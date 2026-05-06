/**
 * Pinned subset of `RunToolParams` request and response shapes for
 * Lore's RunTool wrapper.
 *
 * Schema source — vendored from the pinned commit in
 * `src/notion/runtool/README.md` (Phase 0 reconnaissance):
 *
 * | Item   | Value                                                          |
 * | ------ | -------------------------------------------------------------- |
 * | Repo   | `makenotion/notion-next`                                       |
 * | Commit | `69cd144ac1e429229680b6fb24ec29bcea3e37ac` (snapshot 2026-05-05) |
 * | File   | `src/server-publicApi/apis/ai_tools/params/RunToolParams.ts`   |
 *
 * Issue #533 wired the first runtime tool (`create_pages`); issue
 * #534 extends with `update_page` for anchored markdown edits;
 * issue #535 extends with `query_data_sources` for SQL-mode filter
 * pushdowns. Other tools on `RunToolParams.ALL_TOOLS` (`search`,
 * `move_pages`, etc.) are deliberately out of scope until an
 * explicit issue extends this file with their request and response
 * shapes.
 *
 * Two structural facts the README pins that this file encodes:
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
 * `pages.maxItems = 100`. The `create-pages.ts` wrapper clamps to
 * that ceiling rather than hard-coding it deeper in the call site so
 * a future schema update touches one constant.
 */

// ---------------------------------------------------------------------------
// Issue #533 — `create_pages` request and response shapes
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
 * Mail vault Facts DB at PR #538 review time. The
 * `Record<string, unknown>` typing reflects the input REST shape; the
 * wrapper handles the SQLite expansion before dispatch.
 *
 * On wire-format mismatch (e.g. a REST shape the converter doesn't
 * recognize, or a host-mismatched relation URL), the server returns
 * `400 validation_error` and the wrapper propagates it through the
 * fallback contract (issue #533: "Use the existing create path when
 * the flag is off or when the batch wrapper rejects the payload").
 * Default-off behavior protects data integrity even if a future
 * schema-pin refresh tightens or loosens what `create_pages` accepts
 * on the wire.
 */
export interface RunToolCreatePagesInputPage {
  /**
   * Notion REST property payload (same shape as `pages.create` body).
   * Converted to the SQLite-style flat map by the wrapper before
   * dispatch — see `convertNotionRestToSqliteProperties`.
   */
  properties: Record<string, unknown>
  /** Optional Notion-flavored Markdown body. */
  content?: string
  /** Optional emoji / image icon. Mirrors `pages.create`. */
  icon?: string
  /** Optional cover URL. Mirrors `pages.create`. */
  cover?: string
  /** Optional template id for database pages. Mirrors `pages.create`. */
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
 * Bare response of `runTool("create_pages", ...)`. Per the README's
 * "asymmetric envelope" rule, the response is NOT wrapped in `{ type,
 * create_pages: ... }`; it is the per-tool resource directly.
 */
export interface RunToolCreatePagesResponse {
  pages: RunToolCreatePagesOutputPage[]
}

// ---------------------------------------------------------------------------
// Issue #534 — `update_page` / `update_content` request and response shapes
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
 * `allow_deleting_content` mirrors the REST `pages.updateMarkdown`
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
 * bare resource (no outer envelope) per Phase 0 reconnaissance.
 * Typed loosely because Phase 0 documented the contract from source
 * without runtime verification of every success body — narrow to a
 * stricter shape only after a real-call sample lands in the
 * wrapper's tests.
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
// Issue #535 — `query_data_sources` SQL-mode request and response shapes
// ---------------------------------------------------------------------------

/**
 * Cell value shape returned by `query_data_sources` SQL queries.
 *
 * Rows in `QueryDataSourcesResource.results` are flat
 * `Record<string, SqlCellValue>` keyed by the SQL output column name.
 * Source: `SQLiteDatabasePropertyValue`, exposed via `unionResource`
 * plus `nullableResource` (see
 * `resources/query_data_sources/QueryDataSourcesResource.ts` at the
 * pinned blob SHA).
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
  value: unknown,
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
 * the SQL table name (fully quoted in the query). Documented as
 * the public contract in `README.md`'s
 * `query_data_sources Tool — Input/Output Shape` section.
 */
export function dataSourceUrl(dataSourceId: string): string {
  return `collection://${dataSourceId}`
}

// ---------------------------------------------------------------------------
// Tool-name maps
// ---------------------------------------------------------------------------

/**
 * Map from RunTool API tool name → request params shape.
 * Issue #533 wired `create_pages`; issue #534 extends with
 * `update_page`; issue #535 extends with `query_data_sources`.
 * Phase 1+ of issue #532 will add `search`.
 */
export interface RunToolRequestMap {
  create_pages: RunToolCreatePagesParams
  update_page: RunToolUpdatePageContentParams
  query_data_sources: RunToolQueryDataSourcesParams
}

/**
 * Map from RunTool API tool name → response shape. Mirrors the
 * request map.
 */
export interface RunToolResponseMap {
  create_pages: RunToolCreatePagesResponse
  update_page: RunToolUpdatePageResponse
  query_data_sources: RunToolQueryDataSourcesResponse
}

export type RunToolName = keyof RunToolRequestMap
