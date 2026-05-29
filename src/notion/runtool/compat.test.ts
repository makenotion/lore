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
import {
  APIErrorCode,
  APIResponseError,
  type Client,
  type PageObjectResponse,
} from "@notionhq/client"
import { findNearDuplicates } from "../../core/near-duplicate.js"
import { MemoryService } from "../../core/memory.js"
import type { DatabaseRef, Memory, MemoryStatus } from "../../types.js"
import {
  __resetRunToolSearchWarningsForTest,
  RunToolSearchRestrictedError,
} from "./search.js"

interface FixtureRow {
  id: string
  title: string
  kind: Memory["kind"]
  status: MemoryStatus
  source?: Memory["source"]
  projectId: string
  tags: string[]
}

const PROJECT_A = "proj-a"
const PROJECT_B = "proj-b"

const FIXTURE: ReadonlyArray<FixtureRow> = [
  // Strong matches under the trigram threshold
  {
    id: "mem-1",
    title: "MemoryService refactor part 1",
    kind: "note",
    status: "accepted",
    projectId: PROJECT_A,
    tags: ["refactor"],
  },
  {
    id: "mem-2",
    title: "MemoryService refactor part 2",
    kind: "note",
    status: "accepted",
    projectId: PROJECT_A,
    tags: ["refactor"],
  },
  // Decision row that the memory probe excludes (excludeKinds: ["decision"])
  {
    id: "mem-3",
    title: "MemoryService refactor decision",
    kind: "decision",
    status: "accepted",
    projectId: PROJECT_A,
    tags: ["decision"],
  },
  // Status outside whitelist (e.g. when statuses=["accepted","proposed"])
  {
    id: "mem-4",
    title: "MemoryService refactor done",
    kind: "note",
    status: "superseded",
    projectId: PROJECT_A,
    tags: ["done"],
  },
  // Project mismatch — would not even enter the SQL pool
  {
    id: "mem-5",
    title: "MemoryService refactor B",
    kind: "note",
    status: "accepted",
    projectId: PROJECT_B,
    tags: [],
  },
  // Below threshold — title too dissimilar
  {
    id: "mem-6",
    title: "Unrelated meeting notes",
    kind: "note",
    status: "accepted",
    projectId: PROJECT_A,
    tags: [],
  },
  // Proposed status — opt-in path
  {
    id: "mem-7",
    title: "MemoryService refactor proposed",
    kind: "note",
    status: "proposed",
    projectId: PROJECT_A,
    tags: [],
  },
  // Unscoped (vault-wide) row — REST surfaces this in any
  // project-scoped probe via `projectOrUnscopedFilter`. Issue #539
  // review blocker #3 specifically called out that the SQL path
  // must mirror this; the `compat.test.ts` fixture didn't have an
  // unscoped row before, so the harness couldn't catch the
  // divergence.
  {
    id: "mem-8",
    title: "MemoryService refactor vault-wide",
    kind: "note",
    status: "accepted",
    projectId: "",
    tags: ["refactor"],
  },
  // Tagged-out row in PROJECT_A — should be filtered out when
  // the probe scopes by tags. The SQL exact-token predicate
  // (`Tags LIKE %"refactor"%`) and the REST `multi_select.contains`
  // both reject this row before the LIMIT.
  {
    id: "mem-9",
    title: "MemoryService refactor untagged",
    kind: "note",
    status: "accepted",
    projectId: PROJECT_A,
    tags: ["unrelated"],
  },
  // Retired source — default memory listing excludes it before the
  // near-duplicate scorer sees candidates.
  {
    id: "mem-10",
    title: "MemoryService refactor diary",
    kind: "note",
    status: "accepted",
    source: "agent_diary",
    projectId: PROJECT_A,
    tags: ["refactor"],
  },
]

function makeMemory(row: FixtureRow): Memory {
  return {
    id: row.id,
    title: row.title,
    projectIds: [row.projectId],
    topicId: null,
    source: row.source ?? "manual",
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
      if (row.source === "agent_diary") return false
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
      opts.statuses === undefined && !opts.includeProposed ? ["proposed"] : undefined

    const matches = items.filter((row) => {
      // SQL path also includes unscoped rows by default
      // (mirrors `projectOrUnscopedFilter`). Issue #539 review
      // blocker #3.
      if (row.projectId !== opts.projectId && row.projectId !== "") return false
      if (opts.kind && row.kind !== opts.kind) return false
      if (opts.excludeKinds && opts.excludeKinds.includes(row.kind)) return false
      if (opts.statuses && !opts.statuses.includes(row.status)) return false
      if (excludeStatuses && excludeStatuses.includes(row.status)) return false
      if (row.source === "agent_diary") return false
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
    expect(restIds.has("mem-10")).toBe(false) // retired source excluded
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
      new Set(restResult.map((m) => m.id))
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
      new Set(restResult.map((m) => m.id))
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
      new Set(restResult.map((m) => m.id))
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
      Source: {
        id: "s",
        type: "select",
        select: { id: "1", name: "manual", color: "default" },
      },
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
  queryCalls: number
}

function buildSemanticStubClient(): { client: Client; counters: SemanticStubCounters } {
  const counters: SemanticStubCounters = {
    searchCalls: 0,
    requestCalls: 0,
    retrieveCalls: 0,
    queryCalls: 0,
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
    dataSources: {
      query: async () => {
        counters.queryCalls += 1
        return {
          results: SEMANTIC_FIXTURE.map((row) => buildSemanticPage(row)),
          has_more: false,
          next_cursor: null,
        }
      },
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
    // Default state is ON post-#543. Tests that need the flag-off
    // branch must explicitly set `=0` below; tests that need flag-on
    // can set `=1` for clarity (or rely on the inherited default).
    delete process.env["LORE_USE_RUNTOOL_SEARCH"]
    delete process.env["LORE_USE_RUNTOOL"]
  })

  afterEach(() => {
    delete process.env["LORE_USE_RUNTOOL_SEARCH"]
    delete process.env["LORE_USE_RUNTOOL"]
  })

  it("flag-off and flag-on agree on the page-id set at limit ≤ 25", async () => {
    process.env["LORE_USE_RUNTOOL_SEARCH"] = "0"
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

  it("flag-on with empty composed query uses DS-scoped listing without dispatching RunTool", async () => {
    process.env["LORE_USE_RUNTOOL_SEARCH"] = "1"
    const stub = buildSemanticStubClient()
    const service = new MemoryService(stub.client, SEMANTIC_DB)

    await service.search({ query: "", mode: "semantic", limit: 5 })

    // RunTool requires query length >= 1. Empty semantic queries are
    // list-shaped, so the service uses the Memories data source instead of
    // switching to workspace-wide REST search.
    expect(stub.counters.requestCalls).toBe(0)
    expect(stub.counters.searchCalls).toBe(0)
    expect(stub.counters.queryCalls).toBe(1)
  })

  it("flag-off and flag-on agree on the page-id set with a non-saturating mixed-hit fixture", async () => {
    // Larger A/B harness: 15 in-DS rows + 4 external connector
    // hits = 19 total, which keeps the fixture under the RunTool
    // candidate-window cap. Both paths must surface the same set of
    // in-DS, non-archived, in-Memories page ids at the same final
    // `limit`.
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
          Source: {
            id: "s",
            type: "select",
            select: { id: "1", name: "manual", color: "default" },
          },
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
            results: richFixture.filter((r) => !r.external).map((r) => buildRichPage(r)),
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
                const { APIResponseError, APIErrorCode } =
                  await import("@notionhq/client")
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

    process.env["LORE_USE_RUNTOOL_SEARCH"] = "0"
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

    // Both paths surface the same page-id set at limit=10. Order may differ;
    // the assertion pins set equivalence, not list order.
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
    // Pin that the RunTool route is not capped by the caller's display
    // limit. The wrapper asks for the server's full search window and
    // lets `runSearch` apply the final slice.
    process.env["LORE_USE_RUNTOOL_SEARCH"] = "1"
    const stub = buildSemanticStubClient()
    const service = new MemoryService(stub.client, SEMANTIC_DB)

    await service.search({ query: "Memory", mode: "semantic", limit: 25 })

    expect(stub.counters.requestCalls).toBe(1)
    expect(stub.counters.searchCalls).toBe(0)
  })

  it("flag-on with limit > RUNTOOL_SEARCH_MAX_PAGE_SIZE still routes through RunTool", async () => {
    process.env["LORE_USE_RUNTOOL_SEARCH"] = "1"
    const stub = buildSemanticStubClient()
    const service = new MemoryService(stub.client, SEMANTIC_DB)

    await service.search({ query: "Memory", mode: "semantic", limit: 26 })

    expect(stub.counters.requestCalls).toBe(1)
    expect(stub.counters.searchCalls).toBe(0)
  })

  it("flag-on hydrates via the page id derived from hit.url, not hit.id", async () => {
    // RunTool's `id` is the search index's internal resource id and
    // is not guaranteed to be the page id. The wrapper normalizes
    // `url` to a page id before `MemoryService` hydrates the hit.
    process.env["LORE_USE_RUNTOOL_SEARCH"] = "1"
    const pageId = "11111111-1111-1111-1111-111111111111"
    const pageUrl = `https://app.dev.notion.com/p/${pageId.replaceAll("-", "")}`
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
            url: pageUrl,
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
    const liveIds = Array.from(
      { length: 5 },
      (_, i) => `${i.toString(16).padStart(8, "0")}-aaaa-bbbb-cccc-dddddddddddd`
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
          signal?: AbortSignal
        ) => Promise<unknown>
      }
    ).fetchSemanticPagesViaRunTool.bind(service)

    await expect(
      helperFn({ query: "Memory", limit: 5 }, "Memory", controller.signal)
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

  it("flag-on propagates search-dispatch RestrictedResource instead of falling back to REST", async () => {
    process.env["LORE_USE_RUNTOOL_SEARCH"] = "1"
    const counters = { searchCalls: 0, requestCalls: 0 }
    const stub = {
      search: async () => {
        counters.searchCalls += 1
        return { results: [], has_more: false, next_cursor: null }
      },
      request: async () => {
        counters.requestCalls += 1
        throw new APIResponseError({
          code: APIErrorCode.RestrictedResource,
          status: 403,
          message: "Only public integrations can access this API.",
          headers: new Headers(),
          rawBodyText: "{}",
          additional_data: undefined,
          request_id: undefined,
        })
      },
      pages: {
        retrieve: async () => {
          throw new Error("should not hydrate")
        },
        retrieveMarkdown: async () => ({ markdown: "" }),
      },
    } as unknown as Client
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    try {
      const service = new MemoryService(stub, SEMANTIC_DB)

      await expect(
        service.search({ query: "Memory", mode: "semantic", limit: 5 })
      ).rejects.toBeInstanceOf(RunToolSearchRestrictedError)

      expect(counters.requestCalls).toBe(1)
      expect(counters.searchCalls).toBe(0)
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it("flag-on de-duplicates repeated normalized page ids before hydration", async () => {
    process.env["LORE_USE_RUNTOOL_SEARCH"] = "1"
    const pageId = "11111111-1111-1111-1111-111111111111"
    const retrievedPageIds: string[] = []
    const stub = {
      search: async () => ({ results: [], has_more: false, next_cursor: null }),
      request: async () => ({
        type: "ai_search" as const,
        results: [
          {
            id: "search-index-resource-id-1",
            title: "Memory A",
            url: pageId,
            type: "page",
            highlight: "",
            timestamp: "2026-04-20T00:00:00.000Z",
          },
          {
            id: "search-index-resource-id-2",
            title: "Memory A duplicate",
            url: `https://app.dev.notion.com/p/${pageId.replaceAll("-", "")}`,
            type: "page",
            highlight: "",
            timestamp: "2026-04-20T00:00:00.000Z",
          },
        ],
      }),
      pages: {
        retrieve: async ({ page_id }: { page_id: string }) => {
          retrievedPageIds.push(page_id)
          return buildSemanticPage({ id: page_id, title: "Memory A" })
        },
        retrieveMarkdown: async () => ({ markdown: "" }),
      },
    } as unknown as Client

    const service = new MemoryService(stub, SEMANTIC_DB)
    const result = await service.search({ query: "Memory", mode: "semantic", limit: 5 })

    expect(retrievedPageIds).toEqual([pageId])
    expect(result.map((m) => m.id)).toEqual([pageId])
  })

  it("flag-on saturated raw window trusts RunTool and surfaces capped metadata", async () => {
    // A 25-hit RunTool response is accepted as the semantic relevance
    // window. The service reports `capped: true` instead of switching to
    // REST, so callers can render truncation without discarding Notion AI
    // ordering.
    process.env["LORE_USE_RUNTOOL_SEARCH"] = "1"
    const counters = { searchCalls: 0, requestCalls: 0 }
    const liveIds = Array.from(
      { length: 25 },
      (_, i) => `${i.toString(16).padStart(8, "0")}-aaaa-bbbb-cccc-dddddddddddd`
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
    const result = await service.searchWithMeta({
      query: "Memory",
      mode: "semantic",
      limit: 5,
    })

    expect(counters.requestCalls).toBe(1)
    expect(counters.searchCalls).toBe(0)
    expect(result.capped).toBe(true)
    expect(result.memories).toHaveLength(5)
  })

  it("flag-on saturated raw window with under-recalling post-filter returns capped empty result", async () => {
    // Post-filters can drop every RunTool hit, but the semantic relevance
    // source remains RunTool. The cap metadata distinguishes a truncated
    // search window from a fully exhausted no-match.
    process.env["LORE_USE_RUNTOOL_SEARCH"] = "1"
    const counters = { searchCalls: 0, requestCalls: 0 }
    const liveIds = Array.from(
      { length: 25 },
      (_, i) => `${i.toString(16).padStart(8, "0")}-aaaa-bbbb-cccc-dddddddddddd`
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
    const result = await service.searchWithMeta({
      query: "Memory",
      mode: "semantic",
      limit: 5,
    })

    expect(counters.requestCalls).toBe(1)
    expect(counters.searchCalls).toBe(0)
    expect(result.capped).toBe(true)
    expect(result.memories).toEqual([])
  })

  it("flag-on with all-external-connector hits returns capped empty result", async () => {
    // Pathological case: server returns its full hand of 25 hits
    // but every one is an external connector (Slack / Linear /
    // Drive — `url` is a full URL, not a Notion page id). The
    // wrapper drops them all in `isNotionInternalHit`, so
    // `outcome.hits.length === 0` AND `outcome.saturated === true`.
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
    const result = await service.searchWithMeta({
      query: "Memory",
      mode: "semantic",
      limit: 5,
    })

    expect(counters.requestCalls).toBe(1)
    expect(counters.searchCalls).toBe(0)
    expect(result.capped).toBe(true)
    expect(result.memories).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Issue #542 — `query_data_sources` aggregate consumer A/B harness
// ---------------------------------------------------------------------------

/**
 * Acceptance criterion (issue #543 Phase 4): "Aggregate A/B coverage
 * asserts orphan-rate metric equivalence between RunTool and JS
 * fallback paths over fixtures and at least one representative
 * dev/manual run."
 *
 * The harness drives `runOrphanRateReport` (the integration site
 * consumed by `lore migrate --build-entities --report-orphan-rate`)
 * twice over a shared fact corpus — once with
 * `LORE_USE_RUNTOOL_AGGREGATE=0` (forces the JS enumeration path)
 * and once with `LORE_USE_RUNTOOL_AGGREGATE=1` (forces the RunTool
 * SQL aggregate path) — and asserts the emitted orphan-rate metric
 * matches byte-for-byte.
 *
 * Shape mirrors the search consumer's A/B harness above: one shared
 * fixture, one stub services factory per path, log-line scraping
 * for the metric, set/numeric equivalence asserted across paths.
 *
 * Fixture coverage is pinned here. Manual live-vault evidence is
 * historical audit material for operators running the report
 * against real data.
 */

import { runOrphanRateReport } from "../../cli/commands/migrate/orphan-rate.js"
import type { Fact } from "../../types.js"

type RunOrphanRateReportFn = typeof runOrphanRateReport

interface AggregateFixtureRow {
  factId: string
  subject: string
  subjectEntityId: string | null
  projectIds?: string[]
  validUntil?: string | null
}

const ENT_LIVE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const ENT_LIVE_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

/**
 * Aggregate fixture exercises the cross-section of cases the
 * `entity-migration.ts` parity tests pinned at the unit level —
 * populated SubjectEntity (peer + orphan), case-variant Subject text
 * with empty SubjectEntity, lone empty SubjectEntity, and
 * invalidated facts (which the SQL gateway can't filter and the JS
 * path counts via `includeInvalidated: true`).
 */
const AGGREGATE_FIXTURE: ReadonlyArray<AggregateFixtureRow> = [
  // Populated SubjectEntity, peer (3 facts → groupsWithPeer)
  { factId: "fa-1", subject: "MemoryService.create", subjectEntityId: ENT_LIVE_A },
  { factId: "fa-2", subject: "MemoryService.create", subjectEntityId: ENT_LIVE_A },
  { factId: "fa-3", subject: "MemoryService.create", subjectEntityId: ENT_LIVE_A },
  // Populated SubjectEntity, orphan (1 fact → orphan)
  { factId: "fa-4", subject: "Foo", subjectEntityId: ENT_LIVE_B },
  // Empty SubjectEntity, case-variant Subject collapses to one canonical key
  { factId: "fa-5", subject: "DataSourceQuery", subjectEntityId: null },
  { factId: "fa-6", subject: "datasourcequery", subjectEntityId: null },
  // Empty SubjectEntity, orphan
  { factId: "fa-7", subject: "Solo", subjectEntityId: null },
  // Invalidated fact — must contribute to BOTH paths' counts (the
  // gateway has no `Valid Until` column, and the JS call site
  // passes `includeInvalidated: true` for parity).
  {
    factId: "fa-8",
    subject: "MemoryService.create",
    subjectEntityId: ENT_LIVE_A,
    validUntil: "2026-04-30",
  },
]

function fixtureToFacts(fixture: ReadonlyArray<AggregateFixtureRow>): Fact[] {
  return fixture.map((row) => ({
    id: row.factId,
    subject: row.subject,
    predicate: "mentions",
    object: "",
    projectIds: row.projectIds ?? [],
    validFrom: "2026-04-20",
    validUntil: row.validUntil ?? null,
    reviewBy: null,
    sourceMemoryId: null,
    confidence: "speculative",
    createdAt: "2026-04-20T00:00:00.000Z",
    subjectEntityId: row.subjectEntityId,
    objectEntityId: null,
  }))
}

/**
 * Express the fixture as the `(SubjectEntity, Subject)` group rows
 * the SQL gateway would return for `SELECT SubjectEntity, Subject,
 * COUNT(*) FROM facts GROUP BY SubjectEntity, Subject`. Relations
 * are JSON-stringified arrays of full URLs containing the undashed
 * id form (verified live 2026-05-05 against an internal
 * vault). Empty-relation rows take the `null` form so
 * `extractFirstRelationId` returns `null` for them.
 */
function fixtureToAggregateRows(
  fixture: ReadonlyArray<AggregateFixtureRow>
): Array<{ subjectEntity: string | null; subject: string; cnt: number }> {
  const groups = new Map<
    string,
    { subjectEntity: string | null; subject: string; cnt: number }
  >()
  for (const row of fixture) {
    // Group key is exactly what the SQL gateway groups by:
    // raw SubjectEntity cell || raw Subject cell. Case-variant
    // subjects do NOT pre-collapse server-side (SQLite's `LOWER`
    // can't reproduce `computeSubjectKey`); the fold runs in JS
    // afterwards via `computeOrphanRateFromAggregateRows`.
    const subjectEntityRaw =
      row.subjectEntityId === null
        ? null
        : `["https://www.notion.so/${row.subjectEntityId.replace(/-/g, "")}"]`
    const key = `${subjectEntityRaw ?? ""}|${row.subject}`
    const existing = groups.get(key)
    if (existing) {
      existing.cnt += 1
    } else {
      groups.set(key, { subjectEntity: subjectEntityRaw, subject: row.subject, cnt: 1 })
    }
  }
  return Array.from(groups.values())
}

interface OrphanRateStubCounters {
  requestCalls: number
  queryBySubjectCalls: number
}

interface OrphanRateStubOptions {
  /**
   * When set, the stubbed `client.request` throws this error
   * instead of returning the aggregate rows. Drives the per-call
   * fallback path (capability-gate / transient-error / saturated
   * `has_more: true`).
   */
  requestError?: unknown
  /**
   * When true, the stubbed `client.request` returns the aggregate
   * rows but with `has_more: true`, simulating gateway saturation
   * on a non-trivial vault. The wrapper throws
   * `SqlPartialResultError` and the consumer falls back per-call
   * to the JS path.
   */
  saturated?: boolean
}

function buildOrphanRateServicesStub(
  fixture: ReadonlyArray<AggregateFixtureRow>,
  opts: OrphanRateStubOptions = {}
): {
  services: Parameters<RunOrphanRateReportFn>[0]
  counters: OrphanRateStubCounters
} {
  const counters: OrphanRateStubCounters = { requestCalls: 0, queryBySubjectCalls: 0 }
  const aggregateRows = fixtureToAggregateRows(fixture)
  const facts = fixtureToFacts(fixture)
  const stub = {
    client: {
      request: async (init: { body?: unknown }) => {
        counters.requestCalls += 1
        if (opts.requestError !== undefined) throw opts.requestError
        // Return the aggregate rows in the QueryDataSourcesResource
        // shape: `{ results, has_more, data_source_ids }`.
        const body = init.body as { type: string }
        if (body?.type !== "query_data_sources") {
          throw new Error(`unexpected RunTool dispatch: type=${String(body?.type)}`)
        }
        return {
          results: aggregateRows.map((row) => ({
            subjectEntity: row.subjectEntity,
            subject: row.subject,
            cnt: row.cnt,
          })),
          has_more: opts.saturated === true,
        }
      },
    },
    facts: {
      queryBySubject: async (
        _subject: string,
        _opts?: {
          allowUnfiltered?: boolean
          includeInvalidated?: boolean
          projectId?: string
        }
      ): Promise<Fact[]> => {
        counters.queryBySubjectCalls += 1
        return facts
      },
    },
    vault: {
      databases: {
        facts: { databaseId: "facts-db", dataSourceId: "facts-ds-1" },
      },
    },
  } as unknown as Parameters<RunOrphanRateReportFn>[0]
  return { services: stub, counters }
}

function captureOrphanRateLogs<T>(
  fn: () => Promise<T>
): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = []
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "))
  })
  return fn()
    .then((result) => ({ result, lines }))
    .finally(() => spy.mockRestore())
}

const ORPHAN_RATE_LINE =
  /^Orphan rate \(([^,]+), ([^,]+), via ([a-z-]+)\): (\d+\.\d)% — (\d+)\/(\d+) entit[a-z]+ appear in exactly 1 fact \((\d+) fact[s]? inspected, including invalidated\)\.$/

function parseOrphanRateLine(lines: string[]): {
  pass: string
  scope: string
  path: string
  pct: string
  orphans: number
  totalGroups: number
  totalFacts: number
} {
  const line = lines.find((l) => ORPHAN_RATE_LINE.test(l))
  if (!line) throw new Error(`no orphan-rate line in:\n${lines.join("\n")}`)
  const m = ORPHAN_RATE_LINE.exec(line)!
  return {
    pass: m[1]!,
    scope: m[2]!,
    path: m[3]!,
    pct: m[4]!,
    orphans: Number(m[5]!),
    totalGroups: Number(m[6]!),
    totalFacts: Number(m[7]!),
  }
}

describe("RunTool aggregate vs JS enumeration A/B harness (issue #542)", () => {
  let savedAggregateFlag: string | undefined
  let savedParentFlag: string | undefined

  beforeEach(() => {
    savedAggregateFlag = process.env["LORE_USE_RUNTOOL_AGGREGATE"]
    savedParentFlag = process.env["LORE_USE_RUNTOOL"]
    delete process.env["LORE_USE_RUNTOOL_AGGREGATE"]
    delete process.env["LORE_USE_RUNTOOL"]
  })

  afterEach(() => {
    if (savedAggregateFlag === undefined) {
      delete process.env["LORE_USE_RUNTOOL_AGGREGATE"]
    } else {
      process.env["LORE_USE_RUNTOOL_AGGREGATE"] = savedAggregateFlag
    }
    if (savedParentFlag === undefined) {
      delete process.env["LORE_USE_RUNTOOL"]
    } else {
      process.env["LORE_USE_RUNTOOL"] = savedParentFlag
    }
  })

  it("flag-off (JS enumeration) and flag-on (RunTool aggregate) emit identical orphan-rate metrics", async () => {
    // Flag-off: force JS enumeration. Stub's `request` must NOT be
    // called; `queryBySubject` runs once over the full corpus.
    process.env["LORE_USE_RUNTOOL_AGGREGATE"] = "0"
    const off = buildOrphanRateServicesStub(AGGREGATE_FIXTURE)
    const offResult = await captureOrphanRateLogs(() =>
      runOrphanRateReport(off.services, { apply: false })
    )

    // Flag-on: force RunTool aggregate. Stub's `request` runs once
    // with the `query_data_sources` envelope; `queryBySubject` is NOT
    // called because the SQL path serves the metric end-to-end.
    process.env["LORE_USE_RUNTOOL_AGGREGATE"] = "1"
    const on = buildOrphanRateServicesStub(AGGREGATE_FIXTURE)
    const onResult = await captureOrphanRateLogs(() =>
      runOrphanRateReport(on.services, { apply: false })
    )

    const offMetric = parseOrphanRateLine(offResult.lines)
    const onMetric = parseOrphanRateLine(onResult.lines)

    // Path labels distinguish which branch ran — proves the test
    // exercised the toggle, not just both rounds of a single path.
    expect(offMetric.path).toBe("js-enumeration")
    expect(onMetric.path).toBe("runtool-aggregate")

    // Pass + scope labels are flag-independent (issue #547 contract).
    expect(offMetric.pass).toBe("pre-pass")
    expect(onMetric.pass).toBe("pre-pass")
    expect(offMetric.scope).toBe("vault-wide")
    expect(onMetric.scope).toBe("vault-wide")

    // The load-bearing equivalence: orphan-rate percentage and the
    // group / fact counts must be byte-identical across paths.
    expect(onMetric.pct).toBe(offMetric.pct)
    expect(onMetric.orphans).toBe(offMetric.orphans)
    expect(onMetric.totalGroups).toBe(offMetric.totalGroups)
    expect(onMetric.totalFacts).toBe(offMetric.totalFacts)

    // Sanity-check the absolute numbers so the test catches a
    // shared-bug case where both paths drift in lockstep:
    //   Groups: ent-A (4 facts incl. invalidated), ent-B (1),
    //           key:datasourcequery (2), key:solo (1) = 4 groups.
    //   Peers: ent-A (4) and key:datasourcequery (2) = 2 with peers.
    //   Orphans: ent-B and key:solo = 2 orphans.
    //   Rate: 1 - 2/4 = 0.5 → "50.0%".
    //   Facts inspected: 8 (incl. the one invalidated).
    expect(offMetric.pct).toBe("50.0")
    expect(offMetric.orphans).toBe(2)
    expect(offMetric.totalGroups).toBe(4)
    expect(offMetric.totalFacts).toBe(8)

    // Dispatch isolation: each path takes one and only one route.
    expect(off.counters.requestCalls).toBe(0)
    expect(off.counters.queryBySubjectCalls).toBe(1)
    expect(on.counters.requestCalls).toBe(1)
    expect(on.counters.queryBySubjectCalls).toBe(0)
  })

  it("flag-on with saturated aggregate (`has_more: true`) falls back to JS path with identical metric", async () => {
    // Per-call fallback contract: when the aggregate response
    // carries `has_more: true`, the wrapper throws
    // `SqlPartialResultError` and the call site falls through to
    // JS enumeration. The metric must still match the flag-off
    // path because the underlying corpus is identical.
    process.env["LORE_USE_RUNTOOL_AGGREGATE"] = "0"
    const off = buildOrphanRateServicesStub(AGGREGATE_FIXTURE)
    const offResult = await captureOrphanRateLogs(() =>
      runOrphanRateReport(off.services, { apply: false })
    )

    process.env["LORE_USE_RUNTOOL_AGGREGATE"] = "1"
    // Wrap the JS-path stub with a spy that records the args
    // `runOrphanRateReport` passed to `queryBySubject`. Per PR
    // #549 review iteration 1 should-fix #5: explicit assertion
    // that the JS fallback walked the same fact corpus as the
    // failed SQL probe was meant to aggregate over.
    const onSaturated = buildOrphanRateServicesStub(AGGREGATE_FIXTURE, {
      saturated: true,
    })
    const factsAccessor = onSaturated.services.facts as unknown as {
      queryBySubject: (...args: unknown[]) => Promise<unknown>
    }
    const originalQueryBySubject = factsAccessor.queryBySubject.bind(
      onSaturated.services.facts
    )
    const queryBySubjectSpy = vi.fn(originalQueryBySubject)
    factsAccessor.queryBySubject = queryBySubjectSpy
    const onSaturatedResult = await captureOrphanRateLogs(() =>
      runOrphanRateReport(onSaturated.services, { apply: false })
    )

    const offMetric = parseOrphanRateLine(offResult.lines)
    const saturatedMetric = parseOrphanRateLine(onSaturatedResult.lines)

    // Saturation routed through the JS path — the path label
    // proves the fallback fired.
    expect(saturatedMetric.path).toBe("js-enumeration")
    // Metric still equivalent — the fallback preserves correctness.
    expect(saturatedMetric.pct).toBe(offMetric.pct)
    expect(saturatedMetric.orphans).toBe(offMetric.orphans)
    expect(saturatedMetric.totalGroups).toBe(offMetric.totalGroups)
    expect(saturatedMetric.totalFacts).toBe(offMetric.totalFacts)

    // The fixture has 8 facts (incl. one invalidated). Pin the
    // absolute count so a future refactor that swaps the JS-path
    // service shape doesn't silently change which corpus the JS
    // fallback inspected.
    expect(saturatedMetric.totalFacts).toBe(8)

    // Both dispatchers fired: the SQL probe (which threw) and the
    // JS fallback (which produced the answer).
    expect(onSaturated.counters.requestCalls).toBe(1)
    expect(onSaturated.counters.queryBySubjectCalls).toBe(1)

    // Pin the JS path's call args so a future refactor of
    // `runOrphanRateReport`'s JS fallback that drops
    // `includeInvalidated: true` would surface here as a
    // visible test failure rather than silent metric drift.
    expect(queryBySubjectSpy).toHaveBeenCalledWith(
      "",
      expect.objectContaining({
        allowUnfiltered: true,
        includeInvalidated: true,
      })
    )
  })

  it("flag-on with 403 RestrictedResource (capability gate) falls back to JS path with identical metric", async () => {
    // `query_data_sources` is gated server-side on
    // `hasAdvancedTools` (Enterprise + AI). Operators on lower-tier
    // workspaces see 403 RestrictedResource; the wrapper classifies
    // this as fall-back-able (the auth-refresh proxy can't repair
    // it — it refreshes only on 401), and the call site falls
    // through to JS enumeration.
    process.env["LORE_USE_RUNTOOL_AGGREGATE"] = "0"
    const off = buildOrphanRateServicesStub(AGGREGATE_FIXTURE)
    const offResult = await captureOrphanRateLogs(() =>
      runOrphanRateReport(off.services, { apply: false })
    )

    const { APIResponseError, APIErrorCode } = await import("@notionhq/client")
    const restrictedError = new APIResponseError({
      code: APIErrorCode.RestrictedResource,
      status: 403,
      message: "Only public integrations can access this API.",
      headers: new Headers(),
      rawBodyText: "",
      additional_data: undefined,
      request_id: undefined,
    })

    process.env["LORE_USE_RUNTOOL_AGGREGATE"] = "1"
    const onDegraded = buildOrphanRateServicesStub(AGGREGATE_FIXTURE, {
      requestError: restrictedError,
    })
    const onDegradedResult = await captureOrphanRateLogs(() =>
      runOrphanRateReport(onDegraded.services, { apply: false })
    )

    const offMetric = parseOrphanRateLine(offResult.lines)
    const degradedMetric = parseOrphanRateLine(onDegradedResult.lines)

    expect(degradedMetric.path).toBe("js-enumeration")
    expect(degradedMetric.pct).toBe(offMetric.pct)
    expect(degradedMetric.orphans).toBe(offMetric.orphans)
    expect(degradedMetric.totalGroups).toBe(offMetric.totalGroups)
    expect(degradedMetric.totalFacts).toBe(offMetric.totalFacts)

    expect(onDegraded.counters.requestCalls).toBe(1)
    expect(onDegraded.counters.queryBySubjectCalls).toBe(1)
  })

  it("flag-on with 400 validation_error re-throws (query-shape drift surfaces, no silent fallback)", async () => {
    // Validation errors signal query-shape drift — a column rename,
    // gateway syntax change, or parameter binding shape change.
    // Silent fallback would mask a permanent SQL-rollout failure
    // as "REST/JS path always ran"; the load-bearing rule is to
    // surface them to the operator.
    process.env["LORE_USE_RUNTOOL_AGGREGATE"] = "1"

    const { APIResponseError, APIErrorCode } = await import("@notionhq/client")
    const validationError = new APIResponseError({
      code: APIErrorCode.ValidationError,
      status: 400,
      message: "no such column: SubjectEntity",
      headers: new Headers(),
      rawBodyText: "",
      additional_data: undefined,
      request_id: undefined,
    })

    const stub = buildOrphanRateServicesStub(AGGREGATE_FIXTURE, {
      requestError: validationError,
    })
    await expect(
      runOrphanRateReport(stub.services, { apply: false })
    ).rejects.toBeInstanceOf(APIResponseError)

    // The JS fallback was NOT invoked — re-throw on validation_error
    // is the load-bearing rule.
    expect(stub.counters.requestCalls).toBe(1)
    expect(stub.counters.queryBySubjectCalls).toBe(0)
  })

  it("flag-on (no env set) inherits from the default-on parent and routes through the aggregate path", async () => {
    // Issue #543 default flip: with no env vars set, the parent
    // `LORE_USE_RUNTOOL` defaults ON and `LORE_USE_RUNTOOL_AGGREGATE`
    // inherits — so the aggregate path runs without any operator
    // opt-in. Pin this behavior here so a future "back to default
    // off" change fails loudly across both the unit test suite and
    // the integration A/B harness.
    delete process.env["LORE_USE_RUNTOOL_AGGREGATE"]
    delete process.env["LORE_USE_RUNTOOL"]

    // Per PR #549 review iteration 1 should-fix #6: assert env is
    // genuinely unset at the moment the harness runs, instead of
    // implicitly trusting the hook ordering. A future setupFile
    // change (or vitest version change) that runs the global
    // `tests/setup-runtool-flag.ts` `beforeEach` AFTER the
    // describe-block's `beforeEach` would silently re-pin the
    // parent to `=0` and make this test report
    // `path: "js-enumeration"`, defeating the assertion.
    expect(process.env["LORE_USE_RUNTOOL"]).toBeUndefined()
    expect(process.env["LORE_USE_RUNTOOL_AGGREGATE"]).toBeUndefined()

    const stub = buildOrphanRateServicesStub(AGGREGATE_FIXTURE)
    const result = await captureOrphanRateLogs(() =>
      runOrphanRateReport(stub.services, { apply: false })
    )
    const metric = parseOrphanRateLine(result.lines)
    expect(metric.path).toBe("runtool-aggregate")
    expect(stub.counters.requestCalls).toBe(1)
    expect(stub.counters.queryBySubjectCalls).toBe(0)
  })
})
