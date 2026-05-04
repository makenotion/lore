import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import type { DatabaseRef } from "../types.js"
import {
  ENTITY_QUERY_VARIANT_CAP,
  EntityService,
  expandEntityQueryVariants,
  normalizeEntityKey,
  parseAliases,
} from "./entity.js"

const DB: DatabaseRef = {
  databaseId: "ent-db-id",
  dataSourceId: "ent-ds-id",
}

interface EntityPageOverrides {
  id?: string
  name?: string
  aliases?: string
  kind?: string
  projectIds?: string[]
  archived?: boolean
}

function entityPage(overrides: EntityPageOverrides = {}): PageObjectResponse {
  return {
    object: "page",
    id: overrides.id ?? "ent-1",
    created_time: "2026-04-25T00:00:00.000Z",
    last_edited_time: "2026-04-25T00:00:00.000Z",
    archived: overrides.archived ?? false,
    url: `https://notion.so/${overrides.id ?? "ent-1"}`,
    parent: { type: "database_id", database_id: DB.databaseId },
    properties: {
      Name: {
        type: "title",
        title: [{ plain_text: overrides.name ?? "MemoryService" }],
      } as unknown,
      Aliases: {
        type: "rich_text",
        rich_text: overrides.aliases
          ? [{ plain_text: overrides.aliases }]
          : [],
      } as unknown,
      Kind: overrides.kind
        ? ({
            type: "select",
            select: { name: overrides.kind },
          } as unknown)
        : ({ type: "select", select: null } as unknown),
      Description: {
        type: "rich_text",
        rich_text: [],
      } as unknown,
      Project: {
        type: "relation",
        relation: (overrides.projectIds ?? []).map((id) => ({ id })),
      } as unknown,
    } as PageObjectResponse["properties"],
  } as PageObjectResponse
}

function createMockClient() {
  return {
    dataSources: { query: vi.fn() },
    pages: {
      create: vi.fn(),
      retrieve: vi.fn(),
      retrieveMarkdown: vi.fn(),
      update: vi.fn(),
      updateMarkdown: vi.fn(),
      properties: { retrieve: vi.fn() },
    },
  } as unknown as Client & {
    dataSources: { query: ReturnType<typeof vi.fn> }
    pages: {
      create: ReturnType<typeof vi.fn>
      retrieve: ReturnType<typeof vi.fn>
      retrieveMarkdown: ReturnType<typeof vi.fn>
      update: ReturnType<typeof vi.fn>
      updateMarkdown: ReturnType<typeof vi.fn>
      properties: { retrieve: ReturnType<typeof vi.fn> }
    }
  }
}

/**
 * Shape an entity page whose `Project` relation column is truncated
 * (`has_more: true`) so `hydrateRelationProperties` would issue a
 * `pages.properties.retrieve` call. Used to pin issue #487's pre-filter
 * structural property — `pageToEntity` must NOT be called per
 * candidate; otherwise a high-cardinality alias would burn an
 * O(N) round-trip walk paced by the rate-limit token bucket.
 */
function truncatedProjectEntityPage(
  overrides: EntityPageOverrides = {}
): PageObjectResponse {
  const page = entityPage(overrides)
  page.properties = {
    ...page.properties,
    Project: {
      ...page.properties["Project"],
      id: "rel-project-id",
      has_more: true,
    } as unknown,
  } as PageObjectResponse["properties"]
  return page
}

describe("normalizeEntityKey", () => {
  it("returns equal keys for case variants", () => {
    expect(normalizeEntityKey("MemoryService")).toEqual(
      normalizeEntityKey("memoryservice"),
    )
    expect(normalizeEntityKey("MemoryService")).toEqual(
      normalizeEntityKey("memoryService "),
    )
  })

  it("yields empty string for whitespace-only input", () => {
    expect(normalizeEntityKey("")).toBe("")
    expect(normalizeEntityKey("   ")).toBe("")
  })
})

describe("parseAliases", () => {
  it("splits comma-separated aliases and trims whitespace", () => {
    expect(parseAliases("foo, bar,baz ")).toEqual(["foo", "bar", "baz"])
  })

  it("drops empty entries from leading/trailing commas", () => {
    expect(parseAliases(", foo,, bar,")).toEqual(["foo", "bar"])
  })

  it("returns empty array for empty input", () => {
    expect(parseAliases("")).toEqual([])
  })
})

describe("EntityService.findByName", () => {
  it("matches case-insensitively via the contains fallback", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      // First call: title.equals returns nothing (case-sensitive miss).
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.dataSources.query.mockResolvedValueOnce({
      // Second call: title.contains finds the case-variant page; the
      // post-filter picks the row whose normalized name matches.
      results: [entityPage({ name: "MemoryService" })],
      has_more: false,
      next_cursor: null,
    })

    const service = new EntityService(client, DB)
    const found = await service.findByName("memoryservice")
    expect(found).not.toBeNull()
    expect(found!.name).toBe("MemoryService")
  })

  it("ignores archived name matches", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [entityPage({ id: "ent-archived", name: "AuthSvc", archived: true })],
      has_more: false,
      next_cursor: null,
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [entityPage({ id: "ent-active", name: "AuthSvc", archived: true })],
      has_more: false,
      next_cursor: null,
    })

    const service = new EntityService(client, DB)
    expect(await service.findByName("AuthSvc")).toBeNull()
  })

  it("returns null on whitespace-only input without querying Notion", async () => {
    const client = createMockClient()
    const service = new EntityService(client, DB)
    expect(await service.findByName("   ")).toBeNull()
    expect(client.dataSources.query).not.toHaveBeenCalled()
  })

  it("hydrates only the matching candidate at the documented worst case (issue #487)", async () => {
    // Walk the full `NAME_LOOKUP_MAX_PAGES * NOTION_MAX_PAGE_SIZE`
    // = 1000-candidate / 10-page substring fallback with the match
    // pinned on the last candidate of the last page. Pre-filtering
    // on the synchronously-available `Name` title before calling
    // `pageToEntity` collapses the worst case from 1000 sequential
    // `pages.properties.retrieve` round-trips down to one.
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      // First call: title.equals — case-sensitive miss.
      results: [],
      has_more: false,
      next_cursor: null,
    })
    for (let pageIdx = 0; pageIdx < 10; pageIdx++) {
      const pageCandidates = Array.from({ length: 100 }, (_, i) => {
        const flatIndex = pageIdx * 100 + i
        const isMatch = flatIndex === 999
        return truncatedProjectEntityPage({
          id: `ent-${flatIndex}`,
          name: isMatch ? "MemoryService" : `MemoryService.method${flatIndex}`,
        })
      })
      client.dataSources.query.mockResolvedValueOnce({
        results: pageCandidates,
        has_more: pageIdx < 9,
        next_cursor: pageIdx < 9 ? `cursor-${pageIdx + 1}` : null,
      })
    }
    client.pages.properties.retrieve.mockResolvedValue({
      object: "list",
      results: [{ type: "relation", relation: { id: "proj-A" } }],
      has_more: false,
      next_cursor: null,
    })

    const service = new EntityService(client, DB)
    const found = await service.findByName("memoryservice")
    expect(found).not.toBeNull()
    expect(found!.id).toBe("ent-999")
    // 1 title.equals + 10 title.contains pages = 11 total queries.
    expect(client.dataSources.query).toHaveBeenCalledTimes(11)
    expect(client.pages.properties.retrieve).toHaveBeenCalledTimes(1)
  })

  it("hydrates zero candidates when no row matches the normalized key (issue #487)", async () => {
    // Symmetric no-match case: 100 substring hits, none normalize to
    // the requested key. Pre-fix this hydrated every candidate before
    // returning null; post-fix the loop walks the candidates without
    // a single `pages.properties.retrieve`.
    const client = createMockClient()
    const candidates = Array.from({ length: 100 }, (_, i) =>
      truncatedProjectEntityPage({
        id: `ent-${i}`,
        // Every name carries the substring `User` so the
        // title.contains pass surfaces them, but none normalize to
        // the bare `user` key.
        name: `UserSession${i}`,
      }),
    )
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: candidates,
      has_more: false,
      next_cursor: null,
    })

    const service = new EntityService(client, DB)
    expect(await service.findByName("user")).toBeNull()
    expect(client.pages.properties.retrieve).not.toHaveBeenCalled()
  })
})

describe("EntityService.findByAlias", () => {
  it("ignores archived alias matches", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        entityPage({
          id: "ent-archived",
          name: "AuthService",
          aliases: "AuthSvc",
          archived: true,
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const service = new EntityService(client, DB)
    expect(await service.findByAlias("AuthSvc")).toEqual([])
  })

  it("hydrates only matching candidates at the documented worst case (issue #487)", async () => {
    // Walk the full `NAME_LOOKUP_MAX_PAGES * NOTION_MAX_PAGE_SIZE`
    // = 1000-candidate / 10-page substring pass with the only exact-
    // key alias on the last candidate of the last page. Unlike
    // `findByName`, `findByAlias` accumulates across pages rather
    // than returning early, so the loop walks every page regardless
    // of when the first match is observed. Pre-filtering on the
    // synchronously-available `Aliases` rich_text cell before
    // calling `pageToEntity` collapses the worst case from 1000
    // sequential `pages.properties.retrieve` round-trips down to one.
    const client = createMockClient()
    for (let pageIdx = 0; pageIdx < 10; pageIdx++) {
      const pageCandidates = Array.from({ length: 100 }, (_, i) => {
        const flatIndex = pageIdx * 100 + i
        const isMatch = flatIndex === 999
        return truncatedProjectEntityPage({
          id: `ent-${flatIndex}`,
          name: `Entity${flatIndex}`,
          // Substring match on `User` for every row, but only the
          // last alias normalizes to the exact key.
          aliases: isMatch ? "User" : `Username${flatIndex}`,
        })
      })
      client.dataSources.query.mockResolvedValueOnce({
        results: pageCandidates,
        has_more: pageIdx < 9,
        next_cursor: pageIdx < 9 ? `cursor-${pageIdx + 1}` : null,
      })
    }
    client.pages.properties.retrieve.mockResolvedValue({
      object: "list",
      results: [{ type: "relation", relation: { id: "proj-A" } }],
      has_more: false,
      next_cursor: null,
    })

    const service = new EntityService(client, DB)
    const matches = await service.findByAlias("User")
    expect(matches).toHaveLength(1)
    expect(matches[0].id).toBe("ent-999")
    expect(client.dataSources.query).toHaveBeenCalledTimes(10)
    expect(client.pages.properties.retrieve).toHaveBeenCalledTimes(1)
  })

  it("hydrates zero candidates when no alias normalizes to the key (issue #487)", async () => {
    // Symmetric no-match case: 100 substring hits, none normalize to
    // the requested key. Pre-fix this hydrated every candidate before
    // returning the empty array; post-fix the loop walks the
    // candidates without a single `pages.properties.retrieve`.
    const client = createMockClient()
    const candidates = Array.from({ length: 100 }, (_, i) =>
      truncatedProjectEntityPage({
        id: `ent-${i}`,
        name: `Entity${i}`,
        // Every alias carries the substring `User` (so the
        // rich_text.contains pass surfaces them) but none normalize
        // to the bare `user` key.
        aliases: `Username${i}`,
      }),
    )
    client.dataSources.query.mockResolvedValueOnce({
      results: candidates,
      has_more: false,
      next_cursor: null,
    })

    const service = new EntityService(client, DB)
    expect(await service.findByAlias("User")).toEqual([])
    expect(client.pages.properties.retrieve).not.toHaveBeenCalled()
  })
})

describe("EntityService.getById", () => {
  it("rejects archived entity rows", async () => {
    const client = createMockClient()
    client.pages.retrieve.mockResolvedValueOnce(
      entityPage({ id: "ent-archived", archived: true }),
    )

    const service = new EntityService(client, DB)
    await expect(service.getById("ent-archived")).rejects.toThrow(/archived/)
  })

  it("can explicitly read archived rows for merge retries", async () => {
    const client = createMockClient()
    client.pages.retrieve.mockResolvedValueOnce(
      entityPage({ id: "ent-archived", name: "AuthSvc", archived: true }),
    )

    const service = new EntityService(client, DB)
    const entity = await service.getById("ent-archived", { includeArchived: true })
    expect(entity.id).toBe("ent-archived")
    expect(entity.archived).toBe(true)
  })
})

describe("EntityService.resolveOrCreateEntity", () => {
  it("revalidates cached rows so archived merge losers do not receive new fact relations", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [entityPage({ id: "ent-loser", name: "AuthSvc" })],
      has_more: false,
      next_cursor: null,
    })

    const service = new EntityService(client, DB)
    expect((await service.findByName("AuthSvc"))?.id).toBe("ent-loser")

    client.pages.retrieve.mockResolvedValueOnce(
      entityPage({ id: "ent-loser", name: "AuthSvc", archived: true }),
    )
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        entityPage({
          id: "ent-winner",
          name: "AuthService",
          aliases: "AuthSvc",
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const resolution = await service.resolveOrCreateEntity("AuthSvc")

    expect(client.pages.retrieve).toHaveBeenCalledWith({ page_id: "ent-loser" })
    expect(resolution.entity?.id).toBe("ent-winner")
    expect(resolution.created).toBe(false)
    expect(client.pages.create).not.toHaveBeenCalled()
  })

  it("falls back to lookup queries when cached row revalidation fails", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [entityPage({ id: "ent-loser", name: "AuthSvc" })],
      has_more: false,
      next_cursor: null,
    })

    const service = new EntityService(client, DB)
    expect((await service.findByName("AuthSvc"))?.id).toBe("ent-loser")

    client.pages.retrieve.mockRejectedValueOnce(new Error("object_not_found"))
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        entityPage({
          id: "ent-winner",
          name: "AuthService",
          aliases: "AuthSvc",
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const resolution = await service.resolveOrCreateEntity("AuthSvc")

    expect(resolution.entity?.id).toBe("ent-winner")
    expect(client.pages.create).not.toHaveBeenCalled()
  })

  it("returns ambiguous when multiple entities share an alias", async () => {
    const client = createMockClient()
    // findByName: nothing.
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    // findByAlias: two entities both alias `User`.
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        entityPage({ id: "ent-auth", name: "User (auth context)", aliases: "User" }),
        entityPage({ id: "ent-db", name: "User (db schema)", aliases: "User" }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const service = new EntityService(client, DB)
    const resolution = await service.resolveOrCreateEntity("User")
    expect(resolution.ambiguous).toBe(true)
    expect(resolution.entity).toBeNull()
    expect(resolution.candidates).toHaveLength(2)
    expect(resolution.created).toBe(false)
    expect(client.pages.create).not.toHaveBeenCalled()
  })

  it("auto-creates on miss when autoCreate is unset (default)", async () => {
    const client = createMockClient()
    // findByName: equals miss, contains miss.
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    // findByAlias: nothing.
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    // pages.create returns the new entity.
    client.pages.create.mockResolvedValueOnce(
      entityPage({ id: "ent-new", name: "FreshService" }),
    )

    const service = new EntityService(client, DB)
    const resolution = await service.resolveOrCreateEntity("FreshService")
    expect(resolution.ambiguous).toBe(false)
    expect(resolution.entity).not.toBeNull()
    expect(resolution.entity!.id).toBe("ent-new")
    expect(resolution.created).toBe(true)
    expect(client.pages.create).toHaveBeenCalledTimes(1)
  })

  it("strict mode returns no entity on miss without writing", async () => {
    const client = createMockClient()
    // findByName: miss; findByAlias: miss.
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })

    const service = new EntityService(client, DB)
    const resolution = await service.resolveOrCreateEntity("Unknown", {
      autoCreate: false,
    })
    expect(resolution.entity).toBeNull()
    expect(resolution.ambiguous).toBe(false)
    expect(resolution.created).toBe(false)
    expect(client.pages.create).not.toHaveBeenCalled()
  })

  it("auto-create forwards options.projectIds onto the new Entity row", async () => {
    const client = createMockClient()
    // findByName: equals miss, contains miss.
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    // findByAlias: nothing.
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.pages.create.mockResolvedValueOnce(
      entityPage({ id: "ent-scoped", name: "ScopedService" }),
    )

    const service = new EntityService(client, DB)
    const resolution = await service.resolveOrCreateEntity("ScopedService", {
      projectIds: ["proj-a", "proj-b"],
    })
    expect(resolution.created).toBe(true)
    expect(client.pages.create).toHaveBeenCalledTimes(1)
    const callArg = client.pages.create.mock.calls[0][0] as {
      properties: Record<string, unknown>
    }
    expect(callArg.properties.Project).toEqual({
      relation: [{ id: "proj-a" }, { id: "proj-b" }],
    })
  })

  it("auto-create with an empty projectIds array still leaves Project unset", async () => {
    // Pins `buildEntityProps`'s `input.projectIds?.length` gate at the
    // call-site test layer: an empty array must behave the same as
    // `undefined`. Otherwise a caller passing `projectIds: []` for "no
    // project scope" would silently emit a relation property with an
    // empty `relation: []` payload.
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.pages.create.mockResolvedValueOnce(
      entityPage({ id: "ent-empty", name: "EmptyScopeService" }),
    )

    const service = new EntityService(client, DB)
    await service.resolveOrCreateEntity("EmptyScopeService", { projectIds: [] })
    const callArg = client.pages.create.mock.calls[0][0] as {
      properties: Record<string, unknown>
    }
    expect(callArg.properties).not.toHaveProperty("Project")
  })

  it("auto-create without projectIds leaves Project unset on the new row", async () => {
    const client = createMockClient()
    // findByName: equals miss, contains miss.
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    // findByAlias: nothing.
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.pages.create.mockResolvedValueOnce(
      entityPage({ id: "ent-unscoped", name: "UnscopedService" }),
    )

    const service = new EntityService(client, DB)
    await service.resolveOrCreateEntity("UnscopedService")
    const callArg = client.pages.create.mock.calls[0][0] as {
      properties: Record<string, unknown>
    }
    expect(callArg.properties).not.toHaveProperty("Project")
  })

  it("byName match unions options.projectIds into the existing entity's Project relation", async () => {
    const client = createMockClient()
    // findByName: case-insensitive equals miss, contains hit returns
    // existing entity scoped to project A.
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        entityPage({
          id: "ent-existing",
          name: "AuthService",
          projectIds: ["proj-a"],
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const service = new EntityService(client, DB)
    const resolution = await service.resolveOrCreateEntity("AuthService", {
      projectIds: ["proj-b"],
    })
    expect(resolution.created).toBe(false)
    expect(resolution.entity?.id).toBe("ent-existing")
    expect(resolution.entity?.projectIds).toEqual(["proj-a", "proj-b"])
    expect(client.pages.update).toHaveBeenCalledTimes(1)
    const updateArg = client.pages.update.mock.calls[0][0] as {
      page_id: string
      properties: Record<string, unknown>
    }
    expect(updateArg.page_id).toBe("ent-existing")
    expect(updateArg.properties.Project).toEqual({
      relation: [{ id: "proj-a" }, { id: "proj-b" }],
    })
  })

  it("byName match with already-included project is a no-op (no pages.update)", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        entityPage({
          id: "ent-already",
          name: "AuthService",
          projectIds: ["proj-a", "proj-b"],
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const service = new EntityService(client, DB)
    const resolution = await service.resolveOrCreateEntity("AuthService", {
      projectIds: ["proj-a"],
    })
    expect(resolution.entity?.projectIds).toEqual(["proj-a", "proj-b"])
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("byAlias single match unions options.projectIds into the existing entity", async () => {
    const client = createMockClient()
    // findByName: equals miss, contains miss.
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    // findByAlias: one entity scoped to project A.
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        entityPage({
          id: "ent-aliased",
          name: "AuthService",
          aliases: "AuthSvc",
          projectIds: ["proj-a"],
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const service = new EntityService(client, DB)
    const resolution = await service.resolveOrCreateEntity("AuthSvc", {
      projectIds: ["proj-c"],
    })
    expect(resolution.entity?.id).toBe("ent-aliased")
    expect(resolution.entity?.projectIds).toEqual(["proj-a", "proj-c"])
    expect(client.pages.update).toHaveBeenCalledTimes(1)
    const updateArg = client.pages.update.mock.calls[0][0] as {
      properties: Record<string, unknown>
    }
    expect(updateArg.properties.Project).toEqual({
      relation: [{ id: "proj-a" }, { id: "proj-c" }],
    })
  })

  it("ambiguous alias match does not union project ids onto either candidate", async () => {
    const client = createMockClient()
    // findByName: equals miss, contains miss.
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    // findByAlias: two entities both alias `User`.
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        entityPage({
          id: "ent-auth",
          name: "User (auth)",
          aliases: "User",
          projectIds: ["proj-a"],
        }),
        entityPage({
          id: "ent-db",
          name: "User (db)",
          aliases: "User",
          projectIds: ["proj-b"],
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const service = new EntityService(client, DB)
    const resolution = await service.resolveOrCreateEntity("User", {
      projectIds: ["proj-c"],
    })
    expect(resolution.ambiguous).toBe(true)
    expect(resolution.entity).toBeNull()
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("byName match with no projectIds option is a pure read (no pages.update)", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [
        entityPage({
          id: "ent-pure-read",
          name: "AuthService",
          projectIds: ["proj-a"],
        }),
      ],
      has_more: false,
      next_cursor: null,
    })

    const service = new EntityService(client, DB)
    await service.resolveOrCreateEntity("AuthService")
    expect(client.pages.update).not.toHaveBeenCalled()
  })
})

describe("EntityService.addProjectIds", () => {
  it("issues no pages.update when every requested id is already present", async () => {
    const client = createMockClient()
    const service = new EntityService(client, DB)
    const existing = {
      id: "ent-noop",
      name: "AuthService",
      aliases: [],
      kind: null,
      description: "",
      projectIds: ["proj-a", "proj-b"],
    }
    const result = await service.addProjectIds(existing, ["proj-a"])
    expect(result).toBe(existing)
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("dedupes duplicates within the requested ids", async () => {
    const client = createMockClient()
    const service = new EntityService(client, DB)
    const existing = {
      id: "ent-dedupe",
      name: "AuthService",
      aliases: [],
      kind: null,
      description: "",
      projectIds: ["proj-a"],
    }
    const result = await service.addProjectIds(existing, [
      "proj-b",
      "proj-b",
      "proj-a",
    ])
    expect(result.projectIds).toEqual(["proj-a", "proj-b"])
    expect(client.pages.update).toHaveBeenCalledTimes(1)
  })

  it("normalizes a partially-constructed Entity without projectIds (optional public field)", async () => {
    // External consumers (test fixtures, adapter mocks) construct
    // `Entity`-shaped objects without populating every field. The
    // exported type has `projectIds?: string[]` for source-compat
    // (see `types.ts`). The service must read the missing field as
    // `[]` rather than throw on `[...undefined]` or `new Set(undefined)`.
    const client = createMockClient()
    const service = new EntityService(client, DB)
    const partial = {
      id: "ent-partial",
      name: "PartialEntity",
      aliases: [],
      kind: null,
      description: "",
      // projectIds: undefined  — deliberately omitted
    }
    const result = await service.addProjectIds(partial, ["proj-x"])
    expect(result.projectIds).toEqual(["proj-x"])
    expect(client.pages.update).toHaveBeenCalledTimes(1)
    const updateArg = client.pages.update.mock.calls[0][0] as {
      properties: Record<string, unknown>
    }
    expect(updateArg.properties.Project).toEqual({
      relation: [{ id: "proj-x" }],
    })
  })
})

describe("EntityService.create", () => {
  it("writes the Project relation when projectIds is supplied directly", async () => {
    const client = createMockClient()
    client.pages.create.mockResolvedValueOnce(
      entityPage({ id: "ent-direct", name: "DirectScopedService" }),
    )

    const service = new EntityService(client, DB)
    await service.create({
      name: "DirectScopedService",
      projectIds: ["proj-direct"],
    })
    const callArg = client.pages.create.mock.calls[0][0] as {
      properties: Record<string, unknown>
    }
    expect(callArg.properties.Project).toEqual({
      relation: [{ id: "proj-direct" }],
    })
  })
})

describe("EntityService.addAliases", () => {
  it("dedupes against existing aliases when adding", async () => {
    const client = createMockClient()
    client.pages.retrieve.mockResolvedValueOnce(
      entityPage({ id: "ent-1", name: "Auth", aliases: "auth, AuthService" }),
    )

    const service = new EntityService(client, DB)
    const updated = await service.addAliases("ent-1", ["auth", "AUTHSERVICE", "Authority"])
    expect(updated.aliases).toContain("Authority")
    // `auth` and `AUTHSERVICE` normalize onto existing aliases — neither
    // should be appended a second time.
    expect(updated.aliases.filter((a) => a.toLowerCase() === "auth")).toHaveLength(1)
    expect(client.pages.update).toHaveBeenCalledTimes(1)
  })
})

describe("EntityService.archive", () => {
  it("writes a merge breadcrumb, archives the page, and evicts name/alias cache entries", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [entityPage({ id: "ent-archive", name: "Auth", aliases: "AuthSvc" })],
      has_more: false,
      next_cursor: null,
    })
    client.pages.retrieveMarkdown.mockResolvedValueOnce({
      markdown: "Existing notes",
    })
    client.pages.updateMarkdown.mockResolvedValueOnce({})
    client.pages.update.mockResolvedValueOnce({})

    const service = new EntityService(client, DB)
    expect(await service.findByName("Auth")).not.toBeNull()

    await service.archive({
      id: "ent-archive",
      name: "Auth",
      aliases: ["AuthSvc"],
      kind: null,
      description: "",
      projectIds: [],
    }, {
      mergedInto: { id: "ent-winner", name: "AuthService" },
      mergedAt: "2026-05-02",
    })

    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })

    expect(client.pages.updateMarkdown).toHaveBeenCalledWith({
      page_id: "ent-archive",
      type: "replace_content_range",
      replace_content_range: {
        content:
          "Existing notes\n\n---\n\n" +
          "## Merged into AuthService\n\n" +
          "Merged into AuthService (ent-winner) on 2026-05-02.",
        content_range: "full_page",
        allow_deleting_content: true,
      },
    })
    expect(client.pages.update).toHaveBeenCalledWith({
      page_id: "ent-archive",
      archived: true,
    })
    expect(
      client.pages.updateMarkdown.mock.invocationCallOrder[0]
    ).toBeLessThan(client.pages.update.mock.invocationCallOrder[0])
    expect(await service.findByName("Auth")).toBeNull()
  })

  it("does not duplicate an existing merge breadcrumb on archive retry", async () => {
    const client = createMockClient()
    client.pages.retrieveMarkdown.mockResolvedValueOnce({
      markdown:
        "## Merged into AuthService\n\n" +
        "Merged into AuthService (ent-winner) on 2026-05-01.",
    })
    client.pages.update.mockResolvedValueOnce({})

    const service = new EntityService(client, DB)
    await service.archive(
      {
        id: "ent-archive",
        name: "Auth",
        aliases: [],
        kind: null,
        description: "",
        projectIds: [],
      },
      {
        mergedInto: { id: "ent-winner", name: "AuthService" },
        mergedAt: "2026-05-02",
      }
    )

    expect(client.pages.updateMarkdown).not.toHaveBeenCalled()
    expect(client.pages.update).toHaveBeenCalledWith({
      page_id: "ent-archive",
      archived: true,
    })
  })

  it("evicts cache entries before the archive write is attempted", async () => {
    const client = createMockClient()
    client.dataSources.query.mockResolvedValueOnce({
      results: [entityPage({ id: "ent-archive", name: "Auth", aliases: "AuthSvc" })],
      has_more: false,
      next_cursor: null,
    })
    client.pages.update.mockRejectedValueOnce(new Error("archive failed"))

    const service = new EntityService(client, DB)
    expect(await service.findByName("Auth")).not.toBeNull()

    await expect(
      service.archive({
        id: "ent-archive",
        name: "Auth",
        aliases: ["AuthSvc"],
        kind: null,
        description: "",
        projectIds: [],
      })
    ).rejects.toThrow("archive failed")

    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    client.dataSources.query.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })

    expect(await service.findByName("Auth")).toBeNull()
  })
})

describe("expandEntityQueryVariants", () => {
  it("returns the trimmed raw input as the only variant when the entity is null", () => {
    const result = expandEntityQueryVariants("  AuthService  ", null)
    expect(result.variants).toEqual(["AuthService"])
    expect(result.hitCap).toBe(false)
    expect(result.dropped).toEqual([])
  })

  it("returns an empty variant set on whitespace-only input so callers can detect the degenerate case", () => {
    const result = expandEntityQueryVariants("   ", null)
    expect(result.variants).toEqual([])
    expect(result.hitCap).toBe(false)
  })

  it("preserves the raw input as the first variant even when canonical exists — un-migrated rows still match", () => {
    const result = expandEntityQueryVariants("AuthSvc", {
      name: "AuthService",
      aliases: ["AuthSvc", "auth-service"],
    })
    expect(result.variants[0]).toBe("AuthSvc")
    expect(result.variants).toContain("AuthService")
    expect(result.variants).toContain("auth-service")
  })

  it("collapses case-variant aliases via normalizeEntityKey so cap slots aren't burned on duplicates", () => {
    const result = expandEntityQueryVariants("AuthService", {
      name: "AuthService",
      aliases: ["authservice", "AUTHSERVICE", "AuthSvc"],
    })
    // Raw input + canonical normalize to one slot; the two case-variant
    // aliases also collapse onto that key. Net: 2 variants (canonical
    // + the truly distinct AuthSvc alias).
    expect(result.variants).toEqual(["AuthService", "AuthSvc"])
    expect(result.hitCap).toBe(false)
  })

  it("caps at ENTITY_QUERY_VARIANT_CAP variants and reports the dropped aliases", () => {
    const aliases = Array.from({ length: 12 }, (_, i) => `Alias-${i}`)
    const result = expandEntityQueryVariants("AuthService", {
      name: "AuthService",
      aliases,
    })
    // Slot 0: raw == canonical (AuthService). Slots 1–9: aliases 0–8.
    // Aliases 9, 10, 11 overflow.
    expect(result.variants).toHaveLength(ENTITY_QUERY_VARIANT_CAP)
    expect(result.hitCap).toBe(true)
    expect(result.dropped).toEqual(["Alias-9", "Alias-10", "Alias-11"])
  })

  it("hitCap stays false when overflow aliases were duplicates of already-included variants", () => {
    // 10 distinct aliases + 3 case-duplicate trailing aliases. The
    // trailing duplicates fail the dedup check before the cap fires,
    // so they're not surfaced as "dropped recall" — they would have
    // been redundant slots anyway.
    const aliases = [
      ...Array.from({ length: 9 }, (_, i) => `Alias-${i}`),
      "AUTHSERVICE",
      "authservice",
      "ALIAS-0",
    ]
    const result = expandEntityQueryVariants("AuthService", {
      name: "AuthService",
      aliases,
    })
    expect(result.variants).toHaveLength(ENTITY_QUERY_VARIANT_CAP)
    expect(result.hitCap).toBe(false)
    expect(result.dropped).toEqual([])
  })

  it("respects a caller-supplied cap override for tests / future tuning", () => {
    const result = expandEntityQueryVariants(
      "AuthSvc",
      { name: "AuthService", aliases: ["alpha", "beta", "gamma"] },
      3,
    )
    // Cap = 3: raw ("AuthSvc"), canonical ("AuthService"), one alias.
    expect(result.variants).toHaveLength(3)
    expect(result.hitCap).toBe(true)
    expect(result.dropped).toEqual(["beta", "gamma"])
  })
})
