import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { toolError } from "../helpers.js"

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
        projectName: z.string().optional().describe("Scope to a project"),
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
    async ({ subject, predicate, object, projectName, confidence, sourceMemoryId }) => {
      try {
        let projectId: string | undefined

        if (projectName) {
          const found = await services.projects.findByName(projectName)
          if (found) projectId = found.id
        } else if (services.context.project) {
          projectId = services.context.project.id
        }

        const fact = await services.facts.create({
          subject,
          predicate,
          object,
          projectId,
          confidence,
          sourceMemoryId,
        })

        return {
          content: [
            {
              type: "text",
              text: `Learned: "${fact.subject}" ${fact.predicate.replace(/_/g, " ")} "${fact.object}" (${fact.confidence})`,
            },
          ],
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
}
