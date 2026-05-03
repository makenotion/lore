import { describe, expect, it } from "vitest"
import { collectEvalThresholdFailures, parseEvalRunCliOptions } from "./eval.js"
import type { EvalRunArtifact } from "../../eval/runner.js"

describe("parseEvalRunCliOptions", () => {
  it("defaults to the retrieval runner", () => {
    const result = parseEvalRunCliOptions({})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.runner).toBe("retrieval")
      expect(result.value.json).toBe(false)
    }
  })

  it("rejects unsupported runner modes", () => {
    const result = parseEvalRunCliOptions({ runner: "agent" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("--runner")
  })

  it("strictly parses the trial count", () => {
    const result = parseEvalRunCliOptions({ trials: "2.5" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("--trials")
  })

  it("rejects non-one retrieval trial counts", () => {
    const result = parseEvalRunCliOptions({ trials: "2" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("retrieval mode")
  })

  it("parses metric thresholds", () => {
    const result = parseEvalRunCliOptions({ minLift: "0.5", maxHarm: "0.0" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.minLift).toBe(0.5)
      expect(result.value.maxHarm).toBe(0)
    }
  })

  it("rejects thresholds outside the unit interval", () => {
    const result = parseEvalRunCliOptions({ minLift: "1.5" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("--min-lift")
  })

  it("threads --baseline through into baselinePath", () => {
    const result = parseEvalRunCliOptions({
      baseline: "evals/baselines/lore-core.json",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.baselinePath).toBe("evals/baselines/lore-core.json")
    }
  })
})

describe("collectEvalThresholdFailures", () => {
  it("fails when lift is too low or harm is too high", () => {
    const failures = collectEvalThresholdFailures(
      evalArtifact({ memoryLift: 0.4, memoryHarm: 0.2 }),
      { minLift: 0.5, maxHarm: 0 }
    )

    expect(failures).toEqual([
      "Memory lift 0.4 is below 0.5.",
      "Memory harm 0.2 exceeds 0.",
    ])
  })

  it("fails when a requested metric is unavailable", () => {
    const failures = collectEvalThresholdFailures(
      evalArtifact({ memoryLift: null, memoryHarm: null }),
      { minLift: 0.5, maxHarm: 0 }
    )

    expect(failures).toEqual([
      "Memory lift is unavailable; expected >= 0.5.",
      "Memory harm is unavailable; expected <= 0.",
    ])
  })
})

function evalArtifact(input: {
  memoryLift: number | null
  memoryHarm: number | null
}): EvalRunArtifact {
  return {
    suite: "test-suite",
    description: "",
    startedAt: "2026-05-03T12:00:00.000Z",
    runner: {
      mode: "retrieval",
      surfaces: ["wake-up.taskMemories"],
      requestedTrials: 1,
      executedTrials: 1,
    },
    results: [],
    summary: {
      tasks: 1,
      scenarios: [],
      trials: 1,
      totalResults: 0,
      passedResults: 0,
      failedResults: 0,
      retrieval: {
        averageRecall: null,
        averagePrecision: null,
        memoryLift: input.memoryLift,
        memoryHarm: input.memoryHarm,
      },
    },
  }
}
