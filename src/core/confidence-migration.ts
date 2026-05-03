/**
 * Baseline backfill for the dynamic-confidence workstream (0.8.0/#11).
 *
 * `lore migrate --build-confidence-scores` seeds every pre-0.8.0 memory's
 * `Confidence Score` from its categorical `Confidence` column and writes
 * `Last Referenced At = created_time`, then realizes any decay accrued
 * since creation. Operator-pulled, plan-then-execute, idempotent — the
 * skip-rule is `confidenceScore !== null`, so a row touched by Phase 2's
 * read-touch (or by a prior run of this migration) is left alone.
 *
 * Mirrors the structure of `fact-encoding`/`memory-encoding` migrations
 * but lives off the `MemoryService` boundary — the migration consumes
 * the public `listAllForBackfill` / `applyBackfillScore` helpers rather
 * than reaching into `services.client` directly. Same posture as
 * `runBuildEntitiesMigration`.
 */

import type { LoreServices } from "../services.js"
import type { MemoryConfidence } from "../types.js"
import { DEFAULT_NOTION_CONCURRENCY } from "../notion/rate-limit.js"
import {
  formatUnresolvedProjectScopeError,
  validateExplicitProjectScopeName,
} from "./project-scope.js"
import { decayConfidenceScore, seedConfidenceScore } from "./decay.js"
import { todayUtc } from "./task.js"

const DAY_MS = 1000 * 60 * 60 * 24

function daysBetween(later: string, earlier: string): number {
  const a = new Date(later).getTime()
  const b = new Date(earlier).getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  // Clamp to 0 so a clock-skewed memory (Notion server clock disagreement
  // producing a `created_time` after `today`) renders as `0d ago` in the
  // operator preview rather than `-3d ago`. `decayConfidenceScore`
  // already clamps `staleDays = max(0, ...)` internally, so the score is
  // unaffected — this clamp keeps the rendered surface honest too.
  return Math.max(0, Math.floor((a - b) / DAY_MS))
}

export interface BuildConfidenceScoresOptions {
  services: LoreServices
  /** When false, `runBuildConfidenceScoresMigration` builds and prints
   *  the plan but does not write. Same posture as `--fix-fact-encoding`'s
   *  bare-flag mode — the operator re-runs with `--yes` to apply. */
  apply: boolean
  /** When true, writes are suppressed even if `apply` is true. Mirrors
   *  every other migrate flag's `--dry-run` precedence. */
  dryRun: boolean
  /** Optional `lore-status`-listed project name to scope the migration
   *  to. Unknown / typo'd names throw before any plan or write fires —
   *  the safety property is documented on the throw site below. */
  projectName?: string
}

export interface BuildConfidenceScoresPlanRow {
  memoryId: string
  title: string
  fromConfidence: MemoryConfidence
  /** `seedConfidenceScore(fromConfidence)` — the categorical-mapped
   *  value before decay is applied. Surfaced for the plan summary's
   *  "avg seeded score" line. */
  seededScore: number
  /** `decayConfidenceScore(seededScore, createdDate, today)` — what
   *  `executePlan` writes. */
  decayedScore: number
  /** YYYY-MM-DD form of the row's Notion `created_time`. Both
   *  `executePlan` (Last Referenced At write) and the plan summary
   *  read this field, so `buildPlan` computes once and the execute
   *  path is mechanical. */
  createdDate: string
  /** Days between `today` and `createdDate`. Surfaced in the plan
   *  summary's "vault avg neglect" line and the per-row preview. */
  daysSinceCreation: number
}

export interface BuildConfidenceScoresPlan {
  totalMemoriesScanned: number
  rowsToSeed: BuildConfidenceScoresPlanRow[]
  rowsAlreadyScored: number
}

export interface BuildConfidenceScoresResult {
  plan: BuildConfidenceScoresPlan
  /** Number of `pages.update` writes that succeeded under `executePlan`.
   *  Zero on dry-run / plan-only paths. */
  written: number
}

/**
 * Drive the build-confidence-scores migration end-to-end. Resolves
 * `--project` (failing fast on unknown names — see safety note in
 * `buildPlan`), scans every non-archived memory, builds the per-row
 * plan, and — when `apply && !dryRun` — dispatches the writes in
 * bounded-concurrent batches.
 *
 * Returns the plan plus the realized write count so callers (CLI
 * dispatcher, tests) can render the appropriate summary without
 * re-deriving the count.
 */
export async function runBuildConfidenceScoresMigration(
  opts: BuildConfidenceScoresOptions
): Promise<BuildConfidenceScoresResult> {
  const plan = await buildPlan(opts)
  let written = 0
  if (opts.apply && !opts.dryRun) {
    written = await executePlan(plan, opts)
  }
  return { plan, written }
}

async function buildPlan(
  opts: BuildConfidenceScoresOptions
): Promise<BuildConfidenceScoresPlan> {
  const { services, projectName } = opts

  // `--project <name>` strict resolution. A typo'd / unknown name must
  // NOT silently fall through to vault-wide migration — that would
  // mutate every null-scored row across all projects, and a `--yes`
  // for one project is not consent to mutate the whole vault.
  let projectId: string | undefined
  const explicitProjectName = validateExplicitProjectScopeName(projectName, "--project", {
    listHint: "run `lore status projects` to list configured projects",
    omittedScopeLabel: "vault-wide scope",
  })
  if (explicitProjectName !== undefined) {
    const project = await services.projects.findByName(explicitProjectName)
    if (project === null) {
      throw new Error(
        formatUnresolvedProjectScopeError([explicitProjectName], "--project", {
          listHint: "run `lore status projects` to list configured projects",
          omittedScopeLabel: "vault-wide scope",
        })
      )
    }
    projectId = project.id
  }

  const rowsToSeed: BuildConfidenceScoresPlanRow[] = []
  let rowsAlreadyScored = 0
  let totalMemoriesScanned = 0
  const today = todayUtc()

  for await (const memory of services.memories.listAllForBackfill({ projectId })) {
    totalMemoriesScanned += 1

    if (memory.confidenceScore !== null) {
      rowsAlreadyScored += 1
      continue
    }

    const seeded = seedConfidenceScore(memory.confidence)
    // `Memory.createdAt` is full ISO-8601; slice to YYYY-MM-DD to match
    // `decayConfidenceScore`'s day-granularity contract — same shape
    // used by `touchOnRead`'s seed-decay-then-bump branch.
    const createdDate = memory.createdAt.slice(0, 10)
    const decayed = decayConfidenceScore(seeded, createdDate, today)
    rowsToSeed.push({
      memoryId: memory.id,
      title: memory.title,
      fromConfidence: memory.confidence,
      seededScore: seeded,
      decayedScore: decayed,
      createdDate,
      daysSinceCreation: daysBetween(today, createdDate),
    })
  }

  return { totalMemoriesScanned, rowsToSeed, rowsAlreadyScored }
}

async function executePlan(
  plan: BuildConfidenceScoresPlan,
  opts: BuildConfidenceScoresOptions
): Promise<number> {
  // Bounded-concurrent dispatch: chunk into batches whose size matches
  // the configured Notion concurrency, then `Promise.all` each batch
  // sequentially. The rate-limited client (`createLimitedClient` in
  // `src/services.ts`) is a `p-limit` gate, so dispatching every row
  // with one big `Promise.all` would also work — but chunking gives a
  // natural seam for the per-100-rows progress line and bounds the
  // in-flight promise count for very large vaults.
  //
  // Why concurrent and not sequential: a sequential `for await` loop
  // serializes round-trips. The configured `notion.rateLimit.concurrency`
  // knob has no effect under that shape — the bottleneck is round-trip
  // serialization, not in-flight count. Chunked-`Promise.all` makes the
  // operator's lever honest.
  const concurrency =
    opts.services.config.notion?.rateLimit?.concurrency ?? DEFAULT_NOTION_CONCURRENCY
  let processed = 0
  let nextProgressMark = 100
  for (let i = 0; i < plan.rowsToSeed.length; i += concurrency) {
    const batch = plan.rowsToSeed.slice(i, i + concurrency)
    await Promise.all(
      batch.map((row) =>
        opts.services.memories.applyBackfillScore(
          row.memoryId,
          row.decayedScore,
          row.createdDate
        )
      )
    )
    processed += batch.length
    if (processed >= nextProgressMark) {
      process.stderr.write(
        `[lore] build-confidence-scores: ${processed}/${plan.rowsToSeed.length}\n`
      )
      // Next 100-row boundary strictly greater than `processed`.
      // `Math.floor(processed / 100) * 100 + 100` is `processed + 100`
      // when processed is a multiple of 100, and the next multiple of
      // 100 above processed otherwise.
      nextProgressMark = Math.floor(processed / 100) * 100 + 100
    }
  }
  return processed
}
