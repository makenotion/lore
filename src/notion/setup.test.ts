import { describe, expect, it } from "vitest"
import type { Client } from "@notionhq/client"
import type { Vault } from "../types.js"
import {
  computeRelationConfigDiff,
  computeSelectOptionDiff,
  migrateVaultSchema,
  verifyVaultDatabases,
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

/**
 * Stand-in for the SDK methods that `verifyVaultDatabases` and
 * `migrateVaultSchema` exercise. Records the maximum number of in-flight
 * retrieves so a parallel fan-out is observable: a sequential `for...of
 * await` loop drives `maxInFlight` to 1, while a `Promise.all` over N
 * retrieves drives it to N.
 */
function makeStartupStub({
  childDatabases,
  liveProperties,
  retrieveDelayMs = 10,
}: {
  childDatabases: Array<{ id: string; title: string }>
  liveProperties: Record<string, Record<string, unknown>>
  retrieveDelayMs?: number
}): {
  client: Client
  maxInFlight: () => number
  databasesRetrieveCalls: () => string[]
  dataSourcesRetrieveCalls: () => string[]
} {
  let inFlight = 0
  let maxInFlight = 0
  const databasesRetrieveCalls: string[] = []
  const dataSourcesRetrieveCalls: string[] = []

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
        list: async () => ({
          results: childDatabases.map((db) => ({
            type: "child_database",
            id: db.id,
            child_database: { title: db.title },
          })),
        }),
      },
    },
    databases: {
      retrieve: async (args: { database_id: string }) => {
        databasesRetrieveCalls.push(args.database_id)
        return track({
          id: args.database_id,
          data_sources: [{ id: `ds-${args.database_id}` }],
        })
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
    maxInFlight: () => maxInFlight,
    databasesRetrieveCalls: () => databasesRetrieveCalls,
    dataSourcesRetrieveCalls: () => dataSourcesRetrieveCalls,
  }
}

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

  it("skips the optional Entities DB when absent without holding back the rest", async () => {
    const childDatabases = [
      { id: "block-projects", title: PROJECTS_DB_TITLE },
      { id: "block-topics", title: TOPICS_DB_TITLE },
      { id: "block-memories", title: MEMORIES_DB_TITLE },
      { id: "block-facts", title: FACTS_DB_TITLE },
    ]
    const { client, maxInFlight } = makeStartupStub({
      childDatabases,
      liveProperties: {},
    })

    const vault = await verifyVaultDatabases(client, "page-1")

    expect(maxInFlight()).toBeGreaterThan(1)
    expect(vault.databases.entities).toBeUndefined()
  })
})

describe("migrateVaultSchema parallel retrieves", () => {
  function vaultFixture({ withEntities }: { withEntities: boolean }): Vault {
    const databases: Vault["databases"] = {
      projects: { databaseId: "p-db", dataSourceId: "p-ds" },
      topics: { databaseId: "t-db", dataSourceId: "t-ds" },
      memories: { databaseId: "m-db", dataSourceId: "m-ds" },
      facts: { databaseId: "f-db", dataSourceId: "f-ds" },
    }
    if (withEntities) {
      databases.entities = { databaseId: "e-db", dataSourceId: "e-ds" }
    }
    return { pageId: "page-1", databases }
  }

  it("issues dataSources.retrieve concurrently across every target DB", async () => {
    // No-drift fixture: live properties are a superset, so Phase B emits no
    // updates. We only care about Phase A's fan-out shape here.
    const liveProperties: Record<string, Record<string, unknown>> = {}
    const { client, maxInFlight, dataSourcesRetrieveCalls } = makeStartupStub({
      childDatabases: [],
      liveProperties,
    })

    const diffs = await migrateVaultSchema(client, vaultFixture({ withEntities: true }))

    // 5 expected DBs (projects, topics, memories, facts, entities).
    expect(dataSourcesRetrieveCalls()).toHaveLength(5)
    expect(maxInFlight()).toBeGreaterThan(1)
    // Diff order must match Object.keys(expectedByDb) enumeration order. The
    // production code populates the literal with projects/topics/memories/
    // facts and then assigns `expectedByDb.entities` last, so spec-defined
    // string-key insertion order puts entities at the end. This is the
    // contract being asserted, not an accident of V8.
    expect(diffs.map((d) => d.database)).toEqual([
      "projects",
      "topics",
      "memories",
      "facts",
      "entities",
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

    const diffs = await migrateVaultSchema(client, vaultFixture({ withEntities: true }))
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

    const diffs = await migrateVaultSchema(client, vaultFixture({ withEntities: true }))
    const memoriesDiff = diffs.find((d) => d.database === "memories")
    expect(memoriesDiff?.missing).toContain("Synopsis")
  })

  it("omits the Entities entry when the vault has no entities database", async () => {
    const { client, maxInFlight, dataSourcesRetrieveCalls } = makeStartupStub({
      childDatabases: [],
      liveProperties: {},
    })

    const diffs = await migrateVaultSchema(client, vaultFixture({ withEntities: false }))

    expect(dataSourcesRetrieveCalls()).toHaveLength(4)
    expect(maxInFlight()).toBeGreaterThan(1)
    expect(diffs.map((d) => d.database)).toEqual([
      "projects",
      "topics",
      "memories",
      "facts",
    ])
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

    const diffs = await migrateVaultSchema(stub, vaultFixture({ withEntities: false }), {
      dryRun: true,
    })
    const memoriesDiff = diffs.find((d) => d.database === "memories")
    expect(memoriesDiff).toBeDefined()
    expect(memoriesDiff!.missing).toContain("Done At")
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

    await expect(
      migrateVaultSchema(stub, vaultFixture({ withEntities: true })),
    ).rejects.toThrow(/Schema migration failed on memories DB/)
    // We still hit retrieve on every DB before the update phase failed.
    expect(dataSourcesRetrieveCount).toBe(5)
    // Phase B must remain sequential and short-circuit on the first
    // failure. If updates ran in parallel, all five would be observed; if
    // a batched try/catch wrapped them, attribution would collapse.
    expect(updateCalls).toEqual(["p-ds", "t-ds", "m-ds"])
  })
})
