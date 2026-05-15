import type { DecisionSummary, ListTasksOpts, TaskSummary } from "../types.js"
import { STALE_TASK_DAYS } from "../types.js"
import { taskDaysOverdue, taskDaysStale } from "./task.js"
import { NOTION_PAGE_SIZE, WAKEUP_TASK_OVERFETCH_MULTIPLIER } from "./wakeup-constants.js"

/**
 * Compute the per-bucket row cap for wake-up task queries. Single source of
 * truth shared by `loadWakeUpData` and the MCP renderer's saturation
 * fallback. Returns `0` when `taskLimit` is `0` or negative — the caller
 * skips task queries entirely in that case.
 *
 * The result stays bounded by Notion's per-page ceiling so each bucket is
 * predictable on the wake-up hot path.
 */
export function computeTasksFetchLimit(taskLimit: number): number {
  return taskLimit > 0
    ? Math.min(NOTION_PAGE_SIZE, taskLimit * WAKEUP_TASK_OVERFETCH_MULTIPLIER)
    : 0
}

export interface WakeUpTaskBucketCoverage {
  overdueCapped: boolean
  staleCapped: boolean
  activeCapped: boolean
}

export async function loadWakeUpTaskWindow(
  tasks: {
    list(
      opts?: ListTasksOpts
    ): Promise<{ items: TaskSummary[]; nextCursor?: string; capped?: boolean }>
  },
  opts: { projectId: string; today: string; limit: number }
): Promise<{ tasks: TaskSummary[]; coverage: WakeUpTaskBucketCoverage }> {
  // Three bounded windows are intentional. Notion gives one sort order
  // per query, while wake-up needs the soonest overdue rows, the oldest
  // non-overdue rows for Stale, and the newest non-overdue rows for
  // Active. Collapsing these would reintroduce the null-date starvation
  // this loader exists to prevent.
  const [overdueWindow, staleCandidatesWindow, activeCandidatesWindow] =
    await Promise.all([
      tasks.list({
        projectId: opts.projectId,
        dueBefore: opts.today,
        limit: opts.limit,
        sortBy: "reviewByAsc",
      }),
      tasks.list({
        projectId: opts.projectId,
        dueAfterOrEmpty: opts.today,
        limit: opts.limit,
        sortBy: "updatedAtAsc",
      }),
      tasks.list({
        projectId: opts.projectId,
        dueAfterOrEmpty: opts.today,
        limit: opts.limit,
        sortBy: "updatedAtDesc",
      }),
    ])

  const overdue = overdueWindow.items.filter(
    (task) => taskDaysOverdue(task, opts.today) !== null
  )
  const stale = staleCandidatesWindow.items.filter((task) => {
    if (taskDaysOverdue(task, opts.today) !== null) return false
    const staleDays = taskDaysStale(task, opts.today)
    return staleDays !== null && staleDays >= STALE_TASK_DAYS
  })
  const active = activeCandidatesWindow.items.filter((task) => {
    if (taskDaysOverdue(task, opts.today) !== null) return false
    const staleDays = taskDaysStale(task, opts.today)
    return staleDays === null || staleDays < STALE_TASK_DAYS
  })

  return {
    tasks: dedupeTaskBuckets([overdue, stale, active]),
    coverage: {
      overdueCapped: taskWindowCapped(overdueWindow),
      // Candidate-window saturation alone is not enough for Stale /
      // Active lower-bound claims. Because the two candidate queries
      // sort away from the opposite bucket, a saturated window with
      // fewer than `limit` survivors means later pages cannot fill that
      // bucket.
      staleCapped: taskWindowCapped(staleCandidatesWindow) && stale.length >= opts.limit,
      activeCapped:
        taskWindowCapped(activeCandidatesWindow) && active.length >= opts.limit,
    },
  }
}

function dedupeTaskBuckets(buckets: TaskSummary[][]): TaskSummary[] {
  // Current filters make overlap structurally impossible, but keep the
  // merge defensive against future filter loosening, timezone edge cases,
  // or eventual-consistency duplicates from Notion.
  const seen = new Set<string>()
  const merged: TaskSummary[] = []
  for (const bucket of buckets) {
    for (const task of bucket) {
      if (seen.has(task.id)) continue
      seen.add(task.id)
      merged.push(task)
    }
  }
  return merged
}

function taskWindowCapped(window: {
  items: TaskSummary[]
  nextCursor?: string
  capped?: boolean
}): boolean {
  return Boolean(window.capped || window.nextCursor)
}

export function emptyTaskBucketCoverage(): WakeUpTaskBucketCoverage {
  return {
    overdueCapped: false,
    staleCapped: false,
    activeCapped: false,
  }
}

export async function queryOverdueDecisionWindow(
  decisions: {
    queryOverdueWindow?(opts?: {
      projectId?: string
      limit?: number
    }): Promise<{ items: DecisionSummary[]; capped: boolean }>
    queryOverdue(opts?: {
      projectId?: string
      limit?: number
    }): Promise<DecisionSummary[]>
  },
  opts: { projectId?: string }
): Promise<{ items: DecisionSummary[]; capped: boolean }> {
  if (typeof decisions.queryOverdueWindow === "function") {
    return decisions.queryOverdueWindow(opts)
  }
  return { items: await decisions.queryOverdue(opts), capped: false }
}
