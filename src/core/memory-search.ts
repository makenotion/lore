/**
 * Memory search pipeline behind the MemoryService facade.
 */

import type {
  Client,
  PageObjectResponse,
  QueryDataSourceParameters,
} from "@notionhq/client"
import { APIErrorCode, isNotionClientError } from "@notionhq/client"
import type {
  DatabaseRef,
  Memory,
  MemoryScopeContext,
  SearchExplain,
  SearchMemoriesInput,
  SearchMode,
} from "../types.js"
import type { LoreFeatureFlags } from "../feature-flags.js"
import { MEMORY_PROPS } from "../notion/schema.js"
import { projectOrUnscopedFilter, withDefaultScopeFilter } from "../notion/filters.js"
import { extractMissingPropertyName } from "../notion/errors.js"
import {
  RunToolSearchRestrictedError,
  RUNTOOL_SEARCH_MAX_PAGE_SIZE,
  searchViaRunTool,
} from "../notion/runtool/index.js"
import { MEMORY_CLEANUP_ORPHAN_SENTINEL } from "./near-duplicate.js"
import { redactDebugMessage } from "../debug-redact.js"
import { confidenceFactor, effectiveConfidenceFactor } from "./decay.js"
import { todayUtc } from "./task.js"
import {
  extractMultiSelect,
  extractCheckbox,
  extractNumber,
  extractRelationIds,
  extractRichText,
  extractSelect,
  isFullPage,
  extractDate,
} from "../notion/extractors.js"
import { collectLivePages, warnLivePageCapFired } from "../notion/live-pages.js"
import { hydrateRelationPropertiesForPages } from "../notion/relation-properties.js"
import { matchesDefaultScope } from "./memory-scope.js"
import {
  isNotRetiredRecallSource,
  retiredRecallSourceExclusionFilters,
  withCleanupOrphanExclusion,
} from "./memory-filters.js"
import {
  isNotReviewTerminalStatus,
  reviewTerminalStatusExclusionFilters,
} from "./memory-review-state.js"

type MaterializeMemories = (
  pages: PageObjectResponse[],
  includeContent: boolean | undefined
) => Promise<Memory[]>

/**
 * Minimum contains-mode hit count that satisfies a hybrid query without
 * firing the explicit semantic branch. Three is chosen empirically
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
 * Legacy semantic page-walk cap. Kept as an export for compatibility
 * with tests and docs that still import it while semantic search is
 * served by the RunTool AI-search window.
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
 * surface it) plus the running fused score. Captured outside the merge
 * loop so the deterministic tie-break in `tieBreakingRrfCompare` and
 * the explain trace both read off the same authoritative state.
 *
 * Confidence fields are diagnostic only. They are exposed in explain
 * traces so operators can inspect stale or low-trust rows, but they do
 * not affect retrieval order.
 */
export type RrfEntry = {
  page: PageObjectResponse
  score: number
  containsRank: number | null
  semanticRank: number | null
  confidenceFactor: number
  storedConfidenceFactor?: number
  effectiveConfidenceFactor?: number
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
  storedConfidenceFactor: number
  effectiveConfidenceFactor: number
}

export type SearchPagesResult = {
  pages: PageObjectResponse[]
  capped: boolean
}

export class SemanticSearchUnavailableError extends Error {
  constructor(reason: string, cause?: unknown) {
    super(
      `AI semantic search unavailable: ${reason}`,
      cause === undefined ? undefined : { cause }
    )
    this.name = "SemanticSearchUnavailableError"
  }
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

type ConfidenceTrace = {
  confidenceFactor: number
  storedConfidenceFactor: number
  effectiveConfidenceFactor: number
}

function confidenceTraceForPage(
  page: PageObjectResponse,
  today: string,
  features: LoreFeatureFlags
): ConfidenceTrace {
  const storedScore = extractNumber(page.properties[MEMORY_PROPS.CONFIDENCE_SCORE])
  const storedFactor = confidenceFactor(storedScore, features)
  const effectiveFactor = effectiveConfidenceFactor(
    storedScore,
    extractDate(page.properties[MEMORY_PROPS.LAST_REFERENCED_AT]),
    today,
    features
  )
  return {
    confidenceFactor: effectiveFactor,
    storedConfidenceFactor: storedFactor,
    effectiveConfidenceFactor: effectiveFactor,
  }
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
 * `dataSources.query` (contains lane) and RunTool AI search (semantic
 * lane), which are the paths most likely to interpolate
 * request-scoped detail and the
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
 * The format intentionally diverges from the shared partial-failure logger:
 * a hybrid branch isn't a Notion root id, and `tool=hybrid-search` would be
 * misleading because hybrid search is a core service path, not an MCP tool.
 * The shared contract is the
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

export class MemorySearch {
  constructor(
    private client: Client,
    private db: DatabaseRef,
    private features: LoreFeatureFlags,
    private getScopeContext: () => MemoryScopeContext,
    private isScopeFilterEnabled: () => boolean,
    private materializeMemories: MaterializeMemories
  ) {}

  private get scopeCtx(): MemoryScopeContext {
    return this.getScopeContext()
  }

  private get scopeFilterEnabled(): boolean {
    return this.isScopeFilterEnabled()
  }

  /**
   * Search memories. Three execution modes (see the `SearchMode` type):
   *
   * - `"contains"` — DS-scoped `dataSources.query` with Title/Keywords
   * `contains` filters and server-side property filters
   * (`projectId` / `topicId` / `tags` / `kind` / `status`). No workspace
   * leakage, no vector ranking — best for substring/exact-phrase queries.
   * - `"semantic"` (default) — Notion AI search via RunTool, ranked by
   * Notion's relevance engine over titles and bodies. Property filters
   * apply after hydrating the AI-ranked window.
   * - `"hybrid"` — fire contains and semantic in parallel; if
   * contains saturates (`>= HYBRID_FALLBACK_THRESHOLD` hits), use the
   * contains rows alone and discard the parallel semantic result.
   * Otherwise merge the two ranked lists via Reciprocal Rank Fusion
   * (RRF) with a deterministic tie-break (encoded in
   * `searchByHybridPages`). Speculative parallelism keeps wall-clock
   * at one round-trip
   * (≈ AI search latency) regardless of which leg saturates —
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
   * caller's mode and forces every search through Notion AI search.
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
  async runSearch(
    input: SearchMemoriesInput
  ): Promise<{ memories: Memory[]; explain: SearchExplain[]; capped: boolean }> {
    const requested: SearchMode = input.mode ?? "semantic"
    const mode: SearchMode = this.features.forceSemanticSearch ? "semantic" : requested
    const limit = input.limit ?? 10
    const rankingToday = todayUtc()

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
      const hybrid = await this.searchByHybridPages(input, limit, intent, rankingToday)
      pages = hybrid.pages
      explainBranch = hybrid.branch
      hybridTrace = hybrid.trace
      capped = hybrid.capped
    }

    const selectedPages = pages.slice(0, limit)
    const memories = await this.materializeMemories(selectedPages, input.includeContent)
    const explain = selectedPages.map((page, i): SearchExplain => {
      const factors = confidenceTraceForPage(page, rankingToday, this.features)
      if (explainBranch === "contains-only") {
        return {
          memoryId: page.id,
          containsRank: i,
          semanticRank: null,
          rrfScore: null,
          branch: "contains-only",
          ...factors,
        }
      }
      if (explainBranch === "semantic-only") {
        return {
          memoryId: page.id,
          containsRank: null,
          semanticRank: i,
          rrfScore: null,
          branch: "semantic-only",
          ...factors,
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
        // and the saturation cutoff path. The fall-through handles a
        // hypothetical missing-trace path; in current code it is unreachable.
        confidenceFactor: trace?.confidenceFactor ?? factors.confidenceFactor,
        storedConfidenceFactor:
          trace?.storedConfidenceFactor ?? factors.storedConfidenceFactor,
        effectiveConfidenceFactor:
          trace?.effectiveConfidenceFactor ?? factors.effectiveConfidenceFactor,
      }
    })
    return { memories, explain, capped }
  }

  /**
   * DS-scoped query path. Runs against the Memories data source only
   * and returns Notion's recency ordering verbatim.
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
  async fetchContainsPages(input: SearchMemoriesInput): Promise<SearchPagesResult> {
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
    filters.push(...retiredRecallSourceExclusionFilters())
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
    const filtersWithoutPinned = [...filters]
    if (input.excludePinned === true) {
      filters.push({
        property: MEMORY_PROPS.PINNED,
        checkbox: { does_not_equal: true },
      })
    }

    // No filters AND empty query → `filter: undefined` returns every row in
    // the DS sorted by recency, capped at `limit`. Intentional, not a
    // degenerate-input bug: callers passing only `mode: "contains"` with
    // no scope and no query get the equivalent of `lore-query action='recall'` minus
    // cursor pagination. A future reader: do not add a guard here.
    const toBaseFilter = (
      activeFilters: Array<Record<string, unknown>>
    ): Record<string, unknown> | undefined =>
      activeFilters.length > 1
        ? { and: activeFilters }
        : activeFilters.length === 1
          ? activeFilters[0]
          : undefined
    const buildFilter = (
      activeFilters: Array<Record<string, unknown>>
    ): QueryDataSourceParameters["filter"] => {
      const baseFilter = toBaseFilter(activeFilters)
      const scopedFilter =
        input.includeOutOfScope === true || !this.scopeFilterEnabled
          ? baseFilter
          : withDefaultScopeFilter(baseFilter, this.scopeCtx, todayUtc(), undefined, {
              includeExpired: input.includeExpired === true,
            })
      return withCleanupOrphanExclusion(
        scopedFilter
      ) as QueryDataSourceParameters["filter"]
    }

    // Resurfaced cleanup-orphan exclusion. Pushed
    // server-side so a restored-from-trash orphan does not consume a
    // contains-lane slot and silently saturate the
    // `HYBRID_FALLBACK_THRESHOLD` cutoff, masking real semantic hits.
    //
    // Default scope filter. Same posture as `list` —
    // narrow-scope rows whose `scopeKey` doesn't match the reader's
    // identity slot drop out of the contains lane by default.
    const filter = buildFilter(filters)
    const fallbackFilter =
      input.excludePinned === true ? buildFilter(filtersWithoutPinned) : null

    if (limit <= 0) return { pages: [], capped: false }

    // Kind+key binding runs client-side here too: Notion's 2-deep
    // compound-filter limit makes server-side narrow binding
    // structurally impossible; the walker backfills via `extraFilter`.
    const containsToday = todayUtc()
    const containsExtraFilter =
      input.includeOutOfScope === true || !this.scopeFilterEnabled
        ? undefined
        : (page: PageObjectResponse) =>
            matchesDefaultScope(
              page.properties,
              this.scopeCtx,
              containsToday,
              undefined,
              {
                includeExpired: input.includeExpired === true,
              }
            )

    const collectWithFilter = (activeFilter: QueryDataSourceParameters["filter"]) =>
      collectLivePages({
        limit,
        source: "MemoryService.fetchContainsPages",
        query: ({ page_size, start_cursor }) =>
          this.client.dataSources.query({
            data_source_id: this.db.dataSourceId,
            filter: activeFilter,
            // No relevance ranking is available on `dataSources.query`; sort by
            // recency so the latest-edited matches surface first.
            sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
            page_size,
            start_cursor,
          }),
        extraFilter: containsExtraFilter,
      })
    let result: Awaited<ReturnType<typeof collectLivePages>>
    try {
      result = await collectWithFilter(filter)
    } catch (err) {
      if (
        fallbackFilter === null ||
        extractMissingPropertyName(err) !== MEMORY_PROPS.PINNED
      ) {
        throw err
      }
      result = await collectWithFilter(fallbackFilter)
    }
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
   * Semantic relevance search is Notion AI search through RunTool.
   * The returned rows keep the server's relevance order; confidence
   * scores and REST keyword search do not participate in this path.
   */
  async fetchSemanticPages(
    input: SearchMemoriesInput,
    intent: string | null,
    signal?: AbortSignal
  ): Promise<SearchPagesResult> {
    const composedQuery =
      intent !== null
        ? [input.query.trim(), intent].filter(Boolean).join(" ")
        : input.query
    if (signal?.aborted) {
      throw buildAbortError(signal)
    }

    if (composedQuery.trim().length === 0) {
      throw new SemanticSearchUnavailableError(
        'query must contain at least one non-whitespace character; use mode "contains" for filtered listings'
      )
    }
    if (!this.features.runTool.search) {
      throw new SemanticSearchUnavailableError(
        "RunTool search is disabled; enable LORE_USE_RUNTOOL_SEARCH or LORE_USE_RUNTOOL"
      )
    }

    return this.fetchSemanticPagesViaRunTool(
      input,
      composedQuery,
      input.limit ?? 10,
      signal
    )
  }

  /**
   * RunTool `search` consumer for the semantic lane.
   *
   * Returns full `PageObjectResponse[]` shapes plus cap metadata for
   * the top RunTool AI-search window. Semantic search has no REST
   * keyword fallback: capability failures and non-AI search responses
   * throw `SemanticSearchUnavailableError` so callers can surface the
   * missing semantic engine distinctly from an empty result set.
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
   * **Saturation handling.** A full 25-hit window is still returned
   * and marked `capped`. There is no REST keyword fallback because
   * semantic relevance is defined by the AI-ranked window.
   *
   * **Error classification.** 403 `RestrictedResource`, non-AI search
   * modes, and disabled RunTool search surface as
   * `SemanticSearchUnavailableError`. Other SDK errors propagate through
   * the shared rate-limit and auth-refresh layers.
   */
  async fetchSemanticPagesViaRunTool(
    input: SearchMemoriesInput,
    composedQuery: string,
    limit: number,
    signal?: AbortSignal
  ): Promise<SearchPagesResult> {
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
        // the raw window minimizes post-filter under-recall for typical
        // small-`limit` callers without changing the final shape of the
        // result.
      })
    } catch (err) {
      if (err instanceof RunToolSearchRestrictedError) {
        throw new SemanticSearchUnavailableError(
          "Notion rejected RunTool search with RestrictedResource; use ntn or a Notion personal access token with access to AI search",
          err
        )
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

    if (outcome.searchType !== "ai_search") {
      throw new SemanticSearchUnavailableError(
        `RunTool search returned ${outcome.searchType}; AI search is required`
      )
    }

    const capped = outcome.saturated || limit > RUNTOOL_SEARCH_MAX_PAGE_SIZE

    if (outcome.hits.length === 0) {
      return { pages: [], capped }
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
    // trip because RunTool returns compact search resources rather
    // than full `PageObjectResponse[]` rows. Worst case is 25
    // retrieves paced by the global outbound rate-limit bucket (or
    // by the `pages.retrieve` endpoint override if one is configured).
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
    return { pages: filtered, capped }
  }

  /**
   * Apply the parent-DB filter and caller-provided property post-filters
   * to hydrated AI-search pages. Kept as a distinct helper so the
   * semantic lane uses the same narrowing rules as other memory
   * retrieval paths.
   *
   * Excludes archived rows. AI search can return archived pages
   * alongside live ones, and the semantic contract is the filtered
   * top AI-ranked window. Mirror the client-side filter every other
   * paginating walker applies (`findByTopicKey`, `listAllForBackfill`,
   * `listForScan`, `fetchContainsPages`).
   *
   * **Cooperative cancellation.** The optional `signal`
   * parameter is checked before the synchronous parent-DB filter AND
   * before `hydrateRelationPropertiesForPages` — the latter is the
   * dominant residual cost on a large semantic window because
   * hydration paginates relation-property fetches per surviving page.
   * Skipping the hydration when the signal is already aborted bounds
   * residual work at "the in-flight AI-search response landed" rather
   * than "headers AND every relation-hydration round-trip the page
   * implies." On abort we throw an `AbortError`-shaped value that
   * propagates back through `fetchSemanticPages`'s `await` —
   * `searchByHybridPages` then maps it to fulfilled-empty via
   * `isAbortRejection`, identical to the pre-call/post-page check
   * paths in `fetchSemanticPages` itself.
   */
  async applySemanticPostFilters(
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
    // Also drop resurfaced cleanup-orphans. AI search does not apply
    // Lore's memory-property filters, so the server-side `Keywords
    // does_not_contain` clause that DS-scoped walkers use must run
    // client-side on the hydrated page properties. Same posture as the
    // archived and parent-DB filters above.
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
      if (!isNotRetiredRecallSource(page)) return false
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
      // `rejected`) from semantic search. AI search does not apply
      // Lore's status filters, so the exclusion runs as a
      // client-side post-filter — same
      // posture as the kind / status exact-match filters above.
      // Explicit `input.status` short-circuits this branch.
      filtered = filtered.filter(isNotReviewTerminalStatus)
    }
    if (input.excludePinned === true) {
      filtered = filtered.filter(
        (page) => !extractCheckbox(page.properties[MEMORY_PROPS.PINNED])
      )
    }

    // Default scope filter. Same posture as the
    // contains lane's server-side scope filter. AI search does not
    // apply Lore's scope filters, so the exclusion runs client-side.
    // `includeOutOfScope: true` opts out for audit paths; the filter
    // also no-ops when `scopeFilterEnabled` is false (tests
    // constructing the service without a scope context).
    if (input.includeOutOfScope !== true && this.scopeFilterEnabled) {
      const today = todayUtc()
      filtered = filtered.filter((page) =>
        matchesDefaultScope(page.properties, this.scopeCtx, today, undefined, {
          includeExpired: input.includeExpired === true,
        })
      )
    }

    return filtered
  }

  /**
   * Public DS-scoped contains path. Contains is explicit lexical lookup
   * over memory properties; it preserves the recency order returned by
   * `dataSources.query`. Confidence is not a retrieval quality signal.
   */
  async searchByContainsPages(input: SearchMemoriesInput): Promise<SearchPagesResult> {
    return this.fetchContainsPages(input)
  }

  /**
   * Public semantic path. The AI-ranked order is returned unchanged.
   */
  async searchBySemanticPages(
    input: SearchMemoriesInput,
    intent: string | null
  ): Promise<SearchPagesResult> {
    return this.fetchSemanticPages(input, intent)
  }

  /**
   * Hybrid path: speculative parallelism. Fires the contains and semantic
   * queries concurrently via `Promise.allSettled` so the worst-case
   * wall-clock stays at one round-trip (≈ AI search latency)
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
   * would propagate any rejection (a transient 429 from AI search,
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
   * `fetchSemanticPages`, which checks the signal before dispatch and
   * during hydration. The discarded-result rejection arrives as
   * an `AbortError`-shaped value which `isAbortRejection` filters
   * out of the partial-failure log path AND the both-failure
   * detector — a cooperative abort is not a real branch failure and
   * must not pollute `LORE_DEBUG=1` stderr or trip the both-down
   * outage path.
   *
   * **Empty-query note.** With no text filter, the contains leg returns a
   * recency listing under property filters; the semantic leg fails loud
   * because AI search requires a non-empty query. Callers wanting
   * list-like semantics should pass `mode: "contains"` explicitly.
   */
  async searchByHybridPages(
    input: SearchMemoriesInput,
    limit: number,
    intent: string | null,
    today: string = todayUtc()
  ): Promise<{
    pages: PageObjectResponse[]
    branch: "contains-saturated" | "rrf"
    trace: Map<string, HybridTraceEntry>
    capped: boolean
  }> {
    // The controller drives the saturation-triggered cancellation of
    // the in-flight semantic branch. Both
    // branches still dispatch in parallel — abort is a side-effect of
    // contains LANDING with a saturating result, not a precondition of
    // semantic dispatching. The signal flows into `fetchSemanticPages`.
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
    const semanticEffective: PromiseSettledResult<SearchPagesResult> =
      semanticResult.status === "rejected" && isAbortRejection(semanticResult.reason)
        ? { status: "fulfilled", value: { pages: [], capped: false } }
        : semanticResult

    if (
      semanticEffective.status === "rejected" &&
      semanticEffective.reason instanceof SemanticSearchUnavailableError
    ) {
      if (containsResult.status === "rejected") {
        logHybridBothFailure(containsResult.reason, semanticEffective.reason)
      }
      throw semanticEffective.reason
    }

    if (containsResult.status === "rejected" && semanticEffective.status === "rejected") {
      // Both legs failed — log both messages on one stderr line
      // unconditionally (operators triaging a real outage need both
      // rejection reasons regardless of LORE_DEBUG), then surface one to
      // the caller. We choose `containsResult.reason` so the caller's
      // existing `try/catch` sees a structured, DS-scoped error from
      // `dataSources.query` rather than a semantic capability or
      // request error whose detail is less actionable. The choice
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
      semanticEffective.status === "fulfilled" ? semanticEffective.value.pages : []
    const semanticCapped =
      semanticEffective.status === "fulfilled" ? semanticEffective.value.capped : false

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
        const factors = confidenceTraceForPage(page, today, this.features)
        trace.set(page.id, {
          containsRank: rank,
          semanticRank: null,
          rrfScore: null,
          ...factors,
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
    // Confidence metadata is computed once on first encounter so the
    // explain trace can expose it without making it a ranking signal.
    // The RRF formula is rank-only: `Σ (per-branch contribution)`.
    const accumulate = (
      branchPages: PageObjectResponse[],
      branchKind: "contains" | "semantic",
      weight = 1
    ) => {
      branchPages.forEach((page, rank) => {
        const prev = scored.get(page.id)
        const factors = prev ?? confidenceTraceForPage(page, today, this.features)
        const score = (1 / (RRF_K + rank + 1)) * weight
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
            confidenceFactor: factors.confidenceFactor,
            storedConfidenceFactor: factors.storedConfidenceFactor,
            effectiveConfidenceFactor: factors.effectiveConfidenceFactor,
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
        storedConfidenceFactor: entry.storedConfidenceFactor ?? entry.confidenceFactor,
        effectiveConfidenceFactor:
          entry.effectiveConfidenceFactor ?? entry.confidenceFactor,
      })
    }
    return {
      pages: ranked.map((entry) => entry.page),
      branch: "rrf",
      trace,
      capped: containsCapped || semanticCapped,
    }
  }
}
