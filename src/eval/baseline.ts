import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"
import type { EvalRunArtifact, EvalTaskResult } from "./runner.js"
import { EVAL_RUNNERS, EVAL_SURFACES, type EvalRunner, type EvalSurface } from "./schema.js"

/**
 * Snapshot schema version. Bump when the baseline shape changes; the
 * loader rejects unknown versions so a forward-incompatible baseline
 * cannot silently mis-compare.
 */
export const EVAL_BASELINE_SCHEMA_VERSION = 1

const baselineMetricSchema = z
  .object({
    averageRecall: z.number().nullable(),
    averagePrecision: z.number().nullable(),
    memoryLift: z.number().nullable(),
    memoryHarm: z.number().nullable(),
  })
  .strict()

const baselineSummarySchema = z
  .object({
    tasks: z.number().int().nonnegative(),
    totalResults: z.number().int().nonnegative(),
    passedResults: z.number().int().nonnegative(),
    failedResults: z.number().int().nonnegative(),
    retrieval: baselineMetricSchema,
  })
  .strict()

const baselineResultSchema = z
  .object({
    taskId: z.string().min(1),
    scenario: z.string().min(1),
    surface: z.enum(EVAL_SURFACES),
    success: z.boolean(),
    recall: z.number().nullable(),
    precision: z.number().nullable(),
  })
  .strict()

export const evalBaselineSnapshotSchema = z
  .object({
    schemaVersion: z.literal(EVAL_BASELINE_SCHEMA_VERSION),
    suite: z.string().min(1),
    /**
     * Runner mode that produced this baseline. Cross-runner comparisons
     * are rejected by `compareToEvalBaseline` because retrieval-mode
     * baselines key results by ablation scenario (`no-lore`,
     * `helpful-memory`, ...) while a notion-mode baseline would
     * key on `live-vault` — direct comparison would surface every
     * result as either new or removed and trip the drift gate for the
     * wrong reason. Pre-runner-field baselines default to `retrieval`
     * for back-compat.
     */
    runner: z.enum(EVAL_RUNNERS).default("retrieval"),
    capturedAt: z.string().min(1),
    notes: z.string().default(""),
    summary: baselineSummarySchema,
    results: z.array(baselineResultSchema),
  })
  .strict()

export type EvalBaselineSnapshot = z.infer<typeof evalBaselineSnapshotSchema>
export type EvalBaselineResult = z.infer<typeof baselineResultSchema>

/**
 * Default tolerance applied to averaged retrieval metrics (recall,
 * precision, lift). Empirical floating-point jitter from `roundMetric`
 * is bounded at 1e-4; 1e-3 absorbs it without admitting real
 * regressions. `memoryHarm` does NOT use this tolerance — any
 * post-baseline harm bump should be a regression.
 */
export const BASELINE_METRIC_TOLERANCE = 0.001

/**
 * Suite identity mismatch — a baseline captured against suite A
 * cannot be compared against a fresh artifact from suite B. The row
 * keys are scoped to the suite, so the comparison would produce
 * coincidental matches and the drift gate would lose its meaning.
 * Thrown by `compareToEvalBaseline` before any row comparison runs.
 */
export class BaselineSuiteMismatchError extends Error {
  constructor(
    public readonly baselineSuite: string,
    public readonly currentSuite: string,
    public readonly baselinePath: string
  ) {
    super(
      `Baseline at ${baselinePath} was captured for suite "${baselineSuite}" but the current run is for suite "${currentSuite}". ` +
        `Capture a suite-matched baseline before comparing.`
    )
    this.name = "BaselineSuiteMismatchError"
  }
}

/**
 * Cross-runner mismatch — a baseline captured in one runner mode
 * cannot be compared against a fresh artifact from another mode. The
 * scenario keys are disjoint (retrieval baselines key on ablation
 * scenarios; a notion-mode baseline would key on `live-vault`),
 * so the comparison would surface every result as either `newResults`
 * or `removedResults` and trip the drift gate for the wrong reason.
 * The CI baseline gate this PR installs depends on this guard:
 * without it, a baseline captured under one runner could silently
 * gate a future PR running a different runner against the same
 * suite name.
 */
export class BaselineRunnerMismatchError extends Error {
  constructor(
    public readonly baselineRunner: EvalRunner,
    public readonly currentRunner: EvalRunner,
    public readonly baselinePath: string
  ) {
    super(
      `Baseline at ${baselinePath} was captured in "${baselineRunner}" mode but the current run is "${currentRunner}". ` +
        `Capture a runner-matched baseline (lore eval baseline --runner ${currentRunner} ...) before comparing.`
    )
    this.name = "BaselineRunnerMismatchError"
  }
}

export interface BaselineMetricChange {
  baseline: number | null
  current: number | null
  delta: number | null
}

export interface BaselineMetricChanges {
  averageRecall: BaselineMetricChange
  averagePrecision: BaselineMetricChange
  memoryLift: BaselineMetricChange
  memoryHarm: BaselineMetricChange
}

export interface BaselineResultDelta {
  taskId: string
  scenario: string
  surface: EvalSurface
  baselineSuccess: boolean
  currentSuccess: boolean
}

export interface BaselineDriftReport {
  baselinePath: string
  baselineCapturedAt: string
  /** True when any axis crossed the regression bar described below. */
  regressed: boolean
  /** Human-readable reasons for `regressed: true`; empty when no regression. */
  regressions: string[]
  /** Results that passed in the baseline and now fail. */
  newFailures: BaselineResultDelta[]
  /** Results that failed in the baseline and now pass. */
  fixedFailures: BaselineResultDelta[]
  /** Result keys present in the current run but missing from the baseline. */
  newResults: Array<Pick<BaselineResultDelta, "taskId" | "scenario" | "surface">>
  /** Result keys present in the baseline but missing from the current run. */
  removedResults: Array<Pick<BaselineResultDelta, "taskId" | "scenario" | "surface">>
  metricChanges: BaselineMetricChanges
}

/** Build a comparison-stable snapshot from a fresh eval run. */
export function buildEvalBaselineSnapshot(
  artifact: EvalRunArtifact,
  options: { capturedAt?: string; notes?: string } = {}
): EvalBaselineSnapshot {
  const capturedAt = options.capturedAt ?? artifact.startedAt
  return {
    schemaVersion: EVAL_BASELINE_SCHEMA_VERSION,
    suite: artifact.suite,
    runner: artifact.runner.mode,
    capturedAt,
    notes: options.notes ?? "",
    summary: {
      tasks: artifact.summary.tasks,
      totalResults: artifact.summary.totalResults,
      passedResults: artifact.summary.passedResults,
      failedResults: artifact.summary.failedResults,
      retrieval: { ...artifact.summary.retrieval },
    },
    results: artifact.results
      .map(toBaselineResult)
      .sort(compareBaselineResultKeys),
  }
}

export async function writeEvalBaselineSnapshot(
  path: string,
  snapshot: EvalBaselineSnapshot
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8")
}

export async function readEvalBaselineSnapshot(
  path: string
): Promise<EvalBaselineSnapshot> {
  const raw = await readFile(path, "utf-8")
  const parsed = JSON.parse(raw) as unknown
  return evalBaselineSnapshotSchema.parse(parsed)
}

/**
 * Compare a fresh artifact to a baseline snapshot and return a drift
 * report. Regression triggers — any one of these flips `regressed: true`:
 *
 * - A baselined-as-passing result now fails.
 * - `failedResults` increases vs. baseline.
 * - `memoryHarm` increases at all (or appears where the baseline had
 *   no harm signal). No tolerance — any new harm is a regression.
 * - A result present in the baseline is missing from the current run
 *   (silent loss of coverage — deleting a task and its baseline row
 *   in the same PR is the documented baseline-refresh workflow).
 *
 * Aggregate metric drops on `averageRecall` / `averagePrecision` /
 * `memoryLift` are surfaced via `metricChanges` for visibility, but do
 * NOT auto-regress: a per-result drop already shows up as a new
 * failure, and a metric drop without a per-result regression usually
 * means a baselined-as-failing result was tightened. Keep the bar at the
 * task level rather than the average.
 */
export function compareToEvalBaseline(input: {
  artifact: EvalRunArtifact
  baseline: EvalBaselineSnapshot
  baselinePath: string
}): BaselineDriftReport {
  // Suite identity must match. The result keys are scoped to a suite,
  // so a baseline captured against `lore-core` cannot meaningfully
  // compare against a different suite — the row keys would happen to
  // align by coincidence. Without this check, a CI command pointed at
  // the wrong baseline file silently passes the drift gate.
  if (input.baseline.suite !== input.artifact.suite) {
    throw new BaselineSuiteMismatchError(
      input.baseline.suite,
      input.artifact.suite,
      input.baselinePath
    )
  }
  // Runner identity is checked alongside suite identity. The
  // CI baseline gate depends on this: without it, a baseline
  // captured under one runner could silently gate a future PR
  // running a different runner against the same suite name.
  if (input.baseline.runner !== input.artifact.runner.mode) {
    throw new BaselineRunnerMismatchError(
      input.baseline.runner,
      input.artifact.runner.mode,
      input.baselinePath
    )
  }
  const baselineByKey = new Map<string, EvalBaselineResult>()
  for (const result of input.baseline.results) {
    baselineByKey.set(resultKey(result), result)
  }

  const currentByKey = new Map<string, EvalTaskResult>()
  for (const result of input.artifact.results) {
    currentByKey.set(resultKey(result), result)
  }

  const newFailures: BaselineResultDelta[] = []
  const fixedFailures: BaselineResultDelta[] = []
  const newResults: Array<Pick<BaselineResultDelta, "taskId" | "scenario" | "surface">> =
    []
  const removedResults: Array<
    Pick<BaselineResultDelta, "taskId" | "scenario" | "surface">
  > = []

  for (const [key, current] of currentByKey) {
    const prior = baselineByKey.get(key)
    if (!prior) {
      newResults.push({
        taskId: current.taskId,
        scenario: current.scenario,
        surface: current.retrieval.surface,
      })
      continue
    }
    if (prior.success && !current.success) {
      newFailures.push({
        taskId: current.taskId,
        scenario: current.scenario,
        surface: current.retrieval.surface,
        baselineSuccess: prior.success,
        currentSuccess: current.success,
      })
    } else if (!prior.success && current.success) {
      fixedFailures.push({
        taskId: current.taskId,
        scenario: current.scenario,
        surface: current.retrieval.surface,
        baselineSuccess: prior.success,
        currentSuccess: current.success,
      })
    }
  }

  for (const [key, prior] of baselineByKey) {
    if (currentByKey.has(key)) continue
    removedResults.push({
      taskId: prior.taskId,
      scenario: prior.scenario,
      surface: prior.surface,
    })
  }

  const metricChanges = buildMetricChanges(input.artifact, input.baseline)

  const regressions: string[] = []
  if (newFailures.length > 0) {
    regressions.push(
      `${newFailures.length} previously-passing result(s) now failing`
    )
  }
  if (removedResults.length > 0) {
    regressions.push(
      `${removedResults.length} baseline result(s) missing from the current run (refresh baseline if intentional)`
    )
  }
  if (
    input.artifact.summary.failedResults > input.baseline.summary.failedResults
  ) {
    regressions.push(
      `failedResults increased from ${input.baseline.summary.failedResults} to ${input.artifact.summary.failedResults}`
    )
  }
  const harmChange = metricChanges.memoryHarm
  if (
    harmChange.baseline !== null &&
    harmChange.current !== null &&
    harmChange.current > harmChange.baseline
  ) {
    // No tolerance for harm — the JSDoc / docs / const-comment all
    // promise that any post-baseline harm bump is a regression.
    regressions.push(
      `memoryHarm increased from ${harmChange.baseline} to ${harmChange.current}`
    )
  } else if (harmChange.baseline === null && harmChange.current !== null) {
    // The baseline had no harm signal; any current harm is a regression
    // because the previous run didn't measure it (e.g., scenarios were
    // newly added). Treat it as a regression so an operator notices.
    regressions.push(
      `memoryHarm now ${harmChange.current} (baseline had no harm signal)`
    )
  }

  return {
    baselinePath: input.baselinePath,
    baselineCapturedAt: input.baseline.capturedAt,
    regressed: regressions.length > 0,
    regressions,
    newFailures,
    fixedFailures,
    newResults,
    removedResults,
    metricChanges,
  }
}

export function formatBaselineDriftReport(report: BaselineDriftReport): string {
  const lines: string[] = []
  lines.push(
    `Baseline: ${report.baselinePath} (captured ${report.baselineCapturedAt})`
  )
  if (report.regressed) {
    lines.push("Drift: REGRESSED")
    for (const reason of report.regressions) lines.push(`  - ${reason}`)
  } else {
    lines.push("Drift: OK")
  }
  if (report.newFailures.length > 0) {
    lines.push(`New failures (${report.newFailures.length}):`)
    for (const failure of report.newFailures) {
      lines.push(
        `  - ${failure.taskId} / ${failure.scenario} (${failure.surface})`
      )
    }
  }
  if (report.fixedFailures.length > 0) {
    lines.push(`Fixed failures (${report.fixedFailures.length}):`)
    for (const fixed of report.fixedFailures) {
      lines.push(`  - ${fixed.taskId} / ${fixed.scenario} (${fixed.surface})`)
    }
  }
  if (report.newResults.length > 0) {
    lines.push(`New results (${report.newResults.length}, refresh baseline):`)
    for (const item of report.newResults.slice(0, 5)) {
      lines.push(`  - ${item.taskId} / ${item.scenario} (${item.surface})`)
    }
    if (report.newResults.length > 5) {
      lines.push(`  ... and ${report.newResults.length - 5} more`)
    }
  }
  if (report.removedResults.length > 0) {
    lines.push(
      `Removed results (${report.removedResults.length}, refresh baseline):`
    )
    for (const item of report.removedResults.slice(0, 5)) {
      lines.push(`  - ${item.taskId} / ${item.scenario} (${item.surface})`)
    }
    if (report.removedResults.length > 5) {
      lines.push(`  ... and ${report.removedResults.length - 5} more`)
    }
  }

  const metric = report.metricChanges
  lines.push("Metric changes:")
  for (const [name, change] of [
    ["averageRecall", metric.averageRecall],
    ["averagePrecision", metric.averagePrecision],
    ["memoryLift", metric.memoryLift],
    ["memoryHarm", metric.memoryHarm],
  ] as const) {
    lines.push(
      `  - ${name}: ${formatMetric(change.baseline)} -> ${formatMetric(change.current)}` +
        (change.delta !== null ? ` (Δ ${formatDelta(change.delta)})` : "")
    )
  }
  return lines.join("\n")
}

function buildMetricChanges(
  artifact: EvalRunArtifact,
  baseline: EvalBaselineSnapshot
): BaselineMetricChanges {
  return {
    averageRecall: metricChange(
      baseline.summary.retrieval.averageRecall,
      artifact.summary.retrieval.averageRecall
    ),
    averagePrecision: metricChange(
      baseline.summary.retrieval.averagePrecision,
      artifact.summary.retrieval.averagePrecision
    ),
    memoryLift: metricChange(
      baseline.summary.retrieval.memoryLift,
      artifact.summary.retrieval.memoryLift
    ),
    memoryHarm: metricChange(
      baseline.summary.retrieval.memoryHarm,
      artifact.summary.retrieval.memoryHarm
    ),
  }
}

function metricChange(
  baseline: number | null,
  current: number | null
): BaselineMetricChange {
  const delta =
    baseline === null || current === null
      ? null
      : Math.round((current - baseline) * 10000) / 10000
  return { baseline, current, delta }
}

function formatMetric(value: number | null): string {
  return value === null ? "n/a" : value.toString()
}

function formatDelta(value: number): string {
  const rounded = value.toFixed(4)
  return value >= 0 ? `+${rounded}` : rounded
}

function toBaselineResult(result: EvalTaskResult): EvalBaselineResult {
  return {
    taskId: result.taskId,
    scenario: result.scenario,
    surface: result.retrieval.surface,
    success: result.success,
    recall: result.retrieval.recall,
    precision: result.retrieval.precision,
  }
}

function compareBaselineResultKeys(
  a: EvalBaselineResult,
  b: EvalBaselineResult
): number {
  return resultKey(a).localeCompare(resultKey(b))
}

/**
 * Result identity key. Includes `surface` so a single task that
 * exercises multiple wake-up surfaces (or a future runner that mixes
 * surfaces under one `(taskId, scenario)` pair) cannot silently
 * clobber sibling rows in `compareToEvalBaseline`'s `Map<string, ...>`
 * lookups. Past two-key form was `${taskId}::${scenario}`; widening
 * to three keys is forward-compatible because the prior callers all
 * had a unique `(taskId, scenario)` per surface.
 */
function resultKey(
  result:
    | { taskId: string; scenario: string; surface: EvalSurface }
    | EvalTaskResult
): string {
  const surface =
    "surface" in result ? result.surface : result.retrieval.surface
  return `${result.taskId}::${result.scenario}::${surface}`
}
