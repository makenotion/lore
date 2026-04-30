import { describe, expect, it } from "vitest"
import { buildMemoryProps, factsProperties, memoriesProperties } from "./schema.js"

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

describe("memoriesProperties — Topic Key + Revision Count columns (0.9.0/01)", () => {
  it("declares Topic Key as a rich_text column on a fresh-vault config", () => {
    const props = memoriesProperties("p-ds", "t-ds", "m-ds")
    expect(props["Topic Key"]).toEqual({ rich_text: {} })
  })

  it("declares Revision Count as a number column on a fresh-vault config", () => {
    const props = memoriesProperties("p-ds", "t-ds", "m-ds")
    expect(props["Revision Count"]).toEqual({ number: { format: "number" } })
  })

  it("declares both columns on the legacy two-arg overload (so drift detection picks them up)", () => {
    // `verifyVaultDatabases` uses the two-arg overload on a vault that
    // pre-dates self-relations. Both columns ship in both shapes so a
    // legacy vault running `lore migrate` surfaces the missing columns
    // on the same code path as a fresh `lore init`.
    const props = memoriesProperties("p-ds", "t-ds")
    expect(props["Topic Key"]).toEqual({ rich_text: {} })
    expect(props["Revision Count"]).toEqual({ number: { format: "number" } })
  })

  it("places Topic Key immediately after Confidence Score so insertion order matches the spec", () => {
    // The spec (0.9.0/#01) pins the insertion point so a parallel
    // late-merger landing #02 (Compared With) on top of #01 — or vice
    // versa — does a one-line rebase rather than guessing where the
    // column belongs. Topic Key + Revision Count cluster between the
    // numeric Confidence Score and the Review By date column,
    // keeping scalar properties grouped together.
    const keys = Object.keys(memoriesProperties("p-ds", "t-ds", "m-ds"))
    const confidenceScoreIdx = keys.indexOf("Confidence Score")
    const topicKeyIdx = keys.indexOf("Topic Key")
    expect(topicKeyIdx).toBe(confidenceScoreIdx + 1)
  })

  it("places Revision Count immediately after Topic Key", () => {
    const keys = Object.keys(memoriesProperties("p-ds", "t-ds", "m-ds"))
    const topicKeyIdx = keys.indexOf("Topic Key")
    const revisionCountIdx = keys.indexOf("Revision Count")
    expect(revisionCountIdx).toBe(topicKeyIdx + 1)
  })

  it("places Revision Count before Review By so the date columns stay clustered", () => {
    // SOFT pin (precedes, not adjacency) — distinct from the two pins
    // above. PR #161 (issue 0.9.0/02) inserts `Compare Notes` between
    // `Revision Count` and `Review By` in the same scalar block, so
    // whichever PR lands second would fail a `reviewByIdx ===
    // revisionCountIdx + 1` adjacency check. The Topic Key /
    // Revision Count adjacency above stays rigid (those are paired by
    // this issue and never separated by future inserts); the
    // Revision Count → Review By relationship loosens to "precedes"
    // because Phase 1 explicitly contemplates additional scalars
    // landing between them.
    const keys = Object.keys(memoriesProperties("p-ds", "t-ds", "m-ds"))
    const revisionCountIdx = keys.indexOf("Revision Count")
    const reviewByIdx = keys.indexOf("Review By")
    expect(revisionCountIdx).toBeLessThan(reviewByIdx)
  })
})

describe("buildMemoryProps — topicKey emission (0.9.0/01)", () => {
  it("omits Topic Key when the input is undefined (leaves the column untouched on update)", () => {
    const built = buildMemoryProps({ title: "x" }) as Record<string, unknown>
    expect("Topic Key" in built).toBe(false)
  })

  it("emits a rich_text payload when topicKey is a non-empty string", () => {
    const built = buildMemoryProps({
      title: "x",
      topicKey: "decision/jwt-auth-model",
    }) as Record<string, { rich_text: Array<{ text: { content: string } }> }>
    expect(built["Topic Key"]).toEqual({
      rich_text: [{ text: { content: "decision/jwt-auth-model" } }],
    })
  })

  it("emits an empty-string rich_text payload when topicKey is the empty string", () => {
    // Empty string is structurally distinct from undefined: the agent
    // explicitly cleared the key. #14 (re-keying) reads this signal.
    const built = buildMemoryProps({ title: "x", topicKey: "" }) as Record<
      string,
      { rich_text: Array<{ text: { content: string } }> }
    >
    expect(built["Topic Key"]).toEqual({ rich_text: [{ text: { content: "" } }] })
  })
})

describe("buildMemoryProps — revisionCount emission (0.9.0/01)", () => {
  it("omits Revision Count when the input is undefined", () => {
    const built = buildMemoryProps({ title: "x" }) as Record<string, unknown>
    expect("Revision Count" in built).toBe(false)
  })

  it("emits a number payload when revisionCount is provided", () => {
    const built = buildMemoryProps({ title: "x", revisionCount: 3 }) as Record<
      string,
      { number: number }
    >
    expect(built["Revision Count"]).toEqual({ number: 3 })
  })

  it("emits 1 verbatim — the default for fresh upserts", () => {
    const built = buildMemoryProps({ title: "x", revisionCount: 1 }) as Record<
      string,
      { number: number }
    >
    expect(built["Revision Count"]).toEqual({ number: 1 })
  })
})

describe("factsProperties — mentions Predicate option (0.8.0/07)", () => {
  it("declares `mentions` as a Predicate select option", () => {
    // The auto-emitted `mentions` predicate (0.8.0/#07) lives on the
    // same closed select column as the agent-curated relationship
    // predicates. Pin its presence so a future contributor reordering
    // or trimming the option list can't silently drop the value the
    // schema-drift migration adds to upgraded vaults. The two-arg
    // and three-arg overloads share the same select-option list
    // (the entities-aware path only adds relation columns), so one
    // pin covers both drift-detection shapes.
    const props = factsProperties("p-ds", "m-ds") as Record<
      string,
      { select: { options: Array<{ name: string; color?: string }> } }
    >
    const optionNames = props["Predicate"].select.options.map((o) => o.name)
    expect(optionNames).toContain("mentions")
  })
})
