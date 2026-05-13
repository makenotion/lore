/**
 * Memory HTML-entity decode migration.
 *
 * Companion to the fact-encoding migration and `fixTopicEncoding`
 * for the Memories DB. `lore migrate --fix-memory-encoding` uses the
 * functions
 * here to scan every memory, flag rows whose `Title` — and optionally body
 * markdown — differ from their decoded form, then rewrite them.
 *
 * Scope and exclusions:
 * - Archived memories are skipped (no need to fix data the agent can't read).
 * - Memory body markdown is rewritten by one of two paths depending on the
 *   `LORE_USE_RUNTOOL_BLOCK_EDIT` flag (via the RunTool block-edit flag):
 *   - **Flag off (default)**: bodies above `BODY_SIZE_CAP_BYTES` are
 *     skipped and surfaced in `oversizedSkipped` so the operator can
 *     fix them manually. The full body would otherwise need to be
 *     re-uploaded by `pages.updateMarkdown` for every fix.
 *   - **Flag on**: bodies of any size are rewritten via RunTool's
 *     `update_content` tool with deterministic per-entity substitutions
 *     — only the entity strings that actually appear in the body get
 *     sent over the wire, regardless of body size. Rows the anchored
 *     path cannot help (multi-pass `&amp;amp;` shapes; bodies whose
 *     entity-substitution list is empty after a single decode pass)
 *     remain in `oversizedSkipped` only when they're also above the
 *     cap (the canonical path can fix the rest in plan-mode preview).
 * - Unlike the fact path, there is no dedup-key recomputation: memories are
 *   UUID-keyed, so Title changes don't reopen a probe.
 */

import type { Client } from "@notionhq/client"
import type {
  CreatePageParameters,
  PageObjectResponse,
  QueryDataSourceParameters,
} from "@notionhq/client"
import { decodeHTML } from "entities"
import type { DatabaseRef } from "../types.js"
import { extractTitle, isFullPage } from "../notion/extractors.js"
import { projectOrUnscopedFilter } from "../notion/filters.js"
import { decodeTextEntities } from "../notion/html-entities.js"
import {
  isRunToolBlockEditEnabled,
  RunToolBlockEditError,
  updatePageContentViaRunTool,
  type UpdatePageContentEdit,
} from "../notion/runtool/index.js"
import { MEMORY_PROPS } from "../notion/schema.js"

/**
 * 100 KB cap on body markdown we'll migrate in a single pass. `lore mine`
 * occasionally produces multi-hundred-KB outputs; rewriting those via
 * `pages.updateMarkdown` is technically possible but introduces long
 * round-trips and extra partial-failure surface area that this migration
 * is deliberately scoped to avoid. Title-only fix still runs on oversize
 * rows — that's the value driver for near-duplicate detection /
 * entity canonicalization / DS-scoped search.
 */
export const BODY_SIZE_CAP_BYTES = 100 * 1024

/** Per-row plan for the memory encoding fix. Title fix is always
 *  required when present; content fix is best-effort and routes
 *  through one of two paths depending on `LORE_USE_RUNTOOL_BLOCK_EDIT`
 *  (via the RunTool block-edit flag).
 *
 *  Default-off semantics: oversized bodies (`contentTooLargeToFix`)
 *  are skipped on apply.
 *
 *  Flag-on semantics: oversized bodies are eligible for the
 *  RunTool-anchored path when `anchoredPathPlanned === true`, which
 *  matches the apply-path's local guards exactly so plan-mode preview
 *  reflects what apply-mode would do for that row. */
export interface EncodedMemoryRow {
  id: string
  /** Raw stored title. */
  rawTitle: string
  /** Decoded title — what `Title` will be updated to. Equal to `rawTitle`
   *  when only the body needs decoding. */
  decodedTitle: string
  /** Whether Title differs from its decoded form. */
  titleNeedsFix: boolean
  /** Whether the body markdown differs from its decoded form. Only populated
   *  when body fetching is enabled on the scan. */
  contentNeedsFix: boolean
  /** Size of the raw body markdown in UTF-8 bytes — used by the caller to
   *  surface which rows hit the skip cap. */
  contentBytes: number
  /** `true` when body markdown differs from decoded form but exceeds
   *  `BODY_SIZE_CAP_BYTES`. Whether such a row is fixable depends on
   *  `anchoredPathPlanned`; default-off paths cannot fix it. */
  contentTooLargeToFix: boolean
  /** Raw body markdown. Captured for the rewrite path; omitted when the
   *  body wasn't fetched (dry-run without body inspection is still useful
   *  for the Title delta). */
  rawContent: string | null
  /** Decoded body markdown. Omitted when `rawContent` is omitted. */
  decodedContent: string | null
  /** `true` when `retrieveMarkdown` failed (timeout / 5xx / archived body
   *  access error). In this case `rawContent`/`decodedContent` are null
   *  and the row flows through with body status "unknown" — Title fix is
   *  still applied on apply, body rewrite is skipped. Operators can
   *  re-run the migration to pick up rows whose body fetch was transient. */
  contentFetchFailed: boolean
  /** `true` when the row is eligible for the RunTool-anchored body fix
   *  path (via the RunTool block-edit flag). Matches the apply-path's local guards
   *  exactly: flag is on, body has a single-pass entity-substitution
   *  set, and the substitutions list is non-empty. Plan-mode preview
   *  reads this field to label oversized rows truthfully — a row with
   *  this flag set is "would fix via anchored", a row without it
   *  whose body is oversized is "would skip on apply." */
  anchoredPathPlanned: boolean
}

export interface MemoryEncodingFixResult {
  id: string
  rawTitle: string
  decodedTitle: string
  titleFixed: boolean
  contentFixed: boolean
  /** Set on rows whose body was rewritten via the RunTool
   *  `update_content` anchored path (via the RunTool block-edit flag). When false, the
   *  body fix went through the canonical `pages.updateMarkdown` full-body
   *  replace. Surfaced so the migration report can distinguish how a
   *  given fix landed. Defaults to false on rows where `contentFixed`
   *  is also false. */
  contentFixedViaAnchoredPatterns?: boolean
}

export interface MemoryEncodingReport {
  /** Rows whose Title or body needed decoding (`titleNeedsFix ||
   *  contentNeedsFix`). Oversized-body rows appear here with
   *  `contentTooLargeToFix: true` and `titleNeedsFix` set when the title
   *  itself was also dirty. */
  encoded: EncodedMemoryRow[]
  /** Rows whose body exceeded `BODY_SIZE_CAP_BYTES` AND cannot be fixed
   *  by the active path. With the flag off, this is every oversized
   *  encoded row. With the flag on, it's only the rows the
   *  RunTool-anchored path can't repair (multi-pass `&amp;amp;`,
   *  empty-substitution-list bodies, body fetch failures) plus any
   *  apply-time fall-back-able failures (re-bucketed at apply time).
   *  Duplicates rows in `encoded` — kept separate so the CLI report
   *  can surface "skipped because anchored path can't help and body
   *  is over the cap" as its own bucket. */
  oversizedSkipped: EncodedMemoryRow[]
  /** Rows whose body exceeds `BODY_SIZE_CAP_BYTES` AND will be fixed
   *  via the RunTool-anchored path on apply (via the RunTool block-edit flag).
   *  Populated only when `LORE_USE_RUNTOOL_BLOCK_EDIT` is on and the
   *  row's local guards predict success. Empty when the flag is off
   *  — the row would land in `oversizedSkipped` instead. Duplicates
   *  rows in `encoded`. */
  oversizedAnchoredPlanned: EncodedMemoryRow[]
  /** Rows whose Title had HTML entities but the body fetch threw (timeout,
   *  5xx, permission). Includes the Title delta so operators can still see
   *  what *would* be fixed; the migrate loop still writes the Title. */
  contentFetchFailures: EncodedMemoryRow[]
  /** Rows actually rewritten this run. Empty on dry-run. */
  fixes: MemoryEncodingFixResult[]
}

/**
 * Scan every non-archived memory and return the rows whose Title or body
 * markdown differs from its decoded form. Body fetches are issued in batches
 * bounded by the Notion rate limiter — on a vault with thousands of
 * memories this is the bulk of the pass's runtime.
 *
 * When `includeContent` is false, only Title deltas are returned. That mode
 * is used by callers that just want a fast preview of the Title-fix scope
 * without paying the per-page `retrieveMarkdown` round-trip.
 */
export async function findEncodedMemories(
  client: Client,
  memoriesDb: DatabaseRef,
  options: { includeContent?: boolean; projectId?: string } = {}
): Promise<EncodedMemoryRow[]> {
  const includeContent = options.includeContent ?? true
  const rows: EncodedMemoryRow[] = []

  let cursor: string | undefined
  do {
    const response = await client.dataSources.query({
      data_source_id: memoriesDb.dataSourceId,
      filter: options.projectId
        ? (projectOrUnscopedFilter(
            options.projectId
          ) as QueryDataSourceParameters["filter"])
        : undefined,
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
      page_size: 100,
      start_cursor: cursor,
    } as QueryDataSourceParameters)
    const pages = (response.results.filter(isFullPage) as PageObjectResponse[]).filter(
      (p) => !p.archived
    )

    // Fetch body markdown in parallel for the whole page batch. On a vault
    // with hundreds of memories the serial round-trip tax exceeds the
    // Notion SDK's default request timeout; the shared rate-limited client
    // caps concurrency for us. Same pattern as `MemoryService.list`, which
    // always fans the N+1 `retrieveMarkdown` work out via `Promise.all`.
    //
    // Per-page fetch failure is isolated — one timed-out `retrieveMarkdown`
    // call must not abort the whole scan. The row is still surfaced with
    // `contentFetchFailed: true`; the migrate pass still writes the Title
    // fix (which is the value driver for downstream embedding / similarity
    // surfaces) and skips the body rewrite. Operators re-run to pick up
    // transient-fail bodies.
    const rowsForBatch = await Promise.all(
      pages.map(async (page) => {
        const rawTitle = extractTitle(page.properties[MEMORY_PROPS.TITLE])
        const decodedTitle = decodeTextEntities(rawTitle)
        const titleNeedsFix = rawTitle !== decodedTitle

        let rawContent: string | null = null
        let decodedContent: string | null = null
        let contentNeedsFix = false
        let contentBytes = 0
        let contentTooLargeToFix = false
        let contentFetchFailed = false

        if (includeContent) {
          try {
            const md = await client.pages.retrieveMarkdown({ page_id: page.id })
            rawContent = md.markdown ?? ""
            decodedContent = decodeTextEntities(rawContent)
            contentNeedsFix = rawContent !== decodedContent
            contentBytes = Buffer.byteLength(rawContent, "utf8")
            contentTooLargeToFix = contentNeedsFix && contentBytes > BODY_SIZE_CAP_BYTES
          } catch {
            // Swallow — this is a recoverable degradation. Body status is
            // unknown for this row; the caller treats it as "Title only".
            contentFetchFailed = true
          }
        }

        // A row is worth surfacing if it has any actionable delta OR
        // its body fetch failed — the failure case is worth reporting
        // even when Title is clean, because the migration has no view
        // into whether the body carries entities. Silently dropping
        // clean-title / failed-body rows would hide the scan's coverage
        // hole from operators; `contentFetchFailures` in the report
        // makes the gap explicit, and a future re-run (or a targeted
        // retry) can pick these rows up when the transient fault
        // clears.
        if (!titleNeedsFix && !contentNeedsFix && !contentFetchFailed) {
          return null
        }

        // Predict whether the RunTool-anchored body fix path would
        // apply to this row. Mirrors the apply path's local guards
        // exactly so plan-mode preview is truthful — without this,
        // dry-run output would silently lie about which oversized
        // rows are about to be fixed.
        const anchoredPathPlanned =
          isRunToolBlockEditEnabled() &&
          contentNeedsFix &&
          !contentFetchFailed &&
          rawContent !== null &&
          decodedContent !== null &&
          decodeHTML(rawContent) === decodedContent &&
          buildEntitySubstitutions(rawContent).length > 0

        return {
          id: page.id,
          rawTitle,
          decodedTitle,
          titleNeedsFix,
          contentNeedsFix,
          contentBytes,
          contentTooLargeToFix,
          rawContent,
          decodedContent,
          contentFetchFailed,
          anchoredPathPlanned,
        } satisfies EncodedMemoryRow
      })
    )
    for (const row of rowsForBatch) {
      if (row) rows.push(row)
    }
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
  } while (cursor)

  // Deterministic order for the CLI report — decoded title, then id for ties.
  rows.sort((a, b) => {
    const byTitle = a.decodedTitle.localeCompare(b.decodedTitle)
    if (byTitle !== 0) return byTitle
    return a.id.localeCompare(b.id)
  })
  return rows
}

/**
 * Run the memory encoding fix pass. Scans every non-archived memory,
 * rewrites `Title` via `pages.update`, and rewrites body markdown via
 * one of two paths gated by `LORE_USE_RUNTOOL_BLOCK_EDIT`:
 *
 * - **Default-off** (and flag-on, body within `BODY_SIZE_CAP_BYTES`):
 *   `pages.updateMarkdown({ type: "replace_content", replace_content: {
 *   new_str } })` rewrites the full body. Idempotent.
 * - **Flag-on, body above the cap, anchored path planned**: RunTool
 *   `update_content` with deterministic per-entity substitutions
 *   (via the RunTool block-edit flag). The wire payload is the substitutions list,
 *   not the full body, so a 200KB body ships only the bytes for the
 *   entity strings actually present in it. Idempotent.
 *
 * Eligibility for the anchored path is precomputed during the scan
 * (`EncodedMemoryRow.anchoredPathPlanned`) using the same local
 * guards as the apply path: flag on, content needs fix, no fetch
 * failure, single-pass equivalent (`decodeHTML(rawContent) ===
 * decodedContent`), substitutions list non-empty. Multi-pass entity
 * bodies (`&amp;amp;` → `&amp;` → `&`) and bodies whose substitution
 * list is empty fall back to the canonical full-body path; under
 * default-off OR when both paths are unavailable (oversized + not
 * anchored-eligible), the row stays unfixed and surfaces in
 * `oversizedSkipped`.
 *
 * The two oversize-related buckets in `MemoryEncodingReport` are
 * mutually exclusive and complete:
 *
 * - `oversizedSkipped` — oversized rows that won't be fixed by either
 *   path (anchored not planned AND canonical can't run above cap, or
 *   apply-time fall-back-able failure on a planned anchored row).
 *   Title fixes on these rows still apply because Title is the value
 *   driver for downstream duplicate-detection / embedding surfaces.
 * - `oversizedAnchoredPlanned` — oversized rows that WILL be fixed
 *   via the anchored path on apply. Plan-mode preview reads this so
 *   operator output reflects what apply mode does.
 */
export async function fixMemoryEncoding(
  client: Client,
  memoriesDb: DatabaseRef,
  options: { dryRun?: boolean; projectId?: string } = {}
): Promise<MemoryEncodingReport> {
  const encoded = await findEncodedMemories(client, memoriesDb, {
    includeContent: true,
    projectId: options.projectId,
  })
  const contentFetchFailures = encoded.filter((r) => r.contentFetchFailed)

  // When the anchored-edit flag is on, oversized bodies are not
  // skipped unconditionally — `update_content` with deterministic
  // entity-pattern substitutions can fix them without sending the
  // full body over the wire. The prediction lives on
  // `EncodedMemoryRow.anchoredPathPlanned` (computed in
  // `findEncodedMemories` using the same local guards as the apply
  // path), so plan-mode preview reflects what apply mode will do.
  // Default-off keeps `oversizedSkipped` populated for every oversized
  // encoded row so migration reports stay byte-stable when the flag
  // is unset.
  const oversizedSkipped = encoded.filter(
    (r) => r.contentTooLargeToFix && !r.anchoredPathPlanned
  )
  const oversizedAnchoredPlanned = encoded.filter(
    (r) => r.contentTooLargeToFix && r.anchoredPathPlanned
  )

  if (options.dryRun) {
    return {
      encoded,
      oversizedSkipped,
      oversizedAnchoredPlanned,
      contentFetchFailures,
      fixes: [],
    }
  }

  const fixes: MemoryEncodingFixResult[] = []
  for (const row of encoded) {
    let titleFixed = false
    let contentFixed = false
    let contentFixedViaAnchoredPatterns = false

    if (row.titleNeedsFix) {
      await client.pages.update({
        page_id: row.id,
        properties: {
          [MEMORY_PROPS.TITLE]: { title: [{ text: { content: row.decodedTitle } }] },
        } as CreatePageParameters["properties"],
      })
      titleFixed = true
    }

    if (
      row.contentNeedsFix &&
      !row.contentFetchFailed &&
      row.rawContent !== null &&
      row.decodedContent !== null
    ) {
      // Anchored-pattern path: when the flag is on
      // AND the row's local guards predict the path will apply
      // (`anchoredPathPlanned`), dispatch the substitutions via
      // `update_content` with `replace_all_matches: true`. The wire
      // payload is the small substitutions list, not the full body —
      // so a 200KB body ships only the bytes for the entity strings
      // that actually appear in it, regardless of body size.
      //
      // For non-oversized bodies the fall-back canonical path is the
      // existing `replace_content` rewrite. For oversized bodies the
      // canonical path skips, so a fall-back-able failure leaves the
      // row unfixed AND surfaces in `oversizedSkipped` semantics —
      // we re-add such rows to the bucket below.
      const anchoredOk = row.anchoredPathPlanned
        ? await tryFixContentViaAnchoredPatterns(client, row)
        : false

      if (anchoredOk) {
        contentFixed = true
        contentFixedViaAnchoredPatterns = true
      } else if (!row.contentTooLargeToFix) {
        // Canonical full-body path. Available only for non-oversized
        // bodies (the existing skip). Reached when:
        //   - the flag is off (the default-off path), OR
        //   - the flag is on and the anchored path returned a
        //     fall-back-able signal AND the body fits the cap.
        await client.pages.updateMarkdown({
          page_id: row.id,
          type: "replace_content",
          replace_content: {
            new_str: row.decodedContent,
            allow_deleting_content: true,
          },
        })
        contentFixed = true
      } else if (row.anchoredPathPlanned) {
        // Flag was on, anchored path was planned but failed at apply
        // time, body is oversized — the canonical path can't run.
        // Re-bucket the row as `oversizedSkipped` AND remove it from
        // `oversizedAnchoredPlanned` so the migration report
        // truthfully reflects what landed.
        oversizedSkipped.push(row)
        const planIdx = oversizedAnchoredPlanned.indexOf(row)
        if (planIdx >= 0) oversizedAnchoredPlanned.splice(planIdx, 1)
      }
    }

    if (titleFixed || contentFixed) {
      fixes.push({
        id: row.id,
        rawTitle: row.rawTitle,
        decodedTitle: row.decodedTitle,
        titleFixed,
        contentFixed,
        ...(contentFixed
          ? { contentFixedViaAnchoredPatterns }
          : { contentFixedViaAnchoredPatterns: false }),
      })
    }
  }

  return {
    encoded,
    oversizedSkipped,
    oversizedAnchoredPlanned,
    contentFetchFailures,
    fixes,
  }
}

/**
 * Build the entity-substitution list that, when applied to
 * `rawContent` with `replace_all_matches: true`, produces the same
 * decoded output as `decodeTextEntities(rawContent)`.
 *
 * Three load-bearing properties:
 *
 * 1. **Substitutions are derived from `rawContent`'s actual entity
 *    occurrences**, not from a hardcoded entity table. The wire
 *    payload contains only the entities present in the body — a body
 *    with `&amp;` ships one substitution; a body with no entities
 *    ships zero (and the caller skips the call). This is what makes
 *    the 200KB-body fix proportionally cheap on a typical encoded
 *    body where entities are sparse.
 *
 * 2. **Length-descending order** (`old_str` longest first). The
 *    entity-pattern regex extracts complete `&...;` sequences as
 *    distinct entities, so two different entities cannot overlap at
 *    the wire level (each is its own `old_str`). Length-descending
 *    is still useful for the rare adversarial case where the server
 *    applies substitutions left-to-right and a longer entity could
 *    structurally contain a shorter one's tail — sorting by length
 *    keeps the substitution semantics consistent across server
 *    implementations without depending on engine specifics.
 *
 * 3. **One pass.** The fixed-point loop in `decodeTextEntities`
 *    handles double-encoding (`&amp;amp;` → `&amp;` → `&`). The
 *    entity-pattern regex extracts one entity per `&...;` sequence,
 *    so `&amp;amp;` yields a single `&amp;` capture (the
 *    well-formed inner sequence) — applying that substitution with
 *    `replace_all_matches: true` reduces the body to `&amp;`, still
 *    encoded after one pass. The caller's single-pass equivalence
 *    guard (`decodeHTML(rawContent) !== row.decodedContent`)
 *    detects this case BEFORE dispatch and falls back to the
 *    canonical path so the existing fixed-point behavior is
 *    preserved.
 */
const ENTITY_PATTERN =
  /&(?:[a-zA-Z][a-zA-Z0-9]{1,30}|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});/g

export function buildEntitySubstitutions(rawContent: string): UpdatePageContentEdit[] {
  const seen = new Map<string, string>()
  for (const match of rawContent.matchAll(ENTITY_PATTERN)) {
    const entity = match[0]
    if (seen.has(entity)) continue
    const decoded = decodeHTML(entity)
    // Skip entities the decoder couldn't resolve (rare — the regex
    // captures syntactically valid entities, but `entities` may not
    // recognize a malformed-but-shaped sequence). Sending an
    // identity substitution would be a wire no-op and waste a slot.
    if (decoded === entity) continue
    seen.set(entity, decoded)
  }
  return Array.from(seen.entries())
    .sort((a, b) => b[0].length - a[0].length)
    .map(([oldStr, newStr]) => ({ oldStr, newStr, replaceAllMatches: true }))
}

/**
 * Attempt to fix one row's body via the RunTool anchored-pattern
 * path. Returns true on success, false on every fall-back-able
 * signal (including "no entities surfaced — single-pass insufficient").
 *
 * Fall-back semantics across the three cases the wrapper raises:
 *
 * - `no_match`: the substitution list ran but the server saw a
 *   different body. Caller falls back.
 * - `multiple_matches`: structurally impossible under
 *   `replace_all_matches: true` (the kind exists for the unset
 *   default), but classified anyway so a future server change
 *   doesn't surface as an unhandled error.
 * - `restricted_resource`: token can't pass the actor check (the
 *   integration-secret operator path cannot satisfy RunTool's
 *   actor-type gate). Caller falls back; the existing
 *   integration-secret operator path stays available.
 *
 * Multi-pass entity bodies: when `decodeHTML(rawContent) !==
 * decodedContent` (the fixed-point loop converged after >1 pass),
 * one `update_content` call cannot fully decode. Returns false so
 * the caller falls back to the canonical full-body path which
 * preserves the existing `decodeTextEntities` behavior.
 */
async function tryFixContentViaAnchoredPatterns(
  client: Client,
  row: EncodedMemoryRow
): Promise<boolean> {
  // The local-guard predicate (`anchoredPathPlanned`) on
  // `EncodedMemoryRow` already encodes the single-pass equivalence
  // and non-empty-substitutions checks; callers gate this function
  // on that flag, so re-running the guards here would be redundant
  // (and a future divergence between predict and apply would silently
  // hide a regression in plan-mode preview accuracy). Asserting the
  // structural pre-conditions instead documents the contract.
  if (row.rawContent === null) return false
  const updates = buildEntitySubstitutions(row.rawContent)
  if (updates.length === 0) return false

  try {
    await updatePageContentViaRunTool(client, {
      pageId: row.id,
      updates,
    })
    return true
  } catch (err) {
    if (err instanceof RunToolBlockEditError) return false
    throw err
  }
}
