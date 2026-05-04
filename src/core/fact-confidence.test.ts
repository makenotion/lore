/**
 * Tests for the fact-side dynamic-confidence wiring (DEFERRED-02).
 *
 * Mirrors the memory-side `decay`/`confidence-migration`/`memory.touchOnRead`
 * coverage. Pinned behavior:
 *
 * - `pageToFact` reads `Confidence Score` + `Last Referenced At` and
 *   `created_time`; missing columns surface as `null` for backward
 *   compat with un-migrated vaults.
 * - `buildFactProps`'s 3-state semantics for the new columns
 *   (undefined → untouched, null → cleared, value → write).
 * - `FactService.touchOnRead` matches `MemoryService.touchOnRead`: same-
 *   day short-circuit, seed-decay-bump on null, decay-bump on stale,
 *   per-row onError isolation.
 * - `FactService.invalidate` reads + decrements + writes Valid Until
 *   atomically (one `pages.update`).
 * - `runBuildFactConfidenceScoresMigration` plan + execute, with the
 *   `confidenceScore !== null` skip rule.
 */

import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { FactService } from "./fact.js"
import { runBuildFactConfidenceScoresMigration } from "./fact-confidence-migration.js"
import { buildFactProps } from "../notion/schema.js"
import { type DatabaseRef, type Fact, type FactConfidence } from "../types.js"

const DB: DatabaseRef = {
  databaseId: "facts-db",
  dataSourceId: "facts-ds",
}

function pageWithConfidence(opts: {
  id?: string
  createdAt?: string
  confidence?: FactConfidence
  confidenceScore?: number | null
  lastReferencedAt?: string | null
  validUntil?: string | null
}): PageObjectResponse {
  const properties: Record<string, unknown> = {
    Subject: { type: "title", title: [{ plain_text: "S" }] },
    Predicate: { type: "select", select: { name: "uses" } },
    Object: { type: "rich_text", rich_text: [{ plain_text: "O" }] },
    Project: { type: "relation", relation: [] },
    "Valid From": { type: "date", date: { start: "2026-01-01" } },
    "Valid Until": {
      type: "date",
      date: opts.validUntil ? { start: opts.validUntil } : null,
    },
    "Review By": { type: "date", date: null },
    Source: { type: "relation", relation: [] },
    Confidence: {
      type: "select",
      select: { name: opts.confidence ?? "certain" },
    },
    "Confidence Score":
      opts.confidenceScore === undefined
        ? { type: "number", number: null }
        : { type: "number", number: opts.confidenceScore },
    "Last Referenced At": {
      type: "date",
      date: opts.lastReferencedAt ? { start: opts.lastReferencedAt } : null,
    },
  }
  return {
    object: "page",
    id: opts.id ?? "fact-id",
    created_time: opts.createdAt ?? "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-01-01T00:00:00.000Z",
    archived: false,
    parent: { type: "data_source_id", data_source_id: DB.dataSourceId },
    url: "https://notion.so/fact-id",
    properties: properties as unknown as PageObjectResponse["properties"],
  } as PageObjectResponse
}

type UpdateArgs = {
  page_id: string
  properties: Record<string, unknown>
}

function mkClient(
  opts: {
    retrieve?: PageObjectResponse | Error
    query?: Array<{ results: PageObjectResponse[]; has_more?: boolean }>
  } = {}
) {
  const queryResponses = opts.query ?? []
  let queryIdx = 0
  const updateSpy = vi.fn(async (_args: UpdateArgs) => ({}))
  const retrieveSpy = vi.fn(async () => {
    if (opts.retrieve instanceof Error) throw opts.retrieve
    if (opts.retrieve) return opts.retrieve
    throw new Error("retrieve not stubbed")
  })
  const querySpy = vi.fn(async () => {
    const r = queryResponses[Math.min(queryIdx, queryResponses.length - 1)] ?? {
      results: [],
    }
    queryIdx += 1
    return {
      results: r.results,
      has_more: r.has_more ?? false,
      next_cursor: null,
    }
  })
  const client = {
    pages: { update: updateSpy, retrieve: retrieveSpy, create: vi.fn() },
    dataSources: { query: querySpy },
  } as unknown as Client
  return { client, updateSpy, retrieveSpy, querySpy }
}

describe("buildFactProps — DEFERRED-02 columns", () => {
  it("omits Confidence Score and Last Referenced At when undefined", () => {
    const props = buildFactProps({
      subject: "S",
      predicate: "uses",
      object: "O",
    })
    expect(props).not.toHaveProperty("Confidence Score")
    expect(props).not.toHaveProperty("Last Referenced At")
  })

  it("clears Confidence Score on explicit null", () => {
    const props = buildFactProps({
      subject: "S",
      predicate: "uses",
      object: "O",
      confidenceScore: null,
    })
    expect(props!["Confidence Score"]).toEqual({ number: null })
  })

  it("writes a numeric Confidence Score verbatim", () => {
    const props = buildFactProps({
      subject: "S",
      predicate: "uses",
      object: "O",
      confidenceScore: 0.42,
    })
    expect(props!["Confidence Score"]).toEqual({ number: 0.42 })
  })

  it("writes a Last Referenced At date when set", () => {
    const props = buildFactProps({
      subject: "S",
      predicate: "uses",
      object: "O",
      lastReferencedAt: "2026-04-15",
    })
    expect(props!["Last Referenced At"]).toEqual({
      date: { start: "2026-04-15" },
    })
  })
})

describe("pageToFact — DEFERRED-02 columns", () => {
  it("extracts confidenceScore + lastReferencedAt + createdAt", async () => {
    const page = pageWithConfidence({
      id: "f1",
      confidenceScore: 0.7,
      lastReferencedAt: "2026-04-10",
      createdAt: "2026-01-15T12:00:00.000Z",
    })
    const { client } = mkClient({ query: [{ results: [page] }] })
    const service = new FactService(client, DB)
    const { items } = await service.listRecent({ projectId: "p1" })
    expect(items[0].confidenceScore).toBe(0.7)
    expect(items[0].lastReferencedAt).toBe("2026-04-10")
    expect(items[0].createdAt).toBe("2026-01-15T12:00:00.000Z")
  })

  it("returns null on un-migrated vaults missing the columns", async () => {
    // Mirror a pre-DEFERRED-02 row: no Confidence Score column at all,
    // no Last Referenced At column. `extractNumber` and `extractDate`
    // return null for undefined props.
    const page: PageObjectResponse = {
      object: "page",
      id: "legacy",
      created_time: "2025-01-01T00:00:00.000Z",
      last_edited_time: "2025-01-01T00:00:00.000Z",
      archived: false,
      parent: { type: "data_source_id", data_source_id: DB.dataSourceId },
      url: "https://notion.so/legacy",
      properties: {
        Subject: { type: "title", title: [{ plain_text: "S" }] },
        Predicate: { type: "select", select: { name: "uses" } },
        Object: { type: "rich_text", rich_text: [{ plain_text: "O" }] },
        Project: { type: "relation", relation: [] },
        "Valid From": { type: "date", date: { start: "2025-01-01" } },
        "Valid Until": { type: "date", date: null },
        "Review By": { type: "date", date: null },
        Source: { type: "relation", relation: [] },
        Confidence: { type: "select", select: { name: "likely" } },
      } as unknown as PageObjectResponse["properties"],
    } as PageObjectResponse
    const { client } = mkClient({ query: [{ results: [page] }] })
    const service = new FactService(client, DB)
    const { items } = await service.listRecent({ projectId: "p1" })
    expect(items[0].confidenceScore).toBeNull()
    expect(items[0].lastReferencedAt).toBeNull()
  })
})

describe("FactService.touchOnRead", () => {
  it("short-circuits when lastReferencedAt is today and score is non-null", async () => {
    const today = "2026-04-30"
    const { client, updateSpy } = mkClient()
    const service = new FactService(client, DB)
    const fact: Pick<
      Fact,
      "id" | "confidence" | "confidenceScore" | "lastReferencedAt" | "createdAt"
    > = {
      id: "f1",
      confidence: "certain",
      confidenceScore: 0.85,
      lastReferencedAt: today,
      createdAt: "2026-01-01T00:00:00.000Z",
    }
    await service.touchOnRead([fact], { today })
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("seeds + decays + bumps on a null score", async () => {
    const today = "2026-04-30"
    const { client, updateSpy } = mkClient()
    const service = new FactService(client, DB)
    await service.touchOnRead(
      [
        {
          id: "f1",
          confidence: "speculative",
          confidenceScore: null,
          lastReferencedAt: null,
          // 119 days before today; STALE_CONFIDENCE_DAYS = 60, so 59 stale days
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      { today }
    )
    expect(updateSpy).toHaveBeenCalledTimes(1)
    const args = updateSpy.mock.calls[0][0]
    expect(args.properties["Last Referenced At"]).toEqual({
      date: { start: today },
    })
    // speculative → 0.3 seed; decayed 0.3 * 0.99^59 ≈ 0.165; then bump
    // by (1 - x) * 0.05 — bumped value should land in (0.165, 0.205).
    const score = (args.properties["Confidence Score"] as { number: number }).number
    expect(score).toBeGreaterThan(0.16)
    expect(score).toBeLessThan(0.21)
  })

  it("decays + bumps on stale-but-scored", async () => {
    const today = "2026-05-01"
    const { client, updateSpy } = mkClient()
    const service = new FactService(client, DB)
    await service.touchOnRead(
      [
        {
          id: "f1",
          confidence: "certain",
          confidenceScore: 0.9,
          lastReferencedAt: "2026-01-01", // 120 days before, 60 stale days
          createdAt: "2025-09-01T00:00:00.000Z",
        },
      ],
      { today }
    )
    const args = updateSpy.mock.calls[0][0]
    const score = (args.properties["Confidence Score"] as { number: number }).number
    // 0.9 * 0.99^60 ≈ 0.491, then bump → ~0.516
    expect(score).toBeGreaterThan(0.45)
    expect(score).toBeLessThan(0.55)
  })

  it("isolates per-row failures via onError", async () => {
    const today = "2026-05-01"
    const updateSpy = vi.fn(async (args: { page_id: string }) => {
      if (args.page_id === "f-bad") throw new Error("boom")
      return {}
    })
    const client = {
      pages: { update: updateSpy, retrieve: vi.fn(), create: vi.fn() },
      dataSources: { query: vi.fn() },
    } as unknown as Client
    const service = new FactService(client, DB)
    const onError = vi.fn()
    await service.touchOnRead(
      [
        {
          id: "f-good",
          confidence: "certain",
          confidenceScore: 0.5,
          lastReferencedAt: null,
          createdAt: "2026-04-01T00:00:00.000Z",
        },
        {
          id: "f-bad",
          confidence: "certain",
          confidenceScore: 0.5,
          lastReferencedAt: null,
          createdAt: "2026-04-01T00:00:00.000Z",
        },
      ],
      { today, onError }
    )
    expect(updateSpy).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledWith("f-bad", expect.any(Error))
  })
})

describe("FactService.invalidate", () => {
  it("writes Valid Until + decremented Confidence Score + Last Referenced At in one update", async () => {
    const today = new Date().toISOString().slice(0, 10)
    const factPage = pageWithConfidence({
      id: "f1",
      confidenceScore: 0.8,
      lastReferencedAt: today,
      createdAt: "2026-04-01T00:00:00.000Z",
    })
    const { client, updateSpy, retrieveSpy } = mkClient({ retrieve: factPage })
    const service = new FactService(client, DB)
    await service.invalidate("f1")
    expect(retrieveSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy).toHaveBeenCalledTimes(1)
    const args = updateSpy.mock.calls[0][0]
    expect(args.page_id).toBe("f1")
    expect(args.properties["Valid Until"]).toEqual({
      date: { start: today },
    })
    expect(args.properties["Last Referenced At"]).toEqual({
      date: { start: today },
    })
    // 0.8 halved by DECREMENT_FACTOR = 0.5, no decay because today === lastReferencedAt
    expect(args.properties["Confidence Score"]).toEqual({ number: 0.4 })
  })

  it("falls back to a Valid Until-only write when the read fails", async () => {
    // A transient 5xx on the read shouldn't block the invalidate
    // contract — operators expect Valid Until to land regardless.
    const { client, updateSpy } = mkClient({ retrieve: new Error("transient 5xx") })
    const service = new FactService(client, DB)
    await service.invalidate("f1")
    expect(updateSpy).toHaveBeenCalledTimes(1)
    const args = updateSpy.mock.calls[0]?.[0] as {
      properties: Record<string, unknown>
    }
    expect(args.properties).toEqual({
      "Valid Until": { date: { start: expect.any(String) } },
    })
    expect(args.properties).not.toHaveProperty("Confidence Score")
  })

  it("short-circuits without any pages.update when the row is archived (issue #497)", async () => {
    // Notion accepts `pages.update` against archived pages, so
    // without this gate an invalidate call against an already-
    // archived row would write `Valid Until = today` onto a row
    // already excluded from active queries — leaving an audit-
    // visible contradictory `archived: true` plus
    // `Valid Until: <date>` combination. Pin the no-write contract
    // so a future refactor that drops the archived guard fails
    // loudly rather than silently corrupting audits.
    const archivedPage: PageObjectResponse = {
      ...pageWithConfidence({
        id: "f-archived",
        confidenceScore: 0.8,
        lastReferencedAt: "2026-04-01",
        createdAt: "2026-04-01T00:00:00.000Z",
      }),
      archived: true,
    }
    const { client, updateSpy, retrieveSpy } = mkClient({ retrieve: archivedPage })
    const service = new FactService(client, DB)

    await service.invalidate("f-archived")

    expect(retrieveSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("retries with Valid Until-only write when the schema is missing the Confidence Score column", async () => {
    // Pre-DEFERRED-02 vault that hasn't run `lore migrate`: the
    // schema has no `Confidence Score` / `Last Referenced At`
    // columns, so writing all three would 400 on
    // `validation_error: Could not find property "Confidence Score"`.
    // The helper detects the missing-property error and re-issues a
    // bare `Valid Until` write so legacy vaults can still
    // invalidate. Pin the recovery so a future refactor that drops
    // the catch silently breaks legacy vaults.
    const today = new Date().toISOString().slice(0, 10)
    const factPage = pageWithConfidence({
      id: "f1",
      confidenceScore: 0.8,
      lastReferencedAt: today,
      createdAt: "2026-04-01T00:00:00.000Z",
    })
    let updateCount = 0
    const updateSpy = vi.fn(async (_args: UpdateArgs) => {
      updateCount += 1
      if (updateCount === 1) {
        // Notion's missing-property error shape, mirroring what
        // `isMissingPropertyError` recognizes: status 400, code
        // `validation_error`, body mentions the missing property.
        const err = new Error(
          'Could not find property with name or id: "Confidence Score"'
        ) as Error & {
          status?: number
          code?: string
          body?: { code?: string }
        }
        err.status = 400
        err.code = "validation_error"
        err.body = { code: "validation_error" }
        throw err
      }
      return {}
    })
    const retrieveSpy = vi.fn(async () => factPage)
    const client = {
      pages: { update: updateSpy, retrieve: retrieveSpy, create: vi.fn() },
      dataSources: { query: vi.fn() },
    } as unknown as Client
    const service = new FactService(client, DB)
    await service.invalidate("f1")

    // Two pages.update calls: the first attempts all three columns
    // and 400s; the second writes Valid Until alone.
    expect(updateSpy).toHaveBeenCalledTimes(2)
    const recoveryArgs = updateSpy.mock.calls[1][0]
    expect(recoveryArgs.properties).toEqual({
      "Valid Until": { date: { start: expect.any(String) } },
    })
  })
})

describe("FactService internal createdAt invariant (DEFERRED-02)", () => {
  // `Fact.createdAt` is typed optional on the public boundary so
  // external consumers building `Fact`-shaped object literals don't
  // break. Internal helpers rely on the runtime guarantee that
  // `pageToFact` always populates the field. Pin the loud-throw
  // contract so a future regression that lets a partial `Fact` reach
  // an internal helper surfaces with a meaningful message rather
  // than a generic `Cannot read properties of undefined`.

  it("touchOnRead throws a named error when createdAt is missing on a null-score fact", async () => {
    const today = "2026-04-30"
    const { client } = mkClient()
    const service = new FactService(client, DB)
    const onError = vi.fn()
    // The seed-decay branch fires only on null score, which is the
    // path that reads createdAt. A non-null score skips the branch
    // and never touches createdAt — the invariant doesn't matter
    // there. Build the fact without createdAt so the helper throws.
    const partial = {
      id: "f-partial",
      confidence: "certain" as FactConfidence,
      confidenceScore: null,
      lastReferencedAt: null,
      // createdAt deliberately absent
    }
    await service.touchOnRead([partial], { today, onError })
    // touchOnRead routes the throw through `onError`, so the test
    // verifies the named-error message lands there rather than
    // bubbling up.
    expect(onError).toHaveBeenCalledWith(
      "f-partial",
      expect.objectContaining({
        message: expect.stringContaining(
          "FactService.touchOnRead: Fact.createdAt is unexpectedly undefined"
        ),
      })
    )
  })

  it("invalidate throws a named error when createdAt is missing on a null-score fact", async () => {
    // Construct a Fact whose pageToFact-derived row has no
    // `created_time` (a degenerate fixture, NOT a real Notion
    // shape). The retrieve returns a malformed page where the
    // resulting Fact carries no createdAt. The invalidate path
    // reads createdAt only on the null-score seed branch, so set
    // confidenceScore to null to force that branch.
    const malformedPage: PageObjectResponse = {
      object: "page",
      id: "f-no-created",
      // Empty string forces `pageToFact` to write `createdAt: ""` —
      // which is truthy. Use the `createdAt: undefined` path
      // instead by tampering after the fact below.
      created_time: "2026-04-01T00:00:00.000Z",
      last_edited_time: "2026-04-01T00:00:00.000Z",
      archived: false,
      parent: { type: "data_source_id", data_source_id: DB.dataSourceId },
      url: "https://notion.so/f-no-created",
      properties: {
        Subject: { type: "title", title: [{ plain_text: "S" }] },
        Predicate: { type: "select", select: { name: "uses" } },
        Object: { type: "rich_text", rich_text: [{ plain_text: "O" }] },
        Project: { type: "relation", relation: [] },
        "Valid From": { type: "date", date: { start: "2026-04-01" } },
        "Valid Until": { type: "date", date: null },
        "Review By": { type: "date", date: null },
        Source: { type: "relation", relation: [] },
        Confidence: { type: "select", select: { name: "certain" } },
        "Confidence Score": { type: "number", number: null },
        "Last Referenced At": { type: "date", date: null },
      } as unknown as PageObjectResponse["properties"],
    } as PageObjectResponse

    // Wrap the retrieve so the deserialized Fact's `createdAt` is
    // unset — bypassing pageToFact's normal population. Two-step:
    // retrieve returns the malformed page; then we patch the
    // service's `pageToFact` method (TypeScript-private but runtime-
    // accessible) to strip createdAt before invalidate's internal
    // helper reads it. `invalidate` calls `pageToFact` directly
    // (issue #497 refactor; previously it routed through `getById`),
    // so this is the right monkey-patch surface for the invariant.
    const { client } = mkClient({ retrieve: malformedPage })
    const service = new FactService(client, DB)
    // Override `pageToFact` via prototype patch to return a Fact
    // missing createdAt — this directly exercises the helper's
    // throw rather than relying on pageToFact's contract.
    const internal = service as unknown as {
      pageToFact: (page: PageObjectResponse) => Promise<Fact | null>
    }
    const original = internal.pageToFact.bind(service)
    internal.pageToFact = async (page) => {
      const fact = await original(page)
      if (fact !== null) {
        // Strip createdAt to simulate a partial Fact reaching the
        // internal helper. This is the failure mode the helper
        // exists to surface clearly.
        return { ...fact, createdAt: undefined }
      }
      return fact
    }

    await expect(service.invalidate("f-no-created")).rejects.toThrow(
      /FactService\.invalidate: Fact\.createdAt is unexpectedly undefined/
    )
  })
})

describe("runBuildFactConfidenceScoresMigration", () => {
  function mkServices(facts: Fact[]) {
    const applySpy = vi.fn(async () => {})
    const findByNameSpy = vi.fn(async () => null)
    const listSpy = vi.fn(async function* (_opts?: { projectId?: string }) {
      for (const f of facts) yield f
    })
    return {
      services: {
        config: { notion: {} },
        projects: {
          findByName: findByNameSpy,
        },
        facts: {
          listAllForBackfill: listSpy,
          applyBackfillScore: applySpy,
        },
      } as unknown as Parameters<
        typeof runBuildFactConfidenceScoresMigration
      >[0]["services"],
      applySpy,
      findByNameSpy,
      listSpy,
    }
  }

  it("plans + executes only unscored facts", async () => {
    const facts: Fact[] = [
      {
        id: "scored",
        subject: "S1",
        predicate: "uses",
        object: "O1",
        projectIds: [],
        validFrom: "2026-01-01",
        validUntil: null,
        reviewBy: null,
        sourceMemoryId: null,
        confidence: "certain",
        confidenceScore: 0.9, // already scored — should be skipped
        lastReferencedAt: "2026-04-01",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "unscored",
        subject: "S2",
        predicate: "uses",
        object: "O2",
        projectIds: [],
        validFrom: "2026-01-01",
        validUntil: null,
        reviewBy: null,
        sourceMemoryId: null,
        confidence: "likely",
        confidenceScore: null, // pre-DEFERRED-02 — needs seeding
        lastReferencedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]
    const { services, applySpy } = mkServices(facts)
    const result = await runBuildFactConfidenceScoresMigration({
      services,
      apply: true,
      dryRun: false,
    })
    expect(result.plan.totalFactsScanned).toBe(2)
    expect(result.plan.rowsAlreadyScored).toBe(1)
    expect(result.plan.rowsToSeed).toHaveLength(1)
    expect(result.plan.rowsToSeed[0].factId).toBe("unscored")
    expect(result.plan.rowsToSeed[0].fromConfidence).toBe("likely")
    // likely seeds at 0.6; createdAt is on today-? days before the test
    // run. We just confirm the seed math landed on the row.
    expect(result.plan.rowsToSeed[0].seededScore).toBe(0.6)
    expect(applySpy).toHaveBeenCalledTimes(1)
    expect(result.written).toBe(1)
  })

  it("dry-run skips writes", async () => {
    const facts: Fact[] = [
      {
        id: "unscored",
        subject: "S",
        predicate: "uses",
        object: "O",
        projectIds: [],
        validFrom: "2026-01-01",
        validUntil: null,
        reviewBy: null,
        sourceMemoryId: null,
        confidence: "speculative",
        confidenceScore: null,
        lastReferencedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]
    const { services, applySpy } = mkServices(facts)
    const result = await runBuildFactConfidenceScoresMigration({
      services,
      apply: false,
      dryRun: true,
    })
    expect(result.plan.rowsToSeed).toHaveLength(1)
    expect(applySpy).not.toHaveBeenCalled()
    expect(result.written).toBe(0)
  })

  it("aborts on unknown --project name", async () => {
    const { services } = mkServices([])
    await expect(
      runBuildFactConfidenceScoresMigration({
        services,
        apply: true,
        dryRun: false,
        projectName: "nonexistent",
      })
    ).rejects.toThrow(/Project "nonexistent" could not be resolved/)
  })

  it("uses a pre-resolved projectId without looking up projectName again", async () => {
    const { services, findByNameSpy, listSpy } = mkServices([])
    await runBuildFactConfidenceScoresMigration({
      services,
      apply: false,
      dryRun: false,
      projectName: "Archive",
      projectId: "project-archive",
    })

    expect(findByNameSpy).not.toHaveBeenCalled()
    expect(listSpy).toHaveBeenCalledWith({ projectId: "project-archive" })
  })
})
