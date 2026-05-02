import { describe, expect, it, vi } from "vitest"
import type { GetPagePropertyResponse, PageObjectResponse } from "@notionhq/client"
import {
  hydrateRelationProperties,
  hydrateRelationPropertiesForPages,
  RELATION_PROPERTY_MAX_PAGES,
  retrieveRelationPropertyIds,
} from "./relation-properties.js"

type PropertyValue = PageObjectResponse["properties"][string]

function relationProperty(
  id: string,
  relationIds: string[],
  hasMore?: boolean
): PropertyValue {
  return {
    id,
    type: "relation",
    relation: relationIds.map((relationId) => ({ id: relationId })),
    has_more: hasMore,
  } as unknown as PropertyValue
}

function relationListResponse(input: {
  ids: string[]
  hasMore?: boolean
  nextCursor?: string | null
}): GetPagePropertyResponse {
  return {
    object: "list",
    type: "property_item",
    property_item: {
      id: "project",
      type: "relation",
      relation: {},
      next_url: input.nextCursor ? "https://api.notion.test/next" : null,
    },
    results: input.ids.map((id) => ({
      object: "property_item",
      id: "project",
      type: "relation",
      relation: { id },
    })),
    has_more: input.hasMore ?? false,
    next_cursor: input.nextCursor ?? null,
  } as GetPagePropertyResponse
}

function relationPropertyItemResponse(id: string): GetPagePropertyResponse {
  return {
    object: "property_item",
    id: "project",
    type: "relation",
    relation: { id },
  } as GetPagePropertyResponse
}

function pageWithProperties(
  properties: PageObjectResponse["properties"]
): PageObjectResponse {
  return {
    object: "page",
    id: "page-1",
    archived: false,
    in_trash: false,
    created_time: "2026-05-02T00:00:00.000Z",
    last_edited_time: "2026-05-02T00:00:00.000Z",
    created_by: { object: "user", id: "user-1" },
    last_edited_by: { object: "user", id: "user-1" },
    cover: null,
    icon: null,
    parent: { type: "database_id", database_id: "db-1" },
    properties,
    url: "https://notion.test/page-1",
    public_url: null,
    is_locked: false,
  } as PageObjectResponse
}

describe("retrieveRelationPropertyIds", () => {
  it("returns inline relation ids without calling Notion when the property is complete", async () => {
    const retrieve = vi.fn()
    const client = { pages: { properties: { retrieve } } }
    const ids = await retrieveRelationPropertyIds(
      client,
      "page-1",
      relationProperty("project", ["project-a", "project-b"])
    )

    expect(ids).toEqual(["project-a", "project-b"])
    expect(retrieve).not.toHaveBeenCalled()
  })

  it("does not hydrate exactly 25 inline relation ids when Notion marks the property complete", async () => {
    const retrieve = vi.fn()
    const client = { pages: { properties: { retrieve } } }
    const inlineIds = Array.from({ length: 25 }, (_, i) => `project-${i}`)

    const ids = await retrieveRelationPropertyIds(
      client,
      "page-1",
      relationProperty("project", inlineIds, false)
    )

    expect(ids).toEqual(inlineIds)
    expect(retrieve).not.toHaveBeenCalled()
  })

  it("hydrates a relation property when Notion marks the inline response as truncated", async () => {
    const ids26 = Array.from({ length: 26 }, (_, i) => `project-${i}`)
    const retrieve = vi.fn().mockResolvedValueOnce(
      relationListResponse({
        ids: ids26,
        hasMore: false,
      })
    )
    const client = { pages: { properties: { retrieve } } }

    const ids = await retrieveRelationPropertyIds(
      client,
      "page-1",
      relationProperty("project", ids26.slice(0, 25), true)
    )

    expect(ids).toEqual(ids26)
    expect(retrieve).toHaveBeenCalledTimes(1)
  })

  it("paginates relation property items across multiple cursors", async () => {
    const retrieve = vi
      .fn()
      .mockResolvedValueOnce(
        relationListResponse({
          ids: ["project-a", "project-b"],
          hasMore: true,
          nextCursor: "cursor-2",
        })
      )
      .mockResolvedValueOnce(
        relationListResponse({
          ids: ["project-c"],
          hasMore: true,
          nextCursor: "cursor-3",
        })
      )
      .mockResolvedValueOnce(
        relationListResponse({
          ids: ["project-d"],
          hasMore: false,
        })
      )
    const client = { pages: { properties: { retrieve } } }

    const ids = await retrieveRelationPropertyIds(
      client,
      "page-1",
      relationProperty("project", ["project-a"], true)
    )

    expect(ids).toEqual(["project-a", "project-b", "project-c", "project-d"])
    expect(retrieve).toHaveBeenNthCalledWith(1, {
      page_id: "page-1",
      property_id: "project",
      page_size: 100,
      start_cursor: undefined,
    })
    expect(retrieve).toHaveBeenNthCalledWith(2, {
      page_id: "page-1",
      property_id: "project",
      page_size: 100,
      start_cursor: "cursor-2",
    })
    expect(retrieve).toHaveBeenNthCalledWith(3, {
      page_id: "page-1",
      property_id: "project",
      page_size: 100,
      start_cursor: "cursor-3",
    })
  })

  it("throws when a truncated relation property does not return a list response", async () => {
    const retrieve = vi
      .fn()
      .mockResolvedValueOnce(relationPropertyItemResponse("project-a"))
    const client = { pages: { properties: { retrieve } } }

    await expect(
      retrieveRelationPropertyIds(
        client,
        "page-1",
        relationProperty("project", ["project-a"], true)
      )
    ).rejects.toThrow(/Expected relation property project on page page-1/)
  })

  it("throws when relation pagination exceeds the hard page cap", async () => {
    let callCount = 0
    const retrieve = vi.fn().mockImplementation(async () => {
      callCount += 1
      return relationListResponse({
        ids: [`project-${callCount}`],
        hasMore: true,
        nextCursor: `cursor-${callCount}`,
      })
    })
    const client = { pages: { properties: { retrieve } } }

    await expect(
      retrieveRelationPropertyIds(
        client,
        "page-1",
        relationProperty("project", ["project-a"], true)
      )
    ).rejects.toThrow(
      `Relation property project on page page-1 exceeded ${RELATION_PROPERTY_MAX_PAGES} pages`
    )
    expect(retrieve).toHaveBeenCalledTimes(RELATION_PROPERTY_MAX_PAGES)
  })

  it("throws when Notion repeats a relation-property cursor", async () => {
    const retrieve = vi.fn().mockResolvedValue(
      relationListResponse({
        ids: ["project-a"],
        hasMore: true,
        nextCursor: "same-cursor",
      })
    )
    const client = { pages: { properties: { retrieve } } }

    await expect(
      retrieveRelationPropertyIds(
        client,
        "page-1",
        relationProperty("project", ["project-a"], true)
      )
    ).rejects.toThrow(/same next cursor/)
    expect(retrieve).toHaveBeenCalledTimes(2)
  })
})

describe("hydrateRelationProperties", () => {
  it("replaces truncated inline relation arrays with the full paginated set", async () => {
    const retrieve = vi.fn().mockResolvedValue(
      relationListResponse({
        ids: ["project-a", "project-b", "project-c"],
      })
    )
    const client = { pages: { properties: { retrieve } } }
    const page = pageWithProperties({
      Project: relationProperty("project", ["project-a"], true),
    })

    const hydrated = await hydrateRelationProperties(client, page, ["Project"])

    expect(hydrated).not.toBe(page)
    expect(hydrated.properties["Project"]).toMatchObject({
      type: "relation",
      relation: [{ id: "project-a" }, { id: "project-b" }, { id: "project-c" }],
    })
    expect(page.properties["Project"]).toMatchObject({
      relation: [{ id: "project-a" }],
    })
  })

  it("bounds concurrent page hydration", async () => {
    let active = 0
    let maxActive = 0
    const retrieve = vi
      .fn()
      .mockImplementation(async ({ page_id }: { page_id: string }) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 0))
        active -= 1
        return relationListResponse({ ids: [`${page_id}-project`] })
      })
    const client = { pages: { properties: { retrieve } } }
    const pages = Array.from({ length: 8 }, (_, index) =>
      pageWithProperties({
        Project: relationProperty("project", [`inline-${index}`], true),
      })
    ).map((page, index) => ({ ...page, id: `page-${index}` }))

    const hydrated = await hydrateRelationPropertiesForPages(client, pages, ["Project"])

    expect(hydrated).toHaveLength(8)
    expect(retrieve).toHaveBeenCalledTimes(8)
    expect(maxActive).toBeLessThanOrEqual(3)
  })
})
