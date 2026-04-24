/**
 * Minimal LRU + TTL cache used by name→id resolvers inside the MCP server.
 *
 * The MCP server is a long-lived stdio process: a single conversation may
 * resolve the same project or topic name many times across
 * `lore-remember`, `lore-learn`, `lore-ask`, and `lore-wake-up`. Without a
 * cache each resolution is a Notion query; with one, the second and
 * subsequent lookups inside the TTL window are free.
 *
 * **Stampede-safe via `getOrLoad`.** Concurrent cold-start misses on the
 * same key collapse onto a single loader invocation: the first caller
 * installs a pending promise, every concurrent caller awaits it, and the
 * resolved value is cached for later synchronous `get()` reads. Call sites
 * that need stampede safety should use `getOrLoad` rather than the classic
 * `get() ?? fetch()` pattern.
 *
 * The cache is intentionally small and unit-testable. It is not a general
 * replacement for an external cache and must not be used where stale data
 * is a correctness hazard — see the note at `MemoryService.getById` for the
 * canonical counter-example.
 *
 * Insertion-order iteration of the underlying `Map` gives LRU semantics
 * for free: every `get` / `set` that touches a live entry re-inserts it at
 * the tail, so the first key in iteration order is always the least
 * recently used.
 */

interface Entry<V> {
  value: V
  expiresAt: number
}

export class LruCache<K, V> {
  private readonly store: Map<K, Entry<V>>
  /**
   * In-flight loader promises keyed by the cache key. Populated the moment a
   * `getOrLoad` miss dispatches its loader and cleared in a `.finally` so a
   * rejected loader does not poison the slot. Kept off the public surface —
   * callers never observe pending promises via `get()`.
   */
  private readonly pending: Map<K, Promise<V | null>>

  constructor(
    private readonly max: number,
    private readonly ttlMs: number
  ) {
    if (max <= 0) {
      throw new Error(`LruCache max must be > 0 (got ${max})`)
    }
    if (ttlMs <= 0) {
      throw new Error(`LruCache ttlMs must be > 0 (got ${ttlMs})`)
    }
    // Allocate after validation so a bad-args throw doesn't leave a
    // dead Map pinned against a half-constructed instance.
    this.store = new Map<K, Entry<V>>()
    this.pending = new Map<K, Promise<V | null>>()
  }

  /**
   * Look up `key`. Returns `undefined` if missing or expired; expired
   * entries are evicted as a side effect so a later `set` does not race a
   * stale read. Touches the entry's LRU position on a hit.
   */
  get(key: K): V | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key)
      return undefined
    }
    // Re-insert to move this key to the most-recently-used tail position.
    this.store.delete(key)
    this.store.set(key, entry)
    return entry.value
  }

  /**
   * Insert or replace `key`. If the cache is at capacity, the least
   * recently used entry is evicted — which is the first key in the
   * `Map`'s insertion order.
   */
  set(key: K, value: V): void {
    if (this.store.has(key)) {
      this.store.delete(key)
    } else if (this.store.size >= this.max) {
      const oldest = this.store.keys().next().value
      if (oldest !== undefined) this.store.delete(oldest)
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs })
  }

  /**
   * Look up `key`, or invoke `loader` and cache its resolved value on miss.
   *
   * Collapses concurrent cold-start misses on the same key: the first miss
   * installs a pending promise in `this.pending` and every subsequent
   * caller that arrives before the loader resolves awaits the same promise.
   * When the loader resolves to a non-null/undefined value it is committed
   * to the cache via `set()`; `null` propagates to waiters but is not
   * cached (matches existing `set` semantics — nothing is stored for
   * negatives, so a later caller retries).
   *
   * Loader rejections reject every waiting caller and clear the pending
   * slot, so the next call retries rather than caching the rejection. This
   * is the behaviour callers expect from the classic `get() ?? fetch()`
   * pattern; the stampede guard is the only thing different.
   */
  getOrLoad(key: K, loader: () => Promise<V | null>): Promise<V | null> {
    const hit = this.get(key)
    if (hit !== undefined) return Promise.resolve(hit)

    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight

    const promise = loader()
      .then((value) => {
        if (value !== null && value !== undefined) this.set(key, value)
        return value
      })
      .finally(() => {
        // Clear even on success so we never hand out a resolved-once promise
        // from a prior call; future reads go through `get()` at the top.
        this.pending.delete(key)
      })

    this.pending.set(key, promise)
    return promise
  }

  /** Remove a single entry. No-op if missing. */
  delete(key: K): void {
    this.store.delete(key)
  }

  /** Drop every entry. Used by tests and by `clearServiceCaches()`. */
  clear(): void {
    this.store.clear()
  }

  /** Current entry count — useful for tests that assert eviction. */
  get size(): number {
    return this.store.size
  }
}
