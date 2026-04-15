import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { toolError } from "../helpers.js"

export function registerMemoryTools(server: McpServer, services: LoreServices): void {
  // -------------------------------------------------------------------------
  // lore-remember
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-remember",
    {
      title: "Save a memory",
      description:
        "Save a new memory to the vault. The memory content is stored verbatim as a Notion page. " +
        "If no project is specified, uses the auto-detected project from the current working directory.",
      inputSchema: {
        title: z.string().describe("A short descriptive title for this memory"),
        content: z.string().describe("The full content to remember (markdown supported)"),
        projectName: z
          .string()
          .optional()
          .describe("Project name. Defaults to auto-detected project."),
        topicName: z
          .string()
          .optional()
          .describe(
            "Topic name within the project. Created automatically if it doesn't exist."
          ),
        source: z
          .enum(["conversation", "file", "manual", "agent_diary"])
          .optional()
          .describe("How this memory was captured (default: conversation)"),
        tags: z.array(z.string()).optional().describe("Tags for categorization"),
        agent: z.string().optional().describe("Name of the AI agent saving this memory"),
        session: z.string().optional().describe("Session ID to group related memories"),
      },
    },
    async ({ title, content, projectName, topicName, source, tags, agent, session }) => {
      try {
        let projectId = services.context.project?.id

        if (projectName) {
          const found = await services.projects.findByName(projectName)
          if (found) projectId = found.id
        }

        let topicId: string | undefined
        if (topicName && projectId) {
          const topic = await services.topics.getOrCreate(topicName, projectId)
          topicId = topic.id
        }

        const memory = await services.memories.create({
          title,
          content,
          projectId,
          topicId,
          source: source ?? "conversation",
          tags,
          agent,
          session,
        })

        return {
          content: [
            {
              type: "text",
              text: `Saved memory: "${memory.title}" (${memory.id})\nProject: ${projectName ?? services.context.project?.name ?? "none"}\nTopic: ${topicName ?? "none"}`,
            },
          ],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )

  // -------------------------------------------------------------------------
  // lore-search
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-search",
    {
      title: "Search memories",
      description:
        "Semantic search across memories in the vault. Uses Notion's built-in " +
        "search which includes vector similarity matching. Can be scoped to a specific project or topic.",
      inputSchema: {
        query: z.string().describe("Natural language search query"),
        projectName: z.string().optional().describe("Scope search to a specific project"),
        tags: z.array(z.string()).optional().describe("Filter by tags (matches any)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results (default 10)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, projectName, tags, limit }) => {
      try {
        let projectId: string | undefined

        if (projectName) {
          const found = await services.projects.findByName(projectName)
          if (found) projectId = found.id
        } else if (services.context.project) {
          projectId = services.context.project.id
        }

        const results = await services.memories.search({
          query,
          projectId,
          tags,
          limit: limit ?? 10,
        })

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No memories found for: "${query}"` }],
          }
        }

        const text = results
          .map((m) => {
            const meta = [
              m.source,
              m.tags.length > 0 ? m.tags.join(", ") : null,
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
              text: `Found ${results.length} memories for "${query}":\n\n${text}`,
            },
          ],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )

  // -------------------------------------------------------------------------
  // lore-recall
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-recall",
    {
      title: "Recall recent memories",
      description:
        "Get the most recent memories, optionally filtered by project, topic, or source type. " +
        "Useful for catching up on what happened recently in a project.",
      inputSchema: {
        projectName: z.string().optional().describe("Filter by project name"),
        topicName: z.string().optional().describe("Filter by topic name"),
        source: z
          .enum(["conversation", "file", "manual", "agent_diary"])
          .optional()
          .describe("Filter by source type"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results (default 10)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ projectName, topicName, source, limit }) => {
      try {
        let projectId: string | undefined
        let topicId: string | undefined

        if (projectName) {
          const found = await services.projects.findByName(projectName)
          if (found) projectId = found.id
        } else if (services.context.project) {
          projectId = services.context.project.id
        }

        if (topicName && projectId) {
          const found = await services.topics.findByName(topicName, projectId)
          if (found) topicId = found.id
        }

        const memories = await services.memories.list({
          projectId,
          topicId,
          source,
          limit: limit ?? 10,
        })

        if (memories.length === 0) {
          return {
            content: [{ type: "text", text: "No recent memories found." }],
          }
        }

        const text = memories
          .map(
            (m) =>
              `### ${m.title}\n*${m.source} | ${m.updatedAt.split("T")[0]}*\n\n${m.content || "(content not loaded)"}`
          )
          .join("\n\n---\n\n")

        return {
          content: [
            { type: "text", text: `${memories.length} recent memories:\n\n${text}` },
          ],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )

  // -------------------------------------------------------------------------
  // lore-forget
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-forget",
    {
      title: "Archive a memory",
      description:
        "Archive a memory by ID. The memory is not deleted — it's marked as " +
        "archived in Notion and excluded from future searches.",
      inputSchema: {
        memoryId: z.string().describe("The memory ID to archive"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ memoryId }) => {
      try {
        await services.memories.archive(memoryId)
        return {
          content: [{ type: "text", text: `Archived memory ${memoryId}` }],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )

  // -------------------------------------------------------------------------
  // lore-update
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-update",
    {
      title: "Update a memory",
      description: "Update an existing memory's title, content, tags, or categorization.",
      inputSchema: {
        memoryId: z.string().describe("The memory ID to update"),
        title: z.string().optional().describe("New title"),
        content: z.string().optional().describe("New content (replaces existing)"),
        tags: z.array(z.string()).optional().describe("New tags (replaces existing)"),
        projectName: z.string().optional().describe("Move to a different project"),
        topicName: z.string().optional().describe("Move to a different topic"),
      },
    },
    async ({ memoryId, title, content, tags, projectName, topicName }) => {
      try {
        let projectId: string | undefined
        let topicId: string | undefined

        if (projectName) {
          const found = await services.projects.findByName(projectName)
          if (found) projectId = found.id
        }
        if (topicName && projectId) {
          const topic = await services.topics.getOrCreate(topicName, projectId)
          topicId = topic.id
        }

        const updated = await services.memories.update(memoryId, {
          title,
          content,
          tags,
          projectId,
          topicId,
        })

        return {
          content: [
            {
              type: "text",
              text: `Updated memory: "${updated.title}" (${updated.id})`,
            },
          ],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )
}
