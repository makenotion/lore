import { describe, expect, it, vi } from "vitest"
import {
  DEFAULT_WAKEUP_KNOWLEDGE_FACT_LIMIT,
  DEFAULT_WAKEUP_MEMORY_LIMIT,
  DEFAULT_WAKEUP_MEMORY_LIMIT_WITH_DIGEST,
  DEFAULT_WAKEUP_RELATED_MEMORY_LIMIT,
  DEFAULT_WAKEUP_TASK_MEMORY_LIMIT,
  buildEmptyWakeUpCoverage,
  computeWakeUpCoverage,
  dateBucket,
  emptyWakeUpCoverageMetrics,
  formatWakeUpCoverage,
  formatWakeUpCoverageReport,
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
  MemoryKind,
  MemoryStatus,
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
    confidenceScore: null,
    reviewBy: null,
    doneAt: null,
    decidedAt: null,
    lastReferencedAt: null,
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
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
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
    createdAt: "2026-01-01T00:00:00.000Z",
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
    confidenceScore: null,
    reviewBy: null,
    doneAt: null,
    decidedAt: null,
    lastReferencedAt: null,
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
    taskState: "open",
    blockedBy: "",
    entity: overrides.entity ?? "",
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
  }
  return { ...base, ...overrides }
}

function buildDecision(
  overrides: Partial<DecisionSummary> & {
    id: string
    status: DecisionSummary["status"]
  },
): DecisionSummary {
  const base = buildMemory({
    id: overrides.id,
    kind: "decision",
    status: overrides.status,
    createdAt: overrides.createdAt ?? "2026-04-01T00:00:00Z",
  })
  return { ...base, ...overrides, kind: "decision", status: overrides.status }
}

function filterAndSortTasks(
  tasks: TaskSummary[],
  opts: ListTasksOpts,
): TaskSummary[] {
  const filtered = tasks.filter((task) => {
    if (opts.dueBefore && (!task.reviewBy || task.reviewBy > opts.dueBefore)) {
      return false
    }
    if (
      opts.dueAfterOrEmpty &&
      task.reviewBy &&
      task.reviewBy <= opts.dueAfterOrEmpty
    ) {
      return false
    }
    return true
  })
  return filtered.sort((a, b) => {
    if (opts.sortBy === "updatedAtAsc") {
      return compareIso(a.updatedAt, b.updatedAt) || compareReviewBy(a, b)
    }
    if (opts.sortBy === "updatedAtDesc") {
      return compareIso(b.updatedAt, a.updatedAt) || compareReviewBy(a, b)
    }
    return compareReviewBy(a, b)
  })
}

function compareIso(a: string, b: string): number {
  return a.localeCompare(b)
}

function compareReviewBy(a: TaskSummary, b: TaskSummary): number {
  const aDue = a.reviewBy ?? "\uffff"
  const bDue = b.reviewBy ?? "\uffff"
  return aDue.localeCompare(bDue) || b.createdAt.localeCompare(a.createdAt)
}

type ListCall = {
  projectId?: string
  source?: MemorySource
  status?: MemoryStatus
  excludeKinds?: MemoryKind[]
  limit?: number
  includeContent?: boolean
  includeUnscoped?: boolean
  includeProposed?: boolean
  sortBy?: "created_time" | "last_edited_time"
  direction?: "ascending" | "descending"
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

type StaleConfidenceCall = {
  projectId?: string
  limit: number
  today: string
}

interface StubServices extends WakeUpServices {
  memoriesCalls: ListCall[]
  memoriesSearchCalls: SearchCall[]
  factsListRecentCalls: ListRecentCall[]
  decisionsListCalls: ListDecisionsOpts[]
  decisionsOverdueCalls: Array<{ projectId?: string } | undefined>
  tasksListCalls: ListTasksOpts[]
  staleConfidenceCalls: StaleConfidenceCall[]
}

/**
 * Simulates Notion's server-side `Kind: { does_not_equal: <kind> }`
 * filter for stubbed `MemoryService.list` paths in this test suite.
 * Hoisted out of the per-test ad-hoc override so every stub-driven
 * `list` return shares one filter shape with production — if
 * `MemoryService.list`'s real `excludeKinds` semantics ever shift
 * (kind-aliasing, case sensitivity, alternate operator), exactly
 * one helper here moves in lockstep instead of N copies in N tests.
 *
 * Empty / undefined `excludeKinds` is a no-op pass-through. The
 * narrow type predicate keeps the test fixture stub-agnostic — the
 * helper applies cleanly to any `Memory[]` regardless of which
 * other props the fixture builder filled in.
 */
function applyExcludeKinds(
  items: Memory[],
  excludeKinds?: MemoryKind[],
): Memory[] {
  if (!excludeKinds || excludeKinds.length === 0) return items
  const exclude = new Set(excludeKinds)
  return items.filter((m) => !exclude.has(m.kind))
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
  staleConfidence?: Memory[]
  /**
   * Memories returned for the proposed-memory inbox query (issue #281,
   * AC #2). The wake-up data layer dispatches via
   * `services.memories.list({ status: "proposed", ... })`; this stub
   * routes that call to its own bucket so the test can distinguish
   * inbox responses from the recents query.
   */
  proposedMemories?: Memory[]
  /**
   * True inbox depth returned by `services.memories.countProposed`
   * for the wake-up section heading. Defaults to
   * `proposedMemories.length` (the no-saturation case); set
   * explicitly to simulate a deep inbox where the rendered slice is
   * smaller than the true total.
   */
  proposedMemoriesTotal?: number
} = {}): StubServices {
  const memoriesCalls: ListCall[] = []
  const memoriesSearchCalls: SearchCall[] = []
  const factsListRecentCalls: ListRecentCall[] = []
  const decisionsListCalls: ListDecisionsOpts[] = []
  const decisionsOverdueCalls: Array<{ projectId?: string } | undefined> = []
  const tasksListCalls: ListTasksOpts[] = []
  const staleConfidenceCalls: StaleConfidenceCall[] = []
  const factsResult = opts.facts ?? []

  return {
    memories: {
      list: vi.fn(async (args: ListCall) => {
        memoriesCalls.push(args)
        // Route to the right fixture bucket, then run `excludeKinds`
        // through the shared simulator so every list path applies the
        // production-shaped filter consistently (Notion's `Kind:
        // does_not_equal` server-side filter). Without the shared
        // helper, only the proposed-memory path used to apply the
        // filter; raw / digest paths would pass kinds the caller
        // explicitly excluded.
        if (args.source === "digest") {
          return { items: applyExcludeKinds(opts.digestMemories ?? [], args.excludeKinds) }
        }
        if (args.status === "proposed") {
          return { items: applyExcludeKinds(opts.proposedMemories ?? [], args.excludeKinds) }
        }
        return { items: applyExcludeKinds(opts.rawMemories ?? [], args.excludeKinds) }
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
      queryStaleConfidence: vi.fn(async (args: StaleConfidenceCall) => {
        staleConfidenceCalls.push(args)
        // Mirror the production `page_size: opts.limit` cap so a
        // fixture feeding more rows than the limit can authentically
        // simulate saturation.
        return (opts.staleConfidence ?? []).slice(0, args.limit)
      }),
      countProposed: vi.fn(async () => ({
        // Default to the slice length so tests that don't override
        // the inbox total see "rendered slice IS the inbox depth"
        // (matches the pre-#281-Phase-2-fix posture). Tests that
        // simulate saturation set `proposedMemoriesTotal` directly.
        total:
          opts.proposedMemoriesTotal ?? (opts.proposedMemories?.length ?? 0),
        bySource: {} as Record<string, number>,
        byAgent: {} as Record<string, number>,
      })),
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
        const all = filterAndSortTasks(opts.tasks ?? [], listOpts ?? {})
        const limit = listOpts?.limit
        const items =
          typeof limit === "number" && limit >= 0 ? all.slice(0, limit) : all
        return {
          items,
          nextCursor: items.length < all.length ? "next-cursor" : undefined,
        }
      }),
    },
    memoriesCalls,
    memoriesSearchCalls,
    factsListRecentCalls,
    decisionsListCalls,
    decisionsOverdueCalls,
    tasksListCalls,
    staleConfidenceCalls,
  }
}

describe("wake-up coverage counters", () => {
  it("computes ranked/default mode, section counts, and digest freshness", () => {
    const latestDigest = buildMemory({
      id: "digest",
      source: "digest",
      createdAt: "2026-04-19T12:00:00Z",
    })
    const recent = buildMemory({
      id: "recent",
      createdAt: "2026-04-20T00:00:00Z",
    })
    const related = buildMemory({
      id: "related",
      createdAt: "2026-04-18T00:00:00Z",
    })
    const taskMemory = buildMemory({
      id: "task-memory",
      createdAt: "2026-04-17T00:00:00Z",
    })
    const stale = buildMemory({
      id: "stale-confidence",
      createdAt: "2026-04-16T00:00:00Z",
    })

    const coverage = computeWakeUpCoverage({
      userQuery: "  Fix retrieval metrics  ",
      now: NOW,
      rankedSearchAttempted: true,
      latestDigest,
      memories: [recent],
      relatedMemories: [related],
      taskMemories: [taskMemory],
      tasks: [buildTask({ id: "task" })],
      knowledgeFacts: [buildFact({ id: "fact" })],
      proposedDecisions: [buildDecision({ id: "proposed", status: "proposed" })],
      overdueDecisions: [buildDecision({ id: "overdue", status: "accepted" })],
      staleConfidence: [stale],
    })

    expect(coverage.mode).toBe("ranked")
    expect(coverage.queryLength).toBe("Fix retrieval metrics".length)
    expect(coverage.digest).toEqual({ available: true, fresh: true, ageDays: 1 })
    expect(coverage.sectionCounts).toEqual({
      digest: 1,
      currentTaskMemories: 1,
      recentMemories: 1,
      relatedMemories: 1,
      tasks: 1,
      knowledgeFacts: 1,
      decisions: 2,
      proposedDecisions: 1,
      overdueDecisions: 1,
      proposedMemories: 0,
      staleConfidence: 1,
    })
  })

  it("reports stale digest availability without marking it fresh", () => {
    const staleDigest = buildMemory({
      id: "stale-digest",
      source: "digest",
      createdAt: "2026-04-01T00:00:00Z",
    })

    const coverage = computeWakeUpCoverage({
      userQuery: undefined,
      now: NOW,
      latestDigest: staleDigest,
      memories: [],
      relatedMemories: [],
      taskMemories: [],
      tasks: [],
      knowledgeFacts: [],
      proposedDecisions: [],
      overdueDecisions: [],
      staleConfidence: [],
    })

    expect(coverage.mode).toBe("default")
    expect(coverage.queryLength).toBe(0)
    expect(coverage.digest).toEqual({ available: true, fresh: false, ageDays: 19 })
    expect(coverage.sectionCounts.digest).toBe(0)
  })

  it("does not call a future-dated digest fresh or compute a negative age", () => {
    const futureDigest = buildMemory({
      id: "future-digest",
      source: "digest",
      createdAt: "2026-05-01T00:00:00Z",
    })

    const coverage = computeWakeUpCoverage({
      userQuery: "Fix retrieval metrics",
      now: NOW,
      rankedSearchAttempted: true,
      latestDigest: futureDigest,
      memories: [],
      relatedMemories: [],
      taskMemories: [],
      tasks: [],
      knowledgeFacts: [],
      proposedDecisions: [],
      overdueDecisions: [],
      staleConfidence: [],
    })

    expect(coverage.digest).toEqual({
      available: true,
      fresh: false,
      ageDays: null,
    })
    expect(coverage.sectionCounts.digest).toBe(0)
  })

  it("uses default mode when a user query exists but ranked search did not run", () => {
    const coverage = computeWakeUpCoverage({
      userQuery: "Fix retrieval metrics",
      now: NOW,
      rankedSearchAttempted: false,
      latestDigest: null,
      memories: [],
      relatedMemories: [],
      taskMemories: [],
      tasks: [],
      knowledgeFacts: [],
      proposedDecisions: [],
      overdueDecisions: [],
      staleConfidence: [],
    })

    expect(coverage.mode).toBe("default")
    expect(coverage.reason).toBe("no-ranked-search")
    expect(coverage.queryLength).toBe(0)
  })

  it("builds empty fixture coverage with focused overrides", () => {
    const coverage = buildEmptyWakeUpCoverage({
      digest: { available: true },
      sectionCounts: { tasks: 2 },
    })

    expect(coverage.mode).toBe("default")
    expect(coverage.queryLength).toBe(0)
    expect(coverage.digest).toEqual({
      available: true,
      fresh: false,
      ageDays: null,
    })
    expect(coverage.sectionCounts.tasks).toBe(2)
    expect(
      Object.entries(coverage.sectionCounts).filter(([, count]) => count !== 0),
    ).toEqual([["tasks", 2]])
  })

  it("formats one privacy-conscious debug line with caps and counts", () => {
    const line = formatWakeUpCoverage(
      buildEmptyWakeUpCoverage({
        mode: "ranked",
        queryLength: 42,
        digest: { available: true, fresh: true, ageDays: 2 },
        sectionCounts: {
          digest: 1,
          currentTaskMemories: 3,
          recentMemories: 2,
          relatedMemories: 1,
          tasks: 4,
          knowledgeFacts: 5,
          decisions: 6,
          proposedDecisions: 2,
          overdueDecisions: 4,
        },
      }),
      {
        memoryLimit: 3,
        relatedMemoryLimit: 2,
        knowledgeFactLimit: 10,
        taskMemoryLimit: 3,
      },
    )

    expect(line).toContain("mode=ranked")
    expect(line).toContain("ranked=true")
    expect(line).toContain("queryLen=42")
    expect(line).toContain("memory=3")
    expect(line).toContain("sections.currentTask=3")
    expect(line).toContain("sections.decisions=6")
    expect(line).toContain("digestAgeDays=2")
    expect(line).not.toContain("Fix retrieval metrics")
  })

  it("formats cache-hit and load-failed variants through the same vocabulary", () => {
    const cacheHit = formatWakeUpCoverage(
      emptyWakeUpCoverageMetrics("default", "already-ranked-for-session"),
    )
    const loadFailed = formatWakeUpCoverage(
      emptyWakeUpCoverageMetrics("error", "load-failed"),
    )

    expect(cacheHit).toContain("mode=default")
    expect(cacheHit).toContain("ranked=false")
    expect(cacheHit).toContain("reason=already-ranked-for-session")
    expect(cacheHit).toContain("sections.recent=0")
    expect(loadFailed).toContain("mode=error")
    expect(loadFailed).toContain("ranked=false")
    expect(loadFailed).toContain("reason=load-failed")
    expect(loadFailed).toContain("digestAvailable=false")
  })

  it("formats an operator-facing status report from the log formatter", () => {
    const coverage = computeWakeUpCoverage({
      now: NOW,
      latestDigest: null,
      memories: [
        buildMemory({
          id: "recent",
          createdAt: "2026-04-20T00:00:00Z",
        }),
      ],
      relatedMemories: [],
      taskMemories: [],
      tasks: [],
      knowledgeFacts: [],
      proposedDecisions: [],
      overdueDecisions: [],
      staleConfidence: [],
    })

    expect(formatWakeUpCoverageReport(coverage)).toEqual([
      "Wake-up coverage:",
      expect.stringContaining("[lore] wakeup: mode=default"),
    ])
  })
})

describe("loadWakeUpData", () => {
  it("skips coverage counters unless requested", async () => {
    const services = stubServices()
    const data = await loadWakeUpData(services, { projectId: "p1", now: NOW })

    expect(data.coverage).toBeNull()
  })

  it("returns coverage counters for the loaded wake-up sections when requested", async () => {
    const fresh = buildMemory({
      id: "digest",
      title: "Digest - 2026-04-19",
      source: "digest",
      createdAt: "2026-04-19T00:00:00Z",
    })
    const recent = buildMemory({
      id: "recent",
      title: "Recent work",
      createdAt: "2026-04-20T00:00:00Z",
    })
    const related = buildMemory({
      id: "related",
      title: "Related work",
      createdAt: "2026-04-18T00:00:00Z",
    })
    const taskMemory = buildMemory({
      id: "task-memory",
      title: "Current task work",
      createdAt: "2026-04-17T00:00:00Z",
    })
    const services = stubServices({
      rawMemories: [recent],
      digestMemories: [fresh],
      relatedMemories: [related],
      taskQuery: "Fix wake-up metrics",
      taskMemories: [taskMemory],
      tasks: [buildTask({ id: "task", entity: "wake-up metrics" })],
      facts: [buildFact({ id: "fact", predicate: "uses" })],
      proposedDecisions: [buildDecision({ id: "decision", status: "proposed" })],
    })

    const data = await loadWakeUpData(services, {
      projectId: "p1",
      userQuery: "Fix wake-up metrics",
      includeCoverage: true,
      now: NOW,
    })

    expect(data.coverage).not.toBeNull()
    if (!data.coverage) throw new Error("Expected coverage counters")
    expect(data.coverage.mode).toBe("ranked")
    expect(data.coverage.digest).toEqual({
      available: true,
      fresh: true,
      ageDays: 1,
    })
    expect(data.coverage.sectionCounts).toMatchObject({
      digest: 1,
      currentTaskMemories: 1,
      recentMemories: 1,
      relatedMemories: 1,
      tasks: 1,
      knowledgeFacts: 1,
      decisions: 1,
    })
  })

  it("reports rendered task coverage instead of the over-fetched task window", async () => {
    const activeTasks = Array.from({ length: 12 }, (_, i) =>
      buildTask({
        id: `active-${i}`,
        reviewBy: null,
        updatedAt: `2026-04-${String(19 - i).padStart(2, "0")}T00:00:00Z`,
      }),
    )
    const services = stubServices({ tasks: activeTasks })

    const data = await loadWakeUpData(services, {
      projectId: "p1",
      taskLimit: 2,
      includeCoverage: true,
      now: NOW,
    })

    expect(data.tasks).toHaveLength(8)
    expect(data.coverage?.sectionCounts.tasks).toBe(2)
  })

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

    const rawListCall = services.memoriesCalls.find((c) => c.source === undefined && c.status !== "proposed")
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

    const rawListCall = services.memoriesCalls.find((c) => c.source === undefined && c.status !== "proposed")
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

  it("skips the recent-memories query entirely when both memory limits are 0", async () => {
    // The recent-memories arm of the fan-out feeds two consumer paths
    // (digest at `memoryLimitWithDigest`, no-digest at `memoryLimit`).
    // Skipping requires BOTH to be zero — otherwise the digest path
    // silently under-renders. Gate matches sibling arms in the fan-out.
    const services = stubServices({
      rawMemories: [
        buildMemory({ id: "m1", createdAt: "2026-04-19T00:00:00Z" }),
      ],
      digestMemories: [],
    })

    const data = await loadWakeUpData(services, {
      projectId: "p1",
      memoryLimit: 0,
      memoryLimitWithDigest: 0,
      now: NOW,
    })

    const recentCalls = services.memoriesCalls.filter(
      (c) => c.source === undefined && c.status !== "proposed",
    )
    expect(recentCalls).toHaveLength(0)
    expect(data.memories).toEqual([])
  })

  it("still fires the recent-memories query when memoryLimitWithDigest > 0 even if memoryLimit is 0", async () => {
    // Pins the OR gate's correctness: a caller that wants zero
    // memories without a digest but N memories alongside one must NOT
    // see the query skipped.
    const services = stubServices({
      rawMemories: [
        buildMemory({ id: "m1", createdAt: "2026-04-19T00:00:00Z" }),
      ],
      digestMemories: [],
    })

    await loadWakeUpData(services, {
      projectId: "p1",
      memoryLimit: 0,
      memoryLimitWithDigest: 3,
      now: NOW,
    })

    const recentCalls = services.memoriesCalls.filter(
      (c) => c.source === undefined && c.status !== "proposed",
    )
    expect(recentCalls).toHaveLength(1)
  })

  it("skips the knowledge-facts query entirely when knowledgeFactLimit is 0", async () => {
    // The MCP schema documents `knowledgeFactLimit: 0` as "skips the
    // section." `clampNotionPageSize(0)` clamps up to 1, so without an
    // explicit short-circuit a project-scoped wake-up still pays the
    // Notion query and renders one fact — violating the contract.
    const services = stubServices({
      rawMemories: [],
      digestMemories: [],
      facts: [buildFact({ id: "f1", predicate: "uses" })],
    })

    const data = await loadWakeUpData(services, {
      projectId: "p1",
      knowledgeFactLimit: 0,
      now: NOW,
    })

    expect(services.facts.listRecent).not.toHaveBeenCalled()
    expect(data.knowledgeFacts).toEqual([])
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
        confidenceScore: null,
        reviewBy: null,
        doneAt: null,
        decidedAt: "2026-04-01",
        lastReferencedAt: null,
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
        createdAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-04-01T00:00:00Z",
        taskState: null,
        blockedBy: "",
        entity: "",
        topicKey: "",
        revisionCount: 1,
        comparedWith: [],
        compareNotes: "",
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

  it("populates proposedMemories from a status: 'proposed' memories.list call (issue #281, AC #2)", async () => {
    const proposed = [
      buildMemory({ id: "p1", createdAt: "2026-04-21T00:00:00Z" }),
      buildMemory({ id: "p2", createdAt: "2026-04-22T00:00:00Z" }),
    ]
    const services = stubServices({
      rawMemories: [],
      digestMemories: [],
      proposedMemories: proposed,
    })

    const data = await loadWakeUpData(services, { projectId: "p1", now: NOW })

    expect(data.proposedMemories.map((m) => m.id)).toEqual(["p1", "p2"])
    // The data layer routes through `memories.list({ status: "proposed" })`
    // — same precedent as `proposedDecisions`. Sort is `created_time
    // ascending` so the oldest unreviewed rows surface first; under
    // a saturated cap, newest rows roll off rather than oldest stale
    // review debt.
    const proposedCall = services.memoriesCalls.find((c) => c.status === "proposed")
    expect(proposedCall).toBeDefined()
    expect(proposedCall?.projectId).toBe("p1")
    expect(proposedCall?.limit).toBe(20)
    expect(proposedCall?.sortBy).toBe("created_time")
    expect(proposedCall?.direction).toBe("ascending")
    // Mirrors `proposedMemoryFilter()`'s `Kind != decision` clause so
    // the rendered slice and the count-driven section heading agree
    // on which rows count as inbox memories. Without this, a
    // proposed-Kind-`decision` row would inflate the slice but not
    // the count — heading-vs-slice drift the single-source-of-truth
    // helper exists to prevent.
    expect(proposedCall?.excludeKinds).toEqual(["decision"])
  })

  it("excludes Kind = decision from the inbox slice so heading and body agree", async () => {
    // Heading-vs-slice consistency under a kind-mixed vault.
    // `countProposed` uses `proposedMemoryFilter()` which filters
    // `Kind != decision`. The wake-up slice must apply the same
    // predicate so a proposed-decision row never renders in the
    // section body. The stub's `applyExcludeKinds` simulator (above)
    // mirrors Notion's `Kind: does_not_equal` server-side filter
    // for every list path, so this test asserts the slice path
    // passes `excludeKinds: ["decision"]` and lets the shared helper
    // drop the proposed-decision row.
    const proposedNote = buildMemory({
      id: "note-1",
      kind: "note",
      status: "proposed",
      createdAt: "2026-04-21T00:00:00Z",
    })
    const proposedDecision = buildMemory({
      id: "dec-1",
      kind: "decision",
      status: "proposed",
      createdAt: "2026-04-22T00:00:00Z",
    })

    const services = stubServices({
      rawMemories: [],
      digestMemories: [],
      proposedMemories: [proposedNote, proposedDecision],
    })

    const data = await loadWakeUpData(services, { projectId: "p1", now: NOW })

    expect(data.proposedMemories.map((m) => m.id)).toEqual(["note-1"])
    expect(data.proposedMemories).toHaveLength(1)
  })

  it("threads the true proposed-memory total via countProposed for the section heading", async () => {
    // Acceptance criterion: a 25-row inbox with a 20-row cap shows
    // `(25 pending review)` in the section heading and renders the
    // 20 oldest. Pinning that the data layer fans out a
    // `countProposed` call alongside the slice fetch and surfaces
    // the true total via `WakeUpData.proposedMemoriesTotal`.
    const sliced = [
      buildMemory({ id: "p1", createdAt: "2026-04-21T00:00:00Z" }),
      buildMemory({ id: "p2", createdAt: "2026-04-22T00:00:00Z" }),
    ]
    const services = stubServices({
      rawMemories: [],
      digestMemories: [],
      proposedMemories: sliced,
      proposedMemoriesTotal: 25,
    })

    const data = await loadWakeUpData(services, { projectId: "p1", now: NOW })

    expect(data.proposedMemoriesTotal).toBe(25)
    expect(data.proposedMemories).toHaveLength(2)
    expect(services.memories.countProposed).toHaveBeenCalledWith({ projectId: "p1" })
  })

  it("section count uses the true total, not the rendered slice", async () => {
    // `WakeUpSectionCounts.proposedMemories` must reflect inbox
    // depth so the MCP debug-coverage surfaces (`lore status`
    // coverage line, MCP `lore-context action='wake-up' debug=true`
    // output) report `sections.proposedMemories=25` for a 25-row
    // inbox even when only 20 rows fit in the rendered slice.
    // Operators most at risk of nudge fatigue should see depth.
    //
    // The shell hook (`src/hooks/helpers.ts`) intentionally passes
    // `includeProposedMemories: false`, so its `LORE_DEBUG=1` log
    // reports `sections.proposedMemories=0` by design. The depth
    // signal lives on the MCP and CLI status surfaces, not on the
    // hook log.
    const sliced = [buildMemory({ id: "p1", createdAt: "2026-04-21T00:00:00Z" })]
    const services = stubServices({
      rawMemories: [],
      digestMemories: [],
      proposedMemories: sliced,
      proposedMemoriesTotal: 25,
    })

    const data = await loadWakeUpData(services, {
      projectId: "p1",
      now: NOW,
      includeCoverage: true,
    })

    expect(data.coverage?.sectionCounts.proposedMemories).toBe(25)
  })

  it("skips countProposed alongside the slice when includeProposedMemories is false", async () => {
    // Hook wake-up doesn't render the section, so neither the slice
    // nor the count should fire. Same posture as `includeDecisions:
    // false`.
    const services = stubServices({
      rawMemories: [],
      digestMemories: [],
      proposedMemories: [buildMemory({ id: "p1", createdAt: "2026-04-21T00:00:00Z" })],
    })

    await loadWakeUpData(services, {
      projectId: "p1",
      includeProposedMemories: false,
      now: NOW,
    })

    expect(services.memories.countProposed).not.toHaveBeenCalled()
  })

  it("skips the proposed-memory query when includeProposedMemories is false", async () => {
    // Hook wake-up renders no inbox section — same posture as
    // `includeDecisions: false` and `includeStaleConfidence: false`.
    const services = stubServices({
      rawMemories: [],
      digestMemories: [],
      proposedMemories: [buildMemory({ id: "p1", createdAt: "2026-04-21T00:00:00Z" })],
    })

    const data = await loadWakeUpData(services, {
      projectId: "p1",
      includeProposedMemories: false,
      now: NOW,
    })

    expect(data.proposedMemories).toEqual([])
    const proposedCall = services.memoriesCalls.find((c) => c.status === "proposed")
    expect(proposedCall).toBeUndefined()
  })

  it("skips the proposed-memory query when proposedMemoryLimit is 0", async () => {
    // The numeric escape hatch — same shape as `taskLimit: 0`.
    const services = stubServices({ rawMemories: [], digestMemories: [] })

    await loadWakeUpData(services, {
      projectId: "p1",
      proposedMemoryLimit: 0,
      now: NOW,
    })

    const proposedCall = services.memoriesCalls.find((c) => c.status === "proposed")
    expect(proposedCall).toBeUndefined()
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

  describe("tasks over-fetch (issue 0.7.0/12)", () => {
    it("over-fetches each task bucket at min(taskLimit * 4, 100)", async () => {
      // The MCP renderer buckets tasks into Overdue / Stale / Active and
      // applies `taskLimit` per bucket. Each bucket gets a bounded 4×
      // window so wake-up can report hidden lower-bound counts without
      // letting one bucket's sort order hide another bucket entirely.
      const services = stubServices({ tasks: [] })

      await loadWakeUpData(services, { projectId: "p1", taskLimit: 10, now: NOW })

      expect(services.tasksListCalls.map((call) => call.limit)).toEqual([
        40,
        40,
        40,
      ])
      expect(services.tasksListCalls.map((call) => call.sortBy)).toEqual([
        "reviewByAsc",
        "updatedAtAsc",
        "updatedAtDesc",
      ])
    })

    it("clamps the over-fetch window to the Notion 100-row ceiling", async () => {
      // A caller passing `taskLimit: 50` would compute `50 * 4 = 200`
      // candidates without the clamp — twice Notion's per-page ceiling,
      // forcing pagination on the hot path. The data layer caps at 100
      // so wake-up never paginates regardless of caller config.
      const services = stubServices({ tasks: [] })

      await loadWakeUpData(services, { projectId: "p1", taskLimit: 50, now: NOW })

      expect(services.tasksListCalls.map((call) => call.limit)).toEqual([
        100,
        100,
        100,
      ])
    })

    it("skips the tasks query when taskLimit is 0", async () => {
      // The 0 case is the documented kill-switch for the Tasks section
      // — wake-up should not even ask Notion for rows it will never
      // render.
      const services = stubServices({ tasks: [] })

      await loadWakeUpData(services, { projectId: "p1", taskLimit: 0, now: NOW })

      expect(services.tasksListCalls).toEqual([])
    })

    it("returns the full over-fetched window so renderers see all three buckets", async () => {
      // Renderers bucket and slice; the data layer returns whatever
      // `services.tasks.list` produced. A fixture spanning all three
      // buckets must surface intact through the data layer for the
      // renderer's bucketing pass to do its job.
      const overdue = buildTask({
        id: "overdue-1",
        reviewBy: "2026-04-01",
        updatedAt: "2026-04-19T00:00:00Z",
      })
      const stale = buildTask({
        id: "stale-1",
        reviewBy: null,
        updatedAt: "2026-02-01T00:00:00Z",
      })
      const active = buildTask({
        id: "active-1",
        reviewBy: null,
        updatedAt: "2026-04-19T00:00:00Z",
      })
      const services = stubServices({ tasks: [overdue, stale, active] })

      const data = await loadWakeUpData(services, {
        projectId: "p1",
        taskLimit: 10,
        now: NOW,
      })

      expect(data.tasks.map((t) => t.id)).toEqual([
        "overdue-1",
        "stale-1",
        "active-1",
      ])
    })

    it("does not let due-dated tasks starve null-date stale and active tasks", async () => {
      const tasks: TaskSummary[] = []
      for (let i = 0; i < 41; i++) {
        tasks.push(
          buildTask({
            id: `overdue-${i}`,
            reviewBy: `2026-03-${String(20 - (i % 20)).padStart(2, "0")}`,
            updatedAt: "2026-04-19T00:00:00Z",
          }),
        )
      }
      for (let i = 0; i < 5; i++) {
        tasks.push(
          buildTask({
            id: `stale-${i}`,
            reviewBy: null,
            updatedAt: "2026-02-01T00:00:00Z",
          }),
        )
      }
      for (let i = 0; i < 5; i++) {
        tasks.push(
          buildTask({
            id: `active-${i}`,
            reviewBy: null,
            updatedAt: "2026-04-19T00:00:00Z",
          }),
        )
      }
      const services = stubServices({ tasks })

      const data = await loadWakeUpData(services, {
        projectId: "p1",
        taskLimit: 10,
        now: NOW,
      })

      expect(data.tasks.map((t) => t.id)).toContain("stale-0")
      expect(data.tasks.map((t) => t.id)).toContain("active-0")
      expect(data.taskBucketCoverage).toEqual({
        overdueCapped: true,
        staleCapped: false,
        activeCapped: false,
      })
    })
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
