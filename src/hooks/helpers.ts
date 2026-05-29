// ABOUTME: Owns the installed hook runtime for wake-up, autosave, digest, and background-save coordination.
// ABOUTME: Edit when host hook payload handling or user-visible hook output changes.

/**
 * Hook helper utilities.
 *
 * Invoked by host-assistant hook scripts to interact with Lore. The
 * runner receives the hook action as `argv[2]` and reads the hook
 * event from stdin or environment variables, depending on the action.
 *
 * Autosave flow:
 *   - Stop hook: count-based trigger → spawns a detached `claude -p`
 *     sub-agent in the background that writes structured content via lore-*
 *     MCP tools. The main agent is never blocked.
 *   - Stop also schedules an auto-digest helper as a separate detached node
 *     child (the `auto-digest` action below) so digest synthesis never runs
 *     inline on the Stop hot path.
 *
 * A per-session lock ensures at most one background save is
 * in flight per session, and a global cap bounds total concurrent spawns.
 *
 * The `session-end` action exists only as a compatibility shim for stale
 * host-assistant settings; current installs do not register a SessionEnd
 * hook.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"
import {
  findConfigFile,
  loadConfigAllowingInvalidHooks,
  resolveAuth,
  type AuthSource,
} from "../config.js"
import { redactDebugError } from "../debug-redact.js"
import {
  formatTranscriptSessionContent,
  inspectTranscript,
  type TranscriptInspection,
} from "./transcript.js"
import { initServicesFromConfig } from "../services.js"
import type { LoreConfig } from "../types.js"
import { resolveProjectPathFromCwd } from "../core/context.js"
import { mergeHookDefaults, type HookConfig } from "./config.js"
import { buildBackgroundSavePrompt } from "./prompts.js"
import {
  resolveProfileFromConfig,
  resolveProfileFromConfigAtRoot,
} from "../profile/index.js"
import { indentUntrustedText, UNTRUSTED_VAULT_PREAMBLE } from "./untrusted-text.js"
import {
  RANKED_WAKEUP_LIMITS,
  dateBucket,
  emptyWakeUpCoverageMetrics,
  formatWakeUpCoverage,
  loadWakeUpData,
} from "../core/wakeup.js"
import { resolveCostTracking } from "../core/cost-ledger.js"
import { composeProjectContext, type ProjectContext } from "../core/project-context.js"
import { formatCatchAllScopeSummary } from "../core/context.js"
import { spawnBackgroundSave, type SpawnResult } from "./background.js"
import { fireDigestIfStale, scheduleAutoDigestSpawn } from "./digest-scheduler.js"
import {
  recordBackgroundModelCostEvent,
  recordWakeupContextCostEvent,
} from "./cost-events.js"
import { getStateDir, logPath } from "./lock.js"
import {
  ensureHookStateDir,
  safeFilenameSegment,
  writeHookStateFile,
} from "./marker-key.js"
import { canonicalizeAgentName } from "./agent-identity.js"
import {
  clearBackgroundFailure,
  recordBackgroundFailure,
} from "./background-failure-marker.js"
import type { BackgroundFailureScope } from "./background-failure-marker.js"

/** Hook payload fields shared by Claude Code and Codex. */
interface HookEvent {
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
  source?: string
  last_assistant_message?: string
  stop_hook_active?: boolean
}

/**
 * Derive a human-readable agent name from the hook environment.
 *
 * Claude Code sets CLAUDECODE=1 and CLAUDE_CODE_* env vars when it spawns
 * hooks; no equivalent fingerprint exists for Codex or other agents. When
 * neither Claude Code's markers nor an explicit LORE_AGENT_NAME override
 * are present, return undefined — callers omit the Agent line rather than
 * stamping a confident-but-wrong guess onto the memory. The Codex installer
 * should inject `LORE_AGENT_NAME=Codex` into .codex/hooks.json's env so
 * Codex sessions resolve here; other integrations do the same.
 *
 * Both resolution paths route through `canonicalizeAgentName` so the eight
 * Claude variants we've produced in the wild collapse to one bucket on the
 * write side. Third-party names (`Codex`, `Cline`, `Cursor`) pass through
 * unchanged, preserving the PF1-04 explicit-over-inferred contract.
 *
 * Exported for unit-test coverage; not part of the module's public surface
 * for production callers.
 */
export function deriveAgentName(_event: HookEvent): string | undefined {
  const override = process.env["LORE_AGENT_NAME"]
  if (override && override.trim()) return canonicalizeAgentName(override)

  const claudeCodeMarkers = Object.keys(process.env).some((k) =>
    k.startsWith("CLAUDE_CODE_")
  )
  if (claudeCodeMarkers || process.env["CLAUDECODE"] === "1") {
    return canonicalizeAgentName("Claude Code")
  }

  return undefined
}

/**
 * Derive the human-author name for the autosave background spawn
 * (DEFERRED-ATTRIBUTION). Parallel to `deriveAgentName` but for the
 * `Author` Memory column rather than `Agent`.
 *
 * The autosave hook spawns a detached `claude -p` sub-agent that
 * connects to its own MCP server, which lazily resolves identity on
 * writes that omit `author`. We *also* surface the env-override here at
 * prompt-build time so the spawned sub-agent's prompt can carry the
 * canonical `Author: ...` line for textual context — and so an engineer
 * who set `LORE_USER_NAME` in their shell rc gets attribution without
 * asking the MCP child to call `users.me`.
 *
 * Returns undefined when no override is set; callers omit the Author
 * line in that case rather than stamping a placeholder. The spawned
 * MCP server's lazy `users.me` fallback can still resolve the engineer
 * identity — but only if the parent forwards the credentials needed
 * for the call (per `spawnBackgroundSave`'s env-passthrough rules).
 *
 * Exported for unit-test coverage; not part of the module's public
 * surface for production callers.
 */
export function deriveAuthorName(_event: HookEvent): string | undefined {
  const override = process.env["LORE_USER_NAME"]
  if (override && override.trim()) return override.trim()
  return undefined
}

// ---------------------------------------------------------------------------
// State management — per-session save count in $TMPDIR
// ---------------------------------------------------------------------------

async function ensureStateDir(): Promise<void> {
  await ensureHookStateDir(getStateDir())
}

/**
 * Save-count filename for a session id. Routed through
 * `safeFilenameSegment` so the same sanitization policy that protects
 * `lockPath` / `logPath` also protects the per-session counter — a
 * payload with `/`, `..`, backslashes, whitespace, or shell metacharacters
 * stays inside `getStateDir()` rather than escaping into the filesystem.
 *
 * Exported so the path-injection tests can assert the sanitization
 * directly without round-tripping through `handleStop`.
 */
export function statePath(sessionId: string): string {
  return join(getStateDir(), `${safeFilenameSegment(sessionId)}.count`)
}

/**
 * Per-session attempt marker for prompt-bearing wake-up hooks. Codex's
 * `UserPromptSubmit` currently lacks Claude Code's `runOnce`, so the helper
 * owns the debounce that keeps wake-up to the first enabled prompt event.
 */
export function wakeupStatePath(sessionId: string): string {
  return join(getStateDir(), `${safeFilenameSegment(sessionId)}.wakeup`)
}

async function readSaveCount(sessionId: string | undefined): Promise<number> {
  if (!sessionId) return 0
  try {
    const raw = await readFile(statePath(sessionId), "utf-8")
    return parseInt(raw, 10) || 0
  } catch {
    return 0
  }
}

async function writeSaveCount(
  sessionId: string | undefined,
  count: number
): Promise<void> {
  if (!sessionId) return
  await ensureStateDir()
  await writeHookStateFile(statePath(sessionId), count.toString())
}

async function tryMarkWakeupRun(sessionId: string | undefined): Promise<boolean> {
  if (!sessionId) return true
  await ensureStateDir()
  try {
    await writeHookStateFile(wakeupStatePath(sessionId), "1", { flag: "wx" })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false
    throw err
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Lightweight project context resolution from .lore.yaml — no Notion API
 * calls. Mirrors `resolveProject`'s longest-prefix logic and
 * additionally surfaces the sub-project list and catch-all name so the
 * save prompts can enumerate alternatives.
 */
function resolveProjectContext(
  cwd: string,
  configRoot: string,
  projects: Array<{ name: string; path: string }> | undefined
): { subProjects: string[]; catchAllName: string | null } {
  if (!projects?.length) {
    return { subProjects: [], catchAllName: null }
  }

  const subProjects: string[] = []
  let catchAllName: string | null = null
  for (const project of projects) {
    const normalized = project.path === "." ? "" : project.path.replace(/^\//, "")
    if (normalized === "") {
      catchAllName = catchAllName ?? project.name
    } else {
      subProjects.push(project.name)
    }
  }

  // cwd-aware validation: only warn about sub-projects if the cwd is
  // actually inside the config root. Outside-root callers don't need
  // project guidance at all.
  const relPath = relative(resolve(configRoot), resolve(cwd))
  if (relPath.startsWith("..")) {
    return { subProjects: [], catchAllName: null }
  }

  return { subProjects, catchAllName }
}

interface HookState {
  hookConfig: HookConfig
  config: LoreConfig | null
  configRoot: string | null
}

function reportHookConfigWarnings(configPath: string, warnings: string[]): void {
  if (warnings.length === 0) return

  const displayPath = configPath.replace(homedir(), "~")
  process.stderr.write(`[lore] Recovered ${displayPath} with hook defaults.\n`)
  for (const warning of warnings) {
    const formatted = warning.trimEnd().split("\n").join("\n[lore]   ")
    process.stderr.write(`[lore]   ${formatted}\n`)
  }
}

function resolveMemoryCaptureModeForStop(
  config: HookConfig,
  context?: StopFailureContext
): HookConfig["memoryCaptureMode"] {
  if (context?.config?.hooks?.memoryCaptureMode !== undefined) {
    return config.memoryCaptureMode
  }
  if (context?.config?.profile?.startsWith("conversational@")) {
    return "conversational"
  }
  return config.memoryCaptureMode
}

function isConversationalProfileSelector(selector?: string): boolean {
  return selector?.startsWith("conversational@") === true
}

function resolveProfilePromptsForStop(context?: StopFailureContext) {
  if (!context?.config) {
    return undefined
  }
  if (isConversationalProfileSelector(context.config.profile)) {
    return undefined
  }
  return context.configRoot
    ? resolveProfileFromConfigAtRoot(context.config, context.configRoot).prompts
    : resolveProfileFromConfig(context.config).prompts
}

async function loadHookState(): Promise<HookState> {
  const found = await findConfigFile(process.cwd())
  if (!found) {
    return {
      hookConfig: mergeHookDefaults(undefined),
      config: null,
      configRoot: null,
    }
  }

  try {
    const { config, warnings } = await loadConfigAllowingInvalidHooks(found.path)
    reportHookConfigWarnings(found.path, warnings)
    const { subProjects, catchAllName } = resolveProjectContext(
      process.cwd(),
      found.root,
      config.projects
    )
    return {
      hookConfig: mergeHookDefaults(
        config.hooks,
        catchAllName,
        subProjects,
        process.env,
        config.features
      ),
      config,
      configRoot: found.root,
    }
  } catch (err) {
    process.stderr.write(
      `[lore] Failed to load ${found.path}: ${redactDebugError(err)}. Using hook defaults.\n`
    )
    return {
      hookConfig: mergeHookDefaults(undefined),
      config: null,
      configRoot: null,
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const action = process.argv[2]
  switch (action) {
    case "autosave":
      await runAutosave()
      break
    case "wakeup":
      await wakeup()
      break
    case "auto-digest":
      await handleAutoDigest()
      break
    case "session-end":
      // Exit-0 compatibility action for stale Claude Code settings
      // registrations. `lore install --client claude` strips the
      // registration on reinstall; this case lets any stale settings
      // exit cleanly without side effects.
      await handleSessionEnd()
      break
    default:
      process.stderr.write(`Unknown hook action: ${action}\n`)
      process.exit(1)
  }
}

/**
 * True when this module is the Node entry point (invoked directly as
 * the launcher script). False when imported from another module —
 * tests import this file directly and must not trigger `main()`'s
 * process.exit paths or argv routing.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return fileURLToPath(import.meta.url) === entry
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Autosave — event router
// ---------------------------------------------------------------------------

/**
 * Stop / autosave entry point. Two callers:
 *   - Legacy shell shim: forwards stdin via `LORE_AUTOSAVE_CONTENT`
 *     (no `event` argument); the env var path is preserved for
 *     compatibility with legacy installs.
 *   - `lore hooks autosave`: reads stdin in the CLI subcommand and
 *     passes it through `opts.event`. Skips the env var entirely.
 *
 * `opts.event` wins when both are set so a CLI caller can override a
 * stale env var inherited from a parent process.
 */
export async function runAutosave(opts: { event?: string } = {}): Promise<void> {
  // Env var opt-out: LORE_AUTOSAVE=false disables for this session
  if (process.env["LORE_AUTOSAVE"] === "false") {
    process.stdout.write("{}\n")
    return
  }

  const raw = opts.event ?? process.env["LORE_AUTOSAVE_CONTENT"]
  if (!raw) {
    process.stderr.write("LORE_AUTOSAVE_CONTENT not set, skipping.\n")
    return
  }

  // Config opt-out: hooks.autoSave: false in .lore.yaml
  const { hookConfig, config, configRoot } = await loadHookState()
  if (!hookConfig.autoSave) {
    process.stdout.write("{}\n")
    return
  }

  let event: HookEvent
  try {
    event = JSON.parse(raw) as HookEvent
  } catch {
    event = { last_assistant_message: raw }
  }

  await handleStop(event, hookConfig, { config, configRoot })
}

// ---------------------------------------------------------------------------
// Stop — count-based trigger, spawns background save (non-blocking)
// ---------------------------------------------------------------------------

interface TranscriptForSave {
  transcript: TranscriptInspection
  userMessageCount: number
}

export interface StopFailureContext {
  config: LoreConfig | null
  configRoot: string | null
}

function projectNameForStopEvent(
  event: HookEvent,
  context?: StopFailureContext
): string | undefined {
  if (!context?.config || !context.configRoot) return undefined
  return (
    resolveProjectPathFromCwd(
      event.cwd ?? process.cwd(),
      context.configRoot,
      context.config
    )?.name ?? undefined
  )
}

function spawnFailureMessage(result: SpawnResult, command: string): string | null {
  switch (result.kind) {
    case "binary-missing":
      return `background command "${command}" not found`
    case "tempfile-failed":
      return "failed to prepare prompt file"
    case "spawn-error":
      return `spawn failed: ${result.error instanceof Error ? result.error.message : String(result.error)}`
    case "lock-path-too-long":
      return `lock path too long (${result.code}); shorten LORE_HOOK_STATE_DIR`
    default:
      return null
  }
}

async function clearStopFailure(
  configRoot: string | null | undefined,
  scope: BackgroundFailureScope,
  before?: Date
): Promise<void> {
  try {
    await clearBackgroundFailure(configRoot, "autosave", scope, { before })
  } catch {
    // Marker cleanup is diagnostic only; never block the Stop hot path.
  }
}

/**
 * Derive the foreground's resolved `AuthSource` for the autosave spawn
 * + auto-digest helper-fork env partition. Returns
 * `undefined` when the Stop path has no loaded config (failure-context
 * fallback in `loadHookState`) or when `resolveAuth` itself rejects —
 * both branches preserve the every-key forward so the Stop
 * hot path never gains a new failure mode. The detached children's
 * own startup `resolveAuth` calls surface genuine auth problems
 * through their stderr logs.
 *
 * Cost reflects `resolveAuth`'s priority walk:
 * `NOTION_API_TOKEN`-source operators short-circuit at priority 1
 * with zero I/O; `ntn-auth-json` operators pay the auth.json
 * `readFile` plus a dynamic import of the ntn-token loader. Only
 * the `NOTION_API_TOKEN` path avoids any I/O. `loadNtnToken`'s
 * dynamic import is cached after the first call (rarely matters
 * since `lore hooks autosave` is a fresh process per Stop), and the
 * read itself is a single small-file `readFile` — negligible for
 * the Stop hot path's "in-the-millisecond" budget. The hook-agent
 * doc carries the "Two-process split is load-bearing" addendum; if
 * you change the behavior here, update that doc.
 *
 * Exported for unit-test coverage of the four-branch failure matrix
 * (no failureContext, null config, resolveAuth rejection, success);
 * not part of the module's public surface for production callers.
 */
export async function deriveStopAuthSource(
  failureContext: StopFailureContext | undefined
): Promise<AuthSource | undefined> {
  if (!failureContext?.config || !failureContext.configRoot) return undefined
  try {
    const resolved = await resolveAuth(failureContext.config, failureContext.configRoot, {
      quiet: true,
    })
    return resolved.source
  } catch {
    return undefined
  }
}

/**
 * Read and inspect the transcript for an autosave event. Returns null when
 * the event has no transcript path or the file can't be read; callers
 * should treat that as "skip this save".
 */
async function readTranscriptForSave(
  event: HookEvent,
  label: string
): Promise<TranscriptForSave | null> {
  if (!event.transcript_path) return null
  let raw: string
  try {
    raw = await readFile(event.transcript_path, "utf-8")
  } catch (err) {
    process.stderr.write(
      `[lore] ${label}: failed to read transcript: ${redactDebugError(err)}\n`
    )
    return null
  }
  const transcript = inspectTranscript(raw)
  if (
    transcript.totalNonEmptyLineCount > 0 &&
    transcript.messages.length === 0 &&
    (transcript.malformedLineCount > 0 || transcript.ignoredLineCount > 0)
  ) {
    process.stderr.write(
      `[lore] ${label} could not read any transcript messages ` +
        `(${transcript.malformedLineCount} malformed, ${transcript.ignoredLineCount} ignored).\n`
    )
  }
  const userMessageCount = transcript.messages.filter((m) => m.role === "user").length
  return { transcript, userMessageCount }
}

/**
 * Stop handler: counts real user messages and, when the save interval is
 * reached, spawns a detached `claude -p` sub-agent that writes structured
 * content via Lore's MCP tools. The main agent is never blocked — the Stop
 * hook always emits `{}` so the user's next turn starts immediately.
 *
 * Save work is gated by a per-session lock so two overlapping hook fires
 * can't race on the same transcript. Auto-digest synthesis is offloaded to
 * a separate detached node child via `scheduleAutoDigestSpawn` so the Stop
 * path never gathers digest data or initializes Notion clients inline.
 */
export async function handleStop(
  event: HookEvent,
  config: HookConfig,
  failureContext?: StopFailureContext
): Promise<void> {
  try {
    const failureScope: BackgroundFailureScope = {
      projectName: projectNameForStopEvent(event, failureContext),
      sessionId: event.session_id,
    }
    // Resolve the foreground's auth source once per Stop fire so
    // BOTH the autosave spawn AND the auto-digest helper fork apply
    // the ntn-source partition. One disk read of
    // ~/.config/notion/auth.json covers both hops; the digest
    // helper would otherwise inherit the parent's full env (Node
    // default) and leak NOTION_API_TOKEN even when the foreground
    // resolved via ntn. Derived BEFORE the no-transcript early
    // return so that path's `scheduleAutoDigestSpawn` also gets the
    // partition. Defensive: a `resolveAuth` failure (no token
    // configured, transient auth.json read error) falls back to
    // the legacy every-key forward so the Stop hot path itself
    // never gains a new failure mode. The spawned children re-run
    // `resolveAuth` themselves and surface genuine auth problems
    // through their own stderr logs.
    const authSource = await deriveStopAuthSource(failureContext)
    const read = await readTranscriptForSave(event, "Stop hook")
    if (!read) {
      process.stdout.write("{}\n")
      scheduleAutoDigestSpawn(event.cwd ?? process.cwd(), {
        configRoot: failureContext?.configRoot,
        projectName: failureScope.projectName,
        sessionId: failureScope.sessionId,
        authSource,
      })
      return
    }
    const { transcript, userMessageCount: currentCount } = read
    const lastSaveCount = await readSaveCount(event.session_id)
    const { saveInterval } = config
    // First save fires sooner to catch short sessions (min 2 messages).
    // Subsequent saves use the full configured interval.
    const isFirstSave = lastSaveCount === 0
    const threshold = isFirstSave ? Math.min(saveInterval, 2) : saveInterval
    const sinceLast = currentCount - lastSaveCount

    if (sinceLast >= threshold) {
      const sessionContent = formatTranscriptSessionContent(transcript.messages)
      if (sessionContent) {
        // Atomic-learning extraction is disabled if EITHER knob
        // says so — env var OR config — so both must be permissive for
        // the section to ship. Same posture as `autoDigest`'s pair of
        // knobs above; an operator who set the env var and then forgot
        // can't be silently re-enabled by a config-default.
        const learningExtractionEnabled =
          config.learningExtraction && config.features.learningExtraction
        // Durable mode keeps accepted-by-default behavior unless the
        // operator opts into proposed learning saves. Conversational
        // mode gets its safer proposed default inside the prompt
        // builder when this option is left undefined.
        const proposeLearnings =
          learningExtractionEnabled && config.proposeAutosaveLearnings ? true : undefined
        const profilePrompts = resolveProfilePromptsForStop(failureContext)
        const prompt = buildBackgroundSavePrompt(
          config.subProjects,
          config.catchAllName,
          sessionContent,
          event.session_id,
          deriveAgentName(event),
          {
            extractLearnings: learningExtractionEnabled,
            proposeLearnings,
            authorName: deriveAuthorName(event),
            profilePrompts,
            memoryCaptureMode: resolveMemoryCaptureModeForStop(config, failureContext),
          }
        )
        // Only advance the save counter when a background process actually
        // started. Every non-`spawned` result — benign races (lock-held,
        // cap-hit, race-lost) and genuine failures (binary-missing,
        // tempfile-failed, spawn-error) alike — must leave the counter
        // where it is. For benign races, the peer's spawn will produce a
        // memory and the next Stop catches up against the new count. For
        // genuine failures, leaving the counter unchanged lets the next
        // Stop hook retry.
        // Capture the recovery boundary before spawning so cleanup only clears
        // failures observed before this attempt; concurrent failures at or after
        // this timestamp must survive for the operator to see.
        const recoveredAt = new Date()
        const result = spawnBackgroundSave(
          event.cwd ?? process.cwd(),
          prompt,
          event.session_id,
          { agent: config.backgroundAgent, authSource }
        )
        await recordBackgroundModelCostEvent({
          costTracking:
            failureContext?.config && failureContext.configRoot
              ? resolveCostTracking(failureContext.config, failureContext.configRoot)
              : undefined,
          eventType: "autosave.background_model",
          source: "hook",
          prompt,
          result,
          projectName: failureScope.projectName ?? undefined,
          agentName: deriveAgentName(event),
          sessionId: event.session_id,
          agent: config.backgroundAgent,
        })
        if (result.kind === "spawned") {
          await writeSaveCount(event.session_id, currentCount)
          await clearStopFailure(failureContext?.configRoot, failureScope, recoveredAt)
        } else {
          const message = spawnFailureMessage(result, config.backgroundAgent.command)
          if (message) {
            recordBackgroundFailure(failureContext?.configRoot, {
              kind: "autosave",
              ...failureScope,
              code: result.kind,
              message,
              logPath:
                result.kind === "spawn-error" && event.session_id
                  ? logPath(event.session_id)
                  : undefined,
            })
          }
        }
      }
    }
    process.stdout.write("{}\n")
    // Auto-digest scheduling runs in a detached child so the parent Stop
    // hook never pays the cost of .lore.yaml parse + Notion init + digest
    // gather. The marker debounce inside the helper guarantees ≤ 1 digest
    // per project per 7 days regardless of how often Stop fires.
    scheduleAutoDigestSpawn(event.cwd ?? process.cwd(), {
      configRoot: failureContext?.configRoot,
      projectName: failureScope.projectName,
      sessionId: failureScope.sessionId,
      authSource,
    })
  } catch (err) {
    // Fail open: let the AI stop. We intentionally do NOT schedule the
    // auto-digest helper from this branch — an unexpected throw inside
    // the Stop path means we don't know what state we're in (transcript
    // corruption, lock-state inconsistency, fs errors), and the marker
    // debounce will let the next clean Stop hook fire the digest anyway.
    process.stderr.write(`[lore] Stop hook error: ${redactDebugError(err)}\n`)
    process.stdout.write("{}\n")
  }
}

// ---------------------------------------------------------------------------
// Wakeup — load context on the first user prompt (Claude Code and Codex)
// ---------------------------------------------------------------------------
//
// Claude Code registration sets `runOnce: true` on the `UserPromptSubmit`
// hook (the `mergeClaudeHookEntries` install path writes the flag).
// Codex's `UserPromptSubmit` hook exposes the prompt too, but has no
// equivalent `runOnce`, so the helper maintains a per-session marker
// before it touches Notion. That keeps ranked wake-up as a first-prompt
// path instead of a per-turn query.

/**
 * Parse the JSON payload host `UserPromptSubmit` hooks deliver
 * on stdin (forwarded by `wakeup.sh` via `LORE_WAKEUP_EVENT`). Returns
 * the user's prompt text when present, `undefined` otherwise. The
 * `undefined` return is the fallback signal — wake-up degrades to
 * unranked output without needing a user query.
 *
 * Several callers produce `undefined` and they all drop into the same
 * fallback path:
 * - Env var unset (legacy Codex `SessionStart`; resumed sessions
 *   that fire `SessionStart` rather than `UserPromptSubmit`; legacy
 *   `wakeup.sh` that didn't forward stdin).
 * - Env var set but not JSON (a misconfigured hook script).
 * - Env var set with valid JSON but no `prompt` field, or a non-string
 *   `prompt` (a future host event shape we haven't seen yet — the field
 *   name has been stable in Claude Code and Codex hook payloads, but
 *   pinning here means a rename degrades silently rather than crashes).
 * - Prompt parses cleanly but is a slash command (`/clear`,
 *   `/compact`, etc.). These would seed the relevance ranker with
 *   meta-commands rather than task language — useless as search input,
 *   so we treat them as "no user query" and let the fallback path run.
 *
 * They're not distinguished because callers can't act on the difference
 * — the only useful signal is "did we get a usable prompt or not."
 *
 * Hook payload schemas (incl. the `prompt` field on `UserPromptSubmit`) are
 * documented by each host vendor under their `UserPromptSubmit` hook section.
 * If the field name changes, this parser is the one place that needs updating.
 *
 * Exported for unit-test coverage; not part of the module's public
 * surface for production callers.
 */
export function parseUserQueryFromEvent(raw: string | undefined): string | undefined {
  if (!raw || raw.trim().length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const event = parsed as { prompt?: unknown; hook_event_name?: unknown }
  // PF3-04 (bundled): when `hook_event_name` is set and is NOT
  // `UserPromptSubmit`, drop to the fallback path. Today only
  // `UserPromptSubmit` carries a usable `prompt` field; a future event
  // that happens to include `prompt` shouldn't be silently consumed
  // as a search seed without an explicit decision here. Absent or
  // non-string `hook_event_name` is treated as legacy/unknown — fall
  // through to the prompt check so we don't break callers that strip
  // the field.
  if (
    typeof event.hook_event_name === "string" &&
    event.hook_event_name !== "UserPromptSubmit"
  ) {
    return undefined
  }
  const prompt = event.prompt
  if (typeof prompt !== "string") return undefined
  const trimmed = prompt.trim()
  if (trimmed.length === 0) return undefined
  // Slash commands are meta-instructions to the host assistant, not
  // task language. Seeding the relevance ranker with `/clear` or
  // `/compact` would produce noise hits (any memory mentioning the
  // word "clear") and waste a Notion round-trip. Drop to the fallback
  // path so wake-up uses unranked output instead.
  if (trimmed.startsWith("/")) return undefined
  return trimmed
}

export function parseWakeupEventMetadata(raw: string | undefined): {
  hookEventName?: string
  sessionId?: string
  source?: string
} {
  if (!raw || raw.trim().length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {}
  }
  const event = parsed as {
    hook_event_name?: unknown
    session_id?: unknown
    source?: unknown
  }
  return {
    hookEventName:
      typeof event.hook_event_name === "string" ? event.hook_event_name : undefined,
    sessionId:
      typeof event.session_id === "string" && event.session_id.trim().length > 0
        ? event.session_id
        : undefined,
    source: typeof event.source === "string" ? event.source : undefined,
  }
}

/**
 * Hook-local project-framing renderer.
 *
 * Diverges from the shared `renderProjectContextLines` by routing every
 * Notion-derived field — project name, path, description, sibling list,
 * and the catch-all warning's name/sibling splice — through
 * `indentUntrustedText`. The shell wake-up output renders into a host
 * LLM's session-start prompt, so a writable-vault editor must not be
 * able to land an unindented directive line through the framing block.
 *
 * Hook-generated structural labels (`Project:`, `Siblings:`, the
 * blockquote `>` marker, and the catch-all warning's surrounding wording)
 * stay inside the indented line by design: the entire visual block is
 * the quoted region. The MCP surfaces (`lore-context action='wake-up'`,
 * `lore-query action='ask'`) keep using the shared renderer because
 * their callers consume the framing as structured tool output, not as
 * a session-start LLM prompt.
 */
function renderHookProjectContextLines(context: ProjectContext | null): string[] {
  if (!context) return []
  const lines: string[] = []

  if (context.isCatchAllFallback && context.siblings.length > 0) {
    lines.push(
      indentUntrustedText(
        `> ${formatCatchAllScopeSummary(context.name, context.siblings)} ` +
          `Pass projectName to scope to a specific sub-project.`
      )
    )
  }

  const pathSuffix = context.path ? ` (${context.path})` : ""
  lines.push(indentUntrustedText(`Project: ${context.name}${pathSuffix}`))

  if (context.description) {
    lines.push(indentUntrustedText(context.description))
  }

  if (context.siblings.length > 0) {
    lines.push(indentUntrustedText(`Siblings: ${context.siblings.join(", ")}.`))
  }

  return lines
}

const HOOK_WAKEUP_TASK_INVENTORY_LIMIT = 0
const HOOK_WAKEUP_ACTIVE_TASK_RELATED_MEMORY_LIMIT = 0

export async function wakeup(opts: { event?: string } = {}): Promise<void> {
  const rawEvent = opts.event ?? process.env["LORE_WAKEUP_EVENT"]
  const eventMeta = parseWakeupEventMetadata(rawEvent)
  const debug = process.env["LORE_DEBUG"] === "1"
  const userQuery = parseUserQueryFromEvent(rawEvent)

  // Config opt-out: hooks.wakeUp: false suppresses context injection.
  // Check before service initialization so we avoid the Notion round-trip when disabled.
  const hookState = await loadHookState()
  const { hookConfig } = hookState
  const hookCostTracking =
    hookState.config && hookState.configRoot
      ? resolveCostTracking(hookState.config, hookState.configRoot)
      : undefined
  if (!hookConfig.wakeUp) {
    await recordWakeupContextCostEvent({
      costTracking: hookCostTracking,
      status: "skipped",
      agentName: process.env["LORE_AGENT_NAME"],
      sessionId: eventMeta.sessionId,
    })
    return
  }
  if (!hookState.config || !hookState.configRoot) return

  if (eventMeta.hookEventName === "UserPromptSubmit") {
    let marked = true
    try {
      marked = await tryMarkWakeupRun(eventMeta.sessionId)
    } catch (err) {
      process.stderr.write(
        `[lore] wakeup: debounce mark failed — ${redactDebugError(err)}.\n`
      )
    }
    if (!marked) {
      if (debug) {
        process.stderr.write(
          `${formatWakeUpCoverage(
            emptyWakeUpCoverageMetrics("default", "already-ranked-for-session")
          )}\n`
        )
      }
      await recordWakeupContextCostEvent({
        costTracking: hookCostTracking,
        status: "skipped",
        agentName: process.env["LORE_AGENT_NAME"],
        sessionId: eventMeta.sessionId,
      })
      return
    }
  }

  let services: Awaited<ReturnType<typeof initServicesFromConfig>>
  try {
    // Wake-up fires on the first user prompt. Drift
    // detection is debounced via the per-config-root marker so an
    // operator on a stale vault still gets occasional warnings without
    // the multi-page Topics scan running against the rate-limited
    // client every fire..
    services = await initServicesFromConfig(
      process.cwd(),
      hookState.configRoot,
      hookState.config,
      { driftCheck: "debounced" }
    )
  } catch (err) {
    // Init failures may carry SDK-interpolated request-scoped detail
    // (vault page id, base URL, partial query text). Route through the
    // shared `LORE_DEBUG` redactor so the centralized stderr surface
    // doesn't leak vault locators to a log aggregator.
    process.stderr.write(
      `[lore] wakeup: init failed — ${redactDebugError(err)}. Run \`lore status\` or \`lore migrate\` to diagnose.\n`
    )
    await recordWakeupContextCostEvent({
      costTracking: hookCostTracking,
      status: "error",
      agentName: process.env["LORE_AGENT_NAME"],
      sessionId: eventMeta.sessionId,
    })
    return
  }
  const project = services.context.project

  // `UserPromptSubmit` payloads carry the user's actual question,
  // letting wake-up rank memories instead of dumping generic recents. Current
  // Claude Code and Codex installs pass the payload via stdin/`opts.event`;
  // legacy `SessionStart` installs and other callers with no prompt fall
  // through to the data-layer defaults.
  const rankedLimits = userQuery
    ? {
        ...RANKED_WAKEUP_LIMITS,
        relatedMemoryLimit: HOOK_WAKEUP_ACTIVE_TASK_RELATED_MEMORY_LIMIT,
      }
    : {}

  let digest, memories, knowledgeFacts, taskMemories, coverage
  try {
    ;({ digest, memories, knowledgeFacts, taskMemories, coverage } = await loadWakeUpData(
      services,
      {
        projectId: project?.id,
        // Hook rendering only uses title/source/date - skip the N+1 markdown fetch.
        includeMemoryContent: false,
        // Hook never renders decisions - skip the two Notion queries so
        // session-start latency doesn't regress on the hot path.
        includeDecisions: false,
        // Hook never renders the Proposed Memories inbox section —
        // skip the extra Notion query so the session-start latency
        // stays unchanged. Same posture as `includeDecisions: false`.
        includeProposedMemories: false,
        // Hook never renders the Inherited Memories section — skip
        // the per-upstream Notion fan-out so the session-start hot
        // path doesn't pay one `dataSources.query` per configured
        // upstream on every launch. Same posture as
        // `includeDecisions: false` etc. The previous default
        // (`true`) was a performance regression and a privacy
        // posture change operators hadn't opted into.
        includeInheritedMemories: false,
        // Hook never renders the Pinned Context section — skip
        // the `listPinnedBlocks` + `countPinnedBlocks`
        // round-trips so the session-start hot path doesn't pay
        // two extra `dataSources.query` calls per launch. Same
        // posture as `includeInheritedMemories: false` above. The
        // MCP `lore-context action='wake-up'` surface still renders
        // pinned blocks at default; agents that need pinned
        // context call the MCP surface explicitly.
        includePinnedBlocks: false,
        // Hook wake-up is automatic session-start prompt material, not a
        // task-triage surface. These caps skip task inventory and the
        // active-task-entity related-memory query; they do not affect the
        // user-query-seeded "For Your Current Task" search.
        taskLimit: HOOK_WAKEUP_TASK_INVENTORY_LIMIT,
        includeCoverage: debug,
        userQuery,
        cache: services.wakeupCache,
        ...rankedLimits,
      }
    ))
  } catch (err) {
    // Wake-up is decorative. A transient Notion failure must not block
    // session startup — log and exit clean.
    if (debug) {
      process.stderr.write(
        `${formatWakeUpCoverage(emptyWakeUpCoverageMetrics("error", "load-failed"))}\n`
      )
    }
    // Load failures are exactly the path the Notion SDK is most likely
    // to interpolate request-scoped detail into `Error.message` (page
    // ids, partial query fragments, sometimes echoed bodies). Route
    // through the shared `LORE_DEBUG` redactor before the message lands
    // on stderr.
    process.stderr.write(
      `[lore] wakeup: load failed — ${redactDebugError(err)}. Skipping context injection.\n`
    )
    await recordWakeupContextCostEvent({
      costTracking: services.costTracking,
      status: "error",
      projectName: project?.name,
      agentName: process.env["LORE_AGENT_NAME"],
      sessionId: eventMeta.sessionId,
    })
    return
  }

  if (debug) {
    // Operator-facing log: report the ranked/default path, the applied
    // ranked caps, and rendered section counts. It intentionally carries
    // only lengths and ages: no titles, memory bodies, fact text, or query
    // text. Operators can tune retrieval without leaking vault content
    // into stderr.
    if (coverage) {
      process.stderr.write(
        `${formatWakeUpCoverage(
          coverage,
          userQuery
            ? {
                memoryLimit: RANKED_WAKEUP_LIMITS.memoryLimit,
                relatedMemoryLimit: HOOK_WAKEUP_ACTIVE_TASK_RELATED_MEMORY_LIMIT,
                knowledgeFactLimit: RANKED_WAKEUP_LIMITS.knowledgeFactLimit,
                taskMemoryLimit: RANKED_WAKEUP_LIMITS.taskMemoryLimit,
              }
            : {}
        )}\n`
      )
    }
  }

  const sections: string[] = []

  // The shell hook always reads `services.context.project` and
  // `services.context.isCatchAllFallback` — there is no
  // explicit-projectName override on this path. The hook-local render
  // path mirrors the MCP framing block but routes every Notion-derived
  // field through `indentUntrustedText`, so a hostile project name,
  // path, description, or sibling string lands in a 4-space code-quoted
  // block instead of as session-start markdown.
  const projectContextLines = renderHookProjectContextLines(
    composeProjectContext(project, hookState.config, services.context.isCatchAllFallback)
  )
  if (projectContextLines.length > 0) {
    sections.push(projectContextLines.join("\n"))
  }

  // Vault-sourced lines below this point inherit the writability of the
  // configured Notion vault — anyone with edit rights can land arbitrary
  // strings into a memory title, digest body, task title, or fact triple.
  // Mirror the autosave/digest writer-side framing: emit an explicit
  // trust-boundary preamble once, then route every Notion-sourced field
  // through `indentUntrustedText` so the host LLM reads the lines as
  // quoted data rather than as session-start instructions.
  const dataSections: string[] = []

  if (digest) {
    dataSections.push(`\n## Latest Digest — ${digest.createdAt.split("T")[0]}`)
    dataSections.push(indentUntrustedText(`**${digest.title}**`))
    if (digest.content) {
      dataSections.push("", indentUntrustedText(digest.content.trim()))
    }
  }

  // Relevance hits seeded by the user's first message. Surfaced
  // directly under the digest because it's the densest single signal
  // about what the user is actually asking about — denser than
  // timestamp-ordered recents or active-task seeds. The section is
  // omitted entirely when no userQuery was available so the output
  // stays free of an empty section header on the fallback path.
  if (taskMemories && taskMemories.length > 0) {
    dataSections.push("\n## For Your Current Task")
    for (const mem of taskMemories) {
      dataSections.push(
        indentUntrustedText(
          `- **${mem.title}** (${mem.source}, ${mem.createdAt.split("T")[0]})`
        )
      )
    }
  }

  if (memories.length > 0) {
    dataSections.push(
      digest ? "\n## Recent Memories (since digest)" : "\n## Recent Memories"
    )
    const buckets = new Map<string, typeof memories>()
    for (const mem of memories) {
      const bucket = dateBucket(mem.createdAt)
      if (!buckets.has(bucket)) buckets.set(bucket, [])
      buckets.get(bucket)!.push(mem)
    }
    for (const label of ["Today", "Yesterday", "Earlier"] as const) {
      const mems = buckets.get(label)
      if (!mems) continue
      dataSections.push(`### ${label}`)
      for (const mem of mems) {
        dataSections.push(
          indentUntrustedText(
            `- **${mem.title}** (${mem.source}, ${mem.createdAt.split("T")[0]})`
          )
        )
      }
    }
  }

  if (knowledgeFacts.length > 0) {
    dataSections.push("\n## Active Facts")
    for (const fact of knowledgeFacts) {
      dataSections.push(
        indentUntrustedText(
          `- ${fact.subject} ${fact.predicate.replace(/_/g, " ")} ${fact.object}`
        )
      )
    }
  }

  if (dataSections.length > 0) {
    sections.push(...dataSections)
  }

  if (sections.length > 0) {
    // The project-framing block carries a Notion-sourced project
    // description, so the trust-boundary header must precede everything
    // including the framing — not just the data sections. Mirrors the
    // autosave/digest writer-side framing: one preamble per surface,
    // applied once at the top, never re-emitted per section.
    sections.unshift(UNTRUSTED_VAULT_PREAMBLE)
    sections.unshift("# Lore Context")
    const output = sections.join("\n")
    console.log(output)
    await recordWakeupContextCostEvent({
      costTracking: services.costTracking,
      status: "success",
      output,
      projectName: project?.name,
      agentName: process.env["LORE_AGENT_NAME"],
      sessionId: eventMeta.sessionId,
    })
  } else {
    await recordWakeupContextCostEvent({
      costTracking: services.costTracking,
      status: "skipped",
      projectName: project?.name,
      agentName: process.env["LORE_AGENT_NAME"],
      sessionId: eventMeta.sessionId,
    })
  }
}

// ---------------------------------------------------------------------------
// Auto-digest — detached helper invoked by Stop, runs digest synthesis
// off the hot path so Notion init / digest data gathering never block the
// Stop hook itself.
// ---------------------------------------------------------------------------

/**
 * True when `LORE_AUTO_DIGEST=false` is set. Env overrides .lore.yaml —
 * consistent with how `LORE_AUTOSAVE=false` overrides `hooks.autoSave`.
 */
function autoDigestEnvDisabled(): boolean {
  return process.env["LORE_AUTO_DIGEST"] === "false"
}

/**
 * Auto-digest action handler. Runs in the detached node child spawned by
 * the Stop hook (via `scheduleAutoDigestSpawn`).
 *
 * Loads .lore.yaml, honors `hooks.autoDigest: false` plus
 * `LORE_AUTO_DIGEST=false`, then delegates to `fireDigestIfStale` whose
 * marker debounce guarantees ≤ 1 digest per project per 7 days regardless
 * of how often the Stop hook fires.
 *
 * Fail-open: any unexpected throw is logged and swallowed so the parent
 * Stop hook (which has already exited by the time this child runs) is never
 * affected.
 */
export async function handleAutoDigest(): Promise<void> {
  const state = await loadHookState()
  if (!state.config || !state.configRoot) return
  const projectName =
    resolveProjectPathFromCwd(process.cwd(), state.configRoot, state.config)?.name ??
    undefined

  try {
    await fireDigestIfStale(process.cwd(), {
      config: state.config,
      configRoot: state.configRoot,
      autoDigest: state.hookConfig.autoDigest && !autoDigestEnvDisabled(),
      backgroundAgent: state.hookConfig.backgroundAgent,
    })
  } catch (err) {
    recordBackgroundFailure(state.configRoot, {
      kind: "digest-scheduler",
      projectName,
      code: "unexpected-failure",
      message: `unexpected failure: ${err instanceof Error ? err.message : String(err)}`,
    })
    process.stderr.write(
      `[lore] digest scheduler: unexpected failure — ${redactDebugError(err)}\n`
    )
  }
}

// ---------------------------------------------------------------------------
// SessionEnd — exit-0 compatibility shim. Lore does not register a
// SessionEnd hook on current installs; this handler exists so any
// stale host-assistant settings invoking the legacy session-end shim
// exit cleanly with no work.
// ---------------------------------------------------------------------------

/**
 * SessionEnd compatibility no-op. Current installs do not register a
 * SessionEnd hook; this handler is intentionally inert so stale Claude
 * Code settings still exit `0` until operators reinstall.
 *
 * Resolves with `undefined`, never reads any environment, never spawns,
 * never logs. A stale invocation must be invisible to the operator.
 * Auto-digest scheduling lives on the Stop lifecycle (`handleAutoDigest`)
 * — a stale SessionEnd invocation here must not double-fire it.
 */
export async function handleSessionEnd(): Promise<void> {
  // Intentionally empty.
}

// ---------------------------------------------------------------------------
// Entry — fail open for autosave so the AI can always stop
// ---------------------------------------------------------------------------

if (isEntryPoint()) {
  main().catch((err) => {
    const action = process.argv[2]
    process.stderr.write(`[lore] Hook error [${action}]: ${redactDebugError(err)}\n`)
    if (action === "autosave") {
      process.stdout.write("{}\n")
      process.exit(0)
    }
    // `session-end` is a stale-compatibility shim that must always exit 0;
    // `auto-digest` runs detached off Stop and any failure is already
    // logged — exiting non-zero would only confuse operators inspecting
    // child process exit codes.
    process.exit(action === "session-end" || action === "auto-digest" ? 0 : 1)
  })
}
