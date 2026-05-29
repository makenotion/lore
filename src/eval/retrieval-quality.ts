import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { Client, PageObjectResponse } from "@notionhq/client"
import YAML from "yaml"
import { z } from "zod"
import type { LoreServices } from "../services.js"
import { MEMORY_PROPS } from "../notion/schema.js"
import { extractRelationIds, extractTitle, isFullPage } from "../notion/extractors.js"
import { RUNTOOL_PATH } from "../notion/runtool/client.js"
import type { DatabaseRef, Memory, SearchMode } from "../types.js"

const RETRIEVAL_QUALITY_VERSION = 1
const REST_KEYWORD_RAW_PAGE_SIZE = 100
const REST_KEYWORD_MAX_RAW_PAGES = 5

export const RETRIEVAL_QUALITY_LANES = ["ai_search", "rest_keyword", "current"] as const

export type RetrievalQualityLane = (typeof RETRIEVAL_QUALITY_LANES)[number]

const retrievalQualityCaseSchema = z
  .object({
    id: z.string().min(1),
    query: z.string().min(1),
    projectName: z.string().min(1).optional(),
    project: z.string().min(1).optional(),
    expectedMemoryId: z.string().min(1).optional(),
    expected_memory_id: z.string().min(1).optional(),
    expectedTitle: z.string().min(1).optional(),
    expected_title: z.string().min(1).optional(),
  })
  .transform((value) => ({
    id: value.id,
    query: value.query,
    projectName: value.projectName ?? value.project,
    expectedMemoryId: value.expectedMemoryId ?? value.expected_memory_id,
    expectedTitle: value.expectedTitle ?? value.expected_title,
  }))
  .superRefine((value, ctx) => {
    if (value.expectedMemoryId === undefined && value.expectedTitle === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "case must define expectedMemoryId or expectedTitle",
      })
    }
  })

const retrievalQualitySuiteSchema = z.object({
  version: z.literal(RETRIEVAL_QUALITY_VERSION),
  name: z.string().min(1),
  description: z.string().optional(),
  cases: z.array(retrievalQualityCaseSchema).min(1),
})

export type RetrievalQualityCase = z.infer<typeof retrievalQualityCaseSchema>
export type RetrievalQualitySuite = z.infer<typeof retrievalQualitySuiteSchema>

export interface RetrievalQualityRunOptions {
  limit?: number
  lanes?: RetrievalQualityLane[]
  now?: Date
}

export interface RetrievalQualityHit {
  id: string
  title: string
}

export interface RetrievalQualityLaneResult {
  lane: RetrievalQualityLane
  mechanism: string
  targetRank: number | null
  recall: Record<"1" | "5" | "10", boolean>
  reciprocalRank: number
  capped: boolean | null
  topResults: RetrievalQualityHit[]
}

export interface RetrievalQualityCaseResult {
  id: string
  query: string
  projectName: string | null
  expectedMemoryId: string | null
  expectedTitle: string | null
  lanes: RetrievalQualityLaneResult[]
}

export interface RetrievalQualityLaneSummary {
  cases: number
  recallAt1: number
  recallAt5: number
  recallAt10: number
  mrr: number
  missing: number
}

export interface RetrievalQualityArtifact {
  version: 1
  generatedAt: string
  suite: {
    name: string
    path: string
    description: string | null
  }
  limit: number
  lanes: RetrievalQualityLane[]
  results: RetrievalQualityCaseResult[]
  summary: Record<RetrievalQualityLane, RetrievalQualityLaneSummary>
}

interface RetrievalQualityServices {
  client: Client
  vault: { databases: { memories: DatabaseRef } }
  projects: LoreServices["projects"]
  memories: Pick<LoreServices["memories"], "searchWithMeta" | "search">
}

export async function loadRetrievalQualitySuite(
  path: string
): Promise<RetrievalQualitySuite> {
  const raw = await readFile(path, "utf8")
  const parsed = YAML.parse(raw)
  return retrievalQualitySuiteSchema.parse(parsed)
}

export async function runRetrievalQualitySuite(
  services: RetrievalQualityServices,
  suitePath: string,
  options: RetrievalQualityRunOptions = {}
): Promise<RetrievalQualityArtifact> {
  const absoluteSuitePath = resolve(suitePath)
  const suite = await loadRetrievalQualitySuite(absoluteSuitePath)
  const limit = options.limit ?? 10
  const lanes = options.lanes ?? [...RETRIEVAL_QUALITY_LANES]
  const results: RetrievalQualityCaseResult[] = []

  for (const testCase of suite.cases) {
    const projectId =
      testCase.projectName === undefined
        ? undefined
        : (await services.projects.findByName(testCase.projectName))?.id
    if (testCase.projectName !== undefined && projectId === undefined) {
      throw new Error(`Project "${testCase.projectName}" could not be resolved`)
    }

    const laneResults: RetrievalQualityLaneResult[] = []
    for (const lane of lanes) {
      const hits = await runLane(services, {
        lane,
        query: testCase.query,
        projectId,
        limit,
      })
      laneResults.push(scoreLane(testCase, hits))
    }

    results.push({
      id: testCase.id,
      query: testCase.query,
      projectName: testCase.projectName ?? null,
      expectedMemoryId: testCase.expectedMemoryId ?? null,
      expectedTitle: testCase.expectedTitle ?? null,
      lanes: laneResults,
    })
  }

  return {
    version: RETRIEVAL_QUALITY_VERSION,
    generatedAt: (options.now ?? new Date()).toISOString(),
    suite: {
      name: suite.name,
      path: absoluteSuitePath,
      description: suite.description ?? null,
    },
    limit,
    lanes,
    results,
    summary: summarizeLaneResults(results, lanes),
  }
}

async function runLane(
  services: RetrievalQualityServices,
  input: {
    lane: RetrievalQualityLane
    query: string
    projectId?: string
    limit: number
  }
): Promise<{
  lane: RetrievalQualityLane
  mechanism: string
  capped: boolean | null
  hits: RetrievalQualityHit[]
}> {
  if (input.lane === "rest_keyword") {
    return runRestKeywordLane(services, input)
  }

  const mode: SearchMode | undefined = input.lane === "ai_search" ? "semantic" : undefined
  const {
    value: out,
    toolsRunCount,
    restSearchCount,
  } = await withMechanismProbe(services.client, async () =>
    typeof services.memories.searchWithMeta === "function"
      ? await services.memories.searchWithMeta({
          query: input.query,
          projectId: input.projectId,
          limit: input.limit,
          includeContent: false,
          mode,
        })
      : {
          memories: await services.memories.search({
            query: input.query,
            projectId: input.projectId,
            limit: input.limit,
            includeContent: false,
            mode,
          }),
          capped: false,
        }
  )

  if (toolsRunCount === 0) {
    throw new Error(
      `retrieval-quality ${input.lane} lane did not dispatch ${RUNTOOL_PATH}; AI search mechanism is required`
    )
  }
  if (restSearchCount > 0) {
    throw new Error(
      `retrieval-quality ${input.lane} lane called client.search; REST keyword fallback is forbidden`
    )
  }

  return {
    lane: input.lane,
    mechanism:
      input.lane === "ai_search"
        ? "lore search mode=semantic (RunTool ai_search)"
        : "lore search default mode",
    capped: out.capped,
    hits: out.memories.map(memoryToHit),
  }
}

async function withMechanismProbe<T>(
  client: Client,
  fn: () => Promise<T>
): Promise<{ value: T; toolsRunCount: number; restSearchCount: number }> {
  const mutable = client as unknown as {
    request: Client["request"]
    search: Client["search"]
  }
  const originalRequest = mutable.request
  const originalSearch = mutable.search
  const originalFetch = globalThis.fetch
  let toolsRunCount = 0
  let restSearchCount = 0
  let toolsRunFetchCount = 0
  let restSearchFetchCount = 0

  mutable.request = (async (args: Parameters<Client["request"]>[0]) => {
    if (args.path === RUNTOOL_PATH) toolsRunCount += 1
    return await originalRequest.call(client, args)
  }) as Client["request"]
  mutable.search = (async (...args: Parameters<Client["search"]>) => {
    restSearchCount += 1
    return await originalSearch.apply(client, args)
  }) as Client["search"]
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const path = fetchPath(args[0])
    if (path === "/v1/tools/run") toolsRunFetchCount += 1
    if (path === "/v1/search") restSearchFetchCount += 1
    return await originalFetch(...args)
  }) as typeof fetch

  try {
    return {
      value: await fn(),
      toolsRunCount: toolsRunCount + toolsRunFetchCount,
      restSearchCount: restSearchCount + restSearchFetchCount,
    }
  } finally {
    mutable.request = originalRequest
    mutable.search = originalSearch
    globalThis.fetch = originalFetch
  }
}

function fetchPath(input: Parameters<typeof fetch>[0]): string | null {
  let raw: string | undefined
  if (typeof input === "string") {
    raw = input
  } else if (input instanceof URL) {
    raw = input.href
  } else if (typeof Request !== "undefined" && input instanceof Request) {
    raw = input.url
  } else {
    const candidate = input as { url?: unknown }
    raw = typeof candidate.url === "string" ? candidate.url : undefined
  }
  if (raw === undefined) return null
  try {
    return new URL(raw).pathname
  } catch {
    return raw
  }
}

async function runRestKeywordLane(
  services: RetrievalQualityServices,
  input: {
    lane: RetrievalQualityLane
    query: string
    projectId?: string
    limit: number
  }
): Promise<{
  lane: RetrievalQualityLane
  mechanism: string
  capped: boolean | null
  hits: RetrievalQualityHit[]
}> {
  const db = services.vault.databases.memories
  const rawPageSize = REST_KEYWORD_RAW_PAGE_SIZE
  const hits: RetrievalQualityHit[] = []
  let startCursor: string | undefined
  let capped = false

  for (let pageIndex = 0; pageIndex < REST_KEYWORD_MAX_RAW_PAGES; pageIndex += 1) {
    const response = await services.client.search({
      query: input.query,
      filter: { property: "object", value: "page" },
      page_size: rawPageSize,
      start_cursor: startCursor,
    })
    for (const page of response.results) {
      if (!isFullPage(page)) continue
      if (!isMemoryPage(page, db)) continue
      if (!matchesProject(page, input.projectId)) continue
      hits.push(pageToHit(page))
      if (hits.length >= input.limit) break
    }
    capped = response.has_more === true
    startCursor = response.next_cursor ?? undefined
    if (hits.length >= input.limit || !response.has_more || startCursor === undefined) {
      break
    }
  }

  return {
    lane: input.lane,
    mechanism: "Notion SDK client.search keyword lane",
    capped,
    hits,
  }
}

function scoreLane(
  testCase: RetrievalQualityCase,
  result: {
    lane: RetrievalQualityLane
    mechanism: string
    capped: boolean | null
    hits: RetrievalQualityHit[]
  }
): RetrievalQualityLaneResult {
  const targetIndex = result.hits.findIndex((hit) => matchesExpected(testCase, hit))
  const targetRank = targetIndex === -1 ? null : targetIndex + 1
  return {
    lane: result.lane,
    mechanism: result.mechanism,
    targetRank,
    recall: {
      "1": targetRank !== null && targetRank <= 1,
      "5": targetRank !== null && targetRank <= 5,
      "10": targetRank !== null && targetRank <= 10,
    },
    reciprocalRank: targetRank === null ? 0 : 1 / targetRank,
    capped: result.capped,
    topResults: result.hits,
  }
}

function summarizeLaneResults(
  results: RetrievalQualityCaseResult[],
  lanes: RetrievalQualityLane[]
): Record<RetrievalQualityLane, RetrievalQualityLaneSummary> {
  const summaries = Object.fromEntries(
    RETRIEVAL_QUALITY_LANES.map((lane) => [
      lane,
      { cases: 0, recallAt1: 0, recallAt5: 0, recallAt10: 0, mrr: 0, missing: 0 },
    ])
  ) as Record<RetrievalQualityLane, RetrievalQualityLaneSummary>

  for (const lane of lanes) {
    const laneResults = results
      .map((result) => result.lanes.find((candidate) => candidate.lane === lane))
      .filter((result): result is RetrievalQualityLaneResult => result !== undefined)
    const total = laneResults.length
    const denominator = total === 0 ? 1 : total
    summaries[lane] = {
      cases: total,
      recallAt1: laneResults.filter((result) => result.recall["1"]).length / denominator,
      recallAt5: laneResults.filter((result) => result.recall["5"]).length / denominator,
      recallAt10:
        laneResults.filter((result) => result.recall["10"]).length / denominator,
      mrr:
        laneResults.reduce((sum, result) => sum + result.reciprocalRank, 0) / denominator,
      missing: laneResults.filter((result) => result.targetRank === null).length,
    }
  }

  return summaries
}

function matchesExpected(
  testCase: RetrievalQualityCase,
  hit: RetrievalQualityHit
): boolean {
  if (testCase.expectedMemoryId !== undefined && hit.id === testCase.expectedMemoryId) {
    return true
  }
  if (testCase.expectedTitle !== undefined && hit.title === testCase.expectedTitle) {
    return true
  }
  return false
}

function isMemoryPage(page: PageObjectResponse, db: DatabaseRef): boolean {
  if (page.archived) return false
  const parent = page.parent
  if (parent.type === "database_id") return parent.database_id === db.databaseId
  if (parent.type === "data_source_id") return parent.data_source_id === db.dataSourceId
  return false
}

function matchesProject(
  page: PageObjectResponse,
  projectId: string | undefined
): boolean {
  if (projectId === undefined) return true
  const ids = extractRelationIds(page.properties[MEMORY_PROPS.PROJECT])
  return ids.length === 0 || ids.includes(projectId)
}

function memoryToHit(memory: Memory): RetrievalQualityHit {
  return {
    id: memory.id,
    title: memory.title,
  }
}

function pageToHit(page: PageObjectResponse): RetrievalQualityHit {
  return {
    id: page.id,
    title: extractTitle(page.properties[MEMORY_PROPS.TITLE]),
  }
}
