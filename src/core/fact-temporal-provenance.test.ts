/**
 * Tests for temporal-provenance wiring (issue #284).
 *
 * Pinned behavior:
 *
 * - `buildFactProps` writes `Observed At` / `Invalidated At` /
 *   `Invalidated By` columns with the same tristate semantics as
 *   pre-existing date/relation columns.
 * - `FactService.create` (via `createWithDedup`) seeds `Observed At`
 *   to today at the write boundary.
 * - `FactService.invalidate` writes `Invalidated At` alongside
 *   `Valid Until` in a single atomic update, and threads
 *   `sourceMemoryId` into `Invalidated By` when the caller provides it.
 * - `pageToFact` extracts the three new columns into the `Fact` type.
 * - `FactService.queryByEntity` threads `asOf` and `includeInvalidated`
 *   into the underlying server-side filter; the asOf filter pair
 *   includes the `is_empty` short-circuits so pre-migration rows
 *   remain visible during the backfill rollout window.
 * - `runBackfillFactObservedAtMigration` plans + executes the
 *   transaction-time backfill with the per-axis skip rule.
 */

import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import {
  FactService,
  __resetFactCreateMissingColumnWarningForTests,
  __resetInvalidateMissingColumnWarningForTests,
} from "./fact.js"
import { runBackfillFactObservedAtMigration } from "./fact-observed-at-migration.js"
import { buildFactProps, FACT_PROPS, factsProperties } from "../notion/schema.js"
import { type DatabaseRef, type Fact } from "../types.js"

const DB: DatabaseRef = {
  databaseId: "facts-db",
  dataSourceId: "facts-ds",
}

function factPage(opts: {
  id?: string
  observedAt?: string | null
  invalidatedAt?: string | null
  validUntil?: string | null
  invalidatedById?: string | null
  createdAt?: string
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
    "Observed At": {
      type: "date",
      date: opts.observedAt ? { start: opts.observedAt } : null,
    },
    "Invalidated At": {
      type: "date",
      date: opts.invalidatedAt ? { start: opts.invalidatedAt } : null,
    },
    "Invalidated By": {
      type: "relation",
      relation: opts.invalidatedById ? [{ id: opts.invalidatedById }] : [],
    },
    "Review By": { type: "date", date: null },
    Source: { type: "relation", relation: [] },
    Confidence: { type: "select", select: { name: "certain" } },
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

type UpdateArgs = { page_id: string; properties: Record<string, unknown> }

function mkClient(
  opts: {
    retrieve?: PageObjectResponse | Error
    create?: PageObjectResponse
    queries?: Array<{ results: PageObjectResponse[]; has_more?: boolean }>
  } = {}
) {
  const updateSpy = vi.fn(async (_args: UpdateArgs) => ({}))
  const retrieveSpy = vi.fn(async () => {
    if (opts.retrieve instanceof Error) throw opts.retrieve
    if (opts.retrieve) return opts.retrieve
    throw new Error("retrieve not stubbed")
  })
  const createSpy = vi.fn(
    async (_args: { properties: Record<string, unknown> }) => opts.create ?? factPage({})
  )
  const queries = opts.queries ?? []
  let qi = 0
  const querySpy = vi.fn(async (_args: { filter?: unknown; data_source_id?: string }) => {
    const r = queries[Math.min(qi, queries.length - 1)] ?? { results: [] }
    qi += 1
    return { results: r.results, has_more: r.has_more ?? false, next_cursor: null }
  })
  const client = {
    pages: { update: updateSpy, retrieve: retrieveSpy, create: createSpy },
    dataSources: { query: querySpy },
  } as unknown as Client
  return { client, updateSpy, retrieveSpy, createSpy, querySpy }
}

describe("Schema — issue #284 columns", () => {
  it("FACT_PROPS exposes Observed At, Invalidated At, and Invalidated By", () => {
    expect(FACT_PROPS.OBSERVED_AT).toBe("Observed At")
    expect(FACT_PROPS.INVALIDATED_AT).toBe("Invalidated At")
    expect(FACT_PROPS.INVALIDATED_BY).toBe("Invalidated By")
  })

  it("factsProperties registers each new column with the expected shape", () => {
    const props = factsProperties("p-ds", "m-ds", "e-ds") as Record<string, unknown>
    expect(props[FACT_PROPS.OBSERVED_AT]).toEqual({ date: {} })
    expect(props[FACT_PROPS.INVALIDATED_AT]).toEqual({ date: {} })
    expect(props[FACT_PROPS.INVALIDATED_BY]).toMatchObject({
      relation: {
        single_property: {},
        data_source_id: "m-ds",
      },
    })
  })
})

describe("buildFactProps — issue #284 tristate semantics", () => {
  it("omits the columns when undefined", () => {
    const out = buildFactProps({ subject: "S", predicate: "uses", object: "O" })
    expect(out).not.toHaveProperty("Observed At")
    expect(out).not.toHaveProperty("Invalidated At")
    expect(out).not.toHaveProperty("Invalidated By")
  })

  it("clears Observed At / Invalidated At on explicit null", () => {
    const out = buildFactProps({
      subject: "S",
      predicate: "uses",
      object: "O",
      observedAt: null,
      invalidatedAt: null,
    })
    expect(out!["Observed At"]).toEqual({ date: null })
    expect(out!["Invalidated At"]).toEqual({ date: null })
  })

  it("writes the dates when given a value", () => {
    const out = buildFactProps({
      subject: "S",
      predicate: "uses",
      object: "O",
      observedAt: "2026-05-12",
      invalidatedAt: "2026-06-01",
      invalidatedBySourceMemoryId: "mem-9",
    })
    expect(out!["Observed At"]).toEqual({ date: { start: "2026-05-12" } })
    expect(out!["Invalidated At"]).toEqual({ date: { start: "2026-06-01" } })
    expect(out!["Invalidated By"]).toEqual({ relation: [{ id: "mem-9" }] })
  })
})

describe("FactService.invalidate — issue #284 transaction-time provenance", () => {
  it("writes Invalidated At alongside Valid Until in a single update", async () => {
    const today = new Date().toISOString().slice(0, 10)
    const page = factPage({
      id: "f1",
      observedAt: "2026-01-01",
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    const { client, updateSpy } = mkClient({ retrieve: page })
    const service = new FactService(client, DB)

    await service.invalidate("f1")

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const args = updateSpy.mock.calls[0]![0]
    expect(args.page_id).toBe("f1")
    expect(args.properties["Valid Until"]).toEqual({ date: { start: today } })
    expect(args.properties["Invalidated At"]).toEqual({ date: { start: today } })
    // No sourceMemoryId passed, so Invalidated By stays empty (not written).
    expect(args.properties).not.toHaveProperty("Invalidated By")
  })

  it("writes Invalidated By relation when sourceMemoryId is provided", async () => {
    const today = new Date().toISOString().slice(0, 10)
    const page = factPage({
      id: "f1",
      observedAt: "2026-01-01",
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    const { client, updateSpy } = mkClient({ retrieve: page })
    const service = new FactService(client, DB)

    await service.invalidate("f1", { sourceMemoryId: "mem-contradiction" })

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const args = updateSpy.mock.calls[0]![0]
    expect(args.properties["Invalidated At"]).toEqual({ date: { start: today } })
    expect(args.properties["Invalidated By"]).toEqual({
      relation: [{ id: "mem-contradiction" }],
    })
    expect(args.properties["Valid Until"]).toEqual({ date: { start: today } })
  })

  it("surgically drops only the missing column on legacy-vault retry (issue #284 review item #5)", async () => {
    // Principal-review fix: parse the failing property name and drop
    // ONLY that column instead of falling back to a bare Valid-Until
    // write that silently drops every recently-added column. A vault
    // missing `Invalidated At` but with `Invalidated By` AND the
    // DEFERRED-02 columns should keep all the writes its schema does
    // support.
    __resetInvalidateMissingColumnWarningForTests()
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const page = factPage({
        id: "f1",
        observedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      let updateCount = 0
      const updateSpy = vi.fn(async (_args: UpdateArgs) => {
        updateCount += 1
        if (updateCount === 1) {
          const err = new Error(
            'Could not find property with name or id: "Invalidated At"'
          ) as Error & { status?: number; code?: string; body?: { code?: string } }
          err.status = 400
          err.code = "validation_error"
          err.body = { code: "validation_error" }
          throw err
        }
        return {}
      })
      const client = {
        pages: {
          update: updateSpy,
          retrieve: vi.fn(async () => page),
          create: vi.fn(),
        },
        dataSources: { query: vi.fn() },
      } as unknown as Client
      const service = new FactService(client, DB)

      await service.invalidate("f1")

      expect(updateSpy).toHaveBeenCalledTimes(2)
      const recoveryArgs = updateSpy.mock.calls[1]![0] as {
        properties: Record<string, unknown>
      }
      // The recovery payload keeps Valid Until AND every other
      // column the vault DOES support (Confidence Score / Last
      // Referenced At, since the fact had a confidence value).
      // It drops only the parsed-missing column.
      expect(recoveryArgs.properties).not.toHaveProperty("Invalidated At")
      expect(recoveryArgs.properties).toHaveProperty("Valid Until")
      // Operator-visible warning fired with the surgical-drop hint.
      const stderrText = stderrSpy.mock.calls.map((c) => c[0]).join("")
      expect(stderrText).toContain("Invalidated At")
      expect(stderrText).toContain("--backfill-fact-observed-at")
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it("surgically drops the column on Pattern 2 SDK message shape (issue #284 R3-A)", async () => {
    // R3-A regression: previously the Pattern 2 regex captured
    // `"property Invalidated At"` (with leading `property` token),
    // failed the `propertyName in properties` guard, and the
    // invalidate retry degraded to a bare-Valid-Until write —
    // dropping every column the schema DID support. With the
    // non-capturing `property\s+` prefix the bare name `Invalidated
    // At` matches FACT_PROPS verbatim and the surgical drop fires.
    __resetInvalidateMissingColumnWarningForTests()
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const page = factPage({
        id: "f1",
        observedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      let updateCount = 0
      const updateSpy = vi.fn(async (_args: UpdateArgs) => {
        updateCount += 1
        if (updateCount === 1) {
          const err = new Error(
            "property Invalidated At does not exist on this database"
          ) as Error & { status?: number; code?: string; body?: { code?: string } }
          err.status = 400
          err.code = "validation_error"
          err.body = { code: "validation_error" }
          throw err
        }
        return {}
      })
      const client = {
        pages: {
          update: updateSpy,
          retrieve: vi.fn(async () => page),
          create: vi.fn(),
        },
        dataSources: { query: vi.fn() },
      } as unknown as Client
      const service = new FactService(client, DB)

      await service.invalidate("f1")

      expect(updateSpy).toHaveBeenCalledTimes(2)
      const recoveryArgs = updateSpy.mock.calls[1]![0] as {
        properties: Record<string, unknown>
      }
      // Surgical drop: only `Invalidated At` removed; every other
      // column survives (NOT the bare-Valid-Until degraded path).
      expect(recoveryArgs.properties).not.toHaveProperty("Invalidated At")
      expect(recoveryArgs.properties).toHaveProperty("Valid Until")
      expect(recoveryArgs.properties).toHaveProperty("Confidence Score")
      // Stderr warning hint names the canonical column (no
      // `property ` prefix in the operator-visible string).
      const stderrText = stderrSpy.mock.calls.map((c) => c[0]).join("")
      expect(stderrText).toContain("`Invalidated At`")
      expect(stderrText).not.toContain("`property Invalidated At`")
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it("guarantees a Valid Until write after four sequential missing-property drops (R5 blocker)", async () => {
    // R5 reviewer-flagged: my off-by-one fix (`<= → <` on
    // MAX_DROP_ATTEMPTS) introduced a silent-success bug. On a
    // maximally-stale vault missing all four optional columns
    // (Invalidated At, Invalidated By, Confidence Score, Last
    // Referenced At), the loop ran exactly 4 iterations — each one
    // parsed a missing-property error and dropped a column — and
    // then EXITED without issuing the final retry with the trimmed
    // payload. The invalidate contract (`Valid Until = today` must
    // land) was silently broken. The fix restores the +1 trailing
    // iteration AND adds a post-loop bare-Valid-Until guard as
    // defense in depth.
    __resetInvalidateMissingColumnWarningForTests()
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      // Fact carries a sourceMemoryId so the read produces a full
      // Fact shape and the invalidate path writes Confidence Score
      // + Last Referenced At alongside Invalidated At and Invalidated By.
      const page = factPage({
        id: "f1",
        observedAt: "2026-01-01",
        invalidatedAt: null,
        validUntil: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      ;(
        page.properties as Record<
          string,
          { type: string; relation: Array<{ id: string }> }
        >
      ).Source = { type: "relation", relation: [{ id: "mem-src" }] }
      const missingSequence = [
        "Invalidated At",
        "Invalidated By",
        "Confidence Score",
        "Last Referenced At",
      ]
      let updateCount = 0
      const updateSpy = vi.fn(async (args: UpdateArgs) => {
        // Iterations 0..3: reject with the corresponding missing
        // column. Iteration 4: trimmed payload — the final retry.
        // The test asserts iteration 4 contains `Valid Until` and
        // succeeds, NOT that the function silently returns.
        if (updateCount < missingSequence.length) {
          const colName = missingSequence[updateCount]!
          updateCount += 1
          const err = new Error(
            `Could not find property with name or id: "${colName}"`
          ) as Error & { status?: number; code?: string; body?: { code?: string } }
          err.status = 400
          err.code = "validation_error"
          err.body = { code: "validation_error" }
          throw err
        }
        updateCount += 1
        // Final retry must carry Valid Until — the load-bearing
        // invalidate signal. Other columns are gone by this point.
        expect(args.properties).toHaveProperty("Valid Until")
        return {}
      })
      const client = {
        pages: {
          update: updateSpy,
          retrieve: vi.fn(async () => page),
          create: vi.fn(),
        },
        dataSources: { query: vi.fn() },
      } as unknown as Client
      const service = new FactService(client, DB)

      // Pass sourceMemoryId so the invalidate payload also includes
      // Invalidated By — that gives the loop 4 optional columns to
      // drop (Invalidated At + Invalidated By + Confidence Score +
      // Last Referenced At), exercising the full MAX_OPTIONAL_DROPS
      // + 1 budget that the R5 blocker fix restored.
      await service.invalidate("f1", { sourceMemoryId: "mem-invalidator" })

      // Five pages.update calls: four rejections (one per missing
      // column drop) and one final successful retry.
      expect(updateSpy).toHaveBeenCalledTimes(5)
      const finalArgs = updateSpy.mock.calls[4]![0] as {
        properties: Record<string, unknown>
      }
      // The invalidate contract held: Valid Until landed in the
      // final write.
      expect(finalArgs.properties).toHaveProperty("Valid Until")
      // None of the dropped columns are in the final write.
      for (const dropped of missingSequence) {
        expect(finalArgs.properties).not.toHaveProperty(dropped)
      }
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it("falls back to bare Valid Until write when the property name can't be parsed", async () => {
    // Defensive path: an unrecognized validation_error shape (a SDK
    // message change) keeps the pre-fix bare-Valid-Until recovery so
    // the invalidate contract still lands. Operators see an
    // "<unparsed>" warning so the silent-degrade is visible.
    __resetInvalidateMissingColumnWarningForTests()
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const page = factPage({
        id: "f1",
        observedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      let updateCount = 0
      const updateSpy = vi.fn(async (_args: UpdateArgs) => {
        updateCount += 1
        if (updateCount === 1) {
          // Passes isMissingPropertyError (`property` + `does not
          // exist`) but the column name follows an SDK-message-shape
          // change that the parser doesn't recognize.
          const err = new Error(
            "Some new property does not exist <bizarre message shape>"
          ) as Error & { status?: number; code?: string; body?: { code?: string } }
          err.status = 400
          err.code = "validation_error"
          err.body = { code: "validation_error" }
          throw err
        }
        return {}
      })
      const client = {
        pages: {
          update: updateSpy,
          retrieve: vi.fn(async () => page),
          create: vi.fn(),
        },
        dataSources: { query: vi.fn() },
      } as unknown as Client
      const service = new FactService(client, DB)

      await service.invalidate("f1")

      expect(updateSpy).toHaveBeenCalledTimes(2)
      const recoveryArgs = updateSpy.mock.calls[1]![0] as {
        properties: Record<string, unknown>
      }
      expect(recoveryArgs.properties).toEqual({
        "Valid Until": { date: { start: expect.any(String) } },
      })
    } finally {
      stderrSpy.mockRestore()
    }
  })
})

describe("FactService.createWithDedup — issue #284 seeds Observed At", () => {
  it("writes Observed At = today on a fresh create", async () => {
    const today = new Date().toISOString().slice(0, 10)
    const createdPage = factPage({ id: "fresh", observedAt: today })
    const { client, createSpy } = mkClient({
      queries: [{ results: [] }], // empty dedup probe
      create: createdPage,
    })
    const service = new FactService(client, DB)

    const result = await service.createWithDedup({
      subject: "AuthMiddleware",
      predicate: "uses",
      object: "JWT",
    })

    expect(result.deduped).toBe(false)
    expect(createSpy).toHaveBeenCalledTimes(1)
    const createArgs = createSpy.mock.calls[0]![0]
    expect(createArgs.properties["Observed At"]).toEqual({
      date: { start: today },
    })
  })

  it("surgically drops Observed At on stale-schema vaults and lets the create land (issue #284 review item #7)", async () => {
    // Principal-review blocker: a vault that pulled the new code but
    // hasn't run `lore migrate` yet rejects `pages.create` with a
    // `validation_error` because `Observed At` isn't in the schema.
    // Pre-fix, every `lore-fact action='create'` failed until the
    // operator manually migrated. The surgical-drop retry parses the
    // failing property name, removes it from the payload, and
    // re-attempts — same shape `invalidate` uses on the partially-
    // migrated failure class.
    __resetFactCreateMissingColumnWarningForTests()
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const createdPage = factPage({ id: "fresh-legacy" })
      // Capture each attempt's properties snapshot — the retry loop
      // mutates the payload in place by design, so a spy that just
      // holds a reference would see the same final shape on every call.
      const attempts: Array<Record<string, unknown>> = []
      let attempt = 0
      const createSpy = vi.fn(async (args: { properties: Record<string, unknown> }) => {
        attempts.push({ ...args.properties })
        attempt += 1
        if (attempt === 1) {
          const err = new Error(
            'Could not find property with name or id: "Observed At"'
          ) as Error & { status?: number; code?: string; body?: { code?: string } }
          err.status = 400
          err.code = "validation_error"
          err.body = { code: "validation_error" }
          throw err
        }
        return createdPage
      })
      // Empty dedup-probe query so the path falls through to fresh-create.
      const querySpy = vi.fn(async () => ({
        results: [],
        has_more: false,
        next_cursor: null,
      }))
      const client = {
        pages: {
          create: createSpy,
          retrieve: vi.fn(async () => createdPage),
          update: vi.fn(),
        },
        dataSources: { query: querySpy },
      } as unknown as Client
      const service = new FactService(client, DB)

      const result = await service.createWithDedup({
        subject: "AuthMiddleware",
        predicate: "uses",
        object: "JWT",
      })

      // Two create attempts: the first 400s on missing Observed At;
      // the second drops the column from the payload and lands.
      expect(createSpy).toHaveBeenCalledTimes(2)
      expect(attempts[0]).toHaveProperty("Observed At")
      expect(attempts[1]).not.toHaveProperty("Observed At")
      // Other load-bearing columns (Subject, Predicate, Object, DedupKey)
      // survive the drop — only the parsed-missing column is removed.
      expect(attempts[1]).toHaveProperty("Subject")
      expect(attempts[1]).toHaveProperty("DedupKey")
      // The fact landed.
      expect(result.deduped).toBe(false)
      expect(result.fact.id).toBe("fresh-legacy")
      // Operator-visible warning fired with the right hint.
      const stderrText = stderrSpy.mock.calls.map((c) => c[0]).join("")
      expect(stderrText).toContain("Observed At")
      expect(stderrText).toContain("lore migrate")
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it("surgically drops Observed At on Pattern 2 SDK message shape during create (issue #284 R3-A)", async () => {
    // Same R3-A regression on the create-path retry: Pattern 2 with
    // a leading `property` token must strip to the bare name so the
    // surgical drop fires. Pre-fix, this propagated a raw 400 (no
    // bare-fallback for create), blocking every `lore-fact
    // action='create'` write on a partially-migrated vault.
    __resetFactCreateMissingColumnWarningForTests()
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const createdPage = factPage({ id: "fresh-pattern2" })
      const attempts: Array<Record<string, unknown>> = []
      let attempt = 0
      const createSpy = vi.fn(async (args: { properties: Record<string, unknown> }) => {
        attempts.push({ ...args.properties })
        attempt += 1
        if (attempt === 1) {
          const err = new Error(
            "property Observed At does not exist on this database"
          ) as Error & { status?: number; code?: string; body?: { code?: string } }
          err.status = 400
          err.code = "validation_error"
          err.body = { code: "validation_error" }
          throw err
        }
        return createdPage
      })
      const querySpy = vi.fn(async () => ({
        results: [],
        has_more: false,
        next_cursor: null,
      }))
      const client = {
        pages: {
          create: createSpy,
          retrieve: vi.fn(async () => createdPage),
          update: vi.fn(),
        },
        dataSources: { query: querySpy },
      } as unknown as Client
      const service = new FactService(client, DB)

      const result = await service.createWithDedup({
        subject: "AuthMiddleware",
        predicate: "uses",
        object: "JWT",
      })

      // Two attempts: first 400s on Pattern 2 shape; second drops the
      // parsed bare-name column and lands the fact.
      expect(createSpy).toHaveBeenCalledTimes(2)
      expect(attempts[0]).toHaveProperty("Observed At")
      expect(attempts[1]).not.toHaveProperty("Observed At")
      expect(attempts[1]).toHaveProperty("DedupKey")
      expect(result.fact.id).toBe("fresh-pattern2")
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it("propagates unparseable validation errors instead of silently dropping load-bearing columns", async () => {
    // Defensive contract: when the SDK message shape changes and the
    // parser can't extract the failing column, we propagate the error.
    // Unlike invalidate (which has a bare-Valid-Until fallback),
    // create has no minimum-viable degraded write — silently dropping
    // every optional column would land a row missing the dedup key,
    // breaking the dedup contract.
    __resetFactCreateMissingColumnWarningForTests()
    const createSpy = vi.fn(async () => {
      const err = new Error("validation_error with bizarre shape") as Error & {
        status?: number
        code?: string
        body?: { code?: string }
      }
      err.status = 400
      err.code = "validation_error"
      err.body = { code: "validation_error" }
      throw err
    })
    const querySpy = vi.fn(async () => ({
      results: [],
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      pages: { create: createSpy, retrieve: vi.fn(), update: vi.fn() },
      dataSources: { query: querySpy },
    } as unknown as Client
    const service = new FactService(client, DB)

    await expect(
      service.createWithDedup({
        subject: "S",
        predicate: "uses",
        object: "O",
      })
    ).rejects.toThrow(/validation_error/)
  })
})

describe("pageToFact — issue #284 extracts new columns", () => {
  it("populates observedAt / invalidatedAt / invalidatedBySourceMemoryId", async () => {
    const page = factPage({
      id: "f1",
      observedAt: "2026-04-15",
      invalidatedAt: "2026-05-01",
      invalidatedById: "mem-7",
      validUntil: "2026-05-01",
    })
    const { client } = mkClient({ retrieve: page })
    const service = new FactService(client, DB)

    const fact = await service.getById("f1")

    expect(fact).not.toBeNull()
    expect(fact!.observedAt).toBe("2026-04-15")
    expect(fact!.invalidatedAt).toBe("2026-05-01")
    expect(fact!.invalidatedBySourceMemoryId).toBe("mem-7")
  })

  it("returns null observedAt / invalidatedAt for pre-migration rows", async () => {
    const page = factPage({ id: "f-legacy" })
    const { client } = mkClient({ retrieve: page })
    const service = new FactService(client, DB)

    const fact = await service.getById("f-legacy")

    expect(fact).not.toBeNull()
    expect(fact!.observedAt).toBeNull()
    expect(fact!.invalidatedAt).toBeNull()
    expect(fact!.invalidatedBySourceMemoryId).toBeNull()
  })
})

describe("FactService.queryByEntity — issue #284 asOf filter", () => {
  it("threads asOf into the server-side filter as an AND of two transaction-time clauses with is_empty short-circuits", async () => {
    const { client, querySpy } = mkClient({ queries: [{ results: [] }] })
    const service = new FactService(client, DB)

    await service.queryByEntity("Auth", {
      entityId: "ent-1",
      asOf: "2026-04-01",
    })

    // Each branch (relation-id + unmigrated-text) issues a query — but
    // they both apply the same asOf clauses. We assert on the first
    // call's filter shape.
    const args = querySpy.mock.calls[0]![0]
    const filter = args.filter as { and: Array<Record<string, unknown>> }
    expect(filter).toHaveProperty("and")

    // Observed At clause: empty OR on_or_before asOf.
    const flat = JSON.stringify(filter)
    expect(flat).toContain('"Observed At"')
    expect(flat).toContain("on_or_before")
    // Invalidated At clause: empty (with Valid Until fallback) OR > asOf.
    expect(flat).toContain('"Invalidated At"')
    expect(flat).toContain('"after":"2026-04-01"')
    // Each transaction-time leg keeps an is_empty short-circuit for
    // pre-migration rows.
    expect(flat).toContain('"is_empty":true')
  })

  it("approximates with Valid Until on un-migrated rows (issue #284 review item #2)", async () => {
    // Principal-review fix: when Invalidated At is empty (pre-migration
    // or live), the filter additionally requires Valid Until is_empty OR
    // > asOf so historical invalidations don't leak past their cutoff
    // on un-migrated vaults. After --backfill-fact-observed-at runs,
    // Invalidated At = Valid Until on those rows and the safety net
    // becomes byte-equivalent to the explicit Invalidated At leg.
    const { client, querySpy } = mkClient({ queries: [{ results: [] }] })
    const service = new FactService(client, DB)

    await service.queryByEntity("Auth", {
      entityId: "ent-1",
      asOf: "2026-04-01",
    })

    const args = querySpy.mock.calls[0]![0]
    const flat = JSON.stringify(args.filter)
    // Valid Until appears as the fallback inside the Invalidated At leg,
    // gated by `Invalidated At is_empty`.
    expect(flat).toContain('"Valid Until"')
    // The asOf cutoff appears on both the Invalidated At "after" branch
    // AND the Valid Until "after" fallback — proving both legs land.
    const afterCount = (flat.match(/"after":"2026-04-01"/g) ?? []).length
    expect(afterCount).toBe(2)
  })

  it("drops the Valid Until is_empty filter when includeInvalidated is true", async () => {
    const { client, querySpy } = mkClient({ queries: [{ results: [] }] })
    const service = new FactService(client, DB)

    await service.queryByEntity("Auth", {
      entityId: "ent-1",
      includeInvalidated: true,
    })

    const args = querySpy.mock.calls[0]![0]
    const flat = JSON.stringify(args.filter)
    expect(flat).not.toContain('"Valid Until"')
  })

  it("drops the Invalidated At gate when asOf and includeInvalidated are both set (R3 blocker fix)", async () => {
    // R3 reviewer-flagged: `pushLiveOrAsOfClauses` was dropping the
    // `includeInvalidated` flag when forwarding to `asOfFilterClauses`,
    // so the combined `asOf + includeHistory` call produced byte-
    // identical filter output to the asOf-only path. A real fact
    // invalidated BEFORE asOf would never reach the renderer.
    // The fix: forward the flag so the asOf clause builder
    // emits only the `Observed At <= asOf` clause and lets every
    // invalidated row through.
    const { client, querySpy } = mkClient({ queries: [{ results: [] }] })
    const service = new FactService(client, DB)

    await service.queryByEntity("Auth", {
      entityId: "ent-1",
      asOf: "2026-04-01",
      includeInvalidated: true,
    })

    const args = querySpy.mock.calls[0]![0]
    const flat = JSON.stringify(args.filter)
    // Observed At clause still fires — "what Lore knew at asOf".
    expect(flat).toContain('"Observed At"')
    expect(flat).toContain("on_or_before")
    // Invalidated At clause and the Valid Until fallback are NOT
    // emitted — combined flags surface every fact known by asOf,
    // including those already invalidated by then.
    expect(flat).not.toContain('"Invalidated At"')
    expect(flat).not.toContain('"Valid Until"')
  })

  it("applies the default Valid Until is_empty filter when neither flag is set (byte-stable pre-#284 behavior)", async () => {
    const { client, querySpy } = mkClient({ queries: [{ results: [] }] })
    const service = new FactService(client, DB)

    await service.queryByEntity("Auth", { entityId: "ent-1" })

    const args = querySpy.mock.calls[0]![0]
    const flat = JSON.stringify(args.filter)
    expect(flat).toContain('"Valid Until"')
    expect(flat).toContain('"is_empty":true')
    // No asOf clauses fire on the default path.
    expect(flat).not.toContain('"Observed At"')
    expect(flat).not.toContain('"Invalidated At"')
  })
})

describe("runBackfillFactObservedAtMigration — issue #284", () => {
  function mkServices(facts: Fact[]) {
    const applySpy = vi.fn(async () => {})
    const findByNameSpy = vi.fn(async () => null)
    const listSpy = vi.fn(async function* (_opts?: {
      projectId?: string
      includeInvalidated?: boolean
    }) {
      for (const f of facts) yield f
    })
    return {
      services: {
        config: { notion: {} },
        projects: { findByName: findByNameSpy },
        facts: {
          listAllForBackfill: listSpy,
          applyObservedAtBackfill: applySpy,
        },
      } as unknown as Parameters<
        typeof runBackfillFactObservedAtMigration
      >[0]["services"],
      applySpy,
      findByNameSpy,
      listSpy,
    }
  }

  it("plans both axes independently: missing Observed At AND missing Invalidated At", async () => {
    const facts: Fact[] = [
      // Live row, missing Observed At → backfill from createdAt.
      {
        id: "live-needs-observed",
        subject: "S1",
        predicate: "uses",
        object: "O1",
        projectIds: [],
        validFrom: "2026-01-01",
        validUntil: null,
        reviewBy: null,
        sourceMemoryId: null,
        confidence: "certain",
        observedAt: null,
        invalidatedAt: null,
        invalidatedBySourceMemoryId: null,
        createdAt: "2026-01-15T00:00:00.000Z",
      },
      // Invalidated row, missing both → backfill both.
      {
        id: "invalidated-needs-both",
        subject: "S2",
        predicate: "uses",
        object: "O2",
        projectIds: [],
        validFrom: "2026-01-01",
        validUntil: "2026-03-01",
        reviewBy: null,
        sourceMemoryId: null,
        confidence: "certain",
        observedAt: null,
        invalidatedAt: null,
        invalidatedBySourceMemoryId: null,
        createdAt: "2026-01-10T00:00:00.000Z",
      },
      // Already backfilled → skip.
      {
        id: "already-done",
        subject: "S3",
        predicate: "uses",
        object: "O3",
        projectIds: [],
        validFrom: "2026-01-01",
        validUntil: null,
        reviewBy: null,
        sourceMemoryId: null,
        confidence: "certain",
        observedAt: "2026-01-15",
        invalidatedAt: null,
        invalidatedBySourceMemoryId: null,
        createdAt: "2026-01-15T00:00:00.000Z",
      },
    ]
    const { services, applySpy } = mkServices(facts)

    const result = await runBackfillFactObservedAtMigration({
      services,
      apply: true,
      dryRun: false,
    })

    expect(result.plan.totalFactsScanned).toBe(3)
    expect(result.plan.rowsAlreadyBackfilled).toBe(1)
    expect(result.plan.rowsToBackfill).toHaveLength(2)
    expect(result.plan.observedAtRowsToWrite).toBe(2)
    expect(result.plan.invalidatedAtRowsToWrite).toBe(1)

    // Per-row write payloads.
    const liveRow = result.plan.rowsToBackfill.find(
      (r) => r.factId === "live-needs-observed"
    )!
    expect(liveRow.observedAtToWrite).toBe("2026-01-15")
    expect(liveRow.invalidatedAtToWrite).toBeNull()

    const invalidatedRow = result.plan.rowsToBackfill.find(
      (r) => r.factId === "invalidated-needs-both"
    )!
    expect(invalidatedRow.observedAtToWrite).toBe("2026-01-10")
    expect(invalidatedRow.invalidatedAtToWrite).toBe("2026-03-01")

    expect(applySpy).toHaveBeenCalledTimes(2)
    expect(result.written).toBe(2)
  })

  it("dry-run skips writes", async () => {
    const facts: Fact[] = [
      {
        id: "f1",
        subject: "S",
        predicate: "uses",
        object: "O",
        projectIds: [],
        validFrom: "2026-01-01",
        validUntil: null,
        reviewBy: null,
        sourceMemoryId: null,
        confidence: "certain",
        observedAt: null,
        invalidatedAt: null,
        invalidatedBySourceMemoryId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]
    const { services, applySpy } = mkServices(facts)

    const result = await runBackfillFactObservedAtMigration({
      services,
      apply: false,
      dryRun: true,
    })

    expect(result.plan.rowsToBackfill).toHaveLength(1)
    expect(applySpy).not.toHaveBeenCalled()
    expect(result.written).toBe(0)
  })

  it("walks invalidated rows via listAllForBackfill({ includeInvalidated: true })", async () => {
    const { services, listSpy } = mkServices([])

    await runBackfillFactObservedAtMigration({
      services,
      apply: false,
      dryRun: true,
    })

    expect(listSpy).toHaveBeenCalledWith({
      projectId: undefined,
      includeInvalidated: true,
    })
  })

  it("isolates per-row failures and reports them without aborting the run (issue #284 review item #4)", async () => {
    const facts: Fact[] = [
      {
        id: "f-ok",
        subject: "S1",
        predicate: "uses",
        object: "O1",
        projectIds: [],
        validFrom: "2026-01-01",
        validUntil: null,
        reviewBy: null,
        sourceMemoryId: null,
        confidence: "certain",
        observedAt: null,
        invalidatedAt: null,
        invalidatedBySourceMemoryId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "f-fail",
        subject: "S2",
        predicate: "uses",
        object: "O2",
        projectIds: [],
        validFrom: "2026-01-01",
        validUntil: null,
        reviewBy: null,
        sourceMemoryId: null,
        confidence: "certain",
        observedAt: null,
        invalidatedAt: null,
        invalidatedBySourceMemoryId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "f-ok-2",
        subject: "S3",
        predicate: "uses",
        object: "O3",
        projectIds: [],
        validFrom: "2026-01-01",
        validUntil: null,
        reviewBy: null,
        sourceMemoryId: null,
        confidence: "certain",
        observedAt: null,
        invalidatedAt: null,
        invalidatedBySourceMemoryId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]
    const applySpy = vi.fn(async (factId: string) => {
      if (factId === "f-fail") throw new Error("validation_error: column missing")
    })
    const services = {
      config: { notion: {} },
      projects: { findByName: vi.fn().mockResolvedValue(null) },
      facts: {
        listAllForBackfill: async function* () {
          for (const f of facts) yield f
        },
        applyObservedAtBackfill: applySpy,
      },
    } as unknown as Parameters<typeof runBackfillFactObservedAtMigration>[0]["services"]

    const result = await runBackfillFactObservedAtMigration({
      services,
      apply: true,
      dryRun: false,
    })

    expect(applySpy).toHaveBeenCalledTimes(3)
    expect(result.written).toBe(2)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.factId).toBe("f-fail")
    expect(result.failures[0]!.message).toContain("validation_error")
  })
})

describe("FactService.applyObservedAtBackfill — issue #284", () => {
  it("writes both columns when both values are present", async () => {
    const { client, updateSpy } = mkClient()
    const service = new FactService(client, DB)

    await service.applyObservedAtBackfill("f1", {
      observedAt: "2026-01-15",
      invalidatedAt: "2026-03-01",
    })

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const args = updateSpy.mock.calls[0]![0]
    expect(args.page_id).toBe("f1")
    expect(args.properties).toEqual({
      "Observed At": { date: { start: "2026-01-15" } },
      "Invalidated At": { date: { start: "2026-03-01" } },
    })
  })

  it("skips the column when the value is null (per-axis backfill)", async () => {
    const { client, updateSpy } = mkClient()
    const service = new FactService(client, DB)

    await service.applyObservedAtBackfill("f1", {
      observedAt: "2026-01-15",
      invalidatedAt: null,
    })

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const args = updateSpy.mock.calls[0]![0]
    expect(args.properties).toEqual({
      "Observed At": { date: { start: "2026-01-15" } },
    })
  })

  it("issues no update when both values are null", async () => {
    const { client, updateSpy } = mkClient()
    const service = new FactService(client, DB)

    await service.applyObservedAtBackfill("f1", {
      observedAt: null,
      invalidatedAt: null,
    })

    expect(updateSpy).not.toHaveBeenCalled()
  })
})
