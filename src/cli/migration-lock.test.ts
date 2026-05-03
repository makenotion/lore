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
process.stdout.write("READY\\n")
await new Promise((resolve) => process.stdin.once("data", resolve))

const result = tryAcquireMigrationLock(scope)
process.stdout.write(JSON.stringify({
  acquired: result.acquired,
  ownerPid: result.acquired ? result.lock.ownerPid : result.ownerPid,
  pid: process.pid
}) + "\\n")

if (result.acquired) {
  await new Promise((resolve) => process.stdin.once("data", resolve))
}
`
  )
  return workerPath
}

async function runWorkerRace(lockScope: MigrationLockScope): Promise<
  Array<{
    acquired: boolean
    ownerPid: number | null
    pid: number
  }>
> {
  const workerPath = writeRaceWorker()
  const viteNode = join(process.cwd(), "node_modules/vite-node/vite-node.mjs")
  const children = Array.from({ length: 2 }, () => {
    return spawn(process.execPath, [viteNode, workerPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LORE_HOOK_STATE_DIR: TEST_STATE_DIR,
        LOCK_SCOPE: JSON.stringify(lockScope),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
  })

  const handles = children.map((child) => {
    let stdoutBuffer = ""
    let stderr = ""
    let ready = false
    let resolveReady: () => void
    let resolveResult: (result: {
      acquired: boolean
      ownerPid: number | null
      pid: number
    }) => void
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    const resultPromise = new Promise<{
      acquired: boolean
      ownerPid: number | null
      pid: number
    }>((resolve) => {
      resolveResult = resolve
    })

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8")
      let newlineIndex = stdoutBuffer.indexOf("\n")
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex)
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
        if (!ready && line === "READY") {
          ready = true
          resolveReady()
        } else if (line.startsWith("{")) {
          resolveResult(
            JSON.parse(line) as {
              acquired: boolean
              ownerPid: number | null
              pid: number
            }
          )
        }
        newlineIndex = stdoutBuffer.indexOf("\n")
      }
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })

    return {
      child,
      ready: readyPromise,
      result: resultPromise,
      exit: async () => {
        const [code] = (await once(child, "exit")) as [number | null]
        if (code !== 0) {
          throw new Error(`worker exited ${code}: ${stderr}`)
        }
      },
    }
  })

  // Wait for both vite-node workers to load before starting the lock attempt;
  // otherwise the first worker can acquire and exit before the second starts.
  await Promise.all(handles.map((handle) => handle.ready))
  for (const { child } of handles) {
    child.stdin?.write("go\n")
  }

  const results = await Promise.all(handles.map((handle) => handle.result))
  for (const { child } of handles) {
    child.stdin?.write("release\n")
    child.stdin?.end()
  }
  await Promise.all(handles.map((handle) => handle.exit()))
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
