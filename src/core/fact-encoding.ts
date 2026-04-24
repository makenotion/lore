/**
 * Fact HTML-entity decode migration.
 *
 * Companion to `topic-merge.ts:fixTopicEncoding` for the Facts DB. `lore migrate
 * --fix-fact-encoding` uses the functions in this module to scan every fact,
 * flag rows whose `Subject` or `Object` differ from their entity-decoded form,
 * and rewrite both fields (plus `DedupKey`) in a single `pages.update` per row.
 *
 * The extra beat over the topic flow is the **collision gate**: the decoded
 * triple changes the dedup key, so if another live row already occupies the
 * post-decode key the rewrite would silently introduce a duplicate. The gate
 * refuses to apply until `lore migrate --dedup-keys --merge --yes` has
 * collapsed the pre-existing duplicate, mirroring the posture P1-10 used for
 * `--fix-topic-encoding` / `--merge-duplicate-topics`.
 */

import type { Client } from "@notionhq/client"
import type {
  CreatePageParameters,
  PageObjectResponse,
  QueryDataSourceParameters,
} from "@notionhq/client"
import type { DatabaseRef, FactPredicate } from "../types.js"
import {
  extractDate,
  extractRichText,
  extractSelect,
  extractTitle,
  isFullPage,
} from "../notion/extractors.js"
import { decodeTextEntities } from "../notion/html-entities.js"
import { computeFactDedupKey } from "../notion/normalize.js"

/** One fact row whose stored Subject or Object contains HTML entities that
 *  would decode to a cleaner string. Also used as the return shape of an
 *  in-place fix — the raw fields capture what the write replaced. */
export interface EncodedFactRow {
  id: string
  /** Raw stored subject. */
  rawSubject: string
  /** Raw stored object. */
  rawObject: string
  /** Decoded subject — what `Subject` will be updated to. */
  decodedSubject: string
  /** Decoded object — what `Object` will be updated to. */
  decodedObject: string
  /** Dedup key currently stored (may be empty on pre-dedup vaults). */
  rawDedupKey: string
  /** Dedup key computed from the decoded triple. */
  decodedDedupKey: string
  /** Predicate — unchanged by the decode, but carried through so the report
   *  can show the full triple without a second read. */
  predicate: FactPredicate
}

/** One collision the decode pass would introduce: two (or more) live rows
 *  whose post-decode dedup key matches. Reported and gated — no rewrite runs
 *  for *any* row in the collision group until the operator resolves it via
 *  `--dedup-keys --merge --yes`. */
export interface FactEncodingCollision {
  /** Shared post-decode dedup key. */
  decodedDedupKey: string
  /** Preview of the canonical decoded triple (first row in the group). */
  triple: {
    subject: string
    predicate: FactPredicate
    object: string
  }
  /** Every live fact id whose decoded triple hashes to this key. Includes
   *  rows that already carry the decoded form alongside the would-be-decoded
   *  encoded sibling. */
  factIds: string[]
}

/** Result of a single successful rewrite. Same field set as `EncodedFactRow`
 *  — kept as a semantic alias so call sites can distinguish "found" from
 *  "rewrote". */
export type FactEncodingFixResult = EncodedFactRow

/** Aggregated report for the migrate CLI — mirrors the shape
 *  `topic-merge.ts` produces but extended with the collision gate. */
export interface FactEncodingReport {
  /** Rows discovered whose decoded Subject/Object differs from stored. */
  encoded: EncodedFactRow[]
  /** Collision groups that block rewriting (see `collisions` on `EncodedFactRow`
   *  for the row-level flag). */
  collisions: FactEncodingCollision[]
  /** Rows actually rewritten this run. Empty on dry-run. */
  fixes: FactEncodingFixResult[]
}

interface FactRowSnapshot {
  id: string
  subject: string
  predicate: FactPredicate
  object: string
  dedupKey: string
  /** `Valid Until` stripped out for the collision scan — only live rows
   *  participate (invalidated rows don't collide because they're filtered
   *  out of every dedup probe). */
  validUntil: string | null
}

/**
 * Derive the encoded-rows list and the post-decode collision groups from
 * a single Facts DB snapshot. Pure function so both the production fix
 * pass and the external `findEncodedFacts` / `findPostDecodeFactCollisions`
 * helpers can share one computation — and so `fixFactEncoding` can do a
 * single scan instead of paginating the DB twice.
 *
 * Why single-scan matters: Notion's query index is eventually consistent
 * by a few hundred ms, so two independent paginations can observe
 * different snapshots when a concurrent writer lands a row between them.
 * A two-scan fix pass could report a collision against a row whose sibling
 * the first scan missed, or vice versa. Collapsing to one pagination
 * removes that window entirely.
 *
 * Both outputs are sorted for deterministic console output:
 * - `encoded` by decoded subject, then decoded object
 * - `collisions` by decoded subject
 *
 * The collision evaluation uses the full live population (not only
 * encoded rows) because a clean row already carrying the decoded key
 * counts as a collision target — without that, a lone encoded row whose
 * decoded key matches an unrelated clean row would silently create a
 * duplicate on rewrite.
 */
function analyzeFactSnapshot(snapshot: FactRowSnapshot[]): {
  encoded: EncodedFactRow[]
  collisions: FactEncodingCollision[]
} {
  const encoded: EncodedFactRow[] = []
  const byKey = new Map<string, FactRowSnapshot[]>()

  for (const row of snapshot) {
    const decodedSubject = decodeTextEntities(row.subject)
    const decodedObject = decodeTextEntities(row.object)
    const decodedDedupKey = computeFactDedupKey({
      subject: decodedSubject,
      predicate: row.predicate,
      object: decodedObject,
    })

    if (decodedSubject !== row.subject || decodedObject !== row.object) {
      encoded.push({
        id: row.id,
        rawSubject: row.subject,
        rawObject: row.object,
        decodedSubject,
        decodedObject,
        rawDedupKey: row.dedupKey,
        decodedDedupKey,
        predicate: row.predicate,
      })
    }

    // Only live rows participate in collision grouping — invalidated rows
    // are filtered out of every dedup probe so they can't collide with a
    // live rewrite.
    if (!row.validUntil) {
      const bucket = byKey.get(decodedDedupKey) ?? []
      bucket.push(row)
      byKey.set(decodedDedupKey, bucket)
    }
  }

  encoded.sort((a, b) => {
    const subj = a.decodedSubject.localeCompare(b.decodedSubject)
    if (subj !== 0) return subj
    return a.decodedObject.localeCompare(b.decodedObject)
  })

  const collisions: FactEncodingCollision[] = []
  for (const [key, bucket] of byKey) {
    if (bucket.length < 2) continue
    const preview = bucket[0]
    collisions.push({
      decodedDedupKey: key,
      triple: {
        subject: decodeTextEntities(preview.subject),
        predicate: preview.predicate,
        object: decodeTextEntities(preview.object),
      },
      factIds: bucket.map((r) => r.id).sort(),
    })
  }
  collisions.sort((a, b) => a.triple.subject.localeCompare(b.triple.subject))

  return { encoded, collisions }
}

/**
 * Scan every fact row in the DB and return the rows whose Subject or Object
 * carries HTML entities. The `Predicate` field is not decoded — it's a closed
 * enum — but is carried through so the report can show the full triple.
 *
 * Paginates through the full Facts DB. Result order is stable (alphabetical
 * by decoded subject then decoded object) so console output is deterministic.
 * Invalidated rows are included so operators can see the full scope of the
 * migration; the collision gate only runs against live rows.
 */
export async function findEncodedFacts(
  client: Client,
  factsDb: DatabaseRef
): Promise<EncodedFactRow[]> {
  const snapshot = await scanFactRows(client, factsDb)
  return analyzeFactSnapshot(snapshot).encoded
}

/**
 * Predict the set of post-decode dedup-key collisions: groups of two or more
 * live rows whose decoded triple hashes to the same key. Includes encoded +
 * already-decoded pairs (the cross-encoding case) and purely-encoded groups
 * that would still collide after the decode. Used by the CLI to refuse
 * writing when the operator hasn't resolved the pre-existing duplicates via
 * `--dedup-keys --merge --yes`.
 */
export async function findPostDecodeFactCollisions(
  client: Client,
  factsDb: DatabaseRef
): Promise<FactEncodingCollision[]> {
  const snapshot = await scanFactRows(client, factsDb)
  return analyzeFactSnapshot(snapshot).collisions
}

/**
 * Run the encoding-fix pass. Scans every fact once, computes the decoded
 * form, surfaces collisions, and — when `dryRun` is false and no
 * collisions block the row — rewrites `Subject`, `Object`, and `DedupKey`
 * in one atomic `pages.update`.
 *
 * Single-scan design: `findEncodedFacts` and `findPostDecodeFactCollisions`
 * are derived from the same `scanFactRows` snapshot via
 * `analyzeFactSnapshot`, eliminating the Notion-consistency window a
 * two-scan design would leave open.
 *
 * Idempotent: a second run finds no encoded rows and returns an empty
 * `fixes` array. Collision rows are included in `encoded` so operators
 * see the full picture, but they never appear in `fixes` until the
 * underlying pre-existing duplicate is resolved.
 */
export async function fixFactEncoding(
  client: Client,
  factsDb: DatabaseRef,
  options: { dryRun?: boolean } = {}
): Promise<FactEncodingReport> {
  const snapshot = await scanFactRows(client, factsDb)
  const { encoded, collisions } = analyzeFactSnapshot(snapshot)

  const blockedIds = new Set<string>()
  for (const collision of collisions) {
    for (const id of collision.factIds) blockedIds.add(id)
  }

  if (options.dryRun) {
    return { encoded, collisions, fixes: [] }
  }

  const fixes: FactEncodingFixResult[] = []
  for (const row of encoded) {
    if (blockedIds.has(row.id)) continue
    await client.pages.update({
      page_id: row.id,
      properties: {
        Subject: { title: [{ text: { content: row.decodedSubject } }] },
        Object: { rich_text: [{ text: { content: row.decodedObject } }] },
        DedupKey: { rich_text: [{ text: { content: row.decodedDedupKey } }] },
      } as CreatePageParameters["properties"],
    })
    fixes.push(row)
  }

  return { encoded, collisions, fixes }
}

async function scanFactRows(
  client: Client,
  factsDb: DatabaseRef
): Promise<FactRowSnapshot[]> {
  const rows: FactRowSnapshot[] = []
  let cursor: string | undefined

  do {
    const response = await client.dataSources.query({
      data_source_id: factsDb.dataSourceId,
      // Deterministic order for testability. The collision grouping is
      // order-independent, but stable iteration makes the dry-run report
      // reproducible across runs on the same snapshot.
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
      page_size: 100,
      start_cursor: cursor,
    } as QueryDataSourceParameters)
    for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
      rows.push({
        id: page.id,
        subject: extractTitle(page.properties["Subject"]),
        predicate: extractSelect(
          page.properties["Predicate"],
          "related_to"
        ) as FactPredicate,
        object: extractRichText(page.properties["Object"]),
        dedupKey: extractRichText(page.properties["DedupKey"]),
        validUntil: extractDate(page.properties["Valid Until"]),
      })
    }
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined
  } while (cursor)

  return rows
}
