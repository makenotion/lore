import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { formatDispatchError, toolError } from "../helpers.js"
import { handleRecall, handleSearch } from "./memory.js"
import { handleAsk, handleOpenLoops, handleAudit } from "./knowledge.js"
import { tagsSchema } from "./tag-schema.js"

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

const SOURCES = ["conversation", "file", "manual", "agent_diary", "digest"] as const

const YMD_REGEX = /^\d{4}-\d{2}-\d{2}$/

/**
 * Polymorphic dispatcher schema for `lore-query`. The MCP-level inputSchema
 * is declared flat (every field optional with action-scoped descriptions);
 * this discriminated union runs at handler entry for clean per-action
 * validation errors.
 */
const queryDispatchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("recall"),
    projectName: z.string().optional(),
    topicName: z.string().optional(),
    source: z.enum(SOURCES).optional(),
    kind: z.enum(KINDS).optional(),
    status: z.enum(STATUSES).optional(),
    reviewBefore: z.string().regex(YMD_REGEX).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    startCursor: z.string().min(1).optional(),
    includeContent: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("search"),
    query: z.string(),
    projectName: z.string().optional(),
    // Closed-vocab tags here too: the inner discriminated union is the
    // dispatcher's runtime contract, and the architecture in
    // src/mcp/AGENTS.md says it must mirror the closed-vocab guarantee
    // declared at the MCP boundary. The legacy `lore-search` alias
    // intentionally stays loose (it pre-dates the tag taxonomy) — agents
    // moving to `lore-query` opt into the stricter validation.
    tags: tagsSchema.optional(),
    kind: z.enum(KINDS).optional(),
    status: z.enum(STATUSES).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    includeContent: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("ask"),
    entity: z.string(),
    projectName: z.string().optional(),
    limit: z.number().int().min(1).optional(),
  }),
  z.object({
    action: z.literal("open-loops"),
    projectName: z.string().optional(),
    entity: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    all: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("audit"),
    projectName: z.string().optional(),
  }),
])

export function registerQueryTools(server: McpServer, services: LoreServices): void {
  // -------------------------------------------------------------------------
  // lore-query — polymorphic read-path dispatcher (P3-01)
  //
  // Spans memory and knowledge read paths because they share heavy
  // structural overlap (project scoping, limit/cursor knobs, content-off
  // defaults). Mutations stay on `lore-memory` / `lore-fact` /
  // `lore-decision` so the read/write boundary stays visible to agents.
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-query",
    {
      title: "Vault read paths",
      description:
        "Read the vault: list memories, search memories, query the fact graph, list open loops, or audit overdue items. Action-dispatched:\n\n" +
        "- `action: 'recall'` — list recent memories with optional filters (server-side via `dataSources.query`). Title-tier rows by default; `includeContent: true` to fetch bodies. Cursor-paginated.\n" +
        "- `action: 'search'` — semantic search over memories (Notion vector similarity). Title-tier by default. `kind`/`status` are post-filters.\n" +
        "- `action: 'ask'` — query facts about an entity. Returns Governance/Structure/Tracking buckets capped at 5 each (raise via `limit`).\n" +
        "- `action: 'open-loops'` — list active tracking-predicate facts (needs_action / waiting_on / blocked_by). Capped at 10 per section unless `{all: true}`.\n" +
        "- `action: 'audit'` — list facts and decisions past their review-by date.",
      inputSchema: {
        action: z
          .enum(["recall", "search", "ask", "open-loops", "audit"])
          .describe(
            "Operation: recall (list recent), search (semantic), ask (entity facts), open-loops, audit.",
          ),
        // search only
        query: z
          .string()
          .optional()
          .describe("(action='search') Required. Natural language search query."),
        // ask | open-loops
        entity: z
          .string()
          .optional()
          .describe(
            "(action='ask') Required: entity to query (subject or object). " +
              "(action='open-loops') Optional substring filter matched against Subject OR Object.",
          ),
        // shared scope
        projectName: z
          .string()
          .optional()
          .describe("Scope to a project (recall, search, ask, open-loops, audit)."),
        // recall only
        topicName: z
          .string()
          .optional()
          .describe("(action='recall') Filter by topic name."),
        source: z
          .enum(SOURCES)
          .optional()
          .describe("(action='recall') Filter by source type."),
        // recall | search
        kind: z
          .enum(KINDS)
          .optional()
          .describe(
            "(action='recall') Filter by memory kind. (action='search') Post-filter by kind.",
          ),
        status: z
          .enum(STATUSES)
          .optional()
          .describe(
            "(action='recall') Filter by lifecycle status. (action='search') Post-filter.",
          ),
        // recall only
        reviewBefore: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("(action='recall') Only return memories with `Review By` on or before."),
        // search only
        tags: tagsSchema
          .optional()
          .describe(
            "(action='search') Filter by closed-vocabulary tags (matches any). " +
              "For free-form keyword filtering, use `query`.",
          ),
        // shared (recall | search | ask | open-loops)
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Max results. Defaults: recall 10, search 10, ask 5/bucket, open-loops 10/section.",
          ),
        // recall only
        startCursor: z
          .string()
          .min(1)
          .optional()
          .describe("(action='recall') Opaque pagination cursor."),
        // recall | search
        includeContent: z
          .boolean()
          .optional()
          .describe(
            "(recall | search) Include each memory's markdown body (default false). One extra Notion round-trip per row.",
          ),
        // open-loops only
        all: z
          .boolean()
          .optional()
          .describe(
            "(action='open-loops') Bypass the per-section cap and return every matching loop.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const parsed = queryDispatchSchema.safeParse(args)
      if (!parsed.success) {
        return toolError(
          new Error(formatDispatchError("lore-query", parsed.error)),
        )
      }
      switch (parsed.data.action) {
        case "recall":
          return handleRecall(services, parsed.data)
        case "search":
          return handleSearch(services, parsed.data)
        case "ask":
          return handleAsk(services, parsed.data, "lore-query")
        case "open-loops":
          return handleOpenLoops(services, parsed.data)
        case "audit":
          return handleAudit(services, parsed.data)
      }
    },
  )
}
