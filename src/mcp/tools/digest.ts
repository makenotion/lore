import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { toolError } from "../helpers.js"
import { TRACKING_PREDICATES } from "../../types.js"

export function registerDigestTools(server: McpServer, services: LoreServices): void {
  server.registerTool(
    "lore-digest",
    {
      title: "Gather project digest data",
      description:
        "Gather recent project activity for synthesis into a digest. Returns memories, " +
        "open loops, and new facts from the requested time window. The digest is a " +
        "project-scoped temporal summary — it captures what happened on the project, " +
        "not what a specific user did.\n\n" +
        "After reviewing the returned data, synthesize a summary and save it via " +
        'lore-remember with source "digest" and a descriptive title like ' +
        '"Digest — 2025-04-15".',
      inputSchema: {
        period: z
          .enum(["day", "week"])
          .optional()
          .describe('Time window: "day" (last 24h) or "week" (last 7 days). Ignored if since/until provided.'),
        since: z
          .string()
          .optional()
          .describe("Custom start (ISO datetime, e.g. 2025-04-14T00:00:00Z). Overrides period."),
        until: z
          .string()
          .optional()
          .describe("Custom end (ISO datetime). Defaults to now."),
        projectName: z
          .string()
          .optional()
          .describe("Override the auto-detected project."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ period, since, until, projectName }) => {
      try {
        let projectId = services.context.project?.id
        let projectLabel = services.context.project?.name ?? "vault-wide"

        const warnings: string[] = []

        if (projectName) {
          const found = await services.projects.findByName(projectName)
          if (found) {
            projectId = found.id
            projectLabel = found.name
          } else {
            warnings.push(`Project "${projectName}" not found — falling back to auto-detected project.`)
          }
        }

        // Compute time window
        const now = new Date()
        let windowStart: string
        const windowEnd: string = until ?? now.toISOString()

        if (since) {
          windowStart = since
        } else if (period === "week") {
          windowStart = new Date(now.getTime() - 7 * 86_400_000).toISOString()
        } else {
          // Default to "day"
          windowStart = new Date(now.getTime() - 86_400_000).toISOString()
        }

        // Gather data in parallel
        const [recentMemories, lastDigest, openLoops] = await Promise.all([
          services.memories.list({
            projectId: projectId ?? undefined,
            since: windowStart,
            until: windowEnd,
            limit: 50,
          }),
          services.memories.list({
            projectId: projectId ?? undefined,
            source: "digest",
            limit: 1,
          }),
          services.facts.queryBySubject("", {
            projectId: projectId ?? undefined,
            predicates: TRACKING_PREDICATES,
          }),
        ])

        // Group memories by source type
        const bySource = new Map<string, typeof recentMemories>()
        for (const mem of recentMemories) {
          const key = mem.source
          if (!bySource.has(key)) bySource.set(key, [])
          bySource.get(key)!.push(mem)
        }

        // Build output sections
        const sections: string[] = []

        sections.push(`# Digest Data — ${projectLabel}`)
        sections.push(`Window: ${windowStart.split("T")[0]} → ${windowEnd.split("T")[0]}`)
        sections.push("")

        // Last digest reference
        if (lastDigest.length > 0) {
          const ld = lastDigest[0]
          sections.push(`## Previous Digest`)
          sections.push(`**${ld.title}** (${ld.createdAt.split("T")[0]})`)
          sections.push("")
        }

        // Activity by source
        if (recentMemories.length > 0) {
          sections.push(`## Activity (${recentMemories.length} memories)`)
          for (const [source, mems] of bySource) {
            sections.push(`\n### ${source} (${mems.length})`)
            for (const mem of mems) {
              const tags = mem.tags.length > 0 ? ` [${mem.tags.join(", ")}]` : ""
              const date = mem.createdAt.split("T")[0]
              sections.push(`- **${mem.title}** (${date})${tags}`)
              if (mem.content) {
                // Truncate long content to keep digest data manageable
                const preview =
                  mem.content.length > 300
                    ? mem.content.slice(0, 300) + "..."
                    : mem.content
                sections.push(`  ${preview}`)
              }
            }
          }
          sections.push("")
        } else {
          sections.push("## Activity\nNo memories found in this window.\n")
        }

        // Open loops
        if (openLoops.length > 0) {
          sections.push(`## Open Loops (${openLoops.length})`)
          for (const fact of openLoops) {
            const since = fact.validFrom ? ` (since ${fact.validFrom})` : ""
            sections.push(
              `- **${fact.subject}** → ${fact.predicate.replace(/_/g, " ")} → **${fact.object}** [${fact.confidence}]${since}`
            )
          }
          sections.push("")
        }

        if (warnings.length > 0) {
          sections.push(`## Warnings\n${warnings.join("\n")}`)
          sections.push("")
        }

        sections.push(
          "---\n" +
          "To save this digest, synthesize the above into a concise summary and call " +
          '`lore-remember` with source "digest".'
        )

        return { content: [{ type: "text", text: sections.join("\n") }] }
      } catch (err) {
        return toolError(err)
      }
    }
  )
}
