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
}

function entityPage(overrides: EntityPageOverrides = {}): PageObjectResponse {
  return {
    object: "page",
    id: overrides.id ?? "ent-1",
    created_time: "2026-04-25T00:00:00.000Z",
    last_edited_time: "2026-04-25T00:00:00.000Z",
    archived: false,
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
    } as PageObjectResponse["properties"],
  } as PageObjectResponse
}

function createMockClient() {
  return {
    dataSources: { query: vi.fn() },
    pages: { create: vi.fn(), retrieve: vi.fn(), update: vi.fn() },
  } as unknown as Client & {
    dataSources: { query: ReturnType<typeof vi.fn> }
    pages: {
      create: ReturnType<typeof vi.fn>
      retrieve: ReturnType<typeof vi.fn>
      update: ReturnType<typeof vi.fn>
    }
  }
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

  it("returns null on whitespace-only input without querying Notion", async () => {
    const client = createMockClient()
    const service = new EntityService(client, DB)
    expect(await service.findByName("   ")).toBeNull()
    expect(client.dataSources.query).not.toHaveBeenCalled()
  })
})

describe("EntityService.resolveOrCreateEntity", () => {
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
