import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { TopicService, decodeTopicHtmlEntities } from "./topic.js"
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

describe("decodeTopicHtmlEntities", () => {
  it("is a no-op on clean input", () => {
    expect(decodeTopicHtmlEntities("Build & Tooling")).toBe("Build & Tooling")
    expect(decodeTopicHtmlEntities("R&D roadmap")).toBe("R&D roadmap")
    expect(decodeTopicHtmlEntities("")).toBe("")
  })

  it("decodes a single-escape entity", () => {
    expect(decodeTopicHtmlEntities("Build &amp; Tooling")).toBe("Build & Tooling")
    expect(decodeTopicHtmlEntities("a &lt; b")).toBe("a < b")
    expect(decodeTopicHtmlEntities("a &gt; b")).toBe("a > b")
    expect(decodeTopicHtmlEntities("&quot;quoted&quot;")).toBe('"quoted"')
    expect(decodeTopicHtmlEntities("it&#39;s")).toBe("it's")
  })

  it("decodes double-escape `&amp;amp;` all the way to `&`", () => {
    expect(decodeTopicHtmlEntities("Build &amp;amp; Tooling")).toBe(
      "Build & Tooling"
    )
  })

  it("decodes triple-escape without stopping early", () => {
    expect(decodeTopicHtmlEntities("A &amp;amp;amp; B")).toBe("A & B")
  })

  it("is idempotent", () => {
    const clean = decodeTopicHtmlEntities("Build &amp;amp; Tooling")
    expect(decodeTopicHtmlEntities(clean)).toBe(clean)
  })

  it("handles deeply-nested encoding without leaving residue", () => {
    // Eight rounds of `&amp;` — well beyond the two-round real-world case.
    // Each pass strictly shrinks the string; the iteration bound is tied to
    // `name.length` so deep nesting fully decodes rather than capping early.
    let input = "&"
    for (let i = 0; i < 8; i++) {
      input = input.replace(/&/g, "&amp;")
    }
    input = `A ${input} B`
    expect(decodeTopicHtmlEntities(input)).toBe("A & B")
  })

  it("decodes `&apos;` to a straight apostrophe", () => {
    expect(decodeTopicHtmlEntities("it&apos;s")).toBe("it's")
  })

  it("collapses `&#38;amp;` via the fixed-point loop", () => {
    expect(decodeTopicHtmlEntities("&#38;amp; tooling")).toBe("& tooling")
  })

  it("decodes entities beyond the hand-rolled five (`&nbsp;`, `&rsquo;`)", () => {
    // Coverage for the long-tail of HTML5 named entities that a hand-rolled
    // table would miss. Real-world upstream producers (markdown renderers,
    // rich-text editors) emit these routinely.
    expect(decodeTopicHtmlEntities("Build &nbsp; Tooling")).toBe(
      "Build   Tooling"
    )
    expect(decodeTopicHtmlEntities("today&rsquo;s work")).toBe(
      "today’s work"
    )
  })

  it("decodes numeric character references in any radix", () => {
    expect(decodeTopicHtmlEntities("it&#8217;s")).toBe("it’s")
    expect(decodeTopicHtmlEntities("it&#x2019;s")).toBe("it’s")
  })
})

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

  it("stores a raw `&` unchanged", async () => {
    const client = createMockClient()
    const service = new TopicService(client, DB)

    await service.create({ name: "Build & Tooling", projectIds: [] })

    const createArgs = client.pages.create.mock.calls[0][0]
    expect(createArgs.properties.Name.title[0].text.content).toBe(
      "Build & Tooling"
    )
  })

  it("decodes `&amp;` on write so re-saves are idempotent", async () => {
    const client = createMockClient()
    const service = new TopicService(client, DB)

    await service.create({ name: "Build &amp; Tooling", projectIds: [] })

    const createArgs = client.pages.create.mock.calls[0][0]
    expect(createArgs.properties.Name.title[0].text.content).toBe(
      "Build & Tooling"
    )
  })

  it("decodes double-escape `&amp;amp;` all the way to `&` on write", async () => {
    const client = createMockClient()
    const service = new TopicService(client, DB)

    await service.create({ name: "Build &amp;amp; Tooling", projectIds: [] })

    const createArgs = client.pages.create.mock.calls[0][0]
    expect(createArgs.properties.Name.title[0].text.content).toBe(
      "Build & Tooling"
    )
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

  it("decodes HTML entities in the name before querying", async () => {
    const client = createMockClient()
    const service = new TopicService(client, DB)

    await service.findByName("Build &amp;amp; Tooling")

    const queryArgs = client.dataSources.query.mock.calls[0][0]
    expect(queryArgs.filter).toEqual({
      property: "Name",
      title: { equals: "Build & Tooling" },
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

  it("stops after one page when has_more is false even if next_cursor is non-null", async () => {
    const t1 = topicPage("t1", { name: "auth", projectIds: ["p1"] })
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [t1],
      has_more: false,
      next_cursor: "stale-cursor",
    })
    const service = new TopicService(client, DB)

    const topics = await service.listByName("auth")

    expect(topics).toHaveLength(1)
    expect(client.dataSources.query).toHaveBeenCalledTimes(1)
  })

  it("continues past a page when has_more is true", async () => {
    const t1 = topicPage("t1", { name: "auth", projectIds: ["p1"] })
    const t2 = topicPage("t2", { name: "auth", projectIds: ["p2"] })
    const client = createMockClient()
    client.dataSources.query
      .mockResolvedValueOnce({
        results: [t1],
        has_more: true,
        next_cursor: "page-2",
      })
      .mockResolvedValueOnce({
        results: [t2],
        has_more: false,
        next_cursor: null,
      })
    const service = new TopicService(client, DB)

    const topics = await service.listByName("auth")

    expect(topics.map((t) => t.id)).toEqual(["t1", "t2"])
    expect(client.dataSources.query).toHaveBeenCalledTimes(2)
    expect(client.dataSources.query.mock.calls[1][0].start_cursor).toBe("page-2")
  })
})

describe("TopicService.listByProject", () => {
  it("stops after one page when has_more is false even if next_cursor is non-null", async () => {
    const t1 = topicPage("t1", { name: "auth", projectIds: ["p1"] })
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [t1],
      has_more: false,
      next_cursor: "stale-cursor",
    })
    const service = new TopicService(client, DB)

    const topics = await service.listByProject("p1")

    expect(topics).toHaveLength(1)
    expect(client.dataSources.query).toHaveBeenCalledTimes(1)
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

  it("decodes encoded input so existing decoded rows are found and extended, not duplicated", async () => {
    // A row already stored under the decoded name; the caller passes the
    // encoded form (a common re-save pattern). getOrCreate must land on
    // the existing row rather than creating a sibling.
    const existing = topicPage("t1", {
      name: "Build & Tooling",
      projectIds: ["proj-a"],
    })
    const after = topicPage("t1", {
      name: "Build & Tooling",
      projectIds: ["proj-a", "proj-b"],
    })
    const client = createMockClient({
      queryResults: [existing],
      retrievedPages: { t1: after },
    })
    const service = new TopicService(client, DB)

    const topic = await service.getOrCreate("Build &amp; Tooling", ["proj-b"])

    expect(client.pages.create).not.toHaveBeenCalled()
    const queryArgs = client.dataSources.query.mock.calls[0][0]
    expect(queryArgs.filter).toEqual({
      property: "Name",
      title: { equals: "Build & Tooling" },
    })
    expect(topic.projectIds).toEqual(["proj-a", "proj-b"])
  })

  it("decodes on the create branch so a brand-new topic is stored cleanly", async () => {
    const created = topicPage("new-topic", {
      name: "Build & Tooling",
      projectIds: ["proj-a"],
    })
    const client = createMockClient({ queryResults: [], createReturn: created })
    const service = new TopicService(client, DB)

    await service.getOrCreate("Build &amp;amp; Tooling", ["proj-a"])

    expect(client.pages.create).toHaveBeenCalledTimes(1)
    const createArgs = client.pages.create.mock.calls[0][0]
    expect(createArgs.properties.Name.title[0].text.content).toBe(
      "Build & Tooling"
    )
  })

  it("carries the decoded name through retries when a concurrent writer clobbers the extension", async () => {
    // Under the same concurrency pattern as the existing retry test, with an
    // encoded input — the retry's re-lookup must also query for the decoded
    // form, not the raw one, or we'd bounce between a null lookup and a new
    // create on every retry.
    const before = topicPage("t1", {
      name: "Build & Tooling",
      projectIds: ["proj-a"],
    })
    const stale = topicPage("t1", {
      name: "Build & Tooling",
      projectIds: ["proj-a", "proj-x"],
    })
    const correct = topicPage("t1", {
      name: "Build & Tooling",
      projectIds: ["proj-a", "proj-x", "proj-b"],
    })
    const client = createMockClient({ queryResults: [before] })
    const queryMock = client.dataSources.query as ReturnType<typeof vi.fn>
    queryMock
      .mockResolvedValueOnce({
        results: [before],
        has_more: false,
        next_cursor: null,
      })
      .mockResolvedValueOnce({
        results: [stale],
        has_more: false,
        next_cursor: null,
      })
    const retrieveMock = client.pages.retrieve as ReturnType<typeof vi.fn>
    retrieveMock.mockResolvedValueOnce(stale).mockResolvedValueOnce(correct)

    const service = new TopicService(client, DB)
    const topic = await service.getOrCreate("Build &amp;amp; Tooling", ["proj-b"])

    // Every dataSources.query should have used the decoded form.
    for (const call of queryMock.mock.calls) {
      expect(call[0].filter).toEqual({
        property: "Name",
        title: { equals: "Build & Tooling" },
      })
    }
    expect(topic.projectIds).toEqual(["proj-a", "proj-x", "proj-b"])
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

describe("TopicService.findByName — cache", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("serves repeat global lookups from the in-process cache", async () => {
    const t1 = topicPage("t1", { name: "auth", projectIds: ["p1"] })
    const client = createMockClient({ queryResults: [t1] })
    const service = new TopicService(client, DB)

    await service.findByName("auth")
    await service.findByName("auth")
    await service.findByName("auth")

    expect(client.dataSources.query).toHaveBeenCalledTimes(1)
  })

  it("requeries after the TTL elapses", async () => {
    const t1 = topicPage("t1", { name: "auth", projectIds: ["p1"] })
    const client = createMockClient({ queryResults: [t1] })
    const service = new TopicService(client, DB)

    await service.findByName("auth")
    vi.advanceTimersByTime(60_001)
    await service.findByName("auth")

    expect(client.dataSources.query).toHaveBeenCalledTimes(2)
  })

  it("does not cache scoped lookups (projectId given)", async () => {
    const t1 = topicPage("t1", { name: "auth", projectIds: ["p1"] })
    const client = createMockClient({ queryResults: [t1] })
    const service = new TopicService(client, DB)

    await service.findByName("auth", "p1")
    await service.findByName("auth", "p1")

    expect(client.dataSources.query).toHaveBeenCalledTimes(2)
  })

  it("does not let a scoped lookup poison the global cache", async () => {
    const scoped = topicPage("t1", { name: "auth", projectIds: ["p1"] })
    const global = topicPage("t2", { name: "auth", projectIds: ["p1", "p2"] })
    const client = createMockClient()
    client.dataSources.query
      .mockResolvedValueOnce({
        results: [scoped],
        has_more: false,
        next_cursor: null,
      })
      .mockResolvedValueOnce({
        results: [global],
        has_more: false,
        next_cursor: null,
      })
    const service = new TopicService(client, DB)

    const scopedHit = await service.findByName("auth", "p1")
    const globalHit = await service.findByName("auth")

    expect(scopedHit?.id).toBe("t1")
    expect(globalHit?.id).toBe("t2")
    expect(client.dataSources.query).toHaveBeenCalledTimes(2)
  })

  it("does not cache null results", async () => {
    const client = createMockClient({ queryResults: [] })
    const service = new TopicService(client, DB)

    await service.findByName("missing")
    await service.findByName("missing")

    expect(client.dataSources.query).toHaveBeenCalledTimes(2)
  })

  it("invalidates the cache entry on create", async () => {
    const existing = topicPage("t1", { name: "auth", projectIds: ["p1"] })
    const created = topicPage("t2", { name: "auth", projectIds: ["p2"] })
    const client = createMockClient({
      queryResults: [existing],
      createReturn: created,
    })
    const service = new TopicService(client, DB)

    await service.findByName("auth")
    await service.create({ name: "auth", projectIds: ["p2"] })
    await service.findByName("auth")

    expect(client.dataSources.query).toHaveBeenCalledTimes(2)
  })

  it("updates the cache with the post-extend state after getOrCreate extends the relation", async () => {
    const before = topicPage("t1", { name: "auth", projectIds: ["p1"] })
    const after = topicPage("t1", { name: "auth", projectIds: ["p1", "p2"] })
    const client = createMockClient({
      queryResults: [before],
      retrievedPages: { t1: after },
    })
    const service = new TopicService(client, DB)

    await service.getOrCreate("auth", ["p1", "p2"])
    // The refetched (post-extend) state must be the one we serve next.
    const cached = await service.findByName("auth")

    expect(cached?.projectIds).toEqual(["p1", "p2"])
    // getOrCreate issues one findByName (Notion); the trailing
    // findByName is served from the post-extend cache.
    expect(client.dataSources.query).toHaveBeenCalledTimes(1)
  })

  it("evicts a stale cached entry before getOrCreate reads, so writeback uses fresh data", async () => {
    // A stale cache would let getOrCreate use old projectIds as the
    // merge base and clobber relations added elsewhere in the TTL
    // window. Verify the pre-read eviction by observing that a warm
    // cache is not served to getOrCreate.
    const stale = topicPage("t1", { name: "auth", projectIds: ["p1"] })
    const fresh = topicPage("t1", {
      name: "auth",
      projectIds: ["p1", "p3"], // another writer added p3 while we were cached
    })
    const afterWrite = topicPage("t1", {
      name: "auth",
      projectIds: ["p1", "p3", "p2"], // our addition landed on top of fresh
    })
    const client = createMockClient({
      retrievedPages: { t1: afterWrite },
    })
    client.dataSources.query
      .mockResolvedValueOnce({
        results: [stale],
        has_more: false,
        next_cursor: null,
      })
      .mockResolvedValueOnce({
        results: [fresh],
        has_more: false,
        next_cursor: null,
      })
    const service = new TopicService(client, DB)

    // Warm the cache with the stale value.
    await service.findByName("auth")
    expect(client.dataSources.query).toHaveBeenCalledTimes(1)

    // getOrCreate must re-query Notion rather than trust the cache.
    await service.getOrCreate("auth", ["p2"])
    expect(client.dataSources.query).toHaveBeenCalledTimes(2)

    // And the writeback must merge against the fresh projectIds
    // (including p3), not the stale cached ones.
    const updateArgs = client.pages.update.mock.calls[0][0]
    expect(updateArgs.properties.Project.relation).toEqual([
      { id: "p1" },
      { id: "p3" },
      { id: "p2" },
    ])
  })

  it("clearNameCache() forces the next lookup back to Notion", async () => {
    const t1 = topicPage("t1", { name: "auth", projectIds: ["p1"] })
    const client = createMockClient({ queryResults: [t1] })
    const service = new TopicService(client, DB)

    await service.findByName("auth")
    service.clearNameCache()
    await service.findByName("auth")

    expect(client.dataSources.query).toHaveBeenCalledTimes(2)
  })
})
