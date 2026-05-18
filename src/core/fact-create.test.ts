import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { FACT_PROPS } from "../notion/schema.js"
import { computeFactDedupKey } from "../notion/normalize.js"
import type { CreateFactInput, DatabaseRef, FactPredicate } from "../types.js"
import {
  FactCreatePipeline,
  __resetDedupDuplicateScopeMatchWarnedForTests,
  __resetProbeFailureLogForTests,
} from "./fact-create.js"
import { pageToFactSync } from "./fact-mapper.js"

const DB: DatabaseRef = {
  databaseId: "facts-db",
  dataSourceId: "facts-ds",
}

type MockClient = Client & {
  dataSources: { query: ReturnType<typeof vi.fn> }
  pages: {
    create: ReturnType<typeof vi.fn>
    retrieve: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
  request: ReturnType<typeof vi.fn>
}

function richText(value: string) {
  return { type: "rich_text", rich_text: value ? [{ plain_text: value }] : [] }
}

function dateProp(value: string | null) {
  return { type: "date", date: value ? { start: value } : null }
}

function relationProp(ids: string[]) {
  return { type: "relation", relation: ids.map((id) => ({ id })) }
}

function factPage(overrides: {
  id?: string
  subject?: string
  predicate?: FactPredicate
  object?: string
  createdTime?: string
  projectIds?: string[]
  sourceMemoryId?: string | null
  reviewBy?: string | null
  subjectEntityId?: string | null
  objectEntityId?: string | null
  dedupKey?: string
  archived?: boolean
}): PageObjectResponse {
  return {
    object: "page",
    id: overrides.id ?? "fact-id",
    created_time: overrides.createdTime ?? "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-01-02T00:00:00.000Z",
    archived: overrides.archived ?? false,
    url: `https://notion.so/${overrides.id ?? "fact-id"}`,
    parent: { type: "data_source_id", data_source_id: DB.dataSourceId },
    properties: {
      [FACT_PROPS.SUBJECT]: {
        type: "title",
        title: [{ plain_text: overrides.subject ?? "Sub" }],
      } as unknown,
      [FACT_PROPS.PREDICATE]: {
        type: "select",
        select: { name: overrides.predicate ?? "uses" },
      } as unknown,
      [FACT_PROPS.OBJECT]: richText(overrides.object ?? "Obj") as unknown,
      [FACT_PROPS.PROJECT]: relationProp(overrides.projectIds ?? []) as unknown,
      [FACT_PROPS.VALID_FROM]: dateProp("2026-01-01") as unknown,
      [FACT_PROPS.VALID_UNTIL]: dateProp(null) as unknown,
      [FACT_PROPS.OBSERVED_AT]: dateProp("2026-01-01") as unknown,
      [FACT_PROPS.INVALIDATED_AT]: dateProp(null) as unknown,
      [FACT_PROPS.INVALIDATED_BY]: relationProp([]) as unknown,
      [FACT_PROPS.REVIEW_BY]: dateProp(overrides.reviewBy ?? null) as unknown,
      [FACT_PROPS.SOURCE]: relationProp(
        overrides.sourceMemoryId ? [overrides.sourceMemoryId] : []
      ) as unknown,
      [FACT_PROPS.CONFIDENCE]: {
        type: "select",
        select: { name: "certain" },
      } as unknown,
      [FACT_PROPS.CONFIDENCE_SCORE]: { type: "number", number: null } as unknown,
      [FACT_PROPS.LAST_REFERENCED_AT]: dateProp(null) as unknown,
      [FACT_PROPS.DEDUP_KEY]: richText(overrides.dedupKey ?? "") as unknown,
      [FACT_PROPS.SUBJECT_KEY]: richText("") as unknown,
      [FACT_PROPS.SUBJECT_ENTITY]: relationProp(
        overrides.subjectEntityId ? [overrides.subjectEntityId] : []
      ) as unknown,
      [FACT_PROPS.OBJECT_ENTITY]: relationProp(
        overrides.objectEntityId ? [overrides.objectEntityId] : []
      ) as unknown,
      [FACT_PROPS.SCOPE_KIND]: { type: "select", select: null } as unknown,
      [FACT_PROPS.SCOPE_KEY]: richText("") as unknown,
      [FACT_PROPS.AUDIENCE]: richText("") as unknown,
      [FACT_PROPS.LIFETIME]: { type: "select", select: null } as unknown,
      [FACT_PROPS.EXPIRES_AT]: dateProp(null) as unknown,
    } as PageObjectResponse["properties"],
  } as PageObjectResponse
}

function makeClient(): MockClient {
  return {
    dataSources: { query: vi.fn() },
    pages: {
      create: vi.fn(),
      retrieve: vi.fn(async (args: { page_id: string }) =>
        factPage({ id: args.page_id })
      ),
      update: vi.fn(async () => ({})),
    },
    request: vi.fn(),
  } as unknown as MockClient
}

function makePipeline(client: MockClient, useRunToolBatchCreates = false) {
  return new FactCreatePipeline({
    client,
    db: DB,
    pageToFact: async (page) => pageToFactSync(page),
    useRunToolBatchCreates,
  })
}

function mention(index: number): CreateFactInput {
  return {
    subject: "memory-title",
    predicate: "mentions",
    object: `entity-${index}`,
    projectIds: ["proj-1"],
    sourceMemoryId: "mem-1",
    confidence: "speculative",
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

let testHomeDir: string

beforeEach(() => {
  testHomeDir = mkdtempSync(
    join(process.env["TMPDIR"] ?? "/tmp", "lore-fact-create-test-")
  )
  vi.stubEnv("HOME", testHomeDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(testHomeDir, { recursive: true, force: true })
  vi.restoreAllMocks()
  __resetDedupDuplicateScopeMatchWarnedForTests()
  __resetProbeFailureLogForTests()
})

describe("FactCreatePipeline.createWithDedup", () => {
  it("falls back to blind create on dedup probe failure and logs once", async () => {
    __resetProbeFailureLogForTests()
    const client = makeClient()
    const pipeline = makePipeline(client)
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    client.dataSources.query.mockRejectedValue(new Error("DedupKey missing"))
    client.pages.create
      .mockResolvedValueOnce(factPage({ id: "fallback-1" }))
      .mockResolvedValueOnce(factPage({ id: "fallback-2" }))

    const first = await pipeline.createWithDedup({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
    })
    const second = await pipeline.createWithDedup({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
    })

    expect(first.deduped).toBe(false)
    expect(second.deduped).toBe(false)
    expect(first.fact.id).toBe("fallback-1")
    expect(second.fact.id).toBe("fallback-2")
    expect(client.pages.create).toHaveBeenCalledTimes(2)
    expect(errorSpy).toHaveBeenCalledTimes(1)

    const createCall = client.pages.create.mock.calls[0]![0] as {
      properties: Record<string, { rich_text?: Array<{ text: { content: string } }> }>
    }
    expect(
      createCall.properties[FACT_PROPS.DEDUP_KEY]?.rich_text?.[0]?.text.content
    ).toBe(
      computeFactDedupKey({
        subject: "AuthService",
        predicate: "uses",
        object: "JWT",
      })
    )
  })

  it("enriches a dedup hit with review, project, and source fields in one update", async () => {
    const client = makeClient()
    const pipeline = makePipeline(client)
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        factPage({
          id: "existing",
          projectIds: ["proj-a"],
          reviewBy: "2026-04-01",
          sourceMemoryId: null,
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await pipeline.createWithDedup({
      subject: "Sub",
      predicate: "uses",
      object: "Obj",
      projectIds: ["proj-a", "proj-b"],
      reviewBy: "2026-05-01",
      sourceMemoryId: "mem-new",
    })

    expect(result.deduped).toBe(true)
    expect(result.fact.id).toBe("existing")
    expect(result.fact.projectIds).toEqual(["proj-a", "proj-b"])
    expect(result.fact.reviewBy).toBe("2026-05-01")
    expect(result.fact.sourceMemoryId).toBe("mem-new")
    expect(result.enriched).toEqual([
      "extended review to 2026-05-01",
      "added 1 project",
      "linked source memory",
    ])
    expect(client.pages.update).toHaveBeenCalledTimes(1)
    expect(client.pages.update).toHaveBeenCalledWith({
      page_id: "existing",
      properties: {
        [FACT_PROPS.REVIEW_BY]: { date: { start: "2026-05-01" } },
        [FACT_PROPS.PROJECT]: { relation: [{ id: "proj-a" }, { id: "proj-b" }] },
        [FACT_PROPS.SOURCE]: { relation: [{ id: "mem-new" }] },
      },
    })
  })

  it("uses the earliest-created duplicate scope match and warns once", async () => {
    __resetDedupDuplicateScopeMatchWarnedForTests()
    const client = makeClient()
    const pipeline = makePipeline(client)
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    client.dataSources.query.mockResolvedValue({
      results: [
        factPage({
          id: "earliest",
          createdTime: "2026-01-01T00:00:00.000Z",
        }),
        factPage({
          id: "later",
          createdTime: "2026-01-02T00:00:00.000Z",
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const first = await pipeline.createWithDedup({
      subject: "Sub",
      predicate: "uses",
      object: "Obj",
    })
    const second = await pipeline.createWithDedup({
      subject: "Sub",
      predicate: "uses",
      object: "Obj",
    })

    expect(first.fact.id).toBe("earliest")
    expect(second.fact.id).toBe("earliest")
    expect(client.pages.create).not.toHaveBeenCalled()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(String(stderrSpy.mock.calls[0]![0])).toContain(
      "scope-constrained probe found multiple live"
    )
    expect(client.dataSources.query.mock.calls[0]![0]).toMatchObject({
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
      page_size: 2,
    })
  })

  it("holds entity relation locks across the dedup read and merge write", async () => {
    const client = makeClient()
    const pipeline = makePipeline(client)
    const events: string[] = []
    const firstUpdateStarted = deferred()
    const releaseFirstUpdate = deferred()

    client.dataSources.query.mockImplementation(async () => {
      events.push("query")
      return {
        results: [
          factPage({
            id: `existing-${events.filter((event) => event === "query").length}`,
            projectIds: [],
          }),
        ],
        has_more: false,
        next_cursor: null,
      }
    })
    client.pages.update.mockImplementation(async () => {
      events.push("update-start")
      if (events.filter((event) => event === "update-start").length === 1) {
        firstUpdateStarted.resolve()
        await releaseFirstUpdate.promise
      }
      events.push("update-end")
      return {}
    })

    const first = pipeline.createWithDedup({
      subject: "Sub",
      predicate: "uses",
      object: "Obj",
      projectIds: ["proj-a"],
      subjectEntityId: "ent-sub",
      objectEntityId: "ent-obj",
    })
    await firstUpdateStarted.promise

    const second = pipeline.createWithDedup({
      subject: "Sub",
      predicate: "uses",
      object: "Obj",
      projectIds: ["proj-b"],
      subjectEntityId: "ent-sub",
      objectEntityId: "ent-obj",
    })
    await sleep(75)

    expect(events).toEqual(["query", "update-start"])

    releaseFirstUpdate.resolve()
    await Promise.all([first, second])

    expect(events).toEqual([
      "query",
      "update-start",
      "update-end",
      "query",
      "update-start",
      "update-end",
    ])
  })
})

describe("FactCreatePipeline.createBatchWithDedup", () => {
  it("re-probes the tail after a maybe-committed 5xx batch failure", async () => {
    const client = makeClient()
    const pipeline = makePipeline(client, true)
    client.request.mockRejectedValueOnce(
      Object.assign(new Error("server"), { status: 503 })
    )
    client.pages.create.mockResolvedValue(factPage({ id: "fresh-tail" }))
    let probeCount = 0
    client.dataSources.query.mockImplementation(async (args: { filter: unknown }) => {
      probeCount += 1
      if (probeCount <= 2) {
        return { results: [], has_more: false, next_cursor: null }
      }

      const filter = args.filter as {
        and: Array<{ rich_text?: { equals?: string } }>
      }
      const dedupKey = filter.and
        .map((clause) => clause.rich_text?.equals)
        .find((value): value is string => typeof value === "string")
      const entity0Key = computeFactDedupKey({
        subject: "memory-title",
        predicate: "mentions",
        object: "entity-0",
      })
      if (dedupKey === entity0Key) {
        return {
          results: [
            factPage({
              id: "server-committed-tail",
              subject: "memory-title",
              predicate: "mentions",
              object: "entity-0",
            }),
          ],
          has_more: false,
          next_cursor: null,
        }
      }
      return { results: [], has_more: false, next_cursor: null }
    })

    const results = await pipeline.createBatchWithDedup([mention(0), mention(1)])

    expect(results).toHaveLength(2)
    expect(client.dataSources.query).toHaveBeenCalledTimes(4)
    expect(client.pages.create).toHaveBeenCalledTimes(1)
    expect(results[0]!.status).toBe("fulfilled")
    expect(results[1]!.status).toBe("fulfilled")
    if (results[0]!.status === "fulfilled") {
      expect(results[0]!.value.deduped).toBe(true)
      expect(results[0]!.value.fact.id).toBe("server-committed-tail")
    }
    if (results[1]!.status === "fulfilled") {
      expect(results[1]!.value.deduped).toBe(false)
    }
  })

  it("uses fresh create without re-probing after a pre-commit 4xx batch failure", async () => {
    const client = makeClient()
    const pipeline = makePipeline(client, true)
    client.dataSources.query.mockResolvedValue({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.request.mockRejectedValueOnce(
      Object.assign(new Error("validation"), {
        status: 400,
        code: "validation_error",
      })
    )
    client.pages.create
      .mockResolvedValueOnce(factPage({ id: "fresh-0" }))
      .mockResolvedValueOnce(factPage({ id: "fresh-1" }))

    const results = await pipeline.createBatchWithDedup([mention(0), mention(1)])

    expect(results).toHaveLength(2)
    expect(results.every((result) => result.status === "fulfilled")).toBe(true)
    expect(client.dataSources.query).toHaveBeenCalledTimes(2)
    expect(client.pages.create).toHaveBeenCalledTimes(2)
  })
})
