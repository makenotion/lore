import { z } from "zod"

/**
 * Shared Zod schemas for create-required user-facing text fields whose
 * empty/whitespace-only values would create blank or near-blank rows in
 * Notion. Reject at the MCP boundary so the failure surfaces as a tool
 * dispatch error with a clear field path instead of a half-populated page.
 *
 * Two variants — pick by whether the field's surrounding whitespace is
 * incidental (trim it) or content-bearing (preserve it):
 *
 * - `nonBlankString` — `.trim().min(1)`. Use for short identifier-/title-
 *   shaped fields where leading/trailing whitespace is incidental and
 *   normalization helps downstream consumers. Matches the posture
 *   already established by `lore-query action='ask'`'s `entity` schema
 *   and the issue #481 fix for `lore-fact action='create'` subject /
 *   object.
 *
 * - `nonBlankBody` — `.refine(value => value.trim().length > 0)`. Use for
 *   markdown page-body fields that round-trip into Notion via
 *   `pages.updateMarkdown`. Validation must NOT transform the value:
 *   stripping leading whitespace silently rewrites authored content
 *   (e.g. a body that starts with a four-space-indented Markdown code
 *   block becomes an unindented one). The blank check uses `trim()` only
 *   to compute the predicate; the original string is preserved.
 *
 * Update paths intentionally use plain `z.string()` (or richer clearable
 * schemas): on update, an empty string is the documented clear-the-field
 * sentinel for text properties, so the create-time guarantee does not
 * extend to update-time semantics.
 */

const NON_BLANK_MESSAGE = "must not be blank or whitespace-only"

export const nonBlankString = z.string().trim().min(1, NON_BLANK_MESSAGE)

export const nonBlankBody = z
  .string()
  .refine((value) => value.trim().length > 0, NON_BLANK_MESSAGE)
