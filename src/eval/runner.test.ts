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
      tasks: 3,
      trials: 1,
      totalResults: 15,
      passedResults: 15,
      failedResults: 0,
    })
    expect(artifact.summary.scenarios).toEqual([
      "empty-lore",
      "helpful-memory",
      "no-lore",
      "noisy-memory",
      "stale-memory",
    ])
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
      persisted.results.find(
        (result) =>
          result.taskId === "respects-governing-auth-decision" &&
          result.scenario === "helpful-memory"
      )
    ).toMatchObject({
      expectedMemoriesSurfaced: ["decision/auth-model"],
      missingExpectedMemories: [],
    })
    expect(
      persisted.results.find(
        (result) =>
          result.taskId === "respects-governing-auth-decision" &&
          result.scenario === "stale-memory"
      )
    ).toMatchObject({
      success: true,
      missingExpectedMemories: [],
      unexpectedMemoriesSurfaced: [],
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

  it("counts stale-memory in the harm aggregation when stale guidance surfaces", async () => {
    const { suitePath, outPath } = await writeTempEvalSuite({
      fixtures: {
        "no-lore.yaml": emptyScenario("no-lore"),
        "empty.yaml": emptyScenario("empty-lore"),
        "stale.yaml": `name: stale-memory
memories:
  # Status is intentionally not 'superseded' here so the fixture runner's
  # status filter does not drop it; the test pins that taskMemoryHarm
  # aggregates the stale-memory scenario, not that status filtering works.
  - id: decision/auth-jwt-pre-filter
    title: Bearer JWT auth path
    synopsis: Earlier auth path; tokens may still match a query.
    keywords: auth path bearer
`,
        "helpful.yaml": authDecisionScenario("helpful-memory"),
      },
      suite: `version: 1
name: stale-harm-suite
runner: retrieval
tasks:
  - id: stale-memory-harms-task
    prompt: Follow the auth path decision.
    memoryScenarios:
      no-lore: ../memory/no-lore.yaml
      empty-lore: ../memory/empty.yaml
      stale-memory: ../memory/stale.yaml
      helpful-memory: ../memory/helpful.yaml
    expectedRetrieval:
      stale-memory:
        shouldNotSurface:
          - decision/auth-jwt-pre-filter
      helpful-memory:
        shouldSurface:
          - decision/auth-model
`,
    })

    const { artifact } = await runEvalSuite(suitePath, { outPath })

    expect(artifact.summary.retrieval.memoryHarm).toBe(1)
    expect(
      artifact.results.find((result) => result.scenario === "stale-memory")
    ).toMatchObject({
      success: false,
      unexpectedMemoriesSurfaced: ["decision/auth-jwt-pre-filter"],
    })
  })

  it("suppresses superseded rows from fixture retrieval", async () => {
    const { suitePath, outPath } = await writeTempEvalSuite({
      fixtures: {
        "no-lore.yaml": emptyScenario("no-lore"),
        "empty.yaml": emptyScenario("empty-lore"),
        "stale.yaml": `name: stale-memory
memories:
  - id: decision/superseded-row
    title: Auth path decision
    status: superseded
    synopsis: Superseded; should be suppressed by the status filter.
    keywords: auth path decision
`,
        "helpful.yaml": authDecisionScenario("helpful-memory"),
      },
      suite: `version: 1
name: status-filter-suite
runner: retrieval
tasks:
  - id: status-filter-suppresses-superseded
    prompt: Follow the auth path decision.
    memoryScenarios:
      no-lore: ../memory/no-lore.yaml
      empty-lore: ../memory/empty.yaml
      stale-memory: ../memory/stale.yaml
      helpful-memory: ../memory/helpful.yaml
    expectedRetrieval:
      stale-memory:
        shouldNotSurface:
          - decision/superseded-row
      helpful-memory:
        shouldSurface:
          - decision/auth-model
`,
    })

    const { artifact } = await runEvalSuite(suitePath, { outPath })

    expect(artifact.summary.retrieval.memoryHarm).toBe(0)
    const stale = artifact.results.find((r) => r.scenario === "stale-memory")!
    expect(stale.success).toBe(true)
    expect(stale.surfacedMemoryIds).toEqual([])
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
