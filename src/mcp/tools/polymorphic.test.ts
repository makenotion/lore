/**
 * Polymorphic dispatcher tests for the seven `lore-*` tools introduced
 * in P3-01 (`lore-context`, `lore-memory`, `lore-query`, `lore-fact`,
 * `lore-decision`, `lore-journal`, `lore-project`).
 *
 * These tests verify the new contract:
 * 1. Each polymorphic tool is registered.
 * 2. Each declared `action` value reaches the right underlying handler.
 * 3. Invalid `action` values produce a clean discriminated-union error.
 * 4. Missing required-per-action params produce a clean error.
 * 5. The old single-purpose tool names remain registered (deprecation
 *    aliases per the stability rule) and exhibit unchanged behavior.
 *
 * Per-handler behavior is exercised by the existing per-file test suites
 * (`memory.test.ts`, `decisions.test.ts`, `knowledge.test.ts`,
 * `context.test.ts`). This file specifically covers the dispatcher.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describe, expect, it, vi } from "vitest"
import { registerContextTools } from "./context.js"
import { registerMemoryTools } from "./memory.js"
import { registerQueryTools } from "./query.js"
import { registerKnowledgeTools } from "./knowledge.js"
import { registerDecisionTools } from "./decisions.js"
import { registerJournalTools } from "./journal.js"
import { registerProjectTools } from "./project.js"

type Handler = (...args: never[]) => Promise<unknown>

type ToolConfig = {
  description?: string
  inputSchema?: Record<string, unknown>
  [key: string]: unknown
}

function createMockServer() {
  const handlers = new Map<string, Handler>()
  const configs = new Map<string, ToolConfig>()
  const server = {
    registerTool: vi.fn((name: string, config: ToolConfig, handler: Handler) => {
      handlers.set(name, handler)
      configs.set(name, config)
    }),
  } as unknown as McpServer
  return {
    server,
    has(name: string): boolean {
      return handlers.has(name)
    },
    get(name: string): Handler {
      const handler = handlers.get(name)
      if (!handler) throw new Error(`missing handler ${name}`)
      return handler
    },
    description(name: string): string {
      return configs.get(name)?.description ?? ""
    },
    config(name: string): ToolConfig {
      const cfg = configs.get(name)
      if (!cfg) throw new Error(`missing config for ${name}`)
      return cfg
    },
    /**
     * Render the registered config to a deterministic string suitable for
     * size measurement. Walks each parameter's Zod schema and pulls out
     * just the fields agents actually see in the JSON-Schema rendering
     * (`type`, `description`, enum/values, optionality). A naive
     * `JSON.stringify(config)` would emit deep Zod internals (`_def`,
     * `~standard`, etc.) that aren't part of the agent-visible surface
     * and would inflate the count by ~10×.
     */
    renderedSize(name: string): number {
      return renderConfigForSize(this.config(name)).length
    },
    names(): string[] {
      return Array.from(handlers.keys())
    },
  }
}

/**
 * Approximate the agent-visible MCP tool config as a single string. Title
 * + description verbatim + a flat `param: description` line per inputSchema
 * field. This omits Zod internals that the SDK strips before sending to
 * the client and undercounts JSON-Schema overhead like `"type":"string"`
 * — but the relative size between tools is what the budget tests guard
 * against, and that ordering is preserved.
 */
function renderConfigForSize(config: ToolConfig): string {
  const lines: string[] = []
  if (typeof config["title"] === "string") lines.push(`title: ${config["title"]}`)
  if (config.description) lines.push(`description: ${config.description}`)
  if (config.inputSchema && typeof config.inputSchema === "object") {
    for (const [key, schema] of Object.entries(config.inputSchema)) {
      const desc = describeOf(schema)
      lines.push(desc ? `${key}: ${desc}` : key)
    }
  }
  return lines.join("\n")
}

function describeOf(schema: unknown): string {
  if (!schema || typeof schema !== "object") return ""
  // Zod v3 stashes the .describe() string at `_def.description`. Walk
  // down through wrappers (.optional() etc.) until we find one or run
  // out of layers.
  let cursor: unknown = schema
  for (let i = 0; i < 6; i++) {
    if (!cursor || typeof cursor !== "object") return ""
    const def = (cursor as { _def?: { description?: string; innerType?: unknown } })._def
    if (def?.description) return def.description
    if (def?.innerType) cursor = def.innerType
    else return ""
  }
  return ""
}

function extractText(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0].text
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true
}

// -------------------------------------------------------------------------
// Stub services. Each tool only touches a few service methods. Only stub
// what each test needs; otherwise leave methods unimplemented to assert
// dispatch hits the right path.
// -------------------------------------------------------------------------

interface StubOpts {
  vaultStats?: () => Promise<unknown>
  projectsList?: ReturnType<typeof vi.fn>
  projectsFindByName?: ReturnType<typeof vi.fn>
  memoriesList?: ReturnType<typeof vi.fn>
  memoriesGetById?: ReturnType<typeof vi.fn>
  memoriesArchive?: ReturnType<typeof vi.fn>
  memoriesUpdate?: ReturnType<typeof vi.fn>
  memoriesCreate?: ReturnType<typeof vi.fn>
  memoriesSearch?: ReturnType<typeof vi.fn>
  factsCreate?: ReturnType<typeof vi.fn>
  factsCreateWithDedup?: ReturnType<typeof vi.fn>
  factsInvalidate?: ReturnType<typeof vi.fn>
  factsExtendReview?: ReturnType<typeof vi.fn>
  decisionsCreate?: ReturnType<typeof vi.fn>
  decisionsList?: ReturnType<typeof vi.fn>
  decisionsGetById?: ReturnType<typeof vi.fn>
  decisionsSupersede?: ReturnType<typeof vi.fn>
  decisionsReviewCompleted?: ReturnType<typeof vi.fn>
}

function makeServices(opts: StubOpts = {}): unknown {
  return {
    config: { projects: [] },
    context: { project: null, vault: { pageId: "v1" } },
    vault: {
      pageId: "v1",
      stats: opts.vaultStats ?? vi.fn(async () => ({ projects: 0, topics: 0, memories: 0, facts: 0 })),
    },
    projects: {
      list: opts.projectsList ?? vi.fn(async () => []),
      findByName: opts.projectsFindByName ?? vi.fn(async () => null),
    },
    topics: { findByName: vi.fn(), getOrCreate: vi.fn(), listByProject: vi.fn(async () => []) },
    memories: {
      list: opts.memoriesList ?? vi.fn(async () => ({ items: [], nextCursor: undefined })),
      getById: opts.memoriesGetById ?? vi.fn(),
      archive: opts.memoriesArchive ?? vi.fn(async () => undefined),
      update: opts.memoriesUpdate ?? vi.fn(),
      create: opts.memoriesCreate ?? vi.fn(),
      search: opts.memoriesSearch ?? vi.fn(async () => []),
      getTitleById: vi.fn(),
    },
    facts: {
      create: opts.factsCreate ?? vi.fn(async () => ({})),
      createWithDedup:
        opts.factsCreateWithDedup ??
        vi.fn(async () => ({
          fact: {
            id: "f1",
            subject: "S",
            predicate: "uses",
            object: "O",
            confidence: "certain",
            reviewBy: null,
          },
          deduped: false,
          enriched: [],
        })),
      invalidate: opts.factsInvalidate ?? vi.fn(async () => undefined),
      extendReview: opts.factsExtendReview ?? vi.fn(async () => undefined),
      listTracking: vi.fn(async () => ({ items: [], hasMore: false })),
      queryByEntity: vi.fn(async () => []),
      queryBySubject: vi.fn(async () => []),
      queryOverdue: vi.fn(async () => []),
    },
    decisions: {
      create: opts.decisionsCreate ?? vi.fn(),
      list: opts.decisionsList ?? vi.fn(async () => ({ items: [], nextCursor: undefined })),
      getById: opts.decisionsGetById ?? vi.fn(),
      supersede: opts.decisionsSupersede ?? vi.fn(async () => undefined),
      reviewCompleted: opts.decisionsReviewCompleted ?? vi.fn(async () => undefined),
      queryOverdue: vi.fn(async () => []),
    },
    sessionMemories: { record: vi.fn(), get: vi.fn(() => null) },
  }
}

// -------------------------------------------------------------------------
// lore-project
// -------------------------------------------------------------------------

describe("lore-project polymorphic dispatcher", () => {
  it("registers the polymorphic tool plus both deprecated aliases", () => {
    const mock = createMockServer()
    registerProjectTools(mock.server, makeServices() as never)
    expect(mock.has("lore-project")).toBe(true)
    expect(mock.has("lore-list-projects")).toBe(true)
    expect(mock.has("lore-get-project")).toBe(true)
    // Deprecation pointer is in each old alias's description.
    expect(mock.description("lore-list-projects").toLowerCase()).toContain("deprecated")
    expect(mock.description("lore-get-project").toLowerCase()).toContain("deprecated")
  })

  it("dispatches action='list' to the list handler", async () => {
    const projectsList = vi.fn(async () => [
      { id: "p1", name: "Mail", path: "mail", type: "codebase", status: "active", description: "" },
    ])
    const mock = createMockServer()
    registerProjectTools(mock.server, makeServices({ projectsList }) as never)
    const result = await mock.get("lore-project")({ action: "list" } as never)
    expect(projectsList).toHaveBeenCalled()
    expect(extractText(result)).toContain("Mail")
  })

  it("dispatches action='get' to the get handler", async () => {
    const projectsFindByName = vi.fn(async () => ({
      id: "p1",
      name: "Mail",
      path: "mail",
      type: "codebase",
      status: "active",
      description: "Mail backend",
    }))
    const mock = createMockServer()
    registerProjectTools(
      mock.server,
      makeServices({ projectsFindByName }) as never,
    )
    const result = await mock.get("lore-project")({
      action: "get",
      name: "Mail",
    } as never)
    expect(projectsFindByName).toHaveBeenCalledWith("Mail")
    expect(extractText(result)).toContain("# Mail")
  })

  it("rejects an invalid action with a discriminator error", async () => {
    const mock = createMockServer()
    registerProjectTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-project")({ action: "explode" } as never)
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("lore-project")
    expect(extractText(result)).toContain("action")
  })

  it("rejects action='get' without `name`", async () => {
    const mock = createMockServer()
    registerProjectTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-project")({ action: "get" } as never)
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("lore-project")
  })
})

// -------------------------------------------------------------------------
// lore-memory
// -------------------------------------------------------------------------

describe("lore-memory polymorphic dispatcher", () => {
  it("registers the polymorphic tool plus deprecated aliases", () => {
    const mock = createMockServer()
    registerMemoryTools(mock.server, makeServices() as never)
    expect(mock.has("lore-memory")).toBe(true)
    for (const alias of [
      "lore-remember",
      "lore-update",
      "lore-forget",
      "lore-expand",
      "lore-recall",
      "lore-search",
    ]) {
      expect(mock.has(alias)).toBe(true)
      expect(mock.description(alias).toLowerCase()).toContain("deprecated")
    }
  })

  it("dispatches action='archive' to the archive handler", async () => {
    const memoriesArchive = vi.fn(async () => undefined)
    const mock = createMockServer()
    registerMemoryTools(mock.server, makeServices({ memoriesArchive }) as never)
    const result = await mock.get("lore-memory")({
      action: "archive",
      memoryId: "mem-123",
    } as never)
    expect(memoriesArchive).toHaveBeenCalledWith("mem-123")
    expect(extractText(result)).toContain("Archived memory mem-123")
  })

  it("dispatches action='expand' and dedupes repeated IDs", async () => {
    const memoriesGetById = vi.fn(async (id: string) => ({
      id,
      title: `Body ${id}`,
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
      content: "Hello",
      createdAt: "2026-04-20T00:00:00Z",
      updatedAt: "2026-04-20T00:00:00Z",
    }))
    const mock = createMockServer()
    registerMemoryTools(mock.server, makeServices({ memoriesGetById }) as never)
    const id = "11111111-1111-1111-1111-111111111111"
    const result = await mock.get("lore-memory")({
      action: "expand",
      ids: [id, id],
    } as never)
    expect(memoriesGetById).toHaveBeenCalledTimes(1)
    expect(extractText(result)).toContain(`Body ${id}`)
  })

  it("rejects archive without memoryId via discriminated union", async () => {
    const mock = createMockServer()
    registerMemoryTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-memory")({ action: "archive" } as never)
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("lore-memory")
  })

  it("dispatches action='save' to the same handler as legacy lore-remember", async () => {
    const memoriesCreate = vi.fn(async () => ({
      id: "m1",
      title: "T",
      projectIds: [],
      content: "C",
    }))
    const mock = createMockServer()
    registerMemoryTools(mock.server, makeServices({ memoriesCreate }) as never)
    await mock.get("lore-memory")({
      action: "save",
      title: "T",
      content: "C",
    } as never)
    expect(memoriesCreate).toHaveBeenCalled()
  })
})

// -------------------------------------------------------------------------
// lore-query
// -------------------------------------------------------------------------

describe("lore-query polymorphic dispatcher", () => {
  it("registers lore-query", () => {
    const mock = createMockServer()
    registerQueryTools(mock.server, makeServices() as never)
    expect(mock.has("lore-query")).toBe(true)
  })

  it("dispatches action='recall' to memories.list", async () => {
    const memoriesList = vi.fn(async () => ({ items: [], nextCursor: undefined }))
    const mock = createMockServer()
    registerQueryTools(mock.server, makeServices({ memoriesList }) as never)
    await mock.get("lore-query")({ action: "recall" } as never)
    expect(memoriesList).toHaveBeenCalled()
  })

  it("dispatches action='search' with required query", async () => {
    const memoriesSearch = vi.fn(async () => [])
    const mock = createMockServer()
    registerQueryTools(mock.server, makeServices({ memoriesSearch }) as never)
    await mock.get("lore-query")({ action: "search", query: "auth" } as never)
    expect(memoriesSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: "auth" }),
    )
  })

  it("rejects action='search' without query", async () => {
    const mock = createMockServer()
    registerQueryTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-query")({ action: "search" } as never)
    expect(isError(result)).toBe(true)
  })

  it("rejects action='ask' without entity", async () => {
    const mock = createMockServer()
    registerQueryTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-query")({ action: "ask" } as never)
    expect(isError(result)).toBe(true)
  })

  it("rejects unknown action", async () => {
    const mock = createMockServer()
    registerQueryTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-query")({ action: "summarize" } as never)
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("lore-query")
  })
})

// -------------------------------------------------------------------------
// lore-fact
// -------------------------------------------------------------------------

describe("lore-fact polymorphic dispatcher", () => {
  it("registers lore-fact plus deprecated learn/correct/extend aliases", () => {
    const mock = createMockServer()
    registerKnowledgeTools(mock.server, makeServices() as never)
    expect(mock.has("lore-fact")).toBe(true)
    for (const alias of ["lore-learn", "lore-correct", "lore-extend"]) {
      expect(mock.has(alias)).toBe(true)
      expect(mock.description(alias).toLowerCase()).toContain("deprecated")
    }
  })

  it("dispatches action='invalidate' to facts.invalidate", async () => {
    const factsInvalidate = vi.fn(async () => undefined)
    const mock = createMockServer()
    registerKnowledgeTools(mock.server, makeServices({ factsInvalidate }) as never)
    const result = await mock.get("lore-fact")({
      action: "invalidate",
      factId: "f-7",
    } as never)
    expect(factsInvalidate).toHaveBeenCalledWith("f-7")
    expect(extractText(result)).toContain("f-7")
  })

  it("dispatches action='extend' with reviewBy", async () => {
    const factsExtendReview = vi.fn(async () => undefined)
    const mock = createMockServer()
    registerKnowledgeTools(
      mock.server,
      makeServices({ factsExtendReview }) as never,
    )
    await mock.get("lore-fact")({
      action: "extend",
      factId: "f-7",
      reviewBy: "2026-12-31",
    } as never)
    expect(factsExtendReview).toHaveBeenCalledWith("f-7", "2026-12-31")
  })

  it("rejects action='extend' without reviewBy", async () => {
    const mock = createMockServer()
    registerKnowledgeTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-fact")({
      action: "extend",
      factId: "f-7",
    } as never)
    expect(isError(result)).toBe(true)
  })

  it("dispatches action='create' to facts.createWithDedup", async () => {
    const factsCreateWithDedup = vi.fn(async () => ({
      fact: {
        id: "f1",
        subject: "Auth",
        predicate: "uses",
        object: "JWT",
        confidence: "certain",
        reviewBy: null,
      },
      deduped: false,
      enriched: [],
    }))
    const mock = createMockServer()
    registerKnowledgeTools(
      mock.server,
      makeServices({ factsCreateWithDedup }) as never,
    )
    await mock.get("lore-fact")({
      action: "create",
      subject: "Auth",
      predicate: "uses",
      object: "JWT",
    } as never)
    expect(factsCreateWithDedup).toHaveBeenCalled()
  })
})

// -------------------------------------------------------------------------
// lore-decision
// -------------------------------------------------------------------------

describe("lore-decision polymorphic dispatcher", () => {
  it("registers lore-decision plus all six deprecated aliases", () => {
    const mock = createMockServer()
    registerDecisionTools(mock.server, makeServices() as never)
    expect(mock.has("lore-decision")).toBe(true)
    for (const alias of [
      "lore-decide",
      "lore-list-decisions",
      "lore-get-decision",
      "lore-decision-context",
      "lore-supersede",
      "lore-review-decision",
    ]) {
      expect(mock.has(alias)).toBe(true)
      expect(mock.description(alias).toLowerCase()).toContain("deprecated")
    }
  })

  it("dispatches action='supersede' atomically", async () => {
    const decisionsGetById = vi.fn(async (id: string) => ({
      id,
      title: `Decision ${id}`,
      status: "accepted",
      confidence: "certain",
      projectIds: [],
      content: "",
      decidedAt: "2026-01-01",
      reviewBy: null,
      supersedesIds: [],
      affectsIds: [],
      alternatives: "",
      consequences: "",
      tags: [],
      keywords: "",
      author: "",
      agent: "",
      session: "",
      kind: "decision",
      topicId: null,
      source: "manual",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }))
    const decisionsSupersede = vi.fn(async () => undefined)
    const factsCreate = vi.fn(async () => ({}))
    const services = makeServices({
      decisionsGetById,
      decisionsSupersede,
    }) as Record<string, unknown> & { facts: Record<string, unknown> }
    // syncDecisionReachability touches several fact-graph reads; stub
    // them as no-ops so the supersede dispatcher round-trips without
    // exploding on missing methods.
    services.facts = {
      ...services.facts,
      create: factsCreate,
      queryBySubject: vi.fn(async () => []),
      queryBySourceMemory: vi.fn(async () => []),
      invalidate: vi.fn(async () => undefined),
      setSource: vi.fn(async () => undefined),
    }
    const mock = createMockServer()
    registerDecisionTools(mock.server, services as never)
    const result = await mock.get("lore-decision")({
      action: "supersede",
      newDecisionId: "new-1",
      oldDecisionId: "old-1",
    } as never)
    expect(decisionsSupersede).toHaveBeenCalledWith("new-1", "old-1")
    expect(factsCreate).toHaveBeenCalled()
    expect(extractText(result)).toContain("Superseded")
  })

  it("dispatches action='review' with default +90 days", async () => {
    const decisionsReviewCompleted = vi.fn(async () => undefined)
    const mock = createMockServer()
    registerDecisionTools(
      mock.server,
      makeServices({ decisionsReviewCompleted }) as never,
    )
    const result = await mock.get("lore-decision")({
      action: "review",
      decisionId: "d-1",
    } as never)
    expect(decisionsReviewCompleted).toHaveBeenCalledWith(
      "d-1",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    )
    expect(extractText(result)).toContain("d-1")
  })

  it("rejects action='supersede' without ids", async () => {
    const mock = createMockServer()
    registerDecisionTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-decision")({ action: "supersede" } as never)
    expect(isError(result)).toBe(true)
  })
})

// -------------------------------------------------------------------------
// lore-context
// -------------------------------------------------------------------------

describe("lore-context polymorphic dispatcher", () => {
  it("registers lore-context plus deprecated status/wake-up/digest aliases", () => {
    const mock = createMockServer()
    registerContextTools(mock.server, makeServices() as never)
    expect(mock.has("lore-context")).toBe(true)
    for (const alias of ["lore-status", "lore-wake-up", "lore-digest"]) {
      expect(mock.has(alias)).toBe(true)
      expect(mock.description(alias).toLowerCase()).toContain("deprecated")
    }
  })

  it("dispatches action='status' to vault.stats", async () => {
    const vaultStats = vi.fn(async () => ({
      projects: 1,
      topics: 2,
      memories: 3,
      facts: 4,
    }))
    const mock = createMockServer()
    registerContextTools(mock.server, makeServices({ vaultStats }) as never)
    const result = await mock.get("lore-context")({ action: "status" } as never)
    expect(vaultStats).toHaveBeenCalled()
    expect(extractText(result)).toContain("Memories: 3")
  })

  it("rejects unknown action", async () => {
    const mock = createMockServer()
    registerContextTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-context")({ action: "wake" } as never)
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("lore-context")
  })
})

// -------------------------------------------------------------------------
// lore-journal
// -------------------------------------------------------------------------

describe("lore-journal polymorphic dispatcher", () => {
  it("registers lore-journal and the read-journal alias", () => {
    const mock = createMockServer()
    registerJournalTools(mock.server, makeServices() as never)
    expect(mock.has("lore-journal")).toBe(true)
    expect(mock.has("lore-read-journal")).toBe(true)
    expect(mock.description("lore-read-journal").toLowerCase()).toContain("deprecated")
  })

  it("defaults missing action to 'write' AND emits the once-per-process deprecation notice on stderr", async () => {
    // The wrap-up consequence of preserving the legacy write call shape
    // is that callers get no signal to migrate. The dispatcher writes a
    // one-shot deprecation notice to stderr so a human operator running
    // the MCP process sees it. The notice flag is module-scoped, so this
    // test must be the FIRST write triggered against `journal.ts` in
    // this file — co-locating the legacy-call-shape assertion with the
    // stderr assertion guarantees that ordering and prevents either
    // surface from regressing without the other being noticed.
    const memoriesCreate = vi.fn(async () => ({
      id: "j1",
      title: "J",
      projectIds: [],
    }))
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)
    try {
      const mock = createMockServer()
      registerJournalTools(
        mock.server,
        makeServices({ memoriesCreate }) as never,
      )
      // Legacy call shape — no `action` field, just title + content.
      const result = await mock.get("lore-journal")({
        title: "J",
        content: "Body",
      } as never)
      expect(memoriesCreate).toHaveBeenCalled()
      expect(extractText(result)).toContain("Journal entry saved")
      const wrote = stderrSpy.mock.calls.flat().join("")
      expect(wrote).toContain("lore-journal is deprecated")
      // Notice points at the polymorphic surface, not the legacy aliases.
      expect(wrote).toContain("lore-memory")
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it("dispatches action='read' to memories.list with source='agent_diary'", async () => {
    const memoriesList = vi.fn(async () => ({ items: [], nextCursor: undefined }))
    const mock = createMockServer()
    registerJournalTools(
      mock.server,
      makeServices({ memoriesList }) as never,
    )
    await mock.get("lore-journal")({ action: "read" } as never)
    expect(memoriesList).toHaveBeenCalledWith(
      expect.objectContaining({ source: "agent_diary" }),
    )
  })
})

// -------------------------------------------------------------------------
// Tool surface count — the P3-01 acceptance criterion
// -------------------------------------------------------------------------

describe("P3-01 tool surface", () => {
  it("registers 7 polymorphic tools (~8 per the plan) and 17 deprecated aliases", () => {
    const mock = createMockServer()
    const services = makeServices() as never
    registerContextTools(mock.server, services)
    registerMemoryTools(mock.server, services)
    registerQueryTools(mock.server, services)
    registerKnowledgeTools(mock.server, services)
    registerDecisionTools(mock.server, services)
    registerJournalTools(mock.server, services)
    registerProjectTools(mock.server, services)

    const allNames = mock.names()

    // The seven new polymorphic tools.
    const polymorphic = [
      "lore-context",
      "lore-memory",
      "lore-query",
      "lore-fact",
      "lore-decision",
      "lore-journal",
      "lore-project",
    ]
    for (const name of polymorphic) {
      expect(allNames).toContain(name)
    }
    expect(polymorphic.length).toBe(7)

    // The legacy aliases that must still be reachable per the stability
    // rule. Note `lore-journal` is BOTH the new polymorphic name AND the
    // legacy write-only name; it is counted once under the polymorphic set
    // (the `action: 'write'` default preserves the legacy call shape).
    const legacyAliases = [
      "lore-status",
      "lore-wake-up",
      "lore-digest",
      "lore-remember",
      "lore-update",
      "lore-forget",
      "lore-expand",
      "lore-recall",
      "lore-search",
      "lore-learn",
      "lore-correct",
      "lore-extend",
      "lore-ask",
      "lore-open-loops",
      "lore-audit",
      "lore-decide",
      "lore-list-decisions",
      "lore-get-decision",
      "lore-decision-context",
      "lore-supersede",
      "lore-review-decision",
      "lore-read-journal",
      "lore-list-projects",
      "lore-get-project",
    ]
    for (const name of legacyAliases) {
      expect(allNames).toContain(name)
    }

    // No overlap of polymorphic names and legacy aliases except `lore-journal`
    // which is both the new dispatcher and the legacy write-only name.
    const polymorphicSet = new Set(polymorphic)
    for (const alias of legacyAliases) {
      expect(polymorphicSet.has(alias)).toBe(false)
    }
  })

  it("legacy aliases share descriptions short enough to measurably reduce per-session prompt overhead", () => {
    const mock = createMockServer()
    const services = makeServices() as never
    registerContextTools(mock.server, services)
    registerMemoryTools(mock.server, services)
    registerQueryTools(mock.server, services)
    registerKnowledgeTools(mock.server, services)
    registerDecisionTools(mock.server, services)
    registerJournalTools(mock.server, services)
    registerProjectTools(mock.server, services)

    // Every legacy alias's description must be a one-liner deprecation
    // pointer. We assert a tight upper bound so a future PR cannot
    // silently re-inflate them.
    const legacyAliases = [
      "lore-status",
      "lore-wake-up",
      "lore-digest",
      "lore-remember",
      "lore-update",
      "lore-forget",
      "lore-expand",
      "lore-recall",
      "lore-search",
      "lore-learn",
      "lore-correct",
      "lore-extend",
      "lore-ask",
      "lore-open-loops",
      "lore-audit",
      "lore-decide",
      "lore-list-decisions",
      "lore-get-decision",
      "lore-decision-context",
      "lore-supersede",
      "lore-review-decision",
      "lore-read-journal",
      "lore-list-projects",
      "lore-get-project",
    ]
    const SHORT_DESCRIPTION_LIMIT = 120
    for (const alias of legacyAliases) {
      const desc = mock.description(alias)
      expect(desc.length).toBeLessThanOrEqual(SHORT_DESCRIPTION_LIMIT)
      expect(desc.toLowerCase()).toContain("deprecated")
    }
  })

  // -----------------------------------------------------------------------
  // Polymorphic-tool prompt-economy budgets.
  //
  // The phase's stated goal is "lower prompt tax for AI agents." The
  // legacy-alias bound above guards the deprecated 24-tool half. These
  // tests guard the polymorphic seven, which are the surface that
  // actually sticks around. Without a ceiling, a future PR could quietly
  // append an action's worth of bullets to a description and inflate
  // every reconnecting session's prompt.
  //
  // Numbers are tuned to current usage with comfortable headroom:
  // ~25% above what's currently registered, so a real new action can
  // land but a lazy dump cannot.
  // -----------------------------------------------------------------------

  it("each polymorphic tool's description stays within budget", () => {
    const mock = createMockServer()
    const services = makeServices() as never
    registerContextTools(mock.server, services)
    registerMemoryTools(mock.server, services)
    registerQueryTools(mock.server, services)
    registerKnowledgeTools(mock.server, services)
    registerDecisionTools(mock.server, services)
    registerJournalTools(mock.server, services)
    registerProjectTools(mock.server, services)

    // Per-tool description ceiling. Generous to current values — a real
    // new action can land within this budget. The intent is to catch
    // a paragraph-of-narration regression, not to police phrasing.
    const PER_TOOL_DESCRIPTION_LIMIT = 1100
    const polymorphic = [
      "lore-context",
      "lore-memory",
      "lore-query",
      "lore-fact",
      "lore-decision",
      "lore-journal",
      "lore-project",
    ]
    for (const name of polymorphic) {
      const desc = mock.description(name)
      expect(
        desc.length,
        `${name} description (${desc.length} chars) exceeds the ${PER_TOOL_DESCRIPTION_LIMIT}-char per-tool budget`,
      ).toBeLessThanOrEqual(PER_TOOL_DESCRIPTION_LIMIT)
    }
  })

  it("the seven polymorphic tools' descriptions sum stays within the combined budget", () => {
    const mock = createMockServer()
    const services = makeServices() as never
    registerContextTools(mock.server, services)
    registerMemoryTools(mock.server, services)
    registerQueryTools(mock.server, services)
    registerKnowledgeTools(mock.server, services)
    registerDecisionTools(mock.server, services)
    registerJournalTools(mock.server, services)
    registerProjectTools(mock.server, services)

    // Combined ceiling. Polymorphic descriptions currently total ~4600
    // chars; this gives ~25% headroom while still preventing a
    // surface-doubling regression.
    const TOTAL_POLYMORPHIC_DESCRIPTION_LIMIT = 6000
    const polymorphic = [
      "lore-context",
      "lore-memory",
      "lore-query",
      "lore-fact",
      "lore-decision",
      "lore-journal",
      "lore-project",
    ]
    const total = polymorphic.reduce(
      (sum, name) => sum + mock.description(name).length,
      0,
    )
    expect(
      total,
      `combined polymorphic description size (${total} chars) exceeds the ${TOTAL_POLYMORPHIC_DESCRIPTION_LIMIT}-char budget`,
    ).toBeLessThanOrEqual(TOTAL_POLYMORPHIC_DESCRIPTION_LIMIT)
  })

  it("each polymorphic tool's full registered config (description + inputSchema field descriptions) stays within budget", () => {
    // Description char-count alone misses the inputSchema parameter
    // descriptions, which agents also see. A polymorphic tool with 20
    // optional fields each carrying a chunky `(action='X') ...`
    // description is the second leak vector. This test bounds the
    // rendered config string per tool.
    const mock = createMockServer()
    const services = makeServices() as never
    registerContextTools(mock.server, services)
    registerMemoryTools(mock.server, services)
    registerQueryTools(mock.server, services)
    registerKnowledgeTools(mock.server, services)
    registerDecisionTools(mock.server, services)
    registerJournalTools(mock.server, services)
    registerProjectTools(mock.server, services)

    // Per-tool full-config ceiling. Currently `lore-decision` is the
    // largest at ~3500 chars rendered; budget is set at 5000 to keep
    // ~40% headroom for a future action without inviting a paragraph
    // of unstructured commentary in any param description.
    const PER_TOOL_CONFIG_LIMIT = 5000
    const polymorphic = [
      "lore-context",
      "lore-memory",
      "lore-query",
      "lore-fact",
      "lore-decision",
      "lore-journal",
      "lore-project",
    ]
    for (const name of polymorphic) {
      const size = mock.renderedSize(name)
      expect(
        size,
        `${name} rendered config size (${size} chars) exceeds the ${PER_TOOL_CONFIG_LIMIT}-char per-tool budget`,
      ).toBeLessThanOrEqual(PER_TOOL_CONFIG_LIMIT)
    }
  })
})
