import { describe, expect, it } from "vitest"
import { scoreRanking } from "./rank-metrics.js"

describe("scoreRanking", () => {
  it("scores multi-relevance ranked results across k values", () => {
    const metrics = scoreRanking({
      returnedIds: ["noise", "b", "a", "other"],
      relevant: [
        { id: "a", relevance: 1 },
        { id: "b", relevance: 1 },
      ],
      kValues: [1, 2, 4],
    })

    expect(metrics).toMatchObject({
      relevantCount: 2,
      returnedRelevantCount: 2,
      firstRelevantRank: 2,
      ranksByRelevantId: {
        b: 2,
        a: 3,
      },
      recallAt: {
        "1": 0,
        "2": 0.5,
        "4": 1,
      },
      precisionAt: {
        "1": 0,
        "2": 0.5,
        "4": 0.5,
      },
      completenessAt: {
        "1": 0,
        "2": 0,
        "4": 1,
      },
      mrrAt: {
        "1": 0,
        "2": 0.5,
        "4": 0.5,
      },
      averagePrecisionAt: {
        "1": 0,
        "2": 0.25,
        "4": 0.5833,
      },
    })
    expect(metrics.ndcgAt["1"]).toBe(0)
    expect(metrics.ndcgAt["4"]).toBe(0.6934)
  })

  it("does not let duplicate returned ids inflate NDCG", () => {
    const metrics = scoreRanking({
      returnedIds: ["target", "target"],
      relevant: [{ id: "target", relevance: 1 }],
      kValues: [2],
    })

    expect(metrics.ndcgAt["2"]).toBe(1)
    expect(metrics.recallAt["2"]).toBe(1)
    expect(metrics.averagePrecisionAt["2"]).toBe(1)
  })

  it("returns zero-valued metrics when no relevant document is retrieved", () => {
    const metrics = scoreRanking({
      returnedIds: ["noise"],
      relevant: [{ id: "target", relevance: 1 }],
      kValues: [1],
    })

    expect(metrics.firstRelevantRank).toBeNull()
    expect(metrics.recallAt["1"]).toBe(0)
    expect(metrics.ndcgAt["1"]).toBe(0)
    expect(metrics.mrrAt["1"]).toBe(0)
    expect(metrics.averagePrecisionAt["1"]).toBe(0)
  })
})
