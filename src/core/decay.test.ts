import { describe, expect, it } from "vitest"
import {
  bumpConfidenceScore,
  clampConfidenceScore,
  confidenceFactor,
  decayConfidenceScore,
  decrementConfidenceScore,
  effectiveConfidenceFactor,
  effectiveConfidenceScore,
  seedConfidenceScore,
} from "./decay.js"

describe("clampConfidenceScore", () => {
  it("returns the value when in range", () => {
    expect(clampConfidenceScore(0)).toBe(0)
    expect(clampConfidenceScore(0.5)).toBe(0.5)
    expect(clampConfidenceScore(1)).toBe(1)
  })

  it("clamps below zero up to zero", () => {
    expect(clampConfidenceScore(-0.5)).toBe(0)
    expect(clampConfidenceScore(-100)).toBe(0)
  })

  it("clamps above one down to one", () => {
    expect(clampConfidenceScore(1.5)).toBe(1)
    expect(clampConfidenceScore(100)).toBe(1)
  })
})

describe("seedConfidenceScore", () => {
  it("maps categorical confidence to numeric seeds", () => {
    expect(seedConfidenceScore("certain")).toBe(0.9)
    expect(seedConfidenceScore("likely")).toBe(0.6)
    expect(seedConfidenceScore("speculative")).toBe(0.3)
  })
})

describe("bumpConfidenceScore", () => {
  it("nudges middling scores upward via exponential approach", () => {
    expect(bumpConfidenceScore(0.5)).toBeCloseTo(0.525, 6)
  })

  it("bumps high-confidence rows by a small amount", () => {
    expect(bumpConfidenceScore(0.95)).toBeCloseTo(0.9525, 6)
  })

  it("clamps at one — repeated bumps never escape the ceiling", () => {
    expect(bumpConfidenceScore(1.0)).toBe(1.0)
  })

  it("recovers a maximally-decayed row by 5% of the gap to one", () => {
    expect(bumpConfidenceScore(0.0)).toBeCloseTo(0.05, 6)
  })
})

describe("decrementConfidenceScore", () => {
  it("halves a high-confidence score", () => {
    expect(decrementConfidenceScore(0.9)).toBeCloseTo(0.45, 6)
  })

  it("halves a middling score", () => {
    expect(decrementConfidenceScore(0.5)).toBeCloseTo(0.25, 6)
  })

  it("leaves zero at zero (the floor is invariant under halving)", () => {
    expect(decrementConfidenceScore(0.0)).toBe(0.0)
  })
})

describe("decayConfidenceScore", () => {
  const TODAY = "2026-04-29"

  it("returns current unchanged when never touched (lastReferencedAt is null)", () => {
    expect(decayConfidenceScore(0.9, null, TODAY)).toBe(0.9)
  })

  it("returns current unchanged on the day-of (zero days elapsed)", () => {
    expect(decayConfidenceScore(0.9, "2026-04-29", TODAY)).toBe(0.9)
  })

  it("returns current unchanged within the 60-day grace window", () => {
    // 2026-04-29 minus 60 days = 2026-02-28 — exactly at the boundary.
    expect(decayConfidenceScore(0.9, "2026-02-28", TODAY)).toBe(0.9)
  })

  it("decays past the grace window by DECAY_RATE per stale day", () => {
    // 2026-04-29 minus 90 days = 2026-01-29 → 30 stale days.
    // 0.9 * 0.99^30 ≈ 0.6651
    expect(decayConfidenceScore(0.9, "2026-01-29", TODAY)).toBeCloseTo(
      0.9 * Math.pow(0.99, 30),
      6
    )
  })

  it("decays substantially over six months of neglect", () => {
    // 2026-04-29 minus 180 days = 2025-10-31 → 120 stale days.
    expect(decayConfidenceScore(0.9, "2025-10-31", TODAY)).toBeCloseTo(
      0.9 * Math.pow(0.99, 120),
      6
    )
  })

  it("returns current unchanged on garbage `lastReferencedAt` input (NaN-resistant)", () => {
    expect(decayConfidenceScore(0.9, "garbage", TODAY)).toBe(0.9)
  })

  it("returns current unchanged on garbage `today` input (NaN-resistant)", () => {
    expect(decayConfidenceScore(0.9, "2026-01-29", "not-a-date")).toBe(0.9)
  })

  it("leaves a zero score at zero across any neglect window", () => {
    expect(decayConfidenceScore(0, "2025-01-01", TODAY)).toBe(0)
  })

  it("clamps an out-of-range negative input up to zero (caller misuse safety net)", () => {
    // The spec contract is `current ∈ [0, 1]`, but `clampConfidenceScore`
    // at the write boundary is the single enforcement point — this test
    // pins that the decay path tolerates a negative caller input rather
    // than producing an unbounded `negative * 0.99^k` value that would
    // leak past clamping in some hypothetical future caller.
    expect(decayConfidenceScore(-0.5, "2025-01-01", TODAY)).toBe(0)
  })
})

describe("confidenceFactor", () => {
  it("returns 1.0 for null (unscored — neutral, pre-migration rows)", () => {
    expect(confidenceFactor(null)).toBe(1.0)
  })

  it("returns 1.0 for a maxed-out score", () => {
    expect(confidenceFactor(1.0)).toBeCloseTo(1.0, 6)
  })

  it("returns 0.5 for a maximally-decayed score (the floor)", () => {
    expect(confidenceFactor(0.0)).toBeCloseTo(0.5, 6)
  })

  it("returns 0.75 for a middling score (linear interpolation)", () => {
    expect(confidenceFactor(0.5)).toBeCloseTo(0.75, 6)
  })

  it("interpolates linearly between the floor and the ceiling", () => {
    expect(confidenceFactor(0.2)).toBeCloseTo(0.6, 6)
    expect(confidenceFactor(0.8)).toBeCloseTo(0.9, 6)
  })

  it("LORE_DISABLE_CONFIDENCE_FACTOR=1 returns 1.0 unconditionally — kill switch (issue 0.8.0/08)", () => {
    // Operator escape hatch. The kill switch lives at the top of
    // `confidenceFactor` so single-branch and hybrid paths share one
    // bypass — same posture as `LORE_FORCE_SEMANTIC_SEARCH` and
    // `LORE_DISABLE_NEAR_DUPLICATE_PROBE`. With the env var set, every
    // call returns 1.0 — even for fully-decayed (`0.0`) rows that would
    // otherwise map to `CONFIDENCE_FACTOR_MIN`. Exhaustive coverage
    // across the input range pins that a future refactor splitting the
    // bypass between scored / unscored paths is caught.
    const original = process.env["LORE_DISABLE_CONFIDENCE_FACTOR"]
    process.env["LORE_DISABLE_CONFIDENCE_FACTOR"] = "1"
    try {
      expect(confidenceFactor(0.0)).toBe(1.0)
      expect(confidenceFactor(0.5)).toBe(1.0)
      expect(confidenceFactor(1.0)).toBe(1.0)
      expect(confidenceFactor(null)).toBe(1.0)
    } finally {
      if (original === undefined) {
        delete process.env["LORE_DISABLE_CONFIDENCE_FACTOR"]
      } else {
        process.env["LORE_DISABLE_CONFIDENCE_FACTOR"] = original
      }
    }
  })

  it("LORE_DISABLE_CONFIDENCE_FACTOR set to anything other than '1' does NOT activate the kill switch", () => {
    // Strict-string match: the kill switch fires only on exact "1", same
    // posture as every other lore env knob. Empty string, "true", "yes",
    // "on", and other plausible truthy values must NOT bypass.
    const original = process.env["LORE_DISABLE_CONFIDENCE_FACTOR"]
    try {
      for (const value of ["", "0", "true", "yes", "on", "false"]) {
        process.env["LORE_DISABLE_CONFIDENCE_FACTOR"] = value
        // 0.0 input → factor 0.5 (not bypassed to 1.0)
        expect(confidenceFactor(0.0)).toBeCloseTo(0.5, 6)
      }
    } finally {
      if (original === undefined) {
        delete process.env["LORE_DISABLE_CONFIDENCE_FACTOR"]
      } else {
        process.env["LORE_DISABLE_CONFIDENCE_FACTOR"] = original
      }
    }
  })
})

describe("effectiveConfidenceScore", () => {
  const TODAY = "2026-04-29"

  it("returns null for unscored rows", () => {
    expect(effectiveConfidenceScore(null, "2025-10-31", TODAY)).toBeNull()
  })

  it("applies neglect decay without mutating the stored score", () => {
    const stored = 0.9
    const effective = effectiveConfidenceScore(stored, "2025-10-31", TODAY)

    expect(stored).toBe(0.9)
    expect(effective).toBeCloseTo(0.9 * Math.pow(0.99, 120), 6)
  })
})

describe("effectiveConfidenceFactor", () => {
  const TODAY = "2026-04-29"

  it("uses the decayed effective score for ranking", () => {
    const factor = effectiveConfidenceFactor(0.9, "2025-10-31", TODAY)

    expect(factor).toBeCloseTo(0.5 + 0.5 * (0.9 * Math.pow(0.99, 120)), 6)
  })

  it("keeps null scores neutral", () => {
    expect(effectiveConfidenceFactor(null, "2025-10-31", TODAY)).toBe(1.0)
  })
})
