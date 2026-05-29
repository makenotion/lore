import { describe, expect, it } from "vitest"
import type { PageObjectResponse } from "@notionhq/client"
import { extractNumber } from "./extractors.js"

type PropertyValue = PageObjectResponse["properties"][string]

describe("extractNumber", () => {
  it("returns the populated number on a number property", () => {
    const prop = { type: "number", number: 0.85 } as unknown as PropertyValue
    expect(extractNumber(prop)).toBe(0.85)
  })

  it("returns null when the number property is empty", () => {
    // Notion serialises a cleared number column as `{ type: "number",
    // number: null }`. The extractor must surface this as `null` so the
    // downstream domain shape stays closed (`number | null`) and ranking code
    // can distinguish "never scored" from "scored zero."
    const prop = { type: "number", number: null } as unknown as PropertyValue
    expect(extractNumber(prop)).toBeNull()
  })

  it("returns null when the property is missing entirely (pre-migration page)", () => {
    // A vault without a numeric column has no property value at all. The
    // extractor must accept this without throwing so legacy pages keep loading
    // cleanly through the page mappers.
    expect(extractNumber(undefined)).toBeNull()
  })

  it("returns null when the property is the wrong type (defensive)", () => {
    // Mirror of how `extractDate`/`extractRichText` defend against a
    // schema rename or a tooling bug that hands the extractor a
    // populated-but-mismatched property. Returning the documented default
    // (null) keeps reads non-fatal.
    const prop = { type: "rich_text", rich_text: [] } as unknown as PropertyValue
    expect(extractNumber(prop)).toBeNull()
  })

  it("preserves zero as a valid populated value (not coerced to null)", () => {
    // `0` is a meaningful Confidence Score. The extractor must not collapse it
    // to null; downstream code distinguishes "never scored" (null) from
    // "scored to zero" (0).
    const prop = { type: "number", number: 0 } as unknown as PropertyValue
    expect(extractNumber(prop)).toBe(0)
  })
})
