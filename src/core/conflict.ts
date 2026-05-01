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
 * Number.POSITIVE_INFINITY` (or its alias `Infinity`) explicitly. #09's
 * `--exhaustive` flag uses this exact path. The two-axis design (default
 * 50 OR explicit Infinity) is deliberate: an engineer reading the
 * signature should never have to guess what "unbounded" means; passing
 * `{}` defaults to 50, which silently defeats `--exhaustive` if someone's
 * not careful.
 *
 * **The cap genuinely bounds in-memory pair allocation.** The
 * implementation maintains a sorted top-K accumulator (binary insert +
 * tail truncation), so candidates that can't make the cut are skipped
 * before signal-array allocation rather than collected and discarded
 * post-sort. A high-overlap project that would produce N(N-1)/2 raw
 * candidates allocates O(`pairLimit`) `ConflictCandidate` objects, not
 * O(N²). The per-pair similarity computation is still O(N²) — that's
 * inherent to lexical-pair comparison and only an index over the corpus
 * could change it — but the cap closes the memory blow-up.
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

  // **Two distinct accumulation paths**, one per cap shape:
  //
  // - **Finite cap** (the default + every non-`--exhaustive` call):
  //   bounded top-K via binary-insert + tail-pop with a `<= minBar`
  //   pre-allocation skip. In-flight footprint is O(cap); per-pair
  //   work is O(log cap). Total: O(N² · log cap) CPU, O(cap) memory.
  //
  // - **Unbounded** (`pairLimit: Number.POSITIVE_INFINITY`, used only
  //   by `lore conflicts scan --exhaustive`): push every passing
  //   candidate, sort once at the end. Per-pair work is O(1); the
  //   final sort is O(M log M) where M is the count of passing pairs.
  //   Total: O(N² + M log M) CPU, O(M) memory.
  //
  // **Why the split is load-bearing.** The bounded path's binary-
  // insert is O(log cap) for the search but the `splice` at the
  // chosen index is O(cap) — so per-insertion is O(cap), not
  // O(log cap). Under finite `cap`, that's fine: cap is small
  // (50 default; 500 in `lore conflicts scan`). Under unbounded
  // `cap`, the accumulator grows to M = O(N²) and the per-insert
  // splice walks the full prefix on average — total work degrades
  // to O(N² · M) = O(N⁴), which is dramatically worse than the
  // collect-then-sort O(N² + M log M) the prior implementation had.
  // The `--exhaustive` flag exists for vaults with extremely
  // overlapping projects; quartic regression there would be
  // pathological. The two paths share threshold + signal logic via
  // a per-pair callback so the visible output stays byte-identical
  // across paths (cross-checked by the equivalence test in
  // `conflict.test.ts`).
  const isUnbounded = !Number.isFinite(cap)

  if (isUnbounded) {
    return findConflictCandidatesUnbounded(memories, {
      trigramThreshold,
      tagOverlapThreshold,
    })
  }
  return findConflictCandidatesBounded(memories, {
    trigramThreshold,
    tagOverlapThreshold,
    cap,
  })
}

interface PairLoopOptions {
  trigramThreshold: number
  tagOverlapThreshold: number
}

interface BoundedLoopOptions extends PairLoopOptions {
  cap: number
}

/**
 * Bounded top-K accumulator. Maintains a sorted-by-similarity-desc
 * array of size at most `cap`. New candidates that can't make the cut
 * are skipped before signal-array allocation, so the in-flight
 * footprint is genuinely O(`cap`), independent of corpus density.
 *
 * Tie semantics: `<= minBar` skip drops strict-equal candidates when
 * the accumulator is full; binary-insert places equal-similarity
 * candidates AFTER existing same-similarity entries. Combined, ties at
 * the boundary preserve i<j insertion order — same shape as the prior
 * stable-sort + slice.
 */
function findConflictCandidatesBounded(
  memories: Memory[],
  options: BoundedLoopOptions,
): ConflictCandidate[] {
  const candidates: ConflictCandidate[] = []
  let minBar = Number.NEGATIVE_INFINITY

  walkPairs(memories, options, (a, b, similarity, buildSignals) => {
    // Bar check BEFORE signal-array allocation. `<= minBar` (not
    // `<`) drops strict-equal candidates when the accumulator is
    // full so insertion order at the threshold is preserved — the
    // first ties to arrive stay in, later ties are skipped.
    if (candidates.length >= options.cap && similarity <= minBar) return

    const signals = buildSignals()
    if (signals.length === 0) return

    // Binary-insert by similarity descending. The search returns the
    // first index whose stored similarity is strictly less than the
    // new candidate's; inserting AT that index puts the new candidate
    // AFTER any existing equal-similarity entries.
    let lo = 0
    let hi = candidates.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (candidates[mid].similarity >= similarity) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    candidates.splice(lo, 0, { memoryA: a, memoryB: b, similarity, signals })
    if (candidates.length > options.cap) {
      candidates.pop()
    }
    if (candidates.length > 0) {
      minBar = candidates[candidates.length - 1].similarity
    }
  })

  return candidates
}

/**
 * Unbounded path used by `--exhaustive`. Pushes every passing
 * candidate, then sorts once at the end. O(N²) push + O(M log M)
 * sort where M is the count of passing pairs. Avoids the bounded
 * path's per-insert `splice` cost which under unbounded `cap`
 * would degrade to O(N⁴) total.
 *
 * `Array.prototype.sort` is stable since ES2019, so equal-similarity
 * pairs preserve their `i < j` insertion order — same tie-shape as
 * the bounded path produces.
 */
function findConflictCandidatesUnbounded(
  memories: Memory[],
  options: PairLoopOptions,
): ConflictCandidate[] {
  const candidates: ConflictCandidate[] = []

  walkPairs(memories, options, (a, b, similarity, buildSignals) => {
    const signals = buildSignals()
    if (signals.length === 0) return
    candidates.push({ memoryA: a, memoryB: b, similarity, signals })
  })

  candidates.sort((x, y) => y.similarity - x.similarity)
  return candidates
}

/**
 * Shared `i < j` pair walk + per-pair filter / similarity / signal
 * scaffolding. Calls `onCandidate` for each pair that passes the
 * project-intersection + similarity-threshold gates. The `buildSignals`
 * thunk is deferred so callers can run their own pre-allocation skip
 * (the bounded path's `<= minBar` cut) BEFORE paying the signal-array
 * allocation cost.
 *
 * **Why a flat `i < j` loop, not partition-by-project.** A naive
 * partition-by-project would emit cross-project-overlap pairs multiple
 * times (memory in projects [A, B] paired against memory in [B, C]
 * would surface once under group B and miss otherwise; grouping [A]
 * and [B, C] separately would double-count). The flat shape emits each
 * unordered pair exactly once.
 */
function walkPairs(
  memories: Memory[],
  options: PairLoopOptions,
  onCandidate: (
    a: Memory,
    b: Memory,
    similarity: number,
    buildSignals: () => string[],
  ) => void,
): void {
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
      // and burn a candidate slot.
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

      const trigramHit = similarity >= options.trigramThreshold
      const tagHit = tagSimilarity >= options.tagOverlapThreshold
      if (!trigramHit && !tagHit) continue

      // Defer signal construction so callers can apply their own
      // pre-allocation skip first (the bounded path's `<= minBar`
      // cut). Today's defaults make `tagHit && !shared`
      // mathematically unreachable (Jaccard ≥ 0.5 forces |A ∩ B| ≥ 1),
      // but a caller passing `tagOverlapThreshold: 0` could land
      // empty signals — guard explicitly so the `ConflictCandidate`
      // contract ("signals populated") holds by construction rather
      // than by threshold-default math.
      const buildSignals = (): string[] => {
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
        return signals
      }

      onCandidate(a, b, similarity, buildSignals)
    }
  }
}
