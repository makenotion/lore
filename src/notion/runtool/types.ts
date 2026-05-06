/**
 * Pinned subset of `RunToolParams.create_pages` request and response shapes.
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
 * Issue #533 narrows scope to **batch creates** (`create_pages`) only.
 * `update_page`, `move_pages`, etc. live on `RunToolParams.ALL_TOOLS` but
 * are deliberately out of scope here — a future issue must extend this
 * file with their request / response shapes before any production caller
 * may issue them. Doing the wider surface unconditionally would defeat
 * the "Phase 1 wrapper is intentionally narrow" rule from the README.
 *
 * Two structural facts the README pins that this file encodes:
 *
 * 1. **Discriminated request envelope.** `{ type: "create_pages",
 *    create_pages: { parent, pages } }`. Every consumer must build the
 *    body via `runTool("create_pages", params)` rather than hand-rolling
 *    the envelope so the discriminator and the inner key cannot drift.
 * 2. **Bare per-tool response.** The response body is NOT wrapped in
 *    `{ type, [tool_name]: ... }`; it is the raw per-tool resource. For
 *    `create_pages` the resource shape (response of the underlying
 *    public API) is `{ pages: Array<{ id }> }`. A wrapper that types
 *    its return as the request envelope shape will trip on the first
 *    real call.
 *
 * The chunk-size cap (`100` pages per call) is documented in the Notion
 * MCP `notion-create-pages` tool schema — the alias surface that exposes
 * `create_pages` to assistants — as `pages.maxItems = 100`. The wrapper
 * in `create-pages.ts` clamps to that ceiling rather than hard-coding it
 * deeper in the call site so a future schema update touches one constant.
 */

/**
 * Parent for a `create_pages` call. Lore writes facts and memories under
 * `data_source_id` parents exclusively (the five-database vault layout),
 * so this file's surface is narrowed to that arm. The other parent
 * shapes (`page_id`, `database_id`, workspace-level standalone) exist on
 * the raw `RunToolParams` schema but are deliberately omitted here —
 * adding them is a one-line change in a follow-up issue.
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
 * converts these REST shapes into the flat SQLite-style property
 * map the `create_pages` endpoint actually consumes via
 * `convertNotionRestToSqliteProperties`. The conversion is grounded
 * in the empirical wire format observed live against the
 * production Mail vault Facts DB at PR #538 review time. The
 * `Record<string, unknown>` typing reflects the input REST shape;
 * the wrapper handles the SQLite expansion before dispatch.
 *
 * On wire-format mismatch (e.g. a REST shape the converter doesn't
 * recognize, or a host-mismatched relation URL), the server returns
 * `400 validation_error` and the wrapper propagates it through the
 * fallback contract (issue #533: "Use the existing create path
 * when the flag is off or when the batch wrapper rejects the
 * payload"). Default-off behavior protects data integrity even if
 * a future schema-pin refresh tightens or loosens what
 * `create_pages` accepts on the wire.
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
 * One created page in the response. The pinned upstream resource shape
 * exposes more fields than `id`, but only `id` is structurally
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

/**
 * Map from RunTool API tool name → request params shape. Only
 * `create_pages` is populated for issue #533. Phase 1+ of issue #532
 * extends this with `search` and `query_data_sources`.
 */
export interface RunToolRequestMap {
  create_pages: RunToolCreatePagesParams
}

/**
 * Map from RunTool API tool name → response shape. Mirrors the request
 * map; same one-tool narrowness here for issue #533.
 */
export interface RunToolResponseMap {
  create_pages: RunToolCreatePagesResponse
}

export type RunToolName = keyof RunToolRequestMap
