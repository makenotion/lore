import { z } from "zod"
import { TAG_VOCABULARY } from "../../types.js"

/**
 * Shared Zod schemas for the closed `tags` vocabulary and free-form
 * `keywords` field. Used by every memory-writing tool — `lore-memory`
 * (save | update), `lore-decision` (create), `lore-journal` (write), and
 * the legacy `lore-remember` / `lore-update` / `lore-decide` aliases — so
 * agents get a consistent error message when they try to invent an
 * out-of-vocab tag.
 *
 * Tool-parameter descriptions stay short so the 40-term vocabulary doesn't
 * bloat every tool's schema rendering. The full enumeration only appears
 * inside the validation error the agent sees when a bad tag arrives —
 * that's where listing the vocabulary is actually useful.
 */

/** Pre-computed once: every schema construction would otherwise re-join. */
const VOCAB_CSV = TAG_VOCABULARY.join(", ")

/** Notion rich_text caps at 2000 chars per segment. Fail at Zod, not Notion. */
const KEYWORDS_MAX_LEN = 2000

/**
 * Validator that emits a directive error when an out-of-vocab tag arrives:
 * names the bad values, lists the accepted vocabulary, and points at the
 * `keywords` field for free-form labels.
 */
const tagArraySchema = z
  .array(z.string())
  .superRefine((tags, ctx) => {
    const vocab = new Set<string>(TAG_VOCABULARY)
    const invalid = tags.filter((t) => !vocab.has(t))
    if (invalid.length === 0) return
    const quoted = invalid.map((t) => `"${t}"`).join(", ")
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `Tag${invalid.length === 1 ? "" : "s"} ${quoted} not in the closed vocabulary. ` +
        `Accepted tags: ${VOCAB_CSV}. ` +
        `For PR numbers, ticket IDs, file paths, class/function names, or any other ` +
        `free-form label, use \`keywords\` instead (e.g. keywords: "pr-25701 ThreadStore.swift").`,
    })
  })

/**
 * Zod schema for `tags` on memory-writing tools. Accepts only values from
 * `TAG_VOCABULARY`. Agents see the full vocabulary in the rejection
 * message rather than inline in every tool's parameter docs.
 */
export const tagsSchema = tagArraySchema.describe(
  "Closed-vocabulary tags for categorization. " +
    "Invalid tags fail with a rejection listing the full vocabulary and pointing at `keywords` for free-form labels (PR numbers, ticket IDs, file paths, class names)."
)

/**
 * Zod schema for the free-form `keywords` field — space-separated tokens
 * indexed by Notion's text search. Capped at 2000 chars to fail fast at
 * the Zod boundary instead of surfacing a generic Notion 400.
 */
export const keywordsSchema = z
  .string()
  .max(
    KEYWORDS_MAX_LEN,
    `keywords must be ${KEYWORDS_MAX_LEN} characters or fewer (Notion rich_text segment cap).`
  )
  .describe(
    "Free-form space-separated tokens (PR numbers, ticket IDs, file paths, class/function names). " +
      "Indexed by Notion text search. Prefer this over `tags` for anything not in the closed vocabulary. " +
      `Max ${KEYWORDS_MAX_LEN} chars.`
  )
