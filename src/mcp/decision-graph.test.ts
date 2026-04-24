import { describe, expect, it, vi } from "vitest"
import {
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

    const links = await resolveCanonicalDecisionLinks(services, [
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

    expect(links).toHaveLength(1)
    expect(links[0].fact.subject).toBe("AuthService")
    expect(links[0].decision.id).toBe("new-id")
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

    const links = await linksPromise
    expect(links.map((link) => link.decision.id).sort()).toEqual([...roots].sort())
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
    })
  })
})
