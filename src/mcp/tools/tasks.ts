/**
 * Task tools (P3-02). Tasks supersede the legacy tracking-predicate
 * facts (`needs_action`, `waiting_on`, `blocked_by`). Each tool here is
 * a thin orchestration layer over `services.tasks` (`TaskService`) plus
 * project-name resolution; the heavy lifting — schema, defaults,
 * Notion calls — lives in `src/core/task.ts`.
 *
 * Tool surface mirrors the spec:
 * - `lore-task-create` — create a task. Equivalent to the old
 *   `lore-learn` with a tracking predicate, but the description goes in
 *   the page body instead of a 2000-char rich_text Object field.
 * - `lore-task-update` — change state, blocker, due date.
 * - `lore-task-close` — mark done (or cancelled).
 * - `lore-tasks` — list with filters (entity, state, overdue).
 */

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { toolError } from "../helpers.js"
import { resolveProjectIds } from "../resolve.js"
import { tagsSchema, keywordsSchema } from "./tag-schema.js"
import { taskDaysOverdue } from "../../core/task.js"
import { ACTIVE_TASK_STATES } from "../../types.js"
import type { TaskState, TaskSummary } from "../../types.js"

const TASK_STATES = ["open", "in-progress", "blocked", "done", "cancelled"] as const

const YMD_REGEX = /^\d{4}-\d{2}-\d{2}$/

/**
 * Default cap for `lore-tasks` listings. Matches `lore-open-loops`'
 * default so the agent UX is consistent across the deprecation period.
 * Per-section, not total — mirrors how `lore-open-loops` splits Overdue
 * + Active.
 */
const DEFAULT_TASKS_LIMIT = 10

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
 */
function formatTaskRow(t: TaskSummary, today: string): string {
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
  return (
    `- ${marker}**${t.title}** [${stateLabel}]${blocked}${overduePart}\n` +
    `  ID: ${t.id}`
  )
}

export function registerTaskTools(server: McpServer, services: LoreServices): void {
  // -------------------------------------------------------------------------
  // lore-task-create
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-task-create",
    {
      title: "Create a task",
      description:
        "Create a task — an open loop that needs action. Tasks supersede the legacy tracking-predicate facts " +
        "(`needs_action` / `waiting_on` / `blocked_by` on `lore-learn`); the description lives in the page body " +
        "(no 2000-char rich_text limit) and the subject is structurally indexed.\n\n" +
        "Pair with `lore-task-update` to move state, `lore-task-close` to mark done, and `lore-tasks` to list. " +
        "Use `entity` when the task is about a specific entity that other facts/tasks/decisions also reference — " +
        "`lore-ask(entity)` will surface it in the Tasks bucket.",
      inputSchema: {
        subject: z
          .string()
          .min(1)
          .describe("One-line task subject. Becomes the page title."),
        description: z
          .string()
          .optional()
          .describe(
            "Free-form description / context. Becomes the page body (markdown supported)."
          ),
        entity: z
          .string()
          .optional()
          .describe(
            "Normalized entity name the task is about (PR number, service, person). " +
              "Defaults to the subject. `lore-ask(entity)` filters tasks by this column."
          ),
        state: z
          .enum(TASK_STATES)
          .optional()
          .describe(
            "Initial state (default `open`). Use `blocked` only when an external dependency exists; " +
              "pair with `blockedBy` to name the blocker."
          ),
        blockedBy: z
          .string()
          .optional()
          .describe(
            "Free-form blocker label (PR number, person, external service). " +
              "Only meaningful when `state` is `blocked`."
          ),
        dueDate: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("Due date (YYYY-MM-DD). Maps to the Review By column."),
        affectsIds: z
          .array(z.string())
          .optional()
          .describe(
            "Memory IDs this task is sourced from / affects. Migrated tasks " +
              "carry their original fact's `sourceMemoryId` here so provenance survives."
          ),
        projectName: z
          .string()
          .optional()
          .describe("Project name. Defaults to auto-detected project from cwd."),
        projectNames: z
          .array(z.string())
          .optional()
          .describe("Multiple project names for cross-project tasks."),
        topicName: z
          .string()
          .optional()
          .describe("Topic name within the project. Created automatically if it doesn't exist."),
        confidence: z
          .enum(["certain", "likely", "speculative"])
          .optional()
          .describe("Confidence in the task's framing (default `certain`)."),
        tags: tagsSchema.optional(),
        keywords: keywordsSchema.optional(),
        agent: z.string().optional().describe("Name of the AI agent creating this task"),
        session: z.string().optional().describe("Session ID to group related saves"),
      },
    },
    async ({
      subject,
      description,
      entity,
      state,
      blockedBy,
      dueDate,
      affectsIds,
      projectName,
      projectNames,
      topicName,
      confidence,
      tags,
      keywords,
      agent,
      session,
    }) => {
      try {
        // A `blocked` task with no `blockedBy` label is useless to
        // triage — the row says "I'm blocked" without naming the
        // blocker. Reject at the boundary rather than letting the empty
        // row land. The migration path explicitly populates `Blocked By`
        // when porting `blocked_by` / `waiting_on` facts, so this guard
        // only fires on fresh agent calls; cross-field, so it can't live
        // on the per-field Zod map.
        if (state === "blocked" && !blockedBy) {
          throw new Error(
            "state: \"blocked\" requires a `blockedBy` label naming the dependency " +
              "(PR number, person, external service). A blocked task with no blocker is " +
              "unactionable. Pass `blockedBy` or use state: \"open\" if no specific blocker exists."
          )
        }
        const resolved = await resolveProjectIds(services, projectName, projectNames)

        let topicId: string | undefined
        let topicLabel = "none"
        if (topicName && resolved.ids.length > 0) {
          const topic = await services.topics.getOrCreate(topicName, resolved.ids)
          topicId = topic.id
          topicLabel = topic.name
        }

        const task = await services.tasks.create({
          subject,
          description,
          entity,
          state: state as TaskState | undefined,
          blockedBy,
          dueDate,
          affectsIds,
          projectIds: resolved.ids.length > 0 ? resolved.ids : undefined,
          topicId,
          confidence,
          tags,
          keywords,
          agent,
          session,
        })

        // Record for `lore-learn` session auto-link, mirroring how
        // `lore-remember` and `lore-decide` plant a session pointer so a
        // later `lore-learn` fact can auto-link this task as its source.
        services.sessionMemories.record(
          { agent, session },
          { memoryId: task.id, projectIds: task.projectIds }
        )

        const projectLabel = resolved.ids.length
          ? (projectNames?.join(", ") ?? projectName ?? services.context.project?.name ?? "auto-detected")
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

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )

  // -------------------------------------------------------------------------
  // lore-task-update
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-task-update",
    {
      title: "Update a task",
      description:
        "Update a task's state, blocker, due date, subject, description, or scoping. Any field omitted is left " +
        "untouched. Pass `dueDate: \"\"` to explicitly clear the due date.",
      inputSchema: {
        taskId: z.string().describe("The task ID to update"),
        state: z
          .enum(TASK_STATES)
          .optional()
          .describe(
            "New state. Use `lore-task-close` if you only need to mark a task done — it's the same " +
              "underlying mutation but the call site is clearer."
          ),
        blockedBy: z
          .string()
          .optional()
          .describe(
            "New blocker label (or empty string to clear). Only meaningful when `state` is `blocked`."
          ),
        entity: z
          .string()
          .optional()
          .describe("New normalized entity name."),
        dueDate: z
          .string()
          .optional()
          .describe(
            "New due date (YYYY-MM-DD). Pass an empty string to clear the date entirely. " +
              "Validated server-side; non-empty values must match YYYY-MM-DD."
          ),
        subject: z.string().optional().describe("New subject (page title)."),
        description: z
          .string()
          .optional()
          .describe("New description (replaces page body)."),
        tags: tagsSchema.optional(),
        keywords: keywordsSchema.optional(),
      },
    },
    async ({
      taskId,
      state,
      blockedBy,
      entity,
      dueDate,
      subject,
      description,
      tags,
      keywords,
    }) => {
      try {
        // Validate dueDate manually so `""` (clear-the-date) is allowed
        // without inflating the Zod schema. A malformed non-empty value
        // is rejected before it hits Notion.
        let dueDateValue: string | null | undefined
        if (dueDate === undefined) {
          dueDateValue = undefined
        } else if (dueDate === "") {
          dueDateValue = null
        } else if (!YMD_REGEX.test(dueDate)) {
          throw new Error(`dueDate must be YYYY-MM-DD or empty string, got "${dueDate}"`)
        } else {
          dueDateValue = dueDate
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
        if (state === "blocked" && (blockedBy === undefined || blockedBy === "")) {
          throw new Error(
            "Transitioning to state: \"blocked\" requires a `blockedBy` label in the same call. " +
              "A blocked task with no blocker is unactionable; restate the blocker explicitly even if " +
              "the row already had one set."
          )
        }

        const updated = await services.tasks.update(taskId, {
          state: state as TaskState | undefined,
          blockedBy,
          entity,
          dueDate: dueDateValue,
          subject,
          description,
          tags,
          keywords,
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

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )

  // -------------------------------------------------------------------------
  // lore-task-close
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-task-close",
    {
      title: "Close a task",
      description:
        "Mark a task as done (or cancelled). Equivalent to the old `lore-correct` on a tracking-predicate fact, but " +
        "the original task body is preserved and the row stays queryable via `lore-tasks` with `state: done`.",
      inputSchema: {
        taskId: z.string().describe("The task ID to close"),
        state: z
          .enum(["done", "cancelled"])
          .optional()
          .describe(
            "Closing state — `done` (shipped, default) or `cancelled` (dropped without completion). " +
              "Distinguished so metrics can separate the two."
          ),
      },
      annotations: { destructiveHint: true },
    },
    async ({ taskId, state }) => {
      try {
        const closingState: "done" | "cancelled" = state ?? "done"
        await services.tasks.close(taskId, closingState)
        return {
          content: [
            {
              type: "text",
              text: `Closed task ${taskId} (state: ${closingState})`,
            },
          ],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )

  // -------------------------------------------------------------------------
  // lore-tasks
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-tasks",
    {
      title: "List tasks",
      description:
        "List tasks (Kind = task memories), filtered by state, entity, or due date. Returns Overdue and Active " +
        `sections, each capped at ${DEFAULT_TASKS_LIMIT} rows by default. Pass {state: 'done'} for closed work, ` +
        "{entity: '…'} to scope to a specific subject, or {limit: N} to raise the cap.\n\n" +
        "Replaces `lore-open-loops` after the P3-02 migration. The legacy tool still works on un-migrated vaults; " +
        "this tool is the path forward.",
      inputSchema: {
        projectName: z
          .string()
          .optional()
          .describe("Override the auto-detected project."),
        entity: z
          .string()
          .optional()
          .describe(
            "Substring filter matched server-side against the Entity column. " +
              "Use this to scope to a PR, service, or other subject."
          ),
        state: z
          .enum(TASK_STATES)
          .optional()
          .describe(
            "Filter to a single state. Omit to see all active states (open, in-progress, blocked); " +
              "pass `done` or `cancelled` for closed work."
          ),
        dueBefore: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("Only return tasks with a Review By date on or before this YYYY-MM-DD."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(`Per-section cap (default ${DEFAULT_TASKS_LIMIT}). Capped at 200.`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ projectName, entity, state, dueBefore, limit }) => {
      try {
        let projectId: string | undefined
        const warnings: string[] = []

        if (projectName) {
          const found = await services.projects.findByName(projectName)
          if (found) {
            projectId = found.id
          } else {
            warnings.push(
              `Project "${projectName}" not found — falling back to auto-detected project.`
            )
          }
        }
        if (!projectId && services.context.project) {
          projectId = services.context.project.id
        }

        // Pull a generous slice (4× cap, capped at 100) so a single
        // bucket dominating the fetched window doesn't silently truncate
        // the other. With 2× and a vault tilted overdue (e.g. 18 overdue
        // + 2 active among 20 fetched), Active would render as `2 of 2`
        // when the live set has hundreds — the "hidden N" suffix only
        // counts within the fetched window, not the upstream universe.
        // 4× absorbs realistic bucket-skew on the Mail vault's 271 open
        // loops without paying a second query. Saturated past that, the
        // operator should narrow with `entity` or raise `limit`.
        const fetchLimit = Math.min((limit ?? DEFAULT_TASKS_LIMIT) * 4, 100)
        const states: TaskState[] = state
          ? [state as TaskState]
          : ACTIVE_TASK_STATES

        const { items: tasks } = await services.tasks.list({
          projectId,
          entity,
          states,
          dueBefore,
          limit: fetchLimit,
        })

        if (tasks.length === 0) {
          const filterHint = entity ? ` matching "${entity}"` : ""
          const warn = warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""
          return {
            content: [
              { type: "text", text: `No tasks found${filterHint}.${warn}` },
            ],
          }
        }

        const today = new Date().toISOString().split("T")[0]
        const cap = limit ?? DEFAULT_TASKS_LIMIT

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

        const sections: string[] = []
        if (overdueAll.length > 0) {
          const hidden = overdueAll.length - overdue.length
          const heading =
            hidden > 0
              ? `### Overdue (${overdue.length} shown of ${overdueAll.length}, hiding ${hidden})`
              : `### Overdue (${overdueAll.length})`
          sections.push(
            `${heading}\n\n` + overdue.map((t) => formatTaskRow(t, today)).join("\n")
          )
        }
        if (activeAll.length > 0) {
          // Closed-state queries (`state: "done"` / `"cancelled"`) land
          // every row in this branch because `taskDaysOverdue` returns
          // null for non-active states — overdue doesn't apply to closed
          // lifecycles. The heading title-cases the requested state
          // ("Done" / "Cancelled") rather than always saying "Active",
          // so the section label matches the filter the agent passed.
          const hidden = activeAll.length - active.length
          const heading =
            hidden > 0
              ? `### ${state ? state[0].toUpperCase() + state.slice(1) : "Active"} (${active.length} shown of ${activeAll.length}, hiding ${hidden})`
              : `### ${state ? state[0].toUpperCase() + state.slice(1) : "Active"} (${activeAll.length})`
          sections.push(
            `${heading}\n\n` + active.map((t) => formatTaskRow(t, today)).join("\n")
          )
        }

        const total = tasks.length
        const filterSuffix = entity ? ` touching "${entity}"` : ""
        const warn = warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""

        return {
          content: [
            {
              type: "text",
              text: `${total} task${total === 1 ? "" : "s"}${filterSuffix}:\n\n${sections.join("\n\n")}${warn}`,
            },
          ],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )
}
