import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { toolError } from "../helpers.js"

export function registerContextTools(server: McpServer, services: LoreServices): void {
  // -------------------------------------------------------------------------
  // lore-status
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-status",
    {
      title: "Vault status",
      description:
        "Show the current vault status including database counts, active project context, and configuration summary.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const stats = await services.vault.stats()
        const project = services.context.project

        const lines = [
          `Vault: ${services.context.vault.pageId}`,
          `Current project: ${project ? `${project.name} (${project.path || "no path"})` : "none (vault-wide scope)"}`,
          "",
          "Database counts:",
          `  Projects: ${stats.projects}`,
          `  Topics:   ${stats.topics}`,
          `  Memories: ${stats.memories}`,
          `  Facts:    ${stats.facts}`,
        ]

        if (services.config.projects?.length) {
          lines.push("", "Configured projects:")
          for (const p of services.config.projects) {
            lines.push(`  - ${p.name} (${p.path})`)
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] }
      } catch (err) {
        return toolError(err)
      }
    }
  )

  // -------------------------------------------------------------------------
  // lore-wake-up
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-wake-up",
    {
      title: "Load session context",
      description:
        "Load relevant context for the current session. Returns recent memories and active facts for the current project plus any repo-wide (unscoped) entries. Call this at the start of a conversation to prime context.",
      inputSchema: {
        projectName: z
          .string()
          .optional()
          .describe("Override the auto-detected project. Use a project name."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max memories to return (default 10)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ projectName, limit }) => {
      try {
        let projectId = services.context.project?.id

        if (projectName) {
          const found = await services.projects.findByName(projectName)
          if (found) projectId = found.id
        }

        const [memories, facts] = await Promise.all([
          services.memories.list({
            projectId: projectId ?? undefined,
            limit: limit ?? 10,
          }),
          projectId
            ? services.facts.queryBySubject("", { projectId })
            : Promise.resolve([]),
        ])

        const sections: string[] = []

        if (services.context.project) {
          sections.push(
            `Project: ${services.context.project.name} (${services.context.project.path || "root"})\n`
          )
        }

        if (memories.length > 0) {
          sections.push("## Recent Memories\n")
          for (const mem of memories) {
            sections.push(
              `### ${mem.title}`,
              `*${mem.source} | ${mem.tags.length > 0 ? mem.tags.join(", ") : "no tags"} | ${mem.updatedAt.split("T")[0]}*\n`,
              mem.content || "(no content loaded)",
              ""
            )
          }
        } else {
          sections.push("No memories found for this context.\n")
        }

        if (facts.length > 0) {
          sections.push("## Active Facts\n")
          for (const fact of facts) {
            sections.push(
              `- **${fact.subject}** ${fact.predicate.replace(/_/g, " ")} **${fact.object}** (${fact.confidence})`
            )
          }
        }

        return { content: [{ type: "text", text: sections.join("\n") }] }
      } catch (err) {
        return toolError(err)
      }
    }
  )
}
