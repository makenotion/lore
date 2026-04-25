import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { formatDispatchError, toolError, debugLogPartialFailures } from "../helpers.js"
import { resolveProjectIds } from "../resolve.js"
import { resolveCanonicalDecisionLinks } from "../decision-graph.js"
import { groupFactsByClass, renderFact, resolveReferencedTitles } from "../render.js"

import type { Decision, Fact, FactPredicate, TaskSummary } from "../../types.js"
import { TRACKING_PREDICATES } from "../../types.js"
import { taskDaysOverdue } from "../../core/task.js"

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

/**
 * Default per-bucket cap for `lore-ask`'s grouped display (P2-06).
 * A well-connected entity with 20+ facts compresses down to 15 visible
 * rows at this cap (5 × 3 buckets). Callers can raise via the `limit`
 * param when they really do need the full list.
 */
const DEFAULT_ASK_BUCKET_CAP = 5

/**
 * Advertised value in the overflow hint (`(pass limit to raise the cap;
 * e.g. limit=20)`). Pinned rather than derived so a future bump to
 * `DEFAULT_ASK_BUCKET_CAP` doesn't silently shift the suggestion into a
 * number the user didn't expect. Roughly 4× the default cap — large
 * enough that raising here shows the tail of most hot entities without
 * dumping the whole graph.
 */
const SUGGESTED_OVERFLOW_LIMIT = 20

/**
 * Default per-bucket cap for `lore-open-loops`. The Mail vault has 271 open
 * loops; returning all of them on every ambient call floods the agent
 * context. Ten per bucket matches how humans scan a triage list — enough
 * to see the urgency spread, short enough to act on.
 */
export const DEFAULT_OPEN_LOOPS_LIMIT = 10

/** Days-overdue threshold for the `⚠⚠` marker. */
const OVERDUE_SEVERE_DAYS = 14

/** Days-overdue threshold for the `⚠` marker. */
const OVERDUE_MILD_DAYS = 1

/**
 * Ranking contract for `lore-open-loops`.
 *
 * **Overdue** (`rankOverdue`): sort by days-overdue **descending**.
 * Tiebreakers: `validFrom` desc, then `id` lex asc.
 *
 * **Active** (`rankActive`): sort by `reviewBy` ascending. Null reviewBy
 * sinks to the bottom via explicit-null comparator. Tiebreakers:
 * `validFrom` desc, then `id` lex asc.
 *
 * Markers (`rankOverdue` only): `⚠⚠` at >= `OVERDUE_SEVERE_DAYS`,
 * `⚠` at >= `OVERDUE_MILD_DAYS`, empty below.
 *
 * Pinned by tests in `knowledge.test.ts`. Changes are observable to
 * agents and require a coordinated spec revision.
 */
function rankOverdue(a: Fact, b: Fact, daysOverdue: (f: Fact) => number): number {
  const byDays = daysOverdue(b) - daysOverdue(a)
  if (byDays !== 0) return byDays
  const byValidFrom = (b.validFrom ?? "").localeCompare(a.validFrom ?? "")
  if (byValidFrom !== 0) return byValidFrom
  return a.id.localeCompare(b.id)
}

function rankActive(a: Fact, b: Fact): number {
  if (a.reviewBy === null && b.reviewBy !== null) return 1
  if (a.reviewBy !== null && b.reviewBy === null) return -1
  if (a.reviewBy !== null && b.reviewBy !== null) {
    const byReview = a.reviewBy.localeCompare(b.reviewBy)
    if (byReview !== 0) return byReview
  }
  const byValidFrom = (b.validFrom ?? "").localeCompare(a.validFrom ?? "")
  if (byValidFrom !== 0) return byValidFrom
  return a.id.localeCompare(b.id)
}

/**
 * Predicates accepted on `lore-learn`. The tracking predicates
 * (`needs_action`, `waiting_on`, `blocked_by`) are deliberately absent
 * after P3-02 — those workflows live on `lore-task-create` now. Keeping
 * them in the union but rejecting at the validation layer is what gives
 * us the "type one" -> directive error UX.
 *
 * Decision-graph predicates (`decided_by`, `supersedes_decision`,
 * `informs`) stay internal-only — created by `DecisionService` and
 * never via `lore-learn` regardless of P3-02.
 */
const PREDICATE_VALUES = [
  "is_a",
  "has_a",
  "uses",
  "depends_on",
  "related_to",
  "created_by",
  "owned_by",
  "replaces",
  "extends",
  "conflicts_with",
  "needs_action",
  "waiting_on",
  "blocked_by",
] as const

const CONFIDENCES = ["certain", "likely", "speculative"] as const

const YMD_REGEX = /^\d{4}-\d{2}-\d{2}$/

/**
 * Build the redirect message agents see when they call `lore-learn` with
 * a tracking predicate. The wording tells them the right tool to call,
 * names the closest equivalent task state, and shows the field mapping
 * — `Subject → subject`, `Object → description` — so the agent doesn't
 * have to guess at how to translate.
 */
function trackingPredicateRedirect(predicate: FactPredicate): string {
  const stateHint =
    predicate === "blocked_by"
      ? "blocked"
      : "open"
  const blockerLine =
    predicate === "blocked_by" || predicate === "waiting_on"
      ? "\n  • blockedBy: (the Object you'd have used)"
      : ""
  return (
    `Tracking predicate \`${predicate}\` is no longer accepted by lore-learn. ` +
    `Tracked work lives on tasks now (P3-02): the description goes in the page body, the subject is structurally indexed, ` +
    `and lore-tasks queries by entity / state / due date.\n\n` +
    `Use \`lore-task-create\` instead:\n` +
    `  • subject: (the Subject you'd have used)\n` +
    `  • description: (the Object — full prose, no 2000-char limit)${blockerLine}\n` +
    `  • state: "${stateHint}"\n` +
    `  • entity: (defaults to subject — set explicitly if other facts/tasks reference a different name)\n\n` +
    `Existing tracking facts can be ported in bulk via \`lore migrate --migrate-tracking-to-tasks\`.`
  )
}

/**
 * Return true when the auto-link candidate's project scope is compatible
 * with the fact's. Rules:
 *
 * - Either side empty (vault-wide) → compatible. A vault-wide memory can
 *   support a scoped fact, and a vault-wide fact can accept any scoped
 *   memory as source.
 * - Both sides scoped → require at least one shared project.
 *
 * Anything else is a durable cross-project mis-link risk and must be
 * declined. Mirror of the conservative stance in the backfill heuristic.
 */
function projectsCompatible(factProjectIds: string[], memoryProjectIds: string[]): boolean {
  if (factProjectIds.length === 0 || memoryProjectIds.length === 0) return true
  const memoryScope = new Set(memoryProjectIds)
  return factProjectIds.some((id) => memoryScope.has(id))
}

function renderDecidedByLine(fact: Fact, decision: Decision, today: string): string {
  const review = decision.reviewBy
    ? decision.reviewBy <= today
      ? ` **(DECISION REVIEW OVERDUE — ${decision.reviewBy})**`
      : ` (decision review by ${decision.reviewBy})`
    : ""
  const decided = decision.decidedAt ? ` (decided ${decision.decidedAt})` : ""
  return `- **${fact.subject}** decided by **${decision.title}** [${decision.status}, ${decision.confidence}]${decided}${review}\n  Decision ID: ${decision.id} | Fact ID: ${fact.id}`
}

function renderGenericTrailing(fact: Fact, today: string): string {
  const validity = fact.validFrom ? ` (since ${fact.validFrom})` : ""
  const review = fact.reviewBy
    ? fact.reviewBy <= today
      ? ` **(OVERDUE — review by ${fact.reviewBy})**`
      : ` (review by ${fact.reviewBy})`
    : ""
  return `[${fact.confidence}]${validity}${review}\n  ID: ${fact.id}`
}

function renderTrackingTrailing(fact: Fact, overdueDays: number | null): string {
  const validity = fact.validFrom ? ` (since ${fact.validFrom})` : ""
  if (overdueDays !== null && fact.reviewBy) {
    const marker =
      overdueDays === 0
        ? "due today"
        : `${overdueDays} day${overdueDays === 1 ? "" : "s"} overdue`
    return `[${fact.confidence}]${validity} **(${marker} — review by ${fact.reviewBy})**\n  ID: ${fact.id}`
  }
  const review = fact.reviewBy ? ` (review by ${fact.reviewBy})` : ""
  return `[${fact.confidence}]${validity}${review}\n  ID: ${fact.id}`
}

function daysOverdueOf(reviewBy: string | null, today: string): number | null {
  if (!reviewBy || reviewBy > today) return null
  const diff = new Date(today).getTime() - new Date(reviewBy).getTime()
  return Math.floor(diff / 86_400_000)
}

function compareSortKeyDesc(
  a: { sortKey: string | null },
  b: { sortKey: string | null },
): number {
  if (a.sortKey === b.sortKey) return 0
  if (!a.sortKey) return 1
  if (!b.sortKey) return -1
  return a.sortKey < b.sortKey ? 1 : -1
}

// -------------------------------------------------------------------------
// Handlers — extracted so the polymorphic `lore-fact` and `lore-query`
// tools and the deprecated `lore-learn` / `lore-correct` / `lore-extend` /
// `lore-ask` / `lore-open-loops` / `lore-audit` aliases share single
// implementations.
// -------------------------------------------------------------------------

interface LearnArgs {
  subject: string
  predicate: (typeof PREDICATE_VALUES)[number]
  object: string
  projectName?: string
  projectNames?: string[]
  reviewBy?: string
  confidence?: (typeof CONFIDENCES)[number]
  sourceMemoryId?: string
  session?: string
  agent?: string
}

export async function handleLearn(
  services: LoreServices,
  args: LearnArgs,
): Promise<ToolResult> {
  try {
    // P3-02: tracking predicates are no longer first-class facts. Reject
    // them with a directive error instead of writing the row; the
    // migration command ports any pre-existing tracking facts over to
    // the task model in bulk. The rejection lives in the shared handler
    // so both `lore-fact action='create'` and the `lore-learn` alias
    // refuse identically.
    if ((TRACKING_PREDICATES as FactPredicate[]).includes(args.predicate)) {
      return toolError(new Error(trackingPredicateRedirect(args.predicate)))
    }
    const resolved = await resolveProjectIds(services, args.projectName, args.projectNames)
    const factProjectIds = resolved.ids

    let effectiveSource: string | undefined = args.sourceMemoryId
    let autoLinkedFromSession = false
    const toolWarnings: string[] = [...resolved.warnings]

    if (!effectiveSource) {
      const candidate = services.sessionMemories.get({ agent: args.agent, session: args.session })
      if (candidate) {
        if (projectsCompatible(factProjectIds, candidate.projectIds)) {
          effectiveSource = candidate.memoryId
          autoLinkedFromSession = true
        } else {
          toolWarnings.push(
            `Declined auto-link: session memory ${candidate.memoryId} is scoped to a different project ` +
              `than this fact. Pass sourceMemoryId explicitly to override.`,
          )
        }
      }
    }

    const { fact, deduped, enriched } = await services.facts.createWithDedup({
      subject: args.subject,
      predicate: args.predicate,
      object: args.object,
      projectIds: factProjectIds.length > 0 ? factProjectIds : undefined,
      reviewBy: args.reviewBy,
      confidence: args.confidence,
      sourceMemoryId: effectiveSource,
    })

    const verb = !deduped
      ? "Learned"
      : enriched.length > 0
        ? "Enriched existing fact"
        : "Matched existing fact"
    const lines = [
      `${verb}: "${fact.subject}" ${fact.predicate.replace(/_/g, " ")} "${fact.object}" (${fact.confidence}) — ID: ${fact.id}`,
    ]
    if (fact.reviewBy) {
      lines.push(`Review by: ${fact.reviewBy}`)
    }
    if (effectiveSource && autoLinkedFromSession) {
      lines.push(`Source (auto-linked from session): ${effectiveSource}`)
    } else if (effectiveSource) {
      lines.push(`Source: ${effectiveSource}`)
    } else {
      lines.push(
        "WARNING: No Source memory linked. Facts without a Source can't be retraced by `lore-query` action='ask'. " +
          "Pass `sourceMemoryId` with an existing supporting memory, or pass `agent`+`session` " +
          "matching an earlier `lore-memory`/`lore-decision` save call for auto-link. This becomes a " +
          "hard error in a future release.",
      )
    }
    if (enriched.length > 0) {
      lines.push(`Merged: ${enriched.join("; ")}`)
    }
    if (toolWarnings.length > 0) {
      lines.push(`Warnings: ${toolWarnings.join("; ")}`)
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    }
  } catch (err) {
    return toolError(err)
  }
}

export async function handleInvalidate(
  services: LoreServices,
  args: { factId: string },
): Promise<ToolResult> {
  try {
    await services.facts.invalidate(args.factId)
    return {
      content: [{ type: "text", text: `Invalidated fact ${args.factId}` }],
    }
  } catch (err) {
    return toolError(err)
  }
}

export async function handleExtendFact(
  services: LoreServices,
  args: { factId: string; reviewBy: string },
): Promise<ToolResult> {
  try {
    await services.facts.extendReview(args.factId, args.reviewBy)
    return {
      content: [
        { type: "text", text: `Extended review date for ${args.factId} to ${args.reviewBy}` },
      ],
    }
  } catch (err) {
    return toolError(err)
  }
}

interface AskArgs {
  entity: string
  projectName?: string
  limit?: number
}

export async function handleAsk(
  services: LoreServices,
  args: AskArgs,
  toolName = "lore-ask",
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

    // Fetch facts and tasks in parallel — they're independent queries
    // and `lore-ask` is on the agent hot path. Failures on the tasks side
    // surface as a warning rather than collapsing the call so a transient
    // 5xx on the tasks query does not nuke the facts response.
    const [facts, taskListing] = await Promise.all([
      services.facts.queryByEntity(args.entity, { projectId }),
      services.tasks
        .list({ projectId, entity: args.entity, limit: 50 })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          warnings.push(`Tasks lookup failed: ${message}`)
          return { items: [] as TaskSummary[] }
        }),
    ])
    const tasks = taskListing.items

    const formatWarnings = () =>
      warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""

    if (facts.length === 0 && tasks.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No facts or tasks found about "${args.entity}".${formatWarnings()}`,
          },
        ],
      }
    }

    const today = new Date().toISOString().split("T")[0]
    const cap = args.limit ?? DEFAULT_ASK_BUCKET_CAP
    const { governance, structure, tracking } = groupFactsByClass(facts)

    const decidedByFacts = governance.filter((fact) => fact.predicate === "decided_by")
    const supersedesFacts = governance.filter(
      (fact) => fact.predicate === "supersedes_decision",
    )

    const { links: decisionLinks, failures: decisionFailures } =
      await resolveCanonicalDecisionLinks(services, decidedByFacts, { projectId })

    if (decisionFailures.length > 0) {
      debugLogPartialFailures(toolName, decisionFailures)
      const rootIds = decisionFailures.map(({ rootId }) => rootId).join(", ")
      warnings.push(
        `Could not resolve ${decisionFailures.length} decision root${decisionFailures.length === 1 ? "" : "s"} (${rootIds}) — retry before relying on this result.`,
      )
    }

    const titleMap = await resolveReferencedTitles(
      [...supersedesFacts, ...structure, ...tracking],
      services,
    )

    type Governed = { sortKey: string | null; line: string }
    const governanceItems: Governed[] = [
      ...decisionLinks.map(({ fact, decision }) => ({
        sortKey: fact.validFrom,
        line: renderDecidedByLine(fact, decision, today),
      })),
      ...supersedesFacts.map((fact) => ({
        sortKey: fact.validFrom,
        line: renderFact(fact, {
          titleMap,
          trailing: renderGenericTrailing(fact, today),
        }),
      })),
    ]
    governanceItems.sort(compareSortKeyDesc)

    const structureItems = structure.map((fact) =>
      renderFact(fact, {
        titleMap,
        trailing: renderGenericTrailing(fact, today),
      }),
    )

    type Tracked = { overdueDays: number | null; sortKey: string | null; line: string }
    const trackingItems: Tracked[] = tracking.map((fact) => {
      const overdueDays = daysOverdueOf(fact.reviewBy, today)
      return {
        overdueDays,
        sortKey: fact.validFrom,
        line: renderFact(fact, {
          titleMap,
          prefix: overdueDays !== null ? "⚠ " : undefined,
          trailing: renderTrackingTrailing(fact, overdueDays),
        }),
      }
    })
    const overdueItems = trackingItems
      .filter((item) => item.overdueDays !== null)
      .sort((a, b) => (b.overdueDays ?? 0) - (a.overdueDays ?? 0))
    const activeItems = trackingItems
      .filter((item) => item.overdueDays === null)
      .sort((a, b) => compareSortKeyDesc(a, b))
    const trackingOrdered = [...overdueItems, ...activeItems]

    const sections: string[] = []
    let anyOverflow = false

    if (governanceItems.length > 0) {
      const visible = governanceItems.slice(0, cap)
      const hidden = governanceItems.length - visible.length
      if (hidden > 0) anyOverflow = true
      const hiddenSuffix = hidden > 0 ? ` (${hidden} hidden)` : ""
      sections.push(
        `### Governance (${governanceItems.length})${hiddenSuffix}\n${visible
          .map((item) => item.line)
          .join("\n")}`,
      )
    }

    if (structureItems.length > 0) {
      const visible = structureItems.slice(0, cap)
      const hidden = structureItems.length - visible.length
      if (hidden > 0) anyOverflow = true
      const hiddenSuffix = hidden > 0 ? ` (${hidden} hidden)` : ""
      sections.push(
        `### Structure (${structureItems.length})${hiddenSuffix}\n${visible.join("\n")}`,
      )
    }

    if (trackingOrdered.length > 0) {
      const visible = trackingOrdered.slice(0, cap)
      const hidden = trackingOrdered.length - visible.length
      if (hidden > 0) anyOverflow = true
      const hiddenSuffix = hidden > 0 ? `, ${hidden} hidden` : ""
      sections.push(
        `### Tracking (${overdueItems.length} overdue, ${activeItems.length} active${hiddenSuffix})\n${visible
          .map((item) => item.line)
          .join("\n")}`,
      )
    }

    // Tasks bucket — surfaces tracked work touching the entity. Sourced
    // separately from facts so post-P3-02 vaults (where tracking
    // predicates aren't first-class facts anymore) still get the open
    // loops view at `lore-ask` time.
    type Tasked = { sortKey: string | null; line: string }
    const taskItems: Tasked[] = tasks.map((t) => {
      const overdueDays = taskDaysOverdue(t, today)
      const stateLabel = t.taskState ?? "open"
      const blocker = t.blockedBy ? `, blocked by ${t.blockedBy}` : ""
      const due =
        overdueDays !== null && t.reviewBy
          ? overdueDays === 0
            ? " **(due today)**"
            : ` **(${overdueDays} day${overdueDays === 1 ? "" : "s"} overdue — review by ${t.reviewBy})**`
          : t.reviewBy
            ? ` (due ${t.reviewBy})`
            : ""
      const prefix = overdueDays !== null ? "⚠ " : ""
      return {
        // Tasks have no `validFrom` — the agent-relevant ordering is
        // most-pressing-first. Sort by `Review By` ascending; fall back
        // to `decidedAt` when no due date is set so newer-but-undated
        // tasks order before truly stale ones; null sinks to the bottom.
        sortKey: t.reviewBy ?? t.decidedAt ?? null,
        line: `- ${prefix}**${t.title}** [${stateLabel}${blocker}]${due}\n  Task ID: ${t.id}`,
      }
    })
    taskItems.sort((a, b) => {
      if (a.sortKey === b.sortKey) return 0
      if (!a.sortKey) return 1
      if (!b.sortKey) return -1
      return a.sortKey < b.sortKey ? -1 : 1
    })

    if (taskItems.length > 0) {
      const visible = taskItems.slice(0, cap)
      const hidden = taskItems.length - visible.length
      if (hidden > 0) anyOverflow = true
      const hiddenSuffix = hidden > 0 ? ` (${hidden} hidden)` : ""
      sections.push(
        `### Tasks (${taskItems.length})${hiddenSuffix}\n${visible
          .map((item) => item.line)
          .join("\n")}`,
      )
    }

    if (sections.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No current facts or tasks found about "${args.entity}".${formatWarnings()}`,
          },
        ],
      }
    }

    const totalFacts =
      governanceItems.length +
      structureItems.length +
      trackingOrdered.length +
      taskItems.length
    const overflowHint =
      anyOverflow && args.limit === undefined
        ? `\n\n(pass limit to raise the cap; e.g. limit=${SUGGESTED_OVERFLOW_LIMIT})`
        : ""

    // Header noun: tasks become first-class in the same response, so a
    // vault with only tasks (post-migration, sparse facts) doesn't
    // misreport "0 facts" when the section actually rendered.
    const noun =
      taskItems.length > 0 && facts.length === 0 ? "results" : "facts"
    return {
      content: [
        {
          type: "text",
          text: `${totalFacts} ${noun} about "${args.entity}":\n\n${sections.join("\n\n")}${overflowHint}${formatWarnings()}`,
        },
      ],
    }
  } catch (err) {
    return toolError(err)
  }
}

interface OpenLoopsArgs {
  projectName?: string
  entity?: string
  limit?: number
  all?: boolean
}

export async function handleOpenLoops(
  services: LoreServices,
  args: OpenLoopsArgs,
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

    const perSectionCap = args.all
      ? undefined
      : args.limit !== undefined
        ? args.limit
        : DEFAULT_OPEN_LOOPS_LIMIT

    const { items: loops, hasMore: serviceClipped } = await services.facts.listTracking({
      projectId,
      entity: args.entity,
    })

    if (serviceClipped) {
      warnings.push(
        "Result set was clipped by the service-layer safety cap. Narrow the query with " +
          "`entity` or `projectName` to see the remainder.",
      )
    }

    if (loops.length === 0) {
      const filterHint = args.entity ? ` matching "${args.entity}"` : ""
      const warn = warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""
      return {
        content: [{ type: "text", text: `No open loops found${filterHint}.${warn}` }],
      }
    }

    const today = new Date().toISOString().split("T")[0]
    const todayMs = new Date(today).getTime()

    const daysOverdue = (f: Fact): number => {
      if (!f.reviewBy || f.reviewBy > today) return 0
      return Math.floor((todayMs - new Date(f.reviewBy).getTime()) / 86_400_000)
    }

    const overdueAll = loops
      .filter((f) => f.reviewBy !== null && f.reviewBy <= today)
      .sort((a, b) => rankOverdue(a, b, daysOverdue))

    const activeAll = loops.filter((f) => !f.reviewBy || f.reviewBy > today).sort(rankActive)

    const overdue =
      perSectionCap === undefined ? overdueAll : overdueAll.slice(0, perSectionCap)
    const active = perSectionCap === undefined ? activeAll : activeAll.slice(0, perSectionCap)

    const urgencyMarker = (days: number): string => {
      if (days >= OVERDUE_SEVERE_DAYS) return "⚠⚠ "
      if (days >= OVERDUE_MILD_DAYS) return "⚠ "
      return ""
    }

    const formatOverdue = (f: Fact): string => {
      const days = daysOverdue(f)
      const marker = urgencyMarker(days)
      const daysLabel = days === 1 ? "1 day overdue" : `${days} days overdue`
      const since = f.validFrom ? ` (since ${f.validFrom})` : ""
      return (
        `- ${marker}${daysLabel}: **${f.subject}** → ${f.predicate.replace(/_/g, " ")} ` +
        `→ **${f.object}** [${f.confidence}]${since}\n  ID: ${f.id}`
      )
    }

    const formatActive = (f: Fact): string => {
      const since = f.validFrom ? ` (since ${f.validFrom})` : ""
      const review = f.reviewBy ? ` — review by ${f.reviewBy}` : " — no review date"
      return (
        `- **${f.subject}** → ${f.predicate.replace(/_/g, " ")} → ` +
        `**${f.object}** [${f.confidence}]${since}${review}\n  ID: ${f.id}`
      )
    }

    const buildHeader = (label: string, shown: number, total: number): string => {
      if (perSectionCap === undefined || shown >= total) return `### ${label} (${total})`
      const hidden = total - shown
      return `### ${label} (${shown} shown of ${total}, hiding ${hidden})`
    }

    const sections: string[] = []
    if (overdueAll.length > 0) {
      sections.push(
        `${buildHeader("Overdue", overdue.length, overdueAll.length)}\n\n` +
          overdue.map(formatOverdue).join("\n"),
      )
    }
    if (activeAll.length > 0) {
      sections.push(
        `${buildHeader("Active", active.length, activeAll.length)}\n\n` +
          active.map(formatActive).join("\n"),
      )
    }

    const anyTruncated =
      overdue.length < overdueAll.length || active.length < activeAll.length
    if (anyTruncated) {
      sections.push(
        "Pass `{all: true}` to see everything, `{limit: N}` for a different cap, " +
          "or `{entity: \"...\"}` to narrow further.",
      )
    }

    const total = loops.length
    const filterSuffix = args.entity ? ` touching "${args.entity}"` : ""
    const warn = warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""

    return {
      content: [
        {
          type: "text",
          text: `${total} open loop${total === 1 ? "" : "s"}${filterSuffix}:\n\n${sections.join("\n\n")}${warn}`,
        },
      ],
    }
  } catch (err) {
    return toolError(err)
  }
}

export async function handleAudit(
  services: LoreServices,
  args: { projectName?: string },
): Promise<ToolResult> {
  try {
    let projectId: string | undefined

    if (args.projectName) {
      const found = await services.projects.findByName(args.projectName)
      if (!found) {
        return {
          content: [{ type: "text", text: `Project "${args.projectName}" not found.` }],
        }
      }
      projectId = found.id
    } else if (services.context.project) {
      projectId = services.context.project.id
    }

    const [overdueFacts, overdueDecisions] = await Promise.all([
      services.facts.queryOverdue({ projectId }),
      services.decisions.queryOverdue({ projectId }),
    ])

    if (overdueFacts.length === 0 && overdueDecisions.length === 0) {
      return {
        content: [{ type: "text", text: "No overdue facts or decisions found." }],
      }
    }

    const today = new Date().toISOString().split("T")[0]
    const sections: string[] = []

    if (overdueFacts.length > 0) {
      const factLines = overdueFacts
        .map((f) => {
          const days = Math.floor(
            (new Date(today).getTime() - new Date(f.reviewBy!).getTime()) / 86_400_000,
          )
          const since = f.validFrom ? ` (since ${f.validFrom})` : ""
          return (
            `- **${f.subject}** ${f.predicate.replace(/_/g, " ")} **${f.object}** [${f.confidence}]${since}\n` +
            `  Review by: ${f.reviewBy} (${days} day${days === 1 ? "" : "s"} overdue)\n` +
            `  ID: ${f.id}`
          )
        })
        .join("\n")
      sections.push(`## Overdue Facts (${overdueFacts.length})\n\n${factLines}`)
    }

    if (overdueDecisions.length > 0) {
      const decisionLines = overdueDecisions
        .map((d) => {
          const days = d.reviewBy
            ? Math.floor(
                (new Date(today).getTime() - new Date(d.reviewBy).getTime()) /
                  86_400_000,
              )
            : 0
          const decided = d.decidedAt ? ` | decided ${d.decidedAt}` : ""
          return (
            `- **${d.title}** [${d.status}]${decided}\n` +
            `  Review by: ${d.reviewBy} (${days} day${days === 1 ? "" : "s"} overdue)\n` +
            `  ID: ${d.id}`
          )
        })
        .join("\n")
      sections.push(`## Overdue Decisions (${overdueDecisions.length})\n\n${decisionLines}`)
    }

    const actions = [
      "",
      "Actions:",
      "- **Fact — invalidate**: `lore-fact` with `action: 'invalidate'` if no longer true",
      "- **Fact — extend**: `lore-fact` with `action: 'extend'` and a new review date",
      "- **Decision — mark reviewed**: `lore-decision` with `action: 'review'`",
      "- **Decision — supersede**: `lore-decision` with `action: 'supersede'` and a replacement",
      "- **No change**: leave as-is if still under review",
    ]

    return {
      content: [
        {
          type: "text",
          text: sections.join("\n\n") + "\n" + actions.join("\n"),
        },
      ],
    }
  } catch (err) {
    return toolError(err)
  }
}

const factDispatchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    subject: z.string(),
    predicate: z.enum(PREDICATE_VALUES),
    object: z.string(),
    projectName: z.string().optional(),
    projectNames: z.array(z.string()).optional(),
    reviewBy: z.string().regex(YMD_REGEX).optional(),
    confidence: z.enum(CONFIDENCES).optional(),
    sourceMemoryId: z.string().optional(),
    session: z.string().optional(),
    agent: z.string().optional(),
  }),
  z.object({
    action: z.literal("invalidate"),
    factId: z.string(),
  }),
  z.object({
    action: z.literal("extend"),
    factId: z.string(),
    reviewBy: z.string().regex(YMD_REGEX),
  }),
])

export function registerKnowledgeTools(server: McpServer, services: LoreServices): void {
  // -------------------------------------------------------------------------
  // lore-fact — polymorphic dispatcher (P3-01)
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-fact",
    {
      title: "Knowledge graph fact mutations",
      description:
        "Create, invalidate, or extend the review window of facts in the knowledge graph. Action-dispatched:\n\n" +
        "- `action: 'create'` — add a Subject —predicate→ Object triple. Auto-dedupes against existing equivalent triples and merges metadata onto the survivor.\n" +
        "- `action: 'invalidate'` — mark a fact as no longer true (sets `Valid Until` to today). Preserved for history.\n" +
        "- `action: 'extend'` — push back a fact's review-by date.\n\n" +
        "Every created fact SHOULD link back to a supporting memory via `sourceMemoryId` so `lore-query action='ask'` can retrace the reasoning. Pass the memory ID directly, or pass `agent`+`session` matching an earlier `lore-memory action='save'` / `lore-decision action='create'` call in the same process and `sourceMemoryId` auto-links.\n\n" +
        "Decision predicates (`decided_by`, `supersedes_decision`, `informs`) are internal-only and not accepted here — they are auto-created by the decision tool family.",
      inputSchema: {
        action: z
          .enum(["create", "invalidate", "extend"])
          .describe("Operation: create, invalidate, or extend (push back review date)."),
        // create
        subject: z
          .string()
          .optional()
          .describe("(action='create') The entity this fact is about."),
        predicate: z
          .enum(PREDICATE_VALUES)
          .optional()
          .describe("(action='create') The relationship type."),
        object: z
          .string()
          .optional()
          .describe("(action='create') The related entity or value."),
        projectName: z.string().optional().describe("(action='create') Scope to a project."),
        projectNames: z
          .array(z.string())
          .optional()
          .describe("(action='create') Multiple project names for cross-project facts."),
        confidence: z
          .enum(CONFIDENCES)
          .optional()
          .describe("(action='create') Confidence (default: certain)."),
        sourceMemoryId: z
          .string()
          .optional()
          .describe("(action='create') ID of the memory that supports this fact."),
        session: z
          .string()
          .optional()
          .describe(
            "(action='create') Session ID. With `agent`, used to auto-link `sourceMemoryId`.",
          ),
        agent: z
          .string()
          .optional()
          .describe("(action='create') Agent name. Part of the session composite key."),
        // shared (create | extend)
        reviewBy: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe(
            "(action='create' optional, action='extend' required) Review-by date (YYYY-MM-DD).",
          ),
        // invalidate | extend
        factId: z
          .string()
          .optional()
          .describe(
            "Required for action='invalidate' and action='extend'. The fact's page ID.",
          ),
      },
    },
    async (args) => {
      const parsed = factDispatchSchema.safeParse(args)
      if (!parsed.success) {
        return toolError(
          new Error(formatDispatchError("lore-fact", parsed.error)),
        )
      }
      switch (parsed.data.action) {
        case "create":
          return handleLearn(services, parsed.data)
        case "invalidate":
          return handleInvalidate(services, parsed.data)
        case "extend":
          return handleExtendFact(services, parsed.data)
      }
    },
  )

  // -------------------------------------------------------------------------
  // Deprecated aliases — preserved for the one-release transition window.
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-learn",
    {
      title: "Add a fact",
      description: "Deprecated alias — prefer `lore-fact` with `action: 'create'`.",
      inputSchema: {
        subject: z.string().describe("The entity this fact is about"),
        predicate: z.enum(PREDICATE_VALUES).describe("The relationship type"),
        object: z.string().describe("The related entity or value"),
        projectName: z.string().optional().describe("Scope to a project."),
        projectNames: z
          .array(z.string())
          .optional()
          .describe("Multiple project names for cross-project facts."),
        reviewBy: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("Date (YYYY-MM-DD) by which this fact should be reviewed."),
        confidence: z
          .enum(CONFIDENCES)
          .optional()
          .describe("How confident is this fact (default: certain)"),
        sourceMemoryId: z
          .string()
          .optional()
          .describe("ID of the memory that supports this fact"),
        session: z.string().optional().describe("Session ID for auto-link."),
        agent: z.string().optional().describe("Agent name. Part of the composite session key."),
      },
    },
    async (args) => handleLearn(services, args),
  )

  server.registerTool(
    "lore-correct",
    {
      title: "Invalidate a fact",
      description: "Deprecated alias — prefer `lore-fact` with `action: 'invalidate'`.",
      inputSchema: {
        factId: z.string().describe("The fact ID to invalidate"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ factId }) => handleInvalidate(services, { factId }),
  )

  server.registerTool(
    "lore-extend",
    {
      title: "Extend a fact's review date",
      description: "Deprecated alias — prefer `lore-fact` with `action: 'extend'`.",
      inputSchema: {
        factId: z.string().describe("The fact ID to extend"),
        reviewBy: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .describe("New review-by date (YYYY-MM-DD)"),
      },
    },
    async ({ factId, reviewBy }) => handleExtendFact(services, { factId, reviewBy }),
  )

  server.registerTool(
    "lore-ask",
    {
      title: "Query facts",
      description: "Deprecated alias — prefer `lore-query` with `action: 'ask'`.",
      inputSchema: {
        entity: z
          .string()
          .describe("The entity to query (searched as both subject and object)"),
        projectName: z.string().optional().describe("Scope to a project"),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Per-bucket cap on the number of facts rendered."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => handleAsk(services, args, "lore-ask"),
  )

  server.registerTool(
    "lore-open-loops",
    {
      title: "List open loops",
      description:
        "Deprecated alias — prefer `lore-query` with `action: 'open-loops'`. " +
        "Post-P3-02 tracked work lives on `lore-tasks`.",
      inputSchema: {
        projectName: z.string().optional().describe("Override the auto-detected project."),
        entity: z
          .string()
          .optional()
          .describe("Substring filter matched against Subject OR Object."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max rows per section. Default 10."),
        all: z
          .boolean()
          .optional()
          .describe("Bypass the per-section cap and return every matching loop."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => handleOpenLoops(services, args),
  )

  server.registerTool(
    "lore-audit",
    {
      title: "Audit overdue facts",
      description: "Deprecated alias — prefer `lore-query` with `action: 'audit'`.",
      inputSchema: {
        projectName: z.string().optional().describe("Override the auto-detected project."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => handleAudit(services, args),
  )
}
