import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { parse as parseYaml } from "yaml"
import type { TaskEvalMemoryCondition } from "../schema.js"
import { loadSeedCorpus } from "../seed-corpus.js"
import { defaultAdapters } from "./codex-adapter.js"
import { runLongitudinalTaskEvalSuite } from "./longitudinal-runner.js"
import { countTasksAllPassed, defaultArtifactPath } from "./shared.js"
import {
  isLongitudinalTaskEvalSuite,
  taskEvalSuiteSchema,
  type AgentAdapter,
  type AnyTaskEvalArtifact,
  type RunTaskEvalOptions,
  type TaskEvalArtifact,
  type TaskEvalResult,
  type TaskEvalSuite,
  type TaskEvalTask,
  type VerifierResult,
} from "./schema.js"
import { deriveFailureReason, runVerifier } from "./verifier.js"
import { prepareWorkspace, seedMemoryCondition } from "./workspace.js"
import { roundMs } from "./patch-stats.js"
import { resolveTranscriptDir, taskTranscriptPath } from "./transcripts.js"

export async function loadTaskEvalSuite(path: string): Promise<{
  suite: TaskEvalSuite
  root: string
  path: string
}> {
  const absolute = resolve(path)
  const raw = await readFile(absolute, "utf-8")
  const parsed = parseYaml(raw) as unknown
  const suite = taskEvalSuiteSchema.parse(parsed)
  if (isLongitudinalTaskEvalSuite(suite) && suite.seededCorpus) {
    const corpus = await loadSeedCorpus(resolve(dirname(absolute), suite.seededCorpus))
    const corpusContextIds = new Set([
      ...corpus.vault.memories.map((memory) => memory.id),
      ...corpus.vault.decisions.map((decision) => decision.id),
      ...corpus.vault.facts.map((fact) => fact.id),
    ])
    for (const scenario of suite.scenarios) {
      const ids = [
        ...(scenario.seededContext?.contextIds ?? []),
        ...(scenario.seededContext?.harmfulContextIds ?? []),
      ]
      const unknownIds = ids.filter((id) => !corpusContextIds.has(id))
      if (unknownIds.length > 0) {
        throw new Error(
          `Seeded corpus ${suite.seededCorpus} does not define context id(s) for scenario ${scenario.id}: ${unknownIds.join(", ")}`
        )
      }
    }
  }
  return { suite, root: dirname(absolute), path: absolute }
}

export async function runTaskEvalSuite(
  suitePath: string,
  options: RunTaskEvalOptions = {}
): Promise<{ artifact: AnyTaskEvalArtifact; outPath: string }> {
  const loaded = await loadTaskEvalSuite(suitePath)
  if (isLongitudinalTaskEvalSuite(loaded.suite)) {
    return runLongitudinalTaskEvalSuite(
      { suite: loaded.suite, root: loaded.root, path: loaded.path },
      options
    )
  }
  if (options.costKillSwitchUsd !== undefined) {
    throw new Error(
      "--cost-kill-switch-usd is only supported for longitudinal task suites."
    )
  }
  if (
    options.difficulty !== undefined ||
    options.sample !== undefined ||
    (options.scenarioIds?.length ?? 0) > 0 ||
    options.parallelism !== undefined
  ) {
    throw new Error(
      "--difficulty, --sample, --scenario-id, and --parallel are only supported for longitudinal task suites."
    )
  }

  const adapters = options.adapters ?? defaultAdapters()
  const startedAt = (options.now ?? new Date()).toISOString()
  const outPath = resolve(
    options.outPath ?? defaultArtifactPath(loaded.suite.name, startedAt)
  )
  const transcriptsDir = resolveTranscriptDir(options.transcriptsDir, outPath)
  const totalTrials = loaded.suite.tasks.reduce(
    (total, task) => total + Math.max(1, Object.keys(task.memoryConditions).length),
    0
  )

  const results: TaskEvalResult[] = []
  for (const task of loaded.suite.tasks) {
    const conditions = Object.entries(task.memoryConditions) as Array<
      [TaskEvalMemoryCondition, string]
    >
    if (conditions.length === 0) {
      const index = results.length + 1
      options.onProgress?.({
        type: "trial-start",
        runner: "task",
        taskId: task.id,
        scenarioId: null,
        condition: null,
        index,
        total: totalTrials,
      })
      const result = await runTaskEvalTrial({
        task,
        condition: null,
        conditionFixture: null,
        suiteRoot: loaded.root,
        adapters,
        keepWorkspaces: options.keepWorkspaces ?? false,
        transcriptPath: taskTranscriptPath({
          transcriptsDir,
          index,
          taskId: task.id,
          condition: null,
        }),
      })
      results.push(result)
      options.onProgress?.({
        type: "trial-finish",
        runner: "task",
        taskId: task.id,
        scenarioId: null,
        condition: null,
        index,
        total: totalTrials,
        success: result.success,
      })
      continue
    }
    for (const [condition, fixturePath] of conditions) {
      const index = results.length + 1
      options.onProgress?.({
        type: "trial-start",
        runner: "task",
        taskId: task.id,
        scenarioId: null,
        condition,
        index,
        total: totalTrials,
      })
      const result = await runTaskEvalTrial({
        task,
        condition,
        conditionFixture: fixturePath,
        suiteRoot: loaded.root,
        adapters,
        keepWorkspaces: options.keepWorkspaces ?? false,
        transcriptPath: taskTranscriptPath({
          transcriptsDir,
          index,
          taskId: task.id,
          condition,
        }),
      })
      results.push(result)
      options.onProgress?.({
        type: "trial-finish",
        runner: "task",
        taskId: task.id,
        scenarioId: null,
        condition,
        index,
        total: totalTrials,
        success: result.success,
      })
    }
  }

  const passedTrials = results.filter((r) => r.success).length
  const taskIds = new Set(results.map((r) => r.taskId))
  const passedTasks = countTasksAllPassed(results)
  const artifact: TaskEvalArtifact = {
    suite: loaded.suite.name,
    description: loaded.suite.description,
    startedAt,
    runner: { mode: "task" },
    results,
    summary: {
      tasks: taskIds.size,
      passedTasks,
      failedTasks: taskIds.size - passedTasks,
      totalTrials: results.length,
      passedTrials,
      failedTrials: results.length - passedTrials,
    },
  }

  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8")
  return { artifact, outPath }
}
async function runTaskEvalTrial(input: {
  task: TaskEvalTask
  condition: TaskEvalMemoryCondition | null
  conditionFixture: string | null
  suiteRoot: string
  adapters: Map<string, AgentAdapter>
  keepWorkspaces: boolean
  transcriptPath?: string
}): Promise<TaskEvalResult> {
  const adapter = input.adapters.get(input.task.agent)
  if (!adapter) {
    throw new Error(
      `No adapter registered for agent "${input.task.agent}"; pass one via RunTaskEvalOptions.adapters.`
    )
  }
  const before = performance.now()
  const prepared = await prepareWorkspace({
    source: input.task.workspace,
    suiteRoot: input.suiteRoot,
    declaredPath: formatWorkspaceSource(input.task.workspace),
  })
  const workspace = prepared.workspace
  try {
    if (input.conditionFixture) {
      await seedMemoryCondition({
        suiteRoot: input.suiteRoot,
        fixturePath: input.conditionFixture,
        workspace,
      })
    }
    const agentRun = await adapter.run({
      prompt: input.task.prompt,
      workspace,
      timeoutMs: input.task.timeoutMs,
      transcriptPath: input.transcriptPath,
    })
    const verifierResults: VerifierResult[] = []
    for (const verifier of input.task.verifiers) {
      verifierResults.push(await runVerifier(verifier, workspace, prepared.sourceRoot))
    }
    const success =
      agentRun.exitCode === 0 &&
      !agentRun.timedOut &&
      verifierResults.every((r) => r.passed)
    return {
      taskId: input.task.id,
      agent: input.task.agent,
      memoryCondition: input.condition,
      workspaceSource: prepared.sourceLabel,
      workspaceMaterialization: prepared.materialization,
      workspace: input.keepWorkspaces ? workspace : null,
      success,
      failureReason: deriveFailureReason(success, agentRun, verifierResults),
      agentRun,
      verifiers: verifierResults,
      metrics: { elapsedMs: roundMs(performance.now() - before) },
    }
  } finally {
    if (!input.keepWorkspaces) {
      await rm(workspace, { recursive: true, force: true })
    }
  }
}

function formatWorkspaceSource(source: TaskEvalTask["workspace"]): string {
  return typeof source === "string"
    ? source
    : `${source.kind}:${source.repo}@${source.sha}`
}
