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
import { formatDispatchError, toolError } from "../helpers.js"
import { resolveProjectIds } from "../resolve.js"
import { tagsSchema, keywordsSchema } from "./tag-schema.js"
import { taskDaysOverdue } from "../../core/task.js"
import { ACTIVE_TASK_STATES } from "../../types.js"
import type { TaskState, TaskSummary } from "../../types.js"

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

    const task = await services.tasks.create({
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
      agent: args.agent,
      session: args.session,
    })

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
    return {
      content: [
        {
          type: "text",
          text: `Closed task ${args.taskId} (state: ${closingState})`,
        },
      ],
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

    // Pull a generous slice (4× cap, capped at 100) so a single
    // bucket dominating the fetched window doesn't silently truncate
    // the other. With 2× and a vault tilted overdue (e.g. 18 overdue
    // + 2 active among 20 fetched), Active would render as `2 of 2`
    // when the live set has hundreds — the "hidden N" suffix only
    // counts within the fetched window, not the upstream universe.
    // 4× absorbs realistic bucket-skew on the Mail vault's 271 open
    // loops without paying a second query. Saturated past that, the
    // operator should narrow with `entity` or raise `limit`.
    const fetchLimit = Math.min((args.limit ?? DEFAULT_TASKS_LIMIT) * 4, 100)
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
    const { items: tasks } = await services.tasks.list({
      projectId,
      entities: args.entity ? [args.entity] : undefined,
      states,
      dueBefore: args.dueBefore,
      limit: fetchLimit,
    })

    if (tasks.length === 0) {
      const filterHint = args.entity ? ` matching "${args.entity}"` : ""
      const warn = warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""
      return {
        content: [
          { type: "text", text: `No tasks found${filterHint}.${warn}` },
        ],
      }
    }

    const today = new Date().toISOString().split("T")[0]
    const cap = args.limit ?? DEFAULT_TASKS_LIMIT

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
        `${heading}\n\n` + overdue.map((t) => formatTaskRow(t, today)).join("\n"),
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
          ? `### ${args.state ? args.state[0].toUpperCase() + args.state.slice(1) : "Active"} (${active.length} shown of ${activeAll.length}, hiding ${hidden})`
          : `### ${args.state ? args.state[0].toUpperCase() + args.state.slice(1) : "Active"} (${activeAll.length})`
      sections.push(
        `${heading}\n\n` + active.map((t) => formatTaskRow(t, today)).join("\n"),
      )
    }

    const total = tasks.length
    const filterSuffix = args.entity ? ` touching "${args.entity}"` : ""
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
        "indexed. Action-dispatched:\n\n" +
        "- `action: 'create'` — open a new task. Use `entity` when the task is about " +
        "a specific subject other facts/decisions also reference; `lore-query` " +
        "action='ask' surfaces it in the Tasks bucket.\n" +
        "- `action: 'update'` — change state, blocker, due date, subject, " +
        "description, or scoping. Any field omitted is left untouched. Pass " +
        "`dueDate: \"\"` to clear the due date.\n" +
        "- `action: 'close'` — mark done (or cancelled — distinguished for metrics).\n" +
        "- `action: 'list'` — list tasks (`Kind = task` memories) with Overdue " +
        "and Active sections.",
      inputSchema: {
        action: z
          .enum(["create", "update", "close", "list"])
          .describe(
            "Operation: create (open a task), update (mutate fields), close (mark done/cancelled), or list (triage view).",
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
            "(action='create' | 'list') Project name. Defaults to auto-detected project from cwd.",
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
        limit: z
          .number()
          .int()
          .optional()
          .describe(
            `(action='list') Per-section cap (default ${DEFAULT_TASKS_LIMIT}). Capped at 200.`,
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
      }
    },
  )
}
