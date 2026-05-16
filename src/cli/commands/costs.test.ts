import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  COST_LEDGER_SCHEMA_VERSION,
  costLedgerShardPath,
  payloadSummary,
} from "../../core/cost-ledger.js"
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
  let warnSpy: ReturnType<typeof vi.fn>
  let exitTrap: ReturnType<typeof trapProcessExit>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-costs-command-"))
    logSpy = vi.fn()
    errorSpy = vi.fn()
    warnSpy = vi.fn()
    vi.spyOn(console, "log").mockImplementation(logSpy)
    vi.spyOn(console, "error").mockImplementation(errorSpy)
    vi.spyOn(console, "warn").mockImplementation(warnSpy)
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

  function mcpLedgerLine(timestamp: string, action: string): string {
    return (
      JSON.stringify({
        schemaVersion: COST_LEDGER_SCHEMA_VERSION,
        timestamp,
        eventType: "mcp.invocation",
        source: "host_agent",
        status: "success",
        tool: "lore-query",
        action,
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
          schemaVersion: COST_LEDGER_SCHEMA_VERSION,
          timestamp: new Date().toISOString(),
          eventType: "autosave.background_model",
          source: "hook",
          status: "success",
          payload: payloadSummary("autosave prompt"),
          modelUsage: {
            provider: "openai",
            model: "gpt-5.2-codex",
            inputTokens: 1000,
            estimated: true,
            source: "prompt_estimate",
          },
          estimatedCost: {
            usd: 0.00175,
            pricingSource: "builtin-openai-2026-05",
            estimated: true,
          },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          eventType: "mcp.invocation",
          status: "success",
          projectName: "SECRET_INVALID_ROW",
        }),
        "{not json",
      ].join("\n") + "\n"
    )

    await costsCommand.parseAsync(["summary"], { from: "user" })

    const output = logSpy.mock.calls.flat().join("\n")
    const warning = warnSpy.mock.calls.flat().join("\n")
    expect(output).toContain("MCP calls: 1 total")
    expect(output).toContain("background prompt estimates")
    expect(output).not.toContain("SECRET_INVALID_ROW")
    expect(warning).toContain("skipped 2 malformed cost ledger lines")
    expect(warning).not.toContain("SECRET_INVALID_ROW")
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
    expect(warnSpy.mock.calls.flat().join("\n")).toContain(
      "skipped 1 malformed cost ledger line"
    )
    expect(exitTrap.exitCodes).toEqual([])
  })

  it("keeps JSONL export stdout parseable and writes malformed-row warnings to stderr", async () => {
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
        "",
        JSON.stringify({
          timestamp: new Date().toISOString(),
          eventType: "mcp.invocation",
          status: "success",
          projectName: "SECRET_INVALID_ROW",
        }),
        "{not json",
      ].join("\n") + "\n"
    )

    await costsCommand.parseAsync(["export", "--format", "jsonl"], { from: "user" })

    const output = logSpy.mock.calls.flat().join("\n")
    const warning = warnSpy.mock.calls.flat().join("\n")
    const exported = output
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(exported).toHaveLength(1)
    expect(exported[0]?.["tool"]).toBe("lore-query")
    expect(output).not.toContain("Warning:")
    expect(output).not.toContain("SECRET_INVALID_ROW")
    expect(warning).toContain("skipped 2 malformed cost ledger lines")
    expect(warning).not.toContain("SECRET_INVALID_ROW")
    expect(errorSpy).not.toHaveBeenCalled()
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

  it("summarizes legacy and process-shard ledger rows", async () => {
    writeCostTrackingConfig()
    const ledgerPath = join(dir, "state", "costs.jsonl")
    const timestamp = new Date().toISOString()
    writeFileSync(ledgerPath, mcpLedgerLine(timestamp, "legacy"))
    writeFileSync(
      costLedgerShardPath(ledgerPath, 101),
      mcpLedgerLine(timestamp, "shard-101")
    )
    writeFileSync(
      costLedgerShardPath(ledgerPath, 202),
      mcpLedgerLine(timestamp, "shard-202")
    )

    await costsCommand.parseAsync(["summary"], { from: "user" })

    const output = logSpy.mock.calls.flat().join("\n")
    expect(output).toContain("MCP calls: 3 total")
    expect(output).toContain("lore-query legacy: 1 success")
    expect(output).toContain("lore-query shard-101: 1 success")
    expect(output).toContain("lore-query shard-202: 1 success")
    expect(exitTrap.exitCodes).toEqual([])
  })

  it("exports merged ledger rows in deterministic order", async () => {
    writeCostTrackingConfig()
    const ledgerPath = join(dir, "state", "costs.jsonl")
    const tiedTimestamp = "2026-05-15T10:00:00.000Z"
    writeFileSync(ledgerPath, mcpLedgerLine(tiedTimestamp, "legacy"))
    writeFileSync(
      costLedgerShardPath(ledgerPath, 202),
      mcpLedgerLine("2026-05-15T09:59:00.000Z", "first") +
        mcpLedgerLine(tiedTimestamp, "shard-202")
    )
    writeFileSync(
      costLedgerShardPath(ledgerPath, 101),
      mcpLedgerLine(tiedTimestamp, "shard-101")
    )

    await costsCommand.parseAsync(["export"], { from: "user" })

    const exported = logSpy.mock.calls
      .flat()
      .join("\n")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { action: string })
    expect(exported.map((event) => event.action)).toEqual([
      "first",
      "legacy",
      "shard-101",
      "shard-202",
    ])
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
