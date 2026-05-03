import { z } from "zod"
import { SYNOPSIS_MAX } from "../types.js"

/** Notion rich_text property values are written as one segment by these paths. */
export const RICH_TEXT_PROPERTY_MAX_LEN = 2000

export function richTextPropertySchema(fieldName: string): z.ZodString {
  return (
    z
      .string()
      // Zod counts JavaScript string length (UTF-16 code units). Notion's
      // exact unit is undocumented, so this is intentionally conservative for
      // surrogate pairs while still preventing over-cap single-segment writes.
      .max(
        RICH_TEXT_PROPERTY_MAX_LEN,
        `${fieldName} must be ${RICH_TEXT_PROPERTY_MAX_LEN} characters or fewer (Notion rich_text segment cap).`
      )
  )
}

function synopsisPropertySchema(): z.ZodString {
  return z
    .string()
    .max(SYNOPSIS_MAX, `synopsis must be ${SYNOPSIS_MAX} characters or fewer.`)
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

const richTextMetadataFieldsSchema = z
  .object({
    alternatives: richTextPropertySchema("alternatives").optional(),
    consequences: richTextPropertySchema("consequences").optional(),
    author: richTextPropertySchema("author").optional(),
    agent: richTextPropertySchema("agent").optional(),
    keywords: richTextPropertySchema("keywords").optional(),
    synopsis: synopsisPropertySchema().optional(),
    session: richTextPropertySchema("session").optional(),
    blockedBy: richTextPropertySchema("blockedBy").optional(),
    entity: richTextPropertySchema("entity").optional(),
    topicKey: richTextPropertySchema("topicKey").optional(),
  })
  .passthrough()

/**
 * Validate raw metadata text before any HTML-entity decode pass. This mirrors
 * the MCP boundary behavior: encoded text does not get to exceed the cap and
 * then shrink under it during decoding.
 */
export function validateRichTextMetadataFields(
  input: Partial<Record<RichTextMetadataField, string | undefined>>,
  caller: string
): void {
  const result = richTextMetadataFieldsSchema.safeParse(input)
  if (result.success) return

  const message = result.error.issues
    .map((issue) => {
      const path = issue.path.join(".")
      if (!path || issue.message.startsWith(`${path} `)) return issue.message
      return `${path}: ${issue.message}`
    })
    .join("; ")
  throw new Error(`${caller}: ${message}`)
}
