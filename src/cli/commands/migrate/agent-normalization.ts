import type { LoreServices } from "../../../services.js"
import type { NormalizableAgentRow } from "../../../core/agent-normalization.js"
import { printDiscoveryBreadcrumb } from "./shared.js"

/**
 * Drive the agent-identity normalization pass and render the report.
 * Plan-only by default; `--yes` flips to apply mode. Mirrors the report
 * shape `runFactEncodingFix` / `runMemoryEncodingFix` use.
 *
 * Exported so the migrate CLI tests can exercise it without invoking
 * commander's argv plumbing.
 */
export async function runAgentNormalization(
  services: LoreServices,
  options: { apply: boolean; dryRun?: boolean; projectId?: string }
): Promise<void> {
  const planOnly = !options.apply
  printDiscoveryBreadcrumb("memories with non-canonical Agent strings")
  const report = await services.memories.normalizeAgents({
    dryRun: planOnly,
    ...(options.projectId ? { projectId: options.projectId } : {}),
  })

  if (report.encoded.length === 0) {
    console.log(
      "\nNo memories with non-canonical Agent strings found — every Agent value is already in its canonical form."
    )
    return
  }

  // Group by canonical destination so the operator sees, at a glance, how
  // many fragmented variants are collapsing onto each canonical string.
  // The "8 → Claude Code" framing is the value driver of this migration;
  // a flat per-row list buries it under prefix repetition.
  const byCanonical = new Map<string, NormalizableAgentRow[]>()
  for (const row of report.encoded) {
    const bucket = byCanonical.get(row.canonicalAgent) ?? []
    bucket.push(row)
    byCanonical.set(row.canonicalAgent, bucket)
  }

  const verb = planOnly ? "Would normalize" : "Normalized"
  const written = planOnly ? report.encoded.length : report.fixes.length
  console.log(
    `\n${verb} ${written} memor${written === 1 ? "y" : "ies"} ` +
      `(${byCanonical.size} canonical bucket${byCanonical.size === 1 ? "" : "s"}).`
  )

  for (const [canonical, rows] of byCanonical) {
    const variants = new Map<string, number>()
    for (const row of rows) {
      variants.set(row.rawAgent, (variants.get(row.rawAgent) ?? 0) + 1)
    }
    const ordered = Array.from(variants.entries()).sort((a, b) => b[1] - a[1])
    console.log(
      `  → "${canonical}" (${rows.length} memor${rows.length === 1 ? "y" : "ies"})`
    )
    for (const [variant, count] of ordered) {
      console.log(`     "${variant}" × ${count}`)
    }
  }

  if (report.errors.length > 0) {
    console.log(
      `\nFailed to rewrite ${report.errors.length} row${report.errors.length === 1 ? "" : "s"} (re-run to retry — the apply step is idempotent):`
    )
    const PREVIEW_LIMIT = 10
    for (const e of report.errors.slice(0, PREVIEW_LIMIT)) {
      console.log(`  ${e.id}: ${e.message}`)
    }
    if (report.errors.length > PREVIEW_LIMIT) {
      console.log(`  … and ${report.errors.length - PREVIEW_LIMIT} more failures.`)
    }
  }

  if (planOnly) {
    console.log(
      "\nPlan only — no rewrites written. Re-run with `--yes` to canonicalize the Agent column."
    )
  }
}
