/**
 * Agent identity normalization migration (PF3-02).
 *
 * Companion to `fact-encoding.ts` and `memory-encoding.ts` — same shape, same
 * plan-then-apply posture, different column. `lore migrate --normalize-agents`
 * uses the functions in this module to scan every memory's `Agent` field,
 * route the stored value through `canonicalizeAgentName`, and rewrite rows
 * whose canonical form differs from what Notion currently holds.
 *
 * Idempotent: a second run finds zero rows to rewrite. The canonicalizer is
 * a pure function over the stored string, so the same input always produces
 * the same output.
 *
 * Scope and exclusions:
 * - Archived memories are skipped — they don't surface in any agent
 *   filtering / dashboard query, so rewriting them is wasted work.
 * - Memories whose `Agent` is empty are skipped — there's no value to
 *   canonicalize. Pre-PF1-04 memories from Codex sessions sit in this
 *   bucket and stay as-is until the operator separately backfills them.
 */

import type { Client } from "@notionhq/client"
import type {
  CreatePageParameters,
  PageObjectResponse,
  QueryDataSourceParameters,
} from "@notionhq/client"
import type { DatabaseRef } from "../types.js"
import { extractRichText, isFullPage } from "../notion/extractors.js"
import { projectOrUnscopedFilter } from "../notion/filters.js"
import { canonicalizeAgentName } from "../hooks/agent-identity.js"

/**
 * One memory row whose stored `Agent` differs from its canonical form.
 * Surfaced verbatim in the plan output so operators can see exactly which
 * variants are being collapsed before applying the rewrite.
 */
export interface NormalizableAgentRow {
  id: string
  /** Raw stored Agent string. */
  rawAgent: string
  /** Canonical form — what `Agent` will be updated to. */
  canonicalAgent: string
}

/** Result of one successful rewrite. Same field set as `NormalizableAgentRow`
 *  — kept as a semantic alias so call sites can distinguish "found" from
 *  "rewrote" the same way the encoding migrations do. */
export type AgentNormalizationFixResult = NormalizableAgentRow

/** Per-row failure surfaced when `pages.update` rejects on a single row.
 *  The pass continues — surviving rows still write — and the CLI renders
 *  the error count alongside the success count so operators see the gap. */
export interface AgentNormalizationFailure {
  id: string
  message: string
}

/** Aggregated report mirroring the shape `MemoryEncodingReport` /
 *  `FactEncodingReport` produce. */
export interface AgentNormalizationReport {
  /** Rows discovered whose canonical Agent differs from stored. */
  encoded: NormalizableAgentRow[]
  /** Rows actually rewritten this run. Empty on dry-run. */
  fixes: AgentNormalizationFixResult[]
  /** Per-row write failures. Empty on dry-run and on a clean apply. */
  errors: AgentNormalizationFailure[]
}

/**
 * Scan every non-archived memory and return rows whose stored `Agent`
 * disagrees with `canonicalizeAgentName(stored)`. Empty-Agent rows are
 * filtered out — there's nothing to normalize.
 *
 * Result order is stable (canonical agent, then raw, then id) so the CLI
 * preview output is deterministic across runs against the same vault.
 */
export async function findNormalizableAgents(
  client: Client,
  memoriesDb: DatabaseRef,
  options: { projectId?: string } = {}
): Promise<NormalizableAgentRow[]> {
  const rows: NormalizableAgentRow[] = []

  let cursor: string | undefined
  do {
    const response = await client.dataSources.query({
      data_source_id: memoriesDb.dataSourceId,
      // Deterministic order for testability; the canonicalizer is
      // order-independent but stable iteration keeps dry-run reports
      // reproducible.
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
      page_size: 100,
      start_cursor: cursor,
      // Server-side prune: skip empty-Agent rows (Codex pre-PF1-04
      // sessions and any memory created before the field existed). The
      // client-side `if (!rawAgent) continue` below is a defensive safety
      // net for any edge case the filter doesn't catch — it's redundant
      // when the filter works, harmless when it doesn't.
      filter: (options.projectId
        ? {
            and: [
              { property: "Agent", rich_text: { is_not_empty: true } },
              projectOrUnscopedFilter(options.projectId),
            ],
          }
        : {
            property: "Agent",
            rich_text: { is_not_empty: true },
          }) as QueryDataSourceParameters["filter"],
    } as QueryDataSourceParameters)

    for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
      if (page.archived) continue
      const rawAgent = extractRichText(page.properties["Agent"])
      if (!rawAgent) continue
      const canonicalAgent = canonicalizeAgentName(rawAgent)
      if (canonicalAgent === rawAgent) continue
      rows.push({ id: page.id, rawAgent, canonicalAgent })
    }

    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
  } while (cursor)

  rows.sort((a, b) => {
    const byCanonical = a.canonicalAgent.localeCompare(b.canonicalAgent)
    if (byCanonical !== 0) return byCanonical
    const byRaw = a.rawAgent.localeCompare(b.rawAgent)
    if (byRaw !== 0) return byRaw
    return a.id.localeCompare(b.id)
  })
  return rows
}

/**
 * Run the agent-identity normalization pass. Scans every memory once,
 * collects the rows whose canonical Agent differs from stored, and — when
 * `dryRun` is false — rewrites `Agent` via a single `pages.update` per row.
 *
 * Idempotent: the canonicalizer is pure and a second run on the same vault
 * returns an empty `encoded` array.
 *
 * Fails open on per-row error: a single Notion 5xx / rate-limit rejection
 * does not abort the whole pass. The failed row is recorded in `errors`
 * and the next iteration continues. Operators can re-run to retry the
 * failures (the canonicalizer is pure and the apply step is idempotent,
 * so a retry against a stable vault picks up exactly the failed subset).
 */
export async function normalizeAgents(
  client: Client,
  memoriesDb: DatabaseRef,
  options: { dryRun?: boolean; projectId?: string } = {}
): Promise<AgentNormalizationReport> {
  const encoded = await findNormalizableAgents(client, memoriesDb, {
    projectId: options.projectId,
  })

  if (options.dryRun) {
    return { encoded, fixes: [], errors: [] }
  }

  const fixes: AgentNormalizationFixResult[] = []
  const errors: AgentNormalizationFailure[] = []
  for (const row of encoded) {
    try {
      await client.pages.update({
        page_id: row.id,
        properties: {
          Agent: { rich_text: [{ text: { content: row.canonicalAgent } }] },
        } as CreatePageParameters["properties"],
      })
      fixes.push(row)
    } catch (err) {
      errors.push({
        id: row.id,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { encoded, fixes, errors }
}
