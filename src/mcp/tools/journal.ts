import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { toolError } from "../helpers.js"

export function registerJournalTools(server: McpServer, services: LoreServices): void {
  // -------------------------------------------------------------------------
  // lore-journal
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-journal",
    {
      title: "Write a journal entry",
      description:
        "Write a journal entry for the current agent session. Journal entries " +
        "are memories with source type 'agent_diary'. Use this to record session " +
        "notes, observations, or decisions made during a conversation.",
      inputSchema: {
        title: z.string().describe("Journal entry title"),
        content: z.string().describe("Journal entry content (markdown supported)"),
        agent: z.string().optional().describe("Agent name (e.g., 'Claude Code', 'Codex')"),
        session: z
          .string()
          .optional()
          .describe("Session identifier for grouping entries"),
        tags: z.array(z.string()).optional().describe("Tags for categorization"),
      },
    },
    async ({ title, content, agent, session, tags }) => {
      try {
        const projectIds = services.context.project
          ? [services.context.project.id]
          : undefined

        const memory = await services.memories.create({
          title,
          content,
          projectIds,
          source: "agent_diary",
          agent: agent ?? "unknown",
          session,
          tags,
        })

        return {
          content: [
            {
              type: "text",
              text: `Journal entry saved: "${memory.title}" (${memory.id})`,
            },
          ],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )

  // -------------------------------------------------------------------------
  // lore-read-journal
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-read-journal",
    {
      title: "Read journal entries",
      description:
        "Read recent journal entries (agent diary memories). " +
        "Useful for reviewing what previous sessions documented.",
      inputSchema: {
        agent: z.string().optional().describe("Filter by agent name"),
        projectName: z.string().optional().describe("Filter by project name"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max entries (default 10)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ agent, projectName, limit }) => {
      try {
        let projectId: string | undefined

        if (projectName) {
          const found = await services.projects.findByName(projectName)
          if (found) projectId = found.id
        } else if (services.context.project) {
          projectId = services.context.project.id
        }

        const entries = await services.memories.list({
          projectId,
          source: "agent_diary",
          limit: limit ?? 10,
        })

        // Filter by agent name if specified
        let filtered = entries
        if (agent) {
          filtered = entries.filter((m) =>
            m.agent.toLowerCase().includes(agent.toLowerCase())
          )
        }

        if (filtered.length === 0) {
          return {
            content: [{ type: "text", text: "No journal entries found." }],
          }
        }

        const text = filtered
          .map((m) => {
            const meta = [
              m.agent || "unknown agent",
              m.session ? `session: ${m.session}` : null,
              m.updatedAt.split("T")[0],
            ]
              .filter(Boolean)
              .join(" | ")

            return `### ${m.title}\n*${meta}*\n\n${m.content || "(content not loaded)"}`
          })
          .join("\n\n---\n\n")

        return {
          content: [
            {
              type: "text",
              text: `${filtered.length} journal entries:\n\n${text}`,
            },
          ],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )
}
