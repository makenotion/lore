import { describe, expect, it } from "vitest"
import {
  computeContentHash,
  DEDUP_WINDOW_MS,
  RAW_OBSERVATION_TAIL_LINES,
} from "./raw-observation-dedup.js"

describe("computeContentHash", () => {
  it("returns a 64-character hex string", () => {
    const hash = computeContentHash("Bash", { cmd: "ls" }, "output")
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("is stable for the same inputs", () => {
    const a = computeContentHash("Read", { path: "/foo" }, { content: "bar" })
    const b = computeContentHash("Read", { path: "/foo" }, { content: "bar" })
    expect(a).toBe(b)
  })

  it("differs when toolName differs", () => {
    const a = computeContentHash("Read", {}, {})
    const b = computeContentHash("Write", {}, {})
    expect(a).not.toBe(b)
  })

  it("differs when input differs", () => {
    const a = computeContentHash("Read", { x: 1 }, {})
    const b = computeContentHash("Read", { x: 2 }, {})
    expect(a).not.toBe(b)
  })

  it("differs when output differs", () => {
    const a = computeContentHash("Read", {}, "foo")
    const b = computeContentHash("Read", {}, "bar")
    expect(a).not.toBe(b)
  })

  it("is stable regardless of object key insertion order", () => {
    const a = computeContentHash("T", { b: 2, a: 1 }, null)
    const b = computeContentHash("T", { a: 1, b: 2 }, null)
    expect(a).toBe(b)
  })
})

describe("constants", () => {
  it("DEDUP_WINDOW_MS is 5 minutes", () => {
    expect(DEDUP_WINDOW_MS).toBe(5 * 60 * 1_000)
  })

  it("RAW_OBSERVATION_TAIL_LINES is exported and positive", () => {
    expect(RAW_OBSERVATION_TAIL_LINES).toBeGreaterThan(0)
  })
})
