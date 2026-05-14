/**
 * Bench-mode baseline snapshot + comparison.
 *
 * Structurally disjoint from `src/eval/baseline.ts` (the retrieval
 * baseline). Bench artifacts have neither `(taskId, scenario, surface)`
 * keys nor `recall` / `precision` / `memoryLift` / `memoryHarm`
 * aggregates, so the bench gets its own baseline file rather than
 * coercing the existing one. `BaselineRunnerMismatchError` in
 * `src/eval/baseline.ts` catches cross-runner attempts at the read
 * boundary.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { LONGMEMEVAL_CATEGORIES } from "./bench-corpus.js"
import type { BenchRunArtifact } from "./bench-runner-types.js"

export const BENCH_BASELINE_SCHEMA_VERSION = 1

/**
 * Tight per-example shape. Only the four fields that matter for drift
 * detection: previously-correct examples that turn incorrect trigger
 * the regression gate; the full agent / judge / ingestion telemetry
 * lives in the artifact, not the baseline.
 */
const benchBaselineResultSchema = z
  .object({
    exampleId: z.string().min(1),
    category: z.enum(LONGMEMEVAL_CATEGORIES),
    success: z.boolean(),
    failureReason: z.string().nullable(),
  })
  .strict()

const benchBaselineCategoryStatSchema = z
  .object({
    n: z.number().int().nonnegative(),
    correct: z.number().int().nonnegative(),
    accuracy: z.number(),
  })
  .strict()

export const benchBaselineSnapshotSchema = z
  .object({
    schemaVersion: z.literal(BENCH_BASELINE_SCHEMA_VERSION),
    suite: z.string().min(1),
    benchmark: z.literal("longmemeval"),
    runner: z.literal("bench"),
    capturedAt: z.string().min(1),
    notes: z.string().default(""),
    configHash: z.string().min(1),
    summary: z
      .object({
        totalExamples: z.number().int().nonnegative(),
        scoredExamples: z.number().int().nonnegative(),
        correct: z.number().int().nonnegative(),
        accuracy: z.number(),
        byCategory: z.record(z.string(), benchBaselineCategoryStatSchema),
      })
      .strict(),
    results: z.array(benchBaselineResultSchema),
  })
  .strict()

export type BenchBaselineSnapshot = z.infer<typeof benchBaselineSnapshotSchema>
export type BenchBaselineResult = z.infer<typeof benchBaselineResultSchema>

/**
 * Drift tolerances. Per-category and overall accuracy drops greater
 * than 2 percentage points fail; scoredExamples drops greater than 5
 * (out of typically 500) fail. The cost-cap-abort gate fires
 * unconditionally regardless of accuracy.
 */
export const BENCH_BASELINE_ACCURACY_TOLERANCE = 0.02
export const BENCH_BASELINE_SCORED_DROP_TOLERANCE = 5

export class BenchBaselineConfigMismatchError extends Error {
  constructor(
    public readonly diff: { field: string; baseline: string; fresh: string }[]
  ) {
    super(
      `Bench baseline config mismatch — re-baseline required. ` +
        `Diverged fields: ${diff.map((d) => d.field).join(", ")}`
    )
    this.name = "BenchBaselineConfigMismatchError"
  }
}

export class BenchBaselineRunnerMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `Bench baseline runner mismatch: expected "${expected}", got "${actual}". ` +
        `A retrieval baseline cannot be compared against a bench artifact.`
    )
    this.name = "BenchBaselineRunnerMismatchError"
  }
}

export interface BenchBaselineDrift {
  regressed: boolean
  reasons: string[]
  regressedExamples: string[]
}

export async function readBenchBaselineSnapshot(
  path: string
): Promise<BenchBaselineSnapshot> {
  const raw = await readFile(path, "utf-8")
  const parsed = JSON.parse(raw)
  if (parsed?.runner && parsed.runner !== "bench") {
    throw new BenchBaselineRunnerMismatchError("bench", String(parsed.runner))
  }
  return benchBaselineSnapshotSchema.parse(parsed)
}

export async function writeBenchBaselineSnapshot(
  path: string,
  snapshot: BenchBaselineSnapshot
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8")
}

/**
 * Build a baseline snapshot from a fresh artifact. `notes` is the
 * operator-supplied human-readable annotation (typically the URL of
 * the CI run that produced the artifact).
 */
export function buildBenchBaselineSnapshot(
  artifact: BenchRunArtifact,
  options: { notes?: string; capturedAt?: string } = {}
): BenchBaselineSnapshot {
  const capturedAt = options.capturedAt ?? new Date().toISOString()
  const byCategory: Record<string, { n: number; correct: number; accuracy: number }> = {}
  for (const category of LONGMEMEVAL_CATEGORIES) {
    const stat = artifact.summary.byCategory[category]
    if (stat) {
      byCategory[category] = {
        n: stat.n,
        correct: stat.correct,
        accuracy: stat.accuracy,
      }
    }
  }
  return {
    schemaVersion: BENCH_BASELINE_SCHEMA_VERSION,
    suite: artifact.suite,
    benchmark: "longmemeval",
    runner: "bench",
    capturedAt,
    notes: options.notes ?? "",
    configHash: artifact.summary.configHash,
    summary: {
      totalExamples: artifact.summary.totalExamples,
      scoredExamples: artifact.summary.scoredExamples,
      correct: artifact.summary.overall.correct,
      accuracy: artifact.summary.overall.accuracy,
      byCategory,
    },
    results: artifact.results.map((result) => ({
      exampleId: result.exampleId,
      category: result.category,
      success: result.success,
      failureReason: result.failureReason,
    })),
  }
}

/**
 * Compare a fresh artifact against a committed baseline. Returns a
 * drift report; `regressed: true` should fail the build / nightly job.
 *
 * Six drift gates:
 * 1. Config-hash mismatch → forces a re-baseline.
 * 2. Per-example regression: previously-correct example is now incorrect.
 * 3. Per-category accuracy drop > BENCH_BASELINE_ACCURACY_TOLERANCE.
 * 4. Overall accuracy drop > BENCH_BASELINE_ACCURACY_TOLERANCE.
 * 5. scoredExamples drop > BENCH_BASELINE_SCORED_DROP_TOLERANCE.
 * 6. Cost-cap-abort in the fresh artifact.
 */
export function compareBenchBaseline(input: {
  artifact: BenchRunArtifact
  baseline: BenchBaselineSnapshot
}): BenchBaselineDrift {
  const reasons: string[] = []
  const regressedExamples: string[] = []
  const { artifact, baseline } = input
  if (artifact.summary.configHash !== baseline.configHash) {
    const diff = [
      {
        field: "summary.configHash",
        baseline: baseline.configHash,
        fresh: artifact.summary.configHash,
      },
    ]
    throw new BenchBaselineConfigMismatchError(diff)
  }
  const baselineSuccess = new Map(baseline.results.map((r) => [r.exampleId, r.success]))
  for (const result of artifact.results) {
    const wasCorrect = baselineSuccess.get(result.exampleId)
    if (wasCorrect === true && !result.success) {
      regressedExamples.push(result.exampleId)
    }
  }
  if (regressedExamples.length > 0) {
    reasons.push(`${regressedExamples.length} previously-correct example(s) now fail`)
  }
  for (const category of LONGMEMEVAL_CATEGORIES) {
    const freshStat = artifact.summary.byCategory[category]
    const baselineStat = baseline.summary.byCategory[category]
    if (!freshStat || !baselineStat) continue
    const drop = baselineStat.accuracy - freshStat.accuracy
    if (drop > BENCH_BASELINE_ACCURACY_TOLERANCE) {
      reasons.push(
        `Category ${category} accuracy drop ${drop.toFixed(4)} > tolerance ${BENCH_BASELINE_ACCURACY_TOLERANCE}`
      )
    }
  }
  const overallDrop = baseline.summary.accuracy - artifact.summary.overall.accuracy
  if (overallDrop > BENCH_BASELINE_ACCURACY_TOLERANCE) {
    reasons.push(
      `Overall accuracy drop ${overallDrop.toFixed(4)} > tolerance ${BENCH_BASELINE_ACCURACY_TOLERANCE}`
    )
  }
  const scoredDrop = baseline.summary.scoredExamples - artifact.summary.scoredExamples
  if (scoredDrop > BENCH_BASELINE_SCORED_DROP_TOLERANCE) {
    reasons.push(
      `scoredExamples drop ${scoredDrop} > tolerance ${BENCH_BASELINE_SCORED_DROP_TOLERANCE}`
    )
  }
  if (artifact.summary.aborted) {
    reasons.push("Fresh artifact reports cost-cap or write-cap abort")
  }
  return {
    regressed: reasons.length > 0,
    reasons,
    regressedExamples,
  }
}

/**
 * Stable JSON serializer with deterministic key ordering. Produces the
 * exact byte sequence the bench-runner hashes into `summary.configHash`.
 * Same shape both at capture time and at compare time so the hash
 * matches byte-for-byte.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const ordered: Record<string, unknown> = {}
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        ordered[k] = (val as Record<string, unknown>)[k]
      }
      return ordered
    }
    return val
  })
}

export function computeConfigHash(config: unknown): string {
  const hash = createHash("sha256")
  hash.update(canonicalJsonStringify(config))
  return hash.digest("hex")
}
