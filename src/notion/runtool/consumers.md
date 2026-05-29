# RunTool Consumers

This document tracks the current RunTool runtime surfaces and fallback behavior.
The shared wire contract lives in [`contract.md`](contract.md); historical
rollout evidence lives in
[`../../../docs/archive/runtool-evidence.md`](../../../docs/archive/runtool-evidence.md).

## Module State

| File                           | Responsibility                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `client.ts`                    | Shared `runTool<T>(client, tool, params)` dispatcher plus the `update_page` / `update_content` lower-level surface.            |
| `types.ts`                     | Pinned subset of request/response types for `create_pages`, `update_page`, `query_data_sources`, and `search`.                 |
| `flag.ts`                      | Parent kill-switch and per-consumer env parsers. Parent and inheriting sub-flags default ON; batch creates default OFF.        |
| `update-page.ts`               | High-level anchored markdown edit wrapper.                                                                                     |
| `create-pages.ts`              | Chunked batch-create wrapper for explicit `create_pages` opt-in.                                                               |
| `query.ts`                     | SQL filter helpers, SQL aggregate helper, and relation-id rehydration helpers.                                                 |
| `search.ts`                    | Semantic-lane `search` wrapper with result narrowing and saturation reporting.                                                 |
| `error-helpers.ts`             | Shared SQL validation classifier, fallback logging, partial-result error, restricted-resource warning, and page-id validation. |
| `index.ts`                     | Public RunTool exports.                                                                                                        |
| `*.test.ts` / `compat.test.ts` | Mocked HTTP coverage and A/B fixture harnesses.                                                                                |

Every consumer dispatches through `client.request()` via `runTool`; none creates
a separate auth path, base-URL resolver, or rate-limit gate.

## Flags

| Flag                             | Default | Inherits `LORE_USE_RUNTOOL` | Consumer                              |
| -------------------------------- | ------- | --------------------------- | ------------------------------------- |
| `LORE_USE_RUNTOOL_BLOCK_EDIT`    | ON      | yes                         | `update_page` anchored markdown edits |
| `LORE_USE_RUNTOOL_FILTER_SQL`    | ON      | yes                         | SQL filter helpers                    |
| `LORE_USE_RUNTOOL_SEARCH`        | ON      | yes                         | Semantic-lane search                  |
| `LORE_USE_RUNTOOL_AGGREGATE`     | ON      | yes                         | Orphan-rate SQL aggregate             |
| `LORE_USE_RUNTOOL_BATCH_CREATES` | OFF     | no                          | Fact batch creates                    |

The test environment pins `LORE_USE_RUNTOOL=0` for the legacy REST/SDK corpus.
Consumer tests that exercise RunTool opt back in explicitly.

RunTool-capable auth is a service-init invariant. PATs (`ntn_` /
`development_ntn_`) and ntn-issued user tokens can use RunTool. `secret_...`
integration tokens cannot; Lore rejects them while any RunTool surface is
enabled instead of allowing every call to degrade to REST.

## REST Exception Registry

Remaining REST/SDK use is classified here so the exception set is explicit:

| Class            | Surfaces                                                                            | Status                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Auth             | `secret_...` integration tokens                                                     | Rejected during service initialization when any RunTool surface is enabled.                            |
| Capability gap   | SQL `has_more`, SQL canonicalization/date-column gaps, aggregate `hasAdvancedTools` | Allowed only through documented fallback branches; each branch emits `runtool-fallback=1 used-rest=1`. |
| Capability limit | Search 25-row window                                                                | Accepted as the semantic AI-search contract; surfaced as `capped: true`, not a REST fallback.          |
| Capability gap   | `update_page` anchored edit miss/ambiguity/delete warning                           | Falls back to the full-body REST markdown path and emits `runtool-fallback=1 used-rest=1`.             |
| Security gap     | `create_pages` partial-commit recovery                                              | Kept behind `LORE_USE_RUNTOOL_BATCH_CREATES=1`; fallback preserves per-input idempotency.              |
| Historical       | Silent REST fallback for RunTool-disabled or unsupported auth                       | Not allowed; callers either opt out explicitly or surface a fallback/unavailable event.                |

## Block Edit: `update_page`

Surface:

| Item         | Contract                                                                          |
| ------------ | --------------------------------------------------------------------------------- |
| Wrapper      | `updatePageContentViaRunTool(client, { pageId, updates, allowDeletingContent? })` |
| Tool command | `update_page` with `command: "update_content"`                                    |
| Callers      | Memory encoding fixes and topic-key audit append/rekey flows                      |
| Flag         | `LORE_USE_RUNTOOL_BLOCK_EDIT`                                                     |
| Tests        | `update-page.test.ts`, memory encoding/topic-key tests                            |

The wrapper validates page id shape, non-empty update batches, non-empty
anchors, and same-batch duplicate anchors before making a wire call. Those
validation failures are programmer errors and do not fall back.

Fall-back-able failures are represented by `RunToolBlockEditError`:

| Kind                  | Fallback behavior                                                                       |
| --------------------- | --------------------------------------------------------------------------------------- |
| `no_match`            | Existing REST/SDK full-body path decides whether it can still apply.                    |
| `multiple_matches`    | Existing path avoids ambiguous anchored replacement.                                    |
| `deletion_warning`    | Existing path preserves children unless the caller made an explicit delete decision.    |
| `restricted_resource` | Existing path handles capability or actor-shape rejection after init-time token checks. |

401, 429, 5xx, malformed responses, and unclassified 400s propagate so auth
refresh, shared backoff, and schema-drift surfacing continue to work.

## Batch Creates: `create_pages`

Surface:

| Item    | Contract                                                                                     |
| ------- | -------------------------------------------------------------------------------------------- |
| Wrapper | `createPagesViaRunTool({ client, parentDataSourceId, pages, chunkSize?, relationUrlBase? })` |
| Caller  | `FactService.createBatchWithDedup` when `useRunToolBatchCreates` is true                     |
| Flag    | `LORE_USE_RUNTOOL_BATCH_CREATES=1`                                                           |
| Tests   | `runtool.test.ts`, `sqlite-properties.test.ts`, `fact-batch.test.ts`                         |

This consumer is default-off and does not inherit from `LORE_USE_RUNTOOL`.
`create_pages` can partially commit a batch, so the opt-in must be explicit.

Key behavior:

- Empty input is a no-op.
- A single input stays on the normal `createWithDedup` path.
- Batches are chunked at `RUNTOOL_CREATE_PAGES_MAX_CHUNK` (100).
- Every page in one call shares one data-source parent.
- Notion REST property shapes are converted to RunTool's SQLite-style flat
  property map before dispatch.
- Relation URLs use the derived user-facing host for the target Notion API
  environment.

Failure handling preserves per-input isolation:

| Failure class                                    | Fallback                                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| First chunk fails with a pre-commit 4xx          | Fall back to fresh per-input creates after the already-completed dedup pass.                          |
| Transport failure, unknown status, or 5xx        | Re-probe via `createWithDedup` so a server-side commit with a lost response is absorbed.              |
| Later chunk fails after earlier chunks succeeded | Throw `BatchCreateError` with `committedIds`; credit the committed prefix and fall back for the tail. |
| 401/403/auth-class denial                        | Fall back per input and emit a once-per-process warning so operators see why RunTool is unavailable.  |

## SQL Filters: `query_data_sources`

Surface:

| Helper                               | Caller                                |
| ------------------------------------ | ------------------------------------- |
| `fetchEntityByNormalizedName`        | `EntityService.findByName`            |
| `fetchEntitiesByAliasSubstring`      | `EntityService.findByAlias`           |
| `fetchNearDuplicateCandidatePageIds` | `MemoryService.listForNearDuplicates` |
| `fetchAlreadyComparedPairKeys`       | `lore conflicts scan`                 |
| `comparedPairKey`                    | Conflict-scan pair normalization      |

Flag: `LORE_USE_RUNTOOL_FILTER_SQL`.

Tests: `query.test.ts`, `compat.test.ts`, entity/memory/conflict call-site
coverage.

Current SQL helper rules:

| Rule                                                                          | Reason                                                                           |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Arbitrary SQL stays in `src/notion/runtool/query.ts`, not in domain services. | Keeps the RunTool-specific dialect quarantined.                                  |
| Name and alias SQL over-fetch, then JS post-filter normalizes exact keys.     | SQLite cannot run Lore's `normalizeEntityKey` semantics.                         |
| Saturated name/alias windows fall back to REST.                               | Alias/name matches can be non-unique; REST pagination remains authoritative.     |
| Tag filters use `Tags LIKE '%"<tag>"%'` after tag validation.                 | Matches multi-select tokens exactly instead of substring-matching adjacent tags. |
| Relation filters use undashed ids in URL-shaped SQL cells.                    | The SQL gateway stores relation columns as JSON arrays of user-facing URLs.      |
| Null-permissive negative filters add `OR <column> IS NULL`.                   | Mirrors Notion REST `does_not_equal` / `does_not_contain` behavior.              |

Fallback:

| Error                                      | Behavior                                                         |
| ------------------------------------------ | ---------------------------------------------------------------- |
| 400 / `validation_error`                   | Re-throw; this is query-shape or gateway drift.                  |
| `SqlPartialResultError` / `has_more: true` | Fall back to REST/JS; partial SQL results are not authoritative. |
| Network, 401, 403, 429, 5xx, malformed     | Fall back per call and emit `runtool-fallback=1 used-rest=1`.    |

## SQL Aggregate: `query_data_sources`

Surface:

| Item            | Contract                                                                      |
| --------------- | ----------------------------------------------------------------------------- |
| Helper          | `querySubjectGroupCountsViaRunTool`                                           |
| Relation parser | `extractFirstRelationId`                                                      |
| Caller          | `lore migrate --build-entities --report-orphan-rate`                          |
| Flag            | `LORE_USE_RUNTOOL_AGGREGATE`                                                  |
| Tests           | `query.test.ts`, aggregate section in `compat.test.ts`, migrate command tests |

The aggregate helper groups Facts by `(SubjectEntity, Subject)` and counts each
group. The JS fold then applies Lore's canonical key expression
`subjectEntityId ?? computeSubjectKey(subject)` so SQL and JS enumeration share
one metric definition.

The emitted SQL is schematic:

```sql
SELECT
  "SubjectEntity" AS subjectEntity,
  "Subject"       AS subject,
  COUNT(*)        AS cnt
FROM "collection://<facts-data-source-id>"
-- Optional project scope:
WHERE "Project" LIKE ?
GROUP BY "SubjectEntity", "Subject"
```

Important constraints:

| Constraint                                          | Behavior                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| No `Valid Until` SQL column                         | The SQL path counts every fact; JS fallback passes `includeInvalidated: true` for parity. |
| Relation columns use URL-shaped undashed ids        | `extractFirstRelationId` rehydrates the first relation id to dashed Notion id form.       |
| No cursor/page-size knob                            | `has_more: true` throws `SqlPartialResultError` and falls back to JS enumeration.         |
| `query_data_sources` may require `hasAdvancedTools` | 403 falls back; operators can disable aggregate while leaving filter SQL enabled.         |

Fallback:

| Error                                                           | Behavior                                                               |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 400 / `validation_error`                                        | Re-throw; query-shape drift must be visible.                           |
| `SqlPartialResultError`, network, 401, 403, 429, 5xx, malformed | Fall back to JS enumeration and emit `runtool-fallback=1 used-rest=1`. |

The aggregate path is most useful for small vaults or narrow project scopes.
Large vaults usually saturate the SQL gateway and use JS enumeration.

## Search: `search`

Surface:

| Item    | Contract                                                                  |
| ------- | ------------------------------------------------------------------------- |
| Wrapper | `searchViaRunTool(client, { query, dataSourceId, pageSize? })`            |
| Caller  | `MemoryService.fetchSemanticPages` flag-on branch                         |
| Flag    | `LORE_USE_RUNTOOL_SEARCH`                                                 |
| Tests   | `search.test.ts`, search section in `compat.test.ts`, memory search tests |

The wrapper builds `data_source_url: collection://<memories-data-source-id>`,
sets `max_highlight_length: 0`, clamps `page_size` to 25, narrows hits to
Notion page ids, preserves `is_archived`, and returns a `saturated` flag.
It requires the response type to be `ai_search`; `workspace_search` and `none`
fail loudly because semantic relevance must not silently downgrade to lexical
workspace search.

RunTool `search` has no cursor and caps the raw window at 25. The caller falls
back to another path only in one structural case:

| Case                 | Reason                                                                    |
| -------------------- | ------------------------------------------------------------------------- |
| Empty composed query | RunTool requires `query.length >= 1`; the service uses DS-scoped listing. |

Requested limits above 25 and saturated 25-hit responses do not switch to REST.
The service accepts the RunTool window as the semantic relevance source and
surfaces saturation through `capped: true`.

403 `restricted_resource`, 401, 429, 5xx, malformed, validation errors, and
non-`ai_search` responses propagate. The wrapper still emits the
once-per-process restricted-resource warning before throwing. Cooperative
aborts propagate as aborts so `Promise.allSettled` discard behavior matches the
REST path.
