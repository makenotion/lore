import { z } from "zod"
import { richTextPropertySchema } from "../../../core/rich-text-schema.js"
import { DEFAULT_MEMORY_SYNOPSIS_MAX } from "../../../types.js"
import { clearableYmdDateSchema, ymdDateSchema } from "../date-schema.js"
import { notionPageIdSchema } from "../../../notion/page-id-schema.js"
import { scopeInputSchema } from "../scope-schema.js"
import { createTagsSchema, keywordsSchema } from "../tag-schema.js"
import { nonBlankBody, nonBlankString } from "../text-schema.js"
import {
  COMPARE_VERDICTS,
  CONFIDENCES,
  EXPAND_MAX_IDS,
  KINDS,
  SOURCES,
  STATUSES,
  SUGGEST_KIND_VALUES,
  TOPIC_KEY_REGEX,
} from "./types.js"

export function createMemoryDispatchSchema(
  tagsSchema: ReturnType<typeof createTagsSchema>,
  options: { synopsisMaxChars?: number } = {}
) {
  const synopsisMaxChars = options.synopsisMaxChars ?? DEFAULT_MEMORY_SYNOPSIS_MAX
  const synopsisSchema = z
    .string()
    .max(synopsisMaxChars, `synopsis must be ${synopsisMaxChars} characters or fewer.`)
  return z.discriminatedUnion("action", [
    z.object({
      action: z.literal("save"),
      title: nonBlankString,
      // `content` is the markdown page body; nonBlankBody validates without
      // transforming so a body that starts with an indented code block or
      // intentional whitespace round-trips verbatim into Notion.
      content: nonBlankBody,
      projectName: z.string().optional(),
      projectNames: z.array(z.string()).optional(),
      topicName: z.string().optional(),
      forceNewTopic: z.boolean().optional(),
      source: z.enum(SOURCES).optional(),
      kind: z.enum(KINDS).optional(),
      status: z.enum(STATUSES).optional(),
      confidence: z.enum(CONFIDENCES).optional(),
      reviewBy: ymdDateSchema.optional(),
      decidedAt: ymdDateSchema.optional(),
      tags: tagsSchema.optional(),
      keywords: keywordsSchema.optional(),
      synopsis: synopsisSchema.optional(),
      author: z.string().optional(),
      agent: z.string().optional(),
      session: z.string().optional(),
      topicKey: z
        .string()
        .regex(
          TOPIC_KEY_REGEX,
          "Must be kebab-case path like 'decision/jwt-auth' (lowercase, slash-separated, no leading/trailing slash)"
        )
        .optional(),
      scope: scopeInputSchema,
    }),
    z.object({
      action: z.literal("update"),
      memoryId: z.string(),
      title: z.string().optional(),
      content: z.string().optional(),
      tags: tagsSchema.optional(),
      keywords: keywordsSchema.optional(),
      synopsis: synopsisSchema.optional(),
      projectName: z.string().optional(),
      projectNames: z.array(z.string()).optional(),
      topicName: z.string().optional(),
      forceNewTopic: z.boolean().optional(),
      kind: z.enum(KINDS).optional(),
      status: z.enum(STATUSES).optional(),
      confidence: z.enum(CONFIDENCES).optional(),
      reviewBy: clearableYmdDateSchema.optional(),
      decidedAt: clearableYmdDateSchema.optional(),
      supersedesIds: z.array(notionPageIdSchema).optional(),
      affectsIds: z.array(notionPageIdSchema).optional(),
      alternatives: richTextPropertySchema("alternatives").optional(),
      consequences: richTextPropertySchema("consequences").optional(),
      // Same kebab-case regex as `lore-memory action='save'`'s
      // (forthcoming) topic-key parameter — the format contract is
      // identical across save and update.
      topicKey: z.string().regex(TOPIC_KEY_REGEX).optional(),
      scope: scopeInputSchema,
    }),
    z.object({
      action: z.literal("archive"),
      memoryId: z.string(),
    }),
    z.object({
      action: z.literal("expand"),
      ids: z.array(notionPageIdSchema).min(1).max(EXPAND_MAX_IDS),
    }),
    z.object({
      action: z.literal("suggest-topic-key"),
      title: z.string(),
      kind: z.enum(SUGGEST_KIND_VALUES),
    }),
    z.object({
      action: z.literal("compare"),
      memoryIdA: z.string(),
      memoryIdB: z.string(),
      verdict: z.enum(COMPARE_VERDICTS),
      affectedMemoryId: z.string().optional(),
      // Compare verdicts persist into the `Compare Notes` rich_text audit
      // trail; a blank reason produces the same near-empty Notion content
      // shape this PR is targeting elsewhere.
      reason: nonBlankString.pipe(z.string().max(200)),
      judgeConfidence: z.number().min(0).max(1).optional(),
      promptVersion: z.string().optional(),
    }),
    z.object({
      action: z.literal("approve"),
      memoryId: z.string(),
      reviewer: z.string().optional(),
      reason: z.string().max(500).optional(),
    }),
    z.object({
      action: z.literal("reject"),
      memoryId: z.string(),
      reviewer: z.string().optional(),
      reason: z.string().max(500).optional(),
    }),
    z.object({
      action: z.literal("promote"),
      memoryId: z.string(),
      // Target name lookup is intentionally a string match against
      // `config.promotionTargets[].name`, not a `z.enum(...)` of the
      // resolved labels — the topology is config-driven and a Zod
      // enum would force a server restart to register a new target.
      // Out-of-vocab names land at `handlePromote`'s configured-list
      // hint instead. Capped at 200 to match the adjacent
      // `reviewer` / `reason` posture and bound prompt-budget on
      // malformed input.
      targetName: z.string().max(200),
      reason: z.string().max(500).optional(),
      // `promoter` is intentionally NOT accepted at the MCP boundary.
      // The MCP surface is agent-driven; an agent-supplied promoter
      // string would let any caller forge the `**Promoter:**` line
      // of the cross-vault audit block — exactly the audit gap the
      // topology design exists to close. The CLI's `--promoter` flag
      // remains operator-driven; the MCP equivalent uses the
      // server-resolved identity exclusively.
      dryRun: z.boolean().optional(),
    }),
  ])
}
