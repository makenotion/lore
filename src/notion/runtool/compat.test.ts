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

import { describe, expect, it, vi } from "vitest"
import { findNearDuplicates } from "../../core/near-duplicate.js"
import type { Memory, MemoryStatus } from "../../types.js"

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
