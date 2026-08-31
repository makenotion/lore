/**
 * Small SDK-error inspection helpers for the SQL filter call sites.
 *
 * The shared `runTool<T>(client, tool, params)` dispatcher
 * propagates Notion SDK errors verbatim (per the RunTool dispatcher's
 * "Errors propagate verbatim" contract) so callers can branch on
 * `err.status` / `err.code` directly. The SQL filter call sites
 * share two posture decisions:
 *
 * 1. **Validation errors propagate to the operator.** A 400 /
 *    `validation_error` indicates query-shape drift — column rename,
 *    gateway syntax change, parameter binding shape change. Silent
 *    fallback would mask a permanent SQL-rollout failure as
 *    "REST path always ran." Re-throw so the operator sees it.
 * 2. **Every other error falls back to REST.** Network blip, 5xx,
 *    401 (the auth-refresh proxy already had its retry attempt
 *    before the error reached us), 403 (capability gate; the
 *    `update_page` wrapper already emits a once-per-process
 *    `restricted_resource` warning), 429 (the rate-limit gate
 *    already paused the bucket). Falling back lets the existing
 *    REST/SDK path serve the call while the SQL flag stays opt-in.
 *
 * Helpers below are tiny on purpose — duplicating them across
 * call sites would invite drift, so they live here even though
 * each is only a few lines.
 */

import { redactDebugError, redactDebugMessage } from "../../debug-redact.js"

// eslint-disable-next-line no-control-regex -- stderr events must stay one line
const LOG_CONTROL_CHARS = /[\x00-\x1F\x7F]/g

function oneLine(value: string): string {
  return value.replace(LOG_CONTROL_CHARS, " ")
}

/**
 * Notion page ids come in two wire forms: 32-character lowercase
 * hex (no separators) and dashed UUID (8-4-4-4-12). Either is
 * acceptable to the server.
 *
 * **Single source of truth across RunTool consumers.** Two
 * consumers exist today; future consumers (`fetch`, `move_pages`,
 * etc.) MUST import this regex rather than re-declaring it:
 *
 * - **`update_page`** — validates the caller's
 *   `pageId` parameter at the wrapper boundary so a malformed id
 *   surfaces as a clear local error rather than a generic Notion
 *   400 from the wire.
 * - **`search`** — validates the page id extracted from
 *   `result.url` after the search wrapper distinguishes
 *   Notion-hosted hits from external connector hits. The wrapper
 *   drops external hits so the consumer can pass `hit.url`
 *   straight to `pages.retrieve` without further validation.
 *
 * The `i` flag tolerates upstream casing drift defensively;
 * Notion's canonical form is lowercase but matching is case-
 * insensitive at the wire level.
 */
const NOTION_PAGE_ID_PATTERN =
  "[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

export const NOTION_PAGE_ID_RE = new RegExp(`^(?:${NOTION_PAGE_ID_PATTERN})$`, "i")
export const NOTION_PAGE_ID_IN_TEXT_RE = new RegExp(`(?:${NOTION_PAGE_ID_PATTERN})`, "i")

/**
 * `true` when `pageId` looks like a Notion page id (32-hex or
 * dashed UUID after trim). Fast-fail diagnostic for caller bugs;
 * Notion still validates ids server-side, so a perfectly-shaped
 * id that doesn't exist propagates as a 404 from the server
 * unchanged. See {@link NOTION_PAGE_ID_RE} for the consumer list.
 */
export function isLikelyNotionPageId(pageId: string): boolean {
  return NOTION_PAGE_ID_RE.test(pageId.trim())
}

/**
 * Normalize a bare Notion page id to dashed lowercase UUID form.
 * Returns `null` when the input is not one of the page-id wire forms
 * accepted by {@link isLikelyNotionPageId}.
 */
export function normalizeLikelyNotionPageId(pageId: string): string | null {
  const trimmed = pageId.trim()
  if (!isLikelyNotionPageId(trimmed)) return null
  const compact = trimmed.replaceAll("-", "").toLowerCase()
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join("-")
}

/**
 * `true` when `err` looks like a Notion `validation_error` —
 * either via `status === 400` or via the SDK's parsed `code`
 * field. Both are checked because future SDK shape drift on
 * either dimension still needs to surface to the operator.
 */
export function isSqlValidationError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const status = (err as { status?: number }).status
  const code = (err as { code?: string }).code
  return status === 400 || code === "validation_error"
}

/**
 * Emit a one-line `[lore] partial-failure: …` stderr notice whenever
 * a flagged-on RunTool path hands the call to REST/SDK. Used by the
 * SQL-then-REST fallback paths so an operator can distinguish a
 * transient blip from a sustained capability-gate problem.
 *
 * `source` names the call site (`entity-find-by-name`,
 * `entity-find-by-alias`, `near-duplicate-candidates`,
 * `conflict-already-compared`) so the line is greppable per surface.
 *
 * Routes through `redactDebugError` so SDK-interpolated leak vectors
 * (page ids, headers, etc.) don't surface in the log line — same
 * defense-in-depth posture as the shared partial-failure logger.
 */
export function logRunToolFallback(source: string, err: unknown): void {
  const status = (err as { status?: number } | null | undefined)?.status
  const code = (err as { code?: unknown } | null | undefined)?.code
  process.stderr.write(
    `[lore] partial-failure: source=${oneLine(source)} ` +
      `status=${oneLine(String(status ?? "unknown"))} ` +
      `code=${oneLine(String(code ?? "unknown"))} ` +
      `reason=${runToolFallbackReason(err)} ` +
      `error=${oneLine(redactDebugError(err))} ` +
      `runtool-fallback=1 used-rest=1\n`
  )
}

function runToolFallbackReason(err: unknown): string {
  const status = (err as { status?: number } | null | undefined)?.status
  const code = (err as { code?: unknown } | null | undefined)?.code
  if (code === "restricted_resource" || status === 403) return "restricted_resource"
  if (code === "unauthorized" || status === 401) return "auth_unavailable"
  if (code === "rate_limited" || status === 429) return "rate_limited"
  if (typeof status === "number" && status >= 500) return "server_error"
  if (err instanceof Error && err.name === "RunToolBlockEditError") {
    const kind = (err as { kind?: unknown }).kind
    if (typeof kind === "string" && kind.length > 0) return kind
  }
  if (err instanceof Error && err.name === "SqlPartialResultError") {
    return "partial_result"
  }
  if (status === undefined && code === undefined) return "transport_or_unknown"
  return "runtool_error"
}

/**
 * Sentinel error thrown by SQL helpers when the gateway response
 * carries `has_more: true`. The Notion `query_data_sources` request
 * envelope exposes no cursor / offset / page-size, so a `has_more`
 * response means the requested SQL `LIMIT N` was clamped by the
 * gateway and the helper has only the first page of the filtered
 * candidate set. Treating that as a successful narrow result would
 * silently return fewer rows than the caller asked for; throwing
 * lets the per-call fallback handler route through to the REST
 * path that walks the full window via cursor pagination.
 *
 * The thrown error is NOT a `validation_error` (the helper composed
 * the query correctly; the result was just truncated), so the SQL
 * call site's `isSqlValidationError` check returns false and the
 * REST fallback engages — same path as a transient 5xx / network
 * blip.
 */
export class SqlPartialResultError extends Error {
  constructor(source: string) {
    super(
      `RunTool query_data_sources returned has_more: true at ${source} — ` +
        `the gateway clamped LIMIT and the wrapper has only a partial result. ` +
        `Falling back to REST.`
    )
    this.name = "SqlPartialResultError"
  }
}

const warnedRestrictedResources = new Set<string>()

/**
 * Emit a once-per-source/outcome stderr warning when a RunTool
 * consumer sees a 403 RestrictedResource. Lifted out of the
 * per-consumer modules so repeated identical failures do not spam
 * stderr, while hard failures and REST fallbacks remain separately
 * observable.
 *
 * Routes through the shared redactor for defense-in-depth — auth-
 * shaped error messages can surface workspace ids / paths under
 * uncommon scenarios. Reset-for-test seam exposed below.
 */
export function warnRunToolRestrictedResourceOnce(
  source: "update_page" | "search",
  err: unknown,
  opts: { usedRest: boolean } = { usedRest: true }
): void {
  const key = `${source}:${opts.usedRest ? "fallback" : "error"}`
  if (warnedRestrictedResources.has(key)) return
  warnedRestrictedResources.add(key)
  const message = err instanceof Error ? err.message : ""
  const detail = message ? `: ${redactDebugMessage(message)}` : ""
  const outcome = opts.usedRest
    ? "used REST/SDK path"
    : "operation failed without REST/SDK fallback"
  const markers = opts.usedRest
    ? "runtool-fallback=1 used-rest=1"
    : "runtool-error=1 used-rest=0"
  process.stderr.write(
    `[lore] runtool: 403 RestrictedResource on ${source}; ${outcome}. ` +
      `RunTool returned 403 RestrictedResource. ` +
      `The server-reported error is included below.` +
      detail +
      ` ${markers}\n`
  )
}

/** Test seam — reset the process-local warning latches so individual
 *  test cases can independently exercise the warning path. */
export function __resetWarnRunToolRestrictedResourceOnceForTest(): void {
  warnedRestrictedResources.clear()
}
