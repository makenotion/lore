# AGENTS.md -- src/core/

> Read the root `AGENTS.md` first. This file covers the domain logic layer only.

## Purpose

This directory contains Lore's business logic: CRUD operations for each entity
type, context resolution, and vault management. These services sit between the
interfaces (MCP, CLI, hooks) and the Notion SDK layer (`src/notion/`).

## Files

| File         | Class/Function     | Responsibility                                 |
| ------------ | ------------------ | ---------------------------------------------- |
| `vault.ts`   | `VaultManager`     | Init/load vault, get database IDs, count stats |
| `project.ts` | `ProjectService`   | CRUD for projects, findByPath, findByName      |
| `topic.ts`   | `TopicService`     | CRUD for topics, getOrCreate, listByProject    |
| `memory.ts`  | `MemoryService`    | CRUD + list + semantic search for memories     |
| `fact.ts`    | `FactService`      | Knowledge graph triples with temporal validity |
| `context.ts` | `resolveProject()` | Match cwd to a project via longest prefix      |
| `wakeup.ts`  | `loadWakeUpData()` | Aggregate digest + memories + facts for wake-up surfaces (MCP tool + shell hook) |

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
   `null`.
3. Iterate over projects defined in `.lore.yaml`. For each, check if the
   project's `path` is a prefix of the relative path.
4. Select the project with the **longest matching prefix** (most specific match).
5. Look up the matched project in Notion by path first, then by name.

This supports monorepo layouts where projects map to subdirectories.

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

## Extractors Dependency

All services import property extractors from `src/notion/extractors.ts`. The
private `pageToFoo()` methods on each service convert a `PageObjectResponse`
into a domain type using these extractors.

| Service          | Converter         | Domain type |
| ---------------- | ----------------- | ----------- |
| `ProjectService` | `pageToProject()` | `Project`   |
| `TopicService`   | `pageToTopic()`   | `Topic`     |
| `MemoryService`  | `pageToMemory()`  | `Memory`    |
| `FactService`    | `pageToFact()`    | `Fact`      |

**Rule**: If you add a new database property, you must:

1. Add the property config in `schema.ts`
2. Add extraction logic using an extractor from `extractors.ts`
3. Update the domain type in `types.ts`
4. Update the `pageToFoo()` converter in the relevant service
