import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  parseReconcileCliOptions,
  runReconcile,
  tasksCommand,
  type ReconcileCliOptions,
} from "./tasks.js"
import { initServices, type LoreServices } from "../../services.js"
import type { Memory, TaskSummary } from "../../types.js"

vi.mock("../../services.js", () => ({
  initServices: vi.fn(),
}))

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
    createdAt: "2026-04-25T00:00:00.000Z",
    updatedAt: "2026-04-25T00:00:00.000Z",
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

  it.each([
    "banana",
    "0.5abc",
    "+0.5",
    "-0.1",
    "5e-1",
    "1.5",
    "1.0000000000000001",
    "1.0000000000000000000001",
  ])("rejects malformed or out-of-range --min-score value %j", (minScore) => {
    const result = parseReconcileCliOptions({
      minScore,
      limit: "25",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toBe(
        `--min-score must be a number in [0, 1], got "${minScore}"`
      )
    }
  })

  it.each(["abc", "", "3.7", "3abc", "1e3", "+5", "-1"])(
    "rejects malformed --limit value %j",
    (limit) => {
      const result = parseReconcileCliOptions({
        minScore: "0.5",
        limit,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.message).toContain("--limit")
        expect(result.message).toContain("decimal integer")
      }
    }
  )

  it("rejects --limit below 1", () => {
    const result = parseReconcileCliOptions({
      minScore: "0.5",
      limit: "0",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("positive integer")
  })

  it("rejects --limit above MAX_RECONCILE_LIMIT (100)", () => {
    const result = parseReconcileCliOptions({
      minScore: "0.5",
      limit: "9999",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("between 1 and 100")
  })

  it("rejects --limit beyond Number.MAX_SAFE_INTEGER", () => {
    const result = parseReconcileCliOptions({
      minScore: "0.5",
      limit: "9007199254740992",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("safe integer range")
  })
})

describe("runReconcile", () => {
  it("rejects when --project resolves nothing", async () => {
    const findByName = vi.fn().mockResolvedValue(null)
    const services = makeServices({
      findByName,
      contextProject: { id: "ctx-proj", name: "AutoDetected", path: "." },
    })

    await expect(
      runReconcile(services, { projectName: "Nonexistent", minScore: 0.5, limit: 25 })
    ).rejects.toThrow(
      'Project "Nonexistent" could not be resolved (not found, archived, or inaccessible).'
    )

    expect(findByName).toHaveBeenNthCalledWith(1, "Nonexistent")
    expect(findByName).toHaveBeenNthCalledWith(2, "Nonexistent", {
      includeArchived: true,
    })
    const tasksList = services.tasks.list as ReturnType<typeof vi.fn>
    expect(tasksList).not.toHaveBeenCalled()
  })

  it("rejects with archived-specific wording when --project resolves only as archived", async () => {
    const findByName = vi.fn(
      async (name: string, options?: { includeArchived?: boolean }) =>
        options?.includeArchived
          ? {
              id: "p-archive",
              name,
              path: "archive",
              type: "project",
              status: "archived",
              description: "",
            }
          : null
    )
    const services = makeServices({
      findByName,
      contextProject: { id: "ctx-proj", name: "AutoDetected", path: "." },
    })

    await expect(
      runReconcile(services, { projectName: "Archive", minScore: 0.5, limit: 25 })
    ).rejects.toThrow(
      'Project "Archive" could not be resolved because it is archived.'
    )

    expect(findByName).toHaveBeenNthCalledWith(1, "Archive")
    expect(findByName).toHaveBeenNthCalledWith(2, "Archive", {
      includeArchived: true,
    })
    const tasksList = services.tasks.list as ReturnType<typeof vi.fn>
    expect(tasksList).not.toHaveBeenCalled()
  })

  it("rejects blank --project before context fallback", async () => {
    const findByName = vi.fn()
    const services = makeServices({
      findByName,
      contextProject: { id: "ctx-proj", name: "AutoDetected", path: "." },
    })

    await expect(
      runReconcile(services, { projectName: "", minScore: 0.5, limit: 25 })
    ).rejects.toThrow('Project "" could not be resolved')

    expect(findByName).not.toHaveBeenCalled()
    const tasksList = services.tasks.list as ReturnType<typeof vi.fn>
    expect(tasksList).not.toHaveBeenCalled()
  })

  it("scopes to the named project when findByName resolves", async () => {
    const findByName = vi
      .fn()
      .mockResolvedValue({ id: "p-mail", name: "Mail", path: "mail" })
    const services = makeServices({
      findByName,
      contextProject: { id: "ctx-other", name: "Other", path: "other" },
    })
    await runReconcile(services, { projectName: "Mail", minScore: 0.5, limit: 25 })

    const tasksList = services.tasks.list as ReturnType<typeof vi.fn>
    // Named project wins over the auto-detected context.
    expect(tasksList).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p-mail" })
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

    const output = await runReconcile(services, {
      projectName: undefined,
      minScore: 0.5,
      limit: 25,
    })

    expect(output).toContain("## 1 candidate closure (out of 1 active task scanned)")
    expect(output).toContain('### 1. Task t-abc — "Track PR-25750 review" [in-progress')
    expect(output).toContain("Best match: memory m-good")
    expect(output).toContain("Cue: ")
    expect(output).toContain("Close: lore-task({ action: 'close', taskId: 't-abc' })")
  })

  it("renders the empty-set form on a vault with no active tasks", async () => {
    const services = makeServices({ contextProject: null })
    const output = await runReconcile(services, {
      projectName: undefined,
      minScore: 0.5,
      limit: 25,
    })
    expect(output).toBe("## 0 candidate closures (out of 0 active tasks scanned)")
  })
})

/**
 * Commander-level integration coverage for `lore tasks reconcile`. The
 * helpers `parseReconcileCliOptions` and `runReconcile` above are exercised
 * directly; this block drives `tasksCommand.parseAsync(["reconcile", ...])`
 * so the `.action(...)` glue — `console.error("Reconcile failed: ...")`,
 * `process.exit(1)`, and the `initServices` boundary — is verified end-to-end.
 *
 * Without this, a future refactor that swallowed `parsed.ok === false` (e.g.
 * an early-return without `process.exit`) would silently succeed in
 * production while every helper-level test still passed.
 */
describe("tasksCommand reconcile action", () => {
  let errorSpy: ReturnType<typeof vi.fn>
  let logSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.mocked(initServices).mockReset()
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__process_exit_${typeof code === "number" ? code : 0}__`)
    }) as never)
    errorSpy = vi.fn()
    logSpy = vi.fn()
    vi.spyOn(console, "error").mockImplementation(errorSpy)
    vi.spyOn(console, "log").mockImplementation(logSpy)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("exits 1 with 'Reconcile failed:' prefix on malformed --min-score and skips initServices", async () => {
    await expect(
      tasksCommand.parseAsync(["reconcile", "--min-score", "abc"], { from: "user" })
    ).rejects.toThrow("__process_exit_1__")

    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
    // Pin "fired exactly once" + "no sentinel leaked" so a future refactor
    // that routes parse-failure back through the generic catch arm (which
    // would re-fire console.error with the throw-mock's `__process_exit_1__`
    // sentinel as the operator-facing message) regresses this test rather
    // than passing under the loose .toContain check.
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain(
      'Reconcile failed: --min-score must be a number in [0, 1], got "abc"'
    )
    expect(errorText).not.toContain("__process_exit_")
  })

  it.each([
    ["3.7", 'Reconcile failed: --limit must be a positive decimal integer, got "3.7"'],
    // Over-cap goes through the explicit MAX_RECONCILE_LIMIT branch in
    // parseReconcileCliOptions rather than the regex branch — covering it at
    // the action layer pins the contract against a future refactor that
    // throws on over-cap (instead of returning ok: false).
    ["9999", "Reconcile failed: --limit must be between 1 and 100, got 9999"],
  ])(
    "exits 1 with the structured prefix on rejected --limit %s and skips initServices",
    async (limit, expectedMessage) => {
      await expect(
        tasksCommand.parseAsync(["reconcile", "--limit", limit], { from: "user" })
      ).rejects.toThrow("__process_exit_1__")

      expect(vi.mocked(initServices)).not.toHaveBeenCalled()
      expect(errorSpy).toHaveBeenCalledTimes(1)
      const errorText = errorSpy.mock.calls.flat().join("\n")
      expect(errorText).toContain(expectedMessage)
      expect(errorText).not.toContain("__process_exit_")
    }
  )

  it("exits 1 via the catch path with the wrapped message when initServices throws", async () => {
    vi.mocked(initServices).mockRejectedValue(new Error("vault unreachable"))

    await expect(
      tasksCommand.parseAsync(["reconcile"], { from: "user" })
    ).rejects.toThrow("__process_exit_1__")

    expect(vi.mocked(initServices)).toHaveBeenCalledTimes(1)
    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Reconcile failed:")
    expect(errorText).toContain("vault unreachable")
    expect(logSpy).not.toHaveBeenCalled()
  })

  it("calls initServices exactly once and prints runReconcile output to stdout on the happy path", async () => {
    const services = makeServices({ contextProject: null })
    vi.mocked(initServices).mockResolvedValue(services)

    await tasksCommand.parseAsync(["reconcile"], { from: "user" })

    expect(vi.mocked(initServices)).toHaveBeenCalledTimes(1)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalledWith(
      "## 0 candidate closures (out of 0 active tasks scanned)"
    )
  })
})
