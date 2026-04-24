import { describe, expect, it } from "vitest"
import type { Client } from "@notionhq/client"
import { createLimitedClient } from "./rate-limit.js"

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
    await new Promise((resolve) => setTimeout(resolve, callDurationMs))
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
  } as unknown as Client

  return {
    client: stub,
    maxInFlight: () => maxInFlight,
    callCount: () => callCount,
  }
}

describe("createLimitedClient", () => {
  it("exactly saturates concurrency at the cap — 10 calls × 20ms × 3", async () => {
    const { client, maxInFlight, callCount } = makeObservableClient()
    const limited = createLimitedClient(client, 3)

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
    const limited = createLimitedClient(client, 2)

    await Promise.all(
      Array.from({ length: 6 }, () => limited.search({} as never)),
    )

    expect(callCount()).toBe(6)
    expect(maxInFlight()).toBe(2)
  })

  it("caps three-level namespaces like blocks.children.list", async () => {
    // setup.ts uses `client.blocks.children.list` and the SDK also exposes
    // `client.pages.properties.retrieve`. A one-level-deep Proxy would leave
    // these ungoverned — this test pins the recursive wrap.
    const { client, maxInFlight, callCount } = makeObservableClient()
    const limited = createLimitedClient(client, 2)

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
    const limited = createLimitedClient(client, 2)

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
    const limited = createLimitedClient(stub, 1)

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

  it("passes through non-function, non-object properties unchanged", () => {
    const fake = {
      version: "5.0.0",
      pages: { retrieve: () => Promise.resolve("ok") },
    } as unknown as Client

    const limited = createLimitedClient(fake, 3)
    expect((limited as unknown as { version: string }).version).toBe("5.0.0")
  })
})
