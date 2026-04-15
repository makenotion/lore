/**
 * Hook helper utilities.
 *
 * These are invoked by the shell hook scripts to interact with Lore.
 * The hooks call `node dist/hooks/helpers.js <action>` with
 * relevant context passed via environment variables.
 *
 * Autosave fires on two Claude Code hook events:
 *   - Stop:        count-based trigger → blocks AI → AI writes structured
 *                  content via MCP tools (lore-journal, lore-remember, lore-learn)
 *   - PreCompact:  passive transcript save (safety net before compaction)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findConfigFile, loadConfig } from "../config.js"
import { initServices } from "../services.js"

const action = process.argv[2]

/** JSON payload Claude Code delivers on stdin for hook events. */
interface HookEvent {
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
  last_assistant_message?: string
  stop_hook_active?: boolean
}

const DEFAULT_SAVE_INTERVAL = 5

const SAVE_PROMPT = `[Lore auto-save] Before stopping, save your work context for the team.

Use these Lore tools to persist what matters from this session:

• lore-journal — Write a brief summary of what was accomplished and key decisions made.
• lore-remember — Save specific discoveries, context, or decisions that would help future sessions. Use descriptive titles and tags.
• lore-learn — Record entity relationships discovered (e.g., "AuthService uses JWT").

Focus on decisions and discoveries, not play-by-play. Be concise. Then stop.`

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
// Transcript parsing
// ---------------------------------------------------------------------------

/**
 * Count real user messages in a Claude Code JSONL transcript.
 *
 * Filters out empty entries and system-reminder-only entries so the count
 * reflects actual developer interaction, not inflated hook traffic.
 */
function countUserMessages(transcriptRaw: string): number {
  let count = 0
  for (const line of transcriptRaw.split("\n")) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry.type !== "user") continue

      const content = entry.message?.content
      if (!content) continue

      let text: string
      if (Array.isArray(content)) {
        text = content
          .filter((p: Record<string, unknown>) => p.type === "text")
          .map((p: Record<string, unknown>) => (p.text as string) ?? "")
          .join("")
      } else if (typeof content === "string") {
        text = content
      } else {
        continue
      }

      // Strip system reminders — what remains is real user input
      text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim()
      if (text.length > 0) count++
    } catch {
      continue
    }
  }
  return count
}

/**
 * Read the tail of a transcript file for passive saves.
 */
async function readTranscriptTail(
  path: string | undefined,
  maxChars: number,
): Promise<string | undefined> {
  if (!path) return undefined
  try {
    const raw = await readFile(path, "utf-8")
    if (raw.length <= maxChars) return raw
    return `…${raw.slice(-maxChars)}`
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

async function loadSaveInterval(): Promise<number> {
  try {
    const found = await findConfigFile(process.cwd())
    if (!found) return DEFAULT_SAVE_INTERVAL
    const config = await loadConfig(found.path)
    return config.hooks?.saveInterval ?? DEFAULT_SAVE_INTERVAL
  } catch {
    return DEFAULT_SAVE_INTERVAL
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
    default:
      process.stderr.write(`Unknown hook action: ${action}\n`)
      process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Autosave — event router
// ---------------------------------------------------------------------------

async function autosave(): Promise<void> {
  const raw = process.env["LORE_AUTOSAVE_CONTENT"]
  if (!raw) {
    process.stderr.write("LORE_AUTOSAVE_CONTENT not set, skipping.\n")
    return
  }

  let event: HookEvent = {}
  try {
    event = JSON.parse(raw)
  } catch {
    event = { last_assistant_message: raw }
  }

  switch (event.hook_event_name) {
    case "Stop":
      await handleStop(event)
      break
    case "PreCompact":
      await handlePassiveSave(event)
      break
    default:
      await handlePassiveSave(event)
  }
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
 * Claude Code to interpret.
 */
async function handleStop(event: HookEvent): Promise<void> {
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
    const currentCount = countUserMessages(transcriptRaw)
    const lastSaveCount = await readSaveCount(event.session_id)
    const saveInterval = await loadSaveInterval()
    // First save fires sooner to catch short sessions (min 2 messages).
    // Subsequent saves use the full configured interval.
    const isFirstSave = lastSaveCount === 0
    const threshold = isFirstSave ? Math.min(saveInterval, 2) : saveInterval
    const sinceLast = currentCount - lastSaveCount

    if (sinceLast >= threshold) {
      await writeSaveCount(event.session_id, currentCount)
      process.stdout.write(
        JSON.stringify({ decision: "block", reason: SAVE_PROMPT }) + "\n",
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
// Passive save — safety-net transcript dump for PreCompact
// ---------------------------------------------------------------------------

async function handlePassiveSave(event: HookEvent): Promise<void> {
  const now = new Date()
  const dateStr = now.toISOString().split("T")[0]
  const timeStr = now.toTimeString().slice(0, 5)
  const agent = process.env["LORE_AGENT_NAME"] ?? "Claude Code"
  const eventName = event.hook_event_name ?? "unknown"

  const label =
    eventName === "PreCompact"
      ? "Context snapshot"
      : "Session notes"

  const content =
    (await readTranscriptTail(event.transcript_path, 4000)) ??
    `${label} at ${now.toISOString()}`

  const tag =
    eventName === "PreCompact"
      ? "compact"
      : "auto-save"

  try {
    const services = await initServices()
    await services.memories.create({
      title: `${label} — ${dateStr} ${timeStr}`,
      content,
      projectId: services.context.project?.id,
      source: "agent_diary",
      agent,
      session: event.session_id,
      tags: ["auto-save", tag],
    })
    process.stderr.write(`[lore] Auto-saved: "${label} — ${dateStr} ${timeStr}"\n`)
  } catch (err) {
    process.stderr.write(
      `[lore] Passive save error: ${err instanceof Error ? err.message : err}\n`,
    )
  }
}

// ---------------------------------------------------------------------------
// Wakeup — load context at session start
// ---------------------------------------------------------------------------

async function wakeup(): Promise<void> {
  let services: Awaited<ReturnType<typeof initServices>>
  try {
    services = await initServices()
  } catch {
    // Missing config or auth is normal (not every project has Lore).
    // Exit silently rather than producing a hook error.
    return
  }
  const project = services.context.project

  const memories = await services.memories.list({
    projectId: project?.id,
    limit: 5,
  })

  const facts = project
    ? await services.facts.queryBySubject("", { projectId: project.id })
    : []

  const sections: string[] = []

  if (project) {
    sections.push(`Project: ${project.name} (${project.path || "root"})`)
  }

  if (memories.length > 0) {
    sections.push("\n## Recent Memories")
    for (const mem of memories) {
      sections.push(`- **${mem.title}** (${mem.source}, ${mem.updatedAt.split("T")[0]})`)
    }
  }

  if (facts.length > 0) {
    sections.push("\n## Active Facts")
    for (const fact of facts) {
      sections.push(
        `- ${fact.subject} ${fact.predicate.replace(/_/g, " ")} ${fact.object}`,
      )
    }
  }

  if (sections.length > 0) {
    console.log(sections.join("\n"))
  }
}

// ---------------------------------------------------------------------------
// Entry — fail open for autosave so the AI can always stop
// ---------------------------------------------------------------------------

main().catch((err) => {
  process.stderr.write(
    `[lore] Hook error: ${err instanceof Error ? err.message : err}\n`,
  )
  if (action === "autosave") {
    process.stdout.write("{}\n")
    process.exit(0)
  }
  process.exit(1)
})
