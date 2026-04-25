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

    const handler = mockServer.getHandler("lore-task-create")
    const result = await handler({
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
    const handler = mockServer.getHandler("lore-task-create")

    const result = await handler({
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
    const handler = mockServer.getHandler("lore-task-create")

    await handler({
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
    const handler = mockServer.getHandler("lore-task-update")

    const result = await handler({
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
    const handler = mockServer.getHandler("lore-task-update")

    const result = await handler({
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
    const handler = mockServer.getHandler("lore-task-update")

    await handler({
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

    const handler = mockServer.getHandler("lore-task-close")
    await handler({ taskId: "task-id" } as never)

    expect(svc.tasks.close).toHaveBeenCalledWith("task-id", "done")
  })

  it("supports state=cancelled for dropped-without-completion path", async () => {
    const svc = services()
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)

    const handler = mockServer.getHandler("lore-task-close")
    await handler({ taskId: "task-id", state: "cancelled" } as never)

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

    const handler = mockServer.getHandler("lore-task-update")
    await handler({ taskId: "task-id", dueDate: "" } as never)

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
  function createSchema(toolName: string) {
    const svc = services()
    const mockServer = createMockServer()
    registerTaskTools(mockServer.server, svc as never)
    return mockServer.getInputSchema(toolName)
  }

  describe("lore-task-create", () => {
    const baseInput = { subject: "Rotate keys" }

    it("accepts empty string for blockedBy / entity / description (absence semantic)", () => {
      const schema = createSchema("lore-task-create")
      const parsed = schema.safeParse({
        ...baseInput,
        blockedBy: "",
        entity: "",
        description: "",
      })
      expect(parsed.success).toBe(true)
    })

    it("rejects whitespace-only blockedBy", () => {
      const schema = createSchema("lore-task-create")
      const parsed = schema.safeParse({ ...baseInput, blockedBy: "   " })
      expect(parsed.success).toBe(false)
      if (!parsed.success) {
        expect(parsed.error.issues[0].message).toContain("Whitespace-only")
      }
    })

    it("rejects whitespace-only entity", () => {
      const schema = createSchema("lore-task-create")
      const parsed = schema.safeParse({ ...baseInput, entity: " \t " })
      expect(parsed.success).toBe(false)
    })

    it("rejects whitespace-only description", () => {
      const schema = createSchema("lore-task-create")
      const parsed = schema.safeParse({ ...baseInput, description: "  \n  " })
      expect(parsed.success).toBe(false)
    })

    it("rejects whitespace-only subject — title can never be absent", () => {
      const schema = createSchema("lore-task-create")
      const parsed = schema.safeParse({ subject: "   " })
      expect(parsed.success).toBe(false)
    })

    it("rejects malformed dueDate at the Zod boundary on create too", () => {
      // Create and update share the same `dueDateSchema()` — pin both
      // sides so a future refactor of one path can't desync from the
      // other.
      const schema = createSchema("lore-task-create")
      const parsed = schema.safeParse({
        ...baseInput,
        dueDate: "tomorrow-please",
      })
      expect(parsed.success).toBe(false)
    })

    it("accepts an empty dueDate on create as 'no due date set'", () => {
      const schema = createSchema("lore-task-create")
      const parsed = schema.safeParse({ ...baseInput, dueDate: "" })
      expect(parsed.success).toBe(true)
    })
  })

  describe("lore-task-update", () => {
    const baseInput = { taskId: "task-id" }

    it("accepts empty string on every empty-able field", () => {
      const schema = createSchema("lore-task-update")
      const parsed = schema.safeParse({
        ...baseInput,
        blockedBy: "",
        entity: "",
        description: "",
        dueDate: "",
      })
      expect(parsed.success).toBe(true)
    })

    it("rejects whitespace-only blockedBy", () => {
      const schema = createSchema("lore-task-update")
      const parsed = schema.safeParse({ ...baseInput, blockedBy: "   " })
      expect(parsed.success).toBe(false)
    })

    it("rejects whitespace-only entity", () => {
      const schema = createSchema("lore-task-update")
      const parsed = schema.safeParse({ ...baseInput, entity: " " })
      expect(parsed.success).toBe(false)
    })

    it("rejects whitespace-only description", () => {
      const schema = createSchema("lore-task-update")
      const parsed = schema.safeParse({ ...baseInput, description: " \t " })
      expect(parsed.success).toBe(false)
    })

    it("rejects whitespace-only subject — renaming to whitespace is meaningless", () => {
      const schema = createSchema("lore-task-update")
      const parsed = schema.safeParse({ ...baseInput, subject: "   " })
      expect(parsed.success).toBe(false)
    })

    it("rejects whitespace-only dueDate at the Zod boundary", () => {
      const schema = createSchema("lore-task-update")
      const parsed = schema.safeParse({ ...baseInput, dueDate: "   " })
      expect(parsed.success).toBe(false)
    })

    it("rejects malformed (non-YMD) dueDate at the Zod boundary", () => {
      // YMD enforcement now lives in the schema (`dueDateSchema`)
      // rather than a separate handler runtime check, so the rejection
      // happens before the handler runs at all. Pin both paths so a
      // future refactor can't quietly move the validation back into
      // the handler and make the schema misleading.
      const schema = createSchema("lore-task-update")
      const parsed = schema.safeParse({ ...baseInput, dueDate: "not-a-date" })
      expect(parsed.success).toBe(false)
      if (!parsed.success) {
        expect(parsed.error.issues[0].message).toContain("YYYY-MM-DD")
      }
    })

    it("accepts a well-formed YMD dueDate", () => {
      const schema = createSchema("lore-task-update")
      const parsed = schema.safeParse({ ...baseInput, dueDate: "2026-05-01" })
      expect(parsed.success).toBe(true)
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

    const handler = mockServer.getHandler("lore-tasks")
    const result = await handler({} as never)
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

    const handler = mockServer.getHandler("lore-tasks")
    const result = await handler({ entity: "PR #99" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("No tasks found")
    expect(text).toContain("PR #99")
  })
})
