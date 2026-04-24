/**
 * MCP tool helpers.
 */

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

/**
 * Format an unknown error into a standard MCP tool error response.
 */
export function toolError(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err)
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  }
}

/**
 * Render the pagination footer a cursor-aware list tool appends to its text
 * response when more results exist. Absence of the footer signals end-of-list.
 *
 * A fenced ```json block is used (not a bare JSON line) so agents can parse
 * it unambiguously even when list items contain colons, brackets, or other
 * JSON-looking syntax in their titles or bodies.
 */
export function paginationFooter(nextCursor: string | undefined): string {
  if (!nextCursor) return ""
  return `\n\n---\n\n\`\`\`json\n${JSON.stringify({ nextCursor })}\n\`\`\``
}

/**
 * Opt-in operator observability for partial read-path failures. Partial
 * failures surface to the agent via the `Warnings:` footer, which is right
 * for the UX but leaves ops blind: one 429 on wake-up hydration and a
 * pathological corrupted-page situation both show up as an identical silent
 * partial response. When `LORE_DEBUG=1`, this helper emits one stderr line
 * per failing root so an operator running one session can see which shape
 * they're dealing with.
 *
 * Format: `[lore] partial-failure: root=<rootId> error=<message> tool=<toolName>`
 *
 * Only `error.message` is logged — not `error.stack`, `.body`, `.headers`, or
 * the full error object. This narrowing reduces noise and keeps the bulk of
 * Notion SDK error metadata (response bodies, request IDs, status codes) out
 * of stderr; it does **not** fully scrub the message field itself. Some SDK
 * errors — e.g. `InvalidPathParameterError` — interpolate request-scoped
 * detail directly into `.message`, which will still appear here. Treat
 * `LORE_DEBUG=1` as operator-only instrumentation, not a redaction boundary.
 *
 * Interpolated fields (`rootId`, `message`) have ASCII control characters
 * — newlines, carriage returns, tabs, and the 0x00-0x1F / 0x7F range —
 * replaced with spaces before the line is written. Under current callers
 * rootIds are Notion UUIDs and rejection messages are single-line, so this
 * is defensive: it preserves the one-event-per-line invariant that log
 * aggregators rely on when future callers (PF1-01 bounded retries,
 * wake-up parallel queries) stream through the same helper.
 */
export function debugLogPartialFailures(
  toolName: string,
  failures: ReadonlyArray<{ rootId: string; error: unknown }>,
): void {
  if (process.env["LORE_DEBUG"] !== "1") return
  for (const { rootId, error } of failures) {
    const rawMessage = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `[lore] partial-failure: root=${oneLine(rootId)} error=${oneLine(rawMessage)} tool=${toolName}\n`,
    )
  }
}

// eslint-disable-next-line no-control-regex -- coercing to a single log line is the point
const CONTROL_CHARS = /[\x00-\x1F\x7F]/g

function oneLine(value: string): string {
  return value.replace(CONTROL_CHARS, " ")
}
