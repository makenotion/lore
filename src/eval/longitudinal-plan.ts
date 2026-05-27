import type {
  LongitudinalTaskArtifact,
  LongitudinalTaskCondition,
} from "./task-runner/schema.js"

export interface LongitudinalBenchmarkPlanOptions {
  toCondition?: Exclude<LongitudinalTaskCondition, "no-memory">
  mde?: number
  power?: number
  alpha?: number
  twoSided?: boolean
  budgetUsd?: number
  costPerConditionRunUsd?: number
  conditionsPerScenario?: number
}

export interface LongitudinalPairedOutcomes {
  pairs: number
  bothPassed: number
  bothFailed: number
  lifted: number
  harmed: number
  missing: number
  observedLift: number | null
  observedDiscordance: number | null
}

export interface LongitudinalConditionEfficiency {
  condition: LongitudinalTaskCondition
  trials: number
  measuredTokenTrials: number
  meanPrimaryTokensPerTrial: number | null
  measuredElapsedTrials: number
  meanElapsedMsPerTrial: number | null
  measuredCostTrials: number
  meanPrimaryCostUsdPerTrial: number | null
}

export interface LongitudinalPairedEfficiencyDeltas {
  pairs: number
  tokenPairs: number
  meanPrimaryTokenDelta: number | null
  meanPrimaryTokenDeltaPct: number | null
  elapsedPairs: number
  meanElapsedMsDelta: number | null
  meanElapsedDeltaPct: number | null
  costPairs: number
  meanPrimaryCostUsdDelta: number | null
  meanPrimaryCostDeltaPct: number | null
}

export interface LongitudinalEfficiencySummary {
  conditions: Record<LongitudinalTaskCondition, LongitudinalConditionEfficiency>
  pairedDeltas: LongitudinalPairedEfficiencyDeltas
}

export interface LongitudinalBenchmarkPlan {
  fromCondition: "no-memory"
  toCondition: Exclude<LongitudinalTaskCondition, "no-memory">
  alpha: number
  power: number
  twoSided: boolean
  mde: number
  pairedOutcomes: LongitudinalPairedOutcomes
  efficiency: LongitudinalEfficiencySummary
  estimatedPairsRequired: number
  conditionRunsRequired: number
  conditionsPerScenario: number
  assumedHarmRate: number
  assumedDiscordance: number
  measuredCostUsd: number | null
  measuredCostPerConditionRunUsd: number | null
  measuredCostConditionRuns: number
  totalCostConditionRuns: number
  measuredCostCoverage: number
  costPerConditionRunUsd: number | null
  projectedCostUsd: number | null
  budgetUsd: number | null
  budgetCoversPlan: boolean | null
  maxPairsAtBudget: number | null
}

export function buildLongitudinalBenchmarkPlan(
  artifact: LongitudinalTaskArtifact,
  options: LongitudinalBenchmarkPlanOptions = {}
): LongitudinalBenchmarkPlan {
  const toCondition = options.toCondition ?? defaultMemoryCondition(artifact)
  const mde = options.mde ?? 0.15
  const power = options.power ?? 0.8
  const alpha = options.alpha ?? 0.05
  const twoSided = options.twoSided ?? true
  assertUnitInterval("mde", mde)
  assertUnitInterval("power", power)
  assertUnitInterval("alpha", alpha)
  if (mde === 0) throw new Error("mde must be greater than 0")
  if (power === 0 || power === 1) throw new Error("power must be between 0 and 1")
  if (alpha === 0 || alpha === 1) throw new Error("alpha must be between 0 and 1")

  const pairedOutcomes = countPairedOutcomes(artifact, toCondition)
  const efficiency = summarizeEfficiency(artifact, toCondition)
  const assumedHarmRate =
    pairedOutcomes.pairs === 0 ? 0 : pairedOutcomes.harmed / pairedOutcomes.pairs
  const estimatedPairsRequired = estimatePairedBinarySampleSize({
    mde,
    alpha,
    power,
    twoSided,
    harmRate: assumedHarmRate,
  })
  const conditionsPerScenario =
    options.conditionsPerScenario ?? countExecutedConditions(artifact)
  const conditionRunsRequired = estimatedPairsRequired * conditionsPerScenario
  const costCoverage = summarizePrimaryCostCoverage(artifact)
  const measuredCostUsd = costCoverage.complete ? costCoverage.totalUsd : null
  const measuredCostPerConditionRunUsd =
    measuredCostUsd === null || costCoverage.totalConditionRuns === 0
      ? null
      : measuredCostUsd / costCoverage.totalConditionRuns
  const costPerConditionRunUsd =
    options.costPerConditionRunUsd ?? measuredCostPerConditionRunUsd
  const budgetUsd = options.budgetUsd ?? 1000
  const projectedCostUsd =
    costPerConditionRunUsd === null
      ? null
      : conditionRunsRequired * costPerConditionRunUsd
  const maxPairsAtBudget =
    costPerConditionRunUsd === null || budgetUsd === null
      ? null
      : Math.floor(budgetUsd / (costPerConditionRunUsd * conditionsPerScenario))

  return {
    fromCondition: "no-memory",
    toCondition,
    alpha,
    power,
    twoSided,
    mde,
    pairedOutcomes,
    efficiency,
    estimatedPairsRequired,
    conditionRunsRequired,
    conditionsPerScenario,
    assumedHarmRate,
    assumedDiscordance: mde + 2 * assumedHarmRate,
    measuredCostUsd,
    measuredCostPerConditionRunUsd,
    measuredCostConditionRuns: costCoverage.measuredConditionRuns,
    totalCostConditionRuns: costCoverage.totalConditionRuns,
    measuredCostCoverage: costCoverage.coverage,
    costPerConditionRunUsd,
    projectedCostUsd,
    budgetUsd,
    budgetCoversPlan: projectedCostUsd === null ? null : projectedCostUsd <= budgetUsd,
    maxPairsAtBudget,
  }
}

function summarizeEfficiency(
  artifact: LongitudinalTaskArtifact,
  toCondition: Exclude<LongitudinalTaskCondition, "no-memory">
): LongitudinalEfficiencySummary {
  return {
    conditions: {
      "no-memory": summarizeConditionEfficiency(artifact, "no-memory"),
      "seeded-lore": summarizeConditionEfficiency(artifact, "seeded-lore"),
      "lore-full-loop": summarizeConditionEfficiency(artifact, "lore-full-loop"),
    },
    pairedDeltas: summarizePairedEfficiencyDeltas(artifact, toCondition),
  }
}

function summarizeConditionEfficiency(
  artifact: LongitudinalTaskArtifact,
  condition: LongitudinalTaskCondition
): LongitudinalConditionEfficiency {
  const results = artifact.results.filter((result) => result.condition === condition)
  const tokenValues = compactNumbers(results.map(primaryTokensForResult))
  const elapsedValues = compactNumbers(results.map(elapsedMsForResult))
  const costValues = compactNumbers(results.map(primaryCostUsdForResult))
  return {
    condition,
    trials: results.length,
    measuredTokenTrials: tokenValues.length,
    meanPrimaryTokensPerTrial: meanOrNull(tokenValues),
    measuredElapsedTrials: elapsedValues.length,
    meanElapsedMsPerTrial: meanOrNull(elapsedValues),
    measuredCostTrials: costValues.length,
    meanPrimaryCostUsdPerTrial: meanOrNull(costValues),
  }
}

function summarizePairedEfficiencyDeltas(
  artifact: LongitudinalTaskArtifact,
  toCondition: Exclude<LongitudinalTaskCondition, "no-memory">
): LongitudinalPairedEfficiencyDeltas {
  const scenarioIds = new Set(artifact.results.map((result) => result.scenarioId))
  const tokenDeltas: number[] = []
  const tokenBase: number[] = []
  const elapsedDeltas: number[] = []
  const elapsedBase: number[] = []
  const costDeltas: number[] = []
  const costBase: number[] = []
  let pairs = 0
  for (const scenarioId of scenarioIds) {
    const noMemory = artifact.results.find(
      (result) => result.scenarioId === scenarioId && result.condition === "no-memory"
    )
    const memory = artifact.results.find(
      (result) => result.scenarioId === scenarioId && result.condition === toCondition
    )
    if (!noMemory || !memory) continue
    pairs++
    collectDelta(
      tokenDeltas,
      tokenBase,
      primaryTokensForResult(noMemory),
      primaryTokensForResult(memory)
    )
    collectDelta(
      elapsedDeltas,
      elapsedBase,
      elapsedMsForResult(noMemory),
      elapsedMsForResult(memory)
    )
    collectDelta(
      costDeltas,
      costBase,
      primaryCostUsdForResult(noMemory),
      primaryCostUsdForResult(memory)
    )
  }
  const meanTokenDelta = meanOrNull(tokenDeltas)
  const meanElapsedDelta = meanOrNull(elapsedDeltas)
  const meanCostDelta = meanOrNull(costDeltas)
  return {
    pairs,
    tokenPairs: tokenDeltas.length,
    meanPrimaryTokenDelta: meanTokenDelta,
    meanPrimaryTokenDeltaPct: percentDelta(meanTokenDelta, meanOrNull(tokenBase)),
    elapsedPairs: elapsedDeltas.length,
    meanElapsedMsDelta: meanElapsedDelta,
    meanElapsedDeltaPct: percentDelta(meanElapsedDelta, meanOrNull(elapsedBase)),
    costPairs: costDeltas.length,
    meanPrimaryCostUsdDelta: meanCostDelta,
    meanPrimaryCostDeltaPct: percentDelta(meanCostDelta, meanOrNull(costBase)),
  }
}

function primaryTokensForResult(
  result: LongitudinalTaskArtifact["results"][number]
): number | null {
  let total = 0
  let found = false
  for (const phase of result.phases) {
    const prompt = phase.cost?.promptTokens
    const completion = phase.cost?.completionTokens
    if (
      typeof prompt === "number" &&
      Number.isFinite(prompt) &&
      typeof completion === "number" &&
      Number.isFinite(completion)
    ) {
      total += prompt + completion
      found = true
    }
  }
  return found ? total : null
}

function elapsedMsForResult(
  result: LongitudinalTaskArtifact["results"][number]
): number | null {
  if (result.phases.length === 0) return null
  let total = 0
  for (const phase of result.phases) {
    if (!Number.isFinite(phase.elapsedMs)) return null
    total += phase.elapsedMs
  }
  return total
}

function primaryCostUsdForResult(
  result: LongitudinalTaskArtifact["results"][number]
): number | null {
  let total = 0
  let found = false
  for (const phase of result.phases) {
    if (!phase.cost) {
      if (phase.agentRun !== null) return null
      continue
    }
    const usd = phase.cost?.totalUsd
    if (typeof usd === "number" && Number.isFinite(usd)) {
      total += usd
      found = true
    } else {
      return null
    }
  }
  return found ? total : null
}

function collectDelta(
  deltas: number[],
  baselineValues: number[],
  baseline: number | null,
  memory: number | null
): void {
  if (baseline === null || memory === null) return
  deltas.push(memory - baseline)
  baselineValues.push(baseline)
}

function compactNumbers(values: Array<number | null>): number[] {
  return values.filter((value): value is number => value !== null)
}

function meanOrNull(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentDelta(delta: number | null, baseline: number | null): number | null {
  if (delta === null || baseline === null || baseline === 0) return null
  return delta / baseline
}

function defaultMemoryCondition(
  artifact: LongitudinalTaskArtifact
): Exclude<LongitudinalTaskCondition, "no-memory"> {
  const seeded = artifact.summary.conditions["seeded-lore"]
  if (seeded && seeded.trials > 0) return "seeded-lore"
  return "lore-full-loop"
}

function countPairedOutcomes(
  artifact: LongitudinalTaskArtifact,
  toCondition: Exclude<LongitudinalTaskCondition, "no-memory">
): LongitudinalPairedOutcomes {
  const scenarioIds = new Set(artifact.results.map((result) => result.scenarioId))
  let bothPassed = 0
  let bothFailed = 0
  let lifted = 0
  let harmed = 0
  let missing = 0
  for (const scenarioId of scenarioIds) {
    const noMemory = artifact.results.find(
      (result) => result.scenarioId === scenarioId && result.condition === "no-memory"
    )
    const memory = artifact.results.find(
      (result) => result.scenarioId === scenarioId && result.condition === toCondition
    )
    if (!noMemory || !memory) {
      missing++
      continue
    }
    if (noMemory.success && memory.success) bothPassed++
    else if (!noMemory.success && !memory.success) bothFailed++
    else if (!noMemory.success && memory.success) lifted++
    else harmed++
  }
  const pairs = bothPassed + bothFailed + lifted + harmed
  return {
    pairs,
    bothPassed,
    bothFailed,
    lifted,
    harmed,
    missing,
    observedLift: pairs === 0 ? null : (lifted - harmed) / pairs,
    observedDiscordance: pairs === 0 ? null : (lifted + harmed) / pairs,
  }
}

function estimatePairedBinarySampleSize(input: {
  mde: number
  alpha: number
  power: number
  twoSided: boolean
  harmRate: number
}): number {
  const liftedRate = input.harmRate + input.mde
  if (liftedRate > 1) {
    throw new Error("mde + observed harm rate cannot exceed 1")
  }
  const discordance = liftedRate + input.harmRate
  const delta = input.mde
  const alphaTail = input.twoSided ? input.alpha / 2 : input.alpha
  const zAlpha = inverseStandardNormal(1 - alphaTail)
  const zPower = inverseStandardNormal(input.power)
  const varianceUnderAlternative = Math.max(0, discordance - delta * delta)
  const numerator =
    zAlpha * Math.sqrt(discordance) + zPower * Math.sqrt(varianceUnderAlternative)
  return Math.ceil((numerator * numerator) / (delta * delta))
}

function countExecutedConditions(artifact: LongitudinalTaskArtifact): number {
  return Object.values(artifact.summary.conditions).filter((condition) => {
    return condition.trials > 0
  }).length
}

function summarizePrimaryCostCoverage(artifact: LongitudinalTaskArtifact): {
  totalUsd: number
  measuredConditionRuns: number
  totalConditionRuns: number
  coverage: number
  complete: boolean
} {
  let total = 0
  let measuredConditionRuns = 0
  for (const result of artifact.results) {
    const usd = primaryCostUsdForResult(result)
    if (usd !== null) {
      total += usd
      measuredConditionRuns++
    }
  }
  return {
    totalUsd: total,
    measuredConditionRuns,
    totalConditionRuns: artifact.results.length,
    coverage:
      artifact.results.length === 0 ? 0 : measuredConditionRuns / artifact.results.length,
    complete:
      artifact.results.length > 0 && measuredConditionRuns === artifact.results.length,
  }
}

function assertUnitInterval(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1`)
  }
}

// Acklam's rational approximation. Good enough for planning output; callers
// should not use this module for final statistical claims without review.
function inverseStandardNormal(p: number): number {
  if (p <= 0 || p >= 1 || !Number.isFinite(p)) {
    throw new Error("p must be between 0 and 1")
  }

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ]
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ]
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ]
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416,
  ]
  const plow = 0.02425
  const phigh = 1 - plow

  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    )
  }

  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return (
      -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    )
  }

  const q = p - 0.5
  const r = q * q
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  )
}
