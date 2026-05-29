import { settleAll } from "./settle.js"
import type { FactInvalidateResult, QueryFactsOpts } from "./fact.js"
import { computeSubjectKey } from "../notion/normalize.js"
import { ACTIVE_DECISION_STATUSES, memoryScopeToInput } from "../types.js"
import type { CreateFactInput, Decision, Fact, MemoryStatus } from "../types.js"

/**
 * Entity-aware identity key for a fact's Subject side. Used by the
 * decision-graph BFS / retarget paths to dedup links that refer to the
 * same canonical entity even when the underlying facts carry different
 * raw Subject strings.
 *
 * - When `subjectEntityId` is populated (post-PF3-01 row that's been
 *   filled by `--build-entities` or written through
 *   `lore-fact action='create'` after the resolver), the relation id
 *   is the canonical key.
 * - When the relation column is empty (unmigrated row), fall back
 *   to `computeSubjectKey(subject)` — the same case/whitespace fold
 *   `SubjectKey` uses. Two facts with cosmetic Subject variants still
 *   collapse to one key so the existing dedup contract holds; two
 *   facts with structurally different Subjects still produce different
 *   keys.
 *
 * Without this, two facts about the same entity but with cosmetically
 * different Subject strings produce duplicate `decided_by` rows in
 * `syncDecisionReachability` and duplicate canonical links in
 * `resolveCanonicalDecisionLinks`.
 */
function factSubjectKey(fact: Fact): string {
  if (fact.subjectEntityId) return `entity:${fact.subjectEntityId}`
  return `subject:${computeSubjectKey(fact.subject)}`
}

export interface DecisionGraphServices {
  decisions: {
    getById(id: string): Promise<Decision>
  }
  facts: {
    queryByObject(object: string, opts?: QueryFactsOpts): Promise<Fact[]>
    queryBySourceMemory(sourceMemoryId: string, opts?: QueryFactsOpts): Promise<Fact[]>
    create(input: CreateFactInput): Promise<Fact>
    invalidate(id: string): Promise<void | FactInvalidateResult>
  }
}

export interface ResolvedCurrentDecisions {
  current: Decision[]
  replacedCount: number
}

/**
 * Shared BFS memoization across a fan-out of supersession walks.
 *
 * When `resolveCanonicalDecisionLinks` fires multiple `resolveCurrentDecisions`
 * calls in parallel and two walks converge on the same descendant, we want a
 * single `getDecision` / `queryByObject` round-trip for that descendant across
 * the whole fan-out. Pass a shared `SupersessionCaches` instance via
 * `opts.caches` and each walk consults the same memoization tables.
 *
 * Entries are stored as Promises rather than resolved values so concurrent
 * cold-start misses on the same key collapse onto one underlying Notion call:
 * the first miss installs a pending promise, the second miss finds it and
 * awaits the same result. Without this, two walks that reach a shared
 * descendant in lockstep both fire their own `getDecision` / `queryByObject`.
 *
 * **Scope and lifetime.** Scope is explicitly per
 * `resolveCanonicalDecisionLinks` invocation — decisions mutate (status flips
 * on supersession, review dates slide), so longer-lived caching lives in the
 * services themselves with their own TTLs. This graph-local cache collapses
 * BFS-level redundancy inside one fan-out; `DecisionService.idCache` (and
 * every future `LruCache` consumer) handles cross-invocation reuse. The two
 * mechanisms coexist: this layer gets the intra-invocation wins, the primitive
 * layer gets the repeat-query wins.
 *
 * **`projectId` is captured per invocation, not per-cache.** Both
 * `resolveCurrentDecisions` calls sharing a `SupersessionCaches` must use
 * the same `opts.projectId`. The cached successor lists are computed under
 * one project's scope; sharing a cache across two different-projectId calls
 * would leak a successor set from project A into project B's walk. Today
 * `resolveCanonicalDecisionLinks` passes one `opts` through so this is
 * moot, but if a future caller shares an instance across heterogeneous
 * walks, it must allocate a fresh `SupersessionCaches` per project.
 */
export interface SupersessionCaches {
  decisions: Map<string, Promise<Decision | null>>
  successors: Map<string, Promise<string[]>>
}

export function createSupersessionCaches(): SupersessionCaches {
  return { decisions: new Map(), successors: new Map() }
}

export interface CanonicalDecisionLink {
  fact: Fact
  decision: Decision
}

/**
 * Shape returned by `resolveCanonicalDecisionLinks`: the canonical links we
 * were able to resolve, plus per-root failures for roots whose walks
 * rejected. Callers surface `failures` as tool warnings so an agent sees a
 * partial answer with a named gap instead of an opaque error.
 */
export interface CanonicalDecisionLinkResult {
  links: CanonicalDecisionLink[]
  failures: Array<{ rootId: string; error: unknown }>
}

export interface ReachabilitySyncResult {
  invalidated: number
  created: number
}

/**
 * Resolve a set of decision IDs to the current active leaf decisions by
 * following `supersedes_decision` edges forward through the graph.
 *
 * `opts.caches` lets the caller share `decisionCache` / `successorCache`
 * across multiple invocations (the canonical consumer is
 * `resolveCanonicalDecisionLinks`). When omitted, a fresh pair is
 * allocated per call.
 *
 * ### Rejection semantics (part of the contract, not an impl detail)
 *
 * `getDecision` maps failures to `null` via `.catch(() => null)`, so it
 * never rejects from the caller's POV — a missing decision is
 * indistinguishable from a permission-denied or transient fetch error.
 *
 * `getSuccessorIds` propagates rejections to the caller. On reject it
 * evicts its cache slot (identity-guarded via
 * `successorCache.get(id) === promise`) so a *later sequentially
 * dispatched* walk that looks up the same key finds an empty slot and
 * installs its own retry. **This is not a shield for in-flight
 * awaiters** — sibling walks that already subscribed to the pending
 * promise before it rejected still inherit the rejection. Under
 * `resolveCanonicalDecisionLinks`'s `settleAll` fan-out, a transient
 * `queryByObject` failure on a shared descendant that two
 * concurrently-dispatched walks both reach before rejection surfaces
 * as 2+ failures in the bucket. The fully-bounded variant (race a
 * `null`-sentinel so subscribers see null rather than a throw) is
 * deferred — the current shape matches `LruCache.getOrLoad`'s contract
 * and the sequential-retry case is the common one. Pinned by the
 * concurrent-cascade test.
 */
export async function resolveCurrentDecisions(
  services: DecisionGraphServices,
  decisionIds: string[],
  opts: { projectId?: string; caches?: SupersessionCaches } = {}
): Promise<ResolvedCurrentDecisions> {
  const queue = Array.from(new Set(decisionIds.filter(Boolean)))
  const visited = new Set<string>()
  const replaced = new Set<string>()
  const leafIds = new Set<string>()
  const caches = opts.caches ?? createSupersessionCaches()
  const decisionCache = caches.decisions
  const successorCache = caches.successors

  function getDecision(id: string): Promise<Decision | null> {
    const cached = decisionCache.get(id)
    if (cached !== undefined) return cached
    const promise = services.decisions.getById(id).catch(() => null)
    decisionCache.set(id, promise)
    return promise
  }

  function getSuccessorIds(id: string): Promise<string[]> {
    const cached = successorCache.get(id)
    if (cached !== undefined) return cached

    // Rejection semantics are load-bearing and documented on the function
    // header above — the quick version: propagate the error, evict the
    // cache slot so sequential retries dispatch fresh, but don't shield
    // in-flight awaiters.
    const promise = (async () => {
      const decision = await getDecision(id)
      const lookupKeys = [id]
      if (decision?.title && decision.title !== id) {
        lookupKeys.push(decision.title)
      }

      // Parallel lookup: the two `queryByObject` calls (one for `id`,
      // one for the legacy title fallback) are independent — they
      // filter on different values of the same column. Awaiting them
      // sequentially would double the round-trip cost per BFS node.
      // The shared rate-limited Notion client governs concurrency, so
      // peak throughput is unchanged. Wall-clock per node drops from
      // `T(query[id]) + T(query[title])` to `max(...)`.
      const factsPerKey = await Promise.all(
        lookupKeys.map((key) =>
          services.facts.queryByObject(key, {
            projectId: opts.projectId,
            predicates: ["supersedes_decision"],
            limit: 25,
          })
        )
      )

      // Exact-match guard: a fact only contributes a successor if its
      // `Object` is one of the lookup keys. Comparing against the set
      // (rather than the per-iteration `key` from the old serial loop)
      // preserves the substring-hit rejection while letting the
      // queries fan out.
      //
      // Subtle: this is *at-least-as-strict* as the old per-iteration
      // check, not formally identical. Old: a fact matched only if it
      // was returned by the query for `key` AND `fact.object === key`.
      // New: a fact matches if `fact.object ∈ lookupKeys`. The two
      // diverge only when a query returns a row whose Object is
      // another lookup key (e.g. `queryByObject(id)` returning a row
      // with `object === title`). In the old code that row was
      // dropped on the id pass and recovered on the title pass; here
      // it's accepted directly. Net behavior is equivalent for sane
      // server-side filters; pathological `contains` results are
      // slightly more permissively recovered, never spuriously
      // accepted (the substring-noise test pins this).
      const lookupKeySet = new Set(lookupKeys)
      const successors = new Set<string>()
      for (const facts of factsPerKey) {
        for (const fact of facts) {
          if (fact.predicate !== "supersedes_decision") continue
          if (!lookupKeySet.has(fact.object)) continue
          const successorId = fact.sourceMemoryId ?? fact.subject
          if (successorId && successorId !== id) {
            successors.add(successorId)
          }
        }
      }

      return Array.from(successors)
    })().catch((err) => {
      // Evict only if this exact promise is still in the cache. A later
      // sibling walk may have already seen the rejection and re-installed
      // its own retry; don't clobber that.
      if (successorCache.get(id) === promise) {
        successorCache.delete(id)
      }
      throw err
    })

    successorCache.set(id, promise)
    return promise
  }

  while (queue.length > 0) {
    const currentId = queue.shift()
    if (!currentId || visited.has(currentId)) continue

    visited.add(currentId)
    const successorIds = await getSuccessorIds(currentId)
    if (successorIds.length === 0) {
      const decision = await getDecision(currentId)
      // A leaf (no successors) only counts as a current governing
      // decision when its status is in `ACTIVE_DECISION_STATUSES`.
      // The previous hard-coded `=== "superseded"` check let
      // `deprecated` and `rejected` decisions surface as "current"
      // even though they are conceptually inactive. The widening cast
      // lets `includes` accept the broader `MemoryStatus` carried by
      // `Memory.status`; every value in `ACTIVE_DECISION_STATUSES` is
      // itself a `MemoryStatus`, so the widening is sound.
      const activeStatuses = ACTIVE_DECISION_STATUSES as readonly MemoryStatus[]
      if (!decision || !activeStatuses.includes(decision.status)) {
        replaced.add(currentId)
        continue
      }
      leafIds.add(currentId)
      continue
    }

    replaced.add(currentId)
    queue.push(...successorIds)
  }

  const current = (
    await Promise.all(Array.from(leafIds).map((id) => getDecision(id)))
  ).filter((decision): decision is Decision => decision !== null)

  current.sort((a, b) => decisionSortKey(b).localeCompare(decisionSortKey(a)))
  return { current, replacedCount: replaced.size }
}

/**
 * Resolve `decided_by` facts to the current canonical decisions they imply.
 * Deduplicates repeated links that converge on the same subject/decision pair.
 *
 * Per-root supersession walks fan out concurrently: each unique root ID dispatches
 * its `resolveCurrentDecisions` call before any has completed, so N distinct roots
 * cost one chain-depth round-trip instead of N. The in-chain BFS inside each
 * `resolveCurrentDecisions` call stays sequential — step N+1 needs step N's
 * successor list — so the speedup is strictly in the outer fan-out.
 *
 * All walks in a single invocation share one `SupersessionCaches` so that
 * when two roots converge on a common descendant (the common shape after a
 * single supersession rewrites a legacy decision tree), the descendant's
 * `getDecision` / `queryByObject` runs once total — not once per walk.
 *
 * Partial-results posture: a single root's walk may reject (transient
 * Notion 5xx, a missing page). Instead of sinking the whole call via
 * `Promise.all`, we `settleAll` over the fan-out and return the walks
 * that succeeded plus a `failures` list naming the roots that didn't.
 * Callers surface `failures` as tool warnings so an agent sees a partial
 * answer with a named gap instead of an opaque error banner.
 */
export async function resolveCanonicalDecisionLinks(
  services: DecisionGraphServices,
  facts: Fact[],
  opts: { projectId?: string } = {}
): Promise<CanonicalDecisionLinkResult> {
  const rootsByFact = facts.map((fact) => fact.sourceMemoryId ?? fact.object)
  const uniqueRoots = Array.from(new Set(rootsByFact.filter((rootId) => Boolean(rootId))))

  const caches = createSupersessionCaches()
  const { fulfilled, failures } = await settleAll(
    uniqueRoots.map(
      (rootId) =>
        [
          rootId,
          resolveCurrentDecisions(services, [rootId], { ...opts, caches }),
        ] as const
    )
  )
  const resolutions = new Map<string, ResolvedCurrentDecisions>(fulfilled)

  const links: CanonicalDecisionLink[] = []
  const seen = new Set<string>()

  for (let i = 0; i < facts.length; i++) {
    const rootId = rootsByFact[i]
    if (!rootId) continue
    const resolution = resolutions.get(rootId)
    if (!resolution) continue

    const fact = facts[i]
    for (const decision of resolution.current) {
      // Dedup by canonical entity (post-PF3-01) with case-folded
      // Subject fallback for un-migrated rows. Pre-PF3-01 the key was
      // raw `fact.subject`, which double-counted "MemoryService" and
      // "memoryservice" as distinct links.
      const key = `${factSubjectKey(fact)}\u0000${decision.id}`
      if (seen.has(key)) continue
      seen.add(key)
      links.push({ fact, decision })
    }
  }

  return {
    links,
    failures: failures.map(({ key, error }) => ({ rootId: key, error })),
  }
}

/**
 * Retarget active `decided_by` facts from an old decision onto its replacement.
 * This keeps the graph canonical after supersession so read paths do less work.
 */
export async function syncDecisionReachability(
  services: DecisionGraphServices,
  oldDecisionId: string,
  newDecision: Decision
): Promise<ReachabilitySyncResult> {
  if (oldDecisionId === newDecision.id) {
    return { invalidated: 0, created: 0 }
  }

  const [oldFacts, existingNewFacts] = await Promise.all([
    services.facts.queryBySourceMemory(oldDecisionId, {
      predicates: ["decided_by"],
      // Decision-graph reachability sync must see every decided_by
      // fact regardless of scope context — this is internal
      // reconciliation that re-points the graph from the old to the
      // new decision and would lose decided_by edges on out-of-scope
      // sourced facts otherwise.
      includeOutOfScope: true,
    }),
    services.facts.queryBySourceMemory(newDecision.id, {
      predicates: ["decided_by"],
      includeOutOfScope: true,
    }),
  ])

  // Use entity-aware key so two existing decided_by facts referencing
  // the same canonical entity (one with a populated SubjectEntity, one
  // without) collapse to one slot. Pre-PF3-01 the set was keyed on raw
  // `fact.subject`, which would create a duplicate retarget when the
  // new and old facts had cosmetically different subject strings for
  // the same entity.
  const existingKeys = new Set(existingNewFacts.map((fact) => factSubjectKey(fact)))
  let invalidated = 0
  let created = 0

  for (const fact of oldFacts) {
    await services.facts.invalidate(fact.id)
    invalidated++

    const factKey = factSubjectKey(fact)
    if (existingKeys.has(factKey)) continue

    await services.facts.create({
      subject: fact.subject,
      predicate: "decided_by",
      object: newDecision.id,
      projectIds:
        fact.projectIds.length > 0
          ? fact.projectIds
          : newDecision.projectIds.length > 0
            ? newDecision.projectIds
            : undefined,
      sourceMemoryId: newDecision.id,
      // Carry the canonical entity relation forward so the retargeted
      // row stays exact-recall under `queryByEntityId`. `null`
      // (unbackfilled source fact) flows through as `undefined` and the
      // fact lands as a text-only row that the next `--build-entities`
      // pass can re-point.
      subjectEntityId: fact.subjectEntityId ?? undefined,
      // Retargeted `decided_by` facts inherit the
      // new decision's scope. The previous fact (now invalidated)
      // carried the OLD decision's scope; the retarget rebuilds the
      // edge under the governing decision's identity slot.
      scope: memoryScopeToInput(newDecision.scope),
    })

    existingKeys.add(factKey)
    created++
  }

  return { invalidated, created }
}

function decisionSortKey(decision: Decision): string {
  return decision.decidedAt ?? decision.updatedAt
}
