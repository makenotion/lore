import { describe, expect, it } from "vitest"
import { parsePositiveDecimalInteger, parseUnitIntervalDecimal } from "./parse.js"

describe("parsePositiveDecimalInteger", () => {
  it("accepts positive decimal integers", () => {
    const result = parsePositiveDecimalInteger("--limit", "10")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe(10)
  })

  it("accepts leading zeros as unambiguous decimal input", () => {
    const result = parsePositiveDecimalInteger("--limit", "007")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe(7)
  })

  it("accepts Number.MAX_SAFE_INTEGER", () => {
    const result = parsePositiveDecimalInteger("--limit", String(Number.MAX_SAFE_INTEGER))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe(Number.MAX_SAFE_INTEGER)
  })

  it.each(["", "3.7", "3abc", "1e3", "+5", "-1", " 5", "5 "])(
    "rejects malformed decimal integer input %j",
    (raw) => {
      const result = parsePositiveDecimalInteger("--limit", raw)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.message).toContain("--limit")
        expect(result.message).toContain("positive decimal integer")
      }
    }
  )

  it("rejects zero", () => {
    const result = parsePositiveDecimalInteger("--limit", "0")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("positive integer")
  })

  it("rejects values outside the safe integer range", () => {
    const result = parsePositiveDecimalInteger("--limit", "9007199254740992")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("safe integer range")
  })
})

describe("parseUnitIntervalDecimal", () => {
  it.each([
    ["0", 0],
    ["0.5", 0.5],
    ["1", 1],
    ["1.0", 1],
    ["1.0000000000000000", 1],
  ])("accepts decimal unit interval input %j", (raw, expected) => {
    const result = parseUnitIntervalDecimal("--min-score", raw)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe(expected)
  })

  it.each([
    "",
    "0.5abc",
    "+0.5",
    "-0.1",
    "5e-1",
    ".5",
    "0.",
    " 0.5",
    "0.5 ",
    "1.0001",
    "1.0000000000000001",
    "1.0000000000000000000001",
    "2",
    "00.5",
    "007",
  ])("rejects malformed or out-of-range unit interval input %j", (raw) => {
    const result = parseUnitIntervalDecimal("--min-score", raw)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toBe(`--min-score must be a number in [0, 1], got "${raw}"`)
    }
  })
})
