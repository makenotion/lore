import { describe, expect, it, vi } from "vitest"
import type { LoreServices } from "../services.js"
import type { Fact } from "../types.js"
import { runFactConfidenceAudit } from "./fact-confidence-audit.js"

const TODAY = "2026-05-29"

function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: "fact-default",
    subject: "AuthService",
    predicate: "uses",
    object: "JWT",
    projectIds: [],
    validFrom: "2026-01-01",
    validUntil: null,
    reviewBy: null,
    sourceMemoryId: null,
    confidence: "certain",
    confidenceScore: 0.9,
    lastReferencedAt: TODAY,
    createdAt: `${TODAY}T00:00:00.000Z`,
    subjectEntityId: null,
    objectEntityId: null,
    ...overrides,
  }
}

async function* factsForAudit(facts: Fact[]): AsyncGenerator<Fact> {
  for (const fact of facts) yield fact
}

function makeServices(facts: Fact[]) {
  const listAllForBackfill = vi.fn(() => factsForAudit(facts))
  const services = {
    facts: { listAllForBackfill },
  } as unknown as LoreServices
  return { services, listAllForBackfill }
}

describe("runFactConfidenceAudit", () => {
  it("summarizes categorical spread, numeric spread, and effective decay", async () => {
    const facts = [
      makeFact({
        id: "certain-seed",
        confidence: "certain",
        confidenceScore: 0.9,
        lastReferencedAt: TODAY,
      }),
      makeFact({
        id: "speculative-stale",
        confidence: "speculative",
        confidenceScore: 0.3,
        lastReferencedAt: "2026-01-01",
        predicate: "mentions",
        object: "Scheduler",
      }),
      makeFact({
        id: "speculative-unscored",
        confidence: "speculative",
        confidenceScore: null,
        lastReferencedAt: null,
        predicate: "mentions",
        object: "Router",
      }),
      makeFact({
        id: "likely-bumped",
        confidence: "likely",
        confidenceScore: 0.65,
        lastReferencedAt: "2026-05-20",
      }),
      makeFact({
        id: "likely-invalid-date",
        confidence: "likely",
        confidenceScore: 0.4,
        lastReferencedAt: "not-a-date",
      }),
    ]
    const { services, listAllForBackfill } = makeServices(facts)

    const report = await runFactConfidenceAudit({
      services,
      projectId: "project-mail",
      today: TODAY,
    })

    expect(listAllForBackfill).toHaveBeenCalledWith({ projectId: "project-mail" })
    expect(report.totalFactsScanned).toBe(5)
    expect(report.categorical).toEqual({
      certain: 1,
      likely: 2,
      speculative: 2,
    })
    expect(report.unknownCategorical).toEqual([])
    expect(report.scoredFacts).toBe(4)
    expect(report.unscoredFacts).toBe(1)
    expect(report.storedScores.average).toBeCloseTo((0.9 + 0.3 + 0.65 + 0.4) / 4)
    expect(report.effectiveScores.count).toBe(4)
    expect(report.lastReferenced).toMatchObject({
      missing: 1,
      today: 1,
      within30Days: 1,
      invalid: 1,
      over60Days: 1,
    })
    expect(report.scoreVsSeed).toEqual({
      atSeed: 2,
      aboveSeed: 1,
      belowSeed: 1,
      unknownConfidence: 0,
    })
    expect(report.decay.pastGrace).toBe(1)
    expect(report.decay.wouldLowerStoredScore).toBe(1)
    expect(report.decay.examples[0]).toMatchObject({
      factId: "speculative-stale",
      predicate: "mentions",
      daysSinceLastReferenced: 148,
    })
    expect(report.decay.examples[0]!.effectiveScore).toBeLessThan(0.3)
    expect(report.topSpeculativePredicates[0]).toMatchObject({
      predicate: "mentions",
      speculative: 2,
      total: 2,
    })
  })

  it("returns zeroed summaries for an empty vault", async () => {
    const { services } = makeServices([])

    const report = await runFactConfidenceAudit({ services, today: TODAY })

    expect(report.totalFactsScanned).toBe(0)
    expect(report.storedScores.average).toBeNull()
    expect(report.effectiveScores.average).toBeNull()
    expect(report.decay.averageDrop).toBeNull()
    expect(report.predicates).toEqual([])
  })

  it("surfaces unexpected categorical confidence values instead of hiding them", async () => {
    const facts = [
      makeFact({
        id: "unknown-confidence",
        confidence: "guessed" as Fact["confidence"],
        confidenceScore: 0.42,
        predicate: "mentions",
      }),
    ]
    const { services } = makeServices(facts)

    const report = await runFactConfidenceAudit({ services, today: TODAY })

    expect(report.categorical).toEqual({
      certain: 0,
      likely: 0,
      speculative: 0,
    })
    expect(report.unknownCategorical).toEqual([{ confidence: "guessed", total: 1 }])
    expect(report.scoreVsSeed).toEqual({
      atSeed: 0,
      aboveSeed: 0,
      belowSeed: 0,
      unknownConfidence: 1,
    })
    expect(report.predicates[0]).toMatchObject({
      predicate: "mentions",
      total: 1,
      unknown: 1,
    })
  })
})
