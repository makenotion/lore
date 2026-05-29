import type { LoreServices } from "../../../services.js"
import {
  runBuildFactConfidenceScoresMigration,
  type BuildFactConfidenceScoresPlan,
  type BuildFactConfidenceScoresResult,
} from "../../../core/fact-confidence-migration.js"
import {
  confidenceNames,
  runFactConfidenceAudit,
  type FactConfidenceAuditReport,
  type PredicateConfidenceSummary,
  type ScoreDistribution,
  type ScoreSummary,
} from "../../../core/fact-confidence-audit.js"
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

export async function runAuditFactConfidence(
  services: LoreServices,
  options: {
    projectName?: string
    projectId?: string
    includeArchived?: boolean
  }
): Promise<FactConfidenceAuditReport> {
  const scope = await resolveMigrationProjectScope(services, {
    auditFactConfidence: true,
    project: options.projectName,
    projectId: options.projectId,
    includeArchived: options.includeArchived,
  })
  const projectName = scope.projectName ?? options.projectName

  printDiscoveryBreadcrumb(
    projectName
      ? `live facts for a confidence audit in project "${projectName}"`
      : "live facts for a confidence audit"
  )

  const report = await runFactConfidenceAudit({
    services,
    projectId: scope.projectId,
  })
  printFactConfidenceAudit(report)
  return report
}

export function printFactConfidenceAudit(report: FactConfidenceAuditReport): void {
  console.log(
    `\n[lore] audit-fact-confidence: scanned ${report.totalFactsScanned} ` +
      `live fact${report.totalFactsScanned === 1 ? "" : "s"}`
  )
  console.log(
    `       categorical: ${formatConfidenceCounts(
      report.categorical,
      report.unknownCategorical,
      report.totalFactsScanned
    )}`
  )
  console.log(
    `       numeric: ${report.scoredFacts} scored / ${report.unscoredFacts} unscored; ` +
      `stored ${formatScoreSummary(report.storedScores)}; ` +
      `effective ${formatScoreSummary(report.effectiveScores)}`
  )
  console.log(`       stored buckets:    ${formatBuckets(report.storedBuckets)}`)
  console.log(`       effective buckets: ${formatBuckets(report.effectiveBuckets)}`)
  console.log(
    `       Last Referenced At: missing ${countPct(report.lastReferenced.missing, report.totalFactsScanned)}, ` +
      `today ${countPct(report.lastReferenced.today, report.totalFactsScanned)}, ` +
      `1-7d ${countPct(report.lastReferenced.within7Days, report.totalFactsScanned)}, ` +
      `8-30d ${countPct(report.lastReferenced.within30Days, report.totalFactsScanned)}, ` +
      `31-60d ${countPct(report.lastReferenced.within60Days, report.totalFactsScanned)}, ` +
      `>60d ${countPct(report.lastReferenced.over60Days, report.totalFactsScanned)}, ` +
      `invalid ${countPct(report.lastReferenced.invalid, report.totalFactsScanned)}`
  )
  console.log(
    `       neglect decay: ${countPct(report.decay.pastGrace, report.scoredFacts)} scored rows past ` +
      `the 60d grace; ${countPct(
        report.decay.wouldLowerStoredScore,
        report.scoredFacts
      )} would rank lower after effective decay` +
      ` (avg drop ${formatMaybeScore(report.decay.averageDrop)}, max drop ${formatMaybeScore(report.decay.maxDrop)})`
  )
  const unknownSeed =
    report.scoreVsSeed.unknownConfidence > 0
      ? `, unknown confidence ${countPct(
          report.scoreVsSeed.unknownConfidence,
          report.scoredFacts
        )}`
      : ""
  console.log(
    `       score vs categorical seed: at seed ${countPct(
      report.scoreVsSeed.atSeed,
      report.scoredFacts
    )}, above seed ${countPct(
      report.scoreVsSeed.aboveSeed,
      report.scoredFacts
    )}, below seed ${countPct(
      report.scoreVsSeed.belowSeed,
      report.scoredFacts
    )}${unknownSeed}`
  )
  if (report.topSpeculativePredicates.length > 0) {
    console.log(
      `       top speculative predicates: ${formatPredicateRows(
        report.topSpeculativePredicates
      )}`
    )
  }
  if (report.decay.examples.length > 0) {
    console.log(`\n       Top ${report.decay.examples.length} effective-decay drops:`)
    for (const [index, row] of report.decay.examples.entries()) {
      const triple = `${row.subject} ${row.predicate.replace(/_/g, " ")} ${row.object}`
      console.log(
        `       ${index + 1}. (${row.storedScore.toFixed(3)} -> ${row.effectiveScore.toFixed(3)}, ` +
          `-${row.drop.toFixed(3)}) ${triple}  --  last referenced ` +
          `${row.daysSinceLastReferenced}d ago`
      )
    }
  }
  console.log(
    "\n       Conflict adjudication: `lore conflicts scan` only proposes memory pairs; " +
      "`lore-memory action='compare'` uses the caller's `affectedMemoryId` " +
      "as the loser for asymmetric verdicts. Judge confidence labels emitted " +
      "conflict facts, but existing fact confidence is not an automatic winner selector."
  )
}

function formatConfidenceCounts(
  counts: Record<string, number>,
  unknown: Array<{ confidence: string; total: number }>,
  total: number
): string {
  const rows = confidenceNames().map(
    (name) => `${name} ${countPct(counts[name] ?? 0, total)}`
  )
  const unknownTotal = unknown.reduce((sum, row) => sum + row.total, 0)
  if (unknownTotal > 0) {
    rows.push(
      `unknown ${countPct(unknownTotal, total)} [${unknown
        .map((row) => `${row.confidence} ${row.total}`)
        .join(", ")}]`
    )
  }
  return rows.join(", ")
}

function formatBuckets(buckets: ScoreDistribution): string {
  const total = buckets.veryLow + buckets.low + buckets.moderate + buckets.trusted
  return [
    `<0.2 ${countPct(buckets.veryLow, total)}`,
    `0.2-<0.4 ${countPct(buckets.low, total)}`,
    `0.4-<0.5 ${countPct(buckets.moderate, total)}`,
    `>=0.5 ${countPct(buckets.trusted, total)}`,
  ].join(", ")
}

function formatScoreSummary(summary: ScoreSummary): string {
  if (summary.count === 0) return "n/a"
  return (
    `avg ${formatMaybeScore(summary.average)}, min ${formatMaybeScore(summary.min)}, ` +
    `max ${formatMaybeScore(summary.max)}`
  )
}

function formatMaybeScore(score: number | null): string {
  return score === null ? "n/a" : score.toFixed(3)
}

function formatPredicateRows(rows: PredicateConfidenceSummary[]): string {
  return rows
    .map(
      (row) =>
        `${row.predicate} ${row.speculative}/${row.total} speculative ` +
        `(${pct(row.speculative, row.total)})`
    )
    .join(", ")
}

function countPct(count: number, total: number): string {
  return `${count} (${pct(count, total)})`
}

function pct(count: number, total: number): string {
  if (total === 0) return "0.0%"
  return `${((count / total) * 100).toFixed(1)}%`
}
