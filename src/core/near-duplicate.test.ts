import { describe, expect, it, vi } from "vitest"
import { findNearDuplicates, type MemoryLister } from "./near-duplicate.js"
import type { Memory } from "../types.js"

function makeMemory(overrides: Partial<Memory> & { id: string; title: string }): Memory {
  return {
    projectIds: ["proj-a"],
    topicId: null,
    source: "manual",
    kind: "note",
    status: "informational",
    confidence: "certain",
    reviewBy: null,
    decidedAt: null,
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
    content: "",
    taskState: null,
    blockedBy: "",
    entity: "",
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  }
}

function makeLister(items: Memory[]): MemoryLister & { listSpy: ReturnType<typeof vi.fn> } {
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
        },
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
        },
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
      expect.objectContaining({ tags: ["architecture", "core"] }),
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
      expect.objectContaining({ tags: undefined }),
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
      expect.objectContaining({ includeContent: false }),
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
      },
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
      },
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
      expect.objectContaining({ topicId: "topic-z", kind: "decision" }),
    )
  })
})
