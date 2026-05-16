import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { recordNotionRead, recordNotionWrite } from "../core/cost-accounting.js"
import { readLedgerEvents, resolveCostTracking } from "../core/cost-ledger.js"
import type { LoreServices } from "../services.js"
import { runMcpInvocationWithCostTracking } from "./cost-tracking.js"

const appendCostEventMock = vi.hoisted(() => vi.fn())

vi.mock("../core/cost-ledger.js", async () => {
  const actual = await vi.importActual<typeof import("../core/cost-ledger.js")>(
    "../core/cost-ledger.js"
  )
  appendCostEventMock.mockImplementation(actual.appendCostEvent)
  return {
    ...actual,
    appendCostEvent: appendCostEventMock,
  }
})

describe("MCP cost tracking", () => {
  const dirs: string[] = []
  const originalEnv = {
    agentName: process.env["LORE_AGENT_NAME"],
    sessionId: process.env["LORE_SESSION_ID"],
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    restoreEnv("LORE_AGENT_NAME", originalEnv.agentName)
    restoreEnv("LORE_SESSION_ID", originalEnv.sessionId)
    appendCostEventMock.mockClear()
  })

  it("runs disabled invocations without appending ledger rows or touching ledger files", async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-mcp-cost-"))
    dirs.push(root)
    const ledgerPath = join(root, "state", "ledger.jsonl")
    const costTracking = resolveCostTracking(
      { costTracking: { enabled: false, ledgerPath: "state/ledger.jsonl" } },
      root
    )
    const services = {
      costTracking,
      context: { project: { name: "Project" } },
    } as unknown as LoreServices
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    try {
      const result = await runMcpInvocationWithCostTracking(
        services,
        "lore-memory",
        { action: "save", title: "ignored while disabled" },
        async () => {
          recordNotionRead()
          recordNotionWrite()
          return {
            content: [{ type: "text", text: "visible response" }],
            costOutputs: { memoriesCreated: 1 },
          }
        }
      )

      expect(result).toEqual({
        content: [{ type: "text", text: "visible response" }],
        costOutputs: { memoriesCreated: 1 },
      })
      expect(await readLedgerEvents(costTracking)).toEqual([])
      expect(appendCostEventMock).not.toHaveBeenCalled()
      expect(existsSync(join(root, "state"))).toBe(false)
      expect(existsSync(ledgerPath)).toBe(false)
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      stderr.mockRestore()
    }
  })

  it("logs redacted invocation metrics without changing tool results", async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-mcp-cost-"))
    dirs.push(root)
    const costTracking = resolveCostTracking(
      { costTracking: { enabled: true, ledgerPath: "ledger.jsonl" } },
      root
    )
    const services = {
      costTracking,
      context: { project: { name: "Project" } },
    } as unknown as LoreServices
    process.env["LORE_AGENT_NAME"] = "TrustedAgent"
    process.env["LORE_SESSION_ID"] = "trusted-session"

    const result = await runMcpInvocationWithCostTracking(
      services,
      "lore-memory",
      {
        action: "save",
        projectName: "secret project scope",
        agent: "secret agent prompt",
        session: "secret session prompt",
        title: "secret title",
        content: "secret body",
      },
      async () => {
        recordNotionRead()
        recordNotionWrite()
        return {
          content: [{ type: "text", text: "visible response" }],
          costOutputs: { memoriesCreated: 1 },
        }
      }
    )

    expect(result.content[0]!.text).toBe("visible response")
    expect(costTracking.enabled).toBe(true)
    const rows = await readLedgerEvents(costTracking)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event).toMatchObject({
      eventType: "mcp.invocation",
      tool: "lore-memory",
      action: "save",
      status: "success",
      notion: { reads: 1, writes: 1 },
      outputs: { memoriesCreated: 1 },
      projectName: "Project",
      agentName: "TrustedAgent",
      sessionId: "trusted-session",
    })
    expect(rows[0]!.event).not.toMatchObject({
      projectName: "secret project scope",
      agentName: "secret agent prompt",
      sessionId: "secret session prompt",
    })
    expect(rows[0]!.line).not.toContain("secret title")
    expect(rows[0]!.line).not.toContain("secret project scope")
    expect(rows[0]!.line).not.toContain("secret agent prompt")
    expect(rows[0]!.line).not.toContain("secret session prompt")
    expect(rows[0]!.line).not.toContain("visible response")
  })

  it("does not copy raw MCP metadata into error rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-mcp-cost-"))
    dirs.push(root)
    const costTracking = resolveCostTracking(
      { costTracking: { enabled: true, ledgerPath: "ledger.jsonl" } },
      root
    )
    const services = {
      costTracking,
      context: { project: { name: "Project" } },
    } as unknown as LoreServices

    await expect(
      runMcpInvocationWithCostTracking(
        services,
        "lore-memory",
        {
          action: "secret action prompt",
          projectName: "secret project prompt",
          agent: "secret agent prompt",
          session: "secret session prompt",
        },
        async () => {
          throw new Error("validation failed")
        }
      )
    ).rejects.toThrow("validation failed")

    const rows = await readLedgerEvents(costTracking)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event).toMatchObject({
      eventType: "mcp.invocation",
      tool: "lore-memory",
      status: "error",
      projectName: "Project",
    })
    expect(rows[0]!.event).not.toHaveProperty("action")
    expect(rows[0]!.event).not.toHaveProperty("agentName")
    expect(rows[0]!.event).not.toHaveProperty("sessionId")
    expect(rows[0]!.line).not.toContain("secret action prompt")
    expect(rows[0]!.line).not.toContain("secret project prompt")
    expect(rows[0]!.line).not.toContain("secret agent prompt")
    expect(rows[0]!.line).not.toContain("secret session prompt")
  })
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}
