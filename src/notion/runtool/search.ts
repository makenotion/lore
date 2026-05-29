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
 * 3. **Error mapping.** 403 `RestrictedResource` becomes
 *    {@link RunToolSearchRestrictedError}; the wrapper emits a
 *    once-per-process stderr warning before throwing. Validation 400s, 401,
 *    429, and 5xx propagate verbatim so the rate-limit and auth-refresh
 *    proxies stay authoritative on those classes.
 *
 * Response materialization is the consumer's job. RunTool's `search`
 * returns `{ id, title, url, type, ... }` per hit. Notion-hosted hits
 * can put either a bare page id or a Notion page URL in `url`; the
 * wrapper normalizes that field to a page id before returning. The
 * consumer (`MemoryService`) needs full `PageObjectResponse` shapes
 * to feed `applySemanticPostFilters` + `hydrateRelationPropertiesForPages`.
 * This wrapper returns the structured hit list and lets the consumer
 * hydrate via the shared rate-limited `pages.retrieve` path.
 */

import type { Client } from "@notionhq/client"
import { APIErrorCode, isNotionClientError } from "@notionhq/client"
import { runTool } from "./client.js"
import {
  __resetWarnRunToolRestrictedResourceOnceForTest,
  NOTION_PAGE_ID_IN_TEXT_RE,
  normalizeLikelyNotionPageId,
  warnRunToolRestrictedResourceOnce,
} from "./error-helpers.js"
import {
  dataSourceUrl,
  isInternalSearchResponse,
  RUNTOOL_SEARCH_MAX_PAGE_SIZE,
  type RunToolInternalSearchResponse,
  type RunToolInternalSearchResult,
  type RunToolSearchParams,
} from "./types.js"

export { RUNTOOL_SEARCH_MAX_PAGE_SIZE }

/**
 * Structured error indicating the RunTool `search` dispatch failed because
 * the actor or client capability surface is not allowed to use the tool.
 * `MemoryService` lets this propagate so unsupported auth is visible rather
 * than downgraded silently.
 */
export class RunToolSearchRestrictedError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined)
    this.name = "RunToolSearchRestrictedError"
  }
}

/**
 * One Notion-internal page hit from a RunTool `search` response.
 * External connector hits (Slack / Linear / Drive — `url` is a
 * non-Notion URL rather than a Notion page locator) are filtered out
 * by the wrapper; Lore's consumers only care about Notion pages.
 */
export interface RunToolSearchHit {
  id: string
  title: string
  /** Normalized page id for Notion results; the wrapper drops
   *  external connector hits before returning so this is always safe
   *  to pass to `pages.retrieve`. */
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
   *  window is the caller's signal that the returned semantic window may be
   *  truncated and should be surfaced as cap metadata.
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
  /** The internal search backend the server reported. Always
   *  `ai_search`; the wrapper rejects `workspace_search` and `none`
   *  because semantic retrieval must not silently downgrade to
   *  non-AI relevance. */
  searchType: RunToolInternalSearchResponse["type"]
}

/**
 * Issue a RunTool `search` request scoped to one Notion data source.
 *
 * `query` MUST be non-empty (the server enforces `length >= 1`); the
 * caller is responsible for choosing another explicit retrieval path when the
 * composed query is empty.
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
 * oversight**: REST `client.search` returns no highlights either,
 * so the RunTool path with `max_highlight_length: 0` produces an
 * isomorphic response shape to what REST already gives consumers.
 * If a future caller wants highlights they can override the field
 * — but Lore's `MemoryService` post-filter and materialization
 * pipeline never reads `highlight`.
 *
 * It does NOT set `query_type` or `content_search_mode`: supported
 * PAT / ntn user tokens default to AI search when available. The
 * response must report `type: "ai_search"`; `workspace_search` and
 * `none` mean AI semantic search is unavailable and are rejected
 * loudly instead of being treated as semantic relevance.
 */
export async function searchViaRunTool(
  client: Client,
  params: { query: string; dataSourceId: string; pageSize?: number }
): Promise<RunToolSearchOutcome> {
  if (params.query.length === 0) {
    throw new Error(
      "searchViaRunTool: query must be non-empty (RunTool search " +
        "requires query length >= 1; the caller is responsible for " +
        "choosing another explicit retrieval path on empty queries)."
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
      warnRunToolRestrictedResourceOnce("search", err, { usedRest: false })
      throw new RunToolSearchRestrictedError(
        "RunTool search rejected this token (RestrictedResource). " +
          "RunTool requires a Notion PAT or ntn-issued user token; " +
          "integration tokens (secret_...) are unsupported.",
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
  if (response.type !== "ai_search") {
    throw new Error(
      `AI semantic search unavailable: RunTool search returned ${response.type}; ` +
        `expected ai_search. Ensure this workspace and token have Notion AI search access.`
    )
  }

  // The wrapper narrows to Notion-hosted hits because Lore's
  // consumers only care about Notion pages. External connector
  // results carry non-Notion URLs in the `url` field (e.g.
  // `https://slack.com/...`). The wrapper drops the external arm and
  // normalizes Notion page identifiers before returning so the caller
  // can pass `hit.url` straight to `pages.retrieve`.
  const hits: RunToolSearchHit[] = []
  for (const result of response.results) {
    const pageId = pageIdFromNotionInternalHit(result)
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
 * Extract the page id for Notion-hosted hits. The search API can
 * return either a bare page id or a Notion URL in `url`; external
 * connector results use other hosts and are dropped.
 */
function pageIdFromNotionInternalHit(result: RunToolInternalSearchResult): string | null {
  if (typeof result.url !== "string" || result.url.length === 0) return null
  const barePageId = normalizeLikelyNotionPageId(result.url)
  if (barePageId !== null) return barePageId

  let parsed: URL
  try {
    parsed = new URL(result.url)
  } catch {
    return null
  }
  if (!isNotionHostedSearchUrl(parsed.hostname)) return null

  const pageIdMatch = parsed.pathname.match(NOTION_PAGE_ID_IN_TEXT_RE)
  const matchedPageId = pageIdMatch?.[0]
  return matchedPageId ? normalizeLikelyNotionPageId(matchedPageId) : null
}

function isNotionHostedSearchUrl(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return (
    host === "notion.so" ||
    host.endsWith(".notion.so") ||
    host === "notion.com" ||
    host.endsWith(".notion.com") ||
    host === "notion.site" ||
    host.endsWith(".notion.site")
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
