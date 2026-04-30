import { describe, expect, it } from "vitest"
import { gatherDigestData, daysSince } from "./digest.js"
import type { Memory, TaskState, TaskSummary } from "../types.js"

function makeMemory(overrides: Partial<Memory>): Memory {
  return {
    id: "m-" + Math.random().toString(36).slice(2),
    title: "Untitled",
    projectIds: [],
    topicId: null,
    source: "conversation",
    kind: "note",
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
    taskState: null,
    blockedBy: "",
    entity: "",
    topicKey: "",
    revisionCount: 1,
    createdAt: "2026-04-20T10:00:00.000Z",
    updatedAt: "2026-04-20T10:00:00.000Z",
    ...overrides,
  }
}

function makeTask(overrides: Partial<TaskSummary>): TaskSummary {
  return {
    id: "t-" + Math.random().toString(36).slice(2),
    title: "Task subject",
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
    entity: "",
    topicKey: "",
    revisionCount: 1,
    createdAt: "2026-04-20T10:00:00.000Z",
    updatedAt: "2026-04-20T10:00:00.000Z",
    ...overrides,
  }
}

interface ListedCall {
  projectId?: string
  source?: string
  since?: string
  until?: string
  limit?: number
  sortBy?: "created_time" | "last_edited_time"
}

interface ListTasksCall {
  projectId?: string
  states?: TaskState[]
  limit?: number
}

function stubServices(opts: {
  memories?: Memory[]
  digestMemory?: Memory | null
  tasks?: TaskSummary[]
  /**
   * When set, the tasks stub returns this string as `nextCursor` so the
   * caller's truncation-detection branch fires (mirrors Notion's
   * `has_more: true` signal on a `limit: N` query that found more
   * than N rows).
   */
  tasksNextCursor?: string
}) {
  const calls: ListedCall[] = []
  const taskCalls: ListTasksCall[] = []
  return {
    calls,
    taskCalls,
    memories: {
      async list(args: ListedCall): Promise<{ items: Memory[] }> {
        calls.push(args)
        if (args.source === "digest") {
          return { items: opts.digestMemory ? [opts.digestMemory] : [] }
        }
        return { items: opts.memories ?? [] }
      },
    },
    tasks: {
      async list(
        args: ListTasksCall = {},
      ): Promise<{ items: TaskSummary[]; nextCursor?: string }> {
        taskCalls.push(args)
        return {
          items: opts.tasks ?? [],
          nextCursor: opts.tasksNextCursor,
        }
      },
    },
  }
}

describe("gatherDigestData", () => {
  it("labels the output with the supplied project label", async () => {
    const services = stubServices({})
    const result = await gatherDigestData(services, {
      projectLabel: "Mail",
      period: "week",
    })
    expect(result.raw).toContain("# Digest Data — Mail")
  })

  it("reports recentMemoryCount so schedulers can short-circuit on quiet windows", async () => {
    const services = stubServices({ memories: [] })
    const result = await gatherDigestData(services, { projectLabel: "Mail" })
    expect(result.recentMemoryCount).toBe(0)
    expect(result.raw).toContain("No memories found")
  })

  it("returns the last digest's createdAt date (YYYY-MM-DD) when one exists", async () => {
    const services = stubServices({
      digestMemory: makeMemory({
        source: "digest",
        title: "Digest — 2026-04-10 — Mail",
        createdAt: "2026-04-10T00:00:00.000Z",
      }),
    })
    const result = await gatherDigestData(services, { projectLabel: "Mail" })
    expect(result.lastDigestDate).toBe("2026-04-10")
    expect(result.raw).toContain("Previous Digest")
  })

  it("returns null lastDigestDate when no digest exists", async () => {
    const services = stubServices({ digestMemory: null })
    const result = await gatherDigestData(services, { projectLabel: "Mail" })
    expect(result.lastDigestDate).toBeNull()
    expect(result.raw).not.toContain("Previous Digest")
  })

  it("queries the latest digest by created_time, not last_edited_time", async () => {
    // Regression: the default sort order is last_edited_time, which would let
    // an edit to an older digest mask a newer one. Wake-up uses created_time
    // for the exact same lookup — we must stay consistent or the two code
    // paths disagree on which digest is the "freshest".
    const services = stubServices({})
    await gatherDigestData(services, { projectLabel: "Mail" })
    const digestCall = services.calls.find((c) => c.source === "digest")
    expect(digestCall?.sortBy).toBe("created_time")
  })

  it("accepts an injected clock for deterministic window + overdue computation", async () => {
    const fixed = new Date("2026-04-24T12:00:00.000Z")
    const services = stubServices({
      tasks: [
        makeTask({
          title: "ship",
          entity: "Alice",
          taskState: "open",
          reviewBy: "2026-04-24",
        }),
      ],
    })
    const result = await gatherDigestData(services, {
      projectLabel: "Mail",
      period: "day",
      now: () => fixed,
    })
    const call = services.calls.find((c) => c.source !== "digest")
    expect(call?.since).toBe("2026-04-23T12:00:00.000Z")
    expect(result.raw).toContain("OVERDUE")
  })

  it("groups memories by source in the Activity section", async () => {
    const services = stubServices({
      memories: [
        makeMemory({ title: "conv-1", source: "conversation" }),
        makeMemory({ title: "diary-1", source: "agent_diary" }),
        makeMemory({ title: "conv-2", source: "conversation" }),
      ],
    })
    const result = await gatherDigestData(services, { projectLabel: "Mail" })
    expect(result.raw).toContain("### conversation (2)")
    expect(result.raw).toContain("### agent_diary (1)")
    expect(result.raw).toContain("conv-1")
    expect(result.raw).toContain("diary-1")
  })

  it("flags overdue tasks under Open Work", async () => {
    const today = new Date().toISOString().split("T")[0]!
    const services = stubServices({
      tasks: [
        makeTask({
          title: "reply to RFC",
          entity: "Alice",
          taskState: "open",
          reviewBy: today, // today counts as overdue
        }),
      ],
    })
    const result = await gatherDigestData(services, { projectLabel: "Mail" })
    expect(result.raw).toContain("## Open Work (1)")
    expect(result.raw).toContain("OVERDUE")
  })

  it("applies a day window when period is 'day'", async () => {
    const services = stubServices({})
    const before = Date.now() - 86_400_000 - 1_000
    await gatherDigestData(services, { projectLabel: "Mail", period: "day" })
    const call = services.calls.find((c) => c.source !== "digest")
    expect(call).toBeDefined()
    expect(new Date(call!.since!).getTime()).toBeGreaterThan(before)
  })

  it("respects an explicit since/until window", async () => {
    const services = stubServices({})
    await gatherDigestData(services, {
      projectLabel: "Mail",
      since: "2026-04-01T00:00:00.000Z",
      until: "2026-04-15T00:00:00.000Z",
    })
    const call = services.calls.find((c) => c.source !== "digest")
    expect(call?.since).toBe("2026-04-01T00:00:00.000Z")
    expect(call?.until).toBe("2026-04-15T00:00:00.000Z")
  })

  it("renders 'many more' for Open Work when Notion reports nextCursor", async () => {
    // Regression: pre-fix the digest reported `+ N more` based on local
    // fetch size only. On a vault with 100+ open tasks, fetching with
    // `limit: 26` returns 26 rows and tells the synthesizer "+ 1 more"
    // when 75+ are hidden. Notion's `nextCursor` (mirrored as
    // `has_more`) is the canonical truncation signal — test asserts
    // that branch wins over the local count.
    const overflowTasks = Array.from({ length: 26 }, (_, i) =>
      makeTask({
        title: `task ${i}`,
        entity: `entity-${i}`,
        taskState: "open",
      }),
    )
    const services = stubServices({
      tasks: overflowTasks,
      tasksNextCursor: "more-rows-exist",
    })
    const result = await gatherDigestData(services, { projectLabel: "Mail" })
    expect(result.raw).toContain(
      "## Open Work (25 shown; many more open beyond the cap)",
    )
    expect(result.raw).toContain("many more open tasks not shown")
    // The bullet body never tries to enumerate the unknown tail count.
    expect(result.raw).not.toContain("and 1 more.")
  })

  it("renders an exact hidden count when truncation lands inside the local probe", async () => {
    // The other truncation case: 26 rows fit in the +1 probe, no
    // nextCursor, so we know exactly one task is hidden.
    const tasks = Array.from({ length: 26 }, (_, i) =>
      makeTask({
        title: `task ${i}`,
        entity: `entity-${i}`,
        taskState: "open",
      }),
    )
    const services = stubServices({ tasks, tasksNextCursor: undefined })
    const result = await gatherDigestData(services, { projectLabel: "Mail" })
    expect(result.raw).toContain("## Open Work (25 shown of 26)")
    expect(result.raw).toContain("and 1 more.")
  })
})

describe("daysSince", () => {
  it("returns 0 for the same day", () => {
    const now = new Date("2026-04-24T12:00:00.000Z")
    expect(daysSince("2026-04-24T00:00:00.000Z", now)).toBe(0)
  })

  it("returns 7 for exactly one week ago", () => {
    const now = new Date("2026-04-24T00:00:00.000Z")
    expect(daysSince("2026-04-17T00:00:00.000Z", now)).toBe(7)
  })
})
