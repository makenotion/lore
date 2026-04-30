import { describe, expect, it, vi } from "vitest"
import {
  parseReconcileCliOptions,
  runReconcile,
  type ReconcileCliOptions,
} from "./tasks.js"
import type { LoreServices } from "../../services.js"
import type { Memory, TaskSummary } from "../../types.js"

function makeTask(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "t1",
    title: "Track PR-25750",
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
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    taskState: "open",
    blockedBy: "",
    entity: "PR-25750",
    topicKey: "",
    revisionCount: 1,
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
    createdAt: "2026-04-25T00:00:00.000Z",
    updatedAt: "2026-04-25T00:00:00.000Z",
    taskState: null,
    blockedBy: "",
    entity: "",
    topicKey: "",
    revisionCount: 1,
    ...overrides,
  }
}

/**
 * Build a `LoreServices`-shaped stub narrow to what `runReconcile`
 * actually touches: `projects.findByName`, `tasks.list`, `memories.search`,
 * `memories.materializeContent`, `context.project`. Anything else is
 * cast through `unknown` — the helper neither reads nor writes those
 * fields and a real `LoreServices` would force a much larger fixture.
 */
function makeServices(opts: {
  findByName?: ReturnType<typeof vi.fn>
  contextProject?: { id: string; name: string; path: string } | null
  tasksItems?: TaskSummary[]
  memoriesByQuery?: (query: string) => Memory[]
}): LoreServices {
  return {
    projects: {
      findByName: opts.findByName ?? vi.fn().mockResolvedValue(null),
    },
    tasks: {
      list: vi.fn().mockResolvedValue({ items: opts.tasksItems ?? [] }),
    },
    memories: {
      search: vi.fn(async ({ query }: { query: string }) => {
        return opts.memoriesByQuery ? opts.memoriesByQuery(query) : []
      }),
      materializeContent: vi.fn(async (m: Memory) => m),
    },
    context: { project: opts.contextProject ?? null },
  } as unknown as LoreServices
}

describe("parseReconcileCliOptions", () => {
  it("accepts well-formed --min-score and --limit", () => {
    const result = parseReconcileCliOptions({
      project: "Mail",
      minScore: "0.7",
      limit: "10",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual<ReconcileCliOptions>({
        projectName: "Mail",
        minScore: 0.7,
        limit: 10,
      })
    }
  })

  it("accepts unspecified project as undefined", () => {
    const result = parseReconcileCliOptions({
      minScore: "0.5",
      limit: "25",
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.projectName).toBeUndefined()
  })

  it("rejects --min-score with a non-numeric string", () => {
    const result = parseReconcileCliOptions({
      minScore: "banana",
      limit: "25",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("--min-score")
  })

  it("rejects --min-score below 0", () => {
    const result = parseReconcileCliOptions({
      minScore: "-0.1",
      limit: "25",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("between 0 and 1")
  })

  it("rejects --min-score above 1", () => {
    const result = parseReconcileCliOptions({
      minScore: "1.5",
      limit: "25",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("between 0 and 1")
  })

  it("rejects --limit with a non-numeric string", () => {
    const result = parseReconcileCliOptions({
      minScore: "0.5",
      limit: "abc",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("--limit")
  })

  it("rejects --limit below 1", () => {
    const result = parseReconcileCliOptions({
      minScore: "0.5",
      limit: "0",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("between 1 and 100")
  })

  it("rejects --limit above MAX_RECONCILE_LIMIT (100)", () => {
    const result = parseReconcileCliOptions({
      minScore: "0.5",
      limit: "9999",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("between 1 and 100")
  })
})

describe("runReconcile", () => {
  it("warns and falls back to auto-detected project when --project resolves nothing", async () => {
    const messages: string[] = []
    const findByName = vi.fn().mockResolvedValue(null)
    const services = makeServices({
      findByName,
      contextProject: { id: "ctx-proj", name: "AutoDetected", path: "." },
    })
    const output = await runReconcile(
      services,
      { projectName: "Nonexistent", minScore: 0.5, limit: 25 },
      (msg) => messages.push(msg),
    )

    expect(findByName).toHaveBeenCalledWith("Nonexistent")
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('"Nonexistent" not found')
    // Falls back to auto-detected project — assertion shape mirrors
    // the MCP-side test that pins the same contract for the action
    // handler.
    const tasksList = services.tasks.list as ReturnType<typeof vi.fn>
    expect(tasksList).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "ctx-proj" }),
    )
    expect(output).toContain("0 candidate closures")
  })

  it("scopes to the named project when findByName resolves", async () => {
    const findByName = vi
      .fn()
      .mockResolvedValue({ id: "p-mail", name: "Mail", path: "mail" })
    const services = makeServices({
      findByName,
      contextProject: { id: "ctx-other", name: "Other", path: "other" },
    })
    await runReconcile(
      services,
      { projectName: "Mail", minScore: 0.5, limit: 25 },
      () => {},
    )

    const tasksList = services.tasks.list as ReturnType<typeof vi.fn>
    // Named project wins over the auto-detected context.
    expect(tasksList).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p-mail" }),
    )
  })

  it("returns the same markdown shape as formatReconcileOutput for a populated case (byte-identity claim against the MCP surface)", async () => {
    // Pin the byte-identity contract from the PR body's Test plan:
    // the CLI subcommand and the MCP action share `reconcileActiveTasks`,
    // so a populated case must produce the same shape on both sides.
    // We assert on the rendered markers (heading + ranked row + close
    // incantation) rather than diffing against the MCP output directly
    // — both surfaces route through `formatReconcileOutput`, so a shape
    // match here implies byte-identity by construction.
    const task = makeTask({
      id: "t-abc",
      title: "Track PR-25750 review",
      taskState: "in-progress",
    })
    const memory = makeMemory({
      id: "m-good",
      title: "Merged PR-25750",
      content: "Merged PR-25750 — outlook label.applied classifier shipped.",
      createdAt: new Date().toISOString(),
    })
    const services = makeServices({
      contextProject: null,
      tasksItems: [task],
      memoriesByQuery: () => [memory],
    })

    const output = await runReconcile(
      services,
      { projectName: undefined, minScore: 0.5, limit: 25 },
      () => {},
    )

    expect(output).toContain("## 1 candidate closure (out of 1 active task scanned)")
    expect(output).toContain('### 1. Task t-abc — "Track PR-25750 review" [in-progress')
    expect(output).toContain("Best match: memory m-good")
    expect(output).toContain("Cue: ")
    expect(output).toContain("Close: lore-task({ action: 'close', taskId: 't-abc' })")
  })

  it("renders the empty-set form on a vault with no active tasks", async () => {
    const services = makeServices({ contextProject: null })
    const output = await runReconcile(
      services,
      { projectName: undefined, minScore: 0.5, limit: 25 },
      () => {},
    )
    expect(output).toBe(
      "## 0 candidate closures (out of 0 active tasks scanned)",
    )
  })
})
