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
| `wakeup.ts`   | `loadWakeUpData()` | Aggregate digest + memories + facts for wake-up surfaces (MCP tool + shell hook) |

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

- Only include pages from the Memories database (by checking `parent.database_id`)
- Optionally filter by project, topic, or tags

The `list()` method uses `dataSources.query()` with property filters and is
suited for browsing recent memories by project/topic/source.

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

The `FactService` provides two query methods:

| Method                          | Behavior                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `queryBySubject(subject, opts)` | Finds facts where `Subject` title contains the string                          |
| `queryByEntity(entity, opts)`   | Finds facts where the entity appears as either Subject or Object, deduplicates |

Both methods exclude invalidated facts by default.

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
