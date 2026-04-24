import { describe, expect, it, vi, beforeEach } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { FactService, __resetProbeFailureLogForTests } from "./fact.js"
import { normalize, computeFactDedupKey } from "../notion/normalize.js"
import {
  TRACKING_PREDICATES,
  type DatabaseRef,
  type FactPredicate,
} from "../types.js"

const DB: DatabaseRef = {
  databaseId: "facts-db",
  dataSourceId: "facts-ds",
}

// Alias: HEAD's listRecent tests reference `db`; keep both names pointing at
// the same value so neither test block needs rewriting during the merge.
const db = DB

/**
 * Build a synthetic fact page with just the properties the service reads.
 * Missing columns default via the extractors, which mirrors a pre-migration
 * fact row that never had a `DedupKey`.
 */
function factPage(overrides: {
  id?: string
  subject?: string
  predicate?: FactPredicate
  object?: string
  dedupKey?: string
  reviewBy?: string | null
  validUntil?: string | null
  projectIds?: string[]
  sourceMemoryId?: string | null
}): PageObjectResponse {
  return {
    object: "page",
    id: overrides.id ?? "fact-id",
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-02-01T00:00:00.000Z",
    archived: false,
    url: `https://notion.so/${overrides.id ?? "fact-id"}`,
    parent: { type: "database_id", database_id: "facts-db" },
    properties: {
      Subject: {
        type: "title",
        title: [{ plain_text: overrides.subject ?? "Sub" }],
      } as unknown,
      Predicate: {
        type: "select",
        select: { name: overrides.predicate ?? "uses" },
      } as unknown,
      Object: {
        type: "rich_text",
        rich_text: [{ plain_text: overrides.object ?? "Obj" }],
      } as unknown,
      Project: {
        type: "relation",
        relation: (overrides.projectIds ?? []).map((id) => ({ id })),
      } as unknown,
      "Valid From": {
        type: "date",
        date: { start: "2026-01-01" },
      } as unknown,
      "Valid Until":
        overrides.validUntil !== undefined
          ? ({
              type: "date",
              date: overrides.validUntil
                ? { start: overrides.validUntil }
                : null,
            } as unknown)
          : ({ type: "date", date: null } as unknown),
      "Review By":
        overrides.reviewBy !== undefined
          ? ({
              type: "date",
              date: overrides.reviewBy
                ? { start: overrides.reviewBy }
                : null,
            } as unknown)
          : ({ type: "date", date: null } as unknown),
      Source: {
        type: "relation",
        relation: overrides.sourceMemoryId
          ? [{ id: overrides.sourceMemoryId }]
          : [],
      } as unknown,
      Confidence: {
        type: "select",
        select: { name: "certain" },
      } as unknown,
      DedupKey: {
        type: "rich_text",
        rich_text: overrides.dedupKey
          ? [{ plain_text: overrides.dedupKey }]
          : [],
      } as unknown,
    } as PageObjectResponse["properties"],
  } as PageObjectResponse
}

function createMockClient() {
  return {
    dataSources: { query: vi.fn() },
    pages: { create: vi.fn(), update: vi.fn() },
  } as unknown as Client & {
    dataSources: { query: ReturnType<typeof vi.fn> }
    pages: {
      create: ReturnType<typeof vi.fn>
      update: ReturnType<typeof vi.fn>
    }
  }
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

describe("normalize", () => {
  it("collapses case, whitespace, and trailing punctuation", () => {
    expect(normalize("Foo")).toBe(normalize("foo"))
    expect(normalize(" Foo ")).toBe(normalize("foo"))
    expect(normalize("Foo  bar")).toBe(normalize("foo bar"))
    expect(normalize("Foo.")).toBe(normalize("Foo"))
    expect(normalize("Foo!!")).toBe(normalize("foo"))
  })

  it("preserves embedded punctuation", () => {
    expect(normalize("file.ts")).toBe("file.ts")
    expect(normalize("a-b_c")).toBe("a-b_c")
  })

  it("folds Unicode NFC vs NFD to the same form", () => {
    const nfc = "café" // precomposed é
    const nfd = "café" // e + combining acute
    expect(nfc).not.toBe(nfd)
    expect(normalize(nfc)).toBe(normalize(nfd))
  })

  it("preserves trailing closing brackets", () => {
    // Strip is limited to sentence terminators + whitespace so balanced
    // punctuation survives intact. Pinned so a future regex widening
    // (e.g. back to `\p{P}`) can't silently change dedup grouping.
    expect(normalize("foo (bar)")).toBe("foo (bar)")
    expect(normalize("module.ts")).toBe("module.ts")
    expect(normalize("Foo.bar.")).toBe("foo.bar")
  })
})

describe("computeFactDedupKey", () => {
  it("produces identical keys for cosmetically different triples", () => {
    const a = computeFactDedupKey({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
    })
    const b = computeFactDedupKey({
      subject: " authservice ",
      predicate: "uses",
      object: "jwt.",
    })
    expect(a).toBe(b)
  })

  it("distinguishes triples that move content across fields", () => {
    const a = computeFactDedupKey({
      subject: "a b",
      predicate: "uses",
      object: "c",
    })
    const b = computeFactDedupKey({
      subject: "a",
      predicate: "uses",
      object: "b c",
    })
    expect(a).not.toBe(b)
  })

  it("returns a fixed-length 64-char hex digest regardless of input size", () => {
    const short = computeFactDedupKey({
      subject: "a",
      predicate: "uses",
      object: "b",
    })
    const long = computeFactDedupKey({
      subject: "x".repeat(3000),
      predicate: "uses",
      object: "y".repeat(3000),
    })
    expect(short).toMatch(/^[0-9a-f]{64}$/)
    expect(long).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("FactService.createWithDedup", () => {
  let client: ReturnType<typeof createMockClient>
  let service: FactService

  beforeEach(() => {
    client = createMockClient()
    service = new FactService(client, DB)
  })

  it("writes a new fact with DedupKey when no match exists", async () => {
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.pages.create.mockResolvedValueOnce(
      factPage({
        id: "new-fact",
        subject: "AuthService",
        predicate: "uses",
        object: "JWT",
      })
    )

    const result = await service.createWithDedup({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
    })

    expect(result.deduped).toBe(false)
    expect(result.fact.id).toBe("new-fact")
    expect(client.pages.create).toHaveBeenCalledTimes(1)
    const createCall = client.pages.create.mock.calls[0][0]
    const dedupProp = createCall.properties.DedupKey
    expect(dedupProp.rich_text[0].text.content).toBe(
      computeFactDedupKey({
        subject: "AuthService",
        predicate: "uses",
        object: "JWT",
      })
    )
  })

  it("unions missing projectIds into the existing row and flags enrichment", async () => {
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "live-fact",
          projectIds: ["proj-x"],
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await service.createWithDedup({
      subject: "Sub",
      predicate: "uses",
      object: "Obj",
      projectIds: ["proj-x", "proj-y"],
    })

    expect(result.deduped).toBe(true)
    expect(result.enriched).toContain("added 1 project")
    expect(result.fact.projectIds).toEqual(["proj-x", "proj-y"])
    // Atomic merge invariant: partial-enrichment hits ship exactly one
    // update touching only the affected property.
    expect(client.pages.update).toHaveBeenCalledTimes(1)
    const projectUpdate = client.pages.update.mock.calls.find(
      (c: Array<{ properties?: { Project?: unknown } }>) =>
        c[0].properties && c[0].properties.Project
    )
    if (!projectUpdate) throw new Error("expected a Project update call")
    expect(projectUpdate[0].properties.Project.relation).toEqual([
      { id: "proj-x" },
      { id: "proj-y" },
    ])
  })

  it("does not re-write Project when all requested projectIds already link", async () => {
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "live-fact",
          projectIds: ["proj-x", "proj-y"],
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await service.createWithDedup({
      subject: "Sub",
      predicate: "uses",
      object: "Obj",
      projectIds: ["proj-x"],
    })

    expect(result.deduped).toBe(true)
    expect(result.enriched).toEqual([])
    const projectUpdate = client.pages.update.mock.calls.find(
      (c: Array<{ properties?: { Project?: unknown } }>) =>
        c[0].properties && c[0].properties.Project
    )
    expect(projectUpdate).toBeUndefined()
  })

  it("links sourceMemoryId on an orphaned existing row (first-writer-wins)", async () => {
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "orphan",
          sourceMemoryId: null,
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await service.createWithDedup({
      subject: "Sub",
      predicate: "uses",
      object: "Obj",
      sourceMemoryId: "mem-new",
    })

    expect(result.deduped).toBe(true)
    expect(result.enriched).toContain("linked source memory")
    expect(result.fact.sourceMemoryId).toBe("mem-new")
    expect(client.pages.update).toHaveBeenCalledTimes(1)
    const sourceUpdate = client.pages.update.mock.calls.find(
      (c: Array<{ properties?: { Source?: unknown } }>) =>
        c[0].properties && c[0].properties.Source
    )
    if (!sourceUpdate) throw new Error("expected a Source update call")
    expect(sourceUpdate[0].properties.Source.relation).toEqual([
      { id: "mem-new" },
    ])
  })

  it("preserves an existing sourceMemoryId (first-writer-wins, no clobber)", async () => {
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "sourced",
          sourceMemoryId: "mem-original",
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await service.createWithDedup({
      subject: "Sub",
      predicate: "uses",
      object: "Obj",
      sourceMemoryId: "mem-new",
    })

    expect(result.deduped).toBe(true)
    expect(result.enriched).not.toContain("linked source memory")
    expect(result.fact.sourceMemoryId).toBe("mem-original")
    const sourceUpdate = client.pages.update.mock.calls.find(
      (c: Array<{ properties?: { Source?: unknown } }>) =>
        c[0].properties && c[0].properties.Source
    )
    expect(sourceUpdate).toBeUndefined()
  })

  it("extends existing fact's Review By and returns deduped when live match exists", async () => {
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "live-fact",
          subject: "AuthService",
          predicate: "uses",
          object: "JWT",
          reviewBy: "2026-04-01",
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await service.createWithDedup({
      subject: " authservice ",
      predicate: "uses",
      object: "jwt.",
      reviewBy: "2026-05-01",
    })

    expect(result.deduped).toBe(true)
    expect(result.enriched).toContain("extended review to 2026-05-01")
    expect(result.fact.id).toBe("live-fact")
    expect(result.fact.reviewBy).toBe("2026-05-01")
    expect(client.pages.create).not.toHaveBeenCalled()
    expect(client.pages.update).toHaveBeenCalledTimes(1)
    expect(client.pages.update).toHaveBeenCalledWith({
      page_id: "live-fact",
      properties: {
        "Review By": { date: { start: "2026-05-01" } },
      },
    })
  })

  it("skips the extend write when the incoming review date matches existing", async () => {
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "live-fact",
          subject: "AuthService",
          predicate: "uses",
          object: "JWT",
          reviewBy: "2026-04-01",
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await service.createWithDedup({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      reviewBy: "2026-04-01",
    })

    expect(result.deduped).toBe(true)
    expect(result.enriched).toEqual([])
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("writes a new fact when only invalidated matches exist", async () => {
    // Probe filters on Valid Until is_empty, so invalidated rows are not
    // returned — the service sees an empty result and creates a fresh row.
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.pages.create.mockResolvedValueOnce(
      factPage({ id: "new-fact" })
    )

    const result = await service.createWithDedup({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
    })

    expect(result.deduped).toBe(false)
    expect(client.pages.create).toHaveBeenCalledTimes(1)
  })

  it("falls back to blind create when the dedup probe throws", async () => {
    __resetProbeFailureLogForTests()
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    client.dataSources.query.mockRejectedValueOnce(
      new Error("transient API error")
    )
    client.pages.create.mockResolvedValueOnce(
      factPage({ id: "fallback-fact" })
    )

    const result = await service.createWithDedup({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
    })

    expect(result.deduped).toBe(false)
    expect(result.fact.id).toBe("fallback-fact")
    expect(client.pages.create).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalledTimes(1)
    errSpy.mockRestore()
  })

  it("logs probe failures at most once per process", async () => {
    __resetProbeFailureLogForTests()
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    client.dataSources.query.mockRejectedValue(
      new Error("Could not find property 'DedupKey'")
    )
    client.pages.create.mockResolvedValue(factPage({ id: "f" }))

    await service.createWithDedup({
      subject: "a",
      predicate: "uses",
      object: "b",
    })
    await service.createWithDedup({
      subject: "a",
      predicate: "uses",
      object: "b",
    })
    await service.createWithDedup({
      subject: "c",
      predicate: "uses",
      object: "d",
    })

    // Once across three probe failures — pre-migration vaults don't spam
    // stderr on every autosave.
    expect(errSpy).toHaveBeenCalledTimes(1)
    errSpy.mockRestore()
  })

  it("applies default 7-day review window for tracking predicates on miss", async () => {
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.pages.create.mockResolvedValueOnce(
      factPage({ id: "new-fact", predicate: "needs_action" })
    )

    await service.createWithDedup({
      subject: "Foo",
      predicate: "needs_action",
      object: "Handle edge case",
    })

    const createCall = client.pages.create.mock.calls[0][0]
    const reviewByProp = createCall.properties["Review By"]
    expect(reviewByProp.date.start).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("queries with an equals filter on DedupKey and is_empty on Valid Until", async () => {
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.pages.create.mockResolvedValueOnce(factPage({ id: "new" }))

    await service.createWithDedup({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
    })

    const queryCall = client.dataSources.query.mock.calls[0][0]
    expect(queryCall.data_source_id).toBe("facts-ds")
    expect(queryCall.page_size).toBe(1)
    expect(queryCall.filter).toEqual({
      and: [
        {
          property: "DedupKey",
          rich_text: {
            equals: computeFactDedupKey({
              subject: "AuthService",
              predicate: "uses",
              object: "JWT",
            }),
          },
        },
        { property: "Valid Until", date: { is_empty: true } },
      ],
    })
  })

  it("issues exactly one pages.update bundling review, project, and source merges", async () => {
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "live-fact",
          projectIds: ["proj-x"],
          reviewBy: "2026-04-01",
          sourceMemoryId: null,
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await service.createWithDedup({
      subject: "Sub",
      predicate: "uses",
      object: "Obj",
      projectIds: ["proj-x", "proj-y"],
      reviewBy: "2026-05-01",
      sourceMemoryId: "mem-new",
    })

    expect(result.deduped).toBe(true)
    expect(result.enriched).toEqual([
      "extended review to 2026-05-01",
      "added 1 project",
      "linked source memory",
    ])
    expect(client.pages.update).toHaveBeenCalledTimes(1)
    const [updateCall] = client.pages.update.mock.calls
    expect(updateCall[0].page_id).toBe("live-fact")
    expect(updateCall[0].properties).toEqual({
      "Review By": { date: { start: "2026-05-01" } },
      Project: { relation: [{ id: "proj-x" }, { id: "proj-y" }] },
      Source: { relation: [{ id: "mem-new" }] },
    })
  })

  it("leaves enriched empty and issues no update when everything is already present", async () => {
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "live-fact",
          projectIds: ["proj-x"],
          reviewBy: "2026-05-01",
          sourceMemoryId: "mem-existing",
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await service.createWithDedup({
      subject: "Sub",
      predicate: "uses",
      object: "Obj",
      projectIds: ["proj-x"],
      reviewBy: "2026-05-01",
      sourceMemoryId: "mem-existing",
    })

    expect(result.deduped).toBe(true)
    expect(result.enriched).toEqual([])
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("leaves existing in-memory state untouched when the atomic update throws", async () => {
    // Pin the in-memory rollback invariant: if someone later moves the
    // `existing.projectIds = ...` / `existing.sourceMemoryId = ...`
    // mirror assignments back above the `await pages.update`, the
    // retry below would see mergedProjectIds === null and fillingSource
    // === false and issue zero updates — which is the failure mode this
    // test catches. With the assignments correctly placed after the
    // await, the retry recomputes both and issues a second update with
    // the same payload as the first attempt.
    const livePage = factPage({
      id: "live-fact",
      projectIds: ["proj-x"],
      sourceMemoryId: null,
    })
    client.dataSources.query.mockResolvedValue({
      results: [livePage],
      has_more: false,
      next_cursor: null,
    })
    client.pages.update.mockRejectedValueOnce(new Error("Notion 500"))

    await expect(
      service.createWithDedup({
        subject: "Sub",
        predicate: "uses",
        object: "Obj",
        projectIds: ["proj-x", "proj-y"],
        sourceMemoryId: "mem-new",
      })
    ).rejects.toThrow("Notion 500")

    // The caller never sees a half-enriched success — the throw propagates
    // and `enriched` never enters the caller's view. One update attempt,
    // no partial state.
    expect(client.pages.update).toHaveBeenCalledTimes(1)

    // Retry: second call's probe returns the same livePage. If the first
    // attempt had mutated `existing` before the throw, merging the same
    // projectIds would find them already present and skip the Project
    // update — so we'd see `enriched` missing the projects entry. The
    // correct post-throw behaviour is that the second call sees the
    // pristine pre-write state and produces the full enrichment again.
    client.pages.update.mockResolvedValueOnce({})
    const retryResult = await service.createWithDedup({
      subject: "Sub",
      predicate: "uses",
      object: "Obj",
      projectIds: ["proj-x", "proj-y"],
      sourceMemoryId: "mem-new",
    })
    expect(retryResult.deduped).toBe(true)
    expect(retryResult.enriched).toEqual([
      "added 1 project",
      "linked source memory",
    ])
    // One update on the retry — a single atomic payload covering both
    // properties, identical to the shape the first attempt built.
    expect(client.pages.update).toHaveBeenCalledTimes(2)
  })
})

describe("FactService.create (default path)", () => {
  it("returns only the Fact so callers relying on the old signature still work", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.pages.create.mockResolvedValueOnce(factPage({ id: "f1" }))
    const service = new FactService(client, DB)

    const fact = await service.create({
      subject: "a",
      predicate: "uses",
      object: "b",
    })

    expect(fact.id).toBe("f1")
  })
})
