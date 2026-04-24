import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { toolError } from "../helpers.js"
import { gatherDigestData } from "../../core/digest.js"

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
            warnings.push(
              `Project "${projectName}" not found — falling back to auto-detected project.`,
            )
          }
        }

        const digest = await gatherDigestData(services, {
          projectId,
          projectLabel,
          since,
          until,
          period,
        })

        const parts: string[] = [digest.raw]
        if (warnings.length > 0) {
          parts.push(`## Warnings\n${warnings.join("\n")}`, "")
        }
        parts.push(
          "---\n" +
            "To save this digest, synthesize the above into a concise summary and call " +
            '`lore-remember` with source "digest".',
        )

        return { content: [{ type: "text", text: parts.join("\n") }] }
      } catch (err) {
        return toolError(err)
      }
    },
  )
}
