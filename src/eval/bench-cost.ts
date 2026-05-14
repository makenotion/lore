/**
 * Cost computation for the LongMemEval bench-runner.
 *
 * Two cost surfaces:
 *
 * 1. **Runner-measured** — the agent's per-example Codex `turn.completed`
 *    `usage` (input/cached_input/output/reasoning_output tokens) and the
 *    judge's OpenAI `usage` (prompt/completion tokens). Multiplied by
 *    per-1K-tokens rates from `evals/bench/pricing.json`.
 *
 * 2. **Ingestion-estimated** — `count(sessions) * pricing.ingestion.perSessionEstimatedUsd`.
 *    Production mining shells out to `claude -p` / `codex exec` whose
 *    per-spawn token counts are not exposed to the runner. The
 *    estimated number is committed with a calibration source so the
 *    artifact carries the lineage of the estimate.
 */

import { readFile } from "node:fs/promises"
import { z } from "zod"
import type { BenchExtractionUsage } from "./bench-simulated-autosave.js"

const perModelPricingSchema = z
  .object({
    inputPer1K: z.number().nonnegative(),
    cachedInputPer1K: z.number().nonnegative(),
    outputPer1K: z.number().nonnegative(),
    reasoningOutputPer1K: z.number().nonnegative(),
  })
  .strict()

const ingestionPricingSchema = z
  .object({
    perSessionEstimatedUsd: z.number().nonnegative(),
    calibrationSource: z.string().default("committed-estimate"),
    calibratedAt: z.string().default("pending-bootstrap"),
  })
  .strict()

export const benchPricingSchema = z
  .object({
    models: z.record(z.string().min(1), perModelPricingSchema),
    ingestion: ingestionPricingSchema,
  })
  .strict()

export type BenchPricing = z.infer<typeof benchPricingSchema>
export type PerModelPricing = z.infer<typeof perModelPricingSchema>

/**
 * Codex 0.128.0 `--json` emits a `turn.completed` event with this
 * `usage` shape. The four fields let the pricing module charge
 * cached input at the cached-rate (Codex pricing today: 50% off for
 * cached input) and reasoning output at its model-specific rate.
 */
export interface CodexTurnUsage {
  input_tokens: number
  cached_input_tokens: number
  output_tokens: number
  reasoning_output_tokens: number
}

const codexTurnUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    cached_input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    reasoning_output_tokens: z.number().int().nonnegative(),
  })
  .passthrough()

export async function loadBenchPricing(path: string): Promise<BenchPricing> {
  const raw = await readFile(path, "utf-8")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not parse bench pricing at ${path}: ${message}`, {
      cause: err,
    })
  }
  return benchPricingSchema.parse(parsed)
}

export function getModelPricing(pricing: BenchPricing, model: string): PerModelPricing {
  const entry = pricing.models[model]
  if (!entry) {
    throw new Error(
      `Bench pricing has no entry for model "${model}". ` +
        `Known models: ${Object.keys(pricing.models).join(", ")}`
    )
  }
  return entry
}

/**
 * Parse a Codex `turn.completed` event's `usage` payload. Returns
 * `null` when the payload is missing or malformed — the caller routes
 * that to `failureReason: "agent-token-usage-missing"`, NOT silent
 * estimation. No tiktoken-estimate fallback exists.
 */
export function parseCodexUsage(usage: unknown): CodexTurnUsage | null {
  if (!usage || typeof usage !== "object") return null
  const parsed = codexTurnUsageSchema.safeParse(usage)
  if (!parsed.success) return null
  return {
    input_tokens: parsed.data.input_tokens,
    cached_input_tokens: parsed.data.cached_input_tokens,
    output_tokens: parsed.data.output_tokens,
    reasoning_output_tokens: parsed.data.reasoning_output_tokens,
  }
}

export function computeAgentCostUsd(
  usage: CodexTurnUsage,
  pricing: PerModelPricing
): number {
  // Codex's `input_tokens` is the TOTAL prompt-token count;
  // `cached_input_tokens` is the cached portion OF that total (matches
  // `JudgeUsage`'s `cachedPromptTokens` contract in this module).
  // Charging both at `inputPer1K + cachedInputPer1K` double-counts
  // the cached portion. Split the bucket explicitly so the cached
  // portion lands at the cheaper rate and the remainder lands at the
  // regular rate.
  const uncachedInput = Math.max(0, usage.input_tokens - usage.cached_input_tokens)
  return (
    (uncachedInput / 1000) * pricing.inputPer1K +
    (usage.cached_input_tokens / 1000) * pricing.cachedInputPer1K +
    (usage.output_tokens / 1000) * pricing.outputPer1K +
    (usage.reasoning_output_tokens / 1000) * pricing.reasoningOutputPer1K
  )
}

export interface JudgeUsage {
  promptTokens: number
  completionTokens: number
  /**
   * Cached portion of `promptTokens` as reported by OpenAI's
   * `prompt_tokens_details.cached_tokens`. Charged at the cheaper
   * `cachedInputPer1K` rate when present; the non-cached remainder
   * (`promptTokens - cachedPromptTokens`) is charged at the regular
   * `inputPer1K` rate. Default 0 for older completion shapes.
   */
  cachedPromptTokens?: number
}

export function computeJudgeCostUsd(usage: JudgeUsage, pricing: PerModelPricing): number {
  const cached = usage.cachedPromptTokens ?? 0
  const uncached = Math.max(0, usage.promptTokens - cached)
  return (
    (uncached / 1000) * pricing.inputPer1K +
    (cached / 1000) * pricing.cachedInputPer1K +
    (usage.completionTokens / 1000) * pricing.outputPer1K
  )
}

export function computeExtractionCostUsd(
  usage: BenchExtractionUsage,
  pricing: PerModelPricing
): number {
  const cached = usage.cachedPromptTokens
  const uncached = Math.max(0, usage.promptTokens - cached)
  return (
    (uncached / 1000) * pricing.inputPer1K +
    (cached / 1000) * pricing.cachedInputPer1K +
    (usage.completionTokens / 1000) * pricing.outputPer1K
  )
}

export function estimateIngestionCostUsd(
  sessionCount: number,
  pricing: BenchPricing
): number {
  return sessionCount * pricing.ingestion.perSessionEstimatedUsd
}

/**
 * Inputs to project the running cost forward after one more example.
 * The bench-runner calls this between examples to decide whether to
 * abort before the next one against `LORE_EVAL_BENCH_MAX_USD`.
 */
export interface ProjectedCostInput {
  agentUsdSoFar: number
  judgeUsdSoFar: number
  extractionUsdSoFar?: number
  ingestionEstimatedUsdSoFar: number
}

export function projectedTotalUsd(input: ProjectedCostInput): number {
  return (
    input.agentUsdSoFar +
    input.judgeUsdSoFar +
    (input.extractionUsdSoFar ?? 0) +
    input.ingestionEstimatedUsdSoFar
  )
}
