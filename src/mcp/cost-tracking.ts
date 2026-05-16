import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
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

type ToolActionSets = ReadonlyMap<string, ReadonlySet<string>>

const EMPTY_TOOL_ACTIONS: ToolActionSets = new Map()

export function installCostTrackingToolWrapper(
  server: McpServer,
  services: LoreServices
): void {
  const originalRegisterTool = server.registerTool.bind(server)
  const toolActions = new Map<string, ReadonlySet<string>>()
  const wrappedRegisterTool = (
    name: string,
    config: Parameters<typeof server.registerTool>[1],
    callback: ToolCallback
  ) => {
    const actions = safeToolActionsFromInputSchema(
      (config as { inputSchema?: unknown }).inputSchema
    )
    if (actions) {
      toolActions.set(name, actions)
    } else {
      toolActions.delete(name)
    }
    return originalRegisterTool(name, config, (async (
      args: Record<string, unknown>,
      extra?: unknown
    ) =>
      runMcpInvocationWithCostTracking(
        services,
        name,
        args,
        () => callback(args, extra),
        toolActions
      )) as never)
  }
  server.registerTool = wrappedRegisterTool as typeof server.registerTool
}

export async function runMcpInvocationWithCostTracking(
  services: LoreServices,
  tool: string,
  args: Record<string, unknown>,
  run: () => Promise<CostTrackedToolResult>,
  toolActions: ToolActionSets = EMPTY_TOOL_ACTIONS
): Promise<CostTrackedToolResult> {
  if (!services.costTracking.enabled) return run()

  const started = Date.now()
  const input = safeJsonStringify(args)
  const action = safeActionValue(tool, args["action"], toolActions)
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

function safeToolActionsFromInputSchema(
  inputSchema: unknown
): ReadonlySet<string> | undefined {
  const actionSchema = actionSchemaFromInputSchema(inputSchema)
  const values = zodEnumValues(actionSchema)
  return values.length > 0 ? new Set(values) : undefined
}

function actionSchemaFromInputSchema(inputSchema: unknown): unknown {
  if (!inputSchema || typeof inputSchema !== "object") return undefined

  if (inputSchema instanceof z.ZodObject) {
    return inputSchema.shape["action"]
  }

  const rawShapeAction = (inputSchema as Record<string, unknown>)["action"]
  if (rawShapeAction) return rawShapeAction

  return undefined
}

function zodEnumValues(schema: unknown): string[] {
  let cursor = schema
  for (let i = 0; i < 8; i++) {
    if (cursor instanceof z.ZodEnum) {
      return [...cursor.options]
    }
    if (cursor instanceof z.ZodOptional || cursor instanceof z.ZodNullable) {
      cursor = cursor.unwrap()
      continue
    }
    return []
  }
  return []
}

function safeActionValue(
  tool: string,
  value: unknown,
  toolActions: ToolActionSets
): string | undefined {
  if (typeof value !== "string") return undefined
  const safeActions = toolActions.get(tool)
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
