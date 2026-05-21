/**
 * Memory search inputs and explanation payloads.
 */

import type { MemoryKind, MemoryStatus } from "./domain.js"

/**
 * Search execution mode. Trades off scope precision against ranking quality:
 *
 * - `"contains"` — `dataSources.query` against the Memories DB with
 * `Title contains` / `Keywords contains` / `Synopsis contains` filters.
 * Strictly DS-scoped (no workspace leakage), supports server-side property
 * filters (`kind` / `status` / `tags`), but loses Notion's vector relevance
 * ranking over page bodies. Best for substring/exact-phrase queries on
 * titles, keyword tokens (PR numbers, ticket IDs, function names), and the
 * short curated synopsis written at save time.
 * - `"semantic"` — workspace-wide `client.search` ranked by Notion's vector
 * index over titles AND bodies. Preserves relevance ranking, but cannot
 * apply server-side property filters and may rank non-Memory pages from
 * the same workspace ahead of real hits when the query is niche. Best for
 * phrase-shaped or conceptual queries where body matches matter.
 * - `"hybrid"` (default) — fires `contains` and `semantic` in parallel via
 * `Promise.allSettled`. If contains saturates
 * (`>= HYBRID_FALLBACK_THRESHOLD` hits), the contains rows are used
 * alone and the parallel semantic result is discarded; otherwise the
 * two ranked lists are merged via Reciprocal Rank Fusion (RRF) with
 * a deterministic tie-break (`score → best-rank → contains-presence
 * → page id`). Speculative parallelism keeps the worst-case wall-clock
 * at one round-trip (≈ `client.search` latency) regardless of which
 * leg saturates — the cheap-path waste is one discarded Notion call
 * governed by the shared rate limiter.
 */
export type SearchMode = "contains" | "semantic" | "hybrid"

export interface SearchMemoriesInput {
  query: string
  projectId?: string
  topicId?: string
  /**
   * Search/read filters accept any tag string, not just the closed
   * `Tag` vocabulary — legacy memories predate the vocabulary and must
   * remain filterable. Applied server-side in `mode: "contains"` (and the
   * contains leg of `"hybrid"`); applied as a post-filter in `"semantic"`.
   */
  tags?: string[]
  /**
   * Server-side filter in `"contains"` (and the contains leg of `"hybrid"`);
   * post-filter in `"semantic"` because `client.search` does not accept
   * property filters.
   */
  kind?: MemoryKind
  status?: MemoryStatus
  /**
   * When `true`, do NOT exclude `Status = proposed` rows from the
   * search result set. Defaults to `false` — proposed-memory inbox
   * rows are filtered out of default recall paths so a noisy
   * autosave-as-proposed flow cannot pollute search.
   * Explicit `status: "proposed"` short-circuits this
   * default and surfaces the inbox directly.
   *
   * Mirrors `MemoryService.list`'s `includeProposed` flag with the
   * same semantics. Server-side filter in `"contains"` (and the
   * contains leg of `"hybrid"`); client-side post-filter in
   * `"semantic"` because `client.search` lacks property-filter
   * support.
   */
  includeProposed?: boolean
  /**
   * Exclude memories whose `Pinned` checkbox is true. Used by
   * query-focused wake-up paths where pinned context is intentionally
   * suppressed so governance rows cannot consume the ranked task-memory
   * window.
   *
   * Server-side filter in `"contains"` (and the contains leg of
   * `"hybrid"`); client-side post-filter in `"semantic"` because
   * `client.search` lacks property-filter support.
   */
  excludePinned?: boolean
  limit?: number
  /**
   * When false, skip the per-page `retrieveMarkdown` round-trip and return
   * memories with `content: ""`. Used by callers that render only title /
   * date / tags — e.g. the shell wake-up hook's related-memories section —
   * so the hot path doesn't pay N+1 markdown fetches.
   */
  includeContent?: boolean
  /**
   * Search execution mode. Defaults to `"hybrid"`. See `SearchMode` for the
   * tradeoffs between scope precision and ranking quality.
   */
  mode?: SearchMode
  /**
   * Optional disambiguator. Threaded into the semantic branch's
   * relevance query as context, NEVER into the contains branch's
   * substring match. Use when `query` is short and ambiguous and the
   * caller knows which sense they mean (e.g. `query: "auth"`,
   * `intent: "WeChat session cookie"`).
   *
   * Whitespace-only intent (`" "`) normalizes to unset across every
   * consumer.
   *
   * Under `mode: "hybrid"` (default), setting intent disables the
   * saturation cutoff so the RRF merge always runs — intent would
   * otherwise be discarded when contains has `>= HYBRID_FALLBACK_THRESHOLD`
   * hits. Under RRF, the contains lane is up-weighted so contains-precision
   * still dominates ordering. Has no effect under `mode: "contains"`.
   */
  intent?: string
  /**
   * When `true`, skip the default scope filter that excludes narrow-scope
   * (`session` / `agent` / `user` / `role` / `run` / `environment`) rows
   * whose `scopeKey` does not match the resolved `MemoryScopeContext`,
   * AND skip the expired-row exclusion. Defaults to `false`.
   *
   * Operator-facing audit paths (`lore status`'s expiring-rows surface,
   * triage tooling) opt in. Agent-facing recall paths leave it unset so
   * a session-scoped note from a different session never leaks into
   * default retrieval — the load-bearing acceptance criterion of scope.
   *
   * Server-side filter clause in `"contains"` (and the contains leg of
   * `"hybrid"`); client-side post-filter in `"semantic"` because
   * `client.search` lacks property-filter support.
   */
  includeOutOfScope?: boolean
  /**
   * When `true`, keep expired rows while still enforcing narrow-scope
   * kind/key isolation. This is narrower than `includeOutOfScope`: wake-up
   * diagnostics can inspect expired operational memories without exposing
   * another session's private rows.
   */
  includeExpired?: boolean
}

/**
 * Per-row diagnostic for `MemoryService.searchWithExplain`. One entry per
 * memory in the result list, aligned by index (`explain[i]` describes
 * `memories[i]`).
 *
 * The `branch` field carries the resolved-mode information explicitly so
 * a reader doesn't have to infer it from null patterns. Branch-field
 * semantics are pinned:
 *
 * - `"contains-only"` — `mode: "contains"`. `semanticRank` is always
 * `null`; `rrfScore` is `null`.
 * - `"semantic-only"` — `mode: "semantic"` (including the
 * `LORE_FORCE_SEMANTIC_SEARCH=1` kill-switch case). `containsRank`
 * is always `null`; `rrfScore` is `null`.
 * - `"contains-saturated"` — `mode: "hybrid"` and the saturation cutoff
 * fired. `containsRank` reflects the row's position in the contains
 * list; `semanticRank` is **always `null`** because the semantic
 * branch's output was discarded — surfacing its rank would imply
 * influence on ordering that did not happen. `rrfScore` is `null`.
 * - `"rrf"` — `mode: "hybrid"` and the under-saturation merge ran.
 * Both ranks reflect actual branch presence (one may be `null` when
 * only one branch surfaced the row); `rrfScore` is the fused score
 * used for ordering.
 *
 * Field names are canonical to lore (qmd uses `lexRank` for the contains
 * lane; we keep `containsRank` because the underlying Notion query is
 * a `contains` filter, not a lexical index). A test pins the names so
 * they don't drift toward qmd vocabulary in a future refactor.
 */
export interface SearchExplain {
  memoryId: string
  /** 0-based; null when contains did not run or did not surface this row. */
  containsRank: number | null
  /** 0-based; null when semantic did not run, was discarded, or did not surface this row. */
  semanticRank: number | null
  /** Populated only on the `"rrf"` branch; null on every other branch. */
  rrfScore: number | null
  branch: "contains-only" | "semantic-only" | "contains-saturated" | "rrf"
  /**
   * The confidence-weighting factor applied to this row's per-branch RRF
   * score. `1.0` for unscored (unmigrated `Confidence Score = null`)
   * or fully-trusted rows; `CONFIDENCE_FACTOR_MIN` (default `0.5`) for
   * fully-decayed rows. This is the applied effective factor, including
   * ranking-time neglect decay from `Last Referenced At`. Multiplied into the score in
   * `MemoryService.searchByHybridPages` and the single-branch
   * `searchByContainsPages` / `searchBySemanticPages` paths.
   *
   * Older traces may have this field absent; deserialize-aware
   * consumers tolerate the missing field.
   */
  confidenceFactor: number
  /**
   * Factor from the stored `Confidence Score`, without ranking-time decay.
   * Present on live traces so explain output can show when effective decay
   * changed ordering. Older traces may lack this field.
   */
  storedConfidenceFactor?: number
  /**
   * Factor after applying ranking-time decay from `Last Referenced At`.
   * Equal to `confidenceFactor` on live traces; named explicitly for
   * diagnostics and rollout comparisons. Older traces may lack this field.
   */
  effectiveConfidenceFactor?: number
}
