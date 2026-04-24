import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describe, expect, it, vi } from "vitest"
import { registerKnowledgeTools } from "./knowledge.js"
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

function makeFact(id: string, overrides: Partial<Fact> = {}): Fact {
  return {
    id,
    subject: "AuthService",
    predicate: "decided_by",
    object: "decision-id",
    projectIds: [],
    validFrom: "2026-04-20",
    validUntil: null,
    reviewBy: null,
    sourceMemoryId: "decision-id",
    confidence: "certain",
    ...overrides,
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

describe("lore-ask", () => {
  it("resolves superseded decision links to the current decision and hides duplicates", async () => {
    const mockServer = createMockServer()
    const oldDecision = makeDecision("old-id", {
      title: "Old decision",
      status: "superseded",
    })
    const newDecision = makeDecision("new-id", {
      title: "New decision",
      decidedAt: "2026-04-21",
    })

    const services = {
      projects: {
        findByName: vi.fn(),
      },
      facts: {
        queryByEntity: vi.fn().mockResolvedValue([
          makeFact("fact-old", {
            sourceMemoryId: "old-id",
            object: "Old decision",
          }),
          makeFact("fact-new", {
            sourceMemoryId: "new-id",
            object: "new-id",
          }),
        ]),
        queryByObject: vi.fn().mockImplementation(async (object: string) => {
          if (object === "Old decision") {
            return [
              makeFact("sup-legacy", {
                subject: "New decision",
                predicate: "supersedes_decision",
                object: "Old decision",
                sourceMemoryId: "new-id",
              }),
            ]
          }
          return []
        }),
      },
      decisions: {
        getById: vi.fn().mockImplementation(async (id: string) => {
          if (id === "old-id") return oldDecision
          if (id === "new-id") return newDecision
          throw new Error(`unknown decision ${id}`)
        }),
      },
      context: {
        project: null,
      },
    }

    registerKnowledgeTools(mockServer.server, services as never)
    const loreAsk = mockServer.getHandler("lore-ask")

    const result = await loreAsk({ entity: "AuthService" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain('1 facts about "AuthService"')
    expect(text).toContain("New decision")
    expect(text).not.toContain("Old decision")
  })
})

describe("lore-ask projectName resolution", () => {
  it("warns and falls back when projectName does not resolve", async () => {
    const mockServer = createMockServer()
    const queryByEntity = vi.fn().mockResolvedValue([])

    const services = {
      projects: { findByName: vi.fn().mockResolvedValue(null) },
      facts: {
        queryByEntity,
        queryByObject: vi.fn(),
      },
      decisions: { getById: vi.fn() },
      context: { project: { id: "proj-ambient", name: "Ambient" } },
    }

    registerKnowledgeTools(mockServer.server, services as never)
    const handler = mockServer.getHandler("lore-ask")

    const result = await handler({ entity: "AuthService", projectName: "Typo" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    // Warning emitted, not an error.
    expect(text).toContain('Project "Typo" not found')
    expect(text).toContain("Warnings:")
    // Fallback applied: query scoped to the ambient project.
    expect(queryByEntity).toHaveBeenCalledWith(
      "AuthService",
      expect.objectContaining({ projectId: "proj-ambient" }),
    )
  })
})

describe("lore-learn sourceMemoryId discipline", () => {
  function makeServices(overrides: Record<string, unknown> = {}) {
    return {
      projects: { findByName: vi.fn() },
      facts: {
        create: vi.fn().mockImplementation(async (input) =>
          makeFact("fact-created", {
            subject: input.subject,
            predicate: input.predicate,
            object: input.object,
            sourceMemoryId: input.sourceMemoryId ?? null,
          })
        ),
        createWithDedup: vi.fn().mockImplementation(async (input) => ({
          fact: makeFact("fact-created", {
            subject: input.subject,
            predicate: input.predicate,
            object: input.object,
            sourceMemoryId: input.sourceMemoryId ?? null,
          }),
          deduped: false,
          enriched: [],
        })),
        queryByEntity: vi.fn(),
        queryByObject: vi.fn(),
      },
      decisions: { getById: vi.fn() },
      context: { project: null },
      sessionMemories: {
        // Defaults — tests override per-case.
        record: vi.fn(),
        get: vi.fn().mockReturnValue(undefined),
      },
      ...overrides,
    }
  }

  it("soft-phases missing sourceMemoryId: creates the fact with a prominent warning", async () => {
    // The spec's soft-phase requirement: we do NOT hard-error when no source
    // is available, because that would break every deployed caller on day
    // one. Instead the fact is created and the response carries a loud
    // warning. Flip to hard error in a future minor.
    const mockServer = createMockServer()
    const services = makeServices()
    registerKnowledgeTools(mockServer.server, services as never)
    const loreLearn = mockServer.getHandler("lore-learn")

    const result = await loreLearn({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBeFalsy()
    expect(payload.content[0].text).toContain("WARNING")
    expect(payload.content[0].text).toContain("sourceMemoryId")
    // Fact IS created; we're warning, not refusing.
    expect(services.facts.createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMemoryId: undefined })
    )
  })

  it("creates the fact when sourceMemoryId is passed explicitly", async () => {
    const mockServer = createMockServer()
    const services = makeServices()
    registerKnowledgeTools(mockServer.server, services as never)
    const loreLearn = mockServer.getHandler("lore-learn")

    const result = await loreLearn({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      sourceMemoryId: "mem-explicit",
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBeFalsy()
    expect(payload.content[0].text).toContain("Source: mem-explicit")
    expect(payload.content[0].text).not.toContain("WARNING")
    expect(services.facts.createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMemoryId: "mem-explicit" })
    )
  })

  it("auto-links sourceMemoryId from the session tracker when the caller omits it", async () => {
    // Core P1-09 auto-link path: a `lore-learn` call that omits
    // sourceMemoryId picks up the memory saved earlier in the same
    // (agent, session). Tracker value includes project scope so the
    // downstream compatibility check gets real data.
    const mockServer = createMockServer()
    const services = makeServices({
      sessionMemories: {
        record: vi.fn(),
        get: vi.fn().mockImplementation((key: { agent?: string; session?: string }) => {
          if (key.agent === "claude" && key.session === "session-abc") {
            return { memoryId: "mem-from-session", projectIds: [] }
          }
          return undefined
        }),
      },
    })
    registerKnowledgeTools(mockServer.server, services as never)
    const loreLearn = mockServer.getHandler("lore-learn")

    const result = await loreLearn({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      session: "session-abc",
      agent: "claude",
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBeFalsy()
    expect(payload.content[0].text).toContain("auto-linked from session")
    expect(payload.content[0].text).toContain("mem-from-session")
    expect(services.facts.createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMemoryId: "mem-from-session" })
    )
  })

  it("prefers the explicitly-passed sourceMemoryId over the session candidate", async () => {
    const mockServer = createMockServer()
    const services = makeServices({
      sessionMemories: {
        record: vi.fn(),
        get: vi
          .fn()
          .mockReturnValue({ memoryId: "mem-from-session", projectIds: [] }),
      },
    })
    registerKnowledgeTools(mockServer.server, services as never)
    const loreLearn = mockServer.getHandler("lore-learn")

    await loreLearn({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      session: "session-abc",
      agent: "claude",
      sourceMemoryId: "mem-explicit",
    } as never)

    expect(services.facts.createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMemoryId: "mem-explicit" })
    )
  })

  it("declines auto-link when session memory's project is disjoint from the fact's project", async () => {
    // Reviewer blocker #2: an iOS-scoped memory must not silently become the
    // source for a server-scoped fact. The memory and the fact are both
    // scoped; their project sets do not intersect; decline and warn.
    const mockServer = createMockServer()
    const projectsFindByName = vi.fn().mockImplementation(async (name: string) => {
      if (name === "server") return { id: "proj-server", name: "server" }
      return null
    })
    const services = makeServices({
      projects: { findByName: projectsFindByName },
      sessionMemories: {
        record: vi.fn(),
        get: vi
          .fn()
          .mockReturnValue({ memoryId: "mem-ios", projectIds: ["proj-ios"] }),
      },
    })
    registerKnowledgeTools(mockServer.server, services as never)
    const loreLearn = mockServer.getHandler("lore-learn")

    const result = await loreLearn({
      subject: "EventQueue",
      predicate: "uses",
      object: "RMQ",
      projectName: "server",
      session: "s1",
      agent: "claude",
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBeFalsy()
    // Auto-link refused — fact is created without a Source and with both
    // the soft-phase warning AND the decline reason in the warnings line.
    expect(payload.content[0].text).toContain("Declined auto-link")
    expect(payload.content[0].text).toContain("different project")
    expect(payload.content[0].text).toContain("WARNING")
    expect(services.facts.createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMemoryId: undefined })
    )
  })

  it("accepts auto-link when fact has no project scope (vault-wide fact)", async () => {
    // A vault-wide fact can legitimately accept any scoped memory as source.
    // This is the symmetric case to the previous test.
    const mockServer = createMockServer()
    const services = makeServices({
      sessionMemories: {
        record: vi.fn(),
        get: vi
          .fn()
          .mockReturnValue({ memoryId: "mem-ios", projectIds: ["proj-ios"] }),
      },
    })
    registerKnowledgeTools(mockServer.server, services as never)
    const loreLearn = mockServer.getHandler("lore-learn")

    const result = await loreLearn({
      subject: "Framework",
      predicate: "is_a",
      object: "JS lib",
      session: "s1",
      agent: "claude",
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.content[0].text).toContain("auto-linked from session")
    expect(services.facts.createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMemoryId: "mem-ios" })
    )
  })

  it("accepts auto-link when session memory has no project scope (vault-wide memory)", async () => {
    // A vault-wide memory can support a scoped fact — symmetric case.
    const mockServer = createMockServer()
    const services = makeServices({
      projects: {
        findByName: vi.fn().mockResolvedValue({ id: "proj-server", name: "server" }),
      },
      sessionMemories: {
        record: vi.fn(),
        get: vi
          .fn()
          .mockReturnValue({ memoryId: "mem-global", projectIds: [] }),
      },
    })
    registerKnowledgeTools(mockServer.server, services as never)
    const loreLearn = mockServer.getHandler("lore-learn")

    const result = await loreLearn({
      subject: "EventQueue",
      predicate: "uses",
      object: "RMQ",
      projectName: "server",
      session: "s1",
      agent: "claude",
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.content[0].text).toContain("auto-linked from session")
    expect(services.facts.createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMemoryId: "mem-global" })
    )
  })

  it("soft-phase warning (no hard error) when session is present but the tracker has no entry", async () => {
    const mockServer = createMockServer()
    const services = makeServices({
      sessionMemories: {
        record: vi.fn(),
        get: vi.fn().mockReturnValue(undefined),
      },
    })
    registerKnowledgeTools(mockServer.server, services as never)
    const loreLearn = mockServer.getHandler("lore-learn")

    const result = await loreLearn({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      session: "session-without-memory",
      agent: "claude",
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBeFalsy()
    expect(payload.content[0].text).toContain("WARNING")
    expect(services.facts.createWithDedup).toHaveBeenCalled()
  })
})

describe("lore-audit projectName resolution", () => {
  it("returns an explicit error when projectName does not resolve", async () => {
    // lore-audit surfaces destructive follow-up actions (mark reviewed,
    // supersede) — silent fallback would let the caller act on the wrong
    // project's overdue queue.
    const mockServer = createMockServer()
    const queryOverdueFacts = vi.fn()
    const queryOverdueDecisions = vi.fn()

    const services = {
      projects: { findByName: vi.fn().mockResolvedValue(null) },
      facts: { queryOverdue: queryOverdueFacts },
      decisions: { queryOverdue: queryOverdueDecisions },
      context: { project: { id: "proj-ambient", name: "Ambient" } },
    }

    registerKnowledgeTools(mockServer.server, services as never)
    const handler = mockServer.getHandler("lore-audit")

    const result = await handler({ projectName: "Typo" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain('Project "Typo" not found')
    expect(queryOverdueFacts).not.toHaveBeenCalled()
    expect(queryOverdueDecisions).not.toHaveBeenCalled()
  })
})
