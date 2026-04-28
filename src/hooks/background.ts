/**
 * Background `claude -p` spawn primitive.
 *
 * Both the Stop / SessionEnd autosave paths and the digest scheduler call
 * into here, so the helper carries the post-#66 concurrency machinery
 * (per-session lock, global cap, per-session stderr log) plus the digest
 * extensions: a configurable allowlist (so the digest can run against a
 * narrower tool surface than the catch-all save) and a configurable log
 * label (so [lore] stderr lines tell a session-end failure apart from a
 * digest failure without having to grep the PID).
 *
 * Lives in its own module because `helpers.ts` runs `main()` when the file
 * is the Node entry point, which would happen at import time for any test
 * or CLI that referenced the spawn directly. Keeping the spawn here lets
 * `cli/commands/digest.ts` and the digest scheduler import it without
 * triggering hook routing as a side effect.
 */

import { spawn, execFileSync } from "node:child_process"
import {
  existsSync,
  writeSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import {
  activeSaveCount,
  hasActiveSessionLock,
  logPath,
  MAX_CONCURRENT_SAVES,
  releaseSessionLock,
  tryAcquireSessionLock,
} from "./lock.js"

/**
 * Tool allowlist for the catch-all session save agent. Broad on purpose —
 * the session-end worker may fan out across save / fact-create /
 * decision-create / task-create depending on what the session produced.
 * The save prompt teaches the polymorphic surface, so the spawned subagent
 * calls these names directly.
 */
export const DEFAULT_SAVE_ALLOWLIST = [
  "mcp__lore__lore-memory",
  "mcp__lore__lore-fact",
  "mcp__lore__lore-decision",
  "mcp__lore__lore-task",
].join(",")

/**
 * Tool allowlist for the digest synthesizer. Narrower than the session-end
 * allowlist so a bad synthesizer prompt violation (e.g. trying to call
 * `lore-fact` action='create') becomes a tool-call error, not a silent
 * extra write. The prompt at `prompts.ts:buildDigestPrompt` already
 * instructs this; the allowlist is defense in depth.
 */
export const DIGEST_ALLOWLIST = ["mcp__lore__lore-memory"].join(",")

export function findClaudeBinary(): string | null {
  try {
    return execFileSync("which", ["claude"], { encoding: "utf-8" }).trim() || null
  } catch {
    // which failed — try common install locations
  }
  const candidates = [
    join(homedir(), ".local", "bin", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

export interface SpawnBackgroundSaveOptions {
  /**
   * Tool allowlist for the spawned `claude -p`. Defaults to
   * `DEFAULT_SAVE_ALLOWLIST`. Pass `DIGEST_ALLOWLIST` for the digest path
   * so a synthesizer that violates the prompt's "single lore-memory action='save'"
   * rule gets a tool-call error rather than a silent stray write.
   */
  allowedTools?: string
  /**
   * Prefix for `[lore]` stderr lines — `"session-end"`, `"digest"`, etc.
   * Lets operators distinguish failures across paths without grepping PIDs.
   */
  logLabel?: string
}

/**
 * Outcome of a `spawnBackgroundSave` call.
 *
 * The three benign-race kinds (`lock-held`, `cap-hit`, `race-lost`) signal
 * that a peer process is — or about to be — running the same work. Callers
 * with side effects to persist (digest marker touch, save counter bump)
 * MUST NOT advance their state on these kinds, since the peer's success
 * already accounts for the side effect.
 *
 * The three failure kinds (`binary-missing`, `tempfile-failed`,
 * `spawn-error`) signal genuine failure: no peer is doing the work, and
 * callers should roll back any optimistically-claimed state so the next
 * trigger retries.
 */
export type SpawnResult =
  /** Child started and (when `lockKey` was passed) holds the session lock. */
  | { kind: "spawned" }
  /** Per-key lock was held by a live peer — that peer is doing the work. */
  | { kind: "lock-held" }
  /** Global `MAX_CONCURRENT_SAVES` cap reached — another peer is doing work. */
  | { kind: "cap-hit" }
  /** Lost the post-spawn O_EXCL race; child was SIGTERMed. Peer has the lock. */
  | { kind: "race-lost" }
  /** `claude` binary not on PATH or in known install locations — retry next trigger. */
  | { kind: "binary-missing" }
  /** Failed to create / write the temp prompt file — retry next trigger. */
  | { kind: "tempfile-failed" }
  /** `child_process.spawn` itself threw — retry next trigger. */
  | { kind: "spawn-error"; error: unknown }

/**
 * True iff the result indicates a peer is producing the same work. Callers
 * with optimistically-claimed state (digest marker, save counter) must NOT
 * roll back on these kinds — the peer's success covers the window.
 *
 * Centralized so digest-scheduler.ts and the `lore digest` CLI agree on the
 * benign-race set; adding a seventh `SpawnResult` variant in the future
 * will require explicit triage at this single site rather than diverging
 * silently across consumers.
 */
export function isBenignRace(result: SpawnResult): boolean {
  return (
    result.kind === "lock-held" ||
    result.kind === "cap-hit" ||
    result.kind === "race-lost"
  )
}

/**
 * Spawn a detached `claude -p` sub-agent to do a structured save. Returns a
 * discriminated union describing the outcome:
 *
 * - `spawned` — a child process was started and now owns the session lock
 *   (when `lockKey` was passed). Callers should advance their persistent
 *   state (save counter, digest marker, etc.).
 * - `lock-held` / `cap-hit` / `race-lost` — a peer is producing the same
 *   work. Callers should NOT advance state, NOR roll back any optimistic
 *   state they already claimed: the peer's success will cover it.
 * - `binary-missing` / `tempfile-failed` / `spawn-error` — genuine failure.
 *   Callers should roll back any optimistic state so the next trigger retries.
 *
 * `lockKey` (passed as `sessionId` for the autosave path; a synthetic key
 * like `"digest-Mail"` for the digest path) routes lock + log filenames so
 * each spawn family has its own per-key debounce while sharing the global
 * `MAX_CONCURRENT_SAVES` cap. Pass `undefined` to skip locking entirely —
 * only sensible for one-shot CLI invocations.
 */
export function spawnBackgroundSave(
  cwd: string,
  prompt: string,
  lockKey?: string,
  options: SpawnBackgroundSaveOptions = {}
): SpawnResult {
  const allowedTools = options.allowedTools ?? DEFAULT_SAVE_ALLOWLIST
  const logLabel = options.logLabel ?? "background save"

  const claudeBin = findClaudeBinary()
  if (!claudeBin) {
    process.stderr.write(`[lore] ${logLabel}: claude binary not found, skipping\n`)
    return { kind: "binary-missing" }
  }

  // Fast-path capacity check — avoids paying the spawn cost in the common
  // case where another save is already in flight or the global cap is hit.
  // A second, authoritative check happens after spawn (via O_EXCL acquire)
  // so concurrent callers that both pass this probe are still serialized.
  if (lockKey && hasActiveSessionLock(lockKey)) return { kind: "lock-held" }
  if (activeSaveCount() >= MAX_CONCURRENT_SAVES) return { kind: "cap-hit" }

  // Write prompt to a temp file and pipe via stdin fd to avoid exposing
  // session transcript content in process arguments (visible via `ps`).
  // O_EXCL (`wx+`) defeats symlink TOCTOU on shared `/tmp` deployments.
  const promptFile = join(
    tmpdir(),
    `lore-prompt-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.txt`
  )
  let stdinFd: number
  try {
    stdinFd = openSync(promptFile, "wx+", 0o600)
    writeSync(stdinFd, prompt)
    closeSync(stdinFd)
    stdinFd = openSync(promptFile, "r")
    // Unlink immediately — child still reads via its inherited fd copy (Unix)
    unlinkSync(promptFile)
  } catch (err) {
    process.stderr.write(
      `[lore] ${logLabel}: failed to prepare prompt file: ${err instanceof Error ? err.message : err}\n`
    )
    return { kind: "tempfile-failed" }
  }

  const args = [
    "-p",
    "--allowedTools",
    allowedTools,
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--model",
    "sonnet",
  ]

  // Minimal env — only what the background process needs
  const safeEnv: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "",
    LORE_AUTOSAVE: "false",
  }
  const notionToken = process.env["LORE_NOTION_TOKEN"]
  if (notionToken) safeEnv["LORE_NOTION_TOKEN"] = notionToken
  const notionBaseUrl = process.env["LORE_NOTION_BASE_URL"]
  if (notionBaseUrl) safeEnv["LORE_NOTION_BASE_URL"] = notionBaseUrl

  // Redirect stderr to a per-key log so crashes are recoverable without
  // someone actively watching stderr. Truncate per save: each spawn is
  // independent and an unbounded append would grow the file forever.
  let stderrSink: "ignore" | number = "ignore"
  if (lockKey) {
    try {
      stderrSink = openSync(logPath(lockKey), "w", 0o600)
    } catch {
      // Fall back to ignore — logging is best-effort, the save must still run.
    }
  }

  let lockFile: string | null = null
  try {
    const child = spawn(claudeBin, args, {
      cwd,
      detached: true,
      stdio: [stdinFd, "ignore", stderrSink],
      env: safeEnv,
    })

    // Atomic acquire using the child's own PID — no hand-off window. If a
    // concurrent hook spawned first and already acquired, our acquire fails
    // and we tear down our child to keep "at most one in flight per key".
    if (lockKey) {
      if (typeof child.pid !== "number") {
        try {
          child.kill("SIGTERM")
        } catch {
          // Child already gone.
        }
        // Spawn returned no PID — the OS rejected the fork. Treat as a
        // genuine spawn failure, not a benign race: there is no peer here.
        return { kind: "spawn-error", error: new Error("spawn returned no pid") }
      }
      lockFile = tryAcquireSessionLock(lockKey, child.pid)
      if (!lockFile) {
        try {
          child.kill("SIGTERM")
        } catch {
          // Child already gone.
        }
        // Lost the O_EXCL race — a concurrent hook beat us to the lock.
        // The winning peer is producing the work; callers must NOT roll
        // back optimistic state.
        return { kind: "race-lost" }
      }
    }

    child.unref()
    return { kind: "spawned" }
  } catch (err) {
    process.stderr.write(
      `[lore] ${logLabel}: spawn failed: ${err instanceof Error ? err.message : err}\n`
    )
    if (lockFile) releaseSessionLock(lockFile)
    return { kind: "spawn-error", error: err }
  } finally {
    // Safe on Unix: `spawn` with `stdio: [stdinFd, ...]` dups the fd into the
    // child, so closing the parent's copy here doesn't affect the child's read.
    closeSync(stdinFd)
    if (typeof stderrSink === "number") closeSync(stderrSink)
  }
}
