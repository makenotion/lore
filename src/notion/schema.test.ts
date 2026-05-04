import { describe, expect, it } from "vitest"
import {
  buildEntityProps,
  buildFactProps,
  buildMemoryProps,
  COMPARE_NOTES_MAX_CHARS,
  ENTITY_PROPS,
  entitiesProperties,
  FACT_PROPS,
  factsProperties,
  MEMORY_PROPS,
  memoriesProperties,
  memoriesSelfRelationProperties,
  PROJECT_PROPS,
  projectsProperties,
  TOPIC_PROPS,
  topicsProperties,
} from "./schema.js"

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

describe("memoriesProperties — Compare Notes column (0.9.0/02)", () => {
  it("declares Compare Notes as a rich_text column on the fresh-vault config", () => {
    const props = memoriesProperties("p-ds", "t-ds", "m-ds")
    expect(props["Compare Notes"]).toEqual({ rich_text: {} })
  })

  it("declares Compare Notes on the legacy-vault (no self-relation) shape too", () => {
    // The two-arg overload is what `verifyVaultDatabases` uses on a vault
    // that pre-dates self-relations. The column ships in both shapes so a
    // legacy vault running `lore migrate` surfaces the missing column on
    // the same code path as a fresh `lore init`.
    const props = memoriesProperties("p-ds", "t-ds")
    expect(props["Compare Notes"]).toEqual({ rich_text: {} })
  })

  it("places Compare Notes between Confidence Score and Review By", () => {
    // The 0.9.0 spec orders the scalar cluster as `Confidence Score →
    // Topic Key → Revision Count → Compare Notes → Review By`. #01
    // (Topic Key + Revision Count) and #02 (Compare Notes) are
    // independent PRs against the same scalar block; this test pins
    // the boundaries (after Confidence Score, before Review By) but
    // not the exact `+1` adjacency, so a #160-vs-#161 merge order
    // doesn't churn whichever PR lands second. The schema comment in
    // `schema.ts` documents the full cluster ordering for the
    // late-merger.
    const keys = Object.keys(memoriesProperties("p-ds", "t-ds", "m-ds"))
    const confidenceScoreIdx = keys.indexOf("Confidence Score")
    const compareNotesIdx = keys.indexOf("Compare Notes")
    const reviewByIdx = keys.indexOf("Review By")
    expect(compareNotesIdx).toBeGreaterThan(confidenceScoreIdx)
    expect(compareNotesIdx).toBeLessThan(reviewByIdx)
  })
})

describe("memoriesProperties / memoriesSelfRelationProperties — Compared With self-relation (0.9.0/02)", () => {
  it("declares Compared With as a single_property self-relation on the three-arg shape", () => {
    const props = memoriesProperties("p-ds", "t-ds", "m-ds")
    expect(props["Compared With"]).toEqual({
      relation: {
        single_property: {},
        data_source_id: "m-ds",
      },
    })
  })

  it("does NOT declare Compared With on the legacy two-arg shape (self-relations require the DS id)", () => {
    // Self-relations cannot reference a data source that doesn't yet
    // exist, so the two-arg overload — used during fresh-vault creation
    // before the Memories DS has an id — must omit them. `Supersedes`
    // and `Affects` follow the same pattern; Compared With must too.
    const props = memoriesProperties("p-ds", "t-ds")
    expect("Compared With" in props).toBe(false)
    expect("Supersedes" in props).toBe(false)
    expect("Affects" in props).toBe(false)
  })

  it("declares Compared With as a single_property self-relation on memoriesSelfRelationProperties", () => {
    // memoriesSelfRelationProperties is the second-step patch path used
    // by createVaultDatabases — the post-creation patch that adds
    // Supersedes / Affects / Compared With once the Memories DS id is
    // known. Drift detection on a vault upgraded from <0.9.0 picks up
    // the missing column through this shape.
    const props = memoriesSelfRelationProperties("m-ds")
    expect(props["Compared With"]).toEqual({
      relation: {
        single_property: {},
        data_source_id: "m-ds",
      },
    })
  })

  it("keeps Supersedes and Affects as single_property in the same shape — Compared With matches the convention", () => {
    // Sanity-pin: if a future contributor flips Compared With to
    // dual_property without flipping the others, the symmetric-write
    // contract documented for #05 silently breaks.
    const props = memoriesSelfRelationProperties("m-ds")
    expect(props["Supersedes"]).toEqual({
      relation: { single_property: {}, data_source_id: "m-ds" },
    })
    expect(props["Affects"]).toEqual({
      relation: { single_property: {}, data_source_id: "m-ds" },
    })
    expect(props["Compared With"]).toEqual({
      relation: { single_property: {}, data_source_id: "m-ds" },
    })
  })
})

describe("buildMemoryProps — comparedWith + compareNotes emission (0.9.0/02)", () => {
  it("omits both columns when both inputs are undefined", () => {
    const built = buildMemoryProps({ title: "x" }) as Record<string, unknown>
    expect("Compared With" in built).toBe(false)
    expect("Compare Notes" in built).toBe(false)
  })

  it("emits a relation for comparedWith with one entry per memory id", () => {
    const built = buildMemoryProps({
      title: "x",
      comparedWith: ["page-a", "page-b"],
    }) as Record<string, { relation: { id: string }[] }>
    expect(built["Compared With"]).toEqual({
      relation: [{ id: "page-a" }, { id: "page-b" }],
    })
  })

  it("emits an empty relation when comparedWith is the empty array (clears the cell)", () => {
    // Mirrors how supersedesIds + affectsIds behave: an empty array is a
    // deliberate write that wipes the relation, distinct from `undefined`
    // which leaves the column untouched.
    const built = buildMemoryProps({
      title: "x",
      comparedWith: [],
    }) as Record<string, { relation: { id: string }[] }>
    expect(built["Compared With"]).toEqual({ relation: [] })
  })

  it("emits a single text sub-block for a short compareNotes string (under 1900 chars)", () => {
    const ndjson = '{"verdict":"scoped","target":"page-a"}'
    const built = buildMemoryProps({
      title: "x",
      compareNotes: ndjson,
    }) as Record<string, { rich_text: { type: "text"; text: { content: string } }[] }>
    expect(built["Compare Notes"]).toEqual({
      rich_text: [{ type: "text", text: { content: ndjson } }],
    })
  })

  it("chunks a long compareNotes string into multiple text sub-blocks (≤1900 chars each)", () => {
    // The simple-write path (a single text block with the full content)
    // would fail Notion's per-block 2000-char ceiling. Routing through
    // `encodeCompareNotesRichText` produces the chunked payload that
    // any audit trail past ~13 entries needs.
    const longNotes = "a".repeat(3000)
    const built = buildMemoryProps({
      title: "x",
      compareNotes: longNotes,
    }) as Record<string, { rich_text: { text: { content: string } }[] }>
    const chunks = built["Compare Notes"].rich_text
    expect(chunks).toHaveLength(2)
    expect(chunks[0].text.content).toHaveLength(1900)
    expect(chunks[1].text.content).toHaveLength(1100)
  })

  it("emits an empty rich_text array when compareNotes is the empty string (explicit clear)", () => {
    // `""` is distinct from `undefined`. Empty-string emits the
    // encoder's empty-array shape so the simple-write and chunked
    // paths agree on what "clear" looks like — a future caller diffing
    // the property write payloads sees one shape regardless of which
    // path produced it. Notion accepts `rich_text: []` as cell-clear.
    const built = buildMemoryProps({
      title: "x",
      compareNotes: "",
    }) as Record<string, { rich_text: unknown[] }>
    expect(built["Compare Notes"]).toEqual({ rich_text: [] })
  })

  it("throws when compareNotes exceeds COMPARE_NOTES_MAX_CHARS (chokepoint cap reaches buildMemoryProps)", () => {
    // The cap is enforced at the encoder, which `buildMemoryProps`
    // routes through. A caller passing an over-cap string here gets
    // the same overflow error that `appendCompareNote` would throw —
    // there is no path that produces an over-cap rich_text payload.
    const overCap = "a".repeat(COMPARE_NOTES_MAX_CHARS + 1)
    expect(() => buildMemoryProps({ title: "x", compareNotes: overCap })).toThrow(
      /Compare Notes overflow/,
    )
  })
})

describe("projectIds shared `?.length` gate across builders", () => {
  // `buildMemoryProps`, `buildFactProps`, and `buildEntityProps` all gate
  // the Project relation write on `input.projectIds?.length`. Pin the
  // empty-vs-undefined contract at the source-of-truth layer here, not
  // just at one consumer's call-site test, so a future refactor that
  // changes the gate (e.g. to `!== undefined`) trips a single shared
  // assertion instead of leaving two of three builders silently emitting
  // empty `relation: []` payloads.

  it("buildMemoryProps: undefined projectIds omits Project property", () => {
    const built = buildMemoryProps({ title: "x" }) as Record<string, unknown>
    expect(built).not.toHaveProperty("Project")
  })

  it("buildMemoryProps: empty array omits Project property (same as undefined)", () => {
    const built = buildMemoryProps({ title: "x", projectIds: [] }) as Record<
      string,
      unknown
    >
    expect(built).not.toHaveProperty("Project")
  })

  it("buildFactProps: undefined projectIds omits Project property", () => {
    const built = buildFactProps({
      subject: "s",
      predicate: "uses",
      object: "o",
    }) as Record<string, unknown>
    expect(built).not.toHaveProperty("Project")
  })

  it("buildFactProps: empty array omits Project property", () => {
    const built = buildFactProps({
      subject: "s",
      predicate: "uses",
      object: "o",
      projectIds: [],
    }) as Record<string, unknown>
    expect(built).not.toHaveProperty("Project")
  })

  it("buildEntityProps: undefined projectIds omits Project property", () => {
    const built = buildEntityProps({ name: "Foo" }) as Record<string, unknown>
    expect(built).not.toHaveProperty("Project")
  })

  it("buildEntityProps: empty array omits Project property", () => {
    const built = buildEntityProps({ name: "Foo", projectIds: [] }) as Record<
      string,
      unknown
    >
    expect(built).not.toHaveProperty("Project")
  })

  it("buildEntityProps: populated array writes the Project relation verbatim", () => {
    const built = buildEntityProps({
      name: "Foo",
      projectIds: ["a", "b"],
    }) as Record<string, unknown>
    expect(built.Project).toEqual({ relation: [{ id: "a" }, { id: "b" }] })
  })
})

describe("factsProperties — mentions Predicate option (0.8.0/07)", () => {
  it("declares `mentions` as a Predicate select option", () => {
    // The auto-emitted `mentions` predicate (0.8.0/#07) lives on the
    // same closed select column as the agent-curated relationship
    // predicates. Pin its presence so a future contributor reordering
    // or trimming the option list can't silently drop the value the
    // schema-drift migration adds to upgraded vaults.
    const props = factsProperties("p-ds", "m-ds", "e-ds") as Record<
      string,
      { select: { options: Array<{ name: string; color?: string }> } }
    >
    const optionNames = props["Predicate"].select.options.map((o) => o.name)
    expect(optionNames).toContain("mentions")
  })
})

describe("factsProperties — required Entity relations", () => {
  it("always declares SubjectEntity and ObjectEntity against the Entities data source", () => {
    const props = factsProperties("p-ds", "m-ds", "e-ds")

    expect(props["SubjectEntity"]).toEqual({
      relation: {
        single_property: {},
        data_source_id: "e-ds",
      },
    })
    expect(props["ObjectEntity"]).toEqual({
      relation: {
        single_property: {},
        data_source_id: "e-ds",
      },
    })
  })
})

describe("memoriesProperties — Status select options (issue #281)", () => {
  it("registers every MemoryStatus literal so recordReview's select.name writes never reference a missing option", () => {
    // `MemoryService.recordReview` writes `Status: { select: { name:
    // "accepted" } }` / `"rejected"` and validates pre-write against
    // `MemoryStatus === "proposed"`. If a future schema rename
    // dropped `accepted` / `rejected` / `proposed` from the option
    // list, the writes would fail at the Notion API with no
    // type-level signal at compile time. Pin every option so the
    // schema and the `MemoryStatus` union stay in lockstep.
    const props = memoriesProperties("p-ds", "t-ds", "m-ds")
    const statusProp = props["Status"] as
      | { select: { options: Array<{ name: string; color?: string }> } }
      | undefined
    expect(statusProp).toBeDefined()
    const optionNames = statusProp!.select.options.map((o) => o.name)
    expect(optionNames).toEqual(
      expect.arrayContaining([
        "informational",
        "proposed",
        "accepted",
        "superseded",
        "deprecated",
        "rejected",
      ]),
    )
  })
})

describe("*_PROPS constants match the schema-builder definitions (issue #482)", () => {
  // The PR introducing *_PROPS centralized the property-name strings so a
  // future rename would be caught by TypeScript at every call site. That
  // protection only holds if the *_PROPS values stay aligned with what the
  // builder functions actually emit. A rename made *only* in the constant
  // (without updating the schema shape) would leave both halves silently
  // disagreeing — the very failure mode the PR exists to prevent. These
  // tests turn that drift from impossible-to-mistype into impossible-to-
  // merge. Compare every constant value against the keys the corresponding
  // builder writes, in BOTH directions: every constant maps to a real
  // schema column AND every schema column has a constant.
  const SCENARIOS = [
    {
      name: "PROJECT_PROPS / projectsProperties",
      constantValues: new Set<string>(Object.values(PROJECT_PROPS)),
      schemaKeys: new Set(Object.keys(projectsProperties)),
    },
    {
      name: "TOPIC_PROPS / topicsProperties",
      constantValues: new Set<string>(Object.values(TOPIC_PROPS)),
      schemaKeys: new Set(Object.keys(topicsProperties("p-ds"))),
    },
    {
      name: "MEMORY_PROPS / memoriesProperties (with self-relations)",
      constantValues: new Set<string>(Object.values(MEMORY_PROPS)),
      // The self-relation columns (Supersedes / Affects / Compared With)
      // only land when memoriesProperties is called with `memoriesDsId`
      // — pass it so the comparison covers the full vault shape.
      schemaKeys: new Set(Object.keys(memoriesProperties("p-ds", "t-ds", "m-ds"))),
    },
    {
      name: "ENTITY_PROPS / entitiesProperties",
      constantValues: new Set<string>(Object.values(ENTITY_PROPS)),
      schemaKeys: new Set(Object.keys(entitiesProperties("p-ds", "m-ds"))),
    },
    {
      name: "FACT_PROPS / factsProperties",
      constantValues: new Set<string>(Object.values(FACT_PROPS)),
      schemaKeys: new Set(Object.keys(factsProperties("p-ds", "m-ds", "e-ds"))),
    },
  ]

  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: every constant value maps to a schema column`, () => {
      const orphanConstants = [...scenario.constantValues].filter(
        (value) => !scenario.schemaKeys.has(value),
      )
      expect(orphanConstants).toEqual([])
    })

    it(`${scenario.name}: every schema column has a constant`, () => {
      const orphanColumns = [...scenario.schemaKeys].filter(
        (key) => !scenario.constantValues.has(key),
      )
      expect(orphanColumns).toEqual([])
    })
  }

  it("MEMORY_PROPS covers the self-relation-only properties (memoriesSelfRelationProperties)", () => {
    // memoriesSelfRelationProperties is the patch-in-after-creation shape
    // for the Memories DB's self-relation columns. Its keys must be a
    // subset of MEMORY_PROPS — every self-relation patch points at a
    // column that the consolidated `memoriesProperties` shape also writes.
    const selfRelKeys = new Set(Object.keys(memoriesSelfRelationProperties("m-ds")))
    const memoryConstantValues = new Set<string>(Object.values(MEMORY_PROPS))
    const orphans = [...selfRelKeys].filter((k) => !memoryConstantValues.has(k))
    expect(orphans).toEqual([])
  })
})
