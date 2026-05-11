import { describe, expect, it } from "vitest"
import { tagsSchema, keywordsSchema } from "./tag-schema.js"

describe("tagsSchema", () => {
  it("accepts tags from the closed vocabulary", () => {
    const result = tagsSchema.safeParse(["ios", "performance", "code-review"])
    expect(result.success).toBe(true)
  })

  it("accepts the empty array", () => {
    const result = tagsSchema.safeParse([])
    expect(result.success).toBe(true)
  })

  it("rejects PR-number tags with an error naming the bad values", () => {
    const result = tagsSchema.safeParse(["pr-1234"])
    expect(result.success).toBe(false)
    if (result.success) return
    const message = result.error.issues[0].message
    expect(message).toContain(`"pr-1234"`)
  })

  it("rejects out-of-vocab tags with guidance pointing at `keywords`", () => {
    const result = tagsSchema.safeParse(["WidgetListStore.swift"])
    expect(result.success).toBe(false)
    if (result.success) return
    const message = result.error.issues[0].message
    expect(message.toLowerCase()).toContain("keywords")
  })

  it("lists the accepted vocabulary in the error message", () => {
    const result = tagsSchema.safeParse(["not-a-real-tag"])
    expect(result.success).toBe(false)
    if (result.success) return
    const message = result.error.issues[0].message
    // A couple of sentinel vocabulary entries must appear so agents see the
    // full set and can pick a valid replacement.
    expect(message).toContain("ios")
    expect(message).toContain("performance")
    expect(message).toContain("gotcha")
  })

  it("aggregates multiple invalid tags into a single issue", () => {
    const result = tagsSchema.safeParse([
      "ios",
      "pr-1234",
      "SENTRY-APP-2DY",
      "performance",
    ])
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.length).toBe(1)
    const message = result.error.issues[0].message
    expect(message).toContain("pr-1234")
    expect(message).toContain("SENTRY-APP-2DY")
  })

  it("rejects non-string array elements before the vocab check runs", () => {
    // Public contract: the underlying z.array(z.string()) already rejects
    // non-strings. Guard the assertion so a future refactor to z.enum
    // doesn't silently change the error shape for numeric / null inputs.
    const result = tagsSchema.safeParse([123, null])
    expect(result.success).toBe(false)
  })
})

describe("keywordsSchema", () => {
  it("accepts free-form space-separated tokens", () => {
    const result = keywordsSchema.safeParse("pr-1234 WidgetListStore.swift SENTRY-123")
    expect(result.success).toBe(true)
  })

  it("accepts the empty string", () => {
    const result = keywordsSchema.safeParse("")
    expect(result.success).toBe(true)
  })

  it("rejects strings exceeding Notion's 2000-char rich_text segment cap", () => {
    const result = keywordsSchema.safeParse("x".repeat(2001))
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0].message).toContain("2000")
  })

  it("accepts exactly 2000 chars (boundary)", () => {
    const result = keywordsSchema.safeParse("x".repeat(2000))
    expect(result.success).toBe(true)
  })
})
