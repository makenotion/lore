/**
 * Task operations — first-class task records backed by the Memories DB.
 *
 * A task is a Notion page in the Memories database with `Kind = task`. It
 * supersedes the legacy tracking-predicate facts (`needs_action`,
 * `waiting_on`, `blocked_by`) — the description goes in the page body
 * (free-form prose, no rich_text length cap), the subject becomes the
 * title (structurally indexed), and `Task State` carries the lifecycle.
 *
 * The split exists because the Facts DB was designed for atomic
 * `(Subject, Predicate, Object)` triples — `AuthService uses JWT`. In
 * practice, ~half the facts in the Mail vault were tracking-predicate
 * rows whose Object field was a 187-char-average ticket description.
 * Structural queries don't work on prose; `lore-ask` flooded with
 * paragraphs; the knowledge graph couldn't be queried as a graph. Tasks
 * pull this prose out of Facts and into the right shape.
 *
 * Service mirrors `DecisionService`: shares the Memories DB with
 * `MemoryService`, sets the `Kind` discriminator on every create, and
 * exposes index-tier listings that skip the `retrieveMarkdown` body
 * fetch. Cross-service orchestration (e.g. `lore-ask` running fact +
 * task queries together) lives at the MCP tool layer.
 */

import type { Client } from "@notionhq/client"
import type {
  PageObjectResponse,
  CreatePageParameters,
  QueryDataSourceParameters,
} from "@notionhq/client"
import type {
  Task,
  TaskSummary,
  TaskState,
  CreateTaskInput,
  UpdateTaskInput,
  ListTasksOpts,
  DatabaseRef,
} from "../types.js"
import { ACTIVE_TASK_STATES } from "../types.js"
import { buildMemoryProps } from "../notion/schema.js"
import { projectOrUnscopedFilter } from "../notion/filters.js"
import { decodeTextEntities } from "../notion/html-entities.js"
import { isFullPage } from "../notion/extractors.js"
import { pageToMemory } from "./memory.js"

export class TaskService {
  constructor(
    private client: Client,
    private db: DatabaseRef
  ) {}

  /**
   * Create a `Kind = task` memory. `subject` becomes the page title,
   * `description` the page body. The `Entity` column defaults to the
   * subject so `lore-ask(entity)` lookups always have a column to match
   * against — the migration relies on this when porting fact subjects.
   *
   * Decodes plain-text fields at the write boundary so doubly-encoded
   * autosave input lands clean — same posture `MemoryService.create`
   * takes (PF1-06). Idempotent on clean values.
   */
  async create(input: CreateTaskInput): Promise<Task> {
    const state = input.state ?? "open"
    const subject = decodeTextEntities(input.subject)
    const description = input.description
      ? decodeTextEntities(input.description)
      : undefined
    const entity = decodeTextEntities(input.entity ?? input.subject)
    const blockedBy =
      input.blockedBy !== undefined ? decodeTextEntities(input.blockedBy) : undefined
    const keywords =
      input.keywords !== undefined ? decodeTextEntities(input.keywords) : undefined
    const confidence = input.confidence ?? "certain"

    const page = await this.client.pages.create({
      parent: { type: "database_id", database_id: this.db.databaseId },
      properties: buildMemoryProps({
        title: subject,
        projectIds: input.projectIds,
        topicId: input.topicId,
        source: "manual",
        kind: "task",
        confidence,
        // `Review By` doubles as the task's due date — same column,
        // same overdue semantics so `lore-audit` and the wake-up
        // overdue branches keep working without new logic.
        reviewBy: input.dueDate,
        affectsIds: input.affectsIds,
        alternatives: input.alternatives,
        consequences: input.consequences,
        agent: input.agent,
        tags: input.tags,
        keywords,
        session: input.session,
        taskState: state,
        blockedBy,
        entity,
      }),
    })

    if (description) {
      await this.client.pages.updateMarkdown({
        page_id: page.id,
        type: "insert_content",
        insert_content: { content: description },
      })
    }

    return pageToMemory(
      page as PageObjectResponse,
      description ?? ""
    ) as Task
  }

  /**
   * Fetch one task with its body. Returns the Memory + content shape but
   * narrowed to `Task`; throws when the page exists but isn't a task so
   * a confused tool call surfaces immediately rather than silently
   * sliding past the type narrowing.
   */
  async getById(id: string): Promise<Task> {
    const [page, md] = await Promise.all([
      this.client.pages.retrieve({ page_id: id }),
      this.client.pages.retrieveMarkdown({ page_id: id }),
    ])
    const memory = pageToMemory(page as PageObjectResponse, md.markdown)
    if (memory.kind !== "task") {
      throw new Error(
        `Memory ${id} is not a task (kind: ${memory.kind}). ` +
          "Use MemoryService for non-task memories."
      )
    }
    return memory as Task
  }

  /**
   * List tasks matching the given filters. Returns summaries with no
   * markdown body — single Notion page query, regardless of result
   * count. Defaults to `ACTIVE_TASK_STATES` so callers asking for "the
   * task list" don't accidentally see closed work.
   */
  async list(
    opts?: ListTasksOpts
  ): Promise<{ items: TaskSummary[]; nextCursor?: string }> {
    const filters: Array<Record<string, unknown>> = [
      { property: "Kind", select: { equals: "task" } },
    ]

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }
    const states = opts?.states ?? ACTIVE_TASK_STATES
    if (states.length === 1) {
      filters.push({ property: "Task State", select: { equals: states[0] } })
    } else if (states.length > 1) {
      filters.push({
        or: states.map((s) => ({
          property: "Task State",
          select: { equals: s },
        })),
      })
    }
    if (opts?.entity) {
      filters.push({
        property: "Entity",
        rich_text: { contains: opts.entity },
      })
    }
    if (opts?.dueBefore) {
      filters.push({
        property: "Review By",
        date: { on_or_before: opts.dueBefore },
      })
    }

    const filter = filters.length > 1 ? { and: filters } : filters[0]

    const response = await this.client.dataSources.query({
      data_source_id: this.db.dataSourceId,
      filter: filter as QueryDataSourceParameters["filter"],
      // Sort by `Review By` ascending so most-overdue / soonest-due rows
      // float to the top — same default `lore-audit` and
      // `lore-open-loops` use, and the right answer for a triage list.
      sorts: [
        { property: "Review By", direction: "ascending" },
        { timestamp: "created_time", direction: "descending" },
      ],
      page_size: Math.min(opts?.limit ?? 20, 100),
      start_cursor: opts?.startCursor,
    })

    const pages = response.results.filter(isFullPage) as PageObjectResponse[]
    const nextCursor =
      response.has_more && response.next_cursor ? response.next_cursor : undefined

    return {
      items: pages.map((page) => toTaskSummary(pageToMemory(page, "") as Task)),
      nextCursor,
    }
  }

  /**
   * Update a task's mutable fields. Mirrors `MemoryService.update` but
   * only exposes the columns that make sense on a task — `state`,
   * `dueDate` (`Review By`), `blockedBy`, `entity`, and the standard
   * subject/description.
   *
   * Decodes plain-text fields at the write boundary so doubly-encoded
   * autosave input (`&amp;amp;`) resolves to plain text — same posture
   * `MemoryService.update` takes (PF1-06). `Blocked By` and `Entity`
   * are agent-boundary fields that downstream `lore-ask(entity)` and
   * future similarity surfaces will read; idempotent on clean values.
   */
  async update(id: string, input: UpdateTaskInput): Promise<Task> {
    const props: Record<string, unknown> = {}

    if (input.subject !== undefined) {
      props["Title"] = {
        title: [{ text: { content: decodeTextEntities(input.subject) } }],
      }
    }
    if (input.state) {
      props["Task State"] = { select: { name: input.state } }
    }
    if (input.blockedBy !== undefined) {
      props["Blocked By"] = {
        rich_text: [{ text: { content: decodeTextEntities(input.blockedBy) } }],
      }
    }
    if (input.entity !== undefined) {
      props["Entity"] = {
        rich_text: [{ text: { content: decodeTextEntities(input.entity) } }],
      }
    }
    if (input.tags) {
      props["Tags"] = {
        multi_select: input.tags.map((t) => ({ name: t })),
      }
    }
    if (input.keywords !== undefined) {
      props["Keywords"] = {
        rich_text: [{ text: { content: decodeTextEntities(input.keywords) } }],
      }
    }
    if (input.affectsIds) {
      props["Affects"] = {
        relation: input.affectsIds.map((rid) => ({ id: rid })),
      }
    }
    // `null` clears the date; an explicit string sets it; `undefined`
    // leaves it untouched. Mirrors the `reviewBy` discipline elsewhere.
    if (input.dueDate !== undefined) {
      props["Review By"] = input.dueDate
        ? { date: { start: input.dueDate } }
        : { date: null }
    }

    if (Object.keys(props).length > 0) {
      await this.client.pages.update({
        page_id: id,
        properties: props as CreatePageParameters["properties"],
      })
    }

    if (input.description !== undefined) {
      await this.client.pages.updateMarkdown({
        page_id: id,
        type: "replace_content_range",
        replace_content_range: {
          content: decodeTextEntities(input.description),
          content_range: "full_page",
          allow_deleting_content: true,
        },
      })
    }

    return this.getById(id)
  }

  /**
   * Mark a task as done. Equivalent to `update(id, { state: "done" })`
   * but keeps the call site readable at every triage path that just
   * wants to close work without restating the lifecycle.
   *
   * Pass `state: "cancelled"` when the task was dropped without
   * completion — distinguishing the two for downstream metrics.
   *
   * **Non-transactional**. Notion has no conditional-write or
   * compare-and-swap primitive, so two agents racing on the same task
   * are last-write-wins. Two `close` calls converge to `done` (idempotent);
   * a `close` after a concurrent `update({ state: "in-progress" })` from
   * another agent silently overwrites the in-progress state with no
   * warning. Acceptable because closing work is the terminal step in the
   * lifecycle — overwriting an `in-progress` mid-flight only happens when
   * agents disagree about whether work is done, and in that case
   * downstream `lore-tasks state: "done"` queries surface the closed row
   * for re-triage. If we ever need stricter semantics, the model would
   * be `expectedCurrentState` à la decision supersession's read-then-write
   * discipline.
   */
  async close(id: string, state: "done" | "cancelled" = "done"): Promise<void> {
    await this.client.pages.update({
      page_id: id,
      properties: {
        "Task State": { select: { name: state } },
      } as CreatePageParameters["properties"],
    })
  }

  /**
   * Active tasks past their due date. Mirrors
   * `DecisionService.queryOverdue` so wake-up / `lore-audit` can
   * compose all three sources without per-service branching.
   */
  async queryOverdue(opts?: { projectId?: string }): Promise<TaskSummary[]> {
    const today = new Date().toISOString().split("T")[0]
    const filters: Array<Record<string, unknown>> = [
      { property: "Kind", select: { equals: "task" } },
      { property: "Review By", date: { on_or_before: today } },
      {
        or: ACTIVE_TASK_STATES.map((s) => ({
          property: "Task State",
          select: { equals: s },
        })),
      },
    ]
    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }

    const response = await this.client.dataSources.query({
      data_source_id: this.db.dataSourceId,
      filter: { and: filters } as QueryDataSourceParameters["filter"],
      sorts: [{ property: "Review By", direction: "ascending" }],
    })

    const pages = response.results.filter(isFullPage) as PageObjectResponse[]
    return pages.map((page) => toTaskSummary(pageToMemory(page, "") as Task))
  }
}

function toTaskSummary(task: Task): TaskSummary {
  // Strip `content` — summaries never carry the markdown body. TS's
  // `Omit` on the type does the static work; this runtime projection
  // matches it. Same pattern `DecisionService.toDecisionSummary` uses.
  const copy: Record<string, unknown> = { ...task }
  delete copy.content
  return copy as TaskSummary
}

/**
 * Determine whether a task counts as overdue against `today`. Returns the
 * integer days past due, or `null` when the task has no due date or is
 * still within its window. Same shape as `daysOverdue` in
 * `mcp/tools/knowledge.ts` so the rendering layer can share its
 * urgency-marker helpers.
 */
export function taskDaysOverdue(
  task: Pick<TaskSummary, "reviewBy" | "taskState">,
  today: string
): number | null {
  if (!task.reviewBy || task.reviewBy > today) return null
  if (!ACTIVE_TASK_STATES.includes(task.taskState as TaskState)) return null
  const diff = new Date(today).getTime() - new Date(task.reviewBy).getTime()
  return Math.floor(diff / 86_400_000)
}
