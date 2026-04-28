import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { formatDispatchError, toolError, debugLogPartialFailures } from "../helpers.js"
import { resolveProjectIds } from "../resolve.js"
import { resolveCanonicalDecisionLinks } from "../decision-graph.js"
import { groupFactsByClass, renderFact, resolveReferencedTitles } from "../render.js"

import type { Decision, Fact, TaskSummary } from "../../types.js"
import { taskDaysOverdue } from "../../core/task.js"
import { expandEntityQueryVariants } from "../../core/entity.js"

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

/**
 * Default per-bucket cap for `lore-query action='ask'`'s grouped display (P2-06).
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
 * Predicates accepted on `lore-fact action='create'`. Tracked work lives
 * on `lore-task action='create'`; the tracking predicates that the Tasks
 * surface superseded (`needs_action` / `waiting_on` / `blocked_by`) are
 * not part of the `FactPredicate` union and are not accepted here.
 *
 * Decision-graph predicates (`decided_by`, `supersedes_decision`,
 * `informs`) stay internal-only — created by `DecisionService` and
 * never via `lore-fact`.
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
] as const

const CONFIDENCES = ["certain", "likely", "speculative"] as const

const YMD_REGEX = /^\d{4}-\d{2}-\d{2}$/

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
// Handlers — one per fact action. Write-side actions (`create`,
// `invalidate`, `extend`) route via `lore-fact`'s discriminated union;
// read-side actions (`ask`, `audit`) are exported for reuse by `lore-query`.
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
    const resolved = await resolveProjectIds(services, args.projectName, args.projectNames)
    const factProjectIds = resolved.ids

    let effectiveSource: string | undefined = args.sourceMemoryId
    let autoLinkedFromSession = false
    const toolWarnings: string[] = [...resolved.warnings]

    // PF3-01 — resolve subject and object to canonical Entity rows.
    // Auto-creates on miss (default), surfaces ambiguity candidates
    // back to the agent on multi-match. Skip silently when the vault
    // hasn't been migrated yet — `services.entities` is null on
    // legacy vaults and the relation columns are absent, so the
    // create still lands as a pre-PF3-01 row.
    let subjectEntityId: string | undefined
    let objectEntityId: string | undefined
    const ambiguous: Array<{ side: "subject" | "object"; input: string; candidates: string[] }> = []
    if (services.entities) {
      // Per-side `.catch(() => null)` instead of `Promise.all`: a
      // transient Notion 5xx on either resolver must NOT sink the
      // whole `lore-fact action='create'` call. Autosave callers have
      // no human in the loop; the fact is more valuable than the
      // relation. Treat a rejected resolution as "couldn't resolve,
      // omit the relation, surface a warning" — the substring-fallback
      // path in `queryByEntity` still finds the row later.
      //
      // Caught by review on PR #88. Mirrors the resilience posture
      // `lore-query action='ask'`'s tasks lookup (further down in this
      // file) already uses for the same reason.
      const entityServices = services.entities
      const [subjectResolution, objectResolution] = await Promise.all([
        entityServices
          .resolveOrCreateEntity(args.subject, {
            autoCreate: true,
            projectIds: factProjectIds,
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err)
            toolWarnings.push(
              `Subject entity resolution failed: ${message}. Fact written without SubjectEntity relation.`,
            )
            return null
          }),
        entityServices
          .resolveOrCreateEntity(args.object, {
            autoCreate: true,
            projectIds: factProjectIds,
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err)
            toolWarnings.push(
              `Object entity resolution failed: ${message}. Fact written without ObjectEntity relation.`,
            )
            return null
          }),
      ])
      if (subjectResolution?.ambiguous) {
        ambiguous.push({
          side: "subject",
          input: args.subject,
          candidates: subjectResolution.candidates.map((c) => `${c.name} (${c.id})`),
        })
      } else if (subjectResolution?.entity) {
        subjectEntityId = subjectResolution.entity.id
      }
      if (objectResolution?.ambiguous) {
        ambiguous.push({
          side: "object",
          input: args.object,
          candidates: objectResolution.candidates.map((c) => `${c.name} (${c.id})`),
        })
      } else if (objectResolution?.entity) {
        objectEntityId = objectResolution.entity.id
      }
    }

    // On ambiguity, surface candidates as a warning and write the fact
    // with the entity relation OMITTED on the ambiguous side. This
    // protects two contracts that would otherwise conflict:
    //
    // 1. Autosave-driven `lore-fact action='create'` calls have no human
    //    in the loop to disambiguate. Refusing to write would silently
    //    drop the fact from the autosave stream — worse than a
    //    half-canonical fact, which the substring-fallback
    //    `queryByEntity` path can still surface.
    //
    // 2. We must not guess and bind the fact to the wrong canonical
    //    row. Omitting the relation lets the operator (or a future
    //    `lore migrate --build-entities` re-run) attach the right
    //    entity later via `setEntityRelations`.
    //
    // The candidate list goes into `toolWarnings` so the agent sees it
    // alongside other tool diagnostics and can re-issue the call with
    // a more-specific name. Tracked by spec line 30 ("tool surfaces
    // candidates back to the caller; no auto-create") — surfacing
    // does not require refusing.
    if (ambiguous.length > 0) {
      for (const a of ambiguous) {
        toolWarnings.push(
          `Ambiguous ${a.side} "${a.input}" — matched ${a.candidates.length} entities (${a.candidates.join(", ")}). ` +
            `Fact written without ${a.side === "subject" ? "Subject" : "Object"}Entity relation. ` +
            `Re-issue with the canonical name to attach the relation.`,
        )
      }
    }

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
      subjectEntityId,
      objectEntityId,
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
  toolName: string,
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

    // PF3-01 — resolve the entity name to a canonical row first so the
    // fact lookup can ride the relation join. Strict mode (no
    // auto-create): the read path must not mint canonical rows just by
    // looking up an unknown entity. Ambiguity surfaces as a warning;
    // the substring-fallback query still runs underneath so the agent
    // sees something useful even when the user's input maps to two
    // distinct canonical entities (e.g. `User (auth context)` and
    // `User (db schema)`).
    let entityId: string | null = null
    let resolvedEntity: { name: string; aliases: string[] } | null = null
    if (services.entities) {
      const resolution = await services.entities
        .resolveOrCreateEntity(args.entity, { autoCreate: false })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          warnings.push(`Entity lookup failed: ${message}`)
          return null
        })
      if (resolution) {
        if (resolution.ambiguous) {
          const candidateLabels = resolution.candidates
            .map((c) => `"${c.name}" (${c.id})`)
            .join(", ")
          warnings.push(
            `"${args.entity}" matches ${resolution.candidates.length} entities — falling back to substring search. ` +
              `Disambiguate by passing one of: ${candidateLabels}.`,
          )
        } else if (resolution.entity) {
          entityId = resolution.entity.id
          resolvedEntity = {
            name: resolution.entity.name,
            aliases: resolution.entity.aliases,
          }
        }
      }
    }

    // Fact recall already rides the canonical relation when the entity
    // resolves; tasks are still a free-form text column, so mirror the
    // fact side's alias awareness by expanding the resolved entity into
    // a deduped variant set. Legacy / ambiguous / unresolved paths
    // collapse to the raw input and behave like the pre-PF4 substring
    // contract. The cap warning surfaces only when an alias drift
    // would have clipped recall; under the cap the lookup is silent.
    const taskVariants = expandEntityQueryVariants(args.entity, resolvedEntity)
    if (taskVariants.hitCap) {
      const droppedLabel = taskVariants.dropped
        .slice(0, 3)
        .map((d) => `"${d}"`)
        .join(", ")
      const remainder =
        taskVariants.dropped.length > 3
          ? `, +${taskVariants.dropped.length - 3} more`
          : ""
      warnings.push(
        `Task recall capped at ${taskVariants.variants.length} alias variants for "${args.entity}" — ` +
          `dropped ${droppedLabel}${remainder}. Tasks written under the dropped aliases may be missed.`,
      )
    }

    // Fetch facts and tasks in parallel — they're independent queries
    // and `lore-query action='ask'` is on the agent hot path. Failures
    // on the tasks side
    // surface as a warning rather than collapsing the call so a transient
    // 5xx on the tasks query does not nuke the facts response.
    //
    // `expandEntityQueryVariants` returns the raw input as the first
    // variant whenever the input is non-empty, so the fallback to
    // `[args.entity]` only fires for the degenerate empty / whitespace
    // case (preserves the legacy `entity: args.entity` contract there
    // — Notion's substring filter against `""` is a vault-wide match
    // and the call is degenerate either way).
    const taskListEntities =
      taskVariants.variants.length > 0 ? taskVariants.variants : [args.entity]
    const [facts, taskListing] = await Promise.all([
      services.facts.queryByEntity(args.entity, { projectId, entityId }),
      services.tasks
        .list({ projectId, entities: taskListEntities, limit: 50 })
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
    const { governance, structure } = groupFactsByClass(facts)

    const decidedByFacts = governance.filter((fact) => fact.predicate === "decided_by")
    const supersedesFacts = governance.filter(
      (fact) => fact.predicate === "supersedes_decision",
    )

    // Dispatch the canonical-decision-link walk and the title-resolution
    // pass in parallel — they're data-independent (different fact subsets
    // in, disjoint outputs out) and both ride the shared rate-limited
    // Notion client, so concurrency here cuts wall-clock to the slower
    // of the two without raising peak Notion load. Sequential awaits
    // here used to add `T(decisionLinks) + T(titleMap)` to every
    // `lore-query action='ask'` call.
    //
    // Failure-semantics note: `Promise.all` short-circuits on the first
    // rejection, which would lose `debugLogPartialFailures` observability
    // if either callee threw. Neither does under normal Notion error
    // paths — `resolveCanonicalDecisionLinks` surfaces failures through
    // a structured `failures` array via `settleAll`, and
    // `MemoryService.getTitleById` swallows fetch errors and returns
    // `null` (see `src/core/memory.ts`'s `fetchTitleAndCache`). If a
    // future change makes either callee throw, swap to
    // `Promise.allSettled` here so the failures bucket is still drained.
    const [
      { links: decisionLinks, failures: decisionFailures },
      titleMap,
    ] = await Promise.all([
      resolveCanonicalDecisionLinks(services, decidedByFacts, { projectId }),
      resolveReferencedTitles([...supersedesFacts, ...structure], services),
    ])

    if (decisionFailures.length > 0) {
      debugLogPartialFailures(toolName, decisionFailures)
      const rootIds = decisionFailures.map(({ rootId }) => rootId).join(", ")
      warnings.push(
        `Could not resolve ${decisionFailures.length} decision root${decisionFailures.length === 1 ? "" : "s"} (${rootIds}) — retry before relying on this result.`,
      )
    }

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

    // Tasks bucket — surfaces tracked work touching the entity. The
    // pre-#23 open-loops view was a fact partition; tasks are the
    // canonical surface now and this section is what
    // `lore-query action='ask'` callers see in its place.
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
}
