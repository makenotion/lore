import { describe, expect, it } from "vitest"

import {
  RICH_TEXT_PROPERTY_MAX_LEN,
  validateRichTextMetadataFields,
} from "./rich-text-schema.js"

describe("validateRichTextMetadataFields", () => {
  it("pins the exact serialized rich_text cap error", () => {
    let caught: unknown

    try {
      validateRichTextMetadataFields(
        {
          alternatives: "x".repeat(RICH_TEXT_PROPERTY_MAX_LEN + 1),
          consequences: "x".repeat(RICH_TEXT_PROPERTY_MAX_LEN + 1),
        },
        "MemoryService.create"
      )
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe(
      `MemoryService.create: alternatives must be ${RICH_TEXT_PROPERTY_MAX_LEN} characters or fewer (Notion rich_text segment cap).; consequences must be ${RICH_TEXT_PROPERTY_MAX_LEN} characters or fewer (Notion rich_text segment cap).`
    )
  })
})
