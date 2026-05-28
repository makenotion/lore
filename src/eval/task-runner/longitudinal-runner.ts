import { createHash, randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { setTimeout as delay } from "node:timers/promises"
import { loadConfig } from "../../config.js"
import {
  DEFAULT_COST_PRICING_TABLE,
  estimateModelCost,
  loadPricingTable,
  readLedgerEventsWithDiagnostics,
  resolveCostTracking,
  type CostRange,
  type BackgroundModelCostEvent,
  type CostLedgerEvent,
  type PricingTable,
  type ResolvedCostTracking,
} from "../../core/cost-ledger.js"
import type { MiningResult } from "../../hooks/conversation-mining.js"
import {
  formatTranscriptSessionContent,
  listTranscriptMessages,
} from "../../hooks/transcript.js"
import { defaultAdapters } from "./codex-adapter.js"
import {
  defaultLongitudinalLoreAdapter,
  LongitudinalAdapterRefusedError,
  removeLongitudinalAgentConfig,
} from "./lore-adapter.js"
import {
  computePatchStats,
  roundMs,
  roundRate,
  writePatchEvidence,
} from "./patch-stats.js"
import {
  isChildProcessRunning,
  killChildProcessGroup,
  registerDetachedChildProcessGroup,
} from "./process-groups.js"
import { defaultArtifactPath } from "./shared.js"
import type {
  AgentAdapter,
  AgentRunResult,
  LongitudinalConditionSummary,
  LongitudinalCostMetrics,
  LongitudinalFailureReason,
  LongitudinalLiftSummary,
  LongitudinalLoreAdapter,
  LongitudinalLoreMetrics,
  LongitudinalLoreRun,
  LongitudinalPhaseResult,
  LongitudinalRunTermination,
  LongitudinalScenarioSampleSelection,
  LongitudinalTaskArtifact,
  LongitudinalTaskCondition,
  LongitudinalTaskEvalSuite,
  LongitudinalTaskResult,
  LongitudinalTaskScenario,
  LongitudinalWakeUpResult,
  RunTaskEvalOptions,
  VerifierResult,
  WorkspaceMaterialization,
} from "./schema.js"
import { deriveFailureReason, runVerifier } from "./verifier.js"
import { prepareWorkspace, rematerializeWorkspace } from "./workspace.js"
import {
  resolveTranscriptDir,
  taskPatchPath,
  taskTranscriptPath,
  taskVerifierOutputPath,
} from "./transcripts.js"

const LONGITUDINAL_DIFFICULTIES = ["easy", "medium", "hard"] as const

export async function runLongitudinalTaskEvalSuite(
  loaded: { suite: LongitudinalTaskEvalSuite; root: string; path: string },
  options: RunTaskEvalOptions
): Promise<{ artifact: LongitudinalTaskArtifact; outPath: string }> {
  const startedAt = (options.now ?? new Date()).toISOString()
  const outPath = resolve(
    options.outPath ?? defaultArtifactPath(loaded.suite.name, startedAt)
  )
  const selection = selectLongitudinalScenarios(loaded.suite, options)
  const scenarios = selection.scenarios
  const selectedConditions = selectLongitudinalConditions(loaded.suite, options)
  const parallelism = normalizeLongitudinalParallelism(options.parallelism)
  const scenarioIds = scenarios.map((scenario) => scenario.id)
  if (options.transcriptsDir !== undefined) {
    throw new Error(
      "Longitudinal task runs keep transcript and patch sidecars artifact-adjacent and do not support transcriptsDir overrides."
    )
  }

  if (parallelism > 1) {
    return runLongitudinalTaskEvalSuiteInChildProcesses({
      loaded,
      options,
      startedAt,
      outPath,
      scenarios,
      selectedConditions,
      parallelism,
      sample: selection.sample,
    })
  }

  const adapters = options.adapters ?? defaultAdapters()
  const loreAdapter = options.longitudinalLoreAdapter ?? defaultLongitudinalLoreAdapter()
  const transcriptsDir = resolveTranscriptDir(undefined, outPath)
  const pricingTable = await loadLongitudinalAgentPricingTable()
  const costKillSwitch = await resolveLongitudinalCostKillSwitch({
    suite: loaded.suite,
    options,
    startedAt,
    selectedConditions,
  })

  const results: LongitudinalTaskResult[] = []
  let termination: LongitudinalRunTermination | null = null
  const totalTrials = scenarios.length * selectedConditions.length
  await writeLongitudinalArtifact({
    suite: loaded.suite,
    startedAt,
    results,
    outPath,
    termination,
    scenarioIds,
    selectedConditions,
    parallelism,
    difficulty: options.difficulty,
    sample: selection.sample,
  })
  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    for (const [conditionIndex, condition] of selectedConditions.entries()) {
      const beforeLaunchTermination = await maybeStopForCostKillSwitch({
        costKillSwitch,
        results,
        completedTrials: results.length,
        totalPlannedTrials: totalTrials,
      })
      if (beforeLaunchTermination) {
        termination = beforeLaunchTermination
        emitLongitudinalStop(options, termination)
        const artifact = await writeLongitudinalArtifact({
          suite: loaded.suite,
          startedAt,
          results,
          outPath,
          termination,
          scenarioIds,
          selectedConditions,
          parallelism,
          difficulty: options.difficulty,
          sample: selection.sample,
        })
        return { artifact, outPath }
      }

      const index = scenarioIndex * selectedConditions.length + conditionIndex + 1
      options.onProgress?.({
        type: "trial-start",
        runner: "task",
        taskId: scenario.id,
        scenarioId: scenario.id,
        condition,
        index,
        total: totalTrials,
      })
      const result = await runLongitudinalTrial({
        suite: loaded.suite,
        scenario,
        condition,
        suiteRoot: loaded.root,
        adapters,
        keepWorkspaces: options.keepWorkspaces ?? false,
        loreAdapter,
        transcriptIndex: index,
        transcriptsDir,
        pricingTable,
      }).catch((err: unknown) =>
        harnessErrorResult({
          scenario,
          condition,
          message: `Longitudinal condition runner failed: ${errorMessage(err)}`,
        })
      )
      results.push(result)
      await writeLongitudinalArtifact({
        suite: loaded.suite,
        startedAt,
        results,
        outPath,
        termination,
        scenarioIds,
        selectedConditions,
        parallelism,
        difficulty: options.difficulty,
        sample: selection.sample,
      })
      options.onProgress?.({
        type: "trial-finish",
        runner: "task",
        taskId: scenario.id,
        scenarioId: scenario.id,
        condition,
        index,
        total: totalTrials,
        success: result.success,
      })

      const afterTrialTermination = await maybeStopForCostKillSwitch({
        costKillSwitch,
        results,
        completedTrials: results.length,
        totalPlannedTrials: totalTrials,
      })
      if (afterTrialTermination) {
        termination = afterTrialTermination
        emitLongitudinalStop(options, termination)
        const artifact = await writeLongitudinalArtifact({
          suite: loaded.suite,
          startedAt,
          results,
          outPath,
          termination,
          scenarioIds,
          selectedConditions,
          parallelism,
          difficulty: options.difficulty,
          sample: selection.sample,
        })
        return { artifact, outPath }
      }
    }
  }

  const artifact = await writeLongitudinalArtifact({
    suite: loaded.suite,
    startedAt,
    results,
    outPath,
    termination,
    scenarioIds,
    selectedConditions,
    parallelism,
    difficulty: options.difficulty,
    sample: selection.sample,
  })
  return { artifact, outPath }
}

async function runLongitudinalTaskEvalSuiteInChildProcesses(input: {
  loaded: { suite: LongitudinalTaskEvalSuite; root: string; path: string }
  options: RunTaskEvalOptions
  startedAt: string
  outPath: string
  scenarios: LongitudinalTaskScenario[]
  selectedConditions: LongitudinalTaskCondition[]
  parallelism: number
  sample: LongitudinalScenarioSampleSelection | undefined
}): Promise<{ artifact: LongitudinalTaskArtifact; outPath: string }> {
  if (input.options.adapters || input.options.longitudinalLoreAdapter) {
    throw new Error(
      "Longitudinal --parallel uses child processes and does not support injected adapters."
    )
  }
  if (input.options.keepWorkspaces) {
    throw new Error("Longitudinal --parallel does not support keepWorkspaces.")
  }
  if (input.options.transcriptsDir !== undefined) {
    throw new Error(
      "Longitudinal --parallel writes per-shard transcript directories and does not support transcriptsDir overrides."
    )
  }
  const cliPath = process.argv[1]
  if (!cliPath) {
    throw new Error("Longitudinal --parallel requires a CLI entrypoint path.")
  }

  const costKillSwitch = await resolveLongitudinalCostKillSwitch({
    suite: input.loaded.suite,
    options: input.options,
    startedAt: input.startedAt,
    selectedConditions: input.selectedConditions,
  })
  const scenarioIds = input.scenarios.map((scenario) => scenario.id)
  const totalTrials = input.scenarios.length * input.selectedConditions.length
  const shardDir = `${input.outPath}-shards`
  await mkdir(shardDir, { recursive: true })

  const resultSlots: Array<LongitudinalTaskResult | undefined> = []
  let nextScenarioIndex = 0
  let termination: LongitudinalRunTermination | null = null
  let emittedStop = false
  let writeQueue: Promise<unknown> = Promise.resolve()
  const activeShardChildren = new Set<ChildProcess>()
  const orderedResults = () =>
    resultSlots.filter((result): result is LongitudinalTaskResult => result !== undefined)
  const writeCurrentArtifact = async () => {
    if (termination && costKillSwitch) {
      termination =
        (await maybeStopForCostKillSwitch({
          costKillSwitch,
          results: orderedResults(),
          completedTrials: orderedResults().length,
          totalPlannedTrials: totalTrials,
        })) ?? termination
    }
    const write = writeQueue.then(() =>
      writeLongitudinalArtifact({
        suite: input.loaded.suite,
        startedAt: input.startedAt,
        results: orderedResults(),
        outPath: input.outPath,
        termination,
        scenarioIds,
        selectedConditions: input.selectedConditions,
        parallelism: input.parallelism,
        difficulty: input.options.difficulty,
        sample: input.sample,
      })
    )
    writeQueue = write.then(
      () => undefined,
      () => undefined
    )
    return write
  }
  const emitStopOnce = (stop: LongitudinalRunTermination) => {
    if (emittedStop) return
    emittedStop = true
    emitLongitudinalStop(input.options, stop)
  }

  await writeCurrentArtifact()

  const runWorker = async () => {
    while (termination === null) {
      const scenarioIndex = nextScenarioIndex
      nextScenarioIndex += 1
      if (scenarioIndex >= input.scenarios.length) return

      const beforeLaunchTermination = await maybeStopForCostKillSwitch({
        costKillSwitch,
        results: orderedResults(),
        completedTrials: orderedResults().length,
        totalPlannedTrials: totalTrials,
      })
      if (termination) return
      if (beforeLaunchTermination) {
        termination = beforeLaunchTermination
        emitStopOnce(termination)
        await stopActiveShardChildren(activeShardChildren)
        await writeCurrentArtifact()
        return
      }

      const scenario = input.scenarios[scenarioIndex]!
      if (termination) return
      for (const [conditionIndex, condition] of input.selectedConditions.entries()) {
        input.options.onProgress?.({
          type: "trial-start",
          runner: "task",
          taskId: scenario.id,
          scenarioId: scenario.id,
          condition,
          index: scenarioIndex * input.selectedConditions.length + conditionIndex + 1,
          total: totalTrials,
        })
      }

      const shardResults = await runLongitudinalScenarioShard({
        suitePath: input.loaded.path,
        cliPath,
        shardPath: join(
          shardDir,
          `${String(scenarioIndex + 1).padStart(3, "0")}-${scenario.id}.json`
        ),
        scenario,
        selectedConditions: input.selectedConditions,
        activeShardChildren,
      }).catch((err: unknown) => {
        if (!isRecoverableLongitudinalShardError(err)) throw err
        return completeLongitudinalShardResults({
          scenario,
          results: [],
          expectedConditions: input.selectedConditions,
          harnessErrorMessage: `Longitudinal shard runner failed: ${errorMessage(err)}`,
        })
      })

      for (const result of filterShardResultsForTerminatedRun(
        shardResults,
        termination
      )) {
        const conditionIndex = input.selectedConditions.indexOf(result.condition)
        if (conditionIndex === -1) {
          throw new Error(
            `Shard ${scenario.id} returned unsupported condition ${result.condition}.`
          )
        }
        const globalIndex =
          scenarioIndex * input.selectedConditions.length + conditionIndex + 1
        resultSlots[globalIndex - 1] = result
        input.options.onProgress?.({
          type: "trial-finish",
          runner: "task",
          taskId: scenario.id,
          scenarioId: scenario.id,
          condition: result.condition,
          index: globalIndex,
          total: totalTrials,
          success: result.success,
        })
      }
      await writeCurrentArtifact()

      const afterShardTermination = await maybeStopForCostKillSwitch({
        costKillSwitch,
        results: orderedResults(),
        completedTrials: orderedResults().length,
        totalPlannedTrials: totalTrials,
      })
      if (afterShardTermination) {
        termination = afterShardTermination
        emitStopOnce(termination)
        await stopActiveShardChildren(activeShardChildren)
        await writeCurrentArtifact()
        return
      }
    }
  }

  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(input.parallelism, input.scenarios.length) }, () =>
      runWorker()
    )
  )
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  )
  if (rejected) {
    await stopActiveShardChildren(activeShardChildren)
    await writeCurrentArtifact()
    throw rejected.reason
  }
  const artifact = await writeCurrentArtifact()
  return { artifact, outPath: input.outPath }
}

async function writeLongitudinalArtifact(input: {
  suite: LongitudinalTaskEvalSuite
  startedAt: string
  results: LongitudinalTaskResult[]
  outPath: string
  termination: LongitudinalRunTermination | null
  scenarioIds: string[]
  selectedConditions: readonly LongitudinalTaskCondition[]
  parallelism: number
  difficulty: RunTaskEvalOptions["difficulty"]
  sample: LongitudinalScenarioSampleSelection | undefined
}): Promise<LongitudinalTaskArtifact> {
  const artifact: LongitudinalTaskArtifact = {
    suite: input.suite.name,
    description: input.suite.description,
    startedAt: input.startedAt,
    runner: {
      mode: "task",
      kind: "longitudinal",
      parallelism: input.parallelism,
      ...(input.difficulty ? { difficulty: input.difficulty } : {}),
      conditions: [...input.selectedConditions],
      ...(input.sample ? { sample: input.sample } : {}),
    },
    termination: input.termination,
    results: input.results,
    summary: summarizeLongitudinalResults(
      input.scenarioIds,
      input.results,
      input.selectedConditions
    ),
  }
  await writeJsonArtifactAtomically(input.outPath, artifact)
  return artifact
}

async function writeJsonArtifactAtomically(
  outPath: string,
  artifact: LongitudinalTaskArtifact
): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true })
  const tmpPath = `${outPath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmpPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8")
  await rename(tmpPath, outPath)
}

function selectLongitudinalScenarios(
  suite: LongitudinalTaskEvalSuite,
  options: RunTaskEvalOptions
): {
  scenarios: LongitudinalTaskScenario[]
  sample: LongitudinalScenarioSampleSelection | undefined
} {
  if (!options.sample) {
    return { scenarios: filterLongitudinalScenarios(suite, options), sample: undefined }
  }
  if (options.difficulty || (options.scenarioIds?.length ?? 0) > 0) {
    throw new Error(
      "Longitudinal --sample cannot be combined with --difficulty or --scenario-id."
    )
  }
  const selectedByBucket: LongitudinalTaskScenario[] = []
  for (const difficulty of LONGITUDINAL_DIFFICULTIES) {
    const requested = normalizeLongitudinalSampleCount(
      difficulty,
      options.sample.counts[difficulty]
    )
    if (requested === undefined) continue
    const bucket = suite.scenarios
      .filter((scenario) => scenario.difficulty === difficulty)
      .sort((a, b) => {
        const aKey = longitudinalSampleSortKey(options.sample!.seed, difficulty, a.id)
        const bKey = longitudinalSampleSortKey(options.sample!.seed, difficulty, b.id)
        return aKey.localeCompare(bKey) || a.id.localeCompare(b.id)
      })
    if (bucket.length < requested) {
      throw new Error(
        `Longitudinal sample requested ${requested} ${difficulty} scenario(s), but only ${bucket.length} are available.`
      )
    }
    selectedByBucket.push(...bucket.slice(0, requested))
  }
  if (selectedByBucket.length === 0) {
    throw new Error("Longitudinal sample requested no scenarios.")
  }
  const selected = selectedByBucket.sort((a, b) => {
    const aKey = longitudinalSampleSortKey(options.sample!.seed, "run-order", a.id)
    const bKey = longitudinalSampleSortKey(options.sample!.seed, "run-order", b.id)
    return aKey.localeCompare(bKey) || a.id.localeCompare(b.id)
  })
  return {
    scenarios: selected,
    sample: {
      seed: options.sample.seed,
      requested: { ...options.sample.counts },
      selectedScenarioIds: selected.map((scenario) => scenario.id),
    },
  }
}

function normalizeLongitudinalSampleCount(
  difficulty: string,
  value: number | undefined
): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `Longitudinal sample count for ${difficulty} must be a positive safe integer.`
    )
  }
  return value
}

function longitudinalSampleSortKey(
  seed: string,
  difficulty: string,
  scenarioId: string
): string {
  return createHash("sha256")
    .update(seed)
    .update("\0")
    .update(difficulty)
    .update("\0")
    .update(scenarioId)
    .digest("hex")
}

function filterLongitudinalScenarios(
  suite: LongitudinalTaskEvalSuite,
  options: RunTaskEvalOptions
): LongitudinalTaskScenario[] {
  const scenarioIdFilter =
    options.scenarioIds && options.scenarioIds.length > 0
      ? new Set(options.scenarioIds)
      : null
  const scenarios = suite.scenarios.filter((scenario) => {
    if (options.difficulty && scenario.difficulty !== options.difficulty) return false
    if (scenarioIdFilter && !scenarioIdFilter.has(scenario.id)) return false
    return true
  })
  if (scenarios.length === 0) {
    const filters = [
      options.difficulty ? `difficulty=${options.difficulty}` : null,
      scenarioIdFilter ? `scenarioIds=${[...scenarioIdFilter].join(",")}` : null,
    ].filter((value): value is string => value !== null)
    throw new Error(
      `No longitudinal scenarios matched${filters.length > 0 ? ` (${filters.join("; ")})` : ""}.`
    )
  }
  if (scenarioIdFilter) {
    const matched = new Set(scenarios.map((scenario) => scenario.id))
    const missing = [...scenarioIdFilter].filter((id) => !matched.has(id))
    if (missing.length > 0) {
      throw new Error(`Unknown longitudinal scenario id(s): ${missing.join(", ")}`)
    }
  }
  return scenarios
}

function selectLongitudinalConditions(
  suite: LongitudinalTaskEvalSuite,
  options: RunTaskEvalOptions
): LongitudinalTaskCondition[] {
  if (!options.conditions || options.conditions.length === 0) {
    return [...suite.conditions]
  }
  const suiteConditions = new Set(suite.conditions)
  const selected: LongitudinalTaskCondition[] = []
  const seen = new Set<LongitudinalTaskCondition>()
  for (const condition of options.conditions) {
    if (!suiteConditions.has(condition)) {
      throw new Error(
        `Longitudinal condition filter selected "${condition}", but the suite only defines ${suite.conditions.join(", ")}.`
      )
    }
    if (seen.has(condition)) {
      throw new Error(`Longitudinal condition filter includes duplicate "${condition}".`)
    }
    seen.add(condition)
    selected.push(condition)
  }
  return selected
}

function normalizeLongitudinalParallelism(value: number | undefined): number {
  if (value === undefined) return 1
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Longitudinal parallelism must be a positive integer.")
  }
  return value
}

function emitLongitudinalStop(
  options: RunTaskEvalOptions,
  termination: LongitudinalRunTermination
): void {
  options.onProgress?.({
    type: "run-stop",
    runner: "task",
    reason: termination.reason,
    limitUsd: termination.limitUsd,
    observedUsd: termination.observedUsd,
    primaryAgentUsd: termination.primaryAgentUsd,
    loreUsd: termination.loreUsd,
    completedTrials: termination.completedTrials,
    totalPlannedTrials: termination.totalPlannedTrials,
  })
}

async function runLongitudinalScenarioShard(input: {
  suitePath: string
  cliPath: string
  shardPath: string
  scenario: LongitudinalTaskScenario
  selectedConditions: readonly LongitudinalTaskCondition[]
  activeShardChildren: Set<ChildProcess>
}): Promise<LongitudinalTaskResult[]> {
  const args = [
    input.cliPath,
    "eval",
    "run",
    input.suitePath,
    "--runner",
    "task",
    "--scenario-id",
    input.scenario.id,
    "--out",
    input.shardPath,
    ...input.selectedConditions.flatMap((condition) => ["--condition", condition]),
  ]
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      LORE_EVAL_LONGITUDINAL_WORKER: "1",
      LORE_EVAL_LONGITUDINAL_IGNORE_SUITE_COST_KILL_SWITCH: "1",
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  input.activeShardChildren.add(child)
  const unregisterDetachedChild = registerDetachedChildProcessGroup(child)
  let stdout = ""
  let stderr = ""
  child.stdout?.setEncoding("utf-8")
  child.stdout?.on("data", (chunk: string) => {
    stdout = capCapturedOutput(stdout + chunk)
  })
  child.stderr?.setEncoding("utf-8")
  child.stderr?.on("data", (chunk: string) => {
    stderr = capCapturedOutput(stderr + chunk)
  })

  const exitCode = await new Promise<number | null>((resolveClose, reject) => {
    child.once("error", reject)
    child.once("close", (code) => resolveClose(code))
  }).finally(() => {
    input.activeShardChildren.delete(child)
    unregisterDetachedChild()
  })
  let artifact: LongitudinalTaskArtifact
  try {
    artifact = JSON.parse(
      await readFile(input.shardPath, "utf-8")
    ) as LongitudinalTaskArtifact
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new RecoverableLongitudinalShardError(
      `Longitudinal shard ${input.scenario.id} did not produce a readable artifact ` +
        `(exit ${exitCode ?? "signal"}): ${detail}\n${stderr || stdout}`,
      { cause: err }
    )
  }
  if (artifact.termination) {
    throw new Error(
      `Longitudinal shard ${input.scenario.id} terminated unexpectedly: ${artifact.termination.message}`
    )
  }
  const invalid = artifact.results.filter(
    (result) => result.scenarioId !== input.scenario.id
  )
  if (invalid.length > 0) {
    throw new Error(
      `Longitudinal shard ${input.scenario.id} returned result(s) for ${invalid.map((result) => result.scenarioId).join(", ")}.`
    )
  }
  return completeLongitudinalShardResults({
    scenario: input.scenario,
    results: artifact.results,
    expectedConditions: input.selectedConditions,
    harnessErrorMessage: formatShardHarnessError({
      scenarioId: input.scenario.id,
      exitCode,
      stdout,
      stderr,
    }),
  })
}

class RecoverableLongitudinalShardError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "RecoverableLongitudinalShardError"
  }
}

function isRecoverableLongitudinalShardError(
  err: unknown
): err is RecoverableLongitudinalShardError {
  return err instanceof RecoverableLongitudinalShardError
}

export function completeLongitudinalShardResults(input: {
  scenario: LongitudinalTaskScenario
  results: LongitudinalTaskResult[]
  expectedConditions: readonly LongitudinalTaskCondition[]
  harnessErrorMessage: string
}): LongitudinalTaskResult[] {
  const completeness = longitudinalShardResultCompleteness({
    scenarioId: input.scenario.id,
    results: input.results,
    expectedConditions: input.expectedConditions,
  })
  if (
    completeness.missing.length === 0 &&
    completeness.duplicate.length === 0 &&
    completeness.unexpected.length === 0
  ) {
    return input.results
  }
  if (completeness.duplicate.length > 0 || completeness.unexpected.length > 0) {
    throw new Error(
      formatShardCompletenessError(input.scenario.id, {
        missing: [],
        duplicate: completeness.duplicate,
        unexpected: completeness.unexpected,
      })
    )
  }
  return [
    ...input.results,
    ...completeness.missing.map((condition) =>
      harnessErrorResult({
        scenario: input.scenario,
        condition,
        message: input.harnessErrorMessage,
      })
    ),
  ]
}

export function filterShardResultsForTerminatedRun(
  results: LongitudinalTaskResult[],
  termination: LongitudinalRunTermination | null
): LongitudinalTaskResult[] {
  if (
    termination?.reason === "cost-kill-switch" ||
    termination?.reason === "cost-unknown"
  ) {
    return results.filter((result) => !isSyntheticShardTerminationResult(result))
  }
  return results
}

function isSyntheticShardTerminationResult(result: LongitudinalTaskResult): boolean {
  if (result.failureReason !== "harness-error") return false
  if (result.agentRun !== null) return false
  if (result.verifiers.length > 0) return false
  if (result.phases.length !== 1) return false
  const phase = result.phases[0]!
  if (phase.failureReason !== "harness-error") return false
  if (phase.agentRun !== null || phase.cost !== null || phase.patch !== null) return false
  if (phase.verifierResults.length > 0) return false
  const message = phase.failureMessage ?? ""
  return (
    message.includes("Longitudinal shard runner failed:") ||
    (message.includes("Longitudinal shard ") &&
      message.includes("returned an incomplete artifact"))
  )
}

export function assertLongitudinalShardResultsComplete(input: {
  scenarioId: string
  results: LongitudinalTaskResult[]
  expectedConditions: readonly LongitudinalTaskCondition[]
}): void {
  const completeness = longitudinalShardResultCompleteness(input)
  if (
    completeness.missing.length === 0 &&
    completeness.duplicate.length === 0 &&
    completeness.unexpected.length === 0
  ) {
    return
  }
  throw new Error(formatShardCompletenessError(input.scenarioId, completeness))
}

function longitudinalShardResultCompleteness(input: {
  scenarioId: string
  results: LongitudinalTaskResult[]
  expectedConditions: readonly LongitudinalTaskCondition[]
}): {
  missing: LongitudinalTaskCondition[]
  duplicate: LongitudinalTaskCondition[]
  unexpected: string[]
} {
  const expected = new Set(input.expectedConditions)
  const seen = new Map<LongitudinalTaskCondition, number>()
  const unexpected: string[] = []
  for (const result of input.results) {
    if (!expected.has(result.condition)) {
      unexpected.push(result.condition)
      continue
    }
    seen.set(result.condition, (seen.get(result.condition) ?? 0) + 1)
  }

  const missing = input.expectedConditions.filter(
    (condition) => (seen.get(condition) ?? 0) === 0
  )
  const duplicate = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([condition]) => condition)
  return { missing, duplicate, unexpected }
}

function formatShardCompletenessError(
  scenarioId: string,
  completeness: {
    missing: LongitudinalTaskCondition[]
    duplicate: LongitudinalTaskCondition[]
    unexpected: string[]
  }
): string {
  const details = [
    completeness.missing.length > 0 ? `missing=${completeness.missing.join(",")}` : null,
    completeness.duplicate.length > 0
      ? `duplicate=${completeness.duplicate.join(",")}`
      : null,
    completeness.unexpected.length > 0
      ? `unexpected=${completeness.unexpected.join(",")}`
      : null,
  ].filter((detail): detail is string => detail !== null)
  return `Longitudinal shard ${scenarioId} returned incomplete condition results: ${details.join("; ")}.`
}

function harnessErrorResult(input: {
  scenario: LongitudinalTaskScenario
  condition: LongitudinalTaskCondition
  message: string
}): LongitudinalTaskResult {
  const startedAt = new Date().toISOString()
  const phase: LongitudinalPhaseResult = {
    phase: "formation",
    promptId: promptIdFor(input.scenario, "formation"),
    workspace: null,
    startedAt,
    finishedAt: startedAt,
    success: false,
    agentRun: null,
    verifierResults: [],
    patchStats: { filesChanged: 0, linesAdded: 0, linesRemoved: 0 },
    patch: null,
    lore: emptyLongitudinalLoreMetrics({
      hooksEnabled: input.condition === "lore-full-loop",
      wakeUpEnabled: false,
    }),
    cost: null,
    elapsedMs: 0,
    failureReason: "harness-error",
    failureMessage: input.message,
  }
  return {
    taskId: input.scenario.id,
    scenarioId: input.scenario.id,
    difficulty: input.scenario.difficulty ?? null,
    condition: input.condition,
    memoryCondition: null,
    agent: input.scenario.agent,
    workspaceSource: formatWorkspaceSource(input.scenario.workspace),
    workspaceMaterialization: syntheticWorkspaceMaterialization(input.scenario.workspace),
    workspace: null,
    success: false,
    failureReason: "harness-error",
    agentRun: null,
    verifiers: [],
    phases: [phase],
    expectedContextDescription: input.scenario.expectedContext.description,
  }
}

function syntheticWorkspaceMaterialization(
  source: LongitudinalTaskScenario["workspace"]
): WorkspaceMaterialization {
  if (typeof source === "string") {
    return { kind: "local", source }
  }
  return {
    kind: "git",
    repo: source.repo,
    sha: source.sha,
    sparseCheckout: source.sparseCheckout ?? [],
    cachePath: "",
  }
}

function formatShardHarnessError(input: {
  scenarioId: string
  exitCode: number | null
  stdout: string
  stderr: string
}): string {
  const detail = firstNonEmptyLine(input.stderr) ?? firstNonEmptyLine(input.stdout)
  return (
    `Longitudinal shard ${input.scenarioId} returned an incomplete artifact` +
    ` (exit ${input.exitCode ?? "signal"})` +
    (detail ? `: ${detail}` : ".")
  )
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function stopActiveShardChildren(children: Set<ChildProcess>): Promise<void> {
  const active = [...children].filter(isChildProcessRunning)
  if (active.length === 0) return

  await stopShardChildrenWithSignal(active, "SIGTERM", 5_000)
  const remaining = active.filter(isChildProcessRunning)
  if (remaining.length > 0) {
    await stopShardChildrenWithSignal(remaining, "SIGKILL", 2_000)
  }
}

async function stopShardChildrenWithSignal(
  children: ChildProcess[],
  signal: NodeJS.Signals,
  timeoutMs: number
): Promise<void> {
  const waits = children.map(waitForChildClose)
  for (const child of children) {
    killChildProcessGroup(child, signal)
  }
  await Promise.race([Promise.all(waits), delay(timeoutMs)])
}

function waitForChildClose(child: ChildProcess): Promise<void> {
  if (!isChildProcessRunning(child)) return Promise.resolve()
  return new Promise((resolveClose) => child.once("close", () => resolveClose()))
}

function capCapturedOutput(value: string): string {
  const max = 16_384
  if (value.length <= max) return value
  return value.slice(value.length - max)
}

interface LongitudinalCostKillSwitch {
  limitUsd: number
  startedAt: Date
  loreProjectNamePrefix: string | null
  loreCostTracking: ResolvedCostTracking | null
  loreCostTrackingError: string | null
}

async function resolveLongitudinalCostKillSwitch(input: {
  suite: LongitudinalTaskEvalSuite
  options: RunTaskEvalOptions
  startedAt: string
  selectedConditions: readonly LongitudinalTaskCondition[]
}): Promise<LongitudinalCostKillSwitch | null> {
  const suiteLimitUsd =
    process.env["LORE_EVAL_LONGITUDINAL_IGNORE_SUITE_COST_KILL_SWITCH"] === "1"
      ? undefined
      : input.suite.costKillSwitchUsd
  const limitUsd = input.options.costKillSwitchUsd ?? suiteLimitUsd
  if (limitUsd === undefined) return null

  const needsLoreCostTracking = input.selectedConditions.includes("lore-full-loop")
  if (!needsLoreCostTracking) {
    return {
      limitUsd,
      startedAt: new Date(input.startedAt),
      loreProjectNamePrefix: null,
      loreCostTracking: null,
      loreCostTrackingError: null,
    }
  }
  const tracking = await loadLongitudinalLoreCostTracking({ required: true })
  const sandboxProjectName = process.env["LORE_EVAL_LONGITUDINAL_SANDBOX_PROJECT"]
  const sandboxProjectError = sandboxProjectName
    ? null
    : "LORE_EVAL_LONGITUDINAL_SANDBOX_PROJECT is required when a longitudinal cost kill-switch includes lore-full-loop."
  return {
    limitUsd,
    startedAt: new Date(input.startedAt),
    loreProjectNamePrefix: sandboxProjectName
      ? `${sandboxProjectName}/longitudinal-`
      : null,
    loreCostTracking: tracking.loreCostTracking,
    loreCostTrackingError: tracking.loreCostTrackingError ?? sandboxProjectError,
  }
}

async function loadLongitudinalLoreCostTracking(input: { required: boolean }): Promise<{
  loreCostTracking: ResolvedCostTracking | null
  loreCostTrackingError: string | null
}> {
  const configRoot = process.env["LORE_EVAL_LONGITUDINAL_CONFIG_ROOT"]
  if (!configRoot) {
    return {
      loreCostTracking: null,
      loreCostTrackingError: input.required
        ? "LORE_EVAL_LONGITUDINAL_CONFIG_ROOT is required when a longitudinal cost kill-switch includes lore-full-loop."
        : null,
    }
  }
  try {
    const config = await loadConfig(join(configRoot, ".lore.yaml"))
    const loreCostTracking = resolveCostTracking(config, configRoot)
    if (input.required && !loreCostTracking.enabled) {
      return {
        loreCostTracking,
        loreCostTrackingError:
          "Lore cost tracking must be enabled when a longitudinal cost kill-switch includes lore-full-loop.",
      }
    }
    return {
      loreCostTracking,
      loreCostTrackingError: null,
    }
  } catch (err) {
    return {
      loreCostTracking: null,
      loreCostTrackingError: input.required
        ? err instanceof Error
          ? err.message
          : String(err)
        : null,
    }
  }
}

async function maybeStopForCostKillSwitch(input: {
  costKillSwitch: LongitudinalCostKillSwitch | null
  results: LongitudinalTaskResult[]
  completedTrials: number
  totalPlannedTrials: number
}): Promise<LongitudinalRunTermination | null> {
  if (!input.costKillSwitch) return null

  const primaryAgentCost = summarizePrimaryAgentCost(input.results)
  const loreCost = await summarizeLoreCostUsd(input.costKillSwitch)
  const observedUsd = primaryAgentCost.usd + (loreCost.usd ?? 0)
  if (primaryAgentCost.unknown) {
    return {
      reason: "cost-unknown",
      limitUsd: input.costKillSwitch.limitUsd,
      observedUsd: roundUsd(observedUsd),
      primaryAgentUsd: roundUsd(primaryAgentCost.usd),
      loreUsd: loreCost.usd === null ? null : roundUsd(loreCost.usd),
      completedTrials: input.completedTrials,
      totalPlannedTrials: input.totalPlannedTrials,
      message:
        `Cost kill-switch stopped after ${input.completedTrials}/${input.totalPlannedTrials} condition runs ` +
        `because primary agent cost is unknown for ${primaryAgentCost.unknown.scenarioId} ` +
        `[${primaryAgentCost.unknown.condition}] ${primaryAgentCost.unknown.phase}: ` +
        `${primaryAgentCost.unknown.reason}.`,
    }
  }
  if (loreCost.unknown) {
    return {
      reason: "cost-unknown",
      limitUsd: input.costKillSwitch.limitUsd,
      observedUsd: roundUsd(observedUsd),
      primaryAgentUsd: roundUsd(primaryAgentCost.usd),
      loreUsd: loreCost.usd === null ? null : roundUsd(loreCost.usd),
      completedTrials: input.completedTrials,
      totalPlannedTrials: input.totalPlannedTrials,
      message:
        `Cost kill-switch stopped after ${input.completedTrials}/${input.totalPlannedTrials} condition runs ` +
        `because Lore-owned model cost is unknown for ${loreCost.unknown.eventType} ` +
        `(${loreCost.unknown.status}): ${loreCost.unknown.reason}.`,
    }
  }
  if (observedUsd < input.costKillSwitch.limitUsd) return null

  return {
    reason: "cost-kill-switch",
    limitUsd: input.costKillSwitch.limitUsd,
    observedUsd: roundUsd(observedUsd),
    primaryAgentUsd: roundUsd(primaryAgentCost.usd),
    loreUsd: loreCost.usd === null ? null : roundUsd(loreCost.usd),
    completedTrials: input.completedTrials,
    totalPlannedTrials: input.totalPlannedTrials,
    message:
      `Cost kill-switch reached after ${input.completedTrials}/${input.totalPlannedTrials} condition runs: ` +
      `observed ${formatUsdForMessage(observedUsd)} >= limit ${formatUsdForMessage(input.costKillSwitch.limitUsd)}.`,
  }
}

function summarizePrimaryAgentCost(results: LongitudinalTaskResult[]): {
  usd: number
  unknown: {
    scenarioId: string
    condition: LongitudinalTaskCondition
    phase: LongitudinalPhaseResult["phase"]
    reason: string
  } | null
} {
  let usd = 0
  for (const result of results) {
    for (const phase of result.phases) {
      if (!phase.agentRun) continue
      if (!phase.cost || phase.cost.totalUsd === null) {
        return {
          usd,
          unknown: {
            scenarioId: result.scenarioId,
            condition: result.condition,
            phase: phase.phase,
            reason: phase.cost?.costUnknownReason ?? "missing_usage",
          },
        }
      }
      usd += phase.cost.totalUsd
    }
  }
  return { usd, unknown: null }
}

async function summarizeLoreCostUsd(costKillSwitch: LongitudinalCostKillSwitch): Promise<{
  usd: number | null
  unknown: { eventType: string; status: string; reason: string } | null
}> {
  if (costKillSwitch.loreCostTrackingError) {
    return {
      usd: null,
      unknown: {
        eventType: "eval.cost_tracking",
        status: "error",
        reason: costKillSwitch.loreCostTrackingError,
      },
    }
  }
  const costTracking = costKillSwitch.loreCostTracking
  if (!costTracking?.enabled) return { usd: 0, unknown: null }
  const range: CostRange = {
    label: "current longitudinal eval run",
    start: costKillSwitch.startedAt,
  }
  try {
    const { rows } = await readLedgerEventsWithDiagnostics(costTracking, range)
    return summarizeLoreModelEvents(
      rows.map((row) => row.event),
      costKillSwitch.loreProjectNamePrefix
    )
  } catch (err) {
    return {
      usd: null,
      unknown: {
        eventType: "eval.cost_ledger",
        status: "error",
        reason: err instanceof Error ? err.message : String(err),
      },
    }
  }
}

function summarizeLoreModelEvents(
  events: CostLedgerEvent[],
  projectNamePrefix: string | null
): {
  usd: number
  unknown: { eventType: string; status: string; reason: string } | null
} {
  let usd = 0
  for (const event of events) {
    if (!isLongitudinalEvalMiningCostEvent(event, projectNamePrefix)) continue
    if (event.estimatedCost.usd === undefined) {
      return {
        usd,
        unknown: {
          eventType: event.eventType,
          status: event.status,
          reason: event.estimatedCost.unknownReason ?? "unknown_cost",
        },
      }
    }
    usd += event.estimatedCost.usd
  }
  return { usd, unknown: null }
}

function isLongitudinalEvalMiningCostEvent(
  event: CostLedgerEvent,
  projectNamePrefix: string | null
): event is BackgroundModelCostEvent & {
  eventType: "eval.mining.background_model"
} {
  if (event.eventType !== "eval.mining.background_model") return false
  if (!projectNamePrefix) return false
  return event.projectName?.startsWith(projectNamePrefix) ?? false
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function formatUsdForMessage(value: number): string {
  return `$${roundUsd(value).toFixed(4)}`
}

async function runLongitudinalTrial(input: {
  suite: LongitudinalTaskEvalSuite
  scenario: LongitudinalTaskScenario
  condition: LongitudinalTaskCondition
  suiteRoot: string
  adapters: Map<string, AgentAdapter>
  keepWorkspaces: boolean
  loreAdapter: LongitudinalLoreAdapter
  transcriptIndex: number
  transcriptsDir: string | null
  pricingTable: PricingTable | null
}): Promise<LongitudinalTaskResult> {
  const adapter = input.adapters.get(input.scenario.agent)
  if (!adapter) {
    throw new Error(
      `No adapter registered for agent "${input.scenario.agent}"; pass one via RunTaskEvalOptions.adapters.`
    )
  }

  const prepared = await prepareWorkspace({
    source: input.scenario.workspace,
    suiteRoot: input.suiteRoot,
    declaredPath: formatWorkspaceSource(input.scenario.workspace),
  })
  const workspaceSource = prepared.sourceRoot
  let workspace = prepared.workspace
  const workspaces = [workspace]
  await removeLongitudinalAgentConfig(workspace)
  const runId = `longitudinal-${input.scenario.id}-${randomUUID().slice(0, 8)}`
  let loreRun: LongitudinalLoreRun | null = null
  const phases: LongitudinalPhaseResult[] = []

  try {
    if (input.condition === "lore-full-loop") {
      loreRun = await input.loreAdapter.createRun({
        suite: input.suite,
        scenario: input.scenario,
        runId,
        workspace,
      })
      await removeLongitudinalAgentConfig(workspace)
    }

    let formationPhase: LongitudinalPhaseResult | null = null
    if (input.condition === "lore-full-loop") {
      const formationSessionId = `${runId}-formation`
      formationPhase = await runLongitudinalFormationPhase({
        scenario: input.scenario,
        condition: input.condition,
        adapter,
        workspace,
        workspaceSource,
        loreRun,
        sessionId: formationSessionId,
        transcriptPath: taskTranscriptPath({
          transcriptsDir: input.transcriptsDir,
          index: input.transcriptIndex,
          taskId: input.scenario.id,
          condition: input.condition,
          phase: "formation",
        }),
        patchPath: taskPatchPath({
          transcriptsDir: input.transcriptsDir,
          index: input.transcriptIndex,
          taskId: input.scenario.id,
          condition: input.condition,
          phase: "formation",
        }),
        pricingTable: input.pricingTable,
      })
      phases.push(formationPhase)
      await removeLongitudinalAgentConfig(workspace)
      workspace = await rematerializeWorkspace(workspaceSource)
      workspaces.push(workspace)
      await removeLongitudinalAgentConfig(workspace)
    }

    const expectedContextIds =
      input.condition === "seeded-lore"
        ? (input.scenario.seededContext?.contextIds ?? [])
        : (formationPhase?.lore.expectedContextIds ?? [])
    const shouldRunUsePhase = formationPhase?.success ?? true
    const usePhase = shouldRunUsePhase
      ? await runLongitudinalUsePhase({
          scenario: input.scenario,
          condition: input.condition,
          adapter,
          workspace,
          workspaceSource,
          wakeUp: await resolveLongitudinalWakeUp({
            condition: input.condition,
            loreRun,
            scenario: input.scenario,
            phaseBPrompt: input.scenario.phaseB.prompt,
            expectedContextIds,
          }),
          expectedContextIds,
          transcriptPath: taskTranscriptPath({
            transcriptsDir: input.transcriptsDir,
            index: input.transcriptIndex,
            taskId: input.scenario.id,
            condition: input.condition,
            phase: "use",
          }),
          patchPath: taskPatchPath({
            transcriptsDir: input.transcriptsDir,
            index: input.transcriptIndex,
            taskId: input.scenario.id,
            condition: input.condition,
            phase: "use",
          }),
          transcriptsDir: input.transcriptsDir,
          transcriptIndex: input.transcriptIndex,
          pricingTable: input.pricingTable,
        })
      : await skippedLongitudinalUsePhase({
          scenario: input.scenario,
          condition: input.condition,
          workspace,
          workspaceSource,
          expectedContextIds,
          formationPhase: formationPhase!,
          patchPath: taskPatchPath({
            transcriptsDir: input.transcriptsDir,
            index: input.transcriptIndex,
            taskId: input.scenario.id,
            condition: input.condition,
            phase: "use",
          }),
        })
    phases.push(usePhase)

    const phaseSuccess =
      input.condition === "lore-full-loop"
        ? phases.every((phase) => phase.success)
        : usePhase.success
    const success = phaseSuccess
    const failureReason = success
      ? null
      : firstLongitudinalFailure(
          input.condition === "lore-full-loop" ? phases : [usePhase]
        )
    return {
      taskId: input.scenario.id,
      scenarioId: input.scenario.id,
      difficulty: input.scenario.difficulty ?? null,
      condition: input.condition,
      memoryCondition: null,
      agent: input.scenario.agent,
      workspaceSource: prepared.sourceLabel,
      workspaceMaterialization: prepared.materialization,
      workspace: input.keepWorkspaces ? workspace : null,
      success,
      failureReason,
      agentRun: usePhase.agentRun,
      verifiers: usePhase.verifierResults,
      phases,
      expectedContextDescription: input.scenario.expectedContext.description,
    }
  } finally {
    if (loreRun) {
      await loreRun.cleanup()
    }
    if (!input.keepWorkspaces) {
      await Promise.all(
        workspaces.map((workspacePath) =>
          rm(workspacePath, { recursive: true, force: true })
        )
      )
    }
  }
}

async function runLongitudinalFormationPhase(input: {
  scenario: LongitudinalTaskScenario
  condition: LongitudinalTaskCondition
  adapter: AgentAdapter
  workspace: string
  workspaceSource: string
  loreRun: LongitudinalLoreRun | null
  sessionId: string
  transcriptPath?: string
  patchPath?: string
  pricingTable: PricingTable | null
}): Promise<LongitudinalPhaseResult> {
  const startedAt = new Date().toISOString()
  const before = performance.now()
  const agentRun = await input.adapter.run({
    prompt: input.scenario.phaseA.prompt,
    workspace: input.workspace,
    timeoutMs: input.scenario.timeoutMs,
    transcriptPath: input.transcriptPath,
  })
  const patchStats = await computePatchStats(input.workspaceSource, input.workspace)
  const patch = await writePatchEvidence({
    sourceRoot: input.workspaceSource,
    workspaceRoot: input.workspace,
    outPath: input.patchPath,
  }).catch(() => null)
  const agentSucceeded = agentRun.exitCode === 0 && !agentRun.timedOut
  let lore = emptyLongitudinalLoreMetrics({
    hooksEnabled: input.condition === "lore-full-loop",
    wakeUpEnabled: false,
  })
  let failureReason: LongitudinalFailureReason | null = agentSucceeded
    ? null
    : deriveFailureReason(false, agentRun, [])
  let failureMessage: string | null = agentSucceeded
    ? null
    : firstAgentFailureMessage(agentRun)
  const formationLinesChanged = patchStats.linesAdded + patchStats.linesRemoved
  if (agentSucceeded && formationLinesChanged > 0) {
    failureReason = "formation"
    failureMessage =
      `Phase A must be read-only, but changed ${patchStats.filesChanged} file` +
      `${patchStats.filesChanged === 1 ? "" : "s"} ` +
      `(+${patchStats.linesAdded}/-${patchStats.linesRemoved} lines).`
  }

  if (
    input.condition === "lore-full-loop" &&
    input.loreRun &&
    agentSucceeded &&
    failureReason === null
  ) {
    try {
      const transcript = await longitudinalFormationTranscript({
        transcriptPath: input.transcriptPath,
        prompt: input.scenario.phaseA.prompt,
        agentRun,
      })
      const formed = await input.loreRun.formContext({
        scenario: input.scenario,
        transcript,
        workspace: input.workspace,
        sessionId: input.sessionId,
      })
      lore = {
        hooksEnabled: true,
        wakeUpEnabled: false,
        memoriesCreated: formed.memoriesCreated,
        factsCreated: formed.factsCreated,
        decisionsCreated: formed.decisionsCreated,
        tasksCreated: formed.tasksCreated,
        expectedContextIds: formed.expectedContextIds,
        surfacedContextIds: [],
        harmfulContextIds: [],
      }
      const miningSucceeded =
        formed.mining === null ||
        (formed.mining.exitCode === 0 && formed.mining.exitSignal === null)
      if (!miningSucceeded && failureReason === null) {
        failureReason = "formation"
        failureMessage = formatMiningFailure(formed.mining)
      }
    } catch (err) {
      if (failureReason === null) {
        failureReason =
          err instanceof LongitudinalAdapterRefusedError ? "adapter-refused" : "formation"
        failureMessage = err instanceof Error ? err.message : String(err)
      }
    }
  }

  const success = failureReason === null
  return {
    phase: "formation",
    promptId: promptIdFor(input.scenario, "formation"),
    workspace: null,
    startedAt,
    finishedAt: new Date().toISOString(),
    success,
    agentRun,
    verifierResults: [],
    patchStats,
    patch,
    lore,
    cost: costFromAgentRun(agentRun, input.pricingTable),
    elapsedMs: roundMs(performance.now() - before),
    failureReason,
    failureMessage,
  }
}

async function runLongitudinalUsePhase(input: {
  scenario: LongitudinalTaskScenario
  condition: LongitudinalTaskCondition
  adapter: AgentAdapter
  workspace: string
  workspaceSource: string
  wakeUp: LongitudinalWakeUpResult
  expectedContextIds: string[]
  transcriptPath?: string
  patchPath?: string
  transcriptsDir: string | null
  transcriptIndex: number
  pricingTable: PricingTable | null
}): Promise<LongitudinalPhaseResult> {
  const startedAt = new Date().toISOString()
  const before = performance.now()
  if (input.wakeUp.failureMessage !== null && input.wakeUp.failureMessage !== undefined) {
    const patchStats = await computePatchStats(input.workspaceSource, input.workspace)
    const patch = await writePatchEvidence({
      sourceRoot: input.workspaceSource,
      workspaceRoot: input.workspace,
      outPath: input.patchPath,
    }).catch(() => null)
    return {
      phase: "use",
      promptId: promptIdFor(input.scenario, "use"),
      workspace: null,
      startedAt,
      finishedAt: new Date().toISOString(),
      success: false,
      agentRun: null,
      verifierResults: [],
      patchStats,
      patch,
      lore: {
        hooksEnabled: input.condition === "lore-full-loop",
        wakeUpEnabled: input.condition !== "no-memory",
        memoriesCreated: 0,
        factsCreated: 0,
        decisionsCreated: 0,
        tasksCreated: 0,
        expectedContextIds: input.expectedContextIds,
        surfacedContextIds: input.wakeUp.surfacedContextIds,
        harmfulContextIds: input.wakeUp.harmfulContextIds,
      },
      cost: null,
      elapsedMs: roundMs(performance.now() - before),
      failureReason: "wake-up",
      failureMessage: input.wakeUp.failureMessage,
    }
  }

  const prompt =
    input.condition === "no-memory"
      ? input.scenario.phaseB.prompt
      : withWakeUpContext(input.scenario.phaseB.prompt, input.wakeUp.renderedContext)
  const agentRun = await input.adapter.run({
    prompt,
    workspace: input.workspace,
    timeoutMs: input.scenario.timeoutMs,
    transcriptPath: input.transcriptPath,
  })
  const verifierResults: VerifierResult[] = []
  for (const [verifierIndex, verifier] of input.scenario.verifiers.entries()) {
    verifierResults.push(
      await runVerifier(
        verifier,
        input.workspace,
        input.workspaceSource,
        taskVerifierOutputPath({
          transcriptsDir: input.transcriptsDir,
          index: input.transcriptIndex,
          taskId: input.scenario.id,
          condition: input.condition,
          phase: "use",
          verifierIndex,
        })
      )
    )
  }
  const patchStats = await computePatchStats(input.workspaceSource, input.workspace)
  const patch = await writePatchEvidence({
    sourceRoot: input.workspaceSource,
    workspaceRoot: input.workspace,
    outPath: input.patchPath,
  }).catch(() => null)
  const agentSucceeded = agentRun.exitCode === 0 && !agentRun.timedOut
  const verifierSucceeded = verifierResults.every((r) => r.passed)
  let failureReason: LongitudinalFailureReason | null = null
  let failureMessage: string | null = null
  if (!agentSucceeded) {
    failureReason = deriveFailureReason(false, agentRun, verifierResults)
    failureMessage = firstAgentFailureMessage(agentRun)
  } else if (!verifierSucceeded) {
    failureReason = "verifiers"
    failureMessage = verifierResults
      .filter((r) => !r.passed)
      .map((r) => r.message)
      .join("; ")
  }

  return {
    phase: "use",
    promptId: promptIdFor(input.scenario, "use"),
    workspace: null,
    startedAt,
    finishedAt: new Date().toISOString(),
    success: failureReason === null,
    agentRun,
    verifierResults,
    patchStats,
    patch,
    lore: {
      hooksEnabled: input.condition === "lore-full-loop",
      wakeUpEnabled: input.condition !== "no-memory",
      memoriesCreated: 0,
      factsCreated: 0,
      decisionsCreated: 0,
      tasksCreated: 0,
      expectedContextIds: input.expectedContextIds,
      surfacedContextIds: input.wakeUp.surfacedContextIds,
      harmfulContextIds: input.wakeUp.harmfulContextIds,
    },
    cost: costFromAgentRun(agentRun, input.pricingTable),
    elapsedMs: roundMs(performance.now() - before),
    failureReason,
    failureMessage,
  }
}

async function skippedLongitudinalUsePhase(input: {
  scenario: LongitudinalTaskScenario
  condition: LongitudinalTaskCondition
  workspace: string
  workspaceSource: string
  expectedContextIds: string[]
  formationPhase: LongitudinalPhaseResult
  patchPath?: string
}): Promise<LongitudinalPhaseResult> {
  const startedAt = new Date().toISOString()
  const before = performance.now()
  const patchStats = await computePatchStats(input.workspaceSource, input.workspace)
  const patch = await writePatchEvidence({
    sourceRoot: input.workspaceSource,
    workspaceRoot: input.workspace,
    outPath: input.patchPath,
  }).catch(() => null)
  const failureReason = input.formationPhase.failureReason ?? "formation"
  const detail =
    input.formationPhase.failureMessage ??
    input.formationPhase.failureReason ??
    "formation failed"
  return {
    phase: "use",
    promptId: promptIdFor(input.scenario, "use"),
    workspace: null,
    startedAt,
    finishedAt: new Date().toISOString(),
    success: false,
    agentRun: null,
    verifierResults: [],
    patchStats,
    patch,
    lore: {
      hooksEnabled: input.condition === "lore-full-loop",
      wakeUpEnabled: false,
      memoriesCreated: 0,
      factsCreated: 0,
      decisionsCreated: 0,
      tasksCreated: 0,
      expectedContextIds: input.expectedContextIds,
      surfacedContextIds: [],
      harmfulContextIds: [],
    },
    cost: null,
    elapsedMs: roundMs(performance.now() - before),
    failureReason,
    failureMessage: `Skipped Phase B because formation failed: ${detail}`,
  }
}

async function loadLongitudinalWakeUp(input: {
  loreRun: LongitudinalLoreRun
  scenario: LongitudinalTaskScenario
  phaseBPrompt: string
  expectedContextIds: string[]
}): Promise<LongitudinalWakeUpResult> {
  try {
    return await input.loreRun.loadContext({
      scenario: input.scenario,
      phaseBPrompt: input.phaseBPrompt,
      expectedContextIds: input.expectedContextIds,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      renderedContext: "",
      surfacedContextIds: [],
      harmfulContextIds: [],
      failureMessage: `Lore wake-up failed: ${message}`,
    }
  }
}

async function resolveLongitudinalWakeUp(input: {
  condition: LongitudinalTaskCondition
  loreRun: LongitudinalLoreRun | null
  scenario: LongitudinalTaskScenario
  phaseBPrompt: string
  expectedContextIds: string[]
}): Promise<LongitudinalWakeUpResult> {
  if (input.condition === "no-memory") return emptyWakeUpResult()
  if (input.condition === "seeded-lore") return seededLongitudinalWakeUp(input.scenario)
  if (!input.loreRun) {
    return {
      renderedContext: "",
      surfacedContextIds: [],
      harmfulContextIds: [],
      failureMessage: "Lore wake-up failed: lore-full-loop run was not initialized.",
    }
  }
  return loadLongitudinalWakeUp({
    loreRun: input.loreRun,
    scenario: input.scenario,
    phaseBPrompt: input.phaseBPrompt,
    expectedContextIds: input.expectedContextIds,
  })
}

function seededLongitudinalWakeUp(
  scenario: LongitudinalTaskScenario
): LongitudinalWakeUpResult {
  if (!scenario.seededContext) {
    return {
      renderedContext: "",
      surfacedContextIds: [],
      harmfulContextIds: [],
      failureMessage: "Seeded Lore context is missing for seeded-lore condition.",
    }
  }
  return {
    renderedContext: scenario.seededContext.renderedContext,
    surfacedContextIds: scenario.seededContext.contextIds,
    harmfulContextIds: scenario.seededContext.harmfulContextIds,
    failureMessage: null,
  }
}

function summarizeLongitudinalResults(
  scenarioIds: string[],
  results: LongitudinalTaskResult[],
  expectedConditions: readonly LongitudinalTaskCondition[]
): LongitudinalTaskArtifact["summary"] {
  const conditions: Record<LongitudinalTaskCondition, LongitudinalConditionSummary> = {
    "no-memory": emptyConditionSummary(),
    "seeded-lore": emptyConditionSummary(),
    "lore-full-loop": emptyConditionSummary(),
  }
  for (const result of results) {
    const summary = conditions[result.condition]
    summary.trials += 1
    if (result.success) summary.passed += 1
    else summary.failed += 1
  }
  for (const summary of Object.values(conditions)) {
    summary.successRate =
      summary.trials === 0 ? 0 : roundRate(summary.passed / summary.trials)
  }

  const lifts: LongitudinalTaskArtifact["summary"]["lifts"] = {}
  for (const condition of ["seeded-lore", "lore-full-loop"] as const) {
    if (conditions[condition].trials > 0) {
      lifts[condition] = buildLiftSummary(scenarioIds, results, condition)
    }
  }
  const primaryLift =
    lifts["lore-full-loop"] ??
    lifts["seeded-lore"] ??
    buildLiftSummary(scenarioIds, results, "lore-full-loop")
  const passedTrials = results.filter((r) => r.success).length
  const passedTasks = countLongitudinalTasksAllConditionsPassed({
    scenarioIds,
    results,
    conditions: expectedConditions,
  })
  return {
    tasks: scenarioIds.length,
    passedTasks,
    failedTasks: scenarioIds.length - passedTasks,
    totalTrials: results.length,
    passedTrials,
    failedTrials: results.length - passedTrials,
    conditions,
    lift: primaryLift,
    lifts,
  }
}

function countLongitudinalTasksAllConditionsPassed(input: {
  scenarioIds: string[]
  results: LongitudinalTaskResult[]
  conditions: readonly LongitudinalTaskCondition[]
}): number {
  let passed = 0
  for (const scenarioId of input.scenarioIds) {
    const byCondition = new Map(
      input.results
        .filter((result) => result.scenarioId === scenarioId)
        .map((result) => [result.condition, result])
    )
    if (
      input.conditions.every((condition) => byCondition.get(condition)?.success === true)
    ) {
      passed += 1
    }
  }
  return passed
}

function buildLiftSummary(
  scenarioIds: string[],
  results: LongitudinalTaskResult[],
  toCondition: Exclude<LongitudinalTaskCondition, "no-memory">
): LongitudinalLiftSummary {
  const liftedScenarioIds: string[] = []
  const harmedScenarioIds: string[] = []
  const pairedScenarioIds: string[] = []
  const contextSatisfiedScenarioIds: string[] = []
  const contextMissedScenarioIds: string[] = []
  const reportingIssues: string[] = []
  for (const scenarioId of scenarioIds) {
    const noMemory = results.find(
      (r) => r.scenarioId === scenarioId && r.condition === "no-memory"
    )
    const memoryEnabled = results.find(
      (r) => r.scenarioId === scenarioId && r.condition === toCondition
    )
    if (!noMemory || !memoryEnabled) continue
    pairedScenarioIds.push(scenarioId)
    if (!noMemory.success && memoryEnabled.success) liftedScenarioIds.push(scenarioId)
    if (noMemory.success && !memoryEnabled.success) harmedScenarioIds.push(scenarioId)
    if (memoryConditionContextSatisfied(memoryEnabled)) {
      contextSatisfiedScenarioIds.push(scenarioId)
    } else {
      contextMissedScenarioIds.push(scenarioId)
    }
  }

  let pairedNoMemoryPassed = 0
  let pairedMemoryPassed = 0
  for (const scenarioId of pairedScenarioIds) {
    const noMemory = results.find(
      (r) => r.scenarioId === scenarioId && r.condition === "no-memory"
    )
    const memoryEnabled = results.find(
      (r) => r.scenarioId === scenarioId && r.condition === toCondition
    )
    if (!noMemory || !memoryEnabled) continue
    if (noMemory.success) pairedNoMemoryPassed += 1
    if (memoryEnabled.success) pairedMemoryPassed += 1
  }
  const pairedTrials = pairedScenarioIds.length
  const successRateDelta =
    pairedTrials === 0
      ? null
      : roundRate(pairedMemoryPassed / pairedTrials - pairedNoMemoryPassed / pairedTrials)
  const missingPairCount = scenarioIds.length - pairedTrials
  if (pairedTrials === 0) {
    reportingIssues.push(
      `No paired no-memory/${toCondition} scenario results are present.`
    )
  } else if (missingPairCount > 0) {
    reportingIssues.push(
      `${missingPairCount} scenario(s) are missing a paired no-memory/${toCondition} result.`
    )
  }
  if (contextMissedScenarioIds.length > 0) {
    reportingIssues.push(
      `${contextMissedScenarioIds.length} paired ${toCondition} scenario(s) did not surface all expected context ids.`
    )
  }
  return {
    fromCondition: "no-memory",
    toCondition,
    pairedTrials,
    pairedScenarioIds,
    pairedNoMemoryPassed,
    pairedMemoryPassed,
    successRateDelta,
    liftedScenarioIds,
    harmedScenarioIds,
    contextSatisfiedScenarioIds,
    contextMissedScenarioIds,
    reportable: reportingIssues.length === 0,
    reportingIssues,
  }
}

function memoryConditionContextSatisfied(result: LongitudinalTaskResult): boolean {
  const usePhase = result.phases.find((phase) => phase.phase === "use")
  if (!usePhase) return false
  return longitudinalUsePhaseContextSatisfied(usePhase)
}

function longitudinalUsePhaseContextSatisfied(
  usePhase: LongitudinalPhaseResult
): boolean {
  if (usePhase.lore.harmfulContextIds.length > 0) return false
  const expected = usePhase.lore.expectedContextIds
  if (expected.length === 0) return usePhase.lore.surfacedContextIds.length > 0
  const surfaced = new Set(usePhase.lore.surfacedContextIds)
  return expected.every((id) => surfaced.has(id))
}

function emptyConditionSummary(): LongitudinalConditionSummary {
  return { trials: 0, passed: 0, failed: 0, successRate: 0 }
}
function promptIdFor(
  scenario: LongitudinalTaskScenario,
  phase: "formation" | "use"
): string {
  if (phase === "formation") return scenario.phaseA.promptId ?? `${scenario.id}-phase-a`
  return scenario.phaseB.promptId ?? `${scenario.id}-phase-b`
}

function formatWorkspaceSource(source: LongitudinalTaskScenario["workspace"]): string {
  return typeof source === "string"
    ? source
    : `${source.kind}:${source.repo}@${source.sha}`
}

function emptyLongitudinalLoreMetrics(input: {
  hooksEnabled: boolean
  wakeUpEnabled: boolean
}): LongitudinalLoreMetrics {
  return {
    hooksEnabled: input.hooksEnabled,
    wakeUpEnabled: input.wakeUpEnabled,
    memoriesCreated: 0,
    factsCreated: 0,
    decisionsCreated: 0,
    tasksCreated: 0,
    expectedContextIds: [],
    surfacedContextIds: [],
    harmfulContextIds: [],
  }
}

function emptyWakeUpResult(): LongitudinalWakeUpResult {
  return {
    renderedContext: "",
    surfacedContextIds: [],
    harmfulContextIds: [],
    failureMessage: null,
  }
}

function withWakeUpContext(prompt: string, renderedContext: string): string {
  if (renderedContext.trim().length === 0) return prompt
  return [
    "Retrieved Lore context from the previous session:",
    "",
    renderedContext.trim(),
    "",
    "Current task:",
    prompt,
  ].join("\n")
}

function firstLongitudinalFailure(
  phases: LongitudinalPhaseResult[]
): LongitudinalFailureReason | null {
  return phases.find((phase) => !phase.success)?.failureReason ?? null
}

function firstAgentFailureMessage(agentRun: AgentRunResult): string | null {
  if (agentRun.refused) return firstNonEmptyLine(agentRun.stderr) ?? "Adapter refused"
  if (agentRun.timedOut) return "Agent timed out"
  if (agentRun.exitCode !== 0) {
    return (
      firstNonEmptyLine(agentRun.stderr) ?? `Agent exited with code ${agentRun.exitCode}`
    )
  }
  return null
}

async function longitudinalFormationTranscript(input: {
  transcriptPath: string | undefined
  prompt: string
  agentRun: AgentRunResult
}): Promise<string> {
  if (input.transcriptPath) {
    try {
      const messages = listTranscriptMessages(
        await readFile(input.transcriptPath, "utf-8")
      )
      if (messages.some((message) => message.role === "assistant")) {
        return formatTranscriptSessionContent(messages)
      }
    } catch {
      // Fall back to a minimal transcript when an injected adapter does not
      // produce a sidecar.
    }
  }
  return formatTranscriptSessionContent([
    { role: "user", text: input.prompt },
    { role: "assistant", text: summarizeAgentResponse(input.agentRun) },
  ])
}

async function loadLongitudinalAgentPricingTable(): Promise<PricingTable | null> {
  return loadPricingTable({
    enabled: true,
    config: { enabled: true },
    ledgerPath: "",
    displayLedgerPath: "",
    pricing: { builtinTable: DEFAULT_COST_PRICING_TABLE },
  })
}

function costFromAgentRun(
  agentRun: AgentRunResult,
  pricingTable: PricingTable | null
): LongitudinalCostMetrics | null {
  if (!agentRun.usage) return null
  const cachedPromptTokens = agentRun.usage.cachedPromptTokens
  const estimate = estimateModelCost(
    {
      provider: agentRun.usage.provider,
      model: agentRun.usage.model,
      inputTokens: Math.max(0, agentRun.usage.promptTokens - cachedPromptTokens),
      cachedInputTokens: cachedPromptTokens,
      outputTokens: agentRun.usage.outputTokens,
      reasoningOutputTokens: agentRun.usage.reasoningOutputTokens,
      estimated: false,
      source: "exact_agent_usage",
    },
    pricingTable
  )
  return {
    provider: agentRun.usage.provider ?? null,
    model: agentRun.usage.model ?? null,
    promptTokens: agentRun.usage.promptTokens,
    cachedPromptTokens,
    completionTokens: agentRun.usage.outputTokens + agentRun.usage.reasoningOutputTokens,
    reasoningOutputTokens: agentRun.usage.reasoningOutputTokens,
    totalUsd: estimate.usd ?? null,
    pricingSource: estimate.pricingSource ?? null,
    costUnknownReason: estimate.unknownReason ?? null,
  }
}

function firstNonEmptyLine(text: string): string | null {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? null
  )
}

function summarizeAgentResponse(agentRun: AgentRunResult): string {
  const stdout = agentRun.stdout.trim()
  if (stdout.length > 0) return stdout
  const stderr = agentRun.stderr.trim()
  if (stderr.length > 0) return stderr
  return `Agent exited with code ${agentRun.exitCode}.`
}

function formatMiningFailure(mining: MiningResult | null): string {
  if (mining === null) return "Mining did not run."
  if (mining.exitSignal) {
    return `Mining child exited via ${mining.exitSignal} after ${mining.elapsedMs}ms.`
  }
  return `Mining child exited with code ${mining.exitCode}.`
}
