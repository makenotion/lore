import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import {
  formatDispatchError,
  paginationFooter,
  toolError,
  debugLogTouchFailure,
  debugLogFactTouchFailure,
  withWakeUpCacheBump,
} from "../helpers.js"
import { debugLogPartialFailures } from "../../observability/partial-failure.js"
import { resolveProjectIds, resolveReadProjectScope } from "../resolve.js"
import { renderTrustLine } from "../render.js"
import { clearableYmdDateSchema } from "./date-schema.js"
import { nonBlankString } from "./text-schema.js"
import { scopeInputSchema } from "./scope-schema.js"
import { isTransientNotionError } from "../../notion/errors.js"
import type { CostOutputCounts } from "../../core/cost-ledger.js"

import {
  DEFAULT_WRITABLE_FACT_PREDICATES,
  GENERIC_FACT_PREDICATES,
  type TaskSummary,
} from "../../types.js"
import { taskDaysOverdue } from "../../core/task.js"
import { runAsk } from "../../core/ask.js"
import { effectiveConfidenceScore } from "../../core/decay.js"
import { FACT_PROPS } from "../../notion/schema.js"
import { writableFactPredicates } from "../../profile/index.js"

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
  noopWrite?: boolean
  costOutputs?: CostOutputCounts
}

/**
 * Predicates accepted on `lore-fact action='create'`. Tracked work lives
 * on `lore-task action='create'`; the tracking predicates that the Tasks
 * surface superseded (`needs_action` / `waiting_on` / `blocked_by`) are
 * not part of the `FactPredicate` union and are not accepted here.
 *
 * Decision-graph predicates (`decided_by`, `supersedes_decision`,
 * `informs`) stay internal-only — created by `DecisionService` and
 * never via `lore-fact`.
 *
 * `mentions` is also internal-only — auto-emitted by
 * `lore-memory action='save'`. Agents that want to assert a richer
 * relationship (`uses`, `depends_on`, etc.) call `lore-fact
 * action='create'` directly; the auto-emitted `mentions` shape is the
 * lowest-quality fallback and is intentionally not addressable as an
 * agent-curated value.
 */
const CONFIDENCES = ["certain", "likely", "speculative"] as const

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
function projectsCompatible(
  factProjectIds: string[],
  memoryProjectIds: string[]
): boolean {
  if (factProjectIds.length === 0 || memoryProjectIds.length === 0) return true
  const memoryScope = new Set(memoryProjectIds)
  return factProjectIds.some((id) => memoryScope.has(id))
}

/**
 * LORE_DEBUG parser contract: one rejected provenance precheck emits one
 * newline-delimited `[lore] fact-precheck-rejected:` event.
 */
function debugLogFactPrecheckRejected(
  reason:
    | "provenance-unresolved"
    | "provenance-cross-project"
    | "provenance-source-unresolved"
    | "provenance-source-cross-project",
  args: Pick<LearnArgs, "agent" | "session" | "sourceMemoryId">,
  factProjectIds: string[]
): void {
  if (process.env["LORE_DEBUG"] !== "1") return
  const clean = (value: string | undefined): string =>
    Array.from(value ?? "<unset>", (char) => {
      const code = char.charCodeAt(0)
      return code <= 31 || code === 127 ? " " : char
    }).join("")
  const projectScope =
    factProjectIds.length > 0 ? factProjectIds.join(",") : "<vault-wide>"
  process.stderr.write(
    `[lore] fact-precheck-rejected: reason=${reason} ` +
      `agent=${clean(args.agent)} session=${clean(args.session)} ` +
      `sourceMemoryId=${clean(args.sourceMemoryId)} project=${projectScope}\n`
  )
}

// -------------------------------------------------------------------------
// Handlers — one per fact action. Write-side actions (`create`,
// `invalidate`, `extend`) route via `lore-fact`'s discriminated union;
// read-side actions (`ask`, `audit`) are exported for reuse by `lore-query`.
// -------------------------------------------------------------------------

interface LearnArgs {
  subject: string
  predicate: string
  object: string
  projectName?: string
  projectNames?: string[]
  reviewBy?: string | null
  confidence?: (typeof CONFIDENCES)[number]
  sourceMemoryId?: string
  session?: string
  agent?: string
  scope?: import("../../types.js").MemoryScopeInput
}

export async function handleLearn(
  services: LoreServices,
  args: LearnArgs
): Promise<ToolResult> {
  try {
    const resolved = await resolveProjectIds(
      services,
      args.projectName,
      args.projectNames
    )
    const factProjectIds = resolved.ids

    // Dispatcher schema already rejects blank sources; keep this for direct handler callers.
    let effectiveSource: string | undefined = args.sourceMemoryId?.trim() || undefined
    let autoLinkedFromSession = false
    const toolWarnings: string[] = [...resolved.warnings]

    if (effectiveSource) {
      let sourceProjectIds: string[]
      try {
        const sourceMemory = await services.memories.getPropertiesById(effectiveSource)
        sourceProjectIds = sourceMemory.projectIds
      } catch {
        debugLogFactPrecheckRejected("provenance-source-unresolved", args, factProjectIds)
        return toolError(
          new Error(
            `provenance-source-unresolved: sourceMemoryId ${effectiveSource} did not resolve to a live Memories row. ` +
              `Pass an existing supporting memory ID, or pass agent+session for session auto-link.`
          )
        )
      }
      if (!projectsCompatible(factProjectIds, sourceProjectIds)) {
        debugLogFactPrecheckRejected(
          "provenance-source-cross-project",
          args,
          factProjectIds
        )
        return toolError(
          new Error(
            `provenance-source-cross-project: sourceMemoryId ${effectiveSource} is scoped to a different project than this fact. ` +
              `Use a source memory from the same project, or a vault-wide source memory.`
          )
        )
      }
    } else {
      const candidate = services.sessionMemories.get({
        agent: args.agent,
        session: args.session,
      })
      if (candidate) {
        if (projectsCompatible(factProjectIds, candidate.projectIds)) {
          effectiveSource = candidate.memoryId
          autoLinkedFromSession = true
        } else {
          debugLogFactPrecheckRejected("provenance-cross-project", args, factProjectIds)
          return toolError(
            new Error(
              `provenance-cross-project: lore-fact create requires a compatible source memory. ` +
                `Session memory ${candidate.memoryId} is scoped to a different project than this fact. ` +
                `Pass sourceMemoryId explicitly to override the session candidate.`
            )
          )
        }
      }
    }

    if (!effectiveSource) {
      debugLogFactPrecheckRejected("provenance-unresolved", args, factProjectIds)
      return toolError(
        new Error(
          "provenance-unresolved: agent+session did not resolve to a compatible session memory. " +
            "Pass sourceMemoryId with an existing supporting memory, or save a memory/decision " +
            "under the same agent+session before creating the fact."
        )
      )
    }

    // PF3-01 — resolve subject and object to canonical Entity rows.
    // Auto-creates on miss (default), surfaces ambiguity candidates
    // back to the agent on multi-match.
    let subjectEntityId: string | undefined
    let objectEntityId: string | undefined
    const ambiguous: Array<{
      side: "subject" | "object"
      input: string
      candidates: string[]
    }> = []
    // Per-side `.catch(() => null)` instead of `Promise.all`: a
    // transient Notion 5xx on either resolver must NOT sink the
    // whole `lore-fact action='create'` call. Autosave callers have
    // no human in the loop; the fact is more valuable than the
    // relation. Treat a rejected resolution as "couldn't resolve,
    // omit the relation, surface a warning" — the substring-fallback
    // path in `queryByEntity` still finds the row later.
    //
    // Mirrors the resilience posture `lore-query action='ask'`'s tasks
    // lookup (further down in this file) already uses for the same
    // reason.
    const [subjectResolution, objectResolution] = await Promise.all([
      services.entities
        .resolveOrCreateEntity(args.subject, {
          autoCreate: true,
          projectIds: factProjectIds,
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          toolWarnings.push(
            `Subject entity resolution failed: ${message}. Fact written without SubjectEntity relation.`
          )
          return null
        }),
      services.entities
        .resolveOrCreateEntity(args.object, {
          autoCreate: true,
          projectIds: factProjectIds,
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          toolWarnings.push(
            `Object entity resolution failed: ${message}. Fact written without ObjectEntity relation.`
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
            `Fact written without ${a.side === "subject" ? FACT_PROPS.SUBJECT_ENTITY : FACT_PROPS.OBJECT_ENTITY} relation. ` +
            `Re-issue with the canonical name to attach the relation.`
        )
      }
    }

    const { fact, deduped, enriched } = await services.facts.createWithDedup({
      subject: args.subject,
      predicate: args.predicate,
      object: args.object,
      projectIds: factProjectIds.length > 0 ? factProjectIds : undefined,
      reviewBy: args.reviewBy ?? undefined,
      confidence: args.confidence,
      sourceMemoryId: effectiveSource,
      subjectEntityId,
      objectEntityId,
      // Scope / lifetime.
      scope: args.scope,
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
    if (autoLinkedFromSession) {
      lines.push(`Source (auto-linked from session): ${effectiveSource}`)
    } else {
      lines.push(`Source: ${effectiveSource}`)
    }
    if (enriched.length > 0) {
      lines.push(`Merged: ${enriched.join("; ")}`)
    }
    if (toolWarnings.length > 0) {
      lines.push(`Warnings: ${toolWarnings.join("; ")}`)
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      costOutputs: !deduped
        ? { factsCreated: 1 }
        : enriched.length > 0
          ? { factsUpdated: 1 }
          : undefined,
    }
  } catch (err) {
    return toolError(err)
  }
}

export async function handleInvalidate(
  services: LoreServices,
  args: { factId: string; sourceMemoryId?: string }
): Promise<ToolResult> {
  try {
    // Read first so we capture `sourceMemoryId` before the invalidate write:
    // `pageToFact`'s historical-tracking-predicate filter races against
    // `Valid Until` updates if the read happens after invalidation. This
    // metadata read is advisory; the invalidate write remains the boundary
    // that proves a missing or inaccessible row.
    let fact: Awaited<ReturnType<typeof services.facts.getById>> = null
    let factReadFailed = false
    try {
      fact = await services.facts.getById(args.factId)
    } catch {
      factReadFailed = true
    }
    const warnings: string[] = []
    let invalidationSourceMemoryId: string | undefined
    // When the caller threads `sourceMemoryId`, that becomes
    // the `Invalidated By` relation: the memory that prompted the
    // invalidation. Distinct from the fact's existing `Source` link
    // (`fact.sourceMemoryId`), which names the *supporting* memory at
    // creation time. Both axes can coexist on one row.
    //
    // Precheck matches `handleLearn`'s provenance contract: the
    // invalidating memory must resolve to a live (non-archived)
    // Memories row, and its project scope must be compatible with
    // the fact's. Without this gate the relation accepts any
    // same-workspace id the token can see — including archived
    // memories and memories scoped to an unrelated project — which
    // pollutes the audit trail the `Invalidated By` column exists to
    // provide. Omit the second argument entirely when no provenance
    // is threaded so the single-arg call site stays byte-stable.
    if (args.sourceMemoryId && !factReadFailed) {
      let invalidatingProjectIds: string[]
      try {
        const invalidatingMemory = await services.memories.getPropertiesById(
          args.sourceMemoryId
        )
        invalidatingProjectIds = invalidatingMemory.projectIds
      } catch (err) {
        // R5 nit fix: distinguish "memory truly missing/inaccessible"
        // (the user-facing `invalidation-source-unresolved` failure
        // class — surfaced to the agent so it can pick a different
        // sourceMemoryId or drop the argument) from transient
        // 429 / 5xx / network errors (the operator-facing failure
        // class — surfaced to the outer `toolError` with the raw
        // Notion error so the agent sees the transient and can
        // retry). The bare-catch shape earlier collapsed every
        // failure into the unresolved error, degrading the
        // operator's mental model during rate-limit blips.
        if (isTransientNotionError(err)) {
          throw err
        }
        return toolError(
          new Error(
            `invalidation-source-unresolved: sourceMemoryId ${args.sourceMemoryId} did not resolve to a live Memories row. ` +
              `Pass an existing memory ID for the invalidation provenance, or omit sourceMemoryId to skip the audit link.`
          )
        )
      }
      // Compatibility is one-sided here: the fact may have no projectIds
      // (vault-wide), in which case any source memory is compatible.
      // Otherwise the source must share at least one project, or be
      // vault-wide itself. Mirrors `handleLearn`'s projectsCompatible
      // shape so the audit-link policy and the create-time provenance
      // policy stay aligned.
      const factProjectIds = fact?.projectIds ?? []
      if (!projectsCompatible(factProjectIds, invalidatingProjectIds)) {
        return toolError(
          new Error(
            `invalidation-source-cross-project: sourceMemoryId ${args.sourceMemoryId} is scoped to a different project than this fact. ` +
              `Use a memory from the same project, or a vault-wide memory.`
          )
        )
      }
      invalidationSourceMemoryId = args.sourceMemoryId
    }

    const invalidateResult = invalidationSourceMemoryId
      ? await services.facts.invalidate(args.factId, {
          sourceMemoryId: invalidationSourceMemoryId,
        })
      : await services.facts.invalidate(args.factId)

    const status = invalidateResult?.status ?? "invalidated"
    if (status === "skipped-archived") {
      return {
        content: [
          {
            type: "text",
            text: `Skipped fact ${args.factId}: row is archived`,
          },
        ],
        noopWrite: true,
      }
    }

    if (factReadFailed) {
      warnings.push(
        args.sourceMemoryId
          ? "Fact metadata read failed before invalidation; sourceMemoryId audit link was skipped."
          : "Fact metadata read failed before invalidation."
      )
    }

    const lines = [`Invalidated fact ${args.factId}`]
    if (warnings.length > 0) {
      lines.push(`Warnings: ${warnings.join("; ")}`)
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      costOutputs: { factsUpdated: 1 },
    }
  } catch (err) {
    return toolError(err)
  }
}

export async function handleExtendFact(
  services: LoreServices,
  args: { factId: string; reviewBy: string | null }
): Promise<ToolResult> {
  try {
    await services.facts.extendReview(args.factId, args.reviewBy)
    if (args.reviewBy === null) {
      return {
        content: [{ type: "text", text: `Cleared review date for ${args.factId}` }],
        costOutputs: { factsUpdated: 1 },
      }
    }
    return {
      content: [
        {
          type: "text",
          text: `Extended review date for ${args.factId} to ${args.reviewBy}`,
        },
      ],
      costOutputs: { factsUpdated: 1 },
    }
  } catch (err) {
    return toolError(err)
  }
}

interface AskArgs {
  entity: string
  projectName?: string
  limit?: number
  includeContext?: boolean
  /**
   * Transaction-time recall cutoff. YYYY-MM-DD form. Returns
   * the slice of facts Lore knew about by this date and had not yet
   * invalidated by this date.
   */
  asOf?: string
  /**
   * Include invalidated facts in the result. Default false
   * — only live facts surface. Useful for tracing how knowledge about an
   * entity changed over time.
   */
  includeHistory?: boolean
}

export async function handleAsk(
  services: LoreServices,
  args: AskArgs,
  toolName: string
): Promise<ToolResult> {
  try {
    const result = await runAsk(services, args, {
      onDecisionFailures: (failures) => debugLogPartialFailures(toolName, failures),
      onMemoryTouchError: (id, error) => debugLogTouchFailure(toolName, id, error),
      onFactTouchError: (id, error) => debugLogFactTouchFailure(toolName, id, error),
    })
    return { content: [{ type: "text", text: result.text }] }
  } catch (err) {
    return toolError(err)
  }
}

export async function handleAudit(
  services: LoreServices,
  args: { projectName?: string }
): Promise<ToolResult> {
  try {
    const { projectId } = await resolveReadProjectScope(services, args.projectName)

    const warnings: string[] = []
    const overdueDecisionQuery =
      typeof services.decisions.queryOverdueWindow === "function"
        ? services.decisions.queryOverdueWindow({ projectId })
        : services.decisions
            .queryOverdue({ projectId })
            .then((items) => ({ items, capped: false }))
    const overdueTaskQuery =
      typeof services.tasks.queryOverdueWindow === "function"
        ? services.tasks.queryOverdueWindow({ projectId })
        : services.tasks
            .queryOverdue({ projectId })
            .then((items) => ({ items, capped: false }))

    let taskLookupFailed = false
    const [overdueFacts, overdueDecisionWindow, overdueTaskWindow] = await Promise.all([
      services.facts.queryOverdue({ projectId }),
      overdueDecisionQuery,
      overdueTaskQuery.catch((err) => {
        taskLookupFailed = true
        const message = err instanceof Error ? err.message : String(err)
        warnings.push(`Tasks lookup failed: ${message}`)
        return { items: [] as TaskSummary[], capped: false }
      }),
    ])
    const overdueDecisions = overdueDecisionWindow.items
    const overdueTasks = overdueTaskWindow.items
    if (overdueDecisionWindow.capped) {
      warnings.push(
        "Overdue decision scan reached the live-row refill cap; more overdue decisions may exist."
      )
    }
    if (overdueTaskWindow.capped) {
      warnings.push(
        "Overdue task scan reached the live-row refill cap; more overdue tasks may exist."
      )
    }
    const cappedFooter = paginationFooter(undefined, {
      truncated: overdueDecisionWindow.capped || overdueTaskWindow.capped,
    })

    const formatWarnings = () =>
      warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""

    if (
      overdueFacts.length === 0 &&
      overdueDecisions.length === 0 &&
      overdueTasks.length === 0
    ) {
      const text = taskLookupFailed
        ? "No overdue facts or decisions found. Overdue tasks could not be checked."
        : "No overdue facts, decisions, or tasks found."
      return {
        content: [
          {
            type: "text",
            text: text + formatWarnings() + cappedFooter,
          },
        ],
      }
    }

    const today = new Date().toISOString().split("T")[0]
    const sections: string[] = []

    if (overdueFacts.length > 0) {
      const factLines = overdueFacts
        .map((f) => {
          const days = Math.floor(
            (new Date(today).getTime() - new Date(f.reviewBy!).getTime()) / 86_400_000
          )
          const since = f.validFrom ? ` (since ${f.validFrom})` : ""
          const trustLine = renderTrustLine(
            effectiveConfidenceScore(
              f.confidenceScore ?? null,
              f.lastReferencedAt ?? null,
              today
            ),
            "  "
          )
          const trustRow = trustLine !== null ? `${trustLine}\n` : ""
          return (
            `- **${f.subject}** ${f.predicate.replace(/_/g, " ")} **${f.object}** [${f.confidence}]${since}\n` +
            trustRow +
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
                (new Date(today).getTime() - new Date(d.reviewBy).getTime()) / 86_400_000
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
      sections.push(
        `## Overdue Decisions (${overdueDecisions.length})\n\n${decisionLines}`
      )
    }

    if (overdueTasks.length > 0) {
      // Audit is the comprehensive overdue-review surface. Wake-up keeps its
      // smaller triage view via `tasks.list` and buckets overdue/stale/active.
      const taskRows = overdueTasks.flatMap((t) => {
        const days = taskDaysOverdue(t, today)
        if (days === null) {
          warnings.push(`Task ${t.id}: failed to compute overdue days, skipping`)
          return []
        }
        const stateLabel = t.taskState ?? "open"
        const blocked = t.blockedBy ? `, blocked by ${t.blockedBy}` : ""
        const entity = t.entity ? ` | entity ${t.entity}` : ""
        return [
          `- **${t.title}** [${stateLabel}${blocked}]${entity}\n` +
            `  Review by: ${t.reviewBy} (${days} day${days === 1 ? "" : "s"} overdue)\n` +
            `  ID: ${t.id}`,
        ]
      })
      if (taskRows.length > 0) {
        sections.push(`## Overdue Tasks (${taskRows.length})\n\n${taskRows.join("\n")}`)
      }
    }

    if (sections.length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              "No overdue facts or decisions found. Overdue tasks could not be rendered." +
              formatWarnings(),
          },
        ],
      }
    }

    const actions = [
      "",
      "Actions:",
      "- **Fact — invalidate**: `lore-fact` with `action: 'invalidate'` if no longer true",
      "- **Fact — extend**: `lore-fact` with `action: 'extend'` and a new review date",
      "- **Decision — mark reviewed**: `lore-decision` with `action: 'review'`",
      "- **Decision — supersede**: `lore-decision` with `action: 'supersede'` and a replacement",
      "- **Task — close**: `lore-task` with `action: 'close'` and `state: 'done'` if completed",
      "- **Task — update due date**: `lore-task` with `action: 'update'` and `dueDate`",
      "- **Task — unblock**: `lore-task` with `action: 'update'`, a non-blocked `state`, and `blockedBy: ''`",
      "- **Task — cancel**: `lore-task` with `action: 'close'` and `state: 'cancelled'` if abandoned",
      "- **No change**: leave as-is if still under review",
    ]

    return {
      content: [
        {
          type: "text",
          text:
            sections.join("\n\n") +
            "\n" +
            actions.join("\n") +
            formatWarnings() +
            cappedFooter,
        },
      ],
    }
  } catch (err) {
    return toolError(err)
  }
}

function createPredicateSchema(values: readonly string[]) {
  const accepted = new Set(values)
  const acceptedList = values.join(" | ")
  return z.string().superRefine((value, ctx) => {
    if (accepted.has(value)) return
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `predicate must be one of ${acceptedList}, got "${value}"`,
    })
  })
}

function createFactDispatchSchema(
  predicateSchema: ReturnType<typeof createPredicateSchema>
) {
  return z
    .discriminatedUnion("action", [
      z.object({
        action: z.literal("create"),
        // Reject empty / whitespace-only subject and object at the
        // boundary; write-path symmetric with the read-path guard. An empty
        // / whitespace-only triple would land in `createWithDedup`,
        // hash through `normalize("")` into `DedupKey`, and persist a
        // structurally degenerate fact row that confuses downstream
        // consumers: `queryBySubject` won't surface it, `repointEntity`
        // sees an empty key, and the dedup probe collides every empty-
        // subject fact onto one slot. Shared `nonBlankString` matches
        // the `.trim().min(1)` posture used by `lore-query action='ask'`'s
        // `entity` schema.
        subject: nonBlankString,
        predicate: predicateSchema,
        object: nonBlankString,
        projectName: z.string().optional(),
        projectNames: z.array(z.string()).optional(),
        reviewBy: clearableYmdDateSchema.optional(),
        confidence: z.enum(CONFIDENCES).optional(),
        sourceMemoryId: z.string().optional(),
        session: z.string().optional(),
        agent: z.string().optional(),
        scope: scopeInputSchema,
      }),
      z.object({
        action: z.literal("invalidate"),
        factId: z.string(),
        // Optional invalidation provenance. The memory id
        // recorded on the fact's `Invalidated By` relation, distinct from
        // `Source` (creation-time provenance). Optional because operators
        // sometimes invalidate without a memory to point at (e.g. an
        // ad-hoc cleanup pass).
        sourceMemoryId: z.string().optional(),
      }),
      z.object({
        action: z.literal("extend"),
        factId: z.string(),
        reviewBy: clearableYmdDateSchema,
      }),
    ])
    .superRefine((args, ctx) => {
      if (args.action !== "create") return
      const sourceMemoryId = args.sourceMemoryId?.trim()
      if (sourceMemoryId) return
      const agent = args.agent?.trim()
      const session = args.session?.trim()
      if (agent && session) return
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceMemoryId"],
        message:
          "provenance-missing: pass a non-empty sourceMemoryId, or pass both non-empty " +
          "agent and session so Lore can auto-link a compatible session memory.",
      })
    })
}

export function registerKnowledgeTools(server: McpServer, services: LoreServices): void {
  const predicateSchema = createPredicateSchema(
    services.profile
      ? writableFactPredicates(services.profile)
      : [...GENERIC_FACT_PREDICATES, ...DEFAULT_WRITABLE_FACT_PREDICATES]
  )
  const factDispatchSchema = createFactDispatchSchema(predicateSchema)

  // -------------------------------------------------------------------------
  // lore-fact — polymorphic dispatcher
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-fact",
    {
      title: "Knowledge graph fact mutations",
      description:
        "Create/invalidate facts; set or clear fact review dates. Action-dispatched:\n\n" +
        "- `action: 'create'` — add a Subject —predicate→ Object triple. Auto-dedupes against existing equivalent triples and merges metadata onto the survivor.\n" +
        "- `action: 'invalidate'` — mark a fact as no longer true (sets `Valid Until` and `Invalidated At` to today). Preserved for history. Pass `sourceMemoryId` to record which memory prompted the invalidation in the `Invalidated By` relation.\n" +
        "- `action: 'extend'` — set or clear a fact's review-by date.\n\n" +
        "Every created fact MUST link back to a supporting memory via `sourceMemoryId` so `lore-query action='ask'` can retrace the reasoning. Pass a live Memories row ID directly, or pass `agent`+`session` matching an earlier `lore-memory action='save'` / `lore-decision action='create'` call in the same process and `sourceMemoryId` auto-links. If neither path produces a compatible Source memory, the create call is rejected before writing.\n\n" +
        "Decision predicates (`decided_by`, `supersedes_decision`, `informs`) and the auto-emitted `mentions` predicate are internal-only and not accepted here — `decided_by` / `supersedes_decision` / `informs` are auto-created by the decision tool family; `mentions` is auto-emitted by `lore-memory action='save'`. Use richer relationship predicates (`uses`, `depends_on`, etc.) for agent-curated edges.",
      inputSchema: {
        action: z
          .enum(["create", "invalidate", "extend"])
          .describe("Operation: create, invalidate, or extend (set/clear review date)."),
        // create
        subject: z
          .string()
          .optional()
          .describe("(action='create') The entity this fact is about."),
        predicate: z
          .string()
          .pipe(predicateSchema)
          .optional()
          .describe("(action='create') The relationship type."),
        object: z
          .string()
          .optional()
          .describe("(action='create') The related entity or value."),
        projectName: z
          .string()
          .optional()
          .describe("(action='create') Scope to a project."),
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
          .describe(
            "(action='create') ID of the memory that supports this fact. Required unless agent+session auto-links a compatible source memory. " +
              "(action='invalidate') Optional ID of the memory that prompted the invalidation; recorded in the fact's `Invalidated By` relation."
          ),
        session: z
          .string()
          .optional()
          .describe(
            "(action='create') Session ID. With `agent`, used to auto-link `sourceMemoryId`."
          ),
        agent: z
          .string()
          .optional()
          .describe("(action='create') Agent name. Part of the session composite key."),
        // shared (create | extend)
        reviewBy: clearableYmdDateSchema
          .optional()
          .describe(
            "(action='create' optional, action='extend' required) Review-by date (YYYY-MM-DD). On create, null or empty string means no initial review date; on extend, null or empty string clears."
          ),
        // invalidate | extend
        factId: z
          .string()
          .optional()
          .describe(
            "Required for action='invalidate' and action='extend'. The fact's page ID."
          ),
        scope: scopeInputSchema,
      },
    },
    async (args) => {
      const parsed = factDispatchSchema.safeParse(args)
      if (!parsed.success) {
        return toolError(new Error(formatDispatchError("lore-fact", parsed.error)))
      }
      const data = parsed.data
      switch (data.action) {
        case "create":
          return withWakeUpCacheBump(services.wakeupCache, () =>
            handleLearn(services, data)
          )
        case "invalidate":
          return withWakeUpCacheBump(services.wakeupCache, () =>
            handleInvalidate(services, data)
          )
        case "extend":
          return withWakeUpCacheBump(services.wakeupCache, () =>
            handleExtendFact(services, data)
          )
      }
    }
  )
}
