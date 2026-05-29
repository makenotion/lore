import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import {
  formatDispatchError,
  paginationFooter,
  toolError,
  withWakeUpCacheBump,
} from "../helpers.js"
import { debugLogPartialFailures } from "../../observability/partial-failure.js"
import { resolveProjectIds, resolveReadProjectScope } from "../resolve.js"
import {
  resolveCanonicalDecisionLinks,
  syncDecisionReachability,
} from "../decision-graph.js"
import { displayId, resolveTitles, truncateSynopsis } from "../render.js"
import {
  ACTIVE_DECISION_STATUSES,
  SYNOPSIS_MAX,
  memoryScopeToInput,
} from "../../types.js"
import type { Decision, DecisionSummary, DecisionStatus } from "../../types.js"
import { createTagsSchema, keywordsSchema } from "./tag-schema.js"
import { scopeInputSchema } from "./scope-schema.js"
import { clearableYmdDateSchema, ymdDateSchema } from "./date-schema.js"
import { nonBlankBody, nonBlankString } from "./text-schema.js"
import {
  RICH_TEXT_PROPERTY_MAX_LEN,
  richTextPropertySchema,
} from "../../core/rich-text-schema.js"
import { findNearDuplicates, type NearDuplicateMatch } from "../../core/near-duplicate.js"
import { resolveAuthorForWrite } from "../../auth/identity.js"
import { LoreError, errorCauseMessage } from "../../errors.js"
import { resolveFeatureFlags } from "../../feature-flags.js"
import type { CostOutputCounts } from "../../core/cost-ledger.js"

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
  costOutputs?: CostOutputCounts
}

interface SupersedeRef {
  id: string
  title?: string
}

/**
 * Trigram threshold for the `lore-decision action='create'` near-duplicate probe. Lower
 * than the memory threshold because decisions carry more ceremony and
 * redundant decisions are more costly than redundant notes.
 */
const DECISION_NEAR_DUPLICATE_THRESHOLD = 0.6

/** Cap the decision probe candidate pool. */
const DECISION_POOL_LIMIT = 50

/** Max candidates to surface in the response. */
const DECISION_SURFACE_LIMIT = 3

const DECISION_FACT_CONFIDENCE = "likely" as const

class DecisionCreateFactPartialFailureError extends LoreError<"decision-create-fact-partial"> {
  readonly decisionId: string
  readonly failedAffect: string
  readonly createdAffects: string[]
  readonly pendingAffects: string[]
  readonly pendingSupersedes: string[]
  readonly factWriteError: unknown

  constructor(details: {
    decision: Decision
    failedAffect: string
    createdAffects: string[]
    pendingAffects: string[]
    pendingSupersedes: string[]
    factWriteError: unknown
  }) {
    const cause =
      details.factWriteError instanceof Error
        ? details.factWriteError.message
        : String(details.factWriteError)
    const createdPart =
      details.createdAffects.length > 0
        ? `Created \`decided_by\` facts before failure: ${details.createdAffects.join(", ")}. `
        : "No `decided_by` facts were created before the failure. "
    const pendingPart =
      details.pendingAffects.length > 0
        ? `Missing \`decided_by\` facts: ${details.pendingAffects.join(", ")}. `
        : ""
    const supersedesPart =
      details.pendingSupersedes.length > 0
        ? `Pending supersessions not attempted: ${details.pendingSupersedes.join(", ")}. `
        : ""
    super(
      "decision-create-fact-partial",
      `Decision create partial failure: decision "${details.decision.title}" ` +
        `(${details.decision.id}) was saved, but the \`decided_by\` fact ` +
        `for "${details.failedAffect}" failed: ${cause}. ` +
        createdPart +
        pendingPart +
        supersedesPart +
        "Create the missing facts for the saved decision; do not recreate the decision.",
      {
        decisionId: details.decision.id,
        failedAffect: details.failedAffect,
        createdAffects: details.createdAffects,
        pendingAffects: details.pendingAffects,
        pendingSupersedes: details.pendingSupersedes,
        factWriteCauseMessage: errorCauseMessage(details.factWriteError),
      },
      { cause: details.factWriteError }
    )
    this.name = "DecisionCreateFactPartialFailureError"
    this.decisionId = details.decision.id
    this.failedAffect = details.failedAffect
    this.createdAffects = details.createdAffects
    this.pendingAffects = details.pendingAffects
    this.pendingSupersedes = details.pendingSupersedes
    this.factWriteError = details.factWriteError
  }
}

class DecisionCreateSupersedePartialFailureError extends LoreError<"decision-create-supersede-partial"> {
  readonly decisionId: string
  readonly failedSupersede: string
  readonly completedSupersedes: string[]
  readonly markedSupersedes: string[]
  readonly createdSupersedeFacts: string[]
  readonly pendingSupersedes: string[]
  readonly missingSupersedeFacts: string[]
  readonly missingReachabilityUpdates: string[]
  readonly supersedeError: unknown

  constructor(details: {
    decision: Decision
    failedSupersede: SupersedeRef
    stage: string
    completedSupersedes: SupersedeRef[]
    markedSupersedes: SupersedeRef[]
    createdSupersedeFacts: SupersedeRef[]
    pendingSupersedes: SupersedeRef[]
    missingSupersedeFacts: SupersedeRef[]
    missingReachabilityUpdates: SupersedeRef[]
    supersedeError: unknown
  }) {
    const cause =
      details.supersedeError instanceof Error
        ? details.supersedeError.message
        : String(details.supersedeError)
    const completedIds = new Set(details.completedSupersedes.map((ref) => ref.id))
    const partiallyMarked = details.markedSupersedes.filter(
      (ref) => !completedIds.has(ref.id)
    )
    super(
      "decision-create-supersede-partial",
      `Decision create partial failure: decision "${details.decision.title}" ` +
        `(${details.decision.id}) was saved, but supersession for ` +
        `${formatSupersedeRef(details.failedSupersede)} failed during ` +
        `${details.stage}: ${cause}. ` +
        formatSupersedeRefs(
          "Completed supersessions before failure",
          details.completedSupersedes,
          "No supersessions completed before the failure"
        ) +
        formatSupersedeRefs(
          "Marked superseded before failure but still missing graph repair",
          partiallyMarked
        ) +
        formatSupersedeRefs(
          "Created `supersedes_decision` facts before failure",
          details.createdSupersedeFacts,
          "No `supersedes_decision` facts were created before the failure"
        ) +
        formatSupersedeRefs(
          "Missing `supersedes_decision` facts",
          details.missingSupersedeFacts
        ) +
        formatSupersedeRefs(
          "Missing decision-context reachability updates",
          details.missingReachabilityUpdates
        ) +
        formatSupersedeRefs(
          "Pending supersessions not attempted",
          details.pendingSupersedes
        ) +
        "Repair the missing supersession work for the saved decision; do not recreate the decision.",
      {
        decisionId: details.decision.id,
        failedSupersede: details.failedSupersede.id,
        completedSupersedes: details.completedSupersedes.map((ref) => ref.id),
        markedSupersedes: details.markedSupersedes.map((ref) => ref.id),
        createdSupersedeFacts: details.createdSupersedeFacts.map((ref) => ref.id),
        pendingSupersedes: details.pendingSupersedes.map((ref) => ref.id),
        missingSupersedeFacts: details.missingSupersedeFacts.map((ref) => ref.id),
        missingReachabilityUpdates: details.missingReachabilityUpdates.map(
          (ref) => ref.id
        ),
        supersedeCauseMessage: errorCauseMessage(details.supersedeError),
      },
      { cause: details.supersedeError }
    )
    this.name = "DecisionCreateSupersedePartialFailureError"
    this.decisionId = details.decision.id
    this.failedSupersede = details.failedSupersede.id
    this.completedSupersedes = details.completedSupersedes.map((ref) => ref.id)
    this.markedSupersedes = details.markedSupersedes.map((ref) => ref.id)
    this.createdSupersedeFacts = details.createdSupersedeFacts.map((ref) => ref.id)
    this.pendingSupersedes = details.pendingSupersedes.map((ref) => ref.id)
    this.missingSupersedeFacts = details.missingSupersedeFacts.map((ref) => ref.id)
    this.missingReachabilityUpdates = details.missingReachabilityUpdates.map(
      (ref) => ref.id
    )
    this.supersedeError = details.supersedeError
  }
}

function formatSupersedeRef(ref: SupersedeRef): string {
  return ref.title ? `"${ref.title}" (${ref.id})` : ref.id
}

function formatSupersedeRefs(
  label: string,
  refs: SupersedeRef[],
  empty?: string
): string {
  if (refs.length === 0) return empty ? `${empty}. ` : ""
  return `${label}: ${refs.map(formatSupersedeRef).join(", ")}. `
}

function formatNearDuplicateDecisions(
  matches: NearDuplicateMatch[],
  newDecisionId: string
): string[] {
  const lines: string[] = []
  const shown = matches.slice(0, DECISION_SURFACE_LIMIT)
  lines.push(
    `Warning: ${matches.length} existing ${matches.length === 1 ? "decision looks" : "decisions look"} similar. If this supersedes any of them, use \`lore-decision\` with \`action: 'supersede'\`:`
  )
  for (const m of shown) {
    const sim = m.titleSimilarity.toFixed(2)
    const when = m.decidedAt ? ` from ${m.decidedAt}` : ""
    lines.push(`  - "${m.title}" (${m.id})${when} — trigram ${sim}, status ${m.status}`)
    lines.push(
      `    lore-decision({ action: "supersede", newDecisionId: "${newDecisionId}", oldDecisionId: "${m.id}" })`
    )
  }
  if (matches.length > shown.length) {
    lines.push(`  - …and ${matches.length - shown.length} more`)
  }
  return lines
}

const DECISION_STATUSES = [
  "proposed",
  "accepted",
  "superseded",
  "deprecated",
  "rejected",
] as const

function todayISO(): string {
  return new Date().toISOString().split("T")[0]
}

function addDaysISO(base: Date, days: number): string {
  const next = new Date(base)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().split("T")[0]
}

function formatIdLine(id: string, titleMap: Map<string, string>): string {
  const title = titleMap.get(id.toLowerCase())
  return title ? `${title} (${id})` : displayId(id, titleMap)
}

function formatSummary(d: DecisionSummary): string {
  const status = `[${d.status}]`
  const decided = d.decidedAt ? ` | decided ${d.decidedAt}` : ""
  const today = todayISO()
  const reviewPart = d.reviewBy
    ? d.reviewBy <= today
      ? ` | review by ${d.reviewBy} **(OVERDUE)**`
      : ` | review by ${d.reviewBy}`
    : ""
  return `**${status}${decided}${reviewPart} | ID: ${d.id}**`
}

// -------------------------------------------------------------------------
// Handlers — extracted so the polymorphic `lore-decision` tool and the
// deprecated single-purpose aliases share single implementations.
// -------------------------------------------------------------------------

interface CreateArgs {
  decision: string
  rationale: string
  projectName?: string
  projectNames?: string[]
  topicName?: string
  forceNewTopic?: boolean
  status?: (typeof DECISION_STATUSES)[number]
  reviewBy?: string
  decidedAt?: string
  supersedesIds?: string[]
  affects?: string[]
  alternatives?: string
  consequences?: string
  tags?: string[]
  keywords?: string
  synopsis?: string
  author?: string
  agent?: string
  session?: string
  scope?: import("../../types.js").MemoryScopeInput
}

async function handleCreate(
  services: LoreServices,
  args: CreateArgs
): Promise<ToolResult> {
  try {
    const features = services.features ?? resolveFeatureFlags()
    const authorPromise = resolveAuthorForWrite(args.author, services.identity)
    const resolved = await resolveProjectIds(
      services,
      args.projectName,
      args.projectNames
    )

    let topicId: string | undefined
    let topicLabel = "none"
    if (args.topicName && resolved.ids.length > 0) {
      const topic = await services.topics.getOrCreate(args.topicName, resolved.ids, {
        forceNew: args.forceNewTopic,
      })
      topicId = topic.id
      // Use the canonical's stored name when normalized-equivalent
      // collapse landed on an existing row.
      topicLabel = topic.name
    } else if (args.topicName) {
      resolved.warnings.push(
        `Topic "${args.topicName}" skipped (requires at least one project)`
      )
    }

    const probeProjectId = resolved.ids[0]
    const probePromise = probeProjectId
      ? findNearDuplicates(services.memories, {
          title: args.decision,
          tags: args.tags ?? [],
          projectId: probeProjectId,
          topicId,
          kind: "decision",
          statuses: ACTIVE_DECISION_STATUSES,
          threshold: DECISION_NEAR_DUPLICATE_THRESHOLD,
          limit: DECISION_POOL_LIMIT,
          features,
          onError: (err) =>
            debugLogPartialFailures("lore-decision", [
              { rootId: "near-duplicate-probe", error: err },
            ]),
        })
      : Promise.resolve([] as NearDuplicateMatch[])

    const resolvedAuthor = await authorPromise

    const [created, nearDuplicates] = await Promise.all([
      services.decisions.create({
        decision: args.decision,
        rationale: args.rationale,
        projectIds: resolved.ids.length > 0 ? resolved.ids : undefined,
        topicId,
        status: (args.status ?? "accepted") as DecisionStatus,
        reviewBy: args.reviewBy,
        decidedAt: args.decidedAt,
        alternatives: args.alternatives,
        consequences: args.consequences,
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
      }),
      probePromise,
    ])

    const duplicateMatches = nearDuplicates.filter((m) => m.id !== created.id)

    services.sessionMemories.record(
      { agent: args.agent, session: args.session },
      { memoryId: created.id, projectIds: created.projectIds }
    )

    const supersedesIds = args.supersedesIds ?? []
    const supersedeRefs = new Map<string, SupersedeRef>()
    const supersedeRef = (id: string): SupersedeRef => supersedeRefs.get(id) ?? { id }
    const supersedeRefsFor = (ids: string[]): SupersedeRef[] =>
      ids.map((id) => supersedeRef(id))

    const affectsCreated: string[] = []
    const affectsWarnings: string[] = []
    const affects = args.affects ?? []
    for (const [index, entity] of affects.entries()) {
      // PF3-01 — resolve each `affects` entry through EntityService so
      // the auto-created `decided_by` fact carries a canonical
      // `SubjectEntity` relation. Strict per-entry try/catch matches
      // the lore-fact resilience posture: a transient resolver blip
      // must NOT sink the whole decision-create. On rejection we
      // create the fact without the relation and surface a warning.
      let subjectEntityId: string | undefined
      try {
        const resolution = await services.entities.resolveOrCreateEntity(entity, {
          autoCreate: true,
          projectIds: created.projectIds,
        })
        if (resolution.ambiguous) {
          const labels = resolution.candidates
            .map((c) => `${c.name} (${c.id})`)
            .join(", ")
          affectsWarnings.push(
            `Ambiguous \`affects\` entry "${entity}" — matched ${resolution.candidates.length} entities (${labels}). Decided_by fact written without SubjectEntity.`
          )
        } else if (resolution.entity) {
          subjectEntityId = resolution.entity.id
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        affectsWarnings.push(
          `Entity resolution failed for \`affects\` entry "${entity}": ${message}. Decided_by fact written without SubjectEntity.`
        )
      }

      try {
        await services.facts.create({
          subject: entity,
          predicate: "decided_by",
          object: created.id,
          projectIds: created.projectIds.length > 0 ? created.projectIds : undefined,
          sourceMemoryId: created.id,
          confidence: DECISION_FACT_CONFIDENCE,
          subjectEntityId,
          // System-managed `decided_by` facts must inherit the
          // decision's scope so a session-scoped
          // decision does not leak the affected entity through
          // `lore-decision action='context'` or `lore-query
          // action='ask'` for readers outside that session. The
          // converted scope passes through `createWithDedup`'s
          // scope-aware merge contract, so a same-(entity, decision)
          // fact under a different scope produces a separate row
          // rather than absorbing.
          scope: memoryScopeToInput(created.scope),
        })
      } catch (factWriteError) {
        throw new DecisionCreateFactPartialFailureError({
          decision: created,
          failedAffect: entity,
          createdAffects: [...affectsCreated],
          pendingAffects: affects.slice(index),
          pendingSupersedes: supersedesIds,
          factWriteError,
        })
      }
      affectsCreated.push(entity)
    }

    const supersededEntries: Array<{ id: string; title: string }> = []
    const markedSupersedes: SupersedeRef[] = []
    const createdSupersedeFacts: SupersedeRef[] = []
    const reachabilityUpdates: string[] = []
    for (const [index, oldId] of supersedesIds.entries()) {
      let oldDecision: Decision
      try {
        oldDecision = await services.decisions.getById(oldId)
      } catch (supersedeError) {
        throw new DecisionCreateSupersedePartialFailureError({
          decision: created,
          failedSupersede: supersedeRef(oldId),
          stage: "decision lookup",
          completedSupersedes: [...supersededEntries],
          markedSupersedes: [...markedSupersedes],
          createdSupersedeFacts: [...createdSupersedeFacts],
          pendingSupersedes: supersedeRefsFor(supersedesIds.slice(index)),
          missingSupersedeFacts: supersedeRefsFor(supersedesIds.slice(index)),
          missingReachabilityUpdates: supersedeRefsFor(supersedesIds.slice(index)),
          supersedeError,
        })
      }

      const oldRef = { id: oldId, title: oldDecision.title }
      supersedeRefs.set(oldId, oldRef)

      try {
        await services.decisions.supersede(created.id, oldId)
      } catch (supersedeError) {
        throw new DecisionCreateSupersedePartialFailureError({
          decision: created,
          failedSupersede: oldRef,
          stage: "supersede update",
          completedSupersedes: [...supersededEntries],
          markedSupersedes: [...markedSupersedes],
          createdSupersedeFacts: [...createdSupersedeFacts],
          pendingSupersedes: supersedeRefsFor(supersedesIds.slice(index)),
          missingSupersedeFacts: supersedeRefsFor(supersedesIds.slice(index)),
          missingReachabilityUpdates: supersedeRefsFor(supersedesIds.slice(index)),
          supersedeError,
        })
      }
      markedSupersedes.push(oldRef)

      try {
        await services.facts.create({
          subject: created.id,
          predicate: "supersedes_decision",
          object: oldId,
          projectIds: created.projectIds.length > 0 ? created.projectIds : undefined,
          sourceMemoryId: created.id,
          confidence: DECISION_FACT_CONFIDENCE,
          // `supersedes_decision` facts inherit the new decision's
          // scope; the new decision is the
          // governing identity slot, so its scope determines who
          // can see the supersession edge.
          scope: memoryScopeToInput(created.scope),
        })
      } catch (supersedeError) {
        throw new DecisionCreateSupersedePartialFailureError({
          decision: created,
          failedSupersede: oldRef,
          stage: "`supersedes_decision` fact write",
          completedSupersedes: [...supersededEntries],
          markedSupersedes: [...markedSupersedes],
          createdSupersedeFacts: [...createdSupersedeFacts],
          pendingSupersedes: supersedeRefsFor(supersedesIds.slice(index + 1)),
          missingSupersedeFacts: supersedeRefsFor(supersedesIds.slice(index)),
          missingReachabilityUpdates: supersedeRefsFor(supersedesIds.slice(index)),
          supersedeError,
        })
      }
      createdSupersedeFacts.push(oldRef)

      let reachability: Awaited<ReturnType<typeof syncDecisionReachability>>
      try {
        reachability = await syncDecisionReachability(services, oldId, created)
      } catch (supersedeError) {
        throw new DecisionCreateSupersedePartialFailureError({
          decision: created,
          failedSupersede: oldRef,
          stage: "decision-context reachability sync",
          completedSupersedes: [...supersededEntries],
          markedSupersedes: [...markedSupersedes],
          createdSupersedeFacts: [...createdSupersedeFacts],
          pendingSupersedes: supersedeRefsFor(supersedesIds.slice(index + 1)),
          missingSupersedeFacts: supersedeRefsFor(supersedesIds.slice(index + 1)),
          missingReachabilityUpdates: supersedeRefsFor(supersedesIds.slice(index)),
          supersedeError,
        })
      }
      supersededEntries.push({ id: oldId, title: oldDecision.title })
      if (reachability.invalidated > 0) {
        reachabilityUpdates.push(
          `Updated decision context for ${reachability.invalidated} affected ${reachability.invalidated === 1 ? "entity" : "entities"} superseded by "${oldDecision.title}"`
        )
      }
    }
    const projectLabel = args.projectNames?.length
      ? args.projectNames.join(", ")
      : (args.projectName ?? services.context.project?.name ?? "none (vault-wide)")

    const lines: string[] = [
      `Saved decision: "${created.title}" (${created.id})`,
      `Status: ${created.status} | Decided at: ${created.decidedAt ?? "today"}${created.reviewBy ? ` | Review by: ${created.reviewBy}` : ""}`,
      `Project: ${projectLabel} | Topic: ${topicLabel}`,
    ]
    if (created.alternatives) lines.push(`Alternatives: ${created.alternatives}`)
    if (created.consequences) lines.push(`Consequences: ${created.consequences}`)

    if (affectsCreated.length > 0) {
      lines.push("", "Auto-created `decided_by` facts:")
      for (const e of affectsCreated) lines.push(`  - ${e} → "${created.title}"`)
    }
    if (supersededEntries.length > 0) {
      lines.push("", "Superseded:")
      for (const { id, title } of supersededEntries) {
        lines.push(`  - ${id} → "${title}" (marked superseded)`)
      }
    }
    if (reachabilityUpdates.length > 0) {
      lines.push("", "Graph updates:")
      for (const update of reachabilityUpdates) lines.push(`  - ${update}`)
    }
    const supersededIdSet = new Set(args.supersedesIds ?? [])
    const decisionMatches = duplicateMatches.filter((m) => !supersededIdSet.has(m.id))
    if (decisionMatches.length > 0) {
      lines.push("", ...formatNearDuplicateDecisions(decisionMatches, created.id))
    }
    const allWarnings = [...resolved.warnings, ...affectsWarnings]
    if (allWarnings.length > 0) {
      lines.push("", `Warnings: ${allWarnings.join("; ")}`)
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      costOutputs: {
        decisionsCreated: 1,
        ...(affectsCreated.length > 0 ? { factsCreated: affectsCreated.length } : {}),
      },
    }
  } catch (err) {
    return toolError(err)
  }
}

interface ListArgs {
  projectName?: string
  status?: (typeof DECISION_STATUSES)[number]
  reviewBefore?: string
  limit?: number
  startCursor?: string
  includeSynopsis?: boolean
}

async function handleList(services: LoreServices, args: ListArgs): Promise<ToolResult> {
  try {
    const { projectId } = await resolveReadProjectScope(services, args.projectName)

    const {
      items: decisions,
      nextCursor,
      capped,
    } = await services.decisions.list({
      projectId,
      status: args.status as DecisionStatus | undefined,
      reviewBefore: args.reviewBefore,
      limit: args.limit ?? 20,
      startCursor: args.startCursor,
    })

    if (decisions.length === 0) {
      const header = nextCursor
        ? "No matching decisions on this page."
        : "No decisions found."
      return {
        content: [
          {
            type: "text",
            text: `${header}${paginationFooter(nextCursor, { truncated: capped })}`,
          },
        ],
      }
    }

    const includeSynopsis = args.includeSynopsis !== false
    const lines = [
      `Found ${decisions.length} decision${decisions.length === 1 ? "" : "s"}:\n`,
    ]
    for (const d of decisions) {
      lines.push(`### ${d.title}`)
      if (includeSynopsis && d.synopsis.trim()) {
        lines.push(truncateSynopsis(d.synopsis))
      }
      lines.push(formatSummary(d))
      if (d.alternatives) lines.push(`Alternatives: ${d.alternatives}`)
      if (d.consequences) lines.push(`Consequences: ${d.consequences}`)
      lines.push("")
    }

    return {
      content: [
        {
          type: "text",
          text: `${lines.join("\n")}${paginationFooter(nextCursor, { truncated: capped })}`,
        },
      ],
      costOutputs: { decisionsReturned: decisions.length },
    }
  } catch (err) {
    return toolError(err)
  }
}

async function handleGet(
  services: LoreServices,
  args: { decisionId: string }
): Promise<ToolResult> {
  try {
    const decision = await services.decisions.getById(args.decisionId)
    const lines = [
      `# ${decision.title}`,
      "",
      `**Status:** ${decision.status}  `,
      `**Decided:** ${decision.decidedAt ?? "unknown"}  `,
      decision.reviewBy ? `**Review by:** ${decision.reviewBy}  ` : null,
      `**ID:** ${decision.id}`,
    ].filter((l): l is string => l !== null)

    if (decision.alternatives) {
      lines.push("", "## Alternatives considered", decision.alternatives)
    }
    if (decision.consequences) {
      lines.push("", "## Consequences", decision.consequences)
    }
    const relationTitles = await resolveTitles(
      [...decision.supersedesIds, ...decision.affectsIds],
      (id) => services.memories.getTitleById(id)
    )
    if (decision.supersedesIds.length > 0) {
      lines.push("", "## Supersedes")
      for (const id of decision.supersedesIds) {
        lines.push(`- ${formatIdLine(id, relationTitles)}`)
      }
    }
    if (decision.affectsIds.length > 0) {
      lines.push("", "## Affects (cross-linked memories)")
      for (const id of decision.affectsIds) {
        lines.push(`- ${formatIdLine(id, relationTitles)}`)
      }
    }
    if (decision.content) {
      lines.push("", "---", "", "## Rationale", "", decision.content)
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      costOutputs: { decisionsReturned: 1 },
    }
  } catch (err) {
    return toolError(err)
  }
}

interface ContextArgs {
  entity: string
  projectName?: string
  limit?: number
}

async function handleContext(
  services: LoreServices,
  args: ContextArgs,
  toolName: string
): Promise<ToolResult> {
  try {
    const warnings: string[] = []
    const formatWarnings = () =>
      warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""

    const { projectId } = await resolveReadProjectScope(services, args.projectName)

    // PF3-01 — resolve the entity name to a canonical row first so the
    // fact lookup can ride the relation join. This brings
    // `lore-decision action='context'` to parity with `lore-query action='ask'`
    // both surfaces should agree on which decisions govern a given
    // canonical entity, regardless of whether the caller typed the name
    // or an alias. Strict mode (no auto-create): the read path must not
    // mint canonical rows just by looking up an unknown entity.
    // Ambiguity surfaces as a warning; the substring-fallback inside
    // `queryByEntity` still runs underneath so the agent sees something
    // useful even when the input maps to two distinct canonical entities.
    let entityId: string | null = null
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
            `Disambiguate by passing one of: ${candidateLabels}.`
        )
      } else if (resolution.entity) {
        entityId = resolution.entity.id
      }
    }

    const facts = await services.facts.queryByEntity(args.entity, {
      projectId,
      entityId: entityId ?? undefined,
      predicates: ["decided_by"],
    })

    if (facts.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No decisions found governing "${args.entity}".${formatWarnings()}`,
          },
        ],
      }
    }

    const { links, failures: linkFailures } = await resolveCanonicalDecisionLinks(
      services,
      facts,
      { projectId }
    )
    if (linkFailures.length > 0) {
      debugLogPartialFailures(toolName, linkFailures)
      const rootIds = linkFailures.map(({ rootId }) => rootId).join(", ")
      warnings.push(
        `Could not resolve ${linkFailures.length} decision root${linkFailures.length === 1 ? "" : "s"} (${rootIds}) — retry before relying on this result.`
      )
    }
    const decisions = Array.from(
      new Map(links.map(({ decision }) => [decision.id, decision])).values()
    )

    if (decisions.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No active decisions found governing "${args.entity}".${formatWarnings()}`,
          },
        ],
      }
    }

    decisions.sort((a, b) =>
      (b.decidedAt ?? b.updatedAt).localeCompare(a.decidedAt ?? a.updatedAt)
    )

    const cap = args.limit ?? 10
    const shown = decisions.slice(0, cap)

    const lines: string[] = [
      `${shown.length} active decision${shown.length === 1 ? "" : "s"} governing "${args.entity}"` +
        (decisions.length > shown.length
          ? ` (showing ${shown.length} of ${decisions.length})`
          : "") +
        ":\n",
    ]

    for (const d of shown) {
      lines.push(`### ${d.title}`)
      lines.push(
        `**[${d.status}]${d.decidedAt ? ` | decided ${d.decidedAt}` : ""} | ID: ${d.id}**`
      )
      if (d.alternatives) lines.push(`Alternatives: ${d.alternatives}`)
      if (d.consequences) lines.push(`Consequences: ${d.consequences}`)
      lines.push("")
    }

    const historicalRoots = new Set(
      facts
        .map((fact) => fact.sourceMemoryId ?? fact.object)
        .filter((value): value is string => value !== null && value.length > 0)
    )
    const resolvedOnward = historicalRoots.size - decisions.length - linkFailures.length
    if (resolvedOnward > 0) {
      lines.push(
        `_${resolvedOnward} superseded decision link${resolvedOnward === 1 ? "" : "s"} resolved forward to current replacements._`
      )
    }

    return {
      content: [{ type: "text", text: lines.join("\n") + formatWarnings() }],
      costOutputs: { decisionsReturned: shown.length },
    }
  } catch (err) {
    return toolError(err)
  }
}

async function handleSupersede(
  services: LoreServices,
  args: { newDecisionId: string; oldDecisionId: string }
): Promise<ToolResult> {
  try {
    // Both decision reads are non-advisory by design; the response text
    // and the `supersedes_decision` fact write both need resolved
    // titles and project ids. A read failure here is a real error and propagates to
    // `toolError`. `lore-fact action='invalidate'` wraps its source-memory
    // read in the contradiction-failure path because the response there
    // is `Invalidated fact <id>` — independent of the source — so the
    // asymmetry is deliberate.
    const [newDecision, oldDecision] = await Promise.all([
      services.decisions.getById(args.newDecisionId),
      services.decisions.getById(args.oldDecisionId),
    ])

    await services.decisions.supersede(args.newDecisionId, args.oldDecisionId)

    await services.facts.create({
      subject: newDecision.id,
      predicate: "supersedes_decision",
      object: oldDecision.id,
      projectIds: newDecision.projectIds.length > 0 ? newDecision.projectIds : undefined,
      sourceMemoryId: newDecision.id,
      confidence: DECISION_FACT_CONFIDENCE,
      // Same posture as the create-time `supersedes_decision` write:
      // the new decision's scope determines visibility of the
      // supersession edge.
      scope: memoryScopeToInput(newDecision.scope),
    })
    const reachability = await syncDecisionReachability(
      services,
      args.oldDecisionId,
      newDecision
    )

    return {
      content: [
        {
          type: "text",
          text:
            `Superseded "${oldDecision.title}" (${args.oldDecisionId}) with "${newDecision.title}" (${args.newDecisionId}).\n` +
            `Auto-created fact: ${args.newDecisionId} → supersedes_decision → ${args.oldDecisionId}\n` +
            `Updated decision context for ${reachability.invalidated} affected ${reachability.invalidated === 1 ? "entity" : "entities"}.`,
        },
      ],
      costOutputs: { decisionsUpdated: 1, factsCreated: 1 },
    }
  } catch (err) {
    return toolError(err)
  }
}

async function handleReview(
  services: LoreServices,
  args: { decisionId: string; reviewBy?: string | null }
): Promise<ToolResult> {
  try {
    const newDate =
      args.reviewBy === undefined ? addDaysISO(new Date(), 90) : args.reviewBy
    await services.decisions.reviewCompleted(args.decisionId, newDate)
    if (newDate === null) {
      return {
        content: [
          {
            type: "text",
            text: `Cleared review date for decision ${args.decisionId}.`,
          },
        ],
        costOutputs: { decisionsUpdated: 1 },
      }
    }
    return {
      content: [
        {
          type: "text",
          text: `Marked decision ${args.decisionId} as reviewed. New review date: ${newDate}`,
        },
      ],
      costOutputs: { decisionsUpdated: 1 },
    }
  } catch (err) {
    return toolError(err)
  }
}

function createDecisionDispatchSchema(tagsSchema: ReturnType<typeof createTagsSchema>) {
  return z.discriminatedUnion("action", [
    z.object({
      action: z.literal("create"),
      decision: nonBlankString,
      // `rationale` is the markdown page body; nonBlankBody validates
      // without transforming so authored whitespace (indented code,
      // intentional leading newlines) round-trips verbatim into Notion.
      rationale: nonBlankBody,
      projectName: z.string().optional(),
      projectNames: z.array(z.string()).optional(),
      topicName: z.string().optional(),
      forceNewTopic: z.boolean().optional(),
      status: z.enum(DECISION_STATUSES).optional(),
      reviewBy: ymdDateSchema.optional(),
      decidedAt: ymdDateSchema.optional(),
      supersedesIds: z.array(z.string()).optional(),
      affects: z.array(z.string()).optional(),
      alternatives: richTextPropertySchema("alternatives").optional(),
      consequences: richTextPropertySchema("consequences").optional(),
      tags: tagsSchema.optional(),
      keywords: keywordsSchema.optional(),
      synopsis: z.string().max(SYNOPSIS_MAX).optional(),
      author: z.string().optional(),
      agent: z.string().optional(),
      session: z.string().optional(),
      scope: scopeInputSchema,
    }),
    z.object({
      action: z.literal("list"),
      projectName: z.string().optional(),
      status: z.enum(DECISION_STATUSES).optional(),
      reviewBefore: ymdDateSchema.optional(),
      limit: z.number().int().min(1).max(100).optional(),
      startCursor: z.string().min(1).optional(),
      includeSynopsis: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("get"),
      decisionId: z.string(),
    }),
    z.object({
      action: z.literal("context"),
      // Reject empty / whitespace-only entity at the boundary. The
      // handler routes through `FactService.queryByEntity`,
      // which short-circuits an empty input to `[]`, but failing the
      // dispatch with a clear error beats silently returning "no
      // decisions found" when the agent passed a blank string by mistake.
      entity: z.string().trim().min(1, "entity must be a non-empty string"),
      projectName: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    z.object({
      action: z.literal("supersede"),
      newDecisionId: z.string(),
      oldDecisionId: z.string(),
    }),
    z.object({
      action: z.literal("review"),
      decisionId: z.string(),
      reviewBy: clearableYmdDateSchema.optional(),
    }),
  ])
}

export function registerDecisionTools(server: McpServer, services: LoreServices): void {
  const tagsSchema = createTagsSchema(services.profile?.taxonomy.tags)
  const decisionDispatchSchema = createDecisionDispatchSchema(tagsSchema)

  // -------------------------------------------------------------------------
  // lore-decision — polymorphic dispatcher
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-decision",
    {
      title: "Decision lifecycle operations",
      description:
        "Record, query, or supersede architectural decisions. Action-dispatched:\n\n" +
        "- `action: 'create'` — record a decision (rationale, alternatives, consequences, review date). Auto-creates `decided_by` facts for each entry in `affects` and `supersedes_decision` facts when `supersedesIds` is set. Use this instead of `lore-memory action='save'` for decisions.\n" +
        "- `action: 'list'` — index-tier listing (no body fetch). Cursor-paginated.\n" +
        "- `action: 'get'` — load full rationale + metadata + relations for one decision.\n" +
        "- `action: 'context'` — graph walk: every active decision governing an entity, resolved through any supersession chain.\n" +
        "- `action: 'supersede'` — atomically mark `oldDecisionId` superseded by `newDecisionId` and create the `supersedes_decision` fact.\n" +
        "- `action: 'review'` — mark reviewed; set or clear the review-by date (default +90 days).",
      inputSchema: {
        action: z
          .enum(["create", "list", "get", "context", "supersede", "review"])
          .describe(
            "Operation: create, list, get (one), context (governing decisions for entity), supersede, review."
          ),
        // create
        decision: z
          .string()
          .optional()
          .describe(
            "(action='create') Required. One-line decision statement (becomes the title)."
          ),
        rationale: z
          .string()
          .optional()
          .describe(
            "(action='create') Required. Prose explaining the reasoning (page body)."
          ),
        // create | list | context
        projectName: z
          .string()
          .optional()
          .describe(
            "(create | list | context) Project name. Defaults to auto-detected for create."
          ),
        // create
        projectNames: z
          .array(z.string())
          .optional()
          .describe(
            "(action='create') Multiple project names for cross-project decisions."
          ),
        topicName: z
          .string()
          .optional()
          .describe(
            "(action='create') Topic name within the project (auto-created if missing). " +
              "Variants that differ only by case, plural-`s`, `&` vs `and`, or punctuation collapse onto the existing canonical row."
          ),
        forceNewTopic: z
          .boolean()
          .optional()
          .describe(
            "(action='create') Bypass the normalized-equivalent + trigram-similar topic-name probe and create a fresh row."
          ),
        // create | list
        status: z
          .enum(DECISION_STATUSES)
          .optional()
          .describe(
            "(action='create') Lifecycle state (default: accepted). (action='list') Filter."
          ),
        // create | list | review
        reviewBy: clearableYmdDateSchema
          .optional()
          .describe(
            "(action='create') Review-by date; create requires YYYY-MM-DD. (action='review') New review date (default +90d); null or empty string clears. " +
              "Note: list filter uses `reviewBefore` instead."
          ),
        // list only
        reviewBefore: ymdDateSchema
          .optional()
          .describe(
            "(action='list') Filter to decisions with `Review By` on or before this."
          ),
        // create
        decidedAt: ymdDateSchema
          .optional()
          .describe("(action='create') Canonical decision date (default: today)."),
        supersedesIds: z
          .array(z.string())
          .optional()
          .describe("(action='create') Decision IDs this decision replaces."),
        affects: z
          .array(z.string())
          .optional()
          .describe(
            "(action='create') Entity names affected. Each auto-creates a `decided_by` fact."
          ),
        alternatives: z
          .string()
          .max(RICH_TEXT_PROPERTY_MAX_LEN)
          .optional()
          .describe(
            `(action='create') Alternatives considered (≤${RICH_TEXT_PROPERTY_MAX_LEN} chars).`
          ),
        consequences: z
          .string()
          .max(RICH_TEXT_PROPERTY_MAX_LEN)
          .optional()
          .describe(
            `(action='create') Consequences accepted (≤${RICH_TEXT_PROPERTY_MAX_LEN} chars).`
          ),
        tags: tagsSchema.optional().describe("(action='create') Closed-vocabulary tags."),
        keywords: keywordsSchema
          .optional()
          .describe("(action='create') Free-form labels."),
        synopsis: z
          .string()
          .max(SYNOPSIS_MAX)
          .optional()
          .describe(
            "(action='create') 1–2 sentence synopsis of the governing rule — distinct from " +
              "`decision` (the title) and `rationale` (the body). Surfaces under the title on " +
              `recall/search/wake-up listings. Up to ${SYNOPSIS_MAX} chars.`
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
          .describe("(action='create') Name of the AI agent recording this decision."),
        session: z
          .string()
          .optional()
          .describe("(action='create') Session ID to group related records."),
        // list | context
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("(list | context) Max results. Defaults: list 20, context 10."),
        startCursor: z
          .string()
          .min(1)
          .optional()
          .describe("(action='list') Opaque pagination cursor."),
        includeSynopsis: z
          .boolean()
          .optional()
          .describe(
            "(action='list') Render each decision's synopsis line (when set) " +
              "between the title heading and the status/metadata line. Defaults true. " +
              "Pass false to restore byte-identical pre-DEFERRED-01 output for callers " +
              "piping the response into another formatter."
          ),
        // get | review
        decisionId: z
          .string()
          .optional()
          .describe(
            "Required for action='get' and action='review'. The decision's page ID."
          ),
        // context | (search-style)
        entity: z
          .string()
          .optional()
          .describe(
            "(action='context') Required. Entity to look up. Resolves through canonical entity registry (aliases + case-insensitive name) when available; matches `decided_by` facts whose Subject (preferred, via canonical relation) or Object text contains the input."
          ),
        // supersede
        newDecisionId: z
          .string()
          .optional()
          .describe("(action='supersede') Required. ID of the new decision."),
        oldDecisionId: z
          .string()
          .optional()
          .describe("(action='supersede') Required. ID of the decision being replaced."),
        scope: scopeInputSchema,
      },
    },
    async (args) => {
      const parsed = decisionDispatchSchema.safeParse(args)
      if (!parsed.success) {
        return toolError(new Error(formatDispatchError("lore-decision", parsed.error)))
      }
      const data = parsed.data
      switch (data.action) {
        case "create":
          return withWakeUpCacheBump(services.wakeupCache, () =>
            handleCreate(services, data)
          )
        case "list":
          return handleList(services, data)
        case "get":
          return handleGet(services, data)
        case "context":
          return handleContext(services, data, "lore-decision")
        case "supersede":
          return withWakeUpCacheBump(services.wakeupCache, () =>
            handleSupersede(services, data)
          )
        case "review":
          return withWakeUpCacheBump(services.wakeupCache, () =>
            handleReview(services, data)
          )
      }
    }
  )
}
