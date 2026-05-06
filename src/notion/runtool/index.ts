/**
 * Public surface for the quarantined RunTool integration. Phase 0
 * (issue #532) shipped the contract README; issue #533 (PR #538)
 * landed the shared `runTool<T>(client, tool, params)` dispatcher
 * along with the `create_pages` consumer; issue #534 (PR #537)
 * extends with `update_page` / `update_content` for anchored
 * markdown edits; issue #535 extends with `query_data_sources` SQL
 * filter helpers for entity / near-duplicate / conflict-scan
 * predicate pushdowns; issue #541 extends with `search` for the
 * `MemoryService` semantic lane.
 *
 * This barrel re-exports the consumer surface that
 * `MemoryService`, `EntityService`, `memory-encoding.ts`, and the
 * conflict scanner pull in. Sibling modules (`update-page.ts`,
 * `create-pages.ts`, `query.ts`, `search.ts`) live alongside;
 * importers should pull from this barrel rather than the deeper
 * files so the quarantine boundary stays narrow.
 */

export {
  isRunToolAggregateEnabled,
  isRunToolBlockEditEnabled,
  isRunToolEnabled,
  isRunToolFilterSqlEnabled,
  isRunToolSearchEnabled,
} from "./flag.js"
export {
  RunToolBlockEditError,
  updatePageContentViaRunTool,
} from "./update-page.js"
export type {
  RunToolBlockEditFailureKind,
  UpdatePageContentEdit,
  UpdatePageContentParams,
} from "./update-page.js"

// Issue #535 — SQL filter helpers
export {
  comparedPairKey,
  fetchAlreadyComparedPairKeys,
  fetchEntitiesByAliasSubstring,
  fetchEntityByNormalizedName,
  fetchNearDuplicateCandidatePageIds,
  hydrateMemoryPageIds,
  sqlString,
} from "./query.js"
export type {
  NearDuplicateSqlOpts,
  SqlEntityAliasMatch,
  SqlEntityNameMatch,
} from "./query.js"

// Issue #542 — SQL aggregate helpers
export {
  extractFirstRelationId,
  querySubjectGroupCountsViaRunTool,
} from "./query.js"
export type { SqlSubjectGroupCount } from "./query.js"

export {
  dataSourceUrl,
  isInternalSearchResponse,
  isQueryDataSourcesResponse,
  RUNTOOL_SEARCH_MAX_PAGE_SIZE,
} from "./types.js"
export type {
  QueryDataSourcesSqlData,
  RunToolInternalSearchResponse,
  RunToolInternalSearchResult,
  RunToolQueryDataSourcesParams,
  RunToolQueryDataSourcesResponse,
  RunToolSearchParams,
  SqlCellValue,
  SqlResultRow,
} from "./types.js"

// Issue #541 — search consumer
export {
  RunToolSearchRestrictedError,
  searchViaRunTool,
} from "./search.js"
export type {
  RunToolSearchHit,
  RunToolSearchOutcome,
} from "./search.js"

// Re-export the generic dispatcher so call sites that build their own
// SQL helpers can reach `runTool(client, "query_data_sources", params)`
// without piercing the quarantine boundary.
export { runTool } from "./client.js"
