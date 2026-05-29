import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { describe, expect, it, vi } from "vitest"
import { defaultFeatureFlags, type LoreFeatureFlags } from "../feature-flags.js"
import { MEMORY_PROPS } from "../notion/schema.js"
import type { LoreServices } from "../services.js"
import type { DatabaseRef, Project } from "../types.js"
import {
  buildRetrievalQualityResult,
  createRetrievalQualityTransportTrace,
  loadRetrievalQualitySuite,
  runRetrievalQualityLane,
  runRetrievalQualitySuite,
  scoreRetrievalQuality,
  validateRetrievalQualityMechanism,
  type RetrievalQualityLane,
  type RetrievalQualityLaneRunner,
  type RetrievalQualitySuite,
} from "./retrieval-quality.js"

const DB: DatabaseRef = {
  databaseId: "memories-db",
  dataSourceId: "memories-ds",
}

const TARGET_MEMORY_ID = "11111111-1111-4111-8111-111111111111"
const PROJECT_ID = "project-id"

function memoryPage(id: string, title: string): PageObjectResponse {
  return {
    object: "page",
    id,
    created_time: "2026-05-29T12:00:00.000Z",
    last_edited_time: "2026-05-29T12:00:00.000Z",
    archived: false,
    url: `https://www.notion.so/${id.replaceAll("-", "")}`,
    parent: { type: "data_source_id", data_source_id: DB.dataSourceId },
    properties: {
      [MEMORY_PROPS.TITLE]: {
        type: "title",
        title: [{ plain_text: title }],
      } as unknown,
      [MEMORY_PROPS.PROJECT]: {
        type: "relation",
        relation: [{ id: PROJECT_ID }],
      } as unknown,
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
      [MEMORY_PROPS.PINNED]: { type: "checkbox", checkbox: false } as unknown,
      [MEMORY_PROPS.SUPERSEDES]: { type: "relation", relation: [] } as unknown,
      [MEMORY_PROPS.AFFECTS]: { type: "relation", relation: [] } as unknown,
      [MEMORY_PROPS.COMPARED_WITH]: { type: "relation", relation: [] } as unknown,
    } as PageObjectResponse["properties"],
  } as PageObjectResponse
}

function features(
  overrides: Partial<Omit<LoreFeatureFlags, "runTool">> & {
    runTool?: Partial<LoreFeatureFlags["runTool"]>
  } = {}
): LoreFeatureFlags {
  const defaults = defaultFeatureFlags()
  return {
    ...defaults,
    ...overrides,
    runTool: {
      ...defaults.runTool,
      ...overrides.runTool,
    },
  }
}

function qualitySuite(): RetrievalQualitySuite {
  return {
    version: 1,
    name: "quality-smoke",
    runner: "retrieval-quality",
    description: "",
    limit: 10,
    lanes: ["product", "runtool-ai", "rest-keyword"],
    requiredLanes: ["product", "runtool-ai"],
    cases: [
      {
        id: "paraphrase-case",
        query: "paraphrased question",
        expectedMemoryId: TARGET_MEMORY_ID,
        expectedTitle: "Target memory",
        projectName: "Project",
      },
    ],
  }
}

function makeLaneServices(featureFlags: LoreFeatureFlags): {
  services: LoreServices
  spies: {
    request: ReturnType<typeof vi.fn>
    search: ReturnType<typeof vi.fn>
    dataSourcesQuery: ReturnType<typeof vi.fn>
    pagesRetrieve: ReturnType<typeof vi.fn>
  }
} {
  const page = memoryPage(TARGET_MEMORY_ID, "Target memory")
  const request = vi.fn(async (args: { path?: string }) => {
    if (args.path !== "tools/run") {
      throw new Error(`Unexpected request path: ${String(args.path)}`)
    }
    return {
      type: "ai_search",
      results: [
        {
          id: "search-hit",
          title: "Target memory",
          url: TARGET_MEMORY_ID,
          is_archived: false,
        },
      ],
    }
  })
  const search = vi.fn(async () => ({
    results: [page],
    has_more: false,
    next_cursor: null,
  }))
  const dataSourcesQuery = vi.fn(async () => ({
    results: [page],
    has_more: false,
    next_cursor: null,
  }))
  const pagesRetrieve = vi.fn(async () => page)
  const client = {
    request,
    search,
    dataSources: { query: dataSourcesQuery },
    pages: {
      retrieve: pagesRetrieve,
      properties: {
        retrieve: vi.fn(),
      },
    },
  } as unknown as Client
  return {
    services: {
      client,
      features: featureFlags,
      context: {
        vault: {
          databases: {
            memories: DB,
          },
        },
      },
      scopeContext: {},
    } as unknown as LoreServices,
    spies: {
      request,
      search,
      dataSourcesQuery,
      pagesRetrieve,
    },
  }
}

describe("retrieval-quality eval runner", () => {
  it("scores recall@k and MRR for ranked search results", () => {
    expect(scoreRetrievalQuality(["a", "target", "c"], "target")).toEqual({
      targetRank: 2,
      recallAt1: 0,
      recallAt5: 1,
      recallAt10: 1,
      reciprocalRank: 0.5,
    })
    expect(scoreRetrievalQuality(["a", "b"], "target")).toEqual({
      targetRank: null,
      recallAt1: 0,
      recallAt5: 0,
      recallAt10: 0,
      reciprocalRank: 0,
    })
  })

  it("validates the expected transport mechanism per lane", () => {
    const aiTrace = createRetrievalQualityTransportTrace()
    aiTrace.toolsRunSearchCalls = 1
    expect(validateRetrievalQualityMechanism("product", aiTrace)).toMatchObject({
      passed: true,
      failures: [],
    })

    const fallbackTrace = createRetrievalQualityTransportTrace()
    fallbackTrace.clientSearchCalls = 1
    expect(validateRetrievalQualityMechanism("runtool-ai", fallbackTrace)).toMatchObject({
      passed: false,
      failures: [
        "expected RunTool search to dispatch through tools/run",
        "expected no REST client.search fallback",
      ],
    })

    const keywordTrace = createRetrievalQualityTransportTrace()
    keywordTrace.dataSourceQueryCalls = 1
    expect(validateRetrievalQualityMechanism("rest-keyword", keywordTrace)).toMatchObject(
      {
        passed: true,
        failures: [],
      }
    )
  })

  it("routes each lane through the expected search transport", async () => {
    const suite = qualitySuite()
    const item = suite.cases[0]!
    const runs: Array<{
      lane: RetrievalQualityLane
      featureFlags: LoreFeatureFlags
      expected: "tools-run" | "data-source"
    }> = [
      {
        lane: "product",
        featureFlags: features(),
        expected: "tools-run",
      },
      {
        lane: "runtool-ai",
        featureFlags: features({ runTool: { enabled: false, search: false } }),
        expected: "tools-run",
      },
      {
        lane: "rest-keyword",
        featureFlags: features({ forceSemanticSearch: true }),
        expected: "data-source",
      },
    ]

    for (const run of runs) {
      const { services, spies } = makeLaneServices(run.featureFlags)
      const result = await runRetrievalQualityLane({
        suite,
        case: item,
        lane: run.lane,
        services,
        projectId: PROJECT_ID,
      })

      expect(result).toMatchObject({
        lane: run.lane,
        targetRank: 1,
        success: true,
        mechanism: { passed: true, failures: [] },
      })
      expect(spies.search).not.toHaveBeenCalled()
      if (run.expected === "tools-run") {
        expect(spies.request).toHaveBeenCalledTimes(1)
        expect(spies.pagesRetrieve).toHaveBeenCalledTimes(1)
        expect(spies.dataSourcesQuery).not.toHaveBeenCalled()
      } else {
        expect(spies.request).not.toHaveBeenCalled()
        expect(spies.pagesRetrieve).not.toHaveBeenCalled()
        expect(spies.dataSourcesQuery).toHaveBeenCalledTimes(1)
      }
    }
  })

  it("rejects suites that cannot measure recall@10", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-retrieval-quality-"))
    const suitePath = join(dir, "suite.yaml")
    await writeFile(
      suitePath,
      `version: 1
name: quality-smoke
runner: retrieval-quality
limit: 5
lanes:
  - product
requiredLanes:
  - product
cases:
  - id: paraphrase-case
    query: "paraphrased question"
    expectedMemoryId: "${TARGET_MEMORY_ID}"
    projectName: "Project"
`,
      "utf-8"
    )

    await expect(loadRetrievalQualitySuite(suitePath)).rejects.toThrow(
      /greater than or equal to 10/
    )
  })

  it("runs a suite and gates only required lanes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-retrieval-quality-"))
    const suitePath = join(dir, "suite.yaml")
    const outPath = join(dir, "result.json")
    await writeFile(
      suitePath,
      `version: 1
name: quality-smoke
runner: retrieval-quality
limit: 10
lanes:
  - product
  - runtool-ai
  - rest-keyword
requiredLanes:
  - product
  - runtool-ai
cases:
  - id: paraphrase-case
    query: "paraphrased question"
    expectedMemoryId: "target-memory"
    expectedTitle: "Target memory"
    projectName: "Project"
`,
      "utf-8"
    )

    const project: Project = {
      id: "project-id",
      name: "Project",
      type: "project",
      path: ".",
      status: "active",
      description: "",
    }
    const services = {
      projects: {
        findByName: async (name: string) => (name === "Project" ? project : null),
      },
    } as unknown as LoreServices
    const laneResults: Record<RetrievalQualityLane, string[]> = {
      product: ["target-memory"],
      "runtool-ai": ["target-memory"],
      "rest-keyword": [],
    }
    const runner: RetrievalQualityLaneRunner = async (input) => {
      const trace = createRetrievalQualityTransportTrace()
      if (input.lane === "rest-keyword") {
        trace.dataSourceQueryCalls = 1
      } else {
        trace.toolsRunSearchCalls = 1
      }
      return buildRetrievalQualityResult({
        case: input.case,
        projectId: input.projectId,
        lane: input.lane,
        returnedMemoryIds: laneResults[input.lane],
        returnedTitles: laneResults[input.lane],
        capped: false,
        explain: [],
        mechanism: validateRetrievalQualityMechanism(input.lane, trace),
        elapsedMs: 1,
      })
    }

    const { artifact, outPath: writtenPath } = await runRetrievalQualitySuite(suitePath, {
      outPath,
      now: new Date("2026-05-29T12:00:00.000Z"),
      servicesFactory: async () => services,
      laneRunner: runner,
    })

    expect(writtenPath).toBe(outPath)
    expect(artifact.runner).toMatchObject({
      mode: "retrieval-quality",
      lanes: ["product", "runtool-ai", "rest-keyword"],
      requiredLanes: ["product", "runtool-ai"],
      k: [1, 5, 10],
      limit: 10,
    })
    expect(artifact.summary).toMatchObject({
      cases: 1,
      totalResults: 3,
      requiredResults: 2,
      passedRequiredResults: 2,
      failedRequiredResults: 0,
    })
    expect(artifact.summary.lanes.product?.recallAt1).toBe(1)
    expect(artifact.summary.lanes["rest-keyword"]?.recallAt1).toBe(0)

    const persisted = JSON.parse(await readFile(outPath, "utf-8")) as {
      startedAt: string
    }
    expect(persisted.startedAt).toBe("2026-05-29T12:00:00.000Z")
  })
})
