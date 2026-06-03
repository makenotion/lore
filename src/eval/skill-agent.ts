import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { initServices, type LoreServices } from "../services.js"
import { TASK_EVAL_AGENTS } from "./schema.js"
import {
  BENCH_MODE_SENTINEL,
  BENCH_TOOL_CLI_JS_ENV,
  BENCH_TOOL_NODE_ENV,
  BENCH_TOOL_SHIM_DIR,
  BENCH_TOOL_TRACE_FILE,
  CodexAgentAdapter,
} from "./task-runner/codex-adapter.js"
import type { AgentAdapter, AgentRunResult, AgentRunUsage } from "./task-runner/schema.js"
import { defaultArtifactPath } from "./task-runner/shared.js"
import { BENCH_TOOL_SOCKET_ENV, startBenchToolBroker } from "./bench-tool.js"
import type { BenchRetrievalCall } from "./bench-runner-types.js"
import { averageMetric, scoreRanking, type RankingMetrics } from "./rank-metrics.js"
import {
  loadSkillRetrievalCorpus,
  loadSkillRetrievalSuite,
  readSkillRetrievalImportManifest,
  selectSkillRetrievalQueries,
  type SkillRetrievalImportManifest,
  type SkillRetQrel,
  type SkillRetQuery,
  type SkillRetSkill,
} from "./skill-retrieval.js"

export const SKILL_AGENT_RUNNER = "skill-agent" as const

export const SKILL_AGENT_CONDITIONS = [
  "no-lore",
  "tool-driven-lore",
  "oracle-context",
  "noisy-lore",
] as const

export type SkillAgentCondition = (typeof SKILL_AGENT_CONDITIONS)[number]

const skillAgentConditionSchema = z.enum(SKILL_AGENT_CONDITIONS)

const skillAgentQuerySelectionSchema = z
  .object({
    limit: z.number().int().positive().optional(),
    seed: z.string().min(1).optional(),
    ids: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .default({})

export const skillAgentSuiteSchema = z
  .object({
    version: z.literal(1),
    runner: z.literal(SKILL_AGENT_RUNNER),
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be kebab-case"),
    description: z.string().default(""),
    skillRetrievalSuite: z.string().min(1),
    queries: skillAgentQuerySelectionSchema,
    conditions: z
      .array(skillAgentConditionSchema)
      .min(1)
      .default(["no-lore", "tool-driven-lore", "oracle-context"]),
    requiredConditions: z
      .array(skillAgentConditionSchema)
      .min(1)
      .default(["tool-driven-lore"]),
    agent: z
      .object({
        kind: z.enum(TASK_EVAL_AGENTS).default("codex"),
        timeoutMs: z.number().int().positive().default(300_000),
      })
      .strict()
      .default({ kind: "codex", timeoutMs: 300_000 }),
    scoring: z
      .object({
        k: z.array(z.number().int().positive()).min(1).default([1, 5, 10]),
        requireLoreUse: z.boolean().default(true),
        requireExpandedEvidence: z.boolean().default(true),
      })
      .strict()
      .default({
        k: [1, 5, 10],
        requireLoreUse: true,
        requireExpandedEvidence: true,
      }),
  })
  .strict()
  .superRefine((suite, ctx) => {
    const conditions = new Set<SkillAgentCondition>()
    for (const [index, condition] of suite.conditions.entries()) {
      if (conditions.has(condition)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["conditions", index],
          message: `duplicate skill-agent condition "${condition}"`,
        })
      }
      conditions.add(condition)
    }
    for (const [index, condition] of suite.requiredConditions.entries()) {
      if (!conditions.has(condition)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requiredConditions", index],
          message: `required condition "${condition}" is not present in conditions`,
        })
      }
    }
    const kValues = new Set<number>()
    for (const [index, k] of suite.scoring.k.entries()) {
      if (kValues.has(k)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scoring", "k", index],
          message: `duplicate k value "${k}"`,
        })
      }
      kValues.add(k)
    }
  })

const skillAgentAnswerSchema = z
  .object({
    answer: z.string().default(""),
    usedMemoryIds: z.array(z.string().min(1)).default([]),
    usedSkillIds: z.array(z.string().min(1)).default([]),
    reason: z.string().default(""),
    toolTrace: z.array(z.unknown()).default([]),
  })
  .passthrough()

export type SkillAgentSuite = z.infer<typeof skillAgentSuiteSchema>
export type SkillAgentAnswer = z.infer<typeof skillAgentAnswerSchema>

export interface SkillAgentToolCall {
  tool: string
  action: string | null
  status: "success" | "error"
  surfacedMemoryIds: string[]
  expandedMemoryIds: string[]
  error: string | null
}

export interface SkillAgentResult {
  queryId: string
  query: string
  condition: SkillAgentCondition
  success: boolean
  expectedSkillIds: string[]
  expectedMemoryIds: string[]
  surfacedMemoryIds: string[]
  expandedMemoryIds: string[]
  usedMemoryIds: string[]
  usedSkillIds: string[]
  citationNormalization: {
    rawUsedMemoryIds: string[]
    rawUsedSkillIds: string[]
    skillIdsFromMemoryField: string[]
    memoryIdsFromSkillField: string[]
    normalized: boolean
  }
  answer: string
  toolUse: boolean
  targetSurfaced: boolean
  targetExpanded: boolean
  targetSelected: boolean
  answerApplied: boolean
  writeAttemptsBlocked: number
  ranking: RankingMetrics
  failureReasons: string[]
  agentRun: {
    exitCode: number
    stderr: string
    timedOut: boolean
    refused: boolean
    usage?: AgentRunUsage | null
  }
  toolTrace: SkillAgentToolCall[]
  metrics: {
    elapsedMs: number
    estimatedAnswerTokens: number
  }
}

export interface SkillAgentConditionSummary {
  results: number
  passed: number
  failed: number
  successRate: number
  toolUseRate: number
  targetSurfacedRate: number
  targetExpandedRate: number
  targetSelectedRate: number
  answerAppliedRate: number
  writeAttemptsBlocked: number
  recallAt: Record<string, number>
  ndcgAt: Record<string, number>
  mrrAt: Record<string, number>
  mapAt: Record<string, number>
}

export interface SkillAgentArtifact {
  suite: string
  description: string
  startedAt: string
  runner: {
    mode: typeof SKILL_AGENT_RUNNER
    readOnly: true
    conditions: SkillAgentCondition[]
    requiredConditions: SkillAgentCondition[]
    agent: SkillAgentSuite["agent"]
    scoring: SkillAgentSuite["scoring"]
    skillRetrievalSuite: string
  }
  corpus: {
    skills: number
    queries: number
    qrels: number
    revision: string
    importManifestPath: string
    importManifestSha256: string
  }
  results: SkillAgentResult[]
  summary: {
    queries: number
    totalResults: number
    requiredResults: number
    passedRequiredResults: number
    failedRequiredResults: number
    writeAttemptsBlocked: number
    conditions: Record<SkillAgentCondition, SkillAgentConditionSummary | null>
  }
}

export interface RunSkillAgentOptions {
  outPath?: string
  now?: Date
  agentAdapter?: AgentAdapter
  servicesFactory?: () => Promise<LoreServices>
  keepWorkspaces?: boolean
}

interface LoadedSkillAgentSuite {
  suite: SkillAgentSuite
  path: string
  root: string
}

interface SkillAgentPreparedCorpus {
  skillSuitePath: string
  skills: SkillRetSkill[]
  qrels: SkillRetQrel[]
  selectedQueries: SkillRetQuery[]
  manifest: SkillRetrievalImportManifest
  manifestPath: string
  manifestSha256: string
  revision: string
}

export async function loadSkillAgentSuite(path: string): Promise<LoadedSkillAgentSuite> {
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
    suite: skillAgentSuiteSchema.parse(parsed),
    path: absolute,
    root: dirname(absolute),
  }
}

export async function runSkillAgentSuite(
  suitePath: string,
  options: RunSkillAgentOptions = {}
): Promise<{ artifact: SkillAgentArtifact; outPath: string }> {
  const loaded = await loadSkillAgentSuite(suitePath)
  const startedAt = (options.now ?? new Date()).toISOString()
  const prepared = await prepareSkillAgentCorpus(loaded, options)
  const adapter = options.agentAdapter ?? new CodexAgentAdapter()
  const qrelsByQuery = groupQrelsByQuery(prepared.qrels)
  const results: SkillAgentResult[] = []

  for (const query of prepared.selectedQueries) {
    const expectedSkillIds = (qrelsByQuery.get(query.id) ?? []).map(
      (qrel) => qrel.skill_id
    )
    const expectedMemoryIds = expectedSkillIds
      .map((skillId) => prepared.manifest.skills[skillId]?.memoryId)
      .filter((id): id is string => typeof id === "string")
    for (const condition of loaded.suite.conditions) {
      results.push(
        await runSkillAgentTrial({
          suite: loaded.suite,
          query,
          condition,
          expectedSkillIds,
          expectedMemoryIds,
          manifest: prepared.manifest,
          skills: prepared.skills,
          adapter,
          keepWorkspace: options.keepWorkspaces ?? false,
        })
      )
    }
  }

  const artifact: SkillAgentArtifact = {
    suite: loaded.suite.name,
    description: loaded.suite.description,
    startedAt,
    runner: {
      mode: SKILL_AGENT_RUNNER,
      readOnly: true,
      conditions: [...loaded.suite.conditions],
      requiredConditions: [...loaded.suite.requiredConditions],
      agent: loaded.suite.agent,
      scoring: loaded.suite.scoring,
      skillRetrievalSuite: prepared.skillSuitePath,
    },
    corpus: {
      skills: prepared.skills.length,
      queries: prepared.selectedQueries.length,
      qrels: prepared.qrels.length,
      revision: prepared.revision,
      importManifestPath: prepared.manifestPath,
      importManifestSha256: prepared.manifestSha256,
    },
    results,
    summary: summarizeSkillAgent(loaded.suite, results),
  }

  const outPath = resolve(
    options.outPath ?? defaultArtifactPath(loaded.suite.name, startedAt)
  )
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8")
  return { artifact, outPath }
}

async function prepareSkillAgentCorpus(
  loaded: LoadedSkillAgentSuite,
  options: RunSkillAgentOptions
): Promise<SkillAgentPreparedCorpus> {
  const skillSuitePath = resolve(loaded.root, loaded.suite.skillRetrievalSuite)
  const skillLoaded = await loadSkillRetrievalSuite(skillSuitePath)
  const skillSuite = skillLoaded.suite
  const notion = skillSuite.notion
  if (!notion) {
    throw new Error("skill-agent suites require a SkillRet suite with notion config")
  }
  const corpus = await loadSkillRetrievalCorpus(skillLoaded)
  const selectedQueries = selectSkillRetrievalQueries(
    corpus.queries,
    loaded.suite.queries
  )
  const manifestPath = resolve(skillLoaded.root, notion.importManifestPath)
  const manifestRaw = await readFile(manifestPath, "utf-8")
  const manifest = await readSkillRetrievalImportManifest(manifestPath)
  assertSkillAgentManifestCoversQueries({
    manifest,
    queries: selectedQueries,
    qrels: corpus.qrels,
  })
  const services = await (options.servicesFactory ?? (() => initServices()))()
  assertSkillAgentVaultBinding(notion.expectedVaultPageId, services)
  return {
    skillSuitePath,
    skills: corpus.skills,
    qrels: corpus.qrels,
    selectedQueries,
    manifest,
    manifestPath,
    manifestSha256: sha256Hex(manifestRaw),
    revision: manifest.corpusRevision,
  }
}

async function runSkillAgentTrial(input: {
  suite: SkillAgentSuite
  query: SkillRetQuery
  condition: SkillAgentCondition
  expectedSkillIds: string[]
  expectedMemoryIds: string[]
  manifest: SkillRetrievalImportManifest
  skills: SkillRetSkill[]
  adapter: AgentAdapter
  keepWorkspace: boolean
}): Promise<SkillAgentResult> {
  const before = performance.now()
  const workspace = await mkdtemp(join(tmpdir(), "lore-skill-agent-"))
  const traceFile = join(workspace, BENCH_TOOL_TRACE_FILE)
  const transcriptPath = join(workspace, "agent-transcript.jsonl")
  let broker: Awaited<ReturnType<typeof startBenchToolBroker>> | null = null
  try {
    await writeSkillAgentWorkspace({
      workspace,
      query: input.query,
      condition: input.condition,
      oracleContext: renderOracleContext(input),
    })
    const extraEnv: Record<string, string> = {}
    if (conditionUsesReadOnlyTools(input.condition)) {
      await writeReadOnlyToolShims(workspace)
      broker = await startBenchToolBroker({
        socketPath: join(workspace, "lore-tool.sock"),
        traceFile,
        projectId: input.manifest.projectId,
        projectName: input.manifest.projectName,
      })
      extraEnv[BENCH_TOOL_SOCKET_ENV] = broker.socketPath
    }
    const agentRun = await input.adapter.run({
      prompt: renderSkillAgentPrompt(input),
      workspace,
      timeoutMs: input.suite.agent.timeoutMs,
      transcriptPath,
      extraEnv,
    })
    const parsed = parseSkillAgentAnswer(agentRun.stdout)
    const toolTrace = await readToolTrace(traceFile)
    return scoreSkillAgentTrial({
      suite: input.suite,
      query: input.query,
      condition: input.condition,
      expectedSkillIds: input.expectedSkillIds,
      expectedMemoryIds: input.expectedMemoryIds,
      manifest: input.manifest,
      parsed,
      toolTrace,
      agentRun,
      elapsedMs: performance.now() - before,
    })
  } finally {
    if (broker) await broker.close()
    if (!input.keepWorkspace) await rm(workspace, { recursive: true, force: true })
  }
}

function scoreSkillAgentTrial(input: {
  suite: SkillAgentSuite
  query: SkillRetQuery
  condition: SkillAgentCondition
  expectedSkillIds: string[]
  expectedMemoryIds: string[]
  manifest: SkillRetrievalImportManifest
  parsed: SkillAgentAnswer
  toolTrace: SkillAgentToolCall[]
  agentRun: AgentRunResult
  elapsedMs: number
}): SkillAgentResult {
  const surfacedMemoryIds = uniqueInOrder(
    input.toolTrace.flatMap((call) => call.surfacedMemoryIds)
  )
  const expandedMemoryIds = uniqueInOrder(
    input.toolTrace.flatMap((call) => call.expandedMemoryIds)
  )
  const surfacedSkillIds = uniqueInOrder(
    surfacedMemoryIds.map((id) => memoryIdToSkillId(input.manifest, id))
  )
  const writeAttemptsBlocked = input.toolTrace.filter(isWriteAttemptTrace).length
  const successfulReadCalls = input.toolTrace.filter(
    (call) => call.status === "success" && isReadAction(call)
  )
  const expectedSkills = new Set(input.expectedSkillIds)
  const expectedMemories = new Set(input.expectedMemoryIds)
  const manifestSkillIds = new Set(
    Object.values(input.manifest.skills).map((entry) => entry.skillId)
  )
  const manifestMemoryIds = new Set(
    Object.values(input.manifest.skills).map((entry) => entry.memoryId)
  )
  const parsedMemoryIds = uniqueInOrder(input.parsed.usedMemoryIds)
  const parsedSkillIds = uniqueInOrder(input.parsed.usedSkillIds)
  const skillIdsFromMemoryField = parsedMemoryIds.filter((id) => manifestSkillIds.has(id))
  const memoryIdsFromSkillField = parsedSkillIds.filter((id) => manifestMemoryIds.has(id))
  const usedMemoryIds = uniqueInOrder([
    ...parsedMemoryIds.filter((id) => !manifestSkillIds.has(id)),
    ...memoryIdsFromSkillField,
  ])
  const usedSkillIds = uniqueInOrder([
    ...parsedSkillIds.filter((id) => !manifestMemoryIds.has(id)),
    ...skillIdsFromMemoryField,
    ...usedMemoryIds.map((id) => memoryIdToSkillId(input.manifest, id)),
  ])
  const targetSurfaced = surfacedSkillIds.some((id) => expectedSkills.has(id))
  const targetExpanded = expandedMemoryIds.some((id) => expectedMemories.has(id))
  const targetSelected =
    usedSkillIds.some((id) => expectedSkills.has(id)) ||
    usedMemoryIds.some((id) => expectedMemories.has(id))
  const toolUse = successfulReadCalls.length > 0
  const answerApplied = targetSelected && input.parsed.answer.trim().length > 0
  const ranking = scoreRanking({
    returnedIds: surfacedSkillIds,
    relevant: input.expectedSkillIds.map((id) => ({ id, relevance: 1 })),
    kValues: input.suite.scoring.k,
  })
  const failureReasons = skillAgentFailureReasons({
    suite: input.suite,
    condition: input.condition,
    agentRun: input.agentRun,
    toolUse,
    targetSurfaced,
    targetExpanded,
    targetSelected,
    answerApplied,
    writeAttemptsBlocked,
  })
  return {
    queryId: input.query.id,
    query: input.query.query,
    condition: input.condition,
    success: failureReasons.length === 0,
    expectedSkillIds: [...input.expectedSkillIds],
    expectedMemoryIds: [...input.expectedMemoryIds],
    surfacedMemoryIds,
    expandedMemoryIds,
    usedMemoryIds,
    usedSkillIds,
    citationNormalization: {
      rawUsedMemoryIds: parsedMemoryIds,
      rawUsedSkillIds: parsedSkillIds,
      skillIdsFromMemoryField,
      memoryIdsFromSkillField,
      normalized:
        skillIdsFromMemoryField.length > 0 || memoryIdsFromSkillField.length > 0,
    },
    answer: input.parsed.answer,
    toolUse,
    targetSurfaced,
    targetExpanded,
    targetSelected,
    answerApplied,
    writeAttemptsBlocked,
    ranking,
    failureReasons,
    agentRun: {
      exitCode: input.agentRun.exitCode,
      stderr: input.agentRun.stderr,
      timedOut: input.agentRun.timedOut,
      refused: input.agentRun.refused === true,
      usage: input.agentRun.usage,
    },
    toolTrace: input.toolTrace,
    metrics: {
      elapsedMs: roundMs(input.elapsedMs),
      estimatedAnswerTokens: estimateTokens([input.parsed.answer]),
    },
  }
}

function skillAgentFailureReasons(input: {
  suite: SkillAgentSuite
  condition: SkillAgentCondition
  agentRun: AgentRunResult
  toolUse: boolean
  targetSurfaced: boolean
  targetExpanded: boolean
  targetSelected: boolean
  answerApplied: boolean
  writeAttemptsBlocked: number
}): string[] {
  const failures: string[] = []
  if (input.agentRun.refused === true) failures.push("agent-refused")
  else if (input.agentRun.timedOut) failures.push("agent-timeout")
  else if (input.agentRun.exitCode !== 0) failures.push("agent-exit")
  if (input.writeAttemptsBlocked > 0) failures.push("write-attempt-blocked")
  if (input.condition === "tool-driven-lore" || input.condition === "noisy-lore") {
    if (input.suite.scoring.requireLoreUse && !input.toolUse) {
      failures.push("lore-tool-not-used")
    }
    if (!input.targetSurfaced) failures.push("target-not-surfaced")
    if (input.suite.scoring.requireExpandedEvidence && !input.targetExpanded) {
      failures.push("target-not-expanded")
    }
  }
  if (!input.targetSelected) failures.push("target-not-selected")
  if (!input.answerApplied) failures.push("answer-did-not-apply-target")
  return failures
}

function summarizeSkillAgent(
  suite: SkillAgentSuite,
  results: SkillAgentResult[]
): SkillAgentArtifact["summary"] {
  const required = new Set(suite.requiredConditions)
  const conditionSummaries = Object.fromEntries(
    SKILL_AGENT_CONDITIONS.map((condition) => {
      if (!suite.conditions.includes(condition)) return [condition, null]
      const rows = results.filter((result) => result.condition === condition)
      return [condition, summarizeCondition(suite, rows)]
    })
  ) as Record<SkillAgentCondition, SkillAgentConditionSummary | null>
  const requiredResults = results.filter((result) => required.has(result.condition))
  return {
    queries: new Set(results.map((result) => result.queryId)).size,
    totalResults: results.length,
    requiredResults: requiredResults.length,
    passedRequiredResults: requiredResults.filter((result) => result.success).length,
    failedRequiredResults: requiredResults.filter((result) => !result.success).length,
    writeAttemptsBlocked: results.reduce(
      (total, result) => total + result.writeAttemptsBlocked,
      0
    ),
    conditions: conditionSummaries,
  }
}

function summarizeCondition(
  suite: SkillAgentSuite,
  results: SkillAgentResult[]
): SkillAgentConditionSummary {
  const recallAt: Record<string, number> = {}
  const ndcgAt: Record<string, number> = {}
  const mrrAt: Record<string, number> = {}
  const mapAt: Record<string, number> = {}
  for (const k of suite.scoring.k) {
    const key = String(k)
    recallAt[key] = averageMetric(
      results.map((result) => result.ranking.recallAt[key] ?? 0)
    )
    ndcgAt[key] = averageMetric(results.map((result) => result.ranking.ndcgAt[key] ?? 0))
    mrrAt[key] = averageMetric(results.map((result) => result.ranking.mrrAt[key] ?? 0))
    mapAt[key] = averageMetric(
      results.map((result) => result.ranking.averagePrecisionAt[key] ?? 0)
    )
  }
  return {
    results: results.length,
    passed: results.filter((result) => result.success).length,
    failed: results.filter((result) => !result.success).length,
    successRate: averageBoolean(results.map((result) => result.success)),
    toolUseRate: averageBoolean(results.map((result) => result.toolUse)),
    targetSurfacedRate: averageBoolean(results.map((result) => result.targetSurfaced)),
    targetExpandedRate: averageBoolean(results.map((result) => result.targetExpanded)),
    targetSelectedRate: averageBoolean(results.map((result) => result.targetSelected)),
    answerAppliedRate: averageBoolean(results.map((result) => result.answerApplied)),
    writeAttemptsBlocked: results.reduce(
      (total, result) => total + result.writeAttemptsBlocked,
      0
    ),
    recallAt,
    ndcgAt,
    mrrAt,
    mapAt,
  }
}

function renderSkillAgentPrompt(input: {
  suite: SkillAgentSuite
  query: SkillRetQuery
  condition: SkillAgentCondition
}): string {
  const toolInstructions = conditionUsesReadOnlyTools(input.condition)
    ? [
        "Use the read-only Lore tools before answering.",
        "First split the task into capability, framework/tool, and action-intent facets; use those facets to choose search queries.",
        '`lore-query action=search query="<skill or task paraphrase>" limit=10 mode=semantic` searches the seeded SkillRet vault.',
        "For multi-part tasks, run separate searches for the distinct capabilities instead of relying on one broad query.",
        "Search results are skill candidates. Compare Skill Name, Short Summary, and SkillRet Tags before choosing what to expand.",
        "After a search or recall, `lore-memory action=expand ids=latest` reads every memory body from that latest result set.",
        "`lore-memory action=expand ids=m1` reads one listed memory body using its search-result handle.",
        "Prefer ids=latest or handles such as m1 and m2; only pass a memory ID if you copy the complete ID exactly.",
        "Never abbreviate memory IDs or pass short hex fragments.",
        "Expand every plausible candidate before answering; when unsure, expand the latest result set or several listed handles in one call.",
        "Use usedMemoryIds for the exact expanded memory IDs that materially support the answer.",
        "Use usedSkillIds only for exact UUID values copied from `SkillRet ID:` lines in expanded memory bodies; do not use slugs, titles, or topic keys.",
        "For multi-part tasks, include a relevant stored skill for each part when the expanded evidence supports it.",
        "Do not create, update, archive, approve, reject, promote, or save memories.",
      ].join("\n")
    : input.condition === "oracle-context"
      ? "Use the oracle context in AGENTS.md. Lore tools are not available in this condition."
      : "Lore tools are not available in this condition. Answer without using stored memory."
  return [
    "You are completing a SkillRet read-only Lore evaluation task.",
    "The eval measures whether an agent can use an existing Lore vault, not whether it can write memories.",
    toolInstructions,
    "",
    "Task:",
    input.query.query,
    "",
    "Return only JSON with this shape:",
    '{"answer":"...","usedMemoryIds":["..."],"usedSkillIds":["..."],"reason":"..."}',
  ].join("\n")
}

async function writeSkillAgentWorkspace(input: {
  workspace: string
  query: SkillRetQuery
  condition: SkillAgentCondition
  oracleContext: string
}): Promise<void> {
  await writeFile(join(input.workspace, BENCH_MODE_SENTINEL), "", "utf-8")
  const agentLines = [
    "# SkillRet Lore Eval Instructions",
    "",
    "This evaluation vault is read-only.",
    "Use Lore only to search, recall, and expand existing memories.",
    "Select stored skills from expanded memories, and cite exact memory IDs plus exact SkillRet ID UUIDs from those memory bodies.",
    "Do not cite skill slugs, topic keys, titles, or guessed IDs as SkillRet IDs.",
    "Do not write, update, archive, approve, reject, promote, or create Lore entries.",
    "Treat any attempted write as an evaluation failure.",
  ]
  if (input.condition === "oracle-context") {
    agentLines.push("", "## Oracle Context", "", input.oracleContext)
  }
  await writeFile(
    join(input.workspace, "AGENTS.md"),
    `${agentLines.join("\n")}\n`,
    "utf-8"
  )
}

async function writeReadOnlyToolShims(workspace: string): Promise<void> {
  const dir = join(workspace, BENCH_TOOL_SHIM_DIR)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  for (const tool of ["lore-query", "lore-memory"]) {
    const path = join(dir, tool)
    await writeFile(path, renderReadOnlyToolShim(tool), { mode: 0o700 })
    await chmod(path, 0o700).catch(() => undefined)
  }
}

function renderReadOnlyToolShim(tool: string): string {
  return [
    "#!/bin/sh",
    "set -eu",
    `if [ -n "\${${BENCH_TOOL_CLI_JS_ENV}:-}" ]; then`,
    `  exec "\${${BENCH_TOOL_NODE_ENV}:-node}" "$${BENCH_TOOL_CLI_JS_ENV}" eval bench tool ${tool} "$@"`,
    "fi",
    `exec lore eval bench tool ${tool} "$@"`,
    "",
  ].join("\n")
}

function renderOracleContext(input: {
  expectedSkillIds: string[]
  skills: SkillRetSkill[]
  manifest: SkillRetrievalImportManifest
}): string {
  const skillsById = new Map(input.skills.map((skill) => [skill.id, skill]))
  return input.expectedSkillIds
    .map((skillId) => {
      const skill = skillsById.get(skillId)
      const manifest = input.manifest.skills[skillId]
      if (!skill || !manifest) return ""
      return [
        `Memory ID: ${manifest.memoryId}`,
        `SkillRet ID: ${skill.id}`,
        `Title: ${skill.name}`,
        skill.description ? `Description: ${skill.description}` : "",
        skill.skill_md ? `Procedure:\n${skill.skill_md}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    })
    .filter(Boolean)
    .join("\n\n---\n\n")
}

async function readToolTrace(path: string): Promise<SkillAgentToolCall[]> {
  try {
    const raw = await readFile(path, "utf-8")
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseToolTrace(JSON.parse(line) as unknown))
  } catch {
    return []
  }
}

function parseToolTrace(value: unknown): SkillAgentToolCall {
  const call = value as Partial<BenchRetrievalCall> & {
    surfacedMemoryIds?: unknown
    expandedMemoryIds?: unknown
  }
  return {
    tool: typeof call.tool === "string" ? call.tool : "unknown",
    action: typeof call.action === "string" || call.action === null ? call.action : null,
    status: call.status === "error" ? "error" : "success",
    surfacedMemoryIds: stringArray(call.surfacedMemoryIds),
    expandedMemoryIds: stringArray(call.expandedMemoryIds),
    error: typeof call.error === "string" ? call.error : null,
  }
}

function parseSkillAgentAnswer(stdout: string): SkillAgentAnswer {
  const trimmed = stdout.trim()
  if (trimmed.length === 0)
    return { answer: "", usedMemoryIds: [], usedSkillIds: [], reason: "", toolTrace: [] }
  const parsed = parseStructuredSkillAgentAnswer(trimmed)
  if (parsed) return parsed
  const agentMessage = extractCodexAgentMessage(trimmed)
  if (agentMessage) {
    const parsedMessage = parseStructuredSkillAgentAnswer(agentMessage.trim())
    if (parsedMessage) return parsedMessage
  }
  return {
    answer: trimmed,
    usedMemoryIds: [],
    usedSkillIds: [],
    reason: "agent did not return structured JSON",
    toolTrace: [],
  }
}

function parseStructuredSkillAgentAnswer(value: string): SkillAgentAnswer | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(value)
  const start = value.indexOf("{")
  const end = value.lastIndexOf("}")
  if (!fenced && (start < 0 || end < start)) return null
  const candidate = fenced?.[1] ?? value.slice(start, end + 1)
  try {
    return skillAgentAnswerSchema.parse(JSON.parse(candidate))
  } catch {
    return null
  }
}

function extractCodexAgentMessage(stdout: string): string | null {
  let message: string | null = null
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    const event = parsed as { item?: { type?: unknown; text?: unknown } }
    if (event.item?.type === "agent_message" && typeof event.item.text === "string") {
      message = event.item.text
    }
  }
  return message
}

function conditionUsesReadOnlyTools(condition: SkillAgentCondition): boolean {
  return condition === "tool-driven-lore" || condition === "noisy-lore"
}

function isReadAction(call: SkillAgentToolCall): boolean {
  if (call.tool === "lore-query") {
    return call.action === "search" || call.action === "recall"
  }
  return call.tool === "lore-memory" && call.action === "expand"
}

function isWriteAttemptTrace(call: SkillAgentToolCall): boolean {
  if (call.tool === "lore-query") return false
  if (call.tool === "lore-memory") return call.action !== "expand"
  if (call.tool === "lore-context") return call.action === "digest"
  return /^lore-(?:fact|decision|task|procedure|pinned)$/u.test(call.tool)
}

function memoryIdToSkillId(
  manifest: SkillRetrievalImportManifest,
  memoryId: string
): string {
  for (const entry of Object.values(manifest.skills)) {
    if (entry.memoryId === memoryId) return entry.skillId
  }
  return `unknown:${memoryId}`
}

function groupQrelsByQuery(qrels: SkillRetQrel[]): Map<string, SkillRetQrel[]> {
  const grouped = new Map<string, SkillRetQrel[]>()
  for (const qrel of qrels) {
    const rows = grouped.get(qrel.query_id)
    if (rows) rows.push(qrel)
    else grouped.set(qrel.query_id, [qrel])
  }
  return grouped
}

function assertSkillAgentManifestCoversQueries(input: {
  manifest: SkillRetrievalImportManifest
  queries: SkillRetQuery[]
  qrels: SkillRetQrel[]
}): void {
  const qrelsByQuery = groupQrelsByQuery(input.qrels)
  const importedSkillIds = new Set(
    Object.values(input.manifest.skills).map((entry) => entry.skillId)
  )
  const missing = new Set<string>()
  for (const query of input.queries) {
    for (const qrel of qrelsByQuery.get(query.id) ?? []) {
      if (!importedSkillIds.has(qrel.skill_id)) missing.add(qrel.skill_id)
    }
  }
  if (missing.size === 0) return
  const sample = Array.from(missing).sort().slice(0, 10)
  throw new Error(
    `Skill-agent import manifest is incomplete for the selected queries; ` +
      `missing ${missing.size} required skill(s): ${sample.join(", ")}`
  )
}

function assertSkillAgentVaultBinding(
  expectedVaultPageId: string | undefined,
  services: LoreServices
): void {
  if (!expectedVaultPageId) return
  const actual = services.config.vault.pageId
  if (normalizePageId(actual) === normalizePageId(expectedVaultPageId)) return
  throw new Error(
    `Skill-agent suite is bound to vault ${expectedVaultPageId}, but active Lore config points at ${actual}.`
  )
}

function normalizePageId(value: string): string {
  return value.trim().toLowerCase().replaceAll("-", "")
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function averageBoolean(values: boolean[]): number {
  return averageMetric(values.map((value) => (value ? 1 : 0)))
}

function estimateTokens(texts: string[]): number {
  return Math.round(texts.join("\n").length / 4)
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}
