/**
 * Confidence scoring policy and display thresholds.
 */

import type { MemoryConfidence } from "../types/domain.js"

/**
 * Confidence Score is constrained to [CONFIDENCE_SCORE_MIN,
 * CONFIDENCE_SCORE_MAX] inclusive. Out-of-range writes are clamped by
 * `clampConfidenceScore`. Notion's number column has no native range
 * constraint, so the clamp is the single enforcement point.
 */
export const CONFIDENCE_SCORE_MIN = 0
export const CONFIDENCE_SCORE_MAX = 1

/**
 * Initial Confidence Score seeded from the categorical Confidence select
 * on first read-touch (or by `lore migrate --build-confidence-scores`).
 * Empirical: `certain` lands at 0.9 (not 1.0 — leaves headroom for
 * repeated confirmation to push higher), `likely` at 0.6, `speculative`
 * at 0.3. A memory written without an explicit `Confidence` defaults to
 * `certain` per `pageToMemory`, so the seeded value is 0.9.
 */
export const CONFIDENCE_SEED: Record<MemoryConfidence, number> = {
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
 * Bump multiplier applied on every read-citation. The bump uses
 * `next = current + (1 - current) * BUMP_RATE` so high-confidence rows
 * ratchet slowly and stay below 1.0; low-confidence rows recover
 * faster than a high-confidence row decays per stale day.
 */
export const BUMP_RATE = 0.05

/**
 * Per-day multiplier applied past the `STALE_CONFIDENCE_DAYS` grace.
 * `next = current * DECAY_RATE^staleDays` — at 0.99, half-life past
 * the grace is ~69 stale days.
 */
export const DECAY_RATE = 0.99

/**
 * Multiplier applied on a contradiction signal (`lore-correct`,
 * `lore-supersede`). Aggressive: a single contradiction halves the
 * stored score. Asymmetry vs. `BUMP_RATE` is deliberate — contradiction
 * is high-quality negative evidence, not the diffuse signal neglect
 * carries.
 */
export const DECREMENT_FACTOR = 0.5

/**
 * Floor for the RRF weighting factor exposed by `confidenceFactor`.
 * `score = 0` maps to this value; `score = 1` maps to 1. Preserves the
 * "score is a tiebreaker, not a veto" intuition — a maximally-decayed
 * memory still surfaces at half the weight of a fully-trusted one.
 */
export const CONFIDENCE_FACTOR_MIN = 0.5

/**
 * Threshold below which `formatMemoryListItem` renders an italic trust
 * indicator between the heading and the synopsis. Pinned at 0.5 to match
 * `CONFIDENCE_FACTOR_MIN` — a row whose RRF factor has bottomed out IS
 * the row that needs the visible signal. A `null` Confidence Score never
 * renders the indicator either, so vaults without populated scores look
 * unchanged until `lore migrate --build-confidence-scores` populates them.
 *
 * Single source of truth for the per-row trust indicator AND the
 * low-score branch of the Stale Confidence wake-up subsection.
 * Diverging the two would mean a row could surface in Stale Confidence's
 * low-score branch AND fail to flag in Recent Memories (or vice versa),
 * which is incoherent for a score-driven signal. The neglect branch of
 * the Stale Confidence subsection is governed by `STALE_CONFIDENCE_DAYS`
 * instead and is allowed to surface rows whose stored score is above
 * this threshold.
 */
export const CONFIDENCE_DISPLAY_THRESHOLD = 0.5

/**
 * Map a numeric Confidence Score to the human-readable label rendered
 * below the heading on recall / search / wake-up listings. Three
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
 * wake-up, and a literal "0.34" is technically more precise but harder
 * to read at a glance than `"low confidence"`. Bucket thresholds are
 * pinned in code; tuning is one-line.
 *
 * Returns `null` only above the display threshold — never on a valid
 * in-range score. The caller's `null` check on `Memory.confidenceScore`
 * (the "no score yet / unmigrated row" case) stays at the call site
 * because `null` there is structurally different from "scored above
 * the indicator threshold."
 */
export function formatTrustLabel(score: number): string | null {
  if (score >= CONFIDENCE_DISPLAY_THRESHOLD) return null
  if (score < 0.2) return "very low confidence"
  if (score < 0.4) return "low confidence"
  return "moderate confidence"
}

/**
 * Maximum rows surfaced in the Stale Confidence wake-up subsection.
 * Default 5 — tight enough to keep the subsection a triage prompt
 * rather than an exhaustive list. When the section is saturated
 * (returned exactly STALE_CONFIDENCE_LIMIT rows), the heading prefixes
 * the count with `≥` (e.g. `≥5`) to signal "at least this many"; no
 * exact total is computed (one query, no inventory).
 */
export const STALE_CONFIDENCE_LIMIT = 5

/**
 * Milliseconds in a day. Cross-cutting constant — every native-`Date`
 * day-arithmetic site (`taskDaysOverdue`, `decayConfidenceScore`,
 * `MemoryService.queryStaleConfidence`, the wake-up renderer's
 * `Last referenced: Nd ago` builder, `task-reconcile`'s age scoring,
 * `loadWakeUpData`'s digest-freshness window, `dateBucket`) divides
 * by this value. Pinned here rather than a per-module local so a
 * future tweak (or the inevitable contributor who writes
 * `1000 * 60 * 60 * 24` from muscle memory) finds one source of truth.
 */
export const MS_PER_DAY = 86_400_000
