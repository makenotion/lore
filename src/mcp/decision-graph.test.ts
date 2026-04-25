import { describe, expect, it, vi } from "vitest"
import {
  createSupersessionCaches,
  resolveCanonicalDecisionLinks,
  resolveCurrentDecisions,
  syncDecisionReachability,
} from "./decision-graph.js"
import type { Decision, Fact, FactConfidence, FactPredicate } from "../types.js"

function makeDecision(id: string, overrides: Partial<Decision> = {}): Decision {
  return {
    id,
    title: `Decision ${id}`,
    projectIds: [],
    topicId: null,
    source: "manual",
    kind: "decision",
    status: "accepted",
    confidence: "certain",
    reviewBy: null,
    decidedAt: "2026-04-20",
    supersedesIds: [],
    affectsIds: [],
    alternatives: "",
    consequences: "",
    author: "",
    agent: "",
    tags: [],
    keywords: "",
    session: "",
    content: "",
    taskState: null,
    blockedBy: "",
    entity: "",
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  }
}

function makeFact(
  id: string,
  overrides: Partial<Fact> & { predicate?: FactPredicate; confidence?: FactConfidence } = {}
): Fact {
  return {
    id,
    subject: "Entity",
    predicate: overrides.predicate ?? "related_to",
    object: "Object",
    projectIds: [],
    validFrom: "2026-04-20",
    validUntil: null,
    reviewBy: null,
    sourceMemoryId: null,
    confidence: overrides.confidence ?? "certain",
    subjectEntityId: null,
    objectEntityId: null,
    ...overrides,
  }
}

function createServices(opts: {
  decisions?: Record<string, Decision>
  factsByObject?: Record<string, Fact[]>
  factsBySourceMemory?: Record<string, Fact[]>
}) {
  const decisions = opts.decisions ?? {}
  const factsByObject = opts.factsByObject ?? {}
  const factsBySourceMemory = opts.factsBySourceMemory ?? {}

  const services = {
    decisions: {
      getById: vi.fn(async (id: string) => {
        const decision = decisions[id]
        if (!decision) throw new Error(`missing decision ${id}`)
        return decision
      }),
    },
    facts: {
      queryByObject: vi.fn(async (object: string) => factsByObject[object] ?? []),
      queryBySourceMemory: vi.fn(
        async (sourceMemoryId: string) => factsBySourceMemory[sourceMemoryId] ?? []
      ),
      create: vi.fn(async () => makeFact("created")),
      invalidate: vi.fn(async () => {}),
    },
  }

  return services
}

describe("resolveCurrentDecisions", () => {
  it("follows ID-based supersession facts to the current decision", async () => {
    const services = createServices({
      decisions: {
        "old-id": makeDecision("old-id", {
          title: "Old decision",
          status: "superseded",
        }),
        "new-id": makeDecision("new-id", {
          title: "New decision",
          decidedAt: "2026-04-21",
        }),
      },
      factsByObject: {
        "old-id": [
          makeFact("sup-1", {
            subject: "new-id",
            predicate: "supersedes_decision",
            object: "old-id",
            sourceMemoryId: "new-id",
          }),
        ],
      },
    })

    const resolved = await resolveCurrentDecisions(services, ["old-id"], {
      projectId: "proj-1",
    })

    expect(resolved.current.map((decision) => decision.id)).toEqual(["new-id"])
    expect(resolved.replacedCount).toBe(1)
    expect(services.facts.queryByObject).toHaveBeenCalledWith(
      "old-id",
      expect.objectContaining({
        projectId: "proj-1",
        predicates: ["supersedes_decision"],
      })
    )
  })
})

describe("resolveCanonicalDecisionLinks", () => {
  it("falls back to legacy title-based supersession facts and deduplicates subject/decision pairs", async () => {
    const services = createServices({
      decisions: {
        "old-id": makeDecision("old-id", {
          title: "Old decision",
          status: "superseded",
        }),
        "new-id": makeDecision("new-id", {
          title: "New decision",
          decidedAt: "2026-04-21",
        }),
      },
      factsByObject: {
        "Old decision": [
          makeFact("sup-legacy", {
            subject: "New decision",
            predicate: "supersedes_decision",
            object: "Old decision",
            sourceMemoryId: "new-id",
          }),
        ],
      },
    })

    const { links, failures } = await resolveCanonicalDecisionLinks(services, [
      makeFact("fact-old", {
        subject: "AuthService",
        predicate: "decided_by",
        object: "Old decision",
        sourceMemoryId: "old-id",
      }),
      makeFact("fact-new", {
        subject: "AuthService",
        predicate: "decided_by",
        object: "new-id",
        sourceMemoryId: "new-id",
      }),
    ])

    expect(failures).toEqual([])
    expect(links).toHaveLength(1)
    expect(links[0].fact.subject).toBe("AuthService")
    expect(links[0].decision.id).toBe("new-id")
  })

  it("shares descendant decision / successor lookups across root walks", async () => {
    // Two roots ("root-a", "root-b") both supersede into the same leaf
    // ("leaf"). Without a shared cache, the leaf would be fetched twice —
    // once per root walk. With the shared cache, exactly once.
    const services = createServices({
      decisions: {
        "root-a": makeDecision("root-a", { title: "root-a", status: "superseded" }),
        "root-b": makeDecision("root-b", { title: "root-b", status: "superseded" }),
        leaf: makeDecision("leaf", { title: "leaf", decidedAt: "2026-04-22" }),
      },
      factsByObject: {
        "root-a": [
          makeFact("sup-a", {
            subject: "leaf",
            predicate: "supersedes_decision",
            object: "root-a",
            sourceMemoryId: "leaf",
          }),
        ],
        "root-b": [
          makeFact("sup-b", {
            subject: "leaf",
            predicate: "supersedes_decision",
            object: "root-b",
            sourceMemoryId: "leaf",
          }),
        ],
      },
    })

    await resolveCanonicalDecisionLinks(services, [
      makeFact("fact-a", {
        subject: "Entity",
        predicate: "decided_by",
        object: "root-a",
        sourceMemoryId: "root-a",
      }),
      makeFact("fact-b", {
        subject: "Entity",
        predicate: "decided_by",
        object: "root-b",
        sourceMemoryId: "root-b",
      }),
    ])

    // Leaf descendant should be fetched exactly once across the fan-out.
    const leafFetches = services.decisions.getById.mock.calls.filter(
      (call) => call[0] === "leaf"
    ).length
    expect(leafFetches).toBe(1)

    // Successor lookup for the leaf likewise caches: only one queryByObject
    // against "leaf" across both walks.
    const leafQueries = services.facts.queryByObject.mock.calls.filter(
      (call) => call[0] === "leaf"
    ).length
    expect(leafQueries).toBe(1)
  })

  it("fans out per-root supersession walks concurrently", async () => {
    const roots = ["root-1", "root-2", "root-3", "root-4"]
    const services = createServices({
      decisions: Object.fromEntries(
        roots.map((id) => [id, makeDecision(id, { title: id })])
      ),
    })

    const pending = new Map<string, (facts: Fact[]) => void>()
    services.facts.queryByObject = vi.fn(
      (object: string) =>
        new Promise<Fact[]>((resolve) => {
          pending.set(object, resolve)
        })
    )

    const linksPromise = resolveCanonicalDecisionLinks(
      services,
      roots.map((rootId, index) =>
        makeFact(`fact-${index}`, {
          subject: "Entity",
          predicate: "decided_by",
          object: rootId,
          sourceMemoryId: rootId,
        })
      )
    )

    // Poll until every per-root walk has reached its first queryByObject
    // dispatch. In the pre-change serial loop, only one call would ever be
    // pending here — waitFor would time out, which is the intended regression
    // signal. Using waitFor instead of a fixed setImmediate count keeps the
    // test durable if resolveCurrentDecisions grows another pre-dispatch await.
    await vi.waitFor(() => {
      expect(services.facts.queryByObject).toHaveBeenCalledTimes(roots.length)
    })

    const dispatchedObjects = services.facts.queryByObject.mock.calls
      .map((call) => call[0] as string)
      .sort()
    expect(dispatchedObjects).toEqual([...roots].sort())

    for (const rootId of roots) {
      pending.get(rootId)?.([])
    }

    const { links, failures } = await linksPromise
    expect(failures).toEqual([])
    expect(links.map((link) => link.decision.id).sort()).toEqual([...roots].sort())
  })

  it("collapses two concurrent walks onto a single leaf fetch even under deliberate interleaving", async () => {
    // Reviewer concern: the earlier shared-cache test passes identically
    // whether entries are plain values or promises, because both mocks
    // resolve in a single microtask. This test gates the leaf's
    // `getById` so walks A and B both reach the `leaf` lookup key while
    // the first fetch is still pending — the path a plain-value map
    // cannot satisfy. Promise-valued entries must install the pending
    // promise on walk A's first miss so walk B awaits it instead of
    // firing its own `getById("leaf")`.
    let releaseLeafFetch!: (decision: Decision) => void
    const leafFetchGate = new Promise<Decision>((resolve) => {
      releaseLeafFetch = resolve
    })

    const services = createServices({
      decisions: {
        "root-a": makeDecision("root-a", { title: "root-a", status: "superseded" }),
        "root-b": makeDecision("root-b", { title: "root-b", status: "superseded" }),
      },
      factsByObject: {
        "root-a": [
          makeFact("sup-a", {
            subject: "leaf",
            predicate: "supersedes_decision",
            object: "root-a",
            sourceMemoryId: "leaf",
          }),
        ],
        "root-b": [
          makeFact("sup-b", {
            subject: "leaf",
            predicate: "supersedes_decision",
            object: "root-b",
            sourceMemoryId: "leaf",
          }),
        ],
      },
    })

    // Override `getById` so root fetches resolve immediately but the leaf
    // fetch is gated. Every caller that hits `getById("leaf")` shares the
    // same gated promise — but if the cache stores the *value* instead of
    // the *promise*, walk B would fire its own separate fetch.
    const leafDecision = makeDecision("leaf", {
      title: "leaf",
      decidedAt: "2026-04-22",
    })
    services.decisions.getById = vi.fn(async (id: string) => {
      if (id === "leaf") return leafFetchGate
      return makeDecision(id, { title: id, status: "superseded" })
    })

    const linksPromise = resolveCanonicalDecisionLinks(services, [
      makeFact("fact-a", {
        subject: "Entity",
        predicate: "decided_by",
        object: "root-a",
        sourceMemoryId: "root-a",
      }),
      makeFact("fact-b", {
        subject: "Entity",
        predicate: "decided_by",
        object: "root-b",
        sourceMemoryId: "root-b",
      }),
    ])

    // Wait until both walks have reached `getById("leaf")` — if the
    // promise-valued cache works, only one dispatch has fired; the second
    // walker awaits the same pending promise.
    await vi.waitFor(() => {
      const leafDispatches = services.decisions.getById.mock.calls.filter(
        (call) => call[0] === "leaf",
      ).length
      // Exactly one call to getById("leaf") across both walks is the
      // invariant the shared pending-promise is meant to enforce.
      expect(leafDispatches).toBe(1)
    })

    releaseLeafFetch(leafDecision)
    const { links, failures } = await linksPromise
    expect(failures).toEqual([])
    expect(links.map((link) => link.decision.id)).toEqual(["leaf"])
  })

  it("does not poison sibling walks when one walk's queryByObject rejects", async () => {
    // Root A's walk converges on a shared descendant "leaf"; root B's walk
    // arrives at "leaf" after root A's lookup has rejected. If the cache
    // stored the rejected promise, root B would inherit the rejection —
    // a one-walk failure becomes a two-walk failure. The on-reject evict
    // keeps the rejection scoped to the walk that actually encountered it.
    const services = createServices({
      decisions: {
        "root-a": makeDecision("root-a", { title: "root-a", status: "superseded" }),
        "root-b": makeDecision("root-b", { title: "root-b", status: "superseded" }),
        leaf: makeDecision("leaf", { title: "leaf", decidedAt: "2026-04-22" }),
      },
    })

    let callCount = 0
    services.facts.queryByObject = vi.fn(async (object: string) => {
      if (object === "leaf") {
        callCount++
        // Reject on first call (root A's walk), succeed on second (root B's).
        if (callCount === 1) throw new Error("transient notion")
        return []
      }
      if (object === "root-a") {
        return [
          makeFact("sup-a", {
            subject: "leaf",
            predicate: "supersedes_decision",
            object: "root-a",
            sourceMemoryId: "leaf",
          }),
        ]
      }
      if (object === "root-b") {
        return [
          makeFact("sup-b", {
            subject: "leaf",
            predicate: "supersedes_decision",
            object: "root-b",
            sourceMemoryId: "leaf",
          }),
        ]
      }
      return []
    })

    // Use per-walk invocations to exercise the eviction: if walk A's
    // rejection poisoned the cache, walk B would also reject.
    const caches = createSupersessionCaches()
    await expect(
      resolveCurrentDecisions(services, ["root-a"], { caches }),
    ).rejects.toThrow("transient notion")

    // Walk B reaches "leaf" after A's rejection evicted the slot; its own
    // `queryByObject("leaf")` call runs and returns [], so the walk
    // resolves cleanly.
    const resolved = await resolveCurrentDecisions(services, ["root-b"], { caches })
    expect(resolved.current.map((d) => d.id)).toEqual(["leaf"])
    expect(callCount).toBe(2)
  })

  it("propagates the shared rejection to concurrent in-flight awaiters (documented limitation)", async () => {
    // This is the counterpart to the sequential `does not poison sibling
    // walks` test above. It pins the *limitation* the docstring on
    // `getSuccessorIds` calls out: evict-on-reject shields sequential
    // re-entry but not concurrent awaiters that subscribed to the pending
    // promise before it rejected. Both walks awaiting the same rejected
    // `queryByObject("leaf")` will both inherit the rejection.
    //
    // If a future change bounds this further (e.g. `null`-sentinel race),
    // this test is expected to fail and the `getSuccessorIds` docstring
    // should be updated to drop the caveat.
    const services = createServices({
      decisions: {
        "root-a": makeDecision("root-a", { title: "root-a", status: "superseded" }),
        "root-b": makeDecision("root-b", { title: "root-b", status: "superseded" }),
        leaf: makeDecision("leaf", { title: "leaf", decidedAt: "2026-04-22" }),
      },
      factsByObject: {
        "root-a": [
          makeFact("sup-a", {
            subject: "leaf",
            predicate: "supersedes_decision",
            object: "root-a",
            sourceMemoryId: "leaf",
          }),
        ],
        "root-b": [
          makeFact("sup-b", {
            subject: "leaf",
            predicate: "supersedes_decision",
            object: "root-b",
            sourceMemoryId: "leaf",
          }),
        ],
      },
    })

    // Gate the `queryByObject("leaf")` promise so both walks subscribe
    // BEFORE the rejection resolves. This is the concurrent-cascade shape
    // the reviewer flagged.
    let rejectLeafQuery!: (err: Error) => void
    const leafQueryGate = new Promise<Fact[]>((_, reject) => {
      rejectLeafQuery = reject
    })
    services.facts.queryByObject = vi.fn(async (object: string) => {
      if (object === "leaf") return leafQueryGate
      if (object === "root-a")
        return [
          makeFact("sup-a", {
            subject: "leaf",
            predicate: "supersedes_decision",
            object: "root-a",
            sourceMemoryId: "leaf",
          }),
        ]
      if (object === "root-b")
        return [
          makeFact("sup-b", {
            subject: "leaf",
            predicate: "supersedes_decision",
            object: "root-b",
            sourceMemoryId: "leaf",
          }),
        ]
      return []
    })

    // Dispatch both walks concurrently. `resolveCanonicalDecisionLinks`
    // allocates its own shared `SupersessionCaches` internally — both
    // BFS walkers will reach `getSuccessorIds("leaf")` through it, with
    // walk A installing the pending promise and walk B finding it and
    // awaiting. Both are subscribed before rejection.
    const links = resolveCanonicalDecisionLinks(
      services,
      [
        makeFact("fact-a", {
          subject: "E",
          predicate: "decided_by",
          object: "root-a",
          sourceMemoryId: "root-a",
        }),
        makeFact("fact-b", {
          subject: "E",
          predicate: "decided_by",
          object: "root-b",
          sourceMemoryId: "root-b",
        }),
      ],
    )

    // Wait for both walks to reach the gated `queryByObject("leaf")` call
    // — they must both be subscribed before the rejection.
    await vi.waitFor(() => {
      const leafCalls = services.facts.queryByObject.mock.calls.filter(
        (c) => c[0] === "leaf",
      ).length
      // One dispatch; both walks await the same pending promise.
      expect(leafCalls).toBe(1)
    })

    // Under PF1-02 (this branch), `resolveCanonicalDecisionLinks`
    // returns `{ links, failures }` rather than throwing. Both walks
    // awaiting the shared rejected promise surface as failures in
    // the bucket — the documented limitation of evict-on-reject.
    rejectLeafQuery(new Error("transient notion"))
    const { failures } = await links
    // Exact pin: ONE transient `queryByObject` rejection cascades into
    // TWO failures because both root walks subscribed to the same
    // pending promise before it rejected. If a future refactor bounds
    // this further (null-sentinel race), `failures.length === 1` and
    // the test fails — the expectation should be flipped and the
    // `getSuccessorIds` docstring's caveat should be dropped in the
    // same change. `toBeGreaterThanOrEqual(1)` would have hidden the
    // regression silently.
    expect(failures.map((f) => f.rootId).sort()).toEqual(["root-a", "root-b"])
    for (const failure of failures) {
      expect((failure.error as Error).message).toBe("transient notion")
    }
  })

  it("returns partial results plus failures when one root's walk rejects", async () => {
    const services = createServices({
      decisions: {
        "ok-root": makeDecision("ok-root", { title: "ok" }),
        // "bad-root" intentionally absent; getById will throw for it.
      },
    })

    // Make queryByObject succeed for both, but leave the bad root without a
    // decision so its walk's final `getDecision(leafId)` still resolves to
    // null — which is not a rejection. We want an actual rejection: override
    // getById for the bad root only.
    const original = services.decisions.getById
    services.decisions.getById = vi.fn(async (id: string) => {
      if (id === "bad-root") throw new Error("notion down")
      return original(id)
    })
    // Throwing during getDecision won't reject the walk because of the
    // `.catch(() => null)` inside resolveCurrentDecisions. Instead reject the
    // queryByObject for that root, which is un-caught inside the walk.
    services.facts.queryByObject = vi.fn(async (object: string) => {
      if (object === "bad-root") throw new Error("notion down")
      return []
    })

    const { links, failures } = await resolveCanonicalDecisionLinks(services, [
      makeFact("fact-ok", {
        subject: "Entity",
        predicate: "decided_by",
        object: "ok-root",
        sourceMemoryId: "ok-root",
      }),
      makeFact("fact-bad", {
        subject: "Entity",
        predicate: "decided_by",
        object: "bad-root",
        sourceMemoryId: "bad-root",
      }),
    ])

    expect(links.map((link) => link.decision.id)).toEqual(["ok-root"])
    expect(failures).toHaveLength(1)
    expect(failures[0].rootId).toBe("bad-root")
    expect((failures[0].error as Error).message).toBe("notion down")
  })
})

describe("syncDecisionReachability", () => {
  it("invalidates old decided_by facts and recreates only missing links with decision IDs", async () => {
    const newDecision = makeDecision("new-id", {
      title: "New decision",
      projectIds: [],
      confidence: "likely",
    })
    const services = createServices({
      decisions: {
        "new-id": newDecision,
      },
      factsBySourceMemory: {
        "old-id": [
          makeFact("old-fact-1", {
            subject: "AuthService",
            predicate: "decided_by",
            object: "Old decision",
            sourceMemoryId: "old-id",
            projectIds: ["proj-1"],
          }),
          makeFact("old-fact-2", {
            subject: "BillingService",
            predicate: "decided_by",
            object: "Old decision",
            sourceMemoryId: "old-id",
            projectIds: ["proj-1"],
          }),
        ],
        "new-id": [
          makeFact("new-fact-1", {
            subject: "AuthService",
            predicate: "decided_by",
            object: "new-id",
            sourceMemoryId: "new-id",
            projectIds: ["proj-1"],
          }),
        ],
      },
    })

    const result = await syncDecisionReachability(services, "old-id", newDecision)

    expect(result).toEqual({ invalidated: 2, created: 1 })
    expect(services.facts.invalidate).toHaveBeenCalledTimes(2)
    expect(services.facts.create).toHaveBeenCalledWith({
      subject: "BillingService",
      predicate: "decided_by",
      object: "new-id",
      projectIds: ["proj-1"],
      sourceMemoryId: "new-id",
      confidence: "likely",
      subjectEntityId: undefined,
    })
  })

  it("carries SubjectEntity forward when retargeting (PF3-01)", async () => {
    const newDecision = makeDecision("new-id", {
      title: "New decision",
      projectIds: ["proj-1"],
      confidence: "certain",
    })
    const services = createServices({
      decisions: { "new-id": newDecision },
      factsBySourceMemory: {
        "old-id": [
          makeFact("old-fact-1", {
            subject: "MemoryService",
            predicate: "decided_by",
            object: "Old decision",
            sourceMemoryId: "old-id",
            projectIds: ["proj-1"],
            subjectEntityId: "ent-memory-service",
          }),
        ],
        "new-id": [],
      },
    })

    await syncDecisionReachability(services, "old-id", newDecision)

    expect(services.facts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "MemoryService",
        subjectEntityId: "ent-memory-service",
      }),
    )
  })

  it("dedups retargets by canonical entity even when raw subjects differ (PF3-01)", async () => {
    // Pre-PF3-01 contract: dedup keyed on raw `fact.subject`. Two
    // facts with cosmetic-variant subjects ("MemoryService" vs
    // "memoryservice") for the same entity would create two retarget
    // rows. After PF3-01, both share `subjectEntityId` so the second
    // hits the existing-keys set and is skipped.
    const newDecision = makeDecision("new-id", {
      title: "New decision",
      projectIds: ["proj-1"],
      confidence: "certain",
    })
    const services = createServices({
      decisions: { "new-id": newDecision },
      factsBySourceMemory: {
        "old-id": [
          makeFact("old-1", {
            subject: "MemoryService",
            predicate: "decided_by",
            object: "Old",
            sourceMemoryId: "old-id",
            projectIds: ["proj-1"],
            subjectEntityId: "ent-ms",
          }),
          makeFact("old-2", {
            subject: "memoryservice",
            predicate: "decided_by",
            object: "Old",
            sourceMemoryId: "old-id",
            projectIds: ["proj-1"],
            subjectEntityId: "ent-ms",
          }),
        ],
        "new-id": [],
      },
    })

    const result = await syncDecisionReachability(services, "old-id", newDecision)

    // Both old facts invalidated, but only ONE retarget created — the
    // second was deduped via `factSubjectKey` (entity:ent-ms).
    expect(result).toEqual({ invalidated: 2, created: 1 })
    expect(services.facts.create).toHaveBeenCalledTimes(1)
  })
})
