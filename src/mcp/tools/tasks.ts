/**
 * Task tools (P3-02 + PF3-06).
 *
 * Tasks are the canonical surface for tracked work. The polymorphic
 * `lore-task` dispatcher is action-routed across
 * `create` / `update` / `close` / `list` — matching the rest of the
 * P3-01 polymorphic family (`lore-memory`, `lore-decision`, etc.).
 *
 * Each handler is a thin orchestration layer over `services.tasks`
 * (`TaskService`) plus project-name resolution; the heavy lifting —
 * schema, defaults, Notion calls — lives in `src/core/task.ts`.
 */

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import {
  debugLogPartialFailures,
  formatDispatchError,
  paginationFooter,
  toolError,
} from "../helpers.js"
import { resolveProjectIds } from "../resolve.js"
import { tagsSchema, keywordsSchema } from "./tag-schema.js"
import { taskDaysOverdue } from "../../core/task.js"
import { findDuplicateActiveTasks } from "../../core/near-duplicate.js"
import { renderTrustLine, truncateSynopsis } from "../render.js"
import {
  reconcileActiveTasks,
  formatReconcileOutput,
  DEFAULT_RECONCILE_LIMIT,
  DEFAULT_RECONCILE_MIN_SCORE,
  MAX_RECONCILE_LIMIT,
} from "../../core/task-reconcile.js"
import { ACTIVE_TASK_STATES, SYNOPSIS_MAX } from "../../types.js"
import type { ListTasksOpts, TaskState, TaskSummary } from "../../types.js"

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

const TASK_STATES = ["open", "in-progress", "blocked", "done", "cancelled"] as const

const CLOSE_STATES = ["done", "cancelled"] as const

const CONFIDENCES = ["certain", "likely", "speculative"] as const

const YMD_REGEX = /^\d{4}-\d{2}-\d{2}$/

/**
 * Default cap for `lore-task action='list'` listings. Per-section,
 * not total — Overdue and Active render independently so a vault with
 * many overdue tasks still surfaces some active ones above the cap.
 */
const DEFAULT_TASKS_LIMIT = 10
const TASK_LIST_FETCH_MULTIPLIER = 4
const TASK_LIST_DEEP_WALK_MIN_LIMIT = 26
const TASK_LIST_PAGE_SIZE = 100
const MAX_TASK_LIST_PAGES = 10

const OVERDUE_SEVERE_DAYS = 14
const OVERDUE_MILD_DAYS = 1

function urgencyMarker(days: number): string {
  if (days >= OVERDUE_SEVERE_DAYS) return "⚠⚠ "
  if (days >= OVERDUE_MILD_DAYS) return "⚠ "
  return ""
}

/**
 * Format a single task row for listing surfaces. Overdue rows lead with
 * an urgency marker and a `(N days overdue)` suffix; in-window rows show
 * their due date plainly. The `Blocked By` column is appended only when
 * non-empty so untouched fields don't visually clutter the output.
 *
 * When `includeSynopsis` is true (default), a non-empty `synopsis` is
 * rendered as an indented line between the title row and the `ID:`
 * line so the agent sees a one-line gist on the listing without paying
 * a body fetch. Synopses are defensively truncated at `SYNOPSIS_MAX`
 * via the shared helper, mirroring `formatMemoryListItem`'s discipline
 * for over-cap rows that landed via legacy / migration paths.
 *
 * Trust indicator (DEFERRED-01 follow-up to 0.8.0/#09): when the row's
 * stored `Confidence Score` is below `CONFIDENCE_DISPLAY_THRESHOLD`, an
 * indented italic label lands between the title row and the synopsis,
 * matching the placement in `formatMemoryListItem`. Null and above-
 * threshold rows render byte-identically — pre-migration vaults look
 * unchanged until `lore migrate --build-confidence-scores` populates
 * scores. NOT gated by `includeSynopsis`: trust is system metadata,
 * not synopsis content; the two surfaces are independent.
 */
function formatTaskRow(
  t: TaskSummary,
  today: string,
  options: { includeSynopsis?: boolean } = {},
): string {
  const overdueDays = taskDaysOverdue(t, today)
  const marker = overdueDays !== null ? urgencyMarker(overdueDays) : ""
  const stateLabel = t.taskState ?? "open"
  const due =
    overdueDays !== null && t.reviewBy
      ? overdueDays === 0
        ? `due today (review by ${t.reviewBy})`
        : `${overdueDays} day${overdueDays === 1 ? "" : "s"} overdue (review by ${t.reviewBy})`
      : t.reviewBy
        ? `due ${t.reviewBy}`
        : "no due date"
  const blocked = t.blockedBy ? ` — blocked by ${t.blockedBy}` : ""
  const overduePart = overdueDays !== null ? ` **(${due})**` : ` (${due})`
  const includeSynopsis = options.includeSynopsis !== false
  const synopsisLine =
    includeSynopsis && t.synopsis.trim() ? `  ${truncateSynopsis(t.synopsis)}\n` : ""
  const trustLineText = renderTrustLine(t.confidenceScore, "  ")
  const trustLine = trustLineText !== null ? `${trustLineText}\n` : ""
  return (
    `- ${marker}**${t.title}** [${stateLabel}]${blocked}${overduePart}\n` +
    trustLine +
    synopsisLine +
    `  ID: ${t.id}`
  )
}

// ---------------------------------------------------------------------------
// Handlers — one per `lore-task` action (create | update | close | list).
// Routed by the polymorphic dispatcher's discriminated union.
// ---------------------------------------------------------------------------

interface CreateArgs {
  subject: string
  description?: string
  entity?: string
  state?: (typeof TASK_STATES)[number]
  blockedBy?: string
  dueDate?: string
  affectsIds?: string[]
  projectName?: string
  projectNames?: string[]
  topicName?: string
  forceNewTopic?: boolean
  confidence?: (typeof CONFIDENCES)[number]
  tags?: string[]
  keywords?: string
  synopsis?: string
  author?: string
  agent?: string
  session?: string
}

async function handleCreate(
  services: LoreServices,
  args: CreateArgs,
): Promise<ToolResult> {
  try {
    // A `blocked` task with no `blockedBy` label is useless to
    // triage — the row says "I'm blocked" without naming the
    // blocker. Reject at the boundary rather than letting the empty
    // row land. The migration path explicitly populates `Blocked By`
    // when porting `blocked_by` / `waiting_on` facts, so this guard
    // only fires on fresh agent calls; cross-field, so it can't live
    // on the per-field Zod map.
    if (args.state === "blocked" && !args.blockedBy) {
      throw new Error(
        "state: \"blocked\" requires a `blockedBy` label naming the dependency " +
          "(PR number, person, external service). A blocked task with no blocker is " +
          "unactionable. Pass `blockedBy` or use state: \"open\" if no specific blocker exists.",
      )
    }
    const resolved = await resolveProjectIds(services, args.projectName, args.projectNames)

    let topicId: string | undefined
    let topicLabel = "none"
    if (args.topicName && resolved.ids.length > 0) {
      const topic = await services.topics.getOrCreate(args.topicName, resolved.ids, {
        forceNew: args.forceNewTopic,
      })
      topicId = topic.id
      topicLabel = topic.name
    }

    // Probe runs in parallel with the create — sequencing them would double
    // wall-clock latency on the hot write path. The just-created row is
    // filtered out post-resolve (the helper can't know task.id at probe-fire).
    // Probe is advisory: failures return [] silently and never block the create,
    // and the wasted query on a rejecting create is the deliberate parallelism cost.
    const probeEntity = args.entity ?? args.subject
    const [task, duplicates] = await Promise.all([
      services.tasks.create({
        subject: args.subject,
        description: args.description,
        entity: args.entity,
        state: args.state as TaskState | undefined,
        blockedBy: args.blockedBy,
        dueDate: args.dueDate,
        affectsIds: args.affectsIds,
        projectIds: resolved.ids.length > 0 ? resolved.ids : undefined,
        topicId,
        confidence: args.confidence,
        tags: args.tags,
        keywords: args.keywords,
        synopsis: args.synopsis,
        // DEFERRED-ATTRIBUTION: explicit caller override wins; otherwise
        // default to the engineer-identity resolved at server startup.
        // `services.identity` is required on the type — null `author`
        // means neither `LORE_USER_NAME` nor `users.me` produced a
        // usable name; collapse to undefined so the column stays empty.
        author: args.author ?? services.identity.author ?? undefined,
        agent: args.agent,
        session: args.session,
      }),
      findDuplicateActiveTasks(services.tasks, {
        entity: probeEntity,
        projectId: resolved.ids[0],
        onError: (err) =>
          debugLogPartialFailures("lore-task", [
            { rootId: "duplicate-probe", error: err },
          ]),
      }),
    ])

    // Post-filter the just-created row out of the probe results. This
    // is the SOLE exclusion mechanism — the parallel posture means
    // `findDuplicateActiveTasks` can't know `task.id` at probe-fire
    // time, so the helper performs no exclusion of its own. Closes
    // the eventual-consistency race between create and the query
    // index; same posture as the memory near-dup probe. The footer's
    // `(${filteredDuplicates.length})` count derives from this filtered
    // list, not the raw probe response — agent sees the same N rows
    // and the same N in the heading.
    const filteredDuplicates = duplicates.filter((t) => t.id !== task.id)

    // Record for `lore-fact action='create'` session auto-link,
    // mirroring how `lore-memory` action='save' and
    // `lore-decision` action='create' plant a session pointer so a
    // later fact can auto-link this task as its source.
    services.sessionMemories.record(
      { agent: args.agent, session: args.session },
      { memoryId: task.id, projectIds: task.projectIds },
    )

    const projectLabel = resolved.ids.length
      ? (args.projectNames?.join(", ") ?? args.projectName ?? services.context.project?.name ?? "auto-detected")
      : "none (repo-wide)"

    const lines = [
      `Created task: "${task.title}" (${task.id})`,
      `State: ${task.taskState ?? "open"}`,
      `Project: ${projectLabel}`,
      `Topic: ${topicLabel}`,
    ]
    if (task.entity && task.entity !== task.title) {
      lines.push(`Entity: ${task.entity}`)
    }
    if (task.reviewBy) {
      lines.push(`Due: ${task.reviewBy}`)
    }
    if (task.blockedBy) {
      lines.push(`Blocked by: ${task.blockedBy}`)
    }
    if (resolved.warnings.length > 0) {
      lines.push(`Warnings: ${resolved.warnings.join("; ")}`)
    }

    // Duplicates footer precedes the closure CTA. Per the 0.7.0
    // coordination note, the response reads `[duplicates footer] →
    // [closure CTA]` so the singleton CTA acts as the closing visual
    // beat after the per-duplicate close incantations. The order-pin
    // fixture asserts every close-incantation line appears at-or-after
    // the duplicates header; inverting the blocks fails the assertion
    // loudly.
    if (filteredDuplicates.length > 0) {
      lines.push("")
      lines.push(
        `Other active tasks tracking "${probeEntity}" ` +
          `(${filteredDuplicates.length}) — close any that are obsolete:`,
      )
      for (const dup of filteredDuplicates) {
        const stateLabel = dup.taskState ?? "open"
        lines.push(
          `  - "${dup.title}" [${stateLabel}] — ` +
            `lore-task({ action: 'close', taskId: '${dup.id}' })`,
        )
      }
    }

    lines.push(
      `\nClose this task when the work is done: ` +
        `lore-task({ action: 'close', taskId: '${task.id}' })`,
    )

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    }
  } catch (err) {
    return toolError(err)
  }
}

interface UpdateArgs {
  taskId: string
  state?: (typeof TASK_STATES)[number]
  blockedBy?: string
  entity?: string
  dueDate?: string
  subject?: string
  description?: string
  tags?: string[]
  keywords?: string
  synopsis?: string
}

async function handleUpdate(
  services: LoreServices,
  args: UpdateArgs,
): Promise<ToolResult> {
  try {
    // Validate dueDate manually so `""` (clear-the-date) is allowed
    // without inflating the Zod schema. A malformed non-empty value
    // is rejected before it hits Notion.
    let dueDateValue: string | null | undefined
    if (args.dueDate === undefined) {
      dueDateValue = undefined
    } else if (args.dueDate === "") {
      dueDateValue = null
    } else if (!YMD_REGEX.test(args.dueDate)) {
      throw new Error(`dueDate must be YYYY-MM-DD or empty string, got "${args.dueDate}"`)
    } else {
      dueDateValue = args.dueDate
    }

    // Mirror create's `state: "blocked"` requirement: if the caller
    // is transitioning into `blocked`, they must name the blocker
    // in the same call. This conservative check trips even when the
    // task already has a `Blocked By` value from a prior write —
    // restating the blocker on every transition is explicit and
    // cheap, and avoids a pre-read round-trip that would otherwise
    // be needed to inspect the existing column. Setting an empty
    // string explicitly clears it; that's still a valid combination
    // with non-`blocked` states, just not with `state: "blocked"`.
    if (args.state === "blocked" && (args.blockedBy === undefined || args.blockedBy === "")) {
      throw new Error(
        "Transitioning to state: \"blocked\" requires a `blockedBy` label in the same call. " +
          "A blocked task with no blocker is unactionable; restate the blocker explicitly even if " +
          "the row already had one set.",
      )
    }

    const updated = await services.tasks.update(args.taskId, {
      state: args.state as TaskState | undefined,
      blockedBy: args.blockedBy,
      entity: args.entity,
      dueDate: dueDateValue,
      subject: args.subject,
      description: args.description,
      tags: args.tags,
      keywords: args.keywords,
      synopsis: args.synopsis,
    })

    const lines = [
      `Updated task: "${updated.title}" (${updated.id})`,
      `State: ${updated.taskState ?? "open"}`,
    ]
    if (updated.reviewBy) lines.push(`Due: ${updated.reviewBy}`)
    if (updated.blockedBy) lines.push(`Blocked by: ${updated.blockedBy}`)
    // Echo the entity so a rename (e.g. canonicalizing
    // "PR 25750" → "PR-25750") is observable in the response,
    // mirroring the create path's echo line.
    if (updated.entity && updated.entity !== updated.title) {
      lines.push(`Entity: ${updated.entity}`)
    }

    // Closure CTA suppressed on terminal-state updates — an agent that
    // closed via `update({ state: "done" })` doesn't need "close this
    // task" repeated to them. `update` to a terminal state is a
    // close-shaped operation; same Done At stamp ships in the same atom
    // as the state write (see TaskService.update / TaskService.close).
    const updatedState = updated.taskState ?? "open"
    if (updatedState !== "done" && updatedState !== "cancelled") {
      lines.push(
        `\nClose this task when the work is done: ` +
          `lore-task({ action: 'close', taskId: '${updated.id}' })`,
      )
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    }
  } catch (err) {
    return toolError(err)
  }
}

interface CloseArgs {
  taskId: string
  state?: (typeof CLOSE_STATES)[number]
}

async function handleClose(
  services: LoreServices,
  args: CloseArgs,
): Promise<ToolResult> {
  try {
    const closingState: "done" | "cancelled" = args.state ?? "done"
    await services.tasks.close(args.taskId, closingState)

    // Re-read the post-close row so the response can echo the stamped
    // `Done At` (issue 0.7.0/07). On a vault that hasn't migrated the
    // Memories DS to add the column, `extractDate` returns `null` and
    // we suppress the line — graceful degradation, no version gate.
    let doneAt: string | null = null
    try {
      const reread = await services.tasks.getById(args.taskId)
      doneAt = reread.doneAt
    } catch {
      // Ignore re-read failures: the close itself succeeded, and the
      // Done At echo is a courtesy line. A transient 5xx shouldn't
      // mask the close confirmation.
    }

    const text =
      `Closed task ${args.taskId} (state: ${closingState})` +
      (doneAt ? `\nDone at: ${doneAt}` : "")

    return {
      content: [{ type: "text", text }],
    }
  } catch (err) {
    return toolError(err)
  }
}

interface ListArgs {
  projectName?: string
  entity?: string
  state?: (typeof TASK_STATES)[number]
  dueBefore?: string
  limit?: number
  startCursor?: string
  includeSynopsis?: boolean
}

async function handleList(
  services: LoreServices,
  args: ListArgs,
): Promise<ToolResult> {
  try {
    let projectId: string | undefined
    const warnings: string[] = []

    if (args.projectName) {
      const found = await services.projects.findByName(args.projectName)
      if (found) {
        projectId = found.id
      } else {
        warnings.push(
          `Project "${args.projectName}" not found — falling back to auto-detected project.`,
        )
      }
    }
    if (!projectId && services.context.project) {
      projectId = services.context.project.id
    }

    const cap = args.limit ?? DEFAULT_TASKS_LIMIT
    const deepWalk = cap >= TASK_LIST_DEEP_WALK_MIN_LIMIT
    const pageSize = deepWalk
      ? TASK_LIST_PAGE_SIZE
      : Math.min(cap * TASK_LIST_FETCH_MULTIPLIER, TASK_LIST_PAGE_SIZE)
    const maxPages = deepWalk ? MAX_TASK_LIST_PAGES : 1
    const maxFetchedRows = pageSize * maxPages

    // Bucket headings render inventory counts, so larger explicit
    // requests drain cursor pages before bucketing. Small triage calls
    // keep the historical 4x window and render lower-bound counts if
    // that window saturates. The hard page cap keeps broad closed-history
    // queries from becoming unbounded Notion walks; if the cap fires,
    // every total rendered below is a lower bound.
    const states: TaskState[] = args.state
      ? [args.state as TaskState]
      : ACTIVE_TASK_STATES

    // `TaskService.list` consumes a multi-variant `entities` filter so
    // alias-aware callers (`lore-query action='ask'`) can OR over
    // canonical + aliases server-side. `lore-task action='list'`
    // deliberately keeps a singular user-facing `entity` input — the
    // agent typed one string, the tool surfaces tasks containing
    // exactly that string. Canonicalization here would change the
    // user's filter shape without their knowledge; canonical-aware
    // recall is `lore-query action='ask'`'s job.
    const listOpts = {
      projectId,
      entities: args.entity ? [args.entity] : undefined,
      states,
      dueBefore: args.dueBefore,
    } satisfies Omit<ListTasksOpts, "limit" | "startCursor">

    const tasks: TaskSummary[] = []
    let nextCursor = args.startCursor
    let pagesFetched = 0
    // "Exact total" means exact for the completed cursor walk. Notion
    // does not provide snapshot isolation across page requests, so a
    // concurrent edit can still move a task between cursor steps.
    do {
      // If any cursor step fails, the outer catch returns a tool error
      // and discards accumulated rows. Rendering a partial walk would
      // make exact/lower-bound claims from an unknown slice.
      const page = await services.tasks.list({
        ...listOpts,
        limit: pageSize,
        ...(nextCursor ? { startCursor: nextCursor } : {}),
      })
      tasks.push(...page.items)
      nextCursor = page.nextCursor
      pagesFetched += 1
    } while (nextCursor && pagesFetched < maxPages)
    // `TaskService.list` can hit its internal live-page refill cap on
    // an intermediate cursor step while this MCP walker still continues.
    // Only the final cursor state decides whether the aggregate walk is
    // lower-bound.
    const saturated = Boolean(nextCursor)

    if (tasks.length === 0) {
      const filterHint = args.entity ? ` matching "${args.entity}"` : ""
      const emptyText = saturated
        ? `No tasks found${filterHint} in the first ${maxFetchedRows} fetched rows; more matching tasks may exist.`
        : `No tasks found${filterHint}.`
      const warn = warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""
      return {
        content: [
          {
            type: "text",
            text: `${emptyText}${warn}${paginationFooter(nextCursor, { truncated: saturated })}`,
          },
        ],
      }
    }

    const today = new Date().toISOString().split("T")[0]

    // Bucket by overdue/active. `state` filter covers closed work
    // (done / cancelled) — those rows go straight into the Active
    // section since "overdue" doesn't apply to closed lifecycles.
    const overdueAll: TaskSummary[] = []
    const activeAll: TaskSummary[] = []
    for (const t of tasks) {
      if (taskDaysOverdue(t, today) !== null) {
        overdueAll.push(t)
      } else {
        activeAll.push(t)
      }
    }

    const overdue = overdueAll.slice(0, cap)
    const active = activeAll.slice(0, cap)
    const hidesFetchedRows =
      overdueAll.length > overdue.length || activeAll.length > active.length
    const footerCursor = hidesFetchedRows ? undefined : nextCursor
    const footerTruncated = hidesFetchedRows || saturated
    const includeSynopsis = args.includeSynopsis !== false
    const bound = saturated ? "≥" : ""
    const countLabel = (count: number): string => `${bound}${count}`
    const bucketHeading = (
      title: string,
      rows: TaskSummary[],
      allRows: TaskSummary[],
    ): string => {
      const hidden = allRows.length - rows.length
      const hiddenLabel = saturated ? `≥${hidden}` : `${hidden}`
      return hidden > 0
        ? `### ${title} (${rows.length} shown of ${countLabel(allRows.length)}, hiding ${hiddenLabel})`
        : `### ${title} (${countLabel(allRows.length)})`
    }

    const sections: string[] = []
    if (overdueAll.length > 0) {
      sections.push(
        `${bucketHeading("Overdue", overdue, overdueAll)}\n\n` +
          overdue.map((t) => formatTaskRow(t, today, { includeSynopsis })).join("\n"),
      )
    }
    if (activeAll.length > 0) {
      // Closed-state queries (`state: "done"` / `"cancelled"`) land
      // every row in this branch because `taskDaysOverdue` returns
      // null for non-active states — overdue doesn't apply to closed
      // lifecycles. The heading title-cases the requested state
      // ("Done" / "Cancelled") rather than always saying "Active",
      // so the section label matches the filter the agent passed.
      const sectionTitle = args.state
        ? args.state[0].toUpperCase() + args.state.slice(1)
        : "Active"
      sections.push(
        `${bucketHeading(sectionTitle, active, activeAll)}\n\n` +
          active.map((t) => formatTaskRow(t, today, { includeSynopsis })).join("\n"),
      )
    }

    const footers: string[] = []
    if (saturated) {
      const nextStep = deepWalk
        ? "The deepest bounded walk already ran; narrow with `projectName`, `entity`, `state`, or `dueBefore` for exact totals."
        : `Use \`limit >= ${TASK_LIST_DEEP_WALK_MIN_LIMIT}\` for a deeper bounded walk, or narrow with ` +
          "`projectName`, `entity`, `state`, or `dueBefore` for exact totals."
      footers.push(
        `More matching tasks exist after the first ${maxFetchedRows} fetched rows; ` +
          `totals are lower bounds. ${nextStep}`,
      )
    }

    const total = tasks.length
    const totalLabel =
      saturated || total !== 1 ? `${countLabel(total)} tasks` : "1 task"
    const totalSemantics = saturated
      ? `lower-bound total; listing capped at ${maxFetchedRows}`
      : "exact total"
    const filterSuffix = args.entity ? ` touching "${args.entity}"` : ""
    const footer = footers.length > 0 ? `\n\n${footers.join("\n")}` : ""
    const warn = warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""
    const pagination = paginationFooter(footerCursor, {
      truncated: footerTruncated,
    })

    return {
      content: [
        {
          type: "text",
          text: `${totalLabel} (${totalSemantics})${filterSuffix}:\n\n${sections.join("\n\n")}${footer}${warn}${pagination}`,
        },
      ],
    }
  } catch (err) {
    return toolError(err)
  }
}

interface ReconcileArgs {
  projectName?: string
  minScore?: number
  limit?: number
}

async function handleReconcile(
  services: LoreServices,
  args: ReconcileArgs,
): Promise<ToolResult> {
  try {
    let projectId: string | undefined
    const warnings: string[] = []

    if (args.projectName) {
      const found = await services.projects.findByName(args.projectName)
      if (found) {
        projectId = found.id
      } else {
        warnings.push(
          `Project "${args.projectName}" not found — falling back to auto-detected project.`,
        )
      }
    }
    if (!projectId && services.context.project) {
      projectId = services.context.project.id
    }

    const today = new Date().toISOString().split("T")[0]!
    const { candidates, activeTasksScanned } = await reconcileActiveTasks(
      services,
      {
        projectId,
        minScore: args.minScore,
        limit: args.limit,
        today,
      },
    )

    const body = formatReconcileOutput(candidates, activeTasksScanned, today)
    const warn = warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""

    return {
      content: [{ type: "text", text: body + warn }],
    }
  } catch (err) {
    return toolError(err)
  }
}

/**
 * Discriminated union for runtime validation of `lore-task` dispatch.
 * The MCP-level `inputSchema` is declared flat (every action's params
 * optional) so agents see one parameter table rather than a JSON
 * Schema `oneOf`. We re-validate against this union inside the
 * handler so unsupported action+param combinations surface as clean
 * errors via `formatDispatchError`.
 */
const taskDispatchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    subject: z.string().min(1),
    description: z.string().optional(),
    entity: z.string().optional(),
    state: z.enum(TASK_STATES).optional(),
    blockedBy: z.string().optional(),
    dueDate: z.string().regex(YMD_REGEX, "Must be YYYY-MM-DD format").optional(),
    affectsIds: z.array(z.string()).optional(),
    projectName: z.string().optional(),
    projectNames: z.array(z.string()).optional(),
    topicName: z.string().optional(),
    forceNewTopic: z.boolean().optional(),
    confidence: z.enum(CONFIDENCES).optional(),
    tags: tagsSchema.optional(),
    keywords: keywordsSchema.optional(),
    synopsis: z.string().max(SYNOPSIS_MAX).optional(),
    author: z.string().optional(),
    agent: z.string().optional(),
    session: z.string().optional(),
  }),
  z.object({
    action: z.literal("update"),
    taskId: z.string(),
    state: z.enum(TASK_STATES).optional(),
    blockedBy: z.string().optional(),
    entity: z.string().optional(),
    // Manual YMD validation in `handleUpdate` permits empty string for
    // clear-the-date semantics; the schema only enforces the type.
    dueDate: z.string().optional(),
    subject: z.string().optional(),
    description: z.string().optional(),
    tags: tagsSchema.optional(),
    keywords: keywordsSchema.optional(),
    synopsis: z.string().max(SYNOPSIS_MAX).optional(),
  }),
  z.object({
    action: z.literal("close"),
    taskId: z.string(),
    state: z.enum(CLOSE_STATES).optional(),
  }),
  z.object({
    action: z.literal("list"),
    projectName: z.string().optional(),
    entity: z.string().optional(),
    state: z.enum(TASK_STATES).optional(),
    dueBefore: z.string().regex(YMD_REGEX, "Must be YYYY-MM-DD format").optional(),
    limit: z.number().int().min(1).max(200).optional(),
    startCursor: z.string().min(1).optional(),
    includeSynopsis: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("reconcile"),
    projectName: z.string().optional(),
    minScore: z.number().min(0).max(1).optional(),
    limit: z.number().int().min(1).max(MAX_RECONCILE_LIMIT).optional(),
  }),
])

export function registerTaskTools(server: McpServer, services: LoreServices): void {
  // -------------------------------------------------------------------------
  // lore-task — polymorphic dispatcher (PF3-06)
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-task",
    {
      title: "Task operations",
      description:
        "Create, update, close, or list tasks. Tasks are the canonical " +
        "surface for tracked work; the description lives in the page body " +
        "(no 2000-char rich_text limit) and the subject is structurally " +
        "indexed.\n\n" +
        "CRITICAL CLOSURE RULE: close tasks (action='close') as soon as " +
        "work completes. Closed tasks are the source of truth for \"done\"; " +
        "unclosed tasks keep surfacing in wake-up.\n\n" +
        "Action-dispatched:\n\n" +
        "- `action: 'create'` — open a new task. Use `entity` when the task is about " +
        "a specific subject other facts/decisions also reference; `lore-query` " +
        "action='ask' surfaces it in the Tasks bucket.\n" +
        "- `action: 'update'` — change state, blocker, due date, subject, " +
        "description, or scoping. Any field omitted is left untouched. Pass " +
        "`dueDate: \"\"` to clear the due date.\n" +
        "- `action: 'close'` — mark done (or cancelled — distinguished for metrics).\n" +
        "- `action: 'list'` — list task memories with Overdue and Active " +
        "sections. Labels totals as exact or lower-bound; " +
        `small limits fetch ${TASK_LIST_FETCH_MULTIPLIER}×limit, while ` +
        `limit >= ${TASK_LIST_DEEP_WALK_MIN_LIMIT} uses a deeper bounded walk ` +
        `capped at ${TASK_LIST_PAGE_SIZE * MAX_TASK_LIST_PAGES} fetched rows.\n` +
        "- `action: 'reconcile'` — scan active tasks for resolution-shaped " +
        "memory matches and return ranked closure candidates with close " +
        "incantations. Read-only; never auto-closes.",
      inputSchema: {
        action: z
          .enum(["create", "update", "close", "list", "reconcile"])
          .describe(
            "Operation: create (open a task), update (mutate fields), " +
              "close (mark done/cancelled), list (triage view), or reconcile " +
              "(scan active tasks for resolution-shaped memory matches and " +
              "surface candidate closures).",
          ),
        // create
        subject: z
          .string()
          .optional()
          .describe(
            "(action='create') One-line task subject. Becomes the page title. (action='update') New subject.",
          ),
        description: z
          .string()
          .optional()
          .describe(
            "(action='create' | 'update') Description / context. Becomes the page body (markdown supported).",
          ),
        // create | update | close
        taskId: z
          .string()
          .optional()
          .describe(
            "(action='update' | 'close') The task ID to mutate.",
          ),
        // create | update | list
        entity: z
          .string()
          .optional()
          .describe(
            "(action='create') Normalized entity name the task is about; defaults to subject. " +
              "(action='update') Rename the entity. " +
              "(action='list') Substring filter matched server-side against the Entity column.",
          ),
        // create | update | close | list — multiple shapes; the per-action
        // discriminated union enforces the right enum at runtime.
        state: z
          .enum(TASK_STATES)
          .optional()
          .describe(
            "(action='create') Initial state (default `open`). Pair `blocked` with `blockedBy`. " +
              "(action='update') New state. Use action='close' if you only need to mark a task done. " +
              "(action='close') Closing state — `done` (default) or `cancelled`. " +
              "(action='list') Filter to a single state. Omit on list to see all active states (open, in-progress, blocked).",
          ),
        blockedBy: z
          .string()
          .optional()
          .describe(
            "(action='create' | 'update') Free-form blocker label (PR number, person, external service). " +
              "Required when state is `blocked`; pass an empty string on update to clear.",
          ),
        dueDate: z
          .string()
          .optional()
          .describe(
            "(action='create') Due date (YYYY-MM-DD). Maps to the Review By column. " +
              "(action='update') New due date — pass empty string to clear.",
          ),
        affectsIds: z
          .array(z.string())
          .optional()
          .describe(
            "(action='create') Memory IDs this task is sourced from / affects. Migrated tasks " +
              "carry their original fact's `sourceMemoryId` here so provenance survives.",
          ),
        projectName: z
          .string()
          .optional()
          .describe(
            "(action='create' | 'list' | 'reconcile') Project name. Defaults to auto-detected project from cwd.",
          ),
        projectNames: z
          .array(z.string())
          .optional()
          .describe("(action='create') Multiple project names for cross-project tasks."),
        topicName: z
          .string()
          .optional()
          .describe(
            "(action='create') Topic name within the project. Created automatically if it doesn't exist. " +
              "Variants that differ only by case, plural-`s`, `&` vs `and`, or punctuation collapse onto the existing canonical row.",
          ),
        forceNewTopic: z
          .boolean()
          .optional()
          .describe(
            "(action='create') Bypass the normalized-equivalent + trigram-similar topic-name probe and create a fresh row.",
          ),
        confidence: z
          .enum(CONFIDENCES)
          .optional()
          .describe("(action='create') Confidence in the task's framing (default `certain`)."),
        tags: tagsSchema
          .optional()
          .describe("(action='create' | 'update') Closed-vocabulary tags."),
        keywords: keywordsSchema
          .optional()
          .describe("(action='create' | 'update') Free-form keywords."),
        synopsis: z
          .string()
          .max(SYNOPSIS_MAX)
          .optional()
          .describe(
            "(action='create' | 'update') 1–2 sentence synopsis of what the task is about " +
              "and what 'done' looks like — distinct from `subject` (short title) and " +
              `\`description\` (the body). Up to ${SYNOPSIS_MAX} chars. ` +
              "On update, omit to leave untouched; pass empty string to clear.",
          ),
        author: z
          .string()
          .optional()
          .describe(
            "(action='create') Engineer display name. Defaults to LORE_USER_NAME env or `users.me`.",
          ),
        agent: z
          .string()
          .optional()
          .describe("(action='create') Name of the AI agent creating this task."),
        session: z
          .string()
          .optional()
          .describe("(action='create') Session ID to group related saves."),
        // list
        dueBefore: z
          .string()
          .optional()
          .describe(
            "(action='list') Only return tasks with a Review By date on or before this YYYY-MM-DD.",
          ),
        startCursor: z
          .string()
          .min(1)
          .optional()
          .describe("(action='list') Opaque pagination cursor from a previous response."),
        limit: z
          .number()
          .int()
          .optional()
          .describe(
            `(action='list') Per-section render cap (default ${DEFAULT_TASKS_LIMIT}). ` +
              `Small caps fetch ${TASK_LIST_FETCH_MULTIPLIER}×limit; ` +
              `limit >= ${TASK_LIST_DEEP_WALK_MIN_LIMIT} requests a deep walk. Capped at 200. ` +
              `(action='reconcile') Maximum candidate closures to surface ` +
              `(default ${DEFAULT_RECONCILE_LIMIT}). Capped at ${MAX_RECONCILE_LIMIT}.`,
          ),
        minScore: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            `(action='reconcile') Minimum candidate score (0–1) to surface. ` +
              `Default ${DEFAULT_RECONCILE_MIN_SCORE}. Candidates without a ` +
              "resolution-shaped cue (`merged`, `shipped`, `resolved`, `fixed`, " +
              "`closed`, etc.) are filtered out BEFORE scoring — entity-only " +
              "mentions never reach the threshold.",
          ),
        includeSynopsis: z
          .boolean()
          .optional()
          .describe(
            "(action='list') Render each task's synopsis line (when set) " +
              "as an indented line between the title row and the `ID:` line. " +
              "Defaults true. Pass false to restore byte-identical " +
              "pre-DEFERRED-01 output for callers piping the response into " +
              "another formatter.",
          ),
      },
    },
    async (args) => {
      const parsed = taskDispatchSchema.safeParse(args)
      if (!parsed.success) {
        return toolError(
          new Error(formatDispatchError("lore-task", parsed.error)),
        )
      }
      switch (parsed.data.action) {
        case "create":
          return handleCreate(services, parsed.data)
        case "update":
          return handleUpdate(services, parsed.data)
        case "close":
          return handleClose(services, parsed.data)
        case "list":
          return handleList(services, parsed.data)
        case "reconcile":
          return handleReconcile(services, parsed.data)
      }
    },
  )
}
