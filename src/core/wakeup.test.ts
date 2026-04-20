import { describe, expect, it, vi } from "vitest"
import {
  DEFAULT_WAKEUP_KNOWLEDGE_FACT_LIMIT,
  DEFAULT_WAKEUP_MEMORY_LIMIT,
  DEFAULT_WAKEUP_MEMORY_LIMIT_WITH_DIGEST,
  dateBucket,
  loadWakeUpData,
  type WakeUpServices,
} from "./wakeup.js"
import type { Fact, FactPredicate, Memory, MemorySource } from "../types.js"

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

type QueryCall = { subject: string; opts?: { projectId?: string; predicates?: FactPredicate[]; limit?: number } }

interface StubServices extends WakeUpServices {
  memoriesCalls: ListCall[]
  factsCalls: QueryCall[]
}

function stubServices(opts: {
  rawMemories?: Memory[]
  digestMemories?: Memory[]
  facts?: Fact[]
}): StubServices {
  const memoriesCalls: ListCall[] = []
  const factsCalls: QueryCall[] = []
  const factsResult = opts.facts ?? []

  return {
    memories: {
      list: vi.fn(async (args: ListCall) => {
        memoriesCalls.push(args)
        if (args.source === "digest") return opts.digestMemories ?? []
        return opts.rawMemories ?? []
      }),
    },
    facts: {
      queryBySubject: vi.fn(async (subject: string, queryOpts) => {
        factsCalls.push({ subject, opts: queryOpts })
        return factsResult
      }),
    },
    memoriesCalls,
    factsCalls,
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

  it("skips digest and fact lookup when no project is resolved", async () => {
    const services = stubServices({ rawMemories: [], digestMemories: [] })

    const data = await loadWakeUpData(services, { now: NOW })

    expect(data.digest).toBeNull()
    expect(data.openLoops).toEqual([])
    expect(data.knowledgeFacts).toEqual([])
    expect(services.memoriesCalls.some((c) => c.source === "digest")).toBe(false)
    expect(services.facts.queryBySubject).not.toHaveBeenCalled()
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
})

describe("dateBucket", () => {
  it("classifies timestamps relative to `now`", () => {
    expect(dateBucket("2026-04-20T10:00:00Z", NOW)).toBe("Today")
    expect(dateBucket("2026-04-19T23:59:00Z", NOW)).toBe("Yesterday")
    expect(dateBucket("2026-04-10T00:00:00Z", NOW)).toBe("Earlier")
  })
})
