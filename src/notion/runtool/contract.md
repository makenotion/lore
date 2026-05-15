# RunTool Contract

This document is the current contract for Lore's use of Notion's internal
RunTool API. Historical phase notes and manual run evidence live in
[`../../../docs/archive/runtool-evidence.md`](../../../docs/archive/runtool-evidence.md).

## Scope

Lore vendors a pinned subset of RunTool. Code in this repo must not import the
internal upstream source at build or runtime, and must not extend the tool set
without an explicit issue.

Supported tool names use the RunTool API names, not MCP-facing aliases:

| RunTool API name     | MCP alias not used in Lore  | Lore status                                  |
| -------------------- | --------------------------- | -------------------------------------------- |
| `search`             | `notion-search`             | Semantic-lane candidate fetch                |
| `query_data_sources` | `notion-query-data-sources` | SQL filters and aggregate helper             |
| `create_pages`       | `notion-create-pages`       | Explicit opt-in batch create                 |
| `update_page`        | `notion-update-page`        | Anchored markdown edits via `update_content` |

Other tools present in the pinned upstream `RunToolParams.ALL_TOOLS` list are
out of scope until a separate issue adds a consumer.

## Pinned Schema Source

| Item            | Value                                      |
| --------------- | ------------------------------------------ |
| Source          | internal upstream Notion server snapshot   |
| Branch reviewed | `main`                                     |
| Commit          | `69cd144ac1e429229680b6fb24ec29bcea3e37ac` |
| Snapshot date   | 2026-05-05                                 |

Per-file blob SHAs at the pinned commit:

| Path under `src/server-publicApi/apis/ai_tools/`           | Blob SHA                                   |
| ---------------------------------------------------------- | ------------------------------------------ |
| `params/RunToolParams.ts`                                  | `b9370e41a29f2b784f8f7564c3ba08766d83f938` |
| `params/search/SearchToolParams.ts`                        | `d1f0b451a28fe2eaf3b86beed6b5c987438761f5` |
| `params/query_data_sources/QueryDataSourcesToolParams.ts`  | `2bcab21355c6604e1d150543191f2584290cfcad` |
| `params/query_data_sources/QueryDataSourcesDataParams.ts`  | `8faf522d1b7af92420a021818051c68395470da4` |
| `resources/RunToolResource.ts`                             | `b743e99863c2ecd254ab3a81b59e90621ba36095` |
| `resources/search/SearchResource.ts`                       | `d5a1db1a98082a17fd0f6d923fef1057579156d3` |
| `resources/search/InternalSearchResource.ts`               | `0e85b9c8ad728c476b98adfc887f8aa9c2a6b733` |
| `resources/search/InternalSearchResultResource.ts`         | `e82780637d6b54dd3477c3b7d4d39f508f90e753` |
| `resources/search/UserSearchResource.ts`                   | `9a1328974d25c08535b40a3ac1560653e96c8787` |
| `resources/query_data_sources/QueryDataSourcesResource.ts` | `5c7410744748326c660019e568ca89a73e973954` |
| `endpoints/RunTool.ts`                                     | `9a48d3aa9c5b093cb6dad050f83297b16c9312c1` |

A schema refresh must update the whole table at once, re-run the A/B harness,
and call out any breaking change in the request envelope, response shape, or
capability gating.

## Endpoint

RunTool uses:

```text
POST /v1/tools/run
```

The endpoint is registered upstream with `isEndpointDocumented: false` and is
server-gated by the `ai_tools_public_api` Statsig flag. Lore therefore treats
it as a quarantined, pinned-schema integration.

Base URL is the same Notion REST host Lore already targets: `LORE_NOTION_BASE_URL`
when set, otherwise the SDK default. The wrapper must not introduce a second
base-URL knob.

## Request Envelope

The body is a discriminated union keyed by `type`:

```jsonc
{
  "type": "<tool_name>",
  "<tool_name>": {
    /* tool-specific params */
  },
}
```

Examples:

```ts
runTool(client, "create_pages", params)
runTool(client, "update_page", params)
runTool(client, "query_data_sources", params)
runTool(client, "search", params)
```

## Response Envelope

The response body is the bare per-tool resource shape. There is no outer
`{ type, [tool_name]: ... }` wrapper mirroring the request.

| Tool                 | Response shape Lore expects                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `create_pages`       | `{ pages: Array<{ id: string }> }`                                                                   |
| `update_page`        | `UpdatePageResource.Value`; the `update_content` wrapper only exposes success/deletion-warning state |
| `search`             | `InternalSearchResource.Value` for Lore's `internal` search use case                                 |
| `query_data_sources` | `{ results, has_more, data_source_ids? }`                                                            |

A wrapper that types responses as `{ type, [tool]: ... }` will fail on the
first real call.

## Auth And Capability

The Notion SDK sends the resolved token as `Authorization: Bearer <token>` for
RunTool just as it does for every REST call. Lore's auth priority remains:

1. `NOTION_API_TOKEN`
2. ntn-resolved `~/.config/notion/auth.json`

RunTool accepts user-actor or workflow-bot tokens. Public OAuth integration
tokens can be rejected with 403 `restricted_resource`; auth-refresh cannot
repair that class because it only retries 401.

Upstream dispatch has two actor paths:

| Path             | Behavior                                                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow bot     | Supported tools dispatch directly after capability checks.                                                                                                                                |
| Non-workflow bot | `resolveRunToolUserActor` accepts personal bots with matching effective actor and user guest bots with a `UserTable` parent; other actor shapes reject with `ApiRestrictedResourceError`. |

Workflow-bot direct-tool capability gates:

| Tool                                                 | Gate                                                      |
| ---------------------------------------------------- | --------------------------------------------------------- |
| `search`                                             | Always shown                                              |
| `query_data_sources`                                 | `hasAdvancedTools` (Enterprise + AI workspace plan)       |
| `query_meeting_notes`                                | `hasAiAccess`                                             |
| Write tools such as `create_pages` and `update_page` | Visibility layer allows them; per-tool quotas still apply |

`isMcpClientAllowed` also runs against the workspace MCP-client allowlist before
tool dispatch. A workspace-admin allowlist denial surfaces as
`ApiRestrictedResourceError`.

## Rate-Limit Accounting

RunTool calls go through two server-side checks:

| Check                             | Applies to                                                                      | Notes                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Per-tool, per-actor RunTool quota | All RunTool tools                                                               | Keyed on `(actorId, toolName)`; failures surface as HTTP 429 with `Retry-After`. |
| Block-write quota                 | `create_pages`, `update_page`, `move_pages`, `duplicate_page`, `create_comment` | Counts blocks written; read tools skip this gate.                                |

On the Lore side, RunTool must dispatch through the same `Client` instance as
REST/SDK calls. That keeps RunTool under `createLimitedClient`'s token bucket
and lets the shared 401 refresh and 429 `Retry-After` backoff remain the only
auth/rate-limit mechanisms in the process.

Do not add a `pLimit` or token bucket inside `src/notion/runtool/`.

## Error Vocabulary

The canonical fall-back-able 403 kind is `restricted_resource`, matching
`APIErrorCode.RestrictedResource`. Every RunTool consumer must use this exact
spelling.

| Kind                  | Trigger                                                                     | Recovery                                               |
| --------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| `no_match`            | `update_content.old_str` was absent from the page body                      | Caller falls back to the existing REST/SDK path        |
| `multiple_matches`    | `old_str` matched more than once and `replace_all_matches` was unset        | Caller falls back; picking one implicitly is forbidden |
| `deletion_warning`    | Edit would remove child pages or databases without `allow_deleting_content` | Caller falls back to preserve children                 |
| `restricted_resource` | 403 actor-type, MCP-client allowlist, or workflow-bot capability rejection  | Caller falls back; auth-refresh cannot repair it       |

Multi-kind consumers use `RunToolBlockEditError` with a `kind` discriminator.
Single-kind consumers may use a typed class such as `RunToolSearchRestrictedError`.
The string vocabulary remains shared across both shapes.

401 and 429 must propagate through the SDK/proxy chain so auth refresh and
backoff stay authoritative. 400 / `validation_error` usually indicates query or
schema drift and should not be silently hidden behind REST fallback unless a
consumer has a documented, typed validation class. 5xx and malformed responses
propagate unless a consumer explicitly documents a safe fallback branch.

## `search`

Lore issues internal search requests scoped to the Memories data source:

| Field                               | Type                            | Lore use                                   |
| ----------------------------------- | ------------------------------- | ------------------------------------------ |
| `query`                             | `string`, min length 1          | Required semantic query string             |
| `data_source_url`                   | `collection://<data_source_id>` | Scopes to the Memories data source         |
| `page_size`                         | 1-25                            | Wrapper clamps to 25                       |
| `max_highlight_length`              | 0-500                           | Lore sets `0`; highlights are not surfaced |
| `query_type`, `content_search_mode` | optional upstream fields        | Omitted for workflow-bot compatibility     |

RunTool `search` has no request cursor and no response `next_cursor`. It cannot
represent REST search's paginated `page_size: 100` path. Consumers must fall
back when recall could be under-served.

Lore consumes `InternalSearchResource.Value`:

```ts
type InternalSearchResource = {
  type: "ai_search" | "workspace_search" | "none"
  results: Array<{
    id: string
    title: string
    url: string
    type: string
    highlight: string
    timestamp: string
    is_archived?: boolean
  }>
}
```

For Notion results, `url` is a page id usable for hydration. External connector
results carry full URLs and are dropped by the wrapper.

## `query_data_sources`

Lore uses SQL mode. The request data is wrapped under the tool envelope:

```jsonc
{
  "type": "query_data_sources",
  "query_data_sources": {
    "data": {
      "mode": "sql",
      "data_source_urls": ["collection://<data_source_id>"],
      "query": "SELECT * FROM \"collection://<data_source_id>\" WHERE ...",
      "params": ["..."],
    },
  },
}
```

| Field              | Required | Notes                                                           |
| ------------------ | -------- | --------------------------------------------------------------- |
| `data_source_urls` | yes      | `collection://<data_source_id>` for each referenced data source |
| `query`            | yes      | SQLite; quote the data-source URL as the table name             |
| `mode`             | no       | Defaults to `sql`; Lore sets SQL mode explicitly where useful   |
| `params`           | no       | String values for `?` placeholders                              |

View mode (`mode: "view"`, `view_url`) exists upstream but is not used by Lore.

Response shape:

```ts
type QueryDataSourcesResource = {
  results: Array<Record<string, string | number | boolean | string[] | null>>
  has_more: boolean
  data_source_ids?: string[]
}
```

There is no documented cursor, offset, or page-size input. When `has_more` is
true, Lore treats the SQL result as partial and falls back rather than consuming
an incomplete result.

Known SQL gateway constraints that are load-bearing for current helpers:

| Constraint                                                                                        | Consumer consequence                                                                                                         |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Relation columns store JSON arrays of full user-facing URLs containing undashed page ids          | Helpers bind undashed ids into `LIKE` predicates and rehydrate relation ids from URL-shaped strings.                         |
| `Tags` stores a JSON array of quoted strings                                                      | Exact-token predicates use `Tags LIKE '%"<tag>"%'` after kebab-case validation.                                              |
| `archived`, `last_edited_time`, `lastEditedTime`, and `Valid Until` are not queryable SQL columns | Helpers do not add those predicates server-side; callers preserve parity through REST hydration or JS fallback where needed. |
| `query_data_sources` is gated by `hasAdvancedTools` for workflow bots                             | Consumers must have a 403 fallback path.                                                                                     |
