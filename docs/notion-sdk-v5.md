# Notion SDK v5 Contract

Lore targets `@notionhq/client` v5.x. This guide is the source of truth for
SDK shapes that differ from v4. Use it when adding or reviewing Notion SDK call
sites in `src/notion/`.

## Data-Source Queries

The v5 SDK queries databases through the `dataSources` namespace:

```typescript
// Correct: v5
const response = await client.dataSources.query({
  data_source_id: databaseId,
  filter: { ... },
  sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
  page_size: 20,
})

// Wrong: v4
const response = await client.databases.query({
  database_id: databaseId,
  ...
})
```

The response type is `QueryDataSourceResponse`. Filter and sort parameters use
`QueryDataSourceParameters`.

Use `isFullPage()` before extracting page properties from query results. If a
call site needs to preserve Notion validation details, route the response
through `query-response.ts` rather than collapsing errors into a generic shape.

## Database Creation

Database creation in v5 puts property definitions inside
`initial_data_source`:

```typescript
// Correct: v5
await client.databases.create({
  parent: { type: "page_id", page_id: pageId },
  title: [{ text: { content: "My Database" } }],
  initial_data_source: {
    properties: {
      Name: { title: {} },
      Status: { select: { options: [...] } },
    },
  },
})

// Wrong: v4
await client.databases.create({
  parent: { page_id: pageId },
  properties: { ... },
})
```

In Lore, prefer `createDbArgs()` from `src/notion/setup.ts` when creating
vault databases. It centralizes the casting needed for
`initial_data_source.properties`.

## Parent-type discriminant

The v5 SDK requires an explicit `type` field on parent objects:

```typescript
// Correct: v5
{ parent: { type: "page_id", page_id: pageId } }
{ parent: { type: "database_id", database_id: dbId } }

// Wrong: v4
{ parent: { page_id: pageId } }
```

Do not rely on SDK inference for parent type. The explicit discriminant keeps
TypeScript aligned with the wire shape.

## Markdown Page-Content API

Page bodies are read and written through the markdown API, not block children:

```typescript
// Read content.
const md = await client.pages.retrieveMarkdown({ page_id: id })
const content = md.markdown

// Write content to a new page.
await client.pages.updateMarkdown({
  page_id: id,
  type: "insert_content",
  insert_content: { content: markdownString },
})

// Replace content on an existing page.
await client.pages.updateMarkdown({
  page_id: id,
  type: "replace_content",
  replace_content: {
    new_str: newMarkdown,
    allow_deleting_content: true,
  },
})
```

Use block children only for code that is explicitly about Notion blocks rather
than Lore memory bodies.

## Bearer-token auth

The `auth` option passed to `new Client({ auth, ... })` flows through to a
`Bearer` header on every outbound SDK request. For ntn-issued tokens, the token
is the value read from `auth.json`'s workspace entry. For `NOTION_API_TOKEN`,
the token is the explicit bearer supplied by the operator. Both values are
passed identically to the SDK; this layer does not branch on auth mode.

See the root `AGENTS.md` **Authentication** section, `src/auth/AGENTS.md`, and
`docs/authentication.md` for the token resolution contract before this layer
receives a bearer.

## Filter type casting

When building dynamic compound filters, the SDK types do not always infer the
discriminated union correctly. Cast the final filter object:

```typescript
const filter = filters.length > 1 ? { and: filters } : filters[0]

const response = await client.dataSources.query({
  data_source_id: this.databaseId,
  filter: filter as QueryDataSourceParameters["filter"],
})
```

This is an intentional pattern for dynamically composed filters. Do not replace
it with stringly typed filter construction or broad `any` casts.
