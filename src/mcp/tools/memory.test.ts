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
    keywords: "",
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

describe("lore-remember session recording", () => {
  it("records the created memory with project scope into sessionMemories", async () => {
    // Integration point for P1-09 auto-link: lore-learn reads back the
    // {memoryId, projectIds} entry. Project scope is what drives the
    // cross-project safety check on auto-link.
    const mockServer = createMockServer()
    const created = makeMemory("mem-just-saved", {
      title: "Saved",
      projectIds: ["proj-a"],
    })
    const record = vi.fn()

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create: vi.fn().mockResolvedValue(created) },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record, get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getHandler("lore-remember")

    await remember({
      title: "Saved",
      content: "body",
      session: "session-xyz",
      agent: "claude-code",
    } as never)

    expect(record).toHaveBeenCalledWith(
      { agent: "claude-code", session: "session-xyz" },
      { memoryId: "mem-just-saved", projectIds: ["proj-a"] }
    )
  })

  it("still calls record when session is omitted — tracker handles the empty-session guard", async () => {
    // The tracker drops empty sessions itself; the tool should always call
    // `record` so the contract is uniform and the tracker's guards are the
    // single source of truth.
    const mockServer = createMockServer()
    const created = makeMemory("mem-no-session")
    const record = vi.fn()

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create: vi.fn().mockResolvedValue(created) },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record, get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getHandler("lore-remember")

    await remember({ title: "No session", content: "body" } as never)

    expect(record).toHaveBeenCalledWith(
      { agent: undefined, session: undefined },
      { memoryId: "mem-no-session", projectIds: [] }
    )
  })
})

describe("lore-recall topicName resolution", () => {
  it("resolves topicName globally (not scoped to the ambient project) so multi-project topics work", async () => {
    const mockServer = createMockServer()
    const topic = makeTopic("topic-1", { name: "OAuth", projectIds: ["proj-a", "proj-b"] })
    const memory = makeMemory("mem-1", { title: "OAuth flow notes", topicId: "topic-1" })

    const findByName = vi.fn().mockResolvedValue(topic)
    const memoriesList = vi.fn().mockResolvedValue({ items: [memory] })

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
    const memoriesList = vi.fn().mockResolvedValue({
      items: [makeMemory("unrelated", { title: "Unrelated recent memory" })],
    })

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
    const memoriesList = vi.fn().mockResolvedValue({ items: [] })

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

describe("lore-recall projectName resolution", () => {
  it("returns an explicit error when projectName does not resolve (no silent fall-through)", async () => {
    const mockServer = createMockServer()
    const projectsFindByName = vi.fn().mockResolvedValue(null)
    const topicsFindByName = vi.fn()
    const memoriesList = vi.fn()

    const services = {
      projects: { findByName: projectsFindByName },
      topics: { findByName: topicsFindByName },
      memories: { list: memoriesList },
      // Ambient project is set — the old code would have left projectId undefined
      // and then skipped the else-if, running an unscoped query.
      context: { project: { id: "proj-ambient", name: "Ambient" } },
    }

    registerMemoryTools(mockServer.server, services as never)
    const recall = mockServer.getHandler("lore-recall")

    const result = await recall({ projectName: "Typo" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain('Project "Typo" not found')
    expect(memoriesList).not.toHaveBeenCalled()
  })

  it("project error wins when both projectName and topicName are passed and project is invalid", async () => {
    const mockServer = createMockServer()
    const projectsFindByName = vi.fn().mockResolvedValue(null)
    const topicsFindByName = vi.fn()
    const memoriesList = vi.fn()

    const services = {
      projects: { findByName: projectsFindByName },
      topics: { findByName: topicsFindByName },
      memories: { list: memoriesList },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    const recall = mockServer.getHandler("lore-recall")

    const result = await recall({
      projectName: "Typo",
      topicName: "SomeTopic",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain('Project "Typo" not found')
    // Short-circuit on project miss — topic lookup must not run, nor the list query.
    expect(topicsFindByName).not.toHaveBeenCalled()
    expect(memoriesList).not.toHaveBeenCalled()
  })
})

describe("lore-recall cursor pagination", () => {
  it("appends a fenced json `nextCursor` footer when the service reports more pages", async () => {
    const mockServer = createMockServer()
    const memory = makeMemory("mem-1", { title: "first page" })
    const memoriesList = vi.fn().mockResolvedValue({
      items: [memory],
      nextCursor: "resume-here",
    })

    const services = {
      topics: { findByName: vi.fn() },
      memories: { list: memoriesList },
      projects: { findByName: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    const recall = mockServer.getHandler("lore-recall")

    const result = await recall({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    // Fenced json block — unambiguously parseable even when item bodies contain JSON-like syntax.
    expect(text).toMatch(/```json\n\{"nextCursor":"resume-here"\}\n```/)
  })

  it("omits the footer entirely when the service returns no nextCursor", async () => {
    const mockServer = createMockServer()
    const memory = makeMemory("mem-1", { title: "only page" })
    const memoriesList = vi.fn().mockResolvedValue({ items: [memory] })

    const services = {
      topics: { findByName: vi.fn() },
      memories: { list: memoriesList },
      projects: { findByName: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    const recall = mockServer.getHandler("lore-recall")

    const result = await recall({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).not.toContain("nextCursor")
    expect(text).not.toContain("```json")
  })

  it("forwards startCursor through to the service list call", async () => {
    const mockServer = createMockServer()
    const memoriesList = vi.fn().mockResolvedValue({ items: [] })

    const services = {
      topics: { findByName: vi.fn() },
      memories: { list: memoriesList },
      projects: { findByName: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    const recall = mockServer.getHandler("lore-recall")

    await recall({ startCursor: "resume-here" } as never)

    expect(memoriesList).toHaveBeenCalledWith(
      expect.objectContaining({ startCursor: "resume-here" }),
    )
  })

  it("surfaces nextCursor when a page is empty but more results remain", async () => {
    // Server-side filters can yield an empty page mid-enumeration. The cursor
    // MUST still surface — otherwise an agent following "page until footer
    // disappears" terminates prematurely.
    const mockServer = createMockServer()
    const memoriesList = vi.fn().mockResolvedValue({
      items: [],
      nextCursor: "keep-paging",
    })

    const services = {
      topics: { findByName: vi.fn() },
      memories: { list: memoriesList },
      projects: { findByName: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    const recall = mockServer.getHandler("lore-recall")

    const result = await recall({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("No matching memories on this page.")
    expect(text).toMatch(/```json\n\{"nextCursor":"keep-paging"\}\n```/)
  })
})

describe("lore-search projectName resolution", () => {
  it("warns and falls back to auto-detected project when projectName does not resolve", async () => {
    const mockServer = createMockServer()
    const projectsFindByName = vi.fn().mockResolvedValue(null)
    const memoriesSearch = vi
      .fn()
      .mockResolvedValue([makeMemory("mem-1", { title: "A result" })])

    const services = {
      projects: { findByName: projectsFindByName },
      topics: { findByName: vi.fn() },
      memories: { search: memoriesSearch, list: vi.fn() },
      context: { project: { id: "proj-ambient", name: "Ambient" } },
    }

    registerMemoryTools(mockServer.server, services as never)
    const search = mockServer.getHandler("lore-search")

    const result = await search({ query: "anything", projectName: "Typo" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    // Warning emitted, not an error.
    expect(text).toContain('Project "Typo" not found')
    expect(text).toContain("Warnings:")
    // Fallback applied: search scoped to the ambient project.
    expect(memoriesSearch).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-ambient" }),
    )
  })
})

describe("lore-recall content-off default", () => {
  // The default `includeContent: false` keeps the hot path at one Notion
  // round-trip per page. Eager bodies are opt-in because agents almost
  // always triage titles first and expand one or two rows.
  it("passes includeContent: false to the service by default", async () => {
    const mockServer = createMockServer()
    const memoriesList = vi.fn().mockResolvedValue({
      items: [makeMemory("mem-1", { title: "A row", content: "" })],
    })

    const services = {
      topics: { findByName: vi.fn() },
      memories: { list: memoriesList },
      projects: { findByName: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    const recall = mockServer.getHandler("lore-recall")

    await recall({ limit: 10 } as never)

    expect(memoriesList).toHaveBeenCalledWith(
      expect.objectContaining({ includeContent: false, limit: 10 }),
    )
  })

  it("omits bodies and the placeholder on the default path, and points callers at includeContent: true", async () => {
    const mockServer = createMockServer()
    const memoriesList = vi.fn().mockResolvedValue({
      items: [
        makeMemory("mem-1", { title: "Row A", content: "" }),
        makeMemory("mem-2", { title: "Row B", content: "" }),
      ],
    })

    const services = {
      topics: { findByName: vi.fn() },
      memories: { list: memoriesList },
      projects: { findByName: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    const recall = mockServer.getHandler("lore-recall")

    const result = await recall({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).not.toContain("(content not loaded)")
    expect(text).toContain("### Row A")
    expect(text).toContain("### Row B")
    expect(text).toContain("includeContent: true")
  })

  it("forwards includeContent: true through to the service when opted in", async () => {
    const mockServer = createMockServer()
    const memoriesList = vi.fn().mockResolvedValue({
      items: [makeMemory("mem-1", { title: "With body", content: "Hello body." })],
    })

    const services = {
      topics: { findByName: vi.fn() },
      memories: { list: memoriesList },
      projects: { findByName: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    const recall = mockServer.getHandler("lore-recall")

    const result = await recall({ includeContent: true } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(memoriesList).toHaveBeenCalledWith(
      expect.objectContaining({ includeContent: true }),
    )
    expect(text).toContain("Hello body.")
    expect(text).not.toContain("Bodies omitted")
  })
})

describe("lore-recall tag rendering", () => {
  // Post-P1-01, each row is title + meta only — tags are load-bearing for
  // triage and must surface in the meta line. Mirrors lore-search's shape so
  // agents parse one pattern across both tools.
  it("renders tags in the meta line for a tagged memory", async () => {
    const mockServer = createMockServer()
    const memoriesList = vi.fn().mockResolvedValue({
      items: [
        makeMemory("mem-1", {
          title: "OAuth flow notes",
          tags: ["oauth", "auth"],
        }),
      ],
    })

    const services = {
      topics: { findByName: vi.fn() },
      memories: { list: memoriesList },
      projects: { findByName: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    const recall = mockServer.getHandler("lore-recall")

    const result = await recall({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("oauth, auth")
    // Tags sit between status and date in the meta pipe chain.
    expect(text).toMatch(/\*manual \| oauth, auth \| 2026-04-20\*/)
  })

  it("omits the tag slot entirely for an untagged memory (no empty slot, no trailing pipe)", async () => {
    const mockServer = createMockServer()
    const memoriesList = vi.fn().mockResolvedValue({
      items: [makeMemory("mem-1", { title: "Untagged note", tags: [] })],
    })

    const services = {
      topics: { findByName: vi.fn() },
      memories: { list: memoriesList },
      projects: { findByName: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    const recall = mockServer.getHandler("lore-recall")

    const result = await recall({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    // No empty slot between source and date, and no trailing pipe before the date.
    expect(text).toMatch(/\*manual \| 2026-04-20\*/)
    expect(text).not.toMatch(/\|\s*\|/)
    expect(text).not.toMatch(/\|\s*\*/)
  })

  it("emits identical meta ordering to lore-search for the same memory", async () => {
    // Symmetry guard: if someone re-orders one renderer and not the other,
    // this test fails. The meta contract is shared across the two tools.
    const tagged = makeMemory("mem-1", {
      title: "Shared shape",
      source: "manual",
      kind: "decision",
      status: "accepted",
      tags: ["oauth", "auth"],
      updatedAt: "2026-04-20T00:00:00.000Z",
    })

    const recallServer = createMockServer()
    registerMemoryTools(recallServer.server, {
      topics: { findByName: vi.fn() },
      memories: { list: vi.fn().mockResolvedValue({ items: [tagged] }) },
      projects: { findByName: vi.fn() },
      context: { project: null },
    } as never)
    const recall = recallServer.getHandler("lore-recall")

    const searchServer = createMockServer()
    registerMemoryTools(searchServer.server, {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: {
        search: vi.fn().mockResolvedValue([tagged]),
        list: vi.fn(),
      },
      context: { project: null },
    } as never)
    const search = searchServer.getHandler("lore-search")

    const recallResult = await recall({} as never)
    const searchResult = await search({ query: "anything" } as never)

    const recallText = (recallResult as { content: Array<{ text: string }> }).content[0].text
    const searchText = (searchResult as { content: Array<{ text: string }> }).content[0].text

    // Extract the italicized meta line from each. Both renderers wrap meta in *…*.
    const metaPattern = /\*([^*]+)\*/
    const recallMeta = recallText.match(metaPattern)?.[1]
    const searchMeta = searchText.match(metaPattern)?.[1]

    expect(recallMeta).toBe("manual | decision | accepted | oauth, auth | 2026-04-20")
    expect(searchMeta).toBe(recallMeta)
  })
})

describe("lore-search content-off default", () => {
  it("passes includeContent: false to the service by default", async () => {
    const mockServer = createMockServer()
    const memoriesSearch = vi
      .fn()
      .mockResolvedValue([makeMemory("mem-1", { title: "Hit", content: "" })])

    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { search: memoriesSearch, list: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    const search = mockServer.getHandler("lore-search")

    await search({ query: "anything" } as never)

    expect(memoriesSearch).toHaveBeenCalledWith(
      expect.objectContaining({ includeContent: false }),
    )
  })

  it("omits bodies and the placeholder, and surfaces a re-call hint, when includeContent is not set", async () => {
    const mockServer = createMockServer()
    const memoriesSearch = vi
      .fn()
      .mockResolvedValue([makeMemory("mem-1", { title: "A hit", content: "" })])

    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { search: memoriesSearch, list: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    const search = mockServer.getHandler("lore-search")

    const result = await search({ query: "anything" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).not.toContain("(content not loaded)")
    expect(text).toContain("### A hit")
    expect(text).toContain("includeContent: true")
  })

  it("forwards includeContent: true and renders bodies when opted in", async () => {
    const mockServer = createMockServer()
    const memoriesSearch = vi.fn().mockResolvedValue([
      makeMemory("mem-1", { title: "Eager hit", content: "Full body text." }),
    ])

    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { search: memoriesSearch, list: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    const search = mockServer.getHandler("lore-search")

    const result = await search({ query: "anything", includeContent: true } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(memoriesSearch).toHaveBeenCalledWith(
      expect.objectContaining({ includeContent: true }),
    )
    expect(text).toContain("Full body text.")
    expect(text).not.toContain("Bodies omitted")
  })
})
