import { describe, expect, it, vi, beforeEach } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import {
  FactService,
  __resetProbeFailureLogForTests,
  clampNotionPageSize,
} from "./fact.js"
import {
  normalize,
  computeFactDedupKey,
  computeSubjectKey,
} from "../notion/normalize.js"
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

describe("FactService.listTracking", () => {
  it("filters by the tracking-predicate set and Valid Until is_empty", async () => {
    // Every tracking predicate must land in the OR clause; skipping one
    // would silently exclude `blocked_by` (or whichever) facts from
    // `lore-open-loops` output.
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.listTracking({ projectId: "p1" })

    const filter = calls[0].filter as { and: Array<Record<string, unknown>> }
    expect(filter).toHaveProperty("and")

    // Multiple OR groups coexist inside the compound AND: the project-
    // scope filter, the predicate filter, and (when set) the entity
    // filter. Pick the one whose children are select-equals on Predicate.
    const predicateGroup = filter.and.find((c) => {
      const maybeOr = (c as { or?: Array<Record<string, unknown>> }).or
      if (!Array.isArray(maybeOr)) return false
      return maybeOr.every(
        (clause) => (clause as { property?: string }).property === "Predicate",
      )
    }) as { or: Array<{ property: string; select: { equals: string } }> }
    expect(predicateGroup).toBeDefined()
    const predicates = predicateGroup.or.map((c) => c.select.equals).sort()
    expect(predicates).toEqual([...TRACKING_PREDICATES].sort())

    const validUntilClause = filter.and.find(
      (c) => (c as { property?: string }).property === "Valid Until",
    )
    expect(validUntilClause).toMatchObject({
      property: "Valid Until",
      date: { is_empty: true },
    })
  })

  it("adds an OR(SubjectKey, Subject, Object contains) clause when entity is set", async () => {
    // Entity filter must match both sides — PR slugs commonly appear as
    // the Object of a `waiting_on` fact, while service names are
    // Subjects. Losing either side silently halves recall.
    //
    // The Subject side gets the SubjectKey case-folded variant alongside
    // the raw Subject so case-variant entity names resolve correctly
    // (P3-03 Part A); the Object side stays raw because Part A doesn't
    // add an ObjectKey column (Part B work).
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.listTracking({ projectId: "p1", entity: "PR #25751" })

    const filter = calls[0].filter as { and: Array<Record<string, unknown>> }
    const entityGroup = filter.and.find((c) => {
      const maybeOr = (c as { or?: Array<Record<string, unknown>> }).or
      if (!Array.isArray(maybeOr)) return false
      const props = maybeOr.map((clause) => (clause as { property?: string }).property)
      return props.includes("Subject") && props.includes("Object")
    }) as { or: Array<Record<string, unknown>> }
    expect(entityGroup).toBeDefined()

    const subjectKey = entityGroup.or.find(
      (c) => (c as { property?: string }).property === "SubjectKey",
    ) as { property: string; rich_text: { contains: string } }
    const subject = entityGroup.or.find(
      (c) => (c as { property?: string }).property === "Subject",
    ) as { property: string; title: { contains: string } }
    const object = entityGroup.or.find(
      (c) => (c as { property?: string }).property === "Object",
    ) as { property: string; rich_text: { contains: string } }
    expect(subjectKey).toMatchObject({
      property: "SubjectKey",
      rich_text: { contains: computeSubjectKey("PR #25751") },
    })
    expect(subject).toMatchObject({
      property: "Subject",
      title: { contains: "PR #25751" },
    })
    expect(object).toMatchObject({
      property: "Object",
      rich_text: { contains: "PR #25751" },
    })
  })

  it("OR-s SubjectEntity/ObjectEntity relation clauses when entityId is set (PF3-01)", async () => {
    // Post-PF3-01 callers (handleOpenLoops resolving via EntityService)
    // pass an entityId alongside the substring entity. The server-side
    // filter must include both relation clauses AND the substring
    // clauses so post-migration rows surface by exact relation while
    // un-migrated rows still surface via substring.
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.listTracking({
      projectId: "p1",
      entity: "PR #25751",
      entityId: "ent-pr-25751",
    })

    // Find the entity OR group — distinguished from the predicate OR
    // group by the presence of Subject/Object/SubjectEntity clauses.
    const filter = calls[0].filter as { and: Array<Record<string, unknown>> }
    const entityGroup = filter.and.find((c) => {
      const maybeOr = (c as { or?: Array<Record<string, unknown>> }).or
      if (!Array.isArray(maybeOr)) return false
      const props = maybeOr.map((clause) => (clause as { property?: string }).property)
      return props.includes("Subject") || props.includes("SubjectEntity")
    }) as { or: Array<Record<string, unknown>> }
    expect(entityGroup).toBeDefined()

    const subjectEntity = entityGroup.or.find(
      (c) => (c as { property?: string }).property === "SubjectEntity",
    ) as { property: string; relation: { contains: string } }
    const objectEntity = entityGroup.or.find(
      (c) => (c as { property?: string }).property === "ObjectEntity",
    ) as { property: string; relation: { contains: string } }
    expect(subjectEntity).toMatchObject({
      property: "SubjectEntity",
      relation: { contains: "ent-pr-25751" },
    })
    expect(objectEntity).toMatchObject({
      property: "ObjectEntity",
      relation: { contains: "ent-pr-25751" },
    })

    // The substring branches still ride along — un-migrated rows
    // remain reachable.
    const subjectSubstring = entityGroup.or.find(
      (c) => (c as { property?: string }).property === "Subject",
    )
    expect(subjectSubstring).toBeDefined()
  })

  it("sorts by Review By ascending, then created_time descending", async () => {
    // Pinned: the service-side sort biases early pages toward high-signal
    // rows (soonest review first) so capped callers see the important
    // stuff even if they never paginate past page 1.
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.listTracking({ projectId: "p1" })

    expect(calls[0].sorts).toEqual([
      { property: "Review By", direction: "ascending" },
      { timestamp: "created_time", direction: "descending" },
    ])
  })

  it("paginates across multiple Notion pages when limit is undefined", async () => {
    // `all: true` in the tool layer translates to limit=undefined here.
    // The worst-case Mail vault has ~271 open loops, which spans three
    // 100-row pages. A single-page walk would undercount by ~63%.
    const page1 = Array.from({ length: 100 }, (_, i) =>
      buildFactPage({ id: `f1-${i}` }),
    )
    const page2 = Array.from({ length: 100 }, (_, i) =>
      buildFactPage({ id: `f2-${i}` }),
    )
    const page3 = Array.from({ length: 71 }, (_, i) =>
      buildFactPage({ id: `f3-${i}` }),
    )
    const { client, querySpy } = createClient([
      { results: page1, has_more: true, next_cursor: "c1" },
      { results: page2, has_more: true, next_cursor: "c2" },
      { results: page3, has_more: false, next_cursor: null },
    ])
    const service = new FactService(client, db)

    const { items, hasMore } = await service.listTracking({ projectId: "p1" })

    expect(querySpy).toHaveBeenCalledTimes(3)
    expect(items).toHaveLength(271)
    expect(hasMore).toBe(false)
    // Second call must thread the cursor from page 1.
    expect(querySpy.mock.calls[1][0]).toMatchObject({ start_cursor: "c1" })
    expect(querySpy.mock.calls[2][0]).toMatchObject({ start_cursor: "c2" })
  })

  it("stops paginating once the limit is reached and reports hasMore=true", async () => {
    // Limit-reached-mid-page is the interesting case: Notion may still
    // have rows in the response after we hit the cap. `hasMore` must
    // reflect that so the tool layer can surface a "+N more" hint.
    const page1 = Array.from({ length: 100 }, (_, i) =>
      buildFactPage({ id: `f-${i}` }),
    )
    const { client, querySpy } = createClient([
      { results: page1, has_more: true, next_cursor: "c1" },
    ])
    const service = new FactService(client, db)

    const { items, hasMore } = await service.listTracking({ projectId: "p1", limit: 10 })

    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(items).toHaveLength(10)
    expect(hasMore).toBe(true)
  })

  it("reports hasMore=false when the full result set fits under the limit", async () => {
    // Corollary to the previous test: if a scoped vault has 3 open loops
    // and the caller asks for 10, `hasMore` must be false so the tool
    // doesn't emit a misleading "+N hidden" hint.
    const { client } = createClient([
      { results: [buildFactPage({ id: "f1" })], has_more: false },
    ])
    const service = new FactService(client, db)

    const { items, hasMore } = await service.listTracking({ projectId: "p1", limit: 10 })

    expect(items).toHaveLength(1)
    expect(hasMore).toBe(false)
  })

  it("reports hasMore=false when limit exactly matches the last page size", async () => {
    // Boundary case the other two tests miss: the caller asked for 100,
    // the page returned exactly 100 rows, and Notion signalled no more
    // pages. `items.length >= limit` IS true so we enter the limit-hit
    // branch, but `appended === pages.length` and `nextCursor` is
    // undefined — expect hasMore=false. Pinning this stops a future
    // refactor that accidentally sets `hasMore = true` whenever the
    // limit-branch fires.
    const page1 = Array.from({ length: 100 }, (_, i) =>
      buildFactPage({ id: `f-${i}` }),
    )
    const { client } = createClient([
      { results: page1, has_more: false, next_cursor: null },
    ])
    const service = new FactService(client, db)

    const { items, hasMore } = await service.listTracking({
      projectId: "p1",
      limit: 100,
    })

    expect(items).toHaveLength(100)
    expect(hasMore).toBe(false)
  })

  it("suppresses the SubjectKey OR branch when entity normalizes to empty", async () => {
    // Same broadening trap as `queryBySubject` — `lore-open-loops` with
    // an entity input of `"."` or `"   "` would otherwise silently match
    // every populated-SubjectKey row in the vault. The Subject + Object
    // raw-contains branches still run, preserving the pre-P3-03
    // substring semantics for these edge inputs.
    for (const entity of [".", "   ", "!!!"]) {
      const { client, calls } = createClient([{ results: [] }])
      await new FactService(client, db).listTracking({
        projectId: "p1",
        entity,
      })

      expect(computeSubjectKey(entity)).toBe("")

      const filter = calls[0].filter as { and: Array<Record<string, unknown>> }
      const entityGroup = filter.and.find((c) => {
        const maybeOr = (c as { or?: Array<Record<string, unknown>> }).or
        if (!Array.isArray(maybeOr)) return false
        const props = maybeOr.map(
          (clause) => (clause as { property?: string }).property,
        )
        return props.includes("Subject") && props.includes("Object")
      }) as { or: Array<Record<string, unknown>> }
      expect(entityGroup).toBeDefined()

      const properties = entityGroup.or.map(
        (c) => (c as { property?: string }).property,
      )
      expect(properties).not.toContain("SubjectKey")
      expect(properties).toEqual(expect.arrayContaining(["Subject", "Object"]))
    }
  })

  it("drops the Valid Until filter when includeInvalidated is true", async () => {
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.listTracking({ projectId: "p1", includeInvalidated: true })

    const filter = calls[0].filter as Record<string, unknown>
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
    expect(computeSubjectKey("MemoryService")).toBe(
      computeSubjectKey("memoryservice")
    )
    expect(computeSubjectKey("MemoryService")).toBe(
      computeSubjectKey("MemoryService ")
    )
    expect(computeSubjectKey("MemoryService")).toBe(
      computeSubjectKey(" MemoryService.")
    )
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
    expect(createCall.properties.Subject.title[0].text.content).toBe(
      "MemoryService"
    )
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
      const props = maybeOr.map(
        (clause) => (clause as { property?: string }).property
      )
      return props.includes("SubjectKey") && props.includes("Subject")
    }) as { or: Array<Record<string, unknown>> } | undefined
    expect(orGroup).toBeDefined()

    const subjectKeyClause = orGroup!.or.find(
      (c) => (c as { property?: string }).property === "SubjectKey"
    ) as { property: string; rich_text: { contains: string } }
    expect(subjectKeyClause.rich_text.contains).toBe(
      computeSubjectKey("MemoryService")
    )

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

  it("omits the OR clause entirely when subject is empty (list-all-in-scope)", async () => {
    // Empty subject means "list every fact in scope" — adding a
    // `SubjectKey contains ""` clause would constrain the result to rows
    // with non-empty SubjectKey, silently hiding pre-migration rows.
    const { client, calls } = createClient([{ results: [] }])
    const service = new FactService(client, db)

    await service.queryBySubject("", { projectId: "p1" })

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
          (clause) => (clause as { property?: string }).property === "SubjectKey",
        )
      })
      expect(hasSubjectKeyClause).toBe(false)

      // Raw Subject filter still applied — caller still gets literal-
      // substring semantics.
      const subjectClause = clauses.find(
        (c) => (c as { property?: string }).property === "Subject",
      ) as { property: string; title: { contains: string } } | undefined
      expect(subjectClause).toBeDefined()
      expect(subjectClause!.title.contains).toBe(subject)
    }
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
  // Hot-path callers like `loadWakeUpData` (openLoopLimit forwarded into
  // `queryBySubject`) and `resolveCurrentDecisions` (limit: 25 forwarded
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
    await new FactService(subjectCall.client, db).queryBySubject(
      "MemoryService",
      { projectId: "p1" },
    )
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
    // Mail vault's open-loops scale) lost ~63% of the result set.
    const page1 = Array.from({ length: 100 }, (_, i) =>
      buildFactPage({ id: `f1-${i}` }),
    )
    const page2 = Array.from({ length: 100 }, (_, i) =>
      buildFactPage({ id: `f2-${i}` }),
    )
    const page3 = Array.from({ length: 71 }, (_, i) =>
      buildFactPage({ id: `f3-${i}` }),
    )
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
    const page1 = Array.from({ length: 100 }, (_, i) =>
      buildFactPage({ id: `f-${i}` }),
    )
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
    const page1 = Array.from({ length: 100 }, (_, i) =>
      buildFactPage({ id: `f-${i}` }),
    )
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

    expect(calls[0].sorts).toEqual([
      { property: "Review By", direction: "ascending" },
    ])
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
    const { client, calls } = createClient([
      { results: [] },
      { results: [] },
    ])
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
      factPage({ id: `rel-${i}`, subject: "AuthService" }),
    )
    const textRows = Array.from({ length: 25 }, (_, i) =>
      factPage({ id: `text-${i}`, subject: "AuthService" }),
    )
    const { client } = createClient([
      { results: relationRows },
      { results: textRows },
    ])
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
    filter: { and: Array<Record<string, unknown>> } | Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const clauses = Array.isArray(
      (filter as { and?: Array<Record<string, unknown>> }).and,
    )
      ? ((filter as { and: Array<Record<string, unknown>> }).and)
      : [filter as Record<string, unknown>]
    return clauses.find((c) => {
      const property = (c as { property?: string }).property
      if (property === "Predicate") return true
      const maybeOr = (c as { or?: Array<Record<string, unknown>> }).or
      if (!Array.isArray(maybeOr)) return false
      return maybeOr.every(
        (clause) =>
          (clause as { property?: string }).property === "Predicate",
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
    const { client, calls } = createClient([
      { results: [] },
      { results: [] },
    ])
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
