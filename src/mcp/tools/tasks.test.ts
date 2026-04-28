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
