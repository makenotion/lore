import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import { z } from "zod"

export const EVAL_SUITE_VERSION = 1

export const EVAL_RUNNERS = ["retrieval", "notion", "task", "bench"] as const

/**
 * Agents the committed task-eval YAML may reference. `mock` is
 * intentionally NOT in this list — tests pass mock adapters via
 * `RunTaskEvalOptions.adapters` directly, but a committed YAML cannot
 * reference an agent that has no production implementation. Adding a
 * new agent (Claude Code headless, etc.) is a one-entry edit here plus
 * the matching `AgentAdapter` implementation.
 */
export const TASK_EVAL_AGENTS = ["codex"] as const

export const TASK_EVAL_SUITE_VERSION = 1

export type TaskEvalAgent = (typeof TASK_EVAL_AGENTS)[number]

/**
 * Memory conditions for the task-eval matrix.
 * Each task is exercised against every condition listed in its
 * `memoryConditions` map; the runner seeds the workspace with the
 * condition's fixture file before invoking the agent. Mirrors the
 * retrieval-suite ablations with the same names so the two surfaces
 * stay aligned.
 */
export const TASK_EVAL_MEMORY_CONDITIONS = [
  "no-lore",
  "helpful",
  "noisy",
  "stale",
] as const

export type TaskEvalMemoryCondition = (typeof TASK_EVAL_MEMORY_CONDITIONS)[number]

export const REQUIRED_ABLATION_SCENARIOS = [
  "no-lore",
  "empty-lore",
  "helpful-memory",
] as const

export const EVAL_SURFACES = [
  "wake-up.taskMemories",
  "wake-up.memories",
  "wake-up.relatedMemories",
  "wake-up.staleConfidence",
] as const

export type EvalRunner = (typeof EVAL_RUNNERS)[number]
export type RequiredAblationScenario = (typeof REQUIRED_ABLATION_SCENARIOS)[number]
export type EvalSurface = (typeof EVAL_SURFACES)[number]

const scenarioIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be kebab-case")

const memoryIdSchema = z.string().min(1)

const retrievalExpectationSchema = z
  .object({
    shouldSurface: z.array(memoryIdSchema).default([]),
    shouldNotSurface: z.array(memoryIdSchema).default([]),
  })
  .strict()

const evalTaskSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be kebab-case"),
    prompt: z
      .string()
      .min(1)
      .describe(
        "Prompt for the task. Consumed as `userQuery` only on the " +
          "wake-up.taskMemories surface. Decorative on memories, " +
          "relatedMemories, and staleConfidence surfaces, which route " +
          "through queries that ignore the prompt. See docs/evals.md " +
          "(\"Wake-up surfaces\") for the per-surface contract."
      ),
    surface: z.enum(EVAL_SURFACES).default("wake-up.taskMemories"),
    memoryScenarios: z.record(scenarioIdSchema, z.string().min(1)),
    expectedRetrieval: z.record(scenarioIdSchema, retrievalExpectationSchema).default({}),
    retrieval: z
      .object({
        limit: z.number().int().positive().default(5),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((task, ctx) => {
    for (const scenario of REQUIRED_ABLATION_SCENARIOS) {
      if (!(scenario in task.memoryScenarios)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["memoryScenarios", scenario],
          message: `required ablation scenario "${scenario}" is missing`,
        })
      }
    }
    for (const scenario of Object.keys(task.expectedRetrieval)) {
      if (!(scenario in task.memoryScenarios)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expectedRetrieval", scenario],
          message: `expected retrieval scenario "${scenario}" is not defined in memoryScenarios`,
        })
      }
    }
    const helpfulExpectation = task.expectedRetrieval["helpful-memory"]
    if (!helpfulExpectation || helpfulExpectation.shouldSurface.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedRetrieval", "helpful-memory", "shouldSurface"],
        message:
          "retrieval tasks must define expectedRetrieval.helpful-memory.shouldSurface",
      })
    }
  })

export const evalSuiteSchema = z
  .object({
    // When introducing v2, accept every supported version here and normalize in
    // loadEvalSuite so committed v1 suites keep loading through the migration.
    version: z.literal(EVAL_SUITE_VERSION),
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be kebab-case"),
    description: z.string().default(""),
    trials: z.number().int().positive().default(1),
    runner: z.enum(EVAL_RUNNERS).default("retrieval"),
    tasks: z.array(evalTaskSchema).min(1),
  })
  .strict()

export const evalMemoryScenarioSchema = z
  .object({
    name: scenarioIdSchema,
    description: z.string().default(""),
    memories: z
      .array(
        z
          .object({
            id: memoryIdSchema,
            title: z.string().min(1),
            kind: z
              .enum(["note", "decision", "incident", "runbook", "postmortem", "policy"])
              .default("note"),
            status: z
              .enum([
                "informational",
                "proposed",
                "accepted",
                "superseded",
                "deprecated",
                "rejected",
              ])
              .default("informational"),
            confidence: z.enum(["certain", "likely", "speculative"]).default("certain"),
            tags: z.array(z.string().min(1)).default([]),
            keywords: z.string().default(""),
            synopsis: z.string().default(""),
            content: z.string().default(""),
            // Surface annotations: opt-in flags that route a memory to a
            // particular wake-up section in the fixture runner. A memory may
            // carry multiple flags (e.g., a digest row also surfaces in
            // recents). Defaults preserve the existing taskMemories-only
            // suite shape.
            isStaleConfidence: z.boolean().default(false),
          })
          .strict()
      )
      .default([]),
    // Active task fixtures seed the relatedMemories surface — the wake-up
    // path extracts entity strings from active tasks and runs a semantic
    // search against them. Fixture tasks here drive that seeding without
    // adding a new top-level YAML schema for tasks.
    tasks: z
      .array(
        z
          .object({
            id: memoryIdSchema,
            subject: z.string().min(1),
            entity: z.string().default(""),
          })
          .strict()
      )
      .default([]),
  })
  .strict()

/**
 * LongMemEval bench-suite schema (issue #595). Structurally disjoint
 * from `evalSuiteSchema`: the dispatcher in `runEvalSuite` reads the
 * top-level `runner` field first and routes "bench" to `runBenchSuite`
 * before deeper validation.
 *
 * Every field that has a single supported value (model snapshots,
 * adapter, benchmark) is a `z.literal` — adding a second model is a
 * Zod-schema change, which is exactly the audit checkpoint we want.
 * `.strict()` at every level rejects unknown fields so a typo can't
 * silently disable a knob.
 */
/**
 * Ingestion strategy for the bench. Two values:
 *
 * - `lore-mine` (V1 default): each session is mined through the
 *   production Stop-hook autosave pipeline (`runConversationMining`
 *   → `claude -p` → `lore mcp` tools). Faithful to Lore's production
 *   write path. On LongMemEval's synthetic-conversation corpus the
 *   autosave's "durable knowledge" filter intentionally rejects
 *   casual conversational facts, so mining produces ~1 memory per
 *   ~30-session haystack and the agent recalls little. The bench
 *   number measures "Lore's production filter against the LongMemEval
 *   workload" — honest but not Zep-comparable.
 *
 * - `raw-transcript`: each session is stored verbatim as one memory
 *   (title `Session <i>`, body = the session transcript). Bypasses
 *   the autosave filter; the agent's `lore-query` / `lore-context`
 *   retrieves the transcript memory and answers from its body. This
 *   mirrors Zep's Graphiti-ingest baseline: every conversational
 *   token is stored, retrieval reads it back. Apples-to-apples with
 *   the published Zep LongMemEval numbers.
 *
 * The two strategies measure different things — V1 ships both,
 * suite YAML picks. The committed `longmemeval.yaml` keeps
 * `lore-mine` (V1 contract); a parallel `longmemeval-raw-transcript.yaml`
 * runs raw-transcript so operators can publish whichever number
 * matches the workload they're calibrating against.
 */
export const BENCH_INGESTION_STRATEGIES = ["lore-mine", "raw-transcript"] as const
export type BenchIngestionStrategy = (typeof BENCH_INGESTION_STRATEGIES)[number]

/**
 * Retrieval strategy for the agent. Two values:
 *
 * - `tool-driven` (V1 default): the agent has Lore MCP tools
 *   (`lore-query`, `lore-memory`, `lore-context`) registered and
 *   decides for itself when to call them. Maps to mid-session
 *   followup behavior in production Lore. **Currently structurally
 *   unavailable under `codex exec`** — Codex 0.128.0 does not load
 *   MCP servers in its non-interactive exec mode (`enable_mcp_apps`
 *   feature flag is "under development"). The agent sees no tools
 *   and falls through to shell-command attempts that all fail with
 *   `command not found`. Listed here for documentation completeness
 *   and to keep the schema stable when a future Codex release or
 *   Claude Code headless adapter restores tool-driven retrieval.
 *
 * - `wake-up-prefetch`: the bench-runner calls `loadWakeUpData` with
 *   `userQuery=<question>` BEFORE invoking the agent. The
 *   relevance-ranked top memories (bodies included) are rendered as
 *   a system-prompt addendum the agent reads inline. No MCP tools
 *   required — the agent just answers from the injected context.
 *   Maps to how Lore's wake-up hook actually works at session start:
 *   the hook calls `lore-context action='wake-up' userQuery=<task>`
 *   via the agent's MCP integration and the response is pasted into
 *   the agent's context window. For the bench surface, this is
 *   functionally equivalent: pre-fetched relevance bundle, agent
 *   answers from it.
 */
export const BENCH_AGENT_RETRIEVAL_STRATEGIES = [
  "tool-driven",
  "wake-up-prefetch",
] as const
export type BenchAgentRetrievalStrategy =
  (typeof BENCH_AGENT_RETRIEVAL_STRATEGIES)[number]

export const benchSuiteSchema = z
  .object({
    runner: z.literal("bench"),
    benchmark: z.literal("longmemeval"),
    suite: z.string().min(1),
    corpus: z
      .object({
        name: z.string().min(1),
        path: z.string().min(1),
      })
      .strict(),
    agent: z
      .object({
        model: z.literal("gpt-4o-mini-2024-07-18"),
        adapter: z.literal("codex"),
        systemPrompt: z.string().min(1),
        retrieval: z
          .enum(BENCH_AGENT_RETRIEVAL_STRATEGIES)
          .default("tool-driven"),
      })
      .strict(),
    judge: z
      .object({
        model: z.literal("gpt-4o-2024-08-06"),
        recallPrompt: z.string().min(1),
        abstentionPrompt: z.string().min(1),
      })
      .strict(),
    ingestion: z
      .object({
        strategy: z.enum(BENCH_INGESTION_STRATEGIES).default("lore-mine"),
      })
      .strict()
      .default({ strategy: "lore-mine" }),
    caps: z
      .object({
        perExampleWrites: z.number().int().positive().default(500),
        perSuiteWrites: z.number().int().positive().default(250_000),
      })
      .strict()
      .default({ perExampleWrites: 500, perSuiteWrites: 250_000 }),
    notes: z.string().default(""),
  })
  .strict()

export type BenchSuite = z.infer<typeof benchSuiteSchema>

export interface LoadedBenchSuite {
  suite: BenchSuite
  path: string
  root: string
}

export async function loadBenchSuite(path: string): Promise<LoadedBenchSuite> {
  const absolute = resolve(path)
  const raw = await readFile(absolute, "utf-8")
  const parsed = parseEvalYaml(raw, absolute)
  return {
    suite: benchSuiteSchema.parse(parsed),
    path: absolute,
    root: dirname(absolute),
  }
}

/**
 * Cheap discriminator read off the top of a YAML document so the
 * dispatcher can route to the bench vs retrieval/task path before
 * deeper validation. Returns null on parse failure — the caller falls
 * back to the legacy `evalSuiteSchema` parse error path.
 */
export function peekSuiteRunner(raw: string): EvalRunner | null {
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch {
    return null
  }
  const runner = (parsed as { runner?: unknown })?.runner
  if (typeof runner !== "string") return null
  if ((EVAL_RUNNERS as readonly string[]).includes(runner)) {
    return runner as EvalRunner
  }
  return null
}

export type EvalSuite = z.infer<typeof evalSuiteSchema>
export type EvalTask = EvalSuite["tasks"][number]
export type EvalMemoryScenario = z.infer<typeof evalMemoryScenarioSchema>
export type EvalFixtureMemory = EvalMemoryScenario["memories"][number]
export type RetrievalExpectation = z.infer<typeof retrievalExpectationSchema>

export interface LoadedEvalSuite {
  suite: EvalSuite
  path: string
  root: string
  scenarioFixtures: Map<string, EvalMemoryScenario>
}

export async function loadEvalSuite(path: string): Promise<LoadedEvalSuite> {
  const absolute = resolve(path)
  const raw = await readFile(absolute, "utf-8")
  const parsed = parseEvalYaml(raw, absolute)
  const loaded = {
    suite: evalSuiteSchema.parse(parsed),
    path: absolute,
    root: dirname(absolute),
    scenarioFixtures: new Map<string, EvalMemoryScenario>(),
  }
  await validateEvalSuiteFixtures(loaded)
  return loaded
}

export async function loadEvalMemoryScenario(path: string): Promise<EvalMemoryScenario> {
  const absolute = resolve(path)
  const raw = await readFile(absolute, "utf-8")
  const parsed = parseEvalYaml(raw, absolute)
  return evalMemoryScenarioSchema.parse(parsed)
}

function parseEvalYaml(raw: string, path: string): unknown {
  try {
    return parseYaml(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not parse YAML in ${path}: ${message}`, { cause: err })
  }
}

async function validateEvalSuiteFixtures(loaded: LoadedEvalSuite): Promise<void> {
  for (const task of loaded.suite.tasks) {
    for (const [id, relativePath] of Object.entries(task.memoryScenarios)) {
      const scenarioPath = resolve(loaded.root, relativePath)
      let fixture = loaded.scenarioFixtures.get(scenarioPath)
      if (!fixture) {
        fixture = await loadEvalMemoryScenario(scenarioPath)
        loaded.scenarioFixtures.set(scenarioPath, fixture)
      }
      if (fixture.name !== id) {
        throw new Error(
          `Task "${task.id}" scenario "${id}" points at fixture named "${fixture.name}" in ${scenarioPath}`
        )
      }
    }
  }
}
