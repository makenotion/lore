import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { FactService } from "./fact.js"
import { TRACKING_PREDICATES, type DatabaseRef } from "../types.js"

const db: DatabaseRef = {
  databaseId: "facts-db",
  dataSourceId: "facts-ds",
}

function buildFactPage(overrides: Partial<PageObjectResponse> = {}): PageObjectResponse {
  const properties: Record<string, unknown> = {
    Subject: { type: "title", title: [{ plain_text: "S" }] },
    Predicate: { type: "select", select: { name: "uses" } },
    Object: { type: "rich_text", rich_text: [{ plain_text: "O" }] },
    Project: { type: "relation", relation: [] },
    "Valid From": { type: "date", date: { start: "2026-01-01" } },
    "Valid Until": { type: "date", date: null },
    "Review By": { type: "date", date: null },
    Source: { type: "relation", relation: [] },
    Confidence: { type: "select", select: { name: "certain" } },
  }
  return {
    object: "page",
    id: "fact-id",
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-01-01T00:00:00.000Z",
    archived: false,
    parent: { type: "data_source_id", data_source_id: db.dataSourceId },
    url: "https://notion.so/fact-id",
    properties: properties as PageObjectResponse["properties"],
    ...overrides,
  } as PageObjectResponse
}

function createClient(responses: Array<{
  results: PageObjectResponse[]
  has_more?: boolean
  next_cursor?: string | null
}>) {
  const calls: Array<Record<string, unknown>> = []
  let i = 0
  const querySpy = vi.fn(async (args: Record<string, unknown>) => {
    calls.push(args)
    const response = responses[Math.min(i, responses.length - 1)]
    i += 1
    return {
      results: response.results,
      has_more: response.has_more ?? false,
      next_cursor: response.next_cursor ?? null,
    }
  })
  return {
    client: { dataSources: { query: querySpy } } as unknown as Client,
    querySpy,
    calls,
  }
}

describe("FactService.listRecent", () => {
  it("runs single-page even when the Notion response reports has_more=true", async () => {
    // The wake-up caller cannot absorb pagination latency on every hook fire.
    // Even if the server signals more results are available, listRecent must
    // return what it has and stop. The caller still needs a signal that more
    // exist — it comes back via `hasMore`, not a second Notion call.
    const { client, querySpy } = createClient([
      {
        results: [buildFactPage({ id: "f1" })],
        has_more: true,
        next_cursor: "should-be-ignored",
      },
    ])
    const service = new FactService(client, db)

    const { items, hasMore } = await service.listRecent({ projectId: "p1", limit: 25 })

    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(items).toHaveLength(1)
    expect(hasMore).toBe(true)
  })

  it("returns hasMore=false when the Notion response fits in a single page", async () => {
    const { client } = createClient([
      { results: [buildFactPage({ id: "f1" })], has_more: false },
    ])
    const service = new FactService(client, db)

    const { hasMore } = await service.listRecent({ projectId: "p1" })

    expect(hasMore).toBe(false)
  })

  it("emits an AND-of-does_not_equal filter per excluded predicate", async () => {
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.listRecent({
      projectId: "p1",
      excludePredicates: TRACKING_PREDICATES,
      limit: 25,
    })

    const filter = calls[0].filter as { and: Array<Record<string, unknown>> }
    expect(filter).toHaveProperty("and")
    // Expect one does_not_equal clause per tracking predicate.
    const predicateClauses = filter.and.filter(
      (c) => (c as { property?: string }).property === "Predicate",
    )
    expect(predicateClauses).toHaveLength(TRACKING_PREDICATES.length)
    for (const clause of predicateClauses) {
      expect(clause).toMatchObject({
        property: "Predicate",
        select: { does_not_equal: expect.any(String) },
      })
    }
    const excludedValues = predicateClauses.map(
      (c) => (c as { select: { does_not_equal: string } }).select.does_not_equal,
    )
    expect(excludedValues.sort()).toEqual([...TRACKING_PREDICATES].sort())
  })

  it("clamps page_size to Notion's 100-row ceiling", async () => {
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.listRecent({ projectId: "p1", limit: 500 })

    expect(calls[0].page_size).toBe(100)
  })

  it("sorts by created_time descending", async () => {
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.listRecent({ projectId: "p1" })

    expect(calls[0].sorts).toEqual([
      { timestamp: "created_time", direction: "descending" },
    ])
  })

  it("excludes invalidated facts by default via Valid Until is_empty", async () => {
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.listRecent({ projectId: "p1" })

    const filter = calls[0].filter as { and: Array<Record<string, unknown>> }
    const validUntilClause = filter.and.find(
      (c) => (c as { property?: string }).property === "Valid Until",
    )
    expect(validUntilClause).toMatchObject({
      property: "Valid Until",
      date: { is_empty: true },
    })
  })

  it("drops the Valid Until filter when includeInvalidated is true", async () => {
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.listRecent({ projectId: "p1", includeInvalidated: true })

    const filter = calls[0].filter as Record<string, unknown>
    // With invalidation filter gone and only the project scope remaining,
    // the compound `and` wrapper collapses to a single filter object.
    const clauses: Array<Record<string, unknown>> = Array.isArray(filter.and)
      ? (filter.and as Array<Record<string, unknown>>)
      : [filter]
    const hasValidUntil = clauses.some(
      (c) => (c as { property?: string }).property === "Valid Until",
    )
    expect(hasValidUntil).toBe(false)
  })
})
