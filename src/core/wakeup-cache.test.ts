import { describe, expect, it } from "vitest"
import { WakeUpCache, computeWakeUpCacheKey } from "./wakeup-cache.js"
import type { WakeUpData, WakeUpOptions } from "./wakeup.js"

function makeData(): WakeUpData {
  return {
    digest: null,
    memories: [],
    knowledgeFacts: [],
    proposedDecisions: [],
    overdueDecisions: [],
    overdueDecisionsCapped: false,
    relatedMemories: [],
    tasks: [],
    taskBucketCoverage: {
      overdueCapped: false,
      staleCapped: false,
      activeCapped: false,
    },
    taskMemories: [],
    proposedMemories: [],
    proposedMemoriesTotal: 0,
    staleConfidence: [],
    coverage: null,
    inheritedMemories: [],
  }
}

describe("WakeUpCache", () => {
  it("returns hits for the same key while still inside TTL and at the same epoch", () => {
    const cache = new WakeUpCache()
    const data = makeData()
    const startEpoch = cache.currentEpoch

    expect(cache.set("key-1", data, startEpoch)).toBe(true)
    expect(cache.get("key-1")).toBe(data)
    expect(cache.size).toBe(1)
  })

  it("misses on a different cache key", () => {
    const cache = new WakeUpCache()
    cache.set("key-1", makeData(), cache.currentEpoch)

    expect(cache.get("key-other")).toBeUndefined()
  })

  it("invalidates on bumpEpoch — a save between two wake-ups re-fetches", () => {
    const cache = new WakeUpCache()
    const data = makeData()
    cache.set("key-1", data, cache.currentEpoch)

    cache.bumpEpoch()

    // Stored entry's epoch no longer matches; the second wake-up misses.
    expect(cache.get("key-1")).toBeUndefined()
  })

  it("expires entries after TTL — deterministic via injected `now`", () => {
    let nowMs = 1_000
    const cache = new WakeUpCache({ ttlMs: 30_000, now: () => nowMs })
    cache.set("key-1", makeData(), cache.currentEpoch)

    nowMs += 30_001
    expect(cache.get("key-1")).toBeUndefined()
  })

  it("returns the entry while inside the TTL window", () => {
    let nowMs = 1_000
    const cache = new WakeUpCache({ ttlMs: 30_000, now: () => nowMs })
    cache.set("key-1", makeData(), cache.currentEpoch)

    nowMs += 29_999
    expect(cache.get("key-1")).not.toBeUndefined()
  })

  it("refuses to commit when an epoch advanced between dispatch and commit", () => {
    const cache = new WakeUpCache()
    const startEpoch = cache.currentEpoch
    cache.bumpEpoch()

    // Commit attempted with the captured pre-bump epoch should be a no-op.
    expect(cache.set("key-1", makeData(), startEpoch)).toBe(false)
    expect(cache.get("key-1")).toBeUndefined()
  })

  it("evicts the oldest entry when at capacity", () => {
    const cache = new WakeUpCache({ max: 3 })
    cache.set("a", makeData(), cache.currentEpoch)
    cache.set("b", makeData(), cache.currentEpoch)
    cache.set("c", makeData(), cache.currentEpoch)
    cache.set("d", makeData(), cache.currentEpoch)

    expect(cache.size).toBe(3)
    expect(cache.get("a")).toBeUndefined()
    expect(cache.get("d")).not.toBeUndefined()
  })

  it("evicts at the constructor-supplied capacity (default exercised via the test fixture above)", () => {
    const cache = new WakeUpCache({ max: 1 })
    cache.set("a", makeData(), cache.currentEpoch)
    cache.set("b", makeData(), cache.currentEpoch)
    expect(cache.size).toBe(1)
    expect(cache.get("a")).toBeUndefined()
    expect(cache.get("b")).not.toBeUndefined()
  })

  it("collapses concurrent cold-start callers onto a single loader (stampede protection)", async () => {
    const cache = new WakeUpCache()
    let resolve!: (value: WakeUpData) => void
    let calls = 0
    const loader = () => {
      calls += 1
      return new Promise<WakeUpData>((r) => {
        resolve = r
      })
    }

    const startEpoch = cache.currentEpoch
    const a = cache.getOrLoad("key-1", startEpoch, loader)
    const b = cache.getOrLoad("key-1", startEpoch, loader)
    const c = cache.getOrLoad("key-1", startEpoch, loader)

    expect(calls).toBe(1)

    const data = makeData()
    resolve(data)
    const [ra, rb, rc] = await Promise.all([a, b, c])
    expect(ra).toBe(data)
    expect(rb).toBe(data)
    expect(rc).toBe(data)
    expect(calls).toBe(1)
  })

  it("commits the loader's result on success when the epoch is stable", async () => {
    const cache = new WakeUpCache()
    const data = makeData()
    const startEpoch = cache.currentEpoch
    await cache.getOrLoad("key-1", startEpoch, async () => data)

    expect(cache.get("key-1")).toBe(data)
  })

  it("does not commit when an intervening write bumped the epoch during fan-out", async () => {
    const cache = new WakeUpCache()
    let resolve!: (value: WakeUpData) => void
    const loader = () =>
      new Promise<WakeUpData>((r) => {
        resolve = r
      })

    const startEpoch = cache.currentEpoch
    const inFlight = cache.getOrLoad("key-1", startEpoch, loader)
    cache.bumpEpoch() // simulate a save landing during fan-out
    resolve(makeData())
    await inFlight

    expect(cache.get("key-1")).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it("after bumpEpoch clears pending, the next caller dispatches a fresh loader", async () => {
    const cache = new WakeUpCache()
    let aResolve!: (value: WakeUpData) => void
    let bCalls = 0

    const startEpochA = cache.currentEpoch
    const a = cache.getOrLoad("key-1", startEpochA, () =>
      new Promise<WakeUpData>((r) => {
        aResolve = r
      }),
    )

    cache.bumpEpoch() // a save lands while A is in flight

    const startEpochB = cache.currentEpoch
    const bData = makeData()
    const b = cache.getOrLoad("key-1", startEpochB, async () => {
      bCalls += 1
      return bData
    })

    aResolve(makeData()) // A finishes after B was already dispatched
    await Promise.all([a, b])

    expect(bCalls).toBe(1)
    expect(cache.get("key-1")).toBe(bData)
  })

  it("a rejected loader clears its pending slot so subsequent callers retry", async () => {
    const cache = new WakeUpCache()
    let calls = 0
    const startEpoch = cache.currentEpoch

    await expect(
      cache.getOrLoad("key-1", startEpoch, async () => {
        calls += 1
        throw new Error("transient")
      }),
    ).rejects.toThrow("transient")

    const data = makeData()
    const result = await cache.getOrLoad("key-1", startEpoch, async () => {
      calls += 1
      return data
    })
    expect(result).toBe(data)
    expect(calls).toBe(2)
  })
})

describe("computeWakeUpCacheKey", () => {
  it("produces the same key for the same options", () => {
    const opts: WakeUpOptions = { projectId: "proj-1", userQuery: "fix bug" }
    expect(computeWakeUpCacheKey(opts)).toBe(computeWakeUpCacheKey(opts))
  })

  it("produces a stable key regardless of option insertion order", () => {
    const a: WakeUpOptions = { projectId: "p", taskLimit: 5, userQuery: "x" }
    const b: WakeUpOptions = { userQuery: "x", taskLimit: 5, projectId: "p" }
    expect(computeWakeUpCacheKey(a)).toBe(computeWakeUpCacheKey(b))
  })

  it("produces distinct keys for distinct projectIds", () => {
    expect(computeWakeUpCacheKey({ projectId: "a" })).not.toBe(
      computeWakeUpCacheKey({ projectId: "b" }),
    )
  })

  it("produces distinct keys for distinct userQuery values", () => {
    expect(computeWakeUpCacheKey({ userQuery: "fix bug" })).not.toBe(
      computeWakeUpCacheKey({ userQuery: "fix tests" }),
    )
  })

  it("normalizes userQuery casing and whitespace before keying", () => {
    expect(computeWakeUpCacheKey({ userQuery: "Fix Bug" })).toBe(
      computeWakeUpCacheKey({ userQuery: "  fix bug  " }),
    )
  })

  it("treats empty / whitespace-only userQuery as no userQuery", () => {
    expect(computeWakeUpCacheKey({})).toBe(computeWakeUpCacheKey({ userQuery: "" }))
    expect(computeWakeUpCacheKey({})).toBe(
      computeWakeUpCacheKey({ userQuery: "   " }),
    )
  })

  it("ignores `now` so back-to-back invocations land on the same slot", () => {
    expect(computeWakeUpCacheKey({ projectId: "p", now: 1 })).toBe(
      computeWakeUpCacheKey({ projectId: "p", now: 999 }),
    )
  })

  it("includes todayDate so a midnight crossing forces a refetch", () => {
    expect(computeWakeUpCacheKey({ todayDate: "2026-05-03" })).not.toBe(
      computeWakeUpCacheKey({ todayDate: "2026-05-04" }),
    )
  })

  it("varies on every option that affects the fan-out output", () => {
    const base: WakeUpOptions = { projectId: "p" }
    const fields: Array<keyof WakeUpOptions> = [
      "memoryLimit",
      "memoryLimitWithDigest",
      "digestFreshnessDays",
      "knowledgeFactLimit",
      "relatedMemoryLimit",
      "taskLimit",
      "taskMemoryLimit",
      "proposedMemoryLimit",
      // Issue #286 — `inheritedMemoryLimit` changes the
      // `inheritedMemories` array on `WakeUpData`; without
      // including it the MCP path (default 3) and a hook path
      // (would-be 0) would collide on key.
      "inheritedMemoryLimit",
    ]
    const baseline = computeWakeUpCacheKey(base)
    for (const field of fields) {
      const variant = computeWakeUpCacheKey({ ...base, [field]: 99 })
      expect(variant).not.toBe(baseline)
    }
    for (const field of [
      "includeMemoryContent",
      "includeDecisions",
      "includeStaleConfidence",
      "includeProposedMemories",
      "includeCoverage",
      // Issue #286 — toggling `includeInheritedMemories` swings
      // the upstream fan-out on/off; without including it a
      // hook-style caller (opt-out) and an MCP-style caller
      // (default on) collide on key and silently cross-serve
      // each other's `inheritedMemories` array.
      "includeInheritedMemories",
    ] as const) {
      const variant = computeWakeUpCacheKey({ ...base, [field]: false })
      expect(variant).not.toBe(baseline)
    }
  })
})
