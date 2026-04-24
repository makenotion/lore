import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { ProjectService } from "./project.js"
import type { DatabaseRef } from "../types.js"

function projectPage(id: string, name: string): PageObjectResponse {
  return {
    object: "page",
    id,
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-02-01T00:00:00.000Z",
    archived: false,
    url: `https://notion.so/${id}`,
    parent: { type: "database_id", database_id: "projects-db" },
    properties: {
      Name: { type: "title", title: [{ plain_text: name }] } as unknown,
      Type: { type: "select", select: { name: "project" } } as unknown,
      Path: { type: "rich_text", rich_text: [] } as unknown,
      Status: { type: "select", select: { name: "active" } } as unknown,
      Description: { type: "rich_text", rich_text: [] } as unknown,
    } as PageObjectResponse["properties"],
  } as PageObjectResponse
}

function createMockClient() {
  return {
    pages: {
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    dataSources: {
      query: vi.fn(),
    },
  } as unknown as Client & {
    pages: {
      create: ReturnType<typeof vi.fn>
      update: ReturnType<typeof vi.fn>
    }
    dataSources: { query: ReturnType<typeof vi.fn> }
  }
}

const DB: DatabaseRef = {
  databaseId: "projects-db-id",
  dataSourceId: "projects-ds-id",
}

describe("ProjectService.list — pagination", () => {
  it("stops after one page when has_more is false even if next_cursor is non-null", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [projectPage("p1", "alpha")],
      has_more: false,
      next_cursor: "stale-cursor",
    })
    const service = new ProjectService(client, DB)

    const projects = await service.list()

    expect(projects).toHaveLength(1)
    expect(client.dataSources.query).toHaveBeenCalledTimes(1)
  })

  it("continues past a page when has_more is true", async () => {
    const client = createMockClient()
    client.dataSources.query
      .mockResolvedValueOnce({
        results: [projectPage("p1", "alpha")],
        has_more: true,
        next_cursor: "page-2",
      })
      .mockResolvedValueOnce({
        results: [projectPage("p2", "beta")],
        has_more: false,
        next_cursor: null,
      })
    const service = new ProjectService(client, DB)

    const projects = await service.list()

    expect(projects.map((p) => p.id)).toEqual(["p1", "p2"])
    expect(client.dataSources.query).toHaveBeenCalledTimes(2)
    expect(client.dataSources.query.mock.calls[1][0].start_cursor).toBe("page-2")
  })
})

describe("ProjectService.findByName — cache", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("serves repeat lookups from the in-process cache without re-querying Notion", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValue({
      results: [projectPage("p1", "alpha")],
      has_more: false,
      next_cursor: null,
    })
    const service = new ProjectService(client, DB)

    const first = await service.findByName("alpha")
    const second = await service.findByName("alpha")
    const third = await service.findByName("alpha")

    expect(first?.id).toBe("p1")
    expect(second?.id).toBe("p1")
    expect(third?.id).toBe("p1")
    expect(client.dataSources.query).toHaveBeenCalledTimes(1)
  })

  it("requeries Notion after the TTL elapses", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValue({
      results: [projectPage("p1", "alpha")],
      has_more: false,
      next_cursor: null,
    })
    const service = new ProjectService(client, DB)

    await service.findByName("alpha")
    vi.advanceTimersByTime(60_001)
    await service.findByName("alpha")

    expect(client.dataSources.query).toHaveBeenCalledTimes(2)
  })

  it("does not cache negative lookups (null result)", async () => {
    const client = createMockClient()
    client.dataSources.query
      .mockResolvedValueOnce({ results: [], has_more: false, next_cursor: null })
      .mockResolvedValueOnce({ results: [], has_more: false, next_cursor: null })
    const service = new ProjectService(client, DB)

    expect(await service.findByName("missing")).toBeNull()
    expect(await service.findByName("missing")).toBeNull()

    expect(client.dataSources.query).toHaveBeenCalledTimes(2)
  })

  it("invalidates the cache entry on create so a subsequent findByName hits Notion", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValue({
      results: [projectPage("p1", "alpha")],
      has_more: false,
      next_cursor: null,
    })
    client.pages.create.mockResolvedValue(projectPage("p2", "alpha"))
    const service = new ProjectService(client, DB)

    await service.findByName("alpha")
    expect(client.dataSources.query).toHaveBeenCalledTimes(1)

    await service.create({ name: "alpha" })
    await service.findByName("alpha")

    expect(client.dataSources.query).toHaveBeenCalledTimes(2)
  })

  it("clears the cache on archive", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValue({
      results: [projectPage("p1", "alpha")],
      has_more: false,
      next_cursor: null,
    })
    const service = new ProjectService(client, DB)

    await service.findByName("alpha")
    expect(client.dataSources.query).toHaveBeenCalledTimes(1)

    await service.archive("p1")
    await service.findByName("alpha")

    expect(client.dataSources.query).toHaveBeenCalledTimes(2)
  })

  it("clearNameCache() forces the next lookup back to Notion", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValue({
      results: [projectPage("p1", "alpha")],
      has_more: false,
      next_cursor: null,
    })
    const service = new ProjectService(client, DB)

    await service.findByName("alpha")
    service.clearNameCache()
    await service.findByName("alpha")

    expect(client.dataSources.query).toHaveBeenCalledTimes(2)
  })
})

describe("ProjectService.findByName — stampede dedup", () => {
  it("collapses N concurrent cold-start lookups onto a single Notion query", async () => {
    // Load-bearing: without `getOrLoad`, each concurrent caller sees a
    // cache miss and issues its own `dataSources.query`. With it, the
    // first caller installs a pending promise that every subsequent
    // caller inside the same tick awaits.
    const client = createMockClient()
    client.dataSources.query.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                results: [projectPage("p1", "alpha")],
                has_more: false,
                next_cursor: null,
              }),
            5
          )
        )
    )
    const service = new ProjectService(client, DB)

    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.findByName("alpha"))
    )

    expect(results.map((r) => r?.id)).toEqual(Array(8).fill("p1"))
    expect(client.dataSources.query).toHaveBeenCalledTimes(1)
  })
})
