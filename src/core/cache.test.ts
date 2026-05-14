import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LruCache } from "./cache.js"

describe("LruCache — construction", () => {
  it("throws when max is non-positive", () => {
    expect(() => new LruCache<string, number>(0, 1000)).toThrow(/max/)
    expect(() => new LruCache<string, number>(-1, 1000)).toThrow(/max/)
  })

  it("throws when ttlMs is non-positive", () => {
    expect(() => new LruCache<string, number>(10, 0)).toThrow(/ttlMs/)
    expect(() => new LruCache<string, number>(10, -50)).toThrow(/ttlMs/)
  })
})

describe("LruCache — basic get/set", () => {
  it("returns undefined for missing keys", () => {
    const cache = new LruCache<string, number>(10, 1000)
    expect(cache.get("missing")).toBeUndefined()
  })

  it("returns the stored value for present keys", () => {
    const cache = new LruCache<string, number>(10, 1000)
    cache.set("a", 1)
    expect(cache.get("a")).toBe(1)
  })

  it("overwrites existing entries on set", () => {
    const cache = new LruCache<string, number>(10, 1000)
    cache.set("a", 1)
    cache.set("a", 2)
    expect(cache.get("a")).toBe(2)
    expect(cache.size).toBe(1)
  })

  it("delete removes a single entry and is a no-op when absent", () => {
    const cache = new LruCache<string, number>(10, 1000)
    cache.set("a", 1)
    cache.delete("a")
    expect(cache.get("a")).toBeUndefined()
    cache.delete("a") // no throw on missing
  })

  it("clear drops every entry", () => {
    const cache = new LruCache<string, number>(10, 1000)
    cache.set("a", 1)
    cache.set("b", 2)
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.get("a")).toBeUndefined()
  })
})

describe("LruCache — eviction order", () => {
  it("evicts the least recently inserted when at capacity", () => {
    const cache = new LruCache<string, number>(2, 1000)
    cache.set("a", 1)
    cache.set("b", 2)
    cache.set("c", 3) // evicts "a"

    expect(cache.get("a")).toBeUndefined()
    expect(cache.get("b")).toBe(2)
    expect(cache.get("c")).toBe(3)
    expect(cache.size).toBe(2)
  })

  it("get() refreshes recency so the other key becomes the eviction target", () => {
    const cache = new LruCache<string, number>(2, 1000)
    cache.set("a", 1)
    cache.set("b", 2)
    // Touch "a" so "b" becomes the oldest.
    expect(cache.get("a")).toBe(1)
    cache.set("c", 3) // should evict "b", not "a"

    expect(cache.get("a")).toBe(1)
    expect(cache.get("b")).toBeUndefined()
    expect(cache.get("c")).toBe(3)
  })

  it("set() on an existing key refreshes recency", () => {
    const cache = new LruCache<string, number>(2, 1000)
    cache.set("a", 1)
    cache.set("b", 2)
    // Re-set "a" — it should move to the MRU position.
    cache.set("a", 10)
    cache.set("c", 3) // should evict "b", not "a"

    expect(cache.get("a")).toBe(10)
    expect(cache.get("b")).toBeUndefined()
    expect(cache.get("c")).toBe(3)
  })
})

describe("LruCache — getOrLoad stampede dedup", () => {
  it("collapses N concurrent cold-start misses onto one loader call", async () => {
    const cache = new LruCache<string, number>(10, 1000)
    let calls = 0
    const loader = vi.fn(async () => {
      calls++
      await new Promise((r) => setTimeout(r, 5))
      return 42
    })

    const results = await Promise.all(
      Array.from({ length: 8 }, () => cache.getOrLoad("key", loader))
    )

    expect(calls).toBe(1)
    expect(results).toEqual(Array(8).fill(42))
    expect(cache.get("key")).toBe(42)
  })

  it("returns the cached value on hot-path reads without invoking the loader", async () => {
    const cache = new LruCache<string, number>(10, 1000)
    cache.set("key", 7)
    const loader = vi.fn(async () => 99)

    const value = await cache.getOrLoad("key", loader)

    expect(value).toBe(7)
    expect(loader).not.toHaveBeenCalled()
  })

  it("propagates loader rejections and clears the pending slot so the next caller retries", async () => {
    const cache = new LruCache<string, number>(10, 1000)
    const boom = new Error("network down")
    const loader = vi
      .fn<() => Promise<number | null>>()
      .mockImplementationOnce(async () => {
        throw boom
      })
      .mockImplementationOnce(async () => 5)

    await expect(cache.getOrLoad("key", loader)).rejects.toBe(boom)
    expect(cache.get("key")).toBeUndefined()

    // Second attempt runs the loader again — no poisoned pending slot.
    const second = await cache.getOrLoad("key", loader)
    expect(second).toBe(5)
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it("rejects every concurrent waiter on the same shared pending promise", async () => {
    // Load-bearing: the `.finally` placement is only correct if every
    // caller awaiting the shared in-flight promise receives the rejection.
    // A broken cleanup (e.g. placing `.delete` before `.then/catch`) would
    // leave some waiters hanging or resolve them with `undefined`.
    const cache = new LruCache<string, number>(10, 1000)
    const boom = new Error("network down")
    const loader = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5))
      throw boom
    })

    await expect(
      Promise.all([
        cache.getOrLoad("key", loader),
        cache.getOrLoad("key", loader),
        cache.getOrLoad("key", loader),
      ])
    ).rejects.toBe(boom)

    expect(loader).toHaveBeenCalledTimes(1)
    // Pending slot cleared even though all three callers shared it.
    expect(cache.get("key")).toBeUndefined()
  })

  it("does not cache null results but still propagates them to waiters", async () => {
    const cache = new LruCache<string, number>(10, 1000)
    const loader = vi
      .fn<() => Promise<number | null>>()
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => 3)

    const [first, second] = await Promise.all([
      cache.getOrLoad("key", loader),
      cache.getOrLoad("key", loader),
    ])
    // Both concurrent waiters see the same null — single loader invocation.
    expect(first).toBeNull()
    expect(second).toBeNull()
    expect(loader).toHaveBeenCalledTimes(1)
    // Null was not committed to the store, so a later call runs the loader.
    expect(cache.get("key")).toBeUndefined()
    const reloaded = await cache.getOrLoad("key", loader)
    expect(reloaded).toBe(3)
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it("does not cache undefined results either (guards against refactor drift)", async () => {
    // The commit guard is `value !== null && value !== undefined`. If a
    // future refactor drops the undefined branch, this test catches it:
    // `loader()` returning undefined should propagate but not cache.
    const cache = new LruCache<string, number>(10, 1000)
    const loader = vi
      .fn<() => Promise<number | null | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(7)

    const first = await cache.getOrLoad("key", loader as () => Promise<number | null>)
    expect(first).toBeUndefined()
    expect(cache.get("key")).toBeUndefined()

    const second = await cache.getOrLoad("key", loader as () => Promise<number | null>)
    expect(second).toBe(7)
    expect(loader).toHaveBeenCalledTimes(2)
  })
})

describe("LruCache — TTL expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns the value while within TTL", () => {
    const cache = new LruCache<string, number>(10, 1000)
    cache.set("a", 1)
    vi.advanceTimersByTime(999)
    expect(cache.get("a")).toBe(1)
  })

  it("returns undefined and evicts after TTL elapses", () => {
    const cache = new LruCache<string, number>(10, 1000)
    cache.set("a", 1)
    vi.advanceTimersByTime(1001)
    expect(cache.get("a")).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it("set() resets the expiry window", () => {
    const cache = new LruCache<string, number>(10, 1000)
    cache.set("a", 1)
    vi.advanceTimersByTime(900)
    cache.set("a", 2) // extends expiry from now
    vi.advanceTimersByTime(900)
    expect(cache.get("a")).toBe(2)
  })

  it("getOrLoad re-invokes the loader on an expired entry", async () => {
    // Pins the TTL → getOrLoad interaction: `getOrLoad` delegates to
    // `this.get()` which evicts expired entries, so an expired key should
    // trigger the loader path. If a future change caches pending promises
    // instead of values and forgets TTL, this catches it.
    const cache = new LruCache<string, number>(10, 1000)
    const loader = vi
      .fn<() => Promise<number | null>>()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)

    const first = await cache.getOrLoad("a", loader)
    expect(first).toBe(1)
    expect(loader).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1001)

    const second = await cache.getOrLoad("a", loader)
    expect(second).toBe(2)
    expect(loader).toHaveBeenCalledTimes(2)
  })
})

describe("LruCache — delete/clear drop pending", () => {
  // Load-bearing: the write-side invalidation pattern used by
  // `TopicService.getOrCreate` and `DecisionService.supersede` is
  // `delete(key); await getOrLoad(key, …)`. If `delete` only evicted
  // `store`, a concurrent reader's in-flight loader would still be
  // installed in `pending`; the invalidator would await that stale
  // loader and use its pre-write view as a merge base — a lost update.
  // These tests pin the primitive-level contract that resolves it.

  it("delete(key) cancels authority of an in-flight loader so the next getOrLoad runs fresh", async () => {
    const cache = new LruCache<string, number>(10, 1000)
    let stalePending: ((value: number | null) => void) | undefined
    const staleLoader = vi.fn(
      () =>
        new Promise<number | null>((resolve) => {
          stalePending = resolve
        })
    )
    const freshLoader = vi.fn<() => Promise<number | null>>().mockResolvedValue(2)

    // Install a slow in-flight loader for key "a".
    const stalePromise = cache.getOrLoad("a", staleLoader)
    expect(staleLoader).toHaveBeenCalledTimes(1)

    // A writer invalidates. `delete` must drop both the (nonexistent)
    // store entry and the pending loader slot.
    cache.delete("a")

    // Next reader should see an empty pending slot and dispatch a fresh
    // loader — not re-use the stale in-flight one.
    const fresh = await cache.getOrLoad("a", freshLoader)
    expect(fresh).toBe(2)
    expect(freshLoader).toHaveBeenCalledTimes(1)

    // Release the stale loader with a stale value. It must NOT commit
    // back to the cache — the identity guard in getOrLoad suppresses it.
    stalePending?.(999)
    await stalePromise
    expect(cache.get("a")).toBe(2) // fresh value preserved, not overwritten
  })

  it("clear() cancels every in-flight loader the same way", async () => {
    const cache = new LruCache<string, number>(10, 1000)
    let releaseA: ((value: number | null) => void) | undefined
    let releaseB: ((value: number | null) => void) | undefined
    const loaderA = vi.fn(
      () =>
        new Promise<number | null>((resolve) => {
          releaseA = resolve
        })
    )
    const loaderB = vi.fn(
      () =>
        new Promise<number | null>((resolve) => {
          releaseB = resolve
        })
    )

    const pA = cache.getOrLoad("a", loaderA)
    const pB = cache.getOrLoad("b", loaderB)

    cache.clear()

    const freshA = vi.fn<() => Promise<number | null>>().mockResolvedValue(10)
    const freshB = vi.fn<() => Promise<number | null>>().mockResolvedValue(20)

    // Both keys should dispatch fresh loaders post-clear — the stale
    // loaders' pending slots are gone.
    const [a, b] = await Promise.all([
      cache.getOrLoad("a", freshA),
      cache.getOrLoad("b", freshB),
    ])
    expect(a).toBe(10)
    expect(b).toBe(20)
    expect(freshA).toHaveBeenCalledTimes(1)
    expect(freshB).toHaveBeenCalledTimes(1)

    // Stale values arriving after clear must not poison the cache.
    releaseA?.(111)
    releaseB?.(222)
    await Promise.all([pA, pB])
    expect(cache.get("a")).toBe(10)
    expect(cache.get("b")).toBe(20)
  })

  it("set() during an in-flight stale loader is not overwritten on stale resolution", async () => {
    // Covers the `delete(); set()` shape used by TopicService.getOrCreate's
    // post-extend write-through. A stale in-flight loader must not clobber
    // the authoritative write.
    const cache = new LruCache<string, number>(10, 1000)
    let releaseStale: ((value: number | null) => void) | undefined
    const staleLoader = vi.fn(
      () =>
        new Promise<number | null>((resolve) => {
          releaseStale = resolve
        })
    )

    const stalePromise = cache.getOrLoad("k", staleLoader)
    cache.delete("k")
    cache.set("k", 42) // authoritative post-invalidation write

    releaseStale?.(7) // stale loader resolves to pre-invalidation value
    await stalePromise

    expect(cache.get("k")).toBe(42)
  })

  it("waiters on a stale in-flight loader still receive its resolved value", async () => {
    // The identity guard suppresses commit-to-cache, not resolution to
    // awaiting callers. A caller that installed the loader (or awaited
    // it before invalidation) must still receive the loader's result —
    // they asked for it, they get it. Only the cache stays clean.
    const cache = new LruCache<string, number>(10, 1000)
    let release: ((value: number | null) => void) | undefined
    const loader = vi.fn(
      () =>
        new Promise<number | null>((resolve) => {
          release = resolve
        })
    )

    const staleRead = cache.getOrLoad("k", loader)
    cache.delete("k")
    release?.(9)

    await expect(staleRead).resolves.toBe(9)
    expect(cache.get("k")).toBeUndefined() // but not cached
  })
})

describe("LruCache — cacheNegatives option (PF1-09)", () => {
  // The shared primitive's PF1-05-spec hook for "known-absent" loader
  // returns. When `cacheNegatives: true`, a loader resolving to `null`
  // commits a tombstone — subsequent reads short-circuit instead of
  // re-dispatching the loader. Errors still reject without caching, so
  // a transient 429 / 5xx is distinguishable from a known-absent.

  it("commits a null tombstone under cacheNegatives so the next read short-circuits", async () => {
    // V is `number | null` (not `number`) so `null extends V` and
    // `cacheNegatives: true` is type-permitted — see
    // `LruCacheOptions<V>`. Using `number` alone would (correctly)
    // be a type error, pinned by the structural test below.
    const cache = new LruCache<string, number | null>(10, 1000, {
      cacheNegatives: true,
    })
    const loader = vi
      .fn<() => Promise<number | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(7)

    const first = await cache.getOrLoad("missing", loader)
    expect(first).toBeNull()
    expect(loader).toHaveBeenCalledTimes(1)

    // Next read hits the tombstone — no second loader invocation.
    const second = await cache.getOrLoad("missing", loader)
    expect(second).toBeNull()
    expect(loader).toHaveBeenCalledTimes(1)

    // `get()` reflects the cached null (distinguished from "missing"
    // by `null !== undefined`). The signature `V | undefined` here is
    // `(number | null) | undefined`, so a caller who narrows away
    // `undefined` is honestly told `null` is still possible.
    expect(cache.get("missing")).toBeNull()
  })

  it("type-error: cacheNegatives:true on a non-null V is rejected at construction", () => {
    // Structural pin for the option-type constraint: a cache whose
    // `V` excludes `null` cannot opt into `cacheNegatives: true`,
    // because `getOrLoad` would otherwise commit `null` into the
    // store and `get(): V | undefined` would later surface `null` to
    // a caller whose declared type doesn't include it (the unsound
    // shape the principal review flagged on the original PR).
    //
    // The expectation here is a TypeScript error, not a runtime
    // exception. We use a `// @ts-expect-error` directive to assert
    // the diagnostic — `tsc --noEmit` (run via `npm run typecheck`)
    // fails this test indirectly if the error stops being emitted.
    // Inline the construction so the directive scopes tightly.
    // @ts-expect-error cacheNegatives:true requires `null extends V`
    new LruCache<string, number>(10, 1000, { cacheNegatives: true })
    // Sanity: omitting the option still typechecks for the same V.
    new LruCache<string, number>(10, 1000)
    new LruCache<string, number>(10, 1000, { cacheNegatives: false })
  })

  it("transient errors do NOT install a tombstone — next caller retries", async () => {
    // Load-bearing for the title-cache hot path: a 429 / 5xx blip
    // must not pin a 60-second `(?)` window for that id. The loader
    // throwing rejects waiters and clears the pending slot without
    // caching anything; cacheNegatives only governs `null` returns.
    const cache = new LruCache<string, number | null>(10, 1000, {
      cacheNegatives: true,
    })
    const loader = vi
      .fn<() => Promise<number | null>>()
      .mockImplementationOnce(async () => {
        throw new Error("transient 429")
      })
      .mockImplementationOnce(async () => 5)

    await expect(cache.getOrLoad("k", loader)).rejects.toThrow("transient 429")
    expect(cache.get("k")).toBeUndefined()

    const recovered = await cache.getOrLoad("k", loader)
    expect(recovered).toBe(5)
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it("default (cacheNegatives unset) preserves pre-PF1-09 null behaviour — null propagates but not cached", async () => {
    // Pin the default contract: project / topic / decision name
    // resolvers rely on null meaning "not yet created, retry next
    // call." Flipping the default would silently lock in a missing
    // row's absence for the TTL.
    const cache = new LruCache<string, number>(10, 1000)
    const loader = vi
      .fn<() => Promise<number | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(11)

    expect(await cache.getOrLoad("k", loader)).toBeNull()
    expect(cache.get("k")).toBeUndefined()
    expect(await cache.getOrLoad("k", loader)).toBe(11)
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it("explicit set(key, null) under cacheNegatives stores a null tombstone", async () => {
    // The MemoryService writer side calls `titleCache.set(id, null)`
    // on archive — this must persist as a known-absent tombstone, not
    // be silently dropped.
    const cache = new LruCache<string, string | null>(10, 1000, {
      cacheNegatives: true,
    })
    cache.set("archived-id", null)
    expect(cache.get("archived-id")).toBeNull()

    // And subsequent getOrLoad short-circuits on it, even with a
    // loader that would return a different value.
    const loader = vi.fn<() => Promise<string | null>>().mockResolvedValue("never run")
    expect(await cache.getOrLoad("archived-id", loader)).toBeNull()
    expect(loader).not.toHaveBeenCalled()
  })
})

describe("LruCache.set drops in-flight pending slot (PF1-09)", () => {
  // Folding writeEpoch's race-guard duties into LruCache: an
  // authoritative `set(key, value)` mid-flight of a stale loader
  // must suppress the loader's commit. This is what lets writers
  // use `delete → write → set` without per-service epoch counters.

  it("suppresses a stale in-flight loader's commit when set() runs before the loader resolves", async () => {
    const cache = new LruCache<string, number>(10, 1000)
    let releaseStale: ((value: number | null) => void) | undefined
    const staleLoader = vi.fn(
      () =>
        new Promise<number | null>((resolve) => {
          releaseStale = resolve
        })
    )

    // 1. Reader installs a pending loader.
    const stalePromise = cache.getOrLoad("k", staleLoader)
    expect(staleLoader).toHaveBeenCalledTimes(1)

    // 2. Writer calls `set` — authoritative post-write value lands and
    //    `set` clears the pending slot in one call (no separate
    //    `delete` needed). Models the writer's `pages.update → set`
    //    sequence in MemoryService.update.
    cache.set("k", 99)

    // 3. Stale loader resolves to a pre-write value. Identity guard
    //    fails (pending was cleared by `set`), so the commit is
    //    suppressed and the writer's value survives.
    releaseStale?.(7)
    await stalePromise
    expect(cache.get("k")).toBe(99)
  })

  it("waiter on the stale loader still receives the loader's value (one-shot stale read)", async () => {
    // Suppressing the commit must not cancel the loader's promise to
    // its waiters. Reads asked for the loader's value; they get it.
    // Only the cache stays clean.
    const cache = new LruCache<string, number>(10, 1000)
    let releaseStale: ((value: number | null) => void) | undefined
    const staleLoader = vi.fn(
      () =>
        new Promise<number | null>((resolve) => {
          releaseStale = resolve
        })
    )

    const staleRead = cache.getOrLoad("k", staleLoader)
    cache.set("k", 42)
    releaseStale?.(7)

    await expect(staleRead).resolves.toBe(7)
    // Cache holds the writer's value.
    expect(cache.get("k")).toBe(42)
  })
})
