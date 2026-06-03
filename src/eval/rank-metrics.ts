export interface RankingMetrics {
  relevantCount: number
  returnedRelevantCount: number
  firstRelevantRank: number | null
  ranksByRelevantId: Record<string, number>
  recallAt: Record<string, number>
  precisionAt: Record<string, number>
  completenessAt: Record<string, number>
  ndcgAt: Record<string, number>
  mrrAt: Record<string, number>
  averagePrecisionAt: Record<string, number>
}

export interface RelevanceLabel {
  id: string
  relevance: number
}

export function scoreRanking(input: {
  returnedIds: string[]
  relevant: RelevanceLabel[]
  kValues: number[]
}): RankingMetrics {
  const relevanceById = new Map<string, number>()
  for (const label of input.relevant) {
    if (label.relevance <= 0) continue
    const existing = relevanceById.get(label.id) ?? 0
    relevanceById.set(label.id, Math.max(existing, label.relevance))
  }
  const kValues = normalizeKValues(input.kValues)
  const ranksByRelevantId: Record<string, number> = {}
  let firstRelevantRank: number | null = null
  let returnedRelevantCount = 0

  for (const [index, id] of input.returnedIds.entries()) {
    if (!relevanceById.has(id)) continue
    const rank = index + 1
    if (ranksByRelevantId[id] !== undefined) continue
    ranksByRelevantId[id] = rank
    returnedRelevantCount += 1
    if (firstRelevantRank === null || rank < firstRelevantRank) {
      firstRelevantRank = rank
    }
  }

  const relevantCount = relevanceById.size
  const recallAt: Record<string, number> = {}
  const precisionAt: Record<string, number> = {}
  const completenessAt: Record<string, number> = {}
  const ndcgAt: Record<string, number> = {}
  const mrrAt: Record<string, number> = {}
  const averagePrecisionAt: Record<string, number> = {}

  for (const k of kValues) {
    const returnedAtK = input.returnedIds.slice(0, k)
    const relevantAtK = returnedAtK.filter((id, index) => {
      return relevanceById.has(id) && input.returnedIds.indexOf(id) === index
    })
    recallAt[String(k)] =
      relevantCount === 0 ? 0 : roundMetric(relevantAtK.length / relevantCount)
    precisionAt[String(k)] = roundMetric(relevantAtK.length / k)
    completenessAt[String(k)] =
      relevantCount > 0 && relevantAtK.length === relevantCount ? 1 : 0
    ndcgAt[String(k)] = normalizedDiscountedCumulativeGain({
      returnedIds: input.returnedIds,
      relevanceById,
      k,
    })
    mrrAt[String(k)] =
      firstRelevantRank !== null && firstRelevantRank <= k
        ? roundMetric(1 / firstRelevantRank)
        : 0
    averagePrecisionAt[String(k)] =
      relevantCount === 0
        ? 0
        : roundMetric(
            averagePrecisionSum(input.returnedIds.slice(0, k), relevanceById) /
              relevantCount
          )
  }

  return {
    relevantCount,
    returnedRelevantCount,
    firstRelevantRank,
    ranksByRelevantId,
    recallAt,
    precisionAt,
    completenessAt,
    ndcgAt,
    mrrAt,
    averagePrecisionAt,
  }
}

export function averageMetric(values: number[]): number {
  if (values.length === 0) return 0
  return roundMetric(values.reduce((sum, value) => sum + value, 0) / values.length)
}

export function roundMetric(value: number): number {
  return Math.round(value * 10000) / 10000
}

function normalizeKValues(kValues: number[]): number[] {
  return Array.from(new Set(kValues))
    .filter((k) => Number.isSafeInteger(k) && k > 0)
    .sort((a, b) => a - b)
}

function normalizedDiscountedCumulativeGain(input: {
  returnedIds: string[]
  relevanceById: Map<string, number>
  k: number
}): number {
  const seen = new Set<string>()
  const dcg = discountedCumulativeGain(
    input.returnedIds.slice(0, input.k).map((id) => {
      if (seen.has(id)) return 0
      seen.add(id)
      return input.relevanceById.get(id) ?? 0
    })
  )
  const ideal = Array.from(input.relevanceById.values())
    .sort((a, b) => b - a)
    .slice(0, input.k)
  const idcg = discountedCumulativeGain(ideal)
  return idcg === 0 ? 0 : roundMetric(dcg / idcg)
}

function averagePrecisionSum(
  returnedIds: string[],
  relevanceById: Map<string, number>
): number {
  const seen = new Set<string>()
  let returnedRelevantCount = 0
  let out = 0
  for (const [index, id] of returnedIds.entries()) {
    if (!relevanceById.has(id) || seen.has(id)) continue
    seen.add(id)
    returnedRelevantCount += 1
    out += returnedRelevantCount / (index + 1)
  }
  return out
}

function discountedCumulativeGain(relevances: number[]): number {
  return relevances.reduce((sum, relevance, index) => {
    if (relevance <= 0) return sum
    return sum + (2 ** relevance - 1) / Math.log2(index + 2)
  }, 0)
}
