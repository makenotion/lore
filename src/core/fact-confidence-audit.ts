import type { LoreServices } from "../services.js"
import type { FactConfidence, FactPredicate } from "../types.js"
import {
  CONFIDENCE_DISPLAY_THRESHOLD,
  MS_PER_DAY,
  STALE_CONFIDENCE_DAYS,
} from "../types.js"
import { effectiveConfidenceScore, seedConfidenceScore } from "./decay.js"
import { todayUtc } from "./task.js"

const CONFIDENCES: readonly FactConfidence[] = ["certain", "likely", "speculative"]
const SCORE_EPSILON = 1e-9

export type ConfidenceCounts = Record<FactConfidence, number>

export interface UnknownConfidenceSummary {
  confidence: string
  total: number
}

export interface ScoreDistribution {
  veryLow: number
  low: number
  moderate: number
  trusted: number
}

export interface ScoreSummary {
  count: number
  min: number | null
  max: number | null
  average: number | null
}

export interface LastReferencedSummary {
  missing: number
  today: number
  within7Days: number
  within30Days: number
  within60Days: number
  over60Days: number
  invalid: number
}

export interface ScoreVsSeedSummary {
  atSeed: number
  aboveSeed: number
  belowSeed: number
  unknownConfidence: number
}

export interface DecayOpportunityExample {
  factId: string
  subject: string
  predicate: FactPredicate
  object: string
  confidence: string
  storedScore: number
  effectiveScore: number
  lastReferencedAt: string
  daysSinceLastReferenced: number
  drop: number
}

export interface DecayOpportunitySummary {
  pastGrace: number
  wouldLowerStoredScore: number
  averageDrop: number | null
  maxDrop: number | null
  examples: DecayOpportunityExample[]
}

export interface PredicateConfidenceSummary extends ConfidenceCounts {
  predicate: FactPredicate
  total: number
  unknown: number
}

export interface FactConfidenceAuditReport {
  today: string
  totalFactsScanned: number
  categorical: ConfidenceCounts
  unknownCategorical: UnknownConfidenceSummary[]
  scoredFacts: number
  unscoredFacts: number
  storedScores: ScoreSummary
  effectiveScores: ScoreSummary
  storedBuckets: ScoreDistribution
  effectiveBuckets: ScoreDistribution
  lastReferenced: LastReferencedSummary
  scoreVsSeed: ScoreVsSeedSummary
  decay: DecayOpportunitySummary
  predicates: PredicateConfidenceSummary[]
  topSpeculativePredicates: PredicateConfidenceSummary[]
}

interface RunningScoreSummary {
  count: number
  sum: number
  min: number | null
  max: number | null
}

export async function runFactConfidenceAudit(opts: {
  services: LoreServices
  projectId?: string
  today?: string
}): Promise<FactConfidenceAuditReport> {
  const today = opts.today ?? todayUtc()
  const categorical = emptyConfidenceCounts()
  const storedScores = emptyScoreSummary()
  const effectiveScores = emptyScoreSummary()
  const storedBuckets = emptyScoreDistribution()
  const effectiveBuckets = emptyScoreDistribution()
  const lastReferenced = emptyLastReferencedSummary()
  const scoreVsSeed: ScoreVsSeedSummary = {
    atSeed: 0,
    aboveSeed: 0,
    belowSeed: 0,
    unknownConfidence: 0,
  }
  const decayExamples: DecayOpportunityExample[] = []
  const predicateCounts = new Map<FactPredicate, PredicateConfidenceSummary>()
  const unknownCategoricalCounts = new Map<string, number>()

  let totalFactsScanned = 0
  let scoredFacts = 0
  let unscoredFacts = 0
  let decayPastGrace = 0
  let decayWouldLowerStoredScore = 0
  let decayDropSum = 0
  let maxDrop: number | null = null

  for await (const fact of opts.services.facts.listAllForBackfill({
    projectId: opts.projectId,
  })) {
    totalFactsScanned += 1
    const rawConfidence = String(fact.confidence)
    const knownConfidence = knownFactConfidence(rawConfidence)
    const predicate = predicateSummary(predicateCounts, fact.predicate)
    predicate.total += 1
    if (knownConfidence === null) {
      unknownCategoricalCounts.set(
        rawConfidence,
        (unknownCategoricalCounts.get(rawConfidence) ?? 0) + 1
      )
      predicate.unknown += 1
    } else {
      categorical[knownConfidence] += 1
      predicate[knownConfidence] += 1
    }

    const confidenceScore = fact.confidenceScore ?? null
    const lastReferencedAt = fact.lastReferencedAt ?? null
    const lastReferencedDays = classifyLastReferenced(
      lastReferencedAt,
      today,
      lastReferenced
    )

    if (confidenceScore === null) {
      unscoredFacts += 1
      continue
    }

    scoredFacts += 1
    addScore(storedScores, confidenceScore)
    addBucket(storedBuckets, confidenceScore)

    if (knownConfidence === null) {
      scoreVsSeed.unknownConfidence += 1
    } else {
      const seed = seedConfidenceScore(knownConfidence)
      if (Math.abs(confidenceScore - seed) <= SCORE_EPSILON) {
        scoreVsSeed.atSeed += 1
      } else if (confidenceScore > seed) {
        scoreVsSeed.aboveSeed += 1
      } else {
        scoreVsSeed.belowSeed += 1
      }
    }

    const effective = effectiveConfidenceScore(confidenceScore, lastReferencedAt, today)
    if (effective !== null) {
      addScore(effectiveScores, effective)
      addBucket(effectiveBuckets, effective)
      const drop = confidenceScore - effective
      if (lastReferencedDays !== null && lastReferencedDays > STALE_CONFIDENCE_DAYS) {
        decayPastGrace += 1
      }
      if (drop > SCORE_EPSILON) {
        decayWouldLowerStoredScore += 1
        decayDropSum += drop
        maxDrop = maxDrop === null ? drop : Math.max(maxDrop, drop)
        if (lastReferencedAt !== null && lastReferencedDays !== null) {
          decayExamples.push({
            factId: fact.id,
            subject: fact.subject,
            predicate: fact.predicate,
            object: fact.object,
            confidence: rawConfidence,
            storedScore: confidenceScore,
            effectiveScore: effective,
            lastReferencedAt,
            daysSinceLastReferenced: lastReferencedDays,
            drop,
          })
        }
      }
    }
  }

  decayExamples.sort((a, b) => b.drop - a.drop)
  const predicates = Array.from(predicateCounts.values()).sort((a, b) => {
    if (a.total === b.total) return a.predicate.localeCompare(b.predicate)
    return b.total - a.total
  })
  const topSpeculativePredicates = predicates
    .filter((row) => row.speculative > 0)
    .sort((a, b) => {
      if (a.speculative === b.speculative) return a.predicate.localeCompare(b.predicate)
      return b.speculative - a.speculative
    })
    .slice(0, 5)

  return {
    today,
    totalFactsScanned,
    categorical,
    unknownCategorical: Array.from(unknownCategoricalCounts.entries())
      .map(([confidence, total]) => ({ confidence, total }))
      .sort((a, b) => {
        if (a.total === b.total) return a.confidence.localeCompare(b.confidence)
        return b.total - a.total
      }),
    scoredFacts,
    unscoredFacts,
    storedScores: finalizeScoreSummary(storedScores),
    effectiveScores: finalizeScoreSummary(effectiveScores),
    storedBuckets,
    effectiveBuckets,
    lastReferenced,
    scoreVsSeed,
    decay: {
      pastGrace: decayPastGrace,
      wouldLowerStoredScore: decayWouldLowerStoredScore,
      averageDrop:
        decayWouldLowerStoredScore === 0
          ? null
          : decayDropSum / decayWouldLowerStoredScore,
      maxDrop,
      examples: decayExamples.slice(0, 5),
    },
    predicates,
    topSpeculativePredicates,
  }
}

function emptyConfidenceCounts(): ConfidenceCounts {
  return {
    certain: 0,
    likely: 0,
    speculative: 0,
  }
}

function emptyScoreSummary(): RunningScoreSummary {
  return {
    count: 0,
    sum: 0,
    min: null,
    max: null,
  }
}

function emptyScoreDistribution(): ScoreDistribution {
  return {
    veryLow: 0,
    low: 0,
    moderate: 0,
    trusted: 0,
  }
}

function emptyLastReferencedSummary(): LastReferencedSummary {
  return {
    missing: 0,
    today: 0,
    within7Days: 0,
    within30Days: 0,
    within60Days: 0,
    over60Days: 0,
    invalid: 0,
  }
}

function predicateSummary(
  counts: Map<FactPredicate, PredicateConfidenceSummary>,
  predicate: FactPredicate
): PredicateConfidenceSummary {
  const existing = counts.get(predicate)
  if (existing) return existing
  const created = {
    predicate,
    total: 0,
    unknown: 0,
    ...emptyConfidenceCounts(),
  }
  counts.set(predicate, created)
  return created
}

function addScore(summary: RunningScoreSummary, score: number): void {
  summary.count += 1
  summary.sum += score
  summary.min = summary.min === null ? score : Math.min(summary.min, score)
  summary.max = summary.max === null ? score : Math.max(summary.max, score)
}

function finalizeScoreSummary(summary: RunningScoreSummary): ScoreSummary {
  return {
    count: summary.count,
    min: summary.min,
    max: summary.max,
    average: summary.count === 0 ? null : summary.sum / summary.count,
  }
}

function addBucket(buckets: ScoreDistribution, score: number): void {
  if (score < 0.2) {
    buckets.veryLow += 1
  } else if (score < 0.4) {
    buckets.low += 1
  } else if (score < CONFIDENCE_DISPLAY_THRESHOLD) {
    buckets.moderate += 1
  } else {
    buckets.trusted += 1
  }
}

function classifyLastReferenced(
  lastReferencedAt: string | null,
  today: string,
  summary: LastReferencedSummary
): number | null {
  if (lastReferencedAt === null) {
    summary.missing += 1
    return null
  }
  const days = daysSince(today, lastReferencedAt)
  if (days === null) {
    summary.invalid += 1
    return null
  }
  if (days === 0) summary.today += 1
  else if (days <= 7) summary.within7Days += 1
  else if (days <= 30) summary.within30Days += 1
  else if (days <= 60) summary.within60Days += 1
  else summary.over60Days += 1
  return days
}

function daysSince(today: string, earlier: string): number | null {
  const todayMs = Date.parse(today)
  const earlierMs = Date.parse(earlier)
  if (Number.isNaN(todayMs) || Number.isNaN(earlierMs)) return null
  return Math.max(0, Math.floor((todayMs - earlierMs) / MS_PER_DAY))
}

export function confidenceNames(): readonly FactConfidence[] {
  return CONFIDENCES
}

function knownFactConfidence(confidence: string): FactConfidence | null {
  return (CONFIDENCES as readonly string[]).includes(confidence)
    ? (confidence as FactConfidence)
    : null
}
