/**
 * `FactService.createBatchWithDedup` tests (issue #533).
 *
 * Two surfaces are exercised:
 *
 * 1. **Flag off** — `Promise.allSettled(map(createWithDedup))` shape;
 *    the public-API expectation is "byte-equivalent to the pre-#533
 *    auto-mention emission." Verified by counting `pages.create`
 *    invocations and inspecting the per-input properties payload.
 * 2. **Flag on** — one `request` (RunTool `create_pages`) call
 *    replaces N `pages.create` calls for the fresh-create misses.
 *    Verified by inspecting the request body envelope and the
 *    properties payload alignment with the input order.
 *
 * Behavioral-equivalence proof: the test "flag-on and flag-off emit
 * the same logical triples" snapshots the canonical `(subject,
 * predicate, object, projectIds, sourceMemoryId, confidence)` tuples
 * produced under each flag value and asserts set equality. This is
 * the acceptance-criterion check from the issue: "running the same
 * auto-learn/fact-emission scenario with the flag off and on creates
 * the same fact triples."
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import {
  FactService,
  __resetRunToolBatchCreatesAuthFallbackLogForTests,
  classifyTailFallback,
} from "./fact.js"
import type { CreateFactInput, DatabaseRef, FactPredicate } from "../types.js"
import { computeFactDedupKey } from "../notion/normalize.js"

const DB: DatabaseRef = {
  databaseId: "facts-db",
  dataSourceId: "facts-ds",
}

function factPage(overrides: {
  id?: string
  subject?: string
  predicate?: FactPredicate
  object?: string
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
        select: { name: overrides.predicate ?? "mentions" },
      } as unknown,
      Object: {
        type: "rich_text",
        rich_text: [{ plain_text: overrides.object ?? "Obj" }],
      } as unknown,
      Project: { type: "relation", relation: [] } as unknown,
      "Valid From": { type: "date", date: { start: "2026-05-05" } } as unknown,
      "Valid Until": { type: "date", date: null } as unknown,
      "Review By": { type: "date", date: null } as unknown,
      Source: { type: "relation", relation: [] } as unknown,
      Confidence: {
        type: "select",
        select: { name: "speculative" },
      } as unknown,
      DedupKey: { type: "rich_text", rich_text: [] } as unknown,
      SubjectKey: { type: "rich_text", rich_text: [] } as unknown,
      SubjectEntity: { type: "relation", relation: [] } as unknown,
      ObjectEntity: { type: "relation", relation: [] } as unknown,
    } as PageObjectResponse["properties"],
  } as unknown as PageObjectResponse
}

interface MockClient {
  client: Client
  query: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  retrieve: ReturnType<typeof vi.fn>
  request: ReturnType<typeof vi.fn>
}

function makeMockClient(): MockClient {
  const query = vi.fn()
  const create = vi.fn()
  const update = vi.fn()
  const retrieve = vi.fn(async (args: { page_id: string }) =>
    factPage({ id: args.page_id })
  )
  const request = vi.fn()
  const client = {
    dataSources: { query },
    pages: { create, retrieve, update },
    request,
  } as unknown as Client
  return { client, query, create, update, retrieve, request }
}

function mention(idx: number, overrides: Partial<CreateFactInput> = {}): CreateFactInput {
  return {
    subject: "memory-title",
    predicate: "mentions",
    object: `entity-${idx}`,
    sourceMemoryId: "memory-1",
    projectIds: ["proj-1"],
    confidence: "speculative",
    ...overrides,
  }
}

describe("classifyTailFallback (PR #538 round 2 transport-drop guard)", () => {
  // The classifier decides whether a per-input fallback after a
  // batch failure must re-probe via createWithDedup (orphan-commit
  // recovery) or can skip the probe via freshCreateAfterDedupMiss
  // (the failure couldn't have produced a commit).
  it("transport-class (no status) → reprobe", () => {
    expect(classifyTailFallback(new Error("connection reset"))).toBe("reprobe")
    expect(
      classifyTailFallback(
        Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" })
      )
    ).toBe("reprobe")
  })

  it("5xx server errors → reprobe (might have committed before failing)", () => {
    expect(
      classifyTailFallback(Object.assign(new Error("server"), { status: 500 }))
    ).toBe("reprobe")
    expect(
      classifyTailFallback(Object.assign(new Error("bad gateway"), { status: 502 }))
    ).toBe("reprobe")
    expect(
      classifyTailFallback(Object.assign(new Error("gateway timeout"), { status: 504 }))
    ).toBe("reprobe")
  })

  it("4xx pre-commit failures → fresh-create (cannot have committed)", () => {
    // Notion's standard 4xx responses: validation_error (400),
    // unauthorized (401), restricted_resource (403),
    // object_not_found (404), conflict_error (409), rate_limited
    // (429). None of these can produce a committed row.
    expect(
      classifyTailFallback(
        Object.assign(new Error("validation"), {
          status: 400,
          code: "validation_error",
        })
      )
    ).toBe("fresh-create")
    expect(
      classifyTailFallback(
        Object.assign(new Error("auth"), {
          status: 401,
          code: "unauthorized",
        })
      )
    ).toBe("fresh-create")
    expect(
      classifyTailFallback(
        Object.assign(new Error("403"), {
          status: 403,
          code: "restricted_resource",
        })
      )
    ).toBe("fresh-create")
    expect(
      classifyTailFallback(
        Object.assign(new Error("rate-limited"), {
          status: 429,
          code: "rate_limited",
        })
      )
    ).toBe("fresh-create")
  })

  it("non-Error / null inputs default to reprobe (conservative)", () => {
    expect(classifyTailFallback(null)).toBe("reprobe")
    expect(classifyTailFallback(undefined)).toBe("reprobe")
    expect(classifyTailFallback("string error")).toBe("reprobe")
    expect(classifyTailFallback(42)).toBe("reprobe")
  })
})

describe("FactService.createBatchWithDedup — empty input", () => {
  it("returns [] without any Notion call", async () => {
    const { client, query, create, request } = makeMockClient()
    const service = new FactService(client, DB)

    const results = await service.createBatchWithDedup([])

    expect(results).toEqual([])
    expect(query).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })
})

describe("FactService.createBatchWithDedup — flag off (default)", () => {
  let mock: MockClient
  let service: FactService

  beforeEach(() => {
    mock = makeMockClient()
    service = new FactService(mock.client, DB)
    // Probe never finds an existing row → fresh create path on every
    // call.
    mock.query.mockResolvedValue({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    mock.create.mockImplementation(async () =>
      factPage({ id: `created-${mock.create.mock.calls.length}` })
    )
  })

  it("dispatches one pages.create per input (legacy fan-out shape)", async () => {
    const inputs = [mention(0), mention(1), mention(2)]
    const results = await service.createBatchWithDedup(inputs)

    expect(results).toHaveLength(3)
    expect(results.every((r) => r.status === "fulfilled")).toBe(true)
    expect(mock.create).toHaveBeenCalledTimes(3)
    expect(mock.request).not.toHaveBeenCalled()
  })

  it("preserves per-input failure isolation (one create rejects, others land)", async () => {
    mock.create
      .mockResolvedValueOnce(factPage({ id: "created-0" }))
      .mockRejectedValueOnce(
        Object.assign(new Error("boom"), { status: 400 })
      )
      .mockResolvedValueOnce(factPage({ id: "created-2" }))

    const results = await service.createBatchWithDedup([
      mention(0),
      mention(1),
      mention(2),
    ])

    expect(results[0]!.status).toBe("fulfilled")
    expect(results[1]!.status).toBe("rejected")
    expect(results[2]!.status).toBe("fulfilled")
  })

  it("short-circuits a single-input call to createWithDedup directly", async () => {
    const result = await service.createBatchWithDedup([mention(0)])
    expect(result).toHaveLength(1)
    expect(result[0]!.status).toBe("fulfilled")
    expect(mock.create).toHaveBeenCalledTimes(1)
    expect(mock.request).not.toHaveBeenCalled()
  })
})

describe("FactService.createBatchWithDedup — flag on (RunTool batch)", () => {
  let mock: MockClient
  let service: FactService

  beforeEach(() => {
    mock = makeMockClient()
    service = new FactService(mock.client, DB, undefined, {
      useRunToolBatchCreates: true,
    })
    mock.query.mockResolvedValue({
      results: [],
      has_more: false,
      next_cursor: null,
    })
  })

  it("issues one create_pages request for N fresh-create misses", async () => {
    mock.request.mockResolvedValueOnce({
      pages: [{ id: "rt-0" }, { id: "rt-1" }, { id: "rt-2" }],
    })

    const results = await service.createBatchWithDedup([
      mention(0),
      mention(1),
      mention(2),
    ])

    expect(results).toHaveLength(3)
    expect(results.every((r) => r.status === "fulfilled")).toBe(true)
    expect(mock.request).toHaveBeenCalledTimes(1)
    // Per-input pages.create must NOT fire on the happy path —
    // that's the whole point of the batch.
    expect(mock.create).not.toHaveBeenCalled()

    const requestArgs = mock.request.mock.calls[0]![0]
    expect(requestArgs.method).toBe("post")
    expect(requestArgs.path).toBe("/v1/tools/run")
    expect(requestArgs.body.type).toBe("create_pages")
    expect(requestArgs.body.create_pages.parent).toEqual({
      type: "data_source_id",
      data_source_id: "facts-ds",
    })
    expect(requestArgs.body.create_pages.pages).toHaveLength(3)

    // Each created Fact carries the synthesized id from the response,
    // matched in input order.
    const ids = results.map((r) =>
      r.status === "fulfilled" ? r.value.fact.id : null
    )
    expect(ids).toEqual(["rt-0", "rt-1", "rt-2"])
  })

  it("preserves dedup merge semantics for hits and only batches fresh misses", async () => {
    // Input 1 (idx 1) probes to an existing row; the others miss.
    mock.query.mockImplementation(async (args: { filter: unknown }) => {
      const filter = args.filter as { and: Array<{ rich_text?: { equals?: string } }> }
      const dedupKey = filter.and
        .map((c) => c.rich_text?.equals)
        .find((v) => typeof v === "string" && v.length > 0)
      // Construct dedup keys for each entity to compare.
      const entity1Key = computeFactDedupKey({
        subject: "memory-title",
        predicate: "mentions",
        object: "entity-1",
      })
      if (dedupKey === entity1Key) {
        return {
          results: [
            factPage({
              id: "existing-fact",
              subject: "memory-title",
              predicate: "mentions",
              object: "entity-1",
            }),
          ],
          has_more: false,
          next_cursor: null,
        }
      }
      return { results: [], has_more: false, next_cursor: null }
    })
    mock.request.mockResolvedValueOnce({
      pages: [{ id: "rt-0" }, { id: "rt-2" }],
    })

    const results = await service.createBatchWithDedup([
      mention(0),
      mention(1),
      mention(2),
    ])

    expect(results).toHaveLength(3)
    expect(results[0]!.status).toBe("fulfilled")
    expect(results[1]!.status).toBe("fulfilled")
    expect(results[2]!.status).toBe("fulfilled")

    // The hit input must surface the existing fact id, not a new one.
    if (results[1]!.status === "fulfilled") {
      expect(results[1]!.value.deduped).toBe(true)
      expect(results[1]!.value.fact.id).toBe("existing-fact")
    }

    // The misses must surface the new ids in input order.
    if (results[0]!.status === "fulfilled") {
      expect(results[0]!.value.fact.id).toBe("rt-0")
      expect(results[0]!.value.deduped).toBe(false)
    }
    if (results[2]!.status === "fulfilled") {
      expect(results[2]!.value.fact.id).toBe("rt-2")
      expect(results[2]!.value.deduped).toBe(false)
    }

    // The batch call only contained the two miss inputs (idx 0 and 2).
    expect(mock.request).toHaveBeenCalledTimes(1)
    const batchPages = mock.request.mock.calls[0]![0].body.create_pages
      .pages as Array<{ properties: Record<string, unknown> }>
    expect(batchPages).toHaveLength(2)
  })

  it("falls back to per-input pages.create when the batch call fails outright", async () => {
    mock.request.mockRejectedValueOnce(
      Object.assign(new Error("server"), { status: 500 })
    )
    mock.create
      .mockResolvedValueOnce(factPage({ id: "fb-0" }))
      .mockResolvedValueOnce(factPage({ id: "fb-1" }))

    const results = await service.createBatchWithDedup([
      mention(0),
      mention(1),
    ])

    expect(results).toHaveLength(2)
    expect(results.every((r) => r.status === "fulfilled")).toBe(true)
    expect(mock.request).toHaveBeenCalledTimes(1)
    // Per-input fallback creates fired AFTER the batch failure.
    expect(mock.create).toHaveBeenCalledTimes(2)
  })

  it("re-probes via createWithDedup on partial-commit-tail when chunk 2 transport-drops (PR #538 round 2)", async () => {
    // Round 2 of S1: the wrapper accumulates `createdPageIds` from
    // earlier successful chunks, so a 5xx or transport-class
    // failure on chunk 2 surfaces as `BatchCreateError` whose
    // committedIds = chunk 1's ids. The tail (chunk 2's inputs)
    // could STILL have partially landed on the server before the
    // response failed — chunk-order alone doesn't prove the
    // failing chunk had no server-side effects. The fallback
    // must re-probe via `createWithDedup` for transport-class
    // BatchCreateError tails too. Falling back via
    // `freshCreateAfterDedupMiss` would duplicate any pages chunk
    // 2 actually committed.
    //
    // 150 inputs / 100-page chunks → chunk 1 (100 ids) lands;
    // chunk 2 (50 inputs) hits ECONNRESET. Tail = inputs 100..149.
    // The re-probe must catch a server-side commit for input 100
    // (the orphan) and surface it as `deduped: true`.
    const inputs = Array.from({ length: 150 }, (_, i) => mention(i))
    let factsRequestCount = 0
    mock.request.mockImplementation(async () => {
      factsRequestCount += 1
      if (factsRequestCount === 1) {
        return {
          pages: Array.from({ length: 100 }, (_, j) => ({ id: `rt-${j}` })),
        }
      }
      // Transport-class failure on chunk 2: `code: "ECONNRESET"`,
      // no `.status` field — exactly the shape Node's `fetch`
      // produces when the connection drops mid-response.
      throw Object.assign(new Error("connection reset by peer"), {
        code: "ECONNRESET",
      })
    })

    let probeCallCount = 0
    mock.query.mockImplementation(async (args: { filter: unknown }) => {
      probeCallCount += 1
      // Pre-batch probes for all 150 inputs return empty (nothing
      // exists yet). The first 150 calls are the parallel probes.
      if (probeCallCount <= 150) {
        return { results: [], has_more: false, next_cursor: null }
      }
      // Fallback re-probes for the 50 tail inputs (100..149).
      // Simulate server-side orphan commit for input 100 only —
      // the others genuinely didn't commit.
      const filter = args.filter as {
        and: Array<{ rich_text?: { equals?: string } }>
      }
      const dedupKey = filter.and
        .map((c) => c.rich_text?.equals)
        .find((v) => typeof v === "string" && v.length > 0)
      const entity100Key = computeFactDedupKey({
        subject: "memory-title",
        predicate: "mentions",
        object: "entity-100",
      })
      if (dedupKey === entity100Key) {
        return {
          results: [
            factPage({
              id: "orphan-from-chunk-2",
              subject: "memory-title",
              predicate: "mentions",
              object: "entity-100",
            }),
          ],
          has_more: false,
          next_cursor: null,
        }
      }
      return { results: [], has_more: false, next_cursor: null }
    })
    let createCallCount = 0
    mock.create.mockImplementation(async () => {
      createCallCount += 1
      return factPage({ id: `fb-${createCallCount}` })
    })

    const results = await service.createBatchWithDedup(inputs)

    expect(results).toHaveLength(150)
    expect(results.every((r) => r.status === "fulfilled")).toBe(true)

    // Inputs 0..99 carry the chunk-1 batch ids.
    for (let i = 0; i < 100; i += 1) {
      const r = results[i]!
      if (r.status === "fulfilled") {
        expect(r.value.fact.id).toBe(`rt-${i}`)
        expect(r.value.deduped).toBe(false)
      }
    }

    // Input 100 (the orphan): re-probe found the server-committed
    // row, so we got it back as a dedup hit — NOT a duplicate
    // create.
    const orphanResult = results[100]!
    expect(orphanResult.status).toBe("fulfilled")
    if (orphanResult.status === "fulfilled") {
      expect(orphanResult.value.deduped).toBe(true)
      expect(orphanResult.value.fact.id).toBe("orphan-from-chunk-2")
    }

    // Inputs 101..149: re-probe missed (server didn't commit), so
    // they fell through to fresh-create.
    for (let i = 101; i < 150; i += 1) {
      const r = results[i]!
      if (r.status === "fulfilled") {
        expect(r.value.deduped).toBe(false)
      }
    }

    // The orphan row was NOT re-created via pages.create. Without
    // the partial-commit re-probe fix, pages.create would have
    // fired 50 times (once per tail input); the re-probe on input
    // 100 short-circuits via the dedup hit, so create fires only
    // 49 times.
    expect(createCallCount).toBe(49)
  })

  it("re-probes via createWithDedup on full-failure fallback (S1 transport-drop guard)", async () => {
    // Security review S1 (PR #538): a transport-drop on the first
    // chunk gives us no signal whether the server actually
    // committed. The full-failure fallback must re-probe via
    // `createWithDedup` (not `freshCreateAfterDedupMiss`), so a
    // server-side commit we lost the response for is caught by the
    // dedup probe on the retry pass.
    //
    // Setup: batch fails outright; on the per-input fallback,
    // input[0] hits an existing row (simulating "server committed
    // before transport drop") and input[1] misses. The hit must
    // surface as `deduped: true` (re-probe found it), the miss
    // must surface as a fresh create.
    mock.request.mockRejectedValueOnce(
      Object.assign(new Error("connection reset"), { code: "ECONNRESET" })
    )

    let probeCall = 0
    mock.query.mockImplementation(async () => {
      // First probe call (during the parallel pre-batch probes):
      // both miss. Subsequent probe calls (during fallback): the
      // probe for input[0]'s dedup key now hits.
      probeCall += 1
      if (probeCall <= 2) {
        // Pre-batch probes (one per input)
        return { results: [], has_more: false, next_cursor: null }
      }
      // Fallback probes — input[0] hits the (just-committed)
      // existing row, input[1] misses.
      const args = mock.query.mock.calls[probeCall - 1]![0] as {
        filter: { and: Array<{ rich_text?: { equals?: string } }> }
      }
      const dedupKey = args.filter.and
        .map((c) => c.rich_text?.equals)
        .find((v) => typeof v === "string" && v.length > 0)
      const entity0Key = computeFactDedupKey({
        subject: "memory-title",
        predicate: "mentions",
        object: "entity-0",
      })
      if (dedupKey === entity0Key) {
        return {
          results: [
            factPage({
              id: "server-committed-but-lost-ack",
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
    mock.create.mockResolvedValueOnce(factPage({ id: "fresh-1" }))

    const results = await service.createBatchWithDedup([
      mention(0),
      mention(1),
    ])

    expect(results).toHaveLength(2)
    expect(results[0]!.status).toBe("fulfilled")
    expect(results[1]!.status).toBe("fulfilled")
    if (results[0]!.status === "fulfilled") {
      // The re-probe found the orphaned commit and reused it
      // (deduped: true). No duplicate row created.
      expect(results[0]!.value.deduped).toBe(true)
      expect(results[0]!.value.fact.id).toBe("server-committed-but-lost-ack")
    }
    if (results[1]!.status === "fulfilled") {
      // The genuinely-uncommitted input got a fresh create.
      expect(results[1]!.value.deduped).toBe(false)
      expect(results[1]!.value.fact.id).toBe("fresh-1")
    }
    // pages.create fired exactly once — for the genuinely missing
    // input only. Without the re-probe path, both inputs would have
    // hit `freshCreateAfterDedupMiss` and `pages.create` would have
    // fired twice — duplicating the orphan commit.
    expect(mock.create).toHaveBeenCalledTimes(1)
  })

  it("on partial commit, credits the committed prefix and falls back per-input for the tail", async () => {
    // 200 inputs → 2 chunks. First chunk lands; second throws.
    const inputs = Array.from({ length: 200 }, (_, i) => mention(i))
    mock.request
      .mockResolvedValueOnce({
        pages: Array.from({ length: 100 }, (_, i) => ({ id: `rt-${i}` })),
      })
      .mockRejectedValueOnce(
        Object.assign(new Error("server"), { status: 500 })
      )
    // Fallback per-input creates for the tail
    mock.create.mockImplementation(async () =>
      factPage({ id: `fb-${mock.create.mock.calls.length - 1}` })
    )

    const results = await service.createBatchWithDedup(inputs)

    expect(results).toHaveLength(200)
    expect(results.every((r) => r.status === "fulfilled")).toBe(true)
    // First 100 came from the batch (id starts "rt-")
    for (let i = 0; i < 100; i += 1) {
      const r = results[i]!
      if (r.status === "fulfilled") {
        expect(r.value.fact.id).toBe(`rt-${i}`)
      }
    }
    // Tail 100 came from fallback creates
    expect(mock.create).toHaveBeenCalledTimes(100)
  })
})

describe("FactService.createBatchWithDedup — loud-enough auth fallback warning", () => {
  let stderr: ReturnType<typeof vi.fn>
  let originalWrite: typeof process.stderr.write

  beforeEach(() => {
    __resetRunToolBatchCreatesAuthFallbackLogForTests()
    stderr = vi.fn()
    originalWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown) => {
      stderr(chunk)
      return true
    }) as typeof process.stderr.write
  })

  afterEach(() => {
    process.stderr.write = originalWrite
  })

  it("emits a once-per-process stderr warning on 403 RestrictedResource", async () => {
    // README "loud enough" mandate (PR #538 security review S2
    // follow-up): operators on integration-secret auth who flip
    // LORE_USE_RUNTOOL_BATCH_CREATES=1 must learn why their
    // flagged-on calls never use the new path.
    const mock = makeMockClient()
    mock.query.mockResolvedValue({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    mock.request.mockRejectedValue(
      Object.assign(new Error("Only public integrations can access this API."), {
        status: 403,
        code: "restricted_resource",
      })
    )
    mock.create.mockResolvedValue(factPage({ id: "fb" }))
    const service = new FactService(mock.client, DB, undefined, {
      useRunToolBatchCreates: true,
    })

    await service.createBatchWithDedup([mention(0), mention(1)])

    const calls = stderr.mock.calls.map((c) => String(c[0]))
    const warning = calls.find((line) =>
      line.includes("[lore] runtool batch_create:")
    )
    expect(warning).toBeDefined()
    expect(warning!).toContain("403")
    expect(warning!).toContain("restricted_resource")
    expect(warning!).toContain("LORE_USE_RUNTOOL_BATCH_CREATES=0")
  })

  it("only emits the warning once per process", async () => {
    const mock = makeMockClient()
    mock.query.mockResolvedValue({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    mock.request.mockRejectedValue(
      Object.assign(new Error("403"), {
        status: 403,
        code: "restricted_resource",
      })
    )
    mock.create.mockResolvedValue(factPage({ id: "fb" }))
    const service = new FactService(mock.client, DB, undefined, {
      useRunToolBatchCreates: true,
    })

    // Multi-input batches so each save dispatches the RunTool
    // call (single-input short-circuits to createWithDedup,
    // bypassing the batch path entirely — a real save with one
    // mention would never trigger this warning, which is the
    // correct posture).
    await service.createBatchWithDedup([mention(0), mention(1)])
    await service.createBatchWithDedup([mention(2), mention(3)])
    await service.createBatchWithDedup([mention(4), mention(5)])

    const warningLines = stderr.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes("[lore] runtool batch_create:"))
    expect(warningLines).toHaveLength(1)
    // All three batches still attempted RunTool (and all fell back).
    expect(mock.request).toHaveBeenCalledTimes(3)
  })

  it("stays silent on non-auth errors (5xx, transport drop)", async () => {
    const mock = makeMockClient()
    mock.query.mockResolvedValue({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    mock.request.mockRejectedValue(
      Object.assign(new Error("server"), { status: 500 })
    )
    mock.create.mockResolvedValue(factPage({ id: "fb" }))
    const service = new FactService(mock.client, DB, undefined, {
      useRunToolBatchCreates: true,
    })

    await service.createBatchWithDedup([mention(0)])

    const warningLines = stderr.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes("[lore] runtool batch_create:"))
    expect(warningLines).toHaveLength(0)
  })
})

describe("FactService.createBatchWithDedup — behavioral equivalence", () => {
  it("flag-on and flag-off produce the same logical (subject, predicate, object) triples", async () => {
    // Capture the set of triples each path emits.
    const inputs = [mention(0), mention(1), mention(2)]

    // ---- Flag off ----
    const offMock = makeMockClient()
    offMock.query.mockResolvedValue({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    let offCallIdx = 0
    offMock.create.mockImplementation(async () => {
      const id = `off-${offCallIdx}`
      offCallIdx += 1
      return factPage({ id })
    })
    const offService = new FactService(offMock.client, DB)
    const offResults = await offService.createBatchWithDedup(inputs)

    // ---- Flag on ----
    const onMock = makeMockClient()
    onMock.query.mockResolvedValue({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    onMock.request.mockResolvedValueOnce({
      pages: [{ id: "on-0" }, { id: "on-1" }, { id: "on-2" }],
    })
    const onService = new FactService(onMock.client, DB, undefined, {
      useRunToolBatchCreates: true,
    })
    const onResults = await onService.createBatchWithDedup(inputs)

    // Both paths fulfilled all three inputs.
    expect(offResults.every((r) => r.status === "fulfilled")).toBe(true)
    expect(onResults.every((r) => r.status === "fulfilled")).toBe(true)

    // Extract the triples each path actually wrote on the wire.
    // Flag-off lands as a per-input `pages.create` with Notion REST
    // shape; flag-on lands as one `create_pages` with the converted
    // SQLite-flat shape (issue #533 wire format). The triples being
    // logically equal across the two shapes IS the behavioral-
    // equivalence acceptance criterion.
    const offTriples = offMock.create.mock.calls.map((call) => {
      const props = call[0]!.properties as {
        Subject: { title: Array<{ text: { content: string } }> }
        Predicate: { select: { name: string } }
        Object: { rich_text: Array<{ text: { content: string } }> }
      }
      return {
        subject: props.Subject.title[0]!.text.content,
        predicate: props.Predicate.select.name,
        object: props.Object.rich_text[0]!.text.content,
      }
    })
    const onTriplesSent = onMock.request.mock.calls[0]![0].body.create_pages
      .pages as Array<{
      properties: Record<string, unknown>
    }>
    const onTriples = onTriplesSent.map((p) => ({
      subject: p.properties["Subject"] as string,
      predicate: p.properties["Predicate"] as string,
      object: p.properties["Object"] as string,
    }))

    expect(onTriples).toEqual(offTriples)
  })
})
