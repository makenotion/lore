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
import { searchViaRunTool } from "../notion/runtool/index.js"
import { MEMORY_CLEANUP_ORPHAN_SENTINEL } from "./near-duplicate.js"
import { redactDebugMessage } from "../debug-redact.js"
import { todayUtc } from "./task.js"
import {
  extractMultiSelect,
  extractCheckbox,
  extractRelationIds,
  extractRichText,
  extractSelect,
  isFullPage,
} from "../notion/extractors.js"
import { collectLivePages, warnLivePageCapFired } from "../notion/live-pages.js"
import { hydrateRelationPropertiesForPages } from "../notion/relation-properties.js"
import { matchesDefaultScope } from "./memory-scope.js"
import { withCleanupOrphanExclusion } from "./memory-filters.js"
import {
  defaultKindExclusionFilters,
  defaultSourceExclusionFilters,
  isDefaultRecallKind,
  isDefaultRecallSource,
} from "./memory-recall-policy.js"
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
 * surface it) plus the running fused score. Captured outside the merge
 * loop so the deterministic tie-break in `tieBreakingRrfCompare` and
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

export type SearchPagesResult = {
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
   * - `"semantic"` (default) — Notion AI search when RunTool search is
   * enabled, otherwise workspace-wide `client.search`, ranked by Notion's
   * relevance engine over titles AND bodies. Property filters degrade to
   * client-side post-filters. Best for phrase-shaped queries that need body
   * relevance.
   * - `"hybrid"` — fire contains and semantic in parallel; if
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
   * **Mode force.** `LORE_FORCE_SEMANTIC_SEARCH=1` overrides the
   * caller's mode and forces every search through the semantic path. It does
   * not disable RunTool search; `LORE_USE_RUNTOOL_SEARCH=0` is the RunTool
   * transport rollback.
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
    return { memories, explain, capped }
  }

  /**
   * DS-scoped query path — **raw fetch**. Runs against the Memories data
   * source only, returns Notion's recency ordering verbatim.
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

    if (input.unscopedOnly === true) {
      filters.push({ property: MEMORY_PROPS.PROJECT, relation: { is_empty: true } })
    } else if (input.projectId) {
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
    if (input.source) {
      filters.push({ property: MEMORY_PROPS.SOURCE, select: { equals: input.source } })
    } else {
      filters.push(...defaultSourceExclusionFilters())
    }
    if (input.kind) {
      filters.push({ property: MEMORY_PROPS.KIND, select: { equals: input.kind } })
    } else {
      filters.push(...defaultKindExclusionFilters())
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
   * Returns Notion's relevance ordering verbatim.
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
  async fetchSemanticPages(
    input: SearchMemoriesInput,
    intent: string | null,
    signal?: AbortSignal
  ): Promise<SearchPagesResult> {
    // Compose the semantic relevance query from the caller's `query` plus
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
    if (limit <= 0) return { pages: [], capped: false }

    const trimmedComposedQuery = composedQuery.trim()
    if (this.features.runTool.search && trimmedComposedQuery.length > 0) {
      return this.fetchSemanticPagesViaRunTool(input, trimmedComposedQuery, signal)
    }

    // Empty semantic queries are recall/list-shaped rather than relevance-shaped:
    // RunTool requires a non-empty query and a workspace-wide REST search would
    // be an implicit API switch. Use the DS-scoped contains fetcher without a
    // text clause so property filters and recency define the result.
    if (trimmedComposedQuery.length === 0) {
      return this.fetchContainsPages(input)
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
    return { pages: accumulated, capped: cappedOut }
  }

  /**
   * RunTool `search` consumer for the semantic lane.
   *
   * Returns `PageObjectResponse[]` plus cap metadata shaped like the
   * REST output so the rest of `runSearch` (post-filter, materialize,
   * explain) consumes either path identically. Cooperative abort throws an
   * `AbortError`-shaped value so `searchByHybridPages`'s
   * `Promise.allSettled` discard works unchanged.
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
   * `RUNTOOL_SEARCH_MAX_PAGE_SIZE` (25) regardless of caller limit so
   * `applySemanticPostFilters` has the most headroom; production callers omit
   * `pageSize` to get this default. 25 retrieves is therefore both the cap and
   * the typical case. A saturated response is accepted as the semantic answer
   * and surfaced through `capped: true`; the caller does not switch to REST.
   *
   * **Error classification.** 403 / 401 / 429 / 5xx / 400 / malformed
   * propagate verbatim. The service-layer auth preflight rejects
   * integration-token shapes before RunTool is called.
   */
  async fetchSemanticPagesViaRunTool(
    input: SearchMemoriesInput,
    composedQuery: string,
    signal?: AbortSignal
  ): Promise<SearchPagesResult> {
    if (signal?.aborted) {
      throw buildAbortError(signal)
    }

    const outcome = await searchViaRunTool(this.client, {
      query: composedQuery,
      dataSourceId: this.db.dataSourceId,
      // `pageSize` is omitted so the wrapper applies its default
      // (`RUNTOOL_SEARCH_MAX_PAGE_SIZE`). We always want the
      // server cap regardless of caller `limit`:
      // `applySemanticPostFilters` is the authoritative cap and
      // the post-filter narrows aggressively (project / kind /
      // status / scope / archived / cleanup-orphan). Maxing out
      // the raw window gives the semantic lane the largest
      // RunTool-backed candidate set without changing the final
      // shape of the result.
    })

    // Cooperative abort check between the network call and the
    // hydration loop — same posture as `applySemanticPostFilters`,
    // which checks before its `hydrateRelationPropertiesForPages`
    // call so a discarded response doesn't pay the heavy hydration
    // tail.
    if (signal?.aborted) {
      throw buildAbortError(signal)
    }

    if (outcome.hits.length === 0) {
      return { pages: [], capped: outcome.saturated }
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
    // **Hydrate via `hit.url`, not `hit.id`.** The RunTool `id`
    // field is the search index's internal resource id and is NOT
    // guaranteed to match the page id. The wrapper normalizes
    // Notion-hosted `url` values to page ids and drops external
    // connector hits, so by construction `hit.url` is the right
    // value to pass to `pages.retrieve`.
    //
    // Per-id retrieval failures: 404 / RestrictedResource drop
    // silently — Notion's search index lags delete / archive /
    // permission-revocation, so a stale hit is expected. Every
    // other class (401, 429, 5xx, network) propagates so the
    // rate-limit and auth-refresh proxies engage on their canonical
    // surface.
    const pages: PageObjectResponse[] = []
    const seenPageIds = new Set<string>()
    for (const hit of outcome.hits) {
      if (seenPageIds.has(hit.url)) continue
      seenPageIds.add(hit.url)
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
    return { pages: filtered, capped: outcome.saturated }
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

    // Apply additional filters (project, topic, tags, source, kind, status). The
    // search API has no property-filter support, so these are post-filters.
    const filterRelationProperties: string[] = []
    if (input.unscopedOnly === true || input.projectId) {
      filterRelationProperties.push(MEMORY_PROPS.PROJECT)
    }
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

    if (input.unscopedOnly === true) {
      filtered = filtered.filter((page) => {
        const ids = extractRelationIds(page.properties[MEMORY_PROPS.PROJECT])
        return ids.length === 0
      })
    } else if (input.projectId) {
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
    if (input.source) {
      filtered = filtered.filter(
        (page) =>
          extractSelect(page.properties[MEMORY_PROPS.SOURCE], "manual") === input.source
      )
    } else {
      filtered = filtered.filter(isDefaultRecallSource)
    }
    if (input.kind) {
      filtered = filtered.filter(
        (page) => extractSelect(page.properties[MEMORY_PROPS.KIND], "note") === input.kind
      )
    } else {
      filtered = filtered.filter(isDefaultRecallKind)
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
    if (input.excludePinned === true) {
      filtered = filtered.filter(
        (page) => !extractCheckbox(page.properties[MEMORY_PROPS.PINNED])
      )
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
   * `dataSources.query`.
   */
  async searchByContainsPages(input: SearchMemoriesInput): Promise<SearchPagesResult> {
    return this.fetchContainsPages(input)
  }

  /**
   * Public semantic path. Notion's relevance order is authoritative for this
   * lane.
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
   * **Single-branch resilience.** A `Promise.all` over both legs
   * would propagate any rejection (a transient 429 from `client.search`,
   * for instance) to the caller, even when contains saturated independently
   * — a regression vs. the single-call latency floor. With
   * `Promise.allSettled` a rejected branch degrades to an empty result and
   * the surviving branch's rows are returned; both-branches-rejected still
   * surfaces an error so a fully broken search subsystem doesn't masquerade
   * as an empty-result silence. Branch failures are logged to stderr under
   * `LORE_DEBUG=1` so operators can distinguish a one-off blip from a
   * pathological loop. `LORE_FORCE_SEMANTIC_SEARCH=1` remains the manual
   * rollback to semantic-only mode; it does not disable the RunTool search
   * transport.
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
   * skips the heavy `hydrateRelationPropertiesForPages` step on pages
   * destined for the discard pile. A saturating contains query is
   * bounded to the page already in flight when abort fires, with
   * synchronous test doubles allowed one extra observed call because
   * they resolve without an event-loop turn. The discarded-result
   * rejection arrives as
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
   * recency listing under property filters; the semantic leg also uses the
   * Memories data source listing path because RunTool search requires a
   * non-empty query. If contains saturates, semantic is discarded —
   * empty-query hybrid effectively behaves as `mode: "contains"`. Callers
   * wanting predictable empty-query semantics should pass `mode:
   * "contains"` explicitly.
   */
  async searchByHybridPages(
    input: SearchMemoriesInput,
    limit: number,
    intent: string | null
  ): Promise<{
    pages: PageObjectResponse[]
    branch: "contains-saturated" | "rrf"
    trace: Map<string, HybridTraceEntry>
    capped: boolean
  }> {
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
    const semanticEffective: PromiseSettledResult<SearchPagesResult> =
      semanticResult.status === "rejected" && isAbortRejection(semanticResult.reason)
        ? { status: "fulfilled", value: { pages: [], capped: false } }
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
        trace.set(page.id, {
          containsRank: rank,
          semanticRank: null,
          rrfScore: null,
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
    const accumulate = (
      branchPages: PageObjectResponse[],
      branchKind: "contains" | "semantic",
      weight = 1
    ) => {
      branchPages.forEach((page, rank) => {
        const prev = scored.get(page.id)
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
