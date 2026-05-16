import { redactDebugError } from "../debug-redact.js"

/**
 * Opt-in operator observability for recoverable partial failures. Partial
 * failures surface to the agent via warnings or command output, which is right
 * for UX but leaves ops blind: one 429 on fan-out hydration and a pathological
 * corrupted-page situation can otherwise look identical. When `LORE_DEBUG=1`,
 * this helper emits one stderr line per failing root so an operator running one
 * session can see which shape they're dealing with.
 *
 * Format: `[lore] partial-failure: root=<rootId> error=<message> tool=<toolName>`
 *
 * Only `error.message` is logged — not `error.stack`, `.body`, `.headers`, or
 * the full error object. The message is then routed through
 * `redactDebugError` which bounds length, strips
 * forward-compatible SDK leak shapes (`body=` / `headers=` / `payload=`),
 * and replaces Notion page-id-shaped substrings with `<page-id>`. The
 * explicit `root=<rootId>` field is NOT redacted — operators need it to
 * triage which root failed.
 *
 * Interpolated fields (`rootId`, `message`) have ASCII control characters
 * — newlines, carriage returns, tabs, and the 0x00-0x1F / 0x7F range —
 * replaced with spaces before the line is written. Under current callers
 * rootIds are Notion UUIDs and rejection messages are single-line, so this
 * is defensive: it preserves the one-event-per-line invariant that log
 * aggregators rely on when future callers stream through the same helper.
 */
export function debugLogPartialFailures(
  toolName: string,
  failures: ReadonlyArray<{ rootId: string; error: unknown }>
): void {
  if (process.env["LORE_DEBUG"] !== "1") return
  for (const { rootId, error } of failures) {
    process.stderr.write(
      `[lore] partial-failure: root=${oneLine(rootId)} error=${oneLine(redactDebugError(error))} tool=${toolName}\n`
    )
  }
}

// eslint-disable-next-line no-control-regex -- coercing to a single log line is the point
const CONTROL_CHARS = /[\x00-\x1F\x7F]/g

function oneLine(value: string): string {
  return value.replace(CONTROL_CHARS, " ")
}
