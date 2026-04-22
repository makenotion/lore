import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describe, expect, it, vi } from "vitest"
import { registerMemoryTools } from "./memory.js"
import type { Memory, Topic } from "../../types.js"

function makeMemory(id: string, overrides: Partial<Memory> = {}): Memory {
  return {
    id,
    title: `Memory ${id}`,
    projectIds: [],
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
    session: "",
    content: "",
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  }
}

function makeTopic(id: string, overrides: Partial<Topic> = {}): Topic {
  return {
    id,
    name: `Topic ${id}`,
    projectIds: [],
    description: "",
    ...overrides,
  }
}

function createMockServer() {
  const handlers = new Map<string, (...args: never[]) => Promise<unknown>>()
  const server = {
    registerTool: vi.fn(
      (name: string, _config: unknown, handler: (...args: never[]) => Promise<unknown>) => {
        handlers.set(name, handler)
      },
    ),
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

describe("lore-recall topicName resolution", () => {
  it("resolves topicName globally (not scoped to the ambient project) so multi-project topics work", async () => {
    const mockServer = createMockServer()
    const topic = makeTopic("topic-1", { name: "OAuth", projectIds: ["proj-a", "proj-b"] })
    const memory = makeMemory("mem-1", { title: "OAuth flow notes", topicId: "topic-1" })

    const findByName = vi.fn().mockResolvedValue(topic)
    const memoriesList = vi.fn().mockResolvedValue([memory])

    const services = {
      topics: { findByName },
      memories: { list: memoriesList },
      projects: { findByName: vi.fn() },
      // Ambient project is the "wrong" one for this topic — the scoped lookup
      // the old code did would have returned null and silently dropped the filter.
      context: { project: { id: "proj-other", name: "Other" } },
    }

    registerMemoryTools(mockServer.server, services as never)
    const recall = mockServer.getHandler("lore-recall")

    await recall({ topicName: "OAuth" } as never)

    // Global lookup — no projectId argument.
    expect(findByName).toHaveBeenCalledWith("OAuth")
    // topicId was passed through to the list call.
    expect(memoriesList).toHaveBeenCalledWith(
      expect.objectContaining({ topicId: "topic-1" }),
    )
  })

  it("returns an explicit error when topicName does not resolve (no silent fall-through)", async () => {
    const mockServer = createMockServer()
    const findByName = vi.fn().mockResolvedValue(null)
    const memoriesList = vi.fn().mockResolvedValue([
      makeMemory("unrelated", { title: "Unrelated recent memory" }),
    ])

    const services = {
      topics: { findByName },
      memories: { list: memoriesList },
      projects: { findByName: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    const recall = mockServer.getHandler("lore-recall")

    const result = await recall({ topicName: "NonExistent" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain('No topic named "NonExistent" found')
    // Crucial: we did NOT fall through to an unfiltered memories.list() call.
    expect(memoriesList).not.toHaveBeenCalled()
  })

  it("omits the topicId filter when topicName is not provided", async () => {
    const mockServer = createMockServer()
    const findByName = vi.fn()
    const memoriesList = vi.fn().mockResolvedValue([])

    const services = {
      topics: { findByName },
      memories: { list: memoriesList },
      projects: { findByName: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    const recall = mockServer.getHandler("lore-recall")

    await recall({} as never)

    expect(findByName).not.toHaveBeenCalled()
    expect(memoriesList).toHaveBeenCalledWith(
      expect.objectContaining({ topicId: undefined }),
    )
  })
})
