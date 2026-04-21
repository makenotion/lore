/**
 * Hook helper utilities.
 *
 * These are invoked by the shell hook scripts to interact with Lore.
 * The hooks call `node dist/hooks/helpers.js <action>` with
 * relevant context passed via environment variables.
 *
 * Autosave fires on the Stop hook event:
 *   - Count-based trigger → blocks AI → AI writes structured
 *     content via MCP tools (lore-journal, lore-remember, lore-learn)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs"
import { spawn, execFileSync } from "node:child_process"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { resolve, relative } from "node:path"
import { findConfigFile, loadConfigAllowingInvalidHooks } from "../config.js"
import {
  formatTranscriptSessionContent,
  inspectTranscript,
} from "./transcript.js"
import { initServicesFromConfig } from "../services.js"
import { type LoreConfig } from "../types.js"
import { mergeHookDefaults, type HookConfig } from "./config.js"
import { buildSavePrompt, buildSessionEndPrompt } from "./prompts.js"
import { dateBucket, loadWakeUpData } from "../core/wakeup.js"

const action = process.argv[2]

/** Hook payload fields shared by Claude Code and Codex. */
interface HookEvent {
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
  last_assistant_message?: string
  stop_hook_active?: boolean
}


// ---------------------------------------------------------------------------
// State management — per-session save count in $TMPDIR
// ---------------------------------------------------------------------------

const STATE_DIR = join(tmpdir(), "lore-hook-state")

async function ensureStateDir(): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true })
}

function statePath(sessionId: string): string {
  return join(STATE_DIR, `${sessionId}.count`)
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
  count: number,
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
  projects: Array<{ name: string; path: string }> | undefined,
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
      config.projects,
    )
    return {
      hookConfig: mergeHookDefaults(config.hooks, catchAllName, subProjects),
      config,
      configRoot: found.root,
    }
  } catch (err) {
    process.stderr.write(
      `[lore] Failed to load ${found.path}: ${err instanceof Error ? err.message : err}. Using hook defaults.\n`,
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
// Stop — count-based trigger, blocks AI for structured save
// ---------------------------------------------------------------------------

/**
 * Stop handler: counts real user messages and blocks the AI when the
 * threshold is reached, injecting a prompt that tells the AI to save
 * structured content via Lore's MCP tools.
 *
 * No Notion API calls — just file I/O. Outputs JSON to stdout for
 * the active assistant to interpret.
 */
async function handleStop(event: HookEvent, config: HookConfig): Promise<void> {
  // Loop guard: AI already processed a block reason, let it stop
  if (event.stop_hook_active) {
    process.stdout.write("{}\n")
    return
  }

  if (!event.transcript_path) {
    process.stdout.write("{}\n")
    return
  }

  try {
    const transcriptRaw = await readFile(event.transcript_path, "utf-8")
    const transcript = inspectTranscript(transcriptRaw)
    if (
      transcript.totalNonEmptyLineCount > 0 &&
      transcript.messages.length === 0 &&
      (transcript.malformedLineCount > 0 || transcript.ignoredLineCount > 0)
    ) {
      process.stderr.write(
        "[lore] Stop hook could not read any transcript messages " +
          `(${transcript.malformedLineCount} malformed, ${transcript.ignoredLineCount} ignored).\n`,
      )
    }
    const currentCount = transcript.messages.filter((message) => message.role === "user").length
    const lastSaveCount = await readSaveCount(event.session_id)
    const { saveInterval } = config
    // First save fires sooner to catch short sessions (min 2 messages).
    // Subsequent saves use the full configured interval.
    const isFirstSave = lastSaveCount === 0
    const threshold = isFirstSave ? Math.min(saveInterval, 2) : saveInterval
    const sinceLast = currentCount - lastSaveCount

    if (sinceLast >= threshold) {
      await writeSaveCount(event.session_id, currentCount)
      process.stdout.write(
        JSON.stringify({
          decision: "block",
          reason: buildSavePrompt(config.subProjects, config.catchAllName),
        }) + "\n",
      )
    } else {
      process.stdout.write("{}\n")
    }
  } catch (err) {
    // Fail open: let the AI stop
    process.stderr.write(
      `[lore] Stop hook error: ${err instanceof Error ? err.message : err}\n`,
    )
    process.stdout.write("{}\n")
  }
}

// ---------------------------------------------------------------------------
// Wakeup — load context at session start
// ---------------------------------------------------------------------------

async function wakeup(): Promise<void> {
  // Config opt-out: hooks.wakeUp: false suppresses context injection.
  // Check before service initialization so we avoid the Notion round-trip when disabled.
  const hookState = await loadHookState()
  const { hookConfig } = hookState
  if (!hookConfig.wakeUp) return
  if (!hookState.config || !hookState.configRoot) return

  let services: Awaited<ReturnType<typeof initServicesFromConfig>>
  try {
    services = await initServicesFromConfig(process.cwd(), hookState.configRoot, hookState.config)
  } catch (err) {
    process.stderr.write(
      `[lore] wakeup: init failed — ${err instanceof Error ? err.message : err}. Run \`lore status\` or \`lore migrate\` to diagnose.\n`,
    )
    return
  }
  const project = services.context.project

  let digest, memories, openLoops, knowledgeFacts
  try {
    ;({ digest, memories, openLoops, knowledgeFacts } = await loadWakeUpData(services, {
      projectId: project?.id,
      // Hook rendering only uses title/source/date — skip the N+1 markdown fetch.
      includeMemoryContent: false,
    }))
  } catch (err) {
    // Wake-up is decorative. A transient Notion failure must not block
    // session startup — log and exit clean.
    process.stderr.write(
      `[lore] wakeup: load failed — ${err instanceof Error ? err.message : err}. Skipping context injection.\n`,
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
        sections.push(`- **${mem.title}** (${mem.source}, ${mem.createdAt.split("T")[0]})`)
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
          `- ${fact.subject} \u2192 ${fact.predicate.replace(/_/g, " ")} \u2192 ${fact.object} (${fact.confidence}${since}, review by ${fact.reviewBy})`,
        )
      }
    }

    if (active.length > 0) {
      sections.push("\n## Open Loops")
      for (const fact of active) {
        const since = fact.validFrom ? `, since ${fact.validFrom}` : ""
        const review = fact.reviewBy ? `, review by ${fact.reviewBy}` : ""
        sections.push(
          `- ${fact.subject} \u2192 ${fact.predicate.replace(/_/g, " ")} \u2192 ${fact.object} (${fact.confidence}${since}${review})`,
        )
      }
    }
  }

  if (knowledgeFacts.length > 0) {
    sections.push("\n## Active Facts")
    for (const fact of knowledgeFacts) {
      sections.push(
        `- ${fact.subject} ${fact.predicate.replace(/_/g, " ")} ${fact.object}`,
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

function findClaudeBinary(): string | null {
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

function spawnBackgroundSave(cwd: string, prompt: string): void {
  const claudeBin = findClaudeBinary()
  if (!claudeBin) {
    process.stderr.write("[lore] session-end: claude binary not found, skipping\n")
    return
  }

  // Write prompt to a temp file and pipe via stdin fd to avoid exposing
  // session transcript content in process arguments (visible via `ps`).
  const promptFile = join(tmpdir(), `lore-prompt-${Date.now()}.txt`)
  let stdinFd: number
  try {
    writeFileSync(promptFile, prompt, { mode: 0o600 })
    stdinFd = openSync(promptFile, "r")
    // Unlink immediately — child still reads via its inherited fd copy (Unix)
    unlinkSync(promptFile)
  } catch (err) {
    process.stderr.write(
      `[lore] session-end: failed to prepare prompt file: ${err instanceof Error ? err.message : err}\n`,
    )
    return
  }

  const args = [
    "-p",
    "--allowedTools",
    "mcp__lore__lore-journal,mcp__lore__lore-remember,mcp__lore__lore-learn,mcp__lore__lore-decide",
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

  try {
    const child = spawn(claudeBin, args, {
      cwd,
      detached: true,
      stdio: [stdinFd, "ignore", "ignore"],
      env: safeEnv,
    })
    child.unref()
  } catch (err) {
    process.stderr.write(
      `[lore] session-end: spawn failed: ${err instanceof Error ? err.message : err}\n`,
    )
  } finally {
    closeSync(stdinFd)
  }
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
async function handleSessionEnd(): Promise<void> {
  if (process.env["LORE_AUTOSAVE"] === "false") return

  const raw = process.env["LORE_SESSION_END_CONTENT"]
  if (!raw) return

  const { hookConfig } = await loadHookState()
  if (!hookConfig.autoSave) return

  let event: HookEvent
  try {
    event = JSON.parse(raw) as HookEvent
  } catch (err) {
    process.stderr.write(
      `[lore] session-end: failed to parse event JSON: ${err instanceof Error ? err.message : err}\n`,
    )
    return
  }

  if (!event.transcript_path) return

  let transcriptRaw: string
  try {
    transcriptRaw = await readFile(event.transcript_path, "utf-8")
  } catch (err) {
    process.stderr.write(
      `[lore] session-end: failed to read transcript: ${err instanceof Error ? err.message : err}\n`,
    )
    return
  }

  const transcript = inspectTranscript(transcriptRaw)
  if (
    transcript.totalNonEmptyLineCount > 0 &&
    transcript.messages.length === 0 &&
    (transcript.malformedLineCount > 0 || transcript.ignoredLineCount > 0)
  ) {
    process.stderr.write(
      "[lore] session-end could not read any transcript messages " +
        `(${transcript.malformedLineCount} malformed, ${transcript.ignoredLineCount} ignored).\n`,
    )
  }

  const currentCount = transcript.messages.filter((message) => message.role === "user").length
  if (currentCount < 2) return

  const lastSaveCount = await readSaveCount(event.session_id)
  if (currentCount - lastSaveCount < 1) return

  const sessionContent = formatTranscriptSessionContent(transcript.messages)
  if (!sessionContent) return

  const prompt = buildSessionEndPrompt(hookConfig.subProjects, hookConfig.catchAllName, sessionContent)
  spawnBackgroundSave(event.cwd ?? process.cwd(), prompt)
}

// ---------------------------------------------------------------------------
// Entry — fail open for autosave so the AI can always stop
// ---------------------------------------------------------------------------

main().catch((err) => {
  process.stderr.write(
    `[lore] Hook error [${action}]: ${err instanceof Error ? err.message : err}\n`,
  )
  if (action === "autosave") {
    process.stdout.write("{}\n")
    process.exit(0)
  }
  process.exit(action === "session-end" ? 0 : 1)
})
