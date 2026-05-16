/**
 * Confidence-score algebra for dynamic confidence.
 *
 * Pure functions only: no `Client`, no Notion calls, no I/O. The I/O wrappers
 * `MemoryService.touchOnRead` and `MemoryService.decrementConfidence` call
 * these helpers, write the result via a single `pages.update`, and route
 * failures through the caller-defined error posture.
 *
 * ## Write-realized lazy decay
 *
 * Every mutation of a stored Confidence Score realizes the time decay accrued
 * since the last touch before applying its own bump or decrement. RRF reads the
 * stored value verbatim through `confidenceFactor`: no decay computation at
 * read time and no divergence between the score visible in Notion and the
 * score used in retrieval. Decay accrues only on touch, decrement, and the
 * confidence backfill migration; a never-touched-after-creation memory keeps
 * its post-migration value until something disturbs it.
 *
 * Decay-at-read is intentionally not the model. It would force retrieval to
 * read `lastReferencedAt` and run time arithmetic per row per query, and it
 * would let stored values diverge from observable ranking contributions.
 *
 * ## Algebra
 *
 * | Helper | Algebra | Where it fires |
 * | --- | --- | --- |
 * | `seedConfidenceScore(c)` | `CONFIDENCE_SEED[c]` (`certain -> 0.9`, `likely -> 0.6`, `speculative -> 0.3`) | First touch on a never-scored row; bulk migration |
 * | `bumpConfidenceScore(s)` | `s + (1 - s) * BUMP_RATE` (`BUMP_RATE = 0.05`) | After decay realization on every read citation |
 * | `decrementConfidenceScore(s)` | `s * DECREMENT_FACTOR` (`DECREMENT_FACTOR = 0.5`) | After decay realization on contradiction and supersession signals |
 * | `decayConfidenceScore(s, ref, today)` | `s * DECAY_RATE^max(0, days - STALE_CONFIDENCE_DAYS)` (`DECAY_RATE = 0.99`, grace = 60 days) | In flight on every touch, decrement, and migration |
 * | `confidenceFactor(s)` | `CONFIDENCE_FACTOR_MIN + (1 - CONFIDENCE_FACTOR_MIN) * s`, `null -> 1` | Read-side, in the RRF accumulator |
 *
 * The asymmetry is deliberate: slow recovery, slow neglect decay, and
 * aggressive contradiction reflect different signal quality. A single citation
 * is weaker evidence than a stretch of neglect, and contradiction is a
 * high-quality negative signal. The shared constants keep migration, I/O
 * wrappers, and ranking aligned.
 */

import {
  CONFIDENCE_SCORE_MIN,
  CONFIDENCE_SCORE_MAX,
  CONFIDENCE_SEED,
  MS_PER_DAY,
  STALE_CONFIDENCE_DAYS,
  BUMP_RATE,
  DECAY_RATE,
  DECREMENT_FACTOR,
  CONFIDENCE_FACTOR_MIN,
  type MemoryConfidence,
} from "../types.js"
import { resolveFeatureFlags, type LoreFeatureFlags } from "../feature-flags.js"

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
 * the `CONFIDENCE_SEED` table). Used by `touchOnRead` (lazy
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
 * `BUMP_RATE` constant.
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
 * `DECREMENT_FACTOR` constant.
 */
export function decrementConfidenceScore(current: number): number {
  return clampConfidenceScore(current * DECREMENT_FACTOR)
}

/**
 * Apply neglect decay. Returns the new score (clamped).
 *
 * Decay algebra: starting at `STALE_CONFIDENCE_DAYS` of neglect, the
 * score multiplies by `DECAY_RATE` per stale day:
 *   `staleDays = max(0, daysSinceLastReferenced - STALE_CONFIDENCE_DAYS)`
 *   `next = current * (DECAY_RATE ** staleDays)`
 * Tune via the `STALE_CONFIDENCE_DAYS` and `DECAY_RATE` constants.
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
 * instead when seeding a never-scored row, so once the migration has
 * run every row participates in decay against a real anchor.
 *
 * Native `Date` math (no `date-fns`) — same shape as `taskDaysOverdue`.
 * NaN-resistant: a malformed `lastReferencedAt`
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
  today: string
): number {
  if (lastReferencedAt === null) return current
  const todayMs = new Date(today).getTime()
  const refMs = new Date(lastReferencedAt).getTime()
  if (Number.isNaN(todayMs) || Number.isNaN(refMs)) return current
  const days = Math.floor((todayMs - refMs) / MS_PER_DAY)
  const staleDays = Math.max(0, days - STALE_CONFIDENCE_DAYS)
  if (staleDays === 0) return current
  return clampConfidenceScore(current * Math.pow(DECAY_RATE, staleDays))
}

/**
 * Map a Confidence Score to an RRF weighting factor in
 * `[CONFIDENCE_FACTOR_MIN, 1.0]`. `null` (unscored) maps to `1.0` —
 * neutral, unmigrated rows shouldn't be penalized for lack of data.
 * A score of `1.0` maps to `1.0`; a score of `0.0` maps to
 * `CONFIDENCE_FACTOR_MIN` (tunable constant).
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
 *
 * **Kill switch.** `LORE_DISABLE_CONFIDENCE_FACTOR=1` returns `1.0`
 * unconditionally — a sustained-failure rollback to the unweighted
 * ranking, not a default. Same posture as `LORE_FORCE_SEMANTIC_SEARCH` and
 * `LORE_DISABLE_NEAR_DUPLICATE_PROBE`: an opt-in defensive lever for an
 * operator whose vault sees pathological ordering under the new signal.
 * The check lives here (not at the RRF call sites) so single-branch
 * paths and the hybrid accumulator share one bypass.
 */
export function confidenceFactor(
  score: number | null,
  features: Pick<LoreFeatureFlags, "confidenceFactor"> = resolveFeatureFlags()
): number {
  if (!features.confidenceFactor) return 1.0
  if (score === null) return 1.0
  return CONFIDENCE_FACTOR_MIN + (1 - CONFIDENCE_FACTOR_MIN) * score
}
