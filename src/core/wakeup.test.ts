import { describe, expect, it, vi } from "vitest"
import {
  DEFAULT_WAKEUP_KNOWLEDGE_FACT_LIMIT,
  DEFAULT_WAKEUP_MEMORY_LIMIT,
  DEFAULT_WAKEUP_MEMORY_LIMIT_WITH_DIGEST,
  DEFAULT_WAKEUP_RELATED_MEMORY_LIMIT,
  DEFAULT_WAKEUP_TASK_MEMORY_LIMIT,
  dateBucket,
  loadWakeUpData,
  type WakeUpServices,
} from "./wakeup.js"
import type {
  DecisionSummary,
  Fact,
  ListDecisionsOpts,
  ListTasksOpts,
  Memory,
  MemorySource,
  TaskSummary,
} from "../types.js"

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
    taskState: null,
    blockedBy: "",
    entity: "",
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
    subjectEntityId: null,
    objectEntityId: null,
    ...overrides,
  }
}

function buildTask(overrides: Partial<TaskSummary> & { id: string }): TaskSummary {
  const base: TaskSummary = {
    id: overrides.id,
    title: overrides.title ?? `Task ${overrides.id}`,
    projectIds: [],
    topicId: null,
    source: "manual",
    kind: "task",
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
    taskState: "open",
    blockedBy: "",
    entity: overrides.entity ?? "",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
  }
  return { ...base, ...overrides }
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
  mode?: "contains" | "semantic" | "hybrid"
}

type ListRecentCall = {
  projectId?: string
  limit?: number
}

interface StubServices extends WakeUpServices {
  memoriesCalls: ListCall[]
  memoriesSearchCalls: SearchCall[]
  factsListRecentCalls: ListRecentCall[]
  decisionsListCalls: ListDecisionsOpts[]
  decisionsOverdueCalls: Array<{ projectId?: string } | undefined>
  tasksListCalls: ListTasksOpts[]
}

function stubServices(opts: {
  rawMemories?: Memory[]
  digestMemories?: Memory[]
  relatedMemories?: Memory[]
  /**
   * Memories returned when the search query equals `taskQuery`. Lets
   * P3-05 tests distinguish the user-query-seeded task search from the
   * task-entity-seeded related search — both go through the same
   * `MemoryService.search` method but feed different output sections.
   */
  taskQuery?: string
  taskMemories?: Memory[]
  facts?: Fact[]
  proposedDecisions?: DecisionSummary[]
  overdueDecisions?: DecisionSummary[]
  tasks?: TaskSummary[]
}): StubServices {
  const memoriesCalls: ListCall[] = []
  const memoriesSearchCalls: SearchCall[] = []
  const factsListRecentCalls: ListRecentCall[] = []
  const decisionsListCalls: ListDecisionsOpts[] = []
  const decisionsOverdueCalls: Array<{ projectId?: string } | undefined> = []
  const tasksListCalls: ListTasksOpts[] = []
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
        if (
          opts.taskQuery !== undefined &&
          opts.taskMemories !== undefined &&
          args.query === opts.taskQuery
        ) {
          return opts.taskMemories
        }
        return opts.relatedMemories ?? []
      }),
    },
    facts: {
      listRecent: vi.fn(async (listOpts: ListRecentCall) => {
        factsListRecentCalls.push(listOpts)
        const total = factsResult.length
        const items =
          listOpts.limit !== undefined
            ? factsResult.slice(0, listOpts.limit)
            : factsResult
        return { items, hasMore: items.length < total }
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
    tasks: {
      list: vi.fn(async (listOpts?: ListTasksOpts) => {
        tasksListCalls.push(listOpts ?? {})
        return { items: opts.tasks ?? [] }
      }),
    },
    memoriesCalls,
    memoriesSearchCalls,
    factsListRecentCalls,
    decisionsListCalls,
    decisionsOverdueCalls,
    tasksListCalls,
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

  it("returns recent facts as knowledge facts", async () => {
    const services = stubServices({
      rawMemories: [],
      digestMemories: [],
      facts: [
        buildFact({ id: "f1", predicate: "uses" }),
        buildFact({ id: "f2", predicate: "depends_on" }),
      ],
    })

    const data = await loadWakeUpData(services, { projectId: "p1", now: NOW })

    expect(data.knowledgeFacts.map((f) => f.id)).toEqual(["f1", "f2"])
  })

  it("caps knowledge facts at knowledgeFactLimit (default)", async () => {
    const facts = Array.from({ length: DEFAULT_WAKEUP_KNOWLEDGE_FACT_LIMIT + 10 }, (_, i) =>
      buildFact({ id: `k${i}`, predicate: "uses" }),
    )
    const services = stubServices({ rawMemories: [], digestMemories: [], facts })

    const data = await loadWakeUpData(services, { projectId: "p1", now: NOW })

    expect(data.knowledgeFacts).toHaveLength(DEFAULT_WAKEUP_KNOWLEDGE_FACT_LIMIT)
  })

  it("issues a single bounded listRecent query for knowledge facts", async () => {
    // Wake-up runs on every hook fire; the facts query must be a bounded
    // single-page read.
    const services = stubServices({ rawMemories: [], digestMemories: [], facts: [] })

    await loadWakeUpData(services, { projectId: "p1", now: NOW })

    expect(services.factsListRecentCalls).toHaveLength(1)
    const knowledgeCall = services.factsListRecentCalls[0]
    expect(knowledgeCall.projectId).toBe("p1")
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

  it("skips digest, fact, decision, and related-memory lookup when no project is resolved", async () => {
    const services = stubServices({ rawMemories: [], digestMemories: [] })

    const data = await loadWakeUpData(services, { now: NOW })

    expect(data.digest).toBeNull()
    expect(data.knowledgeFacts).toEqual([])
    expect(data.proposedDecisions).toEqual([])
    expect(data.overdueDecisions).toEqual([])
    expect(data.relatedMemories).toEqual([])
    expect(services.memoriesCalls.some((c) => c.source === "digest")).toBe(false)
    expect(services.memoriesSearchCalls).toEqual([])
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
        taskState: null,
        blockedBy: "",
        entity: "",
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

  it("surfaces related memories seeded by active task entities", async () => {
    const task = buildTask({
      id: "t-1",
      title: "Historic autolabel pipeline",
      entity: "Historic autolabel",
    })
    const related = buildMemory({
      id: "rel-1",
      title: "Historic autolabel pipeline notes",
      createdAt: "2026-02-10T00:00:00Z",
    })

    const services = stubServices({
      rawMemories: [],
      digestMemories: [],
      tasks: [task],
      relatedMemories: [related],
    })

    const data = await loadWakeUpData(services, { projectId: "p1", now: NOW })

    expect(data.relatedMemories.map((m) => m.id)).toEqual(["rel-1"])
    expect(services.memoriesSearchCalls).toHaveLength(1)
    const relatedCall = services.memoriesSearchCalls[0]
    expect(relatedCall.projectId).toBe("p1")
    expect(relatedCall.query).toContain("Historic autolabel")
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
    const task = buildTask({
      id: "t-1",
      title: "autolabel",
      entity: "autolabel",
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
      tasks: [task],
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
    const task = buildTask({
      id: "t-1",
      title: "Router migration",
      entity: "Router migration",
    })
    const services = stubServices({
      rawMemories: [recent],
      digestMemories: [fresh],
      tasks: [task],
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
    const task = buildTask({
      id: "t-1",
      title: "Router",
      entity: "Router",
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
      tasks: [task],
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
    const task = buildTask({
      id: "t-1",
      title: "Router",
      entity: "Router migration",
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
      tasks: [task],
      relatedMemories: related,
    })

    const data = await loadWakeUpData(services, { projectId: "p1", now: NOW })

    expect(data.relatedMemories).toHaveLength(DEFAULT_WAKEUP_RELATED_MEMORY_LIMIT)
  })

  it("does not issue a related-memories query when there are no active tasks", async () => {
    const services = stubServices({
      rawMemories: [],
      digestMemories: [],
      tasks: [],
      relatedMemories: [
        buildMemory({ id: "should-not-surface", title: "noise", createdAt: "2026-02-10T00:00:00Z" }),
      ],
    })

    const data = await loadWakeUpData(services, { projectId: "p1", now: NOW })

    expect(data.relatedMemories).toEqual([])
    expect(services.memoriesSearchCalls).toEqual([])
  })

  it("drops very short entity fragments from the related-memories seed", async () => {
    // A task whose entity (and title) are both shorter than the
    // 3-char minimum produces no seed at all, so no search fires.
    // A task with a long-enough fallback title still seeds the search.
    const shortTask = buildTask({
      id: "t-short",
      title: "ok",
      entity: "ok",
    })
    const longTask = buildTask({
      id: "t-long",
      title: "Router migration",
      entity: "Router migration",
    })
    const services = stubServices({
      rawMemories: [],
      digestMemories: [],
      tasks: [shortTask, longTask],
      relatedMemories: [],
    })

    await loadWakeUpData(services, { projectId: "p1", now: NOW })

    const relatedCall = services.memoriesSearchCalls[0]
    // The short task's entity is dropped; only the long task's entity
    // appears in the seed.
    expect(relatedCall?.query).toBe("Router migration")
  })

  it("forwards includeMemoryContent to the related-memory search", async () => {
    // The hook wake-up path passes `includeMemoryContent: false` to skip
    // N+1 markdown fetches on every session start. Search must honor it.
    const task = buildTask({
      id: "t-1",
      title: "Router migration",
      entity: "Router migration",
    })
    const services = stubServices({
      rawMemories: [],
      digestMemories: [],
      tasks: [task],
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

  it("requests semantic mode for the related-memory search (P3-04)", async () => {
    // Phrase-shaped task subjects don't substring-match titles, so the
    // contains leg of hybrid would mostly miss and force the same semantic
    // round-trip after a wasted contains pass. Wake-up explicitly opts
    // into `mode: "semantic"` to skip that wasted round-trip and lock in
    // the relevance-ranked behavior the surrounding logic depends on.
    const task = buildTask({
      id: "t-1",
      title: "Router migration",
      entity: "Router migration",
    })
    const services = stubServices({
      rawMemories: [],
      digestMemories: [],
      tasks: [task],
      relatedMemories: [],
    })

    await loadWakeUpData(services, { projectId: "p1", now: NOW })

    const relatedCall = services.memoriesSearchCalls[0]
    expect(relatedCall?.mode).toBe("semantic")
  })

  describe("userQuery / taskMemories", () => {
    it("fires an extra search seeded by userQuery and surfaces the hits", async () => {
      // P3-05: when wake-up has the user's first message, the most
      // relevant section is "what does the vault have on the thing the
      // user is asking about" — not generic recents or task seeds.
      const taskHit = buildMemory({
        id: "task-hit",
        title: "Auth bug post-mortem",
        createdAt: "2026-03-15T00:00:00Z",
      })
      const services = stubServices({
        rawMemories: [],
        digestMemories: [],
        taskQuery: "How do I fix the auth bug?",
        taskMemories: [taskHit],
      })

      const data = await loadWakeUpData(services, {
        projectId: "p1",
        userQuery: "How do I fix the auth bug?",
        now: NOW,
      })

      expect(data.taskMemories.map((m) => m.id)).toEqual(["task-hit"])
      const taskCall = services.memoriesSearchCalls.find(
        (c) => c.query === "How do I fix the auth bug?",
      )
      expect(taskCall).toBeDefined()
      expect(taskCall?.projectId).toBe("p1")
    })

    it("returns empty taskMemories when userQuery is absent", async () => {
      // The fallback path: hooks fired before the user has spoken (e.g.
      // Codex SessionStart) pass no userQuery. Wake-up must skip the
      // extra search entirely — both to save the round-trip and to
      // keep `taskMemories` empty so renderers omit the section.
      const services = stubServices({
        rawMemories: [],
        digestMemories: [],
        taskQuery: "anything",
        taskMemories: [
          buildMemory({ id: "should-not-appear", createdAt: "2026-03-15T00:00:00Z" }),
        ],
      })

      const data = await loadWakeUpData(services, { projectId: "p1", now: NOW })

      expect(data.taskMemories).toEqual([])
      // No search call was issued for any task-shaped query — the only
      // possible search is the related-memories one, which would only
      // fire if there were active tasks.
      expect(services.memoriesSearchCalls).toEqual([])
    })

    it.each([
      ["empty string", ""],
      ["whitespace only", "   \n\t  "],
    ])("treats %s userQuery as absent (no search fired)", async (_label, query) => {
      const services = stubServices({
        rawMemories: [],
        digestMemories: [],
        taskQuery: "shouldnotmatch",
        taskMemories: [
          buildMemory({ id: "should-not-appear", createdAt: "2026-03-15T00:00:00Z" }),
        ],
      })

      const data = await loadWakeUpData(services, {
        projectId: "p1",
        userQuery: query,
        now: NOW,
      })

      expect(data.taskMemories).toEqual([])
      expect(services.memoriesSearchCalls).toEqual([])
    })

    it("trims surrounding whitespace before searching", async () => {
      const services = stubServices({
        rawMemories: [],
        digestMemories: [],
        taskQuery: "fix auth",
        taskMemories: [
          buildMemory({ id: "trim-hit", createdAt: "2026-03-15T00:00:00Z" }),
        ],
      })

      const data = await loadWakeUpData(services, {
        projectId: "p1",
        userQuery: "  fix auth\n  ",
        now: NOW,
      })

      expect(data.taskMemories.map((m) => m.id)).toEqual(["trim-hit"])
      const taskCall = services.memoriesSearchCalls[0]
      expect(taskCall?.query).toBe("fix auth")
    })

    it("truncates very long userQuery to 1000 chars before search", async () => {
      const longQuery = "auth ".repeat(1000) // 5000 chars
      const truncated = longQuery.slice(0, 1000)

      const services = stubServices({
        rawMemories: [],
        digestMemories: [],
        taskQuery: truncated,
        taskMemories: [
          buildMemory({ id: "long-hit", createdAt: "2026-03-15T00:00:00Z" }),
        ],
      })

      const data = await loadWakeUpData(services, {
        projectId: "p1",
        userQuery: longQuery,
        now: NOW,
      })

      expect(data.taskMemories.map((m) => m.id)).toEqual(["long-hit"])
      const taskCall = services.memoriesSearchCalls[0]
      expect(taskCall?.query.length).toBe(1000)
      expect(taskCall?.query).toBe(truncated)
    })

    it("dedupes taskMemories against digest, recent, and related", async () => {
      const fresh = buildMemory({
        id: "d1",
        title: "Fresh digest",
        source: "digest",
        createdAt: "2026-04-19T00:00:00Z",
      })
      const recent = buildMemory({
        id: "m0",
        title: "auth refactor in progress",
        createdAt: "2026-04-20T00:00:00Z",
      })
      const task = buildTask({
        id: "t-1",
        title: "auth",
        entity: "OIDC migration",
      })
      const relatedHit = buildMemory({
        id: "rel-hit",
        title: "Related: auth pipeline",
        createdAt: "2026-03-10T00:00:00Z",
      })
      // Task-search candidate set: digest dupe, recent dupe, related
      // dupe, and one fresh hit. Only the fresh one should survive.
      const taskCandidates = [
        buildMemory({ id: "d1", title: "dupe-digest", createdAt: "2026-04-19T00:00:00Z" }),
        buildMemory({ id: "m0", title: "dupe-recent", createdAt: "2026-04-20T00:00:00Z" }),
        buildMemory({ id: "rel-hit", title: "dupe-related", createdAt: "2026-03-10T00:00:00Z" }),
        buildMemory({
          id: "task-fresh",
          title: "Auth bug deep dive",
          createdAt: "2026-02-15T00:00:00Z",
        }),
      ]

      const services = stubServices({
        rawMemories: [recent],
        digestMemories: [fresh],
        relatedMemories: [relatedHit],
        taskQuery: "auth bug",
        taskMemories: taskCandidates,
        tasks: [task],
      })

      const data = await loadWakeUpData(services, {
        projectId: "p1",
        userQuery: "auth bug",
        now: NOW,
      })

      expect(data.digest?.id).toBe("d1")
      expect(data.memories.map((m) => m.id)).toEqual(["m0"])
      expect(data.relatedMemories.map((m) => m.id)).toEqual(["rel-hit"])
      expect(data.taskMemories.map((m) => m.id)).toEqual(["task-fresh"])
    })

    it("caps taskMemories at taskMemoryLimit (default 3)", async () => {
      const candidates = Array.from({ length: DEFAULT_WAKEUP_TASK_MEMORY_LIMIT + 5 }, (_, i) =>
        buildMemory({
          id: `task-${i}`,
          title: `Task hit ${i}`,
          createdAt: "2026-03-10T00:00:00Z",
        }),
      )
      const services = stubServices({
        rawMemories: [],
        digestMemories: [],
        taskQuery: "auth bug",
        taskMemories: candidates,
      })

      const data = await loadWakeUpData(services, {
        projectId: "p1",
        userQuery: "auth bug",
        now: NOW,
      })

      expect(data.taskMemories).toHaveLength(DEFAULT_WAKEUP_TASK_MEMORY_LIMIT)
    })

    it("skips the task search when taskMemoryLimit: 0 even with a userQuery", async () => {
      const services = stubServices({
        rawMemories: [],
        digestMemories: [],
        taskQuery: "auth bug",
        taskMemories: [
          buildMemory({ id: "should-not-appear", createdAt: "2026-03-15T00:00:00Z" }),
        ],
      })

      const data = await loadWakeUpData(services, {
        projectId: "p1",
        userQuery: "auth bug",
        taskMemoryLimit: 0,
        now: NOW,
      })

      expect(data.taskMemories).toEqual([])
      expect(services.memoriesSearchCalls).toEqual([])
    })

    it("honors caller-supplied taskMemoryLimit", async () => {
      const candidates = Array.from({ length: 10 }, (_, i) =>
        buildMemory({
          id: `task-${i}`,
          title: `Task hit ${i}`,
          createdAt: "2026-03-10T00:00:00Z",
        }),
      )
      const services = stubServices({
        rawMemories: [],
        digestMemories: [],
        taskQuery: "auth bug",
        taskMemories: candidates,
      })

      const data = await loadWakeUpData(services, {
        projectId: "p1",
        userQuery: "auth bug",
        taskMemoryLimit: 5,
        now: NOW,
      })

      expect(data.taskMemories).toHaveLength(5)
    })

    it("does not starve taskMemories when candidates are mostly duplicates", async () => {
      const fresh = buildMemory({
        id: "d1",
        source: "digest",
        createdAt: "2026-04-19T00:00:00Z",
      })
      const recents = Array.from({ length: 3 }, (_, i) =>
        buildMemory({ id: `m${i}`, createdAt: "2026-04-20T00:00:00Z" }),
      )
      // 3 dupes + 3 fresh hits = 6 candidates. fetchLimit must be >= 6.
      const candidates = [
        buildMemory({ id: "d1", title: "dupe-digest", createdAt: "2026-04-01T00:00:00Z" }),
        buildMemory({ id: "m0", title: "dupe-m0", createdAt: "2026-04-01T00:00:00Z" }),
        buildMemory({ id: "m1", title: "dupe-m1", createdAt: "2026-04-01T00:00:00Z" }),
        buildMemory({ id: "t1", title: "task-1", createdAt: "2026-04-01T00:00:00Z" }),
        buildMemory({ id: "t2", title: "task-2", createdAt: "2026-04-01T00:00:00Z" }),
        buildMemory({ id: "t3", title: "task-3", createdAt: "2026-04-01T00:00:00Z" }),
      ]
      const services = stubServices({
        rawMemories: recents,
        digestMemories: [fresh],
        taskQuery: "auth bug",
        taskMemories: candidates,
      })

      const data = await loadWakeUpData(services, {
        projectId: "p1",
        userQuery: "auth bug",
        taskMemoryLimit: 3,
        now: NOW,
      })

      expect(data.taskMemories.map((m) => m.id)).toEqual(["t1", "t2", "t3"])
    })

    it("forwards includeMemoryContent to the task-memory search", async () => {
      const services = stubServices({
        rawMemories: [],
        digestMemories: [],
        taskQuery: "auth bug",
        taskMemories: [],
      })

      await loadWakeUpData(services, {
        projectId: "p1",
        userQuery: "auth bug",
        includeMemoryContent: false,
        now: NOW,
      })

      const taskCall = services.memoriesSearchCalls[0]
      expect(taskCall?.includeContent).toBe(false)
    })

    it("skips task-search when no project is resolved", async () => {
      const services = stubServices({
        rawMemories: [],
        digestMemories: [],
        taskQuery: "auth bug",
        taskMemories: [
          buildMemory({ id: "should-not-appear", createdAt: "2026-03-10T00:00:00Z" }),
        ],
      })

      const data = await loadWakeUpData(services, {
        userQuery: "auth bug",
        now: NOW,
      })

      expect(data.taskMemories).toEqual([])
      expect(services.memoriesSearchCalls).toEqual([])
    })

    it("runs both task and related searches in the same wake-up", async () => {
      const task = buildTask({
        id: "t-1",
        title: "Outlook sync",
        entity: "Outlook sync",
      })
      const relatedHit = buildMemory({
        id: "rel-1",
        title: "Outlook sync runbook",
        createdAt: "2026-03-15T00:00:00Z",
      })
      const taskHit = buildMemory({
        id: "task-1",
        title: "Auth bug investigation",
        createdAt: "2026-03-10T00:00:00Z",
      })
      const services = stubServices({
        rawMemories: [],
        digestMemories: [],
        relatedMemories: [relatedHit],
        taskQuery: "fix the auth bug",
        taskMemories: [taskHit],
        tasks: [task],
      })

      const data = await loadWakeUpData(services, {
        projectId: "p1",
        userQuery: "fix the auth bug",
        now: NOW,
      })

      expect(data.relatedMemories.map((m) => m.id)).toEqual(["rel-1"])
      expect(data.taskMemories.map((m) => m.id)).toEqual(["task-1"])
      const queries = services.memoriesSearchCalls.map((c) => c.query)
      expect(queries).toContain("fix the auth bug")
      expect(queries.some((q) => q.includes("Outlook sync"))).toBe(true)
    })

    it("still runs both searches when userQuery topically overlaps a task", async () => {
      const task = buildTask({
        id: "t-1",
        title: "auth bug fix",
        entity: "OIDC integration",
      })
      const relatedHit = buildMemory({
        id: "rel-overlap",
        title: "auth bug related work",
        createdAt: "2026-03-15T00:00:00Z",
      })
      const taskHit = buildMemory({
        id: "task-overlap",
        title: "auth bug investigation",
        createdAt: "2026-03-10T00:00:00Z",
      })
      const services = stubServices({
        rawMemories: [],
        digestMemories: [],
        relatedMemories: [relatedHit],
        taskQuery: "auth bug fix",
        taskMemories: [taskHit],
        tasks: [task],
      })

      const data = await loadWakeUpData(services, {
        projectId: "p1",
        userQuery: "auth bug fix",
        now: NOW,
      })

      expect(data.taskMemories.map((m) => m.id)).toEqual(["task-overlap"])
      expect(data.relatedMemories.map((m) => m.id)).toEqual(["rel-overlap"])
      expect(services.memoriesSearchCalls).toHaveLength(2)
    })

    it.each([
      ["surrogate pair on boundary", "🦄"],
      ["surrogate pair before boundary", "🚀🚀"],
    ])(
      "%s — never produces a lone high surrogate after truncation",
      async (_label, padding) => {
        const TRUNCATION_LENGTH = 1000
        const paddingLen = padding.length
        const filler = "x".repeat(TRUNCATION_LENGTH - paddingLen + 1)
        const longQuery = filler + padding
        const services = stubServices({
          rawMemories: [],
          digestMemories: [],
          taskQuery: "ignored",
          taskMemories: [],
        })

        await loadWakeUpData(services, {
          projectId: "p1",
          userQuery: longQuery,
          now: NOW,
        })

        const taskCall = services.memoriesSearchCalls[0]
        expect(taskCall).toBeDefined()
        const last = taskCall!.query.charCodeAt(taskCall!.query.length - 1)
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
      },
    )
  })
})

describe("dateBucket", () => {
  it("classifies timestamps relative to `now`", () => {
    expect(dateBucket("2026-04-20T10:00:00Z", NOW)).toBe("Today")
    expect(dateBucket("2026-04-19T23:59:00Z", NOW)).toBe("Yesterday")
    expect(dateBucket("2026-04-10T00:00:00Z", NOW)).toBe("Earlier")
  })
})
