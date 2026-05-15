import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { parse as parseYaml } from "yaml"
import type { TaskEvalMemoryCondition } from "../schema.js"
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

export async function loadTaskEvalSuite(path: string): Promise<{
  suite: TaskEvalSuite
  root: string
  path: string
}> {
  const absolute = resolve(path)
  const raw = await readFile(absolute, "utf-8")
  const parsed = parseYaml(raw) as unknown
  const suite = taskEvalSuiteSchema.parse(parsed)
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

  const adapters = options.adapters ?? defaultAdapters()
  const startedAt = (options.now ?? new Date()).toISOString()

  const results: TaskEvalResult[] = []
  for (const task of loaded.suite.tasks) {
    const conditions = Object.entries(task.memoryConditions) as Array<
      [TaskEvalMemoryCondition, string]
    >
    if (conditions.length === 0) {
      results.push(
        await runTaskEvalTrial({
          task,
          condition: null,
          conditionFixture: null,
          suiteRoot: loaded.root,
          adapters,
          keepWorkspaces: options.keepWorkspaces ?? false,
        })
      )
      continue
    }
    for (const [condition, fixturePath] of conditions) {
      results.push(
        await runTaskEvalTrial({
          task,
          condition,
          conditionFixture: fixturePath,
          suiteRoot: loaded.root,
          adapters,
          keepWorkspaces: options.keepWorkspaces ?? false,
        })
      )
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

  const outPath = resolve(
    options.outPath ?? defaultArtifactPath(loaded.suite.name, startedAt)
  )
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
}): Promise<TaskEvalResult> {
  const adapter = input.adapters.get(input.task.agent)
  if (!adapter) {
    throw new Error(
      `No adapter registered for agent "${input.task.agent}"; pass one via RunTaskEvalOptions.adapters.`
    )
  }
  const before = performance.now()
  const workspaceSource = resolve(input.suiteRoot, input.task.workspace)
  const workspace = await prepareWorkspace({
    source: workspaceSource,
    suiteRoot: input.suiteRoot,
    declaredPath: input.task.workspace,
  })
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
    })
    const verifierResults: VerifierResult[] = []
    for (const verifier of input.task.verifiers) {
      verifierResults.push(await runVerifier(verifier, workspace, workspaceSource))
    }
    const success =
      agentRun.exitCode === 0 &&
      !agentRun.timedOut &&
      verifierResults.every((r) => r.passed)
    return {
      taskId: input.task.id,
      agent: input.task.agent,
      memoryCondition: input.condition,
      workspaceSource,
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
