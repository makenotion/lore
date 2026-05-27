import { randomUUID } from "node:crypto"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { loadConfig } from "../../config.js"
import {
  DEFAULT_COST_PRICING_TABLE,
  estimateModelCost,
  loadPricingTable,
  readLedgerEventsWithDiagnostics,
  resolveCostTracking,
  type CostRange,
  type CostLedgerEvent,
  type PricingTable,
  type ResolvedCostTracking,
} from "../../core/cost-ledger.js"
import type { MiningResult } from "../../hooks/conversation-mining.js"
import { formatTranscriptSessionContent } from "../../hooks/transcript.js"
import { defaultAdapters } from "./codex-adapter.js"
import {
  defaultLongitudinalLoreAdapter,
  LongitudinalAdapterRefusedError,
  removeLongitudinalAgentConfig,
} from "./lore-adapter.js"
import { computePatchStats, roundMs, roundRate } from "./patch-stats.js"
import { countTasksAllPassed, defaultArtifactPath } from "./shared.js"
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
  LongitudinalTaskArtifact,
  LongitudinalTaskCondition,
  LongitudinalTaskEvalSuite,
  LongitudinalTaskResult,
  LongitudinalTaskScenario,
  LongitudinalWakeUpResult,
  RunTaskEvalOptions,
  VerifierResult,
} from "./schema.js"
import { deriveFailureReason, runVerifier } from "./verifier.js"
import { prepareWorkspace, rematerializeWorkspace } from "./workspace.js"
import { resolveTranscriptDir, taskTranscriptPath } from "./transcripts.js"

export async function runLongitudinalTaskEvalSuite(
  loaded: { suite: LongitudinalTaskEvalSuite; root: string; path: string },
  options: RunTaskEvalOptions
): Promise<{ artifact: LongitudinalTaskArtifact; outPath: string }> {
  const adapters = options.adapters ?? defaultAdapters()
  const startedAt = (options.now ?? new Date()).toISOString()
  const loreAdapter = options.longitudinalLoreAdapter ?? defaultLongitudinalLoreAdapter()
  const outPath = resolve(
    options.outPath ?? defaultArtifactPath(loaded.suite.name, startedAt)
  )
  const transcriptsDir = resolveTranscriptDir(options.transcriptsDir, outPath)
  const pricingTable = await loadLongitudinalAgentPricingTable()
  const costKillSwitch = await resolveLongitudinalCostKillSwitch({
    suite: loaded.suite,
    options,
    startedAt,
  })

  const results: LongitudinalTaskResult[] = []
  let termination: LongitudinalRunTermination | null = null
  const totalTrials = loaded.suite.scenarios.length * loaded.suite.conditions.length
  await writeLongitudinalArtifact({
    suite: loaded.suite,
    startedAt,
    results,
    outPath,
    termination,
  })
  for (const scenario of loaded.suite.scenarios) {
    for (const condition of loaded.suite.conditions) {
      const beforeLaunchTermination = await maybeStopForCostKillSwitch({
        costKillSwitch,
        results,
        completedTrials: results.length,
        totalPlannedTrials: totalTrials,
      })
      if (beforeLaunchTermination) {
        termination = beforeLaunchTermination
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
        const artifact = await writeLongitudinalArtifact({
          suite: loaded.suite,
          startedAt,
          results,
          outPath,
          termination,
        })
        return { artifact, outPath }
      }

      const index = results.length + 1
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
      })
      results.push(result)
      await writeLongitudinalArtifact({
        suite: loaded.suite,
        startedAt,
        results,
        outPath,
        termination,
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
        const artifact = await writeLongitudinalArtifact({
          suite: loaded.suite,
          startedAt,
          results,
          outPath,
          termination,
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
  })
  return { artifact, outPath }
}

async function writeLongitudinalArtifact(input: {
  suite: LongitudinalTaskEvalSuite
  startedAt: string
  results: LongitudinalTaskResult[]
  outPath: string
  termination: LongitudinalRunTermination | null
}): Promise<LongitudinalTaskArtifact> {
  const artifact: LongitudinalTaskArtifact = {
    suite: input.suite.name,
    description: input.suite.description,
    startedAt: input.startedAt,
    runner: { mode: "task", kind: "longitudinal" },
    termination: input.termination,
    results: input.results,
    summary: summarizeLongitudinalResults(
      input.suite.scenarios.map((scenario) => scenario.id),
      input.results
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

interface LongitudinalCostKillSwitch {
  limitUsd: number
  startedAt: Date
  loreCostTracking: ResolvedCostTracking | null
}

async function resolveLongitudinalCostKillSwitch(input: {
  suite: LongitudinalTaskEvalSuite
  options: RunTaskEvalOptions
  startedAt: string
}): Promise<LongitudinalCostKillSwitch | null> {
  const limitUsd = input.options.costKillSwitchUsd ?? input.suite.costKillSwitchUsd
  if (limitUsd === undefined) return null

  return {
    limitUsd,
    startedAt: new Date(input.startedAt),
    loreCostTracking: await loadLongitudinalLoreCostTracking(),
  }
}

async function loadLongitudinalLoreCostTracking(): Promise<ResolvedCostTracking | null> {
  const configRoot = process.env["LORE_EVAL_LONGITUDINAL_CONFIG_ROOT"]
  if (!configRoot) return null
  try {
    const config = await loadConfig(join(configRoot, ".lore.yaml"))
    return resolveCostTracking(config, configRoot)
  } catch {
    return null
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
  const costTracking = costKillSwitch.loreCostTracking
  if (!costTracking?.enabled) return { usd: null, unknown: null }
  const range: CostRange = {
    label: "current longitudinal eval run",
    start: costKillSwitch.startedAt,
  }
  try {
    const { rows } = await readLedgerEventsWithDiagnostics(costTracking, range)
    return summarizeLoreModelEvents(rows.map((row) => row.event))
  } catch {
    return { usd: null, unknown: null }
  }
}

function summarizeLoreModelEvents(events: CostLedgerEvent[]): {
  usd: number
  unknown: { eventType: string; status: string; reason: string } | null
} {
  let usd = 0
  for (const event of events) {
    if (!isBackgroundModelCostEvent(event)) continue
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

function isBackgroundModelCostEvent(event: CostLedgerEvent): event is Extract<
  CostLedgerEvent,
  {
    eventType:
      | "autosave.background_model"
      | "digest.background_model"
      | "eval.mining.background_model"
  }
> {
  return (
    event.eventType === "autosave.background_model" ||
    event.eventType === "digest.background_model" ||
    event.eventType === "eval.mining.background_model"
  )
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

    const formationSessionId = `${runId}-formation`
    const formationPhase = await runLongitudinalFormationPhase({
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
      pricingTable: input.pricingTable,
    })
    phases.push(formationPhase)
    await removeLongitudinalAgentConfig(workspace)
    workspace = await rematerializeWorkspace(workspace)
    workspaces.push(workspace)
    await removeLongitudinalAgentConfig(workspace)

    const expectedContextIds =
      input.condition === "seeded-lore"
        ? (input.scenario.seededContext?.contextIds ?? [])
        : formationPhase.lore.expectedContextIds
    const usePhase = formationPhase.success
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
          pricingTable: input.pricingTable,
        })
      : await skippedLongitudinalUsePhase({
          scenario: input.scenario,
          condition: input.condition,
          workspace,
          workspaceSource,
          expectedContextIds,
          formationPhase,
        })
    phases.push(usePhase)

    const success = phases.every((phase) => phase.success)
    return {
      taskId: input.scenario.id,
      scenarioId: input.scenario.id,
      condition: input.condition,
      memoryCondition: null,
      agent: input.scenario.agent,
      workspaceSource: prepared.sourceLabel,
      workspaceMaterialization: prepared.materialization,
      workspace: input.keepWorkspaces ? workspace : null,
      success,
      failureReason: success ? null : firstLongitudinalFailure(phases),
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

  if (input.condition === "lore-full-loop" && input.loreRun && agentSucceeded) {
    try {
      const transcript = formatTranscriptSessionContent([
        { role: "user", text: input.scenario.phaseA.prompt },
        { role: "assistant", text: summarizeAgentResponse(agentRun) },
      ])
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
      if (
        input.scenario.expectedContext.keywords.length > 0 &&
        formed.expectedContextIds.length === 0 &&
        failureReason === null
      ) {
        failureReason = "expected-context"
        failureMessage =
          "Formation did not create context matching the scenario's expected keywords."
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
  pricingTable: PricingTable | null
}): Promise<LongitudinalPhaseResult> {
  const startedAt = new Date().toISOString()
  const before = performance.now()
  if (input.wakeUp.failureMessage !== null && input.wakeUp.failureMessage !== undefined) {
    const patchStats = await computePatchStats(input.workspaceSource, input.workspace)
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
  for (const verifier of input.scenario.verifiers) {
    verifierResults.push(
      await runVerifier(verifier, input.workspace, input.workspaceSource)
    )
  }
  const patchStats = await computePatchStats(input.workspaceSource, input.workspace)
  const expectedSurfaced =
    input.condition === "no-memory" ||
    input.expectedContextIds.length === 0 ||
    input.expectedContextIds.some((id) => input.wakeUp.surfacedContextIds.includes(id))
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
  } else if (!expectedSurfaced) {
    failureReason = "expected-context"
    failureMessage =
      "Wake-up did not surface any expected context id created during formation."
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
}): Promise<LongitudinalPhaseResult> {
  const startedAt = new Date().toISOString()
  const before = performance.now()
  const patchStats = await computePatchStats(input.workspaceSource, input.workspace)
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
  results: LongitudinalTaskResult[]
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
      lifts[condition] = buildLiftSummary(scenarioIds, results, conditions, condition)
    }
  }
  const primaryLift =
    lifts["seeded-lore"] ??
    lifts["lore-full-loop"] ??
    buildLiftSummary(scenarioIds, results, conditions, "lore-full-loop")
  const passedTrials = results.filter((r) => r.success).length
  const passedTasks = countTasksAllPassed(
    results.map((result) => ({
      taskId: result.scenarioId,
      success: result.success,
    }))
  )
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

function buildLiftSummary(
  scenarioIds: string[],
  results: LongitudinalTaskResult[],
  conditions: Record<LongitudinalTaskCondition, LongitudinalConditionSummary>,
  toCondition: Exclude<LongitudinalTaskCondition, "no-memory">
): LongitudinalLiftSummary {
  const liftedScenarioIds: string[] = []
  const harmedScenarioIds: string[] = []
  for (const scenarioId of scenarioIds) {
    const noMemory = results.find(
      (r) => r.scenarioId === scenarioId && r.condition === "no-memory"
    )
    const memoryEnabled = results.find(
      (r) => r.scenarioId === scenarioId && r.condition === toCondition
    )
    if (!noMemory || !memoryEnabled) continue
    if (!noMemory.success && memoryEnabled.success) liftedScenarioIds.push(scenarioId)
    if (noMemory.success && !memoryEnabled.success) harmedScenarioIds.push(scenarioId)
  }

  const noMemoryRate = conditions["no-memory"].successRate
  const memoryRate = conditions[toCondition].successRate
  const successRateDelta =
    conditions["no-memory"].trials === 0 || conditions[toCondition].trials === 0
      ? null
      : roundRate(memoryRate - noMemoryRate)
  return {
    fromCondition: "no-memory",
    toCondition,
    successRateDelta,
    liftedScenarioIds,
    harmedScenarioIds,
  }
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
