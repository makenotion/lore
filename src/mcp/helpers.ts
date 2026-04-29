/**
 * MCP tool helpers.
 */

import type { ZodError } from "zod"

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

/**
 * Operator observability for the auto-`mentions` fact emission path
 * (0.8.0/#07). The auto-emit branch fires per-entity `createWithDedup`
 * calls in parallel after `lore-memory action='save'`; a per-entity
 * failure (transient 429, dedup probe race, schema drift on a vault
 * that hasn't run `lore migrate`) degrades to a no-op for THAT entity
 * rather than failing the surrounding save. The save itself always
 * succeeds; auto-mentions are advisory.
 *
 * Without this helper, a partial-emit failure is invisible to the
 * operator — the save response shows the saved memory but quietly
 * drops the missing fact. Under `LORE_DEBUG=1`, one stderr line per
 * failing entity surfaces enough detail to distinguish a transient
 * blip from a pathological loop.
 *
 * Format: `[lore] auto-fact-failure: source=<save|update> memoryId=<id> entity=<entity> error=<message>`
 *
 * Same narrowing as `debugLogPartialFailures`: only `error.message`
 * is logged. ASCII control characters in `memoryId` / `entity` /
 * `message` are replaced with spaces before the line is written so
 * the one-event-per-line invariant log aggregators rely on holds even
 * if a future entity tokenizer surfaces a multi-line input.
 *
 * `source` is the originating tool action (`save` for #07's #07
 * scope; `update` reserved for the deferred re-emission follow-up
 * tracked in `DEFERRED-03`). Carrying it on every line lets a future
 * contributor distinguish save-time vs. update-time emission failures
 * without grepping the calling stack.
 */
export function debugLogAutoFactFailure(
  source: "save" | "update",
  memoryId: string,
  entity: string,
  error: unknown,
): void {
  if (process.env["LORE_DEBUG"] !== "1") return
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(
    `[lore] auto-fact-failure: source=${source} memoryId=${oneLine(memoryId)} entity=${oneLine(entity)} error=${oneLine(message)}\n`,
  )
}

/**
 * Opt-in operator observability for contradiction-decrement failures on
 * `lore-fact action='invalidate'` and `lore-decision action='supersede'` /
 * `'create'` (with `supersedesIds`). The decrement is advisory: a failed
 * `pages.update` on the source memory's `Confidence Score` must not fail
 * the surrounding response, because the user already got the contradiction
 * write they asked for (the fact IS invalidated; the decision IS marked
 * superseded). When `LORE_DEBUG=1`, this helper emits one stderr line per
 * failed decrement so an operator triaging confidence drift can tell a
 * transient 429 from a pathological loop.
 *
 * Format: `[lore] contradiction-failure: source=<source> memoryId=<memoryId> error=<message>`
 *
 * The `source` discriminator names the literal MCP action that triggered
 * the decrement, not the colloquial CLAUDE.md alias:
 * - `"invalidate"` — `lore-fact action='invalidate'`
 * - `"supersede"` — `lore-decision action='supersede'`
 * - `"decide-supersede"` — `lore-decision action='create'` with
 *   `supersedesIds` (the supersession is a side-effect of the create)
 *
 * Same `[lore]` prefix as `debugLogPartialFailures` and (forthcoming)
 * `debugLogTouchFailure` so `grep "[lore]"` surfaces all three failure
 * classes together. Per-key naming diverges by surface — `source=` here
 * because there is no Notion `root` and `tool=` would alias the more
 * specific MCP action discriminator. Same redaction posture: only
 * `error.message` is logged, control characters are coerced to spaces so
 * one failure produces exactly one log line.
 */
export function debugLogContradictionFailure(
  source: "invalidate" | "supersede" | "decide-supersede",
  memoryId: string,
  error: unknown,
): void {
  if (process.env["LORE_DEBUG"] !== "1") return
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(
    `[lore] contradiction-failure: source=${oneLine(source)} memoryId=${oneLine(memoryId)} error=${oneLine(message)}\n`,
  )
}

/**
 * Render a Zod validation error as a single-line dispatch error message
 * for the polymorphic `lore-*` tools (P3-01). Surfaces the first issue
 * with `field.path: message` so the calling agent can correct the call
 * without parsing a stack trace. Discriminated-union mismatches manifest
 * as `action: Invalid discriminator value` which already names the
 * offending field, so no extra formatting is needed for that case.
 */
export function formatDispatchError(toolName: string, error: ZodError): string {
  const issue = error.issues[0]
  if (!issue) return `${toolName}: invalid arguments`
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)"
  return `${toolName}: ${path}: ${issue.message}`
}
