import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { runFactDedupBackfill } from "./fact-dedup.js"
import { computeFactDedupKey, computeSubjectKey } from "../notion/normalize.js"
import type { DatabaseRef } from "../types.js"

function buildRow(overrides: {
  id: string
  subject: string
  predicate?: string
  object: string
  dedupKey?: string
  /**
   * Stored SubjectKey. Default to `computeSubjectKey(subject)` so legacy
   * fixtures stay focused on DedupKey behaviour without being implicitly
   * "stale on SubjectKey too" — the backfill now re-runs whenever either
   * column drifts, and propagating that into every fixture would obscure
   * the test under exercise. Pass an empty string explicitly to model a
   * pre-P3-03 row.
   */
  subjectKey?: string
  validUntil?: string | null
  reviewBy?: string | null
  createdTime?: string
}): PageObjectResponse {
  const subjectKey =
    overrides.subjectKey !== undefined
      ? overrides.subjectKey
      : computeSubjectKey(overrides.subject)
  return {
    object: "page",
    id: overrides.id,
    created_time: overrides.createdTime ?? "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-02-01T00:00:00.000Z",
    archived: false,
    url: `https://notion.so/${overrides.id}`,
    parent: { type: "database_id", database_id: "facts-db" },
    properties: {
      Subject: {
        type: "title",
        title: [{ plain_text: overrides.subject }],
      } as unknown,
      Predicate: {
        type: "select",
        select: { name: overrides.predicate ?? "uses" },
      } as unknown,
      Object: {
        type: "rich_text",
        rich_text: [{ plain_text: overrides.object }],
      } as unknown,
      DedupKey: {
        type: "rich_text",
        rich_text: overrides.dedupKey ? [{ plain_text: overrides.dedupKey }] : [],
      } as unknown,
      SubjectKey: {
        type: "rich_text",
        rich_text: subjectKey ? [{ plain_text: subjectKey }] : [],
      } as unknown,
      "Valid Until": {
        type: "date",
        date: overrides.validUntil ? { start: overrides.validUntil } : null,
      } as unknown,
      "Review By": {
        type: "date",
        date: overrides.reviewBy ? { start: overrides.reviewBy } : null,
      } as unknown,
    } as PageObjectResponse["properties"],
  } as PageObjectResponse
}

function createMockClient() {
  return {
    dataSources: { query: vi.fn() },
    pages: { update: vi.fn() },
  } as unknown as Client & {
    dataSources: { query: ReturnType<typeof vi.fn> }
    pages: { update: ReturnType<typeof vi.fn> }
  }
}

const DB: DatabaseRef = {
  databaseId: "facts-db",
  dataSourceId: "facts-ds",
}

describe("runFactDedupBackfill — backfill phase", () => {
  it("writes DedupKey and SubjectKey in one update on a pre-migration row", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        buildRow({
          id: "f1",
          subject: "A",
          predicate: "uses",
          object: "B",
          // Pre-migration: both columns empty.
          subjectKey: "",
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await runFactDedupBackfill(client, DB)

    expect(result.backfilled).toBe(1)
    expect(result.skipped).toBe(0)
    // Single atomic update covers both columns — bundling matters because
    // every fact in an internal-scale vault would otherwise pay 2× the writes.
    expect(client.pages.update).toHaveBeenCalledTimes(1)
    expect(client.pages.update).toHaveBeenCalledWith({
      page_id: "f1",
      properties: {
        DedupKey: {
          rich_text: [
            {
              text: {
                content: computeFactDedupKey({
                  subject: "A",
                  predicate: "uses",
                  object: "B",
                }),
              },
            },
          ],
        },
        SubjectKey: {
          rich_text: [{ text: { content: computeSubjectKey("A") } }],
        },
      },
    })
  })

  it("skips rows whose DedupKey and SubjectKey already match", async () => {
    const client = createMockClient()
    const key = computeFactDedupKey({
      subject: "A",
      predicate: "uses",
      object: "B",
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        buildRow({
          id: "f1",
          subject: "A",
          predicate: "uses",
          object: "B",
          dedupKey: key,
          // buildRow defaults SubjectKey to the canonical form, so this
          // row is fully up-to-date.
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await runFactDedupBackfill(client, DB)

    expect(result.backfilled).toBe(0)
    expect(result.skipped).toBe(1)
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("writes only SubjectKey when DedupKey is up-to-date but SubjectKey is empty", async () => {
    // Pinned: vaults migrated to P1-04 (DedupKey) but not yet to P3-03
    // (SubjectKey) must still get a SubjectKey write per row, and only
    // SubjectKey — re-writing a stable DedupKey is wasted I/O on a
    // hot-reused column.
    const client = createMockClient()
    const key = computeFactDedupKey({
      subject: "A",
      predicate: "uses",
      object: "B",
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        buildRow({
          id: "f1",
          subject: "A",
          predicate: "uses",
          object: "B",
          dedupKey: key,
          subjectKey: "",
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await runFactDedupBackfill(client, DB)

    expect(result.backfilled).toBe(1)
    expect(client.pages.update).toHaveBeenCalledTimes(1)
    expect(client.pages.update).toHaveBeenCalledWith({
      page_id: "f1",
      properties: {
        SubjectKey: {
          rich_text: [{ text: { content: computeSubjectKey("A") } }],
        },
      },
    })
  })

  it("is a no-op under dryRun", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        buildRow({
          id: "f1",
          subject: "A",
          predicate: "uses",
          object: "B",
          subjectKey: "",
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await runFactDedupBackfill(client, DB, { dryRun: true })

    expect(result.backfilled).toBe(1)
    expect(client.pages.update).not.toHaveBeenCalled()
  })
})

describe("runFactDedupBackfill — merge phase", () => {
  it("invalidates all but one survivor per duplicate group", async () => {
    const client = createMockClient()
    const key = computeFactDedupKey({
      subject: "A",
      predicate: "uses",
      object: "B",
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        buildRow({
          id: "winner",
          subject: "A",
          predicate: "uses",
          object: "B",
          dedupKey: key,
          reviewBy: "2026-12-01",
          createdTime: "2026-01-01T00:00:00.000Z",
        }),
        buildRow({
          id: "loser1",
          subject: "A",
          predicate: "uses",
          object: "B",
          dedupKey: key,
          reviewBy: "2026-06-01",
          createdTime: "2026-02-01T00:00:00.000Z",
        }),
        buildRow({
          id: "loser2",
          subject: "A",
          predicate: "uses",
          object: "B",
          dedupKey: key,
          reviewBy: null,
          createdTime: "2026-03-01T00:00:00.000Z",
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await runFactDedupBackfill(client, DB, {
      merge: true,
      yes: true,
    })

    expect(result.mergedGroups).toBe(1)
    expect(result.invalidated).toBe(2)
    expect(result.mergePreviewOnly).toBe(false)
    const updates = client.pages.update.mock.calls.map((c) => c[0])
    const invalidated = updates.filter(
      (u: { properties?: { "Valid Until"?: unknown } }) =>
        u.properties && u.properties["Valid Until"]
    )
    expect(invalidated.map((u: { page_id: string }) => u.page_id).sort()).toEqual([
      "loser1",
      "loser2",
    ])
    // Winner is not invalidated.
    const winnerInvalidation = invalidated.find(
      (u: { page_id: string }) => u.page_id === "winner"
    )
    expect(winnerInvalidation).toBeUndefined()
  })

  it("computes a plan without writing when merge runs without yes", async () => {
    const client = createMockClient()
    const key = computeFactDedupKey({
      subject: "A",
      predicate: "uses",
      object: "B",
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        buildRow({
          id: "winner",
          subject: "A",
          predicate: "uses",
          object: "B",
          dedupKey: key,
          reviewBy: "2026-12-01",
        }),
        buildRow({
          id: "loser",
          subject: "A",
          predicate: "uses",
          object: "B",
          dedupKey: key,
          reviewBy: "2026-06-01",
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await runFactDedupBackfill(client, DB, { merge: true })

    expect(result.mergedGroups).toBe(1)
    expect(result.mergePreviewOnly).toBe(true)
    expect(result.invalidated).toBe(0)
    expect(result.plans).toHaveLength(1)
    expect(result.plans[0].survivorId).toBe("winner")
    expect(result.plans[0].loserIds).toEqual(["loser"])
    // No Valid Until writes when preview-only.
    const invalidations = client.pages.update.mock.calls
      .map((c) => c[0])
      .filter(
        (u: { properties?: { "Valid Until"?: unknown } }) =>
          u.properties && u.properties["Valid Until"]
      )
    expect(invalidations).toHaveLength(0)
  })

  it("keeps the oldest row when every row in the group has reviewBy = null", async () => {
    const client = createMockClient()
    const key = computeFactDedupKey({
      subject: "A",
      predicate: "uses",
      object: "B",
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        buildRow({
          id: "newer",
          subject: "A",
          predicate: "uses",
          object: "B",
          dedupKey: key,
          reviewBy: null,
          createdTime: "2026-03-01T00:00:00.000Z",
        }),
        buildRow({
          id: "oldest",
          subject: "A",
          predicate: "uses",
          object: "B",
          dedupKey: key,
          reviewBy: null,
          createdTime: "2026-01-01T00:00:00.000Z",
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await runFactDedupBackfill(client, DB, {
      merge: true,
      yes: true,
    })

    expect(result.mergedGroups).toBe(1)
    expect(result.invalidated).toBe(1)
    const invalidations = client.pages.update.mock.calls
      .map((c) => c[0])
      .filter(
        (u: { properties?: { "Valid Until"?: unknown } }) =>
          u.properties && u.properties["Valid Until"]
      )
    expect(invalidations.map((u: { page_id: string }) => u.page_id)).toEqual(["newer"])
  })

  it("keeps the timed row as survivor over a null-reviewBy sibling", async () => {
    const client = createMockClient()
    const key = computeFactDedupKey({
      subject: "A",
      predicate: "uses",
      object: "B",
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        buildRow({
          id: "timed",
          subject: "A",
          predicate: "uses",
          object: "B",
          dedupKey: key,
          reviewBy: "2026-12-01",
          createdTime: "2026-01-01T00:00:00.000Z",
        }),
        buildRow({
          id: "stable",
          subject: "A",
          predicate: "uses",
          object: "B",
          dedupKey: key,
          reviewBy: null,
          createdTime: "2026-06-01T00:00:00.000Z",
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await runFactDedupBackfill(client, DB, {
      merge: true,
      yes: true,
    })

    expect(result.invalidated).toBe(1)
    const invalidations = client.pages.update.mock.calls
      .map((c) => c[0])
      .filter(
        (u: { properties?: { "Valid Until"?: unknown } }) =>
          u.properties && u.properties["Valid Until"]
      )
    expect(invalidations.map((u: { page_id: string }) => u.page_id)).toEqual(["stable"])
  })

  it("does not issue invalidation writes when merge runs with dryRun", async () => {
    const client = createMockClient()
    const key = computeFactDedupKey({
      subject: "A",
      predicate: "uses",
      object: "B",
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        buildRow({
          id: "w",
          subject: "A",
          predicate: "uses",
          object: "B",
          dedupKey: key,
          reviewBy: "2026-12-01",
        }),
        buildRow({
          id: "l",
          subject: "A",
          predicate: "uses",
          object: "B",
          dedupKey: key,
          reviewBy: "2026-06-01",
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await runFactDedupBackfill(client, DB, {
      merge: true,
      dryRun: true,
      yes: true,
    })

    expect(result.mergedGroups).toBe(1)
    expect(result.plans[0].loserIds).toEqual(["l"])
    // dryRun wins over yes — no invalidations, no backfill writes.
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("walks the pagination cursor across multiple pages", async () => {
    const client = createMockClient()
    client.dataSources.query
      .mockResolvedValueOnce({
        results: [buildRow({ id: "f1", subject: "A", predicate: "uses", object: "B" })],
        has_more: true,
        next_cursor: "page-2",
      })
      .mockResolvedValueOnce({
        results: [buildRow({ id: "f2", subject: "C", predicate: "uses", object: "D" })],
        has_more: false,
        next_cursor: null,
      })

    const result = await runFactDedupBackfill(client, DB)

    expect(result.backfilled).toBe(2)
    expect(client.dataSources.query).toHaveBeenCalledTimes(2)
    expect(client.dataSources.query.mock.calls[1][0].start_cursor).toBe("page-2")
  })

  it("rewrites DedupKey when the stored key is stale (algorithm-change survival)", async () => {
    // The point of this test: after a change to the normalize algorithm,
    // re-running backfill must produce the *current* algorithm's key. If
    // this regresses, P2-03 and P3-03 break because they assume the
    // DedupKey column always reflects the current normalize output.
    const client = createMockClient()
    const staleKey = "stale-key-from-a-previous-schema"
    const currentKey = computeFactDedupKey({
      subject: "A",
      predicate: "uses",
      object: "B",
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        buildRow({
          id: "f1",
          subject: "A",
          predicate: "uses",
          object: "B",
          dedupKey: staleKey,
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await runFactDedupBackfill(client, DB)

    expect(result.backfilled).toBe(1)
    expect(result.skipped).toBe(0)
    expect(client.pages.update).toHaveBeenCalledTimes(1)
    const updateCall = client.pages.update.mock.calls[0][0]
    expect(updateCall.properties.DedupKey.rich_text[0].text.content).toBe(currentKey)
    expect(updateCall.properties.DedupKey.rich_text[0].text.content).not.toBe(staleKey)
  })

  it("ignores already-invalidated rows when computing groups", async () => {
    const client = createMockClient()
    const key = computeFactDedupKey({
      subject: "A",
      predicate: "uses",
      object: "B",
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        buildRow({
          id: "live",
          subject: "A",
          predicate: "uses",
          object: "B",
          dedupKey: key,
        }),
        buildRow({
          id: "dead",
          subject: "A",
          predicate: "uses",
          object: "B",
          dedupKey: key,
          validUntil: "2025-12-01",
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const result = await runFactDedupBackfill(client, DB, { merge: true })

    expect(result.mergedGroups).toBe(0)
    expect(result.invalidated).toBe(0)
  })
})
