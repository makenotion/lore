import { describe, expect, it } from "vitest"
import type { Entity, Fact } from "../types.js"
import type { SqlSubjectGroupCount } from "../notion/runtool/query.js"
import {
  computeOrphanRateFromAggregateRows,
  computeOrphanRateFromFacts,
  foldOrphanRateGroups,
  groupObservationsByKey,
  indexEntitiesByKey,
  orphanMetricKey,
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
      pickCanonical(["MemoryService", "MemoryService.create", "memoryservice"])
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
        makeFact({ id: `a-${i}`, subject: "Foo", object: "Bar" })
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
    const facts: Fact[] = [makeFact({ id: "f1", subject: "MemoryService", object: "X" })]
    const existing = makeEntity({ id: "ent-1", name: "MemoryService" })
    const plans = planEntityMigration(facts, indexEntitiesByKey([existing]))
    const memoryServicePlan = plans.find((p) => p.key === "memoryservice")!
    expect(memoryServicePlan.existing?.id).toBe("ent-1")
  })

  it("matches an existing entity by alias as well as canonical name", () => {
    const facts: Fact[] = [makeFact({ id: "f1", subject: "memoryservice", object: "X" })]
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

describe("orphanMetricKey", () => {
  it("prefers populated subjectEntityId over computed key", () => {
    expect(orphanMetricKey("ent-abc-1234", "MemoryService")).toBe("entity:ent-abc-1234")
  })

  it("falls back to computeSubjectKey when subjectEntityId is null", () => {
    // `MemoryService` and `memoryservice` normalize to the same
    // case-folded key — both un-migrated rows must collapse onto
    // one canonical key in the metric.
    const a = orphanMetricKey(null, "MemoryService")
    const b = orphanMetricKey(null, "memoryservice")
    expect(a).toBe(b)
    expect(a.startsWith("key:")).toBe(true)
  })

  it("returns empty string for whitespace-only subject with no entity id", () => {
    expect(orphanMetricKey(null, "   ")).toBe("")
    expect(orphanMetricKey(null, "")).toBe("")
  })

  it("guards entity:/key: namespaces against accidental collisions", () => {
    // An entity id and a `computeSubjectKey` output cannot share a
    // namespace because the helper prefixes them.
    expect(orphanMetricKey("foo", "")).toBe("entity:foo")
    expect(orphanMetricKey(null, "foo")).toBe("key:foo")
  })
})

describe("foldOrphanRateGroups", () => {
  it("returns zero rate on an empty corpus", () => {
    const report = foldOrphanRateGroups([])
    expect(report).toEqual({
      orphanRate: 0,
      totalGroups: 0,
      groupsWithPeer: 0,
      totalFacts: 0,
    })
  })

  it("collapses case-variant rows onto one canonical key", () => {
    // Two un-migrated rows whose Subjects differ only in case —
    // expected: 1 group, 1 group-with-peer, orphan rate 0.
    const report = foldOrphanRateGroups([
      { subjectEntityId: null, subject: "MemoryService", count: 1 },
      { subjectEntityId: null, subject: "memoryservice", count: 1 },
    ])
    expect(report.totalGroups).toBe(1)
    expect(report.groupsWithPeer).toBe(1)
    expect(report.totalFacts).toBe(2)
    expect(report.orphanRate).toBe(0)
  })

  it("computes the documented PF3-01 spec example", () => {
    // Pre-PF3-01 baseline on an internal vault: 560 facts → ~445
    // distinct subjects → ~89 had a peer. Spec metric: 1 - (89 /
    // 445) ≈ 0.7999. Build a synthetic distribution with the same
    // shape: 89 keys with two facts each (= 178 facts) + 356 keys
    // with one fact each (= 356 facts) = 534 facts across 445 groups.
    // Verifies the shape, not the exact baseline number.
    const rows: Array<{
      subjectEntityId: string | null
      subject: string
      count: number
    }> = []
    for (let i = 0; i < 89; i++) {
      rows.push({ subjectEntityId: null, subject: `paired-${i}`, count: 2 })
    }
    for (let i = 0; i < 356; i++) {
      rows.push({ subjectEntityId: null, subject: `unique-${i}`, count: 1 })
    }
    const report = foldOrphanRateGroups(rows)
    expect(report.totalGroups).toBe(445)
    expect(report.groupsWithPeer).toBe(89)
    expect(report.totalFacts).toBe(89 * 2 + 356)
    expect(report.orphanRate).toBeCloseTo(1 - 89 / 445, 4)
  })

  it("drops degenerate empty-key rows (no entity, no canonical subject)", () => {
    const report = foldOrphanRateGroups([
      { subjectEntityId: null, subject: "   ", count: 5 },
      { subjectEntityId: null, subject: "MemoryService", count: 1 },
    ])
    expect(report.totalGroups).toBe(1)
    expect(report.totalFacts).toBe(1)
  })
})

describe("computeOrphanRateFromFacts vs computeOrphanRateFromAggregateRows", () => {
  // Issue #542 acceptance criterion: "Both paths produce identical
  // orphan-rate metrics on fixture coverage that includes:
  //   - populated SubjectEntity
  //   - empty SubjectEntity
  //   - repeated subjects
  //   - one-off subjects
  //   - invalidated facts (excluded by the SQL WHERE clause; the JS
  //     path is given a list that already excludes invalidated facts)
  //   - project-scoped/unscoped rows
  //
  // Build one fact corpus and one equivalent aggregate-row corpus,
  // assert numeric equivalence at every field of the report.
  it("produces identical reports on a representative corpus", () => {
    const ent1 = "11111111-1111-1111-1111-111111111111"
    const ent2 = "22222222-2222-2222-2222-222222222222"
    const ent2Undashed = "22222222222222222222222222222222"

    const facts: Fact[] = [
      // Populated SubjectEntity, repeated (3 facts on one entity)
      makeFact({ id: "f1", subject: "MemoryService.create", subjectEntityId: ent1 }),
      makeFact({ id: "f2", subject: "MemoryService.create", subjectEntityId: ent1 }),
      makeFact({ id: "f3", subject: "MemoryService.create", subjectEntityId: ent1 }),
      // Populated SubjectEntity, one-off
      makeFact({ id: "f4", subject: "Foo", subjectEntityId: ent2 }),
      // Empty SubjectEntity, case-variants on the same canonical key
      makeFact({ id: "f5", subject: "DataSourceQuery", subjectEntityId: null }),
      makeFact({ id: "f6", subject: "datasourcequery", subjectEntityId: null }),
      // Empty SubjectEntity, one-off
      makeFact({ id: "f7", subject: "Solo", subjectEntityId: null }),
    ]
    const jsReport = computeOrphanRateFromFacts(facts)

    // Equivalent aggregate rows — what the SQL gateway would return
    // after `GROUP BY SubjectEntity, Subject`. The gateway returns
    // relation values as JSON-stringified arrays of full URLs
    // containing the undashed page id; the JS pre-grouping (case
    // variants) does NOT happen server-side, so emit case-variant
    // rows separately.
    const aggregateRows: SqlSubjectGroupCount[] = [
      {
        subjectEntityRaw: `["https://www.notion.so/${"11111111111111111111111111111111"}"]`,
        subject: "MemoryService.create",
        count: 3,
      },
      {
        subjectEntityRaw: `["https://www.notion.so/${ent2Undashed}"]`,
        subject: "Foo",
        count: 1,
      },
      { subjectEntityRaw: null, subject: "DataSourceQuery", count: 1 },
      { subjectEntityRaw: "[]", subject: "datasourcequery", count: 1 },
      { subjectEntityRaw: "", subject: "Solo", count: 1 },
    ]
    const sqlReport = computeOrphanRateFromAggregateRows(aggregateRows)

    expect(sqlReport).toEqual(jsReport)
    // Sanity-check the absolute numbers so the test catches a
    // shared-bug case where both paths drift in lockstep:
    //   - 4 distinct groups: ent1, ent2, key:datasourcequery, key:solo
    //   - 2 with peers (ent1 has 3 facts, key:datasourcequery has 2)
    //   - orphanRate = 1 - 2/4 = 0.5
    expect(jsReport).toEqual({
      orphanRate: 0.5,
      totalGroups: 4,
      groupsWithPeer: 2,
      totalFacts: 7,
    })
  })

  it("counts invalidated facts identically across both paths", () => {
    // Notion's SQL gateway does not expose date columns
    // (verified 2026-05-06 against the dogfood vault: every
    // spelling of `Valid Until` returns `no such column`), so the
    // SQL aggregate path counts every row regardless of
    // invalidation. The migrate-time call site keeps the JS
    // fallback semantically equivalent by passing
    // `includeInvalidated: true` to `queryBySubject`. Both helpers
    // consume the resulting list and produce the same metric —
    // pinned here so a future "let's filter invalidated in JS but
    // not SQL" refactor fails loudly.
    const facts: Fact[] = [
      makeFact({ id: "live-1", subject: "MemoryService", validUntil: null }),
      makeFact({ id: "invalidated", subject: "MemoryService", validUntil: "2026-04-30" }),
      makeFact({ id: "live-2", subject: "OtherSubject", validUntil: null }),
    ]
    const jsReport = computeOrphanRateFromFacts(facts)
    const sqlReport = computeOrphanRateFromAggregateRows([
      { subjectEntityRaw: null, subject: "MemoryService", count: 2 },
      { subjectEntityRaw: null, subject: "OtherSubject", count: 1 },
    ])
    expect(jsReport).toEqual(sqlReport)
    expect(jsReport.totalFacts).toBe(3)
    expect(jsReport.totalGroups).toBe(2)
    expect(jsReport.groupsWithPeer).toBe(1)
    expect(jsReport.orphanRate).toBe(0.5)
  })
})
