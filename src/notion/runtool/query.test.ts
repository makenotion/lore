import { describe, expect, it, vi } from "vitest"
import type { Client } from "@notionhq/client"
import {
  extractFirstRelationId,
  fetchAlreadyComparedPairKeys,
  fetchEntitiesByAliasSubstring,
  fetchEntityByNormalizedName,
  fetchNearDuplicateCandidatePageIds,
  querySubjectGroupCountsViaRunTool,
} from "./query.js"
import { isRunToolAggregateEnabled, isRunToolEnabled } from "./flag.js"
import { SqlPartialResultError } from "./error-helpers.js"

function makeStubClient(
  responder: (args: {
    method: string
    path: string
    body: Record<string, unknown>
  }) => unknown
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
  sourceProperty: "Source",
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
      fetchNearDuplicateCandidatePageIds(client, { ...NEAR_DUP_OPTS, limit: 50 })
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
    const data = (observedBody?.["query_data_sources"] as { data: { query: string } })
      .data
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
    expect(data.params).toEqual(expect.arrayContaining([`%"refactor"%`, `%"infra"%`]))
  })

  it("pushes excluded sources into the SQL predicate ahead of LIMIT", async () => {
    let observedBody: Record<string, unknown> | undefined
    const client = makeStubClient((args) => {
      observedBody = args.body
      return { results: [], has_more: false }
    })
    await fetchNearDuplicateCandidatePageIds(client, {
      ...NEAR_DUP_OPTS,
      excludeSources: ["agent_diary"],
      limit: 50,
    })
    const data = (
      observedBody?.["query_data_sources"] as {
        data: { query: string; params?: string[] }
      }
    ).data
    expect(data.query).toMatch(/"Source" NOT IN \(\?\) OR "Source" IS NULL/)
    expect(data.query.indexOf("Source")).toBeLessThan(data.query.indexOf("LIMIT"))
    expect(data.params).toEqual(expect.arrayContaining(["agent_diary"]))
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
        })
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
      })
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
      })
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
      })
    ).rejects.toBeInstanceOf(SqlPartialResultError)
  })
})

describe("fetchAlreadyComparedPairKeys", () => {
  const COMPARED_OPTS = {
    dataSourceId: "ds-mem",
    projectProperty: "Project",
    comparedWithProperty: "Compared With",
    projectId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  }

  it("throws SqlPartialResultError on has_more: true", async () => {
    const client = makeStubClient(() => ({
      results: [
        {
          id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          compared: '["https://www.notion.so/cccccccccccccccccccccccccccccccc"]',
        },
      ],
      has_more: true,
    }))

    await expect(
      fetchAlreadyComparedPairKeys(client, COMPARED_OPTS)
    ).rejects.toBeInstanceOf(SqlPartialResultError)
  })

  it("extracts unordered compared pair keys when has_more is false", async () => {
    const client = makeStubClient(() => ({
      results: [
        {
          id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          compared: '["https://www.notion.so/cccccccccccccccccccccccccccccccc"]',
        },
      ],
      has_more: false,
    }))

    const pairs = await fetchAlreadyComparedPairKeys(client, COMPARED_OPTS)

    expect([...pairs]).toEqual([
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb::cccccccccccccccccccccccccccccccc",
    ])
  })
})

describe("isRunToolAggregateEnabled", () => {
  it("inherits from LORE_USE_RUNTOOL when the sub-flag is unset", () => {
    expect(isRunToolAggregateEnabled({ LORE_USE_RUNTOOL: "1" })).toBe(true)
    expect(isRunToolAggregateEnabled({ LORE_USE_RUNTOOL: "0" })).toBe(false)
  })

  it("lets LORE_USE_RUNTOOL_AGGREGATE override the parent flag", () => {
    expect(
      isRunToolAggregateEnabled({
        LORE_USE_RUNTOOL: "1",
        LORE_USE_RUNTOOL_AGGREGATE: "0",
      })
    ).toBe(false)
    expect(
      isRunToolAggregateEnabled({
        LORE_USE_RUNTOOL: "0",
        LORE_USE_RUNTOOL_AGGREGATE: "1",
      })
    ).toBe(true)
  })

  it("defaults on with no env vars set (issue #543 Phase 4 flip)", () => {
    expect(isRunToolAggregateEnabled({})).toBe(true)
    expect(isRunToolEnabled({})).toBe(true)
  })

  it("ignores unrecognized values, falling through to the default-on parent", () => {
    expect(isRunToolAggregateEnabled({ LORE_USE_RUNTOOL_AGGREGATE: "maybe" })).toBe(true)
  })
})

describe("querySubjectGroupCountsViaRunTool — issue #542 aggregate", () => {
  const AGG_OPTS = {
    factsDataSourceId: "ds-facts",
    subjectProperty: "Subject",
    subjectEntityProperty: "SubjectEntity",
    projectProperty: "Project",
  }

  it("emits a GROUP BY query and folds rows into the typed shape", async () => {
    let observedBody: Record<string, unknown> | undefined
    const client = makeStubClient((args) => {
      observedBody = args.body
      return {
        results: [
          {
            subjectEntity: `["https://www.notion.so/11111111111111111111111111111111"]`,
            subject: "MemoryService.create",
            cnt: 3,
          },
          { subjectEntity: null, subject: "DataSourceQuery", cnt: 1 },
        ],
        has_more: false,
      }
    })
    const rows = await querySubjectGroupCountsViaRunTool(client, AGG_OPTS)
    expect(rows).toEqual([
      {
        subjectEntityRaw: `["https://www.notion.so/11111111111111111111111111111111"]`,
        subject: "MemoryService.create",
        count: 3,
      },
      { subjectEntityRaw: null, subject: "DataSourceQuery", count: 1 },
    ])
    const data = (
      observedBody?.["query_data_sources"] as {
        data: { query: string; params?: string[] }
      }
    ).data
    // GROUP BY composition pinned — the canonical key fold relies
    // on both columns being grouped. Dropping `Subject` would
    // collapse case-variants server-side, breaking the
    // narrow-then-rematch invariant the aggregate helper documents.
    expect(data.query).toContain("GROUP BY")
    expect(data.query).toMatch(/GROUP BY\s+"SubjectEntity",\s*"Subject"/)
    // No `Valid Until` filter — verified 2026-05-06 against the
    // dogfood vault that the SQL gateway returns `no such column`
    // for every spelling of the date column. Counts all facts
    // including invalidated; equivalence with the JS fallback is
    // preserved by the call site passing `includeInvalidated: true`.
    expect(data.query).not.toMatch(/Valid Until/)
    expect(data.params).toEqual([])
  })

  it("scopes to a project via undashed-id LIKE when projectId is provided", async () => {
    let observedBody: Record<string, unknown> | undefined
    const client = makeStubClient((args) => {
      observedBody = args.body
      return { results: [], has_more: false }
    })
    await querySubjectGroupCountsViaRunTool(client, {
      ...AGG_OPTS,
      projectId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    })
    const data = (
      observedBody?.["query_data_sources"] as {
        data: { query: string; params?: string[] }
      }
    ).data
    expect(data.query).toMatch(/"Project" LIKE \?/)
    // Production-vault verification (2026-05-05) found relation
    // columns store the **undashed** id form. The pin makes a
    // future "let's pass the dashed form through" refactor fail
    // loudly.
    expect(data.params).toEqual(["%aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa%"])
  })

  it("omits the WHERE clause entirely when no projectId is provided", async () => {
    let observedBody: Record<string, unknown> | undefined
    const client = makeStubClient((args) => {
      observedBody = args.body
      return { results: [], has_more: false }
    })
    await querySubjectGroupCountsViaRunTool(client, AGG_OPTS)
    const data = (
      observedBody?.["query_data_sources"] as {
        data: { query: string; params?: string[] }
      }
    ).data
    // No predicates → no WHERE. The previous implementation always
    // emitted a WHERE on `Valid Until`; without the date column
    // available, an empty predicate set must produce a syntactically
    // clean `SELECT … FROM … GROUP BY …` rather than a dangling
    // `WHERE GROUP BY …`.
    expect(data.query).not.toMatch(/WHERE/i)
    expect(data.query).toMatch(/FROM "collection:\/\/[^"]+" GROUP BY/)
  })

  it("throws SqlPartialResultError on has_more: true", async () => {
    const client = makeStubClient(() => ({
      results: [{ subjectEntity: null, subject: "Foo", cnt: 1 }],
      has_more: true,
    }))
    await expect(
      querySubjectGroupCountsViaRunTool(client, AGG_OPTS)
    ).rejects.toBeInstanceOf(SqlPartialResultError)
  })

  it("drops aggregate rows whose count cannot be coerced to a number", async () => {
    const client = makeStubClient(() => ({
      results: [
        { subjectEntity: null, subject: "Foo", cnt: 5 },
        { subjectEntity: null, subject: "Bar", cnt: null },
        { subjectEntity: null, subject: "Baz", cnt: "not-a-number" },
      ],
      has_more: false,
    }))
    const rows = await querySubjectGroupCountsViaRunTool(client, AGG_OPTS)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ subject: "Foo", count: 5 })
  })
})

describe("extractFirstRelationId", () => {
  it("rehydrates the dashed canonical form from a JSON-array URL value", () => {
    const raw = `["https://dev.notion.so/11111111111111111111111111111111"]`
    expect(extractFirstRelationId(raw)).toBe("11111111-1111-1111-1111-111111111111")
  })

  it("returns null for empty / null / '[]' values", () => {
    expect(extractFirstRelationId(null)).toBe(null)
    expect(extractFirstRelationId("")).toBe(null)
    expect(extractFirstRelationId("[]")).toBe(null)
    expect(extractFirstRelationId("   ")).toBe(null)
  })

  it("returns null when no Notion id matches", () => {
    expect(extractFirstRelationId("not-a-uuid-at-all")).toBe(null)
  })

  it("rejects free-floating 32-hex runs that aren't in URL form (PR #547 review)", () => {
    // Anchor pin: a cell that contains 32 contiguous hex chars but
    // NOT in the documented JSON-array-of-URLs shape must NOT be
    // mistaken for a populated SubjectEntity. Without this anchor,
    // a row whose `subject` happened to contain "garbage 11111111111111111111111111111111
    // trailing" would silently key on `entity:11111111-...` instead
    // of falling through to `key:<computeSubjectKey(subject)>`.
    expect(
      extractFirstRelationId("garbage 11111111111111111111111111111111 trailing")
    ).toBe(null)
    expect(extractFirstRelationId("11111111-1111-1111-1111-111111111111")).toBe(null)
    expect(extractFirstRelationId("11111111111111111111111111111111")).toBe(null)
  })

  it("accepts both undashed and dashed ids in URL form", () => {
    // Production today: undashed form. Dashed-alternation is defense
    // in depth against a future schema-pin refresh.
    const undashed = `["https://www.notion.so/22222222222222222222222222222222"]`
    expect(extractFirstRelationId(undashed)).toBe("22222222-2222-2222-2222-222222222222")
    const dashed = `["https://www.notion.so/22222222-2222-2222-2222-222222222222"]`
    expect(extractFirstRelationId(dashed)).toBe("22222222-2222-2222-2222-222222222222")
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
