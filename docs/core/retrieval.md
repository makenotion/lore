# Core Retrieval Contracts

> Read the root [`AGENTS.md`](../../AGENTS.md) first, then
> [`src/core/AGENTS.md`](../../src/core/AGENTS.md). This file carries the
> focused retrieval contract for the core subsystem.

## Memory Search

`MemoryService.search()` supports three modes. The default is
`mode: "semantic"`: Notion AI search is the authoritative relevance engine
for natural-language memory lookup.

### `mode: "semantic"`

Semantic search dispatches `POST /v1/tools/run` with the RunTool `search`
consumer and requires the response type to be `ai_search`. The AI-ranked
window is preserved as returned by Notion, then hydrated through
`pages.retrieve` and filtered to Lore memory rows.

The semantic lane does not call `client.search()` and does not rerank by
confidence. Confidence decay still appears in explain traces so operators can
inspect row trust, but it does not change AI relevance order.

RunTool search has a 25-row response cap and no cursor. Lore requests that
maximum window for semantic search. If the server returns a full window, or a
caller asks for more than 25 results, the returned metadata is `capped: true`;
callers should surface that as "more relevant memories may exist," not retry
through keyword search.

Semantic search fails loud when AI search is not available. Empty queries,
disabled RunTool search, `RestrictedResource`, and non-`ai_search` responses
raise `SemanticSearchUnavailableError` with a message prefixed
`AI semantic search unavailable:`. Interfaces must render that reason
separately from a genuine empty result set.

### `mode: "contains"`

Contains search is the explicit lexical path. It issues `dataSources.query`
against the Memories data source and uses property filters:

- Project inheritance: `Project relation contains projectId OR Project is_empty`.
- Topic: `Topic relation contains topicId`.
- Tags: any-match `multi_select.contains`.
- Kind and Status: server-side `select.equals`.
- Text: title, keywords, or synopsis contains the query.

Empty or whitespace-only contains queries omit the text clause, producing a
filtered recency listing. This is the supported path for list-like reads.

Contains search preserves the recency order returned by Notion. Confidence is
diagnostic metadata, not a retrieval-quality signal.

### `mode: "hybrid"`

Hybrid is explicit opt-in. It fires contains and semantic concurrently. When
contains reaches `HYBRID_FALLBACK_THRESHOLD`, the contains rows are returned
and the semantic branch is cooperatively aborted. Otherwise, the branches are
merged by Reciprocal Rank Fusion over branch ranks only. Confidence is exposed
in explain traces but does not affect ordering.

Hybrid does not hide semantic capability failures. If the semantic branch
fails with `SemanticSearchUnavailableError`, the error is surfaced so callers
do not mistake a missing AI search engine for a low-recall keyword result.

### Interfaces

MCP `lore-query action="search"` defaults to semantic mode. It forwards the
requested limit verbatim; semantic search owns the top-25 cap and reports
`capped` metadata. No interface should over-fetch semantic results and then
slice them as a substitute for pagination.

Project-scoped empty results should name the scope, for example
`No memories found for: "..." in project "Mail iOS"`. This distinguishes
wrong-scope misses from real retrieval misses.

Wake-up related memories and user-query task memories use semantic mode because
their seed phrases need AI relevance over titles and bodies. If semantic search
is unavailable, wake-up renders the unavailable reason under the affected
section rather than silently omitting it.

## Retrieval Quality

`lore eval retrieval-quality <suite>` runs labeled query-to-memory cases
through three lanes:

- `ai_search`: product semantic search, requiring RunTool `ai_search`.
- `rest_keyword`: direct Notion SDK `client.search()` keyword comparison lane.
- `current`: product default search path.

The artifact records target rank, recall@1/5/10, MRR, cap metadata, and the
top returned IDs/titles per lane. The committed Mail suite lives at
`evals/retrieval-quality/mail.yaml`.
