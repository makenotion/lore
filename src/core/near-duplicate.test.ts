import { describe, expect, it, vi } from "vitest"
import {
  AutosaveLearningDuplicateProbeError,
  extractEntityCandidates,
  findAutosaveLearningDuplicate,
  findDuplicateActiveTasks,
  findExactReuseTarget,
  findNearDuplicates,
  findRelatedActiveTasks,
  type MemoryLister,
  type TaskLister,
} from "./near-duplicate.js"
import type { Memory, TaskSummary } from "../types.js"

function makeMemory(overrides: Partial<Memory> & { id: string; title: string }): Memory {
  return {
    projectIds: ["proj-a"],
    topicId: null,
    source: "manual",
    kind: "note",
    status: "informational",
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
    tags: [],
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
    ...overrides,
  }
}

function makeLister(
  items: Memory[]
): MemoryLister & { listSpy: ReturnType<typeof vi.fn> } {
  const listSpy = vi.fn().mockResolvedValue({ items })
  return { list: listSpy, listSpy }
}

describe("findNearDuplicates", () => {
  it("short-circuits when LORE_DISABLE_NEAR_DUPLICATE_PROBE=1 (operator kill-switch)", async () => {
    const listSpy = vi.fn()
    vi.stubEnv("LORE_DISABLE_NEAR_DUPLICATE_PROBE", "1")
    try {
      const result = await findNearDuplicates(
        { list: listSpy },
        {
          title: "Anything",
          tags: [],
          projectId: "proj-a",
          threshold: 0.7,
        }
      )
      expect(result).toEqual([])
      expect(listSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("runs normally when LORE_DISABLE_NEAR_DUPLICATE_PROBE is anything other than '1'", async () => {
    const listSpy = vi.fn().mockResolvedValue({ items: [] })
    vi.stubEnv("LORE_DISABLE_NEAR_DUPLICATE_PROBE", "0")
    try {
      await findNearDuplicates(
        { list: listSpy },
        {
          title: "Anything",
          tags: [],
          projectId: "proj-a",
          threshold: 0.7,
        }
      )
      expect(listSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("returns [] when no projectId is given (vault-wide probes are skipped)", async () => {
    const lister = makeLister([])
    const result = await findNearDuplicates(lister, {
      title: "Anything",
      tags: [],
      threshold: 0.7,
    })
    expect(result).toEqual([])
    // No wasted Notion query on the unscoped path.
    expect(lister.listSpy).not.toHaveBeenCalled()
  })

  it("returns [] for an empty title (degenerate input, no useful signal)", async () => {
    const lister = makeLister([])
    const result = await findNearDuplicates(lister, {
      title: "   ",
      tags: [],
      projectId: "proj-a",
      threshold: 0.7,
    })
    expect(result).toEqual([])
    expect(lister.listSpy).not.toHaveBeenCalled()
  })

  it("passes the top-2 tags into the list filter (candidate-pool scoping)", async () => {
    const lister = makeLister([])
    await findNearDuplicates(lister, {
      title: "Something",
      tags: ["architecture", "core", "performance", "bug"],
      projectId: "proj-a",
      threshold: 0.7,
    })
    expect(lister.listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ["architecture", "core"] })
    )
  })

  it("omits the tag filter entirely when the caller has no tags", async () => {
    // Project scope alone is enough of a candidate pool when tags are
    // absent — passing `tags: []` would return nothing from Notion's OR
    // filter.
    const lister = makeLister([])
    await findNearDuplicates(lister, {
      title: "Something",
      tags: [],
      projectId: "proj-a",
      threshold: 0.7,
    })
    expect(lister.listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tags: undefined })
    )
  })

  it("skips the per-page markdown fetch (probe only needs titles)", async () => {
    const lister = makeLister([])
    await findNearDuplicates(lister, {
      title: "Something",
      tags: [],
      projectId: "proj-a",
      threshold: 0.7,
    })
    expect(lister.listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ includeContent: false })
    )
  })

  it("surfaces matches whose title trigram similarity meets the threshold", async () => {
    const lister = makeLister([
      makeMemory({
        id: "mem-1",
        title: "Wakeup hook swallows errors silently",
        tags: ["architecture"],
      }),
      makeMemory({ id: "mem-2", title: "Unrelated memory about database migrations" }),
    ])
    const result = await findNearDuplicates(lister, {
      title: "Wakeup hook swallows errors silently",
      tags: ["architecture"],
      projectId: "proj-a",
      threshold: 0.7,
    })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("mem-1")
    expect(result[0].titleSimilarity).toBeCloseTo(1)
    expect(result[0].tagOverlap).toBeCloseTo(1)
  })

  it("sorts results by title similarity descending", async () => {
    const lister = makeLister([
      makeMemory({ id: "mem-mid", title: "Wakeup hook swallows errors" }),
      makeMemory({ id: "mem-high", title: "Wakeup hook swallows errors silently" }),
      makeMemory({ id: "mem-low", title: "Wakeup hook" }),
    ])
    const result = await findNearDuplicates(lister, {
      title: "Wakeup hook swallows errors silently",
      tags: [],
      projectId: "proj-a",
      threshold: 0.1,
    })
    const ids = result.map((m) => m.id)
    // Descending by similarity: identical first, then partial, then low.
    expect(ids[0]).toBe("mem-high")
    expect(ids[1]).toBe("mem-mid")
    expect(ids[2]).toBe("mem-low")
  })

  it("drops rows with similarity strictly below threshold", async () => {
    const lister = makeLister([
      makeMemory({ id: "mem-1", title: "Completely unrelated topic" }),
    ])
    const result = await findNearDuplicates(lister, {
      title: "Wakeup hook crash",
      tags: [],
      projectId: "proj-a",
      threshold: 0.7,
    })
    expect(result).toEqual([])
  })

  it("filters by status whitelist client-side", async () => {
    // `lore-decide` needs `accepted OR proposed` — Notion's query accepts
    // one status clause, so the probe post-filters instead of issuing
    // two server queries for one probe.
    const lister = makeLister([
      makeMemory({
        id: "dec-accepted",
        title: "Replace auth middleware",
        kind: "decision",
        status: "accepted",
      }),
      makeMemory({
        id: "dec-superseded",
        title: "Replace auth middleware",
        kind: "decision",
        status: "superseded",
      }),
    ])
    const result = await findNearDuplicates(lister, {
      title: "Replace auth middleware",
      tags: [],
      projectId: "proj-a",
      kind: "decision",
      statuses: ["accepted", "proposed"],
      threshold: 0.6,
    })
    expect(result.map((m) => m.id)).toEqual(["dec-accepted"])
  })

  it("forwards includeProposed: true when statuses includes 'proposed' (decision-probe write-safety opt-in)", async () => {
    // The default recall filter excludes proposed rows. The decision
    // near-duplicate probe contracts to scan `accepted | proposed` candidates,
    // so it must opt in to proposed rows whenever its post-fetch `statuses`
    // whitelist includes `proposed`.
    const listSpy = vi.fn().mockResolvedValue({ items: [] })
    await findNearDuplicates(
      { list: listSpy },
      {
        title: "Replace auth middleware",
        tags: [],
        projectId: "proj-a",
        kind: "decision",
        statuses: ["accepted", "proposed"],
        threshold: 0.6,
      }
    )
    expect(listSpy).toHaveBeenCalledTimes(1)
    expect(listSpy.mock.calls[0]![0]).toMatchObject({ includeProposed: true })
  })

  it("omits includeProposed when statuses does not include 'proposed' (memory-probe default-recall posture)", async () => {
    // Memory near-dup probes pass no `statuses` (or only
    // `accepted`); the default-recall posture is correct —
    // proposed inbox rows do not surface as memory-side
    // near-duplicate candidates. Pin that the helper does NOT
    // opt in absent an explicit `proposed` in the status set,
    // so the inbox stays out of memory-write warnings.
    const listSpy = vi.fn().mockResolvedValue({ items: [] })
    await findNearDuplicates(
      { list: listSpy },
      {
        title: "Wakeup hook crash",
        tags: [],
        projectId: "proj-a",
        threshold: 0.7,
      }
    )
    expect(listSpy).toHaveBeenCalledTimes(1)
    expect(listSpy.mock.calls[0]![0].includeProposed).toBeUndefined()
  })

  it("filters out kinds listed in excludeKinds (memory probe drops decisions)", async () => {
    const lister = makeLister([
      makeMemory({ id: "note", title: "Wakeup hook crash", kind: "note" }),
      makeMemory({ id: "dec", title: "Wakeup hook crash", kind: "decision" }),
    ])
    const result = await findNearDuplicates(lister, {
      title: "Wakeup hook crash",
      tags: [],
      projectId: "proj-a",
      threshold: 0.7,
      excludeKinds: ["decision"],
    })
    expect(result.map((m) => m.id)).toEqual(["note"])
  })

  it("swallows list() errors and returns [] (probe failures must not fail the save)", async () => {
    const listSpy = vi.fn().mockRejectedValue(new Error("notion 503"))
    const result = await findNearDuplicates(
      { list: listSpy },
      {
        title: "Anything",
        tags: [],
        projectId: "proj-a",
        threshold: 0.7,
      }
    )
    expect(result).toEqual([])
  })

  it("invokes onError when the list query throws (operator observability hook)", async () => {
    const err = new Error("notion 503")
    const listSpy = vi.fn().mockRejectedValue(err)
    const onError = vi.fn()

    const result = await findNearDuplicates(
      { list: listSpy },
      {
        title: "Anything",
        tags: [],
        projectId: "proj-a",
        threshold: 0.7,
        onError,
      }
    )

    expect(result).toEqual([])
    expect(onError).toHaveBeenCalledWith(err)
  })

  it("forwards topicId through to the lister (decision probe scopes by topic)", async () => {
    const lister = makeLister([])
    await findNearDuplicates(lister, {
      title: "x",
      tags: [],
      projectId: "proj-a",
      topicId: "topic-z",
      kind: "decision",
      threshold: 0.6,
    })
    expect(lister.listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ topicId: "topic-z", kind: "decision" })
    )
  })

  it("excludes resurfaced cleanup-orphans tagged with the sentinel keyword (issue #477)", async () => {
    // Repro for issue #477. A `MemoryService.create` body-write failure
    // archives the orphan AND tags its `Keywords` column with
    // `__lore-cleanup-orphan` in one atomic update. Notion's archive
    // is reversible — within ~30 days an operator can restore the row
    // from workspace trash. Once restored the row is "live" again and
    // `MemoryService.list`'s default filters surface it. The advisory
    // probe must drop it post-list so it cannot be returned as a
    // dedup target whose body is empty.
    const lister = makeLister([
      makeMemory({
        id: "mem-orphan-resurfaced",
        title: "Decision: replace auth middleware",
        keywords: "__lore-cleanup-orphan",
      }),
      makeMemory({
        id: "mem-real",
        title: "Decision: replace auth middleware",
        keywords: "auth, middleware",
      }),
    ])
    const result = await findNearDuplicates(lister, {
      title: "Decision: replace auth middleware",
      tags: [],
      projectId: "proj-a",
      threshold: 0.7,
    })
    expect(result.map((m) => m.id)).toEqual(["mem-real"])
  })
})

describe("findNearDuplicates — listForNearDuplicates branch (issue #535)", () => {
  // Explicit parameter type so vitest infers a non-empty `mock.calls`
  // tuple. `vi.fn(async () => [])` would otherwise infer `[]` for
  // params and `mock.calls[0]![0]` becomes a type error.
  type SqlListerOpts =
    NonNullable<MemoryLister["listForNearDuplicates"]> extends (
      o: infer O
    ) => Promise<unknown>
      ? O
      : never

  it("routes through listForNearDuplicates when the lister exposes it", async () => {
    const listSpy = vi.fn().mockResolvedValue({ items: [] })
    const sqlSpy = vi.fn(async (_opts: SqlListerOpts) => [
      makeMemory({ id: "mem-1", title: "MemoryService refactor", status: "accepted" }),
    ])
    const result = await findNearDuplicates(
      { list: listSpy, listForNearDuplicates: sqlSpy },
      {
        title: "MemoryService refactor",
        tags: ["refactor"],
        projectId: "proj-a",
        threshold: 0.5,
        excludeKinds: ["decision"],
        statuses: ["accepted", "proposed"],
        limit: 25,
      }
    )

    expect(result.map((m) => m.id)).toEqual(["mem-1"])
    expect(sqlSpy).toHaveBeenCalledTimes(1)
    expect(listSpy).not.toHaveBeenCalled()
    const opts = sqlSpy.mock.calls[0]![0]!
    expect(opts.projectId).toBe("proj-a")
    expect(opts.excludeKinds).toEqual(["decision"])
    expect(opts.statuses).toEqual(["accepted", "proposed"])
    expect(opts.limit).toBe(25)
    expect(opts.tags).toEqual(["refactor"])
  })

  it("falls through to list() when the lister has no listForNearDuplicates method", async () => {
    const listSpy = vi.fn().mockResolvedValue({
      items: [makeMemory({ id: "mem-1", title: "MemoryService refactor" })],
    })
    const result = await findNearDuplicates(
      { list: listSpy },
      {
        title: "MemoryService refactor",
        tags: [],
        projectId: "proj-a",
        threshold: 0.5,
      }
    )
    expect(result.map((m) => m.id)).toEqual(["mem-1"])
    expect(listSpy).toHaveBeenCalledTimes(1)
  })

  it("opts the lister into proposed rows when statuses contains 'proposed'", async () => {
    const sqlSpy = vi.fn(async (_opts: SqlListerOpts) => [] as Memory[])
    await findNearDuplicates(
      { list: vi.fn(), listForNearDuplicates: sqlSpy },
      {
        title: "x",
        tags: [],
        projectId: "proj-a",
        threshold: 0.5,
        statuses: ["accepted", "proposed"],
      }
    )
    expect(sqlSpy.mock.calls[0]![0]!.includeProposed).toBe(true)
  })

  it("does NOT opt into proposed rows when statuses does not include 'proposed'", async () => {
    const sqlSpy = vi.fn(async (_opts: SqlListerOpts) => [] as Memory[])
    await findNearDuplicates(
      { list: vi.fn(), listForNearDuplicates: sqlSpy },
      {
        title: "x",
        tags: [],
        projectId: "proj-a",
        threshold: 0.5,
        statuses: ["accepted"],
      }
    )
    expect(sqlSpy.mock.calls[0]![0]!.includeProposed).toBeUndefined()
  })

  it("returns [] on listForNearDuplicates failure (advisory contract preserved)", async () => {
    const onError = vi.fn()
    const sqlSpy = vi.fn(async (_opts: SqlListerOpts): Promise<Memory[]> => {
      throw new Error("boom")
    })
    const result = await findNearDuplicates(
      { list: vi.fn(), listForNearDuplicates: sqlSpy },
      {
        title: "x",
        tags: [],
        projectId: "proj-a",
        threshold: 0.5,
        onError,
      }
    )
    expect(result).toEqual([])
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it("forwards limit BEFORE truncation — the candidate pool is SQL-filtered (acceptance criterion #3)", async () => {
    // Pre-#535: the JS post-filter would receive 50 candidates and
    // throw away the decision-kind ones, leaving an under-sized
    // non-decision pool. Under #535, the lister sees `excludeKinds`
    // and `statuses` ahead of the limit, so 50 candidates means
    // 50 already-server-side-filtered candidates.
    const sqlSpy = vi.fn(
      async (_opts: SqlListerOpts): Promise<Memory[]> =>
        // 5 candidate rows, all post-filter — 0 of them are `decision`.
        Array.from({ length: 5 }, (_, i) =>
          makeMemory({
            id: `mem-${i}`,
            title: `MemoryService refactor v${i}`,
            kind: "note",
          })
        )
    )
    const result = await findNearDuplicates(
      { list: vi.fn(), listForNearDuplicates: sqlSpy },
      {
        title: "MemoryService refactor v0",
        tags: [],
        projectId: "proj-a",
        threshold: 0.3,
        excludeKinds: ["decision"],
        limit: 50,
      }
    )
    // Limit is forwarded to the lister; trigram match still runs.
    expect(sqlSpy.mock.calls[0]![0]!.limit).toBe(50)
    expect(sqlSpy.mock.calls[0]![0]!.excludeKinds).toEqual(["decision"])
    // Result is non-empty because the SQL-filtered pool already
    // excludes decisions.
    expect(result.length).toBeGreaterThan(0)
  })
})

describe("findAutosaveLearningDuplicate", () => {
  it("short-circuits when LORE_DISABLE_AUTOSAVE_LEARNING_DEDUP=1", async () => {
    const listSpy = vi.fn()
    vi.stubEnv("LORE_DISABLE_AUTOSAVE_LEARNING_DEDUP", "1")
    try {
      const result = await findAutosaveLearningDuplicate(
        { list: listSpy },
        {
          title: "Relation filters reject empty arrays",
          content: "Notion relation filters reject empty arrays.",
          projectId: "proj-a",
          session: "session-1",
        }
      )
      expect(result).toBeNull()
      expect(listSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("honors the shared near-duplicate kill-switch too", async () => {
    const listSpy = vi.fn()
    vi.stubEnv("LORE_DISABLE_NEAR_DUPLICATE_PROBE", "1")
    try {
      const result = await findAutosaveLearningDuplicate(
        { list: listSpy },
        {
          title: "Relation filters reject empty arrays",
          content: "Notion relation filters reject empty arrays.",
          projectId: "proj-a",
          session: "session-1",
        }
      )
      expect(result).toBeNull()
      expect(listSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("requires a session id in session scope", async () => {
    const lister = makeLister([
      makeMemory({
        id: "mem-1",
        title: "Relation filters reject empty arrays",
        content: "Notion relation filters reject empty arrays.",
      }),
    ])

    const result = await findAutosaveLearningDuplicate(lister, {
      title: "Relation filters reject empty arrays",
      content: "Notion relation filters reject empty arrays.",
      projectId: "proj-a",
    })

    expect(result).toBeNull()
    expect(lister.listSpy).not.toHaveBeenCalled()
  })

  it("requires a project id in project scope so cross-session reuse never goes vault-wide", async () => {
    const lister = makeLister([
      makeMemory({
        id: "mem-1",
        title: "Relation filters reject empty arrays",
        content: "Notion relation filters reject empty arrays.",
      }),
    ])

    const result = await findAutosaveLearningDuplicate(lister, {
      title: "Relation filters reject empty arrays",
      content: "Notion relation filters reject empty arrays.",
      session: "session-2",
      scope: "project",
    })

    expect(result).toBeNull()
    expect(lister.listSpy).not.toHaveBeenCalled()
  })

  it("queries autosave-learning notes in the same session and fetches bodies", async () => {
    const lister = makeLister([])

    await findAutosaveLearningDuplicate(lister, {
      title: "Relation filters reject empty arrays",
      content: "Notion relation filters reject empty arrays.",
      projectId: "proj-a",
      session: "session-1",
    })

    expect(lister.listSpy).toHaveBeenCalledWith({
      projectId: "proj-a",
      session: "session-1",
      source: "autosave_learning",
      kind: "note",
      limit: 50,
      includeContent: true,
      includeUnscoped: undefined,
      // The dedup gate must include proposed learnings because shared-vault
      // autosave can route learnings through the review inbox before they enter
      // default recall.
      includeProposed: true,
    })
  })

  it("queries autosave-learning notes across the project when project scope is requested", async () => {
    const lister = makeLister([])

    await findAutosaveLearningDuplicate(lister, {
      title: "Relation filters reject empty arrays",
      content: "Notion relation filters reject empty arrays.",
      projectId: "proj-a",
      projectIds: ["proj-a"],
      session: "session-2",
      scope: "project",
    })

    expect(lister.listSpy).toHaveBeenCalledWith({
      projectId: "proj-a",
      session: undefined,
      source: "autosave_learning",
      kind: "note",
      limit: 50,
      includeContent: true,
      includeUnscoped: true,
      // Both scopes are write-safety gates and must include proposed rows.
      includeProposed: true,
    })
  })

  it("returns the existing row for duplicate title/body pairs from overlapping transcript windows", async () => {
    const existing = makeMemory({
      id: "mem-existing",
      title: "Relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      session: "session-1",
      source: "autosave_learning",
      kind: "note",
    })
    const lister = makeLister([existing])

    const result = await findAutosaveLearningDuplicate(lister, {
      title: "Relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectId: "proj-a",
      session: "session-1",
    })

    expect(result?.id).toBe("mem-existing")
    expect(result?.titleSimilarity).toBeCloseTo(1)
    expect(result?.contentSimilarity).toBeCloseTo(1)
    expect(result?.tokenSimilarity).toBeCloseTo(1)
    expect(result?.projectIds).toEqual(["proj-a"])
    expect(result?.session).toBe("session-1")
  })

  it("returns a prior-session project match for the same durable fact", async () => {
    const existing = makeMemory({
      id: "mem-existing",
      title: "Relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      session: "session-1",
      source: "autosave_learning",
      kind: "note",
    })
    const lister = makeLister([existing])

    const result = await findAutosaveLearningDuplicate(lister, {
      title: "Relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectId: "proj-a",
      projectIds: ["proj-a"],
      session: "session-2",
      scope: "project",
    })

    expect(result?.id).toBe("mem-existing")
    expect(result?.session).toBe("session-1")
  })

  it("does not return a single-project row for a multi-project save", async () => {
    const existing = makeMemory({
      id: "mem-existing",
      title: "Relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectIds: ["proj-a"],
      session: "session-1",
      source: "autosave_learning",
      kind: "note",
    })
    const lister = makeLister([existing])

    const result = await findAutosaveLearningDuplicate(lister, {
      title: "Relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectId: "proj-a",
      projectIds: ["proj-a", "proj-b"],
      session: "session-2",
      scope: "project",
    })

    expect(result).toBeNull()
  })

  it("returns a multi-project match when the project set is exact", async () => {
    const existing = makeMemory({
      id: "mem-existing",
      title: "Relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectIds: ["proj-b", "proj-a"],
      session: "session-1",
      source: "autosave_learning",
      kind: "note",
    })
    const lister = makeLister([existing])

    const result = await findAutosaveLearningDuplicate(lister, {
      title: "Relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectIds: ["proj-a", "proj-b"],
      session: "session-2",
      scope: "project",
    })

    expect(result?.id).toBe("mem-existing")
    expect(lister.listSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-a",
        includeUnscoped: true,
      })
    )
  })

  it("can reuse a source-marked unscoped learning from a later scoped project save", async () => {
    const existing = makeMemory({
      id: "mem-unscoped",
      title: "Relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectIds: [],
      session: null,
      source: "autosave_learning",
      kind: "note",
    })
    const lister = makeLister([existing])

    const result = await findAutosaveLearningDuplicate(lister, {
      title: "Relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectId: "proj-a",
      projectIds: ["proj-a"],
      session: "session-2",
      scope: "project",
    })

    expect(result?.id).toBe("mem-unscoped")
    expect(result?.projectIds).toEqual([])
    expect(result?.session).toBeNull()
  })

  it("catches reordered paraphrases of the same atomic learning", async () => {
    const existing = makeMemory({
      id: "mem-existing",
      title: "dataSources.query rejects empty relation filters",
      content: "Notion's dataSources.query rejects relation filters with empty arrays.",
      session: "session-1",
      source: "autosave_learning",
      kind: "note",
    })
    const lister = makeLister([existing])

    const result = await findAutosaveLearningDuplicate(lister, {
      title: "empty-array relation filters are rejected",
      content: "Empty-array relation filters are rejected by dataSources.query.",
      projectId: "proj-a",
      session: "session-1",
    })

    expect(result?.id).toBe("mem-existing")
    expect(result?.tokenSimilarity).toBeGreaterThanOrEqual(0.72)
  })

  it("does not block distinct learnings from the same session", async () => {
    const lister = makeLister([
      makeMemory({
        id: "mem-other",
        title: "Digest prompts use source digest",
        content: "Background digests save memories with source digest.",
        session: "session-1",
        source: "autosave_learning",
        kind: "note",
      }),
    ])

    const result = await findAutosaveLearningDuplicate(lister, {
      title: "Relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectId: "proj-a",
      session: "session-1",
    })

    expect(result).toBeNull()
  })

  it("does not block distinct learnings with a shared technical prefix", async () => {
    const lister = makeLister([
      makeMemory({
        id: "mem-other",
        title: "dataSources.query relation filter ids",
        content:
          "Notion dataSources.query relation filters must include at least one relation id before update.",
        session: "session-1",
        source: "autosave_learning",
        kind: "note",
      }),
    ])

    const result = await findAutosaveLearningDuplicate(lister, {
      title: "dataSources.query relation filter arrays",
      content:
        "Notion dataSources.query relation filters reject empty arrays before query execution.",
      projectId: "proj-a",
      session: "session-1",
    })

    expect(result).toBeNull()
  })

  it("does not block distinct learnings that reuse the same short title", async () => {
    const lister = makeLister([
      makeMemory({
        id: "mem-other",
        title: "Relation filter gotcha",
        content: "Relation filters must include at least one relation id.",
        session: "session-1",
        source: "autosave_learning",
        kind: "note",
      }),
    ])

    const result = await findAutosaveLearningDuplicate(lister, {
      title: "Relation filter gotcha",
      content: "Relation filters reject empty arrays before query execution.",
      projectId: "proj-a",
      session: "session-1",
    })

    expect(result).toBeNull()
  })

  it("does not let a synopsis-style conversation note suppress an atomic learning", async () => {
    const lister = makeLister([
      makeMemory({
        id: "mem-synopsis",
        title: "Relation filters reject empty arrays",
        content: "Notion dataSources.query rejects relation filters with empty arrays.",
        session: "session-1",
        source: "conversation",
        kind: "note",
      }),
    ])

    const result = await findAutosaveLearningDuplicate(lister, {
      title: "Relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectId: "proj-a",
      session: "session-1",
    })

    expect(result).toBeNull()
  })

  it("fails closed on list errors and reports them through onError", async () => {
    const err = new Error("notion 503")
    const listSpy = vi.fn().mockRejectedValue(err)
    const onError = vi.fn()

    await expect(
      findAutosaveLearningDuplicate(
        { list: listSpy },
        {
          title: "Relation filters reject empty arrays",
          content: "Notion dataSources.query rejects relation filters with empty arrays.",
          projectId: "proj-a",
          session: "session-1",
          onError,
        }
      )
    ).rejects.toBeInstanceOf(AutosaveLearningDuplicateProbeError)

    expect(onError).toHaveBeenCalledWith(err)
  })

  it("excludes resurfaced cleanup-orphans tagged with the sentinel keyword (issue #477)", async () => {
    // The autosave-learning probe is BLOCKING — when it returns a hit,
    // the caller reuses that row instead of creating a new one. A
    // resurfaced cleanup-orphan can have the right source/kind shape and an empty body, so
    // a body-trigram comparison against an incoming learning would
    // produce a misleading similarity score. The sentinel keyword
    // exclusion ensures the orphan can never be returned as a reuse
    // target — the surviving real row wins, and if no real row exists
    // the probe returns null and the create proceeds as expected.
    const lister = makeLister([
      makeMemory({
        id: "mem-orphan-resurfaced",
        title: "Notion relation filters reject empty arrays",
        content: "",
        source: "autosave_learning",
        kind: "note",
        session: "session-1",
        keywords: "__lore-cleanup-orphan",
      }),
      makeMemory({
        id: "mem-real",
        title: "Notion relation filters reject empty arrays",
        content: "Notion relation filters reject empty arrays.",
        source: "autosave_learning",
        kind: "note",
        session: "session-1",
        keywords: "notion, dedup",
      }),
    ])

    const result = await findAutosaveLearningDuplicate(lister, {
      title: "Notion relation filters reject empty arrays",
      content: "Notion relation filters reject empty arrays.",
      projectId: "proj-a",
      session: "session-1",
    })

    expect(result?.id).toBe("mem-real")
  })

  it("returns null when the only candidate is a resurfaced cleanup-orphan (issue #477)", async () => {
    // Mirror of the test above for the case where there is no real
    // counterpart row. The probe must return null so the caller's
    // create proceeds — under the bug, the orphan would be returned
    // and the caller would attempt to "reuse" an empty-body shell.
    const lister = makeLister([
      makeMemory({
        id: "mem-orphan-resurfaced",
        title: "Notion relation filters reject empty arrays",
        content: "",
        source: "autosave_learning",
        kind: "note",
        session: "session-1",
        keywords: "__lore-cleanup-orphan",
      }),
    ])

    const result = await findAutosaveLearningDuplicate(lister, {
      title: "Notion relation filters reject empty arrays",
      content: "Notion relation filters reject empty arrays.",
      projectId: "proj-a",
      session: "session-1",
    })

    expect(result).toBeNull()
  })
})

function makeTaskSummary(
  overrides: Partial<TaskSummary> & { id: string; title: string }
): TaskSummary {
  return {
    projectIds: ["proj-a"],
    topicId: null,
    source: "manual",
    kind: "task",
    status: "informational",
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
    tags: [],
    keywords: "",
    synopsis: "",
    session: "",
    taskState: "open",
    blockedBy: "",
    // Default `entity` to title to mirror `TaskService.create`'s
    // omitted-entity behavior; an explicit `overrides.entity` wins
    // via the spread below. Spelled `entity ?? title` rather than
    // bare `overrides.title` so the override-or-default contract is
    // visible at the call site for future test authors.
    entity: overrides.entity ?? overrides.title,
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  }
}

function makeTaskLister(
  items: TaskSummary[]
): TaskLister & { listSpy: ReturnType<typeof vi.fn> } {
  const listSpy = vi.fn().mockResolvedValue({ items })
  return { list: listSpy, listSpy }
}

describe("findDuplicateActiveTasks", () => {
  it("short-circuits when LORE_DISABLE_NEAR_DUPLICATE_PROBE=1 (operator kill-switch)", async () => {
    const listSpy = vi.fn()
    vi.stubEnv("LORE_DISABLE_NEAR_DUPLICATE_PROBE", "1")
    try {
      const result = await findDuplicateActiveTasks(
        { list: listSpy },
        { entity: "PR-1234", projectId: "proj-a" }
      )
      expect(result).toEqual([])
      expect(listSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("runs normally when LORE_DISABLE_NEAR_DUPLICATE_PROBE is anything other than '1'", async () => {
    const listSpy = vi.fn().mockResolvedValue({ items: [] })
    vi.stubEnv("LORE_DISABLE_NEAR_DUPLICATE_PROBE", "0")
    try {
      await findDuplicateActiveTasks(
        { list: listSpy },
        { entity: "PR-1234", projectId: "proj-a" }
      )
      expect(listSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("returns [] when entity is empty (degenerate input — no useful signal)", async () => {
    const lister = makeTaskLister([])
    const result = await findDuplicateActiveTasks(lister, {
      entity: "",
      projectId: "proj-a",
    })
    expect(result).toEqual([])
    // No wasted Notion call on the unscoped path.
    expect(lister.listSpy).not.toHaveBeenCalled()
  })

  it("returns [] when entity is whitespace-only", async () => {
    const lister = makeTaskLister([])
    const result = await findDuplicateActiveTasks(lister, {
      entity: "   ",
      projectId: "proj-a",
    })
    expect(result).toEqual([])
    expect(lister.listSpy).not.toHaveBeenCalled()
  })

  it("forwards entity, projectId, ACTIVE_TASK_STATES, limit=10, and sortBy='updatedAtDesc' into the list query", async () => {
    // The `sortBy: "updatedAtDesc"` pin is load-bearing for #265's
    // assertive-reuse contract: `findExactReuseTarget` returns the
    // first matching candidate, and the AGENTS.md / docstring claim
    // is "most-recently-edited wins on ties." `TaskService.list`'s
    // default sort is `reviewByAsc` — without an explicit override
    // the reuse helper would silently surface an older row when
    // multiple exact matches exist. A regression that drops the
    // sortBy here would make the recency tiebreak claim a lie; pin
    // it.
    const lister = makeTaskLister([])
    await findDuplicateActiveTasks(lister, {
      entity: "PR-1234",
      projectId: "proj-a",
    })
    expect(lister.listSpy).toHaveBeenCalledWith({
      projectId: "proj-a",
      entities: ["PR-1234"],
      states: ["open", "in-progress", "blocked"],
      limit: 10,
      sortBy: "updatedAtDesc",
    })
  })

  it("returns the raw set of active tasks — no exclusion of any kind", async () => {
    // Acceptance criterion: the helper performs no exclusion. Even if
    // the caller passes the just-created task's id back through some
    // surface, this helper does not (and cannot) filter by it. The
    // test pins that contract — every TaskSummary the lister returns
    // surfaces in the result, in the order the lister returned them.
    const items = [
      makeTaskSummary({ id: "task-1", title: "Track PR-1234 review" }),
      makeTaskSummary({ id: "task-2", title: "PR-1234 follow-up" }),
      makeTaskSummary({ id: "task-3", title: "PR-1234 redux" }),
    ]
    const lister = makeTaskLister(items)
    const result = await findDuplicateActiveTasks(lister, {
      entity: "PR-1234",
      projectId: "proj-a",
    })
    expect(result.map((t) => t.id)).toEqual(["task-1", "task-2", "task-3"])
  })

  it("swallows list() errors and returns [] (probe failures must not fail the create)", async () => {
    const listSpy = vi.fn().mockRejectedValue(new Error("notion 503"))
    const result = await findDuplicateActiveTasks(
      { list: listSpy },
      { entity: "PR-1234", projectId: "proj-a" }
    )
    expect(result).toEqual([])
  })

  it("invokes onError when the list query throws (operator observability hook)", async () => {
    const err = new Error("notion 503")
    const listSpy = vi.fn().mockRejectedValue(err)
    const onError = vi.fn()

    const result = await findDuplicateActiveTasks(
      { list: listSpy },
      { entity: "PR-1234", projectId: "proj-a", onError }
    )

    expect(result).toEqual([])
    expect(onError).toHaveBeenCalledWith(err)
  })

  it("allows an undefined projectId — vault-wide active-task probe is well-defined", async () => {
    // Unlike `findNearDuplicates`, which skips vault-wide probes
    // because they'd scan the whole Memories DB, the task probe rides
    // `TaskService.list`'s `projectOrUnscopedFilter` which already
    // bounds the query to active tasks. An unscoped call is rare in
    // practice (the wire-in always passes `resolved.ids[0]`), but the
    // helper must not refuse it — projectless tasks exist.
    const lister = makeTaskLister([
      makeTaskSummary({ id: "task-1", title: "Track PR-1234" }),
    ])
    const result = await findDuplicateActiveTasks(lister, {
      entity: "PR-1234",
    })
    expect(result.map((t) => t.id)).toEqual(["task-1"])
    expect(lister.listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: undefined })
    )
  })

  it("decodes HTML entities in `entity` before issuing the server-side `Entity contains` filter (issue #265)", async () => {
    // `TaskService.create` decodes `entity` at the write boundary
    // (`src/core/task.ts:180`), so a stored row's Entity column is
    // the decoded form. A caller passing `"PR &amp; Review"` should
    // probe for `"PR & Review"` to find any pre-PF1-06 row whose
    // Entity column was decoded at write time. Without the decode
    // here, the encoded form would substring-miss on the server
    // side and reuse would silently fall through to create.
    const lister = makeTaskLister([])
    await findDuplicateActiveTasks(lister, {
      entity: "PR &amp; Review",
      projectId: "proj-a",
    })
    expect(lister.listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ entities: ["PR & Review"] })
    )
  })

  it("short-circuits to [] when entity decodes to whitespace-only (degenerate input)", async () => {
    // A pathological caller passing `"&nbsp;"` decodes to a
    // non-breaking space; treat it the same as the raw whitespace-
    // only short-circuit above so the helper does not issue a
    // server-side `Entity contains " "` query.
    const lister = makeTaskLister([])
    const result = await findDuplicateActiveTasks(lister, {
      entity: "&#32;",
      projectId: "proj-a",
    })
    expect(result).toEqual([])
    expect(lister.listSpy).not.toHaveBeenCalled()
  })
})

describe("findExactReuseTarget (issue #265 — assertive task reuse)", () => {
  it("returns null when LORE_DISABLE_TASK_REUSE=1 (single-axis kill switch)", () => {
    const candidates = [
      makeTaskSummary({
        id: "task-1",
        title: "Track PR-1234 review",
        entity: "PR-1234",
      }),
    ]
    vi.stubEnv("LORE_DISABLE_TASK_REUSE", "1")
    try {
      expect(
        findExactReuseTarget(candidates, {
          subject: "Track PR-1234 review",
          entity: "PR-1234",
          projectIds: ["proj-a"],
        })
      ).toBeNull()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("runs normally when LORE_DISABLE_TASK_REUSE is unset or anything other than '1'", () => {
    const candidates = [
      makeTaskSummary({
        id: "task-1",
        title: "Track PR-1234 review",
        entity: "PR-1234",
      }),
    ]
    vi.stubEnv("LORE_DISABLE_TASK_REUSE", "0")
    try {
      const target = findExactReuseTarget(candidates, {
        subject: "Track PR-1234 review",
        entity: "PR-1234",
        projectIds: ["proj-a"],
      })
      expect(target?.id).toBe("task-1")
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("returns null on whitespace-only subject (degenerate input must not silently reuse)", () => {
    const candidates = [
      makeTaskSummary({ id: "task-1", title: "   ", entity: "PR-1234" }),
    ]
    expect(
      findExactReuseTarget(candidates, {
        subject: "   ",
        entity: "PR-1234",
        projectIds: ["proj-a"],
      })
    ).toBeNull()
  })

  it("returns null on whitespace-only entity", () => {
    const candidates = [
      makeTaskSummary({ id: "task-1", title: "Rotate keys", entity: "  " }),
    ]
    expect(
      findExactReuseTarget(candidates, {
        subject: "Rotate keys",
        entity: " ",
        projectIds: ["proj-a"],
      })
    ).toBeNull()
  })

  it("matches on exact normalized title and entity in the same project set", () => {
    const candidates = [
      makeTaskSummary({
        id: "task-1",
        title: "Track PR-1234 review",
        entity: "PR-1234",
        projectIds: ["proj-a"],
      }),
    ]
    const target = findExactReuseTarget(candidates, {
      subject: "Track PR-1234 review",
      entity: "PR-1234",
      projectIds: ["proj-a"],
    })
    expect(target?.id).toBe("task-1")
  })

  it("normalizes case, NFKC, and internal whitespace before equality", () => {
    // Stored row was saved with idiosyncratic casing and a full-width
    // hash; the new caller normalizes both — same task. Pre-#265 the
    // probe would surface the row in the advisory footer; #265 reuses
    // it.
    const candidates = [
      makeTaskSummary({
        id: "task-1",
        title: "Track PR ＃1234  Review",
        entity: "pr-1234",
      }),
    ]
    const target = findExactReuseTarget(candidates, {
      subject: "track pr #1234 review",
      entity: "PR-1234",
      projectIds: ["proj-a"],
    })
    expect(target?.id).toBe("task-1")
  })

  it("decodes HTML entities before equality (un-migrated vault encoded titles match decoded callers)", () => {
    // Pre-PF1-06 vault: stored row carries an encoded title because
    // the autosave hook delivered the field with an HTML-entity-
    // escaped `&`. Post-PF1-06 caller passes the decoded subject.
    // `TaskService.create` decodes at the write boundary, so the
    // structural identity is the decoded form — reuse must compute
    // the same canonical form on both sides. Without the decode
    // step in `normalizeReuseKey`, this test fails: the encoded
    // title's `"&amp;"` literal does not normalize to the decoded
    // caller's `"&"` and reuse misses, landing a duplicate row —
    // exactly the silent-miss the principal review flagged as a
    // blocker.
    const candidates = [
      makeTaskSummary({
        id: "task-1",
        title: "Café &amp; Bar review",
        entity: "Café &amp; Bar",
      }),
    ]
    const target = findExactReuseTarget(candidates, {
      subject: "Café & Bar review",
      entity: "Café & Bar",
      projectIds: ["proj-a"],
    })
    expect(target?.id).toBe("task-1")
  })

  it("uses locale-independent .toLowerCase() so reuse is consistent across engineer locales", () => {
    // Vault state is shared across engineers; comparison is per-
    // process. Turkish-locale `.toLocaleLowerCase()` collapses
    // `"INVOICE"` to `"ınvoice"` (dotless-ı), en-US to `"invoice"`.
    // A reuse predicate based on `.toLocaleLowerCase()` would
    // produce different verdicts for the same vault on engineers
    // running under different locales — a consistency hazard the
    // rest of the codebase avoids by using `.toLowerCase()`.
    //
    // The Turkish-locale dotless-ı failure mode is most cleanly
    // demonstrated on uppercase `"I"`: `"AUDIT INVOICE".toLocaleLowerCase("tr-TR")`
    // produces `"audıt ınvoice"`. Locale-independent lowercase
    // produces `"audit invoice"` regardless of the host locale.
    // This test mounts directly on `normalizeReuseKey`'s output
    // shape: a stored title `"Audit Invoice"` plus a caller
    // subject `"AUDIT INVOICE"` must reuse — both normalize to
    // `"audit invoice"` under `.toLowerCase()`.
    const candidates = [
      makeTaskSummary({
        id: "task-1",
        title: "Audit Invoice",
        entity: "Invoice-2026",
      }),
    ]
    const target = findExactReuseTarget(candidates, {
      subject: "AUDIT INVOICE",
      entity: "INVOICE-2026",
      projectIds: ["proj-a"],
    })
    expect(target?.id).toBe("task-1")
  })

  it("collapses multiple-space subject differences before equality", () => {
    // Pre-#265 the autosave learning extractor surfaced the same
    // follow-up across two sessions with slightly-different
    // whitespace ("Track  PR-1234  review" vs "Track PR-1234
    // review"). The whitespace-collapse step in `normalizeReuseKey`
    // makes those structurally identical — reuse must fire. A
    // future contributor narrowing the normalizer (e.g. dropping
    // the `\s+ → " "` step) trips this fixture.
    const candidates = [
      makeTaskSummary({
        id: "task-1",
        title: "Track PR-1234 review",
        entity: "PR-1234",
      }),
    ]
    const target = findExactReuseTarget(candidates, {
      subject: "Track  PR-1234   review",
      entity: "PR-1234",
      projectIds: ["proj-a"],
    })
    expect(target?.id).toBe("task-1")
  })

  it("rejects an entity SUPERSTRING match (probe widens; predicate narrows)", () => {
    // Server-side `Entity contains "PR-1"` matches a stored row whose
    // entity is `"PR-100"`. Without the post-fetch normalized-equality
    // check, reuse would fire on a task tracking the wrong PR — the
    // exact failure mode the predicate is designed to prevent.
    const candidates = [
      makeTaskSummary({
        id: "task-1",
        title: "Track review",
        entity: "PR-100",
      }),
    ]
    const target = findExactReuseTarget(candidates, {
      subject: "Track review",
      entity: "PR-1",
      projectIds: ["proj-a"],
    })
    expect(target).toBeNull()
  })

  it("rejects when the existing title is a superstring of the new subject", () => {
    // Probe surfaces the candidate via entity match, but the stored
    // title strictly contains the caller's subject — different task.
    // Without the title-equality check, reuse would fire on a row
    // whose title was extended over time and silently shadow the new
    // create.
    const candidates = [
      makeTaskSummary({
        id: "task-1",
        title: "Track PR-1234 review and follow up",
        entity: "PR-1234",
      }),
    ]
    expect(
      findExactReuseTarget(candidates, {
        subject: "Track PR-1234 review",
        entity: "PR-1234",
        projectIds: ["proj-a"],
      })
    ).toBeNull()
  })

  it("rejects when project sets diverge (set-equality, not overlap)", () => {
    // Mirrors `MemoryService.upsertByTopicKey`: `[A]` does not match
    // `[A, B]`. A scoped task and a multi-scoped task with the same
    // subject/entity are NOT the same task structurally.
    const candidates = [
      makeTaskSummary({
        id: "task-1",
        title: "Track PR-1234 review",
        entity: "PR-1234",
        projectIds: ["proj-a"],
      }),
    ]
    expect(
      findExactReuseTarget(candidates, {
        subject: "Track PR-1234 review",
        entity: "PR-1234",
        projectIds: ["proj-a", "proj-b"],
      })
    ).toBeNull()
  })

  it("matches multi-project tasks under set-equality (order-independent)", () => {
    const candidates = [
      makeTaskSummary({
        id: "task-1",
        title: "Track PR-1234 review",
        entity: "PR-1234",
        projectIds: ["proj-a", "proj-b"],
      }),
    ]
    const target = findExactReuseTarget(candidates, {
      subject: "Track PR-1234 review",
      entity: "PR-1234",
      projectIds: ["proj-b", "proj-a"],
    })
    expect(target?.id).toBe("task-1")
  })

  it("matches an empty-projectIds (repo-wide) task against another empty-projectIds caller", () => {
    const candidates = [
      makeTaskSummary({
        id: "task-1",
        title: "Audit auth flow",
        entity: "AuthService",
        projectIds: [],
      }),
    ]
    const target = findExactReuseTarget(candidates, {
      subject: "Audit auth flow",
      entity: "AuthService",
      projectIds: [],
    })
    expect(target?.id).toBe("task-1")
  })

  it("returns null on empty candidate list (advisory probe upstream returned [])", () => {
    expect(
      findExactReuseTarget([], {
        subject: "Track PR-1234 review",
        entity: "PR-1234",
        projectIds: ["proj-a"],
      })
    ).toBeNull()
  })

  it("returns the FIRST matching candidate when multiple exact matches exist (input-order tiebreak)", () => {
    // `findExactReuseTarget` is a pure predicate over a pre-sorted
    // input list — it iterates and returns the first match. The
    // upstream `findDuplicateActiveTasks` calls `tasks.list` with
    // `sortBy: "updatedAtDesc"`, so the most-recently-edited row
    // lands at index 0; the predicate's "first match wins"
    // contract surfaces the recency winner end-to-end. This unit
    // test pins the predicate's input-order contract directly
    // (independent of the upstream sort), so a regression that
    // re-orders the helper's iteration trips here. The
    // upstream-sort claim is pinned separately by the
    // `forwards entity, projectId, ACTIVE_TASK_STATES, limit=10,
    // and sortBy='updatedAtDesc' into the list query` test above.
    const candidates = [
      makeTaskSummary({
        id: "task-recent",
        title: "Rotate keys",
        entity: "AuthService",
      }),
      makeTaskSummary({
        id: "task-older",
        title: "Rotate keys",
        entity: "AuthService",
      }),
    ]
    const target = findExactReuseTarget(candidates, {
      subject: "Rotate keys",
      entity: "AuthService",
      projectIds: ["proj-a"],
    })
    expect(target?.id).toBe("task-recent")
  })
})

describe("extractEntityCandidates", () => {
  // The fixture-pinned tokenizer for `findRelatedActiveTasks`. Order
  // matters: high-precision patterns (PR / issue / Jira / URL) iterate
  // before the broad capitalized-phrase pattern so cap-induced
  // truncation drops the noisiest candidates first.

  it("returns [] when title, keywords, and synopsis are all empty", () => {
    expect(extractEntityCandidates("", "", "")).toEqual([])
  })

  it("returns [] when every input is whitespace-only", () => {
    expect(extractEntityCandidates("   ", "\t", "\n")).toEqual([])
  })

  it("extracts `PR #N` and the embedded `#N` substring as separate candidates", () => {
    // The Set dedup collapses identical strings, but `PR #1234` and
    // `#1234` are different literals — both useful as `Entity contains`
    // probes. The PR pattern fires before the standalone-#N pattern,
    // so `PR #1234` lands first in the result order.
    const result = extractEntityCandidates(
      "Merged PR #1234: outlook label.applied classifier",
      "",
      ""
    )
    expect(result).toContain("PR #1234")
    expect(result).toContain("#1234")
    // PR pattern wins the priority race.
    expect(result.indexOf("PR #1234")).toBeLessThan(result.indexOf("#1234"))
  })

  it("extracts `PR-N` (hyphenated form)", () => {
    const result = extractEntityCandidates("Track PR-1234 review", "", "")
    expect(result).toContain("PR-1234")
  })

  it("extracts standalone `#N` issue references", () => {
    const result = extractEntityCandidates("Closes #1234 finally", "", "")
    expect(result).toContain("#1234")
  })

  it("extracts Jira-style ABC-123 ids (>= 2 uppercase letters)", () => {
    const result = extractEntityCandidates("Fix SENTRY-1234 incident in IOS-25", "", "")
    expect(result).toContain("SENTRY-1234")
    expect(result).toContain("IOS-25")
  })

  it("rejects single-letter Jira shapes like `A-1` to avoid false positives", () => {
    // `[A-Z]+-\d+` would match `A-1`; we tightened to `{2,}` so
    // hyphenated single-letter prose doesn't pollute the candidate
    // pool. A-1, T-3, B-2 are common in bullet lists.
    const result = extractEntityCandidates("Item A-1 and B-2", "", "")
    expect(result).not.toContain("A-1")
    expect(result).not.toContain("B-2")
  })

  it("extracts URLs (http and https)", () => {
    const result = extractEntityCandidates(
      "See https://example.com/foo and http://bar.test/baz for context",
      "",
      ""
    )
    expect(result).toContain("https://example.com/foo")
    expect(result).toContain("http://bar.test/baz")
  })

  it("extracts 1-3 word capitalized phrases (greedy left-to-right)", () => {
    // The greedy multi-word match consumes adjacent capitalized words
    // starting from the first capital. For "Outlook Mobile App
    // shipped" the regex consumes the 3-word prefix "Outlook Mobile
    // App" as one candidate; downstream lowercase words terminate the
    // phrase. A 1-word fallback ("AuthService" alone) lands when no
    // adjacent capital follows.
    const phrase = extractEntityCandidates("Outlook Mobile App shipped today", "", "")
    expect(phrase).toContain("Outlook Mobile App")

    const single = extractEntityCandidates("AuthService refactor", "", "")
    expect(single).toContain("AuthService")
  })

  it("combines title + keywords + synopsis as one searchable surface", () => {
    const result = extractEntityCandidates(
      "Shipped feature",
      "PR #1234 OAUTH-12",
      "Closes #88 for AuthService."
    )
    expect(result).toContain("PR #1234")
    expect(result).toContain("OAUTH-12")
    expect(result).toContain("#88")
  })

  it("caps candidate count at 5 (Notion OR-branch ceiling)", () => {
    // Title with many distinct entity shapes; verify the global cap
    // applies. PR/issue/Jira fill first; the cap must hit before all
    // capitalized phrases sneak in.
    const result = extractEntityCandidates(
      "PR #1 PR #2 PR #3 SENTRY-1 SENTRY-2 SENTRY-3 SENTRY-4 SENTRY-5 SENTRY-6",
      "",
      ""
    )
    expect(result.length).toBeLessThanOrEqual(5)
  })

  it("orders high-precision patterns before capitalized-word matches", () => {
    // A title with both a PR and a capitalized phrase should land the
    // PR candidate FIRST. Cap-induced truncation drops the noisier
    // capitalized phrase if budget is tight.
    const result = extractEntityCandidates(
      "Merged PR #1234 for AuthService refactor",
      "",
      ""
    )
    const prIdx = result.indexOf("PR #1234")
    expect(prIdx).toBe(0)
  })

  it("dedupes identical literal matches across the combined input", () => {
    // Same `PR #1234` in title and keywords — only one candidate emitted.
    const result = extractEntityCandidates("Merged PR #1234", "PR #1234", "")
    const prCount = result.filter((c) => c === "PR #1234").length
    expect(prCount).toBe(1)
  })

  it("matches `PR#1234` (no space between PR and #) — \\s* lets zero whitespace through", () => {
    // Pinned per reviewer nit. The PR pattern is `\bPR\s*#\d+\b` so
    // both `PR #1234` and `PR#1234` match. `Entity contains "PR#1234"`
    // and `Entity contains "PR #1234"` are different server-side
    // probes — pin both shapes so a tightening of the regex (e.g.
    // requiring exactly one space) is caught loudly.
    const noSpace = extractEntityCandidates("Merged PR#1234 outage", "", "")
    expect(noSpace).toContain("PR#1234")

    const withSpace = extractEntityCandidates("Merged PR #1234 outage", "", "")
    expect(withSpace).toContain("PR #1234")
  })

  it("strips trailing punctuation from URL matches (concern #2)", () => {
    // `https?:\S+` is greedy on `\S` and pulls in trailing `,)/.;`.
    // Post-process strips them so `Entity contains "https://x.com/foo"`
    // matches a real URL entity even when the source memory wrote
    // `See https://x.com/foo, also` or `See https://x.com/foo).`.
    const comma = extractEntityCandidates(
      "See https://x.com/foo, also at github.com",
      "",
      ""
    )
    expect(comma).toContain("https://x.com/foo")
    expect(comma).not.toContain("https://x.com/foo,")

    const paren = extractEntityCandidates("See https://x.com/foo) details", "", "")
    expect(paren).toContain("https://x.com/foo")
    expect(paren).not.toContain("https://x.com/foo)")

    const period = extractEntityCandidates("See https://x.com/foo. End.", "", "")
    expect(period).toContain("https://x.com/foo")
    expect(period).not.toContain("https://x.com/foo.")

    const multi = extractEntityCandidates("Check https://x.com/foo!).", "", "")
    expect(multi).toContain("https://x.com/foo")
    expect(multi).not.toContain("https://x.com/foo!).")
  })

  it("rejects 1-word capitalized matches that are common verb leads (concern #1)", () => {
    // Stop-list of common save-title verbs / connectors. A bare
    // `Entity contains "Merged"` matches every Merged-flavored task
    // entity in the vault — overwhelming noise. The verb is the
    // noise; if there's a real entity in the title, another pattern
    // (PR / Jira / surviving capitalized phrase) catches it.
    const merged = extractEntityCandidates("Merged the OAuth migration", "", "")
    expect(merged).not.toContain("Merged")

    const found = extractEntityCandidates("Found a regression", "", "")
    expect(found).not.toContain("Found")
    expect(found).not.toContain("Found a")

    const fixed = extractEntityCandidates("Fixed memory leak", "", "")
    expect(fixed).not.toContain("Fixed")

    const reviewing = extractEntityCandidates("Reviewing changes", "", "")
    expect(reviewing).not.toContain("Reviewing")
  })

  it("rejects multi-word matches whose lead is a stop-list verb", () => {
    // "Merged PR" is a real 2-word capitalized match; the leading
    // verb makes it noise even though it's >=2 words. Stop-list
    // applies to phrase leads, not just single-word matches.
    const result = extractEntityCandidates("Merged PR review notes", "", "")
    expect(result).not.toContain("Merged PR")
    // Sanity: the underlying PR shape would still surface if a number
    // were attached (it's a different pattern, not gated).
  })

  it("rejects 1-word generic capitalized nouns that match too many task entities", () => {
    // `Bug`, `API`, `Mail`, `Issue` — these substring-match too many
    // unrelated task entities. The stoplist drops them.
    const bug = extractEntityCandidates("Triaging Bug report", "", "")
    expect(bug).not.toContain("Bug")

    const api = extractEntityCandidates("Refactor API surface", "", "")
    expect(api).not.toContain("API")

    const mail = extractEntityCandidates("Mail outage at 3pm", "", "")
    expect(mail).not.toContain("Mail")
  })

  it("rejects 1-word matches shorter than 4 chars (PR / IO / OK / etc.)", () => {
    // Bare `PR` (no number attached) is too generic — `Entity
    // contains "PR"` matches every PR-flavored task. The cap-at-3
    // rejects single-word noise without losing entity-shaped tokens
    // (CamelCase identifiers are typically much longer).
    const result = extractEntityCandidates("PR review at 3pm", "", "")
    expect(result).not.toContain("PR")
  })

  it("accepts CamelCase 1-word identifiers (mixed case beyond first letter)", () => {
    // The whole point of the relevance gate is to keep
    // identifier-shaped 1-word matches (`AuthService`, `OAuth`,
    // `WeChat`) while dropping plain-word noise (`Merged`, `Bug`).
    const auth = extractEntityCandidates("AuthService refactor", "", "")
    expect(auth).toContain("AuthService")

    const oauth = extractEntityCandidates("OAuth flow rewritten", "", "")
    expect(oauth).toContain("OAuth")

    const wechat = extractEntityCandidates("WeChat session cookie issue", "", "")
    expect(wechat).toContain("WeChat")
  })

  it("accepts 1-word matches with internal digits (PR1234, V2API)", () => {
    // Digit content alone is enough signal — these are
    // identifier-shaped tokens where another pattern (PR / Jira)
    // didn't fire.
    const pr1234 = extractEntityCandidates("Investigated PR1234 fanout", "", "")
    expect(pr1234).toContain("PR1234")
  })

  it("rejects plain capitalized brand-name 1-word tokens (Outlook, Notion)", () => {
    // Trade-off: we lose `Outlook` / `Notion` / `Slack` as 1-word
    // entity candidates, because `Entity contains "Outlook"` matches
    // every Outlook-related task in the vault. False negative is
    // safer than false positive here — these brands rarely appear
    // alone (usually paired with a service or PR number) and the
    // multi-word pattern catches `Outlook Mail App` / `Notion API`
    // when they do.
    const outlook = extractEntityCandidates("Outlook outage today", "", "")
    expect(outlook).not.toContain("Outlook")

    const notion = extractEntityCandidates("Notion API migration", "", "")
    // "Notion API" is multi-word — but "API" is in the stop-list.
    // "Notion" alone would only land if the multi-word match didn't
    // fire. Here `\bNotion API\b` is a 2-word match starting with a
    // non-stoplisted lead → accepted.
    expect(notion).toContain("Notion API")
    // Bare "Notion" would NOT have surfaced even without the
    // multi-word match — pinned for clarity.
    expect(notion).not.toContain("Notion")
  })

  it("rejects bare-imperative verb leads (Fix / Add / Build / Land / Wrote / Got / etc.)", () => {
    // Empirical concern from review delta: agent-written titles
    // frequently use bare imperatives ("Fix the X", "Add Y", "Land Z")
    // — the past-tense stoplist alone misses these. Pin the
    // imperatives so a future "consolidation" of the stoplist can't
    // drop them silently. The reviewer's adversarial fixtures land
    // verbatim:

    expect(extractEntityCandidates("Fix Outlook Mail bug", "", "")).toEqual([])
    expect(extractEntityCandidates("Add OAuth login", "", "")).toEqual(["OAuth"])
    expect(extractEntityCandidates("Land PR review", "", "")).toEqual([])
    expect(extractEntityCandidates("Build Cache Handler", "", "")).toEqual([])
    expect(extractEntityCandidates("Wrote AuthService refactor", "", "")).toEqual([
      "AuthService",
    ])
    expect(extractEntityCandidates("Got Mail Working", "", "")).toEqual([])
    expect(extractEntityCandidates("Ship feature today", "", "")).toEqual([])
    expect(extractEntityCandidates("Resolve memory leak", "", "")).toEqual([])
    expect(extractEntityCandidates("Refactor AuthService into modules", "", "")).toEqual([
      "AuthService",
    ])
    expect(extractEntityCandidates("Test new pipeline", "", "")).toEqual([])
    expect(extractEntityCandidates("Investigate latency spike", "", "")).toEqual([])
    expect(extractEntityCandidates("Implement OAuth flow", "", "")).toEqual(["OAuth"])
    expect(extractEntityCandidates("Migrate to Notion v5", "", "")).toEqual([])
    expect(extractEntityCandidates("Review changes", "", "")).toEqual([])
    expect(extractEntityCandidates("Decide between OAuth and SAML", "", "")).toEqual([
      "OAuth",
      "SAML",
    ])
  })

  it("rejects bare-scheme URL matches like `https://`", () => {
    // Regex requires `[a-zA-Z0-9]` immediately after `://` so a stub
    // like `Just https://.` (where the `.` is prose punctuation) no
    // longer produces `["https://"]`. `Entity contains "https://"`
    // would substring-hit every URL-bearing task entity in the vault.
    expect(extractEntityCandidates("Just https://.", "", "")).toEqual([])
    expect(extractEntityCandidates("Just https:// today", "", "")).toEqual([])
    expect(extractEntityCandidates("Just http://", "", "")).toEqual([])
    // Sanity: real URLs still match.
    expect(extractEntityCandidates("See https://x.com/foo today", "", "")).toContain(
      "https://x.com/foo"
    )
    expect(extractEntityCandidates("See https://a.b/c", "", "")).toContain(
      "https://a.b/c"
    )
  })

  it("counts per-pattern cap by iteration attempts, not by unique additions (intent pin)", () => {
    // Reviewer nit on line 343: pin the intent. The
    // PER_PATTERN_MATCH_CAP is meant to bound the pattern's scan
    // work, not the Set growth. So a pattern that hits 5 already-
    // present literals stops, even though the Set didn't grow. This
    // protects against a pathological-but-realistic input where the
    // same `PR #1234` repeats 50 times in keywords — without this
    // accounting, the loop would scan all 50 before yielding to
    // later patterns. Empirically: cap is 5 attempts; same literal
    // repeated 6 times still bails after 5.
    const repeated = "PR #1 PR #1 PR #1 PR #1 PR #1 PR #1 PR #1 PR #1"
    const result = extractEntityCandidates(repeated, "", "")
    // Only one unique candidate from the first PR pattern.
    expect(result.filter((c) => c === "PR #1").length).toBe(1)
    // The standalone-#N pattern still gets to run because the per-
    // pattern cap halts the PR pattern after 5 iterations, allowing
    // the remaining patterns to execute. `#1` lands.
    expect(result).toContain("#1")
  })
})

describe("findRelatedActiveTasks", () => {
  it("short-circuits when LORE_DISABLE_TASK_CROSSREF=1 (operator kill-switch)", async () => {
    const listSpy = vi.fn()
    vi.stubEnv("LORE_DISABLE_TASK_CROSSREF", "1")
    try {
      const result = await findRelatedActiveTasks(
        { tasks: { list: listSpy } },
        { memoryTitle: "Merged PR #1234", projectId: "proj-a" }
      )
      expect(result).toEqual([])
      expect(listSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("runs normally when LORE_DISABLE_TASK_CROSSREF is unset / not '1'", async () => {
    const listSpy = vi.fn().mockResolvedValue({ items: [] })
    vi.stubEnv("LORE_DISABLE_TASK_CROSSREF", "0")
    try {
      await findRelatedActiveTasks(
        { tasks: { list: listSpy } },
        { memoryTitle: "Merged PR #1234", projectId: "proj-a" }
      )
      expect(listSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("does NOT honor LORE_DISABLE_NEAR_DUPLICATE_PROBE (single-axis kill switches)", async () => {
    // The two probes have different failure modes and an operator may
    // want one but not the other. Pinning this guarantees a future
    // contributor can't "consolidate" the kill switches without a
    // matching design decision.
    const listSpy = vi.fn().mockResolvedValue({ items: [] })
    vi.stubEnv("LORE_DISABLE_NEAR_DUPLICATE_PROBE", "1")
    try {
      await findRelatedActiveTasks(
        { tasks: { list: listSpy } },
        { memoryTitle: "Merged PR #1234", projectId: "proj-a" }
      )
      expect(listSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("returns [] when no entity candidates can be extracted (no Notion call)", async () => {
    // Title / keywords / synopsis with no entity-shaped tokens — the
    // probe degrades to "no cross-reference" rather than firing a
    // tag-only probe that would over-broaden.
    const lister = makeTaskLister([])
    const result = await findRelatedActiveTasks(
      { tasks: lister },
      {
        memoryTitle: "lowercase ramble with no entity hooks",
        memoryKeywords: "",
        memorySynopsis: "",
        projectId: "proj-a",
      }
    )
    expect(result).toEqual([])
    expect(lister.listSpy).not.toHaveBeenCalled()
  })

  it("forwards the candidate set, project, ACTIVE_TASK_STATES, and limit=5 to the lister", async () => {
    const lister = makeTaskLister([])
    await findRelatedActiveTasks(
      { tasks: lister },
      {
        memoryTitle: "Merged PR #1234",
        projectId: "proj-a",
      }
    )
    expect(lister.listSpy).toHaveBeenCalledWith({
      projectId: "proj-a",
      entities: expect.arrayContaining(["PR #1234"]),
      states: ["open", "in-progress", "blocked"],
      limit: 5,
    })
  })

  it("uses title + keywords + synopsis as the entity-extraction surface", async () => {
    const lister = makeTaskLister([])
    await findRelatedActiveTasks(
      { tasks: lister },
      {
        memoryTitle: "Shipped feature",
        memoryKeywords: "PR #1234",
        memorySynopsis: "Closes SENTRY-1234.",
        projectId: "proj-a",
      }
    )
    const call = lister.listSpy.mock.calls[0][0] as { entities: string[] }
    expect(call.entities).toContain("PR #1234")
    expect(call.entities).toContain("SENTRY-1234")
  })

  it("works when synopsis is empty (the agent didn't supply one)", async () => {
    // Pre-#02 deploys are not a runtime concern (#11 hard-deps on #02),
    // but un-supplied synopsis values are: the field is optional on
    // `lore-memory action='save'`. Probe falls back to title + keywords.
    const lister = makeTaskLister([
      makeTaskSummary({ id: "task-1", title: "Track PR #1234" }),
    ])
    const result = await findRelatedActiveTasks(
      { tasks: lister },
      {
        memoryTitle: "Merged PR #1234: classifier",
        memoryKeywords: undefined,
        memorySynopsis: undefined,
        projectId: "proj-a",
      }
    )
    expect(result.map((t) => t.id)).toEqual(["task-1"])
  })

  it("allows undefined projectId — vault-wide cross-ref is well-defined", async () => {
    // Mirrors `findDuplicateActiveTasks`: the underlying TaskService.list
    // honors `projectOrUnscopedFilter` so unscoped probes are valid.
    // A vault-wide save (no resolved project) still benefits from the
    // cross-reference — projectless tasks exist.
    const lister = makeTaskLister([
      makeTaskSummary({ id: "task-1", title: "Track PR #1234" }),
    ])
    const result = await findRelatedActiveTasks(
      { tasks: lister },
      { memoryTitle: "Merged PR #1234" }
    )
    expect(result.map((t) => t.id)).toEqual(["task-1"])
    expect(lister.listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: undefined })
    )
  })

  it("swallows list() errors and returns [] (probe failures must not fail the save)", async () => {
    const listSpy = vi.fn().mockRejectedValue(new Error("notion 503"))
    const result = await findRelatedActiveTasks(
      { tasks: { list: listSpy } },
      { memoryTitle: "Merged PR #1234", projectId: "proj-a" }
    )
    expect(result).toEqual([])
  })

  it("invokes onError when the list query throws (operator observability)", async () => {
    const err = new Error("notion 503")
    const listSpy = vi.fn().mockRejectedValue(err)
    const onError = vi.fn()
    const result = await findRelatedActiveTasks(
      { tasks: { list: listSpy } },
      {
        memoryTitle: "Merged PR #1234",
        projectId: "proj-a",
        onError,
      }
    )
    expect(result).toEqual([])
    expect(onError).toHaveBeenCalledWith(err)
  })

  it("isolates synchronous tokenizer throws from the caller (failure-domain wrap)", async () => {
    // Outer try/catch covers BOTH the sync tokenizer and the async
    // list call. Force a sync throw by handing a malformed services
    // object whose property-access triggers a TypeError inside the
    // tokenizer pass — actually, the tokenizer is pure-string, so
    // simulate via an onError observer to confirm the wrap covers
    // any future regex-related throws (catastrophic backtracking,
    // etc.). This test pins the contract: if the helper threw,
    // `Promise.all` would reject and `handleSave` would surface a
    // save error. The wrap means we degrade to `[]`.
    const onError = vi.fn()
    // Hand a list that throws synchronously (no await) — simulates
    // a service implementation that fails to enter the async
    // boundary cleanly.
    const listSpy = vi.fn(() => {
      throw new Error("sync explosion before await")
    })
    const result = await findRelatedActiveTasks(
      { tasks: { list: listSpy as never } },
      {
        memoryTitle: "Merged PR #1234",
        projectId: "proj-a",
        onError,
      }
    )
    expect(result).toEqual([])
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
