import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { addCostOutputs, captureCostAccounting } from "../core/cost-accounting.js"
import {
  appendCostEvent,
  COST_LEDGER_SCHEMA_VERSION,
  payloadSummary,
  type CostOutputCounts,
} from "../core/cost-ledger.js"
import type { LoreServices } from "../services.js"

export interface CostTrackedToolResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
  noopWrite?: boolean
  costOutputs?: CostOutputCounts
}

type ToolCallback = (
  args: Record<string, unknown>,
  extra?: unknown
) => Promise<CostTrackedToolResult>

const SAFE_TOOL_ACTIONS: Record<string, ReadonlySet<string>> = {
  "lore-context": new Set(["status", "wake-up", "digest"]),
  "lore-decision": new Set(["create", "list", "get", "context", "supersede", "review"]),
  "lore-fact": new Set(["create", "invalidate", "extend"]),
  "lore-memory": new Set([
    "save",
    "update",
    "archive",
    "expand",
    "suggest-topic-key",
    "compare",
    "approve",
    "reject",
    "promote",
  ]),
  "lore-pinned": new Set(["pin", "unpin", "update", "list"]),
  "lore-procedure": new Set(["scan-candidates", "propose", "deprecate"]),
  "lore-project": new Set(["list", "get"]),
  "lore-query": new Set(["recall", "search", "ask", "audit"]),
  "lore-task": new Set(["create", "update", "close", "close-many", "list", "reconcile"]),
}

export function installCostTrackingToolWrapper(
  server: McpServer,
  services: LoreServices
): void {
  const originalRegisterTool = server.registerTool.bind(server)
  const wrappedRegisterTool = (
    name: string,
    config: Parameters<typeof server.registerTool>[1],
    callback: ToolCallback
  ) => {
    return originalRegisterTool(name, config, (async (
      args: Record<string, unknown>,
      extra?: unknown
    ) =>
      runMcpInvocationWithCostTracking(services, name, args, () =>
        callback(args, extra)
      )) as never)
  }
  server.registerTool = wrappedRegisterTool as typeof server.registerTool
}

export async function runMcpInvocationWithCostTracking(
  services: LoreServices,
  tool: string,
  args: Record<string, unknown>,
  run: () => Promise<CostTrackedToolResult>
): Promise<CostTrackedToolResult> {
  if (!services.costTracking.enabled) return run()

  const started = Date.now()
  const input = safeJsonStringify(args)
  const action = safeActionValue(tool, args["action"])
  const projectName = services.context.project?.name
  const agentName = envStringValue("LORE_AGENT_NAME")
  const sessionId = envStringValue("LORE_SESSION_ID")
  const tracked = await captureCostAccounting(async () => {
    const result = await run()
    addCostOutputs(result.costOutputs)
    return result
  })
  const durationMs = Math.max(0, Date.now() - started)
  const source =
    process.env["LORE_BACKGROUND_AGENT"] === "true" ? "background_agent" : "host_agent"

  if (tracked.ok) {
    const output = tracked.result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n")
    await appendCostEvent(services.costTracking, {
      schemaVersion: COST_LEDGER_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      eventType: "mcp.invocation",
      source,
      status: tracked.result.isError ? "error" : "success",
      ...(projectName ? { projectName } : {}),
      ...(agentName ? { agentName } : {}),
      ...(sessionId ? { sessionId } : {}),
      durationMs,
      tool,
      ...(action ? { action } : {}),
      payload: payloadSummary(input, output),
      notion: tracked.context.notion,
      ...(Object.keys(tracked.context.outputs).length > 0
        ? { outputs: tracked.context.outputs }
        : {}),
    })
    return tracked.result
  }

  await appendCostEvent(services.costTracking, {
    schemaVersion: COST_LEDGER_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    eventType: "mcp.invocation",
    source,
    status: "error",
    ...(projectName ? { projectName } : {}),
    ...(agentName ? { agentName } : {}),
    ...(sessionId ? { sessionId } : {}),
    durationMs,
    tool,
    ...(action ? { action } : {}),
    payload: payloadSummary(input, undefined),
    notion: tracked.context.notion,
    ...(Object.keys(tracked.context.outputs).length > 0
      ? { outputs: tracked.context.outputs }
      : {}),
  })
  throw tracked.error
}

function safeActionValue(tool: string, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const safeActions = SAFE_TOOL_ACTIONS[tool]
  return safeActions?.has(value) ? value : undefined
}

function envStringValue(name: string): string | undefined {
  const value = process.env[name]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return "[unserializable]"
  }
}
