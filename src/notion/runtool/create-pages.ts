/**
 * `createPagesViaRunTool` — chunked batch-create wrapper over RunTool's
 * `create_pages` endpoint.
 *
 * Replaces the per-page `pages.create` + optional `pages.updateMarkdown`
 * fan-out with a single `POST /v1/tools/run` request per chunk for
 * create-heavy paths (issue #533). The auto-learn `mentions` fact
 * emission in `MemoryService.handleSave` / `handleUpdate` is the
 * canonical first consumer; future create-heavy migrations or imports
 * can adopt the same primitive opt-in per call site.
 *
 * Surface contract (called out in issue #533's "Approach"):
 *
 * 1. **Same-parent batching only.** Every page in one call shares one
 *    `data_source_id` parent. Callers that mix data sources must group
 *    inputs by parent and call once per group; the wrapper rejects
 *    multi-parent input at the type boundary.
 * 2. **Defensive chunking.** RunTool's `create_pages` documents
 *    `pages.maxItems = 100` on the alias surface
 *    (`notion-create-pages` MCP tool). The wrapper clamps `chunkSize`
 *    to that cap. Empty input is a structural no-op (no Notion call
 *    at all).
 * 3. **Partial-commit handling is first-class.** Per the issue's
 *    failure-semantics requirement: if a chunk fails mid-batch, the
 *    wrapper surfaces created page ids from prior successful chunks
 *    alongside the error so callers can be idempotent before
 *    retrying. The `BatchCreateError` carries the committed prefix
 *    explicitly rather than collapsing it onto the generic Error.
 * 4. **No second auth path or rate-limit gate.** The wrapper
 *    receives the shared `Client` and dispatches via `runTool`,
 *    which goes through `client.request()` — the same Proxy that
 *    rate-limits and auth-refreshes every other Notion call. A
 *    parallel `pLimit` here would defeat the composition contract
 *    (issue #532's "RunTool calls must compose with the same
 *    configured request pacing/backoff") so chunks dispatch
 *    serially. The shared bucket bounds inter-chunk spacing.
 *
 * Callers pass pages whose `properties` are already in the
 * `pages.create`-shaped Notion REST format that `buildFactProps` /
 * `buildMemoryProps` produce. The wrapper itself converts those
 * REST shapes into the flat SQLite-style property map RunTool's
 * `create_pages` consumes (via
 * `convertNotionRestToSqliteProperties` from
 * `./sqlite-properties.ts`). The conversion is grounded in the
 * empirical wire format observed live against the production Mail
 * vault Facts DB at PR #538 review time — title/rich_text/select
 * → flat strings, dates → 3-key `date:<col>:start/:end/:is_datetime`
 * expansion, relations → JSON-stringified array of user-facing
 * URLs. Without the conversion the server rejects the call with
 * `validation_error` because Notion REST shapes are NOT what the
 * `create_pages` endpoint expects despite the alias schema's
 * "primitive value space" framing.
 *
 * Relation URLs are environment-coupled — the user-facing host
 * (`dev.notion.so` for dev, `www.notion.so` for production) MUST
 * match the workspace's API host or the server returns
 * `400 validation_error: Invalid page URL ... for property X`.
 * Callers thread the derived host via `relationUrlBase`; see
 * `services.ts:deriveRelationUrlBase` for the canonical mapping.
 */

import type { Client } from "@notionhq/client"
import { runTool } from "./client.js"
import { convertNotionRestToSqliteProperties } from "./sqlite-properties.js"
import type {
  RunToolCreatePagesInputPage,
  RunToolCreatePagesParent,
} from "./types.js"

/**
 * RunTool `create_pages` documents `pages.maxItems = 100` on the
 * `notion-create-pages` MCP alias schema. The wrapper clamps to this
 * ceiling rather than baking the literal deeper into the call site
 * so a future schema-pin refresh touches exactly one constant. The
 * issue notes "Do not bake in 100 without a test or Public API-team
 * confirmation"; the alias schema IS the public API team's
 * confirmation surface, and the test in `create-pages.test.ts` pins
 * the constant.
 */
export const RUNTOOL_CREATE_PAGES_MAX_CHUNK = 100

/**
 * Default chunk size when caller does not provide one. Matches the
 * server cap so a typical fan-out (10–25 mentions facts on a save)
 * lands in one round-trip; larger inputs auto-chunk.
 */
export const RUNTOOL_CREATE_PAGES_DEFAULT_CHUNK = 100

export interface CreatePagesViaRunToolInput {
  /**
   * Shared Notion SDK client — the rate-limited, auth-refreshing
   * Proxy from `initServicesFromConfig`. Tests pass a stub.
   */
  client: Client
  /**
   * Data-source id every page will be created under. The wrapper
   * does not support `page_id` / `database_id` / workspace-level
   * parents for the same scope-narrowing reason `RunToolCreatePagesParent`
   * does not.
   */
  parentDataSourceId: string
  /**
   * Pages to create. Each carries Notion REST-shaped `properties`,
   * optional Markdown `content`, optional `icon` / `cover` /
   * `template_id`. Ordering is preserved across chunks; the returned
   * `createdPageIds` parallels `pages` 1:1.
   */
  pages: RunToolCreatePagesInputPage[]
  /**
   * Maximum pages per `create_pages` call. Clamped to the server cap
   * (`RUNTOOL_CREATE_PAGES_MAX_CHUNK`). Defaults to the cap when
   * omitted. Non-positive values fall back to the default; the
   * wrapper does not throw on a bad knob because the operator
   * surface is opt-in flag-gated.
   */
  chunkSize?: number
  /**
   * User-facing host root used to construct relation URLs
   * (e.g. `https://dev.notion.so/` for the dev environment,
   * `https://www.notion.so/` for production). Must match the
   * workspace's user-facing domain — see
   * `services.ts:deriveRelationUrlBase`. Live verification at
   * PR #538 review time confirmed that the server rejects relation
   * URLs whose host doesn't match the workspace environment.
   * Optional; defaults to the production host. Production callers
   * MUST thread the derived base from the auth chain.
   */
  relationUrlBase?: string
}

export interface CreatePagesViaRunToolResult {
  /**
   * Created page ids in input order. Length equals `pages.length` on
   * success. On partial commit, length equals the number of pages
   * the server confirmed before the failing chunk; the rest are
   * surfaced via `BatchCreateError.committedIds`.
   */
  createdPageIds: string[]
}

/**
 * Thrown when a `create_pages` chunk fails after at least one
 * earlier chunk succeeded. Callers MUST inspect `committedIds`
 * before retrying — re-issuing the original input would create
 * duplicates of the committed prefix.
 *
 * `cause` carries the underlying error (a Notion SDK
 * `APIResponseError`, a network `TypeError`, etc.) so the caller
 * can branch on status codes. The message is intentionally short
 * because the operator-actionable detail lives on `cause`.
 */
export class BatchCreateError extends Error {
  /**
   * Page ids successfully committed before the failure. Empty when
   * the very first chunk failed. Populated in input order so a
   * caller idempotency-checking against an external dedup index
   * can iterate the prefix without re-sorting.
   */
  readonly committedIds: string[]
  override readonly cause: unknown

  constructor(committedIds: string[], cause: unknown) {
    const committedCount = committedIds.length
    super(
      `RunTool create_pages partial commit: ${committedCount} page${
        committedCount === 1 ? "" : "s"
      } created before the failing chunk.`
    )
    this.name = "BatchCreateError"
    this.committedIds = committedIds
    this.cause = cause
  }
}

/**
 * Batch-create pages via RunTool's `create_pages` tool with
 * defensive chunking and partial-commit handling.
 *
 * Empty `pages` input is a structural no-op — no Notion call,
 * `createdPageIds: []` returned. Mirrors `dataSources.query` /
 * `pages.update`-with-empty-properties behavior elsewhere in the
 * codebase.
 *
 * Chunking is deterministic: the wrapper iterates `pages` in input
 * order, slicing into windows of size `chunkSize` (clamped to the
 * server cap). Each chunk runs as one `runTool("create_pages", ...)`
 * call; chunks dispatch serially so the shared rate-limit bucket
 * and 429 backoff govern inter-chunk spacing without interleaving.
 *
 * **Failure semantics**:
 *
 * - First chunk fails → throw the SDK error verbatim. No
 *   `BatchCreateError` because there is no committed prefix.
 * - Later chunk fails → throw `BatchCreateError` whose
 *   `committedIds` carry the successfully-created prefix. The
 *   original SDK error is on `cause`.
 *
 * Mismatched response shape (server reports fewer ids than pages
 * sent in the chunk) is treated as a hard error and short-circuits
 * subsequent chunks. The committed prefix surface is still honest
 * — only ids the server actually returned are credited.
 */
export async function createPagesViaRunTool(
  input: CreatePagesViaRunToolInput
): Promise<CreatePagesViaRunToolResult> {
  const { client, parentDataSourceId, pages } = input

  if (pages.length === 0) {
    return { createdPageIds: [] }
  }

  const requestedChunkSize =
    input.chunkSize !== undefined && input.chunkSize > 0
      ? input.chunkSize
      : RUNTOOL_CREATE_PAGES_DEFAULT_CHUNK
  const chunkSize = Math.min(requestedChunkSize, RUNTOOL_CREATE_PAGES_MAX_CHUNK)

  const parent: RunToolCreatePagesParent = {
    type: "data_source_id",
    data_source_id: parentDataSourceId,
  }

  const createdPageIds: string[] = []

  for (let offset = 0; offset < pages.length; offset += chunkSize) {
    const chunk = pages.slice(offset, offset + chunkSize)
    // Convert each page's Notion REST property shape into the
    // flat SQLite-style map RunTool's create_pages consumes. The
    // empirical wire format (read-shape inspection of an existing
    // mentions fact via `query_data_sources` at PR-#538 review
    // time) showed selects/text as bare strings, dates as the 3-key
    // `date:<col>:start/:end/:is_datetime` expansion, and relations
    // as JSON-stringified URL arrays — see
    // `sqlite-properties.ts`'s docstring for the canonical table.
    // Without this conversion the server rejects the call with
    // `validation_error` because Notion REST shapes (`{ title:
    // [{ text: {...} }] }`, `{ relation: [{ id }] }`, etc.) are
    // structurally not the SQLite property values the endpoint
    // expects.
    const convertedChunk = chunk.map((page) => ({
      ...page,
      properties: convertNotionRestToSqliteProperties(
        page.properties,
        input.relationUrlBase
      ),
    }))
    let response
    try {
      response = await runTool(client, "create_pages", {
        parent,
        pages: convertedChunk,
      })
    } catch (err) {
      // First-chunk failure leaves no committed prefix to surface;
      // the SDK error propagates directly so the caller can branch
      // on status code (`isRunToolBatchCreatePartialFailure` is the
      // shape check the FactService fallback uses to decide whether
      // to retry the chunk per-page or to skip the prefix).
      if (createdPageIds.length === 0) throw err
      throw new BatchCreateError(createdPageIds, err)
    }

    // The server should return exactly `chunk.length` ids — one per
    // page in the same order. A mismatch is a structural protocol
    // violation, not a data-loss event the caller can recover
    // from blindly. Treat as a partial-commit error so callers
    // surface the honest prefix and can decide whether to retry the
    // missing tail.
    if (!response || !Array.isArray(response.pages)) {
      const cause = new Error(
        "RunTool create_pages: malformed response (missing pages array)"
      )
      if (createdPageIds.length === 0) throw cause
      throw new BatchCreateError(createdPageIds, cause)
    }

    for (const page of response.pages) {
      // Defensive — the response type pins `id: string` but a future
      // schema drift could surface a non-string id and we don't want
      // to credit a malformed value to the caller's idempotency index.
      if (typeof page?.id !== "string" || page.id.length === 0) {
        const cause = new Error(
          "RunTool create_pages: malformed response (page missing id)"
        )
        if (createdPageIds.length === 0) throw cause
        throw new BatchCreateError(createdPageIds, cause)
      }
      createdPageIds.push(page.id)
    }

    if (response.pages.length !== chunk.length) {
      const cause = new Error(
        `RunTool create_pages: response page count ${response.pages.length} ` +
          `does not match request chunk size ${chunk.length}`
      )
      throw new BatchCreateError(createdPageIds, cause)
    }
  }

  return { createdPageIds }
}

/**
 * Type guard for callers (e.g. `FactService.createBatchWithDedup`)
 * that need to distinguish a partial-commit failure from a full
 * failure when deciding how to fall back to per-page creates.
 */
export function isBatchCreateError(err: unknown): err is BatchCreateError {
  return err instanceof BatchCreateError
}
