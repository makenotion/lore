import { describe, expect, it, vi } from "vitest"
import {
  buildProposeProcedureInput,
  composeProcedureBody,
  composeProcedureKeywords,
  composeProcedureSynopsis,
  defaultProcedureTopicKey,
  findExistingProposedProcedure,
  findProcedureCandidates,
  PROCEDURE_KIND_DIVERSITY_BONUS,
  PROCEDURE_MIN_SOURCES,
  ProcedureSourceResolutionError,
  ProcedureTopicKeyConflictError,
  resolveProcedureSources,
  resolveProcedureSupersedesIds,
  sanitizeDeprecateReason,
  scoreCandidate,
  type ProcedureScanServices,
  type ProcedureSource,
} from "./procedure.js"
import type { Memory, TaskSummary } from "../types.js"

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "m1",
    title: "Memory 1",
    projectIds: ["proj-A"],
    topicId: null,
    source: "manual",
    kind: "incident",
    status: "accepted",
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
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    taskState: null,
    blockedBy: "",
    entity: "",
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
    scope: null,
    ...overrides,
  }
}

function makeTask(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "t1",
    title: "Task 1",
    projectIds: ["proj-A"],
    topicId: null,
    source: "manual",
    kind: "task",
    status: "informational",
    confidence: "certain",
    confidenceScore: null,
    reviewBy: null,
    doneAt: "2026-04-15",
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
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-15T00:00:00.000Z",
    taskState: "done",
    blockedBy: "",
    entity: "PR-1234",
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
    scope: null,
    ...overrides,
  }
}

function stubServices(args: {
  memoriesByKind?: Partial<Record<Memory["kind"], Memory[]>>
  tasks?: TaskSummary[]
}): ProcedureScanServices & {
  memoriesListMock: ReturnType<typeof vi.fn>
  tasksListMock: ReturnType<typeof vi.fn>
} {
  const memoriesListMock = vi.fn(async (opts?: { kind?: Memory["kind"] }) => {
    const items =
      opts?.kind && args.memoriesByKind?.[opts.kind]
        ? args.memoriesByKind[opts.kind]!
        : []
    return { items, nextCursor: undefined, capped: false }
  })
  const tasksListMock = vi.fn(async () => ({
    items: args.tasks ?? [],
    nextCursor: undefined,
    capped: false,
  }))
  return {
    memories: { list: memoriesListMock } as ProcedureScanServices["memories"],
    tasks: { list: tasksListMock } as ProcedureScanServices["tasks"],
    memoriesListMock,
    tasksListMock,
  }
}

describe("composeProcedureBody", () => {
  it("renders activation conditions, steps, failure modes, sources, and notes", () => {
    const body = composeProcedureBody({
      activationConditions: ["Entity matches PR #*", "Tags include performance"],
      steps: ["Check Grafana", "Inspect cache hit ratio"],
      failureModes: ["Do NOT restart the cache without coordination"],
      notes: "Borrowed from incident-2026-04-08 postmortem.",
      sourceMemoryIds: ["mem-A", "mem-B"],
    })
    expect(body).toContain("## Activation Conditions")
    expect(body).toContain("- Entity matches PR #*")
    expect(body).toContain("## Steps")
    expect(body).toContain("1. Check Grafana")
    expect(body).toContain("2. Inspect cache hit ratio")
    expect(body).toContain("## Known Failure Modes")
    expect(body).toContain("- Do NOT restart the cache without coordination")
    expect(body).toContain("## Notes")
    expect(body).toContain("Borrowed from incident-2026-04-08 postmortem.")
    expect(body).toContain("## Sources")
    expect(body).toContain("- mem-A")
    expect(body).toContain("- mem-B")
  })

  it("omits empty failure-modes and notes sections entirely", () => {
    const body = composeProcedureBody({
      activationConditions: ["always"],
      steps: ["step"],
      sourceMemoryIds: [],
    })
    expect(body).not.toContain("## Known Failure Modes")
    expect(body).not.toContain("## Notes")
    expect(body).toContain("## Sources")
    expect(body).toContain("- (no supporting memories)")
  })

  it("falls back to placeholder when no activation conditions are provided", () => {
    const body = composeProcedureBody({
      activationConditions: [],
      steps: ["just one"],
      sourceMemoryIds: ["m1"],
    })
    expect(body).toContain("## Activation Conditions\n- (none specified)")
  })
})

describe("composeProcedureKeywords", () => {
  it("includes the entity and the activation tokens", () => {
    const keywords = composeProcedureKeywords(
      ["Entity matches PR #*", "performance, caching"],
      "PR-1234"
    )
    expect(keywords).toContain("PR-1234")
    expect(keywords).toContain("performance")
    expect(keywords).toContain("caching")
    expect(keywords).toContain("Entity")
  })

  it("drops short tokens and dedupes", () => {
    const keywords = composeProcedureKeywords(["a b cd cd"], "")
    // 'a' and 'b' are too short; 'cd' is too short (length 2).
    expect(keywords).toBe("")
  })
})

describe("composeProcedureSynopsis", () => {
  it("includes step count plural and entity", () => {
    expect(composeProcedureSynopsis("PR-1234", 3)).toBe(
      'Reusable procedure for "PR-1234"; 3 steps.'
    )
    expect(composeProcedureSynopsis("PR-1234", 1)).toContain("1 step.")
  })

  it("renders no-entity variant", () => {
    expect(composeProcedureSynopsis("", 2)).toBe("Reusable procedure; 2 steps.")
  })
})

describe("defaultProcedureTopicKey", () => {
  it("derives from entity when present", () => {
    expect(defaultProcedureTopicKey("PR-1234", "Some title")).toBe("procedure/pr-1234")
  })

  it("falls back to title when entity is empty", () => {
    expect(defaultProcedureTopicKey("", "Cache miss runbook")).toBe(
      "procedure/cache-miss-runbook"
    )
  })

  it("returns empty when neither is usable", () => {
    expect(defaultProcedureTopicKey("a", "b")).toBe("")
  })
})

describe("scoreCandidate", () => {
  const today = "2026-05-12"

  it("scales with source count", () => {
    const make = (id: string, createdAt: string): ProcedureSource => ({
      memoryId: id,
      kind: "incident",
      title: id,
      createdAt,
      taskState: null,
    })
    const two = scoreCandidate([make("a", today), make("b", today)], 1, today)
    const three = scoreCandidate(
      [make("a", today), make("b", today), make("c", today)],
      1,
      today
    )
    expect(three).toBeGreaterThan(two)
  })

  it("rewards kind diversity", () => {
    const sources: ProcedureSource[] = [
      { memoryId: "a", kind: "incident", title: "a", createdAt: today, taskState: null },
      { memoryId: "b", kind: "incident", title: "b", createdAt: today, taskState: null },
    ]
    const same = scoreCandidate(sources, 1, today)
    const mixed = scoreCandidate(sources, 2, today)
    expect(mixed - same).toBeCloseTo(PROCEDURE_KIND_DIVERSITY_BONUS, 5)
  })

  it("decays with age", () => {
    const fresh: ProcedureSource = {
      memoryId: "a",
      kind: "incident",
      title: "a",
      createdAt: today,
      taskState: null,
    }
    const stale: ProcedureSource = {
      memoryId: "b",
      kind: "incident",
      title: "b",
      createdAt: "2025-10-01",
      taskState: null,
    }
    const freshScore = scoreCandidate([fresh, fresh], 1, today)
    const staleScore = scoreCandidate([stale, stale], 1, today)
    expect(freshScore).toBeGreaterThan(staleScore)
  })
})

describe("findProcedureCandidates", () => {
  it("returns clusters with at least PROCEDURE_MIN_SOURCES supporting memories", async () => {
    const services = stubServices({
      memoriesByKind: {
        incident: [
          makeMemory({
            id: "i1",
            title: "PR #1234 latency regression",
            kind: "incident",
            keywords: "PR-1234",
            createdAt: "2026-05-01T00:00:00.000Z",
          }),
          makeMemory({
            id: "i2",
            title: "PR #1234 second incident",
            kind: "incident",
            keywords: "PR-1234",
            createdAt: "2026-05-05T00:00:00.000Z",
          }),
        ],
      },
      tasks: [],
    })
    const out = await findProcedureCandidates(services, {
      projectId: "proj-A",
      today: "2026-05-12",
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.entity).toBe("PR #1234")
    expect(out[0]!.sources).toHaveLength(2)
    expect(out[0]!.suggestedTopicKey).toMatch(/^procedure\/pr-1234$/)
  })

  it("filters out singletons below PROCEDURE_MIN_SOURCES", async () => {
    expect(PROCEDURE_MIN_SOURCES).toBe(2)
    const services = stubServices({
      memoriesByKind: {
        incident: [
          makeMemory({
            id: "i1",
            title: "PR #9999 isolated",
            kind: "incident",
            keywords: "PR-9999",
          }),
        ],
      },
    })
    const out = await findProcedureCandidates(services, {
      projectId: "proj-A",
      today: "2026-05-12",
    })
    expect(out).toEqual([])
  })

  it("mixes incidents and resolved tasks into one cluster", async () => {
    const services = stubServices({
      memoriesByKind: {
        incident: [
          makeMemory({
            id: "i1",
            title: "PR #1234 latency regression",
            kind: "incident",
            keywords: "PR-1234",
            createdAt: "2026-05-01T00:00:00.000Z",
          }),
        ],
      },
      tasks: [makeTask({ id: "t1", entity: "PR-1234", title: "Fix PR-1234" })],
    })
    const out = await findProcedureCandidates(services, {
      projectId: "proj-A",
      today: "2026-05-12",
    })
    expect(out).toHaveLength(1)
    const sourceIds = out[0]!.sources.map((s) => s.memoryId).sort()
    expect(sourceIds).toEqual(["i1", "t1"])
    expect(out[0]!.kindDiversity).toBe(2)
  })

  it("skips superseded / deprecated rows", async () => {
    const services = stubServices({
      memoriesByKind: {
        incident: [
          makeMemory({
            id: "i1",
            title: "PR #1234 latency",
            kind: "incident",
            keywords: "PR-1234",
            status: "superseded",
          }),
          makeMemory({
            id: "i2",
            title: "PR #1234 latency redux",
            kind: "incident",
            keywords: "PR-1234",
            status: "deprecated",
          }),
        ],
      },
    })
    const out = await findProcedureCandidates(services, {
      projectId: "proj-A",
      today: "2026-05-12",
    })
    expect(out).toEqual([])
  })

  it("ranks higher-score clusters first", async () => {
    const services = stubServices({
      memoriesByKind: {
        incident: [
          makeMemory({
            id: "i1",
            title: "PR #1234 fresh incident",
            kind: "incident",
            keywords: "PR-1234",
            createdAt: "2026-05-10T00:00:00.000Z",
          }),
          makeMemory({
            id: "i2",
            title: "PR #1234 fresh followup",
            kind: "incident",
            keywords: "PR-1234",
            createdAt: "2026-05-11T00:00:00.000Z",
          }),
          makeMemory({
            id: "i3",
            title: "PR #9999 old",
            kind: "incident",
            keywords: "PR-9999",
            createdAt: "2025-08-01T00:00:00.000Z",
          }),
        ],
        postmortem: [
          makeMemory({
            id: "p1",
            title: "PR #9999 old postmortem",
            kind: "postmortem",
            keywords: "PR-9999",
            createdAt: "2025-08-15T00:00:00.000Z",
          }),
        ],
      },
    })
    const out = await findProcedureCandidates(services, {
      projectId: "proj-A",
      today: "2026-05-12",
    })
    expect(out.length).toBe(2)
    // Both clusters have 2 sources. PR-9999 has kind diversity (+0.5)
    // but PR-1234 has fresher sources (recency factor ~1.0 vs ~0.4).
    // Recency wins; PR-1234 ranks first.
    expect(out[0]!.clusterKey).toBe("pr-1234")
    expect(out[1]!.clusterKey).toBe("pr-9999")
  })

  it("respects the limit option", async () => {
    const services = stubServices({
      memoriesByKind: {
        incident: [
          makeMemory({
            id: "a1",
            title: "PR #1 first",
            kind: "incident",
            keywords: "PR-1",
          }),
          makeMemory({
            id: "a2",
            title: "PR #1 second",
            kind: "incident",
            keywords: "PR-1",
          }),
          makeMemory({
            id: "b1",
            title: "PR #2 first",
            kind: "incident",
            keywords: "PR-2",
          }),
          makeMemory({
            id: "b2",
            title: "PR #2 second",
            kind: "incident",
            keywords: "PR-2",
          }),
        ],
      },
    })
    const out = await findProcedureCandidates(services, {
      projectId: "proj-A",
      today: "2026-05-12",
      limit: 1,
    })
    expect(out).toHaveLength(1)
  })

  it("fetches every source kind in parallel", async () => {
    const services = stubServices({})
    await findProcedureCandidates(services, { projectId: "proj-A", today: "2026-05-12" })
    // Three source kinds (incident, postmortem, runbook) + tasks.
    expect(services.memoriesListMock).toHaveBeenCalledTimes(3)
    expect(services.tasksListMock).toHaveBeenCalledTimes(1)
  })
})

describe("buildProposeProcedureInput", () => {
  it("composes a CreateMemoryInput with kind=procedure status=proposed", () => {
    const input = buildProposeProcedureInput({
      title: "PR-1234 latency triage",
      entity: "PR-1234",
      body: {
        activationConditions: ["Entity matches PR-1234"],
        steps: ["check Grafana", "page oncall"],
        sourceMemoryIds: ["mem-A", "mem-B"],
      },
      projectIds: ["proj-A"],
    })
    expect(input.kind).toBe("procedure")
    expect(input.status).toBe("proposed")
    expect(input.title).toBe("PR-1234 latency triage")
    expect(input.projectIds).toEqual(["proj-A"])
    expect(input.topicKey).toBe("procedure/pr-1234")
    expect(input.content).toContain("## Activation Conditions")
    expect(input.content).toContain("## Steps")
    expect(input.content).toContain("## Sources")
    expect(input.keywords).toContain("PR-1234")
    expect(input.synopsis).toContain("PR-1234")
  })

  it("rejects empty title before any side effect", () => {
    expect(() =>
      buildProposeProcedureInput({
        title: "   ",
        entity: "PR-1234",
        body: { activationConditions: [], steps: [], sourceMemoryIds: [] },
        projectIds: ["proj-A"],
      })
    ).toThrow(/non-empty/i)
  })

  it("honors caller-supplied topicKey", () => {
    const input = buildProposeProcedureInput({
      title: "Cache miss procedure",
      entity: "Cache",
      body: { activationConditions: [], steps: [], sourceMemoryIds: [] },
      projectIds: ["proj-A"],
      topicKey: "procedure/cache-strategy",
    })
    expect(input.topicKey).toBe("procedure/cache-strategy")
  })

  it("threads supersedesIds onto the CreateMemoryInput", () => {
    const input = buildProposeProcedureInput({
      title: "Replacement procedure",
      entity: "Cache",
      body: { activationConditions: [], steps: [], sourceMemoryIds: [] },
      projectIds: ["proj-A"],
      supersedesIds: ["old-runbook-id"],
    })
    expect(input.supersedesIds).toEqual(["old-runbook-id"])
  })

  it("throws when entity + title both normalize to empty (defensive belt-and-braces)", () => {
    expect(() =>
      buildProposeProcedureInput({
        title: "!!!",
        entity: "???",
        body: {
          activationConditions: [],
          steps: [],
          sourceMemoryIds: [],
        },
        projectIds: ["proj-A"],
      })
    ).toThrow(/topic key cannot be empty/i)
  })

  it("dedups sourceMemoryIds before rendering the ## Sources section", () => {
    const input = buildProposeProcedureInput({
      title: "Dedup test",
      entity: "PR-1234",
      body: {
        activationConditions: [],
        steps: ["one"],
        sourceMemoryIds: ["mem-A", "mem-B", "mem-A"],
      },
      projectIds: ["proj-A"],
    })
    // The composed body should only contain "mem-A" once.
    const sourceMatches = input.content.match(/- mem-A/g) ?? []
    expect(sourceMatches.length).toBe(1)
    expect(input.content).toContain("- mem-B")
  })

  it("dedups supersedesIds symmetric with sourceMemoryIds", () => {
    // Notion dedupes relations on the wire so the database side is
    // safe; the invariant is that internal callers can't double-
    // paste regardless of the network layer's behavior.
    const input = buildProposeProcedureInput({
      title: "Dedup test",
      entity: "PR-1234",
      body: {
        activationConditions: [],
        steps: ["one"],
        sourceMemoryIds: ["mem-A", "mem-B"],
      },
      projectIds: ["proj-A"],
      supersedesIds: ["old-1", "old-2", "old-1"],
    })
    expect(input.supersedesIds).toEqual(["old-1", "old-2"])
  })
})

describe("resolveProcedureSources", () => {
  function makeStubServices(memoriesById: Record<string, Memory | Error>) {
    return {
      memories: {
        getById: vi.fn(async (id: string) => {
          const entry = memoriesById[id]
          if (entry instanceof Error) throw entry
          if (!entry) throw new Error(`stub: id ${id} not configured`)
          return entry
        }),
      },
    }
  }

  it("resolves valid sources and returns them in input order (post-dedup)", async () => {
    const services = makeStubServices({
      "id-a": makeMemory({
        id: "id-a",
        kind: "incident",
        status: "accepted",
        projectIds: ["proj-A"],
      }),
      "id-b": makeMemory({
        id: "id-b",
        kind: "postmortem",
        status: "accepted",
        projectIds: ["proj-A"],
      }),
    })
    const resolved = await resolveProcedureSources(services, ["id-a", "id-b"], ["proj-A"])
    expect(resolved.map((r) => r.memoryId)).toEqual(["id-a", "id-b"])
  })

  it("dedups identical ids before counting against PROCEDURE_MIN_SOURCES", async () => {
    const services = makeStubServices({
      "id-a": makeMemory({
        id: "id-a",
        kind: "incident",
        status: "accepted",
        projectIds: ["proj-A"],
      }),
    })
    // Two copies of the same id should NOT pass the count gate.
    await expect(
      resolveProcedureSources(services, ["id-a", "id-a"], ["proj-A"])
    ).rejects.toThrow(ProcedureSourceResolutionError)
  })

  it("rejects when a source memory lookup fails", async () => {
    const services = makeStubServices({
      "id-a": makeMemory({
        id: "id-a",
        kind: "incident",
        status: "accepted",
        projectIds: ["proj-A"],
      }),
      "id-b": new Error("Notion 404"),
    })
    await expect(
      resolveProcedureSources(services, ["id-a", "id-b"], ["proj-A"])
    ).rejects.toMatchObject({
      name: "ProcedureSourceResolutionError",
      memoryIds: ["id-b"],
    })
  })

  it("rejects when a source memory has an incompatible kind", async () => {
    const services = makeStubServices({
      "id-a": makeMemory({
        id: "id-a",
        kind: "incident",
        status: "accepted",
        projectIds: ["proj-A"],
      }),
      "id-b": makeMemory({
        id: "id-b",
        kind: "decision",
        status: "accepted",
        projectIds: ["proj-A"],
      }),
    })
    await expect(
      resolveProcedureSources(services, ["id-a", "id-b"], ["proj-A"])
    ).rejects.toThrow(/kind 'decision' is not a valid procedure source/)
  })

  it("rejects when a source memory has rejected/superseded/deprecated status", async () => {
    const services = makeStubServices({
      "id-a": makeMemory({
        id: "id-a",
        kind: "incident",
        status: "accepted",
        projectIds: ["proj-A"],
      }),
      "id-b": makeMemory({
        id: "id-b",
        kind: "incident",
        status: "rejected",
        projectIds: ["proj-A"],
      }),
    })
    await expect(
      resolveProcedureSources(services, ["id-a", "id-b"], ["proj-A"])
    ).rejects.toThrow(/status 'rejected' disqualifies/)
  })

  it("rejects when a source memory's project scope does not overlap target", async () => {
    const services = makeStubServices({
      "id-a": makeMemory({
        id: "id-a",
        kind: "incident",
        status: "accepted",
        projectIds: ["proj-A"],
      }),
      "id-b": makeMemory({
        id: "id-b",
        kind: "incident",
        status: "accepted",
        projectIds: ["proj-OTHER"],
      }),
    })
    await expect(
      resolveProcedureSources(services, ["id-a", "id-b"], ["proj-A"])
    ).rejects.toThrow(/does not overlap/)
  })

  it("does not echo source projectIds verbatim in scope-mismatch errors", async () => {
    // Defense-in-depth: the operator authenticated via Notion's
    // permission model already owns the source row, so a leak isn't
    // a bearer-secret class violation — but the error message should
    // not enumerate project ids the caller chose not to query.
    const services = makeStubServices({
      "id-a": makeMemory({
        id: "id-a",
        kind: "incident",
        status: "accepted",
        projectIds: ["proj-A"],
      }),
      "id-b": makeMemory({
        id: "id-b",
        kind: "incident",
        status: "accepted",
        projectIds: ["proj-SECRET-NAME-WHO-KNOWS-WHAT"],
      }),
    })
    try {
      await resolveProcedureSources(services, ["id-a", "id-b"], ["proj-A"])
      expect.unreachable("expected ProcedureSourceResolutionError")
    } catch (err) {
      const message = (err as Error).message
      expect(message).not.toContain("proj-SECRET-NAME-WHO-KNOWS-WHAT")
    }
  })

  it("accepts an unscoped (repo-wide) source against any target project", async () => {
    // `projectIds: []` means repo-wide / unscoped — acceptable for
    // any project's procedure (the cross-scope reuse the trigram
    // probe already documents).
    const services = makeStubServices({
      "id-a": makeMemory({
        id: "id-a",
        kind: "incident",
        status: "accepted",
        projectIds: [],
      }),
      "id-b": makeMemory({
        id: "id-b",
        kind: "incident",
        status: "accepted",
        projectIds: ["proj-A"],
      }),
    })
    const resolved = await resolveProcedureSources(services, ["id-a", "id-b"], ["proj-A"])
    expect(resolved).toHaveLength(2)
  })

  it("rejects a task source whose state is not done/cancelled", async () => {
    const services = makeStubServices({
      "id-a": makeMemory({
        id: "id-a",
        kind: "incident",
        status: "accepted",
        projectIds: ["proj-A"],
      }),
      "id-b": makeMemory({
        id: "id-b",
        kind: "task",
        status: "accepted",
        projectIds: ["proj-A"],
        taskState: "open",
      }),
    })
    await expect(
      resolveProcedureSources(services, ["id-a", "id-b"], ["proj-A"])
    ).rejects.toThrow(/task is open, not closed/)
  })

  it("rejects a task source with taskState: null", async () => {
    // `pageToMemory` returns `taskState: null` when the Task State
    // select column is missing (legacy rows from before the column
    // existed, or a Notion-side edit that cleared it). A two-way
    // `mem.taskState && !allowed.has(mem.taskState)` short-circuits
    // on null and lets the row count as valid evidence. The gate
    // requires both `taskState !== null` AND in the closed-states
    // allow-list.
    const services = makeStubServices({
      "id-a": makeMemory({
        id: "id-a",
        kind: "incident",
        status: "accepted",
        projectIds: ["proj-A"],
      }),
      "id-b": makeMemory({
        id: "id-b",
        kind: "task",
        status: "accepted",
        projectIds: ["proj-A"],
        taskState: null,
      }),
    })
    await expect(
      resolveProcedureSources(services, ["id-a", "id-b"], ["proj-A"])
    ).rejects.toThrow(/task has no Task State/)
  })

  it("accepts a closed task source", async () => {
    const services = makeStubServices({
      "id-a": makeMemory({
        id: "id-a",
        kind: "incident",
        status: "accepted",
        projectIds: ["proj-A"],
      }),
      "id-b": makeMemory({
        id: "id-b",
        kind: "task",
        status: "accepted",
        projectIds: ["proj-A"],
        taskState: "done",
      }),
    })
    const resolved = await resolveProcedureSources(services, ["id-a", "id-b"], ["proj-A"])
    expect(resolved.map((r) => r.kind)).toEqual(["incident", "task"])
  })
})

describe("resolveProcedureSupersedesIds", () => {
  function makeStubServices(memoriesById: Record<string, Memory | Error>) {
    return {
      memories: {
        getById: vi.fn(async (id: string) => {
          const entry = memoriesById[id]
          if (entry instanceof Error) throw entry
          if (!entry) throw new Error(`stub: id ${id} not configured`)
          return entry
        }),
      },
    }
  }

  it("accepts live procedure and runbook supersedes targets", async () => {
    const services = makeStubServices({
      "id-a": makeMemory({
        id: "id-a",
        kind: "procedure",
        status: "accepted",
        projectIds: ["proj-A"],
      }),
      "id-b": makeMemory({
        id: "id-b",
        kind: "runbook",
        status: "accepted",
        projectIds: ["proj-A"],
      }),
    })
    const resolved = await resolveProcedureSupersedesIds(
      services,
      ["id-a", "id-b"],
      ["proj-A"]
    )
    expect(resolved.map((r) => r.kind)).toEqual(["procedure", "runbook"])
  })

  it("rejects a typo / non-existent id (lookup failure)", async () => {
    const services = makeStubServices({
      "id-a": makeMemory({
        id: "id-a",
        kind: "procedure",
        status: "accepted",
        projectIds: ["proj-A"],
      }),
      typo: new Error("Notion 404"),
    })
    await expect(
      resolveProcedureSupersedesIds(services, ["typo"], ["proj-A"])
    ).rejects.toThrow(ProcedureSourceResolutionError)
  })

  it("rejects an incompatible-kind supersedes target", async () => {
    const services = makeStubServices({
      "id-a": makeMemory({
        id: "id-a",
        kind: "incident",
        status: "accepted",
        projectIds: ["proj-A"],
      }),
    })
    await expect(
      resolveProcedureSupersedesIds(services, ["id-a"], ["proj-A"])
    ).rejects.toThrow(/kind 'incident' is not a valid supersedesIds target/)
  })

  it("rejects a rejected-status supersedes target", async () => {
    const services = makeStubServices({
      "id-a": makeMemory({
        id: "id-a",
        kind: "procedure",
        status: "rejected",
        projectIds: ["proj-A"],
      }),
    })
    await expect(
      resolveProcedureSupersedesIds(services, ["id-a"], ["proj-A"])
    ).rejects.toThrow(/status 'rejected' disqualifies/)
  })

  it("rejects a supersedes target whose project scope does not overlap", async () => {
    const services = makeStubServices({
      "id-a": makeMemory({
        id: "id-a",
        kind: "procedure",
        status: "accepted",
        projectIds: ["proj-OTHER"],
      }),
    })
    await expect(
      resolveProcedureSupersedesIds(services, ["id-a"], ["proj-A"])
    ).rejects.toThrow(/does not overlap/)
  })

  it("dedups identical ids before lookups", async () => {
    const get = vi.fn(
      async (id: string): Promise<Memory> =>
        makeMemory({ id, kind: "procedure", status: "accepted", projectIds: ["proj-A"] })
    )
    const services = { memories: { getById: get } }
    const resolved = await resolveProcedureSupersedesIds(
      services,
      ["dup", "dup"],
      ["proj-A"]
    )
    expect(resolved).toHaveLength(1)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it("returns empty array on empty input (skips Notion calls)", async () => {
    const get = vi.fn()
    const services = { memories: { getById: get } }
    const resolved = await resolveProcedureSupersedesIds(services, [], ["proj-A"])
    expect(resolved).toEqual([])
    expect(get).not.toHaveBeenCalled()
  })
})

describe("findExistingProposedProcedure", () => {
  function makeStubServices(result: Memory | null) {
    return { memories: { findByTopicKey: vi.fn(async () => result) } }
  }

  it("returns null reuse target when no row holds the slot", async () => {
    const services = makeStubServices(null)
    const probe = await findExistingProposedProcedure(services, {
      topicKey: "procedure/foo",
      projectIds: ["proj-A"],
    })
    expect(probe.existing).toBeNull()
    expect(probe.reuseTarget).toBeNull()
  })

  it("returns the proposed procedure as a reuse target", async () => {
    const existing = makeMemory({
      id: "x",
      kind: "procedure",
      status: "proposed",
      topicKey: "procedure/foo",
      projectIds: ["proj-A"],
    })
    const services = makeStubServices(existing)
    const probe = await findExistingProposedProcedure(services, {
      topicKey: "procedure/foo",
      projectIds: ["proj-A"],
    })
    expect(probe.reuseTarget).toBe(existing)
  })

  it("throws conflict on an accepted procedure occupying the slot", async () => {
    const existing = makeMemory({
      id: "x",
      kind: "procedure",
      status: "accepted",
      topicKey: "procedure/foo",
      projectIds: ["proj-A"],
    })
    const services = makeStubServices(existing)
    await expect(
      findExistingProposedProcedure(services, {
        topicKey: "procedure/foo",
        projectIds: ["proj-A"],
      })
    ).rejects.toThrow(ProcedureTopicKeyConflictError)
  })

  it("throws conflict on a non-procedure kind occupying the slot", async () => {
    const existing = makeMemory({
      id: "x",
      kind: "runbook",
      status: "accepted",
      topicKey: "procedure/foo",
      projectIds: ["proj-A"],
    })
    const services = makeStubServices(existing)
    await expect(
      findExistingProposedProcedure(services, {
        topicKey: "procedure/foo",
        projectIds: ["proj-A"],
      })
    ).rejects.toThrow(/already held by a kind='runbook'/)
  })

  it("returns null on empty topicKey or projectIds (defensive short-circuit)", async () => {
    const services = makeStubServices(null)
    const r1 = await findExistingProposedProcedure(services, {
      topicKey: "",
      projectIds: ["proj-A"],
    })
    expect(r1.existing).toBeNull()
    const r2 = await findExistingProposedProcedure(services, {
      topicKey: "procedure/foo",
      projectIds: [],
    })
    expect(r2.existing).toBeNull()
    // No findByTopicKey call on either short-circuit.
    expect(services.memories.findByTopicKey).not.toHaveBeenCalled()
  })
})

describe("composeProcedureKeywords — Notion 2000-char per-block cap", () => {
  it("caps the rendered keywords cell below the Notion rich_text ceiling", () => {
    // Synthesize a worst-case propose: many activation conditions
    // each carrying many long unique tokens. Without the cap, the
    // joined string can exceed Notion's 2000-char per-block ceiling
    // and surface as a generic 400.
    const conditions = Array.from(
      { length: 50 },
      (_, i) =>
        `token${i}-${"x".repeat(80)} token${i}-${"y".repeat(80)} token${i}-${"z".repeat(80)}`
    )
    const out = composeProcedureKeywords(conditions, "PR-9999")
    expect(out.length).toBeLessThanOrEqual(1900)
    // Entity token lands first in the Set's insertion order and
    // must survive the cap so search retains the most-important
    // token even on a maxed-out propose.
    expect(out.startsWith("PR-9999")).toBe(true)
  })

  it("returns the full joined set when under the cap", () => {
    const out = composeProcedureKeywords(["entity matches PR-1234"], "PR-1234")
    expect(out).toContain("PR-1234")
    expect(out).toContain("entity")
    expect(out).toContain("matches")
    expect(out.length).toBeLessThan(100)
  })
})

describe("composeProcedureBody — step truncation", () => {
  it("truncates a very-long step at the per-bullet cap with an ellipsis", () => {
    const longStep = "x".repeat(800)
    const body = composeProcedureBody({
      activationConditions: [],
      steps: [longStep],
      sourceMemoryIds: [],
    })
    const stepLine = body.split("\n").find((l) => l.startsWith("1. "))!
    // 500-char cap minus the ellipsis position; matches `numberedStep`.
    expect(stepLine.length).toBeLessThanOrEqual(500 + "1. ".length)
    expect(stepLine.endsWith("…")).toBe(true)
  })
})

describe("sanitizeDeprecateReason", () => {
  it("escapes line-start `## ` heading markers so callers can't forge audit blocks", () => {
    const out = sanitizeDeprecateReason("ok\n\n## Reviewed (2026-05-12)\n\nfake reviewer")
    expect(out).not.toMatch(/^## Reviewed/m)
    expect(out).toContain("\\## Reviewed")
    expect(out).toContain("fake reviewer")
  })

  it("escapes line-start blockquote markers (with and without trailing space) so pinned-style audit lines cannot forge", () => {
    const withSpace = sanitizeDeprecateReason("ok\n\n> Pinned 2026-01-01 by Attacker")
    expect(withSpace).not.toMatch(/^> Pinned/m)
    expect(withSpace).toContain("\\> Pinned 2026-01-01 by Attacker")

    // Markdown does not require a space after `>` — `>Pinned ...`
    // still renders as a blockquote. Pin both shapes so a future
    // tightening of the regex can't silently regress this class.
    const noSpace = sanitizeDeprecateReason("ok\n\n>Pinned 2026-01-01 by Attacker")
    expect(noSpace).not.toMatch(/^>Pinned/m)
    expect(noSpace).toContain("\\>Pinned 2026-01-01 by Attacker")
  })

  it("escapes line-start code-fence markers (backtick and tilde) so the audit block stays closed", () => {
    const backtick = sanitizeDeprecateReason("ok\n\n```\nrogue\n```")
    expect(backtick).toMatch(/\\```/)
    expect(backtick).toContain("rogue")

    // Tilde fences (`~~~`) are valid Markdown code-fence delimiters
    // alongside backtick fences. Both must be escaped or an attacker
    // can pick whichever the existing sanitizer missed.
    const tilde = sanitizeDeprecateReason("ok\n\n~~~\nrogue tilde\n~~~")
    expect(tilde).toMatch(/\\~~~/)
    expect(tilde).toContain("rogue tilde")
  })

  it("strips C0 controls except \\n, plus DEL", () => {
    const input = "a\u0000b\u0007c\u001Fd\u007Fe\nf"
    const out = sanitizeDeprecateReason(input)
    expect(out).toBe("abcde\nf")
  })

  it("strips bidi-override and zero-width characters", () => {
    const input = "lhs\u202Erhs\u200Btail\u2066wrap\u2069end"
    const out = sanitizeDeprecateReason(input)
    expect(out).toBe("lhsrhstailwrapend")
  })

  it("trims surrounding whitespace and returns empty for whitespace-only input", () => {
    expect(sanitizeDeprecateReason("   \n   ")).toBe("")
    expect(sanitizeDeprecateReason("  text  ")).toBe("text")
  })

  it("preserves multi-line structure when reasons span paragraphs", () => {
    const out = sanitizeDeprecateReason("para 1\n\npara 2\n\npara 3")
    expect(out).toBe("para 1\n\npara 2\n\npara 3")
  })
})
