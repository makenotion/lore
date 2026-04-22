import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import {
  findDuplicateTopicNames,
  mergeDuplicateTopics,
} from "./topic-merge.js"
import type { DatabaseRef } from "../types.js"

function topicPage(
  id: string,
  opts: {
    name: string
    projectIds?: string[]
    createdAt?: string
  }
): PageObjectResponse {
  return {
    object: "page",
    id,
    created_time: opts.createdAt ?? "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-02-01T00:00:00.000Z",
    archived: false,
    url: `https://notion.so/${id}`,
    parent: { type: "database_id", database_id: "topics-db" },
    properties: {
      Name: {
        type: "title",
        title: [{ plain_text: opts.name }],
      } as unknown,
      Project: {
        type: "relation",
        relation: (opts.projectIds ?? []).map((pid) => ({ id: pid })),
      } as unknown,
    } as PageObjectResponse["properties"],
  } as PageObjectResponse
}

function memoryPage(id: string, topicId: string): PageObjectResponse {
  return {
    object: "page",
    id,
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-02-01T00:00:00.000Z",
    archived: false,
    url: `https://notion.so/${id}`,
    parent: { type: "database_id", database_id: "memories-db" },
    properties: {
      Topic: {
        type: "relation",
        relation: [{ id: topicId }],
      } as unknown,
    } as PageObjectResponse["properties"],
  } as PageObjectResponse
}

const TOPICS_DB: DatabaseRef = {
  databaseId: "topics-db-id",
  dataSourceId: "topics-ds-id",
}

const MEMORIES_DB: DatabaseRef = {
  databaseId: "memories-db-id",
  dataSourceId: "memories-ds-id",
}

function createMockClient(opts: {
  queryResponses?: Array<{ results: PageObjectResponse[]; has_more?: boolean; next_cursor?: string | null }>
} = {}) {
  const queryMock = vi.fn()
  const responses = opts.queryResponses ?? []
  for (const r of responses) {
    queryMock.mockResolvedValueOnce({
      results: r.results,
      has_more: r.has_more ?? false,
      next_cursor: r.next_cursor ?? null,
    })
  }
  // Default: empty result for any remaining queries
  queryMock.mockResolvedValue({ results: [], has_more: false, next_cursor: null })

  return {
    pages: {
      update: vi.fn().mockResolvedValue({}),
    },
    dataSources: {
      query: queryMock,
    },
  } as unknown as Client & {
    pages: { update: ReturnType<typeof vi.fn> }
    dataSources: { query: ReturnType<typeof vi.fn> }
  }
}

describe("findDuplicateTopicNames", () => {
  it("returns empty array for a vault with no duplicates", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            topicPage("t1", { name: "auth" }),
            topicPage("t2", { name: "crypto" }),
            topicPage("t3", { name: "deployment" }),
          ],
        },
      ],
    })

    const duplicates = await findDuplicateTopicNames(client, TOPICS_DB)
    expect(duplicates).toEqual([])
  })

  it("returns one group for a pair of duplicates", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            topicPage("t1", { name: "auth", projectIds: ["p1"] }),
            topicPage("t2", { name: "auth", projectIds: ["p2"] }),
            topicPage("t3", { name: "unrelated" }),
          ],
        },
      ],
    })

    const duplicates = await findDuplicateTopicNames(client, TOPICS_DB)
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0].name).toBe("auth")
    expect(duplicates[0].topicIds).toEqual(["t1", "t2"])
  })

  it("groups multiple dupes of the same name together", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            topicPage("t1", { name: "auth" }),
            topicPage("t2", { name: "auth" }),
            topicPage("t3", { name: "auth" }),
          ],
        },
      ],
    })

    const duplicates = await findDuplicateTopicNames(client, TOPICS_DB)
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0].topicIds).toEqual(["t1", "t2", "t3"])
  })

  it("sorts groups alphabetically by name for deterministic output", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            topicPage("t1", { name: "zebra" }),
            topicPage("t2", { name: "zebra" }),
            topicPage("t3", { name: "alpha" }),
            topicPage("t4", { name: "alpha" }),
            topicPage("t5", { name: "mango" }),
            topicPage("t6", { name: "mango" }),
          ],
        },
      ],
    })

    const duplicates = await findDuplicateTopicNames(client, TOPICS_DB)
    expect(duplicates.map((d) => d.name)).toEqual(["alpha", "mango", "zebra"])
  })

  it("paginates through multi-page results", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [topicPage("t1", { name: "auth" })],
          has_more: true,
          next_cursor: "cursor-1",
        },
        {
          results: [topicPage("t2", { name: "auth" })],
        },
      ],
    })

    const duplicates = await findDuplicateTopicNames(client, TOPICS_DB)
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0].topicIds).toEqual(["t1", "t2"])
  })

  it("stops after one page when has_more is false even if next_cursor is non-null", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            topicPage("t1", { name: "auth" }),
            topicPage("t2", { name: "auth" }),
          ],
          has_more: false,
          next_cursor: "stale-cursor",
        },
      ],
    })

    const duplicates = await findDuplicateTopicNames(client, TOPICS_DB)

    expect(duplicates).toHaveLength(1)
    expect(client.dataSources.query).toHaveBeenCalledTimes(1)
  })
})

describe("mergeDuplicateTopics", () => {
  it("returns empty array for empty input (no-op)", async () => {
    const client = createMockClient()
    const results = await mergeDuplicateTopics(client, TOPICS_DB, MEMORIES_DB, [])
    expect(results).toEqual([])
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("merges a duplicate pair: unions projectIds, re-points memories, archives loser", async () => {
    const canonical = topicPage("t1", {
      name: "auth",
      projectIds: ["p1"],
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    const loser = topicPage("t2", {
      name: "auth",
      projectIds: ["p2"],
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    const client = createMockClient({
      queryResponses: [
        // Query 1: listTopicPagesByName for "auth" (merge group lookup)
        { results: [canonical, loser] },
        // Query 2: listMemoryIdsByTopic for loser (t2)
        { results: [memoryPage("m1", "t2"), memoryPage("m2", "t2")] },
      ],
    })

    const results = await mergeDuplicateTopics(client, TOPICS_DB, MEMORIES_DB, [
      { name: "auth", topicIds: ["t1", "t2"] },
    ])

    expect(results).toHaveLength(1)
    const result = results[0]
    expect(result.name).toBe("auth")
    expect(result.canonicalId).toBe("t1")
    expect(result.canonicalProjectIds).toEqual(["p1", "p2"])
    expect(result.reassignedMemoryIds).toEqual(["m1", "m2"])
    expect(result.archivedIds).toEqual(["t2"])

    const updates = client.pages.update.mock.calls.map((c: unknown[]) => c[0])
    // Expected calls, in order:
    // 1. Extend canonical's Project relation
    // 2. Re-point memory m1
    // 3. Re-point memory m2
    // 4. Archive loser t2
    expect(updates).toHaveLength(4)

    expect(updates[0]).toEqual({
      page_id: "t1",
      properties: { Project: { relation: [{ id: "p1" }, { id: "p2" }] } },
    })
    expect(updates[1]).toEqual({
      page_id: "m1",
      properties: { Topic: { relation: [{ id: "t1" }] } },
    })
    expect(updates[2]).toEqual({
      page_id: "m2",
      properties: { Topic: { relation: [{ id: "t1" }] } },
    })
    expect(updates[3]).toEqual({ page_id: "t2", archived: true })
  })

  it("picks oldest created_time as canonical regardless of input id order", async () => {
    const newer = topicPage("tA", {
      name: "auth",
      projectIds: ["p2"],
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    const older = topicPage("tB", {
      name: "auth",
      projectIds: ["p1"],
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    const client = createMockClient({
      queryResponses: [
        { results: [newer, older] }, // arbitrary order from Notion
        { results: [] }, // no memories referencing the loser
      ],
    })

    const results = await mergeDuplicateTopics(client, TOPICS_DB, MEMORIES_DB, [
      { name: "auth", topicIds: ["tA", "tB"] },
    ])

    expect(results[0].canonicalId).toBe("tB") // older wins
    expect(results[0].archivedIds).toEqual(["tA"])
  })

  it("skips the Project update when canonical already has every project", async () => {
    const canonical = topicPage("t1", {
      name: "auth",
      projectIds: ["p1", "p2"],
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    const loser = topicPage("t2", {
      name: "auth",
      projectIds: ["p2"], // subset of canonical
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    const client = createMockClient({
      queryResponses: [
        { results: [canonical, loser] },
        { results: [] }, // no memories referencing loser
      ],
    })

    await mergeDuplicateTopics(client, TOPICS_DB, MEMORIES_DB, [
      { name: "auth", topicIds: ["t1", "t2"] },
    ])

    const updates = client.pages.update.mock.calls.map((c: unknown[]) => c[0])
    // Only the archive call — no Project update needed.
    expect(updates).toHaveLength(1)
    expect(updates[0]).toEqual({ page_id: "t2", archived: true })
  })

  it("handles a 3-way duplicate by archiving both losers and unioning all projects", async () => {
    const canonical = topicPage("t1", {
      name: "gRPC",
      projectIds: ["p1"],
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    const loser1 = topicPage("t2", {
      name: "gRPC",
      projectIds: ["p2"],
      createdAt: "2026-02-01T00:00:00.000Z",
    })
    const loser2 = topicPage("t3", {
      name: "gRPC",
      projectIds: ["p3"],
      createdAt: "2026-03-01T00:00:00.000Z",
    })
    const client = createMockClient({
      queryResponses: [
        { results: [canonical, loser1, loser2] },
        { results: [] }, // loser1 memories
        { results: [] }, // loser2 memories
      ],
    })

    const results = await mergeDuplicateTopics(client, TOPICS_DB, MEMORIES_DB, [
      { name: "gRPC", topicIds: ["t1", "t2", "t3"] },
    ])

    expect(results[0].canonicalProjectIds).toEqual(["p1", "p2", "p3"])
    expect(results[0].archivedIds).toEqual(["t2", "t3"])
  })

  it("returns null for a group that resolves to a single match (race: other migrate already ran)", async () => {
    const client = createMockClient({
      queryResponses: [
        { results: [topicPage("t1", { name: "auth" })] }, // only one match now
      ],
    })

    const results = await mergeDuplicateTopics(client, TOPICS_DB, MEMORIES_DB, [
      { name: "auth", topicIds: ["t1"] },
    ])

    expect(results).toEqual([])
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("listTopicPagesByName stops when has_more is false even if next_cursor is non-null", async () => {
    const canonical = topicPage("t1", {
      name: "auth",
      projectIds: ["p1"],
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    const loser = topicPage("t2", {
      name: "auth",
      projectIds: ["p2"],
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    const client = createMockClient({
      queryResponses: [
        {
          results: [canonical, loser],
          has_more: false,
          next_cursor: "stale-cursor",
        },
        { results: [] }, // listMemoryIdsByTopic — no memories on loser
      ],
    })

    await mergeDuplicateTopics(client, TOPICS_DB, MEMORIES_DB, [
      { name: "auth", topicIds: ["t1", "t2"] },
    ])

    // 1 call for the name-scan + 1 call for the loser's memory list = 2 total.
    // If the has_more gate is missing, the name-scan would issue a second
    // query on "stale-cursor", bumping the count to 3.
    expect(client.dataSources.query).toHaveBeenCalledTimes(2)
  })

  it("listMemoryIdsByTopic stops when has_more is false even if next_cursor is non-null", async () => {
    const canonical = topicPage("t1", {
      name: "auth",
      projectIds: ["p1"],
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    const loser = topicPage("t2", {
      name: "auth",
      projectIds: ["p2"],
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    const client = createMockClient({
      queryResponses: [
        { results: [canonical, loser] }, // name-scan, default termination
        {
          results: [memoryPage("m1", "t2")],
          has_more: false,
          next_cursor: "stale-cursor",
        },
      ],
    })

    await mergeDuplicateTopics(client, TOPICS_DB, MEMORIES_DB, [
      { name: "auth", topicIds: ["t1", "t2"] },
    ])

    expect(client.dataSources.query).toHaveBeenCalledTimes(2)
  })
})
