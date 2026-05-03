import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, parse, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import {
  loadWakeUpData,
  type WakeUpData,
  type WakeUpOptions,
  type WakeUpServices,
} from "../core/wakeup.js"
import type {
  DecisionSummary,
  Fact,
  ListDecisionsOpts,
  ListTasksOpts,
  Memory,
  MemorySource,
  TaskSummary,
  TaskState,
} from "../types.js"
import {
  loadEvalSuite,
  type EvalRunner,
  type EvalFixtureMemory,
  type EvalMemoryScenario,
  type EvalSurface,
  type EvalTask,
  type LoadedEvalSuite,
} from "./schema.js"

export interface RunEvalOptions {
  runner?: EvalRunner
  trials?: number
  outPath?: string
  now?: Date
}

export interface EvalRunArtifact {
  suite: string
  description: string
  startedAt: string
  runner: {
    mode: "retrieval"
    /**
     * Distinct retrieval surfaces exercised across the run, sorted
     * alphabetically by surface name (default `Array.prototype.sort()`
     * over `EvalSurface` strings) so downstream consumers can
     * binary-search and so the artifact diff is order-stable across
     * runs.
     *
     * Migration recipe from the pre-multi-surface artifact (which had
     * a single `runner.surface` string):
     * 1. Legacy reader detection: `Array.isArray(artifact.runner.surfaces)`
     *    distinguishes the new shape from the legacy `surface` literal.
     * 2. Single-surface back-compat: when `surfaces.length === 1`,
     *    `surfaces[0]` is the equivalent of the old `surface` field.
     * 3. Multi-surface runs: legacy readers must reject or scope to the
     *    surface they care about — `runner.surfaces.includes(<surface>)`
     *    is the supported predicate.
     */
    surfaces: EvalSurface[]
    requestedTrials: number
    executedTrials: number
  }
  results: EvalTaskResult[]
  summary: EvalRunSummary
}

export interface EvalTaskResult {
  taskId: string
  scenario: string
  trial: number
  success: boolean
  surfacedMemoryIds: string[]
  expectedMemoriesSurfaced: string[]
  missingExpectedMemories: string[]
  unexpectedMemoriesSurfaced: string[]
  retrieval: {
    surface: EvalSurface
    limit: number
    recall: number | null
    precision: number | null
  }
  metrics: {
    elapsedMs: number
  }
}

export interface EvalRunSummary {
  tasks: number
  scenarios: string[]
  trials: number
  totalResults: number
  passedResults: number
  failedResults: number
  retrieval: {
    averageRecall: number | null
    averagePrecision: number | null
    memoryLift: number | null
    memoryHarm: number | null
  }
}

interface LoadedScenario {
  id: string
  fixture: EvalMemoryScenario
}

const RESULT_TIMESTAMP_PATTERN = /[:.]/g
const EVAL_PROJECT_ID = "eval-project"

/**
 * Deterministic clock used when the caller does not supply `options.now`.
 * The eval runner is contractually deterministic; without a pinned clock
 * the relatedMemories and staleConfidence surfaces drift with wall-clock
 * time. Pinned to a stable date that's far enough back that any
 * fixture-defined `createdAt` (currently 2026-01-N for the N-th memory)
 * is in the past relative to it.
 */
const DEFAULT_RETRIEVAL_NOW = new Date("2026-05-03T12:00:00.000Z")

export async function runEvalSuite(
  suitePath: string,
  options: RunEvalOptions = {}
): Promise<{ artifact: EvalRunArtifact; outPath: string }> {
  const loaded = await loadEvalSuite(suitePath)
  const runner = options.runner ?? loaded.suite.runner
  if (runner !== "retrieval") {
    throw new Error(
      `Unsupported eval runner "${runner}". Only "retrieval" is implemented.`
    )
  }

  const requestedTrials = options.trials ?? loaded.suite.trials
  if (!Number.isSafeInteger(requestedTrials) || requestedTrials < 1) {
    throw new Error(`--trials must be a positive safe integer, got ${requestedTrials}`)
  }
  if (requestedTrials !== 1) {
    throw new Error(
      `The retrieval eval runner requires trials to be 1; got ${requestedTrials}.`
    )
  }
  const executedTrials = 1

  // Pin a deterministic clock for the whole run when the caller did not
  // supply one. wake-up.relatedMemories and wake-up.staleConfidence both
  // call into time-sensitive task-bucketing helpers (taskDaysStale,
  // STALE_CONFIDENCE_DAYS) — without a fixed `now`, eval results would
  // drift with wall-clock time on a calendar boundary. The deterministic
  // default mirrors the suite's "trials: 1, retrieval is deterministic"
  // contract.
  const now = options.now ?? DEFAULT_RETRIEVAL_NOW
  const startedAt = now.toISOString()
  const results: EvalTaskResult[] = []
  const scenarioIds = new Set<string>()
  const surfacesExercised = new Set<EvalSurface>()

  for (const task of loaded.suite.tasks) {
    surfacesExercised.add(task.surface)
    const scenarios = await loadTaskScenarios(loaded, task)
    for (const scenario of scenarios) {
      scenarioIds.add(scenario.id)
      for (let trial = 1; trial <= executedTrials; trial++) {
        results.push(await runRetrievalTrial(task, scenario, trial, now))
      }
    }
  }

  const artifact: EvalRunArtifact = {
    suite: loaded.suite.name,
    description: loaded.suite.description,
    startedAt,
    runner: {
      mode: "retrieval",
      surfaces: Array.from(surfacesExercised).sort(),
      requestedTrials,
      executedTrials,
    },
    results,
    summary: summarizeResults(
      loaded.suite.tasks,
      Array.from(scenarioIds),
      executedTrials,
      results
    ),
  }

  const outPath = resolve(
    options.outPath ?? (await defaultArtifactPath(loaded, startedAt))
  )
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8")

  return { artifact, outPath }
}

async function loadTaskScenarios(
  loaded: LoadedEvalSuite,
  task: EvalTask
): Promise<LoadedScenario[]> {
  const scenarios: LoadedScenario[] = []
  for (const [id, relativePath] of Object.entries(task.memoryScenarios)) {
    const scenarioPath = resolve(loaded.root, relativePath)
    const fixture = loaded.scenarioFixtures.get(scenarioPath)
    if (!fixture) {
      throw new Error(
        `Scenario "${id}" was not loaded from ${scenarioPath}; reload the eval suite before running.`
      )
    }
    scenarios.push({ id, fixture })
  }
  return scenarios
}

interface SurfaceConfig {
  /**
   * Build the WakeUpOptions overlay that drives `loadWakeUpData` toward
   * surfacing rows in the named section. Every surface zeroes out the
   * other section limits so the runner exercises only the surface under
   * test. The user prompt is supplied separately so taskMemories can
   * thread it into `userQuery`.
   */
  configureOptions: (limit: number, prompt: string) => Partial<WakeUpOptions>
  /**
   * Extract the section's surfaced memory ids from the loadWakeUpData result.
   * The runner passes the task's `retrieval.limit` through so surfaces whose
   * underlying wake-up call ignores the cap (notably `staleConfidence`, which
   * production hard-codes to STALE_CONFIDENCE_LIMIT) can still honor it.
   */
  extract: (data: WakeUpData, limit: number) => string[]
}

const ZEROED_SECTION_OPTIONS: Partial<WakeUpOptions> = {
  taskMemoryLimit: 0,
  memoryLimit: 0,
  memoryLimitWithDigest: 0,
  relatedMemoryLimit: 0,
  knowledgeFactLimit: 0,
  taskLimit: 0,
  includeDecisions: false,
  includeStaleConfidence: false,
}

/**
 * How many active tasks to surface so the relatedMemories search has
 * something to seed from. The relatedMemories search is gated on
 * `tasks.length > 0`; this just needs to be > 0. Picked at 5 to mirror
 * a reasonable per-project active-task density in a small fixture.
 */
const RELATED_TASK_SEED_LIMIT = 5

const SURFACE_REGISTRY: Record<EvalSurface, SurfaceConfig> = {
  "wake-up.taskMemories": {
    configureOptions: (limit, prompt) => ({
      ...ZEROED_SECTION_OPTIONS,
      userQuery: prompt,
      taskMemoryLimit: limit,
    }),
    extract: (data, _limit) => data.taskMemories.map((m) => m.id),
  },
  "wake-up.memories": {
    configureOptions: (limit) => ({
      ...ZEROED_SECTION_OPTIONS,
      memoryLimit: limit,
      memoryLimitWithDigest: limit,
    }),
    extract: (data, _limit) => data.memories.map((m) => m.id),
  },
  "wake-up.relatedMemories": {
    configureOptions: (limit) => ({
      ...ZEROED_SECTION_OPTIONS,
      // Active tasks must be > 0 for the related-memory search to seed.
      // The fixture's tasks list drives the seed entities.
      taskLimit: RELATED_TASK_SEED_LIMIT,
      relatedMemoryLimit: limit,
    }),
    extract: (data, _limit) => data.relatedMemories.map((m) => m.id),
  },
  "wake-up.staleConfidence": {
    configureOptions: () => ({
      ...ZEROED_SECTION_OPTIONS,
      includeStaleConfidence: true,
    }),
    // Production wake-up hard-codes STALE_CONFIDENCE_LIMIT for the
    // queryStaleConfidence call, so the eval can't tune the section
    // cap via task.retrieval.limit. Apply the limit at extraction
    // time instead so the artifact's `retrieval.limit` field stays
    // honest about how many ids could surface.
    //
    // Fixture-mode caveat: production `queryStaleConfidence` orders
    // results explicitly (by stored confidence score / staleness
    // signal), but the fixture stub just returns rows in the order
    // they appear in YAML — see `fixtureWakeUpServices.queryStaleConfidence`.
    // The post-fetch slice here therefore reflects YAML declaration
    // order, NOT production ranking. A regression test that asserts a
    // specific top-1 id is implicitly testing fixture-load order, not
    // the production ranking algorithm. Mirroring production order in
    // the fixture stub is tracked under the same fixture-extraction
    // TODO as the `fixtureMemoryToMemory` literals below.
    extract: (data, limit) =>
      data.staleConfidence.slice(0, limit).map((m) => m.id),
  },
}

async function runRetrievalTrial(
  task: EvalTask,
  scenario: LoadedScenario,
  trial: number,
  now: Date
): Promise<EvalTaskResult> {
  const limit = task.retrieval.limit
  const config = SURFACE_REGISTRY[task.surface]
  const before = performance.now()
  const data = await loadWakeUpData(fixtureWakeUpServices(scenario.fixture), {
    projectId: EVAL_PROJECT_ID,
    includeMemoryContent: true,
    now: now.getTime(),
    ...config.configureOptions(limit, task.prompt),
  })
  return buildRetrievalResult({
    task,
    scenarioId: scenario.id,
    trial,
    limit,
    elapsedMs: roundMetric(performance.now() - before),
    surfacedMemoryIds: config.extract(data, limit),
  })
}

function buildRetrievalResult(input: {
  task: EvalTask
  scenarioId: string
  trial: number
  limit: number
  elapsedMs: number
  surfacedMemoryIds: string[]
}): EvalTaskResult {
  const expectation = input.task.expectedRetrieval[input.scenarioId] ?? {
    shouldSurface: [],
    shouldNotSurface: [],
  }
  const expectedMemoriesSurfaced = expectation.shouldSurface.filter((id) =>
    input.surfacedMemoryIds.includes(id)
  )
  const missingExpectedMemories = expectation.shouldSurface.filter(
    (id) => !input.surfacedMemoryIds.includes(id)
  )
  const unexpectedMemoriesSurfaced = expectation.shouldNotSurface.filter((id) =>
    input.surfacedMemoryIds.includes(id)
  )
  const recall =
    expectation.shouldSurface.length === 0
      ? null
      : roundMetric(expectedMemoriesSurfaced.length / expectation.shouldSurface.length)
  const precision =
    expectation.shouldSurface.length === 0
      ? null
      : roundMetric(
          expectedMemoriesSurfaced.length / Math.max(1, input.surfacedMemoryIds.length)
        )

  return {
    taskId: input.task.id,
    scenario: input.scenarioId,
    trial: input.trial,
    success:
      missingExpectedMemories.length === 0 && unexpectedMemoriesSurfaced.length === 0,
    surfacedMemoryIds: input.surfacedMemoryIds,
    expectedMemoriesSurfaced,
    missingExpectedMemories,
    unexpectedMemoriesSurfaced,
    retrieval: {
      surface: input.task.surface,
      limit: input.limit,
      recall,
      precision,
    },
    metrics: {
      elapsedMs: input.elapsedMs,
    },
  }
}

/**
 * Memory statuses that the fixture-runner suppresses from retrieval.
 * Production retrieval today is status-blind (Notion's `dataSources.query`
 * and `client.search` do not filter on the `Status` column), so this is
 * the eval's enforced contract: a status-aware retriever MUST drop
 * superseded/deprecated/rejected rows before they reach an agent.
 * Tracked under #284's temporal-correctness work; the Notion-backed
 * runner exercises whatever production actually does and may report
 * harm > 0 until that lands.
 */
const SUPPRESSED_RETRIEVAL_STATUSES = new Set([
  "superseded",
  "deprecated",
  "rejected",
])

function isStatusRetrievable(memory: Memory): boolean {
  return !SUPPRESSED_RETRIEVAL_STATUSES.has(memory.status)
}

function fixtureWakeUpServices(scenario: EvalMemoryScenario): WakeUpServices {
  const memories = scenario.memories.map((memory, index) =>
    fixtureMemoryToMemory(memory, index)
  )
  const memoriesById = new Map(memories.map((memory) => [memory.id, memory]))
  const staleConfidenceMemories = scenario.memories
    .filter((memory) => memory.isStaleConfidence)
    .map((memory) => memoriesById.get(memory.id))
    .filter((memory): memory is Memory => memory !== undefined)
  const tasks = scenario.tasks.map((task) => fixtureTaskToSummary(task))
  return {
    memories: {
      list: async (opts) => {
        const sourceFiltered = opts.source
          ? memories.filter((memory) => memory.source === opts.source)
          : memories
        // Status filter mirrors the same suppression applied to search:
        // a status-aware retriever does not surface superseded/deprecated
        // rows on the recents (memories.list) path either.
        const statusFiltered = sourceFiltered.filter(isStatusRetrievable)
        const limit = opts.limit ?? Number.MAX_SAFE_INTEGER
        return { items: statusFiltered.slice(0, limit) }
      },
      search: async (input) =>
        searchFixtureMemories(input.query, memories).slice(0, input.limit),
      queryStaleConfidence: async (opts) =>
        staleConfidenceMemories.slice(0, opts.limit),
    },
    facts: {
      listRecent: async () => ({ items: [] as Fact[], hasMore: false }),
    },
    decisions: {
      list: async (_opts?: ListDecisionsOpts) => ({
        items: [] as DecisionSummary[],
        nextCursor: undefined,
      }),
      queryOverdue: async () => [],
    },
    tasks: {
      list: async (_opts?: ListTasksOpts) => ({
        items: tasks,
        nextCursor: undefined,
      }),
    },
  }
}

// TODO(eval-fixtures-module): extract this and `fixtureMemoryToMemory`
// into `src/eval/fixtures/` with shared TaskSummary / Memory default
// builders so the 30+-field literals do not accumulate drift as
// TaskSummary / Memory evolve. Track alongside the future `orderBy`
// mirror in `fixtureWakeUpServices.queryStaleConfidence` (see surface-
// registry caveat for `wake-up.staleConfidence`).
function fixtureTaskToSummary(
  task: EvalMemoryScenario["tasks"][number]
): TaskSummary {
  const createdAt = new Date(Date.UTC(2026, 0, 1)).toISOString()
  return {
    id: task.id,
    title: task.subject,
    projectIds: [EVAL_PROJECT_ID],
    topicId: null,
    source: "manual" satisfies MemorySource,
    kind: "task",
    status: "informational",
    confidence: "certain",
    confidenceScore: null,
    reviewBy: null,
    doneAt: null,
    decidedAt: null,
    lastReferencedAt: null,
    supersedesIds: [],
    affectsIds: [],
    alternatives: "",
    consequences: "",
    author: "",
    agent: "",
    tags: [],
    keywords: "",
    synopsis: "",
    session: "",
    taskState: "open" satisfies TaskState,
    blockedBy: "",
    entity: task.entity,
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
    createdAt,
    updatedAt: createdAt,
  }
}

/**
 * Base date used for fixture `createdAt` assignment. Each fixture
 * memory is dated `FIXTURE_BASE_DATE - index` days, so the
 * first-listed memory is the newest and the YAML order is also the
 * recency order. Pinned to a stable past date so the
 * `isFreshDigest(maxAgeDays = 7)` window in `loadWakeUpData` does NOT
 * treat fixture memories as fresh digests by accident.
 */
const FIXTURE_BASE_DATE = new Date(Date.UTC(2026, 2, 1, 12, 0, 0))
const MS_PER_FIXTURE_DAY = 24 * 60 * 60 * 1000

function fixtureMemoryToMemory(memory: EvalFixtureMemory, index: number): Memory {
  const createdAt = new Date(
    FIXTURE_BASE_DATE.getTime() - index * MS_PER_FIXTURE_DAY
  ).toISOString()
  return {
    id: memory.id,
    title: memory.title,
    projectIds: [EVAL_PROJECT_ID],
    topicId: null,
    source: "manual" satisfies MemorySource,
    kind: memory.kind,
    status: memory.status,
    confidence: memory.confidence,
    confidenceScore: null,
    reviewBy: null,
    doneAt: null,
    decidedAt: null,
    lastReferencedAt: null,
    supersedesIds: [],
    affectsIds: [],
    alternatives: "",
    consequences: "",
    author: "",
    agent: "",
    tags: memory.tags,
    keywords: memory.keywords,
    synopsis: memory.synopsis,
    session: "",
    content: memory.content,
    taskState: null,
    blockedBy: "",
    entity: "",
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
    createdAt,
    updatedAt: createdAt,
  }
}

function searchFixtureMemories(query: string, memories: Memory[]): Memory[] {
  const queryTokens = tokenize(query)
  return memories
    .filter(isStatusRetrievable)
    .map((memory, index) => ({
      memory,
      index,
      score: scoreMemory(queryTokens, memory),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.memory)
}

function scoreMemory(queryTokens: Set<string>, memory: Memory): number {
  if (queryTokens.size === 0) return 0
  let score = 0
  score += weightedOverlap(queryTokens, tokenize(memory.title), 4)
  score += weightedOverlap(queryTokens, tokenize(memory.synopsis), 3)
  score += weightedOverlap(queryTokens, tokenize(memory.keywords), 3)
  score += weightedOverlap(queryTokens, tokenize(memory.tags.join(" ")), 2)
  score += weightedOverlap(queryTokens, tokenize(memory.content), 1)
  score += weightedOverlap(queryTokens, tokenize(memory.id), 1)
  return score
}

function weightedOverlap(
  queryTokens: Set<string>,
  candidateTokens: Set<string>,
  weight: number
) {
  let score = 0
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) score += weight
  }
  return score
}

function tokenize(value: string): Set<string> {
  const tokens = value.toLowerCase().match(/[a-z0-9]+/g) ?? []
  return new Set(tokens)
}

function summarizeResults(
  tasks: EvalTask[],
  scenarios: string[],
  trials: number,
  results: EvalTaskResult[]
): EvalRunSummary {
  const recallValues = results
    .map((r) => r.retrieval.recall)
    .filter((n): n is number => n !== null)
  const precisionValues = results
    .map((r) => r.retrieval.precision)
    .filter((n): n is number => n !== null)
  const memoryLiftValues = tasks
    .map((task) => taskMemoryLift(task, results))
    .filter((n): n is number => n !== null)
  const memoryHarmValues = tasks
    .map((task) => taskMemoryHarm(task, results))
    .filter((n): n is number => n !== null)

  return {
    tasks: tasks.length,
    scenarios: scenarios.sort(),
    trials,
    totalResults: results.length,
    passedResults: results.filter((r) => r.success).length,
    failedResults: results.filter((r) => !r.success).length,
    retrieval: {
      averageRecall: average(recallValues),
      averagePrecision: average(precisionValues),
      memoryLift: average(memoryLiftValues),
      memoryHarm: average(memoryHarmValues),
    },
  }
}

function taskMemoryLift(task: EvalTask, results: EvalTaskResult[]): number | null {
  const helpfulIds = task.expectedRetrieval["helpful-memory"]?.shouldSurface ?? []
  if (helpfulIds.length === 0) return null
  const helpful = scenarioExpectedRecall(task.id, "helpful-memory", helpfulIds, results)
  if (helpful === null) return null

  const requiredBaselineScenarios = ["no-lore", "empty-lore"]
  const optionalBaselineScenarios = ["noisy-memory"].filter(
    (scenario) => task.memoryScenarios[scenario] !== undefined
  )
  const baselineValues: number[] = []
  for (const scenario of [...requiredBaselineScenarios, ...optionalBaselineScenarios]) {
    const recall = scenarioExpectedRecall(task.id, scenario, helpfulIds, results)
    if (recall === null) return null
    baselineValues.push(recall)
  }
  const baseline = Math.max(...baselineValues)
  return roundMetric(helpful - baseline)
}

function taskMemoryHarm(task: EvalTask, results: EvalTaskResult[]): number | null {
  const baseline = scenarioSuccessRate(task.id, "empty-lore", results)
  if (baseline === null) return null
  const harmScenarios = ["noisy-memory", "stale-memory"]
  const deltas: number[] = []
  for (const scenario of harmScenarios) {
    if (task.memoryScenarios[scenario] === undefined) continue
    const successRate = scenarioSuccessRate(task.id, scenario, results)
    if (successRate === null) return null
    deltas.push(Math.max(0, baseline - successRate))
  }
  return average(deltas)
}

function scenarioExpectedRecall(
  taskId: string,
  scenario: string,
  expectedIds: string[],
  results: EvalTaskResult[]
): number | null {
  const matching = results.filter((r) => r.taskId === taskId && r.scenario === scenario)
  if (matching.length === 0 || expectedIds.length === 0) return null
  const recalls = matching.map((result) => {
    const surfaced = expectedIds.filter((id) => result.surfacedMemoryIds.includes(id))
    return surfaced.length / expectedIds.length
  })
  return average(recalls) ?? 0
}

function scenarioSuccessRate(
  taskId: string,
  scenario: string,
  results: EvalTaskResult[]
): number | null {
  const matching = results.filter((r) => r.taskId === taskId && r.scenario === scenario)
  if (matching.length === 0) return null
  return average(matching.map((result) => (result.success ? 1 : 0))) ?? 0
}

function average(values: number[]): number | null {
  if (values.length === 0) return null
  return roundMetric(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function roundMetric(value: number): number {
  return Math.round(value * 10000) / 10000
}

async function defaultArtifactPath(
  loaded: LoadedEvalSuite,
  startedAt: string
): Promise<string> {
  const root = await findRepoRoot(loaded.root)
  const safeTimestamp = startedAt.replace(RESULT_TIMESTAMP_PATTERN, "-")
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
      if (parsed.name === "@makenotion/lore") return dir
    } catch {
      // Keep walking. A missing or unrelated package.json is not the repo root.
    }
    const parent = dirname(dir)
    if (parent === dir || dir === parse(dir).root) {
      throw new Error(
        `Could not find @makenotion/lore package root from ${start}; pass --out to choose an artifact path.`
      )
    }
    dir = parent
  }
}
