import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { registerTaskTools } from "./tasks.js"
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
    createdAt: "2026-04-20T00:00:00Z",
    updatedAt: "2026-04-20T00:00:00Z",
    taskState: "open",
    blockedBy: "",
    entity: `Task ${id}`,
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
    context: { project: null },
    ...overrides,
  }
}

describe("lore-task-create", () => {
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
    svc.tasks.getById = vi
      .fn()
      .mockResolvedValue(makeTask("t-id", { doneAt: null }))
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

    const config = (mockServer.server.registerTool as ReturnType<typeof vi.fn>)
      .mock.calls.find(([name]) => name === "lore-task")?.[1] as
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
    args: Record<string, unknown>,
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

    it("rejects malformed (non-YMD) dueDate", async () => {
      // YMD enforcement on update lives in `handleUpdate`'s manual
      // validation rather than the schema (so empty string can be
      // distinguished as clear-the-date). Pin the rejection so the
      // boundary stays sharp.
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
  })
})
