import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { toolError } from "../helpers.js"
import { resolveProjectIds } from "../resolve.js"

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
        '"AuthService" uses "JWT" with confidence "certain".',
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
      },
    },
    async ({ subject, predicate, object, projectName, projectNames, reviewBy, confidence, sourceMemoryId }) => {
      try {
        const resolved = await resolveProjectIds(services, projectName, projectNames)

        const fact = await services.facts.create({
          subject,
          predicate,
          object,
          projectIds: resolved.ids.length > 0 ? resolved.ids : undefined,
          reviewBy,
          confidence,
          sourceMemoryId,
        })

        const lines = [
          `Learned: "${fact.subject}" ${fact.predicate.replace(/_/g, " ")} "${fact.object}" (${fact.confidence}) — ID: ${fact.id}`,
        ]
        if (fact.reviewBy) {
          lines.push(`Review by: ${fact.reviewBy}`)
        }
        if (resolved.warnings.length > 0) {
          lines.push(`Warnings: ${resolved.warnings.join("; ")}`)
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

        if (projectName) {
          const found = await services.projects.findByName(projectName)
          if (found) projectId = found.id
        } else if (services.context.project) {
          projectId = services.context.project.id
        }

        const facts = await services.facts.queryByEntity(entity, { projectId })

        if (facts.length === 0) {
          return {
            content: [{ type: "text", text: `No facts found about "${entity}".` }],
          }
        }

        const today = new Date().toISOString().split("T")[0]
        const text = facts
          .map((f) => {
            const validity = f.validFrom ? ` (since ${f.validFrom})` : ""
            const review = f.reviewBy
              ? f.reviewBy <= today
                ? ` **(OVERDUE — review by ${f.reviewBy})**`
                : ` (review by ${f.reviewBy})`
              : ""
            return `- **${f.subject}** ${f.predicate.replace(/_/g, " ")} **${f.object}** [${f.confidence}]${validity}${review}\n  ID: ${f.id}`
          })
          .join("\n")

        return {
          content: [
            {
              type: "text",
              text: `${facts.length} facts about "${entity}":\n\n${text}`,
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

        if (projectName) {
          const found = await services.projects.findByName(projectName)
          if (found) projectId = found.id
        }
        if (!projectId && services.context.project) {
          projectId = services.context.project.id
        }

        const overdue = await services.facts.queryOverdue({ projectId })

        if (overdue.length === 0) {
          return {
            content: [{ type: "text", text: "No overdue facts found." }],
          }
        }

        const today = new Date().toISOString().split("T")[0]
        const text = overdue
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

        return {
          content: [
            {
              type: "text",
              text:
                `${overdue.length} overdue fact${overdue.length === 1 ? "" : "s"}:\n\n${text}\n\n` +
                "Actions:\n" +
                "- **Invalidate**: `lore-correct` with the fact ID if no longer true\n" +
                "- **Extend**: `lore-extend` with the fact ID and a new review date\n" +
                "- **No change**: leave as-is if still under review",
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
