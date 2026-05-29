/**
 * End-to-end integration tests for the contains-mode memory-search filter
 * after issue 0.7.0/04. The fixture (`MemoriesFixtureVault`) faithfully
 * evaluates `dataSources.query` filters — recursing through `and` / `or`
 * compounds and applying case-insensitive `contains` over Title (title) and
 * Keywords / Synopsis (rich_text) — and sorts by `last_edited_time desc`
 * with cursor-based pagination. That fidelity lets these tests pin the
 * spec's fixture-vault acceptance criteria that pure mocks cannot:
 *
 *  - Synopsis-only rows actually surface from `mode: "contains"` because
 *    Notion's `contains` predicate matches the Synopsis column (not just
 *    because a `vi.fn` returned the row regardless of filter shape).
 *  - The post-#04 result set is a true superset of the pre-#04 set when the
 *    same query runs through both filter shapes against the same store.
 *  - At a bounded `limit`, top-N parity holds when no synopsis-only row is
 *    newer than the pre-#04 top-N; eviction is observable, not hidden,
 *    when one is — and the evicted row is reachable via the continuation
 *    cursor.
 *  - Synopsis hits cross `HYBRID_FALLBACK_THRESHOLD` legitimately: pre-#04
 *    a fixture with 2 title/keyword matches + 1 synopsis-only match
 *    under-shoots and routes through RRF; post-#04 the same fixture
 *    saturates and the resolved branch flips to `contains-saturated`.
 *
 * The fixture is deliberately minimal: it models only the property slots
 * `searchByContainsPages` reads (Title, Keywords, Synopsis) plus the
 * structural fields `pageToMemory` and `isFullPage` consume. Anything the
 * real service starts reading from a row that isn't modeled here will
 * throw — which is how a future change that, say, starts filtering on
 * `Decided At` gets caught at this seam.
 */

import { describe, expect, it } from "vitest"
import type {
  Client,
  PageObjectResponse,
  QueryDataSourceParameters,
} from "@notionhq/client"
import { MemoryService } from "./memory.js"
import { MEMORY_PROPS } from "../notion/schema.js"
import type { DatabaseRef } from "../types.js"

interface MemoryRow {
  id: string
  title: string
  keywords: string
  synopsis: string
  source: string
  lastEditedTime: string
}

type LeafFilter =
  | { property: typeof MEMORY_PROPS.TITLE; title: { contains: string } }
  | {
      property: typeof MEMORY_PROPS.KEYWORDS
      rich_text: { contains: string } | { does_not_contain: string }
    }
  | { property: typeof MEMORY_PROPS.SYNOPSIS; rich_text: { contains: string } }
  | { property: typeof MEMORY_PROPS.STATUS; select: { does_not_equal: string } }
  | { property: typeof MEMORY_PROPS.SOURCE; select: { does_not_equal: string } }
type CompoundFilter = { and?: Filter[] } | { or?: Filter[] }
type Filter = LeafFilter | CompoundFilter

class MemoriesFixtureVault {
  private rows: MemoryRow[] = []

  addMemory(row: {
    id: string
    title?: string
    keywords?: string
    synopsis?: string
    lastEditedTime: string
  }): void {
    this.rows.push({
      id: row.id,
      title: row.title ?? "",
      keywords: row.keywords ?? "",
      synopsis: row.synopsis ?? "",
      source: "manual",
      lastEditedTime: row.lastEditedTime,
    })
  }

  /**
   * Evaluate a Notion data-source filter against a single row. Models the
   * subset of the filter grammar `searchByContainsPages` actually emits —
   * `and` / `or` compounds plus `contains` leaves on Title / Keywords /
   * Synopsis. Notion's `contains` is case-insensitive; we mirror that.
   */
  private evaluate(row: MemoryRow, filter: Filter | undefined): boolean {
    if (!filter) return true
    if ("and" in filter && filter.and) {
      return filter.and.every((f) => this.evaluate(row, f))
    }
    if ("or" in filter && filter.or) {
      return filter.or.some((f) => this.evaluate(row, f))
    }
    if ("property" in filter) {
      if (filter.property === "Title" && "title" in filter) {
        return row.title.toLowerCase().includes(filter.title.contains.toLowerCase())
      }
      if (filter.property === "Keywords" && "rich_text" in filter) {
        // `Keywords` carries two filter shapes: the `contains` lane on
        // the precision text-match clause, and the `does_not_contain`
        // lane that excludes resurfaced cleanup-orphans (issue #477).
        // Model both faithfully — `does_not_contain` against an empty
        // rich_text returns true (no value, no substring), matching
        // Notion's intuitive semantics.
        if ("contains" in filter.rich_text) {
          return row.keywords
            .toLowerCase()
            .includes(filter.rich_text.contains.toLowerCase())
        }
        return !row.keywords
          .toLowerCase()
          .includes(filter.rich_text.does_not_contain.toLowerCase())
      }
      if (filter.property === "Synopsis" && "rich_text" in filter) {
        return row.synopsis
          .toLowerCase()
          .includes(filter.rich_text.contains.toLowerCase())
      }
      if (filter.property === "Status" && "select" in filter) {
        // Phase 2 of issue #281 introduces a default-exclude
        // `Status: { does_not_equal: "proposed" }` clause on
        // `MemoryService.search`. Fixture rows have no Status set, so
        // the extractor defaults to `"informational"` and the row passes
        // the exclusion. Modeled here so the fixture's exhaustiveness
        // throw doesn't reject the new clause.
        return "informational" !== filter.select.does_not_equal
      }
      if (filter.property === "Source" && "select" in filter) {
        return row.source !== filter.select.does_not_equal
      }
      // Inside-block throw — a future contributor adding a new property
      // leg (e.g. `Status select.equals`) who forgets to wire its arm
      // surfaces the omission immediately, instead of risking a silent
      // `false` fallthrough if an `else` branch ever lands here. The
      // exhaustiveness check below also surfaces unknown property names
      // at typecheck-time when the `Filter` union grows.
      const unknown: never = filter
      throw new Error(
        `MemoriesFixtureVault: property filter not modeled by the fixture: ${JSON.stringify(unknown)}`
      )
    }
    throw new Error(
      `MemoriesFixtureVault: unsupported filter shape ${JSON.stringify(filter)}`
    )
  }

  private buildPage(row: MemoryRow): PageObjectResponse {
    return {
      object: "page",
      id: row.id,
      created_time: row.lastEditedTime,
      last_edited_time: row.lastEditedTime,
      archived: false,
      url: `https://notion.so/${row.id}`,
      parent: { type: "data_source_id", data_source_id: MEMORIES_DB.dataSourceId },
      properties: {
        Title: {
          type: "title",
          title: [{ plain_text: row.title }],
        } as unknown,
        Keywords: {
          type: "rich_text",
          rich_text: row.keywords ? [{ plain_text: row.keywords }] : [],
        } as unknown,
        Synopsis: {
          type: "rich_text",
          rich_text: row.synopsis ? [{ plain_text: row.synopsis }] : [],
        } as unknown,
        Project: { type: "relation", relation: [] } as unknown,
        Topic: { type: "relation", relation: [] } as unknown,
        Source: { type: "select", select: { name: row.source } } as unknown,
        Tags: { type: "multi_select", multi_select: [] } as unknown,
      } as PageObjectResponse["properties"],
    } as PageObjectResponse
  }

  client(): Client {
    return {
      dataSources: {
        query: async (args: {
          data_source_id: string
          filter?: Filter
          page_size?: number
          start_cursor?: string
          sorts?: Array<{ timestamp: string; direction: string }>
        }) => {
          const matched = this.rows.filter((r) => this.evaluate(r, args.filter))
          // Recency sort: last_edited_time desc, mirroring `searchByContainsPages`.
          matched.sort((a, b) => b.lastEditedTime.localeCompare(a.lastEditedTime))
          const cursor = args.start_cursor
          const startIdx = cursor ? matched.findIndex((r) => r.id === cursor) + 1 : 0
          if (cursor && startIdx === 0) {
            // findIndex returned -1 → +1 = 0, but a real Notion cursor
            // would not be re-issued for a missing row. Treat as misuse.
            throw new Error(
              `MemoriesFixtureVault: start_cursor ${cursor} not found in result set`
            )
          }
          const pageSize = args.page_size ?? 100
          const page = matched.slice(startIdx, startIdx + pageSize)
          const hasMore = startIdx + pageSize < matched.length
          const nextCursor = hasMore ? page[page.length - 1].id : null
          return {
            results: page.map((r) => this.buildPage(r)),
            has_more: hasMore,
            next_cursor: nextCursor,
          }
        },
      },
      // The contains lane never calls `client.search`; the hybrid lane does
      // but its result is discarded under saturation. Empty-results stub
      // covers both.
      search: async () => ({ results: [] }),
      pages: {
        // Every test passes `includeContent: false`, so this stub is
        // never reached. Kept on the surface so a future contributor
        // enabling content materialization sees that the stub is
        // intentionally minimal — fill in real markdown then.
        retrieveMarkdown: async () => ({ markdown: "" }),
      },
    } as unknown as Client
  }
}

const MEMORIES_DB: DatabaseRef = {
  databaseId: "memories-db",
  dataSourceId: "memories-ds",
}

/**
 * Pre-#04 OR clause used for the simulation half of the superset / parity /
 * eviction / threshold-crossing tests. Issuing the same `dataSources.query`
 * with this filter against the fixture mirrors what `searchByContainsPages`
 * would have sent before issue 0.7.0/04 added the Synopsis branch.
 *
 * Returned as `QueryDataSourceParameters["filter"]` for ergonomic passthrough
 * to `client.dataSources.query`. The fixture's evaluator narrows back to
 * the local `Filter` shape, which is a structural subset of the SDK type.
 */
function preSynopsisOrClause(query: string): QueryDataSourceParameters["filter"] {
  return {
    or: [
      { property: MEMORY_PROPS.TITLE, title: { contains: query } },
      { property: MEMORY_PROPS.KEYWORDS, rich_text: { contains: query } },
    ],
  } as QueryDataSourceParameters["filter"]
}

/**
 * Post-#04 OR clause — the three-branch variant that
 * `searchByContainsPages` sends today. Used directly in the eviction
 * test where we need to walk the continuation cursor outside the service
 * surface.
 */
function postSynopsisOrClause(query: string): QueryDataSourceParameters["filter"] {
  return {
    or: [
      { property: MEMORY_PROPS.TITLE, title: { contains: query } },
      { property: MEMORY_PROPS.KEYWORDS, rich_text: { contains: query } },
      { property: MEMORY_PROPS.SYNOPSIS, rich_text: { contains: query } },
    ],
  } as QueryDataSourceParameters["filter"]
}

describe("memory search — Synopsis in contains-mode (issue 0.7.0/04)", () => {
  it("surfaces a synopsis-only row via Notion's contains predicate — title + keywords genuinely miss", async () => {
    // Spec acceptance: a fixture row with synopsis containing the query
    // string but whose title and keywords do NOT match returns from
    // mode: "contains". The fixture's filter evaluator is the source of
    // truth on whether the row matches — a Title/Keywords-only OR clause
    // would not surface this row, the post-#04 OR clause does.
    const vault = new MemoriesFixtureVault()
    vault.addMemory({
      id: "title-hit",
      title: "rationale chain audit",
      lastEditedTime: "2026-04-10T00:00:00.000Z",
    })
    vault.addMemory({
      id: "synopsis-only",
      title: "Adopt DecisionService",
      keywords: "service architecture",
      synopsis: "Replaces freeform rationale notes with traversable chain.",
      lastEditedTime: "2026-04-12T00:00:00.000Z",
    })
    vault.addMemory({
      id: "no-match",
      title: "Unrelated heading",
      keywords: "other tokens",
      synopsis: "Independent topic.",
      lastEditedTime: "2026-04-11T00:00:00.000Z",
    })

    const client = vault.client()
    const service = new MemoryService(client, MEMORIES_DB)

    // Pre-#04 simulation: only Title/Keywords surface the rationale match.
    const preResponse = await client.dataSources.query({
      data_source_id: MEMORIES_DB.dataSourceId,
      filter: preSynopsisOrClause("rationale"),
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: 100,
    })
    const preIds = (preResponse.results as PageObjectResponse[]).map((p) => p.id)
    expect(preIds).toEqual(["title-hit"])

    // Post-#04 (the actual service path): Synopsis-only row also surfaces.
    const post = await service.search({
      query: "rationale",
      mode: "contains",
      includeContent: false,
    })
    expect(post.map((m) => m.id).sort()).toEqual(["synopsis-only", "title-hit"])
    expect(post.find((m) => m.id === "synopsis-only")?.synopsis).toBe(
      "Replaces freeform rationale notes with traversable chain."
    )
  })

  it("post-#04 result set is a true superset of pre-#04 at limit=100 (filter-level superset)", async () => {
    // Spec acceptance: filter-level superset — every row pre-#04 returned
    // for a query is in the post-#04 result set on a fixture vault.
    const vault = new MemoriesFixtureVault()
    // Title-only, keyword-only, and synopsis-only matches plus a non-match
    // distractor. Distinct lastEditedTime so the sort is unambiguous.
    vault.addMemory({
      id: "title-match",
      title: "decision audit log",
      lastEditedTime: "2026-04-15T00:00:00.000Z",
    })
    vault.addMemory({
      id: "keywords-match",
      title: "Header that does not include the term",
      keywords: "decision-graph relations",
      lastEditedTime: "2026-04-14T00:00:00.000Z",
    })
    vault.addMemory({
      id: "synopsis-match",
      title: "Header that does not include the term",
      keywords: "service architecture",
      synopsis: "Records the decision rationale chain end to end.",
      lastEditedTime: "2026-04-13T00:00:00.000Z",
    })
    vault.addMemory({
      id: "distractor",
      title: "completely unrelated",
      keywords: "tokens",
      synopsis: "no overlap with the query",
      lastEditedTime: "2026-04-12T00:00:00.000Z",
    })

    const client = vault.client()
    const service = new MemoryService(client, MEMORIES_DB)

    const preResponse = await client.dataSources.query({
      data_source_id: MEMORIES_DB.dataSourceId,
      filter: preSynopsisOrClause("decision"),
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: 100,
    })
    const preIds = new Set((preResponse.results as PageObjectResponse[]).map((p) => p.id))
    const post = await service.search({
      query: "decision",
      mode: "contains",
      limit: 100,
      includeContent: false,
    })
    const postIds = new Set(post.map((m) => m.id))

    // Pre returns title + keywords matches; post adds the synopsis match.
    expect(preIds).toEqual(new Set(["title-match", "keywords-match"]))
    expect(postIds).toEqual(new Set(["title-match", "keywords-match", "synopsis-match"]))
    // Subset assertion: every pre id is in post.
    for (const id of preIds) {
      expect(postIds.has(id)).toBe(true)
    }
  })

  it("bounded-page parity at limit=5 — no synopsis-only newer rows means top-5 ids and order are identical pre/post", async () => {
    // Spec acceptance: a fixture vault whose top-5 pre-#04 matches are
    // all also post-#04 matches returns identical top-5 (same ids, same
    // order). Constructed with no synopsis-only row newer than the
    // pre-#04 top-5.
    const vault = new MemoriesFixtureVault()
    // Six title-matched rows so pre-#04 has more than the limit.
    vault.addMemory({
      id: "t-1",
      title: "decision row one",
      lastEditedTime: "2026-04-20T00:00:00.000Z",
    })
    vault.addMemory({
      id: "t-2",
      title: "decision row two",
      lastEditedTime: "2026-04-19T00:00:00.000Z",
    })
    vault.addMemory({
      id: "t-3",
      title: "decision row three",
      lastEditedTime: "2026-04-18T00:00:00.000Z",
    })
    vault.addMemory({
      id: "t-4",
      title: "decision row four",
      lastEditedTime: "2026-04-17T00:00:00.000Z",
    })
    vault.addMemory({
      id: "t-5",
      title: "decision row five",
      lastEditedTime: "2026-04-16T00:00:00.000Z",
    })
    vault.addMemory({
      id: "t-6",
      title: "decision row six",
      lastEditedTime: "2026-04-15T00:00:00.000Z",
    })
    // Synopsis-only row that is older than the top-5 — it surfaces in
    // post-#04 but cannot evict any pre-#04 top-5 row.
    vault.addMemory({
      id: "synopsis-older",
      title: "unrelated",
      synopsis: "decision rationale older than the top-5",
      lastEditedTime: "2026-04-10T00:00:00.000Z",
    })

    const client = vault.client()
    const service = new MemoryService(client, MEMORIES_DB)

    const preResponse = await client.dataSources.query({
      data_source_id: MEMORIES_DB.dataSourceId,
      filter: preSynopsisOrClause("decision"),
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: 5,
    })
    const preTop5 = (preResponse.results as PageObjectResponse[]).map((p) => p.id)
    const post = await service.search({
      query: "decision",
      mode: "contains",
      limit: 5,
      includeContent: false,
    })
    const postTop5 = post.map((m) => m.id)

    // Same five ids, same order — the synopsis-only row is older than the
    // pre-#04 top-5, so it never enters the bounded page.
    expect(preTop5).toEqual(["t-1", "t-2", "t-3", "t-4", "t-5"])
    expect(postTop5).toEqual(preTop5)
  })

  it("eviction is observable at limit=5 — synopsis-only newer row enters the page; evicted pre-#04 row is reachable via cursor", async () => {
    // Spec acceptance: a fixture vault where a synopsis-only newer row
    // exists returns that row in the post-#04 top-5; at least one pre-#04
    // result is evicted to the continuation page (`has_more: true`); the
    // evicted row is reachable via cursor.
    const vault = new MemoriesFixtureVault()
    // Five title-matched rows, then a synopsis-only row that is newer
    // than all of them.
    vault.addMemory({
      id: "t-1",
      title: "decision row one",
      lastEditedTime: "2026-04-20T00:00:00.000Z",
    })
    vault.addMemory({
      id: "t-2",
      title: "decision row two",
      lastEditedTime: "2026-04-19T00:00:00.000Z",
    })
    vault.addMemory({
      id: "t-3",
      title: "decision row three",
      lastEditedTime: "2026-04-18T00:00:00.000Z",
    })
    vault.addMemory({
      id: "t-4",
      title: "decision row four",
      lastEditedTime: "2026-04-17T00:00:00.000Z",
    })
    vault.addMemory({
      id: "t-5",
      title: "decision row five",
      lastEditedTime: "2026-04-16T00:00:00.000Z",
    })
    vault.addMemory({
      id: "synopsis-newest",
      title: "unrelated",
      synopsis: "decision rationale that is the newest row",
      lastEditedTime: "2026-04-21T00:00:00.000Z",
    })

    const client = vault.client()
    const service = new MemoryService(client, MEMORIES_DB)

    // Pre-#04 simulation: top-5 are t-1..t-5, no eviction (only 5 rows match).
    const preResponse = await client.dataSources.query({
      data_source_id: MEMORIES_DB.dataSourceId,
      filter: preSynopsisOrClause("decision"),
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: 5,
    })
    const preTop5 = (preResponse.results as PageObjectResponse[]).map((p) => p.id)
    expect(preTop5).toEqual(["t-1", "t-2", "t-3", "t-4", "t-5"])
    expect(preResponse.has_more).toBe(false)

    // Post-#04: synopsis-newest leads, t-5 is evicted to the continuation.
    const post = await service.search({
      query: "decision",
      mode: "contains",
      limit: 5,
      includeContent: false,
    })
    const postTop5 = post.map((m) => m.id)
    expect(postTop5).toEqual(["synopsis-newest", "t-1", "t-2", "t-3", "t-4"])
    // t-5 fell off post-#04's page.
    expect(postTop5).not.toContain("t-5")
    const preSet = new Set(preTop5)
    const postSet = new Set(postTop5)
    const evicted = [...preSet].filter((id) => !postSet.has(id))
    expect(evicted).toEqual(["t-5"])

    // Eviction must be reachable, not hidden. The post-#04 continuation
    // includes the evicted row at the head of the next page. We re-issue
    // the post-#04 query with the cursor returned for the post-#04 top-5
    // — the SDK doesn't surface that on the service return shape, so
    // walk the data-source query directly.
    const postFirstPage = await client.dataSources.query({
      data_source_id: MEMORIES_DB.dataSourceId,
      filter: postSynopsisOrClause("decision"),
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: 5,
    })
    expect(postFirstPage.has_more).toBe(true)
    expect(postFirstPage.next_cursor).toBe("t-4")
    const postContinuation = await client.dataSources.query({
      data_source_id: MEMORIES_DB.dataSourceId,
      filter: postSynopsisOrClause("decision"),
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: 5,
      start_cursor: postFirstPage.next_cursor!,
    })
    const continuationIds = (postContinuation.results as PageObjectResponse[]).map(
      (p) => p.id
    )
    expect(continuationIds).toContain("t-5")
    expect(postContinuation.has_more).toBe(false)
  })

  it("hybrid threshold-crossing — pre-#04 (2 hits) routes through RRF, post-#04 (3 hits) saturates", async () => {
    // Spec acceptance: branch stability is fixture-conditional. A query
    // whose contains count crosses HYBRID_FALLBACK_THRESHOLD post-#04
    // (because Synopsis adds matches that pre-#04 missed) legitimately
    // flips from "rrf" to "contains-saturated". The pre-#04 reduction is
    // demonstrated explicitly via a direct dataSources.query — the
    // counterfactual that justifies the post-#04 branch flip.
    const vault = new MemoriesFixtureVault()
    vault.addMemory({
      id: "title-1",
      title: "decision a",
      lastEditedTime: "2026-04-20T00:00:00.000Z",
    })
    vault.addMemory({
      id: "keywords-1",
      title: "header",
      keywords: "decision tokens",
      lastEditedTime: "2026-04-19T00:00:00.000Z",
    })
    vault.addMemory({
      id: "synopsis-1",
      title: "header",
      synopsis: "decision rationale text",
      lastEditedTime: "2026-04-18T00:00:00.000Z",
    })

    const client = vault.client()
    const service = new MemoryService(client, MEMORIES_DB)

    // Pre-#04 counterfactual: 2 contains hits (Title + Keywords). Below the
    // threshold of 3, so a hybrid pipeline pre-#04 would have RRF-merged
    // with semantic.
    const preResponse = await client.dataSources.query({
      data_source_id: MEMORIES_DB.dataSourceId,
      filter: preSynopsisOrClause("decision"),
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: 10,
    })
    const preIds = (preResponse.results as PageObjectResponse[]).map((p) => p.id)
    expect(preIds).toEqual(["title-1", "keywords-1"])
    expect(preIds.length).toBeLessThan(3)

    // Post-#04: same fixture, but the Synopsis branch lifts the count to 3,
    // saturating the threshold. searchWithExplain reports
    // `contains-saturated` and discards the (empty) semantic result.
    const { memories, explain } = await service.searchWithExplain({
      query: "decision",
      mode: "hybrid",
      includeContent: false,
    })
    expect(memories.map((m) => m.id)).toEqual(["title-1", "keywords-1", "synopsis-1"])
    expect(memories.length).toBeGreaterThanOrEqual(3)
    for (const e of explain) {
      expect(e.branch).toBe("contains-saturated")
    }
  })
})
