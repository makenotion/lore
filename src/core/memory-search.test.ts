import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { defaultFeatureFlags, type LoreFeatureFlags } from "../feature-flags.js"
import { MEMORY_PROPS } from "../notion/schema.js"
import type { DatabaseRef, Memory } from "../types.js"
import {
  HYBRID_FALLBACK_THRESHOLD,
  MemorySearch,
  SemanticSearchUnavailableError,
  tieBreakingRrfCompare,
  type RrfEntry,
} from "./memory-search.js"

const DB: DatabaseRef = {
  databaseId: "memories-db",
  dataSourceId: "memories-ds",
}

type FeatureOverrides = Partial<Omit<LoreFeatureFlags, "runTool">> & {
  runTool?: Partial<LoreFeatureFlags["runTool"]>
}

function features(overrides: FeatureOverrides = {}): LoreFeatureFlags {
  const defaults = defaultFeatureFlags()
  return {
    ...defaults,
    ...overrides,
    runTool: {
      ...defaults.runTool,
      search: true,
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
    lastReferencedAt?: string | null
    source?: string
  } = {}
): PageObjectResponse {
  const title = options.title ?? id
  const confidenceScore = options.confidenceScore ?? null
  const pinned = options.pinned ?? false
  const lastReferencedAt = options.lastReferencedAt ?? null
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
        select: { name: options.source ?? "manual" },
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
      [MEMORY_PROPS.LAST_REFERENCED_AT]: {
        type: "date",
        date: lastReferencedAt ? { start: lastReferencedAt } : null,
      } as unknown,
    } as PageObjectResponse["properties"],
  } as PageObjectResponse
}

function expectedConfidenceFactors(
  storedConfidenceFactor = 1.0,
  effectiveConfidenceFactor = storedConfidenceFactor
) {
  return {
    confidenceFactor: effectiveConfidenceFactor,
    storedConfidenceFactor,
    effectiveConfidenceFactor,
  }
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

function semanticPageId(index: number): string {
  return `00000000-0000-0000-0000-${(index + 1).toString().padStart(12, "0")}`
}

function makeSubject(
  args: {
    containsPages?: PageObjectResponse[]
    semanticPages?: PageObjectResponse[]
    semanticSearchType?: "ai_search" | "workspace_search" | "none"
    semanticRawHitCount?: number
    featureOverrides?: FeatureOverrides
  } = {}
): {
  searcher: MemorySearch
  querySpy: ReturnType<typeof vi.fn>
  searchSpy: ReturnType<typeof vi.fn>
  requestSpy: ReturnType<typeof vi.fn>
  retrieveSpy: ReturnType<typeof vi.fn>
  materializeSpy: ReturnType<typeof vi.fn>
} {
  const semanticPages = args.semanticPages ?? []
  const pagesByRetrieveId = new Map(
    semanticPages.map((p, index) => [semanticPageId(index), p] as const)
  )
  const querySpy = vi.fn(async () => ({
    results: args.containsPages ?? [],
    has_more: false,
    next_cursor: null,
  }))
  const searchSpy = vi.fn(async () => ({
    results: [],
    has_more: false,
    next_cursor: null,
  }))
  const requestSpy = vi.fn(async ({ body }: { body: Record<string, unknown> }) => {
    const search = (body as { search: { page_size: number } }).search
    const rawHitCount = args.semanticRawHitCount ?? semanticPages.length
    const results = Array.from({ length: rawHitCount }, (_, index) => {
      const pageId = semanticPageId(index)
      const pageForTitle = semanticPages[index]
      return {
        id: `resource-${index}`,
        title: pageForTitle?.id ?? `external-${index}`,
        url: pageForTitle === undefined ? `https://example.com/${index}` : pageId,
        type: pageForTitle === undefined ? "external" : "page",
        highlight: "",
        timestamp: "2026-05-01T00:00:00.000Z",
      }
    }).slice(0, search.page_size)
    return {
      type: args.semanticSearchType ?? ("ai_search" as const),
      results,
    }
  })
  const retrieveSpy = vi.fn(async ({ page_id }: { page_id: string }) => {
    const page = pagesByRetrieveId.get(page_id)
    if (!page) throw new Error(`unknown semantic page ${page_id}`)
    return page
  })
  const materializeSpy = vi.fn(async (pages: PageObjectResponse[]) =>
    pages.map(memoryForPage)
  )
  const client = {
    dataSources: { query: querySpy },
    search: searchSpy,
    request: requestSpy,
    pages: {
      retrieve: retrieveSpy,
    },
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
    requestSpy,
    retrieveSpy,
    materializeSpy,
  }
}

describe("MemorySearch mode selection", () => {
  it("contains mode excludes agent_diary rows", async () => {
    const { searcher, querySpy } = makeSubject()

    await searcher.search({
      query: "retry",
      mode: "contains",
      limit: 3,
    })

    const serialized = JSON.stringify(querySpy.mock.calls[0]![0].filter)
    expect(serialized).toContain(MEMORY_PROPS.SOURCE)
    expect(serialized).toContain("does_not_equal")
    expect(serialized).toContain("agent_diary")
  })

  it("semantic mode filters agent_diary rows before materialization", async () => {
    const { searcher, materializeSpy } = makeSubject({
      semanticPages: [
        page("diary", { source: "agent_diary" }),
        page("normal", { source: "manual" }),
      ],
    })

    const memories = await searcher.search({
      query: "retry",
      mode: "semantic",
      limit: 2,
    })

    expect(memories.map((memory) => memory.id)).toEqual(["normal"])
    expect(materializeSpy.mock.calls[0]![0].map((p: PageObjectResponse) => p.id)).toEqual(
      ["normal"]
    )
  })

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
        ...expectedConfidenceFactors(),
      },
    ])
  })

  it("semantic mode uses RunTool AI search and explains semantic ranks", async () => {
    const { searcher, querySpy, searchSpy, requestSpy, retrieveSpy } = makeSubject({
      containsPages: [page("contains-hit")],
      semanticPages: [page("semantic-hit")],
    })

    const { memories, explain } = await searcher.searchWithExplain({
      query: "semantic",
      mode: "semantic",
      includeContent: false,
    })

    expect(querySpy).not.toHaveBeenCalled()
    expect(searchSpy).not.toHaveBeenCalled()
    expect(requestSpy).toHaveBeenCalledTimes(1)
    expect(requestSpy.mock.calls[0][0]).toMatchObject({
      method: "post",
      path: "tools/run",
    })
    expect(retrieveSpy).toHaveBeenCalledTimes(1)
    expect(memories.map((m) => m.id)).toEqual(["semantic-hit"])
    expect(explain).toEqual([
      {
        memoryId: "semantic-hit",
        containsRank: null,
        semanticRank: 0,
        rrfScore: null,
        branch: "semantic-only",
        ...expectedConfidenceFactors(),
      },
    ])
  })

  it("hybrid mode runs both search branches before RRF ranking", async () => {
    const { searcher, querySpy, searchSpy, requestSpy } = makeSubject({
      containsPages: [page("contains-hit")],
      semanticPages: [page("semantic-hit")],
    })

    const { explain } = await searcher.searchWithExplain({
      query: "hybrid",
      mode: "hybrid",
      includeContent: false,
    })

    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).not.toHaveBeenCalled()
    expect(requestSpy).toHaveBeenCalledTimes(1)
    expect(explain.every((entry) => entry.branch === "rrf")).toBe(true)
  })

  it("forceSemanticSearch routes even an explicit contains request through semantic mode", async () => {
    const { searcher, querySpy, searchSpy, requestSpy } = makeSubject({
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
    expect(searchSpy).not.toHaveBeenCalled()
    expect(requestSpy).toHaveBeenCalledTimes(1)
    expect(memories.map((m) => m.id)).toEqual(["semantic-hit"])
    expect(explain[0].branch).toBe("semantic-only")
  })

  it("semantic mode fails loud when RunTool search is disabled", async () => {
    const { searcher, searchSpy, requestSpy } = makeSubject({
      semanticPages: [page("semantic-hit")],
      featureOverrides: { runTool: { search: false } },
    })

    await expect(
      searcher.search({
        query: "semantic",
        mode: "semantic",
      })
    ).rejects.toThrow(SemanticSearchUnavailableError)
    expect(requestSpy).not.toHaveBeenCalled()
    expect(searchSpy).not.toHaveBeenCalled()
  })

  it("semantic mode fails loud for empty AI queries", async () => {
    const { searcher, searchSpy, requestSpy } = makeSubject({
      semanticPages: [page("semantic-hit")],
    })

    await expect(
      searcher.search({
        query: "   ",
        mode: "semantic",
      })
    ).rejects.toThrow(/AI semantic search unavailable: query must contain/)
    expect(requestSpy).not.toHaveBeenCalled()
    expect(searchSpy).not.toHaveBeenCalled()
  })

  it.each(["workspace_search", "none"] as const)(
    "semantic mode fails loud when RunTool returns %s",
    async (searchType) => {
      const { searcher, searchSpy, requestSpy } = makeSubject({
        semanticPages: [page("semantic-hit")],
        semanticSearchType: searchType,
      })

      await expect(
        searcher.search({
          query: "semantic",
          mode: "semantic",
        })
      ).rejects.toThrow(new RegExp(`RunTool search returned ${searchType}`))
      expect(requestSpy).toHaveBeenCalledTimes(1)
      expect(searchSpy).not.toHaveBeenCalled()
    }
  )

  it("hybrid surfaces semantic unavailability even when contains also fails", async () => {
    const { searcher, querySpy } = makeSubject({
      semanticPages: [page("semantic-hit")],
      semanticSearchType: "workspace_search",
    })
    querySpy.mockRejectedValueOnce(new Error("contains unavailable"))

    await expect(
      searcher.search({
        query: "semantic",
        mode: "hybrid",
      })
    ).rejects.toThrow(/AI semantic search unavailable: RunTool search returned/)
  })
})

describe("MemorySearch hybrid ranking", () => {
  it("returns contains results on saturation without merging semantic rows", async () => {
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
        ...expectedConfidenceFactors(),
      }))
    )
  })

  it("hybrid saturation preserves contains order and exposes confidence diagnostics", async () => {
    const { searcher } = makeSubject({
      containsPages: [
        page("stale-stored-high", {
          confidenceScore: 0.9,
          lastReferencedAt: "2000-01-01",
        }),
        page("fresh-stored-lower", {
          confidenceScore: 0.8,
          lastReferencedAt: "2999-01-01",
        }),
        page("fresh-third", {
          confidenceScore: 0.7,
          lastReferencedAt: "2999-01-01",
        }),
      ],
      semanticPages: [page("semantic-only")],
    })

    const { memories, explain } = await searcher.searchWithExplain({
      query: "saturated",
      mode: "hybrid",
      includeContent: false,
    })

    expect(memories.map((m) => m.id)).toEqual([
      "stale-stored-high",
      "fresh-stored-lower",
      "fresh-third",
    ])
    expect(memories.map((m) => m.id)).not.toContain("semantic-only")
    expect(explain.every((entry) => entry.branch === "contains-saturated")).toBe(true)
    expect(
      explain.map((entry) => ({
        id: entry.memoryId,
        containsRank: entry.containsRank,
      }))
    ).toEqual([
      { id: "stale-stored-high", containsRank: 0 },
      { id: "fresh-stored-lower", containsRank: 1 },
      { id: "fresh-third", containsRank: 2 },
    ])
    const stale = explain.find((entry) => entry.memoryId === "stale-stored-high")!
    expect(stale.storedConfidenceFactor).toBeCloseTo(0.95, 10)
    expect(stale.effectiveConfidenceFactor).toBeLessThan(0.9)
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
        ...expectedConfidenceFactors(),
      },
      {
        memoryId: "semantic-only",
        containsRank: null,
        semanticRank: 0,
        rrfScore: expect.closeTo(1 / 61, 10),
        branch: "rrf",
        ...expectedConfidenceFactors(),
      },
      {
        memoryId: "contains-only",
        containsRank: 1,
        semanticRank: null,
        rrfScore: expect.closeTo(1 / 62, 10),
        branch: "rrf",
        ...expectedConfidenceFactors(),
      },
    ])
  })

  it("contains mode preserves Notion order while exposing confidence diagnostics", async () => {
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

    expect(memories.map((m) => m.id)).toEqual(["rank-0-decayed", "rank-1-trusted"])
    expect(explain.map((entry) => entry.confidenceFactor)).toEqual([0.5, 1.0])
  })

  it("contains mode reports effective confidence decay without reranking", async () => {
    const { searcher } = makeSubject({
      containsPages: [
        page("stale-stored-high", {
          confidenceScore: 0.9,
          lastReferencedAt: "2000-01-01",
        }),
        page("fresh-stored-lower", {
          confidenceScore: 0.8,
          lastReferencedAt: "2999-01-01",
        }),
      ],
    })

    const { memories, explain } = await searcher.searchWithExplain({
      query: "confidence",
      mode: "contains",
      includeContent: false,
    })

    expect(memories.map((m) => m.id)).toEqual(["stale-stored-high", "fresh-stored-lower"])
    const stale = explain.find((entry) => entry.memoryId === "stale-stored-high")!
    expect(stale.storedConfidenceFactor).toBeCloseTo(0.95, 10)
    expect(stale.effectiveConfidenceFactor).toBeLessThan(0.9)
    expect(stale.confidenceFactor).toBe(stale.effectiveConfidenceFactor)
  })

  it("semantic mode preserves AI order regardless of effective confidence decay", async () => {
    const { searcher } = makeSubject({
      semanticPages: [
        page("stale-stored-high", {
          confidenceScore: 0.9,
          lastReferencedAt: "2000-01-01",
        }),
        page("fresh-stored-lower", {
          confidenceScore: 0.8,
          lastReferencedAt: "2999-01-01",
        }),
      ],
    })

    const { memories, explain } = await searcher.searchWithExplain({
      query: "confidence",
      mode: "semantic",
      includeContent: false,
    })

    expect(memories.map((m) => m.id)).toEqual(["stale-stored-high", "fresh-stored-lower"])
    const stale = explain.find((entry) => entry.memoryId === "stale-stored-high")!
    expect(stale.storedConfidenceFactor).toBeCloseTo(0.95, 10)
    expect(stale.effectiveConfidenceFactor).toBeLessThan(0.9)
  })

  it("semantic mode returns saturated AI results without REST fallback", async () => {
    const semanticPages = Array.from({ length: 25 }, (_, index) =>
      page(`semantic-${index}`)
    )
    const { searcher, searchSpy, requestSpy } = makeSubject({ semanticPages })

    const { memories, capped } = await searcher.searchWithMeta({
      query: "semantic",
      mode: "semantic",
      limit: 5,
      includeContent: false,
    })

    expect(memories.map((m) => m.id)).toEqual([
      "semantic-0",
      "semantic-1",
      "semantic-2",
      "semantic-3",
      "semantic-4",
    ])
    expect(capped).toBe(true)
    expect(requestSpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).not.toHaveBeenCalled()
  })

  it("semantic mode clamps requests above the RunTool cap and reports capped", async () => {
    const semanticPages = Array.from({ length: 25 }, (_, index) =>
      page(`semantic-${index}`)
    )
    const { searcher, searchSpy, requestSpy } = makeSubject({ semanticPages })

    const { memories, capped } = await searcher.searchWithMeta({
      query: "semantic",
      mode: "semantic",
      limit: 26,
      includeContent: false,
    })

    expect(memories).toHaveLength(25)
    expect(capped).toBe(true)
    expect(requestSpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).not.toHaveBeenCalled()
  })

  it("hybrid RRF ignores confidence for ranking while exposing decay", async () => {
    const { searcher } = makeSubject({
      containsPages: [
        page("stale-stored-high", {
          confidenceScore: 0.9,
          lastReferencedAt: "2000-01-01",
        }),
        page("fresh-stored-lower", {
          confidenceScore: 0.8,
          lastReferencedAt: "2999-01-01",
        }),
      ],
      semanticPages: [],
    })

    const { memories, explain } = await searcher.searchWithExplain({
      query: "confidence",
      mode: "hybrid",
      includeContent: false,
    })

    expect(memories.map((m) => m.id)).toEqual(["stale-stored-high", "fresh-stored-lower"])
    expect(explain.every((entry) => entry.branch === "rrf")).toBe(true)
    const stale = explain.find((entry) => entry.memoryId === "stale-stored-high")!
    expect(stale.storedConfidenceFactor).toBeCloseTo(0.95, 10)
    expect(stale.effectiveConfidenceFactor).toBeLessThan(0.9)
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
