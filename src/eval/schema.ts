import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import { z } from "zod"

export const EVAL_SUITE_VERSION = 1

export const EVAL_RUNNERS = ["retrieval"] as const

export const REQUIRED_ABLATION_SCENARIOS = [
  "no-lore",
  "empty-lore",
  "helpful-memory",
] as const

export type EvalRunner = (typeof EVAL_RUNNERS)[number]
export type RequiredAblationScenario = (typeof REQUIRED_ABLATION_SCENARIOS)[number]

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
    prompt: z.string().min(1),
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
          })
          .strict()
      )
      .default([]),
  })
  .strict()

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
