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
      Array.from({ length: 8 }, () => cache.getOrLoad("key", loader)),
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
      ]),
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

    const first = await cache.getOrLoad(
      "key",
      loader as () => Promise<number | null>,
    )
    expect(first).toBeUndefined()
    expect(cache.get("key")).toBeUndefined()

    const second = await cache.getOrLoad(
      "key",
      loader as () => Promise<number | null>,
    )
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
