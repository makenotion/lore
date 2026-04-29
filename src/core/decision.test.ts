import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { DecisionService } from "./decision.js"
import type { DatabaseRef, MemoryKind } from "../types.js"

/**
 * Notion client mock pattern — partial `Client` stub where every method used
 * by `DecisionService` is a `vi.fn()`. Tests inspect `.mock.calls` to assert
 * on what arguments were sent. This is the first file in the codebase to
 * establish this pattern; PR 3 extends it for MCP tool tests.
 */

type MockablePage = Partial<PageObjectResponse> & { id: string }

function makePage(overrides: MockablePage): PageObjectResponse {
  return {
    object: "page",
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-02-01T00:00:00.000Z",
    archived: false,
    url: `https://notion.so/${overrides.id}`,
    parent: { type: "database_id", database_id: "memories-db" },
    properties: {},
    ...overrides,
  } as PageObjectResponse
}

function decisionPage(
  id: string,
  overrides?: { supersedesIds?: string[]; kind?: MemoryKind; status?: string; reviewBy?: string }
): PageObjectResponse {
  return makePage({
    id,
    properties: {
      Title: { type: "title", title: [{ plain_text: `Decision ${id}` }] } as unknown,
      Kind: {
        type: "select",
        select: { name: overrides?.kind ?? "decision" },
      } as unknown,
      Status: {
        type: "select",
        select: { name: overrides?.status ?? "accepted" },
      } as unknown,
      Supersedes: {
        type: "relation",
        relation: (overrides?.supersedesIds ?? []).map((i) => ({ id: i })),
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
  hasMore?: boolean
  nextCursor?: string | null
}

function createMockClient(opts: MockClientOpts = {}) {
  const defaultCreate = makePage({ id: "new-page-id" })
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
        has_more: opts.hasMore ?? false,
        next_cursor: opts.nextCursor ?? null,
      }),
    },
  } as unknown as Client & { pages: { create: ReturnType<typeof vi.fn> } }
}

const DB: DatabaseRef = {
  databaseId: "memories-db-id",
  dataSourceId: "memories-ds-id",
}

describe("DecisionService.create", () => {
  it("sets Kind=decision, Status=accepted, Decided At=today by default", async () => {
    const client = createMockClient()
    const service = new DecisionService(client, DB)

    const before = new Date().toISOString().split("T")[0]
    await service.create({
      decision: "Use DecisionService",
      rationale: "Testing defaults",
    })

    const createArgs = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(createArgs.parent).toEqual({
      type: "database_id",
      database_id: "memories-db-id",
    })
    expect(createArgs.properties.Kind).toEqual({ select: { name: "decision" } })
    expect(createArgs.properties.Status).toEqual({ select: { name: "accepted" } })
    expect(createArgs.properties.Confidence).toEqual({ select: { name: "certain" } })
    expect(createArgs.properties["Decided At"].date.start >= before).toBe(true)
  })

  it("writes rationale as page body via updateMarkdown", async () => {
    const client = createMockClient()
    const service = new DecisionService(client, DB)

    await service.create({
      decision: "Use rich_text for alternatives",
      rationale: "YAML frontmatter gets destroyed by full_page updates.",
    })

    const markdownArgs = (client.pages.updateMarkdown as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(markdownArgs.type).toBe("insert_content")
    expect(markdownArgs.insert_content.content).toBe(
      "YAML frontmatter gets destroyed by full_page updates."
    )
  })

  it("does not call updateMarkdown when rationale is empty", async () => {
    const client = createMockClient()
    const service = new DecisionService(client, DB)

    await service.create({
      decision: "Bare decision",
      rationale: "",
    })

    expect(client.pages.updateMarkdown).not.toHaveBeenCalled()
  })

  it("passes through explicit status, confidence, reviewBy, supersedesIds", async () => {
    const client = createMockClient()
    const service = new DecisionService(client, DB)

    await service.create({
      decision: "With overrides",
      rationale: "...",
      status: "proposed",
      confidence: "speculative",
      reviewBy: "2026-12-31",
      supersedesIds: ["old-1", "old-2"],
      affectsIds: ["mem-a", "mem-b"],
    })

    const props = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0].properties
    expect(props.Status).toEqual({ select: { name: "proposed" } })
    expect(props.Confidence).toEqual({ select: { name: "speculative" } })
    expect(props["Review By"].date.start).toBe("2026-12-31")
    expect(props.Supersedes.relation).toEqual([{ id: "old-1" }, { id: "old-2" }])
    expect(props.Affects.relation).toEqual([{ id: "mem-a" }, { id: "mem-b" }])
  })

  it("decodes doubly-encoded synopsis at the write boundary", async () => {
    // Through-path proof of the inline `decodeTextEntities` seam at
    // `decision.ts:create`. The rest of `DecisionService` doesn't decode
    // any fields today, so this is the lone seam — a future contributor
    // dropping the wrapper has nothing else to catch the regression.
    const client = createMockClient()
    const service = new DecisionService(client, DB)

    await service.create({
      decision: "Cache project resolutions",
      rationale: "long form",
      synopsis: "Foo &amp;amp; Bar",
    })

    const props = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0].properties
    expect(props.Synopsis).toEqual({
      rich_text: [{ text: { content: "Foo & Bar" } }],
    })
  })

  it("does NOT emit Synopsis on the create page when synopsis is omitted", async () => {
    // `buildMemoryProps` gates the Synopsis emission on `!== undefined`;
    // this test pins that omitting the field produces no Synopsis key on
    // the create payload (rather than a cleared rich_text).
    const client = createMockClient()
    const service = new DecisionService(client, DB)

    await service.create({
      decision: "No synopsis",
      rationale: "rationale",
    })

    const props = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0].properties
    expect(props.Synopsis).toBeUndefined()
  })
})

describe("DecisionService.getById", () => {
  it("returns a Decision when Kind is 'decision'", async () => {
    const client = createMockClient({
      retrievedPages: { "dec-1": decisionPage("dec-1") },
      markdown: "Rationale body",
    })
    const service = new DecisionService(client, DB)

    const decision = await service.getById("dec-1")
    expect(decision.kind).toBe("decision")
    expect(decision.content).toBe("Rationale body")
  })

  it("throws when the page is not a decision", async () => {
    const notADecision = decisionPage("mem-1", { kind: "note" })
    const client = createMockClient({
      retrievedPages: { "mem-1": notADecision },
    })
    const service = new DecisionService(client, DB)

    await expect(service.getById("mem-1")).rejects.toThrow(/not a decision/)
  })
})

describe("DecisionService.list — index tier, no body fetch", () => {
  it("includes Kind=decision in the filter", async () => {
    const client = createMockClient()
    const service = new DecisionService(client, DB)

    await service.list()

    const queryArgs = (client.dataSources.query as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // Filter with no other opts is just the single Kind filter, not wrapped in and
    expect(queryArgs.filter).toEqual({
      property: "Kind",
      select: { equals: "decision" },
    })
  })

  it("composes status + projectId filters under `and`", async () => {
    const client = createMockClient()
    const service = new DecisionService(client, DB)

    await service.list({ status: "accepted", projectId: "proj-1" })

    const queryArgs = (client.dataSources.query as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(queryArgs.filter.and).toContainEqual({
      property: "Kind",
      select: { equals: "decision" },
    })
    expect(queryArgs.filter.and).toContainEqual({
      property: "Status",
      select: { equals: "accepted" },
    })
    // projectOrUnscopedFilter wraps project in an `or`
    const projectFilter = (queryArgs.filter.and as Array<Record<string, unknown>>).find(
      (f) => Array.isArray((f as { or?: unknown[] }).or)
    )
    expect(projectFilter).toBeTruthy()
  })

  it("returns summaries with no content and makes zero retrieveMarkdown calls", async () => {
    const client = createMockClient({
      queryResults: [decisionPage("dec-1"), decisionPage("dec-2"), decisionPage("dec-3")],
    })
    const service = new DecisionService(client, DB)

    const { items } = await service.list()

    expect(items).toHaveLength(3)
    expect(client.pages.retrieveMarkdown).not.toHaveBeenCalled()
    // DecisionSummary omits `content` at the type level; at runtime the object
    // has no content property.
    for (const summary of items) {
      expect(summary).not.toHaveProperty("content")
      expect(summary.kind).toBe("decision")
    }
  })

  it("exposes nextCursor when the Notion response reports has_more", async () => {
    const client = createMockClient({
      queryResults: [decisionPage("dec-1")],
      hasMore: true,
      nextCursor: "notion-cursor-abc",
    })
    const service = new DecisionService(client, DB)

    const { items, nextCursor } = await service.list()

    expect(items).toHaveLength(1)
    expect(nextCursor).toBe("notion-cursor-abc")
  })

  it("omits nextCursor when has_more is false", async () => {
    const client = createMockClient({
      queryResults: [decisionPage("dec-1")],
      hasMore: false,
      nextCursor: "should-be-ignored",
    })
    const service = new DecisionService(client, DB)

    const { nextCursor } = await service.list()

    expect(nextCursor).toBeUndefined()
  })

  it("forwards startCursor to dataSources.query as start_cursor", async () => {
    const client = createMockClient({ queryResults: [] })
    const service = new DecisionService(client, DB)

    await service.list({ startCursor: "resume-from-here" })

    const queryArgs = (client.dataSources.query as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(queryArgs.start_cursor).toBe("resume-from-here")
  })
})

describe("DecisionService.supersede — atomic, ordered", () => {
  let client: ReturnType<typeof createMockClient>
  let service: DecisionService

  beforeEach(() => {
    client = createMockClient({
      retrievedPages: { "new-dec": decisionPage("new-dec", { supersedesIds: [] }) },
    })
    service = new DecisionService(client, DB)
  })

  it("updates the new decision's Supersedes BEFORE marking old as superseded", async () => {
    await service.supersede("new-dec", "old-dec")

    const updateFn = client.pages.update as ReturnType<typeof vi.fn>
    expect(updateFn).toHaveBeenCalledTimes(2)
    expect(updateFn.mock.calls[0][0].page_id).toBe("new-dec")
    expect(updateFn.mock.calls[1][0].page_id).toBe("old-dec")
  })

  it("writes Supersedes relation on new and Status=superseded on old", async () => {
    await service.supersede("new-dec", "old-dec")

    const updateFn = client.pages.update as ReturnType<typeof vi.fn>
    expect(updateFn.mock.calls[0][0].properties.Supersedes).toEqual({
      relation: [{ id: "old-dec" }],
    })
    expect(updateFn.mock.calls[1][0].properties.Status).toEqual({
      select: { name: "superseded" },
    })
  })

  it("merges with existing Supersedes relations (does not clobber)", async () => {
    const local = createMockClient({
      retrievedPages: {
        "new-dec": decisionPage("new-dec", { supersedesIds: ["prior-1"] }),
      },
    })
    const localService = new DecisionService(local, DB)

    await localService.supersede("new-dec", "old-dec")

    const updateArgs = (local.pages.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(updateArgs.properties.Supersedes.relation).toEqual([
      { id: "prior-1" },
      { id: "old-dec" },
    ])
  })

  it("does not duplicate an already-superseded entry", async () => {
    const local = createMockClient({
      retrievedPages: {
        "new-dec": decisionPage("new-dec", { supersedesIds: ["old-dec"] }),
      },
    })
    const localService = new DecisionService(local, DB)

    await localService.supersede("new-dec", "old-dec")

    const updateArgs = (local.pages.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(updateArgs.properties.Supersedes.relation).toEqual([{ id: "old-dec" }])
  })
})

describe("DecisionService.getDecisionChain — cycle-safe walk", () => {
  it("walks backward through supersedesIds and stops at a root", async () => {
    const client = createMockClient({
      retrievedPages: {
        "dec-c": decisionPage("dec-c", { supersedesIds: ["dec-b"] }),
        "dec-b": decisionPage("dec-b", { supersedesIds: ["dec-a"] }),
        "dec-a": decisionPage("dec-a", { supersedesIds: [] }),
      },
    })
    const service = new DecisionService(client, DB)

    const chain = await service.getDecisionChain("dec-c")
    expect(chain.map((d) => d.id)).toEqual(["dec-c", "dec-b", "dec-a"])
  })

  it("terminates on a cycle via visited-set guard", async () => {
    // Pathological data: A supersedes B, B supersedes A.
    const client = createMockClient({
      retrievedPages: {
        "dec-a": decisionPage("dec-a", { supersedesIds: ["dec-b"] }),
        "dec-b": decisionPage("dec-b", { supersedesIds: ["dec-a"] }),
      },
    })
    const service = new DecisionService(client, DB)

    const chain = await service.getDecisionChain("dec-a")
    // We walk A → B, then B would send us back to A but visited-set stops us.
    expect(chain.map((d) => d.id)).toEqual(["dec-a", "dec-b"])
  })
})

describe("DecisionService.reviewCompleted", () => {
  it("uses the provided date when given", async () => {
    const client = createMockClient()
    const service = new DecisionService(client, DB)

    await service.reviewCompleted("dec-1", "2027-01-15")

    const updateArgs = (client.pages.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(updateArgs.properties["Review By"]).toEqual({
      date: { start: "2027-01-15" },
    })
  })

  it("defaults to +90 days when no date is given", async () => {
    const client = createMockClient()
    const service = new DecisionService(client, DB)

    await service.reviewCompleted("dec-1")

    const updateArgs = (client.pages.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const pushed = new Date(updateArgs.properties["Review By"].date.start)
    const now = new Date()
    const diffDays = Math.round((pushed.getTime() - now.getTime()) / 86_400_000)
    // Allow ±1 day slack for clock boundaries / DST.
    expect(diffDays).toBeGreaterThanOrEqual(89)
    expect(diffDays).toBeLessThanOrEqual(91)
  })
})

describe("DecisionService.queryOverdue", () => {
  it("filters by Kind=decision, Review By on_or_before today, and active status", async () => {
    const client = createMockClient()
    const service = new DecisionService(client, DB)

    await service.queryOverdue()

    const queryArgs = (client.dataSources.query as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const andFilters = queryArgs.filter.and as Array<Record<string, unknown>>

    expect(andFilters).toContainEqual({
      property: "Kind",
      select: { equals: "decision" },
    })
    const today = new Date().toISOString().split("T")[0]
    expect(andFilters).toContainEqual({
      property: "Review By",
      date: { on_or_before: today },
    })
    // Active-status clause is an `or` across proposed + accepted
    const statusClause = andFilters.find(
      (f) => Array.isArray((f as { or?: unknown[] }).or)
    ) as { or: Array<Record<string, unknown>> } | undefined
    expect(statusClause).toBeTruthy()
    expect(statusClause!.or).toContainEqual({
      property: "Status",
      select: { equals: "proposed" },
    })
    expect(statusClause!.or).toContainEqual({
      property: "Status",
      select: { equals: "accepted" },
    })
  })

  it("sorts by Review By ascending (oldest first)", async () => {
    const client = createMockClient()
    const service = new DecisionService(client, DB)

    await service.queryOverdue()

    const queryArgs = (client.dataSources.query as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(queryArgs.sorts).toEqual([{ property: "Review By", direction: "ascending" }])
  })

  it("returns summaries (no body fetch)", async () => {
    const client = createMockClient({
      queryResults: [decisionPage("dec-1", { reviewBy: "2026-01-01" })],
    })
    const service = new DecisionService(client, DB)

    const results = await service.queryOverdue()

    expect(results).toHaveLength(1)
    expect(client.pages.retrieveMarkdown).not.toHaveBeenCalled()
    expect(results[0]).not.toHaveProperty("content")
  })

  it("paginates beyond the first 100 rows when no limit is supplied", async () => {
    // Pre-fix behavior: a single dataSources.query with no page_size
    // and no cursor loop silently truncated at Notion's default 100-row
    // page. A vault with > 100 overdue decisions lost the tail. The
    // sort is `Review By asc` so truncation drops the *least* overdue
    // rows — but the gap is real: an operator running `lore-audit`
    // and counting visible rows would believe that's the complete set.
    const page1 = Array.from({ length: 100 }, (_, i) =>
      decisionPage(`d1-${i}`, { reviewBy: "2026-01-01" }),
    )
    const page2 = Array.from({ length: 50 }, (_, i) =>
      decisionPage(`d2-${i}`, { reviewBy: "2026-02-01" }),
    )
    const responses = [
      { results: page1, has_more: true, next_cursor: "c1" },
      { results: page2, has_more: false, next_cursor: null },
    ]
    let i = 0
    const querySpy = vi.fn().mockImplementation(() => {
      const r = responses[Math.min(i, responses.length - 1)]
      i += 1
      return Promise.resolve(r)
    })
    const client = {
      pages: {
        create: vi.fn(),
        retrieve: vi.fn(),
        update: vi.fn(),
        updateMarkdown: vi.fn(),
        retrieveMarkdown: vi.fn(),
      },
      dataSources: { query: querySpy },
    } as unknown as Client
    const service = new DecisionService(client, DB)

    const results = await service.queryOverdue()

    expect(querySpy).toHaveBeenCalledTimes(2)
    expect(results).toHaveLength(150)
    // Cursor must thread across pages.
    expect(querySpy.mock.calls[1][0]).toMatchObject({ start_cursor: "c1" })
  })

  it("stops paginating once the limit is reached", async () => {
    // Limit-reached-mid-page: caller asked for 10, Notion's first
    // response carried 100 rows. A second query MUST NOT fire.
    const page1 = Array.from({ length: 100 }, (_, i) =>
      decisionPage(`d-${i}`, { reviewBy: "2026-01-01" }),
    )
    const querySpy = vi.fn().mockResolvedValue({
      results: page1,
      has_more: true,
      next_cursor: "c1",
    })
    const client = {
      pages: {
        create: vi.fn(),
        retrieve: vi.fn(),
        update: vi.fn(),
        updateMarkdown: vi.fn(),
        retrieveMarkdown: vi.fn(),
      },
      dataSources: { query: querySpy },
    } as unknown as Client
    const service = new DecisionService(client, DB)

    const results = await service.queryOverdue({ limit: 10 })

    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(results).toHaveLength(10)
  })

  it("clamps page_size to min(limit, 100) when limit is small", async () => {
    // Avoid pulling 100 rows when the caller only wants a handful.
    const client = createMockClient()
    const service = new DecisionService(client, DB)

    await service.queryOverdue({ limit: 5 })

    const queryArgs = (client.dataSources.query as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(queryArgs.page_size).toBe(5)
  })

  it("clamps page_size to Notion's 100-row ceiling when no limit is supplied", async () => {
    // `limit ?? 100` defaults to 100 and Math.min(100, 100) === 100.
    // Going higher would 400 from Notion.
    const client = createMockClient()
    const service = new DecisionService(client, DB)

    await service.queryOverdue()

    const queryArgs = (client.dataSources.query as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(queryArgs.page_size).toBe(100)
  })

  it("clamps page_size to 100 when limit exceeds Notion's ceiling", async () => {
    // A caller passing limit=500 must not produce page_size=500 —
    // Notion rejects > 100 with a 400.
    const client = createMockClient()
    const service = new DecisionService(client, DB)

    await service.queryOverdue({ limit: 500 })

    const queryArgs = (client.dataSources.query as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(queryArgs.page_size).toBe(100)
  })
})

describe("DecisionService.getById — cache", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("serves repeat lookups from the in-process cache", async () => {
    const client = createMockClient({
      retrievedPages: { "dec-1": decisionPage("dec-1") },
      markdown: "body",
    })
    const service = new DecisionService(client, DB)

    await service.getById("dec-1")
    await service.getById("dec-1")
    await service.getById("dec-1")

    expect(client.pages.retrieve).toHaveBeenCalledTimes(1)
    expect(client.pages.retrieveMarkdown).toHaveBeenCalledTimes(1)
  })

  it("requeries after the TTL elapses", async () => {
    const client = createMockClient({
      retrievedPages: { "dec-1": decisionPage("dec-1") },
      markdown: "body",
    })
    const service = new DecisionService(client, DB)

    await service.getById("dec-1")
    vi.advanceTimersByTime(30_001)
    await service.getById("dec-1")

    expect(client.pages.retrieve).toHaveBeenCalledTimes(2)
  })

  it("does not cache a throw (non-decision kind)", async () => {
    const notADecision = decisionPage("mem-1", { kind: "note" })
    const client = createMockClient({
      retrievedPages: { "mem-1": notADecision },
    })
    const service = new DecisionService(client, DB)

    await expect(service.getById("mem-1")).rejects.toThrow()
    await expect(service.getById("mem-1")).rejects.toThrow()

    // Both calls must round-trip — a cached throw would be a leak.
    expect(client.pages.retrieve).toHaveBeenCalledTimes(2)
  })

  it("invalidates the cache entry on supersede (both ids)", async () => {
    const newDecision = decisionPage("new-dec", { supersedesIds: [] })
    const oldDecision = decisionPage("old-dec")
    const client = createMockClient({
      retrievedPages: {
        "new-dec": newDecision,
        "old-dec": oldDecision,
      },
    })
    const service = new DecisionService(client, DB)

    // Warm the cache for both decisions.
    await service.getById("new-dec")
    await service.getById("old-dec")
    expect(client.pages.retrieve).toHaveBeenCalledTimes(2)

    await service.supersede("new-dec", "old-dec")

    await service.getById("new-dec")
    await service.getById("old-dec")

    // Initial warm reads newId + oldId (2). supersede evicts newId
    // before reading so its merge base is fresh (1). supersede then
    // invalidates both ids after writes, so the two post-supersede
    // getById calls round-trip (2). Total: 2 + 1 + 2 = 5.
    expect(client.pages.retrieve).toHaveBeenCalledTimes(5)
  })

  it("evicts before reading in supersede so writeback merges against fresh supersedesIds", async () => {
    // A stale cached supersedesIds would let supersede clobber
    // supersessions recorded elsewhere inside the TTL window. Verify
    // the pre-read eviction by observing the writeback uses fresh
    // (not cached) supersedesIds.
    const stale = decisionPage("new-dec", { supersedesIds: [] })
    const fresh = decisionPage("new-dec", { supersedesIds: ["prior-from-elsewhere"] })
    const client = createMockClient({
      retrievedPages: { "new-dec": fresh, "old-dec": decisionPage("old-dec") },
    })
    const retrieveMock = client.pages.retrieve as ReturnType<typeof vi.fn>
    retrieveMock
      .mockResolvedValueOnce(stale) // initial warm
      .mockResolvedValueOnce(fresh) // supersede's internal getById
    const service = new DecisionService(client, DB)

    await service.getById("new-dec") // warm cache with stale (empty supersedesIds)
    await service.supersede("new-dec", "old-dec")

    // The writeback must preserve `prior-from-elsewhere`, not merge
    // against the stale (empty) cached value.
    const updateArgs = (client.pages.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(updateArgs.properties.Supersedes.relation).toEqual([
      { id: "prior-from-elsewhere" },
      { id: "old-dec" },
    ])
  })

  it("invalidates the cache entry on reviewCompleted", async () => {
    const decision = decisionPage("dec-1")
    const client = createMockClient({
      retrievedPages: { "dec-1": decision },
    })
    const service = new DecisionService(client, DB)

    await service.getById("dec-1")
    expect(client.pages.retrieve).toHaveBeenCalledTimes(1)

    await service.reviewCompleted("dec-1")
    await service.getById("dec-1")

    expect(client.pages.retrieve).toHaveBeenCalledTimes(2)
  })

  it("clearCache() forces the next lookup back to Notion", async () => {
    const client = createMockClient({
      retrievedPages: { "dec-1": decisionPage("dec-1") },
    })
    const service = new DecisionService(client, DB)

    await service.getById("dec-1")
    service.clearCache()
    await service.getById("dec-1")

    expect(client.pages.retrieve).toHaveBeenCalledTimes(2)
  })
})

describe("DecisionService.getById — stampede dedup", () => {
  it("collapses N concurrent cold-start reads onto one retrieve + one retrieveMarkdown", async () => {
    // This is the acceptance path for resolveCanonicalDecisionLinks:
    // parallel supersession walks converging on a shared ancestor each
    // invoke getById(ancestor) inside the same tick. Without
    // `getOrLoad` every converger pays its own pair of Notion calls.
    const client = createMockClient({
      retrievedPages: { "dec-1": decisionPage("dec-1") },
      markdown: "body",
    })
    // Delay both reads so concurrent callers stack on the pending slot.
    const retrieveMock = client.pages.retrieve as ReturnType<typeof vi.fn>
    retrieveMock.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(decisionPage("dec-1")), 5)
        )
    )
    const retrieveMarkdownMock = client.pages
      .retrieveMarkdown as ReturnType<typeof vi.fn>
    retrieveMarkdownMock.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ markdown: "body" }), 5))
    )
    const service = new DecisionService(client, DB)

    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.getById("dec-1"))
    )

    expect(results.map((d) => d.id)).toEqual(Array(8).fill("dec-1"))
    expect(retrieveMock).toHaveBeenCalledTimes(1)
    expect(retrieveMarkdownMock).toHaveBeenCalledTimes(1)
  })

  it("supersede's pre-read delete drops an in-flight getById loader so the merge base is fresh", async () => {
    // Mirror of the topic-side concurrent-delete regression. A
    // `decision-graph.ts` walker calls `getById(newId)` with a slow
    // loader in flight. Between the loader's dispatch and its
    // resolution, some external actor (another Lore session, manual
    // Notion edit, migration script) adds `external-prior` to the
    // decision's `Supersedes` relation. Then `supersede(newId, oldId)`
    // fires — its pre-read `idCache.delete(newId)` must force its
    // internal `getById` to dispatch a fresh retrieve rather than
    // await the stale in-flight loader, or the subsequent
    // `merged = [...existing, oldId]` base would drop
    // `external-prior` and the `pages.update` would clobber it.
    const stale = decisionPage("new-dec", { supersedesIds: ["prior"] })
    const fresh = decisionPage("new-dec", {
      supersedesIds: ["prior", "external-prior"],
    })
    const oldDecision = decisionPage("old-dec")
    const client = createMockClient({
      retrievedPages: { "old-dec": oldDecision },
      markdown: "body",
    })

    const retrieveMock = client.pages.retrieve as ReturnType<typeof vi.fn>
    retrieveMock
      // A's in-flight getById — delayed, returns stale supersedesIds.
      .mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve(stale), 5))
      )
      // supersede's internal getById (after `delete(newId)`) —
      // dispatched fresh under the primitive fix, returns the current
      // view including `external-prior`.
      .mockResolvedValueOnce(fresh)

    const retrieveMarkdownMock = client.pages.retrieveMarkdown as ReturnType<
      typeof vi.fn
    >
    retrieveMarkdownMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ markdown: "body" }), 5)
          )
      )
      .mockResolvedValueOnce({ markdown: "body" })

    const service = new DecisionService(client, DB)

    // A's read is in flight when supersede runs. Under the fix,
    // supersede's pre-read delete drops A's pending slot; A's loader
    // still resolves for A's own caller but its value must not be
    // reused as supersede's merge base.
    const aRead = service.getById("new-dec")
    await service.supersede("new-dec", "old-dec")
    await aRead

    const updateArgs = (client.pages.update as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
    // Post-fix: merge base is the fresh view — `external-prior`
    // survives rather than being clobbered.
    expect(updateArgs.page_id).toBe("new-dec")
    expect(updateArgs.properties.Supersedes.relation).toEqual([
      { id: "prior" },
      { id: "external-prior" },
      { id: "old-dec" },
    ])
    // Two distinct retrieves: A's (stale, in-flight at delete time)
    // and supersede's (fresh, dispatched after delete). Pre-fix there
    // would have been only one: supersede reusing A's pending.
    expect(retrieveMock).toHaveBeenCalledTimes(2)
  })

  it("propagates a loader throw to every concurrent waiter without caching it", async () => {
    // Load-bearing: when a non-decision id races through a concurrent
    // fan-out, every waiter should reject with the same error, and the
    // next call must retry (no poisoned cache entry, no poisoned pending
    // slot).
    const notADecision = decisionPage("mem-1", { kind: "note" })
    const client = createMockClient({ retrievedPages: { "mem-1": notADecision } })
    const retrieveMock = client.pages.retrieve as ReturnType<typeof vi.fn>
    retrieveMock
      .mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve(notADecision), 5))
      )
      .mockResolvedValueOnce(notADecision)
    const service = new DecisionService(client, DB)

    const settled = await Promise.allSettled([
      service.getById("mem-1"),
      service.getById("mem-1"),
      service.getById("mem-1"),
    ])
    for (const r of settled) {
      expect(r.status).toBe("rejected")
      if (r.status === "rejected") expect(String(r.reason)).toMatch(/not a decision/)
    }
    // All three shared one retrieve because they collapsed on the pending slot.
    expect(retrieveMock).toHaveBeenCalledTimes(1)

    // A subsequent call runs the loader again — pending slot was cleared
    // and the throw was not cached.
    await expect(service.getById("mem-1")).rejects.toThrow(/not a decision/)
    expect(retrieveMock).toHaveBeenCalledTimes(2)
  })
})
