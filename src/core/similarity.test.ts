import { describe, expect, it } from "vitest"
import { titleTrigrams, trigramJaccard, tagOverlap } from "./similarity.js"

describe("titleTrigrams", () => {
  it("returns an empty set for the empty string", () => {
    expect(titleTrigrams("")).toEqual(new Set())
  })

  it("returns an empty set for whitespace-only input", () => {
    expect(titleTrigrams("   \t\n  ")).toEqual(new Set())
  })

  it("pads boundaries so one-character input still produces trigrams", () => {
    // "x" → "  x  " → "  x", " x ", "x  "
    expect(titleTrigrams("x")).toEqual(new Set(["  x", " x ", "x  "]))
  })

  it("lowercases before extracting trigrams (case variation matches full)", () => {
    expect(titleTrigrams("Foo")).toEqual(titleTrigrams("foo"))
    expect(titleTrigrams("FOO")).toEqual(titleTrigrams("foo"))
  })

  it("collapses internal whitespace runs to a single space", () => {
    expect(titleTrigrams("hello   world")).toEqual(titleTrigrams("hello world"))
  })

  it("NFC-normalizes combining characters so precomposed é and e+acute match", () => {
    const precomposed = "café"
    const decomposed = "café"
    expect(titleTrigrams(precomposed)).toEqual(titleTrigrams(decomposed))
  })

  it("HTML-entity-decodes before extracting trigrams — pre-PF1-06 parity", () => {
    // Pre-PF1-06 vault rows still carry encoded titles in storage
    // (`"Café &amp;amp; Bar"`). Post-PF1-06 writes decode at the create
    // boundary (`MemoryService.create`). Without decoding inside the
    // trigram pipeline, the probe would fail to match these two, and
    // every near-duplicate probe against an unmigrated vault would
    // silently miss real duplicates.
    expect(titleTrigrams("Café &amp;amp; Bar")).toEqual(titleTrigrams("Café & Bar"))
    expect(titleTrigrams("PR #25650&amp;#8217;s diff")).toEqual(
      titleTrigrams("PR #25650’s diff"),
    )
    expect(titleTrigrams("5 &lt; 7")).toEqual(titleTrigrams("5 < 7"))
  })
})

describe("trigramJaccard", () => {
  it("is 1.0 for identical titles", () => {
    expect(trigramJaccard("abc", "abc")).toBe(1)
    expect(trigramJaccard("Hello world", "Hello world")).toBe(1)
  })

  it("is 1.0 across case variation", () => {
    expect(trigramJaccard("Wakeup hook", "WAKEUP HOOK")).toBe(1)
  })

  it("is 1.0 across internal whitespace differences", () => {
    expect(trigramJaccard("a  b  c", "a b c")).toBe(1)
  })

  it("is 0 when either side is empty", () => {
    expect(trigramJaccard("", "anything")).toBe(0)
    expect(trigramJaccard("anything", "")).toBe(0)
    expect(trigramJaccard("", "")).toBe(0)
  })

  it("is 0 for fully disjoint titles with no shared trigrams", () => {
    // No overlapping 3-char windows even with padding.
    expect(trigramJaccard("abc", "xyz")).toBe(0)
  })

  it("is between 0 and 1 for partially overlapping near-titles", () => {
    // Paraphrased variants of the same memory title.
    const sim = trigramJaccard(
      "Wakeup hook swallows errors silently",
      "Wakeup hook silent-failure root cause",
    )
    expect(sim).toBeGreaterThan(0.3)
    expect(sim).toBeLessThan(1)
  })

  it("separates true duplicates from merely topical matches", () => {
    // Near-paraphrase (should score above memory threshold of 0.7 after a
    // trailing suffix only).
    const paraphrase = trigramJaccard(
      "Wakeup hook crash diagnosis",
      "Wakeup hook crash diagnosis + migration plan",
    )
    // Topically related but distinct (should score below).
    const topical = trigramJaccard(
      "Wakeup hook crash diagnosis",
      "Fact dedup backfill migration",
    )
    expect(paraphrase).toBeGreaterThan(topical)
  })

  it("handles one-word titles without throwing (short-string edge case)", () => {
    expect(trigramJaccard("a", "a")).toBe(1)
    expect(trigramJaccard("a", "b")).toBe(0)
  })

  it("scores encoded-vs-decoded pair at 1.0 (normalization parity)", () => {
    // The spec blocker: pre-PF1-06 rows stored as `"&amp;amp;"` must
    // match the post-PF1-06 decoded equivalent above the memory
    // threshold (0.7). Normalization decodes both sides, so trigram
    // Jaccard is exactly 1.0 despite the byte-level difference.
    expect(
      trigramJaccard("Café &amp;amp; Bar closed early", "Café & Bar closed early"),
    ).toBe(1)
    expect(trigramJaccard("5 &lt; 7 always", "5 < 7 always")).toBe(1)
  })

  it("is symmetric in its arguments", () => {
    const a = "Fix the wakeup hook"
    const b = "Wakeup hook fix attempt"
    expect(trigramJaccard(a, b)).toBe(trigramJaccard(b, a))
  })
})

describe("tagOverlap", () => {
  it("is 1.0 for identical tag sets", () => {
    expect(tagOverlap(["architecture", "core"], ["architecture", "core"])).toBe(1)
  })

  it("is order-insensitive", () => {
    expect(tagOverlap(["a", "b", "c"], ["c", "a", "b"])).toBe(1)
  })

  it("is 0 when either side is empty", () => {
    expect(tagOverlap([], ["a"])).toBe(0)
    expect(tagOverlap(["a"], [])).toBe(0)
    expect(tagOverlap([], [])).toBe(0)
  })

  it("is the jaccard ratio for partially overlapping sets", () => {
    // {a,b} vs {b,c} → intersection 1, union 3 → 1/3.
    expect(tagOverlap(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3)
  })

  it("collapses duplicates within a single list (defensive)", () => {
    expect(tagOverlap(["x", "x"], ["x"])).toBe(1)
  })

  it("matches the 2/3 tag-overlap example from the P2-03 spec", () => {
    // {architecture, core, performance} vs {architecture, core} →
    // intersection 2, union 3 → 2/3. This is the "2/3 tag overlap"
    // figure the spec's example response cites.
    const sim = tagOverlap(
      ["architecture", "core", "performance"],
      ["architecture", "core"],
    )
    expect(sim).toBeCloseTo(2 / 3)
  })
})
