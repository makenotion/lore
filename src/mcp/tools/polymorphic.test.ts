/**
 * Polymorphic dispatcher tests for the registered `lore-*` tools.
 * The exact set is enumerated in the `polymorphic` array in each
 * test below and is the load-bearing contract — when a tool family
 * is added or removed the list updates in lockstep, and the tests
 * fail loudly if registration falls out of sync.
 *
 * These tests verify the contract:
 * 1. Each polymorphic tool is registered.
 * 2. Each declared `action` value reaches the right underlying handler.
 * 3. Invalid `action` values produce a clean discriminated-union error.
 * 4. Missing required-per-action params produce a clean error.
 * 5. The MCP tool surface is exactly the declared polymorphic set — no
 *    deprecated aliases remain.
 *
 * Per-handler behavior is exercised by the existing per-file test
 * suites; this file specifically covers the dispatcher.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { registerContextTools } from "./context.js"
import { registerMemoryTools } from "./memory.js"
import { registerPinnedTools } from "./pinned.js"
import { queryDispatchSchema, registerQueryTools } from "./query.js"
import { registerKnowledgeTools } from "./knowledge.js"
import { registerDecisionTools } from "./decisions.js"
import { registerProjectTools } from "./project.js"
import { registerTaskTools } from "./tasks.js"
import { registerProcedureTools } from "./procedures.js"
import { HELP_RECIPES } from "../help.js"
import { resolveProfileFromConfig } from "../../profile/index.js"

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

function enumValuesOf(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return []
  const def = (schema as { _def?: { values?: unknown } })._def
  if (Array.isArray(def?.values)) return [...def.values]
  return []
}

function validateAgainstInputSchema(
  inputSchema: Record<string, unknown> | undefined,
  payload: Record<string, unknown>
): ReturnType<z.ZodObject<z.ZodRawShape>["safeParse"]> {
  expect(inputSchema).toBeDefined()
  return z
    .object(inputSchema as z.ZodRawShape)
    .passthrough()
    .safeParse(payload)
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
  memoriesGetPropertiesById?: ReturnType<typeof vi.fn>
  memoriesArchive?: ReturnType<typeof vi.fn>
  memoriesUpdate?: ReturnType<typeof vi.fn>
  memoriesCreate?: ReturnType<typeof vi.fn>
  memoriesRecordReview?: ReturnType<typeof vi.fn>
  memoriesSearch?: ReturnType<typeof vi.fn>
  memoriesSearchWithExplain?: ReturnType<typeof vi.fn>
  identityResolveAuthor?: ReturnType<typeof vi.fn>
  factsCreate?: ReturnType<typeof vi.fn>
  factsCreateWithDedup?: ReturnType<typeof vi.fn>
  factsInvalidate?: ReturnType<typeof vi.fn>
  factsExtendReview?: ReturnType<typeof vi.fn>
  decisionsCreate?: ReturnType<typeof vi.fn>
  decisionsList?: ReturnType<typeof vi.fn>
  decisionsGetById?: ReturnType<typeof vi.fn>
  decisionsSupersede?: ReturnType<typeof vi.fn>
  decisionsReviewCompleted?: ReturnType<typeof vi.fn>
  decisionsClearCache?: ReturnType<typeof vi.fn>
  tasksCreate?: ReturnType<typeof vi.fn>
  tasksUpdate?: ReturnType<typeof vi.fn>
  tasksClose?: ReturnType<typeof vi.fn>
  tasksList?: ReturnType<typeof vi.fn>
  profile?: unknown
}

function makeEntityService() {
  return {
    resolveOrCreateEntity: vi.fn(async () => ({
      entity: null,
      ambiguous: false,
      candidates: [],
      created: false,
    })),
  }
}

function makeServices(opts: StubOpts = {}): unknown {
  return {
    profile: opts.profile,
    config: { vault: { pageId: "v1" }, projects: [] },
    context: { project: null, vault: { pageId: "v1" } },
    vault: {
      pageId: "v1",
      stats:
        opts.vaultStats ??
        vi.fn(async () => ({ projects: 0, topics: 0, memories: 0, facts: 0 })),
    },
    projects: {
      list: opts.projectsList ?? vi.fn(async () => []),
      findByName: opts.projectsFindByName ?? vi.fn(async () => null),
    },
    entities: makeEntityService(),
    topics: {
      findByName: vi.fn(),
      getOrCreate: vi.fn(),
      listByProject: vi.fn(async () => []),
    },
    memories: {
      list:
        opts.memoriesList ?? vi.fn(async () => ({ items: [], nextCursor: undefined })),
      getById: opts.memoriesGetById ?? vi.fn(),
      getPropertiesById:
        opts.memoriesGetPropertiesById ??
        vi.fn(async (id: string) => ({ id, projectIds: [] })),
      archive: opts.memoriesArchive ?? vi.fn(async () => undefined),
      update: opts.memoriesUpdate ?? vi.fn(),
      create: opts.memoriesCreate ?? vi.fn(),
      search: opts.memoriesSearch ?? vi.fn(async () => []),
      searchWithExplain:
        opts.memoriesSearchWithExplain ??
        vi.fn(async () => ({ memories: [], explain: [] })),
      materializeContent: vi.fn(async (m) => m),
      getTitleById: vi.fn(),
      decrementConfidence: vi.fn(async () => 0.45),
      queryStaleConfidence: vi.fn(async () => []),
      countProposed: vi.fn(async () => ({ total: 0, bySource: {}, byAgent: {} })),
      listPinnedBlocks: vi.fn(async () => []),
      countPinnedBlocks: vi.fn(async () => 0),
      expiringScopedStats: vi.fn(async () => ({
        expired: 0,
        expiringSoon: 0,
        narrowScopeOutOfContext: 0,
      })),
      recordReview:
        opts.memoriesRecordReview ??
        vi.fn(async ({ memoryId, verdict }: { memoryId: string; verdict: string }) => ({
          memory: {
            id: memoryId,
            status: verdict === "approve" ? "accepted" : "rejected",
          },
          previousStatus: "proposed",
        })),
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
      getById: vi.fn(async () => null),
      extendReview: opts.factsExtendReview ?? vi.fn(async () => undefined),
      queryByEntity: vi.fn(async () => []),
      queryBySubject: vi.fn(async () => []),
      queryOverdue: vi.fn(async () => []),
      expiringScopedStats: vi.fn(async () => ({
        expired: 0,
        expiringSoon: 0,
        narrowScopeOutOfContext: 0,
      })),
    },
    decisions: {
      create: opts.decisionsCreate ?? vi.fn(),
      list:
        opts.decisionsList ?? vi.fn(async () => ({ items: [], nextCursor: undefined })),
      getById: opts.decisionsGetById ?? vi.fn(),
      supersede: opts.decisionsSupersede ?? vi.fn(async () => undefined),
      reviewCompleted: opts.decisionsReviewCompleted ?? vi.fn(async () => undefined),
      queryOverdue: vi.fn(async () => []),
      clearCache: opts.decisionsClearCache ?? vi.fn(),
    },
    tasks: {
      create: opts.tasksCreate ?? vi.fn(),
      update: opts.tasksUpdate ?? vi.fn(),
      close: opts.tasksClose ?? vi.fn(async () => undefined),
      list: opts.tasksList ?? vi.fn(async () => ({ items: [] })),
      queryOverdue: vi.fn(async () => []),
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
    identity: {
      resolveAuthor: opts.identityResolveAuthor ?? vi.fn(async () => null),
      clearCache: vi.fn(),
    },
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
      {
        id: "p1",
        name: "Widget",
        path: "apps/widget",
        type: "codebase",
        status: "active",
        description: "",
      },
    ])
    const mock = createMockServer()
    registerProjectTools(mock.server, makeServices({ projectsList }) as never)
    const result = await mock.get("lore-project")({ action: "list" } as never)
    expect(projectsList).toHaveBeenCalled()
    expect(extractText(result)).toContain("Widget")
  })

  it("passes status='any' through to the project list handler", async () => {
    const projectsList = vi.fn(async () => [])
    const mock = createMockServer()
    registerProjectTools(mock.server, makeServices({ projectsList }) as never)

    await mock.get("lore-project")({ action: "list", status: "any" } as never)

    expect(projectsList).toHaveBeenCalledWith("any")
  })

  it("passes status='archived' through to the project list handler", async () => {
    const projectsList = vi.fn(async () => [])
    const mock = createMockServer()
    registerProjectTools(mock.server, makeServices({ projectsList }) as never)

    await mock.get("lore-project")({ action: "list", status: "archived" } as never)

    expect(projectsList).toHaveBeenCalledWith("archived")
  })

  it("dispatches action='get' to the get handler", async () => {
    const projectsFindByName = vi.fn(async () => ({
      id: "p1",
      name: "Widget",
      path: "apps/widget",
      type: "codebase",
      status: "active",
      description: "Widget backend",
    }))
    const mock = createMockServer()
    registerProjectTools(mock.server, makeServices({ projectsFindByName }) as never)
    const result = await mock.get("lore-project")({
      action: "get",
      name: "Widget",
    } as never)
    expect(projectsFindByName).toHaveBeenCalledWith("Widget")
    expect(extractText(result)).toContain("# Widget")
  })

  it("surfaces archived-specific diagnostics for action='get'", async () => {
    const projectsFindByName = vi.fn(
      async (name: string, options?: { includeArchived?: boolean }) =>
        options?.includeArchived
          ? {
              id: "p-archive",
              name,
              path: "archive",
              type: "project",
              status: "archived",
              description: "",
            }
          : null
    )
    const mock = createMockServer()
    registerProjectTools(mock.server, makeServices({ projectsFindByName }) as never)

    const result = await mock.get("lore-project")({
      action: "get",
      name: "Archive",
    } as never)

    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain(
      'Project "Archive" could not be resolved because it is archived'
    )
    expect(projectsFindByName).toHaveBeenNthCalledWith(1, "Archive")
    expect(projectsFindByName).toHaveBeenNthCalledWith(2, "Archive", {
      includeArchived: true,
    })
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

  // ---------------------------------------------------------------------
  // Inbox-review actions (issue #281, AC #3 + AC #4)
  // ---------------------------------------------------------------------

  it("dispatches action='approve' to memories.recordReview with the explicit reviewer", async () => {
    const memoriesRecordReview = vi.fn(async () => ({
      memory: { id: "mem-1", status: "accepted" },
      previousStatus: "proposed",
    }))
    const mock = createMockServer()
    registerMemoryTools(mock.server, makeServices({ memoriesRecordReview }) as never)
    const result = await mock.get("lore-memory")({
      action: "approve",
      memoryId: "mem-1",
      reviewer: "Alice",
      reason: "Looks good",
    } as never)

    expect(memoriesRecordReview).toHaveBeenCalledWith({
      memoryId: "mem-1",
      verdict: "approve",
      reviewer: "Alice",
      reason: "Looks good",
    })
    expect(extractText(result)).toContain("Approved memory mem-1")
    expect(extractText(result)).toContain("Reviewer: Alice")
  })

  it("dispatches action='reject' to memories.recordReview with the explicit reviewer", async () => {
    const memoriesRecordReview = vi.fn(async () => ({
      memory: { id: "mem-2", status: "rejected" },
      previousStatus: "proposed",
    }))
    const mock = createMockServer()
    registerMemoryTools(mock.server, makeServices({ memoriesRecordReview }) as never)
    const result = await mock.get("lore-memory")({
      action: "reject",
      memoryId: "mem-2",
      reviewer: "Bob",
      reason: "Duplicate of an earlier note",
    } as never)

    expect(memoriesRecordReview).toHaveBeenCalledWith({
      memoryId: "mem-2",
      verdict: "reject",
      reviewer: "Bob",
      reason: "Duplicate of an earlier note",
    })
    expect(extractText(result)).toContain("Rejected memory mem-2")
  })

  it("falls back to identity.resolveAuthor when reviewer is omitted on approve", async () => {
    const memoriesRecordReview = vi.fn(async () => ({
      memory: { id: "mem-3", status: "accepted" },
      previousStatus: "proposed",
    }))
    const identityResolveAuthor = vi.fn(async () => "Engineer From users.me")
    const mock = createMockServer()
    registerMemoryTools(
      mock.server,
      makeServices({ memoriesRecordReview, identityResolveAuthor }) as never
    )
    await mock.get("lore-memory")({
      action: "approve",
      memoryId: "mem-3",
    } as never)

    expect(identityResolveAuthor).toHaveBeenCalled()
    expect(memoriesRecordReview).toHaveBeenCalledWith({
      memoryId: "mem-3",
      verdict: "approve",
      reviewer: "Engineer From users.me",
      reason: undefined,
    })
  })

  it("returns an actionable MCP error when no reviewer identity resolves", async () => {
    // Acceptance criterion: a row attributed to "(unknown)" is
    // worse than refusing the call. Pin the no-identity error
    // shape so future refactors can't degrade it into a thrown
    // exception that surfaces as a stack trace.
    const memoriesRecordReview = vi.fn()
    const identityResolveAuthor = vi.fn(async () => null)
    const mock = createMockServer()
    registerMemoryTools(
      mock.server,
      makeServices({ memoriesRecordReview, identityResolveAuthor }) as never
    )
    const result = await mock.get("lore-memory")({
      action: "approve",
      memoryId: "mem-4",
    } as never)

    expect(memoriesRecordReview).not.toHaveBeenCalled()
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("no reviewer identity")
  })

  it("returns an actionable MCP error when reviewer identity resolves to whitespace", async () => {
    // Resolver-trim parity with the CLI: a `users.me` response with
    // a whitespace-only `name` (or `LORE_USER_NAME="   "`) must hit
    // the no-identity guard at the MCP boundary, NOT fall through
    // into `recordReview` and surface as the bare service-layer
    // "reviewer must be a non-empty string" message. Pinned so a
    // refactor that drops the resolver-trim regresses here rather
    // than only at the end-to-end CLI test.
    const memoriesRecordReview = vi.fn()
    const identityResolveAuthor = vi.fn(async () => "   ")
    const mock = createMockServer()
    registerMemoryTools(
      mock.server,
      makeServices({ memoriesRecordReview, identityResolveAuthor }) as never
    )
    const result = await mock.get("lore-memory")({
      action: "reject",
      memoryId: "mem-ws",
    } as never)

    expect(memoriesRecordReview).not.toHaveBeenCalled()
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("no reviewer identity")
  })

  it("rejects approve without memoryId via the discriminated union", async () => {
    const mock = createMockServer()
    registerMemoryTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-memory")({ action: "approve" } as never)
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("lore-memory")
  })

  it("rejects reject with a reason longer than 500 chars at the dispatch boundary", async () => {
    const mock = createMockServer()
    registerMemoryTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-memory")({
      action: "reject",
      memoryId: "mem-5",
      reason: "x".repeat(501),
    } as never)
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

  // -----------------------------------------------------------------------
  // lore-memory action='suggest-topic-key'
  //
  // Pure heuristic over (title, kind). No I/O, no service touch — the
  // handler routes directly through `suggestTopicKey`. These dispatch
  // tests pin: the action reaches the renderer, the response
  // distinguishes suggestion vs. no-suggestion cleanly, and the
  // discriminated union enforces both required fields against the
  // full memory-kind enum.
  // -----------------------------------------------------------------------

  it("dispatches action='suggest-topic-key' and renders the suggested key + reason", async () => {
    const mock = createMockServer()
    registerMemoryTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-memory")({
      action: "suggest-topic-key",
      title: "JWT auth model with refresh tokens",
      kind: "decision",
    } as never)
    const text = extractText(result)
    expect(text).toContain("Suggested topic key: decision/jwt-auth-model")
    expect(text).toContain("Reason:")
  })

  it("renders the no-suggestion branch for kind='note'", async () => {
    const mock = createMockServer()
    registerMemoryTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-memory")({
      action: "suggest-topic-key",
      title: "Quick observation about caching",
      kind: "note",
    } as never)
    const text = extractText(result)
    expect(text).toContain("No suggestion")
    expect(text.toLowerCase()).toContain("note")
  })

  it("renders the no-suggestion branch for kind='task'", async () => {
    const mock = createMockServer()
    registerMemoryTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-memory")({
      action: "suggest-topic-key",
      title: "Investigate PR #1234",
      kind: "task",
    } as never)
    const text = extractText(result)
    expect(text).toContain("No suggestion")
    expect(text.toLowerCase()).toContain("task")
  })

  it("rejects action='suggest-topic-key' without title", async () => {
    const mock = createMockServer()
    registerMemoryTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-memory")({
      action: "suggest-topic-key",
      kind: "decision",
    } as never)
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("lore-memory")
    expect(extractText(result)).toContain("title")
  })

  it("rejects action='suggest-topic-key' without kind", async () => {
    const mock = createMockServer()
    registerMemoryTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-memory")({
      action: "suggest-topic-key",
      title: "JWT auth model",
    } as never)
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("lore-memory")
    expect(extractText(result)).toContain("kind")
  })

  it("rejects action='suggest-topic-key' with unknown kind", async () => {
    // Out-of-vocab kinds fail at the discriminated-union boundary
    // rather than reaching `suggestTopicKey` — pins the Zod enum
    // gate.
    const mock = createMockServer()
    registerMemoryTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-memory")({
      action: "suggest-topic-key",
      title: "Some title",
      kind: "fabrication",
    } as never)
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("lore-memory")
  })

  it("issues no Notion service calls on action='suggest-topic-key' (pure helper)", async () => {
    // The handler is a pure heuristic — pin that no service method on
    // the LoreServices stub fires when the dispatcher routes through
    // it. Catches any future regression that re-couples the handler to
    // service state (e.g. an over-eager session-memory record).
    const memoriesCreate = vi.fn()
    const memoriesUpdate = vi.fn()
    const memoriesArchive = vi.fn()
    const memoriesGetById = vi.fn()
    const memoriesList = vi.fn()
    const memoriesSearch = vi.fn()
    const factsCreateWithDedup = vi.fn()
    const mock = createMockServer()
    registerMemoryTools(
      mock.server,
      makeServices({
        memoriesCreate,
        memoriesUpdate,
        memoriesArchive,
        memoriesGetById,
        memoriesList,
        memoriesSearch,
        factsCreateWithDedup,
      }) as never
    )
    await mock.get("lore-memory")({
      action: "suggest-topic-key",
      title: "Database migration for shard split",
      kind: "runbook",
    } as never)
    expect(memoriesCreate).not.toHaveBeenCalled()
    expect(memoriesUpdate).not.toHaveBeenCalled()
    expect(memoriesArchive).not.toHaveBeenCalled()
    expect(memoriesGetById).not.toHaveBeenCalled()
    expect(memoriesList).not.toHaveBeenCalled()
    expect(memoriesSearch).not.toHaveBeenCalled()
    expect(factsCreateWithDedup).not.toHaveBeenCalled()
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
      expect.objectContaining({ source: "agent_diary" })
    )
  })

  it("dispatches action='search' with required query", async () => {
    const memoriesSearch = vi.fn(async () => [])
    const mock = createMockServer()
    registerQueryTools(mock.server, makeServices({ memoriesSearch }) as never)
    await mock.get("lore-query")({ action: "search", query: "auth" } as never)
    expect(memoriesSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: "auth" })
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
      })
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
      const required: Record<string, unknown> = action === "ask" ? { entity: "Auth" } : {}
      const parsed = queryDispatchSchema.safeParse({
        action,
        intent: "should be stripped",
        ...required,
      })
      expect(parsed.success).toBe(true)
      if (!parsed.success) return
      expect(parsed.data.action).toBe(action)
      expect(parsed.data).not.toHaveProperty("intent")
    }
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
      makeServices({ memoriesSearch, memoriesSearchWithExplain }) as never
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
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          taskState: null,
          blockedBy: "",
          entity: "",
          comparedWith: [],
          compareNotes: "",
        },
      ],
      explain: [
        {
          memoryId: "mem-1",
          containsRank: 0,
          semanticRank: 1,
          rrfScore: 0.0322,
          branch: "rrf",
          confidenceFactor: 1.0,
        },
      ],
    }))
    const mock = createMockServer()
    registerQueryTools(mock.server, makeServices({ memoriesSearchWithExplain }) as never)
    const result = await mock.get("lore-query")({
      action: "search",
      query: "auth",
      explain: true,
    } as never)
    const text = extractText(result)
    expect(text).toContain("## Score trace")
    expect(text).toContain(
      "mem-1 branch=rrf contains=0 semantic=1 rrf=0.032200 confidenceFactor=1.000"
    )
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
      makeServices({ memoriesSearch, memoriesSearchWithExplain }) as never
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

  it("rejects action='ask' with empty entity (issue #481)", async () => {
    // Pin the Zod boundary rejection so a future schema refactor
    // can't silently regress to `z.string()` and let an empty entity
    // reach `FactService.queryByEntity` (which now also short-circuits
    // to `[]`, but the boundary rejection gives the agent a useful
    // diagnostic instead of "no facts found").
    const mock = createMockServer()
    registerQueryTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-query")({
      action: "ask",
      entity: "",
    } as never)
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("entity")
  })

  it("rejects action='ask' with whitespace-only entity (issue #481)", async () => {
    const mock = createMockServer()
    registerQueryTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-query")({
      action: "ask",
      entity: "   ",
    } as never)
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("entity")
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
    registerKnowledgeTools(mock.server, makeServices({ factsExtendReview }) as never)
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
    registerKnowledgeTools(mock.server, makeServices({ factsCreateWithDedup }) as never)
    await mock.get("lore-fact")({
      action: "create",
      subject: "Auth",
      predicate: "uses",
      object: "JWT",
      sourceMemoryId: "mem-source",
    } as never)
    expect(factsCreateWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMemoryId: "mem-source" })
    )
  })

  it("rejects action='create' with empty subject (issue #481)", async () => {
    // Pin the write-path symmetry: an empty / whitespace-only triple
    // would hash through `normalize("")` into `DedupKey` and persist
    // a structurally degenerate row. The Zod boundary fails dispatch
    // before `createWithDedup` runs.
    const mock = createMockServer()
    registerKnowledgeTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-fact")({
      action: "create",
      subject: "",
      predicate: "uses",
      object: "JWT",
      sourceMemoryId: "mem-source",
    } as never)
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("subject")
  })

  it("rejects action='create' with whitespace-only object (issue #481)", async () => {
    const mock = createMockServer()
    registerKnowledgeTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-fact")({
      action: "create",
      subject: "Auth",
      predicate: "uses",
      object: "   ",
      sourceMemoryId: "mem-source",
    } as never)
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("object")
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
      makeServices({ decisionsReviewCompleted }) as never
    )
    const result = await mock.get("lore-decision")({
      action: "review",
      decisionId: "d-1",
    } as never)
    expect(decisionsReviewCompleted).toHaveBeenCalledWith(
      "d-1",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)
    )
    expect(extractText(result)).toContain("d-1")
  })

  it("rejects action='supersede' without ids", async () => {
    const mock = createMockServer()
    registerDecisionTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-decision")({ action: "supersede" } as never)
    expect(isError(result)).toBe(true)
  })

  it("rejects action='context' with empty entity (issue #481)", async () => {
    // Mirrors the `lore-query action='ask'` rejection above. The
    // handler funnels into `FactService.queryByEntity`, which short-
    // circuits empty input to `[]`, but the dispatch should fail with
    // a useful diagnostic instead of "No decisions found governing".
    const mock = createMockServer()
    registerDecisionTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-decision")({
      action: "context",
      entity: "",
    } as never)
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("entity")
  })

  it("rejects action='context' with whitespace-only entity (issue #481)", async () => {
    const mock = createMockServer()
    registerDecisionTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-decision")({
      action: "context",
      entity: "\t",
    } as never)
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("entity")
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
      })
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
      expect.objectContaining({ state: "in-progress" })
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

  // -----------------------------------------------------------------------
  // lore-task action='reconcile' (issue 0.7.0/14)
  //
  // The action must reach the orchestrator (positive dispatch) and the
  // discriminated-union must enforce the bounds on `minScore` (0–1) and
  // `limit` (1–100). The orchestrator's behavior is exercised in
  // `core/task-reconcile.test.ts`; this block covers the dispatch
  // contract.
  // -----------------------------------------------------------------------

  it("dispatches action='reconcile' to the reconcile handler with no optional params", async () => {
    const tasksList = vi.fn(async () => ({ items: [] }))
    const mock = createMockServer()
    registerTaskTools(mock.server, makeServices({ tasksList }) as never)
    const result = await mock.get("lore-task")({
      action: "reconcile",
    } as never)
    expect(tasksList).toHaveBeenCalled()
    expect(extractText(result)).toContain("0 candidate closures")
  })

  it("dispatches action='reconcile' with projectName, minScore, and limit options", async () => {
    const tasksList = vi.fn(async () => ({ items: [] }))
    const projectsFindByName = vi.fn(async () => ({
      id: "p1",
      name: "Widget",
      path: "apps/widget",
      type: "codebase",
      status: "active",
      description: "",
    }))
    const mock = createMockServer()
    registerTaskTools(
      mock.server,
      makeServices({ tasksList, projectsFindByName }) as never
    )
    const result = await mock.get("lore-task")({
      action: "reconcile",
      projectName: "Widget",
      minScore: 0.7,
      limit: 50,
    } as never)
    expect(projectsFindByName).toHaveBeenCalledWith("Widget")
    expect(extractText(result)).toContain("0 candidate closures")
  })

  it("rejects action='reconcile' with minScore < 0", async () => {
    const mock = createMockServer()
    registerTaskTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-task")({
      action: "reconcile",
      minScore: -0.1,
    } as never)
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("minScore")
  })

  it("rejects action='reconcile' with minScore > 1", async () => {
    const mock = createMockServer()
    registerTaskTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-task")({
      action: "reconcile",
      minScore: 1.1,
    } as never)
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("minScore")
  })

  it("rejects action='reconcile' with limit < 1", async () => {
    const mock = createMockServer()
    registerTaskTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-task")({
      action: "reconcile",
      limit: 0,
    } as never)
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("limit")
  })

  it("rejects action='reconcile' with limit > 100", async () => {
    const mock = createMockServer()
    registerTaskTools(mock.server, makeServices() as never)
    const result = await mock.get("lore-task")({
      action: "reconcile",
      limit: 101,
    } as never)
    expect(isError(result)).toBe(true)
    expect(extractText(result)).toContain("limit")
  })

  it("the registered action enum lists 'reconcile'", () => {
    const mock = createMockServer()
    registerTaskTools(mock.server, makeServices() as never)
    const cfg = mock.config("lore-task")
    const schema = cfg.inputSchema as Record<string, unknown>
    // Pull the `action` field's enum values via Zod internals. The mock
    // captures the raw schema map, not a finalized JSON Schema; this
    // mirrors the helper at top of file.
    const actionField = schema["action"] as
      | { _def?: { values?: readonly string[] } }
      | undefined
    expect(actionField).toBeDefined()
    expect(actionField?._def?.values).toContain("reconcile")
  })

  it("describes the reconcile action in the top-level description", () => {
    const mock = createMockServer()
    registerTaskTools(mock.server, makeServices() as never)
    const desc = mock.description("lore-task")
    expect(desc).toContain("'reconcile'")
    expect(desc).toContain("never auto-closes")
  })

  it("the reconcile action is read-only by behavior — no write-shaped Notion calls land", async () => {
    // The `lore-task` tool's annotations cannot set `readOnlyHint: true`
    // (the same registration also serves create/update/close), so the
    // read-only contract is enforced by handler implementation. Pin
    // that the reconcile dispatch path issues no write-shaped service
    // call (`tasks.create`, `tasks.update`, `tasks.close`,
    // `memories.create`, `memories.update`, `memories.archive`).
    const tasksCreate = vi.fn()
    const tasksUpdate = vi.fn()
    const tasksClose = vi.fn()
    const memoriesCreate = vi.fn()
    const memoriesUpdate = vi.fn()
    const memoriesArchive = vi.fn()
    const tasksList = vi.fn(async () => ({ items: [] }))
    const memoriesSearch = vi.fn(async () => [])
    const mock = createMockServer()
    registerTaskTools(
      mock.server,
      makeServices({
        tasksCreate,
        tasksUpdate,
        tasksClose,
        memoriesCreate,
        memoriesUpdate,
        memoriesArchive,
        tasksList,
        memoriesSearch,
      }) as never
    )
    await mock.get("lore-task")({ action: "reconcile" } as never)
    expect(tasksCreate).not.toHaveBeenCalled()
    expect(tasksUpdate).not.toHaveBeenCalled()
    expect(tasksClose).not.toHaveBeenCalled()
    expect(memoriesCreate).not.toHaveBeenCalled()
    expect(memoriesUpdate).not.toHaveBeenCalled()
    expect(memoriesArchive).not.toHaveBeenCalled()
  })
})

// -------------------------------------------------------------------------
// Tool surface count — the post-purge invariant
// -------------------------------------------------------------------------

describe("MCP tool surface", () => {
  it("registers exactly the declared polymorphic tools — zero aliases", () => {
    // The 0.6.0 deprecation purge removed the 28 single-purpose aliases
    // (24 from P3-01 + 4 from PF3-06) and the `lore-journal` polymorphic
    // tool itself. This assertion is the load-bearing guard against
    // re-introduction. Every registered tool name's schema is rendered
    // into the agent-visible MCP capabilities config on every
    // reconnecting session, so adding a new alias under any cover
    // (e.g. "just for one transition") re-introduces prompt-budget
    // drift. A legitimate new tool family should update the expected
    // list here rather than route around the assertion.
    const mock = createMockServer()
    const services = makeServices() as never
    registerContextTools(mock.server, services)
    registerMemoryTools(mock.server, services)
    registerPinnedTools(mock.server, services)
    registerQueryTools(mock.server, services)
    registerKnowledgeTools(mock.server, services)
    registerDecisionTools(mock.server, services)
    registerProjectTools(mock.server, services)
    registerTaskTools(mock.server, services)
    registerProcedureTools(mock.server, services)

    const polymorphic = [
      "lore-context",
      "lore-memory",
      "lore-pinned",
      "lore-query",
      "lore-fact",
      "lore-decision",
      "lore-project",
      "lore-task",
      "lore-procedure",
    ]
    expect(mock.names().sort()).toEqual([...polymorphic].sort())
  })

  it("has a help recipe for every public polymorphic action", () => {
    const registerAll = (services: never) => {
      const mock = createMockServer()
      registerContextTools(mock.server, services)
      registerMemoryTools(mock.server, services)
      registerPinnedTools(mock.server, services)
      registerQueryTools(mock.server, services)
      registerKnowledgeTools(mock.server, services)
      registerDecisionTools(mock.server, services)
      registerProjectTools(mock.server, services)
      registerTaskTools(mock.server, services)
      registerProcedureTools(mock.server, services)
      return mock
    }
    const mock = registerAll(makeServices() as never)

    const recipeKeys = HELP_RECIPES.map((recipe) => `${recipe.tool}/${recipe.action}`)
    expect(new Set(recipeKeys).size, "help recipe keys must be unique").toBe(
      recipeKeys.length
    )

    const helpActionsByTool = new Map<string, string[]>()
    for (const recipe of HELP_RECIPES) {
      const actions = helpActionsByTool.get(recipe.tool)
      if (actions) {
        actions.push(recipe.action)
      } else {
        helpActionsByTool.set(recipe.tool, [recipe.action])
      }
    }

    for (const name of mock.names()) {
      const actionSchema = mock.config(name).inputSchema?.["action"]
      const publicActions = enumValuesOf(actionSchema)
      expect(publicActions, `${name} must expose an action enum`).not.toEqual([])
      expect(
        [...(helpActionsByTool.get(name) ?? [])].sort(),
        `${name} help recipes must match the registered public action enum`
      ).toEqual([...publicActions].sort())
    }

    expect([...helpActionsByTool.keys()].sort()).toEqual(mock.names().sort())

    const profileVariants = [
      { label: "fallback", services: makeServices() },
      {
        label: "default@1.0.0",
        services: makeServices({
          profile: resolveProfileFromConfig({ profile: "default@1.0.0" }),
        }),
      },
      {
        label: "support@1.0.0",
        services: makeServices({
          profile: resolveProfileFromConfig({ profile: "support@1.0.0" }),
        }),
      },
    ]

    for (const { label, services } of profileVariants) {
      const profileMock = registerAll(services as never)
      for (const recipe of HELP_RECIPES) {
        const result = validateAgainstInputSchema(
          profileMock.config(recipe.tool).inputSchema,
          recipe.example
        )
        expect(
          result.success,
          `${label}: ${recipe.tool} action='${recipe.action}' example must validate against the registered MCP input schema`
        ).toBe(true)
      }
    }
  })

  // -----------------------------------------------------------------------
  // Polymorphic-tool prompt-economy budgets.
  //
  // The registered polymorphic dispatchers are the only MCP tool surface,
  // so these ceilings guard against a future PR quietly appending an
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
    registerPinnedTools(mock.server, services)
    registerQueryTools(mock.server, services)
    registerKnowledgeTools(mock.server, services)
    registerDecisionTools(mock.server, services)
    registerProjectTools(mock.server, services)
    registerTaskTools(mock.server, services)
    registerProcedureTools(mock.server, services)

    // Per-tool description ceiling. Generous to current values — a real
    // new action can land within this budget. The intent is to catch
    // a paragraph-of-narration regression, not to police phrasing.
    //
    // Bumped from 1100 → 1750 in 0.7.0/14: the previous ceiling left
    // ~22 chars of headroom on `lore-task` (1078 chars at 4 actions),
    // and adding the 5th action (`reconcile`) plus its bullet pushed
    // past the boundary. Per the original comment the budget should
    // sit ~25% above current registration; the post-#14 lore-task
    // description is ~1383 chars, so 1750 (≈ 1.265 × 1383) restores
    // the original ~25% headroom posture and leaves room for one more
    // action without inviting a paragraph of narration. The earlier
    // 1400 number left only ~17 chars of headroom — the next action
    // would have tripped this on the same day it landed.
    //
    // Bumped 1750 → 1950 in #282 to absorb the `lore-memory`
    // cross-reference paragraph pointing pinned-block users at the
    // new `lore-pinned` family AND tighten the `update` bullet with
    // the MemoryReadOnlyError contract. The +200 chars stack against
    // the sibling fine-grained `PER_TOOL_DESCRIPTION_LIMITS` map
    // below, which retains the same 1900 entry for `lore-memory`
    // (per-tool detection of lopsided growth across the surface).
    const PER_TOOL_DESCRIPTION_LIMIT = 2050
    const polymorphic = [
      "lore-context",
      "lore-memory",
      "lore-pinned",
      "lore-query",
      "lore-fact",
      "lore-decision",
      "lore-project",
      "lore-task",
      "lore-procedure",
    ]
    for (const name of polymorphic) {
      const desc = mock.description(name)
      expect(
        desc.length,
        `${name} description (${desc.length} chars) exceeds the ${PER_TOOL_DESCRIPTION_LIMIT}-char per-tool budget`
      ).toBeLessThanOrEqual(PER_TOOL_DESCRIPTION_LIMIT)
    }
  })

  it("the polymorphic tools' descriptions sum stays within the combined budget", () => {
    const mock = createMockServer()
    const services = makeServices() as never
    registerContextTools(mock.server, services)
    registerMemoryTools(mock.server, services)
    registerPinnedTools(mock.server, services)
    registerQueryTools(mock.server, services)
    registerKnowledgeTools(mock.server, services)
    registerDecisionTools(mock.server, services)
    registerProjectTools(mock.server, services)
    registerTaskTools(mock.server, services)
    registerProcedureTools(mock.server, services)

    // Combined ceiling across every registered polymorphic tool's
    // description string. The budget exists so a contributor cannot
    // quietly grow per-tool descriptions enough to re-inflate every
    // reconnecting session's prompt — the same pressure the alias
    // purge originally addressed. The ceiling holds ~25% headroom
    // above current registered usage; an action-sized add (≤ ~300
    // chars) lands without a bump, while a family-add (a new
    // dispatcher with multiple actions) or a critical-rule block
    // pushed onto an existing description must bump this ceiling
    // explicitly and document why in the same change.
    // Bumped 11050 → 11450 (+400) for the lore-query "retrieve-first"
    // framing paragraph. The added wording instructs agents to call
    // `action: 'search'` (and `action: 'ask'` when an entity is named)
    // BEFORE abstaining — closes the failure mode where a model with
    // weak tool-use propensity (e.g. gpt-4o-mini under the bench)
    // reads the question, decides "I don't know," and never tries
    // retrieval. Production agents also benefit from the same
    // posture against in-context guessing. Per-tool ceiling for
    // lore-query also bumped 1340 → 1580 below.
    const TOTAL_POLYMORPHIC_DESCRIPTION_LIMIT = 11450
    const polymorphic = [
      "lore-context",
      "lore-memory",
      "lore-pinned",
      "lore-query",
      "lore-fact",
      "lore-decision",
      "lore-project",
      "lore-task",
      "lore-procedure",
    ]
    const total = polymorphic.reduce(
      (sum, name) => sum + mock.description(name).length,
      0
    )
    expect(
      total,
      `combined polymorphic description size (${total} chars) exceeds the ${TOTAL_POLYMORPHIC_DESCRIPTION_LIMIT}-char budget`
    ).toBeLessThanOrEqual(TOTAL_POLYMORPHIC_DESCRIPTION_LIMIT)
  })

  it("each polymorphic tool's description string stays within its per-tool envelope", () => {
    // Per-tool description ceiling — the mechanical enforcement of
    // the "≤ ~200 chars per single-action-add" envelope documented
    // in the combined-budget comment above. The combined ceiling
    // catches across-the-board creep where every description grew
    // slightly; this per-tool ceiling catches one tool absorbing a
    // paragraph of unstructured commentary on a single bullet.
    // Without the per-tool gate, a single 300+ char addition could
    // land under the combined budget and never trip a check.
    //
    // Ceilings are current observed length + ~150 char headroom per
    // tool. A contributor who hits a ceiling must (a) bump the
    // tool's mapped ceiling here AND (b) bump the combined ceiling
    // above, forcing an explicit acknowledgment of the new size and
    // a comment noting what was added. A budget bump comment that
    // isn't paired with a per-tool ceiling bump means the addition
    // landed entirely on a single tool — usually a sign that a
    // different tool's description should have absorbed the new
    // content (e.g., approve/reject went on `lore-memory`, not on
    // `lore-context`).
    const mock = createMockServer()
    const services = makeServices() as never
    registerContextTools(mock.server, services)
    registerMemoryTools(mock.server, services)
    registerPinnedTools(mock.server, services)
    registerQueryTools(mock.server, services)
    registerKnowledgeTools(mock.server, services)
    registerDecisionTools(mock.server, services)
    registerProjectTools(mock.server, services)
    registerTaskTools(mock.server, services)
    registerProcedureTools(mock.server, services)

    // Current observed lengths (post-#550 / 0.13.1 SCOPE RULE block
    // + issue #282 lore-pinned family):
    // lore-context: 1087, lore-memory: 1775, lore-query: 1038,
    // lore-fact: 1233, lore-decision: 848, lore-project: 323,
    // lore-task: 1704, lore-pinned: 880. Each ceiling is
    // `current + ~150 chars` — accommodates one single-action-add at
    // the documented envelope before the test fails LOUDLY and
    // forces the contributor to bump the entry here AND the combined
    // ceiling above.
    //
    // `lore-procedure` carries the propose/scan-candidates/deprecate
    // actions with a paragraph framing the propose-then-approve safety
    // gate so agents see the contract alongside the action list. The
    // per-tool ceiling is set to match the per-tool envelope discipline
    // with comfortable headroom.
    //
    // Sum of per-tool ceilings deliberately exceeds the combined
    // `TOTAL_POLYMORPHIC_DESCRIPTION_LIMIT` so the
    // combined ceiling stays the real envelope; per-tool ceilings
    // exist to catch lopsided growth (one tool absorbs all the
    // additions while the others stay quiet — hides the growth from
    // the combined-bump bookkeeping). Keep the two numbers in sync
    // when bumping either: a future combined-ceiling raise should
    // confirm the sum-of-ceilings still has headroom (or bump
    // individual entries alongside).
    //
    // `lore-memory` bumped 1520 → 1900 in #282 to absorb the
    // cross-reference paragraph pointing pinned-block users at the
    // new `lore-pinned` family AND a tightened wording on the
    // `update` bullet noting the MemoryReadOnlyError contract. The
    // +255 chars keep `lore-memory` as the largest mutator surface
    // without inviting a paragraph of unstructured commentary.
    // `lore-pinned` sized at 1330 — current ~1180 plus headroom.
    // The description carries load-bearing security framing on
    // `force: true` ("stop-sign visible in the audit trail, NOT
    // an access-control gate"), an explicit "Audience is render
    // metadata, not authorization" sentence on the `list` bullet,
    // and an `includeAllAudiences` clarification on the same.
    // Each clause is load-bearing — trimming them would
    // re-introduce the access-control misconception that the
    // wording exists to prevent.
    const PER_TOOL_DESCRIPTION_LIMITS: Record<string, number> = {
      "lore-context": 1240,
      // 1520 → 1720 to absorb the `lore-memory action='promote'`
      // bullet (issue #286). 1720 → 2050 after merging issue
      // #282 onto the post-#286 head: the pinned cross-reference
      // paragraph + tightened `update`-bullet MemoryReadOnlyError
      // wording stack on top of the promote bullet. Both deltas
      // keep `lore-memory` as the largest mutator surface
      // without inviting a paragraph of unstructured commentary.
      "lore-memory": 2050,
      // `lore-pinned` lands fresh at 1330 — current ~1180 plus
      // the ~150-char headroom envelope. Description carries
      // load-bearing security framing on `force` / `audience`.
      "lore-pinned": 1330,
      // Issue #284 — bumped 1190 → 1340 to absorb the
      // `lore-query action='ask'` asOf / includeHistory bullet.
      // Bumped 1340 → 1580 to absorb the "retrieve-first" framing
      // paragraph instructing agents to call `action: 'search'`
      // (and `action: 'ask'` when an entity is named) BEFORE
      // abstaining — closes the LongMemEval failure mode where
      // gpt-4o-mini reads the question, decides "I don't know,"
      // and never tries retrieval. Production agents benefit from
      // the same posture against in-context guessing.
      "lore-query": 1580,
      // Issue #284 — bumped 1390 → 1440 to absorb the
      // `Invalidated At` / `Invalidated By` mention on
      // `lore-fact action='invalidate'` and the new `sourceMemoryId`
      // describe clause; bumped 1440 → 1540 for R3 nit (confidence-
      // decrement side-effect note on the `invalidate` action so
      // agents see the DEFERRED-02 / 0.8.0/#06 downstream signal).
      "lore-fact": 1540,
      "lore-decision": 1000,
      "lore-project": 480,
      "lore-task": 1850,
      // Carries the propose / scan-candidates / deprecate action
      // bullets plus a propose-then-approve safety-gate paragraph
      // so agents see the contract alongside the action list. The
      // envelope sits ~150 chars above current registered length,
      // matching the per-tool headroom discipline.
      "lore-procedure": 1300,
    }
    for (const [name, limit] of Object.entries(PER_TOOL_DESCRIPTION_LIMITS)) {
      const length = mock.description(name).length
      expect(
        length,
        `${name} description (${length} chars) exceeds the ${limit}-char per-tool envelope. ` +
          `If this is intentional (a new action / required schema signal), bump the ` +
          `entry in PER_TOOL_DESCRIPTION_LIMITS AND the combined TOTAL_POLYMORPHIC_DESCRIPTION_LIMIT, ` +
          `and add a paired bump-history bullet to the combined-ceiling comment above.`
      ).toBeLessThanOrEqual(limit)
    }
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
    registerPinnedTools(mock.server, services)
    registerQueryTools(mock.server, services)
    registerKnowledgeTools(mock.server, services)
    registerDecisionTools(mock.server, services)
    registerProjectTools(mock.server, services)
    registerTaskTools(mock.server, services)
    registerProcedureTools(mock.server, services)

    // Per-tool full-config ceiling. `lore-memory` is the current
    // largest at ~5000 chars rendered (its 6 actions plus the 0.9.0
    // topic-key + compare workstreams pushed it past `lore-decision`).
    // 0.10.0/DEFERRED-ATTRIBUTION added the `author` parameter to the
    // save action; budget bumped from 5000 → 5200 to absorb that and
    // leave ~30% headroom for a future action without inviting a
    // paragraph of unstructured commentary in any param description.
    // Issue #281 Phase 4 bumped 5200 → 5700 for the `approve` / `reject`
    // inbox-review actions plus their `reviewer` parameter; the +500
    // chars cover two new discriminated-union branches and one new
    // input field on `lore-memory` without leaking elsewhere.
    // Issue #283 bumped 5700 → 6000 for the `scope` parameter on
    // save/update — one new structured field with five sub-properties
    // (kind/key/audience/lifetime/expiresAt) plus a single combined
    // describe() that names the closed enums for kind and lifetime so
    // agents can pick a value without consulting docs. The +300
    // headroom absorbs the rendered Zod object schema (per-property
    // type strings + nullable/optional decorations) without leaking
    // elsewhere. Issue #286 bumped 6000 → 6400 for the
    // `action='promote'` branch — one new discriminated-union member
    // (`memoryId` / `targetName` / `reason` / `promoter`) plus two
    // new input-schema fields (`targetName`, `promoter`) and the
    // matching `action` enum entry. PR #589 review bumped
    // 6400 → 6600 to absorb the audit-forgery defense (the
    // `promoter` field was dropped from the schema, but the
    // `dryRun` parameter description carries ~250 chars of
    // rationale for why the MCP equivalent of `--dry-run` exists)
    // plus the longer `targetName` describe text covering the
    // configured-list error contract. Issue #282 bumped 6600 →
    // 6900 for the lore-memory cross-reference paragraph
    // pointing pinned-block users at `lore-pinned` plus a
    // tightened wording on the `update` bullet noting the
    // MemoryReadOnlyError contract. `lore-pinned` lives in its
    // own file and stays within the same per-tool budget.
    // Future actions should continue stacking the budget
    // explicitly.
    const PER_TOOL_CONFIG_LIMIT = 6900
    const polymorphic = [
      "lore-context",
      "lore-memory",
      "lore-pinned",
      "lore-query",
      "lore-fact",
      "lore-decision",
      "lore-project",
      "lore-task",
      "lore-procedure",
    ]
    for (const name of polymorphic) {
      const size = mock.renderedSize(name)
      expect(
        size,
        `${name} rendered config size (${size} chars) exceeds the ${PER_TOOL_CONFIG_LIMIT}-char per-tool budget`
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
      expect.objectContaining({ synopsis: "One-liner" })
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
      expect.objectContaining({ synopsis: "Refined" })
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
    registerDecisionTools(mock.server, makeServices({ decisionsCreate }) as never)
    await mock.get("lore-decision")({
      action: "create",
      decision: "Cache resolutions",
      rationale: "long form",
      synopsis: "Resolved projects cached for 60s.",
    } as never)
    expect(decisionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        synopsis: "Resolved projects cached for 60s.",
      })
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
    registerTaskTools(mock.server, makeServices({ tasksCreate, tasksUpdate }) as never)

    await mock.get("lore-task")({
      action: "create",
      subject: "Rotate keys",
      synopsis: "Rotate keys for new env.",
    } as never)
    expect(tasksCreate).toHaveBeenCalledWith(
      expect.objectContaining({ synopsis: "Rotate keys for new env." })
    )

    await mock.get("lore-task")({
      action: "update",
      taskId: "t1",
      synopsis: "Updated synopsis",
    } as never)
    expect(tasksUpdate).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ synopsis: "Updated synopsis" })
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
      expect(
        isError(result),
        `${tool} ${args.action} should reject overcap synopsis`
      ).toBe(true)
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
        `${tool} inputSchema must declare a synopsis field`
      ).toBe(true)
    }
  })
})
