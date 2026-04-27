import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describe, expect, it, vi } from "vitest"
import { registerContextTools } from "./context.js"
import { RANKED_WAKEUP_LIMITS, loadWakeUpData } from "../../core/wakeup.js"
import type { Fact, Memory } from "../../types.js"

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

interface WakeServicesOverrides {
  memories?: Memory[]
  digest?: Memory | null
  relatedMemories?: Memory[]
  /**
   * Memories returned when the search query equals `taskQuery`. Lets
   * P3-05 tests distinguish the user-query-seeded task search from the
   * open-loop-entity-seeded related search at the MCP layer (same shape
   * as the data-layer stub in `wakeup.test.ts`).
   */
  taskQuery?: string
  taskMemories?: Memory[]
  facts?: Fact[]
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
  // Mirror the tracking-partition contract: filter to tracking predicates
  // and bias the surviving rows toward most-overdue under any cap. Tests
  // that pin specific cap behavior arrange fixture order to match the
  // urgency-biased ordering the real `listTracking` produces.
  const trackingPredicates = new Set(["needs_action", "waiting_on", "blocked_by"])
  const factsListTracking = vi.fn(
    async (opts: { projectId?: string; limit?: number } = {}) => {
      const tracking = (overrides.facts ?? []).filter((f) =>
        trackingPredicates.has(f.predicate),
      )
      const sorted = [...tracking].sort((a, b) => {
        if (a.reviewBy === b.reviewBy) return 0
        if (a.reviewBy === null) return 1
        if (b.reviewBy === null) return -1
        return a.reviewBy < b.reviewBy ? -1 : 1
      })
      const total = sorted.length
      const items =
        opts.limit !== undefined ? sorted.slice(0, opts.limit) : sorted
      return { items, hasMore: items.length < total }
    },
  )
  const factsListRecent = vi.fn(
    async (opts: { excludePredicates?: string[]; limit?: number }) => {
      const excluded = new Set(opts.excludePredicates ?? [])
      const all = (overrides.facts ?? []).filter((f) => !excluded.has(f.predicate))
      return { items: all.slice(0, opts.limit), hasMore: false }
    },
  )

  return {
    projects: { findByName: vi.fn() },
    memories: {
      list: memoriesList,
      search: memoriesSearch,
      getTitleById,
    },
    facts: {
      listTracking: factsListTracking,
      listRecent: factsListRecent,
    },
    decisions: {
      list: vi.fn(async () => ({ items: [] })),
      queryOverdue: vi.fn(async () => []),
    },
    tasks: {
      list: vi.fn(async () => ({ items: [] })),
    },
    context: { project: { id: "proj-1", name: "Mail", path: "/mail" } },
    config: { projects: [] },
    vault: { pageId: "vault-1", stats: vi.fn() },
    _calls: {
      memoriesList,
      memoriesSearch,
      factsListTracking,
      factsListRecent,
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
    const wake = mockServer.getHandler("lore-wake-up")
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
    const wake = mockServer.getHandler("lore-wake-up")
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
    const wake = mockServer.getHandler("lore-wake-up")
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
    const wake = mockServer.getHandler("lore-wake-up")
    const result = await wake({} as never)

    const text = extractText(result)
    expect(text).toContain("Adopt OIDC for auth")
    expect(text).not.toContain(DECISION_ID)
  })
})

describe("lore-wake-up — Part D: per-section limits", () => {
  it("forwards openLoopLimit to the tracking-predicate query", async () => {
    const mockServer = createMockServer()
    const services = makeWakeServices({ facts: [] })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getHandler("lore-wake-up")
    await wake({ openLoopLimit: 7 } as never)

    const [opts] = services._calls.factsListTracking.mock.calls[0]
    expect(opts?.limit).toBe(7)
  })

  it("forwards knowledgeFactLimit to the non-tracking listRecent query", async () => {
    const mockServer = createMockServer()
    const services = makeWakeServices({ facts: [] })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getHandler("lore-wake-up")
    await wake({ knowledgeFactLimit: 3 } as never)

    expect(services._calls.factsListRecent).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3 }),
    )
  })

  it("skips the open-loops section when openLoopLimit is 0", async () => {
    // Pairs with the wakeup.ts short-circuit: 0 means "don't fetch",
    // which also means "don't render".
    const mockServer = createMockServer()
    const services = makeWakeServices({
      facts: [makeFact({ id: "f1", predicate: "needs_action" })],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getHandler("lore-wake-up")
    const result = await wake({ openLoopLimit: 0 } as never)

    const text = extractText(result)
    expect(text).not.toContain("## Open Loops")
    expect(services._calls.factsListTracking).not.toHaveBeenCalled()
  })

  it("openLoopLimit: 0 cascades to skip the related-memory search", async () => {
    // Related memories are seeded from open-loop entities, so with zero
    // open loops there's nothing to seed from. The memories.search fan-out
    // must not fire — otherwise we pay for a wide relevance search with
    // an empty query.
    const mockServer = createMockServer()
    const services = makeWakeServices({
      facts: [makeFact({ id: "f1", predicate: "needs_action" })],
      relatedMemories: [makeMemory("r1", { title: "should not surface" })],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getHandler("lore-wake-up")
    const result = await wake({ openLoopLimit: 0 } as never)

    const text = extractText(result)
    expect(text).not.toContain("Related to Open Loops")
    expect(services._calls.memoriesSearch).not.toHaveBeenCalled()
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
    const wake = mockServer.getHandler("lore-wake-up")
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
    // Related to Open Loops has no date-bucket sub-head, so entries sit
    // directly under the `## Related to Open Loops` h2 — h3 is the right
    // depth. Recent Memories entries sit under `### Today/Yesterday/Earlier`
    // and must stay at h4.
    const mockServer = createMockServer()
    const services = makeWakeServices({
      memories: [makeMemory("m1", { title: "Recent entry" })],
      facts: [
        makeFact({
          id: "f1",
          predicate: "needs_action",
          subject: "Router migration",
          object: "OIDC",
        }),
      ],
      relatedMemories: [makeMemory("r1", { title: "Related entry" })],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getHandler("lore-wake-up")
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
    const wake = mockServer.getHandler("lore-wake-up")
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
    const wake = mockServer.getHandler("lore-wake-up")
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
    // Explicit 0 is the "skip this section" knob; mirrors how
    // openLoopLimit: 0 short-circuits the open-loops section.
    const mockServer = createMockServer()
    const services = makeWakeServices({
      taskQuery: "fix auth",
      taskMemories: [makeMemory("task-1", { title: "Auth investigation" })],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getHandler("lore-wake-up")
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

  it("applies RANKED_WAKEUP_LIMITS to the open-loop and knowledge-fact sections when userQuery is set", async () => {
    // The data-layer caps for sections that don't run through topical
    // collapse (open loops + knowledge facts) should flow straight from
    // RANKED_WAKEUP_LIMITS into the underlying service calls.
    const mockServer = createMockServer()
    const services = makeWakeServices({
      taskQuery: "fix auth",
      taskMemories: [makeMemory("task-1")],
    })

    registerContextTools(mockServer.server, services as never)
    const wake = mockServer.getHandler("lore-wake-up")
    await wake({ userQuery: "fix auth" } as never)

    expect(services._calls.factsListTracking).toHaveBeenCalledWith(
      expect.objectContaining({ limit: RANKED_WAKEUP_LIMITS.openLoopLimit }),
    )
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
    const wake = mockServer.getHandler("lore-wake-up")
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
    const wake = mockServer.getHandler("lore-wake-up")
    await wake({
      userQuery: "fix auth",
      openLoopLimit: 42,
      knowledgeFactLimit: 47,
    } as never)

    expect(services._calls.factsListTracking).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 42 }),
    )
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
    const mcpWake = mcpServer.getHandler("lore-wake-up")
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
    const wake = mockServer.getHandler("lore-wake-up")
    const result = await wake({ userQuery: "fix auth" } as never)

    const text = extractText(result)
    expect(text).toContain("Fresh task hit")
    // The dupe title appears once in Recent Memories, NOT under For Your
    // Current Task — count matches stay at 1.
    const matches = text.match(/Both recent and relevant/g) ?? []
    expect(matches.length).toBe(1)
  })
})
