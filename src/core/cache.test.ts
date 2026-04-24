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
})
