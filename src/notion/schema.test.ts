import { describe, expect, it } from "vitest"
import { buildMemoryProps, memoriesProperties } from "./schema.js"

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

  it("collapses an empty string to date:null so an explicit clear writes through", () => {
    // Mirrors `reviewBy`'s clear-with-empty-string semantic. Notion's
    // `date` property type distinguishes `null` from absent; the empty
    // string is the agent-facing "clear this column" signal.
    const built = buildMemoryProps({ title: "x", doneAt: "" }) as Record<
      string,
      { date: { start: string } | null }
    >
    expect(built["Done At"]).toEqual({ date: null })
  })

  it("collapses null to date:null so callers using the typed `string | null` shape clear the column too", () => {
    const built = buildMemoryProps({ title: "x", doneAt: null }) as Record<
      string,
      { date: { start: string } | null }
    >
    expect(built["Done At"]).toEqual({ date: null })
  })
})
