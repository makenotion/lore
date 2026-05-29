import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { recordNotionRead, recordNotionWrite } from "../core/cost-accounting.js"
import { readLedgerEvents, resolveCostTracking } from "../core/cost-ledger.js"
import type { LoreServices } from "../services.js"
import type { DecisionSummary, Fact, Memory, TaskSummary } from "../types.js"
import {
  installCostTrackingToolWrapper,
  runMcpInvocationWithCostTracking,
} from "./cost-tracking.js"
import { registerContextTools } from "./tools/context.js"
import { registerDecisionTools } from "./tools/decisions.js"
import { registerKnowledgeTools } from "./tools/knowledge.js"
import { registerMemoryTools } from "./tools/memory.js"
import { registerPinnedTools } from "./tools/pinned.js"
import { registerProcedureTools } from "./tools/procedures.js"
import { registerProjectTools } from "./tools/project.js"
import { registerQueryTools } from "./tools/query.js"
import { registerTaskTools } from "./tools/tasks.js"

const appendCostEventMock = vi.hoisted(() => vi.fn())

vi.mock("../core/cost-ledger.js", async () => {
  const actual = await vi.importActual<typeof import("../core/cost-ledger.js")>(
    "../core/cost-ledger.js"
  )
  appendCostEventMock.mockImplementation(actual.appendCostEvent)
  return {
    ...actual,
    appendCostEvent: appendCostEventMock,
  }
})

type Handler = (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>

type ToolConfig = {
  inputSchema?: Record<string, unknown>
  [key: string]: unknown
}

describe("MCP cost tracking", () => {
  const dirs: string[] = []
  const originalEnv = {
    agentName: process.env["LORE_AGENT_NAME"],
    sessionId: process.env["LORE_SESSION_ID"],
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    restoreEnv("LORE_AGENT_NAME", originalEnv.agentName)
    restoreEnv("LORE_SESSION_ID", originalEnv.sessionId)
    appendCostEventMock.mockClear()
  })

  it("runs disabled invocations without appending ledger rows or touching ledger files", async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-mcp-cost-"))
    dirs.push(root)
    const ledgerPath = join(root, "state", "ledger.jsonl")
    const costTracking = resolveCostTracking(
      { costTracking: { enabled: false, ledgerPath: "state/ledger.jsonl" } },
      root
    )
    const services = {
      costTracking,
      context: { project: { name: "Project" } },
    } as unknown as LoreServices
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    try {
      const result = await runMcpInvocationWithCostTracking(
        services,
        "lore-memory",
        { action: "save", title: "ignored while disabled" },
        async () => {
          recordNotionRead()
          recordNotionWrite()
          return {
            content: [{ type: "text", text: "visible response" }],
            costOutputs: { memoriesCreated: 1 },
          }
        }
      )

      expect(result).toEqual({
        content: [{ type: "text", text: "visible response" }],
        costOutputs: { memoriesCreated: 1 },
      })
      expect(await readLedgerEvents(costTracking)).toEqual([])
      expect(appendCostEventMock).not.toHaveBeenCalled()
      expect(existsSync(join(root, "state"))).toBe(false)
      expect(existsSync(ledgerPath)).toBe(false)
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      stderr.mockRestore()
    }
  })

  it("records every registered MCP action enum value without a separate allowlist", async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-mcp-cost-"))
    dirs.push(root)
    const costTracking = resolveCostTracking(
      { costTracking: { enabled: true, ledgerPath: "ledger.jsonl" } },
      root
    )
    const services = {
      costTracking,
      context: { project: { name: "Project" } },
    } as unknown as LoreServices
    const mock = createMockServer()

    installCostTrackingToolWrapper(mock.server, services)
    registerContextTools(mock.server, services)
    registerMemoryTools(mock.server, services)
    registerPinnedTools(mock.server, services)
    registerQueryTools(mock.server, services)
    registerProjectTools(mock.server, services)
    registerKnowledgeTools(mock.server, services)
    registerDecisionTools(mock.server, services)
    registerTaskTools(mock.server, services)
    registerProcedureTools(mock.server, services)

    const expectedPairs: string[] = []
    for (const name of mock.names()) {
      const actions = enumValuesOf(mock.config(name).inputSchema?.["action"])
      expect(actions, `${name} must expose a string action enum`).not.toEqual([])
      for (const action of actions) {
        expectedPairs.push(`${name}/${action}`)
        await mock.invoke(name, { action }).catch(() => undefined)
      }
    }

    const rows = await readLedgerEvents(costTracking)
    const seenPairs = new Set(
      rows.map((row) => {
        expect(row.event.eventType).toBe("mcp.invocation")
        const event = row.event as { tool: string; action?: string }
        return `${event.tool}/${event.action ?? ""}`
      })
    )
    expect(seenPairs).toEqual(new Set(expectedPairs))
    expect(rows).toHaveLength(expectedPairs.length)
    for (const row of rows) {
      const event = row.event as { action?: unknown }
      expect(event.action, row.line).toBeTypeOf("string")
    }
  })

  it("logs serialized argument-envelope byte metrics without changing tool results", async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-mcp-cost-"))
    dirs.push(root)
    const costTracking = resolveCostTracking(
      { costTracking: { enabled: true, ledgerPath: "ledger.jsonl" } },
      root
    )
    const services = {
      costTracking,
      context: { project: { name: "Project" } },
    } as unknown as LoreServices
    process.env["LORE_AGENT_NAME"] = "TrustedAgent"
    process.env["LORE_SESSION_ID"] = "trusted-session"
    const args = {
      action: "save",
      projectName: "secret project scope",
      agent: "secret agent prompt",
      session: "secret session prompt",
      title: "secret title",
      content: "secret body",
    }

    const result = await runMcpInvocationWithCostTracking(
      services,
      "lore-memory",
      args,
      async () => {
        recordNotionRead()
        recordNotionWrite()
        return {
          content: [{ type: "text", text: "visible response" }],
          costOutputs: { memoriesCreated: 1 },
        }
      },
      actionSets({ "lore-memory": ["save"] })
    )

    expect(result.content[0]!.text).toBe("visible response")
    expect(costTracking.enabled).toBe(true)
    const rows = await readLedgerEvents(costTracking)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event).toMatchObject({
      eventType: "mcp.invocation",
      tool: "lore-memory",
      action: "save",
      status: "success",
      payload: {
        inputBytes: Buffer.byteLength(JSON.stringify(args), "utf8"),
        estimatedInputTokens: Math.ceil(
          Buffer.byteLength(JSON.stringify(args), "utf8") / 4
        ),
        redacted: true,
        tokenEstimator: "chars_per_token_4",
      },
      notion: { reads: 1, writes: 1 },
      outputs: { memoriesCreated: 1 },
      projectName: "Project",
      agentName: "TrustedAgent",
      sessionId: "trusted-session",
    })
    expect(rows[0]!.event).not.toMatchObject({
      projectName: "secret project scope",
      agentName: "secret agent prompt",
      sessionId: "secret session prompt",
    })
    expect(rows[0]!.line).not.toContain("secret title")
    expect(rows[0]!.line).not.toContain("secret project scope")
    expect(rows[0]!.line).not.toContain("secret agent prompt")
    expect(rows[0]!.line).not.toContain("secret session prompt")
    expect(rows[0]!.line).not.toContain("visible response")
  })

  it("scrubs and caps env-sourced metadata before writing ledger rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-mcp-cost-"))
    dirs.push(root)
    const costTracking = resolveCostTracking(
      { costTracking: { enabled: true, ledgerPath: "ledger.jsonl" } },
      root
    )
    const services = {
      costTracking,
      context: { project: { name: "Project" } },
    } as unknown as LoreServices
    process.env["LORE_AGENT_NAME"] = `Agent\t${"A".repeat(10_000)}\ntrailing`
    process.env["LORE_SESSION_ID"] = "\u2028session\tvalue\u009f"

    await runMcpInvocationWithCostTracking(
      services,
      "lore-context",
      { action: "status" },
      async () => ({
        content: [{ type: "text", text: "visible response" }],
      })
    )

    const rows = await readLedgerEvents(costTracking)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event.agentName).toBe(`Agent ${"A".repeat(193)}…`)
    expect(rows[0]!.event.agentName).toHaveLength(200)
    expect(rows[0]!.event.sessionId).toBe("session value")
    // eslint-disable-next-line no-control-regex
    expect(rows[0]!.event.agentName).not.toMatch(/[\x00-\x1F\x7F-\x9F\u2028\u2029]/)
    // eslint-disable-next-line no-control-regex
    expect(rows[0]!.event.sessionId).not.toMatch(/[\x00-\x1F\x7F-\x9F\u2028\u2029]/)
  })

  it("omits env-sourced metadata that is empty after sanitization", async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-mcp-cost-"))
    dirs.push(root)
    const costTracking = resolveCostTracking(
      { costTracking: { enabled: true, ledgerPath: "ledger.jsonl" } },
      root
    )
    const services = {
      costTracking,
      context: { project: { name: "Project" } },
    } as unknown as LoreServices
    process.env["LORE_AGENT_NAME"] = "\u0000\t\n\u007f\u009f\u2028"
    process.env["LORE_SESSION_ID"] = "\r\u2029"

    await runMcpInvocationWithCostTracking(
      services,
      "lore-context",
      { action: "status" },
      async () => ({
        content: [{ type: "text", text: "visible response" }],
      })
    )

    const rows = await readLedgerEvents(costTracking)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event).not.toHaveProperty("agentName")
    expect(rows[0]!.event).not.toHaveProperty("sessionId")
  })

  it("records wake-up rendered row counts for every returned row type", async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-mcp-cost-"))
    dirs.push(root)
    const costTracking = resolveCostTracking(
      { costTracking: { enabled: true, ledgerPath: "ledger.jsonl" } },
      root
    )
    const services = makeWakeUpServices(costTracking, {
      facts: [
        makeFact({
          id: "fact-1",
          subject: "CostSubject",
          predicate: "uses",
          object: "CostObject",
        }),
      ],
      proposedDecisions: [
        makeDecisionSummary({
          id: "decision-1",
          title: "Cost decision",
          status: "proposed",
        }),
      ],
      tasks: [
        makeTask({
          id: "task-1",
          title: "Cost task",
        }),
      ],
    })
    const mockServer = createMockServer()

    installCostTrackingToolWrapper(mockServer.server, services)
    registerContextTools(mockServer.server, services)

    const result = await mockServer.handler("lore-context")({
      action: "wake-up",
      limit: 1,
    } as never)

    expect(extractText(result)).toContain("Wake-up cost fixture")
    expect(extractText(result)).toContain("**CostSubject** uses **CostObject**")
    expect(extractText(result)).toContain("Cost decision")
    expect(extractText(result)).toContain("Cost task")
    const rows = await readLedgerEvents(costTracking)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event).toMatchObject({
      eventType: "mcp.invocation",
      tool: "lore-context",
      action: "wake-up",
      status: "success",
      outputs: {
        memoriesReturned: 1,
        factsReturned: 1,
        decisionsReturned: 1,
        tasksReturned: 1,
      },
    })
  })

  it("records explicit zero wake-up rendered row counts", async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-mcp-cost-"))
    dirs.push(root)
    const costTracking = resolveCostTracking(
      { costTracking: { enabled: true, ledgerPath: "ledger.jsonl" } },
      root
    )
    const services = makeWakeUpServices(costTracking, { memories: [] })
    const mockServer = createMockServer()

    installCostTrackingToolWrapper(mockServer.server, services)
    registerContextTools(mockServer.server, services)

    const result = await mockServer.handler("lore-context")({
      action: "wake-up",
    } as never)

    expect(extractText(result)).toContain("No memories found for this context.")
    const rows = await readLedgerEvents(costTracking)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event).toMatchObject({
      eventType: "mcp.invocation",
      tool: "lore-context",
      action: "wake-up",
      status: "success",
      outputs: {
        memoriesReturned: 0,
        factsReturned: 0,
        decisionsReturned: 0,
        tasksReturned: 0,
      },
    })
  })

  it("does not copy raw MCP metadata into error rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-mcp-cost-"))
    dirs.push(root)
    const costTracking = resolveCostTracking(
      { costTracking: { enabled: true, ledgerPath: "ledger.jsonl" } },
      root
    )
    const services = {
      costTracking,
      context: { project: { name: "Project" } },
    } as unknown as LoreServices

    await expect(
      runMcpInvocationWithCostTracking(
        services,
        "lore-memory",
        {
          action: "secret action prompt",
          projectName: "secret project prompt",
          agent: "secret agent prompt",
          session: "secret session prompt",
        },
        async () => {
          throw new Error("validation failed")
        },
        actionSets({ "lore-memory": ["save"] })
      )
    ).rejects.toThrow("validation failed")

    const rows = await readLedgerEvents(costTracking)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event).toMatchObject({
      eventType: "mcp.invocation",
      tool: "lore-memory",
      status: "error",
      projectName: "Project",
    })
    expect(rows[0]!.event).not.toHaveProperty("action")
    expect(rows[0]!.event).not.toHaveProperty("agentName")
    expect(rows[0]!.event).not.toHaveProperty("sessionId")
    expect(rows[0]!.line).not.toContain("secret action prompt")
    expect(rows[0]!.line).not.toContain("secret project prompt")
    expect(rows[0]!.line).not.toContain("secret agent prompt")
    expect(rows[0]!.line).not.toContain("secret session prompt")
  })

  it("omits non-string action values from ledger rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-mcp-cost-"))
    dirs.push(root)
    const costTracking = resolveCostTracking(
      { costTracking: { enabled: true, ledgerPath: "ledger.jsonl" } },
      root
    )
    const services = {
      costTracking,
      context: { project: { name: "Project" } },
    } as unknown as LoreServices

    await runMcpInvocationWithCostTracking(
      services,
      "lore-memory",
      { action: 123 },
      async () => ({ content: [{ type: "text", text: "visible response" }] }),
      actionSets({ "lore-memory": ["save"] })
    )

    const rows = await readLedgerEvents(costTracking)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event).not.toHaveProperty("action")
  })
})

function extractText(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]!.text
}

interface WakeUpCostFixtureOverrides {
  memories?: Memory[]
  facts?: Fact[]
  proposedDecisions?: DecisionSummary[]
  overdueDecisions?: DecisionSummary[]
  tasks?: TaskSummary[]
}

function makeMemory(id: string, overrides: Partial<Memory> = {}): Memory {
  return {
    id,
    title: `Memory ${id}`,
    projectIds: ["project-1"],
    topicId: null,
    source: "manual",
    kind: "note",
    status: "informational",
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
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
    ...overrides,
  }
}

function makeFact(overrides: Partial<Fact> & { id: string }): Fact {
  return {
    subject: "Subject",
    predicate: "uses",
    object: "Object",
    projectIds: ["project-1"],
    validFrom: null,
    validUntil: null,
    reviewBy: null,
    sourceMemoryId: null,
    confidence: "likely",
    lastReferencedAt: null,
    createdAt: "2026-05-16T00:00:00.000Z",
    subjectEntityId: null,
    objectEntityId: null,
    ...overrides,
  }
}

function makeDecisionSummary(
  overrides: Partial<DecisionSummary> & { id: string }
): DecisionSummary {
  return makeMemory(overrides.id, {
    kind: "decision",
    status: "accepted",
    decidedAt: "2026-05-16",
    title: overrides.title ?? `Decision ${overrides.id}`,
    ...overrides,
  }) as unknown as DecisionSummary
}

function makeTask(overrides: Partial<TaskSummary> & { id: string }): TaskSummary {
  return makeMemory(overrides.id, {
    kind: "task",
    taskState: "open",
    title: overrides.title ?? `Task ${overrides.id}`,
    ...overrides,
  }) as unknown as TaskSummary
}

function makeWakeUpServices(
  costTracking: LoreServices["costTracking"],
  overrides: WakeUpCostFixtureOverrides = {}
): LoreServices {
  const memories = overrides.memories ?? [
    makeMemory("mem-1", {
      title: "Wake-up cost fixture",
      synopsis: "Rendered by wake-up.",
    }),
  ]
  const facts = overrides.facts ?? []
  const proposedDecisions = overrides.proposedDecisions ?? []
  const overdueDecisions = overrides.overdueDecisions ?? []
  const tasks = overrides.tasks ?? []
  return {
    costTracking,
    context: {
      project: {
        id: "project-1",
        name: "Fixture",
        path: "fixture",
        description: "",
      },
      isCatchAllFallback: false,
      vault: { pageId: "vault-1" },
    },
    config: { vault: { pageId: "vault-1" }, projects: [] },
    projects: { findByName: vi.fn(async () => null) },
    memories: {
      list: vi.fn(async (opts?: { source?: string; status?: string }) => {
        if (opts?.source === "digest" || opts?.status === "proposed") {
          return { items: [] }
        }
        return { items: memories }
      }),
      search: vi.fn(async () => []),
      getTitleById: vi.fn(async () => null),
      countProposed: vi.fn(async () => ({ total: 0, bySource: {}, byAgent: {} })),
      listPinnedBlocks: vi.fn(async () => []),
      countPinnedBlocks: vi.fn(async () => 0),
      touchOnRead: vi.fn(async () => undefined),
    },
    facts: {
      listRecent: vi.fn(async (opts?: { limit?: number }) => ({
        items: facts.slice(0, opts?.limit),
        hasMore: false,
      })),
      touchOnRead: vi.fn(async () => undefined),
    },
    decisions: {
      list: vi.fn(async (opts?: { status?: string }) => ({
        items: opts?.status === "proposed" ? proposedDecisions : [],
      })),
      queryOverdue: vi.fn(async () => overdueDecisions),
      queryOverdueWindow: vi.fn(async () => ({
        items: overdueDecisions,
        capped: false,
      })),
    },
    tasks: {
      list: vi.fn(async (opts?: { limit?: number }) => ({
        items:
          typeof opts?.limit === "number" && opts.limit >= 0
            ? tasks.slice(0, opts.limit)
            : tasks,
      })),
    },
    scopeContext: {},
    upstreams: [],
  } as unknown as LoreServices
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}

function actionSets(
  valuesByTool: Record<string, readonly string[]>
): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map(
    Object.entries(valuesByTool).map(([tool, values]) => [tool, new Set(values)])
  )
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
    handler(name: string): Handler {
      const handler = handlers.get(name)
      if (!handler) throw new Error(`missing handler for ${name}`)
      return handler
    },
    names(): string[] {
      return Array.from(handlers.keys())
    },
    config(name: string): ToolConfig {
      const config = configs.get(name)
      if (!config) throw new Error(`missing config for ${name}`)
      return config
    },
    invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
      const handler = handlers.get(name)
      if (!handler) throw new Error(`missing handler for ${name}`)
      return handler(args)
    },
  }
}

function enumValuesOf(schema: unknown): string[] {
  let cursor = schema
  for (let i = 0; i < 8; i++) {
    if (!cursor || typeof cursor !== "object") return []
    const def = (cursor as { _def?: { values?: unknown; innerType?: unknown } })._def
    if (
      Array.isArray(def?.values) &&
      def.values.every((value) => typeof value === "string")
    ) {
      return [...def.values]
    }
    if (def?.innerType) {
      cursor = def.innerType
      continue
    }
    return []
  }
  return []
}
