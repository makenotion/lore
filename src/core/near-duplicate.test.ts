import { describe, expect, it, vi } from "vitest"
import {
  findDuplicateActiveTasks,
  findNearDuplicates,
  type MemoryLister,
  type TaskLister,
} from "./near-duplicate.js"
import type { Memory, TaskSummary } from "../types.js"

function makeMemory(overrides: Partial<Memory> & { id: string; title: string }): Memory {
  return {
    projectIds: ["proj-a"],
    topicId: null,
    source: "manual",
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
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  }
}

function makeLister(items: Memory[]): MemoryLister & { listSpy: ReturnType<typeof vi.fn> } {
  const listSpy = vi.fn().mockResolvedValue({ items })
  return { list: listSpy, listSpy }
}

describe("findNearDuplicates", () => {
  it("short-circuits when LORE_DISABLE_NEAR_DUPLICATE_PROBE=1 (operator kill-switch)", async () => {
    const listSpy = vi.fn()
    vi.stubEnv("LORE_DISABLE_NEAR_DUPLICATE_PROBE", "1")
    try {
      const result = await findNearDuplicates(
        { list: listSpy },
        {
          title: "Anything",
          tags: [],
          projectId: "proj-a",
          threshold: 0.7,
        },
      )
      expect(result).toEqual([])
      expect(listSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("runs normally when LORE_DISABLE_NEAR_DUPLICATE_PROBE is anything other than '1'", async () => {
    const listSpy = vi.fn().mockResolvedValue({ items: [] })
    vi.stubEnv("LORE_DISABLE_NEAR_DUPLICATE_PROBE", "0")
    try {
      await findNearDuplicates(
        { list: listSpy },
        {
          title: "Anything",
          tags: [],
          projectId: "proj-a",
          threshold: 0.7,
        },
      )
      expect(listSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("returns [] when no projectId is given (vault-wide probes are skipped)", async () => {
    const lister = makeLister([])
    const result = await findNearDuplicates(lister, {
      title: "Anything",
      tags: [],
      threshold: 0.7,
    })
    expect(result).toEqual([])
    // No wasted Notion query on the unscoped path.
    expect(lister.listSpy).not.toHaveBeenCalled()
  })

  it("returns [] for an empty title (degenerate input, no useful signal)", async () => {
    const lister = makeLister([])
    const result = await findNearDuplicates(lister, {
      title: "   ",
      tags: [],
      projectId: "proj-a",
      threshold: 0.7,
    })
    expect(result).toEqual([])
    expect(lister.listSpy).not.toHaveBeenCalled()
  })

  it("passes the top-2 tags into the list filter (candidate-pool scoping)", async () => {
    const lister = makeLister([])
    await findNearDuplicates(lister, {
      title: "Something",
      tags: ["architecture", "core", "performance", "bug"],
      projectId: "proj-a",
      threshold: 0.7,
    })
    expect(lister.listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ["architecture", "core"] }),
    )
  })

  it("omits the tag filter entirely when the caller has no tags", async () => {
    // Project scope alone is enough of a candidate pool when tags are
    // absent — passing `tags: []` would return nothing from Notion's OR
    // filter.
    const lister = makeLister([])
    await findNearDuplicates(lister, {
      title: "Something",
      tags: [],
      projectId: "proj-a",
      threshold: 0.7,
    })
    expect(lister.listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tags: undefined }),
    )
  })

  it("skips the per-page markdown fetch (probe only needs titles)", async () => {
    const lister = makeLister([])
    await findNearDuplicates(lister, {
      title: "Something",
      tags: [],
      projectId: "proj-a",
      threshold: 0.7,
    })
    expect(lister.listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ includeContent: false }),
    )
  })

  it("surfaces matches whose title trigram similarity meets the threshold", async () => {
    const lister = makeLister([
      makeMemory({
        id: "mem-1",
        title: "Wakeup hook swallows errors silently",
        tags: ["architecture"],
      }),
      makeMemory({ id: "mem-2", title: "Unrelated memory about database migrations" }),
    ])
    const result = await findNearDuplicates(lister, {
      title: "Wakeup hook swallows errors silently",
      tags: ["architecture"],
      projectId: "proj-a",
      threshold: 0.7,
    })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("mem-1")
    expect(result[0].titleSimilarity).toBeCloseTo(1)
    expect(result[0].tagOverlap).toBeCloseTo(1)
  })

  it("sorts results by title similarity descending", async () => {
    const lister = makeLister([
      makeMemory({ id: "mem-mid", title: "Wakeup hook swallows errors" }),
      makeMemory({ id: "mem-high", title: "Wakeup hook swallows errors silently" }),
      makeMemory({ id: "mem-low", title: "Wakeup hook" }),
    ])
    const result = await findNearDuplicates(lister, {
      title: "Wakeup hook swallows errors silently",
      tags: [],
      projectId: "proj-a",
      threshold: 0.1,
    })
    const ids = result.map((m) => m.id)
    // Descending by similarity: identical first, then partial, then low.
    expect(ids[0]).toBe("mem-high")
    expect(ids[1]).toBe("mem-mid")
    expect(ids[2]).toBe("mem-low")
  })

  it("drops rows with similarity strictly below threshold", async () => {
    const lister = makeLister([
      makeMemory({ id: "mem-1", title: "Completely unrelated topic" }),
    ])
    const result = await findNearDuplicates(lister, {
      title: "Wakeup hook crash",
      tags: [],
      projectId: "proj-a",
      threshold: 0.7,
    })
    expect(result).toEqual([])
  })

  it("filters by status whitelist client-side", async () => {
    // `lore-decide` needs `accepted OR proposed` — Notion's query accepts
    // one status clause, so the probe post-filters instead of issuing
    // two server queries for one probe.
    const lister = makeLister([
      makeMemory({
        id: "dec-accepted",
        title: "Replace auth middleware",
        kind: "decision",
        status: "accepted",
      }),
      makeMemory({
        id: "dec-superseded",
        title: "Replace auth middleware",
        kind: "decision",
        status: "superseded",
      }),
    ])
    const result = await findNearDuplicates(lister, {
      title: "Replace auth middleware",
      tags: [],
      projectId: "proj-a",
      kind: "decision",
      statuses: ["accepted", "proposed"],
      threshold: 0.6,
    })
    expect(result.map((m) => m.id)).toEqual(["dec-accepted"])
  })

  it("filters out kinds listed in excludeKinds (memory probe drops decisions)", async () => {
    const lister = makeLister([
      makeMemory({ id: "note", title: "Wakeup hook crash", kind: "note" }),
      makeMemory({ id: "dec", title: "Wakeup hook crash", kind: "decision" }),
    ])
    const result = await findNearDuplicates(lister, {
      title: "Wakeup hook crash",
      tags: [],
      projectId: "proj-a",
      threshold: 0.7,
      excludeKinds: ["decision"],
    })
    expect(result.map((m) => m.id)).toEqual(["note"])
  })

  it("swallows list() errors and returns [] (probe failures must not fail the save)", async () => {
    const listSpy = vi.fn().mockRejectedValue(new Error("notion 503"))
    const result = await findNearDuplicates(
      { list: listSpy },
      {
        title: "Anything",
        tags: [],
        projectId: "proj-a",
        threshold: 0.7,
      },
    )
    expect(result).toEqual([])
  })

  it("invokes onError when the list query throws (operator observability hook)", async () => {
    const err = new Error("notion 503")
    const listSpy = vi.fn().mockRejectedValue(err)
    const onError = vi.fn()

    const result = await findNearDuplicates(
      { list: listSpy },
      {
        title: "Anything",
        tags: [],
        projectId: "proj-a",
        threshold: 0.7,
        onError,
      },
    )

    expect(result).toEqual([])
    expect(onError).toHaveBeenCalledWith(err)
  })

  it("forwards topicId through to the lister (decision probe scopes by topic)", async () => {
    const lister = makeLister([])
    await findNearDuplicates(lister, {
      title: "x",
      tags: [],
      projectId: "proj-a",
      topicId: "topic-z",
      kind: "decision",
      threshold: 0.6,
    })
    expect(lister.listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ topicId: "topic-z", kind: "decision" }),
    )
  })
})

function makeTaskSummary(
  overrides: Partial<TaskSummary> & { id: string; title: string },
): TaskSummary {
  return {
    projectIds: ["proj-a"],
    topicId: null,
    source: "manual",
    kind: "task",
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
    taskState: "open",
    blockedBy: "",
    // Default `entity` to title to mirror `TaskService.create`'s
    // omitted-entity behavior; an explicit `overrides.entity` wins
    // via the spread below. Spelled `entity ?? title` rather than
    // bare `overrides.title` so the override-or-default contract is
    // visible at the call site for future test authors.
    entity: overrides.entity ?? overrides.title,
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  }
}

function makeTaskLister(
  items: TaskSummary[],
): TaskLister & { listSpy: ReturnType<typeof vi.fn> } {
  const listSpy = vi.fn().mockResolvedValue({ items })
  return { list: listSpy, listSpy }
}

describe("findDuplicateActiveTasks", () => {
  it("short-circuits when LORE_DISABLE_NEAR_DUPLICATE_PROBE=1 (operator kill-switch)", async () => {
    const listSpy = vi.fn()
    vi.stubEnv("LORE_DISABLE_NEAR_DUPLICATE_PROBE", "1")
    try {
      const result = await findDuplicateActiveTasks(
        { list: listSpy },
        { entity: "PR-25750", projectId: "proj-a" },
      )
      expect(result).toEqual([])
      expect(listSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("runs normally when LORE_DISABLE_NEAR_DUPLICATE_PROBE is anything other than '1'", async () => {
    const listSpy = vi.fn().mockResolvedValue({ items: [] })
    vi.stubEnv("LORE_DISABLE_NEAR_DUPLICATE_PROBE", "0")
    try {
      await findDuplicateActiveTasks(
        { list: listSpy },
        { entity: "PR-25750", projectId: "proj-a" },
      )
      expect(listSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("returns [] when entity is empty (degenerate input — no useful signal)", async () => {
    const lister = makeTaskLister([])
    const result = await findDuplicateActiveTasks(lister, {
      entity: "",
      projectId: "proj-a",
    })
    expect(result).toEqual([])
    // No wasted Notion call on the unscoped path.
    expect(lister.listSpy).not.toHaveBeenCalled()
  })

  it("returns [] when entity is whitespace-only", async () => {
    const lister = makeTaskLister([])
    const result = await findDuplicateActiveTasks(lister, {
      entity: "   ",
      projectId: "proj-a",
    })
    expect(result).toEqual([])
    expect(lister.listSpy).not.toHaveBeenCalled()
  })

  it("forwards entity, projectId, ACTIVE_TASK_STATES, and limit=10 into the list query", async () => {
    const lister = makeTaskLister([])
    await findDuplicateActiveTasks(lister, {
      entity: "PR-25750",
      projectId: "proj-a",
    })
    expect(lister.listSpy).toHaveBeenCalledWith({
      projectId: "proj-a",
      entities: ["PR-25750"],
      states: ["open", "in-progress", "blocked"],
      limit: 10,
    })
  })

  it("returns the raw set of active tasks — no exclusion of any kind", async () => {
    // Acceptance criterion: the helper performs no exclusion. Even if
    // the caller passes the just-created task's id back through some
    // surface, this helper does not (and cannot) filter by it. The
    // test pins that contract — every TaskSummary the lister returns
    // surfaces in the result, in the order the lister returned them.
    const items = [
      makeTaskSummary({ id: "task-1", title: "Track PR-25750 review" }),
      makeTaskSummary({ id: "task-2", title: "PR-25750 follow-up" }),
      makeTaskSummary({ id: "task-3", title: "PR-25750 redux" }),
    ]
    const lister = makeTaskLister(items)
    const result = await findDuplicateActiveTasks(lister, {
      entity: "PR-25750",
      projectId: "proj-a",
    })
    expect(result.map((t) => t.id)).toEqual(["task-1", "task-2", "task-3"])
  })

  it("swallows list() errors and returns [] (probe failures must not fail the create)", async () => {
    const listSpy = vi.fn().mockRejectedValue(new Error("notion 503"))
    const result = await findDuplicateActiveTasks(
      { list: listSpy },
      { entity: "PR-25750", projectId: "proj-a" },
    )
    expect(result).toEqual([])
  })

  it("invokes onError when the list query throws (operator observability hook)", async () => {
    const err = new Error("notion 503")
    const listSpy = vi.fn().mockRejectedValue(err)
    const onError = vi.fn()

    const result = await findDuplicateActiveTasks(
      { list: listSpy },
      { entity: "PR-25750", projectId: "proj-a", onError },
    )

    expect(result).toEqual([])
    expect(onError).toHaveBeenCalledWith(err)
  })

  it("allows an undefined projectId — vault-wide active-task probe is well-defined", async () => {
    // Unlike `findNearDuplicates`, which skips vault-wide probes
    // because they'd scan the whole Memories DB, the task probe rides
    // `TaskService.list`'s `projectOrUnscopedFilter` which already
    // bounds the query to active tasks. An unscoped call is rare in
    // practice (the wire-in always passes `resolved.ids[0]`), but the
    // helper must not refuse it — projectless tasks exist.
    const lister = makeTaskLister([
      makeTaskSummary({ id: "task-1", title: "Track PR-25750" }),
    ])
    const result = await findDuplicateActiveTasks(lister, {
      entity: "PR-25750",
    })
    expect(result.map((t) => t.id)).toEqual(["task-1"])
    expect(lister.listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: undefined }),
    )
  })
})
