import { mkdir, open, readFile, readdir, unlink, writeFile } from "node:fs/promises"
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path"
import { homedir } from "node:os"
import { z } from "zod"
import type { CostTrackingConfig, LoreConfig } from "../types.js"
import { redactDebugError } from "../debug-redact.js"

export const COST_LEDGER_SCHEMA_VERSION = 1
export const DEFAULT_COST_LEDGER_PATH = "~/.local/share/lore/cost-ledger.jsonl"
export const DEFAULT_COST_PRICING_TABLE = "openai-2026-05"
export const COST_LEDGER_APPEND_ERROR_MARKER_VERSION = 1
export const COST_LEDGER_APPEND_ERROR_MARKER_SUFFIX = ".append-error.json"
export const TOKEN_ESTIMATOR = "chars_per_token_4"

export type CostEventType =
  | "mcp.invocation"
  | "hook.wakeup_context"
  | "autosave.background_model"
  | "digest.background_model"

export type CostEventSource = "host_agent" | "background_agent" | "hook" | "cli"
export type CostEventStatus = "success" | "error" | "skipped"

export interface CostPayloadSummary {
  inputBytes?: number
  outputBytes?: number
  estimatedInputTokens?: number
  estimatedOutputTokens?: number
  redacted: true
  tokenEstimator: typeof TOKEN_ESTIMATOR
}

export interface CostNotionSummary {
  reads: number
  writes: number
  failures: number
  rateLimitBackoffs: number
}

export interface CostOutputCounts {
  memoriesCreated?: number
  memoriesUpdated?: number
  memoriesArchived?: number
  memoriesReturned?: number
  factsCreated?: number
  factsUpdated?: number
  factsReturned?: number
  decisionsCreated?: number
  decisionsUpdated?: number
  decisionsReturned?: number
  tasksCreated?: number
  tasksUpdated?: number
  tasksClosed?: number
  tasksReturned?: number
  projectsReturned?: number
  proceduresReturned?: number
}

export interface CostModelUsage {
  provider?: "openai" | "anthropic" | "unknown"
  model?: string
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  reasoningOutputTokens?: number
  estimated: boolean
  source: "exact_agent_usage" | "prompt_estimate" | "unavailable"
}

export interface CostEstimate {
  usd?: number
  pricingSource?: string
  estimated: boolean
  unknownReason?: "unknown_model" | "missing_usage" | "not_applicable"
}

export interface CostLedgerEventBase {
  schemaVersion: 1
  timestamp: string
  eventType: CostEventType
  source: CostEventSource
  projectName?: string
  agentName?: string
  sessionId?: string
  durationMs?: number
  status: CostEventStatus
}

export interface McpInvocationCostEvent extends CostLedgerEventBase {
  eventType: "mcp.invocation"
  tool: string
  action?: string
  payload: CostPayloadSummary
  notion: CostNotionSummary
  outputs?: CostOutputCounts
}

export interface WakeupContextCostEvent extends CostLedgerEventBase {
  eventType: "hook.wakeup_context"
  source: "hook"
  payload: CostPayloadSummary
  estimatedCost: CostEstimate
}

export interface BackgroundModelCostEvent extends CostLedgerEventBase {
  eventType: "autosave.background_model" | "digest.background_model"
  source: "hook" | "cli"
  payload: CostPayloadSummary
  modelUsage: CostModelUsage
  estimatedCost: CostEstimate
}

export type CostLedgerEvent =
  | McpInvocationCostEvent
  | WakeupContextCostEvent
  | BackgroundModelCostEvent

export interface ModelRates {
  inputPer1K?: number
  cachedInputPer1K?: number
  outputPer1K?: number
  reasoningOutputPer1K?: number
}

export interface PricingTable {
  source: string
  models: Record<string, ModelRates>
}

const modelRatesSchema = z
  .object({
    inputPer1K: z.number().finite().nonnegative().optional(),
    cachedInputPer1K: z.number().finite().nonnegative().optional(),
    outputPer1K: z.number().finite().nonnegative().optional(),
    reasoningOutputPer1K: z.number().finite().nonnegative().optional(),
  })
  .strict()

const pricingTableSchema = z
  .object({
    source: z.string().optional(),
    models: z.record(modelRatesSchema),
  })
  .strict()

const builtinPricingTableSchema = pricingTableSchema.extend({
  source: z.string(),
})

export type ResolvedCostTracking =
  | {
      enabled: false
      config: CostTrackingConfig | undefined
    }
  | {
      enabled: true
      config: CostTrackingConfig
      ledgerPath: string
      displayLedgerPath: string
      pricing: {
        builtinTable: string
        overridesPath?: string
      }
    }

export interface CostLedgerAppendErrorMarker {
  version: typeof COST_LEDGER_APPEND_ERROR_MARKER_VERSION
  timestamp: string
  ledgerPath: string
  error: string
}

export interface CostLedgerAppendErrorMarkerRead {
  markerPath: string
  marker: CostLedgerAppendErrorMarker | null
  readError?: string
}

const BUILTIN_PRICING_TABLES: Record<string, PricingTable> = {
  [DEFAULT_COST_PRICING_TABLE]: {
    source: "builtin-openai-2026-05",
    models: {
      "gpt-5.5": {
        inputPer1K: 0.005,
        cachedInputPer1K: 0.0005,
        outputPer1K: 0.03,
      },
      "gpt-5.4": {
        inputPer1K: 0.0025,
        cachedInputPer1K: 0.00025,
        outputPer1K: 0.015,
      },
      "gpt-5.4-mini": {
        inputPer1K: 0.00075,
        cachedInputPer1K: 0.000075,
        outputPer1K: 0.0045,
      },
      "gpt-5.2": {
        inputPer1K: 0.00175,
        cachedInputPer1K: 0.000175,
        outputPer1K: 0.014,
      },
      "gpt-5.2-chat-latest": {
        inputPer1K: 0.00175,
        cachedInputPer1K: 0.000175,
        outputPer1K: 0.014,
      },
      "gpt-5.2-codex": {
        inputPer1K: 0.00175,
        cachedInputPer1K: 0.000175,
        outputPer1K: 0.014,
      },
      "gpt-5": {
        inputPer1K: 0.00125,
        cachedInputPer1K: 0.000125,
        outputPer1K: 0.01,
      },
      "gpt-5-nano": {
        inputPer1K: 0.00005,
        cachedInputPer1K: 0.000005,
        outputPer1K: 0.0004,
      },
    },
  },
}

let appendWarningEmitted = false

export function resolveCostTracking(
  config: Pick<LoreConfig, "costTracking">,
  configRoot: string
): ResolvedCostTracking {
  const raw = config.costTracking
  if (!raw?.enabled) {
    return { enabled: false, config: raw }
  }

  const ledgerPath = resolveConfiguredPath(
    raw.ledgerPath ?? DEFAULT_COST_LEDGER_PATH,
    configRoot
  )
  const overridesPath = raw.pricing?.overridesPath
    ? resolveConfiguredPath(raw.pricing.overridesPath, configRoot)
    : undefined

  return {
    enabled: true,
    config: raw,
    ledgerPath,
    displayLedgerPath: displayPath(ledgerPath),
    pricing: {
      builtinTable: raw.pricing?.builtinTable ?? DEFAULT_COST_PRICING_TABLE,
      ...(overridesPath ? { overridesPath } : {}),
    },
  }
}

export function resolveConfiguredPath(path: string, configRoot: string): string {
  const expanded = expandHome(path)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(configRoot, expanded)
}

export function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2))
  return path
}

export function displayPath(path: string): string {
  const home = homedir()
  if (path === home) return "~"
  if (path.startsWith(`${home}/`)) return `~/${relative(home, path)}`
  return path
}

export function estimateTokensFromText(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4)
}

export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / 4)
}

export function payloadSummary(input?: string, output?: string): CostPayloadSummary {
  const summary: CostPayloadSummary = {
    redacted: true,
    tokenEstimator: TOKEN_ESTIMATOR,
  }
  if (input !== undefined) {
    const bytes = Buffer.byteLength(input, "utf8")
    summary.inputBytes = bytes
    summary.estimatedInputTokens = estimateTokensFromBytes(bytes)
  }
  if (output !== undefined) {
    const bytes = Buffer.byteLength(output, "utf8")
    summary.outputBytes = bytes
    summary.estimatedOutputTokens = estimateTokensFromBytes(bytes)
  }
  return summary
}

export const emptyNotionSummary = (): CostNotionSummary => ({
  reads: 0,
  writes: 0,
  failures: 0,
  rateLimitBackoffs: 0,
})

export function costLedgerShardPath(
  ledgerPath: string,
  processId: number = process.pid
): string {
  const parsed = parse(ledgerPath)
  return join(parsed.dir, `${parsed.name}.${processId}${parsed.ext}`)
}

export async function appendCostEvent(
  costTracking: ResolvedCostTracking | undefined,
  event: CostLedgerEvent
): Promise<void> {
  if (!costTracking?.enabled) return
  const shardPath = costLedgerShardPath(costTracking.ledgerPath)
  try {
    await mkdir(dirname(shardPath), { recursive: true, mode: 0o700 })
    const handle = await open(shardPath, "a", 0o600)
    try {
      await handle.write(`${JSON.stringify(event)}\n`)
    } finally {
      await handle.close()
    }
    await clearCostLedgerAppendErrorMarker(costTracking)
  } catch (err) {
    if (!appendWarningEmitted) {
      appendWarningEmitted = true
      process.stderr.write(
        `[lore] cost-tracking: failed to append ledger event: ${redactDebugError(err)}\n`
      )
    }
    try {
      await writeCostLedgerAppendErrorMarker(costTracking, err)
    } catch {
      // The ledger is advisory. Losing the marker must not make a cost
      // accounting failure fatal to the caller.
    }
  }
}

export function resetCostLedgerWarningForTests(): void {
  appendWarningEmitted = false
}

export function costLedgerAppendErrorMarkerPath(ledgerPath: string): string {
  return `${ledgerPath}${COST_LEDGER_APPEND_ERROR_MARKER_SUFFIX}`
}

export async function writeCostLedgerAppendErrorMarker(
  costTracking: ResolvedCostTracking,
  err: unknown,
  now = new Date()
): Promise<void> {
  if (!costTracking.enabled) return
  const markerPath = costLedgerAppendErrorMarkerPath(costTracking.ledgerPath)
  const marker: CostLedgerAppendErrorMarker = {
    version: COST_LEDGER_APPEND_ERROR_MARKER_VERSION,
    timestamp: now.toISOString(),
    ledgerPath: costTracking.displayLedgerPath,
    error: redactDebugError(err),
  }
  await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 })
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
    mode: 0o600,
  })
}

export async function readCostLedgerAppendErrorMarker(
  costTracking: ResolvedCostTracking
): Promise<CostLedgerAppendErrorMarkerRead | null> {
  if (!costTracking.enabled) return null
  const markerPath = costLedgerAppendErrorMarkerPath(costTracking.ledgerPath)
  try {
    const parsed = JSON.parse(await readFile(markerPath, "utf-8"))
    const marker = parseCostLedgerAppendErrorMarker(parsed)
    return marker
      ? { markerPath, marker }
      : {
          markerPath,
          marker: null,
          readError: "marker did not match expected schema",
        }
  } catch (err) {
    if (isFileNotFoundError(err)) return null
    return { markerPath, marker: null, readError: redactDebugError(err) }
  }
}

export async function clearCostLedgerAppendErrorMarker(
  costTracking: ResolvedCostTracking
): Promise<void> {
  if (!costTracking.enabled) return
  try {
    await unlink(costLedgerAppendErrorMarkerPath(costTracking.ledgerPath))
  } catch {
    // Best-effort cleanup; a stale marker should not make a successful
    // ledger append fail.
  }
}

export async function loadPricingTable(
  costTracking: ResolvedCostTracking
): Promise<PricingTable | null> {
  if (!costTracking.enabled) return null
  const base = lookupBuiltinPricingTable(costTracking.pricing.builtinTable)
  if (!base) {
    return { source: costTracking.pricing.builtinTable, models: {} }
  }
  const validatedBase = validateBuiltinPricingTable(
    costTracking.pricing.builtinTable,
    base
  )
  const merged: PricingTable = {
    source: validatedBase.source,
    models: { ...validatedBase.models },
  }
  const overridePath = costTracking.pricing.overridesPath
  if (!overridePath) return merged
  try {
    const parsed = validatePricingOverrideTable(
      JSON.parse(await readFile(overridePath, "utf-8"))
    )
    merged.source = `${merged.source}+${parsed.source ?? "overrides"}`
    merged.models = { ...merged.models, ...parsed.models }
  } catch (err) {
    warnInvalidPricingOverride(overridePath, err)
  }
  return merged
}

export function validatePricingTable(value: unknown): PricingTable {
  return builtinPricingTableSchema.parse(value)
}

function validateBuiltinPricingTable(name: string, value: unknown): PricingTable {
  try {
    return validatePricingTable(value)
  } catch (err) {
    throw new Error(`Invalid builtin cost pricing table "${name}"`, { cause: err })
  }
}

function lookupBuiltinPricingTable(name: string): PricingTable | undefined {
  return Object.hasOwn(BUILTIN_PRICING_TABLES, name)
    ? BUILTIN_PRICING_TABLES[name]
    : undefined
}

function validatePricingOverrideTable(value: unknown): Omit<PricingTable, "source"> & {
  source?: string
} {
  return pricingTableSchema.parse(value)
}

function warnInvalidPricingOverride(path: string, err: unknown): void {
  process.stderr.write(
    `[lore] cost-tracking: ignored invalid pricing overrides at ${displayPath(
      path
    )}: ${pricingOverrideWarningReason(err)}\n`
  )
}

function pricingOverrideWarningReason(err: unknown): string {
  if (err instanceof SyntaxError) return "invalid JSON"
  if (err instanceof z.ZodError) return "schema validation failed"
  return redactDebugError(err)
}

export function estimateModelCost(
  usage: CostModelUsage,
  table: PricingTable | null
): CostEstimate {
  if (usage.source === "unavailable") {
    return { estimated: usage.estimated, unknownReason: "missing_usage" }
  }
  if (!usage.model || !table?.models[usage.model]) {
    return { estimated: usage.estimated, unknownReason: "unknown_model" }
  }
  const rates = table.models[usage.model]
  const hasBillableUsage =
    usage.inputTokens !== undefined ||
    usage.cachedInputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.reasoningOutputTokens !== undefined
  if (!hasBillableUsage) {
    return { estimated: usage.estimated, unknownReason: "missing_usage" }
  }

  const usd =
    ((usage.inputTokens ?? 0) * (rates.inputPer1K ?? 0) +
      (usage.cachedInputTokens ?? 0) * (rates.cachedInputPer1K ?? 0) +
      (usage.outputTokens ?? 0) * (rates.outputPer1K ?? 0) +
      (usage.reasoningOutputTokens ?? 0) *
        (rates.reasoningOutputPer1K ?? rates.outputPer1K ?? 0)) /
    1000
  return {
    usd,
    pricingSource: table.source,
    estimated: usage.estimated,
  }
}

export interface CostRange {
  label: string
  start?: Date
  end?: Date
}

export function defaultTodayRange(now = new Date()): CostRange {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return { label: "today", start, end }
}

export function monthRange(month: string): CostRange {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  if (!match) throw new Error("--month must use YYYY-MM")
  const year = Number.parseInt(match[1]!, 10)
  const monthNumber = Number.parseInt(match[2]!, 10)
  if (monthNumber < 1 || monthNumber > 12) throw new Error("--month must use YYYY-MM")
  const start = new Date(year, monthNumber - 1, 1)
  const end = new Date(year, monthNumber, 1)
  return { label: month, start, end }
}

export function sinceRange(value: string, now = new Date()): CostRange {
  const match = /^([1-9]\d*)([hdw])$/.exec(value)
  if (!match) throw new Error("--since must be Nh, Nd, or Nw where N is positive")
  const amount = Number.parseInt(match[1]!, 10)
  const unit = match[2]!
  const multiplier = unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000
  return {
    label: `since ${value}`,
    start: new Date(now.getTime() - amount * multiplier),
    end: now,
  }
}

export function eventInRange(event: CostLedgerEvent, range: CostRange): boolean {
  const time = Date.parse(event.timestamp)
  if (!Number.isFinite(time)) return false
  if (range.start && time < range.start.getTime()) return false
  if (range.end && time >= range.end.getTime()) return false
  return true
}

type UnknownRecord = Record<string, unknown>

const COST_EVENT_TYPES = [
  "mcp.invocation",
  "hook.wakeup_context",
  "autosave.background_model",
  "digest.background_model",
] as const satisfies readonly CostEventType[]

const COST_EVENT_SOURCES = [
  "host_agent",
  "background_agent",
  "hook",
  "cli",
] as const satisfies readonly CostEventSource[]

const COST_EVENT_STATUSES = [
  "success",
  "error",
  "skipped",
] as const satisfies readonly CostEventStatus[]

const MODEL_PROVIDERS = [
  "openai",
  "anthropic",
  "unknown",
] as const satisfies readonly NonNullable<CostModelUsage["provider"]>[]

const MODEL_USAGE_SOURCES = [
  "exact_agent_usage",
  "prompt_estimate",
  "unavailable",
] as const satisfies readonly CostModelUsage["source"][]

const COST_UNKNOWN_REASONS = [
  "unknown_model",
  "missing_usage",
  "not_applicable",
] as const satisfies readonly NonNullable<CostEstimate["unknownReason"]>[]

const COST_OUTPUT_COUNT_KEYS = [
  "memoriesCreated",
  "memoriesUpdated",
  "memoriesArchived",
  "memoriesReturned",
  "factsCreated",
  "factsUpdated",
  "factsReturned",
  "decisionsCreated",
  "decisionsUpdated",
  "decisionsReturned",
  "tasksCreated",
  "tasksUpdated",
  "tasksClosed",
  "tasksReturned",
  "projectsReturned",
  "proceduresReturned",
] as const satisfies readonly (keyof CostOutputCounts)[]

function parseCostLedgerAppendErrorMarker(
  value: unknown
): CostLedgerAppendErrorMarker | null {
  if (!isRecord(value)) return null
  if (value["version"] !== COST_LEDGER_APPEND_ERROR_MARKER_VERSION) return null
  const timestamp = stringField(value, "timestamp")
  const ledgerPath = stringField(value, "ledgerPath")
  const error = stringField(value, "error")
  if (
    timestamp === null ||
    !Number.isFinite(Date.parse(timestamp)) ||
    ledgerPath === null ||
    error === null
  ) {
    return null
  }
  return {
    version: COST_LEDGER_APPEND_ERROR_MARKER_VERSION,
    timestamp,
    ledgerPath,
    error,
  }
}

function parseCostLedgerEvent(value: unknown): CostLedgerEvent | null {
  if (!isRecord(value)) return null
  const base = parseCostLedgerEventBase(value)
  if (!base) return null
  const { eventType, ...common } = base

  if (eventType === "mcp.invocation") {
    const tool = stringField(value, "tool")
    if (tool === null) return null
    const action = optionalStringField(value, "action")
    if (action === null) return null
    const payload = parsePayloadSummary(value["payload"])
    const notion = parseNotionSummary(value["notion"])
    const outputs = parseOutputCounts(value["outputs"])
    if (!payload || !notion || outputs === null) return null
    return {
      ...common,
      eventType,
      tool,
      ...(action !== undefined ? { action } : {}),
      payload,
      notion,
      ...(outputs !== undefined ? { outputs } : {}),
    }
  }

  if (eventType === "hook.wakeup_context") {
    if (common.source !== "hook") return null
    const payload = parsePayloadSummary(value["payload"])
    const estimatedCost = parseCostEstimate(value["estimatedCost"])
    if (!payload || !estimatedCost) return null
    return {
      ...common,
      eventType,
      source: common.source,
      payload,
      estimatedCost,
    }
  }

  if (common.source !== "hook" && common.source !== "cli") return null
  const payload = parsePayloadSummary(value["payload"])
  const modelUsage = parseModelUsage(value["modelUsage"])
  const estimatedCost = parseCostEstimate(value["estimatedCost"])
  if (!payload || !modelUsage || !estimatedCost) return null
  return {
    ...common,
    eventType,
    source: common.source,
    payload,
    modelUsage,
    estimatedCost,
  }
}

function parseCostLedgerEventBase(value: UnknownRecord): CostLedgerEventBase | null {
  if (value["schemaVersion"] !== COST_LEDGER_SCHEMA_VERSION) return null
  const timestamp = stringField(value, "timestamp")
  if (timestamp === null || !Number.isFinite(Date.parse(timestamp))) return null
  const eventType = enumField(value, "eventType", COST_EVENT_TYPES)
  const source = enumField(value, "source", COST_EVENT_SOURCES)
  const status = enumField(value, "status", COST_EVENT_STATUSES)
  if (eventType === null || source === null || status === null) return null
  const projectName = optionalStringField(value, "projectName")
  const agentName = optionalStringField(value, "agentName")
  const sessionId = optionalStringField(value, "sessionId")
  const durationMs = optionalNonnegativeNumberField(value, "durationMs")
  if (
    projectName === null ||
    agentName === null ||
    sessionId === null ||
    durationMs === null
  ) {
    return null
  }
  return {
    schemaVersion: COST_LEDGER_SCHEMA_VERSION,
    timestamp,
    eventType,
    source,
    ...(projectName !== undefined ? { projectName } : {}),
    ...(agentName !== undefined ? { agentName } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    status,
  }
}

function parsePayloadSummary(value: unknown): CostPayloadSummary | null {
  if (!isRecord(value)) return null
  if (value["redacted"] !== true || value["tokenEstimator"] !== TOKEN_ESTIMATOR) {
    return null
  }
  const inputBytes = optionalNonnegativeIntegerField(value, "inputBytes")
  const outputBytes = optionalNonnegativeIntegerField(value, "outputBytes")
  const estimatedInputTokens = optionalNonnegativeIntegerField(
    value,
    "estimatedInputTokens"
  )
  const estimatedOutputTokens = optionalNonnegativeIntegerField(
    value,
    "estimatedOutputTokens"
  )
  if (
    inputBytes === null ||
    outputBytes === null ||
    estimatedInputTokens === null ||
    estimatedOutputTokens === null
  ) {
    return null
  }
  return {
    ...(inputBytes !== undefined ? { inputBytes } : {}),
    ...(outputBytes !== undefined ? { outputBytes } : {}),
    ...(estimatedInputTokens !== undefined ? { estimatedInputTokens } : {}),
    ...(estimatedOutputTokens !== undefined ? { estimatedOutputTokens } : {}),
    redacted: true,
    tokenEstimator: TOKEN_ESTIMATOR,
  }
}

function parseNotionSummary(value: unknown): CostNotionSummary | null {
  if (!isRecord(value)) return null
  const reads = integerField(value, "reads")
  const writes = integerField(value, "writes")
  const failures = integerField(value, "failures")
  const rateLimitBackoffs = integerField(value, "rateLimitBackoffs")
  if (
    reads === null ||
    writes === null ||
    failures === null ||
    rateLimitBackoffs === null
  ) {
    return null
  }
  return { reads, writes, failures, rateLimitBackoffs }
}

function parseOutputCounts(value: unknown): CostOutputCounts | null | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  const outputs: CostOutputCounts = {}
  for (const key of COST_OUTPUT_COUNT_KEYS) {
    const count = optionalNonnegativeIntegerField(value, key)
    if (count === null) return null
    if (count !== undefined) outputs[key] = count
  }
  return Object.keys(outputs).length > 0 ? outputs : undefined
}

function parseModelUsage(value: unknown): CostModelUsage | null {
  if (!isRecord(value)) return null
  const provider = optionalEnumField(value, "provider", MODEL_PROVIDERS)
  const model = optionalStringField(value, "model")
  const inputTokens = optionalNonnegativeIntegerField(value, "inputTokens")
  const cachedInputTokens = optionalNonnegativeIntegerField(value, "cachedInputTokens")
  const outputTokens = optionalNonnegativeIntegerField(value, "outputTokens")
  const reasoningOutputTokens = optionalNonnegativeIntegerField(
    value,
    "reasoningOutputTokens"
  )
  const estimated = booleanField(value, "estimated")
  const source = enumField(value, "source", MODEL_USAGE_SOURCES)
  if (
    provider === null ||
    model === null ||
    inputTokens === null ||
    cachedInputTokens === null ||
    outputTokens === null ||
    reasoningOutputTokens === null ||
    estimated === null ||
    source === null
  ) {
    return null
  }
  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    estimated,
    source,
  }
}

function parseCostEstimate(value: unknown): CostEstimate | null {
  if (!isRecord(value)) return null
  const usd = optionalNonnegativeNumberField(value, "usd")
  const pricingSource = optionalStringField(value, "pricingSource")
  const estimated = booleanField(value, "estimated")
  const unknownReason = optionalEnumField(value, "unknownReason", COST_UNKNOWN_REASONS)
  if (
    usd === null ||
    pricingSource === null ||
    estimated === null ||
    unknownReason === null
  ) {
    return null
  }
  return {
    ...(usd !== undefined ? { usd } : {}),
    ...(pricingSource !== undefined ? { pricingSource } : {}),
    estimated,
    ...(unknownReason !== undefined ? { unknownReason } : {}),
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(record: UnknownRecord, key: string): string | null {
  const value = record[key]
  return typeof value === "string" ? value : null
}

function optionalStringField(
  record: UnknownRecord,
  key: string
): string | null | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  return typeof value === "string" ? value : null
}

function integerField(record: UnknownRecord, key: string): number | null {
  const value = record[key]
  return isNonnegativeInteger(value) ? value : null
}

function optionalNonnegativeIntegerField(
  record: UnknownRecord,
  key: string
): number | null | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  return isNonnegativeInteger(value) ? value : null
}

function optionalNonnegativeNumberField(
  record: UnknownRecord,
  key: string
): number | null | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

function booleanField(record: UnknownRecord, key: string): boolean | null {
  const value = record[key]
  return typeof value === "boolean" ? value : null
}

function enumField<T extends string>(
  record: UnknownRecord,
  key: string,
  values: readonly T[]
): T | null {
  const value = record[key]
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : null
}

function optionalEnumField<T extends string>(
  record: UnknownRecord,
  key: string,
  values: readonly T[]
): T | null | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : null
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

export async function readLedgerEvents(
  costTracking: ResolvedCostTracking,
  range?: CostRange
): Promise<Array<{ line: string; event: CostLedgerEvent }>> {
  return (await readLedgerEventsWithDiagnostics(costTracking, range)).rows
}

export interface CostLedgerReadDiagnostics {
  rows: Array<{ line: string; event: CostLedgerEvent }>
  malformedLineCount: number
}

interface CostLedgerSource {
  path: string
  sortKey: string
}

interface CostLedgerRow {
  line: string
  event: CostLedgerEvent
  sourceIndex: number
  lineNumber: number
}

export async function readLedgerEventsWithDiagnostics(
  costTracking: ResolvedCostTracking,
  range?: CostRange
): Promise<CostLedgerReadDiagnostics> {
  if (!costTracking.enabled) {
    return { rows: [], malformedLineCount: 0 }
  }
  const rows: CostLedgerRow[] = []
  let malformedLineCount = 0
  const sources = await costLedgerReadSources(costTracking.ledgerPath)

  for (const [sourceIndex, source] of sources.entries()) {
    let lineNumber = 0
    try {
      const lines = createInterface({
        input: createReadStream(source.path, { encoding: "utf8" }),
        crlfDelay: Infinity,
      })

      for await (const line of lines) {
        lineNumber += 1
        if (!line.trim()) continue
        try {
          const event = parseCostLedgerEvent(JSON.parse(line))
          if (event && (!range || eventInRange(event, range))) {
            rows.push({
              line: JSON.stringify(event),
              event,
              sourceIndex,
              lineNumber,
            })
          }
          if (!event) malformedLineCount += 1
        } catch {
          malformedLineCount += 1
        }
      }
    } catch (err) {
      if (!isFileNotFoundError(err)) throw err
    }
  }

  rows.sort(compareCostLedgerRows)
  return {
    rows: rows.map(({ line, event }) => ({ line, event })),
    malformedLineCount,
  }
}

export function formatMalformedLedgerWarning(malformedLineCount: number): string | null {
  if (malformedLineCount <= 0) return null
  const noun = malformedLineCount === 1 ? "line" : "lines"
  return `Warning: skipped ${malformedLineCount} malformed cost ledger ${noun}; only valid redacted rows were included.`
}

async function costLedgerReadSources(ledgerPath: string): Promise<CostLedgerSource[]> {
  const parsed = parse(ledgerPath)
  const sources: CostLedgerSource[] = [{ path: ledgerPath, sortKey: "" }]
  let entries: string[]
  try {
    entries = (await readdir(parsed.dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  } catch (err) {
    if (isFileNotFoundError(err)) return sources
    throw err
  }

  const shardPattern = costLedgerShardFilenamePattern(ledgerPath)
  for (const name of entries.filter((name) => shardPattern.test(name)).sort()) {
    sources.push({ path: join(parsed.dir, name), sortKey: name })
  }
  return sources.sort(compareCostLedgerSources)
}

function compareCostLedgerSources(a: CostLedgerSource, b: CostLedgerSource): number {
  if (a.sortKey === "") return b.sortKey === "" ? 0 : -1
  if (b.sortKey === "") return 1
  return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0
}

function costLedgerShardFilenamePattern(ledgerPath: string): RegExp {
  const parsed = parse(ledgerPath)
  return new RegExp(
    `^${escapeRegExp(parsed.name)}\\.[1-9]\\d*${escapeRegExp(parsed.ext)}$`
  )
}

function compareCostLedgerRows(a: CostLedgerRow, b: CostLedgerRow): number {
  return (
    Date.parse(a.event.timestamp) - Date.parse(b.event.timestamp) ||
    a.sourceIndex - b.sourceIndex ||
    a.lineNumber - b.lineNumber ||
    a.line.localeCompare(b.line)
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function isFileNotFoundError(err: unknown): boolean {
  return isRecord(err) && (err["code"] === "ENOENT" || err["code"] === "ENOTDIR")
}

export interface CostSummary {
  rangeLabel: string
  eventCount: number
  modelExactUsd: number
  modelEstimatedUsd: number
  modelUnknownEvents: number
  wakeupEstimatedTokens: number
  mcpTotal: number
  mcpSuccess: number
  mcpError: number
  notion: CostNotionSummary
  notionWrites: number
  mcpByToolAction: Array<{
    tool: string
    action: string
    success: number
    error: number
  }>
}

export function summarizeCostEvents(
  events: readonly CostLedgerEvent[],
  rangeLabel: string
): CostSummary {
  const byToolAction = new Map<
    string,
    { tool: string; action: string; success: number; error: number }
  >()
  const summary: CostSummary = {
    rangeLabel,
    eventCount: events.length,
    modelExactUsd: 0,
    modelEstimatedUsd: 0,
    modelUnknownEvents: 0,
    wakeupEstimatedTokens: 0,
    mcpTotal: 0,
    mcpSuccess: 0,
    mcpError: 0,
    notion: emptyNotionSummary(),
    notionWrites: 0,
    mcpByToolAction: [],
  }

  for (const event of events) {
    if (
      event.eventType === "autosave.background_model" ||
      event.eventType === "digest.background_model"
    ) {
      if (event.status !== "success") {
        continue
      }
      if (event.estimatedCost.usd !== undefined) {
        if (event.estimatedCost.estimated)
          summary.modelEstimatedUsd += event.estimatedCost.usd
        else summary.modelExactUsd += event.estimatedCost.usd
      } else {
        summary.modelUnknownEvents += 1
      }
    }

    if (event.eventType === "hook.wakeup_context") {
      summary.wakeupEstimatedTokens += event.payload.estimatedOutputTokens ?? 0
    }

    if (event.eventType === "mcp.invocation") {
      summary.mcpTotal += 1
      if (event.status === "success") summary.mcpSuccess += 1
      if (event.status === "error") summary.mcpError += 1
      summary.notion.reads += event.notion.reads
      summary.notion.writes += event.notion.writes
      summary.notion.failures += event.notion.failures
      summary.notion.rateLimitBackoffs += event.notion.rateLimitBackoffs
      summary.notionWrites += event.notion.writes

      const action = event.action ?? "(none)"
      const key = `${event.tool}\u0000${action}`
      const current = byToolAction.get(key) ?? {
        tool: event.tool,
        action,
        success: 0,
        error: 0,
      }
      if (event.status === "success") current.success += 1
      if (event.status === "error") current.error += 1
      byToolAction.set(key, current)
    }
  }

  summary.mcpByToolAction = Array.from(byToolAction.values()).sort((a, b) =>
    `${a.tool} ${a.action}`.localeCompare(`${b.tool} ${b.action}`)
  )
  return summary
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`
}

export function formatCostSummary(summary: CostSummary): string {
  const lines = [
    `Lore Costs (${summary.rangeLabel})`,
    "-------------------------",
    `Lore-owned model cost: ${formatUsd(summary.modelExactUsd)} exact agent usage, ~${formatUsd(summary.modelEstimatedUsd)} background prompt estimates, ${summary.modelUnknownEvents} background events with unknown cost`,
    "Background prompt estimates may exclude completion tokens, cached-input billing, and provider-side rounding.",
    `Wake-up context: ${summary.wakeupEstimatedTokens.toLocaleString()} estimated tokens, cost unknown`,
    `MCP calls: ${summary.mcpTotal} total, ${summary.mcpSuccess} success, ${summary.mcpError} error`,
    `Notion operations: ${summary.notion.reads} reads, ${summary.notion.writes} writes, ${summary.notion.failures} failures, ${summary.notion.rateLimitBackoffs} rate-limit backoffs`,
  ]
  if (summary.mcpByToolAction.length > 0) {
    lines.push("", "MCP by tool/action:")
    for (const row of summary.mcpByToolAction) {
      lines.push(
        `  ${row.tool} ${row.action}: ${row.success} success, ${row.error} error`
      )
    }
  }
  return lines.join("\n")
}

export const COST_EXPORT_CSV_COLUMNS = [
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
] as const

export function eventsToCsv(events: readonly CostLedgerEvent[]): string {
  const rows = [COST_EXPORT_CSV_COLUMNS.join(",")]
  for (const event of events) {
    const mcp = event.eventType === "mcp.invocation" ? event : undefined
    const background =
      event.eventType === "autosave.background_model" ||
      event.eventType === "digest.background_model"
        ? event
        : undefined
    const payload =
      event.eventType === "mcp.invocation" ||
      event.eventType === "hook.wakeup_context" ||
      event.eventType === "autosave.background_model" ||
      event.eventType === "digest.background_model"
        ? event.payload
        : undefined
    const values: Record<
      (typeof COST_EXPORT_CSV_COLUMNS)[number],
      string | number | boolean | undefined
    > = {
      timestamp: event.timestamp,
      eventType: event.eventType,
      source: event.source,
      status: event.status,
      projectName: event.projectName,
      agentName: event.agentName,
      sessionId: event.sessionId,
      tool: mcp?.tool,
      action: mcp?.action,
      durationMs: event.durationMs,
      inputBytes: payload?.inputBytes,
      outputBytes: payload?.outputBytes,
      estimatedInputTokens: payload?.estimatedInputTokens,
      estimatedOutputTokens: payload?.estimatedOutputTokens,
      notionReads: mcp?.notion.reads,
      notionWrites: mcp?.notion.writes,
      notionFailures: mcp?.notion.failures,
      notionRateLimitBackoffs: mcp?.notion.rateLimitBackoffs,
      modelProvider: background?.modelUsage.provider,
      model: background?.modelUsage.model,
      modelUsageEstimated: background?.modelUsage.estimated,
      estimatedUsd: background?.estimatedCost.usd,
      costUnknownReason:
        background?.estimatedCost?.unknownReason ??
        (event.eventType === "hook.wakeup_context"
          ? event.estimatedCost?.unknownReason
          : undefined),
    }
    rows.push(COST_EXPORT_CSV_COLUMNS.map((column) => csvCell(values[column])).join(","))
  }
  return rows.join("\n")
}

function csvCell(value: string | number | boolean | undefined): string {
  if (value === undefined) return ""
  const text = String(value)
  if (!/[",\n\r]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

export function backgroundSpawnStatus(kind: string): CostEventStatus {
  if (kind === "spawned") return "success"
  if (kind === "lock-held" || kind === "cap-hit" || kind === "race-lost") {
    return "skipped"
  }
  return "error"
}
