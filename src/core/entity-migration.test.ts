import { describe, expect, it } from "vitest"
import type { Entity, Fact } from "../types.js"
import {
  groupObservationsByKey,
  indexEntitiesByKey,
  pickCanonical,
  planEntityMigration,
} from "./entity-migration.js"

function makeFact(overrides: Partial<Fact>): Fact {
  return {
    id: overrides.id ?? "f-" + Math.random().toString(36).slice(2),
    subject: "MemoryService",
    predicate: "uses",
    object: "DataSourceQuery",
    projectIds: [],
    validFrom: "2026-04-20",
    validUntil: null,
    reviewBy: null,
    sourceMemoryId: null,
    confidence: "certain",
    createdAt: "2026-01-01T00:00:00.000Z",
    subjectEntityId: null,
    objectEntityId: null,
    ...overrides,
  }
}

function makeEntity(overrides: Partial<Entity>): Entity {
  return {
    id: overrides.id ?? "ent-" + Math.random().toString(36).slice(2),
    name: overrides.name ?? "MemoryService",
    aliases: overrides.aliases ?? [],
    kind: overrides.kind ?? null,
    description: overrides.description ?? "",
    projectIds: overrides.projectIds ?? [],
  }
}

describe("pickCanonical", () => {
  it("picks the longest raw form", () => {
    expect(
      pickCanonical(["MemoryService", "MemoryService.create", "memoryservice"]),
    ).toBe("MemoryService.create")
  })

  it("breaks ties on equal length lexicographically (ascending)", () => {
    // "abc" and "abd" are both length 3 — `abc` wins as the
    // lexicographically smaller string.
    expect(pickCanonical(["abd", "abc"])).toBe("abc")
  })

  it("returns empty string for empty input", () => {
    expect(pickCanonical([])).toBe("")
  })
})

describe("groupObservationsByKey", () => {
  it("collapses case variants into one group", () => {
    const groups = groupObservationsByKey([
      { raw: "MemoryService", factId: "f1", side: "subject" },
      { raw: "memoryservice", factId: "f2", side: "object" },
      { raw: "MEMORYSERVICE ", factId: "f3", side: "subject" },
    ])

    expect(groups.size).toBe(1)
    const only = Array.from(groups.values())[0]
    expect(only.rawForms.size).toBe(3)
    expect(only.factIds).toHaveLength(3)
  })

  it("drops whitespace-only observations rather than collapsing them", () => {
    // `"."` and `"   "` both normalize to `""`. Without the filter,
    // every fact would join one degenerate "everything" entity.
    const groups = groupObservationsByKey([
      { raw: ".", factId: "f1", side: "subject" },
      { raw: "   ", factId: "f2", side: "subject" },
      { raw: "Real", factId: "f3", side: "subject" },
    ])

    expect(groups.size).toBe(1)
    expect(Array.from(groups.keys())).toEqual(["real"])
  })
})

describe("planEntityMigration", () => {
  it("produces canonical-with-aliases plans grouped by normalized key", () => {
    const facts: Fact[] = [
      makeFact({ id: "f1", subject: "MemoryService", object: "DataSource" }),
      makeFact({ id: "f2", subject: "memoryservice", object: "datasource" }),
      makeFact({ id: "f3", subject: "MEMORYSERVICE", object: "DataSource" }),
    ]

    const plans = planEntityMigration(facts, indexEntitiesByKey([]))
    // Two groups: memoryservice (3 raw forms) and datasource (2).
    expect(plans).toHaveLength(2)
    const memoryService = plans.find((p) => p.key === "memoryservice")!
    // Tie-break on equal length is lex ascending; "MEMORYSERVICE" wins
    // over "MemoryService" because uppercase letters precede lowercase
    // in ASCII (`M` < `e`). Locking the contract here so a future
    // change to `pickCanonical` is observable.
    expect(memoryService.canonical).toBe("MEMORYSERVICE")
    expect(memoryService.aliases).toEqual(["MemoryService", "memoryservice"])
  })

  it("collapses richer-handle variants into the same group as the bare form", () => {
    const facts: Fact[] = [
      makeFact({ id: "f1", subject: "MemoryService.create", object: "X" }),
      makeFact({ id: "f2", subject: "memoryservice.CREATE", object: "X" }),
    ]
    const plans = planEntityMigration(facts, indexEntitiesByKey([]))
    const richer = plans.find((p) => p.key === "memoryservice.create")!
    expect(richer.canonical).toBe("MemoryService.create")
    expect(richer.aliases).toEqual(["memoryservice.CREATE"])
  })

  it("sorts plans by fact-count desc so the largest collapse renders first", () => {
    const facts: Fact[] = [
      // Group A — 3 facts referencing Foo
      ...Array.from({ length: 3 }, (_, i) =>
        makeFact({ id: `a-${i}`, subject: "Foo", object: "Bar" }),
      ),
      // Group B — 1 fact referencing Baz / Qux
      makeFact({ id: "b-0", subject: "Baz", object: "Qux" }),
    ]

    const plans = planEntityMigration(facts, indexEntitiesByKey([]))
    // Foo (3) and Bar (3) tie at top; Baz (1) and Qux (1) follow.
    const factCounts = plans.map((p) => p.factCount)
    expect(factCounts[0]).toBeGreaterThanOrEqual(factCounts[factCounts.length - 1])
    expect(plans[plans.length - 1].factCount).toBe(1)
  })

  it("flags an existing entity row when the key already has one", () => {
    const facts: Fact[] = [
      makeFact({ id: "f1", subject: "MemoryService", object: "X" }),
    ]
    const existing = makeEntity({ id: "ent-1", name: "MemoryService" })
    const plans = planEntityMigration(facts, indexEntitiesByKey([existing]))
    const memoryServicePlan = plans.find((p) => p.key === "memoryservice")!
    expect(memoryServicePlan.existing?.id).toBe("ent-1")
  })

  it("matches an existing entity by alias as well as canonical name", () => {
    const facts: Fact[] = [
      makeFact({ id: "f1", subject: "memoryservice", object: "X" }),
    ]
    const existing = makeEntity({
      id: "ent-1",
      name: "MS",
      aliases: ["MemoryService"],
    })
    const plans = planEntityMigration(facts, indexEntitiesByKey([existing]))
    expect(plans.find((p) => p.key === "memoryservice")?.existing?.id).toBe("ent-1")
  })

  it("re-running on a post-migration vault is a near-no-op (idempotency pin)", () => {
    // Simulate the post-apply state: the canonical row exists, all
    // raw forms are already aliases on it. A second `planEntityMigration`
    // pass against the same fact set should flag every group as
    // `existing` (no creates) and propose no new aliases (the existing
    // row already covers every observed form).
    const facts: Fact[] = [
      makeFact({ id: "f1", subject: "MemoryService", object: "X" }),
      makeFact({ id: "f2", subject: "memoryservice", object: "X" }),
    ]
    const existing = makeEntity({
      id: "ent-1",
      name: "MemoryService",
      aliases: ["memoryservice"],
    })
    const plans = planEntityMigration(facts, indexEntitiesByKey([existing]))
    const memoryServicePlan = plans.find((p) => p.key === "memoryservice")!
    expect(memoryServicePlan.existing?.id).toBe("ent-1")
    // Every raw form normalizes to a key the existing entity already
    // covers — the `existing` flag is set so the apply phase will go
    // through `addAliases` (which post-filters to truly-new aliases)
    // rather than `create`.
    expect(memoryServicePlan.canonical).toBe("MemoryService")
  })
})
