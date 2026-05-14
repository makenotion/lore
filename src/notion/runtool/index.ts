/**
 * Public surface for the quarantined RunTool integration. The
 * README pins the contract; the shared `runTool<T>(client, tool, params)`
 * dispatcher lands alongside the `create_pages`, `update_page` /
 * `update_content` (anchored markdown edits), `query_data_sources`
 * (SQL filter helpers for entity / near-duplicate / conflict-scan
 * predicate pushdowns), and `search` (semantic lane) consumers.
 *
 * This barrel re-exports the consumer surface that
 * `MemoryService`, `EntityService`, and the conflict scanner pull
 * in. Sibling modules (the `create_pages` / `update_page` /
 * `query_data_sources` / `search` wrappers) live alongside;
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
export { RunToolBlockEditError, updatePageContentViaRunTool } from "./update-page.js"
export type {
  RunToolBlockEditFailureKind,
  UpdatePageContentEdit,
  UpdatePageContentParams,
} from "./update-page.js"

// SQL filter helpers
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

// SQL aggregate helpers
export { extractFirstRelationId, querySubjectGroupCountsViaRunTool } from "./query.js"
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

// Search consumer
export { RunToolSearchRestrictedError, searchViaRunTool } from "./search.js"
export type { RunToolSearchHit, RunToolSearchOutcome } from "./search.js"

// Re-export the generic dispatcher so call sites that build their own
// SQL helpers can reach `runTool(client, "query_data_sources", params)`
// without piercing the quarantine boundary.
export { runTool } from "./client.js"
