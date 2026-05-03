import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { registerTaskTools } from "./tasks.js"
import { TaskUpdatePartialFailureError } from "../../core/task.js"
import type { Task, TaskSummary } from "../../types.js"

function makeTask(id: string, overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id,
    title: `Task ${id}`,
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
    createdAt: "2026-04-20T00:00:00Z",
    updatedAt: "2026-04-20T00:00:00Z",
    taskState: "open",
    blockedBy: "",
    // Distinct sentinel so tests asserting on the entity field can't
    // be fooled by a default that mirrors the title — callers who care
    // about a specific entity must override explicitly.
    entity: "test-entity",
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
    ...overrides,
  }
}

function createMockServer() {
  const handlers = new Map<string, (...args: never[]) => Promise<unknown>>()
  const configs = new Map<string, { inputSchema?: Record<string, z.ZodTypeAny> }>()
  const server = {
    registerTool: vi.fn(
      (
        name: string,
        config: { inputSchema?: Record<string, z.ZodTypeAny> },
        handler: (...args: never[]) => Promise<unknown>
      ) => {
        handlers.set(name, handler)
        configs.set(name, config)
      }
    ),
  } as unknown as McpServer
  return {
    server,
    getHandler: (name: string) => {
      const handler = handlers.get(name)
      if (!handler) throw new Error(`No handler registered for ${name}`)
      return handler
    },
    /**
     * Materialise the registered Zod object schema for a tool. Used to
     * exercise input validation directly — `McpServer.registerTool`
     * applies the schema in production, but the mock above stores the
     * shape verbatim so tests have to compose it themselves.
     */
    getInputSchema: (name: string) => {
      const config = configs.get(name)
      if (!config?.inputSchema) {
        throw new Error(`No input schema registered for ${name}`)
      }
      return z.object(config.inputSchema)
    },
  }
}

function services(overrides: Record<string, unknown> = {}) {
  return {
    projects: { findByName: vi.fn().mockResolvedValue(null) },
    topics: { getOrCreate: vi.fn() },
    tasks: {
      create: vi.fn(),
      update: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue({ items: [] }),
      // Default `getById` resolves to a doneAt-less task so close-path
      // tests that don't override it see no Done At echo line.
      getById: vi.fn().mockResolvedValue(makeTask("t1", { doneAt: null })),
    },
    sessionMemories: { record: vi.fn() },
    identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    context: { project: null },
    ...overrides,
  }
}

describe("lore-task-create", () => {
  it("rejects an unresolved explicit projectName before creating a task", async () => {
    const svc = services({
      context: {
        project: { id: "proj-ambient", name: "Ambient", path: "." },
        isCatchAllFallback: false,
      },
    })
    svc.projects.findByName = vi.fn().mockResolvedValue(null)
    svc.tasks.create = vi.fn()
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({
      action: "create",
      subject: "Rotate keys",
      projectName: "Missing",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(text).toContain('Project "Missing" could not be resolved')
    expect(text).toContain("Fix the project scope")
    expect(svc.topics.getOrCreate).not.toHaveBeenCalled()
    expect(svc.tasks.create).not.toHaveBeenCalled()
  })

  it("threads subject, description, and entity-default through to TaskService", async () => {
    const created: Task = {
      ...makeTask("t1", { entity: "AuthService" }),
      content: "",
    } as Task
    const svc = services()
    svc.tasks.create = vi.fn().mockResolvedValue(created)
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({
      action: "create",
      subject: "Rotate keys",
      description: "Long description prose",
    } as never)

    expect(svc.tasks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Rotate keys",
        description: "Long description prose",
      })
    )
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("Created task")
    expect(text).toContain("State: open")
  })

  it("warns when topicName is skipped because no project scope resolved", async () => {
    const created: Task = {
      ...makeTask("t-unscoped", { title: "unscoped topic skip" }),
      content: "",
    } as Task
    const getOrCreate = vi.fn()
    const svc = services({ topics: { getOrCreate } })
    svc.tasks.create = vi.fn().mockResolvedValue(created)
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({
      action: "create",
      subject: "unscoped topic skip",
      topicName: "Eval & Testing",
    } as never)

    expect(svc.tasks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectIds: undefined,
        topicId: undefined,
      })
    )
    expect(getOrCreate).not.toHaveBeenCalled()

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("Topic: none")
    expect(text).toContain(
      'Warnings: Topic "Eval & Testing" skipped (requires at least one project)'
    )
  })
})

describe("lore-task-create duplicate-task probe (#10)", () => {
  it("appends a duplicates footer when the probe surfaces other active tasks on the same entity", async () => {
    const created: Task = {
      ...makeTask("t-new", { entity: "PR-25750" }),
      content: "",
    } as Task
    const svc = services()
    svc.tasks.create = vi.fn().mockResolvedValue(created)
    // The probe rides the same `services.tasks.list` surface — return
    // two existing rows so the footer renders, including the just-
    // created row to verify the post-fetch `t.id !== task.id` filter.
    svc.tasks.list = vi.fn().mockResolvedValue({
      items: [
        makeTask("t-existing-1", {
          title: "Track PR-25750 review",
          entity: "PR-25750",
          taskState: "in-progress",
        }),
        makeTask("t-existing-2", {
          title: "PR-25750 follow-up",
          entity: "PR-25750",
          taskState: "open",
        }),
        // The probe's view of the just-created row (eventual-
        // consistency simulation). Must be filtered out by the
        // caller's post-fetch `t.id !== task.id` filter.
        makeTask("t-new", { title: "New PR-25750 task", entity: "PR-25750" }),
      ],
    })
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({
      action: "create",
      subject: "New PR-25750 task",
      entity: "PR-25750",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain('Other active tasks tracking "PR-25750" (2)')
    expect(text).toContain('"Track PR-25750 review" [in-progress]')
    expect(text).toContain('"PR-25750 follow-up" [open]')
    expect(text).toContain("lore-task({ action: 'close', taskId: 't-existing-1' })")
    // Just-created row stays out of the duplicate-list — caller-side
    // filter is the SOLE exclusion mechanism. Scope the negative
    // assertion to the bulleted duplicate lines (`  - "..." [...] — ...`)
    // since the post-#09 closure CTA legitimately references `task.id`
    // on its own line and would otherwise trip a naive substring check.
    const duplicateListLines = text.split("\n").filter((l) => l.startsWith("  - "))
    expect(duplicateListLines).toHaveLength(2)
    for (const line of duplicateListLines) {
      expect(line).not.toContain("t-new")
      expect(line).not.toContain('"New PR-25750 task"')
    }
  })

  it("omits the duplicates footer when no other active tasks share the entity", async () => {
    const created: Task = {
      ...makeTask("t1", { entity: "AuthService" }),
      content: "",
    } as Task
    const svc = services()
    svc.tasks.create = vi.fn().mockResolvedValue(created)
    svc.tasks.list = vi.fn().mockResolvedValue({ items: [] })
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({
      action: "create",
      subject: "Rotate keys",
      entity: "AuthService",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("Created task")
    expect(text).not.toContain("Other active tasks")
  })

  it("succeeds silently when the probe rejects, while logging via debugLogPartialFailures", async () => {
    // Three-way contract: (a) the probe's list call rejects, (b)
    // `debugLogPartialFailures` fires with `root=duplicate-probe` and
    // the upstream error message, (c) the create still succeeds and
    // the agent-visible response carries no probe-failure text.
    // LORE_DEBUG=1 unlocks the stderr write inside
    // `debugLogPartialFailures`; without the env flag the helper
    // returns silently and the spy capture would be empty even when
    // the wire is correct.
    const created: Task = {
      ...makeTask("t1", { entity: "PR-25750" }),
      content: "",
    } as Task
    const svc = services()
    svc.tasks.create = vi.fn().mockResolvedValue(created)
    const listError = new Error("notion 503")
    svc.tasks.list = vi.fn().mockRejectedValue(listError)
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    vi.stubEnv("LORE_DEBUG", "1")
    try {
      const handler = mockServer.getHandler("lore-task")
      const result = await handler({
        action: "create",
        subject: "Track PR-25750",
        entity: "PR-25750",
      } as never)
      const text = (result as { content: Array<{ text: string }> }).content[0].text

      // (a) the probe's underlying list call did reject.
      expect(svc.tasks.list).toHaveBeenCalledTimes(1)
      await expect(svc.tasks.list.mock.results[0].value).rejects.toBe(listError)

      // (b) debugLogPartialFailures fired with the expected shape.
      const partialFailureLines = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("[lore] partial-failure:"))
      expect(partialFailureLines).toHaveLength(1)
      expect(partialFailureLines[0]).toContain("tool=lore-task")
      expect(partialFailureLines[0]).toContain("root=duplicate-probe")
      expect(partialFailureLines[0]).toContain("error=notion 503")

      // (c) the create still surfaced cleanly to the agent.
      expect((result as { isError?: boolean }).isError).toBeUndefined()
      expect(text).toContain("Created task")
      expect(text).not.toContain("Other active tasks")
      expect(text).not.toContain("Error")
    } finally {
      vi.unstubAllEnvs()
      stderrSpy.mockRestore()
    }
  })

  it("pins the duplicates footer as the trailing block (issue 0.7.0/10 coordination)", async () => {
    // This pin ensures #09's closure CTA, when it lands, is appended
    // after the duplicates footer per spec coordination — see issue
    // 0.7.0/10. The footer must be the trailing block on this branch
    // so that #09's late-merger has a concrete signal: a `lines.push`
    // appended below the footer leaves this assertion green; a push
    // above the footer (CTA-first ordering, wrong per spec) trips it.
    const created: Task = {
      ...makeTask("t-new", { entity: "PR-25750" }),
      content: "",
    } as Task
    const svc = services()
    svc.tasks.create = vi.fn().mockResolvedValue(created)
    svc.tasks.list = vi.fn().mockResolvedValue({
      items: [
        makeTask("t-existing", {
          title: "Track PR-25750",
          entity: "PR-25750",
          taskState: "open",
        }),
      ],
    })
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({
      action: "create",
      subject: "New PR-25750 task",
      entity: "PR-25750",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    const lines = text.split("\n")

    // Structural pin #1: the duplicates header must come AFTER every
    // pre-existing structural line (Created, State, Project, Topic).
    const headerIdx = lines.findIndex((l) =>
      l.startsWith('Other active tasks tracking "PR-25750"')
    )
    expect(headerIdx).toBeGreaterThan(-1)
    expect(lines.slice(0, headerIdx).join("\n")).toContain("Created task")
    expect(lines.slice(0, headerIdx).join("\n")).toContain("State:")
    expect(lines.slice(0, headerIdx).join("\n")).toContain("Project:")
    expect(lines.slice(0, headerIdx).join("\n")).toContain("Topic:")

    // Structural pin #2 (the load-bearing handshake against #09):
    // every `lore-task({ action: 'close', ... })` incantation in the
    // response must appear at or after the duplicates header. The
    // duplicate rows themselves are close incantations — those satisfy
    // the rule trivially. The pin's value is forward-looking: when #09
    // lands a closure CTA (also a `lore-task({ action: 'close' })`
    // incantation, but referencing the just-created task's id), the
    // late-merger has two options. (a) Insert the CTA at the bottom of
    // `lines` — the CTA's index is >= headerIdx, this assertion still
    // passes, and the spec ordering is satisfied. (b) Insert the CTA
    // above the duplicates block — the CTA's index drops below
    // headerIdx, this assertion FAILS LOUD, and the failure message
    // plus the inline comment in `tasks.ts:215` point straight at the
    // spec rule. Wrong ordering cannot ship green.
    const closeIncantationIdxs = lines
      .map((l, i) => (l.includes("lore-task({ action: 'close',") ? i : -1))
      .filter((i) => i >= 0)
    expect(closeIncantationIdxs.length).toBeGreaterThan(0)
    for (const idx of closeIncantationIdxs) {
      expect(idx).toBeGreaterThanOrEqual(headerIdx)
    }
  })

  it("fires the probe in parallel with the create (Promise.all posture)", async () => {
    // Pin the parallel posture: if a future refactor accidentally
    // sequenced create→probe (or worse, gated probe behind create
    // success), the create's wall-clock would regress. We can't
    // measure wall-clock in a unit test, but we can pin that the
    // probe was invoked even when the create's promise has not yet
    // resolved by the time the probe is dispatched.
    let createResolve!: (task: Task) => void
    const createPromise = new Promise<Task>((resolve) => {
      createResolve = resolve
    })
    const svc = services()
    svc.tasks.create = vi.fn().mockReturnValue(createPromise)
    svc.tasks.list = vi.fn().mockResolvedValue({ items: [] })
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const handlerPromise = handler({
      action: "create",
      subject: "Track PR-25750",
      entity: "PR-25750",
    } as never)

    // Yield the microtask queue so the parallel `Promise.all` can
    // dispatch both branches before we assert.
    await Promise.resolve()
    await Promise.resolve()

    expect(svc.tasks.list).toHaveBeenCalledTimes(1)

    createResolve({
      ...makeTask("t1", { entity: "PR-25750" }),
      content: "",
    } as Task)
    await handlerPromise
  })

  it("falls back to subject when entity is omitted (probe scopes to the same default the row uses)", async () => {
    const created: Task = {
      ...makeTask("t1", { entity: "AuthService" }),
      content: "",
    } as Task
    const svc = services()
    svc.tasks.create = vi.fn().mockResolvedValue(created)
    svc.tasks.list = vi.fn().mockResolvedValue({ items: [] })
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    await handler({ action: "create", subject: "AuthService" } as never)

    // The row's `Entity` defaults to subject when entity is omitted
    // (`TaskService.create`); the probe must use the same default so
    // a future create on the same subject collides with this row.
    expect(svc.tasks.list).toHaveBeenCalledWith(
      expect.objectContaining({ entities: ["AuthService"] })
    )
  })
})

describe("lore-task-create blocked-state guard", () => {
  it("rejects state: 'blocked' when blockedBy is omitted — unactionable rows can't land", async () => {
    const svc = services()
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)
    const handler = mockServer.getHandler("lore-task")

    const result = await handler({
      action: "create",
      subject: "Ship release",
      state: "blocked",
    } as never)

    expect(svc.tasks.create).not.toHaveBeenCalled()
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("Error")
    expect(text).toContain("blockedBy")
  })

  it("accepts state: 'blocked' when blockedBy is provided", async () => {
    const created = {
      ...makeTask("t1", { taskState: "blocked", blockedBy: "PR review" }),
      content: "",
    } as Task
    const svc = services()
    svc.tasks.create = vi.fn().mockResolvedValue(created)
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)
    const handler = mockServer.getHandler("lore-task")

    await handler({
      action: "create",
      subject: "Ship release",
      state: "blocked",
      blockedBy: "PR review",
    } as never)

    expect(svc.tasks.create).toHaveBeenCalledWith(
      expect.objectContaining({ state: "blocked", blockedBy: "PR review" })
    )
  })
})

describe("lore-task-update blocked-state guard", () => {
  it("rejects state: 'blocked' when blockedBy is omitted on the same call", async () => {
    const svc = services()
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)
    const handler = mockServer.getHandler("lore-task")

    const result = await handler({
      action: "update",
      taskId: "task-id",
      state: "blocked",
    } as never)

    expect(svc.tasks.update).not.toHaveBeenCalled()
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("Error")
    expect(text).toContain("blockedBy")
  })

  it("rejects state: 'blocked' with explicit empty blockedBy (clearing the column on transition)", async () => {
    const svc = services()
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)
    const handler = mockServer.getHandler("lore-task")

    const result = await handler({
      action: "update",
      taskId: "task-id",
      state: "blocked",
      blockedBy: "",
    } as never)

    // Empty string with `state: "blocked"` is rejected — restating
    // is required, and an empty restate is unactionable.
    expect(svc.tasks.update).not.toHaveBeenCalled()
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("Error")
  })

  it("allows state transitions away from 'blocked' without requiring blockedBy", async () => {
    const svc = services()
    svc.tasks.update = vi.fn().mockResolvedValue({
      ...makeTask("t1", { taskState: "in-progress" }),
      content: "",
    })
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)
    const handler = mockServer.getHandler("lore-task")

    await handler({
      action: "update",
      taskId: "task-id",
      state: "in-progress",
    } as never)

    expect(svc.tasks.update).toHaveBeenCalledWith(
      "task-id",
      expect.objectContaining({ state: "in-progress" })
    )
  })
})

describe("lore-task-close", () => {
  it("calls TaskService.close with default state=done", async () => {
    const svc = services()
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    await handler({ action: "close", taskId: "task-id" } as never)

    expect(svc.tasks.close).toHaveBeenCalledWith("task-id", "done")
  })

  it("supports state=cancelled for dropped-without-completion path", async () => {
    const svc = services()
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    await handler({ action: "close", taskId: "task-id", state: "cancelled" } as never)

    expect(svc.tasks.close).toHaveBeenCalledWith("task-id", "cancelled")
  })
})

describe("lore-task-update", () => {
  it("translates empty dueDate string into null (clear the date)", async () => {
    const svc = services()
    svc.tasks.update = vi.fn().mockResolvedValue({
      ...makeTask("t1"),
      content: "",
    })
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    await handler({ action: "update", taskId: "task-id", dueDate: "" } as never)

    expect(svc.tasks.update).toHaveBeenCalledWith(
      "task-id",
      expect.objectContaining({ dueDate: null })
    )
  })

  it("threads dueDate: null through to TaskService.update as an explicit clear", async () => {
    const svc = services()
    svc.tasks.update = vi.fn().mockResolvedValue({
      ...makeTask("t1"),
      content: "",
    })
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    await handler({ action: "update", taskId: "task-id", dueDate: null } as never)

    expect(svc.tasks.update).toHaveBeenCalledWith(
      "task-id",
      expect.objectContaining({ dueDate: null })
    )
  })

  it("surfaces structured task update partial-failure messages as MCP errors", async () => {
    const bodyWriteError = new Error("notion 503")
    const svc = services()
    svc.tasks.update = vi
      .fn()
      .mockRejectedValue(
        new TaskUpdatePartialFailureError(
          `Task update partial failure: properties for task task-id persisted, ` +
            `but the description write failed during phase "body": notion 503. ` +
            `The property changes are already on Notion; the description body ` +
            `was not written. Inspect the row before retrying the update.`,
          { taskId: "task-id", bodyWriteError }
        )
      )
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = (await handler({
      action: "update",
      taskId: "task-id",
      state: "in-progress",
      description: "Updated description",
    } as never)) as { isError?: boolean; content: Array<{ text: string }> }

    const text = result.content[0].text
    expect(result.isError).toBe(true)
    expect(text).toContain("Error: TaskUpdatePartialFailureError")
    expect(text).toContain("Task update partial failure")
    expect(text).toContain("properties for task task-id persisted")
    expect(text).toContain('phase "body"')
    expect(text).toContain("description body was not written")
  })
})

/**
 * Issue 0.7.0/09 — closure CTA + description tightening.
 *
 * The CTA is the agent-facing nudge that the work-context-freshest
 * agent (the one who just opened or mutated the task) should close it
 * when the work completes. Pin presence on create + active-state
 * update; pin absence on close (self-referential) and on terminal-state
 * updates (close-shaped operation, repeating the rule is noise).
 */
describe("closure CTA (issue 0.7.0/09)", () => {
  const CTA_PREFIX = "Close this task when the work is done:"

  it("renders the closure CTA on create", async () => {
    const created: Task = {
      ...makeTask("t-new"),
      content: "",
    } as Task
    const svc = services()
    svc.tasks.create = vi.fn().mockResolvedValue(created)
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "create", subject: "Rotate keys" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain(CTA_PREFIX)
    // The exact incantation lets the agent copy-paste back into a
    // tool call. Pin the literal so a refactor that drops `taskId`
    // or shifts to single-quotes-vs-double trips here.
    expect(text).toContain(`lore-task({ action: 'close', taskId: 't-new' })`)
  })

  it("renders the closure CTA on an active-state update", async () => {
    const svc = services()
    svc.tasks.update = vi.fn().mockResolvedValue({
      ...makeTask("t-active", { taskState: "in-progress" }),
      content: "",
    })
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({
      action: "update",
      taskId: "t-active",
      state: "in-progress",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain(CTA_PREFIX)
    expect(text).toContain(`lore-task({ action: 'close', taskId: 't-active' })`)
  })

  it("suppresses the closure CTA on a done-state update", async () => {
    const svc = services()
    svc.tasks.update = vi.fn().mockResolvedValue({
      ...makeTask("t-done", { taskState: "done" }),
      content: "",
    })
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({
      action: "update",
      taskId: "t-done",
      state: "done",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    // `update({ state: "done" })` is itself a close-shaped operation
    // — repeating "close this task" is noise, not a nudge.
    expect(text).not.toContain(CTA_PREFIX)
  })

  it("suppresses the closure CTA on a cancelled-state update", async () => {
    const svc = services()
    svc.tasks.update = vi.fn().mockResolvedValue({
      ...makeTask("t-cx", { taskState: "cancelled" }),
      content: "",
    })
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({
      action: "update",
      taskId: "t-cx",
      state: "cancelled",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).not.toContain(CTA_PREFIX)
  })

  it("suppresses the closure CTA on close (self-referential)", async () => {
    const svc = services()
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "close", taskId: "t-id" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).not.toContain(CTA_PREFIX)
  })

  it("echoes the post-close Done At date when present", async () => {
    const svc = services()
    svc.tasks.getById = vi
      .fn()
      .mockResolvedValue(makeTask("t-id", { doneAt: "2026-04-28" }))
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "close", taskId: "t-id" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("Closed task t-id (state: done)")
    expect(text).toContain("Done at: 2026-04-28")
  })

  it("omits the Done at line when the post-close re-read returns null", async () => {
    // Pre-#07 vault that hasn't been migrated: the row exists but
    // the column is empty. Suppress the courtesy line rather than
    // surface "Done at: null" / "Done at: undefined".
    const svc = services()
    svc.tasks.getById = vi.fn().mockResolvedValue(makeTask("t-id", { doneAt: null }))
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "close", taskId: "t-id" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toBe("Closed task t-id (state: done)")
  })

  it("returns the close confirmation even when the post-close re-read fails", async () => {
    // The Done At echo is a courtesy line — a transient 5xx on
    // `getById` shouldn't mask the close confirmation that already
    // landed on Notion.
    const svc = services()
    svc.tasks.getById = vi.fn().mockRejectedValue(new Error("boom"))
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "close", taskId: "t-id" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toBe("Closed task t-id (state: done)")
  })

  it("leads the lore-task description with the CRITICAL CLOSURE RULE", async () => {
    const svc = services()
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const config = (
      mockServer.server.registerTool as ReturnType<typeof vi.fn>
    ).mock.calls.find(([name]) => name === "lore-task")?.[1] as
      | { description?: string }
      | undefined

    // Pin **position**, not just presence. Agents tokenize tool
    // descriptions top-down and weight early all-caps directives
    // disproportionately. The whole point of this issue is that the
    // rule sits *before* the per-action bullet list — a future
    // refactor that moves the rule below the bullets passes a bare
    // `toContain` assertion but silently regresses the leverage.
    const description = config?.description ?? ""
    const ruleIdx = description.indexOf("CRITICAL CLOSURE RULE")
    const firstBulletIdx = description.indexOf("- `action:")
    expect(ruleIdx).toBeGreaterThan(-1)
    expect(firstBulletIdx).toBeGreaterThan(-1)
    expect(ruleIdx).toBeLessThan(firstBulletIdx)
    expect(description).toContain("action='close'")
  })
})

/**
 * PF3-07 Issue B: optional task fields all share the rule "empty
 * string == absence", and the Zod boundary rejects whitespace-only
 * values so a stray `"  "` can't slip through and corrupt the row's
 * rich_text column.
 */
describe("optional-string Zod boundary", () => {
  /**
   * Validation lives in the polymorphic dispatcher's discriminated
   * union (per-action schemas in `tasks.ts`). Drive validation through
   * the registered handler so a refactor that moves a check between
   * schema and handler still surfaces here. Returns `{ ok }` for the
   * accepts-cases and `{ ok: false, message }` for the rejects-cases
   * — matches the shape the prior `safeParse` assertions checked.
   */
  async function run(
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; message: string }> {
    const svc = services()
    svc.tasks.create = vi.fn().mockResolvedValue({
      id: "t1",
      title: "T",
      projectIds: [],
      taskState: "open",
      blockedBy: "",
      entity: "T",
      reviewBy: null,
    })
    svc.tasks.update = vi.fn().mockResolvedValue({
      id: "t1",
      title: "T",
      projectIds: [],
      taskState: "open",
      blockedBy: "",
      entity: "T",
      reviewBy: null,
    })
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)
    const handler = mockServer.getHandler("lore-task")
    const result = (await handler(args as never)) as {
      isError?: boolean
      content: Array<{ text: string }>
    }
    return { ok: !result.isError, message: result.content[0]?.text ?? "" }
  }

  describe("action='create'", () => {
    const baseInput = { action: "create", subject: "Rotate keys" }

    it("accepts empty string for blockedBy / entity / description (absence semantic)", async () => {
      const { ok } = await run({
        ...baseInput,
        blockedBy: "",
        entity: "",
        description: "",
      })
      expect(ok).toBe(true)
    })

    it("rejects malformed dueDate at the Zod boundary on create too", async () => {
      // Create's `dueDate` carries the YYYY-MM-DD regex on the
      // discriminated union — pin it so a future refactor that moves
      // the check into the handler still trips this assertion.
      const { ok, message } = await run({ ...baseInput, dueDate: "tomorrow-please" })
      expect(ok).toBe(false)
      expect(message).toContain("YYYY-MM-DD")
    })

    it("rejects empty dueDate on create — the regex won't match an empty string", async () => {
      // Create's regex doesn't admit empty string (unlike update,
      // which permits empty as "clear-the-date" via handler-level
      // validation). Document the asymmetry rather than mask it.
      const { ok } = await run({ ...baseInput, dueDate: "" })
      expect(ok).toBe(false)
    })
  })

  describe("action='update'", () => {
    const baseInput = { action: "update", taskId: "task-id" }

    it("accepts empty string on every empty-able field", async () => {
      const { ok } = await run({
        ...baseInput,
        blockedBy: "",
        entity: "",
        description: "",
        dueDate: "",
      })
      expect(ok).toBe(true)
    })

    it("accepts null dueDate as clear-the-date", async () => {
      const { ok } = await run({ ...baseInput, dueDate: null })
      expect(ok).toBe(true)
    })

    it("rejects malformed (non-YMD) dueDate", async () => {
      // Update uses the shared clearable date schema: malformed non-empty
      // strings are rejected, while empty string/null remain clear-the-date.
      const { ok, message } = await run({ ...baseInput, dueDate: "not-a-date" })
      expect(ok).toBe(false)
      expect(message).toContain("YYYY-MM-DD")
    })

    it("accepts a well-formed YMD dueDate", async () => {
      const { ok } = await run({ ...baseInput, dueDate: "2026-05-01" })
      expect(ok).toBe(true)
    })
  })
})

describe("lore-tasks", () => {
  it("returns an error when list projectName does not resolve", async () => {
    const svc = services({
      context: { project: { id: "proj-ambient", name: "Ambient", path: "." } },
    })
    svc.projects.findByName = vi.fn().mockResolvedValue(null)
    svc.tasks.list = vi.fn()
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "list", projectName: "Missing" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(text).toContain('Project "Missing" could not be resolved')
    expect(text).toContain("Fix the project scope")
    expect(svc.tasks.list).not.toHaveBeenCalled()
  })

  it("buckets tasks into Overdue and Active sections", async () => {
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    svc.tasks.list = vi.fn().mockResolvedValue({
      items: [
        makeTask("t-overdue", { reviewBy: "2026-01-01", entity: "PR-1" }),
        makeTask("t-active", { reviewBy: "2099-01-01", entity: "PR-2" }),
      ],
    })

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "list" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("### Overdue")
    expect(text).toContain("### Active")
    expect(text).toContain("t-overdue")
    expect(text).toContain("t-active")
  })

  it("threads startCursor through the bounded walk and marks capped task-list pages as truncated", async () => {
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    svc.tasks.list = vi.fn().mockResolvedValue({
      items: [makeTask("t-capped", { reviewBy: "2099-01-01", entity: "PR-1" })],
      nextCursor: "keep-paging",
      capped: true,
    })

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({
      action: "list",
      startCursor: "resume-here",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(svc.tasks.list).toHaveBeenCalledTimes(1)
    expect(svc.tasks.list).toHaveBeenCalledWith(
      expect.objectContaining({ startCursor: "resume-here", limit: 40 })
    )
    expect(text).toContain("t-capped")
    expect(text).toContain("≥1 tasks (lower-bound total; listing capped at 40):")
    expect(text).toMatch(/```json\n\{"nextCursor":"keep-paging","truncated":true\}\n```/)
  })

  it("paginates multiple saturated windows before reporting bucket totals", async () => {
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    const firstOverduePage = Array.from({ length: 100 }, (_, i) =>
      makeTask(`t-overdue-${i + 1}`, {
        title: `Overdue ${i + 1}`,
        reviewBy: "2026-01-01",
        entity: "PR-1",
      })
    )
    const secondOverduePage = Array.from({ length: 100 }, (_, i) =>
      makeTask(`t-overdue-${i + 101}`, {
        title: `Overdue ${i + 101}`,
        reviewBy: "2026-01-01",
        entity: "PR-1",
      })
    )
    svc.tasks.list = vi
      .fn()
      .mockResolvedValueOnce({ items: firstOverduePage, nextCursor: "cursor-2" })
      .mockResolvedValueOnce({ items: secondOverduePage, nextCursor: "cursor-3" })
      .mockResolvedValueOnce({
        items: [
          makeTask("t-active-after-prefix", {
            title: "Active after overdue prefix",
            reviewBy: "2099-01-01",
            entity: "PR-2",
          }),
        ],
      })

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "list", limit: 30 } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(svc.tasks.list).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ limit: 100, projectId: "proj-1" })
    )
    expect(svc.tasks.list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        limit: 100,
        projectId: "proj-1",
        startCursor: "cursor-2",
      })
    )
    expect(svc.tasks.list).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        limit: 100,
        projectId: "proj-1",
        startCursor: "cursor-3",
      })
    )
    expect(text).toContain("201 tasks (exact total):")
    expect(text).toContain("### Overdue (30 shown of 200, hiding 170)")
    expect(text).toContain("### Active (1)")
    expect(text).toContain("t-active-after-prefix")
  })

  it("treats an exhausted MCP walk as exact even when an intermediate service page is capped", async () => {
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    svc.tasks.list = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          makeTask("t-intermediate-cap", {
            title: "Intermediate service cap",
            reviewBy: "2099-01-01",
          }),
        ],
        nextCursor: "cursor-2",
        capped: true,
      })
      .mockResolvedValueOnce({
        items: [
          makeTask("t-final-page", {
            title: "Final page task",
            reviewBy: "2099-01-01",
          }),
        ],
        nextCursor: undefined,
        capped: false,
      })

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "list", limit: 30 } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(svc.tasks.list).toHaveBeenCalledTimes(2)
    expect(svc.tasks.list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ startCursor: "cursor-2", limit: 100 })
    )
    expect(text).toContain("2 tasks (exact total):")
    expect(text).toContain("### Active (2)")
    expect(text).not.toContain("lower-bound")
    expect(text).not.toContain("More matching tasks exist")
    expect(text).not.toContain("truncated")
    expect(text).not.toContain("≥")
  })

  it("keeps small-limit triage calls bounded and marks saturated counts lower-bound", async () => {
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    svc.tasks.list = vi.fn().mockResolvedValue({
      items: Array.from({ length: 20 }, (_, i) =>
        makeTask(`t-overdue-small-${i + 1}`, {
          title: `Overdue small ${i + 1}`,
          reviewBy: "2026-01-01",
          entity: "PR-1",
        })
      ),
      nextCursor: "cursor-hidden-active",
    })

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "list", limit: 5 } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(svc.tasks.list).toHaveBeenCalledTimes(1)
    expect(svc.tasks.list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20, projectId: "proj-1" })
    )
    expect(text).toContain("≥20 tasks (lower-bound total; listing capped at 20):")
    expect(text).toContain("### Overdue (5 shown of ≥20, hiding ≥15)")
    expect(text).toContain(
      "More matching tasks exist after the first 20 fetched rows; totals are lower bounds."
    )
    expect(text).toContain("Use `limit >= 26` for a deeper bounded walk")
    expect(text).toMatch(/```json\n\{"truncated":true\}\n```/)
    expect(text).not.toContain("### Active")
  })

  it("caps broad closed-state walks and marks counts as lower bounds", async () => {
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    svc.tasks.list = vi.fn(async () => {
      const call = (svc.tasks.list as ReturnType<typeof vi.fn>).mock.calls.length
      return {
        items: Array.from({ length: 100 }, (_, i) =>
          makeTask(`t-done-${call}-${i + 1}`, {
            title: `Done ${call}-${i + 1}`,
            taskState: "done",
            reviewBy: "2026-01-01",
          })
        ),
        nextCursor: `cursor-${call + 1}`,
      }
    })

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({
      action: "list",
      state: "done",
      limit: 30,
      includeSynopsis: false,
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(svc.tasks.list).toHaveBeenCalledTimes(10)
    expect(svc.tasks.list).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ states: ["done"], limit: 100 })
    )
    expect(svc.tasks.list).toHaveBeenNthCalledWith(
      10,
      expect.objectContaining({ startCursor: "cursor-10", limit: 100 })
    )
    expect(text).toContain("≥1000 tasks (lower-bound total; listing capped at 1000):")
    expect(text).toContain("### Done (30 shown of ≥1000, hiding ≥970)")
    expect(text).toContain(
      "More matching tasks exist after the first 1000 fetched rows; totals are lower bounds."
    )
    expect(text).toContain(
      "The deepest bounded walk already ran; narrow with `projectName`, `entity`, `state`, or `dueBefore` for exact totals."
    )
    expect(text).not.toContain("Use `limit >= 26`")
    expect(text).toMatch(/```json\n\{"truncated":true\}\n```/)
  })

  it("does not mark the tenth page as saturated when the cursor exhausts exactly at the cap boundary", async () => {
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    svc.tasks.list = vi.fn(async () => {
      const call = (svc.tasks.list as ReturnType<typeof vi.fn>).mock.calls.length
      return {
        items: Array.from({ length: 100 }, (_, i) =>
          makeTask(`t-boundary-${call}-${i + 1}`, {
            title: `Boundary ${call}-${i + 1}`,
            taskState: "done",
            reviewBy: "2026-01-01",
          })
        ),
        nextCursor: call < 10 ? `cursor-${call + 1}` : undefined,
      }
    })

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({
      action: "list",
      state: "done",
      limit: 30,
      includeSynopsis: false,
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(svc.tasks.list).toHaveBeenCalledTimes(10)
    expect(text).toContain("1000 tasks (exact total):")
    expect(text).toContain("### Done (30 shown of 1000, hiding 970)")
    expect(text).not.toContain("lower-bound")
    expect(text).not.toContain("More matching tasks exist")
    expect(text).not.toContain("≥")
  })

  it("does not emit a nextCursor when per-section hiding leaves fetched rows unrendered", async () => {
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    svc.tasks.list = vi.fn().mockResolvedValue({
      items: [
        makeTask("t-1", { reviewBy: "2026-01-01", entity: "PR-1" }),
        makeTask("t-2", { reviewBy: "2026-01-02", entity: "PR-2" }),
        makeTask("t-3", { reviewBy: "2026-01-03", entity: "PR-3" }),
      ],
      nextCursor: "after-hidden-row",
      capped: false,
    })

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "list", limit: 2 } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("hiding ≥1")
    expect(text).not.toContain("after-hidden-row")
    expect(text).toMatch(/```json\n\{"truncated":true\}\n```/)
  })

  it("surfaces pagination failures without rendering partial first-page rows", async () => {
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    svc.tasks.list = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          makeTask("t-first-page", {
            title: "First page task",
            reviewBy: "2099-01-01",
          }),
        ],
        nextCursor: "cursor-2",
      })
      .mockRejectedValueOnce(new Error("notion 503"))

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "list", limit: 30 } as never)
    const wrapped = result as { content: Array<{ text: string }>; isError?: boolean }
    const text = wrapped.content[0].text

    expect(wrapped.isError).toBe(true)
    expect(text).toContain("Error: notion 503")
    expect(text).not.toContain("First page task")
  })

  it("renders cancelled task listings under a Cancelled section", async () => {
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    svc.tasks.list = vi.fn().mockResolvedValue({
      items: [
        makeTask("t-cancelled", {
          title: "Dropped task",
          taskState: "cancelled",
          reviewBy: "2026-01-01",
        }),
      ],
    })

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "list", state: "cancelled" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(svc.tasks.list).toHaveBeenCalledWith(
      expect.objectContaining({ states: ["cancelled"] })
    )
    expect(text).toContain("1 task (exact total):")
    expect(text).toContain("### Cancelled (1)")
    expect(text).not.toContain("Closure:")
  })

  it("renders 'No tasks found' when the listing is empty", async () => {
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "list", entity: "PR #99" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("No tasks found")
    expect(text).toContain("PR #99")
  })

  it("marks empty saturated task-list walks as lower-bound instead of exact zero", async () => {
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    svc.tasks.list = vi.fn().mockResolvedValue({
      items: [],
      nextCursor: "cursor-archived-only",
    })

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({
      action: "list",
      entity: "PR",
      limit: 5,
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(svc.tasks.list).toHaveBeenCalledTimes(1)
    expect(svc.tasks.list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20, entities: ["PR"] })
    )
    expect(text).toContain(
      'No tasks found matching "PR" in the first 20 fetched rows; more matching tasks may exist.'
    )
    expect(text).toMatch(
      /```json\n\{"nextCursor":"cursor-archived-only","truncated":true\}\n```/
    )
  })

  it("wraps the singular `entity` input into a one-element entities array — does not canonicalize", async () => {
    // The user-facing `entity` argument is intentionally singular: an
    // agent calling `lore-task` action='list' typed exactly one
    // string and expects tasks containing that string. Alias-aware
    // recall belongs to `lore-ask`, which knows the canonical entity.
    // This test pins that boundary so a future refactor doesn't
    // silently start re-resolving the user's input behind their back.
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    await handler({ action: "list", entity: "AuthSvc" } as never)

    const callArgs = (svc.tasks.list as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArgs.entities).toEqual(["AuthSvc"])
    // No legacy `entity` field — service-layer surface is single
    // source of truth on the multi-variant shape.
    expect(callArgs).not.toHaveProperty("entity")
  })

  it("omits the entities filter entirely when no entity input is provided", async () => {
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    await handler({ action: "list" } as never)

    const callArgs = (svc.tasks.list as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArgs.entities).toBeUndefined()
    expect(callArgs.states).toEqual(["open", "in-progress", "blocked"])
  })
})

describe("lore-task synopsis surface (issue 0.7.0/02)", () => {
  it("threads synopsis on action='create' through to TaskService.create", async () => {
    const created: Task = {
      ...makeTask("t-syn", { synopsis: "Rotate keys for new env." }),
      content: "",
    } as Task
    const svc = services()
    svc.tasks.create = vi.fn().mockResolvedValue(created)
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    await handler({
      action: "create",
      subject: "Rotate keys",
      synopsis: "Rotate keys for new env.",
    } as never)

    expect(svc.tasks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Rotate keys",
        synopsis: "Rotate keys for new env.",
      })
    )
  })

  it("threads synopsis on action='update' through to TaskService.update with update/leave-alone/clear semantics", async () => {
    const svc = services()
    svc.tasks.update = vi.fn().mockResolvedValue({
      ...makeTask("t-1"),
      content: "",
    } as Task)
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)
    const handler = mockServer.getHandler("lore-task")

    // Update — explicit value lands.
    await handler({
      action: "update",
      taskId: "t-1",
      synopsis: "Updated synopsis",
    } as never)
    expect(svc.tasks.update).toHaveBeenCalledWith(
      "t-1",
      expect.objectContaining({ synopsis: "Updated synopsis" })
    )

    // Clear — empty string forwards through.
    ;(svc.tasks.update as ReturnType<typeof vi.fn>).mockClear()
    await handler({
      action: "update",
      taskId: "t-1",
      synopsis: "",
    } as never)
    expect(svc.tasks.update).toHaveBeenCalledWith(
      "t-1",
      expect.objectContaining({ synopsis: "" })
    )

    // Leave-alone — omitted arg arrives as undefined.
    ;(svc.tasks.update as ReturnType<typeof vi.fn>).mockClear()
    await handler({
      action: "update",
      taskId: "t-1",
      subject: "rename",
    } as never)
    const [, args] = (svc.tasks.update as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(args.synopsis).toBeUndefined()
  })

  it("rejects synopsis longer than 500 chars at the Zod boundary on create", async () => {
    const svc = services()
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)
    const handler = mockServer.getHandler("lore-task")
    const overCap = "x".repeat(501)

    const result = await handler({
      action: "create",
      subject: "T",
      synopsis: overCap,
    } as never)

    const wrapped = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(wrapped.isError).toBe(true)
    expect(wrapped.content[0].text).toContain("synopsis")
    expect(svc.tasks.create).not.toHaveBeenCalled()
  })

  it("rejects synopsis longer than 500 chars at the Zod boundary on update", async () => {
    const svc = services()
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)
    const handler = mockServer.getHandler("lore-task")
    const overCap = "x".repeat(501)

    const result = await handler({
      action: "update",
      taskId: "t-1",
      synopsis: overCap,
    } as never)

    const wrapped = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(wrapped.isError).toBe(true)
    expect(wrapped.content[0].text).toContain("synopsis")
    expect(svc.tasks.update).not.toHaveBeenCalled()
  })
})

describe("lore-task action='list' synopsis rendering (DEFERRED-01)", () => {
  it("renders the synopsis as an indented line between the title row and the ID line by default", async () => {
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    svc.tasks.list = vi.fn().mockResolvedValue({
      items: [
        makeTask("t-syn", {
          title: "Rotate keys",
          synopsis: "Rotate keys for new env.",
          entity: "PR-1",
          reviewBy: "2099-01-01",
        }),
      ],
    })

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "list" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    const lines = text.split("\n")
    const titleIdx = lines.findIndex((l) => l.includes("**Rotate keys**"))
    expect(titleIdx).toBeGreaterThanOrEqual(0)
    // Synopsis lives between the title row and the `  ID:` line.
    expect(lines[titleIdx + 1]).toBe("  Rotate keys for new env.")
    expect(lines[titleIdx + 2]).toMatch(/^ {2}ID: t-syn/)
  })

  it("omits the synopsis line on rows with empty synopsis (byte-identical pre-DEFERRED-01 path)", async () => {
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    svc.tasks.list = vi.fn().mockResolvedValue({
      items: [
        makeTask("t-plain", {
          title: "Plain task",
          synopsis: "",
          entity: "PR-1",
          reviewBy: "2099-01-01",
        }),
      ],
    })

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "list" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    // Byte-identical pin against the pre-DEFERRED-01 row shape — `toBe`
    // rather than `toMatch` so any indentation drift, trailing whitespace,
    // or extra newline shows up as a test failure rather than slipping past
    // a regex that only checked the first line. `2099-01-01` is far enough
    // in the future that `taskDaysOverdue` returns null on every wall-clock
    // day this suite runs, keeping `due 2099-01-01` deterministic.
    expect(text).toBe(
      "1 task (exact total):\n\n" +
        "### Active (1)\n\n" +
        "- **Plain task** [open] (due 2099-01-01)\n" +
        "  ID: t-plain"
    )
  })

  it("treats whitespace-only synopsis the same as empty (no rendered line)", async () => {
    // Mirror of the decisions-list test: pin the trim-aware truthy check
    // so a hypothetical migration / hand-edit landing `"   "` synopsis
    // doesn't emit a row of pure whitespace between the title and ID.
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    svc.tasks.list = vi.fn().mockResolvedValue({
      items: [
        makeTask("t-ws", {
          title: "Whitespace task",
          synopsis: "   \t  ",
          entity: "PR-1",
          reviewBy: "2099-01-01",
        }),
      ],
    })

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "list" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toBe(
      "1 task (exact total):\n\n" +
        "### Active (1)\n\n" +
        "- **Whitespace task** [open] (due 2099-01-01)\n" +
        "  ID: t-ws"
    )
  })

  it("suppresses the synopsis line when includeSynopsis: false", async () => {
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    svc.tasks.list = vi.fn().mockResolvedValue({
      items: [
        makeTask("t-syn", {
          title: "Rotate keys",
          synopsis: "Rotate keys for new env.",
          entity: "PR-1",
          reviewBy: "2099-01-01",
        }),
      ],
    })

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({
      action: "list",
      includeSynopsis: false,
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).not.toContain("Rotate keys for new env.")
    const lines = text.split("\n")
    const titleIdx = lines.findIndex((l) => l.includes("**Rotate keys**"))
    expect(lines[titleIdx + 1]).toMatch(/^ {2}ID: t-syn/)
  })

  it("defensively truncates over-cap synopses on the listing surface", async () => {
    const word = "abcde "
    const longSynopsis = word.repeat(100)
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    svc.tasks.list = vi.fn().mockResolvedValue({
      items: [
        makeTask("t-long", {
          title: "Long synopsis task",
          synopsis: longSynopsis,
          entity: "PR-1",
          reviewBy: "2099-01-01",
        }),
      ],
    })

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "list" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    const lines = text.split("\n")
    const titleIdx = lines.findIndex((l) => l.includes("**Long synopsis task**"))
    const synopsisLine = lines[titleIdx + 1]
    // Two-space indent + truncated synopsis, ≤ 500 chars of payload.
    expect(synopsisLine.startsWith("  ")).toBe(true)
    const payload = synopsisLine.slice(2)
    expect(payload.length).toBeLessThanOrEqual(500)
    // Boundary-safe: ends on a word, no trailing whitespace, no ellipsis.
    // Mirrors `decisions.test.ts`'s assertion shape so a regression in
    // `truncateSynopsis`'s word-boundary fallback catches symmetrically
    // across all three new surfaces, not just the decision path.
    expect(payload.endsWith("e")).toBe(true)
    expect(synopsisLine).not.toContain("…")
  })
})

describe("lore-task action='list' trust indicator (DEFERRED-01 follow-up to 0.8.0/#09)", () => {
  // Same shape as the synopsis suite above (DEFERRED-01 from 0.7.0).
  // The bucket boundaries themselves are exhaustively pinned in
  // `render.test.ts` via `formatTrustLabel`; here we pin the surface
  // wiring (the line lands between the title row and the synopsis
  // line, indented by two spaces, italic-wrapped).

  it("renders the trust line as an indented italic between the title row and the synopsis line", async () => {
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    svc.tasks.list = vi.fn().mockResolvedValue({
      items: [
        makeTask("t-low", {
          title: "Low-trust task",
          synopsis: "Rotate keys for new env.",
          confidenceScore: 0.3,
          entity: "PR-1",
          reviewBy: "2099-01-01",
        }),
      ],
    })

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "list" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    const lines = text.split("\n")
    const titleIdx = lines.findIndex((l) => l.includes("**Low-trust task**"))
    expect(titleIdx).toBeGreaterThanOrEqual(0)
    // Order is load-bearing: title → trust → synopsis → ID. Same
    // discipline as the wake-up Tasks renderer and `formatMemoryListItem`.
    expect(lines[titleIdx + 1]).toBe("  _low confidence_")
    expect(lines[titleIdx + 2]).toBe("  Rotate keys for new env.")
    expect(lines[titleIdx + 3]).toMatch(/^ {2}ID: t-low/)
  })

  it("renders `_very low confidence_` when the stored score is below 0.2", async () => {
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    svc.tasks.list = vi.fn().mockResolvedValue({
      items: [
        makeTask("t-vlow", {
          title: "Heavily-decayed task",
          synopsis: "",
          confidenceScore: 0.15,
          entity: "PR-1",
          reviewBy: "2099-01-01",
        }),
      ],
    })

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "list" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    const lines = text.split("\n")
    const titleIdx = lines.findIndex((l) => l.includes("**Heavily-decayed task**"))
    expect(lines[titleIdx + 1]).toBe("  _very low confidence_")
  })

  it("renders `_moderate confidence_` when 0.4 ≤ score < 0.5", async () => {
    // Symmetry with the decisions-list and wake-up Tasks suites — each
    // surface pins one positive in-bucket assertion per band so a
    // future contributor swapping the formatter sees regressions on the
    // listing surface, not just at the `formatTrustLabel` helper.
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    svc.tasks.list = vi.fn().mockResolvedValue({
      items: [
        makeTask("t-mod", {
          title: "Borderline task",
          synopsis: "",
          confidenceScore: 0.45,
          entity: "PR-1",
          reviewBy: "2099-01-01",
        }),
      ],
    })

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "list" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    const lines = text.split("\n")
    const titleIdx = lines.findIndex((l) => l.includes("**Borderline task**"))
    expect(lines[titleIdx + 1]).toBe("  _moderate confidence_")
  })

  it("omits the trust line on a null-score row (pre-migration vault stays byte-identical)", async () => {
    // Acceptance criterion: rows with `confidenceScore: null` render
    // identically to pre-DEFERRED-01. `toBe` on the entire response
    // body so any indentation drift, trailing whitespace, or extra
    // newline between title and ID would surface here. `2099-01-01` is
    // far enough in the future that `taskDaysOverdue` returns null on
    // every wall-clock day this suite runs, keeping the `due
    // 2099-01-01` line deterministic.
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    svc.tasks.list = vi.fn().mockResolvedValue({
      items: [
        makeTask("t-null", {
          title: "Pre-migration row",
          synopsis: "",
          confidenceScore: null,
          entity: "PR-1",
          reviewBy: "2099-01-01",
        }),
      ],
    })

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "list" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toBe(
      "1 task (exact total):\n\n" +
        "### Active (1)\n\n" +
        "- **Pre-migration row** [open] (due 2099-01-01)\n" +
        "  ID: t-null"
    )
  })

  it("omits the trust line when the score is at or above the display threshold", async () => {
    // Strict-less-than gate: a row with score === 0.5 must NOT render
    // the indicator. A `<=` rewrite would render `_moderate confidence_`
    // and trip the `_moderate confidence_` negative assertion below;
    // the looser `confidence_` substring negative is the catch-all.
    // Positive row-existence assertion pins that the row itself still
    // renders — the gate suppresses the indicator, not the row.
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    svc.tasks.list = vi.fn().mockResolvedValue({
      items: [
        makeTask("t-healthy", {
          title: "Healthy task",
          synopsis: "",
          confidenceScore: 0.5,
          entity: "PR-1",
          reviewBy: "2099-01-01",
        }),
      ],
    })

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "list" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("Healthy task")
    expect(text).not.toContain("_moderate confidence_")
    expect(text).not.toContain("confidence_")
  })

  it("respects `includeSynopsis: false` but still renders the trust line", async () => {
    // Same independence contract pinned in `render.test.ts` and the
    // decisions-list suite: trust is system metadata, not synopsis
    // content. Suppressing the synopsis must not suppress the trust
    // line.
    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    svc.tasks.list = vi.fn().mockResolvedValue({
      items: [
        makeTask("t-no-syn", {
          title: "No-synopsis low-trust",
          synopsis: "This synopsis must not render.",
          confidenceScore: 0.3,
          entity: "PR-1",
          reviewBy: "2099-01-01",
        }),
      ],
    })

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({
      action: "list",
      includeSynopsis: false,
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).not.toContain("This synopsis must not render.")
    expect(text).toContain("  _low confidence_")
    const lines = text.split("\n")
    const titleIdx = lines.findIndex((l) => l.includes("**No-synopsis low-trust**"))
    expect(lines[titleIdx + 1]).toBe("  _low confidence_")
    // Suppressing synopsis collapses to title → trust → ID.
    expect(lines[titleIdx + 2]).toMatch(/^ {2}ID: t-no-syn/)
  })

  it("renders the trust line bucket-agnostically (overdue + active rows alike)", async () => {
    // The DEFERRED-01 spec lists this as one of the three surfaces; a
    // bucket-agnostic test pins that the formatter doesn't accidentally
    // treat one bucket as a special case. Mirrors the wake-up Tasks
    // assertion in `context.test.ts`.
    const overdueTask = makeTask("t-overdue", {
      title: "Overdue low-trust",
      synopsis: "",
      confidenceScore: 0.3,
      entity: "PR-1",
      reviewBy: "2020-01-01",
    })
    const activeTask = makeTask("t-active", {
      title: "Active low-trust",
      synopsis: "",
      confidenceScore: 0.15,
      entity: "PR-2",
      reviewBy: "2099-01-01",
    })

    const svc = services({
      context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    })
    svc.tasks.list = vi.fn().mockResolvedValue({ items: [overdueTask, activeTask] })

    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "list" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    const lines = text.split("\n")
    const overdueIdx = lines.findIndex((l) => l.includes("**Overdue low-trust**"))
    const activeIdx = lines.findIndex((l) => l.includes("**Active low-trust**"))
    expect(overdueIdx).toBeGreaterThanOrEqual(0)
    expect(activeIdx).toBeGreaterThanOrEqual(0)
    expect(lines[overdueIdx + 1]).toBe("  _low confidence_")
    expect(lines[activeIdx + 1]).toBe("  _very low confidence_")
  })
})

/**
 * Issue 0.7.0/14 — `lore-task action='reconcile'` integration. The
 * algorithm itself is exercised in `src/core/task-reconcile.test.ts`;
 * this block pins the wire-up (handler renders the algorithm's output,
 * resolves project context, rejects unresolved explicit project scope, and
 * the response shape matches the spec).
 */
describe("lore-task action='reconcile' (issue 0.7.0/14)", () => {
  it("renders the empty-set form when there are no active tasks", async () => {
    const svc = services()
    svc.tasks.list = vi.fn().mockResolvedValue({ items: [] })
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "reconcile" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("## 0 candidate closures (out of 0 active tasks scanned)")
  })

  it("renders the empty-set form with N when active tasks exist but no candidates clear threshold", async () => {
    const svc = services({
      memories: {
        search: vi.fn().mockResolvedValue([]),
        materializeContent: vi.fn(async (m: unknown) => m),
      },
    })
    svc.tasks.list = vi.fn().mockResolvedValue({
      items: [
        makeTask("t1", { entity: "PR-25750", taskState: "in-progress" }),
        makeTask("t2", { entity: "PR-25751", taskState: "open" }),
      ],
    })
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "reconcile" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("## 0 candidate closures (out of 2 active tasks scanned)")
  })

  it("renders ranked candidates with id, title, score, cue snippet, and close incantation", async () => {
    const today = new Date().toISOString().split("T")[0]!
    const recentDate = new Date().toISOString()
    const memory = {
      id: "m-good",
      title: "Merged PR-25750",
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
      content: "We merged PR-25750 today — outlook label.applied classifier shipped.",
      createdAt: recentDate,
      updatedAt: recentDate,
      taskState: null,
      blockedBy: "",
      entity: "",
    }
    const svc = services({
      memories: {
        search: vi.fn().mockResolvedValue([memory]),
        materializeContent: vi.fn(async () => memory),
      },
    })
    svc.tasks.list = vi.fn().mockResolvedValue({
      items: [
        makeTask("t-abc", {
          title: "Track PR-25750 review",
          entity: "PR-25750",
          taskState: "in-progress",
        }),
      ],
    })
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({ action: "reconcile" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("## 1 candidate closure (out of 1 active task scanned)")
    expect(text).toContain('### 1. Task t-abc — "Track PR-25750 review" [in-progress')
    expect(text).toContain("Best match: memory m-good")
    expect(text).toContain("Cue: ")
    expect(text).toContain("Close: lore-task({ action: 'close', taskId: 't-abc' })")
    // Today should land in the line.
    void today
  })

  it("returns an error when projectName resolves nothing", async () => {
    const svc = services()
    svc.projects.findByName = vi.fn().mockResolvedValue(null)
    svc.tasks.list = vi.fn().mockResolvedValue({ items: [] })
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    const result = await handler({
      action: "reconcile",
      projectName: "Nonexistent",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(svc.projects.findByName).toHaveBeenCalledWith("Nonexistent")
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(text).toContain('Project "Nonexistent" could not be resolved')
    expect(text).toContain("Fix the project scope")
    expect(svc.tasks.list).not.toHaveBeenCalled()
  })

  it("scopes the reconcile pass to the resolved project id", async () => {
    const svc = services({
      context: { project: { id: "ctx-proj", name: "AutoDetected", path: "." } },
    })
    svc.tasks.list = vi.fn().mockResolvedValue({ items: [] })
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task")
    await handler({ action: "reconcile" } as never)

    // The first call to tasks.list inside reconcileActiveTasks should
    // receive the auto-detected project id.
    expect(svc.tasks.list).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "ctx-proj" })
    )
  })
})

// ---------------------------------------------------------------------------
// DEFERRED-ATTRIBUTION (0.10.0): Author column attribution on lore-task.
//
// Tasks write to the Memories DB (Kind = task) — same Author column as
// memories and decisions. Pin the precedence: explicit args.author wins,
// services.identity.resolveAuthor is the default, null collapses to undefined.
// ---------------------------------------------------------------------------

describe("lore-task action='create' — Author attribution (DEFERRED-ATTRIBUTION)", () => {
  function setUpHarness(identityAuthor: string | null) {
    const created = makeTask("t-attrib")
    const resolveAuthor = vi.fn(async () => identityAuthor)
    const svc = services({ identity: { resolveAuthor, clearCache: vi.fn() } })
    svc.tasks.create = vi.fn().mockResolvedValue(created)
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)
    return { handler: mockServer.getHandler("lore-task"), svc, resolveAuthor }
  }

  it("stamps services.identity.resolveAuthor on tasks.create when args.author is omitted", async () => {
    const { handler, svc } = setUpHarness("Hesham Salman")
    await handler({ action: "create", subject: "Rotate keys" } as never)
    expect(svc.tasks.create).toHaveBeenCalledWith(
      expect.objectContaining({ author: "Hesham Salman" })
    )
  })

  it("explicit args.author wins without calling services.identity.resolveAuthor", async () => {
    const { handler, svc, resolveAuthor } = setUpHarness("ServerSideName")
    await handler({
      action: "create",
      subject: "Rotate keys",
      author: "Override",
    } as never)
    expect(svc.tasks.create).toHaveBeenCalledWith(
      expect.objectContaining({ author: "Override" })
    )
    expect(resolveAuthor).not.toHaveBeenCalled()
  })

  it("collapses to author: undefined when no override and resolver returns null", async () => {
    const { handler, svc } = setUpHarness(null)
    await handler({ action: "create", subject: "Rotate keys" } as never)
    expect(svc.tasks.create).toHaveBeenCalledWith(
      expect.objectContaining({ author: undefined })
    )
  })
})
