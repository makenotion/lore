import { describe, expect, it, vi, beforeEach } from "vitest"
import type {
  Client,
  GetPagePropertyResponse,
  PageObjectResponse,
} from "@notionhq/client"
import {
  FactService,
  REPOINT_ENTITY_CONCURRENCY,
  __resetDedupDuplicateScopeMatchWarnedForTests,
  __resetProbeFailureLogForTests,
  clampNotionPageSize,
} from "./fact.js"
import { normalize, computeFactDedupKey, computeSubjectKey } from "../notion/normalize.js"
import * as relationProperties from "../notion/relation-properties.js"
import { type DatabaseRef, type FactPredicate } from "../types.js"

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
  subjectEntityId?: string | null
  subjectEntityIds?: string[]
  subjectEntityHasMore?: boolean
  objectEntityId?: string | null
  objectEntityIds?: string[]
  objectEntityHasMore?: boolean
  archived?: boolean
}): PageObjectResponse {
  const subjectEntityIds =
    overrides.subjectEntityIds ??
    (overrides.subjectEntityId ? [overrides.subjectEntityId] : [])
  const objectEntityIds =
    overrides.objectEntityIds ??
    (overrides.objectEntityId ? [overrides.objectEntityId] : [])
  return {
    object: "page",
    id: overrides.id ?? "fact-id",
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-02-01T00:00:00.000Z",
    archived: overrides.archived ?? false,
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
              date: overrides.validUntil ? { start: overrides.validUntil } : null,
            } as unknown)
          : ({ type: "date", date: null } as unknown),
      "Review By":
        overrides.reviewBy !== undefined
          ? ({
              type: "date",
              date: overrides.reviewBy ? { start: overrides.reviewBy } : null,
            } as unknown)
          : ({ type: "date", date: null } as unknown),
      Source: {
        type: "relation",
        relation: overrides.sourceMemoryId ? [{ id: overrides.sourceMemoryId }] : [],
      } as unknown,
      Confidence: {
        type: "select",
        select: { name: "certain" },
      } as unknown,
      DedupKey: {
        type: "rich_text",
        rich_text: overrides.dedupKey ? [{ plain_text: overrides.dedupKey }] : [],
      } as unknown,
      SubjectEntity: {
        id: "subject-entity-prop",
        type: "relation",
        relation: subjectEntityIds.map((id) => ({ id })),
        has_more: overrides.subjectEntityHasMore ?? false,
      } as unknown,
      ObjectEntity: {
        id: "object-entity-prop",
        type: "relation",
        relation: objectEntityIds.map((id) => ({ id })),
        has_more: overrides.objectEntityHasMore ?? false,
      } as unknown,
    } as PageObjectResponse["properties"],
  } as PageObjectResponse
}

function relationListResponse(ids: string[]): GetPagePropertyResponse {
  return {
    object: "list",
    type: "property_item",
    property_item: {
      id: "relation-prop",
      type: "relation",
      relation: {},
      next_url: null,
    },
    results: ids.map((id) => ({
      object: "property_item",
      id: "relation-prop",
      type: "relation",
      relation: { id },
    })),
    has_more: false,
    next_cursor: null,
  } as GetPagePropertyResponse
}

function createMockClient() {
  const retrieve = vi.fn(async (args: { page_id: string }) =>
    factPage({ id: args.page_id })
  )
  return {
    dataSources: { query: vi.fn() },
    pages: {
      create: vi.fn(),
      properties: { retrieve: vi.fn() },
      retrieve,
      update: vi.fn(),
    },
  } as unknown as Client & {
    dataSources: { query: ReturnType<typeof vi.fn> }
    pages: {
      create: ReturnType<typeof vi.fn>
      properties: { retrieve: ReturnType<typeof vi.fn> }
      retrieve: ReturnType<typeof vi.fn>
      update: ReturnType<typeof vi.fn>
    }
  }
}

describe("FactService.extendReview", () => {
  it("uses the provided review date when given", async () => {
    const client = createMockClient()
    const service = new FactService(client, DB)

    await service.extendReview("fact-1", "2027-01-15")

    expect(client.pages.update).toHaveBeenCalledWith({
      page_id: "fact-1",
      properties: {
        "Review By": { date: { start: "2027-01-15" } },
      },
    })
  })

  it("clears the review date when null is provided", async () => {
    const client = createMockClient()
    const service = new FactService(client, DB)

    await service.extendReview("fact-1", null)

    expect(client.pages.update).toHaveBeenCalledWith({
      page_id: "fact-1",
      properties: {
        "Review By": { date: null },
      },
    })
  })
})

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

function createClient(
  responses: Array<{
    results: PageObjectResponse[]
    has_more?: boolean
    next_cursor?: string | null
  }>
) {
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

describe("FactService.repointEntity", () => {
  it("repoints subject-only references", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "fact-subject",
          subjectEntityId: "ent-loser",
          objectEntityId: null,
        }),
      ],
      has_more: false,
      next_cursor: null,
    })
    const service = new FactService(client, DB)

    const result = await service.repointEntity({
      fromEntityId: "ent-loser",
      toEntityId: "ent-winner",
      apply: true,
    })

    expect(result.factsRepointed).toBe(1)
    expect(result.subjectRelationsRepointed).toBe(1)
    expect(result.objectRelationsRepointed).toBe(0)
    expect(client.pages.update).toHaveBeenCalledWith({
      page_id: "fact-subject",
      properties: {
        SubjectEntity: { relation: [{ id: "ent-winner" }] },
      },
    })
  })

  it("repoints object-only references", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "fact-object",
          subjectEntityId: null,
          objectEntityId: "ent-loser",
        }),
      ],
      has_more: false,
      next_cursor: null,
    })
    const service = new FactService(client, DB)

    const result = await service.repointEntity({
      fromEntityId: "ent-loser",
      toEntityId: "ent-winner",
      apply: true,
    })

    expect(result.factsRepointed).toBe(1)
    expect(result.subjectRelationsRepointed).toBe(0)
    expect(result.objectRelationsRepointed).toBe(1)
    expect(client.pages.update).toHaveBeenCalledWith({
      page_id: "fact-object",
      properties: {
        ObjectEntity: { relation: [{ id: "ent-winner" }] },
      },
    })
  })

  it("repoints both sides of one fact with a single update", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "fact-both",
          subjectEntityId: "ent-loser",
          objectEntityId: "ent-loser",
        }),
      ],
      has_more: false,
      next_cursor: null,
    })
    const service = new FactService(client, DB)

    const result = await service.repointEntity({
      fromEntityId: "ent-loser",
      toEntityId: "ent-winner",
      apply: true,
    })

    expect(result.factsRepointed).toBe(1)
    expect(result.subjectRelationsRepointed).toBe(1)
    expect(result.objectRelationsRepointed).toBe(1)
    expect(client.pages.update).toHaveBeenCalledTimes(1)
    expect(client.pages.update).toHaveBeenCalledWith({
      page_id: "fact-both",
      properties: {
        SubjectEntity: { relation: [{ id: "ent-winner" }] },
        ObjectEntity: { relation: [{ id: "ent-winner" }] },
      },
    })
  })

  it("repoints loser ids in multi-valued relations and preserves unrelated ids", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "fact-multi",
          subjectEntityIds: ["ent-stale", "ent-loser"],
          objectEntityIds: ["ent-loser", "ent-other"],
        }),
      ],
      has_more: false,
      next_cursor: null,
    })
    const service = new FactService(client, DB)

    const result = await service.repointEntity({
      fromEntityId: "ent-loser",
      toEntityId: "ent-winner",
      apply: true,
    })

    expect(result.plans).toEqual([{ factId: "fact-multi", subject: true, object: true }])
    expect(result.factsRepointed).toBe(1)
    expect(result.subjectRelationsRepointed).toBe(1)
    expect(result.objectRelationsRepointed).toBe(1)
    expect(client.pages.update).toHaveBeenCalledWith({
      page_id: "fact-multi",
      properties: {
        SubjectEntity: {
          relation: [{ id: "ent-stale" }, { id: "ent-winner" }],
        },
        ObjectEntity: {
          relation: [{ id: "ent-winner" }, { id: "ent-other" }],
        },
      },
    })
  })

  it("does not duplicate the winner when a multi-valued relation already has it", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "fact-winner-present",
          subjectEntityIds: ["ent-winner", "ent-other", "ent-loser"],
        }),
      ],
      has_more: false,
      next_cursor: null,
    })
    const service = new FactService(client, DB)

    const result = await service.repointEntity({
      fromEntityId: "ent-loser",
      toEntityId: "ent-winner",
      apply: true,
    })

    expect(result.plans).toEqual([
      { factId: "fact-winner-present", subject: true, object: false },
    ])
    expect(client.pages.update).toHaveBeenCalledWith({
      page_id: "fact-winner-present",
      properties: {
        SubjectEntity: {
          relation: [{ id: "ent-winner" }, { id: "ent-other" }],
        },
      },
    })
  })

  it("hydrates truncated relation properties before planning and preserving repoints", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "fact-truncated",
          subjectEntityIds: ["ent-inline"],
          subjectEntityHasMore: true,
        }),
      ],
      has_more: false,
      next_cursor: null,
    })
    client.pages.properties.retrieve.mockResolvedValueOnce(
      relationListResponse(["ent-inline", "ent-hidden", "ent-loser"])
    )
    const service = new FactService(client, DB)

    const result = await service.repointEntity({
      fromEntityId: "ent-loser",
      toEntityId: "ent-winner",
      apply: true,
    })

    expect(result.plans).toEqual([
      { factId: "fact-truncated", subject: true, object: false },
    ])
    expect(client.pages.properties.retrieve).toHaveBeenCalledWith({
      page_id: "fact-truncated",
      property_id: "subject-entity-prop",
      page_size: 100,
      start_cursor: undefined,
    })
    expect(client.pages.update).toHaveBeenCalledWith({
      page_id: "fact-truncated",
      properties: {
        SubjectEntity: {
          relation: [{ id: "ent-inline" }, { id: "ent-hidden" }, { id: "ent-winner" }],
        },
      },
    })
  })

  it("ignores defensive raw hits that no longer reference the loser", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "fact-already",
          subjectEntityId: "ent-winner",
          objectEntityId: null,
        }),
      ],
      has_more: false,
      next_cursor: null,
    })
    const service = new FactService(client, DB)

    const result = await service.repointEntity({
      fromEntityId: "ent-loser",
      toEntityId: "ent-winner",
      apply: true,
    })

    expect(result.factsMatched).toBe(1)
    expect(result.plans).toEqual([])
    expect(result.factsRepointed).toBe(0)
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("paginates raw relation hits before planning", async () => {
    const client = createMockClient()
    client.dataSources.query
      .mockResolvedValueOnce({
        results: [
          factPage({
            id: "fact-page-1",
            subjectEntityId: "ent-loser",
          }),
        ],
        has_more: true,
        next_cursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        results: [
          factPage({
            id: "fact-page-2",
            objectEntityId: "ent-loser",
          }),
        ],
        has_more: false,
        next_cursor: null,
      })
    const service = new FactService(client, DB)

    const result = await service.repointEntity({
      fromEntityId: "ent-loser",
      toEntityId: "ent-winner",
      apply: false,
    })

    expect(result.factsMatched).toBe(2)
    expect(result.plans).toEqual([
      { factId: "fact-page-1", subject: true, object: false },
      { factId: "fact-page-2", subject: false, object: true },
    ])
    expect(client.dataSources.query).toHaveBeenCalledTimes(2)
    expect(client.dataSources.query.mock.calls[1][0]).toMatchObject({
      start_cursor: "cursor-2",
    })
  })

  it("repoints raw relation rows even when the predicate is filtered from Fact", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "fact-tracking",
          predicate: "needs_action" as never,
          subjectEntityId: "ent-loser",
        }),
      ],
      has_more: false,
      next_cursor: null,
    })
    const service = new FactService(client, DB)

    const result = await service.repointEntity({
      fromEntityId: "ent-loser",
      toEntityId: "ent-winner",
      apply: true,
    })

    expect(result.factsMatched).toBe(1)
    expect(result.factsRepointed).toBe(1)
    expect(client.pages.update).toHaveBeenCalledWith({
      page_id: "fact-tracking",
      properties: {
        SubjectEntity: { relation: [{ id: "ent-winner" }] },
      },
    })
  })

  it("continues after a per-fact update failure and reports the partial state", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({ id: "fact-ok", subjectEntityId: "ent-loser" }),
        factPage({ id: "fact-fail", subjectEntityId: "ent-loser" }),
      ],
      has_more: false,
      next_cursor: null,
    })
    client.pages.update
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("notion 429"))
    const service = new FactService(client, DB)

    const result = await service.repointEntity({
      fromEntityId: "ent-loser",
      toEntityId: "ent-winner",
      apply: true,
    })

    expect(result.plans).toHaveLength(2)
    expect(result.factsRepointed).toBe(1)
    expect(result.subjectRelationsRepointed).toBe(1)
    expect(result.errors).toEqual([{ factId: "fact-fail", message: "notion 429" }])
  })

  it("bounds concurrent per-fact updates", async () => {
    const client = createMockClient()
    const rows = Array.from({ length: REPOINT_ENTITY_CONCURRENCY + 3 }, (_, i) =>
      factPage({ id: `fact-${i}`, subjectEntityId: "ent-loser" })
    )
    client.dataSources.query.mockResolvedValueOnce({
      results: rows,
      has_more: false,
      next_cursor: null,
    })
    let inFlight = 0
    let maxInFlight = 0
    client.pages.update.mockImplementation(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return {}
    })
    const service = new FactService(client, DB)

    const result = await service.repointEntity({
      fromEntityId: "ent-loser",
      toEntityId: "ent-winner",
      apply: true,
    })

    expect(result.factsRepointed).toBe(rows.length)
    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(REPOINT_ENTITY_CONCURRENCY)
  })

  it("does not write in plan-only mode", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [factPage({ id: "fact-plan", subjectEntityId: "ent-loser" })],
      has_more: false,
      next_cursor: null,
    })
    const service = new FactService(client, DB)

    const result = await service.repointEntity({
      fromEntityId: "ent-loser",
      toEntityId: "ent-winner",
      apply: false,
    })

    expect(result.planOnly).toBe(true)
    expect(result.factsRepointed).toBe(1)
    expect(client.pages.update).not.toHaveBeenCalled()
  })
})

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
      (c) => (c as { property?: string }).property === "Valid Until"
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
      (c) => (c as { property?: string }).property === "Valid Until"
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
    expect(sourceUpdate[0].properties.Source.relation).toEqual([{ id: "mem-new" }])
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

  it("skips the extend write when the incoming review date is older than existing", async () => {
    // Review By is monotonic on dedup hit: a stale or repeated agent write
    // whose reviewBy predates the existing row must not regress the runway.
    // Otherwise a re-asserted fact would surface as overdue earlier than
    // the prior write intended.
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "live-fact",
          subject: "AuthService",
          predicate: "uses",
          object: "JWT",
          reviewBy: "2026-05-01",
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
    expect(result.fact.reviewBy).toBe("2026-05-01")
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("sets Review By when the existing fact has no review date", async () => {
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "live-fact",
          subject: "AuthService",
          predicate: "uses",
          object: "JWT",
          reviewBy: null,
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
    expect(result.enriched).toContain("extended review to 2026-04-01")
    expect(result.fact.reviewBy).toBe("2026-04-01")
    expect(client.pages.update).toHaveBeenCalledTimes(1)
    expect(client.pages.update).toHaveBeenCalledWith({
      page_id: "live-fact",
      properties: {
        "Review By": { date: { start: "2026-04-01" } },
      },
    })
  })

  it("writes a new fact when only invalidated matches exist", async () => {
    // Probe filters on Valid Until is_empty, so invalidated rows are not
    // returned — the service sees an empty result and creates a fresh row.
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.pages.create.mockResolvedValueOnce(factPage({ id: "new-fact" }))

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
    client.dataSources.query.mockRejectedValueOnce(new Error("transient API error"))
    client.pages.create.mockResolvedValueOnce(factPage({ id: "fallback-fact" }))

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

  it("queries with a scope-constrained filter on DedupKey + Valid Until + every scope column", async () => {
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
    // Issue #283 round-4 — dedup probe is now scope-constrained:
    // every scope column is bound on the server (so the result is
    // either the compatible row or empty by construction). The
    // probe asks for `page_size: 2` so duplicate state surfaces as
    // "more than one match" rather than silently picking position 0.
    expect(queryCall.page_size).toBe(2)
    // No incoming scope on this test → filter binds every scope
    // column to is_empty.
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
        { property: "Scope Kind", select: { is_empty: true } },
        { property: "Scope Key", rich_text: { is_empty: true } },
        { property: "Audience", rich_text: { is_empty: true } },
        { property: "Lifetime", select: { is_empty: true } },
        { property: "Expires At", date: { is_empty: true } },
      ],
    })
  })

  it("resets the duplicate scope-match warning between tests", async () => {
    __resetDedupDuplicateScopeMatchWarnedForTests()
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      client.dataSources.query.mockResolvedValue({
        results: [factPage({ id: "first" }), factPage({ id: "second" })],
        has_more: false,
        next_cursor: null,
      })

      await service.createWithDedup({
        subject: "AuthService",
        predicate: "uses",
        object: "JWT",
      })
      await service.createWithDedup({
        subject: "AuthService",
        predicate: "uses",
        object: "JWT",
      })

      expect(stderrSpy).toHaveBeenCalledTimes(1)
      expect(String(stderrSpy.mock.calls[0][0])).toContain(
        "scope-constrained probe found multiple live"
      )

      __resetDedupDuplicateScopeMatchWarnedForTests()
      await service.createWithDedup({
        subject: "AuthService",
        predicate: "uses",
        object: "JWT",
      })

      expect(stderrSpy).toHaveBeenCalledTimes(2)
    } finally {
      stderrSpy.mockRestore()
      __resetDedupDuplicateScopeMatchWarnedForTests()
    }
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

  it("fills missing SubjectEntity and ObjectEntity relations on a deduped legacy row", async () => {
    // Issue #199: cold-create wires `subjectEntityId` / `objectEntityId`
    // through `buildFactProps`, but the dedup path used to drop them.
    // A legacy row that pre-dates PF3-01 has empty entity relations; the
    // current write already resolved canonical ids upstream, so the
    // dedup hit must fold them into the same atomic update.
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "legacy-fact",
          subjectEntityId: null,
          objectEntityId: null,
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await service.createWithDedup({
      subject: "Sub",
      predicate: "uses",
      object: "Obj",
      subjectEntityId: "ent-sub",
      objectEntityId: "ent-obj",
    })

    expect(result.deduped).toBe(true)
    expect(result.enriched).toEqual(["linked subject entity", "linked object entity"])
    expect(result.fact.subjectEntityId).toBe("ent-sub")
    expect(result.fact.objectEntityId).toBe("ent-obj")
    expect(client.pages.update).toHaveBeenCalledTimes(1)
    const [updateCall] = client.pages.update.mock.calls
    expect(updateCall[0].page_id).toBe("legacy-fact")
    expect(updateCall[0].properties).toEqual({
      SubjectEntity: { relation: [{ id: "ent-sub" }] },
      ObjectEntity: { relation: [{ id: "ent-obj" }] },
    })
  })

  it("drops both incoming entity relations when either side is archived", async () => {
    client.pages.retrieve.mockImplementation(async (args: { page_id: string }) =>
      factPage({
        id: args.page_id,
        archived: args.page_id === "ent-sub-archived",
      })
    )
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "legacy-fact",
          subjectEntityId: null,
          objectEntityId: null,
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await service.createWithDedup({
      subject: "Sub",
      predicate: "uses",
      object: "Obj",
      subjectEntityId: "ent-sub-archived",
      objectEntityId: "ent-obj",
    })

    expect(result.deduped).toBe(true)
    expect(result.enriched).toEqual([])
    expect(result.fact.subjectEntityId).toBeNull()
    expect(result.fact.objectEntityId).toBeNull()
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("drops both incoming entity relations when one side is genuinely missing (404 / object_not_found)", async () => {
    // Genuinely-missing entity rows are the ONE error class
    // `liveEntityRelationId` swallows: same outcome as `archived: true`,
    // because the entity is in fact gone. Symmetry guard in
    // `dropArchivedEntityRelations` then drops the other side too so we
    // don't write a half-canonical row.
    client.pages.retrieve.mockImplementation(async (args: { page_id: string }) => {
      if (args.page_id === "ent-sub-missing") {
        throw Object.assign(new Error("Could not find page"), {
          status: 404,
          code: "object_not_found",
        })
      }
      return factPage({ id: args.page_id })
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "legacy-fact",
          subjectEntityId: null,
          objectEntityId: null,
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await service.createWithDedup({
      subject: "Sub",
      predicate: "uses",
      object: "Obj",
      subjectEntityId: "ent-sub-missing",
      objectEntityId: "ent-obj",
    })

    expect(result.deduped).toBe(true)
    expect(result.enriched).toEqual([])
    expect(result.fact.subjectEntityId).toBeNull()
    expect(result.fact.objectEntityId).toBeNull()
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("propagates transient probe failures (5xx) instead of silently stripping relations", async () => {
    // A 503 on the entity-liveness probe used to be indistinguishable
    // from "entity is archived" — both routed through the bare
    // `catch {}` and returned undefined, dropping both
    // `SubjectEntity` and `ObjectEntity` from a fact whose relations
    // the caller had correctly resolved. That silently violated the
    // five-database integrity contract during a Notion incident or a
    // sustained 429 backoff window. The probe must now propagate the
    // 5xx so the create either retries via the rate-limit middleware
    // or surfaces the failure to the caller.
    client.pages.retrieve.mockImplementation(async (args: { page_id: string }) => {
      if (args.page_id === "ent-sub-transient") {
        throw Object.assign(new Error("Service unavailable"), { status: 503 })
      }
      return factPage({ id: args.page_id })
    })

    await expect(
      service.createWithDedup({
        subject: "Sub",
        predicate: "uses",
        object: "Obj",
        subjectEntityId: "ent-sub-transient",
        objectEntityId: "ent-obj",
      })
    ).rejects.toMatchObject({ status: 503 })

    expect(client.dataSources.query).not.toHaveBeenCalled()
    expect(client.pages.create).not.toHaveBeenCalled()
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("propagates 429 probe failures (rate-limited) instead of silently stripping relations", async () => {
    client.pages.retrieve.mockImplementation(async (args: { page_id: string }) => {
      if (args.page_id === "ent-obj-rate-limited") {
        throw Object.assign(new Error("Rate limited"), {
          status: 429,
          code: "rate_limited",
        })
      }
      return factPage({ id: args.page_id })
    })

    await expect(
      service.createWithDedup({
        subject: "Sub",
        predicate: "uses",
        object: "Obj",
        subjectEntityId: "ent-sub",
        objectEntityId: "ent-obj-rate-limited",
      })
    ).rejects.toMatchObject({ status: 429 })

    expect(client.pages.create).not.toHaveBeenCalled()
  })

  it("propagates auth / permission probe failures (401 / 403) instead of dropping relations", async () => {
    // Auth and permission errors aren't "entity is gone" either — an
    // operator who lost share access mid-flow should see the failure,
    // not get a relation-stripped row that masquerades as "the entity
    // was archived."
    client.pages.retrieve.mockImplementation(async (args: { page_id: string }) => {
      if (args.page_id === "ent-sub-restricted") {
        throw Object.assign(new Error("Restricted"), {
          status: 403,
          code: "restricted_resource",
        })
      }
      return factPage({ id: args.page_id })
    })

    await expect(
      service.createWithDedup({
        subject: "Sub",
        predicate: "uses",
        object: "Obj",
        subjectEntityId: "ent-sub-restricted",
        objectEntityId: "ent-obj",
      })
    ).rejects.toMatchObject({ status: 403 })

    expect(client.pages.create).not.toHaveBeenCalled()
  })

  it("preserves existing entity relations (first-writer-wins, no clobber)", async () => {
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "linked-fact",
          subjectEntityId: "ent-sub-original",
          objectEntityId: "ent-obj-original",
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await service.createWithDedup({
      subject: "Sub",
      predicate: "uses",
      object: "Obj",
      subjectEntityId: "ent-sub-new",
      objectEntityId: "ent-obj-new",
    })

    expect(result.deduped).toBe(true)
    expect(result.enriched).toEqual([])
    expect(result.fact.subjectEntityId).toBe("ent-sub-original")
    expect(result.fact.objectEntityId).toBe("ent-obj-original")
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("fills only the missing entity side and leaves the populated side untouched", async () => {
    // Mid-migration vault: the subject side is populated but the object
    // side has not landed yet. Asymmetric fill.
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "half-linked",
          subjectEntityId: "ent-sub-original",
          objectEntityId: null,
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await service.createWithDedup({
      subject: "Sub",
      predicate: "uses",
      object: "Obj",
      subjectEntityId: "ent-sub-new",
      objectEntityId: "ent-obj",
    })

    expect(result.deduped).toBe(true)
    expect(result.enriched).toEqual(["linked object entity"])
    expect(result.fact.subjectEntityId).toBe("ent-sub-original")
    expect(result.fact.objectEntityId).toBe("ent-obj")
    expect(client.pages.update).toHaveBeenCalledTimes(1)
    const [updateCall] = client.pages.update.mock.calls
    expect(updateCall[0].properties).toEqual({
      ObjectEntity: { relation: [{ id: "ent-obj" }] },
    })
  })

  it("bundles entity backfill with review/project/source merges in one atomic update", async () => {
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "live-fact",
          projectIds: ["proj-x"],
          reviewBy: "2026-04-01",
          sourceMemoryId: null,
          subjectEntityId: null,
          objectEntityId: null,
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
      subjectEntityId: "ent-sub",
      objectEntityId: "ent-obj",
    })

    expect(result.deduped).toBe(true)
    expect(result.enriched).toEqual([
      "extended review to 2026-05-01",
      "added 1 project",
      "linked source memory",
      "linked subject entity",
      "linked object entity",
    ])
    expect(client.pages.update).toHaveBeenCalledTimes(1)
    const [updateCall] = client.pages.update.mock.calls
    expect(updateCall[0].page_id).toBe("live-fact")
    expect(updateCall[0].properties).toEqual({
      "Review By": { date: { start: "2026-05-01" } },
      Project: { relation: [{ id: "proj-x" }, { id: "proj-y" }] },
      Source: { relation: [{ id: "mem-new" }] },
      SubjectEntity: { relation: [{ id: "ent-sub" }] },
      ObjectEntity: { relation: [{ id: "ent-obj" }] },
    })
  })

  it("issues no update when caller omits entity ids on a legacy row", async () => {
    // Legacy `lore-fact action='create'` paths (decision-graph helpers,
    // pre-PF3-01 callers) don't pass entity ids. The dedup hit must
    // remain a no-op when nothing else changed.
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "legacy-fact",
          projectIds: ["proj-x"],
          subjectEntityId: null,
          objectEntityId: null,
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
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("leaves existing in-memory state untouched when the atomic update throws", async () => {
    // Pin the in-memory rollback invariant: if someone later moves any of
    // the `existing.projectIds = ...` / `existing.sourceMemoryId = ...` /
    // `existing.subjectEntityId = ...` / `existing.objectEntityId = ...`
    // mirror assignments back above the `await pages.update`, the retry
    // below would see the corresponding `filling*` flag false and skip
    // its update — which is the failure mode this test catches. With
    // the assignments correctly placed after the await, the retry
    // recomputes every flag and issues a second update with the same
    // payload as the first attempt.
    const livePage = factPage({
      id: "live-fact",
      projectIds: ["proj-x"],
      sourceMemoryId: null,
      subjectEntityId: null,
      objectEntityId: null,
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
        subjectEntityId: "ent-sub",
        objectEntityId: "ent-obj",
      })
    ).rejects.toThrow("Notion 500")

    // The caller never sees a half-enriched success — the throw propagates
    // and `enriched` never enters the caller's view. One update attempt,
    // no partial state.
    expect(client.pages.update).toHaveBeenCalledTimes(1)

    // Retry: second call's probe returns the same livePage. If the first
    // attempt had mutated `existing` before the throw, the matching merge
    // flags would short-circuit on the retry and the second update would
    // be missing the corresponding entries. The correct post-throw
    // behaviour is that the second call sees the pristine pre-write
    // state and produces the full enrichment again.
    client.pages.update.mockResolvedValueOnce({})
    const retryResult = await service.createWithDedup({
      subject: "Sub",
      predicate: "uses",
      object: "Obj",
      projectIds: ["proj-x", "proj-y"],
      sourceMemoryId: "mem-new",
      subjectEntityId: "ent-sub",
      objectEntityId: "ent-obj",
    })
    expect(retryResult.deduped).toBe(true)
    expect(retryResult.enriched).toEqual([
      "added 1 project",
      "linked source memory",
      "linked subject entity",
      "linked object entity",
    ])
    // One update on the retry — a single atomic payload covering every
    // property, identical to the shape the first attempt built.
    expect(client.pages.update).toHaveBeenCalledTimes(2)
  })
})

describe("FactService.createWithDedup — HTML entity decode at write", () => {
  let client: ReturnType<typeof createMockClient>
  let service: FactService

  beforeEach(() => {
    client = createMockClient()
    service = new FactService(client, DB)
  })

  it("decodes doubly-encoded subject and object before writing and dedup-keying", async () => {
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.pages.create.mockResolvedValueOnce(
      factPage({ id: "new-fact", subject: "Foo & Bar", object: "R & D" })
    )

    await service.createWithDedup({
      subject: "Foo &amp;amp; Bar",
      predicate: "uses",
      object: "R &amp; D",
    })

    const createCall = client.pages.create.mock.calls[0][0]
    const subjectProp = createCall.properties.Subject
    const objectProp = createCall.properties.Object
    expect(subjectProp.title[0].text.content).toBe("Foo & Bar")
    expect(objectProp.rich_text[0].text.content).toBe("R & D")

    const queryCall = client.dataSources.query.mock.calls[0][0]
    // Issue #283 round-4 — scope-constrained probe binds every scope
    // column on the server. With no incoming scope, every column
    // gets `is_empty`.
    expect(queryCall.filter).toEqual({
      and: [
        {
          property: "DedupKey",
          rich_text: {
            equals: computeFactDedupKey({
              subject: "Foo & Bar",
              predicate: "uses",
              object: "R & D",
            }),
          },
        },
        { property: "Valid Until", date: { is_empty: true } },
        { property: "Scope Kind", select: { is_empty: true } },
        { property: "Scope Key", rich_text: { is_empty: true } },
        { property: "Audience", rich_text: { is_empty: true } },
        { property: "Lifetime", select: { is_empty: true } },
        { property: "Expires At", date: { is_empty: true } },
      ],
    })
  })

  it("is idempotent — an already-clean input is unchanged", async () => {
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

    const createCall = client.pages.create.mock.calls[0][0]
    expect(createCall.properties.Subject.title[0].text.content).toBe("AuthService")
    expect(createCall.properties.Object.rich_text[0].text.content).toBe("JWT")
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

describe("computeSubjectKey", () => {
  it("collapses cosmetic subject variants to one key (P3-03 Part A)", () => {
    expect(computeSubjectKey("MemoryService")).toBe(computeSubjectKey("memoryservice"))
    expect(computeSubjectKey("MemoryService")).toBe(computeSubjectKey("MemoryService "))
    expect(computeSubjectKey("MemoryService")).toBe(computeSubjectKey(" MemoryService."))
  })

  it("preserves embedded punctuation and dots so file-like subjects survive", () => {
    expect(computeSubjectKey("file.ts")).toBe("file.ts")
    expect(computeSubjectKey("FactService.create")).toBe("factservice.create")
  })

  it("agrees with the dedup-key fold so a SubjectKey/DedupKey divergence is impossible", () => {
    // Pin the two normalize outputs to the same shape — splitting the
    // fold rules between the two columns would silently re-fragment the
    // entity-canonicalization story P3-03 closes.
    expect(computeSubjectKey("AuthService")).toBe(normalize("AuthService"))
  })
})

describe("FactService.createWithDedup — SubjectKey write", () => {
  it("writes SubjectKey alongside DedupKey on a fresh row", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.pages.create.mockResolvedValueOnce(
      factPage({ id: "new", subject: "MemoryService" })
    )
    const service = new FactService(client, DB)

    await service.createWithDedup({
      subject: "MemoryService",
      predicate: "uses",
      object: "Notion",
    })

    const createCall = client.pages.create.mock.calls[0][0]
    expect(createCall.properties.SubjectKey.rich_text[0].text.content).toBe(
      computeSubjectKey("MemoryService")
    )
    // Subject still carries the human-readable form — SubjectKey is the
    // case-folded mirror, not a replacement.
    expect(createCall.properties.Subject.title[0].text.content).toBe("MemoryService")
  })

  it("computes SubjectKey from the decoded subject so encoded inputs canonicalize consistently", async () => {
    // Pre-PF1-06 inputs sometimes arrive doubly-HTML-encoded. The decode
    // happens at the write boundary, so SubjectKey must be derived from
    // the post-decode value — otherwise `lore-ask("Foo & Bar")` would
    // miss the row written from `Foo &amp;amp; Bar`.
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.pages.create.mockResolvedValueOnce(
      factPage({ id: "new", subject: "Foo & Bar" })
    )
    const service = new FactService(client, DB)

    await service.createWithDedup({
      subject: "Foo &amp;amp; Bar",
      predicate: "uses",
      object: "x",
    })

    const createCall = client.pages.create.mock.calls[0][0]
    expect(createCall.properties.SubjectKey.rich_text[0].text.content).toBe(
      computeSubjectKey("Foo & Bar")
    )
  })
})

describe("FactService.queryBySubject — case-insensitive match", () => {
  it("issues an OR(SubjectKey contains, Subject contains) filter when given a non-empty subject", async () => {
    // The two-clause OR is the migration-period contract: SubjectKey
    // catches every row backfilled by `lore migrate --dedup-keys` (P3-03
    // Part A's primary path), while the Subject fallback keeps
    // pre-migration rows reachable until the backfill lands. Both
    // clauses must use `contains` so partial-match semantics carry over
    // from the pre-P3-03 query.
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.queryBySubject("MemoryService", { projectId: "p1" })

    const filter = calls[0].filter as { and: Array<Record<string, unknown>> }
    expect(filter).toHaveProperty("and")
    const orGroup = filter.and.find((c) => {
      const maybeOr = (c as { or?: Array<Record<string, unknown>> }).or
      if (!Array.isArray(maybeOr)) return false
      const props = maybeOr.map((clause) => (clause as { property?: string }).property)
      return props.includes("SubjectKey") && props.includes("Subject")
    }) as { or: Array<Record<string, unknown>> } | undefined
    expect(orGroup).toBeDefined()

    const subjectKeyClause = orGroup!.or.find(
      (c) => (c as { property?: string }).property === "SubjectKey"
    ) as { property: string; rich_text: { contains: string } }
    expect(subjectKeyClause.rich_text.contains).toBe(computeSubjectKey("MemoryService"))

    const subjectClause = orGroup!.or.find(
      (c) => (c as { property?: string }).property === "Subject"
    ) as { property: string; title: { contains: string } }
    expect(subjectClause.title.contains).toBe("MemoryService")
  })

  it("normalizes case-variant queries to the same SubjectKey filter value", async () => {
    // The bug P3-03 closes: `lore-ask("MemoryService")` and
    // `lore-ask("memoryservice")` must reach the same fact set. The
    // service-side filter normalizes the input, so both calls hit the
    // same SubjectKey contains value.
    const { client: c1, calls: cs1 } = createClient([{ results: [] }])
    const { client: c2, calls: cs2 } = createClient([{ results: [] }])

    await new FactService(c1, db).queryBySubject("MemoryService", {
      projectId: "p1",
    })
    await new FactService(c2, db).queryBySubject("memoryservice ", {
      projectId: "p1",
    })

    const findKey = (calls: Array<Record<string, unknown>>): string => {
      const filter = calls[0].filter as { and: Array<Record<string, unknown>> }
      const orGroup = filter.and.find((c) => {
        const maybeOr = (c as { or?: Array<Record<string, unknown>> }).or
        return Array.isArray(maybeOr)
      }) as { or: Array<Record<string, unknown>> }
      const sk = orGroup.or.find(
        (c) => (c as { property?: string }).property === "SubjectKey"
      ) as { rich_text: { contains: string } }
      return sk.rich_text.contains
    }

    expect(findKey(cs1)).toBe(findKey(cs2))
  })

  it("omits the OR clause entirely when subject is empty (list-all-in-scope, allowUnfiltered)", async () => {
    // Empty subject under `allowUnfiltered: true` means "list every fact
    // in scope" — adding a `SubjectKey contains ""` clause would
    // constrain the result to rows with non-empty SubjectKey, silently
    // hiding pre-migration rows. Without `allowUnfiltered` the call
    // short-circuits to `[]` (see the empty-input guard test below).
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.queryBySubject("", { projectId: "p1", allowUnfiltered: true })

    const filter = calls[0].filter as Record<string, unknown>
    const clauses: Array<Record<string, unknown>> = Array.isArray(filter.and)
      ? (filter.and as Array<Record<string, unknown>>)
      : [filter]
    const hasSubjectClause = clauses.some((c) => {
      const maybeOr = (c as { or?: Array<Record<string, unknown>> }).or
      if (!Array.isArray(maybeOr)) return false
      return maybeOr.some(
        (clause) =>
          (clause as { property?: string }).property === "SubjectKey" ||
          (clause as { property?: string }).property === "Subject"
      )
    })
    expect(hasSubjectClause).toBe(false)
  })

  it("falls back to raw Subject when input normalizes to empty (punctuation/whitespace only)", async () => {
    // Pin the broadening fix: a punctuation-only entity (`"."`, `"!!!"`)
    // or a whitespace-only string normalizes to `""`. Notion's
    // `rich_text contains ""` matches every populated SubjectKey row, so
    // a naive `OR(SubjectKey contains norm, Subject contains raw)` would
    // silently turn `lore-ask({entity: "."})` into "every fact in
    // scope". Suppressing the SubjectKey clause when the normalized form
    // is empty preserves pre-P3-03 substring semantics — the agent gets
    // the rows whose Subject literally contains the input, not the whole
    // vault.
    for (const subject of [".", "   ", "!!!"]) {
      const { client, calls } = createClient([{ results: [] }])
      await new FactService(client, db).queryBySubject(subject, {
        projectId: "p1",
      })

      // Normalize input matches the assertion fixture so the test fails
      // loudly if `computeSubjectKey` ever stops stripping these chars.
      expect(computeSubjectKey(subject)).toBe("")

      const filter = calls[0].filter as { and: Array<Record<string, unknown>> }
      const clauses = Array.isArray(filter.and) ? filter.and : [filter]

      // No OR group with SubjectKey — that's the broadening trap.
      const hasSubjectKeyClause = clauses.some((c) => {
        const maybeOr = (c as { or?: Array<Record<string, unknown>> }).or
        if (!Array.isArray(maybeOr)) return false
        return maybeOr.some(
          (clause) => (clause as { property?: string }).property === "SubjectKey"
        )
      })
      expect(hasSubjectKeyClause).toBe(false)

      // Raw Subject filter still applied — caller still gets literal-
      // substring semantics.
      const subjectClause = clauses.find(
        (c) => (c as { property?: string }).property === "Subject"
      ) as { property: string; title: { contains: string } } | undefined
      expect(subjectClause).toBeDefined()
      expect(subjectClause!.title.contains).toBe(subject)
    }
  })
})

describe("FactService — empty-input vault-scan guards (issue #481)", () => {
  // Pre-fix, an empty / whitespace argument to `queryBySubject`,
  // `queryByObject`, or `queryByEntity` skipped the corresponding
  // text filter (or emitted `contains: ""` which Notion treats as
  // matches-all) and silently paginated every live fact in scope.
  // These tests pin the short-circuit to `[]` so an MCP caller that
  // lets a blank string through, or an `expandEntityQueryVariants`
  // reduction that yields empty, can't trigger an unscoped scan.

  it("queryBySubject('') returns [] without issuing a Notion query (strict-empty gated)", async () => {
    const { client, calls } = createClient([])
    const service = new FactService(client, db)

    const results = await service.queryBySubject("", { projectId: "p1" })

    expect(results).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it("queryBySubject('', { allowUnfiltered: true }) opts back into the list-all-in-scope branch", async () => {
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.queryBySubject("", { projectId: "p1", allowUnfiltered: true })

    expect(calls).toHaveLength(1)
  })

  it("queryByObject('') returns [] without issuing a Notion query (strict-empty gated)", async () => {
    const { client, calls } = createClient([])
    const service = new FactService(client, db)

    const results = await service.queryByObject("", { projectId: "p1" })

    expect(results).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it("queryByObject('', { allowUnfiltered: true }) opts back into list-all-in-scope", async () => {
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.queryByObject("", { projectId: "p1", allowUnfiltered: true })

    expect(calls).toHaveLength(1)
  })

  it("queryByEntity('') returns [] without firing relation or substring branches", async () => {
    const { client, calls } = createClient([])
    const service = new FactService(client, db)

    const results = await service.queryByEntity("", {
      projectId: "p1",
      entityId: "ent-1",
    })

    expect(results).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it("queryByEntity('   ') returns [] without firing relation or substring branches (whitespace-only)", async () => {
    const { client, calls } = createClient([])
    const service = new FactService(client, db)

    const results = await service.queryByEntity("   ", { projectId: "p1" })

    expect(results).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe("FactService.pageToFact — historical tracking-predicate filter", () => {
  // Helper: fact page with raw `Predicate` select set to one of the
  // historical tracking values. Bypasses the typed `FactPredicate`
  // constraint that `factPage`'s helper API enforces.
  const trackingPageWith = (id: string, raw: string) => {
    const row = factPage({ id })
    ;(
      row.properties.Predicate as unknown as {
        select: { name: string }
      }
    ).select.name = raw
    return row
  }

  it("filters rows whose raw Predicate value is needs_action / waiting_on / blocked_by", async () => {
    // Tracking predicates were removed from `FactPredicate` in 0.6.0
    // (`lore-task` is the canonical surface for tracked work). Notion
    // rows still carry those select values on legacy vaults — the
    // schema is additive-only — so the deserialization boundary
    // filters them so no live read path surfaces them as a `Fact`.
    const trackingRow = trackingPageWith("tracking-fact", "needs_action")
    const knowledgeRow = factPage({ id: "knowledge-fact", predicate: "uses" })

    const { client } = createClient([
      { results: [trackingRow, knowledgeRow], has_more: false },
    ])
    const service = new FactService(client, db)

    const results = await service.queryBySubject("", {
      projectId: "p1",
      allowUnfiltered: true,
    })

    expect(results.map((f) => f.id)).toEqual(["knowledge-fact"])
  })

  it("filters tracking rows from listRecent (wake-up Active Facts)", async () => {
    // wake-up's Active Facts section reads through `listRecent`. A
    // historical tracking row in the response window must not surface
    // as live data — even though the typed-union argument would never
    // produce one, a vault that skipped the migration still has
    // them in Notion.
    const trackingRow = trackingPageWith("tracking-fact", "waiting_on")
    const knowledgeRow = factPage({ id: "knowledge-fact", predicate: "uses" })

    const { client } = createClient([
      { results: [trackingRow, knowledgeRow], has_more: false },
    ])
    const service = new FactService(client, db)

    const { items } = await service.listRecent({ projectId: "p1", limit: 10 })

    expect(items.map((f) => f.id)).toEqual(["knowledge-fact"])
  })

  it("filters tracking rows from queryByEntity (lore-query action='ask')", async () => {
    // `handleAsk` (`lore-query action='ask'`) routes through
    // `queryByEntity`, which fans out to `queryBySubject` +
    // `queryByObject` on the pre-PF3-01 fallback path. A tracking-
    // predicate row pointing at the queried entity must not appear in
    // the Governance / Structure / Tasks output.
    const trackingRow = trackingPageWith("tracking-fact", "blocked_by")
    const knowledgeRow = factPage({ id: "knowledge-fact", predicate: "uses" })

    const { client } = createClient([
      // queryBySubject branch: tracking + knowledge.
      { results: [trackingRow, knowledgeRow], has_more: false },
      // queryByObject branch: empty.
      { results: [], has_more: false },
    ])
    const service = new FactService(client, db)

    const results = await service.queryByEntity("AuthService", { projectId: "p1" })

    expect(results.map((f) => f.id)).toEqual(["knowledge-fact"])
  })
})

describe("FactService.pageToFacts — batched relation hydration (issue #498)", () => {
  // Pins the issue's structural acceptance criterion: result-set
  // callers must funnel through `hydrateRelationPropertiesForPages`
  // exactly once instead of issuing N parallel `hydrateRelationProperties`
  // calls inside a `Promise.all`. The wire-level call count to Notion
  // is identical either way (the per-row helper short-circuits when
  // `has_more: false`), so the assertion has to fire on the helper
  // boundary, not on `pages.properties.retrieve`.
  it("queryBySubject routes its result set through the batched helper", async () => {
    const batchedSpy = vi.spyOn(relationProperties, "hydrateRelationPropertiesForPages")

    const pages = Array.from({ length: 5 }, (_, i) =>
      factPage({ id: `fact-${i}`, predicate: "uses" })
    )
    const { client } = createClient([{ results: pages, has_more: false }])
    const service = new FactService(client, db)

    const facts = await service.queryBySubject("Sub", { projectId: "p1" })

    expect(facts.map((f) => f.id)).toEqual([
      "fact-0",
      "fact-1",
      "fact-2",
      "fact-3",
      "fact-4",
    ])
    expect(batchedSpy).toHaveBeenCalledTimes(1)
    const [, callPages, callPropertyNames] = batchedSpy.mock.calls[0]
    expect(callPages).toHaveLength(5)
    expect(callPropertyNames).toEqual(["Project", "SubjectEntity", "ObjectEntity"])

    batchedSpy.mockRestore()
  })

  it("listRecent routes its single-page result through the batched helper", async () => {
    // Covers the second result-set shape the refactor consolidates —
    // `listRecent` returns `{ items, hasMore }` and previously inlined
    // the same `Promise.all(pages.map(p => this.pageToFact(p)))`.
    const batchedSpy = vi.spyOn(relationProperties, "hydrateRelationPropertiesForPages")

    const pages = Array.from({ length: 3 }, (_, i) =>
      factPage({ id: `recent-${i}`, predicate: "uses" })
    )
    const { client } = createClient([{ results: pages, has_more: false }])
    const service = new FactService(client, db)

    const { items } = await service.listRecent({ projectId: "p1", limit: 10 })

    expect(items.map((f) => f.id)).toEqual(["recent-0", "recent-1", "recent-2"])
    expect(batchedSpy).toHaveBeenCalledTimes(1)
    expect(batchedSpy.mock.calls[0][1]).toHaveLength(3)

    batchedSpy.mockRestore()
  })

  it("filters historical tracking-predicate rows on the batched path", async () => {
    // Equivalence-preservation check: the `null`-drop that
    // `pageToFactSync` performs must still happen when the result set
    // is hydrated through the batched helper. Pre-refactor this was a
    // `.filter(isFact)` after `Promise.all`; post-refactor it lives
    // inside `pageToFacts`.
    const trackingPage = factPage({ id: "tracking", predicate: "uses" })
    ;(
      trackingPage.properties.Predicate as unknown as {
        select: { name: string }
      }
    ).select.name = "needs_action"
    const knowledgePage = factPage({ id: "knowledge", predicate: "uses" })

    const { client } = createClient([
      { results: [trackingPage, knowledgePage], has_more: false },
    ])
    const service = new FactService(client, db)

    const facts = await service.queryBySubject("Sub", { projectId: "p1" })

    expect(facts.map((f) => f.id)).toEqual(["knowledge"])
  })
})

describe("clampNotionPageSize", () => {
  // Direct unit tests for the shared helper (issue 0.6.0/15). The
  // call-shape tests below still pin every retrieval method's wire
  // behavior, but those go through `dataSources.query` mocks; this
  // block pins the input/output mapping deterministically so a future
  // edit to the floor (`>= 1`) or ceiling (`<= 100`) can't slip
  // through under a single-method test.
  it("returns NOTION_MAX_PAGE_SIZE when limit is undefined", () => {
    expect(clampNotionPageSize(undefined)).toBe(100)
  })

  it("clamps limit: 0 up to 1 (Notion 400s on page_size: 0)", () => {
    expect(clampNotionPageSize(0)).toBe(1)
  })

  it("passes limit: 1 through unchanged", () => {
    expect(clampNotionPageSize(1)).toBe(1)
  })

  it("passes mid-range limits through unchanged", () => {
    expect(clampNotionPageSize(25)).toBe(25)
  })

  it("passes the boundary limit: 100 through unchanged", () => {
    expect(clampNotionPageSize(100)).toBe(100)
  })

  it("clamps oversized limits down to NOTION_MAX_PAGE_SIZE", () => {
    expect(clampNotionPageSize(150)).toBe(100)
  })
})

describe("FactService — page_size clamping on retrieval queries", () => {
  // Hot-path callers like `resolveCurrentDecisions` (limit: 25 forwarded
  // into `queryByObject`) ask for a handful of rows but used to issue
  // `page_size: 100` regardless. Clamping `page_size` to the requested
  // limit cuts transfer budget and rate-limiter dwell on those paths
  // without changing pagination semantics — the outer cursor loop still
  // walks more pages when `limit` exceeds 100.
  it("queryBySubject({ limit: 4 }) sends page_size: 4", async () => {
    const { client, calls } = createClient([{ results: [] }])
    await new FactService(client, db).queryBySubject("MemoryService", {
      projectId: "p1",
      limit: 4,
    })

    expect(calls[0].page_size).toBe(4)
  })

  it("queryByObject({ limit: 25 }) sends page_size: 25", async () => {
    const { client, calls } = createClient([{ results: [] }])
    await new FactService(client, db).queryByObject("decision-x", {
      projectId: "p1",
      limit: 25,
    })

    expect(calls[0].page_size).toBe(25)
  })

  it("queryBySourceMemory({ limit: 1 }) sends page_size: 1", async () => {
    const { client, calls } = createClient([{ results: [] }])
    await new FactService(client, db).queryBySourceMemory("mem-1", {
      projectId: "p1",
      limit: 1,
    })

    expect(calls[0].page_size).toBe(1)
  })

  it("falls back to page_size: 100 when limit is undefined", async () => {
    // Three back-to-back assertions — one per query method — pin the
    // unlimited-path contract: callers that genuinely need to walk the
    // result set still get Notion's max page size, so the caller-side
    // pagination loop runs the same number of round-trips as before.
    const subjectCall = createClient([{ results: [] }])
    await new FactService(subjectCall.client, db).queryBySubject("MemoryService", {
      projectId: "p1",
    })
    expect(subjectCall.calls[0].page_size).toBe(100)

    const objectCall = createClient([{ results: [] }])
    await new FactService(objectCall.client, db).queryByObject("decision-x", {
      projectId: "p1",
    })
    expect(objectCall.calls[0].page_size).toBe(100)

    const sourceCall = createClient([{ results: [] }])
    await new FactService(sourceCall.client, db).queryBySourceMemory("mem-1", {
      projectId: "p1",
    })
    expect(sourceCall.calls[0].page_size).toBe(100)
  })

  it("clamps oversized limits to Notion's 100-row ceiling", async () => {
    // A caller that asks for `limit: 250` still must not send
    // `page_size: 250` — Notion rejects values above 100 with a 400.
    // Pagination satisfies the over-100 request via the cursor loop,
    // not by inflating page_size.
    const { client, calls } = createClient([{ results: [] }])
    await new FactService(client, db).queryBySubject("MemoryService", {
      projectId: "p1",
      limit: 250,
    })

    expect(calls[0].page_size).toBe(100)
  })
})

describe("FactService.queryOverdue", () => {
  it("paginates beyond the first 100 rows when no limit is supplied", async () => {
    // Pre-fix behavior: a single dataSources.query with no page_size
    // and no cursor loop silently truncated at Notion's default 100-row
    // page. A vault with 271 overdue facts (mirroring the production
    // internal vault's open-loops scale) lost ~63% of the result set.
    const page1 = Array.from({ length: 100 }, (_, i) => buildFactPage({ id: `f1-${i}` }))
    const page2 = Array.from({ length: 100 }, (_, i) => buildFactPage({ id: `f2-${i}` }))
    const page3 = Array.from({ length: 71 }, (_, i) => buildFactPage({ id: `f3-${i}` }))
    const { client, querySpy } = createClient([
      { results: page1, has_more: true, next_cursor: "c1" },
      { results: page2, has_more: true, next_cursor: "c2" },
      { results: page3, has_more: false, next_cursor: null },
    ])
    const service = new FactService(client, db)

    const items = await service.queryOverdue({ projectId: "p1" })

    expect(querySpy).toHaveBeenCalledTimes(3)
    expect(items).toHaveLength(271)
    // Cursor must thread across pages — without this the second call
    // would re-fetch page 1 forever.
    expect(querySpy.mock.calls[1][0]).toMatchObject({ start_cursor: "c1" })
    expect(querySpy.mock.calls[2][0]).toMatchObject({ start_cursor: "c2" })
  })

  it("stops paginating once the limit is reached", async () => {
    // Limit-reached-mid-page: Notion's first response had 100 rows, the
    // caller asked for 10. A second query MUST NOT fire — over-fetching
    // beyond `limit` defeats the page_size clamp.
    const page1 = Array.from({ length: 100 }, (_, i) => buildFactPage({ id: `f-${i}` }))
    const { client, querySpy } = createClient([
      { results: page1, has_more: true, next_cursor: "c1" },
    ])
    const service = new FactService(client, db)

    const items = await service.queryOverdue({ projectId: "p1", limit: 10 })

    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(items).toHaveLength(10)
  })

  it("clamps page_size to min(limit, 100) when limit is small", async () => {
    // The fact-side companion of issue 01: a caller asking for the 5
    // most-overdue facts shouldn't pull 100 rows over the wire. Without
    // the clamp, page_size defaults to 100 and we waste 95 rows per call.
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.queryOverdue({ projectId: "p1", limit: 5 })

    expect(calls[0].page_size).toBe(5)
  })

  it("clamps page_size to Notion's 100-row ceiling when no limit is supplied", async () => {
    // Boundary on the other side: `limit ?? 100` resolves to 100 when
    // unset, so page_size is exactly 100 — Notion's hard maximum.
    // Going higher would 400 from Notion.
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.queryOverdue({ projectId: "p1" })

    expect(calls[0].page_size).toBe(100)
  })

  it("clamps page_size to 100 when limit exceeds Notion's ceiling", async () => {
    // A caller passing limit=500 must not produce page_size=500 — Notion
    // rejects > 100 with a 400. The clamp is `Math.min(limit ?? 100, 100)`.
    const page1 = Array.from({ length: 100 }, (_, i) => buildFactPage({ id: `f-${i}` }))
    const { client, calls } = createClient([
      { results: page1, has_more: false, next_cursor: null },
    ])
    const service = new FactService(client, db)

    await service.queryOverdue({ projectId: "p1", limit: 500 })

    expect(calls[0].page_size).toBe(100)
  })

  it("preserves Review By ascending sort across page boundaries", async () => {
    // The sort is server-side and the page_size clamp doesn't change
    // ordering — pin the sort filter so a future refactor can't
    // accidentally drop it. `Review By asc` is what makes the truncation
    // bug (pre-fix) drop the *least* overdue tail, not the head.
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.queryOverdue({ projectId: "p1" })

    expect(calls[0].sorts).toEqual([{ property: "Review By", direction: "ascending" }])
  })

  it("filters by Review By on_or_before today and Valid Until is_empty", async () => {
    // The active-overdue intent: rows past their review date AND not
    // already invalidated. Skipping `Valid Until is_empty` would surface
    // historical rows the operator already corrected.
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.queryOverdue({ projectId: "p1" })

    const today = new Date().toISOString().split("T")[0]
    const filter = calls[0].filter as { and: Array<Record<string, unknown>> }
    expect(filter.and).toContainEqual({
      property: "Review By",
      date: { on_or_before: today },
    })
    expect(filter.and).toContainEqual({
      property: "Valid Until",
      date: { is_empty: true },
    })
  })
})

describe("FactService.queryByEntity — limit clamp and post-dedup slice (issue 0.6.0/10)", () => {
  // Issue 01 clamped `page_size` on the other three retrieval methods
  // (queryBySubject, queryByObject, queryBySourceMemory). queryByEntity
  // is the fourth in that family and previously had no `limit` knob, so
  // every `lore-ask` against an entity walked both internal branches to
  // exhaustion at page_size: 100 even when the surfacing layer rendered
  // only the top N. These tests pin: (1) the per-branch page_size clamp,
  // (2) the post-dedup slice, and (3) that dedup priority is unchanged.
  it("forwards limit to both branches on the entityId path as page_size: limit", async () => {
    // Two queries fire in parallel (queryByEntityId + queryByEntity-
    // TextOnUnmigrated). Both must clamp page_size to the requested limit
    // — otherwise the parallel branch silently restores the full-walk
    // wall-clock cost issue 01 fixed for the sequential family.
    const { client, calls } = createClient([{ results: [] }, { results: [] }])
    const service = new FactService(client, db)

    await service.queryByEntity("AuthService", {
      projectId: "p1",
      entityId: "ent-auth",
      limit: 25,
    })

    expect(calls.length).toBe(2)
    expect(calls[0].page_size).toBe(25)
    expect(calls[1].page_size).toBe(25)
  })

  it("forwards limit to queryBySubject and queryByObject on the no-entityId path as page_size: limit", async () => {
    // The no-entityId branch is the pre-PF3-01 / ambiguous-resolution
    // path; queryBySubject + queryByObject already accept `limit`
    // (issue 01), so this just verifies the wiring threads through.
    const { client, calls } = createClient([{ results: [] }, { results: [] }])
    const service = new FactService(client, db)

    await service.queryByEntity("AuthService", { projectId: "p1", limit: 25 })

    expect(calls.length).toBe(2)
    expect(calls[0].page_size).toBe(25)
    expect(calls[1].page_size).toBe(25)
  })

  it("falls back to page_size: 100 when limit is undefined on the entityId path", async () => {
    // Wake-up paths and migration scans that need the full slice cannot
    // be silently truncated. Unlimited callers still get Notion's max
    // page size on every branch, so the cursor loop runs the same
    // number of round-trips as before.
    const { client, calls } = createClient([{ results: [] }, { results: [] }])
    const service = new FactService(client, db)

    await service.queryByEntity("AuthService", {
      projectId: "p1",
      entityId: "ent-auth",
    })

    expect(calls.length).toBe(2)
    expect(calls[0].page_size).toBe(100)
    expect(calls[1].page_size).toBe(100)
  })

  it("falls back to page_size: 100 when limit is undefined on the no-entityId path", async () => {
    const { client, calls } = createClient([{ results: [] }, { results: [] }])
    const service = new FactService(client, db)

    await service.queryByEntity("AuthService", { projectId: "p1" })

    expect(calls.length).toBe(2)
    expect(calls[0].page_size).toBe(100)
    expect(calls[1].page_size).toBe(100)
  })

  it("clamps oversized limits to Notion's 100-row ceiling on every branch", async () => {
    // A caller passing limit: 250 must not produce page_size: 250 — the
    // outer cursor loop satisfies the over-100 request, not an inflated
    // page_size that Notion rejects with a 400.
    const { client, calls } = createClient([{ results: [] }, { results: [] }])
    const service = new FactService(client, db)

    await service.queryByEntity("AuthService", {
      projectId: "p1",
      entityId: "ent-auth",
      limit: 250,
    })

    expect(calls[0].page_size).toBe(100)
    expect(calls[1].page_size).toBe(100)
  })

  it("slices the unioned result to limit after dedup on the entityId path", async () => {
    // Both branches return up to `limit` distinct rows on their own; the
    // union before slicing can be 2 × limit. The post-dedup slice caps
    // the user-visible result so a caller asking for limit: 2 never
    // sees more than 2 rows.
    const relationRow = factPage({ id: "rel-1", subject: "AuthService" })
    const textRow = factPage({ id: "text-1", subject: "AuthService" })
    const { client } = createClient([
      { results: [relationRow] }, // queryByEntityId
      { results: [textRow] }, // queryByEntityTextOnUnmigrated
    ])
    const service = new FactService(client, db)

    const result = await service.queryByEntity("AuthService", {
      projectId: "p1",
      entityId: "ent-auth",
      limit: 1,
    })

    expect(result).toHaveLength(1)
    // Relation-hit wins ordering — must be the relation row, not the
    // text-fallback row.
    expect(result[0].id).toBe("rel-1")
  })

  it("unions migrated relation rows and unmigrated text rows on a mixed-migration fixture (issue #486)", async () => {
    // Pins the queryByEntityId / queryByEntityTextOnUnmigrated union
    // semantics that AGENTS.md spells out: "code that reads entity ids
    // from facts must handle both rows with populated entity relations
    // and rows that need the SubjectKey substring fallback." The contract
    // is enforced by `queryByEntity` fanning out to both branches; this
    // test guards against a future caller short-circuiting the relation
    // branch and dropping every un-backfilled row.
    //
    // Fixture distinguishes the two row states structurally: the relation
    // row carries a populated `subjectEntityId` (post `--build-entities`),
    // the text-fallback row leaves both entity relations empty (pre-
    // migration / transition window). The both-present overlap case (a
    // row that surfaces in both branches with distinguishable payloads)
    // is pinned by the next test in this block.
    const migratedRow = factPage({
      id: "migrated-1",
      subject: "AuthService",
      subjectEntityId: "ent-auth",
    })
    const unmigratedRow = factPage({
      id: "unmigrated-1",
      subject: "AuthService",
      subjectEntityId: null,
      objectEntityId: null,
    })
    const { client } = createClient([
      { results: [migratedRow] }, // relation branch
      { results: [unmigratedRow] }, // text-on-unmigrated branch
    ])
    const service = new FactService(client, db)

    const result = await service.queryByEntity("AuthService", {
      projectId: "p1",
      entityId: "ent-auth",
    })

    expect(result.map((f) => f.id)).toEqual(["migrated-1", "unmigrated-1"])
    expect(result[0].subjectEntityId).toBe("ent-auth")
    expect(result[1].subjectEntityId).toBeNull()
  })

  it("preserves dedup priority (relation-hit wins over text-fallback) when both branches contribute the same row", async () => {
    // Overlapping rows: the same fact id appears in both branches with
    // distinguishable payloads (different `reviewBy` dates per branch).
    // The relation-hit payload must survive; the text-fallback
    // duplicate is dropped. Pinning the payload — not just the id —
    // makes a future flip of `seen = new Set(byTextOnUnmigrated.map(...))`
    // observably wrong.
    const sharedFromRelation = factPage({
      id: "shared-1",
      subject: "AuthService",
      reviewBy: "2026-05-01",
    })
    const sharedFromText = factPage({
      id: "shared-1",
      subject: "AuthService",
      reviewBy: "2026-06-15",
    })
    const textOnly = factPage({ id: "text-only-1", subject: "AuthService" })
    const { client } = createClient([
      { results: [sharedFromRelation] },
      { results: [sharedFromText, textOnly] },
    ])
    const service = new FactService(client, db)

    const result = await service.queryByEntity("AuthService", {
      projectId: "p1",
      entityId: "ent-auth",
      limit: 25,
    })

    expect(result).toHaveLength(2)
    expect(result.map((f) => f.id)).toEqual(["shared-1", "text-only-1"])
    // The surviving shared row must carry the relation-branch payload —
    // a flipped dedup priority would surface "2026-06-15" here.
    expect(result[0].reviewBy).toBe("2026-05-01")
  })

  it("preserves subject-hit wins over object-hit dedup priority on the no-entityId path", async () => {
    // Same id, distinguishable payloads per branch. The subject-side
    // hit must survive; the object-side duplicate is dropped. Without
    // the payload assertion, swapping `seen = new Set(asObject.map(...))`
    // would be a silent regression.
    const sharedFromSubject = factPage({
      id: "shared-1",
      subject: "AuthService",
      reviewBy: "2026-05-01",
    })
    const sharedFromObject = factPage({
      id: "shared-1",
      subject: "AuthService",
      reviewBy: "2026-06-15",
    })
    const objectOnly = factPage({ id: "obj-only-1", subject: "Other" })
    const { client } = createClient([
      { results: [sharedFromSubject] }, // queryBySubject
      { results: [sharedFromObject, objectOnly] }, // queryByObject
    ])
    const service = new FactService(client, db)

    const result = await service.queryByEntity("AuthService", {
      projectId: "p1",
      limit: 25,
    })

    expect(result.map((f) => f.id)).toEqual(["shared-1", "obj-only-1"])
    expect(result[0].reviewBy).toBe("2026-05-01")
  })

  it("slices a `2 × limit` distinct-row union down to `limit` on the entityId path", async () => {
    // Coverage for the spec's flagship invariant at scale: each branch
    // returns 25 distinct rows (no overlap), so the pre-slice union is
    // 50. The post-dedup slice must cap the result at exactly 25 — not
    // 50, not 26. Distinct from the `limit: 1` test above, which
    // exercises the same mechanism at the smallest possible scale.
    const relationRows = Array.from({ length: 25 }, (_, i) =>
      factPage({ id: `rel-${i}`, subject: "AuthService" })
    )
    const textRows = Array.from({ length: 25 }, (_, i) =>
      factPage({ id: `text-${i}`, subject: "AuthService" })
    )
    const { client } = createClient([{ results: relationRows }, { results: textRows }])
    const service = new FactService(client, db)

    const result = await service.queryByEntity("AuthService", {
      projectId: "p1",
      entityId: "ent-auth",
      limit: 25,
    })

    expect(result).toHaveLength(25)
    // Relation-branch rows fill the window first; the text branch
    // contributes nothing because the slice runs after dedup but the
    // window was already full of relation rows.
    expect(result.every((f) => f.id.startsWith("rel-"))).toBe(true)
  })
})

describe("FactService.queryByEntity — predicates option (issue 0.6.0/05)", () => {
  function findPredicateClause(
    filter: { and: Array<Record<string, unknown>> } | Record<string, unknown>
  ): Record<string, unknown> | undefined {
    const clauses = Array.isArray(
      (filter as { and?: Array<Record<string, unknown>> }).and
    )
      ? (filter as { and: Array<Record<string, unknown>> }).and
      : [filter as Record<string, unknown>]
    return clauses.find((c) => {
      const property = (c as { property?: string }).property
      if (property === "Predicate") return true
      const maybeOr = (c as { or?: Array<Record<string, unknown>> }).or
      if (!Array.isArray(maybeOr)) return false
      return maybeOr.every(
        (clause) => (clause as { property?: string }).property === "Predicate"
      )
    })
  }

  it("applies a single-predicate equals clause server-side on the relation branch (entityId resolved)", async () => {
    // The relation branch dispatches both queryByEntityId and the
    // unbackfilled-text companion in parallel. Both must carry the
    // predicate clause server-side so a downstream `lore-decision-context`
    // doesn't over-fetch unrelated facts touching the same entity.
    const { client, calls } = createClient([{ results: [] }, { results: [] }])
    const service = new FactService(client, db)

    await service.queryByEntity("AuthService", {
      projectId: "p1",
      entityId: "ent-auth",
      predicates: ["decided_by"],
    })

    // Two queries fired in parallel: relation match + un-backfilled text
    // companion. Both should carry the predicate filter.
    expect(calls.length).toBe(2)
    for (const call of calls) {
      const filter = call.filter as
        | { and: Array<Record<string, unknown>> }
        | Record<string, unknown>
      const predClause = findPredicateClause(filter)
      expect(predClause).toBeDefined()
      // Single-predicate input collapses to `select.equals`.
      expect(predClause).toMatchObject({
        property: "Predicate",
        select: { equals: "decided_by" },
      })
    }
  })

  it("falls back to queryBySubject ∪ queryByObject with the predicate filter when entityId is not resolved", async () => {
    // Pre-PF3-01 path / ambiguous resolution — queryByEntity falls
    // through to the subject + object union. Each side must apply the
    // predicate filter on its own query so the union is server-side
    // narrowed.
    const { client, calls } = createClient([{ results: [] }, { results: [] }])
    const service = new FactService(client, db)

    await service.queryByEntity("AuthService", {
      projectId: "p1",
      predicates: ["decided_by"],
    })

    // Two sequential queries: queryBySubject then queryByObject.
    expect(calls.length).toBe(2)
    for (const call of calls) {
      const filter = call.filter as { and: Array<Record<string, unknown>> }
      const predClause = findPredicateClause(filter)
      expect(predClause).toMatchObject({
        property: "Predicate",
        select: { equals: "decided_by" },
      })
    }
  })

  it("emits an OR-of-equals across multiple predicates", async () => {
    const { client, calls } = createClient([{ results: [] }, { results: [] }])
    const service = new FactService(client, db)

    await service.queryByEntity("AuthService", {
      projectId: "p1",
      entityId: "ent-auth",
      predicates: ["decided_by", "supersedes_decision"],
    })

    for (const call of calls) {
      const filter = call.filter as { and: Array<Record<string, unknown>> }
      const predClause = findPredicateClause(filter) as
        | { or: Array<{ property: string; select: { equals: string } }> }
        | undefined
      expect(predClause).toBeDefined()
      const values = predClause!.or.map((c) => c.select.equals).sort()
      expect(values).toEqual(["decided_by", "supersedes_decision"])
    }
  })

  it("does not emit a Predicate clause when predicates is omitted (no behavior change for legacy callers)", async () => {
    const { client, calls } = createClient([{ results: [] }, { results: [] }])
    const service = new FactService(client, db)

    await service.queryByEntity("AuthService", {
      projectId: "p1",
      entityId: "ent-auth",
    })

    for (const call of calls) {
      const filter = call.filter as
        | { and: Array<Record<string, unknown>> }
        | Record<string, unknown>
      const predClause = findPredicateClause(filter)
      expect(predClause).toBeUndefined()
    }
  })
})

describe("FactService.countByPredicateRaw (issue 0.6.0/24)", () => {
  // Pre-issue: `lore status` had no signal that a vault still carried
  // the legacy tracking-predicate facts (`needs_action`, `waiting_on`,
  // `blocked_by`) that #23 will hide from the read path. The preflight
  // probe must keep counting those rows accurately AFTER #23 ships, so
  // its design intentionally bypasses the typed `FactPredicate` union
  // (raw `string[]` input) AND `pageToFact` (returns `Promise<number>`
  // and never instantiates `Fact` objects).
  it("returns 0 without issuing a query when given an empty array", async () => {
    // Empty input is an early-return path so we never burn a Notion call
    // on a tautologically-empty filter (Notion's API would happily
    // return every row in the DS for `Predicate is one of: []` semantics).
    const { client, querySpy } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    const count = await service.countByPredicateRaw([])

    expect(count).toBe(0)
    expect(querySpy).not.toHaveBeenCalled()
  })

  it("returns the integer count from a single-page response", async () => {
    const { client } = createClient([
      {
        results: [
          buildFactPage({ id: "f1" }),
          buildFactPage({ id: "f2" }),
          buildFactPage({ id: "f3" }),
        ],
        has_more: false,
      },
    ])
    const service = new FactService(client, db)

    const count = await service.countByPredicateRaw(["needs_action"])

    expect(count).toBe(3)
  })

  it("paginates across multiple Notion pages and sums the totals", async () => {
    // The internal vault carries 271 open loops in production, which spans
    // three 100-row pages. A single-shot count would silently undercount
    // by ~63%; the preflight is supposed to be the alarm, not the leak.
    const page1 = Array.from({ length: 100 }, (_, i) => buildFactPage({ id: `f1-${i}` }))
    const page2 = Array.from({ length: 100 }, (_, i) => buildFactPage({ id: `f2-${i}` }))
    const page3 = Array.from({ length: 71 }, (_, i) => buildFactPage({ id: `f3-${i}` }))
    const { client, querySpy } = createClient([
      { results: page1, has_more: true, next_cursor: "c1" },
      { results: page2, has_more: true, next_cursor: "c2" },
      { results: page3, has_more: false, next_cursor: null },
    ])
    const service = new FactService(client, db)

    const count = await service.countByPredicateRaw([
      "needs_action",
      "waiting_on",
      "blocked_by",
    ])

    expect(count).toBe(271)
    expect(querySpy).toHaveBeenCalledTimes(3)
    // Cursor must thread across pages — without it the second call
    // re-fetches page 1 forever.
    expect(querySpy.mock.calls[1][0]).toMatchObject({ start_cursor: "c1" })
    expect(querySpy.mock.calls[2][0]).toMatchObject({ start_cursor: "c2" })
  })

  it("collapses single-string input to a flat select.equals filter", async () => {
    // The OR-of-equals shape is unnecessary when only one predicate
    // value needs matching. Notion accepts both, but the flat form is
    // what `predicateFilterClause` produces elsewhere on this service
    // for parity.
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.countByPredicateRaw(["needs_action"])

    const filter = calls[0].filter as { and: Array<Record<string, unknown>> }
    const predicateClause = filter.and.find(
      (c) => (c as { property?: string }).property === "Predicate"
    )
    expect(predicateClause).toMatchObject({
      property: "Predicate",
      select: { equals: "needs_action" },
    })
  })

  it("OR-s multiple raw predicate values as select.equals clauses", async () => {
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.countByPredicateRaw(["needs_action", "waiting_on", "blocked_by"])

    const filter = calls[0].filter as { and: Array<Record<string, unknown>> }
    const orClause = filter.and.find((c) => "or" in c) as
      | { or: Array<{ property: string; select: { equals: string } }> }
      | undefined
    expect(orClause).toBeDefined()
    const values = orClause!.or.map((c) => c.select.equals).sort()
    expect(values).toEqual(["blocked_by", "needs_action", "waiting_on"])
    for (const clause of orClause!.or) {
      expect(clause).toMatchObject({
        property: "Predicate",
        select: { equals: expect.any(String) },
      })
    }
  })

  it("filters by Valid Until is_empty so invalidated rows never inflate the count", async () => {
    // The preflight fires when the vault carries LIVE tracking facts.
    // Counting historical/invalidated rows would re-warn an operator
    // who already migrated, defeating the silence-after-migration UX
    // the preflight is supposed to deliver.
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.countByPredicateRaw(["needs_action"])

    const filter = calls[0].filter as { and: Array<Record<string, unknown>> }
    const validUntilClause = filter.and.find(
      (c) => (c as { property?: string }).property === "Valid Until"
    )
    expect(validUntilClause).toMatchObject({
      property: "Valid Until",
      date: { is_empty: true },
    })
  })

  it("uses Notion's max page_size for the count walk", async () => {
    // Counting is purely about totalling rows — no caller needs a
    // per-page slice. Pinning page_size at 100 minimizes the number of
    // round-trips against Notion's rate limiter for the common case.
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.countByPredicateRaw(["needs_action"])

    expect(calls[0].page_size).toBe(100)
  })

  it("never instantiates Fact domain objects (bypasses pageToFact)", async () => {
    // Load-bearing for the 0.6.0 contract: #23 adds a `pageToFact`
    // filter that returns null for tracking-predicate rows. A method
    // that walks `pageToFact` and counts the non-nulls would silently
    // regress to zero on real vaults. Pin that contract by feeding the
    // method pages that lack the columns `pageToFact` reads — if the
    // count works regardless, we know the conversion never ran.
    const malformedPages = [
      // No `properties` block at all — `pageToFact` would throw on
      // `extractTitle(props["Subject"])` because props is undefined.
      { object: "page", id: "broken-1" },
      { object: "page", id: "broken-2" },
    ] as unknown as PageObjectResponse[]
    const { client } = createClient([{ results: malformedPages, has_more: false }])
    const service = new FactService(client, db)

    const count = await service.countByPredicateRaw(["needs_action"])

    expect(count).toBe(2)
  })

  it("survives raw input strings the FactPredicate union does not name", async () => {
    // The `Raw` suffix's reason for existing: a future #23 follow-up
    // could remove `needs_action` from the typed union entirely. The
    // method must keep matching that raw select value because
    // historical Notion rows still carry it. A typed-predicate
    // signature would refuse to compile against a removed literal,
    // breaking the preflight at exactly the moment it matters.
    const { client, calls } = createClient([
      { results: [buildFactPage({ id: "legacy-1" })], has_more: false },
    ])
    const service = new FactService(client, db)

    // String not in `FactPredicate` today — the call still type-checks
    // because the parameter is `string[]`, not `FactPredicate[]`.
    const count = await service.countByPredicateRaw(["some_future_legacy_value"])

    expect(count).toBe(1)
    const filter = calls[0].filter as { and: Array<Record<string, unknown>> }
    const predicateClause = filter.and.find(
      (c) => (c as { property?: string }).property === "Predicate"
    )
    expect(predicateClause).toMatchObject({
      property: "Predicate",
      select: { equals: "some_future_legacy_value" },
    })
  })
})

describe("FactService.getById (issue 0.8.0/06)", () => {
  // Single-page lookup feeding the contradiction-decrement path on
  // `lore-fact action='invalidate'`. Returns `Fact | null` with the
  // same null contract as `pageToFact` — historical tracking-predicate
  // rows surface as null so callers don't treat them as live facts.

  it("returns the Fact when the page is full and the predicate is in-vocabulary", async () => {
    const retrieve = vi.fn().mockResolvedValue(
      factPage({
        id: "fact-1",
        subject: "AuthService",
        predicate: "uses",
        object: "JWT",
        sourceMemoryId: "mem-source",
      })
    )
    const client = { pages: { retrieve } } as unknown as Client
    const service = new FactService(client, db)

    const fact = await service.getById("fact-1")

    expect(retrieve).toHaveBeenCalledWith({ page_id: "fact-1" })
    expect(fact).not.toBeNull()
    expect(fact!.id).toBe("fact-1")
    expect(fact!.subject).toBe("AuthService")
    expect(fact!.predicate).toBe("uses")
    expect(fact!.sourceMemoryId).toBe("mem-source")
  })

  it("returns null for historical tracking-predicate rows (needs_action / waiting_on / blocked_by)", async () => {
    // Mirrors the `pageToFact` filter — invalidate's read-then-update
    // ordering relies on this contract: a tracking row read returns
    // null, the invalidate write still succeeds, the contradiction
    // decrement skips because there's no live source to penalize.
    const trackingPage = factPage({ id: "tracking-fact" })
    ;(
      trackingPage.properties.Predicate as unknown as {
        select: { name: string }
      }
    ).select.name = "needs_action"
    const retrieve = vi.fn().mockResolvedValue(trackingPage)
    const client = { pages: { retrieve } } as unknown as Client
    const service = new FactService(client, db)

    const fact = await service.getById("tracking-fact")

    expect(fact).toBeNull()
  })

  it("returns null when the page response is partial (Notion is_full_page guard)", async () => {
    // Notion's `pages.retrieve` returns a partial response when the
    // integration lacks read access to the page or when the page has
    // been deleted. `isFullPage` rejects those — `getById` must
    // surface that as null rather than returning a half-built `Fact`.
    const retrieve = vi.fn().mockResolvedValue({
      object: "page",
      id: "partial-id",
      // Missing properties / parent — fails isFullPage.
    })
    const client = { pages: { retrieve } } as unknown as Client
    const service = new FactService(client, db)

    const fact = await service.getById("partial-id")

    expect(fact).toBeNull()
  })

  it("returns null for archived rows (issue #497)", async () => {
    // `pageToFact` does not gate on `archived`, so without the
    // `getById`-level guard an archived row would deserialize as a
    // live `Fact`. The downstream effect this gate prevents:
    // `handleInvalidate` reads `sourceMemoryId` off the deserialized
    // archived `Fact` and decrements the source memory's
    // `Confidence Score` against a fact that's already excluded from
    // the active dataset. Returning null here makes the read-side
    // path symmetric with "row missing" without forcing the handler
    // into a try/catch.
    //
    // The separate no-`Valid Until`-write guarantee for archived
    // rows is enforced by `FactService.invalidate` (retrieves the
    // page directly, short-circuits on `archived: true` before any
    // `pages.update`), pinned in
    // `fact-confidence.test.ts:short-circuits without any pages.update
    // when the row is archived (issue #497)`.
    const retrieve = vi
      .fn()
      .mockResolvedValue(factPage({ id: "archived-fact", archived: true }))
    const client = { pages: { retrieve } } as unknown as Client
    const service = new FactService(client, db)

    const fact = await service.getById("archived-fact")

    expect(retrieve).toHaveBeenCalledWith({ page_id: "archived-fact" })
    expect(fact).toBeNull()
  })
})
