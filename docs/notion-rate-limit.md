# Notion Rate Limiting

`src/notion/rate-limit.ts` exports `createLimitedClient(client, options)`. It
returns a `Proxy` over the real Notion client that routes outbound SDK calls
through request-rate, concurrency, and shared-backoff gates so fan-out stays
under Notion's per-token ceiling.

The global gate aligns with Notion's published public-API guidance. A small
built-in table of endpoint-specific overrides
(`DEFAULT_NOTION_ENDPOINT_OVERRIDES`) loosens individual endpoints whose
server-side throughput has been measured against a real vault under `tools/`.
Per-vault `notion.rateLimit.*` config knobs, including `endpointOverrides`,
are the operator-side override.

## Gate Composition

Every governed call passes through three gates:

1. **Token bucket** (request rate) paces sustained throughput. The global
   gate's capacity is `burstSize` (`DEFAULT_NOTION_BURST_SIZE`) and its refill
   is `requestsPerSecond` (`DEFAULT_NOTION_REQUESTS_PER_SECOND`); each endpoint
   override builds its own bucket sized to the operator-provided values. Short
   fan-outs that fit under the burst fire instantly; longer fan-outs pace at
   the refill rate. The endpoint-override table's docstring carries the
   per-entry probe-derived sizing rationale.
2. **`p-limit` slot** (concurrency) bounds simultaneous in-flight requests so
   a slow Notion call cannot fan out memory under heavy load. One slot pool
   exists per gate: the global pool is sized by `concurrency`
   (`DEFAULT_NOTION_CONCURRENCY`), and each override has its own pool. At
   probed p50 latency the bucket binds before the slot cap; concurrency matters
   under tail-latency spikes.
3. **Shared 429 backoff** pauses every bucket when a 429 escapes the SDK's
   internal retry budget. The v5 SDK retries 429s twice with `Retry-After`
   parsing. The wrapper then pauses the global bucket and every endpoint
   override for the surfaced `Retry-After`, or
   `DEFAULT_RATE_LIMIT_BACKOFF_MS = 1000ms` when absent, clamped at
   `MAX_RATE_LIMIT_BACKOFF_MS = 60_000ms`. The Notion server-side bucket is
   shared across endpoints for one token, so a throttling signal on one
   endpoint means siblings on the same token are also in the throttling window.
   Calls already past `bucket.acquire()` are not affected; the pause governs
   the next dispatch, not in-flight calls. Backoff events emit a
   `[lore] notion-sdk warn: 429 backoff <ms> (source=...)` stderr line by
   default; consumers wanting telemetry replace `deps.onBackoff`.

## Recursive Proxy Contract

The proxy recurses through sub-namespaces at arbitrary depth, so three-level
paths like `client.blocks.children.list`, `client.blocks.children.append`, and
`client.pages.properties.retrieve` are governed alongside two-level paths like
`client.pages.retrieve` and `client.dataSources.query`, plus top-level methods
like `client.search`.

The proxy tracks the dot-joined path of every method invocation so endpoint
override routing is the same string the operator writes in `endpointOverrides`,
such as `pages.retrieveMarkdown` or `dataSources.query`. Top-level methods
such as `search` and `request` match the bare method name.

## Configuration

`initServicesFromConfig` and `lore init` both wrap the raw client before
handing it to services. `initServicesFromConfig` reads
`config.notion.rateLimit`, including `concurrency`, `requestsPerSecond`,
`burstSize`, and `endpointOverrides`. `lore init` runs before `.lore.yaml`
exists, so it uses defaults and picks up custom values on later commands.

One-time setup flows share the same gate. `lore init`, `lore install`, and
`lore auth --status` route through `createLimitedClient` with the same defaults
as long-running processes. These flows run once per vault and are not on the
hot path. Operators who measure their workload and want to loosen the global
gate or scope a specific endpoint set `notion.rateLimit.requestsPerSecond` or
`notion.rateLimit.endpointOverrides` in `.lore.yaml`.

## Endpoint override inheritance

Endpoint-override defaults are inherited unless the caller passes their own
map. Passing `endpointOverrides: {}` opts every endpoint back through the
global gate, which is the operator escape hatch for a vault that throttles
tighter than the probed reference.

A caller-supplied map replaces the built-in table; it does not silently merge
with unrelated built-in entries the operator did not ask for. If the caller
omits `endpointOverrides` but supplies a global `concurrency`,
`requestsPerSecond`, or `burstSize` knob, the effective global values cap the
inherited built-ins. This preserves existing process-wide throttles for
operators who tuned the single-gate limiter.

The second argument is backwards-compatible: a bare number is interpreted as
`{ concurrency: <n> }`. Existing `createLimitedClient(client, 3)` call sites
continue to work and pick up the request-rate and burst defaults.

## Bucket lifecycle

The bucket only schedules a refill timer when its waiter queue is non-empty.
The timer is not `unref`'d. An `unref`'d refill timer would let Node exit
between an in-flight SDK call resolving and the next queued caller's token
arriving, leaving the queued caller's Promise unresolved. The natural lifecycle
is: timer keeps the loop alive while the queue has work; queue drains; last
issuance schedules no successor; loop exits.

## `pauseFor` drains the bucket

When a 429 surfaces, the wrapper calls `bucket.pauseFor(retryAfterMs)`, which
sets `tokens = 0` and `lastRefillMs = pausedUntilMs`. A caller queued during
the pause therefore waits the pause window plus the first refill interval
(`1/rps` seconds) before its token is issued, as pinned by the `pauseFor + slow
refill` test.

Preserving any token at pause expiry would let the next caller fire instantly
back into the same throttling window the 429 signaled. The extra refill
interval is the cost of no bursting after backoff.

## Per-token, not per-integration

Notion enforces rate limits per access token. Under the ntn-first deployment,
every operator's ntn-issued token has its own server-side bucket sized to the
per-token public-API contract.

The `p-limit` gate in `rate-limit.ts` keeps a single Lore process under the
wrapper's configured ceiling. Cross-process contention within one operator's
token is bounded by `DEFAULT_NOTION_CONCURRENCY` times the number of concurrent
processes and ultimately governed by the shared 429 backoff path when the union
exceeds the server bucket. A proxy token that aggregated requests across
operators would collapse the per-token isolation.

## SDK call-site checklist

Tests that inject their own mock client remain unaffected because the wrap
happens inside `initServicesFromConfig` and `lore init`, not at construction of
`ProjectService`, `TopicService`, or the other domain services. A test that
wants to observe limiter behavior with a mock should wrap the mock explicitly
with `createLimitedClient`.

When adding a new SDK call site, extend `rate-limit.test.ts` with a case that
asserts the limiter governs the new path. The recursive wrap handles any depth
automatically, but the invariant is easy to regress silently; for example, an
SDK method that returns a function or a change to the SDK's property shape
could bypass the wrap without a type-level signal.

When the new path lands in a hot fan-out, such as a paginated walk or
batch-fetch helper that issues many calls to the same SDK method, add a pacing
test alongside the concurrency test. The existing concurrency tests use the
`RATE_GATE_DISABLED` options bag to bypass pacing for clean cap assertions, so
a fan-out path that should respect requests-per-second needs its own test that
exercises the bucket.
