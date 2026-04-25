/**
 * Tracking-fact → task migration (P3-02).
 *
 * Walks every live tracking-predicate fact (`needs_action`, `waiting_on`,
 * `blocked_by`), creates a task memory whose Title is the fact Subject
 * and whose body is the fact Object, then invalidates the source fact so
 * it stops surfacing in `lore-open-loops` / `lore-ask`'s Tracking bucket.
 *
 * Preserves provenance: the original fact's `sourceMemoryId` becomes the
 * task's `affectsIds` so `lore-ask(entity)` on the task surfaces the
 * memory that motivated it. The original fact's `Valid From` becomes the
 * task's `decidedAt` (the canonical capture date) and the fact's
 * `Review By` becomes the task's `dueDate` so overdue rows stay overdue
 * in the new model.
 *
 * Plan-then-execute (`--yes` to apply) — same posture the fact-encoding
 * and dedup-merge migrations use. Idempotent: invalidated facts are
 * filtered out of the next run, and live facts that were already
 * migrated have a `task_migration_id` keyword on the resulting task —
 * but we don't carry that pointer in either direction because Notion
 * doesn't expose a server-side filter on the keywords field; we rely on
 * the invalidate step to gate re-runs instead.
 */

import type { Fact, FactPredicate, TaskState } from "../types.js"
import { TRACKING_PREDICATES } from "../types.js"
import type { FactService } from "./fact.js"
import type { TaskService } from "./task.js"

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

export interface TrackingFactMigrationResult {
  /**
   * One row per fact considered for migration. `taskId === null` when
   * the fact was planned but not written (dry-run, plan-only) or when
   * the create step failed — see `errors`.
   */
  plans: Array<TrackingFactMigrationPlan & { taskId: string | null }>
  /**
   * Per-fact errors. The migration treats each fact independently so a
   * single Notion 5xx doesn't sink the whole run. Errors are logged and
   * the surviving plans complete.
   */
  errors: Array<{ factId: string; message: string }>
  /** Count of facts whose source was invalidated post-migration. */
  invalidated: number
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
      // Entity defaults to subject so `lore-ask(subject)` and the
      // `lore-tasks` entity filter both find migrated rows.
      entity: fact.subject,
      dueDate: fact.reviewBy ?? undefined,
      // Provenance: carry the source memory forward so `lore-ask` can
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
 * don't collapse the whole run; the migration is idempotent because
 * invalidated facts drop out of the next pass.
 */
export async function migrateTrackingFactsToTasks(
  facts: FactService,
  tasks: TaskService,
  options: MigrateOptions
): Promise<TrackingFactMigrationResult> {
  const planOnly = !options.apply || options.dryRun === true
  const errors: Array<{ factId: string; message: string }> = []
  const plans: Array<TrackingFactMigrationPlan & { taskId: string | null }> = []
  let invalidated = 0

  // Use the existing `queryBySubject("")` shape because it already
  // honors the predicate filter and paginates. The wake-up partition
  // pattern (server-side filter) is exactly what we want here.
  const candidates = await facts.queryBySubject("", {
    projectId: options.projectId,
    predicates: TRACKING_PREDICATES,
    limit: options.limit,
  })

  for (const fact of candidates) {
    const plan = planTaskFromFact(fact)

    if (planOnly) {
      plans.push({ ...plan, taskId: null })
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
        // which rows came from this migration. Stays in `keywords`
        // (free-form), not `tags` (closed vocabulary).
        keywords: `migrated-from-fact ${fact.id}`,
      })

      // Invalidate the source fact so it stops surfacing in
      // `lore-open-loops` / `lore-ask` Tracking. Soft-deletes it; the
      // history is preserved.
      await facts.invalidate(fact.id)
      invalidated += 1
      plans.push({ ...plan, taskId: task.id })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ factId: fact.id, message })
      plans.push({ ...plan, taskId: null })
    }
  }

  return { plans, errors, invalidated, planOnly }
}
