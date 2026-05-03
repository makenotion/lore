import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { evalSuiteSchema, loadEvalSuite } from "./schema.js"

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
