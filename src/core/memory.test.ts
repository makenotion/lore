import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { MemoryService, pageToMemory } from "./memory.js"
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
      Keywords: {
        type: "rich_text",
        rich_text: [{ plain_text: "pr-25701 MailboxViewStore.swift" }],
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
    expect(memory.keywords).toBe("pr-25701 MailboxViewStore.swift")
    expect(memory.session).toBe("sess-42")
    expect(memory.content).toBe("Rationale prose.")
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
