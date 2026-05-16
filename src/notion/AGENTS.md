# AGENTS.md -- src/notion/

> Read the root `AGENTS.md` first. This file covers the Notion SDK integration
> layer only.

## Purpose

This directory contains the code that directly touches the Notion API: client
configuration, database schemas, property extractors, vault setup, relation
hydration, and RunTool adapters. Domain logic belongs in `src/core/`.

## Documentation Map

| Need                                                          | Read                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| SDK v5 request and response shapes                            | [`docs/notion-sdk-v5.md`](../../docs/notion-sdk-v5.md)                                                 |
| Rate-limit gates, endpoint overrides, and call-site checklist | [`docs/notion-rate-limit.md`](../../docs/notion-rate-limit.md)                                         |
| RunTool routing and rollback entry point                      | [`runtool/README.md`](runtool/README.md)                                                               |
| RunTool API contract                                          | [`runtool/contract.md`](runtool/contract.md)                                                           |
| RunTool consumer behavior and fallbacks                       | [`runtool/consumers.md`](runtool/consumers.md)                                                         |
| RunTool historical evidence and phase logs                    | [`docs/archive/runtool-evidence.md`](../../docs/archive/runtool-evidence.md)                           |
| Auth token resolution before this layer receives a bearer     | [`src/auth/AGENTS.md`](../auth/AGENTS.md) and [`docs/authentication.md`](../../docs/authentication.md) |
| Service behavior built on these primitives                    | [`src/core/AGENTS.md`](../core/AGENTS.md)                                                              |

## Files

| File                     | Responsibility                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `client.ts`              | Creates a configured `Client` instance with custom timeout and User-Agent.              |
| `page-id-schema.ts`      | Shared Zod schema for Notion page IDs, including undashed URL-form normalization.       |
| `rate-limit.ts`          | Wraps the Notion client in request-rate, concurrency, and shared-backoff gates.         |
| `schema.ts`              | Defines database property configs, property name constants, and page property builders. |
| `extractors.ts`          | Provides typed property value extractors for `PageObjectResponse`.                      |
| `query-response.ts`      | Guards data-source query response shape and preserves validation payload errors.        |
| `relation-properties.ts` | Paginates relation property values when page responses are truncated.                   |
| `setup.ts`               | Creates and verifies the five-database vault structure.                                 |
| `runtool/`               | Hosts the quarantined RunTool integration, public wrappers, feature flags, and tests.   |

## RunTool quarantine

`runtool/` is the home for Lore's quarantined integration with Notion's
internal `POST /v1/tools/run` API. Keep this guide to routing pointers:

- `runtool/README.md` owns the current default, operator rollback path, and
  doc index.
- `runtool/contract.md` owns endpoint, envelope, auth/capability, rate-limit,
  response-shape, pin, and error-vocabulary contracts.
- `runtool/consumers.md` owns per-consumer surfaces and fallback behavior for
  `create_pages`, `update_page`, `query_data_sources`, and `search`.
- `docs/archive/runtool-evidence.md` preserves old phase logs, verification
  runs, and default-on evidence.

The canonical name for the 403 capability-rejection kind is
`restricted_resource`, matching `APIErrorCode.RestrictedResource`. RunTool
consumers must use the same spelling.

## Property Extractors Pattern

`extractors.ts` provides typed helper functions for pulling values out of
Notion page properties. Every core service uses these instead of inlining
property access logic.

| Extractor                       | Input property type | Returns          |
| ------------------------------- | ------------------- | ---------------- |
| `extractTitle(prop)`            | `title`             | `string`         |
| `extractRichText(prop)`         | `rich_text`         | `string`         |
| `extractSelect(prop, fallback)` | `select`            | `string`         |
| `extractMultiSelect(prop)`      | `multi_select`      | `string[]`       |
| `extractRelationIds(prop)`      | `relation`          | `string[]`       |
| `extractDate(prop)`             | `date`              | `string \| null` |

`extractRelationIds()` is intentionally synchronous and only reads IDs already
present on a page response. When a relation property has `has_more: true`, use
`hydrateRelationProperties()` from `relation-properties.ts` before mapping the
page into a domain type. Batch hydration is concurrency-limited to mirror the
Notion client rate-limit gate; avoid bypassing it with ad hoc `Promise.all`
loops around `pages.properties.retrieve`.

The `isFullPage()` type guard narrows data-source query results to
`PageObjectResponse` before extraction.

**Rule:** Always use these extractors. Do not write inline property access like
`page.properties["Name"].title[0].plain_text`; it is fragile and untyped.

## Schema Definitions Pattern

`schema.ts` defines three things per database:

1. **Property name constants** (`PROJECT_PROPS`, `TOPIC_PROPS`,
   `MEMORY_PROPS`, `ENTITY_PROPS`, `FACT_PROPS`) are `as const` objects
   exporting the canonical Notion property name for every column. Always
   reference the constant when accessing a property; never inline a bare string
   literal in production code:

   ```typescript
   // Correct
   const subject = extractTitle(props[FACT_PROPS.SUBJECT])
   filters.push({ property: MEMORY_PROPS.STATUS, select: { equals: "active" } })

   // Wrong
   const subject = extractTitle(props["Subject"])
   filters.push({ property: "Status", select: { equals: "active" } })
   ```

   The `*_PROPS` constants are the single source of truth for Notion property
   names. The schema-drift suite in `schema.test.ts` keeps each constant
   aligned with the keys its builder function emits, so a rename made only on
   one half cannot silently land. Test fixtures may keep bare literals for
   wire-format readability when that intent is explicit.

2. **Property configuration** (`PropertyConfig`) is used by `setup.ts` when
   creating databases. Builders compose the `*_PROPS` constants as computed
   property keys so config and constants share one source.

3. **Property builder functions** (`buildProjectProps`, `buildMemoryProps`,
   etc.) are used by core services when creating or updating pages. The
   builders also write through `*_PROPS` constants.

Database schema configs are exposed as functions so relation IDs and the active
profile can be passed explicitly:

```typescript
// No relations, but profile additives may still apply.
export function projectsProperties(profile?: ResolvedProfile): PropertyConfig { ... }

// Dynamic: needs related DB IDs.
export function memoriesProperties(
  projectsDbId: string,
  topicsDbId: string,
  memoriesDsId?: string,
  profile?: ResolvedProfile,
): PropertyConfig { ... }
```

## Vault Setup

`setup.ts` creates databases in dependency order:

1. **Projects** -- no dependencies
2. **Topics** -- relation to Projects
3. **Memories** -- relations to Projects and Topics
4. **Entities** -- relations to Projects and Memories
5. **Facts** -- relations to Projects, Memories, and Entities

`verifyVaultDatabases()` reads the vault page's child blocks and matches
database titles to the expected names. If a title is missing, it retrieves
unmatched child databases and identifies Lore databases by schema fingerprint
so a renamed database still counts as present and `lore init` cannot duplicate
a partial vault. This is used by `VaultManager.load()`.

Projects, Topics, Memories, Entities, and Facts are mandatory. Row-level
migration fallback is separate: existing Facts may still have empty entity
relations until `lore migrate --build-entities` repoints them.

`verifyVaultDatabasesForEntityRepair()` is the narrow exception for the
`lore vault ensure-entities` bootstrap command: it requires Projects, Topics,
Memories, and Facts but allows Entities to be absent so the repair command can
run outside strict service initialization.

## Things That Do Not Live Here

Do not add long-form SDK migration notes, rate-limit internals, or RunTool
manuals to this file. Put durable reference content in the focused docs linked
above and keep this guide short enough to route a contributor quickly.
