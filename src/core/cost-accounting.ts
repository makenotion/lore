import { AsyncLocalStorage } from "node:async_hooks"
import type { CostNotionSummary, CostOutputCounts } from "./cost-ledger.js"
import { emptyNotionSummary } from "./cost-ledger.js"

export interface CostAccountingContext {
  notion: CostNotionSummary
  outputs: CostOutputCounts
}

const storage = new AsyncLocalStorage<CostAccountingContext>()

export async function runWithCostAccounting<T>(
  run: () => Promise<T>
): Promise<{ result: T; context: CostAccountingContext }> {
  const context: CostAccountingContext = {
    notion: emptyNotionSummary(),
    outputs: {},
  }
  const result = await storage.run(context, run)
  return { result, context }
}

export async function captureCostAccounting<T>(
  run: () => Promise<T>
): Promise<
  | { ok: true; result: T; context: CostAccountingContext }
  | { ok: false; error: unknown; context: CostAccountingContext }
> {
  const context: CostAccountingContext = {
    notion: emptyNotionSummary(),
    outputs: {},
  }
  try {
    const result = await storage.run(context, run)
    return { ok: true, result, context }
  } catch (error) {
    return { ok: false, error, context }
  }
}

export function currentCostAccountingContext(): CostAccountingContext | undefined {
  return storage.getStore()
}

export function recordNotionRead(): void {
  const context = storage.getStore()
  if (context) context.notion.reads += 1
}

export function recordNotionWrite(): void {
  const context = storage.getStore()
  if (context) context.notion.writes += 1
}

export function recordNotionFailure(): void {
  const context = storage.getStore()
  if (context) context.notion.failures += 1
}

export function recordNotionRateLimitBackoff(): void {
  const context = storage.getStore()
  if (context) context.notion.rateLimitBackoffs += 1
}

export function addCostOutputs(outputs: CostOutputCounts | undefined): void {
  if (!outputs) return
  const context = storage.getStore()
  if (!context) return
  for (const [key, value] of Object.entries(outputs)) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) continue
    const typedKey = key as keyof CostOutputCounts
    context.outputs[typedKey] = (context.outputs[typedKey] ?? 0) + value
  }
}
