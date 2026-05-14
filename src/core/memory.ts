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

import { createHash } from "node:crypto"
import type { Client } from "@notionhq/client"
import { APIErrorCode, isNotionClientError } from "@notionhq/client"
import type {
  PageObjectResponse,
  CreatePageParameters,
  QueryDataSourceParameters,
} from "@notionhq/client"
import type {
  Memory,
  MemoryWithoutContent,
  CreateMemoryInput,
  UpdateMemoryInput,
  SearchMemoriesInput,
  SearchMode,
  SearchExplain,
  MemorySource,
  MemoryKind,
  MemoryStatus,
  MemoryConfidence,
  MemoryScopeContext,
  MemoryScopeInput,
  TaskState,
  DatabaseRef,
  FreshCreatePreparation,
} from "../types.js"
import {
  CONFIDENCE_DISPLAY_THRESHOLD,
  EXPIRING_SOON_DAYS,
  MS_PER_DAY,
  STALE_CONFIDENCE_DAYS,
  pairScopeForFactEmission,
} from "../types.js"
import {
  buildMemoryProps,
  COMPARE_NOTES_MAX_CHARS,
  encodeCompareNotesRichText,
  MEMORY_PROPS,
  type CompareNotesTextChunk,
} from "../notion/schema.js"
import { isMissingPropertyError } from "../notion/errors.js"
import { projectOrUnscopedFilter, withDefaultScopeFilter } from "../notion/filters.js"
import { decodeTextEntities } from "../notion/html-entities.js"
import {
  RunToolBlockEditError,
  RunToolSearchRestrictedError,
  RUNTOOL_SEARCH_MAX_PAGE_SIZE,
  searchViaRunTool,
  updatePageContentViaRunTool,
} from "../notion/runtool/index.js"
import { fixMemoryEncoding, type MemoryEncodingReport } from "./memory-encoding.js"
import { normalizeAgents, type AgentNormalizationReport } from "./agent-normalization.js"
import {
  findAutosaveLearningDuplicate,
  MEMORY_CLEANUP_ORPHAN_SENTINEL,
  type AutosaveLearningDuplicateMatch,
} from "./near-duplicate.js"
import { withAutosaveLearningLock } from "./autosave-learning-lock.js"
import {
  backfillSynopses,
  type BackfillOptions,
  type BackfillReport,
} from "./synopsis-backfill.js"
import { LruCache } from "./cache.js"
import { redactDebugMessage } from "../debug-redact.js"
import { validateRichTextMetadataFields } from "./rich-text-schema.js"
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
  isLiveFullPage,
  extractTitle,
  extractRichText,
  extractSelect,
  extractMultiSelect,
  extractRelationIds,
  extractDate,
  extractNumber,
} from "../notion/extractors.js"
import { collectLivePages, warnLivePageCapFired } from "../notion/live-pages.js"
import {
  hydrateRelationProperties,
  hydrateRelationPropertiesForPages,
} from "../notion/relation-properties.js"
import { fetchNearDuplicateCandidatePageIds } from "../notion/runtool/index.js"
import {
  isSqlValidationError,
  logRunToolFallback,
} from "../notion/runtool/error-helpers.js"
import { LoreError, errorCauseMessage } from "../errors.js"
import { resolveFeatureFlags, type LoreFeatureFlags } from "../feature-flags.js"
import { matchesDefaultScope } from "./memory-scope.js"
import {
  MemoryPinned,
  clampPinnedPriority,
  extractMemoryPinned,
  pinnedInputToBuilderProps,
} from "./memory-pinned.js"

export { matchesDefaultScope } from "./memory-scope.js"
export {
  MemoryPinCapExceededError,
  MemoryReadOnlyError,
  clampPinnedPriority,
  pinnedBlockAudienceMatches,
  sanitizeMemoryTitleForMessage,
} from "./memory-pinned.js"

/** Cap matches `DecisionService.idCache` (500); TTL is 60s (vs Decision's
 * 30s) because title text is cheaper-to-be-stale than decision lifecycle
 * state — a stale title only shows the wrong label until the next write
 * evicts the slot, whereas a stale decision status could mis-apply
 * governance. Titles and `Kind=decision` pages share this pool. */
const TITLE_CACHE_MAX = 500
const TITLE_CACHE_TTL_MS = 60_000
const AUTOSAVE_LEARNING_POST_CREATE_STABILIZE_MS = 500
const AUTOSAVE_LEARNING_POST_CREATE_POLL_MS = 50

function parseNonNegativeIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  if (!/^[0-9]+$/.test(raw)) return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : fallback
}

function autosaveLearningPostCreateStabilizeMs(): number {
  return parseNonNegativeIntegerEnv(
    "LORE_AUTOSAVE_LEARNING_POST_CREATE_STABILIZE_MS",
    AUTOSAVE_LEARNING_POST_CREATE_STABILIZE_MS
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Translate the agent-facing `MemoryScopeInput` bundle into the flat
 * primitive shape `buildMemoryProps` / `buildFactProps` consume. The
 * builders themselves stay one-primitive-per-Notion-column so the
 * write path is identical regardless of which surface produced the
 * scope (CLI, MCP, or internal migration).
 *
 * `undefined` input → `undefined` outputs across the board (no
 * column writes). Spread the result into the builder call so omitted
 * scopes leave the caller's surface untouched.
 */
function scopeInputToBuilderProps(scope: MemoryScopeInput | undefined): {
  scopeKind?: string | null
  scopeKey?: string
  audience?: string
  lifetime?: string | null
  expiresAt?: string | null
} {
  if (scope === undefined) return {}
  const out: ReturnType<typeof scopeInputToBuilderProps> = {}
  if (scope.kind !== undefined) out.scopeKind = scope.kind
  if (scope.key !== undefined) out.scopeKey = scope.key
  if (scope.audience !== undefined) out.audience = scope.audience
  if (scope.lifetime !== undefined) out.lifetime = scope.lifetime
  if (scope.expiresAt !== undefined) out.expiresAt = scope.expiresAt
  return out
}

/**
 * Server-side filter clause that excludes memories carrying the
 * cleanup-orphan sentinel (`MEMORY_CLEANUP_ORPHAN_SENTINEL`) in their
 * `Keywords` column.
 *
 * Threaded into every `dataSources.query` walker that surfaces live
 * memories to readers or other write paths — `findByTopicKey`,
 * `list`, `fetchContainsPages`, `listForScan`, `listAllForBackfill`,
 * `queryStaleConfidence`. The semantic-search post-filter
 * (`applySemanticPostFilters`) applies the same exclusion client-side
 * because `client.search` has no property-filter support.
 *
 * **Notion `rich_text.does_not_contain` semantics on empty values.**
 * Notion's filter contract is "the property does not contain the
 * substring" — empty rich_text columns satisfy this (nothing to
 * contain), so memories whose `Keywords` is empty are NOT silently
 * excluded. This is the intuitive answer and the only one consistent
 * with the existing `Keywords contains` filter on the contains-search
 * path. Verified empirically against the internal vault on
 * 2026-05-04 by the author; the empty-keywords unit test on
 * `findByTopicKey` pins the request shape so a future contributor
 * adding a `is_empty` short-circuit can't silently regress.
 *
 * Built as a function (not a frozen constant) so each call returns a
 * fresh literal — the `and: [...]` arrays in caller filters mutate
 * via `push` and Notion's SDK accepts the structure by-reference, so
 * sharing one constant across multiple in-flight queries on the same
 * client risks a future refactor mutating shared state.
 */
function cleanupOrphanExclusionFilter(): Record<string, unknown> {
  return {
    property: MEMORY_PROPS.KEYWORDS,
    rich_text: { does_not_contain: MEMORY_CLEANUP_ORPHAN_SENTINEL },
  }
}

/**
 * Compose the cleanup-orphan exclusion onto whatever filter shape the
 * caller already has. Three input shapes:
 *
 * - `undefined` → returns the bare exclusion clause (single-filter form).
 * - A pre-built `{ and: [...] }` → appends the clause to the array.
 * - A bare property filter → wraps both into a fresh `{ and: [...] }`.
 *
 * Centralizing the composition keeps each walker's call site
 * one-liner-clean and prevents the "two walkers diverge their filter
 * shapes" failure mode that the filter-symmetry review called out.
 */
function withCleanupOrphanExclusion(
  filter: Record<string, unknown> | undefined
): Record<string, unknown> {
  const exclusion = cleanupOrphanExclusionFilter()
  if (filter === undefined) return exclusion
  if (Array.isArray((filter as { and?: unknown[] }).and)) {
    return {
      ...filter,
      and: [...((filter as { and: unknown[] }).and as unknown[]), exclusion],
    }
  }
  return { and: [filter, exclusion] }
}

/**
 * Minimum contains-mode hit count that satisfies a hybrid query without
 * firing the workspace-wide semantic fallback. Three is chosen empirically
 * as the "Option A returns < 3 hits" threshold — small enough that a
 * niche query with one or two title matches still benefits from
 * semantic body relevance, large enough that the common case (a
 * caller searching a specific PR number, file name, or function) skips
 * the second Notion round-trip.
 */
export const HYBRID_FALLBACK_THRESHOLD = 3

/**
 * Single-source predicate for "the hybrid saturation cutoff applies."
 * Both `searchByHybridPages`'s consumer (the post-allSettled saturation
 * branch that returns contains alone) and the abort-on-saturation
 * `.then` handler attached to the contains promise read this
 * predicate. Without a shared helper, a future contributor tightening
 * the cutoff (say, adding a `containsCapped` precondition) has to
 * remember to update both sites in lockstep — a drift hazard the
 * helper closes.
 *
 * The two `intent === null` clauses are NOT redundant:
 *
 * - **Cutoff site**: `intent !== null` bypasses the cutoff so the
 * intent-augmented semantic lane gets to influence ordering under
 * RRF.
 * - **Abort site**: `intent !== null` skips the abort because aborting
 * the semantic branch would silently nullify the intent-augmented
 * semantic lane — an agent passing intent on every saturating
 * one-word query would never see semantic pagination land.
 *
 * Same predicate, same rationale, one helper.
 */
function shouldUseSaturationCutoff(
  intent: string | null,
  containsPages: readonly PageObjectResponse[]
): boolean {
  return intent === null && containsPages.length >= HYBRID_FALLBACK_THRESHOLD
}

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

/**
 * Status values whose rows are excluded from default recall.
 * These are the **review-terminal** states — rows that have either
 * left or never entered the active recall surface:
 *
 * - `proposed` — awaiting reviewer approval. Surfaced through the
 * inbox (`lore inbox list`, wake-up `Proposed Memories`); excluded
 * from `lore-query action='recall'` / `'search'` so a noisy
 * autosave-as-proposed flow cannot pollute recall. The
 * `includeProposed: true` opt-in flag exists for this case.
 * - `rejected` — a reviewer explicitly rejected the row via
 * `lore inbox reject` / `lore-memory action='reject'`. Permanently
 * off the recall surface; the audit body keeps the verdict +
 * reviewer + reason for forensics. No opt-in flag — rejected rows
 * surface only via explicit `status: "rejected"` (the audit path).
 *
 * Both are `Status: { does_not_equal: "<value>" }` server-side
 * clauses pushed onto the existing filter `and:` chain.
 */
export const REVIEW_TERMINAL_STATUSES = ["proposed", "rejected"] as const

/**
 * Default-recall exclusion filter clauses for the review-terminal
 * statuses (`proposed` / `rejected`). Returns an array because
 * Notion's select filter has no `not_in` operator — each excluded
 * value needs its own `does_not_equal` clause. Caller pushes the
 * results onto the outer `and:` chain.
 *
 * Use this from every recall surface so a future contributor adding
 * a new review-terminal state lands the change in one place. Read-
 * paths that explicitly opt in via `status: "<value>"` short-
 * circuit the exclusion at the caller level.
 */
export function reviewTerminalStatusExclusionFilters(): Array<Record<string, unknown>> {
  return REVIEW_TERMINAL_STATUSES.map((status) => ({
    property: MEMORY_PROPS.STATUS,
    select: { does_not_equal: status },
  }))
}

/**
 * Client-side post-filter predicate for the semantic-search branch.
 * `client.search` lacks property-filter support, so the
 * default-exclude has to run after the materialization. Returns
 * `true` for rows that should remain in the result set —
 * `false` for review-terminal rows to drop.
 *
 * Counterpart to `reviewTerminalStatusExclusionFilters`; both
 * encode the same predicate, the server-side and client-side
 * variants compose into the same observable behavior.
 */
export function isNotReviewTerminalStatus(page: PageObjectResponse): boolean {
  const status = extractSelect(page.properties[MEMORY_PROPS.STATUS], "informational")
  return !REVIEW_TERMINAL_STATUSES.includes(
    status as (typeof REVIEW_TERMINAL_STATUSES)[number]
  )
}

const MEMORY_RELATION_PROPERTIES = [
  MEMORY_PROPS.PROJECT,
  MEMORY_PROPS.TOPIC,
  MEMORY_PROPS.SUPERSEDES,
  MEMORY_PROPS.AFFECTS,
  MEMORY_PROPS.COMPARED_WITH,
] as const

export async function hydrateMemoryRelationProperties(
  client: Client,
  page: PageObjectResponse
): Promise<PageObjectResponse> {
  return hydrateRelationProperties(client, page, MEMORY_RELATION_PROPERTIES)
}

export async function hydrateMemoryRelationPropertiesForPages(
  client: Client,
  pages: readonly PageObjectResponse[]
): Promise<PageObjectResponse[]> {
  return hydrateRelationPropertiesForPages(client, pages, MEMORY_RELATION_PROPERTIES)
}

/**
 * Maximum number of `client.search()` pages `fetchSemanticPages` is
 * willing to fetch before yielding the post-filtered set, regardless of
 * whether the requested `limit` has been satisfied. Notion's `search`
 * endpoint returns workspace-wide hits ranked by relevance; Lore filters
 * those down to the Memories DS, so a workspace where many non-Lore
 * pages match the query tokens (or where caller-provided property
 * filters reject most of the first raw page) can starve the result
 * set even when matching memories exist past the first 100 raw hits.
 * Pagination defends against that — but a sustained-loop pull on a
 * pathological query (one that genuinely has no matches anywhere in
 * the workspace) would burn through the per-token rate-limit bucket;
 * the cap bounds blast radius.
 *
 * **Why 5.** Three quantities anchor the choice, all worst-case under
 * the cap:
 *
 * - **Scan window.** `5 × page_size: 100 = 500` raw rows. Clears the
 * post-filter-starvation case for every realistic Lore vault — an
 * internal vault audit had ~560 facts and ~1,300 memories total;
 * a 500-row scan covers most of either set in a single call.
 * - **Tail latency.** `5 × ~500ms` (typical Notion search round-trip
 * ≈ 500ms) ≈ **2.5s** maximum wall-clock for the pathological case.
 * Acceptable for a search surface that is not on session-start hot
 * paths (`loadWakeUpData` uses `list()`, not `client.search`).
 * - **Rate-limit budget.** Five sequential `client.search` calls
 * pace through the shared outbound bucket; the bucket's
 * `DEFAULT_NOTION_REQUESTS_PER_SECOND` and `_BURST_SIZE` set the
 * actual wall-clock floor. Saturation cuts this in the common case
 * — operators only pay the full cost on pathological queries.
 *
 * Loop exits early once enough filtered Lore rows are accumulated for
 * the requested `limit`, or once Notion signals `has_more: false`. The
 * cap fires only when neither saturation nor exhaustion has occurred
 * — i.e., when a real pathological query is in flight; under
 * `LORE_DEBUG=1` `debugLogSemanticSearchCapFired` surfaces a stderr
 * line so operators can distinguish that case from genuine no-matches.
 *
 * Exported for test-pinning and operator visibility. If real-query
 * feedback shows the cap is wrong, change the const; do not add a
 * per-call parameter.
 */
export const SEMANTIC_SEARCH_MAX_PAGES = 5

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
 * deterministic tie-break in `tieBreakingRrfCompare` and the explain
 * trace both read off the same authoritative state.
 *
 * `confidenceFactor` is computed once per row at the first time the row
 * is encountered (it depends only on the row's stored `Confidence
 * Score`, which doesn't change across branches) and multiplied into
 * every per-branch contribution so the fused score reflects trust
 * uniformly.
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

type SearchPagesResult = {
  pages: PageObjectResponse[]
  capped: boolean
}

/**
 * Deterministic comparator for RRF-fused entries. Ties on `score` are
 * common when both branches return rows at identical ranks — without an
 * explicit tie-break, ordering would leak from `Map` insertion order and
 * test fixtures could not pin a stable result. Tie-break levels:
 *
 * 1. Higher `score` wins (primary).
 * 2. Lower best-rank wins. `bestRank = min(containsRank ?? Infinity,
 * semanticRank ?? Infinity)`. A row that ranked #1 anywhere beats a
 * row whose best rank is #2 even when their fused scores match — the
 * score equality is a coincidence of the formula, the rank gap is
 * the real signal.
 * 3. Contains-presence wins. A row with `containsRank !== null` beats a
 * row with `containsRank === null` at equal score AND best-rank.
 * This preserves the "contains is precision" intuition the prior
 * concat-first heuristic encoded; a future contributor tempted to
 * "make tie-break symmetric" would silently shift ordering on this
 * edge case, which the test fixtures pin.
 * 4. Page id ascending. Final deterministic fallback so test fixtures
 * pin a stable order regardless of `Map` iteration.
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
 * the unmigrated-vault case (every retrieval until the
 * `--build-confidence-scores` backfill or read-touches populate
 * scores) AND defense-in-depth against a future refactor that
 * introduces score collisions on the unscored path — without that
 * gate, an arithmetic regression here could silently re-sort
 * unmigrated vaults into page-id order.
 *
 * Hybrid mode does NOT call this helper — it consumes the raw fetch
 * helpers directly and applies the factor inside its RRF accumulator.
 */
function rerankByConfidence(
  pages: PageObjectResponse[],
  branchKind: "contains" | "semantic",
  features: LoreFeatureFlags
): PageObjectResponse[] {
  if (pages.length === 0) return pages
  const allUnscored = pages.every(
    (page) => extractNumber(page.properties[MEMORY_PROPS.CONFIDENCE_SCORE]) === null
  )
  if (allUnscored) return pages
  return pages
    .map((page, rank): RrfEntry => {
      const score = extractNumber(page.properties[MEMORY_PROPS.CONFIDENCE_SCORE])
      const factor = confidenceFactor(score, features)
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
 * stderr-safe line. Mirrors the MCP-layer partial-failure logger's
 * redaction posture (only `error.message` for real Error subclasses)
 * but adds an explicit fallback for `null`/`undefined` so the log
 * line never reads `error=undefined`, which is parsable but not
 * diagnostic.
 *
 * Both branches route through `redactDebugMessage` before the
 * control-char collapse: hybrid search's rejected reasons come from
 * `dataSources.query` (contains lane) and `client.search` (semantic
 * lane), which are exactly the SDK paths most likely to interpolate
 * `InvalidPathParameterError`-style request-scoped detail and the
 * forward-compatible `body=` / `headers=` shapes the helper defends
 * against. Redaction runs first; the control-char collapse then
 * preserves the one-event-per-line invariant on the already-scrubbed
 * surface.
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
  return redactDebugMessage(raw).replace(HYBRID_LOG_CONTROL_CHARS, " ")
}

/**
 * Predicate over a `Promise.allSettled` rejection reason that recognizes
 * a cooperative-cancellation outcome from `fetchSemanticPages`'s
 * abort-aware pagination loop. Two shapes are both legitimate:
 *
 * - `DOMException` with `name === "AbortError"` — what the loop itself
 * throws when it observes `signal.aborted`. `DOMException` is a
 * global on Node 18+, so the `instanceof` check is safe in this
 * codebase.
 * - Any other thrown value whose `name` field is `"AbortError"` — a
 * defensive widening so a future refactor that swaps in `Error`-
 * subclassed abort errors (or a third-party `AbortError`) doesn't
 * silently start logging cooperative aborts as partial failures.
 *
 * `null` / `undefined` rejection reasons (`Promise.reject()`) are
 * explicitly NOT abort errors — those are real bugs in a downstream
 * helper and should surface through the partial-failure log so an
 * operator under `LORE_DEBUG=1` sees them.
 */
function isAbortRejection(reason: unknown): boolean {
  if (reason === null || reason === undefined) return false
  if (typeof DOMException !== "undefined" && reason instanceof DOMException) {
    return reason.name === "AbortError"
  }
  return (
    typeof reason === "object" &&
    "name" in reason &&
    (reason as { name: unknown }).name === "AbortError"
  )
}

/**
 * Throw a fresh `AbortError`-shaped `DOMException` when no preset reason
 * was attached to the controller. `AbortController.abort()` accepts an
 * optional `reason` argument; when omitted, the spec defaults
 * `signal.reason` to a fresh `DOMException("signal is aborted without
 * reason", "AbortError")`. We carry that shape forward inside
 * `fetchSemanticPages` so the rejection reason is meaningful for
 * `isAbortRejection` and stable across Node versions where
 * `signal.reason` semantics shifted.
 *
 * Return type is `Error` rather than `unknown` so the call site can
 * `throw buildAbortError(signal)` without tripping linters that flag
 * `throw <unknown>`. The asymmetry with `isAbortRejection`'s
 * `unknown`-typed input is intentional: we KNOW the value we synthesize
 * here is `Error`-shaped, and `isAbortRejection` widens because
 * `Promise.allSettled` rejection reasons are typed `unknown` and could
 * have originated outside this module.
 *
 * `signal.reason` is typed `any` by the DOM lib, so we narrow at the
 * boundary: when it's already an `Error` we forward it; when it's
 * anything else (an exotic value passed via `controller.abort(reason)`)
 * or `undefined` (older Node releases where `signal.reason` was not
 * spec-defaulted), we synthesize a fresh `DOMException` so the throw
 * is always an `Error`.
 */
function buildAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException("Aborted", "AbortError")
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
 * The format intentionally diverges from `debugLogPartialFailures`
 * (`root=<id> tool=<name>`): a hybrid branch isn't a Notion root id, and
 * `tool=hybrid-search` would be misleading because hybrid search is a core
 * service path, not an MCP tool. The shared contract is the
 * `[lore] partial-failure:` prefix and the `error=` field — downstream
 * parsers should match on those.
 */
function debugLogHybridBranchFailure(
  branch: "contains" | "semantic",
  reason: unknown
): void {
  if (process.env["LORE_DEBUG"] !== "1") return
  process.stderr.write(
    `[lore] partial-failure: branch=${branch} error=${rejectionToLogLine(reason)} source=hybrid-search\n`
  )
}

/**
 * Operator observability for the semantic-search **cap-fired** case.
 * Fires when `fetchSemanticPages` exhausts `SEMANTIC_SEARCH_MAX_PAGES`
 * without saturating (`accumulated.length >= limit`) and without Notion
 * reporting `has_more: false`. The cap is deliberately conservative
 * but it makes pathological-query results indistinguishable from
 * genuine no-matches in the success path. Operators triaging
 * "lore-query returned empty / short results" need a way to
 * disambiguate the two — this helper supplies the signal.
 *
 * Gated on `LORE_DEBUG=1` so the common (non-pathological) path stays
 * silent; same posture as `debugLogHybridBranchFailure`. Format mirrors
 * the established `[lore] <event>: <kv pairs> source=<surface>`
 * contract — `grep '[lore]'` aggregators see one event per occurrence.
 */
function debugLogSemanticSearchCapFired(
  pages: number,
  accumulated: number,
  limit: number
): void {
  if (process.env["LORE_DEBUG"] !== "1") return
  process.stderr.write(
    `[lore] semantic-search-cap-fired: pages=${pages} accumulated=${accumulated} limit=${limit} source=fetch-semantic-pages\n`
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
    `[lore] both-failure: contains=${rejectionToLogLine(containsReason)} semantic=${rejectionToLogLine(semanticReason)} source=hybrid-search\n`
  )
}

/**
 * Every plain-text field that flows through the agent boundary and lands
 * in a Memory page. Run them through `decodeTextEntities` before writing
 * so doubly-encoded autosave input (`&amp;amp;`) resolves to plain text
 * and future similarity / embedding surfaces see consistent values.
 * Sibling: `decodeDecisionTextFields` — keep shared field coverage
 * in lockstep.
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
      input.alternatives !== undefined
        ? decodeTextEntities(input.alternatives)
        : undefined,
    consequences:
      input.consequences !== undefined
        ? decodeTextEntities(input.consequences)
        : undefined,
    author: input.author !== undefined ? decodeTextEntities(input.author) : undefined,
    agent: input.agent !== undefined ? decodeTextEntities(input.agent) : undefined,
    keywords:
      input.keywords !== undefined ? decodeTextEntities(input.keywords) : undefined,
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
      input.alternatives !== undefined
        ? decodeTextEntities(input.alternatives)
        : undefined,
    consequences:
      input.consequences !== undefined
        ? decodeTextEntities(input.consequences)
        : undefined,
    keywords:
      input.keywords !== undefined ? decodeTextEntities(input.keywords) : undefined,
    synopsis:
      input.synopsis !== undefined ? decodeTextEntities(input.synopsis) : undefined,
    blockedBy:
      input.blockedBy !== undefined ? decodeTextEntities(input.blockedBy) : undefined,
    entity: input.entity !== undefined ? decodeTextEntities(input.entity) : undefined,
  }
}

/**
 * Structured partial-state error raised by `MemoryService.rekeyTopicKey`
 * when the `Topic Key` property write succeeded but the body
 * audit-block append failed. Surfacing this as a distinct error type
 * lets callers (the MCP layer's `toolError` rendering, future
 * operator tooling) distinguish "re-key did not happen" from "re-key
 * happened but the audit trail is missing." See `rekeyTopicKey`'s
 * docstring for the full failure-mode rationale.
 *
 * The `instanceof RekeyAuditError` check is the canonical way to
 * detect this state; the message string carries the operator-facing
 * remediation hint.
 */
export class RekeyAuditError extends LoreError<"rekey-audit-failed"> {
  readonly memoryId: string
  readonly oldTopicKey: string
  readonly newTopicKey: string
  readonly cause: unknown

  constructor(
    message: string,
    details: {
      memoryId: string
      oldTopicKey: string
      newTopicKey: string
      cause: unknown
    }
  ) {
    super(
      "rekey-audit-failed",
      message,
      {
        memoryId: details.memoryId,
        oldTopicKey: details.oldTopicKey,
        newTopicKey: details.newTopicKey,
        causeMessage: errorCauseMessage(details.cause),
      },
      { cause: details.cause }
    )
    this.name = "RekeyAuditError"
    this.memoryId = details.memoryId
    this.oldTopicKey = details.oldTopicKey
    this.newTopicKey = details.newTopicKey
    this.cause = details.cause
  }
}

/**
 * Thrown by `MemoryService.recordReview` when the target row's
 * current `Status` is not `"proposed"`. The
 * approve / reject actions are inbox-only — applying them to an
 * already-accepted, rejected, or otherwise non-proposed row would
 * be a state error that masquerades as a no-op. Callers route
 * through this distinct subclass so the MCP / CLI surfaces can
 * render an actionable error pointing at `lore-memory
 * action='update' status='<value>'` for direct status flips.
 */
export class MemoryReviewStateError extends LoreError<"memory-review-state"> {
  readonly memoryId: string
  readonly currentStatus: MemoryStatus

  constructor(
    message: string,
    details: { memoryId: string; currentStatus: MemoryStatus }
  ) {
    super("memory-review-state", message, {
      memoryId: details.memoryId,
      currentStatus: details.currentStatus,
    })
    this.name = "MemoryReviewStateError"
    this.memoryId = details.memoryId
    this.currentStatus = details.currentStatus
  }
}

/**
 * Thrown by `MemoryService.recordReview` when the `Status` property
 * write succeeded but the body audit-block append failed. Same
 * partial-state shape as `RekeyAuditError`: the load-bearing
 * status flip is durable; the cosmetic audit trail is what's
 * missing. A retry rejects with `MemoryReviewStateError` because
 * the row's `Status` has already moved off `"proposed"`. See
 * `recordReview`'s docstring for the full failure-mode rationale.
 */
export class MemoryReviewAuditError extends LoreError<"memory-review-audit-failed"> {
  readonly memoryId: string
  readonly previousStatus: MemoryStatus
  readonly newStatus: MemoryStatus
  readonly cause: unknown

  constructor(
    message: string,
    details: {
      memoryId: string
      previousStatus: MemoryStatus
      newStatus: MemoryStatus
      cause: unknown
    }
  ) {
    super(
      "memory-review-audit-failed",
      message,
      {
        memoryId: details.memoryId,
        previousStatus: details.previousStatus,
        newStatus: details.newStatus,
        causeMessage: errorCauseMessage(details.cause),
      },
      { cause: details.cause }
    )
    this.name = "MemoryReviewAuditError"
    this.memoryId = details.memoryId
    this.previousStatus = details.previousStatus
    this.newStatus = details.newStatus
    this.cause = details.cause
  }
}

/**
 * Structured partial-state error raised by the MCP-layer
 * `lore-memory action='update'` handler when a combined
 * `topicKey + content` update has the content delta land
 * successfully but the subsequent re-key reject. The content
 * mutation is durable on Notion; the re-key did not occur.
 *
 * Distinct from `RekeyAuditError`, which signals "re-key persisted
 * but audit trail missing." A `PartialUpdateError` is the inverse:
 * "content delta persisted, re-key did NOT happen." Callers that
 * need to distinguish the two cases use `instanceof`.
 *
 * Common causes: a transient Notion property-write failure during
 * `rekeyTopicKey`'s `pages.update`, a race where another agent
 * grabbed the topic-key slot between preflight and the mutation,
 * or a content-update that changed `projectIds` and exposed a new
 * collision under the post-update set. The preflight in
 * `handleUpdate` catches the most common validation failures
 * (collision against pre-update state, empty-projectIds) before
 * the content update runs; this error covers the residual cases
 * where the preflight passed but the mutation still rejected.
 */
export class PartialUpdateError extends LoreError<"memory-update-partial"> {
  readonly memoryId: string
  readonly contentApplied: true
  readonly rekeyError: unknown

  constructor(message: string, details: { memoryId: string; rekeyError: unknown }) {
    super(
      "memory-update-partial",
      message,
      {
        memoryId: details.memoryId,
        contentApplied: true,
        rekeyCauseMessage: errorCauseMessage(details.rekeyError),
      },
      { cause: details.rekeyError }
    )
    this.name = "PartialUpdateError"
    this.memoryId = details.memoryId
    this.contentApplied = true
    this.rekeyError = details.rekeyError
  }
}

/**
 * Structured partial-state error raised by `MemoryService.update`
 * when the Notion property update lands but the body markdown write
 * fails afterward. The durable hazard is asymmetry: title/tags/status
 * or other state-like properties may now reflect the attempted update
 * while the body remains at its prior value, so a caller should inspect
 * before repeating non-idempotent property transitions.
 *
 * The literal `failedPhase` / `persisted` fields intentionally mirror
 * the class name so structured in-process callers do not need to parse
 * the message. The message is prefixed with the class name because MCP
 * transports flatten errors to text.
 */
export class MemoryUpdatePartialFailureError extends LoreError<"memory-update-body-partial"> {
  readonly memoryId: string
  readonly failedPhase: "body"
  readonly persisted: { readonly properties: true; readonly body: false }
  readonly bodyWriteError: unknown

  constructor(message: string, details: { memoryId: string; bodyWriteError: unknown }) {
    const prefixedMessage = message.startsWith("MemoryUpdatePartialFailureError: ")
      ? message
      : `MemoryUpdatePartialFailureError: ${message}`
    super(
      "memory-update-body-partial",
      prefixedMessage,
      {
        memoryId: details.memoryId,
        failedPhase: "body",
        persisted: { properties: true, body: false },
        bodyWriteCauseMessage: errorCauseMessage(details.bodyWriteError),
      },
      { cause: details.bodyWriteError }
    )
    this.name = "MemoryUpdatePartialFailureError"
    this.memoryId = details.memoryId
    this.failedPhase = "body"
    this.persisted = { properties: true, body: false }
    this.bodyWriteError = details.bodyWriteError
  }
}

/**
 * Structured partial-state error raised by `MemoryService.create`
 * when the `pages.create` call landed (a Memories DB row exists) but
 * the follow-up `pages.updateMarkdown` body-write rejected. Notion's
 * SDK splits memory creation across two calls — properties first, body
 * second — and a failure between them would otherwise leave a
 * properties-only orphan in the vault that a naive retry would
 * duplicate rather than reuse.
 *
 * **Strategy: best-effort archive, then structured error.** Three
 * options were on the table when this surface was added:
 *
 * 1. *Archive/delete the orphan and throw a structured error.* The
 * chosen path. Matches `MemoryService.archive`'s soft-delete
 * posture — the row is removed from queries but remains
 * inspectable in Notion's trash, preserving audit signal for
 * operators triaging a partial-failure burst. Idempotent on the
 * hot path (a successful retry creates a fresh row, no
 * duplicate-resolution needed).
 * 2. *Throw a structured error without cleanup.* Rejected because the
 * issue's acceptance criterion is "no silently-unrecoverable
 * orphan." Naive callers retrying the same `lore-memory
 * action='save'` would land a duplicate row alongside the orphan
 * until an operator manually archived the original.
 * 3. *Idempotency key / session-aware retry path.* Rejected because
 * it would extend the schema with a new column (or co-opt an
 * existing one) for a defensive guardrail that fires on a rare
 * transient failure mode. Heavyweight relative to the bug.
 *
 * The cleanup is best-effort: a second failure leaves the orphan
 * live and surfaces as `cleanedUp: false` so the operator finishes
 * what the system couldn't.
 *
 * The `cleanedUp` flag distinguishes the two surviving partial-state
 * shapes:
 *
 * - **`cleanedUp: true`** — the orphan row is soft-deleted on Notion.
 * The vault is consistent with "create never happened" from a query
 * perspective; a retry of the original operation will create a fresh
 * row without any operator action. The error still surfaces so the
 * caller can decide whether to retry or surface the body-write
 * failure to the user.
 * - **`cleanedUp: false`** — both the body-write AND the cleanup
 * archive failed. The properties-only row remains live in the vault.
 * A retry without operator intervention would create a duplicate
 * row. The `pageId` field names the orphan; `cleanupError` carries
 * the archive failure so an operator can act on it directly.
 *
 * The `bodyWriteError` field is always populated and carries the
 * underlying `updateMarkdown` failure that triggered the partial
 * state. Distinct from `cleanupError`, which is `undefined` on
 * `cleanedUp: true`.
 *
 * **Auto-mentions / decided_by fact emission is correctly skipped on
 * partial failure.** Fact emission for `mentions` and `decided_by`
 * (decision auto-edges) is a sibling-of-create concern at the MCP
 * handler layer — those handlers fire fact creates AFTER
 * `services.memories.create` resolves so the `Source` relation can
 * point at the just-created row. A `MemoryCreatePartialFailureError`
 * thrown inside `create()` escapes the handler's `await` before fact
 * emission runs, so no orphan facts pointing at an archived (or
 * partially-archived) source land. Confirmed correct by inspection;
 * not load-bearing on any test in this file.
 *
 * Distinct from `RekeyAuditError` ("re-key persisted, audit missing")
 * and `PartialUpdateError` ("content delta persisted, re-key did not
 * happen"). Callers branch on `instanceof` to distinguish the three
 * shapes.
 */
export class MemoryCreatePartialFailureError extends LoreError<"memory-create-partial"> {
  readonly pageId: string
  readonly cleanedUp: boolean
  readonly bodyWriteError: unknown
  readonly cleanupError: unknown

  constructor(
    message: string,
    details: {
      pageId: string
      cleanedUp: boolean
      bodyWriteError: unknown
      cleanupError?: unknown
    }
  ) {
    super(
      "memory-create-partial",
      message,
      {
        pageId: details.pageId,
        cleanedUp: details.cleanedUp,
        bodyWriteCauseMessage: errorCauseMessage(details.bodyWriteError),
        ...(details.cleanupError !== undefined
          ? { cleanupCauseMessage: errorCauseMessage(details.cleanupError) }
          : {}),
      },
      { cause: details.bodyWriteError }
    )
    this.name = "MemoryCreatePartialFailureError"
    this.pageId = details.pageId
    this.cleanedUp = details.cleanedUp
    this.bodyWriteError = details.bodyWriteError
    this.cleanupError = details.cleanupError
  }
}

export interface MemoryCreateResult {
  memory: Memory
  autosaveLearningDuplicate: AutosaveLearningDuplicateMatch | null
  freshCreatePreparation: FreshCreatePreparation | null
}

/**
 * Filter / pagination / sort options accepted by `MemoryService.list`.
 * Extracted to a named type so the method's overload signatures can
 * intersect it with literal `includeContent` narrowings — see the
 * three overloads on `list()` and the `MemoryWithoutContent` shape
 * in `src/types.ts` for the absent-body type contract.
 */
export interface ListMemoriesOptions {
  projectId?: string
  topicId?: string
  source?: MemorySource
  kind?: MemoryKind
  /**
   * Negative `Kind` filter. Each entry is excluded server-side via
   * a `select.does_not_equal` clause on the `Kind` column. Mirrors
   * the existing `excludeKinds` parameter on the memory
   * near-duplicate probe; use the
   * same `excludeKinds: ["decision"]` posture when surfacing
   * "memories that need triage" without conflating with governance
   * decisions.
   *
   * Mutually exclusive with `kind` semantically (a server-side
   * `equals` already narrows to one kind). The two compose
   * literally — `kind: "note"` AND `excludeKinds: ["decision"]`
   * is well-formed but redundant — but no caller passes both.
   *
   * Notion's `does_not_equal` is permissive on null, so a row
   * with no `Kind` column set passes the filter unless it
   * happens to match a listed exclusion (it can't, since null is
   * not equal to any literal). Matches the inbox-status filter
   * posture.
   */
  excludeKinds?: MemoryKind[]
  confidence?: MemoryConfidence
  status?: MemoryStatus
  reviewBefore?: string
  tags?: string[]
  session?: string
  limit?: number
  since?: string
  until?: string
  /**
   * Opt in to fetching each page's markdown body. Default behavior
   * (omitted or `false`) returns rows with `content: ""` and issues
   * zero `pages.retrieveMarkdown` calls. Setting `true` fans out
   * one `pages.retrieveMarkdown` per row, paced by the shared
   * outbound rate-limit bucket — list views that render only title /
   * project / date / tags should leave the flag unset and pay
   * nothing. Callers that genuinely need bodies (the digest
   * synthesizer's recent-memory preview, the wake-up renderer's
   * stored-digest body, the autosave-learning duplicate probe)
   * pass `true` explicitly.
   *
   * The return type narrows on the literal value: `includeContent:
   * true` resolves to `Memory[]`; omitted or `includeContent: false`
   * resolves to `MemoryWithoutContent[]` whose `content` field is
   * the empty-string literal type `""`. A caller-controlled
   * `boolean` value cannot be statically narrowed and falls back to
   * `Memory[]` (the safe widening for the runtime fan-out).
   */
  includeContent?: boolean
  /**
   * When false, scope project queries to memories explicitly linked to the
   * given project, excluding repo-wide/unscoped entries.
   */
  includeUnscoped?: boolean
  /**
   * When `true`, do NOT exclude `Status = proposed` rows from the
   * result set. The default (`false`) adds a server-side
   * `does_not_equal: "proposed"` filter on the Status column so
   * proposed-memory inbox rows do not pollute default recall paths.
   *
   * Explicit `status` wins: when the caller passes `status:
   * "proposed"` (the inbox-review path), `includeProposed` is
   * irrelevant — the row passes via the explicit `equals` filter
   * regardless of the default exclusion.
   *
   * Set `true` for code paths that need to see every memory
   * regardless of review state — e.g. `lore mine`'s upsert
   * idempotency lookup (a re-mine must match a prior proposed
   * row), the conflict scanner (operates on every live row), or
   * the inbox-review CLI / MCP flows.
   */
  includeProposed?: boolean
  /**
   * Notion timestamp field to sort by. Defaults to `last_edited_time`
   * (general-purpose "most recently touched"). Pass `created_time` for
   * "most recently created" ordering — e.g. latest-digest lookup.
   */
  sortBy?: "created_time" | "last_edited_time"
  /**
   * Sort direction. Defaults to `"descending"` (newest first) —
   * matches Notion's recency-default. Pass `"ascending"` for
   * oldest-first ordering, e.g. the proposed-memory inbox surface
   * where stale review debt should surface ahead of recent
   * additions.
   */
  direction?: "ascending" | "descending"
  /**
   * Opaque cursor from a previous page's `nextCursor`. When provided,
   * continues enumeration from where that page ended. The filter/sort
   * must match the originating query — Notion returns the cursor's
   * contents under the assumption the query shape is unchanged.
   */
  startCursor?: string
  /**
   * When `true`, skip the default scope filter — every
   * scope kind surfaces, expired rows surface, and the resolved
   * `MemoryScopeContext` is ignored. Defaults to `false`.
   *
   * Operator-facing audit paths (`lore status` expiring-rows
   * surface, conflict scan, near-duplicate probe pool) opt in.
   * Agent-facing recall paths leave it unset so a session-scoped
   * row from another session never leaks into default retrieval.
   */
  includeOutOfScope?: boolean
}

/**
 * Per-side outcome of `MemoryService.recordCompared`. Each flag is
 * `true` when this call actually issued a `pages.update` for that side
 * (the loaded snapshot did NOT already carry a matching `(target,
 * verdict, affected)` entry) and `false` when this call SKIPPED that
 * side because the entry was already present.
 *
 * The MCP handler reads these flags to distinguish three response
 * shapes: a fresh judgment (`wroteA && wroteB`), a partial-failure
 * recovery (`wroteA !== wroteB` — one side caught up to the other),
 * and an idempotent no-op (`!wroteA && !wroteB` — both sides already
 * carried the entry, callable on top of `lore-memory action='compare'`
 * but normally short-circuited at the gate before reaching this method).
 */
export interface RecordComparedResult {
  wroteA: boolean
  wroteB: boolean
}

/**
 * Structured partial-state error raised by `MemoryService.recordCompared`
 * when exactly one of the symmetric `pages.update` writes rejected and
 * the other landed (or was skipped via per-side idempotency). The
 * caller — typically `handleCompare` — needs to know that ONE side's
 * audit-marker update is in Notion so it can self-heal by reloading the
 * survivor's now-updated `compareNotes` snapshot and retrying the missing
 * side, rather than treating the call as an opaque failure that may have
 * landed nothing.
 *
 * Distinct from `CompareDispatchPartialFailureError` (mid-dispatch fact
 * + decrement step rejection in `recordContradiction` /
 * `recordSupersedence`). This error fires strictly at the audit-marker
 * write layer — fact emission and confidence decrement already
 * succeeded before the call ever reached `recordCompared`.
 *
 * The `result` field carries the partial-success outcome so callers can
 * surface "side X landed, side Y rejected — retrying" rather than
 * silently swallowing the success. `failedSide` names the side whose
 * `pages.update` rejected; `cause` carries the underlying SDK error.
 *
 * **Both-sides failure does NOT route here.** When both writes
 * rejected, `recordCompared` throws the first rejection directly so the
 * caller can rely on the existing per-side idempotency gate to retry
 * safely against a fresh snapshot. Per-side idempotency makes the
 * both-failed case structurally equivalent to a transient error: the
 * retry sees neither audit line on either side and writes both. The
 * structured-error surface is reserved for the genuine partial-success
 * shape where one side already landed and the caller's retry MUST skip
 * it to avoid duplicating the NDJSON audit line.
 *
 * Surfaces as a typed `instanceof RecordComparedPartialWriteError`
 * check in `handleCompare`; the message string carries the partial-
 * success diagnostic for any callers that flatten through `toolError`.
 */
export class RecordComparedPartialWriteError extends LoreError<"record-compared-partial-write"> {
  readonly result: RecordComparedResult
  readonly failedSide: "A" | "B"
  readonly cause: unknown

  constructor(args: {
    message: string
    result: RecordComparedResult
    failedSide: "A" | "B"
    cause: unknown
  }) {
    super(
      "record-compared-partial-write",
      args.message,
      {
        result: args.result,
        failedSide: args.failedSide,
        causeMessage: errorCauseMessage(args.cause),
      },
      { cause: args.cause }
    )
    this.name = "RecordComparedPartialWriteError"
    this.result = args.result
    this.failedSide = args.failedSide
    this.cause = args.cause
  }
}

/**
 * Revision count at which the upsert response footer surfaces a
 * promotion advisory. When `Revision Count` post-write
 * meets this threshold, the topic chain has revised five times —
 * enough that the operator should consider whether the upsert chain
 * is still a single coherent topic or has accumulated several
 * distinct sub-topics. Tunable; the value is a starting point and
 * may need real-vault data to refine.
 */
export const PROMOTE_REVISION_THRESHOLD = 5

/**
 * Post-write body length (in characters of the assembled markdown)
 * at which the upsert response footer surfaces a promotion advisory.
 * At ~5KB the page is unwieldy to read as a single
 * artifact; the threshold is a *human-readability* heuristic, NOT a
 * Notion structural cap. Notion's documented block-per-page limits
 * drift between releases; a precise claim would invite operator
 * confusion when the limit changes.
 */
export const PROMOTE_BODY_LENGTH_THRESHOLD = 5000

/**
 * Promotion advisory surfaced by `MemoryService.upsertByTopicKey`
 * when an *append-revision* upsert (NOT a fresh create) crosses
 * either the revision-count or body-length threshold. The advisory
 * is informational: it never blocks the save and never auto-
 * promotes. The MCP layer renders the advisory as a response footer
 * so the agent or operator can decide whether to act.
 *
 * `reasons` is human-readable and may carry one or both threshold
 * crossings. `suggestion` is the ready-to-paste promotion
 * incantation — the wording is frozen (an `instanceof`-style stable
 * contract for the MCP layer's footer rendering).
 */
export interface PromotionAdvisory {
  reasons: string[]
  suggestion: string
}

interface LatestTopicRevision {
  revisionCount: number
  title: string | null
  content: string
  fingerprint: string | null
}

interface TopicUpsertSnapshot {
  kind: MemoryKind
  title: string
  content: string
  synopsis: string
  keywords: string
  source: MemorySource
  confidence: MemoryConfidence
  author: string
}

interface TopicUpsertAnalysis {
  latestRevision: LatestTopicRevision | null
  bodyMatches: boolean
  propertiesMatch: boolean
  fingerprintMatches: boolean
  bodyAheadOfProperties: boolean
}

const TOPIC_UPSERT_FINGERPRINT_PREFIX = "<!-- lore-topic-upsert-sha256: "

function topicUpsertFingerprint(input: TopicUpsertSnapshot): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: input.kind,
        title: input.title,
        content: input.content,
        synopsis: input.synopsis,
        keywords: input.keywords,
        source: input.source,
        confidence: input.confidence,
        author: input.author,
      })
    )
    .digest("hex")
}

function parseAppendedTopicRevision(
  markdown: string,
  blockStart: number,
  revisionCount: number
): LatestTopicRevision | null {
  const headerStart = blockStart + "\n---\n\n".length
  const headerEnd = markdown.indexOf("\n", headerStart)
  if (headerEnd < 0) {
    return null
  }

  const titlePrefix = "**Title at this revision:** "
  const afterHeader = markdown.slice(headerEnd + 1)
  const lines = afterHeader.split("\n")
  let lineIndex = 0
  while (lines[lineIndex] === "") {
    lineIndex += 1
  }

  let fingerprint: string | null = null
  const fingerprintLine = lines[lineIndex]
  if (fingerprintLine?.startsWith(TOPIC_UPSERT_FINGERPRINT_PREFIX)) {
    fingerprint = fingerprintLine
      .slice(TOPIC_UPSERT_FINGERPRINT_PREFIX.length)
      .replace(/ -->$/, "")
    lineIndex += 1
    if (lines[lineIndex] === "") {
      lineIndex += 1
    }
  }

  const titleLine = lines[lineIndex]
  if (!titleLine?.startsWith(titlePrefix)) {
    return null
  }

  lineIndex += 1
  if (lines[lineIndex] === "") {
    lineIndex += 1
  }

  return {
    revisionCount,
    title: titleLine.slice(titlePrefix.length),
    content: lines.slice(lineIndex).join("\n"),
    fingerprint,
  }
}

function extractLatestAppendedTopicRevision(
  markdown: string,
  options: { requireFingerprint?: boolean } = {}
): LatestTopicRevision | null {
  const revisionStart = /\n---\n\n## Revision (\d+) \([^)]+\)/g
  const matches: RegExpExecArray[] = []
  let match: RegExpExecArray | null

  while ((match = revisionStart.exec(markdown)) !== null) {
    matches.push(match)
  }

  for (const candidate of matches.reverse()) {
    if (candidate.index === undefined) continue

    const revisionCount = Number.parseInt(candidate[1] ?? "", 10)
    if (!Number.isFinite(revisionCount)) continue

    const parsed = parseAppendedTopicRevision(markdown, candidate.index, revisionCount)
    if (options.requireFingerprint && !parsed?.fingerprint) continue
    if (parsed) return parsed
  }

  return null
}

function extractAppendedTopicRevisionByCount(
  markdown: string,
  revisionCount: number
): LatestTopicRevision | null {
  const revisionPrefix = `\n---\n\n## Revision ${revisionCount} (`
  const blockStart = markdown.indexOf(revisionPrefix)
  if (blockStart < 0) {
    return null
  }

  return parseAppendedTopicRevision(markdown, blockStart, revisionCount)
}

function extractLatestTopicRevision(
  markdown: string,
  storedRevisionCount: number
): LatestTopicRevision | null {
  const fingerprintedRevision = extractLatestAppendedTopicRevision(markdown, {
    requireFingerprint: true,
  })
  if (
    fingerprintedRevision &&
    fingerprintedRevision.revisionCount >= storedRevisionCount
  ) {
    return fingerprintedRevision
  }

  if (storedRevisionCount <= 1) {
    return { revisionCount: 1, title: null, content: markdown, fingerprint: null }
  }

  return extractAppendedTopicRevisionByCount(markdown, storedRevisionCount)
}

/**
 * Pick a unique anchor string for the upsert revision-append RunTool
 * branch. Returns `null` when no safe anchor exists — caller falls back
 * to the canonical full-body `replace_content_range` path.
 *
 * The anchor is the latest fingerprinted revision's fingerprint comment
 * line plus everything that follows it through the end of the body. Two
 * load-bearing properties:
 *
 * 1. **Uniqueness.** The fingerprint hashes (kind, title, content,
 * synopsis, keywords, source, confidence, author) — content-derived,
 * so two revisions with byte-identical effective inputs would have
 * short-circuited through the no-op branch above instead of
 * appending. A non-unique fingerprint line would therefore be a
 * structural impossibility for the path that reaches here, but the
 * occurrence-count guard below makes the contract explicit and fails
 * closed if a hand-edited body somehow contains the line twice.
 *
 * 2. **Tail coverage.** The fingerprint line lives inside the latest
 * revision block, and the latest revision is, by definition, the
 * last block in the body. Anchoring on `<fp line> + <rest-to-end>`
 * means substituting the anchor for `anchor + revisionBlock`
 * semantically appends — the new revision lands strictly after the
 * previous one, preserving the document's structural ordering.
 *
 * Falls back to `null` when:
 * - no latest revision exists (first append on a body with no prior
 * revision blocks) — the legacy / un-fingerprinted shape gives no
 * safe anchor;
 * - the latest revision lacks a fingerprint (legacy un-fingerprinted
 * revision blocks predate the audit fingerprint and could collide
 * with other content);
 * - the fingerprint line does not occur exactly once in the body
 * (defensive: structural impossibility today, but the explicit guard
 * keeps a future hand-edited body from silently routing into the
 * wrong replacement).
 */
function pickRevisionAppendAnchor(
  markdown: string,
  latestRevision: LatestTopicRevision | null
): string | null {
  if (!latestRevision || latestRevision.fingerprint === null) return null
  const fpLine = `${TOPIC_UPSERT_FINGERPRINT_PREFIX}${latestRevision.fingerprint} -->`
  const idx = markdown.lastIndexOf(fpLine)
  if (idx < 0) return null
  const occurrences = markdown.split(fpLine).length - 1
  if (occurrences !== 1) return null
  return markdown.slice(idx)
}

/**
 * Pick a unique tail anchor for the rekey audit-block append branch.
 * Returns `null` when no anchor with exactly one occurrence in the body
 * is available — caller falls back to the canonical
 * `replace_content` full-body path while preserving the
 * `RekeyAuditError` partial-state contract.
 *
 * Strategy: take the trailing slice of the body (capped at
 * `REKEY_TAIL_ANCHOR_BYTES`) and verify it occurs exactly once. The
 * tail must be unique by virtue of the body terminating there — any
 * substring that happens to repeat earlier defeats the uniqueness
 * guarantee, so the count-occurrences guard is load-bearing.
 *
 * Unlike the revision-append branch, there is no structural fingerprint
 * to anchor on: re-keys do not carry content-derived hashes (the audit
 * block names the old/new keys, not a fingerprint over them). The
 * tail-with-uniqueness check is the strongest invariant available
 * without changing the body schema.
 */
const REKEY_TAIL_ANCHOR_BYTES = 256

function pickRekeyAuditAnchor(content: string): string | null {
  if (content.length === 0) return null
  const tail = content.slice(Math.max(0, content.length - REKEY_TAIL_ANCHOR_BYTES))
  const occurrences = content.split(tail).length - 1
  if (occurrences !== 1) return null
  return tail
}

/** Construct the canonical `RekeyAuditError` for a partial-state
 * failure. The `cause`'s message is routed through the shared
 * `redactDebugMessage` so a Notion error carrying a workspace id /
 * page-id substring (rare but possible on auth-shaped errors) does
 * not bypass the redactor. The original `err` is still attached as
 * `cause` on the structured error so callers branching via
 * `instanceof RekeyAuditError` retain access to the underlying SDK
 * shape — only the rendered `message` is scrubbed.
 *
 * Keeping a single helper for both the RunTool and REST audit
 * failure surfaces ensures the error shape and redaction posture
 * cannot drift between the two transports. */
function buildRekeyAuditError(
  memoryId: string,
  oldTopicKey: string,
  newTopicKey: string,
  err: unknown
): RekeyAuditError {
  const rawMessage = err instanceof Error ? err.message : String(err)
  const cause = redactDebugMessage(rawMessage)
  return new RekeyAuditError(
    `Re-key persisted ('${oldTopicKey || "(unset)"}' → '${newTopicKey}') ` +
      `but audit-block append failed: ${cause}. The Topic Key column is ` +
      `updated; the body audit trail is missing. A retry will short-circuit ` +
      `as a no-op — the audit block cannot be recovered automatically. ` +
      `Inspect memory ${memoryId} on Notion to confirm and append the audit ` +
      `manually if needed.`,
    { memoryId, oldTopicKey, newTopicKey, cause: err }
  )
}

/** Emit one stderr line under `LORE_DEBUG=1` when `rekeyTopicKey`'s
 * RunTool branch is enabled but the body's tail anchor is not unique
 * (typically because the body has accumulated repetitive structures
 * like multiple `## Re-keyed (...)` audit blocks).
 *
 * Same posture as the existing `[lore] semantic-search-cap-fired`
 * emission — silent under default logging, observable when the
 * operator is debugging. Without this signal an operator running
 * flag-on against a corpus with repetitive tails would see RunTool
 * engaged for some calls and not others with no diagnostic.
 *
 * Bodies for which the anchor IS unique (the common case) emit
 * nothing; this is strictly the no-anchor diagnostic surface. */
function debugLogRekeyAnchorMiss(memoryId: string, bodyLength: number): void {
  if (process.env["LORE_DEBUG"] !== "1") return
  process.stderr.write(
    `[lore] rekey-anchor-miss: memory=${memoryId} body-length=${bodyLength} ` +
      `source=pickRekeyAuditAnchor\n`
  )
}

function analyzeLatestTopicUpsert(
  input: TopicUpsertSnapshot,
  existing: Memory,
  markdown: string
): TopicUpsertAnalysis {
  const latestRevision = extractLatestTopicRevision(markdown, existing.revisionCount)
  if (!latestRevision) {
    return {
      latestRevision: null,
      bodyMatches: false,
      propertiesMatch: false,
      fingerprintMatches: false,
      bodyAheadOfProperties: false,
    }
  }

  const bodyTitleMatches =
    latestRevision.title === null
      ? existing.title === input.title
      : latestRevision.title === input.title
  const bodyMatches = bodyTitleMatches && latestRevision.content === input.content
  const propertiesMatch =
    existing.title === input.title &&
    existing.synopsis === input.synopsis &&
    existing.keywords === input.keywords &&
    existing.source === input.source &&
    existing.confidence === input.confidence &&
    existing.author === input.author

  return {
    latestRevision,
    bodyMatches,
    propertiesMatch,
    fingerprintMatches: latestRevision.fingerprint === topicUpsertFingerprint(input),
    bodyAheadOfProperties: latestRevision.revisionCount > existing.revisionCount,
  }
}

/**
 * Pure helper that returns a `PromotionAdvisory` when at least one
 * threshold is met, or `null` when neither is. The boundary semantics
 * are inclusive (`>=`) so a value AT the threshold fires the
 * advisory — pinned by tests so a future contributor can't silently
 * shift to strict-greater and quietly raise the firing point.
 *
 * Both reasons surface in the order revision-count → body-length so
 * the rendered footer reads consistently; multi-reason firings
 * preserve that order.
 *
 * **Suggestion wording is kind-aware.** Topic-key chains are valid
 * for `decision`, `runbook`, `incident`, `postmortem`, and `policy`
 * kinds. Only `kind: 'decision'` memories can be superseded via
 * `lore-decision action='create'` with `supersedesIds`:
 * `DecisionService.getById` (the resolver the create handler runs
 * for every supersedesIds entry) throws on non-decision kinds, so a
 * footer that handed a runbook/incident/postmortem/policy operator
 * `supersedesIds: [<this-id>]` would be a ready-to-paste BROKEN
 * command. Decisions get the supersede-and-split wording; other
 * kinds get the split-and-archive path that doesn't depend on a
 * decision-only API. The `<this-memory-id>` placeholder appears in
 * the decision-kind branch only and is replaced by the rendering
 * layer.
 */
export function computePromotionAdvisory(input: {
  revisionCount: number
  bodyLength: number
  kind: MemoryKind
}): PromotionAdvisory | null {
  const reasons: string[] = []
  if (input.revisionCount >= PROMOTE_REVISION_THRESHOLD) {
    reasons.push(`${input.revisionCount} revisions accumulated`)
  }
  if (input.bodyLength >= PROMOTE_BODY_LENGTH_THRESHOLD) {
    reasons.push(`body length ${input.bodyLength} chars`)
  }
  if (reasons.length === 0) return null
  const suggestion =
    input.kind === "decision"
      ? "Consider promoting via lore-decision action='create' " +
        "with supersedesIds: [<this-memory-id>], or splitting " +
        "the topic into narrower topicKeys."
      : "Consider splitting the topic into narrower topicKeys, " +
        "or archiving this chain via lore-memory action='archive' " +
        "and starting a fresh chain with a more specific topicKey."
  return { reasons, suggestion }
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
   * Pre-PF1-09 this race protection lived here as a `writeEpoch`
   * monotonic counter with sandwich-bump discipline; folding the
   * invariant into `LruCache.set` collapsed ~30 lines of bespoke code
   * onto the shared primitive.
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
  private readonly pinned: MemoryPinned

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
    this.pinned = new MemoryPinned(
      client,
      db,
      () => this.scopeCtx,
      () => this.scopeFilterEnabled,
      (pages, includeContent) => this.materializeMemories(pages, includeContent)
    )
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
    validateRichTextMetadataFields(input, "MemoryService.create")

    const duplicateConfig = this.autosaveLearningDuplicateConfig(input)
    const lockKey = duplicateConfig
      ? `autosave-learning:${duplicateConfig.scope}:` +
        (duplicateConfig.scope === "project"
          ? duplicateConfig.projectIds.join(",")
          : `${duplicateConfig.scopeId ?? "global"}\0${duplicateConfig.session}`)
      : null

    return await withAutosaveLearningLock(lockKey, async () => {
      if (duplicateConfig) {
        const decoded = decodeMemoryTextFields(input)
        const duplicate = await findAutosaveLearningDuplicate(this, {
          title: decoded.title,
          content: decoded.content,
          projectId: duplicateConfig.projectIds[0],
          projectIds: duplicateConfig.projectIds,
          session: duplicateConfig.session,
          scope: duplicateConfig.scope,
          features: this.features,
        })
        if (duplicate) {
          return {
            memory: duplicate.memory,
            autosaveLearningDuplicate: duplicate,
            freshCreatePreparation: null,
          }
        }
      }

      const freshCreatePreparation = input.prepareFreshCreate
        ? await input.prepareFreshCreate()
        : null
      const freshInput = freshCreatePreparation
        ? { ...input, ...freshCreatePreparation.input }
        : input
      const memory = await this.createFresh(freshInput)
      if (duplicateConfig) {
        await this.waitForAutosaveLearningIndexStability(
          duplicateConfig,
          memory,
          freshInput
        )
      }

      return {
        memory,
        autosaveLearningDuplicate: null,
        freshCreatePreparation,
      }
    })
  }

  private autosaveLearningDuplicateConfig(
    input: CreateMemoryInput
  ):
    | { scope: "session"; session: string; projectIds: string[]; scopeId: string | null }
    | { scope: "project"; session: string; projectIds: string[]; scopeId: string | null }
    | null {
    if (
      input.autosaveLearningDedupScope === "off" ||
      !this.features.autosaveLearningDedup ||
      !this.features.nearDuplicateProbe
    ) {
      return null
    }
    if ((input.source ?? "manual") !== "conversation") return null
    if ((input.kind ?? "note") !== "note") return null
    if (input.confidence !== "likely") return null

    const session = input.session?.trim()
    if (!session) return null

    const projectIds = [...new Set(input.projectIds ?? [])].sort()
    const requestedScope =
      input.autosaveLearningDedupScope ?? (projectIds.length > 0 ? "project" : "session")
    const scope =
      requestedScope === "project" && projectIds.length > 0 ? "project" : "session"
    const scopeId = input.autosaveLearningScopeId?.trim() || null

    return { scope, session, projectIds, scopeId }
  }

  private async waitForAutosaveLearningIndexStability(
    duplicateConfig:
      | {
          scope: "session"
          session: string
          projectIds: string[]
          scopeId: string | null
        }
      | {
          scope: "project"
          session: string
          projectIds: string[]
          scopeId: string | null
        },
    memory: Memory,
    input: CreateMemoryInput
  ): Promise<void> {
    const timeoutMs = autosaveLearningPostCreateStabilizeMs()
    if (timeoutMs <= 0) return

    const decoded = decodeMemoryTextFields(input)
    const deadline = Date.now() + timeoutMs
    while (true) {
      try {
        const visible = await findAutosaveLearningDuplicate(this, {
          title: decoded.title,
          content: decoded.content,
          projectId: duplicateConfig.projectIds[0],
          projectIds: duplicateConfig.projectIds,
          session: duplicateConfig.session,
          scope: duplicateConfig.scope,
          features: this.features,
        })
        if (visible?.id === memory.id) return
      } catch {
        // The memory already landed. A transient read-side failure should not
        // convert the successful create into a partial failure; future writers
        // still fail closed on their own duplicate probe while Notion recovers.
      }

      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) return
      await sleep(Math.min(AUTOSAVE_LEARNING_POST_CREATE_POLL_MS, remainingMs))
    }
  }

  private async createFresh(input: CreateMemoryInput): Promise<Memory> {
    // Decode at the write boundary so doubly-encoded values from the
    // autosave/markdown path land in Notion as plain text. Idempotent: a
    // clean value passes through unchanged. Covers every plain-text
    // field that flows through the agent boundary — title, content body,
    // and the rich_text fields that downstream similarity/embedding
    // surfaces (near-duplicate probe, entity canonicalization,
    // DS-scoped search) will read.
    const decoded = decodeMemoryTextFields(input)
    const createsPinnedBlock = input.pinned?.pinned === true
    await this.pinned.preflightCreate(input.pinned)

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
        ...scopeInputToBuilderProps(input.scope),
        ...pinnedInputToBuilderProps(input.pinned),
      }),
    })
    if (createsPinnedBlock) {
      this.pinned.invalidateCountCache()
    }

    // Write content via markdown API. The SDK splits memory creation
    // across two calls — properties above, body below — so a rejection
    // here would otherwise leave a properties-only orphan that a naive
    // retry would duplicate. Best-effort archive the orphan, then
    // surface a structured error carrying enough state for the caller
    // to retry safely or surface the failure to the operator. See
    // `MemoryCreatePartialFailureError`.
    if (decoded.content) {
      try {
        await this.client.pages.updateMarkdown({
          page_id: page.id,
          type: "insert_content",
          insert_content: { content: decoded.content },
        })
      } catch (bodyWriteError) {
        // Direct `pages.update` rather than `MemoryService.archive()`:
        // the page was just created in this same call, so the
        // title-cache delete-then-tombstone-set discipline `archive()`
        // performs to protect concurrent readers cannot apply — no
        // consumer has had time to cache the title or dispatch a
        // racing read against this id. Inlining keeps the cleanup a
        // single round-trip with no incidental cache work.
        //
        // Cleanup writes BOTH `archived: true` AND the
        // `MEMORY_CLEANUP_ORPHAN_SENTINEL` keyword in one atomic
        // `pages.update`. Notion's archive is soft —
        // within ~30 days the orphan can be restored from the workspace
        // trash, at which point `isLiveFullPage` stops excluding it.
        // The sentinel keyword survives archive/restore round-trips and
        // is the load-bearing signal for `findByTopicKey`,
        // `findNearDuplicates`, and `findAutosaveLearningDuplicate`
        // ignoring the resurfaced empty-body shell. Combining the two
        // mutations into one request closes the window where archive
        // succeeds but the sentinel write fails — Notion's per-request
        // atomicity guarantees both land or neither does.
        //
        // **Keyword preservation**. Notion's `rich_text` writes are
        // full-replace, not append. Writing only the sentinel would
        // clobber whatever the caller passed in `decoded.keywords`,
        // which an operator inspecting Notion's trash would see as
        // "your original keywords are gone" — the sentinel and the
        // user's content. Concatenating preserves both: the sentinel
        // substring still satisfies the `does_not_contain` /
        // `keywords.includes` filters, and the original keywords
        // remain visible if the operator restores the row to recover
        // content. Use a single-space separator so the sentinel is
        // word-tokenizable in any future tag-aware view; an empty
        // existing keywords field collapses to bare-sentinel.
        //
        // **Multi-segment write at the cap edge**. Notion's per-block
        // `rich_text` segment cap is 2000 chars
        // (`RICH_TEXT_PROPERTY_MAX_LEN`), and the MCP boundary's
        // `keywordsSchema` accepts keywords up to exactly that cap.
        // Concatenating ` __lore-cleanup-orphan` (22 chars) onto a
        // 2000-char keyword string would produce a 2022-char single
        // segment that Notion rejects with a validation error. A
        // rejected cleanup write means `cleanedUp = false` and the
        // orphan stays live in the vault — exactly the partial-failure
        // recovery regression the sentinel-write path is meant to
        // prevent. Splitting
        // into two segments — `[originalKeywords, " sentinel"]` —
        // keeps each segment well under the cap; `extractRichText`
        // joins them via empty-string concat, so the substring filter
        // (`does_not_contain` server-side, `keywords.includes`
        // client-side) still sees the unified `original sentinel`
        // string. Always use the two-segment form when keywords are
        // present so the at-cap edge is handled by the same code path
        // as the under-cap normal case — no segment-size math at write
        // time, no edge-case branching.
        const existingKeywords = decoded.keywords?.trim() ?? ""
        const cleanupKeywordsRichText: Array<{ text: { content: string } }> =
          existingKeywords.length > 0
            ? [
                { text: { content: existingKeywords } },
                { text: { content: ` ${MEMORY_CLEANUP_ORPHAN_SENTINEL}` } },
              ]
            : [{ text: { content: MEMORY_CLEANUP_ORPHAN_SENTINEL } }]
        let cleanedUp = false
        let cleanupError: unknown
        try {
          await this.client.pages.update({
            page_id: page.id,
            archived: true,
            properties: {
              [MEMORY_PROPS.KEYWORDS]: {
                rich_text: cleanupKeywordsRichText,
              },
            },
          })
          cleanedUp = true
        } catch (err) {
          cleanupError = err
        }
        const cause =
          bodyWriteError instanceof Error
            ? bodyWriteError.message
            : String(bodyWriteError)
        const message = cleanedUp
          ? `Memory create partial failure: the Memories DB row was ` +
            `created (page ${page.id}) but the body write failed: ${cause}. ` +
            `The orphan row was soft-archived to Notion's trash and its ` +
            `Keywords column carries the '${MEMORY_CLEANUP_ORPHAN_SENTINEL}' ` +
            `sentinel so dedup probes ignore it even if it is later restored ` +
            `from trash. Your retry will land cleanly regardless of whether ` +
            `you restore this row from trash later.`
          : `Memory create partial failure: the Memories DB row was ` +
            `created (page ${page.id}) but the body write failed: ${cause}. ` +
            `The cleanup archive also failed (${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }); the orphan row remains live in the vault. Archive it ` +
            `manually (or hard-delete from Notion's trash) before retrying ` +
            `to avoid a duplicate row.`
        throw new MemoryCreatePartialFailureError(message, {
          pageId: page.id,
          cleanedUp,
          bodyWriteError,
          cleanupError,
        })
      }
    }

    return await this.pageToMemory(page as PageObjectResponse, decoded.content ?? "")
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

  /**
   * Find at most one non-archived memory matching a `(Topic Key,
   * Project-set)` pair, ordered by `Revision Count` desc with
   * `Last Referenced At` desc as the tiebreaker. The shared lookup
   * helper for the topic-key upsert and the re-key repair paths —
   * both consume this so neither hard-depends on the other. Two
   * short-circuit guards defend against accidental whole-vault
   * matches: empty `topicKey` and empty `projectIds` both return
   * null without issuing any Notion query.
   *
   * **Empty `topicKey` guard.** Per the schema contract, empty
   * string and missing both mean "no upsert grouping" — there is
   * no canonical row to find. Without this guard, an upsert caller
   * that forgets to gate on `topicKey === ""` would issue
   * `rich_text: { equals: "" }` to Notion, which matches every
   * legacy row whose Topic Key column is empty (i.e. every
   * memory without a declared topic key). The JS post-filter would
   * narrow to the project set and return the highest-`Revision
   * Count` legacy memory — silently appending a revision onto an
   * arbitrary unrelated row. The parameter type is `string` (not
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
   * key, regardless of Kind. This is what the re-key path needs for
   * collision detection: if a re-key would land on an existing
   * task or decision, the helper must surface that collision so the
   * re-key can reject. Callers that want kind-specific upsert
   * semantics layer a Kind filter at their own boundary; the helper
   * stays Kind-agnostic so the single primitive serves both consumers.
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
    //
    // The `Keywords does_not_contain MEMORY_CLEANUP_ORPHAN_SENTINEL`
    // clause (composed via `withCleanupOrphanExclusion`) excludes
    // resurfaced cleanup-orphans. A properties-only orphan archived
    // after a partial-create failure can be restored from Notion's
    // trash, at which point `isLiveFullPage` stops excluding it; the
    // sentinel keyword written in the same `pages.update` as the
    // archive survives the round-trip and steers the upsert path
    // away from the empty-body shell.
    let cursor: string | undefined = undefined
    do {
      const page = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: withCleanupOrphanExclusion({
          and: [
            { property: MEMORY_PROPS.TOPIC_KEY, rich_text: { equals: input.topicKey } },
            ...input.projectIds.map((id) => ({
              property: MEMORY_PROPS.PROJECT,
              relation: { contains: id },
            })),
          ],
        }) as QueryDataSourceParameters["filter"],
        start_cursor: cursor,
      })
      for (const r of page.results) {
        if (isLiveFullPage(r)) allResults.push(r)
      }
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined
    } while (cursor !== undefined)

    const inputSet = new Set(input.projectIds)
    const memories = await Promise.all(
      allResults.map((page) => this.pageToMemory(page, ""))
    )
    const matches = memories.filter(
      (m) =>
        m.projectIds.length === inputSet.size &&
        m.projectIds.every((id) => inputSet.has(id))
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
   * Topic-key upsert. Either appends a revision block to an existing
   * memory or creates a fresh one. The match key is `(Topic Key,
   * Project-set)`; project equality is set-equal (same IDs, same count),
   * resolved by `findByTopicKey`.
   *
   * **Kind-mismatch validation runs BEFORE any Notion write.** The
   * kind check fires immediately after `findByTopicKey` returns, NOT
   * after the body read/write. Validation after `retrieveMarkdown` +
   * `updateMarkdown` would be a real correctness bug because a
   * kind-mismatched upsert would append a revision block to the page
   * before rejecting.
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
   * handled by the lookup; not a separate throw at this layer.
   * - **PRESERVE silently** (input dropped, no warning): Status,
   * Topic relation. State transitions belong on `lore-memory
   * action='update'`; the upsert path treats these as forgotten-to-
   * omit envelopes.
   * - **REPLACE on every save** (latest write wins): Title, Synopsis,
   * Keywords, Source. Confidence (categorical) bumps if input
   * provides one.
   * - **UNTOUCHED**: Confidence Score (system-managed by the
   * read-path decay pipeline), Last Referenced At (read-citation
   * signal owned by `touchOnRead`).
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
   * with `content_range: "full_page"` for edits to an existing body.
   * There is no append mode, so the upsert path always reads existing
   * markdown and writes back the concatenation. Two API calls per
   * upsert.
   *
   * **Retry idempotency.** Calling upsert twice with identical
   * effective inputs does NOT append a second revision. The append
   * branch reads the latest stored body and skips the write when the
   * caller's title/content plus replace-on-save metadata already match
   * the row's current state. If a previous attempt landed the body
   * append but failed before the property update, the retry repairs the
   * row properties only when the revision's stored fingerprint matches
   * the effective retry input. Otherwise body-ahead saves append from
   * the markdown revision count, not the stale property count. Only
   * fingerprinted revisions can advance that base beyond the stored
   * `Revision Count`; legacy unfingerprinted revisions remain readable
   * at the stored count for no-op compatibility. A body, title,
   * synopsis, keywords, source, confidence, or author change on a
   * complete chain still appends a new revision. Full-match retries
   * return no advisory because the original successful write already
   * surfaced it; repair retries recompute the advisory because the
   * original response never reached the caller.
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
    author?: string
    agent?: string
    session?: string
    reviewBy?: string
    decidedAt?: string
    today?: string
    /**
     * Scope / lifetime declaration. On fresh-create the
     * scope columns land verbatim; on append-revision the scope is
     * silently preserved (revisions inherit the head row's scope —
     * agents change scope through `lore-memory action='update'`).
     */
    scope?: MemoryScopeInput
  }): Promise<{
    memory: Memory
    revisionCount: number
    upserted: boolean
    promotionAdvisory: PromotionAdvisory | null
  }> {
    validateRichTextMetadataFields(input, "MemoryService.upsertByTopicKey")

    if (input.projectIds.length === 0) {
      throw new Error(
        "topicKey requires at least one projectId. " +
          "Projectless memories cannot upsert."
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
        author: input.author,
        agent: input.agent,
        session: input.session,
        reviewBy: input.reviewBy,
        decidedAt: input.decidedAt,
        topicKey: input.topicKey,
        revisionCount: 1,
        // Scope / lifetime is preserved verbatim on fresh-create;
        // append-revision intentionally skips the scope write below
        // because revisions inherit the head row's scope.
        scope: input.scope,
      })
      // Fresh-create never returns a promotion advisory. The
      // advisory is specifically about revision-chain accumulation; a
      // one-shot write with a long body is a different signal that
      // warrants a different surface.
      return {
        memory: created,
        revisionCount: 1,
        upserted: false,
        promotionAdvisory: null,
      }
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
          `kind, or supersede via lore-decision action='create'.`
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
    const decodedAuthor =
      input.author !== undefined ? decodeTextEntities(input.author) : undefined
    const authorForUpdate = decodedAuthor || existing.author

    // Read before deciding whether to append. Notion's v5 markdown API
    // has no append mode, and the body is the only place the latest
    // revision content lives.
    const existingBody = await this.client.pages.retrieveMarkdown({
      page_id: existing.id,
    })

    const upsertSnapshot = {
      kind: input.kind,
      title: decodedTitle,
      content: decodedContent,
      synopsis: decodedSynopsis ?? existing.synopsis,
      keywords: decodedKeywords ?? existing.keywords,
      source: input.source ?? existing.source,
      confidence: input.confidence ?? existing.confidence,
      author: authorForUpdate,
    }
    const upsertAnalysis = analyzeLatestTopicUpsert(
      upsertSnapshot,
      existing,
      existingBody.markdown
    )

    if (
      upsertAnalysis.bodyMatches &&
      upsertAnalysis.bodyAheadOfProperties &&
      upsertAnalysis.fingerprintMatches
    ) {
      const repairedRevisionCount = upsertAnalysis.latestRevision!.revisionCount
      const titleChanged = decodedTitle !== existing.title
      if (titleChanged) {
        this.titleCache.delete(existing.id)
      }
      await this.client.pages.update({
        page_id: existing.id,
        properties: buildMemoryProps({
          title: decodedTitle,
          revisionCount: repairedRevisionCount,
          synopsis: decodedSynopsis,
          keywords: decodedKeywords,
          source: input.source,
          confidence: input.confidence ?? existing.confidence,
          author: authorForUpdate,
        }) as CreatePageParameters["properties"],
      })
      if (titleChanged) {
        this.titleCache.set(existing.id, decodedTitle || null)
      }

      const promotionAdvisory = computePromotionAdvisory({
        revisionCount: repairedRevisionCount,
        bodyLength: existingBody.markdown.length,
        kind: input.kind,
      })

      return {
        memory: {
          ...existing,
          title: decodedTitle,
          revisionCount: repairedRevisionCount,
          synopsis: decodedSynopsis ?? existing.synopsis,
          keywords: decodedKeywords ?? existing.keywords,
          source: input.source ?? existing.source,
          confidence: input.confidence ?? existing.confidence,
          author: authorForUpdate,
        },
        revisionCount: repairedRevisionCount,
        upserted: true,
        promotionAdvisory,
      }
    }

    if (
      upsertAnalysis.bodyMatches &&
      upsertAnalysis.propertiesMatch &&
      !upsertAnalysis.bodyAheadOfProperties
    ) {
      return {
        memory: existing,
        revisionCount: existing.revisionCount,
        upserted: true,
        promotionAdvisory: null,
      }
    }

    // Title-cache delete matches the discipline `update()` uses.
    // Upserts that reach the write branch always bump Title, so the
    // same write-through pattern that protects `update()` from
    // concurrent `getTitleById`
    // callers applies here. Without this, render-layer resolvers
    // would keep returning the pre-upsert title from `titleCache`
    // until the 60s TTL expired even though the new title has landed
    // in Notion. The pre-write delete clears the stored value AND drops
    // any in-flight `getOrLoad` pending slot; the post-write `set`
    // installs the authoritative new title and (via `LruCache.set`'s
    // pending-clearing discipline) suppresses any stale loader's
    // commit dispatched mid-flight.
    this.titleCache.delete(existing.id)

    // Append + write. Notion's v5 markdown API has no append mode;
    // replace_content_range with allow_deleting_content is the
    // canonical edit-existing-body path. When `LORE_USE_RUNTOOL_BLOCK_EDIT`
    // is on AND the previous revision carries a fingerprint we can
    // anchor on, a RunTool `update_content` call substitutes only the
    // tail of the body — the server splices the new
    // revision in-place instead of rewriting the whole page. The
    // wrapper raises a `RunToolBlockEditError` for the four
    // structured fall-back kinds (`no_match` / `multiple_matches` /
    // `deletion_warning` / `restricted_resource`), and we fall back
    // to the canonical full-body path on those so the save always
    // lands. Transient transport errors (401 / 429 / 5xx /
    // malformed) propagate verbatim so the auth-refresh proxy and
    // shared 429 backoff stay authoritative.
    const baseRevisionCount =
      upsertAnalysis.latestRevision &&
      upsertAnalysis.latestRevision.revisionCount > existing.revisionCount
        ? upsertAnalysis.latestRevision.revisionCount
        : existing.revisionCount
    const nextRevision = baseRevisionCount + 1
    const today = input.today ?? todayUtc()
    const revisionBlock = [
      "",
      "---",
      "",
      `## Revision ${nextRevision} (${today})`,
      "",
      `${TOPIC_UPSERT_FINGERPRINT_PREFIX}${topicUpsertFingerprint(upsertSnapshot)} -->`,
      "",
      `**Title at this revision:** ${decodedTitle}`,
      "",
      decodedContent,
    ].join("\n")

    const anchor = pickRevisionAppendAnchor(
      existingBody.markdown,
      upsertAnalysis.latestRevision
    )
    const useRunToolAnchor = this.features.runTool.blockEdit && anchor !== null
    let bodyEditApplied = false
    if (useRunToolAnchor && anchor) {
      try {
        await updatePageContentViaRunTool(this.client, {
          pageId: existing.id,
          updates: [{ oldStr: anchor, newStr: anchor + revisionBlock }],
        })
        bodyEditApplied = true
      } catch (err) {
        if (!(err instanceof RunToolBlockEditError)) throw err
        // Fall through to the full-body path on every structured
        // fall-back signal: `no_match` / `multiple_matches` /
        // `deletion_warning` (validation-class) AND
        // `restricted_resource` (403 capability rejection — the
        // auth-refresh proxy cannot repair this, but the existing
        // REST/SDK path can). A future contributor narrowing the
        // catch (e.g. on `kind === "no_match"` only) would silently
        // re-introduce the integration-secret outage; the
        // `restricted_resource` integration test would fail loudly.
      }
    }
    const assembledBodyLength = existingBody.markdown.length + revisionBlock.length
    if (!bodyEditApplied) {
      const assembledBody = existingBody.markdown + revisionBlock
      await this.client.pages.updateMarkdown({
        page_id: existing.id,
        type: "replace_content_range",
        replace_content_range: {
          content: assembledBody,
          content_range: "full_page",
          allow_deleting_content: true,
        },
      })
    }

    // Property update: Title bumps, Revision Count increments,
    // synopsis / keywords / source replace if provided, confidence
    // bumps if provided. Kind / Status / topicId / projectIds /
    // lastReferencedAt / confidenceScore are NOT in this update.
    //
    // Author is REPLACE-on-every-save (DEFERRED-ATTRIBUTION) when the
    // input carries one: the engineer making this revision becomes the
    // author of the chain. Symmetric reasoning to title / synopsis /
    // keywords / source — the upsert path's "latest write wins" policy
    // covers human attribution. The MCP tool layer lazily passes a
    // default author only when no explicit override is given. Falls
    // back to existing on decodedAuthor is empty/undefined so a
    // service-layer caller (migration, internal tooling) that omits it
    // preserves the prior value rather than clobbering with null. Empty
    // string from the input is treated as "leave alone", matching the
    // `agent` field's posture.
    await this.client.pages.update({
      page_id: existing.id,
      properties: buildMemoryProps({
        title: decodedTitle,
        revisionCount: nextRevision,
        synopsis: decodedSynopsis,
        keywords: decodedKeywords,
        source: input.source,
        confidence: input.confidence ?? existing.confidence,
        author: authorForUpdate,
      }) as CreatePageParameters["properties"],
    })

    // Write-through: install the post-upsert title. `LruCache.set`
    // also drops any in-flight `getOrLoad` pending slot, so a
    // concurrent reader whose loader resolves with the pre-upsert
    // page after this point has its commit suppressed by the
    // identity guard. Mirror of `update()`'s post-write
    // `nameCache.set`.
    this.titleCache.set(existing.id, decodedTitle || null)

    // Promotion advisory. Fires only on the
    // append-revision branch (fresh-create returned earlier with a
    // null advisory). Reads post-write state already in memory:
    // `nextRevision` is the value just written, `assembledBodyLength`
    // is the markdown body's post-write character count. No extra
    // Notion calls. The body length is identical whether the write went
    // through the anchored RunTool path or the full-body fallback —
    // both produce `existingBody.markdown + revisionBlock` as the
    // resulting body. The MCP layer renders this in the save response
    // footer when non-null; agents reading the response decide whether
    // to promote — the system never auto-promotes.
    //
    // `kind` is forwarded to `computePromotionAdvisory` because the
    // suggestion wording is kind-aware: only `kind: 'decision'`
    // memories can be referenced from `lore-decision action='create'
    // supersedesIds: [...]` (DecisionService.getById throws on
    // non-decision kinds). The kind-mismatch guard above already
    // rejected upserts where `input.kind !== existing.kind`, so the
    // two values agree here; either is correct.
    const promotionAdvisory = computePromotionAdvisory({
      revisionCount: nextRevision,
      bodyLength: assembledBodyLength,
      kind: input.kind,
    })

    // Return the post-write memory shape so callers (auto-mentions,
    // session recording) read the new title / keywords / synopsis when
    // re-running entity extraction. `synopsis` and `keywords` fall
    // back to existing when caller omitted them, matching the
    // buildMemoryProps `if (input.X !== undefined)` gate behavior.
    // `author` reflects the post-write state — `authorForUpdate`
    // already collapses input/existing per DEFERRED-ATTRIBUTION's
    // overwrite-when-provided rule, so the returned shape reads the
    // value Notion holds after the update.
    return {
      memory: {
        ...existing,
        title: decodedTitle,
        revisionCount: nextRevision,
        synopsis: decodedSynopsis ?? existing.synopsis,
        keywords: decodedKeywords ?? existing.keywords,
        source: input.source ?? existing.source,
        confidence: input.confidence ?? existing.confidence,
        author: authorForUpdate,
      },
      revisionCount: nextRevision,
      upserted: true,
      promotionAdvisory,
    }
  }

  /**
   * Re-key a memory's `Topic Key` to a new value. The
   * conservative repair path for the topic-key upsert chain — an
   * agent that picks the wrong topic key on first save can switch
   * to the canonical key without abandoning the row.
   *
   * Re-keying is identity surgery, not content evolution:
   *
   * - **No `Revision Count` bump.** Revision Count tracks topic content
   * evolution (N saves under the same identity meant the topic was
   * refined N times). Bumping on re-key would conflate identity
   * changes with content changes.
   * - **No `Last Referenced At` write.** Re-keying is a write, not a
   * read citation, same posture as the topic-key upsert.
   * - **Audit block format** (`## Re-keyed (YYYY-MM-DD)`) deliberately
   * differs from the revision-block prefix (`## Revision N`) so a
   * future memory-history renderer can distinguish identity events
   * from content events without parsing body text.
   *
   * Validation is strict and fail-fast — every guard fires before any
   * Notion mutation, so a rejected call leaves the row entirely
   * untouched. Two structurally undefined cases short-circuit:
   *
   * - **No-op short-circuit.** Re-keying to the existing value is a
   * user-error, not an invariant violation; respond truthfully but
   * write nothing.
   * - **Empty-set guard.** Topic-key identity is `(Topic Key,
   * Project-set)`-keyed. A memory with no projects has no identity
   * slot to re-key into; rejecting is structurally correct (matches
   * the upsert path's empty-project rejection).
   *
   * **Cross-kind collision detection is intentional.** The collision
   * check delegates to `findByTopicKey`, which is deliberately
   * Kind-agnostic (see its docstring) — a re-key onto a slot held by a
   * task or decision under the same key surfaces as a collision and is
   * rejected, even if the re-keyed memory is a different Kind. Lore
   * does NOT auto-merge two topic chains; the operator handles the
   * duplication manually (archive one, re-key the other).
   *
   * **Archived rows do NOT count as collisions.** `findByTopicKey`
   * post-filters `!page.archived`, so a re-key onto a key held only
   * by archived rows succeeds. Intentional per the spec ("must not
   * collide with another **live** memory in the same project-set"):
   * archived rows are out of the active upsert chain. Edge case to
   * track: un-archiving the old row after a re-key would land two
   * live members under the same `(Topic Key, Project-set)` slot.
   * Operators that un-archive should re-check chain integrity via
   * `lore-memory action='recall'`.
   *
   * **Skip-self in collision check.** A memory whose `Topic Key`
   * already equals `newTopicKey` would otherwise self-collide. The
   * no-op short-circuit at step 2 catches this when the OLD key
   * already matches; the explicit `collision.id !== input.memoryId`
   * guard at step 4 catches the eventual-consistency window where
   * `findByTopicKey`'s post-write index lag could surface the same
   * row. Defense in depth — neither guard alone covers both cases.
   *
   * **Property write FIRST, audit-block append SECOND.** The reverse
   * order would create a worse partial state on a transient failure
   * (audit succeeds → property fails → body falsely claims a re-key
   * while the property holds the old key, and a retry duplicates the
   * audit). With property-first, an audit-failure leaves the
   * structural identity change in place and only the cosmetic audit
   * trail at risk. The audit-failure path throws `RekeyAuditError`
   * (a distinct subclass of `Error`) so callers can distinguish
   * "re-key didn't happen" from "re-key happened but audit is
   * missing." See the inline `try/catch` and the `RekeyAuditError`
   * class docstring for the full rationale.
   *
   * **Body-write uses `replace_content` with `new_str`** to match
   * the existing `update()` body-write pattern in this file. The
   * markdown is read first via `pages.retrieveMarkdown` (inside
   * `getById`), the audit block is concatenated, then the full body
   * is rewritten. Concurrent re-keys against the same memory could
   * race past each other and clobber each other's audit blocks —
   * same posture as the documented concurrent-upsert risk, fixed
   * if real-vault data shows the race matters.
   */
  /**
   * Pre-validate a `rekeyTopicKey` call without performing any
   * mutation. Returns the loaded memory + old topic key + a flag
   * indicating whether the re-key would actually do work
   * (`willRekey === false` for the no-op short-circuit case).
   * Throws the same structured errors `rekeyTopicKey` would —
   * empty-projectIds rejection, collision rejection — so callers
   * can surface those failures BEFORE running unrelated mutations.
   *
   * The `lore-memory action='update'` MCP handler calls this
   * before applying a residual content delta so a topicKey-only
   * rejection (collision, empty-projectIds) doesn't leave the
   * content update half-persisted with the operator looking at
   * an error response.
   *
   * **Race window with subsequent `rekeyTopicKey`.** This method
   * loads memory state once and runs the collision query against
   * that snapshot. By the time the caller actually invokes
   * `rekeyTopicKey`, another agent could have grabbed the slot,
   * the row's projectIds could have changed (via a concurrent
   * update), or a transient Notion failure could surface during
   * the mutation. None of those cases retroactively invalidate
   * the preflight; they're caught by `rekeyTopicKey`'s own
   * validation pass and propagated through whatever exception
   * the caller wraps them in (e.g. `PartialUpdateError` at the
   * MCP layer when content has already landed).
   */
  async validateRekey(input: {
    memoryId: string
    newTopicKey: string
  }): Promise<{ memory: Memory; oldTopicKey: string; willRekey: boolean }> {
    const memory = await this.getById(input.memoryId)
    const oldTopicKey = memory.topicKey

    if (oldTopicKey === input.newTopicKey) {
      return { memory, oldTopicKey, willRekey: false }
    }

    if (memory.projectIds.length === 0) {
      throw new Error(
        "Cannot re-key a memory with empty projectIds. " +
          "Topic-key identity requires at least one project."
      )
    }

    const collision = await this.findByTopicKey({
      topicKey: input.newTopicKey,
      projectIds: memory.projectIds,
    })
    if (collision && collision.id !== input.memoryId) {
      throw new Error(
        `Re-key target '${input.newTopicKey}' is already in use by ` +
          `memory ${collision.id} in this project-set. ` +
          `Lore does not auto-merge — archive one or pick a different key.`
      )
    }

    return { memory, oldTopicKey, willRekey: true }
  }

  async rekeyTopicKey(input: {
    memoryId: string
    newTopicKey: string
  }): Promise<{ memory: Memory; oldTopicKey: string }> {
    // `validateRekey` re-runs the same loads and checks
    // `rekeyTopicKey` performs inline. The duplication is
    // intentional: callers that pre-validated via the MCP
    // handler still go through the authoritative validation
    // here so direct callers of `rekeyTopicKey` (anyone
    // bypassing the handler) get the full safety net.
    const { memory, oldTopicKey, willRekey } = await this.validateRekey(input)
    if (!willRekey) {
      return { memory, oldTopicKey }
    }

    // Property write FIRST, audit block SECOND. The reverse order
    // (audit then property) was the original spec but creates a worse
    // partial-state: an audit-write success followed by a property-
    // write failure leaves the body falsely claiming a re-key while
    // the property still holds the old key, AND a retry would append
    // a SECOND audit block before the property write could succeed.
    //
    // With property-first, the failure modes are:
    //
    // 1. **Property write fails.** Nothing was written. The memory is
    // unchanged. A retry runs the full pipeline cleanly — collision
    // check is still valid, no body drift. The thrown error matches
    // a normal Notion error.
    // 2. **Property write succeeds, audit append fails.** The re-key
    // persisted (the load-bearing identity change). Only the
    // cosmetic audit trail is missing. A retry would observe
    // `oldTopicKey === newTopicKey` (we already updated the
    // property), short-circuit through the no-op guard, and exit
    // without re-attempting the audit. The audit block is
    // permanently lost — but the row's structural state is
    // correct and self-consistent.
    //
    // The audit-append failure throws a structured `RekeyAuditError`
    // so callers can distinguish "rekey didn't happen" from "rekey
    // happened but audit is missing." The MCP response surfaces the
    // distinction in the error message; operators triaging the
    // failure see the new key persisted on Notion.
    await this.client.pages.update({
      page_id: input.memoryId,
      // Direct partial-property update — matches `update()`'s
      // targeted shape rather than going through `buildMemoryProps`
      // (which always writes Title and would needlessly disturb the
      // title cache). Re-keying touches `Topic Key` only; `Revision
      // Count` and `Last Referenced At` are deliberately untouched.
      properties: {
        [MEMORY_PROPS.TOPIC_KEY]: {
          rich_text: [{ text: { content: input.newTopicKey } }],
        },
      } as CreatePageParameters["properties"],
    })

    const today = todayUtc()
    const auditBlock = [
      "",
      "---",
      "",
      `## Re-keyed (${today})`,
      "",
      `**From:** \`${oldTopicKey || "(unset)"}\``,
      `**To:** \`${input.newTopicKey}\``,
    ].join("\n")
    const newBody = memory.content + auditBlock

    // Anchored append via RunTool when the flag is on and the body has a
    // unique tail substring. The wire payload is the tail
    // anchor + the small audit block rather than the full body — a
    // proportional reduction for large memory bodies. The
    // `RekeyAuditError` partial-state contract is preserved across both
    // paths: a property write that lands followed by an audit-append
    // failure (RunTool or REST) raises `RekeyAuditError` so callers can
    // distinguish "re-key didn't happen" from "re-key happened but
    // audit is missing." The fall-back-able RunTool signals
    // (`no_match` / `multiple_matches` / `deletion_warning` /
    // `restricted_resource`) drop through to the existing
    // `replace_content` path so a stale anchor never leaves the audit
    // block stranded. `restricted_resource` is load-bearing for
    // integration-secret operators: the auth-refresh proxy cannot
    // repair the 403, but the REST/SDK path can — silently widening
    // the catch back to validation-only would re-introduce the
    // outage path the security review B1/B2 fixed.
    const rekeyFlagOn = this.features.runTool.blockEdit
    const rekeyAnchor = rekeyFlagOn ? pickRekeyAuditAnchor(memory.content) : null
    if (rekeyFlagOn && rekeyAnchor === null) {
      debugLogRekeyAnchorMiss(input.memoryId, memory.content.length)
    }
    let auditApplied = false
    if (rekeyAnchor !== null) {
      try {
        await updatePageContentViaRunTool(this.client, {
          pageId: input.memoryId,
          updates: [{ oldStr: rekeyAnchor, newStr: rekeyAnchor + auditBlock }],
        })
        auditApplied = true
      } catch (err) {
        if (!(err instanceof RunToolBlockEditError)) {
          throw buildRekeyAuditError(input.memoryId, oldTopicKey, input.newTopicKey, err)
        }
        // Structured fall-back signal (no_match / multiple_matches /
        // deletion_warning / restricted_resource): drop through to the
        // REST path. RunTool's own deferral counter could be threaded
        // through here once the A/B harness is in place.
      }
    }

    if (!auditApplied) {
      try {
        await this.client.pages.updateMarkdown({
          page_id: input.memoryId,
          type: "replace_content",
          replace_content: {
            new_str: newBody,
            allow_deleting_content: true,
          },
        })
      } catch (err) {
        throw buildRekeyAuditError(input.memoryId, oldTopicKey, input.newTopicKey, err)
      }
    }

    return {
      memory: { ...memory, topicKey: input.newTopicKey, content: newBody },
      oldTopicKey,
    }
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
    // Properties-only fetch for the structural guards. `getPropertiesById`
    // skips the `pages.retrieveMarkdown` round-trip that `getById` would
    // pay for the body — the Status / Kind guards only inspect Notion
    // select properties, and the body is needed solely on the success
    // path for the audit-block append. Failing guards short-circuit
    // before the body fetch fires. Mirrors the `lore inbox archive`
    // status guard so both inbox-touching call sites share the
    // property-only-read posture.
    const memory = await this.getPropertiesById(input.memoryId)
    if (memory.status !== "proposed") {
      throw new MemoryReviewStateError(
        `Cannot ${input.verdict} memory ${input.memoryId}: ` +
          `current status is "${memory.status}", expected "proposed". ` +
          `The approve / reject actions are inbox-only — use ` +
          `\`lore-memory action='update' status='<value>'\` to flip a ` +
          `non-proposed row's status directly.`,
        {
          memoryId: input.memoryId,
          currentStatus: memory.status,
        }
      )
    }
    // Inbox contract is structural, not just UI: `proposedMemoryFilter()`
    // (the canonical inbox predicate) excludes `Kind = decision` because
    // proposed-state decisions are part of the decision lifecycle, not
    // the auto-extracted-learning inbox. Refusing here prevents an
    // operator or agent from running the memory-inbox approve / reject
    // path on a decision row and bypassing the decision surface that
    // owns governance (`lore-decision action='accept'` / `'supersede'`
    // / `'review'`). Same `proposedMemoryFilter()` "single source of
    // truth" contract that the count and listing surfaces honor.
    if (memory.kind === "decision") {
      throw new MemoryReviewStateError(
        `Cannot ${input.verdict} memory ${input.memoryId}: ` +
          `Kind is "decision". Decisions have their own lifecycle — ` +
          `use \`lore-decision action='supersede'\` to retire a ` +
          `decision or \`lore-decision action='review'\` to clear ` +
          `the proposed state. The memory-inbox approve / reject ` +
          `actions are limited to non-decision proposed memories.`,
        {
          memoryId: input.memoryId,
          currentStatus: memory.status,
        }
      )
    }

    const newStatus: MemoryStatus = input.verdict === "approve" ? "accepted" : "rejected"
    const trimmedReviewer = input.reviewer.trim()
    if (trimmedReviewer.length === 0) {
      throw new Error(
        `MemoryService.recordReview: reviewer must be a non-empty string. ` +
          `Resolve the engineer identity (LORE_USER_NAME env or ` +
          `services.identity.resolveAuthor()) before calling.`
      )
    }

    // Property write first — see the docstring above for the
    // partial-state rationale. Direct partial-property update; not
    // routed through `update()` to keep the title cache undisturbed
    // and avoid touching `Last Referenced At` (review is a write,
    // not a read citation).
    await this.client.pages.update({
      page_id: input.memoryId,
      properties: {
        [MEMORY_PROPS.STATUS]: { select: { name: newStatus } },
      } as CreatePageParameters["properties"],
    })

    const today = todayUtc()
    const reviewedAtIso = new Date().toISOString()
    const verdictLabel = input.verdict === "approve" ? "approved" : "rejected"
    // ISO 8601 timestamp on a separate `**Reviewed At:**` line so the
    // audit trail records reviewer and timestamp in Notion-visible
    // audit body. The heading keeps the date for human readability;
    // `Reviewed At` carries the durable wall-clock evidence so a
    // future audit walker can recover ordering / latency without
    // relying on Notion's `last_edited_time` (which any subsequent
    // edit overwrites).
    const auditLines = [
      "",
      "---",
      "",
      `## Reviewed (${today})`,
      "",
      `**Verdict:** ${verdictLabel}`,
      `**Reviewer:** ${trimmedReviewer}`,
      `**Reviewed At:** ${reviewedAtIso}`,
    ]
    const trimmedReason = input.reason?.trim() ?? ""
    if (trimmedReason.length > 0) {
      auditLines.push(`**Reason:** ${trimmedReason}`)
    }
    const auditBlock = auditLines.join("\n")

    // Body fetch + audit append are wrapped together: either a
    // failed `retrieveMarkdown` (after the status flip already
    // landed) or a failed `updateMarkdown` leaves the same partial
    // state — Status column updated, body audit missing — so they
    // share one `MemoryReviewAuditError` envelope. The body fetch
    // is deliberately deferred until AFTER the property write so
    // guard-rejection / property-write failures short-circuit
    // without paying for the body round-trip.
    let newBody: string
    try {
      const { markdown } = await this.client.pages.retrieveMarkdown({
        page_id: input.memoryId,
      })
      newBody = markdown + auditBlock
      await this.client.pages.updateMarkdown({
        page_id: input.memoryId,
        type: "replace_content",
        replace_content: {
          new_str: newBody,
          allow_deleting_content: true,
        },
      })
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err)
      throw new MemoryReviewAuditError(
        `Review persisted (status: proposed → ${newStatus}) but ` +
          `audit-block append failed: ${cause}. The Status column is ` +
          `updated; the body audit trail is missing. A retry will ` +
          `reject with MemoryReviewStateError because the row is no ` +
          `longer in proposed state. Inspect memory ${input.memoryId} ` +
          `on Notion and append the audit manually if needed.`,
        {
          memoryId: input.memoryId,
          previousStatus: memory.status,
          newStatus,
          cause: err,
        }
      )
    }

    return {
      memory: { ...memory, status: newStatus, content: newBody },
      previousStatus: memory.status,
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
   * Call-count math, motivated by `lore-task action='reconcile'`'s
   * internal-vault budget: routing reconcile's per-candidate hydration through
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
    // concurrent writes are all owned by `LruCache.getOrLoad` —
    // see the class docstring for the race protection that replaced
    // the pre-PF1-09 bespoke `writeEpoch` + `pendingTitles` machinery.
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
    validateRichTextMetadataFields(input, "MemoryService.update")

    await this.pinned.preflightUpdate(id, input)

    // Same decode-at-write discipline as `create`: encoded titles /
    // content / alternatives / consequences flowing in from re-saves of
    // autosave-rendered transcripts must land in Notion clean. Without
    // this, `update` would write encoded text around the freshly-decoded
    // rows `create` produces, re-opening the bug class PF1-06 closes.
    const decoded = decodeUpdateTextFields(input)
    const props: Record<string, unknown> = {}

    if (decoded.title !== undefined) {
      // Pre-write delete: clears the stored value AND drops any
      // in-flight `getOrLoad` pending slot, so a reader whose loader
      // is mid-`pages.retrieve` has its post-loader commit suppressed
      // by `getOrLoad`'s identity guard. The post-write `set` below
      // installs the authoritative value and (via `LruCache.set`'s
      // pending-clearing discipline) closes the dispatched-during-
      // write window for any reader that started after this delete.
      this.titleCache.delete(id)
      props[MEMORY_PROPS.TITLE] = { title: [{ text: { content: decoded.title } }] }
    }
    if (input.projectIds) {
      props[MEMORY_PROPS.PROJECT] = { relation: input.projectIds.map((id) => ({ id })) }
    }
    if (input.topicId) {
      props[MEMORY_PROPS.TOPIC] = { relation: [{ id: input.topicId }] }
    }
    if (input.tags) {
      props[MEMORY_PROPS.TAGS] = {
        multi_select: input.tags.map((t) => ({ name: t })),
      }
    }
    if (decoded.keywords !== undefined) {
      props[MEMORY_PROPS.KEYWORDS] = {
        rich_text: [{ text: { content: decoded.keywords } }],
      }
    }
    if (decoded.synopsis !== undefined) {
      props[MEMORY_PROPS.SYNOPSIS] = {
        rich_text: [{ text: { content: decoded.synopsis } }],
      }
    }
    if (input.kind) {
      props[MEMORY_PROPS.KIND] = { select: { name: input.kind } }
    }
    if (input.status) {
      props[MEMORY_PROPS.STATUS] = { select: { name: input.status } }
    }
    if (input.confidence) {
      props[MEMORY_PROPS.CONFIDENCE] = { select: { name: input.confidence } }
    }
    // See `buildMemoryProps` for the three-state rationale.
    if (input.confidenceScore !== undefined) {
      props[MEMORY_PROPS.CONFIDENCE_SCORE] =
        input.confidenceScore === null
          ? { number: null }
          : { number: input.confidenceScore }
    }
    // `null` explicitly clears a date; `undefined` leaves it untouched.
    // Strict `=== null` matches `buildMemoryProps`' shape so update and
    // create use one consistent rule for "is this a clear or a set?"
    if (input.reviewBy !== undefined) {
      props[MEMORY_PROPS.REVIEW_BY] =
        input.reviewBy === null ? { date: null } : { date: { start: input.reviewBy } }
    }
    if (input.decidedAt !== undefined) {
      props[MEMORY_PROPS.DECIDED_AT] =
        input.decidedAt === null ? { date: null } : { date: { start: input.decidedAt } }
    }
    if (input.lastReferencedAt !== undefined) {
      props[MEMORY_PROPS.LAST_REFERENCED_AT] =
        input.lastReferencedAt === null
          ? { date: null }
          : { date: { start: input.lastReferencedAt } }
    }
    if (input.supersedesIds) {
      props[MEMORY_PROPS.SUPERSEDES] = {
        relation: input.supersedesIds.map((id) => ({ id })),
      }
    }
    if (input.affectsIds) {
      props[MEMORY_PROPS.AFFECTS] = { relation: input.affectsIds.map((id) => ({ id })) }
    }
    if (decoded.alternatives !== undefined) {
      props[MEMORY_PROPS.ALTERNATIVES] = {
        rich_text: [{ text: { content: decoded.alternatives } }],
      }
    }
    if (decoded.consequences !== undefined) {
      props[MEMORY_PROPS.CONSEQUENCES] = {
        rich_text: [{ text: { content: decoded.consequences } }],
      }
    }
    if (input.taskState) {
      props[MEMORY_PROPS.TASK_STATE] = { select: { name: input.taskState } }
    }
    if (decoded.blockedBy !== undefined) {
      props[MEMORY_PROPS.BLOCKED_BY] = {
        rich_text: [{ text: { content: decoded.blockedBy } }],
      }
    }
    if (decoded.entity !== undefined) {
      props[MEMORY_PROPS.ENTITY] = {
        rich_text: [{ text: { content: decoded.entity } }],
      }
    }
    // Scope / lifetime. Mirror the `buildMemoryProps`
    // tristate semantics in the inlined update path so the column
    // writes are consistent across `create` and `update`. The update
    // path inlines the property writes (rather than calling
    // `buildMemoryProps`) because Notion's `pages.update` is a
    // partial update — we only emit columns the caller actually
    // touched.
    if (input.scope !== undefined) {
      const scope = input.scope
      if (scope.kind !== undefined) {
        props[MEMORY_PROPS.SCOPE_KIND] =
          scope.kind === null ? { select: null } : { select: { name: scope.kind } }
      }
      if (scope.key !== undefined) {
        props[MEMORY_PROPS.SCOPE_KEY] = {
          rich_text: [{ text: { content: scope.key } }],
        }
      }
      if (scope.audience !== undefined) {
        props[MEMORY_PROPS.AUDIENCE] = {
          rich_text: [{ text: { content: scope.audience } }],
        }
      }
      if (scope.lifetime !== undefined) {
        props[MEMORY_PROPS.LIFETIME] =
          scope.lifetime === null
            ? { select: null }
            : { select: { name: scope.lifetime } }
      }
      if (scope.expiresAt !== undefined) {
        props[MEMORY_PROPS.EXPIRES_AT] =
          scope.expiresAt === null ? { date: null } : { date: { start: scope.expiresAt } }
      }
    }

    // Pinned context block update. Mirrors the scope/
    // lifetime branch above — the update path inlines column writes
    // rather than calling `buildMemoryProps` because Notion's
    // `pages.update` is partial-update only. The checkbox column has
    // no clear sentinel; `priority` and `mutability` accept `null`
    // for the clear path.
    //
    // Priority is clamped to `[PINNED_PRIORITY_MIN, PINNED_PRIORITY_MAX]`
    // at the service boundary — the MCP Zod schema also clamps, but
    // the service-layer guard catches CLI / hook callers and is the
    // load-bearing protection against a malformed write.
    if (input.pinned !== undefined) {
      const pinnedInput = input.pinned
      if (pinnedInput.pinned !== undefined) {
        props[MEMORY_PROPS.PINNED] = { checkbox: pinnedInput.pinned }
        // Invalidate the in-process pinned-count cache so a same-process
        // pin / unpin sees the fresh count without waiting on the 30s TTL.
        this.pinned.invalidateCountCache()
      }
      if (pinnedInput.priority !== undefined) {
        props[MEMORY_PROPS.PINNED_PRIORITY] =
          pinnedInput.priority === null
            ? { number: null }
            : { number: clampPinnedPriority(pinnedInput.priority) }
      }
      if (pinnedInput.mutability !== undefined) {
        props[MEMORY_PROPS.MUTABILITY] =
          pinnedInput.mutability === null
            ? { select: null }
            : { select: { name: pinnedInput.mutability } }
      }
    }

    let propertiesApplied = false
    if (Object.keys(props).length > 0) {
      await this.client.pages.update({
        page_id: id,
        // Cast needed: we're building update props dynamically
        properties: props as CreatePageParameters["properties"],
      })
      propertiesApplied = true
    }

    if (decoded.content !== undefined) {
      try {
        await this.client.pages.updateMarkdown({
          page_id: id,
          type: "replace_content",
          replace_content: {
            new_str: decoded.content,
            allow_deleting_content: true,
          },
        })
      } catch (bodyWriteError) {
        if (!propertiesApplied) {
          throw bodyWriteError
        }
        if (decoded.title !== undefined) {
          this.titleCache.set(id, decoded.title || null)
        }
        const cause =
          bodyWriteError instanceof Error
            ? bodyWriteError.message
            : String(bodyWriteError)
        throw new MemoryUpdatePartialFailureError(
          `Memory update partial failure: properties for memory ${id} ` +
            `persisted, but the body write failed during phase "body": ${cause}. ` +
            `The property changes are already on Notion; the body content was ` +
            `not written. Inspect the row before retrying the update.`,
          { memoryId: id, bodyWriteError }
        )
      }
    }

    const updated = await this.getById(id)
    // Write-through: we just read the authoritative post-update state,
    // so cache it. `LruCache.set` also drops any in-flight `getOrLoad`
    // pending slot, so a reader whose `pages.retrieve` was dispatched
    // *during* this `pages.update` — after the pre-write delete but
    // before this set — has its post-loader commit suppressed by the
    // identity guard. Mirror of `TopicService.getOrCreate`'s post-write
    // `nameCache.set`.
    if (decoded.title !== undefined) {
      this.titleCache.set(id, updated.title || null)
    }
    return updated
  }

  /**
   * Run the HTML-entity decode pass against this service's Memories DB.
   * Thin wrapper over the standalone memory-encoding migration
   * function so the CLI doesn't need to reach past the service
   * boundary for the client + DatabaseRef.
   */
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
    const today = opts?.today ?? todayUtc()
    await Promise.all(
      memories.map(async (memory) => {
        if (memory.lastReferencedAt === today && memory.confidenceScore !== null) {
          return
        }
        try {
          let nextScore: number
          if (memory.confidenceScore === null) {
            const seeded = seedConfidenceScore(memory.confidence)
            const decayed = decayConfidenceScore(
              seeded,
              memory.createdAt.slice(0, 10),
              today
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
              today
            )
            nextScore = bumpConfidenceScore(decayed)
          }
          await this.client.pages.update({
            page_id: memory.id,
            properties: {
              [MEMORY_PROPS.LAST_REFERENCED_AT]: { date: { start: today } },
              [MEMORY_PROPS.CONFIDENCE_SCORE]: { number: nextScore },
            },
          })
          // Mirror the post-write state onto the caller's
          // `Memory` reference. Without this, a cached
          // `WakeUpData` whose memories were touched on the prior
          // render still says `lastReferencedAt: <yesterday>` —
          // every subsequent cache hit would re-fire `touchOnRead`
          // because the once-per-day gate above keys on
          // `memory.lastReferencedAt === today`. The mutation
          // closes the gate without rewriting the touch contract:
          // the in-memory shape now matches what Notion holds.
          // Mutation is safe under `ReadonlyArray<Pick<...>>` — the
          // array itself is read-only but element fields stay
          // writable, and the picked properties are intentionally
          // non-readonly on `Memory`.
          memory.lastReferencedAt = today
          memory.confidenceScore = nextScore
        } catch (error) {
          opts?.onError?.(memory.id, error)
        }
      })
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
      current = decayConfidenceScore(seeded, memory.createdAt.slice(0, 10), today)
    } else {
      current = decayConfidenceScore(
        memory.confidenceScore,
        memory.lastReferencedAt,
        today
      )
    }
    const next = decrementConfidenceScore(current)
    const properties: CreatePageParameters["properties"] = {
      [MEMORY_PROPS.CONFIDENCE_SCORE]: { number: next },
      [MEMORY_PROPS.LAST_REFERENCED_AT]: { date: { start: today } },
    }
    if (opts?.compareNotes !== undefined) {
      properties[MEMORY_PROPS.COMPARE_NOTES] = {
        rich_text: encodeCompareNotesRichText(opts.compareNotes),
      }
    }
    await this.client.pages.update({
      page_id: memory.id,
      properties,
    })
    return next
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
  async recordCompared(input: {
    memoryA: Pick<Memory, "id" | "comparedWith" | "compareNotes">
    memoryB: Pick<Memory, "id" | "comparedWith" | "compareNotes">
    verdict: string
    /**
     * Loser memory's id for asymmetric verdicts; `null` for symmetric.
     * Persisted in each side's NDJSON entry so direction is part of
     * the idempotency key — a flipped-direction re-judgment bypasses
     * the gate and re-dispatches.
     */
    affected: string | null
    reason: string
    judgedAt: string
    promptVersion: string
    /**
     * Force a side's `pages.update` even when the final audit line
     * already exists. Used only by legacy asymmetric partial-repair:
     * a pre-ledger final audit line proves the old decrement landed,
     * but the affected side may still need the new dispatch ledger
     * appended without appending a duplicate final audit line.
     */
    forceWriteA?: boolean
    forceWriteB?: boolean
  }): Promise<RecordComparedResult> {
    const {
      memoryA,
      memoryB,
      verdict,
      affected,
      reason,
      judgedAt,
      promptVersion,
      forceWriteA = false,
      forceWriteB = false,
    } = input
    const entryA: CompareNoteEntry = {
      verdict,
      target: memoryB.id,
      affected,
      reason,
      judgedAt,
      promptVersion,
    }
    const entryB: CompareNoteEntry = {
      verdict,
      target: memoryA.id,
      affected,
      reason,
      judgedAt,
      promptVersion,
    }

    // Per-side idempotent check. The match-key is (target, verdict,
    // affected) — judgedAt is intentionally NOT part of it because a
    // retry creates a new judgedAt timestamp, and we want to skip the
    // write based on "this pair-and-direction was already audited"
    // rather than "this exact timestamp was already written."
    const aHasEntry = hasMatchingCompareNote(memoryA.compareNotes, {
      target: memoryB.id,
      verdict,
      affected,
    })
    const bHasEntry = hasMatchingCompareNote(memoryB.compareNotes, {
      target: memoryA.id,
      verdict,
      affected,
    })

    const writes: Array<{ side: "A" | "B"; promise: Promise<unknown> }> = []
    const shouldWriteA = !aHasEntry || forceWriteA
    const shouldWriteB = !bHasEntry || forceWriteB
    if (shouldWriteA) {
      const nextNotesA = aHasEntry
        ? memoryA.compareNotes
        : appendCompareNote(memoryA.compareNotes, entryA)
      const nextComparedWithA = memoryA.comparedWith.includes(memoryB.id)
        ? memoryA.comparedWith
        : [...memoryA.comparedWith, memoryB.id]
      writes.push({
        side: "A",
        promise: this.client.pages.update({
          page_id: memoryA.id,
          properties: {
            [MEMORY_PROPS.COMPARED_WITH]: {
              relation: nextComparedWithA.map((id) => ({ id })),
            },
            [MEMORY_PROPS.COMPARE_NOTES]: {
              rich_text: encodeCompareNotesRichText(nextNotesA),
            },
          },
        }),
      })
    }
    if (shouldWriteB) {
      const nextNotesB = bHasEntry
        ? memoryB.compareNotes
        : appendCompareNote(memoryB.compareNotes, entryB)
      const nextComparedWithB = memoryB.comparedWith.includes(memoryA.id)
        ? memoryB.comparedWith
        : [...memoryB.comparedWith, memoryA.id]
      writes.push({
        side: "B",
        promise: this.client.pages.update({
          page_id: memoryB.id,
          properties: {
            [MEMORY_PROPS.COMPARED_WITH]: {
              relation: nextComparedWithB.map((id) => ({ id })),
            },
            [MEMORY_PROPS.COMPARE_NOTES]: {
              rich_text: encodeCompareNotesRichText(nextNotesB),
            },
          },
        }),
      })
    }

    // Use `Promise.allSettled` rather than `Promise.all` so the caller
    // can distinguish "both writes rejected" from "one write landed,
    // one rejected." `Promise.all` rejects on the first failure and
    // discards any concurrent success — which leaves the audit state
    // half-written and the caller unable to tell which (if any) side's
    // `pages.update` actually committed. The partial-success case is
    // the structural hazard `recordCompared` exists to handle: per-side
    // idempotency relies on a retry observing the side that already
    // landed, and the MCP handler needs that signal to drive its
    // self-healing reload-and-retry path.
    //
    // Per-side outcome flags follow the same semantics as the happy-
    // path return: `wroteX = true` iff this call ISSUED AND succeeded
    // a `pages.update` for that side. A skipped side (per-side
    // idempotent — already had matching entry) reports `wroteX = false`,
    // matching the "issues ZERO updates when both sides already carry
    // the entry" contract pinned by the existing service tests.
    const settled = await Promise.allSettled(writes.map((w) => w.promise))
    // Track per-side outcomes via paired boolean + reason fields rather
    // than a `failure: unknown = undefined` sentinel. `Promise.reject(undefined)`
    // is legal — the Notion SDK never does this in practice, but a
    // future contributor swapping the SDK or wrapping it in a layer that
    // does would silently flip every "did this side fail?" branch if the
    // sentinel-by-undefined pattern were retained. Boolean flags written
    // in the same loop iteration as the failure capture remove the
    // ambiguity at the type level.
    let aFailed = false
    let bFailed = false
    let aFailure: unknown = undefined
    let bFailure: unknown = undefined
    let aWrote = false
    let bWrote = false
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!
      const side = writes[i]!.side
      if (outcome.status === "fulfilled") {
        if (side === "A") aWrote = true
        else bWrote = true
      } else if (side === "A") {
        aFailed = true
        aFailure = outcome.reason
      } else {
        bFailed = true
        bFailure = outcome.reason
      }
    }

    if (!aFailed && !bFailed) {
      return { wroteA: aWrote, wroteB: bWrote }
    }

    // Both attempted writes failed. Throw the first underlying rejection
    // directly — per-side idempotency makes a same-input retry safe (a
    // fresh snapshot will see neither audit entry and write both sides
    // cleanly). No structured partial-write error here because there's
    // no partial success to surface.
    if (aFailed && bFailed) {
      throw aFailure
    }

    // Exactly one side rejected; the other landed (or was skipped via
    // per-side idempotency). Surface a structured error carrying the
    // partial-success result so the caller can self-heal: reload the
    // survivor's now-updated snapshot, then retry the missing side
    // through `recordCompared`'s per-side idempotent write.
    //
    // The partial-write surface is structurally identical for two
    // distinct shapes: (a) the survivor's `pages.update` succeeded
    // this call, and (b) the survivor was skipped because its audit
    // entry was already present from a prior call. In both cases the
    // survivor's audit line is durable in Notion; the caller's retry
    // logic is the same.
    const failedSide: "A" | "B" = aFailed ? "A" : "B"
    const cause = aFailed ? aFailure : bFailure
    const survivorWasSkipped = failedSide === "A" ? !shouldWriteB : !shouldWriteA
    const survivorState = survivorWasSkipped
      ? "was already present (skipped via per-side idempotency)"
      : "landed"
    throw new RecordComparedPartialWriteError({
      message:
        `recordCompared partial write — side ${failedSide} rejected; ` +
        `the other side ${survivorState}. ` +
        `Retry with a reloaded snapshot will skip the side already audited ` +
        `and write only the missing side.`,
      result: { wroteA: aWrote, wroteB: bWrote },
      failedSide,
      cause,
    })
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
    let cursor: string | undefined
    do {
      const baseFilter = opts.projectId
        ? projectOrUnscopedFilter(opts.projectId)
        : undefined
      // Resurfaced cleanup-orphan exclusion. The
      // confidence-score backfill seeds a numeric score onto every
      // unscored row; without this filter, the orphan would receive a
      // seeded score (cosmetically wrong, but worse: working against
      // intent — the orphan is a row Lore deliberately removed from
      // its working set).
      const filter = withCleanupOrphanExclusion(baseFilter)
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "ascending" }],
        page_size: 100,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isLiveFullPage)) {
        yield await this.pageToMemory(page, "")
      }
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
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
    lastReferencedAt: string
  ): Promise<void> {
    await this.client.pages.update({
      page_id: memoryId,
      properties: {
        [MEMORY_PROPS.CONFIDENCE_SCORE]: { number: score },
        [MEMORY_PROPS.LAST_REFERENCED_AT]: { date: { start: lastReferencedAt } },
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

  /**
   * Memories that need triage: either scored low, OR long-neglected
   * regardless of stored score. Backs the Stale Confidence wake-up
   * subsection.
   *
   * Server-side filter (when `opts.projectId` is supplied):
   *
   * (Project contains projectId OR Project is_empty)
   * AND Confidence Score is_not_empty
   * AND (
   * Confidence Score < CONFIDENCE_DISPLAY_THRESHOLD
   * OR Last Referenced At on_or_before today - STALE_CONFIDENCE_DAYS
   * )
   *
   * Server-side filter (vault-wide, when `opts.projectId` is omitted):
   * the project clause is dropped entirely so the query covers every
   * memory regardless of project scoping. Same posture as
   * `MemoryService.list`.
   *
   * The neglect-OR clause is load-bearing under the
   * **write-realized lazy decay** model. RRF reads stored
   * Confidence Score verbatim — no decay applied at read. So a memory
   * touched once 6 months ago at score 0.9 keeps a stored 0.9 (and
   * ranks high in retrieval) until something disturbs it. The
   * neglect-OR clause is what surfaces it for triage. When the agent
   * reads it, `touchOnRead` realizes the accrued decay (decay-then-bump),
   * the stored score drops, and the row either continues surfacing
   * (if now actually low-score) or rotates out.
   *
   * The `is_not_empty` guard excludes never-scored rows — those have
   * not yet been touched by any read path; flagging them as stale
   * would conflate "never scored" with "needs triage." Operators
   * backfill them via `lore migrate --build-confidence-scores`.
   *
   * `projectOrUnscopedFilter` matches `MemoryService.list` etc. —
   * repo-wide memories surface in the Stale Confidence section the
   * same way they surface in Recent Memories.
   *
   * Sorted by score ascending so most-decayed rows surface first;
   * neglected-but-fresh-score rows fall to the end of the list. Notion
   * page size = 100 so archive-heavy windows can refill efficiently;
   * archived rows are filtered client-side (matches the established Memories
   * DS pattern). No body fetch — the wake-up subsection renders title +
   * synopsis + trust label + meta only, never bodies.
   */
  async queryStaleConfidence(opts: {
    /** Omit for vault-wide wake-up; matches `MemoryService.list` shape. */
    projectId?: string
    limit: number
    /** YYYY-MM-DD anchor; same shape as `taskDaysOverdue` etc. */
    today: string
    /**
     * When `true`, do NOT exclude `Status = proposed` rows. Defaults
     * to `false` so the wake-up Stale Confidence subsection mirrors
     * the rest of the default-recall posture:
     * proposed memories belong in the inbox surface, not in normal
     * triage lists. The inbox-review flow opts in.
     */
    includeProposed?: boolean
  }): Promise<Memory[]> {
    const neglectCutoff = new Date(
      new Date(opts.today).getTime() - STALE_CONFIDENCE_DAYS * MS_PER_DAY
    )
      .toISOString()
      .slice(0, 10)

    const filters: Array<Record<string, unknown>> = []
    if (opts.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }
    if (opts.includeProposed !== true) {
      // Same default-exclude posture as `MemoryService.list` and
      // `MemoryService.search`: hide both `proposed` (inbox-pending)
      // and `rejected` (terminal-off-recall) rows from triage so
      // review-state never leaks into the Stale Confidence subsection.
      filters.push(...reviewTerminalStatusExclusionFilters())
    }
    filters.push({
      property: MEMORY_PROPS.CONFIDENCE_SCORE,
      number: { is_not_empty: true },
    })
    filters.push({
      or: [
        {
          property: MEMORY_PROPS.CONFIDENCE_SCORE,
          number: { less_than: CONFIDENCE_DISPLAY_THRESHOLD },
        },
        {
          property: MEMORY_PROPS.LAST_REFERENCED_AT,
          date: { on_or_before: neglectCutoff },
        },
      ],
    })
    // Resurfaced cleanup-orphan exclusion. A restored-
    // from-trash orphan that was scored by `--build-confidence-scores`
    // before this filter shipped would otherwise show up in the
    // wake-up Stale Confidence triage view as an empty-body shell —
    // confusing for the operator and noise in the section meant to
    // surface real low-confidence memories.
    filters.push(cleanupOrphanExclusionFilter())

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
    const limit = opts.limit
    if (limit <= 0) return []

    let result: Awaited<ReturnType<typeof collectLivePages>>
    try {
      result = await collectLivePages({
        limit,
        source: "MemoryService.queryStaleConfidence",
        query: ({ page_size, start_cursor }) =>
          this.client.dataSources.query({
            data_source_id: this.db.dataSourceId,
            filter,
            sorts: [{ property: MEMORY_PROPS.CONFIDENCE_SCORE, direction: "ascending" }],
            page_size,
            start_cursor,
          }),
      })
    } catch (err) {
      if (isMissingPropertyError(err)) return []
      throw err
    }
    if (result.capped) {
      warnLivePageCapFired({
        source: "MemoryService.queryStaleConfidence",
        pages: result.pageCount,
        accumulated: result.pages.length,
        limit,
      })
    }

    return Promise.all(result.pages.map((page) => this.pageToMemory(page, "")))
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
    if (this.features.runTool.filterSql) {
      try {
        // Mirror `MemoryService.list`'s default: when the
        // caller has not opted into proposed rows AND has not
        // narrowed via an explicit `statuses` whitelist, exclude
        // `Status = proposed` server-side. Without this, the SQL
        // path would surface inbox/proposed rows that the REST
        // path's default-exclude filter drops, breaking the
        // "behavior unchanged with all RunTool flags off" contract
        // under A/B testing.
        const excludeStatuses =
          opts.statuses === undefined && !opts.includeProposed
            ? (["proposed"] as const)
            : undefined
        // **Tag filtering is pushed server-side via the verified
        // exact-token SQL predicate.** An earlier overfetch
        // heuristic was rejected because wrong-tag rows could fill
        // the `limit * 4` window before tag-matching candidates.
        // `fetchNearDuplicateCandidatePageIds` composes
        // `(Tags LIKE %"tag1"% OR Tags LIKE %"tag2"%)` ahead of
        // the LIMIT, so SQL `LIMIT N` truthfully bounds N
        // tag-matching candidates — identical to REST
        // `multi_select.contains` semantics.
        const pageIds = await fetchNearDuplicateCandidatePageIds(this.client, {
          dataSourceId: this.db.dataSourceId,
          projectProperty: MEMORY_PROPS.PROJECT,
          topicProperty: MEMORY_PROPS.TOPIC,
          kindProperty: MEMORY_PROPS.KIND,
          statusProperty: MEMORY_PROPS.STATUS,
          keywordsProperty: MEMORY_PROPS.KEYWORDS,
          tagsProperty: MEMORY_PROPS.TAGS,
          projectId: opts.projectId,
          // Default `includeUnscoped: true` matches
          // `MemoryService.list`'s default `projectOrUnscopedFilter`
          // — without this, project-scoped near-dup probes would
          // miss vault-wide memories that REST surfaces.
          ...(opts.topicId !== undefined ? { topicId: opts.topicId } : {}),
          ...(opts.tags && opts.tags.length > 0 ? { tags: opts.tags } : {}),
          ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
          ...(opts.excludeKinds && opts.excludeKinds.length > 0
            ? { excludeKinds: opts.excludeKinds }
            : {}),
          ...(opts.statuses && opts.statuses.length > 0
            ? { statuses: opts.statuses }
            : {}),
          ...(excludeStatuses ? { excludeStatuses } : {}),
          cleanupOrphanSentinel: MEMORY_CLEANUP_ORPHAN_SENTINEL,
          limit: opts.limit,
        })
        // One `pages.retrieve` per id, gated by the shared rate-
        // limit gate. Hydrate via `getPropertiesById` (no body
        // fetch) so the returned shape matches the REST path's
        // `includeContent: false` — `content: ""`.
        const memories = await Promise.all(
          pageIds.map((id) =>
            this.getPropertiesById(id).catch((err: unknown) => {
              // A single failed id should not collapse the SQL
              // branch — drop it and continue. Hydration failures
              // are typically archived-after-query races; the row
              // would have been filtered out by the REST path's
              // `is_full_page` + `archived` filter anyway.
              if (process.env["LORE_DEBUG"] === "1") {
                process.stderr.write(
                  `[lore] partial-failure: source=near-duplicate-hydrate ` +
                    `pageId=${id} error=${err instanceof Error ? err.message : "unknown"}\n`
                )
              }
              return null
            })
          )
        )
        // SQL applies exact tag filter before LIMIT (see SQL
        // composition above), so the hydrated list is already
        // tag-filtered and truncated to `opts.limit`. No JS
        // post-filter needed for tags.
        return memories.filter((m): m is Memory => m !== null)
      } catch (err) {
        if (isSqlValidationError(err)) {
          // Surface to the operator: a 400 / validation_error
          // indicates query-shape drift —
          // column rename, gateway syntax change, parameter
          // binding shape change. Silent fallback would mask a
          // permanent SQL-rollout failure as "REST path always
          // ran." The error message carries the gateway's
          // specifics. Transient (network / 5xx / 429 /
          // restricted / unauthorized / malformed) failures still
          // fall back per call.
          throw err
        }
        logRunToolFallback("near-duplicate-candidates", err)
        // fall through to REST path
      }
    }

    const { items } = await this.list({
      projectId: opts.projectId,
      ...(opts.topicId !== undefined ? { topicId: opts.topicId } : {}),
      ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
      ...(opts.excludeKinds && opts.excludeKinds.length > 0
        ? { excludeKinds: [...opts.excludeKinds] }
        : {}),
      ...(opts.tags && opts.tags.length > 0 ? { tags: [...opts.tags] } : {}),
      limit: opts.limit,
      includeContent: false,
      ...(opts.includeProposed !== undefined
        ? { includeProposed: opts.includeProposed }
        : {}),
    })
    return items
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
    const filters: Array<Record<string, unknown>> = []

    if (opts?.projectId) {
      filters.push(
        opts.includeUnscoped === false
          ? { property: MEMORY_PROPS.PROJECT, relation: { contains: opts.projectId } }
          : projectOrUnscopedFilter(opts.projectId)
      )
    }
    if (opts?.topicId) {
      filters.push({
        property: MEMORY_PROPS.TOPIC,
        relation: { contains: opts.topicId },
      })
    }
    if (opts?.source) {
      filters.push({
        property: MEMORY_PROPS.SOURCE,
        select: { equals: opts.source },
      })
    }
    if (opts?.kind) {
      filters.push({
        property: MEMORY_PROPS.KIND,
        select: { equals: opts.kind },
      })
    }
    if (opts?.excludeKinds && opts.excludeKinds.length > 0) {
      // One `does_not_equal` clause per excluded kind — Notion's
      // select filter has no `not_in` operator, so each value
      // gets its own clause. Pushed onto the outer `and:` chain
      // by the surrounding combiner. Mirrors the
      // `reviewTerminalStatusExclusionFilters` posture below.
      for (const k of opts.excludeKinds) {
        filters.push({ property: MEMORY_PROPS.KIND, select: { does_not_equal: k } })
      }
    }
    if (opts?.confidence) {
      filters.push({
        property: MEMORY_PROPS.CONFIDENCE,
        select: { equals: opts.confidence },
      })
    }
    if (opts?.status) {
      filters.push({
        property: MEMORY_PROPS.STATUS,
        select: { equals: opts.status },
      })
    } else if (opts?.includeProposed !== true) {
      // Default-exclude review-terminal statuses (`proposed` and
      // `rejected`) so neither pollutes default recall paths.
      // Explicit `status` short-circuits this branch — when the
      // caller asks for
      // `status: "proposed"` (the inbox-review path) or
      // `status: "rejected"` (the audit path) directly, that filter
      // wins. Notion's `does_not_equal` semantics cover both
      // explicit values and the null / unmigrated case (a row
      // with no Status column set is NOT review-terminal and
      // therefore passes the filter).
      filters.push(...reviewTerminalStatusExclusionFilters())
    }
    if (opts?.reviewBefore) {
      filters.push({
        property: MEMORY_PROPS.REVIEW_BY,
        date: { on_or_before: opts.reviewBefore },
      })
    }
    if (opts?.tags?.length) {
      if (opts.tags.length === 1) {
        filters.push({
          property: MEMORY_PROPS.TAGS,
          multi_select: { contains: opts.tags[0] },
        })
      } else {
        filters.push({
          or: opts.tags.map((t) => ({
            property: MEMORY_PROPS.TAGS,
            multi_select: { contains: t },
          })),
        })
      }
    }
    if (opts?.session) {
      filters.push({
        property: MEMORY_PROPS.SESSION,
        rich_text: { equals: opts.session },
      })
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

    const baseFilter =
      filters.length > 1
        ? { and: filters }
        : filters.length === 1
          ? filters[0]
          : undefined

    // Resurfaced cleanup-orphan exclusion. Pushed
    // server-side here so every consumer of `list` — including
    // `lore-query action='recall'`, the wake-up related-memories
    // pass, the autosave-learning probe, and `findNearDuplicates` —
    // uniformly drops sentinel-tagged rows. Without this, an orphan
    // restored from Notion's trash would surface in recall, wake-up,
    // and the dedup post-filter would have to catch it after
    // `MemoryService.list` had already consumed candidate-pool slots.
    //
    // Default scope filter. Composed before the orphan
    // exclusion so both clauses live in the same top-level `and`.
    // `includeOutOfScope: true` skips the scope clause for audit
    // paths (`lore status` expiring-rows surface, conflict scanner,
    // near-duplicate probe pool).
    const scopedFilter =
      opts?.includeOutOfScope === true || !this.scopeFilterEnabled
        ? baseFilter
        : withDefaultScopeFilter(baseFilter, this.scopeCtx, todayUtc())
    const filter = withCleanupOrphanExclusion(scopedFilter)

    const limit = Math.min(opts?.limit ?? 20, 100)
    if (limit <= 0) {
      return { items: [], nextCursor: opts?.startCursor, capped: false }
    }

    // Notion's compound-filter language caps nesting at 2 levels,
    // so `defaultScopeInclusionFilter` emits a server-side shape
    // that includes the reader's narrow kinds without binding each
    // kind to its key. The kind+key binding runs client-side via
    // `matchesDefaultScope` here. The walker over-fetches by the
    // slots dropped on the client side; backfilled pagination keeps
    // the result at the caller's requested limit.
    const today = todayUtc()
    const applyExtraFilter =
      opts?.includeOutOfScope === true || !this.scopeFilterEnabled
        ? undefined
        : (page: PageObjectResponse) =>
            matchesDefaultScope(page.properties, this.scopeCtx, today)
    const result = await collectLivePages({
      limit,
      startCursor: opts?.startCursor,
      source: "MemoryService.list",
      query: ({ page_size, start_cursor }) =>
        this.client.dataSources.query({
          data_source_id: this.db.dataSourceId,
          filter: filter as QueryDataSourceParameters["filter"],
          sorts: [
            {
              timestamp: opts?.sortBy ?? "last_edited_time",
              direction: opts?.direction ?? "descending",
            },
          ],
          page_size,
          start_cursor,
        }),
      extraFilter: applyExtraFilter,
    })

    if (opts?.includeContent !== true) {
      // `pageToMemory` is still async on the body-skipped branch —
      // the wrap pays only the relation-hydration cost (per-row
      // `pages.properties.retrieve` for truncated relation columns
      // when `has_more: true`), not a body fetch. The N-way
      // `pages.retrieveMarkdown` fan-out lives in the explicit-true
      // branch below.
      //
      // Passing `""` to `pageToMemory` produces rows whose `content`
      // field is the empty string. The runtime invariant matches the
      // `MemoryWithoutContent` (`content: ""`) literal-typed shape that
      // the omitted-or-false overload advertises; TypeScript cannot
      // infer the literal from the empty-string argument alone, so the
      // cast bridges the runtime guarantee to the type-level signal.
      const items = (await Promise.all(
        result.pages.map((page) => this.pageToMemory(page, ""))
      )) as MemoryWithoutContent[]
      return {
        items,
        nextCursor: result.nextCursor,
        capped: result.capped,
      }
    }

    const items = await Promise.all(
      result.pages.map(async (page) => {
        const md = await this.client.pages.retrieveMarkdown({ page_id: page.id })
        return await this.pageToMemory(page, md.markdown)
      })
    )
    return { items, nextCursor: result.nextCursor, capped: result.capped }
  }

  /**
   * Search memories. Three execution modes (see the `SearchMode` type):
   *
   * - `"contains"` — DS-scoped `dataSources.query` with Title/Keywords
   * `contains` filters and server-side property filters
   * (`projectId` / `topicId` / `tags` / `kind` / `status`). No workspace
   * leakage, no vector ranking — best for substring/exact-phrase queries.
   * - `"semantic"` — Workspace-wide `client.search`, ranked by Notion's
   * embedding index over titles AND bodies. Property filters degrade to
   * client-side post-filters since `client.search` lacks property-filter
   * support. Best for phrase-shaped queries that need body relevance.
   * - `"hybrid"` (default) — fire contains and semantic in parallel; if
   * contains saturates (`>= HYBRID_FALLBACK_THRESHOLD` hits), use the
   * contains rows alone and discard the parallel semantic result.
   * Otherwise merge the two ranked lists via Reciprocal Rank Fusion
   * (RRF) with a deterministic tie-break (encoded in
   * `searchByHybridPages`). Speculative parallelism keeps wall-clock
   * at one round-trip
   * (≈ `client.search` latency) regardless of which leg saturates —
   * the cheap-path waste is one discarded Notion call, governed by the
   * shared rate limiter.
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
   * workspace-wide path. Use as a rollback escape hatch if the
   * contains path silently under-recalls in a vault that hasn't
   * run `lore migrate --fix-memory-encoding` yet (encoded titles
   * miss substring matches against post-decode queries).
   */
  async search(input: SearchMemoriesInput): Promise<Memory[]> {
    const { memories } = await this.runSearch(input)
    return memories
  }

  async searchWithMeta(input: SearchMemoriesInput): Promise<{
    memories: Memory[]
    capped: boolean
  }> {
    const { memories, capped } = await this.runSearch(input)
    return { memories, capped }
  }

  /**
   * Same pipeline as `searchWithMeta`, plus a per-row diagnostic trace aligned
   * by index (`explain[i]` describes `memories[i]`). Separate methods rather
   * than one overloaded return type keep `search()`'s `Memory[]` contract
   * stable for existing callers while letting MCP renderers opt into cap
   * metadata and score traces independently.
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
    capped: boolean
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
    input: SearchMemoriesInput
  ): Promise<{ memories: Memory[]; explain: SearchExplain[]; capped: boolean }> {
    const requested: SearchMode = input.mode ?? "hybrid"
    const mode: SearchMode = this.features.forceSemanticSearch ? "semantic" : requested
    const limit = input.limit ?? 10

    // Normalize intent once at the entry point. Both the saturation-bypass
    // gate in `searchByHybridPages` and the query composition in
    // `searchBySemanticPages` need to agree on what counts as "intent is
    // set." Whitespace-only intent (`" "`) collapses to `null` here so a
    // caller can't accidentally bypass the cutoff or pollute the semantic
    // query with whitespace.
    const trimmedIntent = input.intent?.trim()
    const intent =
      trimmedIntent !== undefined && trimmedIntent.length > 0 ? trimmedIntent : null

    let pages: PageObjectResponse[]
    let explainBranch: SearchExplain["branch"]
    let hybridTrace: Map<string, HybridTraceEntry> | null = null
    let capped: boolean

    if (mode === "contains") {
      // `searchByContainsPages` deliberately ignores `input.intent`; it
      // reads only `input.query` for the substring filter. Appending
      // intent into a contains substring would narrow recall in the
      // opposite direction the disambiguator exists to fix.
      const result = await this.searchByContainsPages(input)
      pages = result.pages
      capped = result.capped
      explainBranch = "contains-only"
    } else if (mode === "semantic") {
      const result = await this.searchBySemanticPages(input, intent)
      pages = result.pages
      capped = result.capped
      explainBranch = "semantic-only"
    } else {
      const hybrid = await this.searchByHybridPages(input, limit, intent)
      pages = hybrid.pages
      explainBranch = hybrid.branch
      hybridTrace = hybrid.trace
      capped = hybrid.capped
    }

    const selectedPages = pages.slice(0, limit)
    const memories = await this.materializeMemories(selectedPages, input.includeContent)
    const explain = selectedPages.map((page, i): SearchExplain => {
      const factor = confidenceFactor(
        extractNumber(page.properties[MEMORY_PROPS.CONFIDENCE_SCORE]),
        this.features
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
    return { memories, explain, capped }
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
   * per path.
   *
   * Returns raw `PageObjectResponse[]` plus cap metadata so the caller can
   * dedupe with other paths' output before materializing markdown bodies and
   * still report when archived-row refill stopped early.
   *
   * **Body matches are not searched** — Notion's `dataSources.query` filter
   * surface only exposes property predicates, not page-body text. Callers
   * that need body relevance should use `"semantic"` or rely on the
   * `"hybrid"` fallback.
   */
  private async fetchContainsPages(
    input: SearchMemoriesInput
  ): Promise<SearchPagesResult> {
    const limit = Math.min(input.limit ?? 10, 100)
    const filters: Array<Record<string, unknown>> = []

    if (input.projectId) {
      filters.push(projectOrUnscopedFilter(input.projectId))
    }
    if (input.topicId) {
      filters.push({
        property: MEMORY_PROPS.TOPIC,
        relation: { contains: input.topicId },
      })
    }
    if (input.tags?.length) {
      // Mirrors the OR semantics of `MemoryService.list`: any-tag-matches.
      // Tightening to AND would silently under-shoot the candidate pool for
      // multi-tag queries.
      filters.push(
        input.tags.length === 1
          ? { property: MEMORY_PROPS.TAGS, multi_select: { contains: input.tags[0] } }
          : {
              or: input.tags.map((t) => ({
                property: MEMORY_PROPS.TAGS,
                multi_select: { contains: t },
              })),
            }
      )
    }
    if (input.kind) {
      filters.push({ property: MEMORY_PROPS.KIND, select: { equals: input.kind } })
    }
    if (input.status) {
      filters.push({ property: MEMORY_PROPS.STATUS, select: { equals: input.status } })
    } else if (input.includeProposed !== true) {
      // Same default-exclude posture as `MemoryService.list`: both
      // `proposed` (inbox-pending) and `rejected` (terminal-off-recall)
      // rows are filtered out of default search recall paths.
      // Explicit `status` short-circuits this branch.
      filters.push(...reviewTerminalStatusExclusionFilters())
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
          { property: MEMORY_PROPS.TITLE, title: { contains: trimmed } },
          { property: MEMORY_PROPS.KEYWORDS, rich_text: { contains: trimmed } },
          { property: MEMORY_PROPS.SYNOPSIS, rich_text: { contains: trimmed } },
        ],
      })
    }

    // No filters AND empty query → `filter: undefined` returns every row in
    // the DS sorted by recency, capped at `limit`. Intentional, not a
    // degenerate-input bug: callers passing only `mode: "contains"` with
    // no scope and no query get the equivalent of `lore-query action='recall'` minus
    // cursor pagination. A future reader: do not add a guard here.
    const baseFilter =
      filters.length > 1
        ? { and: filters }
        : filters.length === 1
          ? filters[0]
          : undefined

    // Resurfaced cleanup-orphan exclusion. Pushed
    // server-side so a restored-from-trash orphan does not consume a
    // contains-lane slot and silently saturate the
    // `HYBRID_FALLBACK_THRESHOLD` cutoff, masking real semantic hits.
    //
    // Default scope filter. Same posture as `list` —
    // narrow-scope rows whose `scopeKey` doesn't match the reader's
    // identity slot drop out of the contains lane by default.
    const scopedFilter =
      input.includeOutOfScope === true || !this.scopeFilterEnabled
        ? baseFilter
        : withDefaultScopeFilter(baseFilter, this.scopeCtx, todayUtc())
    const filter = withCleanupOrphanExclusion(scopedFilter)

    if (limit <= 0) return { pages: [], capped: false }

    // Kind+key binding runs client-side here too: Notion's 2-deep
    // compound-filter limit makes server-side narrow binding
    // structurally impossible; the walker backfills via `extraFilter`.
    const containsToday = todayUtc()
    const containsExtraFilter =
      input.includeOutOfScope === true || !this.scopeFilterEnabled
        ? undefined
        : (page: PageObjectResponse) =>
            matchesDefaultScope(page.properties, this.scopeCtx, containsToday)

    const result = await collectLivePages({
      limit,
      source: "MemoryService.fetchContainsPages",
      query: ({ page_size, start_cursor }) =>
        this.client.dataSources.query({
          data_source_id: this.db.dataSourceId,
          filter: filter as QueryDataSourceParameters["filter"],
          // No relevance ranking is available on `dataSources.query`; sort by
          // recency so the latest-edited matches surface first.
          sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
          page_size,
          start_cursor,
        }),
      extraFilter: containsExtraFilter,
    })
    if (result.capped) {
      warnLivePageCapFired({
        source: "MemoryService.fetchContainsPages",
        pages: result.pageCount,
        accumulated: result.pages.length,
        limit,
      })
    }

    return { pages: result.pages, capped: result.capped }
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
   *
   * **Paginates** up to `SEMANTIC_SEARCH_MAX_PAGES` raw pages of
   * `client.search` results before yielding. The post-filter to the
   * Memories DS plus caller-provided property filters can drop most of
   * a single raw page in workspaces dominated by non-Lore pages or
   * under narrow `projectId` / `kind` / `status` constraints; matching
   * Lore memories that fall after the first 100 raw hits would
   * otherwise be invisible to the caller. Loop exits early once
   * accumulated filtered hits cover the requested `limit` OR Notion
   * signals `has_more: false`. See `SEMANTIC_SEARCH_MAX_PAGES` for the
   * cap rationale.
   *
   * **Cooperative cancellation.** `searchByHybridPages`
   * passes an `AbortSignal` so the saturating-contains branch can
   * curtail the in-flight semantic pagination. The signal is checked
   * at three points per iteration:
   *
   * 1. **Pre-loop**, once on entry — defensive against direct
   * callers passing an already-aborted signal.
   * 2. **Pre-call**, before each `await this.client.search(...)` —
   * catches an abort that fired between the previous iteration's
   * post-page check and the current iteration's network call.
   * 3. **Post-page**, after the page lands — catches an abort that
   * fired during the page's `await`.
   *
   * `applySemanticPostFilters` additionally re-checks the signal
   * before its `hydrateRelationPropertiesForPages` call so a long
   * relation-hydration tail does not run on a discarded page.
   *
   * The Notion SDK v5 does NOT expose a per-call `AbortSignal` on its
   * public types (`SupportedRequestInit` carries no `signal` field;
   * the `fetch` option on `ClientOptions` is set at construction, not
   * per-call), so we cannot truly cancel an outstanding HTTP request
   * from here. What we CAN do is keep the in-flight request from
   * spawning further pages.
   *
   * **Residual-call bound.** In production, `client.search` is a
   * network call whose `await` yields the event loop for tens to
   * hundreds of milliseconds. By the time semantic page N's response
   * lands and the continuation runs, contains' saturation handler
   * has had ample microtask time to drain, the post-page check
   * trips, and page N+1 never dispatches — residual is **1**: the
   * page that was in flight when `controller.abort()` ran. The
   * earlier worst case was up to `SEMANTIC_SEARCH_MAX_PAGES` (5)
   * sequential calls.
   *
   * **Synchronous-mock degenerate case.** When both promises resolve
   * in the same JS tick (test mocks that return synchronously,
   * pathologically fast networks), the microtask ordering is
   * `[semantic continuation, saturation handler]` — semantic's
   * continuation runs first, processes page N, dispatches page N+1's
   * `await client.search(...)`, and only THEN does the saturation
   * handler fire. Page N+1 lands as the second residual. Tests in
   * this codebase use `await new Promise(r => setTimeout(r, 0))`
   * inside the mock to force a macrotask boundary that lets the
   * saturation handler drain before the next page would dispatch,
   * pinning the production-typical "residual = 1" behavior.
   *
   * On abort, the loop throws an `AbortError`-shaped rejection (via
   * `buildAbortError`); `searchByHybridPages` recognizes that shape
   * via `isAbortRejection` and treats it as a clean discard rather
   * than a real branch failure.
   */
  private async fetchSemanticPages(
    input: SearchMemoriesInput,
    intent: string | null,
    signal?: AbortSignal
  ): Promise<PageObjectResponse[]> {
    // Compose `client.search`'s `query` from the caller's `query` plus
    // any normalized intent. The `[query.trim(), intent].filter(Boolean)`
    // shape handles the edge case where `query` is empty (allowed on
    // `MemoryService.search` callers that pass `""` for unscoped relevance
    // lookups) without producing a leading space — `" intent"` may rank
    // differently from `"intent"` alone under Notion's unspecified ranking.
    // The contains branch sees ONLY `input.query`; intent never narrows it.
    const composedQuery =
      intent !== null
        ? [input.query.trim(), intent].filter(Boolean).join(" ")
        : input.query
    const limit = input.limit ?? 10

    // Flag-gated RunTool `search` branch. The pinned schema
    // has structural divergences from REST `client.search` that the
    // wrapper cannot mask:
    //
    // - **Empty query.** RunTool requires `query.length >= 1`; REST
    // accepts `""` for unscoped relevance / list-like callers. We
    // route empty composed queries through REST.
    // - **Window cap.** RunTool's `page_size <= 25` and no documented
    // cursor; REST paginates 100/page up to
    // `SEMANTIC_SEARCH_MAX_PAGES`. When the caller asks for `limit`
    // greater than the RunTool cap, the wrapper cannot represent
    // the requested window in one call so we route through REST.
    // - **Saturation under post-filter.** Even within the cap, Lore's
    // `applySemanticPostFilters` may discard most of a 25-row
    // response (project / kind / status / scope / archive / cleanup-
    // orphan client-side narrowing). When the post-filter survivors
    // come up short AND the raw response saturated at the cap, the
    // RunTool path's recall is provably under-served and we fall
    // back to REST per call.
    //
    // 403 `RestrictedResource` is fall-back-able via
    // `RunToolSearchRestrictedError` (auth-refresh proxy can't repair;
    // once-per-process stderr warning fires). All other classes (400
    // validation, 401, 429, 5xx, malformed) propagate verbatim — the
    // canonical error vocabulary pinned by the `update_page` wrapper.
    if (
      this.features.runTool.search &&
      composedQuery.trim().length > 0 &&
      limit <= RUNTOOL_SEARCH_MAX_PAGE_SIZE
    ) {
      const runToolPages = await this.fetchSemanticPagesViaRunTool(
        input,
        composedQuery,
        limit,
        signal
      )
      if (runToolPages !== null) return runToolPages
      // `null` sentinel ⇒ the RunTool branch couldn't serve this
      // call. Two paths produce it: 403 RestrictedResource on the
      // search dispatch, and saturation (raw response hit the
      // 25-row cap, signaling REST may have additional matches
      // beyond the no-cursor window that could change ranking
      // under confidence-rerank or RRF). Cooperative abort throws
      // an `AbortError`-shaped value rather than returning `null`,
      // so abort propagates through this `await`.
    }

    const accumulated: PageObjectResponse[] = []
    // Dedup across paginated pages. Within a single `client.search` page
    // Notion guarantees unique ids; the cross-page collision case the
    // dedup defends against is a concurrent edit between the page-N
    // and page-N+1 fetches that promotes the same memory's ranking on
    // page-N+1 from "off the page" to "on the page." Notion's search
    // does NOT live-rerank between cursor steps (each call is a fresh
    // workspace-wide query, not a slice of a frozen result set), so
    // any vault mutation in flight CAN surface the same id twice
    // across calls. Pre-pagination this couldn't happen — single page
    // meant single observation.
    //
    // Dedup is load-bearing on **both** consumers, for different
    // reasons:
    //
    // - **Hybrid (`searchByHybridPages`).** Without dedup, the RRF
    // accumulator processes the same id twice and adds two
    // per-branch contributions (`(1/(RRF_K+rank1+1)) * factor +
    // (1/(RRF_K+rank2+1)) * factor`) under the *same* `branchKind`,
    // inflating that row's fused score above what a single
    // observation would produce. Cross-branch agreement (the signal
    // RRF surfaces) gets falsified into intra-branch double-credit;
    // fixture-pinned ordering drifts.
    // - **Semantic-only (`searchBySemanticPages`).** Without dedup,
    // the caller sees the same `Memory` rendered twice in the
    // result list — a visible correctness bug, not just a ranking
    // shift. `runSearch`'s `pages.slice(0, limit)` cap doesn't
    // collapse duplicates either; it just truncates.
    //
    // One Set; one mechanism; both consumers protected.
    const seen = new Set<string>()
    // `cursor` is explicitly typed `string | undefined` (NOT `string |
    // null | undefined`) so a future contributor adding a third
    // continuation branch cannot reintroduce `null` into the variable
    // without a type-check failure. The `next_cursor` early-out below
    // guarantees we never assign `null` here today, but the annotation
    // pins that invariant for the next reader.
    let cursor: string | undefined = undefined
    // `cappedOut` tracks whether the loop exhausted
    // `SEMANTIC_SEARCH_MAX_PAGES` without breaking early. JS has no
    // `for...else` so the natural Python idiom is replaced with a
    // boolean reset on every break path.
    let cappedOut = true
    // Pre-loop abort check is the defensive gate for direct callers
    // passing an already-aborted signal — `searchByHybridPages`'s own
    // dispatch path cannot reach here with `signal.aborted === true`
    // because both branches dispatch synchronously in parallel before
    // the contains `.then` saturation handler can fire. The defense
    // matters for future direct callers (operator tooling, future MCP
    // surfaces) that may construct a controller, abort it, then pass
    // the signal — without this gate, we'd burn at least one
    // `client.search` call in that case.
    if (signal?.aborted) {
      throw buildAbortError(signal)
    }
    for (let pageIndex = 0; pageIndex < SEMANTIC_SEARCH_MAX_PAGES; pageIndex++) {
      // Pre-call abort check catches an abort that fired between
      // the previous iteration's post-page check and the current
      // `await client.search(...)`. Both checks run in the same
      // sync continuation when no microtask drained between them,
      // so this is mainly defensive against (a) direct callers that
      // mutate the signal between iterations and (b) future yields
      // that may be added inside the loop body but outside an
      // `await`. The dominant correctness lever for the residual-
      // call bound is the post-filter signal check inside
      // `applySemanticPostFilters`, which fires after `await
      // client.search` (drains microtasks) and before the heavy
      // hydration step. See `fetchSemanticPages`'s docstring for
      // the full ordering analysis.
      if (signal?.aborted) {
        throw buildAbortError(signal)
      }
      const response = await this.client.search({
        query: composedQuery,
        filter: { property: "object", value: "page" },
        page_size: 100,
        start_cursor: cursor,
      })

      // Threading `signal` into post-filter so the synchronous early
      // exit on abort short-circuits BEFORE `hydrateRelationPropertiesForPages`
      // — that helper paginates relation-property fetches and is the
      // dominant residual cost on a saturating-contains run when
      // `client.search`'s response carries 100 hits. Skipping the
      // hydration when we already know the result is destined for the
      // discard pile keeps the saturation-path waste at "the in-flight
      // page's headers landed" rather than "the in-flight page's
      // headers AND every relation-hydration round-trip the page
      // implies."
      for (const page of await this.applySemanticPostFilters(
        response.results as PageObjectResponse[],
        input,
        signal
      )) {
        if (seen.has(page.id)) continue
        seen.add(page.id)
        accumulated.push(page)
      }

      // Saturation: enough filtered rows accumulated to satisfy the
      // caller's `limit`. Stop before paying for the next round-trip.
      if (accumulated.length >= limit) {
        cappedOut = false
        break
      }
      // Exhaustion: Notion has no more pages to return, OR the response
      // returned `has_more: true` with `next_cursor: null` — an
      // inconsistent shape Notion's documented contract excludes but the
      // SDK type permits. Treat both as exhaustion; advancing the loop
      // with `start_cursor: undefined` would re-fetch page 1 and spin.
      if (!response.has_more || response.next_cursor == null) {
        cappedOut = false
        break
      }
      // Cooperative cancellation point — see the docstring above for
      // why the check sits here, after the just-completed page lands
      // its survivors. Throwing rather than `break`-ing matters: under
      // hybrid the outer `Promise.allSettled` consumer needs a
      // rejection to distinguish "aborted partway through pagination"
      // from "loop ran to completion and returned a partial
      // accumulator." A silent break would let a partial semantic
      // result leak into the RRF merge on the saturation branch
      // (where it's supposed to be discarded entirely). Paired with
      // the pre-call check at the top of the next iteration, both
      // microtask orderings (contains-handler-first or
      // semantic-continuation-first) honor the residual-call bound.
      if (signal?.aborted) {
        throw buildAbortError(signal)
      }
      cursor = response.next_cursor
    }
    if (cappedOut) {
      // Loop exhausted SEMANTIC_SEARCH_MAX_PAGES without saturating or
      // hitting `has_more: false`. Surface a single stderr line under
      // LORE_DEBUG=1 so an operator triaging "lore-query returned an
      // empty / short result" can distinguish the cap-fired pathological
      // case from genuine no-matches. The `LORE_DEBUG` gate keeps the
      // common (non-pathological) path silent.
      debugLogSemanticSearchCapFired(SEMANTIC_SEARCH_MAX_PAGES, accumulated.length, limit)
    }

    // Return WITHOUT a final `slice(0, limit)` trim. The saturation gate
    // already bounds `accumulated.length` to `[0, limit + page_size − 1]`
    // (the page that crossed the threshold landed all of its post-filter
    // survivors before the break). Two consequences make the unbounded
    // return correct:
    //
    // - Semantic-only path: `runSearch` trims `pages.slice(0, limit)` at
    // the call boundary (the authoritative final cap). Re-trimming
    // here would be redundant.
    // - Hybrid path: `searchByHybridPages` consumes the full accumulator
    // in its RRF merge. A row at semantic-rank 11 that ALSO appears
    // in contains contributes its `1/(RRF_K + 11 + 1)` to the fused
    // score and can plausibly beat a contains-only row — but only if
    // it survives long enough to reach the accumulator. Trimming to
    // `limit` here would silently nullify that cross-branch signal
    // for the under-shoot case RRF exists to handle.
    //
    // Pre-PR the equivalent narrowing was structural (single page of
    // 100 trimmed to limit), so this is not a fix-for-regression but a
    // recall improvement on the same axis pagination opened up.
    return accumulated
  }

  /**
   * RunTool `search` consumer for the semantic lane.
   *
   * Returns `PageObjectResponse[]` shaped exactly like
   * `fetchSemanticPages`'s legacy REST output so the rest of
   * `runSearch` (post-filter, sort, materialize, explain) consumes
   * either path identically. Returns `null` to signal "couldn't
   * serve this call; caller falls back to REST" — used for 403
   * RestrictedResource and saturation. Cooperative abort throws an
   * `AbortError`-shaped value rather than returning `null`, so
   * `searchByHybridPages`'s `Promise.allSettled` discard works
   * unchanged.
   *
   * **Scoping.** `data_source_url: collection://<memories-data-
   * source-id>` narrows server-side, so the post-filter pipeline's
   * parent-DB filter is structurally a no-op on the RunTool path
   * (every hit is already in the Memories DS). The pipeline still
   * runs because it carries every other narrowing — project
   * inheritance, topic, tags, kind, status, scope, archived,
   * cleanup-orphan — and it's cheaper to keep one filter shape than
   * to build a divergent post-filter.
   *
   * **Hydration.** RunTool's `search` returns `{id, title, url, ...}`
   * per hit — Lore's post-filter and `materializeMemories` need full
   * `PageObjectResponse` shapes (parent, properties, archived flag).
   * The wrapper hydrates each hit through `pages.retrieve`, which is
   * proxied by `createLimitedClient` so the per-token rate-limit
   * gate paces the fan-out. The wrapper requests
   * `RUNTOOL_SEARCH_MAX_PAGE_SIZE` (25) regardless of caller
   * `limit` so `applySemanticPostFilters` has the most headroom;
   * production callers omit `pageSize` to get this default. 25
   * retrieves is therefore both the cap and the typical case.
   *
   * **Saturation handling — ranking-parity rule.** When the raw
   * response carries 25 hits, the no-cursor schema cannot surface
   * matches beyond that window. Those hidden matches affect ranking
   * even when the visible 25 already produced `>= limit` survivors:
   * `rerankByConfidence` (semantic-only) can promote a high-
   * confidence row at REST rank 11 into the final top-`limit`, and
   * hybrid RRF consumes the semantic accumulator beyond the
   * display limit. So the only safe condition for returning RunTool
   * results is `outcome.saturated === false`. When saturated, the
   * helper returns `null` and the caller drops through to REST,
   * which paginates up to `SEMANTIC_SEARCH_MAX_PAGES` × 100 = 500
   * raw rows.
   *
   * **Error classification.** 403 → `null` (silent fall-back,
   * once-per-process stderr warning fires inside the wrapper). 401 /
   * 429 / 5xx / 400 / malformed propagate verbatim — the canonical
   * vocabulary pinned by the `update_page` wrapper.
   */
  private async fetchSemanticPagesViaRunTool(
    input: SearchMemoriesInput,
    composedQuery: string,
    limit: number,
    signal?: AbortSignal
  ): Promise<PageObjectResponse[] | null> {
    if (signal?.aborted) {
      throw buildAbortError(signal)
    }

    let outcome
    try {
      outcome = await searchViaRunTool(this.client, {
        query: composedQuery,
        dataSourceId: this.db.dataSourceId,
        // `pageSize` is omitted so the wrapper applies its default
        // (`RUNTOOL_SEARCH_MAX_PAGE_SIZE`). We always want the
        // server cap regardless of caller `limit`:
        // `applySemanticPostFilters` is the authoritative cap and
        // the post-filter narrows aggressively (project / kind /
        // status / scope / archived / cleanup-orphan). Maxing out
        // the raw window minimizes saturation-induced REST fallback
        // for typical small-`limit` callers without changing the
        // final shape of the result.
      })
    } catch (err) {
      if (err instanceof RunToolSearchRestrictedError) {
        // 403 — auth-refresh proxy can't repair, REST/SDK path can.
        // Wrapper already emitted the once-per-process warning.
        return null
      }
      throw err
    }

    // Cooperative abort check between the network call and the
    // hydration loop — same posture as `applySemanticPostFilters`,
    // which checks before its `hydrateRelationPropertiesForPages`
    // call so a discarded response doesn't pay the heavy hydration
    // tail.
    if (signal?.aborted) {
      throw buildAbortError(signal)
    }

    if (outcome.hits.length === 0) {
      return outcome.saturated ? null : []
    }

    // Hydrate hits to full `PageObjectResponse` shapes. We iterate
    // sequentially with a per-hit signal check at the top of each
    // iteration. `Promise.all`'s parallel dispatch would queue all
    // 25 retrieves through `createLimitedClient`'s outbound bucket
    // before observing a mid-flight abort, defeating the point of
    // cooperative cancellation. Sequential trades a small wall-
    // clock cost (the rate-limit proxy paces dispatch anyway) for
    // proper bounded residual cost.
    //
    // **N+1 cost.** Each hit spawns one `pages.retrieve` round-
    // trip, vs REST `client.search` which returns full
    // `PageObjectResponse[]` from one call. Worst case is 25
    // retrieves paced by the global outbound rate-limit bucket (or
    // by the `pages.retrieve` endpoint override if one is
    // configured), vs REST's single round-trip. This is the cost of
    // opting in to the RunTool search path; tests pin it but
    // operators reading the rollout runbook should know.
    //
    // **Hydrate via `hit.url`, not `hit.id`.** The pinned RunTool
    // schema documents "url is page id for Notion results" —
    // the `url` field carries the Notion page id while
    // `id` is the search index's internal resource id and is
    // NOT guaranteed to match the page id. The wrapper's
    // `isNotionInternalHit` already validates `url` is a Notion
    // page id (regex matches 32-hex or dashed UUID), so by
    // construction `hit.url` is the right value to pass to
    // `pages.retrieve`.
    //
    // Per-id retrieval failures: 404 / RestrictedResource drop
    // silently — Notion's search index lags delete / archive /
    // permission-revocation, so a stale hit is expected. Every
    // other class (401, 429, 5xx, network) propagates so the
    // rate-limit and auth-refresh proxies engage on their canonical
    // surface.
    const pages: PageObjectResponse[] = []
    for (const hit of outcome.hits) {
      if (signal?.aborted) {
        throw buildAbortError(signal)
      }
      let page: Awaited<ReturnType<typeof this.client.pages.retrieve>>
      try {
        page = await this.client.pages.retrieve({ page_id: hit.url })
      } catch (err) {
        if (
          isNotionClientError(err) &&
          (err.code === APIErrorCode.ObjectNotFound ||
            err.code === APIErrorCode.RestrictedResource)
        ) {
          continue
        }
        throw err
      }
      if (!isFullPage(page as Parameters<typeof isFullPage>[0])) continue
      pages.push(page as PageObjectResponse)
    }

    const filtered = await this.applySemanticPostFilters(pages, input, signal)

    // Saturation forces REST fallback **regardless of post-filter
    // survivor count**. When the raw window saturated at 25, the
    // server has more matches that the no-cursor schema cannot
    // surface — and those hidden matches affect ranking even when
    // the visible 25 already produced `>= limit` survivors:
    //
    // - **Semantic-only (`mode: "semantic"`)** runs
    // `rerankByConfidence` AFTER `fetchSemanticPages` returns
    // (`runSearch` → public `searchBySemanticPages` path). A
    // high-confidence row at REST semantic survivor rank 11
    // (within REST's 100-row first page) can be promoted into
    // the final top-`limit` by the confidence factor. The
    // RunTool path never sees that row if it sits beyond raw
    // hit 25 — even though we have `limit` survivors visibly
    // available.
    //
    // - **Hybrid (`mode: "hybrid"`, the default)** consumes the
    // semantic accumulator beyond the display limit when
    // computing RRF. A row outside the first `limit` survivors
    // can still win after cross-branch fusion if it also
    // appears in contains. Truncating to 25 silently shrinks
    // the RRF pool relative to REST's up-to-500 raw-row pool
    // (`SEMANTIC_SEARCH_MAX_PAGES × page_size`).
    //
    // Therefore: `filtered.length >= limit` is NOT a proof of
    // ranking parity with REST. The only safe condition for
    // returning RunTool results without fallback is
    // `outcome.saturated === false` — i.e. "the server has shown
    // its hand at the requested page_size" — at which point REST
    // would not surface additional matches either. When saturated,
    // route through REST so `rerankByConfidence` and RRF see the
    // full candidate pool.
    if (outcome.saturated) {
      return null
    }

    return filtered
  }

  /**
   * Apply the parent-DB filter and caller-provided property post-filters
   * to a single raw page of `client.search` results. Pulled out of
   * `fetchSemanticPages` so the paginating loop can run filters per
   * page without re-inlining the predicate stack — a future filter
   * extension lands in one place rather than two.
   *
   * Excludes archived rows. `client.search` ignores Notion's `archived`
   * flag and returns archived pages alongside live ones; under the
   * paginated loop, an archived memory pushed into the accumulator
   * counts toward `limit` and can stop the loop before later live
   * matches are fetched, so a caller can get fewer usable results than
   * requested even though more non-archived memories exist on
   * subsequent search pages. Mirror the client-side filter every other
   * paginating walker applies (`findByTopicKey`, `listAllForBackfill`,
   * `listForScan`, `fetchContainsPages`).
   *
   * **Cooperative cancellation.** The optional `signal`
   * parameter is checked before the synchronous parent-DB filter AND
   * before `hydrateRelationPropertiesForPages` — the latter is the
   * dominant residual cost on a saturating-contains run because
   * hydration paginates relation-property fetches per surviving page.
   * Skipping the hydration when the signal is already aborted bounds
   * the saturation-path waste at "the in-flight `client.search`
   * response landed" rather than "headers AND every relation-
   * hydration round-trip the page implies." On abort we throw an
   * `AbortError`-shaped value that propagates back through
   * `fetchSemanticPages`'s `await` and out the loop's normal abort
   * path — `searchByHybridPages` then maps it to fulfilled-empty via
   * `isAbortRejection`, identical to the pre-call/post-page check
   * paths in `fetchSemanticPages` itself.
   */
  private async applySemanticPostFilters(
    pages: PageObjectResponse[],
    input: SearchMemoriesInput,
    signal?: AbortSignal
  ): Promise<PageObjectResponse[]> {
    if (signal?.aborted) {
      throw buildAbortError(signal)
    }
    // Filter results to only pages in our Memories database. Notion SDK v5
    // returns two parent-type shapes depending on how the page was created /
    // what the workspace has since been upgraded to: classic `database_id`
    // parents, and data-source-backed `data_source_id` parents. Match either
    // against our `DatabaseRef`. Drop archived rows in the same pass —
    // see the docstring above for why this matters under pagination.
    //
    // Also drop resurfaced cleanup-orphans. `client.search` has no
    // property-filter support, so the server-side `Keywords
    // does_not_contain` clause that DS-scoped walkers use cannot
    // apply here — the exclusion runs client-side on the already-
    // fetched page properties. Same posture as the archived and
    // parent-DB filters above.
    let filtered = pages.filter((page) => {
      if (!("parent" in page)) return false
      if (page.archived) return false
      const parent = page.parent
      if (parent.type === "database_id") {
        if (parent.database_id !== this.db.databaseId) return false
      } else if (parent.type === "data_source_id") {
        if (parent.data_source_id !== this.db.dataSourceId) return false
      } else {
        return false
      }
      const keywords = extractRichText(page.properties[MEMORY_PROPS.KEYWORDS])
      if (keywords.includes(MEMORY_CLEANUP_ORPHAN_SENTINEL)) return false
      return true
    })

    // Apply additional filters (project, topic, tags, kind, status). The
    // search API has no property-filter support, so these are post-filters.
    const filterRelationProperties: string[] = []
    if (input.projectId) filterRelationProperties.push(MEMORY_PROPS.PROJECT)
    if (input.topicId) filterRelationProperties.push(MEMORY_PROPS.TOPIC)
    if (filterRelationProperties.length > 0) {
      // Re-check the signal immediately before hydration. Hydration
      // is the heavy step (one `pages.retrieve` per row that lacks
      // resolved relation properties); skipping it on a signal that
      // flipped during the synchronous parent-DB filter above is the
      // tightest we can bound the per-page residual cost without
      // threading the signal into `hydrateRelationPropertiesForPages`
      // itself (which would require touching the shared notion-layer
      // helper for a memory-search-specific need).
      if (signal?.aborted) {
        throw buildAbortError(signal)
      }
      filtered = await hydrateRelationPropertiesForPages(
        this.client,
        filtered,
        filterRelationProperties
      )
    }

    if (input.projectId) {
      filtered = filtered.filter((page) => {
        const ids = extractRelationIds(page.properties[MEMORY_PROPS.PROJECT])
        return ids.length === 0 || ids.includes(input.projectId!)
      })
    }
    if (input.topicId) {
      filtered = filtered.filter((page) => {
        const ids = extractRelationIds(page.properties[MEMORY_PROPS.TOPIC])
        return ids.includes(input.topicId!)
      })
    }
    if (input.tags?.length) {
      filtered = filtered.filter((page) => {
        const pageTags = extractMultiSelect(page.properties[MEMORY_PROPS.TAGS])
        return input.tags!.some((t) => pageTags.includes(t))
      })
    }
    if (input.kind) {
      filtered = filtered.filter(
        (page) => extractSelect(page.properties[MEMORY_PROPS.KIND], "note") === input.kind
      )
    }
    if (input.status) {
      filtered = filtered.filter(
        (page) =>
          extractSelect(page.properties[MEMORY_PROPS.STATUS], "informational") ===
          input.status
      )
    } else if (input.includeProposed !== true) {
      // Default-exclude review-terminal rows (`proposed` and
      // `rejected`) from semantic search. `client.search` has no
      // property-filter support, so the exclusion runs as a
      // client-side post-filter — same
      // posture as the kind / status exact-match filters above.
      // Explicit `input.status` short-circuits this branch.
      filtered = filtered.filter(isNotReviewTerminalStatus)
    }

    // Default scope filter. Same posture as the
    // contains lane's server-side scope filter — `client.search` has
    // no property-filter support so the exclusion runs client-side.
    // `includeOutOfScope: true` opts out for audit paths; the filter
    // also no-ops when `scopeFilterEnabled` is false (tests
    // constructing the service without a scope context).
    if (input.includeOutOfScope !== true && this.scopeFilterEnabled) {
      const today = todayUtc()
      filtered = filtered.filter((page) =>
        matchesDefaultScope(page.properties, this.scopeCtx, today)
      )
    }

    return filtered
  }

  /**
   * Public DS-scoped contains path with confidence-aware reranking.
   * Calls `fetchContainsPages` for the raw Notion result, then maps each
   * row to a per-branch RRF score weighted by `confidenceFactor` and
   * sorts via `tieBreakingRrfCompare`. The factor is applied **here
   * exactly once** because hybrid does NOT consume this function — it
   * consumes `fetchContainsPages` directly. The decay pipeline contract
   * pins this once-per-row invariant.
   *
   * `mode: "contains"` callers see confidence-reranked recency order
   * — small reranking (RRF score declines slowly per rank) but a
   * stale row at rank 3 can drop below a fresh row at rank 5 if the
   * confidence delta is large enough. Pre-migration vaults
   * (`Confidence Score = null` on every row) are unaffected because
   * `confidenceFactor(null) = 1.0` reduces the algebra to the legacy
   * `1 / (RRF_K + rank + 1)` ordering, and `tieBreakingRrfCompare`
   * preserves Notion's input order on identical scores via the page
   * id ascending fall-through... but only when ids happen to align
   * with the input order. To preserve byte-identical pre-confidence
   * ordering when every row is unscored, we short-circuit early.
   */
  private async searchByContainsPages(
    input: SearchMemoriesInput
  ): Promise<SearchPagesResult> {
    const result = await this.fetchContainsPages(input)
    return {
      pages: rerankByConfidence(result.pages, "contains", this.features),
      capped: result.capped,
    }
  }

  /**
   * Public workspace-wide semantic path with confidence-aware reranking.
   * Symmetric to `searchByContainsPages`. Hybrid consumes
   * `fetchSemanticPages` directly so the factor is applied here exactly
   * once.
   */
  private async searchBySemanticPages(
    input: SearchMemoriesInput,
    intent: string | null
  ): Promise<SearchPagesResult> {
    const pages = await this.fetchSemanticPages(input, intent)
    return {
      pages: rerankByConfidence(pages, "semantic", this.features),
      capped: false,
    }
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
   * uses contains rows alone, ignoring the parallel semantic call.
   * Wasted one Notion call but no wall-clock cost. The shared
   * rate limiter bounds the cost.
   * - **Under-shooting case (RRF)**: merges the two ranked lists via
   * Reciprocal Rank Fusion. Each row's score is `Σ 1 / (RRF_K + rank +
   * 1)` summed across the branches it appears in (`RRF_K = 60`,
   * Cormack 2009). Cross-branch agreement scores higher than
   * single-branch presence — a row ranked #1 in both branches scores
   * `2/61` and beats a row ranked #1 in only one branch (`1/61`).
   * Tie-break order is `score → best-rank → contains-presence → page
   * id ascending` (encoded in `tieBreakingRrfCompare`). Capped at `limit`.
   *
   * The earlier sequential design paid `containsLatency + semanticLatency`
   * on under-shoot — strictly worse than the pre-PR single-call wall-clock
   * for a query that's now the *common* case.
   *
   * **Single-branch resilience.** A `Promise.all` over both legs
   * would propagate any rejection (a transient 429 from `client.search`,
   * for instance) to the caller, even when contains saturated independently
   * — a regression vs. the single-call latency floor. With
   * `Promise.allSettled` a rejected branch degrades to an empty result and
   * the surviving branch's rows are returned; both-branches-rejected still
   * surfaces an error so a fully broken search subsystem doesn't masquerade
   * as an empty-result silence. Branch failures are logged to stderr under
   * `LORE_DEBUG=1` so operators can distinguish a one-off blip from a
   * pathological loop. The kill switch (`LORE_FORCE_SEMANTIC_SEARCH=1`)
   * remains the manual rollback for sustained problems; this guard is the
   * automatic one for transient ones.
   *
   * **Cooperative cancellation when contains saturates.**
   * A side-effect `.then` handler on the contains promise calls
   * `controller.abort()` as soon as it observes a saturating contains
   * result (the predicate is encapsulated in `shouldUseSaturationCutoff`
   * — the same helper the saturation-cutoff branch below reads, so
   * the "should I abort?" gate cannot drift from the "should I take
   * the cutoff?" gate). The signal is plumbed into
   * `fetchSemanticPages`, which checks it pre-loop, pre-call, post-
   * page, AND inside `applySemanticPostFilters` so the residual cost
   * skips the heavy `hydrateRelationPropertiesForPages` step on
   * pages destined for the discard pile. Pre-fix, a saturating
   * contains query still paid up to `SEMANTIC_SEARCH_MAX_PAGES` (5)
   * sequential semantic round-trips before the discarded result
   * resolved; after the fix, the production-typical bound is **1
   * residual `client.search` call** (the page in flight when abort
   * fired), with the synchronous-mock degenerate case bounded at 2
   * — `fetchSemanticPages`'s docstring carries the full residual-
   * call bound analysis. The discarded-result rejection arrives as
   * an `AbortError`-shaped value which `isAbortRejection` filters
   * out of the partial-failure log path AND the both-failure
   * detector — a cooperative abort is not a real branch failure and
   * must not pollute `LORE_DEBUG=1` stderr or trip the both-down
   * outage path. The Notion SDK v5 does not expose a per-call
   * `signal` parameter, so the in-flight HTTP request is NOT
   * cancelled at the network layer; the win is bounding the
   * next-page burn, not zero-cost cancel.
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
    intent: string | null
  ): Promise<{
    pages: PageObjectResponse[]
    branch: "contains-saturated" | "rrf"
    trace: Map<string, HybridTraceEntry>
    capped: boolean
  }> {
    // Hybrid composes the **raw** fetch helpers, not the confidence-aware
    // public wrappers. Calling `searchByContainsPages` /
    // `searchBySemanticPages` here would double-apply the confidence
    // factor (once in the single-branch sort, once in the RRF accumulator
    // below) — collapsing the documented `[CONFIDENCE_FACTOR_MIN, 1.0]`
    // floor to `[CONFIDENCE_FACTOR_MIN², 1.0]` for hybrid callers.
    //
    // The controller drives the saturation-triggered cancellation of
    // the in-flight semantic pagination loop. Both
    // branches still dispatch in parallel — abort is a side-effect of
    // contains LANDING with a saturating result, not a precondition of
    // semantic dispatching. The signal flows into `fetchSemanticPages`
    // and is checked between `client.search` pages.
    const controller = new AbortController()
    const containsPromise = this.fetchContainsPages(input)
    const semanticPromise = this.fetchSemanticPages(input, intent, controller.signal)

    // Side-effect handler: as soon as contains lands fulfilled, decide
    // whether to abort. The handler is attached BEFORE the
    // `Promise.allSettled` await so the abort fires the moment
    // contains resolves rather than only after `Promise.allSettled`
    // itself settles (which would wait for semantic to finish on its
    // own — defeating the cutoff).
    //
    // The `.then(...)` short-circuits on rejection by language
    // semantics: contains rejection means we cannot make a saturation
    // decision, semantic is the only surviving branch left, and
    // aborting it would convert a recoverable contains-down case into
    // a both-down outage. The `.catch(() => {})` is doing exactly ONE
    // job — suppressing `UnhandledPromiseRejection` on the side-effect
    // chain when contains rejects. It is NOT making the
    // "don't abort on contains rejection" decision; that decision is
    // owned by `.then`'s rejection short-circuit. The primary
    // `Promise.allSettled` consumer below still observes the
    // rejection via its `status === "rejected"` branch, so the empty
    // catch here does not mask the failure.
    //
    // Intent gate: `shouldUseSaturationCutoff`'s docstring covers
    // why aborting under intent (`intent !== null`) would silently
    // nullify the intent-augmented semantic lane.
    void containsPromise
      .then((result) => {
        if (shouldUseSaturationCutoff(intent, result.pages)) {
          controller.abort()
        }
      })
      .catch(() => {
        /* unhandled-rejection suppression only — see comment block above */
      })

    const [containsResult, semanticResult] = await Promise.allSettled([
      containsPromise,
      semanticPromise,
    ])

    // Cooperative aborts on the semantic branch are NOT real failures.
    // Map an `AbortError`-shaped rejection to a fulfilled-empty value
    // here so:
    //
    // 1. The both-failure check below cannot trip on the
    // `(contains rejected) + (semantic aborted because we asked
    // for it)` combo. A semantic abort fires only after contains
    // settles fulfilled-saturating; a contains-rejected path
    // never aborts the semantic side. But the type system doesn't
    // enforce that ordering, and a future refactor that introduces
    // a different abort trigger should not silently break
    // both-failure detection.
    // 2. The partial-failure log below stays quiet on the abort path
    // — a cooperative discard isn't transient noise to surface
    // under `LORE_DEBUG=1`.
    const semanticEffective: PromiseSettledResult<PageObjectResponse[]> =
      semanticResult.status === "rejected" && isAbortRejection(semanticResult.reason)
        ? { status: "fulfilled", value: [] }
        : semanticResult

    if (containsResult.status === "rejected" && semanticEffective.status === "rejected") {
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
      logHybridBothFailure(containsResult.reason, semanticEffective.reason)
      throw containsResult.reason
    }

    const containsPages =
      containsResult.status === "fulfilled" ? containsResult.value.pages : []
    const containsCapped =
      containsResult.status === "fulfilled" ? containsResult.value.capped : false
    const semanticPages =
      semanticEffective.status === "fulfilled" ? semanticEffective.value : []

    if (containsResult.status === "rejected") {
      debugLogHybridBranchFailure("contains", containsResult.reason)
    }
    if (semanticEffective.status === "rejected") {
      debugLogHybridBranchFailure("semantic", semanticEffective.reason)
    }

    // Saturation cutoff: contains alone is the answer. Semantic ran in
    // parallel but its output is discarded — the trace must report
    // `semanticRank: null` for every row even when semantic returned the
    // same id, because surfacing that rank would imply influence on
    // ordering that did not happen.
    //
    // The cutoff predicate is shared with the abort-on-saturation
    // handler above via `shouldUseSaturationCutoff` so the two sites
    // cannot drift. The intent gate (`intent === null`) lives in the
    // helper; see its docstring for the intent-bypass rationale.
    if (shouldUseSaturationCutoff(intent, containsPages)) {
      const trace = new Map<string, HybridTraceEntry>()
      containsPages.forEach((page, rank) => {
        trace.set(page.id, {
          containsRank: rank,
          semanticRank: null,
          rrfScore: null,
          confidenceFactor: confidenceFactor(
            extractNumber(page.properties[MEMORY_PROPS.CONFIDENCE_SCORE]),
            this.features
          ),
        })
      })
      return {
        pages: containsPages,
        branch: "contains-saturated",
        trace,
        capped: containsCapped,
      }
    }

    // Under-saturation: RRF over both branches. Cross-branch agreement
    // is the signal the prior concat-then-fill heuristic threw away — a
    // row ranked #2 in both branches should beat a row ranked #1 in only
    // one. The deterministic tie-break in `tieBreakingRrfCompare` pins
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
      weight = 1
    ) => {
      branchPages.forEach((page, rank) => {
        const prev = scored.get(page.id)
        const factor =
          prev?.confidenceFactor ??
          confidenceFactor(
            extractNumber(page.properties[MEMORY_PROPS.CONFIDENCE_SCORE]),
            this.features
          )
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
    // intent-augmented semantic lane stays at 1. This matches qmd's
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
    return {
      pages: ranked.map((entry) => entry.page),
      branch: "rrf",
      trace,
      capped: containsCapped,
    }
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
    if (includeContent === false) {
      return Promise.all(pages.map((page) => this.pageToMemory(page, "")))
    }
    return Promise.all(
      pages.map(async (page) => {
        const md = await this.client.pages.retrieveMarkdown({ page_id: page.id })
        return await this.pageToMemory(page, md.markdown)
      })
    )
  }

  private async pageToMemory(
    page: PageObjectResponse,
    content?: string
  ): Promise<Memory> {
    return pageToMemory(await hydrateMemoryRelationProperties(this.client, page), content)
  }
}

/**
 * Convert a Notion page object to a `Memory` domain type. Pure function —
 * exported for unit testing. The hardened extractors guarantee graceful
 * defaults for pages that pre-date any schema addition: an unmigrated
 * page returns `kind: "note"`, `status: "informational"`, etc.
 */
export function pageToMemory(page: PageObjectResponse, content?: string): Memory {
  const props = page.properties
  const topicIds = extractRelationIds(props[MEMORY_PROPS.TOPIC])
  const session = extractRichText(props[MEMORY_PROPS.SESSION]).trim()

  // Read `Task State` only when the column exists *and* a select is set.
  // `extractSelect` falls back when the column is missing — fine for
  // unmigrated pages — but we want a true `null` (not `"open"`) on
  // every non-task memory so downstream code can branch on the field.
  const taskStateProp = props[MEMORY_PROPS.TASK_STATE]
  const taskState =
    taskStateProp && taskStateProp.type === "select" && taskStateProp.select
      ? (taskStateProp.select.name as TaskState)
      : null

  return {
    id: page.id,
    title: extractTitle(props[MEMORY_PROPS.TITLE]),
    projectIds: extractRelationIds(props[MEMORY_PROPS.PROJECT]),
    topicId: topicIds[0] ?? null,
    source: extractSelect(props[MEMORY_PROPS.SOURCE], "manual") as MemorySource,
    // Decision-related columns. Pre-migration pages default gracefully
    // via the hardened extractors — no backfill required.
    kind: extractSelect(props[MEMORY_PROPS.KIND], "note") as MemoryKind,
    status: extractSelect(props[MEMORY_PROPS.STATUS], "informational") as MemoryStatus,
    confidence: extractSelect(
      props[MEMORY_PROPS.CONFIDENCE],
      "certain"
    ) as MemoryConfidence,
    confidenceScore: extractNumber(props[MEMORY_PROPS.CONFIDENCE_SCORE]),
    reviewBy: extractDate(props[MEMORY_PROPS.REVIEW_BY]),
    doneAt: extractDate(props[MEMORY_PROPS.DONE_AT]),
    decidedAt: extractDate(props[MEMORY_PROPS.DECIDED_AT]),
    lastReferencedAt: extractDate(props[MEMORY_PROPS.LAST_REFERENCED_AT]),
    supersedesIds: extractRelationIds(props[MEMORY_PROPS.SUPERSEDES]),
    affectsIds: extractRelationIds(props[MEMORY_PROPS.AFFECTS]),
    alternatives: extractRichText(props[MEMORY_PROPS.ALTERNATIVES]),
    consequences: extractRichText(props[MEMORY_PROPS.CONSEQUENCES]),
    author: extractRichText(props[MEMORY_PROPS.AUTHOR]),
    agent: extractRichText(props[MEMORY_PROPS.AGENT]),
    tags: extractMultiSelect(props[MEMORY_PROPS.TAGS]),
    keywords: extractRichText(props[MEMORY_PROPS.KEYWORDS]),
    synopsis: extractRichText(props[MEMORY_PROPS.SYNOPSIS]),
    session: session.length > 0 ? session : null,
    content: content ?? "",
    createdAt: page.created_time,
    updatedAt: page.last_edited_time,
    taskState,
    blockedBy: extractRichText(props[MEMORY_PROPS.BLOCKED_BY]),
    entity: extractRichText(props[MEMORY_PROPS.ENTITY]),
    topicKey: extractRichText(props[MEMORY_PROPS.TOPIC_KEY]),
    // Legacy rows have a null `Revision Count` column. Coalesce
    // to 1 — every existing row has been "saved once," so
    // `formatMemoryListItem` treats the count as single-revision
    // and surfaces no `rev` line. Distinct from the Confidence Score
    // path (which preserves null to signal "never scored") because
    // Revision Count carries no "uninitialized" semantic — every row
    // has been written at least once by definition.
    revisionCount: extractNumber(props[MEMORY_PROPS.REVISION_COUNT]) ?? 1,
    comparedWith: extractRelationIds(props[MEMORY_PROPS.COMPARED_WITH]),
    compareNotes: extractRichText(props[MEMORY_PROPS.COMPARE_NOTES]),
    scope: extractMemoryScope(props),
    pinned: extractMemoryPinned(props),
  }
}

/**
 * Read the five scope columns into a `MemoryScope` bundle. Returns
 * `null` when all five columns are empty/missing. Vaults with the
 * scope schema migration applied but without backfilled scope still
 * pass through this branch; default retrieval treats null scope as
 * broadcast.
 *
 * Returns a populated `MemoryScope` with `kind: null` / `lifetime:
 * null` when only one column has been written (e.g. an operator set
 * `Lifetime` on a row but left `Scope Kind` empty) — same surface as
 * a row mid-scope-migration.
 */
function extractMemoryScope(
  props: PageObjectResponse["properties"]
): import("../types.js").MemoryScope | null {
  const kindProp = props[MEMORY_PROPS.SCOPE_KIND]
  const kind =
    kindProp && kindProp.type === "select" && kindProp.select
      ? (kindProp.select.name as import("../types.js").MemoryScopeKind)
      : null
  const key = extractRichText(props[MEMORY_PROPS.SCOPE_KEY])
  const audience = extractRichText(props[MEMORY_PROPS.AUDIENCE])
  const lifetimeProp = props[MEMORY_PROPS.LIFETIME]
  const lifetime =
    lifetimeProp && lifetimeProp.type === "select" && lifetimeProp.select
      ? (lifetimeProp.select.name as import("../types.js").MemoryLifetime)
      : null
  const expiresAt = extractDate(props[MEMORY_PROPS.EXPIRES_AT])
  if (
    kind === null &&
    lifetime === null &&
    expiresAt === null &&
    key.length === 0 &&
    audience.length === 0
  ) {
    return null
  }
  return { kind, key, audience, lifetime, expiresAt }
}

// ---------------------------------------------------------------------------
// Compare Notes — append-only NDJSON audit trail
// ---------------------------------------------------------------------------
//
// **Helper seam.** The compare-notes helper family — cap, append,
// encoder, types — is exported as a single import surface from this
// module so the compare-write path imports `COMPARE_NOTES_MAX_CHARS`,
// `appendCompareNote`, `encodeCompareNotesRichText`, and the
// `CompareNoteEntry` / `CompareNotesTextChunk` types from one location.
//
// Implementation lives where the layering wants it: the pure-NDJSON
// helpers (`appendCompareNote`, `CompareNoteEntry`) stay here because
// they have no Notion dependency, and the Notion-shape helpers
// (`encodeCompareNotesRichText`, `CompareNotesTextChunk`,
// `COMPARE_NOTES_MAX_CHARS`) live next to `buildMemoryProps` in the
// notion schema module. Re-exporting here keeps the seam at one
// location without duplicating the implementation.
//
// `COMPARE_NOTES_MAX_CHARS` is the chokepoint cap: both `appendCompareNote`
// (every grow-step) AND `encodeCompareNotesRichText` (every write to
// `Compare Notes`, including via `buildMemoryProps`) refuse over-cap
// input. There is no path that produces an over-cap rich_text payload.
//
// Read-side decoding goes through the shared `extractRichText` extractor
// — no per-property wrapper is needed.
export { COMPARE_NOTES_MAX_CHARS, encodeCompareNotesRichText }
export type { CompareNotesTextChunk }

export interface CompareNoteEntry {
  verdict: string
  target: string
  /**
   * The loser memory's id for asymmetric verdicts (`conflicts_with`,
   * `supersedes`); `null` for symmetric verdicts. Storing it on each
   * NDJSON line is what lets `hasMatchingCompareNote` distinguish a
   * direction-corrected re-judgment (`(A, B, conflicts_with,
   * affected=A)` after `(A, B, conflicts_with, affected=B)`) from a
   * true duplicate. Without this field, the same-pair-same-verdict
   * idempotency gate would suppress a corrected verdict — leaving the
   * incorrect previous direction authoritative and the newly-affected
   * memory undecremented.
   */
  affected: string | null
  reason: string
  judgedAt: string
  promptVersion: string
}

type CompareDispatchVerdict = "conflicts_with" | "supersedes"

export interface CompareDispatchLedgerEntry {
  entryType: "compare_dispatch"
  dispatchKey: string
  step: "confidence_decrement"
  verdict: CompareDispatchVerdict
  source: string
  affected: string
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
function appendCompareNotesEntry(existing: string, entry: unknown): string {
  const line = JSON.stringify(entry)
  const next = existing.length === 0 ? line : existing + "\n" + line
  if (next.length > COMPARE_NOTES_MAX_CHARS) {
    throw new Error(
      `Compare Notes overflow: appending this entry would push ` +
        `total length to ${next.length} chars (cap ` +
        `${COMPARE_NOTES_MAX_CHARS}). The memory is over-compared; ` +
        `consolidate via lore-memory action='archive' on duplicate ` +
        `pairs or split the topic.`
    )
  }
  return next
}

export function appendCompareNote(existing: string, entry: CompareNoteEntry): string {
  return appendCompareNotesEntry(existing, entry)
}

export function compareDispatchKey(input: {
  verdict: CompareDispatchVerdict
  sourceMemoryId: string
  affectedMemoryId: string
}): string {
  // Unit separator keeps the key unambiguous even if an id ever carries
  // punctuation that would collide with a human-readable delimiter.
  return [
    "compare-dispatch",
    input.verdict,
    input.sourceMemoryId,
    input.affectedMemoryId,
    "confidence_decrement",
  ].join("\u001f")
}

export function buildCompareDispatchLedgerEntry(input: {
  verdict: CompareDispatchVerdict
  sourceMemoryId: string
  affectedMemoryId: string
}): CompareDispatchLedgerEntry {
  return {
    entryType: "compare_dispatch",
    dispatchKey: compareDispatchKey(input),
    step: "confidence_decrement",
    verdict: input.verdict,
    source: input.sourceMemoryId,
    affected: input.affectedMemoryId,
  }
}

export function appendCompareDispatchLedgerEntry(
  existing: string,
  entry: CompareDispatchLedgerEntry
): string {
  return appendCompareNotesEntry(existing, entry)
}

// ---------------------------------------------------------------------------
// Compare-verdict dispatch helpers
// ---------------------------------------------------------------------------
//
// `lore-memory action='compare'` records an agent's verdict on a memory
// pair. Two of the six verdicts are *actionable* — they dispatch into
// the existing contradiction / supersession surfaces. The dispatch
// logic is split here so the MCP handler can call one async function
// per actionable verdict and the audit-marker write (`recordCompared`
// above) stays the single uniform tail.

/**
 * Pair-scoped idempotency check: does the memory's existing
 * `Compare Notes` NDJSON column already record an entry whose
 * `(target, verdict, affected?)` matches the incoming pair?
 *
 * The compare flow's idempotency must distinguish "this specific pair
 * was judged" from "a fact with this triple exists from somewhere" —
 * `FactService.createWithDedup` deduplicates globally on the triple
 * hash, so a fact existing from a different source memory (e.g., a
 * same-titled pair in a different project) would either suppress the
 * gate erroneously or fail to record "this specific pair has been
 * judged." Compare Notes is the authoritative pair-scoped signal.
 *
 * **Direction is part of the key for asymmetric verdicts.** Asymmetric
 * callers (`conflicts_with`, `supersedes`) MUST pass the loser's id as
 * `match.affected`; the entry's `affected` field must equal it. This
 * lets a corrected judgment with the flipped direction (same pair,
 * same verdict, opposite loser) bypass the gate and re-dispatch.
 * Symmetric callers (`scoped`, `related`, `compatible`, `not_conflict`)
 * pass `match.affected: null`; the entry's `affected` field must also
 * be `null` for the match to fire — which is automatic because the
 * write path stores `null` for symmetric entries.
 *
 * Returns `false` on any parse error — a malformed existing line MUST
 * NOT gate a fresh write. The cost of "miss the dedup" is one extra
 * audit-trail line; the cost of "suppress the dispatch" is a
 * silent-no-op verdict.
 */
export function hasMatchingCompareNote(
  notesNdjson: string,
  match: { target: string; verdict: string; affected: string | null }
): boolean {
  if (notesNdjson.length === 0) return false
  for (const line of notesNdjson.split("\n")) {
    if (line.trim().length === 0) continue
    try {
      const entry = JSON.parse(line) as {
        entryType?: string
        target?: string
        verdict?: string
        affected?: string | null
      }
      if (entry.entryType === "compare_dispatch") continue
      // `affected` may be missing on legacy entries written before
      // this PR (none yet exist in production but a future schema
      // migration could resurrect old payloads). Coalesce `undefined`
      // to `null` so a legacy symmetric entry matches a symmetric
      // lookup; legacy asymmetric entries are vanishingly rare and a
      // missed dedup costs only an extra audit line.
      const entryAffected = entry.affected ?? null
      if (
        entry.target === match.target &&
        entry.verdict === match.verdict &&
        entryAffected === match.affected
      ) {
        return true
      }
    } catch {
      // Skip malformed line; do not let it gate the write.
    }
  }
  return false
}

export function hasCompareDispatchLedgerEntry(
  notesNdjson: string,
  match: { dispatchKey: string; step: "confidence_decrement" }
): boolean {
  if (notesNdjson.length === 0) return false
  for (const line of notesNdjson.split("\n")) {
    if (line.trim().length === 0) continue
    try {
      const entry = JSON.parse(line) as {
        entryType?: string
        dispatchKey?: string
        step?: string
      }
      if (
        entry.entryType === "compare_dispatch" &&
        entry.dispatchKey === match.dispatchKey &&
        entry.step === match.step
      ) {
        return true
      }
    } catch {
      // Skip malformed lines; they cannot prove a decrement landed.
    }
  }
  return false
}

/**
 * Map a 0..1 self-reported judge confidence to a categorical
 * `FactConfidence` for the emitted contradiction / supersession fact.
 * Boundaries match the same ladder `confidenceFactor` and the
 * categorical `Confidence` select use elsewhere — `certain` at the
 * high end, `speculative` at the low. Undefined / null defaults to
 * `likely` (the middle bucket): the agent didn't volunteer a number,
 * so the fact lands as agent-reasoned-but-not-strongly-asserted.
 */
function factConfidenceFromJudge(
  score: number | undefined
): "certain" | "likely" | "speculative" {
  if (score === undefined) return "likely"
  if (score >= 0.85) return "certain"
  if (score >= 0.6) return "likely"
  return "speculative"
}

/**
 * Structural services bundle for the compare-dispatch helpers. Mirrors
 * `WakeUpServices` / `ReconcileServices` posture — accepts the real
 * `LoreServices` shape AND lightweight test stubs without dragging the
 * full bundle through. Only the methods the dispatch path actually
 * invokes are listed; adding a method to `MemoryService` /
 * `FactService` / `DecisionService` doesn't widen this surface.
 *
 * `decisions.supersede` is on the bundle so `recordSupersedence` can
 * route through the existing `lore-decision action='supersede'` code
 * path — updating the new decision's `Supersedes` relation and the
 * old decision's `Status` — rather than just decrementing confidence
 * and emitting a fact. Without this, a `verdict: 'supersedes'` compare
 * would NOT actually supersede anything in the decision graph.
 */
export interface CompareDispatchServices {
  memories: {
    decrementConfidence(
      memory: Pick<
        Memory,
        "id" | "confidence" | "confidenceScore" | "lastReferencedAt" | "createdAt"
      >,
      opts?: { today?: string; compareNotes?: string }
    ): Promise<number>
  }
  facts: {
    createWithDedup(input: {
      subject: string
      predicate:
        | "is_a"
        | "has_a"
        | "uses"
        | "depends_on"
        | "related_to"
        | "created_by"
        | "owned_by"
        | "replaces"
        | "extends"
        | "conflicts_with"
        | "decided_by"
        | "supersedes_decision"
        | "informs"
        | "mentions"
      object: string
      projectIds?: string[]
      sourceMemoryId?: string
      confidence?: "certain" | "likely" | "speculative"
      // Compare-dispatch helpers pass the
      // pair-scope when both compared rows share scope, or
      // `undefined` when the pair-scope rule rejects emission
      // (in which case the helper short-circuits before this
      // call). The structural type only requires the key to be
      // present so a future test stub doesn't have to track the
      // bundle exactly.
      scope?: import("../types.js").MemoryScopeInput
    }): Promise<{ fact: { id: string }; deduped: boolean }>
  }
  decisions: {
    supersede(newId: string, oldId: string): Promise<void>
  }
}

/**
 * Structured error surfaced when a compare-dispatch helper has landed
 * a non-idempotent destructive write but a follow-up step failed,
 * leaving the vault in a partial state. Carries diagnostic fields the
 * MCP handler interpolates into its tool-error message so the agent
 * can surface them to the operator.
 *
 * The `step` field names which call landed before the failure: `fact`
 * means the fact was emitted but the decrement failed (and for the
 * supersede path, the decision-supersede may have already run too);
 * `supersede` means `decisions.supersede` succeeded but the fact-
 * create failed. Distinguishing them matters for retry diagnostics —
 * the next safe step differs by what actually landed.
 */
export class CompareDispatchPartialFailureError extends LoreError<"compare-dispatch-partial"> {
  readonly step: "fact" | "supersede"
  readonly affectedMemoryId: string
  readonly factId: string | undefined
  readonly cause: unknown

  constructor(args: {
    message: string
    step: "fact" | "supersede"
    affectedMemoryId: string
    factId: string | undefined
    cause: unknown
  }) {
    super(
      "compare-dispatch-partial",
      args.message,
      {
        step: args.step,
        affectedMemoryId: args.affectedMemoryId,
        ...(args.factId === undefined ? {} : { factId: args.factId }),
        causeMessage: errorCauseMessage(args.cause),
      },
      { cause: args.cause }
    )
    this.name = "CompareDispatchPartialFailureError"
    this.step = args.step
    this.affectedMemoryId = args.affectedMemoryId
    this.factId = args.factId
    this.cause = args.cause
  }
}

/**
 * Dispatch helper for `verdict: 'conflicts_with'`. Emits the
 * `conflicts_with` fact, then halves the contradicted (loser)
 * memory's `Confidence Score` with an idempotency marker written in
 * the same Notion update as the score. Order matters for retry safety:
 *
 * - `createWithDedup` is idempotent on the triple hash — a retry that
 * races with a successful first call no-ops at the dedup probe.
 * - `decrementConfidence` is non-idempotent without a marker, so the
 * affected memory's `Compare Notes` gets a `compare_dispatch` ledger
 * line in the same `pages.update` as the score write. If the SDK call
 * fails after Notion applied the update, the retry sees the marker and
 * skips the second decrement; if the update never landed, the marker
 * is absent and the retry applies the decrement once.
 *
 * The fact's `subject = source memory's title`, `object = contradicted
 * memory's title` — `lore-query action='ask'` retrieves it via the
 * subject substring fallback even on un-migrated vaults that lack the
 * Entities relation column.
 *
 * Confidence is mapped from the optional `judgeConfidence` (0..1) to
 * a categorical via `factConfidenceFromJudge`. Auto-emitted system
 * facts default to `speculative` (matching the `mentions` posture); a
 * compare verdict is genuinely agent-reasoned, so the categorical
 * follows the agent's stance rather than a fixed floor.
 *
 * Prompt-version provenance survives via the Compare Notes audit
 * trail (`recordCompared`'s NDJSON entries carry `promptVersion`),
 * NOT via the fact body — the Facts schema has no body column today,
 * and adding one would require its own schema migration.
 *
 * The pair-scoped final-audit gate runs upstream in the MCP handler;
 * this helper owns only the destructive dispatch idempotency.
 */
export async function recordContradiction(
  services: CompareDispatchServices,
  input: {
    contradictedMemory: Pick<
      Memory,
      | "id"
      | "title"
      | "projectIds"
      | "confidence"
      | "confidenceScore"
      | "lastReferencedAt"
      | "createdAt"
    > &
      // `scope` is needed for the pair-scope
      // emission decision. Optional so legacy callers that
      // pre-date the scope columns still typecheck (their scope is
      // undefined, which `pairScopeForFactEmission` treats as
      // broadcast).
      Partial<Pick<Memory, "compareNotes" | "scope">>
    sourceMemory: Pick<Memory, "id" | "title" | "projectIds"> &
      Partial<Pick<Memory, "scope">>
    judgeConfidence: number | undefined
  }
): Promise<{
  /**
   * The id of the emitted `conflicts_with` fact. `null` when the
   * pair-scope rule rejected emission: the
   * compare verdict still landed in Compare Notes on both sides
   * (audit trail intact), but no broadcast-able fact was created
   * because the two memories carry mismatched scopes and emitting
   * the fact under either scope would leak the narrower row's
   * title across the broader reader context.
   */
  factId: string | null
  affectedCompareNotes: string
  decremented: boolean
  /** Populated when the fact was skipped; explains why for operator-
   * facing output / debug logs. */
  factEmissionSkippedReason?: string
}> {
  const ledgerEntry = buildCompareDispatchLedgerEntry({
    verdict: "conflicts_with",
    sourceMemoryId: input.sourceMemory.id,
    affectedMemoryId: input.contradictedMemory.id,
  })
  const currentCompareNotes = input.contradictedMemory.compareNotes ?? ""
  const alreadyDecremented = hasCompareDispatchLedgerEntry(currentCompareNotes, {
    dispatchKey: ledgerEntry.dispatchKey,
    step: "confidence_decrement",
  })
  const affectedCompareNotes = alreadyDecremented
    ? currentCompareNotes
    : appendCompareDispatchLedgerEntry(currentCompareNotes, ledgerEntry)

  const sharedProjects = intersectProjects(
    input.sourceMemory.projectIds,
    input.contradictedMemory.projectIds
  )

  // Pair-scope rule. The `conflicts_with`
  // fact references both memories' titles; emitting it under
  // either side's scope when the two scopes differ leaks the
  // narrower row across the broader reader context. Skip the
  // fact emission on mismatch — the compare verdict still lands
  // in Compare Notes on both rows below (audit trail), and the
  // confidence decrement still fires (the contradiction is real
  // even if the broadcast-able fact would leak).
  const pairScope = pairScopeForFactEmission(
    input.sourceMemory.scope,
    input.contradictedMemory.scope
  )

  // Step 1: emit the fact when the pair-scope rule allows it.
  // `createWithDedup` is idempotent on the triple hash + scope, so
  // a retry that races against a partial-success on step 2
  // collapses to a no-op merge rather than a duplicate row.
  let factId: string | null = null
  if (pairScope.ok) {
    const result = await services.facts.createWithDedup({
      subject: input.sourceMemory.title,
      predicate: "conflicts_with",
      object: input.contradictedMemory.title,
      projectIds: sharedProjects.length > 0 ? sharedProjects : undefined,
      sourceMemoryId: input.sourceMemory.id,
      confidence: factConfidenceFromJudge(input.judgeConfidence),
      scope: pairScope.scope,
    })
    factId = result.fact.id
  }

  if (!alreadyDecremented) {
    // Step 2: halve the loser's Confidence Score. The Compare Notes
    // ledger line is written in the same `pages.update`; that marker is
    // the retry-side proof that the decrement already landed.
    try {
      await services.memories.decrementConfidence(input.contradictedMemory, {
        compareNotes: affectedCompareNotes,
      })
    } catch (err) {
      throw new CompareDispatchPartialFailureError({
        // Diagnostic fields are interpolated INTO the message string so
        // they survive the MCP boundary — `toolError` forwards
        // `.message` only, dropping typed `readonly` props.
        // Field names match the corresponding properties on the error
        // class so an operator triaging logs can grep either source.
        message:
          "conflicts_with dispatch: fact emitted but decrementConfidence " +
          "failed (inconsistentState: true). Retry the same " +
          "lore-memory action='compare' after the transient failure is " +
          "cleared; if the confidence update landed, the compare_dispatch " +
          "ledger marker on the affected memory will prevent a second " +
          "decrement. Diagnostic fields:\n" +
          `step=fact\n` +
          `affectedMemoryId=${input.contradictedMemory.id}\n` +
          `factId=${factId ?? "(pair-scope-skipped)"}\n` +
          `dispatchKey=${ledgerEntry.dispatchKey}`,
        step: "fact",
        affectedMemoryId: input.contradictedMemory.id,
        factId: factId ?? "(pair-scope-skipped)",
        cause: err,
      })
    }
  }
  return {
    factId,
    affectedCompareNotes,
    decremented: !alreadyDecremented,
    ...(pairScope.ok ? {} : { factEmissionSkippedReason: pairScope.reason }),
  }
}

/**
 * Dispatch helper for `verdict: 'supersedes'`. Routes through the
 * existing `lore-decision action='supersede'` semantics — updates the
 * new decision's `Supersedes` relation, flips the old decision's
 * `Status` to `superseded`, emits the `supersedes_decision` fact, and
 * halves the superseded memory's `Confidence Score` with the same
 * compare-dispatch ledger used by `recordContradiction`. Caller has
 * already gated on `superseded.kind === 'decision'`.
 * * Order matches `recordContradiction` for retry safety:
 *
 * 1. `decisions.supersede` — atomic-by-ordering inside `DecisionService`
 * (writes `Supersedes` first, `Status` second). Failure here leaves
 * the system in a "new points at old; old still accepted" state per
 * `DecisionService.supersede`'s docstring; safe to retry. Retries
 * still pay this round-trip because gating on loaded `Status` would
 * drop the repair path where the relation landed but later steps did
 * not. Concurrent `recordSupersedence` calls against the same
 * `supersedingMemory.id` are serialized by `withEntityRelationLocks`
 * inside `DecisionService.supersede`, so two parallel
 * compare-dispatch fan-outs do not race on the `Supersedes`
 * relation.
 * 2. `createWithDedup` — idempotent on the triple hash. If this fails
 * after step 1 landed, the helper raises a
 * `CompareDispatchPartialFailureError(step: "supersede")`.
 * 3. `decrementConfidence` — protected by the affected memory's
 * `compare_dispatch` ledger marker. If this fails after steps 1-2
 * landed, retrying the same compare either applies the decrement
 * once or observes the marker and skips it.
 *
 * Direction is encoded by the `superseding` / `superseded` parameter
 * names — NOT by positional order — so a flipped scan order can't
 * silently halve the wrong memory. The MCP handler resolves
 * `affectedMemoryId` to the `superseded` (loser) shape before calling.
 */
export async function recordSupersedence(
  services: CompareDispatchServices,
  input: {
    supersedingMemory: Pick<Memory, "id" | "title" | "projectIds" | "confidence"> &
      // Scope needed for pair-scope decision.
      Partial<Pick<Memory, "scope">>
    supersededMemory: Pick<
      Memory,
      | "id"
      | "title"
      | "projectIds"
      | "confidence"
      | "confidenceScore"
      | "lastReferencedAt"
      | "createdAt"
    > &
      Partial<Pick<Memory, "compareNotes" | "scope">>
    judgeConfidence: number | undefined
  }
): Promise<{
  /**
   * The id of the emitted `supersedes_decision` fact. `null` when
   * the pair-scope rule rejected emission:
   * `decisions.supersede` still landed (Status flip + relation
   * write), the compare verdict still landed in Compare Notes,
   * and the loser's confidence was still decremented — but the
   * broadcast-able `supersedes_decision` fact was skipped to
   * avoid leaking the narrower-scope decision's title across the
   * broader reader context.
   */
  factId: string | null
  affectedCompareNotes: string
  decremented: boolean
  /** See `recordContradiction`'s field. */
  factEmissionSkippedReason?: string
}> {
  const ledgerEntry = buildCompareDispatchLedgerEntry({
    verdict: "supersedes",
    sourceMemoryId: input.supersedingMemory.id,
    affectedMemoryId: input.supersededMemory.id,
  })
  const currentCompareNotes = input.supersededMemory.compareNotes ?? ""
  const alreadyDecremented = hasCompareDispatchLedgerEntry(currentCompareNotes, {
    dispatchKey: ledgerEntry.dispatchKey,
    step: "confidence_decrement",
  })
  const affectedCompareNotes = alreadyDecremented
    ? currentCompareNotes
    : appendCompareDispatchLedgerEntry(currentCompareNotes, ledgerEntry)

  // Step 1: update the decision graph (Supersedes relation + Status).
  // Without this the response saying "marked superseded" would be
  // false; the new decision's Supersedes relation would never be set
  // and the old decision's Status would stay at "accepted."
  await services.decisions.supersede(
    input.supersedingMemory.id,
    input.supersededMemory.id
  )

  const sharedProjects = intersectProjects(
    input.supersedingMemory.projectIds,
    input.supersededMemory.projectIds
  )

  // Pair-scope rule. Same logic as
  // `recordContradiction`: skip the fact emission when the two
  // decisions carry mismatched scopes. `decisions.supersede`
  // already landed above (Status flip + relation write), so the
  // graph edge inside the Memories DB is correct; the broadcast-
  // able `supersedes_decision` fact in the Facts DB is the leak
  // vector and gets dropped on mismatch. The compare verdict still
  // lands in Compare Notes, and the loser's confidence still gets
  // decremented (the supersession is real even if the fact would
  // leak).
  const pairScope = pairScopeForFactEmission(
    input.supersedingMemory.scope,
    input.supersededMemory.scope
  )

  // Step 2: emit the fact when the pair-scope rule allows it.
  // Subject = superseding memory's id (matches the existing
  // `lore-decision action='supersede'` shape, since this helper
  // now drives the same code path).
  let factId: string | null = null
  if (pairScope.ok) {
    try {
      const result = await services.facts.createWithDedup({
        subject: input.supersedingMemory.id,
        predicate: "supersedes_decision",
        object: input.supersededMemory.id,
        projectIds: sharedProjects.length > 0 ? sharedProjects : undefined,
        sourceMemoryId: input.supersedingMemory.id,
        confidence: factConfidenceFromJudge(input.judgeConfidence),
        scope: pairScope.scope,
      })
      factId = result.fact.id
    } catch (err) {
      throw new CompareDispatchPartialFailureError({
        // Diagnostic fields interpolated INTO the message — same
        // `toolError`-survives-message-only contract as the
        // conflicts_with throw above. `factId` is `(none)` here
        // because the fact create is exactly the step that failed.
        // `supersedingMemoryId` is named because the retry/recovery
        // action needs the subject side too.
        message:
          "supersedes dispatch: decisions.supersede landed (Supersedes " +
          "relation + Status updated) but the supersedes_decision fact " +
          "create failed (inconsistentState: true). The graph edge is " +
          "missing; lore-query action='ask' won't surface the " +
          "supersession on the affected entity yet. Retry the same " +
          "lore-memory action='compare' after the transient failure is " +
          "cleared; decisions.supersede is idempotent on relation-set " +
          "semantics, so the retry can complete the fact and confidence " +
          "work safely. Diagnostic fields:\n" +
          `step=supersede\n` +
          `affectedMemoryId=${input.supersededMemory.id}\n` +
          `supersedingMemoryId=${input.supersedingMemory.id}\n` +
          `factId=(none)`,
        step: "supersede",
        affectedMemoryId: input.supersededMemory.id,
        factId: undefined,
        cause: err,
      })
    }
  }

  if (!alreadyDecremented) {
    // Step 3: halve the superseded memory's Confidence Score. The
    // Compare Notes ledger line is written atomically with the score.
    try {
      await services.memories.decrementConfidence(input.supersededMemory, {
        compareNotes: affectedCompareNotes,
      })
    } catch (err) {
      throw new CompareDispatchPartialFailureError({
        message:
          "supersedes dispatch: decisions.supersede and the " +
          "supersedes_decision fact landed, but decrementConfidence on " +
          "the superseded memory failed (inconsistentState: true). Retry " +
          "the same lore-memory action='compare' after the transient " +
          "failure is cleared; if the confidence update landed, the " +
          "compare_dispatch ledger marker on the affected memory will " +
          "prevent a second decrement. Diagnostic fields:\n" +
          `step=fact\n` +
          `affectedMemoryId=${input.supersededMemory.id}\n` +
          `factId=${factId ?? "(pair-scope-skipped)"}\n` +
          `dispatchKey=${ledgerEntry.dispatchKey}`,
        step: "fact",
        affectedMemoryId: input.supersededMemory.id,
        factId: factId ?? "(pair-scope-skipped)",
        cause: err,
      })
    }
  }
  return {
    factId,
    affectedCompareNotes,
    decremented: !alreadyDecremented,
    ...(pairScope.ok ? {} : { factEmissionSkippedReason: pairScope.reason }),
  }
}

/**
 * Set-intersection of two project-id arrays. Order follows the first
 * argument so the returned `projectIds` is deterministic across calls
 * with stable inputs. A pair sharing no projects returns `[]`; the
 * MCP handler's cross-project guard catches that case before reaching
 * the dispatch helpers, so an empty intersection here means the guard
 * was bypassed (e.g., a future test that calls a helper directly).
 */
function intersectProjects(a: string[], b: string[]): string[] {
  if (a.length === 0 || b.length === 0) return []
  const setB = new Set(b)
  return a.filter((id) => setB.has(id))
}
