import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import {
  TaskCreatePartialFailureError,
  TaskUpdatePartialFailureError,
  TaskService,
  formatTaskSummary,
  isCleared,
  taskDaysOverdue,
  taskDaysStale,
  taskStats,
  todayUtc,
  type TaskStats,
} from "./task.js"
import { RICH_TEXT_PROPERTY_MAX_LEN } from "./rich-text-schema.js"
import { STALE_TASK_DAYS, SYNOPSIS_MAX } from "../types.js"
import type {
  CreateTaskInput,
  DatabaseRef,
  TaskState,
  UpdateTaskInput,
} from "../types.js"

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
    archived?: boolean
  }
): PageObjectResponse {
  return makePage({
    id,
    archived: overrides?.archived ?? false,
    properties: {
      Title: {
        type: "title",
        title: [{ plain_text: overrides?.title ?? `Task ${id}` }],
      } as unknown,
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

function archivedPage(page: PageObjectResponse): PageObjectResponse {
  return { ...page, archived: true }
}

interface MockClientOpts {
  retrievedPages?: Record<string, PageObjectResponse>
  queryResults?: PageObjectResponse[]
  createReturn?: PageObjectResponse
  createError?: unknown
  markdown?: string
  updateMarkdownError?: unknown
  updateError?: unknown
}

function createMockClient(opts: MockClientOpts = {}) {
  const defaultCreate = makePage({ id: "new-task-id" })
  return {
    pages: {
      create:
        opts.createError !== undefined
          ? vi.fn().mockRejectedValue(opts.createError)
          : vi.fn().mockResolvedValue(opts.createReturn ?? defaultCreate),
      retrieve: vi.fn().mockImplementation(({ page_id }: { page_id: string }) => {
        const page = opts.retrievedPages?.[page_id]
        if (!page)
          return Promise.reject(new Error(`Mock: no page registered for ${page_id}`))
        return Promise.resolve(page)
      }),
      update:
        opts.updateError !== undefined
          ? vi.fn().mockRejectedValue(opts.updateError)
          : vi.fn().mockResolvedValue({}),
      updateMarkdown:
        opts.updateMarkdownError !== undefined
          ? vi.fn().mockRejectedValue(opts.updateMarkdownError)
          : vi.fn().mockResolvedValue({}),
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
  type RichTextFieldCase = readonly [string, (value: string) => Partial<CreateTaskInput>]
  type RejectCase = readonly [string, Partial<CreateTaskInput>, number]

  const richTextFields: RichTextFieldCase[] = [
    ["alternatives", (value: string) => ({ alternatives: value })],
    ["consequences", (value: string) => ({ consequences: value })],
    ["author", (value: string) => ({ author: value })],
    ["agent", (value: string) => ({ agent: value })],
    ["keywords", (value: string) => ({ keywords: value })],
    ["session", (value: string) => ({ session: value })],
    ["blockedBy", (value: string) => ({ blockedBy: value })],
    ["entity", (value: string) => ({ entity: value })],
  ]
  const rejectCases: RejectCase[] = [
    ...richTextFields.map(
      ([field, buildInput]) =>
        [
          field,
          buildInput("x".repeat(RICH_TEXT_PROPERTY_MAX_LEN + 1)),
          RICH_TEXT_PROPERTY_MAX_LEN,
        ] as const
    ),
    ["synopsis", { synopsis: "x".repeat(SYNOPSIS_MAX + 1) }, SYNOPSIS_MAX],
  ]

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
    expect(client.pages.updateMarkdown).not.toHaveBeenCalled()
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("writes description as page body via updateMarkdown", async () => {
    const created = taskPage("new-task-id")
    const client = createMockClient({ createReturn: created })
    const service = new TaskService(client, DB)

    await service.create({
      subject: "Rotate keys",
      description:
        "We rotate the JWT signing key every 90 days; PR #25700 tracks the next rotation.",
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

  it("decodes doubly-encoded synopsis at the write boundary", async () => {
    // Through-path proof of the inline `decodeTextEntities` seam at
    // `task.ts:create`. Mirrors `keywords` / `blockedBy` decode coverage
    // — a future contributor dropping the wrapper has nothing else to
    // catch the regression.
    const created = taskPage("new-task-id")
    const client = createMockClient({ createReturn: created })
    const service = new TaskService(client, DB)

    await service.create({
      subject: "Rotate keys",
      synopsis: "Foo &amp;amp; Bar",
    })

    const args = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(args.properties.Synopsis).toEqual({
      rich_text: [{ text: { content: "Foo & Bar" } }],
    })
  })

  it.each(rejectCases)(
    "rejects over-cap %s before creating a Notion page",
    async (field, input, cap) => {
      const client = createMockClient()
      const service = new TaskService(client, DB)

      await expect(
        service.create({
          subject: "Keep metadata capped",
          ...input,
        })
      ).rejects.toThrow(new RegExp(`TaskService\\.create.*${field}.*${cap}`))

      expect(client.pages.create).not.toHaveBeenCalled()
      expect(client.pages.updateMarkdown).not.toHaveBeenCalled()
    }
  )

  it("archives the created task and throws a structured error when description write fails", async () => {
    const created = taskPage("new-task-id")
    const bodyWriteError = new Error("markdown unavailable")
    const client = createMockClient({
      createReturn: created,
      updateMarkdownError: bodyWriteError,
    })
    const service = new TaskService(client, DB)

    let caught: unknown
    try {
      await service.create({
        subject: "Rotate keys",
        description: "Rotate the JWT signing key.",
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(TaskCreatePartialFailureError)
    const partial = caught as TaskCreatePartialFailureError
    expect(partial.pageId).toBe("new-task-id")
    expect(partial.cleanedUp).toBe(true)
    expect(partial.bodyWriteError).toBe(bodyWriteError)
    expect(partial.cleanupError).toBeUndefined()
    expect(partial.message).toContain("retry the create")
    expect(partial.message).toMatch(/archived to keep the vault consistent/)
    expect(client.pages.update).toHaveBeenCalledWith({
      page_id: "new-task-id",
      archived: true,
    })
  })

  it("carries cleanup failure details when archiving the partial task fails", async () => {
    const created = taskPage("new-task-id")
    const bodyWriteError = new Error("markdown unavailable")
    const cleanupError = new Error("archive unavailable")
    const client = createMockClient({
      createReturn: created,
      updateMarkdownError: bodyWriteError,
      updateError: cleanupError,
    })
    const service = new TaskService(client, DB)

    let caught: unknown
    try {
      await service.create({
        subject: "Rotate keys",
        description: "Rotate the JWT signing key.",
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(TaskCreatePartialFailureError)
    const partial = caught as TaskCreatePartialFailureError
    expect(partial.pageId).toBe("new-task-id")
    expect(partial.cleanedUp).toBe(false)
    expect(partial.bodyWriteError).toBe(bodyWriteError)
    expect(partial.cleanupError).toBe(cleanupError)
    expect(partial.message).toContain("Archive it manually before retrying")
    expect(client.pages.update).toHaveBeenCalledWith({
      page_id: "new-task-id",
      archived: true,
    })
  })

  it("pages.create rejection bubbles untouched with no cleanup or description write", async () => {
    const createError = new Error("create unavailable")
    const client = createMockClient({ createError })
    const service = new TaskService(client, DB)

    await expect(
      service.create({
        subject: "Rotate keys",
        description: "Rotate the JWT signing key.",
      })
    ).rejects.toBe(createError)
    expect(client.pages.updateMarkdown).not.toHaveBeenCalled()
    expect(client.pages.update).not.toHaveBeenCalled()
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

  it("scopes by a single entity variant as a flat rich_text contains clause", async () => {
    const client = createMockClient()
    const service = new TaskService(client, DB)

    await service.list({ entities: ["PR #25700"] })

    const args = (client.dataSources.query as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const filter = JSON.stringify(args.filter)
    expect(filter).toContain('"Entity"')
    expect(filter).toContain('"PR #25700"')
    // Single-variant inputs collapse to a flat clause — no `or` group
    // in the entity slot, so the filter shape matches the pre-PF4
    // single-string contract Notion saw on legacy callers.
    expect(filter).not.toMatch(/"or":\s*\[[^\]]*"Entity"/)
  })

  it("ORs multiple variants over the Entity column for alias-aware recall", async () => {
    const client = createMockClient()
    const service = new TaskService(client, DB)

    await service.list({ entities: ["AuthService", "AuthSvc", "auth-service"] })

    const args = (client.dataSources.query as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const filter = JSON.stringify(args.filter)
    // Each variant lands as its own `Entity rich_text contains` clause
    // so a task whose Entity column stores any one of the aliases
    // surfaces in the response.
    expect(filter).toContain('"AuthService"')
    expect(filter).toContain('"AuthSvc"')
    expect(filter).toContain('"auth-service"')
    // The clauses compose under a single `or` group so Notion handles
    // the union server-side rather than the caller paginating over
    // each variant individually.
    expect(filter).toMatch(/"or":\s*\[/)
  })

  it("omits the entity filter when entities is empty (no spurious vault-wide narrowing)", async () => {
    const client = createMockClient()
    const service = new TaskService(client, DB)

    await service.list({ entities: [] })

    const args = (client.dataSources.query as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(JSON.stringify(args.filter)).not.toContain('"Entity"')
  })

  it("filters to tasks due after a date or without a due date", async () => {
    const client = createMockClient()
    const service = new TaskService(client, DB)

    await service.list({ dueAfterOrEmpty: "2026-04-20" })

    const args = (client.dataSources.query as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const filter = JSON.stringify(args.filter)
    expect(filter).toContain('"Review By"')
    expect(filter).toContain('"is_empty":true')
    expect(filter).toContain('"after":"2026-04-20"')
  })

  it("can sort by oldest last-edited time for stale-task wake-up loading", async () => {
    const client = createMockClient()
    const service = new TaskService(client, DB)

    await service.list({ sortBy: "updatedAtAsc" })

    const args = (client.dataSources.query as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(args.sorts[0]).toEqual({
      timestamp: "last_edited_time",
      direction: "ascending",
    })
  })

  it("can sort by newest last-edited time for active-task wake-up loading", async () => {
    const client = createMockClient()
    const service = new TaskService(client, DB)

    await service.list({ sortBy: "updatedAtDesc" })

    const args = (client.dataSources.query as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(args.sorts[0]).toEqual({
      timestamp: "last_edited_time",
      direction: "descending",
    })
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

  it("excludes archived task pages from list results", async () => {
    const client = createMockClient({
      queryResults: [
        archivedPage(taskPage("archived-task", { title: "Archived task" })),
        taskPage("live-task", { title: "Live task" }),
      ],
    })
    const service = new TaskService(client, DB)

    const { items } = await service.list({})

    expect(items.map((item) => item.id)).toEqual(["live-task"])
  })

  it("filters archived rows and refills the requested limit across pages", async () => {
    const client = createMockClient()
    const query = client.dataSources.query as ReturnType<typeof vi.fn>
    query.mockReset()
    query
      .mockResolvedValueOnce({
        results: [
          taskPage("archived-before", { archived: true }),
          taskPage("live-1"),
          taskPage("archived-between", { archived: true }),
        ],
        has_more: true,
        next_cursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        results: [taskPage("live-2"), taskPage("archived-after", { archived: true })],
        has_more: true,
        next_cursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        results: [taskPage("live-3")],
        has_more: false,
        next_cursor: null,
      })
    const service = new TaskService(client, DB)

    const { items, nextCursor } = await service.list({ limit: 3 })

    expect(items.map((item) => item.id)).toEqual(["live-1", "live-2", "live-3"])
    expect(nextCursor).toBeUndefined()
    expect(query).toHaveBeenCalledTimes(3)
    expect(query.mock.calls[1]![0].start_cursor).toBe("cursor-1")
    expect(query.mock.calls[2]![0].start_cursor).toBe("cursor-2")
    expect(query.mock.calls[0]![0].page_size).toBe(100)
    expect(query.mock.calls[1]![0].page_size).toBe(100)
    expect(query.mock.calls[2]![0].page_size).toBe(100)
  })

  it("returns an opaque refill cursor instead of skipping live rows from a partially consumed page", async () => {
    const client = createMockClient()
    const query = client.dataSources.query as ReturnType<typeof vi.fn>
    query.mockReset()
    query.mockImplementation(({ start_cursor }: { start_cursor?: string }) => {
      if (start_cursor === undefined) {
        return Promise.resolve({
          results: [
            taskPage("live-1"),
            taskPage("live-2"),
            taskPage("live-3"),
            taskPage("live-4"),
          ],
          has_more: true,
          next_cursor: "notion-cursor-after-current-page",
        })
      }
      return Promise.resolve({
        results: [taskPage("live-5")],
        has_more: false,
        next_cursor: null,
      })
    })
    const service = new TaskService(client, DB)

    const first = await service.list({ limit: 2 })
    const second = await service.list({
      limit: 2,
      startCursor: first.nextCursor,
    })

    expect(first.items.map((item) => item.id)).toEqual(["live-1", "live-2"])
    expect(first.nextCursor).toBeDefined()
    expect(first.nextCursor).not.toBe("notion-cursor-after-current-page")
    expect(second.items.map((item) => item.id)).toEqual(["live-3", "live-4"])
    expect(second.nextCursor).toBe("notion-cursor-after-current-page")
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1]![0].start_cursor).toBeUndefined()
  })
})

describe("TaskService.close", () => {
  it("defaults to state=done when no explicit state passed and stamps Done At in the same atom", async () => {
    const client = createMockClient()
    const service = new TaskService(client, DB)

    await service.close("task-id")

    const args = (client.pages.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(args.page_id).toBe("task-id")
    expect(args.properties["Task State"]).toEqual({ select: { name: "done" } })
    // YYYY-MM-DD only — pinned so a future change to ISO timestamps would
    // surface here rather than silently feeding a non-date-typed value
    // into Notion's `date` column.
    expect(args.properties["Done At"]).toEqual({
      date: { start: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
    })
  })

  it("supports cancelling — distinguished from done for metrics — and stamps Done At", async () => {
    const client = createMockClient()
    const service = new TaskService(client, DB)

    await service.close("task-id", "cancelled")

    const args = (client.pages.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(args.properties["Task State"]).toEqual({ select: { name: "cancelled" } })
    expect(args.properties["Done At"]).toEqual({
      date: { start: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
    })
  })

  it("byte-identical Done At shapes for `close` and `update({ state: 'done' })` on the same wall-clock day", async () => {
    // The two write paths converge on one on-disk shape so closure-rate
    // metrics don't have to know which API the caller used.
    const closeClient = createMockClient()
    const closeService = new TaskService(closeClient, DB)
    await closeService.close("via-close")

    const updateClient = createMockClient({
      retrievedPages: { "via-update": taskPage("via-update", { state: "done" }) },
    })
    const updateService = new TaskService(updateClient, DB)
    await updateService.update("via-update", { state: "done" })

    const closeArgs = (closeClient.pages.update as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
    const updateArgs = (updateClient.pages.update as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
    expect(closeArgs.properties["Done At"]).toEqual(updateArgs.properties["Done At"])
  })

  it("is idempotent: a second close overwrites Done At with today (last-close-wins)", async () => {
    const client = createMockClient()
    const service = new TaskService(client, DB)

    await service.close("task-id")
    await service.close("task-id")

    // Two calls, same shape — both stamp Done At to today; the second
    // overwrites the first, matching `Task State`'s last-write-wins
    // posture under contention.
    expect(client.pages.update).toHaveBeenCalledTimes(2)
    const first = (client.pages.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const second = (client.pages.update as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(first.properties["Done At"]).toEqual(second.properties["Done At"])
  })
})

describe("TaskService.update", () => {
  type RichTextFieldCase = readonly [string, (value: string) => UpdateTaskInput]
  type RejectCase = readonly [string, UpdateTaskInput, number]

  const richTextFields: RichTextFieldCase[] = [
    ["blockedBy", (value: string) => ({ blockedBy: value })],
    ["entity", (value: string) => ({ entity: value })],
    ["keywords", (value: string) => ({ keywords: value })],
  ]
  const rejectCases: RejectCase[] = [
    ...richTextFields.map(
      ([field, buildInput]) =>
        [
          field,
          buildInput("x".repeat(RICH_TEXT_PROPERTY_MAX_LEN + 1)),
          RICH_TEXT_PROPERTY_MAX_LEN,
        ] as const
    ),
    ["synopsis", { synopsis: "x".repeat(SYNOPSIS_MAX + 1) }, SYNOPSIS_MAX],
  ]

  it("throws a structured partial-failure error when properties land but description write fails", async () => {
    const bodyWriteError = new Error("notion 503")
    const client = createMockClient({ updateMarkdownError: bodyWriteError })
    const service = new TaskService(client, DB)

    let caught: unknown
    try {
      await service.update("task-id", {
        state: "in-progress",
        description: "Updated description",
      })
    } catch (err) {
      caught = err
    }

    expect(client.pages.update).toHaveBeenCalledTimes(1)
    expect(client.pages.updateMarkdown).toHaveBeenCalledTimes(1)
    expect(
      (client.pages.update as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    ).toBeLessThan(
      (client.pages.updateMarkdown as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0]
    )
    expect(client.pages.retrieve).not.toHaveBeenCalled()
    expect(client.pages.retrieveMarkdown).not.toHaveBeenCalled()
    expect(caught).toBeInstanceOf(TaskUpdatePartialFailureError)
    const partial = caught as TaskUpdatePartialFailureError
    expect(partial.taskId).toBe("task-id")
    expect(partial.failedPhase).toBe("body")
    expect(partial.persisted).toEqual({ properties: true, body: false })
    expect(partial.bodyWriteError).toBe(bodyWriteError)
    expect(partial.message).toContain("properties for task task-id persisted")
    expect(partial.message).toContain('phase "body"')
    expect(partial.message).toContain("description body was not written")
  })

  it("does not wrap description-only failures because no earlier update persisted", async () => {
    const bodyWriteError = new Error("notion 503")
    const client = createMockClient({ updateMarkdownError: bodyWriteError })
    const service = new TaskService(client, DB)

    await expect(
      service.update("task-id", { description: "Updated description" })
    ).rejects.toBe(bodyWriteError)
    expect(client.pages.update).not.toHaveBeenCalled()
    expect(client.pages.updateMarkdown).toHaveBeenCalledTimes(1)
  })

  it("includes non-Error description-write rejections in the structured message", async () => {
    const bodyWriteError = "notion string failure"
    const client = createMockClient({ updateMarkdownError: bodyWriteError })
    const service = new TaskService(client, DB)

    let caught: unknown
    try {
      await service.update("task-id", {
        state: "in-progress",
        description: "Updated description",
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(TaskUpdatePartialFailureError)
    const partial = caught as TaskUpdatePartialFailureError
    expect(partial.bodyWriteError).toBe(bodyWriteError)
    expect(partial.message).toContain("notion string failure")
  })

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

  it("stamps Done At when transitioning to state='done' so update-to-terminal matches close()", async () => {
    const updatedPage = taskPage("task-id", { state: "done" })
    const client = createMockClient({
      retrievedPages: { "task-id": updatedPage },
    })
    const service = new TaskService(client, DB)

    await service.update("task-id", { state: "done" })

    const args = (client.pages.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(args.properties["Task State"]).toEqual({ select: { name: "done" } })
    expect(args.properties["Done At"]).toEqual({
      date: { start: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
    })
  })

  it("stamps Done At when transitioning to state='cancelled'", async () => {
    const updatedPage = taskPage("task-id", { state: "cancelled" })
    const client = createMockClient({
      retrievedPages: { "task-id": updatedPage },
    })
    const service = new TaskService(client, DB)

    await service.update("task-id", { state: "cancelled" })

    const args = (client.pages.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(args.properties["Task State"]).toEqual({ select: { name: "cancelled" } })
    expect(args.properties["Done At"]).toEqual({
      date: { start: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
    })
  })

  it("does NOT touch Done At on a re-open (state='open') — preserved as historical fact", async () => {
    const updatedPage = taskPage("task-id", { state: "open" })
    const client = createMockClient({
      retrievedPages: { "task-id": updatedPage },
    })
    const service = new TaskService(client, DB)

    await service.update("task-id", { state: "open" })

    const args = (client.pages.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(args.properties["Task State"]).toEqual({ select: { name: "open" } })
    // Re-open is "the most recent close timestamp" preserved — the
    // column tracks history, not the active close moment. Same posture
    // for `in-progress` / `blocked` non-terminal transitions.
    expect(args.properties["Done At"]).toBeUndefined()
  })

  it("does NOT touch Done At on non-terminal transitions like state='in-progress'", async () => {
    const updatedPage = taskPage("task-id", { state: "in-progress" })
    const client = createMockClient({
      retrievedPages: { "task-id": updatedPage },
    })
    const service = new TaskService(client, DB)

    await service.update("task-id", { state: "in-progress" })

    const args = (client.pages.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(args.properties["Done At"]).toBeUndefined()
  })

  it("decodes doubly-encoded synopsis at the write boundary", async () => {
    // Through-path proof of the direct `decodeTextEntities` call inside
    // the `props["Synopsis"]` emission (rather than inside a helper).
    const updatedPage = taskPage("task-id", { state: "open" })
    const client = createMockClient({
      retrievedPages: { "task-id": updatedPage },
    })
    const service = new TaskService(client, DB)

    await service.update("task-id", { synopsis: "Foo &amp;amp; Bar" })

    const args = (client.pages.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(args.properties.Synopsis).toEqual({
      rich_text: [{ text: { content: "Foo & Bar" } }],
    })
  })

  it("emits empty Synopsis rich_text on synopsis: '' to clear the column", async () => {
    // Sibling-text-field shape: empty string clears, undefined leaves
    // untouched. Pin the `!== undefined` guard at the property emission
    // so the alternative (`isCleared`) regression is detectable.
    const updatedPage = taskPage("task-id", { state: "open" })
    const client = createMockClient({
      retrievedPages: { "task-id": updatedPage },
    })
    const service = new TaskService(client, DB)

    await service.update("task-id", { synopsis: "" })

    const args = (client.pages.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(args.properties.Synopsis).toEqual({
      rich_text: [{ text: { content: "" } }],
    })
  })

  it("does NOT emit Synopsis when synopsis is omitted (leave-untouched)", async () => {
    const updatedPage = taskPage("task-id", { state: "open" })
    const client = createMockClient({
      retrievedPages: { "task-id": updatedPage },
    })
    const service = new TaskService(client, DB)

    await service.update("task-id", { state: "in-progress" })

    const args = (client.pages.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(args.properties.Synopsis).toBeUndefined()
  })

  it.each(rejectCases)(
    "rejects over-cap %s before any Notion write",
    async (field, input, cap) => {
      const client = createMockClient()
      const service = new TaskService(client, DB)

      await expect(service.update("task-id", input)).rejects.toThrow(
        new RegExp(`TaskService\\.update.*${field}.*${cap}`)
      )

      expect(client.pages.update).not.toHaveBeenCalled()
      expect(client.pages.retrieve).not.toHaveBeenCalled()
      expect(client.pages.retrieveMarkdown).not.toHaveBeenCalled()
    }
  )
})

describe("isCleared — empty-string-means-absence rule", () => {
  it("treats null as cleared (caller asked to clear)", () => {
    expect(isCleared(null)).toBe(true)
  })

  it("treats empty string and whitespace-only as cleared (Zod still rejects whitespace, but core stays defensive)", () => {
    expect(isCleared("")).toBe(true)
    expect(isCleared("   ")).toBe(true)
    expect(isCleared("\t\n")).toBe(true)
  })

  it("returns false for undefined — undefined means 'don't touch', which is distinct from clear", () => {
    // Callers filter `undefined` BEFORE invoking isCleared (see the
    // dueDate update path), so this distinction never collapses
    // semantics in practice. Pinned anyway so a future refactor
    // doesn't accidentally treat undefined as cleared and start
    // wiping fields the caller never asked to touch.
    expect(isCleared(undefined)).toBe(false)
  })

  it("treats non-empty content as not-cleared", () => {
    expect(isCleared("PR #25750")).toBe(false)
    expect(isCleared("2026-05-01")).toBe(false)
    expect(isCleared("a")).toBe(false)
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

describe("taskDaysStale", () => {
  it("returns days since updatedAt for active tasks", () => {
    const result = taskDaysStale(
      { updatedAt: "2026-03-01T00:00:00Z", taskState: "open" },
      "2026-04-20"
    )
    // 50 days from 2026-03-01 → 2026-04-20.
    expect(result).toBe(50)
  })

  it("returns 0 for active tasks edited today (no staleness yet)", () => {
    // `T23:59:59Z` is the rigorous upper-edge same-day timestamp:
    // a raw-timestamp diff against `today` (parsed as UTC midnight)
    // yields `-1` and a pre-fix implementation would silently pull
    // the row out of the Stale bucket. The calendar-day truncation
    // in `taskDaysStale` makes both the noon and the end-of-day
    // case resolve to `0`; pinning the harder case here ensures the
    // truncation can't regress without the test catching it.
    const result = taskDaysStale(
      { updatedAt: "2026-04-20T23:59:59Z", taskState: "in-progress" },
      "2026-04-20"
    )
    expect(result).toBe(0)
  })

  it("returns null for done tasks", () => {
    // Closed work isn't "stale", it's "done" — bucketing must not
    // resurface a done task in the Stale section just because it was
    // edited a long time ago.
    const result = taskDaysStale(
      { updatedAt: "2026-01-01T00:00:00Z", taskState: "done" },
      "2026-04-20"
    )
    expect(result).toBeNull()
  })

  it("returns null for cancelled tasks", () => {
    const result = taskDaysStale(
      { updatedAt: "2026-01-01T00:00:00Z", taskState: "cancelled" },
      "2026-04-20"
    )
    expect(result).toBeNull()
  })

  it("returns null when updatedAt is missing", () => {
    // The field comes off Notion's `last_edited_time` which is always
    // populated for live pages; missing only on synthetic / partially-
    // initialized objects, where the staleness check should no-op
    // rather than crash on `new Date("")`.
    const result = taskDaysStale({ updatedAt: "", taskState: "open" }, "2026-04-20")
    expect(result).toBeNull()
  })

  it("returns null for terminal-state tasks regardless of how old they are", () => {
    // Closed work isn't "stale" — it's done. Mirrors how `taskDaysOverdue`
    // suppresses urgency markers on done/cancelled rows.
    expect(
      taskDaysStale(
        { updatedAt: "2026-01-01T00:00:00.000Z", taskState: "done" },
        "2026-04-28"
      )
    ).toBeNull()
    expect(
      taskDaysStale(
        { updatedAt: "2026-01-01T00:00:00.000Z", taskState: "cancelled" },
        "2026-04-28"
      )
    ).toBeNull()
  })

  it("returns the day-count delta against `today` for active tasks", () => {
    expect(
      taskDaysStale(
        { updatedAt: "2026-04-01T00:00:00.000Z", taskState: "open" },
        "2026-05-01"
      )
    ).toBe(30)
  })

  it("returns 0 for a task touched today (not yet stale)", () => {
    expect(
      taskDaysStale(
        { updatedAt: "2026-04-28T00:00:00.000Z", taskState: "in-progress" },
        "2026-04-28"
      )
    ).toBe(0)
  })

  it("returns null when updatedAt is missing", () => {
    expect(taskDaysStale({ updatedAt: "", taskState: "open" }, "2026-04-28")).toBeNull()
  })

  it("computes calendar-day diffs regardless of `updatedAt` time-of-day", () => {
    // `last_edited_time` is a full ISO timestamp with arbitrary
    // time-of-day; `today` is a calendar day at UTC midnight.
    // Comparing the raw timestamps would let the time component
    // skew the diff: `2026-04-20T12:00:00Z` is 0.5d before
    // `2026-04-20T00:00:00Z` if you go raw, so `Math.floor(-0.5d)`
    // returns `-1`. Truncating `updatedAt` to the calendar-day
    // prefix produces the whole-day count operators expect, and
    // makes the helper signature match PR #129's spec
    // (`taskDaysStale(updatedAt: "2026-04-20T12:00:00Z", today:
    // "2026-04-20") === 0`).
    expect(
      taskDaysStale(
        { updatedAt: "2026-04-20T12:00:00Z", taskState: "open" },
        "2026-04-20"
      )
    ).toBe(0)
    // 30 days, 1 hour ago must register as the full 30 days, not 29.
    // A pre-fix implementation returns `Math.floor(29.96) = 29` here
    // and the row silently undercounts in the stale bucket.
    expect(
      taskDaysStale(
        { updatedAt: "2026-03-29T01:00:00Z", taskState: "open" },
        "2026-04-28"
      )
    ).toBe(30)
    // Time-of-day later than the today anchor still resolves to the
    // calendar-day diff — a raw-timestamp diff would produce `-1`
    // here and silently pull the row out of the stale bucket.
    expect(
      taskDaysStale(
        { updatedAt: "2026-04-20T23:59:59Z", taskState: "open" },
        "2026-04-20"
      )
    ).toBe(0)
  })
})

describe("TaskService.queryOverdue", () => {
  it("paginates beyond the first 100 rows when no limit is supplied", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      taskPage(`t1-${i}`, { reviewBy: "2026-01-01" })
    )
    const page2 = Array.from({ length: 50 }, (_, i) =>
      taskPage(`t2-${i}`, { reviewBy: "2026-02-01" })
    )
    const client = createMockClient()
    const querySpy = client.dataSources.query as ReturnType<typeof vi.fn>
    const responses = [
      { results: page1, has_more: true, next_cursor: "c1" },
      { results: page2, has_more: false, next_cursor: null },
    ]
    let i = 0
    querySpy.mockImplementation(() => {
      const response = responses[Math.min(i, responses.length - 1)]
      i += 1
      return Promise.resolve(response)
    })
    const service = new TaskService(client, DB)

    const results = await service.queryOverdue()

    expect(querySpy).toHaveBeenCalledTimes(2)
    expect(results).toHaveLength(150)
    expect(querySpy.mock.calls[1][0]).toMatchObject({ start_cursor: "c1" })
  })

  it("stops paginating once the limit is reached", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      taskPage(`t-${i}`, { reviewBy: "2026-01-01" })
    )
    const client = createMockClient()
    const querySpy = client.dataSources.query as ReturnType<typeof vi.fn>
    querySpy.mockResolvedValue({
      results: page1,
      has_more: true,
      next_cursor: "c1",
    })
    const service = new TaskService(client, DB)

    const results = await service.queryOverdue({ limit: 10 })

    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(results).toHaveLength(10)
  })

  it("skips archived pages returned by the data source query", async () => {
    const archived = {
      ...taskPage("t-archived", { reviewBy: "2026-01-01" }),
      archived: true,
    } as PageObjectResponse
    const live = taskPage("t-live", { reviewBy: "2026-01-02" })
    const client = createMockClient({
      queryResults: [archived, live],
    })
    const service = new TaskService(client, DB)

    const results = await service.queryOverdue()

    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("t-live")
  })

  it("uses page_size 100 even when limit is small", async () => {
    const client = createMockClient()
    const service = new TaskService(client, DB)

    await service.queryOverdue({ limit: 5 })

    const queryArgs = (client.dataSources.query as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
    expect(queryArgs.page_size).toBe(100)
  })

  it("clamps page_size to Notion's 100-row ceiling when no limit is supplied", async () => {
    const client = createMockClient()
    const service = new TaskService(client, DB)

    await service.queryOverdue()

    const queryArgs = (client.dataSources.query as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
    expect(queryArgs.page_size).toBe(100)
  })

  it("clamps page_size to 100 when limit exceeds Notion's ceiling", async () => {
    const client = createMockClient()
    const service = new TaskService(client, DB)

    await service.queryOverdue({ limit: 500 })

    const queryArgs = (client.dataSources.query as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
    expect(queryArgs.page_size).toBe(100)
  })
})

describe("TaskService.countActive", () => {
  it("buckets each active row into total/overdue/stale/in-progress/blocked", async () => {
    // Three rows: one overdue, one stale (>30d untouched, no due), one
    // in-progress (fresh). Pinning every counter on the same call
    // proves the bucketing is mutually consistent — overdue and stale
    // can co-exist on different rows but the same row can't double-count
    // (the `else` branch on the stale check makes overdue strictly
    // dominant per row).
    const overduePage: PageObjectResponse = makePage({
      id: "t-overdue",
      created_time: "2026-04-20T00:00:00.000Z",
      last_edited_time: "2026-04-25T00:00:00.000Z",
      properties: {
        Title: { type: "title", title: [{ plain_text: "Overdue task" }] } as unknown,
        Kind: { type: "select", select: { name: "task" } } as unknown,
        "Task State": { type: "select", select: { name: "open" } } as unknown,
        "Review By": { type: "date", date: { start: "2026-04-01" } } as unknown,
        "Blocked By": { type: "rich_text", rich_text: [] } as unknown,
        Entity: { type: "rich_text", rich_text: [] } as unknown,
      } as PageObjectResponse["properties"],
    })
    const stalePage: PageObjectResponse = makePage({
      id: "t-stale",
      created_time: "2026-01-01T00:00:00.000Z",
      // 90 days before 2026-04-28 → past the 30-day stale threshold.
      last_edited_time: "2026-01-28T00:00:00.000Z",
      properties: {
        Title: { type: "title", title: [{ plain_text: "Stale task" }] } as unknown,
        Kind: { type: "select", select: { name: "task" } } as unknown,
        "Task State": { type: "select", select: { name: "blocked" } } as unknown,
        "Blocked By": {
          type: "rich_text",
          rich_text: [{ plain_text: "PR #25700" }],
        } as unknown,
        Entity: { type: "rich_text", rich_text: [] } as unknown,
      } as PageObjectResponse["properties"],
    })
    const inProgressPage: PageObjectResponse = makePage({
      id: "t-fresh",
      created_time: "2026-04-25T00:00:00.000Z",
      last_edited_time: "2026-04-27T00:00:00.000Z",
      properties: {
        Title: { type: "title", title: [{ plain_text: "Fresh task" }] } as unknown,
        Kind: { type: "select", select: { name: "task" } } as unknown,
        "Task State": {
          type: "select",
          select: { name: "in-progress" },
        } as unknown,
        "Blocked By": { type: "rich_text", rich_text: [] } as unknown,
        Entity: { type: "rich_text", rich_text: [] } as unknown,
      } as PageObjectResponse["properties"],
    })
    const client = createMockClient({
      queryResults: [overduePage, stalePage, inProgressPage],
    })
    const service = new TaskService(client, DB)

    const stats = await service.countActive({ today: "2026-04-28" })

    expect(stats.total).toBe(3)
    expect(stats.overdue).toBe(1)
    expect(stats.stale).toBe(1)
    expect(stats.inProgress).toBe(1)
    expect(stats.blocked).toBe(1)
  })

  it("walks pagination to exhaustion (multi-page result)", async () => {
    // Two pages: first returns has_more, second has no cursor. Pin
    // pagination so a future change to `list({ startCursor })` doesn't
    // silently turn the count into "first page only."
    const page1 = taskPage("t1", { state: "open" })
    const page2 = taskPage("t2", { state: "open" })
    const dataSourceQuery = vi
      .fn()
      .mockResolvedValueOnce({
        results: [page1],
        has_more: true,
        next_cursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        results: [page2],
        has_more: false,
        next_cursor: null,
      })
    const client = {
      pages: {
        retrieve: vi.fn(),
        retrieveMarkdown: vi.fn(),
        update: vi.fn(),
        create: vi.fn(),
        updateMarkdown: vi.fn(),
      },
      dataSources: { query: dataSourceQuery },
    } as unknown as Client
    const service = new TaskService(client, DB)

    const stats = await service.countActive({ today: "2026-04-28" })

    expect(stats.total).toBe(2)
    expect(dataSourceQuery).toHaveBeenCalledTimes(2)
    expect(
      (dataSourceQuery.mock.calls[1]![0] as { start_cursor?: string }).start_cursor
    ).toBe("cursor-1")
  })

  it("scopes by projectId via the same OR-with-unscoped clause as TaskService.list", async () => {
    const client = createMockClient()
    const service = new TaskService(client, DB)

    await service.countActive({ projectId: "proj-mail", today: "2026-04-28" })

    const args = (client.dataSources.query as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const filter = JSON.stringify(args.filter)
    expect(filter).toContain("proj-mail")
    // Active states drive the filter — done/cancelled rows are excluded
    // server-side so the count never sees closed work.
    expect(filter).toContain('"open"')
    expect(filter).toContain('"in-progress"')
    expect(filter).toContain('"blocked"')
    expect(filter).not.toContain('"done"')
    expect(filter).not.toContain('"cancelled"')
  })

  it("rejects malformed `today` with a clear RangeError before issuing any Notion query", async () => {
    // Defense-in-depth at the public service boundary. Without the
    // guard, a malformed `today` would silently zero every bucket:
    // `new Date(NaN)` flows through both bucket helpers as `NaN`,
    // every comparison against `NaN` is `false`, and the response
    // claims "no overdue, no stale, no anything" without ever
    // surfacing the input mistake. `taskStats` (the typical caller)
    // already validates; `countActive` is public and a direct caller
    // bypassing the orchestrator must see the same error shape.
    const client = createMockClient()
    const service = new TaskService(client, DB)

    await expect(service.countActive({ today: "not-a-date" })).rejects.toThrow(
      /invalid today value "not-a-date"/i
    )
    // The Notion query must NOT have fired — validation runs before
    // the paginated walk.
    expect(client.dataSources.query).not.toHaveBeenCalled()
  })
})

describe("TaskService.countClosedSince", () => {
  it("returns the row count when Done At exists on the data source", async () => {
    const client = createMockClient({
      queryResults: [
        taskPage("c1", { state: "done" }),
        taskPage("c2", { state: "cancelled" }),
        taskPage("c3", { state: "done" }),
      ],
    })
    const service = new TaskService(client, DB)

    const total = await service.countClosedSince("2026-03-30")
    expect(total).toBe(3)

    const args = (client.dataSources.query as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // `Done At on_or_after` is inclusive on the lower bound and
    // matches rows whose `Done At` is on or before today; combined,
    // `today - 29 days` produces the 30-day inclusive window the
    // `Closed last 30 days` label promises.
    expect(JSON.stringify(args.filter)).toContain(
      '"Done At","date":{"on_or_after":"2026-03-30"}'
    )
  })

  it("excludes archived task pages from the closed-since count", async () => {
    const client = createMockClient({
      queryResults: [
        archivedPage(taskPage("archived-closed", { state: "done" })),
        taskPage("live-closed", { state: "done" }),
      ],
    })
    const service = new TaskService(client, DB)

    const total = await service.countClosedSince("2026-03-30")

    expect(total).toBe(1)
  })

  it("excludes re-opened tasks via a Task State in (done, cancelled) filter", async () => {
    // `Done At` is preserved across re-open by design — `update({
    // state: 'open' })` keeps the prior closure timestamp as
    // historical fact. Without the terminal-state guard, a row closed
    // on day -1 then re-opened today would still match the filter and
    // double-count as a closure. Pin the guard so a future change to
    // the date filter can't silently drop the state filter and
    // regress the rate metric.
    const client = createMockClient()
    const service = new TaskService(client, DB)

    await service.countClosedSince("2026-03-30")

    const args = (client.dataSources.query as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const filter = JSON.stringify(args.filter)
    // Both terminal states must appear under an `or` group — the
    // filter pins "currently-closed" not "ever-closed."
    expect(filter).toContain('"Task State","select":{"equals":"done"}')
    expect(filter).toContain('"Task State","select":{"equals":"cancelled"}')
    // Active states must NOT appear in the filter — they belong to
    // `countActive`, not `countClosedSince`.
    expect(filter).not.toContain('"Task State","select":{"equals":"open"}')
    expect(filter).not.toContain('"Task State","select":{"equals":"in-progress"}')
    expect(filter).not.toContain('"Task State","select":{"equals":"blocked"}')
  })

  it("does not count archived terminal tasks as closed", async () => {
    const client = createMockClient({
      queryResults: [
        taskPage("closed-live", { state: "done" }),
        taskPage("closed-archived", { state: "done", archived: true }),
      ],
    })
    const service = new TaskService(client, DB)

    const total = await service.countClosedSince("2026-03-30")

    expect(total).toBe(1)
  })

  it("returns null when the column doesn't exist (pre-#07 vault)", async () => {
    // Notion raises a `validation_error` whose message names the
    // missing property; `isMissingPropertyError` matches it and the
    // method falls through to `null` so the renderer can suppress the
    // closure-rate line entirely.
    const dataSourceQuery = vi.fn().mockRejectedValue(
      Object.assign(new Error("Could not find property with name or id: Done At"), {
        code: "validation_error",
      })
    )
    const client = {
      pages: {},
      dataSources: { query: dataSourceQuery },
    } as unknown as Client
    const service = new TaskService(client, DB)

    const total = await service.countClosedSince("2026-03-30")
    expect(total).toBeNull()
  })

  it("re-throws unrelated Notion errors instead of swallowing them as null", async () => {
    // A genuinely-malformed filter shape, a 5xx, or a rate-limit error
    // must propagate so the caller surfaces the failure rather than
    // showing "no closures" to the operator while the vault is
    // actually broken.
    const dataSourceQuery = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("Internal server error"), {
          code: "internal_server_error",
        })
      )
    const client = {
      pages: {},
      dataSources: { query: dataSourceQuery },
    } as unknown as Client
    const service = new TaskService(client, DB)

    await expect(service.countClosedSince("2026-03-30")).rejects.toThrow(
      /Internal server error/
    )
  })

  it("scopes the closed-since query by projectId when provided", async () => {
    const client = createMockClient()
    const service = new TaskService(client, DB)

    await service.countClosedSince("2026-03-30", { projectId: "proj-mail" })
    const args = (client.dataSources.query as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(JSON.stringify(args.filter)).toContain("proj-mail")
  })
})

describe("TaskService.queryOverdue", () => {
  it("excludes archived task pages from overdue results", async () => {
    const client = createMockClient({
      queryResults: [
        archivedPage(
          taskPage("archived-overdue", {
            state: "open",
            reviewBy: "2026-01-01",
          })
        ),
        taskPage("live-overdue", {
          state: "open",
          reviewBy: "2026-01-01",
        }),
      ],
    })
    const service = new TaskService(client, DB)

    const results = await service.queryOverdue()

    expect(results.map((item) => item.id)).toEqual(["live-overdue"])
  })

  it("filters archived rows while paginating overdue tasks", async () => {
    const client = createMockClient()
    const query = client.dataSources.query as ReturnType<typeof vi.fn>
    query.mockReset()
    query
      .mockResolvedValueOnce({
        results: [
          taskPage("archived-before", {
            archived: true,
            reviewBy: "2026-01-01",
          }),
          taskPage("live-1", { reviewBy: "2026-01-01" }),
        ],
        has_more: true,
        next_cursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        results: [
          taskPage("archived-between", {
            archived: true,
            reviewBy: "2026-01-02",
          }),
          taskPage("live-2", { reviewBy: "2026-01-02" }),
          taskPage("archived-after", {
            archived: true,
            reviewBy: "2026-01-03",
          }),
        ],
        has_more: false,
        next_cursor: null,
      })
    const service = new TaskService(client, DB)

    const results = await service.queryOverdue()

    expect(results.map((item) => item.id)).toEqual(["live-1", "live-2"])
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1]![0].start_cursor).toBe("cursor-1")
  })

  it("caps the default overdue-task window and exposes capped metadata", async () => {
    const responses = Array.from({ length: 6 }, (_, i) => ({
      results: [taskPage(`task-${i}`, { reviewBy: "2026-01-01" })],
      has_more: i < 5,
      next_cursor: i < 5 ? `cursor-${i + 1}` : null,
    }))
    let i = 0
    const client = createMockClient()
    const query = client.dataSources.query as ReturnType<typeof vi.fn>
    query.mockReset()
    query.mockImplementation(() => {
      const response = responses[Math.min(i, responses.length - 1)]
      i += 1
      return Promise.resolve(response)
    })
    const service = new TaskService(client, DB)
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    try {
      const result = await service.queryOverdueWindow()

      expect(result.items.map((item) => item.id)).toEqual([
        "task-0",
        "task-1",
        "task-2",
        "task-3",
        "task-4",
      ])
      expect(result.capped).toBe(true)
      expect(query).toHaveBeenCalledTimes(5)
    } finally {
      stderrSpy.mockRestore()
    }
  })
})

describe("taskStats orchestrator", () => {
  it("composes countActive + countClosedSince into the surface-rendering shape", async () => {
    const service = {
      countActive: vi.fn(async () => ({
        total: 271,
        overdue: 25,
        stale: 89,
        inProgress: 12,
        blocked: 4,
      })),
      countClosedSince: vi.fn(async () => 14),
    }

    const stats = await taskStats(service as never, {
      today: "2026-04-28",
    })

    expect(stats).toEqual({
      active: 271,
      overdue: 25,
      stale: 89,
      inProgress: 12,
      blocked: 4,
      closedLast30Days: 14,
    })
    // The closed-since window is `today - 29 days` so `Done At
    // on_or_after windowStart` covers exactly 30 inclusive calendar
    // days through `today`. Subtracting 30 would cover 31 days and
    // silently inflate the rate against the `N / 30` divisor.
    expect(service.countClosedSince).toHaveBeenCalledWith(
      "2026-03-30",
      expect.any(Object)
    )
  })

  it("computes a 30-day inclusive window: today − 29 days through today", () => {
    // Pin the off-by-one explicitly. A regression to `today - 30` would
    // span 31 inclusive days; this assertion catches that immediately.
    const todayMs = new Date("2026-04-28").getTime()
    const expected = new Date(todayMs - 29 * 86_400_000).toISOString().split("T")[0]
    expect(expected).toBe("2026-03-30")
  })

  it("propagates a null closedLast30Days from a pre-#07 vault unchanged", async () => {
    const service = {
      countActive: vi.fn(async () => ({
        total: 0,
        overdue: 0,
        stale: 0,
        inProgress: 0,
        blocked: 0,
      })),
      countClosedSince: vi.fn(async () => null),
    }

    const stats = await taskStats(service as never, { today: "2026-04-28" })
    expect(stats.closedLast30Days).toBeNull()
  })

  it("forwards projectId to both underlying counters", async () => {
    const service = {
      countActive: vi.fn(async () => ({
        total: 0,
        overdue: 0,
        stale: 0,
        inProgress: 0,
        blocked: 0,
      })),
      countClosedSince: vi.fn(async () => 0),
    }

    await taskStats(service as never, {
      projectId: "proj-mail",
      today: "2026-04-28",
    })

    expect(service.countActive).toHaveBeenCalledWith({
      projectId: "proj-mail",
      today: "2026-04-28",
    })
    expect(service.countClosedSince).toHaveBeenCalledWith("2026-03-30", {
      projectId: "proj-mail",
    })
  })

  it("rejects malformed `today` with a clear RangeError instead of letting NaN propagate", async () => {
    // Without the boundary check, a malformed `today` would cascade
    // through `new Date(NaN)` → `.toISOString()` and surface as an
    // opaque RangeError several frames up. The explicit guard names
    // the offending value at the helper site so the failure is
    // self-explanatory.
    const service = {
      countActive: vi.fn(),
      countClosedSince: vi.fn(),
    }
    await expect(taskStats(service as never, { today: "not-a-date" })).rejects.toThrow(
      /invalid today value "not-a-date"/i
    )
    // Neither underlying counter should have fired — the validation
    // runs before the `Promise.all` fan-out.
    expect(service.countActive).not.toHaveBeenCalled()
    expect(service.countClosedSince).not.toHaveBeenCalled()
  })
})

describe("todayUtc", () => {
  it("returns a YYYY-MM-DD string parseable as a UTC date", () => {
    const value = todayUtc()
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // Round-trip through Date — the value must be a real UTC date,
    // not a string that happens to match the regex.
    const ms = new Date(value).getTime()
    expect(Number.isNaN(ms)).toBe(false)
    // Should be today by UTC; allow a 1-day window to accommodate
    // tests crossing midnight UTC during execution.
    const todayMs = Date.now()
    const dayMs = 86_400_000
    expect(Math.abs(todayMs - ms)).toBeLessThan(2 * dayMs)
  })
})

describe("formatTaskSummary", () => {
  function baseStats(overrides: Partial<TaskStats> = {}): TaskStats {
    return {
      active: 0,
      overdue: 0,
      stale: 0,
      inProgress: 0,
      blocked: 0,
      closedLast30Days: null,
      ...overrides,
    }
  }

  it("renders 'Tasks: 0 active' bare when the vault is task-empty", () => {
    // Acceptance criterion: a task-empty vault still renders the line
    // — operators need an explicit signal that the surface is working,
    // not that it's hidden.
    const lines = formatTaskSummary(baseStats({ active: 0 }))
    expect(lines).toEqual(["Tasks: 0 active"])
  })

  it("emits no parenthetical when active>0 but every sub-stat is zero", () => {
    const lines = formatTaskSummary(baseStats({ active: 5 }))
    expect(lines).toEqual(["Tasks: 5 active"])
  })

  it("renders the full sub-stat parenthetical in the canonical order", () => {
    const lines = formatTaskSummary(
      baseStats({
        active: 271,
        overdue: 25,
        stale: 89,
        inProgress: 12,
        blocked: 4,
      })
    )
    expect(lines).toEqual([
      `Tasks: 271 active (overdue: 25, stale ≥${STALE_TASK_DAYS}d: 89, in-progress: 12, blocked: 4)`,
    ])
  })

  it("omits per-bucket sub-stats whose count is zero", () => {
    // Only overdue is non-zero — the parenthetical contains overdue
    // alone. The renderer never emits "stale ≥30d: 0" as filler.
    const lines = formatTaskSummary(baseStats({ active: 25, overdue: 25 }))
    expect(lines).toEqual(["Tasks: 25 active (overdue: 25)"])
  })

  it("appends a closure-rate line when closedLast30Days is non-null (post-#07)", () => {
    const lines = formatTaskSummary(baseStats({ active: 271, closedLast30Days: 14 }))
    expect(lines).toEqual([
      "Tasks: 271 active",
      "       Closed last 30 days: 14 (rate: 0.47/day)",
    ])
  })

  it("aligns the closure-rate continuation line under the count on the primary line", () => {
    // Pin the alignment-by-prefix-length contract: the indent on the
    // continuation line equals the length of the `Tasks: ` prefix.
    // A future copy edit on the primary line (e.g. `Tasks (project): `)
    // would silently rot the visual block alignment without this guard.
    // Use a fixture where the count cannot collide with any other
    // numeric token in the line so `indexOf(String(active))` lands on
    // the count and not on a substring of "30d" / "0.03/day" / etc.
    const report = baseStats({ active: 271, closedLast30Days: 1 })
    const lines = formatTaskSummary(report)
    const primary = lines[0]!
    const continuation = lines[1]!
    const tasksPrefixLen = primary.indexOf(String(report.active))
    const continuationIndent = continuation.indexOf("Closed")
    expect(tasksPrefixLen).toBeGreaterThan(0) // sanity: count is found
    expect(continuationIndent).toBe(tasksPrefixLen)
  })

  it("renders a 0/30 closure rate as '0.00/day' (operator-visible signal of stagnation)", () => {
    const lines = formatTaskSummary(baseStats({ active: 5, closedLast30Days: 0 }))
    expect(lines).toEqual([
      "Tasks: 5 active",
      "       Closed last 30 days: 0 (rate: 0.00/day)",
    ])
  })

  it("suppresses the closure-rate line entirely when closedLast30Days is null (pre-#07)", () => {
    const lines = formatTaskSummary(baseStats({ active: 5, closedLast30Days: null }))
    expect(lines).toEqual(["Tasks: 5 active"])
  })

  it("rounds the rate to 2 decimals", () => {
    // 30 closures / 30 days → 1.00; 100 closures / 30 days → 3.33.
    expect(
      formatTaskSummary(baseStats({ active: 1, closedLast30Days: 30 }))[1]
    ).toContain("rate: 1.00/day")
    expect(
      formatTaskSummary(baseStats({ active: 1, closedLast30Days: 100 }))[1]
    ).toContain("rate: 3.33/day")
  })
})
