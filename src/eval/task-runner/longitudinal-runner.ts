import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { performance } from "node:perf_hooks"
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
  LongitudinalFailureReason,
  LongitudinalLoreAdapter,
  LongitudinalLoreMetrics,
  LongitudinalLoreRun,
  LongitudinalPhaseResult,
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

export async function runLongitudinalTaskEvalSuite(
  loaded: { suite: LongitudinalTaskEvalSuite; root: string; path: string },
  options: RunTaskEvalOptions
): Promise<{ artifact: LongitudinalTaskArtifact; outPath: string }> {
  const adapters = options.adapters ?? defaultAdapters()
  const startedAt = (options.now ?? new Date()).toISOString()
  const loreAdapter = options.longitudinalLoreAdapter ?? defaultLongitudinalLoreAdapter()

  const results: LongitudinalTaskResult[] = []
  for (const scenario of loaded.suite.scenarios) {
    for (const condition of loaded.suite.conditions) {
      results.push(
        await runLongitudinalTrial({
          suite: loaded.suite,
          scenario,
          condition,
          suiteRoot: loaded.root,
          adapters,
          keepWorkspaces: options.keepWorkspaces ?? false,
          loreAdapter,
        })
      )
    }
  }

  const summary = summarizeLongitudinalResults(
    loaded.suite.scenarios.map((scenario) => scenario.id),
    results
  )
  const artifact: LongitudinalTaskArtifact = {
    suite: loaded.suite.name,
    description: loaded.suite.description,
    startedAt,
    runner: { mode: "task", kind: "longitudinal" },
    results,
    summary,
  }

  const outPath = resolve(
    options.outPath ?? defaultArtifactPath(loaded.suite.name, startedAt)
  )
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8")
  return { artifact, outPath }
}
async function runLongitudinalTrial(input: {
  suite: LongitudinalTaskEvalSuite
  scenario: LongitudinalTaskScenario
  condition: LongitudinalTaskCondition
  suiteRoot: string
  adapters: Map<string, AgentAdapter>
  keepWorkspaces: boolean
  loreAdapter: LongitudinalLoreAdapter
}): Promise<LongitudinalTaskResult> {
  const adapter = input.adapters.get(input.scenario.agent)
  if (!adapter) {
    throw new Error(
      `No adapter registered for agent "${input.scenario.agent}"; pass one via RunTaskEvalOptions.adapters.`
    )
  }

  const workspaceSource = resolve(input.suiteRoot, input.scenario.workspace)
  let workspace = await prepareWorkspace({
    source: workspaceSource,
    suiteRoot: input.suiteRoot,
    declaredPath: input.scenario.workspace,
  })
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
    })
    phases.push(formationPhase)
    await removeLongitudinalAgentConfig(workspace)
    workspace = await rematerializeWorkspace(workspace)
    workspaces.push(workspace)
    await removeLongitudinalAgentConfig(workspace)

    const expectedContextIds = formationPhase.lore.expectedContextIds
    const usePhase = formationPhase.success
      ? await runLongitudinalUsePhase({
          scenario: input.scenario,
          condition: input.condition,
          adapter,
          workspace,
          workspaceSource,
          wakeUp:
            input.condition === "lore-full-loop" && loreRun
              ? await loadLongitudinalWakeUp({
                  loreRun,
                  scenario: input.scenario,
                  phaseBPrompt: input.scenario.phaseB.prompt,
                  expectedContextIds,
                })
              : emptyWakeUpResult(),
          expectedContextIds,
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
      workspaceSource,
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
}): Promise<LongitudinalPhaseResult> {
  const startedAt = new Date().toISOString()
  const before = performance.now()
  const agentRun = await input.adapter.run({
    prompt: input.scenario.phaseA.prompt,
    workspace: input.workspace,
    timeoutMs: input.scenario.timeoutMs,
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
    cost: null,
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
        wakeUpEnabled: input.condition === "lore-full-loop",
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
    input.condition === "lore-full-loop"
      ? withWakeUpContext(input.scenario.phaseB.prompt, input.wakeUp.renderedContext)
      : input.scenario.phaseB.prompt
  const agentRun = await input.adapter.run({
    prompt,
    workspace: input.workspace,
    timeoutMs: input.scenario.timeoutMs,
  })
  const verifierResults: VerifierResult[] = []
  for (const verifier of input.scenario.verifiers) {
    verifierResults.push(
      await runVerifier(verifier, input.workspace, input.workspaceSource)
    )
  }
  const patchStats = await computePatchStats(input.workspaceSource, input.workspace)
  const expectedSurfaced =
    input.condition !== "lore-full-loop" ||
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
      wakeUpEnabled: input.condition === "lore-full-loop",
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

function summarizeLongitudinalResults(
  scenarioIds: string[],
  results: LongitudinalTaskResult[]
): LongitudinalTaskArtifact["summary"] {
  const conditions: Record<LongitudinalTaskCondition, LongitudinalConditionSummary> = {
    "no-memory": emptyConditionSummary(),
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

  const liftedScenarioIds: string[] = []
  const harmedScenarioIds: string[] = []
  for (const scenarioId of scenarioIds) {
    const noMemory = results.find(
      (r) => r.scenarioId === scenarioId && r.condition === "no-memory"
    )
    const fullLoop = results.find(
      (r) => r.scenarioId === scenarioId && r.condition === "lore-full-loop"
    )
    if (!noMemory || !fullLoop) continue
    if (!noMemory.success && fullLoop.success) liftedScenarioIds.push(scenarioId)
    if (noMemory.success && !fullLoop.success) harmedScenarioIds.push(scenarioId)
  }

  const noMemoryRate = conditions["no-memory"].successRate
  const fullLoopRate = conditions["lore-full-loop"].successRate
  const successRateDelta =
    conditions["no-memory"].trials === 0 || conditions["lore-full-loop"].trials === 0
      ? null
      : roundRate(fullLoopRate - noMemoryRate)
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
    lift: {
      fromCondition: "no-memory",
      toCondition: "lore-full-loop",
      successRateDelta,
      liftedScenarioIds,
      harmedScenarioIds,
    },
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
