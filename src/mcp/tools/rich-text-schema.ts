import { z } from "zod"

/** Notion rich_text property values are written as one segment by these tools. */
export const RICH_TEXT_PROPERTY_MAX_LEN = 2000

export function richTextPropertySchema(fieldName: string): z.ZodString {
  return z
    .string()
    .max(
      RICH_TEXT_PROPERTY_MAX_LEN,
      `${fieldName} must be ${RICH_TEXT_PROPERTY_MAX_LEN} characters or fewer (Notion rich_text segment cap).`
    )
}
