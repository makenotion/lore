import type { LoreServices } from "../../../services.js"
import {
  runBuildConfidenceScoresMigration,
  type BuildConfidenceScoresPlan,
  type BuildConfidenceScoresResult,
} from "../../../core/confidence-migration.js"
import {
  runBuildFactConfidenceScoresMigration,
  type BuildFactConfidenceScoresPlan,
  type BuildFactConfidenceScoresResult,
} from "../../../core/fact-confidence-migration.js"
import { printDiscoveryBreadcrumb, resolveMigrationProjectScope } from "./shared.js"

/**
 * Drive the build-confidence-scores migration and render the report.
 * Plan-only by default; `--yes` flips to apply mode. Mirrors
 * `runFactEncodingFix` / `runBuildEntitiesMigration` posture.
 *
 * Exported so the migrate CLI tests can exercise it without invoking
 * commander's argv plumbing.
 */
export async function runBuildConfidenceScores(
  services: LoreServices,
  options: {
    apply: boolean
    dryRun: boolean
    projectName?: string
    projectId?: string
    includeArchived?: boolean
  }
): Promise<BuildConfidenceScoresResult> {
  const planOnly = !options.apply
  const scope = await resolveMigrationProjectScope(services, {
    buildConfidenceScores: true,
    project: options.projectName,
    projectId: options.projectId,
    includeArchived: options.includeArchived,
  })
  const projectName = scope.projectName ?? options.projectName

  printDiscoveryBreadcrumb(
    projectName
      ? `memories without a Confidence Score in project "${projectName}"`
      : "memories without a Confidence Score"
  )

  const result = await runBuildConfidenceScoresMigration({
    services,
    apply: options.apply,
    dryRun: options.dryRun,
    projectName,
    projectId: scope.projectId,
  })
  const { plan, written } = result

  console.log(
    `\n[lore] build-confidence-scores: scanned ${plan.totalMemoriesScanned} ` +
      `memor${plan.totalMemoriesScanned === 1 ? "y" : "ies"}`
  )
  console.log(
    `       ${plan.rowsToSeed.length} to seed (${plan.rowsAlreadyScored} already scored)`
  )

  if (plan.rowsToSeed.length === 0) {
    if (planOnly) {
      console.log(
        "\nNo memories need seeding — every row already has a Confidence Score."
      )
    } else {
      console.log(
        "\nNo memories needed seeding — every row already had a Confidence Score."
      )
    }
    return result
  }

  const stats = summarizeConfidenceScorePlan(plan)
  console.log(`       avg seeded score:  ${stats.avgSeeded.toFixed(2)}`)
  // The "to-seed" qualifier is load-bearing on a vault that's mostly
  // already-scored — averaging only the unseeded subset describes
  // what `--yes` would write, NOT what the vault as a whole looks
  // like. A label of "vault avg neglect" would mislead operators
  // running the migration against a partly-populated vault.
  console.log(
    `       avg decayed score: ${stats.avgDecayed.toFixed(2)} ` +
      `(to-seed avg neglect: ${stats.avgNeglectPastGrace} day${stats.avgNeglectPastGrace === 1 ? "" : "s"} past grace)`
  )

  const PREVIEW_LIMIT = 10
  const sortedByDecay = [...plan.rowsToSeed].sort(
    (a, b) => a.decayedScore - b.decayedScore
  )
  const top = sortedByDecay.slice(0, PREVIEW_LIMIT)
  if (top.length > 0) {
    console.log(`\n       Top ${top.length} most-decayed (after seed + decay):`)
    top.forEach((row, i) => {
      console.log(
        `       ${i + 1}. (${row.decayedScore.toFixed(3)}) ${row.title}  —  ${row.daysSinceCreation}d ago`
      )
    })
  }

  if (planOnly) {
    console.log("\n[lore] dry-run: no writes performed. Re-run with --yes to apply.")
  } else {
    console.log(
      `\n[lore] build-confidence-scores: wrote ${written} row${written === 1 ? "" : "s"}.`
    )
  }
  return result
}

/**
 * Fact-side mirror of `runBuildConfidenceScores` (DEFERRED-02). Same
 * plan-then-execute discipline: strict-resolve `--project`, scan
 * unscored facts via `FactService.listAllForBackfill`, render plan
 * summary, optionally apply with progress lines.
 */
export async function runBuildFactConfidenceScores(
  services: LoreServices,
  options: {
    apply: boolean
    dryRun: boolean
    projectName?: string
    projectId?: string
    includeArchived?: boolean
  }
): Promise<BuildFactConfidenceScoresResult> {
  const planOnly = !options.apply
  const scope = await resolveMigrationProjectScope(services, {
    buildFactConfidenceScores: true,
    project: options.projectName,
    projectId: options.projectId,
    includeArchived: options.includeArchived,
  })
  const projectName = scope.projectName ?? options.projectName

  printDiscoveryBreadcrumb(
    projectName
      ? `facts without a Confidence Score in project "${projectName}"`
      : "facts without a Confidence Score"
  )

  const result = await runBuildFactConfidenceScoresMigration({
    services,
    apply: options.apply,
    dryRun: options.dryRun,
    projectName,
    projectId: scope.projectId,
  })
  const { plan, written } = result

  console.log(
    `\n[lore] build-fact-confidence-scores: scanned ${plan.totalFactsScanned} ` +
      `fact${plan.totalFactsScanned === 1 ? "" : "s"}`
  )
  console.log(
    `       ${plan.rowsToSeed.length} to seed (${plan.rowsAlreadyScored} already scored)`
  )

  if (plan.rowsToSeed.length === 0) {
    if (planOnly) {
      console.log("\nNo facts need seeding — every row already has a Confidence Score.")
    } else {
      console.log("\nNo facts needed seeding — every row already had a Confidence Score.")
    }
    return result
  }

  const stats = summarizeFactConfidenceScorePlan(plan)
  console.log(`       avg seeded score:  ${stats.avgSeeded.toFixed(2)}`)
  console.log(
    `       avg decayed score: ${stats.avgDecayed.toFixed(2)} ` +
      `(to-seed avg neglect: ${stats.avgNeglectPastGrace} day${stats.avgNeglectPastGrace === 1 ? "" : "s"} past grace)`
  )

  const PREVIEW_LIMIT = 10
  const sortedByDecay = [...plan.rowsToSeed].sort(
    (a, b) => a.decayedScore - b.decayedScore
  )
  const top = sortedByDecay.slice(0, PREVIEW_LIMIT)
  if (top.length > 0) {
    console.log(`\n       Top ${top.length} most-decayed (after seed + decay):`)
    top.forEach((row, i) => {
      const triple = `${row.subject} ${row.predicate.replace(/_/g, " ")} ${row.object}`
      console.log(
        `       ${i + 1}. (${row.decayedScore.toFixed(3)}) ${triple}  —  ${row.daysSinceCreation}d ago`
      )
    })
  }

  if (planOnly) {
    console.log("\n[lore] dry-run: no writes performed. Re-run with --yes to apply.")
  } else {
    console.log(
      `\n[lore] build-fact-confidence-scores: wrote ${written} row${written === 1 ? "" : "s"}.`
    )
  }
  return result
}

/**
 * Pure summary stats for the build-fact-confidence-scores plan output.
 * Mirror of `summarizeConfidenceScorePlan` (DEFERRED-02).
 */
export function summarizeFactConfidenceScorePlan(plan: BuildFactConfidenceScoresPlan): {
  avgSeeded: number
  avgDecayed: number
  avgNeglectPastGrace: number
} {
  const n = plan.rowsToSeed.length
  if (n === 0) {
    return { avgSeeded: 0, avgDecayed: 0, avgNeglectPastGrace: 0 }
  }
  const STALE_GRACE_DAYS = 60
  let seededSum = 0
  let decayedSum = 0
  let neglectPastGraceSum = 0
  for (const row of plan.rowsToSeed) {
    seededSum += row.seededScore
    decayedSum += row.decayedScore
    neglectPastGraceSum += Math.max(0, row.daysSinceCreation - STALE_GRACE_DAYS)
  }
  return {
    avgSeeded: seededSum / n,
    avgDecayed: decayedSum / n,
    avgNeglectPastGrace: Math.round(neglectPastGraceSum / n),
  }
}

/**
 * Pure summary stats for the build-confidence-scores plan output.
 * Exported so tests pin the per-line numbers without re-deriving the
 * arithmetic.
 */
export function summarizeConfidenceScorePlan(plan: BuildConfidenceScoresPlan): {
  avgSeeded: number
  avgDecayed: number
  avgNeglectPastGrace: number
} {
  const n = plan.rowsToSeed.length
  if (n === 0) {
    return { avgSeeded: 0, avgDecayed: 0, avgNeglectPastGrace: 0 }
  }
  const STALE_GRACE_DAYS = 60
  let seededSum = 0
  let decayedSum = 0
  let neglectPastGraceSum = 0
  for (const row of plan.rowsToSeed) {
    seededSum += row.seededScore
    decayedSum += row.decayedScore
    neglectPastGraceSum += Math.max(0, row.daysSinceCreation - STALE_GRACE_DAYS)
  }
  return {
    avgSeeded: seededSum / n,
    avgDecayed: decayedSum / n,
    avgNeglectPastGrace: Math.round(neglectPastGraceSum / n),
  }
}
