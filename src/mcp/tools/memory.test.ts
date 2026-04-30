import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { registerMemoryTools } from "./memory.js"
import { registerQueryTools } from "./query.js"
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
    confidenceScore: null,
    reviewBy: null,
    doneAt: null,
    decidedAt: null,
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
    /**
     * Wrap a polymorphic dispatcher in a one-action shim so individual
     * tests can call it with action-specific args alone. Equivalent to
     * the prior alias-handler shape — the polymorphic dispatcher's
     * discriminated union still validates the per-action schema.
     */
    getActionHandler(toolName: string, action: string) {
      const handler = handlers.get(toolName)
      if (!handler) throw new Error(`missing handler ${toolName}`)
      return (args: Record<string, unknown>) =>
        handler({ ...args, action } as never)
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
    registerQueryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

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
    registerQueryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    await remember({ title: "No session", content: "body" } as never)

    expect(record).toHaveBeenCalledWith(
      { agent: undefined, session: undefined },
      { memoryId: "mem-no-session", projectIds: [] }
    )
  })
})

describe("lore-remember forceNewTopic (issue #109)", () => {
  it("forwards forceNewTopic to topics.getOrCreate as { forceNew: true }", async () => {
    // The MCP boundary takes a `forceNewTopic` flag; the service-layer
    // contract is `forceNew`. This test pins the rename so a future
    // refactor doesn't silently strip the flag at the boundary.
    const mockServer = createMockServer()
    const created = makeMemory("mem-new", { projectIds: ["proj-a"] })
    const getOrCreate = vi
      .fn()
      .mockResolvedValue(makeTopic("t-new", { name: "Eval & Testing" }))

    const services = {
      projects: { findByName: vi.fn().mockResolvedValue({ id: "proj-a", name: "a" }) },
      topics: { getOrCreate },
      memories: { create: vi.fn().mockResolvedValue(created), list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    await remember({
      title: "Wakeup hook crash diagnosis",
      content: "body",
      topicName: "Eval & Testing",
      forceNewTopic: true,
    } as never)

    expect(getOrCreate).toHaveBeenCalledWith(
      "Eval & Testing",
      ["proj-a"],
      { forceNew: true },
    )
  })

  it("renders the canonical's stored name when normalized-equivalent collapse landed", async () => {
    // When the agent saves "Eval & Testing" but the probe matches an
    // existing "Evals & Testing" canonical, the response should echo
    // the canonical name — not the input — so the agent's view of the
    // vault stays consistent with what's stored.
    const mockServer = createMockServer()
    const created = makeMemory("mem-new", { projectIds: ["proj-a"] })
    const canonical = makeTopic("t-canonical", { name: "Evals & Testing" })
    const getOrCreate = vi.fn().mockResolvedValue(canonical)

    const services = {
      projects: { findByName: vi.fn().mockResolvedValue({ id: "proj-a", name: "a" }) },
      topics: { getOrCreate },
      memories: { create: vi.fn().mockResolvedValue(created), list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "Eval testing rollout",
      content: "body",
      topicName: "Eval & Testing",
    } as never)

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("Topic: Evals & Testing")
  })

  it("surfaces the SimilarTopicError message back through toolError", async () => {
    // When the probe rejects, getOrCreate throws; the tool layer's
    // try/catch routes the message into the `Error: ...` content.
    const mockServer = createMockServer()
    const getOrCreate = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'Topic "GraphQLL Federation" looks similar to 1 existing topic in this project:\n  - "GraphQL Federation" (similarity 0.86, id: t-1)\nUse one of the existing topic names verbatim, or pass `forceNew: true` to create a new topic anyway.',
        ),
      )

    const services = {
      projects: { findByName: vi.fn().mockResolvedValue({ id: "proj-a", name: "a" }) },
      topics: { getOrCreate },
      memories: { create: vi.fn(), list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "irrelevant",
      content: "body",
      topicName: "GraphQLL Federation",
    } as never)

    const wrapped = result as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(wrapped.isError).toBe(true)
    expect(wrapped.content[0].text).toContain("looks similar")
    expect(wrapped.content[0].text).toContain("forceNew: true")
    // Save was never attempted — the throw short-circuits before
    // `memories.create`.
    expect(services.memories.create).not.toHaveBeenCalled()
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
    registerQueryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

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
    registerQueryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

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
    registerQueryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

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
    registerQueryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

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
    registerQueryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

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
    registerQueryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

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
    registerQueryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

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
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

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
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

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
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

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
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

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
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

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
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

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
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

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
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

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
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

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
    registerQueryTools(mockServer.server, services as never)
    const search = mockServer.getActionHandler("lore-query", "search")

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
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

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
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

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
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

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
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

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
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

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
    const recallServices = {
      topics: { findByName: vi.fn() },
      memories: { list: vi.fn().mockResolvedValue({ items: [tagged] }) },
      projects: { findByName: vi.fn() },
      context: { project: null },
    }
    registerMemoryTools(recallServer.server, recallServices as never)
    registerQueryTools(recallServer.server, recallServices as never)
    const recall = recallServer.getActionHandler("lore-query", "recall")

    const searchServer = createMockServer()
    const searchServices = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: {
        search: vi.fn().mockResolvedValue([tagged]),
        list: vi.fn(),
      },
      context: { project: null },
    }
    registerMemoryTools(searchServer.server, searchServices as never)
    registerQueryTools(searchServer.server, searchServices as never)
    const search = searchServer.getActionHandler("lore-query", "search")

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

describe("lore-recall trust indicator (issue 0.8.0/09)", () => {
  // The trust line surfaces on recall when a memory's `confidenceScore`
  // sits below the display threshold. Pinned at the surface (not just
  // the renderer) so a future contributor swapping the recall handler
  // away from `formatMemoryListItem` would see this fail rather than
  // silently lose the signal.

  it("renders the trust line on a low-confidence recall row", async () => {
    const mockServer = createMockServer()
    const memoriesList = vi.fn().mockResolvedValue({
      items: [
        makeMemory("mem-1", {
          title: "Decayed row",
          source: "manual",
          tags: ["auth"],
          updatedAt: "2026-04-20T00:00:00.000Z",
          confidenceScore: 0.3,
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
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

    const result = await recall({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("### Decayed row\n_low confidence_\n")
  })

  it("omits the trust line on a healthy recall row (byte-identical to pre-0.8.0)", async () => {
    const mockServer = createMockServer()
    const memoriesList = vi.fn().mockResolvedValue({
      items: [
        makeMemory("mem-1", {
          title: "Healthy row",
          source: "manual",
          tags: ["auth"],
          updatedAt: "2026-04-20T00:00:00.000Z",
          confidenceScore: 0.95,
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
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

    const result = await recall({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).not.toContain("confidence_")
    expect(text).toContain("### Healthy row")
  })
})

describe("lore-search trust indicator (issue 0.8.0/09)", () => {
  it("renders the trust line on a low-confidence search hit", async () => {
    const mockServer = createMockServer()
    const memoriesSearch = vi.fn().mockResolvedValue([
      makeMemory("mem-1", {
        title: "Decayed hit",
        source: "manual",
        tags: ["auth"],
        updatedAt: "2026-04-20T00:00:00.000Z",
        confidenceScore: 0.15,
      }),
    ])

    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { search: memoriesSearch, list: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const search = mockServer.getActionHandler("lore-query", "search")

    const result = await search({ query: "anything" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("### Decayed hit\n_very low confidence_\n")
  })

  it("omits the trust line on a healthy search hit (byte-identical to pre-0.8.0)", async () => {
    const mockServer = createMockServer()
    const memoriesSearch = vi
      .fn()
      .mockResolvedValue([
        makeMemory("mem-1", { title: "Healthy hit", confidenceScore: 0.95 }),
      ])

    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { search: memoriesSearch, list: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const search = mockServer.getActionHandler("lore-query", "search")

    const result = await search({ query: "anything" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).not.toContain("confidence_")
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
    registerQueryTools(mockServer.server, services as never)
    const search = mockServer.getActionHandler("lore-query", "search")

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
    registerQueryTools(mockServer.server, services as never)
    const search = mockServer.getActionHandler("lore-query", "search")

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
    registerQueryTools(mockServer.server, services as never)
    const search = mockServer.getActionHandler("lore-query", "search")

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
    registerQueryTools(mockServer.server, services as never)
    const search = mockServer.getActionHandler("lore-query", "search")

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
    registerQueryTools(mockServer.server, services as never)
    const search = mockServer.getActionHandler("lore-query", "search")

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
    registerQueryTools(mockServer.server, services as never)
    const search = mockServer.getActionHandler("lore-query", "search")

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
    registerQueryTools(mockServer.server, services as never)
    const search = mockServer.getActionHandler("lore-query", "search")

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
    registerQueryTools(mockServer.server, services as never)
    const search = mockServer.getActionHandler("lore-query", "search")

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
    registerQueryTools(mockServer.server, services as never)
    const expand = mockServer.getActionHandler("lore-memory", "expand")

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

  it("enforces the 20-ID cap at the dispatcher's discriminated union", async () => {
    // Validation lives in the polymorphic `lore-memory` dispatcher's
    // discriminated union (`ids: array(uuid()).min(1).max(20)` on the
    // `expand` branch). Drive the handler so the test follows the same
    // path production callers do — schema-only `safeParse` would miss
    // a refactor that moved the cap onto a runtime guard.
    const mockServer = createMockServer()
    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { getById: vi.fn().mockResolvedValue(makeMemory("m")) },
      context: { project: null },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const expand = mockServer.getActionHandler("lore-memory", "expand")

    // Build 21 distinct valid v4 UUIDs to push past the cap. Format follows
    // Zod's UUID regex: 8-4-4-4-12 with version 4 and variant 8–b.
    const tooMany = Array.from({ length: 21 }, (_, i) => {
      const hex = i.toString(16).padStart(4, "0")
      const tail3 = hex.slice(0, 3)
      return `${hex}${hex}-${hex}-4${tail3}-8${tail3}-${hex}${hex}${hex}`
    })

    const isErr = (r: unknown): boolean =>
      (r as { isError?: boolean }).isError === true

    const oversized = await expand({ ids: tooMany })
    expect(isErr(oversized)).toBe(true)

    // Empty input is rejected — min(1) guards against no-op calls.
    const empty = await expand({ ids: [] })
    expect(isErr(empty)).toBe(true)

    // Boundary: exactly 20 IDs round-trips.
    const justRight = await expand({ ids: tooMany.slice(0, 20) })
    expect(isErr(justRight)).toBe(false)

    // Non-UUID strings fail the per-element z.string().uuid() guard.
    const badShape = await expand({ ids: ["not-a-uuid"] })
    expect(isErr(badShape)).toBe(true)
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
    registerQueryTools(mockServer.server, services as never)
    const expand = mockServer.getActionHandler("lore-memory", "expand")

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
    registerQueryTools(mockServer.server, services as never)
    const expand = mockServer.getActionHandler("lore-memory", "expand")

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
    registerQueryTools(mockServer.server, services as never)
    const expand = mockServer.getActionHandler("lore-memory", "expand")

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

describe("lore-memory active-task cross-reference (issue 0.7.0/11)", () => {
  // The save response surfaces active tasks tracking the same entity
  // the just-saved memory describes — anchoring closure CTAs at the
  // resolution moment. Probe runs in parallel with the create + the
  // existing near-dup probe so wall-clock latency is unchanged.

  function makeTaskSummary(
    overrides: { id: string; title: string } & Partial<{
      taskState: "open" | "in-progress" | "blocked" | "done" | "cancelled"
      entity: string
    }>,
  ) {
    return {
      id: overrides.id,
      title: overrides.title,
      projectIds: ["proj-a"],
      topicId: null,
      source: "manual" as const,
      kind: "task" as const,
      status: "informational" as const,
      confidence: "certain" as const,
      confidenceScore: null,
      reviewBy: null,
      doneAt: null,
      decidedAt: null,
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
      taskState: overrides.taskState ?? "open",
      blockedBy: "",
      entity: overrides.entity ?? overrides.title,
      comparedWith: [],
      compareNotes: "",
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
    }
  }

  it("surfaces a Related active tasks footer when entities match active tasks", async () => {
    const mockServer = createMockServer()
    const created = makeMemory("mem-new", {
      title: "Merged PR #25750: outlook label.applied classifier",
      projectIds: ["proj-a"],
    })
    const tasksList = vi.fn().mockResolvedValue({
      items: [
        makeTaskSummary({
          id: "task-1",
          title: "Track PR #25750 review",
          taskState: "in-progress",
        }),
      ],
    })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create: vi.fn().mockResolvedValue(created), list: vi.fn().mockResolvedValue({ items: [] }) },
      tasks: { list: tasksList },
      facts: {
        createWithDedup: vi
          .fn()
          .mockResolvedValue({ fact: { id: "fact-x" }, deduped: false, enriched: [] }),
      },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "Merged PR #25750: outlook label.applied classifier",
      content: "body",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("Saved memory:")
    // Heading uses the issue's spec wording.
    expect(text).toContain("Related active tasks (1)")
    expect(text).toContain("close any that this memory resolves")
    // Per-task line carries title, state, and copy-paste closure CTA.
    expect(text).toContain('"Track PR #25750 review" [in-progress]')
    expect(text).toContain("lore-task({ action: 'close', taskId: 'task-1' })")
    // Probe was scoped to project + ACTIVE_TASK_STATES, with extracted
    // entities including PR #25750.
    expect(tasksList).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-a",
        states: ["open", "in-progress", "blocked"],
        entities: expect.arrayContaining(["PR #25750"]),
        limit: 5,
      }),
    )
  })

  it("threads keywords and synopsis into the entity-extraction surface", async () => {
    // Pre-#02 the handler had no `synopsis` field; the wire-in here
    // exists because #11 hard-deps on #02. Pin the surface so a future
    // refactor doesn't silently drop synopsis from the probe inputs.
    const mockServer = createMockServer()
    const created = makeMemory("mem-new", {
      title: "Shipped",
      projectIds: ["proj-a"],
      keywords: "PR #25750",
      synopsis: "Closes SENTRY-1234.",
    })
    const tasksList = vi.fn().mockResolvedValue({ items: [] })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create: vi.fn().mockResolvedValue(created), list: vi.fn().mockResolvedValue({ items: [] }) },
      tasks: { list: tasksList },
      facts: {
        createWithDedup: vi
          .fn()
          .mockResolvedValue({ fact: { id: "fact-x" }, deduped: false, enriched: [] }),
      },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    await remember({
      title: "Shipped",
      content: "body",
      keywords: "PR #25750",
      synopsis: "Closes SENTRY-1234.",
    } as never)

    const call = tasksList.mock.calls[0][0] as { entities: string[] }
    expect(call.entities).toContain("PR #25750")
    expect(call.entities).toContain("SENTRY-1234")
  })

  it("omits the cross-reference footer when the probe returns no tasks", async () => {
    const mockServer = createMockServer()
    const created = makeMemory("mem-new", {
      title: "Merged PR #25750",
      projectIds: ["proj-a"],
    })
    const tasksList = vi.fn().mockResolvedValue({ items: [] })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create: vi.fn().mockResolvedValue(created), list: vi.fn().mockResolvedValue({ items: [] }) },
      tasks: { list: tasksList },
      facts: {
        createWithDedup: vi
          .fn()
          .mockResolvedValue({ fact: { id: "fact-x" }, deduped: false, enriched: [] }),
      },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "Merged PR #25750",
      content: "body",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("Saved memory:")
    expect(text).not.toContain("Related active tasks")
  })

  it("save still succeeds when the cross-reference probe fails (advisory)", async () => {
    const mockServer = createMockServer()
    const created = makeMemory("mem-new", {
      title: "Merged PR #25750",
      projectIds: ["proj-a"],
    })
    const tasksList = vi.fn().mockRejectedValue(new Error("notion 503"))

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create: vi.fn().mockResolvedValue(created), list: vi.fn().mockResolvedValue({ items: [] }) },
      tasks: { list: tasksList },
      facts: {
        createWithDedup: vi
          .fn()
          .mockResolvedValue({ fact: { id: "fact-x" }, deduped: false, enriched: [] }),
      },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "Merged PR #25750",
      content: "body",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("Saved memory:")
    expect(text).not.toContain("Related active tasks")
    expect((result as { isError?: boolean }).isError).not.toBe(true)
  })

  it("LORE_DISABLE_TASK_CROSSREF=1 skips the probe without making a Notion call", async () => {
    const mockServer = createMockServer()
    const created = makeMemory("mem-new", {
      title: "Merged PR #25750",
      projectIds: ["proj-a"],
    })
    const tasksList = vi.fn()

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create: vi.fn().mockResolvedValue(created), list: vi.fn().mockResolvedValue({ items: [] }) },
      tasks: { list: tasksList },
      facts: {
        createWithDedup: vi
          .fn()
          .mockResolvedValue({ fact: { id: "fact-x" }, deduped: false, enriched: [] }),
      },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    vi.stubEnv("LORE_DISABLE_TASK_CROSSREF", "1")
    try {
      const result = await remember({
        title: "Merged PR #25750",
        content: "body",
      } as never)
      const text = (result as { content: Array<{ text: string }> }).content[0].text
      expect(text).toContain("Saved memory:")
      expect(text).not.toContain("Related active tasks")
      expect(tasksList).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("fires the probe in parallel with the create — both start before either resolves", async () => {
    // Wall-clock guarantee from the issue: latency unchanged from
    // pre-#11. Concretely, the probe fires before `memories.create`
    // resolves. Without parallelism, `tasks.list` would only run after
    // `memories.create` resolved.
    const mockServer = createMockServer()
    const events: string[] = []
    let resolveCreate!: (m: Memory) => void

    const create = vi.fn(() => {
      events.push("create-called")
      return new Promise<Memory>((resolve) => {
        resolveCreate = resolve
      })
    })
    const tasksList = vi.fn().mockImplementation(async () => {
      events.push("tasks-list-called")
      return { items: [] }
    })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create, list: vi.fn().mockResolvedValue({ items: [] }) },
      tasks: { list: tasksList },
      // Mock `facts.createWithDedup` so the post-create auto-emit
      // branch (issue 0.8.0/#07) doesn't synchronously throw on the
      // unresolved property access. Without it, the title `"Merged PR
      // #25750"` extracts an entity, the auto-emit branch hits
      // `services.facts.createWithDedup`, the synchronous `TypeError`
      // routes through `handleSave`'s outer try/catch, and the test
      // would pass only because its parallelism assertions run on the
      // synchronous prefix before auto-emit ever runs — masking a
      // silent toolError on the post-create path.
      facts: {
        createWithDedup: vi
          .fn()
          .mockResolvedValue({ fact: { id: "fact-x" }, deduped: false, enriched: [] }),
      },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const pending = remember({
      title: "Merged PR #25750",
      content: "body",
    } as never)

    // Yield so both kicked-off promises run their synchronous prefix.
    await new Promise((r) => setImmediate(r))

    // Both calls fired before create resolved — proves parallelism.
    expect(events).toContain("create-called")
    expect(events).toContain("tasks-list-called")

    resolveCreate(
      makeMemory("mem-new", {
        title: "Merged PR #25750",
        projectIds: ["proj-a"],
      }),
    )
    const result = await pending
    // Post-fix sanity: with the `facts` mock present the post-create
    // path runs cleanly. A regression where, e.g., `createWithDedup`
    // is renamed surfaces here as a hard failure rather than a
    // silently-masked toolError.
    expect((result as { isError?: boolean }).isError).not.toBe(true)
  })
})

describe("lore-memory auto-mentions emission (issue 0.8.0/07)", () => {
  // The save handler now auto-emits one `mentions` fact per entity
  // surfaced by `extractEntityCandidates` over the saved memory's
  // title / keywords / synopsis. This widens `lore-ask`'s structural
  // recall surface without an LLM call (the extractor is regex-based)
  // and without changing the retrieval pipeline.

  it("emits one `mentions` fact per extracted entity with subject=title, predicate=mentions, source=memory id", async () => {
    const mockServer = createMockServer()
    const created = makeMemory("mem-emit-1", {
      title: "Investigated PR #25750 latency regression",
      projectIds: ["proj-a"],
      keywords: "performance",
    })
    const createWithDedup = vi.fn().mockResolvedValue({
      fact: { id: "fact-1" },
      deduped: false,
      enriched: [],
    })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create: vi.fn().mockResolvedValue(created),
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      facts: { createWithDedup },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "Investigated PR #25750 latency regression",
      content: "body",
      keywords: "performance",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    // At least one `mentions` fact landed for `PR #25750` with the
    // memory title as subject and the memory id as the source.
    expect(createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Investigated PR #25750 latency regression",
        predicate: "mentions",
        object: "PR #25750",
        sourceMemoryId: "mem-emit-1",
        projectIds: ["proj-a"],
        confidence: "speculative",
      }),
    )
    // Footer surfaces the count. All creates landed so the "/N
    // attempted" suffix is absent — that suffix only appears on
    // partial-failure runs.
    expect(text).toMatch(/Auto-mentions: \d+(?!\/)/)
    expect(text).not.toContain("attempted")
  })

  it("respects ENTITY_CANDIDATE_LIMIT (caps at 5 facts even when more entities are extractable)", async () => {
    const mockServer = createMockServer()
    const created = makeMemory("mem-emit-cap", {
      title: "Shipped PR #1 PR #2 PR #3 PR #4 PR #5 PR #6 PR #7",
      projectIds: ["proj-a"],
    })
    const createWithDedup = vi.fn().mockResolvedValue({
      fact: { id: "fact-x" },
      deduped: false,
      enriched: [],
    })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create: vi.fn().mockResolvedValue(created),
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      facts: { createWithDedup },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    await remember({
      title: "Shipped PR #1 PR #2 PR #3 PR #4 PR #5 PR #6 PR #7",
      content: "body",
    } as never)

    // The extractor caps total candidates at 5 — auto-emit honors
    // that ceiling without re-deriving its own cap.
    expect(createWithDedup.mock.calls.length).toBeLessThanOrEqual(5)
    expect(createWithDedup.mock.calls.length).toBeGreaterThan(0)
  })

  it("emits zero facts and omits the footer when no entities are extractable", async () => {
    const mockServer = createMockServer()
    const created = makeMemory("mem-no-entities", {
      title: "ok",
      projectIds: ["proj-a"],
    })
    const createWithDedup = vi.fn()

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create: vi.fn().mockResolvedValue(created),
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      facts: { createWithDedup },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "ok",
      content: "body",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(createWithDedup).not.toHaveBeenCalled()
    expect(text).not.toContain("Auto-mentions:")
  })

  it("save still succeeds when a per-entity fact creation fails (failure-domain isolation)", async () => {
    // A transient failure on one fact's create should not break the
    // surrounding save response or block surviving fact creates from
    // landing. Same posture as the parallel near-dup / cross-ref
    // probes — auto-mentions are advisory.
    const mockServer = createMockServer()
    const created = makeMemory("mem-partial", {
      title: "Reviewed PR #25750 against SENTRY-1234",
      projectIds: ["proj-a"],
    })
    const createWithDedup = vi
      .fn()
      .mockResolvedValueOnce({ fact: { id: "fact-ok" }, deduped: false, enriched: [] })
      .mockRejectedValueOnce(new Error("notion 503"))
      .mockResolvedValue({ fact: { id: "fact-ok-2" }, deduped: false, enriched: [] })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create: vi.fn().mockResolvedValue(created),
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      facts: { createWithDedup },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "Reviewed PR #25750 against SENTRY-1234",
      content: "body",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect((result as { isError?: boolean }).isError).not.toBe(true)
    expect(text).toContain("Saved memory:")
    // Surviving creates landed; the partial failure didn't sink the
    // whole branch.
    expect(createWithDedup).toHaveBeenCalled()
    // Partial-failure footer surfaces the "landed/attempted" split
    // so an operator inspecting the save can tell whether the work
    // actually happened — not just whether the tokenizer fired.
    expect(text).toMatch(/Auto-mentions: \d+\/\d+ attempted/)
  })

  it("LORE_DISABLE_AUTO_MENTIONS=1 skips both extraction and fact creation entirely", async () => {
    // Same posture as `LORE_DISABLE_NEAR_DUPLICATE_PROBE` /
    // `LORE_DISABLE_TASK_CROSSREF`. Single-axis kill switch lets an
    // operator distrust the regex-based entity tokenizer
    // independently of the other advisory probes. Distinct from
    // those two knobs: an operator may trust the deterministic
    // substring near-dup probe and the active-task cross-ref while
    // distrusting the auto-mentions tokenizer's noise floor.
    const mockServer = createMockServer()
    const created = makeMemory("mem-disabled", {
      title: "Investigated PR #25750",
      projectIds: ["proj-a"],
    })
    const createWithDedup = vi.fn()

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create: vi.fn().mockResolvedValue(created),
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      facts: { createWithDedup },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    vi.stubEnv("LORE_DISABLE_AUTO_MENTIONS", "1")
    try {
      const result = await remember({
        title: "Investigated PR #25750",
        content: "body",
      } as never)
      const text = (result as { content: Array<{ text: string }> }).content[0].text

      expect(text).toContain("Saved memory:")
      // No fact-create call; no advisory footer.
      expect(createWithDedup).not.toHaveBeenCalled()
      expect(text).not.toContain("Auto-mentions:")
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("threads keywords and synopsis into the auto-mentions extraction surface", async () => {
    // Tokenizer reads title + keywords + synopsis; pin the wire-in
    // so a future refactor doesn't silently drop the auxiliary
    // surfaces.
    const mockServer = createMockServer()
    const created = makeMemory("mem-threads", {
      title: "Reviewed",
      projectIds: ["proj-a"],
      keywords: "PR #25750",
      synopsis: "Closes SENTRY-1234.",
    })
    const createWithDedup = vi.fn().mockResolvedValue({
      fact: { id: "fact-x" },
      deduped: false,
      enriched: [],
    })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create: vi.fn().mockResolvedValue(created),
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      facts: { createWithDedup },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    await remember({
      title: "Reviewed",
      content: "body",
      keywords: "PR #25750",
      synopsis: "Closes SENTRY-1234.",
    } as never)

    const objects = createWithDedup.mock.calls.map(
      (c) => (c[0] as { object: string }).object,
    )
    expect(objects).toContain("PR #25750")
    expect(objects).toContain("SENTRY-1234")
  })

  it("omits projectIds when the saved memory has no project scope (vault-wide auto-emit is well-defined)", async () => {
    // `createWithDedup`'s `projectIds` is optional; passing an empty
    // array would scope the dedup probe in a way the rest of the
    // codebase doesn't. Match the convention used elsewhere in this
    // handler — undefined when no projects, populated otherwise.
    const mockServer = createMockServer()
    const created = makeMemory("mem-vaultwide", {
      title: "Reviewed PR #25750",
      projectIds: [],
    })
    const createWithDedup = vi.fn().mockResolvedValue({
      fact: { id: "fact-x" },
      deduped: false,
      enriched: [],
    })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create: vi.fn().mockResolvedValue(created),
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      facts: { createWithDedup },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    await remember({
      title: "Reviewed PR #25750",
      content: "body",
    } as never)

    const firstCall = createWithDedup.mock.calls[0][0] as {
      projectIds?: string[]
    }
    expect(firstCall.projectIds).toBeUndefined()
  })

  it("two saves with the same title + entity converge to one fact via createWithDedup (acceptance criterion #5)", async () => {
    // Pin the wire-up: a second save with the same payload must route
    // through `createWithDedup` so the existing dedup-key probe absorbs
    // the second emission. This is a convergence test on the wire-in,
    // not a re-test of `FactService.createWithDedup`'s dedup semantics
    // — the latter is covered exhaustively in `core/fact.test.ts`. The
    // wire-up bug shape this guards against is "second save creates a
    // fresh row because the tool layer used `create` instead of
    // `createWithDedup`."
    const mockServer = createMockServer()
    const created = makeMemory("mem-dedup", {
      title: "Investigated PR #25750",
      projectIds: ["proj-a"],
    })
    // Default resolution covers every per-entity call (the title
    // produces both `PR #25750` and `#25750` via overlapping
    // patterns — two calls per save). The first save's calls return
    // `deduped: false` (fresh rows); the remaining calls return
    // `deduped: true` to mimic the live shape — the surrounding
    // handler doesn't branch on the boolean, but the fixture
    // documents intent.
    const createWithDedup = vi
      .fn()
      .mockResolvedValueOnce({ fact: { id: "fact-pr" }, deduped: false, enriched: [] })
      .mockResolvedValueOnce({ fact: { id: "fact-hash" }, deduped: false, enriched: [] })
      .mockResolvedValue({ fact: { id: "fact-pr" }, deduped: true, enriched: [] })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create: vi.fn().mockResolvedValue(created),
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      facts: { createWithDedup },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const args = { title: "Investigated PR #25750", content: "body" }
    const result1 = await remember(args as never)
    const result2 = await remember(args as never)

    // Both saves succeed and use `createWithDedup` (not `create`) so
    // the second pass hits the dedup probe. Same entity set, same
    // subject, same predicate → the second save's calls land on the
    // same triples. Surface assertion: both saves see the same
    // `(subject, predicate, object)` triples on `createWithDedup`
    // and neither raises an error. The number of per-save calls
    // depends on the extractor's candidate set for the title — what
    // matters here is that the second save fires the same triples
    // through `createWithDedup`, not `create`.
    expect((result1 as { isError?: boolean }).isError).not.toBe(true)
    expect((result2 as { isError?: boolean }).isError).not.toBe(true)
    const calls = createWithDedup.mock.calls.map(
      (c) => c[0] as { subject: string; predicate: string; object: string },
    )
    // At least two calls (one per save) — the title extracts at
    // least one entity, both saves run the auto-emit branch.
    expect(calls.length).toBeGreaterThanOrEqual(2)
    // Every call uses the `mentions` predicate.
    for (const call of calls) {
      expect(call.predicate).toBe("mentions")
      expect(call.subject).toBe("Investigated PR #25750")
    }
    // The convergence guarantee: the second save's `(predicate,
    // object)` set is a subset of the first save's. Asserting subset
    // (not "halves equal") decouples the test from the extractor's
    // iteration order — what matters is that the second save sees
    // the same triples through `createWithDedup`, regardless of
    // which order the calls fire on each pass.
    const firstSaveObjects = new Set<string>()
    const secondSaveObjects = new Set<string>()
    let seenSecondSaveStart = false
    // Split calls by save: the first save's calls land before the
    // second remember kicks off, so they appear first in the call
    // log. The split point is implicit (calls.length is even when
    // the extractor is deterministic) — assert subset rather than
    // exact split to stay robust if a future tokenizer change
    // alters the per-save call count.
    const half = Math.floor(calls.length / 2)
    for (let i = 0; i < calls.length; i++) {
      if (i >= half) seenSecondSaveStart = true
      if (seenSecondSaveStart) secondSaveObjects.add(calls[i].object)
      else firstSaveObjects.add(calls[i].object)
    }
    for (const obj of secondSaveObjects) {
      expect(firstSaveObjects).toContain(obj)
    }
  })

  it("LORE_DISABLE_NEAR_DUPLICATE_PROBE=1 does NOT disable auto-mentions emission (single-axis kill switches)", async () => {
    // Pin the single-axis contract the in-code comment and
    // AGENTS.md doc both lean on: an operator who distrusts the
    // near-duplicate substring probe must NOT lose auto-mentions
    // emission as a side effect. Sibling of the `findRelatedActiveTasks`
    // single-axis guard in `core/near-duplicate.test.ts` — a future
    // contributor "consolidating" the kill switches onto a single
    // env var would break this test rather than silently widening
    // the disable surface.
    const mockServer = createMockServer()
    const created = makeMemory("mem-single-axis-1", {
      title: "Reviewed PR #25750",
      projectIds: ["proj-a"],
    })
    const createWithDedup = vi
      .fn()
      .mockResolvedValue({ fact: { id: "fact-x" }, deduped: false, enriched: [] })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create: vi.fn().mockResolvedValue(created),
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      facts: { createWithDedup },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    vi.stubEnv("LORE_DISABLE_NEAR_DUPLICATE_PROBE", "1")
    try {
      await remember({
        title: "Reviewed PR #25750",
        content: "body",
      } as never)
      // Auto-emit still fired despite the near-dup kill switch.
      expect(createWithDedup).toHaveBeenCalled()
      expect(createWithDedup).toHaveBeenCalledWith(
        expect.objectContaining({ predicate: "mentions" }),
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("LORE_DISABLE_TASK_CROSSREF=1 does NOT disable auto-mentions emission (single-axis kill switches)", async () => {
    // Mirror of the near-dup single-axis test above — distrust of
    // the active-task cross-reference probe must NOT cascade to
    // auto-mentions. Same two-axis independence the AGENTS.md doc
    // pins.
    const mockServer = createMockServer()
    const created = makeMemory("mem-single-axis-2", {
      title: "Reviewed PR #25750",
      projectIds: ["proj-a"],
    })
    const createWithDedup = vi
      .fn()
      .mockResolvedValue({ fact: { id: "fact-x" }, deduped: false, enriched: [] })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create: vi.fn().mockResolvedValue(created),
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      facts: { createWithDedup },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    vi.stubEnv("LORE_DISABLE_TASK_CROSSREF", "1")
    try {
      await remember({
        title: "Reviewed PR #25750",
        content: "body",
      } as never)
      expect(createWithDedup).toHaveBeenCalled()
      expect(createWithDedup).toHaveBeenCalledWith(
        expect.objectContaining({ predicate: "mentions" }),
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe("lore-memory auto-mentions re-emission on update (DEFERRED-03)", () => {
  // Update-time re-emission of `mentions` facts uses the add-only
  // contract: pre-query existing mentions sourced from this memory,
  // emit `createWithDedup` only for entities not already covered.
  // Stale facts (entities removed by the update) are deliberately NOT
  // cleaned up — that requires extending the auto-fact contract with
  // invalidation, which today only `lore-correct` carries.

  it("emits a `mentions` fact for an entity newly surfaced in the post-update title", async () => {
    const mockServer = createMockServer()
    const updated = makeMemory("mem-update-1", {
      title: "Investigated PR #25750 latency regression",
      projectIds: ["proj-a"],
    })
    const update = vi.fn().mockResolvedValue(updated)
    const queryBySourceMemory = vi.fn().mockResolvedValue([])
    const createWithDedup = vi.fn().mockResolvedValue({
      fact: { id: "fact-new" },
      deduped: false,
      enriched: [],
    })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { update, getById: vi.fn() },
      facts: { queryBySourceMemory, createWithDedup },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    const result = await lore({
      memoryId: "mem-update-1",
      title: "Investigated PR #25750 latency regression",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(queryBySourceMemory).toHaveBeenCalledWith(
      "mem-update-1",
      expect.objectContaining({ predicates: ["mentions"] }),
    )
    // The pre-query intentionally does NOT pass `projectId` —
    // same-source-memory already implies same-scope, so scoping by
    // project would silently lose facts for memories whose
    // `projectIds` differ from the call site's. Pin the omission so
    // a future contributor "tightening" the query doesn't drop
    // legitimate covered-set rows.
    const probeOpts = queryBySourceMemory.mock.calls[0][1] as {
      projectId?: string
    }
    expect(probeOpts.projectId).toBeUndefined()
    expect(createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Investigated PR #25750 latency regression",
        predicate: "mentions",
        object: "PR #25750",
        sourceMemoryId: "mem-update-1",
        projectIds: ["proj-a"],
        confidence: "speculative",
      }),
    )
    // Footer surfaces the count with the `new` suffix that
    // distinguishes update-time emission from save-time emission.
    // Anchor on the line boundary rather than relying on a
    // negative-lookahead regex — `^Auto-mentions: N new$` is the
    // exact full-success shape, and the partial-failure shape
    // (`Auto-mentions: K/N new attempted`) cannot match.
    expect(text).toMatch(/^Auto-mentions: \d+ new$/m)
  })

  it("does NOT re-emit a fact for an entity already covered by an existing mentions fact", async () => {
    // The covered-set check is the load-bearing dedup primitive: if
    // `queryBySourceMemory` returns a fact with `object: "PR #25750"`,
    // a post-update set that includes "PR #25750" must not re-emit.
    // Pinning this guards against a refactor that swaps the per-Object
    // Set for an `id`-based check (which would never match across
    // saves) or that drops the pre-query entirely (which would
    // re-introduce the dedup-key probe round-trip per call).
    const mockServer = createMockServer()
    const updated = makeMemory("mem-update-cover", {
      title: "Investigated PR #25750 again",
      projectIds: ["proj-a"],
    })
    const update = vi.fn().mockResolvedValue(updated)
    const queryBySourceMemory = vi.fn().mockResolvedValue([
      { id: "fact-existing", object: "PR #25750" },
      { id: "fact-existing-2", object: "#25750" },
    ])
    const createWithDedup = vi.fn().mockResolvedValue({
      fact: { id: "fact-x" },
      deduped: false,
      enriched: [],
    })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { update, getById: vi.fn() },
      facts: { queryBySourceMemory, createWithDedup },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    const result = await lore({
      memoryId: "mem-update-cover",
      title: "Investigated PR #25750 again",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    // Every extracted candidate is already covered → zero
    // `createWithDedup` calls and no advisory footer.
    expect(createWithDedup).not.toHaveBeenCalled()
    expect(text).not.toContain("Auto-mentions:")
  })

  it("does NOT invalidate or touch facts for entities removed by the update (add-only contract)", async () => {
    // Stale-fact silence is the contract we're pinning: the spec
    // explicitly accepts drift on removes as the cost of avoiding
    // the diff-and-invalidate path, which would extend the auto-fact
    // contract with invalidation behavior. A future contributor
    // tempted to "clean up stale mentions on update" would break
    // this test rather than silently widening the contract.
    const mockServer = createMockServer()
    const updated = makeMemory("mem-update-stale", {
      title: "Investigated PR #25750",
      projectIds: ["proj-a"],
    })
    const update = vi.fn().mockResolvedValue(updated)
    // Existing facts include one for an entity NOT in the post-update
    // text — the add-only contract leaves it alone. The current-text
    // entities (`PR #25750` + `#25750`, surfaced by overlapping
    // patterns in the extractor) are all covered so no fresh emission
    // fires; the test isolates the stale-fact-handling assertion from
    // any "fresh entity slipped through" noise.
    const queryBySourceMemory = vi.fn().mockResolvedValue([
      { id: "fact-stale", object: "SENTRY-9999" },
      { id: "fact-current-pr", object: "PR #25750" },
      { id: "fact-current-hash", object: "#25750" },
    ])
    const createWithDedup = vi.fn()
    const invalidate = vi.fn()

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { update, getById: vi.fn() },
      facts: { queryBySourceMemory, createWithDedup, invalidate },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    await lore({
      memoryId: "mem-update-stale",
      title: "Investigated PR #25750",
    } as never)

    // No invalidate. No fresh creates either (PR #25750 already
    // covered, SENTRY-9999 not in post-update text).
    expect(invalidate).not.toHaveBeenCalled()
    expect(createWithDedup).not.toHaveBeenCalled()
  })

  it("emits only for the candidates not already covered (mixed add + already-covered)", async () => {
    // The realistic case: one entity carried over from the previous
    // version, one entity newly added in this update. The covered
    // entity is filtered out; the new entity emits.
    const mockServer = createMockServer()
    const updated = makeMemory("mem-update-mixed", {
      title: "Reviewed PR #25750 against SENTRY-1234",
      projectIds: ["proj-a"],
    })
    const update = vi.fn().mockResolvedValue(updated)
    const queryBySourceMemory = vi.fn().mockResolvedValue([
      { id: "fact-existing", object: "PR #25750" },
    ])
    const createWithDedup = vi.fn().mockResolvedValue({
      fact: { id: "fact-x" },
      deduped: false,
      enriched: [],
    })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { update, getById: vi.fn() },
      facts: { queryBySourceMemory, createWithDedup },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    await lore({
      memoryId: "mem-update-mixed",
      title: "Reviewed PR #25750 against SENTRY-1234",
    } as never)

    const objects = createWithDedup.mock.calls.map(
      (c) => (c[0] as { object: string }).object,
    )
    // PR #25750 was already covered → not in the calls.
    expect(objects).not.toContain("PR #25750")
    // SENTRY-1234 is freshly surfaced → in the calls.
    expect(objects).toContain("SENTRY-1234")
  })

  it("threads post-update keywords and synopsis into the extraction surface", async () => {
    // The branch reads the resolved-update memory's fields, not the
    // request args — so an update that clears synopsis or sets new
    // keywords sees the resolved values. Pin the wire-in.
    const mockServer = createMockServer()
    const updated = makeMemory("mem-update-fields", {
      title: "Reviewed",
      projectIds: ["proj-a"],
      keywords: "PR #25750",
      synopsis: "Closes SENTRY-1234.",
    })
    const update = vi.fn().mockResolvedValue(updated)
    const queryBySourceMemory = vi.fn().mockResolvedValue([])
    const createWithDedup = vi.fn().mockResolvedValue({
      fact: { id: "fact-x" },
      deduped: false,
      enriched: [],
    })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { update, getById: vi.fn() },
      facts: { queryBySourceMemory, createWithDedup },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    await lore({
      memoryId: "mem-update-fields",
      keywords: "PR #25750",
      synopsis: "Closes SENTRY-1234.",
    } as never)

    const objects = createWithDedup.mock.calls.map(
      (c) => (c[0] as { object: string }).object,
    )
    expect(objects).toContain("PR #25750")
    expect(objects).toContain("SENTRY-1234")
  })

  it("LORE_DISABLE_AUTO_MENTIONS=1 skips both pre-query and per-entity emission entirely", async () => {
    // Same kill switch as save — single-axis disable for the regex
    // tokenizer. Pinning that update-time emission honors the same
    // env var lets an operator distrust the tokenizer end-to-end with
    // one toggle.
    const mockServer = createMockServer()
    const updated = makeMemory("mem-update-disabled", {
      title: "Investigated PR #25750",
      projectIds: ["proj-a"],
    })
    const update = vi.fn().mockResolvedValue(updated)
    const queryBySourceMemory = vi.fn()
    const createWithDedup = vi.fn()

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { update, getById: vi.fn() },
      facts: { queryBySourceMemory, createWithDedup },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    vi.stubEnv("LORE_DISABLE_AUTO_MENTIONS", "1")
    try {
      const result = await lore({
        memoryId: "mem-update-disabled",
        title: "Investigated PR #25750",
      } as never)
      const text = (result as { content: Array<{ text: string }> }).content[0].text

      // Neither the pre-query nor the per-entity emission fire; no
      // advisory footer.
      expect(queryBySourceMemory).not.toHaveBeenCalled()
      expect(createWithDedup).not.toHaveBeenCalled()
      expect(text).not.toContain("Auto-mentions:")
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("update succeeds when a per-entity fact creation fails (failure-domain isolation)", async () => {
    // Same posture as save's failure-isolation test: one fact's
    // create rejects, the other lands, the update response is not
    // an error, and the partial-failure footer surfaces the split.
    //
    // Title is "Investigated PR #25750" — `Investigated` is in the
    // extractor stoplist so the multi-word phrase pattern can't
    // match, leaving exactly two candidates: `PR #25750` (PR
    // pattern) and `#25750` (issue-hash pattern). One reject + one
    // resolve gives a deterministic `1/2 new attempted` ratio so
    // the footer assertion can pin the exact count rather than a
    // permissive regex shape.
    const mockServer = createMockServer()
    const updated = makeMemory("mem-update-partial", {
      title: "Investigated PR #25750",
      projectIds: ["proj-a"],
    })
    const update = vi.fn().mockResolvedValue(updated)
    const queryBySourceMemory = vi.fn().mockResolvedValue([])
    const createWithDedup = vi
      .fn()
      .mockResolvedValueOnce({ fact: { id: "fact-ok" }, deduped: false, enriched: [] })
      .mockRejectedValueOnce(new Error("notion 503"))

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { update, getById: vi.fn() },
      facts: { queryBySourceMemory, createWithDedup },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    const result = await lore({
      memoryId: "mem-update-partial",
      title: "Investigated PR #25750",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect((result as { isError?: boolean }).isError).not.toBe(true)
    expect(text).toContain("Updated memory:")
    expect(createWithDedup).toHaveBeenCalledTimes(2)
    // Pin the exact ratio rather than a regex shape — guards
    // against an off-by-one in `results.filter(Boolean).length` or
    // a future refactor that flips success/failure semantics.
    expect(text).toContain("Auto-mentions: 1/2 new attempted")
  })

  it("update succeeds when the pre-query for existing mentions fails (degrades to assume-nothing-covered)", async () => {
    // A `queryBySourceMemory` failure must not block the update or
    // the surrounding emission — degrade to "assume nothing covered"
    // so `createWithDedup`'s own probe carries the dedup load.
    // Pinning that the update response is not an error guards against
    // the obvious refactor that swaps the try/catch for a bare await.
    const mockServer = createMockServer()
    const updated = makeMemory("mem-update-probefail", {
      title: "Reviewed PR #25750",
      projectIds: ["proj-a"],
    })
    const update = vi.fn().mockResolvedValue(updated)
    const queryBySourceMemory = vi.fn().mockRejectedValue(new Error("notion 500"))
    const createWithDedup = vi.fn().mockResolvedValue({
      fact: { id: "fact-x" },
      deduped: false,
      enriched: [],
    })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { update, getById: vi.fn() },
      facts: { queryBySourceMemory, createWithDedup },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    const result = await lore({
      memoryId: "mem-update-probefail",
      title: "Reviewed PR #25750",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect((result as { isError?: boolean }).isError).not.toBe(true)
    expect(text).toContain("Updated memory:")
    // Pre-query degraded to empty → every candidate was attempted.
    expect(createWithDedup).toHaveBeenCalled()
  })

  it("an update with no extractable entities skips the pre-query and emits no facts", async () => {
    // The branch short-circuits before `queryBySourceMemory` when
    // the extractor surfaces nothing, so a synopsis-only update on
    // a low-token title pays zero round-trips for the auto-mentions
    // path.
    const mockServer = createMockServer()
    const updated = makeMemory("mem-update-noentities", {
      title: "ok",
      projectIds: ["proj-a"],
      synopsis: "",
    })
    const update = vi.fn().mockResolvedValue(updated)
    const queryBySourceMemory = vi.fn()
    const createWithDedup = vi.fn()

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { update, getById: vi.fn() },
      facts: { queryBySourceMemory, createWithDedup },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    const result = await lore({
      memoryId: "mem-update-noentities",
      title: "ok",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(queryBySourceMemory).not.toHaveBeenCalled()
    expect(createWithDedup).not.toHaveBeenCalled()
    expect(text).not.toContain("Auto-mentions:")
  })

  it("omits projectIds when the resolved-update memory has no project scope", async () => {
    // Mirror of the save-side `omits projectIds when …` test — a
    // vault-wide auto-emit must pass `projectIds: undefined` not
    // `projectIds: []` to `createWithDedup`, matching the convention
    // the rest of the handler uses.
    const mockServer = createMockServer()
    const updated = makeMemory("mem-update-vaultwide", {
      title: "Reviewed PR #25750",
      projectIds: [],
    })
    const update = vi.fn().mockResolvedValue(updated)
    const queryBySourceMemory = vi.fn().mockResolvedValue([])
    const createWithDedup = vi.fn().mockResolvedValue({
      fact: { id: "fact-x" },
      deduped: false,
      enriched: [],
    })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { update, getById: vi.fn() },
      facts: { queryBySourceMemory, createWithDedup },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    await lore({
      memoryId: "mem-update-vaultwide",
      title: "Reviewed PR #25750",
    } as never)

    const firstCall = createWithDedup.mock.calls[0][0] as {
      projectIds?: string[]
    }
    expect(firstCall.projectIds).toBeUndefined()
  })

  it("does NOT fire the pre-query when the update touches no extraction-relevant fields", async () => {
    // Steady-state efficiency gate: an update that only mutates
    // confidence / status / tags / projectIds / etc. cannot change
    // the extraction surface, so running the pre-query just to
    // discover the existing covered-set is unchanged is pure waste.
    // The branch is gated on `args.title` / `args.keywords` /
    // `args.synopsis` being defined; this test pins that a
    // confidence-only update on a memory whose RESOLVED title would
    // produce extractable entities does not fire the pre-query.
    // Without the gate, every confidence-only update on a memory
    // titled `"Investigated PR #25750"` would round-trip to Notion
    // for the `queryBySourceMemory` probe.
    const mockServer = createMockServer()
    const updated = makeMemory("mem-update-confidence-only", {
      title: "Investigated PR #25750",
      projectIds: ["proj-a"],
      confidence: "certain",
    })
    const update = vi.fn().mockResolvedValue(updated)
    const queryBySourceMemory = vi.fn()
    const createWithDedup = vi.fn()

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { update, getById: vi.fn() },
      facts: { queryBySourceMemory, createWithDedup },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    const result = await lore({
      memoryId: "mem-update-confidence-only",
      confidence: "certain",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(queryBySourceMemory).not.toHaveBeenCalled()
    expect(createWithDedup).not.toHaveBeenCalled()
    expect(text).not.toContain("Auto-mentions:")
  })

  it("decodes HTML entities on candidates so the covered-set check matches createWithDedup's stored form", async () => {
    // `createWithDedup` decodes Subject/Object via `decodeTextEntities`
    // at its write boundary (`src/core/fact.ts`), so the existing
    // fact's `Object` value is the decoded form (`Foo & Bar`). The
    // raw extractor output for an update that surfaces the same
    // entity is the encoded form (`Foo &amp; Bar`). Without the
    // decode pass on candidates, the covered-set Set would treat
    // them as different strings, the candidate would be classified
    // as "new", `createWithDedup` would round-trip to Notion (its
    // dedup-key probe would catch the duplicate, returning
    // `deduped: true`), and the steady-state cost would be one
    // wasted Notion call per HTML-encoded entity per update.
    //
    // Pinning the decode here so a future contributor "simplifying"
    // the candidate normalization would break this test rather than
    // silently re-introducing the wasted-round-trip class of bug.
    const mockServer = createMockServer()
    const updated = makeMemory("mem-update-decoded", {
      // Use a multi-word capitalized phrase carrying `&amp;` —
      // matches the multi-word capitalized phrase pattern post-
      // decode (`Café & Bar` → both words capitalized) and is the
      // canonical PF1-06 bug class fixture.
      title: "Café &amp; Bar review",
      projectIds: ["proj-a"],
    })
    const update = vi.fn().mockResolvedValue(updated)
    // Stored fact's Object is already decoded — this is what
    // `createWithDedup` writes after decoding `Café &amp; Bar`.
    const queryBySourceMemory = vi
      .fn()
      .mockResolvedValue([{ id: "fact-pre", object: "Café & Bar" }])
    const createWithDedup = vi.fn()

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { update, getById: vi.fn() },
      facts: { queryBySourceMemory, createWithDedup },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    await lore({
      memoryId: "mem-update-decoded",
      title: "Café &amp; Bar review",
    } as never)

    // The candidate `Café &amp; Bar` decodes to `Café & Bar`, which
    // matches the stored fact → no fresh emission.
    const calls = createWithDedup.mock.calls.map(
      (c) => (c[0] as { object: string }).object,
    )
    expect(calls).not.toContain("Café &amp; Bar")
    expect(calls).not.toContain("Café & Bar")
  })
})

describe("lore-memory synopsis surface (issue 0.7.0/02)", () => {
  it("threads synopsis on action='save' through to memories.create", async () => {
    const mockServer = createMockServer()
    const created = makeMemory("mem-with-synopsis", {
      title: "Saved",
      synopsis: "One-line gist for the listings tier.",
    })
    const create = vi.fn().mockResolvedValue(created)
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create, list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    await remember({
      title: "Saved",
      content: "body",
      synopsis: "One-line gist for the listings tier.",
    } as never)

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Saved",
        synopsis: "One-line gist for the listings tier.",
      }),
    )
  })

  it("threads synopsis on action='update' through to memories.update", async () => {
    const mockServer = createMockServer()
    const updated = makeMemory("mem-1", { synopsis: "New synopsis" })
    const update = vi.fn().mockResolvedValue(updated)
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { update, getById: vi.fn() },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    await lore({
      memoryId: "mem-1",
      synopsis: "New synopsis",
    } as never)

    expect(update).toHaveBeenCalledWith(
      "mem-1",
      expect.objectContaining({ synopsis: "New synopsis" }),
    )
  })

  it("update with empty-string synopsis is forwarded as the explicit clear", async () => {
    // The boundary preserves the `""` semantic so MemoryService.update
    // can write a cleared rich_text. `undefined` (omitted) means leave
    // untouched — pinned in the next test.
    const mockServer = createMockServer()
    const update = vi.fn().mockResolvedValue(makeMemory("mem-1"))
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { update, getById: vi.fn() },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    await lore({ memoryId: "mem-1", synopsis: "" } as never)

    expect(update).toHaveBeenCalledWith(
      "mem-1",
      expect.objectContaining({ synopsis: "" }),
    )
  })

  it("update with no synopsis arg leaves the field untouched (forwards undefined)", async () => {
    const mockServer = createMockServer()
    const update = vi.fn().mockResolvedValue(makeMemory("mem-1"))
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { update, getById: vi.fn() },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    await lore({ memoryId: "mem-1", title: "Just renaming" } as never)

    const [, args] = update.mock.calls[0]
    expect(args.synopsis).toBeUndefined()
  })

  it("rejects synopsis longer than 500 chars at the Zod boundary", async () => {
    const mockServer = createMockServer()
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create: vi.fn(),
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")
    const overCap = "x".repeat(501)

    const result = await remember({
      title: "Saved",
      content: "body",
      synopsis: overCap,
    } as never)

    const wrapped = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(wrapped.isError).toBe(true)
    expect(wrapped.content[0].text).toContain("synopsis")
    // The save was rejected; create was never invoked.
    expect(services.memories.create).not.toHaveBeenCalled()
  })

  // Note: write-time decode coverage for synopsis lives where the
  // decode actually fires:
  //   - MemoryService.create / update — `src/core/memory.test.ts`
  //   - DecisionService.create — `src/core/decision.test.ts`
  //   - TaskService.create / update — `src/core/task.test.ts`
  // Keep the proof at the seam, not at the helper.
})

describe("lore-recall synopsis rendering (issue 0.7.0/03)", () => {
  // Pins the four-cell `includeContent` × synopsis-non-empty matrix on
  // the recall surface. The pre-#03 cells (no synopsis) must remain
  // byte-identical so existing fixtures and agent expectations don't
  // shift on the no-synopsis path.

  function buildRecallServices(memory: Memory) {
    const memoriesList = vi.fn().mockResolvedValue({ items: [memory] })
    return {
      topics: { findByName: vi.fn() },
      memories: { list: memoriesList },
      projects: { findByName: vi.fn() },
      context: { project: null },
    }
  }

  it("includeContent=false, no synopsis → byte-identical pre-#03 row", async () => {
    const mockServer = createMockServer()
    const services = buildRecallServices(
      makeMemory("mem-1", { title: "OAuth handshake notes", tags: ["auth"] }),
    )

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

    const result = await recall({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("### OAuth handshake notes\n*manual | auth | 2026-04-20*")
  })

  it("includeContent=false, synopsis → synopsis line between heading and meta", async () => {
    const mockServer = createMockServer()
    const services = buildRecallServices(
      makeMemory("mem-1", {
        title: "OAuth handshake notes",
        tags: ["auth"],
        synopsis: "Outlook callbacks fail because the redirect URI is not allow-listed.",
      }),
    )

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

    const result = await recall({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain(
      "### OAuth handshake notes\n" +
        "Outlook callbacks fail because the redirect URI is not allow-listed.\n" +
        "*manual | auth | 2026-04-20*",
    )
  })

  it("includeContent=true, no synopsis → byte-identical pre-#03 body-on row", async () => {
    const mockServer = createMockServer()
    const services = buildRecallServices(
      makeMemory("mem-1", {
        title: "OAuth handshake notes",
        tags: ["auth"],
        content: "Body paragraph.",
      }),
    )

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

    const result = await recall({ includeContent: true } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain(
      "### OAuth handshake notes\n*manual | auth | 2026-04-20*\n\nBody paragraph.",
    )
  })

  it("includeContent=true, synopsis → synopsis above meta, body below", async () => {
    const mockServer = createMockServer()
    const services = buildRecallServices(
      makeMemory("mem-1", {
        title: "OAuth handshake notes",
        tags: ["auth"],
        synopsis: "Outlook callbacks fail.",
        content: "Body paragraph.",
      }),
    )

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

    const result = await recall({ includeContent: true } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain(
      "### OAuth handshake notes\n" +
        "Outlook callbacks fail.\n" +
        "*manual | auth | 2026-04-20*\n\n" +
        "Body paragraph.",
    )
  })

  it("includeSynopsis=false restores byte-identical pre-#03 output (body-off)", async () => {
    const mockServer = createMockServer()
    const services = buildRecallServices(
      makeMemory("mem-1", {
        title: "OAuth handshake notes",
        tags: ["auth"],
        synopsis: "This synopsis should not render.",
      }),
    )

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

    const result = await recall({ includeSynopsis: false } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).not.toContain("This synopsis should not render.")
    expect(text).toContain("### OAuth handshake notes\n*manual | auth | 2026-04-20*")
  })

  it("includeSynopsis=false restores byte-identical pre-#03 output (body-on)", async () => {
    const mockServer = createMockServer()
    const services = buildRecallServices(
      makeMemory("mem-1", {
        title: "OAuth handshake notes",
        tags: ["auth"],
        synopsis: "This synopsis should not render.",
        content: "Body paragraph.",
      }),
    )

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

    const result = await recall({
      includeContent: true,
      includeSynopsis: false,
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).not.toContain("This synopsis should not render.")
    expect(text).toContain(
      "### OAuth handshake notes\n*manual | auth | 2026-04-20*\n\nBody paragraph.",
    )
  })

  it("preserves the multi-row separator with mixed-synopsis rows", async () => {
    // Pins the row separator from the spec's acceptance criteria.
    const mockServer = createMockServer()
    const memoriesList = vi.fn().mockResolvedValue({
      items: [
        makeMemory("mem-1", {
          title: "With synopsis",
          tags: ["auth"],
          synopsis: "First row has a synopsis.",
        }),
        makeMemory("mem-2", { title: "Without synopsis", tags: ["auth"] }),
      ],
    })
    const services = {
      topics: { findByName: vi.fn() },
      memories: { list: memoriesList },
      projects: { findByName: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

    const result = await recall({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain(
      "### With synopsis\n" +
        "First row has a synopsis.\n" +
        "*manual | auth | 2026-04-20*\n\n---\n\n" +
        "### Without synopsis\n" +
        "*manual | auth | 2026-04-20*",
    )
  })

  it("does not add a Notion round-trip when synopsis renders (property rides the dataSources.query response)", async () => {
    const mockServer = createMockServer()
    const memoriesList = vi.fn().mockResolvedValue({
      items: [
        makeMemory("mem-1", {
          title: "Synopsis rendered",
          synopsis: "rides along on the property payload",
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
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

    await recall({} as never)

    // Exactly one list call; recall does not fan out per row.
    expect(memoriesList).toHaveBeenCalledTimes(1)
  })
})

describe("lore-search synopsis rendering (issue 0.7.0/03)", () => {
  function buildSearchServices(memory: Memory) {
    const memoriesSearch = vi.fn().mockResolvedValue([memory])
    return {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { search: memoriesSearch, list: vi.fn() },
      context: { project: null },
    }
  }

  it("renders synopsis between heading and meta on the body-off path", async () => {
    const mockServer = createMockServer()
    const services = buildSearchServices(
      makeMemory("mem-1", {
        title: "Search hit",
        tags: ["auth"],
        synopsis: "One-line gist.",
      }),
    )

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const search = mockServer.getActionHandler("lore-query", "search")

    const result = await search({ query: "auth" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain(
      "### Search hit\nOne-line gist.\n*manual | auth | 2026-04-20*",
    )
  })

  it("renders synopsis above meta and body below on the body-on path", async () => {
    const mockServer = createMockServer()
    const services = buildSearchServices(
      makeMemory("mem-1", {
        title: "Search hit",
        tags: ["auth"],
        synopsis: "One-line gist.",
        content: "Body paragraph.",
      }),
    )

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const search = mockServer.getActionHandler("lore-query", "search")

    const result = await search({ query: "auth", includeContent: true } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain(
      "### Search hit\n" +
        "One-line gist.\n" +
        "*manual | auth | 2026-04-20*\n\n" +
        "Body paragraph.",
    )
  })

  it("renders the optional Score trace footer below the memory list when explain=true", async () => {
    const mockServer = createMockServer()
    const memoriesSearchWithExplain = vi.fn().mockResolvedValue({
      memories: [
        makeMemory("mem-1", {
          title: "Search hit",
          synopsis: "synopsis line",
        }),
      ],
      explain: [
        {
          memoryId: "mem-1",
          containsRank: 0,
          semanticRank: null,
          rrfScore: null,
          branch: "contains-only",
          confidenceFactor: 1.0,
        },
      ],
    })
    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: {
        search: vi.fn(),
        searchWithExplain: memoriesSearchWithExplain,
        list: vi.fn(),
      },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const search = mockServer.getActionHandler("lore-query", "search")

    const result = await search({ query: "auth", explain: true } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    // Synopsis rendered, then the score trace footer below.
    const synopsisIdx = text.indexOf("synopsis line")
    const traceIdx = text.indexOf("## Score trace")
    expect(synopsisIdx).toBeGreaterThan(-1)
    expect(traceIdx).toBeGreaterThan(synopsisIdx)
  })

  it("includeSynopsis=false restores byte-identical pre-#03 search output", async () => {
    const mockServer = createMockServer()
    const services = buildSearchServices(
      makeMemory("mem-1", {
        title: "Search hit",
        tags: ["auth"],
        synopsis: "Should not appear.",
      }),
    )

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const search = mockServer.getActionHandler("lore-query", "search")

    const result = await search({
      query: "auth",
      includeSynopsis: false,
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).not.toContain("Should not appear.")
    expect(text).toContain("### Search hit\n*manual | auth | 2026-04-20*")
  })
})

// ---------------------------------------------------------------------------
// touch-on-read wiring (issue 0.8.0/05)
//
// Pins the citation-as-evidence contract at the MCP boundary: every
// surfaced memory on recall / search / expand passes through
// `MemoryService.touchOnRead`. The data-layer touch algebra is
// independently pinned by `src/core/memory.test.ts`'s
// `MemoryService.touchOnRead` block; these tests are about the wiring,
// not the algebra.
// ---------------------------------------------------------------------------

describe("lore-query action='recall' — touch-on-read wiring (issue 0.8.0/05)", () => {
  it("touches every returned memory after recall composes its response", async () => {
    const mockServer = createMockServer()
    const m1 = makeMemory("mem-1", { title: "A" })
    const m2 = makeMemory("mem-2", { title: "B" })
    const memoriesList = vi.fn().mockResolvedValue({ items: [m1, m2] })
    const touchOnRead = vi.fn().mockResolvedValue(undefined)

    const services = {
      topics: { findByName: vi.fn() },
      memories: { list: memoriesList, touchOnRead },
      projects: { findByName: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

    const result = await recall({} as never)
    expect((result as { isError?: boolean }).isError).not.toBe(true)
    expect(touchOnRead).toHaveBeenCalledTimes(1)
    const passed = touchOnRead.mock.calls[0]![0] as Memory[]
    expect(passed.map((m) => m.id)).toEqual(["mem-1", "mem-2"])
  })

  it("does not invoke touchOnRead when the recall result is empty", async () => {
    const mockServer = createMockServer()
    const memoriesList = vi.fn().mockResolvedValue({ items: [] })
    const touchOnRead = vi.fn().mockResolvedValue(undefined)

    const services = {
      topics: { findByName: vi.fn() },
      memories: { list: memoriesList, touchOnRead },
      projects: { findByName: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

    await recall({} as never)
    // Empty-input touchOnRead is a no-op at the data layer, but the
    // wiring layer doesn't bother calling it — saves one allocation
    // per zero-result recall.
    expect(touchOnRead).not.toHaveBeenCalled()
  })

  it("does not surface a touchOnRead failure as a tool error", async () => {
    // Touch is advisory — a 429 / network blip on the post-response
    // write must not poison the rendered response. This pins the
    // try/catch isolation around the touch call.
    const mockServer = createMockServer()
    const memoriesList = vi
      .fn()
      .mockResolvedValue({ items: [makeMemory("mem-1", { title: "A" })] })
    const touchOnRead = vi.fn().mockRejectedValue(new Error("notion 429"))

    const services = {
      topics: { findByName: vi.fn() },
      memories: { list: memoriesList, touchOnRead },
      projects: { findByName: vi.fn() },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

    const result = await recall({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect((result as { isError?: boolean }).isError).not.toBe(true)
    expect(text).toContain("### A")
  })
})

describe("lore-query action='search' — touch-on-read wiring (issue 0.8.0/05)", () => {
  it("touches every returned search result after the response composes", async () => {
    const mockServer = createMockServer()
    const m1 = makeMemory("mem-1", { title: "Hit one" })
    const m2 = makeMemory("mem-2", { title: "Hit two" })
    const memoriesSearch = vi.fn().mockResolvedValue([m1, m2])
    const touchOnRead = vi.fn().mockResolvedValue(undefined)

    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { search: memoriesSearch, list: vi.fn(), touchOnRead },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const search = mockServer.getActionHandler("lore-query", "search")

    await search({ query: "auth" } as never)
    expect(touchOnRead).toHaveBeenCalledTimes(1)
    const passed = touchOnRead.mock.calls[0]![0] as Memory[]
    expect(passed.map((m) => m.id)).toEqual(["mem-1", "mem-2"])
  })

  it("touches the post-limit slice, not the full over-fetch window", async () => {
    // Semantic mode over-fetches by 2× to give the post-filter
    // headroom; the wiring touches the SLICED results so a touch
    // batch reflects what the agent actually sees.
    const mockServer = createMockServer()
    const memoriesSearch = vi.fn().mockResolvedValue([
      makeMemory("mem-1"),
      makeMemory("mem-2"),
      makeMemory("mem-3"),
      makeMemory("mem-4"),
    ])
    const touchOnRead = vi.fn().mockResolvedValue(undefined)

    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { search: memoriesSearch, list: vi.fn(), touchOnRead },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const search = mockServer.getActionHandler("lore-query", "search")

    await search({ query: "auth", limit: 2, mode: "semantic" } as never)
    const passed = touchOnRead.mock.calls[0]![0] as Memory[]
    expect(passed.map((m) => m.id)).toEqual(["mem-1", "mem-2"])
  })
})

describe("lore-memory action='expand' — touch-on-read wiring (issue 0.8.0/05)", () => {
  const ID_A = "11111111-1111-4111-8111-111111111111"
  const ID_B = "22222222-2222-4222-8222-222222222222"

  it("touches the expanded memories on a successful expand call", async () => {
    const mockServer = createMockServer()
    const getById = vi.fn(async (id: string) =>
      makeMemory(id, { title: `Title ${id}`, content: `Body ${id}` }),
    )
    const touchOnRead = vi.fn().mockResolvedValue(undefined)

    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { getById, touchOnRead },
      context: { project: null },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const expand = mockServer.getActionHandler("lore-memory", "expand")

    await expand({ ids: [ID_A, ID_B] } as never)
    expect(touchOnRead).toHaveBeenCalledTimes(1)
    const passed = touchOnRead.mock.calls[0]![0] as Memory[]
    expect(passed.map((m) => m.id).sort()).toEqual([ID_A, ID_B].sort())
  })

  it("only touches successfully-hydrated rows when one fetch fails", async () => {
    // The 404 row already surfaces as `(unresolved: ...)` to the
    // agent — re-touching it would duplicate the failure mode without
    // any signal value, so the wiring filters partial-failures out
    // before invoking touchOnRead.
    const mockServer = createMockServer()
    const getById = vi.fn(async (id: string) => {
      if (id === ID_B) throw new Error("notion 404")
      return makeMemory(id, { title: `Title ${id}`, content: `Body ${id}` })
    })
    const touchOnRead = vi.fn().mockResolvedValue(undefined)

    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { getById, touchOnRead },
      context: { project: null },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const expand = mockServer.getActionHandler("lore-memory", "expand")

    await expand({ ids: [ID_A, ID_B] } as never)
    const passed = touchOnRead.mock.calls[0]![0] as Memory[]
    expect(passed.map((m) => m.id)).toEqual([ID_A])
  })

  it("does not invoke touchOnRead when every fetch failed", async () => {
    const mockServer = createMockServer()
    const getById = vi.fn(async () => {
      throw new Error("notion 503")
    })
    const touchOnRead = vi.fn().mockResolvedValue(undefined)

    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { getById, touchOnRead },
      context: { project: null },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const expand = mockServer.getActionHandler("lore-memory", "expand")

    const result = await expand({ ids: [ID_A] } as never)
    expect((result as { isError?: boolean }).isError).not.toBe(true)
    expect(touchOnRead).not.toHaveBeenCalled()
  })
})
