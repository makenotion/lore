import { describe, expect, it, vi } from "vitest"
import {
  composeReconcileQuery,
  formatReconcileOutput,
  reconcileActiveTasks,
  scoreCandidate,
  RECONCILE_PER_TASK_LIMIT,
  type ReconcileServices,
} from "./task-reconcile.js"
import type { Memory, TaskSummary } from "../types.js"

function makeTask(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "t1",
    title: "Task 1",
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
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    taskState: "open",
    blockedBy: "",
    entity: "PR-25750",
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
    ...overrides,
  }
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "m1",
    title: "Memory 1",
    projectIds: [],
    topicId: null,
    source: "manual",
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
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    taskState: null,
    blockedBy: "",
    entity: "",
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
    ...overrides,
  }
}

const TODAY = "2026-04-29"
const TODAY_MS = new Date(TODAY).getTime()

describe("composeReconcileQuery", () => {
  it("joins title, entity, and synopsis with spaces", () => {
    const task = makeTask({
      title: "Track PR-25750 review",
      entity: "PR-25750",
      synopsis: "Outlook classifier review",
    })
    expect(composeReconcileQuery(task)).toBe(
      "Track PR-25750 review PR-25750 Outlook classifier review",
    )
  })

  it("dedupes consecutive identical parts (entity == title)", () => {
    const task = makeTask({
      title: "AuthService",
      entity: "AuthService",
      synopsis: "",
    })
    expect(composeReconcileQuery(task)).toBe("AuthService")
  })

  it("returns empty string when every part is empty/whitespace", () => {
    const task = makeTask({ title: "  ", entity: "", synopsis: "" })
    expect(composeReconcileQuery(task)).toBe("")
  })

  it("degrades to entity + title when synopsis is empty (pre-#02 vault)", () => {
    const task = makeTask({
      title: "Track outlook classifier",
      entity: "PR-25750",
      synopsis: "",
    })
    expect(composeReconcileQuery(task)).toBe(
      "Track outlook classifier PR-25750",
    )
  })
})

describe("scoreCandidate — entity-match axis", () => {
  it("returns entity = 0 unconditionally when task.entity is empty (defends against JS includes('') === true)", () => {
    const task = makeTask({ entity: "" })
    const memory = makeMemory({
      title: "Anything",
      content: "Merged whatever",
    })
    const result = scoreCandidate(task, memory, TODAY_MS)
    expect(result.entityMatch).toBe(0)
  })

  it("returns entity = 0 when task.entity is whitespace-only", () => {
    const task = makeTask({ entity: "   " })
    const memory = makeMemory({ title: "PR-25750", content: "Merged it" })
    const result = scoreCandidate(task, memory, TODAY_MS)
    expect(result.entityMatch).toBe(0)
  })

  it("returns entity = 1.0 when entity appears in title", () => {
    const task = makeTask({ entity: "PR-25750" })
    const memory = makeMemory({
      title: "Merged PR-25750 outlook classifier",
      content: "shipped",
    })
    const result = scoreCandidate(task, memory, TODAY_MS)
    expect(result.entityMatch).toBe(1.0)
  })

  it("returns entity = 1.0 when entity appears in synopsis", () => {
    const task = makeTask({ entity: "PR-25750" })
    const memory = makeMemory({
      title: "Outlook merge",
      synopsis: "Resolved PR-25750 fully",
      content: "merged",
    })
    const result = scoreCandidate(task, memory, TODAY_MS)
    expect(result.entityMatch).toBe(1.0)
  })

  it("returns entity = 1.0 when entity appears in keywords", () => {
    const task = makeTask({ entity: "PR-25750" })
    const memory = makeMemory({
      title: "Outlook merge",
      keywords: "PR-25750 mail-ios",
      content: "merged",
    })
    const result = scoreCandidate(task, memory, TODAY_MS)
    expect(result.entityMatch).toBe(1.0)
  })

  it("returns entity = 0.5 when entity appears in body only", () => {
    const task = makeTask({ entity: "PR-25750" })
    const memory = makeMemory({
      title: "Outlook merge",
      content: "Merged PR-25750 — outlook label.applied classifier rolled",
    })
    const result = scoreCandidate(task, memory, TODAY_MS)
    expect(result.entityMatch).toBe(0.5)
  })

  it("returns entity = 0 when entity does not appear anywhere", () => {
    const task = makeTask({ entity: "PR-25750" })
    const memory = makeMemory({
      title: "Other thing",
      content: "Merged something else",
    })
    const result = scoreCandidate(task, memory, TODAY_MS)
    expect(result.entityMatch).toBe(0)
  })
})

describe("scoreCandidate — cue-match axis", () => {
  it("returns cue = 1.0 for hard cues (merged/shipped/resolved/fixed/closed/completed/deployed)", () => {
    const task = makeTask()
    for (const cue of [
      "merged",
      "shipped",
      "resolved",
      "fixed",
      "closed",
      "completed",
      "deployed",
    ]) {
      const memory = makeMemory({ content: `We ${cue} the issue.` })
      const result = scoreCandidate(task, memory, TODAY_MS)
      expect(result.cueMatch, `cue=${cue}`).toBe(1.0)
    }
  })

  it("returns cue = 0.5 for soft cues (done/landed/out)", () => {
    const task = makeTask()
    for (const cue of ["done", "landed", "out"]) {
      const memory = makeMemory({ content: `We ${cue} it.` })
      const result = scoreCandidate(task, memory, TODAY_MS)
      expect(result.cueMatch, `cue=${cue}`).toBe(0.5)
    }
  })

  it("returns cue = 0 when no cue matches", () => {
    const task = makeTask()
    const memory = makeMemory({
      content: "This is a memory about PR-25750 work that's blocking.",
    })
    const result = scoreCandidate(task, memory, TODAY_MS)
    expect(result.cueMatch).toBe(0)
  })

  it("captures a snippet around the matched cue for inline rendering", () => {
    const task = makeTask()
    const memory = makeMemory({
      content:
        "Long preamble that goes on and on and on and on. Today we merged the change. Now we move on.",
    })
    const result = scoreCandidate(task, memory, TODAY_MS)
    expect(result.cueSnippet).toContain("merged")
  })
})

describe("scoreCandidate — recency-bonus axis", () => {
  it("returns recency = 1.0 within RECENCY_FULL_DAYS (14 days)", () => {
    const task = makeTask()
    const memory = makeMemory({ createdAt: "2026-04-20T00:00:00.000Z" })
    const result = scoreCandidate(task, memory, TODAY_MS)
    expect(result.recencyBonus).toBe(1.0)
  })

  it("returns recency = 0 at or past RECENCY_ZERO_DAYS (90 days)", () => {
    const task = makeTask()
    const memory = makeMemory({ createdAt: "2026-01-20T00:00:00.000Z" })
    const result = scoreCandidate(task, memory, TODAY_MS)
    expect(result.recencyBonus).toBe(0)
  })

  it("decays linearly between RECENCY_FULL_DAYS and RECENCY_ZERO_DAYS", () => {
    const task = makeTask()
    // ~52 days ago — about midway between 14 and 90 → ~0.5
    const memory = makeMemory({ createdAt: "2026-03-08T00:00:00.000Z" })
    const result = scoreCandidate(task, memory, TODAY_MS)
    expect(result.recencyBonus).toBeGreaterThan(0.4)
    expect(result.recencyBonus).toBeLessThan(0.6)
  })
})

describe("scoreCandidate — composite score", () => {
  it("entity (1.0) + cue (1.0) + recent (1.0) lands at exactly 1.0", () => {
    const task = makeTask({ entity: "PR-25750" })
    const memory = makeMemory({
      title: "PR-25750 status",
      content: "Merged today",
      createdAt: "2026-04-25T00:00:00.000Z",
    })
    const result = scoreCandidate(task, memory, TODAY_MS)
    expect(result.score).toBeCloseTo(1.0)
  })

  it("entity-only + recency-only (no cue) drops via cueMatch, not via score — score reads 0.6", () => {
    // Spec: this is the "blocking on PR" failure mode the cue-gate prevents.
    // Without the cue gate, this would land at 1.0 * 0.4 + 1.0 * 0.2 = 0.6,
    // which clears the default 0.5 threshold. The cueMatch === 0 gate
    // upstream is what filters this out.
    const task = makeTask({ entity: "PR-25750" })
    const memory = makeMemory({
      title: "PR-25750 status",
      content: "blocking on PR-25750 review",
      createdAt: "2026-04-25T00:00:00.000Z",
    })
    const result = scoreCandidate(task, memory, TODAY_MS)
    expect(result.cueMatch).toBe(0)
    expect(result.score).toBeCloseTo(0.6)
  })
})

describe("reconcileActiveTasks — orchestration", () => {
  function makeServices(opts: {
    activeTasks: TaskSummary[]
    candidatesByTask: Record<string, Memory[]>
  }): ReconcileServices {
    const tasksList = vi.fn(async () => ({ items: opts.activeTasks }))
    const memoriesSearch = vi.fn(
      async ({ query }: { query: string }) => {
        // Find the task this search is for by matching the composed query.
        const task = opts.activeTasks.find(
          (t) => composeReconcileQuery(t) === query,
        )
        return task ? (opts.candidatesByTask[task.id] ?? []) : []
      },
    )
    const memoriesMaterialize = vi.fn(async (m: Memory) => m)
    return {
      tasks: { list: tasksList } as unknown as ReconcileServices["tasks"],
      memories: {
        search: memoriesSearch,
        materializeContent: memoriesMaterialize,
      } as unknown as ReconcileServices["memories"],
    }
  }

  it("returns 0 candidates when the active task set is empty", async () => {
    const services = makeServices({ activeTasks: [], candidatesByTask: {} })
    const result = await reconcileActiveTasks(services, { today: TODAY })
    expect(result.candidates).toEqual([])
    expect(result.activeTasksScanned).toBe(0)
  })

  it("returns 0 candidates when active tasks exist but no memories clear threshold", async () => {
    const task = makeTask({ id: "t1", entity: "PR-25750" })
    const services = makeServices({
      activeTasks: [task],
      candidatesByTask: {
        t1: [
          makeMemory({
            id: "m-noisy",
            title: "Some other thing",
            content: "blocking work",
          }),
        ],
      },
    })
    const result = await reconcileActiveTasks(services, { today: TODAY })
    expect(result.candidates).toEqual([])
    expect(result.activeTasksScanned).toBe(1)
  })

  it("filters out task and decision rows from candidates before scoring", async () => {
    // Even a task row whose content carries a hard cue and entity match
    // must not surface as a candidate — reconcile scans tasks AGAINST
    // memories, not against other tasks.
    const task = makeTask({ id: "t1", entity: "PR-25750" })
    const services = makeServices({
      activeTasks: [task],
      candidatesByTask: {
        t1: [
          makeMemory({
            id: "m-task",
            kind: "task",
            title: "Other task on PR-25750",
            content: "Merged PR-25750 from another task page",
            createdAt: "2026-04-25T00:00:00.000Z",
          }),
          makeMemory({
            id: "m-decision",
            kind: "decision",
            title: "Decision on PR-25750",
            content: "Resolved PR-25750",
            createdAt: "2026-04-25T00:00:00.000Z",
          }),
        ],
      },
    })
    const result = await reconcileActiveTasks(services, { today: TODAY })
    expect(result.candidates).toEqual([])
  })

  it("surfaces a clean candidate when entity + cue + recent align", async () => {
    const task = makeTask({
      id: "t1",
      title: "Track PR-25750 review",
      entity: "PR-25750",
    })
    const memory = makeMemory({
      id: "m-good",
      title: "Merged PR-25750 — outlook label.applied classifier",
      content: "Merged PR-25750. Label applied classifier shipped.",
      createdAt: "2026-04-25T00:00:00.000Z",
    })
    const services = makeServices({
      activeTasks: [task],
      candidatesByTask: { t1: [memory] },
    })
    const result = await reconcileActiveTasks(services, { today: TODAY })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].task.id).toBe("t1")
    expect(result.candidates[0].memory.id).toBe("m-good")
    expect(result.candidates[0].score).toBeGreaterThanOrEqual(0.5)
  })

  it("reduces to one row per task — no two rendered rows recommend the same close incantation", async () => {
    const task = makeTask({
      id: "t1",
      title: "Track PR-25750",
      entity: "PR-25750",
    })
    const services = makeServices({
      activeTasks: [task],
      candidatesByTask: {
        t1: [
          makeMemory({
            id: "m-older",
            title: "Merged PR-25750 first attempt",
            content: "Merged PR-25750 first try",
            createdAt: "2026-04-15T00:00:00.000Z",
          }),
          makeMemory({
            id: "m-newer",
            title: "Merged PR-25750 fix",
            content: "Merged PR-25750 follow-up",
            createdAt: "2026-04-25T00:00:00.000Z",
          }),
        ],
      },
    })
    const result = await reconcileActiveTasks(services, { today: TODAY })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].task.id).toBe("t1")
  })

  it("breaks score ties by memory.createdAt (more recent wins) at the per-task reduce", async () => {
    const task = makeTask({
      id: "t1",
      title: "Track PR-25750",
      entity: "PR-25750",
    })
    // Two memories with identical entity+cue+recency scores; the more
    // recent createdAt must win the per-task reduce step.
    const services = makeServices({
      activeTasks: [task],
      candidatesByTask: {
        t1: [
          makeMemory({
            id: "m-older",
            title: "Merged PR-25750",
            content: "Merged PR-25750",
            createdAt: "2026-04-20T00:00:00.000Z",
          }),
          makeMemory({
            id: "m-newer",
            title: "Merged PR-25750",
            content: "Merged PR-25750",
            createdAt: "2026-04-25T00:00:00.000Z",
          }),
        ],
      },
    })
    const result = await reconcileActiveTasks(services, { today: TODAY })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].memory.id).toBe("m-newer")
  })

  it("respects minScore threshold — entity-only candidates filtered via cue-gate before threshold", async () => {
    const task = makeTask({
      id: "t1",
      title: "Track PR-25750",
      entity: "PR-25750",
    })
    const services = makeServices({
      activeTasks: [task],
      candidatesByTask: {
        t1: [
          makeMemory({
            id: "m-no-cue",
            title: "PR-25750 status",
            content: "Discussion about PR-25750 — no resolution language here.",
            createdAt: "2026-04-25T00:00:00.000Z",
          }),
        ],
      },
    })
    const result = await reconcileActiveTasks(services, {
      today: TODAY,
      minScore: 0.3,
    })
    // Even with a low minScore, the cue-gate drops this candidate.
    expect(result.candidates).toEqual([])
  })

  it("respects the limit option, sorted by score descending", async () => {
    const tasks = [
      makeTask({ id: "t1", title: "Track A", entity: "A" }),
      makeTask({ id: "t2", title: "Track B", entity: "B" }),
      makeTask({ id: "t3", title: "Track C", entity: "C" }),
    ]
    const services = makeServices({
      activeTasks: tasks,
      candidatesByTask: {
        t1: [
          makeMemory({
            id: "m1",
            title: "A merged",
            content: "Merged A.",
            createdAt: "2026-04-25T00:00:00.000Z",
          }),
        ],
        t2: [
          makeMemory({
            id: "m2",
            title: "B done",
            content: "Done with B.",
            createdAt: "2026-04-25T00:00:00.000Z",
          }),
        ],
        t3: [
          makeMemory({
            id: "m3",
            title: "C shipped",
            content: "Shipped C.",
            createdAt: "2026-04-25T00:00:00.000Z",
          }),
        ],
      },
    })
    const result = await reconcileActiveTasks(services, {
      today: TODAY,
      limit: 2,
    })
    expect(result.candidates).toHaveLength(2)
    expect(result.activeTasksScanned).toBe(3)
    // Sorted by score descending — the soft-cue (B "done") should rank
    // last and be dropped by the cap.
    const taskIds = result.candidates.map((c) => c.task.id)
    expect(taskIds).not.toContain("t2")
  })

  it("hydrates bodies via materializeContent (no eager body fetch)", async () => {
    const task = makeTask({
      id: "t1",
      title: "Track PR-25750",
      entity: "PR-25750",
    })
    const indexTierMemory = makeMemory({
      id: "m-index",
      title: "Merged PR-25750",
      content: "", // index tier returns no body
      createdAt: "2026-04-25T00:00:00.000Z",
    })
    const hydratedMemory = makeMemory({
      ...indexTierMemory,
      content: "Merged PR-25750 today.",
    })
    const tasksList = vi.fn(async () => ({ items: [task] }))
    const memoriesSearch = vi.fn(async () => [indexTierMemory])
    const memoriesMaterialize = vi.fn(async () => hydratedMemory)
    const services: ReconcileServices = {
      tasks: { list: tasksList } as unknown as ReconcileServices["tasks"],
      memories: {
        search: memoriesSearch,
        materializeContent: memoriesMaterialize,
      } as unknown as ReconcileServices["memories"],
    }
    const result = await reconcileActiveTasks(services, { today: TODAY })
    expect(memoriesSearch).toHaveBeenCalledWith(
      expect.objectContaining({ includeContent: false, mode: "hybrid" }),
    )
    expect(memoriesMaterialize).toHaveBeenCalledTimes(1)
    expect(result.candidates).toHaveLength(1)
  })

  it("degrades gracefully when materializeContent throws (transient 5xx, archived)", async () => {
    const task = makeTask({
      id: "t1",
      title: "Track PR-25750",
      entity: "PR-25750",
    })
    const tasksList = vi.fn(async () => ({ items: [task] }))
    const memoriesSearch = vi.fn(async () => [
      makeMemory({
        id: "m-fail",
        title: "Merged PR-25750",
        content: "",
        createdAt: "2026-04-25T00:00:00.000Z",
      }),
    ])
    const memoriesMaterialize = vi.fn(async () => {
      throw new Error("notion 503")
    })
    const services: ReconcileServices = {
      tasks: { list: tasksList } as unknown as ReconcileServices["tasks"],
      memories: {
        search: memoriesSearch,
        materializeContent: memoriesMaterialize,
      } as unknown as ReconcileServices["memories"],
    }
    // Hydration failure → empty body → cueMatch = 0 → cue-gate filter
    // → no candidate surfaces. The reconcile call returns cleanly with
    // zero candidates instead of throwing.
    const result = await reconcileActiveTasks(services, { today: TODAY })
    expect(result.candidates).toEqual([])
    expect(result.activeTasksScanned).toBe(1)
  })

  it("uses the index-tier search with includeContent: false (over-fetch headroom)", async () => {
    const task = makeTask({ id: "t1", entity: "PR-25750" })
    const tasksList = vi.fn(async () => ({ items: [task] }))
    const memoriesSearch = vi.fn<(args: { limit: number }) => Promise<Memory[]>>(
      async () => [],
    )
    const memoriesMaterialize = vi.fn(async (m: Memory) => m)
    const services: ReconcileServices = {
      tasks: { list: tasksList } as unknown as ReconcileServices["tasks"],
      memories: {
        search: memoriesSearch,
        materializeContent: memoriesMaterialize,
      } as unknown as ReconcileServices["memories"],
    }
    await reconcileActiveTasks(services, { today: TODAY })
    expect(memoriesSearch).toHaveBeenCalledTimes(1)
    const callArgs = memoriesSearch.mock.calls[0]![0]
    // Over-fetch by 4× the per-task cap, capped at 20.
    expect(callArgs.limit).toBe(RECONCILE_PER_TASK_LIMIT * 4)
  })

  it("post-filters the just-scanned task itself if returned by search (defends against self-reference)", async () => {
    // A task that happens to mention its own entity in its title would
    // otherwise self-match. Filter on memory.id !== task.id at the
    // candidate level (already covered by kind-task filter above, but
    // also test the identity guard).
    const task = makeTask({
      id: "t1",
      title: "Track PR-25750",
      entity: "PR-25750",
    })
    const services = makeServices({
      activeTasks: [task],
      candidatesByTask: {
        t1: [
          makeMemory({
            id: "t1", // same id as the task — explicit self-reference
            kind: "note",
            title: "Track PR-25750",
            content: "Merged PR-25750",
            createdAt: "2026-04-25T00:00:00.000Z",
          }),
        ],
      },
    })
    const result = await reconcileActiveTasks(services, { today: TODAY })
    expect(result.candidates).toEqual([])
  })

  it("walks tasks.list cursors across multiple pages until nextCursor is undefined", async () => {
    // Mail-vault parity: vaults with > 100 active tasks must walk
    // cursors. Mock the service to return two pages, the first with
    // `nextCursor` set, the second without; assert both pages were
    // exhausted and the count matches the safety cap correctly.
    const page1Tasks = Array.from({ length: 100 }, (_, i) =>
      makeTask({ id: `t1-${i}`, entity: "" }),
    )
    const page2Tasks = Array.from({ length: 50 }, (_, i) =>
      makeTask({ id: `t2-${i}`, entity: "" }),
    )
    const tasksList = vi
      .fn()
      .mockResolvedValueOnce({ items: page1Tasks, nextCursor: "cursor-1" })
      .mockResolvedValueOnce({ items: page2Tasks, nextCursor: undefined })
    const memoriesSearch = vi.fn(async () => [])
    const memoriesMaterialize = vi.fn(async (m: Memory) => m)
    const services: ReconcileServices = {
      tasks: { list: tasksList } as unknown as ReconcileServices["tasks"],
      memories: {
        search: memoriesSearch,
        materializeContent: memoriesMaterialize,
      } as unknown as ReconcileServices["memories"],
    }
    const result = await reconcileActiveTasks(services, { today: TODAY })
    expect(tasksList).toHaveBeenCalledTimes(2)
    // First call has no startCursor; second carries the page-1 cursor.
    expect(tasksList.mock.calls[0]![0]).toMatchObject({ startCursor: undefined })
    expect(tasksList.mock.calls[1]![0]).toMatchObject({ startCursor: "cursor-1" })
    expect(result.activeTasksScanned).toBe(150)
  })

  it("uses a true worker pool — fast tasks make progress while slow tasks are still in flight", async () => {
    // Defends against the chunk-based implementation: a chunked variant
    // would block the entire next chunk on the slowest task in the
    // current chunk. With a true worker pool, fast tasks complete and
    // their workers immediately pick up the next item.
    //
    // Arrange: 16 tasks (2× concurrency cap of 8). The first 8 are slow
    // (gated on a manually-released promise); the remaining 8 are fast.
    // With chunk semantics, all 8 fast tasks would block until ALL 8
    // slow tasks finish. With pool semantics, as each slow task
    // resolves, a free worker picks up a fast task.
    const slowGate: Array<() => void> = []
    const slowTasks = Array.from({ length: 8 }, (_, i) =>
      makeTask({
        id: `slow-${i}`,
        title: `Slow task ${i}`,
        entity: "",
      }),
    )
    const fastTasks = Array.from({ length: 8 }, (_, i) =>
      makeTask({
        id: `fast-${i}`,
        title: `Fast task ${i}`,
        entity: "",
      }),
    )
    const tasksList = vi.fn(async () => ({
      items: [...slowTasks, ...fastTasks],
    }))
    let fastTasksDispatched = 0
    const memoriesSearch = vi.fn(async ({ query }: { query: string }) => {
      // Slow tasks gate on a manually-released promise; fast tasks
      // resolve immediately. Slow / fast queries are distinguished by
      // the title prefix `composeReconcileQuery` produces.
      if (query.startsWith("Slow task ")) {
        await new Promise<void>((resolve) => slowGate.push(resolve))
      } else if (query.startsWith("Fast task ")) {
        fastTasksDispatched++
      }
      return []
    })
    const memoriesMaterialize = vi.fn(async (m: Memory) => m)
    const services: ReconcileServices = {
      tasks: { list: tasksList } as unknown as ReconcileServices["tasks"],
      memories: {
        search: memoriesSearch,
        materializeContent: memoriesMaterialize,
      } as unknown as ReconcileServices["memories"],
    }
    const reconcilePromise = reconcileActiveTasks(services, { today: TODAY })

    // Yield enough microtasks for the worker pool to dispatch its
    // initial 8 slow tasks.
    for (let i = 0; i < 50; i++) await Promise.resolve()
    // Initial worker burst is 8 (concurrency cap) — all slow.
    expect(slowGate.length).toBe(8)
    // Fast tasks have not yet been dispatched: chunk-based code would
    // wait for the full slow chunk to finish; pool-based code is
    // waiting because every worker is currently inside a slow task.
    expect(fastTasksDispatched).toBe(0)

    // Release one slow task. The freed worker picks up the next item
    // (a fast task) immediately.
    slowGate.shift()!()
    for (let i = 0; i < 50; i++) await Promise.resolve()
    expect(fastTasksDispatched).toBeGreaterThanOrEqual(1)

    // Drain remaining slow tasks so the test finishes.
    for (const release of slowGate) release()
    slowGate.length = 0
    await reconcilePromise
  })
})

describe("formatReconcileOutput", () => {
  it("renders the empty-set form when no candidates surface, regardless of activeTasksScanned", () => {
    expect(formatReconcileOutput([], 0, TODAY)).toBe(
      "## 0 candidate closures (out of 0 active tasks scanned)",
    )
    expect(formatReconcileOutput([], 5, TODAY)).toBe(
      "## 0 candidate closures (out of 5 active tasks scanned)",
    )
  })

  it("renders task id, title, state, age, memory id, score, and close incantation per row", () => {
    const task = makeTask({
      id: "t-abc",
      title: "Track PR-25750",
      taskState: "in-progress",
      createdAt: "2026-02-01T00:00:00.000Z", // ~87 days ago
    })
    const memory = makeMemory({
      id: "m-xyz",
      title: "Merged PR-25750",
      content: "Merged PR-25750 — outlook label.applied classifier rolled.",
      createdAt: "2026-04-17T00:00:00.000Z",
    })
    const candidate = scoreCandidate(task, memory, TODAY_MS)
    const rendered = formatReconcileOutput([candidate], 1, TODAY)
    expect(rendered).toContain("## 1 candidate closure (out of 1 active task scanned)")
    expect(rendered).toContain("### 1. Task t-abc — \"Track PR-25750\" [in-progress")
    expect(rendered).toContain("Best match: memory m-xyz")
    expect(rendered).toContain("Cue: \"")
    expect(rendered).toContain("Close: lore-task({ action: 'close', taskId: 't-abc' })")
  })
})
