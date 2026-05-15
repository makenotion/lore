import type { LoreServices } from "../../../services.js"
import {
  runBackfillFactObservedAtMigration,
  type BackfillFactObservedAtResult,
} from "../../../core/fact-observed-at-migration.js"
import {
  PROJECT_SCOPE_MIGRATION_DOC,
  resolveProjectScopeName,
  validateExplicitProjectScopeName,
} from "../../../core/project-scope.js"
import { redactDebugMessage } from "../../../debug-redact.js"
import { printDiscoveryBreadcrumb } from "./shared.js"

/**
 * Driver for `--backfill-fact-observed-at`. Same
 * plan-then-execute discipline as the sibling fact-confidence
 * migration: strict-resolve `--project`, walk every fact via
 * `FactService.listAllForBackfill` (including invalidated rows so
 * historical `Valid Until` values can seed `Invalidated At`), render
 * the plan, optionally apply with progress lines.
 */
export async function runBackfillFactObservedAt(
  services: LoreServices,
  options: {
    apply: boolean
    dryRun: boolean
    projectName?: string
    projectId?: string
  }
): Promise<BackfillFactObservedAtResult> {
  const planOnly = !options.apply
  const explicitProjectName = validateExplicitProjectScopeName(
    options.projectName,
    "--project",
    {
      listHint: "run `lore status projects` to list configured projects",
      omittedScopeLabel: "vault-wide scope",
      docsHint: PROJECT_SCOPE_MIGRATION_DOC,
    }
  )
  let projectId = options.projectId
  if (explicitProjectName !== undefined && projectId === undefined) {
    const project = await resolveProjectScopeName(
      services.projects,
      explicitProjectName,
      "--project",
      {
        listHint: "run `lore status projects` to list configured projects",
        omittedScopeLabel: "vault-wide scope",
        docsHint: PROJECT_SCOPE_MIGRATION_DOC,
      }
    )
    projectId = project.id
  }

  printDiscoveryBreadcrumb(
    options.projectName
      ? `facts missing transaction-time provenance in project "${options.projectName}"`
      : "facts missing transaction-time provenance"
  )

  const result = await runBackfillFactObservedAtMigration({
    services,
    apply: options.apply,
    dryRun: options.dryRun,
    projectName: options.projectName,
    projectId,
  })
  const { plan, written, failures } = result

  console.log(
    `\n[lore] backfill-fact-observed-at: scanned ${plan.totalFactsScanned} ` +
      `fact${plan.totalFactsScanned === 1 ? "" : "s"}`
  )
  console.log(
    `       ${plan.rowsToBackfill.length} to backfill ` +
      `(${plan.observedAtRowsToWrite} Observed At, ` +
      `${plan.invalidatedAtRowsToWrite} Invalidated At from Valid Until)`
  )
  console.log(`       ${plan.rowsAlreadyBackfilled} already backfilled`)

  if (plan.rowsToBackfill.length === 0) {
    if (planOnly) {
      console.log(
        "\nNo facts need backfilling — every row already carries Observed At / Invalidated At."
      )
    } else {
      console.log(
        "\nNo facts needed backfilling — every row already had Observed At / Invalidated At."
      )
    }
    return result
  }

  if (planOnly) {
    console.log("\n[lore] dry-run: no writes performed. Re-run with --yes to apply.")
  } else {
    console.log(
      `\n[lore] backfill-fact-observed-at: wrote ${written} row${written === 1 ? "" : "s"}.`
    )
    // Per-row failure surface. Lets the
    // operator distinguish transient errors (likely re-runnable) from
    // schema mismatches (need their own remediation) without parsing
    // stderr progress lines.
    if (failures.length > 0) {
      console.log(
        `[lore] backfill-fact-observed-at: ${failures.length} row${failures.length === 1 ? "" : "s"} failed; re-run to retry`
      )
      const PREVIEW = 5
      for (const failure of failures.slice(0, PREVIEW)) {
        // Route SDK error messages through redactDebugMessage
        // before rendering to a user-visible channel. Today's Notion
        // SDK does not interpolate page bodies into Error.message;
        // the redactor is forward-compat hardening that matches the
        // posture every other operator-visible error surface in this
        // codebase already adopts.
        console.log(`       - ${failure.factId}: ${redactDebugMessage(failure.message)}`)
      }
      if (failures.length > PREVIEW) {
        console.log(`       ... and ${failures.length - PREVIEW} more`)
      }
    }
  }
  return result
}
