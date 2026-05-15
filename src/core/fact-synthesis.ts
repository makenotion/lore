import type { CreateFactInput, Fact } from "../types.js"

/**
 * Synthesize a `Fact` shape from a freshly-created page id + the
 * `CreateFactInput` that produced it (batch path).
 *
 * The batch `create_pages` response carries only `{ id }` per page,
 * so the caller cannot route through `pageToFact`'s
 * `PageObjectResponse` extractor. Re-fetching every created row
 * via `pages.retrieve` would give back the N round-trips the batch
 * call just saved (the `createBatchWithDedupRunToolLocked`
 * "load-bearing batching win" note carries the rationale).
 * Synthesizing from the input
 * preserves the wall-clock win at the cost of leaving the
 * system-managed read-side fields (`confidenceScore`,
 * `lastReferencedAt`) at their fresh-row default of `null`, which
 * is exactly what `pageToFact` would return for a never-touched
 * post-create row anyway.
 *
 * `createdAt` defaults to "now" because Notion's `created_time` is
 * server-side and not in the response. The Fact carries this as
 * an optional field per the `Fact.createdAt` doc comment.
 *
 * Auto-mention emission — the canonical caller — only checks
 * fulfilled / rejected on each result and never reads back the
 * synthesized fields, so the "approximate fields" cost is entirely
 * paid by hypothetical future consumers, which the type's optional
 * markers permit.
 *
 * **Invariant — keep aligned with `pageToFact`.** This synthesizer
 * deliberately bypasses `pageToFact`'s historical-tracking-predicate
 * filter (the `pageToFactSync` null-return for legacy
 * `needs_action` / `waiting_on` / `blocked_by` rows). The bypass is
 * safe today because the batch path validates `predicate` upstream
 * via the `FactPredicate` type — historical strings cannot reach
 * here. A future contributor who tightens `pageToFact`'s filter
 * (e.g. adding a new historical-only predicate to the null-return
 * set) MUST mirror that change here, otherwise the batch path
 * would silently surface filtered rows that the single-input path
 * would drop. Pinned only by documentation, not test scaffolding.
 */
export function synthesizeFactFromCreateInput(
  id: string,
  input: CreateFactInput,
  validFromDefault: string,
  observedAtDefault: string
): Fact {
  return {
    id,
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    projectIds: input.projectIds ? [...input.projectIds] : [],
    validFrom: input.validFrom ?? validFromDefault,
    validUntil: null,
    // `observedAt` is bitemporally distinct from `validFrom`:
    // `validFrom` is domain truth (when the fact started being true in
    // the world), `observedAt` is transaction time (when Lore learned
    // about it). The caller passes both defaults explicitly so a future
    // backfill caller decoupling them (e.g., `validFrom: "2024-01-01",
    // observedAt: today`) can't silently land an `observedAt` derived
    // from the wrong axis. `invalidatedAt` and
    // `invalidatedBySourceMemoryId` stay null until invalidation.
    observedAt: observedAtDefault,
    invalidatedAt: null,
    invalidatedBySourceMemoryId: null,
    reviewBy: input.reviewBy ?? null,
    sourceMemoryId: input.sourceMemoryId ?? null,
    confidence: input.confidence ?? "certain",
    confidenceScore: null,
    lastReferencedAt: null,
    createdAt: new Date().toISOString(),
    subjectEntityId: input.subjectEntityId ?? null,
    objectEntityId: input.objectEntityId ?? null,
    scope: input.scope
      ? {
          kind: input.scope.kind ?? null,
          key: input.scope.key ?? "",
          audience: input.scope.audience ?? "",
          lifetime: input.scope.lifetime ?? null,
          expiresAt: input.scope.expiresAt ?? null,
        }
      : null,
  }
}
