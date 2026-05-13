import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Client } from "@notionhq/client"
import {
  createLimitedClient,
  DEFAULT_NOTION_BURST_SIZE,
  DEFAULT_NOTION_CONCURRENCY,
  DEFAULT_NOTION_REQUESTS_PER_SECOND,
  DEFAULT_RATE_LIMIT_BACKOFF_MS,
  MAX_RATE_LIMIT_BACKOFF_MS,
  TokenBucket,
} from "./rate-limit.js"

/**
 * Build a stand-in client that records the concurrency at the moment each
 * call enters and exits. Async methods return once every outstanding call
 * is accounted for, which lets the test assert exact-cap behaviour after
 * the whole batch resolves.
 *
 * Returned stub exposes `blocks.children.list` and `pages.properties.retrieve`
 * so the three-level namespace path is observable, plus flat methods for the
 * top-level and sub-namespace cases.
 */
function makeObservableClient(callDurationMs = 20): {
  client: Client
  maxInFlight: () => number
  callCount: () => number
} {
  let inFlight = 0
  let maxInFlight = 0
  let callCount = 0

  const track = async () => {
    callCount++
    inFlight++
    if (inFlight > maxInFlight) maxInFlight = inFlight
    if (callDurationMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, callDurationMs))
    }
    inFlight--
  }

  const stub = {
    pages: {
      retrieve: () => track(),
      update: () => track(),
      properties: { retrieve: () => track() },
    },
    blocks: {
      children: { list: () => track(), append: () => track() },
    },
    dataSources: {
      query: () => track(),
    },
    search: () => track(),
    // Top-level `client.request` is the SDK seam the RunTool wrapper
    // dispatches through (issue #533 wired `create_pages`; issue #534
    // wired `update_page`). The recursive Proxy already wraps it
    // because `request` is a top-level method, but the invariant is
    // easy to silently regress — a future SDK refactor that flipped
    // `request` into a different shape (a function returning a
    // function, a getter, etc.) could drop it out of the wrap with no
    // type-level signal. The pacing/cap tests below pin the
    // contract; without this stub neither would observe the SDK
    // path. AGENTS.md's rate-limit module section codifies the rule:
    // "every new SDK call site needs rate-limit coverage."
    request: () => track(),
  } as unknown as Client

  return {
    client: stub,
    maxInFlight: () => maxInFlight,
    callCount: () => callCount,
  }
}

/**
 * Effectively-bypass options bag used by the concurrency-only tests
 * below. `DEFAULT_NOTION_REQUESTS_PER_SECOND` would dominate the
 * assertions: a burst of 10 short calls under default pacing finishes
 * serially and shows `maxInFlight = 1` because each call is done
 * before the next token arrives. Setting rps + burst high effectively
 * disables the rate gate so the assertions observe pure `p-limit`
 * behavior.
 *
 * Named for the *intent* — "no pacing" — rather than the surface
 * shape ("fast rate"). A future test that wants to assert pacing
 * behavior would NOT use this constant.
 */
const RATE_GATE_DISABLED = { requestsPerSecond: 1000, burstSize: 1000 } as const

/** Suppress the default `[lore] notion-sdk warn:` stderr line on tests
 * that intentionally trigger 429 backoff. Tests that want to *assert*
 * the emission build their own recording callback. */
const SILENT_BACKOFF = { onBackoff: () => {} } as const

describe("createLimitedClient — concurrency gate", () => {
  it("exactly saturates concurrency at the cap — 10 calls × 20ms × 3", async () => {
    const { client, maxInFlight, callCount } = makeObservableClient()
    const limited = createLimitedClient(client, { concurrency: 3, ...RATE_GATE_DISABLED })

    // 10 calls, each 20ms. With concurrency=3 there is always work in flight
    // until the last three calls — maxInFlight MUST equal 3, not just be
    // bounded by it. `toBeLessThanOrEqual(3)` would pass trivially if the
    // stub never actually ran.
    await Promise.all(
      Array.from({ length: 10 }, () => limited.dataSources.query({} as never)),
    )

    expect(callCount()).toBe(10)
    expect(maxInFlight()).toBe(3)
  })

  it("caps concurrency on top-level client methods like search", async () => {
    const { client, maxInFlight, callCount } = makeObservableClient()
    const limited = createLimitedClient(client, { concurrency: 2, ...RATE_GATE_DISABLED })

    await Promise.all(
      Array.from({ length: 6 }, () => limited.search({} as never)),
    )

    expect(callCount()).toBe(6)
    expect(maxInFlight()).toBe(2)
  })

  it("caps concurrency on client.request (RunTool seam, issue #533)", async () => {
    // The RunTool wrapper (`src/notion/runtool/client.ts`) routes
    // every `runTool(...)` call through `client.request<T>({...})`.
    // The recursive Proxy already wraps top-level methods, but
    // CLAUDE.md's rate-limit module section explicitly asks for a
    // pacing/cap test per new SDK call site so a future SDK
    // refactor that flipped `request` into a different shape
    // (a function returning a function, a getter, etc.) cannot
    // silently bypass the wrap. Without this case, RunTool calls
    // could blow the per-token rps ceiling without any type-level
    // signal.
    const { client, maxInFlight, callCount } = makeObservableClient()
    const limited = createLimitedClient(client, {
      concurrency: 2,
      ...RATE_GATE_DISABLED,
    })

    await Promise.all(
      Array.from({ length: 6 }, () =>
        (
          limited as unknown as {
            request: (args: Record<string, unknown>) => Promise<unknown>
          }
        ).request({ method: "post", path: "tools/run", body: {} })
      )
    )

    expect(callCount()).toBe(6)
    expect(maxInFlight()).toBe(2)
  })

  it("caps three-level namespaces like blocks.children.list", async () => {
    // setup.ts uses `client.blocks.children.list` and the SDK also exposes
    // `client.pages.properties.retrieve`. A one-level-deep Proxy would leave
    // these ungoverned — this test pins the recursive wrap.
    const { client, maxInFlight, callCount } = makeObservableClient()
    const limited = createLimitedClient(client, { concurrency: 2, ...RATE_GATE_DISABLED })

    await Promise.all([
      ...Array.from({ length: 3 }, () => limited.blocks.children.list({} as never)),
      ...Array.from({ length: 3 }, () =>
        limited.pages.properties.retrieve({} as never),
      ),
    ])

    expect(callCount()).toBe(6)
    expect(maxInFlight()).toBe(2)
  })

  it("shares the same gate across every namespace", async () => {
    const { client, maxInFlight, callCount } = makeObservableClient()
    const limited = createLimitedClient(client, { concurrency: 2, ...RATE_GATE_DISABLED })

    await Promise.all([
      limited.pages.retrieve({} as never),
      limited.pages.update({} as never),
      limited.pages.properties.retrieve({} as never),
      limited.dataSources.query({} as never),
      limited.blocks.children.list({} as never),
      limited.search({} as never),
    ])

    expect(callCount()).toBe(6)
    expect(maxInFlight()).toBe(2)
  })

  it("caps concurrency on top-level client.request — RunTool dispatch path (issue #534)", async () => {
    // RunTool dispatches via `client.request({ path: "tools/run",
    // method: "post", body })` — the SDK-relative form, NOT
    // `"/v1/tools/run"`. The Notion v5 SDK builds the wire URL as
    // `${prefixUrl}${path}` where `prefixUrl = ${baseUrl}/v1/`, so a
    // leading slash here would produce a double-prefix bug; the
    // wire-URL contract is pinned in `src/notion/runtool/client.ts`'s
    // `RUNTOOL_PATH` docstring and exercised by a real-Client test in
    // `src/notion/runtool/update-page.test.ts`. The limiter must
    // govern this path the same way it governs `client.search` —
    // without this assertion a future SDK refactor that dropped
    // `request` out of the wrap would silently bypass the
    // concurrency cap and the token-bucket gate for every RunTool
    // call site.
    const { client, maxInFlight, callCount } = makeObservableClient()
    const limited = createLimitedClient(client, { concurrency: 2, ...RATE_GATE_DISABLED })

    await Promise.all(
      Array.from({ length: 6 }, () => limited.request({} as never)),
    )

    expect(callCount()).toBe(6)
    expect(maxInFlight()).toBe(2)
  })

  it("releases the slot when a call rejects so the next call proceeds", async () => {
    // If p-limit kept a rejected call in flight, a transient Notion 5xx
    // would permanently narrow the concurrency window. Pin that it doesn't.
    let attempt = 0
    const stub = {
      pages: {
        retrieve: async () => {
          attempt++
          if (attempt === 1) throw new Error("transient")
          return { id: "ok" }
        },
      },
    } as unknown as Client
    const limited = createLimitedClient(stub, { concurrency: 1, ...RATE_GATE_DISABLED })

    await expect(limited.pages.retrieve({} as never)).rejects.toThrow("transient")
    // If the slot leaked we'd block here forever; the test timeout would fail.
    const result = await limited.pages.retrieve({} as never)
    expect(result).toEqual({ id: "ok" })
    expect(attempt).toBe(2)
  })

  it("rejects non-integer or non-positive concurrency at construction time", () => {
    const { client } = makeObservableClient()
    expect(() => createLimitedClient(client, 0)).toThrow(/concurrency/)
    expect(() => createLimitedClient(client, -1)).toThrow(/concurrency/)
    expect(() => createLimitedClient(client, Number.NaN)).toThrow(/concurrency/)
    // Floats are rejected — the error message promises "positive integer"
    // and the Zod schema is `.int()`. No silent rounding.
    expect(() => createLimitedClient(client, 2.5)).toThrow(/positive integer/)
    expect(() => createLimitedClient(client, Infinity)).toThrow(/positive integer/)
  })

  it("rejects non-positive requestsPerSecond / burstSize at construction time", () => {
    const { client } = makeObservableClient()
    expect(() =>
      createLimitedClient(client, { requestsPerSecond: 0 }),
    ).toThrow(/requestsPerSecond/)
    expect(() =>
      createLimitedClient(client, { requestsPerSecond: -1 }),
    ).toThrow(/requestsPerSecond/)
    expect(() => createLimitedClient(client, { burstSize: 0 })).toThrow(
      /burstSize/,
    )
    // burstSize must be an integer; rps may be a float (e.g. 0.5/s = 1
    // every two seconds is a sensible operator override).
    expect(() => createLimitedClient(client, { burstSize: 2.5 })).toThrow(
      /positive integer/,
    )
  })

  it("passes through non-function, non-object properties unchanged", () => {
    const fake = {
      version: "5.0.0",
      pages: { retrieve: () => Promise.resolve("ok") },
    } as unknown as Client

    const limited = createLimitedClient(fake, 3)
    expect((limited as unknown as { version: string }).version).toBe("5.0.0")
  })

  it("exposes the public default constants for cross-module reuse", () => {
    // services.ts dropped the explicit fallback after createLimitedClient
    // started defaulting internally; the constants remain part of the
    // public surface for future call sites that want to override on a
    // per-flow basis. The literal-pin below is the guard that catches
    // an accidental drift away from the values the rate-limit
    // docstring is justifying — the rationale lives there.
    expect(DEFAULT_NOTION_CONCURRENCY).toBe(10)
    expect(DEFAULT_NOTION_REQUESTS_PER_SECOND).toBe(20)
    expect(DEFAULT_NOTION_BURST_SIZE).toBe(10)
  })
})

describe("createLimitedClient — token bucket pacing", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("paces a burst of calls beyond the bucket capacity", async () => {
    // 10 calls, burst=3, 10 rps → first 3 fire instantly, then one
    // every 100ms. p-limit cap of 10 means concurrency isn't the
    // bottleneck — the rate limiter is.
    const { client, callCount } = makeObservableClient(0)
    const limited = createLimitedClient(client, {
      concurrency: 10,
      requestsPerSecond: 10,
      burstSize: 3,
    })

    const promises = Array.from({ length: 10 }, () =>
      limited.dataSources.query({} as never),
    )

    // Burst window: only 3 should have started.
    await vi.advanceTimersByTimeAsync(0)
    expect(callCount()).toBe(3)

    // Advance 100ms — one token refilled.
    await vi.advanceTimersByTimeAsync(100)
    expect(callCount()).toBe(4)

    // Advance another 200ms — two more tokens.
    await vi.advanceTimersByTimeAsync(200)
    expect(callCount()).toBe(6)

    // Advance the rest.
    await vi.advanceTimersByTimeAsync(700)
    await Promise.all(promises)
    expect(callCount()).toBe(10)
  })

  it("paces a burst of client.request calls beyond the bucket capacity (RunTool dispatch — issue #534)", async () => {
    // Mirror of the typed-method pacing test for the top-level
    // `request` path. RunTool's per-tool, per-actor server-side bucket
    // is independent of REST's bucket but BOTH route through the same
    // `Authorization` header on the wire — composing through this
    // gate keeps Lore's outbound rate under the lower of the two
    // ceilings without standing up a parallel pacer. Pinning the gate
    // explicitly on `request` is the test contract from the
    // src/notion/runtool/README.md "Rate-Limit Accounting" section.
    const { client, callCount } = makeObservableClient(0)
    const limited = createLimitedClient(client, {
      concurrency: 10,
      requestsPerSecond: 10,
      burstSize: 3,
    })

    const promises = Array.from({ length: 10 }, () => limited.request({} as never))

    await vi.advanceTimersByTimeAsync(0)
    expect(callCount()).toBe(3)

    await vi.advanceTimersByTimeAsync(100)
    expect(callCount()).toBe(4)

    await vi.advanceTimersByTimeAsync(200)
    expect(callCount()).toBe(6)

    await vi.advanceTimersByTimeAsync(700)
    await Promise.all(promises)
    expect(callCount()).toBe(10)
  })

  it("paces a burst of pages.retrieve calls (RunTool search hydration fan-out — issue #541)", async () => {
    // The `MemoryService.fetchSemanticPagesViaRunTool` helper
    // hydrates up to RUNTOOL_SEARCH_MAX_PAGE_SIZE (25) hits via
    // `pages.retrieve`. Per CLAUDE.md's "When the new path lands
    // in a hot fan-out" doctrine, the hot fan-out shape needs its
    // own pacing test — a future SDK refactor that flipped
    // `pages.retrieve` out of the recursive Proxy wrap would
    // silently blow the per-token rps ceiling for every search
    // dispatch. The hydration loop is sequential under the
    // implementation, but a concurrent caller (or a future
    // parallelization) would also see the gate applied.
    const { client, callCount } = makeObservableClient(0)
    const limited = createLimitedClient(client, {
      concurrency: 25,
      requestsPerSecond: 10,
      burstSize: 3,
    })

    const promises = Array.from({ length: 10 }, () =>
      limited.pages.retrieve({} as never),
    )

    await vi.advanceTimersByTimeAsync(0)
    expect(callCount()).toBe(3)

    await vi.advanceTimersByTimeAsync(100)
    expect(callCount()).toBe(4)

    await vi.advanceTimersByTimeAsync(200)
    expect(callCount()).toBe(6)

    await vi.advanceTimersByTimeAsync(700)
    await Promise.all(promises)
    expect(callCount()).toBe(10)
  })

  it("preserves burst-instant behavior when call count fits the bucket", async () => {
    // 3 calls, burst=3 — every call fires within the same tick. The
    // token bucket does NOT add latency to short fan-outs that fit
    // under the burst cap; that property is what makes the default
    // safe to apply unconditionally.
    const { client, callCount } = makeObservableClient(0)
    const limited = createLimitedClient(client, {
      concurrency: 5,
      requestsPerSecond: 3,
      burstSize: 3,
    })

    const promises = Array.from({ length: 3 }, () =>
      limited.dataSources.query({} as never),
    )

    await vi.advanceTimersByTimeAsync(0)
    expect(callCount()).toBe(3)
    await Promise.all(promises)
  })
})

describe("createLimitedClient — 429 shared backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("pauses the bucket on 429 with a retry-after header (delta-seconds)", async () => {
    // The SDK retries 429s internally; this test simulates the case
    // where the SDK has exhausted its budget and the 429 surfaces to
    // our wrapper. The wrapper should pause the bucket so a SUBSEQUENT
    // call on this same client backs off until retry-after elapses.
    //
    // Dispatching the sibling AFTER awaiting the failing call's
    // rejection is the load-bearing piece of the test: a sibling that
    // raced the 429 (kicked off concurrently) might already hold its
    // token and a slot, in which case the bucket pause has nothing to
    // gate. The realistic threat model the wrapper is defending
    // against is the sustained-throttling case where 429s land back-
    // to-back, so the right pin is "next call after the 429 sees the
    // pause," not "every concurrent in-flight call sees the pause."
    const stub = {
      pages: {
        retrieve: async () => {
          const err = Object.assign(new Error("rate_limited"), {
            code: "rate_limited",
            status: 429,
            headers: new Headers({ "retry-after": "2" }),
          })
          throw err
        },
        update: async () => "ok",
      },
    } as unknown as Client
    const limited = createLimitedClient(
      stub,
      {
        concurrency: 5,
        requestsPerSecond: 1000, // not the bottleneck under no-pause
        burstSize: 5,
      },
      SILENT_BACKOFF,
    )

    await expect(limited.pages.retrieve({} as never)).rejects.toThrow(
      "rate_limited",
    )

    // Now the bucket is paused. Fire the next call — it should NOT
    // complete until retry-after elapses.
    let siblingSettled = false
    const sibling = limited.pages.update({} as never).then((value) => {
      siblingSettled = true
      return value
    })

    await vi.advanceTimersByTimeAsync(500)
    expect(siblingSettled).toBe(false)

    // Advance past the retry-after window. Sibling completes.
    await vi.advanceTimersByTimeAsync(2000)
    await sibling
    expect(siblingSettled).toBe(true)
  })

  it("falls back to a default backoff when retry-after is absent", async () => {
    // The error has no headers — the wrapper should still pause the
    // bucket using its built-in default backoff so concurrent
    // siblings don't immediately re-fire into the same throttling
    // event. Pin the fallback at the observable level (sibling
    // doesn't complete inside 100ms) without locking the exact
    // numeric value.
    const stub = {
      pages: {
        retrieve: async () => {
          const err = Object.assign(new Error("rate_limited"), {
            code: "rate_limited",
            status: 429,
          })
          throw err
        },
        update: async () => "ok",
      },
    } as unknown as Client
    const limited = createLimitedClient(
      stub,
      {
        concurrency: 5,
        requestsPerSecond: 1000,
        burstSize: 5,
      },
      SILENT_BACKOFF,
    )

    await expect(limited.pages.retrieve({} as never)).rejects.toThrow(
      "rate_limited",
    )

    let siblingSettled = false
    const sibling = limited.pages.update({} as never).then((value) => {
      siblingSettled = true
      return value
    })

    // Inside the default backoff window — sibling still queued.
    await vi.advanceTimersByTimeAsync(100)
    expect(siblingSettled).toBe(false)
    // Past the default backoff — sibling completes. Pinning to the
    // exported constant rather than a hardcoded literal so a future
    // tuning of the default backoff propagates to the test
    // automatically.
    await vi.advanceTimersByTimeAsync(DEFAULT_RATE_LIMIT_BACKOFF_MS + 500)
    await sibling
    expect(siblingSettled).toBe(true)
  })

  it("propagates the 429 pause to in-flight concurrent siblings (CR-1 fix)", async () => {
    // Acquire-token-INSIDE-slot is the load-bearing fix for CR-1.
    // Under the old (acquire-before-slot) ordering, all 5 callers
    // would grab tokens immediately (burst=5), then queue in
    // p-limit. Once call 1 returned a 429 and paused the bucket,
    // calls 2..5 already had their tokens; their slots would open
    // and they would dispatch WITHOUT observing the pause —
    // breaking the shared-backoff guarantee whenever
    // `burstSize > concurrency`.
    //
    // Under the new (acquire-inside-slot) ordering, each caller
    // awaits `bucket.acquire()` only when its slot opens, so the
    // pause registered by call 1's 429 is observed by the next
    // caller's `bucket.acquire()` regardless of how big the
    // burst was at dispatch time.
    let firstFailed = false
    const stub = {
      pages: {
        retrieve: async () => {
          if (!firstFailed) {
            firstFailed = true
            const err = Object.assign(new Error("rate_limited"), {
              code: "rate_limited",
              status: 429,
              headers: new Headers({ "retry-after": "2" }),
            })
            throw err
          }
          return { id: "ok" }
        },
      },
    } as unknown as Client
    const limited = createLimitedClient(
      stub,
      {
        concurrency: 1, // tight slot contention so siblings serialize
        requestsPerSecond: 1000,
        burstSize: 5, // > concurrency: would mask the bug under old order
      },
      SILENT_BACKOFF,
    )

    // Fire 3 concurrent calls; with concurrency=1 they serialize.
    // Call 1 throws 429; calls 2 and 3 should observe the pause.
    let secondSettled = false
    const c1 = limited.pages.retrieve({} as never).catch(() => "rejected")
    const c2 = limited.pages.retrieve({} as never).then((v) => {
      secondSettled = true
      return v
    })

    await vi.advanceTimersByTimeAsync(0)
    await c1
    expect(secondSettled).toBe(false)

    // Inside the 2s pause window — call 2 should still be queued.
    await vi.advanceTimersByTimeAsync(500)
    expect(secondSettled).toBe(false)

    // Past the pause — call 2 completes successfully (the stub now
    // returns { id: "ok" }).
    await vi.advanceTimersByTimeAsync(2000)
    await c2
    expect(secondSettled).toBe(true)
  })

  it("clamps an unbounded retry-after to MAX_RATE_LIMIT_BACKOFF_MS (CR-2 fix)", async () => {
    // A malicious or buggy `Retry-After: 86400` (24h) would freeze
    // the entire client for a day if the wrapper trusted the value
    // verbatim. Pin the clamp at the observable level — sibling
    // completes within max + slack, NOT 24 hours later.
    const stub = {
      pages: {
        retrieve: async () => {
          const err = Object.assign(new Error("rate_limited"), {
            code: "rate_limited",
            status: 429,
            headers: new Headers({ "retry-after": "86400" }), // 24h
          })
          throw err
        },
        update: async () => "ok",
      },
    } as unknown as Client
    const recorded: Array<{ ms: number; source: string }> = []
    const limited = createLimitedClient(
      stub,
      { concurrency: 5, requestsPerSecond: 1000, burstSize: 5 },
      { onBackoff: (ms, source) => recorded.push({ ms, source }) },
    )

    await expect(limited.pages.retrieve({} as never)).rejects.toThrow(
      "rate_limited",
    )

    // The clamp lands at MAX_RATE_LIMIT_BACKOFF_MS exactly.
    expect(recorded).toEqual([
      { ms: MAX_RATE_LIMIT_BACKOFF_MS, source: "header-clamped" },
    ])

    let siblingSettled = false
    const sibling = limited.pages.update({} as never).then((v) => {
      siblingSettled = true
      return v
    })

    // Just shy of the clamp ceiling — sibling still waiting.
    await vi.advanceTimersByTimeAsync(MAX_RATE_LIMIT_BACKOFF_MS - 1000)
    expect(siblingSettled).toBe(false)

    // Past the clamp — sibling completes (NOT 24 hours later).
    await vi.advanceTimersByTimeAsync(2000)
    await sibling
    expect(siblingSettled).toBe(true)
  })

  it("emits onBackoff with source=header for parsed retry-after", async () => {
    const stub = {
      pages: {
        retrieve: async () => {
          const err = Object.assign(new Error("rate_limited"), {
            code: "rate_limited",
            status: 429,
            headers: new Headers({ "retry-after": "5" }),
          })
          throw err
        },
      },
    } as unknown as Client
    const recorded: Array<{ ms: number; source: string }> = []
    const limited = createLimitedClient(
      stub,
      { concurrency: 1, ...RATE_GATE_DISABLED },
      { onBackoff: (ms, source) => recorded.push({ ms, source }) },
    )
    await vi.useRealTimers()
    await expect(limited.pages.retrieve({} as never)).rejects.toThrow()
    expect(recorded).toEqual([{ ms: 5000, source: "header" }])
  })

  it("emits onBackoff with source=default when retry-after is absent", async () => {
    const stub = {
      pages: {
        retrieve: async () => {
          const err = Object.assign(new Error("rate_limited"), {
            code: "rate_limited",
            status: 429,
          })
          throw err
        },
      },
    } as unknown as Client
    const recorded: Array<{ ms: number; source: string }> = []
    const limited = createLimitedClient(
      stub,
      { concurrency: 1, ...RATE_GATE_DISABLED },
      { onBackoff: (ms, source) => recorded.push({ ms, source }) },
    )
    await vi.useRealTimers()
    await expect(limited.pages.retrieve({} as never)).rejects.toThrow()
    expect(recorded).toEqual([
      { ms: DEFAULT_RATE_LIMIT_BACKOFF_MS, source: "default" },
    ])
  })

  it("a throwing onBackoff does NOT poison error propagation", async () => {
    // An observability hook that fails (telemetry endpoint down,
    // logger init race) MUST NOT mask the original 429 from the
    // caller. Without the inner try/catch around `onBackoff(...)`,
    // the throw would replace the original error and break every
    // existing call-site error handler.
    const stub = {
      pages: {
        retrieve: async () => {
          const err = Object.assign(new Error("rate_limited"), {
            code: "rate_limited",
            status: 429,
          })
          throw err
        },
      },
    } as unknown as Client
    const limited = createLimitedClient(
      stub,
      { concurrency: 1, ...RATE_GATE_DISABLED },
      {
        onBackoff: () => {
          throw new Error("telemetry exploded")
        },
      },
    )
    await vi.useRealTimers()
    // The caller still sees the original rate_limited error — NOT
    // "telemetry exploded".
    await expect(limited.pages.retrieve({} as never)).rejects.toThrow(
      "rate_limited",
    )
  })

  it("parses an HTTP-date retry-after header (Q2 fixed-time format)", async () => {
    // The Notion docs show integer-seconds in practice, but RFC 7231
    // also allows HTTP-date format. The SDK's internal parser
    // handles both; the wrapper's parser must too so we don't
    // mishandle a header from a future SDK fixture or a misbehaving
    // proxy. Use vi.setSystemTime so Date.parse() and the bucket's
    // injected clock agree on "now".
    vi.setSystemTime(new Date("2026-05-02T12:00:00.000Z"))
    const future = new Date("2026-05-02T12:00:03.000Z").toUTCString()
    const stub = {
      pages: {
        retrieve: async () => {
          const err = Object.assign(new Error("rate_limited"), {
            code: "rate_limited",
            status: 429,
            headers: new Headers({ "retry-after": future }),
          })
          throw err
        },
      },
    } as unknown as Client
    const recorded: Array<{ ms: number; source: string }> = []
    const limited = createLimitedClient(
      stub,
      { concurrency: 1, ...RATE_GATE_DISABLED },
      { onBackoff: (ms, source) => recorded.push({ ms, source }) },
    )
    await expect(limited.pages.retrieve({} as never)).rejects.toThrow()
    expect(recorded.length).toBe(1)
    // 3 seconds in the future per the date header.
    expect(recorded[0].ms).toBe(3000)
    expect(recorded[0].source).toBe("header")
  })

  it("falls back to default when retry-after is malformed", async () => {
    const stub = {
      pages: {
        retrieve: async () => {
          const err = Object.assign(new Error("rate_limited"), {
            code: "rate_limited",
            status: 429,
            headers: new Headers({ "retry-after": "not a number or date" }),
          })
          throw err
        },
      },
    } as unknown as Client
    const recorded: Array<{ ms: number; source: string }> = []
    const limited = createLimitedClient(
      stub,
      { concurrency: 1, ...RATE_GATE_DISABLED },
      { onBackoff: (ms, source) => recorded.push({ ms, source }) },
    )
    await vi.useRealTimers()
    await expect(limited.pages.retrieve({} as never)).rejects.toThrow()
    // Unparseable → falls through to default backoff with source=default.
    expect(recorded).toEqual([
      { ms: DEFAULT_RATE_LIMIT_BACKOFF_MS, source: "default" },
    ])
  })

  it("retry-after: 0 falls back to default backoff (Q2)", async () => {
    // Edge case in the parser: `extractRetryAfterMs` returns 0 for
    // `retry-after: 0`, and the wrapper's `?? DEFAULT_…` operator
    // does NOT short-circuit on 0 (only on null/undefined). 0 is
    // truthy enough to bypass the fallback. So the result is:
    //   parsed = 0 → ms = 0 → clamped = min(0, MAX) = 0 → pauseFor(0)
    //   → early-return inside pauseFor; bucket NOT actually paused.
    //
    // Pin this as intentional: a server saying "retry whenever"
    // shouldn't gratuitously force a 1-second backoff. The
    // emitted source is "header" (we DID parse a value), the ms
    // is 0, and the next caller proceeds without bucket gating.
    // If a future patch wants `retry-after: 0` to mean "use the
    // default floor anyway," it must change the wrapper, NOT the
    // parser — pinning here so the change is observable.
    const stub = {
      pages: {
        retrieve: async () => {
          const err = Object.assign(new Error("rate_limited"), {
            code: "rate_limited",
            status: 429,
            headers: new Headers({ "retry-after": "0" }),
          })
          throw err
        },
        update: async () => "ok",
      },
    } as unknown as Client
    const recorded: Array<{ ms: number; source: string }> = []
    const limited = createLimitedClient(
      stub,
      { concurrency: 5, requestsPerSecond: 1000, burstSize: 5 },
      { onBackoff: (ms, source) => recorded.push({ ms, source }) },
    )
    await expect(limited.pages.retrieve({} as never)).rejects.toThrow()
    expect(recorded).toEqual([{ ms: 0, source: "header" }])

    // Bucket NOT paused — next caller proceeds immediately.
    let siblingSettled = false
    limited.pages.update({} as never).then(() => {
      siblingSettled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(siblingSettled).toBe(true)
  })

  it("propagates the 429 to the calling code (wrapper does not swallow)", async () => {
    // Pausing the bucket is a side effect; the original error MUST
    // still surface to the caller so the existing call-site error
    // handling (telemetry, retry-at-callsite, structured logs) keeps
    // working. The wrapper is additive, not lossy.
    const stub = {
      pages: {
        retrieve: async () => {
          const err = Object.assign(new Error("rate_limited"), {
            code: "rate_limited",
            status: 429,
          })
          throw err
        },
      },
    } as unknown as Client
    const limited = createLimitedClient(
      stub,
      { concurrency: 1, ...RATE_GATE_DISABLED },
      SILENT_BACKOFF,
    )

    await vi.useRealTimers()
    await expect(limited.pages.retrieve({} as never)).rejects.toThrow(
      "rate_limited",
    )
  })
})

describe("TokenBucket", () => {
  it("issues capacity tokens immediately, then refills at rate", async () => {
    vi.useFakeTimers()
    try {
      const bucket = new TokenBucket(3, 10) // burst=3, 10 tokens/sec
      const acquired: number[] = []
      const promises = Array.from({ length: 10 }, (_, i) =>
        bucket.acquire().then(() => acquired.push(i)),
      )

      // Burst window: 3 acquired.
      await vi.advanceTimersByTimeAsync(0)
      expect(acquired.length).toBe(3)

      // 100ms → 1 more.
      await vi.advanceTimersByTimeAsync(100)
      expect(acquired.length).toBe(4)

      // 700ms more → catches up.
      await vi.advanceTimersByTimeAsync(700)
      await Promise.all(promises)
      expect(acquired.length).toBe(10)
    } finally {
      vi.useRealTimers()
    }
  })

  it("issues tokens in FIFO order so early waiters never starve", async () => {
    vi.useFakeTimers()
    try {
      const bucket = new TokenBucket(1, 5) // burst=1, 5 tokens/sec
      const order: number[] = []
      const promises = [0, 1, 2, 3].map((i) =>
        bucket.acquire().then(() => order.push(i)),
      )

      await vi.advanceTimersByTimeAsync(0)
      expect(order).toEqual([0])

      await vi.advanceTimersByTimeAsync(200)
      expect(order).toEqual([0, 1])

      await vi.advanceTimersByTimeAsync(200)
      expect(order).toEqual([0, 1, 2])

      await vi.advanceTimersByTimeAsync(200)
      await Promise.all(promises)
      expect(order).toEqual([0, 1, 2, 3])
    } finally {
      vi.useRealTimers()
    }
  })

  it("pauseFor delays new acquisitions until the pause expires and drains the bucket", async () => {
    vi.useFakeTimers()
    try {
      const bucket = new TokenBucket(3, 1000) // burst=3, very fast refill
      // Drain the burst manually so the next acquire is gated entirely
      // by the pause + refill, not the leftover capacity.
      await bucket.acquire()
      await bucket.acquire()
      await bucket.acquire()

      bucket.pauseFor(500)

      let resolved = false
      const next = bucket.acquire().then(() => {
        resolved = true
      })

      await vi.advanceTimersByTimeAsync(100)
      expect(resolved).toBe(false)

      await vi.advanceTimersByTimeAsync(500)
      await next
      expect(resolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("pauseFor + slow refill: post-pause caller waits pause + 1/rps for first token", async () => {
    // Drain semantics: pauseFor sets `tokens = 0` AND `lastRefillMs =
    // pausedUntilMs`. So a caller queued during the pause has to wait
    // the pause window PLUS the first refill interval (`1/rps` seconds)
    // before its token is issued. With fast refill (rps=1000) the
    // post-pause refill is ~1ms and invisible; with slow refill
    // (rps=2 → 500ms per token) it's observable.
    //
    // The behavior is intentional — preserving the bucket's "no
    // bursting after backoff" guarantee. If the bucket retained one
    // token at pause-expiry, the next caller would fire instantly,
    // potentially re-entering the same throttling window the 429
    // signaled. Documenting via test so a future refactor that
    // "fixes" the extra refill interval reads as a behavioral
    // change, not a cleanup.
    vi.useRealTimers() // section uses real timers; switch back at end
    const bucket = new TokenBucket(1, 2) // burst=1, 2 tokens/sec → 500ms/token
    await bucket.acquire() // drain the burst
    bucket.pauseFor(500)

    const start = Date.now()
    await bucket.acquire()
    const elapsed = Date.now() - start

    // Pause (500) + refill interval (500) = 1000ms minimum. Allow ±50ms slack
    // for setTimeout drift.
    expect(elapsed).toBeGreaterThanOrEqual(950)
    expect(elapsed).toBeLessThan(1200)
    // No `vi.useFakeTimers()` cleanup needed: every other test in this
    // describe sets its own timer mode at the top of its body, so a
    // restoration here would be unreachable defense.
  })

  it("pauseFor does not shorten an existing pause", async () => {
    vi.useFakeTimers()
    try {
      const bucket = new TokenBucket(1, 1000)
      await bucket.acquire()

      bucket.pauseFor(1000)
      // A shorter pauseFor must not move the resume time earlier.
      bucket.pauseFor(100)

      let resolved = false
      const next = bucket.acquire().then(() => {
        resolved = true
      })

      await vi.advanceTimersByTimeAsync(500)
      expect(resolved).toBe(false)

      await vi.advanceTimersByTimeAsync(600)
      await next
      expect(resolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("rejects non-positive capacity / refill at construction", () => {
    expect(() => new TokenBucket(0, 1)).toThrow(/burstSize/)
    expect(() => new TokenBucket(-1, 1)).toThrow(/burstSize/)
    expect(() => new TokenBucket(1, 0)).toThrow(/requestsPerSecond/)
    expect(() => new TokenBucket(1, -1)).toThrow(/requestsPerSecond/)
    expect(() => new TokenBucket(Number.NaN, 1)).toThrow(/burstSize/)
    expect(() => new TokenBucket(1, Number.NaN)).toThrow(/requestsPerSecond/)
  })

  it("works with custom now()/setTimer deps for unit-test injection", async () => {
    let now = 0
    const timers: Array<{ at: number; cb: () => void }> = []
    const advance = async (ms: number) => {
      now += ms
      // Fire any timers whose target time has passed, in due order.
      while (true) {
        const idx = timers.findIndex((t) => t.at <= now)
        if (idx === -1) break
        const [fired] = timers.splice(idx, 1)
        fired.cb()
        // Drain microtasks so promise continuations run.
        await Promise.resolve()
        await Promise.resolve()
      }
    }
    const bucket = new TokenBucket(1, 10, {
      now: () => now,
      setTimer: (cb, ms) => {
        timers.push({ at: now + ms, cb })
      },
    })

    const acquired: number[] = []
    const p0 = bucket.acquire().then(() => acquired.push(0))
    const p1 = bucket.acquire().then(() => acquired.push(1))
    const p2 = bucket.acquire().then(() => acquired.push(2))

    await Promise.resolve()
    expect(acquired).toEqual([0])

    await advance(100)
    expect(acquired).toEqual([0, 1])

    await advance(100)
    await Promise.all([p0, p1, p2])
    expect(acquired).toEqual([0, 1, 2])
  })
})
