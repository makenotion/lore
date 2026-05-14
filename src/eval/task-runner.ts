/**
 * End-to-end task-eval runner — the agent-execution half of the eval
 * spec, gated by deterministic verifiers. Distinct from the retrieval
 * runner: where retrieval mode scores which memories surface, task mode
 * scores whether an agent actually produced the desired workspace state
 * after the run. Layout:
 *
 * - `TaskEvalSuite`: a separate YAML file format from retrieval suites.
 *   Each task names a workspace fixture, a prompt, an agent, a memory-
 *   condition matrix, and a list of verifiers.
 * - `AgentAdapter`: pluggable interface. `CodexAgentAdapter` shells out
 *   to `codex exec --cd <workspace> --sandbox workspace-write`; tests
 *   inject a mock adapter directly.
 * - `Verifier`: pluggable interface. The shipped verifiers cover file
 *   existence, regex match (with optional forbid mode), and exact
 *   file-unchanged checks against the workspace fixture.
 *
 * The runner copies the workspace fixture into a tmp directory, seeds
 * the chosen memory condition's fixture file, hands the workspace to
 * the agent, executes verifiers against the post-run state, and cleans
 * the tmp directory. Workspace fixtures stay read-only on disk so a
 * concurrent run cannot corrupt them.
 *
 * Production safety:
 * - Real Codex invocation is gated behind `LORE_EVAL_TASK_REAL=1`. The
 *   default `CodexAgentAdapter.run` refuses to spawn without that env
 *   var, so a misconfigured CI job cannot rack up unbounded model
 *   spend.
 * - Codex spawns inherit a scrubbed env (only `PATH` / `HOME` / `TZ` /
 *   `LANG` / `LC_*` / `CODEX_*` / `OPENAI_API_KEY` are forwarded, with
 *   `CODEX_HOME` pointed at an isolated runtime home);
 *   `NOTION_API_TOKEN`, `LORE_NOTION_TOKEN`, `GITHUB_TOKEN` and
 *   anything else stays out of the child env and the artifact.
 * - The Codex child runs in a detached process group; timeout
 *   cancellation kills `-pgid` so subprocesses Codex spawned (test
 *   watchers, dev servers, package installs) terminate too.
 */
import { existsSync } from "node:fs"
import {
  cp,
  chmod,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  mkdir,
  mkdtemp,
} from "node:fs/promises"
import { join, dirname, resolve, relative } from "node:path"
import { tmpdir } from "node:os"
import { createHash, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { z } from "zod"
import type { AuthSource } from "../config.js"
import { resolveProjectByName } from "../core/project-scope.js"
import {
  loadWakeUpData,
  type WakeUpData,
} from "../core/wakeup.js"
import { initServices, type LoreServices } from "../services.js"
import type { Fact, Memory, Project } from "../types.js"
import {
  runConversationMining,
  type MiningResult,
} from "../hooks/conversation-mining.js"
import { mergeHookDefaults } from "../hooks/config.js"
import { formatTranscriptSessionContent } from "../hooks/transcript.js"
import {
  TASK_EVAL_AGENTS,
  TASK_EVAL_MEMORY_CONDITIONS,
  TASK_EVAL_SUITE_VERSION,
  type TaskEvalMemoryCondition,
} from "./schema.js"

const verifierSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("file-exists"),
      path: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("file-contents-match"),
      path: z.string().min(1),
      pattern: z
        .string()
        .min(1)
        // Reject malformed regexes at parse time so the runner never
        // throws SyntaxError mid-trial. Synthesizing a per-verifier
        // failure inside `runVerifier` would still leave the rest of
        // the suite running on the bad pattern; failing fast at parse
        // time matches every other lore validation discipline.
        .refine((p) => {
          try {
            new RegExp(p)
            return true
          } catch {
            return false
          }
        }, "must be a valid JavaScript regex"),
      mode: z.enum(["match", "forbid"]).default("match"),
    })
    .strict(),
  z
    .object({
      // Asserts the workspace file is byte-identical to the source
      // fixture. Used to pin "the agent must not modify this file"
      // contracts that the prompt declares but the agent could
      // otherwise violate without tripping a content-match verifier.
      type: z.literal("file-unchanged"),
      path: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("command"),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      cwd: z.string().min(1).optional(),
      timeoutMs: z.number().int().positive().default(120_000),
    })
    .strict(),
])

const memoryConditionSchema = z.enum(TASK_EVAL_MEMORY_CONDITIONS)

const taskEvalTaskSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be kebab-case"),
    prompt: z.string().min(1),
    agent: z.enum(TASK_EVAL_AGENTS).default("codex"),
    workspace: z.string().min(1),
    /**
     * Map from memory condition (`no-lore`, `helpful`, `noisy`,
     * `stale`) to a fixture path. Each condition listed here runs
     * the task once with that condition's fixture seeded into the
     * workspace's .lore-memories.json. Empty matrix means the task
     * runs once with no memory seeded — the agent's tools see whatever
     * the workspace fixture itself includes (typically nothing).
     */
    memoryConditions: z
      .record(memoryConditionSchema, z.string().min(1))
      .default({}),
    verifiers: z.array(verifierSchema).min(1),
    /** Per-task timeout cap on the agent invocation, in milliseconds. */
    timeoutMs: z.number().int().positive().default(300_000),
  })
  .strict()

const taskEvalStandardSuiteSchema = z
  .object({
    version: z.literal(TASK_EVAL_SUITE_VERSION),
    runner: z.literal("task").optional(),
    longitudinal: z.literal(false).optional(),
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be kebab-case"),
    description: z.string().default(""),
    tasks: z.array(taskEvalTaskSchema).min(1),
  })
  .strict()
  .superRefine((suite, ctx) => {
    const seen = new Set<string>()
    for (let i = 0; i < suite.tasks.length; i++) {
      const id = suite.tasks[i]!.id
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tasks", i, "id"],
          message: `duplicate task id "${id}"; ids must be unique within a suite`,
        })
      }
      seen.add(id)
    }
  })

const longitudinalConditionSchema = z.enum(["no-memory", "lore-full-loop"])

const longitudinalPhaseSchema = z
  .object({
    promptId: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be kebab-case")
      .optional(),
    prompt: z.string().min(1),
  })
  .strict()

const longitudinalExpectedContextSchema = z
  .object({
    description: z.string().default(""),
    keywords: z.array(z.string().min(1)).default([]),
    harmfulKeywords: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .default({})

const longitudinalTaskScenarioSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be kebab-case"),
    agent: z.enum(TASK_EVAL_AGENTS).default("codex"),
    workspace: z.string().min(1),
    phaseA: longitudinalPhaseSchema,
    phaseB: longitudinalPhaseSchema,
    expectedContext: longitudinalExpectedContextSchema,
    verifiers: z.array(verifierSchema).min(1),
    timeoutMs: z.number().int().positive().default(300_000),
  })
  .strict()

export const longitudinalTaskEvalSuiteSchema = z
  .object({
    version: z.literal(TASK_EVAL_SUITE_VERSION),
    runner: z.literal("task").optional(),
    longitudinal: z.literal(true),
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be kebab-case"),
    description: z.string().default(""),
    conditions: z
      .array(longitudinalConditionSchema)
      .min(1)
      .default(["no-memory", "lore-full-loop"]),
    scenarios: z.array(longitudinalTaskScenarioSchema).min(1),
  })
  .strict()
  .superRefine((suite, ctx) => {
    const seenScenarios = new Set<string>()
    for (let i = 0; i < suite.scenarios.length; i++) {
      const id = suite.scenarios[i]!.id
      if (seenScenarios.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scenarios", i, "id"],
          message: `duplicate scenario id "${id}"; ids must be unique within a suite`,
        })
      }
      seenScenarios.add(id)
    }

    const seenConditions = new Set<string>()
    for (let i = 0; i < suite.conditions.length; i++) {
      const condition = suite.conditions[i]!
      if (seenConditions.has(condition)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["conditions", i],
          message: `duplicate condition "${condition}"; conditions must be unique`,
        })
      }
      seenConditions.add(condition)
    }
  })

export const taskEvalSuiteSchema = z.union([
  longitudinalTaskEvalSuiteSchema,
  taskEvalStandardSuiteSchema,
])

export type TaskEvalVerifier = z.infer<typeof verifierSchema>
export type TaskEvalTask = z.infer<typeof taskEvalTaskSchema>
export type TaskEvalStandardSuite = z.infer<typeof taskEvalStandardSuiteSchema>
export type LongitudinalTaskCondition = z.infer<typeof longitudinalConditionSchema>
export type LongitudinalTaskScenario = z.infer<
  typeof longitudinalTaskScenarioSchema
>
export type LongitudinalTaskEvalSuite = z.infer<
  typeof longitudinalTaskEvalSuiteSchema
>
export type TaskEvalSuite = TaskEvalStandardSuite | LongitudinalTaskEvalSuite

export interface AgentRunInput {
  prompt: string
  workspace: string
  timeoutMs: number
}

export interface AgentRunResult {
  exitCode: number
  stdout: string
  stderr: string
  /** True when the run was forcibly terminated by the timeout. */
  timedOut: boolean
  /**
   * Set by an adapter that declined to invoke the underlying agent
   * (e.g., `CodexAgentAdapter` refusing without `LORE_EVAL_TASK_REAL=1`).
   * The runner reads this directly to set `failureReason: "adapter-refused"`,
   * so future adapters (Claude headless, etc.) get the same refusal
   * semantics without keying off a Codex-specific stderr substring.
   * Default false on all paths that actually invoked the agent.
   */
  refused?: boolean
}

/**
 * Adapter id is broadened to plain `string` (not `TaskEvalAgent`) so
 * tests can inject a mock adapter under any id without widening the
 * production agent enum. The runner consults `task.agent` (validated
 * against `TaskEvalAgent`) and looks up an adapter by that string in
 * the `adapters` map; a matching mock entry under id `"mock"` works in
 * tests because tests build their own `adapters` map.
 */
export interface AgentAdapter {
  readonly id: string
  run(input: AgentRunInput): Promise<AgentRunResult>
}

export interface VerifierResult {
  verifier: TaskEvalVerifier
  passed: boolean
  message: string
}

/**
 * Discriminator for failed trials so artifact consumers don't have to
 * re-derive the disambiguation between adapter refusal, timeouts,
 * spawn errors, agent-exit failure, and verifier failure. `null` on
 * successful trials.
 */
export type TaskFailureReason =
  | "adapter-refused"
  | "timeout"
  | "spawn-error"
  | "agent-exit"
  | "verifiers"

export type LongitudinalFailureReason =
  | TaskFailureReason
  | "formation"
  | "wake-up"
  | "expected-context"

export interface TaskEvalResult {
  taskId: string
  agent: string
  /** Memory condition this trial was run under, or null when the task has no matrix. */
  memoryCondition: TaskEvalMemoryCondition | null
  workspaceSource: string
  /** Tmp workspace path during the run; null after cleanup. */
  workspace: string | null
  success: boolean
  /** Disambiguates the failure mode; null on success. */
  failureReason: TaskFailureReason | null
  agentRun: AgentRunResult
  verifiers: VerifierResult[]
  metrics: {
    elapsedMs: number
  }
}

export interface PatchStats {
  filesChanged: number
  linesAdded: number
  linesRemoved: number
}

export interface LongitudinalLoreMetrics {
  hooksEnabled: boolean
  wakeUpEnabled: boolean
  memoriesCreated: number
  factsCreated: number
  decisionsCreated: number
  tasksCreated: number
  expectedContextIds: string[]
  surfacedContextIds: string[]
  harmfulContextIds: string[]
}

export interface LongitudinalCostMetrics {
  promptTokens: number | null
  completionTokens: number | null
  totalUsd: number | null
}

export interface LongitudinalPhaseResult {
  phase: "formation" | "use"
  promptId: string
  workspace: string | null
  startedAt: string
  finishedAt: string
  success: boolean
  agentRun: AgentRunResult | null
  verifierResults: VerifierResult[]
  patchStats: PatchStats
  lore: LongitudinalLoreMetrics
  cost: LongitudinalCostMetrics | null
  elapsedMs: number
  failureReason: LongitudinalFailureReason | null
  failureMessage: string | null
}

export interface LongitudinalTaskResult {
  taskId: string
  scenarioId: string
  condition: LongitudinalTaskCondition
  memoryCondition: null
  agent: string
  workspaceSource: string
  workspace: string | null
  success: boolean
  failureReason: LongitudinalFailureReason | null
  agentRun: AgentRunResult | null
  verifiers: VerifierResult[]
  phases: LongitudinalPhaseResult[]
  expectedContextDescription: string
}

export interface LongitudinalConditionSummary {
  trials: number
  passed: number
  failed: number
  successRate: number
}

export interface LongitudinalLiftSummary {
  fromCondition: "no-memory"
  toCondition: "lore-full-loop"
  successRateDelta: number | null
  liftedScenarioIds: string[]
  harmedScenarioIds: string[]
}

export interface TaskEvalArtifact {
  suite: string
  description: string
  startedAt: string
  runner: { mode: "task" }
  results: TaskEvalResult[]
  summary: {
    tasks: number
    passedTasks: number
    failedTasks: number
    /** Trials = tasks × matrix-size; matches `results.length`. */
    totalTrials: number
    passedTrials: number
    failedTrials: number
  }
}

export interface LongitudinalTaskArtifact {
  suite: string
  description: string
  startedAt: string
  runner: { mode: "task"; kind: "longitudinal" }
  results: LongitudinalTaskResult[]
  summary: {
    tasks: number
    passedTasks: number
    failedTasks: number
    totalTrials: number
    passedTrials: number
    failedTrials: number
    conditions: Record<LongitudinalTaskCondition, LongitudinalConditionSummary>
    lift: LongitudinalLiftSummary
  }
}

export type AnyTaskEvalArtifact = TaskEvalArtifact | LongitudinalTaskArtifact

export interface LongitudinalLoreFormationResult {
  projectId: string | null
  projectName: string | null
  mining: MiningResult | null
  memoriesCreated: number
  factsCreated: number
  decisionsCreated: number
  tasksCreated: number
  createdContextIds: string[]
  expectedContextIds: string[]
}

export interface LongitudinalWakeUpResult {
  renderedContext: string
  surfacedContextIds: string[]
  harmfulContextIds: string[]
  failureMessage: string | null
}

export interface LongitudinalLoreRun {
  projectId: string | null
  projectName: string | null
  formContext(input: {
    scenario: LongitudinalTaskScenario
    transcript: string
    workspace: string
    sessionId: string
  }): Promise<LongitudinalLoreFormationResult>
  loadContext(input: {
    scenario: LongitudinalTaskScenario
    phaseBPrompt: string
    expectedContextIds: string[]
  }): Promise<LongitudinalWakeUpResult>
  cleanup(): Promise<void>
}

export interface LongitudinalLoreAdapter {
  createRun(input: {
    suite: LongitudinalTaskEvalSuite
    scenario: LongitudinalTaskScenario
    runId: string
    workspace: string
  }): Promise<LongitudinalLoreRun>
}

export interface RunTaskEvalOptions {
  outPath?: string
  now?: Date
  /**
   * Map of agent id → adapter. The runner looks up `task.agent` in this
   * map. Defaults inject the `codex` adapter; tests inject the `mock`
   * adapter so they don't shell out to a real model.
   */
  adapters?: Map<string, AgentAdapter>
  /**
   * Skip workspace-tmpdir cleanup. Useful for debugging — operators
   * who want to inspect the post-run workspace state pass `true`.
   * Defaults to `false`; the runner removes every tmp workspace it
   * creates to avoid filling the disk with model-generated content.
   */
  keepWorkspaces?: boolean
  /**
   * Programmatic seam for tests and dry runs. Production callers leave
   * this unset; the runner builds a live Notion-backed adapter only when
   * the longitudinal real-run env gate is enabled.
   */
  longitudinalLoreAdapter?: LongitudinalLoreAdapter
}

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

async function runLongitudinalTaskEvalSuite(
  loaded: { suite: LongitudinalTaskEvalSuite; root: string; path: string },
  options: RunTaskEvalOptions
): Promise<{ artifact: LongitudinalTaskArtifact; outPath: string }> {
  const adapters = options.adapters ?? defaultAdapters()
  const startedAt = (options.now ?? new Date()).toISOString()
  const loreAdapter =
    options.longitudinalLoreAdapter ?? defaultLongitudinalLoreAdapter()

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

function isLongitudinalTaskEvalSuite(
  suite: TaskEvalSuite
): suite is LongitudinalTaskEvalSuite {
  return "longitudinal" in suite && suite.longitudinal === true
}

export function isLongitudinalTaskArtifact(
  artifact: AnyTaskEvalArtifact
): artifact is LongitudinalTaskArtifact {
  return artifact.runner.mode === "task" && "kind" in artifact.runner
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
        failureReason = err instanceof LongitudinalAdapterRefusedError
          ? "adapter-refused"
          : "formation"
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
  if (
    input.wakeUp.failureMessage !== null &&
    input.wakeUp.failureMessage !== undefined
  ) {
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
    verifierResults.push(await runVerifier(verifier, input.workspace, input.workspaceSource))
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
  const conditions: Record<
    LongitudinalTaskCondition,
    LongitudinalConditionSummary
  > = {
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
    conditions["no-memory"].trials === 0 ||
    conditions["lore-full-loop"].trials === 0
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

function countTasksAllPassed(
  results: Array<Pick<TaskEvalResult, "taskId" | "success">>
): number {
  const successByTask = new Map<string, boolean>()
  for (const result of results) {
    const prior = successByTask.get(result.taskId)
    successByTask.set(result.taskId, (prior ?? true) && result.success)
  }
  let passed = 0
  for (const value of successByTask.values()) if (value) passed++
  return passed
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

async function prepareWorkspace(input: {
  source: string
  suiteRoot: string
  declaredPath: string
}): Promise<string> {
  // Path-escape guard. `task.workspace` is operator-controlled YAML; a
  // malicious or careless `../../../etc` could otherwise turn `fs.cp`
  // into a recursive read of arbitrary host filesystem directories
  // (and write them into a tmpdir handed to the agent). The legitimate
  // boundary is the suite root's parent — sibling directories like
  // `evals/workspaces/<name>` are valid, anything that climbs above
  // `evals/` is not. Mirrors the `seedMemoryCondition` boundary.
  const evalsRoot = dirname(input.suiteRoot)
  const rel = relative(evalsRoot, input.source)
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(
      `Workspace fixture path "${input.declaredPath}" escapes the eval-suite parent directory`
    )
  }
  const dir = await mkdtemp(join(tmpdir(), "lore-eval-task-"))
  // `fs.cp` (Node 16.7+) preserves modes and handles symlinks/dotfiles
  // out of the box. The recursive flag walks subdirectories; verbatim
  // mode preservation matters when a fixture commits an executable
  // script (e.g. `scripts/setup.sh`) whose +x bit must survive the copy.
  await cp(input.source, dir, { recursive: true, preserveTimestamps: true })
  return dir
}

async function rematerializeWorkspace(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lore-eval-task-"))
  await cp(source, dir, { recursive: true, preserveTimestamps: true })
  return dir
}

async function seedMemoryCondition(input: {
  suiteRoot: string
  fixturePath: string
  workspace: string
}): Promise<void> {
  const absolute = resolve(input.suiteRoot, input.fixturePath)
  // Path-escape guard. Production memory fixtures live next to the
  // suite root in a sibling directory (e.g., a YAML suite reading a
  // JSON memory fixture in a peer subdirectory), so the legitimate
  // read scope is
  // "under the suite root's parent" — NOT the suite root itself, and
  // NOT a broader `evals/` ancestor. The boundary intentionally allows
  // sibling-directory reads (task-memory/, baselines/) but rejects
  // anything that escapes via `../../../etc/...`. If org policy ever
  // requires pinning an `evals/baselines/` subtree as untouchable
  // read-only, tighten this boundary in lockstep with the new
  // contract.
  const evalsRoot = dirname(input.suiteRoot)
  const rel = relative(evalsRoot, absolute)
  // `rel.startsWith("/")` is a Windows-port hedge; `path.relative` on
  // POSIX never returns an absolute path, but on win32 it can return
  // a drive-letter path (`C:\...`) that no `..` prefix would catch.
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(
      `Memory-condition fixture path "${input.fixturePath}" escapes the eval-suite parent directory`
    )
  }
  const contents = await readFile(absolute, "utf-8")
  // Conventional drop point: .lore-memories.json at the workspace
  // root. Agent prompts that are matrix-aware reference this path.
  await writeFile(
    join(input.workspace, ".lore-memories.json"),
    contents,
    "utf-8"
  )
}

function deriveFailureReason(
  success: boolean,
  agentRun: AgentRunResult,
  verifierResults: VerifierResult[]
): TaskFailureReason | null {
  if (success) return null
  // Adapter-side refusal is a structural field on AgentRunResult,
  // not a Codex-specific stderr substring. Future adapters set
  // `refused: true` on their own opt-out paths.
  if (agentRun.refused) return "adapter-refused"
  if (agentRun.timedOut) return "timeout"
  if (agentRun.exitCode < 0) return "spawn-error"
  if (agentRun.exitCode !== 0) return "agent-exit"
  if (verifierResults.some((v) => !v.passed)) return "verifiers"
  // Defensive: if `success` is false but no axis says so, treat as
  // verifiers (the only remaining contributor to the success calc).
  return "verifiers"
}

async function runVerifier(
  verifier: TaskEvalVerifier,
  workspace: string,
  workspaceSource: string
): Promise<VerifierResult> {
  if (verifier.type === "command") {
    return runCommandVerifier(verifier, workspace)
  }
  const target = resolve(workspace, verifier.path)
  if (!isInsideWorkspace(target, workspace)) {
    return {
      verifier,
      passed: false,
      message: `Verifier path "${verifier.path}" escapes the workspace`,
    }
  }
  if (verifier.type === "file-exists") {
    try {
      await stat(target)
      return { verifier, passed: true, message: `File exists: ${verifier.path}` }
    } catch {
      return { verifier, passed: false, message: `File missing: ${verifier.path}` }
    }
  }
  if (verifier.type === "file-unchanged") {
    const sourcePath = resolve(workspaceSource, verifier.path)
    let sourceHash: string
    let workspaceHash: string
    try {
      sourceHash = await hashFile(sourcePath)
    } catch {
      return {
        verifier,
        passed: false,
        message: `Source fixture missing for unchanged check: ${verifier.path}`,
      }
    }
    try {
      workspaceHash = await hashFile(target)
    } catch {
      return {
        verifier,
        passed: false,
        message: `Workspace file missing for unchanged check: ${verifier.path}`,
      }
    }
    return sourceHash === workspaceHash
      ? {
          verifier,
          passed: true,
          message: `File unchanged from fixture: ${verifier.path}`,
        }
      : {
          verifier,
          passed: false,
          message: `File modified from fixture: ${verifier.path}`,
        }
  }
  // file-contents-match. The regex was already validated at schema-parse
  // time, so this construction cannot throw.
  let contents: string
  try {
    contents = await readFile(target, "utf-8")
  } catch {
    return {
      verifier,
      passed: false,
      message: `File missing for content check: ${verifier.path}`,
    }
  }
  const regex = new RegExp(verifier.pattern)
  const matched = regex.test(contents)
  if (verifier.mode === "match") {
    return {
      verifier,
      passed: matched,
      message: matched
        ? `Pattern matched in ${verifier.path}`
        : `Pattern did not match in ${verifier.path}`,
    }
  }
  return {
    verifier,
    passed: !matched,
    message: matched
      ? `Forbidden pattern matched in ${verifier.path}`
      : `Forbidden pattern not present in ${verifier.path}`,
  }
}

async function runCommandVerifier(
  verifier: Extract<TaskEvalVerifier, { type: "command" }>,
  workspace: string
): Promise<VerifierResult> {
  const cwd = resolve(workspace, verifier.cwd ?? ".")
  if (!isInsideWorkspace(cwd, workspace)) {
    return {
      verifier,
      passed: false,
      message: `Command cwd "${verifier.cwd ?? "."}" escapes the workspace`,
    }
  }

  const result = await runVerifierCommand({
    command: verifier.command,
    args: verifier.args,
    cwd,
    timeoutMs: verifier.timeoutMs,
  })
  if (result.timedOut) {
    return {
      verifier,
      passed: false,
      message: `Command timed out after ${verifier.timeoutMs}ms: ${formatCommand(verifier)}`,
    }
  }
  if (result.exitCode !== 0) {
    return {
      verifier,
      passed: false,
      message:
        `Command failed (${result.exitCode}): ${formatCommand(verifier)}` +
        firstCommandOutput(result),
    }
  }
  return {
    verifier,
    passed: true,
    message: `Command passed: ${formatCommand(verifier)}`,
  }
}

function runVerifierCommand(input: {
  command: string
  args: string[]
  cwd: string
  timeoutMs: number
}): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolveRun) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildVerifierChildEnv(),
      detached: true,
    })
    const stdoutCapture = makeCappedCapture()
    const stderrCapture = makeCappedCapture()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch {
        // Process already exited.
      }
    }, input.timeoutMs)
    child.stdout?.on("data", (c: Buffer) => appendCappedChunk(stdoutCapture, c))
    child.stderr?.on("data", (c: Buffer) => appendCappedChunk(stderrCapture, c))
    child.on("error", (err) => {
      clearTimeout(timer)
      resolveRun({
        exitCode: -1,
        stdout: joinCappedCapture(stdoutCapture),
        stderr: joinCappedCapture(stderrCapture) + `\n[spawn-error] ${err}`,
        timedOut,
      })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolveRun({
        exitCode: code ?? -1,
        stdout: joinCappedCapture(stdoutCapture),
        stderr: joinCappedCapture(stderrCapture),
        timedOut,
      })
    })
  })
}

function buildVerifierChildEnv(
  parentEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const key of ["PATH", "HOME", "TMPDIR", "TZ", "LANG", "LC_ALL", "LC_CTYPE"]) {
    const value = parentEnv[key]
    if (value !== undefined) out[key] = value
  }
  out["CI"] = parentEnv["CI"] ?? "1"
  return out
}

function formatCommand(verifier: Extract<TaskEvalVerifier, { type: "command" }>): string {
  return [verifier.command, ...verifier.args].join(" ")
}

function firstCommandOutput(input: { stdout: string; stderr: string }): string {
  const firstLine = `${input.stderr}\n${input.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return firstLine ? `; ${firstLine}` : ""
}

async function hashFile(path: string): Promise<string> {
  const buf = await readFile(path)
  return createHash("sha256").update(buf).digest("hex")
}

function isInsideWorkspace(target: string, workspace: string): boolean {
  const rel = relative(workspace, target)
  return !rel.startsWith("..") && !rel.startsWith("/")
}

async function computePatchStats(
  sourceRoot: string,
  workspaceRoot: string
): Promise<PatchStats> {
  const [sourceFiles, workspaceFiles] = await Promise.all([
    listRelativeFiles(sourceRoot),
    listRelativeFiles(workspaceRoot),
  ])
  const allFiles = new Set([...sourceFiles, ...workspaceFiles])
  let filesChanged = 0
  let linesAdded = 0
  let linesRemoved = 0
  for (const file of [...allFiles].sort()) {
    const sourcePath = join(sourceRoot, file)
    const workspacePath = join(workspaceRoot, file)
    const sourceExists = sourceFiles.includes(file)
    const workspaceExists = workspaceFiles.includes(file)
    const sourceText = sourceExists ? await readTextForStats(sourcePath) : null
    const workspaceText = workspaceExists ? await readTextForStats(workspacePath) : null
    if (sourceText === workspaceText) continue
    filesChanged += 1
    const diff = diffLineCounts(sourceText, workspaceText)
    linesAdded += diff.added
    linesRemoved += diff.removed
  }
  return { filesChanged, linesAdded, linesRemoved }
}

const PATCH_STATS_IGNORED_NAMES = new Set([
  ".codex",
  ".git",
  ".lore-memories.json",
  ".lore.yaml",
  ".mcp.json",
  "node_modules",
])

async function listRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (PATCH_STATS_IGNORED_NAMES.has(entry.name)) continue
      const absolute = join(dir, entry.name)
      const rel = relative(root, absolute)
      if (entry.isDirectory()) {
        await walk(absolute)
      } else if (entry.isFile()) {
        files.push(rel)
      }
    }
  }
  await walk(root)
  return files.sort()
}

async function readTextForStats(path: string): Promise<string> {
  const buffer = await readFile(path)
  if (buffer.includes(0)) return ""
  return buffer.toString("utf-8")
}

function diffLineCounts(
  before: string | null,
  after: string | null
): { added: number; removed: number } {
  const beforeLines = splitDiffLines(before ?? "")
  const afterLines = splitDiffLines(after ?? "")
  if (before === null) return { added: afterLines.length, removed: 0 }
  if (after === null) return { added: 0, removed: beforeLines.length }
  const lcs = longestCommonSubsequenceLength(beforeLines, afterLines)
  return {
    added: Math.max(0, afterLines.length - lcs),
    removed: Math.max(0, beforeLines.length - lcs),
  }
}

function splitDiffLines(text: string): string[] {
  if (text.length === 0) return []
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text
  if (normalized.length === 0) return []
  return normalized.split(/\r?\n/)
}

function longestCommonSubsequenceLength(a: string[], b: string[]): number {
  if (a.length * b.length > 1_000_000) {
    const shared = new Set(a)
    return b.filter((line) => shared.has(line)).length
  }
  const row = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    let prev = 0
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j]!
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(row[j]!, row[j - 1]!)
      prev = temp
    }
  }
  return row[b.length]!
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100
}

function roundRate(value: number): number {
  return Math.round(value * 10_000) / 10_000
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
    return firstNonEmptyLine(agentRun.stderr) ?? `Agent exited with code ${agentRun.exitCode}`
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

function defaultArtifactPath(suiteName: string, startedAt: string): string {
  const safe = startedAt.replace(/[:.]/g, "-")
  return resolve(process.cwd(), "evals", "results", `${suiteName}-${safe}.json`)
}

function defaultAdapters(): Map<string, AgentAdapter> {
  // Note: no `mock` entry. A committed YAML cannot reference an agent
  // without a production adapter; tests build their own adapter map.
  return new Map<string, AgentAdapter>([["codex", new CodexAgentAdapter()]])
}

function defaultLongitudinalLoreAdapter(): LongitudinalLoreAdapter {
  const allowReal = process.env["LORE_EVAL_LONGITUDINAL_REAL"]
  if (allowReal === "1" || allowReal === "true") {
    return new LiveLongitudinalLoreAdapter()
  }
  return new RefusingLongitudinalLoreAdapter(
    "Real longitudinal Lore formation refused: set " +
      "LORE_EVAL_LONGITUDINAL_REAL=1 and " +
      "LORE_EVAL_LONGITUDINAL_SANDBOX_PROJECT to opt in."
  )
}

export class LongitudinalAdapterRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LongitudinalAdapterRefusedError"
  }
}

class RefusingLongitudinalLoreAdapter implements LongitudinalLoreAdapter {
  constructor(private readonly message: string) {}

  async createRun(): Promise<LongitudinalLoreRun> {
    const message = this.message
    return {
      projectId: null,
      projectName: null,
      async formContext(): Promise<LongitudinalLoreFormationResult> {
        throw new LongitudinalAdapterRefusedError(message)
      },
      async loadContext(): Promise<LongitudinalWakeUpResult> {
        throw new LongitudinalAdapterRefusedError(message)
      },
      async cleanup(): Promise<void> {},
    }
  }
}

class LiveLongitudinalLoreAdapter implements LongitudinalLoreAdapter {
  private servicesPromise: Promise<LoreServices> | null = null

  async createRun(input: {
    suite: LongitudinalTaskEvalSuite
    scenario: LongitudinalTaskScenario
    runId: string
    workspace: string
  }): Promise<LongitudinalLoreRun> {
    const services = await this.services()
    const sandboxProjectName = process.env["LORE_EVAL_LONGITUDINAL_SANDBOX_PROJECT"]
    if (!sandboxProjectName) {
      throw new LongitudinalAdapterRefusedError(
        "LORE_EVAL_LONGITUDINAL_SANDBOX_PROJECT is required for lore-full-loop runs."
      )
    }
    assertLongitudinalSandboxProjectName(sandboxProjectName)
    const parentProject = await resolveProjectByName(
      services.projects,
      sandboxProjectName,
      "longitudinal eval sandbox"
    )
    const projectName = `${parentProject.name}/${input.runId}`
    const project = await services.projects.create({
      name: projectName,
      path: ".",
      description:
        `Longitudinal eval project for suite ${input.suite.name}, ` +
        `scenario ${input.scenario.id}.`,
    })
    let configRoot: string | null = null
    try {
      configRoot = await mkdtemp(join(tmpdir(), "lore-eval-longitudinal-config-"))
      await chmod(configRoot, 0o700)
      await writeLongitudinalConfigRoot({
        configRoot,
        services,
        projectName: project.name,
      })
      return new LiveLongitudinalLoreRun({
        services,
        project,
        configRoot,
        workspace: input.workspace,
      })
    } catch (err) {
      await Promise.allSettled([
        services.projects.archive(project.id),
        configRoot
          ? rm(configRoot, { recursive: true, force: true })
          : Promise.resolve(),
      ])
      throw err
    }
  }

  private async services(): Promise<LoreServices> {
    if (!this.servicesPromise) {
      const configuredRoot = process.env["LORE_EVAL_LONGITUDINAL_CONFIG_ROOT"]
      if (configuredRoot) {
        const prior = process.env["LORE_CONFIG_ROOT"]
        process.env["LORE_CONFIG_ROOT"] = configuredRoot
        this.servicesPromise = initServices(undefined, { driftCheck: false }).finally(
          () => {
            if (prior === undefined) delete process.env["LORE_CONFIG_ROOT"]
            else process.env["LORE_CONFIG_ROOT"] = prior
          }
        )
      } else {
        this.servicesPromise = initServices(undefined, { driftCheck: false })
      }
    }
    return this.servicesPromise
  }
}

class LiveLongitudinalLoreRun implements LongitudinalLoreRun {
  readonly projectId: string
  readonly projectName: string

  constructor(
    private readonly input: {
      services: LoreServices
      project: Project
      configRoot: string
      workspace: string
    }
  ) {
    this.projectId = input.project.id
    this.projectName = input.project.name
  }

  async formContext(input: {
    scenario: LongitudinalTaskScenario
    transcript: string
    workspace: string
    sessionId: string
  }): Promise<LongitudinalLoreFormationResult> {
    const before = await snapshotProjectContext(this.input.services, this.projectId)
    const hooks = mergeHookDefaults(this.input.services.config.hooks, this.projectName, [])
    const codexHome = await createIsolatedCodexHome()
    let mining: MiningResult
    try {
      mining = await withTemporaryLongitudinalAgentConfig(
        {
          workspace: input.workspace,
          configRoot: this.input.configRoot,
          services: this.input.services,
        },
        () =>
          withTemporaryEnv(
            {
              LORE_CONFIG_ROOT: this.input.configRoot,
              LORE_AGENT_NAME: process.env["LORE_AGENT_NAME"] ?? "Codex",
              CODEX_HOME: codexHome,
            },
            () =>
              runConversationMining(input.transcript, {
                cwd: input.workspace,
                subProjects: [],
                catchAllName: this.projectName,
                sessionId: input.sessionId,
                agentName: "Codex",
                authSource: this.input.services.authSource,
                agent: hooks.backgroundAgent,
              })
          )
      )
    } finally {
      await removeIsolatedCodexHome(codexHome)
    }
    const after = await snapshotProjectContext(this.input.services, this.projectId)
    const delta = diffProjectContextSnapshots(before, after)
    const expectedContextIds = selectExpectedContextIds(
      input.scenario.expectedContext.keywords,
      delta.contexts
    )
    return {
      projectId: this.projectId,
      projectName: this.projectName,
      mining,
      memoriesCreated: delta.memoriesCreated,
      factsCreated: delta.factsCreated,
      decisionsCreated: delta.decisionsCreated,
      tasksCreated: delta.tasksCreated,
      createdContextIds: delta.contexts.map((context) => context.id),
      expectedContextIds,
    }
  }

  async loadContext(input: {
    scenario: LongitudinalTaskScenario
    phaseBPrompt: string
    expectedContextIds: string[]
  }): Promise<LongitudinalWakeUpResult> {
    const data = await loadWakeUpData(this.input.services, {
      projectId: this.projectId,
      userQuery: input.phaseBPrompt,
      includeMemoryContent: true,
      includeCoverage: true,
    })
    return wakeUpDataToLongitudinalResult(data, input.scenario)
  }

  async cleanup(): Promise<void> {
    await this.input.services.projects.archive(this.projectId)
    await rm(this.input.configRoot, { recursive: true, force: true })
  }
}

const LONGITUDINAL_SANDBOX_NAME_MARKERS =
  /\b(?:sandbox|eval|test|scratch|staging|dev|playground)\b/i

export type LongitudinalAgentConfigServices = Pick<
  LoreServices,
  "authSource" | "config"
>

function assertLongitudinalSandboxProjectName(projectName: string): void {
  if (LONGITUDINAL_SANDBOX_NAME_MARKERS.test(projectName)) return
  const allowProd = process.env["LORE_EVAL_NOTION_ALLOW_PRODUCTION"]
  if (allowProd === "1" || allowProd === "true") return
  throw new Error(
    `Project "${projectName}" does not look like a sandbox (no word-bounded match for sandbox/eval/test/scratch/staging/dev/playground). ` +
      `Set LORE_EVAL_NOTION_ALLOW_PRODUCTION=1 to confirm pointing longitudinal task evals at this project on purpose.`
  )
}

async function writeLongitudinalConfigRoot(input: {
  configRoot: string
  services: LoreServices
  projectName: string
}): Promise<void> {
  const auth =
    input.services.config.auth &&
    (input.services.config.auth.workspaceId || input.services.config.auth.baseUrl)
      ? {
          workspaceId: input.services.config.auth.workspaceId,
          baseUrl: input.services.config.auth.baseUrl,
        }
      : undefined
  const config = {
    vault: { pageId: input.services.config.vault.pageId },
    ...(auth ? { auth } : {}),
    projects: [{ name: input.projectName, path: "." }],
    hooks: input.services.config.hooks ?? {},
  }
  await writeFile(join(input.configRoot, ".lore.yaml"), stringifyYaml(config), {
    mode: 0o600,
  })
}

async function writeLongitudinalAgentConfig(input: {
  workspace: string
  configRoot: string
  services: LongitudinalAgentConfigServices
}): Promise<void> {
  const mcpCommand = await resolveMcpCommand()
  const mcpEnv = buildLongitudinalMcpEnv(input.configRoot, input.services.authSource)
  await mkdir(join(input.workspace, ".codex"), { recursive: true, mode: 0o700 })
  await writeFile(
    join(input.workspace, ".codex", "config.toml"),
    renderCodexMcpConfig({ command: mcpCommand.command, args: mcpCommand.args, env: mcpEnv }),
    { mode: 0o600 }
  )
  await writeFile(
    join(input.workspace, ".mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          lore: {
            command: mcpCommand.command,
            args: mcpCommand.args,
            env: mcpEnv,
          },
        },
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  )
}

async function removeLongitudinalAgentConfig(workspace: string): Promise<void> {
  await Promise.all([
    rm(join(workspace, ".codex", "config.toml"), { force: true }),
    rm(join(workspace, ".mcp.json"), { force: true }),
  ])
}

export async function withTemporaryLongitudinalAgentConfig<T>(
  input: {
    workspace: string
    configRoot: string
    services: LongitudinalAgentConfigServices
  },
  fn: () => Promise<T>
): Promise<T> {
  try {
    await writeLongitudinalAgentConfig(input)
    return await fn()
  } finally {
    await removeLongitudinalAgentConfig(input.workspace)
  }
}

async function resolveMcpCommand(): Promise<{ command: string; args: string[] }> {
  const distMcp = resolve(dirname(fileURLToPath(import.meta.url)), "..", "mcp.js")
  try {
    await stat(distMcp)
    return { command: "node", args: [distMcp] }
  } catch {
    return { command: "lore", args: ["mcp"] }
  }
}

function buildLongitudinalMcpEnv(
  configRoot: string,
  authSource: AuthSource
): Record<string, string> {
  const env: Record<string, string> = {
    LORE_CONFIG_ROOT: configRoot,
    LORE_SUPPRESS_DEPRECATIONS: "1",
    LORE_BACKGROUND_AGENT: "true",
  }
  for (const key of [
    "PATH",
    "HOME",
    "NOTION_API_TOKEN",
    "LORE_NOTION_TOKEN",
    "LORE_NOTION_BASE_URL",
    "NOTION_WORKSPACE_ID",
    "NOTION_ENV",
    "NOTION_BASE_URL",
    "NOTION_API_BASE_URL",
    "LORE_USER_NAME",
  ]) {
    if (
      authSource === "ntn-auth-json" &&
      (key === "NOTION_API_TOKEN" || key === "LORE_NOTION_TOKEN")
    ) {
      continue
    }
    const value = process.env[key]
    if (typeof value === "string" && value.length > 0) env[key] = value
  }
  return env
}

function renderCodexMcpConfig(input: {
  command: string
  args: string[]
  env: Record<string, string>
}): string {
  const enabledTools = [
    "lore-context",
    "lore-query",
    "lore-memory",
    "lore-decision",
    "lore-fact",
    "lore-task",
    "lore-project",
  ]
  const lines = [
    "[mcp_servers.lore]",
    'transport = "stdio"',
    `command = "${tomlEscape(input.command)}"`,
    `args = [${input.args.map((arg) => `"${tomlEscape(arg)}"`).join(", ")}]`,
    'default_tools_approval_mode = "approve"',
    `enabled_tools = [${enabledTools.map((tool) => `"${tool}"`).join(", ")}]`,
    "",
    "[mcp_servers.lore.env]",
  ]
  for (const [key, value] of Object.entries(input.env).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    lines.push(`${key} = "${tomlEscape(value)}"`)
  }
  lines.push("")
  return lines.join("\n")
}

function tomlEscape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
}

async function withTemporaryEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const prior = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(overrides)) {
    prior.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

interface ProjectContextSnapshot {
  memoryContexts: ProjectContextItem[]
  factContexts: ProjectContextItem[]
}

export interface ProjectContextItem {
  id: string
  kind: Memory["kind"] | "fact"
  text: string
}

async function snapshotProjectContext(
  services: LoreServices,
  projectId: string
): Promise<ProjectContextSnapshot> {
  const memoryContexts: ProjectContextItem[] = []
  for await (const memory of services.memories.listAllForBackfill({ projectId })) {
    memoryContexts.push(memoryToContextItem(memory))
  }
  const factContexts: ProjectContextItem[] = []
  for await (const fact of services.facts.listAllForBackfill({ projectId })) {
    factContexts.push(factToContextItem(fact))
  }
  return { memoryContexts, factContexts }
}

function diffProjectContextSnapshots(
  before: ProjectContextSnapshot,
  after: ProjectContextSnapshot
): {
  memoriesCreated: number
  factsCreated: number
  decisionsCreated: number
  tasksCreated: number
  contexts: ProjectContextItem[]
} {
  const beforeIds = new Set([
    ...before.memoryContexts.map((item) => item.id),
    ...before.factContexts.map((item) => item.id),
  ])
  const contexts = [...after.memoryContexts, ...after.factContexts].filter(
    (item) => !beforeIds.has(item.id)
  )
  return {
    memoriesCreated: contexts.filter(
      (item) => item.kind !== "decision" && item.kind !== "task" && item.kind !== "fact"
    ).length,
    factsCreated: contexts.filter((item) => item.kind === "fact").length,
    decisionsCreated: contexts.filter((item) => item.kind === "decision").length,
    tasksCreated: contexts.filter((item) => item.kind === "task").length,
    contexts,
  }
}

export function selectExpectedContextIds(
  keywords: string[],
  contexts: ProjectContextItem[]
): string[] {
  if (keywords.length === 0) {
    return contexts
      .filter((context) => context.kind !== "fact")
      .map((context) => context.id)
  }
  const normalized = keywords.map((keyword) => keyword.toLocaleLowerCase())
  const combinedText = contexts
    .map((context) => context.text)
    .join("\n")
    .toLocaleLowerCase()
  if (normalized.every((keyword) => combinedText.includes(keyword))) {
    const partialMatches = contexts.filter((context) => {
      const text = context.text.toLocaleLowerCase()
      return normalized.some((keyword) => text.includes(keyword))
    })
    return partialMatches.length > 0
      ? partialMatches.map((context) => context.id)
      : contexts.map((context) => context.id)
  }
  return contexts
    .filter((context) => {
      const text = context.text.toLocaleLowerCase()
      return normalized.every((keyword) => text.includes(keyword))
    })
    .map((context) => context.id)
}

function wakeUpDataToLongitudinalResult(
  data: WakeUpData,
  scenario: LongitudinalTaskScenario
): LongitudinalWakeUpResult {
  const contexts = wakeUpDataToContextItems(data)
  const surfacedContextIds = contexts.map((context) => context.id)
  const harmfulKeywords = scenario.expectedContext.harmfulKeywords.map((keyword) =>
    keyword.toLocaleLowerCase()
  )
  const harmfulContextIds =
    harmfulKeywords.length === 0
      ? []
      : contexts
          .filter((context) => {
            const text = context.text.toLocaleLowerCase()
            return harmfulKeywords.some((keyword) => text.includes(keyword))
          })
          .map((context) => context.id)
  return {
    renderedContext: renderLongitudinalWakeUpContext(contexts),
    surfacedContextIds,
    harmfulContextIds,
    failureMessage: null,
  }
}

function wakeUpDataToContextItems(data: WakeUpData): ProjectContextItem[] {
  const items: ProjectContextItem[] = []
  const add = (item: ProjectContextItem | null | undefined) => {
    if (!item) return
    if (items.some((existing) => existing.id === item.id)) return
    items.push(item)
  }
  add(data.digest ? memoryToContextItem(data.digest) : null)
  for (const memory of data.taskMemories) add(memoryToContextItem(memory))
  for (const memory of data.memories) add(memoryToContextItem(memory))
  for (const memory of data.relatedMemories) add(memoryToContextItem(memory))
  for (const memory of data.proposedMemories) add(memoryToContextItem(memory))
  for (const memory of data.staleConfidence) add(memoryToContextItem(memory))
  for (const memory of data.pinnedBlocks) add(memoryToContextItem(memory))
  for (const section of data.inheritedMemories) {
    for (const memory of section.memories) add(memoryToContextItem(memory))
  }
  for (const decision of data.proposedDecisions) add(memoryToContextItem(decision))
  for (const decision of data.overdueDecisions) add(memoryToContextItem(decision))
  for (const task of data.tasks) add(memoryToContextItem(task))
  for (const fact of data.knowledgeFacts) add(factToContextItem(fact))
  return items
}

function memoryToContextItem(
  memory: Omit<Memory, "content"> & { content?: string }
): ProjectContextItem {
  return {
    id: memory.id,
    kind: memory.kind,
    text: [
      memory.kind,
      memory.title,
      memory.synopsis,
      memory.keywords,
      memory.entity,
      memory.content ?? "",
    ]
      .filter(Boolean)
      .join("\n"),
  }
}

function factToContextItem(fact: Fact): ProjectContextItem {
  return {
    id: fact.id,
    kind: "fact",
    text: ["fact", fact.subject, fact.predicate, fact.object].join(" "),
  }
}

function renderLongitudinalWakeUpContext(contexts: ProjectContextItem[]): string {
  if (contexts.length === 0) return ""
  const lines: string[] = []
  for (const context of contexts) {
    const preview = context.text.replace(/\s+/g, " ").trim().slice(0, 1_000)
    lines.push(`- [${context.kind}] ${context.id}: ${preview}`)
  }
  return lines.join("\n")
}

/**
 * Allowlist of env vars forwarded to the Codex child. Anything not
 * listed here stays out of the child env (and out of the JSON artifact's
 * captured stdout/stderr if the model echoes its env). Secrets like
 * `NOTION_API_TOKEN`, `LORE_NOTION_TOKEN`, and `GITHUB_TOKEN` are
 * deliberately absent.
 */
export const CODEX_FORWARDED_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TZ",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "OPENAI_API_KEY",
] as const

const CODEX_FORWARDED_ENV_PREFIXES = ["CODEX_"]
const CODEX_HOME_CONFIG_KEYS = new Set([
  "model",
  "model_provider",
  "model_reasoning_effort",
])

export async function createIsolatedCodexHome(
  parentEnv: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const codexHome = await mkdtemp(join(tmpdir(), "lore-eval-codex-home-"))
  try {
    await chmod(codexHome, 0o700)
    const sourceHome = resolveSourceCodexHome(parentEnv)
    if (sourceHome !== null) {
      const sourceAuth = join(sourceHome, "auth.json")
      if (existsSync(sourceAuth)) {
        const targetAuth = join(codexHome, "auth.json")
        await cp(sourceAuth, targetAuth)
        await chmod(targetAuth, 0o600).catch(() => undefined)
      }
      const sourceConfig = join(sourceHome, "config.toml")
      if (existsSync(sourceConfig)) {
        const configText = renderIsolatedCodexConfig(
          await readFile(sourceConfig, "utf-8")
        )
        if (configText.length > 0) {
          await writeFile(join(codexHome, "config.toml"), configText, { mode: 0o600 })
        }
      }
    }
    return codexHome
  } catch (err) {
    await removeIsolatedCodexHome(codexHome)
    throw err
  }
}

function resolveSourceCodexHome(parentEnv: NodeJS.ProcessEnv): string | null {
  const explicit = parentEnv["CODEX_HOME"]
  if (typeof explicit === "string" && explicit.length > 0) return explicit
  const home = parentEnv["HOME"]
  if (typeof home === "string" && home.length > 0) return join(home, ".codex")
  return null
}

function renderIsolatedCodexConfig(source: string): string {
  const lines: string[] = []
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue
    if (trimmed.startsWith("[")) break
    const match = /^([A-Za-z0-9_]+)\s*=/.exec(trimmed)
    if (match && CODEX_HOME_CONFIG_KEYS.has(match[1]!)) {
      lines.push(trimmed)
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : ""
}

async function removeIsolatedCodexHome(codexHome: string): Promise<void> {
  await rm(codexHome, { recursive: true, force: true })
}

export function buildCodexChildEnv(
  parentEnv: NodeJS.ProcessEnv = process.env,
  options: { codexHome?: string } = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const key of CODEX_FORWARDED_ENV_KEYS) {
    const value = parentEnv[key]
    if (value !== undefined) out[key] = value
  }
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue
    for (const prefix of CODEX_FORWARDED_ENV_PREFIXES) {
      if (key.startsWith(prefix)) {
        out[key] = value
        break
      }
    }
  }
  if (options.codexHome !== undefined) {
    out["CODEX_HOME"] = options.codexHome
    out["HOME"] = options.codexHome
  }
  return out
}

/**
 * Cap on the bytes captured per stream (stdout, stderr) from the Codex
 * child. Real Codex sessions can produce multi-MB stdout in long runs;
 * the in-memory concat would land the whole stream in the JSON
 * artifact. Bounded to 1 MiB per stream — enough to surface refusal
 * messages and short failure traces, small enough to keep the artifact
 * comparable in CI artifact-upload size limits.
 */
export const CODEX_CAPTURE_CAP_BYTES = 1024 * 1024

interface CappedCapture {
  chunks: Buffer[]
  truncated: boolean
}

function makeCappedCapture(): CappedCapture {
  return { chunks: [], truncated: false }
}

function appendCappedChunk(capture: CappedCapture, chunk: Buffer): void {
  let captured = 0
  for (const c of capture.chunks) captured += c.length
  if (captured >= CODEX_CAPTURE_CAP_BYTES) {
    capture.truncated = true
    return
  }
  const remaining = CODEX_CAPTURE_CAP_BYTES - captured
  if (remaining >= chunk.length) {
    capture.chunks.push(chunk)
  } else {
    capture.chunks.push(chunk.subarray(0, remaining))
    // The chunk was clipped — mark truncated so the join() pass adds
    // the marker. Avoids the exact-fill false-positive that the prior
    // `>= CODEX_CAPTURE_CAP_BYTES` check produced when the last chunk
    // landed completely.
    capture.truncated = true
  }
}

function joinCappedCapture(capture: CappedCapture): string {
  const text = Buffer.concat(capture.chunks).toString("utf-8")
  if (capture.truncated) {
    return `${text}\n[capture-truncated at ${CODEX_CAPTURE_CAP_BYTES} bytes]`
  }
  return text
}

/**
 * Production agent adapter. Shells out to `codex exec --cd <workspace>
 * --sandbox workspace-write --skip-git-repo-check <prompt>` with a
 * scrubbed env and an isolated Codex runtime home, in a detached
 * process group so timeout cancellation kills the whole tree.
 *
 * Gated behind `LORE_EVAL_TASK_REAL=1` because real Codex invocations
 * incur model spend; without the env var the adapter exits cleanly with
 * a recognizable stderr line and a non-zero exit code so the runner
 * surfaces "we declined to actually run" rather than a misleading
 * success.
 *
 * **Platform**: POSIX (macOS / Linux). The detached process group +
 * `process.kill(-pid)` teardown is POSIX semantics. Windows' process-
 * group model differs and `process.kill(-pid)` will throw there; the
 * timer's catch swallows that throw and the SIGKILL never lands. The
 * eval runner's docs target nightly CI on Linux/Mac. A future Windows
 * port must reimplement the timeout teardown via `taskkill /T` or
 * equivalent.
 */
/**
 * Sentinel file the bench-runner drops into a per-example workspace
 * to opt the adapter into bench-mode invocation. Task-mode workspaces
 * never carry this file, so `CodexAgentAdapter.run()` branches purely
 * on its presence and the task-mode path stays byte-stable.
 *
 * The sentinel name is intentionally hyphen-prefixed so a careless
 * directory listing surfaces it as a hidden config file rather than
 * blending with task fixtures.
 */
export const BENCH_MODE_SENTINEL = ".lore-bench-mode"

/**
 * Detect whether a workspace was prepared for bench-mode. The bench
 * runner writes this sentinel at workspace construction; the file is
 * zero bytes and exists only as a flag.
 */
function isBenchWorkspace(workspace: string): boolean {
  return existsSync(join(workspace, BENCH_MODE_SENTINEL))
}

/**
 * Bench-mode argv: `codex exec --json --output-last-message
 * <answer-file> -m <model> --cd <workspace> --sandbox workspace-write
 * --skip-git-repo-check <prompt>`. The full `mcp_servers.lore` block
 * (transport, command, args, env including the bench bearer) lives
 * on disk at `<workspace>/.codex/config.toml` (mode 0600); the
 * Codex argv carries zero secrets. See `buildBenchSpawnArgs` and
 * `buildBenchWorkspace` (`eval/bench-runner.ts`) for the on-disk
 * shape and the threat-model trade-off vs argv routing.
 */
export const BENCH_AGENT_MODEL = "gpt-4o-mini-2024-07-18"

/**
 * Env vars the bench-runner reads to populate the workspace
 * `.codex/config.toml`'s `[mcp_servers.lore.env]` block. The bench-
 * runner is responsible for setting them per example.
 */
export const BENCH_RUNTIME_NOTION_TOKEN_ENV = "LORE_BENCH_NOTION_TOKEN"
export const BENCH_RUNTIME_CONFIG_ROOT_ENV = "LORE_BENCH_CONFIG_ROOT"
export const BENCH_RUNTIME_OPENAI_KEY_ENV = "LORE_BENCH_OPENAI_API_KEY"

/**
 * Env keys cleared from the operator's parent env before the bench
 * Codex child is spawned. Operator-day-to-day Notion / GitHub /
 * Anthropic tokens must not reach the Codex parent process; the
 * bench's MCP-child Notion auth comes from the on-disk
 * `<workspace>/.codex/config.toml` `[mcp_servers.lore.env]` block
 * (see `buildBenchWorkspace`), not from inheritance. Clearing the
 * day-to-day token from Codex's parent env is defense-in-depth so a
 * future Codex env-passthrough behavior change cannot accidentally
 * route the wrong token into the MCP child.
 */
export const BENCH_CHILD_CLEARED_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "NOTION_API_TOKEN",
  "LORE_NOTION_TOKEN",
  "GITHUB_TOKEN",
] as const

/**
 * Build the bench-mode Codex child env. The allowlist below mirrors
 * `CODEX_FORWARDED_ENV_KEYS` minus secrets that must come from the
 * bench-runner's controlled env, plus the explicit
 * `LORE_BENCH_OPENAI_API_KEY → OPENAI_API_KEY` mapping.
 */
export function buildBenchCodexChildEnv(
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const key of ["PATH", "HOME", "TMPDIR", "TZ", "LANG", "LC_ALL", "LC_CTYPE"]) {
    const value = parentEnv[key]
    if (value !== undefined) out[key] = value
  }
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue
    if (key.startsWith("CODEX_")) out[key] = value
  }
  // Explicit child OPENAI_API_KEY comes ONLY from
  // LORE_BENCH_OPENAI_API_KEY; the operator's day-to-day
  // OPENAI_API_KEY is in BENCH_CHILD_CLEARED_ENV_KEYS so it doesn't
  // reach the child via inheritance.
  const benchOpenAI = parentEnv[BENCH_RUNTIME_OPENAI_KEY_ENV]
  if (benchOpenAI) out["OPENAI_API_KEY"] = benchOpenAI
  return out
}

/**
 * Build the Codex `exec` argv for a bench-mode run. The entire
 * bench MCP config (transport, command, args, env including the
 * bench bearer) lives on disk at `<workspace>/.codex/config.toml`
 * (mode `0o600`) — see `buildBenchWorkspace` in
 * `eval/bench-runner.ts`. The spawn argv carries ZERO secrets;
 * `args.join(" ")` is safe to log.
 *
 * Exported so the regression test can assert "the rendered argv
 * contains no bearer-shaped substring." The invariant: token
 * routing happens via on-disk config, never via Codex argv.
 */
export function buildBenchSpawnArgs(workspace: string, prompt: string): string[] {
  return [
    "exec",
    "--json",
    "--output-last-message",
    join(workspace, "answer.txt"),
    "-m",
    BENCH_AGENT_MODEL,
    "--cd",
    workspace,
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    prompt,
  ]
}

export class CodexAgentAdapter implements AgentAdapter {
  readonly id: string = "codex"

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (isBenchWorkspace(input.workspace)) {
      return this.runBench(input)
    }
    return this.runTask(input)
  }

  private async runBench(input: AgentRunInput): Promise<AgentRunResult> {
    const allowReal = process.env["LORE_EVAL_BENCH_REAL"]
    if (allowReal !== "1" && allowReal !== "true") {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "[codex-adapter] real bench Codex invocation refused: set LORE_EVAL_BENCH_REAL=1 to opt in. " +
          "This guard prevents misconfigured CI from racking up unbounded model spend.",
        timedOut: false,
        refused: true,
      }
    }
    const args = buildBenchSpawnArgs(input.workspace, input.prompt)
    return new Promise<AgentRunResult>((resolveRun) => {
      const child = spawn("codex", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: buildBenchCodexChildEnv(),
        detached: true,
      })
      const stdoutCapture = makeCappedCapture()
      const stderrCapture = makeCappedCapture()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
          else child.kill("SIGKILL")
        } catch {
          // Process already gone; nothing to do.
        }
      }, input.timeoutMs)
      child.stdout?.on("data", (c: Buffer) => appendCappedChunk(stdoutCapture, c))
      child.stderr?.on("data", (c: Buffer) => appendCappedChunk(stderrCapture, c))
      child.on("error", (err) => {
        clearTimeout(timer)
        resolveRun({
          exitCode: -1,
          stdout: joinCappedCapture(stdoutCapture),
          stderr: joinCappedCapture(stderrCapture) + `\n[spawn-error] ${err}`,
          timedOut,
        })
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        resolveRun({
          exitCode: code ?? -1,
          stdout: joinCappedCapture(stdoutCapture),
          stderr: joinCappedCapture(stderrCapture),
          timedOut,
        })
      })
    })
  }

  private async runTask(input: AgentRunInput): Promise<AgentRunResult> {
    const allowReal = process.env["LORE_EVAL_TASK_REAL"]
    if (allowReal !== "1" && allowReal !== "true") {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "[codex-adapter] real Codex invocation refused: set LORE_EVAL_TASK_REAL=1 to opt in. " +
          "This guard prevents misconfigured CI from racking up unbounded model spend.",
        timedOut: false,
        refused: true,
      }
    }
    const codexHome = await createIsolatedCodexHome()
    return new Promise<AgentRunResult>((resolveRun) => {
      const args = [
        "exec",
        "--cd",
        input.workspace,
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        input.prompt,
      ]
      const env = buildCodexChildEnv(process.env, { codexHome })
      const child = spawn("codex", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env,
        // Detached so we can kill the entire process group on timeout
        // (codex may have spawned subprocesses inside `workspace-write`
        // — test watchers, package installs — that we need to clean up).
        detached: true,
      })
      const stdoutCapture = makeCappedCapture()
      const stderrCapture = makeCappedCapture()
      let timedOut = false
      let settled = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          if (child.pid !== undefined) {
            // Negative pid kills the process group on POSIX. We hold
            // detached=true so the group is `child.pid`'s own.
            process.kill(-child.pid, "SIGKILL")
          } else {
            child.kill("SIGKILL")
          }
        } catch {
          // Process already gone; nothing to do.
        }
      }, input.timeoutMs)
      const finish = (result: AgentRunResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void removeIsolatedCodexHome(codexHome).finally(() => resolveRun(result))
      }
      child.stdout?.on("data", (c: Buffer) => appendCappedChunk(stdoutCapture, c))
      child.stderr?.on("data", (c: Buffer) => appendCappedChunk(stderrCapture, c))
      child.on("error", (err) => {
        finish({
          exitCode: -1,
          stdout: joinCappedCapture(stdoutCapture),
          stderr: joinCappedCapture(stderrCapture) + `\n[spawn-error] ${err}`,
          timedOut,
        })
      })
      child.on("close", (code) => {
        finish({
          exitCode: code ?? -1,
          stdout: joinCappedCapture(stdoutCapture),
          stderr: joinCappedCapture(stderrCapture),
          timedOut,
        })
      })
    })
  }
}
