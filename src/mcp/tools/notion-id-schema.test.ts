import { describe, expect, it } from "vitest"
import { notionPageIdSchema } from "./notion-id-schema.js"

describe("notionPageIdSchema", () => {
  it("accepts dashed UUID-shaped Notion page ids", () => {
    const id = "11111111-2222-3333-4444-555566667777"
    const result = notionPageIdSchema.safeParse(id)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBe(id)
  })

  it("accepts undashed 32-character hex ids and normalizes to dashed form", () => {
    // Notion page URLs surface ids without dashes:
    // `notion.so/<title>-1f1e2d3c4b5a69788796a5b4c3d2e1f0`. The schema
    // accepts that shape and rewrites it so downstream code sees one
    // canonical form regardless of where the caller pasted from.
    const undashed = "1f1e2d3c4b5a69788796a5b4c3d2e1f0"
    const result = notionPageIdSchema.safeParse(undashed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBe("1f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0")
    }
  })

  it("accepts mixed-case hex in either form and lower-cases to canonical output", () => {
    // Notion's API returns lowercase, but a paste from a clipboard
    // manager or a hand-typed id may carry uppercase. The transform
    // lower-cases after hyphenating so `AaBb…` and `aabb…` (the same
    // Notion page) collapse to one canonical string — without this,
    // downstream dedup `Set<string>`s and id-keyed caches would treat
    // them as two distinct pages.
    const mixedDashed = "AaBbCcDd-1234-5678-9aBc-DeF012345678"
    const mixedUndashed = "AaBbCcDd123456789aBcDeF012345678"
    const expected = "aabbccdd-1234-5678-9abc-def012345678"

    const dashedResult = notionPageIdSchema.safeParse(mixedDashed)
    expect(dashedResult.success).toBe(true)
    if (dashedResult.success) expect(dashedResult.data).toBe(expected)

    const undashedResult = notionPageIdSchema.safeParse(mixedUndashed)
    expect(undashedResult.success).toBe(true)
    if (undashedResult.success) expect(undashedResult.data).toBe(expected)
  })

  it("normalizes case-variants of the same id to the same canonical output", () => {
    // Pins the dedup invariant the doc comment promises: two pastes
    // of the same Notion page differing only in case (mixed-case vs
    // lowercase, dashed vs undashed) all collapse to one string.
    const variants = [
      "AaBbCcDd-1234-5678-9aBc-DeF012345678",
      "aabbccdd-1234-5678-9abc-def012345678",
      "AABBCCDD-1234-5678-9ABC-DEF012345678",
      "AaBbCcDd123456789aBcDeF012345678",
      "aabbccdd123456789abcdef012345678",
    ]
    const canonical = variants.map((v) => {
      const result = notionPageIdSchema.safeParse(v)
      expect(result.success).toBe(true)
      return result.success ? result.data : null
    })
    expect(new Set(canonical).size).toBe(1)
    expect(canonical[0]).toBe("aabbccdd-1234-5678-9abc-def012345678")
  })

  it("trims surrounding whitespace before validation", () => {
    const result = notionPageIdSchema.safeParse("  1f1e2d3c4b5a69788796a5b4c3d2e1f0  ")
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBe("1f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0")
    }
  })

  it("rejects empty and whitespace-only strings", () => {
    for (const value of ["", " ", "  ", "\t", "\n", " \t\n "]) {
      expect(notionPageIdSchema.safeParse(value).success).toBe(false)
    }
  })

  it("rejects strings of the wrong length", () => {
    // 31 hex chars (one short of undashed)
    expect(notionPageIdSchema.safeParse("1f1e2d3c4b5a69788796a5b4c3d2e1f").success).toBe(
      false
    )
    // 33 hex chars (one long)
    expect(
      notionPageIdSchema.safeParse("1f1e2d3c4b5a69788796a5b4c3d2e1f01").success
    ).toBe(false)
  })

  it("rejects strings with non-hex characters", () => {
    // 32 chars but contains a `g`
    expect(notionPageIdSchema.safeParse("1f1e2d3c4b5a69788796a5b4c3d2e1g0").success).toBe(
      false
    )
  })

  it("rejects malformed dashed shapes", () => {
    // Right total length but wrong dash positions
    expect(
      notionPageIdSchema.safeParse("1f1e2d3c-4b5a-6978-8796a5b4c3d2-e1f0").success
    ).toBe(false)
  })

  it("rejects non-string values", () => {
    expect(notionPageIdSchema.safeParse(null).success).toBe(false)
    expect(notionPageIdSchema.safeParse(undefined).success).toBe(false)
    expect(notionPageIdSchema.safeParse(123).success).toBe(false)
  })
})
