// ABOUTME: Owns the lore-memory MCP schema, public tool copy, and action routing.
// ABOUTME: Edit when agent-facing memory inputs, validation hints, or dispatched actions change.

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { formatDispatchError, toolError, withWakeUpCacheBump } from "../helpers.js"
import { RICH_TEXT_PROPERTY_MAX_LEN } from "../../core/rich-text-schema.js"
import { SYNOPSIS_MAX } from "../../types.js"
import { clearableYmdDateSchema } from "./date-schema.js"
import { scopeInputSchema } from "./scope-schema.js"
import { createTagsSchema, keywordsSchema } from "./tag-schema.js"
import { handleArchive } from "./memory/archive.js"
import { handleCompare } from "./memory/compare.js"
import { handleExpand } from "./memory/expand.js"
import { handlePromote } from "./memory/promote.js"
import { handleReview } from "./memory/review.js"
import { handleSave } from "./memory/save.js"
import { createMemoryDispatchSchema } from "./memory/schema.js"
import { handleSuggestTopicKey } from "./memory/suggest-topic-key.js"
import {
  COMPARE_VERDICTS,
  CONFIDENCES,
  EXPAND_MAX_IDS,
  SOURCES,
  STATUSES,
  SUGGEST_KIND_VALUES,
  TOPIC_KEY_REGEX,
} from "./memory/types.js"
import { handleUpdate } from "./memory/update.js"

export { handleExpand } from "./memory/expand.js"
export { handleRecall, handleSearch } from "./memory/read.js"

export function registerMemoryTools(server: McpServer, services: LoreServices): void {
  const tagsSchema = createTagsSchema(services.profile?.taxonomy.tags)
  const memoryDispatchSchema = createMemoryDispatchSchema(tagsSchema)

  // -------------------------------------------------------------------------
  // lore-memory — polymorphic dispatcher
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-memory",
    {
      title: "Memory operations",
      description:
        "Save, update, archive, batch-expand, suggest a topic key, record a compare verdict, or review a proposed memory. Action-dispatched:\n\n" +
        "- `action: 'save'` — create a new memory page; runs a near-duplicate probe in parallel. With `topicKey` set, upserts onto an existing memory with the same key AND project-set (appends a revision block instead of creating a new row).\n" +
        "- `action: 'update'` — mutate an existing memory's title, body, tags, kind, status, or relations. Any field omitted is left untouched. Rejects with `MemoryReadOnlyError` on read-only pinned blocks; use `lore-pinned action='update'` with `force: true` to override.\n" +
        "- `action: 'archive'` — soft-delete a memory by ID (Notion archive flag).\n" +
        "- `action: 'expand'` — batch-fetch full markdown bodies for up to 20 IDs in one parallel call. Companion to the title-tier defaults on `lore-query` recall/search.\n" +
        "- `action: 'suggest-topic-key'` — pure heuristic over (title, kind) → kebab-case key. Pass the result to `action: 'save'` as `topicKey`. Notes and tasks return null.\n" +
        "- `action: 'compare'` — record a verdict on a memory pair (`conflicts_with` | `supersedes` | `scoped` | `related` | `compatible` | `not_conflict`). Asymmetric verdicts require `affectedMemoryId`. Idempotent on `(pair, verdict, affected)`.\n" +
        "- `action: 'approve'` / `'reject'` — inbox-review a `Status: proposed` memory (#281); flips Status and appends a Reviewed audit block.\n" +
        "- `action: 'promote'` — copy a memory into a configured `promotionTargets` entry with origin audit block; `requireReview` targets land as `Status: proposed`. See docs/topology.md#promotion.\n\n" +
        "For pinned context blocks (always-visible governing memory rendered in wake-up before relevance-ranked sections), use `lore-pinned`.\n\n" +
        "For architectural decisions prefer `lore-decision` with `action: 'create'` — it captures structured rationale and supersession chains.\n\n" +
        "`tags` is a closed vocabulary; for free-form labels (PR numbers, file paths, IDs) use `keywords`.",
      inputSchema: {
        action: z
          .enum([
            "save",
            "update",
            "archive",
            "expand",
            "suggest-topic-key",
            "compare",
            "approve",
            "reject",
            "promote",
          ])
          .describe(
            "Operation: save | update | archive | expand | suggest-topic-key | compare | approve | reject | promote."
          ),
        // save
        title: z
          .string()
          .optional()
          .describe(
            "Required for action='save' and action='suggest-topic-key'; new title for update. Short."
          ),
        content: z
          .string()
          .optional()
          .describe(
            "Required for action='save'; new body (markdown) for action='update'."
          ),
        // save | update | archive | expand | approve | reject
        memoryId: z
          .string()
          .optional()
          .describe(
            "Required for action='update'/'archive'/'approve'/'reject'. The Notion page ID of the memory."
          ),
        // The advertised tool schema is intentionally permissive: the
        // real validation (page-id shape, 1-20 cap, lowercase
        // canonicalization) lives in the `expand` branch of
        // `memoryDispatchSchema` below, so MCP-level introspection
        // doesn't need to mirror every constraint. Keeps the agent-
        // visible config string small.
        ids: z
          .array(z.string())
          .optional()
          .describe(
            `(action='expand') Memory IDs (1-${EXPAND_MAX_IDS}). Accepts dashed UUIDs as returned by recall/search/wake-up, or undashed 32-character hex ids from Notion page URLs.`
          ),
        // shared (save | update)
        projectName: z
          .string()
          .optional()
          .describe(
            "(save | update) Project name. Defaults to auto-detected project from cwd."
          ),
        projectNames: z
          .array(z.string())
          .optional()
          .describe("(save | update) Multiple project names for cross-project memories."),
        topicName: z
          .string()
          .optional()
          .describe(
            "(save | update) Topic name within the project. Auto-created if missing on save. Case/plural/punctuation variants silently collapse onto the canonical row to prevent fan-out."
          ),
        forceNewTopic: z
          .boolean()
          .optional()
          .describe(
            "(save | update) Bypass the normalized-equivalent + trigram-similar check on `topicName` and create a fresh row. Use only when you've reviewed the candidates surfaced by the structured error and confirmed your name is intentionally distinct."
          ),
        source: z
          .enum(SOURCES)
          .optional()
          .describe(
            "(action='save') How this memory was captured. Default: conversation."
          ),
        kind: z
          .enum(SUGGEST_KIND_VALUES)
          .optional()
          .describe(
            "(save | update | suggest-topic-key) Memory kind (default: note on save). " +
              "Use lore-decision for decisions; lore-task for tasks. " +
              "Required for action='suggest-topic-key', which accepts the full kind set; " +
              "save and update reject 'task' (tasks are owned by lore-task)."
          ),
        status: z
          .enum(STATUSES)
          .optional()
          .describe("(save | update) Lifecycle state (default: informational on save)."),
        confidence: z
          .enum(CONFIDENCES)
          .optional()
          .describe("(save | update) Confidence level (default: certain on save)."),
        reviewBy: clearableYmdDateSchema
          .optional()
          .describe(
            "(save | update) Review-by date YYYY-MM-DD. Save: must be YYYY-MM-DD. Update: null or empty string clears; omit leaves unchanged."
          ),
        decidedAt: clearableYmdDateSchema
          .optional()
          .describe(
            "(save | update) Canonical decision date YYYY-MM-DD. Save: must be YYYY-MM-DD. Update: null or empty string clears; omit leaves unchanged."
          ),
        tags: tagsSchema.optional().describe("(save | update) Closed-vocabulary tags."),
        keywords: keywordsSchema
          .optional()
          .describe("(save | update) Free-form keywords."),
        synopsis: z
          .string()
          .max(SYNOPSIS_MAX)
          .optional()
          .describe(
            `(save | update) 1-2 sentence synopsis surfaced under the title on recall/search/wake-up listings (≤${SYNOPSIS_MAX} chars). On update, omit to keep, pass empty string to clear.`
          ),
        author: z
          .string()
          .optional()
          .describe(
            "(action='save') Engineer display name. Defaults to LORE_USER_NAME env or `users.me` on the active token."
          ),
        agent: z
          .string()
          .optional()
          .describe("(action='save') Name of the AI agent saving this memory."),
        session: z
          .string()
          .optional()
          .describe("(action='save') Session ID to group related memories."),
        topicKey: z
          .string()
          .regex(
            TOPIC_KEY_REGEX,
            "Must be kebab-case path like 'decision/jwt-auth' (lowercase, slash-separated, no leading/trailing slash)"
          )
          .optional()
          .describe(
            "Kebab-case path like 'decision/jwt-auth'. On save: upserts when a memory " +
              "exists with same key/project-set (appends a revision, bumps Revision Count); " +
              "requires `kind` ∈ {decision, runbook, " +
              "incident, postmortem, policy}. On update: re-keys, appending a " +
              "`## Re-keyed` audit block; cannot be combined with `kind`. " +
              "See docs/memory-workflows.md#topic-keys."
          ),
        // update only
        supersedesIds: z
          .array(z.string())
          .optional()
          .describe(
            "(action='update') Replace the Supersedes relation with these decision IDs."
          ),
        affectsIds: z
          .array(z.string())
          .optional()
          .describe(
            "(action='update') Replace the Affects relation with these memory IDs."
          ),
        alternatives: z
          .string()
          .max(RICH_TEXT_PROPERTY_MAX_LEN)
          .optional()
          .describe(
            `(action='update') Alternatives text, up to ${RICH_TEXT_PROPERTY_MAX_LEN} chars (replaces existing).`
          ),
        consequences: z
          .string()
          .max(RICH_TEXT_PROPERTY_MAX_LEN)
          .optional()
          .describe(
            `(action='update') Consequences text, up to ${RICH_TEXT_PROPERTY_MAX_LEN} chars (replaces existing).`
          ),
        // compare
        memoryIdA: z
          .string()
          .optional()
          .describe(
            "(action='compare') First memory ID. A/B are unordered labels; direction comes from `affectedMemoryId`."
          ),
        memoryIdB: z.string().optional().describe("(action='compare') Second memory ID."),
        verdict: z
          .enum(COMPARE_VERDICTS)
          .optional()
          .describe(
            "(action='compare') Verdict on the pair. See docs/memory-workflows.md#conflict-verdicts."
          ),
        affectedMemoryId: z
          .string()
          .optional()
          .describe(
            "(action='compare') Required for asymmetric verdicts (`conflicts_with`, `supersedes`); names the loser. Must equal memoryIdA or memoryIdB."
          ),
        reason: z
          .string()
          .max(500)
          .optional()
          .describe(
            "(action='compare') ≤200 chars; recorded in Compare Notes. (action='approve'/'reject') Optional rationale ≤500 chars; recorded in the Reviewed audit block."
          ),
        judgeConfidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            "(action='compare') Optional 0..1 self-reported confidence. Below 0.7 the agent SHOULD ask the user first."
          ),
        promptVersion: z
          .string()
          .optional()
          .describe(
            "(action='compare') Optional prompt version (default: current `CONFLICT_JUDGE_PROMPT_VERSION`)."
          ),
        reviewer: z
          .string()
          .optional()
          .describe(
            "(action='approve'/'reject') Optional reviewer name. Defaults to the engineer identity resolver (LORE_USER_NAME → users.me)."
          ),
        // promote
        targetName: z
          .string()
          .optional()
          .describe(
            "(action='promote') Name of the promotion target as configured in `.lore.yaml`'s `promotionTargets`."
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            "(action='promote') Preview the audit block + resolved status without writing to the target vault. Mirrors `lore promote --dry-run`. Mis-resolved targets / missing identity / same-vault rejection all surface before the source read so a misconfigured call cannot burn target-vault quota."
          ),
        scope: scopeInputSchema,
      },
    },
    async (args) => {
      const parsed = memoryDispatchSchema.safeParse(args)
      if (!parsed.success) {
        return toolError(new Error(formatDispatchError("lore-memory", parsed.error)))
      }
      const data = parsed.data
      switch (data.action) {
        case "save":
          return withWakeUpCacheBump(services.wakeupCache, () =>
            handleSave(services, data)
          )
        case "update":
          return withWakeUpCacheBump(services.wakeupCache, () =>
            handleUpdate(services, data)
          )
        case "archive":
          return withWakeUpCacheBump(services.wakeupCache, () =>
            handleArchive(services, data)
          )
        case "expand":
          return handleExpand(services, data)
        case "suggest-topic-key":
          return handleSuggestTopicKey(data)
        case "compare":
          return withWakeUpCacheBump(services.wakeupCache, () =>
            handleCompare(services, data)
          )
        case "approve":
          return withWakeUpCacheBump(services.wakeupCache, () =>
            handleReview(services, data, "approve")
          )
        case "reject":
          return withWakeUpCacheBump(services.wakeupCache, () =>
            handleReview(services, data, "reject")
          )
        case "promote":
          // Promotion writes to a target vault, while this dispatcher owns the
          // primary vault's wake-up cache. The primary bump keeps write-action
          // routing consistent without making the promoted row visible to
          // primary read paths. Target-vault wake-up caches must be invalidated
          // by the target write path that owns those cached results.
          return withWakeUpCacheBump(services.wakeupCache, () =>
            handlePromote(services, data)
          )
      }
    }
  )
}
