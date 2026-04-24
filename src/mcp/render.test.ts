import { describe, expect, it, vi } from "vitest"
import {
  displayId,
  displayValue,
  factClass,
  groupFactsByClass,
  isUuid,
  renderFact,
  resolveReferencedTitles,
  resolveTitles,
} from "./render.js"
import type { Fact, FactConfidence, FactPredicate } from "../types.js"

const DECISION_A = "349b35e6-e67f-8185-bec0-d3902135c5ba"
const DECISION_B = "449b35e6-e67f-8185-bec0-d3902135c5bb"
const MEMORY_A = "549b35e6-e67f-8185-bec0-d3902135c5bc"
const MISSING_ID = "649b35e6-e67f-8185-bec0-d3902135c5bd"

function makeFact(
  id: string,
  overrides: Partial<Fact> & { predicate?: FactPredicate; confidence?: FactConfidence } = {},
): Fact {
  return {
    id,
    subject: "Entity",
    predicate: overrides.predicate ?? "decided_by",
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

function createResolvers(titles: Record<string, string> = {}) {
  const getTitleById = vi.fn(async (id: string) => titles[id.toLowerCase()] ?? null)
  return {
    resolvers: { memories: { getTitleById } },
    getTitleById,
  }
}

describe("isUuid", () => {
  it("matches canonical 8-4-4-4-12 hex UUIDs case-insensitively", () => {
    expect(isUuid(DECISION_A)).toBe(true)
    expect(isUuid(DECISION_A.toUpperCase())).toBe(true)
  })

  it("rejects plain strings and near-misses", () => {
    expect(isUuid("AuthService")).toBe(false)
    expect(isUuid("lore-update")).toBe(false)
    expect(isUuid("349b35e6e67f8185bec0d3902135c5ba")).toBe(false) // no dashes
    expect(isUuid(`prefix ${DECISION_A}`)).toBe(false)
    expect(isUuid("")).toBe(false)
    expect(isUuid(null)).toBe(false)
    expect(isUuid(undefined)).toBe(false)
  })
})

describe("resolveTitles", () => {
  it("dedupes and normalizes IDs so each unique page is fetched once", async () => {
    const { resolvers, getTitleById } = createResolvers({
      [DECISION_A]: "Prefer MCP over bespoke APIs",
      [DECISION_B]: "Adopt Zod for input validation",
    })

    const ids = [
      DECISION_A,
      DECISION_A.toUpperCase(),
      DECISION_A,
      DECISION_B,
      "",
    ]

    const map = await resolveTitles(ids, (id) => resolvers.memories.getTitleById(id))

    expect(map.get(DECISION_A)).toBe("Prefer MCP over bespoke APIs")
    expect(map.get(DECISION_B)).toBe("Adopt Zod for input validation")
    expect(getTitleById).toHaveBeenCalledTimes(2)
  })

  it("drops IDs whose loader returned null so callers fall back via displayId", async () => {
    const { resolvers } = createResolvers({})
    const map = await resolveTitles([MISSING_ID], (id) =>
      resolvers.memories.getTitleById(id),
    )
    expect(map.has(MISSING_ID)).toBe(false)
  })

  it("makes zero calls on an empty / whitespace input list", async () => {
    const { resolvers, getTitleById } = createResolvers({})
    const map = await resolveTitles([], (id) => resolvers.memories.getTitleById(id))
    expect(map.size).toBe(0)
    expect(getTitleById).not.toHaveBeenCalled()
  })
})

describe("resolveReferencedTitles — API call budget", () => {
  it("fans out exactly once per unique UUID, regardless of reuse across facts", async () => {
    const { resolvers, getTitleById } = createResolvers({
      [DECISION_A]: "Prefer MCP over bespoke APIs",
      [DECISION_B]: "Adopt Zod for input validation",
    })

    const facts = [
      makeFact("f1", { subject: "computeRelationConfigDiff", object: DECISION_A }),
      makeFact("f2", { subject: "lore-update", object: DECISION_A }),
      makeFact("f3", { subject: "lore-remember", object: DECISION_A }),
      makeFact("f4", { subject: "lore-ask", object: DECISION_B }),
    ]

    const map = await resolveReferencedTitles(facts, resolvers)

    // Pins the perf contract: 4 facts, 2 distinct UUIDs → 2 Notion calls.
    expect(getTitleById).toHaveBeenCalledTimes(2)
    expect(map.get(DECISION_A)).toBe("Prefer MCP over bespoke APIs")
    expect(map.get(DECISION_B)).toBe("Adopt Zod for input validation")
  })

  it("resolves UUID subjects as well as UUID objects", async () => {
    const { resolvers, getTitleById } = createResolvers({
      [DECISION_A]: "New canonical decision",
      [DECISION_B]: "Older decision",
    })

    const facts = [
      makeFact("f1", {
        subject: DECISION_A,
        predicate: "supersedes_decision",
        object: DECISION_B,
      }),
    ]

    const map = await resolveReferencedTitles(facts, resolvers)

    expect(map.get(DECISION_A)).toBe("New canonical decision")
    expect(map.get(DECISION_B)).toBe("Older decision")
    expect(getTitleById).toHaveBeenCalledTimes(2)
  })

  it("works uniformly for decision and memory references (same backing DB)", async () => {
    const { resolvers } = createResolvers({ [MEMORY_A]: "Plain memory title" })

    const facts = [
      makeFact("f1", { subject: "AuthService", object: MEMORY_A, predicate: "related_to" }),
    ]

    const map = await resolveReferencedTitles(facts, resolvers)

    expect(map.get(MEMORY_A)).toBe("Plain memory title")
  })

  it("skips the network entirely when no facts reference a UUID", async () => {
    const { resolvers, getTitleById } = createResolvers({})
    const facts = [makeFact("f1", { subject: "AuthService", object: "JWT" })]

    const map = await resolveReferencedTitles(facts, resolvers)

    expect(map.size).toBe(0)
    expect(getTitleById).not.toHaveBeenCalled()
  })
})

describe("renderFact", () => {
  it("substitutes resolved titles in both subject and object positions", () => {
    const titleMap = new Map<string, string>([
      [DECISION_A, "New decision"],
      [DECISION_B, "Old decision"],
    ])

    const line = renderFact(
      makeFact("f1", {
        subject: DECISION_A,
        predicate: "supersedes_decision",
        object: DECISION_B,
      }),
      { titleMap },
    )

    expect(line).toBe("- **New decision** supersedes decision **Old decision**")
  })

  it("resolves uppercase references through a lowercase-keyed title map", () => {
    const titleMap = new Map<string, string>([[DECISION_A, "Resolved title"]])

    const line = renderFact(
      makeFact("f1", {
        subject: "lore-update",
        predicate: "decided_by",
        object: DECISION_A.toUpperCase(),
      }),
      { titleMap },
    )

    expect(line).toBe("- **lore-update** decided by **Resolved title**")
  })

  it("falls back to a truncated `(?)` hint when resolution misses", () => {
    const titleMap = new Map<string, string>()

    const line = renderFact(
      makeFact("f1", {
        subject: "lore-update",
        predicate: "decided_by",
        object: DECISION_A,
      }),
      { titleMap },
    )

    // Only the last 8 hex chars survive — full UUIDs are visual noise.
    expect(line).toBe(`- **lore-update** decided by **…${DECISION_A.slice(-8)} (?)**`)
  })

  it("renders plain strings verbatim and appends the trailing segment", () => {
    const titleMap = new Map<string, string>()

    const line = renderFact(
      makeFact("f1", { subject: "AuthService", predicate: "uses", object: "JWT" }),
      { titleMap, trailing: "(certain)" },
    )

    expect(line).toBe("- **AuthService** uses **JWT** (certain)")
  })
})

describe("renderFact prefix option", () => {
  it("inserts the prefix between the bullet and **Subject**", () => {
    // P2-06 uses the prefix slot to surface a `⚠ ` marker on overdue
    // tracking rows without forking the triple renderer. Pins the exact
    // placement so a future refactor can't silently shift the marker.
    const titleMap = new Map<string, string>()
    const line = renderFact(
      makeFact("f1", { subject: "AuthService", predicate: "needs_action", object: "JWT" }),
      { titleMap, prefix: "⚠ ", trailing: "[certain]" },
    )
    expect(line).toBe("- ⚠ **AuthService** needs action **JWT** [certain]")
  })

  it("emits the same output as omitting prefix when prefix is empty", () => {
    const titleMap = new Map<string, string>()
    const withEmpty = renderFact(
      makeFact("f1", { subject: "A", predicate: "uses", object: "B" }),
      { titleMap, prefix: "" },
    )
    const withoutPrefix = renderFact(
      makeFact("f1", { subject: "A", predicate: "uses", object: "B" }),
      { titleMap },
    )
    expect(withEmpty).toBe(withoutPrefix)
  })
})

describe("factClass", () => {
  it("maps decision-graph predicates to governance", () => {
    expect(factClass("decided_by")).toBe("governance")
    expect(factClass("supersedes_decision")).toBe("governance")
  })

  it("maps tracking predicates to tracking", () => {
    expect(factClass("needs_action")).toBe("tracking")
    expect(factClass("waiting_on")).toBe("tracking")
    expect(factClass("blocked_by")).toBe("tracking")
  })

  it("defaults unrecognized or structural predicates to structure", () => {
    // All listed-in-spec structural predicates.
    expect(factClass("is_a")).toBe("structure")
    expect(factClass("has_a")).toBe("structure")
    expect(factClass("uses")).toBe("structure")
    expect(factClass("depends_on")).toBe("structure")
    expect(factClass("replaces")).toBe("structure")
    expect(factClass("extends")).toBe("structure")
    expect(factClass("conflicts_with")).toBe("structure")
    expect(factClass("created_by")).toBe("structure")
    expect(factClass("owned_by")).toBe("structure")
    expect(factClass("related_to")).toBe("structure")
    // `informs` is a decision-graph predicate but isn't explicitly listed
    // in the spec's Governance set; the default-to-structure rule keeps
    // it visible rather than silently dropped from the output.
    expect(factClass("informs")).toBe("structure")
  })
})

describe("groupFactsByClass", () => {
  it("splits facts into three buckets and keeps input order on validFrom ties", () => {
    // Same validFrom across all three → sort is stable; bucket assignment
    // is what's being pinned here.
    const facts: Fact[] = [
      makeFact("s1", { predicate: "uses", validFrom: "2026-04-20" }),
      makeFact("t1", { predicate: "needs_action", validFrom: "2026-04-20" }),
      makeFact("g1", { predicate: "decided_by", validFrom: "2026-04-20" }),
      makeFact("s2", { predicate: "depends_on", validFrom: "2026-04-20" }),
    ]
    const groups = groupFactsByClass(facts)
    expect(groups.governance.map((f) => f.id)).toEqual(["g1"])
    expect(groups.structure.map((f) => f.id)).toEqual(["s1", "s2"])
    expect(groups.tracking.map((f) => f.id)).toEqual(["t1"])
  })

  it("sorts each bucket most-recent-first by validFrom and sinks nulls to the end", () => {
    const facts: Fact[] = [
      makeFact("older", { predicate: "uses", validFrom: "2026-03-01" }),
      makeFact("newer", { predicate: "uses", validFrom: "2026-04-20" }),
      makeFact("missing", { predicate: "uses", validFrom: null }),
      makeFact("middle", { predicate: "uses", validFrom: "2026-04-01" }),
    ]
    const groups = groupFactsByClass(facts)
    expect(groups.structure.map((f) => f.id)).toEqual([
      "newer",
      "middle",
      "older",
      "missing",
    ])
  })

  it("returns empty arrays for buckets with no matching predicate", () => {
    const facts = [makeFact("s1", { predicate: "uses" })]
    const groups = groupFactsByClass(facts)
    expect(groups.governance).toEqual([])
    expect(groups.tracking).toEqual([])
    expect(groups.structure).toHaveLength(1)
  })
})

describe("displayValue / displayId", () => {
  it("returns plain text unchanged", () => {
    const titleMap = new Map<string, string>()
    expect(displayValue("AuthService", titleMap)).toBe("AuthService")
  })

  it("returns the title when known and a truncated hint otherwise", () => {
    const titleMap = new Map<string, string>([[DECISION_A, "Resolved title"]])
    expect(displayId(DECISION_A, titleMap)).toBe("Resolved title")
    expect(displayId(MISSING_ID, titleMap)).toBe(`…${MISSING_ID.slice(-8)} (?)`)
  })

  it("treats non-UUID strings as unresolved verbatim in the hint path", () => {
    const titleMap = new Map<string, string>()
    // `displayId` is sometimes called on values that happen to not be
    // UUIDs (e.g., legacy data) — the hint should degrade gracefully,
    // not lie about having truncated a UUID.
    expect(displayId("not-a-uuid", titleMap)).toBe("not-a-uuid (?)")
  })
})
