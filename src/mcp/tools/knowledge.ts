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
    async ({ subject, predicate, object, projectName, projectNames, confidence, sourceMemoryId }) => {
      try {
        const resolved = await resolveProjectIds(services, projectName, projectNames)

        const fact = await services.facts.create({
          subject,
          predicate,
          object,
          projectIds: resolved.ids.length > 0 ? resolved.ids : undefined,
          confidence,
          sourceMemoryId,
        })

        const lines = [
          `Learned: "${fact.subject}" ${fact.predicate.replace(/_/g, " ")} "${fact.object}" (${fact.confidence})`,
        ]
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

        const text = facts
          .map((f) => {
            const validity = f.validFrom ? ` (since ${f.validFrom})` : ""
            return `- **${f.subject}** ${f.predicate.replace(/_/g, " ")} **${f.object}** [${f.confidence}]${validity}`
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

        const text = loops
          .map((f) => {
            const since = f.validFrom ? ` (since ${f.validFrom})` : ""
            return `- **${f.subject}** \u2192 ${f.predicate.replace(/_/g, " ")} \u2192 **${f.object}** [${f.confidence}]${since}  \n  ID: ${f.id}`
          })
          .join("\n")

        const warn = warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""

        return {
          content: [
            {
              type: "text",
              text: `${loops.length} open loop${loops.length === 1 ? "" : "s"}:\n\n${text}${warn}`,
            },
          ],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )
}
