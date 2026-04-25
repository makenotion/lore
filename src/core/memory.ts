/**
 * Memory CRUD + search — the core content store.
 *
 * Each memory is a Notion page in the Memories database. The page body
 * holds verbatim content. Page properties hold metadata for filtering
 * and categorization.
 *
 * Semantic search leverages Notion's existing embedding + vector search
 * pipeline: content written to Notion pages is automatically chunked,
 * embedded, and indexed. We search via the Notion search API.
 */

import type { Client } from "@notionhq/client"
import type {
  PageObjectResponse,
  CreatePageParameters,
  QueryDataSourceParameters,
} from "@notionhq/client"
import type {
  Memory,
  CreateMemoryInput,
  UpdateMemoryInput,
  SearchMemoriesInput,
  MemorySource,
  MemoryKind,
  MemoryStatus,
  MemoryConfidence,
  TaskState,
  DatabaseRef,
} from "../types.js"
import { buildMemoryProps } from "../notion/schema.js"
import { projectOrUnscopedFilter } from "../notion/filters.js"
import { decodeTextEntities } from "../notion/html-entities.js"
import {
  fixMemoryEncoding,
  type MemoryEncodingReport,
} from "./memory-encoding.js"
import { LruCache } from "./cache.js"
import {
  isFullPage,
  extractTitle,
  extractRichText,
  extractSelect,
  extractMultiSelect,
  extractRelationIds,
  extractDate,
} from "../notion/extractors.js"

/** Cap matches `DecisionService.idCache` (500); TTL is 60s (vs Decision's
 *  30s) because title text is cheaper-to-be-stale than decision lifecycle
 *  state — a stale title only shows the wrong label until the next write
 *  evicts the slot, whereas a stale decision status could mis-apply
 *  governance. Titles and `Kind=decision` pages share this pool. */
const TITLE_CACHE_MAX = 500
const TITLE_CACHE_TTL_MS = 60_000

/**
 * Every plain-text field that flows through the agent boundary and lands
 * in a Memory page. Run them through `decodeTextEntities` before writing
 * so doubly-encoded autosave input (`&amp;amp;`) resolves to plain text
 * and future similarity / embedding surfaces see consistent values.
 *
 * Coverage is deliberately explicit rather than derived from
 * `CreateMemoryInput` so a future plain-text field addition fails the
 * type-check here and forces a decision about whether to decode. If the
 * coverage ever diverges from `CreateMemoryInput`'s rich_text shape, the
 * drift stays visible in the compiler rather than in a downstream
 * similarity regression.
 */
function decodeMemoryTextFields(input: CreateMemoryInput): {
  title: string
  content: string
  alternatives: string | undefined
  consequences: string | undefined
  author: string | undefined
  agent: string | undefined
  keywords: string | undefined
  session: string | undefined
  blockedBy: string | undefined
  entity: string | undefined
} {
  return {
    title: decodeTextEntities(input.title),
    content: input.content ? decodeTextEntities(input.content) : "",
    alternatives:
      input.alternatives !== undefined ? decodeTextEntities(input.alternatives) : undefined,
    consequences:
      input.consequences !== undefined ? decodeTextEntities(input.consequences) : undefined,
    author: input.author !== undefined ? decodeTextEntities(input.author) : undefined,
    agent: input.agent !== undefined ? decodeTextEntities(input.agent) : undefined,
    keywords: input.keywords !== undefined ? decodeTextEntities(input.keywords) : undefined,
    session: input.session !== undefined ? decodeTextEntities(input.session) : undefined,
    blockedBy:
      input.blockedBy !== undefined ? decodeTextEntities(input.blockedBy) : undefined,
    entity: input.entity !== undefined ? decodeTextEntities(input.entity) : undefined,
  }
}

/**
 * Partial-update variant. Every field that might be passed gets the
 * decoder; `undefined` propagates so the update path can distinguish
 * "leave untouched" from "explicitly set to empty string".
 *
 * `UpdateMemoryInput` currently omits `author`, `agent`, and `session`
 * because those fields aren't exposed on the update path. If a future
 * change adds them, also extend this helper's return shape and the
 * corresponding `if (decoded.X !== undefined)` branches in `update()`.
 * The structural-literal typing keeps that coupling visible to the
 * type-checker rather than silent.
 */
function decodeUpdateTextFields(input: UpdateMemoryInput): {
  title: string | undefined
  content: string | undefined
  alternatives: string | undefined
  consequences: string | undefined
  keywords: string | undefined
  blockedBy: string | undefined
  entity: string | undefined
} {
  return {
    title: input.title !== undefined ? decodeTextEntities(input.title) : undefined,
    content: input.content !== undefined ? decodeTextEntities(input.content) : undefined,
    alternatives:
      input.alternatives !== undefined ? decodeTextEntities(input.alternatives) : undefined,
    consequences:
      input.consequences !== undefined ? decodeTextEntities(input.consequences) : undefined,
    keywords: input.keywords !== undefined ? decodeTextEntities(input.keywords) : undefined,
    blockedBy:
      input.blockedBy !== undefined ? decodeTextEntities(input.blockedBy) : undefined,
    entity: input.entity !== undefined ? decodeTextEntities(input.entity) : undefined,
  }
}

export class MemoryService {
  /**
   * `getTitleById` is the hot path for UUID→title resolution in
   * `render.ts:resolveTitles` and `lore-wake-up`. A 25-UUID wake-up without
   * this cache pays 25 Notion `pages.retrieve` calls even if the same IDs
   * were just resolved a few seconds earlier. The cache is keyed on the
   * memory id so `Kind = decision` pages (which also live in Memories DB)
   * cache alongside plain notes.
   *
   * Value type is `string | null` — null is a cacheable tombstone for
   * IDs that are archived, 404, or permission-scoped. Repeated wake-ups
   * over a stable ID set then stop hitting Notion for the missing ones
   * too, satisfying the "25-UUID wake-up twice → zero retrieve calls on
   * the second run" acceptance criterion.
   *
   * Stampede-safe via the `pendingTitles` map — N concurrent cold-start
   * misses on the same id share one `pages.retrieve`. `LruCache.getOrLoad`
   * doesn't fit here because it refuses to cache null returns (see
   * PF1-05 spec); we need to distinguish transient errors (don't cache)
   * from known-absent (cache as tombstone). When PF1-05 grows a
   * `cacheNegatives: true` option this class can collapse onto the shared
   * primitive — TODO tracked in PF1-09.
   *
   * **Read/write race handling via `writeEpoch`.** A single monotonic
   * counter is bumped by `update` and `archive` both *before* the delete
   * and *after* the post-write `set`. A reader captures `startEpoch` at
   * dispatch and only commits its cache value if `writeEpoch ===
   * startEpoch` at retrieve-resolution time. The sandwich bumps cover
   * two symmetric races:
   *
   * - Reader dispatched *before* the writer's first bump: retrieve
   *   resolves after the writer's second bump → commit skipped.
   * - Reader dispatched *during* the writer's in-flight `pages.update`
   *   (after first bump, before second): retrieve resolves after
   *   second bump → commit skipped.
   *
   * Using a single counter (rather than per-id) keeps memory bounded
   * over process lifetime at the cost of over-conservative skips: a
   * write to id Y invalidates any in-flight read for id X too. Acceptable
   * because writes are rare relative to reads and a skipped commit
   * just means the next caller re-fetches — never wrong, just
   * occasionally redundant. Notion's own read-after-write eventual
   * consistency creates a similar window that this guard cannot close
   * (the retrieve could observe pre-write state even after both bumps
   * resolve); TTL (60s) is the authoritative staleness bound there.
   *
   * **`pendingTitles` is epoch-agnostic by design.** Reader B that
   * subscribes to Reader A's pending promise returns A's resolved value
   * verbatim, even when the epoch advanced between A's dispatch and
   * B's arrival. A's epoch check correctly skips the cache commit, so
   * the authoritative post-write value stays in `titleCache` — but B's
   * specific call sees A's stale return. One-shot staleness per caller
   * (the *next* read on any id finds fresh in the cache), consistent
   * with the over-conservative epoch tradeoff documented above.
   */
  private readonly titleCache = new LruCache<string, string | null>(
    TITLE_CACHE_MAX,
    TITLE_CACHE_TTL_MS,
  )
  private readonly pendingTitles = new Map<string, Promise<string | null>>()
  /**
   * Monotonic counter bumped on any title-affecting write. See the
   * class docstring for the sandwich-bump discipline — this is the
   * mechanism that closes both the dispatched-before-write and
   * dispatched-during-write races.
   */
  private writeEpoch = 0

  constructor(
    private client: Client,
    private db: DatabaseRef
  ) {}

  private bumpWriteEpoch(): void {
    this.writeEpoch++
  }

  async create(input: CreateMemoryInput): Promise<Memory> {
    // Decode at the write boundary so doubly-encoded values from the
    // autosave/markdown path land in Notion as plain text. Idempotent: a
    // clean value passes through unchanged. Covers every plain-text
    // field that flows through the agent boundary — title, content body,
    // and the rich_text fields that downstream similarity/embedding
    // surfaces (P2-03, P3-03, P3-04) will read.
    const decoded = decodeMemoryTextFields(input)

    // Create the page with properties only
    const page = await this.client.pages.create({
      parent: { type: "database_id", database_id: this.db.databaseId },
      properties: buildMemoryProps({
        title: decoded.title,
        projectIds: input.projectIds,
        topicId: input.topicId,
        source: input.source ?? "manual",
        kind: input.kind,
        status: input.status,
        confidence: input.confidence,
        reviewBy: input.reviewBy,
        decidedAt: input.decidedAt,
        supersedesIds: input.supersedesIds,
        affectsIds: input.affectsIds,
        alternatives: decoded.alternatives,
        consequences: decoded.consequences,
        author: decoded.author,
        agent: decoded.agent,
        tags: input.tags,
        keywords: decoded.keywords,
        session: decoded.session,
        taskState: input.taskState,
        blockedBy: decoded.blockedBy,
        entity: decoded.entity,
      }),
    })

    // Write content via markdown API
    if (decoded.content) {
      await this.client.pages.updateMarkdown({
        page_id: page.id,
        type: "insert_content",
        insert_content: { content: decoded.content },
      })
    }

    return this.pageToMemory(page as PageObjectResponse, decoded.content ?? "")
  }

  async getById(id: string): Promise<Memory> {
    const [page, md] = await Promise.all([
      this.client.pages.retrieve({ page_id: id }),
      this.client.pages.retrieveMarkdown({ page_id: id }),
    ])
    return this.pageToMemory(page as PageObjectResponse, md.markdown)
  }

  /**
   * Read a memory's `Title` property without fetching its markdown body.
   * Single `pages.retrieve` round-trip on a cold cache; hot-path hits
   * return synchronously from the in-process title cache. Used by
   * render-layer resolvers that only need a human-readable label for a
   * page ID. Returns `null` on not-found / archived / permission errors
   * so callers can fall through to the raw ID with a `(?)` hint. Works
   * across `Kind = decision` and every other memory kind — both live in
   * the Memories DB.
   *
   * **Caching discipline** — distinguishes two null-result regimes:
   * - *Known absent* (partial-page response, `archived: true`): cached as
   *   a null tombstone. Repeated wake-ups over the same id set stop
   *   re-fetching the same missing ids within the TTL window.
   * - *Transient failure* (network error, 429, 5xx): the exception is
   *   swallowed and null is returned to the caller, but the value is
   *   NOT cached. The next caller retries. Rate-limit / network blips
   *   therefore degrade to a single `(?)` render, not a 60-second
   *   stretch of `(?)` labels.
   */
  async getTitleById(id: string): Promise<string | null> {
    // Fast path: cache hit (including a cached null tombstone).
    const cached = this.titleCache.get(id)
    if (cached !== undefined) return cached

    // Stampede dedup: N concurrent cold-start misses share one fetch.
    const inflight = this.pendingTitles.get(id)
    if (inflight) return inflight

    // Capture the write epoch at dispatch so the loader's commit-time
    // check can detect any concurrent `update` / `archive` (on this id
    // or another) that sandwich-bumped around the retrieve.
    const startEpoch = this.writeEpoch
    const promise = this.fetchTitleAndCache(id, startEpoch)
    this.pendingTitles.set(id, promise)
    // Clear only if this is still the slot's in-flight promise. A
    // subsequent call that arrives after resolution will find the value
    // in `titleCache` and bypass the pending map entirely.
    void promise.finally(() => {
      if (this.pendingTitles.get(id) === promise) {
        this.pendingTitles.delete(id)
      }
    })
    return promise
  }

  private async fetchTitleAndCache(
    id: string,
    startEpoch: number,
  ): Promise<string | null> {
    let page: Awaited<ReturnType<typeof this.client.pages.retrieve>>
    try {
      page = await this.client.pages.retrieve({ page_id: id })
    } catch {
      // Transient (network / 429 / 5xx). Don't cache — next caller retries.
      return null
    }

    const extractResolved = (): string | null => {
      if (!isFullPage(page) || page.archived) return null
      const title = extractTitle(page.properties["Title"])
      return title || null
    }
    const resolved = extractResolved()

    // Epoch check: if any `update` / `archive` sandwich-bumped the
    // counter while this retrieve was in flight, a writer has already
    // installed the authoritative post-write value (or tombstone).
    // Refuse to commit our (now-stale) value. Return it to the caller
    // anyway — reads should not fail just because a concurrent write
    // happened. Using a single process-wide counter means a write to
    // id Y also invalidates an in-flight read for id X; over-conservative
    // by design (next read re-fetches), keeps memory bounded.
    if (this.writeEpoch === startEpoch) {
      this.titleCache.set(id, resolved)
    }
    return resolved
  }

  /** Drop the in-process title cache. Used by tests and by the
   *  cross-service `clearServiceCaches()` helper. Also drops any
   *  in-flight title fetches so test fixtures start clean. */
  clearTitleCache(): void {
    this.titleCache.clear()
    this.pendingTitles.clear()
    this.writeEpoch = 0
  }

  async update(id: string, input: UpdateMemoryInput): Promise<Memory> {
    // Same decode-at-write discipline as `create`: encoded titles /
    // content / alternatives / consequences flowing in from re-saves of
    // autosave-rendered transcripts must land in Notion clean. Without
    // this, `update` would write encoded text around the freshly-decoded
    // rows `create` produces, re-opening the bug class PF1-06 closes.
    const decoded = decodeUpdateTextFields(input)
    const props: Record<string, unknown> = {}

    if (decoded.title !== undefined) {
      // Pre-write epoch bump: any `fetchTitleAndCache` already in flight
      // for ANY id will see an advanced epoch at commit time and skip
      // its set. The paired post-write bump below closes the
      // dispatched-during-write window. Then evict the current cache
      // entry; the post-write `set` installs the authoritative value.
      this.bumpWriteEpoch()
      this.titleCache.delete(id)
      props["Title"] = { title: [{ text: { content: decoded.title } }] }
    }
    if (input.projectIds) {
      props["Project"] = { relation: input.projectIds.map((id) => ({ id })) }
    }
    if (input.topicId) {
      props["Topic"] = { relation: [{ id: input.topicId }] }
    }
    if (input.tags) {
      props["Tags"] = {
        multi_select: input.tags.map((t) => ({ name: t })),
      }
    }
    if (decoded.keywords !== undefined) {
      props["Keywords"] = {
        rich_text: [{ text: { content: decoded.keywords } }],
      }
    }
    if (input.kind) {
      props["Kind"] = { select: { name: input.kind } }
    }
    if (input.status) {
      props["Status"] = { select: { name: input.status } }
    }
    if (input.confidence) {
      props["Confidence"] = { select: { name: input.confidence } }
    }
    // `null` explicitly clears a date; `undefined` leaves it untouched.
    if (input.reviewBy !== undefined) {
      props["Review By"] = input.reviewBy
        ? { date: { start: input.reviewBy } }
        : { date: null }
    }
    if (input.decidedAt !== undefined) {
      props["Decided At"] = input.decidedAt
        ? { date: { start: input.decidedAt } }
        : { date: null }
    }
    if (input.supersedesIds) {
      props["Supersedes"] = { relation: input.supersedesIds.map((id) => ({ id })) }
    }
    if (input.affectsIds) {
      props["Affects"] = { relation: input.affectsIds.map((id) => ({ id })) }
    }
    if (decoded.alternatives !== undefined) {
      props["Alternatives"] = {
        rich_text: [{ text: { content: decoded.alternatives } }],
      }
    }
    if (decoded.consequences !== undefined) {
      props["Consequences"] = {
        rich_text: [{ text: { content: decoded.consequences } }],
      }
    }
    if (input.taskState) {
      props["Task State"] = { select: { name: input.taskState } }
    }
    if (decoded.blockedBy !== undefined) {
      props["Blocked By"] = {
        rich_text: [{ text: { content: decoded.blockedBy } }],
      }
    }
    if (decoded.entity !== undefined) {
      props["Entity"] = {
        rich_text: [{ text: { content: decoded.entity } }],
      }
    }

    if (Object.keys(props).length > 0) {
      await this.client.pages.update({
        page_id: id,
        // Cast needed: we're building update props dynamically
        properties: props as CreatePageParameters["properties"],
      })
    }

    if (decoded.content) {
      await this.client.pages.updateMarkdown({
        page_id: id,
        type: "replace_content_range",
        replace_content_range: {
          content: decoded.content,
          content_range: "full_page",
          allow_deleting_content: true,
        },
      })
    }

    const updated = await this.getById(id)
    // Write-through: we just read the authoritative post-update state, so
    // cache it. Closes the stale-read window a delete-only flow leaves
    // open — a concurrent `getTitleById` between delete and update could
    // have re-cached the pre-update title via the default 60s TTL.
    // Mirror of `TopicService.getOrCreate`'s post-write `nameCache.set`.
    //
    // Post-write epoch bump pairs with the pre-write bump above (the
    // "sandwich") so readers whose retrieve was dispatched *during* the
    // in-flight `pages.update` — after the pre-bump but before the final
    // set — also have their stale commits suppressed. Without this,
    // only readers dispatched *before* the pre-bump would be guarded.
    if (decoded.title !== undefined) {
      this.titleCache.set(id, updated.title || null)
      this.bumpWriteEpoch()
    }
    return updated
  }

  /**
   * Run the HTML-entity decode pass against this service's Memories DB.
   * Thin wrapper over the standalone migration function in
   * `memory-encoding.ts` so the CLI doesn't need to reach past the
   * service boundary for the client + DatabaseRef.
   */
  async fixEncoding(
    options: { dryRun?: boolean } = {}
  ): Promise<MemoryEncodingReport> {
    return fixMemoryEncoding(this.client, this.db, options)
  }

  async archive(id: string): Promise<void> {
    // Sandwich bump: pre-write guards readers dispatched *before* the
    // archive; post-write guards readers whose retrieve straddles the
    // Notion round-trip. Evict first so a concurrent read during the
    // round-trip doesn't serve the pre-archive title, install a null
    // tombstone after so subsequent reads short-circuit, and bump
    // again so any in-flight retrieve that resolves after the tombstone
    // skips its commit.
    this.bumpWriteEpoch()
    this.titleCache.delete(id)
    await this.client.pages.update({
      page_id: id,
      archived: true,
    })
    this.titleCache.set(id, null)
    this.bumpWriteEpoch()
  }

  async list(opts?: {
    projectId?: string
    topicId?: string
    source?: MemorySource
    kind?: MemoryKind
    status?: MemoryStatus
    reviewBefore?: string
    tags?: string[]
    limit?: number
    since?: string
    until?: string
    /**
     * When false, skip the per-page markdown fetch and return memories with
     * `content: ""`. Use for index-tier listings (decisions, wake-up
     * summaries) and list views that render only title/date/tags — avoids
     * N+1 `retrieveMarkdown` calls.
     */
    includeContent?: boolean
    /**
     * When false, scope project queries to memories explicitly linked to the
     * given project, excluding repo-wide/unscoped entries.
     */
    includeUnscoped?: boolean
    /**
     * Notion timestamp field to sort by. Defaults to `last_edited_time`
     * (general-purpose "most recently touched"). Pass `created_time` for
     * "most recently created" ordering — e.g. latest-digest lookup.
     */
    sortBy?: "created_time" | "last_edited_time"
    /**
     * Opaque cursor from a previous page's `nextCursor`. When provided,
     * continues enumeration from where that page ended. The filter/sort
     * must match the originating query — Notion returns the cursor's
     * contents under the assumption the query shape is unchanged.
     */
    startCursor?: string
  }): Promise<{ items: Memory[]; nextCursor?: string }> {
    const filters: Array<Record<string, unknown>> = []

    if (opts?.projectId) {
      filters.push(
        opts.includeUnscoped === false
          ? { property: "Project", relation: { contains: opts.projectId } }
          : projectOrUnscopedFilter(opts.projectId)
      )
    }
    if (opts?.topicId) {
      filters.push({
        property: "Topic",
        relation: { contains: opts.topicId },
      })
    }
    if (opts?.source) {
      filters.push({
        property: "Source",
        select: { equals: opts.source },
      })
    }
    if (opts?.kind) {
      filters.push({
        property: "Kind",
        select: { equals: opts.kind },
      })
    }
    if (opts?.status) {
      filters.push({
        property: "Status",
        select: { equals: opts.status },
      })
    }
    if (opts?.reviewBefore) {
      filters.push({
        property: "Review By",
        date: { on_or_before: opts.reviewBefore },
      })
    }
    if (opts?.tags?.length) {
      if (opts.tags.length === 1) {
        filters.push({ property: "Tags", multi_select: { contains: opts.tags[0] } })
      } else {
        filters.push({
          or: opts.tags.map((t) => ({
            property: "Tags",
            multi_select: { contains: t },
          })),
        })
      }
    }
    if (opts?.since) {
      filters.push({
        timestamp: "created_time",
        created_time: { on_or_after: opts.since },
      })
    }
    if (opts?.until) {
      filters.push({
        timestamp: "created_time",
        created_time: { before: opts.until },
      })
    }

    const filter =
      filters.length > 1
        ? { and: filters }
        : filters.length === 1
          ? filters[0]
          : undefined

    const response = await this.client.dataSources.query({
      data_source_id: this.db.dataSourceId,
      filter: filter as QueryDataSourceParameters["filter"],
      sorts: [{ timestamp: opts?.sortBy ?? "last_edited_time", direction: "descending" }],
      page_size: Math.min(opts?.limit ?? 20, 100),
      start_cursor: opts?.startCursor,
    })

    const pages = response.results.filter(isFullPage) as PageObjectResponse[]
    const nextCursor =
      response.has_more && response.next_cursor ? response.next_cursor : undefined

    if (opts?.includeContent === false) {
      return {
        items: pages.map((page) => this.pageToMemory(page, "")),
        nextCursor,
      }
    }

    const items = await Promise.all(
      pages.map(async (page) => {
        const md = await this.client.pages.retrieveMarkdown({ page_id: page.id })
        return this.pageToMemory(page, md.markdown)
      })
    )
    return { items, nextCursor }
  }

  /**
   * Semantic search for memories using Notion's search API.
   *
   * Content stored in Notion is automatically embedded and indexed by
   * Notion's vector search pipeline. This search leverages that index.
   *
   * Notion's `search` endpoint returns results ranked by relevance when no
   * `sort` parameter is passed. Passing `sort` switches to recency ordering
   * and demotes the query to a lexical filter — which defeats the point.
   * We pay for a larger `page_size` instead so the client-side filter to
   * the Memories database has enough headroom when the workspace contains
   * other pages that happen to match the query tokens.
   */
  async search(input: SearchMemoriesInput): Promise<Memory[]> {
    const response = await this.client.search({
      query: input.query,
      filter: { property: "object", value: "page" },
      page_size: 100,
    })

    // Filter results to only pages in our Memories database. Notion SDK v5
    // returns two parent-type shapes depending on how the page was created /
    // what the workspace has since been upgraded to: classic `database_id`
    // parents, and data-source-backed `data_source_id` parents. Match either
    // against our `DatabaseRef`.
    const memoryPages = (response.results as PageObjectResponse[]).filter((page) => {
      if (!("parent" in page)) return false
      const parent = page.parent
      if (parent.type === "database_id") {
        return parent.database_id === this.db.databaseId
      }
      if (parent.type === "data_source_id") {
        return parent.data_source_id === this.db.dataSourceId
      }
      return false
    })

    // Apply additional filters (project, topic, tags)
    let filtered = memoryPages
    if (input.projectId) {
      filtered = filtered.filter((page) => {
        const ids = extractRelationIds(page.properties["Project"])
        return ids.length === 0 || ids.includes(input.projectId!)
      })
    }
    if (input.topicId) {
      filtered = filtered.filter((page) => {
        const ids = extractRelationIds(page.properties["Topic"])
        return ids.includes(input.topicId!)
      })
    }
    if (input.tags?.length) {
      filtered = filtered.filter((page) => {
        const pageTags = extractMultiSelect(page.properties["Tags"])
        return input.tags!.some((t) => pageTags.includes(t))
      })
    }

    // Cap at the caller's requested limit before paying the per-page markdown
    // round-trip. `client.search()` ignores our limit and returns up to
    // `page_size`, so we trim here.
    const capped = filtered.slice(0, input.limit ?? 10)

    if (input.includeContent === false) {
      return capped.map((page) => this.pageToMemory(page, ""))
    }

    return Promise.all(
      capped.map(async (page) => {
        const md = await this.client.pages.retrieveMarkdown({ page_id: page.id })
        return this.pageToMemory(page, md.markdown)
      })
    )
  }

  private pageToMemory(page: PageObjectResponse, content?: string): Memory {
    return pageToMemory(page, content)
  }
}

/**
 * Convert a Notion page object to a `Memory` domain type. Pure function —
 * exported for unit testing. The hardened extractors guarantee graceful
 * defaults for pages that pre-date any schema addition: a pre-migration
 * page returns `kind: "note"`, `status: "informational"`, etc.
 */
export function pageToMemory(page: PageObjectResponse, content?: string): Memory {
  const props = page.properties
  const topicIds = extractRelationIds(props["Topic"])

  // Read `Task State` only when the column exists *and* a select is set.
  // `extractSelect` falls back when the column is missing — fine for
  // pre-migration pages — but we want a true `null` (not `"open"`) on
  // every non-task memory so downstream code can branch on the field.
  const taskStateProp = props["Task State"]
  const taskState =
    taskStateProp && taskStateProp.type === "select" && taskStateProp.select
      ? (taskStateProp.select.name as TaskState)
      : null

  return {
    id: page.id,
    title: extractTitle(props["Title"]),
    projectIds: extractRelationIds(props["Project"]),
    topicId: topicIds[0] ?? null,
    source: extractSelect(props["Source"], "manual") as MemorySource,
    // Decision-related columns. Pre-migration pages default gracefully
    // via the hardened extractors — no backfill required.
    kind: extractSelect(props["Kind"], "note") as MemoryKind,
    status: extractSelect(props["Status"], "informational") as MemoryStatus,
    confidence: extractSelect(props["Confidence"], "certain") as MemoryConfidence,
    reviewBy: extractDate(props["Review By"]),
    decidedAt: extractDate(props["Decided At"]),
    supersedesIds: extractRelationIds(props["Supersedes"]),
    affectsIds: extractRelationIds(props["Affects"]),
    alternatives: extractRichText(props["Alternatives"]),
    consequences: extractRichText(props["Consequences"]),
    author: extractRichText(props["Author"]),
    agent: extractRichText(props["Agent"]),
    tags: extractMultiSelect(props["Tags"]),
    keywords: extractRichText(props["Keywords"]),
    session: extractRichText(props["Session"]),
    content: content ?? "",
    createdAt: page.created_time,
    updatedAt: page.last_edited_time,
    taskState,
    blockedBy: extractRichText(props["Blocked By"]),
    entity: extractRichText(props["Entity"]),
  }
}
