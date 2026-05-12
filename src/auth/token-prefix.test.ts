import { describe, expect, it } from "vitest"

import {
  classifyTokenPrefix,
  describeTokenPrefix,
  tokenPrefixAdvisory,
} from "./token-prefix.js"

describe("classifyTokenPrefix", () => {
  it("classifies prod PAT / ntn bot tokens as personal-prod", () => {
    expect(classifyTokenPrefix("ntn_abcdefghijklmnopqrstuvwx")).toBe("personal-prod")
  })

  it("classifies dev-environment tokens as personal-dev", () => {
    expect(classifyTokenPrefix("development_ntn_abcdefghijklmnop")).toBe(
      "personal-dev",
    )
  })

  it("classifies integration tokens as integration", () => {
    expect(classifyTokenPrefix("secret_abcdefghijklmnopqrstuvwx")).toBe("integration")
  })

  it("returns unknown for unrecognized shapes", () => {
    expect(classifyTokenPrefix("opaque-jwt-shape")).toBe("unknown")
    expect(classifyTokenPrefix("")).toBe("unknown")
    expect(classifyTokenPrefix("Bearer ntn_abc")).toBe("unknown")
  })

  it("does NOT misclassify development_ntn_ as personal-prod", () => {
    // `development_ntn_` contains `ntn_` as a substring; the
    // classifier MUST check the dev prefix first so the prod branch
    // can't shadow it. A regression that flipped the order would route
    // every dev token through the prod label.
    expect(classifyTokenPrefix("development_ntn_aaaaaaaaaaaaaaaa")).toBe(
      "personal-dev",
    )
  })

  it("does NOT match ntn_ inside a larger string (anchoring contract)", () => {
    // `startsWith` is start-anchored; a token like `Bearer ntn_...`
    // is rejected as unknown rather than misclassified as personal-prod.
    // Lore's redactor and bearer-shape guard handle the `Bearer `
    // prefix separately; the classifier sees raw tokens only.
    expect(classifyTokenPrefix("xntn_abc")).toBe("unknown")
    expect(classifyTokenPrefix("Bearer secret_abc")).toBe("unknown")
  })
})

describe("describeTokenPrefix", () => {
  it("renders personal-prod with the ntn_ shape", () => {
    expect(describeTokenPrefix("personal-prod")).toBe("personal token — ntn_")
  })

  it("renders personal-dev with the development_ntn_ shape", () => {
    expect(describeTokenPrefix("personal-dev")).toBe(
      "personal token — development_ntn_",
    )
  })

  it("renders integration tokens as a single-line, paren-free label", () => {
    // The label MUST be safe for `(${label})` wrapping by the
    // caller. Inner parens would produce nested-paren output;
    // newlines would break the script-friendly identity contract.
    // The rate-limit-collapse advisory lives in `tokenPrefixAdvisory`
    // and is emitted to stderr by the caller, NOT folded into this
    // label.
    const out = describeTokenPrefix("integration")
    expect(out).toBe("integration token — secret_")
    expect(out).not.toMatch(/[()]/)
    expect(out).not.toMatch(/\n/)
  })

  it("returns empty string for unknown so the identity renders bare", () => {
    expect(describeTokenPrefix("unknown")).toBe("")
  })
})

describe("tokenPrefixAdvisory", () => {
  it("emits a rate-limit-collapse advisory for integration tokens", () => {
    // The advisory carries the operator guidance that used to live
    // in `describeTokenPrefix`'s label — moved out so the label
    // stays paren-free and the advisory goes to stderr where
    // script-friendly consumers can ignore it.
    const advisory = tokenPrefixAdvisory("integration")
    expect(advisory).not.toBeNull()
    expect(advisory!.toLowerCase()).toContain("rate-limited")
    expect(advisory!.toLowerCase()).toContain("pat")
    expect(advisory!).toContain("notion.so/developers/tokens")
  })

  it("returns null for personal and unknown prefixes (no advisory)", () => {
    expect(tokenPrefixAdvisory("personal-prod")).toBeNull()
    expect(tokenPrefixAdvisory("personal-dev")).toBeNull()
    expect(tokenPrefixAdvisory("unknown")).toBeNull()
  })
})
