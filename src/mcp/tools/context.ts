import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { toolError } from "../helpers.js"
import { dateBucket, loadWakeUpData } from "../../core/wakeup.js"

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
        "Load relevant context for the current session. When a recent project digest exists it is surfaced first, followed by a trimmed list of recent memories, open loops, and active facts. Call this at the start of a conversation to prime context.",
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
          .describe("Max memories to return (default 10; trimmed when a fresh digest is surfaced)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ projectName, limit }) => {
      try {
        let projectId = services.context.project?.id
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

        const { digest, memories, openLoops, knowledgeFacts } = await loadWakeUpData(
          services,
          {
            projectId: projectId ?? undefined,
            memoryLimit: limit,
            // Honor the caller's explicit limit even when a digest is present:
            // the trim is a default, not a cap the user can't override.
            memoryLimitWithDigest: limit,
          },
        )

        const sections: string[] = []

        if (services.context.project) {
          sections.push(
            `Project: ${services.context.project.name} (${services.context.project.path || "root"})\n`
          )
        }

        if (warnings.length > 0) {
          sections.push(`> ${warnings.join("\n> ")}\n`)
        }

        if (digest) {
          sections.push(`## Latest Digest — ${digest.createdAt.split("T")[0]}\n`)
          sections.push(`**${digest.title}**\n`)
          if (digest.content) {
            sections.push(digest.content.trim(), "")
          }
        }

        if (memories.length > 0) {
          const heading = digest
            ? "## Recent Memories (since digest)\n"
            : "## Recent Memories\n"
          sections.push(heading)
          // Group by date bucket
          const buckets = new Map<string, typeof memories>()
          for (const mem of memories) {
            const bucket = dateBucket(mem.createdAt)
            if (!buckets.has(bucket)) buckets.set(bucket, [])
            buckets.get(bucket)!.push(mem)
          }
          for (const label of ["Today", "Yesterday", "Earlier"] as const) {
            const mems = buckets.get(label)
            if (!mems) continue
            sections.push(`### ${label}\n`)
            for (const mem of mems) {
              sections.push(
                `#### ${mem.title}`,
                `*${mem.source} | ${mem.tags.length > 0 ? mem.tags.join(", ") : "no tags"} | ${mem.createdAt.split("T")[0]}*\n`,
                mem.content || "(no content loaded)",
                ""
              )
            }
          }
        } else if (!digest) {
          sections.push("No memories found for this context.\n")
        }

        if (openLoops.length > 0) {
          const today = new Date().toISOString().split("T")[0]
          sections.push("## Open Loops\n")
          for (const fact of openLoops) {
            const since = fact.validFrom ? ` (since ${fact.validFrom})` : ""
            const overdue = fact.reviewBy && fact.reviewBy <= today ? " **(OVERDUE)**" : ""
            sections.push(
              `- **${fact.subject}** \u2192 ${fact.predicate.replace(/_/g, " ")} \u2192 **${fact.object}** [${fact.confidence}]${since}${overdue}`
            )
          }
          sections.push("")
        }

        if (knowledgeFacts.length > 0) {
          sections.push("## Active Facts\n")
          for (const fact of knowledgeFacts) {
            sections.push(
              `- **${fact.subject}** ${fact.predicate.replace(/_/g, " ")} **${fact.object}** (${fact.confidence})`
            )
          }
        }

        return { content: [{ type: "text", text: sections.join("\n") }] }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return toolError(new Error(`lore-wake-up failed to load context: ${message}`))
      }
    }
  )
}
