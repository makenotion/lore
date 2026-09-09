/**
 * Local JSONL store for raw PostToolUse observations.
 *
 * Records land in $XDG_STATE_HOME/lore/raw-observations/<key>.jsonl
 * (or ~/.local/state/lore/raw-observations/<key>.jsonl when
 * XDG_STATE_HOME is unset). The store is never written inside the repo.
 * Files use mode 0600; directories use mode 0700.
 */

import { createReadStream } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { configKey, ensureHookStateDir, writeHookStateFile } from "./marker-key.js"

/** Tail window for dedup / recent-record reads. Bounded to avoid OOM on large files. */
export const RAW_OBSERVATION_TAIL_LINES = 500

export interface RawObservationRecord {
  v: 1
  observedAt: string
  sessionId: string | null
  cwd: string | null
  toolName: string
  contentHash: string
  input: unknown
  output: unknown
  event: unknown
}

/**
 * Resolve the base directory for raw-observation JSONL files.
 * Override with LORE_RAW_OBSERVATION_DIR for tests or unusual deployments.
 */
export function rawObservationDir(envSource: NodeJS.ProcessEnv = process.env): string {
  const override = envSource["LORE_RAW_OBSERVATION_DIR"]
  if (override && override.trim().length > 0) return override.trim()

  const xdg = envSource["XDG_STATE_HOME"]
  const base =
    xdg && xdg.trim().length > 0 ? xdg.trim() : join(homedir(), ".local", "state")
  return join(base, "lore", "raw-observations")
}

/**
 * Full path to the JSONL file for a given config root.
 */
export function rawObservationPath(
  configRoot: string,
  envSource: NodeJS.ProcessEnv = process.env
): string {
  return join(rawObservationDir(envSource), `${configKey(configRoot)}.jsonl`)
}

/**
 * Append one record as a JSON line. Creates directories and file with
 * owner-only permissions.
 */
export async function appendObservation(
  filePath: string,
  record: RawObservationRecord
): Promise<void> {
  const dir = join(filePath, "..")
  await ensureHookStateDir(dir)
  const line = JSON.stringify(record) + "\n"
  await writeHookStateFile(filePath, line, { flag: "a", encoding: "utf8" })
}

/**
 * Read the tail of the JSONL file and return parsed records. Parses
 * only the last RAW_OBSERVATION_TAIL_LINES lines to bound memory use.
 * Returns [] when the file does not exist or cannot be read.
 */
export async function readRecentObservations(
  filePath: string,
  opts: { sessionId?: string; windowMs?: number } = {}
): Promise<RawObservationRecord[]> {
  const lines = await readTailLines(filePath, RAW_OBSERVATION_TAIL_LINES)
  const now = Date.now()

  const records: RawObservationRecord[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRawObservationRecord(record)) continue
    if (opts.sessionId !== undefined && record.sessionId !== opts.sessionId) continue
    if (opts.windowMs !== undefined) {
      const observedMs = new Date(record.observedAt).getTime()
      if (Number.isNaN(observedMs) || now - observedMs > opts.windowMs) continue
    }
    records.push(record)
  }
  return records
}

function isRawObservationRecord(value: unknown): value is RawObservationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  return (
    r["v"] === 1 &&
    typeof r["observedAt"] === "string" &&
    typeof r["toolName"] === "string" &&
    typeof r["contentHash"] === "string"
  )
}

async function readTailLines(filePath: string, maxLines: number): Promise<string[]> {
  return new Promise((resolve) => {
    const lines: string[] = []
    let stream: ReturnType<typeof createReadStream>
    try {
      stream = createReadStream(filePath, { encoding: "utf8" })
    } catch {
      resolve([])
      return
    }
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    rl.on("line", (line) => {
      lines.push(line)
      if (lines.length > maxLines) lines.shift()
    })
    rl.on("close", () => resolve(lines))
    rl.on("error", () => resolve(lines))
    stream.on("error", () => {
      rl.close()
      resolve(lines)
    })
  })
}
