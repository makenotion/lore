# AGENTS.md -- src/notion/

> Read the root `AGENTS.md` first. This file covers the Notion SDK integration
> layer only.

## Purpose

This directory contains everything that directly touches the Notion API:
client configuration, database schemas, property extractors, and vault setup.
No domain logic lives here -- that belongs in `src/core/`.

## Files

| File            | Responsibility                                                            |
| --------------- | ------------------------------------------------------------------------- |
| `client.ts`     | Creates a configured `Client` instance with custom timeout and User-Agent |
| `rate-limit.ts` | Proxy wrapper that caps outbound concurrency via `p-limit`                |
| `schema.ts`     | Database property definitions + page property builder functions           |
| `extractors.ts` | Type-safe property value extractors for `PageObjectResponse`              |
| `setup.ts`      | Creates and verifies the four-database vault structure                    |

## Notion SDK v5.x Specifics

This project targets `@notionhq/client` ^5.1.0. The v5 SDK introduced
breaking changes that affect nearly every file in this directory. If you have
experience with the v4 SDK, pay close attention to the differences below.

### dataSources.query (not databases.query)

The v5 SDK renamed the query endpoint:

```typescript
// CORRECT -- v5
const response = await client.dataSources.query({
  data_source_id: databaseId,
  filter: { ... },
  sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
  page_size: 20,
})

// WRONG -- v4 (will not compile)
const response = await client.databases.query({
  database_id: databaseId,
  ...
})
```

The response type is `QueryDataSourceResponse`. Filter and sort parameters use
`QueryDataSourceParameters`.

### initial_data_source (not top-level properties)

Database creation in v5 puts property definitions inside `initial_data_source`:

```typescript
// CORRECT -- v5
await client.databases.create({
  parent: { type: "page_id", page_id: pageId },
  title: [{ text: { content: "My Database" } }],
  initial_data_source: {
    properties: { Name: { title: {} }, Status: { select: { options: [...] } } }
  },
})

// WRONG -- v4
await client.databases.create({
  parent: { page_id: pageId },
  properties: { ... }
})
```

### Parent type discriminant

The v5 SDK requires an explicit `type` field on parent objects:

```typescript
// CORRECT -- v5
{ parent: { type: "page_id", page_id: pageId } }
{ parent: { type: "database_id", database_id: dbId } }

// WRONG -- v4
{ parent: { page_id: pageId } }
```

### Markdown API for page content

Page bodies are read and written via the markdown API, not block children:

```typescript
// Read content
const md = await client.pages.retrieveMarkdown({ page_id: id })
const content = md.markdown

// Write content (new page)
await client.pages.updateMarkdown({
  page_id: id,
  type: "insert_content",
  insert_content: { content: markdownString },
})

// Replace content (existing page)
await client.pages.updateMarkdown({
  page_id: id,
  type: "replace_content_range",
  replace_content_range: {
    content: newMarkdown,
    content_range: "full_page",
    allow_deleting_content: true,
  },
})
```

### Bearer-token auth via the v5 SDK

The `auth: token` parameter on `new Client({ auth, ... })` flows
through to a `Bearer` header on every outbound request. For
ntn-issued tokens (post-0.10.0 default), the token is the value
read from `auth.json`'s workspace entry; for legacy
`LORE_NOTION_TOKEN`, the token is the integration's static secret.
Both are passed identically to the SDK; the SDK is auth-mode-blind.
See the root `AGENTS.md` **Authentication** section and
`src/auth/AGENTS.md` for how the token is resolved before reaching
this layer.

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

The `isFullPage()` type guard narrows `QueryDataSourceResponse` results to
`PageObjectResponse` before extraction.

**Rule**: Always use these extractors. Do not write inline property access like
`page.properties["Name"].title[0].plain_text` -- it is fragile and untyped.

## Schema Definitions Pattern

`schema.ts` defines two things per database:

1. **Property configuration** (`PropertyConfig`) -- used by `setup.ts` when creating
   databases via `initial_data_source.properties`.

2. **Property builder functions** (`buildProjectProps`, `buildMemoryProps`, etc.) --
   used by core services when creating or updating pages.

Databases that have relations to other databases use functions (not constants) so
the related database ID can be passed in:

```typescript
// Static (no relations)
export const projectsProperties: PropertyConfig = { ... }

// Dynamic (needs related DB IDs)
export function memoriesProperties(projectsDbId: string, topicsDbId: string): PropertyConfig { ... }
```

## Vault Setup

`setup.ts` creates databases in dependency order:

1. **Projects** -- no dependencies
2. **Topics** -- relation to Projects
3. **Memories** -- relations to Projects and Topics
4. **Entities** (PF3-01) -- relations to Projects and Memories
5. **Facts** -- relations to Projects, Memories, and Entities

The `createDbArgs()` helper handles the type casting needed for
`initial_data_source.properties`. If you need to create a new database, follow
this pattern.

`verifyVaultDatabases()` reads the vault page's child blocks and matches
database titles to the expected names. This is used by `VaultManager.load()`.

**Required vs optional databases.** Projects / Topics / Memories / Facts
are mandatory — `verifyVaultDatabases` throws when any of them are absent.
The Entities database is optional: pre-PF3-01 vaults still load with
`vault.databases.entities` left undefined. `migrateVaultSchema` keys the
expected-shape map off whichever databases actually exist, so a legacy
vault doesn't surface phantom drift on the entity relation columns until
the operator runs `lore migrate --build-entities` to wire them in.

## Rate Limiting

`rate-limit.ts` exports `createLimitedClient(client, concurrency)`. It returns
a `Proxy` over the real client that routes every outbound method call through
a shared `p-limit` gate, so fan-out (decision-graph walks, batch fact fetches,
render-layer title lookups) stays under Notion's ~3 rps public guidance.

The Proxy **recurses through sub-namespaces at arbitrary depth**, so
three-level paths like `client.blocks.children.list`,
`client.blocks.children.append`, and `client.pages.properties.retrieve`
are governed alongside the two-level paths (`client.pages.retrieve`,
`client.dataSources.query`) and top-level methods (`client.search`). A
non-recursive wrapper would leak these three-level calls — an earlier
revision of this module did, and `setup.ts`'s `blocks.children.list`
verification sweep was ungoverned until the fix.

`initServicesFromConfig` and `lore init` both wrap the raw client before
handing it to services, using `config.notion.rateLimit.concurrency`
(default `3`). `initServicesFromConfig` reads the config value;
`lore init` runs before `.lore.yaml` exists, so it uses the default and
picks up any custom concurrency on subsequent commands.

Tests that inject their own mock client remain unaffected because the
wrap happens inside `initServicesFromConfig` / `lore init`, not at
construction of `ProjectService` / `TopicService` / etc. If a test wants
to observe limiter behaviour with a mock, it should wrap the mock
explicitly via `createLimitedClient`.

**When adding a new SDK call site**, extend `rate-limit.test.ts` with a
case that asserts the limiter governs the new path. The recursive wrap
handles any depth automatically, but the invariant is easy to regress
silently — for example, an SDK method that returns a function (deep
promise chains, future higher-order factories) or a change to the
SDK's property shape could bypass the wrap without any type-level
signal. The scar tissue is: a one-line test per new top-level or
nested method saves the next regression.

**Per-token, not per-integration.** Notion enforces rate limits per
access token (confirmed with the public-connections team
2026-05-01). Under the 0.10.0 ntn-first deployment, every
operator's ntn-issued token has its own ~3-rps bucket. The
`p-limit` gate in `rate-limit.ts` keeps a single Lore process
under that ceiling; cross-process contention within one operator's
token is bounded by `DEFAULT_NOTION_CONCURRENCY` × number of
concurrent processes. A "lore proxy token" that aggregated requests
across operators would re-collapse the per-token isolation —
don't.

## Filter Type Casting

When building complex filters (compound `and`/`or`), the SDK types do not
always infer correctly. Cast the filter object:

```typescript
const filter = filters.length > 1 ? { and: filters } : filters[0]

const response = await client.dataSources.query({
  data_source_id: this.databaseId,
  filter: filter as QueryDataSourceParameters["filter"],
})
```

This is an intentional pattern, not a hack. The SDK's discriminated union for
filter types is too strict for dynamically composed filters.
