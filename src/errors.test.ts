import { describe, expect, it } from "vitest"

import { LoreError, errorCauseMessage, isLoreError, loreErrorExitCode } from "./errors.js"

describe("LoreError", () => {
  it("carries a stable kind, structured details, and Error cause", () => {
    const cause = new Error("notion 503")
    const err = new LoreError(
      "memory-create-partial",
      "memory row landed but body write failed",
      {
        pageId: "mem-1",
        cleanedUp: false,
        bodyWriteCauseMessage: "notion 503",
      },
      { cause }
    )

    expect(err).toBeInstanceOf(Error)
    expect(isLoreError(err)).toBe(true)
    expect(err.kind).toBe("memory-create-partial")
    expect(err.details).toEqual({
      pageId: "mem-1",
      cleanedUp: false,
      bodyWriteCauseMessage: "notion 503",
    })
    expect(err.cause).toBe(cause)
  })

  it("maps user-correctable and temporary kinds to distinct CLI exits", () => {
    const userError = new LoreError("memory-read-only", "read-only", {
      memoryId: "mem-1",
      memoryTitle: "Pinned policy",
    })
    const temporaryError = new LoreError(
      "transient-project-resolution",
      "project lookup failed",
      {
        names: ["Docs"],
        scopeFields: "--project",
        causeMessage: "notion 503",
      }
    )

    expect(loreErrorExitCode(userError)).toBe(2)
    expect(loreErrorExitCode(temporaryError)).toBe(75)
    expect(loreErrorExitCode(new Error("plain"), 9)).toBe(9)
  })
})

describe("errorCauseMessage", () => {
  it("normalizes common cause shapes", () => {
    expect(errorCauseMessage(new Error("boom"))).toBe("boom")
    expect(errorCauseMessage("string failure")).toBe("string failure")
    expect(errorCauseMessage(undefined, "fallback")).toBe("fallback")
  })
})
