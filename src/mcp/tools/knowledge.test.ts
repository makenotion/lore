import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { describe, expect, it, vi } from "vitest"
import { registerKnowledgeTools } from "./knowledge.js"
import { registerQueryTools } from "./query.js"
import type { Decision, Fact, Project, TaskSummary } from "../../types.js"
import { MemoryService } from "../../core/memory.js"

function makeDecision(id: string, overrides: Partial<Decision> = {}): Decision {
  return {
    id,
    title: `Decision ${id}`,
    projectIds: [],
    topicId: null,
    source: "manual",
    kind: "decision",
    status: "accepted",
    reviewBy: null,
    doneAt: null,
    decidedAt: "2026-04-20",
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

function makeFact(id: string, overrides: Partial<Fact> = {}): Fact {
  return {
    id,
    subject: "AuthService",
    predicate: "decided_by",
    object: "decision-id",
    projectIds: [],
    validFrom: "2026-04-20",
    validUntil: null,
    reviewBy: null,
    sourceMemoryId: "decision-id",
    confidence: "certain",
    confidenceScore: null,
    lastReferencedAt: null,
    createdAt: "2026-04-20T00:00:00.000Z",
    subjectEntityId: null,
    objectEntityId: null,
    ...overrides,
  }
}

function makeTask(id: string, overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id,
    title: `Task ${id}`,
    projectIds: [],
    topicId: null,
    source: "manual",
    kind: "task",
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
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    taskState: "open",
    blockedBy: "",
    entity: "",
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
    ...overrides,
  }
}

function makeEntityService() {
  return {
    resolveOrCreateEntity: vi.fn().mockResolvedValue({
      entity: null,
      ambiguous: false,
      candidates: [],
      created: false,
    }),
  }
}

function createMockServer() {
  const handlers = new Map<string, (...args: never[]) => Promise<unknown>>()
  const server = {
    registerTool: vi.fn(
      (
        name: string,
        _config: unknown,
        handler: (...args: never[]) => Promise<unknown>
      ) => {
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
     * tests can call it with action-specific args alone. The dispatcher's
     * discriminated union still validates the per-action schema.
     */
    getActionHandler(toolName: string, action: string) {
      const handler = handlers.get(toolName)
      if (!handler) throw new Error(`missing handler ${toolName}`)
      return (args: Record<string, unknown>) => handler({ ...args, action } as never)
    },
  }
}

describe("lore-ask", () => {
  it("resolves superseded decision links to the current decision and hides duplicates", async () => {
    const mockServer = createMockServer()
    const oldDecision = makeDecision("old-id", {
      title: "Old decision",
      status: "superseded",
    })
    const newDecision = makeDecision("new-id", {
      title: "New decision",
      decidedAt: "2026-04-21",
    })

    const services = {
      projects: {
        findByName: vi.fn(),
      },
      facts: {
        queryByEntity: vi.fn().mockResolvedValue([
          makeFact("fact-old", {
            sourceMemoryId: "old-id",
            confidence: "likely",
            object: "Old decision",
          }),
          makeFact("fact-new", {
            sourceMemoryId: "new-id",
            confidence: "likely",
            object: "new-id",
          }),
        ]),
        queryByObject: vi.fn().mockImplementation(async (object: string) => {
          if (object === "Old decision") {
            return [
              makeFact("sup-legacy", {
                subject: "New decision",
                predicate: "supersedes_decision",
                object: "Old decision",
                sourceMemoryId: "new-id",
                confidence: "likely",
              }),
            ]
          }
          return []
        }),
      },
      decisions: {
        getById: vi.fn().mockImplementation(async (id: string) => {
          if (id === "old-id") return oldDecision
          if (id === "new-id") return newDecision
          throw new Error(`unknown decision ${id}`)
        }),
      },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      memories: { getTitleById: vi.fn().mockResolvedValue(null) },
      entities: makeEntityService(),
      context: {
        project: null,
      },
    }

    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreAsk = mockServer.getActionHandler("lore-query", "ask")

    const result = await loreAsk({ entity: "AuthService" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain('1 facts about "AuthService"')
    expect(text).toContain("New decision")
    expect(text).not.toContain("Old decision")
  })
})

describe("lore-ask — partial decision resolution", () => {
  function servicesWithPartialFailure() {
    const newDecision = makeDecision("new-id", { title: "New decision" })
    return {
      projects: { findByName: vi.fn() },
      facts: {
        queryByEntity: vi.fn().mockResolvedValue([
          makeFact("fact-ok", {
            sourceMemoryId: "new-id",
            confidence: "likely",
            object: "new-id",
          }),
          makeFact("fact-bad", {
            sourceMemoryId: "bad-root",
            confidence: "likely",
            object: "bad-root",
          }),
        ]),
        queryByObject: vi.fn().mockImplementation(async (object: string) => {
          if (object === "bad-root") throw new Error("notion 5xx")
          return []
        }),
      },
      decisions: {
        getById: vi.fn().mockImplementation(async (id: string) => {
          if (id === "new-id") return newDecision
          throw new Error(`unknown decision ${id}`)
        }),
      },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      memories: { getTitleById: vi.fn().mockResolvedValue(null) },
      entities: makeEntityService(),
      context: { project: null },
    }
  }

  it("surfaces a warning when one decision root's walk rejects, keeping the resolved decisions", async () => {
    // End-to-end: the settleAll wrapper inside resolveCanonicalDecisionLinks
    // produces `failures`; the tool handler pushes a warning describing the
    // failing root IDs through the existing `Warnings:` footer. Without
    // this test, a future regression that forgot to wire failures into
    // warnings would pass the unit test but silently drop the user-visible
    // error signal.
    const mockServer = createMockServer()
    const services = servicesWithPartialFailure()

    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreAsk = mockServer.getActionHandler("lore-query", "ask")

    const result = await loreAsk({ entity: "AuthService" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    // The resolved decision is still rendered.
    expect(text).toContain("New decision")
    // Partial-failure warning surfaces the failing root id INSIDE the
    // Warnings: footer, not elsewhere. Regex pins co-location so an
    // accidental leak into the decision render (where the id could
    // match via `toContain` but in the wrong section) still fails.
    expect(text).toMatch(/Warnings:[^\n]*bad-root/)
    expect(text).toContain("retry before relying on this result")
  })

  it("emits one stderr line per failing root when LORE_DEBUG=1", async () => {
    // Operator-observability gate: when the env var is set, each failure
    // surfaces on stderr in the canonical format so ops can distinguish a
    // routine 429 from a pathological corrupted-page loop. Without this
    // signal, partial failures are silent to ops since the agent-facing
    // warning never leaves the MCP response.
    const mockServer = createMockServer()
    const services = servicesWithPartialFailure()
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreAsk = mockServer.getActionHandler("lore-query", "ask")
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    vi.stubEnv("LORE_DEBUG", "1")

    try {
      await loreAsk({ entity: "AuthService" } as never)

      // One line per failing root — single failure in this fixture.
      expect(stderr).toHaveBeenCalledTimes(1)
      const logged = String(stderr.mock.calls[0][0])
      // Exact canonical format: operators grep on `[lore] partial-failure:`
      // in log aggregators and pin on the field ordering below. A future
      // reshuffle (say, moving `tool=` before `root=`) would silently
      // break downstream filters; pin the full line here instead of a
      // substring set so a reordering trips this test.
      expect(logged).toBe(
        "[lore] partial-failure: root=bad-root error=notion 5xx tool=lore-query\n"
      )
    } finally {
      vi.unstubAllEnvs()
      stderr.mockRestore()
    }
  })

  it("collapses embedded newlines and control chars into spaces so one failure = one log line", async () => {
    // Defensive invariant: `grep "[lore] partial-failure:"` downstream
    // expects one event per line. A Notion SDK error that happens to
    // include a multi-line body (or, in the wild, an `InvalidPathParameterError`
    // message containing embedded structure) would otherwise fork a
    // single failure into multiple aggregator events. Rare today — free
    // to pin before future callers like PF1-01's bounded retries add
    // surfaces we haven't eyeballed.
    const mockServer = createMockServer()
    const newDecision = makeDecision("new-id", { title: "New decision" })
    const services = {
      projects: { findByName: vi.fn() },
      facts: {
        queryByEntity: vi
          .fn()
          .mockResolvedValue([
            makeFact("fact-ok", { sourceMemoryId: "new-id", object: "new-id" }),
            makeFact("fact-bad", { sourceMemoryId: "bad-root", object: "bad-root" }),
          ]),
        queryByObject: vi.fn().mockImplementation(async (object: string) => {
          // Message contains a newline AND a tab AND a carriage-return —
          // all three must collapse to a single space.
          if (object === "bad-root") throw new Error("line one\nline two\ttabbed\rcr")
          return []
        }),
      },
      decisions: {
        getById: vi.fn().mockImplementation(async (id: string) => {
          if (id === "new-id") return newDecision
          throw new Error(`unknown decision ${id}`)
        }),
      },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      memories: { getTitleById: vi.fn().mockResolvedValue(null) },
      entities: makeEntityService(),
      context: { project: null },
    }
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreAsk = mockServer.getActionHandler("lore-query", "ask")
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    vi.stubEnv("LORE_DEBUG", "1")

    try {
      await loreAsk({ entity: "AuthService" } as never)

      expect(stderr).toHaveBeenCalledTimes(1)
      const logged = String(stderr.mock.calls[0][0])
      // Exactly one trailing newline — the appended event terminator —
      // and no embedded ones. A naive split by \n must yield exactly two
      // parts: the event and an empty string after the terminator.
      expect(logged.split("\n")).toHaveLength(2)
      expect(logged).toBe(
        "[lore] partial-failure: root=bad-root error=line one line two tabbed cr tool=lore-query\n"
      )
    } finally {
      vi.unstubAllEnvs()
      stderr.mockRestore()
    }
  })

  it("is silent on stderr when LORE_DEBUG is unset, even with partial failures", async () => {
    // The helper is opt-in by design: silent partial failure is the common
    // case and logging by default would make stderr unreadable. This test
    // pins the default-off posture so a future change that flips the
    // predicate cannot land without being noticed.
    const mockServer = createMockServer()
    const services = servicesWithPartialFailure()
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreAsk = mockServer.getActionHandler("lore-query", "ask")
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    // Explicit unset — no lingering env from a parallel test.
    vi.stubEnv("LORE_DEBUG", "")

    try {
      const result = await loreAsk({ entity: "AuthService" } as never)
      const text = (result as { content: Array<{ text: string }> }).content[0].text

      // The agent-facing warning still surfaces — we only suppress stderr.
      expect(text).toMatch(/Warnings:[^\n]*bad-root/)
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
      stderr.mockRestore()
    }
  })
})

describe("lore-ask — parallel decision and title resolution", () => {
  it("dispatches resolveCanonicalDecisionLinks and resolveReferencedTitles concurrently", async () => {
    // Pins the parallel `Promise.all` in handleAsk: both passes are
    // data-independent (different fact subsets in, disjoint outputs
    // out), so serializing them adds wall-clock on every `lore-ask`
    // call. Mock both underlying loaders with manually-controlled
    // deferreds and prove both are in flight before either resolves.
    // If a future refactor re-serializes the awaits, only
    // `decisions.getById` would have been called by the microtask
    // flush — `memories.getTitleById` would still be downstream of the
    // first await and the second assertion would fail.
    const mockServer = createMockServer()

    // Definite-assignment (`!:`) is load-bearing here: a `let` typed as
    // `((...) => void) | null = null` gets narrowed at the call site
    // because TS can't prove the Promise executor ran synchronously,
    // even though the spec guarantees it. The `!` says "this is assigned
    // before any read" — true for the executor, and the assertion is
    // what unblocks `resolveDecision(null)` below without an unsafe cast.
    let resolveDecision!: (d: Decision | null) => void
    const decisionPromise = new Promise<Decision | null>((resolve) => {
      resolveDecision = resolve
    })
    const getById = vi.fn(() => decisionPromise)

    let resolveTitle!: (t: string | null) => void
    const titlePromise = new Promise<string | null>((resolve) => {
      resolveTitle = resolve
    })
    const getTitleById = vi.fn(() => titlePromise)

    // UUID-shaped object on a structure fact forces title resolution
    // to issue a `memories.getTitleById` call. A non-UUID would short-
    // circuit at `resolveTitles` and the title pass would never reach
    // the loader, defeating the parallelism assertion.
    const uuidObject = "11111111-1111-4111-8111-111111111111"

    const services = {
      projects: { findByName: vi.fn() },
      facts: {
        queryByEntity: vi.fn().mockResolvedValue([
          // Drives the decision-link path: `decided_by` lands in the
          // governance bucket and forces a `decisions.getById("new-id")`
          // through `resolveCurrentDecisions`'s BFS.
          makeFact("fact-decided", {
            predicate: "decided_by",
            sourceMemoryId: "new-id",
            confidence: "likely",
            object: "new-id",
          }),
          // Drives the title-resolution path: UUID-shaped object on a
          // structure-class fact forces a `memories.getTitleById(uuid)`.
          makeFact("fact-uses", {
            predicate: "uses",
            object: uuidObject,
          }),
        ]),
        queryByObject: vi.fn().mockResolvedValue([]),
      },
      decisions: { getById },
      memories: { getTitleById },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      entities: makeEntityService(),
      context: { project: null },
    }

    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreAsk = mockServer.getActionHandler("lore-query", "ask")

    const pending = loreAsk({ entity: "AuthService" } as never)
    // Flush microtasks so any synchronously-dispatched calls land on
    // their mocks. `setImmediate` matches the cadence used by the
    // sibling parallel-dispatch test in `memory.test.ts` (lore-expand).
    await new Promise((r) => setImmediate(r))

    // Both passes are mid-flight before either deferred resolves. If
    // `handleAsk` had `await resolveCanonicalDecisionLinks(...)` ahead
    // of `resolveReferencedTitles(...)`, the title loader would never
    // have been called because the decision deferred is still pending.
    expect(getById).toHaveBeenCalled()
    expect(getTitleById).toHaveBeenCalled()

    // Drain the deferreds so the handler can complete and the test
    // doesn't hang. Decision side resolves to null → BFS terminates
    // with zero canonical leaves and an empty `links` list. Title
    // side resolves to null → the UUID renders as its unresolved
    // hint, but the response still composes successfully.
    resolveDecision(null)
    resolveTitle(null)

    const result = (await pending) as { content: Array<{ text: string }> }
    // Sanity: the response composition still works end-to-end. The
    // structure bucket renders the `uses` fact even when its object
    // title didn't resolve.
    expect(result.content[0].text).toContain("Structure")
  })
})

describe("lore-ask grouped display (P2-06)", () => {
  function services(facts: Fact[], overrides: Record<string, unknown> = {}) {
    return {
      projects: { findByName: vi.fn() },
      facts: {
        queryByEntity: vi.fn().mockResolvedValue(facts),
        queryByObject: vi.fn().mockResolvedValue([]),
      },
      decisions: { getById: vi.fn() },
      memories: { getTitleById: vi.fn().mockResolvedValue(null) },
      // P3-02: lore-ask now also queries tasks.list. Stub returns empty
      // by default so existing tests that only assert on facts keep
      // passing; tests that exercise the Tasks bucket override this.
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      entities: makeEntityService(),
      context: { project: null },
      ...overrides,
    }
  }

  async function invokeAsk(
    facts: Fact[],
    args: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {}
  ): Promise<string> {
    const mockServer = createMockServer()
    registerKnowledgeTools(mockServer.server, services(facts, overrides) as never)
    registerQueryTools(mockServer.server, services(facts, overrides) as never)
    const handler = mockServer.getActionHandler("lore-query", "ask")
    const result = await handler({ entity: "AuthService", ...args } as never)
    return (result as { content: Array<{ text: string }> }).content[0].text
  }

  it("renders bucket headings with counts when classes are present", async () => {
    const facts: Fact[] = [
      makeFact("struct-1", { predicate: "uses", object: "JWT" }),
      makeFact("gov-1", {
        predicate: "supersedes_decision",
        subject: "AuthService",
        object: "LegacyDecision",
      }),
    ]
    const text = await invokeAsk(facts)
    expect(text).toContain('2 facts about "AuthService"')
    expect(text).toMatch(/### Governance \(1\)/)
    expect(text).toMatch(/### Structure \(1\)/)
  })

  it("omits bucket headings for empty classes", async () => {
    const text = await invokeAsk([
      makeFact("struct-1", { predicate: "uses", object: "JWT" }),
    ])
    expect(text).toContain("### Structure")
    expect(text).not.toContain("### Governance")
  })

  it("caps each bucket at 5 by default and surfaces a per-bucket hidden count", async () => {
    const facts: Fact[] = Array.from({ length: 8 }, (_, i) =>
      makeFact(`s-${i}`, {
        predicate: "uses",
        object: `Obj${i}`,
        // Unique validFrom per row so the sort is deterministic.
        validFrom: `2026-04-${String(10 + i).padStart(2, "0")}`,
      })
    )
    const text = await invokeAsk(facts)

    expect(text).toContain("### Structure (8) (3 hidden)")
    // Most-recent-first: s-7 is the newest and must render; s-0 is the
    // oldest and must fall below the cap.
    expect(text).toContain("Obj7")
    expect(text).not.toContain("Obj0")
    // Overflow hint is emitted when the default cap hid rows.
    expect(text).toContain("pass limit")
  })

  it("raises the cap when the caller passes an explicit limit", async () => {
    const facts: Fact[] = Array.from({ length: 8 }, (_, i) =>
      makeFact(`s-${i}`, {
        predicate: "uses",
        object: `Obj${i}`,
        validFrom: `2026-04-${String(10 + i).padStart(2, "0")}`,
      })
    )
    const text = await invokeAsk(facts, { limit: 20 })

    expect(text).toContain("### Structure (8)")
    // All eight rows survive — no `(N hidden)` suffix, no overflow hint.
    expect(text).not.toMatch(/\(\d+ hidden\)/)
    expect(text).not.toContain("pass limit")
    for (let i = 0; i < 8; i++) {
      expect(text).toContain(`Obj${i}`)
    }
  })

  it("resolves UUID-shaped objects to titles via the memory loader", async () => {
    // A `supersedes_decision` fact where both sides are UUIDs — the P1-05
    // title resolver should substitute them without forcing the caller to
    // look up IDs manually.
    const DECISION_A = "349b35e6-e67f-8185-bec0-d3902135c5ba"
    const DECISION_B = "449b35e6-e67f-8185-bec0-d3902135c5bb"
    const titles: Record<string, string> = {
      [DECISION_A]: "Adopt JWT v2",
      [DECISION_B]: "Legacy session cookies",
    }
    const memories = {
      getTitleById: vi
        .fn()
        .mockImplementation(async (id: string) => titles[id.toLowerCase()] ?? null),
    }

    const facts: Fact[] = [
      makeFact("g1", {
        predicate: "supersedes_decision",
        subject: DECISION_A,
        object: DECISION_B,
      }),
    ]
    const text = await invokeAsk(facts, {}, { memories })

    expect(text).toContain("Adopt JWT v2")
    expect(text).toContain("Legacy session cookies")
    // Raw UUIDs must not leak into the rendered triple.
    expect(text).not.toContain(DECISION_A)
    expect(text).not.toContain(DECISION_B)
  })

  it("does not emit an overflow hint when the caller already passed a limit", async () => {
    const facts: Fact[] = Array.from({ length: 8 }, (_, i) =>
      makeFact(`s-${i}`, {
        predicate: "uses",
        object: `Obj${i}`,
      })
    )
    const text = await invokeAsk(facts, { limit: 3 })
    // `limit=3` is below the count so we DO trim — but the caller is
    // already on the knob, so we don't re-advertise it.
    expect(text).toMatch(/\(5 hidden\)/)
    expect(text).not.toContain("pass limit")
  })
})

describe("lore-ask — confidence-weighted RRF (DEFERRED-02)", () => {
  function services(facts: Fact[]) {
    return {
      projects: { findByName: vi.fn() },
      facts: {
        queryByEntity: vi.fn().mockResolvedValue(facts),
        queryByObject: vi.fn().mockResolvedValue([]),
        // `handleAsk` fires `fireFactTouchOnRead` after the visible-slice
        // fact list is rendered; stub `touchOnRead` so the helper
        // resolves cleanly. Without this stub, `fireFactTouchOnRead`'s
        // outer try/catch swallows the missing-method TypeError but
        // every test would emit the same noise.
        touchOnRead: vi.fn().mockResolvedValue(undefined),
      },
      decisions: { getById: vi.fn() },
      memories: {
        getTitleById: vi.fn().mockResolvedValue(null),
        // `handleAsk` calls `getManyById` for memory cite-as-evidence;
        // returning `[]` (no source memories) keeps the test focused
        // on the fact ordering.
        getManyById: vi.fn().mockResolvedValue([]),
        touchOnRead: vi.fn().mockResolvedValue(undefined),
      },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      entities: makeEntityService(),
      context: { project: null },
    }
  }

  async function invokeAsk(facts: Fact[]): Promise<string> {
    const mockServer = createMockServer()
    const svc = services(facts)
    registerKnowledgeTools(mockServer.server, svc as never)
    registerQueryTools(mockServer.server, svc as never)
    const handler = mockServer.getActionHandler("lore-query", "ask")
    const result = await handler({ entity: "AuthService" } as never)
    return (result as { content: Array<{ text: string }> }).content[0].text
  }

  it("preserves byte-identical pre-DEFERRED-02 recency ordering when every score is null", async () => {
    // Pre-migration vaults: every `confidenceScore` is null. The RRF
    // pass should behave as a pure recency sort because
    // `confidenceFactor(null) === 1.0` ties every multiplier and the
    // RRF score collapses to monotonic-by-rank.
    const facts: Fact[] = [
      makeFact("older", {
        predicate: "uses",
        object: "OlderObj",
        validFrom: "2026-04-01",
      }),
      makeFact("newer", {
        predicate: "uses",
        object: "NewerObj",
        validFrom: "2026-04-25",
      }),
    ]
    const text = await invokeAsk(facts)
    const newerIdx = text.indexOf("NewerObj")
    const olderIdx = text.indexOf("OlderObj")
    expect(newerIdx).toBeGreaterThan(-1)
    expect(olderIdx).toBeGreaterThan(-1)
    // Newer fact renders first under recency-only (the pre-DEFERRED-02
    // contract). Pin the order so a future refactor that silently
    // changes the sort comparator can't regress null-score vaults.
    expect(newerIdx).toBeLessThan(olderIdx)
  })

  it("ranks high-confidence older facts above low-confidence newer facts", async () => {
    // The first draft of the comparator only applied confidenceFactor
    // as a same-day tiebreaker. This pins the BLOCKING fix from review
    // 2: a high-score older fact must beat a low-score newer fact when
    // the score gap warrants. With FACT_RRF_K = 4:
    //   rank 0 (newer), score 0.05 → factor 0.525 → 1/5 * 0.525 = 0.105
    //   rank 1 (older), score 0.95 → factor 0.975 → 1/6 * 0.975 = 0.1625
    // Older wins.
    const facts: Fact[] = [
      makeFact("newer-decayed", {
        predicate: "uses",
        object: "NewerDecayed",
        validFrom: "2026-04-25",
        confidenceScore: 0.05,
      }),
      makeFact("older-trusted", {
        predicate: "uses",
        object: "OlderTrusted",
        validFrom: "2026-04-01",
        confidenceScore: 0.95,
      }),
    ]
    const text = await invokeAsk(facts)
    const trustedIdx = text.indexOf("OlderTrusted")
    const decayedIdx = text.indexOf("NewerDecayed")
    expect(trustedIdx).toBeGreaterThan(-1)
    expect(decayedIdx).toBeGreaterThan(-1)
    expect(trustedIdx).toBeLessThan(decayedIdx)
  })

  it("renders the trust label as a separate indented line when confidenceScore < threshold", async () => {
    // BLOCKING fix from review 2: the new score must be visible in the
    // user-facing surfaces, not just affect ranking. A fact at score
    // 0.15 is "very low confidence" per `formatTrustLabel`; the
    // trust label renders on its own indented italic line below the
    // bullet (mirroring the decision/task surfaces from DEFERRED-07
    // via the shared `renderTrustLine` helper).
    const facts: Fact[] = [
      makeFact("decayed", {
        predicate: "uses",
        object: "DecayedObj",
        confidenceScore: 0.15,
      }),
    ]
    const text = await invokeAsk(facts)
    expect(text).toContain("[certain]")
    expect(text).toContain("_very low confidence_")
  })

  it("does not render a trust label when confidenceScore is null (byte-identical pre-DEFERRED-02)", async () => {
    // Pre-migration row: render must remain `[certain]` only with the
    // ID footer immediately below. No trust line, no italic signal.
    // A regression here would be visible to every agent reading
    // lore-ask responses against an un-backfilled vault.
    const facts: Fact[] = [
      makeFact("legacy", {
        predicate: "uses",
        object: "LegacyObj",
      }),
    ]
    const text = await invokeAsk(facts)
    expect(text).toContain("[certain]")
    expect(text).not.toContain("_very low confidence_")
    expect(text).not.toContain("_low confidence_")
    expect(text).not.toContain("_moderate confidence_")
  })

  it("does not render a trust label when confidenceScore is above threshold", async () => {
    // 0.8 is fully trusted (above CONFIDENCE_DISPLAY_THRESHOLD = 0.5).
    // `renderTrustLine` returns null on above-threshold scores, so the
    // rendered output stays `[certain]` only.
    const facts: Fact[] = [
      makeFact("fresh", {
        predicate: "uses",
        object: "FreshObj",
        confidenceScore: 0.8,
      }),
    ]
    const text = await invokeAsk(facts)
    expect(text).toContain("[certain]")
    expect(text).not.toContain("_very low confidence_")
    expect(text).not.toContain("_low confidence_")
    expect(text).not.toContain("_moderate confidence_")
  })
})

describe("lore-ask — decided_by trust line (DEFERRED-02)", () => {
  // The governance bucket renders `decided_by` facts via
  // `renderDecidedByLine`, which previously emitted only the
  // decision's `[status, confidence]` categorical label and never
  // the FACT's numeric trust signal. A `decided_by` fact whose
  // confidence has decayed (e.g. the entity-decision link has gone
  // long-uncited) was rendering as a fully trusted governance
  // statement. The fact-side trust line must surface here too,
  // mirroring the structure-bucket / Overdue Facts treatment, so
  // the highest-value governance path participates in the
  // dynamic-confidence contract.

  function decidedByServices(facts: Fact[], decision: Decision) {
    return {
      projects: { findByName: vi.fn() },
      facts: {
        queryByEntity: vi.fn().mockResolvedValue(facts),
        queryByObject: vi.fn().mockResolvedValue([]),
        touchOnRead: vi.fn().mockResolvedValue(undefined),
      },
      decisions: {
        getById: vi.fn().mockResolvedValue(decision),
      },
      memories: {
        getTitleById: vi.fn().mockResolvedValue(null),
        getManyById: vi.fn().mockResolvedValue([]),
        touchOnRead: vi.fn().mockResolvedValue(undefined),
      },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      entities: makeEntityService(),
      context: { project: null },
    }
  }

  async function invokeAsk(facts: Fact[], decision: Decision): Promise<string> {
    const mockServer = createMockServer()
    const svc = decidedByServices(facts, decision)
    registerKnowledgeTools(mockServer.server, svc as never)
    registerQueryTools(mockServer.server, svc as never)
    const handler = mockServer.getActionHandler("lore-query", "ask")
    const result = await handler({ entity: "AuthService" } as never)
    return (result as { content: Array<{ text: string }> }).content[0].text
  }

  it("renders the trust line on a low-confidence decided_by fact", async () => {
    // Score 0.15 is "very low confidence" per `formatTrustLabel`. The
    // trust line must surface between the title row and the ID footer
    // so a heavily-decayed governance link is visibly distinguished
    // from a freshly-cited one.
    const decision = makeDecision("dec-1", {
      title: "Adopt OIDC",
      status: "accepted",
    })
    const fact = makeFact("fact-decayed", {
      subject: "AuthService",
      predicate: "decided_by",
      object: "dec-1",
      sourceMemoryId: "dec-1",
      confidenceScore: 0.15,
    })
    const text = await invokeAsk([fact], decision)
    const lines = text.split("\n")
    const titleIdx = lines.findIndex(
      (l) => l.includes("decided by") && l.includes("AuthService")
    )
    expect(titleIdx).toBeGreaterThanOrEqual(0)
    expect(lines[titleIdx + 1]).toBe("  _very low confidence_")
    // ID footer follows the trust line, matching the
    // title → trust → ID envelope used by every other fact-side surface.
    expect(lines[titleIdx + 2]).toMatch(/^ {2}Decision ID:/)
  })

  it("omits the trust line on a null confidenceScore (pre-migration vault)", async () => {
    // Pre-DEFERRED-02 vault — `renderTrustLine(null, ...)` returns
    // null and the rendered output is byte-identical to pre-DEFERRED-02
    // for un-backfilled rows.
    const decision = makeDecision("dec-2", { title: "Adopt OIDC" })
    const fact = makeFact("fact-null", {
      subject: "AuthService",
      predicate: "decided_by",
      object: "dec-2",
      sourceMemoryId: "dec-2",
      confidenceScore: null,
    })
    const text = await invokeAsk([fact], decision)
    expect(text).toContain("decided by")
    expect(text).not.toContain("_very low confidence_")
    expect(text).not.toContain("_low confidence_")
    expect(text).not.toContain("_moderate confidence_")
  })

  it("omits the trust line on an above-threshold confidenceScore", async () => {
    const decision = makeDecision("dec-3", { title: "Adopt OIDC" })
    const fact = makeFact("fact-fresh", {
      subject: "AuthService",
      predicate: "decided_by",
      object: "dec-3",
      sourceMemoryId: "dec-3",
      confidenceScore: 0.85,
    })
    const text = await invokeAsk([fact], decision)
    expect(text).toContain("decided by")
    expect(text).not.toContain("_very low confidence_")
    expect(text).not.toContain("_low confidence_")
    expect(text).not.toContain("_moderate confidence_")
  })
})

describe("lore-ask — fact touch-on-read wiring (DEFERRED-02)", () => {
  // Pins the citation-as-evidence contract for the fact-side surface:
  // every fact actually displayed in `lore-query action='ask'` (visible
  // governance + visible structure, NOT the hidden-overflow tail) bumps
  // `Confidence Score` + `Last Referenced At` via
  // `services.facts.touchOnRead`. Mirror of the memory-side wake-up
  // touch-on-read tests in `context.test.ts`.
  //
  // Without these tests, `fireFactTouchOnRead`'s outer try/catch
  // would swallow a missing-method TypeError on a regression that
  // dropped the wiring, and the rest of the test suite would still
  // pass — the contract would be silently broken until production
  // dynamic-confidence stopped accumulating.

  function services(
    facts: Fact[],
    factsTouchOnRead: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)
  ) {
    return {
      projects: { findByName: vi.fn() },
      facts: {
        queryByEntity: vi.fn().mockResolvedValue(facts),
        queryByObject: vi.fn().mockResolvedValue([]),
        touchOnRead: factsTouchOnRead,
      },
      decisions: { getById: vi.fn() },
      memories: {
        getTitleById: vi.fn().mockResolvedValue(null),
        getManyById: vi.fn().mockResolvedValue([]),
        touchOnRead: vi.fn().mockResolvedValue(undefined),
      },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      entities: makeEntityService(),
      context: { project: null },
    }
  }

  async function invokeAsk(
    facts: Fact[],
    args: Record<string, unknown> = {},
    factsTouchOnRead?: ReturnType<typeof vi.fn>
  ): Promise<{ text: string; touchedIds: string[]; touchCount: number }> {
    const mockServer = createMockServer()
    const touchSpy = factsTouchOnRead ?? vi.fn().mockResolvedValue(undefined)
    const svc = services(facts, touchSpy)
    registerKnowledgeTools(mockServer.server, svc as never)
    registerQueryTools(mockServer.server, svc as never)
    const handler = mockServer.getActionHandler("lore-query", "ask")
    const result = await handler({ entity: "AuthService", ...args } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    const passed =
      touchSpy.mock.calls.length > 0 ? (touchSpy.mock.calls[0]![0] as Fact[]) : []
    return {
      text,
      touchedIds: passed.map((f) => f.id),
      touchCount: touchSpy.mock.calls.length,
    }
  }

  it("touches both visible governance and visible structure facts", async () => {
    // `handleAsk` partitions facts into governance (decided_by /
    // supersedes_decision) and structure buckets via
    // `groupFactsByClass`. The visible-slice contract: every row
    // shown to the agent counts as cited. Structure-bucket facts
    // surface via the visible structure slice; governance facts
    // (here `supersedes_decision`, no decision lookup needed)
    // surface via the visible governance slice.
    const facts: Fact[] = [
      makeFact("gov-1", {
        subject: "NewDecision",
        predicate: "supersedes_decision",
        object: "OldDecision",
      }),
      makeFact("struct-1", { predicate: "uses", object: "JWT" }),
      makeFact("struct-2", { predicate: "depends_on", object: "DB" }),
    ]
    const { touchedIds, touchCount } = await invokeAsk(facts)
    expect(touchCount).toBe(1)
    expect(new Set(touchedIds)).toEqual(new Set(["gov-1", "struct-1", "struct-2"]))
  })

  it("does not touch hidden-overflow facts past the per-bucket cap", async () => {
    // 8 structure facts > the default cap of 5. Only the top 5 are
    // rendered to the agent; the bottom 3 land in the `(3 hidden)`
    // suffix and must NOT be touched — bumping their Confidence Score
    // would inflate signal against rows that were never displayed.
    const facts: Fact[] = Array.from({ length: 8 }, (_, i) =>
      makeFact(`s-${i}`, {
        predicate: "uses",
        object: `Obj${i}`,
        // Unique validFrom desc so the top 5 are deterministic.
        validFrom: `2026-04-${String(10 + i).padStart(2, "0")}`,
      })
    )
    const { text, touchedIds, touchCount } = await invokeAsk(facts)
    expect(touchCount).toBe(1)
    // The hidden-count suffix proves the slice fired.
    expect(text).toContain("(3 hidden)")
    expect(touchedIds).toHaveLength(5)
    // The visible 5 are the highest validFrom rows (s-3 through s-7).
    // The hidden 3 (s-0, s-1, s-2) MUST NOT appear.
    for (const hiddenId of ["s-0", "s-1", "s-2"]) {
      expect(touchedIds).not.toContain(hiddenId)
    }
  })

  it("does not call facts.touchOnRead when there are no facts", async () => {
    // Empty result set — no facts surfaced, no touch. Pin the
    // empty-batch short-circuit at the MCP boundary so a future
    // refactor can't silently fire a no-op Notion call on every
    // ask response that has no facts.
    const { touchCount } = await invokeAsk([])
    expect(touchCount).toBe(0)
  })

  it("does not call facts.touchOnRead when only tasks surface (non-empty response, zero visible facts)", async () => {
    // Edge case: queryByEntity returns no facts but the Tasks bucket
    // has rows. `visibleFacts` is empty, so the empty-batch
    // short-circuit must still hold and no facts.touchOnRead call
    // fires. Pinned because the tasks-only path renders a non-empty
    // response while the fact-side cite list is genuinely empty —
    // a regression that flattened the guard could leak a no-op call.
    //
    // **Tasks must be non-empty.** The handler short-circuits with
    // `if (facts.length === 0 && tasks.length === 0) return ...`
    // BEFORE reaching the `fireFactTouchOnRead` call. Stubbing
    // `tasks.list` with `items: []` would make the test pass for
    // the wrong reason — through the all-empty early return rather
    // than through `fireFactTouchOnRead`'s `rows.length === 0`
    // guard. Inject one task so we actually exercise the
    // non-empty-response / zero-visible-facts branch.
    const factsTouchOnRead = vi.fn().mockResolvedValue(undefined)
    const mockServer = createMockServer()
    const svc = services([], factsTouchOnRead)
    svc.tasks.list = vi.fn().mockResolvedValue({
      items: [
        {
          id: "task-only",
          title: "Rotate JWT keys",
          taskState: "open",
          blockedBy: null,
          reviewBy: null,
          decidedAt: null,
          entity: "AuthService",
        },
      ],
    })
    registerKnowledgeTools(mockServer.server, svc as never)
    registerQueryTools(mockServer.server, svc as never)
    const handler = mockServer.getActionHandler("lore-query", "ask")
    const result = await handler({ entity: "AuthService" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    // Confirm the handler actually rendered the Tasks section — the
    // assertion that no fact-touch fired is meaningless if the early
    // all-empty return was hit instead.
    expect(text).toContain("### Tasks")
    expect(text).toContain("Rotate JWT keys")
    expect(factsTouchOnRead).not.toHaveBeenCalled()
  })

  it("does not surface a facts.touchOnRead failure as a tool error", async () => {
    // Advisory contract — a touch failure must NEVER fail the
    // surrounding `ask` response. Mirror of the memory-side advisory
    // test in `context.test.ts`.
    const facts: Fact[] = [makeFact("struct-1", { predicate: "uses", object: "JWT" })]
    const factsTouchOnRead = vi.fn().mockRejectedValue(new Error("notion 503"))
    const mockServer = createMockServer()
    const svc = services(facts, factsTouchOnRead)
    registerKnowledgeTools(mockServer.server, svc as never)
    registerQueryTools(mockServer.server, svc as never)
    const handler = mockServer.getActionHandler("lore-query", "ask")
    const result = await handler({ entity: "AuthService" } as never)
    expect((result as { isError?: boolean }).isError).not.toBe(true)
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("AuthService")
  })
})

describe("lore-ask projectName resolution", () => {
  it("returns an error when projectName does not resolve", async () => {
    const mockServer = createMockServer()
    const queryByEntity = vi.fn().mockResolvedValue([])

    const services = {
      projects: { findByName: vi.fn().mockResolvedValue(null) },
      facts: {
        queryByEntity,
        queryByObject: vi.fn(),
      },
      decisions: { getById: vi.fn() },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      memories: { getTitleById: vi.fn().mockResolvedValue(null) },
      entities: makeEntityService(),
      context: {
        project: {
          id: "proj-ambient",
          name: "Ambient",
          path: "",
          description: "",
        },
        isCatchAllFallback: false,
      },
      config: { vault: { pageId: "v1" }, projects: [] },
    }

    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-query", "ask")

    const result = await handler({ entity: "AuthService", projectName: "Typo" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(text).toContain('Project "Typo" could not be resolved')
    expect(text).toContain("Fix the project scope")
    expect(queryByEntity).not.toHaveBeenCalled()
  })
})

describe("lore-query action='ask' — issue #284 temporal recall threading", () => {
  function mkAskServices(queryByEntity: ReturnType<typeof vi.fn>) {
    return {
      projects: { findByName: vi.fn() },
      facts: { queryByEntity, queryByObject: vi.fn() },
      decisions: { getById: vi.fn() },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      memories: { getTitleById: vi.fn().mockResolvedValue(null) },
      entities: makeEntityService(),
      context: {
        project: {
          id: "proj-ambient",
          name: "Ambient",
          path: "",
          description: "",
        },
        isCatchAllFallback: false,
      },
      config: { vault: { pageId: "v1" }, projects: [] },
    }
  }

  it("threads asOf and includeHistory through to facts.queryByEntity", async () => {
    const mockServer = createMockServer()
    const queryByEntity = vi.fn().mockResolvedValue([])
    const services = mkAskServices(queryByEntity)

    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-query", "ask")

    await handler({
      entity: "AuthService",
      asOf: "2026-04-01",
      includeHistory: true,
    } as never)

    expect(queryByEntity).toHaveBeenCalledTimes(1)
    const callArgs = queryByEntity.mock.calls[0]![1] as {
      asOf?: string
      includeInvalidated?: boolean
    }
    expect(callArgs.asOf).toBe("2026-04-01")
    expect(callArgs.includeInvalidated).toBe(true)
  })

  it("omits asOf / includeInvalidated when not passed (byte-stable pre-#284 contract)", async () => {
    const mockServer = createMockServer()
    const queryByEntity = vi.fn().mockResolvedValue([])
    const services = mkAskServices(queryByEntity)

    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-query", "ask")

    await handler({ entity: "AuthService" } as never)

    expect(queryByEntity).toHaveBeenCalledTimes(1)
    const callArgs = queryByEntity.mock.calls[0]![1] as {
      asOf?: string
      includeInvalidated?: boolean
    }
    expect(callArgs.asOf).toBeUndefined()
    expect(callArgs.includeInvalidated).toBeUndefined()
  })

  it("renders invalidated facts with the INVALIDATED date inline", async () => {
    const mockServer = createMockServer()
    const invalidatedFact = makeFact("fact-old", {
      subject: "AuthService",
      predicate: "uses",
      object: "LegacyAuth",
      validFrom: "2026-01-01",
      validUntil: "2026-03-15",
      invalidatedAt: "2026-03-15",
    })
    const queryByEntity = vi.fn().mockResolvedValue([invalidatedFact])
    const services = mkAskServices(queryByEntity)

    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-query", "ask")

    const result = await handler({
      entity: "AuthService",
      includeHistory: true,
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text

    expect(text).toContain("INVALIDATED on 2026-03-15")
  })

  it("suppresses the INVALIDATED segment on an asOf recall when the invalidation date is after the cutoff (R3 blocker)", async () => {
    // Server-side filter is "live at asOf" — facts invalidated AFTER
    // asOf are deliberately returned because they were live from
    // Lore's perspective at the requested date. The renderer must
    // NOT leak the post-asOf invalidation date into the answer, or
    // the as-of mental model breaks (an answer "what did Lore know
    // at 2026-04-01?" cannot report invalidations that happened in
    // May).
    const mockServer = createMockServer()
    const fact = makeFact("fact-late-inval", {
      subject: "AuthService",
      predicate: "uses",
      object: "LegacyAuth",
      validFrom: "2026-01-01",
      validUntil: "2026-05-01",
      observedAt: "2026-01-01",
      invalidatedAt: "2026-05-01",
    })
    const queryByEntity = vi.fn().mockResolvedValue([fact])
    const services = mkAskServices(queryByEntity)

    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-query", "ask")

    const result = await handler({
      entity: "AuthService",
      asOf: "2026-04-01",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text

    // The fact surfaces (live from Lore's perspective at 2026-04-01).
    expect(text).toContain("fact-late-inval")
    // But its post-asOf invalidation date is hidden — the renderer
    // suppresses the segment because invalidatedAt > asOf.
    expect(text).not.toContain("INVALIDATED on 2026-05-01")
  })

  it("still renders INVALIDATED when the invalidation date is on or before the asOf cutoff (R3 blocker)", async () => {
    // Boundary: an invalidation that landed before or exactly at
    // asOf was knowable to Lore at the cutoff and should render.
    // Combined with `includeHistory: true` the filter surfaces it.
    const mockServer = createMockServer()
    const fact = makeFact("fact-early-inval", {
      subject: "AuthService",
      predicate: "uses",
      object: "LegacyAuth",
      validFrom: "2026-01-01",
      validUntil: "2026-02-15",
      observedAt: "2026-01-01",
      invalidatedAt: "2026-02-15",
    })
    const queryByEntity = vi.fn().mockResolvedValue([fact])
    const services = mkAskServices(queryByEntity)

    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-query", "ask")

    const result = await handler({
      entity: "AuthService",
      asOf: "2026-04-01",
      includeHistory: true,
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text

    expect(text).toContain("INVALIDATED on 2026-02-15")
  })

  it("rejects malformed asOf at the MCP boundary", async () => {
    const mockServer = createMockServer()
    const queryByEntity = vi.fn().mockResolvedValue([])
    const services = mkAskServices(queryByEntity)

    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-query", "ask")

    const result = await handler({
      entity: "AuthService",
      asOf: "yesterday",
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(queryByEntity).not.toHaveBeenCalled()
  })
})

describe("lore-fact action='invalidate' — issue #284 sourceMemoryId threading", () => {
  function mkInvalidateServices(invalidate: ReturnType<typeof vi.fn>) {
    return {
      projects: { findByName: vi.fn() },
      facts: {
        invalidate,
        getById: vi.fn().mockResolvedValue(null),
        createWithDedup: vi.fn(),
        extendReview: vi.fn(),
        queryByEntity: vi.fn(),
        queryByObject: vi.fn(),
      },
      memories: {
        getById: vi.fn(),
        getPropertiesById: vi.fn().mockResolvedValue(null),
      },
      decisions: { getById: vi.fn() },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      entities: makeEntityService(),
      context: {
        project: { id: "p1", name: "P1", path: "", description: "" },
        isCatchAllFallback: false,
      },
      sessionMemories: { get: vi.fn() },
      wakeupCache: { invalidate: vi.fn(), bumpEpoch: vi.fn() },
      identity: { resolveAuthor: vi.fn() },
      config: { vault: { pageId: "v1" }, projects: [] },
    }
  }

  it("forwards sourceMemoryId to FactService.invalidate after passing the provenance precheck", async () => {
    const mockServer = createMockServer()
    const invalidate = vi.fn().mockResolvedValue(undefined)
    const services = mkInvalidateServices(invalidate)
    // Precheck reads the invalidating memory + the fact's project scope
    // (#284 review item #3). Wire compatible scopes so the precheck passes.
    services.memories.getPropertiesById = vi
      .fn()
      .mockResolvedValue({ id: "mem-contradiction", projectIds: ["proj-a"] })
    services.facts.getById = vi
      .fn()
      .mockResolvedValue(makeFact("fact-1", { projectIds: ["proj-a"] }))

    registerKnowledgeTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-fact", "invalidate")

    await handler({
      factId: "fact-1",
      sourceMemoryId: "mem-contradiction",
    } as never)

    expect(invalidate).toHaveBeenCalledWith("fact-1", {
      sourceMemoryId: "mem-contradiction",
    })
  })

  it("omits the options arg when sourceMemoryId is not threaded (byte-stable)", async () => {
    const mockServer = createMockServer()
    const invalidate = vi.fn().mockResolvedValue(undefined)
    const services = mkInvalidateServices(invalidate)

    registerKnowledgeTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-fact", "invalidate")

    await handler({ factId: "fact-1" } as never)

    expect(invalidate).toHaveBeenCalledWith("fact-1")
  })

  it("rejects when sourceMemoryId does not resolve to a live memory (issue #284 review item #3)", async () => {
    const mockServer = createMockServer()
    const invalidate = vi.fn().mockResolvedValue(undefined)
    const services = mkInvalidateServices(invalidate)
    // getPropertiesById throws when the memory is missing / archived.
    services.memories.getPropertiesById = vi
      .fn()
      .mockRejectedValue(new Error("not found"))
    services.facts.getById = vi
      .fn()
      .mockResolvedValue(makeFact("fact-1", { projectIds: ["proj-a"] }))

    registerKnowledgeTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-fact", "invalidate")

    const result = await handler({
      factId: "fact-1",
      sourceMemoryId: "ghost-mem",
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain("invalidation-source-unresolved")
    expect(invalidate).not.toHaveBeenCalled()
  })

  it("rejects when sourceMemoryId is in an incompatible project (issue #284 review item #3)", async () => {
    const mockServer = createMockServer()
    const invalidate = vi.fn().mockResolvedValue(undefined)
    const services = mkInvalidateServices(invalidate)
    services.memories.getPropertiesById = vi
      .fn()
      .mockResolvedValue({ id: "mem-x", projectIds: ["proj-b"] })
    services.facts.getById = vi
      .fn()
      .mockResolvedValue(makeFact("fact-1", { projectIds: ["proj-a"] }))

    registerKnowledgeTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-fact", "invalidate")

    const result = await handler({
      factId: "fact-1",
      sourceMemoryId: "mem-x",
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain("invalidation-source-cross-project")
    expect(invalidate).not.toHaveBeenCalled()
  })

  it("surfaces transient 429 / 5xx during the precheck instead of swallowing it as invalidation-source-unresolved (R5 nit)", async () => {
    // Pre-fix the bare `catch {}` collapsed every getPropertiesById
    // failure (404, RestrictedResource, archived, transient
    // 429/5xx) into the same user-facing
    // `invalidation-source-unresolved` error. Operators triaging
    // a real outage couldn't tell that the precheck blew up on a
    // rate-limit blip vs a genuine missing memory. The narrowed
    // catch reroutes transients to the outer toolError so the agent
    // sees the actual Notion error.
    const mockServer = createMockServer()
    const invalidate = vi.fn().mockResolvedValue(undefined)
    const services = mkInvalidateServices(invalidate)
    const transient = Object.assign(new Error("Rate limited"), {
      code: "rate_limited",
      status: 429,
    })
    services.memories.getPropertiesById = vi.fn().mockRejectedValue(transient)
    services.facts.getById = vi
      .fn()
      .mockResolvedValue(makeFact("fact-1", { projectIds: ["proj-a"] }))

    registerKnowledgeTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-fact", "invalidate")

    const result = await handler({
      factId: "fact-1",
      sourceMemoryId: "mem-x",
    } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text
    // Surfaces the transient error verbatim — NOT the misleading
    // `invalidation-source-unresolved` message.
    expect(text).toContain("Rate limited")
    expect(text).not.toContain("invalidation-source-unresolved")
    expect(invalidate).not.toHaveBeenCalled()
  })

  it("accepts vault-wide source memory against a scoped fact (issue #284 review item #3)", async () => {
    const mockServer = createMockServer()
    const invalidate = vi.fn().mockResolvedValue(undefined)
    const services = mkInvalidateServices(invalidate)
    services.memories.getPropertiesById = vi
      .fn()
      .mockResolvedValue({ id: "mem-x", projectIds: [] }) // vault-wide
    services.facts.getById = vi
      .fn()
      .mockResolvedValue(makeFact("fact-1", { projectIds: ["proj-a"] }))

    registerKnowledgeTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-fact", "invalidate")

    const result = await handler({
      factId: "fact-1",
      sourceMemoryId: "mem-x",
    } as never)

    expect((result as { isError?: boolean }).isError).toBeFalsy()
    expect(invalidate).toHaveBeenCalledWith("fact-1", { sourceMemoryId: "mem-x" })
  })
})

describe("lore-fact action='create' — tracking-predicate Zod rejection", () => {
  // Acceptance criterion (#23, line 452-455): the contracted
  // active profile's writable predicate list drives validation at the dispatcher
  // boundary, so each tracking predicate string fails at parse time
  // rather than via the deleted `trackingPredicateRedirect` helper.
  // Pin all three values so widening the writable list (intentionally
  // or by paste) shows up as failing tests.
  function makeServices() {
    const createWithDedup = vi.fn()
    return {
      services: {
        projects: { findByName: vi.fn() },
        facts: {
          createWithDedup,
          create: vi.fn(),
          queryByEntity: vi.fn(),
          queryByObject: vi.fn(),
        },
        decisions: { getById: vi.fn() },
        context: { project: null },
        sessionMemories: { record: vi.fn(), get: vi.fn() },
        identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
        entities: makeEntityService(),
      },
      createWithDedup,
    }
  }

  for (const predicate of ["needs_action", "waiting_on", "blocked_by"] as const) {
    it(`rejects predicate='${predicate}' at the dispatcher with a parse error`, async () => {
      const mockServer = createMockServer()
      const { services, createWithDedup } = makeServices()
      registerKnowledgeTools(mockServer.server, services as never)
      const loreFactCreate = mockServer.getActionHandler("lore-fact", "create")

      const result = await loreFactCreate({
        subject: "PR #25700",
        predicate,
        object: "Engineering",
      } as never)

      const payload = result as { content: Array<{ text: string }>; isError?: boolean }
      expect(payload.isError).toBe(true)
      expect(payload.content[0].text).toContain("predicate")
      // The handler must NOT have been reached — Zod's enum check
      // fires before dispatch, so no service call is issued.
      expect(createWithDedup).not.toHaveBeenCalled()
    })
  }
})

describe("lore-fact date validation", () => {
  function makeCreateServices() {
    const createWithDedup = vi.fn().mockImplementation(async (input) => ({
      fact: makeFact("fact-created", {
        subject: input.subject,
        predicate: input.predicate,
        object: input.object,
        reviewBy: input.reviewBy ?? null,
      }),
      deduped: false,
      enriched: [],
    }))
    return {
      services: {
        projects: { findByName: vi.fn() },
        facts: {
          createWithDedup,
          queryByEntity: vi.fn(),
          queryByObject: vi.fn(),
        },
        decisions: { getById: vi.fn() },
        memories: {
          getPropertiesById: vi.fn().mockResolvedValue({
            id: "mem-source",
            projectIds: [],
          }),
        },
        context: { project: null },
        sessionMemories: { record: vi.fn(), get: vi.fn() },
        identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
        entities: makeEntityService(),
      },
      createWithDedup,
    }
  }

  it("treats reviewBy: null on create as no initial review date", async () => {
    const mockServer = createMockServer()
    const { services, createWithDedup } = makeCreateServices()
    registerKnowledgeTools(mockServer.server, services as never)
    const create = mockServer.getActionHandler("lore-fact", "create")

    const result = await create({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      sourceMemoryId: "mem-source",
      confidence: "likely",
      reviewBy: null,
    } as never)

    expect((result as { isError?: boolean }).isError).toBeFalsy()
    expect(createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({ reviewBy: undefined })
    )
  })

  it("normalizes reviewBy: empty string on create to no initial review date", async () => {
    const mockServer = createMockServer()
    const { services, createWithDedup } = makeCreateServices()
    registerKnowledgeTools(mockServer.server, services as never)
    const create = mockServer.getActionHandler("lore-fact", "create")

    const result = await create({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      sourceMemoryId: "mem-source",
      confidence: "likely",
      reviewBy: "",
    } as never)

    expect((result as { isError?: boolean }).isError).toBeFalsy()
    expect(createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({ reviewBy: undefined })
    )
  })

  it("threads reviewBy: null on extend through as an explicit clear", async () => {
    const mockServer = createMockServer()
    const extendReview = vi.fn().mockResolvedValue(undefined)
    registerKnowledgeTools(mockServer.server, { facts: { extendReview } } as never)
    const extend = mockServer.getActionHandler("lore-fact", "extend")

    await extend({ factId: "fact-1", reviewBy: null } as never)

    expect(extendReview).toHaveBeenCalledWith("fact-1", null)
  })

  it("normalizes reviewBy: empty string on extend to an explicit clear", async () => {
    const mockServer = createMockServer()
    const extendReview = vi.fn().mockResolvedValue(undefined)
    registerKnowledgeTools(mockServer.server, { facts: { extendReview } } as never)
    const extend = mockServer.getActionHandler("lore-fact", "extend")

    await extend({ factId: "fact-1", reviewBy: "" } as never)

    expect(extendReview).toHaveBeenCalledWith("fact-1", null)
  })

  it("rejects malformed review dates before fact mutation", async () => {
    const mockServer = createMockServer()
    const extendReview = vi.fn()
    registerKnowledgeTools(mockServer.server, { facts: { extendReview } } as never)
    const extend = mockServer.getActionHandler("lore-fact", "extend")

    const result = await extend({ factId: "fact-1", reviewBy: "05/03/2026" } as never)

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(extendReview).not.toHaveBeenCalled()
  })
})

describe("lore-fact action='create' projectName resolution", () => {
  it("rejects an unresolved explicit projectName before creating a fact", async () => {
    const mockServer = createMockServer()
    const createWithDedup = vi.fn()
    const services = {
      projects: { findByName: vi.fn().mockResolvedValue(null) },
      facts: {
        createWithDedup,
        queryByEntity: vi.fn(),
        queryByObject: vi.fn(),
      },
      decisions: { getById: vi.fn() },
      context: { project: { id: "proj-ambient", name: "Ambient" } },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerKnowledgeTools(mockServer.server, services as never)
    const create = mockServer.getActionHandler("lore-fact", "create")

    const result = await create({
      subject: "AuthService",
      predicate: "depends_on",
      object: "Database",
      sourceMemoryId: "mem-source",
      confidence: "likely",
      projectName: "Missing",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(text).toContain('Project "Missing" could not be resolved')
    expect(text).toContain("Fix the project scope")
    expect(createWithDedup).not.toHaveBeenCalled()
  })

  it("rejects mixed projectNames atomically before creating a fact", async () => {
    const mockServer = createMockServer()
    const createWithDedup = vi.fn()
    const findByName = vi.fn(async (name: string) =>
      name === "Widget" ? { id: "proj-widget", name: "Widget" } : null
    )
    const services = {
      projects: { findByName },
      facts: {
        createWithDedup,
        queryByEntity: vi.fn(),
        queryByObject: vi.fn(),
      },
      decisions: { getById: vi.fn() },
      context: { project: { id: "proj-ambient", name: "Ambient" } },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }

    registerKnowledgeTools(mockServer.server, services as never)
    const create = mockServer.getActionHandler("lore-fact", "create")

    const result = await create({
      subject: "AuthService",
      predicate: "depends_on",
      object: "Database",
      sourceMemoryId: "mem-source",
      confidence: "likely",
      projectNames: ["Widget", "Missing"],
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(text).toContain('Project "Missing" could not be resolved')
    expect(findByName).toHaveBeenCalledWith("Widget")
    expect(findByName).toHaveBeenCalledWith("Missing")
    expect(createWithDedup).not.toHaveBeenCalled()
  })
})

describe("lore-learn sourceMemoryId discipline", () => {
  const memoriesDb = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function makeSourceMemory(id: string, projectIds: string[] = []) {
    return { id, projectIds }
  }

  function makeRetrievedSourcePage(
    id: string,
    overrides: Partial<PageObjectResponse> = {}
  ): PageObjectResponse {
    return {
      object: "page",
      id,
      created_time: "2026-01-01T00:00:00.000Z",
      last_edited_time: "2026-01-02T00:00:00.000Z",
      archived: false,
      properties: {
        Title: { type: "title", title: [{ plain_text: `Memory ${id}` }] },
        Project: { type: "relation", relation: [] },
      } as unknown as PageObjectResponse["properties"],
      parent: { type: "database_id", database_id: memoriesDb.databaseId },
      url: `https://notion.so/${id}`,
      ...overrides,
    } as PageObjectResponse
  }

  function makeMemoryServiceForPage(page: PageObjectResponse) {
    const client = {
      pages: {
        retrieve: vi.fn(async () => page),
      },
    } as unknown as Client
    return new MemoryService(client, memoriesDb)
  }

  function makeServices(overrides: Record<string, unknown> = {}) {
    return {
      projects: { findByName: vi.fn() },
      memories: {
        getPropertiesById: vi
          .fn()
          .mockImplementation(async (id: string) => makeSourceMemory(id)),
      },
      facts: {
        create: vi.fn().mockImplementation(async (input) =>
          makeFact("fact-created", {
            subject: input.subject,
            predicate: input.predicate,
            object: input.object,
            sourceMemoryId: input.sourceMemoryId ?? null,
            confidence: "likely",
          })
        ),
        createWithDedup: vi.fn().mockImplementation(async (input) => ({
          fact: makeFact("fact-created", {
            subject: input.subject,
            predicate: input.predicate,
            object: input.object,
            sourceMemoryId: input.sourceMemoryId ?? null,
            confidence: "likely",
          }),
          deduped: false,
          enriched: [],
        })),
        queryByEntity: vi.fn(),
        queryByObject: vi.fn(),
      },
      decisions: { getById: vi.fn() },
      context: { project: null },
      sessionMemories: {
        // Defaults — tests override per-case.
        record: vi.fn(),
        get: vi.fn().mockReturnValue(undefined),
      },
      entities: makeEntityService(),
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
      ...overrides,
    }
  }

  it("rejects missing provenance at the schema boundary before writing the fact", async () => {
    const mockServer = createMockServer()
    const services = makeServices()
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreLearn = mockServer.getActionHandler("lore-fact", "create")

    const result = await loreLearn({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBe(true)
    expect(payload.content[0].text).toContain("Error: lore-fact: sourceMemoryId:")
    expect(payload.content[0].text).toContain("provenance-missing")
    expect(services.facts.createWithDedup).not.toHaveBeenCalled()
  })

  it.each([
    ["agent only", { agent: "claude" }],
    ["session only", { session: "session-abc" }],
    ["whitespace session", { agent: "claude", session: "  " }],
  ])(
    "rejects malformed session provenance at the schema boundary: %s",
    async (_name, partial) => {
      const mockServer = createMockServer()
      const services = makeServices()
      registerKnowledgeTools(mockServer.server, services as never)
      registerQueryTools(mockServer.server, services as never)
      const loreLearn = mockServer.getActionHandler("lore-fact", "create")

      const result = await loreLearn({
        subject: "AuthService",
        predicate: "uses",
        object: "JWT",
        ...partial,
      } as never)

      const payload = result as { content: Array<{ text: string }>; isError?: boolean }
      expect(payload.isError).toBe(true)
      expect(payload.content[0].text).toContain("Error: lore-fact: sourceMemoryId:")
      expect(payload.content[0].text).toContain("provenance-missing")
      expect(services.facts.createWithDedup).not.toHaveBeenCalled()
    }
  )

  it("creates the fact when sourceMemoryId is passed explicitly", async () => {
    const mockServer = createMockServer()
    const services = makeServices()
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreLearn = mockServer.getActionHandler("lore-fact", "create")

    const result = await loreLearn({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      sourceMemoryId: "mem-explicit",
      confidence: "likely",
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBeFalsy()
    expect(payload.content[0].text).toContain("Source: mem-explicit")
    expect(payload.content[0].text).not.toContain("WARNING")
    expect(services.memories.getPropertiesById).toHaveBeenCalledWith("mem-explicit")
    expect(services.facts.createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMemoryId: "mem-explicit" })
    )
  })

  it("rejects unresolved explicit sourceMemoryId before entity or fact writes", async () => {
    const mockServer = createMockServer()
    const resolveOrCreateEntity = vi.fn()
    const services = makeServices({
      entities: { resolveOrCreateEntity },
      memories: {
        getPropertiesById: vi.fn().mockRejectedValue(new Error("not found")),
      },
    })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreLearn = mockServer.getActionHandler("lore-fact", "create")

    const result = await loreLearn({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      sourceMemoryId: "mem-typo",
      confidence: "likely",
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBe(true)
    expect(payload.content[0].text).toContain("provenance-source-unresolved")
    expect(payload.content[0].text).toContain("mem-typo")
    expect(services.facts.createWithDedup).not.toHaveBeenCalled()
    expect(resolveOrCreateEntity).not.toHaveBeenCalled()
  })

  it("rejects explicit sourceMemoryId from another database before entity or fact writes", async () => {
    const mockServer = createMockServer()
    const resolveOrCreateEntity = vi.fn()
    const services = makeServices({
      entities: { resolveOrCreateEntity },
      memories: makeMemoryServiceForPage(
        makeRetrievedSourcePage("fact-page", {
          parent: { type: "database_id", database_id: "facts-db" },
        })
      ),
    })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreLearn = mockServer.getActionHandler("lore-fact", "create")

    const result = await loreLearn({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      sourceMemoryId: "fact-page",
      confidence: "likely",
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBe(true)
    expect(payload.content[0].text).toContain("provenance-source-unresolved")
    expect(payload.content[0].text).toContain("live Memories row")
    expect(services.facts.createWithDedup).not.toHaveBeenCalled()
    expect(resolveOrCreateEntity).not.toHaveBeenCalled()
  })

  it("rejects archived explicit sourceMemoryId before entity or fact writes", async () => {
    const mockServer = createMockServer()
    const resolveOrCreateEntity = vi.fn()
    const services = makeServices({
      entities: { resolveOrCreateEntity },
      memories: makeMemoryServiceForPage(
        makeRetrievedSourcePage("mem-archived", { archived: true })
      ),
    })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreLearn = mockServer.getActionHandler("lore-fact", "create")

    const result = await loreLearn({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      sourceMemoryId: "mem-archived",
      confidence: "likely",
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBe(true)
    expect(payload.content[0].text).toContain("provenance-source-unresolved")
    expect(payload.content[0].text).toContain("live Memories row")
    expect(services.facts.createWithDedup).not.toHaveBeenCalled()
    expect(resolveOrCreateEntity).not.toHaveBeenCalled()
  })

  it("rejects project-incompatible explicit sourceMemoryId before entity or fact writes", async () => {
    const mockServer = createMockServer()
    const resolveOrCreateEntity = vi.fn()
    const services = makeServices({
      entities: { resolveOrCreateEntity },
      projects: {
        findByName: vi.fn().mockResolvedValue({ id: "proj-server", name: "server" }),
      },
      memories: {
        getPropertiesById: vi
          .fn()
          .mockResolvedValue(makeSourceMemory("mem-ios", ["proj-ios"])),
      },
    })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreLearn = mockServer.getActionHandler("lore-fact", "create")

    const result = await loreLearn({
      subject: "EventQueue",
      predicate: "uses",
      object: "RMQ",
      projectName: "server",
      sourceMemoryId: "mem-ios",
      confidence: "likely",
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBe(true)
    expect(payload.content[0].text).toContain("provenance-source-cross-project")
    expect(payload.content[0].text).toContain("different project")
    expect(services.facts.createWithDedup).not.toHaveBeenCalled()
    expect(resolveOrCreateEntity).not.toHaveBeenCalled()
  })

  it("auto-links sourceMemoryId from the session tracker when the caller omits it", async () => {
    // Core P1-09 auto-link path: a `lore-learn` call that omits
    // sourceMemoryId picks up the memory saved earlier in the same
    // (agent, session). Tracker value includes project scope so the
    // downstream compatibility check gets real data.
    const mockServer = createMockServer()
    const services = makeServices({
      sessionMemories: {
        record: vi.fn(),
        get: vi.fn().mockImplementation((key: { agent?: string; session?: string }) => {
          if (key.agent === "claude" && key.session === "session-abc") {
            return { memoryId: "mem-from-session", projectIds: [] }
          }
          return undefined
        }),
      },
    })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreLearn = mockServer.getActionHandler("lore-fact", "create")

    const result = await loreLearn({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      session: "session-abc",
      agent: "claude",
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBeFalsy()
    expect(payload.content[0].text).toContain("auto-linked from session")
    expect(payload.content[0].text).toContain("mem-from-session")
    expect(services.facts.createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMemoryId: "mem-from-session" })
    )
  })

  it("prefers the explicitly-passed sourceMemoryId over the session candidate", async () => {
    const mockServer = createMockServer()
    const sessionGet = vi
      .fn()
      .mockReturnValue({ memoryId: "mem-from-session", projectIds: ["proj-ios"] })
    const services = makeServices({
      projects: {
        findByName: vi.fn().mockResolvedValue({ id: "proj-server", name: "server" }),
      },
      sessionMemories: {
        record: vi.fn(),
        get: sessionGet,
      },
    })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreLearn = mockServer.getActionHandler("lore-fact", "create")

    await loreLearn({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      projectName: "server",
      session: "session-abc",
      agent: "claude",
      sourceMemoryId: "mem-explicit",
      confidence: "likely",
    } as never)

    expect(services.facts.createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMemoryId: "mem-explicit" })
    )
    expect(services.memories.getPropertiesById).toHaveBeenCalledWith("mem-explicit")
    expect(sessionGet).not.toHaveBeenCalled()
  })

  it("rejects auto-link when session memory's project is disjoint from the fact's project", async () => {
    // Reviewer blocker #2: an iOS-scoped memory must not silently become the
    // source for a server-scoped fact. The memory and the fact are both
    // scoped; their project sets do not intersect, so the create must fail
    // before the fact write unless the caller passes an explicit source.
    const mockServer = createMockServer()
    const resolveOrCreateEntity = vi.fn()
    const projectsFindByName = vi.fn().mockImplementation(async (name: string) => {
      if (name === "server") return { id: "proj-server", name: "server" }
      return null
    })
    const services = makeServices({
      entities: { resolveOrCreateEntity },
      projects: { findByName: projectsFindByName },
      sessionMemories: {
        record: vi.fn(),
        get: vi.fn().mockReturnValue({ memoryId: "mem-ios", projectIds: ["proj-ios"] }),
      },
    })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreLearn = mockServer.getActionHandler("lore-fact", "create")

    const result = await loreLearn({
      subject: "EventQueue",
      predicate: "uses",
      object: "RMQ",
      projectName: "server",
      session: "s1",
      agent: "claude",
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBe(true)
    expect(payload.content[0].text).toContain("provenance-cross-project")
    expect(payload.content[0].text).toContain("different project")
    expect(services.facts.createWithDedup).not.toHaveBeenCalled()
    expect(resolveOrCreateEntity).not.toHaveBeenCalled()
  })

  it("accepts auto-link when fact has no project scope (vault-wide fact)", async () => {
    // A vault-wide fact can legitimately accept any scoped memory as source.
    // This is the symmetric case to the previous test.
    const mockServer = createMockServer()
    const services = makeServices({
      sessionMemories: {
        record: vi.fn(),
        get: vi.fn().mockReturnValue({ memoryId: "mem-ios", projectIds: ["proj-ios"] }),
      },
    })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreLearn = mockServer.getActionHandler("lore-fact", "create")

    const result = await loreLearn({
      subject: "Framework",
      predicate: "is_a",
      object: "JS lib",
      session: "s1",
      agent: "claude",
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.content[0].text).toContain("auto-linked from session")
    expect(services.facts.createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMemoryId: "mem-ios" })
    )
  })

  it("accepts auto-link when session memory has no project scope (vault-wide memory)", async () => {
    // A vault-wide memory can support a scoped fact — symmetric case.
    const mockServer = createMockServer()
    const services = makeServices({
      projects: {
        findByName: vi.fn().mockResolvedValue({ id: "proj-server", name: "server" }),
      },
      sessionMemories: {
        record: vi.fn(),
        get: vi.fn().mockReturnValue({ memoryId: "mem-global", projectIds: [] }),
      },
    })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreLearn = mockServer.getActionHandler("lore-fact", "create")

    const result = await loreLearn({
      subject: "EventQueue",
      predicate: "uses",
      object: "RMQ",
      projectName: "server",
      session: "s1",
      agent: "claude",
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.content[0].text).toContain("auto-linked from session")
    expect(services.facts.createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMemoryId: "mem-global" })
    )
  })

  it("rejects when session is present but the tracker has no entry", async () => {
    const mockServer = createMockServer()
    const resolveOrCreateEntity = vi.fn()
    const services = makeServices({
      entities: { resolveOrCreateEntity },
      sessionMemories: {
        record: vi.fn(),
        get: vi.fn().mockReturnValue(undefined),
      },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreLearn = mockServer.getActionHandler("lore-fact", "create")

    const result = await loreLearn({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      session: "session-without-memory",
      agent: "claude",
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBe(true)
    expect(payload.content[0].text).toContain("provenance-unresolved")
    expect(payload.content[0].text).toContain("did not resolve")
    expect(services.facts.createWithDedup).not.toHaveBeenCalled()
    expect(resolveOrCreateEntity).not.toHaveBeenCalled()
  })
})

describe("lore-audit projectName resolution", () => {
  it("returns an explicit error when projectName does not resolve", async () => {
    // lore-audit surfaces destructive follow-up actions (mark reviewed,
    // supersede) — silent fallback would let the caller act on the wrong
    // project's overdue queue.
    const mockServer = createMockServer()
    const queryOverdueFacts = vi.fn()
    const queryOverdueDecisions = vi.fn()
    const queryOverdueTasks = vi.fn()

    const services = {
      projects: { findByName: vi.fn().mockResolvedValue(null) },
      facts: { queryOverdue: queryOverdueFacts },
      decisions: { queryOverdue: queryOverdueDecisions },
      tasks: { queryOverdue: queryOverdueTasks },
      context: { project: { id: "proj-ambient", name: "Ambient" } },
    }

    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-query", "audit")

    const result = await handler({ projectName: "Typo" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain('Project "Typo" could not be resolved')
    expect(text).toContain("Fix the project scope")
    expect(queryOverdueFacts).not.toHaveBeenCalled()
    expect(queryOverdueDecisions).not.toHaveBeenCalled()
    expect(queryOverdueTasks).not.toHaveBeenCalled()
  })
})

describe("lore-query action='audit' overdue tasks", () => {
  function auditServices(opts?: {
    facts?: Fact[]
    decisions?: Decision[]
    tasks?: TaskSummary[]
    projectId?: string | null
  }) {
    return {
      projects: {
        findByName: vi
          .fn()
          .mockResolvedValue(
            opts?.projectId
              ? { id: opts.projectId, name: "Named Project", path: "named" }
              : null
          ),
      },
      facts: { queryOverdue: vi.fn().mockResolvedValue(opts?.facts ?? []) },
      decisions: {
        queryOverdue: vi.fn().mockResolvedValue(opts?.decisions ?? []),
      },
      tasks: { queryOverdue: vi.fn().mockResolvedValue(opts?.tasks ?? []) },
      context: { project: null },
    }
  }

  it("renders overdue tasks when no facts or decisions are overdue", async () => {
    const task = makeTask("task-overdue", {
      title: "Refresh Notion auth runbook",
      taskState: "blocked",
      blockedBy: "owner review",
      entity: "Auth docs",
      reviewBy: "2026-01-01",
    })
    const services = auditServices({ tasks: [task] })
    const mockServer = createMockServer()
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-query", "audit")

    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("## Overdue Tasks (1)")
    expect(text).toContain(
      "- **Refresh Notion auth runbook** [blocked, blocked by owner review] | entity Auth docs"
    )
    expect(text).toContain("Review by: 2026-01-01")
    expect(text).toContain("ID: task-overdue")
    expect(text).not.toContain("No overdue facts, decisions, or tasks found.")
    expect(text).toContain("Task — close")
    expect(text).toContain("Task — update due date")
    expect(text).toContain("Task — unblock")
    expect(text).toContain("Task — cancel")
  })

  it("renders facts, decisions, and tasks together with the requested project scope", async () => {
    const fact = makeFact("fact-overdue", {
      subject: "AuditSurface",
      predicate: "uses",
      object: "ReviewBy",
      reviewBy: "2026-01-01",
    })
    const decision = makeDecision("decision-overdue", {
      title: "Keep review dates visible",
      reviewBy: "2026-01-02",
    })
    const task = makeTask("task-overdue", {
      title: "Close reviewed work",
      reviewBy: "2026-01-03",
    })
    const services = auditServices({
      facts: [fact],
      decisions: [decision],
      tasks: [task],
      projectId: "proj-named",
    })
    const mockServer = createMockServer()
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-query", "audit")

    const result = await handler({ projectName: "Named Project" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("## Overdue Facts (1)")
    expect(text).toContain("## Overdue Decisions (1)")
    expect(text).toContain("## Overdue Tasks (1)")
    expect(text.indexOf("## Overdue Facts")).toBeLessThan(
      text.indexOf("## Overdue Decisions")
    )
    expect(text.indexOf("## Overdue Decisions")).toBeLessThan(
      text.indexOf("## Overdue Tasks")
    )
    expect(services.facts.queryOverdue).toHaveBeenCalledWith({ projectId: "proj-named" })
    expect(services.decisions.queryOverdue).toHaveBeenCalledWith({
      projectId: "proj-named",
    })
    expect(services.tasks.queryOverdue).toHaveBeenCalledWith({ projectId: "proj-named" })
  })

  it("reports no overdue sources only when facts, decisions, and tasks are empty", async () => {
    const services = auditServices()
    const mockServer = createMockServer()
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-query", "audit")

    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toBe("No overdue facts, decisions, or tasks found.")
  })

  it("warns and still renders facts when overdue task lookup fails", async () => {
    const fact = makeFact("fact-overdue", {
      subject: "AuditSurface",
      predicate: "uses",
      object: "ReviewBy",
      reviewBy: "2026-01-01",
    })
    const services = auditServices({ facts: [fact] })
    services.tasks.queryOverdue = vi.fn().mockRejectedValue(new Error("transient 5xx"))
    const mockServer = createMockServer()
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-query", "audit")

    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("## Overdue Facts (1)")
    expect(text).toContain("AuditSurface")
    expect(text).toContain("Warnings:")
    expect(text).toContain("Tasks lookup failed: transient 5xx")
  })

  it("does not claim tasks were checked when overdue task lookup fails with no other overdue sources", async () => {
    const services = auditServices()
    services.tasks.queryOverdue = vi.fn().mockRejectedValue(new Error("transient 5xx"))
    const mockServer = createMockServer()
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-query", "audit")

    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain(
      "No overdue facts or decisions found. Overdue tasks could not be checked."
    )
    expect(text).toContain("Warnings: Tasks lookup failed: transient 5xx")
  })

  it("warns and skips task rows that do not satisfy the overdue invariant", async () => {
    const valid = makeTask("task-valid", {
      title: "Close reviewed work",
      reviewBy: "2026-01-03",
    })
    const malformed = makeTask("task-malformed", {
      title: "Future task from stale query result",
      reviewBy: "2099-01-01",
    })
    const services = auditServices({ tasks: [malformed, valid] })
    const mockServer = createMockServer()
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-query", "audit")

    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("## Overdue Tasks (1)")
    expect(text).toContain("Close reviewed work")
    expect(text).not.toContain("Future task from stale query result")
    expect(text).toContain(
      "Warnings: Task task-malformed: failed to compute overdue days, skipping"
    )
  })

  it("returns a warning-only empty audit when all overdue task rows are malformed", async () => {
    const malformed = makeTask("task-malformed", {
      title: "Future task from stale query result",
      reviewBy: "2099-01-01",
    })
    const services = auditServices({ tasks: [malformed] })
    const mockServer = createMockServer()
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-query", "audit")

    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain(
      "No overdue facts or decisions found. Overdue tasks could not be rendered."
    )
    expect(text).toContain(
      "Warnings: Task task-malformed: failed to compute overdue days, skipping"
    )
    expect(text).not.toContain("## Overdue Tasks")
  })
})

describe("lore-learn — PF3-01 entity ambiguity surface", () => {
  function makeServices(
    entitiesBehavior: {
      subjectAmbiguous?: boolean
      objectAmbiguous?: boolean
      resolverThrows?: boolean
    } = {}
  ) {
    const ambiguousResolution = (input: string) => ({
      entity: null,
      ambiguous: true,
      candidates: [
        {
          id: "ent-a",
          name: `${input} (auth context)`,
          aliases: [input],
          kind: null,
          description: "",
        },
        {
          id: "ent-b",
          name: `${input} (db schema)`,
          aliases: [input],
          kind: null,
          description: "",
        },
      ],
      created: false,
    })
    const uniqueResolution = (input: string) => ({
      entity: {
        id: `ent-unique-${input}`,
        name: input,
        aliases: [],
        kind: null,
        description: "",
      },
      ambiguous: false,
      candidates: [],
      created: false,
    })

    return {
      projects: { findByName: vi.fn() },
      facts: {
        createWithDedup: vi.fn().mockImplementation(async (input) => ({
          fact: makeFact("fact-created", {
            subject: input.subject,
            predicate: input.predicate,
            object: input.object,
            sourceMemoryId: input.sourceMemoryId ?? null,
            confidence: "likely",
            subjectEntityId: input.subjectEntityId ?? null,
            objectEntityId: input.objectEntityId ?? null,
          }),
          deduped: false,
          enriched: [],
        })),
        queryByEntity: vi.fn(),
        queryByObject: vi.fn(),
      },
      decisions: { getById: vi.fn() },
      memories: {
        getPropertiesById: vi.fn().mockImplementation(async (id: string) => ({
          id,
          projectIds: [],
        })),
      },
      context: { project: null },
      sessionMemories: {
        record: vi.fn(),
        get: vi.fn().mockReturnValue(undefined),
      },
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
      entities: {
        resolveOrCreateEntity: vi.fn().mockImplementation(async (input: string) => {
          if (entitiesBehavior.resolverThrows) {
            throw new Error("notion 429")
          }
          if (input.toLowerCase().includes("user") && entitiesBehavior.subjectAmbiguous) {
            return ambiguousResolution(input)
          }
          if (
            input.toLowerCase().includes("session") &&
            entitiesBehavior.objectAmbiguous
          ) {
            return ambiguousResolution(input)
          }
          return uniqueResolution(input)
        }),
      },
    }
  }

  it("writes the fact with a warning and omits SubjectEntity on ambiguous subject", async () => {
    // Autosave fan-out scenario: an ambiguous "User" subject should
    // not block the fact write. The substring fallback in
    // queryByEntity still finds the row later.
    const mockServer = createMockServer()
    const services = makeServices({ subjectAmbiguous: true })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreLearn = mockServer.getActionHandler("lore-fact", "create")

    const result = await loreLearn({
      subject: "User",
      predicate: "has_a",
      object: "session",
      sourceMemoryId: "mem-1",
      confidence: "likely",
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBeFalsy()
    const text = payload.content[0].text
    expect(text).toContain("Ambiguous subject")
    expect(text).toContain("ent-a")
    expect(text).toContain("ent-b")
    // Fact created without SubjectEntity binding — Object resolved fine.
    expect(services.facts.createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectEntityId: undefined,
        objectEntityId: "ent-unique-session",
      })
    )
  })

  it("writes the fact without entity relations when entity resolution fails", async () => {
    const mockServer = createMockServer()
    const services = makeServices({ resolverThrows: true })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreLearn = mockServer.getActionHandler("lore-fact", "create")

    const result = await loreLearn({
      subject: "Anything",
      predicate: "uses",
      object: "Else",
      sourceMemoryId: "mem-1",
      confidence: "likely",
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBeFalsy()
    expect(payload.content[0].text).toContain("entity resolution failed")
    // No entity ids on the create call — the row-level fallback still
    // recalls the fact by SubjectKey / Subject text.
    expect(services.facts.createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectEntityId: undefined,
        objectEntityId: undefined,
      })
    )
  })
})

describe("lore-ask — P3-02 Tasks bucket", () => {
  function makeAskServices(overrides: Record<string, unknown> = {}) {
    return {
      projects: { findByName: vi.fn() },
      facts: {
        queryByEntity: vi.fn().mockResolvedValue([]),
        queryByObject: vi.fn().mockResolvedValue([]),
      },
      decisions: { getById: vi.fn() },
      memories: { getTitleById: vi.fn().mockResolvedValue(null) },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: null },
      entities: {
        resolveOrCreateEntity: vi.fn().mockResolvedValue({
          entity: null,
          ambiguous: false,
          candidates: [],
          created: false,
        }),
      },
      ...overrides,
    }
  }

  it("renders a Tasks section with state and overdue marker", async () => {
    const mockServer = createMockServer()
    const services = makeAskServices()
    services.tasks.list = vi.fn().mockResolvedValue({
      items: [
        {
          id: "t-1",
          title: "Rotate JWT keys",
          taskState: "blocked",
          blockedBy: "PR #1234 review",
          reviewBy: "2026-01-01",
          decidedAt: null,
          entity: "AuthService",
        },
      ],
    })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreAsk = mockServer.getActionHandler("lore-query", "ask")

    const result = await loreAsk({ entity: "AuthService" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("### Tasks")
    expect(text).toContain("Rotate JWT keys")
    expect(text).toContain("blocked by PR #1234 review")
    // Overdue tasks lead with the urgency marker.
    expect(text).toMatch(/⚠ \*\*Rotate JWT keys/)
  })

  it("filters tasks by entity server-side via the multi-variant entities filter", async () => {
    const mockServer = createMockServer()
    const services = makeAskServices()
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreAsk = mockServer.getActionHandler("lore-query", "ask")

    await loreAsk({ entity: "AuthService" } as never)

    // Unresolved entities collapse the variant set to the raw input —
    // alias-aware recall is the unique EntityService path, exercised
    // separately below. The contract here is that `lore-ask` always feeds
    // `TaskService.list` through the new `entities` array surface, never
    // the removed `entity` field.
    expect(services.tasks.list).toHaveBeenCalledWith(
      expect.objectContaining({ entities: ["AuthService"] })
    )
    const callArgs = (services.tasks.list as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArgs).not.toHaveProperty("entity")
  })

  it("does not pass a `states` override to TaskService.list — service-side ACTIVE_TASK_STATES default applies", async () => {
    // Pinning the contract: lore-ask renders only active work in its
    // Tasks bucket. If a future caller starts surfacing closed tasks
    // here, it should be a deliberate spec change with a corresponding
    // bucket rename, not a silent default flip.
    const mockServer = createMockServer()
    const services = makeAskServices()
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreAsk = mockServer.getActionHandler("lore-query", "ask")

    await loreAsk({ entity: "AuthService" } as never)

    const callArgs = (services.tasks.list as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArgs).not.toHaveProperty("states")
  })

  it("renders 'No facts or tasks' when both queries return empty", async () => {
    const mockServer = createMockServer()
    const services = makeAskServices()
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreAsk = mockServer.getActionHandler("lore-query", "ask")

    const result = await loreAsk({ entity: "AuthService" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("No facts or tasks found")
  })

  it("surfaces a Warnings line and continues when tasks.list rejects", async () => {
    const mockServer = createMockServer()
    const services = makeAskServices()
    services.tasks.list = vi.fn().mockRejectedValue(new Error("transient 5xx"))
    services.facts.queryByEntity = vi.fn().mockResolvedValue([
      {
        id: "fact-1",
        subject: "AuthService",
        predicate: "uses",
        object: "JWT",
        projectIds: [],
        validFrom: "2026-04-01",
        validUntil: null,
        reviewBy: null,
        sourceMemoryId: null,
        confidence: "likely",
      },
    ])
    services.facts.queryByObject = vi.fn().mockResolvedValue([])
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreAsk = mockServer.getActionHandler("lore-query", "ask")

    const result = await loreAsk({ entity: "AuthService" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("Tasks lookup failed")
    expect(text).toContain("transient 5xx")
    // Facts still rendered — the warning didn't sink the call.
    expect(text).toContain("JWT")
  })
})

describe("lore-ask — task recall honors canonical entity aliases", () => {
  function makeAskServicesWithEntity(
    resolution: {
      entity?: { id: string; name: string; aliases: string[] } | null
      ambiguous?: boolean
      candidates?: Array<{ id: string; name: string }>
    },
    overrides: Record<string, unknown> = {}
  ) {
    const candidates = (resolution.candidates ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      aliases: [],
      kind: null,
      description: "",
    }))
    return {
      projects: { findByName: vi.fn() },
      facts: {
        queryByEntity: vi.fn().mockResolvedValue([]),
        queryByObject: vi.fn().mockResolvedValue([]),
      },
      decisions: { getById: vi.fn() },
      memories: { getTitleById: vi.fn().mockResolvedValue(null) },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      context: { project: null },
      entities: {
        resolveOrCreateEntity: vi.fn().mockResolvedValue({
          entity: resolution.entity ?? null,
          ambiguous: resolution.ambiguous ?? false,
          candidates: resolution.entity
            ? [
                {
                  ...resolution.entity,
                  kind: null,
                  description: "",
                },
              ]
            : candidates,
          created: false,
        }),
      },
      ...overrides,
    }
  }

  it("expands the canonical entity into name + aliases when the resolver returns a unique row", async () => {
    const mockServer = createMockServer()
    const services = makeAskServicesWithEntity({
      entity: {
        id: "ent-auth",
        name: "AuthService",
        aliases: ["AuthSvc", "auth-service"],
      },
    })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreAsk = mockServer.getActionHandler("lore-query", "ask")

    // User typed an alias — variants must include the canonical name
    // and the other registered aliases so a task stored under any of
    // them surfaces.
    await loreAsk({ entity: "AuthSvc" } as never)

    const callArgs = (services.tasks.list as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArgs.entities).toEqual(
      expect.arrayContaining(["AuthSvc", "AuthService", "auth-service"])
    )
    // Raw user input is preserved as the first variant — un-migrated
    // tasks that store the original alias spelling still match.
    expect(callArgs.entities[0]).toBe("AuthSvc")
  })

  it("collapses case-variant aliases via the same normalization Facts use", async () => {
    const mockServer = createMockServer()
    const services = makeAskServicesWithEntity({
      entity: {
        id: "ent-auth",
        name: "AuthService",
        // Aliases are stored verbatim but two of these collapse onto
        // the canonical key — they should not consume cap slots.
        aliases: ["authservice", "AUTHSERVICE", "AuthSvc"],
      },
    })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreAsk = mockServer.getActionHandler("lore-query", "ask")

    await loreAsk({ entity: "AuthService" } as never)

    const callArgs = (services.tasks.list as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // Raw input + canonical name dedupe to one variant; the two
    // case-variant aliases also collapse onto the canonical key.
    // Net: `AuthService` (raw == canonical) + `AuthSvc` (distinct).
    expect(callArgs.entities).toEqual(["AuthService", "AuthSvc"])
  })

  it("falls back to the raw input on ambiguous resolution and surfaces the disambiguate warning", async () => {
    const mockServer = createMockServer()
    const services = makeAskServicesWithEntity({
      ambiguous: true,
      candidates: [
        { id: "ent-auth", name: "User (auth context)" },
        { id: "ent-db", name: "User (db schema)" },
      ],
    })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreAsk = mockServer.getActionHandler("lore-query", "ask")

    const result = await loreAsk({ entity: "User" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    // Ambiguity surfaces but the call doesn't collapse — task lookup
    // still runs against the raw substring so the agent sees something
    // useful.
    expect(text).toContain("matches 2 entities")
    const callArgs = (services.tasks.list as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArgs.entities).toEqual(["User"])
  })

  it("unresolved entity lookup feeds the raw input through unchanged", async () => {
    const mockServer = createMockServer()
    const services = makeAskServicesWithEntity({})
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreAsk = mockServer.getActionHandler("lore-query", "ask")

    await loreAsk({ entity: "AuthService" } as never)

    const callArgs = (services.tasks.list as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArgs.entities).toEqual(["AuthService"])
  })

  it("warns when the alias set exceeds the variant cap and lists the dropped aliases", async () => {
    // 12 distinct aliases on a single entity — variants land at the
    // 10-slot cap (raw input + canonical + 8 aliases). The two
    // overflow aliases surface in the warning so an operator can see
    // exactly which alias spellings are no longer recalled.
    const aliases = Array.from({ length: 12 }, (_, i) => `Auth-Alias-${i}`)
    const mockServer = createMockServer()
    const services = makeAskServicesWithEntity({
      entity: {
        id: "ent-auth",
        name: "AuthService",
        aliases,
      },
    })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreAsk = mockServer.getActionHandler("lore-query", "ask")

    const result = await loreAsk({ entity: "AuthService" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("Task recall capped at 10 alias variants")
    // Spec acceptance criterion: surface a warning naming the
    // overflowed aliases so the cap is observable, not silent.
    expect(text).toContain("Auth-Alias-9")
    const callArgs = (services.tasks.list as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArgs.entities).toHaveLength(10)
  })
})

// Issue 0.6.0/18: project framing block on lore-query action='ask'.
describe("lore-ask — project framing block (issue 0.6.0/18)", () => {
  function makeServices(
    opts: {
      project?: {
        id: string
        name: string
        path: string
        description: string
      } | null
      isCatchAllFallback?: boolean
      configProjects?: Array<{ name: string; path: string }>
      findByName?: (name: string) => Promise<unknown>
    } = {}
  ) {
    return {
      projects: { findByName: vi.fn(opts.findByName ?? (async () => null)) },
      facts: {
        queryByEntity: vi.fn().mockResolvedValue([]),
        queryByObject: vi.fn().mockResolvedValue([]),
      },
      decisions: { getById: vi.fn() },
      memories: { getTitleById: vi.fn().mockResolvedValue(null) },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      entities: makeEntityService(),
      context: {
        project:
          opts.project === undefined
            ? {
                id: "proj-widget",
                name: "Widget",
                path: "apps/widget",
                description: "Widget application.",
              }
            : opts.project,
        isCatchAllFallback: opts.isCatchAllFallback ?? false,
      },
      config: { vault: { pageId: "v1" }, projects: opts.configProjects ?? [] },
    }
  }

  it("prepends a project framing block by default (includeContext omitted)", async () => {
    const mockServer = createMockServer()
    const services = makeServices({
      project: {
        id: "proj-widget",
        name: "Widget",
        path: "apps/widget",
        description: "Widget application.",
      },
      configProjects: [
        { name: "Widget", path: "apps/widget" },
        { name: "Web", path: "apps/web" },
      ],
    })
    services.facts.queryByEntity = vi.fn().mockResolvedValue([
      {
        id: "fact-1",
        subject: "AuthService",
        predicate: "uses",
        object: "OIDC",
        projectIds: [],
        validFrom: "2026-04-20",
        validUntil: null,
        reviewBy: null,
        sourceMemoryId: null,
        confidence: "likely",
        subjectEntityId: null,
        objectEntityId: null,
      },
    ])
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const ask = mockServer.getActionHandler("lore-query", "ask")

    const result = await ask({ entity: "AuthService" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    // Framing block sits ABOVE the count line.
    const projectIdx = text.indexOf("Project: Widget (apps/widget)")
    const countIdx = text.indexOf('1 facts about "AuthService"')
    expect(projectIdx).toBeGreaterThan(-1)
    expect(countIdx).toBeGreaterThan(projectIdx)
    expect(text).toContain("  Widget application.")
    // Siblings names *peers* — the resolved project is excluded.
    expect(text).toContain("  Siblings: Web.")
    expect(text).not.toContain("Siblings: Widget")
  })

  it("suppresses the framing block when includeContext: false", async () => {
    const mockServer = createMockServer()
    const services = makeServices({
      project: {
        id: "proj-widget",
        name: "Widget",
        path: "apps/widget",
        description: "Should not appear.",
      },
      configProjects: [{ name: "Widget", path: "apps/widget" }],
    })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const ask = mockServer.getActionHandler("lore-query", "ask")

    const result = await ask({
      entity: "AuthService",
      includeContext: false,
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).not.toContain("Project: Widget")
    expect(text).not.toContain("Should not appear.")
    expect(text).not.toContain("Siblings:")
  })

  it("includes the framing block on the empty-results path so cold-start agents still see scope", async () => {
    const mockServer = createMockServer()
    const services = makeServices({
      project: {
        id: "proj-widget",
        name: "Widget",
        path: "apps/widget",
        description: "Widget application.",
      },
      configProjects: [{ name: "Widget", path: "apps/widget" }],
    })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const ask = mockServer.getActionHandler("lore-query", "ask")

    const result = await ask({ entity: "Unknown" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("Project: Widget (apps/widget)")
    expect(text).toContain('No facts or tasks found about "Unknown"')
  })

  it("renders a catch-all warning that mirrors the save-side voice", async () => {
    const mockServer = createMockServer()
    const services = makeServices({
      project: {
        id: "proj-mono",
        name: "Monorepo",
        path: ".",
        description: "Whole repo.",
      },
      isCatchAllFallback: true,
      configProjects: [
        { name: "Monorepo", path: "." },
        { name: "Widget", path: "apps/widget" },
        { name: "Web", path: "apps/web" },
      ],
    })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const ask = mockServer.getActionHandler("lore-query", "ask")

    const result = await ask({ entity: "AuthService" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    // Lead-in mirrors the save-side warning byte-for-byte (shared via
    // `formatCatchAllScopeSummary` in `src/core/context.ts`); only the
    // call-to-action tail diverges (read tools take `projectName` only).
    expect(text).toContain(
      '> Scoped to catch-all "Monorepo" (monorepo-wide). Sub-projects available: Widget, Web. Pass projectName to scope to a specific sub-project.'
    )
  })

  it("describes the explicitly-resolved project when projectName is passed (Fix 2)", async () => {
    const mockServer = createMockServer()
    // Type-annotated as `Project` so the fixture validates against the
    // production shape — if `Project` ever grows a required field, this
    // test fails alongside the prod call site instead of silently passing.
    const webProject: Project = {
      id: "proj-web",
      name: "Web",
      type: "project",
      path: "apps/web",
      status: "active",
      description: "Marketing site.",
    }
    const services = makeServices({
      project: {
        id: "proj-widget",
        name: "Widget",
        path: "apps/widget",
        description: "Widget application.",
      },
      configProjects: [
        { name: "Widget", path: "apps/widget" },
        { name: "Web", path: "apps/web" },
      ],
      findByName: async (name) => (name === "Web" ? webProject : null),
    })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const ask = mockServer.getActionHandler("lore-query", "ask")

    const result = await ask({
      entity: "AuthService",
      projectName: "Web",
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("Project: Web (apps/web)")
    expect(text).toContain("  Marketing site.")
    // The auto-detected project's description must NOT leak through.
    expect(text).not.toContain("Widget application.")
  })

  it("renders no framing block when no project resolved (vault-wide scope)", async () => {
    const mockServer = createMockServer()
    const services = makeServices({ project: null, configProjects: [] })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const ask = mockServer.getActionHandler("lore-query", "ask")

    const result = await ask({ entity: "AuthService" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).not.toContain("Project:")
    expect(text).not.toContain("Siblings:")
  })
})
describe("lore-query action='audit' Overdue Facts trust indicator (0.8.0/DEFERRED-02)", () => {
  // Sibling of the Overdue Decisions trust-indicator block above.
  // Pre-DEFERRED-02 the Overdue Facts section carried a TODO placeholder
  // pointing at this surface; once the Facts DB grew a `Confidence Score`
  // column the placeholder unblocked. Pin the same envelope —
  // title → trust → review-by → ID — so a future renderer swap or
  // re-flow doesn't silently drop the audit signal that drove the
  // operator's attention to this row in the first place.

  function auditServices(facts: Fact[]) {
    return {
      projects: { findByName: vi.fn() },
      facts: { queryOverdue: vi.fn().mockResolvedValue(facts) },
      decisions: { queryOverdue: vi.fn().mockResolvedValue([]) },
      tasks: { queryOverdue: vi.fn().mockResolvedValue([]) },
      context: { project: null },
    }
  }

  it("renders the trust line between the title row and the Review by row on a low-confidence fact", async () => {
    const fact = makeFact("fact-low", {
      subject: "DecayedSubject",
      predicate: "uses",
      object: "DecayedObj",
      reviewBy: "2026-01-01",
      confidenceScore: 0.3,
    })
    const mockServer = createMockServer()
    registerKnowledgeTools(mockServer.server, auditServices([fact]) as never)
    registerQueryTools(mockServer.server, auditServices([fact]) as never)
    const handler = mockServer.getActionHandler("lore-query", "audit")

    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    const lines = text.split("\n")
    const titleIdx = lines.findIndex((l) => l.includes("**DecayedSubject**"))
    expect(titleIdx).toBeGreaterThanOrEqual(0)
    expect(lines[titleIdx + 1]).toBe("  _low confidence_")
    expect(lines[titleIdx + 2]).toMatch(/^ {2}Review by:/)
  })

  it("omits the trust line when confidenceScore is null (pre-migration vault)", async () => {
    // Pre-DEFERRED-02 vault — the `Confidence Score` column hasn't
    // been backfilled yet, so the field comes back null and
    // `renderTrustLine` returns null. Audit output stays
    // byte-identical to pre-DEFERRED-02 for un-migrated vaults.
    const fact = makeFact("fact-null", {
      subject: "PreMigrationSubject",
      predicate: "uses",
      object: "PreMigrationObj",
      reviewBy: "2026-01-01",
    })
    const mockServer = createMockServer()
    registerKnowledgeTools(mockServer.server, auditServices([fact]) as never)
    registerQueryTools(mockServer.server, auditServices([fact]) as never)
    const handler = mockServer.getActionHandler("lore-query", "audit")

    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("PreMigrationSubject")
    expect(text).not.toContain("confidence_")
  })

  it("omits the trust line when the score is at or above the display threshold", async () => {
    const fact = makeFact("fact-healthy", {
      subject: "FreshSubject",
      predicate: "uses",
      object: "FreshObj",
      reviewBy: "2026-01-01",
    })
    const mockServer = createMockServer()
    registerKnowledgeTools(mockServer.server, auditServices([fact]) as never)
    registerQueryTools(mockServer.server, auditServices([fact]) as never)
    const handler = mockServer.getActionHandler("lore-query", "audit")

    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("FreshSubject")
    expect(text).not.toContain("confidence_")
  })
})

// ---------------------------------------------------------------------------
// Issue #467: create-required text fields must be nonblank after trimming.
// Empty / whitespace-only `subject` or `object` would create blank facts;
// reject at the MCP boundary instead.
// ---------------------------------------------------------------------------

describe("lore-fact action='create' — nonblank subject/object (issue #467)", () => {
  function harness() {
    const mockServer = createMockServer()
    const createWithDedup = vi.fn().mockResolvedValue({
      fact: makeFact("fact-x"),
      deduped: false,
      enriched: [],
    })
    const services = {
      projects: { findByName: vi.fn() },
      memories: {
        getPropertiesById: vi.fn().mockResolvedValue({
          id: "mem-x",
          projectIds: [],
        }),
      },
      facts: { createWithDedup },
      decisions: { getById: vi.fn() },
      context: { project: null },
      sessionMemories: { record: vi.fn(), get: vi.fn() },
      entities: makeEntityService(),
      identity: { resolveAuthor: vi.fn(async () => null), clearCache: vi.fn() },
    }
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    return {
      handler: mockServer.getActionHandler("lore-fact", "create"),
      createWithDedup,
    }
  }

  async function run(args: Record<string, unknown>) {
    const { handler, createWithDedup } = harness()
    const result = (await handler(args as never)) as {
      isError?: boolean
      content: Array<{ text: string }>
    }
    return {
      ok: !result.isError,
      message: result.content[0]?.text ?? "",
      createWithDedup,
    }
  }

  const baseArgs = {
    predicate: "uses",
    sourceMemoryId: "mem-x",
    confidence: "likely",
  }

  it("rejects empty subject", async () => {
    const { ok, message, createWithDedup } = await run({
      ...baseArgs,
      subject: "",
      object: "JWT",
    })
    expect(ok).toBe(false)
    expect(message).toContain("subject")
    expect(message).toContain("blank")
    expect(createWithDedup).not.toHaveBeenCalled()
  })

  it("rejects whitespace-only subject", async () => {
    const { ok, message, createWithDedup } = await run({
      ...baseArgs,
      subject: "  \t",
      object: "JWT",
    })
    expect(ok).toBe(false)
    expect(message).toContain("subject")
    expect(createWithDedup).not.toHaveBeenCalled()
  })

  it("rejects empty object", async () => {
    const { ok, message, createWithDedup } = await run({
      ...baseArgs,
      subject: "AuthService",
      object: "",
    })
    expect(ok).toBe(false)
    expect(message).toContain("object")
    expect(createWithDedup).not.toHaveBeenCalled()
  })

  it("rejects whitespace-only object", async () => {
    const { ok, message, createWithDedup } = await run({
      ...baseArgs,
      subject: "AuthService",
      object: "   ",
    })
    expect(ok).toBe(false)
    expect(message).toContain("object")
    expect(createWithDedup).not.toHaveBeenCalled()
  })

  it("accepts nonblank subject and object", async () => {
    const { ok, createWithDedup } = await run({
      ...baseArgs,
      subject: "AuthService",
      object: "JWT",
    })
    expect(ok).toBe(true)
    expect(createWithDedup).toHaveBeenCalled()
  })
})
