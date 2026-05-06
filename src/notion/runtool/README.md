# `src/notion/runtool/` — Quarantined RunTool Integration

> **Status: Phase 0 README + three runtime consumers (`create_pages`,
> `update_page`, `query_data_sources`) + one aggregate consumer.**
> PR #538 (issue #533) landed the shared
> `runTool<T>(client, tool, params)` dispatcher plus the
> `create_pages` slice (live-verified against the production Mail
> vault); PR #537 (issue #534) extends the surface with `update_page`
> / `update_content` for anchored markdown edits in `MemoryService`
> and `memory-encoding.ts`; PR #539 (issue #535) extends with
> `query_data_sources` SQL filter helpers wired into
> `EntityService.findByName` / `findByAlias`, `findNearDuplicates`,
> and the conflict scanner; issue #542 extends `query_data_sources`
> with the SQL-mode aggregate path consumed by
> `lore migrate --build-entities --report-orphan-rate` (the PF3-01
> orphan-rate metric). All consumers compose with the existing
> rate-limit + auth-refresh proxies via the shared
> `client.request()` dispatch path. The remaining read-path Phase 1+
> work (`search`, `LORE_USE_RUNTOOL_SEARCH`) is tracked under
> [issue #532](https://github.com/makenotion/lore/issues/532) and is
> NOT shipped here.
>
> Every contract assertion below is sourced from the pinned upstream
> commit named in "Pinned Schema Source"; runtime behavior on Lore's
> actual auth path is annotated as "needs runtime verification"
> wherever the code path could not be fully resolved by reading
> source. Issue #534's wrapper added runtime verification of the
> `update_page` error model — see "Canonical Error-Classification
> Vocabulary" below. Issue #535's wrapper added runtime verification
> of the `query_data_sources` SQL gateway column representations —
> see "Production-vault SQL gateway findings (2026-05-05)" below.
>
> **PR #538 live-verification (May 5 2026, prod Mail vault).**
> Two test fact rows were created via RunTool's `create_pages`
> endpoint against the production Mail vault Facts DB
> (`collection://5abdc6b6-...`) using the wrapper's exact wire
> format, then read back via `query_data_sources` to confirm the
> shape, then invalidated (`Valid Until = today`) per lore's "facts
> are never deleted" rule. Verified outcomes:
>
> 1. **Auth chain** — ntn-resolved user-actor token landed both
>    rows successfully against `api-dev.notion.com`.
> 2. **Wire format**:
>    - title / rich_text / select / number → flat primitives ✅
>    - date → 3-key expansion (`date:<col>:start`/`:end`/`:is_datetime`) ✅
>    - relation → JSON-stringified array of user-facing URLs ✅
>    - **Host coupling** (load-bearing): `https://www.notion.so/<id>`
>      is REJECTED on a dev workspace with `400 validation_error:
>      Invalid page URL ... for property X`. Bare ids and
>      `notion.com` URLs are likewise rejected. The relation URL
>      base must be derived from the API host —
>      `services.ts:deriveRelationUrlBase` is the single source
>      and PR #538's golden tests pin the mapping (`api-dev.notion.com`
>      → `dev.notion.so`, default → `www.notion.so`).
> 3. **Round-trip** — both rows queryable via SQL and visible in
>    the empirical schema with the converter's exact property keys.
>
> Verification rows (now invalidated, will not surface in default
> queries):
> - `358b35e6-e67f-817c-b6d8-cab40486a780` — primitive-only fact
> - `358b35e6-e67f-8146-9f4c-cbf3da3ab086` — fact with `Project` relation

## Why This Module Is Quarantined

Quan Nguyen on the Notion Public API team named two practical paths around
the gaps Lore filed in the public-API feedback package delivered to the
Notion API team on 2026-05-05:

1. Use the Notion MCP server directly. Works for agents but is not
   programmatic.
2. Call the underlying `RunTool` API. Schema lives in
   `makenotion/notion-next:src/server-publicApi/apis/ai_tools/params/RunToolParams.ts`.

Both halves matter:

> Except for file upload, the MCP is miles ahead of the api. — Quan

> RunTool is built as a public api, it is not publicly documented. We will
> make breaking changes in the future. — Quan

The first half justifies the experiment; the second constrains rollout. The
schema is therefore **vendored as a pinned subset** — never imported from
`notion-next` at build or runtime, never extended past the two read-path
wins below without an explicit issue, and gated behind opt-in feature flags.

## Pinned Schema Source

| Item | Value |
| ---- | ----- |
| Repo | `makenotion/notion-next` |
| Branch (snapshot reviewed) | `main` |
| Commit | `69cd144ac1e429229680b6fb24ec29bcea3e37ac` |
| Snapshot date | 2026-05-05 |

Per-file blob SHAs at the pinned commit:

| Path (under `src/server-publicApi/apis/ai_tools/`) | Blob SHA |
| -------------------------------------------------- | -------- |
| `params/RunToolParams.ts` | `b9370e41a29f2b784f8f7564c3ba08766d83f938` |
| `params/search/SearchToolParams.ts` | `d1f0b451a28fe2eaf3b86beed6b5c987438761f5` |
| `params/query_data_sources/QueryDataSourcesToolParams.ts` | `2bcab21355c6604e1d150543191f2584290cfcad` |
| `params/query_data_sources/QueryDataSourcesDataParams.ts` | `8faf522d1b7af92420a021818051c68395470da4` |
| `resources/RunToolResource.ts` | `b743e99863c2ecd254ab3a81b59e90621ba36095` |
| `resources/search/SearchResource.ts` | `d5a1db1a98082a17fd0f6d923fef1057579156d3` |
| `resources/search/InternalSearchResource.ts` | `0e85b9c8ad728c476b98adfc887f8aa9c2a6b733` |
| `resources/search/InternalSearchResultResource.ts` | `e82780637d6b54dd3477c3b7d4d39f508f90e753` |
| `resources/search/UserSearchResource.ts` | `9a1328974d25c08535b40a3ac1560653e96c8787` |
| `resources/query_data_sources/QueryDataSourcesResource.ts` | `5c7410744748326c660019e568ca89a73e973954` |
| `endpoints/RunTool.ts` | `9a48d3aa9c5b093cb6dad050f83297b16c9312c1` |

Every file the README cites for the documented contract is pinned. A
future schema-pin refresh updates this whole table at once so a
reviewer can diff blob-by-blob against the new commit.

### Refreshing the pin

When the upstream schema is refreshed, the pin update **must** happen as a
dedicated PR that:

1. Updates this table with the new commit + blob SHAs.
2. Re-runs the A/B harness (`compat.test.ts`, Phase 4) and pastes the diff
   summary in the PR body.
3. Calls out any breaking change in the request envelope, response shape,
   or capability gating.

## Endpoint And Method

`POST /v1/tools/run`

Source:
[`endpoints/RunTool.ts:142`](https://github.com/makenotion/notion-next/blob/69cd144ac1e429229680b6fb24ec29bcea3e37ac/src/server-publicApi/apis/ai_tools/endpoints/RunTool.ts)
— `export const Path = "/v1/tools/run" as const`. The endpoint is registered
with `isEndpointDocumented: false`; this is the load-bearing reason Lore
treats it as opt-in and pinned-schema. The endpoint is gated behind the
`ai_tools_public_api` Statsig feature flag at the server side.

Base URL is the same Notion REST host Lore already targets — `LORE_NOTION_BASE_URL`
when set, otherwise the SDK's default Notion API host. The wrapper must
NOT introduce a second base-URL knob; the existing
`createClient(token, baseUrl)` resolution chain in `src/notion/client.ts`
applies. Lore does not pin the SDK's default host literal in this README
so a hardcoded mismatch between RunTool wrapper and SDK cannot drift in.

## Request Envelope

The body is a discriminated union keyed by `type`:

```jsonc
{
  "type": "<tool_name>",
  "<tool_name>": { /* tool-specific params */ }
}
```

Use the **RunTool API tool names** in Lore code and docs:

| Tool name (RunTool API) | MCP-facing alias (do NOT use in Lore) |
| ----------------------- | ------------------------------------- |
| `search`                | `notion-search`                       |
| `query_data_sources`    | `notion-query-data-sources`           |
| `create_pages`          | `notion-create-pages`                 |
| `update_page`           | `notion-update-page`                  |

`RunToolParams.ALL_TOOLS` is the authoritative list. The MCP-facing names
are a separate aliasing layer; the wrapper must speak the API names so
schema drift in either layer surfaces as a type error.

The wrapper surface lands incrementally. PR #538 (`create_pages`)
and PR #537 (`update_page`) shipped the write-path slices ahead of
the read-path plan; PR #539 (issue #535) wired
`query_data_sources` for SQL filter pushdown. `search` remains the
last unshipped Phase 1+ entry and is tracked under issue #532:

```ts
// Shipped in PR #538 (issue #533):
runTool("create_pages", params)

// Shipped in PR #537 (issue #534):
runTool("update_page", params)

// Shipped in PR #539 (issue #535):
runTool("query_data_sources", params)

// Planned for issue #532 Phase 1+ (NOT yet implemented):
runTool("search", params)
```

### Response envelope (asymmetric with request)

The response body is **the bare per-tool resource shape** — there is NO
outer `{ type, [tool_name]: {...} }` wrapping mirroring the request.
`RunToolResource.Value` resolves through
`ToolImplementationsConfig[ToolName]["successResult"]` and the runtime
type is a `unionResource` over the per-tool resources directly.
Concretely:

- `create_pages` (shipped in PR #538) returns a
  `CreatePagesResource.Value` directly — `{ pages: Array<{ id }> }`
  per the pinned schema and verified live against the production
  Mail vault.
- `search` (planned for issue #532) returns a `SearchResource.Value`
  — itself a discriminated union of
  `InternalSearchResource.Value | UserSearchResource.Value`,
  discriminated by the inner `type` field (see "`search` Tool" below).
- `query_data_sources` (shipped in PR #539, issue #535) returns a
  `QueryDataSourcesResource.Value` directly
  (`{ results, has_more, data_source_ids? }`).

A Phase 1 wrapper that types its response as `{ type, [tool]: ... }`
(mirroring the request) will trip on the first call. Type the response
as the per-tool resource directly.

`RunToolParams.ALL_TOOLS` defines **20 tools** at the pinned commit:
`search`, `fetch`, `create_pages`, `update_page`, `move_pages`,
`duplicate_page`, `create_database`, `update_data_source`,
`create_comment`, `get_comments`, `get_teams`, `get_users`,
`answer_question`, `query_data_sources`, `query_database_view`,
`query_meeting_notes`, `list_agents`, `chat`, `create_view`,
`update_view`. (`answer_question`, `list_agents`, and `chat` are
`limited_configurations` tools — visible only in `local` /
`development` configurations and not on the public path Lore uses;
the README's table at the top of this section therefore lists only
the four issue-#532 names.) Every tool except `search` and
`query_data_sources` is **out of scope for issue #532**; a future
issue must explicitly add any others.

## Auth And Capability Requirements For ntn-Resolved Tokens

> **Lore-side scope warning.** RunTool requires a user-actor or
> workflow-bot token. Two of Lore's four supported auth paths
> (`LORE_NOTION_TOKEN` and the soft-deprecated `auth.token` in
> `.lore.yaml`) are integration secrets — public OAuth integrations
> from a Lore-team perspective — and will be rejected with 403 on
> every RunTool call. `NOTION_API_TOKEN` is ambiguous: it can be
> either an integration secret or an ntn-resolved token, depending
> on what the operator exported. Only the ntn-resolved path
> (`~/.config/notion/auth.json`, post-0.10.0 default) is guaranteed
> to satisfy RunTool's actor-type check. Phase 1's wrapper must
> detect the 403-from-integration-secret case explicitly — silently
> degrading every legacy-auth caller to "RunTool unavailable" is
> the correct behavior, but it must be loud enough that an operator
> on `LORE_NOTION_TOKEN` knows why their flagged-on calls never use
> the new path. The dogfood rollout messaging needs to call this
> out: flipping `LORE_USE_RUNTOOL=1` while still using
> `LORE_NOTION_TOKEN` is a no-op at best and an error-spam at
> worst.

### Confirmed from source

`RunTool.executeWithoutRequestMetadata` has **two parallel actor-type
paths**, not one:

1. **Workflow-bot fast path** — for every supported tool, an early
   `if (bodyParams.type === "<tool>" && bot.isWorkflowBot())` branch
   ([`endpoints/RunTool.ts:274-358`](https://github.com/makenotion/notion-next/blob/69cd144ac1e429229680b6fb24ec29bcea3e37ac/src/server-publicApi/apis/ai_tools/endpoints/RunTool.ts))
   dispatches directly to the per-tool helper (`search`,
   `queryDataSources`, etc.) using the bot itself as the actor.
   Workflow bots **never reach** `resolveRunToolUserActor`.

2. **Non-workflow path** — falls through to
   `resolveRunToolUserActor`
   ([`endpoints/RunTool.ts:96-129`](https://github.com/makenotion/notion-next/blob/69cd144ac1e429229680b6fb24ec29bcea3e37ac/src/server-publicApi/apis/ai_tools/endpoints/RunTool.ts))
   which:
   - **Personal bots** (`bot.getType() === "personal"`): returns
     `RequestLocalContext.metadata.effectiveActor` provided
     `botParentPointer` matches the effective actor's id; otherwise
     `ApiValidationError("User not found")`.
   - **User guest bots with `UserTable` parent**: loads the user via
     `environment.records.loadRecord(botParentPointer)` and returns
     them as the actor.
   - **Anything else** (public OAuth integration, workflow bot whose
     parent is not a User, anything not matching the above):
     `ApiRestrictedResourceError("Only public integrations can access this API.")`.

> **Naming hazard:** the error message "Only public integrations can
> access this API" fires when the actor is NOT a user-guest bot with a
> `UserTable` parent — i.e. the message text is the **inverse** of the
> rule. RunTool actually rejects public OAuth integrations and accepts
> only personal bots, workflow bots, and user-guest bots with a User
> parent. Phase 1's wrapper should translate this surfacing into a
> Lore-actionable message such as: "RunTool rejected this token; it
> looks like a public OAuth integration. RunTool requires a personal,
> workflow, or user-guest token from `ntn`."

### Dispatch order in `executeImpl`

Three gates run in sequence; understanding the order matters when
classifying a 403:

1. `isMcpClientAllowed` — workspace MCP-client allowlist
   ([`endpoints/RunTool.ts:399-425`](https://github.com/makenotion/notion-next/blob/69cd144ac1e429229680b6fb24ec29bcea3e37ac/src/server-publicApi/apis/ai_tools/endpoints/RunTool.ts)).
2. `publicApiRunToolRateLimit` — per-actor, per-tool rate-limit
   ([`endpoints/RunTool.ts:201-209`](https://github.com/makenotion/notion-next/blob/69cd144ac1e429229680b6fb24ec29bcea3e37ac/src/server-publicApi/apis/ai_tools/endpoints/RunTool.ts)).
   Runs **before** the workflow-bot capability check, so a workflow bot
   calling a disallowed tool still consumes rate-limit budget on the
   eventual rejection.
3. Workflow-bot capability allowlist (`getAllowedDirectMcpToolNames`)
   ([`endpoints/RunTool.ts:251-272`](https://github.com/makenotion/notion-next/blob/69cd144ac1e429229680b6fb24ec29bcea3e37ac/src/server-publicApi/apis/ai_tools/endpoints/RunTool.ts)),
   then per-tool dispatch.

### Workflow-bot capability gating

For workflow bots, `getAllowedDirectMcpToolNames` and
`getDirectToolAccessFlags` produce an allowlist
([`endpoints/RunTool.ts:251-272`](https://github.com/makenotion/notion-next/blob/69cd144ac1e429229680b6fb24ec29bcea3e37ac/src/server-publicApi/apis/ai_tools/endpoints/RunTool.ts)):

- `search` — `ALWAYS_SHOW`.
- `query_data_sources` — gated on `hasAdvancedTools` (Enterprise + AI
  workspace plan). `query_database_view` is the consolation tool for
  `hasAiAccess && !hasAdvancedTools` (Business+ with AI but no advanced
  tools).
- `query_meeting_notes` — gated on `hasAiAccess`.
- All write tools (`create_pages`, `update_page`, etc.) — `ALWAYS_SHOW` at
  the visibility layer; per-tool quotas apply downstream.

Source: `RunToolParams.ALL_TOOLS` capability predicates
([`params/RunToolParams.ts:258-298`](https://github.com/makenotion/notion-next/blob/69cd144ac1e429229680b6fb24ec29bcea3e37ac/src/server-publicApi/apis/ai_tools/params/RunToolParams.ts)).

A workflow bot calling a tool not in its allowed direct list returns:

```
ApiRestrictedResourceError(
  "This token does not have the required capabilities to use the <tool> tool."
)
```

### MCP client allowlist

`isMcpClientAllowed` runs against the workspace MCP-client allowlist
([`endpoints/RunTool.ts:399-425`](https://github.com/makenotion/notion-next/blob/69cd144ac1e429229680b6fb24ec29bcea3e37ac/src/server-publicApi/apis/ai_tools/endpoints/RunTool.ts)).
A workspace admin may have explicitly disallowed unknown MCP clients; in
that case every RunTool call from Lore returns:

```
ApiRestrictedResourceError(
  "This MCP client is not allowed in this workspace. A workspace admin can
  manage allowed MCP clients in the workspace settings."
)
```

Lore's existing client already sends a stable `User-Agent` (set from
the `USER_AGENT` constant in `src/notion/client.ts`); RunTool calls
inherit it through the same SDK path. Reference the constant when
writing wrapper docs or tests rather than the literal version, which
silently drifts on every release. Whether and how to surface this
error to operators is a Phase 1+ UX decision.

### Header

The Notion SDK v5 sends the resolved token as `Authorization: Bearer
<token>` for every request, RunTool included. There is no separate header
or capability namespace at the wire level. The auth resolution chain
(`NOTION_API_TOKEN` > ntn-resolved `~/.config/notion/auth.json` >
`LORE_NOTION_TOKEN` > `auth.token`) is unchanged.

### Open questions — runtime verification needed before Phase 2/3

These cannot be answered from source alone:

1. **Which actor type does an ntn-issued token resolve as on the
   server?** RunTool routes differently depending on whether the bot
   is `workflow`, `personal`, or `userGuestBot`-with-`UserTable`-parent
   (see "Auth And Capability Requirements" above). ntn tokens come
   from the workspace's Connections setting after the engineer
   authorizes ntn against their personal account, so the bot parent
   is almost certainly `UserTable` — but the *type* determines
   whether Lore's calls take the workflow-bot fast path (gated on
   `getAllowedDirectMcpToolNames`, capability-checked) or fall
   through to `resolveRunToolUserActor` (gated on user-guest-bot
   shape, capability-unchecked at this layer). Phase 1's first
   integration test should be: call `query_data_sources` with a
   trivial `SELECT 1 FROM "collection://..." LIMIT 0` and record the
   actor type and outcome (success / 403-with-message) in this
   README before Phase 3 wiring begins.

2. **Does the ntn-issued token's workspace have `hasAdvancedTools`?**
   This is a billing-plan question, not a code question. The Notion
   internal vault is on Enterprise + AI; the team's dogfood vault may
   not be. If Lore's target workspaces don't all have advanced tools,
   Phase 3 (aggregates) becomes degraded for some operators and we
   either fall back to the JS `GROUP BY` path or surface a guard error.

3. **Does the workspace block unknown MCP clients?** The
   `isMcpClientAllowed` check runs unconditionally. Notion's internal
   workspace policy may already allowlist `lore/...` user agents; the
   public-template Mail vault may not. Phase 1 should record both
   outcomes.

## Rate-Limit Accounting

### Confirmed from source

RunTool calls go through **two rate-limit checks**:

1. **Per-tool, per-actor RunTool quota.** `publicApiRunToolRateLimit({
   environment, actorId, toolName })` runs at the top of
   `executeWithoutRequestMetadata`
   ([`endpoints/RunTool.ts:201-209`](https://github.com/makenotion/notion-next/blob/69cd144ac1e429229680b6fb24ec29bcea3e37ac/src/server-publicApi/apis/ai_tools/endpoints/RunTool.ts)).
   Failures surface as the standard public-API rate-limit response
   (HTTP 429 with `Retry-After`). The bucket is keyed on `(actorId,
   toolName)` — `search` and `query_data_sources` quotas are
   independent of each other and of the standard REST per-token bucket.

2. **Block-write quota** (write tools only). `publicApiRunToolBlockRateLimitPreCheck`
   plus `incrementPublicApiRunToolBlockCount` count blocks written by
   `create_pages` / `update_page` / `move_pages` / `duplicate_page` /
   `create_comment`. Read tools (`search`, `query_data_sources`) skip
   this gate. The synchronous-block check is itself gated by the
   `public_api_block_creation_rate_limit_enabled` Statsig flag.

### How this composes with the existing REST/SDK bucket

The existing `src/notion/rate-limit.ts` token bucket targets Notion's
**~3 rps per-token guidance for the standard REST API**
(`DEFAULT_NOTION_REQUESTS_PER_SECOND = 3`,
`DEFAULT_NOTION_BURST_SIZE = 3`). RunTool's bucket is separate — but
**both buckets count requests that traverse the same `Authorization`
header**. The cleanest approach is to keep RunTool calls under the same
token bucket as REST calls so:

- A single Lore process never exceeds the lower of the two ceilings.
- Cross-tool fan-out (a memory search that issues a RunTool `search`
  followed by a REST `pages.retrieve` chain to hydrate relations) paces
  uniformly.
- The 429 backoff path already wired into `createLimitedClient` — including
  the `Retry-After` clamp at `MAX_RATE_LIMIT_BACKOFF_MS = 60_000ms` —
  applies regardless of which bucket surfaced the 429.

**Contract for Phase 1:** the RunTool client wrapper must share the
same client-side outbound rps gate as the SDK calls — i.e. the
`createLimitedClient` token bucket. A second parallel gate
(a fresh `pLimit(3)` inside `runtool/client.ts`, or a separate token
bucket) would silently double the effective rps and is forbidden by
issue #532's "composition" non-goal: "RunTool calls must compose with
the same configured request pacing/backoff used by the Notion client
wrapper." How that sharing is achieved (proxy reuse, bucket injection,
or shared limit handle) is a Phase 1 architecture decision; this
README pins only the contract, not the mechanism.

**Test invariant.** `src/notion/AGENTS.md`'s rate-limiting section
already requires a `rate-limit.test.ts` case for every new SDK call
site, because the recursive Proxy can silently bypass a
function-shape change with no type-level signal. Issue #534 landed
two RunTool-specific cases against the top-level `client.request`
dispatch path (one concurrency-cap assertion, one token-bucket
pacing assertion in `src/notion/rate-limit.test.ts`) plus a
companion auth-refresh test for `client.request` in
`src/notion/client.test.ts`. The shared dispatcher landing in
#532's Phase 1 must keep this coverage alive — when `runTool` folds
in as a separate top-level method, add an analogous
concurrency-cap + pacing case for it (and an auth-refresh case if
the dispatcher exposes a new top-level shape). Without that, a
future SDK refactor could silently drop the shared dispatcher out
of the wrap.

**Multi-process pacing.** `src/notion/AGENTS.md` already documents
that Notion enforces rate limits per access token, so a Lore process
running concurrently with the MCP server, with a hook spawn, or
across worktrees each pace independently at 3 rps locally — the
RunTool server bucket sees the union, bounded by
`DEFAULT_NOTION_CONCURRENCY × number of concurrent processes`. The
RunTool per-tool, per-actor server bucket adds a second
ceiling on top of this, but does not change the multi-process
arithmetic on Lore's side. Phase 1's wrapper does not need a new
mechanism for this; it inherits `createLimitedClient`'s posture.

### Error model

Confirmed shapes (from `@notionhq/server/helpers/publicApiError`):

- `ApiValidationError` — 400 family. Body shape matches Notion's standard
  `{ object: "error", code: "validation_error", message: "..." }`. The
  `update_page` wrapper landed in #534 classifies the
  `update_content`-specific shapes (`old_str did not match`, `old_str
  was not found`, `old_str matches more than once`) as fall-back-able
  `RunToolBlockEditError` of kind `no_match` / `multiple_matches`;
  unrecognized 400s propagate verbatim so the caller sees the actual
  server complaint.
- `ApiRestrictedResourceError` — 403. Used for unsupported actor types,
  workflow-bot capability denials, and workspace MCP-client allowlist
  rejection. The auth-refresh proxy CANNOT repair this (it refreshes
  only on 401); the `update_page` wrapper classifies it as
  fall-back-able (`restricted_resource`) with a once-per-process
  stderr warning so integration-secret operators see why a flagged-on
  call silently degrades. See "Canonical Error-Classification
  Vocabulary" below for the full kind table.
- Rate-limit failure — 429 with `Retry-After`. The body code Lore should
  expect is the same `rate_limited` family the v5 SDK already parses;
  the wrapper should NOT add a second 429 detection path. Per #534's
  shipped policy 429 propagates verbatim from the wrapper so
  `createLimitedClient`'s `extractRetryAfterMs` parser stays the
  single-source 429 path.
- 5xx — opaque server error; the wrapper propagates verbatim (NOT
  classifies as fall-back-able). The original Phase 0 reconnaissance
  drafted a "per-call fall back to REST/SDK" posture, but #534's
  implementation reversed that decision after considering the
  composition with `createLimitedClient`'s shared backoff: silently
  swallowing 5xx into a fallback would let the wrapper bypass the
  shared 429 backoff window that the SDK's own 429-shaped retries
  rely on. The consumer's outer try/catch decides whether a 5xx
  warrants escalation.

### Open questions — runtime verification needed

1. Is the per-tool RunTool quota looser, tighter, or equal to the 3 rps
   REST guidance? Phase 1 should measure with a trivial 25-call burst
   against a dev vault and record the answer here.
2. Does the surfaced `Retry-After` for a RunTool 429 differ in units or
   shape from the REST-bucket 429? The existing 429 path in
   `src/notion/rate-limit.ts` (`extractRetryAfterMs`, module-private
   today) handles both seconds and absolute-date `Retry-After` values;
   if Phase 1's RunTool wrapper composes through `createLimitedClient`
   (the contract above), it inherits that handling without writing a
   second parser. Confirm RunTool's `Retry-After` shape matches REST's
   so this composition is sound.

## `search` Tool — Input/Output Shape

### Input (`SearchToolParams.Value`)

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `query` | `string` (min length 1) | yes | Semantic query string. |
| `query_type` | `"internal" \| "user"` | no | "internal" = workspace+connectors; "user" = user-by-name/email lookup. **Workflow-bot variant omits this field — workflow bots can only do `internal`.** |
| `content_search_mode` | `"workspace_search" \| "ai_search"` | no | Force backend. Default = AI if available, else workspace. **Workflow-bot variant omits this — workflow bots are pinned to `workspace_search`.** |
| `data_source_url` | `string` | no | `collection://<data_source_id>` URL to scope search to one Lore database. THIS IS THE ONLY KNOB Lore needs for `searchHybrid` scoping. |
| `page_url` | `string` | no | Restrict to a page subtree. Not used by Lore. |
| `teamspace_id` | `string` | no | Restrict to a teamspace. Not used by Lore. |
| `filters` | `SearchFilterParam.Value` | no | Date range / creator-id filters. **This is the hook for `applySemanticPostFilters` — Lore's project / kind / status post-filters do NOT map cleanly here, but creator-id filters do.** |
| `page_size` | int 1-25, default 10 | no | Hard server cap of 25 — much smaller than `client.search`'s 100. Drives Phase 2 pagination math. |
| `max_highlight_length` | int 0-500, default 200 | no | 0 = omit highlights. Lore can use 0 to minimize response size. |

### Lore-relevant pagination behavior

`SearchToolParams` exposes no `start_cursor` field (no pagination cursor
in the request) and `InternalSearchResource` exposes no `next_cursor`
(no pagination cursor in the response). The only knob is `page_size`,
capped server-side at 25. **This is a hard divergence from REST
`client.search`, which paginates with `start_cursor`/`next_cursor` and
supports `page_size: 100`.** Phase 2 must runtime-verify the
no-cursor reading against a real call; the structural consequences
(impact on `SEMANTIC_SEARCH_MAX_PAGES` and the saturating-contains
loop) are Phase 2 design decisions, not Phase 0 contract.

### Output (`SearchResource.Value` — discriminated union)

`SearchResource.Value = InternalSearchResource.Value | UserSearchResource.Value`,
discriminated by the outer `type` field returned in the response. Lore's
memory-search use case exclusively issues `query_type: "internal"`
requests, which by contract return `InternalSearchResource.Value`; the
`UserSearchResource` arm is unused. The Phase 1 wrapper has two valid
postures:

- **Compile-time narrow.** Type the wrapper's `search` overload so a
  `query_type: "internal"` request returns `InternalSearchResource.Value`
  and a `query_type: "user"` request returns `UserSearchResource.Value`,
  using TypeScript's discriminated-union type narrowing.
- **Runtime narrow.** Accept any `SearchResource.Value`, assert
  `result.type` is one of `"ai_search" | "workspace_search" | "none"`
  (the `InternalSearchResource` arm) at the wrapper boundary, and
  surface a programming-error if the `UserSearchResource` arm
  (discriminator `"user_search"`) is ever returned.

Either is acceptable; both must avoid silently casting `UserSearchResource`
results into a memory-search consumer expecting `InternalSearchResource`.

The `InternalSearchResource` arm — the only one Lore consumes:

```ts
type InternalSearchResource = {
  type: "ai_search" | "workspace_search" | "none"
  results: Array<{
    id: string
    title: string
    url: string         // page ID for Notion results, full URL for connector results
    type: string        // discriminator (page, database, etc.)
    highlight: string   // empty when max_highlight_length=0
    timestamp: string
    is_archived?: boolean
  }>
}
```

Two Lore-specific contract observations:

1. **`url` is a page-ID for Notion results.** Lore can pass that ID
   directly to `pages.retrieveMarkdown` / hydrate-relations — no URL
   parsing needed. External connector results (Slack, Linear, Drive)
   have a full URL and are not Lore page candidates.
2. **No score field.** Each result carries `id`, `title`, `url`,
   `type`, `highlight`, `timestamp`, optional `is_archived` — that's
   the entire shape. REST `client.search` doesn't return scores
   either, so this is not a regression, but it's worth noting that
   any cross-branch fusion built on rank order (e.g. RRF) sees
   ordering and possibly score-scale differences from REST. Quantifying
   that divergence is the A/B harness's job in Phase 4.

## `query_data_sources` Tool — Input/Output Shape

### Input (`QueryDataSourcesToolParams.Value`)

The body wraps `data` in an outer envelope:

```jsonc
{
  "type": "query_data_sources",
  "query_data_sources": {
    "data": { /* SQL mode OR view mode — discriminated by `mode` */ }
  }
}
```

#### SQL mode (default)

| Field | Type | Required |
| ----- | ---- | -------- |
| `data_source_urls` | `string[]` | yes — `collection://<data_source_id>` for each table referenced in `query` |
| `query` | `string` | yes — SQLite. Use the data-source URL **as the table name**, fully quoted: `SELECT * FROM "collection://abc..." WHERE ...` |
| `mode` | `"sql"` | no — defaults to `"sql"` |
| `params` | `string[]` | no — parameterized values for `?` placeholders. Use `"__YES__"` / `"__NO__"` for checkbox boolean. |

#### View mode

| Field | Type | Required |
| ----- | ---- | -------- |
| `mode` | `"view"` | yes |
| `view_url` | `string` | yes — full URL with `?v=<view_id>` |

Lore's aggregate use case (orphan-rate computation in
`entity-migration.ts`) is **SQL mode only**. View mode is documented for
completeness but is not part of the issue-#532 scope.

### Output (`QueryDataSourcesResource.Value`)

Source: `resources/query_data_sources/QueryDataSourcesResource.ts` at
blob SHA `5c7410744748326c660019e568ca89a73e973954`.

```ts
type QueryDataSourcesResource = {
  // Required:
  results: Array<Record<string, string | number | boolean | string[] | null>>
  has_more: boolean
  // Optional:
  data_source_ids?: string[]    // "only present for SQL queries" (per resource description)
}
```

Each row is a flat record keyed by the SQL output column name. Cell
values come from `SQLiteDatabasePropertyValue` and are typed as
`string | number | boolean | string[] | null` via `unionResource` plus
`nullableResource`.

Two Lore-specific contract observations:

1. **Aggregates collapse to scalar columns.** A `SELECT
   SubjectEntity, COUNT(*) AS cnt FROM "collection://..." GROUP BY
   SubjectEntity` returns rows of `{SubjectEntity: string|null, cnt:
   number}` — the shape `entity-migration.ts`'s orphan-rate metric
   needs. Phase 3 evaluates whether moving the JS `GROUP BY` into
   SQL is worth the runtime cost.
2. **No body content.** The result is property data only — no rich
   text body, no children blocks. Any downstream caller that needs
   the page body must follow up with `pages.retrieveMarkdown`. This
   is fine for the orphan-rate use case (which only needs property
   relations and counts) but constrains the primitive's reusability
   to read-only aggregate workloads.

### Pagination

`QueryDataSourcesDataParams` exposes **no cursor, no offset, and no
explicit `page_size`** input field. The response carries
`has_more: boolean` but the request envelope offers no documented way
to request the next page. Three takeaways for Phase 1+:

1. **Phase 1 must runtime-probe the actual server cap.** Call a
   trivial unfiltered `SELECT * FROM "collection://..." LIMIT 99999`
   against a vault large enough to exceed the server cap, observe the
   `has_more` response, and record the inferred cap value in this
   README before Phase 3 wiring begins.
2. **Phase 3 must define behavior on `has_more === true`.** Lore's
   orphan-rate use case is bounded by `SubjectEntity` cardinality
   (small in practice on the Mail vault — pre-PF3-01 baseline ~445
   distinct subjects) so a single call almost certainly suffices.
   The wrapper still has to either (a) error explicitly on
   `has_more === true` so callers cannot silently consume a partial
   result, OR (b) fall back per-call to REST `dataSources.query` +
   JS `GROUP BY` for the full set. Phase 3 picks one.
3. **Cap-induced fallback is distinct from 403/429 fallback.** The
   fallback counter Phase 3 maintains should distinguish "fell back
   because of capability gate" (403) from "fell back because of
   rate-limit pressure" (429) from "fell back because the result
   set exceeded the server cap" (200 with `has_more: true`). The
   first is structural (per-workspace plan tier); the second is
   operational; the third is data-shape — different operator
   actions follow.

### Capability gate is the bigger risk

`query_data_sources` requires `hasAdvancedTools` (Enterprise + AI),
gated server-side. Phase 3 wiring must therefore plan for a 403
response shape on workspaces below that plan tier: the fallback
contract from issue #532 ("If a RunTool call fails while the flag is
on, fall back per call to the existing REST/SDK path and
increment/log a fallback counter") covers this case. The specific
fallback policy — when, how loudly, and whether to mute repeat 403s
within a process — is a Phase 3 design decision, not a Phase 0
contract.

## Phase 0 Acceptance Re-Check

| Phase 0 deliverable (issue #532) | Status |
| -------------------------------- | ------ |
| Endpoint and method | Confirmed: `POST /v1/tools/run` |
| Request envelope shape and exact tool names | Confirmed; tool names use API form (`search`, `query_data_sources`) |
| Auth header / capability requirements for ntn-resolved tokens | Confirmed actor-type rejection for public integrations; three-outcome enumeration (workflow-bot fast path / personal-bot via `effectiveActor` / user-guest-bot via `loadRecord`) flagged for Phase 1 runtime probe |
| Rate-limit accounting | Confirmed two-bucket model; composition contract for Lore's wrapper documented; per-tool quota magnitude flagged for Phase 1 runtime measurement |
| `search` input/output shape, pagination, result IDs, score/highlight | Confirmed; cursor-pagination divergence from REST documented |
| `query_data_sources` SQL input/output, aggregate result representation, capability gating | Confirmed; `hasAdvancedTools` gate documented |
| Source commit/blob SHA for the pinned schema | Confirmed table above |

A reviewer without `notion-next` repo access can read this file alone and
understand the RunTool contract well enough to design the Phase 1 client
and audit the Phase 2/3 wrappers.

## Module State

Two runtime consumers landed: `create_pages` (PR #538 / issue #533)
and `update_page` (PR #537 / issue #534). Both compose with the
existing rate-limit + auth-refresh Proxies via the shared
`client.request()` dispatch path.

### Landed runtime surface

| File | Issue | Purpose |
| ---- | ----- | ------- |
| `client.ts` | #533 + #534 | Shared `runTool<T>(client, tool, params)` dispatcher (PR #538). PR #537 extended it with the `update_page` consumer surface (`runUpdatePageContent`, `RunToolBlockEditError`, validation-error classifier, once-per-process `restricted_resource` stderr warning). |
| `types.ts` | #533 + #534 + #535 | Pinned subset of `RunToolParams`. Today: `create_pages` (#533), `update_page` (#534), and `query_data_sources` (#535) request / response shapes plus the `RunToolRequestMap` / `RunToolResponseMap` tool-name maps. |
| `flag.ts` | #534 + #535 | `LORE_USE_RUNTOOL` parent kill-switch + per-consumer sub-flags (`LORE_USE_RUNTOOL_BLOCK_EDIT` for #534, `LORE_USE_RUNTOOL_FILTER_SQL` for #535) with parent-inherit. Default off. |
| `update-page.ts` | #534 | High-level `updatePageContentViaRunTool` consumer wrapper with pre-call validation (page-id shape, empty / duplicate `oldStr`). |
| `query.ts` | #535 + #542 | SQL filter helpers (#535) consumed by `EntityService.findByName` / `findByAlias`, `MemoryService.listForNearDuplicates`, and `lore conflicts scan`; SQL aggregate helper `querySubjectGroupCountsViaRunTool` (#542) consumed by `lore migrate --build-entities --report-orphan-rate`. Throws `SqlPartialResultError` on `has_more: true` to route saturated windows through the per-call REST/JS fallback. |
| `error-helpers.ts` | #535 | `isSqlValidationError` (400 / `validation_error` classifier), `logRunToolFallback` (LORE_DEBUG=1 stderr line), `SqlPartialResultError`, `warnRunToolIntegrationSecretOnce` (F5 once-per-process integration-secret warning). |
| `index.ts` | #534 + #535 + #542 | Public surface — re-exports `runTool`, the `update_page` consumer, the #535 SQL filter helpers, the #542 SQL aggregate helper, and every per-consumer flag accessor. |
| `update-page.test.ts` | #534 | Mocked HTTP coverage for the `update_page` wrapper: success / no-match / multiple-matches / deletion-warning / restricted-resource (× 2: happy + once-per-process) / 401 / 429 / 5xx / malformed / generic-400 rejection / pageId shape validation, plus a real-`Client` integration test asserting the SDK builds the canonical URL `https://api.notion.com/v1/tools/run`. |
| `create-pages.ts` | #533 | Chunked batch-create wrapper consumed by `FactService.createBatchWithDedup` for auto-`mentions` fact emission. Exposed via `LORE_USE_RUNTOOL_BATCH_CREATES=1` (default off, **does NOT inherit from the parent `LORE_USE_RUNTOOL` quarantine knob** per security review S2 — the write-path opt-in must be loud because of the partial-commit failure mode). Server cap pinned at 100 pages per call (Notion MCP `notion-create-pages` tool's `pages.maxItems`); chunk size clamps to that ceiling. Partial-commit handling is first-class via `BatchCreateError.committedIds`. Tail fallback re-probes via `createWithDedup` on transport-class / 5xx failures per `classifyTailFallback`. |
| `runtool.test.ts` | #533 | Mocked HTTP success / 401 / 403 / 429 / 5xx / malformed / unsupported-tool-name cases for the shared dispatcher with `create_pages`-shaped fixtures. |
| `sqlite-properties.ts` / `sqlite-properties.test.ts` | #533 | Notion-REST → SQLite-flat property converter for `create_pages` payloads. |

The `restricted_resource` 403 fall-back posture introduced by #534
(auth-refresh cannot repair it; integration-secret operators
silently degrade with a once-per-process stderr warning) is the
canonical reference for future RunTool consumers — see
"Canonical Error-Classification Vocabulary" below.

### Phase 1+ pending (still out of scope)

Issue #532 tracks the broader rollout. Pending deliverables:

- `search` consumer under a `LORE_USE_RUNTOOL_SEARCH` sub-flag. When
  it lands, the `RunToolRequestMap` / `RunToolResponseMap` in
  `types.ts` extend with the `search` shape in a follow-up PR without
  touching the shared dispatcher.
- `search.ts` — request/response mapper between the RunTool `search`
  shape and Lore's domain `MemorySearchResult[]`.
- Phase 4 default-on rollout — gated by the criteria in "Default-On
  Criteria" of issue #532.

Default flag state stays OFF for every consumer until those criteria
are met. (`query_data_sources` shipped in PR #539 — see `query.ts`,
`compat.test.ts`, and `LORE_USE_RUNTOOL_FILTER_SQL` in `flag.ts` —
and is no longer pending.)

## Canonical Error-Classification Vocabulary

The `update_page` wrapper landed in issue #534 introduces the
fall-back-able-error vocabulary that future RunTool consumers must
share. The shared dispatcher landing in #532's Phase 1 will key
error-classification on these exact strings; a sibling PR using a
different spelling has a normalization debt that must be resolved
IN that PR before it merges.

| Kind | Trigger | Recovery |
| ---- | ------- | -------- |
| `no_match` | `update_content`'s `old_str` was absent from the page body | Caller falls back to existing REST/SDK path |
| `multiple_matches` | `old_str` matched more than once and `replace_all_matches` was unset | Caller falls back; picking one implicitly is forbidden |
| `deletion_warning` | The edit would remove child pages or databases and `allow_deleting_content` was not opted in | Caller falls back to preserve children |
| `restricted_resource` | 403 RestrictedResource — the actor-type / MCP-client allowlist / workflow-bot capability gate rejected the call | Caller falls back; auth-refresh CANNOT repair (refresh only fires on 401). Wrapper emits a once-per-process stderr warning |

**Naming**: `restricted_resource` mirrors `APIErrorCode.RestrictedResource`
exactly; the underscored snake_case matches the SDK's public enum
spelling. A bare `"restricted"` on a sibling PR (e.g. an in-flight
`#539`) is a vocabulary debt that must be aligned before the shared
dispatcher lands. Operators reading mixed logs need one canonical name
to grep for.

The `RunToolBlockEditError` class carries this `kind` discriminator
plus the original SDK error as `cause` (ES2022 native channel) so
call sites branch deterministically on the kind without inspecting
strings.

## Issue #535 Slice — `query_data_sources` SQL Filter Helpers

Issue #535 wires the third RunTool consumer: SQL filter pushdowns for
the entity name / alias lookup, near-duplicate candidate fetch, and
the conflict scanner's already-judged check. The helpers route
through the same shared `runTool<T>(client, "query_data_sources",
params)` dispatcher PR #538 landed; no separate fetch path, no
parallel rate-limit gate, no `RunToolError` class.

### Surface

| File | Purpose |
| ---- | ------- |
| `query.ts` | Domain adapters: `fetchEntityByNormalizedName`, `fetchEntitiesByAliasSubstring`, `fetchNearDuplicateCandidatePageIds`, `fetchAlreadyComparedPairKeys`, `comparedPairKey`. Arbitrary SQL stays out of `src/core/`. Each helper takes a `Client` and dispatches via `runTool(client, "query_data_sources", params)`. |
| `types.ts` | Pinned subset of `QueryDataSourcesToolParams` + `QueryDataSourcesResource` — `QueryDataSourcesSqlData`, `RunToolQueryDataSourcesParams`, `RunToolQueryDataSourcesResponse`, `SqlCellValue`, `SqlResultRow`. Plus `dataSourceUrl(id)` helper and `isQueryDataSourcesResponse` structural guard. |
| `flag.ts` | `isRunToolFilterSqlEnabled(env)` — defaults to the parent `LORE_USE_RUNTOOL` value, off by default. |

### Scope of the SQL slice

| Target | Status |
| ------ | ------ |
| `EntityService.findByName` | Wired on the SQL path. SQL issues one parameterized `LOWER(Name) LIKE '%key%'` substring query and the JS post-filter narrows back to exact `normalizeEntityKey(rawName) === key` matches with archived-row gating. Saturated cap (100) falls through to REST. |
| `EntityService.findByAlias` | Wired on the SQL path. SQL issues one parameterized `LOWER(Aliases) LIKE '%key%'` substring query; JS post-filter narrows via `parseAliases` + `normalizeEntityKey` for exact alias-token equality and rejects substring-only false positives (e.g. `"User"` against stored `"UserService"`). Saturated cap (100) ALWAYS falls through to REST regardless of SQL match count, since aliases are deliberately non-unique and the REST paginated walk is authoritative. |
| `findNearDuplicates` `Status IN (...)` | Wired on the SQL path via `MemoryService.listForNearDuplicates`. The decision-path's `accepted | proposed` whitelist is pushed before `LIMIT N`. |
| `findNearDuplicates` `Kind NOT IN (...)` | Wired on the SQL path. The memory probe's `excludeKinds: ["decision"]` narrows server-side; the JS post-filter is a defense-in-depth backstop. |
| `findNearDuplicates` tag scoping | Wired on the SQL path via the verified exact-token JSON-quoted form `Tags LIKE '%"<tag>"%'`. SQL applies tag membership BEFORE `LIMIT`, identical to REST `multi_select.contains` semantics. Verified 2026-05-05 against the production vault: substring `%refactor%` matches `"refactor-old"` / `"refactor-trade-off"` (false positives), but the JSON-quote-anchored `%"refactor"%` requires the closing `"` and only matches discrete tokens. Tag values validated against `^[a-zA-Z0-9][a-zA-Z0-9-]*$` as defense in depth against LIKE special characters. |
| `Compared With` negative relation checks | Wired on the SQL path in `lore conflicts scan`. One server-side targeted query per project pre-builds an unordered pair-key set (`<lo>::<hi>`) over rows whose `Compared With` relation is non-empty. JS post-filter then runs O(1) Set lookups instead of array `.includes` against eagerly-loaded relation arrays. |

### Production-vault SQL gateway findings (2026-05-05)

Verified directly against `~/Developer/Notion/Mail` via
`mcp__notion__notion-query-data-sources` (read-only):

- **Relation columns store JSON arrays of full URLs containing the
  undashed page id form**, e.g. `"[\"https://dev.notion.so/<undashed-uuid>\"]"`.
  A `LIKE '%<dashed-uuid>%'` returns 0 rows. The SQL helpers undash
  via `id.replace(/-/g, "")` before binding into the LIKE pattern.
  Empty-relation surface forms observed: `NULL`, empty string, and
  the literal `[]`; the unscoped clause OR's all three.
- **Multi-select columns (`Tags`) store JSON arrays of double-quoted
  strings**: `["tag1", "tag2"]`. SQLite's bare `LOWER(Tags) LIKE '%tag%'`
  substring-matches across token boundaries (`"refactor"` would match
  `"refactor-old"`, diverging from REST). The verified-against-vault
  fix is the JSON-quote-anchored exact-token form
  `Tags LIKE '%"<tag>"%'` — the closing `"` ensures only discrete
  tokens match. The helper pushes this predicate server-side ahead of
  `LIMIT`, with kebab-case validation against
  `^[a-zA-Z0-9][a-zA-Z0-9-]*$` for defense in depth.
- **`archived` is NOT a valid SQL column** (`no such column: archived`).
  The SQL gateway appears to filter archived rows out of the result
  set by default; no client-side `archived = 0` clause is needed
  (or possible). Callers that need to confirm archival status
  retrieve via `pages.retrieve` and read
  `PageObjectResponse.archived`.
- **`last_edited_time` and `lastEditedTime` are NOT valid SQL columns**.
  `createdTime` is. The near-duplicate probe's candidate pool is
  JS-scored by trigram similarity afterwards, so omitting `ORDER BY`
  is the safe shape — gateway-default order is acceptable.
- **`Valid Until` (and every spelling: `validUntil` / `valid_until` /
  `ValidUntil`) is NOT a valid SQL column** on the Facts data
  source either. Verified 2026-05-06 against the dogfood vault.
  Same gateway-side restriction as `last_edited_time`. Issue #542's
  aggregate helper consequently can't filter invalidated facts
  server-side; the migrate-time call site preserves equivalence by
  passing `includeInvalidated: true` to its JS fallback.

### Null / missing-property semantics

Documented at each SQL composition site in `query.ts`; pinned by tests
in `runtool.test.ts`:

- `Kind NOT IN (?, ?, …)` → composed as
  `Kind NOT IN (...) OR Kind IS NULL` so a row with no Kind passes,
  matching Notion's `select.does_not_equal` null-permissive posture.
- `Status IN (?, ?, …)` → null-restrictive on its own, matching the
  REST path's `select.equals` whitelist (a row with no Status fails
  on both branches).
- `Status NOT IN (?, ?, …)` (the default-exclude-proposed shim in
  `MemoryService.listForNearDuplicates`) → composed with the same
  `OR Status IS NULL` allowance so the SQL branch matches REST's
  `does_not_equal` posture.
- `Keywords NOT LIKE '%__lore-cleanup-orphan%'` → composed with
  `OR Keywords IS NULL` so a row without Keywords passes, mirroring
  the REST path's `rich_text.does_not_contain` posture.

### Per-call fallback

Every SQL call site is wrapped in a `try { … } catch (err) { … }`
that branches on the SDK error fields (the same vocabulary the
`update_page` wrapper uses):

- `err.status === 400` / `err.code === "validation_error"` →
  re-throw. Indicates query-shape drift (column rename, gateway
  syntax change, parameter binding shape change). Silent fallback
  would mask a permanent SQL-rollout failure as "REST path always
  ran." The error message carries the gateway's specifics.
- All other errors (network, 5xx, 401, 403, 429) → fall through to
  the REST/SDK path silently for the user but visibly under
  `LORE_DEBUG=1`.

The existing REST path is the one tested under `npm test`'s 4500+
assertions; the SQL path is opt-in behind
`LORE_USE_RUNTOOL_FILTER_SQL=1` (defaults to the parent
`LORE_USE_RUNTOOL` value).

### Default-off invariant

With `LORE_USE_RUNTOOL=0` and `LORE_USE_RUNTOOL_FILTER_SQL=0` (the
default), every byte of REST behavior is preserved. The
`compat.test.ts` "flag-off invariant" test pins this against an
identical fixture corpus, and the existing 4500+ tests cover the
REST path itself.

## Issue #542 Slice — `query_data_sources` SQL Aggregate Helper

Issue #542 extends the `query_data_sources` consumer surface with a
server-side aggregate helper (`querySubjectGroupCountsViaRunTool` in
`query.ts`) consumed by `lore migrate --build-entities
--report-orphan-rate` to compute the PF3-01 orphan-rate metric. The
helper routes through the same shared
`runTool<T>(client, "query_data_sources", params)` dispatcher PR
#538 landed; no separate fetch path, no parallel rate-limit gate,
no `RunToolError` class.

### Surface

| File              | Purpose |
| ----------------- | ------- |
| `query.ts`        | Aggregate adapter: `querySubjectGroupCountsViaRunTool` issues a single SQL query that groups facts by `(SubjectEntity, Subject)` and counts per group. Throws `SqlPartialResultError` on `has_more: true`. Plus `extractFirstRelationId` — relation column rehydration helper that converts the JSON-array-of-URLs SQL gateway value into the canonical dashed Notion id form so the aggregate fold's metric key matches the JS enumeration path's. |
| `flag.ts`         | `isRunToolAggregateEnabled(env)` — defaults to the parent `LORE_USE_RUNTOOL` value, off by default. Distinct from the filter-SQL flag because aggregate queries traverse the `hasAdvancedTools` capability gate (Enterprise + AI workspaces only); operators rolling out RunTool need to flip filter-SQL and aggregate independently per workspace tier. |
| `index.ts`        | Re-exports `querySubjectGroupCountsViaRunTool`, `extractFirstRelationId`, `SqlSubjectGroupCount`, and `isRunToolAggregateEnabled`. |

### Wired call site

`lore migrate --build-entities --report-orphan-rate` is the
canonical first consumer (see
[issue #542](https://github.com/makenotion/lore/issues/542)). The
methodology is documented at the spec level in
`src/core/AGENTS.md` ("Measuring whether `--build-entities`
collapsed the orphan graph"); the wired implementation pair lives in:

- `src/notion/runtool/query.ts:querySubjectGroupCountsViaRunTool` —
  SQL aggregate path.
- `src/core/entity-migration.ts:computeOrphanRateFromAggregateRows`
  / `computeOrphanRateFromFacts` — both paths funnel through
  `foldOrphanRateGroups`, which keys each fact on
  `subjectEntityId ?? computeSubjectKey(subject)` exactly per the
  PF3-01 spec.
- `src/cli/commands/migrate.ts:runOrphanRateReport` — driver that
  branches on `isRunToolAggregateEnabled()` and falls back per-call
  to the JS enumeration path on every non-`validation_error`
  failure (capability gate / rate-limit / network / saturated
  `has_more: true` / malformed response).

### SQL shape

The query template below is **schematic**: the actual emitted SQL
substitutes the live data-source URL via `dataSourceUrl(id)` from
`types.ts` and the `quoteTable(url)` helper at the call site. The
`<facts-data-source-id>` placeholder reads as a literal in this
README; pin the wire shape via `query.test.ts` regex assertions
rather than copy-pasting:

```sql
SELECT
  "SubjectEntity" AS subjectEntity,
  "Subject"       AS subject,
  COUNT(*)        AS cnt
FROM "collection://<facts-data-source-id>"
-- Optional, when `projectId` is provided:
WHERE "Project" LIKE ?  -- bound: '%<undashed-projectId>%'
GROUP BY "SubjectEntity", "Subject"
```

**Why group by both columns.** The metric key is a JS expression
`subjectEntityId ?? computeSubjectKey(subject)`. SQLite's `LOWER()`
is ASCII-only and the SQL gateway carries no `computeSubjectKey`
UDF; the helper deliberately under-narrows server-side. `GROUP BY`
emits one row per `(SubjectEntity, raw Subject)` distinct pair; the
JS folder applies `computeSubjectKey` over the raw Subject and
collapses case-variant rows that share a canonical key. Same
narrow-then-rematch posture as `fetchEntityByNormalizedName` (#535).

**No `LIMIT` clamp** other than the gateway's implicit cap. The
metric is structurally bounded by `(SubjectEntity, Subject)`
distinct-pair cardinality (~445 distinct subjects on the pre-PF3-01
Mail vault baseline; 263 canonical groups across 916 facts on the
dogfood vault as of 2026-05-06). If the gateway clamps via
`has_more: true`, the helper throws `SqlPartialResultError` and the
caller falls through to JS enumeration rather than consume a
partial aggregate.

### Date / project / `Valid Until` column semantics

- **No `Valid Until` filter.** Notion's SQL gateway does not expose
  date columns. Production-vault verification on 2026-05-06 against
  the dogfood vault confirmed `"Valid Until"`, `validUntil`,
  `valid_until`, and `ValidUntil` all fail with `no such column`.
  Same gateway-side restriction as the README's pre-existing
  `last_edited_time` / `lastEditedTime` finding. The aggregate query
  consequently counts EVERY fact in scope, including invalidated
  rows. The migrate-time call site keeps the JS fallback semantically
  equivalent by passing `includeInvalidated: true` to
  `services.facts.queryBySubject`. The PF3-01 spec wording ("snapshot
  every live fact") shifts to "snapshot every fact" for the wired
  metric — operationally unchanged because invalidated facts
  contributed subjects to the canonical grouping just like live ones
  did.
- **`Project`** is a Notion `relation` column. Production-vault
  verification (PR #538 / 2026-05-05) confirmed relation columns
  store JSON arrays of full URLs containing the **undashed** id
  form. The helper passes `%<undashed-projectId>%` into the LIKE
  pattern via the same `undash()` posture
  `fetchNearDuplicateCandidatePageIds` adopted.
- **`SubjectEntity`** (selected, not filtered) is a single-relation
  Notion `relation` column with the same JSON-array-of-URLs
  representation. The fold extracts the first id via
  `extractFirstRelationId` and rehydrates to the canonical dashed
  form so the metric key matches `Fact.subjectEntityId` (always
  dashed by `pageToFact`).

### Per-call fallback

The migrate command site wraps the SQL call in a
`try { … } catch (err) { … }` that branches on the SDK error
fields, same vocabulary as the filter-SQL helpers:

- `err.status === 400` / `err.code === "validation_error"` →
  re-throw. Indicates query-shape drift (column rename, gateway
  syntax change). Silent fallback would mask a permanent
  SQL-rollout failure as "JS path always ran." The error message
  carries the gateway's specifics.
- All other errors (network, 5xx, 401, 403, 429,
  `SqlPartialResultError`) → fall through to the JS enumeration
  path via `services.facts.queryBySubject("", { allowUnfiltered:
  true })`. Logs one `[lore] partial-failure: source=
  orphan-rate-aggregate runtool-fallback=1` line under
  `LORE_DEBUG=1`.

The JS enumeration path is the canonical fallback and is the
default execution path when `LORE_USE_RUNTOOL_AGGREGATE=0`. It is
the path tested under `npm test`'s existing assertions; the SQL
path is opt-in behind `LORE_USE_RUNTOOL_AGGREGATE=1` (defaults to
the parent `LORE_USE_RUNTOOL` value).

### Default-off invariant

With `LORE_USE_RUNTOOL=0` and `LORE_USE_RUNTOOL_AGGREGATE=0` (the
default), every byte of `--report-orphan-rate` behavior is
deterministic JS enumeration. The aggregate code path runs only
when the operator opts in.

### Runtime verification (2026-05-06, dogfood vault)

- **End-to-end aggregate**: `lore migrate --build-entities
  --report-orphan-rate --dry-run --allow-unscoped` with
  `LORE_USE_RUNTOOL_AGGREGATE=1` issues exactly one `tools/run`
  call on the wire (observed via `LORE_DEBUG=1`). The default JS
  enumeration path on the same vault inspects 924 facts across
  269 canonical groups → 14.5% orphan rate (counts including
  invalidated; the live-only count is ~916 facts / 263 groups /
  12.9%).
- **`Valid Until` filter rejected**: every spelling
  (`"Valid Until"`, `validUntil`, `valid_until`, `ValidUntil`)
  fails with `Failed to execute query: no such column`. Documented
  above; the helper drops the WHERE clause on the date column.
- **`has_more: true` is structural for non-trivial vaults.**
  Verified 2026-05-06 against the dogfood vault: the GROUP BY over
  924 facts produces 269 distinct rows, and the SQL gateway clamps
  the response with `has_more: true`. The aggregate helper throws
  `SqlPartialResultError` per its documented contract; the
  migrate-time call site falls through to JS enumeration. This is
  the **expected production posture** for any vault with more than
  approximately 100 distinct `(SubjectEntity, Subject)` pairs —
  which means most non-trivial Lore vaults. The aggregate path's
  practical value is therefore limited to small vaults / narrow
  project scopes where the distinct-group count fits under the
  gateway cap. Operators on large vaults will see the
  `LORE_DEBUG=1` stderr line on every flagged-on run and the metric
  will be JS-computed regardless. A future server-side pagination
  knob on `query_data_sources` would lift this limitation; tracked
  upstream.
- **`hasAdvancedTools` capability gate** is the second residual
  risk for this slice (per "Capability gate is the bigger risk"
  above). The fallback path is the operator's structural escape
  hatch — a workspace below the gate sees zero aggregate traffic,
  every flagged-on call falls through to JS, and the
  `LORE_DEBUG=1`-gated stderr line surfaces the silent degrade.
