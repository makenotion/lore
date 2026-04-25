import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { formatDispatchError, toolError } from "../helpers.js"
import {
  DEFAULT_WAKEUP_KNOWLEDGE_FACT_LIMIT,
  DEFAULT_WAKEUP_MEMORY_LIMIT,
  DEFAULT_WAKEUP_OPEN_LOOP_LIMIT,
  DEFAULT_WAKEUP_RELATED_MEMORY_LIMIT,
  DEFAULT_WAKEUP_TASK_LIMIT,
  DEFAULT_WAKEUP_TASK_MEMORY_LIMIT,
  RANKED_WAKEUP_LIMITS,
  dateBucket,
  loadWakeUpData,
} from "../../core/wakeup.js"
import { gatherDigestData } from "../../core/digest.js"
import { taskDaysOverdue } from "../../core/task.js"
import type { Memory } from "../../types.js"
import {
  type CollapsedMemoryGroup,
  collapseOverlappingMemories,
  displayValue,
  renderFact,
  resolveReferencedTitles,
} from "../render.js"

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

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

// -------------------------------------------------------------------------
// Handlers — extracted so both the polymorphic `lore-context` tool and the
// legacy `lore-status` / `lore-wake-up` / `lore-digest` aliases share one
// implementation per action.
// -------------------------------------------------------------------------

async function handleStatus(services: LoreServices): Promise<ToolResult> {
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

async function handleWakeUp(
  services: LoreServices,
  args: {
    projectName?: string
    expand?: boolean
    limit?: number
    openLoopLimit?: number
    knowledgeFactLimit?: number
    taskLimit?: number
    userQuery?: string
    taskMemoryLimit?: number
  },
): Promise<ToolResult> {
  try {
    let projectId = services.context.project?.id
    const warnings: string[] = []

    if (args.projectName) {
      const found = await services.projects.findByName(args.projectName)
      if (found) {
        projectId = found.id
      } else {
        warnings.push(
          `Project "${args.projectName}" not found — falling back to auto-detected project.`,
        )
      }
    }

    const includeContent = args.expand === true
    // PF3-04: when `userQuery` is set the MCP surface mirrors the shell
    // hook's `RANKED_WAKEUP_LIMITS` for the per-section defaults, so the
    // prompt-budget contract for ranked wake-up is identical regardless of
    // which surface fired. An explicit caller-supplied cap still wins —
    // these defaults only apply when the corresponding arg is absent.
    const ranked = typeof args.userQuery === "string" && args.userQuery.trim().length > 0
    const recentDefault = ranked
      ? RANKED_WAKEUP_LIMITS.memoryLimit
      : DEFAULT_WAKEUP_MEMORY_LIMIT
    const relatedDefault = ranked
      ? RANKED_WAKEUP_LIMITS.relatedMemoryLimit
      : DEFAULT_WAKEUP_RELATED_MEMORY_LIMIT
    const recentCap = args.limit ?? recentDefault
    const relatedCap = args.limit ?? relatedDefault
    const recentOverfetch = recentCap * COLLAPSE_OVERFETCH_MULTIPLIER
    const relatedOverfetch = relatedCap * COLLAPSE_OVERFETCH_MULTIPLIER
    // Task-memory section: relevance hits seeded by `userQuery`. Routes
    // through the same `ranked ? RANKED : DEFAULT` ternary as the other
    // sections so a future tightening of `RANKED_WAKEUP_LIMITS.taskMemoryLimit`
    // doesn't silently desync the surfaces. Today the two constants are
    // equal by construction (3) — that equality is documented in
    // `RANKED_WAKEUP_LIMITS` itself — but mirroring the structure removes
    // the silent-divergence trap and makes the section's policy obvious
    // at the call site. Over-fetch by the collapse multiplier so the
    // visible-cluster slice has headroom — same discipline as Recent and
    // Related, since this section also runs through `collapseOverlappingMemories`.
    const taskCap =
      args.taskMemoryLimit ??
      (ranked ? RANKED_WAKEUP_LIMITS.taskMemoryLimit : DEFAULT_WAKEUP_TASK_MEMORY_LIMIT)
    const taskOverfetch = taskCap * COLLAPSE_OVERFETCH_MULTIPLIER
    // Open-loop and knowledge-fact sections don't run through topical
    // collapse, so the ranked defaults flow straight through to the data
    // layer without an over-fetch step. Caller-supplied values win as
    // before; absent values fall to the ranked cap when `userQuery` is
    // set, otherwise to the data-layer constants resolved here at the
    // call site rather than relying on `loadWakeUpData`'s internal `??`
    // defaulting. Self-contained resolution keeps the MCP call's policy
    // visible in this file — a future change to the data-layer defaulting
    // discipline (e.g. switching to required params) can't silently shift
    // the MCP path.
    const openLoopLimit =
      args.openLoopLimit ??
      (ranked ? RANKED_WAKEUP_LIMITS.openLoopLimit : DEFAULT_WAKEUP_OPEN_LOOP_LIMIT)
    const knowledgeFactLimit =
      args.knowledgeFactLimit ??
      (ranked ? RANKED_WAKEUP_LIMITS.knowledgeFactLimit : DEFAULT_WAKEUP_KNOWLEDGE_FACT_LIMIT)
    const {
      digest,
      memories,
      openLoops,
      knowledgeFacts,
      proposedDecisions,
      overdueDecisions,
      relatedMemories,
      tasks,
      taskMemories,
    } = await loadWakeUpData(services, {
      projectId: projectId ?? undefined,
      memoryLimit: recentOverfetch,
      memoryLimitWithDigest: recentOverfetch,
      relatedMemoryLimit: relatedOverfetch,
      openLoopLimit,
      knowledgeFactLimit,
      taskLimit: args.taskLimit,
      userQuery: args.userQuery,
      taskMemoryLimit: taskOverfetch,
      includeMemoryContent: includeContent,
    })

    const sections: string[] = []

    if (services.context.project) {
      sections.push(
        `Project: ${services.context.project.name} (${services.context.project.path || "root"})\n`,
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

    // P3-05: relevance hits seeded by the caller's `userQuery`. Surfaced
    // directly under the digest (densest single signal about what the
    // user is asking about) and above timestamp-ordered Recent Memories.
    // Section is omitted when no `userQuery` was passed so legacy callers
    // see byte-identical pre-P3-05 output. Runs through the same
    // collapse + cluster-slice as Recent / Related so a near-duplicate
    // task hit doesn't shrink the visible row count.
    if (taskMemories.length > 0) {
      sections.push("## For Your Current Task\n")
      sections.push(
        "*Memories ranked by relevance to your `userQuery`. Deduped against the digest, Recent Memories, and Related sections so the same page never renders twice.*\n",
      )
      const groups = collapseOverlappingMemories(taskMemories).slice(0, taskCap)
      for (const group of groups) {
        sections.push(...renderMemoryEntry(group.keep, group, includeContent, 3))
      }
    }

    if (memories.length > 0) {
      const heading = digest
        ? "## Recent Memories (since digest)\n"
        : "## Recent Memories\n"
      sections.push(heading)
      const groups = collapseOverlappingMemories(memories).slice(0, recentCap)
      const groupsByKeepId = new Map(groups.map((g) => [g.keep.id, g]))
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

    if (proposedDecisions.length > 0 || overdueDecisions.length > 0) {
      const today = new Date().toISOString().split("T")[0]
      sections.push("## Decisions Requiring Attention\n")
      if (proposedDecisions.length > 0) {
        sections.push(`### Proposed (${proposedDecisions.length})\n`)
        for (const d of proposedDecisions) {
          sections.push(
            `- **${d.title}** — proposed${d.decidedAt ? ` ${d.decidedAt}` : ""} | ID: ${d.id}`,
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
                  86_400_000,
              )
            : 0
          sections.push(
            `- **${d.title}** [${d.status}] — review by ${d.reviewBy ?? "?"} (${days} day${days === 1 ? "" : "s"} overdue) | ID: ${d.id}`,
          )
        }
        sections.push("")
      }
    }

    const factTitleMap = await resolveReferencedTitles(
      [...openLoops, ...knowledgeFacts],
      services,
    )

    if (tasks.length > 0) {
      const today = new Date().toISOString().split("T")[0]
      sections.push("## Tasks\n")
      for (const task of tasks) {
        const overdueDays = taskDaysOverdue(task, today)
        const stateLabel = task.taskState ?? "open"
        const blocker = task.blockedBy ? ` — blocked by ${task.blockedBy}` : ""
        const due =
          overdueDays !== null && task.reviewBy
            ? overdueDays === 0
              ? " **(due today)**"
              : ` **(${overdueDays} day${overdueDays === 1 ? "" : "s"} overdue — review by ${task.reviewBy})**`
            : task.reviewBy
              ? ` (due ${task.reviewBy})`
              : ""
        const prefix = overdueDays !== null ? "⚠ " : ""
        sections.push(
          `- ${prefix}**${task.title}** [${stateLabel}]${blocker}${due} | ID: ${task.id}`,
        )
      }
      sections.push("")
    }

    if (openLoops.length > 0) {
      const today = new Date().toISOString().split("T")[0]
      // Tracking facts are deprecated in favour of tasks; a vault
      // mid-migration may still surface them here. Header makes the
      // transitional status clear so an agent reading two sections
      // (Tasks + Open Loops) understands the relationship.
      sections.push(
        tasks.length > 0
          ? "## Open Loops (legacy facts — migrate via `lore migrate --migrate-tracking-to-tasks --yes`)\n"
          : "## Open Loops\n",
      )
      for (const fact of openLoops) {
        const since = fact.validFrom ? ` (since ${fact.validFrom})` : ""
        const overdue = fact.reviewBy && fact.reviewBy <= today ? " **(OVERDUE)**" : ""
        const subject = displayValue(fact.subject, factTitleMap)
        const object = displayValue(fact.object, factTitleMap)
        sections.push(
          `- **${subject}** → ${fact.predicate.replace(/_/g, " ")} → **${object}** [${fact.confidence}]${since}${overdue}`,
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

async function handleDigest(
  services: LoreServices,
  args: {
    period?: "day" | "week"
    since?: string
    until?: string
    projectName?: string
  },
): Promise<ToolResult> {
  try {
    let projectId = services.context.project?.id
    let projectLabel = services.context.project?.name ?? "vault-wide"

    const warnings: string[] = []

    if (args.projectName) {
      const found = await services.projects.findByName(args.projectName)
      if (found) {
        projectId = found.id
        projectLabel = found.name
      } else {
        warnings.push(
          `Project "${args.projectName}" not found — falling back to auto-detected project.`,
        )
      }
    }

    const digest = await gatherDigestData(services, {
      projectId,
      projectLabel,
      since: args.since,
      until: args.until,
      period: args.period,
    })

    const parts: string[] = [digest.raw]
    if (warnings.length > 0) {
      parts.push(`## Warnings\n${warnings.join("\n")}`, "")
    }
    parts.push(
      "---\n" +
        "To save this digest, synthesize the above into a concise summary and call " +
        '`lore-memory` with `action: "save"` and `source: "digest"` (or the deprecated ' +
        "`lore-remember` alias).",
    )

    return { content: [{ type: "text", text: parts.join("\n") }] }
  } catch (err) {
    return toolError(err)
  }
}

const contextDispatchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }),
  z.object({
    action: z.literal("wake-up"),
    projectName: z.string().optional(),
    expand: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
    openLoopLimit: z.number().int().min(0).max(50).optional(),
    knowledgeFactLimit: z.number().int().min(0).max(50).optional(),
    taskLimit: z.number().int().min(0).max(50).optional(),
    userQuery: z.string().optional(),
    taskMemoryLimit: z.number().int().min(0).max(20).optional(),
  }),
  z.object({
    action: z.literal("digest"),
    period: z.enum(["day", "week"]).optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    projectName: z.string().optional(),
  }),
])

export function registerContextTools(server: McpServer, services: LoreServices): void {
  // -------------------------------------------------------------------------
  // lore-context — polymorphic dispatcher (P3-01)
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-context",
    {
      title: "Vault context operations",
      description:
        "Vault status, session priming, and project digest in one polymorphic tool. Action-dispatched:\n\n" +
        "- `action: 'status'` — vault page id, database counts, active project, configured projects.\n" +
        "- `action: 'wake-up'` — load digest + (when `userQuery` is set) For-Your-Current-Task ranked memories + recent memories + tasks + open loops (legacy tracking facts) + active facts + decisions requiring attention. Title-tier rows by default; `expand: true` for bodies. Pass `userQuery` after `/clear` or a session-pivot so wake-up ranks pages by the user's actual question.\n" +
        "- `action: 'digest'` — gather raw activity data for synthesis into a digest memory. Save the synthesis via `lore-memory` action='save' with source='digest'.",
      inputSchema: {
        action: z
          .enum(["status", "wake-up", "digest"])
          .describe("Operation: 'status', 'wake-up' (session priming), or 'digest' (raw data)."),
        // wake-up + digest
        projectName: z
          .string()
          .optional()
          .describe("(action='wake-up' or 'digest') Override the auto-detected project."),
        // wake-up
        expand: z
          .boolean()
          .optional()
          .describe(
            "(action='wake-up') Include each memory's markdown body inline (default false). Each body costs one extra Notion round-trip.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(
            "(action='wake-up') Max distinct clusters per memory section after topical collapse.",
          ),
        openLoopLimit: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe(
            "(action='wake-up') Max open-loop facts. 0 skips the section (and the related-memory seed).",
          ),
        knowledgeFactLimit: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe("(action='wake-up') Max active-facts rendered (default 25). 0 skips."),
        taskLimit: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe(
            `(action='wake-up') Max tasks rendered in the Tasks section (default ${DEFAULT_WAKEUP_TASK_LIMIT}). 0 skips the section entirely.`,
          ),
        userQuery: z
          .string()
          .optional()
          .describe(
            "(action='wake-up') Optional short description of the user's current task. When set, fires an additional relevance search seeded by this text and surfaces the hits as a 'For Your Current Task' section above Recent Memories. Truncated to 1000 chars before search. Mirrors the shell hook's P3-05 ranked path, so MCP-direct callers (e.g. after `/clear` or a session pivot) get the same query-aware output.",
          ),
        taskMemoryLimit: z
          .number()
          .int()
          .min(0)
          .max(20)
          .optional()
          .describe(
            `(action='wake-up') Max memories surfaced for the user's current task (default ${DEFAULT_WAKEUP_TASK_MEMORY_LIMIT}). Honored only when 'userQuery' is non-empty. Set 0 to skip the section entirely even when a query is provided.`,
          ),
        // digest
        period: z
          .enum(["day", "week"])
          .optional()
          .describe(
            "(action='digest') Time window: 'day' (last 24h) or 'week' (last 7 days). Ignored if since/until provided.",
          ),
        since: z
          .string()
          .optional()
          .describe(
            "(action='digest') Custom start (ISO datetime, e.g. 2025-04-14T00:00:00Z). Overrides period.",
          ),
        until: z
          .string()
          .optional()
          .describe("(action='digest') Custom end (ISO datetime). Defaults to now."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const parsed = contextDispatchSchema.safeParse(args)
      if (!parsed.success) {
        return toolError(
          new Error(formatDispatchError("lore-context", parsed.error)),
        )
      }
      switch (parsed.data.action) {
        case "status":
          return handleStatus(services)
        case "wake-up":
          return handleWakeUp(services, parsed.data)
        case "digest":
          return handleDigest(services, parsed.data)
      }
    },
  )

  // -------------------------------------------------------------------------
  // Deprecated aliases — preserved for the one-release transition window
  // mandated by the stability rule in src/mcp/AGENTS.md. Schemas are
  // preserved so existing callers do not break; descriptions shrink to
  // redirect agents to the polymorphic tool.
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-status",
    {
      title: "Vault status",
      description: "Deprecated alias — prefer `lore-context` with `action: 'status'`.",
      annotations: { readOnlyHint: true },
    },
    async () => handleStatus(services),
  )

  server.registerTool(
    "lore-wake-up",
    {
      title: "Load session context",
      description: "Deprecated alias — prefer `lore-context` with `action: 'wake-up'`.",
      inputSchema: {
        projectName: z
          .string()
          .optional()
          .describe("Override the auto-detected project. Use a project name."),
        expand: z
          .boolean()
          .optional()
          .describe("Include each memory's markdown body inline (default false)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(
            "Max distinct clusters per memory section after topical collapse.",
          ),
        openLoopLimit: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe("Max open-loop facts; 0 skips the section."),
        knowledgeFactLimit: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe("Max active-facts rendered (default 25)."),
        taskLimit: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe(
            `Max tasks rendered in the Tasks section (default ${DEFAULT_WAKEUP_TASK_LIMIT}). 0 skips the section.`,
          ),
        userQuery: z
          .string()
          .optional()
          .describe(
            "Optional short description of the user's current task. When set, fires an additional relevance search seeded by this text and surfaces the hits as a 'For Your Current Task' section above Recent Memories. Truncated to 1000 chars before search. Mirrors the shell hook's P3-05 ranked path, so MCP-direct callers (e.g. after `/clear` or a session pivot) get the same query-aware output.",
          ),
        taskMemoryLimit: z
          .number()
          .int()
          .min(0)
          .max(20)
          .optional()
          .describe(
            "Max memories surfaced for the user's current task (default 3). Honored only when `userQuery` is non-empty. Set 0 to skip the section entirely even when a query is provided.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => handleWakeUp(services, args),
  )

  server.registerTool(
    "lore-digest",
    {
      title: "Gather project digest data",
      description: "Deprecated alias — prefer `lore-context` with `action: 'digest'`.",
      inputSchema: {
        period: z
          .enum(["day", "week"])
          .optional()
          .describe("Time window: day or week (ignored if since/until provided)."),
        since: z.string().optional().describe("Custom start (ISO datetime)."),
        until: z.string().optional().describe("Custom end (ISO datetime). Defaults to now."),
        projectName: z
          .string()
          .optional()
          .describe("Override the auto-detected project."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => handleDigest(services, args),
  )
}
