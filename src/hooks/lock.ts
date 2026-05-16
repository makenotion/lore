/**
 * Background-save concurrency guard.
 *
 * The Stop hook fires `spawnBackgroundSave` for autosave, and the auto-digest
 * helper fires `spawnBackgroundSave` for digest synthesis. Two overlapping
 * saves keyed on the same id would race and create duplicate memories, so
 * each lock key owns at most one in-flight save at a time. A global cap
 * prevents runaway token spend if many sessions fire saves simultaneously.
 *
 * The spawned child is `claude` — we can't attach a cleanup hook to it, so
 * the lock is owned by the child's PID and released implicitly when that PID
 * is dead. Every acquire call performs a PID liveness probe to
 * garbage-collect stale locks left behind by crashed or killed children.
 */
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ensureHookStateDirSync,
  safeFilenameSegment,
  writeHookStateFileSync,
} from "./marker-key.js"
import { LoreError } from "../errors.js"

/**
 * Where per-session lock files and stderr logs live. Defaults to a fixed
 * path under `tmpdir()` so hook runs across shells converge on the same
 * directory. Resolved on every call so test harnesses can override
 * `LORE_HOOK_STATE_DIR` at runtime and have each parallel test file see
 * its own directory.
 */
export function getStateDir(): string {
  // `join` normalizes whatever the env var contains (e.g. collapsing macOS's
  // trailing-slash `TMPDIR`) so `path.startsWith()` comparisons against
  // return values of `lockPath` / `logPath` stay consistent.
  return process.env["LORE_HOOK_STATE_DIR"]
    ? join(process.env["LORE_HOOK_STATE_DIR"])
    : join(tmpdir(), "lore-hook-state")
}

/**
 * Maximum simultaneous background-save processes across all sessions. Guard
 * against a flurry of sessions firing saves at once — each `claude -p` call
 * spends tokens invisibly, so an unbounded fan-out is a silent cost bomb.
 */
export const MAX_CONCURRENT_SAVES = 5

function ensureStateDirSync(): void {
  ensureHookStateDirSync(getStateDir())
}

/**
 * Lock filename for a session id, scrubbed through `safeFilenameSegment` so
 * a payload carrying `/`, `..`, backslashes, whitespace, or shell
 * metacharacters can't escape `getStateDir()`. Normal Claude Code session
 * ids (UUID-shaped, alphanumeric + hyphens) pass through unchanged so this
 * is a no-op for the common case.
 */
export function lockPath(sessionId: string): string {
  return join(getStateDir(), `${safeFilenameSegment(sessionId)}.lock`)
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but we lack permission to signal it —
    // still alive from our perspective. ESRCH means no such process.
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

function readLockPid(path: string): number | null {
  try {
    const raw = readFileSync(path, "utf-8").trim()
    const pid = parseInt(raw, 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function removeIfExists(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Another racer may have unlinked first — fine.
  }
}

/**
 * Returns true if a live save is in flight for this session. Stale locks
 * (owner PID is dead or unparseable) are cleaned up as a side effect so the
 * next acquire can succeed.
 */
export function hasActiveSessionLock(sessionId: string): boolean {
  const path = lockPath(sessionId)
  if (!existsSync(path)) return false
  const pid = readLockPid(path)
  if (pid === null || !isProcessAlive(pid)) {
    removeIfExists(path)
    return false
  }
  return true
}

/**
 * Count live (non-stale) locks across all sessions. Scans the state dir and
 * sweeps stale entries in passing, so repeated calls converge on the true
 * number of in-flight saves.
 */
export function activeSaveCount(): number {
  let entries: string[]
  try {
    entries = readdirSync(getStateDir())
  } catch {
    return 0
  }
  let count = 0
  for (const entry of entries) {
    if (!entry.endsWith(".lock")) continue
    const path = join(getStateDir(), entry)
    const pid = readLockPid(path)
    if (pid !== null && isProcessAlive(pid)) {
      count++
    } else {
      removeIfExists(path)
    }
  }
  return count
}

/**
 * Classified error thrown by `tryAcquireSessionLock` when the rendered lock
 * path exceeds the host filesystem's syscall limit. Distinct from the
 * benign-`null` race / capacity returns so `spawnBackgroundSave` can map it
 * to a non-benign `SpawnResult` kind — there is no peer producing the work,
 * so callers must roll back optimistic state (digest marker freshness) and
 * record a background-failure marker rather than treating it as
 * `race-lost`.
 *
 * The `safeFilenameSegment` cap keeps NAME_MAX safe for
 * hostile session ids on its own, but an unusually long
 * `LORE_HOOK_STATE_DIR` close to `PATH_MAX` (≈1024 bytes on darwin, 4096
 * on Linux) can still push the full path over the syscall limit. Without
 * this classified throw, the underlying `ENAMETOOLONG` propagates out of
 * every Stop hook for the affected session and indefinitely skips autosave.
 */
export class LockPathTooLongError extends LoreError<"lock-path-too-long"> {
  readonly code: "ENAMETOOLONG" | "ENOENT"
  readonly lockKey: string

  constructor(lockKey: string, code: "ENAMETOOLONG" | "ENOENT") {
    super("lock-path-too-long", `lock path too long (${code}) for "${lockKey}"`, {
      lockKey,
      code,
    })
    this.name = "LockPathTooLongError"
    this.code = code
    this.lockKey = lockKey
  }
}

/**
 * Decide whether a syscall error code should be reclassified as
 * `LockPathTooLongError`. `ENAMETOOLONG` is the canonical path-too-long
 * code on every POSIX filesystem the hooks layer targets. `ENOENT` is the
 * darwin-specific variant where the kernel can't resolve a path because
 * one of its segments exceeds `NAME_MAX`; on Linux, ENOENT only ever
 * means a missing directory (which would itself be a real bug after
 * `ensureStateDirSync` has just created the parent), so the absorption is
 * gated on `process.platform === "darwin"` to keep linux ENOENT on the
 * genuine-failure path.
 */
function isAbsorbedPathError(
  code: string | undefined
): code is "ENAMETOOLONG" | "ENOENT" {
  if (code === "ENAMETOOLONG") return true
  if (code === "ENOENT" && process.platform === "darwin") return true
  return false
}

/**
 * Attempt to acquire the session lock on behalf of a PID. Returns the lock
 * file path on success; `null` when a live peer is already producing the
 * same work or the global concurrency cap has been reached (the caller
 * should treat both as benign races); throws `LockPathTooLongError` when
 * the rendered path is too long for the host filesystem (the caller must
 * treat that as a genuine failure — there is no peer).
 *
 * Callers should pass the child PID once `spawn` has returned, so the lock
 * names the detached process that will do the work. That removes the
 * hand-off window where two PIDs could both be considered owners: the lock
 * is either the child's (alive → held) or stale (child exited → reclaimable).
 *
 * Uses `wx` (O_EXCL) for atomic create-if-absent — if two hooks race on the
 * same session, only one call returns a path. The loser should tear down
 * whatever state it was about to commit (e.g. kill the child it just
 * spawned).
 *
 * The classified throw, rather than a coalesced `null` return, is
 * load-bearing: the path-too-long case is NOT a benign race, so mapping it
 * to `null` would silently feed the digest scheduler's `isBenignRace`
 * branch (leaving the marker fresh, suppressing auto-digest until the
 * marker expired) and the CLI's "Digest already in flight" message,
 * neither of which is true when no peer exists.
 */
export function tryAcquireSessionLock(
  sessionId: string,
  ownerPid: number
): string | null {
  try {
    ensureStateDirSync()
  } catch (err) {
    // `ensureStateDirSync` itself can trip ENAMETOOLONG when the operator
    // configured a `LORE_HOOK_STATE_DIR` deeper than `PATH_MAX` minus
    // intermediate `mkdirSync` segments. Reclassify as `LockPathTooLongError`
    // so the caller can roll back marker state and record a failure marker.
    const code = (err as NodeJS.ErrnoException).code
    if (isAbsorbedPathError(code)) {
      throw new LockPathTooLongError(sessionId, code)
    }
    throw err
  }
  if (hasActiveSessionLock(sessionId)) return null
  if (activeSaveCount() >= MAX_CONCURRENT_SAVES) return null
  const path = lockPath(sessionId)
  try {
    writeHookStateFileSync(path, ownerPid.toString(), { flag: "wx" })
    return path
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "EEXIST") return null
    if (isAbsorbedPathError(code)) {
      throw new LockPathTooLongError(sessionId, code)
    }
    throw err
  }
}

/** Remove the lock file. Used when a spawn fails after acquire. */
export function releaseSessionLock(path: string): void {
  removeIfExists(path)
}

/**
 * Path to the background-save stderr log for a given session. Same
 * sanitization posture as `lockPath` — `safeFilenameSegment` keeps the
 * filename inside `getStateDir()` regardless of the session id's shape.
 */
export function logPath(sessionId: string): string {
  return join(getStateDir(), `${safeFilenameSegment(sessionId)}.log`)
}
