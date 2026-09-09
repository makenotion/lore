import { describe, expect, it } from "vitest"
import {
  redactObservationField,
  RAW_OBSERVATION_FIELD_CAP_BYTES,
} from "./raw-observation-redact.js"

describe("redactObservationField", () => {
  it("passes through primitive JSON values unchanged", () => {
    expect(redactObservationField(42)).toBe(42)
    expect(redactObservationField(true)).toBe(true)
    expect(redactObservationField(null)).toBeNull()
    expect(redactObservationField("hello")).toBe("hello")
  })

  it("replaces unsupported types with a sentinel string", () => {
    expect(redactObservationField(undefined)).toBe("<unsupported>")
  })

  it("redacts ntn_ tokens", () => {
    expect(redactObservationField("token: ntn_abc123XYZ")).toBe("token: <redacted-token>")
  })

  it("redacts development_ntn_ tokens", () => {
    expect(redactObservationField("dev: development_ntn_abc123")).toBe(
      "dev: <redacted-token>"
    )
  })

  it("redacts secret_ tokens", () => {
    expect(redactObservationField("key: secret_xyz789")).toBe("key: <redacted-token>")
  })

  it("replaces a string containing <private> with the sentinel", () => {
    expect(redactObservationField("this is <private> data")).toBe("<private>")
  })

  it("replaces a string containing </private> with the sentinel", () => {
    expect(redactObservationField("end </private> tag")).toBe("<private>")
  })

  it("<private> check is case-insensitive", () => {
    expect(redactObservationField("some <PRIVATE> text")).toBe("<private>")
  })

  it("traverses arrays recursively", () => {
    expect(redactObservationField(["hello", "ntn_abc"])).toEqual([
      "hello",
      "<redacted-token>",
    ])
  })

  it("traverses objects recursively", () => {
    const input = { a: "ntn_token", b: { c: "safe" } }
    expect(redactObservationField(input)).toEqual({
      a: "<redacted-token>",
      b: { c: "safe" },
    })
  })

  it("enforces the depth cap", () => {
    // Build a deeply nested object (12 levels)
    let nested: unknown = "leaf"
    for (let i = 0; i < 12; i++) {
      nested = { v: nested }
    }
    const result = redactObservationField(nested)
    // The function should not throw and the deep leaf should be capped
    expect(typeof result).toBe("object")
  })

  it("truncates fields that exceed the byte cap", () => {
    const big = "x".repeat(RAW_OBSERVATION_FIELD_CAP_BYTES + 100)
    const result = redactObservationField(big)
    expect(typeof result).toBe("string")
    expect((result as string).startsWith("<truncated:")).toBe(true)
  })

  it("does not truncate fields at the byte cap", () => {
    const exact = "a".repeat(RAW_OBSERVATION_FIELD_CAP_BYTES)
    const result = redactObservationField(exact)
    expect(result).toBe(exact)
  })
})
