import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { toolError } from "../helpers.js"
import { dateBucket, loadWakeUpData } from "../../core/wakeup.js"
import { displayValue, renderFact, resolveReferencedTitles } from "../render.js"

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
          .describe(
            "Max memories per section (default 10 recent / 5 related; recent is trimmed when a fresh digest is surfaced). Acts as a per-section cap across both the recent-memories and related-to-open-loops sections so callers can bound total prompt size.",
          ),
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

        // The shared wake-up bundle loads the digest, recent memories,
        // partitioned facts, proposed + overdue decisions, and related
        // memories seeded from open-loop entities. All in one helper so the
        // hook and MCP surfaces stay aligned.
        const {
          digest,
          memories,
          openLoops,
          knowledgeFacts,
          proposedDecisions,
          overdueDecisions,
          relatedMemories,
        } = await loadWakeUpData(services, {
          projectId: projectId ?? undefined,
          memoryLimit: limit,
          // Honor the caller's explicit limit even when a digest is present:
          // the trim is a default, not a cap the user can't override.
          memoryLimitWithDigest: limit,
          // Apply the same cap to related memories so `limit` genuinely
          // bounds the per-section memory count — otherwise a caller asking
          // for `limit: 1` could still receive up to 5 related entries.
          relatedMemoryLimit: limit,
        })

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

        if (relatedMemories.length > 0) {
          sections.push("## Related to Open Loops\n")
          sections.push(
            "*Memories surfaced by a relevance query seeded from your open-loop entities. Deduped against the digest and Recent Memories above, so these are the *next* most relevant pages the recents didn't already cover.*\n",
          )
          for (const mem of relatedMemories) {
            const meta = [
              mem.source,
              mem.kind !== "note" ? mem.kind : null,
              mem.tags.length > 0 ? mem.tags.join(", ") : null,
              mem.updatedAt.split("T")[0],
            ]
              .filter(Boolean)
              .join(" | ")
            sections.push(`### ${mem.title}`, `*${meta}*\n`, mem.content || "(no content loaded)", "")
          }
        }

        // Decisions that need attention — proposed awaiting decision, or
        // overdue for review. Surfaces the subset of decisions an agent
        // should consider before acting.
        if (proposedDecisions.length > 0 || overdueDecisions.length > 0) {
          const today = new Date().toISOString().split("T")[0]
          sections.push("## Decisions Requiring Attention\n")
          if (proposedDecisions.length > 0) {
            sections.push(`### Proposed (${proposedDecisions.length})\n`)
            for (const d of proposedDecisions) {
              sections.push(
                `- **${d.title}** — proposed${d.decidedAt ? ` ${d.decidedAt}` : ""} | ID: ${d.id}`
              )
            }
            sections.push("")
          }
          if (overdueDecisions.length > 0) {
            sections.push(`### Overdue for Review (${overdueDecisions.length})\n`)
            for (const d of overdueDecisions) {
              const days = d.reviewBy
                ? Math.floor(
                    (new Date(today).getTime() - new Date(d.reviewBy).getTime()) /
                      86_400_000
                  )
                : 0
              sections.push(
                `- **${d.title}** [${d.status}] — review by ${d.reviewBy ?? "?"} (${days} day${days === 1 ? "" : "s"} overdue) | ID: ${d.id}`
              )
            }
            sections.push("")
          }
        }

        // Resolve every UUID referenced by an open-loop or active fact
        // in one batched fan-out so the two sections share a single
        // network round-trip per unique page ID. `displayValue` (Open
        // Loops' arrow format) and `renderFact` (Active Facts' flat
        // format) both read from the same map.
        const factTitleMap = await resolveReferencedTitles(
          [...openLoops, ...knowledgeFacts],
          services,
        )

        if (openLoops.length > 0) {
          const today = new Date().toISOString().split("T")[0]
          sections.push("## Open Loops\n")
          for (const fact of openLoops) {
            const since = fact.validFrom ? ` (since ${fact.validFrom})` : ""
            const overdue = fact.reviewBy && fact.reviewBy <= today ? " **(OVERDUE)**" : ""
            const subject = displayValue(fact.subject, factTitleMap)
            const object = displayValue(fact.object, factTitleMap)
            sections.push(
              `- **${subject}** \u2192 ${fact.predicate.replace(/_/g, " ")} \u2192 **${object}** [${fact.confidence}]${since}${overdue}`
            )
          }
          sections.push("")
        }

        if (knowledgeFacts.length > 0) {
          sections.push("## Active Facts\n")
          for (const fact of knowledgeFacts) {
            sections.push(
              renderFact(fact, {
                titleMap: factTitleMap,
                trailing: `(${fact.confidence})`,
              }),
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
