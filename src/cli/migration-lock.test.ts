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
const RACE_TEST_TIMEOUT_MS = 90_000
let originalStateDir: string | undefined

type WorkerRaceResult = {
  acquired: boolean
  ownerPid: number | null
  pid: number
}

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
    `import { existsSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { tryAcquireMigrationLock } from ${JSON.stringify(moduleUrl)}

const scope = JSON.parse(process.env["LOCK_SCOPE"] ?? "{}")
const startFile = process.env["LOCK_START_FILE"]
if (startFile) {
  process.stdout.write("READY\\n")
  while (!existsSync(startFile)) {
    await sleep(10)
  }
}

const result = tryAcquireMigrationLock(scope)
process.stdout.write(JSON.stringify({
  acquired: result.acquired,
  ownerPid: result.acquired ? result.lock.ownerPid : result.ownerPid,
  pid: process.pid
}) + "\\n")

if (result.acquired) {
  const releasePath = process.env["LOCK_RELEASE_PATH"]
  if (!releasePath) {
    await sleep(Number(process.env["LOCK_HOLD_MS"] ?? "30000"))
  } else {
    const timeoutMs = Number(process.env["LOCK_HOLD_TIMEOUT_MS"] ?? "25000")
    const deadline = Date.now() + timeoutMs
    while (!existsSync(releasePath) && Date.now() < deadline) {
      await sleep(25)
    }
  }
}
`
  )
  return workerPath
}

function watchRaceWorker(child: ReturnType<typeof spawn>): {
  child: ReturnType<typeof spawn>
  ready: Promise<void>
  result: Promise<WorkerRaceResult>
} {
  let stdoutBuffer = ""
  let stderr = ""
  let ready = false
  let resultSettled = false
  let resolveReady!: () => void
  let rejectReady!: (err: Error) => void
  let resolveResult!: (value: WorkerRaceResult) => void
  let rejectResult!: (err: Error) => void
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const resultPromise = new Promise<WorkerRaceResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  function finishResult(value: WorkerRaceResult) {
    if (resultSettled) return
    resultSettled = true
    clearTimeout(timer)
    resolveResult(value)
  }

  function fail(error: Error) {
    if (!ready) rejectReady(error)
    if (!resultSettled) {
      resultSettled = true
      clearTimeout(timer)
      rejectResult(error)
    }
  }

  const timer = setTimeout(() => {
    fail(new Error(`worker timed out before reporting: ${stderr || "<no stderr>"}`))
  }, 20_000)

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8")
    let lineEnd = stdoutBuffer.indexOf("\n")
    while (lineEnd !== -1) {
      const line = stdoutBuffer.slice(0, lineEnd)
      stdoutBuffer = stdoutBuffer.slice(lineEnd + 1)
      if (line === "READY") {
        if (!ready) {
          ready = true
          resolveReady()
        }
      } else if (line.trim() !== "") {
        try {
          finishResult(JSON.parse(line) as WorkerRaceResult)
        } catch (err) {
          fail(
            new Error(
              `worker emitted invalid JSON: ${err instanceof Error ? err.message : err}`
            )
          )
        }
      }
      lineEnd = stdoutBuffer.indexOf("\n")
    }
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8")
  })
  child.on("exit", (code) => {
    if (!ready) {
      fail(new Error(`worker exited before ready (${code}): ${stderr}`))
    } else if (!resultSettled) {
      const line = stdoutBuffer.trim()
      if (!line) {
        fail(new Error(`worker exited ${code}: ${stderr}`))
        return
      }
      try {
        finishResult(JSON.parse(line) as WorkerRaceResult)
      } catch (err) {
        fail(
          new Error(
            `worker emitted invalid JSON: ${err instanceof Error ? err.message : err}`
          )
        )
      }
    }
  })

  return { child, ready: readyPromise, result: resultPromise }
}

async function runWorkerRace(
  lockScope: MigrationLockScope
): Promise<WorkerRaceResult[]> {
  const workerPath = writeRaceWorker()
  const releasePath = join(
    TEST_STATE_DIR,
    `migration-lock-release-${Date.now()}-${Math.random()}`
  )
  const startFile = join(TEST_STATE_DIR, `migration-lock-start-${Date.now()}`)
  const viteNode = join(process.cwd(), "node_modules/vite-node/vite-node.mjs")
  const children = Array.from({ length: 2 }, () =>
    spawn(process.execPath, [viteNode, workerPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LORE_HOOK_STATE_DIR: TEST_STATE_DIR,
        LOCK_SCOPE: JSON.stringify(lockScope),
        LOCK_START_FILE: startFile,
        LOCK_RELEASE_PATH: releasePath,
        LOCK_HOLD_TIMEOUT_MS: "25000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
  )

  const workers = children.map(watchRaceWorker)

  try {
    await Promise.all(workers.map((worker) => worker.ready))
    writeFileSync(startFile, "1")
    return await Promise.all(workers.map((worker) => worker.result))
  } finally {
    writeFileSync(releasePath, "release")
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
      }
    }
    await Promise.all(
      children.map((child) =>
        child.exitCode === null && child.signalCode === null
          ? once(child, "exit")
          : Promise.resolve()
      )
    )
  }
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

  it(
    "allows exactly one racing process to acquire a fresh lock",
    async () => {
      const results = await runWorkerRace(scope())

      expect(results.filter((r) => r.acquired)).toHaveLength(1)
      expect(results.filter((r) => !r.acquired)).toHaveLength(1)
    },
    RACE_TEST_TIMEOUT_MS
  )

  it(
    "allows exactly one racing process to reclaim a stale lock",
    async () => {
      const lockScope = scope()
      const path = seedLock(lockScope, DEAD_PID)
      const old = new Date(Date.now() - MALFORMED_LOCK_STALE_MS - 1_000)
      utimesSync(path, old, old)

      const results = await runWorkerRace(lockScope)

      expect(results.filter((r) => r.acquired)).toHaveLength(1)
      expect(results.filter((r) => !r.acquired)).toHaveLength(1)
    },
    RACE_TEST_TIMEOUT_MS
  )

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
