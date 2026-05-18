// ABOUTME: Owns the MemoryService API for memory CRUD, search, review, topic keys, comparisons, and promotion.
// ABOUTME: Edit when a memory capability crosses the service boundary or collaborator wiring changes.

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
import { APIErrorCode, isNotionClientError } from "@notionhq/client"
import type { PageObjectResponse, QueryDataSourceParameters } from "@notionhq/client"
import type {
  Memory,
  MemoryWithoutContent,
  CreateMemoryInput,
  UpdateMemoryInput,
  SearchMemoriesInput,
  SearchExplain,
  MemoryKind,
  MemoryStatus,
  MemoryScopeContext,
  DatabaseRef,
} from "../types.js"
import { EXPIRING_SOON_DAYS, MS_PER_DAY } from "../types.js"
import { MEMORY_PROPS } from "../notion/schema.js"
import { projectOrUnscopedFilter } from "../notion/filters.js"
import { fixMemoryEncoding, type MemoryEncodingReport } from "./memory-encoding.js"
import { normalizeAgents, type AgentNormalizationReport } from "./agent-normalization.js"
import {
  backfillSynopses,
  type BackfillOptions,
  type BackfillReport,
} from "./synopsis-backfill.js"
import { LruCache } from "./cache.js"
import { todayUtc } from "./task.js"
import {
  isFullPage,
  isLiveFullPage,
  extractTitle,
  extractRichText,
} from "../notion/extractors.js"
import { resolveFeatureFlags, type LoreFeatureFlags } from "../feature-flags.js"
import { MemoryPinned } from "./memory-pinned.js"
import { MemoryConfidence } from "./memory-confidence.js"
import {
  cleanupOrphanExclusionFilter,
  withCleanupOrphanExclusion,
} from "./memory-filters.js"
import {
  MemoryTopicKey,
  type FindByTopicKeyInput,
  type RekeyTopicKeyInput,
  type RekeyTopicKeyResult,
  type RekeyValidationResult,
  type TopicKeyUpsertInput,
  type TopicKeyUpsertResult,
} from "./memory-topic-key.js"
import {
  MemoryCompare,
  type RecordComparedInput,
  type RecordComparedResult,
} from "./memory-compare.js"
import { MemorySearch, type SearchPagesResult } from "./memory-search.js"
import { MemoryMapper } from "./memory-mapper.js"
import { MemoryCreate, type MemoryCreateResult } from "./memory-create.js"
import { MemoryList, type ListMemoriesOptions } from "./memory-list.js"
import { MemoryReview } from "./memory-review.js"
import { MemoryUpdate } from "./memory-update.js"

export { matchesDefaultScope } from "./memory-scope.js"
export {
  MemoryPinCapExceededError,
  MemoryReadOnlyError,
  clampPinnedPriority,
  pinnedBlockAudienceMatches,
  sanitizeMemoryTitleForMessage,
} from "./memory-pinned.js"
export {
  RekeyAuditError,
  computePromotionAdvisory,
  PROMOTE_BODY_LENGTH_THRESHOLD,
  PROMOTE_REVISION_THRESHOLD,
} from "./memory-topic-key.js"
export type { PromotionAdvisory } from "./memory-topic-key.js"
export {
  COMPARE_NOTES_MAX_CHARS,
  CompareDispatchPartialFailureError,
  RecordComparedPartialWriteError,
  appendCompareDispatchLedgerEntry,
  appendCompareNote,
  buildCompareDispatchLedgerEntry,
  compareDispatchKey,
  encodeCompareNotesRichText,
  hasCompareDispatchLedgerEntry,
  hasMatchingCompareNote,
  recordContradiction,
  recordSupersedence,
} from "./memory-compare.js"
export type {
  CompareDispatchLedgerEntry,
  CompareDispatchServices,
  CompareNoteEntry,
  CompareNotesTextChunk,
  RecordComparedResult,
} from "./memory-compare.js"
export {
  HYBRID_FALLBACK_THRESHOLD,
  SEMANTIC_SEARCH_MAX_PAGES,
  tieBreakingRrfCompare,
} from "./memory-search.js"
export type { RrfEntry } from "./memory-search.js"
export {
  REVIEW_TERMINAL_STATUSES,
  isNotReviewTerminalStatus,
  reviewTerminalStatusExclusionFilters,
} from "./memory-review-state.js"
export {
  extractMemoryScope,
  hydrateMemoryRelationProperties,
  hydrateMemoryRelationPropertiesForPages,
  pageToMemory,
} from "./memory-mapper.js"
export { MemoryCreatePartialFailureError } from "./memory-create.js"
export type { MemoryCreateResult } from "./memory-create.js"
export type { ListMemoriesOptions } from "./memory-list.js"
export { MemoryReviewAuditError, MemoryReviewStateError } from "./memory-review.js"
export { MemoryUpdatePartialFailureError, PartialUpdateError } from "./memory-update.js"

/** Cap matches `DecisionService.idCache` (500); TTL is 60s (vs Decision's
 * 30s) because title text is cheaper-to-be-stale than decision lifecycle
 * state — a stale title only shows the wrong label until the next write
 * evicts the slot, whereas a stale decision status could mis-apply
 * governance. Titles and `Kind=decision` pages share this pool. */
const TITLE_CACHE_MAX = 500
const TITLE_CACHE_TTL_MS = 60_000

/**
 * Server-side filter clause defining the proposed-memory review inbox.
 * Single source of truth so every consumer — the count primitive
 * (`MemoryService.countProposed`), the wake-up inbox section
 * (`loadWakeUpData`), the inbox-list CLI (`lore inbox list`) —
 * composes the same filter literal and never drifts.
 *
 * The clause is `Status = proposed AND Kind != decision`:
 *
 * - `Status: { equals: "proposed" }` — the inbox state.
 * - `Kind: { does_not_equal: "decision" }` — `proposed` is also a
 * normal in-flight `decision` lifecycle state per
 * `ACTIVE_DECISION_STATUSES`; counting those rows would conflate
 * governance decisions with auto-extracted learnings. Mirrors the
 * `excludeKinds: ["decision"]` posture in the memory near-duplicate
 * probe.
 *
 * Notion's `does_not_equal` is permissive on null — a row with no
 * `Kind` column set (a hand-edited or unmigrated page) passes the
 * filter, since it is by definition not `decision`. Same posture as
 * the `reviewTerminalStatusExclusionFilters` default-recall filter.
 */
export function proposedMemoryFilter(): { and: Array<Record<string, unknown>> } {
  return {
    and: [
      { property: MEMORY_PROPS.STATUS, select: { equals: "proposed" } },
      { property: MEMORY_PROPS.KIND, select: { does_not_equal: "decision" } },
    ],
  }
}

export class MemoryService {
  private readonly features: LoreFeatureFlags

  /**
   * `getTitleById` is the hot path for UUID→title resolution in
   * `render.ts:resolveTitles` and `lore-context action='wake-up'`. A 25-UUID wake-up without
   * this cache pays 25 Notion `pages.retrieve` calls even if the same IDs
   * were just resolved a few seconds earlier. The cache is keyed on the
   * memory id so `Kind = decision` pages (which also live in Memories DB)
   * cache alongside plain notes.
   *
   * Value type is `string | null` — null is a cacheable tombstone for
   * IDs that are archived, 404, or permission-scoped. Repeated wake-ups
   * over a stable ID set then stop hitting Notion for the missing ones
   * too, satisfying the "25-UUID wake-up twice → zero retrieve calls on
   * the second run" acceptance criterion. Tombstones are committed via
   * `LruCache.getOrLoad`'s `cacheNegatives: true` option, which
   * distinguishes a known-absent loader return (`null`) from a transient
   * error (loader throws). Errors clear the slot without caching, so a
   * 429 / 5xx blip still re-dispatches on the next read.
   *
   * Stampede-safe via `LruCache.getOrLoad`: N concurrent cold-start
   * misses on the same id share one `pages.retrieve` — the second and
   * later callers await the first loader's promise.
   *
   * **Read/write race handling.** Writers (`update`, `archive`) wrap
   * their `pages.update` round-trip in `titleCache.delete(id)` (pre-write,
   * to flush any in-flight loader's pending slot) and `titleCache.set(id,
   * resolved)` (post-write, to install the authoritative new value).
   * `LruCache.set` itself drops `pending[key]` so a stale loader's
   * `getOrLoad` commit is suppressed by the identity guard at
   * `cache.ts:` — closing both the dispatched-before-write and
   * dispatched-during-write races without a per-service epoch counter.
   * The race-protection invariant lives in `LruCache.set`, so this
   * service does not need a parallel write epoch to suppress stale
   * loader commits.
   *
   * **One-shot staleness per concurrent reader.** A reader whose
   * loader's `pages.retrieve` straddles the writer's `delete → update →
   * set` window resolves with the pre-write page (reads do not block
   * on writes). The reader's `getOrLoad` commit is suppressed by the
   * identity guard, so the writer's post-write value stays cached.
   * The reader's caller still sees the stale value once; the next
   * read on any id finds fresh in the cache. This is the same
   * tradeoff `LruCache.getOrLoad` applies to every consumer — readers
   * never fail because of a concurrent write.
   */
  private readonly titleCache = new LruCache<string, string | null>(
    TITLE_CACHE_MAX,
    TITLE_CACHE_TTL_MS,
    { cacheNegatives: true }
  )

  /**
   * Resolved scope context for this process. Threaded into every
   * default-retrieval path so default reads exclude narrow-scope
   * rows whose `scopeKey` does not match the reader's matching
   * identity slot. A missing context (default `{}`) means
   * "no narrow scopes ever surface" — only broadcast scopes plus
   * rows without a declared scope. Production callers populate this
   * in `initServices` from environment variables, the active project,
   * and the auth identity; tests default to empty.
   */
  private scopeCtx: MemoryScopeContext = {}
  private readonly mapper: MemoryMapper
  private readonly pinned: MemoryPinned
  private readonly confidence: MemoryConfidence
  private readonly topicKey: MemoryTopicKey
  private readonly compare: MemoryCompare
  private readonly searcher: MemorySearch
  private readonly lister: MemoryList
  private readonly reviewer: MemoryReview
  private readonly updater: MemoryUpdate
  private readonly creator: MemoryCreate

  /**
   * Whether default-retrieval paths should apply the scope filter.
   * Opt-in: a caller that constructs `MemoryService` without an
   * explicit `scopeCtx` argument gets the no-scope retrieval shape
   * (no scope clause, no expiry clause). Production
   * `initServicesFromConfig` always passes a context (possibly
   * empty), turning the filter on for every real-vault read.
   * Tests construct services without scope context and stay on the
   * no-scope shape unless they explicitly opt in via
   * `setScopeContext`.
   */
  private scopeFilterEnabled = false

  constructor(
    private client: Client,
    private db: DatabaseRef,
    scopeCtx?: MemoryScopeContext,
    options?: { features?: LoreFeatureFlags }
  ) {
    this.features = options?.features ?? resolveFeatureFlags()
    this.mapper = new MemoryMapper(client)
    this.pinned = new MemoryPinned(
      client,
      db,
      () => this.scopeCtx,
      () => this.scopeFilterEnabled,
      (pages, includeContent) => this.materializeMemories(pages, includeContent)
    )
    this.confidence = new MemoryConfidence(client, db, (page, content) =>
      this.pageToMemory(page, content)
    )
    this.topicKey = new MemoryTopicKey(client, db, this.features, {
      create: (input) => this.create(input),
      getById: (id) => this.getById(id),
      pageToMemory: (page, content) => this.pageToMemory(page, content),
      titleCache: this.titleCache,
    })
    this.compare = new MemoryCompare(client)
    this.lister = new MemoryList(
      client,
      db,
      this.features,
      () => this.scopeCtx,
      () => this.scopeFilterEnabled,
      (page, content) => this.pageToMemory(page, content),
      (id) => this.getPropertiesById(id)
    )
    this.searcher = new MemorySearch(
      client,
      db,
      this.features,
      () => this.scopeCtx,
      () => this.scopeFilterEnabled,
      (pages, includeContent) => this.materializeMemories(pages, includeContent)
    )
    this.reviewer = new MemoryReview(client, (id) => this.getPropertiesById(id))
    this.updater = new MemoryUpdate(client, {
      preflightPinnedUpdate: (id, input) => this.pinned.preflightUpdate(id, input),
      invalidatePinnedCountCache: () => this.pinned.invalidateCountCache(),
      deleteTitleCache: (id) => this.titleCache.delete(id),
      setTitleCache: (id, title) => this.titleCache.set(id, title),
      getById: (id) => this.getById(id),
    })
    this.creator = new MemoryCreate(client, db, this.features, {
      duplicateLister: this.lister,
      preflightPinnedCreate: (input) => this.pinned.preflightCreate(input),
      invalidatePinnedCountCache: () => this.pinned.invalidateCountCache(),
      pageToMemory: (page, content) => this.pageToMemory(page, content),
    })
    if (scopeCtx) {
      this.scopeCtx = scopeCtx
      this.scopeFilterEnabled = true
    }
  }

  /**
   * Replace the scope context after construction. Used by tests and
   * by the `initServices` seam when scope context resolution depends
   * on Notion calls that can't run synchronously in the constructor.
   * Calling this enables the scope filter on subsequent reads.
   */
  setScopeContext(ctx: MemoryScopeContext): void {
    this.scopeCtx = ctx
    this.scopeFilterEnabled = true
  }

  /** Snapshot of the active scope context. Read-only — callers
   * cannot mutate it. Threaded into MCP audit responses so an
   * operator triaging "why don't I see this row?" can confirm
   * which identity slots resolved. */
  getScopeContext(): Readonly<MemoryScopeContext> {
    return this.scopeCtx
  }

  private isMemoryPageParent(parent: PageObjectResponse["parent"]): boolean {
    if (parent.type === "database_id") {
      return parent.database_id === this.db.databaseId
    }
    if (parent.type === "data_source_id") {
      return parent.data_source_id === this.db.dataSourceId
    }
    return false
  }

  private requireLiveMemoryPage(page: unknown, id: string): PageObjectResponse {
    if (!isFullPage(page as Parameters<typeof isFullPage>[0])) {
      throw new Error(`Memory ${id} did not resolve to a full page.`)
    }
    const fullPage = page as PageObjectResponse
    if (fullPage.archived) {
      throw new Error(`Memory ${id} is archived.`)
    }
    if (!this.isMemoryPageParent(fullPage.parent)) {
      throw new Error(`Memory ${id} is not in the Memories database.`)
    }
    return fullPage
  }

  async create(input: CreateMemoryInput): Promise<Memory> {
    return (await this.createWithResult(input)).memory
  }

  async createWithResult(input: CreateMemoryInput): Promise<MemoryCreateResult> {
    return this.creator.createWithResult(input)
  }

  async getById(id: string): Promise<Memory> {
    const [page, md] = await Promise.all([
      this.client.pages.retrieve({ page_id: id }),
      this.client.pages.retrieveMarkdown({ page_id: id }),
    ])
    return await this.pageToMemory(page as PageObjectResponse, md.markdown)
  }

  /**
   * Read a memory's properties without fetching its markdown body. Sibling
   * of `getById` that skips the `pages.retrieveMarkdown` round-trip —
   * issued exclusively for callers that need the property-tier shape
   * (`confidenceScore`, `lastReferencedAt`, `createdAt`, `confidence`,
   * `id`) and never read the body. The contradiction-decrement path
   * (`lore-fact action='invalidate'` → `decrementConfidence`) is the
   * canonical caller: every fact invalidation otherwise pays one extra
   * `retrieveMarkdown` round-trip for content the decrement algebra
   * never touches.
   *
   * The returned `Memory.content` is `""`. Callers that need the body
   * should use `getById` instead, or hydrate via `materializeContent`
   * after a `getPropertiesById` if both shapes are needed.
   *
   * The ID must point at a live page in the configured Memories database.
   * Accessible pages from sibling databases and archived memory rows are
   * rejected before they can masquerade as vault-wide memories via the
   * backward-compatible parser defaults.
   */
  async getPropertiesById(id: string): Promise<Memory> {
    const page = await this.client.pages.retrieve({ page_id: id })
    return await this.pageToMemory(this.requireLiveMemoryPage(page, id), "")
  }

  /**
   * Batched property-only reads. Issues one `pages.retrieve` per
   * **distinct** input ID via `Promise.all` and skips the
   * `pages.retrieveMarkdown` round-trip — `touchOnRead` reads
   * `confidenceScore` / `lastReferencedAt` / `confidence` / `createdAt`
   * off the in-memory row, all of which live in the page's properties
   * bag. The returned `Memory` shapes carry `content: ""`; callers
   * needing the body must use `getById` instead.
   *
   * The properties-only posture matters because the touch-on-read
   * wiring in `lore-query action='ask'` routes through here —
   * fetching markdown bodies the caller will discard would
   * double the Notion call budget on every ask response with cited
   * source memories.
   *
   * **Output ordering.** Returned memories preserve the input order of
   * their FIRST occurrence. Repeated IDs are deduped at the boundary
   * (collapsed to one fetch), so a caller passing `["a", "a"]` gets
   * `[Memory{a}]` once. Missing IDs (404 / archived / permission
   * errors) resolve to `null` and are filtered out, so a 404 on the
   * row at input position 2 of `[a, b, c]` returns `[Memory{a},
   * Memory{c}]` — output positions are 1:1 with input positions only
   * after the dedup + drop-failures filter has been applied.
   *
   * Callers that already hold materialized `Memory[]` (`recall` /
   * `search` / `expand` / wake-up loaders) should pass them directly
   * to `touchOnRead` instead of re-fetching here.
   */
  async getManyById(ids: ReadonlyArray<string>): Promise<Memory[]> {
    const seen = new Set<string>()
    const distinct: string[] = []
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      distinct.push(id)
    }
    const results = await Promise.all(
      distinct.map(async (id) => {
        try {
          const page = await this.client.pages.retrieve({ page_id: id })
          return await this.pageToMemory(this.requireLiveMemoryPage(page, id), "")
        } catch {
          return null
        }
      })
    )
    return results.filter((m): m is Memory => m !== null)
  }

  async findByTopicKey(input: FindByTopicKeyInput): Promise<Memory | null> {
    return await this.topicKey.findByTopicKey(input)
  }

  async findByPromotionSourceKey(sourceKey: string): Promise<Memory | null> {
    const trimmed = sourceKey.trim()
    if (trimmed.length === 0) return null

    let cursor: string | undefined
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: withCleanupOrphanExclusion({
          property: MEMORY_PROPS.PROMOTION_SOURCE_KEY,
          rich_text: { equals: trimmed },
        }) as QueryDataSourceParameters["filter"],
        page_size: 100,
        start_cursor: cursor,
      })
      const pages = response.results.filter(isLiveFullPage)
      for (const page of pages) {
        const memory = await this.pageToMemory(page, "")
        const hydrated = await this.materializeContent(memory)
        if (hydrated.content.trim().length === 0) continue
        return hydrated
      }
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor !== undefined)

    return null
  }

  async upsertByTopicKey(input: TopicKeyUpsertInput): Promise<TopicKeyUpsertResult> {
    return await this.topicKey.upsertByTopicKey(input)
  }

  async validateRekey(input: RekeyTopicKeyInput): Promise<RekeyValidationResult> {
    return await this.topicKey.validateRekey(input)
  }

  async rekeyTopicKey(input: RekeyTopicKeyInput): Promise<RekeyTopicKeyResult> {
    return await this.topicKey.rekeyTopicKey(input)
  }

  /**
   * Record an inbox-review verdict on a proposed memory. The
   * caller is the human or authorized agent deciding whether the
   * auto-extracted learning belongs in the shared vault or not.
   *
   * Two verdicts:
   *
   * - **`approve`** — flips `Status` from `proposed` to `accepted`.
   * The row enters default recall on the next read pass.
   * - **`reject`** — flips `Status` from `proposed` to `rejected`.
   * The row stays out of default recall (the default-exclude
   * filters `proposed` only, but recall-shaped consumers should
   * continue ignoring `rejected` via their own status filtering).
   *
   * Both verdicts append a `## Reviewed (YYYY-MM-DD)` audit block to
   * the page body recording the verdict, the reviewer, the timestamp,
   * and an optional reason. Audit-block prefix differs from the
   * topic-key re-key prefix (`## Re-keyed`) so a future memory-history
   * renderer can distinguish lifecycle events from identity events
   * without parsing body text. The block is what a future operator
   * sees when inspecting why a row landed in its current state.
   *
   * **Status guard**: a non-proposed row throws
   * `MemoryReviewStateError`. The verdicts only make sense on the
   * inbox-state — applying them to an already-accepted row would be
   * a no-op masquerading as a real review event. Operators who want
   * to flip a non-proposed row's status use
   * `lore-memory action='update' status='<value>'` directly.
   *
   * **Property write FIRST, audit-block append SECOND** — same
   * partial-state posture as `rekeyTopicKey`. A property-write
   * success followed by an audit-write failure leaves the load-
   * bearing status flip in place; the cosmetic audit trail is what
   * gets lost. A retry observes `Status !== "proposed"` and rejects
   * with `MemoryReviewStateError`, surfacing the partial state to
   * the operator. The audit-failure path throws `MemoryReviewAuditError`
   * (a distinct subclass of `Error`) so callers can branch on
   * `instanceof` and disambiguate "review didn't happen" from
   * "review happened but audit is missing." Two distinct call sites
   * inside the audit-block envelope can fail and produce that same
   * partial state: the body fetch (`pages.retrieveMarkdown`, which
   * runs AFTER the status flip so guard-rejection paths skip the
   * round-trip entirely) and the body write (`pages.updateMarkdown`,
   * the actual audit append). Both share one `try/catch` and one
   * `MemoryReviewAuditError` envelope — the recovery contract is
   * identical (next retry rejects with `MemoryReviewStateError`),
   * so callers don't need to disambiguate which sub-step failed.
   *
   * **Concurrent reviews**: two operators racing on the same memory
   * can both observe `Status: proposed` and both call `recordReview`.
   * The second-to-write wins: the property update is per-request
   * atomic, so the row ends up with whichever verdict landed last.
   * Both audit blocks land on the body via separate `updateMarkdown`
   * calls — the trailing call's body read happens after the leading
   * call's write, so audit blocks accumulate without clobbering. A
   * future contributor adding stricter conflict detection would
   * route through a per-memory lock similar to the autosave-learning
   * gate; not needed today given low review concurrency.
   */
  async recordReview(input: {
    memoryId: string
    verdict: "approve" | "reject"
    reviewer: string
    reason?: string
  }): Promise<{ memory: Memory; previousStatus: MemoryStatus }> {
    return this.reviewer.recordReview(input)
  }

  async materializeContent(memory: Memory): Promise<Memory> {
    const md = await this.client.pages.retrieveMarkdown({ page_id: memory.id })
    return { ...memory, content: md.markdown }
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
   * - *Known absent* (archived full page, 404 `ObjectNotFound`,
   * `RestrictedResource`): `fetchTitle` returns `null` and `getOrLoad`
   * commits a null tombstone. Repeated wake-ups over the same id set
   * stop re-fetching the same missing ids within the TTL window.
   * - *Transient failure* (401 / 429 / 5xx / network / unknown errors):
   * `fetchTitle` re-throws, `getOrLoad` rejects without caching, and
   * the try/catch below converts the rejection into `null` for the
   * caller. The slot is NOT cached, so the next caller retries.
   * Rate-limit / network blips therefore degrade to a single `(?)`
   * render, not a 60-second stretch of `(?)` labels. 401 is
   * deliberately not tombstoned — the auth-refresh rationale lives
   * on `fetchTitle`.
   */
  async getTitleById(id: string): Promise<string | null> {
    // Stampede dedup, TTL, LRU, negative-tombstone caching, and the
    // identity-guard that suppresses stale-loader commits during
    // concurrent writes are all owned by `LruCache.getOrLoad`.
    //
    // The loader throws on transient errors so `getOrLoad` propagates
    // the rejection without caching (no poisoned tombstone for a
    // 429 / network blip). We catch here and return null to preserve
    // `getTitleById`'s "never throws on read" public contract — the
    // caller sees a single `(?)` render and the next call retries.
    try {
      return await this.titleCache.getOrLoad(id, () => this.fetchTitle(id))
    } catch {
      return null
    }
  }

  private async fetchTitle(id: string): Promise<string | null> {
    // Distinguishing "known absent" from "transient" is load-bearing
    // under `cacheNegatives: true`:
    //
    // - Returning `null` commits a tombstone via `getOrLoad` so the
    // next read short-circuits without a Notion call.
    // - Throwing routes through `getOrLoad`'s rejection path, which
    // clears the pending slot without caching anything; the next
    // read re-fetches.
    //
    // Tombstone the id-level absence cases (404 ObjectNotFound,
    // RestrictedResource) and the archived-page case (Notion returns
    // a full PageObjectResponse with `archived: true`). Every other
    // error class re-throws and is treated as transient. Without
    // this, every wake-up over a stable id-set would re-issue
    // `pages.retrieve` for every dead id, paced by the outbound
    // rate-limit bucket — silently violating the "25-UUID wake-up
    // twice → zero retrieve calls on the second run" contract this
    // class advertises.
    //
    // `Unauthorized` (401) is deliberately NOT tombstoned: the
    // auth-refreshing SDK wrapper already attempts one auth refresh
    // on 401 and only surfaces the original error when refresh is
    // unavailable or the retry still fails. By the time a 401
    // reaches us it's a broad token-level signal, not a per-page
    // absence — caching it would poison every id resolved during a
    // bad-auth window for up to 60s after recovery.
    let page: Awaited<ReturnType<typeof this.client.pages.retrieve>>
    try {
      page = await this.client.pages.retrieve({ page_id: id })
    } catch (err) {
      if (
        isNotionClientError(err) &&
        (err.code === APIErrorCode.ObjectNotFound ||
          err.code === APIErrorCode.RestrictedResource)
      ) {
        return null
      }
      throw err
    }
    if (!isFullPage(page) || page.archived) return null
    const title = extractTitle(page.properties[MEMORY_PROPS.TITLE])
    return title || null
  }

  /** Drop the in-process title cache. Used by tests and by the
   * cross-service `clearServiceCaches()` helper. `LruCache.clear`
   * also drops any in-flight `getOrLoad` pending slots so test
   * fixtures start clean. */
  clearTitleCache(): void {
    this.titleCache.clear()
    // clear the pinned-count cache too on the
    // cross-service `clearServiceCaches()` reset so test fixtures
    // see a fresh count between cases.
    this.pinned.clearCountCache()
  }

  async update(id: string, input: UpdateMemoryInput): Promise<Memory> {
    return this.updater.update(id, input)
  }

  async fixEncoding(
    options: { dryRun?: boolean; projectId?: string } = {}
  ): Promise<MemoryEncodingReport> {
    return fixMemoryEncoding(this.client, this.db, {
      ...options,
      features: this.features,
    })
  }

  /**
   * Run the agent-identity normalization pass against this service's
   * Memories DB. Same shape as `fixEncoding` — thin wrapper over the
   * standalone migration function so the CLI
   * doesn't need to reach past the service boundary for the client +
   * DatabaseRef.
   */
  async normalizeAgents(
    options: { dryRun?: boolean; projectId?: string } = {}
  ): Promise<AgentNormalizationReport> {
    return normalizeAgents(this.client, this.db, options)
  }

  /**
   * Run the synopsis-backfill pass against this service's Memories DB.
   * Thin wrapper over `backfillSynopses` so the CLI dispatcher reaches
   * the migration through the service boundary like every other
   * encoding / normalization migration.
   */
  async backfillSynopses(options: BackfillOptions): Promise<BackfillReport> {
    return backfillSynopses(this.client, this.db, options)
  }

  async archive(id: string): Promise<void> {
    // Pre-write delete: clear the stored value and drop any in-flight
    // `getOrLoad` pending slot. Post-write `set(id, null)` installs a
    // null tombstone (under `cacheNegatives: true`, subsequent reads
    // short-circuit on the tombstone instead of re-fetching). The
    // post-write `set` also drops the pending slot a second time, so a
    // reader whose retrieve was dispatched after the pre-write delete
    // and resolves with the pre-archive page (Notion returns archived
    // pages with `archived: true` populated) has its commit suppressed
    // by the identity guard.
    this.titleCache.delete(id)
    await this.client.pages.update({
      page_id: id,
      archived: true,
    })
    this.titleCache.set(id, null)
  }

  /**
   * Update `Last Referenced At` to today and lazily seed / decay / bump
   * `Confidence Score` for the given memories. Updates dispatch in
   * parallel via `Promise.all`. Each update is its own `pages.update`
   * (Notion has no batch-update primitive); the rate-limit middleware
   * handles backpressure.
   *
   * Short-circuits per-row when `lastReferencedAt === today` AND the
   * row's `confidenceScore` is already non-null — no Notion call. The
   * check is structural; concurrent reads in the same session may both
   * miss the short-circuit and both fire writes (Notion accepts in
   * arrival order, final state is consistent).
   *
   * Failure handling: any per-row failure routes through `onError` and
   * degrades to a no-op for that row. The caller's read result is
   * always preserved; `touchOnRead` is advisory, never blocking.
   *
   * Bump-once-per-day: a memory cited 50 times in one session bumps
   * exactly once — same gate as the column write.
   *
   * Decay-then-bump on stale rows: when `lastReferencedAt` is non-null
   * and not today, the helper first applies `decayConfidenceScore`
   * against the staleness accrued since the last touch, THEN applies
   * `bumpConfidenceScore`. Write-realized lazy decay — every mutation
   * realizes the time-decay since the last mutation. RRF reads the
   * stored value as-is via `confidenceFactor`.
   *
   * Seed-decay-then-bump on never-scored rows: when
   * `confidenceScore === null`, the row predates the confidence-score
   * column (or is otherwise unmigrated). The decay anchor is
   * `createdAt` — the row's been
   * "neglected" since creation. Seed → decay against `createdAt` →
   * bump matches what the bulk migration writes for the same row, so
   * a read-before-migrate path and a migrate-before-read path
   * converge to the same stored value.
   */
  async touchOnRead(
    memories: ReadonlyArray<
      Pick<
        Memory,
        "id" | "confidence" | "confidenceScore" | "lastReferencedAt" | "createdAt"
      >
    >,
    opts?: {
      today?: string
      onError?: (memoryId: string, error: unknown) => void
    }
  ): Promise<void> {
    return this.confidence.touchOnRead(memories, opts)
  }

  /**
   * Apply a contradiction decrement to a single memory. Reads the
   * current score, lazily seeds from the categorical when null,
   * realizes any accrued decay, applies `decrementConfidenceScore`,
   * writes back. Single round-trip. Returns the new score.
   *
   * Decay-then-decrement on stale rows parallels touchOnRead's
   * decay-then-bump: a stale row's stored value reflects the score at
   * last-touch, not at today, so realizing decay before the
   * contradiction keeps the negative signal proportional to current
   * trust. A row at 0.9 with `lastReferencedAt` 200 days before today
   * has effective `0.9 * 0.99^140 ≈ 0.220` (140 stale days), so the
   * halving lands at `≈ 0.110` — not 0.45 as it would be without the
   * realize step.
   *
   * Seed-decay-then-decrement on never-scored rows mirrors
   * `touchOnRead` — same convergence guarantee that a contradiction
   * landed against an unmigrated row and one landed against a
   * migrated row reach the same effective current value before
   * decrementing.
   *
   * The `Last Referenced At` write on contradiction is deliberate:
   * contradiction IS a form of cite (negative cite), and treating it
   * as neglect would let a heavily-contradicted memory simultaneously
   * decay, producing double-counted negative signal. Bumping
   * `Last Referenced At` resets the decay clock; the explicit
   * decrement provides the negative signal.
   */
  async decrementConfidence(
    memory: Pick<
      Memory,
      "id" | "confidence" | "confidenceScore" | "lastReferencedAt" | "createdAt"
    >,
    opts?: { today?: string; compareNotes?: string }
  ): Promise<number> {
    return this.confidence.decrementConfidence(memory, opts)
  }

  /**
   * Symmetric audit-marker write for `lore-memory action='compare'`.
   * Issues up to two `pages.update` calls in parallel,
   * one per side, each writing BOTH the `Compared With` relation
   * (with the counterpart's id added) AND the `Compare Notes`
   * rich_text (with a fresh NDJSON entry appended). Notion has no
   * multi-page atomic primitive, so the two writes share a
   * `Promise.allSettled`; partial-success is surfaced through the
   * structured `RecordComparedPartialWriteError` so callers can
   * self-heal.
   *
   * **Failure model.** Three settle outcomes:
   *
   * - **Both writes succeed.** Returns `{ wroteA, wroteB }` reflecting
   * which sides this call actually issued (versus which were skipped
   * via per-side idempotency).
   * - **Both writes reject.** Throws the first underlying rejection
   * directly. Per-side idempotency makes a same-input retry safe — a
   * fresh snapshot will see neither audit entry and write both
   * sides cleanly. No structured error here because there is no
   * partial-success state to surface.
   * - **Exactly one side rejects.** Throws
   * `RecordComparedPartialWriteError` carrying `result: {wroteA,
   * wroteB}` (the partial-success outcome), `failedSide` (the side
   * whose `pages.update` rejected), and `cause` (the underlying SDK
   * error). The MCP handler uses this to drive a single-shot
   * reload-and-retry path: the survivor's audit entry is now in
   * Notion, so a fresh `getById` snapshot lets the retry's per-side
   * idempotency check skip the survivor and write only the missing
   * side.
   *
   * Using `Promise.all` here would reject on the first failure —
   * discarding the concurrent success and leaving the caller unable
   * to distinguish "nothing wrote" from "A wrote, B failed." A naive
   * retry against a stale snapshot would then write the already-
   * landed side a second time, duplicating the NDJSON audit line.
   * The `Promise.allSettled` + structured-error contract preserves
   * the partial-success signal so retries can be precise.
   *
   * **Per-side idempotency.** Each side's write is gated locally by
   * `hasMatchingCompareNote(side.compareNotes, {target, verdict,
   * affected})`. If the loaded snapshot already carries a matching
   * entry, that side's `pages.update` is SKIPPED. This is what makes
   * a partial-failure recovery safe: when one side succeeded on a
   * prior call and the other failed, a re-run of `recordCompared`
   * with the same inputs writes only the missing side and leaves the
   * already-present side untouched (no duplicate audit line, no
   * duplicated `Compared With` relation). The returned
   * `RecordComparedResult` tells the caller which sides actually
   * landed a write, so the MCP handler can distinguish "fresh
   * judgment" from "recovery completion" in its response text.
   *
   * **Caller contract.**
   *
   * - The caller MUST have already validated overflow against
   * `COMPARE_NOTES_MAX_CHARS` by running `appendCompareNote` on
   * each side as a preflight inside `handleCompare`. When
   * per-side idempotency skips a write, the preflight cost
   * already incurred is wasted but harmless; the alternative —
   * moving the preflight inside `recordCompared` — would couple
   * the dispatch path to the audit-marker layout.
   * - The caller is responsible for the OUTER pair-scoped gate that
   * decides whether to invoke this method at all. For symmetric
   * verdicts the gate must check BOTH sides; for asymmetric
   * verdicts the gate's single-side check is correct because the
   * destructive dispatch (decrement + fact) is the dominant
   * concern there.
   *
   * **Compared With set semantics.** `Compared With` is a Notion
   * `single_property` self-relation; the API treats the relation list
   * as a set, so re-adding an id Notion already has is a no-op at the
   * data layer. The compose step still de-dupes locally so a fresh
   * verdict on a pair that has already been judged doesn't grow the
   * relation list with a stale duplicate before the API collapses it.
   *
   * **Why two calls, not one.** Notion's relation column points only
   * from the side that names the counterpart. Writing only A → B
   * leaves B's `Compared With` empty, so an operator inspecting B in
   * the Notion UI sees no signal that the pair was judged. Symmetric
   * writes preserve audit visibility on both pages.
   */
  async recordCompared(input: RecordComparedInput): Promise<RecordComparedResult> {
    return this.compare.recordCompared(input)
  }

  /**
   * Paginating async iterator over every non-archived memory in this
   * service's Memories DB, optionally scoped to a single project. Yields
   * `Memory` objects (with empty `content`) in created-time-ascending
   * order so the migration's plan output is deterministic across runs.
   *
   * Two consumers: `runBuildConfidenceScoresMigration` (the baseline
   * backfill) and `MemoryService.confidenceStats` (the
   * `lore status` confidence-distribution summary). Both want a
   * walker over every non-archived memory with no body fetch and the
   * same optional project scope, so they share one iterator rather
   * than re-deriving the pagination algebra. Exposing a
   * `Memory[]`-shaped iterator (rather than raw `PageObjectResponse[]`)
   * keeps callers off the SDK type surface and lets them consume
   * `Memory.createdAt` / `Memory.confidence` / `Memory.confidenceScore`
   * via the same extractor pipeline every other read path uses.
   *
   * Archived rows are filtered client-side: Notion exposes the archived
   * flag on the returned page object, and the existing read paths
   * (`agent-normalization`, `memory-encoding`) skip via `page.archived`.
   * Backfilling a score onto a row whose page is archived is wasted
   * work — it surfaces in no read path and would be silently lost on
   * the next un-archive's full re-write.
   *
   * Scoped by `projectId`: when omitted, the iterator walks every memory
   * in the vault (vault-wide migration). When set, scopes via the same
   * `projectOrUnscopedFilter` shape `MemoryService.list` uses, so a
   * project-scoped run also covers repo-wide unscoped rows that belong
   * to no project.
   */
  async *listAllForBackfill(
    opts: {
      projectId?: string
    } = {}
  ): AsyncGenerator<Memory, void, void> {
    yield* this.confidence.listAllForBackfill(opts)
  }

  /**
   * Single `pages.update` writing both `Confidence Score` and
   * `Last Referenced At`. Distinct from `touchOnRead` because the
   * migration sets `Last Referenced At` to the memory's `createdAt`
   * (sliced to YYYY-MM-DD), not today — the migration's contract is
   * "treat creation as the implicit first reference," so the row's
   * decay anchor IS its creation date.
   *
   * Caller is responsible for clamping `score`. Production callers
   * (`runBuildConfidenceScoresMigration`) hand off scores produced by
   * `decayConfidenceScore`, which clamps internally.
   */
  async applyBackfillScore(
    memoryId: string,
    score: number,
    lastReferencedAt: string
  ): Promise<void> {
    return this.confidence.applyBackfillScore(memoryId, score, lastReferencedAt)
  }

  /**
   * Aggregate `Confidence Score` distribution across non-archived
   * memories — the data the `lore status` confidence-summary line
   * surfaces (DEFERRED-04). Memory-side parallel of `taskStats`'s
   * closure-rate aggregation: pure read, no body fetch, optional
   * project scope.
   *
   * Walks via `listAllForBackfill` so we share one paginated iterator
   * with the `--build-confidence-scores` migration. Aggregates in a
   * single pass:
   *
   * - `totalMemories` — every non-archived row the iterator yields.
   * - `scoredMemories` — `Memory.confidenceScore !== null`. On a
   * vault that hasn't run the backfill this stays at zero and the
   * renderer collapses the `(avg …, … below threshold)` suffix off
   * the line accordingly.
   * - `averageScore` — arithmetic mean across scored rows. Returns
   * `0` when no scored rows exist; the renderer suppresses the avg
   * surface in that case via the `scoredMemories === 0` guard, so
   * the placeholder zero never reaches the operator.
   * - `belowThreshold` — count of scored rows whose stored value is
   * strictly below `CONFIDENCE_DISPLAY_THRESHOLD` (the same gate
   * the trust indicator and Stale Confidence wake-up use, so all
   * three surfaces agree on what "below threshold" means).
   *
   * Cost is one paginated walk over the (project-scoped) Memories
   * data source — the same shape `--build-confidence-scores`
   * already pays per `lore migrate` invocation. The migration is
   * operator-pulled and infrequent; `lore status` is on-demand and
   * now pays this walk on every invocation, so per-status cost
   * scales linearly in vault size (≈ N/100 round-trips). Acceptable
   * on the operator-facing status surface but worth a follow-up
   * (cache, `--confidence` flag, or `lore status` skip) if a vault
   * grows past the point where the walk feels slow.
   *
   * The walk is **internally sequential** — `listAllForBackfill`
   * is a paginated async iterator that awaits each `dataSources.query`
   * before issuing the next. The shared rate-limited client
   * ( default `concurrency = 3`) bounds
   * total in-flight calls but does not parallelize this iterator;
   * its pagination is what dominates wall-clock on large vaults.
   * The CLI fan-out runs `confidenceStats` parallel to `taskStats`
   * at the top level, but the pagination inside this method stays
   * serial. Read together with the per-invocation-cost note above:
   * the `max(taskStats, confidenceStats)` claim at the call site
   * holds for the orchestration, not for any single round-trip.
   *
   * `averageScore` is an arithmetic mean computed in floating-point;
   * accumulation across long pagination can leave the result off by
   * one ULP from the "true" mean. The renderer truncates at two
   * decimals, so this is invisible in practice but worth noting if
   * a future caller compares two stats reports for exact equality.
   *
   * Vaults that haven't migrated to the `Confidence Score` column
   * work fine: every yielded `Memory.confidenceScore` is `null`, so
   * `scoredMemories` / `averageScore` / `belowThreshold` all stay
   * at zero.
   */
  async confidenceStats(opts: { projectId?: string } = {}): Promise<{
    totalMemories: number
    scoredMemories: number
    averageScore: number
    belowThreshold: number
  }> {
    return this.confidence.confidenceStats(opts)
  }

  /**
   * Operator-facing counters for the `lore status` expiring/expired
   * scoped-memory surface.
   *
   * Returns three counts:
   * - `expired`: rows whose `Expires At < today` and whose page is
   * not archived. Already invisible to default reads — surfaced
   * here so an operator can run `lore-memory action='archive'` to
   * actually clean them up.
   * - `expiringSoon`: rows with `Expires At` in the inclusive window
   * `[today, today + EXPIRING_SOON_DAYS]`. The "expiring this
   * week" triage signal — agents whose memories are about to drop
   * out of recall get an audit nudge.
   * - `narrowScopeOutOfContext`: count of rows whose Scope Kind is
   * one of the narrow kinds (`user` / `agent` / `role` / `session`
   * / `run` / `environment`) AND whose Scope Key does NOT match
   * the current resolved scope context. This is the "session-
   * scoped notes outliving their session" signal — the load-
   * bearing acceptance criterion the scope columns exist to make
   * visible.
   *
   * Single paginated walk via `listAllForBackfill`, project-scoped
   * when `projectId` is provided. Counts archived rows out (the
   * walker already filters them).
   */
  async expiringScopedStats(opts: { projectId?: string } = {}): Promise<{
    expired: number
    expiringSoon: number
    narrowScopeOutOfContext: number
  }> {
    const today = todayUtc()
    const horizonMs =
      Date.parse(today) +
      // EXPIRING_SOON_DAYS is the days-ahead horizon. We need it in
      // ms to compare YYYY-MM-DD strings; render the shifted Date
      // back to the same format via `.toISOString().slice(0, 10)`.
      EXPIRING_SOON_DAYS * MS_PER_DAY
    const horizon = new Date(horizonMs).toISOString().slice(0, 10)
    let expired = 0
    let expiringSoon = 0
    let narrowScopeOutOfContext = 0
    const ctx = this.scopeCtx
    for await (const memory of this.listAllForBackfill(opts)) {
      const scope = memory.scope ?? null
      if (scope === null) continue
      const expiresAt = scope.expiresAt
      if (expiresAt !== null) {
        if (expiresAt < today) {
          expired += 1
        } else if (expiresAt <= horizon) {
          expiringSoon += 1
        }
      }
      const kind = scope.kind
      if (kind === null) continue
      if (kind === "team" || kind === "project" || kind === "global") continue
      const expected =
        kind === "user"
          ? ctx.userId
          : kind === "agent"
            ? ctx.agent
            : kind === "role"
              ? ctx.role
              : kind === "session"
                ? ctx.session
                : kind === "run"
                  ? ctx.run
                  : kind === "environment"
                    ? ctx.environment
                    : undefined
      if (expected === undefined || scope.key !== expected) {
        narrowScopeOutOfContext += 1
      }
    }
    return { expired, expiringSoon, narrowScopeOutOfContext }
  }

  /**
   * Count non-archived `Kind != decision` memories whose `Status =
   * proposed` — the proposed-memory review inbox primitive backing
   * the `lore status` and `lore-context action='status'` inbox-count
   * surfaces. Reports pending proposed-memory counts by
   * project/source/agent.
   *
   * Returns the total count plus per-source and per-agent breakdowns
   * so the operator can see at a glance where pending review pressure
   * is coming from. Source is a closed enum (`MemorySource`); the
   * surface bucket is `string` because rows with a missing `Source`
   * column bucket as `"unknown"` (matching the `Agent` `"unknown"`
   * fallback below) rather than collapsing into the historical
   * `extractSelect` `"manual"` default — that default is correct for
   * `pageToMemory`'s in-memory shape but would silently inflate the
   * `manual` bucket on the operator-facing inbox line. Agent is a
   * free-form `rich_text` string canonicalized at write time via
   * `canonicalizeAgentName`, so the keys reflect whatever historical
   * strings remain in the vault.
   *
   * **`Kind != decision` is server-side**, applied via Notion's
   * `select.does_not_equal: "decision"`. `ACTIVE_DECISION_STATUSES`
   * explicitly includes `proposed` as a normal in-flight decision
   * lifecycle state — counting those rows as inbox memories would
   * conflate governance with auto-extracted learnings awaiting
   * review and inflate the operator's review pressure on every
   * vault that uses `lore-decision action='create'` with
   * `status: "proposed"`. The exclusion matches the
   * `excludeKinds: ["decision"]` posture that the memory near-duplicate
   * probe already uses for the same memories-vs-decisions split.
   *
   * Server-side filter:
   *
   * Status = proposed
   * AND Kind != decision
   * AND (when scoped) (Project contains projectId OR Project is_empty)
   *
   * Direct `client.dataSources.query` rather than `MemoryService.list`
   * because the inbox surface only needs the property tuple
   * (Status / Kind / Source / Agent) and never the markdown body —
   * paying for `pageToMemory`'s per-row body fetch on every `lore
   * status` would scale linearly with the inbox depth for zero
   * rendered benefit. Same posture as `TaskService.countClosedSince`
   * and `FactService.countByPredicateRaw`.
   *
   * Archived rows filtered client-side via `isLiveFullPage` — Notion's
   * `archived` flag lives on `PageObjectResponse`, not as a DB column,
   * so a `dataSources.query` cannot exclude it server-side. Archived
   * proposals are not part of the live inbox.
   *
   * Vault-scoping matches `MemoryService.list`: when `projectId` is
   * omitted the project clause is dropped entirely, so the counter
   * walks every project's proposals (the surface used when no
   * `--project` flag is supplied to `lore status`). When `projectId`
   * is supplied, repo-wide unscoped proposals surface in the count
   * via the OR clause — same posture as recall.
   */
  async countProposed(opts: { projectId?: string } = {}): Promise<{
    total: number
    bySource: Record<string, number>
    byAgent: Record<string, number>
  }> {
    // Spread `proposedMemoryFilter()`'s `.and` clauses onto the outer
    // filter array (rather than nesting the helper as a sub-`and`)
    // so the composed shape is flat — `{ and: [status, kind,
    // project] }` instead of `{ and: [{ and: [status, kind] }, project] }`.
    // Notion accepts both, but a flat compound is conventional and
    // easier to debug in API logs.
    //
    // Resurfaced cleanup-orphan exclusion. The proposed-
    // inbox slice in `loadWakeUpData` uses `MemoryService.list({ status:
    // "proposed", excludeKinds: ["decision"] })`, which already excludes
    // the sentinel via the `MemoryService.list` server-side filter.
    // The matching count surface here must apply the same exclusion or
    // the wake-up renderer prints a count that doesn't match its row
    // list — `loadWakeUpData` documents the slice/count match as an
    // invariant. Appended at the end of the flat filter array so the
    // existing `[status, kind, project]` order in API logs is unchanged
    // for the common case.
    const filters: Array<Record<string, unknown>> = [...proposedMemoryFilter().and]
    if (opts.projectId) filters.push(projectOrUnscopedFilter(opts.projectId))
    filters.push(cleanupOrphanExclusionFilter())
    const filter = filters.length > 1 ? { and: filters } : filters[0]

    let total = 0
    const bySource: Record<string, number> = {}
    const byAgent: Record<string, number> = {}
    let cursor: string | undefined
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        page_size: 100,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isLiveFullPage)) {
        total += 1
        const sourceProp = page.properties[MEMORY_PROPS.SOURCE]
        const sourceKey =
          sourceProp && sourceProp.type === "select" && sourceProp.select
            ? sourceProp.select.name
            : "unknown"
        bySource[sourceKey] = (bySource[sourceKey] ?? 0) + 1
        const agentRaw = extractRichText(page.properties[MEMORY_PROPS.AGENT]).trim()
        const agentKey = agentRaw.length > 0 ? agentRaw : "unknown"
        byAgent[agentKey] = (byAgent[agentKey] ?? 0) + 1
      }
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)
    return { total, bySource, byAgent }
  }

  async queryStaleConfidence(opts: {
    projectId?: string
    limit: number
    today: string
    includeProposed?: boolean
  }): Promise<Memory[]> {
    return this.confidence.queryStaleConfidence(opts)
  }

  async listPinnedBlocks(opts: {
    projectId?: string
    limit?: number
    today?: string
    readerContext?: MemoryScopeContext
    includeContent?: boolean
    audienceFilter?: boolean
    includeOutOfScope?: boolean
  }): Promise<Memory[]> {
    return this.pinned.listPinnedBlocks(opts)
  }

  async countPinnedBlocks(opts: { bypassCache?: boolean } = {}): Promise<number> {
    return this.pinned.countPinnedBlocks(opts)
  }

  /**
   * Project-grouped paginated walk for `lore conflicts scan`.
   * Returns `Memory[][]` aligned by index with the input `projectIds` —
   * `result[i]` holds every non-archived memory whose `Project` relation
   * contains `projectIds[i]`.
   *
   * **Why a dedicated method, not a re-shaped `list`.** `list` is
   * recall-shaped: capped at 100 rows, sorted by edit time, scoped via
   * `projectOrUnscopedFilter` so unscoped repo-wide rows surface alongside
   * project-scoped ones. The conflict scanner needs the opposite: every
   * row in a project (paginate to exhaustion), strict-scoped (an unscoped
   * repo-wide row is NOT a candidate for "conflicts in project X"
   * because it doesn't carry X's identity), and per-project grouping so
   * `findConflictCandidates` runs in-project and the post-list
   * dedup can collapse cross-project duplicates.
   *
   * **Strict-scoped, not `projectOrUnscopedFilter`-shaped.** The
   * conflict-candidate generator (`findConflictCandidates`) intersects
   * `projectIds` per-pair internally, so an unscoped row paired against
   * a project-scoped row would fail that intersection anyway and
   * surface zero candidates. Including unscoped rows here would only
   * inflate the per-project memory list (and the post-list
   * `findConflictCandidates` O(n²) pair work) for zero useful output.
   *
   * **Archived rows.** Filtered client-side via `page.archived` —
   * `dataSources.query` cannot filter on Notion's page-metadata
   * `archived` flag (it lives on `PageObjectResponse`, not as a DB
   * column). Same posture as `findByTopicKey` and `listAllForBackfill`.
   *
   * **Body fetch is opt-in via `includeBodies`.** The candidate
   * generator reads only `title` / `keywords` / `tags` / `projectIds`
   * — body content is irrelevant to lexical similarity. The CLI's
   * `--include-bodies` flag is the only consumer that needs full
   * markdown; default off keeps the scan an O(N) properties walk
   * rather than an O(N) properties walk + O(N) per-page
   * `retrieveMarkdown` round-trips. When the flag is on, body
   * fetches fan out via `Promise.all` per project, governed by the
   * shared rate-limited client.
   *
   * **Progress signal.** When `onProgress` is provided, the helper
   * fires it once per Notion page received with the project label,
   * 1-based page index, and running total so the CLI can stream
   * `Scanning project 'core-app': page 3, 230 memories...` to stderr
   * without coupling to `console.error`.
   */
  async listForScan(opts: {
    projectIds: string[]
    /** Optional human-readable labels aligned by index with `projectIds`
     * for `onProgress` rendering; defaults to the project ID when omitted. */
    projectLabels?: string[]
    includeBodies?: boolean
    onProgress?: (info: {
      projectId: string
      projectLabel: string
      pageIndex: number
      runningTotal: number
    }) => void
  }): Promise<Memory[][]> {
    const labels = opts.projectLabels ?? opts.projectIds
    const result: Memory[][] = []

    for (let i = 0; i < opts.projectIds.length; i++) {
      const projectId = opts.projectIds[i]!
      const label = labels[i] ?? projectId

      const pages: PageObjectResponse[] = []
      let cursor: string | undefined = undefined
      let pageIndex = 0
      do {
        const response = await this.client.dataSources.query({
          data_source_id: this.db.dataSourceId,
          // Resurfaced cleanup-orphan exclusion composed
          // server-side onto the strict-scoped Project filter. The
          // conflict scanner's lexical pair-detector uses title +
          // keywords + tags; an empty-body orphan still has all three,
          // and the per-pair `findConflictCandidates` work would pair
          // it against legitimate rows.
          filter: withCleanupOrphanExclusion({
            property: MEMORY_PROPS.PROJECT,
            relation: { contains: projectId },
          }) as QueryDataSourceParameters["filter"],
          page_size: 100,
          start_cursor: cursor,
        })
        pageIndex++
        for (const r of response.results) {
          if (isLiveFullPage(r)) pages.push(r)
        }
        if (opts.onProgress) {
          opts.onProgress({
            projectId,
            projectLabel: label,
            pageIndex,
            runningTotal: pages.length,
          })
        }
        cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
      } while (cursor !== undefined)

      if (opts.includeBodies) {
        const memories = await Promise.all(
          pages.map(async (page) => {
            const md = await this.client.pages.retrieveMarkdown({ page_id: page.id })
            return await this.pageToMemory(page, md.markdown)
          })
        )
        result.push(memories)
      } else {
        result.push(await Promise.all(pages.map((page) => this.pageToMemory(page, ""))))
      }
    }

    return result
  }

  /**
   * Candidate-pool fetcher for the near-duplicate probe. Pulls
   * `Status IN (...)` and `Kind NOT IN (...)` ahead of the row
   * limit when the operator opts into the RunTool SQL path:
   *
   * - **Flag on (`LORE_USE_RUNTOOL_FILTER_SQL=1`) AND a RunTool
   * client is wired:** issue one parameterized SQL query through
   * `query_data_sources` with both predicates pushed
   * server-side and `LIMIT N` applied AFTER. The SQL query
   * returns page ids; each id hydrates through
   * `getPropertiesById` so the returned `Memory[]` matches the
   * REST path's content-off shape (`content: ""`).
   * - **Flag off OR no RunTool client OR SQL throws:** falls back
   * to {@link MemoryService.list}. `excludeKinds` is forwarded
   * so the REST path also pushes `Kind != X` server-side via the
   * existing `does_not_equal` clauses (a one-line REST
   * improvement that lands alongside the SQL path); `statuses`
   * on the REST path stays as the caller's JS post-filter
   * responsibility because Notion's `dataSources.query` only
   * accepts a single `select.equals` clause for `Status`.
   *
   * Near-duplicate status and kind filters apply before
   * candidate-pool truncation, so `limit` means SQL-filtered
   * candidates rather than candidates later pruned in JS. The
   * contract holds on the SQL branch and partially on the REST
   * fallback (`excludeKinds` is server-side; `statuses` remains a
   * JS post-filter on REST).
   *
   * Null/missing-property semantics: the SQL `Kind NOT IN (...)`
   * predicate explicitly OR's `Kind IS NULL` so a row with no Kind
   * passes the filter, mirroring Notion's `does_not_equal`'s
   * null-permissive posture. `Status IN (...)` is null-restrictive
   * on the SQL side and matches the REST path's `select.equals`
   * whitelist (a null Status row also fails REST). Documented
   * inline in `fetchNearDuplicateCandidatePageIds`.
   */
  async listForNearDuplicates(opts: {
    projectId: string
    topicId?: string
    kind?: MemoryKind
    excludeKinds?: readonly MemoryKind[]
    statuses?: readonly MemoryStatus[]
    tags?: readonly string[]
    includeProposed?: boolean
    limit: number
  }): Promise<Memory[]> {
    return this.lister.listForNearDuplicates(opts)
  }

  async list(opts: ListMemoriesOptions & { includeContent: true }): Promise<{
    items: Memory[]
    nextCursor?: string
    capped: boolean
  }>
  async list(
    opts?: ListMemoriesOptions & { includeContent?: false | undefined }
  ): Promise<{
    items: MemoryWithoutContent[]
    nextCursor?: string
    capped: boolean
  }>
  // Catch-all overload. Accepts the optional broad options shape
  // (`opts?: ListMemoriesOptions`) so wrapper helpers can forward a
  // normalized `ListMemoriesOptions | undefined` filter variable
  // verbatim. Returns the conservative `Memory[]` widening — when
  // `includeContent` is a caller-controlled runtime `boolean`, TS
  // cannot prove the body was skipped, so the literal `""` signal
  // would be unsound.
  async list(opts?: ListMemoriesOptions): Promise<{
    items: Memory[]
    nextCursor?: string
    capped: boolean
  }>
  async list(opts?: ListMemoriesOptions): Promise<{
    items: Memory[] | MemoryWithoutContent[]
    nextCursor?: string
    capped: boolean
  }> {
    return this.lister.list(opts)
  }

  async search(input: SearchMemoriesInput): Promise<Memory[]> {
    return this.searcher.search(input)
  }

  async searchWithMeta(input: SearchMemoriesInput): Promise<{
    memories: Memory[]
    capped: boolean
  }> {
    return this.searcher.searchWithMeta(input)
  }

  async searchWithExplain(input: SearchMemoriesInput): Promise<{
    memories: Memory[]
    explain: SearchExplain[]
    capped: boolean
  }> {
    return this.searcher.searchWithExplain(input)
  }

  private async runSearch(
    input: SearchMemoriesInput
  ): Promise<{ memories: Memory[]; explain: SearchExplain[]; capped: boolean }> {
    return this.searcher.runSearch(input)
  }

  private async fetchContainsPages(
    input: SearchMemoriesInput
  ): Promise<SearchPagesResult> {
    return this.searcher.fetchContainsPages(input)
  }

  private async fetchSemanticPages(
    input: SearchMemoriesInput,
    intent: string | null,
    signal?: AbortSignal
  ): Promise<PageObjectResponse[]> {
    return this.searcher.fetchSemanticPages(input, intent, signal)
  }

  private async fetchSemanticPagesViaRunTool(
    input: SearchMemoriesInput,
    composedQuery: string,
    limit: number,
    signal?: AbortSignal
  ): Promise<PageObjectResponse[] | null> {
    return this.searcher.fetchSemanticPagesViaRunTool(input, composedQuery, limit, signal)
  }

  private async applySemanticPostFilters(
    pages: PageObjectResponse[],
    input: SearchMemoriesInput,
    signal?: AbortSignal
  ): Promise<PageObjectResponse[]> {
    return this.searcher.applySemanticPostFilters(pages, input, signal)
  }

  private async searchByContainsPages(
    input: SearchMemoriesInput
  ): Promise<SearchPagesResult> {
    return this.searcher.searchByContainsPages(input)
  }

  private async searchBySemanticPages(
    input: SearchMemoriesInput,
    intent: string | null
  ): Promise<SearchPagesResult> {
    return this.searcher.searchBySemanticPages(input, intent)
  }

  private async searchByHybridPages(
    input: SearchMemoriesInput,
    limit: number,
    intent: string | null
  ): ReturnType<MemorySearch["searchByHybridPages"]> {
    return this.searcher.searchByHybridPages(input, limit, intent)
  }

  /**
   * Hydrate a list of `PageObjectResponse` rows into `Memory` domain types,
   * honoring `includeContent`. Called exactly once at the top of `search()`
   * on the final merged-and-capped page list, so hybrid never fetches
   * markdown for candidates that won't survive the dedupe and limit cap.
   */
  private async materializeMemories(
    pages: PageObjectResponse[],
    includeContent: boolean | undefined
  ): Promise<Memory[]> {
    return this.mapper.materializeMemories(pages, includeContent)
  }

  private async pageToMemory(
    page: PageObjectResponse,
    content?: string
  ): Promise<Memory> {
    return this.mapper.pageToMemory(page, content)
  }
}
