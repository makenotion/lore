import { afterEach, describe, expect, it } from "vitest"
import {
  assertSandboxProjectName,
  collectEvalThresholdFailures,
  parseEvalRunCliOptions,
  validateBaselineRunnerSupport,
} from "./eval.js"
import type { EvalRunArtifact } from "../../eval/runner.js"

describe("parseEvalRunCliOptions", () => {
  it("leaves runner undefined when --runner is not passed (suite YAML wins)", () => {
    const result = parseEvalRunCliOptions({})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.runner).toBeUndefined()
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

  it("rejects non-one trial counts when --runner is implicit", () => {
    const result = parseEvalRunCliOptions({ trials: "2" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("this runner")
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

  it.each([
    { flag: "baseline", value: "evals/baselines/x.json" },
    { flag: "minLift", value: "0.5" },
    { flag: "maxHarm", value: "0" },
    { flag: "project", value: "Mail" },
  ])("rejects --$flag with --runner task ($flag)", ({ flag, value }) => {
    const result = parseEvalRunCliOptions({
      runner: "task",
      [flag]: value,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("not supported with --runner task")
    }
  })

  it("requires --project when --runner notion is set", () => {
    const result = parseEvalRunCliOptions({ runner: "notion" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("--project")
    }
  })

  it("accepts --runner notion when --project is provided", () => {
    const result = parseEvalRunCliOptions({
      runner: "notion",
      project: "Mail",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.runner).toBe("notion")
      expect(result.value.projectName).toBe("Mail")
    }
  })

  it("phrases the trials error in terms of the selected runner", () => {
    const result = parseEvalRunCliOptions({ runner: "notion", trials: "3" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("notion mode")
      expect(result.message).not.toContain("retrieval mode")
    }
  })
})

describe("assertSandboxProjectName", () => {
  const original = process.env["LORE_EVAL_NOTION_ALLOW_PRODUCTION"]
  afterEach(() => {
    if (original === undefined) {
      delete process.env["LORE_EVAL_NOTION_ALLOW_PRODUCTION"]
    } else {
      process.env["LORE_EVAL_NOTION_ALLOW_PRODUCTION"] = original
    }
  })

  it.each([
    "Mail-sandbox",
    "Eval-Project",
    "Test-Vault",
    "scratch",
    "Mail-staging",
    "dev-vault",
    "Playground",
  ])("accepts sandbox-shaped project names like %s", (name) => {
    delete process.env["LORE_EVAL_NOTION_ALLOW_PRODUCTION"]
    expect(() => assertSandboxProjectName(name)).not.toThrow()
  })

  it.each([
    "Mail",
    "Greatest hits",
    "Latest releases",
    "Evaluation Q1",
    "EvalProject", // no word boundary between Eval/Project — embedded substring
  ])("rejects production-shaped project names like %s", (name) => {
    delete process.env["LORE_EVAL_NOTION_ALLOW_PRODUCTION"]
    expect(() => assertSandboxProjectName(name)).toThrow(
      /LORE_EVAL_NOTION_ALLOW_PRODUCTION=1/
    )
  })

  it("allows production-shaped names when LORE_EVAL_NOTION_ALLOW_PRODUCTION=1", () => {
    process.env["LORE_EVAL_NOTION_ALLOW_PRODUCTION"] = "1"
    expect(() => assertSandboxProjectName("Mail")).not.toThrow()
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

describe("validateBaselineRunnerSupport", () => {
  it("rejects --runner task with an actionable operator message", () => {
    const result = validateBaselineRunnerSupport("task")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("--runner task is not supported")
      expect(result.message).toContain("baseline subcommand")
    }
  })

  it("accepts retrieval and notion runners", () => {
    expect(validateBaselineRunnerSupport("retrieval").ok).toBe(true)
    expect(validateBaselineRunnerSupport("notion").ok).toBe(true)
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
