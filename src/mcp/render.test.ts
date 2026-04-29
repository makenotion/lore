import { describe, expect, it, vi } from "vitest"
import {
  collapseOverlappingMemories,
  defaultMemoryMetaBuilder,
  displayId,
  displayValue,
  factClass,
  formatMemoryListItem,
  groupFactsByClass,
  isUuid,
  renderFact,
  resolveReferencedTitles,
  resolveTitles,
} from "./render.js"
import type {
  Fact,
  FactConfidence,
  FactPredicate,
  Memory,
  MemorySource,
} from "../types.js"
import { SYNOPSIS_MAX } from "../types.js"

function buildMemory(overrides: Partial<Memory> & { id: string; title: string }): Memory {
  return {
    projectIds: [],
    topicId: null,
    source: "manual" satisfies MemorySource,
    kind: "note",
    status: "informational",
    confidence: "certain",
    reviewBy: null,
    doneAt: null,
    decidedAt: null,
    supersedesIds: [],
    affectsIds: [],
    alternatives: "",
    consequences: "",
    author: "",
    agent: "",
    tags: [],
    keywords: "",
    synopsis: "",
    session: "",
    content: "",
    taskState: null,
    blockedBy: "",
    entity: "",
    createdAt: "2026-04-20T00:00:00Z",
    updatedAt: "2026-04-20T00:00:00Z",
    ...overrides,
  }
}

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
    subjectEntityId: null,
    objectEntityId: null,
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
    // The prefix slot lets callers add a marker (e.g. urgency indicator)
    // without forking the triple renderer. Pins the exact placement so a
    // future refactor can't silently shift the marker.
    const titleMap = new Map<string, string>()
    const line = renderFact(
      makeFact("f1", { subject: "AuthService", predicate: "uses", object: "JWT" }),
      { titleMap, prefix: "⚠ ", trailing: "[certain]" },
    )
    expect(line).toBe("- ⚠ **AuthService** uses **JWT** [certain]")
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
  it("splits facts into governance and structure buckets and keeps input order on validFrom ties", () => {
    // Same validFrom across all → sort is stable; bucket assignment
    // is what's being pinned here.
    const facts: Fact[] = [
      makeFact("s1", { predicate: "uses", validFrom: "2026-04-20" }),
      makeFact("g1", { predicate: "decided_by", validFrom: "2026-04-20" }),
      makeFact("s2", { predicate: "depends_on", validFrom: "2026-04-20" }),
    ]
    const groups = groupFactsByClass(facts)
    expect(groups.governance.map((f) => f.id)).toEqual(["g1"])
    expect(groups.structure.map((f) => f.id)).toEqual(["s1", "s2"])
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

describe("collapseOverlappingMemories", () => {
  it("collapses near-duplicate titles onto the first-seen memory", () => {
    // The Mail-vault example from P2-01: three wake-up debugging sessions
    // that share a title prefix collapse into one representative. Tag
    // overlap drives collapse here — the sessions share `hooks, wakeup,
    // debugging`, which is a 3-of-3 overlap against each other's tag set.
    const tags = ["hooks", "wakeup", "debugging"]
    const memories = [
      buildMemory({
        id: "3a85",
        title: "Wakeup silent-failure root cause — missing LORE_NOTION_TOKEN",
        tags,
      }),
      buildMemory({
        id: "2c1f",
        title: "Wakeup silent-failure debugging notes",
        tags,
      }),
      buildMemory({
        id: "1a77",
        title: "Wakeup silent failure — followup on token resolution",
        tags,
      }),
    ]

    const groups = collapseOverlappingMemories(memories)

    expect(groups).toHaveLength(1)
    expect(groups[0].keep.id).toBe("3a85")
    expect(groups[0].collapsedIds).toEqual(["2c1f", "1a77"])
  })

  it("keeps unrelated memories as their own groups (no over-collapse)", () => {
    const memories = [
      buildMemory({ id: "a", title: "OAuth callback returns 400 on Safari" }),
      buildMemory({ id: "b", title: "Notion rate-limiter backoff strategy" }),
      buildMemory({ id: "c", title: "Weekly project digest — 2026-04-17" }),
    ]

    const groups = collapseOverlappingMemories(memories)

    expect(groups).toHaveLength(3)
    expect(groups.every((g) => g.collapsedIds.length === 0)).toBe(true)
  })

  it("collapses by tag-set overlap even when titles diverge", () => {
    // Agents often retitle sessions ("part 1" / "followup") but keep the
    // tag set stable. Szymkiewicz-Simpson overlap catches this because the
    // smaller set is entirely covered by the larger.
    const memories = [
      buildMemory({
        id: "a",
        title: "Completely unrelated phrasing here",
        tags: ["hooks", "wakeup"],
      }),
      buildMemory({
        id: "b",
        title: "Entirely different wording entirely",
        tags: ["hooks", "wakeup", "debugging"],
      }),
    ]

    const groups = collapseOverlappingMemories(memories)

    expect(groups).toHaveLength(1)
    expect(groups[0].keep.id).toBe("a")
    expect(groups[0].collapsedIds).toEqual(["b"])
  })

  it("preserves input order when nothing collapses", () => {
    const memories = [
      buildMemory({ id: "newest", title: "Alpha feature rollout" }),
      buildMemory({ id: "mid", title: "Bravo ingest pipeline hardening" }),
      buildMemory({ id: "oldest", title: "Charlie telemetry dashboards" }),
    ]

    const groups = collapseOverlappingMemories(memories)

    expect(groups.map((g) => g.keep.id)).toEqual(["newest", "mid", "oldest"])
  })

  it("short title tokens and empty tag sets do not force spurious matches", () => {
    // Tokens below the 3-character floor are dropped as too noisy — so
    // two titles that only overlap on "a", "an", "of" should normalize
    // to empty token sets and not match. With no tags on either side,
    // the memories must stay as independent groups.
    const memories = [
      buildMemory({ id: "a", title: "a an of", tags: [] }),
      buildMemory({ id: "b", title: "a an of", tags: [] }),
    ]

    const groups = collapseOverlappingMemories(memories)

    expect(groups).toHaveLength(2)
  })

  it("ignores tag overlap when one side has zero tags", () => {
    // A memory with no tags should not pseudo-match anything through tag
    // overlap — overlap coefficient over an empty set is undefined, and the
    // caller expects "err toward showing" when tag signal is absent.
    const memories = [
      buildMemory({ id: "a", title: "quarterly strategy memo", tags: [] }),
      buildMemory({ id: "b", title: "incident postmortem", tags: ["infra"] }),
    ]

    const groups = collapseOverlappingMemories(memories)
    expect(groups).toHaveLength(2)
  })
})

describe("formatMemoryListItem — four-cell matrix", () => {
  // Pins the body × synopsis matrix from issue 0.7.0/03 verbatim. The
  // pre-#03 paths (no synopsis) must remain byte-identical so callers
  // who pass `includeSynopsis: false` truly restore prior output.
  const baseMemory = buildMemory({
    id: "mem-1",
    title: "OAuth handshake notes",
    source: "manual",
    tags: ["auth"],
    updatedAt: "2026-04-20T00:00:00.000Z",
  })
  const synopsisMemory = buildMemory({
    ...baseMemory,
    synopsis: "Outlook callbacks fail because the redirect URI is not allow-listed.",
  })

  it("includeContent=false, no synopsis → `### {title}\\n*{meta}*` (byte-identical to pre-#03)", () => {
    const out = formatMemoryListItem(baseMemory, { meta: defaultMemoryMetaBuilder })
    expect(out).toBe("### OAuth handshake notes\n*manual | auth | 2026-04-20*")
  })

  it("includeContent=false, synopsis → `### {title}\\n{synopsis}\\n*{meta}*`", () => {
    const out = formatMemoryListItem(synopsisMemory, { meta: defaultMemoryMetaBuilder })
    expect(out).toBe(
      "### OAuth handshake notes\n" +
        "Outlook callbacks fail because the redirect URI is not allow-listed.\n" +
        "*manual | auth | 2026-04-20*",
    )
  })

  it("includeContent=true, no synopsis → `### {title}\\n*{meta}*\\n\\n{body}` (byte-identical to pre-#03)", () => {
    const out = formatMemoryListItem(baseMemory, {
      meta: defaultMemoryMetaBuilder,
      body: "Body paragraph.",
    })
    expect(out).toBe("### OAuth handshake notes\n*manual | auth | 2026-04-20*\n\nBody paragraph.")
  })

  it("includeContent=true, synopsis → `### {title}\\n{synopsis}\\n*{meta}*\\n\\n{body}`", () => {
    const out = formatMemoryListItem(synopsisMemory, {
      meta: defaultMemoryMetaBuilder,
      body: "Body paragraph.",
    })
    expect(out).toBe(
      "### OAuth handshake notes\n" +
        "Outlook callbacks fail because the redirect URI is not allow-listed.\n" +
        "*manual | auth | 2026-04-20*\n\n" +
        "Body paragraph.",
    )
  })
})

describe("formatMemoryListItem — includeSynopsis opt-out", () => {
  const synopsisMemory = buildMemory({
    id: "mem-1",
    title: "OAuth handshake notes",
    source: "manual",
    tags: ["auth"],
    updatedAt: "2026-04-20T00:00:00.000Z",
    synopsis: "Outlook callbacks fail because the redirect URI is not allow-listed.",
  })

  it("includeSynopsis=false suppresses the synopsis line on the body-off path", () => {
    const out = formatMemoryListItem(synopsisMemory, {
      meta: defaultMemoryMetaBuilder,
      includeSynopsis: false,
    })
    // Byte-identical to the no-synopsis cell.
    expect(out).toBe("### OAuth handshake notes\n*manual | auth | 2026-04-20*")
  })

  it("includeSynopsis=false suppresses the synopsis line on the body-on path", () => {
    const out = formatMemoryListItem(synopsisMemory, {
      meta: defaultMemoryMetaBuilder,
      includeSynopsis: false,
      body: "Body paragraph.",
    })
    expect(out).toBe("### OAuth handshake notes\n*manual | auth | 2026-04-20*\n\nBody paragraph.")
  })
})

describe("formatMemoryListItem — heading level + meta variants", () => {
  const synopsisMemory = buildMemory({
    id: "mem-1",
    title: "OAuth handshake notes",
    source: "manual",
    tags: [],
    synopsis: "One-liner.",
    updatedAt: "2026-04-20T00:00:00.000Z",
    createdAt: "2026-04-20T00:00:00.000Z",
  })

  it("respects headingLevel for nested call sites (e.g. wake-up Recent Memories under date buckets)", () => {
    const out = formatMemoryListItem(synopsisMemory, { headingLevel: 4 })
    expect(out.split("\n")[0]).toBe("#### OAuth handshake notes")
  })

  it("accepts a literal meta string and wraps it in asterisks verbatim", () => {
    const out = formatMemoryListItem(synopsisMemory, { meta: "manual | no tags | 2026-04-20" })
    expect(out).toBe(
      "### OAuth handshake notes\nOne-liner.\n*manual | no tags | 2026-04-20*",
    )
  })

  it("omits the meta line entirely when the builder returns null", () => {
    const out = formatMemoryListItem(synopsisMemory, { meta: () => null })
    // Heading + synopsis only, no italic meta line.
    expect(out).toBe("### OAuth handshake notes\nOne-liner.")
  })

  it("falls back to the default recall/search builder when meta option is omitted", () => {
    const out = formatMemoryListItem(synopsisMemory)
    // Default builder is `defaultMemoryMetaBuilder`; this is the
    // recall/search shape.
    expect(out).toBe("### OAuth handshake notes\nOne-liner.\n*manual | 2026-04-20*")
  })
})

describe("formatMemoryListItem — defensive truncation", () => {
  // Per #01 the service layer accepts up to the Notion 2000-char ceiling
  // and only the MCP write Zod enforces the 500-char cap, so internal
  // callers (bulk migrations, the future --backfill-synopses synthesizer)
  // can still write longer values. The renderer must defend against that
  // path landing 1500-char synopses on a wake-up listing.
  it("truncates over-cap synopses at the last word boundary at or before SYNOPSIS_MAX", () => {
    // Build a 600-char synopsis with words exactly 5 chars + 1 space wide
    // so the word boundary is deterministic.
    const word = "abcde "
    const longSynopsis = word.repeat(100) // 600 chars, last char is a space
    const memory = buildMemory({
      id: "mem-1",
      title: "Long synopsis",
      synopsis: longSynopsis,
    })
    const out = formatMemoryListItem(memory, { meta: () => null })
    const synopsisLine = out.split("\n")[1]
    // SYNOPSIS_MAX = 500. 500 / 6 = 83.33, so 83 full words fit (498
    // chars), and the truncation snaps back to that boundary.
    expect(synopsisLine.length).toBeLessThanOrEqual(SYNOPSIS_MAX)
    expect(synopsisLine.endsWith("e")).toBe(true)
    // No ellipsis marker — adding one would diverge from prior text-field
    // truncation in this codebase.
    expect(synopsisLine).not.toContain("…")
  })

  it("does not collapse the meta line into the truncated synopsis text", () => {
    const memory = buildMemory({
      id: "mem-1",
      title: "Truncated row",
      source: "manual",
      tags: ["auth"],
      synopsis: "x".repeat(600),
      updatedAt: "2026-04-20T00:00:00.000Z",
    })
    const out = formatMemoryListItem(memory, { meta: defaultMemoryMetaBuilder })
    // The meta line must still appear, on its own line, after the
    // (possibly truncated) synopsis.
    expect(out).toContain("\n*manual | auth | 2026-04-20*")
  })

  it("hard-slices when the synopsis has no whitespace to break on (single very long token)", () => {
    const memory = buildMemory({
      id: "mem-1",
      title: "Single long token",
      synopsis: "x".repeat(600),
    })
    const out = formatMemoryListItem(memory, { meta: () => null })
    const synopsisLine = out.split("\n")[1]
    expect(synopsisLine.length).toBe(SYNOPSIS_MAX)
  })

  it("leaves under-cap synopses untouched", () => {
    const memory = buildMemory({
      id: "mem-1",
      title: "Short synopsis",
      synopsis: "Short and sweet.",
    })
    const out = formatMemoryListItem(memory, { meta: () => null })
    expect(out).toBe("### Short synopsis\nShort and sweet.")
  })
})
