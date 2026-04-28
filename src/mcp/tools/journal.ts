import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { formatDispatchError, paginationFooter, toolError } from "../helpers.js"
import { resolveProjectIds } from "../resolve.js"
import { tagsSchema, keywordsSchema } from "./tag-schema.js"

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

// One-shot stderr notice so human operators (who never see the tool
// description) notice the deprecation. Module-scoped so long-lived MCP
// servers don't spam the log even if `registerJournalTools` were ever
// called more than once.
let journalDeprecationWarned = false

async function handleWrite(
  services: LoreServices,
  args: {
    title: string
    content: string
    projectName?: string
    projectNames?: string[]
    agent?: string
    session?: string
    tags?: string[]
    keywords?: string
  },
): Promise<ToolResult> {
  try {
    if (!journalDeprecationWarned) {
      journalDeprecationWarned = true
      process.stderr.write(
        "[lore] lore-journal is deprecated — prefer `lore-memory` action='save' with kind: 'note' " +
          "(or `lore-decision` action='create' for architectural decisions). Tool remains " +
          "registered for backwards compatibility and will be removed in a future major version.\n",
      )
    }

    const resolved = await resolveProjectIds(services, args.projectName, args.projectNames)

    const memory = await services.memories.create({
      title: args.title,
      content: args.content,
      projectIds: resolved.ids.length > 0 ? resolved.ids : undefined,
      source: "agent_diary",
      agent: args.agent ?? "unknown",
      session: args.session,
      tags: args.tags,
      keywords: args.keywords,
    })

    const lines = [`Journal entry saved: "${memory.title}" (${memory.id})`]
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

async function handleRead(
  services: LoreServices,
  args: {
    agent?: string
    projectName?: string
    limit?: number
    startCursor?: string
  },
): Promise<ToolResult> {
  try {
    let projectId: string | undefined
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
    if (!projectId && services.context.project) {
      projectId = services.context.project.id
    }

    const { items: entries, nextCursor } = await services.memories.list({
      projectId,
      source: "agent_diary",
      limit: args.limit ?? 10,
      startCursor: args.startCursor,
    })

    // Filter by agent name if specified. Applied client-side after paging,
    // so an all-filtered-out page can still advance via `nextCursor`.
    let filtered = entries
    if (args.agent) {
      filtered = entries.filter((m) =>
        m.agent.toLowerCase().includes(args.agent!.toLowerCase()),
      )
    }

    const warn = warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""
    const footer = paginationFooter(nextCursor)

    if (filtered.length === 0) {
      const header = nextCursor
        ? "No matching journal entries on this page."
        : "No journal entries found."
      return {
        content: [{ type: "text", text: `${header}${warn}${footer}` }],
      }
    }

    const text = filtered
      .map((m) => {
        const meta = [
          m.agent || "unknown agent",
          m.session ? `session: ${m.session}` : null,
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
          text: `${filtered.length} journal entries:\n\n${text}${warn}${footer}`,
        },
      ],
    }
  } catch (err) {
    return toolError(err)
  }
}

const journalDispatchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("write"),
    title: z.string(),
    content: z.string(),
    projectName: z.string().optional(),
    projectNames: z.array(z.string()).optional(),
    agent: z.string().optional(),
    session: z.string().optional(),
    tags: tagsSchema.optional(),
    keywords: keywordsSchema.optional(),
  }),
  z.object({
    action: z.literal("read"),
    agent: z.string().optional(),
    projectName: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    startCursor: z.string().min(1).optional(),
  }),
])

export function registerJournalTools(server: McpServer, services: LoreServices): void {
  // -------------------------------------------------------------------------
  // lore-journal — polymorphic dispatcher (P3-01)
  //
  // Note: the entire journal tool surface is itself deprecated in favor of
  // `lore-memory` with `kind: 'note'` / `lore-decision action='create'` (see
  // the prior single-tool deprecation message on `lore-journal`). We still
  // consolidate write+read under a single polymorphic registration so the
  // overall tool count stays at the planned ~8.
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-journal",
    {
      title: "Agent diary entries",
      description:
        "DEPRECATED — prefer `lore-memory` with `action: 'save'` and `kind: 'note'` (or `lore-decision` with `action: 'create'` for architectural decisions). Session narration should not be saved at all.\n\n" +
        "Polymorphic dispatcher for legacy agent diary entries:\n" +
        "- `action: 'write'` — save a new diary entry (memory with `source: 'agent_diary'`).\n" +
        "- `action: 'read'` — list recent diary entries, optionally filtered by `agent` or `projectName`.",
      inputSchema: {
        // `lore-journal` is the only polymorphic tool where `action` is
        // `.optional()` at the MCP boundary, *deliberately*: the legacy
        // `lore-journal({title, content})` write-only call shape predates
        // P3-01 and would break under a hard `action` requirement. The
        // dispatcher (below) defaults a missing `action` to `"write"` so
        // existing callers keep succeeding. Every other polymorphic tool
        // requires `action` explicitly — do not pattern-match this
        // asymmetry into the others.
        action: z
          .enum(["write", "read"])
          .optional()
          .describe(
            "Operation: 'write' (default — preserves the legacy write-only call shape) or 'read'.",
          ),
        // write
        title: z
          .string()
          .optional()
          .describe("(action='write') Journal entry title. Required for write."),
        content: z
          .string()
          .optional()
          .describe("(action='write') Markdown body. Required for write."),
        // shared (write+read)
        projectName: z.string().optional().describe("Project filter or scope."),
        projectNames: z
          .array(z.string())
          .optional()
          .describe("(action='write') Multiple project associations."),
        agent: z
          .string()
          .optional()
          .describe(
            "(action='write') Agent name attribution. (action='read') Substring filter on agent name.",
          ),
        session: z
          .string()
          .optional()
          .describe("(action='write') Session identifier for grouping entries."),
        tags: tagsSchema
          .optional()
          .describe("(action='write') Closed-vocabulary tags."),
        keywords: keywordsSchema
          .optional()
          .describe("(action='write') Free-form labels."),
        // read
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("(action='read') Max entries per page (default 10)."),
        startCursor: z
          .string()
          .min(1)
          .optional()
          .describe("(action='read') Pagination cursor."),
      },
    },
    async (args) => {
      // Backwards-compatibility: the legacy `lore-journal` tool was
      // write-only — callers do `lore-journal({title, content})` with no
      // `action` field. Default to 'write' so those calls continue to
      // succeed during the deprecation window.
      const normalized =
        args && typeof args === "object" && (args as { action?: unknown }).action === undefined
          ? { ...(args as Record<string, unknown>), action: "write" }
          : args
      const parsed = journalDispatchSchema.safeParse(normalized)
      if (!parsed.success) {
        return toolError(
          new Error(formatDispatchError("lore-journal", parsed.error)),
        )
      }
      switch (parsed.data.action) {
        case "write":
          return handleWrite(services, parsed.data)
        case "read":
          return handleRead(services, parsed.data)
      }
    },
  )
}
