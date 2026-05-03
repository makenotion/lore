import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describe, expect, it, vi } from "vitest"
import { registerDecisionTools } from "./decisions.js"
import { RICH_TEXT_PROPERTY_MAX_LEN } from "./rich-text-schema.js"
import type { Decision, Fact } from "../../types.js"

function makeDecision(id: string, overrides: Partial<Decision> = {}): Decision {
  return {
    id,
    title: `Decision ${id}`,
    projectIds: [],
    topicId: null,
    source: "manual",
    kind: "decision",
    status: "accepted",
    confidence: "certain",
    confidenceScore: null,
    reviewBy: null,
    doneAt: null,
    decidedAt: "2026-04-20",
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

function makeFact(id: string): Fact {
  return {
    id,
    subject: "Entity",
    predicate: "decided_by",
    object: "decision-id",
    projectIds: [],
    validFrom: "2026-04-20",
    validUntil: null,
    reviewBy: null,
    sourceMemoryId: "decision-id",
    confidence: "certain",
    createdAt: "2026-04-20T00:00:00.000Z",
    subjectEntityId: null,
    objectEntityId: null,
  }
}

function makeEntityService() {
  return {
    resolveOrCreateEntity: vi.fn().mockResolvedValue({
      entity: null,
      ambiguous: false,
      candidates: [],
      created: false,
    }),
  }
}

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
    getHandler(name: string) {
      const handler = handlers.get(name)
      if (!handler) throw new Error(`missing handler ${name}`)
      return handler
    },
    /**
     * Wrap a polymorphic dispatcher in a one-action shim so individual
     * tests can call it with action-specific args alone. The dispatcher's
     * discriminated union still validates the per-action schema.
     */
    getActionHandler(toolName: string, action: string) {
      const handler = handlers.get(toolName)
      if (!handler) throw new Error(`missing handler ${toolName}`)
      return (args: Record<string, unknown>) => handler({ ...args, action } as never)
    },
  }
}

describe("registerDecisionTools", () => {
  it("rejects an unresolved explicit projectName before creating a decision", async () => {
    const mockServer = createMockServer()
    const services = {
      decisions: {
        create: vi.fn(),
      },
      facts: {
        create: vi.fn(),
        queryBySourceMemory: vi.fn().mockResolvedValue([]),
      },
      topics: {
        getOrCreate: vi.fn(),
      },
      projects: {
        findByName: vi.fn().mockResolvedValue(null),
      },
      context: {
        project: { id: "proj-ambient", name: "Ambient" },
        isCatchAllFallback: false,
      },
      sessionMemories: {
        record: vi.fn(),
        get: vi.fn(),
      },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerDecisionTools(mockServer.server, services as never)
    const create = mockServer.getActionHandler("lore-decision", "create")

    const result = await create({
      decision: "New decision",
      rationale: "Because reasons",
      projectName: "Missing",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(text).toContain('Project "Missing" could not be resolved')
    expect(text).toContain("Fix the project scope")
    expect(services.topics.getOrCreate).not.toHaveBeenCalled()
    expect(services.decisions.create).not.toHaveBeenCalled()
    expect(services.facts.create).not.toHaveBeenCalled()
  })

  it("rejects mixed projectNames atomically before creating a decision", async () => {
    const mockServer = createMockServer()
    const findByName = vi.fn(async (name: string) =>
      name === "Mail" ? { id: "proj-mail", name: "Mail" } : null
    )
    const services = {
      decisions: {
        create: vi.fn(),
      },
      facts: {
        create: vi.fn(),
        queryBySourceMemory: vi.fn().mockResolvedValue([]),
      },
      topics: {
        getOrCreate: vi.fn(),
      },
      projects: {
        findByName,
      },
      context: {
        project: { id: "proj-ambient", name: "Ambient" },
        isCatchAllFallback: false,
      },
      sessionMemories: {
        record: vi.fn(),
        get: vi.fn(),
      },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerDecisionTools(mockServer.server, services as never)
    const create = mockServer.getActionHandler("lore-decision", "create")

    const result = await create({
      decision: "New decision",
      rationale: "Because reasons",
      projectNames: ["Mail", "Missing"],
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(text).toContain('Project "Missing" could not be resolved')
    expect(findByName).toHaveBeenCalledWith("Mail")
    expect(findByName).toHaveBeenCalledWith("Missing")
    expect(services.topics.getOrCreate).not.toHaveBeenCalled()
    expect(services.decisions.create).not.toHaveBeenCalled()
    expect(services.facts.create).not.toHaveBeenCalled()
  })

  it("stores internal decision facts using stable decision IDs", async () => {
    const mockServer = createMockServer()
    const newDecision = makeDecision("new-id", { title: "New decision" })
    const oldDecision = makeDecision("old-id", {
      title: "Old decision",
      status: "superseded",
    })

    const services = {
      decisions: {
        create: vi.fn().mockResolvedValue(newDecision),
        getById: vi.fn().mockImplementation(async (id: string) => {
          if (id === "old-id") return oldDecision
          if (id === "new-id") return newDecision
          throw new Error(`unknown decision ${id}`)
        }),
        supersede: vi.fn().mockResolvedValue(undefined),
      },
      facts: {
        create: vi.fn().mockResolvedValue(makeFact("fact-id")),
        queryBySourceMemory: vi.fn().mockResolvedValue([]),
        invalidate: vi.fn().mockResolvedValue(undefined),
      },
      memories: {
        decrementConfidence: vi.fn().mockResolvedValue(0.45),
      },
      topics: {
        getOrCreate: vi.fn(),
      },
      projects: {
        findByName: vi.fn(),
      },
      context: {
        project: null,
      },
      sessionMemories: {
        record: vi.fn(),
        get: vi.fn(),
      },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerDecisionTools(mockServer.server, services as never)
    const loreDecide = mockServer.getActionHandler("lore-decision", "create")

    await loreDecide({
      decision: "New decision",
      rationale: "Because reasons",
      affects: ["AuthService"],
      supersedesIds: ["old-id"],
    } as never)

    const factWrites = (services.facts.create as ReturnType<typeof vi.fn>).mock.calls.map(
      ([input]) => input
    )

    expect(factWrites).toContainEqual(
      expect.objectContaining({
        subject: "AuthService",
        predicate: "decided_by",
        object: "new-id",
        sourceMemoryId: "new-id",
      })
    )
    expect(factWrites).toContainEqual(
      expect.objectContaining({
        subject: "new-id",
        predicate: "supersedes_decision",
        object: "old-id",
        sourceMemoryId: "new-id",
      })
    )
  })

  it("surfaces saved decision recovery context when decided_by fact creation fails", async () => {
    const mockServer = createMockServer()
    const created = makeDecision("dec-partial", { title: "Adopt cache" })
    const factError = new Error("notion 503")
    const factCreate = vi
      .fn()
      .mockResolvedValueOnce(makeFact("fact-auth"))
      .mockRejectedValueOnce(factError)

    const services = {
      decisions: {
        create: vi.fn().mockResolvedValue(created),
        getById: vi.fn(),
        supersede: vi.fn(),
      },
      facts: {
        create: factCreate,
        queryBySourceMemory: vi.fn().mockResolvedValue([]),
        invalidate: vi.fn().mockResolvedValue(undefined),
      },
      memories: {
        decrementConfidence: vi.fn(),
      },
      topics: {
        getOrCreate: vi.fn(),
      },
      projects: {
        findByName: vi.fn(),
      },
      context: {
        project: null,
      },
      sessionMemories: {
        record: vi.fn(),
        get: vi.fn(),
      },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerDecisionTools(mockServer.server, services as never)
    const loreDecide = mockServer.getActionHandler("lore-decision", "create")

    const result = await loreDecide({
      decision: "Adopt cache",
      rationale: "Because reasons",
      affects: ["AuthService", "CacheLayer", "Queue"],
      supersedesIds: ["dec-old"],
    } as never)

    const wrapped = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(wrapped.isError).toBe(true)
    expect(wrapped.content[0].text).toContain("Decision create partial failure")
    expect(wrapped.content[0].text).toContain(
      'decision "Adopt cache" (dec-partial) was saved'
    )
    expect(wrapped.content[0].text).toContain(
      '`decided_by` fact for "CacheLayer" failed: notion 503'
    )
    expect(wrapped.content[0].text).toContain(
      "Created `decided_by` facts before failure: AuthService"
    )
    expect(wrapped.content[0].text).toContain(
      "Missing `decided_by` facts: CacheLayer, Queue"
    )
    expect(wrapped.content[0].text).toContain(
      "Pending supersessions not attempted: dec-old"
    )
    expect(wrapped.content[0].text).toContain("do not recreate the decision")
    expect(services.decisions.create).toHaveBeenCalledTimes(1)
    expect(factCreate).toHaveBeenCalledTimes(2)
    expect(services.decisions.getById).not.toHaveBeenCalled()
    expect(services.decisions.supersede).not.toHaveBeenCalled()
    expect(services.sessionMemories.record).toHaveBeenCalledWith(
      { agent: undefined, session: undefined },
      { memoryId: "dec-partial", projectIds: [] }
    )
  })

  it("surfaces saved decision recovery context when supersedes fact creation fails", async () => {
    const mockServer = createMockServer()
    const created = makeDecision("dec-new", { title: "Adopt cache" })
    const oldA = makeDecision("dec-a")
    const oldB = makeDecision("dec-b")
    const factError = new Error("notion 503")
    const factCreate = vi
      .fn()
      .mockResolvedValueOnce(makeFact("fact-a"))
      .mockRejectedValueOnce(factError)

    const services = {
      decisions: {
        create: vi.fn().mockResolvedValue(created),
        getById: vi.fn().mockImplementation(async (id: string) => {
          if (id === "dec-a") return oldA
          if (id === "dec-b") return oldB
          throw new Error(`unknown decision ${id}`)
        }),
        supersede: vi.fn().mockResolvedValue(undefined),
      },
      facts: {
        create: factCreate,
        queryBySourceMemory: vi.fn().mockResolvedValue([]),
        invalidate: vi.fn().mockResolvedValue(undefined),
      },
      memories: {
        decrementConfidence: vi.fn(),
      },
      topics: {
        getOrCreate: vi.fn(),
      },
      projects: {
        findByName: vi.fn(),
      },
      context: {
        project: null,
      },
      sessionMemories: {
        record: vi.fn(),
        get: vi.fn(),
      },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerDecisionTools(mockServer.server, services as never)
    const loreDecide = mockServer.getActionHandler("lore-decision", "create")

    const result = await loreDecide({
      decision: "Adopt cache",
      rationale: "Because reasons",
      supersedesIds: ["dec-a", "dec-b", "dec-c"],
    } as never)

    const wrapped = result as { content: Array<{ text: string }>; isError?: boolean }
    const text = wrapped.content[0].text

    expect(wrapped.isError).toBe(true)
    expect(text).toContain("Decision create partial failure")
    expect(text).toContain('decision "Adopt cache" (dec-new) was saved')
    expect(text).toContain(
      'supersession for "Decision dec-b" (dec-b) failed during `supersedes_decision` fact write: notion 503'
    )
    expect(text).toContain(
      'Completed supersessions before failure: "Decision dec-a" (dec-a)'
    )
    expect(text).toContain(
      'Marked superseded before failure but still missing graph repair: "Decision dec-b" (dec-b)'
    )
    expect(text).toContain(
      'Created `supersedes_decision` facts before failure: "Decision dec-a" (dec-a)'
    )
    expect(text).toContain(
      'Missing `supersedes_decision` facts: "Decision dec-b" (dec-b), dec-c'
    )
    expect(text).toContain(
      'Missing decision-context reachability updates: "Decision dec-b" (dec-b), dec-c'
    )
    expect(text).toContain("Pending supersessions not attempted: dec-c")
    expect(text).toContain("do not recreate the decision")
    expect(services.decisions.create).toHaveBeenCalledTimes(1)
    expect(services.decisions.supersede).toHaveBeenCalledTimes(2)
    expect(services.decisions.supersede).toHaveBeenNthCalledWith(1, "dec-new", "dec-a")
    expect(services.decisions.supersede).toHaveBeenNthCalledWith(2, "dec-new", "dec-b")
    expect(factCreate).toHaveBeenCalledTimes(2)
    expect(services.memories.decrementConfidence).not.toHaveBeenCalled()
  })

  it("keeps landed supersedes facts out of the missing list when reachability sync fails", async () => {
    const mockServer = createMockServer()
    const created = makeDecision("dec-new", { title: "Adopt cache" })
    const oldA = makeDecision("dec-a")
    const oldB = makeDecision("dec-b")
    const queryBySourceMemory = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("reachability 503"))
      .mockResolvedValue([])

    const services = {
      decisions: {
        create: vi.fn().mockResolvedValue(created),
        getById: vi.fn().mockImplementation(async (id: string) => {
          if (id === "dec-a") return oldA
          if (id === "dec-b") return oldB
          throw new Error(`unknown decision ${id}`)
        }),
        supersede: vi.fn().mockResolvedValue(undefined),
      },
      facts: {
        create: vi.fn().mockResolvedValue(makeFact("fact-id")),
        queryBySourceMemory,
        invalidate: vi.fn().mockResolvedValue(undefined),
      },
      memories: {
        decrementConfidence: vi.fn(),
      },
      topics: {
        getOrCreate: vi.fn(),
      },
      projects: {
        findByName: vi.fn(),
      },
      context: {
        project: null,
      },
      sessionMemories: {
        record: vi.fn(),
        get: vi.fn(),
      },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerDecisionTools(mockServer.server, services as never)
    const loreDecide = mockServer.getActionHandler("lore-decision", "create")

    const result = await loreDecide({
      decision: "Adopt cache",
      rationale: "Because reasons",
      supersedesIds: ["dec-a", "dec-b", "dec-c"],
    } as never)

    const wrapped = result as { content: Array<{ text: string }>; isError?: boolean }
    const text = wrapped.content[0].text

    expect(wrapped.isError).toBe(true)
    expect(text).toContain(
      'supersession for "Decision dec-b" (dec-b) failed during decision-context reachability sync: reachability 503'
    )
    expect(text).toContain(
      'Created `supersedes_decision` facts before failure: "Decision dec-a" (dec-a), "Decision dec-b" (dec-b)'
    )
    expect(text).toContain("Missing `supersedes_decision` facts: dec-c")
    expect(text).toContain(
      'Missing decision-context reachability updates: "Decision dec-b" (dec-b), dec-c'
    )
    expect(text).toContain("Pending supersessions not attempted: dec-c")
    expect(text).toContain("do not recreate the decision")
    expect(services.facts.create).toHaveBeenCalledTimes(2)
    expect(queryBySourceMemory).toHaveBeenCalledTimes(4)
    expect(services.memories.decrementConfidence).not.toHaveBeenCalled()
  })

  it("surfaces near-duplicate decisions with a lore-supersede hint", async () => {
    // P2-03 acceptance: a decision near-identical to an existing active
    // decision (trigram ≥ 0.6, same project, same topic) lights up a
    // structured supersession suggestion in the response.
    const mockServer = createMockServer()
    const newDecision = makeDecision("dec-new", {
      title: "Replace auth middleware",
      projectIds: ["proj-a"],
      topicId: "topic-1",
    })
    const existing = makeDecision("dec-old", {
      title: "Replace auth middleware",
      projectIds: ["proj-a"],
      topicId: "topic-1",
      status: "accepted",
      decidedAt: "2026-02-15",
    })

    const list = vi.fn().mockResolvedValue({ items: [existing] })
    const services = {
      decisions: {
        create: vi.fn().mockResolvedValue(newDecision),
        getById: vi.fn(),
        supersede: vi.fn(),
      },
      memories: { list },
      facts: {
        create: vi.fn().mockResolvedValue(makeFact("fact-id")),
        queryBySourceMemory: vi.fn().mockResolvedValue([]),
        invalidate: vi.fn(),
      },
      topics: { getOrCreate: vi.fn() },
      projects: { findByName: vi.fn() },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerDecisionTools(mockServer.server, services as never)
    const loreDecide = mockServer.getActionHandler("lore-decision", "create")

    const result = await loreDecide({
      decision: "Replace auth middleware",
      rationale: "Because reasons",
    } as never)

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain('Saved decision: "Replace auth middleware"')
    expect(text).toContain("Warning:")
    expect(text).toContain("dec-old")
    // Post-P3-01 the supersede call site is rendered via the polymorphic
    // tool (`lore-decision({ action: 'supersede', ... })`).
    expect(text).toContain("lore-decision")
    expect(text).toContain('action: "supersede"')
    expect(text).toContain('newDecisionId: "dec-new"')
    expect(text).toContain('oldDecisionId: "dec-old"')

    // The probe scoped to project + topic + Kind=decision.
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-a",
        topicId: undefined,
        kind: "decision",
        includeContent: false,
      })
    )
  })

  it("filters out superseded / deprecated / rejected decisions (active statuses only)", async () => {
    const mockServer = createMockServer()
    const newDecision = makeDecision("dec-new", {
      title: "Replace auth middleware",
      projectIds: ["proj-a"],
    })
    const list = vi.fn().mockResolvedValue({
      items: [
        makeDecision("dec-superseded", {
          title: "Replace auth middleware",
          status: "superseded",
        }),
        makeDecision("dec-rejected", {
          title: "Replace auth middleware",
          status: "rejected",
        }),
      ],
    })
    const services = {
      decisions: {
        create: vi.fn().mockResolvedValue(newDecision),
        getById: vi.fn(),
        supersede: vi.fn(),
      },
      memories: { list },
      facts: {
        create: vi.fn().mockResolvedValue(makeFact("fact-id")),
        queryBySourceMemory: vi.fn().mockResolvedValue([]),
        invalidate: vi.fn(),
      },
      topics: { getOrCreate: vi.fn() },
      projects: { findByName: vi.fn() },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerDecisionTools(mockServer.server, services as never)
    const loreDecide = mockServer.getActionHandler("lore-decision", "create")

    const result = await loreDecide({
      decision: "Replace auth middleware",
      rationale: "Because reasons",
    } as never)

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).not.toContain("Warning:")
    expect(text).not.toContain("dec-superseded")
    expect(text).not.toContain("dec-rejected")
  })

  it("scopes the probe to the resolved topicId when topicName is provided", async () => {
    // The P2-03 decision rule is "same-project AND same-topic". This test
    // pins the topic actually makes it through the topics.getOrCreate
    // round-trip and into the probe's list() call — a gap the earlier
    // shape-only test missed.
    const mockServer = createMockServer()
    const newDecision = makeDecision("dec-new", {
      title: "Replace auth middleware",
      projectIds: ["proj-a"],
      topicId: "topic-1",
    })
    const getOrCreate = vi.fn().mockResolvedValue({
      id: "topic-1",
      name: "Auth",
      projectIds: ["proj-a"],
      description: "",
    })
    const list = vi.fn().mockResolvedValue({ items: [] })
    const services = {
      decisions: {
        create: vi.fn().mockResolvedValue(newDecision),
        getById: vi.fn(),
        supersede: vi.fn(),
      },
      memories: { list },
      facts: {
        create: vi.fn().mockResolvedValue(makeFact("fact-id")),
        queryBySourceMemory: vi.fn().mockResolvedValue([]),
        invalidate: vi.fn(),
      },
      topics: { getOrCreate },
      projects: { findByName: vi.fn() },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerDecisionTools(mockServer.server, services as never)
    const loreDecide = mockServer.getActionHandler("lore-decision", "create")

    await loreDecide({
      decision: "Replace auth middleware",
      rationale: "Because reasons",
      topicName: "Auth",
    } as never)

    // The third arg is the `opts` bag for the issue #109 probe controls
    // — `forceNew: undefined` here because `forceNewTopic` was not set.
    expect(getOrCreate).toHaveBeenCalledWith("Auth", ["proj-a"], {
      forceNew: undefined,
    })
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-a",
        topicId: "topic-1",
        kind: "decision",
      })
    )
  })

  it("does not re-warn about decisions the caller already explicitly supersedes", async () => {
    // If the caller passes `supersedesIds: [oldId]`, the old decision is
    // expected to match. The probe drops it from the warning to keep the
    // surface focused on "did you mean to supersede this *other* one too?"
    const mockServer = createMockServer()
    const newDecision = makeDecision("dec-new", {
      title: "Replace auth middleware",
      projectIds: ["proj-a"],
    })
    const knownOld = makeDecision("dec-known-old", {
      title: "Replace auth middleware",
      status: "accepted",
    })

    const list = vi.fn().mockResolvedValue({ items: [knownOld] })
    const services = {
      decisions: {
        create: vi.fn().mockResolvedValue(newDecision),
        getById: vi.fn().mockResolvedValue(knownOld),
        supersede: vi.fn(),
      },
      memories: {
        list,
        decrementConfidence: vi.fn().mockResolvedValue(0.45),
      },
      facts: {
        create: vi.fn().mockResolvedValue(makeFact("fact-id")),
        queryBySourceMemory: vi.fn().mockResolvedValue([]),
        invalidate: vi.fn(),
      },
      topics: { getOrCreate: vi.fn() },
      projects: { findByName: vi.fn() },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerDecisionTools(mockServer.server, services as never)
    const loreDecide = mockServer.getActionHandler("lore-decision", "create")

    const result = await loreDecide({
      decision: "Replace auth middleware",
      rationale: "Because reasons",
      supersedesIds: ["dec-known-old"],
    } as never)

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    // Existing supersession flow still runs.
    expect(text).toContain("Superseded:")
    // But no redundant near-dup warning for the known row.
    expect(text).not.toContain("Warning:")
  })

  it("records the new decision with project scope into sessionMemories", async () => {
    // P1-09 integration point: a `lore-learn` call made later in the same
    // (agent, session) must be able to evaluate project-overlap safety
    // against the decision's scope.
    const mockServer = createMockServer()
    const newDecision = makeDecision("dec-new", {
      title: "New",
      projectIds: ["proj-a", "proj-b"],
    })
    const record = vi.fn()

    const services = {
      decisions: {
        create: vi.fn().mockResolvedValue(newDecision),
        getById: vi.fn(),
        supersede: vi.fn(),
      },
      facts: {
        create: vi.fn().mockResolvedValue(makeFact("fact-id")),
        queryBySourceMemory: vi.fn().mockResolvedValue([]),
        invalidate: vi.fn(),
      },
      topics: { getOrCreate: vi.fn() },
      projects: { findByName: vi.fn() },
      context: { project: null },
      sessionMemories: { record, get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerDecisionTools(mockServer.server, services as never)
    const loreDecide = mockServer.getActionHandler("lore-decision", "create")

    await loreDecide({
      decision: "New decision",
      rationale: "Because reasons",
      session: "session-xyz",
      agent: "claude-code",
    } as never)

    expect(record).toHaveBeenCalledWith(
      { agent: "claude-code", session: "session-xyz" },
      { memoryId: "dec-new", projectIds: ["proj-a", "proj-b"] }
    )
  })
})

describe("lore-list-decisions projectName resolution", () => {
  it("returns an explicit error when projectName does not resolve", async () => {
    const mockServer = createMockServer()
    const decisionsList = vi.fn()
    const services = {
      decisions: { list: decisionsList },
      projects: { findByName: vi.fn().mockResolvedValue(null) },
      facts: {},
      topics: {},
      context: { project: { id: "proj-ambient", name: "Ambient" } },
    }

    registerDecisionTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-decision", "list")

    const result = await handler({ projectName: "Typo" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain('Project "Typo" could not be resolved')
    expect(text).toContain("Fix the project scope")
    expect(decisionsList).not.toHaveBeenCalled()
  })
})

describe("lore-decision-context projectName resolution", () => {
  it("returns an explicit error when projectName does not resolve", async () => {
    const mockServer = createMockServer()
    const queryByEntity = vi.fn()
    const services = {
      decisions: {},
      projects: { findByName: vi.fn().mockResolvedValue(null) },
      facts: { queryByEntity },
      topics: {},
      context: { project: { id: "proj-ambient", name: "Ambient" } },
    }

    registerDecisionTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-decision", "context")

    const result = await handler({ entity: "AuthService", projectName: "Typo" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain('Project "Typo" could not be resolved')
    expect(text).toContain("Fix the project scope")
    expect(queryByEntity).not.toHaveBeenCalled()
  })
})

describe("lore-decision-context — partial decision resolution", () => {
  function servicesWithPartialFailure() {
    const goodDecision = makeDecision("good-id", { title: "Working decision" })
    return {
      decisions: {
        getById: vi.fn().mockImplementation(async (id: string) => {
          if (id === "good-id") return goodDecision
          throw new Error(`unknown decision ${id}`)
        }),
      },
      projects: { findByName: vi.fn() },
      facts: {
        queryByEntity: vi.fn().mockResolvedValue([
          { ...makeFact("fact-ok"), sourceMemoryId: "good-id", object: "good-id" },
          { ...makeFact("fact-bad"), sourceMemoryId: "bad-root", object: "bad-root" },
        ]),
        queryByObject: vi.fn().mockImplementation(async (object: string) => {
          if (object === "bad-root") throw new Error("notion 5xx")
          return []
        }),
      },
      topics: {},
      entities: makeEntityService(),
      context: { project: null },
    }
  }

  it("surfaces a warning when one decision root's walk rejects", async () => {
    // Tool-layer acceptance for PF1-02: the `settleAll` wrapper inside
    // resolveCanonicalDecisionLinks produces `failures`, and the tool
    // handler routes them through the same `formatWarnings` shape
    // `lore-ask` uses. This pins end-to-end behaviour that decision-graph
    // unit tests cannot.
    const mockServer = createMockServer()
    const services = servicesWithPartialFailure()

    registerDecisionTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-decision", "context")

    const result = await handler({ entity: "AuthService" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    // The resolved decision still renders.
    expect(text).toContain("Working decision")
    // Warning matches lore-ask's format: single "Warnings:" footer
    // with failing root IDs inside it. Regex co-location pin so a
    // leak of `bad-root` into the decision render above still fails.
    expect(text).toMatch(/Warnings:[^\n]*bad-root/)
    expect(text).toContain("retry before relying on this result")
  })

  it("emits one stderr line per failing root when LORE_DEBUG=1", async () => {
    // Operator observability parity with lore-ask — same log shape so a
    // single `grep "[lore] partial-failure:"` sweep catches both tools.
    const mockServer = createMockServer()
    const services = servicesWithPartialFailure()
    registerDecisionTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-decision", "context")
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    vi.stubEnv("LORE_DEBUG", "1")

    try {
      await handler({ entity: "AuthService" } as never)

      expect(stderr).toHaveBeenCalledTimes(1)
      const logged = String(stderr.mock.calls[0][0])
      // Same exact-format pin as `lore-query action='ask'`: ensures both
      // tools emit the identical canonical line so ops filters work
      // uniformly. A field reorder in one call site without the other
      // would break cross-tool correlation silently; pinning the full
      // line here catches the drift.
      expect(logged).toBe(
        "[lore] partial-failure: root=bad-root error=notion 5xx tool=lore-decision\n"
      )
    } finally {
      vi.unstubAllEnvs()
      stderr.mockRestore()
    }
  })

  it("is silent on stderr when LORE_DEBUG is unset, even with partial failures", async () => {
    const mockServer = createMockServer()
    const services = servicesWithPartialFailure()
    registerDecisionTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-decision", "context")
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    vi.stubEnv("LORE_DEBUG", "")

    try {
      const result = await handler({ entity: "AuthService" } as never)
      const text = (result as { content: Array<{ text: string }> }).content[0].text

      expect(text).toMatch(/Warnings:[^\n]*bad-root/)
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
      stderr.mockRestore()
    }
  })
})

describe("lore-decision-context — PF3-01 canonical entity resolution", () => {
  function makeServicesWithEntities(opts: {
    entityResolution?: {
      entity?: { id: string; name: string; aliases: string[] } | null
      ambiguous?: boolean
      candidates?: Array<{ id: string; name: string }>
    }
    decision?: Decision
    facts?: Fact[]
  }) {
    const decision =
      opts.decision ?? makeDecision("dec-1", { title: "Use JWT for sessions" })

    return {
      decisions: {
        getById: vi.fn().mockImplementation(async (id: string) => {
          if (id === decision.id) return decision
          throw new Error(`unknown decision ${id}`)
        }),
      },
      projects: { findByName: vi.fn() },
      facts: {
        queryByEntity: vi.fn().mockResolvedValue(
          opts.facts ?? [
            {
              ...makeFact("fact-1"),
              sourceMemoryId: decision.id,
              object: decision.id,
            },
          ]
        ),
        queryByObject: vi.fn().mockResolvedValue([]),
      },
      topics: {},
      context: { project: { id: "proj-a", name: "Ambient" } },
      entities: {
        resolveOrCreateEntity: vi.fn().mockImplementation(async () => ({
          entity: opts.entityResolution?.entity ?? null,
          ambiguous: opts.entityResolution?.ambiguous ?? false,
          candidates:
            opts.entityResolution?.candidates ??
            (opts.entityResolution?.entity ? [opts.entityResolution.entity] : []),
          created: false,
        })),
      },
    }
  }

  it("routes through resolveOrCreateEntity with autoCreate=false and forwards entityId to queryByEntity", async () => {
    // Acceptance criterion: alias input ("AuthSvc") resolves to canonical
    // entity ("AuthService") and queryByEntity is called with the
    // resolved entityId so the relation join surfaces backfilled facts.
    // autoCreate must be false — the read path cannot mint entities.
    const mockServer = createMockServer()
    const services = makeServicesWithEntities({
      entityResolution: {
        entity: {
          id: "ent-auth",
          name: "AuthService",
          aliases: ["AuthSvc"],
        },
      },
    })
    registerDecisionTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-decision", "context")

    await handler({ entity: "AuthSvc" } as never)

    expect(services.entities.resolveOrCreateEntity).toHaveBeenCalledWith(
      "AuthSvc",
      expect.objectContaining({ autoCreate: false })
    )
    expect(services.facts.queryByEntity).toHaveBeenCalledWith(
      "AuthSvc",
      expect.objectContaining({
        projectId: "proj-a",
        entityId: "ent-auth",
        predicates: ["decided_by"],
      })
    )
  })

  it("surfaces an ambiguity warning instead of silently picking one entity", async () => {
    // Acceptance criterion: when the resolver returns ambiguous=true,
    // emit a warning naming the candidates so the caller can disambiguate.
    // The substring fallback inside queryByEntity still runs underneath
    // (entityId is null), so the agent gets the best-effort hit set.
    const mockServer = createMockServer()
    const services = makeServicesWithEntities({
      entityResolution: {
        entity: null,
        ambiguous: true,
        candidates: [
          { id: "ent-a", name: "User (auth context)" },
          { id: "ent-b", name: "User (db schema)" },
        ],
      },
    })
    registerDecisionTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-decision", "context")

    const result = await handler({ entity: "User" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("Warnings:")
    expect(text).toContain("matches 2 entities")
    expect(text).toContain("ent-a")
    expect(text).toContain("ent-b")
    // queryByEntity still called, but entityId is undefined so the
    // call falls through to the substring path under queryByEntity.
    expect(services.facts.queryByEntity).toHaveBeenCalledWith(
      "User",
      expect.objectContaining({
        projectId: "proj-a",
        predicates: ["decided_by"],
      })
    )
    const opts = (services.facts.queryByEntity as ReturnType<typeof vi.fn>).mock
      .calls[0][1]
    expect(opts.entityId).toBeUndefined()
  })

  it("unresolved entity lookup queries by raw entity", async () => {
    // queryByEntity's entityId-null branch falls through to queryBySubject
    // ∪ queryByObject. The tool must still pass predicates:
    // ['decided_by'] so the union is server-side narrowed.
    const mockServer = createMockServer()
    const services = makeServicesWithEntities({})
    registerDecisionTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-decision", "context")

    await handler({ entity: "AuthService" } as never)

    expect(services.facts.queryByEntity).toHaveBeenCalledWith(
      "AuthService",
      expect.objectContaining({
        projectId: "proj-a",
        predicates: ["decided_by"],
      })
    )
    const opts = (services.facts.queryByEntity as ReturnType<typeof vi.fn>).mock
      .calls[0][1]
    expect(opts.entityId).toBeUndefined()
  })

  it("surfaces ambiguity warning even when queryByEntity returns zero facts", async () => {
    // Pin the no-facts early return rendering the warnings footer.
    // Without it, a vault where the ambiguous input has zero matching
    // facts would silently swallow the candidate disambiguation hint —
    // the user would see a misleading "No decisions found" with no
    // signal that the input was even ambiguous.
    const mockServer = createMockServer()
    const services = makeServicesWithEntities({
      entityResolution: {
        entity: null,
        ambiguous: true,
        candidates: [
          { id: "ent-a", name: "User (auth context)" },
          { id: "ent-b", name: "User (db schema)" },
        ],
      },
      facts: [],
    })
    registerDecisionTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-decision", "context")

    const result = await handler({ entity: "User" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("No decisions found")
    expect(text).toContain("Warnings:")
    expect(text).toContain("matches 2 entities")
    expect(text).toContain("ent-a")
    expect(text).toContain("ent-b")
  })

  it("warns and continues when entity resolution throws (transient failure)", async () => {
    // The resolver path must never collapse the whole tool call —
    // queryByEntity's substring fallback still produces useful results.
    const mockServer = createMockServer()
    const services = makeServicesWithEntities({})
    services.entities.resolveOrCreateEntity = vi
      .fn()
      .mockRejectedValue(new Error("notion 429"))
    registerDecisionTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-decision", "context")

    const result = await handler({ entity: "AuthService" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("Entity lookup failed")
    expect(text).toContain("notion 429")
    expect(services.facts.queryByEntity).toHaveBeenCalled()
  })
})

describe("lore-decision synopsis surface (issue 0.7.0/02)", () => {
  it("threads synopsis on action='create' through to decisions.create", async () => {
    const mockServer = createMockServer()
    const created = makeDecision("dec-1", {
      title: "Cache project resolutions for 60s",
      synopsis: "All resolved projects are cached in-process for 60s.",
    })

    const services = {
      decisions: {
        create: vi.fn().mockResolvedValue(created),
        getById: vi.fn(),
        supersede: vi.fn(),
      },
      facts: {
        create: vi.fn().mockResolvedValue(makeFact("fact-id")),
        queryBySourceMemory: vi.fn().mockResolvedValue([]),
        invalidate: vi.fn().mockResolvedValue(undefined),
      },
      topics: { getOrCreate: vi.fn() },
      projects: { findByName: vi.fn() },
      memories: { list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerDecisionTools(mockServer.server, services as never)
    const loreDecide = mockServer.getActionHandler("lore-decision", "create")

    await loreDecide({
      decision: "Cache project resolutions for 60s",
      rationale: "Long-form rationale here.",
      synopsis: "All resolved projects are cached in-process for 60s.",
    } as never)

    expect(services.decisions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "Cache project resolutions for 60s",
        rationale: "Long-form rationale here.",
        synopsis: "All resolved projects are cached in-process for 60s.",
      })
    )
  })

  it("rejects synopsis longer than 500 chars at the Zod boundary", async () => {
    const mockServer = createMockServer()
    const services = {
      decisions: { create: vi.fn(), getById: vi.fn(), supersede: vi.fn() },
      facts: { create: vi.fn(), queryBySourceMemory: vi.fn(), invalidate: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      projects: { findByName: vi.fn() },
      memories: { list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerDecisionTools(mockServer.server, services as never)
    const loreDecide = mockServer.getActionHandler("lore-decision", "create")
    const overCap = "x".repeat(501)

    const result = await loreDecide({
      decision: "T",
      rationale: "R",
      synopsis: overCap,
    } as never)

    const wrapped = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(wrapped.isError).toBe(true)
    expect(wrapped.content[0].text).toContain("synopsis")
    expect(services.decisions.create).not.toHaveBeenCalled()
  })
})

describe("lore-decision action='create' Alternatives/Consequences rich_text cap (#270)", () => {
  function setUpCreateHarness() {
    const mockServer = createMockServer()
    const created = makeDecision("dec-rich-text-cap", { projectIds: [] })
    const create = vi.fn().mockResolvedValue(created)
    const services = {
      decisions: { create, getById: vi.fn(), supersede: vi.fn() },
      facts: {
        create: vi.fn().mockResolvedValue(makeFact("fact-id")),
        queryBySourceMemory: vi.fn().mockResolvedValue([]),
        invalidate: vi.fn(),
      },
      memories: { decrementConfidence: vi.fn(), list: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      projects: { findByName: vi.fn() },
      context: { project: null, isCatchAllFallback: false },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }
    registerDecisionTools(mockServer.server, services as never)
    return {
      handler: mockServer.getActionHandler("lore-decision", "create"),
      create,
    }
  }

  it("accepts alternatives and consequences at the Notion rich_text cap", async () => {
    const { handler, create } = setUpCreateHarness()
    const atCap = "x".repeat(RICH_TEXT_PROPERTY_MAX_LEN)

    const result = await handler({
      decision: "Keep metadata capped",
      rationale: "Long rationale still belongs in the body.",
      alternatives: atCap,
      consequences: atCap,
    } as never)

    expect((result as { isError?: boolean }).isError).not.toBe(true)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        alternatives: atCap,
        consequences: atCap,
      })
    )
  })

  it.each([
    ["alternatives", { alternatives: "x".repeat(RICH_TEXT_PROPERTY_MAX_LEN + 1) }],
    ["consequences", { consequences: "x".repeat(RICH_TEXT_PROPERTY_MAX_LEN + 1) }],
  ] as const)("rejects over-cap %s before decisions.create", async (field, input) => {
    const { handler, create } = setUpCreateHarness()

    const result = await handler({
      decision: "Keep metadata capped",
      rationale: "Long rationale still belongs in the body.",
      ...input,
    } as never)

    const wrapped = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(wrapped.isError).toBe(true)
    expect(wrapped.content[0].text).toContain(field)
    expect(wrapped.content[0].text).toContain(`${RICH_TEXT_PROPERTY_MAX_LEN}`)
    expect(create).not.toHaveBeenCalled()
  })
})

describe("lore-decision action='list' synopsis rendering (DEFERRED-01)", () => {
  function listServices(items: ReturnType<typeof makeDecision>[]) {
    return {
      decisions: { list: vi.fn().mockResolvedValue({ items, nextCursor: null }) },
      projects: { findByName: vi.fn() },
      facts: {},
      topics: {},
      context: { project: null },
    }
  }

  it("renders the synopsis line between the title heading and the metadata line by default", async () => {
    const decision = makeDecision("dec-syn", {
      title: "Cache project resolutions",
      synopsis: "All resolved projects are cached in-process for 60s.",
    })
    const mockServer = createMockServer()
    registerDecisionTools(mockServer.server, listServices([decision]) as never)

    const handler = mockServer.getActionHandler("lore-decision", "list")
    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    const lines = text.split("\n")
    const headingIdx = lines.findIndex((l) => l === "### Cache project resolutions")
    expect(headingIdx).toBeGreaterThanOrEqual(0)
    expect(lines[headingIdx + 1]).toBe(
      "All resolved projects are cached in-process for 60s."
    )
    // Metadata bold line follows synopsis.
    expect(lines[headingIdx + 2]).toMatch(/^\*\*\[accepted\]/)
  })

  it("marks the pagination footer as truncated when the live-row refill cap fires", async () => {
    const decision = makeDecision("dec-capped", {
      title: "Capped decision page",
      synopsis: "Visible row from a capped refill window.",
    })
    const mockServer = createMockServer()
    const services = {
      decisions: {
        list: vi.fn().mockResolvedValue({
          items: [decision],
          nextCursor: "keep-paging",
          capped: true,
        }),
      },
      projects: { findByName: vi.fn() },
      facts: {},
      topics: {},
      context: { project: null },
    }
    registerDecisionTools(mockServer.server, services as never)

    const handler = mockServer.getActionHandler("lore-decision", "list")
    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("### Capped decision page")
    expect(text).toMatch(/```json\n\{"nextCursor":"keep-paging","truncated":true\}\n```/)
  })

  it("omits the synopsis line on rows with empty synopsis (byte-identical pre-DEFERRED-01 path)", async () => {
    const decision = makeDecision("dec-empty", {
      title: "Plain decision",
      synopsis: "",
    })
    const mockServer = createMockServer()
    registerDecisionTools(mockServer.server, listServices([decision]) as never)

    const handler = mockServer.getActionHandler("lore-decision", "list")
    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    // Byte-identical pin against the pre-DEFERRED-01 shape — `toBe` rather
    // than `toMatch` so a trailing-space or extra-newline regression slips
    // nothing past the assertion. The fixture's `decidedAt` is set on
    // `makeDecision` (2026-04-20) and `reviewBy` is null, so the
    // `formatSummary` line resolves deterministically without a clock dep.
    expect(text).toBe(
      "Found 1 decision:\n\n" +
        "### Plain decision\n" +
        "**[accepted] | decided 2026-04-20 | ID: dec-empty**\n"
    )
  })

  it("treats whitespace-only synopsis the same as empty (no rendered line)", async () => {
    // Whitespace-only synopses can't come from any current write path
    // (Notion's rich_text default is empty string, and the Zod write
    // schemas don't strip), but a future migration / hand-edit could
    // land one. Pin the trim-aware truthy check so the listing surface
    // never emits a row of pure whitespace between heading and meta.
    const decision = makeDecision("dec-ws", {
      title: "Whitespace synopsis",
      synopsis: "   \t  ",
    })
    const mockServer = createMockServer()
    registerDecisionTools(mockServer.server, listServices([decision]) as never)

    const handler = mockServer.getActionHandler("lore-decision", "list")
    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toBe(
      "Found 1 decision:\n\n" +
        "### Whitespace synopsis\n" +
        "**[accepted] | decided 2026-04-20 | ID: dec-ws**\n"
    )
  })

  it("suppresses the synopsis line when includeSynopsis: false", async () => {
    const decision = makeDecision("dec-syn", {
      title: "Cache project resolutions",
      synopsis: "All resolved projects are cached in-process for 60s.",
    })
    const mockServer = createMockServer()
    registerDecisionTools(mockServer.server, listServices([decision]) as never)

    const handler = mockServer.getActionHandler("lore-decision", "list")
    const result = await handler({ includeSynopsis: false } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).not.toContain("All resolved projects are cached in-process for 60s.")
    const lines = text.split("\n")
    const headingIdx = lines.findIndex((l) => l === "### Cache project resolutions")
    // Suppression collapses to the byte-identical pre-#02 shape: heading
    // immediately followed by the bold meta line.
    expect(lines[headingIdx + 1]).toMatch(/^\*\*\[accepted\]/)
  })

  it("defensively truncates over-cap synopses on the listing surface", async () => {
    // 600 chars of "abcde " words, mirroring the render.test.ts truncation
    // fixture so the boundary math is identical and obvious.
    const word = "abcde "
    const longSynopsis = word.repeat(100)
    const decision = makeDecision("dec-long", {
      title: "Long synopsis decision",
      synopsis: longSynopsis,
    })
    const mockServer = createMockServer()
    registerDecisionTools(mockServer.server, listServices([decision]) as never)

    const handler = mockServer.getActionHandler("lore-decision", "list")
    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    const lines = text.split("\n")
    const headingIdx = lines.findIndex((l) => l === "### Long synopsis decision")
    const synopsisLine = lines[headingIdx + 1]
    expect(synopsisLine.length).toBeLessThanOrEqual(500)
    // Boundary-safe: ends on a word, no trailing whitespace, no ellipsis.
    expect(synopsisLine.endsWith("e")).toBe(true)
    expect(synopsisLine).not.toContain("…")
  })
})

describe("lore-decision action='list' trust indicator (DEFERRED-01 follow-up to 0.8.0/#09)", () => {
  // The same surface assertion shape used by `decisions.test.ts`'s
  // synopsis suite (DEFERRED-01 from 0.7.0): line-index pins protect
  // against an off-by-one rewrite that would silently shift the trust
  // line into the wrong slot. Buckets — very-low / low / moderate —
  // are pinned in `formatTrustLabel` (`src/types.ts`) and exercised
  // exhaustively in `render.test.ts`; these tests pin the surface
  // wiring (the line lands ABOVE synopsis, below heading, in the
  // listing output).

  function listServices(items: ReturnType<typeof makeDecision>[]) {
    return {
      decisions: { list: vi.fn().mockResolvedValue({ items, nextCursor: null }) },
      projects: { findByName: vi.fn() },
      facts: {},
      topics: {},
      context: { project: null },
    }
  }

  it("renders the trust line between the heading and the synopsis on a low-confidence row", async () => {
    // Order is load-bearing: a low-confidence decision's synopsis is
    // itself suspect, so the signal must precede the synopsis content.
    // Mirrors `formatMemoryListItem`'s placement in `render.ts` so the
    // three surfaces (#09 + this DEFERRED-01) share one rendering
    // contract.
    const decision = makeDecision("dec-low", {
      title: "Low-confidence decision",
      synopsis: "All resolved projects are cached in-process for 60s.",
      confidenceScore: 0.3,
    })
    const mockServer = createMockServer()
    registerDecisionTools(mockServer.server, listServices([decision]) as never)

    const handler = mockServer.getActionHandler("lore-decision", "list")
    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    const lines = text.split("\n")
    const headingIdx = lines.findIndex((l) => l === "### Low-confidence decision")
    expect(headingIdx).toBeGreaterThanOrEqual(0)
    expect(lines[headingIdx + 1]).toBe("_low confidence_")
    expect(lines[headingIdx + 2]).toBe(
      "All resolved projects are cached in-process for 60s."
    )
    // Bold meta line follows synopsis after trust, matching the
    // four-row envelope (heading → trust → synopsis → meta).
    expect(lines[headingIdx + 3]).toMatch(/^\*\*\[accepted\]/)
  })

  it("renders `_very low confidence_` when the stored score is below 0.2", () => {
    // Keeps the bucket boundaries reachable from the surface — the
    // detailed bucket assertions live in `render.test.ts`, but the
    // listing surface pins one in-bucket case per band so a future
    // contributor swapping the formatter sees regressions surface here
    // too.
    const decision = makeDecision("dec-vlow", {
      title: "Heavily-decayed decision",
      synopsis: "",
      confidenceScore: 0.15,
    })
    const mockServer = createMockServer()
    registerDecisionTools(mockServer.server, listServices([decision]) as never)

    const handler = mockServer.getActionHandler("lore-decision", "list")
    return handler({} as never).then((result) => {
      const text = (result as { content: Array<{ text: string }> }).content[0].text
      const lines = text.split("\n")
      const headingIdx = lines.findIndex((l) => l === "### Heavily-decayed decision")
      expect(headingIdx).toBeGreaterThanOrEqual(0)
      expect(lines[headingIdx + 1]).toBe("_very low confidence_")
    })
  })

  it("renders `_moderate confidence_` when 0.4 ≤ score < 0.5", async () => {
    const decision = makeDecision("dec-mod", {
      title: "Borderline decision",
      synopsis: "",
      confidenceScore: 0.45,
    })
    const mockServer = createMockServer()
    registerDecisionTools(mockServer.server, listServices([decision]) as never)

    const handler = mockServer.getActionHandler("lore-decision", "list")
    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    const lines = text.split("\n")
    const headingIdx = lines.findIndex((l) => l === "### Borderline decision")
    expect(lines[headingIdx + 1]).toBe("_moderate confidence_")
  })

  it("omits the trust line when confidenceScore is null (pre-migration vault stays byte-identical)", async () => {
    // Acceptance criterion: rows with `confidenceScore: null` render
    // identically to pre-DEFERRED-01. A vault that hasn't run
    // `lore migrate --build-confidence-scores` should look unchanged
    // until the migration populates scores. `toBe` rather than
    // `toMatch` so any indentation drift, trailing whitespace, or
    // extra newline shows up as a test failure rather than slipping
    // past a regex that only checked the first line.
    const decision = makeDecision("dec-null", {
      title: "Pre-migration row",
      synopsis: "",
      confidenceScore: null,
    })
    const mockServer = createMockServer()
    registerDecisionTools(mockServer.server, listServices([decision]) as never)

    const handler = mockServer.getActionHandler("lore-decision", "list")
    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toBe(
      "Found 1 decision:\n\n" +
        "### Pre-migration row\n" +
        "**[accepted] | decided 2026-04-20 | ID: dec-null**\n"
    )
  })

  it("omits the trust line when the score is at or above the display threshold", async () => {
    // The strict less-than gate keeps 0.5 silent. A `<=` rewrite on
    // the threshold predicate would fail this test, complementing the
    // bucket-boundary tests in `render.test.ts`.
    const decision = makeDecision("dec-healthy", {
      title: "Healthy decision",
      synopsis: "",
      confidenceScore: 0.5,
    })
    const mockServer = createMockServer()
    registerDecisionTools(mockServer.server, listServices([decision]) as never)

    const handler = mockServer.getActionHandler("lore-decision", "list")
    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).not.toContain("confidence_")
  })

  it("renders trust line above synopsis line on rows that have both", async () => {
    // Pin the four-row envelope (heading → trust → synopsis → meta)
    // explicitly so a future reordering of the trust insertion point
    // (e.g. moving it below synopsis) trips this test.
    const decision = makeDecision("dec-both", {
      title: "Trust + synopsis",
      synopsis: "Short gist.",
      confidenceScore: 0.15,
    })
    const mockServer = createMockServer()
    registerDecisionTools(mockServer.server, listServices([decision]) as never)

    const handler = mockServer.getActionHandler("lore-decision", "list")
    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    const lines = text.split("\n")
    const headingIdx = lines.findIndex((l) => l === "### Trust + synopsis")
    expect(lines[headingIdx]).toBe("### Trust + synopsis")
    expect(lines[headingIdx + 1]).toBe("_very low confidence_")
    expect(lines[headingIdx + 2]).toBe("Short gist.")
    expect(lines[headingIdx + 3]).toMatch(/^\*\*\[accepted\]/)
  })

  it("respects `includeSynopsis: false` but still renders the trust line", async () => {
    // Trust signal is system metadata; it is NOT gated by the
    // synopsis-rendering toggle. Suppressing the synopsis line shouldn't
    // suppress the trust signal — those are independent surfaces with
    // independent rationale. Mirrors the same assertion in
    // `render.test.ts` for `formatMemoryListItem`.
    const decision = makeDecision("dec-no-syn", {
      title: "No-synopsis low-trust",
      synopsis: "This synopsis must not render.",
      confidenceScore: 0.3,
    })
    const mockServer = createMockServer()
    registerDecisionTools(mockServer.server, listServices([decision]) as never)

    const handler = mockServer.getActionHandler("lore-decision", "list")
    const result = await handler({ includeSynopsis: false } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).not.toContain("This synopsis must not render.")
    expect(text).toContain("_low confidence_")
    const lines = text.split("\n")
    const headingIdx = lines.findIndex((l) => l === "### No-synopsis low-trust")
    expect(lines[headingIdx + 1]).toBe("_low confidence_")
    // Suppressing synopsis collapses to heading → trust → meta.
    expect(lines[headingIdx + 2]).toMatch(/^\*\*\[accepted\]/)
  })
})

describe("lore-decision action='supersede' — confidence decrement on old decision", () => {
  // Acceptance criteria from 0.8.0/06: superseding a decision halves
  // the old decision's `Confidence Score` (decay-realized first on
  // stale rows), writes `Last Referenced At = today`, and degrades
  // gracefully on `pages.update` failure.

  function makeServices(opts: {
    oldDecision: Decision
    newDecision?: Decision
    decrementImpl?: (memory: Decision) => Promise<number>
  }) {
    const newDecision =
      opts.newDecision ?? makeDecision("dec-new", { title: "New decision" })
    const memoriesDecrement =
      opts.decrementImpl !== undefined
        ? vi.fn(opts.decrementImpl)
        : vi.fn().mockResolvedValue(0.45)
    return {
      newDecision,
      services: {
        decisions: {
          create: vi.fn().mockResolvedValue(newDecision),
          getById: vi.fn().mockImplementation(async (id: string) => {
            if (id === opts.oldDecision.id) return opts.oldDecision
            if (id === newDecision.id) return newDecision
            throw new Error(`unknown decision ${id}`)
          }),
          supersede: vi.fn().mockResolvedValue(undefined),
        },
        facts: {
          create: vi.fn().mockResolvedValue(makeFact("fact-id")),
          queryBySourceMemory: vi.fn().mockResolvedValue([]),
          invalidate: vi.fn(),
        },
        memories: {
          decrementConfidence: memoriesDecrement,
        },
        topics: { getOrCreate: vi.fn() },
        projects: { findByName: vi.fn() },
        context: { project: null },
        sessionMemories: { record: vi.fn(), get: vi.fn() },
        identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
      },
      memoriesDecrement,
    }
  }

  it("decrements the old decision after the supersede write", async () => {
    const oldDecision = makeDecision("dec-old", {
      title: "Old decision",
      confidenceScore: 0.9,
      lastReferencedAt: "2026-04-29",
    })
    const mockServer = createMockServer()
    const ctx = makeServices({ oldDecision })
    registerDecisionTools(mockServer.server, ctx.services as never)
    const supersede = mockServer.getActionHandler("lore-decision", "supersede")

    const result = await supersede({
      newDecisionId: ctx.newDecision.id,
      oldDecisionId: oldDecision.id,
    } as never)
    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBeFalsy()
    // The handler passes the full Decision shape (Memory & { kind:
    // "decision" }) so seed/decay/decrement algebra has access to
    // confidence, confidenceScore, lastReferencedAt, createdAt.
    expect(ctx.memoriesDecrement).toHaveBeenCalledTimes(1)
    expect(ctx.memoriesDecrement).toHaveBeenCalledWith(oldDecision)
  })

  it("decrement failure is advisory: supersede response stays clean (no isError)", async () => {
    const oldDecision = makeDecision("dec-old", {
      confidenceScore: 0.9,
      lastReferencedAt: "2026-04-29",
    })
    const mockServer = createMockServer()
    const ctx = makeServices({
      oldDecision,
      decrementImpl: async () => {
        throw new Error("notion 429")
      },
    })
    registerDecisionTools(mockServer.server, ctx.services as never)
    const supersede = mockServer.getActionHandler("lore-decision", "supersede")

    const result = await supersede({
      newDecisionId: ctx.newDecision.id,
      oldDecisionId: oldDecision.id,
    } as never)
    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBeFalsy()
    expect(payload.content[0].text).toContain("Superseded")
  })

  it("logs decrement failure under LORE_DEBUG=1 with source=supersede", async () => {
    const oldDecision = makeDecision("dec-old-log", {
      confidenceScore: 0.9,
      lastReferencedAt: "2026-04-29",
    })
    const mockServer = createMockServer()
    const ctx = makeServices({
      oldDecision,
      decrementImpl: async () => {
        throw new Error("notion 429")
      },
    })
    registerDecisionTools(mockServer.server, ctx.services as never)
    const supersede = mockServer.getActionHandler("lore-decision", "supersede")

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    process.env.LORE_DEBUG = "1"
    try {
      await supersede({
        newDecisionId: ctx.newDecision.id,
        oldDecisionId: oldDecision.id,
      } as never)
      const lines = stderr.mock.calls.map(([line]) => String(line))
      const failure = lines.find((l) => l.includes("contradiction-failure:"))
      expect(failure).toBeDefined()
      expect(failure).toContain("source=supersede")
      expect(failure).toContain("memoryId=dec-old-log")
      expect(failure).toContain("error=notion 429")
    } finally {
      delete process.env.LORE_DEBUG
      stderr.mockRestore()
    }
  })
})

describe("lore-decision action='create' with supersedesIds — parallel decrement", () => {
  it("decrements all superseded decisions in parallel; new decision is not decremented", async () => {
    // Acceptance: supersedesIds: [a, b, c] decrements all three in
    // parallel (Promise.all over the captured old decisions); the new
    // decision never appears in the decrement call list.
    const mockServer = createMockServer()
    const newDecision = makeDecision("dec-new")
    const oldA = makeDecision("dec-a", { confidenceScore: 0.9 })
    const oldB = makeDecision("dec-b", { confidenceScore: 0.6 })
    const oldC = makeDecision("dec-c", { confidenceScore: 0.3 })
    const lookup: Record<string, Decision> = {
      "dec-new": newDecision,
      "dec-a": oldA,
      "dec-b": oldB,
      "dec-c": oldC,
    }

    // The test verifies parallelism by holding the first decrement
    // call open until the others have been requested. If the
    // implementation iterated serially with `await`, the second call
    // would never arrive while the first is pending, and `Promise.all`
    // over a serial loop would deadlock the assertion below.
    let inFlight = 0
    let peakInFlight = 0
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const decrementCalls: string[] = []
    const memoriesDecrement = vi.fn(async (decision: Decision) => {
      decrementCalls.push(decision.id)
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      // Hold open until the gate releases — verifies parallel dispatch.
      if (inFlight < 3) await gate
      inFlight--
      return 0.45
    })

    const services = {
      decisions: {
        create: vi.fn().mockResolvedValue(newDecision),
        getById: vi.fn().mockImplementation(async (id: string) => {
          const found = lookup[id]
          if (!found) throw new Error(`unknown decision ${id}`)
          return found
        }),
        supersede: vi.fn().mockResolvedValue(undefined),
      },
      facts: {
        create: vi.fn().mockResolvedValue(makeFact("fact-id")),
        queryBySourceMemory: vi.fn().mockResolvedValue([]),
        invalidate: vi.fn().mockResolvedValue(undefined),
      },
      memories: {
        decrementConfidence: memoriesDecrement,
      },
      topics: { getOrCreate: vi.fn() },
      projects: { findByName: vi.fn() },
      context: { project: null },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerDecisionTools(mockServer.server, services as never)
    const loreDecide = mockServer.getActionHandler("lore-decision", "create")

    // Kick off the call; release the gate once we expect parallelism
    // to have been kicked off. setImmediate gives the for-loop time
    // to dispatch all three supersedesIds entries before we release.
    const handlerPromise = loreDecide({
      decision: "New decision",
      rationale: "Because reasons",
      supersedesIds: ["dec-a", "dec-b", "dec-c"],
    } as never)
    // Allow microtasks to run the parallel decrement dispatch.
    await new Promise((r) => setImmediate(r))
    releaseGate()
    await handlerPromise

    expect(memoriesDecrement).toHaveBeenCalledTimes(3)
    expect(new Set(decrementCalls)).toEqual(new Set(["dec-a", "dec-b", "dec-c"]))
    // The new decision is NEVER passed to decrementConfidence.
    expect(decrementCalls).not.toContain("dec-new")
    // Parallel dispatch: all three calls were in flight simultaneously.
    expect(peakInFlight).toBe(3)
  })

  it("a single failing decrement does not fail the create response or block siblings", async () => {
    // Acceptance: `Promise.all` with each decrement wrapped in `.catch`
    // means a transient 429 on one row degrades to a no-op for that
    // row; the other decrements still write, the create response is
    // still success.
    const mockServer = createMockServer()
    const newDecision = makeDecision("dec-new")
    const oldA = makeDecision("dec-a", { confidenceScore: 0.9 })
    const oldB = makeDecision("dec-b", { confidenceScore: 0.6 })

    const memoriesDecrement = vi.fn(async (decision: Decision) => {
      if (decision.id === "dec-a") throw new Error("notion 429")
      return 0.3
    })

    const services = {
      decisions: {
        create: vi.fn().mockResolvedValue(newDecision),
        getById: vi.fn().mockImplementation(async (id: string) => {
          if (id === "dec-a") return oldA
          if (id === "dec-b") return oldB
          if (id === "dec-new") return newDecision
          throw new Error(`unknown decision ${id}`)
        }),
        supersede: vi.fn().mockResolvedValue(undefined),
      },
      facts: {
        create: vi.fn().mockResolvedValue(makeFact("fact-id")),
        queryBySourceMemory: vi.fn().mockResolvedValue([]),
        invalidate: vi.fn().mockResolvedValue(undefined),
      },
      memories: {
        decrementConfidence: memoriesDecrement,
      },
      topics: { getOrCreate: vi.fn() },
      projects: { findByName: vi.fn() },
      context: { project: null },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerDecisionTools(mockServer.server, services as never)
    const loreDecide = mockServer.getActionHandler("lore-decision", "create")

    const result = await loreDecide({
      decision: "New decision",
      rationale: "Because reasons",
      supersedesIds: ["dec-a", "dec-b"],
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBeFalsy()
    // Both decrements were attempted (parallelism holds despite one failing).
    expect(memoriesDecrement).toHaveBeenCalledTimes(2)
  })

  it("logs a failed decrement under LORE_DEBUG=1 with source=decide-supersede", async () => {
    const mockServer = createMockServer()
    const newDecision = makeDecision("dec-new")
    const oldA = makeDecision("dec-a", { confidenceScore: 0.9 })

    const services = {
      decisions: {
        create: vi.fn().mockResolvedValue(newDecision),
        getById: vi.fn().mockImplementation(async (id: string) => {
          if (id === "dec-a") return oldA
          if (id === "dec-new") return newDecision
          throw new Error(`unknown decision ${id}`)
        }),
        supersede: vi.fn().mockResolvedValue(undefined),
      },
      facts: {
        create: vi.fn().mockResolvedValue(makeFact("fact-id")),
        queryBySourceMemory: vi.fn().mockResolvedValue([]),
        invalidate: vi.fn().mockResolvedValue(undefined),
      },
      memories: {
        decrementConfidence: vi.fn().mockRejectedValue(new Error("notion 429")),
      },
      topics: { getOrCreate: vi.fn() },
      projects: { findByName: vi.fn() },
      context: { project: null },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerDecisionTools(mockServer.server, services as never)
    const loreDecide = mockServer.getActionHandler("lore-decision", "create")

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    process.env.LORE_DEBUG = "1"
    try {
      await loreDecide({
        decision: "New decision",
        rationale: "Because reasons",
        supersedesIds: ["dec-a"],
      } as never)
      const lines = stderr.mock.calls.map(([line]) => String(line))
      const failure = lines.find((l) => l.includes("contradiction-failure:"))
      expect(failure).toBeDefined()
      expect(failure).toContain("source=decide-supersede")
      expect(failure).toContain("memoryId=dec-a")
      expect(failure).toContain("error=notion 429")
    } finally {
      delete process.env.LORE_DEBUG
      stderr.mockRestore()
    }
  })
})

describe("lore-decision action='context' trust indicator (0.9.0/DEFERRED-07)", () => {
  // The action='context' surface (graph walk: every active decision
  // governing an entity) shares the heading-shaped layout with
  // action='list', so the trust line lands in the same slot. These
  // tests pin the surface wiring; bucket-by-bucket coverage lives in
  // `render.test.ts`.

  function contextServices(decision: ReturnType<typeof makeDecision>) {
    return {
      decisions: {
        getById: vi.fn().mockImplementation(async (id: string) => {
          if (id === decision.id) return decision
          throw new Error(`unknown decision ${id}`)
        }),
      },
      projects: { findByName: vi.fn() },
      facts: {
        queryByEntity: vi.fn().mockResolvedValue([
          {
            ...makeFact("fact-1"),
            sourceMemoryId: decision.id,
            object: decision.id,
          },
        ]),
        queryByObject: vi.fn().mockResolvedValue([]),
      },
      topics: {},
      context: { project: null },
      entities: {
        resolveOrCreateEntity: vi.fn().mockResolvedValue({
          entity: null,
          ambiguous: false,
          candidates: [],
          created: false,
        }),
      },
    }
  }

  it("renders the trust line between heading and metadata on a low-confidence decision", async () => {
    const decision = makeDecision("dec-low", {
      title: "Low-confidence governing decision",
      confidenceScore: 0.3,
    })
    const mockServer = createMockServer()
    registerDecisionTools(mockServer.server, contextServices(decision) as never)
    const handler = mockServer.getActionHandler("lore-decision", "context")

    const result = await handler({ entity: "AuthService" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    const lines = text.split("\n")
    const headingIdx = lines.findIndex(
      (l) => l === "### Low-confidence governing decision"
    )
    expect(headingIdx).toBeGreaterThanOrEqual(0)
    expect(lines[headingIdx + 1]).toBe("_low confidence_")
    // Metadata line follows trust, matching the heading → trust → meta
    // shape from action='list'.
    expect(lines[headingIdx + 2]).toMatch(/^\*\*\[accepted\]/)
  })

  it("omits the trust line when confidenceScore is null (pre-migration vault)", async () => {
    const decision = makeDecision("dec-null", {
      title: "Pre-migration governing decision",
      confidenceScore: null,
    })
    const mockServer = createMockServer()
    registerDecisionTools(mockServer.server, contextServices(decision) as never)
    const handler = mockServer.getActionHandler("lore-decision", "context")

    const result = await handler({ entity: "AuthService" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).not.toContain("confidence_")
  })

  it("omits the trust line when the score is at or above the display threshold", async () => {
    const decision = makeDecision("dec-healthy", {
      title: "Healthy governing decision",
      confidenceScore: 0.5,
    })
    const mockServer = createMockServer()
    registerDecisionTools(mockServer.server, contextServices(decision) as never)
    const handler = mockServer.getActionHandler("lore-decision", "context")

    const result = await handler({ entity: "AuthService" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).not.toContain("confidence_")
  })
})

// ---------------------------------------------------------------------------
// DEFERRED-ATTRIBUTION (0.10.0): Author column attribution on lore-decision.
//
// Decisions write to the Memories DB (Kind = decision); the same Author
// column carries the engineer-identity. Mirror the memory.test.ts coverage
// so a future refactor that drops lazy identity resolution from this handler
// fails the test.
// ---------------------------------------------------------------------------

describe("lore-decision action='create' — Author attribution (DEFERRED-ATTRIBUTION)", () => {
  function setUpCreateHarness(identityAuthor: string | null) {
    const mockServer = createMockServer()
    const created = makeDecision("dec-attrib", { projectIds: [] })
    const create = vi.fn().mockResolvedValue(created)
    const resolveAuthor = vi.fn(async () => identityAuthor)
    const services = {
      decisions: { create, getById: vi.fn(), supersede: vi.fn() },
      facts: {
        create: vi.fn().mockResolvedValue(makeFact("fact-id")),
        queryBySourceMemory: vi.fn().mockResolvedValue([]),
        invalidate: vi.fn(),
      },
      memories: {
        decrementConfidence: vi.fn(),
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      topics: { getOrCreate: vi.fn() },
      projects: { findByName: vi.fn() },
      context: { project: null, isCatchAllFallback: false },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor, clearCache: vi.fn() },
    }
    registerDecisionTools(mockServer.server, services as never)
    return {
      handler: mockServer.getActionHandler("lore-decision", "create"),
      create,
      resolveAuthor,
    }
  }

  it("stamps services.identity.resolveAuthor on decisions.create when args.author is omitted", async () => {
    const { handler, create } = setUpCreateHarness("Hesham Salman")
    await handler({ decision: "Use bcrypt", rationale: "Fast enough" } as never)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ author: "Hesham Salman" })
    )
  })

  it("explicit args.author wins without calling services.identity.resolveAuthor", async () => {
    const { handler, create, resolveAuthor } = setUpCreateHarness("ServerSideName")
    await handler({
      decision: "Use bcrypt",
      rationale: "Fast enough",
      author: "Override",
    } as never)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ author: "Override" }))
    expect(resolveAuthor).not.toHaveBeenCalled()
  })

  it("collapses to author: undefined when no override and resolver returns null", async () => {
    const { handler, create } = setUpCreateHarness(null)
    await handler({ decision: "Use bcrypt", rationale: "Fast enough" } as never)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ author: undefined }))
  })
})
