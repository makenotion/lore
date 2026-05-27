import { describe, expect, it } from "vitest"
import type {
  LongitudinalTaskArtifact,
  LongitudinalTaskCondition,
} from "./task-runner/schema.js"
import { buildLongitudinalBenchmarkPlan } from "./longitudinal-plan.js"

describe("buildLongitudinalBenchmarkPlan", () => {
  it("uses seeded-lore by default and estimates paired sample size from harm", () => {
    const plan = buildLongitudinalBenchmarkPlan(
      artifact([
        ["one", false, true, false],
        ["two", true, false, true],
        ["three", true, true, true],
        ["four", false, false, false],
      ])
    )

    expect(plan.toCondition).toBe("seeded-lore")
    expect(plan.pairedOutcomes).toMatchObject({
      pairs: 4,
      lifted: 1,
      harmed: 1,
      bothPassed: 1,
      bothFailed: 1,
      observedLift: 0,
      observedDiscordance: 0.5,
    })
    expect(plan.assumedHarmRate).toBe(0.25)
    expect(plan.efficiency.pairedDeltas).toMatchObject({
      pairs: 4,
      tokenPairs: 4,
      meanPrimaryTokenDelta: -200,
      meanPrimaryTokenDeltaPct: -0.2,
      elapsedPairs: 4,
      meanElapsedMsDelta: -1000,
      meanElapsedDeltaPct: -0.1,
    })
    expect(plan.estimatedPairsRequired).toBeGreaterThan(100)
    expect(plan.conditionRunsRequired).toBe(plan.estimatedPairsRequired * 3)
    expect(plan.budgetUsd).toBe(1000)
    expect(plan.projectedCostUsd).toBeGreaterThan(0)
  })

  it("projects cost when the caller supplies per-condition-run cost", () => {
    const plan = buildLongitudinalBenchmarkPlan(artifact([["one", false, true, true]]), {
      costPerConditionRunUsd: 2,
      conditionsPerScenario: 2,
      budgetUsd: 200,
    })

    expect(plan.conditionRunsRequired).toBe(plan.estimatedPairsRequired * 2)
    expect(plan.projectedCostUsd).toBe(plan.conditionRunsRequired * 2)
    expect(plan.maxPairsAtBudget).toBe(50)
  })

  it("does not project measured cost from partial cost coverage", () => {
    const input = artifact([["one", false, true, true]])
    const phase = input.results[0]!.phases[0]!
    phase.agentRun = { exitCode: 0, stdout: "", stderr: "", timedOut: false }
    phase.cost = null

    const measured = buildLongitudinalBenchmarkPlan(input)
    const override = buildLongitudinalBenchmarkPlan(input, {
      costPerConditionRunUsd: 2,
      budgetUsd: 200,
    })

    expect(measured.measuredCostConditionRuns).toBe(2)
    expect(measured.totalCostConditionRuns).toBe(3)
    expect(measured.measuredCostCoverage).toBe(2 / 3)
    expect(measured.measuredCostUsd).toBeNull()
    expect(measured.projectedCostUsd).toBeNull()
    expect(override.projectedCostUsd).toBe(override.conditionRunsRequired * 2)
  })

  it("falls back to lore-full-loop when seeded-lore did not run", () => {
    const input = artifact([["one", false, false, true]])
    input.summary.conditions["seeded-lore"].trials = 0

    const plan = buildLongitudinalBenchmarkPlan(input)

    expect(plan.toCondition).toBe("lore-full-loop")
    expect(plan.pairedOutcomes.lifted).toBe(1)
  })
})

function artifact(
  rows: Array<
    [
      scenarioId: string,
      noMemorySuccess: boolean,
      seededLoreSuccess: boolean,
      fullLoopSuccess: boolean,
    ]
  >
): LongitudinalTaskArtifact {
  const results = rows.flatMap(
    ([scenarioId, noMemorySuccess, seededLoreSuccess, fullLoopSuccess]) => {
      const conditionRows: Array<[LongitudinalTaskCondition, boolean]> = [
        ["no-memory", noMemorySuccess],
        ["seeded-lore", seededLoreSuccess],
        ["lore-full-loop", fullLoopSuccess],
      ]
      return conditionRows.map(([condition, success]) => ({
        taskId: scenarioId,
        scenarioId,
        condition,
        memoryCondition: null,
        agent: "codex",
        workspaceSource: "fixture",
        workspaceMaterialization: { kind: "local", source: "fixture" },
        workspace: null,
        success,
        failureReason: success ? null : "verifiers",
        agentRun: null,
        verifiers: [],
        phases: [phaseForCondition(condition)],
        expectedContextDescription: "",
      }))
    }
  ) as LongitudinalTaskArtifact["results"]
  const conditions = {
    "no-memory": conditionSummary(rows.map((row) => row[1])),
    "seeded-lore": conditionSummary(rows.map((row) => row[2])),
    "lore-full-loop": conditionSummary(rows.map((row) => row[3])),
  }
  return {
    suite: "pilot",
    description: "",
    startedAt: "2026-05-26T00:00:00.000Z",
    runner: { mode: "task", kind: "longitudinal" },
    termination: null,
    results,
    summary: {
      tasks: rows.length,
      passedTasks: 0,
      failedTasks: rows.length,
      totalTrials: results.length,
      passedTrials: results.filter((result) => result.success).length,
      failedTrials: results.filter((result) => !result.success).length,
      conditions,
      lift: {
        fromCondition: "no-memory",
        toCondition: "seeded-lore",
        successRateDelta: null,
        liftedScenarioIds: [],
        harmedScenarioIds: [],
      },
      lifts: {},
    },
  }
}

function phaseForCondition(
  condition: LongitudinalTaskCondition
): LongitudinalTaskArtifact["results"][number]["phases"][number] {
  const metrics = {
    "no-memory": { tokens: 1000, elapsedMs: 10_000, usd: 0.1 },
    "seeded-lore": { tokens: 800, elapsedMs: 9_000, usd: 0.08 },
    "lore-full-loop": { tokens: 1200, elapsedMs: 11_000, usd: 0.12 },
  }[condition]
  return {
    phase: "use",
    promptId: `${condition}-use`,
    workspace: null,
    startedAt: "2026-05-26T00:00:00.000Z",
    finishedAt: "2026-05-26T00:00:01.000Z",
    success: true,
    agentRun: null,
    verifierResults: [],
    patchStats: { filesChanged: 0, linesAdded: 0, linesRemoved: 0 },
    lore: {
      hooksEnabled: condition === "lore-full-loop",
      wakeUpEnabled: condition !== "no-memory",
      memoriesCreated: 0,
      factsCreated: 0,
      decisionsCreated: 0,
      tasksCreated: 0,
      expectedContextIds: [],
      surfacedContextIds: [],
      harmfulContextIds: [],
    },
    cost: {
      provider: "openai",
      model: "gpt-5.5",
      promptTokens: metrics.tokens,
      cachedPromptTokens: 0,
      completionTokens: 0,
      reasoningOutputTokens: 0,
      totalUsd: metrics.usd,
      pricingSource: "test",
      costUnknownReason: null,
    },
    elapsedMs: metrics.elapsedMs,
    failureReason: null,
    failureMessage: null,
  }
}

function conditionSummary(
  successes: boolean[]
): LongitudinalTaskArtifact["summary"]["conditions"]["no-memory"] {
  const passed = successes.filter(Boolean).length
  return {
    trials: successes.length,
    passed,
    failed: successes.length - passed,
    successRate: successes.length === 0 ? 0 : passed / successes.length,
  }
}
