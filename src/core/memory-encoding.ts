/**
 * Memory HTML-entity decode migration.
 *
 * Companion to `fact-encoding.ts` and `topic-merge.ts:fixTopicEncoding` for
 * the Memories DB. `lore migrate --fix-memory-encoding` uses the functions
 * here to scan every memory, flag rows whose `Title` — and optionally body
 * markdown — differ from their decoded form, then rewrite them.
 *
 * Scope and exclusions:
 * - Archived memories are skipped (no need to fix data the agent can't read).
 * - Memory body markdown is rewritten only for pages at or below
 *   `BODY_SIZE_CAP_BYTES`. Multi-hundred-KB `lore mine` outputs can exist;
 *   migrating them at scale is a non-goal of this pass. Operators who need
 *   the big pages fixed today can re-scan them manually — we call the skip
 *   out in the report so it's visible.
 * - Unlike the fact path, there is no dedup-key recomputation: memories are
 *   UUID-keyed, so Title changes don't reopen a probe.
 */

import type { Client } from "@notionhq/client"
import type {
  CreatePageParameters,
  PageObjectResponse,
  QueryDataSourceParameters,
} from "@notionhq/client"
import type { DatabaseRef } from "../types.js"
import {
  extractTitle,
  isFullPage,
} from "../notion/extractors.js"
import { decodeTextEntities } from "../notion/html-entities.js"

/**
 * 100 KB cap on body markdown we'll migrate in a single pass. `lore mine`
 * occasionally produces multi-hundred-KB outputs; rewriting those via
 * `pages.updateMarkdown` is technically possible but introduces long
 * round-trips and extra partial-failure surface area that this migration
 * is deliberately scoped to avoid. Title-only fix still runs on oversize
 * rows — that's the value driver for `P2-03` / `P3-03` / `P3-04`.
 */
export const BODY_SIZE_CAP_BYTES = 100 * 1024

/** Per-row plan for the memory encoding fix. Title fix is always required
 *  when present; content fix is best-effort — skipped for oversized bodies. */
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
   *  `BODY_SIZE_CAP_BYTES`. Reported but not rewritten. */
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
}

export interface MemoryEncodingFixResult {
  id: string
  rawTitle: string
  decodedTitle: string
  titleFixed: boolean
  contentFixed: boolean
}

export interface MemoryEncodingReport {
  /** Rows whose Title or body needed decoding (`titleNeedsFix ||
   *  contentNeedsFix`). Oversized-body rows appear here with
   *  `contentTooLargeToFix: true` and `titleNeedsFix` set when the title
   *  itself was also dirty. */
  encoded: EncodedMemoryRow[]
  /** Rows whose body exceeded `BODY_SIZE_CAP_BYTES`. Duplicates rows in
   *  `encoded` — kept separate so the CLI report can surface "skipped
   *  because too large" as its own bucket. */
  oversizedSkipped: EncodedMemoryRow[]
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
  options: { includeContent?: boolean } = {}
): Promise<EncodedMemoryRow[]> {
  const includeContent = options.includeContent ?? true
  const rows: EncodedMemoryRow[] = []

  let cursor: string | undefined
  do {
    const response = await client.dataSources.query({
      data_source_id: memoriesDb.dataSourceId,
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
      page_size: 100,
      start_cursor: cursor,
    } as QueryDataSourceParameters)
    const pages = (response.results.filter(isFullPage) as PageObjectResponse[])
      .filter((p) => !p.archived)

    // Fetch body markdown in parallel for the whole page batch. On a vault
    // with hundreds of memories the serial round-trip tax exceeds the
    // Notion SDK's default request timeout; the shared rate-limited client
    // (see `notion/rate-limit.ts`) caps concurrency for us. Mirrors the
    // pattern in `MemoryService.list` where an N+1 `retrieveMarkdown` fan
    // is always issued via `Promise.all`.
    //
    // Per-page fetch failure is isolated — one timed-out `retrieveMarkdown`
    // call must not abort the whole scan. The row is still surfaced with
    // `contentFetchFailed: true`; the migrate pass still writes the Title
    // fix (which is the value driver for downstream embedding / similarity
    // surfaces) and skips the body rewrite. Operators re-run to pick up
    // transient-fail bodies.
    const rowsForBatch = await Promise.all(
      pages.map(async (page) => {
        const rawTitle = extractTitle(page.properties["Title"])
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
            contentTooLargeToFix =
              contentNeedsFix && contentBytes > BODY_SIZE_CAP_BYTES
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
        } satisfies EncodedMemoryRow
      })
    )
    for (const row of rowsForBatch) {
      if (row) rows.push(row)
    }
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined
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
 * rewrites `Title` via `pages.update`, and — when the body is within
 * `BODY_SIZE_CAP_BYTES` — rewrites body markdown via
 * `pages.updateMarkdown({ type: "replace_content_range", content_range:
 * "full_page" })`. Idempotent.
 *
 * Oversized bodies are surfaced in `oversizedSkipped` so the CLI can report
 * them as a distinct bucket; Title-only fixes on those rows still run,
 * because Title is the value driver for the downstream duplicate-detection
 * and embedding surfaces.
 */
export async function fixMemoryEncoding(
  client: Client,
  memoriesDb: DatabaseRef,
  options: { dryRun?: boolean } = {}
): Promise<MemoryEncodingReport> {
  const encoded = await findEncodedMemories(client, memoriesDb, {
    includeContent: true,
  })
  const oversizedSkipped = encoded.filter((r) => r.contentTooLargeToFix)
  const contentFetchFailures = encoded.filter((r) => r.contentFetchFailed)

  if (options.dryRun) {
    return { encoded, oversizedSkipped, contentFetchFailures, fixes: [] }
  }

  const fixes: MemoryEncodingFixResult[] = []
  for (const row of encoded) {
    let titleFixed = false
    let contentFixed = false

    if (row.titleNeedsFix) {
      await client.pages.update({
        page_id: row.id,
        properties: {
          Title: { title: [{ text: { content: row.decodedTitle } }] },
        } as CreatePageParameters["properties"],
      })
      titleFixed = true
    }

    if (
      row.contentNeedsFix &&
      !row.contentTooLargeToFix &&
      !row.contentFetchFailed &&
      row.decodedContent !== null
    ) {
      await client.pages.updateMarkdown({
        page_id: row.id,
        type: "replace_content_range",
        replace_content_range: {
          content: row.decodedContent,
          content_range: "full_page",
          allow_deleting_content: true,
        },
      })
      contentFixed = true
    }

    if (titleFixed || contentFixed) {
      fixes.push({
        id: row.id,
        rawTitle: row.rawTitle,
        decodedTitle: row.decodedTitle,
        titleFixed,
        contentFixed,
      })
    }
  }

  return { encoded, oversizedSkipped, contentFetchFailures, fixes }
}
