/**
 * Hook helper utilities.
 *
 * These are invoked by the shell hook scripts to interact with Lore.
 * The hooks call `node dist/hooks/helpers.js <action>` with
 * relevant context passed via environment variables.
 *
 * Autosave flow:
 *   - Stop hook (mid-session): count-based trigger → spawns a detached
 *     `claude -p` sub-agent in the background that writes structured content
 *     via lore-* MCP tools. The main agent is never blocked.
 *   - SessionEnd hook: same spawn machinery for one last save after the
 *     session window closes.
 *
 * A per-session lock (see `lock.ts`) ensures at most one background save is
 * in flight per session, and a global cap bounds total concurrent spawns.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { findConfigFile, loadConfigAllowingInvalidHooks } from "../config.js"
import {
  formatTranscriptSessionContent,
  inspectTranscript,
  type TranscriptInspection,
} from "./transcript.js"
import { initServicesFromConfig } from "../services.js"
import { type LoreConfig } from "../types.js"
import { mergeHookDefaults, type HookConfig } from "./config.js"
import { buildSessionEndPrompt } from "./prompts.js"
import {
  RANKED_WAKEUP_LIMITS,
  WAKEUP_OPEN_LOOPS_TRUNCATED_HINT,
  dateBucket,
  loadWakeUpData,
} from "../core/wakeup.js"
import { spawnBackgroundSave } from "./background.js"
import { fireDigestIfStale } from "./digest-scheduler.js"
import { getStateDir } from "./lock.js"
import { canonicalizeAgentName } from "./agent-identity.js"

/** Hook payload fields shared by Claude Code and Codex. */
interface HookEvent {
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
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
 * should inject `LORE_AGENT_NAME=Codex` into `.codex/hooks.json`'s env so
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

// ---------------------------------------------------------------------------
// State management — per-session save count in $TMPDIR
// ---------------------------------------------------------------------------

async function ensureStateDir(): Promise<void> {
  await mkdir(getStateDir(), { recursive: true })
}

function statePath(sessionId: string): string {
  return join(getStateDir(), `${sessionId}.count`)
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
  await writeFile(statePath(sessionId), count.toString())
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Lightweight project context resolution from .lore.yaml — no Notion API
 * calls. Mirrors `resolveProject`'s longest-prefix logic from
 * `core/context.ts` and additionally surfaces the sub-project list and
 * catch-all name so the save prompts can enumerate alternatives.
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
      hookConfig: mergeHookDefaults(config.hooks, catchAllName, subProjects),
      config,
      configRoot: found.root,
    }
  } catch (err) {
    process.stderr.write(
      `[lore] Failed to load ${found.path}: ${err instanceof Error ? err.message : err}. Using hook defaults.\n`
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
      await autosave()
      break
    case "wakeup":
      await wakeup()
      break
    case "session-end":
      await handleSessionEnd()
      break
    default:
      process.stderr.write(`Unknown hook action: ${action}\n`)
      process.exit(1)
  }
}

/**
 * True when this module is the Node entry point (invoked via `node
 * dist/hooks/helpers.js`). False when imported from another module — tests
 * import this file directly and must not trigger `main()`'s process.exit
 * paths or argv routing.
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

async function autosave(): Promise<void> {
  // Env var opt-out: LORE_AUTOSAVE=false disables for this session
  if (process.env["LORE_AUTOSAVE"] === "false") {
    process.stdout.write("{}\n")
    return
  }

  const raw = process.env["LORE_AUTOSAVE_CONTENT"]
  if (!raw) {
    process.stderr.write("LORE_AUTOSAVE_CONTENT not set, skipping.\n")
    return
  }

  // Config opt-out: hooks.autoSave: false in .lore.yaml
  const { hookConfig } = await loadHookState()
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

  await handleStop(event, hookConfig)
}

// ---------------------------------------------------------------------------
// Stop — count-based trigger, spawns background save (non-blocking)
// ---------------------------------------------------------------------------

interface TranscriptForSave {
  transcript: TranscriptInspection
  userMessageCount: number
}

/**
 * Read and inspect the transcript for an autosave event. Used by both the
 * mid-session Stop path and the SessionEnd path — they want the same parsing
 * and the same malformed-line diagnostics. Returns null when the event has no
 * transcript path or the file can't be read; callers should treat that as
 * "skip this save".
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
      `[lore] ${label}: failed to read transcript: ${err instanceof Error ? err.message : err}\n`
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
 * can't race on the same transcript.
 */
export async function handleStop(event: HookEvent, config: HookConfig): Promise<void> {
  try {
    const read = await readTranscriptForSave(event, "Stop hook")
    if (!read) {
      process.stdout.write("{}\n")
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
        const prompt = buildSessionEndPrompt(
          config.subProjects,
          config.catchAllName,
          sessionContent,
          event.session_id,
          deriveAgentName(event)
        )
        // Only advance the save counter when a background process actually
        // started. Every non-`spawned` result — benign races (lock-held,
        // cap-hit, race-lost) and genuine failures (binary-missing,
        // tempfile-failed, spawn-error) alike — must leave the counter
        // where it is. For benign races, the peer's spawn will produce a
        // memory and the next Stop catches up against the new count. For
        // genuine failures, leaving the counter unchanged lets the next
        // Stop or the SessionEnd recovery path retry. (See PR #66.)
        const result = spawnBackgroundSave(
          event.cwd ?? process.cwd(),
          prompt,
          event.session_id
        )
        if (result.kind === "spawned") {
          await writeSaveCount(event.session_id, currentCount)
        }
      }
    }
    process.stdout.write("{}\n")
  } catch (err) {
    // Fail open: let the AI stop
    process.stderr.write(
      `[lore] Stop hook error: ${err instanceof Error ? err.message : err}\n`
    )
    process.stdout.write("{}\n")
  }
}

// ---------------------------------------------------------------------------
// Wakeup — load context at session start (Codex) or first user prompt
// (Claude Code, P3-05)
// ---------------------------------------------------------------------------
//
// Claude Code registration sets `runOnce: true` on the `UserPromptSubmit`
// hook (see `mergeClaudeHookEntries` in `cli/commands/install.ts`). Without
// that flag wake-up would fire on every user message — re-querying Notion
// for the same digest, recents, and (now) task-memory ranking on every
// turn. The current per-session-once contract is what keeps this hook
// affordable on the hot path; if Claude Code's hook engine ever drops
// `runOnce` semantics, wake-up needs a per-session debounce inside the
// helper before that lands.

/**
 * Parse the JSON payload Claude Code's `UserPromptSubmit` hook delivers
 * on stdin (forwarded by `wakeup.sh` via `LORE_WAKEUP_EVENT`). Returns
 * the user's prompt text when present, `undefined` otherwise. The
 * `undefined` return is the fallback signal — wake-up degrades to the
 * pre-P3-05 unranked output without needing a user query.
 *
 * Several callers produce `undefined` and they all drop into the same
 * fallback path:
 * - Env var unset (Codex `SessionStart`; resumed Claude Code sessions
 *   that fire `SessionStart` rather than `UserPromptSubmit`; legacy
 *   `wakeup.sh` that didn't forward stdin).
 * - Env var set but not JSON (a misconfigured hook script).
 * - Env var set with valid JSON but no `prompt` field, or a non-string
 *   `prompt` (a future Claude Code event shape we haven't seen yet —
 *   the field name has been stable since the hooks API shipped, but
 *   pinning here means a rename degrades silently rather than crashes).
 * - Prompt parses cleanly but is a slash command (`/clear`,
 *   `/compact`, etc.). These would seed the relevance ranker with
 *   meta-commands rather than task language — useless as search input,
 *   so we treat them as "no user query" and let the fallback path run.
 *
 * They're not distinguished because callers can't act on the difference
 * — the only useful signal is "did we get a usable prompt or not."
 *
 * The Claude Code hook payload schema (incl. the `prompt` field on
 * `UserPromptSubmit`) is documented at
 * https://docs.claude.com/en/docs/claude-code/hooks#userpromptsubmit;
 * if the field name changes, this parser is the one place that needs
 * updating.
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

async function wakeup(): Promise<void> {
  // Config opt-out: hooks.wakeUp: false suppresses context injection.
  // Check before service initialization so we avoid the Notion round-trip when disabled.
  const hookState = await loadHookState()
  const { hookConfig } = hookState
  if (!hookConfig.wakeUp) return
  if (!hookState.config || !hookState.configRoot) return

  let services: Awaited<ReturnType<typeof initServicesFromConfig>>
  try {
    services = await initServicesFromConfig(
      process.cwd(),
      hookState.configRoot,
      hookState.config
    )
  } catch (err) {
    process.stderr.write(
      `[lore] wakeup: init failed — ${err instanceof Error ? err.message : err}. Run \`lore status\` or \`lore migrate\` to diagnose.\n`
    )
    return
  }
  const project = services.context.project

  // P3-05: when the host assistant is Claude Code on `UserPromptSubmit`,
  // `wakeup.sh` forwards the event JSON via `LORE_WAKEUP_EVENT` so we can
  // seed a relevance search from the user's actual question instead of
  // dumping generic recents. Codex `SessionStart` and any other caller
  // that has no prompt yet leaves the env var unset; we fall through to
  // the data-layer defaults.
  const userQuery = parseUserQueryFromEvent(process.env["LORE_WAKEUP_EVENT"])
  const debug = process.env["LORE_DEBUG"] === "1"
  if (debug) {
    // Operator-facing log: report whether ranked output fired and which
    // caps applied. Useful when triaging "why did wake-up surface iOS
    // notes when I asked about backend auth?" — distinguishes the
    // fallback path (no query reached the helper) from a ranked path
    // that simply produced surprising hits, which in turn directs
    // operators to the right next step (fix the wakeup.sh forwarding
    // vs. inspect the relevance index).
    // Format mirrors `[lore] partial-failure: key=value key=value` so a
    // single grep against `[lore] ` parses uniformly across operator logs.
    if (userQuery) {
      process.stderr.write(
        `[lore] wakeup: ranked=true queryLen=${userQuery.length} memory=${RANKED_WAKEUP_LIMITS.memoryLimit} related=${RANKED_WAKEUP_LIMITS.relatedMemoryLimit} openLoops=${RANKED_WAKEUP_LIMITS.openLoopLimit} knowledge=${RANKED_WAKEUP_LIMITS.knowledgeFactLimit} taskMemories=${RANKED_WAKEUP_LIMITS.taskMemoryLimit}\n`,
      )
    } else {
      process.stderr.write(
        "[lore] wakeup: ranked=false reason=no-user-query\n",
      )
    }
  }
  const rankedLimits = userQuery ? RANKED_WAKEUP_LIMITS : {}

  let digest,
    memories,
    openLoops,
    openLoopsHasMore,
    knowledgeFacts,
    relatedMemories,
    taskMemories
  try {
    ;({
      digest,
      memories,
      openLoops,
      openLoopsHasMore,
      knowledgeFacts,
      relatedMemories,
      taskMemories,
    } = await loadWakeUpData(services, {
      projectId: project?.id,
      // Hook rendering only uses title/source/date — skip the N+1 markdown fetch.
      includeMemoryContent: false,
      // Hook never renders decisions — skip the two Notion queries so
      // session-start latency doesn't regress on the hot path.
      includeDecisions: false,
      userQuery,
      ...rankedLimits,
    }))
  } catch (err) {
    // Wake-up is decorative. A transient Notion failure must not block
    // session startup — log and exit clean.
    process.stderr.write(
      `[lore] wakeup: load failed — ${err instanceof Error ? err.message : err}. Skipping context injection.\n`
    )
    return
  }

  const sections: string[] = []

  if (project) {
    sections.push(`Project: ${project.name} (${project.path || "root"})`)
  }

  if (digest) {
    sections.push(`\n## Latest Digest — ${digest.createdAt.split("T")[0]}`)
    sections.push(`**${digest.title}**`)
    if (digest.content) {
      sections.push("", digest.content.trim())
    }
  }

  // P3-05: relevance hits seeded by the user's first message. Surfaced
  // directly under the digest because it's the densest single signal
  // about what the user is actually asking about — denser than
  // timestamp-ordered recents or open-loop seeds. Section is omitted
  // entirely when no userQuery was available so the output stays
  // identical to the pre-P3-05 shape on the fallback path.
  if (taskMemories && taskMemories.length > 0) {
    sections.push("\n## For Your Current Task")
    for (const mem of taskMemories) {
      sections.push(`- **${mem.title}** (${mem.source}, ${mem.createdAt.split("T")[0]})`)
    }
  }

  if (memories.length > 0) {
    sections.push(digest ? "\n## Recent Memories (since digest)" : "\n## Recent Memories")
    // Group by date bucket
    const buckets = new Map<string, typeof memories>()
    for (const mem of memories) {
      const bucket = dateBucket(mem.createdAt)
      if (!buckets.has(bucket)) buckets.set(bucket, [])
      buckets.get(bucket)!.push(mem)
    }
    for (const label of ["Today", "Yesterday", "Earlier"] as const) {
      const mems = buckets.get(label)
      if (!mems) continue
      sections.push(`### ${label}`)
      for (const mem of mems) {
        sections.push(
          `- **${mem.title}** (${mem.source}, ${mem.createdAt.split("T")[0]})`
        )
      }
    }
  }

  if (openLoops.length > 0) {
    const today = new Date().toISOString().split("T")[0]
    const overdue = openLoops.filter((f) => f.reviewBy && f.reviewBy <= today)
    const active = openLoops.filter((f) => !f.reviewBy || f.reviewBy > today)

    if (overdue.length > 0) {
      sections.push("\n## Overdue")
      for (const fact of overdue) {
        const since = fact.validFrom ? `, since ${fact.validFrom}` : ""
        sections.push(
          `- ${fact.subject} → ${fact.predicate.replace(/_/g, " ")} → ${fact.object} (${fact.confidence}${since}, review by ${fact.reviewBy})`
        )
      }
    }

    if (active.length > 0) {
      sections.push("\n## Open Loops")
      for (const fact of active) {
        const since = fact.validFrom ? `, since ${fact.validFrom}` : ""
        const review = fact.reviewBy ? `, review by ${fact.reviewBy}` : ""
        sections.push(
          `- ${fact.subject} → ${fact.predicate.replace(/_/g, " ")} → ${fact.object} (${fact.confidence}${since}${review})`
        )
      }
    }

    // The tracking-partition fetch capped at `openLoopLimit`. Surface the
    // truncation so the agent knows the displayed slice is biased toward
    // most-overdue (urgency-ranked under the cap) rather than exhaustive,
    // and points at the surface that paginates to exhaustion.
    if (openLoopsHasMore) {
      sections.push(WAKEUP_OPEN_LOOPS_TRUNCATED_HINT)
    }
  }

  if (relatedMemories.length > 0) {
    sections.push("\n## Related to Open Loops")
    for (const mem of relatedMemories) {
      sections.push(`- **${mem.title}** (${mem.source}, ${mem.updatedAt.split("T")[0]})`)
    }
  }

  if (knowledgeFacts.length > 0) {
    sections.push("\n## Active Facts")
    for (const fact of knowledgeFacts) {
      sections.push(
        `- ${fact.subject} ${fact.predicate.replace(/_/g, " ")} ${fact.object}`
      )
    }
  }

  if (sections.length > 0) {
    sections.unshift("# Lore Context")
    console.log(sections.join("\n"))
  }
}

// ---------------------------------------------------------------------------
// SessionEnd — background claude -p for structured saves
// ---------------------------------------------------------------------------

/**
 * True when `LORE_AUTO_DIGEST=false` is set. Env overrides `.lore.yaml` —
 * consistent with how `LORE_AUTOSAVE=false` overrides `hooks.autoSave`.
 */
function autoDigestEnvDisabled(): boolean {
  return process.env["LORE_AUTO_DIGEST"] === "false"
}

/**
 * SessionEnd handler: spawns a background `claude -p` process to do
 * structured saves when the Stop hook didn't fire or left unsaved messages.
 *
 * The background process inherits MCP config from the project's settings.json
 * and uses lore-* tools for journal, memory, and fact saves.
 *
 * Completely non-blocking — never prevents session exit.
 */
export async function handleSessionEnd(): Promise<void> {
  if (process.env["LORE_AUTOSAVE"] === "false") return

  const raw = process.env["LORE_SESSION_END_CONTENT"]
  if (!raw) return

  const state = await loadHookState()
  if (!state.hookConfig.autoSave) return

  let event: HookEvent
  try {
    event = JSON.parse(raw) as HookEvent
  } catch (err) {
    process.stderr.write(
      `[lore] session-end: failed to parse event JSON: ${err instanceof Error ? err.message : err}\n`
    )
    return
  }

  const read = await readTranscriptForSave(event, "session-end")
  if (read && read.userMessageCount >= 2) {
    const lastSaveCount = await readSaveCount(event.session_id)
    if (read.userMessageCount - lastSaveCount >= 1) {
      const sessionContent = formatTranscriptSessionContent(read.transcript.messages)
      if (sessionContent) {
        const prompt = buildSessionEndPrompt(
          state.hookConfig.subProjects,
          state.hookConfig.catchAllName,
          sessionContent,
          event.session_id,
          deriveAgentName(event)
        )
        // SessionEnd has no save counter to advance and no marker to roll
        // back, so the SpawnResult is intentionally discarded. The helper's
        // own per-session stderr log is the only postmortem on this path.
        void spawnBackgroundSave(event.cwd ?? process.cwd(), prompt, event.session_id)
      }
    }
  }

  // Digest scheduling is independent of the save spawn — a quiet session
  // with no new user messages shouldn't block a stale project's digest.
  // Any failure here is swallowed: the scheduler's internal branches log +
  // return one of the `SchedulerOutcome` values, and this outer guard
  // catches unexpected throws (e.g. tmp-dir write failures) so session
  // exit stays clean.
  if (state.config && state.configRoot) {
    try {
      await fireDigestIfStale(event.cwd ?? process.cwd(), {
        config: state.config,
        configRoot: state.configRoot,
        autoDigest: state.hookConfig.autoDigest && !autoDigestEnvDisabled(),
      })
    } catch (err) {
      process.stderr.write(
        `[lore] digest scheduler: unexpected failure — ${err instanceof Error ? err.message : err}\n`
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Entry — fail open for autosave so the AI can always stop
// ---------------------------------------------------------------------------

if (isEntryPoint()) {
  main().catch((err) => {
    const action = process.argv[2]
    process.stderr.write(
      `[lore] Hook error [${action}]: ${err instanceof Error ? err.message : err}\n`
    )
    if (action === "autosave") {
      process.stdout.write("{}\n")
      process.exit(0)
    }
    process.exit(action === "session-end" ? 0 : 1)
  })
}
