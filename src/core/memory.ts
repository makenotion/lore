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
  SearchMode,
  SearchExplain,
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
import {
  normalizeAgents,
  type AgentNormalizationReport,
} from "./agent-normalization.js"
import {
  backfillSynopses,
  type BackfillOptions,
  type BackfillReport,
} from "./synopsis-backfill.js"
import { LruCache } from "./cache.js"
import {
  isFullPage,
  extractTitle,
  extractRichText,
  extractSelect,
  extractMultiSelect,
  extractRelationIds,
  extractDate,
  extractNumber,
} from "../notion/extractors.js"

/** Cap matches `DecisionService.idCache` (500); TTL is 60s (vs Decision's
 *  30s) because title text is cheaper-to-be-stale than decision lifecycle
 *  state — a stale title only shows the wrong label until the next write
 *  evicts the slot, whereas a stale decision status could mis-apply
 *  governance. Titles and `Kind=decision` pages share this pool. */
const TITLE_CACHE_MAX = 500
const TITLE_CACHE_TTL_MS = 60_000

/**
 * Minimum contains-mode hit count that satisfies a hybrid query without
 * firing the workspace-wide semantic fallback. Three is chosen empirically
 * to match the P3-04 spec's "Option A returns < 3 hits" threshold — small
 * enough that a niche query with one or two title matches still benefits
 * from semantic body relevance, large enough that the common case (a
 * caller searching a specific PR number, file name, or function) skips
 * the second Notion round-trip.
 */
export const HYBRID_FALLBACK_THRESHOLD = 3

/**
 * Reciprocal Rank Fusion damping constant. Score for a row at 0-based
 * `rank` in a branch is `1 / (RRF_K + rank + 1)`. Across both branches
 * the scores sum: a row that ranked #1 in both branches scores
 * `2 / (60 + 1) ≈ 0.0328`; a row that ranked #1 in only one branch
 * scores `1 / 61 ≈ 0.0164`. Cross-branch agreement is the signal RRF
 * surfaces that the prior concat-then-fill heuristic threw away.
 *
 * `60` matches qmd's choice and the Cormack 2009 paper. A per-call
 * `rrfK` knob is rejected outright — this is operator-tuning, not
 * caller-tuning. If real-query ordering looks wrong post-rollout, an
 * env knob (`LORE_HYBRID_RRF_K`, mirroring `HYBRID_FALLBACK_THRESHOLD`'s
 * posture) is the future option, but it is intentionally NOT in scope
 * here; the constant is fine to start.
 */
const RRF_K = 60

/**
 * Per-row scoring entry built during the RRF merge. Carries the rank
 * each branch assigned this page (or `null` when the branch did not
 * surface it) plus the running fused score. Captured outside the merge
 * loop so the deterministic tie-break (see `tieBreakingRrfCompare`) and
 * the explain trace both read off the same authoritative state.
 */
export type RrfEntry = {
  page: PageObjectResponse
  score: number
  containsRank: number | null
  semanticRank: number | null
}

/**
 * Per-row diagnostic captured by the hybrid path and consumed by
 * `searchWithExplain`. Mirrors the rank/score fields of `SearchExplain`
 * but omits `memoryId` (the map key) and `branch` (uniform across the
 * result, not per-row).
 */
type HybridTraceEntry = {
  containsRank: number | null
  semanticRank: number | null
  rrfScore: number | null
}

/**
 * Deterministic comparator for RRF-fused entries. Ties on `score` are
 * common when both branches return rows at identical ranks — without an
 * explicit tie-break, ordering would leak from `Map` insertion order and
 * test fixtures could not pin a stable result. Tie-break levels:
 *
 * 1. Higher `score` wins (primary).
 * 2. Lower best-rank wins. `bestRank = min(containsRank ?? Infinity,
 *    semanticRank ?? Infinity)`. A row that ranked #1 anywhere beats a
 *    row whose best rank is #2 even when their fused scores match — the
 *    score equality is a coincidence of the formula, the rank gap is
 *    the real signal.
 * 3. Contains-presence wins. A row with `containsRank !== null` beats a
 *    row with `containsRank === null` at equal score AND best-rank.
 *    This preserves the "contains is precision" intuition the prior
 *    concat-first heuristic encoded; a future contributor tempted to
 *    "make tie-break symmetric" would silently shift ordering on this
 *    edge case, which the test fixtures pin.
 * 4. Page id ascending. Final deterministic fallback so test fixtures
 *    pin a stable order regardless of `Map` iteration.
 */
export function tieBreakingRrfCompare(a: RrfEntry, b: RrfEntry): number {
  if (a.score !== b.score) return b.score - a.score
  const aBestRank = Math.min(a.containsRank ?? Infinity, a.semanticRank ?? Infinity)
  const bBestRank = Math.min(b.containsRank ?? Infinity, b.semanticRank ?? Infinity)
  if (aBestRank !== bBestRank) return aBestRank - bBestRank
  const aHasContains = a.containsRank !== null
  const bHasContains = b.containsRank !== null
  if (aHasContains !== bHasContains) return aHasContains ? -1 : 1
  return a.page.id < b.page.id ? -1 : a.page.id > b.page.id ? 1 : 0
}

// eslint-disable-next-line no-control-regex -- coercing to a single log line is the point
const HYBRID_LOG_CONTROL_CHARS = /[\x00-\x1F\x7F]/g

/**
 * Flatten any rejection reason — including a stringly `Promise.reject("foo")`
 * or a `Promise.reject()` (rejection with `undefined`) — into a single
 * stderr-safe line. Mirrors the redaction posture of
 * `mcp/helpers.ts:debugLogPartialFailures` (only `error.message` for real
 * Error subclasses) but adds an explicit fallback for `null`/`undefined` so
 * the log line never reads `error=undefined`, which is parsable but not
 * diagnostic.
 */
function rejectionToLogLine(reason: unknown): string {
  let raw: string
  if (reason instanceof Error) {
    raw = reason.message
  } else if (reason === undefined || reason === null) {
    raw = "<non-error rejection>"
  } else {
    raw = String(reason)
  }
  return raw.replace(HYBRID_LOG_CONTROL_CHARS, " ")
}

/**
 * Operator observability for **partial** hybrid-search failures (one
 * branch rejected, the other survived). The surviving branch's rows are
 * the response, so this signal is opt-in via `LORE_DEBUG=1` to avoid
 * noisy stderr on transient blips. The both-fail path uses
 * `logHybridBothFailure` instead — that one logs unconditionally because
 * there is no surviving response to mask noise on.
 *
 * Format: `[lore] partial-failure: branch=<contains|semantic> error=<message> source=hybrid-search`
 *
 * The format intentionally diverges from `mcp/helpers.ts:debugLogPartialFailures`
 * (`root=<id> tool=<name>`): a hybrid branch isn't a Notion root id, and
 * `tool=hybrid-search` would be misleading because hybrid search is a core
 * service path, not an MCP tool. The shared contract is the
 * `[lore] partial-failure:` prefix and the `error=` field — see
 * `src/core/AGENTS.md` and `src/mcp/AGENTS.md` for the full discussion.
 */
function debugLogHybridBranchFailure(
  branch: "contains" | "semantic",
  reason: unknown,
): void {
  if (process.env["LORE_DEBUG"] !== "1") return
  process.stderr.write(
    `[lore] partial-failure: branch=${branch} error=${rejectionToLogLine(reason)} source=hybrid-search\n`,
  )
}

/**
 * Operator observability for the **both-fail** hybrid-search case. Logs
 * unconditionally — not gated on `LORE_DEBUG=1` — because both-fail is the
 * worst-case scenario: there is no surviving response to mask diagnostic
 * noise on, the caller's `try/catch` only sees the chosen `throw`, and an
 * operator triaging a real outage needs every rejection reason on stderr
 * regardless of how their environment was started.
 *
 * Single line, both branches' messages on it, so log aggregators see one
 * event per occurrence — same one-event-per-line invariant as the
 * partial-failure helper.
 *
 * Format: `[lore] both-failure: contains=<message> semantic=<message> source=hybrid-search`
 */
function logHybridBothFailure(containsReason: unknown, semanticReason: unknown): void {
  process.stderr.write(
    `[lore] both-failure: contains=${rejectionToLogLine(containsReason)} semantic=${rejectionToLogLine(semanticReason)} source=hybrid-search\n`,
  )
}

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
  synopsis: string | undefined
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
    synopsis:
      input.synopsis !== undefined ? decodeTextEntities(input.synopsis) : undefined,
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
  synopsis: string | undefined
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
    synopsis:
      input.synopsis !== undefined ? decodeTextEntities(input.synopsis) : undefined,
    blockedBy:
      input.blockedBy !== undefined ? decodeTextEntities(input.blockedBy) : undefined,
    entity: input.entity !== undefined ? decodeTextEntities(input.entity) : undefined,
  }
}

export class MemoryService {
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
        confidenceScore: input.confidenceScore,
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
        synopsis: decoded.synopsis,
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
   * Hydrate the markdown body for a memory whose properties are already
   * known. Sibling of `getById` that skips the `pages.retrieve` call —
   * issued exclusively for callers that just received the row from a
   * `MemoryService.search` / `MemoryService.list` pass with
   * `includeContent: false` and need the body without re-fetching the
   * page properties Notion already returned.
   *
   * Call-count math, motivated by `lore-task action='reconcile'`'s Mail
   * vault budget: routing reconcile's per-candidate hydration through
   * `getById` would issue `271 * 5 * 2 = 2710` Notion calls (half of
   * them re-fetching properties already returned by the index-tier
   * search). `materializeContent` issues exactly one
   * `pages.retrieveMarkdown` per call, bounding the budget to
   * `271 * 5 = 1355` calls.
   *
   * Propagates the underlying `pages.retrieveMarkdown` error on failure.
   * Callers that want graceful degradation to empty content (transient
   * 5xx, archived page, etc.) wrap the call in `.catch(() => ({ ...m,
   * content: "" }))`. Failure-handling lives at the caller because
   * different callers want different fallback shapes.
   */
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
    if (decoded.synopsis !== undefined) {
      props["Synopsis"] = {
        rich_text: [{ text: { content: decoded.synopsis } }],
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
    // See `buildMemoryProps` for the three-state rationale.
    if (input.confidenceScore !== undefined) {
      props["Confidence Score"] =
        input.confidenceScore === null
          ? { number: null }
          : { number: input.confidenceScore }
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
        type: "replace_content",
        replace_content: {
          new_str: decoded.content,
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

  /**
   * Run the agent-identity normalization pass against this service's
   * Memories DB. Same shape as `fixEncoding` — thin wrapper over the
   * standalone migration function in `agent-normalization.ts` so the CLI
   * doesn't need to reach past the service boundary for the client +
   * DatabaseRef.
   */
  async normalizeAgents(
    options: { dryRun?: boolean } = {}
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
   * Search memories. Three execution modes (see `SearchMode` in `types.ts`):
   *
   * - `"contains"` — DS-scoped `dataSources.query` with Title/Keywords
   *   `contains` filters and server-side property filters
   *   (`projectId` / `topicId` / `tags` / `kind` / `status`). No workspace
   *   leakage, no vector ranking — best for substring/exact-phrase queries.
   * - `"semantic"` — Workspace-wide `client.search`, ranked by Notion's
   *   embedding index over titles AND bodies. Property filters degrade to
   *   client-side post-filters since `client.search` lacks property-filter
   *   support. Best for phrase-shaped queries that need body relevance.
   * - `"hybrid"` (default) — fire contains and semantic in parallel; if
   *   contains saturates (`>= HYBRID_FALLBACK_THRESHOLD` hits), use the
   *   contains rows alone and discard the parallel semantic result.
   *   Otherwise merge the two ranked lists via Reciprocal Rank Fusion
   *   (RRF) with a deterministic tie-break — see `searchByHybridPages`.
   *   Speculative parallelism keeps wall-clock at one round-trip
   *   (≈ `client.search` latency) regardless of which leg saturates —
   *   the cheap-path waste is one discarded Notion call, governed by the
   *   shared rate limiter.
   *
   * **Materialization happens exactly once** — the per-mode helpers
   * return raw `PageObjectResponse[]` and `materializeMemories` runs at
   * the top level on the merged-and-capped list. Without this, the
   * hybrid fallback could fetch markdown for `containsHits + semanticHits`
   * candidates (potentially 100+) when only `limit` (default 10) will
   * be returned.
   *
   * **Kill switch.** `LORE_FORCE_SEMANTIC_SEARCH=1` overrides the
   * caller's mode and forces every search through the legacy
   * workspace-wide path. Use as a rollback escape hatch if the contains
   * path silently under-recalls in a vault that hasn't run
   * `lore migrate --fix-memory-encoding` yet (encoded titles miss
   * substring matches against post-decode queries) — see P2-10.
   */
  async search(input: SearchMemoriesInput): Promise<Memory[]> {
    const { memories } = await this.runSearch(input)
    return memories
  }

  /**
   * Same pipeline as `search`, plus a per-row diagnostic trace aligned by
   * index (`explain[i]` describes `memories[i]`). Two methods rather than
   * one overloaded return type because every existing caller of `search`
   * — including `loadWakeUpData` — assumes a `Memory[]` shape structurally;
   * forcing union-narrowing on every call site to support an opt-in trace
   * is an outsized typing tax for a feature most callers don't ask for.
   *
   * Branch-field semantics follow the spec in `SearchExplain`. The
   * resolved mode (after `LORE_FORCE_SEMANTIC_SEARCH=1` is applied)
   * drives the value: `"contains-only"`, `"semantic-only"`,
   * `"contains-saturated"`, or `"rrf"`. On the saturation branch
   * `semanticRank` is forced to `null` even when the semantic call
   * returned the row — surfacing its rank would imply influence on
   * ordering that did not happen, since the saturation cutoff discards
   * the semantic branch's output entirely.
   */
  async searchWithExplain(input: SearchMemoriesInput): Promise<{
    memories: Memory[]
    explain: SearchExplain[]
  }> {
    return this.runSearch(input)
  }

  /**
   * Shared execution path. Resolves the mode, dispatches to the per-mode
   * helper, slices to `limit`, materializes markdown, and builds the
   * explain trace. Both `search` and `searchWithExplain` go through this
   * one method so the row order is identical between the two surfaces.
   */
  private async runSearch(
    input: SearchMemoriesInput,
  ): Promise<{ memories: Memory[]; explain: SearchExplain[] }> {
    const requested: SearchMode = input.mode ?? "hybrid"
    const mode: SearchMode =
      process.env["LORE_FORCE_SEMANTIC_SEARCH"] === "1" ? "semantic" : requested
    const limit = input.limit ?? 10

    // Normalize intent once at the entry point. Both the saturation-bypass
    // gate in `searchByHybridPages` and the query composition in
    // `searchBySemanticPages` need to agree on what counts as "intent is
    // set." Whitespace-only intent (`"   "`) collapses to `null` here so a
    // caller can't accidentally bypass the cutoff or pollute the semantic
    // query with whitespace. See #17 / `src/core/AGENTS.md` for the rule.
    const trimmedIntent = input.intent?.trim()
    const intent =
      trimmedIntent !== undefined && trimmedIntent.length > 0 ? trimmedIntent : null

    let pages: PageObjectResponse[]
    let explainBranch: SearchExplain["branch"]
    let hybridTrace: Map<string, HybridTraceEntry> | null = null

    if (mode === "contains") {
      // `searchByContainsPages` deliberately ignores `input.intent`; it
      // reads only `input.query` for the substring filter. Appending
      // intent into a contains substring would narrow recall in the
      // opposite direction the disambiguator exists to fix.
      pages = await this.searchByContainsPages(input)
      explainBranch = "contains-only"
    } else if (mode === "semantic") {
      pages = await this.searchBySemanticPages(input, intent)
      explainBranch = "semantic-only"
    } else {
      const hybrid = await this.searchByHybridPages(input, limit, intent)
      pages = hybrid.pages
      explainBranch = hybrid.branch
      hybridTrace = hybrid.trace
    }

    const capped = pages.slice(0, limit)
    const memories = await this.materializeMemories(capped, input.includeContent)
    const explain = capped.map((page, i): SearchExplain => {
      if (explainBranch === "contains-only") {
        return {
          memoryId: page.id,
          containsRank: i,
          semanticRank: null,
          rrfScore: null,
          branch: "contains-only",
        }
      }
      if (explainBranch === "semantic-only") {
        return {
          memoryId: page.id,
          containsRank: null,
          semanticRank: i,
          rrfScore: null,
          branch: "semantic-only",
        }
      }
      const trace = hybridTrace?.get(page.id)
      return {
        memoryId: page.id,
        containsRank: trace?.containsRank ?? null,
        semanticRank: trace?.semanticRank ?? null,
        rrfScore: trace?.rrfScore ?? null,
        branch: explainBranch,
      }
    })
    return { memories, explain }
  }

  /**
   * DS-scoped query path. Runs against the Memories data source only — no
   * workspace-wide leakage. Filters compose as a single `and`: project
   * inheritance (project relation contains projectId OR is_empty) plus topic,
   * tags, kind, status, and finally a `(Title contains query) OR
   * (Keywords contains query)` clause.
   *
   * Returns raw `PageObjectResponse[]` so the caller can dedupe with other
   * paths' output before materializing markdown bodies.
   *
   * **Body matches are not searched** — Notion's `dataSources.query` filter
   * surface only exposes property predicates, not page-body text. Callers
   * that need body relevance should use `"semantic"` or rely on the
   * `"hybrid"` fallback.
   */
  private async searchByContainsPages(
    input: SearchMemoriesInput,
  ): Promise<PageObjectResponse[]> {
    const limit = Math.min(input.limit ?? 10, 100)
    const filters: Array<Record<string, unknown>> = []

    if (input.projectId) {
      filters.push(projectOrUnscopedFilter(input.projectId))
    }
    if (input.topicId) {
      filters.push({ property: "Topic", relation: { contains: input.topicId } })
    }
    if (input.tags?.length) {
      // Mirrors the OR semantics of `MemoryService.list`: any-tag-matches.
      // Tightening to AND would silently under-shoot the candidate pool for
      // multi-tag queries.
      filters.push(
        input.tags.length === 1
          ? { property: "Tags", multi_select: { contains: input.tags[0] } }
          : {
              or: input.tags.map((t) => ({
                property: "Tags",
                multi_select: { contains: t },
              })),
            },
      )
    }
    if (input.kind) {
      filters.push({ property: "Kind", select: { equals: input.kind } })
    }
    if (input.status) {
      filters.push({ property: "Status", select: { equals: input.status } })
    }

    // Empty-string query degenerates to "match every page in the data source"
    // because `contains: ""` is satisfied by every value. Skip the text
    // clause entirely so the caller gets a recency-ordered listing of
    // whatever the surrounding property filters select — the same result
    // semantic search would give for an empty query, but DS-scoped.
    const trimmed = input.query.trim()
    if (trimmed.length > 0) {
      filters.push({
        or: [
          { property: "Title", title: { contains: trimmed } },
          { property: "Keywords", rich_text: { contains: trimmed } },
          { property: "Synopsis", rich_text: { contains: trimmed } },
        ],
      })
    }

    // No filters AND empty query → `filter: undefined` returns every row in
    // the DS sorted by recency, capped at `limit`. Intentional, not a
    // degenerate-input bug: callers passing only `mode: "contains"` with
    // no scope and no query get the equivalent of `lore-query action='recall'` minus
    // cursor pagination. A future reader: do not add a guard here.
    const filter =
      filters.length > 1
        ? { and: filters }
        : filters.length === 1
          ? filters[0]
          : undefined

    const response = await this.client.dataSources.query({
      data_source_id: this.db.dataSourceId,
      filter: filter as QueryDataSourceParameters["filter"],
      // No relevance ranking is available on `dataSources.query`; sort by
      // recency so the most recently touched matches surface first.
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: limit,
    })

    return response.results.filter(isFullPage) as PageObjectResponse[]
  }

  /**
   * Workspace-wide semantic search via `client.search`. Notion's `search`
   * endpoint returns results ranked by relevance when no `sort` parameter
   * is passed. Passing `sort` switches to recency ordering and demotes the
   * query to a lexical filter — which defeats the point. We pay for a
   * larger `page_size` instead so the client-side filter to the Memories
   * database has enough headroom when the workspace contains other pages
   * that happen to match the query tokens.
   *
   * Property filters (`kind` / `status` / `tags` / `topicId`) apply as
   * client-side post-filters only — `client.search` does not accept them.
   * `projectId` post-filters with the same scope-inheritance semantics as
   * the contains path.
   *
   * Returns raw `PageObjectResponse[]`. Markdown bodies are *not* fetched
   * here — `search()` runs `materializeMemories` once on the final
   * merged-and-capped list.
   */
  private async searchBySemanticPages(
    input: SearchMemoriesInput,
    intent: string | null,
  ): Promise<PageObjectResponse[]> {
    // Compose `client.search`'s `query` from the caller's `query` plus
    // any normalized intent. The `[query.trim(), intent].filter(Boolean)`
    // shape handles the edge case where `query` is empty (allowed on
    // `MemoryService.search` callers that pass `""` for unscoped relevance
    // lookups) without producing a leading space — `" intent"` may rank
    // differently from `"intent"` alone under Notion's unspecified ranking.
    // The contains branch sees ONLY `input.query`; intent never narrows it.
    const composedQuery =
      intent !== null ? [input.query.trim(), intent].filter(Boolean).join(" ") : input.query
    const response = await this.client.search({
      query: composedQuery,
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

    // Apply additional filters (project, topic, tags, kind, status). The
    // search API has no property-filter support, so these are post-filters.
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
    if (input.kind) {
      filtered = filtered.filter(
        (page) => extractSelect(page.properties["Kind"], "note") === input.kind,
      )
    }
    if (input.status) {
      filtered = filtered.filter(
        (page) =>
          extractSelect(page.properties["Status"], "informational") === input.status,
      )
    }

    // Trim before returning so the caller only sees the top-`limit` rows
    // semantic ranked. The final `slice(0, limit)` in `search()` is
    // belt-and-braces; this trim keeps the merge in `searchByHybridPages`
    // from carrying a 100-row tail into the dedupe loop.
    return filtered.slice(0, input.limit ?? 10)
  }

  /**
   * Hybrid path: speculative parallelism. Fires the contains and semantic
   * queries concurrently via `Promise.allSettled` so the worst-case
   * wall-clock stays at one round-trip (≈ `client.search` latency)
   * regardless of which leg saturates AND so a transient single-branch
   * failure cannot sink a query the surviving branch could answer on its
   * own. The decision to use the semantic result or discard it happens
   * *after* both queries settle.
   *
   * - **Saturating case** (`containsHits >= HYBRID_FALLBACK_THRESHOLD`):
   *   uses contains rows alone, ignoring the parallel semantic call.
   *   Wasted one Notion call but no wall-clock cost. The shared rate
   *   limiter (see `notion/rate-limit.ts`) bounds the cost.
   * - **Under-shooting case (RRF)**: merges the two ranked lists via
   *   Reciprocal Rank Fusion. Each row's score is `Σ 1 / (RRF_K + rank +
   *   1)` summed across the branches it appears in (`RRF_K = 60`,
   *   Cormack 2009). Cross-branch agreement scores higher than
   *   single-branch presence — a row ranked #1 in both branches scores
   *   `2/61` and beats a row ranked #1 in only one branch (`1/61`).
   *   Tie-break order is `score → best-rank → contains-presence → page
   *   id ascending` (see `tieBreakingRrfCompare`). Capped at `limit`.
   *
   * The earlier sequential design paid `containsLatency + semanticLatency`
   * on under-shoot — strictly worse than the pre-PR single-call wall-clock
   * for a query that's now the *common* case.
   *
   * **Single-branch resilience (PF3-03).** A `Promise.all` over both legs
   * would propagate any rejection (a transient 429 from `client.search`,
   * for instance) to the caller, even when contains saturated independently
   * — a regression vs. the pre-P3-04 single-call latency floor. With
   * `Promise.allSettled` a rejected branch degrades to an empty result and
   * the surviving branch's rows are returned; both-branches-rejected still
   * surfaces an error so a fully broken search subsystem doesn't masquerade
   * as an empty-result silence. Branch failures are logged to stderr under
   * `LORE_DEBUG=1` so operators can distinguish a one-off blip from a
   * pathological loop. The kill switch (`LORE_FORCE_SEMANTIC_SEARCH=1`)
   * remains the manual rollback for sustained problems; this guard is the
   * automatic one for transient ones.
   *
   * **Empty-query note.** With no text filter, the contains leg returns a
   * recency listing under property filters; the semantic leg returns
   * `client.search({ query: "" })` (Notion's own empty-query behavior,
   * which is not documented). If contains saturates, semantic is
   * discarded — empty-query hybrid effectively behaves as `mode:
   * "contains"`. Callers wanting predictable empty-query semantics should
   * pass `mode: "contains"` explicitly.
   */
  private async searchByHybridPages(
    input: SearchMemoriesInput,
    limit: number,
    intent: string | null,
  ): Promise<{
    pages: PageObjectResponse[]
    branch: "contains-saturated" | "rrf"
    trace: Map<string, HybridTraceEntry>
  }> {
    const [containsResult, semanticResult] = await Promise.allSettled([
      this.searchByContainsPages(input),
      this.searchBySemanticPages(input, intent),
    ])

    if (containsResult.status === "rejected" && semanticResult.status === "rejected") {
      // Both legs failed — log both messages on one stderr line
      // unconditionally (operators triaging a real outage need both
      // rejection reasons regardless of LORE_DEBUG), then surface one to
      // the caller. We choose `containsResult.reason` so the caller's
      // existing `try/catch` sees a structured, DS-scoped error from
      // `dataSources.query` rather than a `client.search` workspace-wide
      // error whose request-scoped detail is less actionable. The choice
      // is also stable across releases — a future refactor that flips it
      // to `semanticResult.reason` would be observable to callers and
      // should be a coordinated change, not a drive-by.
      // We considered `AggregateError([contains, semantic])` here for
      // structural completeness but every current `search()` call site
      // catches a generic Error and surfaces `err.message`; the caller
      // contract is intentionally unchanged. The unconditional stderr
      // log is the operator-facing answer.
      logHybridBothFailure(containsResult.reason, semanticResult.reason)
      throw containsResult.reason
    }

    const containsPages =
      containsResult.status === "fulfilled" ? containsResult.value : []
    const semanticPages =
      semanticResult.status === "fulfilled" ? semanticResult.value : []

    if (containsResult.status === "rejected") {
      debugLogHybridBranchFailure("contains", containsResult.reason)
    }
    if (semanticResult.status === "rejected") {
      debugLogHybridBranchFailure("semantic", semanticResult.reason)
    }

    // Saturation cutoff: contains alone is the answer. Semantic ran in
    // parallel but its output is discarded — the trace must report
    // `semanticRank: null` for every row even when semantic returned the
    // same id, because surfacing that rank would imply influence on
    // ordering that did not happen.
    //
    // **Intent disables the cutoff.** When the caller passes a non-empty
    // intent, the saturation gate is bypassed so the intent-augmented
    // semantic lane gets to influence ordering — otherwise intent would
    // be silently nullified in the common case (any non-trivial vault
    // produces 3+ contains hits for a one-word query like `"auth"`).
    // The cost is small (one Map walk + one sort) but observable: an
    // agent passing intent on every call sees slightly different
    // ordering on queries that today saturate. See #17 for the
    // load-bearing tradeoff.
    if (intent === null && containsPages.length >= HYBRID_FALLBACK_THRESHOLD) {
      const trace = new Map<string, HybridTraceEntry>()
      containsPages.forEach((page, rank) => {
        trace.set(page.id, {
          containsRank: rank,
          semanticRank: null,
          rrfScore: null,
        })
      })
      return { pages: containsPages, branch: "contains-saturated", trace }
    }

    // Under-saturation: RRF over both branches. Cross-branch agreement
    // is the signal the prior concat-then-fill heuristic threw away — a
    // row ranked #2 in both branches should beat a row ranked #1 in only
    // one. The deterministic tie-break (see `tieBreakingRrfCompare`) pins
    // the order on score collisions so test fixtures don't drift on
    // `Map` iteration.
    const scored = new Map<string, RrfEntry>()
    const accumulate = (
      branchPages: PageObjectResponse[],
      branchKind: "contains" | "semantic",
      weight = 1,
    ) => {
      branchPages.forEach((page, rank) => {
        const score = (1 / (RRF_K + rank + 1)) * weight
        const prev = scored.get(page.id)
        if (prev) {
          prev.score += score
          if (branchKind === "contains") prev.containsRank = rank
          else prev.semanticRank = rank
        } else {
          scored.set(page.id, {
            page,
            score,
            containsRank: branchKind === "contains" ? rank : null,
            semanticRank: branchKind === "semantic" ? rank : null,
          })
        }
      })
    }
    // **Intent up-weights the contains lane.** When intent is set, the
    // saturation cutoff was bypassed above so the RRF merge runs even
    // when contains saturated. To keep contains-precision dominant in
    // ordering (the literal-precision lane wins when both branches
    // agree), the contains lane weight is bumped to 2 and the
    // intent-augmented semantic lane stays at 1. This mirrors qmd's
    // "original query ×2" rule. The constant is empirical; if real-query
    // ordering shows contains drowning out useful semantic hits, lower
    // it in a follow-up. An env knob (`LORE_HYBRID_CONTAINS_WEIGHT`) is
    // intentionally NOT scoped here — operator-tuning, not caller-tuning;
    // same posture as `LORE_HYBRID_RRF_K`.
    const containsWeight = intent !== null ? 2 : 1
    accumulate(containsPages, "contains", containsWeight)
    accumulate(semanticPages, "semantic")

    // Slice before building the trace so the map carries entries only for
    // the rows that survive into the response — `runSearch`'s explain
    // loop reads `trace.get(page.id)` on the capped page list, so trace
    // entries past `limit` would be unreachable allocations.
    const ranked = [...scored.values()].sort(tieBreakingRrfCompare).slice(0, limit)
    const trace = new Map<string, HybridTraceEntry>()
    for (const entry of ranked) {
      trace.set(entry.page.id, {
        containsRank: entry.containsRank,
        semanticRank: entry.semanticRank,
        rrfScore: entry.score,
      })
    }
    return { pages: ranked.map((entry) => entry.page), branch: "rrf", trace }
  }

  /**
   * Hydrate a list of `PageObjectResponse` rows into `Memory` domain types,
   * honoring `includeContent`. Called exactly once at the top of `search()`
   * on the final merged-and-capped page list, so hybrid never fetches
   * markdown for candidates that won't survive the dedupe and limit cap.
   */
  private async materializeMemories(
    pages: PageObjectResponse[],
    includeContent: boolean | undefined,
  ): Promise<Memory[]> {
    if (includeContent === false) {
      return pages.map((page) => this.pageToMemory(page, ""))
    }
    return Promise.all(
      pages.map(async (page) => {
        const md = await this.client.pages.retrieveMarkdown({ page_id: page.id })
        return this.pageToMemory(page, md.markdown)
      }),
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
    confidenceScore: extractNumber(props["Confidence Score"]),
    reviewBy: extractDate(props["Review By"]),
    doneAt: extractDate(props["Done At"]),
    decidedAt: extractDate(props["Decided At"]),
    supersedesIds: extractRelationIds(props["Supersedes"]),
    affectsIds: extractRelationIds(props["Affects"]),
    alternatives: extractRichText(props["Alternatives"]),
    consequences: extractRichText(props["Consequences"]),
    author: extractRichText(props["Author"]),
    agent: extractRichText(props["Agent"]),
    tags: extractMultiSelect(props["Tags"]),
    keywords: extractRichText(props["Keywords"]),
    synopsis: extractRichText(props["Synopsis"]),
    session: extractRichText(props["Session"]),
    content: content ?? "",
    createdAt: page.created_time,
    updatedAt: page.last_edited_time,
    taskState,
    blockedBy: extractRichText(props["Blocked By"]),
    entity: extractRichText(props["Entity"]),
  }
}
