/**
 * Minimal LRU + TTL cache used by name→id resolvers inside the MCP server.
 *
 * The MCP server is a long-lived stdio process: a single conversation may
 * resolve the same project or topic name many times across
 * `lore-remember`, `lore-learn`, `lore-ask`, and `lore-wake-up`. Without a
 * cache each resolution is a Notion query; with one, the second and
 * subsequent lookups inside the TTL window are free.
 *
 * **No stampede dedup.** Concurrent cold-start misses on the same key
 * each issue their own Notion call — the cache only dedups the second
 * serialized read. Production call patterns are mostly sequential
 * (single conversation, one tool at a time), so this is acceptable
 * today. If fan-out callers like `resolveReferencedTitles` start
 * issuing N `Promise.all` reads per key, wrap with a pending-promise
 * map.
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
