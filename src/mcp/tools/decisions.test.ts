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
    doneAt: null,
    decidedAt: "2026-04-20",
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
    subjectEntityId: null,
    objectEntityId: null,
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
    /**
     * Wrap a polymorphic dispatcher in a one-action shim so individual
     * tests can call it with action-specific args alone. The dispatcher's
     * discriminated union still validates the per-action schema.
     */
    getActionHandler(toolName: string, action: string) {
      const handler = handlers.get(toolName)
      if (!handler) throw new Error(`missing handler ${toolName}`)
      return (args: Record<string, unknown>) =>
        handler({ ...args, action } as never)
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

    expect(text).toContain('Project "Typo" not found')
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

    expect(text).toContain('Project "Typo" not found')
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
        "[lore] partial-failure: root=bad-root error=notion 5xx tool=lore-decision\n",
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
    skipEntities?: boolean
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
          opts.facts ??
            [
              {
                ...makeFact("fact-1"),
                sourceMemoryId: decision.id,
                object: decision.id,
              },
            ],
        ),
        queryByObject: vi.fn().mockResolvedValue([]),
      },
      topics: {},
      context: { project: { id: "proj-a", name: "Ambient" } },
      entities: opts.skipEntities
        ? null
        : {
            resolveOrCreateEntity: vi.fn().mockImplementation(async () => ({
              entity: opts.entityResolution?.entity ?? null,
              ambiguous: opts.entityResolution?.ambiguous ?? false,
              candidates:
                opts.entityResolution?.candidates ??
                (opts.entityResolution?.entity
                  ? [opts.entityResolution.entity]
                  : []),
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

    expect(services.entities!.resolveOrCreateEntity).toHaveBeenCalledWith(
      "AuthSvc",
      expect.objectContaining({ autoCreate: false }),
    )
    expect(services.facts.queryByEntity).toHaveBeenCalledWith(
      "AuthSvc",
      expect.objectContaining({
        projectId: "proj-a",
        entityId: "ent-auth",
        predicates: ["decided_by"],
      }),
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
      }),
    )
    const opts = (services.facts.queryByEntity as ReturnType<typeof vi.fn>)
      .mock.calls[0][1]
    expect(opts.entityId).toBeUndefined()
  })

  it("legacy vault path (services.entities === null) skips resolver and queries by raw entity", async () => {
    // Pre-PF3-01 vault: queryByEntity's entityId-null branch falls through
    // to queryBySubject ∪ queryByObject. The tool must still pass
    // predicates: ['decided_by'] so the union is server-side narrowed.
    const mockServer = createMockServer()
    const services = makeServicesWithEntities({ skipEntities: true })
    registerDecisionTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-decision", "context")

    await handler({ entity: "AuthService" } as never)

    expect(services.facts.queryByEntity).toHaveBeenCalledWith(
      "AuthService",
      expect.objectContaining({
        projectId: "proj-a",
        predicates: ["decided_by"],
      }),
    )
    const opts = (services.facts.queryByEntity as ReturnType<typeof vi.fn>)
      .mock.calls[0][1]
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
    services.entities!.resolveOrCreateEntity = vi
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
      }),
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
