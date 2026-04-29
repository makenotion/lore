/**
 * Confidence-score algebra for the dynamic-confidence workstream.
 *
 * Pure functions only — no `Client`, no Notion calls, no I/O. The I/O
 * wrappers `MemoryService.touchOnRead` and
 * `MemoryService.decrementConfidence` (in `src/core/memory.ts`) call
 * these helpers, write the result via a single `pages.update`, and
 * route failures through a caller-supplied `onError`.
 *
 * Design contract: **write-realized lazy decay**. Every mutation of a
 * stored Confidence Score realizes the time-decay accrued since the
 * last touch, then applies its own bump or decrement. RRF (#08) reads
 * the stored value verbatim via `confidenceFactor` — no decay
 * computation at read time, no observable/stored divergence.
 */

import {
  CONFIDENCE_SCORE_MIN,
  CONFIDENCE_SCORE_MAX,
  CONFIDENCE_SEED,
  STALE_CONFIDENCE_DAYS,
  BUMP_RATE,
  DECAY_RATE,
  DECREMENT_FACTOR,
  CONFIDENCE_FACTOR_MIN,
  type MemoryConfidence,
} from "../types.js"

/**
 * Notion has no native range constraint on `number` columns; the clamp
 * is the single enforcement point on the write boundary. Every mutator
 * below routes through this helper.
 */
export function clampConfidenceScore(value: number): number {
  if (value < CONFIDENCE_SCORE_MIN) return CONFIDENCE_SCORE_MIN
  if (value > CONFIDENCE_SCORE_MAX) return CONFIDENCE_SCORE_MAX
  return value
}

/**
 * Initial Confidence Score for a memory whose numeric column is still
 * null. Seeds from the categorical `confidence` column —
 * `certain → 0.9`, `likely → 0.6`, `speculative → 0.3` (see
 * `CONFIDENCE_SEED` in `src/types.ts`). Used by `touchOnRead` (lazy
 * initialization on first cite) and by the bulk-backfill migration.
 */
export function seedConfidenceScore(confidence: MemoryConfidence): number {
  return CONFIDENCE_SEED[confidence]
}

/**
 * Increment confidence on a successful citation. Returns the new score
 * (clamped). Used by `touchOnRead` after the in-flight decay has been
 * realized.
 *
 * Bump algebra: `next = current + (1 - current) * BUMP_RATE`. The
 * exponential-approach shape means a memory at 0.5 bumps to 0.525, a
 * memory at 0.9 bumps to 0.905, a memory at 0.99 bumps to 0.9905 —
 * high-confidence rows ratchet slowly and stay below 1.0; low-
 * confidence rows recover faster than they decay on a per-event basis.
 * Asymmetric on purpose: a single citation is weaker evidence than a
 * 30-day stretch of neglect, so the per-citation recovery is
 * intentionally smaller than the per-stale-day decay. Tune via the
 * `BUMP_RATE` constant in `src/types.ts`.
 */
export function bumpConfidenceScore(current: number): number {
  return clampConfidenceScore(current + (1 - current) * BUMP_RATE)
}

/**
 * Decrement confidence on a contradiction signal (`lore-correct`,
 * `lore-supersede`). Returns the new score (clamped).
 *
 * Decrement algebra: `next = current * DECREMENT_FACTOR`. Aggressive
 * on purpose: contradiction is high-quality negative evidence (an
 * explicit human/agent signal that something is wrong), not the
 * diffuse signal that neglect carries. Tune via the
 * `DECREMENT_FACTOR` constant in `src/types.ts`.
 */
export function decrementConfidenceScore(current: number): number {
  return clampConfidenceScore(current * DECREMENT_FACTOR)
}

const DAY_MS = 1000 * 60 * 60 * 24

/**
 * Apply neglect decay. Returns the new score (clamped).
 *
 * Decay algebra: starting at `STALE_CONFIDENCE_DAYS` of neglect, the
 * score multiplies by `DECAY_RATE` per stale day:
 *   `staleDays = max(0, daysSinceLastReferenced - STALE_CONFIDENCE_DAYS)`
 *   `next = current * (DECAY_RATE ** staleDays)`
 * Tune via the `STALE_CONFIDENCE_DAYS` and `DECAY_RATE` constants in
 * `src/types.ts`.
 *
 * Worked examples (against the current constants — `STALE_CONFIDENCE_DAYS
 * = 60`, `DECAY_RATE = 0.99`): a memory at 0.9 untouched for 60 days
 * stays at 0.9 (zero stale days). At 90 days it reads
 * `0.9 * 0.99^30 ≈ 0.665`. At 180 days it reads `0.9 * 0.99^120 ≈
 * 0.270`. The half-life past the 60-day grace is ~69 stale days.
 *
 * `lastReferencedAt: null` is treated as "never touched" — decay does
 * NOT apply (the categorical seed wasn't even written yet). The
 * touch-on-read and decrement paths invoke this against `createdAt`
 * instead when seeding a never-scored row, so post-migration every
 * row participates in decay against a real anchor.
 *
 * Native `Date` math (no `date-fns`) — same shape as `taskDaysOverdue`
 * (`src/core/task.ts`). NaN-resistant: a malformed `lastReferencedAt`
 * returns the input unchanged rather than throwing or producing
 * infinities.
 *
 * `today` is caller-supplied (YYYY-MM-DD form). Tests pin deterministic
 * dates; the touch / decrement helpers default to `todayUtc()`; the
 * migration computes once at the top of the run.
 */
export function decayConfidenceScore(
  current: number,
  lastReferencedAt: string | null,
  today: string,
): number {
  if (lastReferencedAt === null) return current
  const todayMs = new Date(today).getTime()
  const refMs = new Date(lastReferencedAt).getTime()
  if (Number.isNaN(todayMs) || Number.isNaN(refMs)) return current
  const days = Math.floor((todayMs - refMs) / DAY_MS)
  const staleDays = Math.max(0, days - STALE_CONFIDENCE_DAYS)
  if (staleDays === 0) return current
  return clampConfidenceScore(current * Math.pow(DECAY_RATE, staleDays))
}

/**
 * Map a Confidence Score to an RRF weighting factor in
 * `[CONFIDENCE_FACTOR_MIN, 1.0]`. `null` (unscored) maps to `1.0` —
 * neutral, pre-migration rows shouldn't be penalized for lack of data.
 * A score of `1.0` maps to `1.0`; a score of `0.0` maps to
 * `CONFIDENCE_FACTOR_MIN` (tunable in `src/types.ts`).
 *
 * Pure stored-value mapper. This function does NOT apply decay, does
 * NOT read `lastReferencedAt`, and does NOT touch Notion. It exists so
 * RRF's accumulator can multiply each row's stored Confidence Score
 * into its rank score without I/O or time arithmetic. Decay is
 * realized at write time by `touchOnRead` / `decrementConfidence` /
 * the migration; by the time the score reaches retrieval, it is the
 * truth-as-of-last-touch.
 *
 * The floor preserves the "score is a tiebreaker, not a veto"
 * intuition: a maximally-decayed memory still surfaces at the
 * floor-multiple of the lexical / semantic weight of a fully-trusted
 * one — it doesn't disappear from results.
 */
export function confidenceFactor(score: number | null): number {
  if (score === null) return 1.0
  return CONFIDENCE_FACTOR_MIN + (1 - CONFIDENCE_FACTOR_MIN) * score
}
