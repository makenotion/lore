import { z } from "zod"
import type { MiningResult } from "../../hooks/conversation-mining.js"
import {
  TASK_EVAL_AGENTS,
  TASK_EVAL_MEMORY_CONDITIONS,
  TASK_EVAL_SUITE_VERSION,
  type TaskEvalMemoryCondition,
} from "../schema.js"

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
    memoryConditions: z.record(memoryConditionSchema, z.string().min(1)).default({}),
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
export type LongitudinalTaskScenario = z.infer<typeof longitudinalTaskScenarioSchema>
export type LongitudinalTaskEvalSuite = z.infer<typeof longitudinalTaskEvalSuiteSchema>
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
export function isLongitudinalTaskEvalSuite(
  suite: TaskEvalSuite
): suite is LongitudinalTaskEvalSuite {
  return "longitudinal" in suite && suite.longitudinal === true
}

export function isLongitudinalTaskArtifact(
  artifact: AnyTaskEvalArtifact
): artifact is LongitudinalTaskArtifact {
  return artifact.runner.mode === "task" && "kind" in artifact.runner
}
