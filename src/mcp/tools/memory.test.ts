import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { registerMemoryTools } from "./memory.js"
import { registerQueryTools } from "./query.js"
import { RICH_TEXT_PROPERTY_MAX_LEN } from "../../core/rich-text-schema.js"
import {
  appendCompareDispatchLedgerEntry,
  buildCompareDispatchLedgerEntry,
  COMPARE_NOTES_MAX_CHARS,
  MemoryUpdatePartialFailureError,
  RekeyAuditError,
} from "../../core/memory.js"
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
        handler: (...args: never[]) => Promise<unknown>
      ) => {
        configs.set(name, config)
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
     * tests can call it with action-specific args alone. Equivalent to
     * the prior alias-handler shape — the polymorphic dispatcher's
     * discriminated union still validates the per-action schema.
     */
    getActionHandler(toolName: string, action: string) {
      const handler = handlers.get(toolName)
      if (!handler) throw new Error(`missing handler ${toolName}`)
      return (args: Record<string, unknown>) => handler({ ...args, action } as never)
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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

  it("rejects an unresolved explicit projectName before creating a memory", async () => {
    const mockServer = createMockServer()
    const services = {
      projects: { findByName: vi.fn().mockResolvedValue(null) },
      topics: { getOrCreate: vi.fn() },
      memories: { create: vi.fn(), upsertByTopicKey: vi.fn() },
      context: {
        project: { id: "proj-ambient", name: "Ambient" },
        isCatchAllFallback: false,
      },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const save = mockServer.getActionHandler("lore-memory", "save")

    const result = await save({
      title: "Saved",
      content: "body",
      projectName: "Missing",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(text).toContain('Project "Missing" could not be resolved')
    expect(text).toContain("Fix the project scope")
    expect(services.topics.getOrCreate).not.toHaveBeenCalled()
    expect(services.memories.create).not.toHaveBeenCalled()
    expect(services.memories.upsertByTopicKey).not.toHaveBeenCalled()
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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

describe("lore-memory action='archive'", () => {
  it("clears the decision cache after archiving a memory", async () => {
    const mockServer = createMockServer()
    const archive = vi.fn().mockResolvedValue(undefined)
    const clearDecisionCache = vi.fn()
    const services = {
      memories: { archive },
      decisions: { clearCache: clearDecisionCache },
    }

    registerMemoryTools(mockServer.server, services as never)
    const archiveMemory = mockServer.getActionHandler("lore-memory", "archive")

    const result = await archiveMemory({ memoryId: "dec-cached" } as never)

    const text = (result as { content: Array<{ text: string }>; isError?: boolean })
      .content[0].text
    expect(text).toBe("Archived memory dec-cached")
    expect(archive).toHaveBeenCalledWith("dec-cached")
    expect(clearDecisionCache).toHaveBeenCalledTimes(1)
    expect(archive.mock.invocationCallOrder[0]).toBeLessThan(
      clearDecisionCache.mock.invocationCallOrder[0]
    )
  })

  it("does not clear the decision cache when archive fails", async () => {
    const mockServer = createMockServer()
    const archive = vi.fn().mockRejectedValue(new Error("notion 503"))
    const clearDecisionCache = vi.fn()
    const services = {
      memories: { archive },
      decisions: { clearCache: clearDecisionCache },
    }

    registerMemoryTools(mockServer.server, services as never)
    const archiveMemory = mockServer.getActionHandler("lore-memory", "archive")

    const result = await archiveMemory({ memoryId: "dec-cached" } as never)

    const wrapped = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(wrapped.isError).toBe(true)
    expect(wrapped.content[0].text).toContain("Error: notion 503")
    expect(clearDecisionCache).not.toHaveBeenCalled()
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
      memories: {
        create: vi.fn().mockResolvedValue(created),
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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

    expect(getOrCreate).toHaveBeenCalledWith("Eval & Testing", ["proj-a"], {
      forceNew: true,
    })
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
      memories: {
        create: vi.fn().mockResolvedValue(created),
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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

  it("warns when topicName is skipped because no project scope resolved", async () => {
    const mockServer = createMockServer()
    const created = makeMemory("mem-unscoped", { title: "unscoped topic skip" })
    const getOrCreate = vi.fn()
    const create = vi.fn().mockResolvedValue(created)

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate },
      memories: { create },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "unscoped topic skip",
      content: "body",
      topicName: "Eval & Testing",
    } as never)

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectIds: undefined,
        topicId: undefined,
      })
    )
    expect(getOrCreate).not.toHaveBeenCalled()
    expect(text).toContain("Topic: none")
    expect(text).toContain(
      'Warnings: Topic "Eval & Testing" skipped (requires at least one project)'
    )
  })

  it("warns and updates other fields when update topicName has no project scope", async () => {
    const mockServer = createMockServer()
    const updated = makeMemory("mem-unscoped-update", {
      title: "unscoped topic update",
      projectIds: [],
    })
    const current = makeMemory("mem-unscoped-update", {
      title: "before",
      projectIds: [],
    })
    const getOrCreate = vi.fn()
    const update = vi.fn().mockResolvedValue(updated)

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate },
      memories: { update, getById: vi.fn().mockResolvedValue(current) },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const updateMemory = mockServer.getActionHandler("lore-memory", "update")

    const result = await updateMemory({
      memoryId: "mem-unscoped-update",
      content: "body changed",
      topicName: "Eval & Testing",
    } as never)

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(update).toHaveBeenCalledWith(
      "mem-unscoped-update",
      expect.objectContaining({
        content: "body changed",
        projectIds: undefined,
        topicId: undefined,
      })
    )
    expect(getOrCreate).not.toHaveBeenCalled()
    expect(text).toContain('Updated memory: "unscoped topic update"')
    expect(text).toContain(
      'Warnings: Topic "Eval & Testing" skipped (requires at least one project)'
    )
  })

  it("surfaces the SimilarTopicError message back through toolError", async () => {
    // When the probe rejects, getOrCreate throws; the tool layer's
    // try/catch routes the message into the `Error: ...` content.
    const mockServer = createMockServer()
    const getOrCreate = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'Topic "GraphQLL Federation" looks similar to 1 existing topic in this project:\n  - "GraphQL Federation" (similarity 0.86, id: t-1)\nUse one of the existing topic names verbatim, or pass `forceNew: true` to create a new topic anyway.'
        )
      )

    const services = {
      projects: { findByName: vi.fn().mockResolvedValue({ id: "proj-a", name: "a" }) },
      topics: { getOrCreate },
      memories: { create: vi.fn(), list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      })
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({ title: "Some title", content: "body" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("Saved memory:")
    expect(text).not.toContain("Warning:")
  })

  it("fails closed when the autosave-learning duplicate probe query fails", async () => {
    const mockServer = createMockServer()
    const list = vi.fn().mockRejectedValue(new Error("notion 503"))
    const createWithResult = vi.fn()
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { createWithResult, list },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    vi.stubEnv("LORE_BACKGROUND_AGENT", "true")
    try {
      registerMemoryTools(mockServer.server, services as never)
      registerQueryTools(mockServer.server, services as never)
      const remember = mockServer.getActionHandler("lore-memory", "save")

      const result = await remember({
        title: "relation filters reject empty arrays",
        content: "Notion dataSources.query rejects relation filters with empty arrays.",
        kind: "note",
        confidence: "likely",
        session: "session-1",
        agent: "Codex",
      } as never)
      const toolResult = result as {
        isError?: boolean
        content: Array<{ text: string }>
      }

      expect(toolResult.isError).toBe(true)
      expect(toolResult.content[0].text).toContain(
        "Autosave learning duplicate probe failed; refusing to create a possible duplicate."
      )
      expect(createWithResult).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe("lore-memory action='save' autosave-learning structural dedup", () => {
  it("returns same-session duplicates with the dropped metadata footer", async () => {
    const mockServer = createMockServer()
    const existing = makeMemory("mem-existing", {
      title: "relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectIds: ["proj-a"],
      source: "conversation",
      kind: "note",
      confidence: "likely",
      session: "session-1",
    })
    const create = vi.fn()
    const list = vi.fn().mockResolvedValue({ items: [existing] })
    const record = vi.fn()
    const getOrCreate = vi.fn()
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate },
      memories: { create, list },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record, get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    vi.stubEnv("LORE_BACKGROUND_AGENT", "true")
    try {
      registerMemoryTools(mockServer.server, services as never)
      registerQueryTools(mockServer.server, services as never)
      const remember = mockServer.getActionHandler("lore-memory", "save")

      const result = await remember({
        title: "relation filters reject empty arrays",
        content: "Notion dataSources.query rejects relation filters with empty arrays.",
        kind: "note",
        confidence: "likely",
        session: "session-1",
        agent: "Codex",
      } as never)

      const text = (result as { content: Array<{ text: string }> }).content[0].text
      expect(text).toContain("Reused existing autosave learning")
      expect(text).toContain("same-session duplicate")
      expect(text).toContain("mem-existing")
      expect(create).not.toHaveBeenCalled()
      expect(getOrCreate).not.toHaveBeenCalled()
      expect(record).toHaveBeenCalledWith(
        { agent: "Codex", session: "session-1" },
        { memoryId: "mem-existing", projectIds: ["proj-a"] }
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("reuses a prior-session project learning instead of creating a cross-session duplicate", async () => {
    const mockServer = createMockServer()
    const existing = makeMemory("mem-existing", {
      title: "relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectIds: ["proj-a"],
      source: "conversation",
      kind: "note",
      confidence: "likely",
      session: "session-1",
    })
    const create = vi.fn()
    const list = vi.fn().mockResolvedValue({ items: [existing] })
    const record = vi.fn()
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create, list },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record, get: vi.fn() },
      identity: { author: null },
    }

    vi.stubEnv("LORE_BACKGROUND_AGENT", "true")
    try {
      registerMemoryTools(mockServer.server, services as never)
      registerQueryTools(mockServer.server, services as never)
      const remember = mockServer.getActionHandler("lore-memory", "save")

      const result = await remember({
        title: "relation filters reject empty arrays",
        content: "Notion dataSources.query rejects relation filters with empty arrays.",
        kind: "note",
        confidence: "likely",
        session: "session-2",
        agent: "Codex",
      } as never)

      const text = (result as { content: Array<{ text: string }> }).content[0].text
      expect(text).toContain("Reused existing autosave learning")
      expect(text).toContain("cross-session duplicate")
      expect(text).toContain("mem-existing")
      expect(text).toContain("LORE_DISABLE_AUTOSAVE_LEARNING_DEDUP=1")
      expect(create).not.toHaveBeenCalled()
      expect(record).toHaveBeenCalledWith(
        { agent: "Codex", session: "session-2" },
        { memoryId: "mem-existing", projectIds: ["proj-a"] }
      )
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj-a",
          session: undefined,
          source: "conversation",
          kind: "note",
          confidence: "likely",
          includeContent: true,
          includeUnscoped: true,
        })
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("falls back to same-session dedup for an auto-resolved catch-all project", async () => {
    const mockServer = createMockServer()
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const existing = makeMemory("mem-existing", {
      title: "relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectIds: ["proj-catchall"],
      source: "conversation",
      kind: "note",
      confidence: "likely",
      session: "session-1",
    })
    const created = makeMemory("mem-created", {
      title: "relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectIds: ["proj-catchall"],
      source: "conversation",
      kind: "note",
      confidence: "likely",
      session: "session-2",
    })
    const create = vi.fn().mockResolvedValue(created)
    const list = vi.fn(async (opts: { session?: string; includeContent?: boolean }) => {
      if (opts.includeContent && opts.session === "session-2") {
        return { items: [] }
      }
      return { items: [existing] }
    })
    const record = vi.fn()
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create, list },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      context: {
        project: { id: "proj-catchall", name: "Mail" },
        isCatchAllFallback: true,
      },
      config: { projects: [] },
      sessionMemories: { record, get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
      facts: { createWithDedup: vi.fn() },
    }

    vi.stubEnv("LORE_BACKGROUND_AGENT", "true")
    vi.stubEnv("LORE_DEBUG", "1")
    try {
      registerMemoryTools(mockServer.server, services as never)
      registerQueryTools(mockServer.server, services as never)
      const remember = mockServer.getActionHandler("lore-memory", "save")

      const result = await remember({
        title: "relation filters reject empty arrays",
        content: "Notion dataSources.query rejects relation filters with empty arrays.",
        kind: "note",
        confidence: "likely",
        session: "session-2",
        agent: "Codex",
      } as never)

      const text = (result as { content: Array<{ text: string }> }).content[0].text
      expect(text).toContain('Saved memory: "relation filters reject empty arrays"')
      expect(text).not.toContain("Reused existing autosave learning")
      expect(create).toHaveBeenCalledTimes(1)
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj-catchall",
          session: "session-2",
          source: "conversation",
          kind: "note",
          confidence: "likely",
          includeContent: true,
        })
      )
      const stderr = stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join("")
      expect(stderr).toContain("autosave-learning-dedup-scope-downgrade")
      expect(stderr).toContain("reason=catch-all-fallback")
      expect(stderr).toContain('projectId="proj-catchall"')
      expect(stderr).toContain('session="session-2"')
    } finally {
      stderrSpy.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it("honors explicit project scope even when context is a catch-all fallback", async () => {
    const mockServer = createMockServer()
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const existing = makeMemory("mem-existing", {
      title: "relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectIds: ["proj-specific"],
      source: "conversation",
      kind: "note",
      confidence: "likely",
      session: "session-1",
    })
    const create = vi.fn()
    const list = vi.fn().mockResolvedValue({ items: [existing] })
    const findByName = vi.fn(async (name: string) =>
      name === "Specific" ? { id: "proj-specific", name: "Specific" } : null
    )
    const record = vi.fn()
    const services = {
      projects: { findByName },
      topics: { getOrCreate: vi.fn() },
      memories: { create, list },
      context: {
        project: { id: "proj-catchall", name: "Mail" },
        isCatchAllFallback: true,
      },
      config: { projects: [] },
      sessionMemories: { record, get: vi.fn() },
      identity: { author: null },
    }

    vi.stubEnv("LORE_BACKGROUND_AGENT", "true")
    vi.stubEnv("LORE_DEBUG", "1")
    try {
      registerMemoryTools(mockServer.server, services as never)
      registerQueryTools(mockServer.server, services as never)
      const remember = mockServer.getActionHandler("lore-memory", "save")

      const result = await remember({
        title: "relation filters reject empty arrays",
        content: "Notion dataSources.query rejects relation filters with empty arrays.",
        kind: "note",
        confidence: "likely",
        session: "session-2",
        agent: "Codex",
        projectName: "Specific",
      } as never)

      const text = (result as { content: Array<{ text: string }> }).content[0].text
      expect(text).toContain("Reused existing autosave learning")
      expect(text).toContain("cross-session duplicate")
      expect(text).toContain("mem-existing")
      expect(create).not.toHaveBeenCalled()
      expect(findByName).toHaveBeenCalledWith("Specific")
      expect(record).toHaveBeenCalledWith(
        { agent: "Codex", session: "session-2" },
        { memoryId: "mem-existing", projectIds: ["proj-specific"] }
      )
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj-specific",
          session: undefined,
          source: "conversation",
          kind: "note",
          confidence: "likely",
          includeContent: true,
          includeUnscoped: true,
        })
      )
      expect(list).not.toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj-specific",
          session: "session-2",
          includeContent: true,
        })
      )
      const stderr = stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join("")
      expect(stderr).not.toContain("autosave-learning-dedup-scope-downgrade")
    } finally {
      stderrSpy.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it("labels reused legacy learnings without a stored session as unknown-session", async () => {
    const mockServer = createMockServer()
    const existing = makeMemory("mem-existing", {
      title: "relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectIds: ["proj-a"],
      source: "conversation",
      kind: "note",
      confidence: "likely",
      session: null,
    })
    const create = vi.fn()
    const list = vi.fn().mockResolvedValue({ items: [existing] })
    const record = vi.fn()
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create, list },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record, get: vi.fn() },
      identity: { author: null },
    }

    vi.stubEnv("LORE_BACKGROUND_AGENT", "true")
    try {
      registerMemoryTools(mockServer.server, services as never)
      registerQueryTools(mockServer.server, services as never)
      const remember = mockServer.getActionHandler("lore-memory", "save")

      const result = await remember({
        title: "relation filters reject empty arrays",
        content: "Notion dataSources.query rejects relation filters with empty arrays.",
        kind: "note",
        confidence: "likely",
        session: "session-2",
        agent: "Codex",
      } as never)

      const text = (result as { content: Array<{ text: string }> }).content[0].text
      expect(text).toContain("Reused existing autosave learning")
      expect(text).toContain("unknown-session duplicate")
      expect(create).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("does not create a requested topic when the service-layer recheck reuses a duplicate", async () => {
    const mockServer = createMockServer()
    const existing = makeMemory("mem-existing", {
      title: "relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectIds: ["proj-a"],
      source: "conversation",
      kind: "note",
      confidence: "likely",
      session: "session-1",
    })
    const duplicate = {
      id: existing.id,
      title: existing.title,
      titleSimilarity: 1,
      tagOverlap: 0,
      decidedAt: existing.decidedAt,
      status: existing.status,
      memory: existing,
      projectIds: existing.projectIds,
      session: existing.session,
      contentSimilarity: 1,
      combinedSimilarity: 1,
      tokenSimilarity: 1,
    }
    const getOrCreate = vi.fn()
    const createWithResult = vi.fn(async () => ({
      memory: existing,
      autosaveLearningDuplicate: duplicate,
      freshCreatePreparation: null,
    }))
    const services = {
      projects: { findByName: vi.fn(async () => ({ id: "proj-a", name: "A" })) },
      topics: { getOrCreate },
      memories: {
        createWithResult,
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      facts: { createWithDedup: vi.fn() },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    vi.stubEnv("LORE_BACKGROUND_AGENT", "true")
    try {
      registerMemoryTools(mockServer.server, services as never)
      registerQueryTools(mockServer.server, services as never)
      const remember = mockServer.getActionHandler("lore-memory", "save")

      const result = await remember({
        title: "relation filters reject empty arrays",
        content: "Notion dataSources.query rejects relation filters with empty arrays.",
        kind: "note",
        confidence: "likely",
        session: "session-2",
        agent: "Codex",
        projectName: "A",
        topicName: "Auth Models",
      } as never)

      const text = (result as { content: Array<{ text: string }> }).content[0].text
      expect(text).toContain("Reused existing autosave learning")
      expect(getOrCreate).not.toHaveBeenCalled()
      expect(createWithResult).toHaveBeenCalledWith(
        expect.objectContaining({
          prepareFreshCreate: expect.any(Function),
        })
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("passes vault scope into projectless autosave-learning service locks", async () => {
    const mockServer = createMockServer()
    const created = makeMemory("mem-created", {
      title: "relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectIds: [],
      source: "conversation",
      kind: "note",
      confidence: "likely",
      session: "session-2",
    })
    const createWithResult = vi.fn(async () => ({
      memory: created,
      autosaveLearningDuplicate: null,
      freshCreatePreparation: null,
    }))
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: {
        createWithResult,
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      facts: { createWithDedup: vi.fn() },
      context: {
        vault: { pageId: "vault-a" },
        project: null,
        cwd: "/tmp/vault-a",
        isCatchAllFallback: false,
      },
      config: { projects: [] },
      configRoot: "/tmp/vault-a",
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    vi.stubEnv("LORE_BACKGROUND_AGENT", "true")
    try {
      registerMemoryTools(mockServer.server, services as never)
      registerQueryTools(mockServer.server, services as never)
      const remember = mockServer.getActionHandler("lore-memory", "save")

      const result = await remember({
        title: "relation filters reject empty arrays",
        content: "Notion dataSources.query rejects relation filters with empty arrays.",
        kind: "note",
        confidence: "likely",
        session: "session-2",
        agent: "Codex",
      } as never)

      const text = (result as { content: Array<{ text: string }> }).content[0].text
      expect(text).toContain('Saved memory: "relation filters reject empty arrays"')
      expect(createWithResult).toHaveBeenCalledWith(
        expect.objectContaining({
          autosaveLearningDedupScope: "session",
          autosaveLearningScopeId: "vault-a",
        })
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("opts foreground likely session saves out of the autosave-learning service gate", async () => {
    const mockServer = createMockServer()
    const created = makeMemory("mem-created", {
      title: "relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectIds: ["proj-a"],
      topicId: "topic-auth",
      source: "conversation",
      kind: "note",
      confidence: "likely",
      session: "session-2",
    })
    const createWithResult = vi.fn(async () => ({
      memory: created,
      autosaveLearningDuplicate: null,
      freshCreatePreparation: null,
    }))
    const getOrCreate = vi.fn(async () =>
      makeTopic("topic-auth", { name: "Auth Models" })
    )
    const services = {
      projects: { findByName: vi.fn(async () => ({ id: "proj-a", name: "A" })) },
      topics: { getOrCreate },
      memories: {
        createWithResult,
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      facts: { createWithDedup: vi.fn() },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      kind: "note",
      confidence: "likely",
      session: "session-2",
      agent: "Codex",
      projectName: "A",
      topicName: "Auth Models",
    } as never)

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain('Saved memory: "relation filters reject empty arrays"')
    expect(text).toContain("Topic: Auth Models")
    expect(getOrCreate).toHaveBeenCalledWith("Auth Models", ["proj-a"], {
      forceNew: undefined,
    })
    expect(createWithResult).toHaveBeenCalledWith(
      expect.objectContaining({
        topicId: "topic-auth",
        autosaveLearningDedupScope: "off",
        prepareFreshCreate: undefined,
      })
    )
  })

  it("does not let a single-project prior learning block a multi-project save", async () => {
    const mockServer = createMockServer()
    const existing = makeMemory("mem-existing", {
      title: "relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectIds: ["proj-a"],
      source: "conversation",
      kind: "note",
      confidence: "likely",
      session: "session-1",
    })
    const created = makeMemory("mem-created", {
      title: "relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectIds: ["proj-a", "proj-b"],
      source: "conversation",
      kind: "note",
      confidence: "likely",
      session: "session-2",
    })
    const create = vi.fn().mockResolvedValue(created)
    const list = vi.fn().mockResolvedValue({ items: [existing] })
    const findByName = vi.fn(async (name: string) =>
      name === "A"
        ? { id: "proj-a", name: "A" }
        : name === "B"
          ? { id: "proj-b", name: "B" }
          : null
    )
    const record = vi.fn()
    const services = {
      projects: { findByName },
      topics: { getOrCreate: vi.fn() },
      memories: { create, list },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record, get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
      facts: { createWithDedup: vi.fn() },
    }

    vi.stubEnv("LORE_BACKGROUND_AGENT", "true")
    try {
      registerMemoryTools(mockServer.server, services as never)
      registerQueryTools(mockServer.server, services as never)
      const remember = mockServer.getActionHandler("lore-memory", "save")

      const result = await remember({
        title: "relation filters reject empty arrays",
        content: "Notion dataSources.query rejects relation filters with empty arrays.",
        kind: "note",
        confidence: "likely",
        session: "session-2",
        agent: "Codex",
        projectNames: ["A", "B"],
      } as never)

      const text = (result as { content: Array<{ text: string }> }).content[0].text
      expect(text).toContain('Saved memory: "relation filters reject empty arrays"')
      expect(text).not.toContain("Reused existing autosave learning")
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          projectIds: ["proj-a", "proj-b"],
        })
      )
      expect(record).toHaveBeenCalledWith(
        { agent: "Codex", session: "session-2" },
        { memoryId: "mem-created", projectIds: ["proj-a", "proj-b"] }
      )
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj-a",
          session: undefined,
          source: "conversation",
          kind: "note",
          confidence: "likely",
          includeContent: true,
          includeUnscoped: true,
        })
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("keeps synopsis-style background saves independent from the learning gate", async () => {
    const mockServer = createMockServer()
    const created = makeMemory("mem-synopsis", {
      title: "session synopsis",
      content: "Session-level synopsis.",
      projectIds: ["proj-a"],
    })
    const existing = makeMemory("mem-existing", {
      title: "session synopsis",
      content: "Session-level synopsis.",
      projectIds: ["proj-a"],
      source: "conversation",
      kind: "note",
      confidence: "likely",
      session: "session-1",
    })
    const create = vi.fn().mockResolvedValue(created)
    const list = vi.fn().mockResolvedValue({ items: [existing] })
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create, list },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    vi.stubEnv("LORE_BACKGROUND_AGENT", "true")
    try {
      registerMemoryTools(mockServer.server, services as never)
      registerQueryTools(mockServer.server, services as never)
      const remember = mockServer.getActionHandler("lore-memory", "save")

      const result = await remember({
        title: "session synopsis",
        content: "Session-level synopsis.",
        kind: "note",
        session: "session-1",
        agent: "Codex",
      } as never)

      const text = (result as { content: Array<{ text: string }> }).content[0].text
      expect(text).toContain('Saved memory: "session synopsis"')
      expect(create).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("does not let an existing synopsis-style row suppress a later learning", async () => {
    const mockServer = createMockServer()
    const created = makeMemory("mem-learning", {
      title: "relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectIds: ["proj-a"],
      confidence: "likely",
    })
    const existingSynopsis = makeMemory("mem-synopsis", {
      title: "relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectIds: ["proj-a"],
      source: "conversation",
      kind: "note",
      confidence: "certain",
      session: "session-1",
    })
    const create = vi.fn().mockResolvedValue(created)
    const list = vi.fn().mockResolvedValue({ items: [existingSynopsis] })
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create, list },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    vi.stubEnv("LORE_BACKGROUND_AGENT", "true")
    try {
      registerMemoryTools(mockServer.server, services as never)
      registerQueryTools(mockServer.server, services as never)
      const remember = mockServer.getActionHandler("lore-memory", "save")

      const result = await remember({
        title: "relation filters reject empty arrays",
        content: "Notion dataSources.query rejects relation filters with empty arrays.",
        kind: "note",
        confidence: "likely",
        session: "session-1",
        agent: "Codex",
      } as never)

      const text = (result as { content: Array<{ text: string }> }).content[0].text
      expect(text).toContain('Saved memory: "relation filters reject empty arrays"')
      expect(create).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe("lore-recall topicName resolution", () => {
  it("resolves topicName globally (not scoped to the ambient project) so multi-project topics work", async () => {
    const mockServer = createMockServer()
    const topic = makeTopic("topic-1", {
      name: "OAuth",
      projectIds: ["proj-a", "proj-b"],
    })
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
      expect.objectContaining({ topicId: "topic-1" })
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
      expect.objectContaining({ topicId: undefined })
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

    expect(text).toContain('Project "Typo" could not be resolved')
    expect(text).toContain("Fix the project scope")
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

    expect(text).toContain('Project "Typo" could not be resolved')
    expect(text).toContain("Fix the project scope")
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
      expect.objectContaining({ startCursor: "resume-here" })
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

  it("marks the pagination footer as truncated when the live-row refill cap fires", async () => {
    const mockServer = createMockServer()
    const memoriesList = vi.fn().mockResolvedValue({
      items: [],
      nextCursor: "keep-paging",
      capped: true,
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
    expect(text).toMatch(/```json\n\{"nextCursor":"keep-paging","truncated":true\}\n```/)
  })
})

describe("lore-search projectName resolution", () => {
  it("returns an error when projectName does not resolve", async () => {
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

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(text).toContain('Project "Typo" could not be resolved')
    expect(text).toContain("Fix the project scope")
    expect(memoriesSearch).not.toHaveBeenCalled()
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
      expect.objectContaining({ includeContent: false, limit: 10 })
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
      expect.objectContaining({ includeContent: true })
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

    const recallText = (recallResult as { content: Array<{ text: string }> }).content[0]
      .text
    const searchText = (searchResult as { content: Array<{ text: string }> }).content[0]
      .text

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
      expect.objectContaining({ includeContent: false })
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
    const memoriesSearch = vi
      .fn()
      .mockResolvedValue([
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
      expect.objectContaining({ includeContent: true })
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
      expect.objectContaining({ mode: "hybrid" })
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
      })
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
      expect.objectContaining({ mode: "semantic", limit: 10 })
    )

    await search({ query: "q", limit: 5, mode: "contains" } as never)
    expect(memoriesSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "contains", limit: 5 })
    )

    await search({ query: "q", limit: 5, mode: "hybrid" } as never)
    expect(memoriesSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "hybrid", limit: 5 })
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
      expect.objectContaining({ topicId: "topic-1" })
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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

    const isErr = (r: unknown): boolean => (r as { isError?: boolean }).isError === true

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
          resolve(makeMemory(id, { title: `Title ${id}`, content: `Body ${id}` }))
        )
      })
    })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { getById },
      context: { project: null },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      makeMemory(id, { title: `Title ${id}`, content: `Body ${id}` })
    )

    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { getById },
      context: { project: null },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
    }>
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
      memories: {
        create: vi.fn().mockResolvedValue(created),
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      tasks: { list: tasksList },
      facts: {
        createWithDedup: vi
          .fn()
          .mockResolvedValue({ fact: { id: "fact-x" }, deduped: false, enriched: [] }),
      },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      })
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
      memories: {
        create: vi.fn().mockResolvedValue(created),
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      tasks: { list: tasksList },
      facts: {
        createWithDedup: vi
          .fn()
          .mockResolvedValue({ fact: { id: "fact-x" }, deduped: false, enriched: [] }),
      },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      memories: {
        create: vi.fn().mockResolvedValue(created),
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      tasks: { list: tasksList },
      facts: {
        createWithDedup: vi
          .fn()
          .mockResolvedValue({ fact: { id: "fact-x" }, deduped: false, enriched: [] }),
      },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      memories: {
        create: vi.fn().mockResolvedValue(created),
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      tasks: { list: tasksList },
      facts: {
        createWithDedup: vi
          .fn()
          .mockResolvedValue({ fact: { id: "fact-x" }, deduped: false, enriched: [] }),
      },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      memories: {
        create: vi.fn().mockResolvedValue(created),
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      tasks: { list: tasksList },
      facts: {
        createWithDedup: vi
          .fn()
          .mockResolvedValue({ fact: { id: "fact-x" }, deduped: false, enriched: [] }),
      },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      })
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      })
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      (c) => (c[0] as { object: string }).object
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      (c) => c[0] as { subject: string; predicate: string; object: string }
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
        expect.objectContaining({ predicate: "mentions" })
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
        expect.objectContaining({ predicate: "mentions" })
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      expect.objectContaining({ predicates: ["mentions"] })
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
      })
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
    const queryBySourceMemory = vi
      .fn()
      .mockResolvedValue([{ id: "fact-existing", object: "PR #25750" }])
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    await lore({
      memoryId: "mem-update-mixed",
      title: "Reviewed PR #25750 against SENTRY-1234",
    } as never)

    const objects = createWithDedup.mock.calls.map(
      (c) => (c[0] as { object: string }).object
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    await lore({
      memoryId: "mem-update-fields",
      keywords: "PR #25750",
      synopsis: "Closes SENTRY-1234.",
    } as never)

    const objects = createWithDedup.mock.calls.map(
      (c) => (c[0] as { object: string }).object
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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

  it("surfaces structured memory update partial-failure messages as MCP errors", async () => {
    const mockServer = createMockServer()
    const bodyWriteError = new Error("notion 503")
    const update = vi
      .fn()
      .mockRejectedValue(
        new MemoryUpdatePartialFailureError(
          `Memory update partial failure: properties for memory mem-partial ` +
            `persisted, but the body write failed during phase "body": notion 503. ` +
            `The property changes are already on Notion; the body content was ` +
            `not written. Inspect the row before retrying the update.`,
          { memoryId: "mem-partial", bodyWriteError }
        )
      )

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { update, getById: vi.fn() },
      facts: { queryBySourceMemory: vi.fn(), createWithDedup: vi.fn() },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    const result = await lore({
      memoryId: "mem-partial",
      title: "Updated title",
      content: "Updated body",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(text).toContain("Error: MemoryUpdatePartialFailureError")
    expect(text).toContain("Memory update partial failure")
    expect(text).toContain("properties for memory mem-partial persisted")
    expect(text).toContain('phase "body"')
    expect(text).toContain("body content was not written")
    expect(services.facts.queryBySourceMemory).not.toHaveBeenCalled()
    expect(services.facts.createWithDedup).not.toHaveBeenCalled()
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      (c) => (c[0] as { object: string }).object
    )
    expect(calls).not.toContain("Café &amp; Bar")
    expect(calls).not.toContain("Café & Bar")
  })
})

describe("lore-memory action='update' date clearing (issue #271)", () => {
  function setUpUpdateHarness() {
    const mockServer = createMockServer()
    const update = vi.fn().mockResolvedValue(makeMemory("mem-1"))
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { update, getById: vi.fn().mockResolvedValue(makeMemory("mem-1")) },
      facts: { queryBySourceMemory: vi.fn(), createWithDedup: vi.fn() },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    return {
      lore: mockServer.getActionHandler("lore-memory", "update"),
      inputSchema: mockServer.getInputSchema("lore-memory"),
      update,
    }
  }

  it("threads reviewBy: null through to memories.update as an explicit clear", async () => {
    const { lore, update } = setUpUpdateHarness()

    await lore({ memoryId: "mem-1", reviewBy: null } as never)

    expect(update).toHaveBeenCalledWith(
      "mem-1",
      expect.objectContaining({ reviewBy: null })
    )
  })

  it("threads decidedAt: null through to memories.update as an explicit clear", async () => {
    const { lore, update } = setUpUpdateHarness()

    await lore({ memoryId: "mem-1", decidedAt: null } as never)

    expect(update).toHaveBeenCalledWith(
      "mem-1",
      expect.objectContaining({ decidedAt: null })
    )
  })

  it("normalizes reviewBy: empty string to an explicit clear", async () => {
    const { lore, update } = setUpUpdateHarness()

    await lore({ memoryId: "mem-1", reviewBy: "" } as never)

    expect(update).toHaveBeenCalledWith(
      "mem-1",
      expect.objectContaining({ reviewBy: null })
    )
  })

  it("normalizes decidedAt: empty string to an explicit clear", async () => {
    const { lore, update } = setUpUpdateHarness()

    await lore({ memoryId: "mem-1", decidedAt: "" } as never)

    expect(update).toHaveBeenCalledWith(
      "mem-1",
      expect.objectContaining({ decidedAt: null })
    )
  })

  it("clears reviewBy and decidedAt in the same update call", async () => {
    const { lore, update } = setUpUpdateHarness()

    await lore({
      memoryId: "mem-1",
      reviewBy: null,
      decidedAt: null,
    } as never)

    expect(update).toHaveBeenCalledWith(
      "mem-1",
      expect.objectContaining({ reviewBy: null, decidedAt: null })
    )
  })

  it("omitted reviewBy and decidedAt stay undefined", async () => {
    const { lore, update } = setUpUpdateHarness()

    await lore({ memoryId: "mem-1", title: "Renamed" } as never)

    const [, args] = update.mock.calls[0]
    expect(args.reviewBy).toBeUndefined()
    expect(args.decidedAt).toBeUndefined()
  })

  it("accepts null dates in the MCP-visible flat input schema", () => {
    const { inputSchema } = setUpUpdateHarness()

    const parsed = inputSchema.safeParse({
      action: "update",
      memoryId: "mem-1",
      reviewBy: null,
      decidedAt: null,
    })

    expect(parsed.success).toBe(true)
  })

  it("normalizes empty-string dates in the MCP-visible flat input schema", () => {
    const { inputSchema } = setUpUpdateHarness()

    const parsed = inputSchema.safeParse({
      action: "update",
      memoryId: "mem-1",
      reviewBy: "",
      decidedAt: "",
    })

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.reviewBy).toBeNull()
    expect(parsed.data.decidedAt).toBeNull()
  })

  it("describes update clearing with the same wording pattern as synopsis", () => {
    const { inputSchema } = setUpUpdateHarness()

    expect(inputSchema.shape.reviewBy.description).toBe(
      "(save | update) Review-by date YYYY-MM-DD. On update, omit to keep, pass null or empty string to clear."
    )
    expect(inputSchema.shape.decidedAt.description).toBe(
      "(save | update) Canonical decision date YYYY-MM-DD. On update, omit to keep, pass null or empty string to clear."
    )
    expect(inputSchema.shape.synopsis.description).toContain(
      "On update, omit to keep, pass empty string to clear."
    )
  })

  it("still rejects malformed date strings before any update", async () => {
    const { lore, update } = setUpUpdateHarness()

    for (const args of [
      { memoryId: "mem-1", reviewBy: "05-03-2026" },
      { memoryId: "mem-1", decidedAt: "2026/05/03" },
    ]) {
      const result = await lore(args as never)

      expect((result as { isError?: boolean }).isError).toBe(true)
    }
    expect(update).not.toHaveBeenCalled()
  })

  it("keeps action='save' null-date behavior unchanged", async () => {
    const mockServer = createMockServer()
    const create = vi.fn()
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create, list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "Saved",
      content: "body",
      reviewBy: null,
      decidedAt: null,
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(create).not.toHaveBeenCalled()
  })

  it("keeps action='save' empty-string date behavior unchanged", async () => {
    const mockServer = createMockServer()
    const create = vi.fn()
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create, list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "Saved",
      content: "body",
      reviewBy: "",
      decidedAt: "",
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(create).not.toHaveBeenCalled()
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      })
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    await lore({
      memoryId: "mem-1",
      synopsis: "New synopsis",
    } as never)

    expect(update).toHaveBeenCalledWith(
      "mem-1",
      expect.objectContaining({ synopsis: "New synopsis" })
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    await lore({ memoryId: "mem-1", synopsis: "" } as never)

    expect(update).toHaveBeenCalledWith(
      "mem-1",
      expect.objectContaining({ synopsis: "" })
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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

describe("lore-memory action='update' Alternatives/Consequences rich_text cap (#270)", () => {
  function setUpUpdateHarness() {
    const mockServer = createMockServer()
    const update = vi.fn().mockResolvedValue(makeMemory("mem-1"))
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { update, getById: vi.fn() },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }
    registerMemoryTools(mockServer.server, services as never)
    return {
      handler: mockServer.getActionHandler("lore-memory", "update"),
      update,
    }
  }

  it("accepts alternatives and consequences at the Notion rich_text cap", async () => {
    const { handler, update } = setUpUpdateHarness()
    const atCap = "x".repeat(RICH_TEXT_PROPERTY_MAX_LEN)

    const result = await handler({
      memoryId: "mem-1",
      alternatives: atCap,
      consequences: atCap,
    } as never)

    expect((result as { isError?: boolean }).isError).not.toBe(true)
    expect(update).toHaveBeenCalledWith(
      "mem-1",
      expect.objectContaining({
        alternatives: atCap,
        consequences: atCap,
      })
    )
  })

  it.each([
    ["alternatives", { alternatives: "x".repeat(RICH_TEXT_PROPERTY_MAX_LEN + 1) }],
    ["consequences", { consequences: "x".repeat(RICH_TEXT_PROPERTY_MAX_LEN + 1) }],
  ] as const)("rejects over-cap %s before memories.update", async (field, input) => {
    const { handler, update } = setUpUpdateHarness()

    const result = await handler({
      memoryId: "mem-1",
      ...input,
    } as never)

    const wrapped = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(wrapped.isError).toBe(true)
    expect(wrapped.content[0].text).toContain(field)
    expect(wrapped.content[0].text).toContain(`${RICH_TEXT_PROPERTY_MAX_LEN}`)
    expect(update).not.toHaveBeenCalled()
  })
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
      makeMemory("mem-1", { title: "OAuth handshake notes", tags: ["auth"] })
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
      })
    )

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

    const result = await recall({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain(
      "### OAuth handshake notes\n" +
        "Outlook callbacks fail because the redirect URI is not allow-listed.\n" +
        "*manual | auth | 2026-04-20*"
    )
  })

  it("includeContent=true, no synopsis → byte-identical pre-#03 body-on row", async () => {
    const mockServer = createMockServer()
    const services = buildRecallServices(
      makeMemory("mem-1", {
        title: "OAuth handshake notes",
        tags: ["auth"],
        content: "Body paragraph.",
      })
    )

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const recall = mockServer.getActionHandler("lore-query", "recall")

    const result = await recall({ includeContent: true } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain(
      "### OAuth handshake notes\n*manual | auth | 2026-04-20*\n\nBody paragraph."
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
      })
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
        "Body paragraph."
    )
  })

  it("includeSynopsis=false restores byte-identical pre-#03 output (body-off)", async () => {
    const mockServer = createMockServer()
    const services = buildRecallServices(
      makeMemory("mem-1", {
        title: "OAuth handshake notes",
        tags: ["auth"],
        synopsis: "This synopsis should not render.",
      })
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
      })
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
      "### OAuth handshake notes\n*manual | auth | 2026-04-20*\n\nBody paragraph."
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
        "*manual | auth | 2026-04-20*"
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
      })
    )

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const search = mockServer.getActionHandler("lore-query", "search")

    const result = await search({ query: "auth" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("### Search hit\nOne-line gist.\n*manual | auth | 2026-04-20*")
  })

  it("renders synopsis above meta and body below on the body-on path", async () => {
    const mockServer = createMockServer()
    const services = buildSearchServices(
      makeMemory("mem-1", {
        title: "Search hit",
        tags: ["auth"],
        synopsis: "One-line gist.",
        content: "Body paragraph.",
      })
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
        "Body paragraph."
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

  it("surfaces truncated contains-search windows even when no rows were returned", async () => {
    const mockServer = createMockServer()
    const memoriesSearchWithMeta = vi.fn().mockResolvedValue({
      memories: [],
      capped: true,
    })
    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: {
        search: vi.fn(),
        searchWithMeta: memoriesSearchWithMeta,
        list: vi.fn(),
      },
      context: { project: null },
    }

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const search = mockServer.getActionHandler("lore-query", "search")

    const result = await search({ query: "archived", mode: "contains" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain('No memories found for: "archived"')
    expect(text).toContain("live-row refill cap")
    expect(text).toMatch(/```json\n\{"truncated":true\}\n```/)
  })

  it("includeSynopsis=false restores byte-identical pre-#03 search output", async () => {
    const mockServer = createMockServer()
    const services = buildSearchServices(
      makeMemory("mem-1", {
        title: "Search hit",
        tags: ["auth"],
        synopsis: "Should not appear.",
      })
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
    const memoriesSearch = vi
      .fn()
      .mockResolvedValue([
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
      makeMemory(id, { title: `Title ${id}`, content: `Body ${id}` })
    )
    const touchOnRead = vi.fn().mockResolvedValue(undefined)

    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { getById, touchOnRead },
      context: { project: null },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
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
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const expand = mockServer.getActionHandler("lore-memory", "expand")

    const result = await expand({ ids: [ID_A] } as never)
    expect((result as { isError?: boolean }).isError).not.toBe(true)
    expect(touchOnRead).not.toHaveBeenCalled()
  })
})

describe("lore-recall / lore-search revision marker (issue 0.9.0/10)", () => {
  // Surface-pin: the rev-N marker must reach recall and search via the
  // shared `formatMemoryListItem` path. Lives at the surface so a
  // future contributor swapping either handler away from the helper
  // would see this fail rather than silently lose the indicator.

  it("renders `rev N` in the recall meta line for an upserted memory", async () => {
    const mockServer = createMockServer()
    const memoriesList = vi.fn().mockResolvedValue({
      items: [
        makeMemory("mem-1", {
          title: "JWT auth model",
          source: "conversation",
          kind: "decision",
          status: "accepted",
          tags: ["auth", "security"],
          updatedAt: "2026-04-29T00:00:00.000Z",
          revisionCount: 4,
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

    expect(text).toContain(
      "*conversation | decision | accepted | auth, security | rev 4 | 2026-04-29*"
    )
  })

  it("omits the rev marker on a fresh row (revisionCount: 1) — byte-identical to pre-#10", async () => {
    const mockServer = createMockServer()
    const memoriesList = vi.fn().mockResolvedValue({
      items: [
        makeMemory("mem-1", {
          title: "Untouched note",
          source: "manual",
          tags: ["auth"],
          updatedAt: "2026-04-20T00:00:00.000Z",
          revisionCount: 1,
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

    expect(text).not.toContain("rev")
    expect(text).toContain("*manual | auth | 2026-04-20*")
  })

  it("renders `rev N` on a search hit (parity with recall via shared meta builder)", async () => {
    // The same memory through search must produce the same meta line —
    // the contract is shared via `defaultMemoryMetaBuilder`. Mirrors the
    // existing tag-rendering parity test above.
    const mockServer = createMockServer()
    const memoriesSearch = vi.fn().mockResolvedValue([
      makeMemory("mem-1", {
        title: "Database migration runbook",
        source: "manual",
        kind: "runbook",
        status: "accepted",
        tags: ["db", "migration"],
        updatedAt: "2026-04-29T00:00:00.000Z",
        revisionCount: 3,
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

    expect(text).toContain(
      "*manual | runbook | accepted | db, migration | rev 3 | 2026-04-29*"
    )
  })
})

describe("lore-memory action='save' topic-key upsert (0.9.0/06)", () => {
  it("dispatches to upsertByTopicKey when topicKey is set; create is NOT called", async () => {
    // The handler's dispatch should route topicKey-bearing saves to
    // the upsert path. The fresh-create path must not fire when a
    // topicKey is present, otherwise revisions never group.
    const mockServer = createMockServer()
    const upserted = makeMemory("mem-existing", {
      title: "JWT auth model with refresh rotation",
      projectIds: ["proj-a"],
      topicKey: "decision/jwt-auth",
      revisionCount: 2,
    })
    const upsertByTopicKey = vi.fn().mockResolvedValue({
      memory: upserted,
      revisionCount: 2,
      upserted: true,
    })
    const create = vi.fn()
    const services = {
      projects: { findByName: vi.fn().mockResolvedValue({ id: "proj-a", name: "a" }) },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create,
        upsertByTopicKey,
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      facts: { createWithDedup: vi.fn() },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "JWT auth model with refresh rotation",
      content: "Now we rotate refresh tokens.",
      kind: "decision",
      topicKey: "decision/jwt-auth",
    } as never)

    expect(upsertByTopicKey).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
    const args = upsertByTopicKey.mock.calls[0]![0]
    expect(args.topicKey).toBe("decision/jwt-auth")
    expect(args.projectIds).toEqual(["proj-a"])
    expect(args.kind).toBe("decision")

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain('Saved memory: "JWT auth model with refresh rotation"')
    expect(text).toContain("Appended as revision 2")
    expect(text).toContain("topic key 'decision/jwt-auth'")
  })

  it("renders 'Created (revision 1)' header when topicKey is set but no existing match", async () => {
    // Fresh create through the upsert path — the response footer
    // distinguishes "Created (revision 1)" from "Appended as
    // revision N" so the agent knows which branch fired.
    const mockServer = createMockServer()
    const created = makeMemory("mem-fresh", {
      title: "JWT auth model",
      projectIds: ["proj-a"],
      topicKey: "decision/jwt-auth",
      revisionCount: 1,
    })
    const upsertByTopicKey = vi.fn().mockResolvedValue({
      memory: created,
      revisionCount: 1,
      upserted: false,
    })
    const services = {
      projects: { findByName: vi.fn().mockResolvedValue({ id: "proj-a", name: "a" }) },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create: vi.fn(),
        upsertByTopicKey,
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      facts: { createWithDedup: vi.fn() },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "JWT auth model",
      content: "We chose JWT.",
      kind: "decision",
      topicKey: "decision/jwt-auth",
    } as never)

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("Created (revision 1, topic key 'decision/jwt-auth')")
    expect(text).not.toContain("Appended as revision")
  })

  it("preserves the legacy create path byte-identically when topicKey is omitted", async () => {
    // 0.8.x callers — and the catch-all default path — never set
    // topicKey. The acceptance criterion: "behaves byte-identical to
    // 0.8.x" when topicKey is unset.
    const mockServer = createMockServer()
    const created = makeMemory("mem-legacy", { projectIds: ["proj-a"] })
    const create = vi.fn().mockResolvedValue(created)
    const upsertByTopicKey = vi.fn()
    const services = {
      projects: { findByName: vi.fn().mockResolvedValue({ id: "proj-a", name: "a" }) },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create,
        upsertByTopicKey,
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      facts: { createWithDedup: vi.fn() },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "Legacy save",
      content: "no topic key",
    } as never)

    expect(create).toHaveBeenCalledTimes(1)
    expect(upsertByTopicKey).not.toHaveBeenCalled()

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    // No upsert hint — header line matches the pre-#06 shape exactly.
    expect(text).toContain('Saved memory: "Memory mem-legacy" (mem-legacy)')
    expect(text).not.toContain("Appended as revision")
    expect(text).not.toContain("Created (revision 1")
    expect(text).not.toContain("topic key '")
  })

  it("rejects malformed topicKey at the Zod boundary before any service call", async () => {
    // The regex enforces lowercase + slash-separated segments. A
    // malformed key (uppercase, leading slash, spaces) is almost
    // always a typo, so the schema rejects it as a tool-level error.
    const mockServer = createMockServer()
    const create = vi.fn()
    const upsertByTopicKey = vi.fn()
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create, upsertByTopicKey, list: vi.fn() },
      facts: { createWithDedup: vi.fn() },
      tasks: { list: vi.fn() },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    for (const bad of [
      "Decision/JWT",
      " decision/jwt",
      "/decision/jwt",
      "decision/jwt/",
    ]) {
      const result = await remember({
        title: "x",
        content: "y",
        topicKey: bad,
      } as never)
      expect((result as { isError?: boolean }).isError).toBe(true)
      const text = (result as { content: Array<{ text: string }> }).content[0].text
      expect(text).toContain("topicKey")
    }
    expect(create).not.toHaveBeenCalled()
    expect(upsertByTopicKey).not.toHaveBeenCalled()
  })

  it("auto-mentions facts re-emit on upsert against the post-write title / keywords / synopsis", async () => {
    // Acceptance criterion: auto-`mentions` fact emission re-runs
    // on upsert with the new content. The returned memory shape
    // carries the new title / keywords / synopsis so the entity
    // tokenizer extracts against the fresh values.
    const mockServer = createMockServer()
    const upserted = makeMemory("mem-existing", {
      title: "JWT auth with PR-123 refresh rotation",
      projectIds: ["proj-a"],
      keywords: "PR-123 refresh",
      topicKey: "decision/jwt-auth",
      revisionCount: 2,
    })
    const upsertByTopicKey = vi.fn().mockResolvedValue({
      memory: upserted,
      revisionCount: 2,
      upserted: true,
    })
    const createWithDedup = vi.fn().mockResolvedValue({ deduped: false })
    const services = {
      projects: { findByName: vi.fn().mockResolvedValue({ id: "proj-a", name: "a" }) },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create: vi.fn(),
        upsertByTopicKey,
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      facts: { createWithDedup },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    await remember({
      title: "JWT auth with PR-123 refresh rotation",
      content: "rotation now lands.",
      kind: "decision",
      keywords: "PR-123 refresh",
      topicKey: "decision/jwt-auth",
    } as never)

    // Auto-mentions fired against the post-write entity set —
    // PR-123 surfaces from the new title / keywords blob via the
    // `\bPR-\d+\b` pattern in `extractEntityCandidates`.
    expect(createWithDedup).toHaveBeenCalled()
    const objects = createWithDedup.mock.calls.map(
      (c) => (c[0] as { object: string }).object
    )
    expect(objects).toContain("PR-123")
  })

  it("surfaces the upsert-path error (e.g. kind mismatch) through toolError", async () => {
    // The service-layer kind-mismatch throw must surface as a tool
    // error to the agent, not crash the dispatcher. The wording
    // points the agent at remediation.
    const mockServer = createMockServer()
    const upsertByTopicKey = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Kind cannot change on upsert. Existing: 'decision'; input: 'runbook'. Pick a new topicKey for the new kind, or supersede via lore-decision action='create'."
        )
      )
    const services = {
      projects: { findByName: vi.fn().mockResolvedValue({ id: "proj-a", name: "a" }) },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create: vi.fn(),
        upsertByTopicKey,
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      facts: { createWithDedup: vi.fn() },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "x",
      content: "y",
      kind: "runbook",
      topicKey: "decision/jwt-auth",
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("Kind cannot change on upsert")
  })

  it("rejects topicKey when kind is omitted (which would default to 'note')", async () => {
    // The contract: topic keys group recurring decision/runbook/policy-
    // style topics; the suggester returns null for `kind: 'note'` and
    // `kind: 'task'` for the same reason. An agent that passes
    // `topicKey` without explicit `kind` would silently land in an
    // upsert chain on a `note`-defaulted memory. The MCP layer
    // catches this BEFORE any service call so neither `create` nor
    // `upsertByTopicKey` fires.
    const mockServer = createMockServer()
    const create = vi.fn()
    const upsertByTopicKey = vi.fn()
    const services = {
      projects: { findByName: vi.fn().mockResolvedValue({ id: "proj-a", name: "a" }) },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create,
        upsertByTopicKey,
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      facts: { createWithDedup: vi.fn() },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "Wakeup hook diagnosis",
      content: "body",
      topicKey: "decision/jwt-auth",
      // kind deliberately omitted — defaults to 'note'.
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("topicKey is not valid on kind: 'note'")
    expect(create).not.toHaveBeenCalled()
    expect(upsertByTopicKey).not.toHaveBeenCalled()
  })

  it("rejects topicKey when kind is explicitly 'note'", async () => {
    // Same rejection, agent-explicit form. Pinning both the omitted-
    // kind path and the explicit-note path keeps the contract clear
    // for any future refactor that splits the default-kind handling.
    const mockServer = createMockServer()
    const create = vi.fn()
    const upsertByTopicKey = vi.fn()
    const services = {
      projects: { findByName: vi.fn().mockResolvedValue({ id: "proj-a", name: "a" }) },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create,
        upsertByTopicKey,
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      facts: { createWithDedup: vi.fn() },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "A note about something",
      content: "body",
      kind: "note",
      topicKey: "decision/jwt-auth",
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("topicKey is not valid on kind: 'note'")
    expect(create).not.toHaveBeenCalled()
    expect(upsertByTopicKey).not.toHaveBeenCalled()
  })

  it("rejects topicKey + default-note before any Notion side effect — including topics.getOrCreate", async () => {
    // Position-correctness regression. The kind=note guard MUST run
    // before `services.topics.getOrCreate`, which CREATES a Topic
    // row in Notion as a side effect when the named topic doesn't
    // exist. A late-firing guard (post-topic-resolution) would leak
    // an orphaned Topic row that the rejected save never links to.
    //
    // The reviewer-flagged earlier shape ran the guard AFTER both
    // `resolveProjectIds` AND `topics.getOrCreate`, and AFTER
    // dispatching the parallel probes. This test pins all three
    // service surfaces as untouched: `projects.findByName`,
    // `topics.getOrCreate`, and the `memories` write methods. The
    // probe-related list/createWithDedup mocks are also pinned to
    // ensure the parallel probes never fire either — a probe that
    // ran before rejection would still issue a `dataSources.query`,
    // which is read-only but observable in the per-save cost
    // budget.
    const mockServer = createMockServer()
    const findByName = vi.fn()
    const getOrCreate = vi.fn()
    const create = vi.fn()
    const upsertByTopicKey = vi.fn()
    const list = vi.fn()
    const createWithDedup = vi.fn()
    const taskList = vi.fn()
    const services = {
      projects: { findByName },
      topics: { getOrCreate },
      memories: { create, upsertByTopicKey, list },
      facts: { createWithDedup },
      tasks: { list: taskList },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "Topic-key with default note kind",
      content: "body",
      // kind omitted — defaults to 'note'.
      topicKey: "decision/jwt-auth",
      // topicName forces a `topics.getOrCreate` call IF the guard
      // runs after topic resolution. The guard MUST short-circuit
      // before this resolves.
      topicName: "Auth Models",
      projectName: "a",
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("topicKey is not valid on kind: 'note'")

    // Zero side effects across every service surface a save normally
    // touches. If any of these fail, the kind=note guard has drifted
    // back to a late-firing position.
    expect(findByName).not.toHaveBeenCalled()
    expect(getOrCreate).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(upsertByTopicKey).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
    expect(createWithDedup).not.toHaveBeenCalled()
    expect(taskList).not.toHaveBeenCalled()
  })

  it("rejects topicKey + kind=task at the dispatcher boundary before any Notion side effect", async () => {
    const mockServer = createMockServer()
    const findByName = vi.fn()
    const getOrCreate = vi.fn()
    const create = vi.fn()
    const upsertByTopicKey = vi.fn()
    const list = vi.fn()
    const createWithDedup = vi.fn()
    const taskList = vi.fn()
    const services = {
      projects: { findByName },
      topics: { getOrCreate },
      memories: { create, upsertByTopicKey, list },
      facts: { createWithDedup },
      tasks: { list: taskList },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "Task-shaped memory",
      content: "body",
      kind: "task",
      topicKey: "decision/jwt-auth",
      topicName: "Auth Models",
      projectName: "a",
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("kind: Invalid enum value")
    expect(text).toContain("received 'task'")

    expect(findByName).not.toHaveBeenCalled()
    expect(getOrCreate).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(upsertByTopicKey).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
    expect(createWithDedup).not.toHaveBeenCalled()
    expect(taskList).not.toHaveBeenCalled()
  })

  it("rejects single-segment topicKey ('decision' alone) at the Zod boundary", async () => {
    // The TOPIC_KEY_REGEX requires `family/key` shape — at least
    // one slash separator — to match what `suggest-topic-key`
    // emits. A single-segment key like `decision` is a malformed
    // contract violation: the family prefix carries no upsert-
    // grouping value without a key after it. Pin the rejection
    // here so a future loosening of the regex surfaces.
    const mockServer = createMockServer()
    const create = vi.fn()
    const upsertByTopicKey = vi.fn()
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create, upsertByTopicKey, list: vi.fn() },
      facts: { createWithDedup: vi.fn() },
      tasks: { list: vi.fn() },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "x",
      content: "y",
      kind: "decision",
      topicKey: "decision",
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("topicKey")
    expect(create).not.toHaveBeenCalled()
    expect(upsertByTopicKey).not.toHaveBeenCalled()
  })
})

describe("lore-memory action='save' promotion advisory footer (0.9.0/15)", () => {
  // The advisory is a response-footer addition on the topic-key
  // upsert path. The pure-function `computePromotionAdvisory` is
  // tested in `src/core/memory.test.ts`; these tests pin the MCP
  // boundary's render contract: footer present on advisory return,
  // absent (no empty headers) on null return, and the
  // `<this-memory-id>` placeholder substituted with the just-saved
  // memory's id.

  it("appends the advisory footer when the upsert returns a non-null advisory; substitutes the memory-id placeholder", async () => {
    const mockServer = createMockServer()
    const upserted = makeMemory("mem-existing", {
      title: "JWT auth model",
      projectIds: ["proj-a"],
      topicKey: "decision/jwt-auth",
      revisionCount: 5,
    })
    const upsertByTopicKey = vi.fn().mockResolvedValue({
      memory: upserted,
      revisionCount: 5,
      upserted: true,
      promotionAdvisory: {
        reasons: ["5 revisions accumulated", "body length 5832 chars"],
        suggestion:
          "Consider promoting via lore-decision action='create' " +
          "with supersedesIds: [<this-memory-id>], or splitting " +
          "the topic into narrower topicKeys.",
      },
    })
    const services = {
      projects: { findByName: vi.fn().mockResolvedValue({ id: "proj-a", name: "a" }) },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create: vi.fn(),
        upsertByTopicKey,
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      facts: { createWithDedup: vi.fn() },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "JWT auth model",
      content: "...",
      kind: "decision",
      topicKey: "decision/jwt-auth",
    } as never)

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("Promotion advisory:")
    expect(text).toContain("- 5 revisions accumulated")
    expect(text).toContain("- body length 5832 chars")
    // The placeholder is substituted with the just-saved memory's id
    // so the operator can copy-paste the promotion incantation
    // directly. The literal `<this-memory-id>` must NOT appear.
    expect(text).toContain("supersedesIds: [mem-existing]")
    expect(text).not.toContain("<this-memory-id>")
  })

  it("omits the footer entirely when the upsert returns a null advisory (no empty headers)", async () => {
    // Sub-threshold upsert: the service returns `promotionAdvisory:
    // null` and the response renders the standard upsert footer
    // without any "Promotion advisory:" header. Pinning the absence
    // of empty headers is the spec's "omits the section entirely
    // when null" acceptance criterion.
    const mockServer = createMockServer()
    const upserted = makeMemory("mem-existing", {
      title: "JWT auth model",
      projectIds: ["proj-a"],
      topicKey: "decision/jwt-auth",
      revisionCount: 2,
    })
    const upsertByTopicKey = vi.fn().mockResolvedValue({
      memory: upserted,
      revisionCount: 2,
      upserted: true,
      promotionAdvisory: null,
    })
    const services = {
      projects: { findByName: vi.fn().mockResolvedValue({ id: "proj-a", name: "a" }) },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create: vi.fn(),
        upsertByTopicKey,
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      facts: { createWithDedup: vi.fn() },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "JWT auth model",
      content: "...",
      kind: "decision",
      topicKey: "decision/jwt-auth",
    } as never)

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).not.toContain("Promotion advisory")
    expect(text).not.toContain("revisions accumulated")
    expect(text).not.toContain("body length")
  })

  it("omits the footer when topicKey is unset (non-upsert save path)", async () => {
    // A save without `topicKey` runs the legacy create path. Even
    // with a 6KB body, the response carries no advisory because the
    // advisory is scoped to the upsert path. Spec acceptance
    // criterion: "A save WITHOUT topicKey returns no advisory
    // regardless of body length."
    const mockServer = createMockServer()
    const created = makeMemory("mem-fresh", { projectIds: ["proj-a"] })
    const create = vi.fn().mockResolvedValue(created)
    const upsertByTopicKey = vi.fn()
    const services = {
      projects: { findByName: vi.fn().mockResolvedValue({ id: "proj-a", name: "a" }) },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create,
        upsertByTopicKey,
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      facts: { createWithDedup: vi.fn() },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    // 6KB body — would cross PROMOTE_BODY_LENGTH_THRESHOLD if the
    // path applied. It does NOT, because non-topicKey saves don't
    // run through `upsertByTopicKey` and the advisory is scoped to
    // the upsert path.
    const result = await remember({
      title: "Long save",
      content: "a".repeat(6000),
    } as never)

    expect(create).toHaveBeenCalledTimes(1)
    expect(upsertByTopicKey).not.toHaveBeenCalled()
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).not.toContain("Promotion advisory")
  })

  it("omits the footer on a fresh-create upsert (revision 1 of a new chain)", async () => {
    // Fresh-create upsert: the service returns `promotionAdvisory:
    // null` because the advisory is scoped to the append-revision
    // branch only. Spec acceptance criterion: "A fresh-create upsert
    // returns no advisory regardless of body length."
    const mockServer = createMockServer()
    const created = makeMemory("mem-fresh", {
      projectIds: ["proj-a"],
      topicKey: "decision/foo",
      revisionCount: 1,
    })
    const upsertByTopicKey = vi.fn().mockResolvedValue({
      memory: created,
      revisionCount: 1,
      upserted: false,
      promotionAdvisory: null,
    })
    const services = {
      projects: { findByName: vi.fn().mockResolvedValue({ id: "proj-a", name: "a" }) },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create: vi.fn(),
        upsertByTopicKey,
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      facts: { createWithDedup: vi.fn() },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "Foo",
      content: "a".repeat(6000),
      kind: "decision",
      topicKey: "decision/foo",
    } as never)

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("Created (revision 1, topic key 'decision/foo')")
    expect(text).not.toContain("Promotion advisory")
  })

  it("renders the non-decision-kind suggestion verbatim (no `supersedesIds`, no placeholder leak) for a runbook upsert", async () => {
    // Topic-key chains support runbook/incident/postmortem/policy
    // alongside decision (per the README's family table). Only the
    // decision kind gets the `supersedesIds` suggestion because
    // `lore-decision action='create'` resolves every supersedesIds
    // entry through `DecisionService.getById`, which throws on
    // non-decision kinds — the principal review on PR #166 caught
    // that the original spec wording handed runbook operators a
    // ready-to-paste BROKEN command. Pin the user-visible footer for
    // a runbook upsert here so the MCP boundary's rendering can't
    // regress to the decision-only wording without tripping CI.
    const mockServer = createMockServer()
    const upserted = makeMemory("mem-runbook", {
      title: "DB migration runbook",
      projectIds: ["proj-a"],
      topicKey: "runbook/db-migration",
      revisionCount: 5,
      kind: "runbook",
    })
    const upsertByTopicKey = vi.fn().mockResolvedValue({
      memory: upserted,
      revisionCount: 5,
      upserted: true,
      // Suggestion below mirrors what the kind-aware
      // `computePromotionAdvisory` returns for non-decision kinds.
      // Service-layer tests in `src/core/memory.test.ts` pin the
      // string-equality contract; this MCP test pins that the
      // renderer passes the suggestion through verbatim and that
      // `replaceAll("<this-memory-id>", ...)` is a safe no-op when
      // the suggestion has no placeholder.
      promotionAdvisory: {
        reasons: ["5 revisions accumulated"],
        suggestion:
          "Consider splitting the topic into narrower topicKeys, " +
          "or archiving this chain via lore-memory action='archive' " +
          "and starting a fresh chain with a more specific topicKey.",
      },
    })
    const services = {
      projects: { findByName: vi.fn().mockResolvedValue({ id: "proj-a", name: "a" }) },
      topics: { getOrCreate: vi.fn() },
      memories: {
        create: vi.fn(),
        upsertByTopicKey,
        list: vi.fn().mockResolvedValue({ items: [] }),
      },
      facts: { createWithDedup: vi.fn() },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: { id: "proj-a", name: "a" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const remember = mockServer.getActionHandler("lore-memory", "save")

    const result = await remember({
      title: "DB migration runbook",
      content: "...",
      kind: "runbook",
      topicKey: "runbook/db-migration",
    } as never)

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("Promotion advisory:")
    expect(text).toContain("- 5 revisions accumulated")
    expect(text).toContain("splitting the topic into narrower topicKeys")
    expect(text).toContain("archiving this chain")
    // Critical: the user-facing CTA must NOT contain the broken
    // decision-only path. A regression here means an operator pastes
    // a `lore-decision action='create' supersedesIds: [<runbook-id>]`
    // command and gets a `not a decision` rejection from
    // `DecisionService.getById`.
    expect(text).not.toContain("supersedesIds")
    expect(text).not.toContain("lore-decision action='create'")
    // No placeholder leak — `replaceAll` should no-op when the
    // suggestion carries no placeholder, but pinning explicitly
    // catches a future where a contributor mis-edits the
    // non-decision wording to include the placeholder while
    // forgetting to add the substitution.
    expect(text).not.toContain("<this-memory-id>")
  })
})

describe("lore-memory action='update' — topicKey re-keying (issue 0.9.0/14)", () => {
  // Conservative re-key path: an agent that picks the wrong topic
  // key on first save can switch to the canonical key without
  // abandoning the row. The MCP-layer tests pin the dispatch
  // contract — `handleUpdate` must reject `topicKey + kind` BEFORE
  // any I/O, preflight the re-key via `validateRekey` BEFORE any
  // mutation, dispatch content delta + `rekeyTopicKey` in that
  // order so the audit block isn't clobbered, skip
  // `services.memories.update` entirely on a pure re-key, and
  // wrap re-key failures during a combined update in a structured
  // `PartialUpdateError`.

  /**
   * Default `validateRekey` mock used across the re-keying tests.
   * Returns `willRekey: true` and a placeholder old key. Tests that
   * want different preflight behavior pass their own
   * `validateRekey` instead.
   */
  function defaultValidateRekey(oldTopicKey: string) {
    return vi.fn().mockResolvedValue({
      memory: makeMemory("mem-1", { topicKey: oldTopicKey, projectIds: ["P1"] }),
      oldTopicKey,
      willRekey: true,
    })
  }

  it("re-keys a memory and renders the rename in the response footer", async () => {
    const mockServer = createMockServer()
    const rekeyResult = {
      memory: makeMemory("mem-1", {
        title: "Use JWT auth",
        topicKey: "decision/jwt-auth-model",
        projectIds: ["P1"],
      }),
      oldTopicKey: "decision/jwt-auth",
    }
    const validateRekey = defaultValidateRekey("decision/jwt-auth")
    const rekeyTopicKey = vi.fn().mockResolvedValue(rekeyResult)
    const update = vi.fn()

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { validateRekey, rekeyTopicKey, update, getById: vi.fn() },
      facts: { queryBySourceMemory: vi.fn(), createWithDedup: vi.fn() },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    const result = await lore({
      memoryId: "mem-1",
      topicKey: "decision/jwt-auth-model",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(validateRekey).toHaveBeenCalledWith({
      memoryId: "mem-1",
      newTopicKey: "decision/jwt-auth-model",
    })
    expect(rekeyTopicKey).toHaveBeenCalledWith({
      memoryId: "mem-1",
      newTopicKey: "decision/jwt-auth-model",
    })
    // Pure re-key (no other fields set) → `services.memories.update`
    // must NOT fire. Pin verifies the framing-fields-only delta
    // after destructuring has zero residual keys.
    expect(update).not.toHaveBeenCalled()
    expect(text).toContain("Re-keyed: 'decision/jwt-auth' → 'decision/jwt-auth-model'")
    expect(text).toContain("Audit block appended to body.")
  })

  it("no-op when newTopicKey matches existing: skips rekeyTopicKey entirely and surfaces 'Topic key unchanged' acknowledgment", async () => {
    // The preflight `validateRekey` returns `willRekey: false` when
    // the new key matches the existing one. The handler must skip
    // the actual `rekeyTopicKey` call (no body write, no property
    // write) AND surface a `Topic key unchanged` line so the
    // operator can see the call was received and recognized as a
    // no-op rather than silently dropped.
    const mockServer = createMockServer()
    const validateRekey = vi.fn().mockResolvedValue({
      memory: makeMemory("mem-1", {
        topicKey: "decision/jwt-auth",
        projectIds: ["P1"],
      }),
      oldTopicKey: "decision/jwt-auth",
      willRekey: false,
    })
    const rekeyTopicKey = vi.fn()
    const update = vi.fn()
    const getById = vi.fn().mockResolvedValue(
      makeMemory("mem-1", {
        title: "Use JWT auth",
        topicKey: "decision/jwt-auth",
        projectIds: ["P1"],
      })
    )

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { validateRekey, rekeyTopicKey, update, getById },
      facts: { queryBySourceMemory: vi.fn(), createWithDedup: vi.fn() },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    const result = await lore({
      memoryId: "mem-1",
      topicKey: "decision/jwt-auth",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(validateRekey).toHaveBeenCalled()
    expect(rekeyTopicKey).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(text).toContain("Topic key unchanged: 'decision/jwt-auth'")
    expect(text).not.toContain("Re-keyed:")
    expect(text).not.toContain("Audit block appended")
  })

  it("rejects combined topicKey + kind BEFORE any I/O", async () => {
    // The combined-update guard is the load-bearing identity rule:
    // re-keying preserves the upsert-chain identity (kind is part
    // of identity), so a `topicKey + kind` call would smuggle a
    // kind change through the residual update path and split the
    // chain across two kinds. Mock every Notion-touching service
    // method and assert NONE fires — the throw lands at the handler
    // boundary before the preflight, the rekey, or any update.
    const mockServer = createMockServer()
    const validateRekey = vi.fn()
    const rekeyTopicKey = vi.fn()
    const update = vi.fn()
    const getById = vi.fn()

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { validateRekey, rekeyTopicKey, update, getById },
      facts: { queryBySourceMemory: vi.fn(), createWithDedup: vi.fn() },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    const result = await lore({
      memoryId: "mem-1",
      topicKey: "decision/new-key",
      kind: "decision",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toMatch(/Cannot combine `topicKey` \(re-key\) with `kind`/)
    expect(validateRekey).not.toHaveBeenCalled()
    expect(rekeyTopicKey).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(getById).not.toHaveBeenCalled()
  })

  it("resolves explicit project scope before re-key preflight reads", async () => {
    // A topicKey update accepts projectName/projectNames as a content
    // delta. The explicit scope check must run before validateRekey
    // because validateRekey reads the target row and collision
    // candidates; invalid explicit scope should fail before any read or
    // write scoped by the call.
    const mockServer = createMockServer()
    const findByName = vi.fn().mockResolvedValue(null)
    const validateRekey = vi.fn()
    const rekeyTopicKey = vi.fn()
    const update = vi.fn()
    const getById = vi.fn()

    const services = {
      projects: { findByName },
      topics: { getOrCreate: vi.fn() },
      memories: { validateRekey, rekeyTopicKey, update, getById },
      facts: { queryBySourceMemory: vi.fn(), createWithDedup: vi.fn() },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    const result = await lore({
      memoryId: "mem-1",
      topicKey: "decision/new",
      projectName: "Missing",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(text).toContain('Project "Missing" could not be resolved')
    expect(text).toContain("Fix the project scope")
    expect(findByName).toHaveBeenCalledWith("Missing")
    expect(validateRekey).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(rekeyTopicKey).not.toHaveBeenCalled()
    expect(getById).not.toHaveBeenCalled()
  })

  it("rejects blank explicit project scope before re-key preflight reads", async () => {
    const mockServer = createMockServer()
    const findByName = vi.fn().mockResolvedValue(null)
    const validateRekey = vi.fn()
    const rekeyTopicKey = vi.fn()
    const update = vi.fn()
    const getById = vi.fn()

    const services = {
      projects: { findByName },
      topics: { getOrCreate: vi.fn() },
      memories: { validateRekey, rekeyTopicKey, update, getById },
      facts: { queryBySourceMemory: vi.fn(), createWithDedup: vi.fn() },
      context: { project: { id: "ambient", name: "Ambient" }, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    const result = await lore({
      memoryId: "mem-1",
      topicKey: "decision/new",
      projectName: "",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(text).toContain('Project "" could not be resolved')
    expect(findByName).not.toHaveBeenCalled()
    expect(validateRekey).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(rekeyTopicKey).not.toHaveBeenCalled()
    expect(getById).not.toHaveBeenCalled()
  })

  it("combined re-key + content update: preflight first, then content update, then re-key", async () => {
    // Re-key + body update in one call. The preflight `validateRekey`
    // fires BEFORE any mutation so collision/empty-projectIds
    // failures surface without leaving a partial content update.
    // After preflight passes, content update fires SECOND and the
    // re-key fires THIRD — so the audit-block append by
    // `rekeyTopicKey` lands as the LAST write to the body.
    //
    // Reversing the latter two (re-key, then content update) was
    // the original spec but is load-bearing buggy:
    // `MemoryService.update`'s `replace_content` rewrites the FULL
    // body with the caller's `content` arg, which silently clobbers
    // the `## Re-keyed (date)` audit block that `rekeyTopicKey` had
    // just appended. The integration-style service test (in
    // `memory.test.ts`) verifies the final markdown contains both
    // the new content AND the audit block under this fixed order.
    //
    // Pinning all three call points keeps a future refactor that
    // moves the preflight (or drops it) honest.
    const mockServer = createMockServer()
    const rekeyResult = {
      memory: makeMemory("mem-1", {
        title: "Use JWT auth",
        topicKey: "decision/jwt-auth-model",
        projectIds: ["P1"],
      }),
      oldTopicKey: "decision/jwt-auth",
    }
    const updated = makeMemory("mem-1", {
      title: "Use JWT auth (revised)",
      topicKey: "decision/jwt-auth-model",
      projectIds: ["P1"],
    })
    const callOrder: string[] = []
    const validateRekey = vi.fn().mockImplementation(async () => {
      callOrder.push("validate")
      return {
        memory: makeMemory("mem-1", {
          topicKey: "decision/jwt-auth",
          projectIds: ["P1"],
        }),
        oldTopicKey: "decision/jwt-auth",
        willRekey: true,
      }
    })
    const update = vi.fn().mockImplementation(async () => {
      callOrder.push("update")
      return updated
    })
    const rekeyTopicKey = vi.fn().mockImplementation(async () => {
      callOrder.push("rekey")
      return rekeyResult
    })

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { validateRekey, rekeyTopicKey, update, getById: vi.fn() },
      facts: {
        queryBySourceMemory: vi.fn().mockResolvedValue([]),
        createWithDedup: vi.fn(),
      },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    const result = await lore({
      memoryId: "mem-1",
      topicKey: "decision/jwt-auth-model",
      content: "New body content",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    // Order pin: preflight → content update → re-key. A future
    // refactor that flips update/rekey would silently clobber the
    // audit block; one that drops the preflight would re-introduce
    // the partial-persist gap on collision/empty-projectIds.
    expect(callOrder).toEqual(["validate", "update", "rekey"])
    expect(update).toHaveBeenCalledWith(
      "mem-1",
      expect.objectContaining({ content: "New body content" })
    )
    // Pin that the residual `update` call does NOT include
    // `Revision Count` — the rekey path must not bump the counter,
    // and the content-update path forwards only the user-supplied
    // fields. Reading the entire arg shape here (rather than
    // `expect.objectContaining`) so a future contributor that
    // accidentally threads `revisionCount` through would break this
    // test.
    const updateArgs = update.mock.calls[0][1] as Record<string, unknown>
    expect("revisionCount" in updateArgs).toBe(false)
    expect("Revision Count" in updateArgs).toBe(false)
    expect(text).toContain("Re-keyed: 'decision/jwt-auth' → 'decision/jwt-auth-model'")
  })

  it("combined re-key + partial body-write failure says the re-key was skipped", async () => {
    const mockServer = createMockServer()
    const validateRekey = vi.fn().mockResolvedValue({
      memory: makeMemory("mem-1", {
        topicKey: "decision/old",
        projectIds: ["P1"],
      }),
      oldTopicKey: "decision/old",
      willRekey: true,
    })
    const bodyWriteError = new Error("notion 503")
    const update = vi
      .fn()
      .mockRejectedValue(
        new MemoryUpdatePartialFailureError(
          `Memory update partial failure: properties for memory mem-1 ` +
            `persisted, but the body write failed during phase "body": notion 503. ` +
            `The property changes are already on Notion; the body content was ` +
            `not written. Inspect the row before retrying the update.`,
          { memoryId: "mem-1", bodyWriteError }
        )
      )
    const rekeyTopicKey = vi.fn()

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { validateRekey, rekeyTopicKey, update, getById: vi.fn() },
      facts: { queryBySourceMemory: vi.fn(), createWithDedup: vi.fn() },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    const result = await lore({
      memoryId: "mem-1",
      topicKey: "decision/new",
      content: "New body content",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(update).toHaveBeenCalled()
    expect(rekeyTopicKey).not.toHaveBeenCalled()
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(text).toContain("Error: MemoryUpdatePartialFailureError")
    expect(text).toContain("properties for memory mem-1 persisted")
    expect(text).toContain("body content was not written")
    expect(text).toContain("requested re-key to 'decision/new' was not attempted")
    expect(text).toContain("before the re-key step")
  })

  it("surfaces a collision error from validateRekey BEFORE any content update lands", async () => {
    // The preflight catches collisions before the content delta
    // runs, so the operator sees a clean rejection rather than a
    // PartialUpdateError. This is the common case the preflight
    // exists to address.
    const mockServer = createMockServer()
    const validateRekey = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Re-key target 'decision/new' is already in use by " +
            "memory mem-collider in this project-set. " +
            "Lore does not auto-merge — archive one or pick a different key."
        )
      )
    const rekeyTopicKey = vi.fn()
    const update = vi.fn()

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { validateRekey, rekeyTopicKey, update, getById: vi.fn() },
      facts: { queryBySourceMemory: vi.fn(), createWithDedup: vi.fn() },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    const result = await lore({
      memoryId: "mem-1",
      topicKey: "decision/new",
      content: "New body that should NOT land",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("mem-collider")
    expect(text).toMatch(/already in use/)
    // The whole point of the preflight: the content update never
    // runs when the re-key is structurally invalid against the
    // current state.
    expect(update).not.toHaveBeenCalled()
    expect(rekeyTopicKey).not.toHaveBeenCalled()
  })

  it("partial-persist: content delta lands but re-key rejects post-update → throws PartialUpdateError", async () => {
    // The race window the reviewer flagged: preflight passes (no
    // collision against pre-update state), the content update
    // succeeds, then `rekeyTopicKey` rejects (e.g., another agent
    // grabbed the slot, the content update changed projectIds and
    // exposed a fresh collision under the post-update set, or a
    // transient Notion failure during the property write).
    //
    // The handler MUST surface this state via `PartialUpdateError`
    // so the operator gets an unambiguous signal that the content
    // mutation persisted while the re-key did not. A bare error
    // would read like a fully-failed update; the structured error
    // names the partial state.
    const mockServer = createMockServer()
    const validateRekey = vi.fn().mockResolvedValue({
      memory: makeMemory("mem-1", {
        topicKey: "decision/old",
        projectIds: ["P1"],
      }),
      oldTopicKey: "decision/old",
      willRekey: true,
    })
    const updated = makeMemory("mem-1", {
      title: "Updated title",
      projectIds: ["P1"],
    })
    const update = vi.fn().mockResolvedValue(updated)
    // Race: by the time `rekeyTopicKey` runs, a concurrent agent
    // has grabbed the new key.
    const rekeyTopicKey = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Re-key target 'decision/new' is already in use by " +
            "memory mem-racer in this project-set."
        )
      )

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { validateRekey, rekeyTopicKey, update, getById: vi.fn() },
      facts: {
        queryBySourceMemory: vi.fn().mockResolvedValue([]),
        createWithDedup: vi.fn(),
      },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    const result = await lore({
      memoryId: "mem-1",
      topicKey: "decision/new",
      title: "Updated title",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    // The content update DID land (preflight passed, update was
    // called) before the re-key rejected.
    expect(update).toHaveBeenCalled()
    // The error message names the partial state explicitly so
    // operators see "content update persisted, re-key did not"
    // rather than a generic failure.
    expect(text).toMatch(/Content update for memory mem-1 persisted/)
    expect(text).toMatch(/re-key to 'decision\/new' failed/)
    expect(text).toContain("mem-racer")
  })

  it("preflight skipped when topicKey is not provided: no preflight call, regular update flow", async () => {
    // A plain content update without a topicKey must NOT call
    // `validateRekey` — the preflight is exclusive to re-key
    // calls. Pin verifies that adding the preflight didn't
    // regress the cost of every regular update.
    const mockServer = createMockServer()
    const validateRekey = vi.fn()
    const rekeyTopicKey = vi.fn()
    const updated = makeMemory("mem-1", { title: "New title" })
    const update = vi.fn().mockResolvedValue(updated)

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { validateRekey, rekeyTopicKey, update, getById: vi.fn() },
      facts: {
        queryBySourceMemory: vi.fn().mockResolvedValue([]),
        createWithDedup: vi.fn(),
      },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    await lore({ memoryId: "mem-1", title: "New title" } as never)

    expect(validateRekey).not.toHaveBeenCalled()
    expect(rekeyTopicKey).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalled()
  })

  it("combined re-key + content: RekeyAuditError propagates UNCHANGED — no false 'topic key unchanged' or retry-rekey guidance", async () => {
    // Two distinct partial-state errors meet here: `RekeyAuditError`
    // says "Topic Key property persisted, audit-block append
    // failed" — the rekey structurally happened. `PartialUpdateError`
    // says "content persisted, rekey did NOT happen" — the rekey
    // did NOT happen.
    //
    // When `rekeyTopicKey` throws `RekeyAuditError` after a
    // content delta has landed, wrapping it in
    // `PartialUpdateError` would falsely tell the operator the
    // topic key is unchanged AND instruct an unnecessary retry of
    // the re-key. A retry would actually short-circuit through
    // `validateRekey`'s no-op guard because the new key now
    // matches the stored value — wasted operator effort and
    // confused mental model.
    //
    // The handler MUST detect `RekeyAuditError` specifically and
    // propagate it unchanged. Its own message accurately
    // describes the rekey-side state ("Re-key persisted but
    // audit-block append failed"); the operator who issued the
    // combined call already knows the content delta was
    // attempted in the same request.
    const mockServer = createMockServer()
    const validateRekey = vi.fn().mockResolvedValue({
      memory: makeMemory("mem-1", {
        topicKey: "decision/old",
        projectIds: ["P1"],
      }),
      oldTopicKey: "decision/old",
      willRekey: true,
    })
    const updated = makeMemory("mem-1", {
      title: "Updated title",
      projectIds: ["P1"],
    })
    const update = vi.fn().mockResolvedValue(updated)
    // Simulate the audit-failure-after-property-success scenario:
    // `pages.update` for Topic Key succeeded, `pages.updateMarkdown`
    // for the audit block failed, and `rekeyTopicKey` raised
    // `RekeyAuditError` carrying the structured partial state.
    const auditError = new RekeyAuditError(
      "Re-key persisted ('decision/old' → 'decision/new') but " +
        "audit-block append failed: simulated 502. The Topic Key " +
        "column is updated; the body audit trail is missing. " +
        "A retry will short-circuit as a no-op — the audit block " +
        "cannot be recovered automatically. Inspect memory mem-1 " +
        "on Notion to confirm and append the audit manually if " +
        "needed.",
      {
        memoryId: "mem-1",
        oldTopicKey: "decision/old",
        newTopicKey: "decision/new",
        cause: new Error("simulated 502"),
      }
    )
    const rekeyTopicKey = vi.fn().mockRejectedValue(auditError)

    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { validateRekey, rekeyTopicKey, update, getById: vi.fn() },
      facts: {
        queryBySourceMemory: vi.fn().mockResolvedValue([]),
        createWithDedup: vi.fn(),
      },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const lore = mockServer.getActionHandler("lore-memory", "update")

    const result = await lore({
      memoryId: "mem-1",
      topicKey: "decision/new",
      title: "Updated title",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    // The content update DID land (preflight passed, update was
    // called) AND the Topic Key property write succeeded — only
    // the audit-block append failed. The response surfaces the
    // RekeyAuditError's own message.
    expect(update).toHaveBeenCalled()
    expect(text).toMatch(/Re-key persisted/)
    expect(text).toMatch(/audit-block append failed/)

    // CRITICAL pins: the response must NOT claim the topic key is
    // unchanged (the rekey actually happened) AND must NOT
    // instruct the operator to re-issue the re-key (a retry
    // would no-op via the validateRekey short-circuit).
    expect(text).not.toMatch(/topic key is unchanged/)
    expect(text).not.toMatch(/re-issue the re-key/)
    // PartialUpdateError's wrapper-message preamble must NOT
    // appear; the handler propagated `RekeyAuditError` unchanged.
    expect(text).not.toMatch(/Content update for memory mem-1 persisted/)
  })
})

describe("lore-memory action='compare' (issue 0.9.0/05)", () => {
  function makeServicesForCompare(
    a: Memory,
    b: Memory,
    overrides: {
      decrementConfidence?: ReturnType<typeof vi.fn>
      recordCompared?: ReturnType<typeof vi.fn>
      createWithDedup?: ReturnType<typeof vi.fn>
      supersede?: ReturnType<typeof vi.fn>
    } = {}
  ) {
    const getById = vi.fn(async (id: string) => {
      if (id === a.id) return a
      if (id === b.id) return b
      throw new Error(`unknown id ${id}`)
    })
    const decrementConfidence =
      overrides.decrementConfidence ?? vi.fn(async (_m: unknown) => 0.45)
    const recordCompared =
      overrides.recordCompared ?? vi.fn(async () => ({ wroteA: true, wroteB: true }))
    const createWithDedup =
      overrides.createWithDedup ??
      vi.fn(async () => ({ fact: { id: "fact-1" }, deduped: false }))
    const supersede = overrides.supersede ?? vi.fn(async () => undefined)

    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { getById, decrementConfidence, recordCompared },
      facts: { createWithDedup },
      decisions: { supersede },
      context: { project: null },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }
    return {
      services,
      getById,
      decrementConfidence,
      recordCompared,
      createWithDedup,
      supersede,
    }
  }

  it("happy path conflicts_with: halves the affected memory's confidence and emits a fact", async () => {
    const mockServer = createMockServer()
    const a = makeMemory("page-a", { title: "Auth model A", projectIds: ["proj-a"] })
    const b = makeMemory("page-b", { title: "Auth model B", projectIds: ["proj-a"] })
    const { services, decrementConfidence, recordCompared, createWithDedup } =
      makeServicesForCompare(a, b)

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "conflicts_with",
      affectedMemoryId: "page-b",
      reason: "Newer evidence",
      judgeConfidence: 0.9,
    } as never)

    expect((result as { isError?: boolean }).isError).not.toBe(true)
    // decrementConfidence fires on memory B (the loser).
    expect(decrementConfidence).toHaveBeenCalledTimes(1)
    expect(decrementConfidence.mock.calls[0]![0]).toMatchObject({ id: "page-b" })
    // Fact subject = winner's title; object = loser's title.
    expect(createWithDedup).toHaveBeenCalledTimes(1)
    expect(createWithDedup.mock.calls[0]![0]).toMatchObject({
      subject: "Auth model A",
      predicate: "conflicts_with",
      object: "Auth model B",
    })
    // Audit-marker write fires too.
    expect(recordCompared).toHaveBeenCalledTimes(1)
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain("conflicts_with")
    expect(text).toContain("Auth model B")
    expect(text).toContain("fact-1")
  })

  it("flips the affected side: same pair with affectedMemoryId=memoryIdA halves memoryA, NOT memoryB", async () => {
    // Pins the directionality contract — order does NOT encode
    // direction; the affectedMemoryId field does.
    const mockServer = createMockServer()
    const a = makeMemory("page-a", { title: "A", projectIds: ["proj"] })
    const b = makeMemory("page-b", { title: "B", projectIds: ["proj"] })
    const { services, decrementConfidence, createWithDedup } = makeServicesForCompare(
      a,
      b
    )

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "conflicts_with",
      affectedMemoryId: "page-a",
      reason: "B wins",
    } as never)

    expect(decrementConfidence.mock.calls[0]![0]).toMatchObject({ id: "page-a" })
    // Subject = winner (B), object = loser (A).
    expect(createWithDedup.mock.calls[0]![0]).toMatchObject({
      subject: "B",
      object: "A",
    })
  })

  it("rejects asymmetric verdict without affectedMemoryId BEFORE any Notion read", async () => {
    const mockServer = createMockServer()
    const a = makeMemory("page-a", { projectIds: ["proj"] })
    const b = makeMemory("page-b", { projectIds: ["proj"] })
    const { services, getById, decrementConfidence } = makeServicesForCompare(a, b)

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "conflicts_with",
      reason: "missing affected",
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain("requires affectedMemoryId")
    // Direction validation fires BEFORE hydration — getById never called.
    expect(getById).not.toHaveBeenCalled()
    expect(decrementConfidence).not.toHaveBeenCalled()
  })

  it("rejects asymmetric verdict whose affectedMemoryId names a third memory BEFORE any Notion read", async () => {
    const mockServer = createMockServer()
    const a = makeMemory("page-a", { projectIds: ["proj"] })
    const b = makeMemory("page-b", { projectIds: ["proj"] })
    const { services, getById } = makeServicesForCompare(a, b)

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "conflicts_with",
      affectedMemoryId: "page-c-third-memory",
      reason: "x",
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain("must equal memoryIdA or memoryIdB")
    expect(getById).not.toHaveBeenCalled()
  })

  it("rejects symmetric verdict with affectedMemoryId set BEFORE any Notion read", async () => {
    const mockServer = createMockServer()
    const a = makeMemory("page-a", { projectIds: ["proj"] })
    const b = makeMemory("page-b", { projectIds: ["proj"] })
    const { services, getById } = makeServicesForCompare(a, b)

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "scoped",
      affectedMemoryId: "page-a",
      reason: "x",
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain("symmetric")
    expect(text).toContain("affectedMemoryId must be omitted")
    expect(getById).not.toHaveBeenCalled()
  })

  it("supersedes verdict requires the affected memory's kind to be 'decision' (rejects non-decision)", async () => {
    const mockServer = createMockServer()
    const a = makeMemory("page-a", {
      title: "Decision",
      kind: "decision",
      projectIds: ["proj"],
    })
    const b = makeMemory("page-b", {
      title: "Note",
      kind: "note",
      projectIds: ["proj"],
    })
    const { services, decrementConfidence, recordCompared, createWithDedup } =
      makeServicesForCompare(a, b)

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "supersedes",
      affectedMemoryId: "page-b",
      reason: "x",
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain("kind='decision'")
    // Throws AFTER hydration but BEFORE dispatch — no decrement,
    // no fact write, no audit marker.
    expect(decrementConfidence).not.toHaveBeenCalled()
    expect(createWithDedup).not.toHaveBeenCalled()
    expect(recordCompared).not.toHaveBeenCalled()
  })

  it("supersedes verdict on a decision-kind affected memory dispatches through decisions.supersede + fact + decrement", async () => {
    // Reviewer #1 P1 #1 pinned: supersedes must route through the
    // existing `lore-decision action='supersede'` semantics. This
    // test asserts decisions.supersede(winner.id, loser.id) fires
    // (otherwise the new decision's Supersedes relation is never
    // updated and the old decision's Status stays at "accepted")
    // alongside the fact emission and decrement.
    const mockServer = createMockServer()
    const a = makeMemory("page-a", {
      title: "New decision",
      kind: "decision",
      projectIds: ["proj"],
    })
    const b = makeMemory("page-b", {
      title: "Old decision",
      kind: "decision",
      projectIds: ["proj"],
    })
    const { services, decrementConfidence, recordCompared, createWithDedup, supersede } =
      makeServicesForCompare(a, b)

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "supersedes",
      affectedMemoryId: "page-b",
      reason: "Old approach is wrong",
    } as never)

    expect((result as { isError?: boolean }).isError).not.toBe(true)
    // decisions.supersede actually runs — without it the response
    // text claiming "marked superseded" would be a lie.
    expect(supersede).toHaveBeenCalledTimes(1)
    expect(supersede).toHaveBeenCalledWith("page-a", "page-b")
    expect(decrementConfidence.mock.calls[0]![0]).toMatchObject({
      id: "page-b",
    })
    // Fact uses IDs (canonical decision-graph identifier) matching
    // the existing `lore-decision action='supersede'` shape.
    expect(createWithDedup.mock.calls[0]![0]).toMatchObject({
      predicate: "supersedes_decision",
      subject: "page-a",
      object: "page-b",
    })
    expect(recordCompared).toHaveBeenCalledTimes(1)
  })

  it("symmetric verdicts (scoped/related/compatible/not_conflict) skip decrement and fact emission", async () => {
    for (const verdict of ["scoped", "related", "compatible", "not_conflict"] as const) {
      const mockServer = createMockServer()
      const a = makeMemory(`a-${verdict}`, { projectIds: ["proj"] })
      const b = makeMemory(`b-${verdict}`, { projectIds: ["proj"] })
      const { services, decrementConfidence, recordCompared, createWithDedup } =
        makeServicesForCompare(a, b)

      registerMemoryTools(mockServer.server, services as never)
      const compare = mockServer.getActionHandler("lore-memory", "compare")

      const result = await compare({
        memoryIdA: a.id,
        memoryIdB: b.id,
        verdict,
        reason: "x",
      } as never)

      expect((result as { isError?: boolean }).isError).not.toBe(true)
      expect(decrementConfidence).not.toHaveBeenCalled()
      expect(createWithDedup).not.toHaveBeenCalled()
      expect(recordCompared).toHaveBeenCalledTimes(1)
    }
  })

  it("self-pair (memoryIdA === memoryIdB) returns an error before any Notion read", async () => {
    const mockServer = createMockServer()
    const a = makeMemory("page-a", { projectIds: ["proj"] })
    const { services, getById } = makeServicesForCompare(a, a)

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-a",
      verdict: "scoped",
      reason: "x",
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect((result as { content: Array<{ text: string }> }).content[0]!.text).toContain(
      "Cannot compare a memory to itself"
    )
    expect(getById).not.toHaveBeenCalled()
  })

  it("cross-project pair with disjoint project sets returns an error", async () => {
    const mockServer = createMockServer()
    const a = makeMemory("page-a", { projectIds: ["proj-A"] })
    const b = makeMemory("page-b", { projectIds: ["proj-B"] })
    const { services, decrementConfidence } = makeServicesForCompare(a, b)

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "scoped",
      reason: "x",
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect((result as { content: Array<{ text: string }> }).content[0]!.text).toContain(
      "disjoint project sets"
    )
    expect(decrementConfidence).not.toHaveBeenCalled()
  })

  it("idempotent re-compare: same pair + same actionable verdict + same direction short-circuits with zero side effects", async () => {
    // Pre-populate both final audit entries from the previous call.
    // The handler should detect the pair is fully recorded and return
    // alreadyJudged: true without firing any side effect.
    const priorEntryA = JSON.stringify({
      verdict: "conflicts_with",
      target: "page-b",
      affected: "page-b",
      reason: "previous run",
      judgedAt: "2026-04-29T00:00:00.000Z",
      promptVersion: "1",
    })
    const priorEntryB = JSON.stringify({
      verdict: "conflicts_with",
      target: "page-a",
      affected: "page-b",
      reason: "previous run",
      judgedAt: "2026-04-29T00:00:00.000Z",
      promptVersion: "1",
    })
    const mockServer = createMockServer()
    const a = makeMemory("page-a", {
      title: "Winner",
      projectIds: ["proj"],
      compareNotes: priorEntryA,
    })
    const b = makeMemory("page-b", {
      title: "Loser",
      projectIds: ["proj"],
      compareNotes: priorEntryB,
    })
    const { services, decrementConfidence, recordCompared, createWithDedup } =
      makeServicesForCompare(a, b)

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "conflicts_with",
      affectedMemoryId: "page-b",
      reason: "newer run",
    } as never)

    expect((result as { isError?: boolean }).isError).not.toBe(true)
    expect((result as { content: Array<{ text: string }> }).content[0]!.text).toContain(
      "already recorded"
    )
    // Zero side effects on the duplicate call.
    expect(decrementConfidence).not.toHaveBeenCalled()
    expect(createWithDedup).not.toHaveBeenCalled()
    expect(recordCompared).not.toHaveBeenCalled()
  })

  it("retry after fact-created/decrement-landed state skips a second decrement and writes final audit", async () => {
    const ledger = buildCompareDispatchLedgerEntry({
      verdict: "conflicts_with",
      sourceMemoryId: "page-a",
      affectedMemoryId: "page-b",
    })
    const mockServer = createMockServer()
    const a = makeMemory("page-a", { title: "Winner", projectIds: ["proj"] })
    const b = makeMemory("page-b", {
      title: "Loser",
      projectIds: ["proj"],
      compareNotes: appendCompareDispatchLedgerEntry("", ledger),
    })
    const decrementConfidence = vi.fn(async (_m: unknown) => 0.45)
    const createWithDedup = vi.fn(async () => ({
      fact: { id: "fact-existing" },
      deduped: true,
    }))
    const recordCompared = vi.fn(async () => ({ wroteA: true, wroteB: true }))
    const { services } = makeServicesForCompare(a, b, {
      decrementConfidence,
      createWithDedup,
      recordCompared,
    })

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "conflicts_with",
      affectedMemoryId: "page-b",
      reason: "retry after uncertain decrement response",
    } as never)

    expect((result as { isError?: boolean }).isError).not.toBe(true)
    expect(createWithDedup).toHaveBeenCalledTimes(1)
    expect(decrementConfidence).not.toHaveBeenCalled()
    expect(recordCompared).toHaveBeenCalledTimes(1)
    const recordComparedCall = recordCompared.mock.calls[0] as unknown as [
      { memoryB: { compareNotes: string } },
    ]
    const recordedLedger = JSON.parse(recordComparedCall[0].memoryB.compareNotes) as {
      dispatchKey: string
    }
    expect(recordedLedger.dispatchKey).toBe(ledger.dispatchKey)
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain("confidence already halved")
  })

  it("actionable one-sided audit recovery uses the decrement ledger and catches up the missing side", async () => {
    const finalEntryOnWinner = JSON.stringify({
      verdict: "conflicts_with",
      target: "page-b",
      affected: "page-b",
      reason: "prior call wrote A only",
      judgedAt: "2026-04-29T00:00:00.000Z",
      promptVersion: "1",
    })
    const ledger = buildCompareDispatchLedgerEntry({
      verdict: "conflicts_with",
      sourceMemoryId: "page-a",
      affectedMemoryId: "page-b",
    })
    const a = makeMemory("page-a", {
      title: "Winner",
      projectIds: ["proj"],
      comparedWith: ["page-b"],
      compareNotes: finalEntryOnWinner,
    })
    const b = makeMemory("page-b", {
      title: "Loser",
      projectIds: ["proj"],
      compareNotes: appendCompareDispatchLedgerEntry("", ledger),
    })

    const updates: Array<{ page_id: string; properties: Record<string, unknown> }> = []
    const mockClient = {
      pages: {
        update: vi.fn(
          async (args: { page_id: string; properties: Record<string, unknown> }) => {
            updates.push(args)
            return undefined
          }
        ),
      },
    } as never
    const { MemoryService } = await import("../../core/memory.js")
    const realMemories = new MemoryService(mockClient, {
      databaseId: "memories-db",
      dataSourceId: "memories-ds",
    })

    const mockServer = createMockServer()
    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: {
        getById: vi.fn(async (id: string) => {
          if (id === "page-a") return a
          if (id === "page-b") return b
          throw new Error(`unknown id ${id}`)
        }),
        recordCompared: realMemories.recordCompared.bind(realMemories),
        decrementConfidence: vi.fn(),
      },
      facts: {
        createWithDedup: vi.fn(async () => ({
          fact: { id: "fact-existing" },
          deduped: true,
        })),
      },
      decisions: { supersede: vi.fn() },
      context: { project: null },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "conflicts_with",
      affectedMemoryId: "page-b",
      reason: "retry catches B up",
    } as never)

    expect((result as { isError?: boolean }).isError).not.toBe(true)
    expect(services.memories.decrementConfidence).not.toHaveBeenCalled()
    expect(updates).toHaveLength(1)
    expect(updates[0]!.page_id).toBe("page-b")
    const notes = (
      updates[0]!.properties["Compare Notes"] as {
        rich_text: Array<{ text: { content: string } }>
      }
    ).rich_text
      .map((r) => r.text.content)
      .join("")
    const firstLine = JSON.parse(notes.split("\n")[0]!) as { dispatchKey: string }
    expect(firstLine.dispatchKey).toBe(ledger.dispatchKey)
    expect(notes).toContain('"verdict":"conflicts_with"')
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain("Audit recovery")
    expect(text).toContain("only side B")
  })

  it("legacy one-sided actionable audit without ledger repairs missing side without decrementing again", async () => {
    const finalEntryOnWinner = JSON.stringify({
      verdict: "conflicts_with",
      target: "page-b",
      affected: "page-b",
      reason: "pre-ledger partial success",
      judgedAt: "2026-04-29T00:00:00.000Z",
      promptVersion: "1",
    })
    const ledger = buildCompareDispatchLedgerEntry({
      verdict: "conflicts_with",
      sourceMemoryId: "page-a",
      affectedMemoryId: "page-b",
    })
    const mockServer = createMockServer()
    const a = makeMemory("page-a", {
      title: "Winner",
      projectIds: ["proj"],
      comparedWith: ["page-b"],
      compareNotes: finalEntryOnWinner,
    })
    const b = makeMemory("page-b", { title: "Loser", projectIds: ["proj"] })
    const decrementConfidence = vi.fn(async (_m: unknown) => 0.45)
    const createWithDedup = vi.fn(async () => ({
      fact: { id: "fact-should-not-run" },
      deduped: true,
    }))
    const recordCompared = vi.fn(async () => ({ wroteA: false, wroteB: true }))
    const { services } = makeServicesForCompare(a, b, {
      decrementConfidence,
      createWithDedup,
      recordCompared,
    })

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "conflicts_with",
      affectedMemoryId: "page-b",
      reason: "repair old one-sided audit",
    } as never)

    expect((result as { isError?: boolean }).isError).not.toBe(true)
    expect(createWithDedup).not.toHaveBeenCalled()
    expect(decrementConfidence).not.toHaveBeenCalled()
    expect(recordCompared).toHaveBeenCalledTimes(1)
    const recordComparedCall = recordCompared.mock.calls[0] as unknown as [
      { memoryB: { compareNotes: string } },
    ]
    const recordedLedger = JSON.parse(recordComparedCall[0].memoryB.compareNotes) as {
      dispatchKey: string
    }
    expect(recordedLedger.dispatchKey).toBe(ledger.dispatchKey)
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain("confidence already halved")
    expect(text).toContain("Audit recovery")
    expect(text).toContain("only side B")
  })

  it("legacy partial with affected-side audit persists the ledger without duplicating the final audit", async () => {
    const finalEntryOnAffected = JSON.stringify({
      verdict: "conflicts_with",
      target: "page-a",
      affected: "page-b",
      reason: "pre-ledger partial success",
      judgedAt: "2026-04-29T00:00:00.000Z",
      promptVersion: "1",
    })
    const ledger = buildCompareDispatchLedgerEntry({
      verdict: "conflicts_with",
      sourceMemoryId: "page-a",
      affectedMemoryId: "page-b",
    })
    const mockServer = createMockServer()
    const a = makeMemory("page-a", { title: "Winner", projectIds: ["proj"] })
    const b = makeMemory("page-b", {
      title: "Loser",
      projectIds: ["proj"],
      comparedWith: ["page-a"],
      compareNotes: finalEntryOnAffected,
    })
    const decrementConfidence = vi.fn(async (_m: unknown) => 0.45)
    const createWithDedup = vi.fn(async () => ({
      fact: { id: "fact-should-not-run" },
      deduped: true,
    }))
    const recordCompared = vi.fn(async () => ({ wroteA: true, wroteB: true }))
    const { services } = makeServicesForCompare(a, b, {
      decrementConfidence,
      createWithDedup,
      recordCompared,
    })

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "conflicts_with",
      affectedMemoryId: "page-b",
      reason: "repair old affected-side audit",
    } as never)

    expect((result as { isError?: boolean }).isError).not.toBe(true)
    expect(createWithDedup).not.toHaveBeenCalled()
    expect(decrementConfidence).not.toHaveBeenCalled()
    expect(recordCompared).toHaveBeenCalledTimes(1)
    const recordComparedCall = recordCompared.mock.calls[0] as unknown as [
      { memoryB: { compareNotes: string }; forceWriteB: boolean },
    ]
    expect(recordComparedCall[0].forceWriteB).toBe(true)
    const lines = recordComparedCall[0].memoryB.compareNotes
      .split("\n")
      .map((line) => JSON.parse(line) as { entryType?: string; dispatchKey?: string })
    expect(lines).toHaveLength(2)
    expect(lines.some((line) => line.dispatchKey === ledger.dispatchKey)).toBe(true)
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain("confidence already halved")
  })

  it("flipped-direction re-compare on a same-verdict pair RE-DISPATCHES (does NOT short-circuit)", async () => {
    // Reviewer #2 finding pinned. Walk-through:
    //   1. (A, B, conflicts_with, affected=B) — B halved, A.notes
    //      gets {target=B, affected=B}, B.notes gets {target=A,
    //      affected=B}.
    //   2. (A, B, conflicts_with, affected=A) — corrected direction.
    //      Without direction in the idempotency key, the gate would
    //      check B.notes for {target=A, verdict=conflicts_with}, find
    //      it, and incorrectly short-circuit. With `affected` in the
    //      key, the gate query asks for affected=A but finds
    //      affected=B → no match → dispatch fires and A is halved.
    //
    // Pre-plant B.notes with the prior call's mirror entry
    // (target=A, affected=B). The new call queries B.notes (winner
    // for affected=A is B) for (target=A, affected=A). Mismatch on
    // affected — gate clears.
    const priorEntry = JSON.stringify({
      verdict: "conflicts_with",
      target: "page-a",
      affected: "page-b",
      reason: "first call (B was loser)",
      judgedAt: "2026-04-29T00:00:00.000Z",
      promptVersion: "1",
    })
    const mockServer = createMockServer()
    const a = makeMemory("page-a", {
      title: "A",
      projectIds: ["proj"],
    })
    const b = makeMemory("page-b", {
      title: "B",
      projectIds: ["proj"],
      compareNotes: priorEntry,
    })
    const { services, decrementConfidence, createWithDedup, recordCompared } =
      makeServicesForCompare(a, b)

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "conflicts_with",
      affectedMemoryId: "page-a", // corrected direction
      reason: "actually A loses",
    } as never)

    expect((result as { isError?: boolean }).isError).not.toBe(true)
    // A is halved this time, NOT B.
    expect(decrementConfidence).toHaveBeenCalledTimes(1)
    expect(decrementConfidence.mock.calls[0]![0]).toMatchObject({
      id: "page-a",
    })
    expect(createWithDedup).toHaveBeenCalledTimes(1)
    expect(recordCompared).toHaveBeenCalledTimes(1)
  })

  it("symmetric idempotency holds under swapped argument order — both sides carry the entry, the swap short-circuits", async () => {
    // Reviewer NIT pinned: after a successful first call (X, Y,
    // scoped), BOTH sides carry the matching entry. A swapped-order
    // re-call (Y, X, scoped) must short-circuit at the gate. The
    // gate now checks BOTH sides for symmetric verdicts so this
    // works regardless of which side becomes `memoryA` on the swap.
    const entryOnX = JSON.stringify({
      verdict: "scoped",
      target: "page-y",
      affected: null,
      reason: "different scope",
      judgedAt: "2026-04-29T00:00:00.000Z",
      promptVersion: "1",
    })
    const entryOnY = JSON.stringify({
      verdict: "scoped",
      target: "page-x",
      affected: null,
      reason: "different scope",
      judgedAt: "2026-04-29T00:00:00.000Z",
      promptVersion: "1",
    })
    const mockServer = createMockServer()
    const x = makeMemory("page-x", {
      title: "X",
      projectIds: ["proj"],
      compareNotes: entryOnX,
    })
    const y = makeMemory("page-y", {
      title: "Y",
      projectIds: ["proj"],
      compareNotes: entryOnY,
    })
    const { services, recordCompared } = makeServicesForCompare(x, y)

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    // Second call with SWAPPED argument order: Y is now memoryIdA.
    // The both-sides gate hits — short-circuits.
    const result = await compare({
      memoryIdA: "page-y",
      memoryIdB: "page-x",
      verdict: "scoped",
      reason: "swap",
    } as never)

    expect((result as { isError?: boolean }).isError).not.toBe(true)
    expect((result as { content: Array<{ text: string }> }).content[0]!.text).toContain(
      "already recorded"
    )
    expect(recordCompared).not.toHaveBeenCalled()
  })

  it("symmetric partial-failure recovery: only one side carries the entry, retry catches up the missing side without duplicating the present side", async () => {
    // The new reviewer's [P2] regression test. Models the
    // first-call-A-succeeded-B-failed state directly: A's notes
    // carry the matching entry, B's are empty. A retry MUST proceed
    // (gate must NOT short-circuit) and recordCompared MUST skip A
    // (already has the entry) and write B (missing the entry). The
    // response surfaces `Audit recovery: only side B...` so the
    // operator can confirm the pair's audit state is now consistent.
    //
    // To verify per-side idempotency at the service layer, this test
    // uses a real `MemoryService.recordCompared` (not a mock) backed
    // by a synthetic Notion `pages.update` recorder. The handler-
    // level mocks are stubs only for memories.getById / facts /
    // decisions / context — recordCompared runs the real per-side
    // skip-or-write logic.
    const partialEntryOnA = JSON.stringify({
      verdict: "scoped",
      target: "page-b",
      affected: null,
      reason: "first call landed A but not B",
      judgedAt: "2026-04-29T00:00:00.000Z",
      promptVersion: "1",
    })
    const a = makeMemory("page-a", {
      title: "A",
      projectIds: ["proj"],
      // The relation list also carries B's id from the prior
      // partial-success — Compared With is set-semantic so the
      // retry won't grow it past size 1.
      comparedWith: ["page-b"],
      compareNotes: partialEntryOnA,
    })
    const b = makeMemory("page-b", {
      title: "B",
      projectIds: ["proj"],
      // B is the side that previously failed: empty notes, empty
      // relation. The retry must catch B up.
      comparedWith: [],
      compareNotes: "",
    })

    // Build a mock client that records every `pages.update` call so
    // we can verify per-side behavior: A is skipped (no update), B
    // is written.
    const updates: Array<{ page_id: string; properties: Record<string, unknown> }> = []
    const mockClient = {
      pages: {
        update: vi.fn(
          async (args: { page_id: string; properties: Record<string, unknown> }) => {
            updates.push(args)
            return undefined
          }
        ),
      },
    } as never

    // Wire a real `MemoryService` for `recordCompared`. The other
    // handler-level service stubs follow the existing pattern.
    const { MemoryService } = await import("../../core/memory.js")
    const realMemories = new MemoryService(mockClient, {
      databaseId: "memories-db",
      dataSourceId: "memories-ds",
    })

    const mockServer = createMockServer()
    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: {
        // getById returns the partial-state snapshots above.
        getById: vi.fn(async (id: string) => {
          if (id === "page-a") return a
          if (id === "page-b") return b
          throw new Error(`unknown id ${id}`)
        }),
        // recordCompared is the REAL implementation, bound to the
        // mock client. Per-side idempotency is what we're testing.
        recordCompared: realMemories.recordCompared.bind(realMemories),
        decrementConfidence: vi.fn(),
      },
      facts: { createWithDedup: vi.fn() },
      decisions: { supersede: vi.fn() },
      context: { project: null },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "scoped",
      reason: "retry after first call's B-side failure",
    } as never)

    expect((result as { isError?: boolean }).isError).not.toBe(true)

    // Exactly ONE pages.update fires — for B. A is skipped because
    // its loaded snapshot already carries the matching entry.
    expect(updates).toHaveLength(1)
    expect(updates[0]!.page_id).toBe("page-b")

    // B's update writes the missing audit entry AND adds A to its
    // (previously empty) Compared With.
    const bUpdate = updates[0]!
    const bRelation = (
      bUpdate.properties["Compared With"] as {
        relation: { id: string }[]
      }
    ).relation
    expect(bRelation).toEqual([{ id: "page-a" }])
    const bNotes = (
      bUpdate.properties["Compare Notes"] as {
        rich_text: Array<{ text: { content: string } }>
      }
    ).rich_text
      .map((r) => r.text.content)
      .join("")
    const bEntry = JSON.parse(bNotes) as {
      target: string
      verdict: string
      affected: null
    }
    expect(bEntry).toMatchObject({
      target: "page-a",
      verdict: "scoped",
      affected: null,
    })

    // The response surfaces the recovery so the agent can tell the
    // operator the pair's audit state is now consistent.
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain("Audit recovery")
    expect(text).toContain("only side B")
    expect(text).toContain("page-b")
  })

  it("symmetric idempotent retry where BOTH sides carry the entry: zero pages.update calls, alreadyJudged response", async () => {
    // The other half of the reviewer's regression coverage: a true
    // idempotent re-call. The gate's both-sides check short-circuits
    // before recordCompared runs at all.
    const entryOnA = JSON.stringify({
      verdict: "scoped",
      target: "page-b",
      affected: null,
      reason: "x",
      judgedAt: "2026-04-29T00:00:00.000Z",
      promptVersion: "1",
    })
    const entryOnB = JSON.stringify({
      verdict: "scoped",
      target: "page-a",
      affected: null,
      reason: "x",
      judgedAt: "2026-04-29T00:00:00.000Z",
      promptVersion: "1",
    })
    const mockServer = createMockServer()
    const a = makeMemory("page-a", {
      title: "A",
      projectIds: ["proj"],
      comparedWith: ["page-b"],
      compareNotes: entryOnA,
    })
    const b = makeMemory("page-b", {
      title: "B",
      projectIds: ["proj"],
      comparedWith: ["page-a"],
      compareNotes: entryOnB,
    })
    const { services, recordCompared } = makeServicesForCompare(a, b)

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "scoped",
      reason: "x",
    } as never)

    expect((result as { isError?: boolean }).isError).not.toBe(true)
    expect((result as { content: Array<{ text: string }> }).content[0]!.text).toContain(
      "already recorded"
    )
    // recordCompared never reached — the gate short-circuited.
    expect(recordCompared).not.toHaveBeenCalled()
  })

  it("verdict change on same pair (not_conflict → conflicts_with) IS allowed: fresh dispatch fires", async () => {
    // Documents the "verdict change is allowed" contract — a prior
    // not_conflict entry must NOT suppress a fresh conflicts_with
    // judgment.
    const priorEntry = JSON.stringify({
      verdict: "not_conflict",
      target: "page-b",
      reason: "earlier",
      judgedAt: "2026-04-29T00:00:00.000Z",
      promptVersion: "1",
    })
    const mockServer = createMockServer()
    const a = makeMemory("page-a", {
      title: "Winner",
      projectIds: ["proj"],
      compareNotes: priorEntry,
    })
    const b = makeMemory("page-b", { title: "Loser", projectIds: ["proj"] })
    const { services, decrementConfidence, createWithDedup, recordCompared } =
      makeServicesForCompare(a, b)

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "conflicts_with",
      affectedMemoryId: "page-b",
      reason: "actually a conflict",
    } as never)

    expect((result as { isError?: boolean }).isError).not.toBe(true)
    expect(decrementConfidence).toHaveBeenCalledTimes(1)
    expect(createWithDedup).toHaveBeenCalledTimes(1)
    expect(recordCompared).toHaveBeenCalledTimes(1)
  })

  it("Compare Notes overflow preflight blocks destructive side effects on conflicts_with", async () => {
    // Pad memoryB's existing notes (B is the WINNER for affectedMemoryId=A
    // — wait, here memory_loser is A, so winner is B; we need memoryB's
    // compareNotes to be checked AFTER the gate against memoryA's
    // compareNotes for target=B. But the preflight runs against BOTH
    // sides' appendCompareNote, so any side overflowing throws.
    const sampleEntry = {
      verdict: "conflicts_with",
      target: "page-a",
      reason: "x",
      judgedAt: "2026-04-30T00:00:00.000Z",
      promptVersion: "1",
    }
    const entryLen = JSON.stringify(sampleEntry).length
    const padTo = COMPARE_NOTES_MAX_CHARS - entryLen + 1
    const overflowing = "a".repeat(padTo)

    const mockServer = createMockServer()
    const a = makeMemory("page-a", { title: "A", projectIds: ["proj"] })
    const b = makeMemory("page-b", {
      title: "B",
      projectIds: ["proj"],
      compareNotes: overflowing,
    })
    const { services, decrementConfidence, recordCompared, createWithDedup } =
      makeServicesForCompare(a, b)

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "conflicts_with",
      affectedMemoryId: "page-a",
      reason: "x",
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect((result as { content: Array<{ text: string }> }).content[0]!.text).toContain(
      "Compare Notes overflow"
    )
    // NEITHER destructive call fires — the preflight is the gate.
    expect(decrementConfidence).not.toHaveBeenCalled()
    expect(createWithDedup).not.toHaveBeenCalled()
    expect(recordCompared).not.toHaveBeenCalled()
  })

  it("post-dispatch recordCompared failure throws structured error with diagnostic fields embedded in the message", async () => {
    // Reviewer #2 BLOCKING #2 pinned. `toolError` only forwards
    // `error.message` — typed `readonly` fields on a custom Error
    // class would be dropped before the agent ever sees them. So
    // every diagnostic the operator needs to manually reconcile MUST
    // appear in the message text itself. Pin every field by name in
    // the rendered output so a future refactor that drops one breaks
    // this test rather than silently regressing the operator UX.
    const mockServer = createMockServer()
    const a = makeMemory("page-a", { title: "A", projectIds: ["proj"] })
    const b = makeMemory("page-b", { title: "B", projectIds: ["proj"] })
    const recordCompared = vi.fn(async () => {
      throw new Error("notion 429 — Compare Notes write failed")
    })
    const decrementConfidence = vi.fn(async (_m: unknown) => 0.45)
    const createWithDedup = vi.fn(async () => ({
      fact: { id: "fact-99" },
      deduped: false,
    }))
    const { services } = makeServicesForCompare(a, b, {
      recordCompared,
      decrementConfidence,
      createWithDedup,
    })

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "conflicts_with",
      affectedMemoryId: "page-b",
      reason: "x",
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text
    // Surface the documented partial-failure shape — operator gets
    // retry-safe guidance plus manual-inspection diagnostics.
    expect(text).toContain("dispatch landed but recordCompared failed")
    expect(text).toContain("inconsistentState: true")
    expect(text).toMatch(/inspect/i)
    expect(text).toMatch(/Retrying the same lore-memory action='compare' is safe/i)
    // Diagnostic fields the operator needs to reconcile — every one
    // pinned by name + value so it can't silently drop.
    expect(text).toContain("dispatchedFactId=fact-99")
    expect(text).toContain("decrementedMemoryId=page-b")
    expect(text).toContain("compareNotesEntryToWriteA=")
    expect(text).toContain("compareNotesEntryToWriteB=")
    expect(text).toContain("comparedWithRelationToWrite=")
    // The NDJSON entries embedded in the message contain the pair
    // ids the operator needs to know which lines should land on
    // which page.
    expect(text).toContain('"target":"page-b"')
    expect(text).toContain('"target":"page-a"')
    expect(text).toContain('"affected":"page-b"')
    // Destructive side effects DID land.
    expect(decrementConfidence).toHaveBeenCalledTimes(1)
    const decrementCall = decrementConfidence.mock.calls[0] as unknown as [
      unknown,
      { compareNotes: string },
    ]
    expect(decrementCall[1].compareNotes).toContain('"entryType":"compare_dispatch"')
    expect(createWithDedup).toHaveBeenCalledTimes(1)
  })

  it("dispatch partial-failure (fact lands, decrement throws) surfaces step/factId/affectedMemoryId via tool error message", async () => {
    // Latest reviewer P1: `CompareDispatchPartialFailureError` carries
    // typed `step` / `affectedMemoryId` / `factId` properties, but
    // `toolError` only renders `.message`. Pin that the message text
    // itself carries those fields so the operator triaging the agent's
    // response can manually reconcile without reading typed Error
    // properties (which never reach the agent).
    const mockServer = createMockServer()
    const a = makeMemory("page-a", { title: "A", projectIds: ["proj"] })
    const b = makeMemory("page-b", { title: "B", projectIds: ["proj"] })
    const decrementConfidence = vi.fn(async (_m: unknown) => {
      throw new Error("notion 429 — decrement failed")
    })
    const createWithDedup = vi.fn(async () => ({
      fact: { id: "fact-mid-dispatch" },
      deduped: false,
    }))
    const recordCompared = vi.fn(async () => ({ wroteA: true, wroteB: true }))
    const { services } = makeServicesForCompare(a, b, {
      decrementConfidence,
      createWithDedup,
      recordCompared,
    })

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "conflicts_with",
      affectedMemoryId: "page-b",
      reason: "x",
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text
    // Diagnostic surface — every field interpolated by name+value.
    expect(text).toContain("inconsistentState: true")
    expect(text).toContain("step=fact")
    expect(text).toContain("affectedMemoryId=page-b")
    expect(text).toContain("factId=fact-mid-dispatch")
    expect(text).toContain("dispatchKey=")
    expect(text).toMatch(/Retry the same/)
    // The fact landed; the decrement did not. Audit marker never got
    // a chance to fire, so recordCompared was NOT called.
    expect(createWithDedup).toHaveBeenCalledTimes(1)
    expect(decrementConfidence).toHaveBeenCalledTimes(1)
    expect(recordCompared).not.toHaveBeenCalled()
  })

  it("supersedes partial-failure (decisions.supersede lands, fact create throws) surfaces step=supersede + supersedingMemoryId", async () => {
    // Mirror of the conflicts_with partial-failure test for the
    // supersede path. `step=supersede` distinguishes "decisions.supersede
    // landed but fact didn't" from "fact landed but decrement didn't"
    // (`step=fact`); the operator's manual recovery procedure differs.
    const mockServer = createMockServer()
    const a = makeMemory("page-a", {
      title: "New",
      kind: "decision",
      projectIds: ["proj"],
    })
    const b = makeMemory("page-b", {
      title: "Old",
      kind: "decision",
      projectIds: ["proj"],
    })
    const supersede = vi.fn(async () => undefined)
    const createWithDedup = vi.fn(async () => {
      throw new Error("notion 429 — fact create failed")
    })
    const decrementConfidence = vi.fn(async (_m: unknown) => 0.45)
    const recordCompared = vi.fn(async () => ({ wroteA: true, wroteB: true }))
    const { services } = makeServicesForCompare(a, b, {
      supersede,
      createWithDedup,
      decrementConfidence,
      recordCompared,
    })

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "supersedes",
      affectedMemoryId: "page-b",
      reason: "x",
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain("step=supersede")
    expect(text).toContain("affectedMemoryId=page-b")
    expect(text).toContain("supersedingMemoryId=page-a")
    expect(text).toContain("factId=(none)")
    expect(text).toContain("inconsistentState: true")
    expect(text).toMatch(/Retry the same/)
    // decisions.supersede ran; fact create failed; decrement and
    // audit marker never fired.
    expect(supersede).toHaveBeenCalledTimes(1)
    expect(createWithDedup).toHaveBeenCalledTimes(1)
    expect(decrementConfidence).not.toHaveBeenCalled()
    expect(recordCompared).not.toHaveBeenCalled()
  })

  it("retry after decision-superseded/fact-create-failed state completes fact and confidence work", async () => {
    const mockServer = createMockServer()
    const a = makeMemory("page-a", {
      title: "New",
      kind: "decision",
      projectIds: ["proj"],
    })
    const b = makeMemory("page-b", {
      title: "Old",
      kind: "decision",
      projectIds: ["proj"],
    })
    const supersede = vi.fn(async () => undefined)
    const createWithDedup = vi
      .fn()
      .mockRejectedValueOnce(new Error("notion 429 — fact create failed"))
      .mockResolvedValueOnce({ fact: { id: "fact-recovered" }, deduped: false })
    const decrementConfidence = vi.fn(async (_m: unknown) => 0.45)
    const recordCompared = vi.fn(async () => ({ wroteA: true, wroteB: true }))
    const { services } = makeServicesForCompare(a, b, {
      supersede,
      createWithDedup,
      decrementConfidence,
      recordCompared,
    })

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const first = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "supersedes",
      affectedMemoryId: "page-b",
      reason: "x",
    } as never)
    expect((first as { isError?: boolean }).isError).toBe(true)

    const second = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "supersedes",
      affectedMemoryId: "page-b",
      reason: "x",
    } as never)

    expect((second as { isError?: boolean }).isError).not.toBe(true)
    expect(supersede).toHaveBeenCalledTimes(2)
    expect(createWithDedup).toHaveBeenCalledTimes(2)
    expect(decrementConfidence).toHaveBeenCalledTimes(1)
    expect(recordCompared).toHaveBeenCalledTimes(1)
    const text = (second as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain("fact-recovered")
  })

  it("supersedes retry with landed decrement ledger skips the second confidence decrement", async () => {
    const ledger = buildCompareDispatchLedgerEntry({
      verdict: "supersedes",
      sourceMemoryId: "page-a",
      affectedMemoryId: "page-b",
    })
    const mockServer = createMockServer()
    const a = makeMemory("page-a", {
      title: "New",
      kind: "decision",
      projectIds: ["proj"],
    })
    const b = makeMemory("page-b", {
      title: "Old",
      kind: "decision",
      projectIds: ["proj"],
      compareNotes: appendCompareDispatchLedgerEntry("", ledger),
    })
    const supersede = vi.fn(async () => undefined)
    const createWithDedup = vi.fn(async () => ({
      fact: { id: "fact-existing" },
      deduped: true,
    }))
    const decrementConfidence = vi.fn(async (_m: unknown) => 0.45)
    const recordCompared = vi.fn(async () => ({ wroteA: true, wroteB: true }))
    const { services } = makeServicesForCompare(a, b, {
      supersede,
      createWithDedup,
      decrementConfidence,
      recordCompared,
    })

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "supersedes",
      affectedMemoryId: "page-b",
      reason: "retry after uncertain decrement response",
    } as never)

    expect((result as { isError?: boolean }).isError).not.toBe(true)
    expect(supersede).toHaveBeenCalledTimes(1)
    expect(createWithDedup).toHaveBeenCalledTimes(1)
    expect(decrementConfidence).not.toHaveBeenCalled()
    expect(recordCompared).toHaveBeenCalledTimes(1)
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain("confidence already halved")
  })

  it("symmetric verdict failure rethrows the underlying error WITHOUT InconsistentCompareStateError wrapping", async () => {
    // No destructive dispatch happened, so the operator can safely
    // retry the symmetric compare and the gate will be clear.
    const mockServer = createMockServer()
    const a = makeMemory("page-a", { title: "A", projectIds: ["proj"] })
    const b = makeMemory("page-b", { title: "B", projectIds: ["proj"] })
    const recordCompared = vi.fn(async () => {
      throw new Error("notion 429 — Compare Notes write failed")
    })
    const decrementConfidence = vi.fn(async (_m: unknown) => 0.45)
    const createWithDedup = vi.fn(async () => ({
      fact: { id: "fact-99" },
      deduped: false,
    }))
    const { services } = makeServicesForCompare(a, b, {
      recordCompared,
      decrementConfidence,
      createWithDedup,
    })

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "scoped",
      reason: "x",
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text
    // Plain underlying error message — not the structured
    // InconsistentCompareStateError. The agent retries, the gate
    // is still clear, the symmetric retry simply lands.
    expect(text).toContain("notion 429")
    expect(text).not.toContain("dispatch landed but recordCompared failed")
    // No destructive side effects on a symmetric verdict, so a
    // retry is safe.
    expect(decrementConfidence).not.toHaveBeenCalled()
    expect(createWithDedup).not.toHaveBeenCalled()
  })

  it("cross-project title collision is NOT suppressed: distinct pairs decrement independently", async () => {
    // Two project-scoped pairs with identical titles. The pair-scoped
    // Compare Notes gate must NOT suppress one decrement based on the
    // other's existing audit entry. This was the bug in the prior
    // findLiveByTriple-based design.
    const mockServer = createMockServer()
    const p1 = makeMemory("M_P1", { title: "Auth model", projectIds: ["P"] })
    const p2 = makeMemory("M_P2", { title: "Login flow", projectIds: ["P"] })
    const q1 = makeMemory("M_Q1", { title: "Auth model", projectIds: ["Q"] })
    const q2 = makeMemory("M_Q2", { title: "Login flow", projectIds: ["Q"] })

    const getById = vi.fn(async (id: string) => {
      const all = [p1, p2, q1, q2].find((m) => m.id === id)
      if (!all) throw new Error(`unknown ${id}`)
      return all
    })
    const decrementConfidence = vi.fn(async (_m: unknown) => 0.45)
    const recordCompared = vi.fn(async () => ({ wroteA: true, wroteB: true }))
    const createWithDedup = vi.fn(async () => ({
      fact: { id: "fact-x" },
      deduped: false,
    }))

    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: { getById, decrementConfidence, recordCompared },
      facts: { createWithDedup },
      context: { project: null },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    // First call against project-P pair.
    await compare({
      memoryIdA: "M_P1",
      memoryIdB: "M_P2",
      verdict: "conflicts_with",
      affectedMemoryId: "M_P2",
      reason: "x",
    } as never)
    // Second call against project-Q pair — different memories,
    // identical titles. Must NOT be suppressed.
    await compare({
      memoryIdA: "M_Q1",
      memoryIdB: "M_Q2",
      verdict: "conflicts_with",
      affectedMemoryId: "M_Q2",
      reason: "x",
    } as never)

    // Both pairs decrement.
    expect(decrementConfidence).toHaveBeenCalledTimes(2)
    const decrementedIds = decrementConfidence.mock.calls.map(
      (c) => (c[0] as { id: string }).id
    )
    expect(decrementedIds.sort()).toEqual(["M_P2", "M_Q2"])
  })

  it("Zod schema rejects an unknown verdict, reason >200 chars, and judgeConfidence outside 0..1", async () => {
    const mockServer = createMockServer()
    const a = makeMemory("page-a", { projectIds: ["proj"] })
    const b = makeMemory("page-b", { projectIds: ["proj"] })
    const { services } = makeServicesForCompare(a, b)

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const unknownVerdict = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "bogus",
      reason: "x",
    } as never)
    expect((unknownVerdict as { isError?: boolean }).isError).toBe(true)

    const longReason = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "scoped",
      reason: "x".repeat(201),
    } as never)
    expect((longReason as { isError?: boolean }).isError).toBe(true)

    const oobConfidence = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "conflicts_with",
      affectedMemoryId: "page-b",
      reason: "x",
      judgeConfidence: 1.5,
    } as never)
    expect((oobConfidence as { isError?: boolean }).isError).toBe(true)
  })

  it("symmetric one-sided recovery: already-written side at COMPARE_NOTES_MAX_CHARS does NOT block missing-side repair via preflight overflow", async () => {
    // Reviewer's [P2] regression: the prior preflight unconditionally
    // ran appendCompareNote on BOTH sides, so a near-cap A would
    // throw `Compare Notes overflow` even though `recordCompared`
    // would skip A and write only B. The corrected preflight mirrors
    // per-side idempotency: a side that already carries the entry
    // is NOT preflighted (it won't be written this call).
    //
    // Setup: A is a partial-success state where the prior call
    // landed A's audit AND A's notes are now packed to within one
    // entry of the cap by unrelated history. B's notes are empty —
    // B is the side to repair.
    const partialEntryOnA = JSON.stringify({
      verdict: "scoped",
      target: "page-b",
      affected: null,
      reason: "first call landed A but not B",
      judgedAt: "2026-04-29T00:00:00.000Z",
      promptVersion: "1",
    })
    // Pad A's notes with junk content placed BEFORE the partial
    // entry so the entry is still findable by hasMatchingCompareNote
    // at the end. Use newline-joined NDJSON-shaped lines so a
    // future split("\n") parser doesn't choke on the padding.
    const padLine = JSON.stringify({
      verdict: "compatible",
      target: "page-other",
      affected: null,
      reason: "p".repeat(100),
      judgedAt: "2025-01-01T00:00:00.000Z",
      promptVersion: "1",
    })
    const lines: string[] = []
    let totalLength = 0
    while (
      totalLength + padLine.length + 1 <
      COMPARE_NOTES_MAX_CHARS - partialEntryOnA.length - 1
    ) {
      lines.push(padLine)
      totalLength += padLine.length + 1
    }
    lines.push(partialEntryOnA)
    const nearCapANotes = lines.join("\n")
    expect(nearCapANotes.length).toBeLessThanOrEqual(COMPARE_NOTES_MAX_CHARS)
    // Confirm a fresh appendCompareNote against this near-cap notes
    // would actually overflow — pin the test's premise so the test
    // fails loudly if a future change to padding leaves slack.
    expect(nearCapANotes.length + padLine.length + 1).toBeGreaterThan(
      COMPARE_NOTES_MAX_CHARS
    )

    const a = makeMemory("page-a", {
      title: "A",
      projectIds: ["proj"],
      comparedWith: ["page-b"],
      compareNotes: nearCapANotes,
    })
    const b = makeMemory("page-b", {
      title: "B",
      projectIds: ["proj"],
      comparedWith: [],
      compareNotes: "",
    })

    const updates: Array<{ page_id: string; properties: Record<string, unknown> }> = []
    const mockClient = {
      pages: {
        update: vi.fn(
          async (args: { page_id: string; properties: Record<string, unknown> }) => {
            updates.push(args)
            return undefined
          }
        ),
      },
    } as never
    const { MemoryService } = await import("../../core/memory.js")
    const realMemories = new MemoryService(mockClient, {
      databaseId: "memories-db",
      dataSourceId: "memories-ds",
    })

    const mockServer = createMockServer()
    const services = {
      projects: { findByName: vi.fn() },
      topics: { findByName: vi.fn() },
      memories: {
        getById: vi.fn(async (id: string) => {
          if (id === "page-a") return a
          if (id === "page-b") return b
          throw new Error(`unknown id ${id}`)
        }),
        recordCompared: realMemories.recordCompared.bind(realMemories),
        decrementConfidence: vi.fn(),
      },
      facts: { createWithDedup: vi.fn() },
      decisions: { supersede: vi.fn() },
      context: { project: null },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "scoped",
      reason: "retry — A is at cap, B needs catching up",
    } as never)

    // The retry SUCCEEDS (no overflow error) because preflight
    // skipped A — the side that wouldn't have been written anyway.
    expect((result as { isError?: boolean }).isError).not.toBe(true)
    // Exactly ONE pages.update — for B. A is skipped by per-side
    // idempotency.
    expect(updates).toHaveLength(1)
    expect(updates[0]!.page_id).toBe("page-b")
    // Response surfaces the recovery so the operator can confirm.
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain("Audit recovery")
    expect(text).toContain("only side B")
  })

  it("preflight still fires on the missing side: a near-cap MISSING side correctly throws overflow before destructive dispatch", async () => {
    // Companion to the recovery test above — pins that the preflight's
    // safety guarantee is preserved. If the side that would actually
    // be written is near-cap, the overflow throw fires BEFORE any
    // destructive dispatch (decrement + fact emission) lands.
    //
    // Setup: B has no matching entry but its notes are packed so
    // close to the cap that appending the upcoming entry would push
    // past `COMPARE_NOTES_MAX_CHARS`. A fresh `conflicts_with` retry
    // MUST throw on the B preflight before `recordContradiction` runs.
    //
    // The upcoming entry the handler will compose has a
    // handler-generated `judgedAt` we can't predict, but every
    // `conflicts_with` entry from the same pair shares the same
    // verdict / target / affected / promptVersion / reason
    // structure, so the entry length is bounded by the predictable
    // shape. Use a generous cushion: pad B's notes to one character
    // under the cap so even the shortest entry overflows.
    const overCapBNotes = "a".repeat(COMPARE_NOTES_MAX_CHARS - 1)

    const a = makeMemory("page-a", { title: "A", projectIds: ["proj"] })
    const b = makeMemory("page-b", {
      title: "B",
      projectIds: ["proj"],
      compareNotes: overCapBNotes,
    })

    const decrementConfidence = vi.fn(async (_m: unknown) => 0.45)
    const recordCompared = vi.fn(async () => ({ wroteA: true, wroteB: true }))
    const createWithDedup = vi.fn(async () => ({
      fact: { id: "fact-x" },
      deduped: false,
    }))
    const { services } = makeServicesForCompare(a, b, {
      decrementConfidence,
      recordCompared,
      createWithDedup,
    })

    const mockServer = createMockServer()
    registerMemoryTools(mockServer.server, services as never)
    const compare = mockServer.getActionHandler("lore-memory", "compare")

    const result = await compare({
      memoryIdA: "page-a",
      memoryIdB: "page-b",
      verdict: "conflicts_with",
      affectedMemoryId: "page-b",
      reason: "x",
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect((result as { content: Array<{ text: string }> }).content[0]!.text).toContain(
      "Compare Notes overflow"
    )
    // No destructive dispatch fired — the preflight stopped it.
    expect(decrementConfidence).not.toHaveBeenCalled()
    expect(createWithDedup).not.toHaveBeenCalled()
    expect(recordCompared).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// DEFERRED-ATTRIBUTION (0.10.0): Author column attribution surfaces on save
//
// `services.identity.resolveAuthor()` lazily resolves the engineer-identity
// only when the caller omits `args.author`; an explicit `args.author` always
// wins and must not call the resolver.
// ---------------------------------------------------------------------------

describe("lore-memory action='save' — Author attribution (DEFERRED-ATTRIBUTION)", () => {
  function setUpSaveHarness(identityAuthor: string | null) {
    const mockServer = createMockServer()
    const created = makeMemory("mem-attrib", { projectIds: [] })
    const create = vi.fn().mockResolvedValue(created)
    const resolveAuthor = vi.fn(async () => identityAuthor)
    const services = {
      projects: { findByName: vi.fn() },
      topics: { getOrCreate: vi.fn() },
      memories: { create, list: vi.fn().mockResolvedValue({ items: [] }) },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: null, isCatchAllFallback: false },
      config: { projects: [] },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor, clearCache: vi.fn() },
    }
    registerMemoryTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    return {
      handler: mockServer.getActionHandler("lore-memory", "save"),
      create,
      resolveAuthor,
    }
  }

  it("stamps services.identity.resolveAuthor on memories.create when args.author is omitted", async () => {
    const { handler, create } = setUpSaveHarness("Hesham Salman")
    await handler({ title: "Saved", content: "body" } as never)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ author: "Hesham Salman" })
    )
  })

  it("explicit args.author wins without calling services.identity.resolveAuthor", async () => {
    const { handler, create, resolveAuthor } = setUpSaveHarness("ServerSideName")
    await handler({
      title: "Saved",
      content: "body",
      author: "Override",
    } as never)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ author: "Override" }))
    expect(resolveAuthor).not.toHaveBeenCalled()
  })

  it("collapses to author: undefined when args.author is omitted AND identity is null", async () => {
    // The buildMemoryProps truthy gate skips the Author write when
    // input.author is undefined; column stays empty rather than
    // stamping a placeholder. Pinning `undefined` rather than `null`
    // is load-bearing — the create payload travels through
    // decodeMemoryTextFields where `null` and `undefined` follow
    // different branches.
    const { handler, create } = setUpSaveHarness(null)
    await handler({ title: "Saved", content: "body" } as never)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ author: undefined }))
  })
})
