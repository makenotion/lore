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
 * is no longer alive. Every acquire call performs a PID liveness probe to
 * garbage-collect stale locks left behind by crashed or killed children.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeFilenameSegment } from "./marker-key.js"

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
  mkdirSync(getStateDir(), { recursive: true })
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
 * Attempt to acquire the session lock on behalf of a PID. Returns the lock
 * file path on success; null if a live save is already in flight for this
 * session or the global concurrency cap has been reached.
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
 */
export function tryAcquireSessionLock(
  sessionId: string,
  ownerPid: number
): string | null {
  ensureStateDirSync()
  if (hasActiveSessionLock(sessionId)) return null
  if (activeSaveCount() >= MAX_CONCURRENT_SAVES) return null
  const path = lockPath(sessionId)
  try {
    writeFileSync(path, ownerPid.toString(), { flag: "wx", mode: 0o600 })
    return path
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null
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
