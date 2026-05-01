import { describe, expect, it } from "vitest"
import type { Memory } from "../types.js"
import {
  CONFLICT_PAIR_LIMIT,
  CONFLICT_TAG_OVERLAP_THRESHOLD,
  CONFLICT_TRIGRAM_THRESHOLD,
  findConflictCandidates,
  type ConflictCandidate,
} from "./conflict.js"
import { tagOverlap, trigramJaccard } from "./similarity.js"

/**
 * Conflict-candidate threshold tuning notes (for future contributors):
 *
 * - `CONFLICT_TRIGRAM_THRESHOLD = 0.25` is a starting point chosen to be
 *   meaningfully lower than the memory near-duplicate threshold (`0.7`).
 *   The conflict scan surfaces candidates for an agent to reason about,
 *   not duplicates ready to merge — a wider net is correct here.
 * - `CONFLICT_TAG_OVERLAP_THRESHOLD = 0.5` requires at least half-overlap
 *   on tags to fire the tag-only branch. With small tag vocabularies this
 *   typically means at least one shared tag in two-tag rows.
 *
 * Re-tuning is a one-line change in `conflict.ts`. If real-vault data
 * shows the scan over- or under-surfacing pairs, retune the const,
 * regenerate any affected fixtures, and document the new value here.
 */

function makeMemory(overrides: Partial<Memory> & { id: string; title: string }): Memory {
  return {
    projectIds: ["proj-a"],
    topicId: null,
    source: "manual",
    kind: "note",
    status: "informational",
    confidence: "certain",
    confidenceScore: null,
    reviewBy: null,
    doneAt: null,
    decidedAt: null,
    lastReferencedAt: null,
    supersedesIds: [],
    affectsIds: [],
    alternatives: "",
    consequences: "",
    author: "",
    agent: "",
    tags: [],
    keywords: "",
    synopsis: "",
    session: "",
    content: "",
    taskState: null,
    blockedBy: "",
    entity: "",
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  }
}

/**
 * Independent brute-force oracle for `findConflictCandidates`. Walks
 * the same `i < j` pair grid using the same `trigramJaccard` /
 * `tagOverlap` primitives but with an unconditional push-then-sort
 * shape — no top-K accumulator, no per-pair skip optimization. The
 * function under test is allowed to use either internal path; this
 * oracle gives the equivalence test a reference frame that does NOT
 * share the implementation's accumulator code, so a hypothetical bug
 * in both internal paths would still surface as a diff.
 *
 * Defaults (no `pairLimit`) so the oracle returns the full set; the
 * caller slices to compare against bounded runs.
 */
function bruteForceCandidates(memories: Memory[]): ConflictCandidate[] {
  const out: ConflictCandidate[] = []
  for (let i = 0; i < memories.length; i++) {
    const a = memories[i]
    const aProjects = new Set(a.projectIds)
    const aTags = new Set(a.tags)
    for (let j = i + 1; j < memories.length; j++) {
      const b = memories[j]
      if (a.id === b.id) continue
      let sharesProject = false
      for (const projectId of b.projectIds) {
        if (aProjects.has(projectId)) {
          sharesProject = true
          break
        }
      }
      if (!sharesProject) continue
      const blobA = a.title + " " + a.keywords
      const blobB = b.title + " " + b.keywords
      const similarity = trigramJaccard(blobA, blobB)
      const tagSimilarity = tagOverlap(a.tags, b.tags)
      const trigramHit = similarity >= CONFLICT_TRIGRAM_THRESHOLD
      const tagHit = tagSimilarity >= CONFLICT_TAG_OVERLAP_THRESHOLD
      if (!trigramHit && !tagHit) continue
      const signals: string[] = []
      if (trigramHit) signals.push(`title trigram: ${similarity.toFixed(2)}`)
      if (tagHit) {
        const shared: string[] = []
        for (const tag of b.tags) if (aTags.has(tag)) shared.push(tag)
        if (shared.length > 0) signals.push(`shared tags: ${shared.join(", ")}`)
      }
      if (signals.length === 0) continue
      out.push({ memoryA: a, memoryB: b, similarity, signals })
    }
  }
  out.sort((x, y) => y.similarity - x.similarity)
  return out
}

describe("findConflictCandidates", () => {
  it("returns [] for an empty memory set", () => {
    expect(findConflictCandidates([])).toEqual([])
  })

  it("returns [] for a single memory (no pairs possible)", () => {
    const result = findConflictCandidates([makeMemory({ id: "m1", title: "Solo" })])
    expect(result).toEqual([])
  })

  it("returns one pair for two memories with identical titles sharing a project", () => {
    const m1 = makeMemory({ id: "m1", title: "JWT auth model" })
    const m2 = makeMemory({ id: "m2", title: "JWT auth model" })
    const result = findConflictCandidates([m1, m2])
    expect(result).toHaveLength(1)
    expect(result[0].memoryA.id).toBe("m1")
    expect(result[0].memoryB.id).toBe("m2")
    expect(result[0].similarity).toBeCloseTo(1.0)
  })

  it("never produces a self-pair when the caller hands the same memory twice", () => {
    // Defense against caller bugs: a paginated loader returning a row
    // twice, or a defensive dedup miss in #09, must not surface as a
    // (m, m) candidate at similarity 1.0. The id-equality guard fires
    // before any similarity work.
    const m = makeMemory({ id: "m1", title: "JWT auth model" })
    expect(findConflictCandidates([m, m])).toEqual([])
    // Two distinct objects sharing an id (e.g., two separate fetch
    // results materialized into different `Memory` instances) are
    // also caught by the id-equality guard.
    const m1Copy = makeMemory({ id: "m1", title: "JWT auth model" })
    expect(findConflictCandidates([m, m1Copy])).toEqual([])
  })

  it("filters out pairs with disjoint projectIds", () => {
    const m1 = makeMemory({ id: "m1", title: "JWT auth model", projectIds: ["proj-a"] })
    const m2 = makeMemory({ id: "m2", title: "JWT auth model", projectIds: ["proj-b"] })
    const result = findConflictCandidates([m1, m2])
    expect(result).toEqual([])
  })

  it("emits each unordered pair exactly once across multi-project memories", () => {
    // A in [X, Y], B in [Y, Z], C in [Z, W] — A–B share Y, B–C share Z,
    // A–C disjoint. Identical titles so all qualifying pairs fire.
    const a = makeMemory({ id: "A", title: "Shared subject", projectIds: ["X", "Y"] })
    const b = makeMemory({ id: "B", title: "Shared subject", projectIds: ["Y", "Z"] })
    const c = makeMemory({ id: "C", title: "Shared subject", projectIds: ["Z", "W"] })
    const result = findConflictCandidates([a, b, c])
    expect(result).toHaveLength(2)
    const pairKeys = result.map((p) => `${p.memoryA.id}-${p.memoryB.id}`).sort()
    expect(pairKeys).toEqual(["A-B", "B-C"])
  })

  it("surfaces a tag-overlap-only pair when titles are disjoint but tags overlap heavily", () => {
    const m1 = makeMemory({
      id: "m1",
      title: "Migration plan for indexing layer",
      tags: ["architecture", "core"],
    })
    const m2 = makeMemory({
      id: "m2",
      title: "Decision review schedule for Q2",
      tags: ["architecture", "core"],
    })
    const result = findConflictCandidates([m1, m2])
    expect(result).toHaveLength(1)
    expect(result[0].signals.some((s) => s.startsWith("shared tags:"))).toBe(true)
    expect(result[0].signals.find((s) => s.startsWith("shared tags:"))).toContain(
      "architecture",
    )
  })

  it("emits signals in fixed order: trigram first, then tags", () => {
    // Both signals fire (identical title AND fully-overlapping tags).
    // #05's compare tool and #09's scan output read `signals[0]` as
    // the headline reason — pinning the order keeps that contract
    // stable regardless of which check runs first in the
    // implementation.
    const m1 = makeMemory({
      id: "m1",
      title: "JWT auth model",
      tags: ["auth", "security"],
    })
    const m2 = makeMemory({
      id: "m2",
      title: "JWT auth model",
      tags: ["auth", "security"],
    })
    const result = findConflictCandidates([m1, m2])
    expect(result).toHaveLength(1)
    expect(result[0].signals).toHaveLength(2)
    expect(result[0].signals[0]).toMatch(/^title trigram:/)
    expect(result[0].signals[1]).toMatch(/^shared tags:/)
  })

  it("folds keywords into the trigram blob so a shared keyword surfaces a pair on title-blob signal", () => {
    // Disjoint titles + disjoint tags. Shared keyword content (a PR
    // number) should push the title-blob trigram score above the
    // 0.25 threshold even though raw titles don't overlap.
    const m1 = makeMemory({
      id: "m1",
      title: "Investigated regression",
      keywords: "PR-25750 latency profiling",
      tags: [],
    })
    const m2 = makeMemory({
      id: "m2",
      title: "Reverted broken commit",
      keywords: "PR-25750 latency profiling",
      tags: [],
    })
    const result = findConflictCandidates([m1, m2])
    expect(result).toHaveLength(1)
    expect(result[0].signals.some((s) => s.startsWith("title trigram:"))).toBe(true)
  })

  it("does NOT filter on caller-side state — pairs surface even when both memories already cite each other in caller-managed tracking", () => {
    // The module deliberately doesn't read any `comparedWith` /
    // `archived` field on Memory — that filter is the caller's job
    // (#09). Verifying by passing fixtures whose only distinguishing
    // mark would be such a field and asserting the pair still
    // appears.
    const m1 = makeMemory({ id: "m1", title: "Decision: cache strategy" })
    const m2 = makeMemory({ id: "m2", title: "Decision: cache strategy" })
    const result = findConflictCandidates([m1, m2])
    expect(result).toHaveLength(1)
  })

  it("respects an explicit pairLimit and returns pairs sorted by similarity desc", () => {
    // Six memories, four with the exact same title and two with a
    // close paraphrase — yields multiple qualifying pairs. pairLimit:
    // 2 should keep the two highest-similarity pairs.
    const memories = [
      makeMemory({ id: "a", title: "JWT auth model" }),
      makeMemory({ id: "b", title: "JWT auth model" }),
      makeMemory({ id: "c", title: "JWT auth model" }),
      makeMemory({ id: "d", title: "JWT auth model" }),
      makeMemory({ id: "e", title: "JWT auth design" }),
      makeMemory({ id: "f", title: "JWT auth proposal" }),
    ]
    const result = findConflictCandidates(memories, { pairLimit: 2 })
    expect(result).toHaveLength(2)
    expect(result[0].similarity).toBeGreaterThanOrEqual(result[1].similarity)
  })

  it("preserves insertion (i<j) order on similarity ties via stable sort", () => {
    // Three memories with the exact same title produce three
    // similarity≈1.0 pairs: (a,b), (a,c), (b,c). ES2019 stable sort
    // guarantees they appear in that insertion order. #09's scan
    // output renders pairs in a deterministic table; a future
    // contributor swapping `Array.prototype.sort` for a non-stable
    // `quicksort` would silently break that determinism.
    const a = makeMemory({ id: "a", title: "Identical subject string" })
    const b = makeMemory({ id: "b", title: "Identical subject string" })
    const c = makeMemory({ id: "c", title: "Identical subject string" })
    const result = findConflictCandidates([a, b, c])
    expect(result).toHaveLength(3)
    const pairKeys = result.map((p) => `${p.memoryA.id}-${p.memoryB.id}`)
    expect(pairKeys).toEqual(["a-b", "a-c", "b-c"])
    // All three similarities are 1.0; ties are broken by insertion
    // order (i<j over the input).
    for (const candidate of result) {
      expect(candidate.similarity).toBeCloseTo(1.0)
    }
  })

  it("defaults to CONFLICT_PAIR_LIMIT (50) when pairLimit is omitted", () => {
    // Build a corpus producing well over 50 qualifying pairs.
    // 15 memories with identical titles → C(15, 2) = 105 pairs.
    const memories = Array.from({ length: 15 }, (_, i) =>
      makeMemory({ id: `m${i}`, title: "Identical subject string" }),
    )
    const result = findConflictCandidates(memories, {})
    expect(result).toHaveLength(CONFLICT_PAIR_LIMIT)
  })

  it("returns the full sorted set when pairLimit is Number.POSITIVE_INFINITY", () => {
    // Same 15-memory / 105-pair corpus as above. The unbounded path
    // is what #09's `--exhaustive` flag uses; an implementation that
    // special-cases Infinity to "default to 50" would silently
    // defeat that flag.
    const memories = Array.from({ length: 15 }, (_, i) =>
      makeMemory({ id: `m${i}`, title: "Identical subject string" }),
    )
    const result = findConflictCandidates(memories, {
      pairLimit: Number.POSITIVE_INFINITY,
    })
    expect(result).toHaveLength(105)
  })

  it("treats Infinity (alias) and Number.POSITIVE_INFINITY identically", () => {
    const memories = Array.from({ length: 15 }, (_, i) =>
      makeMemory({ id: `m${i}`, title: "Identical subject string" }),
    )
    const viaPositiveInfinity = findConflictCandidates(memories, {
      pairLimit: Number.POSITIVE_INFINITY,
    })
    const viaInfinity = findConflictCandidates(memories, { pairLimit: Infinity })
    expect(viaInfinity).toHaveLength(viaPositiveInfinity.length)
  })

  it("is deterministic — identical input produces identical output", () => {
    const memories = [
      makeMemory({ id: "a", title: "JWT auth model", tags: ["auth"] }),
      makeMemory({ id: "b", title: "JWT auth model", tags: ["auth"] }),
      makeMemory({ id: "c", title: "JWT auth design", tags: ["auth"] }),
    ]
    const first = findConflictCandidates(memories)
    const second = findConflictCandidates(memories)
    expect(second).toEqual(first)
  })

  it("exposes constants at the documented values", () => {
    expect(CONFLICT_TRIGRAM_THRESHOLD).toBe(0.25)
    expect(CONFLICT_TAG_OVERLAP_THRESHOLD).toBe(0.5)
    expect(CONFLICT_PAIR_LIMIT).toBe(50)
  })

  it("bounded top-K matches an INDEPENDENT brute-force oracle (does not just compare implementation against itself)", () => {
    // Adversarial fixture: 12 memories whose pairwise similarities are
    // mixed (not all 1.0), so a bounded top-K accumulator and a
    // sort-then-slice pipeline could in principle diverge on tie
    // semantics.
    //
    // The oracle is hand-rolled: it walks the same `i < j` pair grid,
    // calls `trigramJaccard` and `tagOverlap` directly (the same
    // primitives `findConflictCandidates` consumes, but composed
    // INDEPENDENTLY of either internal accumulation path), pushes
    // every passing pair, sorts stably, and slices. If
    // `findConflictCandidates`'s top-K and unbounded paths share a
    // bug, both internal paths would diverge from the oracle here —
    // which is the test's whole point.
    const memories = [
      makeMemory({ id: "m0", title: "JWT auth model" }),
      makeMemory({ id: "m1", title: "JWT auth model" }),
      makeMemory({ id: "m2", title: "JWT auth design" }),
      makeMemory({ id: "m3", title: "JWT auth design" }),
      makeMemory({ id: "m4", title: "JWT auth proposal" }),
      makeMemory({ id: "m5", title: "JWT auth proposal" }),
      makeMemory({ id: "m6", title: "OAuth bearer model" }),
      makeMemory({ id: "m7", title: "OAuth bearer model" }),
      makeMemory({ id: "m8", title: "Session cookie model" }),
      makeMemory({ id: "m9", title: "Session cookie model" }),
      makeMemory({ id: "m10", title: "Different unrelated topic" }),
      makeMemory({ id: "m11", title: "Yet another distinct subject" }),
    ]
    const oracle = bruteForceCandidates(memories)
    const fingerprint = (c: ConflictCandidate): string =>
      `${c.memoryA.id}-${c.memoryB.id}@${c.similarity.toFixed(3)}`

    // Sub-cap: bounded top-K must match the oracle's top-K prefix.
    for (const cap of [1, 3, 7, 15]) {
      const bounded = findConflictCandidates(memories, { pairLimit: cap })
      expect(bounded.map(fingerprint)).toEqual(
        oracle.slice(0, cap).map(fingerprint),
      )
    }
    // Unbounded: the dedicated push-then-sort path must match the
    // oracle in full. This is the cross-check the prior version of
    // this test was missing — the oracle is not the implementation.
    const unbounded = findConflictCandidates(memories, {
      pairLimit: Number.POSITIVE_INFINITY,
    })
    expect(unbounded.map(fingerprint)).toEqual(oracle.map(fingerprint))
  })

  it("bounded path bounds in-memory pair accumulation to O(cap) — N²-overlap input does not allocate N(N-1)/2 candidates", () => {
    // 50 memories with identical titles produce C(50, 2) = 1225 raw
    // candidates that all clear threshold. A collect-then-slice
    // implementation would allocate 1225 ConflictCandidate objects
    // before slicing to 50. The bounded accumulator is mathematically
    // O(cap) — at any point during the loop, `candidates.length <=
    // cap`. The result count remains 50, but the in-flight allocation
    // is genuinely capped.
    //
    // We verify the contract structurally rather than by introspecting
    // V8's heap: monkey-patch `Array.prototype.splice` for the duration
    // of the call to count growth past the cap. With bounded
    // accumulation, splice is called per-insertion and the observed
    // running array length never exceeds `cap + 1` (the transient
    // state between splice and pop).
    const memories = Array.from({ length: 50 }, (_, i) =>
      makeMemory({ id: `m${i}`, title: "Identical subject string" }),
    )
    let observedMaxLength = 0
    const realSplice = Array.prototype.splice
    Array.prototype.splice = function (
      this: unknown[],
      ...args: Parameters<typeof Array.prototype.splice>
    ): unknown[] {
      const result = realSplice.apply(this, args) as unknown[]
      if (this.length > observedMaxLength) observedMaxLength = this.length
      return result
    } as typeof Array.prototype.splice
    try {
      const result = findConflictCandidates(memories, { pairLimit: 50 })
      expect(result).toHaveLength(50)
    } finally {
      Array.prototype.splice = realSplice
    }
    // Allow `cap + 1` for the transient post-splice / pre-pop length.
    expect(observedMaxLength).toBeLessThanOrEqual(51)
    // Must be strictly less than the unbounded N(N-1)/2 = 1225.
    expect(observedMaxLength).toBeLessThan(1225)
  })

  it("unbounded path uses push-then-sort, NOT per-insert splice (avoids O(N⁴) regression under --exhaustive)", () => {
    // Splitting the implementation into bounded (top-K) and unbounded
    // (push-then-sort) paths is the load-bearing decision behind
    // `--exhaustive`'s performance: a unified top-K path would
    // degenerate into N² × O(N²) = O(N⁴) work because every passing
    // candidate would walk the full prefix on average. This test
    // pins the path split structurally — `Array.prototype.splice`
    // is the bounded path's per-insert primitive and MUST NOT be
    // called on the unbounded path.
    //
    // The 50-memory / 1225-pair fixture from the bounded test would,
    // if routed through the bounded path, call splice 1225 times.
    // The unbounded path uses `push` instead, so we expect zero
    // splice calls during candidate accumulation.
    const memories = Array.from({ length: 50 }, (_, i) =>
      makeMemory({ id: `m${i}`, title: "Identical subject string" }),
    )
    let spliceCallCount = 0
    const realSplice = Array.prototype.splice
    Array.prototype.splice = function (
      this: unknown[],
      ...args: Parameters<typeof Array.prototype.splice>
    ): unknown[] {
      spliceCallCount++
      return realSplice.apply(this, args) as unknown[]
    } as typeof Array.prototype.splice
    try {
      const result = findConflictCandidates(memories, {
        pairLimit: Number.POSITIVE_INFINITY,
      })
      expect(result).toHaveLength(1225)
    } finally {
      Array.prototype.splice = realSplice
    }
    // Zero splice calls on the unbounded path. (`Array.prototype.sort`
    // is called once at the end but doesn't go through splice.)
    expect(spliceCallCount).toBe(0)
  })
})
