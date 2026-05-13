/**
 * Minimal LRU + TTL cache used by name→id resolvers inside the MCP server.
 *
 * The MCP server is a long-lived stdio process: a single conversation may
 * resolve the same project or topic name many times across
 * `lore-memory action='save'`, `lore-fact action='create'`,
 * `lore-query action='ask'`, and `lore-context action='wake-up'`. Without
 * a cache each resolution is a Notion query; with one, the second and
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

/**
 * Options for `LruCache`. The shape is conditional on `V`:
 *
 * - When `V` does NOT include `null`, only `cacheNegatives: false` (or
 *   omission) is permitted. Setting `cacheNegatives: true` on such a
 *   cache is a **type error** — it would let `getOrLoad` commit `null`
 *   into the store and `get()` would later return `null` to a caller
 *   whose declared type is `V | undefined`. The conditional type
 *   surfaces the constraint at construction so the consumer can either
 *   widen `V` to include `null` or drop the option.
 * - When `V` includes `null`, `cacheNegatives` is freely settable.
 *
 * Documented option:
 *
 * - `cacheNegatives` — when true, `getOrLoad` commits a `null` loader
 *   return as a known-absent tombstone, so subsequent reads
 *   short-circuit on the cached `null` instead of re-dispatching the
 *   loader. Default false (negatives are not cached; the next caller
 *   retries).
 *
 *   Use only when the caller can distinguish "known absent" (loader
 *   returns null) from "transient error" (loader throws). The
 *   distinction is load-bearing: a transient error must NOT install a
 *   tombstone, or every affected caller would see stale "absent"
 *   answers for the full TTL.
 *
 *   Direct `set(key, value)` writes are unaffected by this option —
 *   `V` is what governs whether `null` is a structurally legal cached
 *   value. The flag only changes `getOrLoad`'s commit behaviour on a
 *   `null` resolution.
 */
export type LruCacheOptions<V> = null extends V
  ? { cacheNegatives?: boolean }
  : { cacheNegatives?: false }

export class LruCache<K, V> {
  private readonly store: Map<K, Entry<V>>
  /**
   * In-flight loader promises keyed by the cache key. Populated the moment a
   * `getOrLoad` miss dispatches its loader and cleared in a `.finally` so a
   * rejected loader does not poison the slot. Kept off the public surface —
   * callers never observe pending promises via `get()`.
   */
  private readonly pending: Map<K, Promise<V | null>>
  private readonly cacheNegatives: boolean

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
    // The `{} as LruCacheOptions<V>` default is the price of the
    // conditional `LruCacheOptions<V>` shape: TS can't reduce the
    // conditional against an unbound `V` here, but `{}` (with no
    // `cacheNegatives` field) satisfies BOTH branches of the
    // conditional, so the cast is sound. A future contributor
    // tempted to widen `LruCacheOptions` to a plain non-conditional
    // type would silently re-open the unsoundness the cache.test.ts
    // `@ts-expect-error` test pins.
    options: LruCacheOptions<V> = {} as LruCacheOptions<V>
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
    this.cacheNegatives = options.cacheNegatives ?? false
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
    // Re-insert to move this key to the MRU tail position; eviction
    // pops from the head.
    this.store.delete(key)
    this.store.set(key, entry)
    return entry.value
  }

  /**
   * Insert or replace `key`. If the cache is at capacity, the least
   * recently used entry is evicted — which is the first key in the
   * `Map`'s insertion order.
   *
   * Also drops any in-flight `getOrLoad` pending slot for `key`. An
   * explicit `set` is the authoritative writer's value; a concurrent
   * loader that resolves later carries a pre-write view and must NOT
   * be allowed to commit back over the writer's value. The identity
   * guard inside `getOrLoad` catches the suppressed commit
   * (`this.pending.get(key) === promise` is now false). This is what
   * lets writer-side code use `delete + set` (or just `set`) as a
   * race-safe write-through pattern without epoch counters.
   */
  set(key: K, value: V): void {
    if (this.store.has(key)) {
      this.store.delete(key)
    } else if (this.store.size >= this.max) {
      const oldest = this.store.keys().next().value
      if (oldest !== undefined) this.store.delete(oldest)
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs })
    this.pending.delete(key)
  }

  /**
   * Look up `key`, or invoke `loader` and cache its resolved value on miss.
   *
   * Collapses concurrent cold-start misses on the same key: the first miss
   * installs a pending promise in `this.pending` and every subsequent
   * caller that arrives before the loader resolves awaits the same promise.
   * When the loader resolves to a non-null/undefined value it is committed
   * to the cache via `set()`. By default `null` propagates to waiters but
   * is not cached, so a later caller retries — that matches the
   * project / topic / decision name resolvers, where `null` means "not yet
   * created" and locking it in for the TTL would block subsequent
   * lookups after a sibling write.
   *
   * **`cacheNegatives: true`** flips the `null` policy: a `null` loader
   * return is committed as a known-absent tombstone, and subsequent
   * `getOrLoad` reads short-circuit on the tombstone instead of
   * re-dispatching the loader. Callers must distinguish "known absent"
   * (loader returns null) from "transient error" (loader throws) — the
   * second still rejects waiters and clears the slot without caching, so
   * a 429 / 5xx blip can't poison the key for the full TTL.
   *
   * Loader rejections reject every waiting caller and clear the pending
   * slot, so the next call retries rather than caching the rejection. This
   * is the behaviour callers expect from the classic `get() ?? fetch()`
   * pattern; the stampede guard is the only thing different.
   *
   * **Invalidation-safe.** An identity guard compares the resolving
   * loader's promise against the current `pending` slot before committing
   * or evicting. If `delete(key)`, `clear()`, or an authoritative
   * `set(key, …)` ran while the loader was in flight — or if a second
   * `getOrLoad` installed a replacement slot — the stale loader's commit
   * is skipped and its `.finally` only drops its own slot, never a
   * reinstalled one. This is what makes the
   * `delete(key); getOrLoad(key, …)` write-then-read invalidation
   * pattern used by `TopicService.getOrCreate` and `DecisionService.supersede`
   * safe under concurrent readers, and what closes the
   * dispatched-during-write race for the title cache (a writer's
   * `delete(id) → pages.update → set(id, "newest")` sequence drops the
   * pending slot at both ends, so a reader's stale retrieve resolved in
   * between cannot clobber the post-write value).
   */
  getOrLoad(key: K, loader: () => Promise<V | null>): Promise<V | null> {
    const hit = this.get(key)
    // `get()` returns `undefined` for missing/expired entries; a cached
    // null tombstone (only possible when V includes null AND
    // cacheNegatives is set) returns `null`, which short-circuits here
    // exactly like a value hit.
    if (hit !== undefined) return Promise.resolve(hit)

    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight

    const promise: Promise<V | null> = loader()
      .then((value) => {
        // Identity guard: only commit if this loader is still the
        // authoritative pending slot. An intervening `delete`/`clear`
        // invalidates this loader's view of the key, and a concurrent
        // `getOrLoad` may have installed a fresher loader; either way we
        // must not overwrite the cache with our stale read.
        if (this.pending.get(key) === promise) {
          if (value === undefined) {
            // `loader()`'s contract is `Promise<V | null>`, but guard
            // anyway — a stray `undefined` is structurally a miss, not
            // a tombstone, regardless of the cacheNegatives flag.
          } else if (value === null) {
            // The `value as V` cast is sound by construction:
            // `cacheNegatives: true` is type-permitted only when
            // `null extends V` on the `LruCacheOptions<V>` shape. A
            // `cacheNegatives` cache therefore has `V` widened to
            // include `null`, and committing the runtime `null` is
            // structurally legal — no possibility of `get()` later
            // returning `null` to a caller whose declared type
            // excludes it.
            if (this.cacheNegatives) this.set(key, value as V)
          } else {
            this.set(key, value)
          }
        }
        return value
      })
      .finally(() => {
        // Only drop our own slot. If an invalidator replaced it with a
        // newer pending promise between dispatch and resolution, leaving
        // the new slot in place is exactly what the new caller expects.
        if (this.pending.get(key) === promise) {
          this.pending.delete(key)
        }
      })

    this.pending.set(key, promise)
    return promise
  }

  /**
   * Remove a single entry. No-op if missing.
   *
   * Drops both the stored value AND any in-flight `getOrLoad` pending slot
   * for this key so a concurrent invalidator (`TopicService.getOrCreate`,
   * `DecisionService.supersede`) cannot observe a stale pre-write view
   * via an already-dispatched loader. Any loader still racing on the old
   * slot has its commit suppressed by the identity guard in `getOrLoad`.
   */
  delete(key: K): void {
    this.store.delete(key)
    this.pending.delete(key)
  }

  /**
   * Drop every entry. Used by tests and by `clearServiceCaches()`.
   *
   * Clears `pending` as well as `store` for the same reason as `delete`:
   * after `clear()`, no stale in-flight loader may commit back to the
   * cache. Loaders still resolving after the clear are neutralised by
   * the identity guard.
   */
  clear(): void {
    this.store.clear()
    this.pending.clear()
  }

  /** Current entry count — useful for tests that assert eviction. */
  get size(): number {
    return this.store.size
  }
}
