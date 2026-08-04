import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, parse, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import type { Client } from "@notionhq/client"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { MemoryService } from "../core/memory.js"
import { resolveProjectByName } from "../core/project-scope.js"
import { defaultFeatureFlags, type LoreFeatureFlags } from "../feature-flags.js"
import { initServices, type LoreServices } from "../services.js"
import type { SearchExplain } from "../types.js"
import { scoreRanking } from "./rank-metrics.js"

export const RETRIEVAL_QUALITY_RUNNER = "retrieval-quality" as const

export const RETRIEVAL_QUALITY_LANES = ["product", "runtool-ai", "rest-keyword"] as const

export const RETRIEVAL_QUALITY_K_VALUES = [1, 5, 10] as const

export type RetrievalQualityLane = (typeof RETRIEVAL_QUALITY_LANES)[number]
export type RetrievalQualityK = (typeof RETRIEVAL_QUALITY_K_VALUES)[number]

const retrievalQualityLaneSchema = z.enum(RETRIEVAL_QUALITY_LANES)

const retrievalQualityCaseSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be kebab-case"),
    query: z.string().trim().min(1),
    expectedMemoryId: z.string().trim().min(1).optional(),
    expectedTitle: z.string().trim().min(1).optional(),
    expected: z
      .object({
        primaryIds: z.array(z.string().trim().min(1)).min(1),
        acceptableIds: z.array(z.string().trim().min(1)).default([]),
      })
      .strict()
      .optional(),
    harmful: z
      .object({
        staleIds: z.array(z.string().trim().min(1)).default([]),
        nearMissIds: z.array(z.string().trim().min(1)).default([]),
        otherIds: z.array(z.string().trim().min(1)).default([]),
      })
      .strict()
      .default({ staleIds: [], nearMissIds: [], otherIds: [] }),
    labels: z.record(z.string().trim().min(1), z.string().trim().min(1)).default({}),
    projectName: z.string().trim().min(1),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.expectedMemoryId === undefined && item.expected === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedMemoryId"],
        message:
          "retrieval-quality cases must define expectedMemoryId or expected.primaryIds",
      })
    }
    const primaryIds =
      item.expected?.primaryIds ?? [item.expectedMemoryId].filter(isString)
    const acceptableIds = item.expected?.acceptableIds ?? []
    const harmfulIds = [
      ...item.harmful.staleIds,
      ...item.harmful.nearMissIds,
      ...item.harmful.otherIds,
    ]
    const acceptableOverlap = overlap(primaryIds, acceptableIds)
    if (acceptableOverlap.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expected", "acceptableIds"],
        message: `acceptable ids overlap primary ids: ${acceptableOverlap.join(", ")}`,
      })
    }
    const harmfulOverlap = overlap([...primaryIds, ...acceptableIds], harmfulIds)
    if (harmfulOverlap.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["harmful"],
        message: `harmful ids overlap expected ids: ${harmfulOverlap.join(", ")}`,
      })
    }
  })

export const retrievalQualitySuiteSchema = z
  .object({
    version: z.literal(1),
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be kebab-case"),
    runner: z.literal(RETRIEVAL_QUALITY_RUNNER),
    description: z.string().default(""),
    limit: z.number().int().min(10).default(10),
    lanes: z
      .array(retrievalQualityLaneSchema)
      .min(1)
      .default([...RETRIEVAL_QUALITY_LANES]),
    requiredLanes: z
      .array(retrievalQualityLaneSchema)
      .min(1)
      .default(["product", "runtool-ai"]),
    cases: z.array(retrievalQualityCaseSchema).min(1),
  })
  .strict()
  .superRefine((suite, ctx) => {
    const caseIds = new Set<string>()
    for (const item of suite.cases) {
      if (caseIds.has(item.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cases"],
          message: `duplicate retrieval-quality case id "${item.id}"`,
        })
      }
      caseIds.add(item.id)
    }

    const lanes = new Set<RetrievalQualityLane>()
    for (const lane of suite.lanes) {
      if (lanes.has(lane)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lanes"],
          message: `duplicate retrieval-quality lane "${lane}"`,
        })
      }
      lanes.add(lane)
    }

    const requiredLanes = new Set<RetrievalQualityLane>()
    for (const lane of suite.requiredLanes) {
      if (requiredLanes.has(lane)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requiredLanes"],
          message: `duplicate required retrieval-quality lane "${lane}"`,
        })
      }
      requiredLanes.add(lane)
      if (!lanes.has(lane)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requiredLanes"],
          message: `required retrieval-quality lane "${lane}" is not present in lanes`,
        })
      }
    }
  })

export type RetrievalQualitySuite = z.infer<typeof retrievalQualitySuiteSchema>
export type RetrievalQualityCase = RetrievalQualitySuite["cases"][number]

export interface LoadedRetrievalQualitySuite {
  suite: RetrievalQualitySuite
  path: string
  root: string
}

export interface RetrievalQualityTransportTrace {
  toolsRunSearchCalls: number
  toolsRunOtherCalls: number
  clientSearchCalls: number
  dataSourceQueryCalls: number
  pagesRetrieveCalls: number
}

export interface RetrievalQualityMechanism {
  passed: boolean
  failures: string[]
  trace: RetrievalQualityTransportTrace
}

export interface RetrievalQualityResult {
  caseId: string
  query: string
  projectName: string
  projectId: string
  expectedMemoryId: string
  expectedTitle: string | null
  expectedPrimaryMemoryIds: string[]
  acceptableMemoryIds: string[]
  harmfulMemoryIds: string[]
  labels: Record<string, string>
  lane: RetrievalQualityLane
  success: boolean
  targetRank: number | null
  recallAt1: number
  recallAt5: number
  recallAt10: number
  ndcgAt10: number
  reciprocalRank: number
  harmfulAt1: number
  harmfulAt5: number
  harmfulAt10: number
  harmfulMemoryIdsSurfaced: string[]
  returnedMemoryIds: string[]
  returnedTitles: string[]
  capped: boolean
  explain: SearchExplain[]
  mechanism: RetrievalQualityMechanism
  metrics: {
    elapsedMs: number
  }
}

export interface RetrievalQualityLaneSummary {
  cases: number
  passed: number
  failed: number
  recallAt1: number
  recallAt5: number
  recallAt10: number
  ndcgAt10: number
  mrr: number
  harmfulAt1: number
  harmfulAt5: number
  harmfulAt10: number
  mechanismFailures: number
}

export interface RetrievalQualityRunSummary {
  cases: number
  totalResults: number
  requiredResults: number
  passedRequiredResults: number
  failedRequiredResults: number
  lanes: Record<RetrievalQualityLane, RetrievalQualityLaneSummary | null>
}

export interface RetrievalQualityArtifact {
  suite: string
  description: string
  startedAt: string
  runner: {
    mode: typeof RETRIEVAL_QUALITY_RUNNER
    lanes: RetrievalQualityLane[]
    requiredLanes: RetrievalQualityLane[]
    k: RetrievalQualityK[]
    limit: number
  }
  results: RetrievalQualityResult[]
  summary: RetrievalQualityRunSummary
}

export interface RetrievalQualityLaneRunnerInput {
  suite: RetrievalQualitySuite
  case: RetrievalQualityCase
  lane: RetrievalQualityLane
  services: LoreServices
  projectId: string
}

export type RetrievalQualityLaneRunner = (
  input: RetrievalQualityLaneRunnerInput
) => Promise<RetrievalQualityResult>

export interface RunRetrievalQualityOptions {
  outPath?: string
  now?: Date
  servicesFactory?: () => Promise<LoreServices>
  laneRunner?: RetrievalQualityLaneRunner
}

export async function loadRetrievalQualitySuite(
  path: string
): Promise<LoadedRetrievalQualitySuite> {
  const absolute = resolve(path)
  const raw = await readFile(absolute, "utf-8")
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not parse YAML in ${absolute}: ${message}`, { cause: err })
  }
  return {
    suite: retrievalQualitySuiteSchema.parse(parsed),
    path: absolute,
    root: dirname(absolute),
  }
}

export async function runRetrievalQualitySuite(
  suitePath: string,
  options: RunRetrievalQualityOptions = {}
): Promise<{ artifact: RetrievalQualityArtifact; outPath: string }> {
  const loaded = await loadRetrievalQualitySuite(suitePath)
  const now = options.now ?? new Date()
  const startedAt = now.toISOString()
  const services = await (options.servicesFactory ?? (() => initServices()))()
  const laneRunner = options.laneRunner ?? runRetrievalQualityLane
  const results: RetrievalQualityResult[] = []

  for (const item of loaded.suite.cases) {
    const project = await resolveProjectByName(
      services.projects,
      item.projectName,
      "retrieval-quality project"
    )
    for (const lane of loaded.suite.lanes) {
      results.push(
        await laneRunner({
          suite: loaded.suite,
          case: item,
          lane,
          services,
          projectId: project.id,
        })
      )
    }
  }

  const artifact: RetrievalQualityArtifact = {
    suite: loaded.suite.name,
    description: loaded.suite.description,
    startedAt,
    runner: {
      mode: RETRIEVAL_QUALITY_RUNNER,
      lanes: [...loaded.suite.lanes],
      requiredLanes: [...loaded.suite.requiredLanes],
      k: [...RETRIEVAL_QUALITY_K_VALUES],
      limit: loaded.suite.limit,
    },
    results,
    summary: summarizeRetrievalQuality(loaded.suite, results),
  }

  const outPath = resolve(
    options.outPath ?? (await defaultRetrievalQualityArtifactPath(loaded, startedAt))
  )
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8")

  return { artifact, outPath }
}

export async function runRetrievalQualityLane(
  input: RetrievalQualityLaneRunnerInput
): Promise<RetrievalQualityResult> {
  const trace = createRetrievalQualityTransportTrace()
  const client = createTracingClient(input.services.client, trace)
  const features = featuresForRetrievalQualityLane(input.services.features, input.lane)
  const memories = new MemoryService(
    client,
    input.services.context.vault.databases.memories,
    input.services.scopeContext,
    { features }
  )
  const before = performance.now()
  const out = await memories.searchWithExplain({
    query: input.case.query,
    projectId: input.projectId,
    limit: input.suite.limit,
    includeContent: false,
    mode: input.lane === "rest-keyword" ? "contains" : "semantic",
  })
  const elapsedMs = roundMetric(performance.now() - before)
  return buildRetrievalQualityResult({
    case: input.case,
    projectId: input.projectId,
    lane: input.lane,
    returnedMemoryIds: out.memories.map((memory) => memory.id),
    returnedTitles: out.memories.map((memory) => memory.title),
    capped: out.capped,
    explain: out.explain,
    mechanism: validateRetrievalQualityMechanism(input.lane, trace),
    elapsedMs,
  })
}

export function buildRetrievalQualityResult(input: {
  case: RetrievalQualityCase
  projectId: string
  lane: RetrievalQualityLane
  returnedMemoryIds: string[]
  returnedTitles: string[]
  capped: boolean
  explain: SearchExplain[]
  mechanism: RetrievalQualityMechanism
  elapsedMs: number
}): RetrievalQualityResult {
  const expected = resolveRetrievalQualityExpected(input.case)
  const harmfulMemoryIds = resolveRetrievalQualityHarmful(input.case)
  const scored = scoreRetrievalQuality(input.returnedMemoryIds, expected.primaryIds, [
    ...expected.acceptableIds,
  ])
  const harmful = scoreHarmfulRetrieval(input.returnedMemoryIds, harmfulMemoryIds)
  return {
    caseId: input.case.id,
    query: input.case.query,
    projectName: input.case.projectName,
    projectId: input.projectId,
    expectedMemoryId: expected.primaryIds[0]!,
    expectedTitle: input.case.expectedTitle ?? null,
    expectedPrimaryMemoryIds: expected.primaryIds,
    acceptableMemoryIds: expected.acceptableIds,
    harmfulMemoryIds,
    labels: input.case.labels,
    lane: input.lane,
    success:
      scored.targetRank === 1 && harmful.harmfulAt10 === 0 && input.mechanism.passed,
    targetRank: scored.targetRank,
    recallAt1: scored.recallAt1,
    recallAt5: scored.recallAt5,
    recallAt10: scored.recallAt10,
    ndcgAt10: scored.ndcgAt10,
    reciprocalRank: scored.reciprocalRank,
    harmfulAt1: harmful.harmfulAt1,
    harmfulAt5: harmful.harmfulAt5,
    harmfulAt10: harmful.harmfulAt10,
    harmfulMemoryIdsSurfaced: harmful.harmfulMemoryIdsSurfaced,
    returnedMemoryIds: input.returnedMemoryIds,
    returnedTitles: input.returnedTitles,
    capped: input.capped,
    explain: input.explain,
    mechanism: input.mechanism,
    metrics: { elapsedMs: input.elapsedMs },
  }
}

export function scoreRetrievalQuality(
  returnedMemoryIds: string[],
  primaryMemoryIds: string[] | string,
  acceptableMemoryIds: string[] = []
): {
  targetRank: number | null
  recallAt1: number
  recallAt5: number
  recallAt10: number
  ndcgAt10: number
  reciprocalRank: number
} {
  const primaryIds = Array.isArray(primaryMemoryIds)
    ? primaryMemoryIds
    : [primaryMemoryIds]
  const targetRank = bestRank(returnedMemoryIds, primaryIds)
  const ranking = scoreRanking({
    returnedIds: returnedMemoryIds,
    relevant: [
      ...primaryIds.map((id) => ({ id, relevance: 2 })),
      ...acceptableMemoryIds.map((id) => ({ id, relevance: 1 })),
    ],
    kValues: [10],
  })
  return {
    targetRank,
    recallAt1: recallAtK(targetRank, 1),
    recallAt5: recallAtK(targetRank, 5),
    recallAt10: recallAtK(targetRank, 10),
    ndcgAt10: ranking.ndcgAt["10"] ?? 0,
    reciprocalRank: targetRank === null ? 0 : roundMetric(1 / targetRank),
  }
}

export function summarizeRetrievalQuality(
  suite: RetrievalQualitySuite,
  results: RetrievalQualityResult[]
): RetrievalQualityRunSummary {
  const required = new Set(suite.requiredLanes)
  const laneSummaries = Object.fromEntries(
    RETRIEVAL_QUALITY_LANES.map((lane) => {
      if (!suite.lanes.includes(lane)) return [lane, null]
      const rows = results.filter((result) => result.lane === lane)
      return [lane, summarizeRetrievalQualityLane(rows)]
    })
  ) as Record<RetrievalQualityLane, RetrievalQualityLaneSummary | null>
  const requiredResults = results.filter((result) => required.has(result.lane))
  return {
    cases: suite.cases.length,
    totalResults: results.length,
    requiredResults: requiredResults.length,
    passedRequiredResults: requiredResults.filter((result) => result.success).length,
    failedRequiredResults: requiredResults.filter((result) => !result.success).length,
    lanes: laneSummaries,
  }
}

function summarizeRetrievalQualityLane(
  results: RetrievalQualityResult[]
): RetrievalQualityLaneSummary {
  return {
    cases: results.length,
    passed: results.filter((result) => result.success).length,
    failed: results.filter((result) => !result.success).length,
    recallAt1: average(results.map((result) => result.recallAt1)),
    recallAt5: average(results.map((result) => result.recallAt5)),
    recallAt10: average(results.map((result) => result.recallAt10)),
    ndcgAt10: average(results.map((result) => result.ndcgAt10)),
    mrr: average(results.map((result) => result.reciprocalRank)),
    harmfulAt1: average(results.map((result) => result.harmfulAt1)),
    harmfulAt5: average(results.map((result) => result.harmfulAt5)),
    harmfulAt10: average(results.map((result) => result.harmfulAt10)),
    mechanismFailures: results.filter((result) => !result.mechanism.passed).length,
  }
}

function resolveRetrievalQualityExpected(caseItem: RetrievalQualityCase): {
  primaryIds: string[]
  acceptableIds: string[]
} {
  if (caseItem.expected) {
    return {
      primaryIds: uniqueStrings(caseItem.expected.primaryIds),
      acceptableIds: uniqueStrings(caseItem.expected.acceptableIds),
    }
  }
  return {
    primaryIds: [caseItem.expectedMemoryId!],
    acceptableIds: [],
  }
}

function resolveRetrievalQualityHarmful(caseItem: RetrievalQualityCase): string[] {
  return uniqueStrings([
    ...caseItem.harmful.staleIds,
    ...caseItem.harmful.nearMissIds,
    ...caseItem.harmful.otherIds,
  ])
}

function scoreHarmfulRetrieval(
  returnedMemoryIds: string[],
  harmfulMemoryIds: string[]
): {
  harmfulAt1: number
  harmfulAt5: number
  harmfulAt10: number
  harmfulMemoryIdsSurfaced: string[]
} {
  const harmful = new Set(harmfulMemoryIds)
  const surfaced = returnedMemoryIds.filter((id) => harmful.has(id))
  return {
    harmfulAt1: surfacedWithinK(returnedMemoryIds, harmful, 1),
    harmfulAt5: surfacedWithinK(returnedMemoryIds, harmful, 5),
    harmfulAt10: surfacedWithinK(returnedMemoryIds, harmful, 10),
    harmfulMemoryIdsSurfaced: uniqueStrings(surfaced),
  }
}

function surfacedWithinK(
  returnedMemoryIds: string[],
  ids: Set<string>,
  k: RetrievalQualityK
): number {
  return returnedMemoryIds.slice(0, k).some((id) => ids.has(id)) ? 1 : 0
}

function bestRank(returnedMemoryIds: string[], ids: string[]): number | null {
  let out: number | null = null
  for (const id of ids) {
    const index = returnedMemoryIds.indexOf(id)
    if (index === -1) continue
    const rank = index + 1
    if (out === null || rank < out) out = rank
  }
  return out
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

function overlap(left: string[], right: string[]): string[] {
  const rightIds = new Set(right)
  return uniqueStrings(left.filter((id) => rightIds.has(id)))
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

export function createRetrievalQualityTransportTrace(): RetrievalQualityTransportTrace {
  return {
    toolsRunSearchCalls: 0,
    toolsRunOtherCalls: 0,
    clientSearchCalls: 0,
    dataSourceQueryCalls: 0,
    pagesRetrieveCalls: 0,
  }
}

export function validateRetrievalQualityMechanism(
  lane: RetrievalQualityLane,
  trace: RetrievalQualityTransportTrace
): RetrievalQualityMechanism {
  const failures: string[] = []
  if (lane === "product" || lane === "runtool-ai") {
    if (trace.toolsRunSearchCalls === 0) {
      failures.push("expected RunTool search to dispatch through tools/run")
    }
    if (trace.clientSearchCalls !== 0) {
      failures.push("expected no REST client.search fallback")
    }
  } else {
    if (trace.dataSourceQueryCalls === 0) {
      failures.push("expected REST keyword lane to query the Memories data source")
    }
    if (trace.toolsRunSearchCalls !== 0) {
      failures.push("expected REST keyword lane not to dispatch RunTool search")
    }
    if (trace.clientSearchCalls !== 0) {
      failures.push("expected REST keyword lane not to use REST client.search")
    }
  }
  return {
    passed: failures.length === 0,
    failures,
    trace: { ...trace },
  }
}

function featuresForRetrievalQualityLane(
  base: LoreFeatureFlags | undefined,
  lane: RetrievalQualityLane
): LoreFeatureFlags {
  const features = cloneFeatureFlags(base ?? defaultFeatureFlags())
  if (lane === "runtool-ai") {
    features.runTool.enabled = true
    features.runTool.search = true
  } else if (lane === "rest-keyword") {
    features.runTool.search = false
    features.forceSemanticSearch = false
  }
  return features
}

function cloneFeatureFlags(features: LoreFeatureFlags): LoreFeatureFlags {
  return {
    ...features,
    runTool: { ...features.runTool },
  }
}

function createTracingClient(
  client: Client,
  trace: RetrievalQualityTransportTrace
): Client {
  return new Proxy(client as Client & Record<PropertyKey, unknown>, {
    get(target, prop, receiver) {
      if (prop === "request") {
        const request = Reflect.get(target, prop, receiver)
        if (typeof request !== "function") return request
        return (args: Record<string, unknown>) => {
          if (args["path"] === "tools/run") {
            const body = args["body"] as { type?: unknown } | undefined
            if (body?.type === "search") {
              trace.toolsRunSearchCalls += 1
            } else {
              trace.toolsRunOtherCalls += 1
            }
          }
          return Reflect.apply(request, target, [args])
        }
      }
      if (prop === "search") {
        const search = Reflect.get(target, prop, receiver)
        if (typeof search !== "function") return search
        return (...args: unknown[]) => {
          trace.clientSearchCalls += 1
          return Reflect.apply(search, target, args)
        }
      }
      if (prop === "dataSources") {
        const dataSources = Reflect.get(target, prop, receiver)
        return wrapNestedClientObject(dataSources, {
          query: () => {
            trace.dataSourceQueryCalls += 1
          },
        })
      }
      if (prop === "pages") {
        const pages = Reflect.get(target, prop, receiver)
        return wrapNestedClientObject(pages, {
          retrieve: () => {
            trace.pagesRetrieveCalls += 1
          },
        })
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as Client
}

function wrapNestedClientObject(
  value: unknown,
  beforeCall: Record<string, () => void>
): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return value
  }
  return new Proxy(value as Record<PropertyKey, unknown>, {
    get(target, prop, receiver) {
      const member = Reflect.get(target, prop, receiver)
      if (typeof prop !== "string" || typeof member !== "function") return member
      const before = beforeCall[prop]
      if (!before) return member
      return (...args: unknown[]) => {
        before()
        return Reflect.apply(member, target, args)
      }
    },
  })
}

function recallAtK(rank: number | null, k: RetrievalQualityK): number {
  return rank !== null && rank <= k ? 1 : 0
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  return roundMetric(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function roundMetric(value: number): number {
  return Math.round(value * 10000) / 10000
}

async function defaultRetrievalQualityArtifactPath(
  loaded: LoadedRetrievalQualitySuite,
  startedAt: string
): Promise<string> {
  const root = await findRepoRoot(loaded.root)
  const safeTimestamp = startedAt.replace(/[:.]/g, "-")
  return resolve(root, "evals", "results", `${loaded.suite.name}-${safeTimestamp}.json`)
}

async function findRepoRoot(start: string): Promise<string> {
  let dir = resolve(start)
  while (true) {
    const packageJsonPath = join(dir, "package.json")
    try {
      const parsed = JSON.parse(await readFile(packageJsonPath, "utf-8")) as {
        name?: unknown
      }
      if (parsed.name === "@notionhq/lore") return dir
    } catch {
      // Keep walking. Missing and unrelated package.json files are both non-roots.
    }
    const parent = dirname(dir)
    if (parent === dir || dir === parse(dir).root) {
      throw new Error(
        `Could not find @notionhq/lore package root from ${start}; pass --out to choose an artifact path.`
      )
    }
    dir = parent
  }
}
