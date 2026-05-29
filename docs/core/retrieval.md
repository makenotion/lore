# Core Retrieval Contracts

> Read the root [`AGENTS.md`](../../AGENTS.md) first, then
> [`src/core/AGENTS.md`](../../src/core/AGENTS.md). This file carries the
> focused retrieval contract for the core subsystem.

This page is the current contract for memory retrieval behavior. Historical
issue numbers and compatibility notes appear only where they explain an active
invariant; they do not change the contract below.

## Memory List

`MemoryService.list()` is the paginated data-source read primitive behind
agent-facing recall and several maintenance scans. Its default
`recallPolicy` is `"knowledge"`: omitted `source` excludes `agent_diary` /
`digest`, and omitted `kind` excludes `task` / `operational`. Explicit
`source` and `kind` filters bypass only their own default exclusion.

Maintenance scans that promise full-vault coverage must pass
`recallPolicy: "all"` so source/kind hygiene does not silently hide rows from
migration or audit totals. The cleanup-orphan exclusion still applies.

## Memory Search

`MemoryService.search()` switches on `input.mode` (default `"semantic"`)
between three execution paths. Each path returns the same `Memory[]` shape;
they differ in scope, filter capability, and ranking.

### `mode: "contains"` (DS-scoped, server-side filters)

Issues a `dataSources.query` against the Memories DS only — never touches
`client.search`. The filter is composed as a single `and`:

- Project inheritance: `Project relation contains projectId OR Project is_empty`
  (mirrors `MemoryService.list`).
- Topic: `Topic relation contains topicId`.
- Tags: any-match `OR` across tag values (single value collapses to a flat
  `multi_select.contains`).
- Source / Kind / Status: server-side `select.equals`.
- Default recall hygiene: when `source` is omitted, `agent_diary` and
  `digest` rows are excluded; when `kind` is omitted, `task` and
  `operational` rows are excluded. Explicit `source` or `kind` filters bypass
  that field's default exclusion.
- Text clause: title, keywords, or synopsis contains the query.
  Synopsis joins the precision lane (issue 0.7.0/01–02) because it's
  agent-curated, short, and high-signal — a
  phrase absent from title and keywords but present in a synopsis would
  otherwise miss the contains lane entirely. All three branches share
  Notion's case-insensitive `contains` semantics on `rich_text`/`title`.

**Empty / whitespace-only queries skip the text clause** — `contains: ""`
matches every row in Notion, which would degenerate the query into "every
page in the DS." Skipping the clause lets the surrounding property filters
drive the result set, giving the caller a recency-ordered listing under
their other filters. Sort is `last_edited_time desc`; `page_size` is the
caller's `limit` (max 100).

Body matches are **not** searched here — `dataSources.query` only filters
on properties. Callers that need body relevance should use `"semantic"`.

**Archived rows are excluded client-side.** Notion's `archived` flag
lives on `PageObjectResponse`, not as a DB column, so `dataSources.query`
returns archived rows by default. `fetchContainsPages` filters them out
post-fetch — same posture as `findByTopicKey`, `listAllForBackfill`, and
`listForScan`. Without this, an archived row at the top of recency could
occupy a result slot a live row would otherwise fill.

### `mode: "semantic"` (default relevance path)

Uses RunTool `search` when `LORE_USE_RUNTOOL_SEARCH` is enabled and the
composed query is non-empty. RunTool search is scoped to the Memories data
source and returns Notion's relevance order over titles and bodies. The raw
window is capped at 25 because the tool exposes no cursor; Lore accepts that
window as authoritative and surfaces saturation as `capped: true` rather than
switching to REST ranking. A RunTool response type other than `ai_search`
throws an "AI semantic search unavailable" error instead of returning lexical
workspace-search results under semantic mode.

When RunTool search is disabled, the path uses `client.search()` for relevance
ranking against page titles AND bodies. Results are post-filtered to the
Memories DS — matching either `parent.type === "database_id"` against
`db.databaseId` **or** `parent.type === "data_source_id"` against
`db.dataSourceId`. Notion SDK v5 returns both shapes in the wild depending on
when and how the page was created; accepting only `database_id` silently
filters out every real result from a data-source-backed workspace.

Property filters (`projectId` / `topicId` / `tags` / `source` / `kind` /
`status`) all post-filter client-side because `client.search` has no
property-filter support. The same default recall hygiene as the contains lane
applies client-side: omitted `source` drops `agent_diary` / `digest`, and
omitted `kind` drops `task` / `operational`.

**Do not pass a `sort` parameter to `client.search()`.** Notion's `search`
endpoint returns results ranked by relevance when no `sort` is provided.
Passing a `sort` switches to recency ordering and demotes the query to a
lexical filter — which defeats the whole purpose of semantic search. We
fetch `page_size: 100` instead so the post-filter to the Memories DS has
headroom when the workspace contains unrelated pages matching the query
tokens.

When using REST, the path **paginates up to `SEMANTIC_SEARCH_MAX_PAGES` raw pages (default 5)** when
the first 100 raw hits do not yield enough post-filtered Lore memories to
satisfy the requested `limit` (issue #192). Loop exits early on
saturation (`accumulated >= limit`) or exhaustion (`has_more: false`); the
cap fires only when both conditions miss — bounding worst-case latency at
five sequential `client.search` round-trips and protecting the per-token
rate-limit bucket from a pathological query that has no matches anywhere
in the workspace. See `SEMANTIC_SEARCH_MAX_PAGES`'s docstring for the
choice rationale (scan window, tail latency, rate-limit budget).

**Pagination dedupes by page id across cursor steps.** `client.search`
runs each cursor step as a fresh workspace-wide query, not a slice of a
frozen result set, so concurrent vault edits between page-N and page-N+1
fetches CAN surface the same memory id twice. The dedup `Set<string>`
guards both consumers: hybrid's RRF accumulator (intra-branch
double-credit would inflate the fused score) and the semantic-only
caller (rendering the same row twice is a visible correctness bug). Pre-
pagination this couldn't happen — single page meant single observation.

**Returns the full pagination accumulator without an early slice.**
The saturation gate bounds `accumulated.length` to the range from 0
through `limit + pageSize - 1`; trimming inside `fetchSemanticPages`
would silently narrow the hybrid RRF pool. A row at semantic-rank 11
that also appears in contains contributes its `1 / (RRF_K + 11 + 1)`
to the fused score and can plausibly beat a contains-only row — but
only if it survives long enough to reach the accumulator. `runSearch`
applies `pages.slice(0, limit)` at the call boundary as the
authoritative final cap for semantic-only callers; hybrid consumes the
wider pool.

**Operator triage signal.** When the cap fires (loop exhausted
`SEMANTIC_SEARCH_MAX_PAGES` without saturating or hitting `has_more:
false`), `debugLogSemanticSearchCapFired` writes one stderr line under
`LORE_DEBUG=1`: `[lore] semantic-search-cap-fired: pages=5
  accumulated=N limit=L source=fetch-semantic-pages`. The `LORE_DEBUG`
gate keeps the common path silent; operators triaging "lore-query
returned empty / short results" use this to distinguish the
pathological-query case from genuine no-matches. Same posture as
`debugLogHybridBranchFailure`.

**Archived memory pages are excluded** before they enter the
accumulator. `client.search` ignores Notion's `archived` flag; under
pagination, an archived memory pushed into the accumulator counts
toward `limit` and can stop the loop before later live matches are
fetched. The `applySemanticPostFilters` helper drops archived rows in
the same pass as the parent-DB match — mirrors the every-other-walker
contract (`findByTopicKey`, `listAllForBackfill`, `listForScan`,
`fetchContainsPages`).

### `mode: "hybrid"`

Speculative parallelism. `searchByHybridPages` fires `fetchContainsPages`
and `fetchSemanticPages` (the **raw** fetch helpers — see "Fetch/sort
pipeline split" below for why hybrid composes the raw helpers, not the
public confidence-aware wrappers) concurrently via `Promise.allSettled`.
Once both settle:

- **Saturating case** (`containsPages.length >= HYBRID_FALLBACK_THRESHOLD`,
  default 3): the contains rows alone become the result. The parallel
  semantic call is aborted via `AbortController` (issue #490). Both
  branches still dispatch in parallel — the abort is a side-effect of
  contains landing fulfilled-saturating, not a precondition of
  semantic dispatching. The signal flows into `fetchSemanticPages`,
  which checks it pre-loop, pre-call, post-page, and inside
  `applySemanticPostFilters` (so the heavy
  `hydrateRelationPropertiesForPages` step is skipped on pages
  destined for the discard pile).

  **Residual-call bound.** The Notion SDK v5 does NOT expose a per-
  call `AbortSignal` (`SupportedRequestInit` has no `signal` field;
  the `fetch` option on `ClientOptions` is set at construction, not
  per-call), so the in-flight HTTP request itself is NOT cancelled
  at the network layer — what we cancel is the dispatch of further
  pages. In production, `client.search` is a network call whose
  `await` yields the event loop for tens to hundreds of ms; by the
  time semantic page N's response lands and the continuation runs,
  contains' saturation handler has had ample microtask time to
  drain, the post-filter signal check trips, and page N+1 never
  dispatches — production-typical residual is **1**: the page in
  flight when `controller.abort()` ran. The pre-fix worst case was
  up to `SEMANTIC_SEARCH_MAX_PAGES` (5) sequential calls.

  **Synchronous-mock degenerate case.** When both promises resolve
  in the same JS tick (test mocks that return synchronously,
  pathologically fast networks), the
  `[semantic continuation, saturation handler]` microtask ordering
  can dispatch page N+1 before the saturation handler aborts —
  residual = 2. Tests in `memory.test.ts` use `setTimeout(0)` to
  force a macrotask boundary that pins the production-typical
  residual = 1 behavior.

  **Cooperative-abort rejection is not a branch failure.** The
  semantic branch's abort surfaces as an `AbortError`-shaped
  rejection at `Promise.allSettled`. `searchByHybridPages` filters
  it via `isAbortRejection` and maps it to fulfilled-empty BEFORE
  the both-failure detector and the partial-failure log gate run.
  A cooperative discard is silent under `LORE_DEBUG=1` and does
  not trip the both-down outage path.

  **Saturation/abort gate is single-source via `shouldUseSaturationCutoff`.**
  The predicate `intent === null && containsPages.length >=
HYBRID_FALLBACK_THRESHOLD` is read by both the post-`allSettled`
  saturation cutoff branch AND the abort-on-saturation `.then`
  handler attached to the contains promise. The two sites cannot
  drift; tightening the cutoff (adding a `containsCapped`
  precondition, etc.) lands in one place. The `intent === null`
  gate is shared with #17's saturation-bypass-under-intent rule
  for the same reason.

- **Under-shooting case (RRF)**: when contains under-shoots the
  threshold, the merge runs Reciprocal Rank Fusion over both branches
  rather than concat-with-dedup. Each row's score is
  `Σ (1 / (RRF_K + rank + 1)) * weight * confidenceFactor` summed across
  the branches it appears in; `RRF_K = 60` (Cormack 2009 / qmd default).
  `confidenceFactor` is the per-row `[CONFIDENCE_FACTOR_MIN, 1.0]`
  multiplier from `decay.ts`, computed from the ranking-time effective
  score rather than the raw stored score. The
  effective score applies neglect decay from `Last Referenced At` in
  memory and does not write the decayed value back to Notion. The factor
  is applied **once per per-branch contribution** inside the
  `MemorySearch.searchByHybridPages` accumulator. Cross-branch agreement is
  the signal RRF surfaces — a row ranked #1 in both branches with
  `confidenceFactor=1.0` scores `2/61` and beats a row ranked #1 in
  only one branch (`1/61`). The earlier concat-then-fill heuristic
  discarded that signal.

  **Tie-break order** (deterministic, fixture-pinned): score →
  best-rank → contains-presence → page id ascending. `bestRank` is the
  minimum of contains rank and semantic rank, with missing ranks treated
  as infinity. The contains-presence rule
  preserves the "contains is precision" intuition the prior heuristic
  encoded — a contains-present row beats a semantic-only row when score
  AND best-rank are tied. A future contributor tempted to "make
  tie-break symmetric" would silently shift this case; the test fixture
  pins it via an adversarial alphabetic ordering on the semantic-only id.

  **Saturation cutoff is preserved verbatim above the RRF block.** RRF
  only runs when contains under-shoots — the precision case where
  contains nails it (file names, PR numbers, function names) skips RRF
  entirely and returns contains rows in their original order. The
  saturation gate is the first decision; RRF is the second.

- **Single-branch failure (PF3-03).** A rejected branch degrades to an
  empty result; the surviving branch's rows pass through unchanged. A
  transient `429`/`5xx` from `client.search` no longer takes down a
  contains query that saturated independently, and an outage on
  `dataSources.query` no longer takes down a semantic query that
  returned. `LORE_DEBUG=1` emits one stderr line per failed branch
  (`[lore] partial-failure: branch=<contains|semantic> error=<message>
source=hybrid-search`) so an operator can distinguish a transient
  blip from a pathological loop. **Both branches rejected** still
  surfaces an error so a fully broken search subsystem doesn't
  masquerade as "no results found." The both-fail path additionally
  writes `[lore] both-failure: contains=<message> semantic=<message>
source=hybrid-search` **unconditionally** — not gated on
  `LORE_DEBUG` — because there is no surviving response to mask
  noise on, the caller's `try/catch` only sees one chosen `throw`,
  and an operator triaging a real outage needs both rejection
  reasons regardless of how their environment was started. The
  surfaced error is `containsResult.reason` (DS-scoped, structured
  filter errors are more actionable than `client.search`
  workspace-wide errors); flipping that choice would be observable
  to callers and should be a coordinated change.

  **Visibility-cost note.** A genuine clean-miss and a "one branch
  down, the other returned zero hits" both surface as an empty
  result to the caller — by design, since the surviving branch's
  empty result IS the honest answer to the query. The operator-side
  mitigation is the `LORE_DEBUG=1` stderr line; the production
  followup is an error-counter dashboard alert.

  **Log-format divergence from the shared partial-failure logger.**
  Both helpers share the `[lore] partial-failure:` prefix and the
  `error=` field — that is the stable contract for `grep`-based
  log aggregation. The key names diverge: hybrid search uses
  `branch=<contains|semantic>` and `source=hybrid-search` because
  a hybrid branch isn't a Notion root id, and `tool=hybrid-search`
  would be misleading (hybrid search is a core-service path, not
  an MCP tool). Downstream parsers should match on the prefix and
  the `error=` field; per-surface key names are intentionally
  scoped to their surface.

Parallelism keeps the under-shooting case to one branch fan-out while
preserving contains precision when it produces enough signal. Switching from
`Promise.all` to `Promise.allSettled` preserves the wall-clock guarantee while
decoupling the failure domains. `LORE_FORCE_SEMANTIC_SEARCH=1` remains the
manual rollback to semantic-only mode; it does not disable the RunTool search
transport. Use `LORE_USE_RUNTOOL_SEARCH=0` or `LORE_USE_RUNTOOL=0` when the
rollback needs to bypass RunTool itself.

Three is a tradeoff: small enough that a niche query with one or two
title hits still gets the benefit of body-relevance ranking, large enough
that the common case (a caller searching a specific PR number, file
name, or function) skips merging with semantic. If the threshold ever
needs tuning, change the `HYBRID_FALLBACK_THRESHOLD` constant in
`memory-search.ts` — it's re-exported so callers can reference it in their own
diagnostics.

### Optional `intent` disambiguator (#17)

`SearchMemoriesInput.intent` is an optional disambiguator threaded
into the **semantic branch's relevance query as context only** —
NEVER into the contains branch's substring match. Use when `query` is
short and ambiguous and the caller knows which sense they mean (e.g.
`query: "auth"`, `intent: "WeChat session cookie"`). Existing call
sites that don't pass `intent` see byte-identical pre-#17 behavior.

**Contains-vs-semantic asymmetry is the load-bearing rule.** Appending
intent into `query` would break the contains branch's substring
match — every Title without the literal disambiguator phrase drops
out, narrowing recall in the opposite direction the disambiguator
exists to fix. The contains branch sees ONLY `input.query`. Body
matches are not searched in contains regardless (see the contains
caveat above), so the asymmetry is doubly tight: contains-mode
ignores `intent` end-to-end. Co-located here next to the contains
caveat so a future contributor doesn't need to chase the rule across
two surfaces.

**Normalize once, whitespace-only treated as unset.** Both consumers
(the saturation gate in `searchByHybridPages` and the query
composition in `searchBySemanticPages`) read the same normalized
value computed at the top of `runSearch`:

```ts
const trimmedIntent = input.intent?.trim()
const intent =
  trimmedIntent !== undefined && trimmedIntent.length > 0 ? trimmedIntent : null
```

Whitespace-only intent (`"   "`) collapses to `null` so it cannot
accidentally bypass the saturation cutoff or pollute the semantic
query with leading/trailing spaces. The `null` sentinel is the
single signal of "intent is set"; helpers branch on `intent !== null`.

**Saturation-cutoff bypass under intent.** `searchByHybridPages`
gates the saturation cutoff on `intent === null`:

```ts
if (intent === null && containsPages.length >= HYBRID_FALLBACK_THRESHOLD) {
  // contains-saturated branch — discard the parallel semantic call
} else {
  // RRF merge runs regardless of contains saturation
}
```

Without this gate, a naive intent implementation has no effect in
the common case: any non-trivial vault produces 3+ contains hits for
a one-word query, the saturation cutoff fires, and the
intent-augmented semantic call is built, dispatched, and discarded.
The cost of the bypass is small (one Map walk + one sort) but
observable — an agent passing intent on every call sees slightly
different ordering on queries that today saturate. The alternative
(keep the cutoff under intent) silently nullifies intent in the
common case, which is worse.

**Lane weighting under RRF when intent is set.** When intent
disables the cutoff, the RRF merge runs with `containsWeight = 2`
and `semanticWeight = 1`. Contains-precision still dominates
ordering (the literal-precision lane wins when both branches agree)
while the intent-augmented semantic lane can still surface a row
contains missed. This mirrors qmd's "original query ×2" rule. When
intent is unset, both weights default to `1` — byte-identical to
the pre-#17 RRF baseline. The `2` is empirical and the same
operator-tuning posture as `RRF_K`: a future env knob
(`LORE_HYBRID_CONTAINS_WEIGHT`) is the next step if real-query
ordering needs adjustment, not a per-call argument.

**Empty `query` composition.** The semantic branch composes its relevance query
as `[query.trim(), intent].filter(Boolean).join(" ")`,
so an empty `query` (allowed on `MemoryService.search` callers that
pass `""` for unscoped relevance lookups) produces `"intent"` rather than
`" intent"` — Notion may rank a leading-space string differently from the bare
term.

The contains-vs-semantic asymmetry is the load-bearing decision and
the most likely source of future regression. A future contributor
tempted to "make intent symmetric across both branches" would
silently re-introduce the recall-narrowing failure mode this
parameter exists to avoid.

### Diagnostic trace via `searchWithExplain`

`MemoryService.search` returns `Promise<Memory[]>` for every existing
caller; the contract is byte-stable. A sibling method
`searchWithExplain(input)` runs the same pipeline, returns the same row
order, and additionally surfaces per-row diagnostics aligned by index
(`explain[i]` describes `memories[i]`).

The two-method shape is deliberate. TypeScript overload signatures would
force every existing call site (including `loadWakeUpData`) to disambiguate
at the boundary, paying a typing tax for a feature 99% of callers don't
need. Two methods keep the contract clean and put the cost only on opt-in
callers.

The explain shape (`SearchExplain` in `src/types.ts`) carries:

- `memoryId` — the row's Notion page id.
- `containsRank` / `semanticRank` — 0-based rank within each branch, or
  `null` when that branch did not run, was discarded, or did not surface
  the row.
- `rrfScore` — populated only on the `"rrf"` branch.
- `branch` — the canonical signal: `"contains-only"`, `"semantic-only"`,
  `"contains-saturated"`, or `"rrf"`. Reflects the **resolved** mode (after
  `LORE_FORCE_SEMANTIC_SEARCH=1` is applied), not the caller's request.
- `confidenceFactor` — the applied effective factor multiplied into this
  row's per-branch RRF score: `[CONFIDENCE_FACTOR_MIN, 1.0]`, default `1.0`
  for unscored or fully-trusted rows. Populated on every branch.
- `storedConfidenceFactor` / `effectiveConfidenceFactor` — diagnostic
  factors for explain output. The stored factor maps the Notion
  `Confidence Score` as-is; the effective factor applies ranking-time decay
  from `Last Referenced At`. Live traces set `confidenceFactor` equal to
  `effectiveConfidenceFactor`.
  Serialized trace fixtures that lack these fields are still tolerated by
  consumers.

**Branch-field rules** (pinned by tests):

| Resolved mode                   | `branch`             | `containsRank`           | `semanticRank`           | `rrfScore`  |
| ------------------------------- | -------------------- | ------------------------ | ------------------------ | ----------- |
| `"contains"`                    | `contains-only`      | row position in contains | `null`                   | `null`      |
| `"semantic"` (incl. mode force) | `semantic-only`      | `null`                   | row position in semantic | `null`      |
| `"hybrid"`, saturated           | `contains-saturated` | row position in contains | **always `null`**        | `null`      |
| `"hybrid"`, RRF                 | `rrf`                | actual rank or `null`    | actual rank or `null`    | fused score |

The "saturated → semanticRank null" rule is load-bearing: the semantic
branch ran in parallel and may have returned the same id, but the
saturation cutoff discarded its output. Surfacing its rank in the trace
would imply influence on ordering that did not happen.

The explain trace is also surfaced through `lore-query
action='search'` via the optional `explain: boolean` field, rendered as a
`## Score trace` footer (one row per result). Agents that don't pass
`explain` pay zero output-token cost.

Field names (`containsRank`, `semanticRank`, `rrfScore`, `branch`,
`confidenceFactor`, `storedConfidenceFactor`, `effectiveConfidenceFactor`) are
canonical to lore and a test pins them. qmd uses `lexRank` for the contains
lane; we keep `containsRank` because the underlying Notion query is a
`contains` filter, not a lexical index. A future contributor chasing qmd's
vocabulary would silently break the contract.

### Materialization is a single pass

`searchByContainsPages` / `searchBySemanticPages` / `searchByHybridPages`
return raw `PageObjectResponse[]`. `search()` slices the merged result
to `limit` and runs `materializeMemories` exactly once on the survivors.
This is load-bearing: without it, hybrid's under-shooting path could
fetch markdown for `containsHits + semanticHits` candidates (potentially
100+) before the dedupe and `limit` cap. With the single-pass discipline,
hybrid never fetches markdown for a row that isn't in the final response.

### `includeContent: false`

`materializeMemories` honors `includeContent: false` to skip the per-page
`retrieveMarkdown` round-trip. Use it when the caller renders only title /
date / tags (e.g. the shell wake-up hook's related-memories section).

### Fetch/sort pipeline split

Contains and hybrid paths apply the effective confidence factor to the RRF
score **exactly once**. Semantic preserves Notion relevance order. The split
keeps that contract enforceable:

| Layer  | Function                               | Confidence-aware?                                              |
| ------ | -------------------------------------- | -------------------------------------------------------------- |
| Fetch  | `fetchContainsPages(input)`            | No — raw Notion result                                         |
| Fetch  | `fetchSemanticPages(input, intent)`    | No — raw Notion result                                         |
| Public | `searchByContainsPages(input)`         | Yes — fetch + effective factor + sort                          |
| Public | `searchBySemanticPages(input, intent)` | No — Notion relevance order is authoritative                   |
| Public | `searchByHybridPages(...)`             | Yes — composes raw fetch + effective factor in RRF accumulator |

Hybrid composes the **raw** fetch helpers, not the public confidence-
aware contains wrapper. If hybrid called `searchByContainsPages`, the factor
would be applied once in the single-branch sort and again in the RRF
accumulator — collapsing the documented `[CONFIDENCE_FACTOR_MIN, 1.0]` floor to
`[CONFIDENCE_FACTOR_MIN², 1.0]` for hybrid callers (e.g. a row at
score 0.0 would multiply by 0.25, not 0.5).

`rerankByConfidence` (private, in `memory-search.ts`) is the
effective-factor-then-sort applier used by contains mode and the
contains-saturated hybrid branch. It short-circuits when every input row is
unscored
(`Confidence Score = null`) so vaults without confidence scores keep raw
Notion ordering — without that gate, the page-id-ascending fall-through in
`tieBreakingRrfCompare` would re-sort otherwise-tied rows into id order,
masking Notion's recency / relevance ordering.

**Saturation cutoff is unchanged**. The cutoff already has a documented
bypass under `intent !== null`; effective confidence deliberately does NOT add
a "saturated-but-low-confidence" bypass. Even when contains saturates, the
effective factor reranks within the contains branch — a high-stored-score row
with an old `Last Referenced At` can sort below a fresher comparable row.
Adding another bypass would be an observable ordering change and should be
handled as a coordinated retrieval change.

### `LORE_DISABLE_CONFIDENCE_FACTOR=1` kill switch

Operator escape hatch at the top of `confidenceFactor` (`decay.ts`).
With the env var set, every call returns `1.0` unconditionally — a
sustained-failure rollback to unweighted confidence ranking, not a default.
Same posture as `LORE_FORCE_SEMANTIC_SEARCH` and
`LORE_DISABLE_NEAR_DUPLICATE_PROBE`. The check lives at the helper
boundary so single-branch and hybrid paths share one bypass.

### Mode Force: `LORE_FORCE_SEMANTIC_SEARCH=1`

Operator escape hatch checked inside `search()`. When set, every search resolves
to `mode: "semantic"` regardless of the caller's requested mode. It is a
contains/hybrid rollback, not a RunTool transport rollback: with
`LORE_USE_RUNTOOL_SEARCH` enabled, non-empty semantic queries still use RunTool
AI search. Operators who need to bypass RunTool search must set
`LORE_USE_RUNTOOL_SEARCH=0` or `LORE_USE_RUNTOOL=0`.

Use `LORE_FORCE_SEMANTIC_SEARCH=1` if the contains path silently under-recalls
in a vault that hasn't run `lore migrate --fix-memory-encoding` yet — encoded
titles miss substring matches against post-decode queries (see P2-10). Same
posture as `LORE_DISABLE_NEAR_DUPLICATE_PROBE`: an opt-in defensive lever, not
a default.

The `list()` method uses `dataSources.query()` with property filters and is
suited for browsing recent memories by project/topic/source. It has no
substring-title filter — use `search()` for anything that needs relevance
ranking or body-text matching (e.g. `loadWakeUpData`'s related-memories pass,
which seeds a single query from active-task subjects).
