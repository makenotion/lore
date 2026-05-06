import { describe, expect, it, vi } from "vitest"
import type { Client } from "@notionhq/client"
import {
  fetchAlreadyComparedPairKeys,
  fetchEntitiesByAliasSubstring,
  fetchEntityByNormalizedName,
  fetchNearDuplicateCandidatePageIds,
} from "./query.js"
import { SqlPartialResultError } from "./error-helpers.js"

function makeStubClient(
  responder: (args: { method: string; path: string; body: Record<string, unknown> }) => unknown,
): Client {
  return {
    request: vi.fn(async (args) => responder(args)),
  } as unknown as Client
}

const NEAR_DUP_OPTS = {
  dataSourceId: "ds-mem",
  projectProperty: "Project",
  topicProperty: "Topic",
  kindProperty: "Kind",
  statusProperty: "Status",
  keywordsProperty: "Keywords",
  cleanupOrphanSentinel: "__lore-cleanup-orphan",
  projectId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
}

describe("fetchNearDuplicateCandidatePageIds — F6 has_more handling", () => {
  it("throws SqlPartialResultError when the gateway returns has_more: true", async () => {
    const client = makeStubClient(() => ({
      results: [{ id: "p-1" }],
      has_more: true,
    }))
    await expect(
      fetchNearDuplicateCandidatePageIds(client, { ...NEAR_DUP_OPTS, limit: 50 }),
    ).rejects.toBeInstanceOf(SqlPartialResultError)
  })

  it("returns the page-id array when has_more is false", async () => {
    const client = makeStubClient(() => ({
      results: [{ id: "p-1" }, { id: "p-2" }],
      has_more: false,
    }))
    const ids = await fetchNearDuplicateCandidatePageIds(client, {
      ...NEAR_DUP_OPTS,
      limit: 50,
    })
    expect(ids).toEqual(["p-1", "p-2"])
  })

  it("composes the LIMIT clause from the caller's limit", async () => {
    let observedBody: Record<string, unknown> | undefined
    const client = makeStubClient((args) => {
      observedBody = args.body
      return { results: [], has_more: false }
    })
    await fetchNearDuplicateCandidatePageIds(client, { ...NEAR_DUP_OPTS, limit: 25 })
    const data = (observedBody?.["query_data_sources"] as { data: { query: string } }).data
    expect(data.query).toContain("LIMIT 25")
  })

  it("uses the verified exact-token tag predicate ahead of LIMIT", async () => {
    let observedBody: Record<string, unknown> | undefined
    const client = makeStubClient((args) => {
      observedBody = args.body
      return { results: [], has_more: false }
    })
    await fetchNearDuplicateCandidatePageIds(client, {
      ...NEAR_DUP_OPTS,
      tagsProperty: "Tags",
      tags: ["refactor", "infra"],
      limit: 50,
    })
    const data = (
      observedBody?.["query_data_sources"] as {
        data: { query: string; params?: string[] }
      }
    ).data
    expect(data.query).toMatch(/"Tags" LIKE \? OR "Tags" LIKE \?/)
    expect(data.query.indexOf("Tags")).toBeLessThan(data.query.indexOf("LIMIT"))
    expect(data.params).toEqual(
      expect.arrayContaining([`%"refactor"%`, `%"infra"%`]),
    )
  })

  it("rejects tag values with LIKE special characters (kebab-case validation)", async () => {
    const client = makeStubClient(() => ({ results: [], has_more: false }))
    for (const badTag of [`re"factor`, `re%factor`, `re_factor`, ``]) {
      await expect(
        fetchNearDuplicateCandidatePageIds(client, {
          ...NEAR_DUP_OPTS,
          tagsProperty: "Tags",
          tags: [badTag],
          limit: 50,
        }),
      ).rejects.toThrow(/kebab-case/)
    }
  })
})

describe("fetchEntityByNormalizedName", () => {
  it("issues a substring SQL query and returns id + raw name", async () => {
    const client = makeStubClient(() => ({
      results: [
        { id: "ent-1", name: "MemoryService" },
        { id: "ent-2", name: "MemoryServiceClient" },
      ],
      has_more: false,
    }))
    const result = await fetchEntityByNormalizedName(client, {
      dataSourceId: "ds-ent",
      nameProperty: "Name",
      normalizedName: "memoryservice",
    })
    expect(result).toEqual([
      { pageId: "ent-1", rawName: "MemoryService" },
      { pageId: "ent-2", rawName: "MemoryServiceClient" },
    ])
  })

  it("throws SqlPartialResultError on has_more: true", async () => {
    const client = makeStubClient(() => ({
      results: [{ id: "ent-1", name: "MemoryService" }],
      has_more: true,
    }))
    await expect(
      fetchEntityByNormalizedName(client, {
        dataSourceId: "ds-ent",
        nameProperty: "Name",
        normalizedName: "memoryservice",
      }),
    ).rejects.toBeInstanceOf(SqlPartialResultError)
  })

  it("returns empty on whitespace-only normalized name without calling Notion", async () => {
    const request = vi.fn()
    const client = { request } as unknown as Client
    expect(
      await fetchEntityByNormalizedName(client, {
        dataSourceId: "ds-ent",
        nameProperty: "Name",
        normalizedName: "",
      }),
    ).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })
})

describe("fetchEntitiesByAliasSubstring", () => {
  it("issues a substring SQL query against the Aliases column", async () => {
    const client = makeStubClient(() => ({
      results: [
        { id: "ent-1", aliases: "AuthSvc" },
        { id: "ent-2", aliases: "AuthService.create" },
      ],
      has_more: false,
    }))
    const result = await fetchEntitiesByAliasSubstring(client, {
      dataSourceId: "ds-ent",
      aliasesProperty: "Aliases",
      normalizedAlias: "authservice",
    })
    expect(result).toEqual([
      { pageId: "ent-1", rawAliases: "AuthSvc" },
      { pageId: "ent-2", rawAliases: "AuthService.create" },
    ])
  })

  it("throws SqlPartialResultError on has_more: true", async () => {
    const client = makeStubClient(() => ({
      results: [{ id: "ent-1", aliases: "AuthSvc" }],
      has_more: true,
    }))
    await expect(
      fetchEntitiesByAliasSubstring(client, {
        dataSourceId: "ds-ent",
        aliasesProperty: "Aliases",
        normalizedAlias: "authsvc",
      }),
    ).rejects.toBeInstanceOf(SqlPartialResultError)
  })
})

describe("fetchAlreadyComparedPairKeys", () => {
  it("returns unordered pair-keys for compared rows", async () => {
    const client = makeStubClient(() => ({
      results: [
        {
          id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          compared:
            "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb, cccccccccccccccccccccccccccccccc",
        },
      ],
      has_more: false,
    }))
    const pairs = await fetchAlreadyComparedPairKeys(client, {
      dataSourceId: "ds-mem",
      projectProperty: "Project",
      comparedWithProperty: "Compared With",
      projectId: "proj-a",
    })
    expect(pairs.size).toBe(2)
  })

  it("ignores self-references", async () => {
    const client = makeStubClient(() => ({
      results: [
        {
          id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          compared: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        },
      ],
      has_more: false,
    }))
    const pairs = await fetchAlreadyComparedPairKeys(client, {
      dataSourceId: "ds-mem",
      projectProperty: "Project",
      comparedWithProperty: "Compared With",
      projectId: "proj-a",
    })
    expect(pairs.size).toBe(0)
  })
})
