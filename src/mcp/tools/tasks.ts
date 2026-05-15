/**
 * Task tools.
 *
 * Tasks are the canonical surface for tracked work. The polymorphic
 * `lore-task` dispatcher is action-routed across
 * `create` / `update` / `close` / `list` — matching the rest of the
 * polymorphic family (`lore-memory`, `lore-decision`, etc.).
 *
 * Each handler is a thin orchestration layer over `services.tasks`
 * (`TaskService`) plus project-name resolution; the heavy lifting —
 * schema, defaults, Notion calls — lives in `TaskService`.
 */

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import {
  debugLogPartialFailures,
  formatDispatchError,
  paginationFooter,
  toolError,
  withWakeUpCacheBump,
} from "../helpers.js"
import { resolveProjectIds, resolveReadProjectScope } from "../resolve.js"
import { createTagsSchema, keywordsSchema } from "./tag-schema.js"
import { scopeInputSchema } from "./scope-schema.js"
import { taskDaysOverdue } from "../../core/task.js"
import {
  findDuplicateActiveTasks,
  findExactReuseTarget,
} from "../../core/near-duplicate.js"
import { decodeTextEntities } from "../../notion/html-entities.js"
import { resolveFeatureFlags } from "../../feature-flags.js"
import { renderTrustLine, truncateSynopsis } from "../render.js"
import {
  reconcileActiveTasks,
  formatReconcileOutput,
  DEFAULT_RECONCILE_LIMIT,
  DEFAULT_RECONCILE_MIN_SCORE,
  MAX_RECONCILE_LIMIT,
} from "../../core/task-reconcile.js"
import { validateTaskSubjectForCreate } from "../../core/task-subject-validation.js"
import { ACTIVE_TASK_STATES, SYNOPSIS_MAX } from "../../types.js"
import type { ListTasksOpts, TaskState, TaskSummary } from "../../types.js"
import { resolveAuthorForWrite } from "../../auth/identity.js"
import { clearableYmdDateSchema, ymdDateSchema } from "./date-schema.js"
import { nonBlankString } from "./text-schema.js"

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
  /** Issue #495 — see `withWakeUpCacheBump`'s docstring for the marker contract. */
  noopWrite?: boolean
}

const TASK_STATES = ["open", "in-progress", "blocked", "done", "cancelled"] as const

const CLOSE_STATES = ["done", "cancelled"] as const

const CONFIDENCES = ["certain", "likely", "speculative"] as const

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

/**
 * Cross-field guard for the `state: "blocked"` requirement: a blocked
 * task must carry a meaningful `blockedBy` label, so absent / cleared /
 * whitespace-only values all fail. Returns `true` when the value cannot
 * support a `blocked` transition.
 *
 * The create path used `!args.blockedBy` (which lets `"   "` pass
 * because `!"   "` is `false`) and the update path used
 * `=== undefined || === ""` (which lets `"   "` pass because strict
 * compare misses whitespace-only). Both guards now route through this
 * helper so the trim discipline can't silently re-diverge across the
 * two paths. This is the authoritative cross-field check; per-field
 * Zod can't express a multi-field invariant, so `blockedBy` itself
 * stays declared as `z.string().optional()` on the dispatch schema and
 * the empty-string clear semantic on non-`blocked` updates is
 * preserved.
 *
 * The `null` branch is defense-in-depth — `CreateArgs.blockedBy` and
 * `UpdateArgs.blockedBy` are typed `string | undefined` and the Zod
 * schemas are not `.nullable()`, so the documented MCP path can't
 * produce `null` today. Accepting it costs nothing and survives a
 * future schema flip without re-introducing the gap this helper
 * exists to close.
 */
function isUnusableBlockerLabel(value: string | undefined | null): boolean {
  return value === undefined || value === null || value.trim() === ""
}

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
 * Trust indicator: when the row's
 * stored `Confidence Score` is below `CONFIDENCE_DISPLAY_THRESHOLD`, an
 * indented italic label lands between the title row and the synopsis,
 * matching the placement in `formatMemoryListItem`. Null and above-
 * threshold rows render byte-identically — unmigrated vaults look
 * unchanged until `lore migrate --build-confidence-scores` populates
 * scores. NOT gated by `includeSynopsis`: trust is system metadata,
 * not synopsis content; the two surfaces are independent.
 */
function formatTaskRow(
  t: TaskSummary,
  today: string,
  options: { includeSynopsis?: boolean } = {}
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
  scope?: import("../../types.js").MemoryScopeInput
  allowPointerSubject?: boolean
}

/**
 * Names the caller-provided non-key fields that the assertive-reuse
 * branch will silently ignore. The reuse predicate consumes
 * only `(subject, entity, projectIds)` — every other create-time field
 * is structurally dropped if reuse fires. Surfacing the dropped names
 * in the response prevents an agent from believing a state transition
 * or due-date bump landed when only the subject + entity were honored.
 *
 * `agent`, `session`, and `author` are excluded — they are session /
 * provenance metadata, not task fields the operator intends to mutate.
 * `projectName` / `projectNames` are excluded because they participate
 * in the reuse-key (project-set), not as ignored side-channel data.
 * `topicName` and `forceNewTopic` ARE listed because `topics.getOrCreate`
 * is deferred until after the reuse gate, so passing them on a reuse
 * call had no observable effect on the existing row's topic relation.
 */
function collectIgnoredReuseFields(args: CreateArgs): string[] {
  const ignored: string[] = []
  if (args.description !== undefined) ignored.push("description")
  if (args.state !== undefined) ignored.push("state")
  if (args.blockedBy !== undefined) ignored.push("blockedBy")
  if (args.dueDate !== undefined) ignored.push("dueDate")
  if (args.affectsIds !== undefined && args.affectsIds.length > 0)
    ignored.push("affectsIds")
  if (args.topicName !== undefined) ignored.push("topicName")
  if (args.forceNewTopic !== undefined) ignored.push("forceNewTopic")
  if (args.confidence !== undefined) ignored.push("confidence")
  if (args.tags !== undefined && args.tags.length > 0) ignored.push("tags")
  if (args.keywords !== undefined) ignored.push("keywords")
  if (args.synopsis !== undefined) ignored.push("synopsis")
  return ignored
}

async function handleCreate(
  services: LoreServices,
  args: CreateArgs
): Promise<ToolResult> {
  try {
    const features = services.features ?? resolveFeatureFlags()
    // A `blocked` task with no `blockedBy` label is useless to
    // triage — the row says "I'm blocked" without naming the
    // blocker. Reject at the boundary rather than letting the empty
    // row land. The migration path explicitly populates `Blocked By`
    // when porting `blocked_by` / `waiting_on` facts, so this guard
    // only fires on fresh agent calls; cross-field, so it can't live
    // on the per-field Zod map. `isUnusableBlockerLabel` traps the
    // whitespace-only case (`"   "`) the bare truthiness check missed.
    if (args.state === "blocked" && isUnusableBlockerLabel(args.blockedBy)) {
      throw new Error(
        'state: "blocked" requires a `blockedBy` label naming the dependency ' +
          "(PR number, person, external service). A blocked task with no blocker is " +
          'unactionable. Pass `blockedBy` or use state: "open" if no specific blocker exists.'
      )
    }
    const subjectValidation = validateTaskSubjectForCreate(args)
    if (!subjectValidation.ok) {
      throw new Error(subjectValidation.message)
    }
    const authorPromise = resolveAuthorForWrite(args.author, services.identity)
    const resolved = await resolveProjectIds(
      services,
      args.projectName,
      args.projectNames
    )

    // Sequenced probe — assertive reuse needs the entity-matched
    // candidate set in hand BEFORE deciding whether to create, so an
    // exact `(entity, subject, project-set)` match can short-circuit
    // to reuse without leaving an orphan task or topic. The probe
    // runs sequentially with `services.tasks.create` (same posture as
    // `MemoryService.upsertByTopicKey`'s pre-create
    // `findByTopicKey` lookup). Cost is one extra
    // `dataSources.query` round-trip on the create path; bounded
    // (limit=10) and the same query the advisory footer needs anyway.
    //
    // Server-side scope is `projectId: resolved.ids[0]` (single id) —
    // sufficient because Notion's `Project contains <id>` matches every
    // row whose Project relation includes that id regardless of other
    // memberships. A multi-project caller's `[A, B]` create still finds
    // every existing `[A]`, `[A, B]`, `[A, B, C]`, `[A, C]` row via
    // `contains "A"`. The full-set equality check on the predicate side
    // (`findExactReuseTarget`) catches structural mismatches post-fetch.
    // An empty `resolved.ids[]` (repo-wide create) flows `undefined`
    // through to `tasks.list`, which queries unscoped — correct for
    // matching another repo-wide row.
    //
    // `probeEntity` is the decoded canonical form. `TaskService.create`
    // decodes `args.entity ?? args.subject` at the write boundary, so
    // every consumer that compares against a stored row's Entity column
    // must operate on the decoded form: the probe issues
    // `Entity contains <decodedEntity>` server-side, the predicate
    // (`findExactReuseTarget`) compares decoded titles via
    // `normalizeReuseKey`, and the advisory close-CTA footer renders the
    // same canonical form an operator sees in Notion. Decoding once
    // here keeps the three consumers internally consistent.
    // `decodeTextEntities` is idempotent, so the redundant decode
    // inside `findDuplicateActiveTasks` and `normalizeReuseKey`
    // remains correct (and load-bearing for non-MCP callers that
    // don't pre-decode).
    const probeEntity = decodeTextEntities(args.entity ?? args.subject)
    const duplicates = await findDuplicateActiveTasks(services.tasks, {
      entity: probeEntity,
      projectId: resolved.ids[0],
      features,
      onError: (err) =>
        debugLogPartialFailures("lore-task", [{ rootId: "duplicate-probe", error: err }]),
    })

    // Assertive reuse: an exact structural duplicate (same normalized
    // entity, subject, and project-set) returns the existing task
    // without creating. Topic creation is deferred until after this
    // gate so a reuse hit does not leak an orphan Topic — same
    // discipline `lore-memory action='save'` follows for the autosave
    // learning duplicate gate. `LORE_DISABLE_TASK_REUSE=1` (or the
    // broader `LORE_DISABLE_NEAR_DUPLICATE_PROBE=1`) restores
    // advisory-only behavior.
    const reuseTarget = findExactReuseTarget(duplicates, {
      subject: args.subject,
      entity: probeEntity,
      projectIds: resolved.ids,
      features,
    })

    if (reuseTarget !== null) {
      // Record for `lore-fact action='create'` session auto-link,
      // mirroring the create branch — a fact emitted later in the
      // session should still resolve to this task as its source even
      // when the row was reused rather than freshly created.
      services.sessionMemories.record(
        { agent: args.agent, session: args.session },
        { memoryId: reuseTarget.id, projectIds: reuseTarget.projectIds }
      )

      const projectLabel = resolved.ids.length
        ? (args.projectNames?.join(", ") ??
          args.projectName ??
          services.context.project?.name ??
          "auto-detected")
        : "none (repo-wide)"

      const reuseLines = [
        `Reused existing task: "${reuseTarget.title}" (${reuseTarget.id})`,
        `State: ${reuseTarget.taskState ?? "open"}`,
        `Project: ${projectLabel}`,
      ]
      if (reuseTarget.entity && reuseTarget.entity !== reuseTarget.title) {
        reuseLines.push(`Entity: ${reuseTarget.entity}`)
      }
      if (reuseTarget.reviewBy) {
        reuseLines.push(`Due: ${reuseTarget.reviewBy}`)
      }
      if (reuseTarget.blockedBy) {
        reuseLines.push(`Blocked by: ${reuseTarget.blockedBy}`)
      }
      if (resolved.warnings.length > 0) {
        reuseLines.push(`Warnings: ${resolved.warnings.join("; ")}`)
      }

      // Surface the caller-provided non-key fields that were dropped on
      // reuse. Reuse only consumes `(subject, entity, projectIds)` — every
      // other field on the create payload is structurally ignored, which
      // can blindside an agent calling create to land a state transition,
      // due-date bump, or description update against an existing task.
      // The audit-trail discipline matches Lore's other write-side
      // surfaces (e.g. `MemoryService.upsertByTopicKey`'s promotion
      // advisory, `FactService.createWithDedup`'s `enriched` field):
      // assertive idempotency must name what it ignored.
      const ignoredFields = collectIgnoredReuseFields(args)
      if (ignoredFields.length > 0) {
        reuseLines.push(
          `Ignored on reuse: ${ignoredFields.join(", ")} — use ` +
            `lore-task({ action: 'update', taskId: '${reuseTarget.id}', ... }) ` +
            `to change them.`
        )
      }

      reuseLines.push(
        "",
        "Subject and entity match an existing active task; nothing was created.",
        `Update the existing row if needed: ` +
          `lore-task({ action: 'update', taskId: '${reuseTarget.id}', ... })`,
        `Close it when the work is done: ` +
          `lore-task({ action: 'close', taskId: '${reuseTarget.id}' })`
      )

      return {
        content: [{ type: "text", text: reuseLines.join("\n") }],
        // Assertive reuse short-circuits before
        // `services.tasks.create` runs — Notion was not mutated and
        // the wake-up cache should NOT be invalidated for this path.
        // See `withWakeUpCacheBump`'s docstring for the marker
        // contract.
        noopWrite: true,
      }
    }

    let topicId: string | undefined
    let topicLabel = "none"
    if (args.topicName && resolved.ids.length > 0) {
      const topic = await services.topics.getOrCreate(args.topicName, resolved.ids, {
        forceNew: args.forceNewTopic,
      })
      topicId = topic.id
      topicLabel = topic.name
    } else if (args.topicName) {
      resolved.warnings.push(
        `Topic "${args.topicName}" skipped (requires at least one project)`
      )
    }

    const resolvedAuthor = await authorPromise
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
      synopsis: args.synopsis,
      // DEFERRED-ATTRIBUTION: caller override wins without touching
      // identity resolution; omitted authors use the lazy resolver.
      author: resolvedAuthor,
      agent: args.agent,
      session: args.session,
      // Scope / lifetime.
      scope: args.scope,
    })

    // The probe ran before create, so by construction `task.id` cannot
    // appear in `duplicates`. A parallel-probe posture would require
    // a post-fetch `t.id !== task.id` filter to close the
    // eventual-consistency window between create and the query index;
    // sequencing makes that filter unnecessary. The advisory footer
    // renders `duplicates` directly.
    const filteredDuplicates = duplicates

    // Record for `lore-fact action='create'` session auto-link,
    // mirroring how `lore-memory` action='save' and
    // `lore-decision` action='create' plant a session pointer so a
    // later fact can auto-link this task as its source.
    services.sessionMemories.record(
      { agent: args.agent, session: args.session },
      { memoryId: task.id, projectIds: task.projectIds }
    )

    const projectLabel = resolved.ids.length
      ? (args.projectNames?.join(", ") ??
        args.projectName ??
        services.context.project?.name ??
        "auto-detected")
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
          `(${filteredDuplicates.length}) — close any that are obsolete:`
      )
      for (const dup of filteredDuplicates) {
        const stateLabel = dup.taskState ?? "open"
        lines.push(
          `  - "${dup.title}" [${stateLabel}] — ` +
            `lore-task({ action: 'close', taskId: '${dup.id}' })`
        )
      }
    }

    lines.push(
      `\nClose this task when the work is done: ` +
        `lore-task({ action: 'close', taskId: '${task.id}' })`
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
  dueDate?: string | null
  subject?: string
  description?: string
  tags?: string[]
  keywords?: string
  synopsis?: string
  scope?: import("../../types.js").MemoryScopeInput
}

async function handleUpdate(
  services: LoreServices,
  args: UpdateArgs
): Promise<ToolResult> {
  try {
    // Mirror create's `state: "blocked"` requirement: if the caller
    // is transitioning into `blocked`, they must name the blocker
    // in the same call. This conservative check trips even when the
    // task already has a `Blocked By` value from a prior write —
    // restating the blocker on every transition is explicit and
    // cheap, and avoids a pre-read round-trip that would otherwise
    // be needed to inspect the existing column. Setting an empty
    // string explicitly clears it; that's still a valid combination
    // with non-`blocked` states, just not with `state: "blocked"`.
    // Whitespace-only values (`"   "`) fail too — the strict
    // empty-string compare missed them, so the guard funnels through
    // the shared helper to keep create and update parity tight.
    if (args.state === "blocked" && isUnusableBlockerLabel(args.blockedBy)) {
      throw new Error(
        'Transitioning to state: "blocked" requires a `blockedBy` label in the same call. ' +
          "A blocked task with no blocker is unactionable; restate the blocker explicitly even if " +
          "the row already had one set."
      )
    }

    const updated = await services.tasks.update(args.taskId, {
      state: args.state as TaskState | undefined,
      blockedBy: args.blockedBy,
      entity: args.entity,
      dueDate: args.dueDate,
      subject: args.subject,
      description: args.description,
      tags: args.tags,
      keywords: args.keywords,
      synopsis: args.synopsis,
      // Scope / lifetime update.
      scope: args.scope,
    })

    const lines = [
      `Updated task: "${updated.title}" (${updated.id})`,
      `State: ${updated.taskState ?? "open"}`,
    ]
    if (updated.reviewBy) lines.push(`Due: ${updated.reviewBy}`)
    if (updated.blockedBy) lines.push(`Blocked by: ${updated.blockedBy}`)
    // Echo the entity so a rename (e.g. canonicalizing
    // "PR 1234" → "PR-1234") is observable in the response,
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
          `lore-task({ action: 'close', taskId: '${updated.id}' })`
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

async function handleClose(services: LoreServices, args: CloseArgs): Promise<ToolResult> {
  try {
    const closingState: "done" | "cancelled" = args.state ?? "done"
    await services.tasks.close(args.taskId, closingState)

    // Re-read the post-close row so the response can echo the stamped
    // `Done At`. On a vault that hasn't migrated the
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

async function handleList(services: LoreServices, args: ListArgs): Promise<ToolResult> {
  try {
    const { projectId } = await resolveReadProjectScope(services, args.projectName)

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
      return {
        content: [
          {
            type: "text",
            text: `${emptyText}${paginationFooter(nextCursor, { truncated: saturated })}`,
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
      allRows: TaskSummary[]
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
          overdue.map((t) => formatTaskRow(t, today, { includeSynopsis })).join("\n")
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
          active.map((t) => formatTaskRow(t, today, { includeSynopsis })).join("\n")
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
          `totals are lower bounds. ${nextStep}`
      )
    }

    const total = tasks.length
    const totalLabel = saturated || total !== 1 ? `${countLabel(total)} tasks` : "1 task"
    const totalSemantics = saturated
      ? `lower-bound total; listing capped at ${maxFetchedRows}`
      : "exact total"
    const filterSuffix = args.entity ? ` touching "${args.entity}"` : ""
    const footer = footers.length > 0 ? `\n\n${footers.join("\n")}` : ""
    const pagination = paginationFooter(footerCursor, {
      truncated: footerTruncated,
    })

    return {
      content: [
        {
          type: "text",
          text: `${totalLabel} (${totalSemantics})${filterSuffix}:\n\n${sections.join("\n\n")}${footer}${pagination}`,
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
  args: ReconcileArgs
): Promise<ToolResult> {
  try {
    const { projectId } = await resolveReadProjectScope(services, args.projectName)

    const today = new Date().toISOString().split("T")[0]!
    const { candidates, activeTasksScanned } = await reconcileActiveTasks(services, {
      projectId,
      minScore: args.minScore,
      limit: args.limit,
      today,
    })

    const body = formatReconcileOutput(candidates, activeTasksScanned, today)

    return {
      content: [{ type: "text", text: body }],
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
function createTaskDispatchSchema(tagsSchema: ReturnType<typeof createTagsSchema>) {
  return z.discriminatedUnion("action", [
    z.object({
      action: z.literal("create"),
      subject: nonBlankString,
      description: z.string().optional(),
      entity: z.string().optional(),
      state: z.enum(TASK_STATES).optional(),
      blockedBy: z.string().optional(),
      dueDate: ymdDateSchema.optional(),
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
      scope: scopeInputSchema,
      allowPointerSubject: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("update"),
      taskId: z.string(),
      state: z.enum(TASK_STATES).optional(),
      blockedBy: z.string().optional(),
      entity: z.string().optional(),
      dueDate: clearableYmdDateSchema.optional(),
      subject: z.string().optional(),
      description: z.string().optional(),
      tags: tagsSchema.optional(),
      keywords: keywordsSchema.optional(),
      synopsis: z.string().max(SYNOPSIS_MAX).optional(),
      scope: scopeInputSchema,
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
      dueBefore: ymdDateSchema.optional(),
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
}

export function registerTaskTools(server: McpServer, services: LoreServices): void {
  const tagsSchema = createTagsSchema(services.profile?.taxonomy.tags)
  const taskDispatchSchema = createTaskDispatchSchema(tagsSchema)

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
        'work completes. Closed tasks are the source of truth for "done"; ' +
        "unclosed tasks keep surfacing in wake-up.\n\n" +
        "CRITICAL SCOPE RULE: only file tasks for **tangential or " +
        "out-of-scope** work — side-effect discoveries, deferred follow-ups, " +
        "blocked items the session noticed but did not pick up. Never file " +
        "your current in-flight objective: the conversation and plan already " +
        "track it, so a Lore task adds noise and an immediate close burden, " +
        "not signal.\n\n" +
        "Action-dispatched:\n\n" +
        "- `action: 'create'` — open a new task for tangential or " +
        "out-of-scope work; do NOT file your current objective. Idempotent " +
        "on exact `(subject, entity, projectIds)` match. Use `entity` when " +
        "the task is about a specific subject other facts/decisions " +
        "also reference; `lore-query` action='ask' surfaces it in " +
        "the Tasks bucket.\n" +
        "- `action: 'update'` — change state, blocker, due date, subject, " +
        "description, or scoping. Any field omitted is left untouched. Pass " +
        '`dueDate: null` or `dueDate: ""` to clear the due date.\n' +
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
              "surface candidate closures)."
          ),
        // create
        subject: z
          .string()
          .optional()
          .describe(
            "(action='create') One-line task subject. Becomes the page title. (action='update') New subject."
          ),
        description: z
          .string()
          .optional()
          .describe(
            "(action='create' | 'update') Description / context. Becomes the page body (markdown supported)."
          ),
        // create | update | close
        taskId: z
          .string()
          .optional()
          .describe("(action='update' | 'close') The task ID to mutate."),
        // create | update | list
        entity: z
          .string()
          .optional()
          .describe(
            "(action='create') Normalized entity name the task is about; defaults to subject. " +
              "(action='update') Rename the entity. " +
              "(action='list') Substring filter matched server-side against the Entity column."
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
              "(action='list') Filter to a single state. Omit on list to see all active states (open, in-progress, blocked)."
          ),
        blockedBy: z
          .string()
          .optional()
          .describe(
            "(action='create' | 'update') Free-form blocker label (PR number, person, external service). " +
              "Required when state is `blocked`; pass an empty string on update to clear."
          ),
        dueDate: clearableYmdDateSchema
          .optional()
          .describe(
            "(action='create') Due date (YYYY-MM-DD). Maps to the Review By column. " +
              "(action='update') New due date; pass null or empty string to clear."
          ),
        affectsIds: z
          .array(z.string())
          .optional()
          .describe(
            "(action='create') Memory IDs this task is sourced from / affects. Migrated tasks " +
              "carry their original fact's `sourceMemoryId` here so provenance survives."
          ),
        projectName: z
          .string()
          .optional()
          .describe(
            "(action='create' | 'list' | 'reconcile') Project name. Defaults to auto-detected project from cwd."
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
              "Variants that differ only by case, plural-`s`, `&` vs `and`, or punctuation collapse onto the existing canonical row."
          ),
        forceNewTopic: z
          .boolean()
          .optional()
          .describe(
            "(action='create') Bypass the normalized-equivalent + trigram-similar topic-name probe and create a fresh row."
          ),
        confidence: z
          .enum(CONFIDENCES)
          .optional()
          .describe(
            "(action='create') Confidence in the task's framing (default `certain`)."
          ),
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
              "On update, omit to leave untouched; pass empty string to clear."
          ),
        author: z
          .string()
          .optional()
          .describe(
            "(action='create') Engineer display name. Defaults to LORE_USER_NAME env or `users.me`."
          ),
        agent: z
          .string()
          .optional()
          .describe("(action='create') Name of the AI agent creating this task."),
        session: z
          .string()
          .optional()
          .describe("(action='create') Session ID to group related saves."),
        allowPointerSubject: z
          .boolean()
          .optional()
          .describe(
            "(action='create') Bypass the pointer-only subject guard for false positives."
          ),
        // list
        dueBefore: ymdDateSchema
          .optional()
          .describe(
            "(action='list') Only return tasks with a Review By date on or before this YYYY-MM-DD."
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
              `(default ${DEFAULT_RECONCILE_LIMIT}). Capped at ${MAX_RECONCILE_LIMIT}.`
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
              "mentions never reach the threshold."
          ),
        includeSynopsis: z
          .boolean()
          .optional()
          .describe(
            "(action='list') Render each task's synopsis line (when set) " +
              "as an indented line between the title row and the `ID:` line. " +
              "Defaults true. Pass false to restore byte-identical " +
              "pre-DEFERRED-01 output for callers piping the response into " +
              "another formatter."
          ),
        scope: scopeInputSchema,
      },
    },
    async (args) => {
      const parsed = taskDispatchSchema.safeParse(args)
      if (!parsed.success) {
        return toolError(new Error(formatDispatchError("lore-task", parsed.error)))
      }
      const data = parsed.data
      switch (data.action) {
        case "create":
          return withWakeUpCacheBump(services.wakeupCache, () =>
            handleCreate(services, data)
          )
        case "update":
          return withWakeUpCacheBump(services.wakeupCache, () =>
            handleUpdate(services, data)
          )
        case "close":
          return withWakeUpCacheBump(services.wakeupCache, () =>
            handleClose(services, data)
          )
        case "list":
          return handleList(services, data)
        case "reconcile":
          return handleReconcile(services, data)
      }
    }
  )
}
