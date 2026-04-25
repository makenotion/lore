import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { formatDispatchError, toolError } from "../helpers.js"

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

// -------------------------------------------------------------------------
// Handlers — extracted so both the polymorphic `lore-project` tool and the
// deprecated `lore-list-projects` / `lore-get-project` aliases can share
// implementations.
// -------------------------------------------------------------------------

async function handleList(
  services: LoreServices,
  args: { status?: "active" | "archived" },
): Promise<ToolResult> {
  try {
    const projects = await services.projects.list(args.status)

    if (projects.length === 0) {
      return { content: [{ type: "text", text: "No projects found." }] }
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

async function handleGet(
  services: LoreServices,
  args: { name: string },
): Promise<ToolResult> {
  try {
    const project = await services.projects.findByName(args.name)
    if (!project) {
      return {
        content: [{ type: "text", text: `Project "${args.name}" not found.` }],
        isError: true,
      }
    }

    const [topics, { items: recentMemories }] = await Promise.all([
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

/**
 * Discriminated union for runtime validation of `lore-project` dispatch.
 * The MCP-level `inputSchema` is declared flat (every field optional) so
 * agents see one parameter table rather than a JSON Schema `oneOf`. We
 * re-validate against this union inside the handler so unsupported
 * action+param combinations surface as clean errors.
 */
const projectDispatchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    status: z.enum(["active", "archived"]).optional(),
  }),
  z.object({
    action: z.literal("get"),
    name: z.string(),
  }),
])

export function registerProjectTools(server: McpServer, services: LoreServices): void {
  // -------------------------------------------------------------------------
  // lore-project — polymorphic dispatcher (P3-01)
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-project",
    {
      title: "Project operations",
      description:
        "List projects or get details for one project. Action-dispatched:\n\n" +
        "- `action: 'list'` — list all projects (optionally filtered by `status`).\n" +
        "- `action: 'get'` — get details for a project by `name`, including topics and recent activity.",
      inputSchema: {
        action: z
          .enum(["list", "get"])
          .describe(
            "Operation to perform. 'list' enumerates projects; 'get' loads details for one.",
          ),
        status: z
          .enum(["active", "archived"])
          .optional()
          .describe("(action='list') Filter by status. Default: all."),
        name: z
          .string()
          .optional()
          .describe("(action='get') Project name. Required when action='get'."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const parsed = projectDispatchSchema.safeParse(args)
      if (!parsed.success) {
        return toolError(
          new Error(formatDispatchError("lore-project", parsed.error)),
        )
      }
      switch (parsed.data.action) {
        case "list":
          return handleList(services, parsed.data)
        case "get":
          return handleGet(services, parsed.data)
      }
    },
  )

  // -------------------------------------------------------------------------
  // Deprecated aliases — preserved for the one-release transition window
  // mandated by the stability rule in src/mcp/AGENTS.md. Schemas are kept
  // intact so existing callers do not break; descriptions are shortened
  // to redirect agents to the polymorphic tool.
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-list-projects",
    {
      title: "List projects",
      description: "Deprecated alias — prefer `lore-project` with `action: 'list'`.",
      inputSchema: {
        status: z
          .enum(["active", "archived"])
          .optional()
          .describe("Filter by status (default: all)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => handleList(services, { status }),
  )

  server.registerTool(
    "lore-get-project",
    {
      title: "Get project details",
      description: "Deprecated alias — prefer `lore-project` with `action: 'get'`.",
      inputSchema: {
        name: z.string().describe("Project name"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => handleGet(services, { name }),
  )
}
