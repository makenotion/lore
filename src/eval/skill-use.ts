import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import {
  averageMetric,
  roundMetric,
  scoreRanking,
  type RankingMetrics,
} from "./rank-metrics.js"

export const SKILL_USE_RUNNER = "skill-use" as const

export const SKILL_USE_CONDITIONS = [
  "no-context",
  "oracle-context",
  "retrieved-context",
  "harmful-context",
] as const

export const SKILL_USE_RETRIEVAL_LANES = ["keyword"] as const

export type SkillUseCondition = (typeof SKILL_USE_CONDITIONS)[number]
export type SkillUseRetrievalLane = (typeof SKILL_USE_RETRIEVAL_LANES)[number]

const skillUseConditionSchema = z.enum(SKILL_USE_CONDITIONS)
const skillUseRetrievalLaneSchema = z.enum(SKILL_USE_RETRIEVAL_LANES)

const skillUseCorpusSchema = z
  .object({
    documentsPath: z.string().min(1),
  })
  .strict()

const skillUseDocumentConfigSchema = z
  .object({
    textFields: z
      .array(z.enum(["title", "synopsis", "content", "body"]))
      .min(1)
      .default(["title", "synopsis", "content"]),
  })
  .strict()
  .default({ textFields: ["title", "synopsis", "content"] })

const skillUseRetrievalSchema = z
  .object({
    lane: skillUseRetrievalLaneSchema.default("keyword"),
    limit: z.number().int().positive().default(5),
    k: z.array(z.number().int().positive()).min(1).default([1, 5]),
  })
  .strict()
  .default({ lane: "keyword", limit: 5, k: [1, 5] })

const skillUseAnswerSchema = z
  .object({
    accepted: z.array(z.string().trim().min(1)).min(1),
    mode: z.enum(["exact", "contains", "regex"]).default("contains"),
    caseSensitive: z.boolean().default(false),
  })
  .strict()

const skillUseSupportSetSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be kebab-case"),
    documentIds: z.array(z.string().trim().min(1)).min(1),
  })
  .strict()

const skillUseTaskSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be kebab-case"),
    prompt: z.string().trim().min(1),
    answer: skillUseAnswerSchema,
    supportSets: z.array(skillUseSupportSetSchema).min(1),
    acceptableEvidenceIds: z.array(z.string().trim().min(1)).default([]),
    harmfulEvidenceIds: z.array(z.string().trim().min(1)).default([]),
    oracleContextIds: z.array(z.string().trim().min(1)).optional(),
    mustUseContext: z.boolean().default(true),
  })
  .strict()
  .superRefine((task, ctx) => {
    if (task.answer.mode === "regex") {
      for (const [index, pattern] of task.answer.accepted.entries()) {
        try {
          new RegExp(pattern)
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["answer", "accepted", index],
            message: "must be a valid JavaScript regex",
          })
        }
      }
    }
    const supportIds = supportEvidenceIds(task.supportSets)
    const acceptableOverlap = overlap(supportIds, task.acceptableEvidenceIds)
    if (acceptableOverlap.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acceptableEvidenceIds"],
        message: `acceptable evidence ids overlap required evidence ids: ${acceptableOverlap.join(", ")}`,
      })
    }
    const harmfulOverlap = overlap(
      [...supportIds, ...task.acceptableEvidenceIds],
      task.harmfulEvidenceIds
    )
    if (harmfulOverlap.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["harmfulEvidenceIds"],
        message: `harmful evidence ids overlap expected evidence ids: ${harmfulOverlap.join(", ")}`,
      })
    }
  })

const skillUseThresholdsSchema = z
  .object({
    minOracleAccuracy: z.number().min(0).max(1).default(1),
    maxNoContextAccuracy: z.number().min(0).max(1).default(0),
    minRetrievedOracleRatio: z.number().min(0).max(1).default(0),
    maxHarmfulContextRate: z.number().min(0).max(1).default(0),
  })
  .strict()
  .default({
    minOracleAccuracy: 1,
    maxNoContextAccuracy: 0,
    minRetrievedOracleRatio: 0,
    maxHarmfulContextRate: 0,
  })

export const skillUseSuiteSchema = z
  .object({
    version: z.literal(1),
    runner: z.literal(SKILL_USE_RUNNER),
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be kebab-case"),
    description: z.string().default(""),
    corpus: skillUseCorpusSchema,
    document: skillUseDocumentConfigSchema,
    retrieval: skillUseRetrievalSchema,
    thresholds: skillUseThresholdsSchema,
    conditions: z
      .array(skillUseConditionSchema)
      .min(1)
      .default(["no-context", "oracle-context", "retrieved-context"]),
    requiredConditions: z
      .array(skillUseConditionSchema)
      .min(1)
      .default(["oracle-context"]),
    tasks: z.array(skillUseTaskSchema).min(1),
  })
  .strict()
  .superRefine((suite, ctx) => {
    const conditions = new Set<SkillUseCondition>()
    for (const [index, condition] of suite.conditions.entries()) {
      if (conditions.has(condition)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["conditions", index],
          message: `duplicate skill-use condition "${condition}"`,
        })
      }
      conditions.add(condition)
    }

    const requiredConditions = new Set<SkillUseCondition>()
    for (const [index, condition] of suite.requiredConditions.entries()) {
      if (requiredConditions.has(condition)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requiredConditions", index],
          message: `duplicate required skill-use condition "${condition}"`,
        })
      }
      if (!conditions.has(condition)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requiredConditions", index],
          message: `required skill-use condition "${condition}" is not present in conditions`,
        })
      }
      requiredConditions.add(condition)
    }

    const kValues = new Set<number>()
    for (const [index, k] of suite.retrieval.k.entries()) {
      if (kValues.has(k)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retrieval", "k", index],
          message: `duplicate k value "${k}"`,
        })
      }
      kValues.add(k)
    }
    if (suite.retrieval.limit < Math.max(...suite.retrieval.k)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retrieval", "limit"],
        message: "retrieval.limit must be at least the largest requested k value",
      })
    }

    const taskIds = new Set<string>()
    for (const [index, task] of suite.tasks.entries()) {
      if (taskIds.has(task.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tasks", index, "id"],
          message: `duplicate skill-use task id "${task.id}"`,
        })
      }
      taskIds.add(task.id)
      if (task.oracleContextIds) {
        const satisfiesSupportSet = task.supportSets.some((supportSet) =>
          supportSet.documentIds.every((id) => task.oracleContextIds!.includes(id))
        )
        if (!satisfiesSupportSet) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["tasks", index, "oracleContextIds"],
            message: "oracleContextIds must satisfy at least one support set",
          })
        }
      }
    }
  })

const skillUseDocumentSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    synopsis: z.string().default(""),
    content: z.string().default(""),
    body: z.string().default(""),
  })
  .passthrough()

export type SkillUseSuite = z.infer<typeof skillUseSuiteSchema>
export type SkillUseTask = SkillUseSuite["tasks"][number]
export type SkillUseDocument = z.infer<typeof skillUseDocumentSchema>

export interface LoadedSkillUseSuite {
  suite: SkillUseSuite
  path: string
  root: string
}

export interface SkillUseCorpus {
  documents: SkillUseDocument[]
  paths: {
    documents: string
  }
  hashes: {
    documentsSha256: string
  }
}

export interface SkillUseAnswererInput {
  task: SkillUseTask
  condition: SkillUseCondition
  context: SkillUseContextDocument[]
  prompt: string
}

export interface SkillUseAnswererOutput {
  answer: string
  citedDocumentIds?: string[]
  notes?: string
}

export type SkillUseAnswerer = (
  input: SkillUseAnswererInput
) => Promise<SkillUseAnswererOutput>

export interface SkillUseContextDocument {
  id: string
  title: string
  text: string
}

export interface SkillUseResult {
  taskId: string
  prompt: string
  condition: SkillUseCondition
  success: boolean
  answer: string
  citedDocumentIds: string[]
  answerCorrect: boolean
  contextSufficient: boolean
  supportSetSatisfied: boolean
  satisfiedSupportSetIds: string[]
  harmfulContextIdsSurfaced: string[]
  supportEvidenceIds: string[]
  acceptableEvidenceIds: string[]
  harmfulEvidenceIds: string[]
  contextDocumentIds: string[]
  returnedDocumentIds: string[]
  ranking: RankingMetrics | null
  failureReasons: string[]
  metrics: {
    elapsedMs: number
    estimatedContextTokens: number
  }
}

export interface SkillUseConditionSummary {
  results: number
  passed: number
  failed: number
  successRate: number
  answerAccuracy: number
  contextSufficiency: number
  supportSetSatisfaction: number
  harmfulRate: number
  averageContextTokens: number
}

export interface SkillUseLiftSummary {
  retrievedVsNoContextAccuracyDelta: number | null
  retrievedGapToOracle: number | null
  contextDependentTaskIds: string[]
  retrievedLiftedTaskIds: string[]
  retrievedHarmedTaskIds: string[]
}

export interface SkillUseRunSummary {
  tasks: number
  totalResults: number
  requiredResults: number
  passedRequiredResults: number
  failedRequiredResults: number
  thresholdFailures: string[]
  conditions: Record<SkillUseCondition, SkillUseConditionSummary | null>
  lift: SkillUseLiftSummary
}

export interface SkillUseArtifact {
  suite: string
  description: string
  startedAt: string
  runner: {
    mode: typeof SKILL_USE_RUNNER
    configHash: string
    conditions: SkillUseCondition[]
    requiredConditions: SkillUseCondition[]
    retrieval: {
      lane: SkillUseRetrievalLane
      limit: number
      k: number[]
    }
  }
  corpus: {
    documentsPath: string
    documentsSha256: string
    documents: number
  }
  results: SkillUseResult[]
  summary: SkillUseRunSummary
}

export interface RunSkillUseOptions {
  outPath?: string
  now?: Date
  answerer?: SkillUseAnswerer
}

interface KeywordDocument {
  document: SkillUseDocument
  text: string
  termCounts: Map<string, number>
  uniqueTerms: Set<string>
  length: number
}

export async function loadSkillUseSuite(path: string): Promise<LoadedSkillUseSuite> {
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
    suite: skillUseSuiteSchema.parse(parsed),
    path: absolute,
    root: dirname(absolute),
  }
}

export async function loadSkillUseCorpus(
  loaded: LoadedSkillUseSuite
): Promise<SkillUseCorpus> {
  const documentsPath = resolve(loaded.root, loaded.suite.corpus.documentsPath)
  const raw = await readFile(documentsPath, "utf-8")
  const documents = readJsonlText<SkillUseDocument>(
    raw,
    documentsPath,
    skillUseDocumentSchema,
    "skill-use document"
  )
  validateSkillUseCorpus({ suite: loaded.suite, documents })
  return {
    documents,
    paths: { documents: documentsPath },
    hashes: { documentsSha256: sha256Hex(raw) },
  }
}

export async function runSkillUseSuite(
  suitePath: string,
  options: RunSkillUseOptions = {}
): Promise<{ artifact: SkillUseArtifact; outPath: string }> {
  const loaded = await loadSkillUseSuite(suitePath)
  const now = options.now ?? new Date()
  const startedAt = now.toISOString()
  const corpus = await loadSkillUseCorpus(loaded)
  const answerer = options.answerer ?? runEvidenceProxySkillUseAnswerer
  const results: SkillUseResult[] = []

  for (const task of loaded.suite.tasks) {
    const retrieval = loaded.suite.conditions.includes("retrieved-context")
      ? runKeywordSkillUseRetrieval({
          suite: loaded.suite,
          corpus,
          task,
        })
      : { returnedIds: [], ranking: null }
    for (const condition of loaded.suite.conditions) {
      results.push(
        await runSkillUseTrial({
          suite: loaded.suite,
          corpus,
          task,
          condition,
          retrieval,
          answerer,
        })
      )
    }
  }

  const artifact: SkillUseArtifact = {
    suite: loaded.suite.name,
    description: loaded.suite.description,
    startedAt,
    runner: {
      mode: SKILL_USE_RUNNER,
      configHash: skillUseSuiteConfigHash(loaded.suite),
      conditions: [...loaded.suite.conditions],
      requiredConditions: [...loaded.suite.requiredConditions],
      retrieval: {
        lane: loaded.suite.retrieval.lane,
        limit: loaded.suite.retrieval.limit,
        k: [...loaded.suite.retrieval.k].sort((a, b) => a - b),
      },
    },
    corpus: {
      documentsPath: corpus.paths.documents,
      documentsSha256: corpus.hashes.documentsSha256,
      documents: corpus.documents.length,
    },
    results,
    summary: summarizeSkillUse(loaded.suite, results),
  }

  const outPath = resolve(
    options.outPath ?? (await defaultSkillUseArtifactPath(loaded, startedAt))
  )
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8")
  return { artifact, outPath }
}

export async function runEvidenceProxySkillUseAnswerer(
  input: SkillUseAnswererInput
): Promise<SkillUseAnswererOutput> {
  const contextIds = input.context.map((doc) => doc.id)
  const supportSet = firstSatisfiedSupportSet(input.task.supportSets, contextIds)
  const harmfulSurfaced = input.task.harmfulEvidenceIds.some((id) =>
    contextIds.includes(id)
  )
  if (input.task.mustUseContext && (!supportSet || harmfulSurfaced)) {
    return { answer: "", citedDocumentIds: [] }
  }
  return {
    answer: input.task.answer.accepted[0]!,
    citedDocumentIds: supportSet?.documentIds ?? [],
  }
}

function runKeywordSkillUseRetrieval(input: {
  suite: SkillUseSuite
  corpus: SkillUseCorpus
  task: SkillUseTask
}): { returnedIds: string[]; ranking: RankingMetrics } {
  if (input.suite.retrieval.lane !== "keyword") {
    throw new Error(
      `Unsupported skill-use retrieval lane "${input.suite.retrieval.lane}"`
    )
  }
  const documents = input.corpus.documents.map((document) =>
    buildKeywordDocument(document, input.suite.document.textFields)
  )
  const idf = buildInverseDocumentFrequency(documents)
  const returned = rankKeywordDocuments({
    query: input.task.prompt,
    documents,
    idf,
    limit: input.suite.retrieval.limit,
  })
  return {
    returnedIds: returned.map((doc) => doc.document.id),
    ranking: scoreRanking({
      returnedIds: returned.map((doc) => doc.document.id),
      relevant: [
        ...supportEvidenceIds(input.task.supportSets).map((id) => ({
          id,
          relevance: 2,
        })),
        ...input.task.acceptableEvidenceIds.map((id) => ({ id, relevance: 1 })),
      ],
      kValues: input.suite.retrieval.k,
    }),
  }
}

async function runSkillUseTrial(input: {
  suite: SkillUseSuite
  corpus: SkillUseCorpus
  task: SkillUseTask
  condition: SkillUseCondition
  retrieval: { returnedIds: string[]; ranking: RankingMetrics | null }
  answerer: SkillUseAnswerer
}): Promise<SkillUseResult> {
  const context = selectSkillUseContext(input)
  const before = performance.now()
  const answered = await input.answerer({
    task: input.task,
    condition: input.condition,
    context,
    prompt: input.task.prompt,
  })
  const elapsedMs = roundMs(performance.now() - before)
  const contextDocumentIds = context.map((doc) => doc.id)
  const harmfulContextIdsSurfaced = input.task.harmfulEvidenceIds.filter((id) =>
    contextDocumentIds.includes(id)
  )
  const satisfiedSupportSetIds = input.task.supportSets
    .filter((supportSet) =>
      supportSet.documentIds.every((id) => contextDocumentIds.includes(id))
    )
    .map((supportSet) => supportSet.id)
  const supportSetSatisfied = satisfiedSupportSetIds.length > 0
  const contextSufficient = !input.task.mustUseContext || supportSetSatisfied
  const answerCorrect = scoreSkillUseAnswer(input.task.answer, answered.answer)
  const failureReasons = skillUseFailureReasons({
    answerCorrect,
    contextSufficient,
    supportSetSatisfied,
    harmfulContextIdsSurfaced,
  })
  return {
    taskId: input.task.id,
    prompt: input.task.prompt,
    condition: input.condition,
    success: answerCorrect && contextSufficient && harmfulContextIdsSurfaced.length === 0,
    answer: answered.answer,
    citedDocumentIds: answered.citedDocumentIds ?? [],
    answerCorrect,
    contextSufficient,
    supportSetSatisfied,
    satisfiedSupportSetIds,
    harmfulContextIdsSurfaced,
    supportEvidenceIds: supportEvidenceIds(input.task.supportSets),
    acceptableEvidenceIds: [...input.task.acceptableEvidenceIds],
    harmfulEvidenceIds: [...input.task.harmfulEvidenceIds],
    contextDocumentIds,
    returnedDocumentIds:
      input.condition === "retrieved-context" ? [...input.retrieval.returnedIds] : [],
    ranking: input.condition === "retrieved-context" ? input.retrieval.ranking : null,
    failureReasons,
    metrics: {
      elapsedMs,
      estimatedContextTokens: estimateContextTokens(context.map((doc) => doc.text)),
    },
  }
}

function selectSkillUseContext(input: {
  suite: SkillUseSuite
  corpus: SkillUseCorpus
  task: SkillUseTask
  condition: SkillUseCondition
  retrieval: { returnedIds: string[]; ranking: RankingMetrics | null }
}): SkillUseContextDocument[] {
  const documentsById = new Map(input.corpus.documents.map((doc) => [doc.id, doc]))
  let ids: string[]
  if (input.condition === "no-context") {
    ids = []
  } else if (input.condition === "oracle-context") {
    ids = input.task.oracleContextIds ?? [
      ...input.task.supportSets[0]!.documentIds,
      ...input.task.acceptableEvidenceIds,
    ]
  } else if (input.condition === "harmful-context") {
    ids = [...input.task.harmfulEvidenceIds]
  } else {
    ids = input.retrieval.returnedIds
  }
  return ids.flatMap((id) => {
    const document = documentsById.get(id)
    if (!document) return []
    return [
      {
        id: document.id,
        title: document.title,
        text: renderSkillUseDocument(document, input.suite.document.textFields),
      },
    ]
  })
}

export function summarizeSkillUse(
  suite: SkillUseSuite,
  results: SkillUseResult[]
): SkillUseRunSummary {
  const requiredConditions = new Set(suite.requiredConditions)
  const requiredResults = results.filter((result) =>
    requiredConditions.has(result.condition)
  )
  const conditionSummaries = Object.fromEntries(
    SKILL_USE_CONDITIONS.map((condition) => {
      if (!suite.conditions.includes(condition)) return [condition, null]
      const rows = results.filter((result) => result.condition === condition)
      return [condition, summarizeSkillUseCondition(rows)]
    })
  ) as Record<SkillUseCondition, SkillUseConditionSummary | null>
  return {
    tasks: suite.tasks.length,
    totalResults: results.length,
    requiredResults: requiredResults.length,
    passedRequiredResults: requiredResults.filter((result) => result.success).length,
    failedRequiredResults: requiredResults.filter((result) => !result.success).length,
    thresholdFailures: collectSkillUseThresholdFailures(suite, results),
    conditions: conditionSummaries,
    lift: summarizeSkillUseLift(suite, results),
  }
}

function summarizeSkillUseCondition(results: SkillUseResult[]): SkillUseConditionSummary {
  return {
    results: results.length,
    passed: results.filter((result) => result.success).length,
    failed: results.filter((result) => !result.success).length,
    successRate: averageMetric(results.map((result) => (result.success ? 1 : 0))),
    answerAccuracy: averageMetric(
      results.map((result) => (result.answerCorrect ? 1 : 0))
    ),
    contextSufficiency: averageMetric(
      results.map((result) => (result.contextSufficient ? 1 : 0))
    ),
    supportSetSatisfaction: averageMetric(
      results.map((result) => (result.supportSetSatisfied ? 1 : 0))
    ),
    harmfulRate: averageMetric(
      results.map((result) => (result.harmfulContextIdsSurfaced.length > 0 ? 1 : 0))
    ),
    averageContextTokens: averageMetric(
      results.map((result) => result.metrics.estimatedContextTokens)
    ),
  }
}

function collectSkillUseThresholdFailures(
  suite: SkillUseSuite,
  results: SkillUseResult[]
): string[] {
  const summaryByCondition = new Map<SkillUseCondition, SkillUseConditionSummary>()
  for (const condition of suite.conditions) {
    summaryByCondition.set(
      condition,
      summarizeSkillUseCondition(
        results.filter((result) => result.condition === condition)
      )
    )
  }
  const failures: string[] = []
  const oracle = summaryByCondition.get("oracle-context")
  if (oracle && oracle.successRate < suite.thresholds.minOracleAccuracy) {
    failures.push(
      `oracle-context success rate ${oracle.successRate} is below minOracleAccuracy ${suite.thresholds.minOracleAccuracy}`
    )
  }
  const noContext = summaryByCondition.get("no-context")
  if (noContext && noContext.answerAccuracy > suite.thresholds.maxNoContextAccuracy) {
    failures.push(
      `no-context answer accuracy ${noContext.answerAccuracy} exceeds maxNoContextAccuracy ${suite.thresholds.maxNoContextAccuracy}`
    )
  }
  const retrieved = summaryByCondition.get("retrieved-context")
  if (oracle && retrieved && oracle.successRate > 0) {
    const ratio = roundMetric(retrieved.successRate / oracle.successRate)
    if (ratio < suite.thresholds.minRetrievedOracleRatio) {
      failures.push(
        `retrieved/oracle success ratio ${ratio} is below minRetrievedOracleRatio ${suite.thresholds.minRetrievedOracleRatio}`
      )
    }
  }
  if (retrieved && retrieved.harmfulRate > suite.thresholds.maxHarmfulContextRate) {
    failures.push(
      `retrieved-context harmful rate ${retrieved.harmfulRate} exceeds maxHarmfulContextRate ${suite.thresholds.maxHarmfulContextRate}`
    )
  }
  return failures
}

function summarizeSkillUseLift(
  suite: SkillUseSuite,
  results: SkillUseResult[]
): SkillUseLiftSummary {
  const byTaskCondition = new Map<string, Map<SkillUseCondition, SkillUseResult>>()
  for (const result of results) {
    const byCondition = byTaskCondition.get(result.taskId) ?? new Map()
    byCondition.set(result.condition, result)
    byTaskCondition.set(result.taskId, byCondition)
  }
  const noContext = results.filter((result) => result.condition === "no-context")
  const oracle = results.filter((result) => result.condition === "oracle-context")
  const retrieved = results.filter((result) => result.condition === "retrieved-context")
  const contextDependentTaskIds: string[] = []
  const retrievedLiftedTaskIds: string[] = []
  const retrievedHarmedTaskIds: string[] = []

  for (const task of suite.tasks) {
    const byCondition = byTaskCondition.get(task.id)
    if (!byCondition) continue
    const noContextResult = byCondition.get("no-context")
    const oracleResult = byCondition.get("oracle-context")
    const retrievedResult = byCondition.get("retrieved-context")
    if (
      noContextResult &&
      oracleResult &&
      !noContextResult.success &&
      oracleResult.success
    ) {
      contextDependentTaskIds.push(task.id)
    }
    if (
      noContextResult &&
      retrievedResult &&
      !noContextResult.success &&
      retrievedResult.success
    ) {
      retrievedLiftedTaskIds.push(task.id)
    }
    if (
      oracleResult &&
      retrievedResult &&
      oracleResult.success &&
      !retrievedResult.success
    ) {
      retrievedHarmedTaskIds.push(task.id)
    }
  }

  const noContextAccuracy =
    noContext.length === 0
      ? null
      : averageMetric(noContext.map((result) => (result.success ? 1 : 0)))
  const oracleAccuracy =
    oracle.length === 0
      ? null
      : averageMetric(oracle.map((result) => (result.success ? 1 : 0)))
  const retrievedAccuracy =
    retrieved.length === 0
      ? null
      : averageMetric(retrieved.map((result) => (result.success ? 1 : 0)))

  return {
    retrievedVsNoContextAccuracyDelta:
      noContextAccuracy === null || retrievedAccuracy === null
        ? null
        : roundMetric(retrievedAccuracy - noContextAccuracy),
    retrievedGapToOracle:
      oracleAccuracy === null || retrievedAccuracy === null
        ? null
        : roundMetric(oracleAccuracy - retrievedAccuracy),
    contextDependentTaskIds,
    retrievedLiftedTaskIds,
    retrievedHarmedTaskIds,
  }
}

function scoreSkillUseAnswer(answer: SkillUseTask["answer"], value: string): boolean {
  const actual = answer.caseSensitive ? value.trim() : value.trim().toLowerCase()
  return answer.accepted.some((expected) => {
    if (answer.mode === "regex") {
      const flags = answer.caseSensitive ? "" : "i"
      return new RegExp(expected, flags).test(value)
    }
    const normalizedExpected = answer.caseSensitive
      ? expected.trim()
      : expected.trim().toLowerCase()
    if (answer.mode === "exact") return actual === normalizedExpected
    return actual.includes(normalizedExpected)
  })
}

function validateSkillUseCorpus(input: {
  suite: SkillUseSuite
  documents: SkillUseDocument[]
}): void {
  assertUniqueIds(input.documents, "skill-use document")
  const documentIds = new Set(input.documents.map((document) => document.id))
  for (const task of input.suite.tasks) {
    for (const id of [
      ...supportEvidenceIds(task.supportSets),
      ...task.acceptableEvidenceIds,
      ...task.harmfulEvidenceIds,
      ...(task.oracleContextIds ?? []),
    ]) {
      if (!documentIds.has(id)) {
        throw new Error(`task "${task.id}" references unknown skill-use document "${id}"`)
      }
    }
  }
}

function skillUseFailureReasons(input: {
  answerCorrect: boolean
  contextSufficient: boolean
  supportSetSatisfied: boolean
  harmfulContextIdsSurfaced: string[]
}): string[] {
  const failures: string[] = []
  if (!input.answerCorrect) failures.push("answer-incorrect")
  if (!input.contextSufficient) failures.push("context-insufficient")
  if (!input.supportSetSatisfied) failures.push("support-set-missing")
  if (input.harmfulContextIdsSurfaced.length > 0) failures.push("harmful-context")
  if (input.supportSetSatisfied && !input.answerCorrect) {
    failures.push("present-but-unused")
  }
  return failures
}

function supportEvidenceIds(supportSets: SkillUseTask["supportSets"]): string[] {
  const ids = new Set<string>()
  for (const supportSet of supportSets) {
    for (const id of supportSet.documentIds) ids.add(id)
  }
  return Array.from(ids)
}

function firstSatisfiedSupportSet(
  supportSets: SkillUseTask["supportSets"],
  contextIds: string[]
): SkillUseTask["supportSets"][number] | null {
  const idSet = new Set(contextIds)
  return (
    supportSets.find((supportSet) =>
      supportSet.documentIds.every((id) => idSet.has(id))
    ) ?? null
  )
}

function readJsonlText<T>(
  raw: string,
  path: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  label: string
): T[] {
  const rows: T[] = []
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`${label} JSONL parse failed at ${path}:${index + 1}: ${message}`, {
        cause: err,
      })
    }
    try {
      rows.push(schema.parse(parsed))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`${label} validation failed at ${path}:${index + 1}: ${message}`, {
        cause: err,
      })
    }
  }
  return rows
}

function assertUniqueIds(items: Array<{ id: string }>, label: string): void {
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new Error(`${label} id "${item.id}" is duplicated`)
    }
    seen.add(item.id)
  }
}

function buildKeywordDocument(
  document: SkillUseDocument,
  textFields: SkillUseSuite["document"]["textFields"]
): KeywordDocument {
  const text = renderSkillUseDocument(document, textFields)
  const terms = tokenize(text)
  const termCounts = new Map<string, number>()
  for (const term of terms) {
    termCounts.set(term, (termCounts.get(term) ?? 0) + 1)
  }
  return {
    document,
    text,
    termCounts,
    uniqueTerms: new Set(terms),
    length: terms.length,
  }
}

function renderSkillUseDocument(
  document: SkillUseDocument,
  textFields: SkillUseSuite["document"]["textFields"]
): string {
  const values: string[] = []
  for (const field of textFields) {
    const value = document[field]
    if (typeof value === "string" && value.trim().length > 0) values.push(value)
  }
  return values.join("\n\n")
}

function buildInverseDocumentFrequency(
  documents: KeywordDocument[]
): Map<string, number> {
  const idf = new Map<string, number>()
  for (const document of documents) {
    for (const term of document.uniqueTerms) {
      idf.set(term, (idf.get(term) ?? 0) + 1)
    }
  }
  for (const [term, count] of idf.entries()) {
    idf.set(term, Math.log((documents.length + 1) / (count + 1)) + 1)
  }
  return idf
}

function rankKeywordDocuments(input: {
  query: string
  documents: KeywordDocument[]
  idf: Map<string, number>
  limit: number
}): KeywordDocument[] {
  const queryTerms = tokenize(input.query)
  const queryUnique = new Set(queryTerms)
  return input.documents
    .map((document) => {
      let score = 0
      for (const term of queryUnique) {
        const tf = (document.termCounts.get(term) ?? 0) / Math.max(1, document.length)
        score += tf * (input.idf.get(term) ?? 0)
      }
      return { document, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.document.document.id.localeCompare(b.document.document.id)
    })
    .slice(0, input.limit)
    .map((entry) => entry.document)
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

function estimateContextTokens(texts: string[]): number {
  const characters = texts.reduce((sum, text) => sum + text.length, 0)
  return Math.ceil(characters / 4)
}

function overlap(left: string[], right: string[]): string[] {
  const rightSet = new Set(right)
  return left.filter(
    (value, index) => rightSet.has(value) && left.indexOf(value) === index
  )
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100
}

async function defaultSkillUseArtifactPath(
  loaded: LoadedSkillUseSuite,
  startedAt: string
): Promise<string> {
  const repoRoot = await findRepoRoot(loaded.root)
  const stamp = startedAt.replace(/[:.]/g, "-")
  return join(repoRoot, "evals", "results", `${loaded.suite.name}-${stamp}.json`)
}

async function findRepoRoot(start: string): Promise<string> {
  let current = resolve(start)
  for (;;) {
    const packagePath = join(current, "package.json")
    try {
      const raw = await readFile(packagePath, "utf-8")
      const parsed = JSON.parse(raw) as { name?: string }
      if (parsed.name === "@makenotion/lore") return current
    } catch {
      // Keep walking upward.
    }
    const parent = dirname(current)
    if (parent === current) return resolve(start)
    current = parent
  }
}

export function skillUseSuiteConfigHash(suite: SkillUseSuite): string {
  return createHash("sha256").update(JSON.stringify(suite)).digest("hex")
}
