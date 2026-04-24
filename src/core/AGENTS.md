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
| `context.ts`  | `resolveProject()` | Match cwd to a project via longest prefix                  |
| `wakeup.ts`   | `loadWakeUpData()` | Aggregate digest + memories + facts + decisions + open-loop-related memories for wake-up surfaces (MCP tool + shell hook) |
| `cache.ts`    | `LruCache<K, V>`   | Minimal in-process LRU + TTL used by name→id resolvers     |

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

`MemoryService.search()` uses Notion's built-in search API (`client.search()`),
which includes vector similarity matching on page content. Results are
post-filtered to:

- Only include pages from the Memories database — matching either
  `parent.type === "database_id"` against `db.databaseId` **or**
  `parent.type === "data_source_id"` against `db.dataSourceId`. Notion SDK
  v5 returns both shapes in the wild depending on when and how the page
  was created; accepting only `database_id` silently filters out every
  real result from a data-source-backed workspace.
- Optionally filter by project, topic, or tags.

**Do not pass a `sort` parameter to `client.search()`.** Notion's `search`
endpoint returns results ranked by relevance when no `sort` is provided.
Passing a `sort` switches to recency ordering and demotes the query to a
lexical filter — which defeats the whole purpose of semantic search. We fetch
`page_size: 100` instead so the client-side parent-DB filter has headroom when
the workspace contains unrelated pages matching the query tokens.

The `search()` input supports `includeContent: false` to skip the per-page
`retrieveMarkdown` round-trip. Use it when the caller renders only title /
date / tags (e.g. the shell wake-up hook's related-memories section).

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
