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
    pinnedBlocks: [],
    pinnedBlocksTotal: null,
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
    const a = cache.getOrLoad(
      "key-1",
      startEpochA,
      () =>
        new Promise<WakeUpData>((r) => {
          aResolve = r
        })
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
      })
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
      computeWakeUpCacheKey({ projectId: "b" })
    )
  })

  it("produces distinct keys for distinct userQuery values", () => {
    expect(computeWakeUpCacheKey({ userQuery: "fix bug" })).not.toBe(
      computeWakeUpCacheKey({ userQuery: "fix tests" })
    )
  })

  it("normalizes userQuery casing and whitespace before keying", () => {
    expect(computeWakeUpCacheKey({ userQuery: "Fix Bug" })).toBe(
      computeWakeUpCacheKey({ userQuery: " fix bug " })
    )
  })

  it("treats empty / whitespace-only userQuery as no userQuery", () => {
    expect(computeWakeUpCacheKey({})).toBe(computeWakeUpCacheKey({ userQuery: "" }))
    expect(computeWakeUpCacheKey({})).toBe(computeWakeUpCacheKey({ userQuery: " " }))
  })

  it("ignores `now` so back-to-back invocations land on the same slot", () => {
    expect(computeWakeUpCacheKey({ projectId: "p", now: 1 })).toBe(
      computeWakeUpCacheKey({ projectId: "p", now: 999 })
    )
  })

  it("includes todayDate so a midnight crossing forces a refetch", () => {
    expect(computeWakeUpCacheKey({ todayDate: "2026-05-03" })).not.toBe(
      computeWakeUpCacheKey({ todayDate: "2026-05-04" })
    )
  })

  it("varies on task-only mode while treating explicit full as the default", () => {
    const base = { projectId: "p", userQuery: "fix bug" } satisfies WakeUpOptions
    expect(computeWakeUpCacheKey({ ...base, mode: "full" })).toBe(
      computeWakeUpCacheKey(base)
    )
    expect(computeWakeUpCacheKey({ ...base, mode: "task-only" })).not.toBe(
      computeWakeUpCacheKey(base)
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
      // `pinnedBlockLimit` changes both
      // the `pinnedBlocks` slice AND the rendered abuse-warning
      // header count. Without including it a wake-up with
      // `pinnedBlockLimit: 0` (opt-out) and the MCP default
      // would collide and cross-serve incompatible slices.
      "pinnedBlockLimit",
    ]
    const baseline = computeWakeUpCacheKey(base)
    for (const field of fields) {
      const variant = computeWakeUpCacheKey({ ...base, [field]: 99 })
      expect(variant).not.toBe(baseline)
    }
    for (const field of [
      "includeMemoryContent",
      "includeDecisions",
      "includeProposedMemories",
      "includeCoverage",
      // Issue #286 — toggling `includeInheritedMemories` swings
      // the upstream fan-out on/off; without including it a
      // hook-style caller (opt-out) and an MCP-style caller
      // (default on) collide on key and silently cross-serve
      // each other's `inheritedMemories` array.
      "includeInheritedMemories",
      // toggling `includePinnedBlocks`
      // swings the pinned fan-out on/off AND the abuse-warning
      // gate. Without including it a hook-style caller (opt-out)
      // and an MCP-style caller (default on) collide on key and
      // silently cross-serve each other's pinned slice — the
      // MCP caller would lose its `## Pinned Context` section
      // and abuse warning until cache invalidation. Pinned
      // context renders BEFORE the relevance-ranked sections so
      // the collision is a correctness/safety issue rather than
      // just stale metadata.
      "includePinnedBlocks",
    ] as const) {
      const variant = computeWakeUpCacheKey({ ...base, [field]: false })
      expect(variant).not.toBe(baseline)
    }
    expect(computeWakeUpCacheKey({ ...base, includeExpiredMemories: true })).not.toBe(
      baseline
    )
    expect(computeWakeUpCacheKey({ ...base, includeExpiredMemories: false })).toBe(
      baseline
    )
  })

  it("varies on pinnedReaderContext so different audiences don't cross-serve filtered slices (issue #282)", () => {
    // The reader context governs which audience-filtered pins
    // surface for a given session. Two readers with different
    // identities must never share a cached pinned slice.
    const codeReviewer = computeWakeUpCacheKey({
      projectId: "p",
      pinnedReaderContext: { role: "code-reviewers" },
    })
    const releaseAgent = computeWakeUpCacheKey({
      projectId: "p",
      pinnedReaderContext: { role: "release-agents" },
    })
    const noContext = computeWakeUpCacheKey({ projectId: "p" })
    expect(codeReviewer).not.toBe(releaseAgent)
    expect(codeReviewer).not.toBe(noContext)
    expect(releaseAgent).not.toBe(noContext)
  })

  it("treats equivalent pinnedReaderContext shapes as the same key (case-insensitive identity slots)", () => {
    // Audience matching is case-folded; the cache key must
    // match that normalization so two callers with the same
    // identity in different casing share a slot.
    const lower = computeWakeUpCacheKey({
      projectId: "p",
      pinnedReaderContext: { agent: "claude code" },
    })
    const upper = computeWakeUpCacheKey({
      projectId: "p",
      pinnedReaderContext: { agent: "Claude Code" },
    })
    expect(lower).toBe(upper)
  })

  it("ignores empty / whitespace-only identity slots so they don't pollute the cache key", () => {
    // An identity slot exported as empty / whitespace doesn't
    // affect the audience match (`pinnedBlockAudienceMatches`
    // trims and filters empty slots). The cache key must mirror
    // that so two callers — one with an empty `agent`, one with
    // no `agent` field at all — share a slot.
    const empty = computeWakeUpCacheKey({
      projectId: "p",
      pinnedReaderContext: { agent: "" },
    })
    const whitespace = computeWakeUpCacheKey({
      projectId: "p",
      pinnedReaderContext: { agent: " " },
    })
    const absent = computeWakeUpCacheKey({ projectId: "p" })
    expect(empty).toBe(absent)
    expect(whitespace).toBe(absent)
  })

  it("ignores MemoryScopeContext fields that don't affect the pinned audience filter", () => {
    // `pinnedBlockAudienceMatches` consults only agent / role /
    // userId. Fields like `session` / `run` / `environment` are
    // part of the broader `MemoryScopeContext` (issue #283 scope
    // filter) but don't participate in pinned audience matching,
    // so they must NOT inflate the pinned-slice cache key.
    const noisy = computeWakeUpCacheKey({
      projectId: "p",
      pinnedReaderContext: {
        agent: "code-reviewers",
        session: "abc",
        run: "xyz",
        environment: "dev",
      },
    })
    const clean = computeWakeUpCacheKey({
      projectId: "p",
      pinnedReaderContext: { agent: "code-reviewers" },
    })
    expect(noisy).toBe(clean)
  })
})
