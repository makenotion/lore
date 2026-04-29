import { describe, expect, it } from "vitest"
import { buildMemoryProps, memoriesProperties } from "./schema.js"

describe("memoriesProperties — Last Referenced At column (0.8.0/02)", () => {
  it("declares Last Referenced At as a date column on a fresh-vault config", () => {
    const props = memoriesProperties("p-ds", "t-ds", "m-ds")
    expect(props["Last Referenced At"]).toEqual({ date: {} })
  })

  it("declares Last Referenced At on the legacy-vault (no self-relation) shape too", () => {
    // The two-arg overload is what `verifyVaultDatabases` uses on a vault
    // that pre-dates self-relations. The column ships in both shapes so a
    // legacy vault running `lore migrate` surfaces the missing column on
    // the same code path as a fresh `lore init`.
    const props = memoriesProperties("p-ds", "t-ds")
    expect(props["Last Referenced At"]).toEqual({ date: {} })
  })

  it("places Last Referenced At immediately after Decided At so insertion order matches the spec's date-cluster contract", () => {
    // Pin insertion point so a parallel late-merger landing #01
    // (`Confidence Score`) on top of #02 — or vice versa — does a one-line
    // rebase rather than guessing where the column belongs. The spec
    // groups Last Referenced At with the other date columns (Review By /
    // Done At / Decided At).
    const keys = Object.keys(memoriesProperties("p-ds", "t-ds", "m-ds"))
    const decidedAtIdx = keys.indexOf("Decided At")
    const lastReferencedAtIdx = keys.indexOf("Last Referenced At")
    expect(lastReferencedAtIdx).toBe(decidedAtIdx + 1)
  })
})

describe("buildMemoryProps — lastReferencedAt emission", () => {
  it("omits Last Referenced At when the input is undefined (leaves the column untouched on update)", () => {
    const built = buildMemoryProps({ title: "x" }) as Record<string, unknown>
    expect("Last Referenced At" in built).toBe(false)
  })

  it("emits a date-with-start when lastReferencedAt is a YYYY-MM-DD string", () => {
    const built = buildMemoryProps({ title: "x", lastReferencedAt: "2026-04-29" }) as Record<
      string,
      { date: { start: string } | null }
    >
    expect(built["Last Referenced At"]).toEqual({ date: { start: "2026-04-29" } })
  })

  it("collapses null to date:null so callers using the typed `string | null` shape clear the column", () => {
    // `null` is the only documented clear signal — mirrors `reviewBy` /
    // `decidedAt`. Notion's `date` property type distinguishes `null`
    // from absent; `null` is the wire-level "clear this column" signal.
    // Empty strings and other falsy values are NOT treated as clears —
    // the strict `=== null` check in `buildMemoryProps` passes them
    // through verbatim so a Zod regex violation (or other malformed
    // input) surfaces as a Notion-side error rather than silently
    // wiping the column.
    const built = buildMemoryProps({ title: "x", lastReferencedAt: null }) as Record<
      string,
      { date: { start: string } | null }
    >
    expect(built["Last Referenced At"]).toEqual({ date: null })
  })
})

describe("memoriesProperties — Done At column (#07)", () => {
  it("declares Done At as a date column on a fresh-vault config", () => {
    const props = memoriesProperties("p-ds", "t-ds", "m-ds")
    expect(props["Done At"]).toEqual({ date: {} })
  })

  it("declares Done At as a date column on the legacy-vault (no self-relation) shape too", () => {
    // The two-arg overload is what `verifyVaultDatabases` uses on a vault
    // that pre-dates self-relations. Done At ships in both shapes so a
    // legacy vault running `lore migrate` surfaces the missing column on
    // the same code path as a fresh `lore init`.
    const props = memoriesProperties("p-ds", "t-ds")
    expect(props["Done At"]).toEqual({ date: {} })
  })

  it("places Done At immediately after Review By so insertion order matches the spec's #07/#01 rebase contract", () => {
    // The spec pins Done At's insertion point so a parallel late-merger
    // landing #01 (Synopsis) on top of #07 — or vice versa — does a
    // one-line rebase rather than guessing where the column belongs.
    const keys = Object.keys(memoriesProperties("p-ds", "t-ds", "m-ds"))
    const reviewByIdx = keys.indexOf("Review By")
    const doneAtIdx = keys.indexOf("Done At")
    expect(doneAtIdx).toBe(reviewByIdx + 1)
  })
})

describe("memoriesProperties — Confidence Score column (#01)", () => {
  it("declares Confidence Score as a number column on a fresh-vault config", () => {
    const props = memoriesProperties("p-ds", "t-ds", "m-ds")
    expect(props["Confidence Score"]).toEqual({ number: { format: "number" } })
  })

  it("declares Confidence Score on the legacy-vault (no self-relation) shape too", () => {
    // `verifyVaultDatabases` + `migrateVaultSchema` use the two-arg
    // overload on a vault that pre-dates self-relations. The new column
    // ships in both shapes so a legacy vault running `lore migrate`
    // surfaces the missing column on the same code path as a fresh
    // `lore init`.
    const props = memoriesProperties("p-ds", "t-ds")
    expect(props["Confidence Score"]).toEqual({ number: { format: "number" } })
  })

  it("places Confidence Score immediately after Confidence so insertion order matches the #01/#02 rebase contract", () => {
    // The spec pins the insertion point so a parallel late-merger
    // landing #02 (Last Referenced At) on top of #01 — or vice versa —
    // does a one-line rebase rather than guessing where the column
    // belongs. Co-locating with the categorical `Confidence` keeps the
    // on-Notion schema readable: the two confidence axes live next to
    // each other in the property list.
    const keys = Object.keys(memoriesProperties("p-ds", "t-ds", "m-ds"))
    const confidenceIdx = keys.indexOf("Confidence")
    const confidenceScoreIdx = keys.indexOf("Confidence Score")
    expect(confidenceScoreIdx).toBe(confidenceIdx + 1)
  })
})

describe("buildMemoryProps — confidenceScore emission", () => {
  it("omits Confidence Score when the input is undefined (leaves the column untouched on update)", () => {
    const built = buildMemoryProps({ title: "x" }) as Record<string, unknown>
    expect("Confidence Score" in built).toBe(false)
  })

  it("emits a number-with-value when confidenceScore is a finite number", () => {
    const built = buildMemoryProps({ title: "x", confidenceScore: 0.85 }) as Record<
      string,
      { number: number | null }
    >
    expect(built["Confidence Score"]).toEqual({ number: 0.85 })
  })

  it("emits number:null when confidenceScore is null so an explicit clear writes through", () => {
    // Distinct from `undefined` (which omits the property): test fixtures
    // and the migration in #11 use `null` to wipe a stale score before
    // re-seeding. Mirrors how `reviewBy: null` clears a date column.
    const built = buildMemoryProps({ title: "x", confidenceScore: null }) as Record<
      string,
      { number: number | null }
    >
    expect(built["Confidence Score"]).toEqual({ number: null })
  })

  it("preserves zero as a valid score (writes `{ number: 0 }`)", () => {
    // `0` is the floor of the score range, not a sentinel for "unset" —
    // a memory contradicted to zero must round-trip through Notion as
    // an explicit number rather than collapsing to a cleared column.
    const built = buildMemoryProps({ title: "x", confidenceScore: 0 }) as Record<
      string,
      { number: number | null }
    >
    expect(built["Confidence Score"]).toEqual({ number: 0 })
  })
})

describe("buildMemoryProps — doneAt emission", () => {
  it("omits Done At when the input is undefined (leaves the column untouched on update)", () => {
    const built = buildMemoryProps({ title: "x" }) as Record<string, unknown>
    expect("Done At" in built).toBe(false)
  })

  it("emits a date-with-start when doneAt is a YYYY-MM-DD string", () => {
    const built = buildMemoryProps({ title: "x", doneAt: "2026-04-28" }) as Record<
      string,
      { date: { start: string } | null }
    >
    expect(built["Done At"]).toEqual({ date: { start: "2026-04-28" } })
  })

  it("collapses null to date:null so callers using the typed `string | null` shape clear the column too", () => {
    const built = buildMemoryProps({ title: "x", doneAt: null }) as Record<
      string,
      { date: { start: string } | null }
    >
    expect(built["Done At"]).toEqual({ date: null })
  })
})

describe("memoriesProperties — Confidence Score + Last Referenced At columns (0.8.0/#01 + #02)", () => {
  it("declares Confidence Score as a numeric column", () => {
    const props = memoriesProperties("p-ds", "t-ds", "m-ds")
    expect(props["Confidence Score"]).toEqual({ number: { format: "number" } })
  })

  it("declares Last Referenced At as a date column", () => {
    const props = memoriesProperties("p-ds", "t-ds", "m-ds")
    expect(props["Last Referenced At"]).toEqual({ date: {} })
  })

  it("includes both columns on the legacy two-arg overload (so drift detection picks them up)", () => {
    const props = memoriesProperties("p-ds", "t-ds")
    expect(props["Confidence Score"]).toEqual({ number: { format: "number" } })
    expect(props["Last Referenced At"]).toEqual({ date: {} })
  })
})

describe("buildMemoryProps — confidenceScore + lastReferencedAt three-state semantics", () => {
  it("omits Confidence Score and Last Referenced At when both inputs are undefined", () => {
    const built = buildMemoryProps({ title: "x" }) as Record<string, unknown>
    expect("Confidence Score" in built).toBe(false)
    expect("Last Referenced At" in built).toBe(false)
  })

  it("emits clear-shapes when both inputs are null", () => {
    const built = buildMemoryProps({
      title: "x",
      confidenceScore: null,
      lastReferencedAt: null,
    }) as Record<string, unknown>
    expect(built["Confidence Score"]).toEqual({ number: null })
    expect(built["Last Referenced At"]).toEqual({ date: null })
  })

  it("emits set-shapes for a number score and a YYYY-MM-DD date", () => {
    const built = buildMemoryProps({
      title: "x",
      confidenceScore: 0.42,
      lastReferencedAt: "2026-04-29",
    }) as Record<string, unknown>
    expect(built["Confidence Score"]).toEqual({ number: 0.42 })
    expect(built["Last Referenced At"]).toEqual({
      date: { start: "2026-04-29" },
    })
  })

  it("preserves zero (not collapsed to null) — zero is a valid stored confidence", () => {
    // Defensive: zero is below CONFIDENCE_SCORE_MIN's clamp boundary
    // but explicitly inside the closed range, so the build path must
    // emit it as-is rather than treating it as falsy.
    const built = buildMemoryProps({ title: "x", confidenceScore: 0 }) as Record<
      string,
      unknown
    >
    expect(built["Confidence Score"]).toEqual({ number: 0 })
  })
})
