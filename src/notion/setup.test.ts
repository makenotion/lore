import { describe, expect, it } from "vitest"
import { computeSelectOptionDiff } from "./setup.js"

describe("computeSelectOptionDiff", () => {
  it("returns null for non-select property types", () => {
    const live = { type: "title", title: {} }
    const expected = { title: {} }
    expect(computeSelectOptionDiff("Title", live, expected)).toBeNull()
  })

  it("returns null for rich_text properties", () => {
    const live = { rich_text: {} }
    const expected = { rich_text: {} }
    expect(computeSelectOptionDiff("Author", live, expected)).toBeNull()
  })

  it("returns null for date properties", () => {
    const live = { date: {} }
    const expected = { date: {} }
    expect(computeSelectOptionDiff("Review By", live, expected)).toBeNull()
  })

  it("returns null when live and expected have the same select options", () => {
    const live = {
      select: {
        options: [
          { id: "1", name: "note", color: "default" },
          { id: "2", name: "decision", color: "blue" },
        ],
      },
    }
    const expected = {
      select: {
        options: [
          { name: "note", color: "default" },
          { name: "decision", color: "blue" },
        ],
      },
    }
    expect(computeSelectOptionDiff("Kind", live, expected)).toBeNull()
  })

  it("detects new select options missing from live", () => {
    const live = {
      select: {
        options: [
          { id: "1", name: "is_a", color: "blue" },
          { id: "2", name: "uses", color: "yellow" },
        ],
      },
    }
    const expected = {
      select: {
        options: [
          { name: "is_a", color: "blue" },
          { name: "uses", color: "yellow" },
          { name: "decided_by", color: "blue" },
          { name: "informs", color: "pink" },
        ],
      },
    }

    const diff = computeSelectOptionDiff("Predicate", live, expected)
    expect(diff).not.toBeNull()
    expect(diff!.property).toBe("Predicate")
    expect(diff!.newOptions).toEqual(["decided_by", "informs"])
  })

  it("preserves live option IDs in the merged output", () => {
    const live = {
      select: {
        options: [
          { id: "abc-123", name: "note", color: "default" },
          { id: "def-456", name: "decision", color: "blue" },
        ],
      },
    }
    const expected = {
      select: {
        options: [
          { name: "note", color: "default" },
          { name: "decision", color: "blue" },
          { name: "incident", color: "red" },
        ],
      },
    }

    const diff = computeSelectOptionDiff("Kind", live, expected)
    expect(diff).not.toBeNull()
    const merged = diff!.mergedProperty.select as { options: Array<{ id?: string; name: string }> }
    expect(merged.options).toEqual([
      { id: "abc-123", name: "note", color: "default" },
      { id: "def-456", name: "decision", color: "blue" },
      { name: "incident", color: "red" },
    ])
  })

  it("handles multi_select properties the same way", () => {
    const live = {
      multi_select: {
        options: [{ id: "tag-1", name: "urgent", color: "red" }],
      },
    }
    const expected = {
      multi_select: {
        options: [
          { name: "urgent", color: "red" },
          { name: "archived", color: "gray" },
        ],
      },
    }

    const diff = computeSelectOptionDiff("Tags", live, expected)
    expect(diff).not.toBeNull()
    expect(diff!.newOptions).toEqual(["archived"])
    const merged = diff!.mergedProperty.multi_select as {
      options: Array<{ id?: string; name: string }>
    }
    expect(merged.options[0]).toEqual({ id: "tag-1", name: "urgent", color: "red" })
    expect(merged.options[1]).toEqual({ name: "archived", color: "gray" })
  })

  it("returns null when types mismatch (live select vs expected multi_select)", () => {
    const live = { select: { options: [{ id: "1", name: "x" }] } }
    const expected = { multi_select: { options: [{ name: "x" }, { name: "y" }] } }
    expect(computeSelectOptionDiff("X", live, expected)).toBeNull()
  })

  it("handles empty live options (property exists but has no options yet)", () => {
    const live = { multi_select: { options: [] } }
    const expected = {
      multi_select: {
        options: [
          { name: "a", color: "red" },
          { name: "b", color: "blue" },
        ],
      },
    }
    const diff = computeSelectOptionDiff("Tags", live, expected)
    expect(diff).not.toBeNull()
    expect(diff!.newOptions).toEqual(["a", "b"])
  })

  it("handles live with an options array but expected with no options", () => {
    const live = { select: { options: [{ id: "1", name: "a" }] } }
    const expected = { select: { options: [] } }
    expect(computeSelectOptionDiff("X", live, expected)).toBeNull()
  })

  it("handles malformed live input gracefully (no options array)", () => {
    const live = { select: {} }
    const expected = { select: { options: [{ name: "a" }] } }
    const diff = computeSelectOptionDiff("X", live, expected)
    expect(diff).not.toBeNull()
    expect(diff!.newOptions).toEqual(["a"])
  })

  it("is idempotent: re-applying the merged result produces no new diff", () => {
    const live = {
      select: {
        options: [{ id: "1", name: "a", color: "red" }],
      },
    }
    const expected = {
      select: {
        options: [
          { name: "a", color: "red" },
          { name: "b", color: "blue" },
        ],
      },
    }
    const diff = computeSelectOptionDiff("X", live, expected)
    expect(diff).not.toBeNull()

    // Simulate: the next run sees the merged property as the live property.
    // Notion would assign an ID to the new option, so simulate that.
    const mergedProperty = diff!.mergedProperty as {
      select: { options: Array<{ id?: string; name: string; color?: string }> }
    }
    const postApplyLive = {
      select: {
        options: mergedProperty.select.options.map((o, i) =>
          o.id ? o : { ...o, id: `new-${i}` }
        ),
      },
    }

    const reDiff = computeSelectOptionDiff("X", postApplyLive, expected)
    expect(reDiff).toBeNull()
  })
})
