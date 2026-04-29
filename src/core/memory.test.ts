import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import {
  MemoryService,
  pageToMemory,
  tieBreakingRrfCompare,
  type RrfEntry,
} from "./memory.js"
import type { DatabaseRef } from "../types.js"
import { buildMemoryProps } from "../notion/schema.js"

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
    expect(memory.doneAt).toBeNull()
    expect(memory.decidedAt).toBeNull()
    expect(memory.lastReferencedAt).toBeNull()
    expect(memory.supersedesIds).toEqual([])
    expect(memory.affectsIds).toEqual([])
    expect(memory.alternatives).toBe("")
    expect(memory.consequences).toBe("")
    expect(memory.synopsis).toBe("")
    expect(memory.confidenceScore).toBeNull()
    expect(memory.lastReferencedAt).toBeNull()
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
      "Done At": { type: "date", date: { start: "2026-04-25" } },
      "Decided At": { type: "date", date: { start: "2026-04-20" } },
      "Last Referenced At": { type: "date", date: { start: "2026-04-29" } },
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
      Keywords: {
        type: "rich_text",
        rich_text: [{ plain_text: "pr-25701 MailboxViewStore.swift" }],
      },
      Synopsis: {
        type: "rich_text",
        rich_text: [{ plain_text: "Adopt DecisionService for the rationale chain." }],
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
    expect(memory.doneAt).toBe("2026-04-25")
    expect(memory.decidedAt).toBe("2026-04-20")
    expect(memory.lastReferencedAt).toBe("2026-04-29")
    expect(memory.supersedesIds).toEqual(["old-decision"])
    expect(memory.affectsIds).toEqual(["affected-1", "affected-2"])
    expect(memory.alternatives).toBe("Alt A; Alt B")
    expect(memory.consequences).toBe("Must migrate extractors")
    expect(memory.author).toBe("hsalman")
    expect(memory.agent).toBe("claude")
    expect(memory.tags).toEqual(["architecture", "core"])
    expect(memory.keywords).toBe("pr-25701 MailboxViewStore.swift")
    expect(memory.synopsis).toBe("Adopt DecisionService for the rationale chain.")
    expect(memory.session).toBe("sess-42")
    expect(memory.content).toBe("Rationale prose.")
  })

  it("extracts Confidence Score and Last Referenced At when present", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Touched memory" }] },
      "Confidence Score": { type: "number", number: 0.72 },
      "Last Referenced At": { type: "date", date: { start: "2026-04-29" } },
    })

    const memory = pageToMemory(page)
    expect(memory.confidenceScore).toBe(0.72)
    expect(memory.lastReferencedAt).toBe("2026-04-29")
  })

  it("preserves null when Confidence Score is present-but-empty", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Cleared" }] },
      "Confidence Score": { type: "number", number: null },
      "Last Referenced At": { type: "date", date: null },
    })

    const memory = pageToMemory(page)
    expect(memory.confidenceScore).toBeNull()
    expect(memory.lastReferencedAt).toBeNull()
  })
})

describe("Confidence Score property round-trip (#01)", () => {
  it("returns null on a pre-migration page with no Confidence Score column", () => {
    // A vault upgraded from <0.8.0 has no `Confidence Score` column on
    // its Memories DB pages. `pageToMemory` must surface this as `null`
    // so #08's RRF integration can branch on "never scored" without an
    // extra schema check.
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Pre-migration" }] },
    })
    expect(pageToMemory(page).confidenceScore).toBeNull()
  })

  it("extracts a populated Confidence Score number", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Scored" }] },
      "Confidence Score": { type: "number", number: 0.85 },
    })
    expect(pageToMemory(page).confidenceScore).toBe(0.85)
  })

  it("returns null when the column exists but is empty on Notion's side", () => {
    // A row whose Confidence Score was explicitly cleared (e.g. by an
    // operator or the #11 migration) round-trips as `null`. Distinct
    // from "scored to zero" — the floor of the range, which must remain
    // a number through pageToMemory.
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Cleared" }] },
      "Confidence Score": { type: "number", number: null },
    })
    expect(pageToMemory(page).confidenceScore).toBeNull()
  })

  it("preserves zero as a populated value (not collapsed to null)", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Floor" }] },
      "Confidence Score": { type: "number", number: 0 },
    })
    expect(pageToMemory(page).confidenceScore).toBe(0)
  })

  it("round-trips a Confidence Score through buildMemoryProps + pageToMemory", () => {
    const built = buildMemoryProps({ title: "x", confidenceScore: 0.42 }) as Record<
      string,
      { number: number | null }
    >
    expect(built["Confidence Score"]).toEqual({ number: 0.42 })

    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "x" }] },
      "Confidence Score": { type: "number", number: built["Confidence Score"].number },
    })
    expect(pageToMemory(page).confidenceScore).toBe(0.42)
  })
})

describe("MemoryService.create — Confidence Score write semantics (#01)", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function makeCreateClient() {
    const createSpy = vi.fn(
      async (_args: { parent: unknown; properties: Record<string, unknown> }) => ({
        object: "page",
        id: "mem-1",
        created_time: "2026-04-20T00:00:00.000Z",
        last_edited_time: "2026-04-20T00:00:00.000Z",
        archived: false,
        properties: { Title: { type: "title", title: [{ plain_text: "x" }] } },
        parent: { type: "database_id", database_id: db.databaseId },
        url: "",
      }),
    )
    const updateMarkdownSpy = vi.fn(async () => ({}))
    const client = {
      pages: { create: createSpy, updateMarkdown: updateMarkdownSpy },
    } as unknown as Client
    return { client, createSpy }
  }

  it("writes `{ number: <value> }` when confidenceScore is a number", async () => {
    const { client, createSpy } = makeCreateClient()
    const service = new MemoryService(client, db)

    await service.create({ title: "x", content: "", confidenceScore: 0.85 })

    expect(createSpy).toHaveBeenCalledTimes(1)
    const props = createSpy.mock.calls[0]![0].properties
    expect(props["Confidence Score"]).toEqual({ number: 0.85 })
  })

  it("omits Confidence Score when the input does not include it", async () => {
    // Production callers leave confidenceScore unset — the column is
    // system-managed via #03/#06. Omission must produce a create payload
    // with no `Confidence Score` key so Notion stores `null` (the
    // "never scored" sentinel) rather than a default value.
    const { client, createSpy } = makeCreateClient()
    const service = new MemoryService(client, db)

    await service.create({ title: "x", content: "" })

    const props = createSpy.mock.calls[0]![0].properties
    expect("Confidence Score" in props).toBe(false)
  })
})

describe("MemoryService.update — Confidence Score write semantics (#01)", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function makeUpdateClient() {
    const updateSpy = vi.fn(async (_args: { page_id: string; properties: Record<string, unknown> }) => ({}))
    const retrieveSpy = vi.fn(async () => ({
      object: "page",
      id: "mem-1",
      created_time: "2026-04-20T00:00:00.000Z",
      last_edited_time: "2026-04-20T00:00:00.000Z",
      archived: false,
      properties: {
        Title: { type: "title", title: [{ plain_text: "x" }] },
      },
      parent: { type: "database_id", database_id: db.databaseId },
      url: "",
    }))
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "" }))
    const client = {
      pages: {
        update: updateSpy,
        retrieve: retrieveSpy,
        retrieveMarkdown: retrieveMarkdownSpy,
      },
    } as unknown as Client
    return { client, updateSpy, retrieveSpy }
  }

  it("writes `{ number: <value> }` when confidenceScore is a number", async () => {
    const { client, updateSpy } = makeUpdateClient()
    const service = new MemoryService(client, db)

    await service.update("mem-1", { confidenceScore: 0.85 })

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const props = updateSpy.mock.calls[0]![0].properties
    expect(props["Confidence Score"]).toEqual({ number: 0.85 })
  })

  it("writes `{ number: null }` when confidenceScore is explicitly null (clear)", async () => {
    const { client, updateSpy } = makeUpdateClient()
    const service = new MemoryService(client, db)

    await service.update("mem-1", { confidenceScore: null })

    const props = updateSpy.mock.calls[0]![0].properties
    expect(props["Confidence Score"]).toEqual({ number: null })
  })

  it("does NOT touch the column when confidenceScore is omitted (undefined leaves it untouched)", async () => {
    // A `Title`-only update must leave the Confidence Score column
    // entirely alone — both the touch-on-read helper (#03) and the
    // contradiction-decrement path (#06) rely on this distinction so
    // they can co-exist with title/body edits without clobbering the
    // system-managed signal.
    const { client, updateSpy } = makeUpdateClient()
    const service = new MemoryService(client, db)

    await service.update("mem-1", { title: "new title" })

    const props = updateSpy.mock.calls[0]![0].properties
    expect("Confidence Score" in props).toBe(false)
  })

  it("preserves zero as a valid write target", async () => {
    const { client, updateSpy } = makeUpdateClient()
    const service = new MemoryService(client, db)

    await service.update("mem-1", { confidenceScore: 0 })

    const props = updateSpy.mock.calls[0]![0].properties
    expect(props["Confidence Score"]).toEqual({ number: 0 })
  })
})

describe("Synopsis property round-trip", () => {
  it("round-trips a Synopsis string through buildMemoryProps + pageToMemory", () => {
    const synopsis = "Adopt DecisionService so rationale chains stay traversable."
    const built = buildMemoryProps({ title: "x", synopsis }) as Record<
      string,
      { rich_text: Array<{ text: { content: string } }> }
    >

    const richTextProp = built["Synopsis"]
    expect(richTextProp).toBeDefined()
    expect(richTextProp.rich_text[0].text.content).toBe(synopsis)

    const liveShape = {
      type: "rich_text" as const,
      rich_text: richTextProp.rich_text.map((segment) => ({
        plain_text: segment.text.content,
      })),
    }
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "x" }] },
      Synopsis: liveShape,
    })
    expect(pageToMemory(page).synopsis).toBe(synopsis)
  })

  it("omits the Synopsis property when the input is undefined (unchanged semantic)", () => {
    const built = buildMemoryProps({ title: "x" }) as Record<string, unknown>
    expect("Synopsis" in built).toBe(false)
  })

  it("emits a Synopsis property when explicitly set to empty (clears the field)", () => {
    const built = buildMemoryProps({ title: "x", synopsis: "" }) as Record<string, unknown>
    expect("Synopsis" in built).toBe(true)
  })

  it("returns empty string on a pre-migration page with no Synopsis column", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Old" }] },
    })
    expect(pageToMemory(page).synopsis).toBe("")
  })
})

describe("Confidence Score / Last Referenced At — buildMemoryProps three-state semantics", () => {
  it("omits both properties when the inputs are undefined (untouched)", () => {
    const built = buildMemoryProps({ title: "x" }) as Record<string, unknown>
    expect("Confidence Score" in built).toBe(false)
    expect("Last Referenced At" in built).toBe(false)
  })

  it("emits null clears when explicitly set to null", () => {
    const built = buildMemoryProps({
      title: "x",
      confidenceScore: null,
      lastReferencedAt: null,
    }) as Record<string, unknown>
    expect(built["Confidence Score"]).toEqual({ number: null })
    expect(built["Last Referenced At"]).toEqual({ date: null })
  })

  it("emits the value when set to a number / ISO date", () => {
    const built = buildMemoryProps({
      title: "x",
      confidenceScore: 0.85,
      lastReferencedAt: "2026-04-29",
    }) as Record<string, unknown>
    expect(built["Confidence Score"]).toEqual({ number: 0.85 })
    expect(built["Last Referenced At"]).toEqual({
      date: { start: "2026-04-29" },
    })
  })
})

describe("Keywords property round-trip", () => {
  // The schema builder emits a `rich_text` property with a single text
  // segment. The live Notion response fills that in with `plain_text`; we
  // reconstruct the same shape here so `pageToMemory` can consume it.
  it("round-trips a Keywords string through buildMemoryProps + pageToMemory", () => {
    const keywords = "pr-25701 MailboxViewStore.swift SENTRY-MAIL-123"
    const built = buildMemoryProps({ title: "x", keywords }) as Record<
      string,
      { rich_text: Array<{ text: { content: string } }> }
    >

    const richTextProp = built["Keywords"]
    expect(richTextProp).toBeDefined()
    expect(richTextProp.rich_text[0].text.content).toBe(keywords)

    const liveShape = {
      type: "rich_text" as const,
      rich_text: richTextProp.rich_text.map((segment) => ({
        plain_text: segment.text.content,
      })),
    }
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "x" }] },
      Keywords: liveShape,
    })
    expect(pageToMemory(page).keywords).toBe(keywords)
  })

  it("omits the Keywords property when the input is undefined (unchanged semantic)", () => {
    const built = buildMemoryProps({ title: "x" }) as Record<string, unknown>
    expect("Keywords" in built).toBe(false)
  })

  it("emits a Keywords property when explicitly set to empty (clears the field)", () => {
    const built = buildMemoryProps({ title: "x", keywords: "" }) as Record<string, unknown>
    expect("Keywords" in built).toBe(true)
  })
})

describe("Last Referenced At property round-trip (0.8.0/02)", () => {
  it("round-trips a YYYY-MM-DD value through buildMemoryProps + pageToMemory", () => {
    const built = buildMemoryProps({
      title: "x",
      lastReferencedAt: "2026-04-29",
    }) as Record<string, { date: { start: string } | null }>

    expect(built["Last Referenced At"]).toEqual({ date: { start: "2026-04-29" } })

    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "x" }] },
      "Last Referenced At": {
        type: "date",
        date: { start: "2026-04-29" },
      },
    })
    expect(pageToMemory(page).lastReferencedAt).toBe("2026-04-29")
  })

  it("returns null on a pre-migration page that has no Last Referenced At column", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Old" }] },
    })
    expect(pageToMemory(page).lastReferencedAt).toBeNull()
  })
})

describe("MemoryService.create / update — lastReferencedAt three-state semantics (0.8.0/02)", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function makeCreateClient() {
    const createSpy = vi.fn(async (_args: { properties: Record<string, unknown> }) => ({
      object: "page",
      id: "new-id",
      created_time: "2026-04-29T00:00:00.000Z",
      last_edited_time: "2026-04-29T00:00:00.000Z",
      archived: false,
      properties: {},
      parent: { type: "database_id", database_id: db.databaseId },
      url: "https://notion.so/new-id",
    }))
    const updateSpy = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => ({}),
    )
    const updateMarkdownSpy = vi.fn(async () => ({}))
    const retrieveSpy = vi.fn(async () => ({
      object: "page",
      id: "existing-id",
      created_time: "2026-04-29T00:00:00.000Z",
      last_edited_time: "2026-04-29T00:00:00.000Z",
      archived: false,
      properties: {
        Title: { type: "title", title: [{ plain_text: "x" }] },
      },
      parent: { type: "database_id", database_id: db.databaseId },
      url: "https://notion.so/existing-id",
    }))
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "" }))
    const client = {
      pages: {
        create: createSpy,
        update: updateSpy,
        updateMarkdown: updateMarkdownSpy,
        retrieve: retrieveSpy,
        retrieveMarkdown: retrieveMarkdownSpy,
      },
    } as unknown as Client
    return { client, createSpy, updateSpy }
  }

  it("create() writes the Last Referenced At date when lastReferencedAt is provided", async () => {
    const { client, createSpy } = makeCreateClient()
    const service = new MemoryService(client, db)

    await service.create({
      title: "x",
      content: "",
      lastReferencedAt: "2026-04-29",
    })

    const props = createSpy.mock.calls[0]![0].properties as Record<
      string,
      { date: { start: string } | null }
    >
    expect(props["Last Referenced At"]).toEqual({ date: { start: "2026-04-29" } })
  })

  it("update() with lastReferencedAt: null clears the column (date:null)", async () => {
    const { client, updateSpy } = makeCreateClient()
    const service = new MemoryService(client, db)

    await service.update("existing-id", { lastReferencedAt: null })

    const props = updateSpy.mock.calls[0]![0].properties as Record<
      string,
      { date: { start: string } | null }
    >
    expect(props["Last Referenced At"]).toEqual({ date: null })
  })

  it("update() without lastReferencedAt leaves the column untouched (no Last Referenced At in props)", async () => {
    const { client, updateSpy } = makeCreateClient()
    const service = new MemoryService(client, db)

    await service.update("existing-id", { title: "y" })

    // No update is issued at all when no fields apart from title flow
    // through; the title path triggers a single `pages.update`. The Last
    // Referenced At key must not appear in that payload.
    expect(updateSpy).toHaveBeenCalledTimes(1)
    const props = updateSpy.mock.calls[0]![0].properties as Record<string, unknown>
    expect("Last Referenced At" in props).toBe(false)
  })

  it("update() with lastReferencedAt: 'YYYY-MM-DD' writes the date through", async () => {
    const { client, updateSpy } = makeCreateClient()
    const service = new MemoryService(client, db)

    await service.update("existing-id", { lastReferencedAt: "2026-04-29" })

    const props = updateSpy.mock.calls[0]![0].properties as Record<
      string,
      { date: { start: string } | null }
    >
    expect(props["Last Referenced At"]).toEqual({ date: { start: "2026-04-29" } })
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

  it("semantic mode requests relevance-ranked results — no sort parameter — with a 100-page fetch window", async () => {
    const searchSpy = vi.fn(async (_args: Record<string, unknown>) => ({ results: [] }))
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "" }))
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: retrieveMarkdownSpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await service.search({ query: "autolabel", limit: 5, mode: "semantic" })

    expect(searchSpy).toHaveBeenCalledTimes(1)
    const args = searchSpy.mock.calls[0][0]
    expect(args["query"]).toBe("autolabel")
    expect(args["page_size"]).toBe(100)
    // Critical: without `sort`, Notion ranks by relevance. With `sort`, it
    // ranks by the given timestamp and demotes the query to a filter.
    expect(args).not.toHaveProperty("sort")
  })

  it("semantic mode filters to the Memories database and caps at the caller's limit before fetching markdown", async () => {
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

    const results = await service.search({ query: "q", limit: 2, mode: "semantic" })

    expect(results.map((m) => m.id)).toEqual(["mem-1", "mem-2"])
    // Markdown fetched only for the capped subset — not wasted on filtered-out
    // or over-limit results.
    expect(
      (client.pages.retrieveMarkdown as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(2)
  })

  it("semantic mode skips the per-page markdown fetch when includeContent: false", async () => {
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

    const results = await service.search({
      query: "q",
      includeContent: false,
      mode: "semantic",
    })

    expect(results).toHaveLength(2)
    expect(results.every((m) => m.content === "")).toBe(true)
    expect(retrieveMarkdownSpy).not.toHaveBeenCalled()
  })

  it("semantic mode accepts pages with a data_source_id parent (Notion SDK v5 shape)", async () => {
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

    const results = await service.search({ query: "q", limit: 10, mode: "semantic" })

    expect(results.map((m) => m.id).sort()).toEqual(["db-hit", "ds-hit"])
  })

  it("semantic mode applies kind/status as client-side post-filters (search API has no property filters)", async () => {
    // Regression-safety pin for P3-04: callers passing `kind` / `status`
    // in semantic mode still get post-filtering, since `client.search`
    // ignores property filters. The service narrows the result set to
    // matching kind/status before fetching markdown.
    const decisionPage = buildPage(
      {
        Title: { type: "title", title: [{ plain_text: "decision row" }] },
        Kind: { type: "select", select: { name: "decision" } },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
      },
      { id: "a", parent: { type: "database_id", database_id: db.databaseId } },
    )
    const notePage = buildPage(
      {
        Title: { type: "title", title: [{ plain_text: "note row" }] },
        Kind: { type: "select", select: { name: "note" } },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
      },
      { id: "b", parent: { type: "database_id", database_id: db.databaseId } },
    )
    const searchSpy = vi.fn(async () => ({ results: [decisionPage, notePage] }))
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      kind: "decision",
      mode: "semantic",
      includeContent: false,
    })

    // Only the decision row survives — the note is post-filtered out.
    expect(results.map((m) => m.id)).toEqual(["a"])
    // The post-filter path goes through `client.search`, not `dataSources.query`.
    expect(searchSpy).toHaveBeenCalledTimes(1)
  })
})

describe("MemoryService.search — contains mode", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function makeQueryClient(rows: PageObjectResponse[]) {
    const querySpy = vi.fn(async (_args: Record<string, unknown>) => ({
      results: rows,
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({ results: [] }))
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "body" }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: retrieveMarkdownSpy },
    } as unknown as Client
    return { client, querySpy, searchSpy, retrieveMarkdownSpy }
  }

  function buildContainsPage(id: string, title: string): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
      },
      {
        id,
        parent: {
          type: "data_source_id",
          data_source_id: db.dataSourceId,
        },
      } as Partial<PageObjectResponse>,
    )
  }

  it("issues dataSources.query against the Memories DS — never client.search", async () => {
    const { client, querySpy, searchSpy } = makeQueryClient([
      buildContainsPage("c-1", "PR #25650 autolabel notes"),
    ])
    const service = new MemoryService(client, db)

    await service.search({ query: "autolabel", mode: "contains", includeContent: false })

    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).not.toHaveBeenCalled()
    const args = querySpy.mock.calls[0][0]
    expect(args["data_source_id"]).toBe(db.dataSourceId)
  })

  it("filters by Title OR Keywords OR Synopsis contains for non-empty queries", async () => {
    const { client, querySpy } = makeQueryClient([])
    const service = new MemoryService(client, db)

    await service.search({ query: "PR-25650", mode: "contains" })

    const filter = querySpy.mock.calls[0][0]["filter"] as
      | { or?: Array<Record<string, unknown>>; and?: Array<Record<string, unknown>> }
      | undefined
    // Only the text filter is set — no project/topic/tags/kind/status, so
    // the wrapper isn't an `and`. The single filter is the OR of Title,
    // Keywords, and Synopsis contains. Synopsis joins the precision lane as
    // of issue 0.7.0/04 so an agent-curated short summary that doesn't
    // appear verbatim in a title or keyword string still surfaces.
    expect(filter?.or).toBeDefined()
    expect(filter?.or).toEqual([
      { property: "Title", title: { contains: "PR-25650" } },
      { property: "Keywords", rich_text: { contains: "PR-25650" } },
      { property: "Synopsis", rich_text: { contains: "PR-25650" } },
    ])
  })

  it("composes server-side property filters: kind + status + tags", async () => {
    // Acceptance criterion: kind/status/tags currently post-filter in
    // semantic mode become server-side filters in contains mode.
    const { client, querySpy } = makeQueryClient([])
    const service = new MemoryService(client, db)

    await service.search({
      query: "anything",
      mode: "contains",
      kind: "decision",
      status: "accepted",
      tags: ["architecture", "backend"],
    })

    const filter = querySpy.mock.calls[0][0]["filter"] as {
      and: Array<Record<string, unknown>>
    }
    expect(filter.and).toBeDefined()
    // Kind, Status, Tags-OR, and the title/keywords OR all land in the
    // `and` block — DS-scoped, server-side.
    expect(filter.and).toEqual(
      expect.arrayContaining([
        { property: "Kind", select: { equals: "decision" } },
        { property: "Status", select: { equals: "accepted" } },
        {
          or: [
            { property: "Tags", multi_select: { contains: "architecture" } },
            { property: "Tags", multi_select: { contains: "backend" } },
          ],
        },
      ]),
    )
  })

  it("composes the project-or-unscoped filter when projectId is set", async () => {
    const { client, querySpy } = makeQueryClient([])
    const service = new MemoryService(client, db)

    await service.search({
      query: "x",
      projectId: "proj-1",
      mode: "contains",
    })

    const filter = querySpy.mock.calls[0][0]["filter"] as {
      and: Array<Record<string, unknown>>
    }
    expect(filter.and).toEqual(
      expect.arrayContaining([
        {
          or: [
            { property: "Project", relation: { contains: "proj-1" } },
            { property: "Project", relation: { is_empty: true } },
          ],
        },
      ]),
    )
  })

  it("drops the text clause for an empty query — falls back to property-filter recency listing", async () => {
    const { client, querySpy } = makeQueryClient([])
    const service = new MemoryService(client, db)

    // An empty query in semantic mode degenerates because `contains: ""`
    // matches every row. Skip the text clause entirely so the surrounding
    // property filters drive the result set.
    await service.search({ query: "   ", projectId: "proj-1", mode: "contains" })

    const filter = querySpy.mock.calls[0][0]["filter"] as
      | { and?: Array<Record<string, unknown>>; or?: Array<Record<string, unknown>> }
      | undefined
    // Only the project filter — text clause omitted.
    expect(filter?.or).toBeDefined()
    expect(filter?.or).toEqual([
      { property: "Project", relation: { contains: "proj-1" } },
      { property: "Project", relation: { is_empty: true } },
    ])
  })

  it("sorts by last_edited_time desc and applies the requested limit as page_size", async () => {
    const { client, querySpy } = makeQueryClient([])
    const service = new MemoryService(client, db)

    await service.search({ query: "q", mode: "contains", limit: 7 })

    const args = querySpy.mock.calls[0][0]
    expect(args["sorts"]).toEqual([
      { timestamp: "last_edited_time", direction: "descending" },
    ])
    expect(args["page_size"]).toBe(7)
  })

  it("honors includeContent: false on the materialization step", async () => {
    const { client, retrieveMarkdownSpy } = makeQueryClient([
      buildContainsPage("c-1", "row"),
    ])
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "contains",
      includeContent: false,
    })

    expect(results).toHaveLength(1)
    expect(results[0].content).toBe("")
    expect(retrieveMarkdownSpy).not.toHaveBeenCalled()
  })

  it("text-clause OR composes with surrounding kind/tags filters under `and`", async () => {
    // Pins the structural shape: when surrounding server-side filters
    // (kind / tags) are present, the text-clause OR sits inside the `and`
    // alongside them, untouched. End-to-end superset / parity / eviction
    // invariants — the spec's fixture-vault acceptance — are pinned in
    // `memory-search.integration.test.ts` against a stateful filter
    // evaluator that mirrors Notion's `contains` predicate.
    const { client, querySpy } = makeQueryClient([])
    const service = new MemoryService(client, db)

    await service.search({
      query: "DecisionService",
      mode: "contains",
      kind: "decision",
      tags: ["architecture"],
    })

    const filter = querySpy.mock.calls[0][0]["filter"] as {
      and: Array<Record<string, unknown>>
    }
    expect(filter.and).toEqual(
      expect.arrayContaining([
        {
          or: [
            { property: "Title", title: { contains: "DecisionService" } },
            { property: "Keywords", rich_text: { contains: "DecisionService" } },
            { property: "Synopsis", rich_text: { contains: "DecisionService" } },
          ],
        },
      ]),
    )
  })
})

describe("MemoryService.search — hybrid mode", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildHybridPage(id: string, title: string): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
      },
      {
        id,
        parent: {
          type: "data_source_id",
          data_source_id: db.dataSourceId,
        },
      } as Partial<PageObjectResponse>,
    )
  }

  it("is the default mode and returns contains-only results when contains saturates", async () => {
    // Three contains hits is the threshold; the parallel semantic call
    // still fires (speculative parallelism keeps wall-clock at one
    // round-trip) but its result is discarded.
    const querySpy = vi.fn(async () => ({
      results: [
        buildHybridPage("a", "Title a"),
        buildHybridPage("b", "Title b"),
        buildHybridPage("c", "Title c"),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      // Semantic returns rows that would be merged on under-shoot — but
      // contains saturated, so this whole result is dropped.
      results: [
        buildHybridPage("z-discarded", "would-be-semantic"),
      ],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    // No `mode` argument — exercises the "default to hybrid" branch.
    const results = await service.search({ query: "q", includeContent: false })

    expect(results.map((m) => m.id)).toEqual(["a", "b", "c"])
    // Both queries fire in parallel — the saturation decision happens
    // after Promise.all settles, not before the second call dispatches.
    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).toHaveBeenCalledTimes(1)
  })

  it("hybrid fires both queries in parallel — wall-clock is max(contains, semantic), not sum", async () => {
    // Pin the speculative-parallelism contract: Promise.all dispatches
    // both the dataSources.query and the client.search before either
    // resolves. Without this, an under-shooting hybrid would pay
    // contains-then-semantic sequentially, regressing wall-clock vs the
    // pre-PR single-call path.
    let dispatchedSearchAt = 0
    let containsResolvedAt = 0
    let now = 0
    const querySpy = vi.fn(async () => {
      // The query takes 50 simulated ms to resolve.
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          containsResolvedAt = ++now
          resolve()
        }, 0),
      )
      return {
        results: [buildHybridPage("c-1", "one")],
        has_more: false,
        next_cursor: null,
      }
    })
    const searchSpy = vi.fn(async () => {
      dispatchedSearchAt = ++now
      return { results: [] }
    })
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await service.search({ query: "q", mode: "hybrid", includeContent: false })

    // Search dispatched BEFORE contains resolved → parallel, not sequential.
    expect(dispatchedSearchAt).toBeGreaterThan(0)
    expect(dispatchedSearchAt).toBeLessThan(containsResolvedAt)
  })

  it("falls back to semantic when contains returns < 3 hits and merges unique rows", async () => {
    const querySpy = vi.fn(async () => ({
      results: [buildHybridPage("contains-only", "Substring hit")],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [
        // Same row that contains already returned — should be deduped.
        buildHybridPage("contains-only", "Substring hit"),
        // New rows that contains missed (semantic ranking found body matches).
        buildHybridPage("semantic-only-1", "Something else"),
        buildHybridPage("semantic-only-2", "And another"),
      ],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      limit: 5,
      includeContent: false,
    })

    // Contains row first, then unique semantic rows, no duplicate id.
    expect(results.map((m) => m.id)).toEqual([
      "contains-only",
      "semantic-only-1",
      "semantic-only-2",
    ])
    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).toHaveBeenCalledTimes(1)
  })

  it("hybrid caps the merged result list at the caller's limit", async () => {
    const querySpy = vi.fn(async () => ({
      results: [buildHybridPage("c-1", "one")],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [
        buildHybridPage("s-1", "two"),
        buildHybridPage("s-2", "three"),
        buildHybridPage("s-3", "four"),
        buildHybridPage("s-4", "five"),
      ],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      limit: 2,
      includeContent: false,
    })

    // Limit caps the merged list at 2 even though more semantic rows exist.
    expect(results.map((m) => m.id)).toEqual(["c-1", "s-1"])
  })

  it("hybrid materializes markdown only for the final capped set, never for discarded candidates", async () => {
    // Round-trip protection: under-shooting hybrid with includeContent: true
    // must not fetch markdown for every contains + semantic candidate
    // before the dedupe+cap. Concretely: limit=3, contains returns 1,
    // semantic returns 4 (1 dedup'd) → final merged size is 3 → exactly
    // 3 retrieveMarkdown calls, not 5.
    const querySpy = vi.fn(async () => ({
      results: [buildHybridPage("c-1", "contains row")],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [
        // Dup'd against contains — would pre-fetch markdown if materialization
        // happened in the per-mode helpers.
        buildHybridPage("c-1", "contains row"),
        buildHybridPage("s-1", "semantic 1"),
        buildHybridPage("s-2", "semantic 2"),
        buildHybridPage("s-3", "semantic 3 — over the cap"),
      ],
    }))
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "body" }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: retrieveMarkdownSpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      limit: 3,
      includeContent: true, // forces the materialization path
    })

    expect(results.map((m) => m.id)).toEqual(["c-1", "s-1", "s-2"])
    // 3 markdown fetches — not 5 (1 contains + 4 semantic candidates).
    expect(retrieveMarkdownSpy).toHaveBeenCalledTimes(3)
  })

  it("hybrid fires exactly two data round-trips (one dataSources.query + one client.search)", async () => {
    // Pin the round-trip count contract for hybrid: parallelism keeps
    // wall-clock at one round-trip, but the work is two API calls.
    // Adding a third (e.g. a sequential semantic call after contains)
    // would regress.
    const querySpy = vi.fn(async () => ({
      results: [buildHybridPage("c-1", "one"), buildHybridPage("c-2", "two")],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({ results: [] }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await service.search({ query: "q", mode: "hybrid", includeContent: false })

    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).toHaveBeenCalledTimes(1)
  })
})

describe("MemoryService.search — RRF fusion under saturation threshold", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildHybridPage(id: string, title: string): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
      },
      {
        id,
        parent: {
          type: "data_source_id",
          data_source_id: db.dataSourceId,
        },
      } as Partial<PageObjectResponse>,
    )
  }

  it("a row ranked #1 in both branches sorts above a row ranked #1 in only one branch", async () => {
    // Cross-branch agreement is the signal RRF surfaces. Pre-RRF concat
    // would have placed `contains-only-top` first because contains rows
    // always came first; under RRF, `cross-branch-#1` wins because it
    // scores 2/(60+1) ≈ 0.0328 vs the other rows' 1/61 ≈ 0.0164.
    const querySpy = vi.fn(async () => ({
      results: [
        buildHybridPage("contains-only-top", "first in contains only"),
        buildHybridPage("cross-branch-1", "in both branches"),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [
        buildHybridPage("cross-branch-1", "in both branches"),
        buildHybridPage("semantic-only-top", "first in semantic only"),
      ],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    expect(results.map((m) => m.id)).toEqual([
      "cross-branch-1",
      "contains-only-top",
      "semantic-only-top",
    ])
  })

  it("RRF score for a known input pair matches 1/(60+rank+1)", async () => {
    // Pin the RRF formula. A row ranked #0 in contains and absent from
    // semantic scores exactly 1/61. Surfaces via the explain trace.
    const querySpy = vi.fn(async () => ({
      results: [buildHybridPage("solo-contains", "alone in contains")],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({ results: [] }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { explain } = await service.searchWithExplain({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    expect(explain).toHaveLength(1)
    expect(explain[0].rrfScore).toBeCloseTo(1 / 61, 10)
  })

  it("saturation cutoff still short-circuits at the threshold — RRF does not run", async () => {
    // Three contains hits is the threshold. Pre-RRF behavior is preserved
    // verbatim above the new merge code: the contains rows are returned
    // in their original order, the semantic branch's output is discarded.
    const querySpy = vi.fn(async () => ({
      results: [
        buildHybridPage("c-0", "first"),
        buildHybridPage("c-1", "second"),
        buildHybridPage("c-2", "third"),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      // If RRF ran on this saturating case, semantic-only would float in
      // and the test would fail. The cutoff prevents that.
      results: [buildHybridPage("semantic-only", "would float in under RRF")],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    expect(results.map((m) => m.id)).toEqual(["c-0", "c-1", "c-2"])
  })
})

describe("MemoryService.search — confidence-weighted RRF (issue 0.8.0/08)", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildScoredPage(
    id: string,
    title: string,
    confidenceScore: number | null,
  ): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
        "Confidence Score": { type: "number", number: confidenceScore },
      },
      {
        id,
        parent: {
          type: "data_source_id",
          data_source_id: db.dataSourceId,
        },
      } as Partial<PageObjectResponse>,
    )
  }

  it("hybrid mode: rows with identical ranks but different Confidence Scores sort by confidence", async () => {
    // Both rows: contains-only at rank 0 and rank 1. Without confidence
    // weighting, contains rank 0 wins. With confidence weighting, the
    // 0.9-scored row at rank 1 (score 1/62 * (0.5+0.5*0.9) = 1/62 * 0.95)
    // sorts above the 0.1-scored row at rank 0 (score 1/61 * 0.55) ONLY
    // when the confidence delta is large enough. With these constants:
    //   row-low:  (1/61) * 0.55 ≈ 0.00902
    //   row-high: (1/62) * 0.95 ≈ 0.01532
    // So the higher-confidence rank-1 row beats the lower-confidence
    // rank-0 row. Pin this end-to-end through hybrid's RRF accumulator.
    const querySpy = vi.fn(async () => ({
      results: [
        buildScoredPage("row-low", "rank 0 in contains, decayed", 0.1),
        buildScoredPage("row-high", "rank 1 in contains, fresh", 0.9),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({ results: [] }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    // High-confidence row at rank 1 beats low-confidence row at rank 0
    // because the confidence-factor delta (0.95 vs 0.55) outweighs the
    // single-rank gap.
    expect(results.map((m) => m.id)).toEqual(["row-high", "row-low"])
  })

  it("contains mode: a fresh-rank-3 row sorts above a decayed-rank-1 row", async () => {
    // The acceptance-criteria worked example:
    //   rank 3 with confidence=0.95: (1/64) * (0.5+0.5*0.95) = (1/64) * 0.975 ≈ 0.01523
    //   rank 1 with confidence=0.0:  (1/62) * 0.5 ≈ 0.00806
    // Fresh-rank-3 wins.
    const querySpy = vi.fn(async () => ({
      results: [
        buildScoredPage("decay-rank-0", "alphabetically first, decayed", 0.0),
        buildScoredPage("decay-rank-1", "rank 1, decayed", 0.0),
        buildScoredPage("decay-rank-2", "rank 2, decayed", 0.0),
        buildScoredPage("fresh-rank-3", "rank 3, fresh", 0.95),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy },
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "contains",
      includeContent: false,
    })

    expect(results[0].id).toBe("fresh-rank-3")
  })

  it("unscored rows (Confidence Score = null) yield byte-identical pre-0.8.0 ordering", async () => {
    // Pre-migration vault: every row has `Confidence Score = null`.
    // `confidenceFactor(null) = 1.0` and the all-unscored short-circuit in
    // `rerankByConfidence` returns Notion's input order verbatim. Pinning
    // this preserves the soft-dep contract from the spec: 0.8.0 ships
    // visibly inert until #11's backfill / Phase 2 read-touches populate
    // scores.
    const querySpy = vi.fn(async () => ({
      results: [
        buildScoredPage("first", "first by recency", null),
        buildScoredPage("second", "second by recency", null),
        buildScoredPage("third", "third by recency", null),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy },
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "contains",
      includeContent: false,
    })

    expect(results.map((m) => m.id)).toEqual(["first", "second", "third"])
  })

  it("hybrid mode: scored row at Confidence Score=0.0 has effective weight 0.5*baseWeight, NOT 0.25 (no double application)", async () => {
    // The spec's flagship double-application regression test. In hybrid
    // mode, a row at Confidence Score=0.0 with contains-rank=0 and absent
    // from semantic should score `(1/61) * 1 * 0.5`, not
    // `(1/61) * 1 * 0.5 * 0.5`. If hybrid composed the public single-
    // branch wrappers (which apply the factor in their sort), the factor
    // would be applied here AND in the RRF accumulator — collapsing the
    // documented [0.5, 1.0] floor to [0.25, 1.0]. The fetch/sort split
    // pins this.
    const querySpy = vi.fn(async () => ({
      results: [buildScoredPage("decayed", "decayed row", 0.0)],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({ results: [] }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { explain } = await service.searchWithExplain({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    expect(explain).toHaveLength(1)
    // Single-application: (1/61) * 0.5
    expect(explain[0].rrfScore).toBeCloseTo((1 / 61) * 0.5, 10)
    // Sanity: NOT the double-applied value
    expect(explain[0].rrfScore).not.toBeCloseTo((1 / 61) * 0.5 * 0.5, 10)
    expect(explain[0].confidenceFactor).toBeCloseTo(0.5, 10)
  })

  it("LORE_DISABLE_CONFIDENCE_FACTOR=1 reverts ordering to pre-0.8.0", async () => {
    // Operator escape hatch. With the kill switch set, every row's
    // factor is forced to 1.0 and ordering matches pre-0.8.0 — even on
    // a vault with populated scores. Verified end-to-end on the same
    // contains-mode fixture as the "fresh-rank-3 wins" test above.
    const querySpy = vi.fn(async () => ({
      results: [
        buildScoredPage("decay-rank-0", "alphabetically first, decayed", 0.0),
        buildScoredPage("decay-rank-1", "rank 1, decayed", 0.0),
        buildScoredPage("decay-rank-2", "rank 2, decayed", 0.0),
        buildScoredPage("fresh-rank-3", "rank 3, fresh", 0.95),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy },
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const original = process.env["LORE_DISABLE_CONFIDENCE_FACTOR"]
    process.env["LORE_DISABLE_CONFIDENCE_FACTOR"] = "1"
    try {
      const results = await service.search({
        query: "q",
        mode: "contains",
        includeContent: false,
      })
      // Without the factor, Notion's recency order is preserved.
      expect(results.map((m) => m.id)).toEqual([
        "decay-rank-0",
        "decay-rank-1",
        "decay-rank-2",
        "fresh-rank-3",
      ])
    } finally {
      if (original === undefined) {
        delete process.env["LORE_DISABLE_CONFIDENCE_FACTOR"]
      } else {
        process.env["LORE_DISABLE_CONFIDENCE_FACTOR"] = original
      }
    }
  })

  it("saturation cutoff is unchanged — vault with 3+ high-confidence contains hits skips the RRF merge", async () => {
    // Pin that 0.8.0 does NOT modify the saturation cutoff. The spec
    // explicitly defers any "saturated-but-low-confidence" bypass to
    // a follow-up; the RRF merge runs only when contains under-shoots.
    // Even when contains saturates with low-confidence rows, the
    // semantic branch's output is discarded as before. (The trace's
    // confidenceFactor field still surfaces per-row factors so #09's
    // rendering can still highlight stale rows.)
    const querySpy = vi.fn(async () => ({
      results: [
        buildScoredPage("c-0", "decayed first", 0.0),
        buildScoredPage("c-1", "decayed second", 0.0),
        buildScoredPage("c-2", "decayed third", 0.0),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [buildScoredPage("would-float-in", "fresh semantic hit", 0.95)],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    // Cutoff fires; semantic-only row is discarded.
    expect(results.map((m) => m.id)).toEqual(["c-0", "c-1", "c-2"])
  })

  it("searchWithExplain populates confidenceFactor on every row across every branch", async () => {
    // Pin the SearchExplain shape contract: confidenceFactor is now
    // a required field, populated for every row regardless of branch.
    // The single-branch contains case maps each row to its
    // confidenceFactor; the hybrid RRF case carries it via the trace;
    // the contains-saturated case carries it via the saturation trace.
    const containsRows = [
      buildScoredPage("scored", "fresh row", 0.8),
      buildScoredPage("unscored", "pre-migration row", null),
    ]
    const querySpy = vi.fn(async () => ({
      results: containsRows,
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy },
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { explain } = await service.searchWithExplain({
      query: "q",
      mode: "contains",
      includeContent: false,
    })

    expect(explain).toHaveLength(2)
    for (const e of explain) {
      expect(typeof e.confidenceFactor).toBe("number")
      expect(e.confidenceFactor).toBeGreaterThanOrEqual(0.5)
      expect(e.confidenceFactor).toBeLessThanOrEqual(1.0)
    }
    // Specifically: scored row at 0.8 → factor 0.5 + 0.5*0.8 = 0.9.
    const scored = explain.find((e) => e.memoryId === "scored")!
    expect(scored.confidenceFactor).toBeCloseTo(0.9, 10)
    // Unscored row → factor 1.0 (neutral).
    const unscored = explain.find((e) => e.memoryId === "unscored")!
    expect(unscored.confidenceFactor).toBe(1.0)
  })

  it("score (level 1) dominates page-id (level 4) tie-break — comparator runs on factor-weighted scores", async () => {
    // Pin that the comparator runs on the factor-weighted score (level
    // 1), not on raw `1/(RRF_K + rank + 1)`. Two rows have factor 1.0
    // each (so no factor delta) and the higher rank's higher score
    // dominates the alphabetic page-id fall-through (level 4). If a
    // future refactor wired the comparator to read raw scores from
    // some pre-factor field, the tie-break levels would still trigger
    // but on the wrong values; this test would catch a level-1
    // collision on factor-weighted scores even when none should exist.
    //
    // The factor-driven ordering flip is covered by the companion test
    // below ("decayed rank-0 sorts below fresh rank-1") — that one
    // proves the factor is what changes the ordering. This test pins
    // the comparator's read-side: it operates on the same scored
    // values that come out of the accumulator.
    const querySpy = vi.fn(async () => ({
      results: [
        // Both rows scored at 1.0 → both factors 1.0 → score is purely
        // rank-driven. Use scored rows (not unscored) so the
        // all-unscored short-circuit doesn't fire.
        buildScoredPage("z-id-rank-0", "fresh, alphabetically late", 1.0),
        buildScoredPage("a-id-rank-1", "fresh, alphabetically early", 1.0),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy },
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "contains",
      includeContent: false,
    })

    // (1/61) > (1/62), so z-id-rank-0 wins on level 1 score even
    // though page-id ascending (level 4) would put a-id first. Score
    // dominates because the comparator decides at the first level
    // that produces a non-zero result.
    expect(results.map((m) => m.id)).toEqual(["z-id-rank-0", "a-id-rank-1"])
  })

  it("decayed rank-0 sorts below fresh rank-1 in contains mode — factor flips ordering at level 1", async () => {
    // Companion to the fresh-rank-3 worked example, scoped to the
    // adjacent-rank case the spec calls out: pin that the factor
    // multiplies in BEFORE the score comparison. A row at contains-
    // rank 0 with `Confidence Score = 0.0` (factor = 0.5) scores
    // (1/61) * 0.5 ≈ 0.00820. A row at contains-rank 1 with
    // `Confidence Score = 1.0` (factor = 1.0) scores (1/62) * 1.0
    // ≈ 0.01613. Fresh-rank-1 wins on level 1. If a future refactor
    // accidentally applied the factor AFTER the comparator (or
    // skipped it on the single-branch path), the comparator would
    // see the unweighted scores and rank 0 would win — flipping this
    // assertion.
    //
    // This case is distinct from the fresh-rank-3 test in that it
    // pins the closest possible adjacent-rank flip — the smallest
    // ordering change the factor can produce in a single-branch
    // path — so a future tightening of `CONFIDENCE_FACTOR_MIN` toward
    // 1.0 (which would shrink the factor's effective range and
    // potentially un-flip this case) is caught here at the boundary.
    const querySpy = vi.fn(async () => ({
      results: [
        buildScoredPage("rank-0-decayed", "rank 0, fully decayed", 0.0),
        buildScoredPage("rank-1-fresh", "rank 1, fully trusted", 1.0),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy },
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "contains",
      includeContent: false,
    })

    expect(results.map((m) => m.id)).toEqual(["rank-1-fresh", "rank-0-decayed"])
  })
})

describe("MemoryService.searchByHybridPages — structural pipeline split (issue 0.8.0/08)", () => {
  // Pin that hybrid composes the **raw** fetch helpers, not the public
  // confidence-aware sort wrappers. Going through the public wrappers
  // would double-apply the confidence factor and collapse the
  // documented [0.5, 1.0] floor to [0.25, 1.0] in hybrid mode.
  //
  // We can't spy on private methods directly without exposing them, so
  // the structural test goes through the observable Notion calls: the
  // raw fetch helpers each issue exactly one Notion call (the
  // dataSources.query and client.search respectively). If hybrid called
  // the public sort wrappers, the wrappers would still issue one Notion
  // call each (they pass through to the raw helpers), so the round-trip
  // count is identical. The double-application detection lives in the
  // `confidenceFactor` numerical pin in the test above.

  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildScoredPage(
    id: string,
    confidenceScore: number | null,
  ): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: id }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
        "Confidence Score": { type: "number", number: confidenceScore },
      },
      {
        id,
        parent: {
          type: "data_source_id",
          data_source_id: db.dataSourceId,
        },
      } as Partial<PageObjectResponse>,
    )
  }

  it("hybrid issues exactly one dataSources.query and one client.search — same shape as pre-0.8.0", async () => {
    // Round-trip pinning: hybrid calls the raw fetchContains/fetchSemantic
    // helpers exactly once each. If a future refactor wired hybrid to call
    // the public confidence-aware searchByContainsPages /
    // searchBySemanticPages instead, the raw helpers would still be called
    // exactly once each (transitively, via the public wrappers), so this
    // test alone wouldn't catch the regression. The double-application
    // numerical pin above is the load-bearing test; this one ensures the
    // round-trip cost contract didn't drift.
    const querySpy = vi.fn(async () => ({
      results: [buildScoredPage("c-only", 0.5)],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [buildScoredPage("s-only", 0.7)],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).toHaveBeenCalledTimes(1)
  })

  it("the documented [0.5, 1.0] confidence-factor floor holds in hybrid mode (no factor² collapse)", async () => {
    // The cleanest cross-check that hybrid does NOT call the public
    // wrappers. If it did, the score for a Confidence Score=0.0 row
    // would be `(1/61) * 0.5 * 0.5 = ~0.00410`. With the correct fetch/
    // sort split, the score is `(1/61) * 0.5 = ~0.00820`. The 2x gap
    // is wide enough that floating-point noise can't mask the
    // regression.
    const querySpy = vi.fn(async () => ({
      results: [buildScoredPage("decayed", 0.0)],
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy },
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { explain } = await service.searchWithExplain({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    expect(explain).toHaveLength(1)
    const single = (1 / 61) * 0.5
    const doubled = single * 0.5
    expect(explain[0].rrfScore).toBeCloseTo(single, 10)
    // Belt-and-braces: explicitly assert NOT the doubled value.
    expect(Math.abs((explain[0].rrfScore ?? 0) - doubled)).toBeGreaterThan(1e-6)
  })
})

describe("MemoryService.search — RRF tie-break determinism", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildHybridPage(id: string, title: string): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
      },
      {
        id,
        parent: {
          type: "data_source_id",
          data_source_id: db.dataSourceId,
        },
      } as Partial<PageObjectResponse>,
    )
  }

  it("end-to-end: when scores and best-rank tie via mirrored ranks, page id ascending decides", async () => {
    // With weight=1 and integer ranks, two rows with the same multiset
    // of ranks across branches necessarily share both score AND
    // best-rank — so end-to-end coverage of level 2 alone (different
    // best-rank, same score) is impossible without a per-call weight
    // knob. The direct comparator unit tests below cover level 2; this
    // integration test pins the level 4 fall-through that the
    // mirrored-rank fixture actually exercises.
    const querySpy = vi.fn(async () => ({
      results: [
        buildHybridPage("c-rank-1", "ranked second in contains"),
        buildHybridPage("c-rank-0", "ranked first in contains"),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [
        buildHybridPage("c-rank-0", "ranked second in semantic"),
        buildHybridPage("c-rank-1", "ranked first in semantic"),
      ],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    // Both rows score 1/61 + 1/62 (identical), best-rank 0 (each was
    // #1 in some branch), contains-presence on both. Tie-break falls
    // through to page id ascending → c-rank-0 wins lexically.
    expect(results.map((m) => m.id)).toEqual(["c-rank-0", "c-rank-1"])
  })

  it("tie-break level 3: contains-presence wins on score+rank tie", async () => {
    // A contains-only row at rank 0 and a semantic-only row at rank 0
    // both score 1/61 with best-rank 0. Contains-presence breaks the
    // tie. This is the "contains is precision" intuition the prior
    // concat-first heuristic encoded — a future contributor tempted
    // to "make tie-break symmetric" would silently shift this case.
    const querySpy = vi.fn(async () => ({
      results: [buildHybridPage("aaaa-contains", "contains hit")],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      // `zzzz-semantic` sorts after `aaaa-contains` lexically, but the
      // tie-break stops at contains-presence (level 3), never reaching
      // page id. To prove contains-presence is what wins, we put the
      // semantic-only row's id alphabetically *before* the contains
      // row's id — if the comparator fell through to page id, the
      // semantic row would win.
      results: [buildHybridPage("aaaa-semantic-but-alphabetically-before", "semantic hit")],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    // contains-presence wins on score+rank tie even when the
    // semantic-only row sorts earlier alphabetically.
    expect(results.map((m) => m.id)[0]).toBe("aaaa-contains")
  })

  it("tie-break level 4: page id ascending is the final deterministic fallback", async () => {
    // Two semantic-only rows at the same rank are impossible (a single
    // branch returns rows in distinct positions). Construct the page id
    // tie-break by having two rows that both score 1/61 + 1/61 = 2/61
    // (each appears at rank 0 in both branches). Both have contains-
    // presence, identical scores, identical best-rank. Page id
    // determines order.
    //
    // We can't have two rows simultaneously at rank 0 in the same
    // branch, so this test exercises the tie-break by way of the
    // sort's secondary stability — the comparator must reach level 4
    // to resolve the order between rows that genuinely tie at every
    // earlier level. We verify by sandwiching: if we have two pairs
    // and the comparator reaches level 4, the pair-internal order is
    // page id ascending.
    const querySpy = vi.fn(async () => ({
      // Two rows; the alphabetically-later id is at rank 0, the earlier
      // at rank 1.
      results: [buildHybridPage("zzz-1", "z one"), buildHybridPage("aaa-1", "a one")],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      // Swap the order in semantic: alphabetically-earlier at rank 0,
      // later at rank 1. Now zzz-1 has (contains 0, semantic 1) and
      // aaa-1 has (contains 1, semantic 0). Both score 1/61 + 1/62 =
      // identical. Both best-rank 0. Both contains-presence. Tie-break
      // falls through to page id ascending → aaa-1 wins.
      results: [buildHybridPage("aaa-1", "a one"), buildHybridPage("zzz-1", "z one")],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    expect(results.map((m) => m.id)).toEqual(["aaa-1", "zzz-1"])
  })
})

describe("tieBreakingRrfCompare — direct unit tests, one per tie-break level", () => {
  // Direct unit tests against the comparator. End-to-end coverage of
  // level 2 (different best-rank, equal score) is impossible with
  // weight=1 and integer ranks, because two rows with identical scores
  // necessarily share their rank multiset and therefore their min-rank.
  // The unit tests synthesize fixtures the end-to-end fixture cannot
  // produce, ensuring a contributor who simplifies the comparator
  // (e.g. drops level 2) is caught.

  function entry(
    id: string,
    score: number,
    containsRank: number | null,
    semanticRank: number | null,
    confidenceFactor: number = 1.0,
  ): RrfEntry {
    return {
      page: { id } as unknown as PageObjectResponse,
      score,
      containsRank,
      semanticRank,
      confidenceFactor,
    }
  }

  it("level 1: higher score wins", () => {
    const a = entry("a", 0.05, 5, 5)
    const b = entry("b", 0.01, 0, 0)
    // Even though `b` has better best-rank, score wins primarily.
    expect(tieBreakingRrfCompare(a, b)).toBeLessThan(0)
    expect(tieBreakingRrfCompare(b, a)).toBeGreaterThan(0)
  })

  it("level 2: lower best-rank wins on score tie", () => {
    const a = entry("a", 0.0322, 0, 5) // best-rank 0
    const b = entry("b", 0.0322, 2, 1) // best-rank 1
    // Same score; level 2 (best-rank) breaks the tie. `a` wins.
    expect(tieBreakingRrfCompare(a, b)).toBeLessThan(0)
    expect(tieBreakingRrfCompare(b, a)).toBeGreaterThan(0)
  })

  it("level 3: contains-presence wins on score+best-rank tie", () => {
    const a = entry("a", 0.0164, 0, null) // contains-only
    const b = entry("b", 0.0164, null, 0) // semantic-only
    // Equal score (1/61), equal best-rank (0). Contains-presence breaks.
    expect(tieBreakingRrfCompare(a, b)).toBeLessThan(0)
    expect(tieBreakingRrfCompare(b, a)).toBeGreaterThan(0)
  })

  it("level 4: page id ascending is the final fallback", () => {
    // Both rows: same score, same best-rank, both contains-present.
    const a = entry("aaa", 0.0322, 0, 1)
    const b = entry("zzz", 0.0322, 0, 1)
    expect(tieBreakingRrfCompare(a, b)).toBeLessThan(0)
    expect(tieBreakingRrfCompare(b, a)).toBeGreaterThan(0)
  })

  it("equal entries (identical id and ranks) compare to 0", () => {
    const a = entry("same", 0.0322, 0, 1)
    const b = entry("same", 0.0322, 0, 1)
    expect(tieBreakingRrfCompare(a, b)).toBe(0)
  })
})

describe("MemoryService.search — intent parameter (#17)", () => {
  // Pin the contains-vs-semantic asymmetry, normalize-once rule (whitespace-only
  // = unset), saturation-bypass-under-intent gate, and contains-lane up-weight
  // under RRF. The tests below mirror the acceptance criteria in
  // `Phase-2/17-search-intent-parameter.md` one-for-one.
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildIntentPage(id: string, title: string): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
      },
      {
        id,
        parent: {
          type: "data_source_id",
          data_source_id: db.dataSourceId,
        },
      } as Partial<PageObjectResponse>,
    )
  }

  function makeContainsClause(
    args: Record<string, unknown>,
  ): { property: string; rich_text?: { contains: string }; title?: { contains: string } }[] {
    // Walk into the composed filter and pull out the `(Title contains q) OR
    // (Keywords contains q)` clause so we can pin "intent never enters
    // contains" by string-comparing the contains payload.
    const filter = args["filter"] as { and?: unknown[] } | { or?: unknown[] } | undefined
    if (!filter) return []
    const ands = (filter as { and?: unknown[] }).and
    const direct = (filter as { or?: unknown[] }).or
    const orClause = ands
      ? (ands.find((c) => typeof c === "object" && c !== null && "or" in c) as
          | { or: unknown[] }
          | undefined)
      : direct
        ? { or: direct }
        : undefined
    if (!orClause) return []
    return orClause.or as ReturnType<typeof makeContainsClause>
  }

  it("intent does NOT enter the contains branch's filter — substring stays query-only", async () => {
    // The motivating rule: appending intent into the substring filter would
    // narrow recall in the wrong direction (Titles missing the literal
    // disambiguator drop out). Pin contains' filter equals `query` alone.
    const querySpy = vi.fn(async (_args: Record<string, unknown>) => ({
      results: [],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({ results: [] }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await service.search({
      query: "auth",
      intent: "WeChat session cookie",
      mode: "hybrid",
      includeContent: false,
    })

    expect(querySpy).toHaveBeenCalledTimes(1)
    const containsArgs = querySpy.mock.calls[0][0] as Record<string, unknown>
    const orClause = makeContainsClause(containsArgs)
    // Both inner clauses contain `"auth"`, never `"WeChat"` or the joined string.
    expect(orClause.length).toBeGreaterThan(0)
    for (const clause of orClause) {
      const needle =
        clause.rich_text?.contains ?? clause.title?.contains ?? ""
      expect(needle).toBe("auth")
      expect(needle).not.toContain("WeChat")
    }
  })

  it("intent enters the semantic branch's query when non-empty after trim", async () => {
    // Composition is `[query.trim(), intent].filter(Boolean).join(" ")`.
    // Standard non-empty case: `"auth WeChat session cookie"`.
    const searchSpy = vi.fn(async (_args: Record<string, unknown>) => ({ results: [] }))
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await service.search({
      query: "auth",
      intent: "WeChat session cookie",
      mode: "semantic",
    })

    expect(searchSpy).toHaveBeenCalledTimes(1)
    expect(searchSpy.mock.calls[0][0]["query"]).toBe("auth WeChat session cookie")
  })

  it("intent composition handles empty query without a leading space", async () => {
    // Edge case from Fix 3: `MemoryService.search` callers may pass `""`
    // for unscoped relevance lookups. Naive `${query.trim()} ${intent}`
    // would produce `" intent"` — Notion ranks that differently from
    // `"intent"`. The `filter(Boolean)` shape protects against this.
    const searchSpy = vi.fn(async (_args: Record<string, unknown>) => ({ results: [] }))
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await service.search({
      query: "",
      intent: "performance",
      mode: "semantic",
    })

    expect(searchSpy.mock.calls[0][0]["query"]).toBe("performance")
  })

  it("whitespace-only intent (`'   '`) is byte-identical to unset on the semantic-branch composition", async () => {
    // Pins the semantic-branch consumer of the normalize-once rule —
    // whitespace-only intent collapses to `null` and the composed query
    // is `"auth"`, not `"auth "` or `"auth    "`. The other two
    // consumers (saturation gate, lane weighting under hybrid) are
    // pinned independently by the dedicated test
    // `"whitespace-only intent triggers neither saturation bypass nor
    // lane up-weight"` below.
    const searchSpy = vi.fn(async (_args: Record<string, unknown>) => ({ results: [] }))
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await service.search({ query: "auth", intent: "   ", mode: "semantic" })

    // Whitespace-only intent → semantic query is `"auth"`, NOT `"auth    "`
    // and NOT `"auth "` — byte-identical to the unset path.
    expect(searchSpy.mock.calls[0][0]["query"]).toBe("auth")
  })

  it("mode='contains' ignores intent entirely — server-side filter identical to intent-unset", async () => {
    // Acceptance: contains-mode filter shape is byte-identical with or
    // without intent. Drive both calls and snapshot the filter argument.
    const querySpy = vi.fn(async (_args: Record<string, unknown>) => ({
      results: [],
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy },
      // contains mode never touches client.search; presence here is just
      // to satisfy the constructor.
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await service.search({ query: "auth", mode: "contains", includeContent: false })
    const filterUnset = (querySpy.mock.calls[0][0] as Record<string, unknown>)["filter"]

    await service.search({
      query: "auth",
      intent: "WeChat session cookie",
      mode: "contains",
      includeContent: false,
    })
    const filterWithIntent = (querySpy.mock.calls[1][0] as Record<string, unknown>)["filter"]

    expect(filterWithIntent).toEqual(filterUnset)
  })

  it("mode='hybrid' bypasses the saturation cutoff when intent is non-empty after trim", async () => {
    // Three contains hits would normally saturate. With intent set, the
    // RRF merge runs anyway so the semantic lane can influence ordering.
    const containsHits = [
      buildIntentPage("c-0", "first"),
      buildIntentPage("c-1", "second"),
      buildIntentPage("c-2", "third"),
    ]
    const querySpy = vi.fn(async () => ({
      results: containsHits,
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      // A row only the semantic branch surfaces. If the saturation cutoff
      // fired, this row would be discarded and the result would be
      // contains-only (`["c-0", "c-1", "c-2"]`).
      results: [buildIntentPage("semantic-only", "would float in under RRF")],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { explain } = await service.searchWithExplain({
      query: "auth",
      intent: "WeChat session cookie",
      mode: "hybrid",
      includeContent: false,
    })

    // The branch must be `rrf`, not `contains-saturated` — that is the
    // signal the saturation gate was bypassed. The semantic-only row
    // surfaces somewhere in the result set as well, but its position is
    // covered by the dedicated lane-weighting test below.
    expect(explain.every((e) => e.branch === "rrf")).toBe(true)
    const ids = explain.map((e) => e.memoryId)
    expect(ids).toContain("semantic-only")
  })

  it("mode='hybrid' with intent: contains lane is up-weighted (weight=2) under RRF", async () => {
    // Up-weighting only matters when both branches return the same row.
    // Construct a fixture where one row appears in both branches and one
    // appears in only the semantic branch. Under weight=1 on contains
    // (no intent), both rows would score 2/61 and 1/61 — same ordering.
    // The cleanest way to pin "weight=2 actually applied" is the rrfScore
    // on the cross-branch row: `2 * (1/61) + 1 * (1/61) = 3/61` instead
    // of the unweighted `2/61`.
    const querySpy = vi.fn(async () => ({
      results: [buildIntentPage("cross", "in both branches")],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [buildIntentPage("cross", "in both branches")],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { explain } = await service.searchWithExplain({
      query: "auth",
      intent: "WeChat",
      mode: "hybrid",
      includeContent: false,
    })

    expect(explain).toHaveLength(1)
    expect(explain[0].memoryId).toBe("cross")
    // contains weight=2 → 2/61; semantic weight=1 → 1/61; sum = 3/61.
    expect(explain[0].rrfScore).toBeCloseTo(3 / 61, 10)
  })

  it("mode='hybrid' with intent unset: saturation cutoff fires + RRF weights default to 1 below it", async () => {
    // Acceptance: when intent is unset, behavior is byte-identical to
    // #16's baseline. Drive two scenarios under intent-unset and pin
    // them both: (a) saturating cutoff still fires at the threshold,
    // and (b) below-threshold RRF runs with both weights = 1.

    // (a) Saturating: 3 contains hits → contains-saturated branch.
    {
      const querySpy = vi.fn(async () => ({
        results: [
          buildIntentPage("c-0", "first"),
          buildIntentPage("c-1", "second"),
          buildIntentPage("c-2", "third"),
        ],
        has_more: false,
        next_cursor: null,
      }))
      const searchSpy = vi.fn(async () => ({
        results: [buildIntentPage("semantic-only", "would float in under RRF")],
      }))
      const client = {
        dataSources: { query: querySpy },
        search: searchSpy,
        pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
      } as unknown as Client
      const service = new MemoryService(client, db)

      const { explain } = await service.searchWithExplain({
        query: "auth",
        mode: "hybrid",
        includeContent: false,
      })

      expect(explain.every((e) => e.branch === "contains-saturated")).toBe(true)
      expect(explain.map((e) => e.memoryId)).toEqual(["c-0", "c-1", "c-2"])
    }

    // (b) Under-shoot: intent unset, both lanes weight=1 → cross-branch row scores 2/61.
    {
      const querySpy = vi.fn(async () => ({
        results: [buildIntentPage("cross", "in both branches")],
        has_more: false,
        next_cursor: null,
      }))
      const searchSpy = vi.fn(async () => ({
        results: [buildIntentPage("cross", "in both branches")],
      }))
      const client = {
        dataSources: { query: querySpy },
        search: searchSpy,
        pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
      } as unknown as Client
      const service = new MemoryService(client, db)

      const { explain } = await service.searchWithExplain({
        query: "auth",
        mode: "hybrid",
        includeContent: false,
      })

      expect(explain).toHaveLength(1)
      expect(explain[0].rrfScore).toBeCloseTo(2 / 61, 10)
    }
  })

  it("whitespace-only intent triggers neither saturation bypass nor lane up-weight", async () => {
    // Reinforces the "whitespace-only is unset" rule across the two
    // hybrid-only consumers: saturation gate must fire, and the RRF
    // weights below the threshold must default to 1.

    // Saturation case — whitespace-only intent should NOT bypass the cutoff.
    {
      const querySpy = vi.fn(async () => ({
        results: [
          buildIntentPage("c-0", "first"),
          buildIntentPage("c-1", "second"),
          buildIntentPage("c-2", "third"),
        ],
        has_more: false,
        next_cursor: null,
      }))
      const searchSpy = vi.fn(async () => ({
        results: [buildIntentPage("semantic-only", "would float in under RRF")],
      }))
      const client = {
        dataSources: { query: querySpy },
        search: searchSpy,
        pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
      } as unknown as Client
      const service = new MemoryService(client, db)

      const { explain } = await service.searchWithExplain({
        query: "auth",
        intent: "   ",
        mode: "hybrid",
        includeContent: false,
      })

      expect(explain.every((e) => e.branch === "contains-saturated")).toBe(true)
      expect(explain.map((e) => e.memoryId)).toEqual(["c-0", "c-1", "c-2"])
    }

    // Under-shoot case — whitespace-only intent should NOT up-weight contains.
    {
      const querySpy = vi.fn(async () => ({
        results: [buildIntentPage("cross", "in both branches")],
        has_more: false,
        next_cursor: null,
      }))
      const searchSpy = vi.fn(async () => ({
        results: [buildIntentPage("cross", "in both branches")],
      }))
      const client = {
        dataSources: { query: querySpy },
        search: searchSpy,
        pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
      } as unknown as Client
      const service = new MemoryService(client, db)

      const { explain } = await service.searchWithExplain({
        query: "auth",
        intent: "   ",
        mode: "hybrid",
        includeContent: false,
      })

      expect(explain).toHaveLength(1)
      // Both weights = 1 → 2/61, NOT 3/61.
      expect(explain[0].rrfScore).toBeCloseTo(2 / 61, 10)
    }
  })
})

describe("MemoryService.searchWithExplain — branch-field rules and explain alignment", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildPageInDb(id: string, title: string): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
      },
      {
        id,
        parent: {
          type: "data_source_id",
          data_source_id: db.dataSourceId,
        },
      } as Partial<PageObjectResponse>,
    )
  }

  it("MemoryService.search return type is unchanged — Memory[]", async () => {
    // Structural pin: a future contributor cannot accidentally add a
    // wrapper return type to `search()` without breaking this fixture.
    const querySpy = vi.fn(async () => ({
      results: [buildPageInDb("a", "first")],
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy },
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "contains",
      includeContent: false,
    })

    expect(Array.isArray(results)).toBe(true)
    expect(results[0].id).toBe("a")
    // Each entry is a `Memory` — has the structural-domain fields.
    expect(results[0].title).toBe("first")
  })

  it("explain[i] aligns with memories[i] by page id", async () => {
    // The alignment guarantee is what makes the trace useful — a caller
    // can iterate both arrays in lockstep and know the trace describes
    // the same row.
    const querySpy = vi.fn(async () => ({
      results: [buildPageInDb("c-1", "contains hit")],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [
        buildPageInDb("s-1", "semantic 1"),
        buildPageInDb("s-2", "semantic 2"),
      ],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { memories, explain } = await service.searchWithExplain({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    expect(memories).toHaveLength(explain.length)
    for (let i = 0; i < memories.length; i++) {
      expect(explain[i].memoryId).toBe(memories[i].id)
    }
  })

  it("contains mode: branch is 'contains-only', semanticRank and rrfScore are null", async () => {
    const querySpy = vi.fn(async () => ({
      results: [
        buildPageInDb("a", "first"),
        buildPageInDb("b", "second"),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy },
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { explain } = await service.searchWithExplain({
      query: "q",
      mode: "contains",
      includeContent: false,
    })

    expect(explain).toHaveLength(2)
    for (let i = 0; i < explain.length; i++) {
      expect(explain[i].branch).toBe("contains-only")
      expect(explain[i].containsRank).toBe(i)
      expect(explain[i].semanticRank).toBeNull()
      expect(explain[i].rrfScore).toBeNull()
    }
  })

  it("semantic mode: branch is 'semantic-only', containsRank and rrfScore are null", async () => {
    const searchSpy = vi.fn(async () => ({
      results: [buildPageInDb("a", "first"), buildPageInDb("b", "second")],
    }))
    const client = {
      dataSources: { query: vi.fn() },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { explain } = await service.searchWithExplain({
      query: "q",
      mode: "semantic",
      includeContent: false,
    })

    expect(explain).toHaveLength(2)
    for (let i = 0; i < explain.length; i++) {
      expect(explain[i].branch).toBe("semantic-only")
      expect(explain[i].containsRank).toBeNull()
      expect(explain[i].semanticRank).toBe(i)
      expect(explain[i].rrfScore).toBeNull()
    }
  })

  it("hybrid saturated branch: semanticRank is null even when semantic surfaced the row", async () => {
    // The semantic branch ran in parallel and may even have returned the
    // same id, but its output was discarded — surfacing semanticRank
    // would imply influence on ordering that did not happen.
    const querySpy = vi.fn(async () => ({
      results: [
        buildPageInDb("a", "first"),
        buildPageInDb("b", "second"),
        buildPageInDb("c", "third"),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      // Semantic returns row `a` at rank 0 — but contains saturated, so
      // its rank is suppressed in the trace.
      results: [buildPageInDb("a", "first")],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { explain } = await service.searchWithExplain({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    expect(explain).toHaveLength(3)
    for (let i = 0; i < explain.length; i++) {
      expect(explain[i].branch).toBe("contains-saturated")
      expect(explain[i].containsRank).toBe(i)
      expect(explain[i].semanticRank).toBeNull()
      expect(explain[i].rrfScore).toBeNull()
    }
  })

  it("hybrid saturation: 3 contains hits land on contains-saturated regardless of which property each row matched on", async () => {
    // Structural pin for the saturation-cutoff. Synopsis hits count
    // toward HYBRID_FALLBACK_THRESHOLD the same way Title/Keywords hits
    // do — three rows in the contains result list saturate, the parallel
    // semantic call's output is discarded, and every row carries
    // `contains-saturated`. The actual pre-#04→post-#04 threshold
    // *crossing* (where adding Synopsis takes the hit count from 2 to
    // 3) is demonstrated end-to-end in
    // `memory-search.integration.test.ts` against a fixture vault that
    // evaluates the contains predicate. Here we pin only the post-#04
    // outcome at the threshold boundary.
    const querySpy = vi.fn(async () => ({
      results: [
        buildPageInDb("title-hit", "PR-25650 row"),
        buildPageInDb("keywords-hit", "Other row"),
        buildPageInDb("synopsis-hit", "Yet another row"),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [buildPageInDb("semantic-only", "would float in under RRF")],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { memories, explain } = await service.searchWithExplain({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    // Three contains hits hit the saturation threshold — semantic
    // result is discarded and every row carries `contains-saturated`.
    expect(memories.map((m) => m.id)).toEqual([
      "title-hit",
      "keywords-hit",
      "synopsis-hit",
    ])
    for (const e of explain) {
      expect(e.branch).toBe("contains-saturated")
      expect(e.semanticRank).toBeNull()
      expect(e.rrfScore).toBeNull()
    }
  })

  it("hybrid stable branch: zero contains hits stays on rrf regardless of Synopsis OR branch", async () => {
    // Companion to the threshold-crossing test: when the post-#04
    // contains count stays on the same side of the threshold as
    // pre-#04 (here, 0 → 0), the resolved branch is unchanged. Pins
    // the "stable-branch fixture" half of issue 0.7.0/04's
    // branch-stability acceptance.
    const querySpy = vi.fn(async () => ({
      results: [],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [
        buildPageInDb("s-1", "semantic 1"),
        buildPageInDb("s-2", "semantic 2"),
      ],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { explain } = await service.searchWithExplain({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    // Zero contains hits → RRF runs (the saturation gate doesn't fire).
    // Every row sits on `rrf`, semantic-only.
    for (const e of explain) {
      expect(e.branch).toBe("rrf")
      expect(e.containsRank).toBeNull()
      expect(e.semanticRank).not.toBeNull()
    }
  })

  it("hybrid rrf branch: both ranks reflect actual branch presence; rrfScore populated", async () => {
    const querySpy = vi.fn(async () => ({
      results: [buildPageInDb("c-only", "contains alone")],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [
        buildPageInDb("c-only", "contains alone"),
        buildPageInDb("s-only", "semantic alone"),
      ],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { memories, explain } = await service.searchWithExplain({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    const cOnly = explain.find((e) => e.memoryId === "c-only")
    const sOnly = explain.find((e) => e.memoryId === "s-only")

    expect(cOnly?.branch).toBe("rrf")
    expect(cOnly?.containsRank).toBe(0)
    expect(cOnly?.semanticRank).toBe(0)
    expect(cOnly?.rrfScore).toBeCloseTo(2 / 61, 10)

    expect(sOnly?.branch).toBe("rrf")
    expect(sOnly?.containsRank).toBeNull()
    expect(sOnly?.semanticRank).toBe(1)
    expect(sOnly?.rrfScore).toBeCloseTo(1 / 62, 10)

    // c-only sorts above s-only because cross-branch agreement scores
    // higher than single-branch presence.
    expect(memories.map((m) => m.id)).toEqual(["c-only", "s-only"])
  })

  it("LORE_FORCE_SEMANTIC_SEARCH=1 routes mode='hybrid' through 'semantic-only'", async () => {
    // Pin the kill-switch path: when the operator forces semantic, the
    // explain trace reports `semantic-only`, not `rrf` or
    // `contains-saturated`. The `mode` argument is ignored.
    const prev = process.env["LORE_FORCE_SEMANTIC_SEARCH"]
    process.env["LORE_FORCE_SEMANTIC_SEARCH"] = "1"
    try {
      const searchSpy = vi.fn(async () => ({
        results: [buildPageInDb("a", "first")],
      }))
      const client = {
        dataSources: { query: vi.fn() },
        search: searchSpy,
        pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
      } as unknown as Client
      const service = new MemoryService(client, db)

      const { explain } = await service.searchWithExplain({
        query: "q",
        mode: "hybrid",
        includeContent: false,
      })

      expect(explain).toHaveLength(1)
      expect(explain[0].branch).toBe("semantic-only")
      expect(explain[0].containsRank).toBeNull()
    } finally {
      if (prev === undefined) delete process.env["LORE_FORCE_SEMANTIC_SEARCH"]
      else process.env["LORE_FORCE_SEMANTIC_SEARCH"] = prev
    }
  })

  it("SearchExplain field names are canonical to lore (containsRank, not lexRank)", async () => {
    // qmd uses `lexRank` for the contains lane. Pin lore's vocabulary so
    // a future contributor doesn't silently rename chasing qmd's words.
    const querySpy = vi.fn(async () => ({
      results: [buildPageInDb("a", "first")],
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy },
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { explain } = await service.searchWithExplain({
      query: "q",
      mode: "contains",
      includeContent: false,
    })

    const entry = explain[0]
    expect(Object.keys(entry).sort()).toEqual([
      "branch",
      "confidenceFactor",
      "containsRank",
      "memoryId",
      "rrfScore",
      "semanticRank",
    ])
  })
})

describe("MemoryService.search — hybrid single-branch resilience (PF3-03)", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildHybridPage(id: string, title: string): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
      },
      {
        id,
        parent: {
          type: "data_source_id",
          data_source_id: db.dataSourceId,
        },
      } as Partial<PageObjectResponse>,
    )
  }

  it("returns contains-only results when the semantic branch rejects", async () => {
    // Pre-PF3-03 (Promise.all): a transient 429 from client.search would
    // propagate to the caller even though contains saturated independently.
    // With Promise.allSettled the surviving branch's rows pass through.
    const querySpy = vi.fn(async () => ({
      results: [
        buildHybridPage("c-1", "one"),
        buildHybridPage("c-2", "two"),
        buildHybridPage("c-3", "three"),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => {
      throw new Error("simulated 429 from client.search")
    })
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    expect(results.map((m) => m.id)).toEqual(["c-1", "c-2", "c-3"])
    // Both branches were dispatched — the failure path runs after settle,
    // not before dispatch.
    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).toHaveBeenCalledTimes(1)
  })

  it("returns semantic-only results when the contains branch rejects", async () => {
    // Inverted scenario: a Notion outage on dataSources.query while
    // client.search still serves vector hits. Contains' empty result is
    // treated as "no contains rows", semantic provides the full output.
    const querySpy = vi.fn(async () => {
      throw new Error("simulated 5xx from dataSources.query")
    })
    const searchSpy = vi.fn(async () => ({
      results: [
        buildHybridPage("s-1", "semantic 1"),
        buildHybridPage("s-2", "semantic 2"),
      ],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    expect(results.map((m) => m.id)).toEqual(["s-1", "s-2"])
    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).toHaveBeenCalledTimes(1)
  })

  it("surfaces an error when both branches reject (no silent empty)", async () => {
    // Both-failure case must propagate. A genuinely broken search
    // subsystem should not look identical to "no results found" — that
    // would mask a production outage.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const containsError = new Error("contains-failed")
      const semanticError = new Error("semantic-failed")
      const querySpy = vi.fn(async () => {
        throw containsError
      })
      const searchSpy = vi.fn(async () => {
        throw semanticError
      })
      const client = {
        dataSources: { query: querySpy },
        search: searchSpy,
        pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
      } as unknown as Client
      const service = new MemoryService(client, db)

      await expect(
        service.search({ query: "q", mode: "hybrid", includeContent: false }),
      ).rejects.toThrow("contains-failed")
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it("LORE_DEBUG=1 emits one stderr line per failing branch with branch= and error=", async () => {
    // Operator observability: under LORE_DEBUG=1 a failed branch logs
    // exactly one line so log aggregators can correlate transient blips
    // without the caller seeing them. No log line under default LORE_DEBUG.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const original = process.env["LORE_DEBUG"]
    process.env["LORE_DEBUG"] = "1"
    try {
      const querySpy = vi.fn(async () => ({
        results: [
          buildHybridPage("c-1", "one"),
          buildHybridPage("c-2", "two"),
          buildHybridPage("c-3", "three"),
        ],
        has_more: false,
        next_cursor: null,
      }))
      const searchSpy = vi.fn(async () => {
        throw new Error("simulated rate-limit")
      })
      const client = {
        dataSources: { query: querySpy },
        search: searchSpy,
        pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
      } as unknown as Client
      const service = new MemoryService(client, db)

      await service.search({
        query: "q",
        mode: "hybrid",
        includeContent: false,
      })

      const lines = stderrSpy.mock.calls.map((c) => String(c[0]))
      const hybridLines = lines.filter((l) => l.includes("source=hybrid-search"))
      expect(hybridLines).toHaveLength(1)
      expect(hybridLines[0]).toContain("branch=semantic")
      expect(hybridLines[0]).toContain("error=simulated rate-limit")
      // One-event-per-line invariant — the line is newline-terminated.
      expect(hybridLines[0].endsWith("\n")).toBe(true)
    } finally {
      stderrSpy.mockRestore()
      if (original === undefined) {
        delete process.env["LORE_DEBUG"]
      } else {
        process.env["LORE_DEBUG"] = original
      }
    }
  })

  it("emits no stderr line when LORE_DEBUG is unset (default-quiet)", async () => {
    // The default operator experience: a transient blip degrades to a
    // surviving-branch-only result with zero stderr noise. Operators
    // who want visibility opt in via LORE_DEBUG=1.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const original = process.env["LORE_DEBUG"]
    delete process.env["LORE_DEBUG"]
    try {
      const querySpy = vi.fn(async () => ({
        results: [
          buildHybridPage("c-1", "one"),
          buildHybridPage("c-2", "two"),
          buildHybridPage("c-3", "three"),
        ],
        has_more: false,
        next_cursor: null,
      }))
      const searchSpy = vi.fn(async () => {
        throw new Error("simulated rate-limit")
      })
      const client = {
        dataSources: { query: querySpy },
        search: searchSpy,
        pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
      } as unknown as Client
      const service = new MemoryService(client, db)

      await service.search({
        query: "q",
        mode: "hybrid",
        includeContent: false,
      })

      const hybridLines = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("source=hybrid-search"))
      expect(hybridLines).toHaveLength(0)
    } finally {
      stderrSpy.mockRestore()
      if (original === undefined) {
        delete process.env["LORE_DEBUG"]
      } else {
        process.env["LORE_DEBUG"] = original
      }
    }
  })

  it("returns an empty result when one branch rejects and the survivor genuinely has zero hits", async () => {
    // The visibility cost called out in the spec: a caller cannot
    // distinguish "contains down + no semantic match" from "clean miss".
    // This is by design — the surviving branch's empty result IS the
    // honest answer to the query — but pinning the contract here keeps
    // the tradeoff greppable. LORE_DEBUG=1 is the operator-side
    // mitigation; the production followup is an error-counter dashboard.
    //
    // stderrSpy is defensive: under default LORE_DEBUG the partial-failure
    // helper is a no-op, but a parent test that leaks LORE_DEBUG=1 (or a
    // future vitest pool config flip from `forks` to `threads`) would let
    // stderr noise pollute test output. Cheap insurance.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const querySpy = vi.fn(async () => {
        throw new Error("simulated 5xx from dataSources.query")
      })
      const searchSpy = vi.fn(async () => ({ results: [] }))
      const client = {
        dataSources: { query: querySpy },
        search: searchSpy,
        pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
      } as unknown as Client
      const service = new MemoryService(client, db)

      const results = await service.search({
        query: "q",
        mode: "hybrid",
        includeContent: false,
      })

      // Zero rows surfaced — same shape a genuine clean-miss would return.
      // The caller cannot tell the difference; only the operator can, via
      // the LORE_DEBUG=1 stderr line covered by a separate test.
      expect(results).toEqual([])
      expect(querySpy).toHaveBeenCalledTimes(1)
      expect(searchSpy).toHaveBeenCalledTimes(1)
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it("both-fail emits a [lore] both-failure line UNCONDITIONALLY (not gated on LORE_DEBUG)", async () => {
    // Reviewer concern: the both-fail case is the worst-case scenario —
    // there is no surviving response to mask noise on, the caller's
    // try/catch only sees the chosen throw, and the operator needs every
    // rejection reason on stderr regardless of LORE_DEBUG. Logging
    // unconditionally is the right tradeoff here even though the
    // partial-failure path stays opt-in.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const original = process.env["LORE_DEBUG"]
    delete process.env["LORE_DEBUG"]
    try {
      const querySpy = vi.fn(async () => {
        throw new Error("contains-down")
      })
      const searchSpy = vi.fn(async () => {
        throw new Error("semantic-down")
      })
      const client = {
        dataSources: { query: querySpy },
        search: searchSpy,
        pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
      } as unknown as Client
      const service = new MemoryService(client, db)

      await expect(
        service.search({ query: "q", mode: "hybrid", includeContent: false }),
      ).rejects.toThrow("contains-down")

      const bothFailureLines = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("[lore] both-failure:"))
      expect(bothFailureLines).toHaveLength(1)
      const line = bothFailureLines[0]
      // Both rejection messages on the single line — operators see the
      // suppressed-branch error alongside the thrown one.
      expect(line).toContain("contains=contains-down")
      expect(line).toContain("semantic=semantic-down")
      expect(line).toContain("source=hybrid-search")
      expect(line.endsWith("\n")).toBe(true)
    } finally {
      stderrSpy.mockRestore()
      if (original === undefined) {
        delete process.env["LORE_DEBUG"]
      } else {
        process.env["LORE_DEBUG"] = original
      }
    }
  })

  it("non-Error rejection reasons (undefined, null, plain string) render as diagnostic strings, not 'undefined'", async () => {
    // Defensive log-quality fallback: a sloppy `Promise.reject()` (no arg)
    // would otherwise read `error=undefined`, which is parsable but not
    // diagnostic. Plain-string rejections pass through unchanged.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const original = process.env["LORE_DEBUG"]
    process.env["LORE_DEBUG"] = "1"
    try {
      const querySpy = vi.fn(async () => ({
        results: [
          buildHybridPage("c-1", "one"),
          buildHybridPage("c-2", "two"),
          buildHybridPage("c-3", "three"),
        ],
        has_more: false,
        next_cursor: null,
      }))
      const searchSpy = vi.fn(async () => Promise.reject(undefined))
      const client = {
        dataSources: { query: querySpy },
        search: searchSpy,
        pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
      } as unknown as Client
      const service = new MemoryService(client, db)

      await service.search({
        query: "q",
        mode: "hybrid",
        includeContent: false,
      })

      const hybridLines = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("source=hybrid-search"))
      expect(hybridLines).toHaveLength(1)
      expect(hybridLines[0]).toContain("error=<non-error rejection>")
      // Crucially NOT this — that's the bug the fallback fixes.
      expect(hybridLines[0]).not.toContain("error=undefined")
    } finally {
      stderrSpy.mockRestore()
      if (original === undefined) {
        delete process.env["LORE_DEBUG"]
      } else {
        process.env["LORE_DEBUG"] = original
      }
    }
  })
})

describe("MemoryService.search — kill switch", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  it("LORE_FORCE_SEMANTIC_SEARCH=1 routes every call through client.search regardless of caller mode", async () => {
    // Operator escape hatch for the rollback story raised in review:
    // if contains under-recalls in a vault that hasn't run
    // `lore migrate --fix-memory-encoding` yet, set this env var to
    // force every search through the legacy workspace-wide path.
    const querySpy = vi.fn(async () => ({
      results: [],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({ results: [] }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const original = process.env["LORE_FORCE_SEMANTIC_SEARCH"]
    process.env["LORE_FORCE_SEMANTIC_SEARCH"] = "1"
    try {
      await service.search({ query: "q", mode: "contains" })
      await service.search({ query: "q", mode: "hybrid" })
    } finally {
      if (original === undefined) {
        delete process.env["LORE_FORCE_SEMANTIC_SEARCH"]
      } else {
        process.env["LORE_FORCE_SEMANTIC_SEARCH"] = original
      }
    }

    // Both calls routed through client.search, neither touched dataSources.query.
    expect(searchSpy).toHaveBeenCalledTimes(2)
    expect(querySpy).not.toHaveBeenCalled()
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
      "Done At": { type: "date", date: null },
      "Decided At": { type: "date", date: null },
      "Last Referenced At": { type: "date", date: null },
    })

    const memory = pageToMemory(page)
    expect(memory.reviewBy).toBeNull()
    expect(memory.doneAt).toBeNull()
    expect(memory.decidedAt).toBeNull()
    expect(memory.lastReferencedAt).toBeNull()
  })
})

describe("MemoryService.list — pagination", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildListPage(id: string, title: string): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
      },
      { id } as Partial<PageObjectResponse>,
    )
  }

  function createClient(response: {
    results: PageObjectResponse[]
    has_more?: boolean
    next_cursor?: string | null
  }) {
    const querySpy = vi.fn(async (_args: Record<string, unknown>) => ({
      results: response.results,
      has_more: response.has_more ?? false,
      next_cursor: response.next_cursor ?? null,
    }))
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "body" }))
    return {
      client: {
        dataSources: { query: querySpy },
        pages: { retrieveMarkdown: retrieveMarkdownSpy },
      } as unknown as Client,
      querySpy,
      retrieveMarkdownSpy,
    }
  }

  it("exposes nextCursor when the Notion response reports has_more", async () => {
    const { client } = createClient({
      results: [buildListPage("mem-1", "one")],
      has_more: true,
      next_cursor: "notion-cursor-abc",
    })
    const service = new MemoryService(client, db)

    const { items, nextCursor } = await service.list({ includeContent: false })

    expect(items).toHaveLength(1)
    expect(nextCursor).toBe("notion-cursor-abc")
  })

  it("omits nextCursor when has_more is false (ignoring any stale next_cursor Notion returns)", async () => {
    const { client } = createClient({
      results: [buildListPage("mem-1", "one")],
      has_more: false,
      next_cursor: "should-be-ignored",
    })
    const service = new MemoryService(client, db)

    const { nextCursor } = await service.list({ includeContent: false })

    expect(nextCursor).toBeUndefined()
  })

  it("forwards startCursor to dataSources.query as start_cursor", async () => {
    const { client, querySpy } = createClient({ results: [] })
    const service = new MemoryService(client, db)

    await service.list({ startCursor: "resume-from-here", includeContent: false })

    expect(querySpy.mock.calls[0][0]).toMatchObject({
      start_cursor: "resume-from-here",
    })
  })
})

describe("MemoryService.create — HTML entity decode at write", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  type CreateArgs = {
    properties: {
      Title: { title: Array<{ text: { content: string } }> }
    }
  }
  type UpdateMarkdownArgs = { insert_content: { content: string } }

  it("decodes doubly-encoded title and content before writing to Notion", async () => {
    const createSpy = vi.fn(async (_args: CreateArgs) =>
      buildPage(
        { Title: { type: "title", title: [{ plain_text: "PR #25650's diff" }] } },
        { id: "mem-1" },
      ),
    )
    const updateMarkdownSpy = vi.fn(async (_args: UpdateMarkdownArgs) => ({}))
    const client = {
      pages: { create: createSpy, updateMarkdown: updateMarkdownSpy },
    } as unknown as Client

    const service = new MemoryService(client, db)
    await service.create({
      title: "PR #25650&amp;#8217;s diff",
      content: "Fix the &amp;amp; in build logs",
    })

    const createArgs = createSpy.mock.calls[0][0]
    // `&amp;#8217;` collapses to `&#8217;` and then to the curly right single
    // quote ’ — the fixed-point loop keeps decoding until stable.
    expect(createArgs.properties.Title.title[0].text.content).toBe("PR #25650’s diff")

    const mdArgs = updateMarkdownSpy.mock.calls[0][0]
    expect(mdArgs.insert_content.content).toBe("Fix the & in build logs")
  })

  it("is idempotent — clean input passes through unchanged", async () => {
    const createSpy = vi.fn(async (_args: CreateArgs) =>
      buildPage(
        { Title: { type: "title", title: [{ plain_text: "Clean title" }] } },
        { id: "mem-2" },
      ),
    )
    const updateMarkdownSpy = vi.fn(async (_args: UpdateMarkdownArgs) => ({}))
    const client = {
      pages: { create: createSpy, updateMarkdown: updateMarkdownSpy },
    } as unknown as Client

    const service = new MemoryService(client, db)
    await service.create({
      title: "Clean title",
      content: "Body with a literal & character",
    })

    const createArgs = createSpy.mock.calls[0][0]
    expect(createArgs.properties.Title.title[0].text.content).toBe("Clean title")
    const mdArgs = updateMarkdownSpy.mock.calls[0][0]
    expect(mdArgs.insert_content.content).toBe("Body with a literal & character")
  })

  it("decodes every rich_text field — alternatives, consequences, author, agent, keywords, session", async () => {
    // P3-03 (entity canonicalization) will read `author`/`agent` for
    // normalization; P2-03 (near-duplicate detection) will trigram over
    // `alternatives`/`consequences`/`keywords`. All of them flow through
    // the same autosave encoder as `title`, so decode them at the write
    // boundary too. `session` is included for consistency — unlikely to
    // carry encoded content in practice, but cheap to decode and keeps
    // the rich_text coverage exhaustive.
    type FullCreateArgs = {
      properties: {
        Title: { title: Array<{ text: { content: string } }> }
        Alternatives: { rich_text: Array<{ text: { content: string } }> }
        Consequences: { rich_text: Array<{ text: { content: string } }> }
        Author: { rich_text: Array<{ text: { content: string } }> }
        Agent: { rich_text: Array<{ text: { content: string } }> }
        Keywords: { rich_text: Array<{ text: { content: string } }> }
        Synopsis: { rich_text: Array<{ text: { content: string } }> }
        Session: { rich_text: Array<{ text: { content: string } }> }
      }
    }
    const createSpy = vi.fn(async (_args: FullCreateArgs) =>
      buildPage({ Title: { type: "title", title: [{ plain_text: "T" }] } }, { id: "mem-3" }),
    )
    const updateMarkdownSpy = vi.fn(async (_args: UpdateMarkdownArgs) => ({}))
    const client = {
      pages: { create: createSpy, updateMarkdown: updateMarkdownSpy },
    } as unknown as Client

    const service = new MemoryService(client, db)
    await service.create({
      title: "Encoded &amp; title",
      content: "body",
      alternatives: "Alt A &amp; Alt B",
      consequences: "Cost: &amp;amp; risk",
      author: "name &amp; co",
      agent: "tool &amp; script",
      keywords: "PR &amp; branch",
      synopsis: "Foo &amp;amp; Bar",
      session: "sess-&amp;-123",
    })

    const p = createSpy.mock.calls[0][0].properties
    expect(p.Title.title[0].text.content).toBe("Encoded & title")
    expect(p.Alternatives.rich_text[0].text.content).toBe("Alt A & Alt B")
    expect(p.Consequences.rich_text[0].text.content).toBe("Cost: & risk")
    expect(p.Author.rich_text[0].text.content).toBe("name & co")
    expect(p.Agent.rich_text[0].text.content).toBe("tool & script")
    expect(p.Keywords.rich_text[0].text.content).toBe("PR & branch")
    expect(p.Synopsis.rich_text[0].text.content).toBe("Foo & Bar")
    expect(p.Session.rich_text[0].text.content).toBe("sess-&-123")
  })
})

describe("MemoryService.update — HTML entity decode at write", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  it("decodes title, content, and rich_text fields on update — parallels create", async () => {
    // Reviewer concern: without this, `update` would write encoded text
    // around the freshly-decoded rows `create` produces. Same autosave
    // path can re-encode values on subsequent saves, so the `update`
    // write boundary must also decode.
    type FullUpdateArgs = {
      properties: {
        Title?: { title: Array<{ text: { content: string } }> }
        Alternatives?: { rich_text: Array<{ text: { content: string } }> }
        Consequences?: { rich_text: Array<{ text: { content: string } }> }
        Keywords?: { rich_text: Array<{ text: { content: string } }> }
        Synopsis?: { rich_text: Array<{ text: { content: string } }> }
      }
    }
    const updateSpy = vi.fn(async (_args: FullUpdateArgs) => ({}))
    const updateMarkdownSpy = vi.fn(
      async (_args: { replace_content: { new_str: string } }) => ({}),
    )
    const retrieveSpy = vi.fn(async () =>
      buildPage(
        {
          Title: { type: "title", title: [{ plain_text: "Updated" }] },
          Project: { type: "relation", relation: [] },
          Topic: { type: "relation", relation: [] },
          Source: { type: "select", select: { name: "manual" } },
        },
        { id: "mem-1" },
      ),
    )
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "" }))
    const client = {
      pages: {
        update: updateSpy,
        updateMarkdown: updateMarkdownSpy,
        retrieve: retrieveSpy,
        retrieveMarkdown: retrieveMarkdownSpy,
      },
    } as unknown as Client

    const service = new MemoryService(client, db)
    await service.update("mem-1", {
      title: "Updated &amp; saved",
      content: "Body &amp; body",
      alternatives: "Alt &amp; Alt",
      consequences: "Cons &amp; cons",
      keywords: "PR &amp; branch",
      synopsis: "Synopsis &amp; cause",
    })

    const props = updateSpy.mock.calls[0][0].properties
    expect(props.Title?.title[0].text.content).toBe("Updated & saved")
    expect(props.Alternatives?.rich_text[0].text.content).toBe("Alt & Alt")
    expect(props.Consequences?.rich_text[0].text.content).toBe("Cons & cons")
    expect(props.Keywords?.rich_text[0].text.content).toBe("PR & branch")
    expect(props.Synopsis?.rich_text[0].text.content).toBe("Synopsis & cause")

    const mdArgs = updateMarkdownSpy.mock.calls[0][0]
    expect(mdArgs.replace_content.new_str).toBe("Body & body")
  })

  it("emits an empty Synopsis when explicitly cleared, omits when undefined", async () => {
    type SynopsisOnlyUpdateArgs = {
      properties: {
        Synopsis?: { rich_text: Array<{ text: { content: string } }> }
      }
    }
    const updateSpy = vi.fn(async (_args: SynopsisOnlyUpdateArgs) => ({}))
    const retrieveSpy = vi.fn(async () =>
      buildPage(
        {
          Title: { type: "title", title: [{ plain_text: "T" }] },
          Project: { type: "relation", relation: [] },
          Topic: { type: "relation", relation: [] },
          Source: { type: "select", select: { name: "manual" } },
        },
        { id: "mem-1" },
      ),
    )
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "" }))
    const client = {
      pages: {
        update: updateSpy,
        retrieve: retrieveSpy,
        retrieveMarkdown: retrieveMarkdownSpy,
      },
    } as unknown as Client

    const service = new MemoryService(client, db)

    // Empty string clears the property — `undefined` would skip emission.
    await service.update("mem-1", { synopsis: "" })
    const cleared = updateSpy.mock.calls[0][0].properties
    expect(cleared.Synopsis).toBeDefined()
    expect(cleared.Synopsis?.rich_text[0].text.content).toBe("")

    // No synopsis arg → no Synopsis key in the update properties.
    await service.update("mem-1", { keywords: "leave synopsis alone" })
    const untouched = updateSpy.mock.calls[1][0].properties
    expect("Synopsis" in untouched).toBe(false)
  })
})

describe("MemoryService.getTitleById — title cache", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function titlePage(id: string, title: string): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
      },
      { id, parent: { type: "database_id", database_id: db.databaseId } },
    )
  }

  it("skips the Notion call on repeat reads within the TTL window", async () => {
    const retrieveSpy = vi.fn(async ({ page_id }: { page_id: string }) =>
      titlePage(page_id, "Cached title"),
    )
    const client = { pages: { retrieve: retrieveSpy } } as unknown as Client
    const service = new MemoryService(client, db)

    const first = await service.getTitleById("mem-1")
    const second = await service.getTitleById("mem-1")

    expect(first).toBe("Cached title")
    expect(second).toBe("Cached title")
    expect(retrieveSpy).toHaveBeenCalledTimes(1)
  })

  it("collapses concurrent cold-start misses onto a single retrieve", async () => {
    const retrieveSpy = vi.fn(async ({ page_id }: { page_id: string }) => {
      await new Promise((r) => setTimeout(r, 5))
      return titlePage(page_id, "Once")
    })
    const client = { pages: { retrieve: retrieveSpy } } as unknown as Client
    const service = new MemoryService(client, db)

    const values = await Promise.all([
      service.getTitleById("mem-1"),
      service.getTitleById("mem-1"),
      service.getTitleById("mem-1"),
      service.getTitleById("mem-1"),
    ])

    expect(values).toEqual(["Once", "Once", "Once", "Once"])
    expect(retrieveSpy).toHaveBeenCalledTimes(1)
  })

  it("evicts on update so a subsequent read sees the new title", async () => {
    let currentTitle = "Old"
    const retrieveSpy = vi.fn(async ({ page_id }: { page_id: string }) =>
      titlePage(page_id, currentTitle),
    )
    const updateSpy = vi.fn(async () => {
      currentTitle = "New"
      return titlePage("mem-1", "New")
    })
    const markdownSpy = vi.fn(async () => ({ markdown: "" }))
    const client = {
      pages: {
        retrieve: retrieveSpy,
        update: updateSpy,
        retrieveMarkdown: markdownSpy,
        updateMarkdown: vi.fn(async () => ({})),
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    expect(await service.getTitleById("mem-1")).toBe("Old")
    await service.update("mem-1", { title: "New" })
    // The cache was evicted before the update write, so this read goes
    // back to Notion and picks up the post-update state.
    expect(await service.getTitleById("mem-1")).toBe("New")
  })

  it("caches a null tombstone after archive so subsequent reads issue zero Notion calls", async () => {
    // Reviewer concern: Notion returns archived pages as full
    // PageObjectResponse with `archived: true` and every property
    // populated (including Title). A lazy evict-only implementation would
    // re-fetch after archive and `extractTitle` would happily read the
    // archived title — a real-world bug the earlier test missed by
    // faking the post-archive shape as a throw.
    //
    // The correct behaviour: `archive()` installs a null tombstone in
    // the cache, so the next `getTitleById` short-circuits without a
    // network call at all.
    const retrieveSpy = vi.fn(
      async ({ page_id }: { page_id: string }) => titlePage(page_id, "Before"),
    )
    const updateSpy = vi.fn(async () => ({}))
    const client = {
      pages: { retrieve: retrieveSpy, update: updateSpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    expect(await service.getTitleById("mem-1")).toBe("Before")
    const beforeArchiveCalls = retrieveSpy.mock.calls.length

    await service.archive("mem-1")

    expect(await service.getTitleById("mem-1")).toBeNull()
    // Zero additional fetches after archive — the tombstone cached at
    // archive time short-circuits the read path.
    expect(retrieveSpy.mock.calls.length).toBe(beforeArchiveCalls)
  })

  it("caches a null tombstone when the underlying page is archived at fetch time", async () => {
    // The faithful Notion semantic: archived pages return a full
    // PageObjectResponse with `archived: true` and a populated title.
    // `getTitleById` must treat that as absent and return null without
    // reading the Title property — otherwise we'd serve titles for
    // pages the user has explicitly archived.
    const archivedPage = buildPage(
      { Title: { type: "title", title: [{ plain_text: "Archived title" }] } },
      { id: "mem-1", archived: true },
    )
    const retrieveSpy = vi.fn(async () => archivedPage)
    const client = {
      pages: { retrieve: retrieveSpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    expect(await service.getTitleById("mem-1")).toBeNull()
    // Second call hits the tombstone — zero additional fetches.
    expect(await service.getTitleById("mem-1")).toBeNull()
    expect(retrieveSpy).toHaveBeenCalledTimes(1)
  })

  it("does not cache transient errors — next caller retries", async () => {
    // Rate-limit blip and network error paths must NOT install a
    // tombstone, or a 60-second TTL window would degrade every render
    // of the affected ID to `(?)`. The next caller must retry.
    const retrieveSpy = vi
      .fn<(args: { page_id: string }) => Promise<PageObjectResponse>>()
      .mockImplementationOnce(async () => {
        throw new Error("transient 429")
      })
      .mockImplementationOnce(async ({ page_id }) => titlePage(page_id, "Recovered"))
    const client = {
      pages: { retrieve: retrieveSpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    expect(await service.getTitleById("mem-1")).toBeNull()
    // Second call runs the loader again — no poisoned tombstone.
    expect(await service.getTitleById("mem-1")).toBe("Recovered")
    expect(retrieveSpy).toHaveBeenCalledTimes(2)
  })

  it("re-fetches after TTL expiry", async () => {
    // Spec acceptance criterion: TTL expiry re-fetches. Pins that the
    // cache isn't accidentally holding values forever.
    vi.useFakeTimers()
    try {
      const retrieveSpy = vi.fn(
        async ({ page_id }: { page_id: string }) => titlePage(page_id, "T"),
      )
      const client = {
        pages: { retrieve: retrieveSpy },
      } as unknown as Client
      const service = new MemoryService(client, db)

      expect(await service.getTitleById("mem-1")).toBe("T")
      expect(retrieveSpy).toHaveBeenCalledTimes(1)

      // Advance past the 60s TTL.
      vi.advanceTimersByTime(61_000)

      expect(await service.getTitleById("mem-1")).toBe("T")
      expect(retrieveSpy).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("25-UUID repeat wake-up (24 present + 1 archived) issues zero pages.retrieve on the second run", async () => {
    // Integration-level acceptance criterion for PF1-07: repeat
    // `resolveTitles` calls (the render-layer batch used by
    // `lore-wake-up`) over the same id set must hit the cache on the
    // second run.
    //
    // The mixed id is *archived*, not a 404 — Notion returns a full
    // response with `archived: true`, which is the "known-absent"
    // tombstone-cacheable case. Genuinely-missing ids (whose
    // `pages.retrieve` throws) take the transient path and are NOT
    // cached by design — that shape is covered by a separate test
    // below. Keeping the two scenarios distinct prevents the earlier
    // ambiguity where "missing-id" was named like a 404 but mocked like
    // an archive.
    const ids = Array.from({ length: 24 }, (_, i) => `mem-${i.toString().padStart(2, "0")}`)
    ids.push("archived-id")

    const retrieveSpy = vi.fn(async ({ page_id }: { page_id: string }) => {
      if (page_id === "archived-id") {
        return buildPage(
          { Title: { type: "title", title: [{ plain_text: "doesn't matter" }] } },
          { id: page_id, archived: true },
        )
      }
      return titlePage(page_id, `Title of ${page_id}`)
    })
    const client = { pages: { retrieve: retrieveSpy } } as unknown as Client
    const service = new MemoryService(client, db)

    const loader = (id: string) => service.getTitleById(id)

    // First run — one retrieve per distinct id.
    const { resolveTitles } = await import("../mcp/render.js")
    const first = await resolveTitles(ids, loader)
    // Present ids render their title; the archived id is dropped by resolveTitles.
    expect(first.size).toBe(24)
    const firstRunCalls = retrieveSpy.mock.calls.length
    expect(firstRunCalls).toBe(25)

    // Second run — every id hits the cache (values + archived tombstone). Zero fetches.
    const second = await resolveTitles(ids, loader)
    expect(second.size).toBe(24)
    expect(retrieveSpy.mock.calls.length).toBe(firstRunCalls)
  })

  it("genuinely-missing ids (404/throw) do NOT tombstone — next wake-up retries", async () => {
    // Complements the archived-id integration test above: a 404 / network
    // error takes the transient path, so the second call re-fetches rather
    // than serving a stale tombstone. This was the reviewer's concern —
    // previously the "missing-id" test conflated archived (tombstone) with
    // missing (transient), which are different paths with different
    // caching semantics.
    const ids = ["mem-01", "truly-gone"]
    const retrieveSpy = vi.fn(async ({ page_id }: { page_id: string }) => {
      if (page_id === "truly-gone") throw new Error("404 not found")
      return titlePage(page_id, `Title of ${page_id}`)
    })
    const client = { pages: { retrieve: retrieveSpy } } as unknown as Client
    const service = new MemoryService(client, db)

    const loader = (id: string) => service.getTitleById(id)
    const { resolveTitles } = await import("../mcp/render.js")

    await resolveTitles(ids, loader)
    await resolveTitles(ids, loader)

    // mem-01 is cached after the first run (1 fetch total).
    // truly-gone takes the transient path on both runs (2 fetches total).
    const callsForPresent = retrieveSpy.mock.calls.filter(
      (c) => c[0].page_id === "mem-01",
    ).length
    const callsForMissing = retrieveSpy.mock.calls.filter(
      (c) => c[0].page_id === "truly-gone",
    ).length
    expect(callsForPresent).toBe(1)
    expect(callsForMissing).toBe(2)
  })

  it("does not clobber the writer's post-update title when a reader was already in flight", async () => {
    // The race the reviewer flagged: reader A's `pages.retrieve` resolves
    // AFTER writer's `update()` has installed the authoritative new title
    // via write-through. Without the epoch guard, reader A would overwrite
    // the writer's value with the pre-update page. With the guard, reader
    // A observes a bumped epoch at commit and refuses to write, leaving
    // the writer's authoritative value in the cache.
    let releaseRead!: () => void
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const updateSpy = vi.fn(async () => ({}))
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "" }))
    // `getById` after update needs its own retrieve; return "New title".
    let retrieveCount = 0
    const retrieveAll = vi.fn(async ({ page_id }: { page_id: string }) => {
      retrieveCount++
      // First retrieve (reader A) is gated + returns "Old".
      if (retrieveCount === 1) {
        await readGate
        return titlePage(page_id, "Old title")
      }
      // Subsequent retrieves (post-update getById) return "New".
      return titlePage(page_id, "New title")
    })
    const client = {
      pages: {
        retrieve: retrieveAll,
        update: updateSpy,
        retrieveMarkdown: retrieveMarkdownSpy,
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    // Dispatch reader A; it awaits the gate.
    const readerA = service.getTitleById("mem-1")

    // Writer runs to completion: its `update()` call issues a
    // `pages.update` + post-update `getById` (returns "New title") + a
    // write-through `titleCache.set("mem-1", "New title")`.
    await service.update("mem-1", { title: "New title" })

    // Release reader A. The retrieve resolves with the pre-update page.
    releaseRead()
    const readerAResult = await readerA

    // Reader A sees the pre-update page content — reads don't block on
    // writes.
    expect(readerAResult).toBe("Old title")

    // But the cache retains the writer's authoritative "New title" —
    // reader A's stale value was NOT committed because the write epoch
    // advanced during its retrieve.
    expect(await service.getTitleById("mem-1")).toBe("New title")
    expect(updateSpy).toHaveBeenCalledTimes(1)
  })

  it("does not clobber when a reader dispatches DURING the writer's pages.update", async () => {
    // Finding #5 from PR #54 round-2 review: the generation counter
    // protects readers dispatched *before* the writer's pre-bump, but
    // also needs to protect readers dispatched *during* the in-flight
    // Notion write — after the pre-bump but before the post-bump.
    // Without the post-write sandwich bump, such a reader's
    // `writeEpoch === startEpoch` check would pass and it would commit
    // a stale value, clobbering the writer's authoritative `set`.
    //
    // The scenario:
    //   t0: getTitleById("mem-1") → cache miss, captures startEpoch=1
    //       (pre-bump has already fired from a prior update)
    //   t1: dispatches pages.retrieve (gated)
    //   t2: writer runs update() to completion: pre-bump (ep=2), delete,
    //       pages.update, getById (→ "Newest"), set(id, "Newest"),
    //       post-bump (ep=3)
    //   t3: reader's retrieve resolves with the pre-"Newest" page
    //       ("Pre-race"). Epoch check: writeEpoch=3 ≠ startEpoch=1 →
    //       commit skipped. Cache keeps "Newest".
    //
    // If the post-bump were missing, at t3 writeEpoch=2 === startEpoch=1
    // would still catch it (because the pre-bump fired). But if the
    // reader's start was AFTER the pre-bump (startEpoch=2), only the
    // post-bump catches it.
    const service = new MemoryService(
      {
        pages: {
          retrieve: vi.fn(),
          update: vi.fn(),
          retrieveMarkdown: vi.fn(),
        },
      } as unknown as Client,
      db,
    )

    // Simulate: reader dispatches at startEpoch=2, which is exactly
    // the state between pre-bump and post-bump of a running writer.
    // The simplest way to model that: manually bump once, then invoke
    // the read path, then bump again, then simulate the retrieve
    // resolving.
    ;(service as unknown as { writeEpoch: number }).writeEpoch = 2
    const startEpoch = (service as unknown as { writeEpoch: number }).writeEpoch
    expect(startEpoch).toBe(2)

    // Manually bump a second time — this is what `update()`'s post-write
    // set+bump does. If the sandwich is correctly installed, a reader
    // that captured startEpoch=2 must not commit when writeEpoch=3.
    ;(service as unknown as { bumpWriteEpoch: () => void }).bumpWriteEpoch()
    expect((service as unknown as { writeEpoch: number }).writeEpoch).toBe(3)

    // Invoke the private commit-decision logic: manually set a value into
    // the cache at epoch=3 (simulating the writer's write-through), then
    // try to call fetchTitleAndCache with the stale startEpoch=2. The
    // epoch check should skip the commit.
    const titleCache = (service as unknown as {
      titleCache: { get(id: string): unknown; set(id: string, v: string | null): void }
    }).titleCache
    titleCache.set("mem-1", "Newest")

    // Manually run a "reader that captured startEpoch=2" path via the
    // private fetchTitleAndCache.
    const page = buildPage(
      { Title: { type: "title", title: [{ plain_text: "Pre-race" }] } },
      { id: "mem-1" },
    )
    const client = (service as unknown as { client: Client }).client as Client & {
      pages: { retrieve: ReturnType<typeof vi.fn> }
    }
    client.pages.retrieve = vi.fn(async () => page)

    const result = await (
      service as unknown as {
        fetchTitleAndCache(id: string, startEpoch: number): Promise<string | null>
      }
    ).fetchTitleAndCache("mem-1", 2)

    // Reader returns the pre-race page's title — reads don't block on writes.
    expect(result).toBe("Pre-race")
    // But the cache still holds "Newest" — the stale commit was suppressed.
    expect(titleCache.get("mem-1")).toBe("Newest")
  })
})

describe("MemoryService.materializeContent", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function makeIndexTierMemory(id: string) {
    return {
      id,
      title: "Some memory",
      projectIds: [],
      topicId: null,
      source: "manual" as const,
      kind: "note" as const,
      status: "informational" as const,
      confidence: "certain" as const,
      confidenceScore: null,
      reviewBy: null,
      doneAt: null,
      decidedAt: null,
      lastReferencedAt: null,
      supersedesIds: [],
      affectsIds: [],
      alternatives: "",
      consequences: "",
      author: "",
      agent: "",
      tags: [],
      keywords: "",
      synopsis: "Short synopsis",
      session: "",
      content: "",
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      taskState: null,
      blockedBy: "",
      entity: "",
    }
  }

  it("issues exactly one pages.retrieveMarkdown call and zero pages.retrieve calls", async () => {
    const retrieveSpy = vi.fn()
    const retrieveMarkdownSpy = vi.fn(async () => ({
      markdown: "# Body\n\nlong content",
    }))
    const client = {
      pages: { retrieve: retrieveSpy, retrieveMarkdown: retrieveMarkdownSpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const memory = makeIndexTierMemory("mem-1")
    const hydrated = await service.materializeContent(memory)

    expect(retrieveMarkdownSpy).toHaveBeenCalledTimes(1)
    expect(retrieveMarkdownSpy).toHaveBeenCalledWith({ page_id: "mem-1" })
    expect(retrieveSpy).not.toHaveBeenCalled()
    expect(hydrated.content).toBe("# Body\n\nlong content")
  })

  it("preserves all non-content fields from the input row", async () => {
    const client = {
      pages: {
        retrieve: vi.fn(),
        retrieveMarkdown: vi.fn(async () => ({ markdown: "body" })),
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const memory = makeIndexTierMemory("mem-1")
    const hydrated = await service.materializeContent(memory)

    expect(hydrated.id).toBe(memory.id)
    expect(hydrated.title).toBe(memory.title)
    expect(hydrated.synopsis).toBe(memory.synopsis)
    expect(hydrated.kind).toBe(memory.kind)
    expect(hydrated.createdAt).toBe(memory.createdAt)
  })

  it("propagates pages.retrieveMarkdown failures (caller catches and degrades)", async () => {
    const client = {
      pages: {
        retrieve: vi.fn(),
        retrieveMarkdown: vi.fn(async () => {
          throw new Error("notion 503")
        }),
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const memory = makeIndexTierMemory("mem-1")
    await expect(service.materializeContent(memory)).rejects.toThrow("notion 503")
  })
})

// ---------------------------------------------------------------------------
// getManyById — batched fetch used by `lore-query action='ask'` to seed
// `touchOnRead` (issue 0.8.0/05). Pinned here so a future refactor of
// the underlying `getById` semantics surfaces the round-trip + 404
// filter contract this method publishes.
// ---------------------------------------------------------------------------

describe("MemoryService.getManyById", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildMemoryPage(id: string, title: string): PageObjectResponse {
    return {
      ...buildPage({
        Title: { type: "title", title: [{ plain_text: title }] },
      }),
      id,
      url: `https://notion.so/${id}`,
    } as PageObjectResponse
  }

  it("returns a Memory per input id, in input order, when every id resolves", async () => {
    const retrieve = vi.fn(async ({ page_id }: { page_id: string }) =>
      buildMemoryPage(page_id, `Memory ${page_id}`),
    )
    const retrieveMarkdown = vi.fn()
    const client = { pages: { retrieve, retrieveMarkdown } } as unknown as Client
    const service = new MemoryService(client, db)

    const memories = await service.getManyById(["m-1", "m-2", "m-3"])

    expect(memories.map((m) => m.id)).toEqual(["m-1", "m-2", "m-3"])
    expect(memories.map((m) => m.title)).toEqual([
      "Memory m-1",
      "Memory m-2",
      "Memory m-3",
    ])
    expect(retrieve).toHaveBeenCalledTimes(3)
  })

  it("issues exactly one pages.retrieve and zero pages.retrieveMarkdown per id", async () => {
    // Spec budget for `getManyById` (issue 0.8.0/05): "one
    // `pages.retrieve` per memory beyond the original read." Routing
    // through `getById` would also fire `retrieveMarkdown` per id,
    // doubling the Notion call count for cited source-memories on the
    // ask hot path. The properties-only posture is load-bearing —
    // `touchOnRead` only reads property fields off the row.
    const retrieve = vi.fn(async ({ page_id }: { page_id: string }) =>
      buildMemoryPage(page_id, `Memory ${page_id}`),
    )
    const retrieveMarkdown = vi.fn()
    const client = { pages: { retrieve, retrieveMarkdown } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.getManyById(["m-1", "m-2", "m-3"])

    expect(retrieve).toHaveBeenCalledTimes(3)
    expect(retrieveMarkdown).not.toHaveBeenCalled()
  })

  it("filters out 404 / archived / permission failures rather than rejecting the batch", async () => {
    // touchOnRead callers pass IDs they believe exist (from list/search
    // results); rows that disappeared between the read and the touch
    // must be silently dropped so the touch never inflates the
    // surrounding tool's failure surface.
    const retrieve = vi.fn(async ({ page_id }: { page_id: string }) => {
      if (page_id === "m-gone") throw new Error("notion 404")
      return buildMemoryPage(page_id, `Memory ${page_id}`)
    })
    const retrieveMarkdown = vi.fn()
    const client = { pages: { retrieve, retrieveMarkdown } } as unknown as Client
    const service = new MemoryService(client, db)

    const memories = await service.getManyById(["m-1", "m-gone", "m-3"])

    expect(memories.map((m) => m.id)).toEqual(["m-1", "m-3"])
  })

  it("returns an empty array for an empty input — no Notion calls", async () => {
    const retrieve = vi.fn()
    const retrieveMarkdown = vi.fn()
    const client = { pages: { retrieve, retrieveMarkdown } } as unknown as Client
    const service = new MemoryService(client, db)

    const memories = await service.getManyById([])

    expect(memories).toEqual([])
    expect(retrieve).not.toHaveBeenCalled()
    expect(retrieveMarkdown).not.toHaveBeenCalled()
  })

  it("dispatches retrieve calls in parallel — every fetch starts before any returns", async () => {
    // Mirrors the lore-expand parallel-dispatch invariant: a serial
    // `for await` loop would only kick off one fetch at a time.
    const inflight = new Map<string, () => void>()
    const started: string[] = []

    const retrieve = vi.fn(({ page_id }: { page_id: string }) => {
      started.push(page_id)
      return new Promise<PageObjectResponse>((resolve) => {
        inflight.set(page_id, () => resolve(buildMemoryPage(page_id, `T ${page_id}`)))
      })
    })
    const retrieveMarkdown = vi.fn()
    const client = { pages: { retrieve, retrieveMarkdown } } as unknown as Client
    const service = new MemoryService(client, db)

    const pending = service.getManyById(["m-a", "m-b", "m-c"])
    await new Promise((r) => setImmediate(r))
    expect(started).toEqual(["m-a", "m-b", "m-c"])

    inflight.get("m-a")?.()
    inflight.get("m-b")?.()
    inflight.get("m-c")?.()

    const memories = await pending
    expect(memories.map((m) => m.id)).toEqual(["m-a", "m-b", "m-c"])
  })

  it("dedupes repeated input ids before dispatching — one fetch per distinct id", async () => {
    // Mirrors `lore-memory action='expand'`'s dedup-on-input contract:
    // a caller passing `["a", "a", "b"]` gets one fetch per distinct
    // id and one Memory per distinct id back. Saves an unnecessary
    // Notion round-trip when the upstream collector hasn't deduped.
    const retrieve = vi.fn(async ({ page_id }: { page_id: string }) =>
      buildMemoryPage(page_id, `Memory ${page_id}`),
    )
    const retrieveMarkdown = vi.fn()
    const client = { pages: { retrieve, retrieveMarkdown } } as unknown as Client
    const service = new MemoryService(client, db)

    const memories = await service.getManyById(["m-a", "m-a", "m-b"])

    expect(retrieve).toHaveBeenCalledTimes(2)
    expect(memories.map((m) => m.id)).toEqual(["m-a", "m-b"])
  })

  it("returns memories with empty content — properties-only fetch", async () => {
    // The Memory shape carries `content` for downstream renderers.
    // Property-only fetch leaves it empty; callers needing the body
    // must use `getById` instead. Pinned so a future contributor
    // doesn't "helpfully" route through `getById` and silently
    // re-introduce the doubled Notion budget the spec rejected.
    const retrieve = vi.fn(async ({ page_id }: { page_id: string }) =>
      buildMemoryPage(page_id, `Memory ${page_id}`),
    )
    const retrieveMarkdown = vi.fn()
    const client = { pages: { retrieve, retrieveMarkdown } } as unknown as Client
    const service = new MemoryService(client, db)

    const memories = await service.getManyById(["m-1"])

    expect(memories[0]!.content).toBe("")
    expect(retrieveMarkdown).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// touchOnRead + decrementConfidence — confidence dynamics I/O
// ---------------------------------------------------------------------------

describe("MemoryService.touchOnRead", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }
  const TODAY = "2026-04-29"

  function makeMemoryShape(
    overrides: {
      id?: string
      confidence?: "certain" | "likely" | "speculative"
      confidenceScore?: number | null
      lastReferencedAt?: string | null
      createdAt?: string
    } = {},
  ) {
    return {
      id: overrides.id ?? "m1",
      confidence: overrides.confidence ?? ("certain" as const),
      confidenceScore: overrides.confidenceScore ?? null,
      lastReferencedAt: overrides.lastReferencedAt ?? null,
      createdAt: overrides.createdAt ?? "2026-04-29T00:00:00.000Z",
    }
  }

  it("short-circuits when lastReferencedAt is today AND confidenceScore is non-null", async () => {
    const update = vi.fn(async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined)
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.touchOnRead(
      [
        makeMemoryShape({
          id: "m1",
          confidenceScore: 0.85,
          lastReferencedAt: TODAY,
        }),
      ],
      { today: TODAY },
    )

    expect(update).not.toHaveBeenCalled()
  })

  it("does not short-circuit when lastReferencedAt is today but confidenceScore is null", async () => {
    // Realistic concurrent-read scenario: another touch wrote
    // `Last Referenced At` but the score column is still empty (the
    // companion column write would only diverge under a partial Notion
    // failure, but the helper must not skip on the in-memory snapshot).
    const update = vi.fn(async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined)
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.touchOnRead(
      [
        makeMemoryShape({
          id: "m1",
          confidenceScore: null,
          lastReferencedAt: TODAY,
        }),
      ],
      { today: TODAY },
    )

    expect(update).toHaveBeenCalledTimes(1)
  })

  it("seed-decay-then-bumps a never-scored row whose createdAt is recent", async () => {
    // createdAt is today → zero stale days → decay no-ops, only the
    // bump applies. seed("certain") = 0.9; bump(0.9) = 0.9 + 0.1*0.05
    // = 0.905.
    const update = vi.fn(async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined)
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.touchOnRead(
      [
        makeMemoryShape({
          confidence: "certain",
          confidenceScore: null,
          lastReferencedAt: null,
          createdAt: `${TODAY}T00:00:00.000Z`,
        }),
      ],
      { today: TODAY },
    )

    expect(update).toHaveBeenCalledTimes(1)
    const writtenScore = (update.mock.calls[0]![0] as unknown as {
      properties: { "Confidence Score": { number: number } }
    }).properties["Confidence Score"].number
    expect(writtenScore).toBeCloseTo(0.905, 6)
  })

  it("seed-decay-then-bumps a never-scored 200-day-old row (pre-migration convergence)", async () => {
    // 2026-04-29 minus 200 days = 2025-10-11 → 200 days elapsed →
    // 140 stale days past the 60-day grace.
    // seed("certain") = 0.9 → decay = 0.9 * 0.99^140 → bump.
    const update = vi.fn(async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined)
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.touchOnRead(
      [
        makeMemoryShape({
          confidence: "certain",
          confidenceScore: null,
          lastReferencedAt: null,
          createdAt: "2025-10-11T00:00:00.000Z",
        }),
      ],
      { today: TODAY },
    )

    const writtenScore = (update.mock.calls[0]![0] as unknown as {
      properties: { "Confidence Score": { number: number } }
    }).properties["Confidence Score"].number
    const decayed = 0.9 * Math.pow(0.99, 140)
    const expected = decayed + (1 - decayed) * 0.05
    expect(writtenScore).toBeCloseTo(expected, 6)
    // Sanity: should land far below the no-decay baseline (~0.905).
    expect(writtenScore).toBeLessThan(0.3)
  })

  it("decays-then-bumps a stale row instead of bumping the stored score directly", async () => {
    // 2026-04-29 minus 100 days = 2026-01-19 → 100 days elapsed →
    // 40 stale days past the 60-day grace. Stored 0.9 → decay
    // 0.9 * 0.99^40 ≈ 0.602 → bump → ≈ 0.622. NOT bump(0.9) ≈ 0.905.
    const update = vi.fn(async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined)
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.touchOnRead(
      [
        makeMemoryShape({
          confidenceScore: 0.9,
          lastReferencedAt: "2026-01-19",
        }),
      ],
      { today: TODAY },
    )

    const writtenScore = (update.mock.calls[0]![0] as unknown as {
      properties: { "Confidence Score": { number: number } }
    }).properties["Confidence Score"].number
    const decayed = 0.9 * Math.pow(0.99, 40)
    const expected = decayed + (1 - decayed) * 0.05
    expect(writtenScore).toBeCloseTo(expected, 6)
    // Sanity: should not be the no-decay bump value (~0.905).
    expect(writtenScore).toBeLessThan(0.7)
  })

  it("writes both Confidence Score and Last Referenced At in a single pages.update", async () => {
    const update = vi.fn(async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined)
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.touchOnRead([makeMemoryShape()], { today: TODAY })

    expect(update).toHaveBeenCalledTimes(1)
    const args = update.mock.calls[0]![0] as {
      properties: Record<string, unknown>
    }
    expect(args.properties["Last Referenced At"]).toEqual({
      date: { start: TODAY },
    })
    expect(args.properties["Confidence Score"]).toMatchObject({
      number: expect.any(Number),
    })
  })

  it("isolates per-row failures and continues processing the rest of the batch", async () => {
    const update = vi.fn(async (args: { page_id: string }) => {
      if (args.page_id === "m-bad") throw new Error("notion 503")
      return undefined
    })
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)
    const errors: Array<{ id: string; message: string }> = []

    await service.touchOnRead(
      [
        makeMemoryShape({ id: "m-good-1" }),
        makeMemoryShape({ id: "m-bad" }),
        makeMemoryShape({ id: "m-good-2" }),
      ],
      {
        today: TODAY,
        onError: (id, error) => {
          errors.push({
            id,
            message: error instanceof Error ? error.message : String(error),
          })
        },
      },
    )

    expect(update).toHaveBeenCalledTimes(3)
    expect(errors).toEqual([{ id: "m-bad", message: "notion 503" }])
  })

  it("does not throw when a row fails and onError is omitted (the callback is optional)", async () => {
    // Sibling to the `onError` failure-isolation test above: the
    // helper's signature marks `onError` as optional, so a caller that
    // doesn't pass one must still get advisory non-throwing semantics
    // — the read result is preserved regardless of write outcome.
    const update = vi.fn(
      async (args: { page_id: string; properties: Record<string, unknown> }) => {
        if (args.page_id === "m-bad") throw new Error("notion 503")
        return undefined
      },
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await expect(
      service.touchOnRead(
        [
          makeMemoryShape({ id: "m-good-1" }),
          makeMemoryShape({ id: "m-bad" }),
          makeMemoryShape({ id: "m-good-2" }),
        ],
        { today: TODAY },
      ),
    ).resolves.toBeUndefined()
    expect(update).toHaveBeenCalledTimes(3)
  })

  it("is a no-op (and issues no Notion calls) for an empty memory list", async () => {
    const update = vi.fn(async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined)
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.touchOnRead([], { today: TODAY })

    expect(update).not.toHaveBeenCalled()
  })

  it("treats `confidenceScore non-null + lastReferencedAt null` as no-op decay (corner-case safety net)", async () => {
    // Production callers always write both columns together via
    // `touchOnRead` / `decrementConfidence`, so a row with a stored
    // score but no last-reference date shouldn't exist. The type
    // system permits the shape, though, and the implementation leans
    // on `decayConfidenceScore`'s null-tolerant pass-through for this
    // case — pin it so a future "narrow lastReferencedAt to non-null
    // here" refactor surfaces this corner case.
    const update = vi.fn(async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined)
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.touchOnRead(
      [
        makeMemoryShape({
          confidenceScore: 0.7,
          lastReferencedAt: null, // pathological — production never produces this
        }),
      ],
      { today: TODAY },
    )

    const writtenScore = (update.mock.calls[0]![0] as unknown as {
      properties: { "Confidence Score": { number: number } }
    }).properties["Confidence Score"].number
    // No decay applies (lastReferencedAt is null) → bump 0.7 directly:
    // 0.7 + (1 − 0.7) * 0.05 = 0.715.
    expect(writtenScore).toBeCloseTo(0.715, 6)
  })

  it("converges with the bulk-migration baseline on the never-scored branch", async () => {
    // Pre-migration / post-migration convergence test. The migration
    // would compute decay(seed, createdAt, today) — no bump. touchOnRead
    // computes bump(decay(seed, createdAt, today)). Modulo the single
    // bump step (representing the cite the touchOnRead path embodies),
    // the two paths land on the same intermediate decayed value.
    const update = vi.fn(async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined)
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.touchOnRead(
      [
        makeMemoryShape({
          confidence: "likely",
          confidenceScore: null,
          lastReferencedAt: null,
          createdAt: "2025-10-11T00:00:00.000Z",
        }),
      ],
      { today: TODAY },
    )

    const writtenScore = (update.mock.calls[0]![0] as unknown as {
      properties: { "Confidence Score": { number: number } }
    }).properties["Confidence Score"].number
    // seed("likely") = 0.6 → decay over 140 stale days → bump.
    const migrationValue = 0.6 * Math.pow(0.99, 140)
    const touchValue = migrationValue + (1 - migrationValue) * 0.05
    expect(writtenScore).toBeCloseTo(touchValue, 6)
  })
})

describe("MemoryService.decrementConfidence", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }
  const TODAY = "2026-04-29"

  function makeMemoryShape(
    overrides: {
      id?: string
      confidence?: "certain" | "likely" | "speculative"
      confidenceScore?: number | null
      lastReferencedAt?: string | null
      createdAt?: string
    } = {},
  ) {
    return {
      id: overrides.id ?? "m1",
      confidence: overrides.confidence ?? ("certain" as const),
      confidenceScore: overrides.confidenceScore ?? null,
      lastReferencedAt: overrides.lastReferencedAt ?? null,
      createdAt: overrides.createdAt ?? "2026-04-29T00:00:00.000Z",
    }
  }

  it("writes both Confidence Score and Last Referenced At in a single pages.update", async () => {
    const update = vi.fn(async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined)
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.decrementConfidence(
      makeMemoryShape({ confidenceScore: 0.9, lastReferencedAt: TODAY }),
      { today: TODAY },
    )

    expect(update).toHaveBeenCalledTimes(1)
    const args = update.mock.calls[0]![0] as {
      properties: Record<string, unknown>
    }
    expect(args.properties["Last Referenced At"]).toEqual({
      date: { start: TODAY },
    })
    expect(args.properties["Confidence Score"]).toMatchObject({
      number: expect.any(Number),
    })
  })

  it("halves a fresh, non-stale, non-null score (no decay applied)", async () => {
    const update = vi.fn(async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined)
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    const next = await service.decrementConfidence(
      makeMemoryShape({ confidenceScore: 0.9, lastReferencedAt: TODAY }),
      { today: TODAY },
    )

    expect(next).toBeCloseTo(0.45, 6)
  })

  it("decays-then-decrements on a stale row (200 days neglected)", async () => {
    // 200 days elapsed → 140 stale days past 60-day grace.
    // 0.9 * 0.99^140 ≈ 0.220 → halve → ≈ 0.110.
    const update = vi.fn(async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined)
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    const next = await service.decrementConfidence(
      makeMemoryShape({
        confidenceScore: 0.9,
        lastReferencedAt: "2025-10-11",
      }),
      { today: TODAY },
    )

    const decayed = 0.9 * Math.pow(0.99, 140)
    const expected = decayed * 0.5
    expect(next).toBeCloseTo(expected, 6)
    // Sanity: well below the no-decay baseline (0.45).
    expect(next).toBeLessThan(0.2)
  })

  it("seed-decay-then-decrements a never-scored row", async () => {
    // Pre-migration row contradicted directly. seed("certain") = 0.9 →
    // decay against createdAt → halve. Same convergence guarantee as
    // touchOnRead's null-score branch.
    const update = vi.fn(async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined)
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    const next = await service.decrementConfidence(
      makeMemoryShape({
        confidence: "certain",
        confidenceScore: null,
        lastReferencedAt: null,
        createdAt: "2025-10-11T00:00:00.000Z",
      }),
      { today: TODAY },
    )

    const decayed = 0.9 * Math.pow(0.99, 140)
    const expected = decayed * 0.5
    expect(next).toBeCloseTo(expected, 6)
  })

  it("returns the new score from the call", async () => {
    const update = vi.fn(async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined)
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    const next = await service.decrementConfidence(
      makeMemoryShape({ confidenceScore: 0.5, lastReferencedAt: TODAY }),
      { today: TODAY },
    )

    expect(next).toBeCloseTo(0.25, 6)
  })

  it("propagates errors from the underlying pages.update (no onError swallow)", async () => {
    const update = vi.fn(async () => {
      throw new Error("notion 429")
    })
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await expect(
      service.decrementConfidence(
        makeMemoryShape({ confidenceScore: 0.9, lastReferencedAt: TODAY }),
        { today: TODAY },
      ),
    ).rejects.toThrow("notion 429")
  })
})

// ---------------------------------------------------------------------------
// listAllForBackfill + applyBackfillScore — confidence-score migration helpers
// (issue 0.8.0/11). Pinned here so a future refactor does not silently break
// the migration's contract.
// ---------------------------------------------------------------------------

describe("MemoryService.listAllForBackfill", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function makePage(
    id: string,
    overrides: Partial<PageObjectResponse> = {},
    properties: Record<string, unknown> = {},
  ): PageObjectResponse {
    return {
      object: "page",
      id,
      created_time: "2026-01-01T00:00:00.000Z",
      last_edited_time: "2026-02-01T00:00:00.000Z",
      archived: false,
      properties: {
        Title: { type: "title", title: [{ plain_text: id, text: { content: id } }] },
        ...properties,
      } as unknown as PageObjectResponse["properties"],
      parent: { type: "database_id", database_id: "db-id" },
      url: `https://notion.so/${id}`,
      ...overrides,
    } as PageObjectResponse
  }

  it("paginates through every page and yields every non-archived row", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        results: [makePage("m1"), makePage("m2")],
        has_more: true,
        next_cursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        results: [makePage("m3")],
        has_more: false,
        next_cursor: null,
      })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    const ids: string[] = []
    for await (const memory of service.listAllForBackfill()) {
      ids.push(memory.id)
    }
    expect(ids).toEqual(["m1", "m2", "m3"])
    expect(query).toHaveBeenCalledTimes(2)
    // Second call carries the cursor from the first response.
    expect(query.mock.calls[1]![0]).toMatchObject({ start_cursor: "cursor-1" })
  })

  it("filters out archived rows client-side", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      results: [
        makePage("m-live"),
        makePage("m-archived", { archived: true }),
        makePage("m-also-live"),
      ],
      has_more: false,
      next_cursor: null,
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    const ids: string[] = []
    for await (const memory of service.listAllForBackfill()) {
      ids.push(memory.id)
    }
    expect(ids).toEqual(["m-live", "m-also-live"])
  })

  it("scopes to a project via the project-or-unscoped filter when projectId is set", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    const iter = service.listAllForBackfill({ projectId: "project-123" })
    // Drain.
    for await (const _m of iter) void _m
    expect(query).toHaveBeenCalledTimes(1)
    const args = query.mock.calls[0]![0] as {
      filter: unknown
      sorts: unknown
      page_size: number
    }
    expect(args.filter).toBeDefined()
    // Sanity: the filter mentions the project id (exact shape comes from
    // `projectOrUnscopedFilter`, pinned in its own tests).
    expect(JSON.stringify(args.filter)).toContain("project-123")
    expect(args.sorts).toEqual([
      { timestamp: "created_time", direction: "ascending" },
    ])
    expect(args.page_size).toBe(100)
  })

  it("issues no filter when projectId is omitted (vault-wide scope)", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    for await (const _m of service.listAllForBackfill()) void _m
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]![0]).toMatchObject({ filter: undefined })
  })
})

describe("MemoryService.applyBackfillScore", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  it("writes both Confidence Score and Last Referenced At in a single pages.update", async () => {
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) =>
        undefined,
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.applyBackfillScore("memory-1", 0.42, "2025-10-11")

    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0]![0]).toEqual({
      page_id: "memory-1",
      properties: {
        "Confidence Score": { number: 0.42 },
        "Last Referenced At": { date: { start: "2025-10-11" } },
      },
    })
  })

  it("propagates errors from the underlying pages.update", async () => {
    const update = vi.fn(async () => {
      throw new Error("notion 429")
    })
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await expect(
      service.applyBackfillScore("memory-1", 0.5, "2025-10-11"),
    ).rejects.toThrow("notion 429")
  })
})
