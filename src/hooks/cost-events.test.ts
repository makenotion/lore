import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  readLedgerEvents,
  resolveCostTracking,
  type CostLedgerEvent,
} from "../core/cost-ledger.js"
import {
  recordBackgroundModelCostEvent,
  recordWakeupContextCostEvent,
} from "./cost-events.js"

type BackgroundModelEvent = Extract<
  CostLedgerEvent,
  { eventType: "autosave.background_model" | "digest.background_model" }
>
type WakeupContextEvent = Extract<CostLedgerEvent, { eventType: "hook.wakeup_context" }>

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F\u2028\u2029]/

describe("hook cost events", () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "lore-hook-cost-events-"))
    dirs.push(dir)
    return dir
  }

  it("records autosave and digest background model rows as prompt estimates", async () => {
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

    const agent = {
      command: "codex",
      args: ["exec", "--model", "gpt-5.2-codex"],
    }

    await recordBackgroundModelCostEvent({
      costTracking,
      eventType: "autosave.background_model",
      source: "hook",
      prompt: "autosave prompt",
      result: { kind: "spawned" },
      agent,
    })
    await recordBackgroundModelCostEvent({
      costTracking,
      eventType: "digest.background_model",
      source: "cli",
      prompt: "digest prompt",
      result: { kind: "spawned" },
      agent,
    })

    const events = (await readLedgerEvents(costTracking)).map((row) => row.event)
    const backgroundEvents = events.filter(
      (event): event is BackgroundModelEvent =>
        event.eventType === "autosave.background_model" ||
        event.eventType === "digest.background_model"
    )

    expect(backgroundEvents.map((event) => event.eventType)).toEqual([
      "autosave.background_model",
      "digest.background_model",
    ])
    expect(backgroundEvents.map((event) => event.modelUsage.source)).toEqual([
      "prompt_estimate",
      "prompt_estimate",
    ])
    expect(
      backgroundEvents.map((event) => ({
        estimated: event.modelUsage.estimated,
        inputTokens: event.modelUsage.inputTokens,
        cachedInputTokens: event.modelUsage.cachedInputTokens,
        outputTokens: event.modelUsage.outputTokens,
        costEstimated: event.estimatedCost.estimated,
      }))
    ).toEqual([
      {
        estimated: true,
        inputTokens: 4,
        cachedInputTokens: undefined,
        outputTokens: undefined,
        costEstimated: true,
      },
      {
        estimated: true,
        inputTokens: 4,
        cachedInputTokens: undefined,
        outputTokens: undefined,
        costEstimated: true,
      },
    ])
  })

  it("sanitizes shared metadata before writing hook ledger rows", async () => {
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

    await recordBackgroundModelCostEvent({
      costTracking,
      eventType: "autosave.background_model",
      source: "hook",
      prompt: "autosave prompt",
      result: { kind: "spawned" },
      agentName: `Agent\t${"A".repeat(10_000)}\ntrailing`,
      sessionId: "\u2028session\tvalue\u009f",
    })
    await recordWakeupContextCostEvent({
      costTracking,
      status: "success",
      output: "wake-up context",
      agentName: "\u0000\t\n\u007f\u009f\u2028",
      sessionId: "\r\u2029",
    })

    const events = (await readLedgerEvents(costTracking)).map((row) => row.event)
    const backgroundEvent = events.find(
      (event): event is BackgroundModelEvent =>
        event.eventType === "autosave.background_model"
    )
    const wakeupEvent = events.find(
      (event): event is WakeupContextEvent => event.eventType === "hook.wakeup_context"
    )

    expect(backgroundEvent).toBeDefined()
    expect(backgroundEvent!.agentName).toBe(`Agent ${"A".repeat(193)}…`)
    expect(backgroundEvent!.agentName).toHaveLength(200)
    expect(backgroundEvent!.sessionId).toBe("session value")
    expect(backgroundEvent!.agentName).not.toMatch(CONTROL_CHARS)
    expect(backgroundEvent!.sessionId).not.toMatch(CONTROL_CHARS)
    expect(wakeupEvent).toBeDefined()
    expect(wakeupEvent).not.toHaveProperty("agentName")
    expect(wakeupEvent).not.toHaveProperty("sessionId")
  })
})
