import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { formatDispatchError, toolError } from "../helpers.js"
import { handleRecall, handleSearch } from "./memory.js"
import { handleAsk, handleAudit } from "./knowledge.js"
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
 * Agent-facing description for `intent` on the `search` arm. Hoisted out of
 * the inline `.describe()` because the contract is load-bearing (every
 * sentence pins a behavior an agent caller relies on) and the inline form
 * was the longest single description in the dispatcher schema. Adjacent
 * surfaces (CLI, future tool-help renderers) can reuse the same string.
 */
const INTENT_DESCRIPTION =
  "(action='search') Optional disambiguator threaded into the semantic " +
  "branch's relevance query as context, NEVER into the contains branch's " +
  "substring match. Use when `query` is short and ambiguous and the caller " +
  "knows which sense they mean (e.g. `query: 'auth'`, `intent: 'WeChat " +
  "session cookie'`). Under `mode: 'hybrid'` (default) setting intent " +
  "disables the saturation cutoff so the merge always runs and up-weights " +
  "the contains lane to keep precision dominant. Ignored under " +
  "`mode: 'contains'`. Whitespace-only intent is treated as unset."

/**
 * Polymorphic dispatcher schema for `lore-query`. The MCP-level inputSchema
 * is declared flat (every field optional with action-scoped descriptions);
 * this discriminated union runs at handler entry for clean per-action
 * validation errors.
 *
 * Exported solely so contract tests can pin per-arm field membership
 * directly via `safeParse` — handler-side spies only observe the
 * hand-constructed argument literals each `handleX` builds, which means
 * a regression that re-introduces `intent` on a non-`search` arm of this
 * schema would slip past every handler-level test. See `polymorphic.test.ts`
 * for the negative-pin tests on `recall` / `ask` / `audit`.
 */
export const queryDispatchSchema = z.discriminatedUnion("action", [
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
    includeSynopsis: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("search"),
    query: z.string(),
    projectName: z.string().optional(),
    topicName: z.string().optional(),
    // Closed-vocab tags here too: the inner discriminated union is the
    // dispatcher's runtime contract, and the architecture in
    // src/mcp/AGENTS.md says it must mirror the closed-vocab guarantee
    // declared at the MCP boundary.
    tags: tagsSchema.optional(),
    kind: z.enum(KINDS).optional(),
    status: z.enum(STATUSES).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    includeContent: z.boolean().optional(),
    includeSynopsis: z.boolean().optional(),
    mode: z.enum(["contains", "semantic", "hybrid"]).optional(),
    explain: z.boolean().optional(),
    intent: z.string().optional(),
  }),
  z.object({
    action: z.literal("ask"),
    entity: z.string(),
    projectName: z.string().optional(),
    limit: z.number().int().min(1).optional(),
    includeContext: z.boolean().optional(),
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
        "Read the vault: list memories, search memories, query the fact graph, or audit overdue items. Action-dispatched:\n\n" +
        "- `action: 'recall'` — list recent memories with optional filters (server-side via `dataSources.query`). Title-tier rows by default; `includeContent: true` to fetch bodies. Cursor-paginated.\n" +
        "- `action: 'search'` — memory search; `mode: contains | semantic | hybrid` (default `hybrid`). `contains` is DS-scoped substring with server-side filters; `semantic` is workspace-wide vector ranking over titles + bodies; `hybrid` runs both in parallel and prefers contains when it saturates (≥ 3 hits). Title-tier by default.\n" +
        "- `action: 'ask'` — query facts and tasks about an entity. Returns Governance / Structure / Tasks buckets capped at 5 each (raise via `limit`). Prepends a project framing block by default (`includeContext: false` to suppress).\n" +
        "- `action: 'audit'` — list facts, decisions, and tasks past their review-by date.\n\n" +
        "For tracked work (open / blocked / done), use `lore-task action='list'` rather than `lore-query`.",
      inputSchema: {
        action: z
          .enum(["recall", "search", "ask", "audit"])
          .describe(
            "Operation: recall (list recent), search (semantic), ask (entity facts), audit.",
          ),
        // search only
        query: z
          .string()
          .optional()
          .describe("(action='search') Required. Natural language search query."),
        // ask
        entity: z
          .string()
          .optional()
          .describe("(action='ask') Required: entity to query (subject or object)."),
        // shared scope
        projectName: z
          .string()
          .optional()
          .describe("Scope to a project (recall, search, ask, audit)."),
        // recall | search
        topicName: z
          .string()
          .optional()
          .describe(
            "(action='recall') Filter by topic name. " +
              "(action='search') Scope to a topic. Server-side filter in `contains`/`hybrid`; post-filter in `semantic`.",
          ),
        source: z
          .enum(SOURCES)
          .optional()
          .describe("(action='recall') Filter by source type."),
        // recall | search
        kind: z
          .enum(KINDS)
          .optional()
          .describe(
            "(action='recall') Filter by memory kind. " +
              "(action='search') Server-side filter in `contains`/`hybrid`; post-filter in `semantic`.",
          ),
        status: z
          .enum(STATUSES)
          .optional()
          .describe(
            "(action='recall') Filter by lifecycle status. " +
              "(action='search') Server-side filter in `contains`/`hybrid`; post-filter in `semantic`.",
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
              "Server-side filter in `contains`/`hybrid`; post-filter in `semantic`. " +
              "For free-form keyword filtering, use `query`.",
          ),
        // search only
        mode: z
          .enum(["contains", "semantic", "hybrid"])
          .optional()
          .describe(
            "(action='search') Search mode (default `hybrid`). `contains` for DS-scoped substring " +
              "matching with server-side property filters; `semantic` for workspace-wide vector " +
              "relevance over titles AND bodies; `hybrid` fires both in parallel and uses contains " +
              "alone when it saturates (≥ 3 hits) or RRF-fuses both branches when it doesn't.",
          ),
        // search only
        explain: z
          .boolean()
          .optional()
          .describe(
            "(action='search') Append a `## Score trace` footer with per-row branch, contains/semantic ranks, and RRF score. Useful for diagnosing why a row sorted where it did.",
          ),
        // search only
        intent: z.string().optional().describe(INTENT_DESCRIPTION),
        // shared (recall | search | ask)
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Max results. Defaults: recall 10, search 10, ask 5/bucket.",
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
        // recall | search
        includeSynopsis: z
          .boolean()
          .optional()
          .describe(
            "(recall | search) Render the memory's 1–2 sentence synopsis (when present) under the title (default true). Pass false to restore the byte-identical pre-synopsis title-only output for narrow terminals or callers that already plan to fetch bodies.",
          ),
        // ask only
        includeContext: z
          .boolean()
          .optional()
          .describe(
            "(action='ask') Prepend a project framing block (name, description, siblings, catch-all warning) above the grouped-display sections (default true). Pass `false` when the agent's system prompt already supplies framing, to save output tokens.",
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
        case "audit":
          return handleAudit(services, parsed.data)
      }
    },
  )
}
