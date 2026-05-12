/**
 * Process-local cache for `loadWakeUpData` results (issue #495).
 *
 * Wake-up runs ~10 parallel Notion calls per invocation. The MCP tool
 * is invoked more than once per session — at SessionStart, on
 * UserPromptSubmit, and ad-hoc when the agent refreshes context — and
 * the resolvers underneath the aggregator cache, but the aggregator
 * itself does not. Within one user turn, three wake-ups burn ~30
 * Notion calls of bucket budget on a snapshot whose constituent
 * sections (recent memories, latest digest age, active task list) do
 * not change meaningfully on a sub-30-second time scale.
 *
 * **Surface where the cache helps.** This is process-local state, so
 * the only surface that can land repeated cache hits is the
 * long-running MCP server. Hooks (`src/hooks/helpers.ts`) spawn one
 * process per Stop / per UserPromptSubmit and exit — every hook
 * invocation starts with an empty cache. The hook wake-up call still
 * threads `services.wakeupCache` through `loadWakeUpData` for type
 * uniformity, but no cache hit ever lands on that path. Cross-process
 * sharing (filesystem-backed snapshot keyed on `(configRoot,
 * projectId, todayDate, optionsHash)`, same posture as the drift /
 * digest markers) is a follow-up — out of scope for this issue.
 *
 * **Write-epoch invalidation.** A monotonic counter (`writeEpoch`) is
 * bumped by every MCP tool action that mutates a `lore-*` write
 * surface — `lore-memory action='save' | 'update' | 'archive' |
 * 'compare' | 'approve' | 'reject'`, `lore-fact action='create' |
 * 'invalidate' | 'extend'`, `lore-task action='create' | 'update' |
 * 'close'`, `lore-decision action='create' | 'supersede' | 'review'`.
 * `loadWakeUpData` captures the epoch at dispatch and only commits
 * its result to the cache if `writeEpoch === startEpoch` after
 * fan-out — a capture-then-check sandwich at the cache layer (not to
 * be confused with the pre-PF1-09 title-cache sandwich on
 * `MemoryService`, which is gone — the title cache now relies on
 * `LruCache.set` / `delete` clearing pending slots and `getOrLoad`'s
 * identity guard). A read checks the stored epoch matches the current
 * one; a mismatch is a miss, no different from a TTL expiry.
 *
 * **Bump conservatively, even on tool-error responses.** The MCP
 * dispatcher's `withWakeUpCacheBump` wrapper bumps the epoch for
 * every parsed write action regardless of the handler's
 * `isError` outcome, because several write handlers can land
 * durable Notion writes and then return `toolError(...)` for a
 * trailing partial-failure (e.g. `DecisionCreateFactPartialFailureError`
 * surfacing from `decided_by` emission after the decision row already
 * persisted). A non-bump on those paths would let the cache serve a
 * pre-write snapshot for the full TTL. Unnecessary invalidation on a
 * pre-write validation failure costs one fan-out next time wake-up
 * fires; serving stale state after a partial write is silently
 * incorrect. Conservative wins. Handlers that genuinely did NOT
 * touch Notion (the assertive-reuse branch in `lore-task
 * action='create'`, the already-judged branch in `lore-memory
 * action='compare'`) opt out of the bump by tagging the result with
 * `noopWrite: true`.
 *
 * **Touch-on-read does not bump.** `MemoryService.touchOnRead` and
 * `FactService.touchOnRead` are side-effecting reads — they bump
 * `Confidence Score` + `Last Referenced At` on visible citations.
 * They do NOT route through `withWakeUpCacheBump` because invalidating
 * the wake-up cache on every render would defeat the whole cache.
 * The trade-off: a cached wake-up may render a `Confidence Score`
 * trust label (0.8.0/#09) that is up to 30 seconds stale relative to
 * Notion. Within the TTL window this is acceptable — the cache is
 * triage signal, not the authoritative source for trust labels. The
 * hot once-per-day-gate failure (touch re-firing on every cache hit
 * within TTL) is closed separately by `MemoryService.touchOnRead`
 * AND `FactService.touchOnRead` mutating their input rows in place
 * after a successful write, so the cached `Memory.lastReferencedAt`
 * and `Fact.lastReferencedAt` reflect the post-touch state on the
 * next render.
 *
 * **Epoch invalidation is global, not per-key.** A write against
 * project A invalidates a project-B cache hit too. With
 * `WAKEUP_CACHE_MAX_ENTRIES = 32` and a realistic working set of one
 * project per process, this is never observable. Per-key
 * invalidation would require enumerating which sections of which
 * cached snapshots were touched by a given write — significant
 * complexity for no win on the realistic working set. Coarse-but-
 * correct beats fine-but-wrong.
 *
 * **TTL is 30 seconds.** Long enough to absorb back-to-back wake-ups
 * within one user turn, short enough that an agent save followed by a
 * wake-up returns fresh state on the next session-start tick even if
 * the bump path were ever skipped. The TTL is the floor; bumps are
 * the ceiling.
 *
 * **Bounded LRU at 32 entries.** The key axis (projectId × userQuery
 * × options-shape) is wide enough that an unbounded cache could
 * accumulate over a long-lived MCP session. 32 is generous compared
 * to the realistic working set (one project, one query shape) and
 * cheap.
 *
 * **Stampede protection.** Concurrent cold-start callers on the same
 * key (e.g. SessionStart and UserPromptSubmit firing close enough
 * together that the second arrives before the first commits) collapse
 * onto a single fan-out via `getOrLoad`. The first caller dispatches
 * the loader and installs a pending promise; concurrent callers find
 * the pending entry and await it. `bumpEpoch` clears `pending` so a
 * write landing during a fan-out cannot poison subscribers — the
 * existing in-flight loader's commit is suppressed by the epoch
 * sandwich, and the next caller dispatches a fresh fetch instead of
 * subscribing. Same posture as `LruCache.getOrLoad` in `cache.ts`.
 */

import type { WakeUpData, WakeUpOptions } from "./wakeup.js"

/**
 * TTL and capacity defaults are module-private. They aren't tunable
 * via env today (no real-vault data has motivated knobs); a future
 * `LORE_WAKEUP_CACHE_TTL_MS` would re-export them. Tests pass `ttlMs`
 * and `max` through the constructor instead.
 */
const WAKEUP_CACHE_TTL_MS = 30_000
const WAKEUP_CACHE_MAX_ENTRIES = 32

interface CacheEntry {
  data: WakeUpData
  expiresAt: number
  storedEpoch: number
}

export class WakeUpCache {
  private readonly store = new Map<string, CacheEntry>()
  /**
   * In-flight loader promises keyed by cache key. Populated by
   * `getOrLoad` on cold-start dispatch and cleared via `.finally` so
   * a rejected loader does not poison the slot. `bumpEpoch` clears
   * the whole map so a write landing during fan-out forces the next
   * caller to dispatch fresh.
   */
  private readonly pending = new Map<string, Promise<WakeUpData>>()
  private readonly max: number
  private readonly ttlMs: number
  private readonly nowFn: () => number
  private epoch = 0

  constructor(opts: { max?: number; ttlMs?: number; now?: () => number } = {}) {
    this.max = opts.max ?? WAKEUP_CACHE_MAX_ENTRIES
    this.ttlMs = opts.ttlMs ?? WAKEUP_CACHE_TTL_MS
    // Constructor-injected so tests can pin TTL behavior
    // deterministically — `loadWakeUpData` itself takes `opts.now`
    // for the same reason. Defaulting to `Date.now` keeps the
    // production path identical to a wall-clock cache.
    this.nowFn = opts.now ?? Date.now
  }

  /**
   * Snapshot of the current write epoch. Callers capture this BEFORE
   * dispatching their fan-out and pass it back to `getOrLoad` so a
   * concurrent write during fan-out invalidates the result instead of
   * poisoning the cache. See `loadWakeUpData`'s capture site for the
   * sandwich contract this getter participates in.
   */
  get currentEpoch(): number {
    return this.epoch
  }

  /**
   * Bump the write epoch. Every MCP write action calls this exactly
   * once after its handler returns. Bumping pre-write would invalidate
   * a fresh fan-out that races a write — the sandwich rules in
   * `loadWakeUpData` capture the epoch at dispatch, so the post-write
   * bump is the side that closes the race.
   *
   * Also clears `pending` so any in-flight loader's subscribers will
   * see the (about-to-be-stale) result one last time but no NEW caller
   * can subscribe to a snapshot that pre-dates the write. The
   * in-flight loader's commit is suppressed by the epoch check.
   *
   * **Resolution-window note.** A new caller arriving between
   * `bumpEpoch` and the in-flight loader's resolution dispatches a
   * fresh fan-out — by design, since the caller's snapshot needs the
   * post-write state. The prior subscriber still receives the
   * pre-write result one last time. Two concurrent fan-outs land in
   * that window; the second commits, the first is silently discarded
   * by the epoch sandwich.
   */
  bumpEpoch(): void {
    this.epoch++
    this.pending.clear()
  }

  /**
   * Cache hit only when (a) the entry exists, (b) it has not expired,
   * and (c) its stored epoch matches the current epoch — i.e. no
   * write has landed since the entry was committed. Any miss path
   * removes the entry so a stale read doesn't keep occupying a slot.
   *
   * `set` relies on this method's "delete-then-insert on hit" to
   * keep the LRU semantics correct: every `get` re-inserts the entry
   * at the Map's tail so the head is always the least-recently-used.
   * A future contributor "optimizing" `get` by skipping the
   * reinsertion would silently break LRU eviction in `set`.
   */
  get(key: string): WakeUpData | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.nowFn() || entry.storedEpoch !== this.epoch) {
      this.store.delete(key)
      return undefined
    }
    // Move to MRU tail — see `set`'s eviction rule for why this is
    // load-bearing.
    this.store.delete(key)
    this.store.set(key, entry)
    return entry.data
  }

  /**
   * Look up `key`, or invoke `loader` and cache its resolved value
   * on miss. Concurrent cold-start misses on the same key collapse
   * onto a single in-flight promise, mirroring `LruCache.getOrLoad`.
   *
   * `startEpoch` is captured by the caller BEFORE dispatch so a
   * write that lands during fan-out invalidates the commit (the
   * sandwich pattern). The commit step is `set(key, data,
   * startEpoch)`; if the epoch has advanced, `set` returns false
   * and the entry is not stored — but the resolved value still
   * propagates to every subscriber, because it represents the
   * snapshot the loader actually computed. Subsequent reads fall
   * through to a fresh fetch.
   */
  async getOrLoad(
    key: string,
    startEpoch: number,
    loader: () => Promise<WakeUpData>,
  ): Promise<WakeUpData> {
    const hit = this.get(key)
    if (hit !== undefined) return hit

    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight

    const promise = loader()
    // Wrap the loader's promise so we drop the slot on completion
    // and commit the result on the way out — both attached
    // sequentially so the slot release happens after the commit
    // attempt observes the latest cache state.
    const tracked = promise
      .then((data) => {
        // Identity guard: only commit when our pending slot is still
        // the authoritative one. `bumpEpoch` clears `pending`, so a
        // post-write commit attempt against the captured-pre-write
        // epoch will see `pending.get(key) !== promise` and skip.
        if (this.pending.get(key) === tracked) {
          this.set(key, data, startEpoch)
        }
        return data
      })
      .finally(() => {
        if (this.pending.get(key) === tracked) {
          this.pending.delete(key)
        }
      })

    this.pending.set(key, tracked)
    return tracked
  }

  /**
   * Commit `data` to the cache only when `startEpoch` (captured by
   * the caller before fan-out) still matches the current epoch.
   * Returns true on commit, false on skip.
   *
   * Eviction at capacity walks from the Map's iteration head — which
   * is the least-recently-used entry because `get` deletes-and-
   * reinserts on every hit, moving the entry to the tail. Map
   * iteration order is insertion order in JavaScript, so the head
   * is always the LRU. Do not optimize `get` to skip the
   * reinsertion.
   */
  set(key: string, data: WakeUpData, startEpoch: number): boolean {
    if (this.epoch !== startEpoch) return false
    if (this.store.has(key)) {
      this.store.delete(key)
    } else if (this.store.size >= this.max) {
      const oldest = this.store.keys().next().value
      if (oldest !== undefined) this.store.delete(oldest)
    }
    this.store.set(key, {
      data,
      expiresAt: this.nowFn() + this.ttlMs,
      storedEpoch: startEpoch,
    })
    return true
  }

  /** Drop every entry. Used by tests; production code lets the TTL do the work. */
  clear(): void {
    this.store.clear()
    this.pending.clear()
  }

  /** Current entry count — useful for tests that assert eviction. */
  get size(): number {
    return this.store.size
  }
}

/**
 * Subset of `WakeUpOptions` whose values structurally affect the
 * `loadWakeUpData` result. `now` is deliberately excluded — it
 * defaults to `Date.now()` in production callers and would defeat
 * caching with no real-world benefit (sub-second drift between
 * back-to-back invocations does not change the fan-out output).
 * Test callers that pin `now` and want cache misses on every tick
 * should clear the cache between invocations or pass distinct
 * `userQuery` values.
 *
 * `todayDate` IS included because it drives the Stale Confidence
 * cutoff and the rendered `Nd ago` arithmetic; a wake-up that
 * crosses UTC midnight should re-fetch. The caller is responsible
 * for passing the EFFECTIVE `todayDate` (defaulted from `now` when
 * absent on `WakeUpOptions`) into the key — `loadWakeUpData` does
 * this defaulting before computing the key so callers that omit
 * `todayDate` still see distinct keys across day boundaries.
 */
const KEY_OPTION_FIELDS = [
  "projectId",
  "userQuery",
  "memoryLimit",
  "memoryLimitWithDigest",
  "digestFreshnessDays",
  "knowledgeFactLimit",
  "relatedMemoryLimit",
  "taskLimit",
  "taskMemoryLimit",
  "includeMemoryContent",
  "includeDecisions",
  "includeStaleConfidence",
  "includeProposedMemories",
  "proposedMemoryLimit",
  "includeCoverage",
  "todayDate",
  // Issue #286 — both inherited-memory options change the
  // `inheritedMemories` array on `WakeUpData`. Without these
  // fields, a wake-up with `includeInheritedMemories: false` (hook
  // posture) and a wake-up with the default (MCP posture) compute
  // the same key and cross-serve — the second caller sees the
  // first caller's `inheritedMemories` regardless of their own
  // opt-out. Pinned by the inherited-options coverage in
  // `wakeup-cache.test.ts`.
  "includeInheritedMemories",
  "inheritedMemoryLimit",
] as const satisfies readonly (keyof WakeUpOptions)[]

/**
 * Compute a stable cache key for a `loadWakeUpData` invocation. The
 * key folds every option that can change the fan-out output into a
 * single canonically-stringified record so distinct (projectId,
 * userQuery, options) tuples never collide and same-input
 * invocations always hit the same slot.
 *
 * `userQuery` is normalized via the same trim+lowercase rule so two
 * structurally identical queries that differ only in whitespace or
 * case share a key — Notion's vector index ignores those, so the
 * cache should too.
 *
 * The serialization is a sorted-key JSON string rather than a hash
 * digest. None of the option fields are user-controlled secrets and
 * with a 32-entry cap there is no plausible collision pressure;
 * canonical-string keying matches the same correctness guarantee as
 * SHA-256 at lower CPU cost per lookup.
 */
export function computeWakeUpCacheKey(opts: WakeUpOptions): string {
  const normalized: Record<string, unknown> = {}
  for (const field of KEY_OPTION_FIELDS) {
    const value = opts[field]
    if (field === "userQuery" && typeof value === "string") {
      const trimmed = value.trim().toLowerCase()
      if (trimmed.length > 0) normalized[field] = trimmed
      continue
    }
    if (value !== undefined) normalized[field] = value
  }
  // Stable JSON: sort keys so structurally identical option objects
  // serialize identically regardless of insertion order.
  const sortedKeys = Object.keys(normalized).sort()
  const stable: Record<string, unknown> = {}
  for (const k of sortedKeys) stable[k] = normalized[k]
  return JSON.stringify(stable)
}
