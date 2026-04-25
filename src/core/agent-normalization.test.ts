/**
 * Tests for the agent-identity normalization migration (PF3-02).
 *
 * Pins the scan + apply contract: skip-empty, skip-archived, idempotent
 * over canonical input, and exact `pages.update` shape on rewrite. A
 * regression here would either re-fragment the Agent column on a
 * post-migration vault or stomp explicit third-party Agent strings.
 */
import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import {
  findNormalizableAgents,
  normalizeAgents,
} from "./agent-normalization.js"
import type { DatabaseRef } from "../types.js"

function memoryPage(overrides: {
  id: string
  agent: string
  archived?: boolean
}): PageObjectResponse {
  return {
    object: "page",
    id: overrides.id,
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-02-01T00:00:00.000Z",
    archived: overrides.archived ?? false,
    url: `https://notion.so/${overrides.id}`,
    parent: { type: "database_id", database_id: "memories-db" },
    properties: {
      Agent: {
        type: "rich_text",
        rich_text:
          overrides.agent.length > 0
            ? [{ plain_text: overrides.agent }]
            : [],
      } as unknown,
    } as PageObjectResponse["properties"],
  } as PageObjectResponse
}

function createMockClient(
  pages: PageObjectResponse[],
): Client & {
  pages: { update: ReturnType<typeof vi.fn> }
  dataSources: { query: ReturnType<typeof vi.fn> }
} {
  const queryMock = vi.fn().mockResolvedValue({
    results: pages,
    has_more: false,
    next_cursor: null,
  })
  return {
    pages: { update: vi.fn().mockResolvedValue({}) },
    dataSources: { query: queryMock },
  } as unknown as Client & {
    pages: { update: ReturnType<typeof vi.fn> }
    dataSources: { query: ReturnType<typeof vi.fn> }
  }
}

const DB: DatabaseRef = {
  databaseId: "memories-db",
  dataSourceId: "memories-ds",
}

describe("findNormalizableAgents", () => {
  it("returns empty when every Agent is already canonical", async () => {
    const client = createMockClient([
      memoryPage({ id: "m1", agent: "Claude Code" }),
      memoryPage({ id: "m2", agent: "Codex" }),
    ])
    const rows = await findNormalizableAgents(client, DB)
    expect(rows).toEqual([])
  })

  it("collects every observed Mail-vault Claude variant", async () => {
    // Eight variants pulled from PF3-02's spec — pin them as a fixture so
    // any future change to the canonicalizer that misses one of these is
    // surfaced as a test failure here, not as silent fragmentation in
    // production.
    const variants = [
      "Claude Code",
      "claude-code",
      "Claude Opus 4.7 (1M context)",
      "Claude Code (Opus 4.7)",
      "claude-opus-4.7",
      "claude-opus-4-7",
      "claude-code-opus-4-7",
      "Claude Opus 4.7",
    ]
    const client = createMockClient(
      variants.map((agent, i) => memoryPage({ id: `m${i}`, agent })),
    )
    const rows = await findNormalizableAgents(client, DB)
    // The literal `"Claude Code"` row is already canonical and stays out.
    // All other variants need a rewrite.
    expect(rows.map((r) => r.rawAgent).sort()).toEqual(
      variants.filter((v) => v !== "Claude Code").sort(),
    )
    for (const row of rows) {
      expect(row.canonicalAgent).toBe("Claude Code")
    }
  })

  it("skips archived memories", async () => {
    const client = createMockClient([
      memoryPage({ id: "m1", agent: "claude-code", archived: true }),
      memoryPage({ id: "m2", agent: "claude-code" }),
    ])
    const rows = await findNormalizableAgents(client, DB)
    expect(rows.map((r) => r.id)).toEqual(["m2"])
  })

  it("skips memories whose Agent is empty (Codex pre-PF1-04 sessions)", async () => {
    const client = createMockClient([
      memoryPage({ id: "m1", agent: "" }),
      memoryPage({ id: "m2", agent: "claude-code" }),
    ])
    const rows = await findNormalizableAgents(client, DB)
    expect(rows.map((r) => r.id)).toEqual(["m2"])
  })

  it("leaves explicit third-party Agent strings unchanged", async () => {
    const client = createMockClient([
      memoryPage({ id: "m1", agent: "Codex" }),
      memoryPage({ id: "m2", agent: "Cline" }),
      memoryPage({ id: "m3", agent: "Cursor" }),
    ])
    const rows = await findNormalizableAgents(client, DB)
    expect(rows).toEqual([])
  })

  it("paginates through every cursor page", async () => {
    const queryMock = vi
      .fn()
      .mockResolvedValueOnce({
        results: [memoryPage({ id: "m1", agent: "claude-code" })],
        has_more: true,
        next_cursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        results: [memoryPage({ id: "m2", agent: "Claude Opus 4.7" })],
        has_more: false,
        next_cursor: null,
      })
    const client = {
      pages: { update: vi.fn() },
      dataSources: { query: queryMock },
    } as unknown as Client

    const rows = await findNormalizableAgents(client, DB)
    expect(queryMock).toHaveBeenCalledTimes(2)
    expect(rows.map((r) => r.id).sort()).toEqual(["m1", "m2"])
  })

  it("returns rows in deterministic order (canonical → raw → id)", async () => {
    const client = createMockClient([
      memoryPage({ id: "m2", agent: "claude-code" }),
      memoryPage({ id: "m1", agent: "claude-code" }),
      memoryPage({ id: "m3", agent: "Claude Opus 4.7" }),
    ])
    const rows = await findNormalizableAgents(client, DB)
    // Canonical bucket is identical (`Claude Code`), so the secondary sort
    // is by raw — and `localeCompare` ranks `"Claude Opus 4.7"` before
    // `"claude-code"` because the space at position 6 sorts ahead of the
    // hyphen at the same position under default en-US collation. The two
    // `claude-code` rows tie on raw, so id breaks the tie (m1 before m2).
    // What this test pins is *deterministic* order — the exact collation
    // doesn't matter as long as two runs over the same input agree.
    expect(rows.map((r) => r.id)).toEqual(["m3", "m1", "m2"])
  })
})

describe("normalizeAgents", () => {
  it("rewrites every flagged row when not a dry run", async () => {
    const client = createMockClient([
      memoryPage({ id: "m1", agent: "claude-code" }),
      memoryPage({ id: "m2", agent: "Claude Opus 4.7" }),
    ])

    const report = await normalizeAgents(client, DB, { dryRun: false })

    expect(report.encoded).toHaveLength(2)
    expect(report.fixes).toHaveLength(2)
    expect(client.pages.update).toHaveBeenCalledTimes(2)
    // Verify the wire shape: rich_text with a single text node, content
    // = canonical form. A regression to `title` or `select` here would
    // break Notion's property-type contract.
    const [firstCall] = client.pages.update.mock.calls
    expect(firstCall[0]).toMatchObject({
      page_id: expect.any(String),
      properties: {
        Agent: { rich_text: [{ text: { content: "Claude Code" } }] },
      },
    })
  })

  it("issues no writes on dry-run but still surfaces the plan", async () => {
    const client = createMockClient([
      memoryPage({ id: "m1", agent: "claude-code" }),
    ])

    const report = await normalizeAgents(client, DB, { dryRun: true })

    expect(report.encoded).toHaveLength(1)
    expect(report.fixes).toEqual([])
    expect(report.errors).toEqual([])
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("continues past a per-row failure and accumulates the error", async () => {
    // Notion's rate limiter or a transient 5xx can fail one row out of
    // many. The pass must surface that failure without aborting the
    // remaining rewrites — operators retry the failed subset on a
    // subsequent run.
    const client = createMockClient([
      memoryPage({ id: "m-good", agent: "claude-code" }),
      memoryPage({ id: "m-bad", agent: "Claude Opus 4.7" }),
      memoryPage({ id: "m-also-good", agent: "claude-opus-4.7" }),
    ])
    client.pages.update.mockImplementation(async (args: { page_id: string }) => {
      if (args.page_id === "m-bad") {
        throw new Error("simulated rate limit")
      }
      return {}
    })

    const report = await normalizeAgents(client, DB, { dryRun: false })

    expect(report.encoded).toHaveLength(3)
    expect(report.fixes.map((f) => f.id).sort()).toEqual(["m-also-good", "m-good"])
    expect(report.errors).toEqual([
      { id: "m-bad", message: "simulated rate limit" },
    ])
    // Every row still attempted — a regression that bailed out at the
    // first error would only show one update call.
    expect(client.pages.update).toHaveBeenCalledTimes(3)
  })

  it("is idempotent: a second run finds zero rows after the first applies", async () => {
    // Round 1: fragmented vault → some rows rewritten.
    const round1 = createMockClient([
      memoryPage({ id: "m1", agent: "claude-code" }),
      memoryPage({ id: "m2", agent: "Codex" }),
    ])
    const r1 = await normalizeAgents(round1, DB, { dryRun: false })
    expect(r1.fixes).toHaveLength(1)

    // Round 2: emulate the post-migration vault state. The previously-
    // fragmented row now carries the canonical form; the explicit
    // third-party row is untouched. The pass must report nothing to do.
    const round2 = createMockClient([
      memoryPage({ id: "m1", agent: "Claude Code" }),
      memoryPage({ id: "m2", agent: "Codex" }),
    ])
    const r2 = await normalizeAgents(round2, DB, { dryRun: false })
    expect(r2.encoded).toEqual([])
    expect(r2.fixes).toEqual([])
    expect(round2.pages.update).not.toHaveBeenCalled()
  })
})
