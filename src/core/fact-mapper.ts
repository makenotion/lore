import type { Client, PageObjectResponse } from "@notionhq/client"
import type { Fact, FactConfidence, FactPredicate } from "../types.js"
import { FACT_PROPS } from "../notion/schema.js"
import {
  extractDate,
  extractNumber,
  extractRelationIds,
  extractRichText,
  extractSelect,
  extractTitle,
} from "../notion/extractors.js"
import {
  hydrateRelationProperties,
  hydrateRelationPropertiesForPages,
} from "../notion/relation-properties.js"
import { extractFactScope } from "./fact-scope.js"

// Hydrate relation columns that can legitimately exceed Notion's inline
// relation limit. Fact keeps scalar entity ids on the public shape, but
// repair paths may encounter multi-valued SubjectEntity/ObjectEntity rows.
const FACT_RELATION_PROPERTIES = [
  FACT_PROPS.PROJECT,
  FACT_PROPS.SUBJECT_ENTITY,
  FACT_PROPS.OBJECT_ENTITY,
] as const

/**
 * Map a Notion page to the `Fact` domain type, or `null` for rows
 * whose raw `Predicate` select value is one of the historical
 * tracking strings (`needs_action` / `waiting_on` / `blocked_by`).
 *
 * Tracking predicates were removed from `FactPredicate` in 0.6.0
 * (`lore-task` is the canonical surface for tracked work). Historical
 * Notion rows still carry those select values — the schema is
 * additive-only — so the deserialization boundary filters them so
 * no live read path surfaces them as a `Fact`. `countByPredicateRaw`
 * deliberately bypasses this filter so the `lore status` preflight
 * keeps counting the rows.
 *
 * `SubjectKey` and `DedupKey` are deliberately *not* projected onto
 * `Fact` — they're query-only indexes derived from the canonical
 * `Subject` / `Object` / `Predicate` triple, not domain data. Surfacing
 * them on `Fact` would invite callers to read the cached normalized
 * form instead of recomputing it from the source-of-truth fields, and
 * a stale cache (e.g. mid-encoding-fix) would silently diverge from
 * the canonical value. The repo-wide rule that adding a DB
 * property requires updating `Fact` + `pageToFact` is intentionally
 * waived for these two columns; the next contributor should not
 * "fix" the asymmetry by exposing them.
 */
export async function pageToFact(
  client: Client,
  page: PageObjectResponse
): Promise<Fact | null> {
  const hydrated = await hydrateRelationProperties(client, page, FACT_RELATION_PROPERTIES)
  return pageToFactSync(hydrated)
}

/**
 * Batched sibling of `pageToFact`: hydrates relation overflow for the
 * full result set in a single `p-limit(3)`-gated call (via
 * `hydrateRelationPropertiesForPages`), then runs the synchronous
 * deserialization over the already-hydrated pages and drops historical
 * tracking-predicate `null` returns.
 *
 * Result-set callers (paginated `dataSources.query` consumers) must
 * route through this method instead of `Promise.all(results.map(p =>
 * pageToFact(client, p)))`. The shapes are observationally equivalent —
 * both inherit the rate-limit Proxy's concurrency-3 gate — but
 * routing through here consolidates relation-property semantics on
 * the batched helper so a future change to retry policy, hydration
 * scope, or column set has one chokepoint instead of one per call
 * site.
 *
 * The single-row `pageToFact` callers (`getById`, `lookupByDedupKey`,
 * and the inner-loop iterators in `queryOverdue` /
 * `listAllForBackfill` that process one row per outer page) keep the
 * per-page hydration path — there is no result set to batch.
 */
export async function pageToFacts(
  client: Client,
  pages: readonly PageObjectResponse[]
): Promise<Fact[]> {
  if (pages.length === 0) return []
  const hydrated = await hydrateRelationPropertiesForPages(
    client,
    pages,
    FACT_RELATION_PROPERTIES
  )
  const facts: Fact[] = []
  for (const page of hydrated) {
    const fact = pageToFactSync(page)
    if (fact !== null) facts.push(fact)
  }
  return facts
}

/**
 * Synchronous deserialization of an already-hydrated fact page.
 * `pageToFact` and `pageToFacts` both delegate here after their
 * respective hydration step. Returns `null` for historical
 * tracking-predicate rows so callers can filter them at the
 * deserialization boundary.
 */
export function pageToFactSync(page: PageObjectResponse): Fact | null {
  const props = page.properties
  const rawPredicate = extractSelect(props[FACT_PROPS.PREDICATE], "related_to")
  if (HISTORICAL_TRACKING_PREDICATE_VALUES.has(rawPredicate)) {
    return null
  }
  const sourceIds = extractRelationIds(props[FACT_PROPS.SOURCE])
  // PF3-01 — relation columns return `[]` on un-migrated rows
  // because Notion responds with an empty list when the column
  // exists in the schema but is unset on the row. Treat any populated
  // relation as the canonical entity id; ignore the [1+] case (a
  // Fact only ever points at one canonical Entity per side).
  const subjectEntityIds = extractRelationIds(props[FACT_PROPS.SUBJECT_ENTITY])
  const objectEntityIds = extractRelationIds(props[FACT_PROPS.OBJECT_ENTITY])
  // Transaction-time provenance. `Observed At` /
  // `Invalidated At` are `null` on rows the backfill migration hasn't
  // touched yet; the read-side filters in `applyTransactionTimeFilter`
  // tolerate that absence (`is_empty` short-circuit for the migration
  // window).
  const invalidatedByIds = extractRelationIds(props[FACT_PROPS.INVALIDATED_BY])

  return {
    id: page.id,
    subject: extractTitle(props[FACT_PROPS.SUBJECT]),
    predicate: rawPredicate as FactPredicate,
    object: extractRichText(props[FACT_PROPS.OBJECT]),
    projectIds: extractRelationIds(props[FACT_PROPS.PROJECT]),
    validFrom: extractDate(props[FACT_PROPS.VALID_FROM]),
    validUntil: extractDate(props[FACT_PROPS.VALID_UNTIL]),
    observedAt: extractDate(props[FACT_PROPS.OBSERVED_AT]),
    invalidatedAt: extractDate(props[FACT_PROPS.INVALIDATED_AT]),
    invalidatedBySourceMemoryId: invalidatedByIds[0] ?? null,
    reviewBy: extractDate(props[FACT_PROPS.REVIEW_BY]),
    sourceMemoryId: sourceIds[0] ?? null,
    confidence: extractSelect(props[FACT_PROPS.CONFIDENCE], "certain") as FactConfidence,
    // DEFERRED-02 — system-managed numeric mirror of the categorical
    // `Confidence` select. `null` on unmigrated rows; populated by
    // `touchOnRead` / `decrementConfidence` / the build-fact-confidence-
    // scores migration. `extractNumber` returns `null` for missing
    // columns so legacy vaults that haven't run schema migration deserialize
    // cleanly.
    confidenceScore: extractNumber(props[FACT_PROPS.CONFIDENCE_SCORE]),
    lastReferencedAt: extractDate(props[FACT_PROPS.LAST_REFERENCED_AT]),
    createdAt: page.created_time,
    subjectEntityId: subjectEntityIds[0] ?? null,
    objectEntityId: objectEntityIds[0] ?? null,
    scope: extractFactScope(props),
  }
}

/**
 * Raw Notion `Predicate` select values not in the current
 * `FactPredicate` union. Notion rows still exist for vaults that
 * skipped the `--migrate-tracking-to-tasks` migration (the schema is
 * additive-only), so `pageToFact` filters
 * them at the deserialization boundary. Inlined as a plain set rather
 * than re-exported from the public types module because the
 * `FactPredicate` union does not include these values.
 */
const HISTORICAL_TRACKING_PREDICATE_VALUES: ReadonlySet<string> = new Set([
  "needs_action",
  "waiting_on",
  "blocked_by",
])
