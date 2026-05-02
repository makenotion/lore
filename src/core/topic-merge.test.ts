import { describe, expect, it, vi } from "vitest"
import type {
  Client,
  GetPagePropertyResponse,
  PageObjectResponse,
} from "@notionhq/client"
import {
  findDuplicateTopicNames,
  findEncodedTopicNames,
  findPostDecodeTopicCollisions,
  findSimilarTopicGroups,
  fixTopicEncoding,
  mergeDuplicateTopics,
  mergeSimilarTopics,
  mergeTopicsByAliasPlans,
  validateTopicAliasMergePlans,
} from "./topic-merge.js"
import type { DatabaseRef } from "../types.js"

function topicPage(
  id: string,
  opts: {
    name: string
    projectIds?: string[]
    projectHasMore?: boolean
    projectPropertyId?: string
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
        id: opts.projectPropertyId ?? "project",
        type: "relation",
        relation: (opts.projectIds ?? []).map((pid) => ({ id: pid })),
        has_more: opts.projectHasMore,
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

function relationPropertyResponse(ids: string[]): GetPagePropertyResponse {
  return {
    object: "list",
    type: "property_item",
    property_item: {
      id: "project",
      type: "relation",
      relation: {},
      next_url: null,
    },
    results: ids.map((id) => ({
      object: "property_item",
      id: "project",
      type: "relation",
      relation: { id },
    })),
    has_more: false,
    next_cursor: null,
  } as GetPagePropertyResponse
}

const TOPICS_DB: DatabaseRef = {
  databaseId: "topics-db-id",
  dataSourceId: "topics-ds-id",
}

const MEMORIES_DB: DatabaseRef = {
  databaseId: "memories-db-id",
  dataSourceId: "memories-ds-id",
}

function createMockClient(
  opts: {
    queryResponses?: Array<{
      results: PageObjectResponse[]
      has_more?: boolean
      next_cursor?: string | null
    }>
    propertyRetrieveResponses?: GetPagePropertyResponse[]
  } = {}
) {
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

  // Canonical-creation tests need a deterministic id for each created row.
  // Mint one per call so a merge creating two canonicals can assert both.
  let createSeq = 0
  const createMock = vi.fn().mockImplementation(async () => ({
    object: "page",
    id: `created-${++createSeq}`,
    created_time: "2026-04-01T00:00:00.000Z",
    last_edited_time: "2026-04-01T00:00:00.000Z",
    archived: false,
    url: `https://notion.so/created-${createSeq}`,
    parent: { type: "database_id", database_id: "topics-db" },
    properties: {},
  }))
  const propertyRetrieveMock = vi.fn()
  for (const r of opts.propertyRetrieveResponses ?? []) {
    propertyRetrieveMock.mockResolvedValueOnce(r)
  }
  propertyRetrieveMock.mockResolvedValue(relationPropertyResponse([]))

  return {
    pages: {
      update: vi.fn().mockResolvedValue({}),
      create: createMock,
      properties: { retrieve: propertyRetrieveMock },
    },
    dataSources: {
      query: queryMock,
    },
  } as unknown as Client & {
    pages: {
      update: ReturnType<typeof vi.fn>
      create: ReturnType<typeof vi.fn>
      properties: { retrieve: ReturnType<typeof vi.fn> }
    }
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
          results: [topicPage("t1", { name: "auth" }), topicPage("t2", { name: "auth" })],
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

describe("findEncodedTopicNames", () => {
  it("returns an empty array for a clean vault", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            topicPage("t1", { name: "auth" }),
            topicPage("t2", { name: "Build & Tooling" }),
          ],
        },
      ],
    })

    const encoded = await findEncodedTopicNames(client, TOPICS_DB)
    expect(encoded).toEqual([])
  })

  it("flags `&amp;` single-escape rows with their decoded form", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            topicPage("t1", { name: "Build &amp; Tooling" }),
            topicPage("t2", { name: "clean" }),
          ],
        },
      ],
    })

    const encoded = await findEncodedTopicNames(client, TOPICS_DB)
    expect(encoded).toHaveLength(1)
    expect(encoded[0]).toEqual({
      id: "t1",
      rawName: "Build &amp; Tooling",
      decodedName: "Build & Tooling",
    })
  })

  it("flags `&amp;amp;` double-escape rows with the fully-decoded form", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [topicPage("t1", { name: "Build &amp;amp; Tooling" })],
        },
      ],
    })

    const encoded = await findEncodedTopicNames(client, TOPICS_DB)
    expect(encoded).toHaveLength(1)
    expect(encoded[0].decodedName).toBe("Build & Tooling")
  })

  it("sorts results alphabetically by raw name for deterministic output", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            topicPage("t3", { name: "Observability &amp; PII" }),
            topicPage("t1", { name: "Async &amp; Concurrency" }),
            topicPage("t2", { name: "Deploy &amp; Caching" }),
          ],
        },
      ],
    })

    const encoded = await findEncodedTopicNames(client, TOPICS_DB)
    expect(encoded.map((e) => e.rawName)).toEqual([
      "Async &amp; Concurrency",
      "Deploy &amp; Caching",
      "Observability &amp; PII",
    ])
  })

  it("paginates through multi-page results", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [topicPage("t1", { name: "Build &amp; Tooling" })],
          has_more: true,
          next_cursor: "cursor-1",
        },
        {
          results: [topicPage("t2", { name: "GRDB &amp;amp; Persistence" })],
        },
      ],
    })

    const encoded = await findEncodedTopicNames(client, TOPICS_DB)
    expect(encoded).toHaveLength(2)
    expect(encoded.map((e) => e.id)).toEqual(["t1", "t2"])
  })

  it("stops when has_more is false even if next_cursor is non-null", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [topicPage("t1", { name: "Build &amp; Tooling" })],
          has_more: false,
          next_cursor: "stale-cursor",
        },
      ],
    })

    await findEncodedTopicNames(client, TOPICS_DB)
    expect(client.dataSources.query).toHaveBeenCalledTimes(1)
  })

  it("ignores empty-name rows (corrupt data, not an encoding issue)", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            topicPage("t1", { name: "" }),
            topicPage("t2", { name: "Build &amp; Tooling" }),
          ],
        },
      ],
    })

    const encoded = await findEncodedTopicNames(client, TOPICS_DB)
    expect(encoded.map((e) => e.id)).toEqual(["t2"])
  })
})

describe("fixTopicEncoding", () => {
  it("is a no-op on a clean vault", async () => {
    const client = createMockClient({
      queryResponses: [{ results: [topicPage("t1", { name: "auth" })] }],
    })

    const results = await fixTopicEncoding(client, TOPICS_DB)
    expect(results).toEqual([])
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("rewrites each encoded row's Name to the decoded form", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            topicPage("t1", { name: "Build &amp; Tooling" }),
            topicPage("t2", { name: "GRDB &amp;amp; Persistence" }),
            topicPage("t3", { name: "clean" }),
          ],
        },
      ],
    })

    const results = await fixTopicEncoding(client, TOPICS_DB)
    expect(results).toHaveLength(2)

    const updates = client.pages.update.mock.calls.map((c: unknown[]) => c[0])
    expect(updates).toHaveLength(2)
    expect(updates[0]).toEqual({
      page_id: "t1",
      properties: {
        Name: { title: [{ text: { content: "Build & Tooling" } }] },
      },
    })
    expect(updates[1]).toEqual({
      page_id: "t2",
      properties: {
        Name: { title: [{ text: { content: "GRDB & Persistence" } }] },
      },
    })
  })

  it("sets up a cross-encoding pair for the standard merger to collapse", async () => {
    // Two rows — one cleanly stored, one with `&amp;amp;` — refer to the same
    // topic. After fixTopicEncoding decodes the encoded row, the standard
    // duplicate scan finds a two-row group and mergeDuplicateTopics can
    // collapse them without needing to understand entities itself.
    const cleanRow = topicPage("t1", {
      name: "Build & Tooling",
      projectIds: ["p1"],
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    const encodedRow = topicPage("t2", {
      name: "Build &amp;amp; Tooling",
      projectIds: ["p2"],
      createdAt: "2026-06-01T00:00:00.000Z",
    })

    const client = createMockClient({
      queryResponses: [
        // findEncodedTopicNames scan.
        { results: [cleanRow, encodedRow] },
        // Post-fix findDuplicateTopicNames scan — t2 now has the decoded name.
        {
          results: [
            cleanRow,
            topicPage("t2", {
              name: "Build & Tooling",
              projectIds: ["p2"],
              createdAt: "2026-06-01T00:00:00.000Z",
            }),
          ],
        },
      ],
    })

    const encodingResults = await fixTopicEncoding(client, TOPICS_DB)
    expect(encodingResults).toHaveLength(1)
    expect(encodingResults[0].decodedName).toBe("Build & Tooling")

    const duplicates = await findDuplicateTopicNames(client, TOPICS_DB)
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0].name).toBe("Build & Tooling")
    expect(duplicates[0].topicIds).toEqual(["t1", "t2"])
  })
})

describe("findPostDecodeTopicCollisions", () => {
  it("returns empty when no cross-encoding pairs exist", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            topicPage("t1", { name: "clean-a" }),
            topicPage("t2", { name: "clean-b" }),
            // Encoded but no decoded twin — not a collision.
            topicPage("t3", { name: "Build &amp; Tooling" }),
          ],
        },
      ],
    })

    const collisions = await findPostDecodeTopicCollisions(client, TOPICS_DB)
    expect(collisions).toEqual([])
  })

  it("detects a cross-encoding pair that would collide after decoding", async () => {
    // Same conceptual topic, two rows: one clean, one still encoded. After
    // decode they'd both read "Build & Tooling" — the exact state the
    // atomicity gate is designed to forbid writing into without also
    // authorizing the merge.
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            topicPage("t1", { name: "Build & Tooling", projectIds: ["p1"] }),
            topicPage("t2", {
              name: "Build &amp; Tooling",
              projectIds: ["p2"],
            }),
          ],
        },
      ],
    })

    const collisions = await findPostDecodeTopicCollisions(client, TOPICS_DB)
    expect(collisions).toHaveLength(1)
    // Group is keyed by the DECODED name (what the canonical will hold
    // after the merge), not the raw form of either row.
    expect(collisions[0].name).toBe("Build & Tooling")
    expect(collisions[0].topicIds).toEqual(["t1", "t2"])
  })

  it("detects groups among purely-raw duplicates that are already colliding", async () => {
    // Two rows with identical raw encoded names — a pre-existing dup group
    // that would survive decoding and still need the merge.
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            topicPage("t1", { name: "Build &amp; Tooling" }),
            topicPage("t2", { name: "Build &amp; Tooling" }),
          ],
        },
      ],
    })

    const collisions = await findPostDecodeTopicCollisions(client, TOPICS_DB)
    expect(collisions).toHaveLength(1)
    expect(collisions[0].name).toBe("Build & Tooling")
    expect(collisions[0].topicIds).toEqual(["t1", "t2"])
  })

  it("detects double-encoding collapsed to an existing clean row", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            topicPage("t1", { name: "Build & Tooling" }),
            topicPage("t2", { name: "Build &amp;amp; Tooling" }),
          ],
        },
      ],
    })

    const collisions = await findPostDecodeTopicCollisions(client, TOPICS_DB)
    expect(collisions[0].topicIds).toEqual(["t1", "t2"])
  })

  it("sorts collision groups alphabetically by decoded name", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            topicPage("t1", { name: "Zebra" }),
            topicPage("t2", { name: "Zebra" }),
            topicPage("t3", { name: "Apple &amp; Pear" }),
            topicPage("t4", { name: "Apple & Pear" }),
          ],
        },
      ],
    })

    const collisions = await findPostDecodeTopicCollisions(client, TOPICS_DB)
    expect(collisions.map((g) => g.name)).toEqual(["Apple & Pear", "Zebra"])
  })

  it("paginates through multi-page results", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [topicPage("t1", { name: "Build & Tooling" })],
          has_more: true,
          next_cursor: "cursor-1",
        },
        {
          results: [topicPage("t2", { name: "Build &amp; Tooling" })],
        },
      ],
    })

    const collisions = await findPostDecodeTopicCollisions(client, TOPICS_DB)
    expect(collisions).toHaveLength(1)
    expect(collisions[0].topicIds).toEqual(["t1", "t2"])
  })
})

describe("validateTopicAliasMergePlans", () => {
  it("accepts a well-formed single plan", () => {
    expect(() =>
      validateTopicAliasMergePlans([
        { canonical: "Build & Tooling", aliases: ["Build System", "Build tooling"] },
      ])
    ).not.toThrow()
  })

  it("rejects empty canonical", () => {
    expect(() =>
      validateTopicAliasMergePlans([{ canonical: "   ", aliases: ["x"] }])
    ).toThrow(/empty canonical/i)
  })

  it("rejects empty alias", () => {
    expect(() =>
      validateTopicAliasMergePlans([{ canonical: "A", aliases: ["valid", ""] }])
    ).toThrow(/empty alias/i)
  })

  it("rejects missing aliases", () => {
    expect(() => validateTopicAliasMergePlans([{ canonical: "A", aliases: [] }])).toThrow(
      /no aliases/i
    )
  })

  it("rejects alias equal to canonical", () => {
    expect(() =>
      validateTopicAliasMergePlans([{ canonical: "MCP", aliases: ["MCP"] }])
    ).toThrow(/equals its canonical/i)
  })

  it("rejects duplicate alias in the same plan", () => {
    expect(() =>
      validateTopicAliasMergePlans([{ canonical: "A", aliases: ["dup", "dup"] }])
    ).toThrow(/listed twice/i)
  })

  it("rejects the same canonical in two plans", () => {
    expect(() =>
      validateTopicAliasMergePlans([
        { canonical: "A", aliases: ["x"] },
        { canonical: "A", aliases: ["y"] },
      ])
    ).toThrow(/more than one merge plan/i)
  })

  it("rejects the same alias appearing in two plans with different canonicals", () => {
    expect(() =>
      validateTopicAliasMergePlans([
        { canonical: "A", aliases: ["shared"] },
        { canonical: "B", aliases: ["shared"] },
      ])
    ).toThrow(/appears in plans for both/i)
  })

  it("rejects a canonical that is also an alias in another plan", () => {
    expect(() =>
      validateTopicAliasMergePlans([
        { canonical: "A", aliases: ["B"] },
        { canonical: "B", aliases: ["c"] },
      ])
    ).toThrow(/canonical in its own plan but an alias/i)
  })
})

describe("mergeTopicsByAliasPlans", () => {
  it("is a no-op when no alias rows exist, whether or not canonical exists", async () => {
    const client = createMockClient({
      queryResponses: [
        // canonical lookup
        { results: [topicPage("t1", { name: "MCP", projectIds: ["p1"] })] },
        // alias "MCP Tools" lookup — empty
        { results: [] },
      ],
    })

    const results = await mergeTopicsByAliasPlans(client, TOPICS_DB, MEMORIES_DB, [
      { canonical: "MCP", aliases: ["MCP Tools"] },
    ])

    expect(results).toHaveLength(1)
    expect(results[0].noop).toBe(true)
    expect(results[0].canonicalId).toBe("t1")
    expect(results[0].canonicalCreated).toBe(false)
    expect(results[0].archivedAliases).toEqual([])
    expect(results[0].reassignedMemoryIds).toEqual([])
    expect(results[0].unmatchedAliases).toEqual(["MCP Tools"])
    expect(client.pages.update).not.toHaveBeenCalled()
    expect(client.pages.create).not.toHaveBeenCalled()
  })

  it("merges a pair: unions projects, re-points memories, archives alias row", async () => {
    const canonical = topicPage("t1", {
      name: "Build & Tooling",
      projectIds: ["p1"],
    })
    const alias = topicPage("t2", {
      name: "Build System",
      projectIds: ["p2"],
    })
    const client = createMockClient({
      queryResponses: [
        { results: [canonical] }, // canonical lookup
        { results: [alias] }, // alias "Build System" lookup
        { results: [memoryPage("m1", "t2"), memoryPage("m2", "t2")] }, // memories under alias
      ],
    })

    const results = await mergeTopicsByAliasPlans(client, TOPICS_DB, MEMORIES_DB, [
      { canonical: "Build & Tooling", aliases: ["Build System"] },
    ])

    expect(results).toHaveLength(1)
    const result = results[0]
    expect(result.noop).toBe(false)
    expect(result.canonicalId).toBe("t1")
    expect(result.canonicalCreated).toBe(false)
    expect(result.canonicalProjectIds).toEqual(["p1", "p2"])
    expect(result.archivedAliases).toEqual([{ name: "Build System", id: "t2" }])
    expect(result.reassignedMemoryIds).toEqual(["m1", "m2"])
    expect(result.unmatchedAliases).toEqual([])

    const updates = client.pages.update.mock.calls.map((c: unknown[]) => c[0])
    expect(updates).toEqual([
      // union Project onto canonical
      {
        page_id: "t1",
        properties: { Project: { relation: [{ id: "p1" }, { id: "p2" }] } },
      },
      // re-point m1 and m2
      { page_id: "m1", properties: { Topic: { relation: [{ id: "t1" }] } } },
      { page_id: "m2", properties: { Topic: { relation: [{ id: "t1" }] } } },
      // archive the alias row
      { page_id: "t2", archived: true },
    ])
  })

  it("skips the Project update when the canonical already has every alias project", async () => {
    const canonical = topicPage("t1", {
      name: "MCP",
      projectIds: ["p1", "p2"],
    })
    const alias = topicPage("t2", {
      name: "MCP Tools",
      projectIds: ["p2"], // subset
    })
    const client = createMockClient({
      queryResponses: [
        { results: [canonical] },
        { results: [alias] },
        { results: [] }, // no memories under alias
      ],
    })

    await mergeTopicsByAliasPlans(client, TOPICS_DB, MEMORIES_DB, [
      { canonical: "MCP", aliases: ["MCP Tools"] },
    ])

    const updates = client.pages.update.mock.calls.map((c: unknown[]) => c[0])
    // Just the archive call — no project union needed.
    expect(updates).toEqual([{ page_id: "t2", archived: true }])
  })

  it("creates the canonical row when it doesn't exist, with the project union", async () => {
    const alias = topicPage("t2", {
      name: "Old Name",
      projectIds: ["p1", "p2"],
    })
    const client = createMockClient({
      queryResponses: [
        { results: [] }, // canonical "New Name" does not exist
        { results: [alias] },
        { results: [memoryPage("m1", "t2")] },
      ],
    })

    const results = await mergeTopicsByAliasPlans(client, TOPICS_DB, MEMORIES_DB, [
      { canonical: "New Name", aliases: ["Old Name"] },
    ])

    expect(results[0].canonicalCreated).toBe(true)
    expect(results[0].canonicalId).toBe("created-1")
    expect(results[0].canonicalProjectIds).toEqual(["p1", "p2"])
    expect(results[0].reassignedMemoryIds).toEqual(["m1"])
    expect(results[0].archivedAliases).toEqual([{ name: "Old Name", id: "t2" }])

    expect(client.pages.create).toHaveBeenCalledTimes(1)
    expect(client.pages.create).toHaveBeenCalledWith({
      parent: { type: "database_id", database_id: "topics-db-id" },
      properties: expect.objectContaining({
        Name: { title: [{ text: { content: "New Name" } }] },
        Project: { relation: [{ id: "p1" }, { id: "p2" }] },
      }),
    })

    // Memory should point at the newly-minted canonical id, not the alias.
    const memoryUpdate = client.pages.update.mock.calls
      .map((c: unknown[]) => c[0] as { page_id: string })
      .find((u) => u.page_id === "m1")
    expect(memoryUpdate).toEqual({
      page_id: "m1",
      properties: { Topic: { relation: [{ id: "created-1" }] } },
    })
  })

  it("collects unmatched aliases alongside matched ones", async () => {
    const canonical = topicPage("t1", { name: "MCP", projectIds: ["p1"] })
    const matched = topicPage("t2", { name: "MCP Tools", projectIds: ["p1"] })
    const client = createMockClient({
      queryResponses: [
        { results: [canonical] },
        { results: [matched] }, // "MCP Tools" matches
        { results: [] }, // "MCP tool layout" does not
        { results: [] }, // memories under matched
      ],
    })

    const results = await mergeTopicsByAliasPlans(client, TOPICS_DB, MEMORIES_DB, [
      { canonical: "MCP", aliases: ["MCP Tools", "MCP tool layout"] },
    ])

    expect(results[0].noop).toBe(false)
    expect(results[0].archivedAliases).toEqual([{ name: "MCP Tools", id: "t2" }])
    expect(results[0].unmatchedAliases).toEqual(["MCP tool layout"])
  })

  it("merges multiple aliases with multiple rows each onto the same canonical", async () => {
    const canonical = topicPage("t1", { name: "Outlook Sync", projectIds: ["p1"] })
    const aliasAa = topicPage("t2", { name: "Outlook", projectIds: ["p2"] })
    const aliasAb = topicPage("t3", { name: "Outlook", projectIds: ["p3"] }) // duplicate same-name
    const aliasB = topicPage("t4", { name: "Outlook Import", projectIds: ["p4"] })
    const client = createMockClient({
      queryResponses: [
        { results: [canonical] },
        { results: [aliasAa, aliasAb] }, // two rows for "Outlook"
        { results: [aliasB] },
        { results: [memoryPage("m1", "t2")] },
        { results: [memoryPage("m2", "t3")] },
        { results: [memoryPage("m3", "t4")] },
      ],
    })

    const results = await mergeTopicsByAliasPlans(client, TOPICS_DB, MEMORIES_DB, [
      { canonical: "Outlook Sync", aliases: ["Outlook", "Outlook Import"] },
    ])

    expect(results[0].canonicalProjectIds).toEqual(["p1", "p2", "p3", "p4"])
    expect(results[0].archivedAliases).toEqual([
      { name: "Outlook", id: "t2" },
      { name: "Outlook", id: "t3" },
      { name: "Outlook Import", id: "t4" },
    ])
    expect(results[0].reassignedMemoryIds).toEqual(["m1", "m2", "m3"])
  })

  it("throws when the canonical has more than one row", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [topicPage("t1", { name: "MCP" }), topicPage("t2", { name: "MCP" })],
        },
      ],
    })

    await expect(
      mergeTopicsByAliasPlans(client, TOPICS_DB, MEMORIES_DB, [
        { canonical: "MCP", aliases: ["MCP Tools"] },
      ])
    ).rejects.toThrow(/--merge-duplicate-topics/)
  })

  it("writes nothing in dry-run mode but still reports planned changes", async () => {
    const canonical = topicPage("t1", { name: "A", projectIds: ["p1"] })
    const alias = topicPage("t2", { name: "B", projectIds: ["p2"] })
    const client = createMockClient({
      queryResponses: [
        { results: [canonical] },
        { results: [alias] },
        { results: [memoryPage("m1", "t2")] },
      ],
    })

    const results = await mergeTopicsByAliasPlans(
      client,
      TOPICS_DB,
      MEMORIES_DB,
      [{ canonical: "A", aliases: ["B"] }],
      { dryRun: true }
    )

    expect(results[0].noop).toBe(false)
    expect(results[0].canonicalId).toBe("t1")
    expect(results[0].reassignedMemoryIds).toEqual(["m1"])
    expect(results[0].archivedAliases).toEqual([{ name: "B", id: "t2" }])
    expect(client.pages.update).not.toHaveBeenCalled()
    expect(client.pages.create).not.toHaveBeenCalled()
  })

  it("reports canonicalId=null in dry-run when canonical would be created", async () => {
    const alias = topicPage("t2", { name: "B", projectIds: ["p2"] })
    const client = createMockClient({
      queryResponses: [
        { results: [] }, // canonical missing
        { results: [alias] },
        { results: [memoryPage("m1", "t2")] },
      ],
    })

    const results = await mergeTopicsByAliasPlans(
      client,
      TOPICS_DB,
      MEMORIES_DB,
      [{ canonical: "Fresh Canonical", aliases: ["B"] }],
      { dryRun: true }
    )

    expect(results[0].canonicalCreated).toBe(true)
    expect(results[0].canonicalId).toBeNull()
    expect(results[0].canonicalProjectIds).toEqual(["p2"])
    expect(client.pages.create).not.toHaveBeenCalled()
  })

  it("is idempotent — a second run is a no-op", async () => {
    // Simulate the post-run state: canonical exists, alias rows are gone.
    const canonical = topicPage("t1", {
      name: "A",
      projectIds: ["p1", "p2"],
    })
    const client = createMockClient({
      queryResponses: [
        { results: [canonical] }, // canonical lookup
        { results: [] }, // alias B — already archived on first run
      ],
    })

    const results = await mergeTopicsByAliasPlans(client, TOPICS_DB, MEMORIES_DB, [
      { canonical: "A", aliases: ["B"] },
    ])

    expect(results[0].noop).toBe(true)
    expect(results[0].canonicalId).toBe("t1")
    expect(client.pages.update).not.toHaveBeenCalled()
    expect(client.pages.create).not.toHaveBeenCalled()
  })

  it("decodes HTML entities in plan names so YAML can use clean text", async () => {
    // The canonical in the YAML is `Build & Tooling` (clean) but the DB
    // row still holds `Build &amp; Tooling` (encoded, pre-P1-10). After
    // decoding on entry, the canonical lookup uses the clean form — the
    // DB lookup compares against whatever Notion stores, so this test
    // focuses on the decode behaviour via the query argument.
    const client = createMockClient({
      queryResponses: [
        { results: [] }, // canonical
        { results: [] }, // alias
      ],
    })

    await mergeTopicsByAliasPlans(client, TOPICS_DB, MEMORIES_DB, [
      { canonical: "Build &amp; Tooling", aliases: ["Build &amp; System"] },
    ])

    const queries = client.dataSources.query.mock.calls.map(
      (c: unknown[]) => c[0] as Record<string, unknown>
    )
    const filterNames = queries
      .map((q) => q.filter as { title?: { equals?: string } } | undefined)
      .filter((f) => f?.title?.equals)
      .map((f) => f!.title!.equals!)
    expect(filterNames).toContain("Build & Tooling")
    expect(filterNames).toContain("Build & System")
  })

  it("surfaces validation errors before touching Notion", async () => {
    const client = createMockClient()
    await expect(
      mergeTopicsByAliasPlans(client, TOPICS_DB, MEMORIES_DB, [
        { canonical: "A", aliases: ["A"] },
      ])
    ).rejects.toThrow(/equals its canonical/i)
    expect(client.dataSources.query).not.toHaveBeenCalled()
  })
})

describe("findSimilarTopicGroups", () => {
  it("returns empty when every distinct stored name normalizes to its own key", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            topicPage("t1", { name: "Auth" }),
            topicPage("t2", { name: "Crypto" }),
            topicPage("t3", { name: "Deployment" }),
          ],
        },
      ],
    })

    const groups = await findSimilarTopicGroups(client, TOPICS_DB)
    expect(groups).toEqual([])
  })

  it("collapses Eval & Testing siblings into one group (issue #109 repro)", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            topicPage("t1", {
              name: "Evals & Testing",
              createdAt: "2026-04-20T10:00:00.000Z",
            }),
            topicPage("t2", {
              name: "Eval & Testing",
              createdAt: "2026-04-21T10:00:00.000Z",
            }),
            topicPage("t3", {
              name: "Evals & Quality", // distinct head noun, not a sibling
              createdAt: "2026-04-22T10:00:00.000Z",
            }),
          ],
        },
      ],
    })

    const groups = await findSimilarTopicGroups(client, TOPICS_DB)
    expect(groups).toHaveLength(1)
    // Oldest row wins as canonical — deterministic across runs.
    expect(groups[0].canonicalId).toBe("t1")
    expect(groups[0].canonicalName).toBe("Evals & Testing")
    expect(groups[0].siblingIds).toEqual(["t2"])
    expect(groups[0].siblings[0].name).toBe("Eval & Testing")
  })

  it("does NOT report exact-name duplicates (those flow through findDuplicateTopicNames)", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            topicPage("t1", { name: "auth" }),
            topicPage("t2", { name: "auth" }), // exact dup
          ],
        },
      ],
    })

    const groups = await findSimilarTopicGroups(client, TOPICS_DB)
    expect(groups).toEqual([])
  })

  it("collapses HTML-encoded vs decoded sibling pair", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            topicPage("t1", {
              name: "Build & Tooling",
              createdAt: "2026-04-01T10:00:00.000Z",
            }),
            topicPage("t2", {
              name: "Build &amp; Tooling",
              createdAt: "2026-04-05T10:00:00.000Z",
            }),
          ],
        },
      ],
    })

    const groups = await findSimilarTopicGroups(client, TOPICS_DB)
    expect(groups).toHaveLength(1)
    expect(groups[0].canonicalId).toBe("t1")
    expect(groups[0].siblingIds).toEqual(["t2"])
  })

  it("sorts groups by normalized key for deterministic output", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            topicPage("t1", { name: "Zebra" }),
            topicPage("t2", { name: "zebra " }), // trailing space — normalizes to same
            topicPage("t3", { name: "Alpha" }),
            topicPage("t4", { name: "alpha." }),
          ],
        },
      ],
    })

    const groups = await findSimilarTopicGroups(client, TOPICS_DB)
    expect(groups.map((g) => g.normalizedKey)).toEqual(["alpha", "zebra"])
  })
})

describe("mergeSimilarTopics", () => {
  it("dry-run reports the plan without writing", async () => {
    const t1 = topicPage("t1", {
      name: "Evals & Testing",
      projectIds: ["p1"],
      createdAt: "2026-04-20T10:00:00.000Z",
    })
    const t2 = topicPage("t2", {
      name: "Eval & Testing",
      projectIds: ["p2"],
      createdAt: "2026-04-21T10:00:00.000Z",
    })
    const client = createMockClient({
      queryResponses: [{ results: [t1, t2] }],
    })
    // pages.retrieve returns the same rows for the apply-time refetch.
    ;(client.pages as unknown as { retrieve: ReturnType<typeof vi.fn> }).retrieve = vi
      .fn()
      .mockImplementation(async ({ page_id }: { page_id: string }) => {
        if (page_id === "t1") return t1
        if (page_id === "t2") return t2
        throw new Error(`unexpected retrieve: ${page_id}`)
      })

    const groups = await findSimilarTopicGroups(client, TOPICS_DB)
    const results = await mergeSimilarTopics(client, TOPICS_DB, MEMORIES_DB, groups, {
      dryRun: true,
    })

    expect(results).toHaveLength(1)
    expect(results[0].canonicalId).toBe("t1")
    expect(results[0].archivedIds).toEqual(["t2"])
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("apply-mode unions projects, re-points memories, archives siblings", async () => {
    const t1 = topicPage("t1", {
      name: "Evals & Testing",
      projectIds: ["p1"],
      createdAt: "2026-04-20T10:00:00.000Z",
    })
    const t2 = topicPage("t2", {
      name: "Eval & Testing",
      projectIds: ["p2"],
      createdAt: "2026-04-21T10:00:00.000Z",
    })
    const memory1 = memoryPage("mem-1", "t2")
    const memory2 = memoryPage("mem-2", "t2")

    const queryMock = vi.fn()
    queryMock
      // findSimilarTopicGroups initial scan
      .mockResolvedValueOnce({ results: [t1, t2], has_more: false, next_cursor: null })
      // listMemoryIdsByTopic for sibling t2
      .mockResolvedValueOnce({
        results: [memory1, memory2],
        has_more: false,
        next_cursor: null,
      })

    const client = {
      pages: {
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn(),
        retrieve: vi.fn().mockImplementation(async ({ page_id }: { page_id: string }) => {
          if (page_id === "t1") return t1
          if (page_id === "t2") return t2
          throw new Error(`unexpected retrieve: ${page_id}`)
        }),
      },
      dataSources: { query: queryMock },
    } as unknown as Client & {
      pages: {
        update: ReturnType<typeof vi.fn>
        retrieve: ReturnType<typeof vi.fn>
      }
      dataSources: { query: ReturnType<typeof vi.fn> }
    }

    const groups = await findSimilarTopicGroups(client, TOPICS_DB)
    const results = await mergeSimilarTopics(client, TOPICS_DB, MEMORIES_DB, groups, {
      dryRun: false,
    })

    expect(results).toHaveLength(1)
    expect(results[0].canonicalProjectIds).toEqual(["p1", "p2"])
    expect(results[0].reassignedMemoryIds).toEqual(["mem-1", "mem-2"])
    expect(results[0].archivedIds).toEqual(["t2"])

    // Writes: 1 to extend canonical's projects, 2 to re-point memories,
    // 1 to archive sibling — 4 update calls total.
    expect(client.pages.update).toHaveBeenCalledTimes(4)
  })

  it("hydrates truncated project relations before unioning similar topics", async () => {
    const t1 = topicPage("t1", {
      name: "Evals & Testing",
      projectIds: ["p1"],
      projectHasMore: true,
      createdAt: "2026-04-20T10:00:00.000Z",
    })
    const t2 = topicPage("t2", {
      name: "Eval & Testing",
      projectIds: ["p2"],
      projectHasMore: true,
      createdAt: "2026-04-21T10:00:00.000Z",
    })

    const client = createMockClient({
      queryResponses: [
        // findSimilarTopicGroups initial scan
        { results: [t1, t2] },
        // listMemoryIdsByTopic for sibling t2
        { results: [] },
      ],
      propertyRetrieveResponses: [
        relationPropertyResponse(["p1", "p3"]),
        relationPropertyResponse(["p2", "p4"]),
      ],
    })
    ;(client.pages as unknown as { retrieve: ReturnType<typeof vi.fn> }).retrieve = vi
      .fn()
      .mockImplementation(async ({ page_id }: { page_id: string }) => {
        if (page_id === "t1") return t1
        if (page_id === "t2") return t2
        throw new Error(`unexpected retrieve: ${page_id}`)
      })

    const groups = await findSimilarTopicGroups(client, TOPICS_DB)
    const results = await mergeSimilarTopics(client, TOPICS_DB, MEMORIES_DB, groups, {
      dryRun: false,
    })

    expect(results[0].canonicalProjectIds).toEqual(["p1", "p3", "p2", "p4"])
    expect(client.pages.properties.retrieve).toHaveBeenCalledTimes(2)
    expect(client.pages.update).toHaveBeenNthCalledWith(1, {
      page_id: "t1",
      properties: {
        Project: {
          relation: [{ id: "p1" }, { id: "p3" }, { id: "p2" }, { id: "p4" }],
        },
      },
    })
  })

  it("is idempotent — a second scan after apply finds no groups", async () => {
    // First-pass apply leaves the vault clean. The second scan returns
    // only the canonical (sibling is archived; apply mode normally
    // filters archived rows but the test mock doesn't simulate that —
    // the canonical alone produces no groups regardless).
    const t1 = topicPage("t1", { name: "Evals & Testing", projectIds: ["p1"] })
    const client = createMockClient({
      queryResponses: [{ results: [t1] }],
    })

    const groups = await findSimilarTopicGroups(client, TOPICS_DB)
    expect(groups).toEqual([])
  })
})
