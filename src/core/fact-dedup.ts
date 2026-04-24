/**
 * Fact dedup-key backfill and duplicate-merge passes.
 *
 * Run on demand by `lore migrate --dedup-keys`:
 *
 * 1. Backfill: compute and write `DedupKey` on every fact whose cell is empty
 *    (idempotent — rows with a matching key are skipped).
 * 2. Merge (opt-in via `--merge`): group live facts by their normalized key,
 *    pick the row with the latest `Review By` (ties broken by oldest
 *    `created_time`) as the canonical survivor, invalidate the others.
 *    History is preserved because `invalidate` only sets `Valid Until`.
 */

import type { Client } from "@notionhq/client"
import type { PageObjectResponse } from "@notionhq/client"
import type { DatabaseRef } from "../types.js"
import {
  isFullPage,
  extractTitle,
  extractRichText,
  extractSelect,
  extractDate,
} from "../notion/extractors.js"
import { computeFactDedupKey } from "../notion/normalize.js"

export interface FactMergePlan {
  /** Key shared by the survivor and every loser (stable hash digest). */
  dedupKey: string
  /** Triple preview so operators can eyeball what's being collapsed. */
  triple: { subject: string; predicate: string; object: string }
  /** The row that will be preserved. */
  survivorId: string
  /** Rows that will be invalidated (Valid Until set to today). */
  loserIds: string[]
}

export interface FactDedupBackfillResult {
  /** Rows whose `DedupKey` was empty and has now been populated. */
  backfilled: number
  /** Rows that already had the correct key (no write issued). */
  skipped: number
  /** Duplicate groups collapsed (only populated when `merge: true`). */
  mergedGroups: number
  /** Individual rows invalidated as losers during merge. */
  invalidated: number
  /**
   * Per-group merge plan. Always populated when `merge: true`, regardless
   * of `dryRun`/`yes` — so the CLI can print the same preview table in
   * every mode.
   */
  plans: FactMergePlan[]
  /**
   * True when the merge phase ran in plan-only mode: the plan was computed
   * but no invalidations were written. This is the default for `merge:
   * true` unless `yes: true` is passed, so `--dedup-keys --merge` without
   * `--yes` can never silently destroy data.
   */
  mergePreviewOnly: boolean
}

export interface FactDedupOptions {
  /**
   * When true, after backfill group live facts by key and invalidate all
   * but one survivor per group. The survivor's `Review By` is extended to
   * the max across the group. When false, only the backfill runs.
   */
  merge?: boolean
  /**
   * When true, do not issue writes — count what would change and return.
   */
  dryRun?: boolean
  /**
   * Required to execute a merge. Without it, `merge: true` computes the
   * plan but does not write the invalidations — the caller is expected to
   * show the plan and re-run with `yes: true` (typically via a `--yes`
   * CLI flag) once the operator has reviewed it.
   */
  yes?: boolean
}

/**
 * Scan the Facts DB, compute dedup keys, and optionally collapse duplicates.
 * Idempotent. Safe to re-run.
 */
export async function runFactDedupBackfill(
  client: Client,
  factsDb: DatabaseRef,
  options: FactDedupOptions = {}
): Promise<FactDedupBackfillResult> {
  const rows = await listAllFacts(client, factsDb)

  let backfilled = 0
  let skipped = 0

  // Phase 1 — backfill DedupKey on every row missing one.
  for (const row of rows) {
    const expected = computeFactDedupKey({
      subject: row.subject,
      predicate: row.predicate,
      object: row.object,
    })
    if (row.dedupKey === expected) {
      skipped++
      continue
    }
    if (!options.dryRun) {
      await client.pages.update({
        page_id: row.id,
        properties: {
          DedupKey: { rich_text: [{ text: { content: expected } }] },
        },
      })
    }
    row.dedupKey = expected
    backfilled++
  }

  if (!options.merge) {
    return {
      backfilled,
      skipped,
      mergedGroups: 0,
      invalidated: 0,
      plans: [],
      mergePreviewOnly: false,
    }
  }

  // Phase 2 — group live rows by key; invalidate all but the best survivor.
  const liveByKey = new Map<string, FactRow[]>()
  for (const row of rows) {
    if (row.validUntil) continue
    const bucket = liveByKey.get(row.dedupKey) ?? []
    bucket.push(row)
    liveByKey.set(row.dedupKey, bucket)
  }

  const plans: FactMergePlan[] = []
  const today = new Date().toISOString().split("T")[0]

  for (const [dedupKey, bucket] of liveByKey) {
    if (bucket.length < 2) continue

    // Sort so the survivor sits at index 0:
    //   primary: latest Review By first — keep the row with the longest
    //   tracking runway. A null `reviewBy` sorts as earliest (loses to any
    //   timed row), so when the user re-learned a triple with a timer on
    //   top of a legacy blind-create, the timed row survives.
    //   secondary: oldest `created_time` first. When all rows tie on the
    //   primary (e.g. a group of all-null rows), the oldest row wins so
    //   the canonical ID is stable across re-runs on the same snapshot.
    const sorted = [...bucket].sort((a, b) => {
      const aReview = a.reviewBy ?? ""
      const bReview = b.reviewBy ?? ""
      if (aReview !== bReview) return bReview.localeCompare(aReview)
      return a.createdTime.localeCompare(b.createdTime)
    })
    const survivor = sorted[0]
    const losers = sorted.slice(1)

    plans.push({
      dedupKey,
      triple: {
        subject: survivor.subject,
        predicate: survivor.predicate,
        object: survivor.object,
      },
      survivorId: survivor.id,
      loserIds: losers.map((l) => l.id),
    })
  }

  const mergePreviewOnly = !options.dryRun && !options.yes
  let invalidated = 0

  if (!options.dryRun && options.yes) {
    for (const plan of plans) {
      for (const loserId of plan.loserIds) {
        await client.pages.update({
          page_id: loserId,
          properties: {
            "Valid Until": { date: { start: today } },
          },
        })
        invalidated++
      }
    }
  }

  return {
    backfilled,
    skipped,
    mergedGroups: plans.length,
    invalidated,
    plans,
    mergePreviewOnly,
  }
}

interface FactRow {
  id: string
  subject: string
  predicate: string
  object: string
  dedupKey: string
  validUntil: string | null
  reviewBy: string | null
  createdTime: string
}

async function listAllFacts(
  client: Client,
  factsDb: DatabaseRef
): Promise<FactRow[]> {
  const rows: FactRow[] = []
  let cursor: string | undefined
  do {
    // Explicit `created_time` ASC so cross-page ordering is deterministic.
    // The default Notion sort is `last_edited_time DESC`, which would make
    // survivor selection depend on which rows were most recently touched
    // — i.e. two runs of `--merge` on the same snapshot could pick
    // different survivors when the primary + secondary sort keys tie.
    const response = await client.dataSources.query({
      data_source_id: factsDb.dataSourceId,
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
      page_size: 100,
      start_cursor: cursor,
    })
    for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
      rows.push({
        id: page.id,
        subject: extractTitle(page.properties["Subject"]),
        predicate: extractSelect(page.properties["Predicate"], "related_to"),
        object: extractRichText(page.properties["Object"]),
        dedupKey: extractRichText(page.properties["DedupKey"]),
        validUntil: extractDate(page.properties["Valid Until"]),
        reviewBy: extractDate(page.properties["Review By"]),
        createdTime: page.created_time,
      })
    }
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined
  } while (cursor)
  return rows
}
