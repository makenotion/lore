import type { LoreServices } from "../../../services.js"
import { resolveFeatureFlags } from "../../../feature-flags.js"
import {
  computeOrphanRateFromAggregateRows,
  computeOrphanRateFromFacts,
  type OrphanRateReport,
} from "../../../core/entity-migration.js"
import { querySubjectGroupCountsViaRunTool } from "../../../notion/runtool/index.js"
import {
  isSqlValidationError,
  logRunToolFallback,
} from "../../../notion/runtool/error-helpers.js"
import { FACT_PROPS } from "../../../notion/schema.js"

/**
 * Drive the orphan-rate report after `--build-entities`.
 *
 * Two execution paths, gated by `LORE_USE_RUNTOOL_AGGREGATE` (defaults
 * to the parent `LORE_USE_RUNTOOL`, which itself defaults ON):
 *
 * 1. **RunTool aggregate path.** Issues a single
 *    `query_data_sources` SQL query that groups facts by
 *    `(SubjectEntity, Subject)` and counts per group, then folds the
 *    rows through `computeOrphanRateFromAggregateRows`. **Default
 *    path** when neither flag is explicitly disabled.
 * 2. **JS enumeration path.** Walks every fact via
 *    `FactService.queryBySubject("", { allowUnfiltered: true,
 *    includeInvalidated: true })`, folds through
 *    `computeOrphanRateFromFacts`. Runs when either flag is set to
 *    `=0`, or when the RunTool path falls back per-call (capability
 *    gate / saturation / transient transport / malformed response).
 *    Serves every workspace tier including those below
 *    `hasAdvancedTools`.
 *
 * The flagged-on path falls back to the JS path **per call** on a
 * non-`validation_error` SDK error (403 / 429 / 5xx / network blip /
 * `SqlPartialResultError` / malformed response). A 400 /
 * `validation_error` re-throws so query-shape drift surfaces as an
 * operator-actionable failure rather than silently masking. The
 * fallback emits a one-line `[lore] partial-failure` notice under
 * `LORE_DEBUG=1`.
 *
 * **Pre/post-pass labeling**. `apply` is the canonical signal for
 * which graph the metric measured. On `apply === true` (i.e.
 * `--yes` and not `--dry-run`) the helper labels the output
 * `post-pass` because `runBuildEntitiesMigration` filled empty Fact
 * relations before this report ran. On `apply === false`
 * (plan-only, including `--dry-run`) the helper labels `pre-pass`
 * because the migration printed the plan without rewriting any
 * rows. Without this distinction an operator running the
 * operator-friendly preview (`--build-entities --report-orphan-rate
 * --dry-run`) would read the metric as if the migration had landed;
 * the silent mislabel was rejected during review.
 *
 * Read-only and best-effort — a failed report does NOT abort the
 * migration, since the migration's apply path has already landed by
 * the time this runs.
 */
export async function runOrphanRateReport(
  services: LoreServices,
  options: { apply: boolean; projectId?: string; projectName?: string }
): Promise<void> {
  const aggregateEnabled = (services.features ?? resolveFeatureFlags()).runTool.aggregate
  let report: OrphanRateReport | null = null
  let path: "runtool-aggregate" | "js-enumeration" = "js-enumeration"

  if (aggregateEnabled) {
    try {
      const rows = await querySubjectGroupCountsViaRunTool(services.client, {
        factsDataSourceId: services.vault.databases.facts.dataSourceId,
        subjectProperty: FACT_PROPS.SUBJECT,
        subjectEntityProperty: FACT_PROPS.SUBJECT_ENTITY,
        projectProperty: FACT_PROPS.PROJECT,
        projectId: options.projectId,
      })
      report = computeOrphanRateFromAggregateRows(rows)
      path = "runtool-aggregate"
    } catch (err) {
      if (isSqlValidationError(err)) {
        // Query-shape drift — surface to the operator instead of
        // silently masking with the JS path.
        throw err
      }
      logRunToolFallback("orphan-rate-aggregate", err)
      // Fall through to the JS path below.
    }
  }

  if (report === null) {
    // `includeInvalidated: true` keeps both paths semantically
    // equivalent — Notion's SQL gateway does not expose date columns
    // (`Valid Until`, `validUntil`, `valid_until` all return
    // `no such column`), so the SQL aggregate path counts every
    // fact regardless of invalidation. Without the matching opt-in
    // here, the JS fallback would silently report a different (lower)
    // count than the SQL path on the same vault. See
    // `querySubjectGroupCountsViaRunTool`'s docstring for the
    // tradeoff rationale.
    const facts = await services.facts.queryBySubject("", {
      projectId: options.projectId,
      allowUnfiltered: true,
      includeInvalidated: true,
    })
    report = computeOrphanRateFromFacts(facts)
    path = "js-enumeration"
  }

  const pct = (report.orphanRate * 100).toFixed(1)
  // Scope label: prefer the resolved project name when present so the
  // operator sees the same label they passed via `--project`.
  const scopeLabel = options.projectName
    ? `project ${JSON.stringify(options.projectName)}`
    : options.projectId
      ? "project-scoped"
      : "vault-wide"
  const passLabel = options.apply ? "post-pass" : "pre-pass"
  console.log(
    `Orphan rate (${passLabel}, ${scopeLabel}, via ${path}): ${pct}% — ` +
      `${report.totalGroups - report.groupsWithPeer}/${report.totalGroups} ` +
      `entit${report.totalGroups - report.groupsWithPeer === 1 ? "y" : "ies"} ` +
      `appear in exactly 1 fact (${report.totalFacts} fact${report.totalFacts === 1 ? "" : "s"} inspected, including invalidated).`
  )
  if (report.totalGroups > 0 && report.orphanRate < 0.5) {
    console.log(
      "  Below the PF3-01 50% acceptance threshold — case-folding canonicalization was sufficient."
    )
  } else if (report.totalGroups > 0) {
    console.log(
      "  At or above the PF3-01 50% threshold — the deferred richer-clusterer follow-up may be needed; see `src/core/AGENTS.md`."
    )
  }
}
