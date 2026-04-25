# AGENTS.md -- src/core/

> Read the root `AGENTS.md` first. This file covers the domain logic layer only.

## Purpose

This directory contains Lore's business logic: CRUD operations for each entity
type, context resolution, and vault management. These services sit between the
interfaces (MCP, CLI, hooks) and the Notion SDK layer (`src/notion/`).

## Files

| File          | Class/Function     | Responsibility                                             |
| ------------- | ------------------ | ---------------------------------------------------------- |
| `vault.ts`    | `VaultManager`     | Init/load vault, get database IDs, count stats, drift check |
| `project.ts`  | `ProjectService`   | CRUD for projects, findByPath, findByName                  |
| `topic.ts`    | `TopicService`     | CRUD for topics, getOrCreate, listByProject                |
| `memory.ts`   | `MemoryService`    | CRUD + list + semantic search for memories                 |
| `fact.ts`     | `FactService`      | Knowledge graph triples with temporal validity             |
| `decision.ts` | `DecisionService`  | Decision lifecycle (Kind=decision memories): create, list (index tier), supersede, chain walk, review |
| `task.ts`     | `TaskService`     | Task CRUD (Kind=task memories): create, list (index tier), update, close, queryOverdue. P3-02 successor to tracking-predicate facts. |
| `task-migration.ts` | `migrateTrackingFactsToTasks()` | One-shot conversion from tracking facts → task memories. Plan-then-execute via `lore migrate --migrate-tracking-to-tasks --yes`. |
| `entity.ts`   | `EntityService`    | Canonical-entity registry (PF3-01): findByName, findByAlias, resolveOrCreateEntity (with ambiguity surface), addAliases. Optional service — `null` on legacy vaults that pre-date the Entities DB. `merge` was scoped out of PF3-01 because it requires a `FactService.repointEntity` helper that hasn't landed yet. |
| `entity-migration.ts` | `buildEntities()` | One-shot pass that groups every fact's Subject/Object strings by normalized key, picks longest-form canonical, and re-points each fact's `SubjectEntity`/`ObjectEntity` relation. Plan-then-execute via `lore migrate --build-entities --yes`. |
| `context.ts`  | `resolveProject()` | Match cwd to a project via longest prefix                  |
| `wakeup.ts`   | `loadWakeUpData()` | Aggregate digest + memories + facts + decisions + open-loop-related memories for wake-up surfaces (MCP tool + shell hook) |
| `cache.ts`    | `LruCache<K, V>`   | Minimal in-process LRU + TTL used by name→id resolvers     |
| `fact-encoding.ts`   | `fixFactEncoding()`   | `lore migrate --fix-fact-encoding` — decode Subject/Object + recompute DedupKey, gated by post-decode collisions |
| `memory-encoding.ts` | `fixMemoryEncoding()` | `lore migrate --fix-memory-encoding` — decode Title + body markdown; skips archived and body >100 KB |
| `agent-normalization.ts` | `normalizeAgents()` | `lore migrate --normalize-agents` — collapse fragmented `Agent` strings onto their canonical form (PF3-02) |
| `similarity.ts` | `titleTrigrams`, `trigramJaccard`, `tagOverlap` | Pure helpers for the write-path near-duplicate probe |
| `near-duplicate.ts` | `findNearDuplicates()` | Advisory probe used by `lore-remember` / `lore-decide` to surface similar rows |

## Service Class Pattern

All services follow the same constructor pattern:

```typescript
export class FooService {
  constructor(
    private client: Client, // @notionhq/client instance
    private databaseId: string // Notion database ID for this entity
  ) {}
}
```

Services are instantiated in `src/services.ts` via `initServices()`, which loads
the vault, reads database IDs, and creates all service instances.

**Rule**: Services should not instantiate other services. Cross-service calls
happen at the interface layer (MCP tools, CLI commands). Two exceptions compose
multiple services via dependency injection:

- `resolveProject()` takes a `ProjectService` parameter.
- `loadWakeUpData()` accepts a structural `WakeUpServices` (`{ memories, facts }`)
  so both the real `LoreServices` and lightweight test stubs satisfy it.

Prefer this "free-function orchestrator over injected services" shape when the
logic is coordination-only (no stored state, no Notion client ownership).

## Context Resolution

`context.ts` exports `resolveProject()`, which determines the active project
from the working directory. The algorithm:

1. Compute the relative path from the config root (directory containing
   `.lore.yaml`) to the current working directory.
2. If cwd is outside the config root (relative path starts with `..`), return
   `{ project: null, isCatchAllFallback: false }`.
3. Iterate over projects defined in `.lore.yaml`. For each, check if the
   project's `path` is a prefix of the relative path. A project with path
   `"."` or `""` is a **catch-all** — it matches every cwd inside the config
   root with length 0, so any sub-project prefix wins over it.
4. Select the project with the **longest matching prefix** (most specific match).
5. Look up the matched project in Notion by path first, then by name.

This supports monorepo layouts where projects map to subdirectories.

**Return shape**: `resolveProject()` returns `ProjectResolution`, not a bare
`Project | null`. Callers that care about scope accuracy read
`isCatchAllFallback` to detect when the auto-resolved project is the monorepo
catch-all, so they can surface a warning or prompt for explicit selection.
`candidates` holds the non-catch-all project names from the config for use in
those warnings. Two helpers expose these concepts independently:

- `isCatchAllProject(project)` — structural check on a single config entry.
- `subProjectNames(config)` / `catchAllProjectName(config)` — read directly
  from config without walking cwd.

The MCP save layer (`src/mcp/resolve.ts`) uses the cached
`services.context.isCatchAllFallback` flag to add a warning to any save that
falls back to the catch-all without an explicit `projectName`. Hook-local
prompt construction (`src/hooks/helpers.ts`) re-derives sub-projects from the
config without API calls for the same purpose.

## Memory Content Storage

Memory content is stored as Notion page body using the markdown API, not as a
page property. The workflow:

1. **Create**: `pages.create()` with properties only, then `pages.updateMarkdown()`
   with `type: "insert_content"` to write the body.
2. **Read**: `pages.retrieveMarkdown()` returns `{ markdown: string }`.
3. **Update**: `pages.updateMarkdown()` with `type: "replace_content_range"` and
   `content_range: "full_page"`.

This keeps the database properties lightweight (metadata only) while page bodies
hold arbitrarily large content.

## Memory Search

`MemoryService.search()` switches on `input.mode` (default `"hybrid"`)
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
- Kind / Status: server-side `select.equals`.
- Text clause: `(Title contains query) OR (Keywords contains query)`.

**Empty / whitespace-only queries skip the text clause** — `contains: ""`
matches every row in Notion, which would degenerate the query into "every
page in the DS." Skipping the clause lets the surrounding property filters
drive the result set, giving the caller a recency-ordered listing under
their other filters. Sort is `last_edited_time desc`; `page_size` is the
caller's `limit` (max 100).

Body matches are **not** searched here — `dataSources.query` only filters
on properties. Callers that need body relevance should use `"semantic"`
or rely on the hybrid fallback below.

### `mode: "semantic"` (workspace-wide, vector-ranked)

The legacy path. Uses `client.search()` for relevance ranking against page
titles AND bodies. Results are post-filtered to the Memories DS — matching
either `parent.type === "database_id"` against `db.databaseId` **or**
`parent.type === "data_source_id"` against `db.dataSourceId`. Notion SDK
v5 returns both shapes in the wild depending on when and how the page was
created; accepting only `database_id` silently filters out every real
result from a data-source-backed workspace.

Property filters (`projectId` / `topicId` / `tags` / `kind` / `status`)
all post-filter client-side because `client.search` has no property-filter
support.

**Do not pass a `sort` parameter to `client.search()`.** Notion's `search`
endpoint returns results ranked by relevance when no `sort` is provided.
Passing a `sort` switches to recency ordering and demotes the query to a
lexical filter — which defeats the whole purpose of semantic search. We
fetch `page_size: 100` instead so the post-filter to the Memories DS has
headroom when the workspace contains unrelated pages matching the query
tokens.

### `mode: "hybrid"` (default)

Speculative parallelism. `searchByHybridPages` fires `searchByContainsPages`
and `searchBySemanticPages` concurrently via `Promise.allSettled`. Once
both settle:

- **Saturating case** (`containsPages.length >= HYBRID_FALLBACK_THRESHOLD`,
  default 3): the contains rows alone become the result. The parallel
  semantic call is discarded — wasted bandwidth, but no wall-clock cost
  since `Promise.allSettled` resolves at `max(contains_latency, semantic_latency)`,
  which is the same as a pre-PR semantic-only call.
- **Under-shooting case**: contains rows come first, then unique semantic
  rows are concatenated until `limit` is filled. Dedup is by page id;
  contains wins ties because precision-ranked hits should beat workspace
  ranking when both surface the same row.
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

  **Log-format divergence from `mcp/helpers.ts:debugLogPartialFailures`.**
  Both helpers share the `[lore] partial-failure:` prefix and the
  `error=` field — that is the stable contract for `grep`-based
  log aggregation. The key names diverge: hybrid search uses
  `branch=<contains|semantic>` and `source=hybrid-search` because
  a hybrid branch isn't a Notion root id, and `tool=hybrid-search`
  would be misleading (hybrid search is a core-service path, not
  an MCP tool). Downstream parsers should match on the prefix and
  the `error=` field; per-surface key names are intentionally
  scoped to their surface.

The earlier sequential design (run contains, then run semantic if it
under-shot) traded latency *against* itself in the under-shooting case,
which is the *common* case for phrase-shaped queries. Parallelism
restores the pre-PR worst-case wall-clock while keeping the precision
of contains when it produces enough signal. Switching from `Promise.all`
to `Promise.allSettled` preserves the wall-clock guarantee while
decoupling the failure domains — the kill switch
(`LORE_FORCE_SEMANTIC_SEARCH=1`) remains the manual rollback for
sustained problems; this guard is the automatic one for transient ones.

Three is a tradeoff: small enough that a niche query with one or two
title hits still gets the benefit of body-relevance ranking, large enough
that the common case (a caller searching a specific PR number, file
name, or function) skips merging with semantic. If the threshold ever
needs tuning, change the `HYBRID_FALLBACK_THRESHOLD` constant in
`memory.ts` — it's exported so callers can reference it in their own
diagnostics.

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

### Kill switch: `LORE_FORCE_SEMANTIC_SEARCH=1`

Operator escape hatch checked inside `search()`. When set, every search
routes through the legacy workspace-wide path regardless of the caller's
`mode`. Use as a rollback if the contains path silently under-recalls in
a vault that hasn't run `lore migrate --fix-memory-encoding` yet —
encoded titles miss substring matches against post-decode queries
(see P2-10). Same posture as `LORE_DISABLE_NEAR_DUPLICATE_PROBE`: an
opt-in defensive lever, not a default.

The `list()` method uses `dataSources.query()` with property filters and is
suited for browsing recent memories by project/topic/source. It has no
substring-title filter — use `search()` for anything that needs relevance
ranking or body-text matching (e.g. `loadWakeUpData`'s related-memories pass,
which seeds a single query from open-loop fact subjects and objects).

## Fact Invalidation

Facts are never deleted. To mark a fact as no longer true:

```typescript
await factService.invalidate(factId)
```

This sets the `Valid Until` property to today's date. Default queries exclude
facts where `Valid Until` is set (the `is_empty` filter).

To include invalidated facts in a query, pass `includeInvalidated: true`:

```typescript
const allFacts = await factService.queryBySubject("AuthService", {
  projectId,
  includeInvalidated: true,
})
```

**Rule**: Never use `pages.update({ archived: true })` on facts. Archiving
removes the page from all queries. Invalidation preserves historical record.

## Fact Queries

The `FactService` exposes two families of reads: targeted retrieval
(paginates as needed) and hot-path listing (single page, returns saturation
signal). All methods exclude invalidated facts by default.

### Retrieval (paginating)

| Method                          | Behavior                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `queryBySubject(subject, opts)` | Finds facts where `Subject` title contains the string; paginates until exhausted or `limit` is reached |
| `queryByObject(object, opts)`   | Same shape as `queryBySubject` but matches the `Object` rich-text property     |
| `queryBySourceMemory(id, opts)` | Finds facts whose `Source` relation points at a given memory page              |
| `queryByEntity(entity, opts)`   | Finds facts where the entity appears as either Subject or Object, deduplicates |
| `queryOrphans(opts)`            | Returns current facts whose `Source` relation is empty. Used by `lore migrate --backfill-fact-sources` |

### Hot-path listing (single page)

| Method                          | Behavior                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `listRecent(opts)`              | Single-page, server-filtered `created_time desc`. Returns `{ items, hasMore }` so callers can detect truncation without a second round-trip. Accepts `excludePredicates` for partitioning reads (see below). |

### Writes on existing facts

| Method                           | Behavior                                           |
| -------------------------------- | -------------------------------------------------- |
| `extendReview(id, reviewBy)`     | Push forward the `Review By` date                  |
| `invalidate(id)`                 | Mark no-longer-true (sets `Valid Until` = today)   |
| `setSource(id, sourceMemoryId)`  | Overwrite the `Source` relation with one memory    |

### Two-path pattern for partitioned reads

When a caller needs to split facts into disjoint buckets (e.g. wake-up
separating `TRACKING_PREDICATES` from knowledge facts), fire **two targeted
queries in parallel** rather than one full-scan followed by a client-side
partition:

- Tracking side: `queryBySubject("", { projectId, predicates: TRACKING_PREDICATES, limit: 100 })`
- Knowledge side: `listRecent({ projectId, excludePredicates: TRACKING_PREDICATES, limit: N })`

Both queries run server-side against Notion's `select` filter (the knowledge
side uses `AND (Predicate does_not_equal ...)` per tracking predicate). This
replaced the earlier `queryBySubject("")` full-scan in `loadWakeUpData`,
which paginated the entire project fact table on every hook fire just to
populate two bounded sections.

## Entity Resolution and the SubjectKey / SubjectEntity coexistence (PF3-01)

The Facts DB carries two parallel canonicalization columns by design:

| Column | Type | Role |
|---|---|---|
| `SubjectKey` | rich_text | Lowercased + NFC + whitespace-collapsed + trailing-punct-stripped form of `Subject`. Populated by `FactService.create` and the `--dedup-keys` migration. Backs the substring-fallback path in `queryBySubject` / `listTracking` for vaults that haven't run `--build-entities`. |
| `SubjectEntity` / `ObjectEntity` | relation → Entities | Canonical entity row IDs. Populated by `lore-fact action='create'` after `EntityService.resolveOrCreateEntity` and by the `--build-entities` migration. Backs `queryByEntityId` for vaults that have. |

Why both columns coexist for one release cycle:

1. **Transition-window recall.** `queryByEntity` runs both paths in
   parallel when `entityId` resolves: the relation hit + the substring
   hit on rows whose entity relations are still empty (i.e. rows
   `--build-entities` hasn't re-pointed yet). Dropping `SubjectKey`
   immediately would silently lose every un-backfilled row from
   `lore-ask` results.
2. **Safety net for PF3-01 bugs.** If the entity-resolution path
   surfaces a regression in production, operators can flip back to the
   substring path by archiving the Entities DB. The fallback only
   works while `SubjectKey` is still populated on every fact.
3. **Spec carve-out.** The PF3-01 spec explicitly says "Keep the
   column for one release cycle as a safety net, then drop in a
   follow-on cleanup." A separate issue tracks `SubjectKey` removal.

Read paths must therefore handle three vault states: pre-PF3-01 (no
Entities DB, `SubjectKey` only), mid-migration (Entities DB exists but
not every fact has been re-pointed, both paths needed), and
post-migration (every live fact has relations, but the safety net
hasn't been removed yet). `queryByEntity`'s union semantics cover all
three; `pageToFact` populates `subjectEntityId`/`objectEntityId` from
the relation column when present and falls through to `null` otherwise.

### Measuring whether `--build-entities` collapsed the orphan graph

The PF3-01 spec's flagship acceptance criterion is "post-migration,
the orphan-rate metric (`subjects appearing in exactly 1 fact`) drops
from 79.6% to <50% on the Mail vault." The migration ships with
case-folding-only canonical clustering — `computeSubjectKey` collapses
case/whitespace/trailing-punct variants but does NOT recognize that
`MemoryService.create` is a richer-handle variant of `MemoryService`
or that `PR #25705 (SENTRY-MAIL-IOS-2E3)` is metadata-tagged onto the
same `PR #25705` entity. The next contributor evaluating whether to
ship a richer canonical clusterer needs to be able to compute this
metric without re-deriving the methodology.

**How to compute the metric** post-migration:

1. Snapshot every live fact:
   `dataSources.query` against the Facts DS, filter `Valid Until is_empty`,
   paginate to exhaustion. Project-scoped or vault-wide depending on
   what the spec criterion measures (Mail vault is project-scoped).
2. Group by canonical entity. The post-migration row's
   `SubjectEntity` relation IS the canonical key — empty relations
   mean the row hasn't been re-pointed (either pre-migration or a
   transient migration miss). For the metric, **count rows by
   `SubjectEntity[0]?.id ?? computeSubjectKey(Subject)`** so
   un-migrated rows still cluster by their case-folded form.
3. Compute `1 - groups_with_count >= 2 / total_groups`. The
   numerator is groups with at least one peer; the denominator is
   total distinct entities/keys. Pre-PF3-01 baseline on the Mail vault
   was 79.6% (560 facts → ~445 distinct subjects → ~89 had a peer).

The measurement script lives in spirit in
`src/cli/commands/migrate.ts:runBuildEntitiesMigration` — the
`factCount` field on each `EntityGroupPlan` is the raw input. A
follow-up that wires the metric into `lore status` (or a dedicated
`lore migrate --build-entities --report-orphan-rate`) would close the
measurability gap; until then operators run the numbers manually
against the `groupCount` / `factsRepointed` output of a `--dry-run`
pass.

If the metric stays above 50% on a real vault after `--yes`, the case-
folding pass alone wasn't enough — the richer-vs-bare clusterer becomes
load-bearing and the spec's deferred follow-up needs to land. If the
metric drops below 50%, case-folding was sufficient and the deferred
clusterer can be skipped or scoped down to operator-curated alias
merges via `EntityService.addAliases`.

## Fact Write-Side Dedup

`FactService.create()` and `createWithDedup()` both probe the `DedupKey`
column before writing. The key is a SHA-256 hash over
`normalize(subject) ␟ predicate ␟ normalize(object)` — see
`src/notion/normalize.ts`. Normalization folds case, whitespace, trailing
sentence-terminator punctuation, and Unicode NFC so cosmetic variants
resolve to one row. Hashing keeps the stored key at 64 chars regardless
of triple length, sidestepping Notion's 2000-char `rich_text` truncation.

- **Live match** → merge incoming metadata onto the existing row:
  - Extend `Review By` when the new request has a later date.
  - Union `projectIds` into `Project` (cross-project facts accumulate).
  - Link `sourceMemoryId` into `Source` only when the existing row is
    orphaned (first-writer-wins — does not clobber an earlier provenance
    link).
  All applicable mutations ship as a single atomic `pages.update` —
  Notion's API is per-request atomic, so either every mutated property
  lands or none does. A zero-mutation match (everything already present)
  issues no update at all.

  Returns `{ deduped: true, enriched: [...] }` where `enriched` names the
  fields that were mutated. An empty `enriched` array means the probe
  matched but nothing new was added — callers should render "matched,
  no-op" instead of implying a write.
- **Invalidated match** (`Valid Until` set) → deliberately ignored; the
  caller writes a fresh live row so history stays intact when a triple is
  re-asserted after correction.
- **Probe failure** → fall through to blind create with a once-per-process
  stderr warning (pre-migration vaults or transient Notion errors don't
  spam stderr on every autosave). The next
  `lore migrate --dedup-keys --merge` collapses the duplicate.

**Concurrency**: Notion has no unique index or conditional-write primitive.
Two callers racing on the same triple (cross-process, or intra-process
back-to-back autosaves — Notion's query index is eventually consistent by
a few hundred ms) can both see an empty probe. The
`lore migrate --dedup-keys --merge` pass is the authoritative collapse for
any duplicates that slip through. The pass prints the survivor/loser plan
by default; `--yes` is required to execute.

**Rule**: Callers that need to tell the user "this was a dedup, not a new
row" (e.g. `lore-learn`) should use `createWithDedup()` and inspect the
`deduped` and `enriched` fields. `create()` is preserved for callers that
don't care (decision-graph reachability sync, `decided_by` auto-links).

## HTML-entity Decode Migrations

The autosave path occasionally delivers plain-text fields with HTML
entities already escaped (`Foo &amp;amp; Bar`). Every write-boundary now
decodes via `decodeTextEntities` (`src/notion/html-entities.ts`), but rows
written before that guard shipped still carry encoded payloads. Three
`lore migrate` flags decode pre-existing rows in place — all idempotent,
all support `--dry-run`:

| Flag | Target | Module | Apply mode |
| ---- | ------ | ------ | ---------- |
| `--fix-topic-encoding` | Topics.Name | `topic-merge.ts:fixTopicEncoding` | Applies unless `--dry-run`. Pair with `--merge-duplicate-topics` when cross-encoding pairs would collide post-decode. |
| `--fix-fact-encoding`  | Facts.Subject + .Object + .DedupKey | `fact-encoding.ts:fixFactEncoding` | **Plan-only by default; `--yes` applies.** Collision-gated against post-decode dedup-key conflicts — see below. |
| `--fix-memory-encoding` | Memories.Title + body markdown | `memory-encoding.ts:fixMemoryEncoding` | **Plan-only by default; `--yes` applies.** Skips archived memories; skips body rewrite (Title still fixed) when body exceeds `BODY_SIZE_CAP_BYTES` (100 KB). |

The plan-then-execute posture on the fact and memory flags matches
`--dedup-keys --merge --yes`: both rewrite historical rows at larger blast
radius than the topic-name rename, and the dedup-key recomputation in the
fact path means a misapplied run can't be un-done by re-running. Bare
`lore migrate --fix-fact-encoding` prints the plan and exits; the operator
re-runs with `--yes` once they've reviewed the collision report.

Fact encoding is the subtle one. Decoding `Subject`/`Object` changes the
dedup key, so the rewrite path must recompute `DedupKey` in the same
`pages.update` atom as the Subject/Object write. Otherwise a future
`lore-learn` with the already-decoded input misses the probe and creates
a fresh duplicate.

**Collision gate**. Before any Fact rewrite lands,
`findPostDecodeFactCollisions` groups every live row by its post-decode
dedup key. If a group has ≥2 rows — the cross-encoding case, where a
clean row and an encoded sibling would end up on the same key — `every`
member of the group is gated: the migration refuses to rewrite them and
directs the operator to resolve via `lore migrate --dedup-keys --merge
--yes` first. This mirrors the posture `VaultManager.migrate` established
for `--fix-topic-encoding` / `--merge-duplicate-topics`.

Ordering vs. downstream work: land encoding migrations before P2-03
(near-duplicate memory / decision detection), P3-03 (entity
canonicalization), and P3-04 (DS-scoped memory search). Those features
compare plain-text values, so an encoded Title inflates trigram distance
and silently suppresses duplicate detection.

## Agent Identity Canonicalization (PF3-02)

Memory `Agent` is a free-form `rich_text` column populated by
`deriveAgentName` in `src/hooks/helpers.ts`. Default detection produced
seven different spellings of the same Claude Code instance in the
production Mail vault (`Claude Code`, `claude-code`, `Claude Opus 4.7
(1M context)`, `Claude Code (Opus 4.7)`, `claude-opus-4.7`,
`claude-opus-4-7`, `claude-code-opus-4-7` — see PF3-02), fragmenting
per-agent grouping, retention queries, and dashboards across multiple
buckets per actually-distinct agent. The bare-version cousin
`Claude Opus 4.7` (no parenthetical) is pinned in
`agent-identity.test.ts` as the eighth — the regex grammar covers it,
so passing it through unchanged would re-fragment by one more spelling.

`canonicalizeAgentName` (`src/hooks/agent-identity.ts`) is the single
canonical-table source. It normalizes whitespace + hyphen separators to
spaces, lowercases for matching, and applies a structured Claude variant
regex. Match → `"Claude Code"`. No match → input passed through verbatim.
Idempotent.

The closed-table approach is intentional. The `LORE_AGENT_NAME` env
override (PF1-04) is the explicit-over-inferred path for third-party
integrators (Codex, Cline, Cursor, Aider). Their names don't match the
Claude regex and pass through unchanged, preserving attribution. Only add
to the canonical table when a new *default-detection* variant appears in
the wild — i.e., another Claude string we ourselves produce.

Two ingest points:

- **Write-time** in `deriveAgentName`: both the override path and the
  Claude-marker inference path route their result through
  `canonicalizeAgentName` so newly-saved memories never re-fragment.
- **Backfill** via `lore migrate --normalize-agents`
  (`agent-normalization.ts:normalizeAgents`): scans every non-archived
  memory, rewrites rows whose stored Agent differs from its canonical
  form via `pages.update` on the `Agent` rich_text column. Plan-only by
  default; `--yes` applies. Idempotent; a second run finds zero rows.

**Agent column scope**: This canonicalization stops at the Agent string.
The version-suffix variants (`Claude Opus 4.7`) are deliberately collapsed
without a separate `Model` column — every observed variant resolves
cleanly to `Claude Code`, and a future query like "memories from Opus 4.7
sessions" can be served from `Keywords` until a real consumer demands it
(YAGNI). Resist the urge to add a `Model` field, an `Agent` enum, or a
separate Agents DB row in this issue.

**Future model families**: The regex closes around `code` and `opus`-versioned
spellings only. When Anthropic ships a Claude family Claude Code routes to
(Sonnet, Haiku, three-component versions like `4.7.1`), autosave starts
producing strings the regex *intentionally* leaves unchanged — re-fragmenting
the Agent column. The extension recipe lives next to the regex in
`src/hooks/agent-identity.ts` (the JSDoc on `CLAUDE_VARIANTS`), with
companion no-match tests in `agent-identity.test.ts:future-families` that
have to be flipped in lockstep.

## Decision Service

`DecisionService` wraps the decision-specific read/write paths in the Memories
DB — pages where `Kind = decision`. It uses the same `DatabaseRef` as
`MemoryService` (they share the Memories DB) but exposes decision-flavored
methods. Pattern:

```typescript
const decisions = new DecisionService(client, db.memories)
```

Key behaviors:

- `create()` always sets `Kind = decision`, defaults `Status = accepted` and
  `Decided At = today` unless the caller overrides.
- `list()` and `queryOverdue()` skip markdown body fetches, returning
  `DecisionSummary[]` — O(1) API calls regardless of result count.
- `supersede(newId, oldId)` writes in a deliberate order: the new decision's
  `Supersedes` relation first, then the old decision's `Status = superseded`.
  If the second write fails, the system is in "new points at old; old still
  accepted" — a visible, re-runnable inconsistency. Reverse ordering would
  orphan the old decision as superseded with no successor. Do not change the
  order.
- `getDecisionChain()` uses a visited-set guard to terminate on cycles (a
  bidirectional supersession would otherwise loop forever).

**Rule**: `DecisionService` only writes to the Memories DB. It never creates
facts. The `decided_by` and `supersedes_decision` graph edges are created at
the MCP tool layer (`src/mcp/tools/decisions.ts`) where the tool handler
orchestrates `decisions` + `facts` together — consistent with how
`lore-remember` orchestrates `topics` + `memories`.

## Resolver Caching

The MCP server is a long-lived stdio process that frequently resolves the
same `projectName` or `topicName` across multiple tool calls in a single
conversation. `src/core/cache.ts` provides `LruCache<K, V>`, a minimal
LRU + TTL cache; four resolvers use it — three migrated to `getOrLoad`
and one that deliberately opted out (see notes below the table):

| Resolver                        | Keyed on    | TTL  | Cap |
| ------------------------------- | ----------- | ---- | --- |
| `ProjectService.findByName`     | name        | 60s  | 200 |
| `TopicService.findByName`       | name¹       | 60s  | 500 |
| `MemoryService.getTitleById`    | memory id²  | 60s  | 500 |
| `DecisionService.getById`       | decision id | 30s  | 500 |

¹ Only unscoped (no `projectId`) lookups are cached. The scoped variant is
a legacy-vault safety valve with different result shape, and by design
scoped concurrent callers each issue their own query.

² Covers `Kind = decision` pages too — both live in the Memories DB and
`render.ts:resolveTitles` resolves labels for either via this one pool.

**Cached values are not cache hazards.** Negative lookups (null) are never
cached, and throws are never cached — only successful resolutions. Writes
invalidate:

**Stampede-safe via `LruCache.getOrLoad`.** `ProjectService.findByName`,
`TopicService.findByName`, and `DecisionService.getById` route their
Notion fetch through `cache.getOrLoad(key, loader)` rather than the
classic `cache.get(key) ?? fetch()` pattern, so concurrent cold-start
callers converging on the same key — `Promise.all` fan-outs in
`resolveCanonicalDecisionLinks`, parallel autosaves resolving the same
`topicName`, BFS walks hitting a shared ancestor — collapse onto a
single Notion call. `getOrLoad` keeps a `Map<K, Promise<V | null>>` of
in-flight loads keyed by cache key; the second concurrent miss finds the
pending promise and awaits the same underlying Notion call instead of
racing on its own loader. Rejected loaders clear the pending slot so the
next caller retries rather than observing a poisoned miss.

`MemoryService.getTitleById` is the one resolver that does **not** use
`getOrLoad`. Its title cache stores `null` tombstones for not-found /
permission-denied pages so the caller can skip the retry without
pessimising the hot path — and `getOrLoad`'s contract explicitly refuses
to commit `null` to the store. If `LruCache` ever grows a
`cacheNegatives: true` option, fold `titleCache` onto the shared
primitive as part of that work.

**Invalidation reaches the pending map.** `cache.delete(key)` and
`cache.clear()` drop both the stored value AND any in-flight `getOrLoad`
pending slot, and `getOrLoad`'s loader uses a promise-identity guard so
a stale in-flight read cannot commit back to the cache after an
intervening invalidation. This is what makes the
`delete(key); await getById(key)` write-then-read pattern in
`TopicService.getOrCreate` and `DecisionService.supersede` safe under
concurrent readers — a parallel `findByName` or `getById` in flight at
the moment of invalidation no longer poisons the writer's merge base.

- `ProjectService.create` invalidates by name; `archive` clears the whole
  name cache (archive flips `status` on cached objects and we don't track
  the id → name reverse mapping).
- `TopicService.create` invalidates by name; `getOrCreate` proactively
  `set`s the post-extend refetched topic so subsequent lookups see the
  authoritative relation.
- `MemoryService.update` evicts the id's title cache entry *before* the
  write so a concurrent `getTitleById` can't re-cache the stale title.
  `archive` also evicts so a follow-up read returns `null`, not the
  last-known-good title.
- `DecisionService.create` / `supersede` / `reviewCompleted` invalidate
  the affected ids.

**Create paths evict; `getOrCreate` writes through — deliberate asymmetry.**
`create` returns a freshly-minted page that the caller doesn't look up
by name next; evicting is enough. `getOrCreate` has just refetched the
authoritative post-extend state as part of its retry loop, so writing
that value through to the cache costs nothing and skips a Notion
round-trip for the next `findByName`. Do not "normalize" the create
paths to write-through — they don't have the refetched value in hand.

**Do not cache `MemoryService.getById`.** Memory bodies can be updated via
`lore-update` from any tool; a stale body is a real correctness hazard,
not just a latency one.

Tests call `clearServiceCaches(services)` in `src/services.ts` to
force-fresh between fixtures. Production code never calls it — TTLs do
the work.

## Near-Duplicate Probe

`findNearDuplicates()` in `near-duplicate.ts` is the write-path sibling of
`FactService.createWithDedup`: advisory, not blocking. The tool layer
(`src/mcp/tools/memory.ts`, `src/mcp/tools/decisions.ts`) runs it in
parallel with the create so the probe does not add wall-clock latency,
then surfaces any similar rows in the response footer. A failed probe
returns `[]` rather than throwing — probe failures must never fail the
surrounding save.

Scoping rules:

- **Memory path** (`lore-remember`): project + top-2 tags, trigram
  threshold `0.7`, `excludeKinds: ["decision"]` so decisions surface
  only through `lore-decide` and the response stays focused on
  `lore-update` as the corrective action. Deliberately **does not**
  narrow by `kind` — the P2-03 spec's motivating duplicate chain
  spans `note` / `note` / `agent_diary`, which a server-side `kind`
  filter would mask.
- **Decision path** (`lore-decide`): project + (topic if resolved) +
  `Kind = decision`, client-side status filter to `accepted` /
  `proposed`, trigram threshold `0.6`. Superseded / deprecated /
  rejected decisions are deliberately excluded — they are not valid
  supersession targets.

**`kind` and `excludeKinds` are mutually exclusive by design.** The
memory path sets `excludeKinds: ["decision"]` (client-side filter),
the decision path sets `kind: "decision"` (server-side narrowing).
A probe that sets both would apply a server-side filter *and then*
a client-side filter, which is either redundant (same kind) or
self-contradicting (kind included then excluded). Call sites pick
one axis.

**Untopiced decisions fall back to project-only scope.** The spec rule
is "same-project AND same-topic", but when the caller omits `topicName`
the probe runs with `topicId: undefined` and scopes to project alone.
Looser than spec, intentional: an untopiced decision still benefits
from a near-dup warning against project-wide siblings, and tightening
would gate the probe off on every toolless-topicName call.

The probe post-filters the just-written row in the tool layer
(`m.id !== created.id`) to close the eventual-consistency race between
`pages.create` and the query index. Thresholds are the P2-03 spec's
initial guesses; tune after rollout.

**Effective-pool shrink under `excludeKinds`.** The filter runs
client-side after `memories.list({ limit: 50 })`. In a decision-heavy
project, the usable non-decision slice of the 50-row window is
`50 − (decisions in the top-50 recent memories + tags)`. Notion's
`select` filter has no `not-equals` primitive, so this is unavoidable
without a second query. If probe recall dips, bump
`NEAR_DUPLICATE_POOL_LIMIT` rather than chasing a two-query design.

**Untagged saves broaden the candidate pool.** The list-query's `tags`
filter is Notion-side `OR` across values. When the caller passes no
tags, the probe drops the tag filter entirely and scans up to 50 rows
in the project by recency — still bounded, but more likely to produce
false positives than a tag-scoped probe. If this becomes noisy, the
fix is to either lower the pool limit or require at least one tag
before probing; don't narrow the tag filter to `AND` semantics, which
would under-shoot the candidate pool on the other side.

**HTML-entity decode inside the trigram pipeline is load-bearing.**
`similarity.ts:normalizeTitle` runs `decodeTextEntities` before
lowercasing / NFC / whitespace-collapse so pre-PF1-06 encoded rows
(still present in un-migrated vaults) match post-PF1-06 decoded
writes. Moving the decode out of the pipeline, or onto the call sites,
reopens the silent-miss case where `"Café &amp;amp; Bar"` and
`"Café & Bar"` fail to cluster.

Probe failures flow through an `onError` callback which both tool
handlers route to `debugLogPartialFailures` — probe failures become
visible under `LORE_DEBUG=1` without adding noise to the default
stderr stream.

**Kill-switch.** `LORE_DISABLE_NEAR_DUPLICATE_PROBE=1` skips the
probe entirely. Use for bulk-import, fixture setup, or autosave
flows where the per-save round-trip isn't justified. The bypass
lives inside `findNearDuplicates`, not per-tool, so both write tools
honor it without duplicate plumbing.

## Schema Drift Detection

`VaultManager.load()` fires a non-blocking `detectDrift()` check that runs the
same diff logic as `lore migrate` but read-only. If drift is found, a stderr
warning is emitted nudging the user to run `lore migrate`. Failures in the
check are silently swallowed — the vault still loads. Reads on drifted vaults
keep working via extractor fallbacks; writes that need missing properties
fail at the Notion API with a 400.

## Extractors Dependency

All services import property extractors from `src/notion/extractors.ts`. The
private `pageToFoo()` methods on each service convert a `PageObjectResponse`
into a domain type using these extractors.

| Service          | Converter         | Domain type |
| ---------------- | ----------------- | ----------- |
| `ProjectService` | `pageToProject()` | `Project`   |
| `TopicService`   | `pageToTopic()`   | `Topic`     |
| `MemoryService`  | `pageToMemory()` (module-level exported) | `Memory`    |
| `FactService`    | `pageToFact()`    | `Fact`      |
| `DecisionService` | uses `pageToMemory()` + type-narrowing cast | `Decision` |
| `FactService`    | `pageToFact()`    | `Fact`      |

**Rule**: If you add a new database property, you must:

1. Add the property config in `schema.ts`
2. Add extraction logic using an extractor from `extractors.ts`
3. Update the domain type in `types.ts`
4. Update the `pageToFoo()` converter in the relevant service
