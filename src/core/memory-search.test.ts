import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { searchViaRunTool } from "../notion/runtool/index.js"
import { defaultFeatureFlags, type LoreFeatureFlags } from "../feature-flags.js"
import { MEMORY_PROPS } from "../notion/schema.js"
import type { DatabaseRef, Memory, MemoryKind, MemorySource } from "../types.js"
import {
  HYBRID_FALLBACK_THRESHOLD,
  MemorySearch,
  SEMANTIC_SEARCH_MAX_PAGES,
  tieBreakingRrfCompare,
  type RrfEntry,
} from "./memory-search.js"

vi.mock("../notion/runtool/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../notion/runtool/index.js")>()
  return {
    ...actual,
    searchViaRunTool: vi.fn(),
  }
})

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
      search: false,
      ...overrides.runTool,
    },
  }
}

function page(
  id: string,
  options: {
    title?: string
    pinned?: boolean
    lastReferencedAt?: string | null
    source?: MemorySource
    kind?: MemoryKind
    projectIds?: string[]
  } = {}
): PageObjectResponse {
  const title = options.title ?? id
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
      [MEMORY_PROPS.PROJECT]: {
        type: "relation",
        relation: (options.projectIds ?? []).map((id) => ({ id })),
      } as unknown,
      [MEMORY_PROPS.TOPIC]: { type: "relation", relation: [] } as unknown,
      [MEMORY_PROPS.SOURCE]: {
        type: "select",
        select: { name: options.source ?? "manual" },
      } as unknown,
      [MEMORY_PROPS.KIND]: {
        type: "select",
        select: { name: options.kind ?? "note" },
      } as unknown,
      [MEMORY_PROPS.STATUS]: {
        type: "select",
        select: { name: "informational" },
      } as unknown,
      [MEMORY_PROPS.TAGS]: { type: "multi_select", multi_select: [] } as unknown,
      [MEMORY_PROPS.KEYWORDS]: { type: "rich_text", rich_text: [] } as unknown,
      [MEMORY_PROPS.SYNOPSIS]: { type: "rich_text", rich_text: [] } as unknown,
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
    featureOverrides?: FeatureOverrides
  } = {}
): {
  searcher: MemorySearch
  querySpy: ReturnType<typeof vi.fn>
  searchSpy: ReturnType<typeof vi.fn>
  retrieveSpy: ReturnType<typeof vi.fn>
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
  const retrieveSpy = vi.fn(async ({ page_id }: { page_id: string }) => page(page_id))
  const materializeSpy = vi.fn(async (pages: PageObjectResponse[]) =>
    pages.map(memoryForPage)
  )
  const client = {
    dataSources: { query: querySpy },
    pages: { retrieve: retrieveSpy },
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
    retrieveSpy,
    materializeSpy,
  }
}

describe("MemorySearch mode selection", () => {
  it("contains mode default-excludes non-knowledge sources and kinds", async () => {
    const { searcher, querySpy } = makeSubject()

    await searcher.search({
      query: "retry",
      mode: "contains",
      limit: 3,
    })

    const serialized = JSON.stringify(querySpy.mock.calls[0]![0].filter)
    expect(serialized).toContain(
      JSON.stringify({
        property: MEMORY_PROPS.SOURCE,
        select: { does_not_equal: "agent_diary" },
      })
    )
    expect(serialized).toContain(
      JSON.stringify({
        property: MEMORY_PROPS.SOURCE,
        select: { does_not_equal: "digest" },
      })
    )
    expect(serialized).toContain(
      JSON.stringify({
        property: MEMORY_PROPS.KIND,
        select: { does_not_equal: "task" },
      })
    )
    expect(serialized).toContain(
      JSON.stringify({
        property: MEMORY_PROPS.KIND,
        select: { does_not_equal: "operational" },
      })
    )
  })

  it("contains mode lets explicit source and kind requests bypass their default exclusions", async () => {
    const { searcher, querySpy } = makeSubject()

    await searcher.search({
      query: "retry",
      mode: "contains",
      source: "digest",
      kind: "task",
      limit: 3,
    })

    const serialized = JSON.stringify(querySpy.mock.calls[0]![0].filter)
    expect(serialized).toContain(
      JSON.stringify({
        property: MEMORY_PROPS.SOURCE,
        select: { equals: "digest" },
      })
    )
    expect(serialized).toContain(
      JSON.stringify({
        property: MEMORY_PROPS.KIND,
        select: { equals: "task" },
      })
    )
    expect(serialized).not.toContain('"does_not_equal":"digest"')
    expect(serialized).not.toContain('"does_not_equal":"agent_diary"')
    expect(serialized).not.toContain('"does_not_equal":"task"')
    expect(serialized).not.toContain('"does_not_equal":"operational"')
  })

  it("contains mode can restrict results to rows without project relations", async () => {
    const { searcher, querySpy } = makeSubject()

    await searcher.search({
      query: "retry",
      mode: "contains",
      unscopedOnly: true,
      limit: 3,
    })

    const serialized = JSON.stringify(querySpy.mock.calls[0]![0].filter)
    expect(serialized).toContain(
      JSON.stringify({
        property: MEMORY_PROPS.PROJECT,
        relation: { is_empty: true },
      })
    )
  })

  it("semantic mode post-filters non-knowledge sources and kinds by default", async () => {
    const { searcher, materializeSpy } = makeSubject({
      semanticPages: [
        page("agent-diary", { source: "agent_diary" }),
        page("digest", { source: "digest" }),
        page("task", { kind: "task" }),
        page("operational", { kind: "operational" }),
        page("decision", { kind: "decision" }),
        page("note"),
      ],
    })

    const memories = await searcher.search({
      query: "retry",
      mode: "semantic",
      limit: 6,
    })

    expect(memories.map((memory) => memory.id)).toEqual(["decision", "note"])
    expect(materializeSpy.mock.calls[0]![0].map((p: PageObjectResponse) => p.id)).toEqual(
      ["decision", "note"]
    )
  })

  it("semantic mode lets explicit source and kind requests bypass their default exclusions", async () => {
    const digestSearch = makeSubject({
      semanticPages: [page("digest", { source: "digest" }), page("manual")],
    })
    const taskSearch = makeSubject({
      semanticPages: [page("task", { kind: "task" }), page("note")],
    })

    const digestMemories = await digestSearch.searcher.search({
      query: "retry",
      mode: "semantic",
      source: "digest",
      limit: 2,
    })
    const taskMemories = await taskSearch.searcher.search({
      query: "retry",
      mode: "semantic",
      kind: "task",
      limit: 2,
    })

    expect(digestMemories.map((memory) => memory.id)).toEqual(["digest"])
    expect(taskMemories.map((memory) => memory.id)).toEqual(["task"])
  })

  it("semantic mode can post-filter to rows without project relations", async () => {
    const { searcher, materializeSpy } = makeSubject({
      semanticPages: [
        page("project-scoped", { projectIds: ["project-id"] }),
        page("unscoped"),
      ],
    })

    const memories = await searcher.search({
      query: "retry",
      mode: "semantic",
      unscopedOnly: true,
      limit: 2,
    })

    expect(memories.map((memory) => memory.id)).toEqual(["unscoped"])
    expect(materializeSpy.mock.calls[0]![0].map((p: PageObjectResponse) => p.id)).toEqual(
      ["unscoped"]
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
      },
    ])
  })

  it("planned semantic search fans out query variants and rank-fuses candidates", async () => {
    const { searcher, querySpy, searchSpy } = makeSubject()
    const resultSets = [
      [page("variant-b"), page("variant-a")],
      [page("variant-a"), page("variant-c")],
    ]
    let callIndex = 0
    searchSpy.mockImplementation(async () => ({
      results: resultSets[callIndex++] ?? [],
      has_more: false,
      next_cursor: null,
    }))

    const { memories, explain, queryPlan, planTrace } = await searcher.searchWithExplain({
      query: "Fix `Next.js` edge middleware auth and Redis session refresh",
      mode: "semantic",
      strategy: "planned",
      includeContent: false,
      limit: 3,
    })

    expect(querySpy).not.toHaveBeenCalled()
    expect(searchSpy.mock.calls.length).toBeGreaterThan(1)
    expect(searchSpy.mock.calls[0]![0].query).toContain("Next.js")
    expect(queryPlan?.variants[0]).toMatchObject({ kind: "original" })
    expect(memories.map((m) => m.id)).toEqual(["variant-a", "variant-b", "variant-c"])
    expect(explain.map((entry) => entry.semanticRank)).toEqual([0, 1, 2])
    expect(planTrace?.[0]).toMatchObject({
      memoryId: "variant-a",
      variantHits: [
        { variantIndex: 0, rank: 1 },
        { variantIndex: 1, rank: 0 },
      ],
    })
  })

  it("planned semantic search fallback does not send stripped query tokens", async () => {
    const { searcher, searchSpy } = makeSubject({
      semanticPages: [page("sanitized-hit")],
    })

    const { memories, queryPlan } = await searcher.searchWithExplain({
      query: "debug ntn_SECRET_VALUE_SHOULD_NOT_LEAK_1234567890",
      mode: "semantic",
      strategy: "planned",
      includeContent: false,
    })

    expect(searchSpy).toHaveBeenCalledTimes(1)
    expect(searchSpy.mock.calls[0]![0]).toMatchObject({ query: "debug" })
    expect(JSON.stringify(searchSpy.mock.calls[0]![0])).not.toContain("SECRET")
    expect(JSON.stringify(queryPlan)).not.toContain("SECRET")
    expect(memories.map((memory) => memory.id)).toEqual(["sanitized-hit"])
  })

  it("planned semantic search returns no results when sanitization removes the whole query", async () => {
    const { searcher, searchSpy } = makeSubject({
      semanticPages: [page("should-not-search")],
    })

    const { memories, queryPlan } = await searcher.searchWithExplain({
      query: "ntn_SECRET_VALUE_SHOULD_NOT_LEAK_1234567890",
      mode: "semantic",
      strategy: "planned",
      includeContent: false,
    })

    expect(searchSpy).not.toHaveBeenCalled()
    expect(queryPlan).toMatchObject({ originalQuery: "", variants: [] })
    expect(memories).toEqual([])
  })

  it("planned RunTool fallback does not send stripped intent tokens", async () => {
    const { searcher } = makeSubject({
      featureOverrides: { runTool: { search: true } },
    })
    const runToolSearchSpy = vi.mocked(searchViaRunTool)
    runToolSearchSpy.mockReset()
    runToolSearchSpy.mockResolvedValue({
      hits: [
        { id: "intent-hit", title: "intent-hit", url: "intent-hit", isArchived: false },
      ],
      saturated: false,
      searchType: "ai_search",
    })

    const { memories, queryPlan } = await searcher.searchWithExplain({
      query: "debug",
      intent: "ntn_SECRET_VALUE_SHOULD_NOT_LEAK_1234567890",
      mode: "semantic",
      strategy: "planned",
      includeContent: false,
    })

    expect(runToolSearchSpy).toHaveBeenCalledTimes(1)
    expect(runToolSearchSpy.mock.calls[0]![1]).toMatchObject({ query: "debug" })
    expect(JSON.stringify(runToolSearchSpy.mock.calls[0]![1])).not.toContain("SECRET")
    expect(JSON.stringify(queryPlan)).not.toContain("SECRET")
    expect(memories.map((memory) => memory.id)).toEqual(["intent-hit"])
  })

  it("planned semantic search caps each RunTool variant window", async () => {
    const { searcher, searchSpy, retrieveSpy } = makeSubject({
      featureOverrides: { runTool: { search: true } },
    })
    const runToolSearchSpy = vi.mocked(searchViaRunTool)
    runToolSearchSpy.mockReset()
    let runToolCallIndex = 0
    runToolSearchSpy.mockImplementation(async () => {
      const id = `runtool-hit-${runToolCallIndex++}`
      return {
        hits: [{ id, title: id, url: id, isArchived: false }],
        saturated: false,
        searchType: "ai_search",
      }
    })

    const { memories } = await searcher.searchWithExplain({
      query: "Fix `Next.js` edge middleware auth and Redis session refresh",
      mode: "semantic",
      strategy: "planned",
      includeContent: false,
      limit: 25,
    })

    expect(searchSpy).not.toHaveBeenCalled()
    expect(runToolSearchSpy.mock.calls.length).toBeGreaterThan(1)
    expect(
      new Set(runToolSearchSpy.mock.calls.map(([, params]) => params.pageSize))
    ).toEqual(new Set([10]))
    expect(retrieveSpy).toHaveBeenCalledTimes(runToolSearchSpy.mock.calls.length)
    expect(memories.map((memory) => memory.id)).toContain("runtool-hit-0")
  })

  it("planned REST semantic search keeps the variant fanout envelope bounded", async () => {
    const { searcher, searchSpy } = makeSubject()
    searchSpy.mockImplementation(async () => ({
      results: [],
      has_more: true,
      next_cursor: "next",
    }))

    const { queryPlan } = await searcher.searchWithExplain({
      query: "Fix `Next.js` edge middleware auth and Redis session refresh",
      mode: "semantic",
      strategy: "planned",
      includeContent: false,
      limit: 10,
    })

    expect(queryPlan?.variants).toHaveLength(3)
    expect(searchSpy).toHaveBeenCalledTimes(
      queryPlan!.variants.length * SEMANTIC_SEARCH_MAX_PAGES
    )
  })

  it("planned semantic search continues when one variant fails", async () => {
    const { searcher, searchSpy } = makeSubject()
    const outcomes: (
      | { results: PageObjectResponse[]; has_more: false; next_cursor: null }
      | Error
    )[] = [
      { results: [page("original-hit")], has_more: false, next_cursor: null },
      new Error("variant 503"),
      { results: [page("exact-hit")], has_more: false, next_cursor: null },
    ]
    let callIndex = 0
    searchSpy.mockImplementation(async () => {
      const outcome = outcomes[callIndex++] ?? {
        results: [],
        has_more: false,
        next_cursor: null,
      }
      if (outcome instanceof Error) throw outcome
      return outcome
    })

    const { memories, queryPlan } = await searcher.searchWithExplain({
      query: "Fix `Next.js` edge middleware auth and Redis session refresh",
      mode: "semantic",
      strategy: "planned",
      includeContent: false,
      limit: 3,
    })

    expect(queryPlan).toBeDefined()
    expect(searchSpy).toHaveBeenCalledTimes(queryPlan!.variants.length)
    expect(memories.map((memory) => memory.id)).toEqual(["original-hit", "exact-hit"])
  })

  it("planned semantic search falls back to direct search when query planning is disabled", async () => {
    const { searcher, searchSpy } = makeSubject({
      semanticPages: [page("direct-hit")],
      featureOverrides: { queryPlanning: false },
    })

    const { memories, queryPlan } = await searcher.searchWithExplain({
      query: "Fix `Next.js` edge middleware auth",
      mode: "semantic",
      strategy: "planned",
      includeContent: false,
    })

    expect(searchSpy).toHaveBeenCalledTimes(1)
    expect(searchSpy.mock.calls[0]![0]).toMatchObject({
      query: "Fix `Next.js` edge middleware auth",
    })
    expect(memories.map((m) => m.id)).toEqual(["direct-hit"])
    expect(queryPlan).toBeUndefined()
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

  it("hybrid keeps the contains leg raw while planning the semantic leg", async () => {
    const { searcher, querySpy, searchSpy } = makeSubject({
      containsPages: [page("contains-hit")],
    })
    const resultSets = [[page("semantic-hit")], [page("contains-hit")]]
    let callIndex = 0
    searchSpy.mockImplementation(async () => ({
      results: resultSets[callIndex++] ?? [],
      has_more: false,
      next_cursor: null,
    }))

    const { memories, queryPlan } = await searcher.searchWithExplain({
      query: "Fix `Next.js` edge middleware auth",
      mode: "hybrid",
      strategy: "planned",
      includeContent: false,
      limit: 3,
    })

    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(querySpy.mock.calls[0]![0].filter)).toContain(
      "Fix `Next.js` edge middleware auth"
    )
    expect(searchSpy.mock.calls.length).toBeGreaterThan(1)
    expect(queryPlan?.variants[0]).toMatchObject({ kind: "original" })
    expect(memories.map((m) => m.id)).toContain("contains-hit")
    expect(memories.map((m) => m.id)).toContain("semantic-hit")
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
      },
      {
        memoryId: "semantic-only",
        containsRank: null,
        semanticRank: 0,
        rrfScore: expect.closeTo(1 / 61, 10),
        branch: "rrf",
      },
      {
        memoryId: "contains-only",
        containsRank: 1,
        semanticRank: null,
        rrfScore: expect.closeTo(1 / 62, 10),
        branch: "rrf",
      },
    ])
  })

  it("pins the final deterministic page-id tie-break", () => {
    const a: RrfEntry = {
      page: { id: "aaa" } as PageObjectResponse,
      score: 1 / 61 + 1 / 62,
      containsRank: 1,
      semanticRank: 0,
    }
    const z: RrfEntry = {
      page: { id: "zzz" } as PageObjectResponse,
      score: 1 / 61 + 1 / 62,
      containsRank: 0,
      semanticRank: 1,
    }

    expect([z, a].sort(tieBreakingRrfCompare).map((entry) => entry.page.id)).toEqual([
      "aaa",
      "zzz",
    ])
  })
})
