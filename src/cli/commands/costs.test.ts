import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { COST_LEDGER_SCHEMA_VERSION, payloadSummary } from "../../core/cost-ledger.js"
import { trapProcessExit } from "../test-helpers.js"
import { costsCommand } from "./costs.js"

const COST_EXPORT_CSV_HEADER = [
  "timestamp",
  "eventType",
  "source",
  "status",
  "projectName",
  "agentName",
  "sessionId",
  "tool",
  "action",
  "durationMs",
  "inputBytes",
  "outputBytes",
  "estimatedInputTokens",
  "estimatedOutputTokens",
  "notionReads",
  "notionWrites",
  "notionFailures",
  "notionRateLimitBackoffs",
  "modelProvider",
  "model",
  "modelUsageEstimated",
  "estimatedUsd",
  "costUnknownReason",
].join(",")

describe("costs command", () => {
  let dir: string
  let logSpy: ReturnType<typeof vi.fn>
  let errorSpy: ReturnType<typeof vi.fn>
  let exitTrap: ReturnType<typeof trapProcessExit>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-costs-command-"))
    logSpy = vi.fn()
    errorSpy = vi.fn()
    vi.spyOn(console, "log").mockImplementation(logSpy)
    vi.spyOn(console, "error").mockImplementation(errorSpy)
    vi.spyOn(process, "cwd").mockReturnValue(dir)
    exitTrap = trapProcessExit()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  function writeCostTrackingConfig(): void {
    mkdirSync(join(dir, "state"))
    writeFileSync(
      join(dir, ".lore.yaml"),
      `
vault:
  pageId: abc123
costTracking:
  enabled: true
  ledgerPath: state/costs.jsonl
`
    )
  }

  function writeMcpLedgerEvent(timestamp: string): void {
    writeFileSync(
      join(dir, "state", "costs.jsonl"),
      JSON.stringify({
        schemaVersion: COST_LEDGER_SCHEMA_VERSION,
        timestamp,
        eventType: "mcp.invocation",
        source: "host_agent",
        status: "success",
        tool: "lore-query",
        action: "search",
        payload: payloadSummary("{}", "ok"),
        notion: { reads: 1, writes: 0, failures: 0, rateLimitBackoffs: 0 },
      }) + "\n"
    )
  }

  it("renders a summary from the configured ledger and skips invalid rows", async () => {
    mkdirSync(join(dir, "state"))
    writeFileSync(
      join(dir, ".lore.yaml"),
      `
vault:
  pageId: abc123
costTracking:
  enabled: true
  ledgerPath: state/costs.jsonl
`
    )
    writeFileSync(
      join(dir, "state", "costs.jsonl"),
      [
        JSON.stringify({
          schemaVersion: COST_LEDGER_SCHEMA_VERSION,
          timestamp: new Date().toISOString(),
          eventType: "mcp.invocation",
          source: "host_agent",
          status: "success",
          tool: "lore-query",
          action: "search",
          payload: payloadSummary("{}", "ok"),
          notion: { reads: 1, writes: 0, failures: 0, rateLimitBackoffs: 0 },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          eventType: "mcp.invocation",
          status: "success",
          projectName: "SECRET_INVALID_ROW",
        }),
      ].join("\n") + "\n"
    )

    await costsCommand.parseAsync(["summary"], { from: "user" })

    const output = logSpy.mock.calls.flat().join("\n")
    expect(output).toContain("MCP calls: 1 total")
    expect(output).not.toContain("SECRET_INVALID_ROW")
    expect(exitTrap.exitCodes).toEqual([])
  })

  it("exports CSV from valid ledger rows while skipping invalid rows", async () => {
    mkdirSync(join(dir, "state"))
    writeFileSync(
      join(dir, ".lore.yaml"),
      `
vault:
  pageId: abc123
costTracking:
  enabled: true
  ledgerPath: state/costs.jsonl
`
    )
    writeFileSync(
      join(dir, "state", "costs.jsonl"),
      [
        JSON.stringify({
          schemaVersion: COST_LEDGER_SCHEMA_VERSION,
          timestamp: new Date().toISOString(),
          eventType: "mcp.invocation",
          source: "host_agent",
          status: "success",
          tool: "lore-query",
          action: "search",
          payload: payloadSummary("{}", "ok"),
          notion: { reads: 1, writes: 0, failures: 0, rateLimitBackoffs: 0 },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          eventType: "mcp.invocation",
          status: "success",
          projectName: "SECRET_INVALID_ROW",
        }),
      ].join("\n") + "\n"
    )

    await costsCommand.parseAsync(["export", "--format", "csv"], { from: "user" })

    const output = logSpy.mock.calls.flat().join("\n")
    expect(output).toContain("timestamp,eventType,source,status")
    expect(output).toContain("lore-query,search")
    expect(output).not.toContain("SECRET_INVALID_ROW")
    expect(exitTrap.exitCodes).toEqual([])
  })

  it("exports no JSONL stdout when no ledger rows match", async () => {
    writeCostTrackingConfig()
    writeMcpLedgerEvent("2026-04-15T12:00:00.000Z")

    await costsCommand.parseAsync(["export", "--month", "2026-05"], {
      from: "user",
    })

    expect(logSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
    expect(exitTrap.exitCodes).toEqual([])
  })

  it("exports only the CSV header when no ledger rows match", async () => {
    writeCostTrackingConfig()
    writeMcpLedgerEvent("2026-04-15T12:00:00.000Z")

    await costsCommand.parseAsync(["export", "--format", "csv", "--month", "2026-05"], {
      from: "user",
    })

    expect(logSpy.mock.calls.flat()).toEqual([COST_EXPORT_CSV_HEADER])
    expect(errorSpy).not.toHaveBeenCalled()
    expect(exitTrap.exitCodes).toEqual([])
  })

  it("exits 1 when --since and --month are combined", async () => {
    writeFileSync(
      join(dir, ".lore.yaml"),
      `
vault:
  pageId: abc123
costTracking:
  enabled: true
`
    )

    await costsCommand.parseAsync(["summary", "--since", "24h", "--month", "2026-05"], {
      from: "user",
    })

    expect(errorSpy.mock.calls.flat().join("\n")).toContain(
      "--since and --month cannot be combined"
    )
    expect(exitTrap.exitCodes).toEqual([1])
  })
})
