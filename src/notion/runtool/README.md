# `src/notion/runtool/` - RunTool Routing

This directory contains Lore's quarantined integration with Notion's internal
`POST /v1/tools/run` API. Runtime behavior lives in the TypeScript modules in
this directory; this README is the short routing and operator contract.

## Source Map

| Need                                                                                                    | Source                                                                                   |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Endpoint, request/response envelopes, auth/capability gates, rate limits, error vocabulary              | [`contract.md`](contract.md)                                                             |
| Per-consumer surfaces, flags, fallback behavior, and tests                                              | [`consumers.md`](consumers.md)                                                           |
| Phase logs, manual verification runs, default-on evidence, old open questions, and issue-slice evidence | [`../../../docs/archive/runtool-evidence.md`](../../../docs/archive/runtool-evidence.md) |

The child docs are the source of truth for current behavior. The archive is
retained for audit history and schema-refresh context only.

## Current Contract

RunTool dispatches through `client.request()` so it inherits the same Notion SDK
auth header, auth-refresh proxy, rate-limit pacing, retry/backoff behavior, and
User-Agent as the rest of Lore. Do not add a parallel `fetch` path, second base
URL knob, or independent rate-limit gate for RunTool consumers.

The parent `LORE_USE_RUNTOOL` flag and every inheriting sub-flag default ON:

| Flag                             | Consumer                                            | Default               |
| -------------------------------- | --------------------------------------------------- | --------------------- |
| `LORE_USE_RUNTOOL`               | Parent kill-switch for inheriting RunTool consumers | ON                    |
| `LORE_USE_RUNTOOL_BLOCK_EDIT`    | `update_page` anchored markdown edits               | ON, inherits parent   |
| `LORE_USE_RUNTOOL_FILTER_SQL`    | `query_data_sources` SQL filter helpers             | ON, inherits parent   |
| `LORE_USE_RUNTOOL_SEARCH`        | `search` semantic-lane candidate fetch              | ON, inherits parent   |
| `LORE_USE_RUNTOOL_AGGREGATE`     | `query_data_sources` SQL aggregate helper           | ON, inherits parent   |
| `LORE_USE_RUNTOOL_BATCH_CREATES` | `create_pages` fact batch creates                   | OFF, does not inherit |

`LORE_USE_RUNTOOL_BATCH_CREATES` stays default-off because `create_pages` can
partially commit a batch. That write-path opt-in must remain explicit.

## Runtime Surfaces

| Tool                               | Wrapper / caller                                                                                                                     | Flag                             | Fallback posture                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `update_page` / `update_content`   | `updatePageContentViaRunTool`, used by memory body edits and topic-key audit appends                                                 | `LORE_USE_RUNTOOL_BLOCK_EDIT`    | Fall back per call on `RunToolBlockEditError` kinds: `no_match`, `multiple_matches`, `deletion_warning`, `restricted_resource`. Propagate 401, 429, 5xx, malformed, and unclassified 400 errors.                     |
| `query_data_sources` SQL filters   | `fetchEntityByNormalizedName`, `fetchEntitiesByAliasSubstring`, `fetchNearDuplicateCandidatePageIds`, `fetchAlreadyComparedPairKeys` | `LORE_USE_RUNTOOL_FILTER_SQL`    | Fall back per call on non-validation SDK errors and saturated windows. Re-throw 400 / `validation_error` query-shape drift.                                                                                          |
| `search`                           | `searchViaRunTool`, used by `MemoryService.fetchSemanticPages`                                                                       | `LORE_USE_RUNTOOL_SEARCH`        | Fall back to REST when the request cannot be represented safely: empty composed query, `limit > 25`, raw 25-hit saturation, or 403 `restricted_resource`. Propagate 401, 429, 5xx, malformed, and validation errors. |
| `query_data_sources` SQL aggregate | `querySubjectGroupCountsViaRunTool`, used by orphan-rate reporting                                                                   | `LORE_USE_RUNTOOL_AGGREGATE`     | Fall back to JS enumeration on capability/rate/network failures, malformed responses, and `has_more: true`. Re-throw 400 / `validation_error`.                                                                       |
| `create_pages`                     | `createPagesViaRunTool`, used by fact `createBatchWithDedup` when explicitly enabled                                                 | `LORE_USE_RUNTOOL_BATCH_CREATES` | Preserve per-input isolation. Surface committed prefixes with `BatchCreateError.committedIds`; fall back to per-input `createWithDedup` / fresh-create according to whether the failed chunk may have committed.     |

See [`consumers.md`](consumers.md) for the per-consumer details and the test
files that pin each branch.

## Rollback

Disable the whole inheriting family:

```sh
export LORE_USE_RUNTOOL=0
```

Disable one inheriting consumer while leaving the others on:

```sh
export LORE_USE_RUNTOOL_BLOCK_EDIT=0
export LORE_USE_RUNTOOL_FILTER_SQL=0
export LORE_USE_RUNTOOL_SEARCH=0
export LORE_USE_RUNTOOL_AGGREGATE=0
```

Disable the explicit batch-create opt-in:

```sh
export LORE_USE_RUNTOOL_BATCH_CREATES=0
```

Use `0`, `false`, or `off` for incident rollback. Unrecognized non-empty values
fall through to the documented default and emit a once-per-process warning from
`flag.ts`; for the default-on flags, a typo such as `LORE_USE_RUNTOOL=fasle`
leaves RunTool enabled.

## Pin Policy

The vendored schema subset is pinned in [`contract.md`](contract.md). Do not
repin the upstream RunTool schema as part of routine consumer work. A schema
refresh must be a dedicated PR that updates the commit/blob table, re-runs the
A/B harness, and calls out request-envelope, response-shape, or capability-gate
changes.
