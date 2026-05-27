import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  assertSandboxProjectName,
  collectEvalThresholdFailures,
  evalCommand,
  formatTaskProgressEvent,
  hasLongitudinalTaskGateFailures,
  parseEvalRunCliOptions,
  validateBaselineRunnerSupport,
  validateEvalRunRunnerCompatibility,
} from "./eval.js"
import type { EvalRunArtifact } from "../../eval/runner.js"
import type { LongitudinalTaskArtifact } from "../../eval/task-runner.js"
import { runBenchCleanupOrphans } from "../../eval/bench-cleanup.js"
import { trapProcessExit } from "../test-helpers.js"

vi.mock("../../eval/bench-cleanup.js", () => ({
  runBenchCleanupOrphans: vi.fn(),
}))

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

  it("parses the task cost kill-switch", () => {
    const result = parseEvalRunCliOptions({
      runner: "task",
      costKillSwitchUsd: "1500",
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.costKillSwitchUsd).toBe(1500)
  })

  it("parses longitudinal segmentation and parallelism flags", () => {
    const result = parseEvalRunCliOptions({
      runner: "task",
      difficulty: "hard",
      scenarioId: ["one", "two"],
      parallel: "4",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.difficulty).toBe("hard")
      expect(result.value.scenarioIds).toEqual(["one", "two"])
      expect(result.value.parallelism).toBe(4)
    }
  })

  it("rejects invalid longitudinal difficulty values", () => {
    const result = parseEvalRunCliOptions({
      runner: "task",
      difficulty: "spicy",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("--difficulty")
  })

  it("rejects a zero cost kill-switch", () => {
    const result = parseEvalRunCliOptions({
      runner: "task",
      costKillSwitchUsd: "0",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("greater than 0")
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
    { flag: "project", value: "Widget" },
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

  it.each([
    { flag: "baseline", value: "evals/baselines/x.json" },
    { flag: "minLift", value: "0.5" },
    { flag: "maxHarm", value: "0" },
    { flag: "project", value: "Widget" },
  ])("rejects --$flag after peeking a YAML-declared task suite", ({ flag, value }) => {
    const parsed = parseEvalRunCliOptions({ [flag]: value })
    expect(parsed.ok).toBe(true)

    const result = validateEvalRunRunnerCompatibility("task", {
      [flag]: value,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("not supported with --runner task")
    }
  })

  it.each([
    { flag: "baseline", value: "evals/baselines/x.json" },
    { flag: "minLift", value: "0.5" },
    { flag: "maxHarm", value: "0" },
    { flag: "project", value: "Widget" },
  ])("rejects --$flag with --runner profile ($flag)", ({ flag, value }) => {
    const result = parseEvalRunCliOptions({
      runner: "profile",
      [flag]: value,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("not supported with --runner profile")
    }
  })

  it.each([
    { flag: "baseline", value: "evals/baselines/x.json" },
    { flag: "minLift", value: "0.5" },
    { flag: "maxHarm", value: "0" },
    { flag: "project", value: "Widget" },
  ])("rejects --$flag after peeking a YAML-declared profile suite", ({ flag, value }) => {
    const parsed = parseEvalRunCliOptions({ [flag]: value })
    expect(parsed.ok).toBe(true)

    const result = validateEvalRunRunnerCompatibility("profile", {
      [flag]: value,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("not supported with --runner profile")
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
      project: "Widget",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.runner).toBe("notion")
      expect(result.value.projectName).toBe("Widget")
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
    "Widget-sandbox",
    "Eval-Project",
    "Test-Vault",
    "scratch",
    "Widget-staging",
    "dev-vault",
    "Playground",
  ])("accepts sandbox-shaped project names like %s", (name) => {
    delete process.env["LORE_EVAL_NOTION_ALLOW_PRODUCTION"]
    expect(() => assertSandboxProjectName(name)).not.toThrow()
  })

  it.each([
    "Widget",
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
    expect(() => assertSandboxProjectName("Widget")).not.toThrow()
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

describe("hasLongitudinalTaskGateFailures", () => {
  it("does not fail the gate for no-memory baseline failures", () => {
    expect(
      hasLongitudinalTaskGateFailures(
        longitudinalArtifact({
          noMemory: { trials: 1, passed: 0, failed: 1 },
          fullLoop: { trials: 1, passed: 1, failed: 0 },
          passedTrials: 1,
          failedTrials: 1,
        })
      )
    ).toBe(false)
  })

  it("fails the gate when lore-full-loop fails", () => {
    expect(
      hasLongitudinalTaskGateFailures(
        longitudinalArtifact({
          noMemory: { trials: 1, passed: 1, failed: 0 },
          fullLoop: { trials: 1, passed: 0, failed: 1 },
          passedTrials: 1,
          failedTrials: 1,
        })
      )
    ).toBe(true)
  })

  it("uses seeded-lore as the primary gate when it ran", () => {
    expect(
      hasLongitudinalTaskGateFailures(
        longitudinalArtifact({
          noMemory: { trials: 1, passed: 1, failed: 0 },
          seededLore: { trials: 1, passed: 0, failed: 1 },
          fullLoop: { trials: 1, passed: 1, failed: 0 },
          passedTrials: 2,
          failedTrials: 1,
        })
      )
    ).toBe(true)
  })

  it("fails the gate when a longitudinal run was stopped by a kill-switch", () => {
    const artifact = longitudinalArtifact({
      noMemory: { trials: 1, passed: 1, failed: 0 },
      fullLoop: { trials: 0, passed: 0, failed: 0 },
      passedTrials: 1,
      failedTrials: 0,
    })
    artifact.termination = {
      reason: "cost-kill-switch",
      message: "Cost kill-switch reached.",
      limitUsd: 1500,
      observedUsd: 1501,
      primaryAgentUsd: 1501,
      loreUsd: null,
      completedTrials: 1,
      totalPlannedTrials: 2,
    }

    expect(hasLongitudinalTaskGateFailures(artifact)).toBe(true)
  })

  it("falls back to total failed trials when no full-loop condition ran", () => {
    expect(
      hasLongitudinalTaskGateFailures(
        longitudinalArtifact({
          noMemory: { trials: 1, passed: 0, failed: 1 },
          fullLoop: { trials: 0, passed: 0, failed: 0 },
          passedTrials: 0,
          failedTrials: 1,
        })
      )
    ).toBe(true)
  })
})

describe("formatTaskProgressEvent", () => {
  it("renders task runner progress lines", () => {
    expect(
      formatTaskProgressEvent({
        type: "trial-start",
        runner: "task",
        taskId: "fix-import",
        scenarioId: null,
        condition: "helpful",
        index: 2,
        total: 4,
      })
    ).toBe("  running 2/4: fix-import [helpful]")
  })

  it("renders cost kill-switch progress lines", () => {
    expect(
      formatTaskProgressEvent({
        type: "run-stop",
        runner: "task",
        reason: "cost-kill-switch",
        limitUsd: 1500,
        observedUsd: 1501.25,
        primaryAgentUsd: 1500,
        loreUsd: 1.25,
        completedTrials: 49,
        totalPlannedTrials: 201,
      })
    ).toContain("cost kill-switch observed $1501.25 / $1500.00")
  })

  it("renders cost unknown progress lines", () => {
    expect(
      formatTaskProgressEvent({
        type: "run-stop",
        runner: "task",
        reason: "cost-unknown",
        limitUsd: 1500,
        observedUsd: 0,
        primaryAgentUsd: 0,
        loreUsd: null,
        completedTrials: 1,
        totalPlannedTrials: 201,
      })
    ).toContain("cost unknown")
  })
})

describe("eval vaults command", () => {
  const originalCwd = process.cwd()

  afterEach(() => {
    process.chdir(originalCwd)
    vi.restoreAllMocks()
  })

  it("loads the committed registry from a non-root cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-eval-vaults-cli-"))
    process.chdir(dir)
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)

    await evalCommand.parseAsync(["vaults"], { from: "user" })

    const output = logSpy.mock.calls.flat().join("\n")
    expect(output).toContain("Eval vaults (evals/vaults.yaml):")
    expect(output).toContain("lore-dev-sandbox")
  })
})

describe("eval longitudinal plan command", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("prints a powered benchmark estimate from a longitudinal artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-eval-longitudinal-plan-"))
    const artifactPath = join(dir, "artifact.json")
    await writeFile(
      artifactPath,
      JSON.stringify(longitudinalPlanArtifact(), null, 2),
      "utf-8"
    )
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)

    await evalCommand.parseAsync(
      [
        "longitudinal",
        "plan",
        artifactPath,
        "--cost-per-condition-run-usd",
        "2",
        "--conditions-per-scenario",
        "2",
      ],
      { from: "user" }
    )

    const output = logSpy.mock.calls.flat().join("\n")
    expect(output).toContain("Longitudinal plan: no-memory -> seeded-lore")
    expect(output).toContain("pilot pairs: 2")
    expect(output).toContain("condition runs")
    expect(output).toContain("efficiency: primary tokens")
    expect(output).toContain("$")
  })
})

describe("eval bench cleanup-orphans command", () => {
  let errorSpy: ReturnType<typeof vi.fn>
  let logSpy: ReturnType<typeof vi.fn>
  let exitTrap: ReturnType<typeof trapProcessExit>

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function setupSpies() {
    vi.mocked(runBenchCleanupOrphans).mockReset()
    exitTrap = trapProcessExit()
    errorSpy = vi.fn()
    logSpy = vi.fn()
    vi.spyOn(console, "error").mockImplementation(errorSpy)
    vi.spyOn(console, "log").mockImplementation(logSpy)
  }

  it.each(["1abc", "1.5"])(
    "exits 1 before cleanup runs for malformed --older-than %j",
    async (raw) => {
      setupSpies()

      await evalCommand.parseAsync(["bench", "cleanup-orphans", "--older-than", raw], {
        from: "user",
      })

      expect(runBenchCleanupOrphans).not.toHaveBeenCalled()
      expect(errorSpy.mock.calls.flat().join("\n")).toContain(
        "lore eval bench cleanup-orphans failed:"
      )
      expect(errorSpy.mock.calls.flat().join("\n")).toContain("--older-than")
      expect(exitTrap.exitCodes).toEqual([1])
      expect(errorSpy).toHaveBeenCalledTimes(1)
    }
  )

  it("exits 1 before cleanup runs for blank --older-than", async () => {
    setupSpies()

    await evalCommand.parseAsync(["bench", "cleanup-orphans", "--older-than", ""], {
      from: "user",
    })

    expect(runBenchCleanupOrphans).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.flat().join("\n")).toContain(
      "lore eval bench cleanup-orphans failed:"
    )
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("--older-than")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it("passes a strict positive integer through to cleanup", async () => {
    setupSpies()
    vi.mocked(runBenchCleanupOrphans).mockResolvedValue({
      archivedCount: 0,
      skippedCount: 0,
      archived: [],
      skipped: [],
    })

    await evalCommand.parseAsync(
      ["bench", "cleanup-orphans", "--older-than", "7", "--dry-run"],
      { from: "user" }
    )

    expect(runBenchCleanupOrphans).toHaveBeenCalledWith({
      olderThanHours: 7,
      dryRun: true,
    })
    expect(logSpy.mock.calls.flat().join("\n")).toContain(
      "Cleanup-orphans: 0 archived, 0 skipped"
    )
    expect(exitTrap.exitCodes).toEqual([])
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

  it("rejects --runner profile with an actionable operator message", () => {
    const result = validateBaselineRunnerSupport("profile")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("--runner profile is not supported")
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

function longitudinalArtifact(input: {
  noMemory: { trials: number; passed: number; failed: number }
  seededLore?: { trials: number; passed: number; failed: number }
  fullLoop: { trials: number; passed: number; failed: number }
  passedTrials: number
  failedTrials: number
}): LongitudinalTaskArtifact {
  return {
    suite: "longitudinal-test",
    description: "",
    startedAt: "2026-05-03T12:00:00.000Z",
    runner: { mode: "task", kind: "longitudinal" },
    termination: null,
    results: [],
    summary: {
      tasks: 1,
      passedTasks: 0,
      failedTasks: 1,
      totalTrials: input.passedTrials + input.failedTrials,
      passedTrials: input.passedTrials,
      failedTrials: input.failedTrials,
      conditions: {
        "no-memory": {
          ...input.noMemory,
          successRate:
            input.noMemory.trials === 0
              ? 0
              : input.noMemory.passed / input.noMemory.trials,
        },
        "seeded-lore": {
          ...(input.seededLore ?? { trials: 0, passed: 0, failed: 0 }),
          successRate:
            input.seededLore === undefined || input.seededLore.trials === 0
              ? 0
              : input.seededLore.passed / input.seededLore.trials,
        },
        "lore-full-loop": {
          ...input.fullLoop,
          successRate:
            input.fullLoop.trials === 0
              ? 0
              : input.fullLoop.passed / input.fullLoop.trials,
        },
      },
      lift: {
        fromCondition: "no-memory",
        toCondition: "lore-full-loop",
        successRateDelta: null,
        liftedScenarioIds: [],
        harmedScenarioIds: [],
      },
      lifts: {},
    },
  }
}

function longitudinalPlanArtifact(): LongitudinalTaskArtifact {
  return {
    ...longitudinalArtifact({
      noMemory: { trials: 2, passed: 1, failed: 1 },
      seededLore: { trials: 2, passed: 2, failed: 0 },
      fullLoop: { trials: 2, passed: 1, failed: 1 },
      passedTrials: 4,
      failedTrials: 2,
    }),
    results: [
      longitudinalPlanResult("one", "no-memory", false),
      longitudinalPlanResult("one", "seeded-lore", true),
      longitudinalPlanResult("one", "lore-full-loop", false),
      longitudinalPlanResult("two", "no-memory", true),
      longitudinalPlanResult("two", "seeded-lore", true),
      longitudinalPlanResult("two", "lore-full-loop", true),
    ],
  }
}

function longitudinalPlanResult(
  scenarioId: string,
  condition: LongitudinalTaskArtifact["results"][number]["condition"],
  success: boolean
): LongitudinalTaskArtifact["results"][number] {
  return {
    taskId: scenarioId,
    scenarioId,
    difficulty: null,
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
    phases: [],
    expectedContextDescription: "",
  }
}
