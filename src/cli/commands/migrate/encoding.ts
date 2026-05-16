import type { LoreServices } from "../../../services.js"
import {
  BODY_SIZE_CAP_BYTES,
  type EncodedMemoryRow,
} from "../../../core/memory-encoding.js"
import { printDiscoveryBreadcrumb } from "./shared.js"

/** Max rows printed inline before the preview is truncated with a tally. */
const ENCODING_FIX_PREVIEW_LIMIT = 10

/**
 * Render a byte count in a scannable unit. Sub-1 KB values stay in
 * bytes (`512 B`), KB through sub-1 MB render as KB with one decimal
 * (`152.3 KB`), larger values render as MB. The oversize-body preview
 * compares these against `BODY_SIZE_CAP_BYTES` (100 KB), so operator
 * scanning `152.3 KB > 100 KB` is clearer than `155955 bytes > 102400`.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(1)} MB`
}

/**
 * Scan the Facts DB for rows carrying HTML-encoded Subject/Object payloads,
 * print a plan-then-apply report, and — when not a dry run and no collisions
 * block the row — rewrite Subject/Object/DedupKey in one atomic
 * `pages.update`. The collision gate matches the posture
 * `--fix-topic-encoding` / `--merge-duplicate-topics` established.
 */
export async function runFactEncodingFix(
  services: LoreServices,
  options: { apply: boolean; dryRun?: boolean; projectId?: string }
): Promise<void> {
  // Direct helper callers can pass both `apply` and `dryRun`; dry-run
  // always wins so the service call and rendered report stay read-only.
  const planOnly = !options.apply || options.dryRun === true
  const report = await services.facts.fixEncoding({
    dryRun: planOnly,
    ...(options.projectId ? { projectId: options.projectId } : {}),
  })

  if (report.encoded.length === 0) {
    console.log(
      "\nNo HTML-encoded fact rows found — Subject and Object are already clean."
    )
    return
  }

  const blocked = new Set(report.collisions.flatMap((c) => c.factIds))
  const rewritable = report.encoded.filter((r) => !blocked.has(r.id))

  const verb = planOnly ? "Would decode" : "Decoded"
  const applied = planOnly ? rewritable.length : report.fixes.length
  console.log(
    `\n${verb} ${applied} HTML-encoded fact row${applied === 1 ? "" : "s"} ` +
      `(${report.encoded.length} total encoded; ${report.collisions.length} collision group${report.collisions.length === 1 ? "" : "s"} gated).`
  )

  const preview = planOnly ? rewritable : report.fixes
  for (const row of preview.slice(0, ENCODING_FIX_PREVIEW_LIMIT)) {
    console.log(`  "${row.rawSubject}" ${row.predicate} "${row.rawObject}"`)
    console.log(`    → "${row.decodedSubject}" ${row.predicate} "${row.decodedObject}"`)
  }
  if (preview.length > ENCODING_FIX_PREVIEW_LIMIT) {
    console.log(`  … and ${preview.length - ENCODING_FIX_PREVIEW_LIMIT} more rows.`)
  }

  if (report.collisions.length > 0) {
    console.log(
      `\nGated by post-decode dedup-key collisions ` +
        `(${report.collisions.length} group${report.collisions.length === 1 ? "" : "s"} — ` +
        `rewrite refused to avoid silently creating a duplicate):`
    )
    for (const c of report.collisions.slice(0, ENCODING_FIX_PREVIEW_LIMIT)) {
      console.log(`  "${c.triple.subject}" ${c.triple.predicate} "${c.triple.object}"`)
      console.log(`    factIds: ${c.factIds.join(", ")}`)
    }
    if (report.collisions.length > ENCODING_FIX_PREVIEW_LIMIT) {
      console.log(
        `  … and ${report.collisions.length - ENCODING_FIX_PREVIEW_LIMIT} more groups.`
      )
    }
    console.log(
      "\nRun `lore migrate --dedup-keys --merge --yes` to collapse the duplicates first, then re-run `lore migrate --fix-fact-encoding --yes`."
    )
  }

  // Plan-then-execute footer. Always prints in plan-only mode —
  // `--dry-run` and the bare default both want the `--yes` directive.
  // The global migrate action suppresses its generic "Re-run without
  // --dry-run" footer when an encoding flag is present, so there's no
  // double-footer.
  if (planOnly && rewritable.length > 0) {
    console.log("\nPlan only — no rewrites written. Re-run with `--yes` to execute.")
  }
}

/**
 * Scan the Memories DB for non-archived rows whose Title or body
 * markdown carry HTML entities, print a plan-then-apply report, and
 * — when not a dry run — rewrite Title via `pages.update` and body
 * via one of two paths:
 *
 * - **Default-off / flag-on within 100 KB cap**:
 *   `pages.updateMarkdown` full-body `replace_content`.
 * - **Flag-on (`LORE_USE_RUNTOOL_BLOCK_EDIT=1`) above the cap, row
 *   eligible**: RunTool `update_content` with deterministic
 *   per-entity substitutions. Multi-pass /
 *   no-substitutions oversized rows still surface in
 *   `oversizedSkipped`.
 *
 * Plan-mode preview reads `EncodedMemoryRow.anchoredPathPlanned`
 * (computed during scan with the same local guards as the apply
 * path) so per-row labels and the bucket counters reflect what
 * apply mode will do — the `fixMemoryEncoding` docstring carries the
 * predict/apply parity contract.
 */
export async function runMemoryEncodingFix(
  services: LoreServices,
  options: { apply: boolean; dryRun?: boolean; projectId?: string }
): Promise<void> {
  const planOnly = !options.apply || options.dryRun === true
  printDiscoveryBreadcrumb("memories with HTML-encoded Title or body")
  const report = await services.memories.fixEncoding({
    dryRun: planOnly,
    ...(options.projectId ? { projectId: options.projectId } : {}),
  })

  if (report.encoded.length === 0) {
    console.log(
      "\nNo HTML-encoded memory rows found — Title and body markdown are already clean."
    )
    return
  }

  const verb = planOnly ? "Would decode" : "Decoded"
  // Plan-mode counters now route oversized rows through
  // `anchoredPathPlanned`: a row labeled `contentTooLargeToFix` is
  // still fixable when the RunTool flag is on AND the local guards
  // predict the anchored path will land. Without this gate, plan
  // output would say "body fixes: 0 (1 skipped)" while apply mode
  // would actually fix the row — breaking the plan-then-execute
  // contract under `LORE_USE_RUNTOOL_BLOCK_EDIT`.
  const isBodyFixablePlanned = (r: EncodedMemoryRow): boolean =>
    r.contentNeedsFix && (!r.contentTooLargeToFix || r.anchoredPathPlanned)
  const fixableRows = planOnly
    ? report.encoded.filter((r) => r.titleNeedsFix || isBodyFixablePlanned(r)).length
    : report.fixes.length
  const titlePlanned = planOnly
    ? report.encoded.filter((r) => r.titleNeedsFix).length
    : report.fixes.filter((f) => f.titleFixed).length
  const bodyPlanned = planOnly
    ? report.encoded.filter(isBodyFixablePlanned).length
    : report.fixes.filter((f) => f.contentFixed).length

  console.log(
    `\n${verb} ${fixableRows} HTML-encoded memor${fixableRows === 1 ? "y" : "ies"} ` +
      `(Title fixes: ${titlePlanned}; body fixes: ${bodyPlanned}).`
  )

  // Two distinct preview shapes: plan-only renders `EncodedMemoryRow`
  // (pre-write intent with `*NeedsFix` / `*TooLargeToFix` flags), apply
  // renders `MemoryEncodingFixResult` (post-write outcome with
  // `*Fixed` flags). Keeping the loops separate is more durable than
  // structural narrowing — a future field rename on either type stays
  // type-checked without the `"titleFixed" in row` branch becoming
  // silently wrong.
  const previewLength = planOnly ? report.encoded.length : report.fixes.length
  if (planOnly) {
    for (const row of report.encoded.slice(0, ENCODING_FIX_PREVIEW_LIMIT)) {
      const parts: string[] = []
      if (row.titleNeedsFix) parts.push("title")
      // Three body-state shapes for the per-row preview:
      //   - non-oversized AND content needs fix → "body" (canonical path)
      //   - oversized AND anchored path planned → "body via anchored
      //     RunTool patterns"
      //   - oversized AND anchored path NOT planned → "body skipped"
      // The middle case is what was missing pre-review: plan output
      // labeled every oversized row as "skipped" regardless of whether
      // apply mode would actually fix it. The `anchoredPathPlanned`
      // flag is the apply-path guard fingerprint, so plan and apply
      // cannot drift.
      if (row.contentNeedsFix && !row.contentTooLargeToFix) {
        parts.push("body")
      } else if (row.contentTooLargeToFix && row.anchoredPathPlanned) {
        parts.push(
          `body via anchored RunTool patterns (${formatBytes(row.contentBytes)} > ${formatBytes(BODY_SIZE_CAP_BYTES)})`
        )
      } else if (row.contentTooLargeToFix) {
        parts.push(
          `body skipped (${formatBytes(row.contentBytes)} > ${formatBytes(BODY_SIZE_CAP_BYTES)})`
        )
      }
      console.log(
        `  ${row.id} — "${row.rawTitle}" → "${row.decodedTitle}" (${parts.join(", ")})`
      )
    }
  } else {
    for (const fix of report.fixes.slice(0, ENCODING_FIX_PREVIEW_LIMIT)) {
      const parts: string[] = []
      if (fix.titleFixed) parts.push("title")
      if (fix.contentFixed) parts.push("body")
      console.log(
        `  ${fix.id} — "${fix.rawTitle}" → "${fix.decodedTitle}" (${parts.join(", ")})`
      )
    }
  }
  if (previewLength > ENCODING_FIX_PREVIEW_LIMIT) {
    console.log(`  … and ${previewLength - ENCODING_FIX_PREVIEW_LIMIT} more rows.`)
  }

  if (report.oversizedAnchoredPlanned.length > 0) {
    // New section under `LORE_USE_RUNTOOL_BLOCK_EDIT`: oversized
    // rows that DO get fixed via RunTool's
    // anchored `update_content` path. Distinguishing them from
    // `oversizedSkipped` is what keeps plan output truthful — the
    // pre-review version conflated both into a single "skipped"
    // bucket and silently understated what apply mode would do.
    const noun = report.oversizedAnchoredPlanned.length === 1 ? "memory" : "memories"
    const verbPhrase = planOnly
      ? "Will fix oversized body via anchored RunTool patterns on"
      : "Fixed oversized body via anchored RunTool patterns on"
    console.log(
      `\n${verbPhrase} ${report.oversizedAnchoredPlanned.length} ${noun} ` +
        `(body > ${formatBytes(BODY_SIZE_CAP_BYTES)}):`
    )
    for (const row of report.oversizedAnchoredPlanned.slice(
      0,
      ENCODING_FIX_PREVIEW_LIMIT
    )) {
      console.log(
        `  ${row.id} — "${row.decodedTitle}" (${formatBytes(row.contentBytes)})`
      )
    }
    if (report.oversizedAnchoredPlanned.length > ENCODING_FIX_PREVIEW_LIMIT) {
      console.log(
        `  … and ${report.oversizedAnchoredPlanned.length - ENCODING_FIX_PREVIEW_LIMIT} more rows.`
      )
    }
  }

  if (report.oversizedSkipped.length > 0) {
    console.log(
      `\nSkipped body rewrite on ${report.oversizedSkipped.length} memor${report.oversizedSkipped.length === 1 ? "y" : "ies"} ` +
        `(body exceeded ${formatBytes(BODY_SIZE_CAP_BYTES)} — Title fixes still apply when present):`
    )
    for (const row of report.oversizedSkipped.slice(0, ENCODING_FIX_PREVIEW_LIMIT)) {
      console.log(
        `  ${row.id} — "${row.decodedTitle}" (${formatBytes(row.contentBytes)})`
      )
    }
    if (report.oversizedSkipped.length > ENCODING_FIX_PREVIEW_LIMIT) {
      console.log(
        `  … and ${report.oversizedSkipped.length - ENCODING_FIX_PREVIEW_LIMIT} more rows.`
      )
    }
  }

  if (report.contentFetchFailures.length > 0) {
    console.log(
      `\nBody fetch failed on ${report.contentFetchFailures.length} memor${report.contentFetchFailures.length === 1 ? "y" : "ies"} ` +
        "(transient Notion API error — Title fix still applied; re-run to retry the body):"
    )
    for (const row of report.contentFetchFailures.slice(0, ENCODING_FIX_PREVIEW_LIMIT)) {
      console.log(`  ${row.id} — "${row.decodedTitle}"`)
    }
    if (report.contentFetchFailures.length > ENCODING_FIX_PREVIEW_LIMIT) {
      console.log(
        `  … and ${report.contentFetchFailures.length - ENCODING_FIX_PREVIEW_LIMIT} more rows.`
      )
    }
  }

  // Plan-then-execute footer. See `runFactEncodingFix` for rationale.
  if (planOnly && fixableRows > 0) {
    console.log("\nPlan only — no rewrites written. Re-run with `--yes` to execute.")
  }
}
