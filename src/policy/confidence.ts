/**
 * Fact confidence scoring policy and display thresholds.
 */

import type { FactConfidence } from "../types/domain.js"

/**
 * Confidence Score is constrained to [CONFIDENCE_SCORE_MIN,
 * CONFIDENCE_SCORE_MAX] inclusive. Out-of-range writes are clamped by
 * `clampConfidenceScore`. Notion's number column has no native range
 * constraint, so the clamp is the single enforcement point.
 */
export const CONFIDENCE_SCORE_MIN = 0
export const CONFIDENCE_SCORE_MAX = 1

/**
 * Initial fact Confidence Score seeded from the categorical Confidence select.
 * Empirical: `certain` lands at 0.9 (not 1.0 — leaves headroom for
 * repeated confirmation to push higher), `likely` at 0.6, `speculative`
 */
export const CONFIDENCE_SEED: Record<FactConfidence, number> = {
  certain: 0.9,
  likely: 0.6,
  speculative: 0.3,
}

/**
 * Days of neglect (no read-citation) past which `decayConfidenceScore`
 * begins multiplying the stored value by `DECAY_RATE` per stale day.
 * Pinned at 60 — empirical, the same shape as `STALE_TASK_DAYS`.
 */
export const STALE_CONFIDENCE_DAYS = 60

/**
 * Bump multiplier applied on every fact read-citation. The bump uses
 * `next = current + (1 - current) * BUMP_RATE` so high-confidence facts
 * ratchet slowly and stay below 1.0; low-confidence facts recover
 * faster than a high-confidence fact decays per stale day.
 */
export const BUMP_RATE = 0.05

/**
 * Per-day multiplier applied past the `STALE_CONFIDENCE_DAYS` grace.
 * `next = current * DECAY_RATE^staleDays` — at 0.99, half-life past
 * the grace is ~69 stale days.
 */
export const DECAY_RATE = 0.99

/**
 * Multiplier applied when a fact is invalidated. Aggressive: a single
 * invalidation halves the stored score. Asymmetry vs. `BUMP_RATE` is
 * deliberate because invalidation is explicit negative evidence, not the
 * diffuse signal neglect carries.
 */
export const DECREMENT_FACTOR = 0.5

/**
 * Numeric anchor for consumers that import the policy constant. Retrieval
 * ranking treats Confidence Score as neutral.
 */
export const CONFIDENCE_FACTOR_MIN = 0.5

/**
 * Threshold below which fact renderers show an italic trust indicator.
 * Scores below 0.5 render a trust label; scores at or above 0.5 do not.
 */
export const CONFIDENCE_DISPLAY_THRESHOLD = 0.5

/**
 * Map a numeric Confidence Score to the human-readable label rendered
 * below a fact line on ask / audit / wake-up listings. Three
 * empirical buckets:
 *
 * `score < 0.2` → `"very low confidence"`
 * `score < 0.4` → `"low confidence"`
 * `score < CONFIDENCE_DISPLAY_THRESHOLD` (0.5) → `"moderate confidence"`
 * `score >= CONFIDENCE_DISPLAY_THRESHOLD` → `null` (no indicator)
 *
 * The above-threshold case returns `null` so the function is the single
 * gate — a forgetful caller that drops the surrounding `score < threshold`
 * predicate cannot accidentally print `"moderate confidence"` next to a
 * 0.95 row. Callers `??`-or-skip on `null`. Three tiers (not five, not
 * two) is the pragmatic granularity: agents already triage 25 rows per
 * prompt output, and a literal "0.34" is technically more precise but harder
 * to read at a glance than `"low confidence"`. Bucket thresholds are
 * pinned in code; tuning is one-line.
 *
 * Returns `null` only above the display threshold — never on a valid
 * in-range score. The caller's `null` check stays at the call site
 * because a missing score is structurally different from a score above
 * the indicator threshold.
 */
export function formatTrustLabel(score: number): string | null {
  if (score >= CONFIDENCE_DISPLAY_THRESHOLD) return null
  if (score < 0.2) return "very low confidence"
  if (score < 0.4) return "low confidence"
  return "moderate confidence"
}

/**
 * Milliseconds in a day. Cross-cutting constant — every native-`Date`
 * day-arithmetic site (`taskDaysOverdue`, `decayConfidenceScore`,
 * `task-reconcile`'s age scoring,
 * `loadWakeUpData`'s digest-freshness window, `dateBucket`) divides
 * by this value. Pinned here rather than a per-module local so a
 * future tweak (or the inevitable contributor who writes
 * `1000 * 60 * 60 * 24` from muscle memory) finds one source of truth.
 */
export const MS_PER_DAY = 86_400_000
