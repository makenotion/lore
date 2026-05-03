import { spawn } from "node:child_process"
import { once } from "node:events"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { getStateDir } from "../hooks/lock.js"
import {
  MALFORMED_LOCK_STALE_MS,
  MIGRATION_LOCK_MAX_AGE_MS,
  migrationLockPath,
  releaseMigrationLock,
  tryAcquireMigrationLock,
  type MigrationLockScope,
} from "./migration-lock.js"

const DEAD_PID = 4_000_001
const TEST_STATE_DIR = `${process.env["TMPDIR"] ?? "/tmp"}/lore-migration-lock-test-${process.pid}-${Date.now()}`
let originalStateDir: string | undefined

function scope(overrides: Partial<MigrationLockScope> = {}): MigrationLockScope {
  return {
    name: "build-entities",
    configRoot: "/tmp/lore-repo",
    vaultPageId: "vault-page-123",
    ...overrides,
  }
}

function cleanStateDir(): void {
  rmSync(getStateDir(), { recursive: true, force: true })
  mkdirSync(getStateDir(), { recursive: true })
}

function seedLock(lockScope: MigrationLockScope, pid: number | string): string {
  const path = migrationLockPath(lockScope)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, pid.toString())
  return path
}

function expectLockOwnedByThisProcess(path: string): void {
  expect(readFileSync(path, "utf-8").trim()).toMatch(new RegExp(`^${process.pid}\\s+`))
}

function writeRaceWorker(): string {
  const workerPath = join(TEST_STATE_DIR, "migration-lock-worker.ts")
  const moduleUrl = pathToFileURL(join(process.cwd(), "src/cli/migration-lock.ts")).href
  writeFileSync(
    workerPath,
    `import { tryAcquireMigrationLock } from ${JSON.stringify(moduleUrl)}

const scope = JSON.parse(process.env["LOCK_SCOPE"] ?? "{}")
process.stdout.write("ready\\n")
await new Promise((resolve) => {
  process.stdin.once("data", resolve)
  process.stdin.resume()
})
process.stdin.pause()

const result = tryAcquireMigrationLock(scope)
process.stdout.write(JSON.stringify({
  acquired: result.acquired,
  ownerPid: result.acquired ? result.lock.ownerPid : result.ownerPid,
  pid: process.pid
}) + "\\n")

if (result.acquired) {
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, Number(process.env["LOCK_HOLD_MS"] ?? "750"))
    process.stdin.once("data", () => {
      clearTimeout(timeout)
      resolve(undefined)
    })
    process.stdin.resume()
  })
  process.stdin.pause()
}
`
  )
  return workerPath
}

interface WorkerRaceResult {
  acquired: boolean
  ownerPid: number | null
  pid: number
}

function parseWorkerRaceResult(stdout: string): WorkerRaceResult {
  const lines = stdout
    .trim()
    .split(/\n+/)
    .filter((line) => line.length > 0 && line !== "ready")

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!) as Partial<WorkerRaceResult>
      if (typeof parsed.acquired === "boolean") return parsed as WorkerRaceResult
    } catch {
      // Ignore unrelated worker stdout; the structured result is validated below.
    }
  }

  throw new Error(`worker did not emit a result: ${stdout}`)
}

function maybeParseWorkerRaceResult(stdout: string): WorkerRaceResult | null {
  try {
    return parseWorkerRaceResult(stdout)
  } catch {
    return null
  }
}

async function runWorkerRace(lockScope: MigrationLockScope): Promise<
  WorkerRaceResult[]
> {
  const workerPath = writeRaceWorker()
  const viteNode = join(process.cwd(), "node_modules/vite-node/vite-node.mjs")
  const workers = Array.from({ length: 2 }, () => {
    const child = spawn(process.execPath, [viteNode, workerPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LORE_HOOK_STATE_DIR: TEST_STATE_DIR,
        LOCK_SCOPE: JSON.stringify(lockScope),
        // Fallback so a crashed parent does not leave a winning worker alive
        // indefinitely while it waits for the parent-side release signal.
        LOCK_HOLD_MS: "10000",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })

    return { child, stdout: () => stdout, stderr: () => stderr }
  })

  function waitForWorkerReady(worker: (typeof workers)[number]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!worker.child.stdout) {
        reject(new Error("worker stdout pipe was not created"))
        return
      }

      const cleanup = () => {
        worker.child.stdout?.off("data", onData)
        worker.child.off("exit", onExit)
        worker.child.off("error", onError)
      }
      const onData = () => {
        if (!worker.stdout().includes("ready\n")) return
        cleanup()
        resolve()
      }
      const onExit = (code: number | null) => {
        cleanup()
        reject(new Error(`worker exited before ready (${code}): ${worker.stderr()}`))
      }
      const onError = (err: Error) => {
        cleanup()
        reject(err)
      }

      worker.child.stdout.on("data", onData)
      worker.child.once("exit", onExit)
      worker.child.once("error", onError)
      onData()
    })
  }

  function waitForWorkerResult(
    worker: (typeof workers)[number]
  ): Promise<WorkerRaceResult> {
    return new Promise<WorkerRaceResult>((resolve, reject) => {
      if (!worker.child.stdout) {
        reject(new Error("worker stdout pipe was not created"))
        return
      }

      const cleanup = () => {
        worker.child.stdout?.off("data", onData)
        worker.child.off("exit", onExit)
        worker.child.off("error", onError)
      }
      const onData = () => {
        const result = maybeParseWorkerRaceResult(worker.stdout())
        if (!result) return
        cleanup()
        resolve(result)
      }
      const onExit = (code: number | null) => {
        cleanup()
        reject(new Error(`worker exited before result (${code}): ${worker.stderr()}`))
      }
      const onError = (err: Error) => {
        cleanup()
        reject(err)
      }

      worker.child.stdout.on("data", onData)
      worker.child.once("exit", onExit)
      worker.child.once("error", onError)
      onData()
    })
  }

  await Promise.all(workers.map(waitForWorkerReady))

  const exits = workers.map(async (worker) => {
    const [code] = (await once(worker.child, "exit")) as [number | null]
    if (code !== 0) {
      throw new Error(`worker exited ${code}: ${worker.stderr()}`)
    }
  })

  for (const worker of workers) {
    worker.child.stdin?.write("start\n")
  }

  let results: WorkerRaceResult[]
  try {
    results = await Promise.all(workers.map((worker) => waitForWorkerResult(worker)))
  } finally {
    for (const worker of workers) {
      worker.child.stdin?.end("release\n")
    }
  }

  await Promise.all(exits)
  return results
}

describe("tryAcquireMigrationLock", () => {
  beforeEach(() => {
    originalStateDir = process.env["LORE_HOOK_STATE_DIR"]
    process.env["LORE_HOOK_STATE_DIR"] = TEST_STATE_DIR
    cleanStateDir()
  })

  afterEach(() => {
    cleanStateDir()
    if (originalStateDir === undefined) {
      delete process.env["LORE_HOOK_STATE_DIR"]
    } else {
      process.env["LORE_HOOK_STATE_DIR"] = originalStateDir
    }
  })

  it("creates a lock scoped to the migration, config root, and vault", () => {
    const lockScope = scope()
    const result = tryAcquireMigrationLock(lockScope, process.pid)

    expect(result.acquired).toBe(true)
    if (!result.acquired) throw new Error("expected lock acquisition")
    expect(result.lock.path).toBe(migrationLockPath(lockScope))
    expect(result.lock.path).toContain("/migrations/")
    expectLockOwnedByThisProcess(result.lock.path)
  })

  it("fails fast when another live process owns the lock", () => {
    const lockScope = scope()
    const path = seedLock(lockScope, process.pid)

    const result = tryAcquireMigrationLock(lockScope, process.pid)

    expect(result.acquired).toBe(false)
    if (result.acquired) throw new Error("expected lock contention")
    expect(result.path).toBe(path)
    expect(result.ownerPid).toBe(process.pid)
    expect(readFileSync(path, "utf-8").trim()).toBe(process.pid.toString())
  })

  it("recovers a stale lock whose owner PID is no longer alive", () => {
    const lockScope = scope()
    const path = seedLock(lockScope, DEAD_PID)

    const result = tryAcquireMigrationLock(lockScope, process.pid)

    expect(result.acquired).toBe(true)
    if (!result.acquired) throw new Error("expected stale lock recovery")
    expect(result.lock.path).toBe(path)
    expectLockOwnedByThisProcess(path)
  })

  it("treats a fresh unparseable lock file as held", () => {
    const lockScope = scope()
    const path = seedLock(lockScope, "not-a-pid")

    const result = tryAcquireMigrationLock(lockScope, process.pid)

    expect(result.acquired).toBe(false)
    if (result.acquired) throw new Error("expected malformed lock contention")
    expect(result.path).toBe(path)
    expect(result.ownerPid).toBeNull()
    expect(readFileSync(path, "utf-8").trim()).toBe("not-a-pid")
  })

  it("recovers an old unparseable lock file as stale", () => {
    const lockScope = scope()
    const path = seedLock(lockScope, "not-a-pid")
    const old = new Date(Date.now() - MALFORMED_LOCK_STALE_MS - 1_000)
    utimesSync(path, old, old)

    const result = tryAcquireMigrationLock(lockScope, process.pid)

    expect(result.acquired).toBe(true)
    if (!result.acquired) throw new Error("expected old malformed lock recovery")
    expect(result.lock.path).toBe(path)
    expectLockOwnedByThisProcess(path)
  })

  it("recovers an over-age lock even when its PID is alive", () => {
    const lockScope = scope()
    const path = migrationLockPath(lockScope)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      `${process.pid} ${Date.now() - MIGRATION_LOCK_MAX_AGE_MS - 1_000} recycled`
    )

    const result = tryAcquireMigrationLock(lockScope, process.pid)

    expect(result.acquired).toBe(true)
    if (!result.acquired) throw new Error("expected over-age lock recovery")
    expectLockOwnedByThisProcess(path)
  })

  it("allows exactly one racing process to acquire a fresh lock", async () => {
    const results = await runWorkerRace(scope())

    expect(results.filter((r) => r.acquired)).toHaveLength(1)
    expect(results.filter((r) => !r.acquired)).toHaveLength(1)
  }, 30_000)

  it("allows exactly one racing process to reclaim a stale lock", async () => {
    const lockScope = scope()
    const path = seedLock(lockScope, DEAD_PID)
    const old = new Date(Date.now() - MALFORMED_LOCK_STALE_MS - 1_000)
    utimesSync(path, old, old)

    const results = await runWorkerRace(lockScope)

    expect(results.filter((r) => r.acquired)).toHaveLength(1)
    expect(results.filter((r) => !r.acquired)).toHaveLength(1)
  }, 30_000)

  it("keeps independent scopes from blocking each other", () => {
    const first = tryAcquireMigrationLock(scope({ vaultPageId: "vault-a" }))
    const second = tryAcquireMigrationLock(scope({ vaultPageId: "vault-b" }))

    expect(first.acquired).toBe(true)
    expect(second.acquired).toBe(true)
    if (!first.acquired || !second.acquired) {
      throw new Error("expected independent lock acquisitions")
    }
    expect(first.lock.path).not.toBe(second.lock.path)
  })
})

describe("releaseMigrationLock", () => {
  beforeEach(() => {
    originalStateDir = process.env["LORE_HOOK_STATE_DIR"]
    process.env["LORE_HOOK_STATE_DIR"] = TEST_STATE_DIR
    cleanStateDir()
  })

  afterEach(() => {
    cleanStateDir()
    if (originalStateDir === undefined) {
      delete process.env["LORE_HOOK_STATE_DIR"]
    } else {
      process.env["LORE_HOOK_STATE_DIR"] = originalStateDir
    }
  })

  it("removes the lock only when this process still owns it", () => {
    const lockScope = scope()
    const result = tryAcquireMigrationLock(lockScope, process.pid)
    expect(result.acquired).toBe(true)
    if (!result.acquired) throw new Error("expected lock acquisition")

    releaseMigrationLock(result.lock)

    expect(existsSync(result.lock.path)).toBe(false)
  })

  it("does not remove a lock that has been replaced by another owner", () => {
    const lockScope = scope()
    const result = tryAcquireMigrationLock(lockScope, process.pid)
    expect(result.acquired).toBe(true)
    if (!result.acquired) throw new Error("expected lock acquisition")

    writeFileSync(result.lock.path, "999")
    releaseMigrationLock(result.lock)

    expect(readFileSync(result.lock.path, "utf-8").trim()).toBe("999")
  })
})
