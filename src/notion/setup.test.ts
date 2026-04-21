import { describe, expect, it } from "vitest"
import { computeRelationConfigDiff, computeSelectOptionDiff } from "./setup.js"

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

describe("computeRelationConfigDiff", () => {
  it("returns null for non-relation properties", () => {
    expect(computeRelationConfigDiff("Name", { title: {} }, { title: {} })).toBeNull()
    expect(
      computeRelationConfigDiff("Kind", { select: {} }, { select: {} })
    ).toBeNull()
    expect(
      computeRelationConfigDiff("Author", { rich_text: {} }, { rich_text: {} })
    ).toBeNull()
  })

  it("returns null when both sides are already dual_property", () => {
    const live = {
      type: "relation",
      relation: {
        database_id: "db-1",
        data_source_id: "ds-1",
        type: "dual_property",
        dual_property: { synced_property_id: "x", synced_property_name: "Back" },
      },
    }
    const expected = {
      relation: { dual_property: {}, data_source_id: "ds-1" },
    }
    expect(computeRelationConfigDiff("Project", live, expected)).toBeNull()
  })

  it("returns null when both sides are already single_property", () => {
    const live = {
      type: "relation",
      relation: {
        database_id: "db-1",
        data_source_id: "ds-1",
        type: "single_property",
        single_property: {},
      },
    }
    const expected = {
      relation: { single_property: {}, data_source_id: "ds-1" },
    }
    expect(computeRelationConfigDiff("Project", live, expected)).toBeNull()
  })

  it("detects single_property → dual_property drift", () => {
    const live = {
      type: "relation",
      relation: {
        database_id: "db-1",
        data_source_id: "projects-ds",
        type: "single_property",
        single_property: {},
      },
    }
    const expected = {
      relation: { dual_property: {}, data_source_id: "projects-ds" },
    }

    const diff = computeRelationConfigDiff("Project", live, expected)
    expect(diff).not.toBeNull()
    expect(diff!.property).toBe("Project")
    expect(diff!.liveType).toBe("single_property")
    expect(diff!.expectedType).toBe("dual_property")
  })

  it("detects dual_property → single_property drift symmetrically", () => {
    const live = {
      type: "relation",
      relation: {
        database_id: "db-1",
        data_source_id: "projects-ds",
        type: "dual_property",
        dual_property: { synced_property_id: "x", synced_property_name: "Back" },
      },
    }
    const expected = {
      relation: { single_property: {}, data_source_id: "projects-ds" },
    }

    const diff = computeRelationConfigDiff("Project", live, expected)
    expect(diff).not.toBeNull()
    expect(diff!.liveType).toBe("dual_property")
    expect(diff!.expectedType).toBe("single_property")
  })

  it("passes the live data_source_id through verbatim in the update payload", () => {
    const live = {
      type: "relation",
      relation: {
        database_id: "db-1",
        data_source_id: "live-ds-id",
        type: "single_property",
        single_property: {},
      },
    }
    const expected = {
      relation: { dual_property: {}, data_source_id: "live-ds-id" },
    }

    const diff = computeRelationConfigDiff("Project", live, expected)
    expect(diff).not.toBeNull()
    const rel = (diff!.updatePayload as { relation: { data_source_id: string } })
      .relation
    expect(rel.data_source_id).toBe("live-ds-id")
  })

  it("emits an empty dual_property object (no forced synced name)", () => {
    const live = {
      type: "relation",
      relation: {
        database_id: "db-1",
        data_source_id: "ds-1",
        type: "single_property",
        single_property: {},
      },
    }
    const expected = {
      relation: { dual_property: {}, data_source_id: "ds-1" },
    }

    const diff = computeRelationConfigDiff("Project", live, expected)
    expect(diff).not.toBeNull()
    const rel = diff!.updatePayload as {
      type: "relation"
      relation: { type: string; dual_property: Record<string, unknown> }
    }
    expect(rel.type).toBe("relation")
    expect(rel.relation.type).toBe("dual_property")
    expect(rel.relation.dual_property).toEqual({})
  })

  it("returns null when live and expected data_source_ids differ (out of scope)", () => {
    const live = {
      type: "relation",
      relation: {
        database_id: "db-1",
        data_source_id: "ds-old",
        type: "single_property",
        single_property: {},
      },
    }
    const expected = {
      relation: { dual_property: {}, data_source_id: "ds-new" },
    }
    expect(computeRelationConfigDiff("Project", live, expected)).toBeNull()
  })

  it("is idempotent: after applying the upgrade, re-computing produces null", () => {
    const live = {
      type: "relation",
      relation: {
        database_id: "db-1",
        data_source_id: "ds-1",
        type: "single_property",
        single_property: {},
      },
    }
    const expected = {
      relation: { dual_property: {}, data_source_id: "ds-1" },
    }

    const diff = computeRelationConfigDiff("Project", live, expected)
    expect(diff).not.toBeNull()

    // Simulate: Notion has applied the upgrade, so the live response now shows
    // dual_property with an auto-assigned synced_property_name.
    const postApplyLive = {
      type: "relation",
      relation: {
        database_id: "db-1",
        data_source_id: "ds-1",
        type: "dual_property",
        dual_property: {
          synced_property_id: "auto-id",
          synced_property_name: "Related to Topics (Project)",
        },
      },
    }
    expect(computeRelationConfigDiff("Project", postApplyLive, expected)).toBeNull()
  })
})
