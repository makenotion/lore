import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { MemoryService, pageToMemory } from "./memory.js"
import type { DatabaseRef } from "../types.js"

/**
 * Build a synthetic `PageObjectResponse` with only the properties listed.
 * Everything else is omitted — mirrors how pre-migration pages look to the
 * Notion API (missing columns simply don't appear in `properties`).
 */
function buildPage(
  properties: Record<string, unknown>,
  overrides: Partial<PageObjectResponse> = {}
): PageObjectResponse {
  return {
    object: "page",
    id: "page-id-123",
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-02-01T00:00:00.000Z",
    archived: false,
    properties: properties as PageObjectResponse["properties"],
    parent: { type: "database_id", database_id: "db-id" },
    url: "https://notion.so/page-id-123",
    ...overrides,
  } as PageObjectResponse
}

describe("pageToMemory — backward compatibility with pre-migration pages", () => {
  it("returns safe defaults for every new field when all new properties are absent", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Old note" }] },
      Project: { type: "relation", relation: [] },
      Topic: { type: "relation", relation: [] },
      Source: { type: "select", select: { name: "manual" } },
      Author: { type: "rich_text", rich_text: [] },
      Agent: { type: "rich_text", rich_text: [] },
      Tags: { type: "multi_select", multi_select: [] },
      Session: { type: "rich_text", rich_text: [] },
    })

    const memory = pageToMemory(page, "body content")

    expect(memory.title).toBe("Old note")
    expect(memory.source).toBe("manual")

    // Every new field must default gracefully:
    expect(memory.kind).toBe("note")
    expect(memory.status).toBe("informational")
    expect(memory.confidence).toBe("certain")
    expect(memory.reviewBy).toBeNull()
    expect(memory.decidedAt).toBeNull()
    expect(memory.supersedesIds).toEqual([])
    expect(memory.affectsIds).toEqual([])
    expect(memory.alternatives).toBe("")
    expect(memory.consequences).toBe("")
    expect(memory.content).toBe("body content")
  })

  it("does not throw when the properties object is completely empty", () => {
    const page = buildPage({})
    expect(() => pageToMemory(page)).not.toThrow()

    const memory = pageToMemory(page)
    expect(memory.title).toBe("")
    expect(memory.projectIds).toEqual([])
    expect(memory.topicId).toBeNull()
    expect(memory.source).toBe("manual")
    expect(memory.kind).toBe("note")
    expect(memory.status).toBe("informational")
    expect(memory.confidence).toBe("certain")
    expect(memory.content).toBe("")
  })
})

describe("pageToMemory — fully populated decision page", () => {
  it("extracts every new field correctly when all properties are present", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Use DecisionService" }] },
      Project: {
        type: "relation",
        relation: [{ id: "proj-1" }, { id: "proj-2" }],
      },
      Topic: { type: "relation", relation: [{ id: "topic-1" }] },
      Source: { type: "select", select: { name: "conversation" } },
      Kind: { type: "select", select: { name: "decision" } },
      Status: { type: "select", select: { name: "accepted" } },
      Confidence: { type: "select", select: { name: "likely" } },
      "Review By": { type: "date", date: { start: "2026-10-20" } },
      "Decided At": { type: "date", date: { start: "2026-04-20" } },
      Supersedes: { type: "relation", relation: [{ id: "old-decision" }] },
      Affects: {
        type: "relation",
        relation: [{ id: "affected-1" }, { id: "affected-2" }],
      },
      Alternatives: {
        type: "rich_text",
        rich_text: [{ plain_text: "Alt A; Alt B" }],
      },
      Consequences: {
        type: "rich_text",
        rich_text: [{ plain_text: "Must migrate extractors" }],
      },
      Author: { type: "rich_text", rich_text: [{ plain_text: "hsalman" }] },
      Agent: { type: "rich_text", rich_text: [{ plain_text: "claude" }] },
      Tags: {
        type: "multi_select",
        multi_select: [{ name: "architecture" }, { name: "core" }],
      },
      Session: { type: "rich_text", rich_text: [{ plain_text: "sess-42" }] },
    })

    const memory = pageToMemory(page, "Rationale prose.")

    expect(memory.title).toBe("Use DecisionService")
    expect(memory.projectIds).toEqual(["proj-1", "proj-2"])
    expect(memory.topicId).toBe("topic-1")
    expect(memory.source).toBe("conversation")
    expect(memory.kind).toBe("decision")
    expect(memory.status).toBe("accepted")
    expect(memory.confidence).toBe("likely")
    expect(memory.reviewBy).toBe("2026-10-20")
    expect(memory.decidedAt).toBe("2026-04-20")
    expect(memory.supersedesIds).toEqual(["old-decision"])
    expect(memory.affectsIds).toEqual(["affected-1", "affected-2"])
    expect(memory.alternatives).toBe("Alt A; Alt B")
    expect(memory.consequences).toBe("Must migrate extractors")
    expect(memory.author).toBe("hsalman")
    expect(memory.agent).toBe("claude")
    expect(memory.tags).toEqual(["architecture", "core"])
    expect(memory.session).toBe("sess-42")
    expect(memory.content).toBe("Rationale prose.")
  })
})

describe("MemoryService.search", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildSearchPage(
    id: string,
    title: string,
    opts: {
      parentDb?: string
      parentDataSource?: string
      parentType?: "database_id" | "data_source_id"
      tags?: string[]
    } = {},
  ): PageObjectResponse {
    const parentType = opts.parentType ?? "database_id"
    const parent =
      parentType === "data_source_id"
        ? {
            type: "data_source_id" as const,
            data_source_id: opts.parentDataSource ?? db.dataSourceId,
          }
        : {
            type: "database_id" as const,
            database_id: opts.parentDb ?? db.databaseId,
          }
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: {
          type: "multi_select",
          multi_select: (opts.tags ?? []).map((name) => ({ name })),
        },
      },
      { id, parent } as Partial<PageObjectResponse>,
    )
  }

  it("requests relevance-ranked results — no sort parameter — with a 100-page fetch window", async () => {
    const searchSpy = vi.fn(async (_args: Record<string, unknown>) => ({ results: [] }))
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "" }))
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: retrieveMarkdownSpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await service.search({ query: "autolabel", limit: 5 })

    expect(searchSpy).toHaveBeenCalledTimes(1)
    const args = searchSpy.mock.calls[0][0]
    expect(args["query"]).toBe("autolabel")
    expect(args["page_size"]).toBe(100)
    // Critical: without `sort`, Notion ranks by relevance. With `sort`, it
    // ranks by the given timestamp and demotes the query to a filter.
    expect(args).not.toHaveProperty("sort")
  })

  it("filters to the Memories database and caps at the caller's limit before fetching markdown", async () => {
    const client = {
      search: vi.fn(async () => ({
        results: [
          // Three pages belong to the memories DB.
          buildSearchPage("mem-1", "Mem one"),
          buildSearchPage("mem-2", "Mem two"),
          buildSearchPage("mem-3", "Mem three"),
          // Two pages from a different DB should be filtered out.
          buildSearchPage("other-1", "Other one", { parentDb: "some-other-db" }),
          buildSearchPage("other-2", "Other two", { parentDb: "some-other-db" }),
        ],
      })),
      pages: {
        retrieveMarkdown: vi.fn(async () => ({ markdown: "body" })),
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({ query: "q", limit: 2 })

    expect(results.map((m) => m.id)).toEqual(["mem-1", "mem-2"])
    // Markdown fetched only for the capped subset — not wasted on filtered-out
    // or over-limit results.
    expect(
      (client.pages.retrieveMarkdown as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(2)
  })

  it("skips the per-page markdown fetch when includeContent: false", async () => {
    // Callers that render only title / date / tags (e.g. the hook wake-up
    // path's related-memories section) pass includeContent: false to avoid
    // N+1 `retrieveMarkdown` round-trips on a hot path.
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "body" }))
    const client = {
      search: vi.fn(async () => ({
        results: [
          buildSearchPage("mem-1", "Mem one"),
          buildSearchPage("mem-2", "Mem two"),
        ],
      })),
      pages: { retrieveMarkdown: retrieveMarkdownSpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({ query: "q", includeContent: false })

    expect(results).toHaveLength(2)
    expect(results.every((m) => m.content === "")).toBe(true)
    expect(retrieveMarkdownSpy).not.toHaveBeenCalled()
  })

  it("accepts pages with a data_source_id parent (Notion SDK v5 shape)", async () => {
    // Regression test: Notion's `client.search()` returns pages with
    // `parent.type === "data_source_id"` in v5 workspaces — which is the
    // shape observed in production. If the filter only accepted
    // `database_id` parents it would silently return zero results for every
    // real query. Match `parent.data_source_id` against `db.dataSourceId`.
    const client = {
      search: vi.fn(async () => ({
        results: [
          buildSearchPage("ds-hit", "data-source match", {
            parentType: "data_source_id",
          }),
          buildSearchPage("db-hit", "database match", {
            parentType: "database_id",
          }),
          buildSearchPage("ds-miss", "unrelated data source", {
            parentType: "data_source_id",
            parentDataSource: "other-ds",
          }),
        ],
      })),
      pages: {
        retrieveMarkdown: vi.fn(async () => ({ markdown: "" })),
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({ query: "q", limit: 10 })

    expect(results.map((m) => m.id).sort()).toEqual(["db-hit", "ds-hit"])
  })
})

describe("pageToMemory — partial migration (mixed defaults + real values)", () => {
  it("handles a page that has Kind but not Status (intermediate migration state)", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Half-migrated" }] },
      Kind: { type: "select", select: { name: "runbook" } },
      // Status intentionally absent
    })

    const memory = pageToMemory(page)
    expect(memory.kind).toBe("runbook")
    expect(memory.status).toBe("informational") // default kicks in
    expect(memory.confidence).toBe("certain")
  })

  it("handles a page with Status: null select (column exists, no value chosen)", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Status-cleared" }] },
      Kind: { type: "select", select: { name: "decision" } },
      Status: { type: "select", select: null },
    })

    const memory = pageToMemory(page)
    expect(memory.kind).toBe("decision")
    expect(memory.status).toBe("informational") // null select → fallback
  })

  it("handles a page where date properties exist but are unset", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Dateless" }] },
      "Review By": { type: "date", date: null },
      "Decided At": { type: "date", date: null },
    })

    const memory = pageToMemory(page)
    expect(memory.reviewBy).toBeNull()
    expect(memory.decidedAt).toBeNull()
  })
})
