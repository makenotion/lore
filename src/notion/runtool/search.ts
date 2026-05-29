/**
 * High-level wrapper for the `search` consumer.
 *
 * The wrapper sits between `MemoryService.fetchSemanticPages`'s
 * flag-on branch and the shared `runTool(client, "search", params)`
 * dispatcher. Three concerns:
 *
 * 1. **Server cap discipline.** The pinned `SearchToolParams` schema
 *    caps `page_size` at `RUNTOOL_SEARCH_MAX_PAGE_SIZE = 25` and
 *    exposes no cursor, so the wrapper clamps locally and returns a
 *    `saturated` flag the caller surfaces as cap metadata.
 *
 * 2. **Data-source scoping.** Lore's only `search` consumer scopes to
 *    the Memories data source; the wrapper requires `dataSourceId`
 *    and builds the canonical `collection://<id>` URL exactly the
 *    way `query_data_sources` does. The semantic post-filter
 *    pipeline in `MemoryService` does NOT need to re-scope because
 *    `data_source_url` does it server-side.
 *
 * 3. **Error mapping.** 403 `RestrictedResource` is classified
 *    via {@link RunToolSearchRestrictedError} — the auth-refresh
 *    proxy refreshes only on 401, and integration-secret operators
 *    can't pass RunTool's actor-type check. Once-per-process stderr
 *    warning fires the first time so the capability failure is
 *    observable. Validation 400s, 401, 429, and 5xx propagate
 *    verbatim so the rate-limit and auth-refresh proxies stay
 *    authoritative on those classes (canonical vocabulary pinned
 *    by the `update_page` wrapper).
 *
 * Response materialization is the consumer's job. RunTool's `search`
 * returns `{ id, title, url, type, ... }` per hit; the consumer
 * (`MemoryService`) needs full `PageObjectResponse` shapes to feed
 * `applySemanticPostFilters` + `hydrateRelationPropertiesForPages`.
 * This wrapper returns the structured hit list and lets the consumer
 * hydrate via the shared rate-limited `pages.retrieve` path.
 */

import type { Client } from "@notionhq/client"
import { APIErrorCode, isNotionClientError } from "@notionhq/client"
import { runTool } from "./client.js"
import {
  __resetWarnRunToolRestrictedResourceOnceForTest,
  isLikelyNotionPageId,
  warnRunToolRestrictedResourceOnce,
} from "./error-helpers.js"
import {
  dataSourceUrl,
  isInternalSearchResponse,
  RUNTOOL_SEARCH_MAX_PAGE_SIZE,
  type RunToolInternalSearchResponse,
  type RunToolSearchParams,
} from "./types.js"

export { RUNTOOL_SEARCH_MAX_PAGE_SIZE }

/**
 * Structured error indicating the RunTool `search` dispatch failed in
 * a way the caller should surface as semantic-search unavailability.
 * Mirrors the `restricted_resource` arm of
 * {@link import("./client.js").RunToolBlockEditError} for the search
 * surface. All RunTool consumers use `restricted_resource` for
 * fall-back-able 403 capability or actor-shape rejections.
 *
 * The caller (`MemoryService`) converts this to a loud
 * `SemanticSearchUnavailableError` because semantic relevance is
 * defined by AI search, not by a keyword fallback.
 */
export class RunToolSearchRestrictedError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined)
    this.name = "RunToolSearchRestrictedError"
  }
}

/**
 * One Notion-internal page hit from a RunTool `search` response.
 * External connector hits (Slack / Linear / Drive - `url` is a full
 * external URL rather than a page id) are filtered out by the
 * wrapper; Lore's consumers only care about Notion pages.
 */
export interface RunToolSearchHit {
  id: string
  title: string
  /** Page id for Notion results; the wrapper normalizes bare ids and
   *  Notion page URLs, then drops external connector hits before
   *  returning so this is always safe to pass to `pages.retrieve`. */
  url: string
  /** Mirrors Notion's archived flag. Optional on the wire (older
   *  responses omit it); defaults to `false` here so the consumer's
   *  archived-row exclusion runs against a definite value. */
  isArchived: boolean
}

export interface RunToolSearchOutcome {
  hits: RunToolSearchHit[]
  /** True when the response returned exactly `RUNTOOL_SEARCH_MAX_PAGE_SIZE`
   *  hits. The wrapper has no cursor to fetch more, so a saturated
   *  window is the caller's signal that the returned AI-ranked window
   *  is capped.
   *
   *  Conversely, `saturated === false` means **the server has shown
   *  its hand at the requested `page_size`** because the underlying
   *  corpus has fewer than `page_size` matches for this query.
   *
   *  This flag is independent of the post-filter survivor count —
   *  the wrapper does not run Lore's post-filter pipeline; the
   *  consumer does. The flag is computed against the **raw**
   *  response (before the wrapper's external-connector-hit drop),
   *  so a 25-row response of which 24 are external connector hits
   *  still reports `saturated: true`. That is intentional — it
   *  preserves the "the cap may have truncated relevant Lore pages"
   *  semantics regardless of how the server's relevance ranking
   *  intermixed external and Notion hits. */
  saturated: boolean
  /** The kind of internal search the server actually ran
   *  (`ai_search` / `workspace_search` / `none`). Semantic consumers
   *  require `ai_search`; `workspace_search` and `none` are capability
   *  failures for Lore's relevance contract, even when the results
   *  array is empty. */
  searchType: RunToolInternalSearchResponse["type"]
}

/**
 * Issue a RunTool `search` request scoped to one Notion data source.
 *
 * `query` MUST be non-empty (the server enforces `length >= 1`); the
 * caller is responsible for routing empty-query list-like requests to
 * `contains` or `recall`.
 *
 * `pageSize` is **optional** and defaults to
 * `RUNTOOL_SEARCH_MAX_PAGE_SIZE` (the server cap). Production
 * callers should rely on the default — `MemoryService.fetchSemanticPagesViaRunTool`
 * always wants the maximum window so the post-filter has the most
 * headroom and saturation is a real cap signal (not a caller-
 * imposed truncation). The parameter exists for tests / future
 * consumers that need a smaller window. Values are clamped to
 * `[1, RUNTOOL_SEARCH_MAX_PAGE_SIZE]`; `NaN`, `Infinity`, `0`, and
 * negative values fall through the `Number.isFinite` guard to the
 * default.
 *
 * The wrapper sets `max_highlight_length: 0` because Lore never
 * surfaces RunTool's highlight string — saving the response-size
 * budget keeps the round-trip lean. **This is by design, not by
 * oversight**: Lore's search surfaces do not render highlights, so the
 * response can stay small.
 * If a future caller wants highlights they can override the field
 * — but Lore's `MemoryService` post-filter and materialization
 * pipeline never reads `highlight`.
 *
 * It does NOT set `query_type` or `content_search_mode`: the
 * workflow-bot variant of the schema omits these fields (workflow
 * bots are pinned to `query_type: internal` +
 * `content_search_mode: workspace_search`), and personal-bot /
 * user-guest-bot tokens default to AI search when available.
 * Setting them explicitly would foreclose the AI-search fast path
 * on tokens that have access to it.
 */
export async function searchViaRunTool(
  client: Client,
  params: { query: string; dataSourceId: string; pageSize?: number }
): Promise<RunToolSearchOutcome> {
  if (params.query.length === 0) {
    throw new Error(
      "searchViaRunTool: query must be non-empty (RunTool search " +
        "requires query length >= 1; the caller is responsible for " +
        "routing empty-query list-like requests to contains or recall)."
    )
  }
  if (params.dataSourceId.length === 0) {
    throw new Error("searchViaRunTool: dataSourceId is required")
  }

  // `Number.isFinite` rejects `NaN` / `Infinity` / non-numbers
  // before the clamp math (which would propagate `NaN` through
  // `Math.floor` / `Math.max` / `Math.min` and serialize as `null`
  // in the wire body, getting a 400 from the server). Default to
  // the server cap when the caller doesn't specify or specifies
  // garbage.
  const requestedPageSize = params.pageSize
  const clampedPageSize =
    requestedPageSize !== undefined && Number.isFinite(requestedPageSize)
      ? Math.min(Math.max(Math.floor(requestedPageSize), 1), RUNTOOL_SEARCH_MAX_PAGE_SIZE)
      : RUNTOOL_SEARCH_MAX_PAGE_SIZE

  const requestParams: RunToolSearchParams = {
    query: params.query,
    data_source_url: dataSourceUrl(params.dataSourceId),
    page_size: clampedPageSize,
    max_highlight_length: 0,
  }

  let response: RunToolInternalSearchResponse
  try {
    response = await runTool(client, "search", requestParams)
  } catch (err) {
    if (isRestrictedResourceError(err)) {
      warnRunToolRestrictedResourceOnce("search", err)
      throw new RunToolSearchRestrictedError(
        "RunTool search rejected this token (RestrictedResource). " +
          "RunTool search requires an ntn-issued user-actor token " +
          "or personal access token with AI-search access; a public " +
          "OAuth integration secret cannot pass the actor-type check.",
        err
      )
    }
    throw err
  }

  if (!isInternalSearchResponse(response)) {
    throw new Error(
      "searchViaRunTool: malformed response — expected " +
        "InternalSearchResource shape with type ∈ " +
        "{ai_search, workspace_search, none} and results array. " +
        "The upstream schema may have drifted underneath the pinned contract."
    )
  }

  // The wrapper narrows to Notion-internal hits because Lore's
  // consumers only care about Notion pages. External connector
  // results carry a full URL in the `url` field (e.g.
  // `https://slack.com/...`); Notion-internal results carry a bare
  // page id. The wrapper drops the external arm before returning so
  // the caller can pass `hit.url` straight to `pages.retrieve`.
  const hits: RunToolSearchHit[] = []
  for (const result of response.results) {
    const pageId = pageIdFromSearchResultUrl(result.url)
    if (pageId === null) continue
    hits.push({
      id: result.id,
      title: result.title,
      url: pageId,
      // `=== true` strict-coerces non-boolean values (e.g. a
      // hypothetical string `"true"`) to false. Acceptable because
      // `applySemanticPostFilters` re-checks the canonical
      // `page.archived` flag after hydration via `pages.retrieve`,
      // which is the authoritative archive signal. The flag here
      // is informational; the post-filter is the gate.
      isArchived: result.is_archived === true,
    })
  }

  return {
    hits,
    saturated: response.results.length >= clampedPageSize,
    searchType: response.type,
  }
}

/**
 * Extract the Notion page id from a RunTool search result URL.
 *
 * The pinned schema documents `url` as a page id for Notion results
 * and a full URL for external connector results, but production
 * Notion page hits can also return full Notion URLs such as
 * `https://app.dev.notion.com/p/<id>`. Accept bare page ids and
 * Notion-hosted URLs; drop every other URL as an external connector
 * hit.
 */
function pageIdFromSearchResultUrl(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (isLikelyNotionPageId(trimmed)) return trimmed

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (!isNotionHost(url.hostname)) return null

  const match = url.pathname.match(
    /[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  )
  const pageId = match?.[0]
  return pageId !== undefined && isLikelyNotionPageId(pageId) ? pageId : null
}

function isNotionHost(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  return (
    lower === "notion.so" ||
    lower.endsWith(".notion.so") ||
    lower === "notion.com" ||
    lower.endsWith(".notion.com")
  )
}

function isRestrictedResourceError(err: unknown): boolean {
  return isNotionClientError(err) && err.code === APIErrorCode.RestrictedResource
}

/** Test seam — reset the once-per-process warning latch so individual
 *  test cases can independently exercise the warning path. The latch
 *  itself lives so all RunTool consumers share
 *  one warning per process; the seam is re-exported under the
 *  per-consumer name for legacy test-fixture compatibility. */
export function __resetRunToolSearchWarningsForTest(): void {
  __resetWarnRunToolRestrictedResourceOnceForTest()
}
