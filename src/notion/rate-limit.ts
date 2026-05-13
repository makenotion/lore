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
 *    refill rate controls sustained throughput. Defaults match
 *    Notion's ~3 rps guidance with a 3-token burst.
 * 2. **`p-limit` slot** (concurrency): bounds simultaneous in-flight
 *    requests so a slow Notion call can't fan out memory under heavy
 *    load. Same default of 3.
 * 3. **Shared 429 backoff**: when a 429 escapes the SDK's internal
 *    retry budget (the Notion v5 SDK retries 429s automatically with
 *    `Retry-After` parsing, so this is the surfacing-after-exhaustion
 *    path), the wrapper pauses the bucket for the surfaced
 *    `Retry-After` window so concurrent siblings on the same client
 *    don't continue hammering during the throttling event.
 *
 * Tests that inject their own mock client are unaffected: the limiter
 * only wraps the real client inside `initServicesFromConfig` and `lore
 * init`. Tests that explicitly want to observe the gates wrap their
 * mock manually.
 */
import type { Client } from "@notionhq/client"
import pLimit from "p-limit"

/** Matches Notion's public-API guidance of ~3 requests per second. */
export const DEFAULT_NOTION_CONCURRENCY = 3

/** Sustained refill rate for the token bucket; mirrors the rps guidance. */
export const DEFAULT_NOTION_REQUESTS_PER_SECOND = 3

/**
 * Initial bucket capacity. A 3-token burst lets short fan-outs (a
 * decision-graph walk over 3 ancestors, a render-layer title lookup
 * across 3 facts) fire instantly without waiting for the refill clock.
 */
export const DEFAULT_NOTION_BURST_SIZE = 3

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
export function createLimitedClient(
  client: Client,
  options: number | NotionRateLimitOptions = {},
  deps: NotionRateLimitDeps = {},
): Client {
  const opts: NotionRateLimitOptions =
    typeof options === "number" ? { concurrency: options } : options

  const concurrency = opts.concurrency ?? DEFAULT_NOTION_CONCURRENCY
  const requestsPerSecond =
    opts.requestsPerSecond ?? DEFAULT_NOTION_REQUESTS_PER_SECOND
  const burstSize = opts.burstSize ?? DEFAULT_NOTION_BURST_SIZE

  validatePositiveInteger("concurrency", concurrency)
  validatePositiveNumber("requestsPerSecond", requestsPerSecond)
  validatePositiveInteger("burstSize", burstSize)

  const limit = pLimit(concurrency)
  const bucket = new TokenBucket(burstSize, requestsPerSecond, deps)
  const onBackoff = deps.onBackoff ?? defaultOnBackoff

  const wrapMethod =
    (fn: (...args: unknown[]) => unknown, thisArg: unknown) =>
    async (...args: unknown[]) =>
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
      limit(async () => {
        await bucket.acquire()
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
            // Pass `deps.now` directly rather than re-resolving the
            // default at this layer — the bucket already encapsulates
            // its own copy of the same dep, and a shadow copy here
            // would be duplicate state per the post-update review's
            // micro-nit. `extractRetryAfterMs` defaults `Date.now` at
            // its own boundary, so passing `undefined` is equivalent
            // to passing the default.
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
            bucket.pauseFor(clamped)
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

  const wrapLevel = <T extends object>(obj: T): T =>
    new Proxy(obj, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (typeof value === "function") {
          return wrapMethod(value as (...args: unknown[]) => unknown, target)
        }
        if (typeof value === "object" && value !== null) {
          return wrapLevel(value as object)
        }
        return value
      },
    })

  return wrapLevel(client)
}
