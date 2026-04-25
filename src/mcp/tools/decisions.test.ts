import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describe, expect, it, vi } from "vitest"
import { registerDecisionTools } from "./decisions.js"
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
    reviewBy: null,
    decidedAt: "2026-04-20",
    supersedesIds: [],
    affectsIds: [],
    alternatives: "",
    consequences: "",
    author: "",
    agent: "",
    tags: [],
    keywords: "",
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
  }
}

function createMockServer() {
  const handlers = new Map<string, (...args: never[]) => Promise<unknown>>()
  const server = {
    registerTool: vi.fn((name: string, _config: unknown, handler: (...args: never[]) => Promise<unknown>) => {
      handlers.set(name, handler)
    }),
  } as unknown as McpServer

  return {
    server,
    getHandler(name: string) {
      const handler = handlers.get(name)
      if (!handler) throw new Error(`missing handler ${name}`)
      return handler
    },
  }
}

describe("registerDecisionTools", () => {
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
    }

    registerDecisionTools(mockServer.server, services as never)
    const loreDecide = mockServer.getHandler("lore-decide")

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
    }

    registerDecisionTools(mockServer.server, services as never)
    const loreDecide = mockServer.getHandler("lore-decide")

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
    expect(text).toContain("action: \"supersede\"")
    expect(text).toContain('newDecisionId: "dec-new"')
    expect(text).toContain('oldDecisionId: "dec-old"')

    // The probe scoped to project + topic + Kind=decision.
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-a",
        topicId: undefined,
        kind: "decision",
        includeContent: false,
      }),
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
    }

    registerDecisionTools(mockServer.server, services as never)
    const loreDecide = mockServer.getHandler("lore-decide")

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
    }

    registerDecisionTools(mockServer.server, services as never)
    const loreDecide = mockServer.getHandler("lore-decide")

    await loreDecide({
      decision: "Replace auth middleware",
      rationale: "Because reasons",
      topicName: "Auth",
    } as never)

    expect(getOrCreate).toHaveBeenCalledWith("Auth", ["proj-a"])
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-a",
        topicId: "topic-1",
        kind: "decision",
      }),
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
    }

    registerDecisionTools(mockServer.server, services as never)
    const loreDecide = mockServer.getHandler("lore-decide")

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
    }

    registerDecisionTools(mockServer.server, services as never)
    const loreDecide = mockServer.getHandler("lore-decide")

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
    const handler = mockServer.getHandler("lore-list-decisions")

    const result = await handler({ projectName: "Typo" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain('Project "Typo" not found')
    expect(decisionsList).not.toHaveBeenCalled()
  })
})

describe("lore-decision-context projectName resolution", () => {
  it("returns an explicit error when projectName does not resolve", async () => {
    const mockServer = createMockServer()
    const queryBySubject = vi.fn()
    const services = {
      decisions: {},
      projects: { findByName: vi.fn().mockResolvedValue(null) },
      facts: { queryBySubject },
      topics: {},
      context: { project: { id: "proj-ambient", name: "Ambient" } },
    }

    registerDecisionTools(mockServer.server, services as never)
    const handler = mockServer.getHandler("lore-decision-context")

    const result = await handler({ entity: "AuthService", projectName: "Typo" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain('Project "Typo" not found')
    expect(queryBySubject).not.toHaveBeenCalled()
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
        queryBySubject: vi.fn().mockResolvedValue([
          { ...makeFact("fact-ok"), sourceMemoryId: "good-id", object: "good-id" },
          { ...makeFact("fact-bad"), sourceMemoryId: "bad-root", object: "bad-root" },
        ]),
        queryByObject: vi.fn().mockImplementation(async (object: string) => {
          if (object === "bad-root") throw new Error("notion 5xx")
          return []
        }),
      },
      topics: {},
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
    const handler = mockServer.getHandler("lore-decision-context")

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
    const handler = mockServer.getHandler("lore-decision-context")
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    vi.stubEnv("LORE_DEBUG", "1")

    try {
      await handler({ entity: "AuthService" } as never)

      expect(stderr).toHaveBeenCalledTimes(1)
      const logged = String(stderr.mock.calls[0][0])
      // Same exact-format pin as `lore-ask`: ensures both tools emit the
      // identical canonical line so ops filters work uniformly. A field
      // reorder in one call site without the other would break
      // cross-tool correlation silently; pinning the full line here
      // catches the drift.
      expect(logged).toBe(
        "[lore] partial-failure: root=bad-root error=notion 5xx tool=lore-decision-context\n",
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
    const handler = mockServer.getHandler("lore-decision-context")
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
