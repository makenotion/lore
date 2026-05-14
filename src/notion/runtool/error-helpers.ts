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
 * - **`search`** (`search.ts:isNotionInternalHit`) — validates
 *   `result.url` against the regex to distinguish Notion-internal
 *   hits (where the schema puts the page id in `url`) from
 *   external connector hits (Slack / Linear / Drive — where `url`
 *   is a full external URL). The wrapper drops external hits so
 *   the consumer can pass `hit.url` straight to `pages.retrieve`
 *   without further validation.
 *
 * The `i` flag tolerates upstream casing drift defensively;
 * Notion's canonical form is lowercase but matching is case-
 * insensitive at the wire level.
 */
export const NOTION_PAGE_ID_RE =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

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
 * Emit a one-line `[lore] partial-failure: …` stderr notice when
 * `LORE_DEBUG=1`. Used by the SQL-then-REST fallback paths so an
 * operator can distinguish a transient blip from a sustained
 * capability-gate problem (the SQL flag stays opt-in by default,
 * so a sustained fallback isn't user-visible without this signal).
 *
 * `source` names the call site (`entity-find-by-name`,
 * `entity-find-by-alias`, `near-duplicate-candidates`,
 * `conflict-already-compared`) so the line is greppable per surface.
 *
 * Routes through `redactDebugError` so SDK-interpolated leak vectors
 * (page ids, headers, etc.) don't surface in the log line — same
 * defense-in-depth posture as `debugLogPartialFailures` on the MCP
 * tool helpers.
 */
export function logRunToolFallback(source: string, err: unknown): void {
  if (process.env["LORE_DEBUG"] !== "1") return
  const status = (err as { status?: number } | null | undefined)?.status
  const code = (err as { code?: string } | null | undefined)?.code
  process.stderr.write(
    `[lore] partial-failure: source=${source} ` +
      `status=${status ?? "unknown"} code=${code ?? "unknown"} ` +
      `error=${redactDebugError(err)} runtool-fallback=1\n`,
  )
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
        `Falling back to REST.`,
    )
    this.name = "SqlPartialResultError"
  }
}

/**
 * Auth sources that carry an integration-secret token (Notion
 * "internal integration" tokens, not user-actor tokens). These
 * auth paths are explicitly rejected by RunTool with 403
 * `RestrictedResource` per the README's "Auth And Capability
 * Requirements" section.
 *
 * The set is currently empty: `env-notion-api-token` is ambiguous
 * (could be either an integration secret or a personal token,
 * depending on what the operator exported), so it stays out of the
 * known-rejected set. Adding a future auth source requires explicit
 * triage.
 */
const KNOWN_INTEGRATION_SECRET_AUTH_SOURCES = new Set<string>()

/**
 * `true` when the auth source carries an integration-secret token
 * that RunTool will reject with 403.
 */
export function isKnownIntegrationSecretAuthSource(source: string): boolean {
  return KNOWN_INTEGRATION_SECRET_AUTH_SOURCES.has(source)
}

let warnedRestrictedResourceFallback = false

/**
 * Emit a single once-per-process stderr warning when ANY RunTool
 * consumer falls back from a 403 RestrictedResource. Lifted out of
 * the per-consumer modules (the `update_page` latch on the runtool
 * client, the search latch on the runtool search wrapper) so an
 * integration-secret operator
 * dogfooding multiple flagged-on surfaces sees one warning instead
 * of N. The README's "silently degrade … but loud enough" mandate
 * is a per-process posture, not per-tool.
 *
 * Routes through the shared redactor for defense-in-depth — auth-
 * shaped error messages can surface workspace ids / paths under
 * uncommon scenarios. Reset-for-test seam exposed below.
 */
export function warnRunToolRestrictedResourceOnce(
  source: "update_page" | "search",
  err: unknown
): void {
  if (warnedRestrictedResourceFallback) return
  warnedRestrictedResourceFallback = true
  const message = err instanceof Error ? err.message : ""
  const detail = message ? `: ${redactDebugMessage(message)}` : ""
  process.stderr.write(
    `[lore] runtool: 403 RestrictedResource on ${source}; falling back to ` +
      `REST/SDK path. RunTool requires an ntn-issued user-actor token; ` +
      `see src/notion/runtool/README.md` +
      detail +
      `\n`
  )
}

/** Test seam — reset the once-per-process latch so individual test
 *  cases can independently exercise the warning path. */
export function __resetWarnRunToolRestrictedResourceOnceForTest(): void {
  warnedRestrictedResourceFallback = false
}

let warnedRunToolIntegrationSecret = false

/**
 * Emit a one-time stderr warning at services init when a RunTool
 * feature flag is enabled (`LORE_USE_RUNTOOL` / sub-flag) AND the
 * resolved auth source is a known integration-secret path that
 * RunTool will reject with 403.
 *
 * Once-per-process so a long-lived MCP server doesn't spam stderr;
 * idempotent on services re-init.
 */
export function warnRunToolIntegrationSecretOnce(authSource: string): void {
  if (warnedRunToolIntegrationSecret) return
  if (!isKnownIntegrationSecretAuthSource(authSource)) return
  warnedRunToolIntegrationSecret = true
  process.stderr.write(
    `[lore] runtool: LORE_USE_RUNTOOL* flag is enabled but the resolved auth ` +
      `source (${authSource}) is an integration-secret path that RunTool ` +
      `rejects with 403. Every flagged-on call will silently fall back to REST. ` +
      `Migrate to ntn-issued auth via 'lore auth --login' to dogfood RunTool, ` +
      `or unset the LORE_USE_RUNTOOL* flags to silence this warning.\n`,
  )
}

/** Test seam — reset the once-per-process latch so individual test
 *  cases can independently exercise the warning path. */
export function __resetWarnRunToolIntegrationSecretForTest(): void {
  warnedRunToolIntegrationSecret = false
}
