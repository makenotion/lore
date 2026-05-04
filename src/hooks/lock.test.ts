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
import { HOSTILE_SESSION_IDS } from "./path-injection-fixtures.js"

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
    // Trailing slash on the prefix so a sibling directory whose name
    // *starts* with `${getStateDir()}` (e.g. `${stateDir}MALICIOUS/...`)
    // can't false-pass this check. Same posture as the path-injection
    // assertions below.
    expect(path.startsWith(`${getStateDir()}/`)).toBe(true)
  })
})

// Issue #200: a malformed or hostile sessionId must not be able to write
// state files outside `getStateDir()`. The path-builders sanitize through
// `safeFilenameSegment` from `marker-key.ts`, so a payload carrying `/`,
// `..`, backslashes, whitespace, or shell metacharacters collapses to a
// filename that stays under the state dir. Pin both surfaces so a future
// regression that removed the scrub gets caught at this layer rather than
// at the filesystem.
describe("path injection resistance", () => {
  // Both tables share the same hostile-id fixture so a future maintainer
  // adding a new attack shape (e.g. a Unicode normalization variant)
  // updates the fixture once and lockPath / logPath / statePath all
  // pick it up. See `path-injection-fixtures.ts`.
  it.each(HOSTILE_SESSION_IDS as unknown as Array<[string, string]>)(
    "lockPath stays under getStateDir() for %s",
    (_label, hostileId) => {
      const stateDir = getStateDir()
      const path = lockPath(hostileId)
      expect(path.startsWith(`${stateDir}/`)).toBe(true)
      expect(path).toMatch(/\.lock$/)
      // No raw separators in the filename portion — the dirname must equal
      // getStateDir() exactly, which proves the segment didn't punch out
      // into a parent or sibling directory.
      const segment = path.slice(stateDir.length + 1)
      expect(segment).not.toContain("/")
      expect(segment).not.toContain("\\")
    },
  )

  it.each(HOSTILE_SESSION_IDS as unknown as Array<[string, string]>)(
    "logPath stays under getStateDir() for %s",
    (_label, hostileId) => {
      const stateDir = getStateDir()
      const path = logPath(hostileId)
      expect(path.startsWith(`${stateDir}/`)).toBe(true)
      expect(path).toMatch(/\.log$/)
      const segment = path.slice(stateDir.length + 1)
      expect(segment).not.toContain("/")
      expect(segment).not.toContain("\\")
    },
  )

  it("treats sanitized variants of the same hostile id as the same lock", () => {
    // Two payloads whose sanitized forms collide map to the same lock file.
    // This is the documented trade-off — under the trusted-host-integration
    // assumption it's acceptable, and pinning the property here makes the
    // collision behavior explicit instead of accidental.
    expect(lockPath("a/b")).toBe(lockPath("a_b"))
    expect(lockPath("a\\b")).toBe(lockPath("a_b"))
    expect(lockPath("a b")).toBe(lockPath("a_b"))
  })

  it("leaves UUID-shaped sessionIds untouched", () => {
    // Real Claude Code session ids are UUID-like — alphanumeric plus
    // hyphens — and must round-trip unchanged so existing on-disk locks
    // stay addressable across the upgrade. If a future regex tweak
    // accidentally narrows the allowed set, this assertion catches it.
    const uuid = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
    const stateDir = getStateDir()
    expect(lockPath(uuid)).toBe(`${stateDir}/${uuid}.lock`)
    expect(logPath(uuid)).toBe(`${stateDir}/${uuid}.log`)
  })

  it("succeeds for a 300-char session id via the safeFilenameSegment hash path (#485)", () => {
    // Issue #485 acceptance criterion: a session id near or above the
    // per-FS NAME_MAX boundary must NOT throw `ENAMETOOLONG` out of the
    // lock layer. The segment cap in `safeFilenameSegment` hashes the
    // over-cap input into a 128-char filename, so the rendered `.lock`
    // lands at ≤ 133 bytes — well under POSIX NAME_MAX = 255. With a
    // reasonable test state-dir (temp dir), the full path is also well
    // under PATH_MAX, so the call simply succeeds. Pathological
    // state-dirs that exceed PATH_MAX are exercised via fs mocks in
    // `lock-name-too-long.test.ts`; this test pins the structural cap
    // for the common-case session-id boundary.
    const longSession = `long-session-${"x".repeat(300)}`
    const result = tryAcquireSessionLock(longSession, process.pid)
    expect(result).not.toBeNull()
    expect(existsSync(result!)).toBe(true)
    // The on-disk filename must reflect the cap — the hashed form
    // produced by `safeFilenameSegment` is bounded at 128 chars, plus
    // the `.lock` suffix.
    const stateDir = getStateDir()
    const filename = result!.slice(stateDir.length + 1)
    expect(filename.length).toBeLessThanOrEqual(128 + ".lock".length)
    expect(filename).toMatch(/\.lock$/)
    releaseSessionLock(result!)
  })

  it("actually writes a lock file under getStateDir() for a hostile sessionId", () => {
    // End-to-end check: tryAcquireSessionLock with a path-traversing
    // sessionId must succeed, the write must land under getStateDir(),
    // and the global activeSaveCount sweeper must see it. This proves
    // every lock-state filesystem call routes through the same scrubbed
    // path, not just the path builder.
    const hostile = "../escape/me"
    const acquired = tryAcquireSessionLock(hostile, process.pid)
    expect(acquired).not.toBeNull()
    expect(acquired!.startsWith(`${getStateDir()}/`)).toBe(true)
    expect(existsSync(acquired!)).toBe(true)
    // hasActiveSessionLock must agree the lock is held — otherwise a
    // mismatch between writer and reader would silently let an overlap
    // race spawn a duplicate save.
    expect(activeSaveCount()).toBeGreaterThanOrEqual(1)
    releaseSessionLock(acquired!)
  })
})
