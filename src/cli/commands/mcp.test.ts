import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { trapProcessExit } from "../test-helpers.js"

const mocks = vi.hoisted(() => ({
  startServer: vi.fn(),
}))

vi.mock("../../mcp/server.js", () => ({
  startServer: mocks.startServer,
}))

import { mcpCommand } from "./mcp.js"

describe("mcp command", () => {
  let exitTrap: ReturnType<typeof trapProcessExit>
  let stderrSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mocks.startServer.mockReset()
    exitTrap = trapProcessExit()
    stderrSpy = vi.fn()
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrSpy(chunk)
      return true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("starts the MCP server", async () => {
    mocks.startServer.mockResolvedValue(undefined)

    await mcpCommand.parseAsync([], { from: "user" })

    expect(mocks.startServer).toHaveBeenCalledOnce()
    expect(exitTrap.exitCodes).toEqual([])
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it("redacts fatal startup failures on the bin-dispatch path", async () => {
    const pageId = "abcdef0123456789abcdef0123456789"
    const token = "development_ntn_abcdefghijklmnopqrstuvwxyz"
    const previousBackgroundAgent = process.env["LORE_BACKGROUND_AGENT"]
    process.env["LORE_BACKGROUND_AGENT"] = "true"
    const err = new Error(`background init failed for ${pageId} with ${token}\nretry`)
    err.stack =
      `Error: background init failed for ${pageId} with ${token}\n` +
      `    at secretFrame (/tmp/${pageId}.ts:1:1)`
    mocks.startServer.mockRejectedValue(err)

    try {
      await mcpCommand.parseAsync([], { from: "user" })

      expect(mocks.startServer).toHaveBeenCalledOnce()
      expect(exitTrap.exitCodes).toEqual([1])
      expect(stderrSpy).toHaveBeenCalledTimes(1)
      const line = String(stderrSpy.mock.calls[0][0])
      expect(line).toBe(
        "[lore] Fatal error: background init failed for <page-id> with <redacted-token> retry\n"
      )
      expect(line).not.toContain(pageId)
      expect(line).not.toContain(token)
      expect(line).not.toContain("secretFrame")
      expect(line.match(/\n/g)).toHaveLength(1)
    } finally {
      if (previousBackgroundAgent === undefined) {
        delete process.env["LORE_BACKGROUND_AGENT"]
      } else {
        process.env["LORE_BACKGROUND_AGENT"] = previousBackgroundAgent
      }
    }
  })
})
