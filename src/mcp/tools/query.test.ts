/**
 * lore-query polymorphic dispatcher tests.
 *
 * Pins the wiring between the dispatcher's discriminated union and the
 * downstream handlers — adding `includeContext` to the `ask` arm in
 * issue 0.6.0/18 was the motivating coverage gap. Behavioural tests for
 * `handleAsk` itself live in `knowledge.test.ts`; this file pins the
 * dispatcher's forwarding contract.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describe, expect, it, vi } from "vitest"
import { queryDispatchSchema, registerQueryTools } from "./query.js"
import { registerKnowledgeTools } from "./knowledge.js"

function createMockServer() {
  const handlers = new Map<string, (...args: never[]) => Promise<unknown>>()
  const server = {
    registerTool: vi.fn(
      (
        name: string,
        _config: unknown,
        handler: (...args: never[]) => Promise<unknown>
      ) => {
        handlers.set(name, handler)
      }
    ),
  } as unknown as McpServer
  return {
    server,
    getActionHandler(toolName: string, action: string) {
      const handler = handlers.get(toolName)
      if (!handler) throw new Error(`missing handler ${toolName}`)
      return (args: Record<string, unknown>) => handler({ ...args, action } as never)
    },
  }
}

function makeEntityService() {
  return {
    resolveOrCreateEntity: vi.fn(async () => ({
      entity: null,
      ambiguous: false,
      candidates: [],
      created: false,
    })),
  }
}

function makeAskServices(overrides: Record<string, unknown> = {}) {
  return {
    projects: { findByName: vi.fn().mockResolvedValue(null) },
    entities: makeEntityService(),
    facts: {
      queryByEntity: vi.fn().mockResolvedValue([]),
      queryByObject: vi.fn().mockResolvedValue([]),
    },
    decisions: { getById: vi.fn() },
    memories: { getTitleById: vi.fn().mockResolvedValue(null) },
    tasks: {
      list: vi.fn().mockResolvedValue({ items: [] }),
      queryOverdue: vi.fn().mockResolvedValue([]),
    },
    context: {
      project: {
        id: "proj-1",
        name: "Widget",
        path: "apps/widget",
        description: "Widget application.",
      },
      isCatchAllFallback: false,
    },
    config: {
      vault: { pageId: "v1" },
      projects: [{ name: "Widget", path: "apps/widget" }],
    },
    ...overrides,
  }
}

describe("lore-query polymorphic dispatcher — ask arm forwards includeContext", () => {
  it("renders the framing block when includeContext is omitted (default true)", async () => {
    const mockServer = createMockServer()
    const services = makeAskServices()
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const ask = mockServer.getActionHandler("lore-query", "ask")

    const result = await ask({ entity: "AuthService" })
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("Project: Widget (apps/widget)")
  })

  it("renders the framing block when includeContext: true is explicit", async () => {
    const mockServer = createMockServer()
    const services = makeAskServices()
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const ask = mockServer.getActionHandler("lore-query", "ask")

    const result = await ask({ entity: "AuthService", includeContext: true })
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("Project: Widget (apps/widget)")
  })

  it("suppresses the framing block when includeContext: false", async () => {
    const mockServer = createMockServer()
    const services = makeAskServices()
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const ask = mockServer.getActionHandler("lore-query", "ask")

    const result = await ask({ entity: "AuthService", includeContext: false })
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).not.toContain("Project: Widget")
    expect(text).not.toContain("Siblings:")
  })

  it("rejects non-boolean includeContext at the dispatcher schema layer", async () => {
    // Discriminated-union validation is what pins the type contract. A
    // future contributor switching `z.boolean()` to `z.string()` should
    // see this test fail.
    const mockServer = createMockServer()
    const services = makeAskServices()
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const ask = mockServer.getActionHandler("lore-query", "ask")

    const result = await ask({
      entity: "AuthService",
      includeContext: "yes",
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
  })

  it("does not render the framing block on non-ask actions even when project resolves", async () => {
    // Acceptance criterion (#18): `recall`, `search`, and `audit` do
    // NOT render the framing block. `includeContext` lives only on the
    // `ask` arm; other arms strip the field and never reach the framing
    // renderer. This pins the narrow scope so a future contributor
    // doesn't accidentally fan the block out across every read-path
    // action and inflate output tokens.
    const mockServer = createMockServer()
    const services = {
      ...makeAskServices(),
      memories: {
        list: vi.fn().mockResolvedValue({ items: [] }),
        search: vi.fn().mockResolvedValue([]),
        getTitleById: vi.fn().mockResolvedValue(null),
      },
      facts: {
        listTracking: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
        queryOverdue: vi.fn().mockResolvedValue([]),
      },
      decisions: {
        ...makeAskServices().decisions,
        queryOverdue: vi.fn().mockResolvedValue([]),
      },
    }
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)

    const cases = [
      { action: "recall", args: {} },
      { action: "search", args: { query: "auth" } },
      { action: "audit", args: {} },
    ] as const

    for (const { action, args } of cases) {
      const handler = mockServer.getActionHandler("lore-query", action)
      const result = await handler(args)
      const text = (result as { content: Array<{ text: string }> }).content[0].text
      expect(text, `action=${action} must not render framing block`).not.toContain(
        "Project: Widget"
      )
      expect(text, `action=${action} must not render Siblings line`).not.toContain(
        "Siblings:"
      )
    }
  })
})

describe("lore-query polymorphic dispatcher — includeSynopsis forwarding (issue 0.7.0/03)", () => {
  // The flag lives on the recall and search arms of the dispatch schema.
  // Pinning the wiring here protects against a future contributor
  // dropping the field from one arm and not the other, or accidentally
  // adding it to ask/audit (where it would be conceptually wrong — those
  // arms don't render memory rows).

  it("accepts includeSynopsis=false on the recall arm", async () => {
    const mockServer = createMockServer()
    const services = {
      ...makeAskServices(),
      topics: { findByName: vi.fn() },
      memories: {
        list: vi.fn().mockResolvedValue({ items: [] }),
        getTitleById: vi.fn(),
      },
    }
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

    const result = await recall({ includeSynopsis: false })
    expect((result as { isError?: boolean }).isError).not.toBe(true)
  })

  it("accepts includeSynopsis=false on the search arm", async () => {
    const mockServer = createMockServer()
    const services = {
      ...makeAskServices(),
      topics: { findByName: vi.fn() },
      memories: {
        search: vi.fn().mockResolvedValue([]),
        list: vi.fn(),
        getTitleById: vi.fn(),
      },
    }
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const search = mockServer.getActionHandler("lore-query", "search")

    const result = await search({ query: "anything", includeSynopsis: false })
    expect((result as { isError?: boolean }).isError).not.toBe(true)
  })

  it("rejects non-boolean includeSynopsis at the dispatcher schema layer", async () => {
    const mockServer = createMockServer()
    const services = {
      ...makeAskServices(),
      topics: { findByName: vi.fn() },
      memories: {
        list: vi.fn().mockResolvedValue({ items: [] }),
        getTitleById: vi.fn(),
      },
    }
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

    const result = await recall({ includeSynopsis: "yes" })
    expect((result as { isError?: boolean }).isError).toBe(true)
  })
})

describe("lore-query action='ask' — touch-on-read wiring (issue 0.8.0/05)", () => {
  // The ask handler surfaces decisions via `decided_by` facts (each
  // resolves to a canonical decision page that is itself a memory) and
  // source memories backing every fact (`fact.sourceMemoryId`). Both
  // are cites; the wiring collects their IDs, refreshes them via
  // `getManyById`, and passes them through `touchOnRead` so the next
  // RRF pass over the same row benefits from the bumped `Confidence
  // Score`.
  function makeFact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "fact-1",
      subject: "AuthService",
      predicate: "uses",
      object: "OAuth",
      projectIds: [],
      validFrom: null,
      validUntil: null,
      reviewBy: null,
      sourceMemoryId: null,
      confidence: "certain",
      subjectEntityId: null,
      objectEntityId: null,
      ...overrides,
    }
  }

  it("invokes getManyById + touchOnRead with every fact's sourceMemoryId", async () => {
    const mockServer = createMockServer()
    const facts = [
      makeFact({ id: "fact-1", sourceMemoryId: "mem-source-1" }),
      makeFact({ id: "fact-2", predicate: "depends_on", sourceMemoryId: "mem-source-2" }),
      makeFact({ id: "fact-3", predicate: "uses", sourceMemoryId: null }),
    ]
    const getManyById = vi
      .fn()
      .mockResolvedValue([{ id: "mem-source-1" }, { id: "mem-source-2" }])
    const touchOnRead = vi.fn().mockResolvedValue(undefined)
    const services = {
      ...makeAskServices(),
      facts: {
        queryByEntity: vi.fn().mockResolvedValue(facts),
        queryByObject: vi.fn().mockResolvedValue([]),
      },
      memories: {
        getTitleById: vi.fn().mockResolvedValue(null),
        getManyById,
        touchOnRead,
      },
    }
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const ask = mockServer.getActionHandler("lore-query", "ask")

    await ask({ entity: "AuthService" })

    expect(getManyById).toHaveBeenCalledTimes(1)
    const ids = getManyById.mock.calls[0]![0] as string[]
    // null sourceMemoryIds are filtered out before getManyById fires.
    expect(ids).toEqual(["mem-source-1", "mem-source-2"])
    expect(touchOnRead).toHaveBeenCalledTimes(1)
  })

  it("dedupes IDs across decisionLinks and fact sourceMemoryIds (decisions are memories)", async () => {
    // A `decided_by` fact's source memory IS the decision it resolves
    // to — so when the same id appears in both channels the wiring's
    // collector must dedupe rather than touch twice.
    const mockServer = createMockServer()
    const facts = [
      makeFact({
        id: "fact-1",
        predicate: "decided_by",
        object: "decision-1",
        sourceMemoryId: "decision-1",
      }),
      makeFact({ id: "fact-2", sourceMemoryId: "mem-source-2" }),
    ]
    const getManyById = vi.fn().mockResolvedValue([])
    const touchOnRead = vi.fn().mockResolvedValue(undefined)
    const decisionGetById = vi.fn().mockResolvedValue({
      id: "decision-1",
      title: "Decision 1",
      kind: "decision",
      status: "accepted",
      confidence: "certain",
      decidedAt: "2026-04-01",
      reviewBy: null,
      supersedesIds: [],
    })
    const services = {
      ...makeAskServices(),
      facts: {
        queryByEntity: vi.fn().mockResolvedValue(facts),
        queryByObject: vi.fn().mockResolvedValue([]),
      },
      decisions: { getById: decisionGetById },
      memories: {
        getTitleById: vi.fn().mockResolvedValue(null),
        getManyById,
        touchOnRead,
      },
    }
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const ask = mockServer.getActionHandler("lore-query", "ask")

    await ask({ entity: "AuthService" })

    expect(getManyById).toHaveBeenCalledTimes(1)
    const ids = getManyById.mock.calls[0]![0] as string[]
    expect(ids).toContain("decision-1")
    expect(ids).toContain("mem-source-2")
    // No duplicates: decision-1 surfaces once even though it appears
    // both as the decided_by target and as the fact's sourceMemoryId.
    const occurrences = ids.filter((id) => id === "decision-1").length
    expect(occurrences).toBe(1)
  })

  it("skips getManyById and touchOnRead when no source IDs are surfaced", async () => {
    const mockServer = createMockServer()
    const getManyById = vi.fn().mockResolvedValue([])
    const touchOnRead = vi.fn().mockResolvedValue(undefined)
    const services = {
      ...makeAskServices(),
      facts: {
        queryByEntity: vi
          .fn()
          .mockResolvedValue([makeFact({ id: "fact-1", sourceMemoryId: null })]),
        queryByObject: vi.fn().mockResolvedValue([]),
      },
      memories: {
        getTitleById: vi.fn().mockResolvedValue(null),
        getManyById,
        touchOnRead,
      },
    }
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const ask = mockServer.getActionHandler("lore-query", "ask")

    await ask({ entity: "AuthService" })

    expect(getManyById).not.toHaveBeenCalled()
    expect(touchOnRead).not.toHaveBeenCalled()
  })

  it("touches only the visible-slice source memories, not bucket-cap-hidden ones", async () => {
    // Spec acceptance criterion (issue 0.8.0/05): every memory
    // surfaced **as a source for a resolved entity** is touched. Rows
    // past the per-bucket cap render as `(N hidden)` and the agent
    // never sees their source memories — touching them anyway would
    // inflate `Confidence Score` against rows that were never cited,
    // and #08's RRF reads that score for ranking. The collector
    // walks the post-cap visible slice; this test pins the boundary.
    //
    // Default cap is 5 (DEFAULT_ASK_BUCKET_CAP). Build 8 structure
    // facts with distinct sourceMemoryIds so the Structure bucket
    // overflows by 3. Sort key is `validFrom`, descending — newer
    // dates land in the visible slice.
    const mockServer = createMockServer()
    const facts = Array.from({ length: 8 }, (_, i) => ({
      id: `fact-${i}`,
      subject: "AuthService",
      predicate: "uses",
      object: `Dep${i}`,
      projectIds: [],
      validFrom: `2026-04-${String(10 + i).padStart(2, "0")}`,
      validUntil: null,
      reviewBy: null,
      sourceMemoryId: `mem-source-${i}`,
      confidence: "certain",
      subjectEntityId: null,
      objectEntityId: null,
    }))
    const getManyById = vi.fn(async (ids: string[]) => ids.map((id) => ({ id })))
    const touchOnRead = vi.fn().mockResolvedValue(undefined)
    const services = {
      ...makeAskServices(),
      facts: {
        queryByEntity: vi.fn().mockResolvedValue(facts),
        queryByObject: vi.fn().mockResolvedValue([]),
      },
      memories: {
        getTitleById: vi.fn().mockResolvedValue(null),
        getManyById,
        touchOnRead,
      },
    }
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const ask = mockServer.getActionHandler("lore-query", "ask")

    const result = await ask({ entity: "AuthService" })
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    // Sanity: the cap fired and the response surfaces 3 hidden rows.
    expect(text).toContain("(3 hidden)")

    // The collector walks only the visible 5 — hidden rows' source
    // memories must be absent from the touch batch.
    expect(getManyById).toHaveBeenCalledTimes(1)
    const ids = getManyById.mock.calls[0]![0] as string[]
    expect(ids).toHaveLength(5)
    // Newest-first ordering means fact-7 (validFrom 2026-04-17) is
    // the newest and survives the cap; fact-0 (2026-04-10) is the
    // oldest and falls into the hidden bucket.
    expect(ids).toContain("mem-source-7")
    expect(ids).not.toContain("mem-source-0")
  })

  it("does not surface a touchOnRead failure as a tool error (advisory contract)", async () => {
    const mockServer = createMockServer()
    const services = {
      ...makeAskServices(),
      facts: {
        queryByEntity: vi
          .fn()
          .mockResolvedValue([makeFact({ id: "f1", sourceMemoryId: "mem-1" })]),
        queryByObject: vi.fn().mockResolvedValue([]),
      },
      memories: {
        getTitleById: vi.fn().mockResolvedValue(null),
        getManyById: vi.fn().mockResolvedValue([{ id: "mem-1" }]),
        touchOnRead: vi.fn().mockRejectedValue(new Error("notion 429")),
      },
    }
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const ask = mockServer.getActionHandler("lore-query", "ask")

    const result = await ask({ entity: "AuthService" })
    expect((result as { isError?: boolean }).isError).not.toBe(true)
  })
})

describe("lore-query KINDS enum accepts every memory kind", () => {
  // The recall/search KINDS enum must accept every kind the write
  // path produces. Without `procedure` in the enum, agents cannot
  // filter retrieval by that kind through the read-path tool — the
  // surface procedures are supposed to feed.

  it("recall accepts kind: 'procedure' at the dispatch boundary", () => {
    const result = queryDispatchSchema.safeParse({
      action: "recall",
      kind: "procedure",
      limit: 5,
    })
    expect(result.success).toBe(true)
  })

  it("search accepts kind: 'procedure' at the dispatch boundary", () => {
    const result = queryDispatchSchema.safeParse({
      action: "search",
      query: "PR-1234",
      kind: "procedure",
    })
    expect(result.success).toBe(true)
  })

  it("recall/search accept kind: 'state' at the dispatch boundary", () => {
    expect(
      queryDispatchSchema.safeParse({
        action: "recall",
        kind: "state",
        limit: 5,
      }).success
    ).toBe(true)
    expect(
      queryDispatchSchema.safeParse({
        action: "search",
        query: "auth",
        kind: "state",
      }).success
    ).toBe(true)
  })

  it("recall/search accept kind: 'operational' at the dispatch boundary", () => {
    expect(
      queryDispatchSchema.safeParse({
        action: "recall",
        kind: "operational",
        limit: 5,
      }).success
    ).toBe(true)
    expect(
      queryDispatchSchema.safeParse({
        action: "search",
        query: "receipt",
        kind: "operational",
      }).success
    ).toBe(true)
  })
})

describe("lore-query READABLE_SOURCES enum accepts autosave learning rows", () => {
  it("recall accepts source: 'autosave_learning' at the dispatch boundary", () => {
    const result = queryDispatchSchema.safeParse({
      action: "recall",
      source: "autosave_learning",
      limit: 5,
    })
    expect(result.success).toBe(true)
  })

  it("search accepts source: 'autosave_learning' at the dispatch boundary", () => {
    const result = queryDispatchSchema.safeParse({
      action: "search",
      query: "atomic learning",
      source: "autosave_learning",
    })
    expect(result.success).toBe(true)
  })
})
