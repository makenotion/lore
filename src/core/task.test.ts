import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import {
  TaskService,
  buildMigrationKeyword,
  isCleared,
  parseMigratedFactIds,
  taskDaysOverdue,
} from "./task.js"
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

  it("preserves migrated-from-fact markers when keywords are rewritten", async () => {
    // Without preservation, a benign caller updating keywords on a
    // migrated task wipes the marker — and the next migration heal
    // pass would lose the binding in `findMigratedFactIds` and create
    // a duplicate task. The marker is structural; preservation is
    // automatic.
    const existingPage = makePage({
      id: "task-id",
      properties: {
        Keywords: {
          type: "rich_text",
          rich_text: [
            { plain_text: "old-stuff migrated-from-fact fact-99 more-tokens" },
          ],
        } as unknown,
      } as PageObjectResponse["properties"],
    })
    const updatedPage = taskPage("task-id")
    const client = createMockClient({
      retrievedPages: { "task-id": existingPage },
      // The post-update read for `getById` reuses the same retrieved-pages map,
      // so the page returned after update is the same shape.
    })
    // Override the post-update getById to return updatedPage shape.
    client.pages.retrieve = vi.fn().mockResolvedValueOnce(existingPage).mockResolvedValueOnce(updatedPage)
    const service = new TaskService(client, DB)

    await service.update("task-id", { keywords: "fresh-token-1 fresh-token-2" })

    const args = (client.pages.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const writtenKeywords = (args.properties["Keywords"] as {
      rich_text: Array<{ text: { content: string } }>
    }).rich_text[0].text.content
    // Caller's tokens preserved; migrated marker re-appended.
    expect(writtenKeywords).toContain("fresh-token-1")
    expect(writtenKeywords).toContain("fresh-token-2")
    expect(writtenKeywords).toContain("migrated-from-fact fact-99")
  })

  it("does not duplicate a marker the caller already included in their new keywords", async () => {
    // If the caller's input already carries the marker (rare, but
    // possible — they read it themselves and are restating it), the
    // merge is a no-op for that fact id. Otherwise we'd write
    // `migrated-from-fact f1 migrated-from-fact f1` and inflate the
    // keywords with each round-trip.
    const existingPage = makePage({
      id: "task-id",
      properties: {
        Keywords: {
          type: "rich_text",
          rich_text: [{ plain_text: "migrated-from-fact f1" }],
        } as unknown,
      } as PageObjectResponse["properties"],
    })
    const client = createMockClient({
      retrievedPages: { "task-id": existingPage },
    })
    client.pages.retrieve = vi
      .fn()
      .mockResolvedValueOnce(existingPage)
      .mockResolvedValueOnce(taskPage("task-id"))
    const service = new TaskService(client, DB)

    await service.update("task-id", { keywords: "new-stuff migrated-from-fact f1" })

    const args = (client.pages.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const writtenKeywords = (args.properties["Keywords"] as {
      rich_text: Array<{ text: { content: string } }>
    }).rich_text[0].text.content
    // Exactly one marker for f1 — no doubling.
    expect(writtenKeywords.match(/migrated-from-fact f1/g)).toHaveLength(1)
  })

  it("falls back to caller's keywords verbatim when the pre-read fails", async () => {
    // Fail-soft: a transient read error must not block a legitimate
    // keyword update. The cost is one possibly-lost marker resulting
    // in one duplicate task on the next migration pass — vs. blocking
    // every keyword update on a Notion 5xx, which is much worse.
    const updatedPage = taskPage("task-id")
    const client = {
      pages: {
        retrieve: vi
          .fn()
          .mockRejectedValueOnce(new Error("transient 5xx"))
          .mockResolvedValueOnce(updatedPage),
        update: vi.fn().mockResolvedValue({}),
        retrieveMarkdown: vi.fn().mockResolvedValue({ markdown: "" }),
      },
      dataSources: {
        query: vi.fn().mockResolvedValue({ results: [], has_more: false, next_cursor: null }),
      },
    } as unknown as Client
    const service = new TaskService(client, DB)

    await service.update("task-id", { keywords: "operator-update" })

    const args = (client.pages.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const writtenKeywords = (args.properties["Keywords"] as {
      rich_text: Array<{ text: { content: string } }>
    }).rich_text[0].text.content
    expect(writtenKeywords).toBe("operator-update")
  })

  it("leaves keywords untouched (no extra read) when input.keywords is undefined", async () => {
    // Pre-read should only fire when keywords is in the update
    // payload. Other field updates shouldn't pay the round-trip.
    const updatedPage = taskPage("task-id")
    const client = createMockClient({
      retrievedPages: { "task-id": updatedPage },
    })
    const service = new TaskService(client, DB)

    await service.update("task-id", { state: "in-progress" })

    // Single retrieve call: the post-update getById. No pre-read.
    expect((client.pages.retrieve as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })
})

describe('isCleared — empty-string-means-absence rule', () => {
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

describe("buildMigrationKeyword + parseMigratedFactIds", () => {
  it("round-trips a single fact id through the keyword token", () => {
    const keyword = buildMigrationKeyword("fact-abc")
    expect(parseMigratedFactIds(keyword)).toEqual(["fact-abc"])
  })

  it("extracts every marker when the keywords field carries multiple", () => {
    const combined = `${buildMigrationKeyword("fact-1")} ${buildMigrationKeyword("fact-2")}`
    expect(parseMigratedFactIds(combined)).toEqual(["fact-1", "fact-2"])
  })

  it("ignores surrounding free-form keywords that don't carry the marker", () => {
    const mixed = `pr-25700 ${buildMigrationKeyword("fact-1")} ThreadStore.swift`
    expect(parseMigratedFactIds(mixed)).toEqual(["fact-1"])
  })

  it("returns an empty array when no marker is present", () => {
    expect(parseMigratedFactIds("just some keywords")).toEqual([])
    expect(parseMigratedFactIds("")).toEqual([])
  })
})

describe("TaskService.findMigratedFactIds", () => {
  it("paginates a Kind=task + Keywords-contains query and parses fact ids out", async () => {
    const pageA = makePage({
      id: "task-1",
      properties: {
        Keywords: {
          type: "rich_text",
          rich_text: [{ plain_text: "migrated-from-fact fact-1 extra-token" }],
        } as unknown,
      } as PageObjectResponse["properties"],
    })
    const pageB = makePage({
      id: "task-2",
      properties: {
        Keywords: {
          type: "rich_text",
          rich_text: [{ plain_text: "migrated-from-fact fact-2" }],
        } as unknown,
      } as PageObjectResponse["properties"],
    })
    const client = {
      pages: {} as Client["pages"],
      dataSources: {
        query: vi
          .fn()
          .mockResolvedValueOnce({
            results: [pageA],
            has_more: true,
            next_cursor: "cursor-2",
          })
          .mockResolvedValueOnce({
            results: [pageB],
            has_more: false,
            next_cursor: null,
          }),
      },
    } as unknown as Client
    const service = new TaskService(client, DB)

    const map = await service.findMigratedFactIds()

    expect(map.get("fact-1")).toBe("task-1")
    expect(map.get("fact-2")).toBe("task-2")
    expect((client.dataSources.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2)
    // First call uses the Kind=task + Keywords-contains filter; we
    // rely on it being server-side so a vault with thousands of tasks
    // doesn't fan out across post-filter passes.
    const firstCall = (client.dataSources.query as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
    expect(JSON.stringify(firstCall.filter)).toContain('"task"')
    expect(JSON.stringify(firstCall.filter)).toContain("migrated-from-fact")
  })

  it("returns an empty map when no migration markers exist in the vault", async () => {
    const client = createMockClient({ queryResults: [] })
    const service = new TaskService(client, DB)

    const map = await service.findMigratedFactIds()

    expect(map.size).toBe(0)
  })

  it("propagates an error from the second page rather than returning a partial map", async () => {
    // If pagination silently swallowed a second-page failure, the
    // migration would believe a marker was missing and fall through
    // to the create branch — exactly the duplicate-task bug this
    // change is meant to prevent. Pin the throw so a future refactor
    // can't quietly turn that into "skip the bad page, return what
    // we have."
    const pageA = makePage({
      id: "task-1",
      properties: {
        Keywords: {
          type: "rich_text",
          rich_text: [{ plain_text: "migrated-from-fact fact-1" }],
        } as unknown,
      } as PageObjectResponse["properties"],
    })
    const client = {
      pages: {} as Client["pages"],
      dataSources: {
        query: vi
          .fn()
          .mockResolvedValueOnce({
            results: [pageA],
            has_more: true,
            next_cursor: "cursor-2",
          })
          .mockRejectedValueOnce(
            Object.assign(new Error("notion 5xx"), { code: "internal_server_error" })
          ),
      },
    } as unknown as Client
    const service = new TaskService(client, DB)

    await expect(service.findMigratedFactIds()).rejects.toThrow("notion 5xx")
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
