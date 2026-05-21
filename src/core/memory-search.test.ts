import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { defaultFeatureFlags, type LoreFeatureFlags } from "../feature-flags.js"
import { MEMORY_PROPS } from "../notion/schema.js"
import type { DatabaseRef, Memory } from "../types.js"
import {
  HYBRID_FALLBACK_THRESHOLD,
  MemorySearch,
  tieBreakingRrfCompare,
  type RrfEntry,
} from "./memory-search.js"

const DB: DatabaseRef = {
  databaseId: "memories-db",
  dataSourceId: "memories-ds",
}

function features(overrides: Partial<LoreFeatureFlags> = {}): LoreFeatureFlags {
  const defaults = defaultFeatureFlags()
  return {
    ...defaults,
    ...overrides,
    runTool: {
      ...defaults.runTool,
      search: false,
      ...overrides.runTool,
    },
  }
}

function page(
  id: string,
  options: {
    title?: string
    confidenceScore?: number | null
    pinned?: boolean
  } = {}
): PageObjectResponse {
  const title = options.title ?? id
  const confidenceScore = options.confidenceScore ?? null
  const pinned = options.pinned ?? false
  return {
    object: "page",
    id,
    created_time: "2026-05-01T00:00:00.000Z",
    last_edited_time: "2026-05-01T00:00:00.000Z",
    archived: false,
    url: `https://notion.so/${id}`,
    parent: { type: "data_source_id", data_source_id: DB.dataSourceId },
    properties: {
      [MEMORY_PROPS.TITLE]: {
        type: "title",
        title: [{ plain_text: title }],
      } as unknown,
      [MEMORY_PROPS.PROJECT]: { type: "relation", relation: [] } as unknown,
      [MEMORY_PROPS.TOPIC]: { type: "relation", relation: [] } as unknown,
      [MEMORY_PROPS.SOURCE]: {
        type: "select",
        select: { name: "manual" },
      } as unknown,
      [MEMORY_PROPS.KIND]: {
        type: "select",
        select: { name: "note" },
      } as unknown,
      [MEMORY_PROPS.STATUS]: {
        type: "select",
        select: { name: "informational" },
      } as unknown,
      [MEMORY_PROPS.TAGS]: { type: "multi_select", multi_select: [] } as unknown,
      [MEMORY_PROPS.KEYWORDS]: { type: "rich_text", rich_text: [] } as unknown,
      [MEMORY_PROPS.SYNOPSIS]: { type: "rich_text", rich_text: [] } as unknown,
      [MEMORY_PROPS.CONFIDENCE_SCORE]: {
        type: "number",
        number: confidenceScore,
      } as unknown,
      [MEMORY_PROPS.PINNED]: {
        type: "checkbox",
        checkbox: pinned,
      } as unknown,
    } as PageObjectResponse["properties"],
  } as PageObjectResponse
}

function missingPinnedPropertyError(): Error & { code: string } {
  const err = new Error(
    `Could not find property with name or id: ${MEMORY_PROPS.PINNED}`
  ) as Error & { code: string }
  err.code = "validation_error"
  return err
}

function memoryForPage(p: PageObjectResponse): Memory {
  return {
    id: p.id,
    title: p.id,
    content: "",
  } as Memory
}

function makeSubject(
  args: {
    containsPages?: PageObjectResponse[]
    semanticPages?: PageObjectResponse[]
    featureOverrides?: Partial<LoreFeatureFlags>
  } = {}
): {
  searcher: MemorySearch
  querySpy: ReturnType<typeof vi.fn>
  searchSpy: ReturnType<typeof vi.fn>
  materializeSpy: ReturnType<typeof vi.fn>
} {
  const querySpy = vi.fn(async () => ({
    results: args.containsPages ?? [],
    has_more: false,
    next_cursor: null,
  }))
  const searchSpy = vi.fn(async () => ({
    results: args.semanticPages ?? [],
    has_more: false,
    next_cursor: null,
  }))
  const materializeSpy = vi.fn(async (pages: PageObjectResponse[]) =>
    pages.map(memoryForPage)
  )
  const client = {
    dataSources: { query: querySpy },
    search: searchSpy,
  } as unknown as Client

  return {
    searcher: new MemorySearch(
      client,
      DB,
      features(args.featureOverrides),
      () => ({}),
      () => false,
      materializeSpy
    ),
    querySpy,
    searchSpy,
    materializeSpy,
  }
}

describe("MemorySearch mode selection", () => {
  it("contains mode pushes excludePinned into the Notion filter", async () => {
    const { searcher, querySpy } = makeSubject()

    await searcher.search({
      query: "retry",
      mode: "contains",
      excludePinned: true,
      limit: 3,
    })

    const serialized = JSON.stringify(querySpy.mock.calls[0]![0].filter)
    expect(serialized).toContain(MEMORY_PROPS.PINNED)
    expect(serialized).toContain("does_not_equal")
    expect(serialized).toContain("true")
  })

  it("contains mode retries excludePinned without the pinned filter on pre-migration vaults", async () => {
    const { searcher, querySpy } = makeSubject()
    querySpy.mockRejectedValueOnce(missingPinnedPropertyError()).mockResolvedValueOnce({
      results: [page("normal")],
      has_more: false,
      next_cursor: null,
    })

    const memories = await searcher.search({
      query: "retry",
      mode: "contains",
      excludePinned: true,
      limit: 3,
    })

    expect(memories.map((memory) => memory.id)).toEqual(["normal"])
    expect(querySpy).toHaveBeenCalledTimes(2)
    const firstFilter = JSON.stringify(querySpy.mock.calls[0]![0].filter)
    const retryFilter = JSON.stringify(querySpy.mock.calls[1]![0].filter)
    expect(firstFilter).toContain(MEMORY_PROPS.PINNED)
    expect(retryFilter).not.toContain(MEMORY_PROPS.PINNED)
    expect(retryFilter).toContain(MEMORY_PROPS.TITLE)
    expect(retryFilter).toContain(MEMORY_PROPS.KEYWORDS)
    expect(retryFilter).toContain(MEMORY_PROPS.SYNOPSIS)
    expect(retryFilter).toContain("retry")
  })

  it("semantic mode filters pinned rows before materialization", async () => {
    const { searcher, materializeSpy } = makeSubject({
      semanticPages: [page("pinned", { pinned: true }), page("normal")],
    })

    const memories = await searcher.search({
      query: "retry",
      mode: "semantic",
      excludePinned: true,
      limit: 2,
    })

    expect(memories.map((memory) => memory.id)).toEqual(["normal"])
    expect(materializeSpy.mock.calls[0]![0].map((p: PageObjectResponse) => p.id)).toEqual(
      ["normal"]
    )
  })

  it("contains mode uses dataSources.query and explains contains ranks", async () => {
    const { searcher, querySpy, searchSpy, materializeSpy } = makeSubject({
      containsPages: [page("contains-hit")],
      semanticPages: [page("semantic-hit")],
    })

    const { memories, explain } = await searcher.searchWithExplain({
      query: "contains",
      mode: "contains",
      includeContent: false,
    })

    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(querySpy.mock.calls[0][0]).toMatchObject({
      data_source_id: DB.dataSourceId,
      page_size: 100,
    })
    expect(searchSpy).not.toHaveBeenCalled()
    expect(materializeSpy).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "contains-hit" })],
      false
    )
    expect(memories.map((m) => m.id)).toEqual(["contains-hit"])
    expect(explain).toEqual([
      {
        memoryId: "contains-hit",
        containsRank: 0,
        semanticRank: null,
        rrfScore: null,
        branch: "contains-only",
        confidenceFactor: 1.0,
      },
    ])
  })

  it("semantic mode uses client.search and explains semantic ranks", async () => {
    const { searcher, querySpy, searchSpy } = makeSubject({
      containsPages: [page("contains-hit")],
      semanticPages: [page("semantic-hit")],
    })

    const { memories, explain } = await searcher.searchWithExplain({
      query: "semantic",
      mode: "semantic",
      includeContent: false,
    })

    expect(querySpy).not.toHaveBeenCalled()
    expect(searchSpy).toHaveBeenCalledTimes(1)
    expect(searchSpy.mock.calls[0][0]).toMatchObject({
      query: "semantic",
      filter: { property: "object", value: "page" },
      page_size: 100,
    })
    expect(memories.map((m) => m.id)).toEqual(["semantic-hit"])
    expect(explain).toEqual([
      {
        memoryId: "semantic-hit",
        containsRank: null,
        semanticRank: 0,
        rrfScore: null,
        branch: "semantic-only",
        confidenceFactor: 1.0,
      },
    ])
  })

  it("hybrid mode runs both search branches before RRF ranking", async () => {
    const { searcher, querySpy, searchSpy } = makeSubject({
      containsPages: [page("contains-hit")],
      semanticPages: [page("semantic-hit")],
    })

    const { explain } = await searcher.searchWithExplain({
      query: "hybrid",
      mode: "hybrid",
      includeContent: false,
    })

    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).toHaveBeenCalledTimes(1)
    expect(explain.every((entry) => entry.branch === "rrf")).toBe(true)
  })

  it("forceSemanticSearch routes even an explicit contains request through semantic mode", async () => {
    const { searcher, querySpy, searchSpy } = makeSubject({
      containsPages: [page("contains-hit")],
      semanticPages: [page("semantic-hit")],
      featureOverrides: { forceSemanticSearch: true },
    })

    const { memories, explain } = await searcher.searchWithExplain({
      query: "forced",
      mode: "contains",
      includeContent: false,
    })

    expect(querySpy).not.toHaveBeenCalled()
    expect(searchSpy).toHaveBeenCalledTimes(1)
    expect(memories.map((m) => m.id)).toEqual(["semantic-hit"])
    expect(explain[0].branch).toBe("semantic-only")
  })
})

describe("MemorySearch hybrid ranking", () => {
  it("returns contains results on saturation without merging semantic fallback rows", async () => {
    const containsPages = Array.from({ length: HYBRID_FALLBACK_THRESHOLD }, (_, i) =>
      page(`contains-${i}`)
    )
    const { searcher } = makeSubject({
      containsPages,
      semanticPages: [page("semantic-only")],
    })

    const { memories, explain } = await searcher.searchWithExplain({
      query: "saturated",
      mode: "hybrid",
      includeContent: false,
    })

    expect(memories.map((m) => m.id)).toEqual(["contains-0", "contains-1", "contains-2"])
    expect(memories.map((m) => m.id)).not.toContain("semantic-only")
    expect(explain).toEqual(
      containsPages.map((p, rank) => ({
        memoryId: p.id,
        containsRank: rank,
        semanticRank: null,
        rrfScore: null,
        branch: "contains-saturated",
        confidenceFactor: 1.0,
      }))
    )
  })

  it("uses reciprocal-rank fusion for overlapping and branch-only rows", async () => {
    const { searcher } = makeSubject({
      containsPages: [page("overlap"), page("contains-only")],
      semanticPages: [page("semantic-only"), page("overlap")],
    })

    const { memories, explain } = await searcher.searchWithExplain({
      query: "rrf",
      mode: "hybrid",
      includeContent: false,
    })

    expect(memories.map((m) => m.id)).toEqual([
      "overlap",
      "semantic-only",
      "contains-only",
    ])
    expect(explain).toEqual([
      {
        memoryId: "overlap",
        containsRank: 0,
        semanticRank: 1,
        rrfScore: expect.closeTo(1 / 61 + 1 / 62, 10),
        branch: "rrf",
        confidenceFactor: 1.0,
      },
      {
        memoryId: "semantic-only",
        containsRank: null,
        semanticRank: 0,
        rrfScore: expect.closeTo(1 / 61, 10),
        branch: "rrf",
        confidenceFactor: 1.0,
      },
      {
        memoryId: "contains-only",
        containsRank: 1,
        semanticRank: null,
        rrfScore: expect.closeTo(1 / 62, 10),
        branch: "rrf",
        confidenceFactor: 1.0,
      },
    ])
  })

  it("applies confidence weighting before single-branch ordering", async () => {
    const { searcher } = makeSubject({
      containsPages: [
        page("rank-0-decayed", { confidenceScore: 0.0 }),
        page("rank-1-trusted", { confidenceScore: 1.0 }),
      ],
    })

    const { memories, explain } = await searcher.searchWithExplain({
      query: "confidence",
      mode: "contains",
      includeContent: false,
    })

    expect(memories.map((m) => m.id)).toEqual(["rank-1-trusted", "rank-0-decayed"])
    expect(explain.map((entry) => entry.confidenceFactor)).toEqual([1.0, 0.5])
  })

  it("pins the final deterministic page-id tie-break", () => {
    const a: RrfEntry = {
      page: { id: "aaa" } as PageObjectResponse,
      score: 1 / 61 + 1 / 62,
      containsRank: 1,
      semanticRank: 0,
      confidenceFactor: 1.0,
    }
    const z: RrfEntry = {
      page: { id: "zzz" } as PageObjectResponse,
      score: 1 / 61 + 1 / 62,
      containsRank: 0,
      semanticRank: 1,
      confidenceFactor: 1.0,
    }

    expect([z, a].sort(tieBreakingRrfCompare).map((entry) => entry.page.id)).toEqual([
      "aaa",
      "zzz",
    ])
  })
})
