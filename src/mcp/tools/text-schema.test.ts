import { describe, expect, it } from "vitest"
import { nonBlankBody, nonBlankString } from "./text-schema.js"

describe("nonBlankString (trim variant — for identifier/title-shaped fields)", () => {
  it("accepts ordinary strings", () => {
    expect(nonBlankString.safeParse("hello").success).toBe(true)
  })

  it("accepts strings with internal whitespace", () => {
    expect(nonBlankString.safeParse("hello world").success).toBe(true)
  })

  it("trims leading/trailing whitespace from accepted values", () => {
    // `.trim()` transforms the value before `.min(1)` runs; downstream
    // services receive the normalized string. Matches the posture of
    // `lore-query action='ask'`'s `entity` schema.
    const result = nonBlankString.safeParse("  hello  ")
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBe("hello")
    }
  })

  it("rejects an empty string", () => {
    const result = nonBlankString.safeParse("")
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("blank")
    }
  })

  it("rejects whitespace-only strings", () => {
    for (const value of [" ", "  ", "\t", "\n", " \t\n "]) {
      expect(nonBlankString.safeParse(value).success).toBe(false)
    }
  })

  it("rejects non-string values", () => {
    expect(nonBlankString.safeParse(null).success).toBe(false)
    expect(nonBlankString.safeParse(undefined).success).toBe(false)
    expect(nonBlankString.safeParse(123).success).toBe(false)
  })
})

describe("nonBlankBody (preserving variant — for markdown page-body fields)", () => {
  it("accepts ordinary strings", () => {
    const result = nonBlankBody.safeParse("hello")
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBe("hello")
  })

  it("preserves leading/trailing whitespace verbatim", () => {
    // Markdown bodies must round-trip through Notion's
    // `pages.updateMarkdown` byte-identically — stripping leading
    // whitespace silently rewrites authored content (e.g. an
    // intentionally indented Markdown code block).
    const value = "  hello  "
    const result = nonBlankBody.safeParse(value)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBe(value)
  })

  it("preserves leading-newline content (e.g. content starting with blank line)", () => {
    const value = "\n\nfirst real line"
    const result = nonBlankBody.safeParse(value)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBe(value)
  })

  it("preserves indented-code-block bodies", () => {
    const value = "    const x = 1\n    return x"
    const result = nonBlankBody.safeParse(value)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBe(value)
  })

  it("rejects an empty string", () => {
    const result = nonBlankBody.safeParse("")
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("blank")
    }
  })

  it("rejects whitespace-only strings", () => {
    for (const value of [" ", "  ", "\t", "\n", " \t\n "]) {
      expect(nonBlankBody.safeParse(value).success).toBe(false)
    }
  })

  it("rejects non-string values", () => {
    expect(nonBlankBody.safeParse(null).success).toBe(false)
    expect(nonBlankBody.safeParse(undefined).success).toBe(false)
    expect(nonBlankBody.safeParse(123).success).toBe(false)
  })
})
