/**
 * Task operations — first-class task records backed by the Memories DB.
 *
 * A task is a Notion page in the Memories database with `Kind = task`.
 * The description goes in the page body (free-form prose, no rich_text
 * length cap), the subject becomes the title (structurally indexed),
 * and `Task State` carries the lifecycle. Tasks are the canonical
 * surface for tracked work; the legacy tracking-predicate facts that
 * predated this surface have been removed (tracking predicates are
 * not part of the current `FactPredicate` union).
 *
 * The split exists because the Facts DB was designed for atomic
 * `(Subject, Predicate, Object)` triples — `AuthService uses JWT`.
 * Tracked-work rows formerly landed in Facts with 187-char-average
 * ticket descriptions in the Object slot, which made structural
 * queries useless on that data and flooded `lore-query action='ask'`
 * with prose. Tasks pull this prose out of Facts and into the right shape.
 *
 * Service parallels `DecisionService`: shares the Memories DB with
 * `MemoryService`, sets the `Kind` discriminator on every create, and
 * exposes index-tier listings that skip the `retrieveMarkdown` body
 * fetch. Cross-service orchestration (e.g. `lore-query action='ask'`
 * running fact + task queries together) lives at the MCP tool layer.
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
import { ACTIVE_TASK_STATES, STALE_TASK_DAYS } from "../types.js"
import type { MemoryScopeContext } from "../types.js"
import { buildMemoryProps, MEMORY_PROPS } from "../notion/schema.js"
import { isMissingPropertyError } from "../notion/errors.js"
import { projectOrUnscopedFilter, withDefaultScopeFilter } from "../notion/filters.js"
import { matchesDefaultScope } from "./memory.js"
import { decodeTextEntities } from "../notion/html-entities.js"
import { isLiveFullPage } from "../notion/extractors.js"
import {
  collectLivePages,
  LIVE_PAGE_REFILL_MAX_ROWS,
  warnLivePageCapFired,
} from "../notion/live-pages.js"
import { hydrateMemoryRelationProperties, pageToMemory } from "./memory.js"
import { validateRichTextMetadataFields } from "./rich-text-schema.js"

/**
 * Single rule for every empty-able optional task field: **empty string
 * means absence**. Applies uniformly to `blockedBy`, `dueDate`,
 * `entity`, `description`, and any future optional task field added
 * downstream.
 *
 * Whitespace-only inputs are not rejected at the Zod boundary —
 * `blockedBy`, `entity`, and `description` are declared as plain
 * `z.string().optional()` on the create / update schemas, so a
 * caller passing `"   "` reaches this helper. `isCleared` therefore
 * trims before comparing: a whitespace-only value is treated as
 * cleared so service-layer writes don't land a row with a string of
 * spaces masquerading as content. The cross-field guard for
 * `state: "blocked"` (paired with `blockedBy`) is enforced separately
 * at the MCP boundary by `isUnusableBlockerLabel` since per-field
 * Zod can't express a multi-field invariant.
 *
 * `isCleared` formalizes the empty-or-cleared check at one call site
 * so a future caller can't accidentally check `value === ""` in one
 * place and `!value` in another and end up with subtly different
 * semantics (one would treat whitespace-only as cleared, the other
 * wouldn't). Treats `null` as cleared because `dueDate: string | null`
 * on `UpdateTaskInput` lets callers express clear-the-date with
 * either spelling.
 *
 * Returns `false` for `undefined` deliberately — `undefined` means
 * "leave untouched" rather than "clear", and callers filter that
 * sentinel before invoking this helper. Treating undefined as cleared
 * would silently wipe fields callers never asked to touch.
 */
export function isCleared(value: string | null | undefined): boolean {
  if (value === undefined) return false
  return value === null || value.trim() === ""
}

/**
 * Thrown when task properties land in Notion but the description body
 * write fails. `pageId` names the row created by `pages.create`;
 * `cleanedUp` tells callers whether Lore archived that row before
 * surfacing the failure.
 */
export class TaskCreatePartialFailureError extends Error {
  readonly pageId: string
  readonly cleanedUp: boolean
  readonly bodyWriteError: unknown
  readonly cleanupError: unknown

  constructor(
    message: string,
    details: {
      pageId: string
      cleanedUp: boolean
      bodyWriteError: unknown
      cleanupError?: unknown
    }
  ) {
    super(message)
    this.name = "TaskCreatePartialFailureError"
    this.pageId = details.pageId
    this.cleanedUp = details.cleanedUp
    this.bodyWriteError = details.bodyWriteError
    this.cleanupError = details.cleanupError
  }
}

/**
 * Structured partial-state error raised by `TaskService.update`
 * when task properties land but the description body write fails.
 * State/title/due-date/etc. may already be visible in Notion while
 * the prose description remains unchanged, so a caller should inspect
 * before repeating non-idempotent state transitions.
 *
 * The literal `failedPhase` / `persisted` fields intentionally mirror
 * the class name so structured in-process callers do not need to parse
 * the message. The message is prefixed with the class name because MCP
 * transports flatten errors to text.
 */
export class TaskUpdatePartialFailureError extends Error {
  readonly taskId: string
  readonly failedPhase: "body"
  readonly persisted: { readonly properties: true; readonly body: false }
  readonly bodyWriteError: unknown

  constructor(message: string, details: { taskId: string; bodyWriteError: unknown }) {
    super(
      message.startsWith("TaskUpdatePartialFailureError: ")
        ? message
        : `TaskUpdatePartialFailureError: ${message}`
    )
    this.name = "TaskUpdatePartialFailureError"
    this.taskId = details.taskId
    this.failedPhase = "body"
    this.persisted = { properties: true, body: false }
    this.bodyWriteError = details.bodyWriteError
  }
}

export interface OverdueTaskWindow {
  items: TaskSummary[]
  capped: boolean
}

export class TaskService {
  /**
   * Resolved scope context — same posture as
   * `MemoryService.scopeCtx`. The default-retrieval filter narrows
   * `list()` to broadcast scopes plus narrow scopes whose `Scope
   * Key` matches the reader's identity slot. Tests construct
   * `TaskService` without scope context and stay on the unscoped
   * filter shape; production `initServicesFromConfig` always passes
   * a context, turning the filter on.
   */
  private scopeCtx: MemoryScopeContext = {}
  private scopeFilterEnabled = false

  constructor(
    private client: Client,
    private db: DatabaseRef,
    scopeCtx?: MemoryScopeContext
  ) {
    if (scopeCtx) {
      this.scopeCtx = scopeCtx
      this.scopeFilterEnabled = true
    }
  }

  /** Replace the scope context after construction. Same posture as
   *  `MemoryService.setScopeContext`. */
  setScopeContext(ctx: MemoryScopeContext): void {
    this.scopeCtx = ctx
    this.scopeFilterEnabled = true
  }

  /** Snapshot of the active scope context (read-only). */
  getScopeContext(): Readonly<MemoryScopeContext> {
    return this.scopeCtx
  }

  /**
   * Create a `Kind = task` memory. `subject` becomes the page title,
   * `description` the page body. The `Entity` column defaults to the
   * subject so `lore-query action='ask'` lookups always have a column
   * to match against — the migration relies on this when porting fact
   * subjects.
   *
   * Decodes plain-text fields at the write boundary so doubly-encoded
   * autosave input lands clean — same posture `MemoryService.create`
   * takes (PF1-06). Idempotent on clean values.
   */
  async create(input: CreateTaskInput): Promise<Task> {
    validateRichTextMetadataFields(
      { ...input, entity: input.entity ?? input.subject },
      "TaskService.create"
    )

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
    const synopsis =
      input.synopsis !== undefined ? decodeTextEntities(input.synopsis) : undefined
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
        // same overdue semantics so `lore-query action='audit'` and
        // the wake-up overdue branches keep working without new logic.
        reviewBy: input.dueDate,
        affectsIds: input.affectsIds,
        alternatives: input.alternatives,
        consequences: input.consequences,
        author: input.author,
        agent: input.agent,
        tags: input.tags,
        keywords,
        synopsis,
        session: input.session,
        taskState: state,
        blockedBy,
        entity,
        // Scope / lifetime. Tasks default to whatever scope the caller
        // passes; the conventional pairing is `kind: "session"` +
        // `lifetime: "until-task-closed"` for per-session tracked work.
        // The translation from `MemoryScopeInput` to builder primitives
        // matches `MemoryService.create`'s helper so the column writes
        // are consistent across both surfaces.
        scopeKind: input.scope?.kind,
        scopeKey: input.scope?.key,
        audience: input.scope?.audience,
        lifetime: input.scope?.lifetime,
        expiresAt: input.scope?.expiresAt,
      }),
    })

    if (description) {
      try {
        await this.client.pages.updateMarkdown({
          page_id: page.id,
          type: "insert_content",
          insert_content: { content: description },
        })
      } catch (bodyWriteError) {
        let cleanedUp = false
        let cleanupError: unknown
        try {
          await this.client.pages.update({
            page_id: page.id,
            archived: true,
          })
          cleanedUp = true
        } catch (err) {
          cleanupError = err
        }

        const cause =
          bodyWriteError instanceof Error
            ? bodyWriteError.message
            : String(bodyWriteError)
        const message = cleanedUp
          ? `Task create partial failure: the task row was ` +
            `created (page ${page.id}) but the description write failed: ${cause}. ` +
            `The orphan task row was archived to keep the vault consistent; ` +
            `retry the create to land a fresh row.`
          : `Task create partial failure: the task row was ` +
            `created (page ${page.id}) but the description write failed: ${cause}. ` +
            `The cleanup archive ALSO failed (${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }); the orphan task row remains live in the vault. Archive it ` +
            `manually before retrying to avoid a duplicate row.`
        throw new TaskCreatePartialFailureError(message, {
          pageId: page.id,
          cleanedUp,
          bodyWriteError,
          cleanupError,
        })
      }
    }

    return pageToMemory(
      await hydrateMemoryRelationProperties(this.client, page as PageObjectResponse),
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
    const memory = pageToMemory(
      await hydrateMemoryRelationProperties(this.client, page as PageObjectResponse),
      md.markdown
    )
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
   * markdown body. Defaults to `ACTIVE_TASK_STATES` so callers asking
   * for "the task list" don't accidentally see closed work. Archived
   * rows are filtered client-side; when they consume a Notion page
   * slot, the method keeps paginating until `limit` live rows are
   * collected or Notion is exhausted.
   */
  async list(
    opts?: ListTasksOpts
  ): Promise<{ items: TaskSummary[]; nextCursor?: string; capped: boolean }> {
    const filters: Array<Record<string, unknown>> = [
      { property: MEMORY_PROPS.KIND, select: { equals: "task" } },
    ]

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }
    const states = opts?.states ?? ACTIVE_TASK_STATES
    if (states.length === 1) {
      filters.push({ property: MEMORY_PROPS.TASK_STATE, select: { equals: states[0] } })
    } else if (states.length > 1) {
      filters.push({
        or: states.map((s) => ({
          property: MEMORY_PROPS.TASK_STATE,
          select: { equals: s },
        })),
      })
    }
    if (opts?.entities && opts.entities.length > 0) {
      // Server-side OR over `Entity rich_text contains` so alias-aware
      // recall in `lore-query action='ask'` produces the same task set
      // whether the user typed the canonical name or any registered
      // alias. A
      // single variant collapses to a flat clause so legacy
      // single-entity callers keep producing the same Notion filter
      // shape they did pre-PF4.
      if (opts.entities.length === 1) {
        filters.push({
          property: MEMORY_PROPS.ENTITY,
          rich_text: { contains: opts.entities[0] },
        })
      } else {
        filters.push({
          or: opts.entities.map((variant) => ({
            property: MEMORY_PROPS.ENTITY,
            rich_text: { contains: variant },
          })),
        })
      }
    }
    if (opts?.dueBefore) {
      filters.push({
        property: MEMORY_PROPS.REVIEW_BY,
        date: { on_or_before: opts.dueBefore },
      })
    }
    if (opts?.dueAfterOrEmpty) {
      filters.push({
        or: [
          {
            property: MEMORY_PROPS.REVIEW_BY,
            date: { is_empty: true },
          },
          {
            property: MEMORY_PROPS.REVIEW_BY,
            date: { after: opts.dueAfterOrEmpty },
          },
        ],
      })
    }

    const baseFilter = filters.length > 1 ? { and: filters } : filters[0]
    // Default scope filter. A session-scoped task created by another
    // reader's session must not surface in this reader's `lore-task
    // action='list'`; the filter applies the same scope-inclusion rule
    // as `MemoryService.list`. `includeOutOfScope: true` opts out for
    // audit/operator paths; the filter no-ops when no scope context
    // was injected.
    //
    // The server-side filter is 2-deep (Notion's compound-filter
    // limit); the kind+key binding runs client-side via
    // `matchesDefaultScope` threaded into `collectLivePages` as an
    // `extraFilter`. The walker backfills past dropped rows so the
    // result still hits `limit` when the vault has enough scope-
    // matching tasks.
    const today = todayUtc()
    const filter =
      opts?.includeOutOfScope === true || !this.scopeFilterEnabled
        ? baseFilter
        : withDefaultScopeFilter(baseFilter, this.scopeCtx, today)
    const applyExtraFilter =
      opts?.includeOutOfScope === true || !this.scopeFilterEnabled
        ? undefined
        : (page: PageObjectResponse) =>
            matchesDefaultScope(page.properties, this.scopeCtx, today)
    const sorts: QueryDataSourceParameters["sorts"] =
      opts?.sortBy === "updatedAtAsc"
        ? [
            { timestamp: "last_edited_time", direction: "ascending" },
            { property: MEMORY_PROPS.REVIEW_BY, direction: "ascending" },
            { timestamp: "created_time", direction: "descending" },
          ]
        : opts?.sortBy === "updatedAtDesc"
          ? [
              { timestamp: "last_edited_time", direction: "descending" },
              { property: MEMORY_PROPS.REVIEW_BY, direction: "ascending" },
              { timestamp: "created_time", direction: "descending" },
            ]
          : [
              { property: MEMORY_PROPS.REVIEW_BY, direction: "ascending" },
              { timestamp: "created_time", direction: "descending" },
            ]

    const limit = Math.min(opts?.limit ?? 20, 100)
    if (limit <= 0) {
      return { items: [], nextCursor: opts?.startCursor, capped: false }
    }

    const result = await collectLivePages({
      limit,
      startCursor: opts?.startCursor,
      source: "TaskService.list",
      query: ({ page_size, start_cursor }) =>
        this.client.dataSources.query({
          data_source_id: this.db.dataSourceId,
          filter: filter as QueryDataSourceParameters["filter"],
          // Default sort is due-date triage order: most-overdue /
          // soonest-due rows float to the top, matching the
          // `lore-query action='audit'` default. Wake-up passes
          // last-edited variants to load Stale / Active bucket windows
          // without due-date ordering hiding null-due rows.
          sorts,
          page_size,
          start_cursor,
        }),
      extraFilter: applyExtraFilter,
    })

    return {
      items: await Promise.all(
        result.pages.map((page) => pageToTaskSummary(this.client, page))
      ),
      nextCursor: result.nextCursor,
      capped: result.capped,
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
   * are agent-boundary fields that downstream `lore-query action='ask'`
   * and future similarity surfaces will read; idempotent on clean values.
   */
  async update(id: string, input: UpdateTaskInput): Promise<Task> {
    validateRichTextMetadataFields(input, "TaskService.update")

    const props: Record<string, unknown> = {}

    if (input.subject !== undefined) {
      props[MEMORY_PROPS.TITLE] = {
        title: [{ text: { content: decodeTextEntities(input.subject) } }],
      }
    }
    if (input.state) {
      props[MEMORY_PROPS.TASK_STATE] = { select: { name: input.state } }
      // Update-to-terminal stamps `Done At` in the same atom as the
      // state write so a closure-via-update produces the same on-disk
      // shape as `close()`. Without this, every update-to-terminal
      // would silently undercount the closure-rate metric. Re-open
      // (`state: "open"`) intentionally does NOT clear — `Done At`
      // tracks "most recent close timestamp" as historical fact.
      if (input.state === "done" || input.state === "cancelled") {
        const today = new Date().toISOString().split("T")[0]
        props[MEMORY_PROPS.DONE_AT] = { date: { start: today } }
      }
    }
    if (input.blockedBy !== undefined) {
      props[MEMORY_PROPS.BLOCKED_BY] = {
        rich_text: [{ text: { content: decodeTextEntities(input.blockedBy) } }],
      }
    }
    if (input.entity !== undefined) {
      props[MEMORY_PROPS.ENTITY] = {
        rich_text: [{ text: { content: decodeTextEntities(input.entity) } }],
      }
    }
    if (input.tags) {
      props[MEMORY_PROPS.TAGS] = {
        multi_select: input.tags.map((t) => ({ name: t })),
      }
    }
    if (input.keywords !== undefined) {
      props[MEMORY_PROPS.KEYWORDS] = {
        rich_text: [{ text: { content: decodeTextEntities(input.keywords) } }],
      }
    }
    // `!== undefined` (rather than `isCleared`) matches how `Blocked By`
    // and `Entity` are emitted on update — empty string is a valid clear
    // write and lands in Notion as a cleared rich_text. Using `isCleared`
    // would diverge from sibling text-field semantics for no benefit.
    if (input.synopsis !== undefined) {
      props[MEMORY_PROPS.SYNOPSIS] = {
        rich_text: [{ text: { content: decodeTextEntities(input.synopsis) } }],
      }
    }
    if (input.affectsIds) {
      props[MEMORY_PROPS.AFFECTS] = {
        relation: input.affectsIds.map((rid) => ({ id: rid })),
      }
    }
    // Empty string / null both clear the date; an explicit YYYY-MM-DD
    // sets it; `undefined` leaves it untouched. Same "empty string ==
    // absence" rule `isCleared` formalizes — Zod boundary maps both `""`
    // and `null` to "clear this column" in `{ date: null }` form.
    // `blockedBy` / `entity` follow the same rule but the column type
    // (rich_text) accepts an empty string verbatim, so they don't need
    // the explicit `{ date: null }` translation here.
    if (input.dueDate !== undefined) {
      props[MEMORY_PROPS.REVIEW_BY] = isCleared(input.dueDate)
        ? { date: null }
        : { date: { start: input.dueDate as string } }
    }
    // Scope / lifetime. Inlined-update path matches
    // `MemoryService.update`'s shape one-for-one — same tristate
    // semantics on each column. Tasks are Memories so the columns
    // are the same.
    if (input.scope !== undefined) {
      const scope = input.scope
      if (scope.kind !== undefined) {
        props[MEMORY_PROPS.SCOPE_KIND] =
          scope.kind === null ? { select: null } : { select: { name: scope.kind } }
      }
      if (scope.key !== undefined) {
        props[MEMORY_PROPS.SCOPE_KEY] = {
          rich_text: [{ text: { content: scope.key } }],
        }
      }
      if (scope.audience !== undefined) {
        props[MEMORY_PROPS.AUDIENCE] = {
          rich_text: [{ text: { content: scope.audience } }],
        }
      }
      if (scope.lifetime !== undefined) {
        props[MEMORY_PROPS.LIFETIME] =
          scope.lifetime === null
            ? { select: null }
            : { select: { name: scope.lifetime } }
      }
      if (scope.expiresAt !== undefined) {
        props[MEMORY_PROPS.EXPIRES_AT] =
          scope.expiresAt === null ? { date: null } : { date: { start: scope.expiresAt } }
      }
    }

    let propertiesApplied = false
    if (Object.keys(props).length > 0) {
      await this.client.pages.update({
        page_id: id,
        properties: props as CreatePageParameters["properties"],
      })
      propertiesApplied = true
    }

    if (input.description !== undefined) {
      try {
        await this.client.pages.updateMarkdown({
          page_id: id,
          type: "replace_content",
          replace_content: {
            new_str: decodeTextEntities(input.description),
            allow_deleting_content: true,
          },
        })
      } catch (bodyWriteError) {
        if (!propertiesApplied) {
          throw bodyWriteError
        }
        const cause =
          bodyWriteError instanceof Error
            ? bodyWriteError.message
            : String(bodyWriteError)
        throw new TaskUpdatePartialFailureError(
          `Task update partial failure: properties for task ${id} persisted, ` +
            `but the description write failed during phase "body": ${cause}. ` +
            `The property changes are already on Notion; the description body ` +
            `was not written. Inspect the row before retrying the update.`,
          { taskId: id, bodyWriteError }
        )
      }
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
   * downstream `lore-task action='list'` queries with `state: "done"`
   * surface the closed row
   * for re-triage. If we ever need stricter semantics, the model would
   * be `expectedCurrentState` à la decision supersession's read-then-write
   * discipline.
   */
  async close(id: string, state: "done" | "cancelled" = "done"): Promise<void> {
    // Stamp `Done At` in the same atom as the state write. Notion's
    // per-request atomicity guarantees both columns either land or
    // neither does — no two-phase write that could leave a closed task
    // without a closure date or vice versa. Idempotent under contention:
    // a second close overwrites with the new today, matching the existing
    // last-write-wins state-overwrite posture.
    const today = new Date().toISOString().split("T")[0]
    await this.client.pages.update({
      page_id: id,
      properties: {
        [MEMORY_PROPS.TASK_STATE]: { select: { name: state } },
        [MEMORY_PROPS.DONE_AT]: { date: { start: today } },
      } as CreatePageParameters["properties"],
    })
  }

  /**
   * Count active tasks broken into the buckets `lore status` surfaces.
   * One paginated walk against `list({ states: ACTIVE_TASK_STATES })`
   * per call — bounded by total active count, not vault size.
   *
   * `today` is caller-supplied so the active-window and the closed-
   * window threaded by `taskStats` agree to the millisecond. Per-method
   * `new Date()` would let the two windows disagree by whatever wall-
   * clock time elapsed between them, which makes status tests flap on
   * clock skew.
   */
  async countActive(opts: { projectId?: string; today: string }): Promise<{
    total: number
    overdue: number
    stale: number
    inProgress: number
    blocked: number
  }> {
    const today = opts.today
    // Defense-in-depth at the public service boundary. Without this,
    // a malformed `today` cascades silently: `new Date(NaN)` flows
    // through `taskDaysOverdue` / `taskDaysStale` as `NaN`, every
    // comparison against `NaN` is `false`, and every bucket zeros
    // out. `taskStats` (the typical caller) already validates, but
    // `countActive` is public and a direct caller bypassing the
    // orchestrator deserves the same error shape.
    parseTodayMs(today, "countActive")
    let total = 0
    let overdue = 0
    let stale = 0
    let inProgress = 0
    let blocked = 0
    let cursor: string | undefined = undefined
    do {
      const page = await this.list({
        projectId: opts.projectId,
        states: ACTIVE_TASK_STATES,
        limit: 100,
        startCursor: cursor,
      })
      for (const t of page.items) {
        total++
        if (taskDaysOverdue(t, today) !== null) {
          overdue++
        } else {
          const days = taskDaysStale(t, today)
          if (days !== null && days >= STALE_TASK_DAYS) stale++
        }
        if (t.taskState === "in-progress") inProgress++
        if (t.taskState === "blocked") blocked++
      }
      cursor = page.nextCursor
    } while (cursor)
    return { total, overdue, stale, inProgress, blocked }
  }

  /**
   * Count tasks whose `Done At` is on or after `date` AND whose
   * current `Task State` is terminal (`done` / `cancelled`). Returns
   * `null` on a vault that hasn't run the `Done At`-introducing
   * migration (the column doesn't exist; Notion returns a
   * `validation_error` on the filter clause) so the caller
   * can suppress the closure-rate line entirely instead of
   * fabricating a zero.
   *
   * **Why the terminal-state filter is load-bearing.** `Done At` is
   * preserved across re-open by design (`update({ state: "open" })`
   * keeps the prior `Done At` as historical fact — see the docstring
   * on `update()`). Without the state guard, a task closed inside
   * the window then re-opened would still match the filter and
   * inflate the closure count even though it's currently active.
   * "Closed last 30 days" means *currently-closed in the last 30
   * days*, not *ever-closed* — the state filter pins that.
   *
   * Uses `this.client` / `this.db` directly rather than going through
   * `list()` because `Done At` is not in the public filter map and
   * exposing it would only serve this one caller.
   */
  async countClosedSince(
    date: string,
    opts?: { projectId?: string }
  ): Promise<number | null> {
    try {
      let total = 0
      let cursor: string | undefined = undefined
      do {
        const filters: Array<Record<string, unknown>> = [
          { property: MEMORY_PROPS.KIND, select: { equals: "task" } },
          { property: MEMORY_PROPS.DONE_AT, date: { on_or_after: date } },
          {
            or: [
              { property: MEMORY_PROPS.TASK_STATE, select: { equals: "done" } },
              { property: MEMORY_PROPS.TASK_STATE, select: { equals: "cancelled" } },
            ],
          },
        ]
        if (opts?.projectId) filters.push(projectOrUnscopedFilter(opts.projectId))
        const response = await this.client.dataSources.query({
          data_source_id: this.db.dataSourceId,
          filter: { and: filters } as QueryDataSourceParameters["filter"],
          page_size: 100,
          start_cursor: cursor,
        })
        total += response.results.filter(isLiveFullPage).length
        cursor =
          response.has_more && response.next_cursor ? response.next_cursor : undefined
      } while (cursor)
      return total
    } catch (err) {
      if (isMissingPropertyError(err)) return null
      throw err
    }
  }

  /**
   * Active tasks past their due date. Uses the shared live-row refill cap so
   * archive-heavy vaults do not walk Notion unboundedly. Callers that need to
   * tell users the scan hit that cap should use `queryOverdueWindow`; this
   * compatibility wrapper returns only the visible summaries.
   */
  async queryOverdue(opts?: {
    projectId?: string
    limit?: number
    includeOutOfScope?: boolean
  }): Promise<TaskSummary[]> {
    const { items } = await this.queryOverdueWindow(opts)
    return items
  }

  async queryOverdueWindow(opts?: {
    projectId?: string
    limit?: number
    /**
     * Opt out of the default-scope filter so audit /
     * migration callers can see narrow-scope and expired rows. The
     * MCP `lore-query action='audit'` surface consumes this method,
     * so the gate keeps the default `false`: a session-scoped
     * overdue task must not leak to a different reader through
     * audit any more than it does through `list()`.
     */
    includeOutOfScope?: boolean
  }): Promise<OverdueTaskWindow> {
    const today = new Date().toISOString().split("T")[0]
    const filters: Array<Record<string, unknown>> = [
      { property: MEMORY_PROPS.KIND, select: { equals: "task" } },
      { property: MEMORY_PROPS.REVIEW_BY, date: { on_or_before: today } },
      {
        or: ACTIVE_TASK_STATES.map((s) => ({
          property: MEMORY_PROPS.TASK_STATE,
          select: { equals: s },
        })),
      },
    ]
    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }

    const baseFilter = { and: filters }
    // Default scope filter. Same posture as `list()`
    // above: server-side narrows to broadcast + reader's narrow kinds
    // (Notion's 2-deep cap), client-side `matchesDefaultScope`
    // threaded as `collectLivePages.extraFilter` enforces the
    // kind+key binding so a session-scoped overdue task drops out
    // of `lore-query action='audit'` for readers whose session id
    // differs.
    const filter =
      opts?.includeOutOfScope === true || !this.scopeFilterEnabled
        ? baseFilter
        : withDefaultScopeFilter(baseFilter, this.scopeCtx, today)
    const applyExtraFilter =
      opts?.includeOutOfScope === true || !this.scopeFilterEnabled
        ? undefined
        : (page: PageObjectResponse) =>
            matchesDefaultScope(page.properties, this.scopeCtx, today)

    const limit = opts?.limit ?? LIVE_PAGE_REFILL_MAX_ROWS
    if (limit <= 0) return { items: [], capped: false }
    const result = await collectLivePages({
      limit,
      source: "TaskService.queryOverdue",
      query: ({ page_size, start_cursor }) =>
        this.client.dataSources.query({
          data_source_id: this.db.dataSourceId,
          filter: filter as QueryDataSourceParameters["filter"],
          sorts: [{ property: MEMORY_PROPS.REVIEW_BY, direction: "ascending" }],
          page_size,
          start_cursor,
        }),
      extraFilter: applyExtraFilter,
    })
    if (result.capped) {
      warnLivePageCapFired({
        source: "TaskService.queryOverdue",
        pages: result.pageCount,
        accumulated: result.pages.length,
        limit,
      })
    }

    return {
      items: await Promise.all(
        result.pages.map((page) => pageToTaskSummary(this.client, page))
      ),
      capped: result.capped,
    }
  }
}

async function pageToTaskSummary(
  client: Client,
  page: PageObjectResponse
): Promise<TaskSummary> {
  const hydrated = await hydrateMemoryRelationProperties(client, page)
  return toTaskSummary(pageToMemory(hydrated, "") as Task)
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
 * still within its window. Same shape as the knowledge tool's
 * `daysOverdue` so the rendering layer can share its urgency-marker
 * helpers.
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

/**
 * Days since `last_edited_time` for an active task. Returns `null` when
 * the task is in a terminal state (closed tasks aren't "stale", they're
 * "done") or when `updatedAt` is missing. Sibling of `taskDaysOverdue`
 * — same `Pick<TaskSummary>` shape and same `null`-or-positive-int
 * return semantics so the rendering layer can branch on both
 * uniformly.
 *
 * `TaskSummary` inherits `updatedAt: string` from `Memory` via the
 * `Omit<Memory, "content">` projection; the field is
 * populated by `pageToMemory` from Notion's `last_edited_time` page
 * attribute. `last_edited_time` updates on any property change — a tag
 * edit, a comment, a re-relation — so a "stale" task here is "no edits
 * in N days" rather than "no real progress in N days". Acceptable for
 * the wake-up surfacing use case: false positives are rare and
 * recoverable (the agent reads the body and decides not to close).
 *
 * Calendar-day diff: `updatedAt` is truncated to its `YYYY-MM-DD`
 * prefix before parsing so a task edited today at noon yields `0`, not
 * `-1`. Mirrors `taskDaysOverdue`'s posture against `reviewBy` (which
 * is already date-only off the Notion `date` column). `today` is a
 * YYYY-MM-DD UTC day (parses to UTC midnight); `updatedAt` carries
 * arbitrary time-of-day, so the truncation is what makes "untouched
 * ≥30 days" honest about whole-day counts.
 */
export function taskDaysStale(
  task: Pick<TaskSummary, "updatedAt" | "taskState">,
  today: string
): number | null {
  if (!ACTIVE_TASK_STATES.includes(task.taskState as TaskState)) return null
  if (!task.updatedAt) return null
  const updatedDate = task.updatedAt.split("T")[0]
  const diff = new Date(today).getTime() - new Date(updatedDate).getTime()
  return Math.floor(diff / 86_400_000)
}

/**
 * Aggregated task counts surfaced by `lore status` /
 * `lore-context action='status'`. `closedLast30Days` is `null` on
 * vaults that lack the `Done At` column; the renderer
 * suppresses the closure-rate line entirely in that case.
 */
export interface TaskStats {
  active: number
  overdue: number
  stale: number
  inProgress: number
  blocked: number
  closedLast30Days: number | null
}

/**
 * Today's date in UTC YYYY-MM-DD form, suitable as the `today` anchor
 * threaded into `taskStats`. Centralized so both status surfaces (CLI
 * and MCP) compute the anchor identically — silent skew between the
 * two would let the rendered Tasks line diverge on a vault that's
 * queried from both surfaces around midnight UTC.
 */
export function todayUtc(): string {
  return new Date().toISOString().split("T")[0]!
}

/**
 * Parse a YYYY-MM-DD `today` argument and surface a clean
 * `RangeError` on malformed input. Without this guard, a malformed
 * value cascades silently: `new Date(NaN).getTime()` returns NaN,
 * comparisons against NaN return false, every bucket zeros out, and
 * the operator sees a wrong status without any error in stderr.
 *
 * Used by `taskStats` (orchestrator) and `TaskService.countActive`
 * (public service method) — the two boundaries where a malformed
 * `today` could plausibly enter the system. The helper takes a
 * caller-name string so the failure message names the offending
 * site rather than this helper.
 */
function parseTodayMs(today: string, caller: string): number {
  const todayMs = new Date(today).getTime()
  if (Number.isNaN(todayMs)) {
    throw new RangeError(
      `${caller}: invalid today value "${today}" — expected YYYY-MM-DD`
    )
  }
  return todayMs
}

/**
 * Compose `TaskService.countActive` and `TaskService.countClosedSince`
 * into the single shape rendered by both status surfaces.
 *
 * Takes the `TaskService` directly (not the whole services bag) — the
 * orchestrator doesn't need any other service. Both queries fan out
 * via `Promise.all`, so wall-clock is `max(active, closed)` rather
 * than the sum.
 *
 * `today` is caller-supplied so per-test fixtures can pin a fixed
 * date; the active and closed windows derive from the same anchor so
 * they cannot disagree by clock skew.
 */
export async function taskStats(
  service: TaskService,
  opts: { projectId?: string; today: string }
): Promise<TaskStats> {
  const todayMs = parseTodayMs(opts.today, "taskStats")
  // 30-day window inclusive of `today`: `today - 29 days` through `today`
  // is 30 calendar days when `Done At on_or_after windowStart` is matched
  // against rows whose date is on or before `today`. Subtracting 30 days
  // would cover 31 inclusive days and silently inflate the rate against
  // the `N / 30` divisor by ~3.3% — the label reads "Closed last 30 days"
  // verbatim, so the math must match.
  const windowStart = new Date(todayMs - 29 * 86_400_000).toISOString().split("T")[0]!
  const [active, closedLast30Days] = await Promise.all([
    service.countActive({ projectId: opts.projectId, today: opts.today }),
    service.countClosedSince(windowStart, { projectId: opts.projectId }),
  ])
  return {
    active: active.total,
    overdue: active.overdue,
    stale: active.stale,
    inProgress: active.inProgress,
    blocked: active.blocked,
    closedLast30Days,
  }
}

/**
 * Prefix used for both the primary Tasks line and the continuation-
 * line indent on the closure-rate row. Pinned at the constant so a
 * future copy edit on the primary line (e.g. `Tasks (project): `)
 * doesn't silently rot the alignment of the second line.
 */
const TASKS_PREFIX = "Tasks: "

/**
 * Render the Tasks line from a `TaskStats` report. Both `lore status`
 * (CLI) and `lore-context action='status'` (MCP) call this so the
 * rendered output is byte-identical across surfaces.
 *
 * Returns one or two lines:
 *
 * - Always: a `Tasks: N active …` line. Sub-stats render only when
 *   non-zero, joined by `, `. When `active === 0` the line is the
 *   bare `Tasks: 0 active` form — operator signal that the vault is
 *   task-empty, not that the surface is broken.
 * - Optionally: a closure-rate continuation line, indented to align
 *   under the start of `N` on the primary line so the two read as
 *   one logical block. Rendered only when `closedLast30Days !== null`
 *   (vaults with the `Done At` column). Older vaults silently omit
 *   the line.
 *
 * Pure function: deterministic in `report`, no I/O.
 */
export function formatTaskSummary(report: TaskStats): string[] {
  const lines: string[] = []
  if (report.active === 0) {
    lines.push(`${TASKS_PREFIX}0 active`)
  } else {
    const subStats: string[] = []
    if (report.overdue > 0) subStats.push(`overdue: ${report.overdue}`)
    if (report.stale > 0) subStats.push(`stale ≥${STALE_TASK_DAYS}d: ${report.stale}`)
    if (report.inProgress > 0) subStats.push(`in-progress: ${report.inProgress}`)
    if (report.blocked > 0) subStats.push(`blocked: ${report.blocked}`)
    const suffix = subStats.length > 0 ? ` (${subStats.join(", ")})` : ""
    lines.push(`${TASKS_PREFIX}${report.active} active${suffix}`)
  }
  if (report.closedLast30Days !== null) {
    const rate = (report.closedLast30Days / 30).toFixed(2)
    // Indent derived from `TASKS_PREFIX` so the continuation line
    // aligns under the count on the primary line regardless of any
    // future prefix change.
    const indent = " ".repeat(TASKS_PREFIX.length)
    lines.push(
      `${indent}Closed last 30 days: ${report.closedLast30Days} (rate: ${rate}/day)`
    )
  }
  return lines
}
