import { afterEach, describe, expect, it, vi } from "vitest"
import { APIErrorCode, APIResponseError } from "@notionhq/client"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { MEMORY_PROPS } from "../notion/schema.js"
import {
  BODY_SIZE_CAP_BYTES,
  buildEntitySubstitutions,
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
  // RunTool dispatch path (issue #534 AC #5). Defaults to a successful
  // bare-resource response; tests that want to exercise fall-back-able
  // failures override `request` directly on the returned client.
  const requestMock = vi.fn(async () => ({ page_id: "ok" }))
  return {
    pages: {
      update: vi.fn().mockResolvedValue({}),
      retrieveMarkdown: retrieveMarkdownMock,
      updateMarkdown: vi.fn().mockResolvedValue({}),
    },
    dataSources: { query: queryMock },
    request: requestMock,
  } as unknown as Client & {
    pages: {
      update: ReturnType<typeof vi.fn>
      retrieveMarkdown: ReturnType<typeof vi.fn>
      updateMarkdown: ReturnType<typeof vi.fn>
    }
    dataSources: { query: ReturnType<typeof vi.fn> }
    request: ReturnType<typeof vi.fn>
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
      // Default-off path uses canonical full-body replace, never the
      // anchored RunTool path. Field carries `false` so the report
      // can distinguish how a given fix landed across mixed-flag
      // workspaces (issue #534 AC #5).
      contentFixedViaAnchoredPatterns: false,
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

describe("buildEntitySubstitutions (issue #534 AC #5)", () => {
  it("emits one substitution per unique entity, sorted longest-first", async () => {
    // Length-descending sort is load-bearing for non-overlapping
    // entities of different lengths (e.g. `&nbsp;` vs `&lt;`): under
    // `replace_all_matches: true` substitutions apply in array order,
    // and longer patterns run first so they cannot be partially
    // chewed by shorter ones. Multi-pass decoding (e.g. `&amp;amp;`
    // → `&amp;` → `&`) is handled separately by the single-pass
    // equivalence guard in `tryFixContentViaAnchoredPatterns` —
    // bodies that need >1 pass route through the canonical path.
    const updates = buildEntitySubstitutions(
      "&amp; once; &amp; twice; &nbsp; nbsp; &lt; one; &nbsp; nbsp"
    )
    expect(updates.map((u) => u.oldStr)).toEqual(["&nbsp;", "&amp;", "&lt;"])
    for (const u of updates) {
      expect(u.replaceAllMatches).toBe(true)
    }
  })

  it("returns an empty list when the body has no entities", () => {
    expect(buildEntitySubstitutions("plain text body")).toEqual([])
  })

  it("decodes named, numeric, and hex entities", () => {
    const updates = buildEntitySubstitutions("&amp; &#39; &#x27; &nbsp; &lt;")
    const map = new Map(updates.map((u) => [u.oldStr, u.newStr]))
    expect(map.get("&amp;")).toBe("&")
    expect(map.get("&#39;")).toBe("'")
    expect(map.get("&#x27;")).toBe("'")
    // Skip nbsp's exact char check since the entities library may map it
    // to U+00A0; just confirm it resolved away from the literal entity.
    expect(map.get("&nbsp;")).not.toBe("&nbsp;")
    expect(map.get("&lt;")).toBe("<")
  })
})

describe("fixMemoryEncoding — anchored RunTool path (issue #534 AC #5)", () => {
  const ID = "11111111111111111111111111111111"

  afterEach(() => {
    delete process.env.LORE_USE_RUNTOOL_BLOCK_EDIT
    delete process.env.LORE_USE_RUNTOOL
  })

  it("dispatches a 200KB body through update_content with sparse entity substitutions — wire payload is NOT the full body", async () => {
    // Acceptance criterion #5 pin: a 200KB fixture must be fixed via
    // `update_content` without a Lore-side full-body replace. We
    // construct a body whose entities are sparse (a handful of `&amp;`
    // sprinkled across the body) and assert two facts:
    //   1. `pages.updateMarkdown` is NOT called for this row (no
    //      full-body REST rewrite).
    //   2. The `client.request` payload's substitution list is small
    //      (entities only) — concretely, much smaller than the body.
    process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "1"
    const filler = "x".repeat(200 * 1024)
    const body = `${filler.slice(0, 50_000)} &amp; ${filler.slice(50_000, 150_000)} &amp; ${filler.slice(150_000)}`
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(BODY_SIZE_CAP_BYTES)

    const client = createMockClient({
      queryResponses: [{ results: [memoryPage({ id: ID, title: "clean title" })] }],
      markdownByPageId: { [ID]: body },
    })

    const report = await fixMemoryEncoding(client, DB, { dryRun: false })

    // No full-body rewrite happened.
    expect(client.pages.updateMarkdown).not.toHaveBeenCalled()
    // RunTool dispatch happened exactly once.
    expect(client.request).toHaveBeenCalledTimes(1)
    const call = client.request.mock.calls[0]![0] as {
      path: string
      method: string
      body: {
        update_page: {
          content_updates: Array<{
            old_str: string
            new_str: string
            replace_all_matches?: boolean
          }>
        }
      }
    }
    expect(call.path).toBe("tools/run")
    // Wire payload size: just the entity substitutions, NOT the body.
    const wireBytes = Buffer.byteLength(JSON.stringify(call.body), "utf8")
    expect(wireBytes).toBeLessThan(1024) // The substitutions list is tiny.
    expect(wireBytes).toBeLessThan(Buffer.byteLength(body, "utf8") / 100)
    // The substitution shape is what we expect.
    expect(call.body.update_page.content_updates).toEqual([
      { old_str: "&amp;", new_str: "&", replace_all_matches: true },
    ])

    // Report bucket is correct: row appears in `fixes` with the
    // anchored-path flag set, NOT in `oversizedSkipped`.
    expect(report.fixes).toHaveLength(1)
    expect(report.fixes[0]!.id).toBe(ID)
    expect(report.fixes[0]!.contentFixed).toBe(true)
    expect(report.fixes[0]!.contentFixedViaAnchoredPatterns).toBe(true)
    expect(report.oversizedSkipped).toEqual([])
  })

  it("falls back to canonical replace_content for non-oversized bodies on RunTool fall-back-able failure", async () => {
    process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "1"
    const client = createMockClient({
      queryResponses: [{ results: [memoryPage({ id: ID, title: "clean title" })] }],
      markdownByPageId: { [ID]: "small body with &amp; one entity" },
    })
    // Simulate a `restricted_resource` 403 (security review B1) on
    // RunTool. The non-oversized body must drop into the canonical
    // `pages.updateMarkdown` path so the migration still lands.
    client.request.mockRejectedValueOnce(
      new APIResponseError({
        code: APIErrorCode.RestrictedResource,
        status: 403,
        message: "Only public integrations can access this API.",
        headers: new Headers(),
        rawBodyText: "{}",
        additional_data: undefined,
        request_id: undefined,
      })
    )
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const report = await fixMemoryEncoding(client, DB, { dryRun: false })
      expect(client.request).toHaveBeenCalledTimes(1)
      expect(client.pages.updateMarkdown).toHaveBeenCalledTimes(1)
      expect(report.fixes[0]!.contentFixed).toBe(true)
      expect(report.fixes[0]!.contentFixedViaAnchoredPatterns).toBe(false)
      expect(report.oversizedSkipped).toEqual([])
      const writes = stderrSpy.mock.calls.map((args) => String(args[0]))
      expect(
        writes.some(
          (w) =>
            w.includes("source=memory-encoding-anchored-patterns") &&
            w.includes("reason=restricted_resource") &&
            w.includes("runtool-fallback=1") &&
            w.includes("used-rest=1")
        )
      ).toBe(true)
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it("re-buckets oversized rows as oversizedSkipped when RunTool fails fall-back-able", async () => {
    // When the body is oversized AND the anchored path returns a
    // fall-back-able signal, the canonical full-body path can't run
    // (it skips above the cap). The row remains unfixed and we
    // surface it in `oversizedSkipped` so the migration report tells
    // the operator the body wasn't repaired.
    process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "1"
    const filler = "x".repeat(BODY_SIZE_CAP_BYTES + 1024)
    const body = `${filler} &amp; suffix`
    const client = createMockClient({
      queryResponses: [{ results: [memoryPage({ id: ID, title: "clean title" })] }],
      markdownByPageId: { [ID]: body },
    })
    // No-match: server didn't find the substitution anchor (rare
    // race or unexpected body shape).
    client.request.mockRejectedValueOnce(
      new APIResponseError({
        code: APIErrorCode.ValidationError,
        status: 400,
        message: "old_str did not match any content on the page",
        headers: new Headers(),
        rawBodyText: "{}",
        additional_data: undefined,
        request_id: undefined,
      })
    )

    const report = await fixMemoryEncoding(client, DB, { dryRun: false })
    expect(client.request).toHaveBeenCalledTimes(1)
    expect(client.pages.updateMarkdown).not.toHaveBeenCalled()
    // Row appears in oversizedSkipped (not in fixes for body) — same
    // bucket as the default-off skip.
    expect(report.oversizedSkipped).toHaveLength(1)
    expect(report.oversizedSkipped[0]!.id).toBe(ID)
    expect(report.fixes).toEqual([])
  })

  it("falls back to canonical path for multi-pass entity bodies (e.g. &amp;amp;)", async () => {
    // Multi-pass decoding: the fixed-point loop in `decodeTextEntities`
    // peels `&amp;amp;` → `&amp;` → `&` across two passes. The
    // anchored path runs ONE `update_content` call; the
    // single-pass-equivalence guard returns false on multi-pass
    // bodies so the canonical path takes over and preserves the
    // existing fixed-point behavior.
    process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "1"
    const client = createMockClient({
      queryResponses: [{ results: [memoryPage({ id: ID, title: "clean title" })] }],
      markdownByPageId: { [ID]: "Body with &amp;amp; double-encoded" },
    })

    const report = await fixMemoryEncoding(client, DB, { dryRun: false })
    // RunTool dispatch was NOT attempted — single-pass guard caught
    // the multi-pass shape locally before the wire call.
    expect(client.request).not.toHaveBeenCalled()
    // Canonical path ran instead, producing the fully-decoded body.
    expect(client.pages.updateMarkdown).toHaveBeenCalledTimes(1)
    const call = client.pages.updateMarkdown.mock.calls[0]![0] as {
      replace_content: { new_str: string }
    }
    expect(call.replace_content.new_str).toBe("Body with & double-encoded")
    expect(report.fixes[0]!.contentFixedViaAnchoredPatterns).toBe(false)
  })

  it("rethrows non-fall-back-able RunTool errors (401, 429, 5xx) to preserve the auth-refresh / backoff gates", async () => {
    process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "1"
    const client = createMockClient({
      queryResponses: [{ results: [memoryPage({ id: ID, title: "clean title" })] }],
      markdownByPageId: { [ID]: "small body with &amp;" },
    })
    const unauthorized = new APIResponseError({
      code: APIErrorCode.Unauthorized,
      status: 401,
      message: "unauthorized",
      headers: new Headers(),
      rawBodyText: "{}",
      additional_data: undefined,
      request_id: undefined,
    })
    client.request.mockRejectedValueOnce(unauthorized)

    await expect(fixMemoryEncoding(client, DB, { dryRun: false })).rejects.toBe(
      unauthorized
    )
    // Canonical path was NOT attempted — silently falling back on
    // 401 would mask a credential failure and let the auth-refresh
    // proxy's retry attempt slip past.
    expect(client.pages.updateMarkdown).not.toHaveBeenCalled()
  })

  it("default-off: oversized bodies are skipped exactly as before (paired flag-state assertion)", async () => {
    // Principal review #5 posture: the meaningful default-off test
    // pairs flag-on (which MUST exercise the anchored path on
    // oversized) with flag-off (which MUST skip oversized). A
    // regression that lost the resolved block-edit feature flag check
    // in `memory-encoding.ts` would break the flag-off semantics
    // and a regression that lost the oversized fix would break the
    // flag-on semantics. Both phases are required.
    const filler = "x".repeat(BODY_SIZE_CAP_BYTES + 1024)
    const body = `${filler} &amp; tail`

    // Phase 1: flag ON — oversized must be fixed via anchored path.
    process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "1"
    const onClient = createMockClient({
      queryResponses: [{ results: [memoryPage({ id: ID, title: "clean title" })] }],
      markdownByPageId: { [ID]: body },
    })
    const onReport = await fixMemoryEncoding(onClient, DB, { dryRun: false })
    expect(onClient.request).toHaveBeenCalledTimes(1)
    expect(onReport.fixes).toHaveLength(1)
    expect(onReport.oversizedSkipped).toEqual([])

    // Phase 2: flag explicitly OFF — oversized must skip and
    // `client.request` must NOT be called. Issue #543 flipped the
    // default to ON, so flag-off must be set explicitly here rather
    // than relying on env-unset.
    process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "0"
    process.env.LORE_USE_RUNTOOL = "0"
    const offClient = createMockClient({
      queryResponses: [{ results: [memoryPage({ id: ID, title: "clean title" })] }],
      markdownByPageId: { [ID]: body },
    })
    const offReport = await fixMemoryEncoding(offClient, DB, { dryRun: false })
    expect(offClient.request).not.toHaveBeenCalled()
    // Body wasn't fixed; row appears in oversizedSkipped.
    expect(offReport.oversizedSkipped).toHaveLength(1)
    expect(offReport.oversizedSkipped[0]!.id).toBe(ID)
    expect(offClient.pages.updateMarkdown).not.toHaveBeenCalled()
  })

  it("uses resolved feature flags instead of rereading ambient env during the scan", async () => {
    process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "1"
    const filler = "x".repeat(BODY_SIZE_CAP_BYTES + 1024)
    const body = `${filler} &amp; tail`
    const client = createMockClient({
      queryResponses: [{ results: [memoryPage({ id: ID, title: "clean title" })] }],
      markdownByPageId: { [ID]: body },
    })

    const report = await fixMemoryEncoding(client, DB, {
      dryRun: false,
      features: { runTool: { blockEdit: false } },
    })

    expect(client.request).not.toHaveBeenCalled()
    expect(client.pages.updateMarkdown).not.toHaveBeenCalled()
    expect(report.oversizedSkipped).toHaveLength(1)
    expect(report.oversizedSkipped[0]!.id).toBe(ID)
  })

  it("idempotent: a second run after a successful anchored fix finds nothing to fix", async () => {
    // The anchored path's contract is identical to the canonical
    // path on this axis: after a successful fix, re-running the
    // migration sees the decoded body and walks past it.
    process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "1"
    const filler = "x".repeat(BODY_SIZE_CAP_BYTES + 1024)
    const stateByPage: Record<string, string> = {
      [ID]: `${filler} &amp; tail`,
    }
    const client = createMockClient({
      queryResponses: [
        { results: [memoryPage({ id: ID, title: "clean title" })] },
        { results: [memoryPage({ id: ID, title: "clean title" })] },
      ],
      markdownByPageId: stateByPage,
    })
    // Apply the substitution to the in-memory state on the first
    // RunTool call so the second pass observes the post-decode body.
    client.request.mockImplementationOnce(async (args: unknown) => {
      const payload = args as {
        body: {
          update_page: {
            page_id: string
            content_updates: Array<{ old_str: string; new_str: string }>
          }
        }
      }
      let body = stateByPage[payload.body.update_page.page_id] ?? ""
      for (const u of payload.body.update_page.content_updates) {
        body = body.split(u.old_str).join(u.new_str)
      }
      stateByPage[payload.body.update_page.page_id] = body
      return { page_id: payload.body.update_page.page_id }
    })

    const first = await fixMemoryEncoding(client, DB, { dryRun: false })
    expect(first.fixes).toHaveLength(1)
    expect(first.fixes[0]!.contentFixedViaAnchoredPatterns).toBe(true)

    // Second pass: same client instance, same in-memory state. The
    // post-decode body has no entities, so `findEncodedMemories`
    // skips it.
    const second = await fixMemoryEncoding(client, DB, { dryRun: false })
    expect(second.encoded).toEqual([])
    expect(second.fixes).toEqual([])
  })
})
