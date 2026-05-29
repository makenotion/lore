/**
 * Pinned subset of `RunToolParams` request and response shapes for
 * Lore's RunTool wrapper.
 *
 * Schema source — vendored from the pinned upstream snapshot:
 *
 * | Item   | Value                                                          |
 * | ------ | -------------------------------------------------------------- |
 * | Source | internal upstream Notion server snapshot                       |
 * | Commit | `69cd144ac1e429229680b6fb24ec29bcea3e37ac` (snapshot 2026-05-05) |
 * | File   | upstream `RunToolParams` module under the public-API ai_tools params dir |
 *
 * Wired runtime tools: `create_pages`, `update_page` for anchored
 * markdown edits, `query_data_sources` for SQL-mode filter pushdowns,
 * and `search` for the semantic-lane consumer. Other tools on
 * `RunToolParams.ALL_TOOLS` (`move_pages`, etc.) are deliberately
 * out of scope until an explicit follow-up extends this file with
 * their request and response shapes.
 *
 * Two structural facts this file encodes:
 *
 * 1. **Discriminated request envelope.** `{ type: <tool>, [tool]:
 *    params }`. Every consumer must build the body via
 *    `runTool(<tool>, params)` rather than hand-rolling the envelope
 *    so the discriminator and the inner key cannot drift.
 * 2. **Bare per-tool response.** The response body is NOT wrapped in
 *    `{ type, [tool_name]: ... }`; it is the raw per-tool resource.
 *    A wrapper that types its return as the request envelope shape
 *    will trip on the first real call.
 *
 * The `create_pages` chunk-size cap (`100` pages per call) is
 * documented in the Notion MCP `notion-create-pages` tool schema —
 * the alias surface that exposes `create_pages` to assistants — as
 * `pages.maxItems = 100`. The `create_pages` wrapper clamps to
 * that ceiling rather than hard-coding it deeper in the call site so
 * a future schema update touches one constant.
 */

// ---------------------------------------------------------------------------
// `create_pages` request and response shapes
// ---------------------------------------------------------------------------

/**
 * Parent of a `create_pages` request. The wrapper narrows to the
 * data-source parent shape because every Lore caller writes to a
 * specific data source, so this file's surface is narrowed to that
 * arm. The other parent shapes (`page_id`, `database_id`,
 * workspace-level standalone) exist on the raw `RunToolParams` schema
 * but are deliberately omitted here — adding them is a one-line
 * change in a follow-up issue.
 */
export interface RunToolCreatePagesParent {
  type: "data_source_id"
  data_source_id: string
}

/**
 * One page in a `create_pages` request.
 *
 * `properties` is the Notion REST property payload (`{ title: [...] }`,
 * `{ rich_text: [...] }`, `{ select: { name } }`, `{ relation: [{ id }] }`,
 * `{ date: { start } }`, `{ number }`) that `buildFactProps` /
 * `buildMemoryProps` produce. The `createPagesViaRunTool` wrapper
 * converts these REST shapes into the flat SQLite-style property map
 * the `create_pages` endpoint actually consumes via
 * `convertNotionRestToSqliteProperties`. The conversion is grounded
 * in the empirical wire format observed live against the production
 * internal vault Facts DB during batch-create rollout. The
 * `Record<string, unknown>` typing reflects the input REST shape; the
 * wrapper handles the SQLite expansion before dispatch.
 *
 * On wire-format mismatch (e.g. a REST shape the converter doesn't
 * recognize, or a host-mismatched relation URL), the server returns
 * `400 validation_error` and the wrapper propagates it through the
 * fallback contract ("Use the existing create path when
 * the flag is off or when the batch wrapper rejects the payload").
 * Default-off behavior protects data integrity even if a future
 * schema-pin refresh tightens or loosens what `create_pages` accepts
 * on the wire.
 */
export interface RunToolCreatePagesInputPage {
  /**
   * Notion REST property payload (same shape as `pages.create` body).
   * Converted to the SQLite-style flat map by the wrapper before
   * dispatch via `convertNotionRestToSqliteProperties`.
   */
  properties: Record<string, unknown>
  /** Optional Notion-flavored Markdown body. */
  content?: string
  /** Optional emoji / image icon. Matches `pages.create`. */
  icon?: string
  /** Optional cover URL. Matches `pages.create`. */
  cover?: string
  /** Optional template id for database pages. Matches `pages.create`. */
  template_id?: string
}

/**
 * Request body of `runTool("create_pages", params)`. The full wire
 * envelope is `{ type: "create_pages", create_pages: <this shape> }`;
 * the discriminator + outer key are added by `runTool` itself so
 * callers cannot mis-spell either half.
 */
export interface RunToolCreatePagesParams {
  parent: RunToolCreatePagesParent
  pages: RunToolCreatePagesInputPage[]
}

/**
 * One created page in the response. The pinned upstream resource
 * shape exposes more fields than `id`, but only `id` is structurally
 * load-bearing for Lore's batch-create caller — the wrapper hands the
 * id back so the caller can hydrate the row via `pages.retrieve` /
 * `pages.retrieveMarkdown` if it needs the post-write shape.
 */
export interface RunToolCreatePagesOutputPage {
  id: string
}

/**
 * Bare response of `runTool("create_pages", ...)`. The response is NOT
 * wrapped in `{ type, create_pages: ... }`; it is the per-tool resource
 * directly.
 */
export interface RunToolCreatePagesResponse {
  pages: RunToolCreatePagesOutputPage[]
}

// ---------------------------------------------------------------------------
// `update_page` / `update_content` request and response shapes
// ---------------------------------------------------------------------------

/**
 * Single in-place string replacement for `update_content`.
 * `replace_all_matches` defaults to `false` server-side; multiple
 * matches under that default fail rather than picking one
 * implicitly.
 */
export interface RunToolUpdateContentEdit {
  old_str: string
  new_str: string
  replace_all_matches?: boolean
}

/**
 * `update_page` body — the `update_content` command shape.
 * `allow_deleting_content` parallels the REST `pages.updateMarkdown`
 * flag — Notion warns when an edit removes child pages or databases
 * unless the caller acknowledges the deletion.
 */
export interface RunToolUpdatePageContentParams {
  page_id: string
  command: "update_content"
  content_updates: RunToolUpdateContentEdit[]
  allow_deleting_content?: boolean
}

/**
 * Server-emitted warning when an edit would remove child pages or
 * databases. Surfaced verbatim by the wrapper so callers can decide
 * whether the deletion is intended.
 */
export interface RunToolDeletionWarning {
  /** Free-form server message describing what was deleted. */
  message?: string
  /** Optional structured list of removed page / database ids. */
  deleted_ids?: string[]
}

/**
 * Response shape for an `update_page` / `update_content` call. The
 * bare resource (no outer envelope). Typed loosely because the contract was
 * documented from source without runtime
 * verification of every success body — narrow to a stricter shape
 * only after a real-call sample lands in the wrapper's tests.
 */
export interface RunToolUpdatePageResponse {
  /** Echoed page id on success. */
  page_id?: string
  /** Optional deletion warning when `allow_deleting_content` is
   *  false and the edit would remove children. May appear as an
   *  array (multiple warnings) or a single object depending on the
   *  upstream code path. */
  deletion_warning?: RunToolDeletionWarning | RunToolDeletionWarning[]
  /** Tolerate forward-compatible additions without forcing a schema
   *  bump every time the server widens its response. */
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// `query_data_sources` SQL-mode request and response shapes
// ---------------------------------------------------------------------------

/**
 * Cell value shape returned by `query_data_sources` SQL queries.
 *
 * Rows in `QueryDataSourcesResource.results` are flat
 * `Record<string, SqlCellValue>` keyed by the SQL output column name.
 * Source: `SQLiteDatabasePropertyValue`, exposed via `unionResource`
 * plus `nullableResource` (see the upstream
 * `QueryDataSourcesResource` module at the pinned blob SHA).
 */
export type SqlCellValue = string | number | boolean | string[] | null

/**
 * Row shape returned by `query_data_sources` in SQL mode. Keys are
 * SQL output column names; values are scalar `SqlCellValue`s.
 */
export type SqlResultRow = Record<string, SqlCellValue>

/**
 * SQL-mode parameters for `query_data_sources`.
 *
 * `mode` defaults to `"sql"` server-side; we set it explicitly so the
 * wire payload is unambiguous on a future schema bump that adds a new
 * default mode. `data_source_urls` carries one or more
 * `collection://<data_source_id>` URLs — the same strings that double
 * as fully-quoted SQL table names inside `query`.
 *
 * `params` are positional `?`-placeholder values. **Boolean values
 * MUST use the literal sentinels `"__YES__"` / `"__NO__"`** — neither
 * `0` / `1` nor `"true"` / `"false"` are recognized by the SQLite
 * gateway for checkbox columns. Strings, numbers, and `null` flow
 * through as-is for non-checkbox columns.
 */
export interface QueryDataSourcesSqlData {
  mode?: "sql"
  data_source_urls: string[]
  query: string
  params?: ReadonlyArray<string | number | null>
}

/**
 * Request body of `runTool("query_data_sources", params)`. The
 * full wire envelope is `{ type: "query_data_sources",
 * query_data_sources: { data: <SQL data> } }`; `runTool` adds the
 * outer discriminator and the inner `query_data_sources` key.
 */
export interface RunToolQueryDataSourcesParams {
  data: QueryDataSourcesSqlData
}

/**
 * Bare response shape for `query_data_sources`. **Asymmetric with
 * the request** — there is NO outer `{ type, [tool]: ... }`
 * wrapping; the response is `QueryDataSourcesResource.Value`
 * directly, per the pinned `RunToolResource.Value` definition.
 *
 * `data_source_ids` is documented as "only present for SQL queries"
 * (per the resource description); typed `?` accordingly.
 */
export interface RunToolQueryDataSourcesResponse {
  results: SqlResultRow[]
  has_more: boolean
  data_source_ids?: string[]
}

/**
 * `true` when `value` matches the structural contract of
 * {@link RunToolQueryDataSourcesResponse}. Defensive guard for the
 * malformed-response path: a successful (200) HTTP response whose
 * body lacks `results: Array<Record<string, ...>>` or `has_more:
 * boolean` indicates the upstream schema drifted underneath the
 * pin and the wrapper must fall back to REST rather than feed
 * garbage to its callers. Per-row cell typing is NOT validated
 * here — the SQL caller knows which columns it asked for and
 * narrows defensively at use sites.
 */
export function isQueryDataSourcesResponse(
  value: unknown
): value is RunToolQueryDataSourcesResponse {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  if (typeof v["has_more"] !== "boolean") return false
  if (!Array.isArray(v["results"])) return false
  for (const row of v["results"]) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false
  }
  if (
    v["data_source_ids"] !== undefined &&
    !(
      Array.isArray(v["data_source_ids"]) &&
      v["data_source_ids"].every((s: unknown) => typeof s === "string")
    )
  ) {
    return false
  }
  return true
}

/**
 * Build the `collection://<data_source_id>` URL used by
 * `query_data_sources` as both the `data_source_urls` entry AND
 * the SQL table name (fully quoted in the query).
 */
export function dataSourceUrl(dataSourceId: string): string {
  return `collection://${dataSourceId}`
}

// ---------------------------------------------------------------------------
// `search` request and response shapes
// ---------------------------------------------------------------------------

/**
 * Server-side hard cap on `search.page_size` per the pinned
 * `SearchToolParams` schema. The REST `client.search` allows up to 100
 * per page; RunTool `search` allows up to 25 and exposes no cursor.
 * Lore's wrapper clamps to this ceiling and reports saturation as cap metadata.
 */
export const RUNTOOL_SEARCH_MAX_PAGE_SIZE = 25

/**
 * One result in the `InternalSearchResource` arm of the bare
 * `SearchResource` response. For `query_type: "internal"`, `url`
 * can be a bare page id or a Notion page URL for Notion-hosted
 * results; external connector results (Slack, Linear, Drive) carry
 * non-Notion URLs and are discarded by `MemoryService`'s consumer
 * because they are not Lore page candidates.
 */
export interface RunToolInternalSearchResult {
  id: string
  title: string
  /** Page id or Notion URL for Notion results; non-Notion URL for connector results. */
  url: string
  /** Resource type discriminator (`page`, `database`, etc.). */
  type: string
  /** Empty when `max_highlight_length: 0`. */
  highlight: string
  timestamp: string
  is_archived?: boolean
}

/**
 * Bare response of `runTool("search", ...)` for `query_type:
 * "internal"`. The pinned `SearchResource.Value` is a discriminated
 * union of `InternalSearchResource | UserSearchResource`; Lore only
 * issues `internal` queries so this is the only arm the wrapper
 * narrows to. The wrapper rejects (programming error) any response
 * carrying the `user_search` discriminator.
 */
export interface RunToolInternalSearchResponse {
  type: "ai_search" | "workspace_search" | "none"
  results: RunToolInternalSearchResult[]
}

/**
 * Request body for `runTool("search", params)`. The full wire envelope
 * is `{ type: "search", search: <this shape> }`; `runTool` adds the
 * outer discriminator.
 *
 * `query` is required and (server-side) must have `length >= 1`.
 * Lore's `MemoryService.fetchSemanticPages` accepts an empty composed
 * query for unscoped recall, so that caller uses a DS-scoped listing
 * instead of sending an invalid RunTool request.
 *
 * `data_source_url` scopes the search to one collection
 * (`collection://<data_source_id>`). The wrapper ALWAYS sets this for
 * Memory searches so the workspace-wide post-filter to the Memories
 * data source is unnecessary on the RunTool path.
 *
 * `page_size <= 25` — bounded by `RUNTOOL_SEARCH_MAX_PAGE_SIZE`.
 *
 * `max_highlight_length: 0` is the wrapper's default — Lore never
 * surfaces RunTool's highlight string and the savings on response
 * size aren't worth a non-zero default.
 */
export interface RunToolSearchParams {
  query: string
  query_type?: "internal"
  content_search_mode?: "ai_search" | "workspace_search"
  data_source_url?: string
  page_url?: string
  teamspace_id?: string
  page_size?: number
  max_highlight_length?: number
}

/**
 * `true` when `value` matches the structural contract of
 * {@link RunToolInternalSearchResponse}. Defensive guard for the
 * malformed-response path: a successful (200) HTTP response whose
 * body lacks `type` ∈ `{ai_search, workspace_search, none}` or
 * `results` array indicates the upstream schema drifted underneath
 * the pin and the wrapper must fail rather than feed garbage to its
 * callers. Per-result field typing is checked
 * structurally on the entries the wrapper actually consumes
 * (`id`, `url`).
 */
export function isInternalSearchResponse(
  value: unknown
): value is RunToolInternalSearchResponse {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  if (
    v["type"] !== "ai_search" &&
    v["type"] !== "workspace_search" &&
    v["type"] !== "none"
  ) {
    return false
  }
  if (!Array.isArray(v["results"])) return false
  for (const result of v["results"]) {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return false
    }
    const r = result as Record<string, unknown>
    if (typeof r["id"] !== "string" || r["id"].length === 0) return false
    if (typeof r["url"] !== "string") return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Tool-name maps
// ---------------------------------------------------------------------------

/**
 * Map from RunTool API tool name → request params shape.
 * Wired tools: `create_pages`, `update_page`, `query_data_sources`,
 * `search`.
 */
export interface RunToolRequestMap {
  create_pages: RunToolCreatePagesParams
  update_page: RunToolUpdatePageContentParams
  query_data_sources: RunToolQueryDataSourcesParams
  search: RunToolSearchParams
}

/**
 * Map from RunTool API tool name → response shape. Mirrors the
 * request map.
 */
export interface RunToolResponseMap {
  create_pages: RunToolCreatePagesResponse
  update_page: RunToolUpdatePageResponse
  query_data_sources: RunToolQueryDataSourcesResponse
  search: RunToolInternalSearchResponse
}

export type RunToolName = keyof RunToolRequestMap
