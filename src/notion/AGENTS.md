# AGENTS.md -- src/notion/

> Read the root `AGENTS.md` first. This file covers the Notion SDK integration
> layer only.

## Purpose

This directory contains everything that directly touches the Notion API:
client configuration, database schemas, property extractors, and vault setup.
No domain logic lives here -- that belongs in `src/core/`.

## Files

| File                     | Responsibility                                                            |
| ------------------------ | ------------------------------------------------------------------------- |
| `client.ts`              | Creates a configured `Client` instance with custom timeout and User-Agent |
| `rate-limit.ts`          | Proxy wrapper that caps outbound concurrency via `p-limit`                |
| `schema.ts`              | Database property definitions + page property builder functions           |
| `extractors.ts`          | Type-safe property value extractors for `PageObjectResponse`              |
| `relation-properties.ts` | Paginates relation property values when page responses are truncated      |
| `setup.ts`               | Creates and verifies the five-database vault structure                    |

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

`extractRelationIds()` is intentionally synchronous and only reads IDs already
present on a page response. When a relation property has `has_more: true`, use
`hydrateRelationProperties()` from `relation-properties.ts` before mapping the
page into a domain type. Batch hydration is concurrency-limited to mirror the
Notion client rate-limit gate; avoid bypassing it with ad hoc `Promise.all`
loops around `pages.properties.retrieve`.

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
database titles to the expected names. If a title is missing, it retrieves
unmatched child databases and identifies Lore databases by schema fingerprint
so a renamed database still counts as present and `lore init` cannot duplicate
a partial vault. This is used by `VaultManager.load()`.

**Required databases.** Projects / Topics / Memories / Entities / Facts
are mandatory — `verifyVaultDatabases` throws when any of them are absent.
`migrateVaultSchema` always includes the Entities database and the Facts
`SubjectEntity` / `ObjectEntity` relation columns. Row-level migration
fallback is separate: existing Facts may still have empty entity relations
until `lore migrate --build-entities` repoints them.

`verifyVaultDatabasesForEntityRepair()` is the narrow exception for the
`lore vault ensure-entities` bootstrap command: it requires Projects / Topics /
Memories / Facts but allows Entities to be absent so the repair command can run
outside strict service initialization.

## Rate Limiting

`rate-limit.ts` exports `createLimitedClient(client, options)`. It returns
a `Proxy` over the real client that routes every outbound method call
through three composed gates so fan-out (decision-graph walks, batch
fact fetches, render-layer title lookups) stays under Notion's ~3 rps
per-token public guidance:

1. **Token bucket** (request rate) — paces sustained throughput.
   Capacity = `burstSize` (default 3); refill = `requestsPerSecond`
   (default 3). Short fan-outs that fit under the burst (≤3 calls)
   fire instantly; longer fan-outs pace at the refill rate.
2. **`p-limit` slot** (concurrency) — bounds simultaneous in-flight
   requests so a slow Notion call can't fan out memory under heavy
   load. Capacity = `concurrency` (default 3).
3. **Shared 429 backoff** — when a 429 escapes the SDK's internal
   retry budget (the v5 SDK retries 429s twice with `Retry-After`
   parsing), the wrapper pauses the bucket for the surfaced
   `Retry-After` (or `DEFAULT_RATE_LIMIT_BACKOFF_MS = 1000ms` when
   absent), clamped at `MAX_RATE_LIMIT_BACKOFF_MS = 60_000ms` so a
   runaway header doesn't freeze the entire client for hours. The
   pause is observed by every subsequent dispatch on this client.
   Siblings already past the in-slot `bucket.acquire()` (i.e.
   already-dispatched SDK calls) are NOT affected — the pause
   governs the next dispatch, not in-flight calls. Backoff events
   emit a `[lore] notion-sdk warn: 429 backoff <ms> (source=...)`
   stderr line by default; consumers wanting telemetry replace
   `deps.onBackoff`.

The Proxy **recurses through sub-namespaces at arbitrary depth**, so
three-level paths like `client.blocks.children.list`,
`client.blocks.children.append`, and `client.pages.properties.retrieve`
are governed alongside the two-level paths (`client.pages.retrieve`,
`client.dataSources.query`) and top-level methods (`client.search`). A
non-recursive wrapper would leak these three-level calls — an earlier
revision of this module did, and `setup.ts`'s `blocks.children.list`
verification sweep was ungoverned until the fix.

`initServicesFromConfig` and `lore init` both wrap the raw client
before handing it to services. `initServicesFromConfig` reads
`config.notion.rateLimit` (with `concurrency` / `requestsPerSecond` /
`burstSize` knobs); `lore init` runs before `.lore.yaml` exists, so it
uses defaults and picks up any custom values on subsequent commands.

**Backwards-compatible signature**: a bare `number` second argument
is interpreted as `{ concurrency: <n> }`. Legacy `createLimitedClient(client, 3)`
call sites continue to work; they pick up the new rps + burst defaults
transparently.

**One-time setup flows pay the rps tax too.** `lore init`,
`lore install`, and `lore auth --status` previously had only the
concurrency cap; under the new defaults they're paced at 3 rps. These
flows run once-per-vault each and are not on the hot path, so the
added latency (a few seconds for setup-shaped operations that fire >3
calls/sec) is acceptable. Operators who measure their workload and
want to tune up should set `notion.rateLimit.requestsPerSecond` in
`.lore.yaml`.

**Bucket lifecycle.** The bucket only schedules a refill timer when
its waiter queue is non-empty; the timer is NOT `unref`'d. An
`unref`'d refill timer would let Node exit between an in-flight SDK
call resolving and the next queued caller's token arriving, leaving
the queued caller's Promise unresolved (Node treats top-level await
on an unresolved Promise as a no-op exit). The natural lifecycle is
"timer keeps the loop alive while the queue has work; queue drains;
last issuance schedules no successor; loop exits."

**`pauseFor` drains the bucket.** When a 429 surfaces, the wrapper
calls `bucket.pauseFor(retryAfterMs)`, which sets `tokens = 0` AND
`lastRefillMs = pausedUntilMs`. A caller queued during the pause
therefore waits the pause window PLUS the first refill interval
(`1/rps` seconds) before its token is issued — pinned by the
`pauseFor + slow refill` test. Preserving any token at pause-expiry
would let the next caller fire instantly back into the same
throttling window the 429 signaled. The extra refill interval is the
cost of "no bursting after backoff."

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

**When the new path lands in a hot fan-out** (a paginated walk, a
batch-fetch helper that issues many calls to the same SDK method),
add a _pacing_ test alongside the _concurrency_ test — the existing
"caps concurrency on top-level client methods" tests use the
`RATE_GATE_DISABLED` options bag to bypass pacing for clean cap
assertions, so a fan-out path that should respect rps needs its own
test that exercises the bucket. See "paces a burst of calls beyond
the bucket capacity" for the shape.

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
