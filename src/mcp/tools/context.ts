import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { toolError } from "../helpers.js"
import {
  DEFAULT_WAKEUP_MEMORY_LIMIT,
  DEFAULT_WAKEUP_RELATED_MEMORY_LIMIT,
  dateBucket,
  loadWakeUpData,
} from "../../core/wakeup.js"
import type { Memory } from "../../types.js"
import {
  type CollapsedMemoryGroup,
  collapseOverlappingMemories,
  displayValue,
  renderFact,
  resolveReferencedTitles,
} from "../render.js"

/**
 * Multiplier applied to each memory-section cap when we over-fetch to
 * leave room for topical collapse. Without this, collapse would *shrink*
 * the visible section (10 memories, 3 collapse into 1 cluster → agent
 * sees 8 rows instead of 10). With it we fetch 3× the cap, collapse,
 * and then slice by cluster count so `limit` bounds the number of
 * distinct topics the agent sees — which is the intent. Three is the
 * smallest multiple that absorbs realistic dedup rates on the Mail
 * vault (observed 3× duplication on hot debugging sessions) without
 * over-stuffing the body-off payload, and the tracking/knowledge fact
 * queries are unaffected.
 */
const COLLAPSE_OVERFETCH_MULTIPLIER = 3

/**
 * Render one memory entry for wake-up output. Shared between the
 * Recent and Related sections so both share the same collapse trailer
 * format (`(related: <uuid>, <uuid>)`) and the same body-rendering
 * discipline (bodies only when the caller opted into `expand: true`).
 *
 * `headingLevel` is the markdown heading depth (number of leading `#`).
 * Recent Memories sits under date-bucket `###` sub-heads, so entries
 * use `####`; Related to Open Loops has no intermediate heading, so
 * entries stay at `###` to keep the tree balanced. The date field uses
 * `createdAt` for both sections — wake-up prioritizes when a memory
 * was captured over when it was last re-edited.
 *
 * The collapse trailer emits full Notion page UUIDs so an agent can
 * `lore-recall` / `lore-get-decision` the collapsed peers directly —
 * the spec treats the representative as "enough signal" but an agent
 * that wants the peer's body must have an actionable ID, not a
 * truncated hint.
 */
function renderMemoryEntry(
  mem: Memory,
  group: CollapsedMemoryGroup | undefined,
  expand: boolean,
  headingLevel: 3 | 4,
): string[] {
  const tagPart = mem.tags.length > 0 ? mem.tags.join(", ") : "no tags"
  const date = mem.createdAt.split("T")[0]
  const heading = "#".repeat(headingLevel)
  const lines: string[] = [`${heading} ${mem.title}`, `*${mem.source} | ${tagPart} | ${date}*`]
  if (group && group.collapsedIds.length > 0) {
    lines.push(`(related: ${group.collapsedIds.join(", ")})`)
  }
  lines.push("")
  // In the title-only default path, we intentionally skip body rendering
  // — the header + metadata are the payload. When `expand: true` the
  // caller opted into bodies and we stitch the markdown inline, after
  // the metadata + collapse trailer so the trailer reads as a header
  // annotation rather than a body footnote. Collapsed peers' bodies
  // stay suppressed even in expand mode — the representative is the
  // signal; agents that want a peer's body call `lore-recall` with
  // its ID from the trailer.
  if (expand && mem.content) {
    lines.push(mem.content, "")
  }
  return lines
}

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
        "Load relevant context for the current session. When a recent project digest exists it is surfaced first, followed by a trimmed list of recent memories, open loops, and active facts. Call this at the start of a conversation to prime context.\n\n" +
        "Returns title-tier entries by default — each memory renders with metadata (source, tags, date) but no markdown body. Pass `expand: true` when you need bodies inline; otherwise fetch the few bodies you actually want via `lore-recall` / `lore-get-decision`. The digest memory always keeps its body because the digest IS the content.\n\n" +
        "Overlapping memories (near-duplicate title tokens or tag overlap) collapse into a single row with a `(related: <uuid>, <uuid>)` trailer listing the full Notion IDs of the suppressed peers — pass any trailer ID to `lore-recall` or `lore-get-decision` to fetch the peer's body. Even when `expand: true`, collapsed peers' bodies stay suppressed; only the representative renders with its body. `limit` caps the number of distinct clusters rendered, not the raw memory count: wake-up over-fetches and slices after collapse so the visible section size is stable.",
      inputSchema: {
        projectName: z
          .string()
          .optional()
          .describe("Override the auto-detected project. Use a project name."),
        expand: z
          .boolean()
          .optional()
          .describe(
            "Include each recent/related memory's markdown body (default false). Each body costs one extra Notion round-trip, so leave this off for ambient session priming and flip it on only when the caller genuinely needs bodies inline. Digest bodies render regardless.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(
            "Max distinct clusters per memory section (default 10 recent / 5 related; recent is trimmed when a fresh digest is surfaced). Applies AFTER topical collapse — so `limit: 10` means 10 visible clusters, not 10 raw rows. Acts as a per-section cap across both the recent-memories and related-to-open-loops sections so callers can bound total prompt size.",
          ),
        openLoopLimit: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe(
            "Max open-loop facts to surface (default: all tracking-predicate facts up to one Notion page). Set 0 to skip the section entirely — which also skips the related-memory seeding that feeds off open-loop entities.",
          ),
        knowledgeFactLimit: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe(
            "Max active-facts rendered (non-tracking predicates, default 25). Set 0 to skip the section entirely.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ projectName, expand, limit, openLoopLimit, knowledgeFactLimit }) => {
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
        //
        // Memory sections over-fetch so `limit` bounds the number of
        // visible *clusters* after collapse, not raw rows. Without
        // over-fetching, a cluster of 3 duplicates would shrink a 10-row
        // section to 8 — paying the collapse cost with no prompt-size
        // benefit. The hook path doesn't apply collapse, so this
        // multiplier stays at the tool layer, not the data layer.
        const includeContent = expand === true
        const recentCap = limit ?? DEFAULT_WAKEUP_MEMORY_LIMIT
        const relatedCap = limit ?? DEFAULT_WAKEUP_RELATED_MEMORY_LIMIT
        const recentOverfetch = recentCap * COLLAPSE_OVERFETCH_MULTIPLIER
        const relatedOverfetch = relatedCap * COLLAPSE_OVERFETCH_MULTIPLIER
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
          memoryLimit: recentOverfetch,
          // Honor the caller's explicit limit even when a digest is present:
          // the trim is a default, not a cap the user can't override. Still
          // over-fetched so collapse has headroom.
          memoryLimitWithDigest: recentOverfetch,
          // Apply the over-fetched related cap too so `limit` bounds the
          // visible-cluster count in the Related section as well.
          relatedMemoryLimit: relatedOverfetch,
          openLoopLimit,
          knowledgeFactLimit,
          // Title-tier default: skip the N+1 markdown fetch unless the
          // caller explicitly opted into `expand: true`. The digest memory
          // is always fetched with content inside loadWakeUpData, since
          // the digest IS the content.
          includeMemoryContent: includeContent,
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
          // Topical dedup: collapse clusters of near-duplicate memories
          // (same debugging session retitled, same topic tagged twice)
          // so we render the newest representative with an IDs trailer
          // instead of N nearly-identical entries eating prompt budget.
          // Slice by cluster count AFTER collapse so `limit` bounds the
          // number of distinct topics shown, not the pre-collapse rows.
          const groups = collapseOverlappingMemories(memories).slice(0, recentCap)
          const groupsByKeepId = new Map(groups.map((g) => [g.keep.id, g]))
          // Group by date bucket
          const buckets = new Map<string, Memory[]>()
          for (const group of groups) {
            const bucket = dateBucket(group.keep.createdAt)
            if (!buckets.has(bucket)) buckets.set(bucket, [])
            buckets.get(bucket)!.push(group.keep)
          }
          for (const label of ["Today", "Yesterday", "Earlier"] as const) {
            const mems = buckets.get(label)
            if (!mems) continue
            sections.push(`### ${label}\n`)
            for (const mem of mems) {
              const group = groupsByKeepId.get(mem.id)
              sections.push(...renderMemoryEntry(mem, group, includeContent, 4))
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
          const groups = collapseOverlappingMemories(relatedMemories).slice(0, relatedCap)
          for (const group of groups) {
            sections.push(...renderMemoryEntry(group.keep, group, includeContent, 3))
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
