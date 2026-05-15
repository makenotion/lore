import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  parseCloseCliOptions,
  parseCreateCliOptions,
  parseListCliOptions,
  parseReconcileCliOptions,
  parseUpdateCliOptions,
  runReconcile,
  runTaskClose,
  runTaskCreate,
  runTaskList,
  runTaskUpdate,
  tasksCommand,
  type ReconcileCliOptions,
} from "./tasks.js"
import { initServices, type LoreServices } from "../../services.js"
import type { Memory, Task, TaskSummary } from "../../types.js"
import { INVALID_LIMIT_STRINGS, trapProcessExit } from "../test-helpers.js"

vi.mock("../../services.js", () => ({
  initServices: vi.fn(),
}))

function makeTask(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "t1",
    title: "Track PR-1234",
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
    entity: "PR-1234",
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
  tasksCreate?: ReturnType<typeof vi.fn>
  tasksUpdate?: ReturnType<typeof vi.fn>
  tasksClose?: ReturnType<typeof vi.fn>
  tasksGetById?: ReturnType<typeof vi.fn>
  topicsGetOrCreate?: ReturnType<typeof vi.fn>
}): LoreServices {
  return {
    projects: {
      findByName: opts.findByName ?? vi.fn().mockResolvedValue(null),
    },
    tasks: {
      list: vi.fn().mockResolvedValue({ items: opts.tasksItems ?? [] }),
      create:
        opts.tasksCreate ??
        vi.fn().mockResolvedValue(makeTask({ id: "t-new", title: "stubbed" })),
      update:
        opts.tasksUpdate ??
        vi.fn().mockResolvedValue(makeTask({ id: "t-upd", title: "stubbed" })),
      close: opts.tasksClose ?? vi.fn().mockResolvedValue(undefined),
      getById:
        opts.tasksGetById ??
        vi.fn().mockResolvedValue(
          makeTask({
            id: "t-after-close",
            title: "stubbed",
            taskState: "done",
            doneAt: "2026-05-03",
          })
        ),
    },
    topics: {
      getOrCreate:
        opts.topicsGetOrCreate ??
        vi.fn().mockResolvedValue({ id: "topic-1", name: "stubbed-topic" }),
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
      project: "Widget",
      minScore: "0.7",
      limit: "10",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual<ReconcileCliOptions>({
        projectName: "Widget",
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
    ).rejects.toThrow('Project "Archive" could not be resolved because it is archived.')

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
      .mockResolvedValue({ id: "p-widget", name: "Widget", path: "apps/widget" })
    const services = makeServices({
      findByName,
      contextProject: { id: "ctx-other", name: "Other", path: "other" },
    })
    await runReconcile(services, { projectName: "Widget", minScore: 0.5, limit: 25 })

    const tasksList = services.tasks.list as ReturnType<typeof vi.fn>
    // Named project wins over the auto-detected context.
    expect(tasksList).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p-widget" })
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
      title: "Track PR-1234 review",
      taskState: "in-progress",
    })
    const memory = makeMemory({
      id: "m-good",
      title: "Merged PR-1234",
      content: "Merged PR-1234 — outlook label.applied classifier shipped.",
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
    expect(output).toContain('### 1. Task t-abc — "Track PR-1234 review" [in-progress')
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

// ---------------------------------------------------------------------------
// Action-wrapper exit-path tests for the `lore tasks reconcile` command.
//
// `runReconcile` is exercised above as a pure function; this block covers
// the two `process.exit(1)` call sites in the action wrapper itself
// (parse failure inside the try, catch-all) so a refactor that swaps
// `process.exit` for a thrown error breaks the test loudly instead of
// silently changing what shell-script integrations observe.
// ---------------------------------------------------------------------------

describe("tasksCommand reconcile action", () => {
  let errorSpy: ReturnType<typeof vi.fn>
  let logSpy: ReturnType<typeof vi.fn>
  let exitTrap: ReturnType<typeof trapProcessExit>

  beforeEach(() => {
    vi.mocked(initServices).mockReset()
    exitTrap = trapProcessExit()
    errorSpy = vi.fn()
    logSpy = vi.fn()
    vi.spyOn(console, "error").mockImplementation(errorSpy)
    vi.spyOn(console, "log").mockImplementation(logSpy)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each(["banana", "1.5"])(
    "exits 1 once before initServices on invalid --min-score %j",
    async (raw) => {
      await tasksCommand.parseAsync(["reconcile", "--min-score", raw], {
        from: "user",
      })

      const errorText = errorSpy.mock.calls.flat().join("\n")
      expect(errorText).toContain("Reconcile failed:")
      expect(errorText).toContain("--min-score")
      // `toEqual([1])` — not `toContain(1)` — pins the exit-once
      // contract. A future refactor that drops the defensive `return`
      // after `process.exit(1)` would let execution fall through to
      // the outer catch and produce a doubled `process.exit(1)` plus
      // a second `console.error`. The strict assertion catches that
      // regression loudly. See PR #512's review.
      expect(exitTrap.exitCodes).toEqual([1])
      expect(errorSpy).toHaveBeenCalledTimes(1)
      // Pre-`initServices` short-circuit is what makes the validation
      // cheap — flipping the order would force every malformed CLI
      // call to pay a Notion round-trip before rejecting.
      expect(vi.mocked(initServices)).not.toHaveBeenCalled()
    }
  )

  it.each(INVALID_LIMIT_STRINGS)(
    "exits 1 once before initServices on invalid --limit %j",
    async (raw) => {
      await tasksCommand.parseAsync(["reconcile", "--limit", raw], { from: "user" })

      const errorText = errorSpy.mock.calls.flat().join("\n")
      expect(errorText).toContain("Reconcile failed:")
      expect(errorText).toContain("--limit")
      expect(exitTrap.exitCodes).toEqual([1])
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(vi.mocked(initServices)).not.toHaveBeenCalled()
    }
  )

  it("exits 1 once before initServices on --limit 9999 (over-cap)", async () => {
    // Over-cap rejection is structurally a parse failure (rejected by
    // `parseReconcileCliOptions` before `initServices`), but the
    // wording is cap-specific so it lives outside the malformed fuzz
    // set above.
    await tasksCommand.parseAsync(["reconcile", "--limit", "9999"], { from: "user" })

    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Reconcile failed:")
    expect(errorText).toContain("--limit must be between 1 and 100")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
  })

  it("exits 1 via the catch-all when initServices throws", async () => {
    // Distinct from the parse-failure path: this is the bare
    // "Notion call inside the action body raised" branch — operators
    // rely on a non-zero exit code so `if ! lore tasks reconcile; then`
    // shell integrations fail fast rather than treat an outage as
    // "no candidate closures."
    vi.mocked(initServices).mockRejectedValue(new Error("notion 503: gateway"))

    await tasksCommand.parseAsync(["reconcile"], { from: "user" })

    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Reconcile failed:")
    expect(errorText).toContain("notion 503: gateway")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(logSpy).not.toHaveBeenCalled()
  })

  it("exits 1 via the catch-all when runReconcile rejects on an unresolved --project", async () => {
    // `resolveProjectScopeName` throws on a name miss. The action body's
    // try/catch must surface the throw as a clean exit, not a stack trace.
    vi.mocked(initServices).mockResolvedValue({
      projects: { findByName: vi.fn().mockResolvedValue(null) },
      tasks: { list: vi.fn() },
      memories: { search: vi.fn(), materializeContent: vi.fn() },
      context: { project: null },
    } as never)

    await tasksCommand.parseAsync(["reconcile", "--project", "Missing"], {
      from: "user",
    })

    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Reconcile failed:")
    expect(errorText).toContain('Project "Missing" could not be resolved')
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it("calls initServices exactly once and prints runReconcile output to stdout on the happy path", async () => {
    // Preserved from PR #510's coverage: end-to-end happy-path that the
    // action-glue invokes `initServices`, calls `runReconcile`, and
    // routes the output to stdout. Without this, a refactor that
    // accidentally short-circuited the action body before `console.log`
    // would leave every helper-level test passing while the operator-
    // facing CLI silently emitted nothing.
    const services = makeServices({ contextProject: null })
    vi.mocked(initServices).mockResolvedValue(services)

    await tasksCommand.parseAsync(["reconcile"], { from: "user" })

    expect(vi.mocked(initServices)).toHaveBeenCalledTimes(1)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(exitTrap.exitCodes).toEqual([])
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalledWith(
      "## 0 candidate closures (out of 0 active tasks scanned)"
    )
  })
})

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("parseCreateCliOptions", () => {
  it("returns the parsed shape on a well-formed payload", () => {
    const result = parseCreateCliOptions("Track PR-1234", {
      project: "Widget",
      description: "Body text",
      entity: "PR-1234",
      state: "open",
      dueDate: "2026-05-10",
      tags: " frontend, ios ,, ",
      keywords: "kw-1 kw-2",
      synopsis: "What done looks like.",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.subject).toBe("Track PR-1234")
      expect(result.value.projectName).toBe("Widget")
      expect(result.value.description).toBe("Body text")
      expect(result.value.entity).toBe("PR-1234")
      expect(result.value.state).toBe("open")
      expect(result.value.dueDate).toBe("2026-05-10")
      expect(result.value.tags).toEqual(["frontend", "ios"])
      expect(result.value.keywords).toBe("kw-1 kw-2")
      expect(result.value.synopsis).toBe("What done looks like.")
    }
  })

  it("rejects an empty subject before any other field validation", () => {
    const result = parseCreateCliOptions("   ", { state: "bogus" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("<subject>")
  })

  it("rejects an unknown --state", () => {
    const result = parseCreateCliOptions("subject", { state: "frobnicating" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("--state")
      expect(result.message).toContain("frobnicating")
    }
  })

  it("rejects --due-date when not YYYY-MM-DD", () => {
    const result = parseCreateCliOptions("subject", { dueDate: "tomorrow" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("--due-date")
  })

  it("rejects --state=blocked without --blocked-by", () => {
    const result = parseCreateCliOptions("subject", { state: "blocked" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("--blocked-by")
  })

  it("accepts --state=blocked when --blocked-by is provided", () => {
    const result = parseCreateCliOptions("subject", {
      state: "blocked",
      blockedBy: "PR-1",
    })
    expect(result.ok).toBe(true)
  })

  it.each(["   ", "\t", " \t \n "])(
    "rejects --state=blocked with whitespace-only --blocked-by %j",
    (blockedBy) => {
      // Mirrors MCP's `isUnusableBlockerLabel` boundary guard: a blocked
      // task whose blocker label is visually blank in `lore tasks list`
      // is unactionable for triage. The previous parse helper used a
      // truthiness check that accepted `"   "` because `Boolean("   ")
      // === true`, letting an unactionable row land. Pin every
      // whitespace shape (spaces, tab, mixed) so a future refactor that
      // narrows the trim coverage breaks loudly.
      const result = parseCreateCliOptions("subject", {
        state: "blocked",
        blockedBy,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.message).toContain("--blocked-by")
        expect(result.message).toContain("whitespace-only labels are rejected")
      }
    }
  )

  it("rejects --tags values not in the closed TAG_VOCABULARY and points at --keywords", () => {
    // Tag validation parity with MCP `tagsSchema`: out-of-vocab labels
    // (PR numbers, ticket IDs, file paths) must fail at the boundary
    // and the message must point operators at --keywords for free-form
    // labels rather than letting the write reach Notion as a generic 400.
    const result = parseCreateCliOptions("subject", {
      tags: "frontend, pr-1234, not-a-real-tag",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("--tags")
      expect(result.message).toContain('"pr-1234"')
      expect(result.message).toContain('"not-a-real-tag"')
      expect(result.message).toContain("closed tag vocabulary")
      expect(result.message).toContain("--keywords")
    }
  })

  it("accepts --tags values from the closed TAG_VOCABULARY", () => {
    const result = parseCreateCliOptions("subject", {
      tags: "frontend, ios, ui",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tags).toEqual(["frontend", "ios", "ui"])
    }
  })

  it("validates --tags against the supplied profile vocabulary", () => {
    const accepted = parseCreateCliOptions("subject", { tags: "alpha, beta" }, [
      "alpha",
      "beta",
    ])
    expect(accepted.ok).toBe(true)

    const rejected = parseCreateCliOptions("subject", { tags: "frontend" }, [
      "alpha",
      "beta",
    ])
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.message).toContain("alpha, beta")
      expect(rejected.message).not.toContain("ios")
    }
  })
})

describe("runTaskCreate", () => {
  it("rejects when --project resolves nothing", async () => {
    const findByName = vi.fn().mockResolvedValue(null)
    const services = makeServices({ findByName, contextProject: null })

    await expect(
      runTaskCreate(services, {
        subject: "subject",
        description: undefined,
        entity: undefined,
        state: undefined,
        blockedBy: undefined,
        dueDate: undefined,
        projectName: "Nonexistent",
        topicName: undefined,
        tags: undefined,
        keywords: undefined,
        synopsis: undefined,
      })
    ).rejects.toThrow(
      'Project "Nonexistent" could not be resolved (not found, archived, or inaccessible).'
    )

    const tasksCreate = services.tasks.create as ReturnType<typeof vi.fn>
    expect(tasksCreate).not.toHaveBeenCalled()
  })

  it("scopes create to the named project and renders the confirmation", async () => {
    const findByName = vi
      .fn()
      .mockResolvedValue({ id: "p-widget", name: "Widget", path: "apps/widget" })
    const created = makeTask({
      id: "t-abc",
      title: "Track PR-1234",
      taskState: "open",
      reviewBy: "2026-05-10",
      entity: "PR-1234",
    }) as unknown as Task
    const tasksCreate = vi.fn().mockResolvedValue(created)
    const services = makeServices({
      findByName,
      contextProject: { id: "ctx-other", name: "Other", path: "other" },
      tasksCreate,
    })

    const result = await runTaskCreate(services, {
      subject: "Track PR-1234",
      description: "Body",
      entity: "PR-1234",
      state: "open",
      blockedBy: undefined,
      dueDate: "2026-05-10",
      projectName: "Widget",
      topicName: undefined,
      tags: ["frontend"],
      keywords: "kw",
      synopsis: "syn",
    })

    expect(tasksCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Track PR-1234",
        description: "Body",
        entity: "PR-1234",
        state: "open",
        dueDate: "2026-05-10",
        projectIds: ["p-widget"],
        tags: ["frontend"],
        keywords: "kw",
        synopsis: "syn",
      })
    )
    expect(result.text).toContain('Created task: "Track PR-1234" (t-abc)')
    expect(result.text).toContain("State: open")
    expect(result.text).toContain("Project: Widget")
    // Topic line is suppressed when --topic was not supplied (no signal).
    expect(result.text).not.toContain("Topic:")
    expect(result.text).toContain("Entity: PR-1234")
    expect(result.text).toContain("Due: 2026-05-10")
    expect(result.data.reused).toBe(false)
    expect(result.data.id).toBe("t-abc")
  })

  it("falls back to the auto-detected context project when --project is absent", async () => {
    const tasksCreate = vi
      .fn()
      .mockResolvedValue(makeTask({ id: "t-1", title: "subject" }) as unknown as Task)
    const services = makeServices({
      contextProject: { id: "ctx-widget", name: "Widget", path: "apps/widget" },
      tasksCreate,
    })

    await runTaskCreate(services, {
      subject: "subject",
      description: undefined,
      entity: undefined,
      state: undefined,
      blockedBy: undefined,
      dueDate: undefined,
      projectName: undefined,
      topicName: undefined,
      tags: undefined,
      keywords: undefined,
      synopsis: undefined,
    })

    expect(tasksCreate).toHaveBeenCalledWith(
      expect.objectContaining({ projectIds: ["ctx-widget"] })
    )
  })

  it("creates the topic via topics.getOrCreate when --topic is provided alongside a project", async () => {
    const tasksCreate = vi
      .fn()
      .mockResolvedValue(makeTask({ id: "t-2", title: "subject" }) as unknown as Task)
    const topicsGetOrCreate = vi
      .fn()
      .mockResolvedValue({ id: "topic-ship", name: "ship-it" })
    const services = makeServices({
      contextProject: { id: "ctx-widget", name: "Widget", path: "apps/widget" },
      tasksCreate,
      topicsGetOrCreate,
    })

    const result = await runTaskCreate(services, {
      subject: "subject",
      description: undefined,
      entity: undefined,
      state: undefined,
      blockedBy: undefined,
      dueDate: undefined,
      projectName: undefined,
      topicName: "ship-it",
      tags: undefined,
      keywords: undefined,
      synopsis: undefined,
    })

    expect(topicsGetOrCreate).toHaveBeenCalledWith("ship-it", ["ctx-widget"])
    expect(tasksCreate).toHaveBeenCalledWith(
      expect.objectContaining({ topicId: "topic-ship" })
    )
    expect(result.text).toContain("Topic: ship-it")
  })

  it("warns when --topic is supplied without a resolvable project", async () => {
    const tasksCreate = vi
      .fn()
      .mockResolvedValue(makeTask({ id: "t-3", title: "subject" }) as unknown as Task)
    const services = makeServices({ contextProject: null, tasksCreate })

    const result = await runTaskCreate(services, {
      subject: "subject",
      description: undefined,
      entity: undefined,
      state: undefined,
      blockedBy: undefined,
      dueDate: undefined,
      projectName: undefined,
      topicName: "ship-it",
      tags: undefined,
      keywords: undefined,
      synopsis: undefined,
    })

    expect(tasksCreate).toHaveBeenCalledWith(
      expect.objectContaining({ topicId: undefined, projectIds: undefined })
    )
    expect(result.text).toContain('Warnings: Topic "ship-it" skipped')
    expect(result.text).toContain("Project: none (repo-wide)")
  })

  it("short-circuits to assertive reuse on an exact (subject, entity, projectIds) match", async () => {
    // Idempotency parity with `lore-task action='create'` (issue #265).
    // The duplicate probe via `findDuplicateActiveTasks` runs BEFORE
    // `services.tasks.create`; an exact match returns the existing
    // row with the `Reused existing task: ...` vocabulary and no
    // create call ever lands. Without this, an operator running
    // `lore tasks create "Track PR"` twice would land two
    // structurally-identical rows in the vault — the precise gap two
    // reviewers flagged on the prior commit.
    const findByName = vi
      .fn()
      .mockResolvedValue({ id: "p-widget", name: "Widget", path: "apps/widget" })
    const existing = makeTask({
      id: "t-existing",
      title: "Track PR-1234",
      taskState: "in-progress",
      reviewBy: "2026-05-10",
      entity: "PR-1234",
      projectIds: ["p-widget"],
    })
    const tasksCreate = vi.fn()
    const tasksList = vi.fn().mockResolvedValue({ items: [existing] })
    // Override the default `tasks.list` mock so the probe sees a
    // matching candidate. The other tasks.* methods stay defaulted via
    // `makeServices` so create / update / close paths still work in
    // sibling tests sharing this fixture style.
    const services = {
      ...makeServices({
        findByName,
        contextProject: null,
        tasksCreate,
      }),
      tasks: {
        list: tasksList,
        create: tasksCreate,
        update: vi.fn(),
        close: vi.fn(),
        getById: vi.fn(),
      },
    } as unknown as LoreServices

    const result = await runTaskCreate(services, {
      subject: "Track PR-1234",
      description: "ignored payload",
      entity: "PR-1234",
      state: "blocked",
      blockedBy: "ignored too",
      dueDate: "2026-05-15",
      projectName: "Widget",
      topicName: undefined,
      tags: ["frontend"],
      keywords: "ignored",
      synopsis: "ignored",
    })

    expect(tasksCreate).not.toHaveBeenCalled()
    expect(result.data.reused).toBe(true)
    expect(result.data.id).toBe("t-existing")
    expect(result.text).toContain('Reused existing task: "Track PR-1234" (t-existing)')
    expect(result.text).toContain(
      "Subject and entity match an existing active task; nothing was created."
    )
    expect(result.text).toContain(
      "Update the existing row if needed: lore tasks update t-existing ..."
    )
    expect(result.text).toContain(
      "Close it when the work is done: lore tasks close t-existing"
    )
    // The reuse audit names every caller-supplied non-key field that
    // was structurally dropped, so an operator who tried to bump state
    // / due-date / description in the same call learns the bumps did
    // not land.
    expect(result.text).toContain("Ignored on reuse:")
    expect(result.text).toContain("--description")
    expect(result.text).toContain("--state")
    expect(result.text).toContain("--blocked-by")
    expect(result.text).toContain("--due-date")
    expect(result.text).toContain("--tags")
    expect(result.text).toContain("--keywords")
    expect(result.text).toContain("--synopsis")
  })

  it("includes --topic in the reuse audit AND skips topics.getOrCreate when --topic is supplied alongside reuse", async () => {
    // Closes a real audit gap a reviewer flagged on the prior round:
    // the reuse short-circuit in `runTaskCreate` returns BEFORE
    // `topics.getOrCreate`, so a caller-supplied `--topic` has no
    // observable effect on the existing row's topic relation.
    // `lore tasks update` does not offer a `--topic` flag either, so
    // a silently-dropped topic with no audit signal would leave the
    // operator believing the topic landed when it didn't, with no
    // CLI path to apply it after the fact. The fix lists `--topic`
    // in `Ignored on reuse: ...` so the operator sees the gap and
    // can address it via `lore-memory action='update'` (or by
    // creating a fresh task explicitly under the new topic).
    const findByName = vi
      .fn()
      .mockResolvedValue({ id: "p-widget", name: "Widget", path: "apps/widget" })
    const existing = makeTask({
      id: "t-existing",
      title: "Track PR-1234",
      taskState: "open",
      entity: "PR-1234",
      projectIds: ["p-widget"],
    })
    const tasksCreate = vi.fn()
    const tasksList = vi.fn().mockResolvedValue({ items: [existing] })
    const topicsGetOrCreate = vi.fn()
    const services = {
      ...makeServices({
        findByName,
        contextProject: null,
        tasksCreate,
        topicsGetOrCreate,
      }),
      tasks: {
        list: tasksList,
        create: tasksCreate,
        update: vi.fn(),
        close: vi.fn(),
        getById: vi.fn(),
      },
      topics: { getOrCreate: topicsGetOrCreate },
    } as unknown as LoreServices

    const result = await runTaskCreate(services, {
      subject: "Track PR-1234",
      description: undefined,
      entity: "PR-1234",
      state: undefined,
      blockedBy: undefined,
      dueDate: undefined,
      projectName: "Widget",
      topicName: "Reviews",
      tags: undefined,
      keywords: undefined,
      synopsis: undefined,
    })

    expect(tasksCreate).not.toHaveBeenCalled()
    // Crucial: the reuse short-circuit must NOT call topics.getOrCreate.
    // A topic create here would leak an orphan Topic relation onto the
    // vault for an operation that did NOT touch the task's topic.
    expect(topicsGetOrCreate).not.toHaveBeenCalled()
    expect(result.data.reused).toBe(true)
    expect(result.data.ignoredOnReuse).toContain("--topic")
    expect(result.text).toContain("Ignored on reuse:")
    expect(result.text).toContain("--topic")
  })

  it("does NOT reuse when project sets diverge (set-equality, not overlap)", async () => {
    // Reuse keys on `(subject, entity, projectIds)` set-equality.
    // A `[A]` candidate must NOT match an `[A, B]` create — different
    // audit boundaries, different project owners. This pins the parity
    // with `MemoryService.upsertByTopicKey`'s set-equality contract.
    const findByName = vi
      .fn()
      .mockResolvedValue({ id: "p-other", name: "Other", path: "other" })
    const existing = makeTask({
      id: "t-other-scope",
      title: "subject",
      taskState: "open",
      entity: "subject",
      // Existing row scoped to `[p-widget]`; the create resolves to
      // `[p-other]`. Set-equality fails → no reuse.
      projectIds: ["p-widget"],
    })
    const tasksCreate = vi
      .fn()
      .mockResolvedValue(makeTask({ id: "t-fresh", title: "subject" }) as unknown as Task)
    const tasksList = vi.fn().mockResolvedValue({ items: [existing] })
    const services = {
      ...makeServices({ findByName, contextProject: null, tasksCreate }),
      tasks: {
        list: tasksList,
        create: tasksCreate,
        update: vi.fn(),
        close: vi.fn(),
        getById: vi.fn(),
      },
    } as unknown as LoreServices

    const result = await runTaskCreate(services, {
      subject: "subject",
      description: undefined,
      entity: undefined,
      state: undefined,
      blockedBy: undefined,
      dueDate: undefined,
      projectName: "Other",
      topicName: undefined,
      tags: undefined,
      keywords: undefined,
      synopsis: undefined,
    })

    expect(tasksCreate).toHaveBeenCalled()
    expect(result.data.reused).toBe(false)
    expect(result.data.id).toBe("t-fresh")
  })
})

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("parseUpdateCliOptions", () => {
  it("returns the parsed shape on a well-formed payload", () => {
    const result = parseUpdateCliOptions("task-id", {
      state: "in-progress",
      subject: "renamed",
      dueDate: "2026-06-01",
      tags: "frontend, ios",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.taskId).toBe("task-id")
      expect(result.value.state).toBe("in-progress")
      expect(result.value.subject).toBe("renamed")
      expect(result.value.dueDate).toBe("2026-06-01")
      expect(result.value.tags).toEqual(["frontend", "ios"])
    }
  })

  it("treats an empty --due-date as a clear sentinel (null)", () => {
    const result = parseUpdateCliOptions("task-id", { dueDate: "" })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.dueDate).toBeNull()
  })

  it("preserves an empty --blocked-by as a clear sentinel (forwards '' to TaskService)", () => {
    // MCP semantics: passing `blockedBy: ""` clears the column. The CLI
    // must preserve that — `parseUpdateCliOptions` keeps the empty
    // string verbatim (no fallback to undefined) so `services.tasks.update`
    // sees `{ blockedBy: "" }` and writes the cleared rich_text. The
    // cross-field guard above only fires when --state=blocked is the
    // requested transition; this test pins the no-state-blocked path.
    const result = parseUpdateCliOptions("task-id", { blockedBy: "" })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.blockedBy).toBe("")
  })

  it("rejects --state=blocked without --blocked-by, even on update", () => {
    const result = parseUpdateCliOptions("task-id", { state: "blocked" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("--blocked-by")
  })

  it.each(["   ", "\t", " \t \n "])(
    "rejects --state=blocked with whitespace-only --blocked-by %j on update",
    (blockedBy) => {
      // The update path's blocker guard previously rejected `undefined`
      // and `""` but accepted `"   "` because the empty-string check
      // missed whitespace-only inputs. MCP's `isUnusableBlockerLabel`
      // already trims; the CLI now matches. `--blocked-by ""` remains a
      // valid clear sentinel ONLY when the requested state is not
      // `blocked` — see the `preserves an empty --blocked-by as a clear
      // sentinel` test above for that path.
      const result = parseUpdateCliOptions("task-id", {
        state: "blocked",
        blockedBy,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.message).toContain("--blocked-by")
        expect(result.message).toContain("whitespace-only labels are rejected")
      }
    }
  )

  it("rejects an empty task id", () => {
    const result = parseUpdateCliOptions("   ", {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("<task-id>")
  })

  it("rejects --due-date when not empty and not YYYY-MM-DD", () => {
    const result = parseUpdateCliOptions("task-id", { dueDate: "next-week" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("--due-date")
  })
})

describe("runTaskUpdate", () => {
  it("forwards every supplied field to TaskService.update and renders the echo", async () => {
    const tasksUpdate = vi.fn().mockResolvedValue(
      makeTask({
        id: "t-upd",
        title: "renamed",
        taskState: "in-progress",
        reviewBy: "2026-06-01",
        blockedBy: "PR-9",
        entity: "auth-service",
      }) as unknown as Task
    )
    const services = makeServices({ contextProject: null, tasksUpdate })

    const result = await runTaskUpdate(services, {
      taskId: "t-upd",
      state: "in-progress",
      blockedBy: "PR-9",
      entity: "auth-service",
      dueDate: "2026-06-01",
      subject: "renamed",
      description: "new body",
      tags: ["frontend"],
      keywords: "kw",
      synopsis: "syn",
    })

    expect(tasksUpdate).toHaveBeenCalledWith("t-upd", {
      state: "in-progress",
      blockedBy: "PR-9",
      entity: "auth-service",
      dueDate: "2026-06-01",
      subject: "renamed",
      description: "new body",
      tags: ["frontend"],
      keywords: "kw",
      synopsis: "syn",
    })
    expect(result.text).toContain('Updated task: "renamed" (t-upd)')
    expect(result.text).toContain("State: in-progress")
    expect(result.text).toContain("Due: 2026-06-01")
    expect(result.text).toContain("Blocked by: PR-9")
    expect(result.text).toContain("Entity: auth-service")
    expect(result.data.id).toBe("t-upd")
    expect(result.data.state).toBe("in-progress")
  })
})

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

describe("parseCloseCliOptions", () => {
  it("defaults --state to 'done'", () => {
    const result = parseCloseCliOptions("task-id", {})
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.state).toBe("done")
  })

  it("accepts --state=cancelled", () => {
    const result = parseCloseCliOptions("task-id", { state: "cancelled" })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.state).toBe("cancelled")
  })

  it("rejects --state=in-progress (not a close state)", () => {
    const result = parseCloseCliOptions("task-id", { state: "in-progress" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("--state")
  })

  it("rejects an empty task id", () => {
    const result = parseCloseCliOptions("   ", {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("<task-id>")
  })
})

describe("runTaskClose", () => {
  it("calls TaskService.close, re-reads via getById, and echoes Done At", async () => {
    const tasksClose = vi.fn().mockResolvedValue(undefined)
    const tasksGetById = vi.fn().mockResolvedValue(
      makeTask({
        id: "t-close",
        title: "closed",
        taskState: "done",
        doneAt: "2026-05-03",
      }) as unknown as Task
    )
    const services = makeServices({
      contextProject: null,
      tasksClose,
      tasksGetById,
    })

    const result = await runTaskClose(services, {
      taskId: "t-close",
      state: "done",
    })

    expect(tasksClose).toHaveBeenCalledWith("t-close", "done")
    expect(tasksGetById).toHaveBeenCalledWith("t-close")
    expect(result.text).toContain("Closed task t-close (state: done)")
    expect(result.text).toContain("Done at: 2026-05-03")
    expect(result.data).toEqual({
      id: "t-close",
      state: "done",
      doneAt: "2026-05-03",
    })
  })

  it("succeeds when getById fails post-close (graceful degradation, no Done At line)", async () => {
    const tasksClose = vi.fn().mockResolvedValue(undefined)
    const tasksGetById = vi.fn().mockRejectedValue(new Error("Done At column missing"))
    const services = makeServices({
      contextProject: null,
      tasksClose,
      tasksGetById,
    })

    const result = await runTaskClose(services, {
      taskId: "t-close",
      state: "cancelled",
    })

    expect(tasksClose).toHaveBeenCalledWith("t-close", "cancelled")
    expect(result.text).toBe("Closed task t-close (state: cancelled)")
    expect(result.data).toEqual({
      id: "t-close",
      state: "cancelled",
      doneAt: null,
    })
  })
})

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("parseListCliOptions", () => {
  it("returns the parsed shape on a well-formed payload", () => {
    const result = parseListCliOptions({
      project: "Widget",
      entity: "PR-1234",
      state: "open",
      dueBefore: "2026-06-01",
      limit: "50",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({
        projectName: "Widget",
        entity: "PR-1234",
        state: "open",
        dueBefore: "2026-06-01",
        limit: 50,
      })
    }
  })

  it("rejects --due-before when not YYYY-MM-DD", () => {
    const result = parseListCliOptions({ dueBefore: "soon", limit: "20" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("--due-before")
  })

  it("rejects --limit above MAX_LIST_LIMIT (500)", () => {
    // The CLI cap (5 pages × 100 rows) is the hard ceiling beyond which
    // the cursor walker would saturate and silently truncate. Reject
    // at the parse boundary instead so an operator sees actionable
    // wording rather than a "100 tasks" total against a 5,000-row vault.
    const result = parseListCliOptions({ limit: "9999" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("between 1 and 500")
  })

  it("rejects an unknown --state", () => {
    const result = parseListCliOptions({ state: "frobnicating", limit: "20" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("--state")
  })
})

describe("runTaskList", () => {
  it("renders the empty-state form when the vault has no matching tasks", async () => {
    const services = makeServices({ contextProject: null, tasksItems: [] })
    const result = await runTaskList(services, {
      projectName: undefined,
      entity: undefined,
      state: undefined,
      dueBefore: undefined,
      limit: 20,
    })
    expect(result.text).toBe("No tasks found.")
    expect(result.data).toEqual({
      total: 0,
      saturated: false,
      saturationReason: null,
      maxFetched: 500,
      overdue: [],
      active: [],
      filter: {
        projectId: null,
        entity: null,
        state: null,
        dueBefore: null,
        limit: 20,
      },
    })
  })

  it("buckets overdue and active tasks and renders both sections", async () => {
    const overdueRow = makeTask({
      id: "t-late",
      title: "Track PR-1",
      taskState: "open",
      reviewBy: "2024-01-01",
    })
    const activeRow = makeTask({
      id: "t-now",
      title: "Track PR-2",
      taskState: "in-progress",
      reviewBy: undefined as unknown as TaskSummary["reviewBy"],
    })
    const services = makeServices({
      contextProject: null,
      tasksItems: [overdueRow, activeRow],
    })

    const result = await runTaskList(services, {
      projectName: undefined,
      entity: undefined,
      state: undefined,
      dueBefore: undefined,
      limit: 20,
    })

    expect(result.text).toContain("2 tasks (exact total):")
    expect(result.text).toContain("Overdue (1):")
    expect(result.text).toContain("Active (1):")
    expect(result.text).toContain("Track PR-1")
    expect(result.text).toContain("Track PR-2")
    expect(result.text).toContain("ID: t-late")
    expect(result.text).toContain("ID: t-now")
    expect(result.data.total).toBe(2)
    expect(result.data.overdue).toHaveLength(1)
    expect(result.data.active).toHaveLength(1)
  })

  it("titles the section by the requested closed state when filtering to done/cancelled", async () => {
    const doneRow = makeTask({
      id: "t-d",
      title: "Already done",
      taskState: "done",
    })
    const tasksList = vi.fn().mockResolvedValue({ items: [doneRow] })
    const services = {
      ...makeServices({ contextProject: null, tasksItems: [doneRow] }),
      tasks: { list: tasksList },
    } as unknown as LoreServices

    const result = await runTaskList(services, {
      projectName: undefined,
      entity: undefined,
      state: "done",
      dueBefore: undefined,
      limit: 20,
    })

    expect(tasksList).toHaveBeenCalledWith(expect.objectContaining({ states: ["done"] }))
    expect(result.text).toContain("Done (1):")
  })

  it("forwards --project, --entity, and --due-before to TaskService.list", async () => {
    const findByName = vi
      .fn()
      .mockResolvedValue({ id: "p-widget", name: "Widget", path: "apps/widget" })
    const tasksList = vi.fn().mockResolvedValue({ items: [] })
    const services = {
      ...makeServices({ findByName, contextProject: null }),
      tasks: { list: tasksList },
    } as unknown as LoreServices

    await runTaskList(services, {
      projectName: "Widget",
      entity: "PR-1234",
      state: undefined,
      dueBefore: "2026-06-01",
      limit: 25,
    })

    expect(tasksList).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p-widget",
        entities: ["PR-1234"],
        dueBefore: "2026-06-01",
        limit: 25,
      })
    )
  })

  it("cursor-walks across multiple pages until --limit is satisfied", async () => {
    // Cursor pagination is the parity fix for the silent-truncation
    // hole the previous commit had: a single `tasks.list` call clamps
    // at 100 inside the service, so `--limit 200` would silently
    // return 100 and label it `100 tasks (exact total)`. The walker
    // issues sequential page requests until the operator's --limit is
    // satisfied or no more cursors exist.
    const page1Rows = Array.from({ length: 100 }, (_, i) =>
      makeTask({ id: `t-p1-${i}`, title: `Task A${i}` })
    )
    const page2Rows = Array.from({ length: 50 }, (_, i) =>
      makeTask({ id: `t-p2-${i}`, title: `Task B${i}` })
    )
    const tasksList = vi
      .fn()
      .mockResolvedValueOnce({ items: page1Rows, nextCursor: "cursor-1" })
      .mockResolvedValueOnce({ items: page2Rows, nextCursor: undefined })
    const services = {
      ...makeServices({ contextProject: null }),
      tasks: { list: tasksList },
    } as unknown as LoreServices

    const result = await runTaskList(services, {
      projectName: undefined,
      entity: undefined,
      state: undefined,
      dueBefore: undefined,
      limit: 200,
    })

    // Two cursor requests: first asks for `min(200, 100) = 100` rows,
    // second asks for the residual `min(100, 100) = 100` and gets back
    // 50 with nextCursor undefined → loop exits with 150 rows.
    expect(tasksList).toHaveBeenCalledTimes(2)
    expect(tasksList).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 100 }))
    expect(tasksList).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ limit: 100, startCursor: "cursor-1" })
    )
    expect(result.data.total).toBe(150)
    expect(result.data.saturated).toBe(false)
    expect(result.text).toContain("150 tasks (exact total):")
  })

  it("keeps exact-limit results unsaturated when Notion reports no next cursor", async () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      makeTask({ id: `t-${i}`, title: `Task ${i}` })
    )
    const tasksList = vi.fn().mockResolvedValue({ items: rows, nextCursor: undefined })
    const services = {
      ...makeServices({ contextProject: null }),
      tasks: { list: tasksList },
    } as unknown as LoreServices

    const result = await runTaskList(services, {
      projectName: undefined,
      entity: undefined,
      state: undefined,
      dueBefore: undefined,
      limit: 20,
    })

    expect(tasksList).toHaveBeenCalledTimes(1)
    expect(result.data.total).toBe(20)
    expect(result.data.saturated).toBe(false)
    expect(result.data.saturationReason).toBeNull()
    expect(result.text).toContain("20 tasks (exact total):")
    expect(result.text).not.toContain("more matching tasks exist")
  })

  it("renders user-limit saturation footer when the walk stopped at --limit (raise --limit nudge)", async () => {
    // The user-limit case fires when the cursor walk stopped because
    // `tasks.length === --limit` while `nextCursor` was still set.
    // The walk never approached the safety cap, so the operator nudge
    // is "raise --limit" — NOT "narrow filters". The prior shape
    // conflated this with the safety-cap path and rendered "listing
    // capped at 500 fetched rows; narrow with ..." against a 50-task
    // vault on `lore tasks list -n 2`, which is misleading. Pin both
    // the new wording and the JSON `saturationReason` flag so a
    // future refactor can't silently regress to the conflated path.
    const rows = [
      makeTask({ id: "t-1", title: "Task 1", taskState: "open" }),
      makeTask({ id: "t-2", title: "Task 2", taskState: "open" }),
    ]
    const tasksList = vi
      .fn()
      .mockResolvedValue({ items: rows, nextCursor: "cursor-more" })
    const services = {
      ...makeServices({ contextProject: null }),
      tasks: { list: tasksList },
    } as unknown as LoreServices

    const result = await runTaskList(services, {
      projectName: undefined,
      entity: undefined,
      state: undefined,
      dueBefore: undefined,
      limit: 2,
    })

    expect(result.data.saturated).toBe(true)
    expect(result.data.saturationReason).toBe("user-limit")
    expect(result.data.total).toBe(2)
    expect(result.text).toContain("≥2 tasks (lower-bound total")
    expect(result.text).toContain("showed first 2 rows of more matching tasks")
    expect(result.text).toContain(
      "Showing first 2 matching tasks; more matching tasks exist."
    )
    expect(result.text).toContain("Raise --limit to see more")
    // Safety-cap wording must NOT appear on the user-limit path: that
    // wording would push the operator toward narrowing filters when
    // the walk budget was never the binding constraint.
    expect(result.text).not.toContain("listing capped at 500 fetched rows")
    expect(result.text).not.toContain("after the first 500 fetched rows")
  })

  it("prefers safety-cap wording when --limit == MAX_LIST_LIMIT and both terminal conditions fire simultaneously", async () => {
    // `--limit === MAX_LIST_LIMIT === 500` is the boundary where both
    // terminal conditions can fire on the same iteration: 5 full pages
    // × 100 rows = 500 fetched rows lands `tasks.length === --limit`
    // AND `pages === MAX_LIST_PAGES`. The classifier picks safety-cap
    // because at that boundary `--limit > 500` is rejected at parse
    // time — the "raise --limit" nudge would be unactionable advice
    // and the safety cap is the binding constraint. This test pins
    // that priority so a future refactor that flips the classifier
    // back to "user-limit wins on tie" leaves operators staring at
    // an instruction they can't follow.
    const fullPage = (offset: number): TaskSummary[] =>
      Array.from({ length: 100 }, (_, i) =>
        makeTask({ id: `t-${offset + i}`, title: `Task ${offset + i}` })
      )
    const tasksList = vi
      .fn()
      .mockResolvedValueOnce({ items: fullPage(0), nextCursor: "c1" })
      .mockResolvedValueOnce({ items: fullPage(100), nextCursor: "c2" })
      .mockResolvedValueOnce({ items: fullPage(200), nextCursor: "c3" })
      .mockResolvedValueOnce({ items: fullPage(300), nextCursor: "c4" })
      .mockResolvedValueOnce({ items: fullPage(400), nextCursor: "c5" })
    const services = {
      ...makeServices({ contextProject: null }),
      tasks: { list: tasksList },
    } as unknown as LoreServices

    const result = await runTaskList(services, {
      projectName: undefined,
      entity: undefined,
      state: undefined,
      dueBefore: undefined,
      limit: 500,
    })

    expect(tasksList).toHaveBeenCalledTimes(5)
    expect(result.data.total).toBe(500)
    expect(result.data.saturated).toBe(true)
    expect(result.data.saturationReason).toBe("safety-cap")
    expect(result.text).toContain("listing capped at 500 fetched rows")
    expect(result.text).toContain(
      "Narrow with --project, --entity, --state, or --due-before"
    )
    // The "raise --limit" nudge would be unactionable here (the parser
    // already capped `--limit` at MAX_LIST_LIMIT), so the user-limit
    // wording must NOT appear.
    expect(result.text).not.toContain("Raise --limit to see more")
    expect(result.text).not.toContain("showed first 500 rows of more matching")
  })

  it("renders safety-cap saturation footer when MAX_LIST_PAGES fires before --limit (narrow filters nudge)", async () => {
    // The safety-cap case fires when the walk hit `MAX_LIST_PAGES`
    // (5 pages) with `nextCursor` still set BEFORE satisfying
    // `--limit`. In production this happens when Notion under-fills
    // requested pages — i.e. the service returns fewer rows than
    // `pageSize` while still indicating more results via
    // `nextCursor`. Simulating that here with 50-row pages drives the
    // walker to hit `pages === MAX_LIST_PAGES` with `tasks.length`
    // (250) still well below `--limit` (500), which is the precise
    // structural condition the safety-cap branch exists to detect.
    // The operator asked for more rows than the walk budget; further
    // walking would be unbounded against a high-traffic vault, so the
    // right nudge is "narrow filters."
    const page = (offset: number): TaskSummary[] =>
      Array.from({ length: 50 }, (_, i) =>
        makeTask({ id: `t-${offset + i}`, title: `Task ${offset + i}` })
      )
    const tasksList = vi
      .fn()
      .mockResolvedValueOnce({ items: page(0), nextCursor: "c1" })
      .mockResolvedValueOnce({ items: page(50), nextCursor: "c2" })
      .mockResolvedValueOnce({ items: page(100), nextCursor: "c3" })
      .mockResolvedValueOnce({ items: page(150), nextCursor: "c4" })
      .mockResolvedValueOnce({ items: page(200), nextCursor: "c5" })
    const services = {
      ...makeServices({ contextProject: null }),
      tasks: { list: tasksList },
    } as unknown as LoreServices

    const result = await runTaskList(services, {
      projectName: undefined,
      entity: undefined,
      state: undefined,
      dueBefore: undefined,
      limit: 500,
    })

    expect(tasksList).toHaveBeenCalledTimes(5)
    expect(result.data.saturated).toBe(true)
    expect(result.data.saturationReason).toBe("safety-cap")
    expect(result.data.total).toBe(250)
    expect(result.text).toContain("≥250 tasks (lower-bound total")
    expect(result.text).toContain("listing capped at 500 fetched rows")
    expect(result.text).toContain(
      "More matching tasks exist after the first 500 fetched rows"
    )
    expect(result.text).toContain(
      "Narrow with --project, --entity, --state, or --due-before"
    )
    // User-limit wording must NOT appear on the safety-cap path.
    expect(result.text).not.toContain("Raise --limit to see more")
    expect(result.text).not.toContain("showed first 250 rows of more matching")
  })

  it("renders the empty-saturated form when the cap is hit before any matching row lands", async () => {
    // Edge case: pagination cap fires (`nextCursor` still set) but the
    // walker fetched zero matching rows. The empty-state message must
    // signal that more rows may exist beyond the cap rather than
    // claiming "no tasks found" outright.
    const tasksList = vi.fn().mockResolvedValue({ items: [], nextCursor: "cursor-more" })
    const services = {
      ...makeServices({ contextProject: null }),
      tasks: { list: tasksList },
    } as unknown as LoreServices

    const result = await runTaskList(services, {
      projectName: undefined,
      entity: undefined,
      state: undefined,
      dueBefore: undefined,
      limit: 50,
    })

    expect(result.text).toContain(
      "No tasks found in the first 500 fetched rows; more matching tasks may exist."
    )
    expect(result.data.saturated).toBe(true)
    expect(result.data.total).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Action-wrapper exit-path tests for create / update / close / list. Each
// command's `process.exit(1)` call sites (parse failure inside the try, plus
// the catch-all) get the same no-throw `trapProcessExit` coverage as the
// `reconcile` block above so a refactor that breaks the shell-script
// exit-code contract surfaces loudly.
// ---------------------------------------------------------------------------

describe("tasksCommand create/update/close/list actions", () => {
  let errorSpy: ReturnType<typeof vi.fn>
  let logSpy: ReturnType<typeof vi.fn>
  let exitTrap: ReturnType<typeof trapProcessExit>

  beforeEach(() => {
    vi.mocked(initServices).mockReset()
    exitTrap = trapProcessExit()
    errorSpy = vi.fn()
    logSpy = vi.fn()
    vi.spyOn(console, "error").mockImplementation(errorSpy)
    vi.spyOn(console, "log").mockImplementation(logSpy)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("create exits 1 once before initServices on bad --due-date", async () => {
    await tasksCommand.parseAsync(["create", "subject", "--due-date", "tomorrow"], {
      from: "user",
    })

    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Task create failed:")
    expect(errorText).toContain("--due-date")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
  })

  it("create exits 1 via the catch-all when initServices throws", async () => {
    vi.mocked(initServices).mockRejectedValue(new Error("notion 503: gateway"))

    await tasksCommand.parseAsync(["create", "subject"], { from: "user" })

    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Task create failed:")
    expect(errorText).toContain("notion 503: gateway")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it("create prints runTaskCreate output on the happy path", async () => {
    const tasksCreate = vi.fn().mockResolvedValue(
      makeTask({
        id: "t-new",
        title: "Track PR-1",
        taskState: "open",
      }) as unknown as Task
    )
    const services = makeServices({ contextProject: null, tasksCreate })
    vi.mocked(initServices).mockResolvedValue(services)

    await tasksCommand.parseAsync(["create", "Track PR-1"], { from: "user" })

    expect(vi.mocked(initServices)).toHaveBeenCalledTimes(1)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(exitTrap.exitCodes).toEqual([])
    expect(logSpy).toHaveBeenCalledTimes(1)
    const logged = logSpy.mock.calls[0]!.join("\n")
    expect(logged).toContain('Created task: "Track PR-1" (t-new)')
  })

  it("create validates --tags against the active profile vocabulary", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lore-tasks-profile-"))
    writeFileSync(
      join(cwd, ".lore.yaml"),
      "vault:\n  pageId: test-page\nprofile: support@1.0.0\n"
    )
    vi.spyOn(process, "cwd").mockReturnValue(cwd)
    const tasksCreate = vi.fn().mockResolvedValue(
      makeTask({
        id: "t-support",
        title: "Follow up on SUP-1024",
        taskState: "open",
      }) as unknown as Task
    )
    const services = makeServices({ contextProject: null, tasksCreate })
    vi.mocked(initServices).mockResolvedValue(services)

    try {
      await tasksCommand.parseAsync(
        ["create", "Follow up on SUP-1024", "--tags", "escalation"],
        { from: "user" }
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }

    expect(errorSpy).not.toHaveBeenCalled()
    expect(exitTrap.exitCodes).toEqual([])
    expect(tasksCreate).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ["escalation"] })
    )
  })

  it("create validates --tags through LORE_CONFIG_ROOT when it is set", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lore-tasks-cwd-profile-"))
    const configRoot = mkdtempSync(join(tmpdir(), "lore-tasks-root-profile-"))
    const priorRoot = process.env["LORE_CONFIG_ROOT"]
    writeFileSync(
      join(cwd, ".lore.yaml"),
      "vault:\n  pageId: cwd-page\nprofile: default@1.0.0\n"
    )
    writeFileSync(
      join(configRoot, ".lore.yaml"),
      "vault:\n  pageId: root-page\nprofile: support@1.0.0\n"
    )
    process.env["LORE_CONFIG_ROOT"] = configRoot
    vi.spyOn(process, "cwd").mockReturnValue(cwd)
    const tasksCreate = vi.fn().mockResolvedValue(
      makeTask({
        id: "t-support-root",
        title: "Follow up on SUP-1024",
        taskState: "open",
      }) as unknown as Task
    )
    const services = makeServices({ contextProject: null, tasksCreate })
    vi.mocked(initServices).mockResolvedValue(services)

    try {
      await tasksCommand.parseAsync(
        ["create", "Follow up on SUP-1024", "--tags", "escalation"],
        { from: "user" }
      )
    } finally {
      if (priorRoot === undefined) delete process.env["LORE_CONFIG_ROOT"]
      else process.env["LORE_CONFIG_ROOT"] = priorRoot
      rmSync(cwd, { recursive: true, force: true })
      rmSync(configRoot, { recursive: true, force: true })
    }

    expect(errorSpy).not.toHaveBeenCalled()
    expect(exitTrap.exitCodes).toEqual([])
    expect(tasksCreate).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ["escalation"] })
    )
  })

  it("create validates --tags against an installed external profile", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lore-tasks-external-profile-"))
    const profileDir = join(cwd, ".lore", "profiles", "installed", "phase-three", "1.0.0")
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(
      join(cwd, ".lore.yaml"),
      "vault:\n  pageId: test-page\nprofile: phase-three@1.0.0\n"
    )
    writeFileSync(
      join(profileDir, "profile.yaml"),
      "name: phase-three\nversion: 1.0.0\ntaxonomy: taxonomy.yaml\nschema: schema.yaml\n"
    )
    writeFileSync(
      join(profileDir, "taxonomy.yaml"),
      "tags:\n  - phase-three\nentityKinds:\n  - validation-artifact\nwritableFactPredicates:\n  - validates\n"
    )
    writeFileSync(
      join(profileDir, "schema.yaml"),
      "databases:\n  projects:\n    properties: {}\n  topics:\n    properties: {}\n  memories:\n    properties: {}\n  entities:\n    properties: {}\n  facts:\n    properties: {}\n"
    )
    vi.spyOn(process, "cwd").mockReturnValue(cwd)
    const tasksCreate = vi.fn().mockResolvedValue(
      makeTask({
        id: "t-external",
        title: "Validate profile distribution",
        taskState: "open",
      }) as unknown as Task
    )
    const services = makeServices({ contextProject: null, tasksCreate })
    vi.mocked(initServices).mockResolvedValue(services)

    try {
      await tasksCommand.parseAsync(
        ["create", "Validate profile distribution", "--tags", "phase-three"],
        { from: "user" }
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }

    expect(errorSpy).not.toHaveBeenCalled()
    expect(exitTrap.exitCodes).toEqual([])
    expect(tasksCreate).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ["phase-three"] })
    )
  })

  it("update exits 1 once before initServices on --state=blocked without --blocked-by", async () => {
    await tasksCommand.parseAsync(["update", "task-id", "--state", "blocked"], {
      from: "user",
    })

    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Task update failed:")
    expect(errorText).toContain("--blocked-by")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
  })

  it("update prints runTaskUpdate output on the happy path", async () => {
    const tasksUpdate = vi.fn().mockResolvedValue(
      makeTask({
        id: "t-upd",
        title: "renamed",
        taskState: "in-progress",
      }) as unknown as Task
    )
    const services = makeServices({ contextProject: null, tasksUpdate })
    vi.mocked(initServices).mockResolvedValue(services)

    await tasksCommand.parseAsync(["update", "t-upd", "--subject", "renamed"], {
      from: "user",
    })

    expect(vi.mocked(initServices)).toHaveBeenCalledTimes(1)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(exitTrap.exitCodes).toEqual([])
    const logged = logSpy.mock.calls[0]!.join("\n")
    expect(logged).toContain('Updated task: "renamed" (t-upd)')
  })

  it("close exits 1 once before initServices on bad --state", async () => {
    await tasksCommand.parseAsync(["close", "task-id", "--state", "in-progress"], {
      from: "user",
    })

    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Task close failed:")
    expect(errorText).toContain("--state")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
  })

  it("close prints runTaskClose output on the happy path", async () => {
    const tasksClose = vi.fn().mockResolvedValue(undefined)
    const tasksGetById = vi.fn().mockResolvedValue(
      makeTask({
        id: "t-close",
        title: "closed",
        taskState: "done",
        doneAt: "2026-05-03",
      }) as unknown as Task
    )
    const services = makeServices({
      contextProject: null,
      tasksClose,
      tasksGetById,
    })
    vi.mocked(initServices).mockResolvedValue(services)

    await tasksCommand.parseAsync(["close", "t-close"], { from: "user" })

    expect(vi.mocked(initServices)).toHaveBeenCalledTimes(1)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(exitTrap.exitCodes).toEqual([])
    const logged = logSpy.mock.calls[0]!.join("\n")
    expect(logged).toContain("Closed task t-close (state: done)")
    expect(logged).toContain("Done at: 2026-05-03")
  })

  it.each(INVALID_LIMIT_STRINGS)(
    "list exits 1 once before initServices on invalid --limit %j",
    async (raw) => {
      await tasksCommand.parseAsync(["list", "--limit", raw], { from: "user" })

      const errorText = errorSpy.mock.calls.flat().join("\n")
      expect(errorText).toContain("Task list failed:")
      expect(errorText).toContain("--limit")
      expect(exitTrap.exitCodes).toEqual([1])
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(vi.mocked(initServices)).not.toHaveBeenCalled()
    }
  )

  it("list exits 1 once before initServices on --limit 9999 (over-cap)", async () => {
    await tasksCommand.parseAsync(["list", "--limit", "9999"], { from: "user" })

    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Task list failed:")
    expect(errorText).toContain("--limit must be between 1 and 500")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
  })

  it("list prints runTaskList output on the happy path", async () => {
    const services = makeServices({ contextProject: null, tasksItems: [] })
    vi.mocked(initServices).mockResolvedValue(services)

    await tasksCommand.parseAsync(["list"], { from: "user" })

    expect(vi.mocked(initServices)).toHaveBeenCalledTimes(1)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(exitTrap.exitCodes).toEqual([])
    expect(logSpy).toHaveBeenCalledWith("No tasks found.")
  })

  it("create --json prints the structured create result instead of human text", async () => {
    // `--json` path parity with `lore conflicts scan --json` and
    // `lore eval run --json`. Programmatic shell consumers read the
    // structured object (`ID=$(lore tasks create … --json | jq -r .id)`)
    // and never have to parse the leading-line prefix.
    const tasksCreate = vi.fn().mockResolvedValue(
      makeTask({
        id: "t-new",
        title: "Track PR-1",
        taskState: "open",
        entity: "PR-1",
      }) as unknown as Task
    )
    const services = makeServices({ contextProject: null, tasksCreate })
    vi.mocked(initServices).mockResolvedValue(services)

    await tasksCommand.parseAsync(["create", "Track PR-1", "--json"], {
      from: "user",
    })

    expect(errorSpy).not.toHaveBeenCalled()
    const logged = logSpy.mock.calls[0]!.join("\n")
    const parsed = JSON.parse(logged) as { reused: boolean; id: string; state: string }
    expect(parsed.reused).toBe(false)
    expect(parsed.id).toBe("t-new")
    expect(parsed.state).toBe("open")
  })

  it("list --json prints the structured list result with the saturation flag", async () => {
    const tasksList = vi.fn().mockResolvedValue({ items: [], nextCursor: undefined })
    const services = {
      ...makeServices({ contextProject: null }),
      tasks: { list: tasksList },
    } as unknown as LoreServices
    vi.mocked(initServices).mockResolvedValue(services)

    await tasksCommand.parseAsync(["list", "--json"], { from: "user" })

    expect(errorSpy).not.toHaveBeenCalled()
    const logged = logSpy.mock.calls[0]!.join("\n")
    const parsed = JSON.parse(logged) as {
      total: number
      saturated: boolean
      overdue: unknown[]
      active: unknown[]
    }
    expect(parsed.total).toBe(0)
    expect(parsed.saturated).toBe(false)
    expect(parsed.overdue).toEqual([])
    expect(parsed.active).toEqual([])
  })

  it("close --json prints the structured close result", async () => {
    const tasksClose = vi.fn().mockResolvedValue(undefined)
    const tasksGetById = vi.fn().mockResolvedValue(
      makeTask({
        id: "t-close",
        title: "closed",
        taskState: "done",
        doneAt: "2026-05-03",
      }) as unknown as Task
    )
    const services = makeServices({
      contextProject: null,
      tasksClose,
      tasksGetById,
    })
    vi.mocked(initServices).mockResolvedValue(services)

    await tasksCommand.parseAsync(["close", "t-close", "--json"], { from: "user" })

    const logged = logSpy.mock.calls[0]!.join("\n")
    const parsed = JSON.parse(logged) as {
      id: string
      state: string
      doneAt: string | null
    }
    expect(parsed).toEqual({
      id: "t-close",
      state: "done",
      doneAt: "2026-05-03",
    })
  })

  it("create exits 1 once before initServices on out-of-vocab --tags", async () => {
    // Tag validation parity: an out-of-vocab `--tags` value must fail
    // at the parse boundary the same way MCP `tagsSchema` rejects, NOT
    // reach `services.tasks.create` and surface as a generic Notion
    // 400 mid-flight. Pinning the error prefix is the shell-grep
    // contract programmatic consumers rely on.
    await tasksCommand.parseAsync(["create", "subject", "--tags", "pr-1234"], {
      from: "user",
    })

    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Task create failed:")
    expect(errorText).toContain("--tags")
    expect(errorText).toContain("--keywords")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
  })

  it("update exits 1 once before initServices on out-of-vocab --tags", async () => {
    await tasksCommand.parseAsync(["update", "task-id", "--tags", "pr-1234"], {
      from: "user",
    })

    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Task update failed:")
    expect(errorText).toContain("--tags")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
  })

  it("create exits 1 once before initServices on --state=blocked --blocked-by '   '", async () => {
    // The action-level mirror of the parser-level whitespace-blocker
    // tests: `lore tasks create "T" --state blocked --blocked-by "   "`
    // must fail with the structured `Task create failed:` prefix and
    // must NOT reach `services.tasks.create`. Without this Commander
    // coverage, a future refactor that lifted the cross-field guard
    // out of the parser would let an unactionable blocked row land
    // and every helper-level test would still pass.
    await tasksCommand.parseAsync(
      ["create", "T", "--state", "blocked", "--blocked-by", "   "],
      { from: "user" }
    )

    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Task create failed:")
    expect(errorText).toContain("--blocked-by")
    expect(errorText).toContain("whitespace-only labels are rejected")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
  })

  it("update exits 1 once before initServices on --state=blocked --blocked-by '   '", async () => {
    await tasksCommand.parseAsync(
      ["update", "task-id", "--state", "blocked", "--blocked-by", "   "],
      { from: "user" }
    )

    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Task update failed:")
    expect(errorText).toContain("--blocked-by")
    expect(errorText).toContain("whitespace-only labels are rejected")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
  })

  it("update --blocked-by '' clears the blocker via TaskService.update", async () => {
    // MCP's `lore-task action='update'` accepts `blockedBy: ""` as the
    // explicit clear sentinel for the `Blocked By` rich_text column.
    // The CLI must preserve that — passing the empty string verbatim
    // through the parser to TaskService.update so the column actually
    // clears, instead of being treated as "leave untouched."
    const tasksUpdate = vi.fn().mockResolvedValue(
      makeTask({
        id: "t-u",
        title: "subject",
        taskState: "open",
        blockedBy: "",
      }) as unknown as Task
    )
    const services = makeServices({ contextProject: null, tasksUpdate })
    vi.mocked(initServices).mockResolvedValue(services)

    await tasksCommand.parseAsync(["update", "t-u", "--blocked-by", ""], {
      from: "user",
    })

    expect(tasksUpdate).toHaveBeenCalledWith(
      "t-u",
      expect.objectContaining({ blockedBy: "" })
    )
    expect(errorSpy).not.toHaveBeenCalled()
    expect(exitTrap.exitCodes).toEqual([])
  })
})
