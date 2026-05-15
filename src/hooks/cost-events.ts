import { basename } from "node:path"
import {
  appendCostEvent,
  backgroundSpawnStatus,
  COST_LEDGER_SCHEMA_VERSION,
  estimateModelCost,
  loadPricingTable,
  payloadSummary,
  type CostEventStatus,
  type ResolvedCostTracking,
} from "../core/cost-ledger.js"
import type { BackgroundAgentConfig } from "./config.js"
import type { SpawnResult } from "./background.js"

export async function recordBackgroundModelCostEvent(opts: {
  costTracking: ResolvedCostTracking | undefined
  eventType: "autosave.background_model" | "digest.background_model"
  source: "hook" | "cli"
  prompt: string
  result: SpawnResult
  projectName?: string
  agentName?: string
  sessionId?: string
  agent?: BackgroundAgentConfig
}): Promise<void> {
  if (!opts.costTracking?.enabled) return
  const payload = payloadSummary(opts.prompt)
  const model = inferModel(opts.agent)
  const modelUsage = {
    provider: inferProvider(opts.agent?.command),
    ...(model ? { model } : {}),
    inputTokens: payload.estimatedInputTokens,
    estimated: true,
    source: "prompt_estimate" as const,
  }
  const pricing = await loadPricingTable(opts.costTracking)
  await appendCostEvent(opts.costTracking, {
    schemaVersion: COST_LEDGER_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    eventType: opts.eventType,
    source: opts.source,
    status: backgroundSpawnStatus(opts.result.kind),
    ...(opts.projectName ? { projectName: opts.projectName } : {}),
    ...(opts.agentName ? { agentName: opts.agentName } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    payload,
    modelUsage,
    estimatedCost: estimateModelCost(modelUsage, pricing),
  })
}

export async function recordWakeupContextCostEvent(opts: {
  costTracking: ResolvedCostTracking | undefined
  status: CostEventStatus
  output?: string
  projectName?: string
  agentName?: string
  sessionId?: string
}): Promise<void> {
  if (!opts.costTracking?.enabled) return
  await appendCostEvent(opts.costTracking, {
    schemaVersion: COST_LEDGER_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    eventType: "hook.wakeup_context",
    source: "hook",
    status: opts.status,
    ...(opts.projectName ? { projectName: opts.projectName } : {}),
    ...(opts.agentName ? { agentName: opts.agentName } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    payload: payloadSummary(undefined, opts.output ?? ""),
    estimatedCost: {
      estimated: false,
      unknownReason: "not_applicable",
    },
  })
}

function inferModel(agent: BackgroundAgentConfig | undefined): string | undefined {
  const args = agent?.args ?? []
  const index = args.findIndex((arg) => arg === "--model" || arg === "-m")
  if (index >= 0) {
    const model = args[index + 1]
    return model && model.trim() ? model.trim() : undefined
  }
  for (const arg of args) {
    if (arg.startsWith("--model=")) {
      const model = arg.slice("--model=".length).trim()
      return model || undefined
    }
  }
  return undefined
}

function inferProvider(command: string | undefined): "openai" | "anthropic" | "unknown" {
  const name = basename(command ?? "").toLowerCase()
  if (name.includes("claude")) return "anthropic"
  if (name.includes("codex") || name.includes("openai")) return "openai"
  return "unknown"
}
