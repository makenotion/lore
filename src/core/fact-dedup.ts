/**
 * Fact dedup-key backfill and duplicate-merge passes.
 *
 * Run on demand by `lore migrate --dedup-keys`:
 *
 * 1. Backfill: compute and write `DedupKey` AND `SubjectKey` on every fact
 *    whose cell is empty or stale (idempotent — rows whose stored values
 *    already match the current normalize output are skipped). `SubjectKey`
 *    rides on the same pagination because the case-insensitive
 *    `queryBySubject` depends on every fact having the column populated;
 *    splitting it into a separate command would double the migration cost
 *    for no agent-visible benefit.
 * 2. Merge (opt-in via `--merge`): group live facts by their normalized key
 *    AND scope/lifetime bundle so that
 *    same-triple-different-scope rows are NOT collapsed. Pick the row
 *    with the latest `Review By` (ties broken by oldest `created_time`)
 *    as the canonical survivor per group, invalidate the others. History
 *    is preserved because `invalidate` only sets `Valid Until`.
 *
 * An earlier version grouped by `dedupKey` alone, which would
 * collapse a `(triple, scope=team)` row and a
 * `(triple, scope=session)` row into one survivor and invalidate the
 * other. That directly contradicted the new `createWithDedup` rule
 * that same-triple-different-scope rows are intentionally distinct.
 * Grouping now keys on `(dedupKey, scopeKind, scopeKey, audience,
 * lifetime, expiresAt)` so the migration is symmetric with the
 * scope-aware merge contract on the create path.
 */

import type { Client } from "@notionhq/client"
import type { PageObjectResponse, UpdatePageParameters } from "@notionhq/client"
import type { DatabaseRef, MemoryLifetime, MemoryScopeKind } from "../types.js"
import {
  isFullPage,
  extractTitle,
  extractRichText,
  extractSelect,
  extractDate,
} from "../notion/extractors.js"
import { computeFactDedupKey, computeSubjectKey } from "../notion/normalize.js"
import { FACT_PROPS } from "../notion/schema.js"

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
  /**
   * Rows whose `DedupKey` and/or `SubjectKey` were stale or empty and have
   * now been populated. A single row counts once toward this total even
   * when both columns were rewritten in the same atomic update — the
   * counter measures rows touched, not properties touched.
   */
  backfilled: number
  /** Rows whose `DedupKey` AND `SubjectKey` already matched (no write issued). */
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

  // Backfill pass — write DedupKey AND SubjectKey on every row whose stored
  // values diverge from the current normalize output. Bundled into one
  // `pages.update` per row so a vault with hundreds of unmigrated rows
  // pays N round-trips, not 2N. Either column drifting is enough to
  // trigger the write — `skipped` only fires when both already match.
  for (const row of rows) {
    const expectedDedupKey = computeFactDedupKey({
      subject: row.subject,
      predicate: row.predicate,
      object: row.object,
    })
    const expectedSubjectKey = computeSubjectKey(row.subject)

    const dedupNeedsWrite = row.dedupKey !== expectedDedupKey
    const subjectNeedsWrite = row.subjectKey !== expectedSubjectKey

    if (!dedupNeedsWrite && !subjectNeedsWrite) {
      skipped++
      continue
    }

    if (!options.dryRun) {
      const properties: Record<string, unknown> = {}
      if (dedupNeedsWrite) {
        properties[FACT_PROPS.DEDUP_KEY] = {
          rich_text: [{ text: { content: expectedDedupKey } }],
        }
      }
      if (subjectNeedsWrite) {
        properties[FACT_PROPS.SUBJECT_KEY] = {
          rich_text: [{ text: { content: expectedSubjectKey } }],
        }
      }
      await client.pages.update({
        page_id: row.id,
        properties: properties as UpdatePageParameters["properties"],
      })
    }
    row.dedupKey = expectedDedupKey
    row.subjectKey = expectedSubjectKey
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

  // Merge pass — group live rows by key + scope/lifetime bundle; invalidate
  // all but the best survivor per group. Grouping on `dedupKey` alone
  // would collapse same-triple-different-scope rows into one survivor
  // and invalidate the others, destroying the narrow-scope assertion or
  // hiding the broadcast assertion behind a session/agent/role key —
  // both of which contradict the `createWithDedup` scope-aware merge
  // contract that creates these rows as intentionally-distinct in the
  // first place.
  //
  // The grouping key is `dedupKey | scopeKind | scopeKey | audience |
  // lifetime | expiresAt` joined with `\x1F` (ASCII Unit Separator —
  // same separator the dedup-key hash uses to make boundary collisions
  // structurally impossible in normalized text). Empty/null scope
  // values normalize to `""` so a row with all-null scope columns
  // (legacy / broadcast row) groups separately from any row that
  // declares any scope component.
  const liveByKey = new Map<string, FactRow[]>()
  for (const row of rows) {
    if (row.validUntil) continue
    const groupKey = computeFactGroupKey(row)
    const bucket = liveByKey.get(groupKey) ?? []
    bucket.push(row)
    liveByKey.set(groupKey, bucket)
  }

  const plans: FactMergePlan[] = []
  const today = new Date().toISOString().split("T")[0]

  for (const [, bucket] of liveByKey) {
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
      // `FactMergePlan.dedupKey` is the stable SHA-256 hash of the
      // triple, NOT the composite scope-aware grouping key.
      // `computeFactGroupKey(row)` joins dedupKey + scope bundle into
      // the Map key for grouping; that's structurally a different
      // value from the hash. Returning the composite key would break
      // programmatic consumers that index by dedupKey or compare
      // against `computeFactDedupKey(triple)`. Use the survivor's
      // stored DedupKey field, which holds the hash directly.
      dedupKey: survivor.dedupKey,
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
            [FACT_PROPS.VALID_UNTIL]: { date: { start: today } },
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
  subjectKey: string
  validUntil: string | null
  reviewBy: string | null
  createdTime: string
  /**
   * Scope/lifetime columns loaded so the migration's grouping key can
   * include them. Loaded as raw strings (not the typed `MemoryScope`)
   * because the grouping key only needs string equality; lifting to
   * the typed shape would force every loaded row through
   * `pageToFact`-style extractors for no behavioral benefit.
   */
  scopeKind: MemoryScopeKind | null
  scopeKey: string
  audience: string
  lifetime: MemoryLifetime | null
  expiresAt: string | null
}

/**
 * ASCII Unit Separator. Joins the seven scope-aware grouping
 * components into the migration's group key. Same separator the
 * `computeFactDedupKey` hash uses for the same reason — `\x1F`
 * never appears in user-supplied text or in select-option names,
 * so a boundary collision between `(scopeKind="session", key="A")`
 * and `(scopeKind="sessio", key="nA")` is structurally
 * impossible.
 */
const FACT_GROUP_KEY_SEP = "\x1F"

/**
 * Compute the migration's grouping key for `--dedup-keys --merge`.
 * Two rows merge only when this key matches — i.e. same triple AND
 * same scope/lifetime bundle. Empty / null scope components
 * collapse to the empty string so a row with no scope columns
 * groups separately from any row declaring scope.
 */
function computeFactGroupKey(row: FactRow): string {
  return [
    row.dedupKey,
    row.scopeKind ?? "",
    row.scopeKey,
    row.audience,
    row.lifetime ?? "",
    row.expiresAt ?? "",
  ].join(FACT_GROUP_KEY_SEP)
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
    // survivor selection depend on the rows' `last_edited_time` ordering
    // — i.e. two runs of `--merge` on the same snapshot could pick
    // different survivors when the primary + secondary sort keys tie.
    const response = await client.dataSources.query({
      data_source_id: factsDb.dataSourceId,
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
      page_size: 100,
      start_cursor: cursor,
    })
    for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
      // Load the scope/lifetime columns so the migration's grouping
      // key can include them. Vaults that haven't run schema migration
      // won't have these columns; `extractSelect` / `extractRichText`
      // / `extractDate` all return their documented defaults on
      // missing properties, so legacy rows just contribute "" everywhere
      // and continue to group by `dedupKey` alone — preserving merge
      // behavior on un-upgraded vaults.
      const scopeKindProp = page.properties[FACT_PROPS.SCOPE_KIND]
      const scopeKind =
        scopeKindProp && scopeKindProp.type === "select" && scopeKindProp.select
          ? (scopeKindProp.select.name as MemoryScopeKind)
          : null
      const lifetimeProp = page.properties[FACT_PROPS.LIFETIME]
      const lifetime =
        lifetimeProp && lifetimeProp.type === "select" && lifetimeProp.select
          ? (lifetimeProp.select.name as MemoryLifetime)
          : null
      rows.push({
        id: page.id,
        subject: extractTitle(page.properties[FACT_PROPS.SUBJECT]),
        predicate: extractSelect(page.properties[FACT_PROPS.PREDICATE], "related_to"),
        object: extractRichText(page.properties[FACT_PROPS.OBJECT]),
        dedupKey: extractRichText(page.properties[FACT_PROPS.DEDUP_KEY]),
        subjectKey: extractRichText(page.properties[FACT_PROPS.SUBJECT_KEY]),
        validUntil: extractDate(page.properties[FACT_PROPS.VALID_UNTIL]),
        reviewBy: extractDate(page.properties[FACT_PROPS.REVIEW_BY]),
        createdTime: page.created_time,
        scopeKind,
        scopeKey: extractRichText(page.properties[FACT_PROPS.SCOPE_KEY]),
        audience: extractRichText(page.properties[FACT_PROPS.AUDIENCE]),
        lifetime,
        expiresAt: extractDate(page.properties[FACT_PROPS.EXPIRES_AT]),
      })
    }
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined
  } while (cursor)
  return rows
}
