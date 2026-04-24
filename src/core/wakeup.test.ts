import { describe, expect, it, vi } from "vitest"
import {
  DEFAULT_WAKEUP_KNOWLEDGE_FACT_LIMIT,
  DEFAULT_WAKEUP_MEMORY_LIMIT,
  DEFAULT_WAKEUP_MEMORY_LIMIT_WITH_DIGEST,
  DEFAULT_WAKEUP_RELATED_MEMORY_LIMIT,
  dateBucket,
  loadWakeUpData,
  type WakeUpServices,
} from "./wakeup.js"
import type {
  DecisionSummary,
  Fact,
  FactPredicate,
  ListDecisionsOpts,
  Memory,
  MemorySource,
} from "../types.js"
import { TRACKING_PREDICATES } from "../types.js"

const NOW = new Date("2026-04-20T12:00:00Z").getTime()

function buildMemory(overrides: Partial<Memory> & { createdAt: string }): Memory {
  return {
    id: `mem-${overrides.createdAt}`,
    title: "Untitled",
    projectIds: [],
    topicId: null,
    source: "manual" satisfies MemorySource,
    kind: "note",
    status: "informational",
    confidence: "certain",
    reviewBy: null,
    decidedAt: null,
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
    updatedAt: overrides.createdAt,
    ...overrides,
  }
}

let nextFactId = 0
function buildFact(overrides: Partial<Fact>): Fact {
  nextFactId += 1
  return {
    id: `fact-${nextFactId}`,
    subject: "S",
    predicate: "uses",
    object: "O",
    projectIds: [],
    validFrom: null,
    validUntil: null,
    reviewBy: null,
    sourceMemoryId: null,
    confidence: "certain",
    ...overrides,
  }
}

type ListCall = {
  projectId?: string
  source?: MemorySource
  limit?: number
  includeContent?: boolean
  includeUnscoped?: boolean
  sortBy?: "created_time" | "last_edited_time"
}

type SearchCall = {
  query: string
  projectId?: string
  limit?: number
  includeContent?: boolean
}

type QueryCall = { subject: string; opts?: { projectId?: string; predicates?: FactPredicate[]; limit?: number } }
type ListRecentCall = {
  projectId?: string
  excludePredicates?: FactPredicate[]
  limit?: number
}

interface StubServices extends WakeUpServices {
  memoriesCalls: ListCall[]
  memoriesSearchCalls: SearchCall[]
  factsCalls: QueryCall[]
  factsListRecentCalls: ListRecentCall[]
  decisionsListCalls: ListDecisionsOpts[]
  decisionsOverdueCalls: Array<{ projectId?: string } | undefined>
}

function stubServices(opts: {
  rawMemories?: Memory[]
  digestMemories?: Memory[]
  relatedMemories?: Memory[]
  facts?: Fact[]
  proposedDecisions?: DecisionSummary[]
  overdueDecisions?: DecisionSummary[]
}): StubServices {
  const memoriesCalls: ListCall[] = []
  const memoriesSearchCalls: SearchCall[] = []
  const factsCalls: QueryCall[] = []
  const factsListRecentCalls: ListRecentCall[] = []
  const decisionsListCalls: ListDecisionsOpts[] = []
  const decisionsOverdueCalls: Array<{ projectId?: string } | undefined> = []
  const factsResult = opts.facts ?? []

  return {
    memories: {
      list: vi.fn(async (args: ListCall) => {
        memoriesCalls.push(args)
        const items = args.source === "digest"
          ? opts.digestMemories ?? []
          : opts.rawMemories ?? []
        return { items }
      }),
      search: vi.fn(async (args: SearchCall) => {
        memoriesSearchCalls.push(args)
        return opts.relatedMemories ?? []
      }),
    },
    facts: {
      // Simulates Notion's server-side predicate filter so a single fixture
      // array produces the right shard for each query path.
      queryBySubject: vi.fn(async (subject: string, queryOpts) => {
        factsCalls.push({ subject, opts: queryOpts })
        let filtered = factsResult
        if (queryOpts?.predicates?.length) {
          const allowed = new Set<FactPredicate>(queryOpts.predicates)
          filtered = filtered.filter((f) => allowed.has(f.predicate))
        }
        if (queryOpts?.limit !== undefined) {
          filtered = filtered.slice(0, queryOpts.limit)
        }
        return filtered
      }),
      listRecent: vi.fn(async (listOpts: ListRecentCall) => {
        factsListRecentCalls.push(listOpts)
        let filtered = factsResult
        if (listOpts.excludePredicates?.length) {
          const excluded = new Set<FactPredicate>(listOpts.excludePredicates)
          filtered = filtered.filter((f) => !excluded.has(f.predicate))
        }
        const total = filtered.length
        if (listOpts.limit !== undefined) {
          filtered = filtered.slice(0, listOpts.limit)
        }
        return { items: filtered, hasMore: filtered.length < total }
      }),
    },
    decisions: {
      list: vi.fn(async (listOpts?: ListDecisionsOpts) => {
        decisionsListCalls.push(listOpts ?? {})
        return { items: opts.proposedDecisions ?? [] }
      }),
      queryOverdue: vi.fn(async (overdueOpts) => {
        decisionsOverdueCalls.push(overdueOpts)
        return opts.overdueDecisions ?? []
      }),
    },
    memoriesCalls,
    memoriesSearchCalls,
    factsCalls,
    factsListRecentCalls,
    decisionsListCalls,
    decisionsOverdueCalls,
  }
}

describe("loadWakeUpData", () => {
  it("surfaces a fresh digest and trims raw memories", async () => {
    const fresh = buildMemory({
      id: "d1",
      title: "Digest — 2026-04-19",
      source: "digest",
      createdAt: "2026-04-19T00:00:00Z",
      content: "Summary body",
    })
    const manyMemories = Array.from({ length: 10 }, (_, i) =>
      buildMemory({
        id: `m${i}`,
        title: `memory ${i}`,
        createdAt: `2026-04-19T${String(i + 1).padStart(2, "0")}:00:00Z`,
      }),
    )

    const services = stubServices({ rawMemories: manyMemories, digestMemories: [fresh] })

    const data = await loadWakeUpData(services, { projectId: "p1", now: NOW })

    expect(data.digest?.id).toBe("d1")
    expect(data.memories).toHaveLength(DEFAULT_WAKEUP_MEMORY_LIMIT_WITH_DIGEST)
    expect(data.memories.every((m) => m.source !== "digest")).toBe(true)
  })

  it("ignores stale digests and uses the full memory limit", async () => {
    const stale = buildMemory({
      id: "d1",
      title: "Old digest",
      source: "digest",
      createdAt: "2026-03-01T00:00:00Z",
    })
    const manyMemories = Array.from({ length: 12 }, (_, i) =>
      buildMemory({
        id: `m${i}`,
        title: `memory ${i}`,
        createdAt: `2026-04-${String(10 + (i % 10)).padStart(2, "0")}T00:00:00Z`,
      }),
    )

    const services = stubServices({ rawMemories: manyMemories, digestMemories: [stale] })

    const data = await loadWakeUpData(services, { projectId: "p1", now: NOW })

    expect(data.digest).toBeNull()
    expect(data.memories).toHaveLength(DEFAULT_WAKEUP_MEMORY_LIMIT)
  })

  it("filters digest entries and older memories out of the recent-memories list", async () => {
    const fresh = buildMemory({
      id: "d1",
      title: "Fresh digest",
      source: "digest",
      createdAt: "2026-04-19T00:00:00Z",
    })
    // `memories.list()` without source filter will return the digest too
    // (it's just another memory). The helper must drop it to avoid duplication,
    // and it must not surface memories already covered by the digest.
    const mixed = [
      buildMemory({ id: "m0", title: "work after digest", createdAt: "2026-04-20T00:00:00Z" }),
      fresh,
      buildMemory({ id: "m1", title: "work before digest", createdAt: "2026-04-18T00:00:00Z" }),
      buildMemory({ id: "m2", title: "older work", createdAt: "2026-04-17T00:00:00Z" }),
    ]

    const services = stubServices({ rawMemories: mixed, digestMemories: [fresh] })

    const data = await loadWakeUpData(services, { projectId: "p1", now: NOW })

    expect(data.digest?.id).toBe("d1")
    expect(data.memories.map((m) => m.id)).toEqual(["m0"])
  })

  it("over-fetches by one so filtering a leading digest does not cut the list short", async () => {
    const services = stubServices({ rawMemories: [], digestMemories: [] })

    await loadWakeUpData(services, { projectId: "p1", memoryLimit: 10, now: NOW })

    const rawListCall = services.memoriesCalls.find((c) => c.source === undefined)
    expect(rawListCall?.limit).toBe(11)
  })

  it("does not return more than memoryLimit even when no digest is present (0-digest fast path)", async () => {
    // The Mail-vault fast path: zero digest memories exist, but we still
    // request `memoryLimit + 1` so a leading-digest filter has headroom.
    // Without a digest, the extra row must be trimmed — otherwise every
    // wake-up would leak one row past the requested cap.
    const eleven = Array.from({ length: 11 }, (_, i) =>
      buildMemory({
        id: `m${i}`,
        title: `memory ${i}`,
        createdAt: `2026-04-19T${String(i + 1).padStart(2, "0")}:00:00Z`,
      }),
    )
    const services = stubServices({ rawMemories: eleven, digestMemories: [] })

    const data = await loadWakeUpData(services, { projectId: "p1", memoryLimit: 10, now: NOW })

    expect(data.digest).toBeNull()
    expect(data.memories).toHaveLength(10)
  })

  it("sorts the digest query by created_time so freshness matches 'latest'", async () => {
    const services = stubServices({ rawMemories: [], digestMemories: [] })

    await loadWakeUpData(services, { projectId: "p1", now: NOW })

    const digestCall = services.memoriesCalls.find((c) => c.source === "digest")
    expect(digestCall?.includeUnscoped).toBe(false)
    expect(digestCall?.sortBy).toBe("created_time")
  })

  it("propagates includeMemoryContent to the raw memories query", async () => {
    const services = stubServices({ rawMemories: [], digestMemories: [] })

    await loadWakeUpData(services, { projectId: "p1", includeMemoryContent: false, now: NOW })

    const rawListCall = services.memoriesCalls.find((c) => c.source === undefined)
    expect(rawListCall?.includeContent).toBe(false)
    // Digest call always keeps content — that's what renders.
    const digestCall = services.memoriesCalls.find((c) => c.source === "digest")
    expect(digestCall?.includeContent).toBeUndefined()
  })

  it("partitions facts into open loops and knowledge facts", async () => {
    const services = stubServices({
      rawMemories: [],
      digestMemories: [],
      facts: [
        buildFact({ id: "f1", predicate: "uses" }),
        buildFact({ id: "f2", predicate: "needs_action" }),
        buildFact({ id: "f3", predicate: "waiting_on" }),
      ],
    })

    const data = await loadWakeUpData(services, { projectId: "p1", now: NOW })

    expect(data.openLoops.map((f) => f.id).sort()).toEqual(["f2", "f3"])
    expect(data.knowledgeFacts.map((f) => f.id)).toEqual(["f1"])
  })

  it("caps knowledge facts at knowledgeFactLimit (default 25)", async () => {
    const facts = Array.from({ length: DEFAULT_WAKEUP_KNOWLEDGE_FACT_LIMIT + 10 }, (_, i) =>
      buildFact({ id: `k${i}`, predicate: "uses" }),
    )
    const services = stubServices({ rawMemories: [], digestMemories: [], facts })

    const data = await loadWakeUpData(services, { projectId: "p1", now: NOW })

    expect(data.knowledgeFacts).toHaveLength(DEFAULT_WAKEUP_KNOWLEDGE_FACT_LIMIT)
    // Open loops unaffected.
    expect(data.openLoops).toHaveLength(0)
  })

  it("issues targeted fact queries with server-side predicate filters and bounded page size", async () => {
    // Wake-up runs on every hook fire — the old full-scan paginated the
    // entire project fact table. The new shape must push partitioning to
    // Notion: one bounded page for open loops (tracking predicates) and
    // one bounded page for knowledge facts (everything else).
    const services = stubServices({ rawMemories: [], digestMemories: [], facts: [] })

    await loadWakeUpData(services, { projectId: "p1", now: NOW })

    expect(services.factsCalls).toHaveLength(1)
    const openLoopCall = services.factsCalls[0]
    expect(openLoopCall.subject).toBe("")
    expect(openLoopCall.opts?.projectId).toBe("p1")
    expect(openLoopCall.opts?.predicates).toEqual(TRACKING_PREDICATES)
    // Bounded by Notion's per-page ceiling so wake-up never paginates.
    expect(openLoopCall.opts?.limit).toBeDefined()
    expect(openLoopCall.opts?.limit).toBeLessThanOrEqual(100)

    expect(services.factsListRecentCalls).toHaveLength(1)
    const knowledgeCall = services.factsListRecentCalls[0]
    expect(knowledgeCall.projectId).toBe("p1")
    expect(knowledgeCall.excludePredicates).toEqual(TRACKING_PREDICATES)
    expect(knowledgeCall.limit).toBe(DEFAULT_WAKEUP_KNOWLEDGE_FACT_LIMIT)
  })

  it("forwards a caller-supplied knowledgeFactLimit into the server-side query", async () => {
    // Truncation moves from the client to the server; the option must reach
    // the facts layer or the cap becomes advisory noise.
    const services = stubServices({ rawMemories: [], digestMemories: [], facts: [] })

    await loadWakeUpData(services, {
      projectId: "p1",
      knowledgeFactLimit: 7,
      now: NOW,
    })

    expect(services.factsListRecentCalls[0]?.limit).toBe(7)
  })

  it("forwards a caller-supplied openLoopLimit into the tracking-predicate query", async () => {
    // P2-01 exposes per-section caps so callers can bound prompt size.
    // openLoopLimit must reach the tracking-partition query or the cap
    // becomes advisory — wake-up is a hot path and we can't afford to
    // over-fetch just because the renderer truncates later.
    const services = stubServices({ rawMemories: [], digestMemories: [], facts: [] })

    await loadWakeUpData(services, { projectId: "p1", openLoopLimit: 4, now: NOW })

    expect(services.factsCalls[0]?.opts?.limit).toBe(4)
  })

  it("clamps openLoopLimit to Notion's per-page ceiling", async () => {
    // Schema validation caps inputs at 50, but defense-in-depth: if a
    // caller (or a future schema loosening) feeds us 500, we still must
    // not paginate. The service layer caps at 100 too — asserting here
    // pins the wake-up-side contract.
    const services = stubServices({ rawMemories: [], digestMemories: [], facts: [] })

    await loadWakeUpData(services, { projectId: "p1", openLoopLimit: 500, now: NOW })

    expect(services.factsCalls[0]?.opts?.limit).toBeLessThanOrEqual(100)
  })

  it("skips the tracking-predicate query when openLoopLimit is 0", async () => {
    // Setting openLoopLimit: 0 is the explicit "skip this section" knob.
    // It must short-circuit the Notion round-trip — pre-P2-01 wake-up
    // always paid for tracking-partition I/O.
    const services = stubServices({ rawMemories: [], digestMemories: [], facts: [] })

    const data = await loadWakeUpData(services, { projectId: "p1", openLoopLimit: 0, now: NOW })

    expect(data.openLoops).toEqual([])
    expect(services.facts.queryBySubject).not.toHaveBeenCalled()
  })

  it("skips digest, fact, decision, and related-memory lookup when no project is resolved", async () => {
    const services = stubServices({ rawMemories: [], digestMemories: [] })

    const data = await loadWakeUpData(services, { now: NOW })

    expect(data.digest).toBeNull()
    expect(data.openLoops).toEqual([])
    expect(data.knowledgeFacts).toEqual([])
    expect(data.proposedDecisions).toEqual([])
    expect(data.overdueDecisions).toEqual([])
    expect(data.relatedMemories).toEqual([])
    expect(services.memoriesCalls.some((c) => c.source === "digest")).toBe(false)
    expect(services.memoriesSearchCalls).toEqual([])
    expect(services.facts.queryBySubject).not.toHaveBeenCalled()
    expect(services.facts.listRecent).not.toHaveBeenCalled()
    expect(services.decisions.list).not.toHaveBeenCalled()
    expect(services.decisions.queryOverdue).not.toHaveBeenCalled()
  })

  it("treats future-dated digests as stale (clock-skew guard)", async () => {
    const skewed = buildMemory({
      id: "d1",
      title: "future digest",
      source: "digest",
      createdAt: "2026-05-01T00:00:00Z",
    })

    const services = stubServices({ rawMemories: [], digestMemories: [skewed] })
    const data = await loadWakeUpData(services, { projectId: "p1", now: NOW })

    expect(data.digest).toBeNull()
  })

  it("loads proposed and overdue decisions when a project is scoped", async () => {
    const proposed: DecisionSummary[] = [
      {
        id: "dec-p",
        title: "Move auth to OIDC",
        projectIds: ["p1"],
        topicId: null,
        source: "manual",
        kind: "decision",
        status: "proposed",
        confidence: "likely",
        reviewBy: null,
        decidedAt: "2026-04-01",
        supersedesIds: [],
        affectsIds: [],
        alternatives: "",
        consequences: "",
        author: "",
        agent: "",
        tags: [],
        keywords: "",
        session: "",
        createdAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-04-01T00:00:00Z",
      },
    ]
    const overdueDecisions: DecisionSummary[] = [
      {
        ...proposed[0],
        id: "dec-o",
        title: "Retire legacy API",
        status: "accepted",
        reviewBy: "2026-01-01",
      },
    ]

    const services = stubServices({
      rawMemories: [],
      digestMemories: [],
      proposedDecisions: proposed,
      overdueDecisions,
    })

    const data = await loadWakeUpData(services, { projectId: "p1", now: NOW })

    expect(data.proposedDecisions.map((d) => d.id)).toEqual(["dec-p"])
    expect(data.overdueDecisions.map((d) => d.id)).toEqual(["dec-o"])
    expect(services.decisionsListCalls[0]).toEqual({
      projectId: "p1",
      status: "proposed",
      limit: 20,
    })
    expect(services.decisionsOverdueCalls[0]).toEqual({ projectId: "p1" })
  })

  it("skips decision queries when includeDecisions is false", async () => {
    // Hook wake-up renders no decision sections, so it passes
    // includeDecisions: false to avoid paying for queries it will never use.
    const services = stubServices({ rawMemories: [], digestMemories: [] })

    const data = await loadWakeUpData(services, {
      projectId: "p1",
      includeDecisions: false,
      now: NOW,
    })

    expect(data.proposedDecisions).toEqual([])
    expect(data.overdueDecisions).toEqual([])
    expect(services.decisions.list).not.toHaveBeenCalled()
    expect(services.decisions.queryOverdue).not.toHaveBeenCalled()
  })

  it("surfaces related memories seeded by open-loop entities", async () => {
    const openLoop = buildFact({
      id: "f-loop",
      predicate: "blocked_by",
      subject: "Historic autolabel",
      object: "OOM issue",
    })
    const related = buildMemory({
      id: "rel-1",
      title: "Historic autolabel pipeline notes",
      createdAt: "2026-02-10T00:00:00Z",
    })

    const services = stubServices({
      rawMemories: [],
      digestMemories: [],
      facts: [openLoop],
      relatedMemories: [related],
    })

    const data = await loadWakeUpData(services, { projectId: "p1", now: NOW })

    expect(data.relatedMemories.map((m) => m.id)).toEqual(["rel-1"])
    expect(services.memoriesSearchCalls).toHaveLength(1)
    const relatedCall = services.memoriesSearchCalls[0]
    expect(relatedCall.projectId).toBe("p1")
    // Entities are joined into a single relevance query so Notion's vector
    // index scores titles AND bodies against the union.
    expect(relatedCall.query).toContain("Historic autolabel")
    expect(relatedCall.query).toContain("OOM issue")
  })

  it("dedupes related memories against the digest and recent memories", async () => {
    const fresh = buildMemory({
      id: "d1",
      title: "Fresh digest",
      source: "digest",
      createdAt: "2026-04-19T00:00:00Z",
    })
    const recent = buildMemory({
      id: "m0",
      title: "autolabel post-digest update",
      createdAt: "2026-04-20T00:00:00Z",
    })
    const openLoop = buildFact({
      id: "f-loop",
      predicate: "blocked_by",
      subject: "autolabel",
      object: "OOM",
    })
    // Related set includes the digest id, the recent id, and a fresh third one.
    // Only the third one should survive.
    const related = [
      buildMemory({ ...recent, id: "m0", title: "dupe-recent", createdAt: "2026-04-20T00:00:00Z" }),
      buildMemory({ ...fresh, id: "d1", title: "dupe-digest", createdAt: "2026-04-19T00:00:00Z" }),
      buildMemory({ id: "rel-new", title: "autolabel deep dive", createdAt: "2026-02-01T00:00:00Z" }),
    ]

    const services = stubServices({
      rawMemories: [recent],
      digestMemories: [fresh],
      facts: [openLoop],
      relatedMemories: related,
    })

    const data = await loadWakeUpData(services, { projectId: "p1", now: NOW })

    expect(data.relatedMemories.map((m) => m.id)).toEqual(["rel-new"])
  })

  it("scales the related-memory fetch window with relatedLimit + already-surfaced size", async () => {
    // A caller asking for `relatedMemoryLimit: 50` must be able to receive
    // close to 50 memories — previously the fetch was hard-capped at 20, so
    // the request was silently truncated before dedupe.
    const fresh = buildMemory({
      id: "d1",
      source: "digest",
      createdAt: "2026-04-19T00:00:00Z",
    })
    const recent = buildMemory({ id: "m0", createdAt: "2026-04-20T00:00:00Z" })
    const openLoop = buildFact({
      id: "f-loop",
      predicate: "needs_action",
      subject: "Router migration",
      object: "OIDC",
    })
    const services = stubServices({
      rawMemories: [recent],
      digestMemories: [fresh],
      facts: [openLoop],
      relatedMemories: [],
    })

    await loadWakeUpData(services, {
      projectId: "p1",
      relatedMemoryLimit: 50,
      now: NOW,
    })

    const relatedCall = services.memoriesSearchCalls[0]
    // alreadySurfaced = digest(1) + recent(1) = 2. Fetch needs >= 50 + 2.
    expect(relatedCall?.limit).toBeGreaterThanOrEqual(52)
  })

  it("does not starve related memories when candidates are mostly duplicates", async () => {
    // Pathological case: nearly every candidate returned by `titleAny` is
    // already surfaced as digest or recent. Scaling the fetch window by
    // `alreadySurfaced.size` ensures we still fill `relatedLimit` survivors.
    const fresh = buildMemory({
      id: "d1",
      source: "digest",
      createdAt: "2026-04-19T00:00:00Z",
    })
    const recents = Array.from({ length: 3 }, (_, i) =>
      buildMemory({ id: `m${i}`, createdAt: "2026-04-20T00:00:00Z" }),
    )
    const openLoop = buildFact({
      id: "f-loop",
      predicate: "needs_action",
      subject: "Router",
      object: "OIDC",
    })
    const candidates = [
      buildMemory({ id: "d1", title: "dupe digest", createdAt: "2026-04-01T00:00:00Z" }),
      buildMemory({ id: "m0", title: "dupe m0", createdAt: "2026-04-01T00:00:00Z" }),
      buildMemory({ id: "m1", title: "dupe m1", createdAt: "2026-04-01T00:00:00Z" }),
      buildMemory({ id: "m2", title: "dupe m2", createdAt: "2026-04-01T00:00:00Z" }),
      buildMemory({ id: "r1", title: "fresh 1", createdAt: "2026-04-01T00:00:00Z" }),
      buildMemory({ id: "r2", title: "fresh 2", createdAt: "2026-04-01T00:00:00Z" }),
      buildMemory({ id: "r3", title: "fresh 3", createdAt: "2026-04-01T00:00:00Z" }),
    ]
    const services = stubServices({
      rawMemories: recents,
      digestMemories: [fresh],
      facts: [openLoop],
      relatedMemories: candidates,
    })

    const data = await loadWakeUpData(services, {
      projectId: "p1",
      relatedMemoryLimit: 3,
      now: NOW,
    })

    expect(data.relatedMemories.map((m) => m.id)).toEqual(["r1", "r2", "r3"])
  })

  it("caps related memories at relatedMemoryLimit", async () => {
    const openLoop = buildFact({
      id: "f-loop",
      predicate: "needs_action",
      subject: "Router",
      object: "migrate",
    })
    const related = Array.from({ length: DEFAULT_WAKEUP_RELATED_MEMORY_LIMIT + 3 }, (_, i) =>
      buildMemory({
        id: `rel-${i}`,
        title: `Router note ${i}`,
        createdAt: "2026-02-10T00:00:00Z",
      }),
    )

    const services = stubServices({
      rawMemories: [],
      digestMemories: [],
      facts: [openLoop],
      relatedMemories: related,
    })

    const data = await loadWakeUpData(services, { projectId: "p1", now: NOW })

    expect(data.relatedMemories).toHaveLength(DEFAULT_WAKEUP_RELATED_MEMORY_LIMIT)
  })

  it("does not issue a related-memories query when there are no open loops", async () => {
    const services = stubServices({
      rawMemories: [],
      digestMemories: [],
      facts: [buildFact({ id: "k1", predicate: "uses" })], // no tracking predicates
      relatedMemories: [
        buildMemory({ id: "should-not-surface", title: "noise", createdAt: "2026-02-10T00:00:00Z" }),
      ],
    })

    const data = await loadWakeUpData(services, { projectId: "p1", now: NOW })

    expect(data.relatedMemories).toEqual([])
    expect(services.memoriesSearchCalls).toEqual([])
  })

  it("drops very short entity fragments from the related-memories seed", async () => {
    const openLoop = buildFact({
      id: "f-loop",
      predicate: "needs_action",
      subject: "ok",
      object: "Router migration",
    })
    const services = stubServices({
      rawMemories: [],
      digestMemories: [],
      facts: [openLoop],
      relatedMemories: [],
    })

    await loadWakeUpData(services, { projectId: "p1", now: NOW })

    const relatedCall = services.memoriesSearchCalls[0]
    expect(relatedCall?.query).toBe("Router migration")
  })

  it("forwards includeMemoryContent to the related-memory search", async () => {
    // The hook wake-up path passes `includeMemoryContent: false` to skip
    // N+1 markdown fetches on every session start. Search must honor it.
    const openLoop = buildFact({
      id: "f-loop",
      predicate: "needs_action",
      subject: "Router migration",
      object: "OIDC",
    })
    const services = stubServices({
      rawMemories: [],
      digestMemories: [],
      facts: [openLoop],
      relatedMemories: [],
    })

    await loadWakeUpData(services, {
      projectId: "p1",
      includeMemoryContent: false,
      now: NOW,
    })

    const relatedCall = services.memoriesSearchCalls[0]
    expect(relatedCall?.includeContent).toBe(false)
  })
})

describe("dateBucket", () => {
  it("classifies timestamps relative to `now`", () => {
    expect(dateBucket("2026-04-20T10:00:00Z", NOW)).toBe("Today")
    expect(dateBucket("2026-04-19T23:59:00Z", NOW)).toBe("Yesterday")
    expect(dateBucket("2026-04-10T00:00:00Z", NOW)).toBe("Earlier")
  })
})
