import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { toolError } from "../helpers.js"

export function registerProjectTools(server: McpServer, services: LoreServices): void {
  // -------------------------------------------------------------------------
  // lore-list-projects
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-list-projects",
    {
      title: "List projects",
      description:
        "List all projects in the vault. Each project represents a codebase, " +
        "person, or agent with its own memories and topics.",
      inputSchema: {
        status: z
          .enum(["active", "archived"])
          .optional()
          .describe("Filter by status (default: all)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => {
      try {
        const projects = await services.projects.list(status)

        if (projects.length === 0) {
          return {
            content: [{ type: "text", text: "No projects found." }],
          }
        }

        const text = projects
          .map((p) => {
            const parts = [`**${p.name}**`]
            if (p.path) parts.push(`\`${p.path}\``)
            parts.push(`(${p.type}, ${p.status})`)
            if (p.description) parts.push(`— ${p.description}`)
            return `- ${parts.join(" ")}`
          })
          .join("\n")

        return {
          content: [
            {
              type: "text",
              text: `${projects.length} projects:\n\n${text}`,
            },
          ],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )

  // -------------------------------------------------------------------------
  // lore-get-project
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-get-project",
    {
      title: "Get project details",
      description:
        "Get detailed information about a project including its topics " +
        "and recent memory activity.",
      inputSchema: {
        name: z.string().describe("Project name"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => {
      try {
        const project = await services.projects.findByName(name)
        if (!project) {
          return {
            content: [{ type: "text", text: `Project "${name}" not found.` }],
            isError: true,
          }
        }

        const [topics, recentMemories] = await Promise.all([
          services.topics.listByProject(project.id),
          services.memories.list({ projectId: project.id, limit: 5 }),
        ])

        const sections = [
          `# ${project.name}`,
          `**Type:** ${project.type} | **Status:** ${project.status}`,
        ]

        if (project.path) sections.push(`**Path:** \`${project.path}\``)
        if (project.description) sections.push(`**Description:** ${project.description}`)

        if (topics.length > 0) {
          sections.push(
            "",
            `## Topics (${topics.length})`,
            ...topics.map(
              (t) => `- **${t.name}**${t.description ? ` — ${t.description}` : ""}`
            )
          )
        }

        if (recentMemories.length > 0) {
          sections.push(
            "",
            "## Recent Memories",
            ...recentMemories.map(
              (m) => `- **${m.title}** (${m.source}, ${m.updatedAt.split("T")[0]})`
            )
          )
        }

        return {
          content: [{ type: "text", text: sections.join("\n") }],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )
}
