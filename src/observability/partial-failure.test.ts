import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { debugLogPartialFailures } from "./partial-failure.js"

function spyStderr() {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true)
}

describe("debugLogPartialFailures", () => {
  let priorDebug: string | undefined
  let stderr: ReturnType<typeof spyStderr>

  beforeEach(() => {
    priorDebug = process.env["LORE_DEBUG"]
    process.env["LORE_DEBUG"] = "1"
    stderr = spyStderr()
  })

  afterEach(() => {
    stderr.mockRestore()
    if (priorDebug === undefined) {
      delete process.env["LORE_DEBUG"]
    } else {
      process.env["LORE_DEBUG"] = priorDebug
    }
  })

  it("redacts page-id substrings in error messages but keeps explicit root id intact", () => {
    const id = "abcdef0123456789abcdef0123456789"
    const rootId = "fedcba9876543210fedcba9876543210"
    debugLogPartialFailures("lore-memory", [
      { rootId, error: new Error(`Failed to load page ${id}`) },
    ])
    const line = String(stderr.mock.calls[0]![0])
    expect(line).toContain("error=Failed to load page <page-id>")
    expect(line).toContain(`root=${rootId}`)
  })

  it("strips forward-compatible SDK body= leaks", () => {
    debugLogPartialFailures("lore-memory", [
      {
        rootId: "root-id",
        error: new Error('APIError body={"page":"secret"} status=500'),
      },
    ])
    const line = String(stderr.mock.calls[0]![0])
    expect(line).toContain("body=<redacted>")
    expect(line).not.toContain('"secret"')
  })

  it("preserves root id and tool for clean messages", () => {
    debugLogPartialFailures("lore-memory", [
      { rootId: "root-id-1", error: new Error("notion 429") },
    ])
    const line = String(stderr.mock.calls[0]![0])
    expect(line).toBe(
      "[lore] partial-failure: root=root-id-1 error=notion 429 tool=lore-memory\n"
    )
  })

  it("does not write when LORE_DEBUG is unset", () => {
    delete process.env["LORE_DEBUG"]
    debugLogPartialFailures("lore-memory", [
      { rootId: "root-id-1", error: new Error("notion 429") },
    ])
    expect(stderr).not.toHaveBeenCalled()
  })
})
