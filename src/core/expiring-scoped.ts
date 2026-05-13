/**
 * Aggregator + renderer for the `lore status` and `lore-context
 * action='status'` "expiring scoped rows" surface.
 *
 * Lives in the core layer rather than the CLI layer so both the MCP
 * and CLI status surfaces import from the same module — same parity
 * contract as `taskStats` / `formatTaskSummary` and
 * `loadProposedInboxStatus` / `formatProposedInboxStatus`.
 *
 * The shared seam protects against the line drifting between
 * surfaces: a future tweak to the wording or the threshold composes
 * here once and both surfaces pick it up.
 */

import type { FactService } from "./fact.js"
import type { MemoryService } from "./memory.js"
import { EXPIRING_SOON_DAYS } from "../types.js"

/**
 * Combined memory + fact counters surfaced by the expiring-scoped
 * status line. Three categories, each split by DB so the operator
 * sees which surface needs cleanup:
 *
 * - `expired` — `Expires At < today` rows. Already invisible to
 *   default reads via the scope filter; surfaced here so an
 *   operator can archive (memories) or invalidate (facts) them.
 * - `expiringSoon` — `Expires At` in the inclusive
 *   `[today, today + EXPIRING_SOON_DAYS]` window. Triage signal
 *   for "rows about to drop out of recall."
 * - `narrowScopeOutOfContext` — Scope Kind is one of the narrow
 *   kinds (`user` / `agent` / `role` / `session` / `run` /
 *   `environment`) AND Scope Key does not match the resolved
 *   scope context. The "session note outliving its session"
 *   signal — load-bearing for the acceptance criterion.
 */
export interface ExpiringScopedReport {
  expiredMemories: number
  expiredFacts: number
  expiringSoonMemories: number
  expiringSoonFacts: number
  narrowScopeOutOfContextMemories: number
  narrowScopeOutOfContextFacts: number
}

/**
 * Probe both `MemoryService.expiringScopedStats` and
 * `FactService.expiringScopedStats` in parallel and combine the
 * counters. Single fan-out via `Promise.all` so wall-clock at the
 * orchestration level is `max(memories, facts)` rather than the
 * sum.
 */
export async function loadExpiringScopedStatus(
  services: { memories: MemoryService; facts: FactService },
  opts: { projectId?: string } = {}
): Promise<ExpiringScopedReport> {
  const [memories, facts] = await Promise.all([
    services.memories.expiringScopedStats(opts),
    services.facts.expiringScopedStats(opts),
  ])
  return {
    expiredMemories: memories.expired,
    expiredFacts: facts.expired,
    expiringSoonMemories: memories.expiringSoon,
    expiringSoonFacts: facts.expiringSoon,
    narrowScopeOutOfContextMemories: memories.narrowScopeOutOfContext,
    narrowScopeOutOfContextFacts: facts.narrowScopeOutOfContext,
  }
}

/**
 * Render the expiring/expired/out-of-context scoped-row summary.
 * Returns `[]` when every counter is zero so the surrounding
 * length-check on the caller drops the entire surface — same
 * silent-on-empty posture as `formatProposedInboxStatus` and
 * `formatTrackingPreflight`.
 *
 * Three lines max — one per category, rendered only when its
 * memory + fact counts sum to a non-zero value. Operators triaging
 * a healthy vault never see "0 expired / 0 expiring / 0
 * out-of-context" rows; the line shows up only when there's
 * something to act on.
 */
export function formatExpiringScopedSummary(
  report: ExpiringScopedReport
): string[] {
  const lines: string[] = []
  const expired = report.expiredMemories + report.expiredFacts
  const expiringSoon = report.expiringSoonMemories + report.expiringSoonFacts
  const outOfContext =
    report.narrowScopeOutOfContextMemories +
    report.narrowScopeOutOfContextFacts

  if (expired > 0) {
    lines.push(
      `Expired scoped rows: ${expired} ` +
        `(memories: ${report.expiredMemories}, facts: ${report.expiredFacts}) — ` +
        "consider archiving via `lore-memory action='archive'` or `lore-fact action='invalidate'`"
    )
  }
  if (expiringSoon > 0) {
    lines.push(
      `Expiring soon (≤${EXPIRING_SOON_DAYS}d): ${expiringSoon} ` +
        `(memories: ${report.expiringSoonMemories}, facts: ${report.expiringSoonFacts})`
    )
  }
  if (outOfContext > 0) {
    lines.push(
      `Narrow-scope rows outside this context: ${outOfContext} ` +
        `(memories: ${report.narrowScopeOutOfContextMemories}, ` +
        `facts: ${report.narrowScopeOutOfContextFacts}) — ` +
        "rows whose Scope Kind is user/agent/role/session/run/environment " +
        "and whose Scope Key does not match the resolved scope context"
    )
  }
  return lines
}
