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
