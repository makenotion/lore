import { renameSync, writeFileSync } from "node:fs"
import { dirname, basename } from "node:path"

/**
 * Shared concurrency + request-rate governor for outbound Notion SDK calls.
 *
 * Notion's public API is limited to roughly three requests per second per
 * access token. Tools that fan out (decision graph walks, batch fact
 * fetches, render-layer title lookups, migration sweeps) historically
 * routed through a `p-limit` gate that capped concurrent in-flight calls
 * at 3 — but a fast-completing call sequence (cheap reads against
 * primary-key lookups, for instance) could still issue dozens of
 * requests inside a one-second window because `p-limit` only counts
 * "in flight," not "started in the last second." Token bucket pacing
 * fixes that gap.
 *
 * `createLimitedClient` wraps the real client in a Proxy that routes
 * every outbound method call — top-level (`client.search`), two-level
 * (`client.pages.retrieve`, `client.dataSources.query`), three-level
 * (`client.blocks.children.list`, `client.pages.properties.retrieve`),
 * or any future SDK addition — through three composed gates:
 *
 * 1. **Token bucket** (request-rate): each call awaits a token before
 *    it may proceed. Bucket capacity controls the burst tolerance;
 *    refill rate controls sustained throughput. The global gate
 *    defaults align with Notion's public-API ~3 rps guidance; a small
 *    table of endpoint-specific overrides
 *    ({@link DEFAULT_NOTION_ENDPOINT_OVERRIDES}) loosens the gate for
 *    paths backed by operator-runnable probe evidence under `tools/`.
 *    Each overridden endpoint runs on its own bucket, so a fast
 *    endpoint does not consume the global gate's tokens.
 * 2. **`p-limit` slot** (concurrency): bounds simultaneous in-flight
 *    requests so a slow Notion call can't fan out memory under heavy
 *    load. One slot pool per gate — the global pool covers every
 *    non-overridden endpoint, and each endpoint override has its own
 *    pool sized to its measured workload.
 * 3. **Shared 429 backoff**: when a 429 escapes the SDK's internal
 *    retry budget (the Notion v5 SDK retries 429s automatically with
 *    `Retry-After` parsing, so this is the surfacing-after-exhaustion
 *    path), the wrapper pauses **every** bucket — global plus every
 *    endpoint override — for the surfaced `Retry-After` window. The
 *    Notion per-token server-side bucket is shared across endpoints,
 *    so a throttling signal on one endpoint means siblings on the
 *    same token are also in the throttling window.
 *
 * Tests that inject their own mock client are unaffected: the limiter
 * only wraps the real client inside `initServicesFromConfig` and `lore
 * init`. Tests that explicitly want to observe the gates wrap their
 * mock manually.
 */
import type { Client } from "@notionhq/client"
import pLimit from "p-limit"

/**
 * Maximum in-flight outbound Notion calls applied to endpoints with
 * no per-endpoint override. Aligned with Notion's public-API guidance
 * (~3 rps average per access token); endpoints that have been probed
 * against a real vault opt into a higher value via
 * {@link DEFAULT_NOTION_ENDPOINT_OVERRIDES}.
 *
 * Hot fan-outs over an opted-in endpoint (today: body fetches via
 * `pages.retrieveMarkdown`) run under the endpoint's own gate; the
 * global gate covers writes, RunTool dispatches, setup flows, and
 * every endpoint without scoped probe evidence.
 */
export const DEFAULT_NOTION_CONCURRENCY = 3

/**
 * Sustained refill rate for the global token bucket. Matches Notion's
 * public-API ~3 rps average with bursts allowed; endpoints with their
 * own scoped probe evidence loosen via
 * {@link DEFAULT_NOTION_ENDPOINT_OVERRIDES} so a single fast endpoint
 * does not force every other endpoint over the published average.
 *
 * Per-process budget. Multiple Lore processes on one Notion token
 * (MCP server + CLI + hooks running concurrently) compose additively
 * at the server-side bucket; the shared 429 backoff path inside this
 * wrapper (see {@link MAX_RATE_LIMIT_BACKOFF_MS}) is what self-
 * throttles when the union of process-local pacers exceeds the
 * per-token ceiling. Operators running heavy concurrent workloads on
 * one token can tighten further via `notion.rateLimit.requestsPerSecond`
 * in `.lore.yaml`.
 */
export const DEFAULT_NOTION_REQUESTS_PER_SECOND = 3

/**
 * Initial token-bucket capacity for the global gate. A 3-token burst
 * matches the sustained rate; endpoints that need a wider burst for
 * hot fan-outs (e.g., body-fetch fan-out on a list view) opt in via
 * {@link DEFAULT_NOTION_ENDPOINT_OVERRIDES}.
 */
export const DEFAULT_NOTION_BURST_SIZE = 3

/**
 * Endpoint-scoped pacing override block. Each field, when set,
 * replaces the global counterpart for the dotted method path keying
 * this override (e.g., `pages.retrieveMarkdown`). Unset fields fall
 * back to the global default for that knob — an override may loosen
 * a single dimension (rps only) without re-stating the others.
 *
 * The path key is matched against the dot-joined SDK method path the
 * wrapper walks at call time — `pages.retrieveMarkdown`, not the URL
 * shape `/v1/pages/{id}/markdown`. Two top-level methods (`search`,
 * `request`) match the bare method name.
 */
export interface NotionRateLimitEndpointOverride {
  concurrency?: number
  requestsPerSecond?: number
  burstSize?: number
}

/**
 * Built-in endpoint overrides loosening the global pace for endpoints
 * with operator-runnable probe evidence. Adding an entry here implies
 * the dotted path has been measured against a real vault with the
 * probe under `tools/probe-notion-endpoint.mjs` (or its dedicated
 * predecessor `tools/probe-retrieve-markdown.mjs`) and the chosen
 * rate sits at conservative headroom below the observed server-side
 * ceiling.
 *
 * Each entry carries its measurement in its docstring. The convention
 * is ~2× headroom below the cell at concurrency=10, the cell that
 * empirically dominates p50 throughput on the probed endpoints. The
 * margin absorbs (a) multi-process composition on one operator token
 * — two Lore processes at the override rate still sit at or below
 * the measured ceiling — and (b) tighter per-workspace caps than the
 * probed reference vault.
 *
 * Add new entries only with paired probe evidence. If an operator sets any
 * global `notion.rateLimit.*` knob without an explicit `endpointOverrides`
 * map, those effective global values cap this built-in table so existing
 * process-wide throttles remain conservative. Operators who want a probed
 * endpoint to exceed their global gate opt in with an explicit per-endpoint
 * entry in `.lore.yaml`.
 */
export const DEFAULT_NOTION_ENDPOINT_OVERRIDES: Readonly<
  Record<string, NotionRateLimitEndpointOverride>
> = Object.freeze({
  // Body-fetch hot path on list views. Probe matrix at concurrency
  // 1 / 3 / 5 / 10 / 20 sustained ~28–30 rps with zero 429s on the
  // probed vault. 15 rps with a 5-token burst leaves ~2× headroom
  // below the conservative measured ceiling.
  "pages.retrieveMarkdown": Object.freeze({
    concurrency: 10,
    requestsPerSecond: 15,
    burstSize: 5,
  }),
  // Title-resolution hot path — render layer batch-resolves titles
  // for cited rows, RunTool search hydration fans out one
  // `pages.retrieve` per hit. Probe matrix sustained ~25 rps at
  // concurrency=10 with zero 429s. 10 rps with a 5-token burst
  // leaves ~2.5× headroom below the measured ceiling.
  "pages.retrieve": Object.freeze({
    concurrency: 10,
    requestsPerSecond: 10,
    burstSize: 5,
  }),
  // List / search hot path — `MemoryService.list`,
  // `MemoryService.search` contains-mode, fact / decision / entity
  // queries all dispatch `dataSources.query`. Probe matrix sustained
  // ~13 rps at concurrency=10 with zero 429s. The endpoint is
  // visibly heavier than `pages.retrieve` (p50 ~550ms vs ~280ms),
  // so the override stays tighter: 5 rps with a 3-token burst is
  // ~2.6× below the measured ceiling.
  "dataSources.query": Object.freeze({
    concurrency: 5,
    requestsPerSecond: 5,
    burstSize: 3,
  }),
})

/**
 * Default fallback pause when a 429 surfaces without a parseable
 * `Retry-After` header. One second is the smallest "meaningful"
 * backoff — long enough that a single rps budget window can recover,
 * short enough that an unrelated transient blip doesn't stall the
 * caller's next request indefinitely.
 *
 * Exported so tests can assert against the constant rather than a
 * hardcoded literal, and operators can reference the symbolic value
 * if they later want to widen it via a config knob.
 */
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 1000

/**
 * Upper bound on the bucket pause derived from a `Retry-After` header.
 * The pause is **process-wide on this client** — every subsequent
 * Notion call routed through the same `createLimitedClient` waits out
 * the pause window. A malicious or buggy `Retry-After: 86400` would
 * otherwise stall the entire Lore process for 24 hours. Sixty seconds
 * matches the Notion v5 SDK's `DEFAULT_MAX_RETRY_DELAY_MS` so the
 * wrapper and the SDK agree on the longest individual backoff a
 * single 429 can induce.
 */
export const MAX_RATE_LIMIT_BACKOFF_MS = 60_000

export interface NotionRateLimitOptions {
  /**
   * Max outbound Notion calls in flight at once. The `p-limit` cap
   * bounds fan-out memory; it does NOT bound throughput on its own.
   * Defaults to {@link DEFAULT_NOTION_CONCURRENCY}.
   *
   * In practice `concurrency` is rarely the binding constraint: when
   * each SDK call completes faster than `1000/requestsPerSecond` ms,
   * the bucket gates throughput first and slot occupancy stays well
   * under the cap. `concurrency` only binds when individual calls run
   * *longer* than the refill interval (slow `dataSources.query` on a
   * large vault, paginated walks). Operators tuning one knob without
   * the others should expect the bucket-side knob to dominate
   * observed throughput at default settings.
   */
  concurrency?: number
  /**
   * Sustained outbound request rate in calls/second. Token-bucket
   * refill rate. Defaults to {@link DEFAULT_NOTION_REQUESTS_PER_SECOND}.
   */
  requestsPerSecond?: number
  /**
   * Token-bucket capacity — how many calls may fire instantly after a
   * quiet period. Defaults to {@link DEFAULT_NOTION_BURST_SIZE}.
   */
  burstSize?: number
  /**
   * Per-endpoint pacing overrides keyed by dot-joined SDK method path
   * (e.g., `"pages.retrieveMarkdown"`, `"dataSources.query"`, or the
   * bare top-level name `"search"` / `"request"`). Each override
   * replaces the global pacing dimensions it specifies; unset
   * dimensions fall back to the surrounding {@link concurrency} /
   * {@link requestsPerSecond} / {@link burstSize}.
   *
   * Builds a separate token bucket and `p-limit` slot per overridden
   * path, so a fast endpoint does not consume the global gate's
   * tokens and a slow endpoint does not block the global gate's slots.
   * Endpoints without an override route through the global gate.
   *
   * Built-in overrides are inherited when this field is omitted. If the caller
   * also supplies any global rate-limit knob, the effective global values cap
   * the built-in table so an existing process-wide throttle is not silently
   * loosened on hot paths.
   *
   * Caller-supplied overrides REPLACE
   * {@link DEFAULT_NOTION_ENDPOINT_OVERRIDES} for any path the caller
   * names. A caller passing `{ "pages.retrieveMarkdown": { ... } }`
   * does NOT silently merge with the built-in entry; the
   * `requestsPerSecond` value the caller provides is the value that
   * lands on the gate. Pass `endpointOverrides: {}` to opt out of
   * the built-in overrides entirely (every endpoint routes through
   * the global gate).
   */
  endpointOverrides?: Record<string, NotionRateLimitEndpointOverride>
}

/**
 * Source of a backoff event surfaced via {@link NotionRateLimitDeps.onBackoff}.
 *
 * - `"header"` — `Retry-After` was present and parsed cleanly; the
 *   pause matches what Notion asked for.
 * - `"header-clamped"` — `Retry-After` parsed to a value larger than
 *   {@link MAX_RATE_LIMIT_BACKOFF_MS}; the pause was clamped to the
 *   ceiling so a runaway header doesn't stall the client for hours.
 * - `"default"` — no parseable `Retry-After`; the wrapper used
 *   {@link DEFAULT_RATE_LIMIT_BACKOFF_MS} as the floor.
 */
export type BackoffSource = "header" | "header-clamped" | "default"

/**
 * Internal seam for unit tests AND production observability hook.
 * Production callers pass nothing for `now` / `setTimer` and the
 * bucket uses `Date.now` + `setTimeout` directly; tests substitute a
 * fake clock so pacing assertions are deterministic without sleeping
 * in real time. `onBackoff` is the one production-facing field —
 * defaults to a stderr warning, but callers can route to telemetry.
 *
 * @internal — `now` and `setTimer` are not part of the production
 * contract; consumers outside this package should not depend on
 * them. `onBackoff` is stable.
 */
export interface NotionRateLimitDeps {
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => void
  /**
   * Called when a 429 surfaces and the wrapper pauses the shared
   * bucket. `ms` is the actual pause duration (post-clamp); `source`
   * names where the value came from. Defaults to a stderr warning in
   * the existing `[lore] notion-sdk ...` shape so an operator
   * debugging "lore is slow today" sees the pause without enabling
   * `LORE_DEBUG=1` — the bucket pause is otherwise silent (the
   * wrapper is the only place that knows it happened).
   */
  onBackoff?: (ms: number, source: BackoffSource) => void
}

/**
 * Token bucket with FIFO waiter queue and shared 429 pause support.
 *
 * Capacity tokens are issued instantly to the first `capacity`
 * acquirers. Subsequent acquirers wait until the bucket has refilled
 * to one token's worth at `refillPerSecond`. `pauseFor` shifts the
 * next-issuance time forward AND drains the bucket — without the
 * drain, a long pause followed by a burst would re-inflate the bucket
 * to capacity and immediately issue `capacity` calls, defeating the
 * purpose of the pause.
 *
 * Exported for unit tests; production callers go through
 * {@link createLimitedClient}.
 */
export class TokenBucket {
  private tokens: number
  private lastRefillMs: number
  private queue: Array<() => void> = []
  private scheduled = false
  private pausedUntilMs = 0
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, delayMs: number) => void

  constructor(
    public readonly capacity: number,
    public readonly refillPerSecond: number,
    deps: NotionRateLimitDeps = {},
  ) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(
        `Notion rate-limit burstSize must be a positive number (got ${capacity})`,
      )
    }
    if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
      throw new Error(
        `Notion rate-limit requestsPerSecond must be a positive number (got ${refillPerSecond})`,
      )
    }
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? defaultSetTimer
    this.tokens = capacity
    this.lastRefillMs = this.now()
  }

  /**
   * Reserve a token. Resolves once the bucket has issued one to this
   * caller. Multiple concurrent acquirers wake in FIFO order so a
   * burst of fan-out callers doesn't starve the first one queued.
   */
  acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve)
      this.flush()
    })
  }

  /**
   * Pause new token issuance for `ms` milliseconds. Drains the bucket
   * so the first post-pause caller doesn't immediately consume a stale
   * token built up before the throttling event. Used by the wrapper to
   * propagate a 429 `Retry-After` across concurrent callers.
   *
   * Idempotent: calling `pauseFor(500)` twice does NOT extend the
   * pause to 1000ms — the wall-clock target is the max, not the sum.
   */
  pauseFor(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return
    const now = this.now()
    this.pausedUntilMs = Math.max(this.pausedUntilMs, now + ms)
    this.tokens = 0
    this.lastRefillMs = this.pausedUntilMs
    if (this.queue.length > 0 && !this.scheduled) {
      this.scheduleFlush()
    }
  }

  private flush(): void {
    const now = this.now()
    if (now < this.pausedUntilMs) {
      if (!this.scheduled) this.scheduleFlush()
      return
    }
    this.refill()
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1
      const resolver = this.queue.shift()!
      resolver()
    }
    if (this.queue.length > 0 && !this.scheduled) {
      this.scheduleFlush()
    }
  }

  private scheduleFlush(): void {
    const now = this.now()
    let waitMs: number
    if (now < this.pausedUntilMs) {
      waitMs = this.pausedUntilMs - now
    } else {
      const tokensShort = Math.max(0, 1 - this.tokens)
      waitMs = Math.max(1, Math.ceil((tokensShort / this.refillPerSecond) * 1000))
    }
    this.scheduled = true
    this.setTimer(() => {
      this.scheduled = false
      this.flush()
    }, waitMs)
  }

  private refill(): void {
    const now = this.now()
    const elapsedSec = (now - this.lastRefillMs) / 1000
    if (elapsedSec > 0) {
      this.tokens = Math.min(
        this.capacity,
        this.tokens + elapsedSec * this.refillPerSecond,
      )
      this.lastRefillMs = now
    }
  }
}

function defaultSetTimer(callback: () => void, delayMs: number): void {
  // Do NOT `unref()` here. The bucket only schedules a refill timer
  // when there's queued work; an `unref`'d timer would let the event
  // loop exit between an in-flight SDK call resolving and the next
  // queued caller's token arriving — leaving the queued caller's
  // Promise pending forever (Node treats top-level await on an
  // unresolved Promise as a no-op exit). The natural lifecycle is
  // "timer keeps the loop alive while the queue has work; queue
  // drains; last issuance schedules no successor; loop exits."
  setTimeout(callback, delayMs)
}

/**
 * Default backoff emitter — writes a one-line warning to stderr in
 * the same `[lore] notion-sdk ...` shape `client.ts:stderrSdkLogger`
 * uses. Operators debugging "lore is slow today" or "did we just
 * blow the rps ceiling" see the pause source and duration without
 * enabling `LORE_DEBUG=1`. The wrapper is the only place that knows
 * the bucket paused; emitting here closes the observability gap.
 *
 * Routes through `process.stderr.write` rather than `console.warn`
 * so the line shape matches the existing SDK-debug emitter and any
 * `[lore]`-prefixed log aggregation keeps working unchanged.
 */
function defaultOnBackoff(ms: number, source: BackoffSource): void {
  process.stderr.write(
    `[lore] notion-sdk warn: 429 backoff ${ms}ms (source=${source})\n`,
  )
}

/**
 * Match the SDK's surfaced rate-limit shape. The Notion v5 SDK throws
 * `APIResponseError` with `status: 429` and `code: "rate_limited"`
 * after exhausting its internal retry budget; we check both
 * discriminants so future SDK shape drift on either field still
 * triggers the bucket pause.
 */
function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const status = (err as { status?: number }).status
  const code = (err as { code?: string }).code
  return status === 429 || code === "rate_limited"
}

/**
 * Parse `Retry-After` off the SDK error object. Supports both
 * `Headers` instances (standard fetch API) and plain object headers
 * (test fixtures, future fetch substitutes). Mirrors the SDK's
 * internal parsing in `Client.parseRetryAfterHeader` so the wrapper
 * and the SDK agree on the wall-clock target.
 *
 * `now` is the same clock injection the bucket uses, so HTTP-date
 * parsing under fake timers stays deterministic. Production passes
 * `Date.now` directly.
 */
function extractRetryAfterMs(
  err: unknown,
  now: () => number = Date.now,
): number | undefined {
  if (!err || typeof err !== "object") return undefined
  const headers = (err as { headers?: unknown }).headers
  if (!headers) return undefined
  let retryAfter: string | null = null
  if (
    typeof headers === "object" &&
    headers !== null &&
    "get" in headers &&
    typeof (headers as { get?: unknown }).get === "function"
  ) {
    retryAfter = (headers as { get: (key: string) => string | null }).get(
      "retry-after",
    )
  } else if (typeof headers === "object") {
    const record = headers as Record<string, string | undefined>
    retryAfter = record["retry-after"] ?? record["Retry-After"] ?? null
  }
  if (!retryAfter) return undefined
  const seconds = Number.parseInt(retryAfter, 10)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(retryAfter)
  if (Number.isFinite(date)) {
    return Math.max(0, date - now())
  }
  return undefined
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Notion rate-limit ${name} must be a positive integer (got ${value})`,
    )
  }
}

function validatePositiveNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Notion rate-limit ${name} must be a positive number (got ${value})`,
    )
  }
}

function capBuiltInEndpointOverrides(
  defaults: Readonly<Record<string, NotionRateLimitEndpointOverride>>,
  caps: Required<NotionRateLimitEndpointOverride>,
): Record<string, NotionRateLimitEndpointOverride> {
  const capped: Record<string, NotionRateLimitEndpointOverride> = {}
  for (const [path, override] of Object.entries(defaults)) {
    capped[path] = {
      concurrency:
        override.concurrency === undefined
          ? undefined
          : Math.min(override.concurrency, caps.concurrency),
      requestsPerSecond:
        override.requestsPerSecond === undefined
          ? undefined
          : Math.min(override.requestsPerSecond, caps.requestsPerSecond),
      burstSize:
        override.burstSize === undefined
          ? undefined
          : Math.min(override.burstSize, caps.burstSize),
    }
  }
  return capped
}

/**
 * Wrap a Notion client so every outbound method call is paced by a
 * shared token bucket and gated by a shared concurrency limit.
 * Returns a Proxy over `client` — structural type-identical so
 * consumers pass it around as a `Client` without casts.
 *
 * Property access is recursive: every level of the SDK's namespace
 * tree gets proxied until we hit a function (wrapped) or a primitive
 * (passed through). Method return values are NOT proxied — they're
 * data, not further API calls.
 *
 * Backwards-compatible signature: a bare `number` second argument is
 * interpreted as `{ concurrency: <n> }` so the legacy
 * `createLimitedClient(client, 3)` callsites continue to work.
 *
 * The third `deps` parameter is a unit-test seam for clock injection
 * and is NOT part of the public production contract; production
 * callers pass exactly two arguments.
 *
 * **RunTool sharing:** the RunTool wrapper routes through the SDK's
 * `client.request()` method, which IS proxied here, so RunTool
 * calls automatically share this gate. No separate gate factory
 * is needed.
 */
/**
 * Internal handle pairing a token bucket with a `p-limit` slot. One
 * handle per gate — one global, one per endpoint override.
 */
interface RateGate {
  bucket: TokenBucket
  limit: ReturnType<typeof pLimit>
}

export function createLimitedClient(
  client: Client,
  options: number | NotionRateLimitOptions = {},
  deps: NotionRateLimitDeps = {},
): Client {
  const opts: NotionRateLimitOptions =
    typeof options === "number" ? { concurrency: options } : options
  const hasCallerGlobalKnob =
    typeof options === "number" ||
    opts.concurrency !== undefined ||
    opts.requestsPerSecond !== undefined ||
    opts.burstSize !== undefined

  const concurrency = opts.concurrency ?? DEFAULT_NOTION_CONCURRENCY
  const requestsPerSecond =
    opts.requestsPerSecond ?? DEFAULT_NOTION_REQUESTS_PER_SECOND
  const burstSize = opts.burstSize ?? DEFAULT_NOTION_BURST_SIZE

  validatePositiveInteger("concurrency", concurrency)
  validatePositiveNumber("requestsPerSecond", requestsPerSecond)
  validatePositiveInteger("burstSize", burstSize)

  const onBackoff = deps.onBackoff ?? defaultOnBackoff

  const globalGate: RateGate = {
    bucket: new TokenBucket(burstSize, requestsPerSecond, deps),
    limit: pLimit(concurrency),
  }

  // Caller-supplied overrides replace the built-in entries — passing
  // `endpointOverrides: {}` opts every endpoint back through the
  // global gate. An omitted `endpointOverrides` inherits the built-in
  // table so consumers that don't think about endpoint pacing still
  // pick up the probe-justified defaults. If the caller supplied any
  // global knob, cap the built-in table with those effective global
  // values so an existing process-wide throttle is not silently
  // loosened on the hot paths that now have defaults.
  const overrideMap: Record<string, NotionRateLimitEndpointOverride> =
    opts.endpointOverrides ??
    (hasCallerGlobalKnob
      ? capBuiltInEndpointOverrides(DEFAULT_NOTION_ENDPOINT_OVERRIDES, {
          concurrency,
          requestsPerSecond,
          burstSize,
        })
      : DEFAULT_NOTION_ENDPOINT_OVERRIDES)

  const endpointGates = new Map<string, RateGate>()
  for (const [path, override] of Object.entries(overrideMap)) {
    if (!path) {
      throw new Error(
        "Notion rate-limit endpointOverrides key must be a non-empty string",
      )
    }
    const epConcurrency = override.concurrency ?? concurrency
    const epRequestsPerSecond = override.requestsPerSecond ?? requestsPerSecond
    const epBurstSize = override.burstSize ?? burstSize
    validatePositiveInteger(
      `endpointOverrides["${path}"].concurrency`,
      epConcurrency,
    )
    validatePositiveNumber(
      `endpointOverrides["${path}"].requestsPerSecond`,
      epRequestsPerSecond,
    )
    validatePositiveInteger(
      `endpointOverrides["${path}"].burstSize`,
      epBurstSize,
    )
    endpointGates.set(path, {
      bucket: new TokenBucket(epBurstSize, epRequestsPerSecond, deps),
      limit: pLimit(epConcurrency),
    })
  }

  // Materialize the list of all buckets once so the 429 path doesn't
  // walk the override map on every backoff event. A 429 from any
  // endpoint pauses every bucket — Notion's per-token server-side
  // bucket is shared across endpoints, so a throttling signal on one
  // endpoint means siblings on the same token are also in the
  // throttling window.
  const allBuckets: readonly TokenBucket[] = [
    globalGate.bucket,
    ...Array.from(endpointGates.values(), (g) => g.bucket),
  ]

  const gateFor = (path: string): RateGate =>
    endpointGates.get(path) ?? globalGate

  const wrapMethod =
    (
      fn: (...args: unknown[]) => unknown,
      thisArg: unknown,
      path: string,
    ) =>
    async (...args: unknown[]) => {
      const gate = gateFor(path)
      // Claim the p-limit slot FIRST and acquire the bucket token
      // INSIDE the slot, immediately before the SDK call.
      //
      // The alternative ordering (acquire token first, then enter
      // the slot) leaks the shared-backoff guarantee whenever
      // `burstSize > concurrency`, OR under default settings if
      // active SDK calls run long enough for the bucket to keep
      // refilling while every `p-limit` slot is occupied: a caller
      // that consumed a token early and is sitting in the p-limit
      // queue would never re-check the bucket when its slot opens,
      // and would dispatch even if a sibling 429 had since paused
      // the bucket. Acquire-inside-slot pushes the pause check to
      // the boundary closest to the actual SDK dispatch so the
      // pause is always observed.
      //
      // The fan-out memory equivalence: under both orderings the
      // wrapper holds O(N) closures for N queued callers (one per
      // caller, in the bucket queue OR the p-limit queue). The
      // claim-slot-first ordering is correct for FIFO fairness
      // w.r.t. backoff — callers that arrived before a 429 land in
      // the same gate the pause governs.
      return gate.limit(async () => {
        await gate.bucket.acquire()
        try {
          return await (fn.apply(thisArg, args) as Promise<unknown>)
        } catch (err) {
          // The Notion v5 SDK retries 429s internally with
          // `Retry-After` parsing (`DEFAULT_MAX_RETRIES = 2`,
          // `DEFAULT_MAX_RETRY_DELAY_MS = 60_000`); any 429 that
          // surfaces here means the SDK already burned its budget.
          // Propagating the bucket pause across concurrent siblings
          // prevents the next fan-out batch from making the
          // throttling event worse — without it, every sibling
          // would burn its own SDK retry budget on the same
          // sustained rate-limit event.
          if (isRateLimitError(err)) {
            const parsed = extractRetryAfterMs(err, deps.now)
            // Clamp before pausing: an unbounded `Retry-After` would
            // freeze the entire client for the value Notion (or a
            // misbehaving proxy) put on the wire — minutes or hours
            // is not unheard of. Sixty seconds matches the SDK's
            // own `DEFAULT_MAX_RETRY_DELAY_MS` ceiling, so the
            // wrapper and the SDK agree on the longest individual
            // backoff a single 429 can induce.
            const requested = parsed ?? DEFAULT_RATE_LIMIT_BACKOFF_MS
            const clamped = Math.min(requested, MAX_RATE_LIMIT_BACKOFF_MS)
            const source: BackoffSource =
              parsed === undefined
                ? "default"
                : requested > MAX_RATE_LIMIT_BACKOFF_MS
                  ? "header-clamped"
                  : "header"
            // Pause every bucket — Notion's per-token bucket is
            // shared across endpoints, so a 429 on one endpoint
            // means siblings on the same token are also in the
            // throttling window. Pausing only the offending gate
            // would let endpoints with their own gate continue
            // hammering the same throttled server-side bucket.
            for (const bucket of allBuckets) bucket.pauseFor(clamped)
            // Visibility is load-bearing — without it, a 429 storm
            // surfaces only as "lore is slow today." See
            // `defaultOnBackoff` for the default stderr emitter.
            try {
              onBackoff(clamped, source)
            } catch {
              // An onBackoff implementation that throws must NOT
              // poison the underlying error propagation. Caller
              // gets the original 429.
            }
          }
          throw err
        }
      })
    }

  const wrapLevel = <T extends object>(obj: T, path: string): T =>
    new Proxy(obj, {
      get(target, prop, receiver) {
        if (typeof prop === "symbol") {
          return Reflect.get(target, prop, receiver)
        }
        const value = Reflect.get(target, prop, receiver)
        const nextPath = path === "" ? prop : `${path}.${prop}`
        if (typeof value === "function") {
          return wrapMethod(
            value as (...args: unknown[]) => unknown,
            target,
            nextPath,
          )
        }
        if (typeof value === "object" && value !== null) {
          return wrapLevel(value as object, nextPath)
        }
        return value
      },
    })

  return wrapLevel(client, "")
}

// ---------------------------------------------------------------------------
// Bench-mode write-budget Proxy (issue #595)
//
// The 500-write-per-example cap is a safety gate, not a diagnostic.
// Post-hoc detection ("oh, we did 900 writes") satisfies nothing — the
// writes already landed. The cap is enforced inside the MCP server by
// wrapping the Notion client with a Proxy that increments a counter on
// every successful mutation. Once the counter strictly exceeds the
// limit, every subsequent mutation throws `WriteBudgetExceededError`
// (which the MCP layer maps to the `WriteBudgetExceeded:` text-error
// envelope) and the state file is written atomically once per server
// lifetime so the mining child can grep-detect the cap-hit and halt.
//
// Layering: rate-limit Proxy → write-budget Proxy → SDK. The 429 retry
// runs first (a successful retry counts as one write, a failed retry
// counts zero). The write-budget Proxy increments on `await`-resolved
// success only.
// ---------------------------------------------------------------------------

/**
 * Direct SDK methods that count as mutations. Matched by dot-joined
 * path against the recursive Proxy walk so a renamed nested method
 * fails the unit test before it can silently bypass the gate.
 *
 * `pages.create` / `pages.update` are the obvious surface; v5's
 * markdown body API lands writes through `pages.updateMarkdown`, which
 * `MemoryService` / `DecisionService.create` / `EntityService.create`
 * all consume — without it the bench under-counts page-body writes,
 * which is the dominant write surface for memory/decision/entity
 * creation.
 *
 * `databases.create` and `dataSources.update` are vault-setup /
 * schema-patching surfaces. The bench uses a pre-existing sandbox vault
 * so they should not fire during a bench run; counting them defends
 * against an accidental setup call slipping into a per-example flow.
 */
export const WRITE_BUDGET_DIRECT_MUTATIONS: readonly string[] = [
  "pages.create",
  "pages.update",
  "pages.updateMarkdown",
  "databases.create",
  "dataSources.update",
]

/**
 * `client.request()` body shapes classified by their `body.type`
 * discriminator. The RunTool dispatch path layers structured operations
 * over the SDK's generic `request` method; classification here keeps
 * the write-budget gate aware of those operations.
 *
 * Unknown `body.type` defaults to mutation (default-deny): a future
 * RunTool tool added to the SDK should not silently bypass the gate.
 * If a new read-only RunTool consumer lands, it's a one-line classifier
 * update at the same site that adds the consumer.
 */
export const WRITE_BUDGET_RUNTOOL_MUTATIONS: readonly string[] = [
  "create_pages",
  "update_page",
  "update_content",
]

export const WRITE_BUDGET_RUNTOOL_READS: readonly string[] = [
  "query_data_sources",
  "search",
]

/**
 * Direct SDK methods that are reads. Used by tests to assert every
 * documented read method routes through the passthrough branch — a
 * future SDK addition that lands a new mutation method requires a
 * one-line entry in `WRITE_BUDGET_DIRECT_MUTATIONS` and the test
 * fails until the classifier is updated.
 */
export const WRITE_BUDGET_DIRECT_READS: readonly string[] = [
  "pages.retrieve",
  "pages.retrieveMarkdown",
  "pages.properties.retrieve",
  "dataSources.retrieve",
  "dataSources.query",
  "databases.retrieve",
  "search",
]

/**
 * Classification verdict for one outbound call.
 *
 * - `"mutation"` — increment the counter on `await`-resolved success;
 *   throw `WriteBudgetExceededError` past the cap.
 * - `"read"` — passthrough, do not increment.
 */
export type WriteBudgetClassification = "mutation" | "read"

/**
 * Decide whether a call traversing the recursive proxy is a mutation.
 *
 * `path` is the dot-joined property path from the client root to the
 * called function (`pages.update`, `dataSources.query`,
 * `pages.properties.retrieve`, etc.).
 *
 * `args` is the raw arguments array. For direct SDK methods the array
 * is ignored. For `client.request()` calls (`path === "request"`), the
 * first argument is inspected: if it's an object with a string `type`
 * field matching a known mutation discriminator the call is a
 * mutation, with a known read discriminator a read, and any unknown
 * shape defaults to mutation under the default-deny rule.
 */
export function classifyWriteBudget(
  path: string,
  args: readonly unknown[],
): WriteBudgetClassification {
  if (WRITE_BUDGET_DIRECT_MUTATIONS.includes(path)) return "mutation"
  if (path === "request") {
    const body = (args[0] as { body?: unknown } | undefined)?.body
    if (body === undefined || body === null || typeof body !== "object") {
      // Body absent or non-object: a method-shape regression should not
      // pass-fail the bench either way. Treat as passthrough.
      return "read"
    }
    const type = (body as { type?: unknown }).type
    if (typeof type !== "string") return "mutation"
    if (WRITE_BUDGET_RUNTOOL_MUTATIONS.includes(type)) return "mutation"
    if (WRITE_BUDGET_RUNTOOL_READS.includes(type)) return "read"
    // Default-deny: unknown body.type counts as mutation. A future
    // read-only RunTool consumer must be added explicitly.
    return "mutation"
  }
  return "read"
}

/**
 * Thrown by the write-budget proxy when a mutation tool call follows
 * a cap-exceeded counter. The MCP server maps this to the
 * `WriteBudgetExceeded: tool=<name> limit=<N> count=<final>` text-error
 * envelope the mining child grep-matches to halt.
 */
export class WriteBudgetExceededError extends Error {
  constructor(
    public readonly toolPath: string,
    public readonly limit: number,
    public readonly count: number,
  ) {
    super(
      `WriteBudgetExceeded: tool=${toolPath} limit=${limit} count=${count}`,
    )
    this.name = "WriteBudgetExceededError"
  }
}

/**
 * On-disk state file body. Two shapes — the original cap-exceeded
 * payload AND a count-only payload the MCP server writes on shutdown
 * when the cap was NOT exceeded. The reader (`readBudgetCount` in
 * `bench-ingest.ts`) uses the `count` field as authoritative under
 * both shapes; the bench-runner's `notionWrites` field is therefore
 * the proxy-counted total regardless of cap state.
 */
export interface WriteBudgetStateFileBody {
  writeBudgetExceeded: boolean
  limit: number
  count: number
  /** ISO timestamp the file was written; `exceededAt` when the cap fired. */
  exceededAt: string
}

export interface WriteBudgetOptions {
  /** Maximum number of successful mutations allowed. Positive integer. */
  limit: number
  /**
   * Absolute path to write the state file when the cap is exceeded.
   * Directory must exist; file is created on first cap-exceeded write.
   */
  stateFilePath: string
  /**
   * Internal test seam — overrides `Date.now()` for the `exceededAt`
   * timestamp. Production passes nothing.
   */
  now?: () => Date
  /**
   * Internal test seam — overrides the atomic state-file writer.
   * Production passes nothing; the default uses `writeFileSync` to a
   * tmpfile + `renameSync` for atomicity.
   */
  writeStateFile?: (path: string, body: WriteBudgetStateFileBody) => void
}

/**
 * Default state-file writer: write to `<path>.tmp` with mode 0600, then
 * rename atomically over `path`. Atomic posix-rename guarantees the
 * reader (the mining seam in `runConversationMining`) either sees the
 * pre-cap-hit nonexistent file OR the fully-written post-cap-hit body
 * — never a partial write.
 */
function defaultWriteStateFile(
  path: string,
  body: WriteBudgetStateFileBody,
): void {
  const tmp = `${dirname(path)}/.${basename(path)}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * Wrap a Notion client (typically already wrapped by
 * `createLimitedClient`) with a Proxy that counts successful mutations
 * and enforces a per-server-lifetime cap. Returns a Proxy structurally
 * identical to the input client.
 *
 * Sits BELOW the rate-limit proxy in the layering. The rate-limit
 * proxy's 429 retry runs first; a successful retry counts as one
 * write (it landed on Notion), a failed retry counts zero. The
 * counter increments on `await`-resolved success only.
 *
 * The state file is written exactly once per server lifetime; the
 * call that pushes the counter over the cap ALSO throws
 * `WriteBudgetExceededError`. Subsequent over-cap mutation calls
 * throw without re-writing the state file. Reads continue to function
 * past the cap (a halted mining child may want to query before
 * exiting; not counting reads against the cap is intentional).
 */
/**
 * Result of `wrapWithWriteBudget`. `client` is the Proxy that
 * intercepts mutations; `flushBudgetCount` writes the current
 * counter to the state file at shutdown time so a non-cap-exceeded
 * run still surfaces an authoritative `notionWrites` count.
 *
 * The MCP server invokes `flushBudgetCount` from a `SIGTERM` /
 * `SIGINT` / `process.exit` handler installed at services-init time;
 * the per-call cap-exceeded path still writes its own state-file
 * entry inline (no flush needed in that branch).
 */
export interface WrappedWriteBudget {
  client: Client
  /**
   * Persist the final counter to the configured state-file path.
   * No-op once the cap-exceeded inline writer already fired.
   * Safe to call multiple times — the second call writes a fresh
   * snapshot with the same `writeBudgetExceeded` verdict.
   */
  flushBudgetCount: () => void
  /** Current counter value — primarily for tests. */
  getCount: () => number
}

export function wrapWithWriteBudget(
  client: Client,
  options: WriteBudgetOptions,
): WrappedWriteBudget {
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new Error(
      `wrapWithWriteBudget: limit must be a positive integer (got ${options.limit})`,
    )
  }
  if (!options.stateFilePath || typeof options.stateFilePath !== "string") {
    throw new Error(
      "wrapWithWriteBudget: stateFilePath is required (absolute path)",
    )
  }
  const writeStateFile = options.writeStateFile ?? defaultWriteStateFile
  const now = options.now ?? (() => new Date())

  const state = {
    count: 0,
    capExceededWritten: false,
  }

  const writeSnapshot = (writeBudgetExceeded: boolean): void => {
    const body: WriteBudgetStateFileBody = {
      writeBudgetExceeded,
      limit: options.limit,
      count: state.count,
      exceededAt: now().toISOString(),
    }
    try {
      writeStateFile(options.stateFilePath, body)
    } catch (err) {
      process.stderr.write(
        `[lore] write-budget: failed to write state file ` +
          `"${options.stateFilePath}" (${(err as Error).message ?? "unknown"})\n`,
      )
    }
  }

  const wrapMethod =
    (
      fn: (...args: unknown[]) => unknown,
      thisArg: unknown,
      path: string,
    ) =>
    async (...args: unknown[]): Promise<unknown> => {
      const verdict = classifyWriteBudget(path, args)
      if (verdict === "read") {
        // Passthrough — no counter increment, no cap check.
        return fn.apply(thisArg, args) as Promise<unknown>
      }
      // Pre-call cap check uses `>=` so a `--write-budget 500`
      // configuration permits at most 500 successful mutations, not
      // 501. The prior `>` check let the 501st mutation dispatch
      // before throwing; the cap is a safety/spend gate, not a
      // diagnostic, and the natural reading of the contract is
      // strict: at exactly `limit` successful writes, the next
      // mutation does NOT dispatch.
      if (state.count >= options.limit) {
        // Write the cap-exceeded state file ONCE — the first request
        // that sees the cap-hit synthesizes the snapshot before
        // throwing. Subsequent over-cap calls throw without
        // re-writing.
        if (!state.capExceededWritten) {
          writeSnapshot(true)
          state.capExceededWritten = true
        }
        throw new WriteBudgetExceededError(path, options.limit, state.count)
      }
      const result = await (fn.apply(thisArg, args) as Promise<unknown>)
      state.count += 1
      return result
    }

  const wrapLevel = <T extends object>(obj: T, path: string): T =>
    new Proxy(obj, {
      get(target, prop, receiver) {
        if (typeof prop === "symbol") {
          return Reflect.get(target, prop, receiver)
        }
        const value = Reflect.get(target, prop, receiver)
        const nextPath = path === "" ? prop : `${path}.${prop}`
        if (typeof value === "function") {
          return wrapMethod(value as (...args: unknown[]) => unknown, target, nextPath)
        }
        if (typeof value === "object" && value !== null) {
          return wrapLevel(value as object, nextPath)
        }
        return value
      },
    })

  return {
    client: wrapLevel(client, ""),
    // `writeBudgetExceeded` means *"a mutation was attempted past
    // the cap and rejected"*, NOT *"the counter happens to be at the
    // cap"*. Exact-cap-without-attempted-overflow is the same
    // not-exceeded verdict the raw-transcript path uses (it halts
    // before crossing, so the counter can land at exactly `limit`
    // with no rejection event). The two surfaces report the same
    // verdict for the same observable behavior: `capExceededWritten`
    // is the sole source of truth.
    flushBudgetCount: () => writeSnapshot(state.capExceededWritten),
    getCount: () => state.count,
  }
}
