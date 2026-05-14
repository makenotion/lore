/**
 * Synchronous, awaitable conversation-mining seam.
 *
 * Production conversation-mining is fire-and-forget: `spawnBackgroundSave`
 * forks a detached agent CLI sub-agent from the Stop-hook autosave path
 * and exits immediately. The sub-agent calls `lore-memory` / `lore-fact`
 * / `lore-decision` / `lore-task` MCP tools to write structured context
 * for the session.
 *
 * `runConversationMining` is the synchronous counterpart: it builds the
 * same prompt the autosave builds, spawns the configured background-agent
 * binary against the same auth-source-aware env partition, awaits exit,
 * and returns timing + write-budget signal. Callers that need
 * deterministic per-session completion (e.g., harnesses that replay one
 * session before moving to the next) consume this seam; the production
 * hook's spawn primitive serves the fire-and-forget shape and is not
 * subsumed by this helper because the hook owns lock + concurrency-cap
 * + per-session-log machinery whose lifecycle is hook-specific.
 *
 * The shared surface between the two paths is the prompt builder, the
 * binary resolver, and `buildSafeEnv` (the env partition). Drift on any
 * of those three is a real silent-auth-divergence risk; the helpers
 * live where every caller imports them and a future runtime-forwarded
 * key update propagates through one site.
 *
 * `options.budgetStateFile` is the channel an MCP-server-side
 * write-budget Proxy uses to surface its cap-exceeded signal to the
 * caller. When the file exists at child exit and parses as JSON with
 * `writeBudgetExceeded: true`, the result reports that bit; otherwise
 * the result reports `false`. Production callers that don't run the
 * MCP server with a write budget pass no `budgetStateFile` and the
 * seam reports `false` unconditionally.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { closeSync, existsSync, openSync, readFileSync } from "node:fs"
import { buildSafeEnv } from "../auth/forwarded-env.js"
import type { AuthSource } from "../config.js"
import {
  DEFAULT_SAVE_ALLOWLIST,
  findBackgroundBinary,
  renderAgentArgs,
} from "./background.js"
import {
  DEFAULT_BACKGROUND_ARGS,
  DEFAULT_BACKGROUND_COMMAND,
  type BackgroundAgentConfig,
} from "./config.js"
import { buildBackgroundSavePrompt } from "./prompts.js"
import type { ResolvedPromptRegistry } from "../profile/index.js"

/**
 * Default wall-clock cap for one mining child. Per-session mining of
 * the typical 3–4k-token transcript completes well below this on a
 * warm cache; the cap is a safety bound for pathological hangs, not a
 * tuning knob. On expiry the helper escalates SIGTERM → SIGKILL and
 * resolves with a synthetic exit signal so callers can route the
 * outcome to a deterministic failure path.
 */
export const DEFAULT_MINING_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Grace period between the SIGTERM the helper sends on timeout and
 * the unconditional SIGKILL that follows. Five seconds matches the
 * lower end of POSIX `kill` defaults — long enough for a cooperating
 * agent CLI to drain in-flight MCP tool calls, short enough that a
 * traps-SIGTERM-and-ignores child cannot stall the caller for more
 * than five seconds past the wall-clock cap.
 */
export const TIMEOUT_KILL_GRACE_MS = 5_000

/**
 * Synthetic exit signal surfaced to the caller when the wall-clock
 * timeout fires and the helper had to escalate. Distinct from a real
 * `SIGKILL` so the caller can tell "I asked for the cap and the
 * child got killed" from "operator pressed Ctrl-C."
 */
export const TIMEOUT_KILLED_SIGNAL: NodeJS.Signals = "SIGKILL"

/**
 * Outcome of a `runConversationMining` call.
 *
 * `elapsedMs` is wall-clock from the spawn moment through resolution,
 * regardless of exit code. `writeBudgetExceeded` is read from the
 * caller-supplied budget-state file at exit; `false` when no file was
 * passed or the file is absent / unreadable / malformed. `exitCode`
 * and `exitSignal` mirror Node's `child_process` exit event arguments
 * with one synthetic case: when the wall-clock timeout fires the
 * helper escalates SIGTERM → SIGKILL and resolves with `exitCode:
 * null, exitSignal: TIMEOUT_KILLED_SIGNAL` even if the child never
 * emits its own `exit` event.
 */
export interface MiningResult {
  elapsedMs: number
  writeBudgetExceeded: boolean
  exitCode: number | null
  exitSignal: NodeJS.Signals | null
}

export interface RunConversationMiningOptions {
  /**
   * Working directory for the spawned background-agent child.
   */
  cwd: string
  /**
   * Project-selection guidance threaded into the prompt's project
   * block. Identical wire shape to `buildBackgroundSavePrompt`'s
   * existing args.
   */
  subProjects: string[]
  catchAllName: string | null
  /**
   * Identity-block plumb-through. Callers replaying a multi-session
   * haystack set `sessionId` so per-session writes group correctly
   * under the existing `Session` rich_text column.
   */
  sessionId?: string
  agentName?: string
  authorName?: string
  /**
   * Background-agent binary + args. Defaults to the same shape the
   * Stop-hook autosave uses; callers can override to a different
   * binary via the same `BackgroundAgentConfig` shape.
   */
  agent?: BackgroundAgentConfig
  /**
   * Tool allowlist string interpolated into the agent's
   * `{{allowedTools}}` arg slot. Defaults to `DEFAULT_SAVE_ALLOWLIST`
   * (the four save tools plus `lore-query` for the autosave learning
   * probe).
   */
  allowedTools?: string
  /**
   * Auth source the foreground resolved through. **Callers MUST
   * thread this from `resolveAuth`'s return value.** Under
   * `ntn-auth-json` the auth-token subset is dropped from the
   * spawned child's env because the child re-reads ntn's on-disk
   * auth file directly; under any other source the partition is a
   * no-op because the auth-token forward is the only resolution
   * path. Omitting under `ntn-auth-json` silently re-leaks
   * `NOTION_API_TOKEN` into the spawned MCP child's env.
   */
  authSource?: AuthSource
  /**
   * Atomic-learning extraction toggles. Defaults preserve the
   * production autosave shape (`extractLearnings: true`,
   * `proposeLearnings: false`); callers running review-inbox-gated
   * fleets opt into `proposeLearnings: true`.
   */
  extractLearnings?: boolean
  proposeLearnings?: boolean
  profilePrompts?: Pick<
    ResolvedPromptRegistry,
    "autosaveExtractionFilter" | "autosaveToolGuidance" | "atomicLearningExtraction"
  >
  /**
   * Path an MCP-server-side write-budget Proxy writes its
   * cap-exceeded signal to. After the child exits, this helper reads
   * the file and surfaces `writeBudgetExceeded: true` when the JSON
   * envelope `{ "writeBudgetExceeded": true }` is present. Absent /
   * unreadable / malformed file → false (a server not running with a
   * write budget returns no signal, equivalent to "not exceeded").
   */
  budgetStateFile?: string
  /**
   * Optional path the helper redirects the child's stderr to. Mode
   * 0o600 to match the hook-path's `logPath(lockKey)` posture. When
   * unset, stderr is drained internally and discarded — adequate for
   * a cooperating agent CLI that doesn't log secrets, but operators
   * triaging "what did the child say?" should pass a path. The hook
   * path uses its per-session log file for this; harnesses that
   * don't have an equivalent surface (one-shot replays, CI runs)
   * should generate their own.
   */
  stderrSinkPath?: string
  /**
   * Wall-clock cap for the child. Defaults to
   * `DEFAULT_MINING_TIMEOUT_MS`. On expiry the helper escalates
   * SIGTERM → SIGKILL (after `TIMEOUT_KILL_GRACE_MS`) and resolves
   * with `exitSignal: TIMEOUT_KILLED_SIGNAL` so the caller can
   * deterministically route the outcome even when the child traps
   * SIGTERM and refuses to exit.
   */
  timeoutMs?: number
}

/**
 * Read the budget-state file at child exit and decode the
 * `writeBudgetExceeded` boolean. Returns `false` on every failure
 * mode — file absent, unreadable, malformed JSON, missing field,
 * wrong type — because the invariant is "no signal == not exceeded."
 * A throw here would mask the child's exit code with an IO error
 * from the diagnostic layer.
 */
function readBudgetState(path: string): boolean {
  if (!existsSync(path)) return false
  let raw: string
  try {
    raw = readFileSync(path, "utf-8")
  } catch {
    return false
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  if (typeof parsed !== "object" || parsed === null) return false
  const exceeded = (parsed as { writeBudgetExceeded?: unknown }).writeBudgetExceeded
  return exceeded === true
}

/**
 * Release the parent's copy of the stderr-sink fd after `spawn` has
 * accepted it (or after the spawn call has thrown without consuming
 * it). Best-effort: `closeSync` failures are swallowed because the
 * fd may already be gone (Node releases it before throwing on real
 * close errors) and a failed close should not poison the surrounding
 * outcome of the mining run.
 */
function closeStderrSinkSafely(fd: number | null): void {
  if (fd === null) return
  try {
    closeSync(fd)
  } catch {
    // Best-effort: see docstring.
  }
}

/**
 * Open the caller-supplied stderr sink with mode 0o600 (truncate
 * mode), matching the per-session-log file mode the hook-path uses.
 * On open failure the helper logs once to stderr and falls back to
 * the internal drain — the mining run should not fail because a
 * diagnostic surface was misconfigured.
 */
function openStderrSink(path: string): number | null {
  try {
    return openSync(path, "w", 0o600)
  } catch (err) {
    process.stderr.write(
      `[lore] conversation-mining: failed to open stderrSinkPath ` +
        `"${path}" (${(err as Error).message ?? "unknown error"}); ` +
        `falling back to discard.\n`
    )
    return null
  }
}

/**
 * Synchronously drive one session's conversation-mining to completion.
 *
 * Builds the prompt, spawns the configured background-agent binary
 * against the same env partition the production autosave path uses,
 * awaits exit, and returns timing + write-budget signal. Throws on
 * pre-spawn binary lookup failures; resolves on every post-spawn
 * outcome (clean exit, non-zero exit, signal, timeout escalation).
 *
 * Wall-clock cap is terminal: when the timeout fires the helper sends
 * SIGTERM, waits `TIMEOUT_KILL_GRACE_MS`, sends SIGKILL, and resolves
 * with `exitSignal: TIMEOUT_KILLED_SIGNAL` regardless of whether the
 * child emits its own `exit` event. A child that traps SIGTERM and
 * ignores it cannot stall the caller indefinitely.
 */
export function runConversationMining(
  transcript: string,
  options: RunConversationMiningOptions
): Promise<MiningResult> {
  const allowedTools = options.allowedTools ?? DEFAULT_SAVE_ALLOWLIST
  const agentConfig: BackgroundAgentConfig = options.agent ?? {
    command: DEFAULT_BACKGROUND_COMMAND,
    args: [...DEFAULT_BACKGROUND_ARGS],
  }

  const binary = findBackgroundBinary(agentConfig.command)
  if (!binary) {
    // Operator-facing stderr hint uses the same
    // `[lore] background save: ...` shape as the hook spawn path
    // so engineers triaging a missing binary see one consistent
    // surface across paths.
    process.stderr.write(
      `[lore] conversation-mining: background command ` +
        `"${agentConfig.command}" not found on PATH. ` +
        `Install the binary or override hooks.backgroundAgent.command ` +
        `in .lore.yaml (or set LORE_BACKGROUND_COMMAND).\n`
    )
    return Promise.reject(
      new Error(
        `runConversationMining: background-agent binary ` +
          `"${agentConfig.command}" not found on PATH or in known ` +
          `install locations.`
      )
    )
  }

  const prompt = buildBackgroundSavePrompt(
    options.subProjects,
    options.catchAllName,
    transcript,
    options.sessionId,
    options.agentName,
    {
      extractLearnings: options.extractLearnings ?? true,
      proposeLearnings: options.proposeLearnings ?? false,
      authorName: options.authorName,
      profilePrompts: options.profilePrompts,
    }
  )

  const args = renderAgentArgs(agentConfig.args, allowedTools)
  const env = buildSafeEnv(options.authSource)
  const timeoutMs = options.timeoutMs ?? DEFAULT_MINING_TIMEOUT_MS
  const stderrSink = options.stderrSinkPath
    ? openStderrSink(options.stderrSinkPath)
    : null

  return new Promise<MiningResult>((resolve, reject) => {
    const t0 = Date.now()
    let child: ChildProcess
    try {
      child = spawn(binary, args, {
        cwd: options.cwd,
        env,
        // stderr: a caller-supplied fd lands the child's stderr in
        // a mode-0600 file the caller controls; otherwise "pipe"
        // so the parent can drain internally without ever inheriting
        // the parent's stderr fd (no leak into the operator's TTY).
        stdio: ["pipe", "ignore", stderrSink ?? "pipe"],
      })
    } catch (err) {
      // Release the parent's stderr-sink fd before bubbling the spawn
      // error. Without this, a caller invoking the helper in a loop
      // (one mining run per session) leaks one fd per failed spawn
      // and eventually trips `EMFILE`.
      closeStderrSinkSafely(stderrSink)
      reject(err)
      return
    }

    // Spawn duped the stderr-sink fd into the child's stdio when
    // we passed it as the `stdio[2]` slot. The parent's copy of the
    // fd is now redundant; closing it here keeps fd usage bounded
    // at one per active mining run rather than growing without
    // bound across runs. Closing the parent copy does not affect
    // the child's view of the fd — Node's `spawn` performs the dup
    // before this point, and the child holds its own descriptor.
    closeStderrSinkSafely(stderrSink)

    let settled = false
    let killGraceTimer: NodeJS.Timeout | null = null

    const settle = (result: MiningResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (killGraceTimer !== null) clearTimeout(killGraceTimer)
      resolve(result)
    }

    const settleReject = (err: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (killGraceTimer !== null) clearTimeout(killGraceTimer)
      reject(err)
    }

    // Register listeners BEFORE writing to stdin. A child that
    // segfaults on argv parse can emit `error` / `exit` between the
    // `spawn` call and the next microtask; a listener registered
    // after the write would miss the synchronous-error case and
    // either crash Node (unhandled 'error') or deadlock waiting on
    // an exit event that already fired.
    child.on("error", (err) => {
      settleReject(err)
    })

    child.on("exit", (exitCode, exitSignal) => {
      const elapsedMs = Date.now() - t0
      const writeBudgetExceeded = options.budgetStateFile
        ? readBudgetState(options.budgetStateFile)
        : false
      settle({ elapsedMs, writeBudgetExceeded, exitCode, exitSignal })
    })

    // Internal stderr drain when no caller-supplied sink was opened.
    // The child's stderr pipe would otherwise fill its 64 KiB buffer
    // and the child would deadlock writing into a backed-up pipe.
    if (stderrSink === null && child.stderr) {
      child.stderr.resume()
    }

    const timeoutTimer = setTimeout(() => {
      // Wall-clock cap is terminal. SIGTERM gives a cooperating
      // child a chance to drain in-flight MCP calls; SIGKILL after
      // TIMEOUT_KILL_GRACE_MS guarantees the helper resolves even
      // when the child traps SIGTERM and refuses to exit.
      try {
        child.kill("SIGTERM")
      } catch {
        // Child already gone.
      }
      killGraceTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          // Child already gone.
        }
        // Resolve unconditionally even if the child never emits
        // its own `exit` event. A child that ignored SIGTERM and
        // is now uncatchably gone via SIGKILL will emit exit on
        // most platforms, but the helper does not depend on that
        // — the resolve here is the contract.
        const elapsedMs = Date.now() - t0
        const writeBudgetExceeded = options.budgetStateFile
          ? readBudgetState(options.budgetStateFile)
          : false
        settle({
          elapsedMs,
          writeBudgetExceeded,
          exitCode: null,
          exitSignal: TIMEOUT_KILLED_SIGNAL,
        })
      }, TIMEOUT_KILL_GRACE_MS)
      killGraceTimer.unref()
    }, timeoutMs)
    timeoutTimer.unref()

    // Now safe to write the prompt: child error / exit / stdin error
    // listeners are all attached, so a post-write failure lands
    // through `settleReject` / `settle` rather than crashing the
    // parent on an unhandled `'error'` event.
    //
    // Three failure paths land here:
    //
    // - **Child process `error`** — `spawn`-level failure (binary
    //   gone between PATH lookup and exec, fork failure).
    // - **Child process `exit`** — normal or signal-driven exit.
    //   Resolves with the corresponding shape.
    // - **`child.stdin` `error`** — the child closed its read end
    //   before draining the prompt, so Node's stream layer emits
    //   `EPIPE` on the parent's writable side. Without this listener
    //   Node treats the `'error'` event as unhandled and crashes the
    //   parent with `Error: write EPIPE`, defeating the seam's
    //   "always resolves or rejects" contract. Routing through
    //   `settleReject` collapses it to the normal rejection path.
    //
    // Piping the prompt through stdin (rather than placing it in
    // argv) keeps session transcript text out of `ps`-visible
    // command lines. Pathological transcripts that exceed the pipe
    // buffer before the child consumes the initial chunk are out of
    // scope; a future consumer that needs to mine multi-MB
    // transcripts would need to switch to an unlinked temp-file FD
    // (different failure modes, different cleanup story).
    if (child.stdin) {
      child.stdin.on("error", (err) => {
        settleReject(err)
      })
      child.stdin.write(prompt)
      child.stdin.end()
    } else {
      settleReject(
        new Error("runConversationMining: spawned child returned no stdin stream")
      )
    }
  })
}
