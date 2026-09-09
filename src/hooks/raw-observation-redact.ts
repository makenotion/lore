/**
 * Redaction for raw PostToolUse observation payloads.
 *
 * Separate from SDK-error redaction because raw tool payloads carry
 * structured JSON rather than error message strings. Rules are tighter:
 * bearer tokens are replaced, <private> markers suppress whole strings,
 * and a depth cap prevents stack overflow on deeply nested inputs.
 */

/** Max bytes stored per input/output/event field after redaction. */
export const RAW_OBSERVATION_FIELD_CAP_BYTES = 65_536

/**
 * Depth limit for recursive object/array traversal. Nodes beyond this
 * depth are replaced with a sentinel string rather than traversed.
 */
const MAX_DEPTH = 10

/** Patterns for bearer-token-shaped strings that must be redacted. */
const TOKEN_PATTERNS: RegExp[] = [
  /\bdevelopment_ntn_[A-Za-z0-9_-]+/g,
  /\bntn_[A-Za-z0-9_-]+/g,
  /\bsecret_[A-Za-z0-9_-]+/g,
]

const PRIVATE_MARKER_RE = /<\/?private>/i

function redactTokens(value: string): string {
  let result = value
  for (const pattern of TOKEN_PATTERNS) {
    result = result.replace(pattern, "<redacted-token>")
  }
  return result
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "<depth-limit>"

  if (typeof value === "string") {
    if (PRIVATE_MARKER_RE.test(value)) return "<private>"
    return redactTokens(value)
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1))
  }

  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, depth + 1)
    }
    return out
  }

  // Primitive JSON values (number, boolean, null) pass through.
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value
  }

  // Functions, symbols, undefined, etc.
  return "<unsupported>"
}

/**
 * Redact a raw observation field value. Applies token redaction,
 * <private> marker suppression, recursive traversal with depth cap,
 * and a 64 KiB byte cap on the serialized result.
 */
export function redactObservationField(value: unknown): unknown {
  const redacted = redactValue(value, 0)

  // For strings, measure raw bytes (not JSON-serialized bytes) so that the cap
  // is consistent with the field value itself rather than its wire encoding.
  if (typeof redacted === "string") {
    if (Buffer.byteLength(redacted, "utf8") > RAW_OBSERVATION_FIELD_CAP_BYTES) {
      const truncated = Buffer.from(redacted, "utf8")
        .subarray(0, RAW_OBSERVATION_FIELD_CAP_BYTES)
        .toString("utf8")
      return `<truncated:${truncated.length}chars>`
    }
    return redacted
  }

  const serialized = JSON.stringify(redacted)
  if (Buffer.byteLength(serialized, "utf8") <= RAW_OBSERVATION_FIELD_CAP_BYTES) {
    return redacted
  }
  const truncated = Buffer.from(serialized, "utf8")
    .subarray(0, RAW_OBSERVATION_FIELD_CAP_BYTES)
    .toString("utf8")
  return `<truncated:${truncated.length}chars>`
}
