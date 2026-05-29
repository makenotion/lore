import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { formatDispatchError, toolError } from "../helpers.js"
import { handleRecall, handleSearch } from "./memory.js"
import { handleAsk, handleAudit } from "./knowledge.js"
import { ymdDateSchema } from "./date-schema.js"

// The closed set of `MemoryKind` values that `lore-query action='recall'`
// and `action='search'` accept as the `kind` filter. `task` is excluded
// because tracked work has its own polymorphic dispatcher
// (`lore-task action='list'`) and `lore-query` cannot filter against the
// `Task State` lifecycle. Operational rows stay filterable as an explicit
// opt-in for audit and debt follow-up; default recall excludes them when
// `kind` is omitted. Additional durable `MemoryKind` values must be added
// here for recall/search to filter on it; the polymorphic surface tests pin
// the drift contract.
const KINDS = [
  "note",
  "decision",
  "incident",
  "runbook",
  "postmortem",
  "policy",
  "state",
  "operational",
  "procedure",
] as const

const STATUSES = [
  "informational",
  "proposed",
  "accepted",
  "superseded",
  "deprecated",
  "rejected",
] as const

const READABLE_SOURCES = [
  "conversation",
  "file",
  "manual",
  "agent_diary",
  "digest",
] as const

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
  "session cookie'`). Under `mode: 'hybrid'` setting intent " +
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
 * schema would slip past every handler-level test.
 * for the negative-pin tests on `recall` / `ask` / `audit`.
 */
export const queryDispatchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("recall"),
    projectName: z.string().optional(),
    topicName: z.string().optional(),
    source: z.enum(READABLE_SOURCES).optional(),
    kind: z.enum(KINDS).optional(),
    status: z.enum(STATUSES).optional(),
    reviewBefore: ymdDateSchema.optional(),
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
    tags: z.array(z.string().trim().min(1)).optional(),
    source: z.enum(READABLE_SOURCES).optional(),
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
    // Reject empty / whitespace-only entity at the boundary. An
    // unfiltered call would otherwise reach `FactService.queryByEntity`
    // and trigger a vault-wide scan; the service layer also short-
    // circuits to `[]`, but failing here gives the agent
    // a clear "entity is required" error instead of an empty result
    // set masquerading as "no facts found".
    entity: z.string().trim().min(1, "entity must be a non-empty string"),
    projectName: z.string().optional(),
    limit: z.number().int().min(1).optional(),
    includeContext: z.boolean().optional(),
    // Transaction-time recall controls.
    asOf: ymdDateSchema.optional(),
    includeHistory: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("audit"),
    projectName: z.string().optional(),
  }),
])

export function registerQueryTools(server: McpServer, services: LoreServices): void {
  // -------------------------------------------------------------------------
  // lore-query — polymorphic read-path dispatcher
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
        "Vault retrieval — list memories, search memories, query the fact graph, or audit overdue items. " +
        "**Call this BEFORE answering factual questions about stored conversation or recorded knowledge** — the vault is authoritative; abstain only after `action: 'search'` (and `action: 'ask'` when the question names an entity) return nothing. " +
        "Action-dispatched:\n\n" +
        "- `action: 'recall'` — list recent memories with optional filters (server-side via `dataSources.query`). Title-tier rows by default; `includeContent: true` to fetch bodies. Cursor-paginated.\n" +
        "- `action: 'search'` — memory search; `mode: contains | semantic | hybrid` (default `semantic`). `contains` is DS-scoped substring with server-side filters; `semantic` uses Notion relevance over titles + bodies; `hybrid` runs both in parallel and prefers contains when it saturates (≥ 3 hits). Title-tier by default.\n" +
        "- `action: 'ask'` — query facts and tasks about an entity. Returns Governance / Structure / Tasks buckets capped at 5 each (raise via `limit`). Prepends a project framing block by default (`includeContext: false` to suppress). Pass `asOf: 'YYYY-MM-DD'` for a transaction-time as-of recall (what Lore knew at that date) or `includeHistory: true` to surface invalidated facts inline.\n" +
        "- `action: 'audit'` — list facts, decisions, and tasks past their review-by date.\n\n" +
        "For tracked work (open / blocked / done), use `lore-task action='list'` rather than `lore-query`.",
      inputSchema: {
        action: z
          .enum(["recall", "search", "ask", "audit"])
          .describe(
            "Operation: recall (list recent), search (semantic), ask (entity facts), audit."
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
              "(action='search') Scope to a topic. Server-side filter in `contains`/`hybrid`; post-filter in `semantic`."
          ),
        source: z
          .enum(READABLE_SOURCES)
          .optional()
          .describe(
            "(action='recall') Filter by source type. " +
              "(action='search') Server-side filter in `contains`/`hybrid`; post-filter in `semantic`."
          ),
        // recall | search
        kind: z
          .enum(KINDS)
          .optional()
          .describe(
            "(action='recall') Filter by memory kind. " +
              "(action='search') Server-side filter in `contains`/`hybrid`; post-filter in `semantic`."
          ),
        status: z
          .enum(STATUSES)
          .optional()
          .describe(
            "(action='recall') Filter by lifecycle status. " +
              "(action='search') Server-side filter in `contains`/`hybrid`; post-filter in `semantic`."
          ),
        // recall only
        reviewBefore: ymdDateSchema
          .optional()
          .describe(
            "(action='recall') Only return memories with `Review By` on or before."
          ),
        // search only
        tags: z
          .array(z.string().trim().min(1))
          .optional()
          .describe(
            "(action='search') Filter by tag strings (matches any). " +
              "Server-side filter in `contains`/`hybrid`; post-filter in `semantic`. " +
              "Read filters accept legacy and out-of-profile tags; for free-form keyword filtering, use `query`."
          ),
        // search only
        mode: z
          .enum(["contains", "semantic", "hybrid"])
          .optional()
          .describe(
            "(action='search') Search mode (default `semantic`). `contains` for DS-scoped substring " +
              "matching with server-side property filters; `semantic` for Notion relevance " +
              "over titles AND bodies; `hybrid` fires both in parallel and uses contains " +
              "alone when it saturates (≥ 3 hits) or RRF-fuses both branches when it doesn't."
          ),
        // search only
        explain: z
          .boolean()
          .optional()
          .describe(
            "(action='search') Append a `## Score trace` footer with per-row branch, contains/semantic ranks, RRF score, and stored/effective confidence factors. Useful for diagnosing why a row sorted where it did."
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
          .describe("Max results. Defaults: recall 10, search 10, ask 5/bucket."),
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
            "(recall | search) Include each memory's markdown body (default false). One extra Notion round-trip per row."
          ),
        // recall | search
        includeSynopsis: z
          .boolean()
          .optional()
          .describe(
            "(recall | search) Render the memory's 1–2 sentence synopsis (when present) under the title (default true). Pass false to restore the byte-identical pre-synopsis title-only output for narrow terminals or callers that already plan to fetch bodies."
          ),
        // ask only
        includeContext: z
          .boolean()
          .optional()
          .describe(
            "(action='ask') Prepend a project framing block (name, description, siblings, catch-all warning) above the grouped-display sections (default true). Pass `false` when the agent's system prompt already supplies framing, to save output tokens."
          ),
        // ask only — temporal recall controls
        asOf: ymdDateSchema
          .optional()
          .describe(
            "(action='ask') Transaction-time cutoff (YYYY-MM-DD). Returns only facts Lore had observed by this date AND had not yet invalidated by this date — what Lore believed at that point in time. Independent of `includeHistory`; either or both may be set. Distinct from domain-truth `Valid From` / `Valid Until` (when the fact was true in the world). On un-migrated vaults (rows missing `Invalidated At`), the filter approximates with `Valid Until` so a historical invalidation cannot leak past its cutoff; run `lore migrate --backfill-fact-observed-at` to seed transaction-time columns and get strict asOf semantics."
          ),
        includeHistory: z
          .boolean()
          .optional()
          .describe(
            "(action='ask') Include invalidated facts in the result (default false — only live facts surface). Useful for tracing how knowledge about an entity changed over time. The invalidation date renders inline on each historical row."
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const parsed = queryDispatchSchema.safeParse(args)
      if (!parsed.success) {
        return toolError(new Error(formatDispatchError("lore-query", parsed.error)))
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
    }
  )
}
