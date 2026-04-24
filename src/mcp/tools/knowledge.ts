import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { toolError } from "../helpers.js"
import { resolveProjectIds } from "../resolve.js"
import { resolveCanonicalDecisionLinks } from "../decision-graph.js"
import { renderFact, resolveReferencedTitles } from "../render.js"

import { TRACKING_PREDICATES } from "../../types.js"

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

export function registerKnowledgeTools(server: McpServer, services: LoreServices): void {
  // -------------------------------------------------------------------------
  // lore-learn
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-learn",
    {
      title: "Add a fact",
      description:
        "Add a fact to the knowledge graph. Facts are entity-relationship " +
        "triples: Subject —predicate→ Object. Example: " +
        '"AuthService" uses "JWT" with confidence "certain".\n\n' +
        "Every fact SHOULD link back to a supporting memory via `sourceMemoryId` so `lore-ask` can " +
        "retrace the reasoning. Pass the memory ID directly, or pass `agent`+`session` matching an " +
        "earlier `lore-remember`/`lore-decide` call in the same process and `sourceMemoryId` " +
        "auto-links. If neither is available the fact is still created, but with a warning — this " +
        "will become a hard error in a future release.",
      inputSchema: {
        subject: z.string().describe("The entity this fact is about"),
        predicate: z.enum(PREDICATE_VALUES).describe("The relationship type"),
        object: z.string().describe("The related entity or value"),
        projectName: z.string().optional().describe("Scope to a project. Defaults to auto-detected project from cwd."),
        projectNames: z.array(z.string()).optional().describe("Multiple project names for cross-project facts."),
        reviewBy: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
          .optional()
          .describe(
            "Date (YYYY-MM-DD) by which this fact should be reviewed. " +
            "Tracking predicates (needs_action, waiting_on, blocked_by) auto-default to 7 days if omitted."
          ),
        confidence: z
          .enum(["certain", "likely", "speculative"])
          .optional()
          .describe("How confident is this fact (default: certain)"),
        sourceMemoryId: z
          .string()
          .optional()
          .describe("ID of the memory that supports this fact"),
        session: z
          .string()
          .optional()
          .describe(
            "Session ID. Combined with `agent`, used to auto-link `sourceMemoryId` to a memory saved " +
              "earlier in this process."
          ),
        agent: z
          .string()
          .optional()
          .describe("Agent name. Part of the composite session key used for auto-link."),
      },
    },
    async ({
      subject,
      predicate,
      object,
      projectName,
      projectNames,
      reviewBy,
      confidence,
      sourceMemoryId,
      session,
      agent,
    }) => {
      try {
        const resolved = await resolveProjectIds(services, projectName, projectNames)
        const factProjectIds = resolved.ids

        let effectiveSource: string | undefined = sourceMemoryId
        let autoLinkedFromSession = false
        const toolWarnings: string[] = [...resolved.warnings]

        if (!effectiveSource) {
          const candidate = services.sessionMemories.get({ agent, session })
          if (candidate) {
            if (projectsCompatible(factProjectIds, candidate.projectIds)) {
              effectiveSource = candidate.memoryId
              autoLinkedFromSession = true
            } else {
              // Scoped fact + scoped memory with disjoint projects: declining
              // the auto-link prevents a durable cross-project mis-link.
              // The caller can still pass `sourceMemoryId` explicitly if this
              // memory really is the right source.
              toolWarnings.push(
                `Declined auto-link: session memory ${candidate.memoryId} is scoped to a different project ` +
                  `than this fact. Pass sourceMemoryId explicitly to override.`
              )
            }
          }
        }

        const { fact, deduped, enriched } = await services.facts.createWithDedup({
          subject,
          predicate,
          object,
          projectIds: factProjectIds.length > 0 ? factProjectIds : undefined,
          reviewBy,
          confidence,
          sourceMemoryId: effectiveSource,
        })

        // "Learned" — new row. "Enriched" — dedup hit with metadata merged
        // (projects unioned, source linked, review extended). "Matched" —
        // dedup hit that was a genuine no-op, so the agent knows nothing
        // changed even though the ID survived.
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
          // Surface the auto-pick: heuristics can be wrong, and the caller
          // needs visibility to retract if the supporting memory is not the
          // one they intended.
          lines.push(`Source (auto-linked from session): ${effectiveSource}`)
        } else if (effectiveSource) {
          lines.push(`Source: ${effectiveSource}`)
        } else {
          // Soft-phase. We create the fact but flag it loudly so deployed
          // agents have a window to adopt `sourceMemoryId` before the hard
          // error lands in a future minor. Existing callers are not broken
          // by this; new orphan facts are observable in the response.
          lines.push(
            "WARNING: No Source memory linked. Facts without a Source can't be retraced by `lore-ask`. " +
              "Pass `sourceMemoryId` with an existing supporting memory, or pass `agent`+`session` " +
              "matching an earlier `lore-remember`/`lore-decide` call for auto-link. This becomes a " +
              "hard error in a future release."
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
  )

  // -------------------------------------------------------------------------
  // lore-ask
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-ask",
    {
      title: "Query facts",
      description:
        "Query the knowledge graph for facts about an entity. Returns all " +
        "current facts where the entity appears as either subject or object.",
      inputSchema: {
        entity: z
          .string()
          .describe("The entity to query (searched as both subject and object)"),
        projectName: z.string().optional().describe("Scope to a project"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ entity, projectName }) => {
      try {
        let projectId: string | undefined
        const warnings: string[] = []

        if (projectName) {
          const found = await services.projects.findByName(projectName)
          if (found) {
            projectId = found.id
          } else {
            warnings.push(
              `Project "${projectName}" not found — falling back to auto-detected project.`,
            )
          }
        }
        if (!projectId && services.context.project) {
          projectId = services.context.project.id
        }

        const facts = await services.facts.queryByEntity(entity, { projectId })

        const warn = warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""

        if (facts.length === 0) {
          return {
            content: [{ type: "text", text: `No facts found about "${entity}".${warn}` }],
          }
        }

        const today = new Date().toISOString().split("T")[0]
        const decisionFacts = facts.filter((fact) => fact.predicate === "decided_by")
        const otherFacts = facts.filter((fact) => fact.predicate !== "decided_by")
        const lines: string[] = []
        const decisionLinks = await resolveCanonicalDecisionLinks(services, decisionFacts, {
          projectId,
        })

        for (const { fact, decision } of decisionLinks) {
          const review = decision.reviewBy
            ? decision.reviewBy <= today
              ? ` **(DECISION REVIEW OVERDUE — ${decision.reviewBy})**`
              : ` (decision review by ${decision.reviewBy})`
            : ""
          const decided = decision.decidedAt ? ` (decided ${decision.decidedAt})` : ""
          lines.push(
            `- **${fact.subject}** decided by **${decision.title}** [${decision.status}, ${decision.confidence}]${decided}${review}\n  Decision ID: ${decision.id} | Fact ID: ${fact.id}`
          )
        }

        // Resolve every UUID referenced by a non-decided_by fact (both
        // subject- and object-side) so generic predicates render titles
        // instead of opaque page IDs — see P1-05. `decided_by` facts are
        // handled above by the canonical-decision resolver.
        const titleMap = await resolveReferencedTitles(otherFacts, services)

        for (const fact of otherFacts) {
          const validity = fact.validFrom ? ` (since ${fact.validFrom})` : ""
          const review = fact.reviewBy
            ? fact.reviewBy <= today
              ? ` **(OVERDUE — review by ${fact.reviewBy})**`
              : ` (review by ${fact.reviewBy})`
            : ""

          const trailing = `[${fact.confidence}]${validity}${review}\n  ID: ${fact.id}`
          lines.push(renderFact(fact, { titleMap, trailing }))
        }

        if (lines.length === 0) {
          return {
            content: [{ type: "text", text: `No current facts found about "${entity}".${warn}` }],
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `${lines.length} facts about "${entity}":\n\n${lines.join("\n")}${warn}`,
            },
          ],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )

  // -------------------------------------------------------------------------
  // lore-correct
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-correct",
    {
      title: "Invalidate a fact",
      description:
        'Mark a fact as no longer true by setting its "Valid Until" date to today. ' +
        "The fact is preserved for historical reference but excluded from default queries.",
      inputSchema: {
        factId: z.string().describe("The fact ID to invalidate"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ factId }) => {
      try {
        await services.facts.invalidate(factId)
        return {
          content: [{ type: "text", text: `Invalidated fact ${factId}` }],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )

  // -------------------------------------------------------------------------
  // lore-open-loops
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-open-loops",
    {
      title: "List open loops",
      description:
        "List active open loops — tracked items that need action, are waiting on something, " +
        "or are blocked. These are facts with tracking predicates (needs_action, waiting_on, " +
        "blocked_by) that haven't been resolved yet.\n\n" +
        "Tracking facts auto-expire for review after 7 days. Overdue items are shown first.\n\n" +
        "To create an open loop, use lore-learn with a tracking predicate. " +
        "To resolve one, use lore-correct to invalidate the fact.",
      inputSchema: {
        projectName: z
          .string()
          .optional()
          .describe("Override the auto-detected project."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ projectName }) => {
      try {
        let projectId: string | undefined
        const warnings: string[] = []

        if (projectName) {
          const found = await services.projects.findByName(projectName)
          if (found) {
            projectId = found.id
          } else {
            warnings.push(`Project "${projectName}" not found — falling back to auto-detected project.`)
          }
        }
        if (!projectId && services.context.project) {
          projectId = services.context.project.id
        }

        const loops = await services.facts.queryBySubject("", {
          projectId,
          predicates: TRACKING_PREDICATES,
        })

        if (loops.length === 0) {
          const warn = warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""
          return {
            content: [{ type: "text", text: `No open loops found.${warn}` }],
          }
        }

        const today = new Date().toISOString().split("T")[0]
        const overdue = loops.filter((f) => f.reviewBy && f.reviewBy <= today)
        const active = loops.filter((f) => !f.reviewBy || f.reviewBy > today)

        const formatLoop = (f: typeof loops[number]) => {
          const since = f.validFrom ? ` (since ${f.validFrom})` : ""
          const review = f.reviewBy ? ` — review by ${f.reviewBy}` : ""
          const tag = f.reviewBy && f.reviewBy <= today ? " **(OVERDUE)**" : ""
          return `- **${f.subject}** \u2192 ${f.predicate.replace(/_/g, " ")} \u2192 **${f.object}** [${f.confidence}]${since}${review}${tag}  \n  ID: ${f.id}`
        }

        const sections: string[] = []
        if (overdue.length > 0) {
          sections.push(`### Overdue (${overdue.length})\n\n${overdue.map(formatLoop).join("\n")}`)
        }
        if (active.length > 0) {
          sections.push(`### Active (${active.length})\n\n${active.map(formatLoop).join("\n")}`)
        }

        const warn = warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""

        return {
          content: [
            {
              type: "text",
              text: `${loops.length} open loop${loops.length === 1 ? "" : "s"}:\n\n${sections.join("\n\n")}${warn}`,
            },
          ],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )

  // -------------------------------------------------------------------------
  // lore-audit
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-audit",
    {
      title: "Audit overdue facts",
      description:
        "List all facts past their review-by date that haven't been invalidated. " +
        "Use this to find stale knowledge that needs triage: either invalidate with " +
        "lore-correct or extend with lore-extend.\n\n" +
        "Facts with tracking predicates auto-default to a 7-day review window.",
      inputSchema: {
        projectName: z
          .string()
          .optional()
          .describe("Override the auto-detected project."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ projectName }) => {
      try {
        let projectId: string | undefined

        // Strict resolution: lore-audit suggests destructive actions
        // ("mark reviewed", "supersede") targeted at the surfaced items,
        // so silently falling back to the ambient project would put the
        // caller at risk of acting on the wrong project's overdue queue.
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
                (new Date(today).getTime() - new Date(f.reviewBy!).getTime()) / 86_400_000
              )
              const since = f.validFrom ? ` (since ${f.validFrom})` : ""
              return (
                `- **${f.subject}** ${f.predicate.replace(/_/g, " ")} **${f.object}** [${f.confidence}]${since}\n` +
                `  Review by: ${f.reviewBy} (${days} day${days === 1 ? "" : "s"} overdue)\n` +
                `  ID: ${f.id}`
              )
            })
            .join("\n")
          sections.push(
            `## Overdue Facts (${overdueFacts.length})\n\n${factLines}`
          )
        }

        if (overdueDecisions.length > 0) {
          const decisionLines = overdueDecisions
            .map((d) => {
              const days = d.reviewBy
                ? Math.floor(
                    (new Date(today).getTime() - new Date(d.reviewBy).getTime()) /
                      86_400_000
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

        const actions = [
          "",
          "Actions:",
          "- **Fact — invalidate**: `lore-correct` with the fact ID if no longer true",
          "- **Fact — extend**: `lore-extend` with the fact ID and a new review date",
          "- **Decision — mark reviewed**: `lore-review-decision` with the decision ID",
          "- **Decision — supersede**: `lore-supersede` with a replacement decision",
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
  )

  // -------------------------------------------------------------------------
  // lore-extend
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-extend",
    {
      title: "Extend a fact's review date",
      description:
        "Push back the review-by date on a fact. Use when a fact is still valid " +
        "but needs more time before the next review.",
      inputSchema: {
        factId: z.string().describe("The fact ID to extend"),
        reviewBy: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
          .describe("New review-by date (YYYY-MM-DD)"),
      },
    },
    async ({ factId, reviewBy }) => {
      try {
        await services.facts.extendReview(factId, reviewBy)
        return {
          content: [{ type: "text", text: `Extended review date for ${factId} to ${reviewBy}` }],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )
}
