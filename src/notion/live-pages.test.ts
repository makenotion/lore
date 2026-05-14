import { Buffer } from "node:buffer"
import { describe, expect, it, vi } from "vitest"
import type { PageObjectResponse } from "@notionhq/client"
import { collectLivePages } from "./live-pages.js"

function page(id: string): PageObjectResponse {
  return {
    object: "page",
    id,
    created_time: "2026-04-01T00:00:00.000Z",
    last_edited_time: "2026-04-20T00:00:00.000Z",
    archived: false,
    url: `https://notion.so/${id}`,
    parent: { type: "database_id", database_id: "memories-db" },
    properties: {},
  } as PageObjectResponse
}

describe("collectLivePages", () => {
  it("logs when the refill cap fires even if the returned window is full", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        results: [page("live-1")],
        has_more: true,
        next_cursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        results: [page("live-2")],
        has_more: true,
        next_cursor: "cursor-2",
      })
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const original = process.env["LORE_DEBUG"]
    process.env["LORE_DEBUG"] = "1"

    try {
      const result = await collectLivePages({
        limit: 2,
        maxPages: 2,
        source: "test-source",
        query,
      })

      expect(result.pages.map((p) => p.id)).toEqual(["live-1", "live-2"])
      expect(result.nextCursor).toBe("cursor-2")
      expect(result.capped).toBe(true)
      expect(query).toHaveBeenCalledTimes(2)
      const lines = stderrSpy.mock.calls.map((call) => String(call[0]))
      expect(lines.some((line) => line.includes("live-page-refill-cap-fired"))).toBe(true)
      expect(lines.some((line) => line.includes("source=test-source"))).toBe(true)
    } finally {
      stderrSpy.mockRestore()
      if (original === undefined) {
        delete process.env["LORE_DEBUG"]
      } else {
        process.env["LORE_DEBUG"] = original
      }
    }
  })

  it("normalizes malformed opaque cursors to a stable error", async () => {
    const badCursor =
      "lore-live-page:" + Buffer.from("not-json", "utf8").toString("base64url")

    await expect(
      collectLivePages({
        limit: 1,
        startCursor: badCursor,
        source: "test-source",
        query: vi.fn(),
      })
    ).rejects.toThrow("Invalid Lore live-page cursor.")
  })

  it("rethrows non-throwing missing-property payloads with Notion's validation shape", async () => {
    await expect(
      collectLivePages({
        limit: 1,
        source: "test-source",
        query: vi.fn(async () => ({
          object: "error",
          code: "validation_error",
          status: 400,
          message: "Could not find property: Pinned",
        })) as never,
      })
    ).rejects.toMatchObject({
      code: "validation_error",
      message: "Could not find property: Pinned",
    })
  })

  it("rejects malformed non-validation query payloads instead of returning empty", async () => {
    await expect(
      collectLivePages({
        limit: 1,
        source: "test-source",
        query: vi.fn(async () => ({
          object: "error",
          code: "rate_limited",
          status: 429,
          message: "rate_limited",
        })) as never,
      })
    ).rejects.toThrow(
      'Invalid Notion data source query response from test-source: expected results array (code=rate_limited, message="rate_limited").'
    )
  })

  it("rejects opaque cursors whose skip list exceeds one Notion page", async () => {
    const oversized =
      "lore-live-page:" +
      Buffer.from(
        JSON.stringify({
          v: 1,
          startCursor: null,
          skipIds: Array.from({ length: 101 }, (_, i) => `page-${i}`),
        }),
        "utf8"
      ).toString("base64url")

    await expect(
      collectLivePages({
        limit: 1,
        startCursor: oversized,
        source: "test-source",
        query: vi.fn(),
      })
    ).rejects.toThrow("Invalid Lore live-page cursor.")
  })

  it("prunes stale skip ids before emitting the next opaque cursor", async () => {
    const staleCursor =
      "lore-live-page:" +
      Buffer.from(
        JSON.stringify({
          v: 1,
          startCursor: null,
          skipIds: Array.from({ length: 100 }, (_, i) => `stale-${i}`),
        }),
        "utf8"
      ).toString("base64url")
    const query = vi.fn(async () => ({
      results: [page("live-1"), page("live-2"), page("live-3"), page("live-4")],
      has_more: true,
      next_cursor: "after-current-page",
    }))

    const first = await collectLivePages({
      limit: 2,
      startCursor: staleCursor,
      source: "test-source",
      query,
    })
    const second = await collectLivePages({
      limit: 2,
      startCursor: first.nextCursor,
      source: "test-source",
      query,
    })

    expect(first.pages.map((p) => p.id)).toEqual(["live-1", "live-2"])
    expect(second.pages.map((p) => p.id)).toEqual(["live-3", "live-4"])
    expect(second.nextCursor).toBe("after-current-page")
  })
})
