import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { MEMORY_PROPS } from "../notion/schema.js"
import {
  BODY_SIZE_CAP_BYTES,
  findEncodedMemories,
  fixMemoryEncoding,
} from "./memory-encoding.js"
import type { DatabaseRef } from "../types.js"

function memoryPage(overrides: {
  id: string
  title: string
  archived?: boolean
  createdTime?: string
}): PageObjectResponse {
  return {
    object: "page",
    id: overrides.id,
    created_time: overrides.createdTime ?? "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-02-01T00:00:00.000Z",
    archived: overrides.archived ?? false,
    url: `https://notion.so/${overrides.id}`,
    parent: { type: "database_id", database_id: "memories-db" },
    properties: {
      Title: {
        type: "title",
        title: [{ plain_text: overrides.title }],
      } as unknown,
    } as PageObjectResponse["properties"],
  } as PageObjectResponse
}

interface MockClientOptions {
  queryResponses?: Array<{
    results: PageObjectResponse[]
    has_more?: boolean
    next_cursor?: string | null
  }>
  markdownByPageId?: Record<string, string>
}

function createMockClient(opts: MockClientOptions = {}) {
  const queryMock = vi.fn()
  for (const r of opts.queryResponses ?? []) {
    queryMock.mockResolvedValueOnce({
      results: r.results,
      has_more: r.has_more ?? false,
      next_cursor: r.next_cursor ?? null,
    })
  }
  queryMock.mockResolvedValue({
    results: [],
    has_more: false,
    next_cursor: null,
  })

  const retrieveMarkdownMock = vi.fn(async ({ page_id }: { page_id: string }) => ({
    markdown: opts.markdownByPageId?.[page_id] ?? "",
  }))
  return {
    pages: {
      update: vi.fn().mockResolvedValue({}),
      retrieveMarkdown: retrieveMarkdownMock,
      updateMarkdown: vi.fn().mockResolvedValue({}),
    },
    dataSources: { query: queryMock },
  } as unknown as Client & {
    pages: {
      update: ReturnType<typeof vi.fn>
      retrieveMarkdown: ReturnType<typeof vi.fn>
      updateMarkdown: ReturnType<typeof vi.fn>
    }
    dataSources: { query: ReturnType<typeof vi.fn> }
  }
}

const DB: DatabaseRef = {
  databaseId: "memories-db",
  dataSourceId: "memories-ds",
}

describe("findEncodedMemories", () => {
  it("is empty when every non-archived Title and body is clean", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            memoryPage({ id: "m1", title: "auth plan" }),
            memoryPage({ id: "m2", title: "design" }),
          ],
        },
      ],
      markdownByPageId: { m1: "clean body", m2: "also clean" },
    })

    const encoded = await findEncodedMemories(client, DB)
    expect(encoded).toEqual([])
  })

  it("skips archived memories", async () => {
    // An archived memory is invisible to the agent — fixing it provides no
    // value, and including archived rows would bloat the migration.
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            memoryPage({ id: "m1", title: "Build &amp; Tooling", archived: true }),
            memoryPage({ id: "m2", title: "Build &amp; Tooling" }),
          ],
        },
      ],
      markdownByPageId: {},
    })

    const encoded = await findEncodedMemories(client, DB)
    expect(encoded.map((r) => r.id)).toEqual(["m2"])
  })

  it("flags Title-only dirty rows even when body is clean", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [memoryPage({ id: "m1", title: "Build &amp; Tooling" })],
        },
      ],
      markdownByPageId: { m1: "clean body" },
    })

    const encoded = await findEncodedMemories(client, DB)
    expect(encoded).toHaveLength(1)
    expect(encoded[0].titleNeedsFix).toBe(true)
    expect(encoded[0].contentNeedsFix).toBe(false)
    expect(encoded[0].decodedTitle).toBe("Build & Tooling")
  })

  it("flags body-only dirty rows even when Title is clean", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [memoryPage({ id: "m1", title: "clean title" })],
        },
      ],
      markdownByPageId: { m1: "Body with &amp;amp; embedded" },
    })

    const encoded = await findEncodedMemories(client, DB)
    expect(encoded).toHaveLength(1)
    expect(encoded[0].titleNeedsFix).toBe(false)
    expect(encoded[0].contentNeedsFix).toBe(true)
    expect(encoded[0].decodedContent).toBe("Body with & embedded")
  })

  it("marks oversized bodies as contentTooLargeToFix but still fixes Title", async () => {
    const bigBody = "Body &amp; ".repeat(20_000) // ~200 KB
    expect(Buffer.byteLength(bigBody, "utf8")).toBeGreaterThan(BODY_SIZE_CAP_BYTES)

    const client = createMockClient({
      queryResponses: [
        {
          results: [memoryPage({ id: "m1", title: "Big &amp; Chunky" })],
        },
      ],
      markdownByPageId: { m1: bigBody },
    })

    const encoded = await findEncodedMemories(client, DB)
    expect(encoded).toHaveLength(1)
    expect(encoded[0].titleNeedsFix).toBe(true)
    expect(encoded[0].contentNeedsFix).toBe(true)
    expect(encoded[0].contentTooLargeToFix).toBe(true)
  })

  it("with includeContent=false skips the markdown fetch entirely", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [memoryPage({ id: "m1", title: "Build &amp; Tooling" })],
        },
      ],
    })

    const encoded = await findEncodedMemories(client, DB, {
      includeContent: false,
    })
    expect(encoded).toHaveLength(1)
    expect(encoded[0].titleNeedsFix).toBe(true)
    expect(client.pages.retrieveMarkdown).not.toHaveBeenCalled()
  })

  it("scopes discovery to project rows plus unscoped rows when projectId is supplied", async () => {
    const client = createMockClient()

    await findEncodedMemories(client, DB, {
      includeContent: false,
      projectId: "project-a",
    })

    expect(client.dataSources.query).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: {
          or: [
            { property: MEMORY_PROPS.PROJECT, relation: { contains: "project-a" } },
            { property: MEMORY_PROPS.PROJECT, relation: { is_empty: true } },
          ],
        },
      })
    )
  })

  it("surfaces clean-title / failed-body-fetch rows so operators see scan coverage holes", async () => {
    // A memory with a clean Title whose body fetch timed out has no
    // actionable work — we don't know if the body is encoded — but
    // silently dropping it hides the scan coverage hole from operators.
    // It must appear in `encoded` with `contentFetchFailed: true` and
    // clean title/body flags so the CLI can enumerate it under
    // "Body fetch failed on N memories".
    const client = createMockClient({
      queryResponses: [
        {
          results: [memoryPage({ id: "m-opaque", title: "clean title" })],
        },
      ],
    })
    ;(client.pages.retrieveMarkdown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Request to Notion API has timed out")
    )

    const encoded = await findEncodedMemories(client, DB)
    expect(encoded).toHaveLength(1)
    const row = encoded[0]
    expect(row.id).toBe("m-opaque")
    expect(row.titleNeedsFix).toBe(false)
    expect(row.contentNeedsFix).toBe(false)
    expect(row.contentFetchFailed).toBe(true)
  })

  it("isolates per-page retrieveMarkdown failures and still fixes Title", async () => {
    // One page's body fetch throws (timeout / 5xx on a huge page). The
    // whole-batch Promise.all must NOT abort; the bad row flows through
    // with `contentFetchFailed: true` and the Title delta preserved so
    // the apply path still writes the Title.
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            memoryPage({ id: "m-ok", title: "Fine &amp; Dandy" }),
            memoryPage({ id: "m-bad", title: "Broken &amp; Body" }),
          ],
        },
      ],
    })
    ;(client.pages.retrieveMarkdown as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => ({ markdown: "clean body" }))
      .mockImplementationOnce(async () => {
        throw new Error("Request to Notion API has timed out")
      })

    const encoded = await findEncodedMemories(client, DB)
    expect(encoded).toHaveLength(2)
    const bad = encoded.find((r) => r.id === "m-bad")!
    expect(bad.contentFetchFailed).toBe(true)
    expect(bad.rawContent).toBeNull()
    expect(bad.titleNeedsFix).toBe(true)
  })

  it("paginates through multi-page results", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [memoryPage({ id: "m1", title: "A &amp; B" })],
          has_more: true,
          next_cursor: "cursor-1",
        },
        {
          results: [memoryPage({ id: "m2", title: "C &amp;amp; D" })],
        },
      ],
      markdownByPageId: { m1: "", m2: "" },
    })

    const encoded = await findEncodedMemories(client, DB)
    expect(encoded.map((r) => r.id).sort()).toEqual(["m1", "m2"])
  })
})

describe("fixMemoryEncoding", () => {
  it("no-ops when no rows need decoding", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [memoryPage({ id: "m1", title: "clean" })],
        },
      ],
      markdownByPageId: { m1: "also clean" },
    })

    const report = await fixMemoryEncoding(client, DB, { dryRun: false })
    expect(report.fixes).toEqual([])
    expect(client.pages.update).not.toHaveBeenCalled()
    expect(client.pages.updateMarkdown).not.toHaveBeenCalled()
  })

  it("rewrites Title via pages.update and body via pages.updateMarkdown", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [memoryPage({ id: "m1", title: "Build &amp; Tooling" })],
        },
      ],
      markdownByPageId: { m1: "Rollup &amp; Vite" },
    })

    const report = await fixMemoryEncoding(client, DB, { dryRun: false })
    expect(report.fixes).toHaveLength(1)
    expect(report.fixes[0]).toEqual({
      id: "m1",
      rawTitle: "Build &amp; Tooling",
      decodedTitle: "Build & Tooling",
      titleFixed: true,
      contentFixed: true,
    })

    expect(client.pages.update).toHaveBeenCalledWith({
      page_id: "m1",
      properties: {
        Title: { title: [{ text: { content: "Build & Tooling" } }] },
      },
    })
    expect(client.pages.updateMarkdown).toHaveBeenCalledWith({
      page_id: "m1",
      type: "replace_content",
      replace_content: {
        new_str: "Rollup & Vite",
        allow_deleting_content: true,
      },
    })
  })

  it("dry-run returns the plan without writing", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [memoryPage({ id: "m1", title: "Build &amp; Tooling" })],
        },
      ],
      markdownByPageId: { m1: "Rollup &amp; Vite" },
    })

    const report = await fixMemoryEncoding(client, DB, { dryRun: true })
    expect(report.encoded).toHaveLength(1)
    expect(report.fixes).toEqual([])
    expect(client.pages.update).not.toHaveBeenCalled()
    expect(client.pages.updateMarkdown).not.toHaveBeenCalled()
  })

  it("fixes Title but skips body rewrite when the body exceeds the size cap", async () => {
    const bigBody = "Body &amp; ".repeat(20_000)
    const client = createMockClient({
      queryResponses: [
        {
          results: [memoryPage({ id: "m1", title: "Big &amp; Chunky" })],
        },
      ],
      markdownByPageId: { m1: bigBody },
    })

    const report = await fixMemoryEncoding(client, DB, { dryRun: false })
    expect(report.oversizedSkipped).toHaveLength(1)
    expect(report.fixes).toHaveLength(1)
    expect(report.fixes[0].titleFixed).toBe(true)
    expect(report.fixes[0].contentFixed).toBe(false)

    expect(client.pages.update).toHaveBeenCalledTimes(1)
    expect(client.pages.updateMarkdown).not.toHaveBeenCalled()
  })

  it("is idempotent — re-running on already-clean rows writes nothing", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [memoryPage({ id: "m1", title: "Build & Tooling" })],
        },
      ],
      markdownByPageId: { m1: "Rollup & Vite" },
    })

    const report = await fixMemoryEncoding(client, DB, { dryRun: false })
    expect(report.fixes).toEqual([])
    expect(client.pages.update).not.toHaveBeenCalled()
    expect(client.pages.updateMarkdown).not.toHaveBeenCalled()
  })

  it("surfaces clean-title fetch-fail rows in contentFetchFailures without issuing a write", async () => {
    const client = createMockClient({
      queryResponses: [
        { results: [memoryPage({ id: "m-opaque", title: "clean title" })] },
      ],
    })
    ;(client.pages.retrieveMarkdown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("transient 5xx")
    )

    const report = await fixMemoryEncoding(client, DB, { dryRun: false })
    expect(report.contentFetchFailures).toHaveLength(1)
    expect(report.contentFetchFailures[0].id).toBe("m-opaque")
    // Nothing actionable → no fix, no write.
    expect(report.fixes).toEqual([])
    expect(client.pages.update).not.toHaveBeenCalled()
    expect(client.pages.updateMarkdown).not.toHaveBeenCalled()
  })

  it("skips body rewrite when the fetch failed but still fixes Title", async () => {
    const client = createMockClient({
      queryResponses: [
        { results: [memoryPage({ id: "m1", title: "Broken &amp; Body" })] },
      ],
    })
    ;(client.pages.retrieveMarkdown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Request to Notion API has timed out")
    )

    const report = await fixMemoryEncoding(client, DB, { dryRun: false })
    expect(report.contentFetchFailures).toHaveLength(1)
    expect(report.fixes).toHaveLength(1)
    expect(report.fixes[0].titleFixed).toBe(true)
    expect(report.fixes[0].contentFixed).toBe(false)
    expect(client.pages.update).toHaveBeenCalledTimes(1)
    expect(client.pages.updateMarkdown).not.toHaveBeenCalled()
  })

  it("leaves archived rows untouched during apply", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            memoryPage({ id: "m1", title: "Build &amp; Tooling", archived: true }),
            memoryPage({ id: "m2", title: "Clean Title" }),
          ],
        },
      ],
      markdownByPageId: { m1: "body", m2: "body" },
    })

    const report = await fixMemoryEncoding(client, DB, { dryRun: false })
    expect(report.fixes).toEqual([])
    expect(client.pages.update).not.toHaveBeenCalled()
  })
})
