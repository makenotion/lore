import type { Client, PageObjectResponse } from "@notionhq/client"
import { describe, expect, it, vi } from "vitest"
import { MEMORY_PROPS } from "../notion/schema.js"
import type { DatabaseRef } from "../types.js"
import { migrateAgentDiaryMemories } from "./agent-diary-migration.js"

const memories: DatabaseRef = {
  databaseId: "memories-db",
  dataSourceId: "memories-ds",
}

function page(
  id: string,
  options: {
    title?: string
    source?: string
    kind?: string | null
    status?: string | null
    archived?: boolean
  } = {}
): PageObjectResponse {
  return {
    object: "page",
    id,
    archived: options.archived ?? false,
    created_time: "2026-05-01T00:00:00.000Z",
    last_edited_time: "2026-05-01T00:00:00.000Z",
    url: `https://notion.so/${id}`,
    parent: { type: "data_source_id", data_source_id: memories.dataSourceId },
    properties: {
      [MEMORY_PROPS.TITLE]: {
        type: "title",
        title: [{ plain_text: options.title ?? id }],
      } as unknown,
      [MEMORY_PROPS.SOURCE]: {
        type: "select",
        select: { name: options.source ?? "agent_diary" },
      } as unknown,
      [MEMORY_PROPS.KIND]: {
        type: "select",
        select:
          options.kind === undefined
            ? null
            : options.kind === null
              ? null
              : { name: options.kind },
      } as unknown,
      [MEMORY_PROPS.STATUS]: {
        type: "select",
        select:
          options.status === undefined
            ? null
            : options.status === null
              ? null
              : { name: options.status },
      } as unknown,
    } as PageObjectResponse["properties"],
  } as PageObjectResponse
}

function makeClient(pages: PageObjectResponse[]): {
  client: Client
  query: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
} {
  const query = vi.fn(async () => ({
    results: pages,
    has_more: false,
    next_cursor: null,
  }))
  const update = vi.fn(async () => ({}))
  return {
    client: {
      dataSources: { query },
      pages: { update },
    } as unknown as Client,
    query,
    update,
  }
}

describe("migrateAgentDiaryMemories", () => {
  it("audits rows without writing in dry-run mode", async () => {
    const { client, query, update } = makeClient([
      page("null-kind", { title: "Null kind", kind: null, status: "informational" }),
      page("already", { title: "Already rejected", kind: null, status: "rejected" }),
      page("note", { title: "Genuine note", kind: "note", status: "accepted" }),
      page("decision", { title: "Decision row", kind: "decision", status: "accepted" }),
      page("archived", { kind: null, archived: true }),
    ])

    const result = await migrateAgentDiaryMemories({
      client,
      memories,
      sampleLimit: 1,
    })

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        data_source_id: memories.dataSourceId,
        filter: {
          property: MEMORY_PROPS.SOURCE,
          select: { equals: "agent_diary" },
        },
      })
    )
    expect(update).not.toHaveBeenCalled()
    expect(result.mode).toBe("dry-run")
    expect(result.total).toBe(4)
    expect(result.rejectNullKind.map((row) => row.id)).toEqual(["null-kind"])
    expect(result.alreadyRejectedNullKind.map((row) => row.id)).toEqual(["already"])
    expect(result.resourceNotes.map((row) => row.id)).toEqual(["note"])
    expect(result.manualReview.map((row) => row.id)).toEqual(["decision"])
    expect(result.samples.rejectNullKind.map((row) => row.id)).toEqual(["null-kind"])
  })

  it("applies idempotent status and source updates", async () => {
    const { client, update } = makeClient([
      page("null-kind", { kind: null, status: "informational" }),
      page("already", { kind: null, status: "rejected" }),
      page("note", { kind: "note", status: "accepted" }),
      page("runbook", { kind: "runbook", status: "accepted" }),
    ])

    const result = await migrateAgentDiaryMemories({
      client,
      memories,
      apply: true,
    })

    expect(result.applied).toMatchObject({
      rejected: 1,
      resourced: 1,
      failures: [],
    })
    expect(update).toHaveBeenCalledTimes(2)
    expect(update).toHaveBeenCalledWith({
      page_id: "null-kind",
      properties: {
        [MEMORY_PROPS.STATUS]: { select: { name: "rejected" } },
      },
    })
    expect(update).toHaveBeenCalledWith({
      page_id: "note",
      properties: {
        [MEMORY_PROPS.SOURCE]: { select: { name: "conversation" } },
      },
    })
  })

  it("paginates through all live source=agent_diary rows", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        results: [
          page("first", { kind: null, status: "informational" }),
          page("archived", { kind: null, archived: true }),
        ],
        has_more: true,
        next_cursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        results: [page("second", { kind: "note", status: "accepted" })],
        has_more: false,
        next_cursor: null,
      })
    const client = {
      dataSources: { query },
      pages: { update: vi.fn(async () => ({})) },
    } as unknown as Client

    const result = await migrateAgentDiaryMemories({ client, memories })

    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ start_cursor: "cursor-2" })
    )
    expect(result.total).toBe(2)
    expect(result.rejectNullKind.map((row) => row.id)).toEqual(["first"])
    expect(result.resourceNotes.map((row) => row.id)).toEqual(["second"])
  })

  it("records update failures and continues applying other rows", async () => {
    const { client, update } = makeClient([
      page("null-kind", { kind: null, status: "informational" }),
      page("note", { kind: "note", status: "accepted" }),
    ])
    update.mockImplementation(async (args: { page_id: string }) => {
      if (args.page_id === "null-kind") throw new Error("notion 503")
      return {}
    })

    const result = await migrateAgentDiaryMemories({
      client,
      memories,
      apply: true,
    })

    expect(result.applied.rejected).toBe(0)
    expect(result.applied.resourced).toBe(1)
    expect(result.applied.failures).toEqual([
      expect.objectContaining({
        id: "null-kind",
        action: "reject-null-kind",
        message: "notion 503",
      }),
    ])
  })
})
