import { describe, expect, it } from "vitest"
import { clearableYmdDateSchema, ymdDateSchema } from "./date-schema.js"

describe("MCP date schemas", () => {
  it("accepts strict YYYY-MM-DD dates", () => {
    expect(ymdDateSchema.safeParse("2026-05-03").success).toBe(true)
  })

  it("rejects empty strings on strict date fields", () => {
    const parsed = ymdDateSchema.safeParse("")

    expect(parsed.success).toBe(false)
  })

  it("normalizes empty strings to null on clearable date fields", () => {
    const parsed = clearableYmdDateSchema.safeParse("")

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data).toBeNull()
  })

  it("passes through explicit null on clearable date fields", () => {
    const parsed = clearableYmdDateSchema.safeParse(null)

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data).toBeNull()
  })

  it("rejects malformed clearable date strings", () => {
    const parsed = clearableYmdDateSchema.safeParse("05/03/2026")

    expect(parsed.success).toBe(false)
  })
})
