import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { runEvalSuite, type EvalRunArtifact } from "./runner.js"

describe("runEvalSuite", () => {
  it("runs the starter retrieval suite and writes a JSON artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-eval-"))
    const outPath = join(dir, "result.json")

    const { artifact, outPath: writtenPath } = await runEvalSuite(
      "evals/suites/lore-core.yaml",
      {
        outPath,
        now: new Date("2026-05-03T12:00:00.000Z"),
      }
    )

    expect(writtenPath).toBe(outPath)
    expect(artifact.summary).toMatchObject({
      tasks: 1,
      trials: 1,
      totalResults: 4,
      passedResults: 4,
      failedResults: 0,
    })
    expect(artifact.runner).toMatchObject({
      mode: "retrieval",
      surface: "wake-up.taskMemories",
      requestedTrials: 1,
      executedTrials: 1,
    })
    expect(artifact.summary.retrieval.memoryLift).toBe(1)
    expect(artifact.summary.retrieval.memoryHarm).toBe(0)

    const persisted = JSON.parse(await readFile(outPath, "utf-8")) as EvalRunArtifact
    expect(persisted.startedAt).toBe("2026-05-03T12:00:00.000Z")
    expect(
      persisted.results.find((result) => result.scenario === "helpful-memory")
    ).toMatchObject({
      expectedMemoriesSurfaced: ["decision/auth-model"],
      missingExpectedMemories: [],
    })
  })

  it("rejects trial overrides for deterministic retrieval mode", async () => {
    await expect(
      runEvalSuite("evals/suites/lore-core.yaml", {
        trials: 3,
      })
    ).rejects.toThrow("requires trials to be 1")
  })

  it("flags missing expected memories and surfaced forbidden memories", async () => {
    const { suitePath, outPath } = await writeTempEvalSuite({
      fixtures: {
        "no-lore.yaml": emptyScenario("no-lore"),
        "empty.yaml": emptyScenario("empty-lore"),
        "helpful.yaml": `name: helpful-memory
memories:
  - id: decision/expected
    title: Zeta orchard policy
    synopsis: Legacy context only.
  - id: note/billing-danger
    title: Billing token implementation note
    synopsis: A tempting but unrelated billing token path.
`,
      },
      suite: `version: 1
name: failure-suite
runner: retrieval
tasks:
  - id: fails-when-expected-memory-is-missing
    prompt: Implement the billing token flow.
    memoryScenarios:
      no-lore: ../memory/no-lore.yaml
      empty-lore: ../memory/empty.yaml
      helpful-memory: ../memory/helpful.yaml
    expectedRetrieval:
      helpful-memory:
        shouldSurface:
          - decision/expected
        shouldNotSurface:
          - note/billing-danger
`,
    })

    const { artifact } = await runEvalSuite(suitePath, { outPath })

    expect(artifact.summary.failedResults).toBe(1)
    expect(
      artifact.results.find((result) => result.scenario === "helpful-memory")
    ).toMatchObject({
      success: false,
      missingExpectedMemories: ["decision/expected"],
      unexpectedMemoriesSurfaced: ["note/billing-danger"],
    })
  })

  it("reports zero lift when the noisy baseline also surfaces the expected memory", async () => {
    const { suitePath, outPath } = await writeTempEvalSuite({
      fixtures: {
        "no-lore.yaml": emptyScenario("no-lore"),
        "empty.yaml": emptyScenario("empty-lore"),
        "noisy.yaml": authDecisionScenario("noisy-memory"),
        "helpful.yaml": authDecisionScenario("helpful-memory"),
      },
      suite: `version: 1
name: zero-lift-suite
runner: retrieval
tasks:
  - id: noisy-baseline-finds-same-memory
    prompt: Follow the auth model decision.
    memoryScenarios:
      no-lore: ../memory/no-lore.yaml
      empty-lore: ../memory/empty.yaml
      noisy-memory: ../memory/noisy.yaml
      helpful-memory: ../memory/helpful.yaml
    expectedRetrieval:
      helpful-memory:
        shouldSurface:
          - decision/auth-model
`,
    })

    const { artifact } = await runEvalSuite(suitePath, { outPath })

    expect(artifact.summary.retrieval.memoryLift).toBe(0)
  })

  it("reports harm when noisy memory surfaces forbidden guidance", async () => {
    const { suitePath, outPath } = await writeTempEvalSuite({
      fixtures: {
        "no-lore.yaml": emptyScenario("no-lore"),
        "empty.yaml": emptyScenario("empty-lore"),
        "noisy.yaml": `name: noisy-memory
memories:
  - id: note/deprecated-auth
    title: Deprecated auth path
    synopsis: Use the retired auth path.
`,
        "helpful.yaml": authDecisionScenario("helpful-memory"),
      },
      suite: `version: 1
name: harm-suite
runner: retrieval
tasks:
  - id: noisy-memory-harms-task
    prompt: Follow the auth path decision.
    memoryScenarios:
      no-lore: ../memory/no-lore.yaml
      empty-lore: ../memory/empty.yaml
      noisy-memory: ../memory/noisy.yaml
      helpful-memory: ../memory/helpful.yaml
    expectedRetrieval:
      noisy-memory:
        shouldNotSurface:
          - note/deprecated-auth
      helpful-memory:
        shouldSurface:
          - decision/auth-model
`,
    })

    const { artifact } = await runEvalSuite(suitePath, { outPath })

    expect(artifact.summary.retrieval.memoryHarm).toBe(1)
    expect(
      artifact.results.find((result) => result.scenario === "noisy-memory")
    ).toMatchObject({
      success: false,
      unexpectedMemoriesSurfaced: ["note/deprecated-auth"],
    })
  })
})

async function writeTempEvalSuite(input: {
  suite: string
  fixtures: Record<string, string>
}): Promise<{ suitePath: string; outPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "lore-eval-"))
  const suitesDir = join(dir, "suites")
  const memoryDir = join(dir, "memory")
  await mkdir(suitesDir, { recursive: true })
  await mkdir(memoryDir, { recursive: true })

  for (const [name, contents] of Object.entries(input.fixtures)) {
    await writeFile(join(memoryDir, name), contents)
  }

  const suitePath = join(suitesDir, "suite.yaml")
  await writeFile(suitePath, input.suite)
  return { suitePath, outPath: join(dir, "result.json") }
}

function emptyScenario(name: string): string {
  return `name: ${name}
memories: []
`
}

function authDecisionScenario(name: string): string {
  return `name: ${name}
memories:
  - id: decision/auth-model
    title: Auth model decision
    synopsis: Follow the auth path decision.
    keywords: auth path decision
`
}
