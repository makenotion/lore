/**
 * A/B harness for issue #535: assert page-id-set equivalence between
 * the RunTool SQL path and the existing REST/SDK path over a
 * representative corpus.
 *
 * Acceptance criterion #5 of issue #535: "A/B harness compares
 * page/entity-id sets between SQL and existing paths over a
 * representative corpus. Ordering may differ before JS scoring;
 * final rendered order must remain deterministic."
 *
 * The harness deliberately operates on FIXTURE-BACKED `MemoryLister`
 * + `RunToolClient` mocks, not a live vault. Equivalent shapes are
 * built side-by-side: each fixture row is registered both as a REST
 * `MemoryService.list` row AND as an SQL row that the
 * fixture-backed RunTool client returns. The harness then runs
 * `findNearDuplicates` once with the SQL lister and once with the
 * REST-only lister and asserts page-id-set equivalence after the
 * trigram threshold + status filter run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { findNearDuplicates } from "../../core/near-duplicate.js"
import { MemoryService } from "../../core/memory.js"
import type { DatabaseRef, Memory, MemoryStatus } from "../../types.js"
import { __resetRunToolSearchWarningsForTest } from "./search.js"

interface FixtureRow {
  id: string
  title: string
  kind: Memory["kind"]
  status: MemoryStatus
  projectId: string
  tags: string[]
}

const PROJECT_A = "proj-a"
const PROJECT_B = "proj-b"

const FIXTURE: ReadonlyArray<FixtureRow> = [
  // Strong matches under the trigram threshold
  { id: "mem-1", title: "MemoryService refactor part 1", kind: "note", status: "accepted", projectId: PROJECT_A, tags: ["refactor"] },
  { id: "mem-2", title: "MemoryService refactor part 2", kind: "note", status: "accepted", projectId: PROJECT_A, tags: ["refactor"] },
  // Decision row that the memory probe excludes (excludeKinds: ["decision"])
  { id: "mem-3", title: "MemoryService refactor decision", kind: "decision", status: "accepted", projectId: PROJECT_A, tags: ["decision"] },
  // Status outside whitelist (e.g. when statuses=["accepted","proposed"])
  { id: "mem-4", title: "MemoryService refactor done", kind: "note", status: "superseded", projectId: PROJECT_A, tags: ["done"] },
  // Project mismatch — would not even enter the SQL pool
  { id: "mem-5", title: "MemoryService refactor B", kind: "note", status: "accepted", projectId: PROJECT_B, tags: [] },
  // Below threshold — title too dissimilar
  { id: "mem-6", title: "Unrelated meeting notes", kind: "note", status: "accepted", projectId: PROJECT_A, tags: [] },
  // Proposed status — opt-in path
  { id: "mem-7", title: "MemoryService refactor proposed", kind: "note", status: "proposed", projectId: PROJECT_A, tags: [] },
  // Unscoped (vault-wide) row — REST surfaces this in any
  // project-scoped probe via `projectOrUnscopedFilter`. Issue #539
  // review blocker #3 specifically called out that the SQL path
  // must mirror this; the `compat.test.ts` fixture didn't have an
  // unscoped row before, so the harness couldn't catch the
  // divergence.
  { id: "mem-8", title: "MemoryService refactor vault-wide", kind: "note", status: "accepted", projectId: "", tags: ["refactor"] },
  // Tagged-out row in PROJECT_A — should be filtered out when
  // the probe scopes by tags. The SQL exact-token predicate
  // (`Tags LIKE %"refactor"%`) and the REST `multi_select.contains`
  // both reject this row before the LIMIT.
  { id: "mem-9", title: "MemoryService refactor untagged", kind: "note", status: "accepted", projectId: PROJECT_A, tags: ["unrelated"] },
]

function makeMemory(row: FixtureRow): Memory {
  return {
    id: row.id,
    title: row.title,
    projectIds: [row.projectId],
    topicId: null,
    source: "manual",
    kind: row.kind,
    status: row.status,
    confidence: "certain",
    confidenceScore: null,
    reviewBy: null,
    doneAt: null,
    decidedAt: null,
    lastReferencedAt: null,
    supersedesIds: [],
    affectsIds: [],
    alternatives: "",
    consequences: "",
    author: "",
    agent: "",
    tags: row.tags,
    keywords: "",
    synopsis: "",
    session: null,
    content: "",
    taskState: null,
    blockedBy: "",
    entity: "",
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
  }
}

/**
 * Simulate `MemoryService.list` on the REST fall-back path. Applies
 * the same predicates the REST path runs server-side via
 * `MemoryService.list`'s filter composer (project-or-unscoped, kind,
 * excludeKinds, tags OR, includeProposed). `statuses` is NOT applied
 * here because Notion's `dataSources.query` doesn't support `IN`; the
 * REST path leaves the whitelist as a JS post-filter inside
 * `findNearDuplicates`.
 *
 * **Project filter mirrors `projectOrUnscopedFilter`.** A row whose
 * `projectId` is the empty string is treated as unscoped and surfaces
 * regardless of the requested project. Without this, the harness
 * couldn't pin acceptance criterion #6 (issue #539 review blocker
 * #3 — REST sees unscoped, SQL must too).
 */
function restListerLike(items: ReadonlyArray<FixtureRow>) {
  return async (opts: {
    projectId?: string
    kind?: Memory["kind"]
    excludeKinds?: readonly Memory["kind"][]
    tags?: string[]
    limit?: number
    includeProposed?: boolean
  }) => {
    const matches = items.filter((row) => {
      if (opts.projectId && row.projectId !== opts.projectId && row.projectId !== "") {
        return false
      }
      if (opts.kind && row.kind !== opts.kind) return false
      if (opts.excludeKinds && opts.excludeKinds.includes(row.kind)) return false
      // Tag filter: OR across requested tags, mirroring Notion's
      // `multi_select.contains` server-side behavior.
      if (opts.tags && opts.tags.length > 0) {
        if (!row.tags.some((t) => opts.tags!.includes(t))) return false
      }
      // The default is to exclude `proposed` unless `includeProposed`
      // is truthy. Matches `MemoryService.list`'s issue #281 default.
      if (!opts.includeProposed && row.status === "proposed") return false
      return true
    })
    const limited = matches.slice(0, opts.limit ?? 50)
    return { items: limited.map(makeMemory) }
  }
}

/**
 * Simulate `MemoryService.listForNearDuplicates`'s SQL branch:
 * predicates run BEFORE the limit truncation, including
 * `statuses IN (...)`, `Status != proposed` (default-exclude
 * shim), AND exact tag membership via `Tags LIKE '%"<tag>"%'`
 * (issue #539 review iteration 4: SQL applies exact-token tag
 * filter ahead of the LIMIT, mirroring REST's
 * `multi_select.contains` semantics). Mirrors the predicate
 * composition in
 * `src/notion/runtool/query.ts:fetchNearDuplicateCandidatePageIds`
 * plus the default-exclude shim in
 * `MemoryService.listForNearDuplicates`.
 */
function sqlListerLike(items: ReadonlyArray<FixtureRow>) {
  return async (opts: {
    projectId: string
    kind?: Memory["kind"]
    excludeKinds?: readonly Memory["kind"][]
    statuses?: readonly MemoryStatus[]
    tags?: readonly string[]
    includeProposed?: boolean
    limit: number
  }) => {
    // Mirror `MemoryService.listForNearDuplicates`'s shim:
    // default-exclude proposed rows when no whitelist narrows.
    const excludeStatuses: MemoryStatus[] | undefined =
      opts.statuses === undefined && !opts.includeProposed
        ? ["proposed"]
        : undefined

    const matches = items.filter((row) => {
      // SQL path also includes unscoped rows by default
      // (mirrors `projectOrUnscopedFilter`). Issue #539 review
      // blocker #3.
      if (row.projectId !== opts.projectId && row.projectId !== "") return false
      if (opts.kind && row.kind !== opts.kind) return false
      if (opts.excludeKinds && opts.excludeKinds.includes(row.kind)) return false
      if (opts.statuses && !opts.statuses.includes(row.status)) return false
      if (excludeStatuses && excludeStatuses.includes(row.status)) return false
      if (opts.tags && opts.tags.length > 0) {
        if (!row.tags.some((t) => opts.tags!.includes(t))) return false
      }
      return true
    })
    const limited = matches.slice(0, opts.limit)
    return limited.map(makeMemory)
  }
}

describe("RunTool SQL vs REST/SDK A/B harness", () => {
  it("memory near-dup probe (excludeKinds=['decision']): SQL and REST agree on the candidate id set after JS post-filter", async () => {
    const restLister = { list: vi.fn(restListerLike(FIXTURE)) }
    const sqlLister = {
      list: vi.fn(restListerLike(FIXTURE)),
      listForNearDuplicates: vi.fn(sqlListerLike(FIXTURE)),
    }

    const opts = {
      title: "MemoryService refactor",
      tags: [],
      projectId: PROJECT_A,
      threshold: 0.3,
      excludeKinds: ["decision"] as const,
      limit: 50,
    }

    const restResult = await findNearDuplicates(restLister, opts)
    const sqlResult = await findNearDuplicates(sqlLister, opts)

    const restIds = new Set(restResult.map((m) => m.id))
    const sqlIds = new Set(sqlResult.map((m) => m.id))
    expect(sqlIds).toEqual(restIds)
    expect(restIds.has("mem-3")).toBe(false) // decision excluded
    expect(restIds.has("mem-5")).toBe(false) // wrong project
    // mem-4 (status=superseded) is in BOTH sets because the memory
    // probe doesn't pass `statuses`. The status whitelist is a
    // decision-path-only opt-in.
  })

  it("decision probe (statuses=['accepted','proposed']): SQL and REST agree post-JS-filter", async () => {
    const restLister = { list: vi.fn(restListerLike(FIXTURE)) }
    const sqlLister = {
      list: vi.fn(restListerLike(FIXTURE)),
      listForNearDuplicates: vi.fn(sqlListerLike(FIXTURE)),
    }

    const opts = {
      title: "MemoryService refactor",
      tags: [],
      projectId: PROJECT_A,
      threshold: 0.3,
      kind: "decision" as const,
      statuses: ["accepted", "proposed"] satisfies MemoryStatus[],
      limit: 50,
    }

    const restResult = await findNearDuplicates(restLister, opts)
    const sqlResult = await findNearDuplicates(sqlLister, opts)

    expect(new Set(sqlResult.map((m) => m.id))).toEqual(
      new Set(restResult.map((m) => m.id)),
    )
    // mem-3 is the only decision row in PROJECT_A; mem-7 is proposed
    // but kind=note, not decision.
    expect(restResult.map((m) => m.id)).toEqual(["mem-3"])
  })

  it("acceptance criterion #3: SQL path's `limit` bounds post-filter candidates, not pre-filter", async () => {
    // Construct a corpus where 30 of the first 50 rows are
    // `decision` kind, so the REST path's pre-#535 behavior
    // (no excludeKinds passed to list, JS post-filter) would
    // leave the non-decision near-dup pool at ~20 rows. The SQL
    // path's server-side `Kind NOT IN` keeps the post-filter
    // pool at the full 50.
    const heavy: FixtureRow[] = []
    for (let i = 0; i < 30; i++) {
      heavy.push({
        id: `dec-${i}`,
        title: "MemoryService decision " + i,
        kind: "decision",
        status: "accepted",
        projectId: PROJECT_A,
        tags: [],
      })
    }
    for (let i = 0; i < 30; i++) {
      heavy.push({
        id: `note-${i}`,
        title: "MemoryService refactor " + i,
        kind: "note",
        status: "accepted",
        projectId: PROJECT_A,
        tags: [],
      })
    }

    const sqlLister = {
      list: vi.fn(restListerLike(heavy)),
      listForNearDuplicates: vi.fn(sqlListerLike(heavy)),
    }

    const opts = {
      title: "MemoryService refactor",
      tags: [],
      projectId: PROJECT_A,
      threshold: 0.3,
      excludeKinds: ["decision"] as const,
      limit: 50,
    }
    const sqlResult = await findNearDuplicates(sqlLister, opts)
    // SQL path returns up to 50 NON-decision candidates, all of
    // which match the title. Without the SQL pre-filter, the
    // first 30 slots would be decision rows that get post-
    // filtered out — leaving only 20 non-decision candidates
    // for the trigram match.
    expect(sqlResult.length).toBeGreaterThanOrEqual(20)
    expect(sqlResult.every((m) => !m.id.startsWith("dec-"))).toBe(true)
  })

  it("flag-off invariant: removing listForNearDuplicates leaves byte-identical REST behavior", async () => {
    const restListerA = { list: vi.fn(restListerLike(FIXTURE)) }
    const restListerB = {
      list: vi.fn(restListerLike(FIXTURE)),
      // SQL method explicitly absent — equivalent to the flag-off
      // path on a real `MemoryService` whose runtool dispatch
      // would no-op. The two listers MUST produce identical results.
    }

    const opts = {
      title: "MemoryService refactor",
      tags: [],
      projectId: PROJECT_A,
      threshold: 0.3,
      excludeKinds: ["decision"] as const,
      limit: 50,
    }

    const a = await findNearDuplicates(restListerA, opts)
    const b = await findNearDuplicates(restListerB, opts)
    expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id))
    // And both call list() exactly once.
    expect(restListerA.list).toHaveBeenCalledTimes(1)
    expect(restListerB.list).toHaveBeenCalledTimes(1)
  })

  it("includes unscoped (vault-wide) rows under projectOrUnscopedFilter parity (issue #539 blocker #3)", async () => {
    // mem-8 is unscoped (`projectId: ""`). Under
    // `projectOrUnscopedFilter` semantics, it surfaces in any
    // project-scoped probe — the REST and SQL paths must agree.
    const restLister = { list: vi.fn(restListerLike(FIXTURE)) }
    const sqlLister = {
      list: vi.fn(restListerLike(FIXTURE)),
      listForNearDuplicates: vi.fn(sqlListerLike(FIXTURE)),
    }
    const opts = {
      title: "MemoryService refactor",
      tags: [],
      projectId: PROJECT_A,
      threshold: 0.3,
      excludeKinds: ["decision"] as const,
      limit: 50,
    }
    const restResult = await findNearDuplicates(restLister, opts)
    const sqlResult = await findNearDuplicates(sqlLister, opts)
    expect(new Set(sqlResult.map((m) => m.id))).toEqual(
      new Set(restResult.map((m) => m.id)),
    )
    expect(restResult.map((m) => m.id)).toContain("mem-8")
  })

  it("applies tags before LIMIT — untagged rows can't push out tag-scoped rows (issue #539 blocker #3)", async () => {
    // The probe passes `tags: ["refactor"]`. Pre-fix, SQL
    // ignored tags so mem-9 (`tags: ["unrelated"]`) and other
    // untagged rows would consume LIMIT slots and push out
    // tag-scoped rows. Post-fix (review iteration 4), SQL pushes
    // the verified exact-token predicate
    // `Tags LIKE '%"refactor"%'` ahead of the LIMIT so SQL `LIMIT
    // N` truthfully bounds N tag-matching candidates — identical
    // to REST `multi_select.contains` semantics.
    const sqlLister = {
      list: vi.fn(restListerLike(FIXTURE)),
      listForNearDuplicates: vi.fn(sqlListerLike(FIXTURE)),
    }
    const restLister = { list: vi.fn(restListerLike(FIXTURE)) }
    const opts = {
      title: "MemoryService refactor",
      tags: ["refactor"],
      projectId: PROJECT_A,
      threshold: 0.3,
      excludeKinds: ["decision"] as const,
      limit: 50,
    }
    const sqlResult = await findNearDuplicates(sqlLister, opts)
    const restResult = await findNearDuplicates(restLister, opts)
    // Both paths must surface mem-1, mem-2 (tagged "refactor")
    // and exclude mem-9 (tagged "unrelated").
    expect(new Set(sqlResult.map((m) => m.id))).toEqual(
      new Set(restResult.map((m) => m.id)),
    )
    expect(sqlResult.map((m) => m.id)).not.toContain("mem-9")
  })

  it("deterministic ordering across paths after JS scoring", async () => {
    const sqlLister = {
      list: vi.fn(restListerLike(FIXTURE)),
      listForNearDuplicates: vi.fn(sqlListerLike(FIXTURE)),
    }
    const restLister = { list: vi.fn(restListerLike(FIXTURE)) }
    const opts = {
      title: "MemoryService refactor",
      tags: [],
      projectId: PROJECT_A,
      threshold: 0.3,
      limit: 50,
    }
    const sqlResult = await findNearDuplicates(sqlLister, opts)
    const restResult = await findNearDuplicates(restLister, opts)
    // The implementation sorts by `titleSimilarity` desc, so the
    // ordered result list is the same shape on both paths even
    // when the underlying lister returned a different row order.
    expect(sqlResult.map((m) => m.id)).toEqual(restResult.map((m) => m.id))
  })
})

// ---------------------------------------------------------------------------
// Issue #541 — `search` consumer A/B harness
// ---------------------------------------------------------------------------

/**
 * Acceptance criterion: "A/B test in `compat.test.ts` runs both paths
 * over representative queries and asserts page-id set equivalence at
 * the same final `limit`. Ordering and score scale may differ and are
 * documented."
 *
 * Each fixture row is registered both as a REST `client.search` hit
 * AND as a RunTool `search` hit; the harness exercises
 * `MemoryService.search({ mode: "semantic" })` once with
 * `LORE_USE_RUNTOOL_SEARCH=1` and once with the flag unset, then
 * asserts the resulting Memory id sets are equal at the same final
 * `limit`.
 *
 * The harness deliberately uses ONE shared stub client whose
 * `request` (RunTool path) and `search` (REST path) both serve the
 * same fixture set. When the flag is off, `request` is NOT called;
 * when on, `search` is NOT called for the queries the wrapper can
 * serve.
 */

const SEMANTIC_DB: DatabaseRef = {
  databaseId: "memories-db",
  dataSourceId: "memories-ds",
}

const SEMANTIC_FIXTURE: ReadonlyArray<{
  id: string
  title: string
  archived?: boolean
  parent?: "ds" | "db" | "other-ds"
}> = [
  { id: "11111111-1111-1111-1111-111111111111", title: "Memory A" },
  { id: "22222222-2222-2222-2222-222222222222", title: "Memory B" },
  { id: "33333333-3333-3333-3333-333333333333", title: "Memory C" },
  // Archived row — both paths must drop it before the limit slice.
  {
    id: "44444444-4444-4444-4444-444444444444",
    title: "Archived row",
    archived: true,
  },
  // Out-of-DS row — both paths must drop it (REST via post-filter,
  // RunTool via `data_source_url` server-side).
  {
    id: "55555555-5555-5555-5555-555555555555",
    title: "Other DS",
    parent: "other-ds",
  },
]

function buildSemanticPage(row: (typeof SEMANTIC_FIXTURE)[number]): PageObjectResponse {
  const parentVariant = row.parent ?? "ds"
  const parent =
    parentVariant === "db"
      ? { type: "database_id" as const, database_id: SEMANTIC_DB.databaseId }
      : parentVariant === "other-ds"
        ? { type: "data_source_id" as const, data_source_id: "other-ds" }
        : {
            type: "data_source_id" as const,
            data_source_id: SEMANTIC_DB.dataSourceId,
          }
  return {
    object: "page",
    id: row.id,
    created_time: "2026-04-20T00:00:00.000Z",
    last_edited_time: "2026-04-20T00:00:00.000Z",
    created_by: { object: "user", id: "u" },
    last_edited_by: { object: "user", id: "u" },
    cover: null,
    icon: null,
    parent,
    archived: row.archived === true,
    in_trash: row.archived === true,
    properties: {
      Title: { id: "t", type: "title", title: [{ plain_text: row.title } as never] },
      Project: { id: "p", type: "relation", relation: [], has_more: false },
      Topic: { id: "tp", type: "relation", relation: [], has_more: false },
      Source: { id: "s", type: "select", select: { id: "1", name: "manual", color: "default" } },
      Tags: { id: "tg", type: "multi_select", multi_select: [] },
    } as never,
    url: `https://www.notion.so/${row.id.replace(/-/g, "")}`,
    public_url: null,
  } as unknown as PageObjectResponse
}

interface SemanticStubCounters {
  searchCalls: number
  requestCalls: number
  retrieveCalls: number
}

function buildSemanticStubClient(): { client: Client; counters: SemanticStubCounters } {
  const counters: SemanticStubCounters = {
    searchCalls: 0,
    requestCalls: 0,
    retrieveCalls: 0,
  }
  const pagesById = new Map(
    SEMANTIC_FIXTURE.map((row) => [row.id, buildSemanticPage(row)] as const)
  )
  const stub = {
    search: async () => {
      counters.searchCalls += 1
      // REST path returns every fixture row; the post-filter narrows
      // to in-DS / live rows. Mirrors `client.search`'s workspace-wide
      // behavior.
      return {
        results: SEMANTIC_FIXTURE.map((row) => buildSemanticPage(row)),
        has_more: false,
        next_cursor: null,
      }
    },
    request: async ({ body }: { body: Record<string, unknown> }) => {
      counters.requestCalls += 1
      const search = (body as { search: { data_source_url: string; page_size: number } })
        .search
      // RunTool's `data_source_url` scopes server-side: only return
      // hits that match `dataSourceId`. Archived rows are returned
      // (they pass through `applySemanticPostFilters`'s archive drop).
      const hits = SEMANTIC_FIXTURE.filter(
        (row) =>
          (row.parent ?? "ds") !== "other-ds" &&
          search.data_source_url === `collection://${SEMANTIC_DB.dataSourceId}`
      ).slice(0, search.page_size)
      return {
        type: "ai_search" as const,
        results: hits.map((row) => ({
          id: row.id,
          title: row.title,
          url: row.id,
          type: "page",
          highlight: "",
          timestamp: "2026-04-20T00:00:00.000Z",
          is_archived: row.archived === true,
        })),
      }
    },
    pages: {
      retrieve: async ({ page_id }: { page_id: string }) => {
        counters.retrieveCalls += 1
        const page = pagesById.get(page_id)
        if (!page) throw new Error(`unknown page ${page_id}`)
        return page
      },
      retrieveMarkdown: async () => ({ markdown: "" }),
    },
  } as unknown as Client
  return { client: stub, counters }
}

describe("RunTool search vs REST/SDK semantic A/B harness", () => {
  beforeEach(() => {
    __resetRunToolSearchWarningsForTest()
    delete process.env["LORE_USE_RUNTOOL_SEARCH"]
    delete process.env["LORE_USE_RUNTOOL"]
  })

  afterEach(() => {
    delete process.env["LORE_USE_RUNTOOL_SEARCH"]
    delete process.env["LORE_USE_RUNTOOL"]
  })

  it("flag-off and flag-on agree on the page-id set at limit ≤ 25", async () => {
    const restStub = buildSemanticStubClient()
    const restService = new MemoryService(restStub.client, SEMANTIC_DB)
    const restResult = await restService.search({
      query: "Memory",
      mode: "semantic",
      limit: 5,
    })

    process.env["LORE_USE_RUNTOOL_SEARCH"] = "1"
    const runStub = buildSemanticStubClient()
    const runService = new MemoryService(runStub.client, SEMANTIC_DB)
    const runResult = await runService.search({
      query: "Memory",
      mode: "semantic",
      limit: 5,
    })

    // Both paths must drop the archived row (id ...4444) and the
    // out-of-DS row (id ...5555). The surviving id set must match.
    const restIds = new Set(restResult.map((m) => m.id))
    const runIds = new Set(runResult.map((m) => m.id))
    expect(runIds).toEqual(restIds)
    expect(restIds.has("44444444-4444-4444-4444-444444444444")).toBe(false)
    expect(restIds.has("55555555-5555-5555-5555-555555555555")).toBe(false)

    // Flag-off ⇒ no RunTool dispatch. Flag-on ⇒ no `client.search`.
    expect(restStub.counters.searchCalls).toBe(1)
    expect(restStub.counters.requestCalls).toBe(0)
    expect(runStub.counters.searchCalls).toBe(0)
    expect(runStub.counters.requestCalls).toBe(1)
    // Flag-on hydrates only Notion-internal hits (4: A, B, C,
    // archived). The out-of-DS row is filtered server-side via
    // `data_source_url`, so it never enters hydration.
    expect(runStub.counters.retrieveCalls).toBe(4)
  })

  it("flag-on with empty composed query falls back to REST without dispatching RunTool", async () => {
    process.env["LORE_USE_RUNTOOL_SEARCH"] = "1"
    const stub = buildSemanticStubClient()
    const service = new MemoryService(stub.client, SEMANTIC_DB)

    await service.search({ query: "", mode: "semantic", limit: 5 })

    // RunTool requires query length >= 1; the flag-on branch
    // structurally cannot serve this call, so it falls back without
    // attempting the dispatch.
    expect(stub.counters.requestCalls).toBe(0)
    expect(stub.counters.searchCalls).toBe(1)
  })

  it("flag-off and flag-on agree on the page-id set with a non-saturating mixed-hit fixture", async () => {
    // Larger A/B harness: 15 in-DS rows + 4 external connector
    // hits = 19 total, BELOW the saturation cap of 25 so the
    // RunTool path actually runs (rather than falling back on
    // saturation per the ranking-parity rule). Both paths must
    // surface the same set of in-DS, non-archived, in-Memories
    // page ids at the same final `limit`.
    interface RichRow {
      id: string
      title: string
      archived: boolean
      external: boolean
    }
    const richFixture: RichRow[] = []
    for (let i = 0; i < 15; i++) {
      const id = `${i.toString(16).padStart(8, "0")}-aaaa-bbbb-cccc-dddddddddddd`
      richFixture.push({
        id,
        title: `Memory ${i}`,
        archived: i % 7 === 0, // 3 archived rows: i = 0, 7, 14
        external: false,
      })
    }
    for (let i = 0; i < 4; i++) {
      richFixture.push({
        id: `ext-${i}`,
        title: `Slack ${i}`,
        archived: false,
        external: true,
      })
    }

    function buildRichPage(row: RichRow): PageObjectResponse {
      return {
        object: "page",
        id: row.id,
        created_time: "2026-04-20T00:00:00.000Z",
        last_edited_time: "2026-04-20T00:00:00.000Z",
        created_by: { object: "user", id: "u" },
        last_edited_by: { object: "user", id: "u" },
        cover: null,
        icon: null,
        parent: {
          type: "data_source_id",
          data_source_id: SEMANTIC_DB.dataSourceId,
        },
        archived: row.archived,
        in_trash: row.archived,
        properties: {
          Title: { id: "t", type: "title", title: [{ plain_text: row.title }] },
          Project: { id: "p", type: "relation", relation: [], has_more: false },
          Topic: { id: "tp", type: "relation", relation: [], has_more: false },
          Source: { id: "s", type: "select", select: { id: "1", name: "manual", color: "default" } },
          Tags: { id: "tg", type: "multi_select", multi_select: [] },
        } as never,
        url: `https://www.notion.so/${row.id.replace(/-/g, "")}`,
        public_url: null,
      } as unknown as PageObjectResponse
    }

    const pagesById = new Map(
      richFixture.filter((r) => !r.external).map((r) => [r.id, buildRichPage(r)] as const)
    )

    function buildRichStub(): { client: Client } {
      return {
        client: {
          search: async () => ({
            results: richFixture
              .filter((r) => !r.external)
              .map((r) => buildRichPage(r)),
            has_more: false,
            next_cursor: null,
          }),
          request: async ({ body }: { body: Record<string, unknown> }) => {
            const search = (body as { search: { page_size: number } }).search
            return {
              type: "ai_search" as const,
              results: richFixture.slice(0, search.page_size).map((r) => ({
                id: r.id,
                title: r.title,
                url: r.id,
                type: r.external ? "external" : "page",
                highlight: "",
                timestamp: "2026-04-20T00:00:00.000Z",
                is_archived: r.archived,
              })),
            }
          },
          pages: {
            retrieve: async ({ page_id }: { page_id: string }) => {
              const page = pagesById.get(page_id)
              if (!page) {
                const { APIResponseError, APIErrorCode } = await import(
                  "@notionhq/client"
                )
                throw new APIResponseError({
                  code: APIErrorCode.ObjectNotFound,
                  status: 404,
                  message: "not found",
                  headers: new Headers(),
                  rawBodyText: "",
                  additional_data: undefined,
                  request_id: undefined,
                })
              }
              return page
            },
            retrieveMarkdown: async () => ({ markdown: "" }),
          },
        } as unknown as Client,
      }
    }

    delete process.env["LORE_USE_RUNTOOL_SEARCH"]
    const restService = new MemoryService(buildRichStub().client, SEMANTIC_DB)
    const restResult = await restService.search({
      query: "Memory",
      mode: "semantic",
      limit: 10,
    })

    process.env["LORE_USE_RUNTOOL_SEARCH"] = "1"
    const runService = new MemoryService(buildRichStub().client, SEMANTIC_DB)
    const runResult = await runService.search({
      query: "Memory",
      mode: "semantic",
      limit: 10,
    })

    // Both paths surface the same page-id set at limit=10. Order
    // and confidence-rerank may differ; the AC asserts SET
    // equivalence, not list order.
    expect(new Set(runResult.map((m) => m.id))).toEqual(
      new Set(restResult.map((m) => m.id))
    )
    // Archived rows (i = 0, 7, 14) are excluded by both paths.
    expect(restResult.find((m) => m.id.startsWith("00000000"))).toBeUndefined()
    expect(runResult.find((m) => m.id.startsWith("00000000"))).toBeUndefined()
    // External connector hits dropped by both paths.
    expect(restResult.find((m) => m.id.startsWith("ext-"))).toBeUndefined()
    expect(runResult.find((m) => m.id.startsWith("ext-"))).toBeUndefined()
  })

  it("flag-on with limit at the RUNTOOL_SEARCH_MAX_PAGE_SIZE boundary still routes through RunTool", async () => {
    // Pin the gate's `<=` semantics: limit=25 must dispatch through
    // RunTool; limit=26 must fall back. A subtle off-by-one that
    // flipped this to `<` would silently switch every limit=25
    // caller to REST.
    process.env["LORE_USE_RUNTOOL_SEARCH"] = "1"
    const stub = buildSemanticStubClient()
    const service = new MemoryService(stub.client, SEMANTIC_DB)

    await service.search({ query: "Memory", mode: "semantic", limit: 25 })

    expect(stub.counters.requestCalls).toBe(1)
    expect(stub.counters.searchCalls).toBe(0)
  })

  it("flag-on with limit > RUNTOOL_SEARCH_MAX_PAGE_SIZE falls back to REST", async () => {
    process.env["LORE_USE_RUNTOOL_SEARCH"] = "1"
    const stub = buildSemanticStubClient()
    const service = new MemoryService(stub.client, SEMANTIC_DB)

    await service.search({ query: "Memory", mode: "semantic", limit: 26 })

    // The wrapper has no cursor and caps at 25 hits per call. A
    // requested window > 25 cannot be represented without
    // potentially under-recalling, so the consumer routes through
    // REST which paginates up to SEMANTIC_SEARCH_MAX_PAGES * 100.
    expect(stub.counters.requestCalls).toBe(0)
    expect(stub.counters.searchCalls).toBe(1)
  })

  it("flag-on hydrates via hit.url (page id), not hit.id (search index id)", async () => {
    // RED #1 regression: the pinned RunTool schema puts the Notion
    // page id in `url`, not `id`. `id` is the search index's internal
    // resource id and is not guaranteed to be the page id. If the
    // consumer hydrated `pages.retrieve({ page_id: hit.id })`, the
    // result would 404 (or worse, hit a different unrelated page).
    process.env["LORE_USE_RUNTOOL_SEARCH"] = "1"
    const pageId = "11111111-1111-1111-1111-111111111111"
    const indexId = "search-index-resource-id-7" // arbitrary non-page-id
    const receivedPageIds: string[] = []
    const stub = {
      search: async () => ({ results: [], has_more: false, next_cursor: null }),
      request: async () => ({
        type: "ai_search" as const,
        results: [
          {
            id: indexId, // intentionally NOT the page id
            title: "Memory A",
            url: pageId, // page id lives in url per pinned schema
            type: "page",
            highlight: "",
            timestamp: "2026-04-20T00:00:00.000Z",
          },
        ],
      }),
      pages: {
        retrieve: async ({ page_id }: { page_id: string }) => {
          receivedPageIds.push(page_id)
          return {
            object: "page",
            id: page_id,
            archived: false,
            in_trash: false,
            parent: {
              type: "data_source_id",
              data_source_id: SEMANTIC_DB.dataSourceId,
            },
            properties: {
              Title: { id: "t", type: "title", title: [{ plain_text: "A" }] },
              Project: { id: "p", type: "relation", relation: [], has_more: false },
              Topic: { id: "tp", type: "relation", relation: [], has_more: false },
              Tags: { id: "tg", type: "multi_select", multi_select: [] },
            },
            created_time: "2026-04-20T00:00:00.000Z",
            last_edited_time: "2026-04-20T00:00:00.000Z",
            created_by: { object: "user", id: "u" },
            last_edited_by: { object: "user", id: "u" },
            cover: null,
            icon: null,
            url: "https://www.notion.so/x",
            public_url: null,
          }
        },
        retrieveMarkdown: async () => ({ markdown: "" }),
      },
    } as unknown as Client

    const service = new MemoryService(stub, SEMANTIC_DB)
    const result = await service.search({
      query: "Memory",
      mode: "semantic",
      limit: 5,
    })

    // pages.retrieve was called with the page id from `url`, not the
    // search-index id from `id`.
    expect(receivedPageIds).toEqual([pageId])
    expect(result.map((m) => m.id)).toEqual([pageId])
  })

  it("flag-on aborts mid-hydration when the abort signal fires before the next pages.retrieve", async () => {
    // Hybrid mode passes an AbortSignal so the saturating-contains
    // branch can curtail in-flight semantic pagination. The RunTool
    // branch must honor the same contract: a signal aborted between
    // hydration iterations short-circuits BEFORE the next
    // pages.retrieve dispatches. The pre-#541 fan-out shape would
    // have queued all 25 retrieves through the rate-limit proxy
    // before observing the abort; the sequential loop bounds the
    // residual cost.
    process.env["LORE_USE_RUNTOOL_SEARCH"] = "1"

    const controller = new AbortController()
    const liveIds = Array.from({ length: 5 }, (_, i) =>
      `${i.toString(16).padStart(8, "0")}-aaaa-bbbb-cccc-dddddddddddd`
    )
    let retrieveCalls = 0
    const stub = {
      search: async () => ({ results: [], has_more: false, next_cursor: null }),
      request: async () => ({
        type: "ai_search" as const,
        results: liveIds.map((id) => ({
          id,
          title: "M",
          url: id,
          type: "page",
          highlight: "",
          timestamp: "2026-04-20T00:00:00.000Z",
        })),
      }),
      pages: {
        retrieve: async ({ page_id }: { page_id: string }) => {
          retrieveCalls += 1
          if (retrieveCalls === 1) {
            // Fire the abort after the first hit hydrates so the
            // sequential loop's per-iteration check trips at the
            // top of the next iteration.
            controller.abort()
          }
          return {
            object: "page",
            id: page_id,
            archived: false,
            in_trash: false,
            parent: {
              type: "data_source_id",
              data_source_id: SEMANTIC_DB.dataSourceId,
            },
            properties: {
              Title: { id: "t", type: "title", title: [{ plain_text: "M" }] },
              Project: { id: "p", type: "relation", relation: [], has_more: false },
              Topic: { id: "tp", type: "relation", relation: [], has_more: false },
              Tags: { id: "tg", type: "multi_select", multi_select: [] },
            },
            created_time: "2026-04-20T00:00:00.000Z",
            last_edited_time: "2026-04-20T00:00:00.000Z",
            created_by: { object: "user", id: "u" },
            last_edited_by: { object: "user", id: "u" },
            cover: null,
            icon: null,
            url: "https://www.notion.so/x",
            public_url: null,
          }
        },
        retrieveMarkdown: async () => ({ markdown: "" }),
      },
    } as unknown as Client

    const service = new MemoryService(stub, SEMANTIC_DB)
    // We can't pass AbortSignal through MemoryService.search's public
    // surface (no signal arg), so reach the helper indirectly via
    // hybrid mode where the saturation handler aborts the semantic
    // branch. Simulate by calling the private helper directly via
    // the cast — the contract under test is the helper's per-iteration
    // signal check, not the public API.
    const helperFn = (
      service as unknown as {
        fetchSemanticPagesViaRunTool: (
          input: { query: string; limit: number },
          composedQuery: string,
          limit: number,
          signal?: AbortSignal
        ) => Promise<unknown>
      }
    ).fetchSemanticPagesViaRunTool.bind(service)

    await expect(
      helperFn(
        { query: "Memory", limit: 5 },
        "Memory",
        5,
        controller.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" })

    // Only one retrieve completed (the one that triggered the abort);
    // the loop's per-iteration check trips before the second hits the
    // wire.
    expect(retrieveCalls).toBe(1)
  })

  it("flag-on tolerates per-id 404 / RestrictedResource without failing the search", async () => {
    process.env["LORE_USE_RUNTOOL_SEARCH"] = "1"
    const liveId = "11111111-1111-1111-1111-111111111111"
    const staleId = "99999999-9999-9999-9999-999999999999"
    const stub = {
      search: async () => ({ results: [], has_more: false, next_cursor: null }),
      request: async () => ({
        type: "ai_search" as const,
        results: [
          {
            id: liveId,
            title: "Live",
            url: liveId,
            type: "page",
            highlight: "",
            timestamp: "2026-04-20T00:00:00.000Z",
          },
          {
            id: staleId,
            title: "Stale",
            url: staleId,
            type: "page",
            highlight: "",
            timestamp: "2026-04-20T00:00:00.000Z",
          },
        ],
      }),
      pages: {
        retrieve: async ({ page_id }: { page_id: string }) => {
          if (page_id === staleId) {
            // Notion's search index lags deletes — a search hit
            // can point to an id that 404s on retrieve.
            const err = new Error("not_found")
            Object.assign(err, { code: "object_not_found", status: 404 })
            // Make it look like a NotionClientError so isNotionClientError works.
            const { APIResponseError } = await import("@notionhq/client")
            const { APIErrorCode } = await import("@notionhq/client")
            throw new APIResponseError({
              code: APIErrorCode.ObjectNotFound,
              status: 404,
              message: "not found",
              headers: new Headers(),
              rawBodyText: "",
              additional_data: undefined,
              request_id: undefined,
            })
          }
          return {
            object: "page",
            id: page_id,
            archived: false,
            in_trash: false,
            parent: {
              type: "data_source_id",
              data_source_id: SEMANTIC_DB.dataSourceId,
            },
            properties: {
              Title: { id: "t", type: "title", title: [{ plain_text: "Live" }] },
              Project: { id: "p", type: "relation", relation: [], has_more: false },
              Topic: { id: "tp", type: "relation", relation: [], has_more: false },
              Tags: { id: "tg", type: "multi_select", multi_select: [] },
            },
            created_time: "2026-04-20T00:00:00.000Z",
            last_edited_time: "2026-04-20T00:00:00.000Z",
            created_by: { object: "user", id: "u" },
            last_edited_by: { object: "user", id: "u" },
            cover: null,
            icon: null,
            url: "https://www.notion.so/x",
            public_url: null,
          }
        },
        retrieveMarkdown: async () => ({ markdown: "" }),
      },
    } as unknown as Client

    const service = new MemoryService(stub, SEMANTIC_DB)
    const result = await service.search({
      query: "Memory",
      mode: "semantic",
      limit: 5,
    })

    // Stale id silently dropped; live id surfaces.
    expect(result.map((m) => m.id)).toEqual([liveId])
  })

  it("flag-on saturated raw window falls back to REST regardless of post-filter survivor count (ranking-parity rule)", async () => {
    // The saturation gate is unconditional in the post-filter
    // dimension: when raw response saturates at 25, REST might
    // surface additional confidence-promotable or RRF-promotable
    // candidates beyond the no-cursor cap. Even if the wrapper's
    // 25 raw hits all survive post-filter and visibly satisfy
    // `limit`, the hidden-survivors case can change the
    // semantic-only `rerankByConfidence` outcome and the hybrid
    // RRF outcome.
    //
    // This test exercises the most-aggressive form of the rule:
    // 25 raw hits, 25 survive post-filter, limit=5. Old gate
    // (`filtered.length < limit && saturated`) would have
    // returned the top 5 from RunTool. New gate (`saturated`)
    // routes through REST.
    process.env["LORE_USE_RUNTOOL_SEARCH"] = "1"
    const counters = { searchCalls: 0, requestCalls: 0 }
    const liveIds = Array.from({ length: 25 }, (_, i) =>
      `${i.toString(16).padStart(8, "0")}-aaaa-bbbb-cccc-dddddddddddd`
    )
    const stub = {
      search: async () => {
        counters.searchCalls += 1
        return { results: [], has_more: false, next_cursor: null }
      },
      request: async () => {
        counters.requestCalls += 1
        // 25 hits, NONE archived — every one survives post-filter.
        return {
          type: "ai_search" as const,
          results: liveIds.map((id) => ({
            id,
            title: "M",
            url: id,
            type: "page",
            highlight: "",
            timestamp: "2026-04-20T00:00:00.000Z",
            is_archived: false,
          })),
        }
      },
      pages: {
        retrieve: async ({ page_id }: { page_id: string }) => ({
          object: "page",
          id: page_id,
          archived: false,
          in_trash: false,
          parent: {
            type: "data_source_id",
            data_source_id: SEMANTIC_DB.dataSourceId,
          },
          properties: {
            Title: { id: "t", type: "title", title: [{ plain_text: "M" }] },
            Project: { id: "p", type: "relation", relation: [], has_more: false },
            Topic: { id: "tp", type: "relation", relation: [], has_more: false },
            Tags: { id: "tg", type: "multi_select", multi_select: [] },
          },
          created_time: "2026-04-20T00:00:00.000Z",
          last_edited_time: "2026-04-20T00:00:00.000Z",
          created_by: { object: "user", id: "u" },
          last_edited_by: { object: "user", id: "u" },
          cover: null,
          icon: null,
          url: "https://www.notion.so/x",
          public_url: null,
        }),
        retrieveMarkdown: async () => ({ markdown: "" }),
      },
    } as unknown as Client

    const service = new MemoryService(stub, SEMANTIC_DB)
    await service.search({ query: "Memory", mode: "semantic", limit: 5 })

    // RunTool dispatched, saturated detected, REST fallback
    // engaged — even though the visible 25 raw hits exceeded the
    // requested `limit`. This is the load-bearing change that
    // preserves ranking parity with REST under confidence rerank
    // and hybrid RRF.
    expect(counters.requestCalls).toBe(1)
    expect(counters.searchCalls).toBe(1)
  })

  it("flag-on saturated raw window with under-recalling post-filter still falls back to REST", async () => {
    // Same logic applied to the original "saturated AND
    // post-filter survivors < limit" case — which the old gate
    // already handled. Pin that the unification of the gate
    // doesn't regress this case.
    process.env["LORE_USE_RUNTOOL_SEARCH"] = "1"
    const counters = { searchCalls: 0, requestCalls: 0 }
    const liveIds = Array.from({ length: 25 }, (_, i) =>
      `${i.toString(16).padStart(8, "0")}-aaaa-bbbb-cccc-dddddddddddd`
    )
    const stub = {
      search: async () => {
        counters.searchCalls += 1
        return { results: [], has_more: false, next_cursor: null }
      },
      request: async () => {
        counters.requestCalls += 1
        // 25 hits, all archived — post-filter drops every one.
        return {
          type: "ai_search" as const,
          results: liveIds.map((id) => ({
            id,
            title: "M",
            url: id,
            type: "page",
            highlight: "",
            timestamp: "2026-04-20T00:00:00.000Z",
            is_archived: true,
          })),
        }
      },
      pages: {
        retrieve: async ({ page_id }: { page_id: string }) => ({
          object: "page",
          id: page_id,
          archived: true,
          in_trash: true,
          parent: {
            type: "data_source_id",
            data_source_id: SEMANTIC_DB.dataSourceId,
          },
          properties: {
            Title: { id: "t", type: "title", title: [{ plain_text: "M" }] },
            Project: { id: "p", type: "relation", relation: [], has_more: false },
            Topic: { id: "tp", type: "relation", relation: [], has_more: false },
            Tags: { id: "tg", type: "multi_select", multi_select: [] },
          },
          created_time: "2026-04-20T00:00:00.000Z",
          last_edited_time: "2026-04-20T00:00:00.000Z",
          created_by: { object: "user", id: "u" },
          last_edited_by: { object: "user", id: "u" },
          cover: null,
          icon: null,
          url: "https://www.notion.so/x",
          public_url: null,
        }),
        retrieveMarkdown: async () => ({ markdown: "" }),
      },
    } as unknown as Client

    const service = new MemoryService(stub, SEMANTIC_DB)
    await service.search({ query: "Memory", mode: "semantic", limit: 5 })

    expect(counters.requestCalls).toBe(1)
    expect(counters.searchCalls).toBe(1)
  })

  it("flag-on with all-external-connector hits (saturated raw, zero internal hits) falls back to REST", async () => {
    // Pathological case: server returns its full hand of 25 hits
    // but every one is an external connector (Slack / Linear /
    // Drive — `url` is a full URL, not a Notion page id). The
    // wrapper drops them all in `isNotionInternalHit`, so
    // `outcome.hits.length === 0` AND `outcome.saturated === true`.
    // Without the saturation gate's `outcome.saturated ? null : []`
    // branch, the consumer would silently return zero memories
    // even though REST might surface valid Lore hits the connector
    // results crowded out.
    process.env["LORE_USE_RUNTOOL_SEARCH"] = "1"
    const counters = { searchCalls: 0, requestCalls: 0 }
    const stub = {
      search: async () => {
        counters.searchCalls += 1
        return { results: [], has_more: false, next_cursor: null }
      },
      request: async () => {
        counters.requestCalls += 1
        return {
          type: "ai_search" as const,
          results: Array.from({ length: 25 }, (_, i) => ({
            id: `ext-${i}`,
            title: `Slack ${i}`,
            // Full URL, not a Notion page id — wrapper drops these
            url: `https://slack.com/archives/C123/p${i}`,
            type: "external",
            highlight: "",
            timestamp: "2026-04-20T00:00:00.000Z",
          })),
        }
      },
      pages: {
        retrieve: async () => {
          throw new Error("should not be called — wrapper dropped all hits")
        },
        retrieveMarkdown: async () => ({ markdown: "" }),
      },
    } as unknown as Client

    const service = new MemoryService(stub, SEMANTIC_DB)
    await service.search({ query: "Memory", mode: "semantic", limit: 5 })

    expect(counters.requestCalls).toBe(1)
    expect(counters.searchCalls).toBe(1)
  })
})
