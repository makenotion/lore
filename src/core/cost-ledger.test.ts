import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  existsSync,
  writeFileSync,
} from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
  }
})

import {
  appendCostEvent,
  COST_LEDGER_SCHEMA_VERSION,
  defaultTodayRange,
  estimateModelCost,
  eventsToCsv,
  loadPricingTable,
  payloadSummary,
  readLedgerEvents,
  resolveCostTracking,
  summarizeCostEvents,
  type CostLedgerEvent,
} from "./cost-ledger.js"

describe("cost ledger", () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "lore-cost-ledger-"))
    dirs.push(dir)
    return dir
  }

  it("is disabled by default and does not create a ledger file", async () => {
    const root = tempDir()
    const costTracking = resolveCostTracking({}, root)

    await appendCostEvent(costTracking, {
      schemaVersion: COST_LEDGER_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      eventType: "hook.wakeup_context",
      source: "hook",
      status: "success",
      payload: payloadSummary(undefined, "hello"),
      estimatedCost: { estimated: false, unknownReason: "not_applicable" },
    })

    expect(costTracking.enabled).toBe(false)
    expect(existsSync(join(root, ".local"))).toBe(false)
  })

  it("resolves relative paths and writes private JSONL files", async () => {
    const root = tempDir()
    const costTracking = resolveCostTracking(
      {
        costTracking: {
          enabled: true,
          ledgerPath: "state/costs.jsonl",
        },
      },
      root
    )
    if (!costTracking.enabled) throw new Error("expected cost tracking to be enabled")

    await appendCostEvent(costTracking, {
      schemaVersion: COST_LEDGER_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      eventType: "mcp.invocation",
      source: "host_agent",
      status: "success",
      tool: "lore-memory",
      action: "save",
      payload: payloadSummary('{"action":"save"}', "Saved memory"),
      notion: { reads: 1, writes: 2, failures: 0, rateLimitBackoffs: 0 },
      outputs: { memoriesCreated: 1 },
    })

    const ledgerStat = statSync(costTracking.ledgerPath)
    const dirStat = statSync(join(root, "state"))
    expect(ledgerStat.mode & 0o777).toBe(0o600)
    expect(dirStat.mode & 0o777).toBe(0o700)
    const rows = await readLedgerEvents(costTracking)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event).toMatchObject({
      eventType: "mcp.invocation",
      tool: "lore-memory",
      action: "save",
      outputs: { memoriesCreated: 1 },
    })
    expect(rows[0]!.line).not.toContain("Saved memory")
  })

  it("streams multiple ledger rows and preserves range filtering without readFile", async () => {
    const root = tempDir()
    const costTracking = resolveCostTracking(
      {
        costTracking: {
          enabled: true,
          ledgerPath: "state/costs.jsonl",
        },
      },
      root
    )
    if (!costTracking.enabled) throw new Error("expected cost tracking to be enabled")

    mkdirSync(dirname(costTracking.ledgerPath), { recursive: true })
    writeFileSync(
      costTracking.ledgerPath,
      [
        JSON.stringify({
          schemaVersion: COST_LEDGER_SCHEMA_VERSION,
          timestamp: "2026-04-30T23:59:59.000Z",
          eventType: "mcp.invocation",
          source: "host_agent",
          status: "success",
          tool: "lore-query",
          action: "before-range",
          payload: payloadSummary("{}", "old"),
          notion: { reads: 1, writes: 0, failures: 0, rateLimitBackoffs: 0 },
        }),
        JSON.stringify({
          schemaVersion: COST_LEDGER_SCHEMA_VERSION,
          timestamp: "2026-05-01T00:00:00.000Z",
          eventType: "mcp.invocation",
          source: "host_agent",
          status: "success",
          tool: "lore-query",
          action: "in-range",
          payload: payloadSummary("{}", "ok"),
          notion: { reads: 1, writes: 0, failures: 0, rateLimitBackoffs: 0 },
        }),
        JSON.stringify({
          schemaVersion: COST_LEDGER_SCHEMA_VERSION,
          timestamp: "2026-05-15T12:00:00.000Z",
          eventType: "hook.wakeup_context",
          source: "hook",
          status: "success",
          payload: payloadSummary(undefined, "wake context"),
          estimatedCost: { estimated: false, unknownReason: "not_applicable" },
        }),
      ].join("\n") + "\n"
    )

    const readFileMock = vi.mocked(readFile)
    readFileMock.mockClear()

    const rows = await readLedgerEvents(costTracking, {
      label: "may",
      start: new Date("2026-05-01T00:00:00.000Z"),
      end: new Date("2026-06-01T00:00:00.000Z"),
    })

    expect(readFileMock).not.toHaveBeenCalled()
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.event.eventType)).toEqual([
      "mcp.invocation",
      "hook.wakeup_context",
    ])
    expect(rows[0]!.event).toMatchObject({
      eventType: "mcp.invocation",
      action: "in-range",
    })
  })

  it("returns no rows when cost tracking is disabled or the ledger file is missing", async () => {
    const root = tempDir()
    const disabled = resolveCostTracking({}, root)
    expect(await readLedgerEvents(disabled)).toEqual([])

    const costTracking = resolveCostTracking(
      {
        costTracking: {
          enabled: true,
          ledgerPath: "state/missing.jsonl",
        },
      },
      root
    )
    expect(await readLedgerEvents(costTracking)).toEqual([])
  })

  it("summarizes and exports range-filtered ledger events", async () => {
    const now = new Date()
    const events: CostLedgerEvent[] = [
      {
        schemaVersion: COST_LEDGER_SCHEMA_VERSION,
        timestamp: now.toISOString(),
        eventType: "mcp.invocation" as const,
        source: "host_agent" as const,
        status: "success" as const,
        tool: "lore-query",
        action: "search",
        payload: payloadSummary("{}", "result"),
        notion: { reads: 2, writes: 0, failures: 0, rateLimitBackoffs: 1 },
      },
      {
        schemaVersion: COST_LEDGER_SCHEMA_VERSION,
        timestamp: now.toISOString(),
        eventType: "hook.wakeup_context" as const,
        source: "hook" as const,
        status: "success" as const,
        payload: payloadSummary(undefined, "wake context"),
        estimatedCost: { estimated: false, unknownReason: "not_applicable" as const },
      },
    ]

    const summary = summarizeCostEvents(events, defaultTodayRange(now).label)

    expect(summary.mcpTotal).toBe(1)
    expect(summary.wakeupEstimatedTokens).toBeGreaterThan(0)
    expect(summary.notion.rateLimitBackoffs).toBe(1)
    expect(eventsToCsv(events)).toContain("timestamp,eventType,source,status")
    expect(eventsToCsv(events)).toContain("lore-query,search")
  })

  it("skips schema-invalid JSON rows and sanitizes exported JSONL rows", async () => {
    const root = tempDir()
    const costTracking = resolveCostTracking(
      {
        costTracking: {
          enabled: true,
          ledgerPath: "state/costs.jsonl",
        },
      },
      root
    )
    if (!costTracking.enabled) throw new Error("expected cost tracking to be enabled")

    const timestamp = new Date().toISOString()
    mkdirSync(dirname(costTracking.ledgerPath), { recursive: true })
    writeFileSync(
      costTracking.ledgerPath,
      [
        JSON.stringify({
          timestamp,
          eventType: "mcp.invocation",
          status: "success",
          projectName: "SECRET_MISSING_NOTION",
        }),
        "{not json",
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
          rawArgs: "SECRET_EXTRA_FIELD",
        }),
      ].join("\n") + "\n"
    )

    const rows = await readLedgerEvents(costTracking)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event).toMatchObject({
      eventType: "mcp.invocation",
      tool: "lore-query",
      action: "search",
    })
    expect(rows[0]!.line).not.toContain("SECRET")

    const events = rows.map((row) => row.event)
    expect(summarizeCostEvents(events, "today").mcpTotal).toBe(1)
    expect(eventsToCsv(events)).toContain("lore-query,search")
    expect(eventsToCsv(events)).not.toContain("SECRET")
  })

  it("uses the builtin pricing table and excludes skipped spawns from cost totals", async () => {
    const root = tempDir()
    const costTracking = resolveCostTracking(
      {
        costTracking: {
          enabled: true,
        },
      },
      root
    )
    const pricing = await loadPricingTable(costTracking)
    const estimatedCost = estimateModelCost(
      {
        provider: "openai",
        model: "gpt-5.2-codex",
        inputTokens: 1000,
        outputTokens: 1000,
        estimated: true,
        source: "prompt_estimate",
      },
      pricing
    )

    expect(estimatedCost).toMatchObject({
      usd: 0.01575,
      pricingSource: "builtin-openai-2026-05",
      estimated: true,
    })

    const now = new Date().toISOString()
    const summary = summarizeCostEvents(
      [
        {
          schemaVersion: COST_LEDGER_SCHEMA_VERSION,
          timestamp: now,
          eventType: "digest.background_model",
          source: "hook",
          status: "success",
          payload: payloadSummary("digest prompt"),
          modelUsage: {
            provider: "openai",
            model: "gpt-5.2-codex",
            inputTokens: 1000,
            estimated: true,
            source: "prompt_estimate",
          },
          estimatedCost,
        },
        {
          schemaVersion: COST_LEDGER_SCHEMA_VERSION,
          timestamp: now,
          eventType: "autosave.background_model",
          source: "hook",
          status: "skipped",
          payload: payloadSummary("autosave prompt"),
          modelUsage: {
            provider: "unknown",
            inputTokens: 1000,
            estimated: true,
            source: "prompt_estimate",
          },
          estimatedCost: { estimated: true, unknownReason: "unknown_model" },
        },
      ],
      "today"
    )

    expect(summary.modelEstimatedUsd).toBe(0.01575)
    expect(summary.modelUnknownEvents).toBe(0)
  })
})
