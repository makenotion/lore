import { z } from "zod"
import { SYNOPSIS_MAX } from "../types.js"

/** Notion rich_text property values are written as one segment by these paths. */
export const RICH_TEXT_PROPERTY_MAX_LEN = 2000

type RichTextMetadataFieldName = "alternatives" | "consequences"

const RICH_TEXT_METADATA_FIELD_NAMES = new Set<string>(["alternatives", "consequences"])

function richTextPropertyErrorMessage(fieldName: string): string {
  return `${fieldName} must be ${RICH_TEXT_PROPERTY_MAX_LEN} characters or fewer (Notion rich_text segment cap).`
}

export function richTextPropertySchema(fieldName: string): z.ZodString {
  return (
    z
      .string()
      // Zod counts JavaScript string length (UTF-16 code units). Notion's
      // exact unit is undocumented, so this is intentionally conservative for
      // surrogate pairs while still preventing over-cap single-segment writes.
      .max(RICH_TEXT_PROPERTY_MAX_LEN, richTextPropertyErrorMessage(fieldName))
  )
}

export interface RichTextMetadataValidationOptions {
  synopsisMaxChars?: number
}

function synopsisPropertySchema(maxChars = SYNOPSIS_MAX): z.ZodString {
  return z.string().max(maxChars, `synopsis must be ${maxChars} characters or fewer.`)
}

type RichTextMetadataField =
  | "alternatives"
  | "consequences"
  | "author"
  | "agent"
  | "keywords"
  | "synopsis"
  | "session"
  | "blockedBy"
  | "entity"
  | "topicKey"
  | "promotionSourceKey"

function richTextMetadataFieldsSchema(options: RichTextMetadataValidationOptions = {}) {
  const synopsisMaxChars = options.synopsisMaxChars ?? SYNOPSIS_MAX
  return z
    .object({
      alternatives: richTextPropertySchema("alternatives").optional(),
      consequences: richTextPropertySchema("consequences").optional(),
      author: richTextPropertySchema("author").optional(),
      agent: richTextPropertySchema("agent").optional(),
      keywords: richTextPropertySchema("keywords").optional(),
      synopsis: synopsisPropertySchema(synopsisMaxChars).optional(),
      session: richTextPropertySchema("session").optional(),
      blockedBy: richTextPropertySchema("blockedBy").optional(),
      entity: richTextPropertySchema("entity").optional(),
      topicKey: richTextPropertySchema("topicKey").optional(),
      promotionSourceKey: richTextPropertySchema("promotionSourceKey").optional(),
    })
    .passthrough()
}

function isRichTextMetadataFieldName(
  fieldName: string
): fieldName is RichTextMetadataFieldName {
  return RICH_TEXT_METADATA_FIELD_NAMES.has(fieldName)
}

function formatRichTextMetadataIssue(issue: z.ZodIssue): string {
  const path = issue.path.join(".")
  const fieldName = issue.path[0]

  if (
    issue.code === z.ZodIssueCode.too_big &&
    issue.type === "string" &&
    issue.maximum === RICH_TEXT_PROPERTY_MAX_LEN &&
    issue.inclusive === true &&
    issue.path.length === 1 &&
    typeof fieldName === "string" &&
    isRichTextMetadataFieldName(fieldName)
  ) {
    return richTextPropertyErrorMessage(fieldName)
  }

  if (!path) return issue.message
  return `${path}: ${issue.message}`
}

/**
 * Validate raw metadata text before any HTML-entity decode pass. For
 * agent-facing fields this mirrors the MCP boundary behavior: encoded text
 * does not get to exceed the cap and then shrink under it during decoding.
 */
export function validateRichTextMetadataFields(
  input: Partial<Record<RichTextMetadataField, string | undefined>>,
  caller: string,
  options: RichTextMetadataValidationOptions = {}
): void {
  const result = richTextMetadataFieldsSchema(options).safeParse(input)
  if (result.success) return

  const message = result.error.issues
    .map((issue) => formatRichTextMetadataIssue(issue))
    .join("; ")
  throw new Error(`${caller}: ${message}`)
}
