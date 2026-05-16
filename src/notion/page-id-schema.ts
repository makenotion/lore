import { z } from "zod"

/**
 * Shared Zod schema for fields that carry a Notion page id.
 *
 * Accepts the two practical forms agents encounter in the wild:
 *
 * - **Dashed UUID** (`8-4-4-4-12`, hex). What Notion's SDK and our own
 *   tools surface — every `Memory.id`, `Decision.id`, `Fact.id` returned
 *   from `recall` / `search` / `wake-up` lands in this shape.
 * - **Undashed 32-char hex**. What `notion.so/<title>-<id>` URLs expose
 *   to anyone copy-pasting from a browser.
 *
 * Both round-trip into `client.pages.retrieve({ page_id })` cleanly —
 * Notion's SDK accepts either form, in any case. Normalizing at the
 * input boundary to a single canonical shape (lowercase, dashed) means
 * downstream consumers — per-call dedup `Set<string>`s, the
 * `MemoryService.titleCache` keyed by id, the render layer's title-resolver
 * which already lowercases before lookup — see one shape regardless of
 * which form the caller pasted. Without lowercasing, `AaBb…` and
 * `aabb…` (the same Notion page) hash to two distinct strings and the
 * dedup invariant silently breaks.
 *
 * Rejects empty / whitespace-only input so a bad call surfaces as a
 * dispatch error with a clear field path instead of falling through to
 * a Notion 404 / 400. Mirrors `nonBlankString`'s posture for
 * create-required text fields.
 *
 * New fields requiring a Notion page id should prefer this schema for the
 * better error message and the undashed-form acceptance.
 */

const DASHED_NOTION_PAGE_ID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const UNDASHED_NOTION_PAGE_ID = /^[0-9a-fA-F]{32}$/

function hyphenate(undashed: string): string {
  return `${undashed.slice(0, 8)}-${undashed.slice(8, 12)}-${undashed.slice(12, 16)}-${undashed.slice(16, 20)}-${undashed.slice(20, 32)}`
}

export const notionPageIdSchema = z
  .string()
  .trim()
  .refine(
    (value) => DASHED_NOTION_PAGE_ID.test(value) || UNDASHED_NOTION_PAGE_ID.test(value),
    "must be a Notion page id (32-char hex or dashed UUID)"
  )
  .transform((value) => {
    const dashed = UNDASHED_NOTION_PAGE_ID.test(value) ? hyphenate(value) : value
    return dashed.toLowerCase()
  })
