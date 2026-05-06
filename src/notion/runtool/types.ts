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
 * #534 extends the surface with `update_page` for anchored markdown
 * edits. Other tools on `RunToolParams.ALL_TOOLS` (`search`,
 * `query_data_sources`, `move_pages`, etc.) are deliberately out of
 * scope until an explicit issue extends this file with their request
 * and response shapes.
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
// Tool-name maps
// ---------------------------------------------------------------------------

/**
 * Map from RunTool API tool name → request params shape.
 * Issue #533 wired `create_pages`; issue #534 extends with
 * `update_page`. Phase 1+ of issue #532 will add `search` and
 * `query_data_sources`.
 */
export interface RunToolRequestMap {
  create_pages: RunToolCreatePagesParams
  update_page: RunToolUpdatePageContentParams
}

/**
 * Map from RunTool API tool name → response shape. Mirrors the
 * request map.
 */
export interface RunToolResponseMap {
  create_pages: RunToolCreatePagesResponse
  update_page: RunToolUpdatePageResponse
}

export type RunToolName = keyof RunToolRequestMap
