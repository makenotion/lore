import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  buildEvalBaselineSnapshot,
  compareToEvalBaseline,
  evalBaselineSnapshotSchema,
  formatBaselineDriftReport,
  readEvalBaselineSnapshot,
  writeEvalBaselineSnapshot,
  type EvalBaselineSnapshot,
} from "./baseline.js"
import type { EvalRunArtifact, EvalTaskResult } from "./runner.js"

describe("eval baseline", () => {
  it("captures a comparison-stable snapshot from an artifact", () => {
    const artifact = artifactFixture({
      results: [
        passingResult("task-a", "helpful-memory", "wake-up.taskMemories"),
        passingResult("task-a", "no-lore", "wake-up.taskMemories"),
      ],
      summary: { tasks: 1, totalResults: 2, passedResults: 2, failedResults: 0 },
    })

    const snapshot = buildEvalBaselineSnapshot(artifact, {
      capturedAt: "2026-05-03T12:00:00.000Z",
      notes: "first capture",
    })

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      suite: "lore-core",
      capturedAt: "2026-05-03T12:00:00.000Z",
      notes: "first capture",
      summary: {
        tasks: 1,
        totalResults: 2,
        passedResults: 2,
        failedResults: 0,
      },
    })
    expect(snapshot.results.map((r) => `${r.taskId}::${r.scenario}`)).toEqual([
      "task-a::helpful-memory",
      "task-a::no-lore",
    ])
  })

  it("round-trips through write + read with schema validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-baseline-"))
    const path = join(dir, "baseline.json")
    const snapshot = buildEvalBaselineSnapshot(
      artifactFixture({
        results: [passingResult("task-a", "helpful-memory", "wake-up.taskMemories")],
      }),
      { capturedAt: "2026-05-03T12:00:00.000Z" }
    )

    await writeEvalBaselineSnapshot(path, snapshot)
    const loaded = await readEvalBaselineSnapshot(path)

    expect(loaded).toEqual(snapshot)
    const raw = await readFile(path, "utf-8")
    expect(raw.endsWith("\n")).toBe(true)
  })

  it("reports OK drift when the artifact matches the baseline byte-for-byte", () => {
    const artifact = artifactFixture({
      results: [passingResult("task-a", "helpful-memory", "wake-up.taskMemories")],
    })
    const baseline = buildEvalBaselineSnapshot(artifact)

    const drift = compareToEvalBaseline({
      artifact,
      baseline,
      baselinePath: "/tmp/baseline.json",
    })

    expect(drift.regressed).toBe(false)
    expect(drift.regressions).toEqual([])
    expect(drift.newFailures).toEqual([])
    expect(drift.fixedFailures).toEqual([])
    expect(drift.newResults).toEqual([])
    expect(drift.removedResults).toEqual([])
    expect(drift.metricChanges.memoryLift.delta).toBe(0)
  })

  it("flags a regression when a previously-passing result now fails", () => {
    const baselineArtifact = artifactFixture({
      results: [passingResult("task-a", "helpful-memory", "wake-up.taskMemories")],
    })
    const baseline = buildEvalBaselineSnapshot(baselineArtifact)

    const failedArtifact = artifactFixture({
      results: [failingResult("task-a", "helpful-memory", "wake-up.taskMemories")],
      summary: { tasks: 1, totalResults: 1, passedResults: 0, failedResults: 1 },
    })

    const drift = compareToEvalBaseline({
      artifact: failedArtifact,
      baseline,
      baselinePath: "/tmp/baseline.json",
    })

    expect(drift.regressed).toBe(true)
    expect(drift.newFailures).toEqual([
      {
        taskId: "task-a",
        scenario: "helpful-memory",
        surface: "wake-up.taskMemories",
        baselineSuccess: true,
        currentSuccess: false,
      },
    ])
    expect(drift.regressions).toContain("1 previously-passing result(s) now failing")
  })

  it("flags any post-baseline memoryHarm bump as regression", () => {
    const baseline: EvalBaselineSnapshot = {
      schemaVersion: 1,
      suite: "lore-core",
      runner: "retrieval",
      capturedAt: "2026-05-03T12:00:00.000Z",
      notes: "",
      summary: {
        tasks: 1,
        totalResults: 1,
        passedResults: 1,
        failedResults: 0,
        retrieval: {
          averageRecall: null,
          averagePrecision: null,
          memoryLift: 1,
          memoryHarm: 0,
        },
      },
      results: [
        {
          taskId: "task-a",
          scenario: "helpful-memory",
          surface: "wake-up.taskMemories",
          success: true,
          recall: null,
          precision: null,
        },
      ],
    }

    const artifact = artifactFixture({
      results: [passingResult("task-a", "helpful-memory", "wake-up.taskMemories")],
      summary: {
        tasks: 1,
        totalResults: 1,
        passedResults: 1,
        failedResults: 0,
      },
      retrieval: {
        averageRecall: null,
        averagePrecision: null,
        memoryLift: 1,
        memoryHarm: 0.5,
      },
    })

    const drift = compareToEvalBaseline({
      artifact,
      baseline,
      baselinePath: "/tmp/baseline.json",
    })

    expect(drift.regressed).toBe(true)
    expect(drift.regressions).toContain("memoryHarm increased from 0 to 0.5")
  })

  it("treats any post-baseline harm bump as a regression (no tolerance)", () => {
    // The harm contract is "no tolerance — any new harm is a regression"
    // (see BASELINE_METRIC_TOLERANCE comment in baseline.ts and the
    // matching docs paragraph). A jitter that would slip past
    // BASELINE_METRIC_TOLERANCE on the recall/precision/lift axes must
    // still trip the gate when it lands on harm.
    const baselineArtifact = artifactFixture({
      results: [passingResult("task-a", "helpful-memory", "wake-up.taskMemories")],
      retrieval: {
        averageRecall: 1,
        averagePrecision: 0.881,
        memoryLift: 1,
        memoryHarm: 0,
      },
    })
    const baseline = buildEvalBaselineSnapshot(baselineArtifact)

    const jitter = artifactFixture({
      results: [passingResult("task-a", "helpful-memory", "wake-up.taskMemories")],
      retrieval: {
        averageRecall: 1,
        averagePrecision: 0.881,
        memoryLift: 1,
        memoryHarm: 0.0005,
      },
    })

    const drift = compareToEvalBaseline({
      artifact: jitter,
      baseline,
      baselinePath: "/tmp/baseline.json",
    })

    expect(drift.regressed).toBe(true)
    expect(
      drift.regressions.some((r) => r.includes("memoryHarm increased from 0 to 0.0005"))
    ).toBe(true)
  })

  it("flags baseline results missing from the current run as regressions", () => {
    const baselineArtifact = artifactFixture({
      results: [
        passingResult("task-a", "helpful-memory", "wake-up.taskMemories"),
        passingResult("task-b", "helpful-memory", "wake-up.taskMemories"),
      ],
      summary: { tasks: 2, totalResults: 2, passedResults: 2, failedResults: 0 },
    })
    const baseline = buildEvalBaselineSnapshot(baselineArtifact)

    // Current run is missing task-b — silent loss of coverage. The
    // drift report must flag this even though every remaining result
    // is passing.
    const shrunken = artifactFixture({
      results: [passingResult("task-a", "helpful-memory", "wake-up.taskMemories")],
      summary: { tasks: 1, totalResults: 1, passedResults: 1, failedResults: 0 },
    })

    const drift = compareToEvalBaseline({
      artifact: shrunken,
      baseline,
      baselinePath: "/tmp/baseline.json",
    })

    expect(drift.regressed).toBe(true)
    expect(drift.removedResults).toEqual([
      {
        taskId: "task-b",
        scenario: "helpful-memory",
        surface: "wake-up.taskMemories",
      },
    ])
    expect(
      drift.regressions.some((r) =>
        r.includes("baseline result(s) missing from the current run")
      )
    ).toBe(true)
  })

  it("keys per-result drift on (taskId, scenario, surface) so multi-surface siblings don't clobber", () => {
    // Same `(taskId, scenario)` exercised on two surfaces: a buggy
    // two-key implementation would let the second insertion overwrite
    // the first in `Map<string, ...>` lookups and silently drop one
    // surface's coverage from the drift gate.
    const baselineArtifact = artifactFixture({
      results: [
        passingResult("task-a", "helpful-memory", "wake-up.taskMemories"),
        passingResult("task-a", "helpful-memory", "wake-up.memories"),
      ],
      summary: { tasks: 1, totalResults: 2, passedResults: 2, failedResults: 0 },
    })
    const baseline = buildEvalBaselineSnapshot(baselineArtifact)
    expect(baseline.results).toHaveLength(2)

    // Now drop the `wake-up.memories` row from the current run while
    // keeping the `wake-up.taskMemories` row intact. The drift gate
    // must flag the missing surface, not silently treat the two rows
    // as collapsing on the shared `(taskId, scenario)` key.
    const dropped = artifactFixture({
      results: [passingResult("task-a", "helpful-memory", "wake-up.taskMemories")],
      summary: { tasks: 1, totalResults: 1, passedResults: 1, failedResults: 0 },
    })

    const drift = compareToEvalBaseline({
      artifact: dropped,
      baseline,
      baselinePath: "/tmp/baseline.json",
    })

    expect(drift.regressed).toBe(true)
    expect(drift.removedResults).toEqual([
      {
        taskId: "task-a",
        scenario: "helpful-memory",
        surface: "wake-up.memories",
      },
    ])
  })

  it("surfaces newly-added results without flagging them as regressions", () => {
    const baselineArtifact = artifactFixture({
      results: [passingResult("task-a", "helpful-memory", "wake-up.taskMemories")],
    })
    const baseline = buildEvalBaselineSnapshot(baselineArtifact)

    const expanded = artifactFixture({
      results: [
        passingResult("task-a", "helpful-memory", "wake-up.taskMemories"),
        passingResult("task-b", "helpful-memory", "wake-up.memories"),
      ],
      summary: { tasks: 2, totalResults: 2, passedResults: 2, failedResults: 0 },
    })

    const drift = compareToEvalBaseline({
      artifact: expanded,
      baseline,
      baselinePath: "/tmp/baseline.json",
    })

    expect(drift.regressed).toBe(false)
    expect(drift.newResults).toEqual([
      {
        taskId: "task-b",
        scenario: "helpful-memory",
        surface: "wake-up.memories",
      },
    ])
  })

  it("formats drift report with regression reasons and metric deltas", () => {
    const baselineArtifact = artifactFixture({
      results: [passingResult("task-a", "helpful-memory", "wake-up.taskMemories")],
    })
    const baseline = buildEvalBaselineSnapshot(baselineArtifact)
    const failedArtifact = artifactFixture({
      results: [failingResult("task-a", "helpful-memory", "wake-up.taskMemories")],
      summary: { tasks: 1, totalResults: 1, passedResults: 0, failedResults: 1 },
    })

    const drift = compareToEvalBaseline({
      artifact: failedArtifact,
      baseline,
      baselinePath: "/tmp/baseline.json",
    })
    const report = formatBaselineDriftReport(drift)

    expect(report).toContain("Drift: REGRESSED")
    expect(report).toContain("task-a / helpful-memory (wake-up.taskMemories)")
    expect(report).toContain("Metric changes:")
  })

  it("refuses to compare a baseline captured for a different suite", () => {
    const baselineArtifact = artifactFixture({
      results: [passingResult("task-a", "helpful-memory", "wake-up.taskMemories")],
    })
    const baseline = buildEvalBaselineSnapshot(baselineArtifact)
    expect(baseline.suite).toBe("lore-core")

    // A fresh run for a different suite must not compare against this
    // baseline — the row keys would happen to align coincidentally and
    // silently pass the drift gate.
    const otherSuiteArtifact: EvalRunArtifact = {
      ...baselineArtifact,
      suite: "other-suite",
    }

    expect(() =>
      compareToEvalBaseline({
        artifact: otherSuiteArtifact,
        baseline,
        baselinePath: "/tmp/baseline.json",
      })
    ).toThrow(
      /captured for suite "lore-core" but the current run is for suite "other-suite"/
    )
  })

  it("refuses to compare a baseline captured in a different runner mode", () => {
    const baselineArtifact = artifactFixture({
      results: [passingResult("task-a", "helpful-memory", "wake-up.taskMemories")],
    })
    const baseline = buildEvalBaselineSnapshot(baselineArtifact)
    expect(baseline.runner).toBe("retrieval")

    // Mutate the baseline's runner to simulate a baseline captured
    // under a different runner mode (e.g. a future notion-backed
    // runner). We cast through `unknown` because `EvalRunner` only
    // covers runners actually wired in the current PR; the
    // runner-identity guard is intentionally forward-defined so the
    // next runner cannot silently compare against retrieval baselines
    // before its own baseline is captured. A retrieval baseline keys
    // results by ablation scenario; a future notion baseline would
    // key on `live-vault` — direct comparison would surface every
    // result as new or removed and trip the drift gate for the wrong
    // reason. The CI baseline gate this PR installs depends on
    // rejecting that mismatch before any row comparison runs.
    const otherRunnerBaseline: EvalBaselineSnapshot = {
      ...baseline,
      runner: "notion" as unknown as EvalBaselineSnapshot["runner"],
    }

    expect(() =>
      compareToEvalBaseline({
        artifact: baselineArtifact,
        baseline: otherRunnerBaseline,
        baselinePath: "/tmp/baseline.json",
      })
    ).toThrow(/captured in "notion" mode but the current run is "retrieval"/)
  })

  it("rejects baselines whose schemaVersion is not 1", () => {
    const result = evalBaselineSnapshotSchema.safeParse({
      schemaVersion: 2,
      suite: "lore-core",
      capturedAt: "2026-05-03T12:00:00.000Z",
      summary: {
        tasks: 0,
        totalResults: 0,
        passedResults: 0,
        failedResults: 0,
        retrieval: {
          averageRecall: null,
          averagePrecision: null,
          memoryLift: null,
          memoryHarm: null,
        },
      },
      results: [],
    })

    expect(result.success).toBe(false)
  })
})

function passingResult(
  taskId: string,
  scenario: string,
  surface:
    | "wake-up.taskMemories"
    | "wake-up.taskOnly"
    | "wake-up.memories"
    | "wake-up.relatedMemories"
): EvalTaskResult {
  return {
    taskId,
    scenario,
    trial: 1,
    success: true,
    surfacedMemoryIds: [],
    expectedMemoriesSurfaced: [],
    missingExpectedMemories: [],
    unexpectedMemoriesSurfaced: [],
    retrieval: {
      surface,
      limit: 3,
      recall: scenario === "helpful-memory" ? 1 : null,
      precision: scenario === "helpful-memory" ? 1 : null,
    },
    metrics: { elapsedMs: 1 },
  }
}

function failingResult(
  taskId: string,
  scenario: string,
  surface:
    | "wake-up.taskMemories"
    | "wake-up.taskOnly"
    | "wake-up.memories"
    | "wake-up.relatedMemories"
): EvalTaskResult {
  return {
    taskId,
    scenario,
    trial: 1,
    success: false,
    surfacedMemoryIds: [],
    expectedMemoriesSurfaced: [],
    missingExpectedMemories: ["expected/missing"],
    unexpectedMemoriesSurfaced: [],
    retrieval: {
      surface,
      limit: 3,
      recall: 0,
      precision: 0,
    },
    metrics: { elapsedMs: 1 },
  }
}

function artifactFixture(input: {
  results: EvalTaskResult[]
  summary?: Partial<EvalRunArtifact["summary"]>
  retrieval?: Partial<EvalRunArtifact["summary"]["retrieval"]>
}): EvalRunArtifact {
  const summary = {
    tasks: 1,
    scenarios: ["helpful-memory"],
    trials: 1,
    totalResults: input.results.length,
    passedResults: input.results.filter((r) => r.success).length,
    failedResults: input.results.filter((r) => !r.success).length,
    retrieval: {
      averageRecall: 1,
      averagePrecision: 1,
      memoryLift: 1,
      memoryHarm: 0,
      ...input.retrieval,
    },
    ...input.summary,
  }
  return {
    suite: "lore-core",
    description: "",
    startedAt: "2026-05-03T12:00:00.000Z",
    runner: {
      mode: "retrieval",
      surfaces: ["wake-up.taskMemories"],
      requestedTrials: 1,
      executedTrials: 1,
    },
    results: input.results,
    summary,
  }
}
