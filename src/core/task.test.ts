import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { TaskService, taskDaysOverdue } from "./task.js"
import type { DatabaseRef, TaskState } from "../types.js"

type MockablePage = Partial<PageObjectResponse> & { id: string }

function makePage(overrides: MockablePage): PageObjectResponse {
  return {
    object: "page",
    created_time: "2026-04-01T00:00:00.000Z",
    last_edited_time: "2026-04-20T00:00:00.000Z",
    archived: false,
    url: `https://notion.so/${overrides.id}`,
    parent: { type: "database_id", database_id: "memories-db" },
    properties: {},
    ...overrides,
  } as PageObjectResponse
}

function taskPage(
  id: string,
  overrides?: {
    title?: string
    state?: TaskState
    blockedBy?: string
    entity?: string
    reviewBy?: string
  }
): PageObjectResponse {
  return makePage({
    id,
    properties: {
      Title: { type: "title", title: [{ plain_text: overrides?.title ?? `Task ${id}` }] } as unknown,
      Kind: { type: "select", select: { name: "task" } } as unknown,
      "Task State": {
        type: "select",
        select: { name: overrides?.state ?? "open" },
      } as unknown,
      "Blocked By": {
        type: "rich_text",
        rich_text: overrides?.blockedBy ? [{ plain_text: overrides.blockedBy }] : [],
      } as unknown,
      Entity: {
        type: "rich_text",
        rich_text: overrides?.entity ? [{ plain_text: overrides.entity }] : [],
      } as unknown,
      ...(overrides?.reviewBy
        ? {
            "Review By": {
              type: "date",
              date: { start: overrides.reviewBy },
            } as unknown,
          }
        : {}),
    } as PageObjectResponse["properties"],
  })
}

interface MockClientOpts {
  retrievedPages?: Record<string, PageObjectResponse>
  queryResults?: PageObjectResponse[]
  createReturn?: PageObjectResponse
  markdown?: string
}

function createMockClient(opts: MockClientOpts = {}) {
  const defaultCreate = makePage({ id: "new-task-id" })
  return {
    pages: {
      create: vi.fn().mockResolvedValue(opts.createReturn ?? defaultCreate),
      retrieve: vi.fn().mockImplementation(({ page_id }: { page_id: string }) => {
        const page = opts.retrievedPages?.[page_id]
        if (!page) return Promise.reject(new Error(`Mock: no page registered for ${page_id}`))
        return Promise.resolve(page)
      }),
      update: vi.fn().mockResolvedValue({}),
      updateMarkdown: vi.fn().mockResolvedValue({}),
      retrieveMarkdown: vi.fn().mockResolvedValue({ markdown: opts.markdown ?? "" }),
    },
    dataSources: {
      query: vi.fn().mockResolvedValue({
        results: opts.queryResults ?? [],
        has_more: false,
        next_cursor: null,
      }),
    },
  } as unknown as Client & { pages: { create: ReturnType<typeof vi.fn> } }
}

const DB: DatabaseRef = {
  databaseId: "memories-db-id",
  dataSourceId: "memories-ds-id",
}

describe("TaskService.create", () => {
  it("sets Kind=task, defaults Task State to open, defaults entity to subject", async () => {
    const created = taskPage("new-task-id", {
      title: "Rotate keys",
      state: "open",
      entity: "Rotate keys",
    })
    const client = createMockClient({ createReturn: created })
    const service = new TaskService(client, DB)

    await service.create({ subject: "Rotate keys" })

    const args = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(args.properties.Kind).toEqual({ select: { name: "task" } })
    expect(args.properties["Task State"]).toEqual({ select: { name: "open" } })
    // Default entity = subject so lore-ask(entity) finds the task without
    // the caller having to restate it.
    expect(args.properties.Entity).toEqual({
      rich_text: [{ text: { content: "Rotate keys" } }],
    })
    // Title carries the subject; description goes in the body via
    // updateMarkdown (we don't pass one here, so it stays empty).
    expect(args.properties.Title).toEqual({
      title: [{ text: { content: "Rotate keys" } }],
    })
  })

  it("writes description as page body via updateMarkdown", async () => {
    const created = taskPage("new-task-id")
    const client = createMockClient({ createReturn: created })
    const service = new TaskService(client, DB)

    await service.create({
      subject: "Rotate keys",
      description: "We rotate the JWT signing key every 90 days; PR #25700 tracks the next rotation.",
    })

    expect(client.pages.updateMarkdown).toHaveBeenCalledWith({
      page_id: "new-task-id",
      type: "insert_content",
      insert_content: {
        content:
          "We rotate the JWT signing key every 90 days; PR #25700 tracks the next rotation.",
      },
    })
  })

  it("threads blocker into Blocked By column", async () => {
    const created = taskPage("new-task-id")
    const client = createMockClient({ createReturn: created })
    const service = new TaskService(client, DB)

    await service.create({
      subject: "Ship release",
      state: "blocked",
      blockedBy: "PR #25750 review",
    })

    const args = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(args.properties["Task State"]).toEqual({ select: { name: "blocked" } })
    expect(args.properties["Blocked By"]).toEqual({
      rich_text: [{ text: { content: "PR #25750 review" } }],
    })
  })

  it("maps dueDate onto Review By so overdue logic stays uniform", async () => {
    const created = taskPage("new-task-id")
    const client = createMockClient({ createReturn: created })
    const service = new TaskService(client, DB)

    await service.create({
      subject: "Audit",
      dueDate: "2026-05-01",
    })

    const args = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(args.properties["Review By"]).toEqual({
      date: { start: "2026-05-01" },
    })
  })

  it("forwards affectsIds for source-memory provenance", async () => {
    const created = taskPage("new-task-id")
    const client = createMockClient({ createReturn: created })
    const service = new TaskService(client, DB)

    await service.create({
      subject: "Migrate users",
      affectsIds: ["mem-1", "mem-2"],
    })

    const args = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(args.properties.Affects).toEqual({
      relation: [{ id: "mem-1" }, { id: "mem-2" }],
    })
  })
})

describe("TaskService.list", () => {
  it("filters to active states by default and excludes done/cancelled", async () => {
    const client = createMockClient()
    const service = new TaskService(client, DB)

    await service.list({ projectId: "p1" })

    const args = (client.dataSources.query as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // Three active states OR'd together so done/cancelled rows are
    // filtered server-side, not client-side.
    expect(JSON.stringify(args.filter)).toContain('"open"')
    expect(JSON.stringify(args.filter)).toContain('"in-progress"')
    expect(JSON.stringify(args.filter)).toContain('"blocked"')
    expect(JSON.stringify(args.filter)).not.toContain('"done"')
    expect(JSON.stringify(args.filter)).not.toContain('"cancelled"')
  })

  it("scopes by entity via rich_text contains on the Entity column", async () => {
    const client = createMockClient()
    const service = new TaskService(client, DB)

    await service.list({ entity: "PR #25700" })

    const args = (client.dataSources.query as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(JSON.stringify(args.filter)).toContain('"Entity"')
    expect(JSON.stringify(args.filter)).toContain('"PR #25700"')
  })

  it("strips body content from summaries (no retrieveMarkdown calls)", async () => {
    const client = createMockClient({
      queryResults: [taskPage("t1"), taskPage("t2")],
    })
    const service = new TaskService(client, DB)

    const { items } = await service.list({})

    expect(items).toHaveLength(2)
    // Index-tier listing — no markdown round-trips.
    expect(client.pages.retrieveMarkdown).not.toHaveBeenCalled()
    // Summaries deliberately omit `content`.
    for (const item of items) {
      expect((item as Record<string, unknown>).content).toBeUndefined()
    }
  })
})

describe("TaskService.close", () => {
  it("defaults to state=done when no explicit state passed", async () => {
    const client = createMockClient()
    const service = new TaskService(client, DB)

    await service.close("task-id")

    expect(client.pages.update).toHaveBeenCalledWith({
      page_id: "task-id",
      properties: { "Task State": { select: { name: "done" } } },
    })
  })

  it("supports cancelling — distinguished from done for metrics", async () => {
    const client = createMockClient()
    const service = new TaskService(client, DB)

    await service.close("task-id", "cancelled")

    expect(client.pages.update).toHaveBeenCalledWith({
      page_id: "task-id",
      properties: { "Task State": { select: { name: "cancelled" } } },
    })
  })
})

describe("TaskService.update", () => {
  it("clears the due date when dueDate is null", async () => {
    const updatedPage = taskPage("task-id", { state: "open" })
    const client = createMockClient({
      retrievedPages: { "task-id": updatedPage },
    })
    const service = new TaskService(client, DB)

    await service.update("task-id", { dueDate: null })

    const args = (client.pages.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(args.properties["Review By"]).toEqual({ date: null })
  })
})

describe("taskDaysOverdue", () => {
  it("returns null for done tasks even when reviewBy is in the past", () => {
    const result = taskDaysOverdue(
      { reviewBy: "2026-04-01", taskState: "done" },
      "2026-04-20"
    )
    // Closed work isn't overdue. Mirrors how the MCP tools render a
    // closed task without an urgency marker even if its review-by date
    // is in the past.
    expect(result).toBeNull()
  })

  it("returns 0 for due-today rows so they render as 'due today'", () => {
    const result = taskDaysOverdue(
      { reviewBy: "2026-04-20", taskState: "open" },
      "2026-04-20"
    )
    expect(result).toBe(0)
  })

  it("returns null for active tasks whose reviewBy is still in the future", () => {
    const result = taskDaysOverdue(
      { reviewBy: "2026-05-01", taskState: "in-progress" },
      "2026-04-20"
    )
    expect(result).toBeNull()
  })
})
