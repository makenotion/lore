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
  it("surfaces a warning when one decision root's walk rejects", async () => {
    // Tool-layer acceptance for PF1-02: the `settleAll` wrapper inside
    // resolveCanonicalDecisionLinks produces `failures`, and the tool
    // handler routes them through the same `formatWarnings` shape
    // `lore-ask` uses. This pins end-to-end behaviour that decision-graph
    // unit tests cannot.
    const mockServer = createMockServer()
    const goodDecision = makeDecision("good-id", { title: "Working decision" })
    const services = {
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
})
