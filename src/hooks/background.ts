/**
 * Background `claude -p` spawn primitive.
 *
 * Both the Stop autosave path and the digest scheduler call into here, so
 * the helper carries the concurrency machinery (per-session lock, global
 * cap, per-session stderr log) plus the digest extensions: a configurable
 * allowlist (so the digest can run against a narrower tool surface than
 * the catch-all save) and a configurable log label (so `[lore]` stderr
 * lines tell a background-save failure apart from a digest failure
 * without having to grep the PID).
 *
 * The spawned binary defaults to `claude -p` for Claude Code installs and
 * to `codex exec --sandbox workspace-write --skip-git-repo-check` for Codex
 * installs via the hook config resolver. Operators can override the
 * command/args through
 * `hooks.backgroundAgent` or `LORE_BACKGROUND_COMMAND`.
 *
 * Lives in its own module because the hook-helpers entry runs `main()`
 * when invoked as the Node entry point, which would happen at import
 * time for any test or CLI that referenced the spawn directly. Keeping
 * the spawn here lets the digest CLI command and the digest scheduler
 * import it without triggering hook routing as a side effect.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { existsSync, writeSync, openSync, closeSync, unlinkSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join, isAbsolute } from "node:path"
import { buildSafeEnv } from "../auth/forwarded-env.js"
import type { AuthSource } from "../config.js"
import { redactDebugError } from "../debug-redact.js"
import {
  activeSaveCount,
  hasActiveSessionLock,
  LockPathTooLongError,
  logPath,
  MAX_CONCURRENT_SAVES,
  releaseSessionLock,
  tryAcquireSessionLock,
} from "./lock.js"
import {
  ALLOWED_TOOLS_PLACEHOLDER,
  DEFAULT_BACKGROUND_ARGS,
  DEFAULT_BACKGROUND_COMMAND,
  type BackgroundAgentConfig,
} from "./config.js"
import { HOOK_STATE_FILE_MODE, openHookStateFileSync } from "./marker-key.js"

/**
 * Tool allowlist for the catch-all background save agent. Broad on purpose
 * — the background save worker may fan out across save / fact-create /
 * decision-create / task-create depending on what the session produced.
 * The save prompt teaches the polymorphic surface, so the spawned subagent
 * calls these names directly.
 *
 * `lore-query` is included so the atomic-learning extraction path can
 * dedup candidate learnings against the existing vault before saving —
 * the prompt instructs the sub-agent to probe `lore-query action='search'`
 * for each candidate (memory-shaped near-matches scoped to the project);
 * the allowlist is what makes that probe callable.
 */
export const DEFAULT_SAVE_ALLOWLIST = [
  "mcp__lore__lore-memory",
  "mcp__lore__lore-fact",
  "mcp__lore__lore-decision",
  "mcp__lore__lore-task",
  "mcp__lore__lore-query",
].join(",")

/**
 * Tool allowlist for the digest synthesizer. Narrower than the background
 * save allowlist so a bad synthesizer prompt violation (e.g. trying to
 * call `lore-fact` action='create') becomes a tool-call error, not a
 * silent extra write. The `buildDigestPrompt` builder already instructs
 * this; the allowlist is defense in depth.
 */
export const DIGEST_ALLOWLIST = ["mcp__lore__lore-memory"].join(",")

export function findBackgroundBinary(name: string): string | null {
  if (isAbsolute(name)) {
    return existsSync(name) ? name : null
  }
  try {
    return execFileSync("which", [name], { encoding: "utf-8" }).trim() || null
  } catch {
    // which failed — try common install locations
  }
  const candidates = [
    join(homedir(), ".local", "bin", name),
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

export function renderAgentArgs(args: readonly string[], allowedTools: string): string[] {
  return args.map((arg) =>
    arg.includes(ALLOWED_TOOLS_PLACEHOLDER)
      ? arg.split(ALLOWED_TOOLS_PLACEHOLDER).join(allowedTools)
      : arg
  )
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
   * Prefix for `[lore]` stderr lines — `"background save"`, `"digest"`, etc.
   * Lets operators distinguish failures across paths without grepping PIDs.
   */
  logLabel?: string
  /**
   * Resolved background-agent command and args. Production callers pass
   * the value from `mergeHookDefaults`; omitted callers keep the
   * historical Claude-shaped default.
   */
  agent?: BackgroundAgentConfig
  /**
   * Auth source the foreground resolved through. Mirrors the
   * `lore install` partition `buildMcpEnv` applies for MCP config:
   * under `ntn-auth-json` the spawned child's `resolveAuth` re-reads
   * ntn's on-disk auth file directly (priority 2), so forwarding
   * bearer tokens via env is dead weight that increases blast radius
   * without changing the child's auth contract.
   *
   * For `env-notion-api-token`, the token forward stays — that
   * caller explicitly accepts token-in-env as part of its contract
   * and the child has no other way to land on the same source.
   *
   * Omitted callers (the back-compat path; e.g. test fixtures,
   * ad-hoc one-shot invocations without a resolved foreground auth)
   * fall through to the legacy unconditional forward: every key in
   * `RUNTIME_FORWARDED_KEYS` forwards conditionally regardless of
   * source. The detached child still re-resolves auth at startup,
   * so the worst case is the same legacy surface — no upgrade, but
   * no regression either.
   */
  authSource?: AuthSource
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
 * The four failure kinds (`lock-path-too-long`, `binary-missing`,
 * `tempfile-failed`, `spawn-error`) signal genuine failure: no peer is
 * doing the work, and callers should roll back any optimistically-claimed
 * state so the next trigger retries. `lock-path-too-long` is structurally
 * sticky — the next trigger hits the same ENAMETOOLONG until the operator
 * shortens `LORE_HOOK_STATE_DIR` — but that's still the right posture: the
 * caller surfaces the failure marker, and the next operator-visible
 * surface (`lore status`) shows the structural cause.
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
  /**
   * Lock path exceeded the host filesystem's syscall limit
   * (`LORE_HOOK_STATE_DIR` close to `PATH_MAX`); child was SIGTERMed. NOT a
   * benign race — there is no peer doing the work, so callers must roll
   * back optimistically-claimed state (digest marker freshness) and record
   * a background-failure marker. The next trigger will hit the same
   * structural failure until the operator shortens the state dir, but the
   * Stop hook still exits cleanly.
   */
  | {
      kind: "lock-path-too-long"
      code: "ENAMETOOLONG" | "ENOENT"
      lockKey: string
    }
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
  // `lock-path-too-long` is intentionally NOT here. There is no peer doing
  // the work when the lock path exceeds the syscall limit; classifying it
  // as benign would silently feed the digest scheduler's peer-active
  // branch (leaving the digest marker fresh) and the `lore digest` CLI's
  // "Digest already in flight" message.
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
 * like `"digest-Widget"` for the digest path) routes lock + log filenames so
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
  const agentConfig: BackgroundAgentConfig = options.agent ?? {
    command: DEFAULT_BACKGROUND_COMMAND,
    args: [...DEFAULT_BACKGROUND_ARGS],
  }

  const binary = findBackgroundBinary(agentConfig.command)
  if (!binary) {
    process.stderr.write(
      `[lore] ${logLabel}: background command "${agentConfig.command}" not found on PATH, skipping. ` +
        `Install the binary or override hooks.backgroundAgent.command in .lore.yaml ` +
        `(or set LORE_BACKGROUND_COMMAND).\n`
    )
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
  // Tracked separately so the catch path can clean up after a failure at
  // any point in the prep sequence: the open fd (if any) and the temp
  // file (if it was created but not yet unlinked) would otherwise leak
  // session transcript content under /tmp.
  let openFd: number | null = null
  let needsUnlink = false
  try {
    openFd = openSync(promptFile, "wx+", HOOK_STATE_FILE_MODE)
    needsUnlink = true
    writeSync(openFd, prompt)
    closeSync(openFd)
    // Production close succeeded — clear `openFd` so that if the reopen
    // below throws, the catch path skips its `closeSync(openFd)` branch
    // instead of trying to close a fd Node already released (EBADF). The
    // separate failure mode where production `closeSync` itself throws
    // is handled by the catch path's inner try/catch around the cleanup
    // close.
    openFd = null
    openFd = openSync(promptFile, "r")
    // Unlink immediately — child still reads via its inherited fd copy (Unix)
    unlinkSync(promptFile)
    needsUnlink = false
    stdinFd = openFd
  } catch (err) {
    if (openFd !== null) {
      try {
        closeSync(openFd)
      } catch {
        // Best-effort: Node releases the fd before throwing on real close
        // errors, so a second close yields EBADF — which we deliberately
        // swallow to keep `tempfile-failed` as the single observable
        // outcome.
      }
    }
    if (needsUnlink) {
      try {
        unlinkSync(promptFile)
      } catch {
        // Best-effort: file may have been removed by another process.
      }
    }
    process.stderr.write(
      `[lore] ${logLabel}: failed to prepare prompt file: ${redactDebugError(err)}\n`
    )
    return { kind: "tempfile-failed" }
  }

  const args = renderAgentArgs(agentConfig.args, allowedTools)

  // Minimal env — only what the background process needs. Auth /
  // workspace / environment selectors flow through `buildSafeEnv`,
  // the single source of truth shared by every Lore-spawned-child
  // path. Under `authSource: "ntn-auth-json"` the auth-token subset
  // is dropped because the child re-reads ntn's on-disk auth file
  // directly; workspace + base-URL + attribution selectors still
  // forward so multi-workspace resolution agrees with the foreground.
  const safeEnv = buildSafeEnv(options.authSource)

  // Redirect stderr to a per-key log so crashes are recoverable without
  // someone actively watching stderr. Truncate per save: each spawn is
  // independent and an unbounded append would grow the file forever.
  let stderrSink: "ignore" | number = "ignore"
  if (lockKey) {
    try {
      stderrSink = openHookStateFileSync(logPath(lockKey), "w")
    } catch {
      // Fall back to ignore — logging is best-effort, the save must still run.
    }
  }

  let lockFile: string | null = null
  // `child` is hoisted out of the try so the catch can reach it. Without
  // that, an unexpected post-spawn throw (e.g. `ENOSPC` from `writeFileSync`
  // on the lock file) leaves the detached `claude -p` running but untracked
  // — the outer catch returns `spawn-error`, the lock file never lands, and
  // the next Stop hook can't see the in-flight save so it spawns another.
  // Two complementary defenses cover the `ENAMETOOLONG` shape specifically:
  // the segment-length cap in `safeFilenameSegment` keeps NAME_MAX safe for
  // hostile session ids, and `tryAcquireSessionLock` reclassifies the
  // residual `ENAMETOOLONG` (and the darwin `ENOENT`-via-segment variant)
  // as `LockPathTooLongError`, which the inline acquire block below
  // catches and maps to a `lock-path-too-long` SpawnResult. This hoist is
  // the symmetric fix that holds for any other post-spawn throw the lock
  // layer doesn't classify.
  let child: ChildProcess | undefined
  try {
    child = spawn(binary, args, {
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
      try {
        lockFile = tryAcquireSessionLock(lockKey, child.pid)
      } catch (err) {
        if (err instanceof LockPathTooLongError) {
          try {
            child.kill("SIGTERM")
          } catch {
            // Child already gone.
          }
          // logLabel-aware so the operator sees the right surface:
          // autosave Stop hooks emit `[lore] background save: ...`,
          // digest spawns emit `[lore] digest: ...`, etc. A hardcoded
          // "autosave" framing would be wrong on every non-autosave
          // caller. Truncate the lockKey preview so a hostile
          // multi-kilobyte payload can't itself swamp stderr.
          const previewLen = 64
          const preview =
            err.lockKey.length > previewLen
              ? `${err.lockKey.slice(0, previewLen)}...`
              : err.lockKey
          process.stderr.write(
            `[lore] ${logLabel}: lock path too long (${err.code}) for "${preview}"; ` +
              `skipping spawn. Check LORE_HOOK_STATE_DIR length.\n`
          )
          return {
            kind: "lock-path-too-long",
            code: err.code,
            lockKey: err.lockKey,
          }
        }
        // Other syscall errors (ENOSPC, EACCES, EROFS, etc.) still
        // propagate to the outer `spawn-error` catch — the post-spawn
        // child is killed there via the `child && !lockFile` branch.
        throw err
      }
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
    process.stderr.write(`[lore] ${logLabel}: spawn failed: ${redactDebugError(err)}\n`)
    // If we got past `spawn` but never claimed the lock, the child is
    // running but no debounce / accounting points at it. SIGTERM the
    // orphan so it can't silently spend tokens or duplicate work on the
    // next retry. When `lockFile` is set the acquire succeeded — the
    // child is reachable through the normal lock-aliveness path and
    // tearing it down here would defeat the spawn we're returning success
    // for (the only post-acquire operation is `child.unref()`, which
    // doesn't realistically throw but is cheap to defend against).
    if (child && !lockFile) {
      try {
        child.kill("SIGTERM")
      } catch {
        // Child already gone.
      }
    }
    if (lockFile) releaseSessionLock(lockFile)
    return { kind: "spawn-error", error: err }
  } finally {
    // Safe on Unix: `spawn` with `stdio: [stdinFd, ...]` dups the fd into the
    // child, so closing the parent's copy here doesn't affect the child's read.
    closeSync(stdinFd)
    if (typeof stderrSink === "number") closeSync(stderrSink)
  }
}
