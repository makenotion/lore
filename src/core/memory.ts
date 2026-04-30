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
import {
  CONFIDENCE_DISPLAY_THRESHOLD,
  MS_PER_DAY,
  STALE_CONFIDENCE_DAYS,
} from "../types.js"
import {
  buildMemoryProps,
  COMPARE_NOTES_MAX_CHARS,
  encodeCompareNotesRichText,
  type CompareNotesTextChunk,
} from "../notion/schema.js"
import { isMissingPropertyError } from "../notion/errors.js"
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
  bumpConfidenceScore,
  confidenceFactor,
  decayConfidenceScore,
  decrementConfidenceScore,
  seedConfidenceScore,
} from "./decay.js"
import { todayUtc } from "./task.js"
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
 * surface it) plus the running fused score and the confidence-weighting
 * factor applied to that score. Captured outside the merge loop so the
 * deterministic tie-break (see `tieBreakingRrfCompare`) and the explain
 * trace both read off the same authoritative state.
 *
 * `confidenceFactor` is computed once per row at the first time the row
 * is encountered (it depends only on the row's stored `Confidence Score`,
 * which doesn't change across branches) and multiplied into every
 * per-branch contribution so the fused score reflects trust uniformly.
 */
export type RrfEntry = {
  page: PageObjectResponse
  score: number
  containsRank: number | null
  semanticRank: number | null
  confidenceFactor: number
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
  confidenceFactor: number
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

/**
 * Confidence-weighted reranking shared by `searchByContainsPages` and
 * `searchBySemanticPages`. Maps each page to a per-branch RRF entry with
 * `score = (1 / (RRF_K + rank + 1)) * confidenceFactor`, then sorts via
 * `tieBreakingRrfCompare`. The `branchKind` parameter sets the
 * appropriate rank field (`containsRank` on contains-mode callers,
 * `semanticRank` on semantic-mode callers) so the synthesized RrfEntry
 * accurately reflects the row's branch — tie-break levels 2/3 read
 * those fields directly, and a future caller that surfaces these
 * entries (rather than going through `runSearch`'s explain rebuild)
 * would otherwise see a row attributed to the wrong branch.
 *
 * **All-unscored short-circuit.** When every page's `Confidence Score`
 * is `null`, every factor is uniformly `1.0` and the per-row scores
 * `1/(RRF_K + rank + 1)` are strictly decreasing in input order — so
 * `tieBreakingRrfCompare`'s level-1 (`score`) comparison alone
 * preserves input order, and the page-id fall-through never fires.
 * The short-circuit is an allocation/sort-avoidance optimization for
 * the unmigrated-vault case (every retrieval until #11's backfill or
 * Phase 2 read-touches populate scores) AND defense-in-depth against a
 * future refactor that introduces score collisions on the unscored
 * path — without that gate, an arithmetic regression here could
 * silently re-sort unmigrated vaults into page-id order.
 *
 * Hybrid mode does NOT call this helper — it consumes the raw fetch
 * helpers directly and applies the factor inside its RRF accumulator.
 */
function rerankByConfidence(
  pages: PageObjectResponse[],
  branchKind: "contains" | "semantic",
): PageObjectResponse[] {
  if (pages.length === 0) return pages
  const allUnscored = pages.every(
    (page) => extractNumber(page.properties["Confidence Score"]) === null,
  )
  if (allUnscored) return pages
  return pages
    .map((page, rank): RrfEntry => {
      const score = extractNumber(page.properties["Confidence Score"])
      const factor = confidenceFactor(score)
      return {
        page,
        score: (1 / (RRF_K + rank + 1)) * factor,
        containsRank: branchKind === "contains" ? rank : null,
        semanticRank: branchKind === "semantic" ? rank : null,
        confidenceFactor: factor,
      }
    })
    .sort(tieBreakingRrfCompare)
    .map((entry) => entry.page)
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
        lastReferencedAt: input.lastReferencedAt,
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
        topicKey: input.topicKey,
        revisionCount: input.revisionCount,
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
   */
  async getPropertiesById(id: string): Promise<Memory> {
    const page = await this.client.pages.retrieve({ page_id: id })
    return this.pageToMemory(page as PageObjectResponse, "")
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
   * wiring in `lore-query action='ask'` (issue 0.8.0/05) routes through
   * here — fetching markdown bodies the caller will discard would
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
          return this.pageToMemory(page as PageObjectResponse, "")
        } catch {
          return null
        }
      }),
    )
    return results.filter((m): m is Memory => m !== null)
  }

  /**
   * Find at most one non-archived memory matching a `(Topic Key,
   * Project-set)` pair, ordered by `Revision Count` desc with
   * `Last Referenced At` desc as the tiebreaker. The shared lookup
   * helper for the topic-key upsert path (#06) and the re-key repair
   * path (#14) — both consume this so neither hard-depends on the
   * other. Two short-circuit guards defend against accidental
   * whole-vault matches: empty `topicKey` and empty `projectIds`
   * both return null without issuing any Notion query.
   *
   * **Empty `topicKey` guard.** Per the schema contract, empty
   * string and missing both mean "no upsert grouping" — there is
   * no canonical row to find. Without this guard, a caller in #06
   * that forgets to gate on `topicKey === ""` would issue
   * `rich_text: { equals: "" }` to Notion, which matches every
   * legacy row whose Topic Key column is empty (i.e. every
   * pre-#06 memory). The JS post-filter would narrow to the
   * project set and return the highest-`Revision Count` legacy
   * memory — silently appending a revision onto an arbitrary
   * unrelated row. The parameter type is `string` (not
   * `string | undefined`), so the type system doesn't catch the
   * call-site mistake; this guard does.
   *
   * **Project-set EQUALITY, not containment.** Notion's relation
   * filter only supports `contains`, so the query OR-AND-composes
   * one `contains` clause per project ID. The result set is then
   * filtered client-side down to true equality — a memory whose
   * Project relation is `["P1", "P2"]` is excluded from a query
   * for `projectIds: ["P1"]` because the memory has extra projects
   * the caller didn't ask for. Symmetric: a query for
   * `["P1", "P2"]` against a memory in `["P1"]` returns null.
   * Order-independent: set semantics, not list semantics.
   *
   * **Pagination.** A vault with many memories under the same Topic
   * Key (project-set differs across rows so the helper returns null
   * for each but the query yields >100 candidates) or repeated re-
   * keying could overflow the default 100-row Notion page. Loop
   * until `has_more` is false; without pagination the latest
   * revision could hide on a non-first page and the helper would
   * silently return a stale candidate.
   *
   * **Archived rows.** `dataSources.query` cannot filter on the
   * `archived` page-metadata flag (it lives on PageObjectResponse,
   * not as a DB column). The post-filter excludes archived rows
   * client-side.
   *
   * **Cross-kind matching is intentional.** The Memories DB hosts
   * notes, decisions, and tasks (the Kind column discriminates).
   * The query does NOT filter on Kind — a `decision/jwt-auth` topic
   * key matches against any memory in the project set carrying that
   * key, regardless of Kind. This is what #14 (re-key) needs for
   * collision detection: if a re-key would land on an existing
   * task or decision, the helper must surface that collision so the
   * re-key can reject. Callers that want kind-specific upsert
   * semantics (#06's expected use case for plain memories) layer a
   * Kind filter at their own boundary; the helper stays
   * Kind-agnostic so the single primitive serves both consumers.
   */
  async findByTopicKey(input: {
    topicKey: string
    projectIds: string[]
  }): Promise<Memory | null> {
    if (input.topicKey === "") return null
    if (input.projectIds.length === 0) return null

    const allResults: PageObjectResponse[] = []
    // First iteration runs with `start_cursor: undefined` (Notion
    // treats this as "first page"). Subsequent iterations carry the
    // returned `next_cursor` until `has_more` is false; the
    // `?? undefined` guard normalizes a `next_cursor: null` from
    // Notion into the loop-exit sentinel.
    let cursor: string | undefined = undefined
    do {
      const page = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: {
          and: [
            { property: "Topic Key", rich_text: { equals: input.topicKey } },
            ...input.projectIds.map((id) => ({
              property: "Project",
              relation: { contains: id },
            })),
          ],
        } as QueryDataSourceParameters["filter"],
        start_cursor: cursor,
      })
      for (const r of page.results) {
        if (isFullPage(r)) allResults.push(r)
      }
      cursor = page.has_more ? page.next_cursor ?? undefined : undefined
    } while (cursor !== undefined)

    const inputSet = new Set(input.projectIds)
    const matches = allResults
      .filter((page) => !page.archived)
      .map((page) => this.pageToMemory(page, ""))
      .filter(
        (m) =>
          m.projectIds.length === inputSet.size &&
          m.projectIds.every((id) => inputSet.has(id)),
      )

    matches.sort((a, b) => {
      if (a.revisionCount !== b.revisionCount) {
        return b.revisionCount - a.revisionCount
      }
      return (b.lastReferencedAt ?? "").localeCompare(a.lastReferencedAt ?? "")
    })

    return matches[0] ?? null
  }

  /**
   * Topic-key upsert (0.9.0/#06). Either appends a revision block to an
   * existing memory or creates a fresh one. The match key is `(Topic Key,
   * Project-set)`; project equality is set-equal (same IDs, same count),
   * resolved by `findByTopicKey` (#01).
   *
   * **Kind-mismatch validation runs BEFORE any Notion write.** The
   * acceptance criterion for #06 ("kind mismatch throws before any
   * Notion write") requires the kind check to fire immediately after
   * `findByTopicKey` returns, NOT after the body read/write. An
   * earlier draft of this spec had the validation after
   * `retrieveMarkdown` + `updateMarkdown` — a real correctness bug
   * because a kind-mismatched upsert would have appended a revision
   * block to the page before rejecting.
   *
   * **Project-set equality is enforced by `findByTopicKey`, NOT by a
   * defensive recheck here.** The lookup post-filters candidates to
   * `existing.projectIds.length === input.projectIds.length &&
   * existing.projectIds.every(id => inputSet.has(id))` and returns
   * null on mismatch — so by construction the post-find row is
   * set-equal to the input. A second JS-side recheck against the same
   * returned value is structurally tautological. True race detection
   * (a writer that mutates the project relation between find and write
   * on this process) would require a second `pages.retrieve` round-
   * trip and the worst-case consequence (one revision lands on a row
   * whose project set just expanded under a concurrent write) is
   * benign — not justified.
   *
   * **Field policy on upsert:**
   * - **THROW on mismatch**: Kind (per-kind chain). Project-set is
   *   handled by the lookup; not a separate throw at this layer.
   * - **PRESERVE silently** (input dropped, no warning): Status,
   *   Topic relation. State transitions belong on `lore-memory
   *   action='update'`; the upsert path treats these as forgotten-to-
   *   omit envelopes.
   * - **REPLACE on every save** (latest write wins): Title, Synopsis,
   *   Keywords, Source. Confidence (categorical) bumps if input
   *   provides one.
   * - **UNTOUCHED**: Confidence Score (system-managed per 0.8.0/#01),
   *   Last Referenced At (read-citation signal per 0.8.0/#02).
   *
   * **Empty-project guard.** An upsert with `projectIds: []` is
   * structurally undefined — set-equality on the empty set matches
   * every other empty-project memory. Lore allows projectless saves
   * via the create path (catch-all), but those must NOT participate
   * in topic-key upsert. `findByTopicKey` returns null on empty
   * projects, but we throw here for a clearer error.
   *
   * **Notion v5 markdown API.** The SDK exposes `insert_content` for
   * fresh writes on a page with no body and `replace_content_range`
   * with `content_range: "full_page"` for edits to an existing body
   * (per `src/notion/CLAUDE.md`). There is no append mode, so the
   * upsert path always reads existing markdown and writes back the
   * concatenation. Two API calls per upsert.
   *
   * **Idempotency NOT guaranteed.** Calling upsert twice with
   * identical inputs produces revisions 2 and 3, not the same revision
   * twice — upsert is *append*, not idempotent.
   */
  async upsertByTopicKey(input: {
    topicKey: string
    projectIds: string[]
    title: string
    content: string
    kind: MemoryKind
    source?: MemorySource
    status?: MemoryStatus
    confidence?: MemoryConfidence
    topicId?: string
    synopsis?: string
    keywords?: string
    tags?: string[]
    agent?: string
    session?: string
    reviewBy?: string
    decidedAt?: string
    today?: string
  }): Promise<{
    memory: Memory
    revisionCount: number
    upserted: boolean
  }> {
    if (input.projectIds.length === 0) {
      throw new Error(
        "topicKey requires at least one projectId. " +
          "Projectless memories cannot upsert.",
      )
    }

    const existing = await this.findByTopicKey({
      topicKey: input.topicKey,
      projectIds: input.projectIds,
    })

    if (!existing) {
      const created = await this.create({
        title: input.title,
        content: input.content,
        projectIds: input.projectIds,
        topicId: input.topicId,
        source: input.source,
        kind: input.kind,
        status: input.status,
        confidence: input.confidence,
        tags: input.tags,
        keywords: input.keywords,
        synopsis: input.synopsis,
        agent: input.agent,
        session: input.session,
        reviewBy: input.reviewBy,
        decidedAt: input.decidedAt,
        topicKey: input.topicKey,
        revisionCount: 1,
      })
      return { memory: created, revisionCount: 1, upserted: false }
    }

    // Validate Kind BEFORE any Notion write. The kind-mismatch throw
    // must fire before retrieveMarkdown / updateMarkdown so a rejected
    // upsert leaves the existing page untouched.
    //
    // Project-set is NOT re-checked here: `findByTopicKey` already
    // post-filters to set-equality and returns null on mismatch, so by
    // construction `existing.projectIds` is set-equal to
    // `input.projectIds` whenever we get past the find. A defensive
    // re-check of the same returned value is structurally unreachable
    // (it can only fire if `findByTopicKey`'s post-filter is
    // bypassed, which is not a path a caller can take). True
    // race detection would require a second `pages.retrieve` round-
    // trip, which is not justified — the only racing writer that
    // could change the project set between find and write is another
    // process holding the same `topicKey`, an extremely rare case
    // whose worst outcome (one revision lands on a row whose project
    // set just expanded) is benign.
    if (input.kind !== existing.kind) {
      throw new Error(
        `Kind cannot change on upsert. Existing: '${existing.kind}'; ` +
          `input: '${input.kind}'. Pick a new topicKey for the new ` +
          `kind, or supersede via lore-decision action='create'.`,
      )
    }

    // Decode at the write boundary — same posture as `create`. Encoded
    // values flowing in from autosave-rendered transcripts (`Foo &amp;
    // Bar`) must land in Notion as plain text. Idempotent on clean
    // input; covers title, content body, synopsis, and keywords (the
    // similarity / embedding surfaces that read these fields downstream).
    const decodedTitle = decodeTextEntities(input.title)
    const decodedContent = input.content ? decodeTextEntities(input.content) : ""
    const decodedSynopsis =
      input.synopsis !== undefined ? decodeTextEntities(input.synopsis) : undefined
    const decodedKeywords =
      input.keywords !== undefined ? decodeTextEntities(input.keywords) : undefined

    // Title-cache sandwich (mirrors `update()`). The upsert always
    // bumps Title, so the same write-epoch + delete pattern that
    // protects `update()` from concurrent `getTitleById` callers
    // applies here. Without this, render-layer resolvers would keep
    // returning the pre-upsert title from `titleCache` until the 60s
    // TTL expired even though the new title has landed in Notion.
    // The pre-write bump invalidates any in-flight reader's commit-
    // time epoch check; the delete clears the stored value; the
    // post-write `set` installs the authoritative new title; the
    // post-write bump closes the dispatched-during-write window.
    this.bumpWriteEpoch()
    this.titleCache.delete(existing.id)

    // Read + append + write. Notion's v5 markdown API has no append
    // mode (per `src/notion/CLAUDE.md`); replace_content_range with
    // allow_deleting_content is the canonical edit-existing-body path.
    const existingBody = await this.client.pages.retrieveMarkdown({
      page_id: existing.id,
    })
    const nextRevision = existing.revisionCount + 1
    const today = input.today ?? todayUtc()
    const revisionBlock = [
      "",
      "---",
      "",
      `## Revision ${nextRevision} (${today})`,
      "",
      `**Title at this revision:** ${decodedTitle}`,
      "",
      decodedContent,
    ].join("\n")
    await this.client.pages.updateMarkdown({
      page_id: existing.id,
      type: "replace_content_range",
      replace_content_range: {
        content: existingBody.markdown + revisionBlock,
        content_range: "full_page",
        allow_deleting_content: true,
      },
    })

    // Property update: Title bumps, Revision Count increments,
    // synopsis / keywords / source replace if provided, confidence
    // bumps if provided. Kind / Status / topicId / projectIds /
    // lastReferencedAt / confidenceScore are NOT in this update.
    await this.client.pages.update({
      page_id: existing.id,
      properties: buildMemoryProps({
        title: decodedTitle,
        revisionCount: nextRevision,
        synopsis: decodedSynopsis,
        keywords: decodedKeywords,
        source: input.source,
        confidence: input.confidence ?? existing.confidence,
      }) as CreatePageParameters["properties"],
    })

    // Write-through: install the post-upsert title + close the
    // sandwich with a second epoch bump. Mirror of `update()`'s
    // post-write `nameCache.set` + bump.
    this.titleCache.set(existing.id, decodedTitle || null)
    this.bumpWriteEpoch()

    // Return the post-write memory shape so callers (auto-mentions,
    // session recording) read the new title / keywords / synopsis when
    // re-running entity extraction. `synopsis` and `keywords` fall
    // back to existing when caller omitted them, matching the
    // buildMemoryProps `if (input.X !== undefined)` gate behavior.
    return {
      memory: {
        ...existing,
        title: decodedTitle,
        revisionCount: nextRevision,
        synopsis: decodedSynopsis ?? existing.synopsis,
        keywords: decodedKeywords ?? existing.keywords,
        source: input.source ?? existing.source,
        confidence: input.confidence ?? existing.confidence,
      },
      revisionCount: nextRevision,
      upserted: true,
    }
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
    // Strict `=== null` matches `buildMemoryProps`' shape so update and
    // create use one consistent rule for "is this a clear or a set?"
    if (input.reviewBy !== undefined) {
      props["Review By"] =
        input.reviewBy === null ? { date: null } : { date: { start: input.reviewBy } }
    }
    if (input.decidedAt !== undefined) {
      props["Decided At"] =
        input.decidedAt === null ? { date: null } : { date: { start: input.decidedAt } }
    }
    if (input.lastReferencedAt !== undefined) {
      props["Last Referenced At"] =
        input.lastReferencedAt === null
          ? { date: null }
          : { date: { start: input.lastReferencedAt } }
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

  /**
   * Update `Last Referenced At` to today and lazily seed / decay / bump
   * `Confidence Score` for the given memories. Updates dispatch in
   * parallel via `Promise.all`. Each update is its own `pages.update`
   * (Notion has no batch-update primitive); the rate-limit middleware
   * (`src/notion/rate-limit.ts`) handles backpressure.
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
   * `confidenceScore === null`, the row is pre-0.8.0 (or
   * pre-migration). The decay anchor is `createdAt` — the row's been
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
    },
  ): Promise<void> {
    const today = opts?.today ?? todayUtc()
    await Promise.all(
      memories.map(async (memory) => {
        if (
          memory.lastReferencedAt === today &&
          memory.confidenceScore !== null
        ) {
          return
        }
        try {
          let nextScore: number
          if (memory.confidenceScore === null) {
            const seeded = seedConfidenceScore(memory.confidence)
            const decayed = decayConfidenceScore(
              seeded,
              memory.createdAt.slice(0, 10),
              today,
            )
            nextScore = bumpConfidenceScore(decayed)
          } else {
            // `lastReferencedAt` may be null on this branch in
            // theory — production callers always write both columns
            // together, but `decayConfidenceScore` is null-tolerant
            // (returns the input unchanged) so the corner case is
            // safe without a cast.
            const decayed = decayConfidenceScore(
              memory.confidenceScore,
              memory.lastReferencedAt,
              today,
            )
            nextScore = bumpConfidenceScore(decayed)
          }
          await this.client.pages.update({
            page_id: memory.id,
            properties: {
              "Last Referenced At": { date: { start: today } },
              "Confidence Score": { number: nextScore },
            },
          })
        } catch (error) {
          opts?.onError?.(memory.id, error)
        }
      }),
    )
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
   * `touchOnRead` — same convergence guarantee that a pre-migration
   * contradiction and a post-migration contradiction land on the same
   * effective current value before decrementing.
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
    opts?: { today?: string },
  ): Promise<number> {
    const today = opts?.today ?? todayUtc()
    // Mirror `touchOnRead`'s structure: gate only on the null-score
    // branch and let `decayConfidenceScore`'s null-tolerance + same-day
    // zero-stale-days behavior carry the rest. `decay(score, today,
    // today)` returns `score` (zero days elapsed); `decay(score, null,
    // today)` returns `score` (null-tolerant short-circuit). Same
    // result as the prior tri-branch shape, one call instead of two.
    let current: number
    if (memory.confidenceScore === null) {
      const seeded = seedConfidenceScore(memory.confidence)
      current = decayConfidenceScore(
        seeded,
        memory.createdAt.slice(0, 10),
        today,
      )
    } else {
      current = decayConfidenceScore(
        memory.confidenceScore,
        memory.lastReferencedAt,
        today,
      )
    }
    const next = decrementConfidenceScore(current)
    await this.client.pages.update({
      page_id: memory.id,
      properties: {
        "Confidence Score": { number: next },
        "Last Referenced At": { date: { start: today } },
      },
    })
    return next
  }

  /**
   * Paginating async iterator over every non-archived memory in this
   * service's Memories DB, optionally scoped to a single project. Yields
   * `Memory` objects (with empty `content`) in created-time-ascending
   * order so the migration's plan output is deterministic across runs.
   *
   * Two consumers: `runBuildConfidenceScoresMigration` (the 0.8.0/#11
   * baseline backfill) and `MemoryService.confidenceStats` (the
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
  async *listAllForBackfill(opts: {
    projectId?: string
  } = {}): AsyncGenerator<Memory, void, void> {
    let cursor: string | undefined
    do {
      const filter = opts.projectId
        ? projectOrUnscopedFilter(opts.projectId)
        : undefined
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "ascending" }],
        page_size: 100,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
        if (page.archived) continue
        yield this.pageToMemory(page, "")
      }
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined
    } while (cursor)
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
    lastReferencedAt: string,
  ): Promise<void> {
    await this.client.pages.update({
      page_id: memoryId,
      properties: {
        "Confidence Score": { number: score },
        "Last Referenced At": { date: { start: lastReferencedAt } },
      },
    })
  }

  /**
   * Aggregate `Confidence Score` distribution across non-archived
   * memories — the data the `lore status` confidence-summary line
   * surfaces (DEFERRED-04). Memory-side parallel of `taskStats`'s
   * closure-rate aggregation: pure read, no body fetch, optional
   * project scope.
   *
   * Walks via `listAllForBackfill` so we share one paginated iterator
   * with the 0.8.0/#11 migration. Aggregates in a single pass:
   *
   * - `totalMemories` — every non-archived row the iterator yields.
   * - `scoredMemories` — `Memory.confidenceScore !== null`. On a
   *   pre-#11 vault that hasn't run the backfill, this stays at zero
   *   and the renderer collapses the `(avg …, … below threshold)`
   *   suffix off the line accordingly.
   * - `averageScore` — arithmetic mean across scored rows. Returns
   *   `0` when no scored rows exist; the renderer suppresses the avg
   *   surface in that case via the `scoredMemories === 0` guard, so
   *   the placeholder zero never reaches the operator.
   * - `belowThreshold` — count of scored rows whose stored value is
   *   strictly below `CONFIDENCE_DISPLAY_THRESHOLD` (the same gate
   *   the trust indicator and Stale Confidence wake-up use, so all
   *   three surfaces agree on what "below threshold" means).
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
   * (`src/notion/rate-limit.ts`, default `concurrency = 3`) bounds
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
   * Pre-0.8.0 vaults (no `Confidence Score` column) work fine:
   * every yielded `Memory.confidenceScore` is `null`, so
   * `scoredMemories` / `averageScore` / `belowThreshold` all stay
   * at zero.
   */
  async confidenceStats(opts: { projectId?: string } = {}): Promise<{
    totalMemories: number
    scoredMemories: number
    averageScore: number
    belowThreshold: number
  }> {
    let totalMemories = 0
    let scoredMemories = 0
    let scoreSum = 0
    let belowThreshold = 0
    for await (const memory of this.listAllForBackfill(opts)) {
      totalMemories += 1
      if (memory.confidenceScore !== null) {
        scoredMemories += 1
        scoreSum += memory.confidenceScore
        if (memory.confidenceScore < CONFIDENCE_DISPLAY_THRESHOLD) {
          belowThreshold += 1
        }
      }
    }
    const averageScore = scoredMemories > 0 ? scoreSum / scoredMemories : 0
    return { totalMemories, scoredMemories, averageScore, belowThreshold }
  }

  /**
   * Memories that need triage: either scored low, OR long-neglected
   * regardless of stored score. Backs the Stale Confidence wake-up
   * subsection (0.8.0/#10).
   *
   * Server-side filter (when `opts.projectId` is supplied):
   *
   *     (Project contains projectId OR Project is_empty)
   *     AND Confidence Score is_not_empty
   *     AND (
   *       Confidence Score < CONFIDENCE_DISPLAY_THRESHOLD
   *       OR Last Referenced At on_or_before today - STALE_CONFIDENCE_DAYS
   *     )
   *
   * Server-side filter (vault-wide, when `opts.projectId` is omitted):
   * the project clause is dropped entirely so the query covers every
   * memory regardless of project scoping. Same posture as
   * `MemoryService.list`.
   *
   * The neglect-OR clause is load-bearing under #03's
   * **write-realized lazy decay** model. RRF (#08) reads stored
   * Confidence Score verbatim — no decay applied at read. So a memory
   * touched once 6 months ago at score 0.9 keeps a stored 0.9 (and
   * ranks high in retrieval) until something disturbs it. The
   * neglect-OR clause is what surfaces it for triage. When the agent
   * reads it, `touchOnRead` realizes the accrued decay (decay-then-bump
   * per #03), the stored score drops, and the row either continues
   * surfacing (if now actually low-score) or rotates out.
   *
   * The `is_not_empty` guard excludes pre-migration rows (null score)
   * — those have not yet been touched by any read path; flagging them
   * as stale would conflate "never scored" with "needs triage."
   * Operators backfill them via #11's
   * `lore migrate --build-confidence-scores`.
   *
   * `projectOrUnscopedFilter` matches `MemoryService.list` etc. —
   * repo-wide memories surface in the Stale Confidence section the
   * same way they surface in Recent Memories.
   *
   * Sorted by score ascending so most-decayed rows surface first;
   * neglected-but-fresh-score rows fall to the end of the list. Page
   * size = `opts.limit`; archived rows are filtered client-side
   * (matches the established Memories DS pattern). No body fetch —
   * the wake-up subsection renders title + synopsis + trust label +
   * meta only, never bodies.
   */
  async queryStaleConfidence(opts: {
    /** Omit for vault-wide wake-up; matches `MemoryService.list` shape. */
    projectId?: string
    limit: number
    /** YYYY-MM-DD anchor; same shape as `taskDaysOverdue` etc. */
    today: string
  }): Promise<Memory[]> {
    const neglectCutoff = new Date(
      new Date(opts.today).getTime() - STALE_CONFIDENCE_DAYS * MS_PER_DAY,
    )
      .toISOString()
      .slice(0, 10)

    const filters: Array<Record<string, unknown>> = []
    if (opts.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }
    filters.push({
      property: "Confidence Score",
      number: { is_not_empty: true },
    })
    filters.push({
      or: [
        {
          property: "Confidence Score",
          number: { less_than: CONFIDENCE_DISPLAY_THRESHOLD },
        },
        {
          property: "Last Referenced At",
          date: { on_or_before: neglectCutoff },
        },
      ],
    })

    const filter = { and: filters } as QueryDataSourceParameters["filter"]

    // Pre-migration vaults that haven't yet run `lore migrate` against
    // the 0.8.0 schema lack the `Confidence Score` and
    // `Last Referenced At` columns entirely. Notion responds with a
    // `validation_error` ("Could not find sort property with name or
    // id: Confidence Score") rather than an empty result, which would
    // otherwise propagate up through `loadWakeUpData`'s `Promise.all`
    // and fail the entire wake-up. Degrade to an empty section
    // instead — same posture as `FactService.queryByEntityTextOnUnmigrated`
    // and `TaskService.countClosedSince`, both of which silently
    // suppress their feature on vaults that pre-date the column they
    // depend on. The schema-drift detector
    // (`migrateVaultSchema` / `lore migrate --dry-run`) is the
    // canonical operator-facing surface for "you need to migrate";
    // wake-up itself stays decorative. Transient 5xx / rate-limit /
    // network errors do NOT match `isMissingPropertyError` and still
    // propagate so a real outage isn't masked.
    let response
    try {
      response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter,
        sorts: [{ property: "Confidence Score", direction: "ascending" }],
        page_size: opts.limit,
      })
    } catch (err) {
      if (isMissingPropertyError(err)) return []
      throw err
    }

    return response.results
      .filter(isFullPage)
      .filter((page) => !page.archived)
      .map((page) => this.pageToMemory(page as PageObjectResponse, ""))
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
      const factor = confidenceFactor(
        extractNumber(page.properties["Confidence Score"]),
      )
      if (explainBranch === "contains-only") {
        return {
          memoryId: page.id,
          containsRank: i,
          semanticRank: null,
          rrfScore: null,
          branch: "contains-only",
          confidenceFactor: factor,
        }
      }
      if (explainBranch === "semantic-only") {
        return {
          memoryId: page.id,
          containsRank: null,
          semanticRank: i,
          rrfScore: null,
          branch: "semantic-only",
          confidenceFactor: factor,
        }
      }
      const trace = hybridTrace?.get(page.id)
      return {
        memoryId: page.id,
        containsRank: trace?.containsRank ?? null,
        semanticRank: trace?.semanticRank ?? null,
        rrfScore: trace?.rrfScore ?? null,
        branch: explainBranch,
        // Hybrid trace is populated for every row that survives the merge
        // and the saturation cutoff path — both call sites populate
        // `confidenceFactor` — so the fall-through reads from there. The
        // `?? factor` belt-and-braces handles a hypothetical future
        // missing-trace path; in current code it is unreachable.
        confidenceFactor: trace?.confidenceFactor ?? factor,
      }
    })
    return { memories, explain }
  }

  /**
   * DS-scoped query path — **raw fetch**. Runs against the Memories data
   * source only, returns Notion's recency ordering verbatim. Does NOT
   * apply the confidence factor; the caller is responsible for any
   * confidence-aware reranking.
   *
   * The fetch/sort split exists because hybrid mode runs RRF over the
   * raw outputs of both branches and applies the confidence factor
   * inside its accumulator. If `searchByContainsPages` (the public,
   * confidence-aware variant) called itself or piped its sorted output
   * into hybrid, the factor would be applied twice — `factor * factor`
   * collapses the documented `[CONFIDENCE_FACTOR_MIN, 1.0]` floor to
   * `[CONFIDENCE_FACTOR_MIN², 1.0]`. Splitting into a raw-fetch helper
   * and a public sort-applier keeps the factor applied exactly once
   * per path. See `src/core/AGENTS.md` "Confidence dynamics" for the
   * pipeline contract.
   *
   * Returns raw `PageObjectResponse[]` so the caller can dedupe with other
   * paths' output before materializing markdown bodies.
   *
   * **Body matches are not searched** — Notion's `dataSources.query` filter
   * surface only exposes property predicates, not page-body text. Callers
   * that need body relevance should use `"semantic"` or rely on the
   * `"hybrid"` fallback.
   */
  private async fetchContainsPages(
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
   * Workspace-wide semantic search via `client.search` — **raw fetch**.
   * Notion's `search` endpoint returns results ranked by relevance when
   * no `sort` parameter is passed. Passing `sort` switches to recency
   * ordering and demotes the query to a lexical filter — which defeats
   * the point. We pay for a larger `page_size` instead so the client-side
   * filter to the Memories database has enough headroom when the
   * workspace contains other pages that happen to match the query
   * tokens.
   *
   * Property filters (`kind` / `status` / `tags` / `topicId`) apply as
   * client-side post-filters only — `client.search` does not accept them.
   * `projectId` post-filters with the same scope-inheritance semantics as
   * the contains path.
   *
   * Does NOT apply the confidence factor; returns Notion's relevance
   * ordering verbatim. Symmetric to `fetchContainsPages` — see that
   * helper's docstring for the fetch/sort split rationale.
   *
   * Returns raw `PageObjectResponse[]`. Markdown bodies are *not* fetched
   * here — `search()` runs `materializeMemories` once on the final
   * merged-and-capped list.
   */
  private async fetchSemanticPages(
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
   * Public DS-scoped contains path with confidence-aware reranking.
   * Calls `fetchContainsPages` for the raw Notion result, then maps each
   * row to a per-branch RRF score weighted by `confidenceFactor` and
   * sorts via `tieBreakingRrfCompare`. The factor is applied **here
   * exactly once** because hybrid does NOT consume this function — it
   * consumes `fetchContainsPages` directly. See `src/core/AGENTS.md`
   * "Confidence dynamics" for the pipeline contract.
   *
   * Behavior change vs. pre-0.8.0: `mode: "contains"` callers no longer
   * see Notion's recency order. They see confidence-reranked recency
   * order — small reranking (RRF score declines slowly per rank) but
   * a stale row at rank 3 can drop below a fresh row at rank 5 if the
   * confidence delta is large enough. Pre-migration vaults
   * (`Confidence Score = null` on every row) are unaffected because
   * `confidenceFactor(null) = 1.0` reduces the algebra to the legacy
   * `1 / (RRF_K + rank + 1)` ordering, and `tieBreakingRrfCompare`
   * preserves Notion's input order on identical scores via the page
   * id ascending fall-through... but only when ids happen to align
   * with the input order. To preserve byte-identical pre-0.8.0
   * ordering when every row is unscored, we short-circuit early.
   */
  private async searchByContainsPages(
    input: SearchMemoriesInput,
  ): Promise<PageObjectResponse[]> {
    const pages = await this.fetchContainsPages(input)
    return rerankByConfidence(pages, "contains")
  }

  /**
   * Public workspace-wide semantic path with confidence-aware reranking.
   * Symmetric to `searchByContainsPages`. Hybrid consumes
   * `fetchSemanticPages` directly so the factor is applied here exactly
   * once.
   */
  private async searchBySemanticPages(
    input: SearchMemoriesInput,
    intent: string | null,
  ): Promise<PageObjectResponse[]> {
    const pages = await this.fetchSemanticPages(input, intent)
    return rerankByConfidence(pages, "semantic")
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
    // Hybrid composes the **raw** fetch helpers, not the confidence-aware
    // public wrappers. Calling `searchByContainsPages` /
    // `searchBySemanticPages` here would double-apply the confidence
    // factor (once in the single-branch sort, once in the RRF accumulator
    // below) — collapsing the documented `[CONFIDENCE_FACTOR_MIN, 1.0]`
    // floor to `[CONFIDENCE_FACTOR_MIN², 1.0]` for hybrid callers. See
    // `src/core/AGENTS.md` "Confidence dynamics" for the pipeline split.
    const [containsResult, semanticResult] = await Promise.allSettled([
      this.fetchContainsPages(input),
      this.fetchSemanticPages(input, intent),
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
          confidenceFactor: confidenceFactor(
            extractNumber(page.properties["Confidence Score"]),
          ),
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
    // Per-row `confidenceFactor` depends only on the row's stored
    // `Confidence Score`, not on which branch surfaced it — so it's the
    // same value across both branches and is multiplied into every
    // contribution. Computing it once on first encounter (via `prev`'s
    // cache) avoids a redundant property read on cross-branch rows
    // without changing observable scores. The factor folds into the
    // per-branch contribution, not the fused score after the fact, so
    // the RRF formula stays `Σ (per-branch contribution)` — single-line
    // bookkeeping for tests pinning per-branch scores.
    const accumulate = (
      branchPages: PageObjectResponse[],
      branchKind: "contains" | "semantic",
      weight = 1,
    ) => {
      branchPages.forEach((page, rank) => {
        const prev = scored.get(page.id)
        const factor =
          prev?.confidenceFactor ??
          confidenceFactor(extractNumber(page.properties["Confidence Score"]))
        const score = (1 / (RRF_K + rank + 1)) * weight * factor
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
            confidenceFactor: factor,
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
        confidenceFactor: entry.confidenceFactor,
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
    lastReferencedAt: extractDate(props["Last Referenced At"]),
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
    topicKey: extractRichText(props["Topic Key"]),
    // Legacy rows (pre-0.9.0) have a null `Revision Count` column.
    // Coalesce to 1 — every existing row has been "saved once," so
    // formatMemoryListItem (#10) treats the count as single-revision
    // and surfaces no `rev` line. Distinct from the Confidence Score
    // path (which preserves null to signal "never scored") because
    // Revision Count carries no "uninitialized" semantic — every row
    // has been written at least once by definition.
    revisionCount: extractNumber(props["Revision Count"]) ?? 1,
    comparedWith: extractRelationIds(props["Compared With"]),
    compareNotes: extractRichText(props["Compare Notes"]),
  }
}

// ---------------------------------------------------------------------------
// Compare Notes (0.9.0/#02) — append-only NDJSON audit trail
// ---------------------------------------------------------------------------
//
// **Helper seam for #05.** The compare-notes helper family — cap, append,
// encoder, types — is exported as a single import surface from this
// module so #05's compare-write path imports everything from one
// location:
//
//     import {
//       COMPARE_NOTES_MAX_CHARS,
//       appendCompareNote,
//       encodeCompareNotesRichText,
//       type CompareNoteEntry,
//       type CompareNotesTextChunk,
//     } from "../core/memory.js"
//
// Implementation lives where the layering wants it: the pure-NDJSON
// helpers (`appendCompareNote`, `CompareNoteEntry`) stay here because
// they have no Notion dependency, and the Notion-shape helpers
// (`encodeCompareNotesRichText`, `CompareNotesTextChunk`,
// `COMPARE_NOTES_MAX_CHARS`) live in `src/notion/schema.ts` next to
// `buildMemoryProps`. Re-exporting here keeps the seam at one location
// for #05 without duplicating the implementation.
//
// `COMPARE_NOTES_MAX_CHARS` is the chokepoint cap: both `appendCompareNote`
// (every grow-step) AND `encodeCompareNotesRichText` (every write to
// `Compare Notes`, including via `buildMemoryProps`) refuse over-cap
// input. There is no path that produces an over-cap rich_text payload.
//
// Read-side decoding goes through the shared `extractRichText` extractor
// in `src/notion/extractors.ts` — no per-property wrapper is needed.
export { COMPARE_NOTES_MAX_CHARS, encodeCompareNotesRichText }
export type { CompareNotesTextChunk }

export interface CompareNoteEntry {
  verdict: string
  target: string
  reason: string
  judgedAt: string
  promptVersion: string
}

/**
 * Append one NDJSON entry to an existing `Compare Notes` string. Returns
 * the new string; throws when the appended length would exceed
 * `COMPARE_NOTES_MAX_CHARS`. The error names the cap so the operator
 * can decide whether to widen the cap (future patch) or consolidate the
 * over-compared memory via archival.
 *
 * Pure function. The serialized form is `JSON.stringify(entry)` (no
 * trailing newline on the final line, joined with `\n` for prior
 * entries) so a future `split("\n")` parser produces one entry per line
 * without an empty trailing element.
 */
export function appendCompareNote(
  existing: string,
  entry: CompareNoteEntry,
): string {
  const line = JSON.stringify(entry)
  const next = existing.length === 0 ? line : existing + "\n" + line
  if (next.length > COMPARE_NOTES_MAX_CHARS) {
    throw new Error(
      `Compare Notes overflow: appending this entry would push ` +
        `total length to ${next.length} chars (cap ` +
        `${COMPARE_NOTES_MAX_CHARS}). The memory is over-compared; ` +
        `consolidate via lore-memory action='archive' on duplicate ` +
        `pairs or split the topic.`,
    )
  }
  return next
}
