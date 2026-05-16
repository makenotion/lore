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
  costLedgerShardPath,
  defaultTodayRange,
  estimateModelCost,
  eventsToCsv,
  formatCostSummary,
  formatMalformedLedgerWarning,
  loadPricingTable,
  payloadSummary,
  readLedgerEvents,
  readLedgerEventsWithDiagnostics,
  resolveCostTracking,
  summarizeCostEvents,
  validatePricingTable,
  type CostLedgerEvent,
  type PricingTable,
  type ResolvedCostTracking,
} from "./cost-ledger.js"

type BackgroundModelEvent = Extract<
  CostLedgerEvent,
  { eventType: "autosave.background_model" | "digest.background_model" }
>

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

  function mcpEvent(timestamp: string, action: string): CostLedgerEvent {
    return {
      schemaVersion: COST_LEDGER_SCHEMA_VERSION,
      timestamp,
      eventType: "mcp.invocation",
      source: "host_agent",
      status: "success",
      tool: "lore-query",
      action,
      payload: payloadSummary("{}", "ok"),
      notion: { reads: 1, writes: 0, failures: 0, rateLimitBackoffs: 0 },
    }
  }

  function eventActions(rows: Array<{ event: CostLedgerEvent }>): string[] {
    return rows.map((row) =>
      row.event.eventType === "mcp.invocation" ? (row.event.action ?? "") : ""
    )
  }

  function enabledCostTracking(
    root: string,
    options: {
      ledgerPath?: string
      builtinTable?: string
      overridesPath?: string
    } = {}
  ): Extract<ResolvedCostTracking, { enabled: true }> {
    const costTracking = resolveCostTracking(
      {
        costTracking: {
          enabled: true,
          ...(options.ledgerPath ? { ledgerPath: options.ledgerPath } : {}),
          ...(options.builtinTable || options.overridesPath
            ? {
                pricing: {
                  ...(options.builtinTable ? { builtinTable: options.builtinTable } : {}),
                  ...(options.overridesPath
                    ? { overridesPath: options.overridesPath }
                    : {}),
                },
              }
            : {}),
        },
      },
      root
    )
    if (!costTracking.enabled) throw new Error("expected cost tracking to be enabled")
    return costTracking
  }

  async function captureStderr<T>(
    run: () => Promise<T>
  ): Promise<{ value: T; stderr: string }> {
    const chunks: string[] = []
    const originalWrite = process.stderr.write
    process.stderr.write = ((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      return { value: await run(), stderr: chunks.join("") }
    } finally {
      process.stderr.write = originalWrite
    }
  }

  it("is disabled by default and does not create ledger files", async () => {
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

  it("does not create shard files when cost tracking is explicitly disabled", async () => {
    const root = tempDir()
    const costTracking = resolveCostTracking(
      {
        costTracking: {
          enabled: false,
          ledgerPath: "state/costs.jsonl",
        },
      },
      root
    )

    await appendCostEvent(costTracking, mcpEvent(new Date().toISOString(), "disabled"))

    expect(costTracking.enabled).toBe(false)
    expect(existsSync(join(root, "state"))).toBe(false)
  })

  it("resolves relative paths and writes private per-process JSONL shard files", async () => {
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

    const shardPath = costLedgerShardPath(costTracking.ledgerPath)
    const ledgerStat = statSync(shardPath)
    const dirStat = statSync(join(root, "state"))
    expect(existsSync(costTracking.ledgerPath)).toBe(false)
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

  it("merges legacy ledger rows and multiple process shards on read", async () => {
    const root = tempDir()
    const costTracking = enabledCostTracking(root, {
      ledgerPath: "state/costs.jsonl",
    })
    mkdirSync(dirname(costTracking.ledgerPath), { recursive: true })
    writeFileSync(
      costTracking.ledgerPath,
      JSON.stringify(mcpEvent("2026-05-15T10:00:00.000Z", "legacy")) + "\n"
    )
    writeFileSync(
      costLedgerShardPath(costTracking.ledgerPath, 101),
      JSON.stringify(mcpEvent("2026-05-15T10:01:00.000Z", "shard-101")) + "\n"
    )
    writeFileSync(
      costLedgerShardPath(costTracking.ledgerPath, 202),
      JSON.stringify(mcpEvent("2026-05-15T10:02:00.000Z", "shard-202")) + "\n"
    )

    const rows = await readLedgerEvents(costTracking)

    expect(eventActions(rows)).toEqual(["legacy", "shard-101", "shard-202"])
  })

  it("sorts merged ledger rows by timestamp with deterministic tie-breaking", async () => {
    const root = tempDir()
    const costTracking = enabledCostTracking(root, {
      ledgerPath: "state/costs.jsonl",
    })
    const tiedTimestamp = "2026-05-15T10:00:00.000Z"
    mkdirSync(dirname(costTracking.ledgerPath), { recursive: true })
    writeFileSync(
      costTracking.ledgerPath,
      JSON.stringify(mcpEvent(tiedTimestamp, "legacy")) + "\n"
    )
    writeFileSync(
      costLedgerShardPath(costTracking.ledgerPath, 202),
      [
        JSON.stringify(mcpEvent("2026-05-15T09:59:00.000Z", "first")),
        JSON.stringify(mcpEvent(tiedTimestamp, "shard-202")),
      ].join("\n") + "\n"
    )
    writeFileSync(
      costLedgerShardPath(costTracking.ledgerPath, 101),
      JSON.stringify(mcpEvent(tiedTimestamp, "shard-101")) + "\n"
    )

    const rows = await readLedgerEvents(costTracking)

    expect(eventActions(rows)).toEqual(["first", "legacy", "shard-101", "shard-202"])
    expect(eventsToCsv(rows.map((row) => row.event))).toMatch(
      /first[\s\S]*legacy[\s\S]*shard-101[\s\S]*shard-202/
    )
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

  it("reports malformed ledger diagnostics without counting blank lines", async () => {
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
        "",
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
        }),
        "{not json",
        JSON.stringify({
          schemaVersion: COST_LEDGER_SCHEMA_VERSION,
          timestamp: "not-a-date",
          eventType: "mcp.invocation",
          source: "host_agent",
          status: "success",
          tool: "lore-query",
          payload: payloadSummary("{}", "ok"),
          notion: { reads: 1, writes: 0, failures: 0, rateLimitBackoffs: 0 },
        }),
        "   ",
      ].join("\n") + "\n"
    )

    const diagnostics = await readLedgerEventsWithDiagnostics(costTracking)
    expect(diagnostics.rows).toHaveLength(1)
    expect(diagnostics.malformedLineCount).toBe(2)
    expect(await readLedgerEvents(costTracking)).toHaveLength(1)
    expect(formatMalformedLedgerWarning(diagnostics.malformedLineCount)).toBe(
      "Warning: skipped 2 malformed cost ledger lines; only valid redacted rows were included."
    )
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
    const backgroundRows: BackgroundModelEvent[] = [
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
    ]

    expect(
      backgroundRows
        .filter(
          (event) =>
            event.eventType === "autosave.background_model" ||
            event.eventType === "digest.background_model"
        )
        .map((event) => event.modelUsage.source)
    ).toEqual(["prompt_estimate", "prompt_estimate"])

    const summary = summarizeCostEvents(backgroundRows, "today")

    expect(summary.modelEstimatedUsd).toBe(0.01575)
    expect(summary.modelUnknownEvents).toBe(0)
    expect(formatCostSummary(summary)).toContain("background prompt estimates")
  })

  it("summarizes exact model usage separately from background prompt estimates", () => {
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
          estimatedCost: {
            usd: 0.02,
            pricingSource: "test",
            estimated: true,
          },
        },
        {
          schemaVersion: COST_LEDGER_SCHEMA_VERSION,
          timestamp: now,
          eventType: "autosave.background_model",
          source: "hook",
          status: "success",
          payload: payloadSummary("autosave prompt", "provider usage"),
          modelUsage: {
            provider: "openai",
            model: "gpt-5.2-codex",
            inputTokens: 1000,
            outputTokens: 500,
            estimated: false,
            source: "exact_agent_usage",
          },
          estimatedCost: {
            usd: 0.01,
            pricingSource: "test",
            estimated: false,
          },
        },
      ],
      "today"
    )

    expect(summary.modelEstimatedUsd).toBe(0.02)
    expect(summary.modelExactUsd).toBe(0.01)
    expect(formatCostSummary(summary)).toContain(
      "Lore-owned model cost: $0.01 exact agent usage, ~$0.02 background prompt estimates"
    )
  })

  it("merges schema-valid pricing overrides with the builtin table", async () => {
    const root = tempDir()
    const overridePath = join(root, "pricing-overrides.json")
    writeFileSync(
      overridePath,
      JSON.stringify({
        source: "local-test",
        models: {
          "custom-model": {
            inputPer1K: 1,
            cachedInputPer1K: 0.5,
            outputPer1K: 2,
            reasoningOutputPer1K: 3,
          },
        },
      })
    )

    const pricing = await loadPricingTable(
      enabledCostTracking(root, { overridesPath: "pricing-overrides.json" })
    )

    expect(pricing).toMatchObject({
      source: "builtin-openai-2026-05+local-test",
      models: {
        "custom-model": {
          inputPer1K: 1,
          cachedInputPer1K: 0.5,
          outputPer1K: 2,
          reasoningOutputPer1K: 3,
        },
      },
    })
    expect(pricing?.models["gpt-5.2-codex"]).toMatchObject({
      inputPer1K: 0.00175,
      outputPer1K: 0.014,
    })
  })

  it.each([
    [
      "string rates",
      {
        source: "SECRET_SOURCE",
        models: { "custom-model": { inputPer1K: "1" } },
      },
    ],
    [
      "NaN-like string rates",
      {
        source: "SECRET_SOURCE",
        models: { "custom-model": { inputPer1K: "NaN" } },
      },
    ],
    [
      "negative rates",
      {
        source: "SECRET_SOURCE",
        models: { "custom-model": { outputPer1K: -1 } },
      },
    ],
    [
      "typoed model-rate keys",
      {
        source: "SECRET_SOURCE",
        models: { "custom-model": { inputPerThousand: 1 } },
      },
    ],
    [
      "unknown top-level keys",
      {
        source: "SECRET_SOURCE",
        models: { "custom-model": { inputPer1K: 1 } },
        secretTopLevel: "SECRET_CONTENT",
      },
    ],
  ])("ignores override files with %s", async (_name, override) => {
    const root = tempDir()
    const overridePath = join(root, "pricing-overrides.json")
    writeFileSync(overridePath, JSON.stringify(override))

    const { value: pricing, stderr } = await captureStderr(() =>
      loadPricingTable(enabledCostTracking(root, { overridesPath: overridePath }))
    )

    expect(pricing?.source).toBe("builtin-openai-2026-05")
    expect(pricing?.models["custom-model"]).toBeUndefined()
    expect(stderr).toContain("ignored invalid pricing overrides")
    expect(stderr).toContain(overridePath)
    expect(stderr).toContain("schema validation failed")
    expect(stderr).not.toContain("SECRET")
  })

  it("ignores malformed or unreadable override files with a warning", async () => {
    const root = tempDir()
    const malformedPath = join(root, "malformed-pricing.json")
    writeFileSync(malformedPath, "{not json SECRET_CONTENT")

    const malformed = await captureStderr(() =>
      loadPricingTable(enabledCostTracking(root, { overridesPath: malformedPath }))
    )
    const unreadable = await captureStderr(() =>
      loadPricingTable(
        enabledCostTracking(root, { overridesPath: "missing-pricing.json" })
      )
    )

    expect(malformed.value?.source).toBe("builtin-openai-2026-05")
    expect(malformed.stderr).toContain("invalid JSON")
    expect(malformed.stderr).not.toContain("SECRET_CONTENT")
    expect(unreadable.value?.source).toBe("builtin-openai-2026-05")
    expect(unreadable.stderr).toContain("ENOENT")
    expect(unreadable.stderr).toContain("missing-pricing.json")
  })

  it.each(["unknown-table", "constructor", "toString"])(
    "keeps unknown builtin pricing table %s non-fatal",
    async (builtinTable) => {
      const root = tempDir()
      writeFileSync(
        join(root, "pricing-overrides.json"),
        JSON.stringify({
          models: { "custom-model": { inputPer1K: 1 } },
        })
      )
      const pricing = await loadPricingTable(
        enabledCostTracking(root, {
          builtinTable,
          overridesPath: "pricing-overrides.json",
        })
      )

      expect(pricing).toEqual({ source: builtinTable, models: {} })
    }
  )

  it("rejects malformed pricing tables before they can be used", () => {
    expect(() =>
      validatePricingTable({
        source: "broken",
        models: {
          "custom-model": {
            inputPer1K: Number.POSITIVE_INFINITY,
          },
        },
      } satisfies PricingTable)
    ).toThrow()
  })
})
