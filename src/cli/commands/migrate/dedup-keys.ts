import type { LoreServices } from "../../../services.js"

export async function runDedupKeysMigration(
  services: LoreServices,
  options: { merge?: boolean; dryRun?: boolean; yes?: boolean }
): Promise<void> {
  const result = await services.facts.backfillDedupKeys({
    merge: options.merge,
    dryRun: options.dryRun,
    yes: options.yes,
  })
  const dedupVerb = options.dryRun ? "Would backfill" : "Backfilled"
  console.log(
    `\n${dedupVerb} key columns on ${result.backfilled} fact${result.backfilled === 1 ? "" : "s"} ` +
      `(${result.skipped} already up to date).`
  )
  if (options.merge) {
    const plannedLosers = result.plans.reduce((n, p) => n + p.loserIds.length, 0)
    const headerVerb = options.dryRun
      ? "Would merge"
      : result.mergePreviewOnly
        ? "Proposed merge"
        : "Merged"
    console.log(
      `${headerVerb} ${result.mergedGroups} duplicate group${result.mergedGroups === 1 ? "" : "s"}; ${result.mergePreviewOnly || options.dryRun ? "would invalidate" : "invalidated"} ${result.mergePreviewOnly ? plannedLosers : result.invalidated} loser${(result.mergePreviewOnly ? plannedLosers : result.invalidated) === 1 ? "" : "s"}.`
    )
    const PREVIEW_LIMIT = 10
    for (const plan of result.plans.slice(0, PREVIEW_LIMIT)) {
      console.log(
        `  "${plan.triple.subject}" ${plan.triple.predicate} "${plan.triple.object}"`
      )
      console.log(
        `    survivor: ${plan.survivorId} | invalidate: ${plan.loserIds.join(", ")}`
      )
    }
    if (result.plans.length > PREVIEW_LIMIT) {
      console.log(`  … and ${result.plans.length - PREVIEW_LIMIT} more groups.`)
    }
    if (result.mergePreviewOnly && result.mergedGroups > 0) {
      console.log(
        "\nPlan only — no invalidations written. Re-run with `--yes` to execute."
      )
    }
  }
}
