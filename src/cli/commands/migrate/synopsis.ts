import type { LoreServices } from "../../../services.js"
import type { BackgroundAgentConfig } from "../../../hooks/config.js"
import type { BackfillReport, SynopsisBackend } from "../../../core/synopsis-backfill.js"
import { DEFAULT_SYNOPSIS_BATCH_SIZE } from "../../../core/synopsis-backfill.js"
import { printDiscoveryBreadcrumb } from "./shared.js"

/**
 * Parse the `--synopsis-backend` raw value into the typed union. The
 * commander option carries a default of `"claude"` so the operator
 * never sees `undefined`; the validator rejects anything else with a
 * directive error before any Notion call.
 */
export function parseSynopsisBackend(raw: string | undefined): SynopsisBackend {
  const value = (raw ?? "claude").toLowerCase()
  if (value === "claude" || value === "placeholder") return value
  console.error(`--synopsis-backend must be 'claude' or 'placeholder' (got '${raw}').`)
  process.exit(1)
}

/**
 * Parse the `--synopsis-batch-size` raw value into a positive integer.
 * Commander hands us strings even for numeric flags. Rejects
 * non-integer / non-positive values with a directive error before any
 * Notion call. Default is `DEFAULT_SYNOPSIS_BATCH_SIZE` (4).
 */
export function parseSynopsisBatchSize(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SYNOPSIS_BATCH_SIZE
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    console.error(`--synopsis-batch-size must be a positive integer (got '${raw}').`)
    process.exit(1)
  }
  return value
}

/** Cap on the number of preview rows surfaced inline in the synopsis-
 *  backfill plan output. Mirrors the convention other dispatchers use. */
const SYNOPSIS_BACKFILL_PREVIEW_LIMIT = 5

/**
 * Drive the synopsis backfill migration and render the operator-facing
 * report. Plan-only by default; `--yes` flips to apply mode. The
 * placeholder-backend branch swaps the verbs and renders
 * `n/a (placeholder backend)` in place of the literal `0` for the two
 * fetch-time counters that the backend never computes — the typed
 * report stays numeric per the "Display vs. typed report" contract.
 *
 * Exported so the migrate CLI tests can exercise it without invoking
 * commander's argv plumbing.
 */
export async function runSynopsisBackfill(
  services: LoreServices,
  options: {
    apply: boolean
    dryRun?: boolean
    backend: SynopsisBackend
    batchSize?: number
    /**
     * Resolved background-agent shape. Forwarded to
     * `backfillSynopses` so the configured binary / args drive the
     * synthesizer spawn. When omitted, the synthesizer falls through
     * to the historical claude-shaped defaults.
     */
    agent?: BackgroundAgentConfig
    projectId?: string
  }
): Promise<BackfillReport> {
  const planOnly = !options.apply || options.dryRun === true
  printDiscoveryBreadcrumb("memories with empty Synopsis")
  const report = await services.memories.backfillSynopses({
    apply: options.apply,
    dryRun: options.dryRun,
    backend: options.backend,
    batchSize: options.batchSize,
    agent: options.agent,
    ...(options.projectId ? { projectId: options.projectId } : {}),
  })

  if (report.totalCandidates === 0 && report.archivedSkipped === 0) {
    console.log(
      "\nNo memories with empty Synopsis found — every memory already has a synopsis."
    )
    return report
  }

  const backendLabel = options.backend === "placeholder" ? "placeholder" : "claude"
  const verb = planOnly
    ? "Would backfill"
    : options.backend === "placeholder"
      ? "Flagged"
      : "Synthesized"

  const wrote =
    options.backend === "placeholder" ? report.placeholderWritten : report.synthesized

  const batchSize = options.batchSize ?? DEFAULT_SYNOPSIS_BATCH_SIZE
  const batchClause = !planOnly ? `; batch-size: ${batchSize}` : ""
  console.log(
    `\n${verb} ${planOnly ? report.totalCandidates : wrote} ` +
      `synops${(planOnly ? report.totalCandidates : wrote) === 1 ? "is" : "es"} ` +
      `(backend: ${backendLabel}; ${report.totalCandidates} candidate${report.totalCandidates === 1 ? "" : "s"}; ` +
      `${report.archivedSkipped} archived skipped${batchClause}).`
  )

  // Per-bucket tallies. The two fetch-time counters render as
  // `n/a (placeholder backend)` on the placeholder apply path because
  // the backend never fetches a body to evaluate — a literal `0`
  // would imply "checked and found zero" when the migration didn't
  // check at all. The typed report keeps numeric `0` per the
  // "Display vs. typed report" contract.
  const bodyOversizeStr = formatBackfillBucket(
    report.bodyOversizeSkipped,
    options.backend,
    planOnly
  )
  const emptyBodyStr = formatBackfillBucket(
    report.emptyBodySkipped,
    options.backend,
    planOnly
  )
  const lines: string[] = []
  if (planOnly) {
    lines.push(
      `  body-oversize: ${bodyOversizeStr} (estimated, exact counts require --yes)`
    )
    lines.push(`  empty-body:    ${emptyBodyStr} (estimated, exact counts require --yes)`)
  } else {
    lines.push(`  body-oversize: ${bodyOversizeStr}`)
    lines.push(`  empty-body:    ${emptyBodyStr}`)
    if (report.truncated > 0) {
      lines.push(`  truncated:     ${report.truncated}`)
    }
    if (report.bodyFetchFailed > 0) {
      lines.push(`  fetch failed:  ${report.bodyFetchFailed}`)
    }
    if (report.synthesisFailed > 0) {
      lines.push(`  synth failed:  ${report.synthesisFailed}`)
    }
    if (report.scaffoldingRejected > 0) {
      lines.push(`  scaffolding:   ${report.scaffoldingRejected}`)
    }
    if (report.writeFailed > 0) {
      lines.push(`  write failed:  ${report.writeFailed}`)
    }
  }
  for (const line of lines) console.log(line)

  if (report.examples.length > 0) {
    console.log("\nExamples:")
    for (const example of report.examples.slice(0, SYNOPSIS_BACKFILL_PREVIEW_LIMIT)) {
      console.log(`  [${example.bucket}] ${example.id} — "${example.title}"`)
    }
  }

  if (planOnly) {
    if (options.backend === "claude") {
      console.log(
        "\nPlan only — no changes written. Re-run with `--yes` to synthesize " +
          "synopses via `claude -p`. Each candidate row pays one body fetch " +
          "and one synthesizer round-trip — review the candidate count above " +
          "before paying. `--synopsis-backend placeholder` is the no-LLM " +
          "alternative for test infrastructure or large-vault flagging."
      )
    } else {
      console.log(
        "\nPlan only — no changes written. Re-run with `--yes` to write the " +
          "SYNOPSIS_PLACEHOLDER_SENTINEL constant to every candidate row. " +
          "One-way: once a row carries the sentinel, the discovery filter " +
          "excludes it on every subsequent run. Read the issue 0.7.0/05 " +
          "spec's 'Sentinel choice' section before applying on a real vault."
      )
    }
  }

  return report
}

/**
 * Pure renderer for one of the two fetch-time counters
 * (`bodyOversizeSkipped` / `emptyBodySkipped`). The placeholder apply
 * path renders `n/a (placeholder backend)` because the backend never
 * fetches a body, so a literal `0` would be operator-misleading.
 * Plan-only and the claude apply path render the numeric value
 * verbatim. Exported so tests can pin the rendering rules separately
 * from the typed report.
 */
export function formatBackfillBucket(
  count: number,
  backend: SynopsisBackend,
  planOnly: boolean
): string {
  if (backend === "placeholder" && !planOnly) {
    return "n/a (placeholder backend)"
  }
  return String(count)
}
