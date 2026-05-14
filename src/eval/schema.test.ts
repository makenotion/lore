import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  benchSuiteSchema,
  evalSuiteSchema,
  loadBenchSuite,
  loadEvalSuite,
  loadProfileEvalSuite,
  profileEvalSuiteSchema,
} from "./schema.js"

const BENCH_BASE = {
  runner: "bench",
  benchmark: "longmemeval",
  suite: "longmemeval-test",
  corpus: {
    name: "longmemeval_s_cleaned",
    path: "evals/bench-corpora/longmemeval/longmemeval_s_cleaned.json",
  },
  agent: {
    model: "gpt-4o-mini-2024-07-18",
    adapter: "codex",
    systemPrompt: "evals/prompts/longmemeval-agent-system-wake-up.txt",
    retrieval: "wake-up-prefetch",
  },
  judge: {
    model: "gpt-4o-2024-08-06",
    recallPrompt: "evals/prompts/longmemeval-judge.txt",
    abstentionPrompt: "evals/prompts/longmemeval-judge-abstention.txt",
  },
} as const

describe("eval suite schema", () => {
  it("validates the committed starter suite", async () => {
    const loaded = await loadEvalSuite("evals/suites/lore-core.yaml")
    expect(loaded.suite.name).toBe("lore-core")
    expect(loaded.suite.tasks[0]?.memoryScenarios).toMatchObject({
      "no-lore": "../memory/no-lore.yaml",
      "empty-lore": "../memory/empty.yaml",
      "noisy-memory": "../memory/noisy.yaml",
      "helpful-memory": "../memory/auth-decision.yaml",
    })
  })

  it("requires the baseline ablation scenarios on every task", () => {
    const result = evalSuiteSchema.safeParse({
      version: 1,
      name: "missing-ablations",
      tasks: [
        {
          id: "task-one",
          prompt: "Do the task",
          memoryScenarios: {
            "helpful-memory": "../memory/helpful.yaml",
          },
          expectedRetrieval: {
            "helpful-memory": {
              shouldSurface: ["memory/helpful"],
            },
          },
        },
      ],
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        'required ablation scenario "no-lore" is missing'
      )
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        'required ablation scenario "empty-lore" is missing'
      )
    }
  })

  it("requires the current suite version", () => {
    const result = evalSuiteSchema.safeParse({
      version: 2,
      name: "future-suite",
      tasks: [
        {
          id: "task-one",
          prompt: "Do the task",
          memoryScenarios: {
            "no-lore": "../memory/no-lore.yaml",
            "empty-lore": "../memory/empty.yaml",
            "helpful-memory": "../memory/helpful.yaml",
          },
          expectedRetrieval: {
            "helpful-memory": {
              shouldSurface: ["memory/helpful"],
            },
          },
        },
      ],
    })

    expect(result.success).toBe(false)
  })

  it("validates scenario fixture names while loading the suite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-eval-schema-"))
    const suitesDir = join(dir, "suites")
    const memoryDir = join(dir, "memory")
    await mkdir(suitesDir, { recursive: true })
    await mkdir(memoryDir, { recursive: true })

    await writeFile(join(memoryDir, "no-lore.yaml"), "name: no-lore\nmemories: []\n")
    await writeFile(join(memoryDir, "empty.yaml"), "name: empty-lore\nmemories: []\n")
    await writeFile(
      join(memoryDir, "helpful.yaml"),
      "name: wrong-scenario\nmemories: []\n"
    )
    const suitePath = join(suitesDir, "suite.yaml")
    await writeFile(
      suitePath,
      `version: 1
name: mismatch-suite
tasks:
  - id: task-one
    prompt: Do the task
    memoryScenarios:
      no-lore: ../memory/no-lore.yaml
      empty-lore: ../memory/empty.yaml
      helpful-memory: ../memory/helpful.yaml
    expectedRetrieval:
      helpful-memory:
        shouldSurface:
          - memory/helpful
`
    )

    await expect(loadEvalSuite(suitePath)).rejects.toThrow(
      'scenario "helpful-memory" points at fixture named "wrong-scenario"'
    )
  })

  it("rejects expected retrieval keys that are not scenarios", () => {
    const result = evalSuiteSchema.safeParse({
      version: 1,
      name: "typo-suite",
      tasks: [
        {
          id: "task-one",
          prompt: "Do the task",
          memoryScenarios: {
            "no-lore": "../memory/no-lore.yaml",
            "empty-lore": "../memory/empty.yaml",
            "helpful-memory": "../memory/helpful.yaml",
          },
          expectedRetrieval: {
            "helpful-memroy": {
              shouldSurface: ["memory/helpful"],
            },
          },
        },
      ],
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        'expected retrieval scenario "helpful-memroy" is not defined in memoryScenarios'
      )
    }
  })

  it("requires helpful-memory to surface at least one expected memory", () => {
    const result = evalSuiteSchema.safeParse({
      version: 1,
      name: "no-signal-suite",
      tasks: [
        {
          id: "task-one",
          prompt: "Do the task",
          memoryScenarios: {
            "no-lore": "../memory/no-lore.yaml",
            "empty-lore": "../memory/empty.yaml",
            "helpful-memory": "../memory/helpful.yaml",
          },
        },
      ],
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        "retrieval tasks must define expectedRetrieval.helpful-memory.shouldSurface"
      )
    }
  })

  it("accepts the supported runner modes and rejects unknown ones", () => {
    const baseTask = {
      id: "task-one",
      prompt: "Do the task",
      memoryScenarios: {
        "no-lore": "../memory/no-lore.yaml",
        "empty-lore": "../memory/empty.yaml",
        "helpful-memory": "../memory/helpful.yaml",
      },
      expectedRetrieval: {
        "helpful-memory": { shouldSurface: ["memory/helpful"] },
      },
    }

    for (const runner of ["retrieval", "notion"]) {
      const result = evalSuiteSchema.safeParse({
        version: 1,
        name: "runner-modes",
        runner,
        tasks: [baseTask],
      })
      expect(result.success, `runner=${runner} should parse`).toBe(true)
    }

    const rejected = evalSuiteSchema.safeParse({
      version: 1,
      name: "runner-modes",
      runner: "live-agent",
      tasks: [baseTask],
    })
    expect(rejected.success).toBe(false)
  })
})

describe("bench suite schema ingestion extraction fields", () => {
  it("validates the committed simulated-autosave suite", async () => {
    const loaded = await loadBenchSuite(
      "evals/bench-suites/longmemeval-simulated-autosave.yaml"
    )
    expect(loaded.suite.ingestion.strategy).toBe("simulated-autosave")
    expect(loaded.suite.agent.retrieval).toBe("wake-up-prefetch")
  })

  it("validates the committed support simulated-autosave profile suite", async () => {
    const loaded = await loadBenchSuite(
      "evals/bench-suites/support-simulated-autosave.yaml"
    )
    expect(loaded.suite.profile?.selector).toBe("support@1.0.0")
    expect(loaded.suite.ingestion.strategy).toBe("simulated-autosave")
  })

  it("accepts simulated-autosave with required extraction fields", () => {
    const parsed = benchSuiteSchema.parse({
      ...BENCH_BASE,
      ingestion: {
        strategy: "simulated-autosave",
        extractionPrompt: "evals/prompts/longmemeval-ingest-extract.txt",
        extractionModel: "gpt-4o-mini-2024-07-18",
        extractionMaxTokens: 1000,
      },
    })
    expect(parsed.ingestion.strategy).toBe("simulated-autosave")
  })

  it("accepts optional profile metadata on bench suites", () => {
    const parsed = benchSuiteSchema.parse({
      ...BENCH_BASE,
      profile: { selector: "support@1.0.0" },
      ingestion: {
        strategy: "simulated-autosave",
        extractionPrompt: "profiles/support/prompts/longmemeval-ingest-extract.txt",
        extractionModel: "gpt-4o-mini-2024-07-18",
        extractionMaxTokens: 1000,
      },
    })
    expect(parsed.profile?.selector).toBe("support@1.0.0")
  })

  it("rejects simulated-autosave when extraction fields are missing", () => {
    const result = benchSuiteSchema.safeParse({
      ...BENCH_BASE,
      ingestion: {
        strategy: "simulated-autosave",
      },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(
        expect.arrayContaining([
          "ingestion.extractionPrompt",
          "ingestion.extractionModel",
          "ingestion.extractionMaxTokens",
        ])
      )
    }
  })

  it("rejects extraction fields on non-extraction strategies", () => {
    for (const strategy of ["lore-mine", "raw-transcript"]) {
      const result = benchSuiteSchema.safeParse({
        ...BENCH_BASE,
        ingestion: {
          strategy,
          extractionPrompt: "evals/prompts/longmemeval-ingest-extract.txt",
          extractionModel: "gpt-4o-mini-2024-07-18",
          extractionMaxTokens: 1000,
        },
      })
      expect(result.success, `strategy=${strategy}`).toBe(false)
    }
  })
})

describe("profile eval suite schema", () => {
  it("validates the committed support profile suite", async () => {
    const loaded = await loadProfileEvalSuite("evals/profile-suites/support.yaml")
    expect(loaded.suite.runner).toBe("profile")
    expect(loaded.suite.profile).toBe("support@1.0.0")
    expect(loaded.suite.cases[0]?.id).toBe("api-timeout-escalation")
  })

  it("requires exact profile selectors", () => {
    const result = profileEvalSuiteSchema.safeParse({
      version: 1,
      runner: "profile",
      suite: "support-profile",
      profile: "support",
      thresholds: {
        entityKindRecallMin: 0.8,
        predicatePrecisionMin: 0.85,
        hallucinatedFactRateMax: 0.05,
        requiredFieldCompletenessMin: 0.9,
        invalidTaxonomyRateMax: 0,
      },
      cases: [
        {
          id: "case-one",
          expected: { memories: [] },
          actual: { memories: [] },
        },
      ],
    })

    expect(result.success).toBe(false)
  })
})
