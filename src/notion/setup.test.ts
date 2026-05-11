import { describe, expect, it } from "vitest"
import type { Client } from "@notionhq/client"
import type { Vault } from "../types.js"
import {
  computeRelationConfigDiff,
  computeSelectOptionDiff,
  ensureEntitiesDatabase,
  migrateVaultSchema,
  MissingVaultDatabasesError,
  verifyVaultDatabases,
  verifyVaultDatabasesForEntityRepair,
} from "./setup.js"
import {
  ENTITIES_DB_TITLE,
  FACTS_DB_TITLE,
  MEMORIES_DB_TITLE,
  PROJECTS_DB_TITLE,
  TOPICS_DB_TITLE,
} from "./schema.js"

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
    const merged = diff!.mergedProperty.select as {
      options: Array<{ id?: string; name: string }>
    }
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
    expect(computeRelationConfigDiff("Kind", { select: {} }, { select: {} })).toBeNull()
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
    const rel = (diff!.updatePayload as { relation: { data_source_id: string } }).relation
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

describe("MissingVaultDatabasesError", () => {
  it("redacts long vault page ids unless debug output is enabled", () => {
    const previous = process.env["LORE_DEBUG"]
    delete process.env["LORE_DEBUG"]
    try {
      const pageId = "0123456789abcdef0123456789abcdef"
      const redacted = new MissingVaultDatabasesError(pageId, ["Entities"], ["Projects"])
      expect(redacted.message).toContain("0123...cdef")
      expect(redacted.message).not.toContain(pageId)

      process.env["LORE_DEBUG"] = "1"
      const debug = new MissingVaultDatabasesError(pageId, ["Entities"], ["Projects"])
      expect(debug.message).toContain(pageId)
    } finally {
      if (previous === undefined) {
        delete process.env["LORE_DEBUG"]
      } else {
        process.env["LORE_DEBUG"] = previous
      }
    }
  })
})

/**
 * Stand-in for the SDK methods that `verifyVaultDatabases` and
 * `migrateVaultSchema` exercise. Records the maximum number of in-flight
 * retrieves so a parallel fan-out is observable: a sequential `for...of
 * await` loop drives `maxInFlight` to 1, while a `Promise.all` over N
 * retrieves drives it to N.
 */
type StartupChildBlockPage = {
  results: Array<Record<string, unknown>>
  has_more?: boolean
  next_cursor?: string | null
}

function makeStartupStub({
  childDatabases,
  childBlockPages,
  databaseProperties,
  liveProperties,
  retrieveDelayMs = 10,
}: {
  childDatabases: Array<{ id: string; title: string }>
  childBlockPages?: StartupChildBlockPage[]
  databaseProperties?: Record<string, Record<string, unknown>>
  liveProperties: Record<string, Record<string, unknown>>
  retrieveDelayMs?: number
}): {
  client: Client
  blocksChildrenListCalls: () => Array<{
    block_id: string
    page_size?: number
    start_cursor?: string
  }>
  maxInFlight: () => number
  databasesRetrieveCalls: () => string[]
  dataSourcesRetrieveCalls: () => string[]
  databaseCreateCalls: () => unknown[]
} {
  let inFlight = 0
  let maxInFlight = 0
  const blocksChildrenListCalls: Array<{
    block_id: string
    page_size?: number
    start_cursor?: string
  }> = []
  const databasesRetrieveCalls: string[] = []
  const dataSourcesRetrieveCalls: string[] = []
  const databaseCreateCalls: unknown[] = []

  const track = async <T>(value: T): Promise<T> => {
    inFlight++
    if (inFlight > maxInFlight) maxInFlight = inFlight
    await new Promise((r) => setTimeout(r, retrieveDelayMs))
    inFlight--
    return value
  }

  const stub = {
    blocks: {
      children: {
        list: async (args: {
          block_id: string
          page_size?: number
          start_cursor?: string
        }) => {
          blocksChildrenListCalls.push(args)
          if (childBlockPages) {
            return (
              childBlockPages[blocksChildrenListCalls.length - 1] ?? {
                results: [],
                has_more: false,
                next_cursor: null,
              }
            )
          }

          return {
            results: childDatabases.map((db) => ({
              type: "child_database",
              id: db.id,
              child_database: { title: db.title },
            })),
            has_more: false,
            next_cursor: null,
          }
        },
      },
    },
    databases: {
      retrieve: async (args: { database_id: string }) => {
        databasesRetrieveCalls.push(args.database_id)
        return track({
          id: args.database_id,
          data_sources: [{ id: `ds-${args.database_id}` }],
          properties: databaseProperties?.[args.database_id] ?? {},
        })
      },
      create: async (args: unknown) => {
        databaseCreateCalls.push(args)
        return {
          id: "block-created-entities",
          data_sources: [{ id: "ds-created-entities" }],
        }
      },
    },
    dataSources: {
      retrieve: async (args: { data_source_id: string }) => {
        dataSourcesRetrieveCalls.push(args.data_source_id)
        return track({ properties: liveProperties })
      },
      update: async () => ({}),
    },
  } as unknown as Client

  return {
    client: stub,
    blocksChildrenListCalls: () => blocksChildrenListCalls,
    maxInFlight: () => maxInFlight,
    databasesRetrieveCalls: () => databasesRetrieveCalls,
    dataSourcesRetrieveCalls: () => dataSourcesRetrieveCalls,
    databaseCreateCalls: () => databaseCreateCalls,
  }
}

describe("verifyVaultDatabases child block pagination", () => {
  function childDatabaseBlocks(
    childDatabases: Array<{ id: string; title: string }>
  ): Array<Record<string, unknown>> {
    return childDatabases.map((db) => ({
      type: "child_database",
      id: db.id,
      child_database: { title: db.title },
    }))
  }

  function noiseBlocks(): Array<Record<string, unknown>> {
    return Array.from({ length: 100 }, (_, i) => ({
      type: "paragraph",
      id: `note-${i}`,
    }))
  }

  function props(types: Record<string, string>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(types).map(([name, type]) => [name, { type, [type]: {} }])
    )
  }

  const memoriesFingerprint = props({
    Title: "title",
    Project: "relation",
    Topic: "relation",
    Source: "select",
    Kind: "select",
    Tags: "multi_select",
    Session: "rich_text",
  })

  it("finds vault databases after the first page of child blocks", async () => {
    const childDatabases = [
      { id: "block-projects", title: PROJECTS_DB_TITLE },
      { id: "block-topics", title: TOPICS_DB_TITLE },
      { id: "block-memories", title: MEMORIES_DB_TITLE },
      { id: "block-entities", title: ENTITIES_DB_TITLE },
      { id: "block-facts", title: FACTS_DB_TITLE },
    ]
    const { client, blocksChildrenListCalls } = makeStartupStub({
      childDatabases: [],
      childBlockPages: [
        { results: noiseBlocks(), has_more: true, next_cursor: "cursor-2" },
        {
          results: childDatabaseBlocks(childDatabases),
          has_more: false,
          next_cursor: null,
        },
      ],
      liveProperties: {},
      retrieveDelayMs: 0,
    })

    const vault = await verifyVaultDatabases(client, "page-1")

    expect(blocksChildrenListCalls()).toEqual([
      { block_id: "page-1", page_size: 100 },
      { block_id: "page-1", page_size: 100, start_cursor: "cursor-2" },
    ])
    expect(vault.databases.projects).toEqual({
      databaseId: "block-projects",
      dataSourceId: "ds-block-projects",
    })
    expect(vault.databases.entities).toEqual({
      databaseId: "block-entities",
      dataSourceId: "ds-block-entities",
    })
  })

  it("detects a renamed Lore database by schema fingerprint", async () => {
    const childDatabases = [
      { id: "block-projects", title: PROJECTS_DB_TITLE },
      { id: "block-topics", title: TOPICS_DB_TITLE },
      { id: "block-memories", title: "Memory" },
      { id: "block-entities", title: ENTITIES_DB_TITLE },
      { id: "block-facts", title: FACTS_DB_TITLE },
    ]
    const { client, databasesRetrieveCalls } = makeStartupStub({
      childDatabases,
      databaseProperties: {
        "block-memories": memoriesFingerprint,
      },
      liveProperties: {},
      retrieveDelayMs: 0,
    })

    const vault = await verifyVaultDatabases(client, "page-1")

    expect(vault.databases.memories).toEqual({
      databaseId: "block-memories",
      dataSourceId: "ds-block-memories",
    })
    expect(databasesRetrieveCalls().filter((id) => id === "block-memories")).toHaveLength(
      1
    )
  })

  it("treats renamed Lore databases as present when refusing partial init", async () => {
    const { client } = makeStartupStub({
      childDatabases: [{ id: "block-memories", title: "Memory" }],
      databaseProperties: {
        "block-memories": memoriesFingerprint,
      },
      liveProperties: {},
      retrieveDelayMs: 0,
    })

    let thrown: unknown
    try {
      await verifyVaultDatabases(client, "page-1")
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(MissingVaultDatabasesError)
    expect(thrown).toMatchObject({
      present: ["Memories"],
    })
    expect(String(thrown)).toContain("do not run 'lore init'")
  })

  it("fails when a paginated vault has no Entities DB", async () => {
    const childDatabases = [
      { id: "block-projects", title: PROJECTS_DB_TITLE },
      { id: "block-topics", title: TOPICS_DB_TITLE },
      { id: "block-memories", title: MEMORIES_DB_TITLE },
      { id: "block-facts", title: FACTS_DB_TITLE },
    ]
    const { client, blocksChildrenListCalls } = makeStartupStub({
      childDatabases: [],
      childBlockPages: [
        { results: noiseBlocks(), has_more: true, next_cursor: "cursor-2" },
        {
          results: childDatabaseBlocks(childDatabases),
          has_more: false,
          next_cursor: null,
        },
      ],
      liveProperties: {},
      retrieveDelayMs: 0,
    })

    let thrown: unknown
    try {
      await verifyVaultDatabases(client, "page-1")
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(MissingVaultDatabasesError)
    expect(thrown).toMatchObject({
      missing: ["Entities"],
      present: ["Projects", "Topics", "Memories", "Facts"],
    })
    expect(String(thrown)).toContain("missing databases: Entities")
    expect(String(thrown)).toContain("do not run 'lore init'")

    expect(blocksChildrenListCalls()).toEqual([
      { block_id: "page-1", page_size: 100 },
      { block_id: "page-1", page_size: 100, start_cursor: "cursor-2" },
    ])
  })

  it("allows the entity-repair loader to return a four-database vault", async () => {
    const childDatabases = [
      { id: "block-projects", title: PROJECTS_DB_TITLE },
      { id: "block-topics", title: TOPICS_DB_TITLE },
      { id: "block-memories", title: MEMORIES_DB_TITLE },
      { id: "block-facts", title: FACTS_DB_TITLE },
    ]
    const { client } = makeStartupStub({
      childDatabases,
      liveProperties: {},
      retrieveDelayMs: 0,
    })

    const vault = await verifyVaultDatabasesForEntityRepair(client, "page-1")

    expect(vault.databases.projects).toEqual({
      databaseId: "block-projects",
      dataSourceId: "ds-block-projects",
    })
    expect(vault.databases.entities).toBeUndefined()
  })

  it("stops paging once all expected vault databases are found", async () => {
    const childDatabases = [
      { id: "block-projects", title: PROJECTS_DB_TITLE },
      { id: "block-topics", title: TOPICS_DB_TITLE },
      { id: "block-memories", title: MEMORIES_DB_TITLE },
      { id: "block-entities", title: ENTITIES_DB_TITLE },
      { id: "block-facts", title: FACTS_DB_TITLE },
    ]
    const { client, blocksChildrenListCalls } = makeStartupStub({
      childDatabases: [],
      childBlockPages: [
        {
          results: childDatabaseBlocks(childDatabases),
          has_more: true,
          next_cursor: "cursor-2",
        },
        {
          results: noiseBlocks(),
          has_more: false,
          next_cursor: null,
        },
      ],
      liveProperties: {},
      retrieveDelayMs: 0,
    })

    await verifyVaultDatabases(client, "page-1")

    expect(blocksChildrenListCalls()).toEqual([{ block_id: "page-1", page_size: 100 }])
  })

  it("keeps paging when only Entities is still missing", async () => {
    const firstPageDatabases = [
      { id: "block-projects", title: PROJECTS_DB_TITLE },
      { id: "block-topics", title: TOPICS_DB_TITLE },
      { id: "block-memories", title: MEMORIES_DB_TITLE },
      { id: "block-facts", title: FACTS_DB_TITLE },
    ]
    const { client, blocksChildrenListCalls } = makeStartupStub({
      childDatabases: [],
      childBlockPages: [
        {
          results: childDatabaseBlocks(firstPageDatabases),
          has_more: true,
          next_cursor: "cursor-2",
        },
        {
          results: childDatabaseBlocks([
            { id: "block-entities", title: ENTITIES_DB_TITLE },
          ]),
          has_more: false,
          next_cursor: null,
        },
      ],
      liveProperties: {},
      retrieveDelayMs: 0,
    })

    const vault = await verifyVaultDatabases(client, "page-1")

    expect(blocksChildrenListCalls()).toEqual([
      { block_id: "page-1", page_size: 100 },
      { block_id: "page-1", page_size: 100, start_cursor: "cursor-2" },
    ])
    expect(vault.databases.entities).toEqual({
      databaseId: "block-entities",
      dataSourceId: "ds-block-entities",
    })
  })

  it("fails fast when Notion repeats a pagination cursor", async () => {
    const { client } = makeStartupStub({
      childDatabases: [],
      childBlockPages: [
        { results: noiseBlocks(), has_more: true, next_cursor: "cursor-2" },
        { results: noiseBlocks(), has_more: true, next_cursor: "cursor-2" },
      ],
      liveProperties: {},
      retrieveDelayMs: 0,
    })

    await expect(verifyVaultDatabases(client, "page-1")).rejects.toThrow(
      "repeated cursor cursor-2"
    )
  })

  it("fails fast when vault child block pagination exceeds the page cap", async () => {
    const { client, blocksChildrenListCalls } = makeStartupStub({
      childDatabases: [],
      childBlockPages: Array.from({ length: 100 }, (_, i) => ({
        results: noiseBlocks(),
        has_more: true,
        next_cursor: `cursor-${i}`,
      })),
      liveProperties: {},
      retrieveDelayMs: 0,
    })

    await expect(verifyVaultDatabases(client, "page-1")).rejects.toThrow(
      "exceeded 100 pages"
    )
    expect(blocksChildrenListCalls()).toHaveLength(100)
  })
})

describe("verifyVaultDatabases parallel retrieves", () => {
  it("issues every databases.retrieve call concurrently", async () => {
    const childDatabases = [
      { id: "block-projects", title: PROJECTS_DB_TITLE },
      { id: "block-topics", title: TOPICS_DB_TITLE },
      { id: "block-memories", title: MEMORIES_DB_TITLE },
      { id: "block-entities", title: ENTITIES_DB_TITLE },
      { id: "block-facts", title: FACTS_DB_TITLE },
    ]
    const { client, maxInFlight, databasesRetrieveCalls } = makeStartupStub({
      childDatabases,
      liveProperties: {},
    })

    const vault = await verifyVaultDatabases(client, "page-1")

    // The acceptance criterion is that the retrieves overlap, not that any
    // specific count is reached. A sequential loop pins maxInFlight to 1; a
    // parallel fan-out drives it past 1. (The bare stub is not wrapped in
    // `createLimitedClient`, so no concurrency cap applies; tightening to a
    // specific number would silently break if the test stub is ever wrapped.)
    expect(maxInFlight()).toBeGreaterThan(1)
    expect(databasesRetrieveCalls().sort()).toEqual([
      "block-entities",
      "block-facts",
      "block-memories",
      "block-projects",
      "block-topics",
    ])
    expect(vault.databases.projects).toEqual({
      databaseId: "block-projects",
      dataSourceId: "ds-block-projects",
    })
    expect(vault.databases.entities).toEqual({
      databaseId: "block-entities",
      dataSourceId: "ds-block-entities",
    })
  })

  it("fails before retrieving database metadata when Entities is absent", async () => {
    const childDatabases = [
      { id: "block-projects", title: PROJECTS_DB_TITLE },
      { id: "block-topics", title: TOPICS_DB_TITLE },
      { id: "block-memories", title: MEMORIES_DB_TITLE },
      { id: "block-facts", title: FACTS_DB_TITLE },
    ]
    const { client, databasesRetrieveCalls } = makeStartupStub({
      childDatabases,
      liveProperties: {},
    })

    await expect(verifyVaultDatabases(client, "page-1")).rejects.toThrow(
      "missing databases: Entities"
    )

    expect(databasesRetrieveCalls()).toEqual([])
  })
})

describe("ensureEntitiesDatabase", () => {
  const legacyVault = {
    pageId: "page-1",
    databases: {
      projects: { databaseId: "p-db", dataSourceId: "p-ds" },
      topics: { databaseId: "t-db", dataSourceId: "t-ds" },
      memories: { databaseId: "m-db", dataSourceId: "m-ds" },
      facts: { databaseId: "f-db", dataSourceId: "f-ds" },
    },
  }

  it("creates the Entities database with Projects and Memories relations", async () => {
    const { client, databaseCreateCalls } = makeStartupStub({
      childDatabases: [],
      liveProperties: {},
      retrieveDelayMs: 0,
    })

    const result = await ensureEntitiesDatabase(client, legacyVault)

    expect(result).toEqual({
      status: "created",
      ref: {
        databaseId: "block-created-entities",
        dataSourceId: "ds-created-entities",
      },
    })
    expect(databaseCreateCalls()).toHaveLength(1)
    const call = databaseCreateCalls()[0] as {
      initial_data_source: {
        properties: {
          Project: { relation: { data_source_id: string } }
          Source: { relation: { data_source_id: string } }
        }
      }
    }
    expect(call.initial_data_source.properties.Project.relation.data_source_id).toBe(
      "p-ds"
    )
    expect(call.initial_data_source.properties.Source.relation.data_source_id).toBe(
      "m-ds"
    )
  })

  it("dry-runs a missing Entities database without creating it", async () => {
    const { client, databaseCreateCalls } = makeStartupStub({
      childDatabases: [],
      liveProperties: {},
      retrieveDelayMs: 0,
    })

    await expect(
      ensureEntitiesDatabase(client, legacyVault, { dryRun: true })
    ).resolves.toEqual({ status: "would-create" })
    expect(databaseCreateCalls()).toEqual([])
  })

  it("returns the existing ref without writing when Entities already exists", async () => {
    const { client, databaseCreateCalls } = makeStartupStub({
      childDatabases: [],
      liveProperties: {},
      retrieveDelayMs: 0,
    })
    const existing = { databaseId: "e-db", dataSourceId: "e-ds" }

    await expect(
      ensureEntitiesDatabase(client, {
        ...legacyVault,
        databases: { ...legacyVault.databases, entities: existing },
      })
    ).resolves.toEqual({ status: "present", ref: existing })
    expect(databaseCreateCalls()).toEqual([])
  })
})

describe("migrateVaultSchema parallel retrieves", () => {
  function vaultFixture(): Vault {
    return {
      pageId: "page-1",
      databases: {
        projects: { databaseId: "p-db", dataSourceId: "p-ds" },
        topics: { databaseId: "t-db", dataSourceId: "t-ds" },
        memories: { databaseId: "m-db", dataSourceId: "m-ds" },
        entities: { databaseId: "e-db", dataSourceId: "e-ds" },
        facts: { databaseId: "f-db", dataSourceId: "f-ds" },
      },
    }
  }

  it("issues dataSources.retrieve concurrently across every target DB", async () => {
    // No-drift fixture: live properties are a superset, so Phase B emits no
    // updates. We only care about Phase A's fan-out shape here.
    const liveProperties: Record<string, Record<string, unknown>> = {}
    const { client, maxInFlight, dataSourcesRetrieveCalls } = makeStartupStub({
      childDatabases: [],
      liveProperties,
    })

    const diffs = await migrateVaultSchema(client, vaultFixture())

    // 5 expected DBs (projects, topics, memories, entities, facts).
    expect(dataSourcesRetrieveCalls()).toHaveLength(5)
    expect(maxInFlight()).toBeGreaterThan(1)
    // Diff order must match Object.keys(expectedByDb) enumeration order.
    // The production code follows the vault dependency order, with Facts
    // after Entities because its relation columns point at the Entities DS.
    expect(diffs.map((d) => d.database)).toEqual([
      "projects",
      "topics",
      "memories",
      "entities",
      "facts",
    ])
  })

  it("reports Confidence Score as a missing property on a pre-0.8.0 Memories DB", async () => {
    // A vault upgraded from <0.8.0 has no `Confidence Score` column on
    // Memories. The drift detector must surface the column by name so an
    // operator running `lore status` / `lore migrate` sees the nudge —
    // and a future contributor can't silently rename or drop the
    // property without this fixture failing first. Same posture as the
    // Synopsis pin from 0.7.0/01.
    const { client } = makeStartupStub({
      childDatabases: [],
      liveProperties: {},
    })

    const diffs = await migrateVaultSchema(client, vaultFixture())
    const memoriesDiff = diffs.find((d) => d.database === "memories")
    expect(memoriesDiff?.missing).toContain("Confidence Score")
  })

  it("reports Synopsis as a missing property on a pre-0.7.0 Memories DB", async () => {
    // A vault upgraded from <0.7.0 has no Synopsis column on Memories.
    // The drift detector must surface the column by name so an operator
    // running `lore status` / `lore migrate` sees the nudge — and a
    // future contributor can't silently rename or drop the property
    // without this fixture failing first.
    const { client } = makeStartupStub({
      childDatabases: [],
      liveProperties: {},
    })

    const diffs = await migrateVaultSchema(client, vaultFixture())
    const memoriesDiff = diffs.find((d) => d.database === "memories")
    expect(memoriesDiff?.missing).toContain("Synopsis")
  })

  it("surfaces Facts entity-relation columns as missing drift", async () => {
    const { client, maxInFlight, dataSourcesRetrieveCalls } = makeStartupStub({
      childDatabases: [],
      liveProperties: {},
    })

    const diffs = await migrateVaultSchema(client, vaultFixture())

    expect(dataSourcesRetrieveCalls()).toHaveLength(5)
    expect(maxInFlight()).toBeGreaterThan(1)
    const factsDiff = diffs.find((d) => d.database === "facts")
    expect(factsDiff?.missing).toEqual(
      expect.arrayContaining(["SubjectEntity", "ObjectEntity"])
    )
  })

  it("throws a clean missing-Entities error when called with a legacy vault snapshot", async () => {
    const { client, dataSourcesRetrieveCalls } = makeStartupStub({
      childDatabases: [],
      liveProperties: {},
    })
    const legacyVault = {
      pageId: "page-1",
      databases: {
        projects: { databaseId: "p-db", dataSourceId: "p-ds" },
        topics: { databaseId: "t-db", dataSourceId: "t-ds" },
        memories: { databaseId: "m-db", dataSourceId: "m-ds" },
        facts: { databaseId: "f-db", dataSourceId: "f-ds" },
      },
    } as unknown as Vault

    await expect(migrateVaultSchema(client, legacyVault)).rejects.toMatchObject({
      missing: ["Entities"],
      present: ["Projects", "Topics", "Memories", "Facts"],
    })
    expect(dataSourcesRetrieveCalls()).toEqual([])
  })

  it("surfaces Last Referenced At as a missing property on a pre-0.8.0 Memories DB", async () => {
    // A legacy vault retrieved through dataSources.retrieve returns the
    // pre-0.8.0 Memories shape — Review By / Done At / Decided At present,
    // Last Referenced At absent. The first `lore status` against an
    // upgraded vault must surface `Last Referenced At` in the missing
    // list so the operator's `lore migrate` adds it.
    const memoriesLive: Record<string, Record<string, unknown>> = {
      "Review By": { type: "date", date: {} },
      "Done At": { type: "date", date: {} },
      "Decided At": { type: "date", date: {} },
    }
    const stub = {
      blocks: { children: { list: async () => ({ results: [] }) } },
      databases: { retrieve: async () => ({}) },
      dataSources: {
        retrieve: async (args: { data_source_id: string }) => {
          if (args.data_source_id === "m-ds") {
            return { properties: memoriesLive }
          }
          return { properties: {} }
        },
        update: async () => ({}),
      },
    } as unknown as Client

    const diffs = await migrateVaultSchema(stub, vaultFixture(), {
      dryRun: true,
    })
    const memoriesDiff = diffs.find((d) => d.database === "memories")
    expect(memoriesDiff).toBeDefined()
    expect(memoriesDiff!.missing).toContain("Last Referenced At")
  })

  it("surfaces Topic Key as a missing property on a pre-0.9.0 Memories DB", async () => {
    // A vault upgraded from <0.9.0 has no `Topic Key` column on its
    // Memories DB. The drift detector must surface the column by name
    // so an operator running `lore status` / `lore migrate` sees the
    // nudge — and a future contributor can't silently rename or drop
    // the property without this fixture failing first. Same posture as
    // the Confidence Score / Last Referenced At pins from 0.8.0.
    const { client } = makeStartupStub({
      childDatabases: [],
      liveProperties: {},
    })

    const diffs = await migrateVaultSchema(client, vaultFixture())
    const memoriesDiff = diffs.find((d) => d.database === "memories")
    expect(memoriesDiff?.missing).toContain("Topic Key")
  })

  it("surfaces Revision Count as a missing property on a pre-0.9.0 Memories DB", async () => {
    const { client } = makeStartupStub({
      childDatabases: [],
      liveProperties: {},
    })

    const diffs = await migrateVaultSchema(client, vaultFixture())
    const memoriesDiff = diffs.find((d) => d.database === "memories")
    expect(memoriesDiff?.missing).toContain("Revision Count")
  })

  it("surfaces Done At as a missing property on a pre-#07 Memories DB", async () => {
    // A legacy vault retrieved through dataSources.retrieve returns the
    // pre-#07 Memories shape — Review By and Decided At present, Done At
    // absent. The first `lore status` against an upgraded vault must
    // surface `Done At` in the missing list so the operator's `lore
    // migrate` adds it. Pinning the property name here keeps the spec
    // stable across schema refactors (issue 0.7.0/07).
    const memoriesLive: Record<string, Record<string, unknown>> = {
      "Review By": { type: "date", date: {} },
      "Decided At": { type: "date", date: {} },
    }
    const stub = {
      blocks: { children: { list: async () => ({ results: [] }) } },
      databases: { retrieve: async () => ({}) },
      dataSources: {
        retrieve: async (args: { data_source_id: string }) => {
          if (args.data_source_id === "m-ds") {
            return { properties: memoriesLive }
          }
          return { properties: {} }
        },
        update: async () => ({}),
      },
    } as unknown as Client

    const diffs = await migrateVaultSchema(stub, vaultFixture(), {
      dryRun: true,
    })
    const memoriesDiff = diffs.find((d) => d.database === "memories")
    expect(memoriesDiff).toBeDefined()
    expect(memoriesDiff!.missing).toContain("Done At")
  })

  it("surfaces Compare Notes as a missing property on a pre-0.9.0 Memories DB", async () => {
    // A vault upgraded from <0.9.0 has no Compare Notes column. Drift
    // detection must surface it by name so `lore migrate` adds it. Same
    // posture as the Done At / Last Referenced At pins.
    const { client } = makeStartupStub({
      childDatabases: [],
      liveProperties: {},
    })

    const diffs = await migrateVaultSchema(client, vaultFixture(), {
      dryRun: true,
    })
    const memoriesDiff = diffs.find((d) => d.database === "memories")
    expect(memoriesDiff?.missing).toContain("Compare Notes")
  })

  it("surfaces Compared With as a missing self-relation on a pre-0.9.0 Memories DB", async () => {
    // Self-relations live on the same Memories DS as the scalar columns.
    // A pre-0.9.0 DS has Supersedes + Affects but no Compared With. The
    // drift detector must surface the missing self-relation column the
    // same way it does for any scalar property — additions only, no
    // rename/remove.
    const memoriesLive: Record<string, Record<string, unknown>> = {
      Supersedes: {
        type: "relation",
        relation: { single_property: {}, data_source_id: "m-ds" },
      },
      Affects: {
        type: "relation",
        relation: { single_property: {}, data_source_id: "m-ds" },
      },
    }
    const stub = {
      blocks: { children: { list: async () => ({ results: [] }) } },
      databases: { retrieve: async () => ({}) },
      dataSources: {
        retrieve: async (args: { data_source_id: string }) => {
          if (args.data_source_id === "m-ds") {
            return { properties: memoriesLive }
          }
          return { properties: {} }
        },
        update: async () => ({}),
      },
    } as unknown as Client

    const diffs = await migrateVaultSchema(stub, vaultFixture(), {
      dryRun: true,
    })
    const memoriesDiff = diffs.find((d) => d.database === "memories")
    expect(memoriesDiff).toBeDefined()
    expect(memoriesDiff!.missing).toContain("Compared With")
  })

  it("surfaces all four 0.9.0 schema additions in one migrate pass against a 0.8.x snapshot", async () => {
    // End-to-end coverage on top of the per-property pins above. Belt-
    // and-suspenders against a merge train where one of #01 (Topic Key
    // + Revision Count) or #02 (Compare Notes + Compared With) lands
    // independently and the late-merger is rebased without picking up
    // the other half of the schema delta. If `migrateVaultSchema`
    // surfaces three of the four expected additions but misses the
    // fourth, this test fails fast with the column-by-column assertion
    // below — the per-property tests above each exercise their own
    // fixture in isolation, so a regression where the four collide on
    // ordering / iteration would slip past them but not past this one.
    //
    // Fixture is a 0.8.x-shaped Memories DS: every column documented
    // through 0.8.0 is present, the four 0.9.0 columns are not. This
    // matches what `dataSources.retrieve` returns on a vault that ran
    // `lore migrate --build-confidence-scores` but has not yet seen
    // 0.9.0.
    const memoriesLive_0_8_x: Record<string, Record<string, unknown>> = {
      // Pre-0.7.0
      "Review By": { type: "date", date: {} },
      "Decided At": { type: "date", date: {} },
      // 0.7.0/01–04 (Synopsis); 0.7.0/07 (Done At)
      Synopsis: { type: "rich_text", rich_text: {} },
      "Done At": { type: "date", date: {} },
      // 0.8.0/01 (Confidence Score); 0.8.0/02 (Last Referenced At)
      "Confidence Score": { type: "number", number: { format: "number" } },
      "Last Referenced At": { type: "date", date: {} },
      // Self-relations from earlier rollouts; Compared With (0.9.0/02) absent
      Supersedes: {
        type: "relation",
        relation: { single_property: {}, data_source_id: "m-ds" },
      },
      Affects: {
        type: "relation",
        relation: { single_property: {}, data_source_id: "m-ds" },
      },
    }
    const stub = {
      blocks: { children: { list: async () => ({ results: [] }) } },
      databases: { retrieve: async () => ({}) },
      dataSources: {
        retrieve: async (args: { data_source_id: string }) => {
          if (args.data_source_id === "m-ds") {
            return { properties: memoriesLive_0_8_x }
          }
          return { properties: {} }
        },
        update: async () => ({}),
      },
    } as unknown as Client

    const diffs = await migrateVaultSchema(stub, vaultFixture(), {
      dryRun: true,
    })
    const memoriesDiff = diffs.find((d) => d.database === "memories")
    expect(memoriesDiff).toBeDefined()

    // All four 0.9.0 schema additions must surface in the same pass.
    // Three scalar columns from #01 (`Topic Key`, `Revision Count`) and
    // #02 (`Compare Notes`), one self-relation from #02 (`Compared With`).
    expect(memoriesDiff!.missing).toContain("Topic Key")
    expect(memoriesDiff!.missing).toContain("Revision Count")
    expect(memoriesDiff!.missing).toContain("Compare Notes")
    expect(memoriesDiff!.missing).toContain("Compared With")

    // Sanity-pin: the 0.8.x columns we put in the fixture do NOT show up
    // as missing — drift is additions-only and the four 0.9.0 columns
    // are the only delta a 0.8.x → 0.9.0 migrate must apply to Memories.
    expect(memoriesDiff!.missing).not.toContain("Confidence Score")
    expect(memoriesDiff!.missing).not.toContain("Last Referenced At")
    expect(memoriesDiff!.missing).not.toContain("Synopsis")
    expect(memoriesDiff!.missing).not.toContain("Done At")
    expect(memoriesDiff!.missing).not.toContain("Supersedes")
    expect(memoriesDiff!.missing).not.toContain("Affects")
  })

  it("preserves per-database error attribution on update failure", async () => {
    // Force every DB to surface a missing-property diff so Phase B issues an
    // update for each one. The `memories` update rejects — the thrown error
    // must name `memories`, not `projects` or the batch.
    const liveProperties: Record<string, Record<string, unknown>> = {}

    let dataSourcesRetrieveCount = 0
    const updateCalls: string[] = []
    const stub = {
      blocks: { children: { list: async () => ({ results: [] }) } },
      databases: { retrieve: async () => ({}) },
      dataSources: {
        retrieve: async () => {
          dataSourcesRetrieveCount++
          return { properties: liveProperties }
        },
        update: async (args: { data_source_id: string }) => {
          updateCalls.push(args.data_source_id)
          if (args.data_source_id === "m-ds") {
            throw new Error("validation_error: bad payload")
          }
          return {}
        },
      },
    } as unknown as Client

    await expect(migrateVaultSchema(stub, vaultFixture())).rejects.toThrow(
      /Schema migration failed on memories DB/
    )
    // We still hit retrieve on every DB before the update phase failed.
    expect(dataSourcesRetrieveCount).toBe(5)
    // Phase B must remain sequential and short-circuit on the first
    // failure. If updates ran in parallel, all five would be observed; if
    // a batched try/catch wrapped them, attribution would collapse.
    expect(updateCalls).toEqual(["p-ds", "t-ds", "m-ds"])
  })
})
