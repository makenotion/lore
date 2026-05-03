import { z } from "zod"

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

const richTextMetadataFieldsSchema = z
  .object({
    alternatives: richTextPropertySchema("alternatives").optional(),
    consequences: richTextPropertySchema("consequences").optional(),
  })
  .passthrough()

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
 * Validate raw metadata text before any HTML-entity decode pass. This mirrors
 * the MCP boundary behavior: encoded text does not get to exceed the cap and
 * then shrink under it during decoding.
 */
export function validateRichTextMetadataFields(
  input: { alternatives?: string; consequences?: string },
  caller: string
): void {
  const result = richTextMetadataFieldsSchema.safeParse(input)
  if (result.success) return

  const message = result.error.issues
    .map((issue) => formatRichTextMetadataIssue(issue))
    .join("; ")
  throw new Error(`${caller}: ${message}`)
}
