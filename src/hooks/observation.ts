/**
 * PostToolUse raw-observation capture handler.
 *
 * Invoked by `lore hooks observation`. Reads the hook event from stdin,
 * redacts sensitive content, deduplicates within a 5-minute window, and
 * appends one JSONL record to the local raw-observation store.
 *
 * Must fail open: malformed input, storage errors, and disabled config all
 * result in exit 0 with at most one redacted diagnostic line on stderr.
 * Must not initialize Notion services — local capture only.
 */

import { findConfigFile, loadConfigAllowingInvalidHooks } from "../config.js"
import { redactDebugError } from "../debug-redact.js"
import { mergeHookDefaults } from "./config.js"
import { redactObservationField } from "./raw-observation-redact.js"
import {
  appendObservation,
  rawObservationPath,
  type RawObservationRecord,
} from "./raw-observation-store.js"
import { computeContentHash, isDuplicate } from "./raw-observation-dedup.js"

/**
 * Best-effort tool-name extraction from a PostToolUse event payload.
 * Falls back through several known field shapes before returning "unknown".
 */
function extractToolName(event: unknown): string {
  if (!event || typeof event !== "object" || Array.isArray(event)) return "unknown"
  const e = event as Record<string, unknown>

  if (typeof e["tool_name"] === "string" && e["tool_name"]) return e["tool_name"]
  if (typeof e["toolName"] === "string" && e["toolName"]) return e["toolName"]

  const tool = e["tool"]
  if (tool && typeof tool === "object" && !Array.isArray(tool)) {
    const t = tool as Record<string, unknown>
    if (typeof t["name"] === "string" && t["name"]) return t["name"]
  }

  const payload = e["payload"]
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const p = payload as Record<string, unknown>
    if (typeof p["tool_name"] === "string" && p["tool_name"]) return p["tool_name"]
    if (typeof p["toolName"] === "string" && p["toolName"]) return p["toolName"]
  }

  return "unknown"
}

function extractInput(event: unknown): unknown {
  if (!event || typeof event !== "object" || Array.isArray(event)) return undefined
  const e = event as Record<string, unknown>
  for (const key of ["tool_input", "toolInput", "input"]) {
    if (key in e) return e[key]
  }
  const payload = e["payload"]
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const p = payload as Record<string, unknown>
    if ("input" in p) return p["input"]
  }
  return undefined
}

function extractOutput(event: unknown): unknown {
  if (!event || typeof event !== "object" || Array.isArray(event)) return undefined
  const e = event as Record<string, unknown>
  for (const key of ["tool_response", "toolResponse", "output", "result"]) {
    if (key in e) return e[key]
  }
  const payload = e["payload"]
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const p = payload as Record<string, unknown>
    if ("output" in p) return p["output"]
  }
  return undefined
}

function extractSessionId(event: unknown): string | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null
  const e = event as Record<string, unknown>
  const v = e["session_id"] ?? e["sessionId"]
  return typeof v === "string" && v.length > 0 ? v : null
}

function extractCwd(event: unknown): string | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null
  const e = event as Record<string, unknown>
  const v = e["cwd"]
  return typeof v === "string" && v.length > 0 ? v : null
}

/**
 * Handle a raw observation event from PostToolUse. Two callers:
 *   - `lore hooks observation`: reads stdin in the CLI subcommand and
 *     passes it through `opts.event`.
 *   - Legacy / direct invocation: `opts.event` will be an empty string
 *     which exits 0 immediately (no-op, fail open).
 */
export async function handleObservation(opts: {
  event: string
  envSource?: Record<string, string | undefined>
}): Promise<void> {
  const envSource = opts.envSource ?? process.env

  try {
    const raw = opts.event.trim()
    if (!raw) return

    let parsedEvent: unknown
    try {
      parsedEvent = JSON.parse(raw)
    } catch {
      process.stderr.write("[lore] observation: malformed JSON payload, skipping.\n")
      return
    }

    const found = await findConfigFile(process.cwd())
    if (!found) return

    const { config } = await loadConfigAllowingInvalidHooks(found.path)
    const hookConfig = mergeHookDefaults(config.hooks, null, [], envSource)

    if (!hookConfig.rawObservationCapture) return

    const toolName = extractToolName(parsedEvent)
    const rawInput = extractInput(parsedEvent)
    const rawOutput = extractOutput(parsedEvent)

    const redactedInput = redactObservationField(rawInput)
    const redactedOutput = redactObservationField(rawOutput)
    const redactedEvent = redactObservationField(parsedEvent)

    const contentHash = computeContentHash(toolName, redactedInput, redactedOutput)
    const storePath = rawObservationPath(found.root, envSource)

    const duplicate = await isDuplicate(storePath, contentHash)
    if (duplicate) return

    const record: RawObservationRecord = {
      v: 1,
      observedAt: new Date().toISOString(),
      sessionId: extractSessionId(parsedEvent),
      cwd: extractCwd(parsedEvent),
      toolName,
      contentHash,
      input: redactedInput,
      output: redactedOutput,
      event: redactedEvent,
    }

    await appendObservation(storePath, record)
  } catch (err) {
    process.stderr.write(`[lore] observation: ${redactDebugError(err)}\n`)
  }
}
