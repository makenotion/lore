import { describe, expect, it, vi } from "vitest"
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
    dataSources: {
      query: vi.fn(),
    },
  } as unknown as Client & {
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
