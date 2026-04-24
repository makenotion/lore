import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { toolError, paginationFooter } from "../helpers.js"
import { resolveProjectIds } from "../resolve.js"
import type { MemoryKind, MemoryStatus, MemoryConfidence } from "../../types.js"

const KINDS = [
  "note",
  "decision",
  "incident",
  "runbook",
  "postmortem",
  "policy",
] as const

const STATUSES = [
  "informational",
  "proposed",
  "accepted",
  "superseded",
  "deprecated",
  "rejected",
] as const

const CONFIDENCES = ["certain", "likely", "speculative"] as const

const YMD_REGEX = /^\d{4}-\d{2}-\d{2}$/

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
        "If no project is specified, uses the auto-detected project from the current working directory.\n\n" +
        "For architectural decisions, prefer `lore-decide` — it captures structured rationale, supersession chains, and participates in `lore-audit` and `lore-wake-up`.",
      inputSchema: {
        title: z.string().describe("A short descriptive title for this memory"),
        content: z.string().describe("The full content to remember (markdown supported)"),
        projectName: z
          .string()
          .optional()
          .describe("Project name. Defaults to auto-detected project from cwd."),
        projectNames: z
          .array(z.string())
          .optional()
          .describe("Multiple project names for cross-project memories (e.g., a decision affecting Router and backend but not iOS)."),
        topicName: z
          .string()
          .optional()
          .describe(
            "Topic name within the project. Created automatically if it doesn't exist."
          ),
        source: z
          .enum(["conversation", "file", "manual", "agent_diary", "digest"])
          .optional()
          .describe("How this memory was captured (default: conversation)"),
        kind: z
          .enum(KINDS)
          .optional()
          .describe("Memory kind (default: note). Use `lore-decide` for decisions instead."),
        status: z
          .enum(STATUSES)
          .optional()
          .describe("Lifecycle state (default: informational). Applies mostly to runbooks/incidents."),
        confidence: z
          .enum(CONFIDENCES)
          .optional()
          .describe("Confidence level (default: certain)"),
        reviewBy: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("Date (YYYY-MM-DD) when this memory should be reviewed for staleness"),
        decidedAt: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("Canonical date (YYYY-MM-DD) this content was decided/captured"),
        tags: z.array(z.string()).optional().describe("Tags for categorization"),
        agent: z.string().optional().describe("Name of the AI agent saving this memory"),
        session: z.string().optional().describe("Session ID to group related memories"),
      },
    },
    async ({
      title,
      content,
      projectName,
      projectNames,
      topicName,
      source,
      kind,
      status,
      confidence,
      reviewBy,
      decidedAt,
      tags,
      agent,
      session,
    }) => {
      try {
        const resolved = await resolveProjectIds(services, projectName, projectNames)

        let topicId: string | undefined
        let topicLabel = "none"
        if (topicName && resolved.ids.length > 0) {
          const topic = await services.topics.getOrCreate(topicName, resolved.ids)
          topicId = topic.id
          topicLabel = topicName
        }

        const memory = await services.memories.create({
          title,
          content,
          projectIds: resolved.ids.length > 0 ? resolved.ids : undefined,
          topicId,
          source: source ?? "conversation",
          kind: kind as MemoryKind | undefined,
          status: status as MemoryStatus | undefined,
          confidence: confidence as MemoryConfidence | undefined,
          reviewBy,
          decidedAt,
          tags,
          agent,
          session,
        })

        const projectLabel = projectNames?.length
          ? projectNames.join(", ")
          : projectName ?? services.context.project?.name ?? "none (repo-wide)"

        const lines = [
          `Saved memory: "${memory.title}" (${memory.id})`,
          `Project: ${projectLabel}`,
          `Topic: ${topicLabel}`,
        ]
        if (resolved.warnings.length > 0) {
          lines.push(`Warnings: ${resolved.warnings.join("; ")}`)
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
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
        "search which includes vector similarity matching. Can be scoped to a specific project or topic.\n\n" +
        "`kind` and `status` are applied as post-filters on the search results because `client.search()` " +
        "does not support property filters — use `lore-recall` for server-side filtered listings.\n\n" +
        "Returns index-tier rows (title + metadata, no body) by default. Pass `includeContent: true` to " +
        "eagerly fetch bodies at the cost of one extra Notion round-trip per row.",
      inputSchema: {
        query: z.string().describe("Natural language search query"),
        projectName: z.string().optional().describe("Scope search to a specific project"),
        tags: z.array(z.string()).optional().describe("Filter by tags (matches any)"),
        kind: z
          .enum(KINDS)
          .optional()
          .describe("Post-filter by memory kind"),
        status: z
          .enum(STATUSES)
          .optional()
          .describe("Post-filter by lifecycle status"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results (default 10)"),
        includeContent: z
          .boolean()
          .optional()
          .describe(
            "Include each memory's markdown body (default false). Each body costs one extra Notion " +
              "round-trip, so leave this off for index-tier triage and flip it on only when you need bodies."
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, projectName, tags, kind, status, limit, includeContent }) => {
      try {
        let projectId: string | undefined
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
        if (!projectId && services.context.project) {
          projectId = services.context.project.id
        }

        const withContent = includeContent === true

        const searchResults = await services.memories.search({
          query,
          projectId,
          tags,
          // Over-fetch slightly so post-filters don't starve the output.
          limit: Math.min((limit ?? 10) * 2, 50),
          includeContent: withContent,
        })

        // Post-filter by kind/status since Notion's search API doesn't
        // support property filters. These are native typed properties on
        // each returned memory thanks to the extractor fallbacks.
        let results = searchResults
        if (kind) results = results.filter((m) => m.kind === kind)
        if (status) results = results.filter((m) => m.status === status)
        results = results.slice(0, limit ?? 10)

        const warn = warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No memories found for: "${query}"${warn}` }],
          }
        }

        const text = results
          .map((m) => {
            const meta = [
              m.source,
              m.kind !== "note" ? m.kind : null,
              m.status !== "informational" ? m.status : null,
              m.tags.length > 0 ? m.tags.join(", ") : null,
              m.updatedAt.split("T")[0],
            ]
              .filter(Boolean)
              .join(" | ")

            const body = withContent && m.content ? `\n\n${m.content}` : ""
            return `### ${m.title}\n*${meta}*${body}`
          })
          .join("\n\n---\n\n")

        const footer = withContent
          ? ""
          : `\n\n_Bodies omitted — re-call with \`includeContent: true\` to fetch them._`

        return {
          content: [
            {
              type: "text",
              text: `Found ${results.length} memories for "${query}":\n\n${text}${footer}${warn}`,
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
        "Get the most recent memories, optionally filtered by project, topic, source type, kind, or status. " +
        "Useful for catching up on what happened recently in a project. Filters are applied server-side via " +
        "`dataSources.query` — use `lore-search` for vector similarity matching.\n\n" +
        "Returns index-tier rows (title + metadata, no body) by default — one Notion round-trip per page. " +
        "Pass `includeContent: true` to eagerly fetch bodies at the cost of one extra round-trip per row.\n\n" +
        "Returns up to `limit` results per call. When more results exist, the response ends with a fenced " +
        "```json block `{\"nextCursor\":\"...\"}` — pass that value as `startCursor` on the next call to " +
        "continue enumerating. Absence of the footer means the final page.",
      inputSchema: {
        projectName: z.string().optional().describe("Filter by project name"),
        topicName: z.string().optional().describe("Filter by topic name"),
        source: z
          .enum(["conversation", "file", "manual", "agent_diary", "digest"])
          .optional()
          .describe("Filter by source type"),
        kind: z
          .enum(KINDS)
          .optional()
          .describe("Filter by memory kind (e.g., `decision`, `incident`, `runbook`)"),
        status: z
          .enum(STATUSES)
          .optional()
          .describe("Filter by lifecycle status"),
        reviewBefore: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("Only return memories with `Review By` on or before this date"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max results per page (default 10, max 100)"),
        startCursor: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Opaque cursor from a previous response's `nextCursor`. Pass to continue " +
              "enumerating from where the last page ended. Keep all other filters identical."
          ),
        includeContent: z
          .boolean()
          .optional()
          .describe(
            "Include each memory's markdown body (default false). Each body costs one extra Notion " +
              "round-trip, so leave this off for index-tier triage and flip it on only when you need bodies."
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({
      projectName,
      topicName,
      source,
      kind,
      status,
      reviewBefore,
      limit,
      startCursor,
      includeContent,
    }) => {
      try {
        let projectId: string | undefined
        let topicId: string | undefined

        if (projectName) {
          const found = await services.projects.findByName(projectName)
          if (!found) {
            return {
              content: [{ type: "text", text: `Project "${projectName}" not found.` }],
            }
          }
          projectId = found.id
        } else if (services.context.project) {
          projectId = services.context.project.id
        }

        // Resolve topicName globally. Topics can span multiple projects
        // (many-to-many Topic.Project), so scoping the lookup by projectId
        // silently drops the filter when the topic exists but isn't linked
        // to the current project — causing unfiltered fall-through.
        if (topicName) {
          const found = await services.topics.findByName(topicName)
          if (!found) {
            return {
              content: [{ type: "text", text: `No topic named "${topicName}" found.` }],
            }
          }
          topicId = found.id
        }

        const withContent = includeContent === true

        const { items: memories, nextCursor } = await services.memories.list({
          projectId,
          topicId,
          source,
          kind: kind as MemoryKind | undefined,
          status: status as MemoryStatus | undefined,
          reviewBefore,
          limit: limit ?? 10,
          includeContent: withContent,
          startCursor,
        })

        if (memories.length === 0) {
          // Server-side filters can yield an empty page mid-enumeration; we
          // must surface the cursor so callers don't stop early on a false
          // "end of results" signal.
          const header = nextCursor
            ? "No matching memories on this page."
            : "No recent memories found."
          return {
            content: [
              { type: "text", text: `${header}${paginationFooter(nextCursor)}` },
            ],
          }
        }

        const text = memories
          .map((m) => {
            const meta = [
              m.source,
              m.kind !== "note" ? m.kind : null,
              m.status !== "informational" ? m.status : null,
              m.updatedAt.split("T")[0],
            ]
              .filter(Boolean)
              .join(" | ")
            const body = withContent && m.content ? `\n\n${m.content}` : ""
            return `### ${m.title}\n*${meta}*${body}`
          })
          .join("\n\n---\n\n")

        const bodiesFooter = withContent
          ? ""
          : `\n\n_Bodies omitted — re-call with \`includeContent: true\` to fetch them._`

        return {
          content: [
            {
              type: "text",
              text: `${memories.length} recent memories:\n\n${text}${bodiesFooter}${paginationFooter(nextCursor)}`,
            },
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
      description:
        "Update an existing memory's title, content, tags, kind, status, or other metadata. " +
        "Any field not provided is left untouched.",
      inputSchema: {
        memoryId: z.string().describe("The memory ID to update"),
        title: z.string().optional().describe("New title"),
        content: z.string().optional().describe("New content (replaces existing)"),
        tags: z.array(z.string()).optional().describe("New tags (replaces existing)"),
        projectName: z.string().optional().describe("Move to a different project"),
        projectNames: z.array(z.string()).optional().describe("Set multiple project associations"),
        topicName: z.string().optional().describe("Move to a different topic"),
        kind: z.enum(KINDS).optional().describe("New memory kind"),
        status: z.enum(STATUSES).optional().describe("New lifecycle status"),
        confidence: z.enum(CONFIDENCES).optional().describe("New confidence level"),
        reviewBy: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("New review-by date (YYYY-MM-DD)"),
        decidedAt: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("New canonical decision date (YYYY-MM-DD)"),
        supersedesIds: z
          .array(z.string())
          .optional()
          .describe("Replace the Supersedes relation with these decision IDs"),
        affectsIds: z
          .array(z.string())
          .optional()
          .describe("Replace the Affects relation with these memory IDs"),
        alternatives: z
          .string()
          .optional()
          .describe("Alternatives text (replaces existing)"),
        consequences: z
          .string()
          .optional()
          .describe("Consequences text (replaces existing)"),
      },
    },
    async ({
      memoryId,
      title,
      content,
      tags,
      projectName,
      projectNames,
      topicName,
      kind,
      status,
      confidence,
      reviewBy,
      decidedAt,
      supersedesIds,
      affectsIds,
      alternatives,
      consequences,
    }) => {
      try {
        let projectIds: string[] | undefined
        let topicId: string | undefined
        let topicLabel: string | undefined
        const warnings: string[] = []

        if (projectNames?.length || projectName) {
          const resolved = await resolveProjectIds(services, projectName, projectNames)
          projectIds = resolved.ids.length > 0 ? resolved.ids : undefined
          warnings.push(...resolved.warnings)
        }
        if (topicName) {
          // Topics are scoped to projects. Prefer an explicit project from
          // this call; otherwise fall back to the memory's existing Project
          // relation so `lore-update({ memoryId, topicName })` works without
          // restating a project the memory is already in. Finally fall back
          // to the auto-detected context project.
          let topicScope = projectIds
          if (!topicScope || topicScope.length === 0) {
            const current = await services.memories.getById(memoryId)
            if (current.projectIds.length > 0) {
              topicScope = current.projectIds
            } else if (services.context.project) {
              topicScope = [services.context.project.id]
            }
          }
          if (!topicScope || topicScope.length === 0) {
            throw new Error(
              `Cannot set topicName="${topicName}": no project scope available. ` +
                `The memory has no Project relation and no project was passed or auto-detected. ` +
                `Pass projectName or projectNames.`
            )
          }
          const topic = await services.topics.getOrCreate(topicName, topicScope)
          topicId = topic.id
          topicLabel = topic.name
        }

        const updated = await services.memories.update(memoryId, {
          title,
          content,
          tags,
          projectIds,
          topicId,
          kind: kind as MemoryKind | undefined,
          status: status as MemoryStatus | undefined,
          confidence: confidence as MemoryConfidence | undefined,
          reviewBy,
          decidedAt,
          supersedesIds,
          affectsIds,
          alternatives,
          consequences,
        })

        const lines = [`Updated memory: "${updated.title}" (${updated.id})`]
        if (topicLabel) {
          lines.push(`Topic: ${topicLabel}`)
        }
        if (warnings.length > 0) {
          lines.push(`Warnings: ${warnings.join("; ")}`)
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )
}
