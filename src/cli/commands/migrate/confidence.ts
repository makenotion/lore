import type { LoreServices } from "../../../services.js"
import {
  runBuildFactConfidenceScoresMigration,
  type BuildFactConfidenceScoresPlan,
  type BuildFactConfidenceScoresResult,
} from "../../../core/fact-confidence-migration.js"
import { printDiscoveryBreadcrumb, resolveMigrationProjectScope } from "./shared.js"

/**
 * Drive the fact confidence-score backfill and render the report.
 * Plan-only by default; `--yes` flips to apply mode.
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
  const planOnly = !options.apply || options.dryRun === true
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
    apply: !planOnly,
    dryRun: planOnly || options.dryRun,
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
