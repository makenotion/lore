import { describe, expect, it } from "vitest"
import { normalizeTopicNameForLookup } from "./topic-normalize.js"

describe("normalizeTopicNameForLookup", () => {
  it("returns empty string for blank input", () => {
    expect(normalizeTopicNameForLookup("")).toBe("")
    expect(normalizeTopicNameForLookup("   ")).toBe("")
    expect(normalizeTopicNameForLookup("\t\n")).toBe("")
  })

  it("lowercases", () => {
    expect(normalizeTopicNameForLookup("GraphQL Federation")).toBe(
      "graphql federation"
    )
  })

  it("collapses `&` and `and` to the same key", () => {
    expect(normalizeTopicNameForLookup("Build & Tooling")).toBe(
      normalizeTopicNameForLookup("Build and Tooling")
    )
  })

  it("decodes HTML entities before comparing", () => {
    expect(normalizeTopicNameForLookup("Build &amp; Tooling")).toBe(
      normalizeTopicNameForLookup("Build & Tooling")
    )
    expect(normalizeTopicNameForLookup("Build &amp;amp; Tooling")).toBe(
      normalizeTopicNameForLookup("Build & Tooling")
    )
  })

  it("strips punctuation differences", () => {
    expect(normalizeTopicNameForLookup("Super-Archive Eval")).toBe(
      normalizeTopicNameForLookup("super archive eval")
    )
    expect(normalizeTopicNameForLookup("Build, Tooling.")).toBe(
      normalizeTopicNameForLookup("Build Tooling")
    )
  })

  it("collapses simple plural / singular pairs", () => {
    expect(normalizeTopicNameForLookup("Eval & Testing")).toBe(
      normalizeTopicNameForLookup("Evals & Testing")
    )
    expect(normalizeTopicNameForLookup("Bodies of Work")).toBe(
      normalizeTopicNameForLookup("Body of Work")
    )
    expect(normalizeTopicNameForLookup("Processes")).toBe(
      normalizeTopicNameForLookup("Process")
    )
  })

  it("does NOT collapse 'testing' ↔ 'test' (no gerund stripping)", () => {
    // The pluralize pass deliberately stops at trailing-s; a gerund-strip
    // would over-collapse semantically distinct words like `string` → `str`
    // or `training` → `train`. Pin this so a future "more aggressive
    // lemmatizer" change doesn't silently regress us into that hazard.
    expect(normalizeTopicNameForLookup("Testing")).not.toBe(
      normalizeTopicNameForLookup("Test")
    )
  })

  it("does NOT collapse short words like 'gas' / 'bus'", () => {
    // `gas` and `bus` end in `s` but the trailing `s` is the word's own.
    // The length floor (`SINGULARIZE_MIN_LENGTH`) is what keeps these intact.
    expect(normalizeTopicNameForLookup("gas")).toBe("gas")
    expect(normalizeTopicNameForLookup("bus")).toBe("bus")
  })

  it("does NOT collapse double-s words like 'boss'", () => {
    expect(normalizeTopicNameForLookup("Boss Mode")).toBe("boss mode")
    expect(normalizeTopicNameForLookup("Class")).toBe("class")
  })

  it("collapses different conjunctions only at the connective", () => {
    // Conjunction folds (`&` ↔ `and`) plus pluralization are the two
    // axes; head-noun changes don't collapse.
    expect(normalizeTopicNameForLookup("Evals & Quality")).not.toBe(
      normalizeTopicNameForLookup("Evals & Testing")
    )
  })

  it("is idempotent — re-normalizing the key produces the same key", () => {
    const first = normalizeTopicNameForLookup("Build &amp;amp; Tooling")
    expect(normalizeTopicNameForLookup(first)).toBe(first)
  })

  it("collapses NFC vs decomposed Unicode", () => {
    // "Café" composed (single é) vs decomposed (e + ́).
    expect(normalizeTopicNameForLookup("Café Notes")).toBe(
      normalizeTopicNameForLookup("Café Notes")
    )
  })

  it("fixes the issue #109 internal-vault repro: Eval & Testing ≡ Evals & Testing", () => {
    // The exact pair the issue cites as silently fanning out into two
    // sibling topics in the internal vault.
    expect(normalizeTopicNameForLookup("Eval & Testing")).toBe(
      normalizeTopicNameForLookup("Evals & Testing")
    )
  })

  it("keeps the issue #109 distinct concepts apart", () => {
    // Same audit, but these are genuinely different topics — the probe
    // shouldn't collapse them at the normalization layer.
    const evalsTesting = normalizeTopicNameForLookup("Evals & Testing")
    const evalsQuality = normalizeTopicNameForLookup("Evals & Quality")
    const superArchive = normalizeTopicNameForLookup("Super-archive eval")
    expect(evalsTesting).not.toBe(evalsQuality)
    expect(evalsTesting).not.toBe(superArchive)
    expect(evalsQuality).not.toBe(superArchive)
  })
})
