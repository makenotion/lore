import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
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
    taskState: null,
    blockedBy: "",
    entity: "",
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
  const configs = new Map<string, { inputSchema?: Record<string, z.ZodTypeAny> }>()
  const server = {
    registerTool: vi.fn(
      (
        name: string,
        config: { inputSchema?: Record<string, z.ZodTypeAny> },
        handler: (...args: never[]) => Promise<unknown>,
      ) => {
        configs.set(name, config)
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
    getInputSchema(name: string): z.ZodObject<z.ZodRawShape> {
      const config = configs.get(name)
      if (!config?.inputSchema) throw new Error(`missing inputSchema for ${name}`)
      return z.object(config.inputSchema)
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

describe("lore-remember near-duplicate probe", () => {
  it("surfaces candidates whose title trigram similarity meets the 0.7 threshold", async () => {
    // The probe scans the recent memories in the same project + top-2
    // tags, flags any that look similar to the title being saved, and
    // surfaces them in the response footer. Save still succeeds.
    const mockServer = createMockServer()
    const created = makeMemory("mem-new", {
      title: "Wakeup hook swallows errors silently",
      projectIds: ["proj-a"],
      tags: ["architecture"],
    })
    const existing = makeMemory("mem-old", {
      title: "Wakeup hook swallows errors silently",
      projectIds: ["proj-a"],
      tags: ["architecture"],
    })

    const list = vi.fn().mockResolvedValue({ items: [existing] })
    const services = {
      projects: { findByName: vi.fn().mockResolvedValue({ id: "proj-a", name: "a" }) },
      topics: { getOrCreate: vi.fn() },
      memories: { create: vi.fn().mockResolvedValue(created), list },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getHandler("lore-remember")

    const result = await remember({
      title: "Wakeup hook swallows errors silently",
      content: "body",
      tags: ["architecture"],
    } as never)

    const text = (result as { content: Array<{ text: string }> }).content[0].text

    // Save succeeded; probe surfaced the candidate.
    expect(text).toContain('Saved memory: "Wakeup hook swallows errors silently"')
    expect(text).toContain("Warning:")
    expect(text).toContain("existing memory looks similar")
    expect(text).toContain("mem-old")
    // Post-P3-01 the recommendation points at the polymorphic tool, with
    // the legacy `lore-update` flow surfaced via `action: 'update'`.
    expect(text).toContain("lore-memory")
    expect(text).toContain("action: 'update'")
    // Probe scoped to project + top-2 tags — crucially, NOT narrowed by
    // kind. The spec's motivating duplicate chain spans note/note/agent_diary
    // and a kind filter would mask it.
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-a",
        tags: ["architecture"],
        includeContent: false,
      }),
    )
    // `kind` may be present as `undefined` but must not be set to a value —
    // a value would translate to a `Kind=equals` filter at the Notion layer.
    expect(list.mock.calls[0][0].kind).toBeUndefined()
  })

  it("does not narrow the probe by kind even when the caller passes kind=runbook", async () => {
    // Regression test against the earlier implementation that forwarded
    // `kind` to `memories.list()`. Passing `kind: "runbook"` on
    // `lore-remember` should still surface near-identical notes — the
    // spec is "same project + top-2 tags", full stop.
    const mockServer = createMockServer()
    const created = makeMemory("mem-new", {
      title: "Wakeup hook swallows errors silently",
      projectIds: ["proj-a"],
      kind: "runbook",
    })
    const list = vi.fn().mockResolvedValue({
      items: [
        makeMemory("mem-note", {
          title: "Wakeup hook swallows errors silently",
          projectIds: ["proj-a"],
          kind: "note",
        }),
      ],
    })
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create: vi.fn().mockResolvedValue(created), list },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getHandler("lore-remember")

    const result = await remember({
      title: "Wakeup hook swallows errors silently",
      content: "body",
      kind: "runbook",
    } as never)

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("mem-note")
    // list was called without a kind filter — the note surfaced despite the
    // caller writing a runbook.
    // `kind` may be present as `undefined` but must not be set to a value —
    // a value would translate to a `Kind=equals` filter at the Notion layer.
    expect(list.mock.calls[0][0].kind).toBeUndefined()
  })

  it("drops Kind=decision rows from the memory probe (decisions are lore-decide's domain)", async () => {
    // A note titled identically to a governing decision shouldn't light
    // up that decision as a near-dup candidate — decisions surface via
    // `lore-decide`, not `lore-update`.
    const mockServer = createMockServer()
    const created = makeMemory("mem-new", {
      title: "Replace auth middleware",
      projectIds: ["proj-a"],
    })

    const list = vi.fn().mockResolvedValue({
      items: [
        // A decision with the same title exists in the pool — must NOT surface.
        makeMemory("dec-in-pool", {
          title: "Replace auth middleware",
          projectIds: ["proj-a"],
          kind: "decision",
          status: "accepted",
        }),
        makeMemory("note-in-pool", {
          title: "Replace auth middleware",
          projectIds: ["proj-a"],
          kind: "note",
        }),
      ],
    })
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create: vi.fn().mockResolvedValue(created), list },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getHandler("lore-remember")

    const result = await remember({
      title: "Replace auth middleware",
      content: "body",
    } as never)

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    // Note surfaces; decision does not.
    expect(text).toContain("note-in-pool")
    expect(text).not.toContain("dec-in-pool")
  })

  it("produces no warning footer when no existing memory clears the threshold", async () => {
    const mockServer = createMockServer()
    const created = makeMemory("mem-new", {
      title: "Wakeup hook swallows errors silently",
      projectIds: ["proj-a"],
    })

    const list = vi.fn().mockResolvedValue({
      items: [
        makeMemory("mem-other", {
          title: "Completely unrelated memory about migrations",
          projectIds: ["proj-a"],
        }),
      ],
    })
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create: vi.fn().mockResolvedValue(created), list },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getHandler("lore-remember")

    const result = await remember({
      title: "Wakeup hook swallows errors silently",
      content: "body",
    } as never)

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("Saved memory:")
    expect(text).not.toContain("Warning:")
    expect(text).not.toContain("look similar")
    expect(text).not.toContain("looks similar")
  })

  it("skips the probe query when no project context is available", async () => {
    // The probe is bounded by a project filter — without one, we'd scan
    // the entire Memories DB, busting the per-save cost budget. The
    // probe short-circuits instead.
    const mockServer = createMockServer()
    const created = makeMemory("mem-new", {
      title: "Vault-wide note",
      projectIds: [],
    })

    const list = vi.fn()
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create: vi.fn().mockResolvedValue(created), list },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getHandler("lore-remember")

    await remember({ title: "Vault-wide note", content: "body" } as never)

    expect(list).not.toHaveBeenCalled()
  })

  it("filters out the just-created row if the probe surfaces it (parallel-race safety)", async () => {
    // Notion's query index is eventually consistent, but under tight
    // races the probe could observe the newly-written row. The tool
    // drops matches whose id equals the created memory's id so the
    // response doesn't warn the caller about their own fresh write.
    const mockServer = createMockServer()
    const created = makeMemory("mem-new", {
      title: "Same title",
      projectIds: ["proj-a"],
    })

    const list = vi.fn().mockResolvedValue({
      items: [
        // The probe returns the just-created row (race with create).
        makeMemory("mem-new", { title: "Same title", projectIds: ["proj-a"] }),
      ],
    })
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create: vi.fn().mockResolvedValue(created), list },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getHandler("lore-remember")

    const result = await remember({ title: "Same title", content: "body" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).not.toContain("Warning:")
  })

  it("save still succeeds when the probe query fails (probe is advisory)", async () => {
    const mockServer = createMockServer()
    const created = makeMemory("mem-new", {
      title: "Some title",
      projectIds: ["proj-a"],
    })

    const list = vi.fn().mockRejectedValue(new Error("notion 503"))
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create: vi.fn().mockResolvedValue(created), list },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getHandler("lore-remember")

    const result = await remember({ title: "Some title", content: "body" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("Saved memory:")
    expect(text).not.toContain("Warning:")
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

describe("lore-search mode parameter", () => {
  it("defaults mode to hybrid and forwards it to the service", async () => {
    // P3-04: The new default. Hybrid runs contains first and only falls
    // back to semantic when contains under-shoots. The MCP layer threads
    // the mode through so the service can switch on it.
    const mockServer = createMockServer()
    const memoriesSearch = vi
      .fn()
      .mockResolvedValue([makeMemory("mem-1", { title: "ok" })])

    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { search: memoriesSearch, list: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    const search = mockServer.getHandler("lore-search")

    await search({ query: "q" } as never)

    expect(memoriesSearch).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "hybrid" }),
    )
  })

  it("threads mode: contains through to the service and forwards kind/status as server-side filters", async () => {
    // Acceptance criterion: contains mode applies kind/status server-side.
    // The MCP tool forwards them rather than swallowing them at the
    // boundary.
    const mockServer = createMockServer()
    const memoriesSearch = vi.fn().mockResolvedValue([])

    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { search: memoriesSearch, list: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    const search = mockServer.getHandler("lore-search")

    await search({
      query: "PR-25650",
      mode: "contains",
      kind: "decision",
      status: "accepted",
      tags: ["architecture"],
    } as never)

    expect(memoriesSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "contains",
        kind: "decision",
        status: "accepted",
        tags: ["architecture"],
      }),
    )
  })

  it("over-fetches in semantic mode but uses the requested limit verbatim in contains/hybrid", async () => {
    // Semantic mode still post-filters kind/status because client.search
    // ignores property filters — the over-fetch keeps the post-filter from
    // starving output. Contains/hybrid filter server-side so no over-fetch
    // is needed; the tool forwards the requested limit verbatim.
    const mockServer = createMockServer()
    const memoriesSearch = vi.fn().mockResolvedValue([])
    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { search: memoriesSearch, list: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    const search = mockServer.getHandler("lore-search")

    await search({ query: "q", limit: 5, mode: "semantic" } as never)
    expect(memoriesSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "semantic", limit: 10 }),
    )

    await search({ query: "q", limit: 5, mode: "contains" } as never)
    expect(memoriesSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "contains", limit: 5 }),
    )

    await search({ query: "q", limit: 5, mode: "hybrid" } as never)
    expect(memoriesSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "hybrid", limit: 5 }),
    )
  })

  it("resolves topicName to a topic id and threads it through", async () => {
    const mockServer = createMockServer()
    const findTopic = vi.fn().mockResolvedValue(makeTopic("topic-1", { name: "GraphQL" }))
    const memoriesSearch = vi.fn().mockResolvedValue([])
    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: findTopic },
      memories: { search: memoriesSearch, list: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    const search = mockServer.getHandler("lore-search")

    await search({ query: "q", topicName: "GraphQL" } as never)

    expect(findTopic).toHaveBeenCalledWith("GraphQL")
    expect(memoriesSearch).toHaveBeenCalledWith(
      expect.objectContaining({ topicId: "topic-1" }),
    )
  })

  it("returns an error when topicName does not resolve", async () => {
    const mockServer = createMockServer()
    const findTopic = vi.fn().mockResolvedValue(null)
    const memoriesSearch = vi.fn().mockResolvedValue([])
    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: findTopic },
      memories: { search: memoriesSearch, list: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    const search = mockServer.getHandler("lore-search")

    const result = await search({ query: "q", topicName: "Nope" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain('No topic named "Nope" found')
    // Service was not called — short-circuited at the topic resolver.
    expect(memoriesSearch).not.toHaveBeenCalled()
  })
})

describe("lore-expand", () => {
  // UUIDs valid per z.string().uuid() — Notion returns dashed UUIDs from
  // page.id, so these match the shape agents would actually pass in.
  const ID_A = "11111111-1111-4111-8111-111111111111"
  const ID_B = "22222222-2222-4222-8222-222222222222"
  const ID_C = "33333333-3333-4333-8333-333333333333"

  it("returns hydrated bodies for each requested ID", async () => {
    const mockServer = createMockServer()
    const getById = vi.fn(async (id: string) => {
      const titles: Record<string, string> = {
        [ID_A]: "Alpha memory",
        [ID_B]: "Beta memory",
        [ID_C]: "Gamma memory",
      }
      return makeMemory(id, {
        title: titles[id] ?? "Unknown",
        content: `Body for ${id}`,
      })
    })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { getById },
      context: { project: null },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const expand = mockServer.getHandler("lore-expand")

    const result = await expand({ ids: [ID_A, ID_B, ID_C] } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("### Alpha memory")
    expect(text).toContain("### Beta memory")
    expect(text).toContain("### Gamma memory")
    expect(text).toContain(`Body for ${ID_A}`)
    expect(text).toContain(`Body for ${ID_B}`)
    expect(text).toContain(`Body for ${ID_C}`)
    expect(text).toContain("Expanded 3 memories")
    expect(getById).toHaveBeenCalledTimes(3)
  })

  it("enforces the 20-ID cap at the schema layer", async () => {
    const mockServer = createMockServer()
    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { getById: vi.fn() },
      context: { project: null },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const schema = mockServer.getInputSchema("lore-expand")

    // Build 21 distinct valid v4 UUIDs to push past the cap. Format follows
    // Zod's UUID regex: 8-4-4-4-12 with version 4 and variant 8–b.
    const tooMany = Array.from({ length: 21 }, (_, i) => {
      const hex = i.toString(16).padStart(4, "0")
      const tail3 = hex.slice(0, 3)
      return `${hex}${hex}-${hex}-4${tail3}-8${tail3}-${hex}${hex}${hex}`
    })

    const oversized = schema.safeParse({ ids: tooMany })
    expect(oversized.success).toBe(false)

    // Empty input is also rejected — min(1) guards against no-op calls.
    const empty = schema.safeParse({ ids: [] })
    expect(empty.success).toBe(false)

    // Boundary: exactly 20 IDs parses cleanly.
    const justRight = schema.safeParse({ ids: tooMany.slice(0, 20) })
    expect(justRight.success).toBe(true)

    // Non-UUID strings fail the per-element z.string().uuid() guard.
    const badShape = schema.safeParse({ ids: ["not-a-uuid"] })
    expect(badShape.success).toBe(false)
  })

  it("parallel-dispatches getById — every fetch starts before any returns", async () => {
    // Each mocked fetch blocks on an externally-controlled promise so we can
    // prove all three in-flight concurrently. If the handler serialized
    // (e.g. `for await`), the test would time out because fetch #2 would
    // never start while fetch #1 is still pending.
    const mockServer = createMockServer()
    const inflight = new Map<string, () => void>()
    const started: string[] = []

    const getById = vi.fn((id: string) => {
      started.push(id)
      return new Promise<Memory>((resolve) => {
        inflight.set(id, () =>
          resolve(makeMemory(id, { title: `Title ${id}`, content: `Body ${id}` })),
        )
      })
    })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { getById },
      context: { project: null },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const expand = mockServer.getHandler("lore-expand")

    const pending = expand({ ids: [ID_A, ID_B, ID_C] } as never)
    // Let the microtask queue flush so any already-kicked-off fetches land
    // in `started`. If dispatch is serial, only ID_A is there.
    await new Promise((r) => setImmediate(r))
    expect(started).toEqual([ID_A, ID_B, ID_C])

    // Resolve in reverse order — the handler must assemble output by input
    // order regardless of completion order.
    inflight.get(ID_C)?.()
    inflight.get(ID_B)?.()
    inflight.get(ID_A)?.()

    const result = await pending
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    const idxA = text.indexOf(`Body ${ID_A}`)
    const idxB = text.indexOf(`Body ${ID_B}`)
    const idxC = text.indexOf(`Body ${ID_C}`)
    expect(idxA).toBeGreaterThan(-1)
    expect(idxB).toBeGreaterThan(idxA)
    expect(idxC).toBeGreaterThan(idxB)
  })

  it("renders per-ID failures as (unresolved: <id>) without collapsing the whole call", async () => {
    const mockServer = createMockServer()
    const getById = vi.fn(async (id: string) => {
      if (id === ID_B) throw new Error("boom — page gone")
      return makeMemory(id, { title: `Title ${id}`, content: `Body ${id}` })
    })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { getById },
      context: { project: null },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const expand = mockServer.getHandler("lore-expand")

    const result = await expand({ ids: [ID_A, ID_B, ID_C] } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    // Successes still surface.
    expect(text).toContain(`Body ${ID_A}`)
    expect(text).toContain(`Body ${ID_C}`)
    // Failure row uses the agreed shape and carries the error message.
    expect(text).toContain(`### (unresolved: ${ID_B})`)
    expect(text).toContain("boom — page gone")
    // Response is not flagged as an error — partial success is not failure.
    expect((result as { isError?: boolean }).isError).not.toBe(true)
    // Header reflects the mixed outcome so agents can react without parsing.
    expect(text).toContain("Expanded 2/3 memories (1 unresolved)")
  })

  it("de-duplicates repeated IDs before dispatching getById", async () => {
    const mockServer = createMockServer()
    const getById = vi.fn(async (id: string) =>
      makeMemory(id, { title: `Title ${id}`, content: `Body ${id}` }),
    )

    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { getById },
      context: { project: null },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const expand = mockServer.getHandler("lore-expand")

    const result = await expand({ ids: [ID_A, ID_A, ID_B] } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    // ID_A is fetched once even though the caller passed it twice.
    expect(getById).toHaveBeenCalledTimes(2)
    expect(getById).toHaveBeenCalledWith(ID_A)
    expect(getById).toHaveBeenCalledWith(ID_B)
    // Header counts unique IDs, not the raw input length.
    expect(text).toContain("Expanded 2 memories")
  })
})
