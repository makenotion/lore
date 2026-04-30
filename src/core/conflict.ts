/**
 * Lexical conflict-candidate generator. Pure function over a `Memory[]`
 * snapshot; no Notion access.
 *
 * The module is the *deterministic* half of the 0.9.0 conflict-detection
 * workflow. It returns pairs whose titles, keywords, and tags overlap
 * enough to be worth examining — a cheap pre-filter over the same
 * trigram + tag-overlap helpers that back the near-duplicate probe in
 * `near-duplicate.ts`. The *semantic* half — judging whether a pair
 * actually conflicts, supersedes, or is just related — happens in the
 * calling agent's context and is recorded via `lore-memory action='compare'`
 * (#05). Kept honest in the framing: the system surfaces *candidates*,
 * the agent provides the *verdict*.
 *
 * Engram seeds the same role with FTS5 over an SQLite catalog; lore
 * reuses the existing in-memory helpers from `./similarity.ts` because
 * the candidate set fits in memory and the one-off scan is amortized
 * across the agent's reasoning step that follows. See
 * `src/core/AGENTS.md` § "Locked LLM prompts" for the canonical
 * engram-borrow rationale (this file's comment is the design-choice
 * note; the doctrine lives there).
 */

import type { Memory } from "../types.js"
import { tagOverlap, trigramJaccard } from "./similarity.js"

export interface ConflictCandidate {
  memoryA: Memory
  memoryB: Memory
  /** Trigram Jaccard over the `title + " " + keywords` blob. Range `[0, 1]`. */
  similarity: number
  /**
   * Human-readable reasons the pair surfaced, in fixed order: trigram
   * signal first, tag signal second. Always non-empty by construction —
   * `findConflictCandidates` skips a pair before pushing rather than
   * land it with `signals: []`. Renderers may treat `signals[0]` as the
   * headline reason without further sorting.
   */
  signals: string[]
}

/**
 * Default trigram-similarity floor for surfacing a pair. Lower than the
 * memory near-duplicate threshold (`MEMORY_NEAR_DUPLICATE_THRESHOLD = 0.7`
 * in `src/mcp/tools/memory.ts`) by design: near-duplicates are a stricter
 * version of conflict candidates — conflict candidates include weaker
 * surface overlap, with the agent providing the semantic judgment.
 */
export const CONFLICT_TRIGRAM_THRESHOLD = 0.25

/**
 * Tag-overlap floor: at least this Jaccard ratio of shared tags between
 * the two memories must be reached for a pair to surface on the tag-only
 * signal (when the trigram score is below the trigram floor).
 */
export const CONFLICT_TAG_OVERLAP_THRESHOLD = 0.5

/**
 * Default cap on pairs returned per call. Applied when the caller omits
 * `pairLimit`. Engram's FTS5 candidate set is implicitly bounded by query
 * selectivity; lore is explicit so a thousand-memory vault doesn't return
 * half a million pairs by accident.
 *
 * To opt OUT of any cap, callers pass `pairLimit:
 * Number.POSITIVE_INFINITY` (or its alias `Infinity`) explicitly —
 * `slice(0, Infinity)` is a no-op truncation. #09's `--exhaustive` flag
 * uses this exact path. The two-axis design (default 50 OR explicit
 * Infinity) is deliberate: an engineer reading the signature should never
 * have to guess what "unbounded" means; passing `{}` defaults to 50,
 * which silently defeats `--exhaustive` if someone's not careful.
 */
export const CONFLICT_PAIR_LIMIT = 50

export interface FindConflictCandidatesOptions {
  trigramThreshold?: number
  tagOverlapThreshold?: number
  /**
   * Maximum pairs to return. When omitted, defaults to
   * `CONFLICT_PAIR_LIMIT` (50). Pass `Number.POSITIVE_INFINITY`
   * (or `Infinity`) to skip truncation entirely — used by #09's
   * `--exhaustive` flag.
   */
  pairLimit?: number
}

/**
 * Generate lexical conflict candidates from a memory set. Pure function;
 * no Notion access. The caller (#09's CLI scan) provides the memory list
 * AND is responsible for any post-filtering (e.g., dropping pairs already
 * in `comparedWith`). Keeping this module's scope to candidate
 * *generation* — not state-aware filtering — decouples it from the
 * `comparedWith` schema column added in #02 and from any future skip-
 * conditions a caller wants to apply.
 *
 * Filters this function applies:
 * - At least one shared project (intersection on `projectIds`; memories
 *   with disjoint project sets are never paired).
 * - Trigram similarity OR tag-overlap above threshold.
 *
 * Filters this function does NOT apply (caller's job):
 * - Archived state (lives on Notion page metadata, not on the `Memory`
 *   shape; #09's `MemoryService.listForScan` filters archived rows at the
 *   query layer).
 * - Skip-already-judged via `comparedWith` membership.
 * - Skip-already-superseded via `Status` or `Supersedes`.
 * - Time windows.
 */
export function findConflictCandidates(
  memories: Memory[],
  options: FindConflictCandidatesOptions = {},
): ConflictCandidate[] {
  const trigramThreshold = options.trigramThreshold ?? CONFLICT_TRIGRAM_THRESHOLD
  const tagOverlapThreshold =
    options.tagOverlapThreshold ?? CONFLICT_TAG_OVERLAP_THRESHOLD
  const cap = options.pairLimit ?? CONFLICT_PAIR_LIMIT

  const candidates: ConflictCandidate[] = []

  // Flat O(n²) `i < j` loop with a per-pair project-intersection guard.
  // A naive partition-by-project would emit cross-project-overlap pairs
  // multiple times (memory in projects [A, B] paired against memory in
  // [B, C] would surface once under group B and miss otherwise; grouping
  // [A] and [B, C] separately would double-count). The flat shape emits
  // each unordered pair exactly once.
  for (let i = 0; i < memories.length; i++) {
    const a = memories[i]
    const aProjects = new Set(a.projectIds)
    const aTags = new Set(a.tags)
    for (let j = i + 1; j < memories.length; j++) {
      const b = memories[j]

      // Self-pair guard: if the caller hands us a list with the same
      // memory referenced twice (paginated branches in #09's loader
      // returning a row twice, a defensive dedup miss, etc.), the
      // index-based loop would emit a `(m, m)` pair at similarity 1.0
      // and burn a candidate slot. Engram's FTS5 candidate set can't
      // produce this; lore's in-memory generator is one comparison
      // away from cannot-produce-a-self-pair-regardless-of-caller-bugs.
      if (a.id === b.id) continue

      let sharesProject = false
      for (const projectId of b.projectIds) {
        if (aProjects.has(projectId)) {
          sharesProject = true
          break
        }
      }
      if (!sharesProject) continue

      // Fold keywords into the trigram blob so phrase-shaped surface
      // signal (PR numbers, file paths, ticket IDs) contributes to the
      // similarity score even when the title alone wouldn't cross the
      // threshold. Keywords is a single free-form string per
      // `src/types.ts:460`, not an array — concatenating with a space
      // is the right shape.
      const blobA = a.title + " " + a.keywords
      const blobB = b.title + " " + b.keywords
      const similarity = trigramJaccard(blobA, blobB)
      const tagSimilarity = tagOverlap(a.tags, b.tags)

      const trigramHit = similarity >= trigramThreshold
      const tagHit = tagSimilarity >= tagOverlapThreshold
      if (!trigramHit && !tagHit) continue

      // Build signals in a fixed order — trigram first, tags second —
      // so #05's compare tool and #09's scan output can render the
      // first signal as the headline reason without re-sorting.
      const signals: string[] = []
      if (trigramHit) {
        signals.push(`title trigram: ${similarity.toFixed(2)}`)
      }
      if (tagHit) {
        const shared: string[] = []
        for (const tag of b.tags) {
          if (aTags.has(tag)) shared.push(tag)
        }
        if (shared.length > 0) {
          signals.push(`shared tags: ${shared.join(", ")}`)
        }
      }

      // Structural guarantee: a candidate never lands with `signals: []`.
      // Today's defaults (`tagOverlapThreshold = 0.5`) make `tagHit && !shared`
      // mathematically unreachable (Jaccard ≥ 0.5 forces |A ∩ B| ≥ 1), but
      // a caller passing `tagOverlapThreshold: 0` could land here without
      // a structural signal — guard explicitly so the `ConflictCandidate`
      // contract ("signals populated") holds by construction rather than
      // by threshold-default math.
      if (signals.length === 0) continue

      candidates.push({ memoryA: a, memoryB: b, similarity, signals })
    }
  }

  // Stable sort by similarity desc; `Array.prototype.sort` has been
  // guaranteed stable since ES2019, so equal-similarity pairs preserve
  // their insertion order (which is `i < j` over the input).
  candidates.sort((x, y) => y.similarity - x.similarity)
  // `slice(0, Infinity)` is a no-op truncation in JavaScript, so passing
  // `pairLimit: Infinity` returns the full sorted set unchanged.
  return candidates.slice(0, cap)
}
