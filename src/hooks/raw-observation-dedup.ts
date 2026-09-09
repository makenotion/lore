/**
 * 5-minute deduplication for raw PostToolUse observations.
 *
 * Computes a content hash over the redacted tool name, input, and output,
 * then checks a bounded tail of the JSONL store for the same hash within
 * the dedup window before allowing an append.
 */

import { createHash } from "node:crypto"
import {
  readRecentObservations,
  RAW_OBSERVATION_TAIL_LINES,
} from "./raw-observation-store.js"

/** Dedup window in milliseconds. */
export const DEDUP_WINDOW_MS = 5 * 60 * 1_000

/**
 * Compute a stable SHA-256 hash over the canonical form of (toolName,
 * redactedInput, redactedOutput). The JSON serialization uses sorted keys
 * so object property order cannot produce two different hashes for the same
 * logical value.
 */
export function computeContentHash(
  toolName: string,
  redactedInput: unknown,
  redactedOutput: unknown
): string {
  const payload = stableStringify({
    toolName,
    input: redactedInput,
    output: redactedOutput,
  })
  return createHash("sha256").update(payload).digest("hex")
}

/**
 * Return true if the JSONL file already contains a record with the same
 * contentHash observed within the last DEDUP_WINDOW_MS milliseconds.
 * Reads at most RAW_OBSERVATION_TAIL_LINES lines (bounded scan).
 */
export async function isDuplicate(
  jsonlPath: string,
  contentHash: string,
  windowMs: number = DEDUP_WINDOW_MS
): Promise<boolean> {
  const recent = await readRecentObservations(jsonlPath, { windowMs })
  return recent.some((r) => r.contentHash === contentHash)
}

/** Deterministic JSON serialization with sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return JSON.stringify(value)
  }
  const sorted = Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = (value as Record<string, unknown>)[k]
      return acc
    }, {})
  return JSON.stringify(sorted, (_key, val: unknown) => {
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      return Object.keys(val as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (val as Record<string, unknown>)[k]
          return acc
        }, {})
    }
    return val
  })
}

// Re-export so tests can pin the tail window constant without a separate import.
export { RAW_OBSERVATION_TAIL_LINES }
