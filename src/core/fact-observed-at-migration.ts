/**
 * Backfill the transaction-time provenance columns on every fact.
 *
 * `lore migrate --backfill-fact-observed-at` walks every fact row,
 * including invalidated rows, and writes:
 *
 * - `Observed At = page.created_time` (YYYY-MM-DD) on rows whose
 *   `Observed At` is empty. The Notion `created_time` is the best
 *   available proxy for "when Lore learned this fact" on rows
 *   without the column populated — the write side seeds `Observed
 *   At` at create time, but every row written before the
 *   transaction-time columns existed needs the backfill.
 * - `Invalidated At = Valid Until` on rows where `Valid Until` is set
 *   AND `Invalidated At` is empty. Conservative best-effort fallback:
 *   on historical invalidations the operator didn't separately record
 *   the transaction-time invalidation date. Using `Valid Until` is the
 *   closest signal we have — and on the common path
 *   (`FactService.invalidate` flips both today), the two dates align
 *   by construction.
 *
 * The migration is idempotent (skip-rule is `observed-at != null AND
 * invalidated-at != null` for rows that need both, with each axis
 * checked independently — a row already backfilled on one axis stays
 * untouched on the next run). Plan-then-execute via
 * `lore migrate --backfill-fact-observed-at --yes`; bare invocation
 * prints the plan and exits.
 *
 * Mirrors the fact-confidence-baseline migration line-for-line on
 * structure — the two are deliberately parallel so an operator
 * running both migrations sees a consistent shape across surfaces.
 */

import type { LoreServices } from "../services.js"
import { DEFAULT_NOTION_CONCURRENCY } from "../notion/rate-limit.js"
import {
  PROJECT_SCOPE_MIGRATION_DOC,
  resolveProjectScopeName,
  validateExplicitProjectScopeName,
} from "./project-scope.js"

export interface BackfillFactObservedAtOptions {
  services: LoreServices
  /** When false, builds and prints the plan but does not write. */
  apply: boolean
  /** When true, suppresses writes regardless of `apply`. */
  dryRun: boolean
  /** Optional project name to scope the migration. Unknown names abort
   *  before any plan or write fires. */
  projectName?: string
  /** Pre-resolved project ID from the CLI dispatcher. Takes precedence
   *  over `projectName`. */
  projectId?: string
}

export interface BackfillFactObservedAtPlanRow {
  factId: string
  subject: string
  predicate: string
  object: string
  /** YYYY-MM-DD of the value the migration will write to `Observed At`,
   *  or `null` when the row already carries one. */
  observedAtToWrite: string | null
  /** YYYY-MM-DD of the value the migration will write to `Invalidated
   *  At`, or `null` when the row is live (no `Valid Until`) or already
   *  carries an `Invalidated At` of its own. */
  invalidatedAtToWrite: string | null
}

export interface BackfillFactObservedAtPlan {
  totalFactsScanned: number
  /** Rows that need EITHER `Observed At` OR `Invalidated At` written
   *  (each axis checked independently). A single row can contribute to
   *  both counters and still appears once here. */
  rowsToBackfill: BackfillFactObservedAtPlanRow[]
  /** Rows where both axes are already populated. */
  rowsAlreadyBackfilled: number
  /** Sub-counter: rows whose `Observed At` was missing and will be
   *  filled by this run. */
  observedAtRowsToWrite: number
  /** Sub-counter: rows whose `Invalidated At` was missing AND whose
   *  `Valid Until` is set (so the migration has a fallback value to
   *  write). */
  invalidatedAtRowsToWrite: number
}

export interface BackfillFactObservedAtFailure {
  factId: string
  message: string
}

export interface BackfillFactObservedAtResult {
  plan: BackfillFactObservedAtPlan
  /** Number of `pages.update` writes that succeeded. Zero on dry-run /
   *  plan-only paths. */
  written: number
  /** Per-row failures encountered during the apply pass (issue #284
   *  review item #4). Empty on dry-run / plan-only paths. Operators
   *  use these to distinguish "transient 429 on a few rows" from
   *  "schema mismatch on this specific row" without aborting the
   *  whole pass. */
  failures: BackfillFactObservedAtFailure[]
}

export async function runBackfillFactObservedAtMigration(
  opts: BackfillFactObservedAtOptions
): Promise<BackfillFactObservedAtResult> {
  const plan = await buildPlan(opts)
  const { written, failures } =
    opts.apply && !opts.dryRun
      ? await executePlan(plan, opts)
      : { written: 0, failures: [] as BackfillFactObservedAtFailure[] }
  return { plan, written, failures }
}

async function buildPlan(
  opts: BackfillFactObservedAtOptions
): Promise<BackfillFactObservedAtPlan> {
  const { services, projectName } = opts

  // Strict-resolve the project name. A typo'd / unknown name must NOT
  // silently fall through to vault-wide migration — same posture as the
  // sibling fact-confidence migration.
  let projectId = opts.projectId
  const explicitProjectName = validateExplicitProjectScopeName(projectName, "--project", {
    listHint: "run `lore status projects` to list configured projects",
    omittedScopeLabel: "vault-wide scope",
    docsHint: PROJECT_SCOPE_MIGRATION_DOC,
  })
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

  const rowsToBackfill: BackfillFactObservedAtPlanRow[] = []
  let rowsAlreadyBackfilled = 0
  let totalFactsScanned = 0
  let observedAtRowsToWrite = 0
  let invalidatedAtRowsToWrite = 0

  // Include invalidated rows (`includeInvalidated: true`) so we can also
  // backfill `Invalidated At` from `Valid Until` on historical
  // invalidations. The default backfill walker filters those out.
  for await (const fact of services.facts.listAllForBackfill({
    projectId,
    includeInvalidated: true,
  })) {
    totalFactsScanned += 1

    // `pageToFact` always populates `createdAt` from Notion's built-in
    // `created_time`; the explicit guard surfaces a partial-Fact
    // contamination at the right call site.
    if (fact.createdAt === undefined) {
      throw new Error(
        `lore migrate --backfill-fact-observed-at: Fact.createdAt is ` +
          `unexpectedly undefined (fact id=${fact.id}). listAllForBackfill ` +
          `routes through pageToFact which always populates the field; a ` +
          `missing value indicates a partial Fact reached the migration ` +
          `walker.`
      )
    }

    const observedAtToWrite = fact.observedAt == null ? fact.createdAt.slice(0, 10) : null
    // Only seed `Invalidated At` from `Valid Until` when the row IS
    // invalidated AND lacks the transaction-time column. Live rows
    // (`validUntil == null`) intentionally leave `Invalidated At`
    // empty regardless of `Observed At` state.
    const invalidatedAtToWrite =
      fact.validUntil != null && fact.invalidatedAt == null ? fact.validUntil : null

    if (observedAtToWrite === null && invalidatedAtToWrite === null) {
      rowsAlreadyBackfilled += 1
      continue
    }

    if (observedAtToWrite !== null) observedAtRowsToWrite += 1
    if (invalidatedAtToWrite !== null) invalidatedAtRowsToWrite += 1

    rowsToBackfill.push({
      factId: fact.id,
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      observedAtToWrite,
      invalidatedAtToWrite,
    })
  }

  return {
    totalFactsScanned,
    rowsToBackfill,
    rowsAlreadyBackfilled,
    observedAtRowsToWrite,
    invalidatedAtRowsToWrite,
  }
}

async function executePlan(
  plan: BackfillFactObservedAtPlan,
  opts: BackfillFactObservedAtOptions
): Promise<{ written: number; failures: BackfillFactObservedAtFailure[] }> {
  // Per-row error isolation. A `Promise.all` per batch would abort
  // the entire migration on the first rejection, so an operator
  // hitting a transient 429 or a schema-mismatch on a single row
  // would have to re-run after every failure. `Promise.allSettled`
  // per chunk lets the run complete, distinguishes the failed rows
  // from the successful ones, and surfaces a per-row failure list
  // the caller can render. The rate-limit middleware
  // paces individual requests; the chunk loop bounds in-flight count
  // (memory) and gives us a natural cadence for the per-100-rows
  // stderr progress line.
  const concurrency =
    opts.services.config.notion?.rateLimit?.concurrency ?? DEFAULT_NOTION_CONCURRENCY
  let written = 0
  let processed = 0
  let nextProgressMark = 100
  const failures: BackfillFactObservedAtFailure[] = []
  for (let i = 0; i < plan.rowsToBackfill.length; i += concurrency) {
    const batch = plan.rowsToBackfill.slice(i, i + concurrency)
    const settled = await Promise.allSettled(
      batch.map((row) =>
        opts.services.facts.applyObservedAtBackfill(row.factId, {
          observedAt: row.observedAtToWrite,
          invalidatedAt: row.invalidatedAtToWrite,
        })
      )
    )
    settled.forEach((result, idx) => {
      processed += 1
      if (result.status === "fulfilled") {
        written += 1
      } else {
        const row = batch[idx]!
        const message =
          result.reason instanceof Error ? result.reason.message : String(result.reason)
        failures.push({ factId: row.factId, message })
      }
    })
    if (processed >= nextProgressMark) {
      process.stderr.write(
        `[lore] backfill-fact-observed-at: ${processed}/${plan.rowsToBackfill.length} ` +
          `(${written} written, ${failures.length} failed)\n`
      )
      nextProgressMark = Math.floor(processed / 100) * 100 + 100
    }
  }
  return { written, failures }
}
