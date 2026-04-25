import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import {
  formatDispatchError,
  paginationFooter,
  toolError,
  debugLogPartialFailures,
} from "../helpers.js"
import { resolveProjectIds } from "../resolve.js"
import { settleAll } from "../../core/settle.js"
import type { Memory, MemoryKind, MemoryStatus, MemoryConfidence } from "../../types.js"
import { tagsSchema, keywordsSchema } from "./tag-schema.js"
import {
  findNearDuplicates,
  type NearDuplicateMatch,
} from "../../core/near-duplicate.js"

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

/**
 * Trigram threshold for the `lore-remember` near-duplicate probe. Matches
 * the P2-03 spec's initial guess — tune after rollout if we see false
 * positives flooding the response footer on legitimately-distinct
 * memories sharing boilerplate title wording.
 */
const MEMORY_NEAR_DUPLICATE_THRESHOLD = 0.7

/** Cap the probe candidate pool. See `findNearDuplicates` docstring. */
const NEAR_DUPLICATE_POOL_LIMIT = 50

/** Max candidates to surface in the response. */
const NEAR_DUPLICATE_SURFACE_LIMIT = 3

function formatNearDuplicateMatches(matches: NearDuplicateMatch[]): string[] {
  const lines: string[] = []
  const shown = matches.slice(0, NEAR_DUPLICATE_SURFACE_LIMIT)
  lines.push(
    `Warning: ${matches.length} existing ${matches.length === 1 ? "memory looks" : "memories look"} similar:`,
  )
  for (const m of shown) {
    const sim = m.titleSimilarity.toFixed(2)
    const tagPart = m.tagOverlap > 0 ? `, tag overlap ${m.tagOverlap.toFixed(2)}` : ""
    lines.push(`  - "${m.title}" (${m.id}) — trigram ${sim}${tagPart}`)
  }
  if (matches.length > shown.length) {
    lines.push(`  - …and ${matches.length - shown.length} more`)
  }
  lines.push(
    "Consider `lore-memory` with `action: 'update'` on the existing row, or `lore-decision` with `action: 'create'` and `supersedesIds` if this is a formal replacement.",
  )
  return lines
}

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

const SOURCES = ["conversation", "file", "manual", "agent_diary", "digest"] as const

const YMD_REGEX = /^\d{4}-\d{2}-\d{2}$/

const EXPAND_MAX_IDS = 20

// -------------------------------------------------------------------------
// Handlers — extracted so the polymorphic `lore-memory` tool and the
// deprecated `lore-remember` / `lore-update` / `lore-forget` / `lore-expand`
// aliases share single implementations.
// -------------------------------------------------------------------------

interface SaveArgs {
  title: string
  content: string
  projectName?: string
  projectNames?: string[]
  topicName?: string
  source?: (typeof SOURCES)[number]
  kind?: (typeof KINDS)[number]
  status?: (typeof STATUSES)[number]
  confidence?: (typeof CONFIDENCES)[number]
  reviewBy?: string
  decidedAt?: string
  tags?: string[]
  keywords?: string
  agent?: string
  session?: string
}

async function handleSave(services: LoreServices, args: SaveArgs): Promise<ToolResult> {
  try {
    const resolved = await resolveProjectIds(services, args.projectName, args.projectNames)

    let topicId: string | undefined
    let topicLabel = "none"
    if (args.topicName && resolved.ids.length > 0) {
      const topic = await services.topics.getOrCreate(args.topicName, resolved.ids)
      topicId = topic.id
      topicLabel = args.topicName
    }

    const probeProjectId = resolved.ids[0]
    const probePromise = probeProjectId
      ? findNearDuplicates(services.memories, {
          title: args.title,
          tags: args.tags ?? [],
          projectId: probeProjectId,
          excludeKinds: ["decision"],
          threshold: MEMORY_NEAR_DUPLICATE_THRESHOLD,
          limit: NEAR_DUPLICATE_POOL_LIMIT,
          onError: (err) =>
            debugLogPartialFailures("lore-remember", [
              { rootId: "near-duplicate-probe", error: err },
            ]),
        })
      : Promise.resolve([] as NearDuplicateMatch[])

    const [memory, nearDuplicates] = await Promise.all([
      services.memories.create({
        title: args.title,
        content: args.content,
        projectIds: resolved.ids.length > 0 ? resolved.ids : undefined,
        topicId,
        source: args.source ?? "conversation",
        kind: args.kind as MemoryKind | undefined,
        status: args.status as MemoryStatus | undefined,
        confidence: args.confidence as MemoryConfidence | undefined,
        reviewBy: args.reviewBy,
        decidedAt: args.decidedAt,
        tags: args.tags,
        keywords: args.keywords,
        agent: args.agent,
        session: args.session,
      }),
      probePromise,
    ])

    const matches = nearDuplicates.filter((m) => m.id !== memory.id)

    services.sessionMemories.record(
      { agent: args.agent, session: args.session },
      { memoryId: memory.id, projectIds: memory.projectIds },
    )

    const projectLabel = args.projectNames?.length
      ? args.projectNames.join(", ")
      : args.projectName ?? services.context.project?.name ?? "none (repo-wide)"

    const lines = [
      `Saved memory: "${memory.title}" (${memory.id})`,
      `Project: ${projectLabel}`,
      `Topic: ${topicLabel}`,
    ]
    if (resolved.warnings.length > 0) {
      lines.push(`Warnings: ${resolved.warnings.join("; ")}`)
    }
    if (matches.length > 0) {
      lines.push("", ...formatNearDuplicateMatches(matches))
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    }
  } catch (err) {
    return toolError(err)
  }
}

interface UpdateArgs {
  memoryId: string
  title?: string
  content?: string
  tags?: string[]
  keywords?: string
  projectName?: string
  projectNames?: string[]
  topicName?: string
  kind?: (typeof KINDS)[number]
  status?: (typeof STATUSES)[number]
  confidence?: (typeof CONFIDENCES)[number]
  reviewBy?: string
  decidedAt?: string
  supersedesIds?: string[]
  affectsIds?: string[]
  alternatives?: string
  consequences?: string
}

async function handleUpdate(services: LoreServices, args: UpdateArgs): Promise<ToolResult> {
  try {
    let projectIds: string[] | undefined
    let topicId: string | undefined
    let topicLabel: string | undefined
    const warnings: string[] = []

    if (args.projectNames?.length || args.projectName) {
      const resolved = await resolveProjectIds(services, args.projectName, args.projectNames)
      projectIds = resolved.ids.length > 0 ? resolved.ids : undefined
      warnings.push(...resolved.warnings)
    }
    if (args.topicName) {
      let topicScope = projectIds
      if (!topicScope || topicScope.length === 0) {
        const current = await services.memories.getById(args.memoryId)
        if (current.projectIds.length > 0) {
          topicScope = current.projectIds
        } else if (services.context.project) {
          topicScope = [services.context.project.id]
        }
      }
      if (!topicScope || topicScope.length === 0) {
        throw new Error(
          `Cannot set topicName="${args.topicName}": no project scope available. ` +
            `The memory has no Project relation and no project was passed or auto-detected. ` +
            `Pass projectName or projectNames.`,
        )
      }
      const topic = await services.topics.getOrCreate(args.topicName, topicScope)
      topicId = topic.id
      topicLabel = topic.name
    }

    const updated = await services.memories.update(args.memoryId, {
      title: args.title,
      content: args.content,
      tags: args.tags,
      keywords: args.keywords,
      projectIds,
      topicId,
      kind: args.kind as MemoryKind | undefined,
      status: args.status as MemoryStatus | undefined,
      confidence: args.confidence as MemoryConfidence | undefined,
      reviewBy: args.reviewBy,
      decidedAt: args.decidedAt,
      supersedesIds: args.supersedesIds,
      affectsIds: args.affectsIds,
      alternatives: args.alternatives,
      consequences: args.consequences,
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

async function handleArchive(
  services: LoreServices,
  args: { memoryId: string },
): Promise<ToolResult> {
  try {
    await services.memories.archive(args.memoryId)
    return {
      content: [{ type: "text", text: `Archived memory ${args.memoryId}` }],
    }
  } catch (err) {
    return toolError(err)
  }
}

export async function handleExpand(
  services: LoreServices,
  args: { ids: string[] },
): Promise<ToolResult> {
  try {
    const unique: string[] = []
    const seen = new Set<string>()
    for (const id of args.ids) {
      if (!seen.has(id)) {
        seen.add(id)
        unique.push(id)
      }
    }

    const { fulfilled, failures } = await settleAll(
      unique.map((id) => [id, services.memories.getById(id)] as const),
    )
    if (failures.length > 0) {
      debugLogPartialFailures(
        "lore-expand",
        failures.map(({ key, error }) => ({ rootId: key, error })),
      )
    }

    const bodies = new Map<string, Memory>()
    for (const [id, memory] of fulfilled) bodies.set(id, memory)
    const errors = new Map<string, unknown>()
    for (const { key, error } of failures) errors.set(key, error)

    const sections = unique.map((id) => {
      const memory = bodies.get(id)
      if (memory) return formatExpandedMemory(memory)
      const error = errors.get(id)
      const message = error instanceof Error ? error.message : String(error ?? "unknown error")
      return `### (unresolved: ${id})\n*${message}*`
    })

    const header =
      failures.length > 0
        ? `Expanded ${fulfilled.length}/${unique.length} memories (${failures.length} unresolved):`
        : `Expanded ${fulfilled.length} ${fulfilled.length === 1 ? "memory" : "memories"}:`

    return {
      content: [{ type: "text", text: `${header}\n\n${sections.join("\n\n---\n\n")}` }],
    }
  } catch (err) {
    return toolError(err)
  }
}

interface RecallArgs {
  projectName?: string
  topicName?: string
  source?: (typeof SOURCES)[number]
  kind?: (typeof KINDS)[number]
  status?: (typeof STATUSES)[number]
  reviewBefore?: string
  limit?: number
  startCursor?: string
  includeContent?: boolean
}

export async function handleRecall(
  services: LoreServices,
  args: RecallArgs,
): Promise<ToolResult> {
  try {
    let projectId: string | undefined
    let topicId: string | undefined

    if (args.projectName) {
      const found = await services.projects.findByName(args.projectName)
      if (!found) {
        return {
          content: [{ type: "text", text: `Project "${args.projectName}" not found.` }],
        }
      }
      projectId = found.id
    } else if (services.context.project) {
      projectId = services.context.project.id
    }

    if (args.topicName) {
      const found = await services.topics.findByName(args.topicName)
      if (!found) {
        return {
          content: [{ type: "text", text: `No topic named "${args.topicName}" found.` }],
        }
      }
      topicId = found.id
    }

    const withContent = args.includeContent === true

    const { items: memories, nextCursor } = await services.memories.list({
      projectId,
      topicId,
      source: args.source,
      kind: args.kind as MemoryKind | undefined,
      status: args.status as MemoryStatus | undefined,
      reviewBefore: args.reviewBefore,
      limit: args.limit ?? 10,
      includeContent: withContent,
      startCursor: args.startCursor,
    })

    if (memories.length === 0) {
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
          m.tags.length > 0 ? m.tags.join(", ") : null,
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

interface SearchArgs {
  query: string
  projectName?: string
  tags?: string[]
  kind?: (typeof KINDS)[number]
  status?: (typeof STATUSES)[number]
  limit?: number
  includeContent?: boolean
}

export async function handleSearch(
  services: LoreServices,
  args: SearchArgs,
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

    const withContent = args.includeContent === true

    const searchResults = await services.memories.search({
      query: args.query,
      projectId,
      tags: args.tags,
      limit: Math.min((args.limit ?? 10) * 2, 50),
      includeContent: withContent,
    })

    let results = searchResults
    if (args.kind) results = results.filter((m) => m.kind === args.kind)
    if (args.status) results = results.filter((m) => m.status === args.status)
    results = results.slice(0, args.limit ?? 10)

    const warn = warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""

    if (results.length === 0) {
      return {
        content: [{ type: "text", text: `No memories found for: "${args.query}"${warn}` }],
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
          text: `Found ${results.length} memories for "${args.query}":\n\n${text}${footer}${warn}`,
        },
      ],
    }
  } catch (err) {
    return toolError(err)
  }
}

const memoryDispatchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    title: z.string(),
    content: z.string(),
    projectName: z.string().optional(),
    projectNames: z.array(z.string()).optional(),
    topicName: z.string().optional(),
    source: z.enum(SOURCES).optional(),
    kind: z.enum(KINDS).optional(),
    status: z.enum(STATUSES).optional(),
    confidence: z.enum(CONFIDENCES).optional(),
    reviewBy: z.string().regex(YMD_REGEX).optional(),
    decidedAt: z.string().regex(YMD_REGEX).optional(),
    tags: tagsSchema.optional(),
    keywords: keywordsSchema.optional(),
    agent: z.string().optional(),
    session: z.string().optional(),
  }),
  z.object({
    action: z.literal("update"),
    memoryId: z.string(),
    title: z.string().optional(),
    content: z.string().optional(),
    tags: tagsSchema.optional(),
    keywords: keywordsSchema.optional(),
    projectName: z.string().optional(),
    projectNames: z.array(z.string()).optional(),
    topicName: z.string().optional(),
    kind: z.enum(KINDS).optional(),
    status: z.enum(STATUSES).optional(),
    confidence: z.enum(CONFIDENCES).optional(),
    reviewBy: z.string().regex(YMD_REGEX).optional(),
    decidedAt: z.string().regex(YMD_REGEX).optional(),
    supersedesIds: z.array(z.string()).optional(),
    affectsIds: z.array(z.string()).optional(),
    alternatives: z.string().optional(),
    consequences: z.string().optional(),
  }),
  z.object({
    action: z.literal("archive"),
    memoryId: z.string(),
  }),
  z.object({
    action: z.literal("expand"),
    ids: z.array(z.string().uuid()).min(1).max(EXPAND_MAX_IDS),
  }),
])

export function registerMemoryTools(server: McpServer, services: LoreServices): void {
  // -------------------------------------------------------------------------
  // lore-memory — polymorphic dispatcher (P3-01)
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-memory",
    {
      title: "Memory operations",
      description:
        "Save, update, archive, or batch-expand memories. Action-dispatched:\n\n" +
        "- `action: 'save'` — create a new memory page in the vault. Runs a near-duplicate probe in parallel.\n" +
        "- `action: 'update'` — mutate an existing memory's title, body, tags, kind, status, or relations. Any field omitted is left untouched.\n" +
        "- `action: 'archive'` — soft-delete a memory by ID (Notion archive flag).\n" +
        "- `action: 'expand'` — batch-fetch full markdown bodies for up to 20 IDs in one parallel call. Companion to the title-tier defaults on `lore-query` recall/search.\n\n" +
        "For architectural decisions prefer `lore-decision` with `action: 'create'` — it captures structured rationale and supersession chains.\n\n" +
        "`tags` is a closed vocabulary; for free-form labels (PR numbers, file paths, IDs) use `keywords`.",
      inputSchema: {
        action: z
          .enum(["save", "update", "archive", "expand"])
          .describe("Operation: save (create), update, archive, or expand (batch body fetch)."),
        // save
        title: z
          .string()
          .optional()
          .describe(
            "Required for action='save'; new title for action='update'. Short, descriptive.",
          ),
        content: z
          .string()
          .optional()
          .describe("Required for action='save'; new body (markdown) for action='update'."),
        // save | update | archive | expand
        memoryId: z
          .string()
          .optional()
          .describe(
            "Required for action='update' and action='archive'. The Notion page ID of the memory.",
          ),
        ids: z
          .array(z.string().uuid())
          .optional()
          .describe(
            `(action='expand') Memory IDs (1-${EXPAND_MAX_IDS}). UUIDs as returned by recall/search/wake-up.`,
          ),
        // shared (save | update)
        projectName: z
          .string()
          .optional()
          .describe("(save | update) Project name. Defaults to auto-detected project from cwd."),
        projectNames: z
          .array(z.string())
          .optional()
          .describe("(save | update) Multiple project names for cross-project memories."),
        topicName: z
          .string()
          .optional()
          .describe(
            "(save | update) Topic name within the project. Auto-created if missing on save.",
          ),
        source: z
          .enum(SOURCES)
          .optional()
          .describe("(action='save') How this memory was captured. Default: conversation."),
        kind: z
          .enum(KINDS)
          .optional()
          .describe(
            "(save | update) Memory kind (default: note on save). Use lore-decision for decisions.",
          ),
        status: z
          .enum(STATUSES)
          .optional()
          .describe("(save | update) Lifecycle state (default: informational on save)."),
        confidence: z
          .enum(CONFIDENCES)
          .optional()
          .describe("(save | update) Confidence level (default: certain on save)."),
        reviewBy: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("(save | update) Review-by date YYYY-MM-DD."),
        decidedAt: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("(save | update) Canonical decision date YYYY-MM-DD."),
        tags: tagsSchema
          .optional()
          .describe("(save | update) Closed-vocabulary tags."),
        keywords: keywordsSchema
          .optional()
          .describe("(save | update) Free-form keywords."),
        agent: z
          .string()
          .optional()
          .describe("(action='save') Name of the AI agent saving this memory."),
        session: z
          .string()
          .optional()
          .describe("(action='save') Session ID to group related memories."),
        // update only
        supersedesIds: z
          .array(z.string())
          .optional()
          .describe("(action='update') Replace the Supersedes relation with these decision IDs."),
        affectsIds: z
          .array(z.string())
          .optional()
          .describe("(action='update') Replace the Affects relation with these memory IDs."),
        alternatives: z
          .string()
          .optional()
          .describe("(action='update') Alternatives text (replaces existing)."),
        consequences: z
          .string()
          .optional()
          .describe("(action='update') Consequences text (replaces existing)."),
      },
    },
    async (args) => {
      const parsed = memoryDispatchSchema.safeParse(args)
      if (!parsed.success) {
        return toolError(
          new Error(formatDispatchError("lore-memory", parsed.error)),
        )
      }
      switch (parsed.data.action) {
        case "save":
          return handleSave(services, parsed.data)
        case "update":
          return handleUpdate(services, parsed.data)
        case "archive":
          return handleArchive(services, parsed.data)
        case "expand":
          return handleExpand(services, parsed.data)
      }
    },
  )

  // -------------------------------------------------------------------------
  // Deprecated aliases — preserved for the one-release transition window.
  // Schemas are kept intact so existing callers do not break; descriptions
  // shrink to redirect agents to the polymorphic tool. Recall/search live
  // under `lore-query` per the P3-01 plan, but legacy `lore-recall` /
  // `lore-search` aliases are kept here alongside the rest of the memory
  // family to mirror the prior file layout.
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-remember",
    {
      title: "Save a memory",
      description: "Deprecated alias — prefer `lore-memory` with `action: 'save'`.",
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
          .describe("Multiple project names for cross-project memories."),
        topicName: z
          .string()
          .optional()
          .describe("Topic name within the project. Created automatically if it doesn't exist."),
        source: z
          .enum(SOURCES)
          .optional()
          .describe("How this memory was captured (default: conversation)"),
        kind: z
          .enum(KINDS)
          .optional()
          .describe("Memory kind (default: note). Use `lore-decision` for decisions."),
        status: z.enum(STATUSES).optional().describe("Lifecycle state (default: informational)."),
        confidence: z.enum(CONFIDENCES).optional().describe("Confidence level (default: certain)"),
        reviewBy: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("Review-by date YYYY-MM-DD."),
        decidedAt: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("Canonical date this content was decided/captured (YYYY-MM-DD)."),
        tags: tagsSchema.optional(),
        keywords: keywordsSchema.optional(),
        agent: z.string().optional().describe("Name of the AI agent saving this memory"),
        session: z.string().optional().describe("Session ID to group related memories"),
      },
    },
    async (args) => handleSave(services, args),
  )

  server.registerTool(
    "lore-update",
    {
      title: "Update a memory",
      description: "Deprecated alias — prefer `lore-memory` with `action: 'update'`.",
      inputSchema: {
        memoryId: z.string().describe("The memory ID to update"),
        title: z.string().optional().describe("New title"),
        content: z.string().optional().describe("New content (replaces existing)"),
        tags: tagsSchema.optional(),
        keywords: keywordsSchema.optional(),
        projectName: z.string().optional().describe("Move to a different project"),
        projectNames: z
          .array(z.string())
          .optional()
          .describe("Set multiple project associations"),
        topicName: z.string().optional().describe("Move to a different topic"),
        kind: z.enum(KINDS).optional().describe("New memory kind"),
        status: z.enum(STATUSES).optional().describe("New lifecycle status"),
        confidence: z.enum(CONFIDENCES).optional().describe("New confidence level"),
        reviewBy: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("New review-by date YYYY-MM-DD."),
        decidedAt: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("New canonical decision date YYYY-MM-DD."),
        supersedesIds: z
          .array(z.string())
          .optional()
          .describe("Replace the Supersedes relation with these decision IDs"),
        affectsIds: z
          .array(z.string())
          .optional()
          .describe("Replace the Affects relation with these memory IDs"),
        alternatives: z.string().optional().describe("Alternatives text (replaces existing)"),
        consequences: z.string().optional().describe("Consequences text (replaces existing)"),
      },
    },
    async (args) => handleUpdate(services, args),
  )

  server.registerTool(
    "lore-forget",
    {
      title: "Archive a memory",
      description: "Deprecated alias — prefer `lore-memory` with `action: 'archive'`.",
      inputSchema: {
        memoryId: z.string().describe("The memory ID to archive"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ memoryId }) => handleArchive(services, { memoryId }),
  )

  server.registerTool(
    "lore-expand",
    {
      title: "Fetch memory bodies by ID",
      description: "Deprecated alias — prefer `lore-memory` with `action: 'expand'`.",
      inputSchema: {
        ids: z
          .array(z.string().uuid())
          .min(1)
          .max(EXPAND_MAX_IDS)
          .describe(
            `Memory page IDs to hydrate (1-${EXPAND_MAX_IDS}). UUIDs as returned by recall/search/wake-up.`,
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ids }) => handleExpand(services, { ids }),
  )

  server.registerTool(
    "lore-recall",
    {
      title: "Recall recent memories",
      description: "Deprecated alias — prefer `lore-query` with `action: 'recall'`.",
      inputSchema: {
        projectName: z.string().optional().describe("Filter by project name"),
        topicName: z.string().optional().describe("Filter by topic name"),
        source: z.enum(SOURCES).optional().describe("Filter by source type"),
        kind: z.enum(KINDS).optional().describe("Filter by memory kind"),
        status: z.enum(STATUSES).optional().describe("Filter by lifecycle status"),
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
          .describe("Opaque cursor from a previous response's `nextCursor`."),
        includeContent: z
          .boolean()
          .optional()
          .describe("Include each memory's markdown body (default false)."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => handleRecall(services, args),
  )

  server.registerTool(
    "lore-search",
    {
      title: "Search memories",
      description: "Deprecated alias — prefer `lore-query` with `action: 'search'`.",
      inputSchema: {
        query: z.string().describe("Natural language search query"),
        projectName: z.string().optional().describe("Scope search to a specific project"),
        tags: z.array(z.string()).optional().describe("Filter by tags (matches any)"),
        kind: z.enum(KINDS).optional().describe("Post-filter by memory kind"),
        status: z.enum(STATUSES).optional().describe("Post-filter by lifecycle status"),
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
          .describe("Include each memory's markdown body (default false)."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => handleSearch(services, args),
  )
}

/**
 * Render one hydrated memory for `lore-expand` output. Mirrors the meta-line
 * shape used by `lore-recall` / `lore-search` so agents scanning across
 * triage listings and expanded bodies see a uniform header line. Empty
 * `content` still renders the header (the memory exists; the body is just
 * blank) rather than collapsing the row.
 */
function formatExpandedMemory(m: Memory): string {
  const meta = [
    m.source,
    m.kind !== "note" ? m.kind : null,
    m.status !== "informational" ? m.status : null,
    m.updatedAt.split("T")[0],
  ]
    .filter(Boolean)
    .join(" | ")
  const body = m.content ? `\n\n${m.content}` : ""
  return `### ${m.title}\n*${meta}*${body}`
}
