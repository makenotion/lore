import { describe, expect, it } from "vitest"
import { mergePlannedSearchResults, planSearchQueries } from "./search-plan.js"

describe("planSearchQueries", () => {
  it("keeps the sanitized original query first and adds extracted variants", () => {
    const plan = planSearchQueries(
      "Fix `Next.js` edge middleware auth for @notion/router; verify Redis session refresh failures.",
      { maxQueries: 5 }
    )

    expect(plan.variants[0]).toMatchObject({
      kind: "original",
    })
    expect(plan.variants[0]?.query).toContain("Next.js")
    expect(plan.variants.some((variant) => variant.query.includes("Next.js"))).toBe(true)
    expect(plan.variants.some((variant) => /\bfix\b/u.test(variant.query))).toBe(true)
    expect(
      plan.variants.some((variant) => variant.query.includes("@notion/router"))
    ).toBe(true)
  })

  it("keeps long original queries intact while capping extracted variants", () => {
    const criticalTail =
      "package rails-rspec-guardian from drafts/rails-rspec-guardian.md"
    const plan = planSearchQueries(
      `${"shared skills repository ".repeat(12)}${criticalTail}`,
      { maxQueries: 5 }
    )

    expect(plan.variants[0]).toMatchObject({ kind: "original" })
    expect(plan.variants[0]?.query).toContain(criticalTail)
    expect(plan.variants.slice(1).every((variant) => variant.query.length <= 180)).toBe(
      true
    )
  })

  it("removes bearer-shaped tokens from planned queries", () => {
    const plan = planSearchQueries(
      "Debug auth with ntn_SECRET_VALUE_SHOULD_NOT_LEAK_1234567890 and secret_ANOTHER_VALUE_SHOULD_NOT_LEAK_1234567890 plus 123456:bot-token-value",
      { maxQueries: 5 }
    )
    const rendered = JSON.stringify(plan)

    expect(rendered).not.toContain("ntn_SECRET")
    expect(rendered).not.toContain("secret_ANOTHER")
    expect(rendered).not.toContain("123456:bot-token")
    expect(rendered).toContain("Debug auth")
  })

  it("caps and dedupes variants", () => {
    const plan = planSearchQueries(
      "build build build GraphQL GraphQL resolver resolver resolver; build GraphQL resolver",
      { maxQueries: 3 }
    )
    const uniqueQueries = new Set(plan.variants.map((variant) => variant.query))

    expect(plan.variants).toHaveLength(3)
    expect(uniqueQueries.size).toBe(plan.variants.length)
  })

  it("defaults to a bounded three-variant plan", () => {
    const plan = planSearchQueries(
      "Fix `Next.js` edge middleware auth and Redis session refresh failures"
    )

    expect(plan.variants).toHaveLength(3)
  })

  it("adds a synopsis-shaped capability variant for clear task intent", () => {
    const plan = planSearchQueries(
      "We need a comprehensive E2E test plan with quality gates, acceptance criteria, and Playwright scenarios for the launch.",
      { maxQueries: 3 }
    )

    expect(plan.variants.map((variant) => variant.kind)).toEqual([
      "original",
      "facets",
      "capability",
    ])
    expect(plan.variants[2]?.query).toContain("Use when")
    expect(plan.variants[2]?.query).toContain("test")
    expect(plan.variants[2]?.query).toContain("quality")
    expect(plan.variants[2]?.query).toContain("playwright")
  })

  it("synthesizes a generic capability variant from action and subject terms", () => {
    const plan = planSearchQueries(
      "Fix `Next.js` edge middleware auth and Redis session refresh failures",
      { maxQueries: 3 }
    )

    expect(plan.variants.map((variant) => variant.kind)).toEqual([
      "original",
      "facets",
      "capability",
    ])
    expect(plan.variants[2]?.query).toContain("Use when fix")
    expect(plan.variants[2]?.query).toContain("Next.js")
    expect(plan.variants[2]?.query).toContain("redis")
  })

  it("does not inject hard-coded skill-repository bridge wording", () => {
    const plan = planSearchQueries(
      "Update our shared skills repository for Codex and Claude Code with a new skill package, plugin manifest, and marketplace JSON.",
      { maxQueries: 3 }
    )

    expect(plan.variants[2]).toMatchObject({ kind: "capability" })
    expect(plan.variants[2]?.query).toMatch(/\bskills?\b/u)
    expect(plan.variants[2]?.query).toContain("repository")
    expect(plan.variants[2]?.query).not.toContain("cloning")
    expect(plan.variants[2]?.query).not.toContain("publishing metadata")
  })
})

describe("mergePlannedSearchResults", () => {
  it("dedupes candidates and rank-fuses cross-variant hits", () => {
    const merged = mergePlannedSearchResults(
      [
        [{ id: "b" }, { id: "a" }],
        [{ id: "a" }, { id: "c" }],
      ],
      { getId: (item) => item.id, limit: 3 }
    )

    expect(merged.items.map((item) => item.id)).toEqual(["a", "b", "c"])
    expect(merged.trace[0]).toMatchObject({
      memoryId: "a",
      bestRank: 0,
      variantHits: [
        { variantIndex: 0, rank: 1 },
        { variantIndex: 1, rank: 0 },
      ],
    })
  })

  it("preserves requested first-variant candidates by inclusion", () => {
    const merged = mergePlannedSearchResults(
      [
        [{ id: "direct-0" }, { id: "direct-1" }, { id: "direct-2" }],
        [{ id: "variant-0" }, { id: "variant-1" }, { id: "variant-2" }],
        [{ id: "variant-0" }, { id: "variant-1" }, { id: "variant-2" }],
      ],
      {
        getId: (item) => item.id,
        limit: 3,
        preserveFirstSetCount: 2,
      }
    )

    expect(merged.items.map((item) => item.id)).toContain("direct-0")
    expect(merged.items.map((item) => item.id)).toContain("direct-1")
  })
})
