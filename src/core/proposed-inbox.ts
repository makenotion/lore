/**
 * Proposed-memory review inbox status surface.
 * Shared between `lore status` (CLI) and `lore-context action='status'`
 * (MCP) so the two operator-facing surfaces emit byte-identical lines
 * for the same vault state — same parity contract as `taskStats` /
 * `formatTaskSummary`.
 *
 * The data layer (`MemoryService.countProposed`) does the paginated
 * `dataSources.query` walk and produces a `{ total, bySource, byAgent }`
 * shape; this module owns only the loader (a thin pass-through that
 * isolates the call surface) and the pure renderer.
 */

import type { MemoryService } from "./memory.js"

/**
 * Aggregated proposed-memory inbox depth surfaced as a single status
 * line. Project scoping is applied upstream by the caller (`lore
 * status` and `lore-context action='status'` both call
 * `loadProposedInboxStatus({ projectId })` or omit the scope for a
 * vault-wide total), so the report itself does not carry the project
 * axis.
 *
 * `bySource` and `byAgent` are both `Record<string, number | undefined>`.
 * Sources include `MemorySource` enum values plus the literal
 * `"unknown"` fallback for rows whose `Source` column is missing.
 * Agents are free-form rich_text strings canonicalized at write time
 * (`canonicalizeAgentName`); empty /
 * missing Agent values bucket under `"unknown"`.
 *
 * The `Record<string, number | undefined>` shape (rather than
 * `Record<string, number>`) lets a future caller pre-allocate dense
 * bucket maps with placeholder zeros without poisoning the renderer's
 * sort. The renderer filters out non-positive entries before sorting.
 */
export interface ProposedInboxReport {
  total: number
  bySource: Record<string, number | undefined>
  byAgent: Record<string, number | undefined>
}

/**
 * Subset of `LoreServices` the inbox loader actually reads. Lets tests
 * pass a one-method fake instead of standing up the full services
 * object.
 */
export type ProposedInboxServices = {
  memories: Pick<MemoryService, "countProposed">
}

/**
 * One paginated `dataSources.query` walk over `Status = proposed AND
 * Kind != decision` non-archived memories, scoped to `projectId` when
 * supplied. See `MemoryService.countProposed` for the filter contract —
 * vault-wide scope when `projectId` is omitted, repo-wide unscoped
 * proposals surface in scoped counts via the `Project is_empty` OR
 * clause.
 */
export async function loadProposedInboxStatus(
  services: ProposedInboxServices,
  opts: { projectId?: string } = {}
): Promise<ProposedInboxReport> {
  const result = await services.memories.countProposed({
    projectId: opts.projectId,
  })
  return {
    total: result.total,
    bySource: result.bySource,
    byAgent: result.byAgent,
  }
}

/**
 * Render the proposed-memory inbox line. Returns `[]` when no
 * proposals are pending so the caller's single length-check
 * suppresses the entire surface — same contract shape as
 * `formatTrackingPreflight` / `formatDigestStatus` /
 * `formatDriftStatus`. An empty inbox is the silent path; the line
 * exists to nudge an operator with pending review work, not to
 * occupy a row of vault state on every status call.
 *
 * Shape with a non-empty inbox:
 *
 *     Proposed memory: 1 pending review
 *     Proposed memories: 12 pending review (sources: conversation 8, manual 4 · agents: Claude Code 9, Codex 3)
 *
 * The prefix inflects on `total` — `Proposed memory:` for `total ===
 * 1` and `Proposed memories:` otherwise. Pluralizing "memory" is the
 * smallest natural-language fix for `1 pending review`-reads-off; the
 * `pending review` suffix stays invariant because "review" is the
 * activity, not the row count.
 *
 * Sub-stat clusters (`sources:` / `agents:`) render only when at
 * least two buckets carry counts — a single-bucket inbox is already
 * fully described by the prefix and the `pending review` total, so
 * inlining `(sources: conversation 12)` would just duplicate the
 * total. Buckets within each cluster sort by descending count, then
 * by key ascending for stable output across runs that tie on count.
 *
 * Pure function: deterministic in `report`, no I/O.
 */
export function formatProposedInboxStatus(report: ProposedInboxReport): string[] {
  if (report.total <= 0) return []

  const sourceParts = formatInboxBuckets(report.bySource)
  const agentParts = formatInboxBuckets(report.byAgent)

  const subStats: string[] = []
  if (sourceParts) subStats.push(`sources: ${sourceParts}`)
  if (agentParts) subStats.push(`agents: ${agentParts}`)

  const prefix = report.total === 1 ? "Proposed memory" : "Proposed memories"
  const suffix = subStats.length > 0 ? ` (${subStats.join(" · ")})` : ""
  return [`${prefix}: ${report.total} pending review${suffix}`]
}

/**
 * Sort buckets descending by count, ascending by key on ties, and
 * render as `key N` joined by `, `. Returns null when fewer than two
 * buckets carry counts so the caller suppresses the entire cluster
 * — the bare line already conveys a single-bucket inbox via its
 * total.
 *
 * Accepts `Record<string, number | undefined>` so a caller that
 * pre-allocates dense bucket maps with placeholder `undefined` /
 * zero values doesn't drag the renderer through a custom filter.
 */
function formatInboxBuckets(buckets: Record<string, number | undefined>): string | null {
  const entries = Object.entries(buckets).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0
  )
  if (entries.length < 2) return null
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return entries.map(([key, count]) => `${key} ${count}`).join(", ")
}
