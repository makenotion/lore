import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { TopicService } from "./topic.js"
import type { DatabaseRef } from "../types.js"

type MockablePage = Partial<PageObjectResponse> & { id: string }

function makePage(overrides: MockablePage): PageObjectResponse {
  return {
    object: "page",
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-02-01T00:00:00.000Z",
    archived: false,
    url: `https://notion.so/${overrides.id}`,
    parent: { type: "database_id", database_id: "topics-db" },
    properties: {},
    ...overrides,
  } as PageObjectResponse
}

function topicPage(
  id: string,
  opts?: { name?: string; projectIds?: string[]; description?: string }
): PageObjectResponse {
  return makePage({
    id,
    properties: {
      Name: {
        type: "title",
        title: [{ plain_text: opts?.name ?? `Topic ${id}` }],
      } as unknown,
      Project: {
        type: "relation",
        relation: (opts?.projectIds ?? []).map((pid) => ({ id: pid })),
      } as unknown,
      Description: {
        type: "rich_text",
        rich_text: opts?.description ? [{ plain_text: opts.description }] : [],
      } as unknown,
    } as PageObjectResponse["properties"],
  })
}

interface MockClientOpts {
  queryResults?: PageObjectResponse[]
  createReturn?: PageObjectResponse
  retrievedPages?: Record<string, PageObjectResponse>
}

function createMockClient(opts: MockClientOpts = {}) {
  const defaultCreate = topicPage("new-topic-id")
  return {
    pages: {
      create: vi.fn().mockResolvedValue(opts.createReturn ?? defaultCreate),
      retrieve: vi.fn().mockImplementation(({ page_id }: { page_id: string }) => {
        const page = opts.retrievedPages?.[page_id]
        if (!page)
          return Promise.reject(new Error(`Mock: no page registered for ${page_id}`))
        return Promise.resolve(page)
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    dataSources: {
      query: vi.fn().mockResolvedValue({
        results: opts.queryResults ?? [],
        has_more: false,
        next_cursor: null,
      }),
    },
  } as unknown as Client & {
    pages: {
      create: ReturnType<typeof vi.fn>
      update: ReturnType<typeof vi.fn>
      retrieve: ReturnType<typeof vi.fn>
    }
    dataSources: { query: ReturnType<typeof vi.fn> }
  }
}

const DB: DatabaseRef = {
  databaseId: "topics-db-id",
  dataSourceId: "topics-ds-id",
}

describe("TopicService.create", () => {
  it("builds an empty relation when projectIds is empty", async () => {
    const client = createMockClient()
    const service = new TopicService(client, DB)

    await service.create({ name: "GraphQL federation", projectIds: [] })

    const createArgs = client.pages.create.mock.calls[0][0]
    expect(createArgs.parent).toEqual({
      type: "database_id",
      database_id: "topics-db-id",
    })
    expect(createArgs.properties.Project).toEqual({ relation: [] })
  })

  it("builds a multi-project relation", async () => {
    const client = createMockClient()
    const service = new TopicService(client, DB)

    await service.create({
      name: "GraphQL federation",
      projectIds: ["proj-a", "proj-b"],
    })

    const createArgs = client.pages.create.mock.calls[0][0]
    expect(createArgs.properties.Project).toEqual({
      relation: [{ id: "proj-a" }, { id: "proj-b" }],
    })
  })
})

describe("TopicService.pageToTopic (via getById)", () => {
  it("round-trips a multi-project relation", async () => {
    const client = createMockClient({
      retrievedPages: {
        t1: topicPage("t1", {
          name: "Shared crypto",
          projectIds: ["p1", "p2", "p3"],
        }),
      },
    })
    const service = new TopicService(client, DB)

    const topic = await service.getById("t1")

    expect(topic.name).toBe("Shared crypto")
    expect(topic.projectIds).toEqual(["p1", "p2", "p3"])
  })
})

describe("TopicService.findByName", () => {
  it("applies only the Name filter when projectId is not given (global lookup)", async () => {
    const client = createMockClient()
    const service = new TopicService(client, DB)

    await service.findByName("GraphQL federation")

    const queryArgs = client.dataSources.query.mock.calls[0][0]
    expect(queryArgs.filter).toEqual({
      property: "Name",
      title: { equals: "GraphQL federation" },
    })
  })

  it("combines Name and Project.contains under `and` when projectId is given", async () => {
    const client = createMockClient()
    const service = new TopicService(client, DB)

    await service.findByName("GraphQL federation", "proj-a")

    const queryArgs = client.dataSources.query.mock.calls[0][0]
    expect(queryArgs.filter.and).toEqual([
      { property: "Name", title: { equals: "GraphQL federation" } },
      { property: "Project", relation: { contains: "proj-a" } },
    ])
  })

  it("returns null when no matches exist", async () => {
    const client = createMockClient({ queryResults: [] })
    const service = new TopicService(client, DB)

    expect(await service.findByName("nonexistent")).toBeNull()
  })

  it("throws when more than one match is found in global mode", async () => {
    const dup1 = topicPage("t1", { name: "auth", projectIds: ["p1"] })
    const dup2 = topicPage("t2", { name: "auth", projectIds: ["p2"] })
    const client = createMockClient({ queryResults: [dup1, dup2] })
    const service = new TopicService(client, DB)

    await expect(service.findByName("auth")).rejects.toThrow(
      /Multiple topics named "auth" found \(t1, t2\)\. Run `lore migrate --merge-duplicate-topics`/
    )
  })

  it("does not throw in scoped mode even if Notion returns multiple matches", async () => {
    // Scoped lookup is the safety valve — callers that know their own
    // project scope can read a topic that pre-dates any merge step.
    const dup1 = topicPage("t1", { name: "auth", projectIds: ["p1"] })
    const dup2 = topicPage("t2", { name: "auth", projectIds: ["p1", "p2"] })
    const client = createMockClient({ queryResults: [dup1, dup2] })
    const service = new TopicService(client, DB)

    const topic = await service.findByName("auth", "p1")
    expect(topic?.id).toBe("t1") // first-match semantics preserved for scoped mode
  })
})

describe("TopicService.listByName", () => {
  it("returns every topic with the given name, paginated", async () => {
    const t1 = topicPage("t1", { name: "auth", projectIds: ["p1"] })
    const t2 = topicPage("t2", { name: "auth", projectIds: ["p2"] })
    const client = createMockClient({ queryResults: [t1, t2] })
    const service = new TopicService(client, DB)

    const topics = await service.listByName("auth")

    expect(topics).toHaveLength(2)
    expect(topics.map((t) => t.id)).toEqual(["t1", "t2"])
  })

  it("returns empty array when no matches exist", async () => {
    const client = createMockClient({ queryResults: [] })
    const service = new TopicService(client, DB)

    const topics = await service.listByName("nonexistent")
    expect(topics).toEqual([])
  })
})

describe("TopicService.getOrCreate — extend-on-find", () => {
  it("creates a new topic when none exists", async () => {
    const created = topicPage("new-topic", {
      name: "GraphQL federation",
      projectIds: ["proj-a"],
    })
    const client = createMockClient({ queryResults: [], createReturn: created })
    const service = new TopicService(client, DB)

    const topic = await service.getOrCreate("GraphQL federation", ["proj-a"])

    expect(client.pages.create).toHaveBeenCalledTimes(1)
    expect(client.pages.update).not.toHaveBeenCalled()
    expect(topic.projectIds).toEqual(["proj-a"])
  })

  it("returns the existing topic with zero writes when all projectIds are already linked", async () => {
    const existing = topicPage("t1", {
      name: "GraphQL federation",
      projectIds: ["proj-a"],
    })
    const client = createMockClient({ queryResults: [existing] })
    const service = new TopicService(client, DB)

    const topic = await service.getOrCreate("GraphQL federation", ["proj-a"])

    expect(client.pages.create).not.toHaveBeenCalled()
    expect(client.pages.update).not.toHaveBeenCalled()
    expect(client.pages.retrieve).not.toHaveBeenCalled()
    expect(topic.id).toBe("t1")
    expect(topic.projectIds).toEqual(["proj-a"])
  })

  it("extends the relation and re-reads authoritative state", async () => {
    const before = topicPage("t1", {
      name: "GraphQL federation",
      projectIds: ["proj-a"],
    })
    const after = topicPage("t1", {
      name: "GraphQL federation",
      projectIds: ["proj-a", "proj-b"],
    })
    const client = createMockClient({
      queryResults: [before],
      retrievedPages: { t1: after },
    })
    const service = new TopicService(client, DB)

    const topic = await service.getOrCreate("GraphQL federation", [
      "proj-a",
      "proj-b",
    ])

    expect(client.pages.create).not.toHaveBeenCalled()
    expect(client.pages.update).toHaveBeenCalledTimes(1)
    const updateArgs = client.pages.update.mock.calls[0][0]
    expect(updateArgs.page_id).toBe("t1")
    expect(updateArgs.properties.Project.relation).toEqual([
      { id: "proj-a" },
      { id: "proj-b" },
    ])
    // Post-update refetch confirms our addition survived.
    expect(client.pages.retrieve).toHaveBeenCalledTimes(1)
    expect(topic.projectIds).toEqual(["proj-a", "proj-b"])
  })

  it("does not duplicate ids when the existing relation is a superset", async () => {
    const existing = topicPage("t1", {
      name: "GraphQL federation",
      projectIds: ["proj-a", "proj-b", "proj-c"],
    })
    const client = createMockClient({ queryResults: [existing] })
    const service = new TopicService(client, DB)

    const topic = await service.getOrCreate("GraphQL federation", ["proj-a"])

    expect(client.pages.update).not.toHaveBeenCalled()
    expect(topic.projectIds).toEqual(["proj-a", "proj-b", "proj-c"])
  })

  it("looks up globally (no project filter) so extend finds a topic in any project", async () => {
    const existing = topicPage("t1", {
      name: "GraphQL federation",
      projectIds: ["proj-a"],
    })
    const after = topicPage("t1", {
      name: "GraphQL federation",
      projectIds: ["proj-a", "proj-b"],
    })
    const client = createMockClient({
      queryResults: [existing],
      retrievedPages: { t1: after },
    })
    const service = new TopicService(client, DB)

    await service.getOrCreate("GraphQL federation", ["proj-b"])

    const queryArgs = client.dataSources.query.mock.calls[0][0]
    expect(queryArgs.filter).toEqual({
      property: "Name",
      title: { equals: "GraphQL federation" },
    })
  })

  it("retries when a concurrent writer clobbers the extension", async () => {
    const before = topicPage("t1", {
      name: "auth",
      projectIds: ["proj-a"],
    })
    // First refetch — someone else wrote without our addition.
    const stale = topicPage("t1", {
      name: "auth",
      projectIds: ["proj-a", "proj-x"],
    })
    // Second refetch — our retry succeeded.
    const correct = topicPage("t1", {
      name: "auth",
      projectIds: ["proj-a", "proj-x", "proj-b"],
    })
    const client = createMockClient({
      queryResults: [before],
    })
    // Override query to return the post-clobber state on the second
    // findByName call (the retry's own lookup).
    const queryMock = client.dataSources.query as ReturnType<typeof vi.fn>
    queryMock
      .mockResolvedValueOnce({ results: [before], has_more: false, next_cursor: null })
      .mockResolvedValueOnce({ results: [stale], has_more: false, next_cursor: null })
    const retrieveMock = client.pages.retrieve as ReturnType<typeof vi.fn>
    retrieveMock
      .mockResolvedValueOnce(stale) // first retrieve — clobbered
      .mockResolvedValueOnce(correct) // second retrieve — retry succeeded

    const service = new TopicService(client, DB)
    const topic = await service.getOrCreate("auth", ["proj-b"])

    expect(client.pages.update).toHaveBeenCalledTimes(2)
    expect(client.pages.retrieve).toHaveBeenCalledTimes(2)
    expect(topic.projectIds).toEqual(["proj-a", "proj-x", "proj-b"])
  })
})
