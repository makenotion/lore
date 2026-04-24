/**
 * Near-duplicate probe used by `lore-remember` and `lore-decide`.
 *
 * The probe is advisory, not blocking: the write always proceeds, but the
 * tool response surfaces any existing row whose title looks similar enough
 * that the caller might have meant to update or supersede instead of
 * creating a fresh page.
 *
 * Cost budget: one `dataSources.query` per save, bounded by a project +
 * tag filter. The query runs at the tool layer in parallel with the
 * actual create so it doesn't add wall-clock latency.
 *
 * Thresholds are initial guesses from the P2-03 spec (0.7 for memories,
 * 0.6 for decisions); tune on real data after rollout.
 */

import type { Memory, MemoryKind, MemoryStatus } from "../types.js"
import { trigramJaccard, tagOverlap } from "./similarity.js"

export interface NearDuplicateMatch {
  id: string
  title: string
  /** Trigram Jaccard over the normalized titles. Range `[0, 1]`. */
  titleSimilarity: number
  /**
   * Jaccard over tag sets. Range `[0, 1]`. `0` when either row has no
   * tags (see `tagOverlap` in `similarity.ts` for the empty-set rule),
   * so callers render this only when `> 0` — a 0.0 reading on an
   * untagged candidate carries no information and would be noise.
   */
  tagOverlap: number
  decidedAt: string | null
  status: MemoryStatus
}

/**
 * Minimal interface the probe needs from `MemoryService`. Keeping it
 * narrow lets tests pass a plain object without constructing a full
 * service, and documents exactly which query shape the probe depends on
 * so future `list()` signature changes don't silently break the probe.
 */
export interface MemoryLister {
  list(opts: {
    projectId?: string
    topicId?: string
    tags?: string[]
    kind?: MemoryKind
    limit?: number
    includeContent?: boolean
  }): Promise<{ items: Memory[]; nextCursor?: string }>
}

export interface FindNearDuplicatesOpts {
  /** Title of the row being written — the probe subject. */
  title: string
  /** Tags on the row being written. Top-2 scope the candidate pool. */
  tags: string[]
  /**
   * Project to scope the candidate pool. Must be provided — vault-wide
   * probes are skipped because they'd scan the entire Memories DB, busting
   * the one-query budget. Multi-project saves pass the primary project;
   * cross-project near-duplicates are a Phase 3/4 concern.
   */
  projectId?: string
  /**
   * Topic filter for decisions (same-topic is part of the P2-03 decision
   * rule). Leave undefined for the memory path.
   */
  topicId?: string
  /** `decision` for the `lore-decide` path, undefined for `lore-remember`. */
  kind?: MemoryKind
  /**
   * Kinds to post-filter out of the candidate pool. Notion's
   * `dataSources.query` has no "kind ≠ X" primitive, so the filter
   * runs client-side. `lore-remember` uses `["decision"]` so a
   * freshly-saved note doesn't light up every governing decision
   * record — decisions are the `lore-decide` probe's domain.
   */
  excludeKinds?: MemoryKind[]
  /**
   * Status whitelist applied client-side after the query. Notion's
   * `dataSources.query` accepts exactly one `Status select equals` clause,
   * so the decision path — which needs `accepted OR proposed` — post-filters
   * here instead of issuing two server queries for one probe.
   */
  statuses?: MemoryStatus[]
  /** Trigram Jaccard threshold to qualify as a match. */
  threshold: number
  /** Max rows to scan in the candidate pool (default 50). */
  limit?: number
  /**
   * Optional observer for list-query failures. Invoked with the raw
   * error before the probe returns `[]`. `lore-remember` /
   * `lore-decide` route this through `debugLogPartialFailures` so
   * probe failures show up under `LORE_DEBUG=1` like every other
   * read-path partial failure, instead of degrading silently.
   */
  onError?: (err: unknown) => void
}

/**
 * Fetch the recent-memory candidate pool and return any rows whose title
 * trigram similarity meets or exceeds `threshold`. Results are sorted by
 * similarity descending — the caller typically surfaces the top 2–3.
 *
 * Swallows probe errors and returns `[]` rather than propagating:
 * near-dup detection is advisory, and a failed probe must not fail the
 * surrounding save. The tool layer is free to add a telemetry hook later.
 */
export async function findNearDuplicates(
  memories: MemoryLister,
  opts: FindNearDuplicatesOpts,
): Promise<NearDuplicateMatch[]> {
  // Operator kill-switch. Bulk-import, autosave hooks firing every few
  // messages, and test fixtures that spin up 50+ memories all pay a
  // `dataSources.query` per save otherwise. Setting the env var to `1`
  // short-circuits the probe entirely without touching the call sites.
  // Bypass lives here (not per-tool) so both `lore-remember` and
  // `lore-decide` honor it automatically.
  if (process.env["LORE_DISABLE_NEAR_DUPLICATE_PROBE"] === "1") return []
  if (opts.title.trim() === "") return []
  if (!opts.projectId) return []

  // Top-2 tags scope the candidate pool. The `list` tag filter is
  // Notion-side OR across values, so a memory needs to match either tag
  // to enter the pool — which is what we want: share a category, be a
  // candidate for dedup. Fewer than 2 tags: use whatever we have;
  // zero tags means no tag filter (project scope alone).
  const topTags = opts.tags.slice(0, 2)

  let items: Memory[]
  try {
    const result = await memories.list({
      projectId: opts.projectId,
      topicId: opts.topicId,
      tags: topTags.length > 0 ? topTags : undefined,
      kind: opts.kind,
      limit: opts.limit ?? 50,
      includeContent: false,
    })
    items = result.items
  } catch (err) {
    opts.onError?.(err)
    return []
  }

  const excludeKinds = opts.excludeKinds && opts.excludeKinds.length > 0
    ? new Set<MemoryKind>(opts.excludeKinds)
    : null

  const matches: NearDuplicateMatch[] = []
  for (const mem of items) {
    if (excludeKinds?.has(mem.kind)) continue
    if (opts.statuses && !opts.statuses.includes(mem.status)) continue
    const sim = trigramJaccard(opts.title, mem.title)
    if (sim < opts.threshold) continue
    matches.push({
      id: mem.id,
      title: mem.title,
      titleSimilarity: sim,
      tagOverlap: tagOverlap(opts.tags, mem.tags),
      decidedAt: mem.decidedAt,
      status: mem.status,
    })
  }
  matches.sort((a, b) => b.titleSimilarity - a.titleSimilarity)
  return matches
}
