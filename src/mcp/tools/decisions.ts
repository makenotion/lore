import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import {
  formatDispatchError,
  paginationFooter,
  toolError,
  debugLogPartialFailures,
} from "../helpers.js"
import { resolveProjectIds } from "../resolve.js"
import {
  resolveCanonicalDecisionLinks,
  syncDecisionReachability,
} from "../decision-graph.js"
import { displayId, resolveTitles } from "../render.js"
import type { DecisionSummary, DecisionStatus } from "../../types.js"
import { tagsSchema, keywordsSchema } from "./tag-schema.js"
import {
  findNearDuplicates,
  type NearDuplicateMatch,
} from "../../core/near-duplicate.js"

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

/**
 * Trigram threshold for the `lore-decide` near-duplicate probe. Lower
 * than the memory threshold because decisions carry more ceremony and
 * redundant decisions are more costly than redundant notes.
 */
const DECISION_NEAR_DUPLICATE_THRESHOLD = 0.6

/** Cap the decision probe candidate pool. */
const DECISION_POOL_LIMIT = 50

/** Max candidates to surface in the response. */
const DECISION_SURFACE_LIMIT = 3

const ACTIVE_DECISION_STATUSES: DecisionStatus[] = ["accepted", "proposed"]

function formatNearDuplicateDecisions(
  matches: NearDuplicateMatch[],
  newDecisionId: string,
): string[] {
  const lines: string[] = []
  const shown = matches.slice(0, DECISION_SURFACE_LIMIT)
  lines.push(
    `Warning: ${matches.length} existing ${matches.length === 1 ? "decision looks" : "decisions look"} similar. If this supersedes any of them, use \`lore-decision\` with \`action: 'supersede'\`:`,
  )
  for (const m of shown) {
    const sim = m.titleSimilarity.toFixed(2)
    const when = m.decidedAt ? ` from ${m.decidedAt}` : ""
    lines.push(
      `  - "${m.title}" (${m.id})${when} — trigram ${sim}, status ${m.status}`,
    )
    lines.push(
      `    lore-decision({ action: "supersede", newDecisionId: "${newDecisionId}", oldDecisionId: "${m.id}" })`,
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

const CONFIDENCES = ["certain", "likely", "speculative"] as const

const YMD_REGEX = /^\d{4}-\d{2}-\d{2}$/

function todayISO(): string {
  return new Date().toISOString().split("T")[0]
}

function addDaysISO(base: Date, days: number): string {
  const next = new Date(base)
  next.setDate(next.getDate() + days)
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
  status?: (typeof DECISION_STATUSES)[number]
  confidence?: (typeof CONFIDENCES)[number]
  reviewBy?: string
  decidedAt?: string
  supersedesIds?: string[]
  affects?: string[]
  alternatives?: string
  consequences?: string
  tags?: string[]
  keywords?: string
  agent?: string
  session?: string
}

async function handleCreate(services: LoreServices, args: CreateArgs): Promise<ToolResult> {
  try {
    const resolved = await resolveProjectIds(services, args.projectName, args.projectNames)

    let topicId: string | undefined
    let topicLabel = "none"
    if (args.topicName && resolved.ids.length > 0) {
      const topic = await services.topics.getOrCreate(args.topicName, resolved.ids)
      topicId = topic.id
      topicLabel = args.topicName
    } else if (args.topicName) {
      resolved.warnings.push(
        `Topic "${args.topicName}" skipped (requires at least one project)`,
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
          onError: (err) =>
            debugLogPartialFailures("lore-decide", [
              { rootId: "near-duplicate-probe", error: err },
            ]),
        })
      : Promise.resolve([] as NearDuplicateMatch[])

    const [created, nearDuplicates] = await Promise.all([
      services.decisions.create({
        decision: args.decision,
        rationale: args.rationale,
        projectIds: resolved.ids.length > 0 ? resolved.ids : undefined,
        topicId,
        status: (args.status ?? "accepted") as DecisionStatus,
        confidence: args.confidence,
        reviewBy: args.reviewBy,
        decidedAt: args.decidedAt,
        alternatives: args.alternatives,
        consequences: args.consequences,
        tags: args.tags,
        keywords: args.keywords,
        agent: args.agent,
        session: args.session,
      }),
      probePromise,
    ])

    const duplicateMatches = nearDuplicates.filter((m) => m.id !== created.id)

    services.sessionMemories.record(
      { agent: args.agent, session: args.session },
      { memoryId: created.id, projectIds: created.projectIds },
    )

    const affectsCreated: string[] = []
    for (const entity of args.affects ?? []) {
      await services.facts.create({
        subject: entity,
        predicate: "decided_by",
        object: created.id,
        projectIds: created.projectIds.length > 0 ? created.projectIds : undefined,
        sourceMemoryId: created.id,
        confidence: created.confidence,
      })
      affectsCreated.push(entity)
    }

    const supersededEntries: Array<{ id: string; title: string }> = []
    const reachabilityUpdates: string[] = []
    for (const oldId of args.supersedesIds ?? []) {
      const oldDecision = await services.decisions.getById(oldId)
      await services.decisions.supersede(created.id, oldId)
      await services.facts.create({
        subject: created.id,
        predicate: "supersedes_decision",
        object: oldId,
        projectIds: created.projectIds.length > 0 ? created.projectIds : undefined,
        sourceMemoryId: created.id,
        confidence: created.confidence,
      })
      const reachability = await syncDecisionReachability(services, oldId, created)
      supersededEntries.push({ id: oldId, title: oldDecision.title })
      if (reachability.invalidated > 0) {
        reachabilityUpdates.push(
          `Updated decision context for ${reachability.invalidated} affected ${reachability.invalidated === 1 ? "entity" : "entities"} superseded by "${oldDecision.title}"`,
        )
      }
    }

    const projectLabel = args.projectNames?.length
      ? args.projectNames.join(", ")
      : args.projectName ?? services.context.project?.name ?? "none (vault-wide)"

    const lines: string[] = [
      `Saved decision: "${created.title}" (${created.id})`,
      `Status: ${created.status} | Decided at: ${created.decidedAt ?? "today"}${created.reviewBy ? ` | Review by: ${created.reviewBy}` : ""}`,
      `Project: ${projectLabel} | Topic: ${topicLabel}`,
      `Confidence: ${created.confidence}`,
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
    if (resolved.warnings.length > 0) {
      lines.push("", `Warnings: ${resolved.warnings.join("; ")}`)
    }

    return { content: [{ type: "text", text: lines.join("\n") }] }
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
}

async function handleList(services: LoreServices, args: ListArgs): Promise<ToolResult> {
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

    const { items: decisions, nextCursor } = await services.decisions.list({
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
          { type: "text", text: `${header}${paginationFooter(nextCursor)}` },
        ],
      }
    }

    const lines = [`Found ${decisions.length} decision${decisions.length === 1 ? "" : "s"}:\n`]
    for (const d of decisions) {
      lines.push(`### ${d.title}`)
      lines.push(formatSummary(d))
      if (d.alternatives) lines.push(`Alternatives: ${d.alternatives}`)
      if (d.consequences) lines.push(`Consequences: ${d.consequences}`)
      lines.push("")
    }

    return {
      content: [
        { type: "text", text: `${lines.join("\n")}${paginationFooter(nextCursor)}` },
      ],
    }
  } catch (err) {
    return toolError(err)
  }
}

async function handleGet(
  services: LoreServices,
  args: { decisionId: string },
): Promise<ToolResult> {
  try {
    const decision = await services.decisions.getById(args.decisionId)
    const lines = [
      `# ${decision.title}`,
      "",
      `**Status:** ${decision.status}  `,
      `**Decided:** ${decision.decidedAt ?? "unknown"}  `,
      decision.reviewBy ? `**Review by:** ${decision.reviewBy}  ` : null,
      `**Confidence:** ${decision.confidence}  `,
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
      (id) => services.memories.getTitleById(id),
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

    return { content: [{ type: "text", text: lines.join("\n") }] }
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
  toolName: string,
): Promise<ToolResult> {
  try {
    let projectId: string | undefined
    const warnings: string[] = []
    const formatWarnings = () =>
      warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""

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

    const facts = await services.facts.queryBySubject(args.entity, {
      projectId,
      predicates: ["decided_by"],
    })

    if (facts.length === 0) {
      return {
        content: [
          { type: "text", text: `No decisions found governing "${args.entity}".` },
        ],
      }
    }

    const { links, failures: linkFailures } = await resolveCanonicalDecisionLinks(
      services,
      facts,
      { projectId },
    )
    if (linkFailures.length > 0) {
      debugLogPartialFailures(toolName, linkFailures)
      const rootIds = linkFailures.map(({ rootId }) => rootId).join(", ")
      warnings.push(
        `Could not resolve ${linkFailures.length} decision root${linkFailures.length === 1 ? "" : "s"} (${rootIds}) — retry before relying on this result.`,
      )
    }
    const decisions = Array.from(
      new Map(links.map(({ decision }) => [decision.id, decision])).values(),
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
      (b.decidedAt ?? b.updatedAt).localeCompare(a.decidedAt ?? a.updatedAt),
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
        `**[${d.status}]${d.decidedAt ? ` | decided ${d.decidedAt}` : ""} | ID: ${d.id}**`,
      )
      if (d.alternatives) lines.push(`Alternatives: ${d.alternatives}`)
      if (d.consequences) lines.push(`Consequences: ${d.consequences}`)
      lines.push("")
    }

    const historicalRoots = new Set(
      facts
        .map((fact) => fact.sourceMemoryId ?? fact.object)
        .filter((value): value is string => value !== null && value.length > 0),
    )
    const resolvedOnward = historicalRoots.size - decisions.length - linkFailures.length
    if (resolvedOnward > 0) {
      lines.push(
        `_${resolvedOnward} superseded decision link${resolvedOnward === 1 ? "" : "s"} resolved forward to current replacements._`,
      )
    }

    return {
      content: [{ type: "text", text: lines.join("\n") + formatWarnings() }],
    }
  } catch (err) {
    return toolError(err)
  }
}

async function handleSupersede(
  services: LoreServices,
  args: { newDecisionId: string; oldDecisionId: string },
): Promise<ToolResult> {
  try {
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
      confidence: newDecision.confidence,
    })
    const reachability = await syncDecisionReachability(
      services,
      args.oldDecisionId,
      newDecision,
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
    }
  } catch (err) {
    return toolError(err)
  }
}

async function handleReview(
  services: LoreServices,
  args: { decisionId: string; reviewBy?: string },
): Promise<ToolResult> {
  try {
    const newDate = args.reviewBy ?? addDaysISO(new Date(), 90)
    await services.decisions.reviewCompleted(args.decisionId, newDate)
    return {
      content: [
        {
          type: "text",
          text: `Marked decision ${args.decisionId} as reviewed. New review date: ${newDate}`,
        },
      ],
    }
  } catch (err) {
    return toolError(err)
  }
}

const decisionDispatchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    decision: z.string(),
    rationale: z.string(),
    projectName: z.string().optional(),
    projectNames: z.array(z.string()).optional(),
    topicName: z.string().optional(),
    status: z.enum(DECISION_STATUSES).optional(),
    confidence: z.enum(CONFIDENCES).optional(),
    reviewBy: z.string().regex(YMD_REGEX).optional(),
    decidedAt: z.string().regex(YMD_REGEX).optional(),
    supersedesIds: z.array(z.string()).optional(),
    affects: z.array(z.string()).optional(),
    alternatives: z.string().optional(),
    consequences: z.string().optional(),
    tags: tagsSchema.optional(),
    keywords: keywordsSchema.optional(),
    agent: z.string().optional(),
    session: z.string().optional(),
  }),
  z.object({
    action: z.literal("list"),
    projectName: z.string().optional(),
    status: z.enum(DECISION_STATUSES).optional(),
    reviewBefore: z.string().regex(YMD_REGEX).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    startCursor: z.string().min(1).optional(),
  }),
  z.object({
    action: z.literal("get"),
    decisionId: z.string(),
  }),
  z.object({
    action: z.literal("context"),
    entity: z.string(),
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
    reviewBy: z.string().regex(YMD_REGEX).optional(),
  }),
])

export function registerDecisionTools(server: McpServer, services: LoreServices): void {
  // -------------------------------------------------------------------------
  // lore-decision — polymorphic dispatcher (P3-01)
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
        "- `action: 'review'` — mark a decision reviewed, push the review-by date forward (default +90 days).",
      inputSchema: {
        action: z
          .enum(["create", "list", "get", "context", "supersede", "review"])
          .describe(
            "Operation: create, list, get (one), context (governing decisions for entity), supersede, review.",
          ),
        // create
        decision: z
          .string()
          .optional()
          .describe("(action='create') Required. One-line decision statement (becomes the title)."),
        rationale: z
          .string()
          .optional()
          .describe("(action='create') Required. Prose explaining the reasoning (page body)."),
        // create | list | context
        projectName: z
          .string()
          .optional()
          .describe(
            "(create | list | context) Project name. Defaults to auto-detected for create.",
          ),
        // create
        projectNames: z
          .array(z.string())
          .optional()
          .describe("(action='create') Multiple project names for cross-project decisions."),
        topicName: z
          .string()
          .optional()
          .describe("(action='create') Topic name within the project (auto-created if missing)."),
        // create | list
        status: z
          .enum(DECISION_STATUSES)
          .optional()
          .describe(
            "(action='create') Lifecycle state (default: accepted). (action='list') Filter.",
          ),
        // create
        confidence: z
          .enum(CONFIDENCES)
          .optional()
          .describe("(action='create') Confidence (default: certain)."),
        // create | list | review
        reviewBy: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe(
            "(action='create') Review-by date. (action='review') New review date (default +90d). " +
              "Note: list filter uses `reviewBefore` instead.",
          ),
        // list only
        reviewBefore: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("(action='list') Filter to decisions with `Review By` on or before this."),
        // create
        decidedAt: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
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
            "(action='create') Entity names affected. Each auto-creates a `decided_by` fact.",
          ),
        alternatives: z
          .string()
          .optional()
          .describe("(action='create') Alternatives considered (≤2000 chars)."),
        consequences: z
          .string()
          .optional()
          .describe("(action='create') Consequences accepted (≤2000 chars)."),
        tags: tagsSchema.optional().describe("(action='create') Closed-vocabulary tags."),
        keywords: keywordsSchema.optional().describe("(action='create') Free-form labels."),
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
        // get | review
        decisionId: z
          .string()
          .optional()
          .describe(
            "Required for action='get' and action='review'. The decision's page ID.",
          ),
        // context | (search-style)
        entity: z
          .string()
          .optional()
          .describe(
            "(action='context') Required. Entity to look up (matches `decided_by` Subject).",
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
      },
    },
    async (args) => {
      const parsed = decisionDispatchSchema.safeParse(args)
      if (!parsed.success) {
        return toolError(
          new Error(formatDispatchError("lore-decision", parsed.error)),
        )
      }
      switch (parsed.data.action) {
        case "create":
          return handleCreate(services, parsed.data)
        case "list":
          return handleList(services, parsed.data)
        case "get":
          return handleGet(services, parsed.data)
        case "context":
          return handleContext(services, parsed.data, "lore-decision")
        case "supersede":
          return handleSupersede(services, parsed.data)
        case "review":
          return handleReview(services, parsed.data)
      }
    },
  )

  // -------------------------------------------------------------------------
  // Deprecated aliases — preserved for the one-release transition window.
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-decide",
    {
      title: "Record a decision",
      description: "Deprecated alias — prefer `lore-decision` with `action: 'create'`.",
      inputSchema: {
        decision: z.string().describe("One-line decision statement (becomes the title)"),
        rationale: z.string().describe("Prose explaining the reasoning (becomes the page body)"),
        projectName: z
          .string()
          .optional()
          .describe("Project name. Defaults to auto-detected project from cwd."),
        projectNames: z
          .array(z.string())
          .optional()
          .describe("Multiple project names for cross-project decisions"),
        topicName: z
          .string()
          .optional()
          .describe("Topic name within the project (auto-created if it doesn't exist)"),
        status: z
          .enum(DECISION_STATUSES)
          .optional()
          .describe("Lifecycle state (default: accepted)"),
        confidence: z
          .enum(CONFIDENCES)
          .optional()
          .describe("Confidence in the decision (default: certain)"),
        reviewBy: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("Review-by date YYYY-MM-DD."),
        decidedAt: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("Canonical decision date YYYY-MM-DD."),
        supersedesIds: z
          .array(z.string())
          .optional()
          .describe("Decision IDs this decision replaces."),
        affects: z
          .array(z.string())
          .optional()
          .describe("Entity names affected — auto-creates `decided_by` facts."),
        alternatives: z
          .string()
          .optional()
          .describe("Alternatives considered (≤2000 char)"),
        consequences: z
          .string()
          .optional()
          .describe("Consequences accepted (≤2000 char)"),
        tags: tagsSchema.optional(),
        keywords: keywordsSchema.optional(),
        agent: z.string().optional().describe("Name of the AI agent recording this decision"),
        session: z.string().optional().describe("Session ID to group related records"),
      },
    },
    async (args) => handleCreate(services, args),
  )

  server.registerTool(
    "lore-list-decisions",
    {
      title: "List decisions",
      description: "Deprecated alias — prefer `lore-decision` with `action: 'list'`.",
      inputSchema: {
        projectName: z.string().optional().describe("Scope to a project"),
        status: z.enum(DECISION_STATUSES).optional().describe("Filter by lifecycle state"),
        reviewBefore: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("Only return decisions with `Review By` on or before this date"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max results per page (default 20, max 100)"),
        startCursor: z
          .string()
          .min(1)
          .optional()
          .describe("Opaque cursor from a previous response's `nextCursor`."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => handleList(services, args),
  )

  server.registerTool(
    "lore-get-decision",
    {
      title: "Get a decision",
      description: "Deprecated alias — prefer `lore-decision` with `action: 'get'`.",
      inputSchema: {
        decisionId: z.string().describe("The decision's page ID"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ decisionId }) => handleGet(services, { decisionId }),
  )

  const decisionContextLegacyName = "lore-decision-context"
  server.registerTool(
    decisionContextLegacyName,
    {
      title: "Find decisions governing an entity",
      description: "Deprecated alias — prefer `lore-decision` with `action: 'context'`.",
      inputSchema: {
        entity: z
          .string()
          .describe("The entity to look up (matches the Subject of `decided_by` facts)"),
        projectName: z.string().optional().describe("Scope to a project"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max decisions to return (default 10)"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => handleContext(services, args, decisionContextLegacyName),
  )

  server.registerTool(
    "lore-supersede",
    {
      title: "Supersede a decision",
      description: "Deprecated alias — prefer `lore-decision` with `action: 'supersede'`.",
      inputSchema: {
        newDecisionId: z.string().describe("ID of the new decision that takes precedence"),
        oldDecisionId: z.string().describe("ID of the old decision being replaced"),
      },
    },
    async (args) => handleSupersede(services, args),
  )

  server.registerTool(
    "lore-review-decision",
    {
      title: "Mark a decision reviewed",
      description: "Deprecated alias — prefer `lore-decision` with `action: 'review'`.",
      inputSchema: {
        decisionId: z.string().describe("The decision's page ID"),
        reviewBy: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("New review date (YYYY-MM-DD). Default: +90 days from today."),
      },
    },
    async (args) => handleReview(services, args),
  )
}
