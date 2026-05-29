/**
 * Tests for the memory-debt scanner (issue #288).
 *
 * The scanner is a pure orchestrator over service methods, so the
 * tests stub each service surface with vi-mocked async functions and
 * assert on:
 *
 *  1. category detection — each detector fires when the underlying
 *     service surface returns matching rows;
 *  2. score ordering — P1 sorts above P2 above P3, score breaks ties
 *     within a priority, then deterministic by category and entityId;
 *  3. empty-vault path — every counter is zero and the items list is
 *     empty when no service surfaces anything;
 *  4. project scoping — `projectId` propagates through every service call;
 *  5. JSON contract — the shape stays self-describing and stable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LoreServices } from "../services.js"
import type { Decision, DecisionSummary, Fact, Memory, TaskSummary } from "../types.js"
import { findSimilarTopicGroups } from "./topic-merge.js"
import {
  DEBT_CATEGORIES,
  priorityForScore,
  scanDebt,
  type DebtCategory,
} from "./memory-debt.js"

// `findSimilarTopicGroups` walks Topics via `client.dataSources.query`
// directly; mocking the module-level export lets the scanner's
// `import { findSimilarTopicGroups } from "./topic-merge.js"` line pick
// up the test stub. Tests that need a real group set return one via
// `vi.mocked(findSimilarTopicGroups).mockResolvedValue(...)`.
vi.mock("./topic-merge.js", async () => {
  const actual =
    await vi.importActual<typeof import("./topic-merge.js")>("./topic-merge.js")
  return {
    ...actual,
    findSimilarTopicGroups: vi.fn(async () => []),
  }
})

beforeEach(() => {
  vi.mocked(findSimilarTopicGroups).mockResolvedValue([])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const TODAY = "2026-05-12"

function makeMemory(overrides: Partial<Memory> & { id: string; title: string }): Memory {
  return {
    projectIds: ["proj-a"],
    topicId: null,
    source: "manual",
    kind: "note",
    status: "informational",
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
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  }
}

function makeFact(overrides: Partial<Fact> & { id: string }): Fact {
  return {
    subject: "AuthService",
    predicate: "depends_on",
    object: "SessionStore",
    projectIds: ["proj-a"],
    validFrom: null,
    validUntil: null,
    reviewBy: null,
    sourceMemoryId: null,
    confidence: "likely",
    lastReferencedAt: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    subjectEntityId: null,
    objectEntityId: null,
    scope: null,
    ...overrides,
  }
}

interface StubOpts {
  orphanFacts?: Fact[]
  /**
   * Total orphan count (or sentinel-bumped count) the stubbed
   * `queryOrphans` reports back when the scanner threads its
   * `limit + 1` budget. Length comparison drives `orphanFactsCapped`
   * downstream of the slice, so a stub that simply returns `orphanFacts`
   * already exercises both code paths via `slice(0, limit)`.
   */
  overdueFacts?: Fact[]
  overdueDecisions?: DecisionSummary[]
  overdueTasks?: TaskSummary[]
  activeTasks?: TaskSummary[]
  /**
   * Multi-page active-task return for pagination regression tests.
   * Each entry corresponds to one `services.tasks.list` call; the
   * stub returns `{ items, nextCursor }` keyed by `startCursor` so
   * the scanner walks pages 0..N-1. Final page's `nextCursor` is
   * `undefined`.
   */
  activeTasksByPage?: TaskSummary[][]
  scanMemoriesByProject?: Memory[][]
  ownerlessMemories?: Memory[]
  operationalMemories?: Memory[]
  /** Multi-page operational-memory return. Same shape as `activeTasksByPage`. */
  operationalMemoriesByPage?: Memory[][]
  digestMemories?: Memory[]
  /** Multi-page digest-memory return. Same shape as `activeTasksByPage`. */
  digestMemoriesByPage?: Memory[][]
  summaryMemories?: Memory[]
  summaryMemoriesByPage?: Memory[][]
  tasksById?: Record<string, TaskSummary>
  /** Multi-page paginated ownerless-memory return. Same shape as `activeTasksByPage`. */
  ownerlessByPage?: Memory[][]
  similarTopicGroups?: Awaited<
    ReturnType<typeof import("./topic-merge.js").findSimilarTopicGroups>
  >
  projects?: Array<{ id: string; name: string }>
  scopeStats?:
    | {
        memories: {
          expired: number
          expiringSoon: number
          narrowScopeOutOfContext: number
        }
        facts: {
          expired: number
          expiringSoon: number
          narrowScopeOutOfContext: number
        }
      }
    | { throws: Error }
  /**
   * Simulate a pre-#283 vault by claiming `probeScopeColumnsPresent`
   * returns `false`. Without this knob the new explicit schema
   * probe in `safeLoadExpiringScopedStatus` would always observe
   * present columns and skip the degraded branch.
   *
   * Default: `true` (columns present, normal scan). Set to `false`
   * to exercise the pre-#283 degrade path. Tests that historically
   * threw `Could not find property: Scope Kind` from
   * `expiringScopedStats` should migrate to this flag — that throw
   * shape doesn't match real `listAllForBackfill` behavior on
   * pre-#283 vaults (extractors return `scope: null` silently).
   */
  scopeColumnsPresent?: boolean
}

function makeStubServices(opts: StubOpts = {}): LoreServices {
  const projects = opts.projects ?? [{ id: "proj-a", name: "Mail" }]
  const memoriesStub = {
    listForScan: vi.fn(async () => opts.scanMemoriesByProject ?? projects.map(() => [])),
    list: vi.fn(
      async (listOpts?: {
        startCursor?: string
        kind?: string
        source?: string
        includeOutOfScope?: boolean
        includeContent?: boolean
      }) => {
        if (listOpts?.kind === "operational") {
          if (
            opts.operationalMemoriesByPage &&
            opts.operationalMemoriesByPage.length > 0
          ) {
            const cursorIndex = listOpts.startCursor ? Number(listOpts.startCursor) : 0
            const page = opts.operationalMemoriesByPage[cursorIndex] ?? []
            const hasNext = cursorIndex + 1 < opts.operationalMemoriesByPage.length
            return {
              items: page,
              capped: false as const,
              ...(hasNext ? { nextCursor: String(cursorIndex + 1) } : {}),
            }
          }
          return {
            items: opts.operationalMemories ?? [],
            capped: false as const,
          }
        }
        if (listOpts?.source === "digest") {
          if (opts.digestMemoriesByPage && opts.digestMemoriesByPage.length > 0) {
            const cursorIndex = listOpts.startCursor ? Number(listOpts.startCursor) : 0
            const page = opts.digestMemoriesByPage[cursorIndex] ?? []
            const hasNext = cursorIndex + 1 < opts.digestMemoriesByPage.length
            return {
              items: page,
              capped: false as const,
              ...(hasNext ? { nextCursor: String(cursorIndex + 1) } : {}),
            }
          }
          return {
            items: opts.digestMemories ?? [],
            capped: false as const,
          }
        }
        if (listOpts?.includeOutOfScope === true && listOpts.includeContent === false) {
          if (opts.summaryMemoriesByPage && opts.summaryMemoriesByPage.length > 0) {
            const cursorIndex = listOpts.startCursor ? Number(listOpts.startCursor) : 0
            const page = opts.summaryMemoriesByPage[cursorIndex] ?? []
            const hasNext = cursorIndex + 1 < opts.summaryMemoriesByPage.length
            return {
              items: page,
              capped: false as const,
              ...(hasNext ? { nextCursor: String(cursorIndex + 1) } : {}),
            }
          }
          return {
            items: opts.summaryMemories ?? [],
            capped: false as const,
          }
        }
        if (opts.ownerlessByPage && opts.ownerlessByPage.length > 0) {
          const cursorIndex = listOpts?.startCursor ? Number(listOpts.startCursor) : 0
          const page = opts.ownerlessByPage[cursorIndex] ?? []
          const hasNext = cursorIndex + 1 < opts.ownerlessByPage.length
          return {
            items: page,
            capped: false as const,
            ...(hasNext ? { nextCursor: String(cursorIndex + 1) } : {}),
          }
        }
        return {
          items: opts.ownerlessMemories ?? [],
          capped: false as const,
        }
      }
    ),
    expiringScopedStats: vi.fn(async () => {
      if (opts.scopeStats && "throws" in opts.scopeStats) {
        throw opts.scopeStats.throws
      }
      return (
        opts.scopeStats?.memories ?? {
          expired: 0,
          expiringSoon: 0,
          narrowScopeOutOfContext: 0,
        }
      )
    }),
  }
  const factsStub = {
    queryOrphans: vi.fn(async () => opts.orphanFacts ?? []),
    queryOverdue: vi.fn(async () => opts.overdueFacts ?? []),
    expiringScopedStats: vi.fn(async () => {
      if (opts.scopeStats && "throws" in opts.scopeStats) {
        throw opts.scopeStats.throws
      }
      return (
        opts.scopeStats?.facts ?? {
          expired: 0,
          expiringSoon: 0,
          narrowScopeOutOfContext: 0,
        }
      )
    }),
  }
  const decisionsStub = {
    queryOverdue: vi.fn(async () => opts.overdueDecisions ?? []),
  }
  const tasksStub = {
    queryOverdue: vi.fn(async () => opts.overdueTasks ?? []),
    list: vi.fn(async (listOpts?: { startCursor?: string }) => {
      if (opts.activeTasksByPage && opts.activeTasksByPage.length > 0) {
        const cursorIndex = listOpts?.startCursor ? Number(listOpts.startCursor) : 0
        const page = opts.activeTasksByPage[cursorIndex] ?? []
        const hasNext = cursorIndex + 1 < opts.activeTasksByPage.length
        return {
          items: page,
          capped: false as const,
          ...(hasNext ? { nextCursor: String(cursorIndex + 1) } : {}),
        }
      }
      return {
        items: opts.activeTasks ?? [],
        capped: false as const,
      }
    }),
    getById: vi.fn(async (id: string) => {
      const task = opts.tasksById?.[id]
      if (!task) throw new Error(`Task not found: ${id}`)
      return task
    }),
    create: vi.fn(async () => undefined),
  }
  const projectsStub = {
    list: vi.fn(async () => projects),
  }
  const vault = {
    databases: {
      topics: { databaseId: "topics-db", dataSourceId: "topics-ds" },
      memories: { databaseId: "memories-db", dataSourceId: "memories-ds" },
      facts: { databaseId: "facts-db", dataSourceId: "facts-ds" },
    },
  }
  // `findSimilarTopicGroups` walks the Topics DB directly via
  // `client.dataSources.query`. Stub the call to return an empty page
  // so the topic-sprawl branch trivially yields no candidates unless a
  // test explicitly overrides via the import-namespace spy below.
  const topicPages = opts.similarTopicGroups ? [] : []
  // Stub `dataSources.retrieve` for the new explicit
  // `probeScopeColumnsPresent` check in `safeLoadExpiringScopedStatus`.
  // Default: pretend the #283 columns exist. `scopeColumnsPresent:
  // false` opts into the pre-#283 degrade path WITHOUT requiring the
  // stats walk to throw (the real failure shape).
  const columnsPresent = opts.scopeColumnsPresent !== false
  const buildSchemaProperties = (
    extras: Record<string, unknown> = {}
  ): Record<string, unknown> => {
    const base: Record<string, unknown> = {
      Name: {},
      Project: {},
      ...extras,
    }
    if (columnsPresent) {
      base["Scope Kind"] = { type: "select" }
      base["Expires At"] = { type: "date" }
    }
    return base
  }
  const client = {
    dataSources: {
      query: vi.fn(async () => ({
        results: topicPages,
        has_more: false,
        next_cursor: null,
      })),
      retrieve: vi.fn(async ({ data_source_id }: { data_source_id: string }) => {
        // Same property shape for memories + facts; the probe only
        // checks key presence, not select-option contents.
        return {
          id: data_source_id,
          properties: buildSchemaProperties(),
        }
      }),
    },
  }
  return {
    memories: memoriesStub,
    facts: factsStub,
    decisions: decisionsStub,
    tasks: tasksStub,
    projects: projectsStub,
    vault,
    client,
  } as unknown as LoreServices
}

describe("priorityForScore", () => {
  it("maps scores into P1/P2/P3 buckets at 70 and 40", () => {
    expect(priorityForScore(0)).toBe("P3")
    expect(priorityForScore(39)).toBe("P3")
    expect(priorityForScore(40)).toBe("P2")
    expect(priorityForScore(69)).toBe("P2")
    expect(priorityForScore(70)).toBe("P1")
    expect(priorityForScore(120)).toBe("P1")
  })
})

describe("scanDebt — empty vault", () => {
  it("returns zero items and a clean summary on an empty vault", async () => {
    const services = makeStubServices()
    const report = await scanDebt(services, { today: TODAY })
    expect(report.summary.total).toBe(0)
    expect(report.summary.p1).toBe(0)
    expect(report.summary.p2).toBe(0)
    expect(report.summary.p3).toBe(0)
    expect(report.items).toEqual([])
    for (const category of DEBT_CATEGORIES) {
      expect(report.summary.byCategory[category]).toBe(0)
    }
    expect(report.stats.truncated).toBe(false)
  })

  it("findSimilarTopicGroups is called by the scanner", async () => {
    const services = makeStubServices()
    await scanDebt(services, { today: TODAY })
    expect(vi.mocked(findSimilarTopicGroups)).toHaveBeenCalled()
  })
})

describe("scanDebt — category detection", () => {
  it("detects orphan facts and marks them P1", async () => {
    const orphan = makeFact({ id: "f1" })
    const services = makeStubServices({ orphanFacts: [orphan] })
    const report = await scanDebt(services, { today: TODAY })
    const items = report.items.filter((i) => i.category === "orphan_fact")
    expect(items.length).toBe(1)
    expect(items[0]!.priority).toBe("P1")
    expect(items[0]!.suggestedActions).toContain("attach_source")
  })

  it("detects overdue facts, decisions, and tasks together", async () => {
    const overdueFact = makeFact({ id: "f1", reviewBy: "2026-01-01" })
    const overdueDecision: DecisionSummary = makeMemory({
      id: "d1",
      title: "stale decision",
      kind: "decision",
      status: "accepted",
      reviewBy: "2026-01-01",
    }) as Decision
    const overdueTask: TaskSummary = makeMemory({
      id: "t1",
      title: "stale task",
      kind: "task",
      taskState: "open",
      reviewBy: "2026-01-01",
    }) as TaskSummary
    const services = makeStubServices({
      overdueFacts: [overdueFact],
      overdueDecisions: [overdueDecision],
      overdueTasks: [overdueTask],
    })
    const report = await scanDebt(services, { today: TODAY })
    const items = report.items.filter((i) => i.category === "overdue_governance")
    expect(items.length).toBe(3)
    expect(items.map((i) => i.entityType).sort()).toEqual(["decision", "fact", "task"])
  })

  it("detects duplicate clusters from findConflictCandidates over listForScan", async () => {
    // Two memories with high lexical overlap in the same project. The
    // conflict generator will pair them.
    const a = makeMemory({
      id: "m1",
      title: "PR label classifier false positives",
      keywords: "classifier pr labels",
      projectIds: ["proj-a"],
    })
    const b = makeMemory({
      id: "m2",
      title: "PR label classifier false positives v2",
      keywords: "classifier pr labels v2",
      projectIds: ["proj-a"],
    })
    const services = makeStubServices({
      scanMemoriesByProject: [[a, b]],
    })
    const report = await scanDebt(services, { today: TODAY })
    const items = report.items.filter((i) => i.category === "duplicate_cluster")
    expect(items.length).toBe(1)
    expect(items[0]!.id).toBe("duplicate_cluster::m1::m2")
  })

  it("excludes digest rows from duplicate_cluster title clustering", async () => {
    const first = makeMemory({
      id: "digest-1",
      title: "Digest — 2026-05-01 — Mail iOS",
      source: "digest",
      keywords: "mail ios digest",
      projectIds: ["proj-a"],
    })
    const second = makeMemory({
      id: "digest-2",
      title: "Digest — 2026-05-11 — Mail iOS",
      source: "digest",
      keywords: "mail ios digest",
      projectIds: ["proj-a"],
    })
    const services = makeStubServices({
      scanMemoriesByProject: [[first, second]],
    })
    const report = await scanDebt(services, { today: TODAY })
    expect(report.stats.duplicateClusterPairs).toBe(0)
    expect(report.items.filter((i) => i.category === "duplicate_cluster")).toEqual([])
  })

  it("skips already-compared pairs in duplicate_cluster", async () => {
    const a = makeMemory({
      id: "m1",
      title: "PR label classifier false positives",
      keywords: "classifier pr labels",
      projectIds: ["proj-a"],
      comparedWith: ["m2"],
    })
    const b = makeMemory({
      id: "m2",
      title: "PR label classifier false positives v2",
      keywords: "classifier pr labels v2",
      projectIds: ["proj-a"],
      comparedWith: ["m1"],
    })
    const services = makeStubServices({
      scanMemoriesByProject: [[a, b]],
    })
    const report = await scanDebt(services, { today: TODAY })
    expect(report.items.filter((i) => i.category === "duplicate_cluster")).toEqual([])
  })

  it("threads projectId into findSimilarTopicGroups on project-scoped scans", async () => {
    // Issue #585 review: a `lore debt scan --project Mail` must not
    // surface topic-sprawl groups from unrelated projects (e.g.
    // Calendar). The fix threads `opts.projectId` into the helper so
    // the underlying Topics-DS query filters server-side by
    // `Project relation contains <id>`.
    const services = makeStubServices()
    await scanDebt(services, {
      projectId: "proj-a",
      projectLabel: "Mail",
      today: TODAY,
    })
    expect(vi.mocked(findSimilarTopicGroups)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ projectId: "proj-a" })
    )
  })

  it("omits projectId on vault-wide scans (default vault-wide topic walk)", async () => {
    const services = makeStubServices()
    await scanDebt(services, { today: TODAY })
    const calls = vi.mocked(findSimilarTopicGroups).mock.calls
    const last = calls[calls.length - 1]
    // Third argument is the options bag; should NOT carry projectId.
    expect(last?.[2]).not.toHaveProperty("projectId")
  })

  it("detects topic sprawl from findSimilarTopicGroups", async () => {
    vi.mocked(findSimilarTopicGroups).mockResolvedValueOnce([
      {
        normalizedKey: "authentication",
        canonicalName: "Authentication",
        canonicalId: "topic-1",
        siblingIds: ["topic-2"],
        siblings: [{ id: "topic-2", name: "Auth" }],
      },
    ])
    const services = makeStubServices()
    const report = await scanDebt(services, { today: TODAY })
    const items = report.items.filter((i) => i.category === "topic_sprawl")
    expect(items.length).toBe(1)
    expect(items[0]!.entityType).toBe("topic")
    expect(items[0]!.suggestedActions).toContain("merge_topics_dry_run")
  })

  it("synthesizes scope_anomaly items from expiringScopedStats counters", async () => {
    const services = makeStubServices({
      scopeStats: {
        memories: {
          expired: 3,
          expiringSoon: 2,
          narrowScopeOutOfContext: 1,
        },
        facts: {
          expired: 1,
          expiringSoon: 0,
          narrowScopeOutOfContext: 0,
        },
      },
    })
    const report = await scanDebt(services, { today: TODAY })
    const items = report.items.filter((i) => i.category === "scope_anomaly")
    // Three buckets above zero: expired, expiringSoon, out_of_context.
    expect(items.length).toBe(3)
    expect(items.map((i) => i.entityId).sort()).toEqual([
      "expired",
      "expiring_soon",
      "out_of_context",
    ])
    expect(report.stats.scopeAnomalies).toBe(7)
  })

  it("degrades scope_anomaly to null on pre-#283 vaults (schema-probe path)", async () => {
    // Real shape: a pre-#283 vault's `MemoryService.expiringScopedStats`
    // does NOT throw — it walks `listAllForBackfill` and the extractors
    // return `scope: null` silently for missing columns. So the degraded
    // detection MUST come from an explicit schema probe, not from a
    // caught exception. `scopeColumnsPresent: false` simulates the
    // real failure mode by having `probeScopeColumnsPresent` (via the
    // stubbed `client.dataSources.retrieve`) report missing columns
    // even though the stats walkers would happily return all-zero
    // counters.
    const services = makeStubServices({
      scopeColumnsPresent: false,
      // Provide concrete counters that would otherwise count as a
      // "clean" probe (all zeros) — proving the degrade detection
      // beats the success path on a pre-#283 vault. Without the
      // schema-probe fix, this test would observe `scopeAnomalies:
      // 0` and pass a false-clean assertion.
      scopeStats: {
        memories: { expired: 0, expiringSoon: 0, narrowScopeOutOfContext: 0 },
        facts: { expired: 0, expiringSoon: 0, narrowScopeOutOfContext: 0 },
      },
    })
    const report = await scanDebt(services, { today: TODAY })
    expect(report.items.filter((i) => i.category === "scope_anomaly")).toEqual([])
    expect(report.stats.scopeAnomalies).toBeNull()
    expect(report.stats.scopeAnomalyProbeSkipped).toBe(false)
  })

  it("still detects degradation via the legacy exception-catching fallback", async () => {
    // Defensive secondary path: if a service implementation ever
    // does throw a `validation_error` with a missing-property
    // message, the scanner must still degrade cleanly. The shared
    // `isMissingPropertyError` helper from `src/notion/errors.ts`
    // checks BOTH the error code and the message shape, so unrelated
    // "page not found" errors don't get recast as a migration hint.
    const services = makeStubServices({
      // Columns present per the schema probe, but the stats walker
      // throws — an unusual but defensively-handled shape.
      scopeColumnsPresent: true,
      scopeStats: {
        throws: Object.assign(new Error("Could not find property: Scope Kind"), {
          code: "validation_error",
        }),
      },
    })
    const report = await scanDebt(services, { today: TODAY })
    expect(report.stats.scopeAnomalies).toBeNull()
  })

  it("detects operational memories with no expiry metadata", async () => {
    const operational = makeMemory({
      id: "op1",
      title: "poll state",
      kind: "operational",
      expiresOn: "",
    })
    const services = makeStubServices({ operationalMemories: [operational] })
    const report = await scanDebt(services, { today: TODAY })
    const items = report.items.filter((i) => i.category === "operational_expiry")
    expect(items.length).toBe(1)
    expect(items[0]!.suggestedActions).toContain("add_expires_at")
  })

  it("continues operational expiry auditing onto the next memory page", async () => {
    const scoped = makeMemory({
      id: "op-scoped",
      title: "temporary poll state",
      kind: "operational",
      expiresOn: "",
      scope: {
        kind: null,
        key: "",
        audience: "",
        lifetime: "expires",
        expiresAt: "2026-06-01",
      },
    })
    const missingExpiry = makeMemory({
      id: "op-missing",
      title: "second-page poll state",
      kind: "operational",
      expiresOn: "",
    })
    const services = makeStubServices({
      operationalMemoriesByPage: [[scoped], [missingExpiry]],
    })

    const report = await scanDebt(services, {
      today: TODAY,
      categories: ["operational_expiry"],
    })

    const items = report.items.filter((i) => i.category === "operational_expiry")
    expect(items.map((i) => i.entityId)).toEqual(["op-missing"])
    expect(report.stats.operationalMemoriesInspected).toBe(2)
  })

  it("detects operational memories whose linked task has closed", async () => {
    const task = makeMemory({
      id: "task-1",
      title: "close the loop",
      kind: "task",
      taskState: "done",
    }) as TaskSummary
    const operational = makeMemory({
      id: "op1",
      title: "task receipt",
      kind: "operational",
      expiresOn: "task-closed:task-1",
    })
    const services = makeStubServices({
      operationalMemories: [operational],
      tasksById: { "task-1": task },
    })
    const report = await scanDebt(services, { today: TODAY })
    const items = report.items.filter((i) => i.category === "operational_expiry")
    expect(items.length).toBe(1)
    expect(items[0]!.reasons.join(" ")).toContain("Linked task is done")
  })

  it("detects operational memories whose linked GitHub PR has closed", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ state: "closed", merged_at: null }),
    }))
    vi.stubGlobal("fetch", fetchMock)
    const operational = makeMemory({
      id: "op1",
      title: "pr receipt",
      kind: "operational",
      expiresOn: "pr-closed:Iron-Ham/lore#899",
    })
    const services = makeStubServices({ operationalMemories: [operational] })

    const report = await scanDebt(services, { today: TODAY })

    const items = report.items.filter((i) => i.category === "operational_expiry")
    expect(items.length).toBe(1)
    expect(items[0]!.reasons.join(" ")).toContain("Linked PR is closed")
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/Iron-Ham/lore/pulls/899",
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: "application/vnd.github+json",
          "user-agent": "lore-memory-debt-scan",
        }),
      })
    )
  })

  it("does not flag operational memories whose linked GitHub PR is still open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ state: "open", merged_at: null }),
      }))
    )
    const operational = makeMemory({
      id: "op1",
      title: "open pr receipt",
      kind: "operational",
      expiresOn: "pr-closed:Iron-Ham/lore#899",
    })
    const services = makeStubServices({ operationalMemories: [operational] })

    const report = await scanDebt(services, { today: TODAY })

    expect(report.items.filter((i) => i.category === "operational_expiry")).toEqual([])
  })

  it("detects log-shaped digest summaries", async () => {
    const digest = makeMemory({
      id: "d1",
      title: "daily digest",
      source: "digest",
      content:
        "Today we worked on the debt scanner. First we opened the issue. " +
        "Then we searched files. Next we edited code. Finally we ran tests.",
    })
    const services = makeStubServices({ digestMemories: [digest] })
    const report = await scanDebt(services, { today: TODAY })
    const items = report.items.filter((i) => i.category === "summary_quality")
    expect(items.length).toBe(1)
    expect(report.stats.logShapedSummaries).toBe(1)
  })

  it("continues digest quality auditing onto the next memory page", async () => {
    const durableDigest = makeMemory({
      id: "d-ok",
      title: "durable digest",
      source: "digest",
      content:
        "Decision: keep operational PR poll rows temporary. Rows must carry expiresAt or expiresOn so debt scan can archive stale coordination state.",
    })
    const logDigest = makeMemory({
      id: "d-log",
      title: "daily digest",
      source: "digest",
      content:
        "This session started with issue triage. First we searched files. Then we edited code. Next we ran tests. Finally we pushed.",
    })
    const services = makeStubServices({
      digestMemoriesByPage: [[durableDigest], [logDigest]],
    })

    const report = await scanDebt(services, {
      today: TODAY,
      categories: ["summary_quality"],
    })

    const items = report.items.filter((i) => i.category === "summary_quality")
    expect(items.map((i) => i.entityId)).toEqual(["d-log"])
    expect(report.stats.logShapedSummaries).toBe(1)
  })

  it("caps synopsis auditing by auditable candidates, not raw scanned rows", async () => {
    const blank = makeMemory({
      id: "blank",
      title: "blank synopsis",
      synopsis: "",
    })
    const logSynopsis = makeMemory({
      id: "s1",
      title: "autosave synopsis",
      synopsis:
        "This session started with issue triage. First we searched files, then we edited code, and finally we ran tests.",
    })
    const services = makeStubServices({
      summaryMemoriesByPage: [[blank], [logSynopsis]],
    })

    const report = await scanDebt(services, {
      today: TODAY,
      perCategoryLimit: 1,
      categories: ["summary_quality"],
    })

    const items = report.items.filter((i) => i.category === "summary_quality")
    expect(items.length).toBe(1)
    expect(items[0]!.entityId).toBe("s1")
    expect(report.stats.summaryQualityCandidates).toBe(1)
  })

  it("detects ownerless memories with no topic and no author/agent", async () => {
    const ownerless = makeMemory({
      id: "m1",
      title: "ownerless",
      topicId: null,
      projectIds: ["proj-a"],
      author: "",
      agent: "",
    })
    const services = makeStubServices({ ownerlessMemories: [ownerless] })
    const report = await scanDebt(services, { today: TODAY })
    const items = report.items.filter((i) => i.category === "ownerless")
    expect(items.length).toBe(1)
    expect(items[0]!.entityId).toBe("m1")
  })

  it("does NOT flag ownerless when author or agent is set", async () => {
    const owned = makeMemory({
      id: "m1",
      title: "owned",
      topicId: null,
      author: "Hesham",
      agent: "",
    })
    const services = makeStubServices({ ownerlessMemories: [owned] })
    const report = await scanDebt(services, { today: TODAY })
    expect(report.items.filter((i) => i.category === "ownerless")).toEqual([])
  })

  it("does NOT flag ownerless when projectIds is empty (vault-index notes)", async () => {
    const indexNote = makeMemory({
      id: "m1",
      title: "vault index",
      topicId: null,
      projectIds: [],
      author: "",
      agent: "",
    })
    const services = makeStubServices({ ownerlessMemories: [indexNote] })
    const report = await scanDebt(services, { today: TODAY })
    expect(report.items.filter((i) => i.category === "ownerless")).toEqual([])
  })
})

describe("scanDebt — sort and priority ordering", () => {
  it("sorts P1 above P2 above P3, then by score descending", async () => {
    const orphan = makeFact({
      id: "f1",
      projectIds: ["proj-a", "proj-b"],
    })
    const ownerless = makeMemory({
      id: "m1",
      title: "ownerless",
      topicId: null,
      projectIds: ["proj-a"],
      author: "",
      agent: "",
    })
    const services = makeStubServices({
      orphanFacts: [orphan],
      ownerlessMemories: [ownerless],
    })
    const report = await scanDebt(services, { today: TODAY })
    // Orphan fact has severityWeight 55 + governanceRisk 12 (policy) plus
    // retrieval risk, so it should outrank the ownerless memory
    // (severityWeight 15). Keep this comment in sync with
    // `SEVERITY_WEIGHT.orphan_fact` in `memory-debt.ts`.
    expect(report.items[0]!.category).toBe("orphan_fact")
    const ownerlessIndex = report.items.findIndex((i) => i.category === "ownerless")
    expect(ownerlessIndex).toBeGreaterThan(0)
  })

  it("breaks ties deterministically by entityId", async () => {
    const a = makeFact({ id: "f-aaa" })
    const b = makeFact({ id: "f-zzz" })
    const services = makeStubServices({ orphanFacts: [b, a] })
    const r1 = await scanDebt(services, { today: TODAY })
    const r2 = await scanDebt(services, { today: TODAY })
    expect(r1.items.map((i) => i.entityId)).toEqual(r2.items.map((i) => i.entityId))
    // Same-score same-category items sort by entityId ascending.
    const orphanIds = r1.items
      .filter((i) => i.category === "orphan_fact")
      .map((i) => i.entityId)
    expect(orphanIds).toEqual(["f-aaa", "f-zzz"])
  })

  it("truncates the items list to --limit and sets stats.truncated", async () => {
    const orphans = Array.from({ length: 50 }, (_, i) =>
      makeFact({ id: `f-${i.toString().padStart(2, "0")}` })
    )
    const services = makeStubServices({ orphanFacts: orphans })
    const report = await scanDebt(services, { today: TODAY, limit: 10 })
    expect(report.items.length).toBe(10)
    expect(report.stats.truncated).toBe(true)
  })
})

describe("scanDebt — project scoping", () => {
  it("passes projectId through to every service method", async () => {
    const services = makeStubServices()
    await scanDebt(services, {
      projectId: "proj-a",
      projectLabel: "Mail",
      today: TODAY,
    })
    expect(services.facts.queryOrphans).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-a" })
    )
    expect(services.facts.queryOverdue).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-a" })
    )
    expect(services.decisions.queryOverdue).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-a" })
    )
    expect(services.tasks.queryOverdue).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-a" })
    )
  })

  it("stamps the project label on the report when scoped", async () => {
    const services = makeStubServices()
    const report = await scanDebt(services, {
      projectId: "proj-a",
      projectLabel: "Mail",
      today: TODAY,
    })
    expect(report.project).toBe("Mail")
  })

  it("leaves project undefined on a vault-wide scan", async () => {
    const services = makeStubServices()
    const report = await scanDebt(services, { today: TODAY })
    expect(report.project).toBeUndefined()
  })
})

describe("scanDebt — category filter", () => {
  it("restricts detection to the named categories", async () => {
    const orphan = makeFact({ id: "f1" })
    const services = makeStubServices({
      orphanFacts: [orphan],
    })
    const report = await scanDebt(services, {
      categories: ["orphan_fact"],
      today: TODAY,
    })
    expect(report.items.length).toBe(1)
    expect(report.items[0]!.category).toBe("orphan_fact")
  })

  it("rejects unknown category names is the CLI's job — the core function trusts its inputs", async () => {
    // Sanity: pass a known-good category and verify items[].category matches.
    const orphan = makeFact({ id: "f1" })
    const services = makeStubServices({ orphanFacts: [orphan] })
    const valid: DebtCategory[] = ["orphan_fact"]
    const report = await scanDebt(services, { categories: valid, today: TODAY })
    expect(report.items.every((i) => i.category === "orphan_fact")).toBe(true)
  })

  it("does NOT mark scopeAnomalies as null when scope_anomaly is filtered out", async () => {
    // Issue #585 round-7 review blocker: a `--category orphan_fact`
    // scan must NOT leave `stats.scopeAnomalies = null` and trigger
    // the renderer's `lore migrate` prompt. The probe was skipped,
    // not degraded — those are different states. Default `0` +
    // `scopeAnomalyProbeSkipped: true` is the disambiguator.
    const services = makeStubServices()
    const report = await scanDebt(services, {
      categories: ["orphan_fact"],
      today: TODAY,
    })
    expect(report.stats.scopeAnomalies).toBe(0)
    expect(report.stats.scopeAnomalies).not.toBeNull()
    expect(report.stats.scopeAnomalyProbeSkipped).toBe(true)
    // Confirm the probe never fired — the load-bearing distinction.
    expect(services.memories.expiringScopedStats).not.toHaveBeenCalled()
    expect(services.facts.expiringScopedStats).not.toHaveBeenCalled()
  })

  it("sets scopeAnomalyProbeSkipped: false when the scope_anomaly category is selected", async () => {
    const services = makeStubServices()
    const report = await scanDebt(services, {
      categories: ["scope_anomaly"],
      today: TODAY,
    })
    expect(report.stats.scopeAnomalyProbeSkipped).toBe(false)
  })

  it("sets scopeAnomalyProbeSkipped: false on a vault-wide scan with no category filter", async () => {
    const services = makeStubServices()
    const report = await scanDebt(services, { today: TODAY })
    expect(report.stats.scopeAnomalyProbeSkipped).toBe(false)
  })
})

describe("scanDebt — bounded probes (issue #585 review)", () => {
  // The reviewer flagged three saturation bugs on the original PR:
  //   1. orphan_fact paginated to exhaustion and only then sliced
  //      `perCategoryLimit` — paying for every orphan in a large vault.
  //   2. stale-task probe inspected only the first 100-row page of
  //      `services.tasks.list`, ignoring `nextCursor` / `capped`. Default
  //      sort is review-by triage order, so old stale tasks could sit
  //      past page 1 and never get inspected.
  //   3. ownerless probe had the same single-page bug against
  //      `MemoryService.list`.
  //
  // Each test below pins the post-fix behavior: bounded fetch + cap
  // signal in stats, paginate via cursor, surface capped-scan flag.

  it("threads --per-category-limit + 1 into queryOrphans (bounded fetch)", async () => {
    const orphan = makeFact({ id: "f1" })
    const services = makeStubServices({ orphanFacts: [orphan] })
    await scanDebt(services, { today: TODAY, perCategoryLimit: 5 })
    expect(services.facts.queryOrphans).toHaveBeenCalledWith(
      // The "+1" sentinel disambiguates "exactly N orphans" from
      // "≥ N orphans, more exist past the inspected window."
      expect.objectContaining({ limit: 6 })
    )
  })

  it("flags orphanFactsCapped when the saturated sentinel comes back", async () => {
    // The stubbed `queryOrphans` returns whatever we give it. To simulate
    // "service hit the sentinel," return `perCategoryLimit + 1` orphans.
    const limit = 3
    const saturated = Array.from({ length: limit + 1 }, (_, i) =>
      makeFact({ id: `f-${i}` })
    )
    const services = makeStubServices({ orphanFacts: saturated })
    const report = await scanDebt(services, { today: TODAY, perCategoryLimit: limit })
    expect(report.stats.orphanFactsCapped).toBe(true)
    // Items list is sliced to perCategoryLimit, so the sentinel
    // does not leak into output ordering.
    const orphanItems = report.items.filter((i) => i.category === "orphan_fact")
    expect(orphanItems.length).toBe(limit)
  })

  it("clears orphanFactsCapped when fewer than perCategoryLimit + 1 orphans exist", async () => {
    const services = makeStubServices({
      orphanFacts: [makeFact({ id: "f1" }), makeFact({ id: "f2" })],
    })
    const report = await scanDebt(services, { today: TODAY, perCategoryLimit: 10 })
    expect(report.stats.orphanFactsCapped).toBe(false)
  })

  it("paginates the stale-task probe via nextCursor until empty", async () => {
    // Construct three pages of active tasks. Each row is stale (last
    // edited more than STALE_TASK_DAYS = 30 days before TODAY). The
    // scanner must walk all three pages, not stop after page 1.
    const oldUpdatedAt = "2026-02-01T00:00:00.000Z" // > 30 days before TODAY
    const page0 = [
      makeMemory({
        id: "t0a",
        title: "stale 0a",
        kind: "task",
        taskState: "open",
        updatedAt: oldUpdatedAt,
      }) as TaskSummary,
    ]
    const page1 = [
      makeMemory({
        id: "t1a",
        title: "stale 1a",
        kind: "task",
        taskState: "open",
        updatedAt: oldUpdatedAt,
      }) as TaskSummary,
    ]
    const page2 = [
      makeMemory({
        id: "t2a",
        title: "stale 2a",
        kind: "task",
        taskState: "open",
        updatedAt: oldUpdatedAt,
      }) as TaskSummary,
    ]
    const services = makeStubServices({ activeTasksByPage: [page0, page1, page2] })
    const report = await scanDebt(services, { today: TODAY, perCategoryLimit: 100 })
    expect(services.tasks.list).toHaveBeenCalledTimes(3)
    // Every page contributed a stale row, so the count is 3.
    expect(report.stats.staleTasks).toBe(3)
    expect(report.stats.staleTasksScanCapped).toBe(false)
  })

  it("requests stale-task pages in updatedAtAsc order", async () => {
    const services = makeStubServices({ activeTasksByPage: [[]] })
    await scanDebt(services, { today: TODAY, perCategoryLimit: 100 })
    // The first list() call must request the updatedAtAsc sort so the
    // oldest-edited rows are walked first — without this, a vault with
    // many active tasks would surface review-by triage order and the
    // scanner could miss stale rows past page 1.
    const firstCall = vi.mocked(services.tasks.list).mock.calls[0]?.[0]
    expect(firstCall).toMatchObject({ sortBy: "updatedAtAsc" })
  })

  it("sets staleTasksScanCapped when perCategoryLimit is reached before exhaustion", async () => {
    const oldUpdatedAt = "2026-02-01T00:00:00.000Z"
    // Pretend Notion has many pages — the scanner only inspects up to
    // perCategoryLimit rows then stops with the flag set.
    const buildPage = (prefix: string, n: number): TaskSummary[] =>
      Array.from(
        { length: n },
        (_, i) =>
          makeMemory({
            id: `${prefix}-${i}`,
            title: `stale ${prefix}-${i}`,
            kind: "task",
            taskState: "open",
            updatedAt: oldUpdatedAt,
          }) as TaskSummary
      )
    const services = makeStubServices({
      activeTasksByPage: [buildPage("a", 3), buildPage("b", 3), buildPage("c", 3)],
    })
    const report = await scanDebt(services, { today: TODAY, perCategoryLimit: 4 })
    expect(report.stats.staleTasksScanCapped).toBe(true)
  })

  it("stops the stale-task walk early when a non-stale row is encountered", async () => {
    // Ascending-updatedAt sort guarantees later rows are even less
    // stale. The optimizer pins this: once we see a row with
    // taskDaysStale < STALE_TASK_DAYS, every subsequent row is also
    // sub-threshold, so the walk can short-circuit.
    const recentUpdatedAt = `${TODAY}T00:00:00.000Z`
    const services = makeStubServices({
      activeTasksByPage: [
        [
          makeMemory({
            id: "t-fresh",
            title: "fresh",
            kind: "task",
            taskState: "open",
            updatedAt: recentUpdatedAt,
          }) as TaskSummary,
        ],
        [
          makeMemory({
            id: "t-later",
            title: "should not be inspected",
            kind: "task",
            taskState: "open",
            updatedAt: recentUpdatedAt,
          }) as TaskSummary,
        ],
      ],
    })
    await scanDebt(services, { today: TODAY, perCategoryLimit: 100 })
    // First page returned a fresh row → walk bails before fetching page 1.
    expect(services.tasks.list).toHaveBeenCalledTimes(1)
  })

  it("paginates the ownerless-memory probe via nextCursor until empty", async () => {
    const ownerless = (id: string) =>
      makeMemory({
        id,
        title: id,
        topicId: null,
        projectIds: ["proj-a"],
        author: "",
        agent: "",
      })
    const services = makeStubServices({
      ownerlessByPage: [[ownerless("m0")], [ownerless("m1")], [ownerless("m2")]],
    })
    const report = await scanDebt(services, { today: TODAY, perCategoryLimit: 100 })
    const ownerlessCalls = vi
      .mocked(services.memories.list)
      .mock.calls.filter(
        ([args]) => !args?.kind && !args?.source && args?.includeOutOfScope !== true
      )
    expect(ownerlessCalls.length).toBe(3)
    expect(report.stats.ownerlessMemories).toBe(3)
    expect(report.stats.ownerlessScanCapped).toBe(false)
  })

  it("sets ownerlessScanCapped when perCategoryLimit is reached", async () => {
    const ownerless = (id: string) =>
      makeMemory({
        id,
        title: id,
        topicId: null,
        projectIds: ["proj-a"],
        author: "",
        agent: "",
      })
    const services = makeStubServices({
      ownerlessByPage: [
        [ownerless("m0"), ownerless("m1"), ownerless("m2")],
        [ownerless("m3"), ownerless("m4")],
      ],
    })
    // perCategoryLimit < total => the second page is partially
    // consumed and the flag must fire.
    const report = await scanDebt(services, { today: TODAY, perCategoryLimit: 3 })
    expect(report.stats.ownerlessScanCapped).toBe(true)
  })
})

describe("scanDebt — JSON contract", () => {
  it("produces a stable top-level shape", async () => {
    const services = makeStubServices({
      orphanFacts: [makeFact({ id: "f1" })],
    })
    // Scope the report to a project so `project` is present in the
    // JSON round-trip — `JSON.stringify` drops keys with `undefined`
    // values, which would otherwise change the surfaced top-level
    // keys depending on whether the caller scoped or not.
    const report = await scanDebt(services, {
      projectId: "proj-a",
      projectLabel: "Mail",
      today: TODAY,
    })
    // JSON.parse + stringify round-trip yields the same shape — confirms
    // every field is a plain JSON value.
    const json = JSON.parse(JSON.stringify(report))
    expect(Object.keys(json).sort()).toEqual([
      "items",
      "project",
      "scannedAt",
      "stats",
      "summary",
      "today",
    ])
    expect(json.project).toBe("Mail")
    expect(Object.keys(json.summary).sort()).toEqual([
      "byCategory",
      "p1",
      "p2",
      "p3",
      "total",
    ])
    expect(Object.keys(json.summary.byCategory).sort()).toEqual(
      [...DEBT_CATEGORIES].sort()
    )
    expect(Object.keys(json.stats).sort()).toEqual([
      "duplicateClusterPairs",
      "logShapedSummaries",
      "operationalExpiryIssues",
      "operationalMemoriesInspected",
      "orphanFacts",
      "orphanFactsCapped",
      "overdueDecisions",
      "overdueFacts",
      "overdueTasks",
      "ownerlessMemories",
      "ownerlessScanCapped",
      "scopeAnomalies",
      "scopeAnomalyProbeSkipped",
      "similarTopicGroups",
      "staleTasks",
      "staleTasksScanCapped",
      "summaryQualityCandidates",
      "truncated",
    ])
    expect(json.items[0]).toEqual(
      expect.objectContaining({
        id: expect.stringContaining("orphan_fact::"),
        priority: expect.stringMatching(/^P[123]$/),
        category: "orphan_fact",
        entityType: "fact",
        entityId: "f1",
        title: expect.any(String),
        score: expect.any(Number),
        reasons: expect.any(Array),
        suggestedActions: expect.any(Array),
        safeToAutoFix: false,
      })
    )
  })
})
