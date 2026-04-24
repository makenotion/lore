import { describe, expect, it } from "vitest"
import { settleAll } from "./settle.js"

describe("settleAll", () => {
  it("returns all fulfilled when every promise resolves", async () => {
    const { fulfilled, failures } = await settleAll([
      ["a", Promise.resolve(1)] as const,
      ["b", Promise.resolve(2)] as const,
      ["c", Promise.resolve(3)] as const,
    ])

    expect(failures).toEqual([])
    expect(fulfilled).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ])
  })

  it("splits fulfilled from failed and preserves input order in failures", async () => {
    const boom = new Error("bad root")
    const { fulfilled, failures } = await settleAll([
      ["a", Promise.resolve(1)] as const,
      ["b", Promise.reject(boom)] as const,
      ["c", Promise.resolve(3)] as const,
    ])

    expect(fulfilled).toEqual([
      ["a", 1],
      ["c", 3],
    ])
    expect(failures).toEqual([{ key: "b", error: boom }])
  })

  it("permits duplicate keys — keys are tagged context, not a map", async () => {
    const { fulfilled } = await settleAll([
      ["x", Promise.resolve(1)] as const,
      ["x", Promise.resolve(2)] as const,
    ])

    // Both entries land in `fulfilled` under the repeated key; caller
    // decides how to resolve the duplicate (last-wins, merge, etc).
    expect(fulfilled.map(([k]) => k)).toEqual(["x", "x"])
    expect(fulfilled.map(([, v]) => v)).toEqual([1, 2])
  })

  it("works with object keys (identity-based, not string)", async () => {
    const keyA = { name: "a" }
    const keyB = { name: "b" }
    const { fulfilled } = await settleAll([
      [keyA, Promise.resolve(1)] as const,
      [keyB, Promise.resolve(2)] as const,
    ])

    expect(fulfilled[0][0]).toBe(keyA)
    expect(fulfilled[1][0]).toBe(keyB)
  })

  it("returns empty buckets for empty input", async () => {
    const { fulfilled, failures } = await settleAll([])
    expect(fulfilled).toEqual([])
    expect(failures).toEqual([])
  })

  it("preserves input order across multiple failures", async () => {
    // Pin the ordering contract: the comment in `settle.ts` says iteration
    // order is preserved, and the doc promises it. Future refactors that
    // flip the traversal would change which root's error lands first in
    // the tool's warning string.
    const err1 = new Error("fail b")
    const err2 = new Error("fail d")
    const { fulfilled, failures } = await settleAll([
      ["a", Promise.resolve(1)] as const,
      ["b", Promise.reject(err1)] as const,
      ["c", Promise.resolve(3)] as const,
      ["d", Promise.reject(err2)] as const,
    ])

    expect(fulfilled.map(([k]) => k)).toEqual(["a", "c"])
    expect(failures.map(({ key }) => key)).toEqual(["b", "d"])
    expect(failures[0].error).toBe(err1)
    expect(failures[1].error).toBe(err2)
  })
})
