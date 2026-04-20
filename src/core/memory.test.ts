import { describe, expect, it } from "vitest"
import type { PageObjectResponse } from "@notionhq/client"
import { pageToMemory } from "./memory.js"

/**
 * Build a synthetic `PageObjectResponse` with only the properties listed.
 * Everything else is omitted — mirrors how pre-migration pages look to the
 * Notion API (missing columns simply don't appear in `properties`).
 */
function buildPage(
  properties: Record<string, unknown>,
  overrides: Partial<PageObjectResponse> = {}
): PageObjectResponse {
  return {
    object: "page",
    id: "page-id-123",
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-02-01T00:00:00.000Z",
    archived: false,
    properties: properties as PageObjectResponse["properties"],
    parent: { type: "database_id", database_id: "db-id" },
    url: "https://notion.so/page-id-123",
    ...overrides,
  } as PageObjectResponse
}

describe("pageToMemory — backward compatibility with pre-migration pages", () => {
  it("returns safe defaults for every new field when all new properties are absent", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Old note" }] },
      Project: { type: "relation", relation: [] },
      Topic: { type: "relation", relation: [] },
      Source: { type: "select", select: { name: "manual" } },
      Author: { type: "rich_text", rich_text: [] },
      Agent: { type: "rich_text", rich_text: [] },
      Tags: { type: "multi_select", multi_select: [] },
      Session: { type: "rich_text", rich_text: [] },
    })

    const memory = pageToMemory(page, "body content")

    expect(memory.title).toBe("Old note")
    expect(memory.source).toBe("manual")

    // Every new field must default gracefully:
    expect(memory.kind).toBe("note")
    expect(memory.status).toBe("informational")
    expect(memory.confidence).toBe("certain")
    expect(memory.reviewBy).toBeNull()
    expect(memory.decidedAt).toBeNull()
    expect(memory.supersedesIds).toEqual([])
    expect(memory.affectsIds).toEqual([])
    expect(memory.alternatives).toBe("")
    expect(memory.consequences).toBe("")
    expect(memory.content).toBe("body content")
  })

  it("does not throw when the properties object is completely empty", () => {
    const page = buildPage({})
    expect(() => pageToMemory(page)).not.toThrow()

    const memory = pageToMemory(page)
    expect(memory.title).toBe("")
    expect(memory.projectIds).toEqual([])
    expect(memory.topicId).toBeNull()
    expect(memory.source).toBe("manual")
    expect(memory.kind).toBe("note")
    expect(memory.status).toBe("informational")
    expect(memory.confidence).toBe("certain")
    expect(memory.content).toBe("")
  })
})

describe("pageToMemory — fully populated decision page", () => {
  it("extracts every new field correctly when all properties are present", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Use DecisionService" }] },
      Project: {
        type: "relation",
        relation: [{ id: "proj-1" }, { id: "proj-2" }],
      },
      Topic: { type: "relation", relation: [{ id: "topic-1" }] },
      Source: { type: "select", select: { name: "conversation" } },
      Kind: { type: "select", select: { name: "decision" } },
      Status: { type: "select", select: { name: "accepted" } },
      Confidence: { type: "select", select: { name: "likely" } },
      "Review By": { type: "date", date: { start: "2026-10-20" } },
      "Decided At": { type: "date", date: { start: "2026-04-20" } },
      Supersedes: { type: "relation", relation: [{ id: "old-decision" }] },
      Affects: {
        type: "relation",
        relation: [{ id: "affected-1" }, { id: "affected-2" }],
      },
      Alternatives: {
        type: "rich_text",
        rich_text: [{ plain_text: "Alt A; Alt B" }],
      },
      Consequences: {
        type: "rich_text",
        rich_text: [{ plain_text: "Must migrate extractors" }],
      },
      Author: { type: "rich_text", rich_text: [{ plain_text: "hsalman" }] },
      Agent: { type: "rich_text", rich_text: [{ plain_text: "claude" }] },
      Tags: {
        type: "multi_select",
        multi_select: [{ name: "architecture" }, { name: "core" }],
      },
      Session: { type: "rich_text", rich_text: [{ plain_text: "sess-42" }] },
    })

    const memory = pageToMemory(page, "Rationale prose.")

    expect(memory.title).toBe("Use DecisionService")
    expect(memory.projectIds).toEqual(["proj-1", "proj-2"])
    expect(memory.topicId).toBe("topic-1")
    expect(memory.source).toBe("conversation")
    expect(memory.kind).toBe("decision")
    expect(memory.status).toBe("accepted")
    expect(memory.confidence).toBe("likely")
    expect(memory.reviewBy).toBe("2026-10-20")
    expect(memory.decidedAt).toBe("2026-04-20")
    expect(memory.supersedesIds).toEqual(["old-decision"])
    expect(memory.affectsIds).toEqual(["affected-1", "affected-2"])
    expect(memory.alternatives).toBe("Alt A; Alt B")
    expect(memory.consequences).toBe("Must migrate extractors")
    expect(memory.author).toBe("hsalman")
    expect(memory.agent).toBe("claude")
    expect(memory.tags).toEqual(["architecture", "core"])
    expect(memory.session).toBe("sess-42")
    expect(memory.content).toBe("Rationale prose.")
  })
})

describe("pageToMemory — partial migration (mixed defaults + real values)", () => {
  it("handles a page that has Kind but not Status (intermediate migration state)", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Half-migrated" }] },
      Kind: { type: "select", select: { name: "runbook" } },
      // Status intentionally absent
    })

    const memory = pageToMemory(page)
    expect(memory.kind).toBe("runbook")
    expect(memory.status).toBe("informational") // default kicks in
    expect(memory.confidence).toBe("certain")
  })

  it("handles a page with Status: null select (column exists, no value chosen)", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Status-cleared" }] },
      Kind: { type: "select", select: { name: "decision" } },
      Status: { type: "select", select: null },
    })

    const memory = pageToMemory(page)
    expect(memory.kind).toBe("decision")
    expect(memory.status).toBe("informational") // null select → fallback
  })

  it("handles a page where date properties exist but are unset", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Dateless" }] },
      "Review By": { type: "date", date: null },
      "Decided At": { type: "date", date: null },
    })

    const memory = pageToMemory(page)
    expect(memory.reviewBy).toBeNull()
    expect(memory.decidedAt).toBeNull()
  })
})
