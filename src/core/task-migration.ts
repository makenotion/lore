/**
 * Tracking-fact → task migration (P3-02).
 *
 * Walks every live tracking-predicate fact (`needs_action`, `waiting_on`,
 * `blocked_by`), creates a task memory whose Title is the fact Subject
 * and whose body is the fact Object, then invalidates the source fact so
 * it stops surfacing in `lore-query action='open-loops'` /
 * `lore-query action='ask'`'s Tracking bucket.
 *
 * Preserves provenance: the original fact's `sourceMemoryId` becomes the
 * task's `affectsIds` so `lore-query action='ask'` on the task surfaces the
 * memory that motivated it. The original fact's `Valid From` becomes the
 * task's `decidedAt` (the canonical capture date) and the fact's
 * `Review By` becomes the task's `dueDate` so overdue rows stay overdue
 * in the new model.
 *
 * Plan-then-execute (`--yes` to apply) — same posture the fact-encoding
 * and dedup-merge migrations use.
 *
 * **Idempotent on rerun (PF3-07).** Two failure modes are handled:
 *
 * 1. The fact's invalidate step landed last run — the fact drops out of
 *    the candidate query because invalidated facts are filtered.
 * 2. The task created last run but the invalidate failed (network blip,
 *    rate limit) — the candidate query *still surfaces* the fact, but
 *    the bulk `findMigratedFactIds` pre-fetch carries a marker pointing
 *    at the existing task. The migration skips create, points the plan
 *    row at the existing task id, and **retries the invalidate** so a
 *    half-completed prior run heals deterministically.
 *
 * Both paths keep the fact-id encoded in the task's `Keywords` column
 * via `migrated-from-fact <factId>` (built by `buildMigrationKeyword`).
 *
 * **Not concurrent-safe across operators.** Notion has no conditional-
 * write or unique-index primitive, mirroring the `FactService.create`
 * caveat. Two operators running the apply pass simultaneously can both
 * read empty markers for the same fact, both create a task, and end up
 * with a duplicate the next pass can't sort out (both would then carry
 * `migrated-from-fact <factId>` and the rerun's first-write-wins map
 * would pick one arbitrarily). Run the migration from one operator at
 * a time; the existing `lore migrate --dedup-keys --merge --yes` pass
 * is the authoritative collapse if duplicates do slip through.
 *
 * **First-real-run runbook for the heal path.** The unit tests pin the
 * heal path at the function-call level, but the full create-fail-rerun
 * cycle is materially mutating in production. Before scaling the
 * migration to a vault with hundreds of tracking facts, exercise the
 * heal path end-to-end on a low-stakes project once:
 *
 *   1. Pick a project with ≤ 5 tracking facts (use
 *      `lore-query action='open-loops'` to count).
 *   2. Run `lore migrate --migrate-tracking-to-tasks` (plan-only) to
 *      capture a baseline plan. Verify the row count matches step 1.
 *   3. Run `lore migrate --migrate-tracking-to-tasks --yes`. Note
 *      every printed task id and source fact id in the operator log.
 *   4. Pick one of the now-invalidated facts and re-validate it via
 *      Notion (clear `Valid Until`) to simulate the failed-invalidate
 *      state. The task page exists with a `migrated-from-fact <id>`
 *      keyword; the source fact is live again.
 *   5. Re-run `lore migrate --migrate-tracking-to-tasks --yes`. The
 *      report MUST read `Migrated 0 tracking facts` and `Found 1 fact
 *      already migrated — skipped task creation and re-attempted
 *      invalidation`. No new task page should appear in the Memories
 *      DB; the source fact should once again be invalidated.
 *
 * That's the cheapest exercise that touches every code path the unit
 * tests pin individually (pre-fetch, marker parse, skip-create, heal
 * invalidate). Failing step 5's expected output is the canary that
 * the heal path silently regressed and demands an investigation
 * before any broader rollout.
 */

import type { Fact, FactPredicate, TaskState } from "../types.js"
import { TRACKING_PREDICATES } from "../types.js"
import type { FactService } from "./fact.js"
import { buildMigrationKeyword, type TaskService } from "./task.js"

/**
 * Recognise the specific Notion validation error that fires when a
 * pre-schema-migration vault doesn't yet have `task` as a `Kind`
 * select option. Used to soften `findMigratedFactIds` on a vault
 * the operator hasn't run `lore migrate` against — that path can't
 * have migrated tasks regardless, so empty map is the right answer.
 *
 * Deliberately narrow: every other error class (`rate_limited`,
 * network blips, anything not pointing at the missing option) keeps
 * propagating so an idempotency lookup that genuinely failed doesn't
 * silently degrade into "no idempotency, may double-create."
 */
function isMissingTaskKindOptionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: unknown }).code
  if (code !== "validation_error") return false
  return /option\s+"task"\s+not\s+found/i.test(err.message)
}

export interface TrackingFactMigrationPlan {
  fact: Fact
  /** Task properties we'll write — surfaces in plan output. */
  task: {
    subject: string
    state: TaskState
    blockedBy?: string
    entity: string
    dueDate?: string
    affectsIds: string[]
  }
}

/**
 * Plan row carrying the migration outcome alongside the source fact and
 * proposed task properties. `taskId` is non-null both for fresh creates
 * and for rerun heal paths that bind to an existing task; the
 * `alreadyMigrated` flag distinguishes the two so plan output and
 * metrics can render them separately.
 */
export type MigrationPlanRow = TrackingFactMigrationPlan & {
  /**
   * The task this fact binds to. `null` only when the fact was planned
   * but not written (plan-only / dry-run, or the create step failed).
   * For already-migrated facts this is the *existing* task id from the
   * keyword marker.
   */
  taskId: string | null
  /**
   * True when the fact was bound to an existing task on rerun (a prior
   * apply pass created the task but failed at the invalidate step).
   * Plan-only mode still flags this so operators see what would be
   * skipped, not just what would be created.
   */
  alreadyMigrated: boolean
}

export interface TrackingFactMigrationResult {
  /**
   * One row per fact considered for migration. See `MigrationPlanRow`
   * for the `taskId` / `alreadyMigrated` semantics.
   */
  plans: MigrationPlanRow[]
  /**
   * Per-fact errors. The migration treats each fact independently so a
   * single Notion 5xx doesn't sink the whole run. Errors are logged and
   * the surviving plans complete.
   */
  errors: Array<{ factId: string; message: string }>
  /**
   * Count of facts whose source was invalidated this pass. Includes
   * fresh migrations *and* rerun heal paths that retried an
   * invalidation a prior run failed.
   */
  invalidated: number
  /**
   * Count of facts already migrated by a prior pass — bound to an
   * existing task via the `migrated-from-fact <factId>` keyword
   * marker. Distinguished from `plans.length` so the plan summary can
   * report "N migrated, M already done" without a second pass over
   * the rows.
   */
  alreadyMigrated: number
  /** True when the run was plan-only (`--dry-run` or no `--yes`). */
  planOnly: boolean
}

/**
 * Map a tracking predicate to its corresponding initial task state.
 *
 * - `needs_action` → `open` (someone needs to do this)
 * - `waiting_on`   → `open` (the work isn't blocked by an external
 *                    dependency we can name; it's waiting for a person
 *                    or process). Earlier drafts modeled this as
 *                    `blocked` with the Object as `blockedBy`, but the
 *                    spec rule is clearer: `waiting_on` becomes `open`
 *                    plus `Blocked By` so the *task lifecycle* doesn't
 *                    falsely mark every waiting row as blocked.
 * - `blocked_by`   → `blocked` (explicit external dependency; the
 *                    Object names the blocker, which we move to the
 *                    `Blocked By` column).
 */
export function trackingPredicateToTaskState(predicate: FactPredicate): TaskState {
  return predicate === "blocked_by" ? "blocked" : "open"
}

/**
 * Build the migration plan for a single fact. Pure — no Notion calls.
 * Exported so the CLI can render a preview before any writes happen.
 */
export function planTaskFromFact(fact: Fact): TrackingFactMigrationPlan {
  const state = trackingPredicateToTaskState(fact.predicate)
  // For `blocked_by` we move the Object into `Blocked By` (it names the
  // blocker, which is exactly what that column is for). For `waiting_on`
  // we mirror the same — the Object describes who/what the row is
  // waiting on, which is the blocker semantically. For `needs_action`
  // the Object IS the work description, so leave Blocked By empty.
  const blockedBy =
    fact.predicate === "blocked_by" || fact.predicate === "waiting_on"
      ? fact.object
      : undefined

  return {
    fact,
    task: {
      subject: fact.subject,
      state,
      blockedBy,
      // Entity defaults to subject so `lore-query action='ask'` and the
      // `lore-task action='list'` entity filter both find migrated rows.
      entity: fact.subject,
      dueDate: fact.reviewBy ?? undefined,
      // Provenance: carry the source memory forward so
      // `lore-query action='ask'` can
      // still retrace the reasoning. Empty array when the fact is
      // orphan (one of the orphan-fact backlog items in the Mail vault).
      affectsIds: fact.sourceMemoryId ? [fact.sourceMemoryId] : [],
    },
  }
}

export interface MigrateOptions {
  apply: boolean
  dryRun?: boolean
  /**
   * Optional cap for testing / staged rollouts. `undefined` walks every
   * matching fact across pages.
   */
  limit?: number
  projectId?: string
}

/**
 * Convert every live tracking-predicate fact into a task memory and
 * invalidate the source fact. Operates per-fact so transient errors
 * don't collapse the whole run.
 *
 * **Idempotency hinge.** Before iterating, the migration bulk-loads
 * `factId → taskId` for every existing migration-marked task in the
 * vault. A candidate fact that's already in the map *was* migrated by
 * a prior run that crashed before the invalidate step landed — the
 * heal path re-attempts the invalidate but never re-creates the task.
 * Fresh candidates take the standard create-then-invalidate path.
 */
export async function migrateTrackingFactsToTasks(
  facts: FactService,
  tasks: TaskService,
  options: MigrateOptions
): Promise<TrackingFactMigrationResult> {
  const planOnly = !options.apply || options.dryRun === true
  const errors: Array<{ factId: string; message: string }> = []
  const plans: MigrationPlanRow[] = []
  let invalidated = 0
  let alreadyMigrated = 0

  // Use the existing `queryBySubject("")` shape because it already
  // honors the predicate filter and paginates. The wake-up partition
  // pattern (server-side filter) is exactly what we want here.
  const candidates = await facts.queryBySubject("", {
    projectId: options.projectId,
    predicates: TRACKING_PREDICATES,
    limit: options.limit,
  })

  // Pre-fetch the migration marker map. One paginated query covers any
  // number of candidates — server-side filtered to `Kind = task` AND
  // `Keywords contains "migrated-from-fact"` so we read only the rows
  // we'd actually consult. Skipped on a clean vault when no candidate
  // facts exist, since the loop below has nothing to look up.
  //
  // Validation-error fallback: a pre-schema-migration vault has no
  // `task` option on the `Kind` select column yet, so the filter
  // rejects with `validation_error`. In that scenario there cannot be
  // any migrated tasks (none could have been written), so an empty map
  // is the correct value — we just can't have asked Notion for it.
  // Any other error re-throws so genuine failures (rate limit, network)
  // don't silently degrade to "no idempotency, may double-create."
  let migrationMap = new Map<string, string>()
  if (candidates.length > 0) {
    try {
      migrationMap = await tasks.findMigratedFactIds()
    } catch (err) {
      if (isMissingTaskKindOptionError(err)) {
        // Vault hasn't had schema migration applied. Empty map is
        // correct: no migrated tasks can exist yet.
      } else {
        throw err
      }
    }
  }

  for (const fact of candidates) {
    const plan = planTaskFromFact(fact)
    const existingTaskId = migrationMap.get(fact.id)

    if (existingTaskId !== undefined) {
      // Already migrated by a prior run. Avoid the duplicate create.
      alreadyMigrated += 1
      if (planOnly) {
        plans.push({ ...plan, taskId: existingTaskId, alreadyMigrated: true })
        continue
      }
      // Heal path: the prior run created the task but the invalidate
      // failed (otherwise the fact wouldn't be a candidate this pass).
      // Retry the invalidate; if it fails again, surface the error and
      // move on so the next pass can retry once more.
      try {
        await facts.invalidate(fact.id)
        invalidated += 1
        plans.push({ ...plan, taskId: existingTaskId, alreadyMigrated: true })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errors.push({ factId: fact.id, message })
        plans.push({ ...plan, taskId: existingTaskId, alreadyMigrated: true })
      }
      continue
    }

    if (planOnly) {
      plans.push({ ...plan, taskId: null, alreadyMigrated: false })
      continue
    }

    try {
      const task = await tasks.create({
        subject: plan.task.subject,
        // Body carries the original Object verbatim so no information
        // is lost. For `needs_action` this is the actual ticket
        // description — the whole reason this migration exists.
        description: fact.object,
        entity: plan.task.entity,
        state: plan.task.state,
        blockedBy: plan.task.blockedBy,
        dueDate: plan.task.dueDate,
        affectsIds: plan.task.affectsIds,
        projectIds: fact.projectIds.length > 0 ? fact.projectIds : undefined,
        confidence: fact.confidence,
        // Tag the task so an operator browsing the Memories DB sees
        // which rows came from this migration, and so a partial-failure
        // rerun finds the existing row before re-creating it. Stays in
        // `keywords` (free-form), not `tags` (closed vocabulary).
        keywords: buildMigrationKeyword(fact.id),
      })

      // Invalidate the source fact so it stops surfacing in
      // `lore-query action='open-loops'` / `lore-query action='ask'`
      // Tracking. Soft-deletes it; the
      // history is preserved. If this throws, the next migration pass
      // catches the orphaned task via `findMigratedFactIds` and retries
      // the invalidate — no duplicate task lands.
      await facts.invalidate(fact.id)
      invalidated += 1
      plans.push({ ...plan, taskId: task.id, alreadyMigrated: false })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ factId: fact.id, message })
      plans.push({ ...plan, taskId: null, alreadyMigrated: false })
    }
  }

  return { plans, errors, invalidated, alreadyMigrated, planOnly }
}
