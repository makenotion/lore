import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { toolError, paginationFooter, debugLogPartialFailures } from "../helpers.js"
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

/**
 * Trigram threshold for the `lore-decide` near-duplicate probe. Lower
 * than the memory threshold because decisions carry more ceremony and
 * redundant decisions are more costly than redundant notes — we'd rather
 * surface a supersession suggestion that the caller ignores than miss a
 * real replacement. Paired with same-project + same-topic scoping, which
 * already pre-filters aggressively.
 */
const DECISION_NEAR_DUPLICATE_THRESHOLD = 0.6

/** Cap the decision probe candidate pool. */
const DECISION_POOL_LIMIT = 50

/** Max candidates to surface in the response. */
const DECISION_SURFACE_LIMIT = 3

/**
 * The P2-03 spec scopes the decision probe to `Status IN (accepted,
 * proposed)` — superseded / deprecated / rejected decisions should not
 * surface as supersession targets. Notion's `dataSources.query` accepts
 * one `Status` clause; the probe post-filters these client-side.
 */
const ACTIVE_DECISION_STATUSES: DecisionStatus[] = ["accepted", "proposed"]

function formatNearDuplicateDecisions(
  matches: NearDuplicateMatch[],
  newDecisionId: string,
): string[] {
  const lines: string[] = []
  const shown = matches.slice(0, DECISION_SURFACE_LIMIT)
  lines.push(
    `Warning: ${matches.length} existing ${matches.length === 1 ? "decision looks" : "decisions look"} similar. If this supersedes any of them, use \`lore-supersede\`:`,
  )
  for (const m of shown) {
    const sim = m.titleSimilarity.toFixed(2)
    const when = m.decidedAt ? ` from ${m.decidedAt}` : ""
    lines.push(
      `  - "${m.title}" (${m.id})${when} — trigram ${sim}, status ${m.status}`,
    )
    lines.push(
      `    lore-supersede({ newDecisionId: "${newDecisionId}", oldDecisionId: "${m.id}" })`,
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

/**
 * Render a relation-list row: `Title (id)` when resolved, short hint
 * otherwise. Keeps the ID visible on a hit so readers can cross-reference
 * back to `lore-get-decision <id>`; on a miss, `displayId` already
 * produces a truncated-hint form so we don't double-print 36 hex chars.
 */
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

export function registerDecisionTools(server: McpServer, services: LoreServices): void {
  // -------------------------------------------------------------------------
  // lore-decide
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-decide",
    {
      title: "Record a decision",
      description:
        "Record an architectural decision as a first-class entity with rationale, alternatives, consequences, and review date. " +
        "Use this instead of `lore-remember` for decisions — it produces structured, queryable records that participate in `lore-audit` and `lore-wake-up`.\n\n" +
        "`tags` is a closed vocabulary. For free-form labels (PR numbers, ticket IDs, file paths), use `keywords`.\n\n" +
        "Auto-creates `decided_by` facts for each entity name in `affects`, so the decision surfaces automatically via `lore-ask` or `lore-decision-context`. " +
        "If `supersedesIds` is set, marks the old decision(s) as superseded and auto-creates `supersedes_decision` facts.",
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
          .describe("Date (YYYY-MM-DD) when this decision should be reviewed for staleness"),
        decidedAt: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("Canonical decision date (default: today)"),
        supersedesIds: z
          .array(z.string())
          .optional()
          .describe("Decision IDs this decision replaces. Each old decision is marked superseded."),
        affects: z
          .array(z.string())
          .optional()
          .describe(
            "Entity names affected by this decision (e.g., \"AuthService\"). " +
              "Each entry auto-creates a `decided_by` fact so the decision surfaces via `lore-ask`."
          ),
        alternatives: z
          .string()
          .optional()
          .describe("Alternatives considered, as a short free-text summary (2000 char limit)"),
        consequences: z
          .string()
          .optional()
          .describe("Consequences accepted, as a short free-text summary (2000 char limit)"),
        tags: tagsSchema.optional(),
        keywords: keywordsSchema.optional(),
        agent: z.string().optional().describe("Name of the AI agent recording this decision"),
        session: z.string().optional().describe("Session ID to group related records"),
      },
    },
    async ({
      decision,
      rationale,
      projectName,
      projectNames,
      topicName,
      status,
      confidence,
      reviewBy,
      decidedAt,
      supersedesIds,
      affects,
      alternatives,
      consequences,
      tags,
      keywords,
      agent,
      session,
    }) => {
      try {
        const resolved = await resolveProjectIds(services, projectName, projectNames)

        let topicId: string | undefined
        let topicLabel = "none"
        if (topicName && resolved.ids.length > 0) {
          const topic = await services.topics.getOrCreate(topicName, resolved.ids)
          topicId = topic.id
          topicLabel = topicName
        } else if (topicName) {
          // Decisions without any project can't anchor a topic: the topic
          // would be orphaned (not visible in `lore status topics <project>`
          // or `lore-get-project`). Surface the skip because the caller
          // explicitly asked to link one.
          resolved.warnings.push(
            `Topic "${topicName}" skipped (requires at least one project)`
          )
        }

        // Probe for near-duplicate decisions in parallel with the create.
        // Same-project + same-topic is the P2-03 rule; the probe returns
        // only active (accepted/proposed) decisions so superseded rows
        // don't show up as supersession targets. Running in parallel
        // keeps wall-clock latency at max(create, probe). The probe
        // short-circuits (returns []) when no project scope is available.
        // Probe failures route through `debugLogPartialFailures` (opt-in
        // under `LORE_DEBUG=1`) but never fail the save.
        const probeProjectId = resolved.ids[0]
        const probePromise = probeProjectId
          ? findNearDuplicates(services.memories, {
              title: decision,
              tags: tags ?? [],
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

        // Create the decision itself. supersedesIds are applied via
        // DecisionService.supersede() below (which also marks the old
        // decisions superseded), not as part of create — we want the
        // full atomic supersession semantic for each one.
        const [created, nearDuplicates] = await Promise.all([
          services.decisions.create({
            decision,
            rationale,
            projectIds: resolved.ids.length > 0 ? resolved.ids : undefined,
            topicId,
            status: (status ?? "accepted") as DecisionStatus,
            confidence,
            reviewBy,
            decidedAt,
            alternatives,
            consequences,
            tags,
            keywords,
            agent,
            session,
          }),
          probePromise,
        ])

        // Drop self in case the eventual-consistency race lets Notion's
        // query index surface the freshly-created row under the probe
        // filter.
        const duplicateMatches = nearDuplicates.filter((m) => m.id !== created.id)

        // Record for auto-linking on subsequent `lore-learn` calls in the
        // same (agent, session). Decisions already auto-source their own
        // `decided_by` and `supersedes_decision` facts below, but a plain
        // `lore-learn` call made after `lore-decide` in the same turn should
        // pick up the decision as the supporting memory — subject to the
        // project-overlap check in knowledge.ts.
        services.sessionMemories.record(
          { agent, session },
          { memoryId: created.id, projectIds: created.projectIds }
        )

        // Process affects first so any explicit context links already exist
        // before supersession reconciliation deduplicates inherited ones.
        const affectsCreated: string[] = []
        for (const entity of affects ?? []) {
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

        // Process supersessions: atomic memory-level supersede + auto-fact.
        const supersededEntries: Array<{ id: string; title: string }> = []
        const reachabilityUpdates: string[] = []
        for (const oldId of supersedesIds ?? []) {
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
              `Updated decision context for ${reachability.invalidated} affected ${reachability.invalidated === 1 ? "entity" : "entities"} superseded by "${oldDecision.title}"`
            )
          }
        }

        const projectLabel = projectNames?.length
          ? projectNames.join(", ")
          : projectName ?? services.context.project?.name ?? "none (vault-wide)"

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
        // Drop rows the caller already explicitly superseded — they are
        // expected duplicates and warning again would be noise. What's
        // left is "looks similar but the caller didn't call them out as
        // replacements" — the interesting near-dup surface.
        const supersededIdSet = new Set(supersedesIds ?? [])
        const decisionMatches = duplicateMatches.filter(
          (m) => !supersededIdSet.has(m.id),
        )
        if (decisionMatches.length > 0) {
          lines.push(
            "",
            ...formatNearDuplicateDecisions(decisionMatches, created.id),
          )
        }
        if (resolved.warnings.length > 0) {
          lines.push("", `Warnings: ${resolved.warnings.join("; ")}`)
        }

        return { content: [{ type: "text", text: lines.join("\n") }] }
      } catch (err) {
        return toolError(err)
      }
    }
  )

  // -------------------------------------------------------------------------
  // lore-list-decisions
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-list-decisions",
    {
      title: "List decisions",
      description:
        "List decisions matching the given filters. Returns summaries without markdown bodies — O(1) Notion API calls regardless of result count. " +
        "Use this to discover what decisions have been made; use `lore-get-decision` to read the full rationale for a specific one.\n\n" +
        "Returns up to `limit` decisions per call. When more exist, the response ends with a fenced " +
        "```json block `{\"nextCursor\":\"...\"}` — pass that value as `startCursor` on the next call to " +
        "continue enumerating. Absence of the footer means the final page.",
      inputSchema: {
        projectName: z.string().optional().describe("Scope to a project"),
        status: z
          .enum(DECISION_STATUSES)
          .optional()
          .describe("Filter by lifecycle state"),
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
          .describe(
            "Opaque cursor from a previous response's `nextCursor`. Pass to continue " +
              "enumerating from where the last page ended. Keep all other filters identical."
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ projectName, status, reviewBefore, limit, startCursor }) => {
      try {
        let projectId: string | undefined
        if (projectName) {
          const found = await services.projects.findByName(projectName)
          if (!found) {
            return {
              content: [{ type: "text", text: `Project "${projectName}" not found.` }],
            }
          }
          projectId = found.id
        } else if (services.context.project) {
          projectId = services.context.project.id
        }

        const { items: decisions, nextCursor } = await services.decisions.list({
          projectId,
          status: status as DecisionStatus | undefined,
          reviewBefore,
          limit: limit ?? 20,
          startCursor,
        })

        if (decisions.length === 0) {
          // Server-side filters can yield an empty page mid-enumeration; we
          // must surface the cursor so callers don't stop early on a false
          // "end of results" signal.
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
  )

  // -------------------------------------------------------------------------
  // lore-get-decision
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-get-decision",
    {
      title: "Get a decision",
      description:
        "Load the full rationale and metadata for a specific decision. Use `lore-list-decisions` to find the ID first.",
      inputSchema: {
        decisionId: z.string().describe("The decision's page ID"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ decisionId }) => {
      try {
        const decision = await services.decisions.getById(decisionId)
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
        // Resolve relation IDs to titles so readers can scan the chain
        // without cross-referencing opaque UUIDs. Both Supersedes and
        // Affects rows live in the Memories DB, so one title-only
        // fetcher handles the whole set; we batch the two ID lists
        // together to minimize the network fan-out on a single render.
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
  )

  // -------------------------------------------------------------------------
  // lore-decision-context
  // -------------------------------------------------------------------------
  // Single binding for both the MCP registration string and the operator
  // log's `tool=` field so a future rename can't desync the two surfaces.
  const decisionContextName = "lore-decision-context"
  server.registerTool(
    decisionContextName,
    {
      title: "Find decisions governing an entity",
      description:
        "Find every decision that governs a specific entity (e.g., \"AuthService\"). " +
        "Walks the facts graph: queries `decided_by` facts for the entity, resolves each to the current canonical decision through any supersession chain, and returns the active decisions sorted by decided date (newest first).\n\n" +
        "Use this before editing a subsystem — it answers \"what decisions already apply here?\"",
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
    async ({ entity, projectName, limit }) => {
      try {
        let projectId: string | undefined
        const warnings: string[] = []
        // Built just-in-time at each return site so warnings added later
        // (decision-graph partial failures) aren't silently dropped.
        const formatWarnings = () =>
          warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""

        if (projectName) {
          const found = await services.projects.findByName(projectName)
          if (!found) {
            return {
              content: [{ type: "text", text: `Project "${projectName}" not found.` }],
            }
          }
          projectId = found.id
        } else if (services.context.project) {
          projectId = services.context.project.id
        }

        const facts = await services.facts.queryBySubject(entity, {
          projectId,
          predicates: ["decided_by"],
        })

        if (facts.length === 0) {
          return {
            content: [
              { type: "text", text: `No decisions found governing "${entity}".` },
            ],
          }
        }

        const { links, failures: linkFailures } = await resolveCanonicalDecisionLinks(
          services,
          facts,
          { projectId },
        )
        if (linkFailures.length > 0) {
          debugLogPartialFailures(decisionContextName, linkFailures)
          const rootIds = linkFailures.map(({ rootId }) => rootId).join(", ")
          warnings.push(
            `Could not resolve ${linkFailures.length} decision root${linkFailures.length === 1 ? "" : "s"} (${rootIds}) — retry before relying on this result.`,
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
                text: `No active decisions found governing "${entity}".${formatWarnings()}`,
              },
            ],
          }
        }

        decisions.sort((a, b) =>
          (b.decidedAt ?? b.updatedAt).localeCompare(a.decidedAt ?? a.updatedAt)
        )

        const cap = limit ?? 10
        const shown = decisions.slice(0, cap)

        const lines: string[] = [
          `${shown.length} active decision${shown.length === 1 ? "" : "s"} governing "${entity}"` +
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
        // Subtract failures from the "resolved forward" count so a root
        // whose walk rejected doesn't read as if it was successfully
        // resolved onward to a live replacement.
        const resolvedOnward =
          historicalRoots.size - decisions.length - linkFailures.length
        if (resolvedOnward > 0) {
          lines.push(
            `_${resolvedOnward} superseded decision link${resolvedOnward === 1 ? "" : "s"} resolved forward to current replacements._`
          )
        }

        return {
          content: [{ type: "text", text: lines.join("\n") + formatWarnings() }],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )

  // -------------------------------------------------------------------------
  // lore-supersede
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-supersede",
    {
      title: "Supersede a decision",
      description:
        "Mark an old decision as superseded by a new one. Atomic: adds the old decision's ID to the new decision's `Supersedes` relation, then sets the old decision's `Status` to `superseded`. " +
        "Auto-creates a `supersedes_decision` fact using stable decision IDs and updates any inherited `decided_by` graph links.",
      inputSchema: {
        newDecisionId: z
          .string()
          .describe("ID of the new decision that takes precedence"),
        oldDecisionId: z
          .string()
          .describe("ID of the old decision being replaced"),
      },
    },
    async ({ newDecisionId, oldDecisionId }) => {
      try {
        const [newDecision, oldDecision] = await Promise.all([
          services.decisions.getById(newDecisionId),
          services.decisions.getById(oldDecisionId),
        ])

        await services.decisions.supersede(newDecisionId, oldDecisionId)

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
          oldDecisionId,
          newDecision
        )

        return {
          content: [
            {
              type: "text",
              text:
                `Superseded "${oldDecision.title}" (${oldDecisionId}) with "${newDecision.title}" (${newDecisionId}).\n` +
                `Auto-created fact: ${newDecisionId} → supersedes_decision → ${oldDecisionId}\n` +
                `Updated decision context for ${reachability.invalidated} affected ${reachability.invalidated === 1 ? "entity" : "entities"}.`,
            },
          ],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )

  // -------------------------------------------------------------------------
  // lore-review-decision
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-review-decision",
    {
      title: "Mark a decision reviewed",
      description:
        "Mark a decision as reviewed, pushing its `Review By` date forward. " +
        "Without a date, defaults to +90 days from today. Use after confirming a decision is still valid.",
      inputSchema: {
        decisionId: z.string().describe("The decision's page ID"),
        reviewBy: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("New review date (YYYY-MM-DD). Default: +90 days from today."),
      },
    },
    async ({ decisionId, reviewBy }) => {
      try {
        const newDate = reviewBy ?? addDaysISO(new Date(), 90)
        await services.decisions.reviewCompleted(decisionId, newDate)
        return {
          content: [
            {
              type: "text",
              text: `Marked decision ${decisionId} as reviewed. New review date: ${newDate}`,
            },
          ],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )
}
