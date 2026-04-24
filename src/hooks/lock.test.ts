/**
 * Unit tests for the per-session background-save lock.
 *
 * The lock file records a PID; a "released" lock is one whose PID is no
 * longer running. These tests exercise acquire/overlap/staleness directly
 * against `$TMPDIR/lore-hook-state/` using the current process PID (always
 * alive) and a synthetic dead PID.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"

// Isolate from sibling test files that also touch the lock dir. See
// helpers.test.ts for the rationale — `vi.hoisted` is required because ES
// module imports run before top-level statements, so a plain assignment
// would pin STATE_DIR before it took effect.
vi.hoisted(() => {
  process.env["LORE_HOOK_STATE_DIR"] =
    `${process.env["TMPDIR"] ?? "/tmp"}/lore-lock-test-${process.pid}-${Date.now()}`
})

import {
  activeSaveCount,
  getStateDir,
  hasActiveSessionLock,
  lockPath,
  logPath,
  releaseSessionLock,
  tryAcquireSessionLock,
  MAX_CONCURRENT_SAVES,
} from "./lock.js"

// PIDs above 4 million are effectively never alive on Linux/macOS — the
// kernel recycles well below this ceiling. Use it to simulate a stale lock
// without spawning a throwaway process.
const DEAD_PID = 4_000_001

function cleanStateDir(): void {
  try {
    rmSync(getStateDir(), { recursive: true, force: true })
  } catch {
    // Best-effort — the dir may not exist between test runs.
  }
  // Pre-create the dir so tests can seed lock files directly with
  // writeFileSync before calling into the module under test.
  mkdirSync(getStateDir(), { recursive: true })
}

describe("tryAcquireSessionLock", () => {
  beforeEach(cleanStateDir)
  afterEach(cleanStateDir)

  it("creates a lock file owned by the supplied PID", () => {
    const sessionId = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const path = tryAcquireSessionLock(sessionId, process.pid)
    expect(path).toBe(lockPath(sessionId))
    expect(existsSync(path!)).toBe(true)
    expect(readFileSync(path!, "utf-8").trim()).toBe(process.pid.toString())
  })

  it("returns null when a live lock already exists for the same session", () => {
    const sessionId = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const first = tryAcquireSessionLock(sessionId, process.pid)
    expect(first).not.toBeNull()
    const second = tryAcquireSessionLock(sessionId, process.pid)
    expect(second).toBeNull()
  })

  it("reclaims a stale lock whose owner PID is no longer alive", () => {
    const sessionId = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`
    // Simulate a crashed prior save by seeding a lock with a dead PID.
    writeFileSync(lockPath(sessionId), DEAD_PID.toString())
    expect(hasActiveSessionLock(sessionId)).toBe(false)
    const path = tryAcquireSessionLock(sessionId, process.pid)
    expect(path).toBe(lockPath(sessionId))
    expect(readFileSync(path!, "utf-8").trim()).toBe(process.pid.toString())
  })

  it("returns null once the global concurrency cap is reached", () => {
    const paths: string[] = []
    for (let i = 0; i < MAX_CONCURRENT_SAVES; i++) {
      const acquired = tryAcquireSessionLock(`cap-${Date.now()}-${i}`, process.pid)
      expect(acquired).not.toBeNull()
      paths.push(acquired!)
    }
    // Cap reached — next acquire must fail even though the session is new.
    const extra = tryAcquireSessionLock(`cap-${Date.now()}-overflow`, process.pid)
    expect(extra).toBeNull()

    // Releasing one frees a slot so acquire can succeed again.
    releaseSessionLock(paths[0])
    const retry = tryAcquireSessionLock(`cap-${Date.now()}-retry`, process.pid)
    expect(retry).not.toBeNull()
  })

  it("treats an unparseable lock file as stale", () => {
    const sessionId = `test-${Date.now()}-garbage`
    writeFileSync(lockPath(sessionId), "not-a-pid")
    expect(hasActiveSessionLock(sessionId)).toBe(false)
    const path = tryAcquireSessionLock(sessionId, process.pid)
    expect(path).not.toBeNull()
  })
})

describe("activeSaveCount", () => {
  beforeEach(cleanStateDir)
  afterEach(cleanStateDir)

  it("counts only locks whose owner PID is alive, sweeping stale entries", () => {
    // One live lock owned by this process.
    const live = tryAcquireSessionLock(`count-${Date.now()}-live`, process.pid)
    expect(live).not.toBeNull()
    // One stale lock with a dead PID.
    const staleSession = `count-${Date.now()}-stale`
    writeFileSync(lockPath(staleSession), DEAD_PID.toString())

    expect(activeSaveCount()).toBe(1)
    // Stale lock should be swept by the call above.
    expect(existsSync(lockPath(staleSession))).toBe(false)
  })
})

describe("logPath", () => {
  it("lives alongside lock files in the state dir", () => {
    const path = logPath("sess-log")
    expect(path.endsWith("sess-log.log")).toBe(true)
    expect(path.startsWith(getStateDir())).toBe(true)
  })
})
