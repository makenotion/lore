import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerContextTools } from "./context.js"
import { RANKED_WAKEUP_LIMITS, loadWakeUpData } from "../../core/wakeup.js"
import type { Fact, Memory, Project, TaskSummary } from "../../types.js"

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
    createdAt: "2026-04-20T00:00:00Z",
    updatedAt: "2026-04-20T00:00:00Z",
    ...overrides,
  }
}

function makeFact(overrides: Partial<Fact> & { id: string }): Fact {
  return {
    subject: "S",
    predicate: "uses",
    object: "O",
    projectIds: [],
    validFrom: null,
    validUntil: null,
    reviewBy: null,
    sourceMemoryId: null,
    confidence: "certain",
    subjectEntityId: null,
    objectEntityId: null,
    ...overrides,
  }
}

function makeTask(overrides: Partial<TaskSummary> & { id: string }): TaskSummary {
  const base: TaskSummary = {
    id: overrides.id,
    title: overrides.title ?? `Task ${overrides.id}`,
    projectIds: [],
    topicId: null,
    source: "manual",
    kind: "task",
    status: "informational",
    confidence: "certain",
    confidenceScore: null,
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
    taskState: "open",
    blockedBy: "",
    entity: overrides.entity ?? "",
    createdAt: "2026-04-20T00:00:00Z",
    updatedAt: "2026-04-20T00:00:00Z",
  }
  return { ...base, ...overrides }
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
    /**
     * Wrap a polymorphic dispatcher in a one-action shim so individual
     * tests can call it with action-specific args alone. The dispatcher's
     * discriminated union still validates the per-action schema.
     */
    getActionHandler(toolName: string, action: string) {
      const handler = handlers.get(toolName)
      if (!handler) throw new Error(`missing handler ${toolName}`)
      return (args: Record<string, unknown>) =>
        handler({ ...args, action } as never)
    },
  }
}

interface WakeServicesOverrides {
  memories?: Memory[]
  digest?: Memory | null
  relatedMemories?: Memory[]
  /**
   * Memories returned when the search query equals `taskQuery`. Lets
   * P3-05 tests distinguish the user-query-seeded task search from the
   * task-entity-seeded related search at the MCP layer (same shape
   * as the data-layer stub in `wakeup.test.ts`).
   */
  taskQuery?: string
  taskMemories?: Memory[]
  facts?: Fact[]
  tasks?: TaskSummary[]
  /**
   * Override the auto-detected project on `services.context.project`.
   * Defaults to a minimal Mail project with no description and `path:
   * "/mail"` to match the pre-issue-18 fixture exactly.
   */
  contextProject?: {
    id: string
    name: string
    path: string
    description?: string
  } | null
  /** Override `services.context.isCatchAllFallback`. Defaults to false. */
  isCatchAllFallback?: boolean
  /** Override `services.config.projects`. Defaults to []. */
  configProjects?: Array<{ name: string; path: string }>
  /** Override `services.projects.findByName`. Used by explicit-projectName tests. */
  findByName?: (name: string) => Promise<unknown>
}

function makeWakeServices(overrides: WakeServicesOverrides = {}) {
  const memoriesList = vi.fn(async (args: { source?: string }) => {
    if (args.source === "digest") {
      return { items: overrides.digest ? [overrides.digest] : [] }
    }
    return { items: overrides.memories ?? [] }
  })
  const memoriesSearch = vi.fn(async (args: { query: string }) => {
    if (
      overrides.taskQuery !== undefined &&
      overrides.taskMemories !== undefined &&
      args.query === overrides.taskQuery
    ) {
      return overrides.taskMemories
    }
    return overrides.relatedMemories ?? []
  })
  const getTitleById = vi.fn(async () => null)
  const factsListRecent = vi.fn(
    async (opts: { limit?: number } = {}) => {
      const all = overrides.facts ?? []
      return { items: all.slice(0, opts.limit), hasMore: false }
    },
  )

  // Default to the same minimal Mail project the pre-issue-18 fixture
  // used. Tests that rely on the project framing block override
  // `contextProject` (e.g. to add a description) and `configProjects`
  // (to populate siblings).
  const defaultProject = { id: "proj-1", name: "Mail", path: "/mail", description: "" }
  const contextProject =
    overrides.contextProject === undefined
      ? defaultProject
      : overrides.contextProject
  const findByName = overrides.findByName
    ? vi.fn(overrides.findByName)
    : vi.fn(async () => null)
  return {
    projects: { findByName },
    memories: {
      list: memoriesList,
      search: memoriesSearch,
      getTitleById,
    },
    facts: {
      listRecent: factsListRecent,
    },
    decisions: {
      list: vi.fn(async () => ({ items: [] })),
      queryOverdue: vi.fn(async () => []),
    },
    tasks: {
      // Honor the caller's `limit` so fixtures larger than the data
      // layer's over-fetch window can authentically simulate
      // saturation. `TaskService.list` clamps at the `limit` it's
      // handed (`tasksFetchLimit` from `loadWakeUpData`); the mock
      // mirrors that posture so the renderer's saturation marker can
      // be exercised end-to-end without a real Notion client.
      list: vi.fn(async (opts?: { limit?: number }) => {
        const all = overrides.tasks ?? []
        const limit = opts?.limit
        const items =
          typeof limit === "number" && limit >= 0 ? all.slice(0, limit) : all
        return { items }
      }),
      countActive: vi.fn(async () => ({
        total: 0,
        overdue: 0,
        stale: 0,
        inProgress: 0,
        blocked: 0,
      })),
      // Typed as `number | null` so test cases can override the stub
      // with a finite count (post-#07 vaults) without TS complaining
      // about the fixed-`null` inference.
      countClosedSince: vi.fn(async (): Promise<number | null> => null),
    },
    context: {
      project: contextProject,
      isCatchAllFallback: overrides.isCatchAllFallback ?? false,
      // `handleStatus` reads `services.context.vault.pageId`. Wake-up
      // doesn't, but the stub serves both surfaces so the field is
      // populated unconditionally.
      vault: { pageId: "vault-1" },
    },
    config: { vault: { pageId: "vault-1" }, projects: overrides.configProjects ?? [] },
    vault: {
      pageId: "vault-1",
      stats: vi.fn(async () => ({
        projects: 0,
        topics: 0,
        memories: 0,
        facts: 0,
      })),
    },
    _calls: {
      memoriesList,
      memoriesSearch,
      factsListRecent,
      findByName,
    },
  }
}

function extractText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content
  return content[0].text
}

describe("lore-wake-up — Part A: title-only by default", () => {
  it("omits memory bodies from the default (non-expand) path", async () => {
    const mockServer = createMockServer()
    const services = makeWakeServices({
      memories: [
        makeMemory("m1", {
          title: "OAuth handshake failure notes",
          content: "# Full body\n\nShould not appear in the default wake-up.",
          tags: ["auth"],
        }),
      ],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    expect(text).toContain("OAuth handshake failure notes")
    expect(text).not.toContain("Full body")
    // Body-off must NOT render the "(no content loaded)" sentinel that
    // pre-P2-01 rendered when content was missing — the absence of a body
    // is the default state now, not an error to surface.
    expect(text).not.toContain("no content loaded")
    // The default path still calls memories.list with includeContent: false
    // so the Notion round-trip stays one page.
    expect(services._calls.memoriesList).toHaveBeenCalledWith(
      expect.objectContaining({ includeContent: false }),
    )
  })

  it("restores full body rendering when expand: true", async () => {
    const mockServer = createMockServer()
    const services = makeWakeServices({
      memories: [
        makeMemory("m1", {
          title: "Expand-me memory",
          content: "The bodies are back.",
        }),
      ],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({ expand: true } as never)

    const text = extractText(result)
    expect(text).toContain("The bodies are back.")
    expect(services._calls.memoriesList).toHaveBeenCalledWith(
      expect.objectContaining({ includeContent: true }),
    )
  })
})

describe("lore-wake-up — Part B: topical dedup", () => {
  it("collapses overlapping memories with a (related: <uuid>) trailer", async () => {
    // Three wake-up debugging sessions with shared tags must collapse to
    // one representative entry (the first-seen) plus an IDs trailer
    // pointing at the collapsed peers. The trailer emits the FULL UUID
    // so agents can `lore-recall` / `lore-get-decision` the peer — a
    // last-8 hint would be reader-only and not agent-actionable.
    const tags = ["hooks", "wakeup", "debugging"]
    const peerId = "2c1ffab4-e67f-8185-bec0-d3902135c5bb"
    const mockServer = createMockServer()
    const services = makeWakeServices({
      memories: [
        makeMemory("3a853ab4-e67f-8185-bec0-d3902135c5ba", {
          title: "Wakeup silent-failure root cause",
          tags,
        }),
        makeMemory(peerId, {
          title: "Wakeup silent-failure debugging followup",
          tags,
        }),
      ],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    expect(text).toContain("Wakeup silent-failure root cause")
    // The collapsed peer should NOT render as its own heading.
    expect(text).not.toContain("Wakeup silent-failure debugging followup")
    // The trailer emits the peer's full Notion UUID so agents can
    // re-fetch it directly — pass the ID to `lore-recall` /
    // `lore-get-decision` to load the peer's body on demand.
    expect(text).toContain(`(related: ${peerId})`)
  })
})

describe("lore-wake-up — Part C: UUID → title resolution", () => {
  it("renders resolved titles in Active Facts instead of raw UUIDs", async () => {
    // The facts section must route every UUID through the P1-05 title
    // resolver. A raw 36-char hex string in wake-up output is the bug
    // P1-05 / P2-01 were both written to eliminate.
    const DECISION_ID = "349b35e6-e67f-8185-bec0-d3902135c5ba"
    const mockServer = createMockServer()
    const services = makeWakeServices({
      facts: [
        makeFact({
          id: "fact-1",
          subject: "AuthService",
          predicate: "decided_by",
          object: DECISION_ID,
        }),
      ],
    })
    services.memories.getTitleById = vi.fn(async (id: string) =>
      id.toLowerCase() === DECISION_ID ? "Adopt OIDC for auth" : null,
    )

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    expect(text).toContain("Adopt OIDC for auth")
    expect(text).not.toContain(DECISION_ID)
  })
})

describe("lore-wake-up — Part D: per-section limits", () => {
  it("forwards knowledgeFactLimit to the listRecent query", async () => {
    const mockServer = createMockServer()
    const services = makeWakeServices({ facts: [] })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    await wake({ knowledgeFactLimit: 3 } as never)

    expect(services._calls.factsListRecent).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3 }),
    )
  })
})

describe("lore-wake-up — expand interacts with collapse", () => {
  it("renders the (related: <uuid>) trailer before the body when expand is true", async () => {
    // Order matters for readability: metadata and the collapse trailer
    // belong on the header line; the body is the payload underneath.
    // An inverted order would make the trailer read like a body footnote.
    const tags = ["hooks", "wakeup", "debugging"]
    const peerId = "2c1ffab4-e67f-8185-bec0-d3902135c5bb"
    const mockServer = createMockServer()
    const services = makeWakeServices({
      memories: [
        makeMemory("3a853ab4-e67f-8185-bec0-d3902135c5ba", {
          title: "Wakeup silent-failure root cause",
          tags,
          content: "Body paragraph for the representative.",
        }),
        makeMemory(peerId, {
          title: "Wakeup silent-failure debugging followup",
          tags,
          content: "Body for a collapsed peer — must not render.",
        }),
      ],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({ expand: true } as never)

    const text = extractText(result)
    const trailerIdx = text.indexOf(`(related: ${peerId})`)
    const bodyIdx = text.indexOf("Body paragraph for the representative.")
    expect(trailerIdx).toBeGreaterThan(-1)
    expect(bodyIdx).toBeGreaterThan(-1)
    expect(trailerIdx).toBeLessThan(bodyIdx)
    // Collapsed peer's body stays suppressed even in expand mode — only
    // the representative's body is rendered. An agent that wants the
    // peer's body re-fetches it via `lore-recall` with the trailer ID.
    expect(text).not.toContain("Body for a collapsed peer")
  })

  it("renders Related Memories at h3 so the markdown tree stays balanced", async () => {
    // Related Memories has no date-bucket sub-head, so entries sit
    // directly under the `## Related Memories` h2 — h3 is the right
    // depth. Recent Memories entries sit under `### Today/Yesterday/Earlier`
    // and must stay at h4.
    const mockServer = createMockServer()
    const services = makeWakeServices({
      memories: [makeMemory("m1", { title: "Recent entry" })],
      tasks: [
        makeTask({
          id: "t1",
          title: "Router migration",
          entity: "Router migration",
        }),
      ],
      relatedMemories: [makeMemory("r1", { title: "Related entry" })],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    // Recent Memories: `## Recent Memories` → `### Today` → `#### Recent entry`
    expect(text).toMatch(/^#### Recent entry/m)
    // Related to Open Loops: `## Related to Open Loops` → `### Related entry`
    expect(text).toMatch(/^### Related entry/m)
  })
})

describe("lore-wake-up — Part E: P3-05 ranked output (userQuery)", () => {
  // The MCP tool is the second surface for ranked wake-up. Hooks ship
  // ranked output via Claude Code's UserPromptSubmit; the MCP tool ships
  // it via an explicit `userQuery` argument that an agent passes after a
  // /clear or session-pivot. Both must produce the same shape so callers
  // get consistent output regardless of which surface they use.

  it("renders 'For Your Current Task' under the digest when userQuery is provided", async () => {
    const mockServer = createMockServer()
    const services = makeWakeServices({
      memories: [makeMemory("m1", { title: "Recent unrelated memory" })],
      taskQuery: "fix outlook auth bug",
      taskMemories: [makeMemory("task-1", { title: "Outlook auth investigation" })],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({ userQuery: "fix outlook auth bug" } as never)

    const text = extractText(result)
    expect(text).toContain("## For Your Current Task")
    expect(text).toContain("Outlook auth investigation")
    // The task section sits ABOVE Recent Memories — relevance hits beat
    // timestamp ordering in priority order.
    const taskIdx = text.indexOf("## For Your Current Task")
    const recentIdx = text.indexOf("## Recent Memories")
    expect(taskIdx).toBeGreaterThan(-1)
    expect(recentIdx).toBeGreaterThan(taskIdx)
  })

  it("omits the task section when userQuery is absent (legacy callers see byte-identical output)", async () => {
    const mockServer = createMockServer()
    const services = makeWakeServices({
      memories: [makeMemory("m1", { title: "Recent memory" })],
      taskQuery: "ignored",
      taskMemories: [makeMemory("should-not-appear", { title: "Hidden hit" })],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    expect(text).not.toContain("For Your Current Task")
    expect(text).not.toContain("Hidden hit")
    // The task search must not even fire when no userQuery is provided —
    // and search shouldn't fire at all here since there are no open loops
    // to seed the related search either.
    expect(services._calls.memoriesSearch).not.toHaveBeenCalled()
  })

  it("omits the task section when taskMemoryLimit: 0 even with a userQuery", async () => {
    // Explicit 0 is the "skip this section" knob — the search isn't
    // fired and the section isn't rendered.
    const mockServer = createMockServer()
    const services = makeWakeServices({
      taskQuery: "fix auth",
      taskMemories: [makeMemory("task-1", { title: "Auth investigation" })],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({
      userQuery: "fix auth",
      taskMemoryLimit: 0,
    } as never)

    const text = extractText(result)
    expect(text).not.toContain("For Your Current Task")
    // The data layer skips the search when the effective limit is zero,
    // so no extra Notion round-trip fires.
    expect(services._calls.memoriesSearch).not.toHaveBeenCalled()
  })

  // PF3-04: per-section caps must match the shell hook's `RANKED_WAKEUP_LIMITS`
  // when a userQuery is provided, otherwise an MCP-direct caller's prompt
  // budget diverges from a Claude Code first-prompt wake-up — the AGENTS.md
  // claim "rendering is the only divergence" only holds if the row counts
  // line up across both surfaces.

  it("applies RANKED_WAKEUP_LIMITS to the knowledge-fact section when userQuery is set", async () => {
    // The data-layer caps for sections that don't run through topical
    // collapse (knowledge facts) should flow straight from
    // RANKED_WAKEUP_LIMITS into the underlying service calls.
    const mockServer = createMockServer()
    const services = makeWakeServices({
      taskQuery: "fix auth",
      taskMemories: [makeMemory("task-1")],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    await wake({ userQuery: "fix auth" } as never)

    expect(services._calls.factsListRecent).toHaveBeenCalledWith(
      expect.objectContaining({ limit: RANKED_WAKEUP_LIMITS.knowledgeFactLimit }),
    )
  })

  it("falls back to surface defaults when userQuery is absent", async () => {
    // Pin the inverse: without userQuery the existing per-section defaults
    // apply, so legacy MCP callers see no change in row counts.
    const mockServer = createMockServer()
    const services = makeWakeServices({})

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    await wake({} as never)

    const knowledgeCall = services._calls.factsListRecent.mock.calls[0]?.[0] as
      | { limit?: number }
      | undefined
    // Default knowledge-fact cap is 25; ranked cap is 10. Without
    // userQuery we keep the looser default.
    expect(knowledgeCall?.limit).not.toBe(RANKED_WAKEUP_LIMITS.knowledgeFactLimit)
  })

  it("respects caller-supplied caps even when userQuery is set", async () => {
    // Explicit args still win over the ranked defaults — the ranked path
    // is "use tighter limits when the caller hasn't told us otherwise."
    const mockServer = createMockServer()
    const services = makeWakeServices({
      taskQuery: "fix auth",
      taskMemories: [makeMemory("task-1")],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    await wake({
      userQuery: "fix auth",
      knowledgeFactLimit: 47,
    } as never)

    expect(services._calls.factsListRecent).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 47 }),
    )
  })

  it("renders the same number of memory rows as the hook for the same input (parity)", async () => {
    // PF3-04 acceptance: when both surfaces fire ranked wake-up against
    // the same input, the visible row counts in each memory section must
    // match. The hook applies RANKED_WAKEUP_LIMITS flat; the MCP path
    // over-fetches by COLLAPSE_OVERFETCH_MULTIPLIER and then slices by
    // cluster — but the final visible counts converge because both
    // surfaces enforce the same ranked cap.

    // Build a fixture with more candidates than any cap so every section
    // saturates: 6 distinct memories (above ranked memoryLimit=3),
    // 6 distinct task hits (above taskMemoryLimit=3). Titles share NO
    // 3+ char tokens so topical collapse is a no-op on the MCP side —
    // this test pins the cap, not the collapse heuristic.
    const recentTitles = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"]
    const taskTitles = ["Quux", "Plugh", "Xyzzy", "Thud", "Wibble", "Wobble"]
    const recentMemories: Memory[] = recentTitles.map((title, i) =>
      makeMemory(`recent-${i}`, {
        title,
        tags: [`uniq-recent-${i}`],
        createdAt: `2026-04-${String(20 - i).padStart(2, "0")}T00:00:00Z`,
      }),
    )
    const taskMemoriesFixture: Memory[] = taskTitles.map((title, i) =>
      makeMemory(`task-${i}`, {
        title,
        tags: [`uniq-task-${i}`],
        createdAt: `2026-03-${String(20 - i).padStart(2, "0")}T00:00:00Z`,
      }),
    )

    // MCP surface
    const mcpServer = createMockServer()
    const mcpServices = makeWakeServices({
      memories: recentMemories,
      taskQuery: "auth bug",
      taskMemories: taskMemoriesFixture,
    })
    registerContextTools(mcpServer.server, mcpServices as never)
    const mcpWake = mcpServer.getActionHandler("lore-context", "wake-up")
    const mcpResult = await mcpWake({ userQuery: "auth bug" } as never)
    const mcpText = extractText(mcpResult)

    // Hook-equivalent surface — drive `loadWakeUpData` directly with the
    // shared RANKED_WAKEUP_LIMITS so any future drift is caught here.
    const hookServices = makeWakeServices({
      memories: recentMemories,
      taskQuery: "auth bug",
      taskMemories: taskMemoriesFixture,
    })
    const hookData = await loadWakeUpData(hookServices as never, {
      projectId: "proj-1",
      userQuery: "auth bug",
      includeMemoryContent: false,
      ...RANKED_WAKEUP_LIMITS,
    })

    // Recent Memories renders one bullet per memory under date buckets
    // (`#### `), and the cluster-slice on the MCP side bounds the visible
    // count at recentCap (= memoryLimit = 3 under ranked). Pin the actual
    // *titles* visible on each surface, not just the count — comparing
    // both sides to a literal constant would be a tautology that wouldn't
    // catch a divergence where MCP picked [Bravo, Delta, Foxtrot] while
    // the hook picked [Alpha, Bravo, Charlie].
    const mcpRecentTitles = recentTitles
      .filter((t) => mcpText.includes(`#### ${t}\n`))
      .sort()
    const hookRecentTitles = hookData.memories.map((m) => m.title).sort()
    expect(mcpRecentTitles).toHaveLength(RANKED_WAKEUP_LIMITS.memoryLimit)
    expect(hookRecentTitles).toHaveLength(RANKED_WAKEUP_LIMITS.memoryLimit)
    expect(mcpRecentTitles).toEqual(hookRecentTitles)

    // For Your Current Task renders one heading per cluster (`### `).
    // Same set-equality check as Recent Memories.
    const mcpTaskTitles = taskTitles.filter((t) => mcpText.includes(`### ${t}\n`)).sort()
    const hookTaskTitles = hookData.taskMemories.map((m) => m.title).sort()
    expect(mcpTaskTitles).toHaveLength(RANKED_WAKEUP_LIMITS.taskMemoryLimit)
    expect(hookTaskTitles).toHaveLength(RANKED_WAKEUP_LIMITS.taskMemoryLimit)
    expect(mcpTaskTitles).toEqual(hookTaskTitles)
  })

  it("dedupes taskMemories against recents and related at the MCP layer", async () => {
    // Same dedupe contract as the hook: a memory rendered in another
    // section must NOT appear under For Your Current Task, even if Notion
    // ranks it as the top relevance hit.
    const mockServer = createMockServer()
    const dupeId = "dupe-1"
    const services = makeWakeServices({
      memories: [makeMemory(dupeId, { title: "Both recent and relevant" })],
      taskQuery: "fix auth",
      taskMemories: [
        makeMemory(dupeId, { title: "Both recent and relevant — dup" }),
        makeMemory("task-fresh", { title: "Fresh task hit" }),
      ],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({ userQuery: "fix auth" } as never)

    const text = extractText(result)
    expect(text).toContain("Fresh task hit")
    // The dupe title appears once in Recent Memories, NOT under For Your
    // Current Task — count matches stay at 1.
    const matches = text.match(/Both recent and relevant/g) ?? []
    expect(matches.length).toBe(1)
  })
})

// Issue 0.6.0/18: project framing block on wake-up.
describe("lore-wake-up — Part F: project framing block (issue 0.6.0/18)", () => {
  it("renders description and siblings under the Project header", async () => {
    const mockServer = createMockServer()
    const services = makeWakeServices({
      memories: [makeMemory("m1", { title: "Recent memory" })],
      contextProject: {
        id: "proj-1",
        name: "Mail",
        path: "apps/mail",
        description: "Notion-backed mail client.",
      },
      configProjects: [
        { name: "Mail", path: "apps/mail" },
        { name: "Web", path: "apps/web" },
        { name: "Desktop", path: "apps/desktop" },
      ],
    })
    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    // Header line still leads — preserves the prior "Project: ..." anchor
    // every existing wake-up test relies on.
    expect(text).toContain("Project: Mail (apps/mail)")
    // Description and siblings sit under the header, indented for grouping.
    expect(text).toContain("  Notion-backed mail client.")
    // Siblings names *peers* — Mail is excluded as the resolved project.
    expect(text).toContain("  Siblings: Web, Desktop.")
    expect(text).not.toContain("Siblings: Mail")
  })

  it("omits the description line when Project.description is empty", async () => {
    // Spec rule: empty Project.description after trim → no synthetic
    // filler. Block degrades to header + Siblings.
    const mockServer = createMockServer()
    const services = makeWakeServices({
      contextProject: {
        id: "proj-1",
        name: "Mail",
        path: "apps/mail",
        description: "",
      },
      configProjects: [
        { name: "Mail", path: "apps/mail" },
        { name: "Web", path: "apps/web" },
      ],
    })
    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    expect(text).toContain("Project: Mail (apps/mail)")
    // Siblings names peers; Mail is excluded as the resolved project.
    expect(text).toContain("  Siblings: Web.")
    // No description line of any kind — no `(no description)` filler etc.
    expect(text).not.toMatch(/^ {2}Notion-backed/m)
  })

  it("omits the Siblings line when no sub-projects are configured", async () => {
    const mockServer = createMockServer()
    const services = makeWakeServices({
      contextProject: {
        id: "proj-1",
        name: "Solo",
        path: "",
        description: "Single-project vault.",
      },
      configProjects: [],
    })
    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    // No path suffix when Project.path is empty.
    expect(text).toMatch(/^Project: Solo$/m)
    expect(text).toContain("  Single-project vault.")
    expect(text).not.toContain("Siblings:")
  })

  it("prepends a catch-all warning when isCatchAllFallback is true", async () => {
    const mockServer = createMockServer()
    const services = makeWakeServices({
      contextProject: {
        id: "proj-mono",
        name: "Monorepo",
        path: ".",
        description: "Whole repo.",
      },
      isCatchAllFallback: true,
      configProjects: [
        { name: "Monorepo", path: "." },
        { name: "Mail", path: "apps/mail" },
        { name: "Web", path: "apps/web" },
      ],
    })
    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    // Lead-in mirrors the save-side warning byte-for-byte (shared via
    // `formatCatchAllScopeSummary` in `src/core/context.ts`); only the
    // call-to-action tail diverges (read tools take `projectName` only).
    expect(text).toContain(
      '> Scoped to catch-all "Monorepo" (monorepo-wide). Sub-projects available: Mail, Web. Pass projectName to scope to a specific sub-project.',
    )
    // Warning sits ABOVE the Project header — block-level warning first.
    const warnIdx = text.indexOf("> Scoped to catch-all")
    const headerIdx = text.indexOf("Project: Monorepo")
    expect(warnIdx).toBeGreaterThan(-1)
    expect(headerIdx).toBeGreaterThan(warnIdx)
  })

  it("describes the explicitly-resolved project when projectName is passed (Fix 2)", async () => {
    // Pinned by issue 0.6.0/18: an agent that passes projectName: "Web"
    // while cwd resolves to apps/mail must see the Web project's context,
    // not Mail's. The framing describes whichever project the rest of
    // the wake-up output is filtered to.
    const webProject: Project = {
      id: "proj-web",
      name: "Web",
      type: "project",
      path: "apps/web",
      status: "active",
      description: "Marketing site.",
    }
    const mockServer = createMockServer()
    const services = makeWakeServices({
      contextProject: {
        id: "proj-mail",
        name: "Mail",
        path: "apps/mail",
        description: "Notion-backed mail client.",
      },
      configProjects: [
        { name: "Mail", path: "apps/mail" },
        { name: "Web", path: "apps/web" },
      ],
      findByName: async (name) => (name === "Web" ? webProject : null),
    })
    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({ projectName: "Web" } as never)

    const text = extractText(result)
    // Header describes the EXPLICIT pick, not the auto-detected project.
    expect(text).toContain("Project: Web (apps/web)")
    expect(text).toContain("  Marketing site.")
    // Mail's description must NOT appear — explicit pick wins.
    expect(text).not.toContain("Notion-backed mail client.")
  })

  it("renders the Tasks summary line on action='status' (issue 0.7.0/13)", async () => {
    // Acceptance criterion: the same `formatTaskSummary` shape the CLI
    // emits also surfaces via `lore-context action='status'`. Pin the
    // line shape so a future divergence between the two surfaces fails
    // here instead of leaking into operator-facing output.
    const mockServer = createMockServer()
    const services = makeWakeServices()
    services.tasks.countActive = vi.fn(async () => ({
      total: 271,
      overdue: 25,
      stale: 89,
      inProgress: 12,
      blocked: 0,
    }))
    services.tasks.countClosedSince = vi.fn(async () => 14)

    registerContextTools(mockServer.server, services as never)
    const status = mockServer.getActionHandler("lore-context", "status")
    const result = await status({} as never)

    const text = extractText(result)
    expect(text).toContain(
      "Tasks: 271 active (overdue: 25, stale ≥30d: 89, in-progress: 12)",
    )
    expect(text).toContain("Closed last 30 days: 14 (rate: 0.47/day)")
  })

  it("suppresses the closure-rate line on action='status' for pre-#07 vaults", async () => {
    // `countClosedSince` returns null when the `Done At` column is
    // missing; the renderer drops the line entirely so the operator
    // doesn't see "Closed last 30 days: 0 (rate: 0.00/day)" misleadingly.
    const mockServer = createMockServer()
    const services = makeWakeServices()
    services.tasks.countActive = vi.fn(async () => ({
      total: 5,
      overdue: 0,
      stale: 0,
      inProgress: 0,
      blocked: 0,
    }))
    services.tasks.countClosedSince = vi.fn(async () => null)

    registerContextTools(mockServer.server, services as never)
    const status = mockServer.getActionHandler("lore-context", "status")
    const result = await status({} as never)

    const text = extractText(result)
    expect(text).toContain("Tasks: 5 active")
    expect(text).not.toContain("Closed last 30 days")
  })

  it("renders the bare 'Tasks: 0 active' line for a task-empty vault", async () => {
    // Empty-vault signal — operator needs explicit confirmation that the
    // surface is wired up, not that the line silently dropped because
    // the count was zero.
    const mockServer = createMockServer()
    const services = makeWakeServices()
    registerContextTools(mockServer.server, services as never)
    const status = mockServer.getActionHandler("lore-context", "status")
    const result = await status({} as never)

    const text = extractText(result)
    expect(text).toContain("Tasks: 0 active")
  })

  it("scopes the Tasks summary to the active project when one is auto-detected", async () => {
    // The MCP path threads `services.context.project?.id` into both
    // counters so a project-scoped agent sees only its own tasks. Pin
    // the projectId pass-through so a future refactor can't silently
    // unscope the queries (which would surface 271 tasks regardless of
    // which sub-project the agent is in).
    const mockServer = createMockServer()
    const services = makeWakeServices()
    const countActive = vi.fn(async () => ({
      total: 0,
      overdue: 0,
      stale: 0,
      inProgress: 0,
      blocked: 0,
    }))
    const countClosedSince = vi.fn(async () => null)
    services.tasks.countActive = countActive
    services.tasks.countClosedSince = countClosedSince

    registerContextTools(mockServer.server, services as never)
    const status = mockServer.getActionHandler("lore-context", "status")
    await status({} as never)

    expect(countActive).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-1" }),
    )
    expect(countClosedSince).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ projectId: "proj-1" }),
    )
  })

  it("explicit projectName forces isCatchAllFallback off even when context was a catch-all", async () => {
    // Auto-detected context could be a catch-all fallback, but if the
    // agent explicitly named a project, we trust the pick — no warning.
    const subProject: Project = {
      id: "proj-mail",
      name: "Mail",
      type: "project",
      path: "apps/mail",
      status: "active",
      description: "Mail.",
    }
    const mockServer = createMockServer()
    const services = makeWakeServices({
      contextProject: {
        id: "proj-mono",
        name: "Monorepo",
        path: ".",
        description: "Whole repo.",
      },
      isCatchAllFallback: true,
      configProjects: [
        { name: "Monorepo", path: "." },
        { name: "Mail", path: "apps/mail" },
      ],
      findByName: async (name) => (name === "Mail" ? subProject : null),
    })
    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({ projectName: "Mail" } as never)

    const text = extractText(result)
    expect(text).toContain("Project: Mail (apps/mail)")
    // No catch-all warning on the explicit-pick path.
    expect(text).not.toContain('> Scoped to catch-all')
  })
})

describe("lore-wake-up — Part G: synopsis rendering (issue 0.7.0/03)", () => {
  // Wake-up's three memory sections (Recent, Related, For-Your-Current-Task)
  // all gain synopsis rendering by default. The digest section is
  // unchanged — the digest IS the content. The `expand: true` opt-in
  // remains additive: synopsis renders on the default path; expand adds
  // bodies on top.

  it("renders the synopsis in the Recent Memories section by default", async () => {
    const mockServer = createMockServer()
    const services = makeWakeServices({
      memories: [
        makeMemory("m1", {
          title: "OAuth handshake notes",
          synopsis: "Outlook callbacks fail because the redirect URI is not allow-listed.",
          tags: ["auth"],
        }),
      ],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    expect(text).toContain(
      "#### OAuth handshake notes\n" +
        "Outlook callbacks fail because the redirect URI is not allow-listed.\n" +
        "*manual | auth | 2026-04-20*",
    )
  })

  it("renders the synopsis in the Related to Active Tasks section by default", async () => {
    const mockServer = createMockServer()
    const services = makeWakeServices({
      tasks: [makeTask({ id: "t1", title: "Router migration", entity: "Router" })],
      relatedMemories: [
        makeMemory("r1", {
          title: "Router migration playbook",
          synopsis: "Three-phase rollout: dual-write, cut over, decommission.",
          tags: ["migration"],
        }),
      ],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    expect(text).toContain(
      "### Router migration playbook\n" +
        "Three-phase rollout: dual-write, cut over, decommission.\n" +
        "*manual | migration | 2026-04-20*",
    )
  })

  it("renders the synopsis in the For Your Current Task section by default", async () => {
    const mockServer = createMockServer()
    const services = makeWakeServices({
      taskQuery: "fix outlook auth bug",
      taskMemories: [
        makeMemory("task-1", {
          title: "Outlook auth investigation",
          synopsis: "Token rotation broke when MS rolled out the v2 endpoint.",
          tags: ["auth"],
        }),
      ],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({ userQuery: "fix outlook auth bug" } as never)

    const text = extractText(result)
    expect(text).toContain(
      "### Outlook auth investigation\n" +
        "Token rotation broke when MS rolled out the v2 endpoint.\n" +
        "*manual | auth | 2026-04-20*",
    )
  })

  it("renders synopsis above the (related: <uuid>) trailer when topical collapse fires", async () => {
    // The shared helper places synopsis between the heading and the
    // italic meta line, so the trailer (added in renderMemoryEntry)
    // sits below the meta line just like it did pre-#03.
    const tags = ["hooks", "wakeup", "debugging"]
    const peerId = "2c1ffab4-e67f-8185-bec0-d3902135c5bb"
    const mockServer = createMockServer()
    const services = makeWakeServices({
      memories: [
        makeMemory("3a853ab4-e67f-8185-bec0-d3902135c5ba", {
          title: "Wakeup silent-failure root cause",
          synopsis: "Token loader silently failed on missing LORE_NOTION_TOKEN.",
          tags,
        }),
        makeMemory(peerId, {
          title: "Wakeup silent-failure debugging followup",
          synopsis: "Peer synopsis that must NOT render — peer is collapsed.",
          tags,
        }),
      ],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    // Representative's synopsis renders.
    expect(text).toContain("Token loader silently failed on missing LORE_NOTION_TOKEN.")
    // Collapsed peer's synopsis stays suppressed — only the
    // representative is rendered, per the topical-collapse contract.
    expect(text).not.toContain("Peer synopsis that must NOT render")
    // Synopsis above trailer above date — pin the order.
    const synopsisIdx = text.indexOf("Token loader silently failed")
    const trailerIdx = text.indexOf(`(related: ${peerId})`)
    expect(synopsisIdx).toBeGreaterThan(-1)
    expect(trailerIdx).toBeGreaterThan(synopsisIdx)
  })

  it("expand=true renders synopsis AND body (additive)", async () => {
    const mockServer = createMockServer()
    const services = makeWakeServices({
      memories: [
        makeMemory("m1", {
          title: "OAuth handshake notes",
          synopsis: "One-line gist.",
          content: "Body paragraph that only renders under expand=true.",
        }),
      ],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({ expand: true } as never)

    const text = extractText(result)
    expect(text).toContain("One-line gist.")
    expect(text).toContain("Body paragraph that only renders under expand=true.")
    // Order: synopsis above body.
    expect(text.indexOf("One-line gist.")).toBeLessThan(
      text.indexOf("Body paragraph"),
    )
  })

  it("makes the same number of memories.list calls regardless of synopsis rendering", async () => {
    // Synopsis rides along on dataSources.query — adding the property
    // to the rendered output does NOT add Notion round-trips.
    const mockServer = createMockServer()
    const services = makeWakeServices({
      memories: [
        makeMemory("m1", { title: "With synopsis", synopsis: "x" }),
        makeMemory("m2", { title: "Without synopsis", synopsis: "" }),
      ],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    await wake({} as never)

    // Pre-#03 wake-up calls memories.list once for the digest probe and
    // once for the recent memories query — two calls total. #03 must
    // not introduce a third.
    expect(services._calls.memoriesList).toHaveBeenCalledTimes(2)
  })
})

describe("lore-wake-up — synopsis is always rendered on wake-up (issue 0.7.0/03 scoping)", () => {
  // Per the spec's scoping rationale, includeSynopsis is a recall/search
  // knob only. Wake-up's dispatch schema does not declare the field, and
  // wake-up's renderer does not consult it — so even a caller that
  // tries to pass includeSynopsis to wake-up should still see synopses.
  // The wake-up audience benefits from synopses by default; the
  // existing `limit: 0` short-circuit covers "I want fewer rows."
  it("renders synopsis even when caller passes includeSynopsis: false (field is dropped, not honored)", async () => {
    const mockServer = createMockServer()
    const services = makeWakeServices({
      memories: [
        makeMemory("m1", {
          title: "Always-rendered synopsis",
          synopsis: "This synopsis must render on wake-up.",
        }),
      ],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")

    const result = await wake({ includeSynopsis: false } as never)
    const text = extractText(result)
    expect(text).toContain("This synopsis must render on wake-up.")
  })
})
describe("lore-wake-up — Part H: stale-task bucketing (issue 0.7.0/12)", () => {
  // Pre-#12 the Tasks section was a flat list capped at 10. Real vaults
  // accumulated dead work that rendered identically to live work — no
  // staleness signal, no closure CTA. #12 splits the section into
  // Overdue / Stale / Active sub-buckets and emits an inline closure
  // CTA on every row.
  //
  // `now` for these tests is implicit via `new Date()` inside
  // `handleWakeUp`. Every fixture timestamp is computed relative to
  // wall-clock so the bucketing stays correct regardless of when the
  // test runs. `daysAgo()` returns a full ISO timestamp;
  // `daysAgoDate()` returns the date-only `YYYY-MM-DD` form that
  // Notion's `date` column emits — used for `reviewBy` so an overdue
  // fixture is overdue on every wall-clock day, not just on dates
  // hardcoded into the test.
  function daysAgo(n: number): string {
    return new Date(Date.now() - n * 86_400_000).toISOString()
  }
  function daysAgoDate(n: number): string {
    return daysAgo(n).split("T")[0]
  }

  it("renders Overdue / Stale / Active sub-headings in priority order with row counts", async () => {
    const overdueTask = makeTask({
      id: "overdue-1",
      title: "Ship classifier hotfix",
      reviewBy: daysAgoDate(27),
      updatedAt: daysAgo(2),
    })
    const staleTask = makeTask({
      id: "stale-1",
      title: "Investigate timezone bug in BVC",
      reviewBy: null,
      updatedAt: daysAgo(45),
    })
    const activeTask = makeTask({
      id: "active-1",
      title: "Refactor router shim",
      reviewBy: null,
      updatedAt: daysAgo(2),
    })

    const mockServer = createMockServer()
    const services = makeWakeServices({
      tasks: [overdueTask, staleTask, activeTask],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    expect(text).toContain("## Tasks")
    expect(text).toContain("### Overdue (1)")
    expect(text).toContain(
      "### Stale (1 active task untouched ≥30 days) — consider closing if resolved",
    )
    expect(text).toContain("### Active (1)")

    // Bucket ordering: Overdue > Stale > Active.
    const overdueIdx = text.indexOf("### Overdue")
    const staleIdx = text.indexOf("### Stale")
    const activeIdx = text.indexOf("### Active")
    expect(overdueIdx).toBeGreaterThan(-1)
    expect(staleIdx).toBeGreaterThan(overdueIdx)
    expect(activeIdx).toBeGreaterThan(staleIdx)
  })

  it("emits an inline closure CTA on every task row regardless of bucket", async () => {
    // Pin all three buckets in one fixture so a regression in any
    // bucket's row formatting (Overdue / Stale / Active) surfaces the
    // closure CTA. The CTA is the load-bearing nudge for #12 — losing
    // it on the Stale path would silently undo the issue's intent.
    const overdueTask = makeTask({
      id: "overdue-id",
      title: "Overdue row",
      reviewBy: daysAgoDate(27),
      updatedAt: daysAgo(2),
    })
    const staleTask = makeTask({
      id: "stale-id",
      title: "Stale row",
      reviewBy: null,
      updatedAt: daysAgo(45),
    })
    const activeTask = makeTask({
      id: "active-id",
      title: "Active row",
      reviewBy: null,
      updatedAt: daysAgo(2),
    })

    const mockServer = createMockServer()
    const services = makeWakeServices({
      tasks: [overdueTask, staleTask, activeTask],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    // Each bucket's row carries the same "ID: <id> — close if resolved:"
    // trailer + a ready-to-copy `lore-task({ action: 'close', ... })`
    // call. The agent never has to remember the dispatcher signature.
    for (const id of ["overdue-id", "stale-id", "active-id"]) {
      expect(text).toContain(`ID: ${id} — close if resolved:`)
      expect(text).toContain(
        `lore-task({ action: 'close', taskId: '${id}' })`,
      )
    }
  })

  it("omits empty buckets so an Active-only project shows only ### Active", async () => {
    const activeTask = makeTask({
      id: "active-1",
      title: "Refactor router shim",
      reviewBy: null,
      updatedAt: daysAgo(2),
    })

    const mockServer = createMockServer()
    const services = makeWakeServices({ tasks: [activeTask] })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    expect(text).toContain("## Tasks")
    expect(text).toContain("### Active (1)")
    expect(text).not.toContain("### Overdue")
    expect(text).not.toContain("### Stale")
  })

  it("omits the entire Tasks section when there are no active tasks", async () => {
    // Pre-existing behavior: a project with no active tasks emits no
    // `## Tasks` header at all. The bucketing rewrite must preserve
    // that — no empty header, no empty sub-buckets.
    const mockServer = createMockServer()
    const services = makeWakeServices({ tasks: [] })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    expect(text).not.toContain("## Tasks")
  })

  it("buckets a row that is both overdue and stale into Overdue (overdue is the stronger signal)", async () => {
    // Mutual-exclusivity rule: a task with a past due date AND a 60-day-
    // old `updatedAt` lands in Overdue, not Stale. Surfacing it in both
    // buckets would double-count it; surfacing it in Stale would hide
    // its overdue urgency under a softer header.
    const both = makeTask({
      id: "both-1",
      title: "Long-overdue and untouched",
      reviewBy: daysAgoDate(120),
      updatedAt: daysAgo(60),
    })

    const mockServer = createMockServer()
    const services = makeWakeServices({ tasks: [both] })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    expect(text).toContain("### Overdue (1)")
    expect(text).not.toContain("### Stale")
  })

  it("caps each bucket at taskLimit and surfaces the hidden count in the heading", async () => {
    // The over-fetched window holds up to 4× the cap. Per-bucket caps
    // ensure no single bucket dominates the rendered Tasks section.
    // The heading itself surfaces the shown/total/hidden split — same
    // single-signal posture `lore-task action='list'` already uses.
    const tasks: TaskSummary[] = []
    for (let i = 0; i < 12; i++) {
      tasks.push(
        makeTask({
          id: `stale-${i}`,
          title: `Stale task ${i}`,
          reviewBy: null,
          updatedAt: daysAgo(45),
        }),
      )
    }

    const mockServer = createMockServer()
    const services = makeWakeServices({ tasks })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    // Default `taskLimit` is 10 — render 10, hide 2.
    const result = await wake({} as never)

    const text = extractText(result)
    // Truncated-heading grammar: "10 shown of 12 active tasks untouched
    // ≥30 days, hiding 2" — the descriptor stays attached to the total
    // so the reader doesn't parse "hiding 2 active tasks untouched"
    // as if only the 2 hidden are stale.
    expect(text).toContain(
      "### Stale (10 shown of 12 active tasks untouched ≥30 days, hiding 2) — consider closing if resolved",
    )
    // No separate trailer line — the heading carries the full signal.
    expect(text).not.toContain("more not shown")
    // Sanity: the first 10 rendered, not the last 2.
    expect(text).toContain("Stale task 0")
    expect(text).toContain("Stale task 9")
    expect(text).not.toContain("Stale task 10")
    expect(text).not.toContain("Stale task 11")
  })

  it("does not starve Stale and Active when the over-fetched window contains all three buckets", async () => {
    // The data layer over-fetches by 4× so an Overdue-heavy fixture
    // doesn't crowd Stale/Active out of the window. With one of each,
    // all three render.
    const tasks: TaskSummary[] = []
    // 8 overdue rows
    for (let i = 0; i < 8; i++) {
      tasks.push(
        makeTask({
          id: `overdue-${i}`,
          title: `Overdue ${i}`,
          reviewBy: daysAgoDate(27),
          updatedAt: daysAgo(2),
        }),
      )
    }
    // 1 stale, 1 active
    tasks.push(
      makeTask({
        id: "stale-1",
        title: "Stale row",
        reviewBy: null,
        updatedAt: daysAgo(45),
      }),
    )
    tasks.push(
      makeTask({
        id: "active-1",
        title: "Active row",
        reviewBy: null,
        updatedAt: daysAgo(2),
      }),
    )

    const mockServer = createMockServer()
    const services = makeWakeServices({ tasks })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    expect(text).toContain("### Overdue (8)")
    expect(text).toContain("### Stale (1 active task untouched ≥30 days)")
    expect(text).toContain("### Active (1)")
    expect(text).toContain("Stale row")
    expect(text).toContain("Active row")
  })
})

describe("lore-wake-up — Part H follow-ups: saturation marker + sort-order starvation (DEFERRED-04)", () => {
  // Clock-frozen determinism: wall-clock-relative `daysAgo` produces
  // a flake window when the suite crosses UTC midnight; `vi.setSystemTime`
  // anchors every fixture and the renderer's `new Date().toISOString()`
  // call to a single `today` value.
  const FROZEN_NOW = new Date("2026-04-29T12:00:00Z").getTime()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FROZEN_NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // The `Frozen` suffix encodes the clock posture in the name itself:
  // `daysAgoFrozen` is anchored to `FROZEN_NOW`, the wall-clock-relative
  // sibling in Part H / Part I keeps the bare `daysAgo` name. A future
  // describe block reading "I want a frozen anchor too" copies this
  // helper; one reading "I want wall-clock" copies Part H's. No comment
  // required to disambiguate — the name carries the contract.
  function daysAgoFrozen(n: number): string {
    return new Date(FROZEN_NOW - n * 86_400_000).toISOString()
  }
  function daysAgoFrozenDate(n: number): string {
    return daysAgoFrozen(n).split("T")[0]
  }

  it("prefixes bucket counts with ≥ when the over-fetched window saturates", async () => {
    // Default `taskLimit` is 10, so the data layer over-fetches at
    // `min(100, 10 * 4) = 40`. A 40-row stale fixture saturates that
    // window exactly: every row lands in Stale, and the renderer can
    // no longer claim a precise inventory — the vault might have
    // hundreds of stale rows beyond the over-fetch ceiling. The `≥`
    // prefix on both the total and the hidden count signals "lower
    // bound, not inventory" so the agent's triage view stays honest
    // about what the wake-up window can actually see. `lore-task
    // action='reconcile'` is the proper audit surface; `## Tasks` is
    // the triage view, and the saturation marker is its claim to
    // that scope.
    const tasks: TaskSummary[] = []
    for (let i = 0; i < 40; i++) {
      tasks.push(
        makeTask({
          id: `stale-${i}`,
          title: `Stale task ${i}`,
          reviewBy: null,
          updatedAt: daysAgoFrozen(45),
        }),
      )
    }

    const mockServer = createMockServer()
    const services = makeWakeServices({ tasks })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    expect(text).toContain(
      "### Stale (10 shown of ≥40 active tasks untouched ≥30 days, hiding ≥30) — consider closing if resolved",
    )
    // Sanity: the first 10 render, the rest are gated by the cap.
    expect(text).toContain("Stale task 0")
    expect(text).toContain("Stale task 9")
    expect(text).not.toContain("Stale task 10")
  })

  it("omits the ≥ prefix when the over-fetched window has headroom", async () => {
    // A 12-row fixture sits comfortably inside the 40-row over-fetch
    // window, so bucket counts are exact and the marker stays absent.
    // Pinned alongside the saturation case so a regression that
    // emits `≥` unconditionally surfaces here, not as an unrelated
    // assertion failure elsewhere.
    const tasks: TaskSummary[] = []
    for (let i = 0; i < 12; i++) {
      tasks.push(
        makeTask({
          id: `stale-${i}`,
          title: `Stale task ${i}`,
          reviewBy: null,
          updatedAt: daysAgoFrozen(45),
        }),
      )
    }

    const mockServer = createMockServer()
    const services = makeWakeServices({ tasks })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    expect(text).toContain(
      "### Stale (10 shown of 12 active tasks untouched ≥30 days, hiding 2) — consider closing if resolved",
    )
    // No saturation marker on either the total or the hidden count.
    expect(text).not.toContain("≥12")
    expect(text).not.toContain("hiding ≥")
  })

  it("starves null-due Stale and Active rows when due-dated rows fill the over-fetch window", async () => {
    // Realistic sort-skew fixture: `TaskService.list` sorts by
    // `Review By ascending` and Notion places null-date rows AFTER
    // non-null rows. A vault with 40 due-dated active tasks therefore
    // consumes the entire `tasksFetchLimit = 40` over-fetch window
    // before any null-due Stale or Active row can appear. The
    // implementation is correct (bucketing precedence is honest about
    // its window); this test pins the contract so a future change to
    // the over-fetch multiplier or the sort order is caught here
    // rather than discovered on the Mail vault.
    //
    // **Why this differs from Part H's "does not starve" test.** That
    // test (8 overdue + 1 stale + 1 active = 10 rows) sits comfortably
    // inside the 40-row over-fetch window, so all three buckets render.
    // The new fixture (40 + 5 + 5 = 50 rows) over-shoots the window —
    // the mock's `limit`-honoring slice drops the last 10 rows
    // (mirroring what `TaskService.list` would do against Notion), and
    // the dropped rows are precisely the null-due ones. Both tests are
    // valid: Part H's pins "the over-fetch window is wide enough for
    // the small case"; this one pins "the over-fetch window is narrow
    // enough that the saturation marker is load-bearing on a real
    // vault."
    const tasks: TaskSummary[] = []
    // 40 due-dated overdue rows, sort-position first (the real
    // `TaskService.list` ordering surfaces these before null-due rows).
    for (let i = 0; i < 40; i++) {
      tasks.push(
        makeTask({
          id: `overdue-${i}`,
          title: `Overdue ${i}`,
          reviewBy: daysAgoFrozenDate(27 + i),
          updatedAt: daysAgoFrozen(2),
        }),
      )
    }
    // 5 null-due stale rows, sort-position after the due-dated rows.
    for (let i = 0; i < 5; i++) {
      tasks.push(
        makeTask({
          id: `stale-${i}`,
          title: `Starved stale ${i}`,
          reviewBy: null,
          updatedAt: daysAgoFrozen(45),
        }),
      )
    }
    // 5 null-due active rows, sort-position last.
    for (let i = 0; i < 5; i++) {
      tasks.push(
        makeTask({
          id: `active-${i}`,
          title: `Starved active ${i}`,
          reviewBy: null,
          updatedAt: daysAgoFrozen(2),
        }),
      )
    }

    const mockServer = createMockServer()
    const services = makeWakeServices({ tasks })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    // Saturation: 40 overdue, taskCap = 10, hidden = ≥30. Both the
    // total and the hidden count carry the `≥` lower-bound marker.
    expect(text).toContain("### Overdue (10 shown of ≥40, hiding ≥30)")
    // Stale and Active never reach the renderer — they were starved
    // by the sort order. Their headings stay absent because the
    // buckets are empty (`renderBucket` no-ops on `rows.length === 0`).
    expect(text).not.toContain("### Stale")
    expect(text).not.toContain("### Active")
    expect(text).not.toContain("Starved stale")
    expect(text).not.toContain("Starved active")
  })
})

describe("lore-wake-up — Part I: Tasks synopsis rendering (DEFERRED-01)", () => {
  function daysAgo(n: number): string {
    return new Date(Date.now() - n * 86_400_000).toISOString()
  }
  function daysAgoDate(n: number): string {
    return daysAgo(n).split("T")[0]
  }

  it("renders the synopsis as an indented line between the title row and the ID line", async () => {
    // One row per bucket so the assertion proves synopsis rendering is
    // bucket-agnostic — same posture as the closure-CTA test in Part H.
    const overdueTask = makeTask({
      id: "overdue-id",
      title: "Overdue row",
      synopsis: "Overdue synopsis text.",
      reviewBy: daysAgoDate(27),
      updatedAt: daysAgo(2),
    })
    const staleTask = makeTask({
      id: "stale-id",
      title: "Stale row",
      synopsis: "Stale synopsis text.",
      reviewBy: null,
      updatedAt: daysAgo(45),
    })
    const activeTask = makeTask({
      id: "active-id",
      title: "Active row",
      synopsis: "Active synopsis text.",
      reviewBy: null,
      updatedAt: daysAgo(2),
    })

    const mockServer = createMockServer()
    const services = makeWakeServices({
      tasks: [overdueTask, staleTask, activeTask],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    for (const fixture of [
      { title: "Overdue row", id: "overdue-id", synopsis: "Overdue synopsis text." },
      { title: "Stale row", id: "stale-id", synopsis: "Stale synopsis text." },
      { title: "Active row", id: "active-id", synopsis: "Active synopsis text." },
    ]) {
      const lines = text.split("\n")
      const titleIdx = lines.findIndex((l) => l.includes(`**${fixture.title}**`))
      expect(titleIdx).toBeGreaterThanOrEqual(0)
      expect(lines[titleIdx + 1]).toBe(`  ${fixture.synopsis}`)
      expect(lines[titleIdx + 2]).toContain(`ID: ${fixture.id} — close if resolved:`)
    }
  })

  it("omits the synopsis line on rows with empty synopsis (byte-identical pre-DEFERRED-01 path)", async () => {
    const task = makeTask({
      id: "plain-id",
      title: "Plain row",
      synopsis: "",
      reviewBy: null,
      updatedAt: daysAgo(2),
    })

    const mockServer = createMockServer()
    const services = makeWakeServices({ tasks: [task] })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    // Byte-identical pin against the pre-DEFERRED-01 row shape. The wake-up
    // ## Tasks section's full output is too dependent on surrounding
    // sections (digest / Recent Memories / Active Facts) to assert on the
    // entire response, so we slice exactly the two-line bullet for the row
    // and match it as a single string. Any indentation drift or stray
    // newline between the title row and the ID row trips this check.
    const lines = text.split("\n")
    const titleIdx = lines.findIndex((l) => l.includes("**Plain row**"))
    expect(`${lines[titleIdx]}\n${lines[titleIdx + 1]}`).toBe(
      "- **Plain row** [open]\n" +
        "  ID: plain-id — close if resolved: lore-task({ action: 'close', taskId: 'plain-id' })",
    )
  })

  it("treats whitespace-only synopsis the same as empty (no rendered line)", async () => {
    // Mirror of the decisions-list and tasks-list whitespace tests: pin
    // the trim-aware truthy check on the wake-up triage view so a future
    // migration landing `"   "` synopsis can't emit a blank indented line
    // between the title row and the ID/CTA line.
    const task = makeTask({
      id: "ws-id",
      title: "Whitespace row",
      synopsis: "   \t  ",
      reviewBy: null,
      updatedAt: daysAgo(2),
    })

    const mockServer = createMockServer()
    const services = makeWakeServices({ tasks: [task] })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    const lines = text.split("\n")
    const titleIdx = lines.findIndex((l) => l.includes("**Whitespace row**"))
    expect(`${lines[titleIdx]}\n${lines[titleIdx + 1]}`).toBe(
      "- **Whitespace row** [open]\n" +
        "  ID: ws-id — close if resolved: lore-task({ action: 'close', taskId: 'ws-id' })",
    )
  })

  it("ignores caller-supplied includeSynopsis (wake-up has no synopsis toggle)", async () => {
    // Per DEFERRED-01: wake-up does NOT gain new toggles. The field
    // is not declared on the `wake-up` branch of `contextDispatchSchema`,
    // so Zod's default `strip` posture drops it during `safeParse` —
    // there is no dispatcher-layer code rejecting it explicitly. Pin
    // this so a copy-paste from `lore-task action='list'` to
    // `lore-context action='wake-up'` doesn't silently suppress the
    // synopsis on the triage view.
    const task = makeTask({
      id: "syn-id",
      title: "Syn row",
      synopsis: "Visible synopsis.",
      reviewBy: null,
      updatedAt: daysAgo(2),
    })

    const mockServer = createMockServer()
    const services = makeWakeServices({ tasks: [task] })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({ includeSynopsis: false } as never)

    const text = extractText(result)
    expect(text).toContain("Visible synopsis.")
  })

  it("defensively truncates over-cap synopses on the triage row", async () => {
    const word = "abcde "
    const longSynopsis = word.repeat(100)
    const task = makeTask({
      id: "long-id",
      title: "Long synopsis",
      synopsis: longSynopsis,
      reviewBy: null,
      updatedAt: daysAgo(2),
    })

    const mockServer = createMockServer()
    const services = makeWakeServices({ tasks: [task] })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getActionHandler("lore-context", "wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    const lines = text.split("\n")
    const titleIdx = lines.findIndex((l) => l.includes("**Long synopsis**"))
    const synopsisLine = lines[titleIdx + 1]
    expect(synopsisLine.startsWith("  ")).toBe(true)
    const payload = synopsisLine.slice(2)
    expect(payload.length).toBeLessThanOrEqual(500)
    // Boundary-safe: ends on a word, no trailing whitespace, no ellipsis.
    // Mirrors the decisions / tasks truncation assertions so a regression
    // in `truncateSynopsis`'s word-boundary fallback catches symmetrically
    // across all three new surfaces.
    expect(payload.endsWith("e")).toBe(true)
    expect(synopsisLine).not.toContain("…")
  })
})
