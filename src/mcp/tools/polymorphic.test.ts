/**
 * Polymorphic dispatcher tests for the seven `lore-*` tools — six
 * introduced in P3-01 (`lore-context`, `lore-memory`, `lore-query`,
 * `lore-fact`, `lore-decision`, `lore-project`) plus `lore-task` added
 * in PF3-06 to subsume the standalone task tools landed by P3-02.
 * `lore-journal` was removed in the 0.6.0 deprecation purge alongside
 * the single-purpose aliases.
 *
 * These tests verify the contract:
 * 1. Each polymorphic tool is registered.
 * 2. Each declared `action` value reaches the right underlying handler.
 * 3. Invalid `action` values produce a clean discriminated-union error.
 * 4. Missing required-per-action params produce a clean error.
 * 5. The MCP tool surface is exactly the 7 polymorphic dispatchers — no
 *    deprecated aliases remain after the 0.6.0 deprecation purge.
 *
 * Per-handler behavior is exercised by the existing per-file test suites
 * (`memory.test.ts`, `decisions.test.ts`, `knowledge.test.ts`,
 * `context.test.ts`, `tasks.test.ts`). This file specifically covers
 * the dispatcher.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describe, expect, it, vi } from "vitest"
import { registerContextTools } from "./context.js"
import { registerMemoryTools } from "./memory.js"
import { queryDispatchSchema, registerQueryTools } from "./query.js"
import { registerKnowledgeTools } from "./knowledge.js"
import { registerDecisionTools } from "./decisions.js"
import { registerProjectTools } from "./project.js"
import { registerTaskTools } from "./tasks.js"

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
  memoriesSearchWithExplain?: ReturnType<typeof vi.fn>
  factsCreate?: ReturnType<typeof vi.fn>
  factsCreateWithDedup?: ReturnType<typeof vi.fn>
  factsInvalidate?: ReturnType<typeof vi.fn>
  factsExtendReview?: ReturnType<typeof vi.fn>
  decisionsCreate?: ReturnType<typeof vi.fn>
  decisionsList?: ReturnType<typeof vi.fn>
  decisionsGetById?: ReturnType<typeof vi.fn>
  decisionsSupersede?: ReturnType<typeof vi.fn>
  decisionsReviewCompleted?: ReturnType<typeof vi.fn>
  tasksCreate?: ReturnType<typeof vi.fn>
  tasksUpdate?: ReturnType<typeof vi.fn>
  tasksClose?: ReturnType<typeof vi.fn>
  tasksList?: ReturnType<typeof vi.fn>
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
      searchWithExplain:
        opts.memoriesSearchWithExplain ??
        vi.fn(async () => ({ memories: [], explain: [] })),
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
    tasks: {
      create: opts.tasksCreate ?? vi.fn(),
      update: opts.tasksUpdate ?? vi.fn(),
      close: opts.tasksClose ?? vi.fn(async () => undefined),
      list: opts.tasksList ?? vi.fn(async () => ({ items: [] })),
      countActive: vi.fn(async () => ({
        total: 0,
        overdue: 0,
        stale: 0,
        inProgress: 0,
        blocked: 0,
      })),
      countClosedSince: vi.fn(async () => null),
    },
    sessionMemories: { record: vi.fn(), get: vi.fn(() => null) },
  }
}

// -------------------------------------------------------------------------
// lore-project
// -------------------------------------------------------------------------

describe("lore-project polymorphic dispatcher", () => {
  it("registers the polymorphic tool", () => {
    const mock = createMockServer()
    registerProjectTools(mock.server, makeServices() as never)
    expect(mock.has("lore-project")).toBe(true)
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
  it("registers the polymorphic tool", () => {
    const mock = createMockServer()
    registerMemoryTools(mock.server, makeServices() as never)
    expect(mock.has("lore-memory")).toBe(true)
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

  it("dispatches action='save' to memories.create", async () => {
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

  it("threads source='agent_diary' through action='recall' (legacy read path)", async () => {
    // The 0.6.0 deprecation purge removed the legacy journal tool, but
    // production vaults still carry historical `agent_diary` memories.
    // This test pins the documented escape hatch from `MemorySource`'s
    // JSDoc: callers can still recall those rows via lore-query with an
    // explicit source filter. Regression-pin so the recall path can't
    // silently regress when the source-filter list is touched.
    const memoriesList = vi.fn(async () => ({ items: [], nextCursor: undefined }))
    const mock = createMockServer()
    registerQueryTools(mock.server, makeServices({ memoriesList }) as never)
    await mock.get("lore-query")({
      action: "recall",
      source: "agent_diary",
    } as never)
    expect(memoriesList).toHaveBeenCalledWith(
      expect.objectContaining({ source: "agent_diary" }),
    )
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

  it("dispatches action='search' with intent forwarded to memories.search end-to-end (#17)", async () => {
    // Acceptance criterion: `lore-query action='search'` forwards intent
    // through to the service layer. Pin the dispatcher → handler → service
    // composition so a future refactor that drops the field at any seam
    // is caught here.
    const memoriesSearch = vi.fn(async () => [])
    const mock = createMockServer()
    registerQueryTools(mock.server, makeServices({ memoriesSearch }) as never)
    await mock.get("lore-query")({
      action: "search",
      query: "auth",
      intent: "WeChat session cookie",
    } as never)
    expect(memoriesSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "auth",
        intent: "WeChat session cookie",
      }),
    )
  })

  it.each(["recall", "ask", "audit"] as const)(
    "queryDispatchSchema strips intent from action='%s' (intent is absent from non-search arms)",
    (action) => {
      // Acceptance criterion: only the `search` arm accepts `intent`.
      // Drive the schema directly via `safeParse` rather than through a
      // handler stub — a handler-level spy only observes whatever
      // hand-constructed argument literal each `handleX` builds, which
      // would mask a regression that re-introduces `intent` on a non-
      // `search` arm of the dispatcher schema.
      //
      // Zod's default `z.object` mode strips unknown keys silently. So a
      // future contributor who adds `intent: z.string().optional()` to
      // the recall (or any other) arm here would NOT cause `safeParse`
      // to fail — the field would simply start surviving into
      // `parsed.data`. Asserting `parsed.data` does not have `intent`
      // is the load-bearing pin for the per-arm field membership.
      const required: Record<string, unknown> =
        action === "ask" ? { entity: "Auth" } : {}
      const parsed = queryDispatchSchema.safeParse({
        action,
        intent: "should be stripped",
        ...required,
      })
      expect(parsed.success).toBe(true)
      if (!parsed.success) return
      expect(parsed.data.action).toBe(action)
      expect(parsed.data).not.toHaveProperty("intent")
    },
  )

  it("queryDispatchSchema preserves intent on action='search' (positive control for the negative tests above)", () => {
    // The negative tests rely on Zod's strip behavior — a passing parse
    // with no `intent` key in `parsed.data` is the regression signal.
    // This positive control proves the strip behavior isn't masking a
    // schema-wide bug that drops `intent` from every arm.
    const parsed = queryDispatchSchema.safeParse({
      action: "search",
      query: "auth",
      intent: "WeChat session cookie",
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.action).toBe("search")
    expect(parsed.data).toHaveProperty("intent", "WeChat session cookie")
  })

  it("dispatches action='search' with explain:true through searchWithExplain", async () => {
    // The dispatcher must route to searchWithExplain (not search) when
    // explain is set, so callers that opt in get the trace.
    const memoriesSearch = vi.fn(async () => [])
    const memoriesSearchWithExplain = vi.fn(async () => ({
      memories: [],
      explain: [],
    }))
    const mock = createMockServer()
    registerQueryTools(
      mock.server,
      makeServices({ memoriesSearch, memoriesSearchWithExplain }) as never,
    )
    await mock.get("lore-query")({
      action: "search",
      query: "auth",
      explain: true,
    } as never)
    expect(memoriesSearchWithExplain).toHaveBeenCalled()
    expect(memoriesSearch).not.toHaveBeenCalled()
  })

  it("renders ## Score trace footer when explain:true and results exist", async () => {
    // Confirm the explain trace surfaces in the response text. The
    // format is the canonical contract: per-row branch + ranks + rrf.
    const memoriesSearchWithExplain = vi.fn(async () => ({
      memories: [
        {
          id: "mem-1",
          title: "First",
          projectIds: [],
          topicId: null,
          source: "manual",
          kind: "note",
          status: "informational",
          confidence: "certain",
          reviewBy: null,
          doneAt: null,
          decidedAt: null,
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
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          taskState: null,
          blockedBy: "",
          entity: "",
        },
      ],
      explain: [
        {
          memoryId: "mem-1",
          containsRank: 0,
          semanticRank: 1,
          rrfScore: 0.0322,
          branch: "rrf",
        },
      ],
    }))
    const mock = createMockServer()
    registerQueryTools(
      mock.server,
      makeServices({ memoriesSearchWithExplain }) as never,
    )
    const result = await mock.get("lore-query")({
      action: "search",
      query: "auth",
      explain: true,
    } as never)
    const text = extractText(result)
    expect(text).toContain("## Score trace")
    expect(text).toContain("mem-1 branch=rrf contains=0 semantic=1 rrf=0.032200")
  })

  it("omits ## Score trace footer when explain is not set", async () => {
    // Default path stays terse — no score trace pollution. The
    // dispatcher must route through plain `search`, not `searchWithExplain`.
    const memoriesSearch = vi.fn(async () => [])
    const memoriesSearchWithExplain = vi.fn(async () => ({
      memories: [],
      explain: [],
    }))
    const mock = createMockServer()
    registerQueryTools(
      mock.server,
      makeServices({ memoriesSearch, memoriesSearchWithExplain }) as never,
    )
    const result = await mock.get("lore-query")({
      action: "search",
      query: "auth",
    } as never)
    expect(extractText(result)).not.toContain("## Score trace")
    expect(memoriesSearchWithExplain).not.toHaveBeenCalled()
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
  it("registers lore-fact", () => {
    const mock = createMockServer()
    registerKnowledgeTools(mock.server, makeServices() as never)
    expect(mock.has("lore-fact")).toBe(true)
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
  it("registers lore-decision", () => {
    const mock = createMockServer()
    registerDecisionTools(mock.server, makeServices() as never)
    expect(mock.has("lore-decision")).toBe(true)
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
  it("registers lore-context", () => {
    const mock = createMockServer()
    registerContextTools(mock.server, makeServices() as never)
    expect(mock.has("lore-context")).toBe(true)
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
// lore-task (PF3-06)
// -------------------------------------------------------------------------

describe("lore-task polymorphic dispatcher", () => {
  it("registers lore-task", () => {
    const mock = createMockServer()
    registerTaskTools(mock.server, makeServices() as never)
    expect(mock.has("lore-task")).toBe(true)
  })

  it("dispatches action='create' to tasks.create with subject threading through", async () => {
    const tasksCreate = vi.fn(async () => ({
      id: "t-1",
      title: "Rotate keys",
      projectIds: [],
      taskState: "open",
      blockedBy: "",
      entity: "Rotate keys",
      reviewBy: null,
    }))
    const mock = createMockServer()
    registerTaskTools(mock.server, makeServices({ tasksCreate }) as never)
    const result = await mock.get("lore-task")({
      action: "create",
      subject: "Rotate keys",
      description: "Roll the signing key.",
    } as never)
    expect(tasksCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Rotate keys",
        description: "Roll the signing key.",
      }),
    )
    expect(extractText(result)).toContain("Created task")
    expect(extractText(result)).toContain("State: open")
  })

  it("dispatches action='update' to tasks.update", async () => {
    const tasksUpdate = vi.fn(async () => ({
      id: "t-1",
      title: "Rotate keys",
      projectIds: [],
      taskState: "in-progress",
      blockedBy: "",
      entity: "Rotate keys",
      reviewBy: null,
    }))
    const mock = createMockServer()
    registerTaskTools(mock.server, makeServices({ tasksUpdate }) as never)
    await mock.get("lore-task")({
      action: "update",
      taskId: "t-1",
      state: "in-progress",
    } as never)
    expect(tasksUpdate).toHaveBeenCalledWith(
      "t-1",
      expect.objectContaining({ state: "in-progress" }),
    )
  })

  it("dispatches action='close' with default state=done", async () => {
    const tasksClose = vi.fn(async () => undefined)
    const mock = createMockServer()
    registerTaskTools(mock.server, makeServices({ tasksClose }) as never)
    const result = await mock.get("lore-task")({
      action: "close",
      taskId: "t-1",
    } as never)
    expect(tasksClose).toHaveBeenCalledWith("t-1", "done")
    expect(extractText(result)).toContain("Closed task t-1")
  })

  it("dispatches action='list' to tasks.list", async () => {
    const tasksList = vi.fn(async () => ({ items: [] }))
    const mock = createMockServer()
    registerTaskTools(mock.server, makeServices({ tasksList }) as never)
    const result = await mock.get("lore-task")({
      action: "list",
      entity: "PR-99",
    } as never)
    expect(tasksList).toHaveBeenCalled()
    expect(extractText(result)).toContain("No tasks found")
  })

  it("rejects an invalid action with a discriminator error", async () => {
    const mock = createMockServer()
    registerTaskTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-task")({ action: "explode" } as never)
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("lore-task")
    expect(extractText(result)).toContain("action")
  })

  it("rejects action='create' without subject", async () => {
    const mock = createMockServer()
    registerTaskTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-task")({ action: "create" } as never)
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("lore-task")
  })

  it("rejects action='update' without taskId", async () => {
    const mock = createMockServer()
    registerTaskTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-task")({
      action: "update",
      state: "in-progress",
    } as never)
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("lore-task")
  })

  it("preserves the create-time blocked-without-blockedBy guard at the polymorphic surface", async () => {
    const tasksCreate = vi.fn()
    const mock = createMockServer()
    registerTaskTools(mock.server, makeServices({ tasksCreate }) as never)
    const result = await mock.get("lore-task")({
      action: "create",
      subject: "Ship release",
      state: "blocked",
    } as never)
    expect(tasksCreate).not.toHaveBeenCalled()
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("blockedBy")
  })

  it("preserves the update-time blocked-without-blockedBy guard at the polymorphic surface", async () => {
    // Mirrors the create-time guard: `handleUpdate` rejects a transition
    // into `state: 'blocked'` unless `blockedBy` is restated in the same
    // call (even if a prior write already set it). The per-handler
    // `tasks.test.ts` exercises this through the `lore-task-update`
    // alias; this assertion pins the same contract at the polymorphic
    // dispatcher so a future regression in the dispatch path can't
    // silently drop the guard.
    const tasksUpdate = vi.fn()
    const mock = createMockServer()
    registerTaskTools(mock.server, makeServices({ tasksUpdate }) as never)
    const result = await mock.get("lore-task")({
      action: "update",
      taskId: "task-id",
      state: "blocked",
    } as never)
    expect(tasksUpdate).not.toHaveBeenCalled()
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("blockedBy")
  })

  it("rejects update transitioning to blocked when blockedBy is empty string at the polymorphic surface", async () => {
    // Empty string with `state: "blocked"` is rejected — restating is
    // required, and an empty restate is unactionable. Exercises the
    // second branch of the cross-field guard via the polymorphic
    // dispatcher.
    const tasksUpdate = vi.fn()
    const mock = createMockServer()
    registerTaskTools(mock.server, makeServices({ tasksUpdate }) as never)
    const result = await mock.get("lore-task")({
      action: "update",
      taskId: "task-id",
      state: "blocked",
      blockedBy: "",
    } as never)
    expect(tasksUpdate).not.toHaveBeenCalled()
    expect(isError(result)).toBe(true)
  })
})

// -------------------------------------------------------------------------
// Tool surface count — the post-purge invariant
// -------------------------------------------------------------------------

describe("MCP tool surface", () => {
  it("registers exactly the 7 polymorphic tools — zero aliases", () => {
    // The 0.6.0 deprecation purge removed the 28 single-purpose aliases
    // (24 from P3-01 + 4 from PF3-06) and the `lore-journal` polymorphic
    // tool itself. This assertion is the load-bearing guard against
    // re-introduction. The rationale lives in `src/mcp/AGENTS.md`
    // "Deprecation timeline (historical)": every alias's schema rendered
    // into the agent-visible MCP capabilities config on every reconnecting
    // session, so adding a new alias under any cover (e.g. "just for one
    // transition") would re-introduce the prompt-budget drift this purge
    // corrected. A legitimate new tool family should update the expected
    // list here rather than route around the assertion.
    const mock = createMockServer()
    const services = makeServices() as never
    registerContextTools(mock.server, services)
    registerMemoryTools(mock.server, services)
    registerQueryTools(mock.server, services)
    registerKnowledgeTools(mock.server, services)
    registerDecisionTools(mock.server, services)
    registerProjectTools(mock.server, services)
    registerTaskTools(mock.server, services)

    const polymorphic = [
      "lore-context",
      "lore-memory",
      "lore-query",
      "lore-fact",
      "lore-decision",
      "lore-project",
      "lore-task",
    ]
    expect(mock.names().sort()).toEqual([...polymorphic].sort())
  })

  // -----------------------------------------------------------------------
  // Polymorphic-tool prompt-economy budgets.
  //
  // The seven polymorphic tools are now the only registered surface, so
  // these ceilings guard against a future PR quietly appending an
  // action's worth of bullets to a description and re-inflating every
  // reconnecting session's prompt — the same pressure that motivated
  // the alias purge in the first place.
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
    registerProjectTools(mock.server, services)
    registerTaskTools(mock.server, services)

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
      "lore-project",
      "lore-task",
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
    registerProjectTools(mock.server, services)
    registerTaskTools(mock.server, services)

    // Combined ceiling. The surface has moved 7 → 8 → 7 across P3-01,
    // PF3-06, and the 0.6.0 purge; the budget covers the high-water
    // mark plus comfortable headroom so a future action lands without
    // inviting a surface-doubling regression.
    const TOTAL_POLYMORPHIC_DESCRIPTION_LIMIT = 7000
    const polymorphic = [
      "lore-context",
      "lore-memory",
      "lore-query",
      "lore-fact",
      "lore-decision",
      "lore-project",
      "lore-task",
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
    registerProjectTools(mock.server, services)
    registerTaskTools(mock.server, services)

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
      "lore-project",
      "lore-task",
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

// -------------------------------------------------------------------------
// Synopsis surface (issue 0.7.0/02)
//
// Pin that the optional `synopsis` field threads through to the right
// action handlers, that the 500-char Zod cap fires at the dispatch
// boundary, and that each write tool's MCP-visible inputSchema names
// `synopsis` so an agent introspecting via tools/list discovers it.
// -------------------------------------------------------------------------

describe("synopsis surface (issue 0.7.0/02)", () => {
  it("threads synopsis on lore-memory action='save' to memories.create", async () => {
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
      synopsis: "One-liner",
    } as never)
    expect(memoriesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ synopsis: "One-liner" }),
    )
  })

  it("threads synopsis on lore-memory action='update' to memories.update", async () => {
    const memoriesUpdate = vi.fn(async () => ({
      id: "m1",
      title: "T",
      projectIds: [],
      content: "C",
    }))
    const mock = createMockServer()
    registerMemoryTools(mock.server, makeServices({ memoriesUpdate }) as never)
    await mock.get("lore-memory")({
      action: "update",
      memoryId: "m1",
      synopsis: "Refined",
    } as never)
    expect(memoriesUpdate).toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({ synopsis: "Refined" }),
    )
  })

  it("threads synopsis on lore-decision action='create' to decisions.create", async () => {
    const decisionsCreate = vi.fn(async () => ({
      id: "d1",
      title: "T",
      projectIds: [],
      confidence: "certain",
    }))
    const mock = createMockServer()
    registerDecisionTools(
      mock.server,
      makeServices({ decisionsCreate }) as never,
    )
    await mock.get("lore-decision")({
      action: "create",
      decision: "Cache resolutions",
      rationale: "long form",
      synopsis: "Resolved projects cached for 60s.",
    } as never)
    expect(decisionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        synopsis: "Resolved projects cached for 60s.",
      }),
    )
  })

  it("threads synopsis on lore-task action='create' and 'update' to TaskService", async () => {
    const tasksCreate = vi.fn(async () => ({
      id: "t1",
      title: "T",
      projectIds: [],
      taskState: "open",
    }))
    const tasksUpdate = vi.fn(async () => ({
      id: "t1",
      title: "T",
      projectIds: [],
      taskState: "open",
    }))
    const mock = createMockServer()
    registerTaskTools(
      mock.server,
      makeServices({ tasksCreate, tasksUpdate }) as never,
    )

    await mock.get("lore-task")({
      action: "create",
      subject: "Rotate keys",
      synopsis: "Rotate keys for new env.",
    } as never)
    expect(tasksCreate).toHaveBeenCalledWith(
      expect.objectContaining({ synopsis: "Rotate keys for new env." }),
    )

    await mock.get("lore-task")({
      action: "update",
      taskId: "t1",
      synopsis: "Updated synopsis",
    } as never)
    expect(tasksUpdate).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ synopsis: "Updated synopsis" }),
    )
  })

  it("rejects synopsis longer than 500 chars at the dispatch boundary on every write tool", async () => {
    const overCap = "x".repeat(501)
    const cases: Array<{ tool: string; args: Record<string, unknown> }> = [
      {
        tool: "lore-memory",
        args: { action: "save", title: "T", content: "C", synopsis: overCap },
      },
      {
        tool: "lore-memory",
        args: { action: "update", memoryId: "m1", synopsis: overCap },
      },
      {
        tool: "lore-decision",
        args: {
          action: "create",
          decision: "T",
          rationale: "R",
          synopsis: overCap,
        },
      },
      {
        tool: "lore-task",
        args: { action: "create", subject: "T", synopsis: overCap },
      },
      {
        tool: "lore-task",
        args: { action: "update", taskId: "t1", synopsis: overCap },
      },
    ]
    const mock = createMockServer()
    const services = makeServices() as never
    registerMemoryTools(mock.server, services)
    registerDecisionTools(mock.server, services)
    registerTaskTools(mock.server, services)

    for (const { tool, args } of cases) {
      const result = await mock.get(tool)(args as never)
      expect(isError(result), `${tool} ${args.action} should reject overcap synopsis`).toBe(true)
      expect(extractText(result)).toContain("synopsis")
    }
  })

  it("each write tool's inputSchema names synopsis so agents discover it via tools/list", () => {
    const mock = createMockServer()
    const services = makeServices() as never
    registerMemoryTools(mock.server, services)
    registerDecisionTools(mock.server, services)
    registerTaskTools(mock.server, services)

    for (const tool of ["lore-memory", "lore-decision", "lore-task"]) {
      const cfg = mock.config(tool)
      const schema = cfg.inputSchema as Record<string, unknown> | undefined
      expect(schema, `${tool} must declare an inputSchema`).toBeDefined()
      expect(
        schema && Object.keys(schema).includes("synopsis"),
        `${tool} inputSchema must declare a synopsis field`,
      ).toBe(true)
    }
  })
})
