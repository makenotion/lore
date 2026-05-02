import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { describe, expect, it, vi } from "vitest"
import { registerKnowledgeTools } from "./knowledge.js"
import { registerQueryTools } from "./query.js"
import type { Decision, Fact, Memory, Project } from "../../types.js"
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
    confidence: "certain",
    confidenceScore: null,
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
    subjectEntityId: null,
    objectEntityId: null,
    ...overrides,
  }
}

function createMockServer() {
  const handlers = new Map<string, (...args: never[]) => Promise<unknown>>()
  const server = {
    registerTool: vi.fn((name: string, _config: unknown, handler: (...args: never[]) => Promise<unknown>) => {
      handlers.set(name, handler)
    }),
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
            object: "Old decision",
          }),
          makeFact("fact-new", {
            sourceMemoryId: "new-id",
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
            object: "new-id",
          }),
          makeFact("fact-bad", {
            sourceMemoryId: "bad-root",
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
        "[lore] partial-failure: root=bad-root error=notion 5xx tool=lore-query\n",
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
        queryByEntity: vi.fn().mockResolvedValue([
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
        "[lore] partial-failure: root=bad-root error=line one line two tabbed cr tool=lore-query\n",
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
      context: { project: null },
      ...overrides,
    }
  }

  async function invokeAsk(
    facts: Fact[],
    args: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {},
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
      }),
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
      }),
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
      }),
    )
    const text = await invokeAsk(facts, { limit: 3 })
    // `limit=3` is below the count so we DO trim — but the caller is
    // already on the knob, so we don't re-advertise it.
    expect(text).toMatch(/\(5 hidden\)/)
    expect(text).not.toContain("pass limit")
  })
})

describe("lore-ask projectName resolution", () => {
  it("warns and falls back when projectName does not resolve", async () => {
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

    // Warning emitted, not an error.
    expect(text).toContain('Project "Typo" not found')
    expect(text).toContain("Warnings:")
    // Fallback applied: query scoped to the ambient project.
    expect(queryByEntity).toHaveBeenCalledWith(
      "AuthService",
      expect.objectContaining({ projectId: "proj-ambient" }),
    )
  })
})

describe("lore-fact action='create' — tracking-predicate Zod rejection", () => {
  // Acceptance criterion (#23, line 452-455): the contracted
  // `FactPredicate` union drives the Zod enum at the dispatcher
  // boundary, so each tracking predicate string fails at parse time
  // rather than via the deleted `trackingPredicateRedirect` helper.
  // Pin all three values so widening `PREDICATE_VALUES` (intentionally
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
        identity: { author: null },
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

describe("lore-learn sourceMemoryId discipline", () => {
  function makeServices(overrides: Record<string, unknown> = {}) {
    return {
      projects: { findByName: vi.fn() },
      facts: {
        create: vi.fn().mockImplementation(async (input) =>
          makeFact("fact-created", {
            subject: input.subject,
            predicate: input.predicate,
            object: input.object,
            sourceMemoryId: input.sourceMemoryId ?? null,
          })
        ),
        createWithDedup: vi.fn().mockImplementation(async (input) => ({
          fact: makeFact("fact-created", {
            subject: input.subject,
            predicate: input.predicate,
            object: input.object,
            sourceMemoryId: input.sourceMemoryId ?? null,
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
      identity: { author: null },
      ...overrides,
    }
  }

  it("soft-phases missing sourceMemoryId: creates the fact with a prominent warning", async () => {
    // The spec's soft-phase requirement: we do NOT hard-error when no source
    // is available, because that would break every deployed caller on day
    // one. Instead the fact is created and the response carries a loud
    // warning. Flip to hard error in a future minor.
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
    expect(payload.isError).toBeFalsy()
    expect(payload.content[0].text).toContain("WARNING")
    expect(payload.content[0].text).toContain("sourceMemoryId")
    // Fact IS created; we're warning, not refusing.
    expect(services.facts.createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMemoryId: undefined })
    )
  })

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
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBeFalsy()
    expect(payload.content[0].text).toContain("Source: mem-explicit")
    expect(payload.content[0].text).not.toContain("WARNING")
    expect(services.facts.createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMemoryId: "mem-explicit" })
    )
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
    const services = makeServices({
      sessionMemories: {
        record: vi.fn(),
        get: vi
          .fn()
          .mockReturnValue({ memoryId: "mem-from-session", projectIds: [] }),
      },
    })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreLearn = mockServer.getActionHandler("lore-fact", "create")

    await loreLearn({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      session: "session-abc",
      agent: "claude",
      sourceMemoryId: "mem-explicit",
    } as never)

    expect(services.facts.createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMemoryId: "mem-explicit" })
    )
  })

  it("declines auto-link when session memory's project is disjoint from the fact's project", async () => {
    // Reviewer blocker #2: an iOS-scoped memory must not silently become the
    // source for a server-scoped fact. The memory and the fact are both
    // scoped; their project sets do not intersect; decline and warn.
    const mockServer = createMockServer()
    const projectsFindByName = vi.fn().mockImplementation(async (name: string) => {
      if (name === "server") return { id: "proj-server", name: "server" }
      return null
    })
    const services = makeServices({
      projects: { findByName: projectsFindByName },
      sessionMemories: {
        record: vi.fn(),
        get: vi
          .fn()
          .mockReturnValue({ memoryId: "mem-ios", projectIds: ["proj-ios"] }),
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
    expect(payload.isError).toBeFalsy()
    // Auto-link refused — fact is created without a Source and with both
    // the soft-phase warning AND the decline reason in the warnings line.
    expect(payload.content[0].text).toContain("Declined auto-link")
    expect(payload.content[0].text).toContain("different project")
    expect(payload.content[0].text).toContain("WARNING")
    expect(services.facts.createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMemoryId: undefined })
    )
  })

  it("accepts auto-link when fact has no project scope (vault-wide fact)", async () => {
    // A vault-wide fact can legitimately accept any scoped memory as source.
    // This is the symmetric case to the previous test.
    const mockServer = createMockServer()
    const services = makeServices({
      sessionMemories: {
        record: vi.fn(),
        get: vi
          .fn()
          .mockReturnValue({ memoryId: "mem-ios", projectIds: ["proj-ios"] }),
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
        get: vi
          .fn()
          .mockReturnValue({ memoryId: "mem-global", projectIds: [] }),
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

  it("soft-phase warning (no hard error) when session is present but the tracker has no entry", async () => {
    const mockServer = createMockServer()
    const services = makeServices({
      sessionMemories: {
        record: vi.fn(),
        get: vi.fn().mockReturnValue(undefined),
      },
      identity: { author: null },
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
    expect(payload.isError).toBeFalsy()
    expect(payload.content[0].text).toContain("WARNING")
    expect(services.facts.createWithDedup).toHaveBeenCalled()
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

    const services = {
      projects: { findByName: vi.fn().mockResolvedValue(null) },
      facts: { queryOverdue: queryOverdueFacts },
      decisions: { queryOverdue: queryOverdueDecisions },
      context: { project: { id: "proj-ambient", name: "Ambient" } },
    }

    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const handler = mockServer.getActionHandler("lore-query", "audit")

    const result = await handler({ projectName: "Typo" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain('Project "Typo" not found')
    expect(queryOverdueFacts).not.toHaveBeenCalled()
    expect(queryOverdueDecisions).not.toHaveBeenCalled()
  })
})

describe("lore-learn — PF3-01 entity ambiguity surface", () => {
  function makeServices(entitiesBehavior: {
    subjectAmbiguous?: boolean
    objectAmbiguous?: boolean
    skipService?: boolean
  } = {}) {
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
      context: { project: null },
      sessionMemories: {
        record: vi.fn(),
        get: vi.fn().mockReturnValue(undefined),
      },
      identity: { author: null },
      entities: entitiesBehavior.skipService
        ? null
        : {
            resolveOrCreateEntity: vi.fn().mockImplementation(async (input: string) => {
              if (input.toLowerCase().includes("user") && entitiesBehavior.subjectAmbiguous) {
                return ambiguousResolution(input)
              }
              if (input.toLowerCase().includes("session") && entitiesBehavior.objectAmbiguous) {
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
      }),
    )
  })

  it("legacy vault path (services.entities === null) skips resolver entirely", async () => {
    const mockServer = createMockServer()
    const services = makeServices({ skipService: true })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const loreLearn = mockServer.getActionHandler("lore-fact", "create")

    const result = await loreLearn({
      subject: "Anything",
      predicate: "uses",
      object: "Else",
      sourceMemoryId: "mem-1",
    } as never)

    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBeFalsy()
    // No entity ids on the create call — pre-PF3-01 fact.
    expect(services.facts.createWithDedup).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectEntityId: undefined,
        objectEntityId: undefined,
      }),
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
          blockedBy: "PR #25750 review",
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
    expect(text).toContain("blocked by PR #25750 review")
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

    // Legacy vault path (no `services.entities`) collapses the variant
    // set to the raw input — alias-aware recall is the EntityService
    // path, exercised separately below. The contract here is that
    // `lore-ask` always feeds `TaskService.list` through the new
    // `entities` array surface, never the removed `entity` field.
    expect(services.tasks.list).toHaveBeenCalledWith(
      expect.objectContaining({ entities: ["AuthService"] }),
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

    const callArgs = (services.tasks.list as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
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
        confidence: "certain",
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
    overrides: Record<string, unknown> = {},
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
      expect.arrayContaining(["AuthSvc", "AuthService", "auth-service"]),
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

  it("legacy vault (services.entities === null) feeds the raw input through unchanged", async () => {
    const mockServer = createMockServer()
    const services = makeAskServicesWithEntity({})
    services.entities = null as never
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
  function makeServices(opts: {
    project?: {
      id: string
      name: string
      path: string
      description: string
    } | null
    isCatchAllFallback?: boolean
    configProjects?: Array<{ name: string; path: string }>
    findByName?: (name: string) => Promise<unknown>
  } = {}) {
    return {
      projects: { findByName: vi.fn(opts.findByName ?? (async () => null)) },
      facts: {
        queryByEntity: vi.fn().mockResolvedValue([]),
        queryByObject: vi.fn().mockResolvedValue([]),
      },
      decisions: { getById: vi.fn() },
      memories: { getTitleById: vi.fn().mockResolvedValue(null) },
      tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
      context: {
        project: opts.project === undefined
          ? {
              id: "proj-mail",
              name: "Mail",
              path: "apps/mail",
              description: "Notion-backed mail client.",
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
        id: "proj-mail",
        name: "Mail",
        path: "apps/mail",
        description: "Notion-backed mail client.",
      },
      configProjects: [
        { name: "Mail", path: "apps/mail" },
        { name: "Web", path: "apps/web" },
      ],
    })
    services.facts.queryByEntity = vi
      .fn()
      .mockResolvedValue([
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
          confidence: "certain",
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
    const projectIdx = text.indexOf("Project: Mail (apps/mail)")
    const countIdx = text.indexOf('1 facts about "AuthService"')
    expect(projectIdx).toBeGreaterThan(-1)
    expect(countIdx).toBeGreaterThan(projectIdx)
    expect(text).toContain("  Notion-backed mail client.")
    // Siblings names *peers* — Mail is excluded as the resolved project.
    expect(text).toContain("  Siblings: Web.")
    expect(text).not.toContain("Siblings: Mail")
  })

  it("suppresses the framing block when includeContext: false", async () => {
    const mockServer = createMockServer()
    const services = makeServices({
      project: {
        id: "proj-mail",
        name: "Mail",
        path: "apps/mail",
        description: "Should not appear.",
      },
      configProjects: [{ name: "Mail", path: "apps/mail" }],
    })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const ask = mockServer.getActionHandler("lore-query", "ask")

    const result = await ask({
      entity: "AuthService",
      includeContext: false,
    } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).not.toContain("Project: Mail")
    expect(text).not.toContain("Should not appear.")
    expect(text).not.toContain("Siblings:")
  })

  it("includes the framing block on the empty-results path so cold-start agents still see scope", async () => {
    const mockServer = createMockServer()
    const services = makeServices({
      project: {
        id: "proj-mail",
        name: "Mail",
        path: "apps/mail",
        description: "Notion-backed mail client.",
      },
      configProjects: [{ name: "Mail", path: "apps/mail" }],
    })
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const ask = mockServer.getActionHandler("lore-query", "ask")

    const result = await ask({ entity: "Unknown" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("Project: Mail (apps/mail)")
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
        { name: "Mail", path: "apps/mail" },
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
      '> Scoped to catch-all "Monorepo" (monorepo-wide). Sub-projects available: Mail, Web. Pass projectName to scope to a specific sub-project.',
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
        id: "proj-mail",
        name: "Mail",
        path: "apps/mail",
        description: "Mail client.",
      },
      configProjects: [
        { name: "Mail", path: "apps/mail" },
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
    // The auto-detected Mail project's description must NOT leak through.
    expect(text).not.toContain("Mail client.")
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

describe("lore-fact action='invalidate' — confidence decrement on source memory", () => {
  // Acceptance criteria from 0.8.0/06: invalidating a fact halves the
  // source memory's `Confidence Score` (with realize-decay-first on
  // stale rows), writes `Last Referenced At = today`, skips when the
  // fact has no source, and degrades gracefully on `pages.update`
  // failure (advisory write — invalidate response stays clean).

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
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z",
      ...overrides,
    }
  }

  function makeServices(opts: {
    fact?: Fact | null
    sourceMemory?: Memory
    invalidateImpl?: () => Promise<void>
    decrementImpl?: (memory: Memory) => Promise<number>
    getPropertiesByIdImpl?: (id: string) => Promise<Memory>
  } = {}) {
    const factsGetById = vi.fn().mockResolvedValue(opts.fact ?? null)
    const factsInvalidate =
      opts.invalidateImpl !== undefined
        ? vi.fn(opts.invalidateImpl)
        : vi.fn().mockResolvedValue(undefined)
    const memoriesGetPropertiesById =
      opts.getPropertiesByIdImpl !== undefined
        ? vi.fn(opts.getPropertiesByIdImpl)
        : vi
            .fn()
            .mockResolvedValue(opts.sourceMemory ?? makeMemory("source-mem"))
    const memoriesDecrement =
      opts.decrementImpl !== undefined
        ? vi.fn(opts.decrementImpl)
        : vi.fn().mockResolvedValue(0.45)
    return {
      services: {
        projects: { findByName: vi.fn() },
        facts: {
          getById: factsGetById,
          invalidate: factsInvalidate,
          create: vi.fn(),
          createWithDedup: vi.fn(),
          queryByEntity: vi.fn(),
          queryByObject: vi.fn(),
        },
        memories: {
          getPropertiesById: memoriesGetPropertiesById,
          decrementConfidence: memoriesDecrement,
        },
        decisions: { getById: vi.fn() },
        context: { project: null },
        sessionMemories: { record: vi.fn(), get: vi.fn() },
        identity: { author: null },
      },
      factsGetById,
      factsInvalidate,
      memoriesGetPropertiesById,
      memoriesDecrement,
    }
  }

  it("decrements the source memory after invalidating the fact", async () => {
    const fact = makeFact("fact-1", { sourceMemoryId: "mem-source" })
    const sourceMemory = makeMemory("mem-source")
    const mockServer = createMockServer()
    const ctx = makeServices({ fact, sourceMemory })
    registerKnowledgeTools(mockServer.server, ctx.services as never)
    const invalidate = mockServer.getActionHandler("lore-fact", "invalidate")

    const result = await invalidate({ factId: "fact-1" } as never)
    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBeFalsy()
    expect(payload.content[0].text).toBe("Invalidated fact fact-1")

    expect(ctx.factsGetById).toHaveBeenCalledWith("fact-1")
    expect(ctx.factsInvalidate).toHaveBeenCalledWith("fact-1")
    expect(ctx.memoriesGetPropertiesById).toHaveBeenCalledWith("mem-source")
    // The handler passes the full Memory shape into decrementConfidence
    // so the service's seed/decay/decrement algebra has access to
    // confidence, confidenceScore, lastReferencedAt, createdAt.
    expect(ctx.memoriesDecrement).toHaveBeenCalledWith(sourceMemory)
  })

  it("ordering: read → invalidate → decrement (read is first so sourceMemoryId is captured pre-invalidate)", async () => {
    // Reads MUST happen before the invalidate write — `pageToFact`'s
    // historical-tracking-predicate filter races against `Valid Until`
    // updates if the read happens after invalidation.
    const sequence: string[] = []
    const fact = makeFact("fact-ord", { sourceMemoryId: "mem-ord" })
    const sourceMemory = makeMemory("mem-ord")
    const mockServer = createMockServer()
    const ctx = makeServices({
      fact,
      sourceMemory,
      invalidateImpl: async () => {
        sequence.push("invalidate")
      },
      decrementImpl: async () => {
        sequence.push("decrement")
        return 0.45
      },
    })
    ctx.factsGetById.mockImplementation(async (id: string) => {
      sequence.push("getById")
      return id === "fact-ord" ? fact : null
    })
    registerKnowledgeTools(mockServer.server, ctx.services as never)
    const invalidate = mockServer.getActionHandler("lore-fact", "invalidate")

    await invalidate({ factId: "fact-ord" } as never)

    expect(sequence).toEqual(["getById", "invalidate", "decrement"])
  })

  it("skips decrement when the fact has no source memory (orphaned fact)", async () => {
    const fact = makeFact("fact-orphan", { sourceMemoryId: null })
    const mockServer = createMockServer()
    const ctx = makeServices({ fact })
    registerKnowledgeTools(mockServer.server, ctx.services as never)
    const invalidate = mockServer.getActionHandler("lore-fact", "invalidate")

    const result = await invalidate({ factId: "fact-orphan" } as never)
    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBeFalsy()
    expect(ctx.factsInvalidate).toHaveBeenCalledWith("fact-orphan")
    expect(ctx.memoriesGetPropertiesById).not.toHaveBeenCalled()
    expect(ctx.memoriesDecrement).not.toHaveBeenCalled()
  })

  it("skips decrement when getById returns null (historical tracking-predicate row)", async () => {
    // `pageToFact` returns null for needs_action / waiting_on / blocked_by
    // rows; the invalidate write still succeeds but there's no live fact
    // shape to read sourceMemoryId from.
    const mockServer = createMockServer()
    const ctx = makeServices({ fact: null })
    registerKnowledgeTools(mockServer.server, ctx.services as never)
    const invalidate = mockServer.getActionHandler("lore-fact", "invalidate")

    await invalidate({ factId: "fact-tracking" } as never)
    expect(ctx.factsInvalidate).toHaveBeenCalledWith("fact-tracking")
    expect(ctx.memoriesGetPropertiesById).not.toHaveBeenCalled()
    expect(ctx.memoriesDecrement).not.toHaveBeenCalled()
  })

  it("decrement failure is advisory: invalidate response stays clean (no isError)", async () => {
    // Acceptance criterion: a transient 429 / archived target on the
    // decrement does NOT fail the surrounding lore-fact call. The
    // user already got the contradiction write they asked for.
    const fact = makeFact("fact-fail", { sourceMemoryId: "mem-fail" })
    const sourceMemory = makeMemory("mem-fail")
    const mockServer = createMockServer()
    const ctx = makeServices({
      fact,
      sourceMemory,
      decrementImpl: async () => {
        throw new Error("notion 429")
      },
    })
    registerKnowledgeTools(mockServer.server, ctx.services as never)
    const invalidate = mockServer.getActionHandler("lore-fact", "invalidate")

    const result = await invalidate({ factId: "fact-fail" } as never)
    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBeFalsy()
    expect(payload.content[0].text).toBe("Invalidated fact fact-fail")
  })

  it("source-memory read failure is advisory: invalidate response stays clean", async () => {
    // An archived source memory could throw on `pages.retrieve`. The
    // contradiction tail must not propagate that failure to the user
    // — the fact IS invalidated regardless.
    const fact = makeFact("fact-arc", { sourceMemoryId: "mem-archived" })
    const mockServer = createMockServer()
    const ctx = makeServices({
      fact,
      getPropertiesByIdImpl: async () => {
        throw new Error("page archived")
      },
    })
    registerKnowledgeTools(mockServer.server, ctx.services as never)
    const invalidate = mockServer.getActionHandler("lore-fact", "invalidate")

    const result = await invalidate({ factId: "fact-arc" } as never)
    const payload = result as { content: Array<{ text: string }>; isError?: boolean }
    expect(payload.isError).toBeFalsy()
    expect(ctx.memoriesDecrement).not.toHaveBeenCalled()
  })

  it("logs contradiction failures under LORE_DEBUG=1", async () => {
    const fact = makeFact("fact-log", { sourceMemoryId: "mem-log" })
    const sourceMemory = makeMemory("mem-log")
    const mockServer = createMockServer()
    const ctx = makeServices({
      fact,
      sourceMemory,
      decrementImpl: async () => {
        throw new Error("notion 429")
      },
    })
    registerKnowledgeTools(mockServer.server, ctx.services as never)
    const invalidate = mockServer.getActionHandler("lore-fact", "invalidate")

    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)
    process.env.LORE_DEBUG = "1"
    try {
      await invalidate({ factId: "fact-log" } as never)
      const lines = stderr.mock.calls.map(([line]) => String(line))
      const failure = lines.find((l) =>
        l.includes("contradiction-failure:"),
      )
      expect(failure).toBeDefined()
      expect(failure).toContain("source=invalidate")
      expect(failure).toContain("memoryId=mem-log")
      expect(failure).toContain("error=notion 429")
    } finally {
      delete process.env.LORE_DEBUG
      stderr.mockRestore()
    }
  })
})

describe("lore-fact action='invalidate' — end-to-end math through real MemoryService (issue 0.8.0/06)", () => {
  // Pin the spec's three math acceptance criteria at the
  // handler-through-service boundary, not just the service layer:
  //
  //   1. Stored-and-fresh source: 0.9 / today → 0.45 (no-decay path).
  //   2. Stored-and-stale source: 0.9 / 200d ago → ≈ 0.110 (decay-then-decrement).
  //   3. Null-score source (pre-migration): 200d-old `certain` → ≈ 0.110
  //      (seed-decay-then-decrement, convergence with the bulk migration).
  //
  // These are pinned at the algebra layer in `decay.test.ts` and at the
  // service layer in `memory.test.ts:MemoryService.decrementConfidence`.
  // Re-pinning here protects the MCP contract against a future refactor
  // that swaps `decrementConfidence` for a non-decay-aware helper or
  // moves the math computation into the handler.

  const TODAY = "2026-04-29"
  const memoriesDb = {
    databaseId: "memories-db",
    dataSourceId: "memories-ds",
  }

  function memoryPage(overrides: {
    id: string
    confidence?: "certain" | "likely" | "speculative"
    confidenceScore?: number | null
    lastReferencedAt?: string | null
    createdAt?: string
  }): PageObjectResponse {
    const props: Record<string, unknown> = {
      Title: { type: "title", title: [{ plain_text: "Source memory" }] },
      Confidence: {
        type: "select",
        select: { name: overrides.confidence ?? "certain" },
      },
    }
    if (overrides.confidenceScore !== undefined) {
      props["Confidence Score"] = {
        type: "number",
        number: overrides.confidenceScore,
      }
    }
    if (overrides.lastReferencedAt !== undefined) {
      props["Last Referenced At"] = {
        type: "date",
        date: overrides.lastReferencedAt
          ? { start: overrides.lastReferencedAt }
          : null,
      }
    }
    return {
      object: "page",
      id: overrides.id,
      created_time: overrides.createdAt ?? `${TODAY}T00:00:00.000Z`,
      last_edited_time: `${TODAY}T00:00:00.000Z`,
      archived: false,
      parent: { type: "data_source_id", data_source_id: memoriesDb.dataSourceId },
      url: `https://notion.so/${overrides.id}`,
      properties: props as PageObjectResponse["properties"],
    } as PageObjectResponse
  }

  function makeIntegrationServices(opts: {
    fact: Fact
    sourcePage: PageObjectResponse
  }) {
    // Real MemoryService wired against a stubbed Client. The
    // `pages.update` spy captures the actual `Confidence Score` value
    // the handler-through-service writes — that's the math contract
    // the spec acceptance criteria pin.
    const update = vi.fn(async () => undefined)
    const retrieve = vi.fn(async () => opts.sourcePage)
    const client = {
      pages: { update, retrieve },
    } as unknown as Client
    const memories = new MemoryService(client, memoriesDb)
    // Inject `today` into the decrement so the test is deterministic
    // independent of the wall clock — wrap `decrementConfidence` to
    // forward a pinned `today`. The handler today calls without
    // `opts`, which would default to `todayUtc()`. A future `today`
    // injection on the handler would make this wrapper unnecessary.
    const realDecrement = memories.decrementConfidence.bind(memories)
    memories.decrementConfidence = ((memory, _opts) =>
      realDecrement(memory, { today: TODAY })) as typeof memories.decrementConfidence
    return {
      services: {
        projects: { findByName: vi.fn() },
        facts: {
          getById: vi.fn().mockResolvedValue(opts.fact),
          invalidate: vi.fn().mockResolvedValue(undefined),
          create: vi.fn(),
          createWithDedup: vi.fn(),
          queryByEntity: vi.fn(),
          queryByObject: vi.fn(),
        },
        memories,
        decisions: { getById: vi.fn() },
        context: { project: null },
        sessionMemories: { record: vi.fn(), get: vi.fn() },
        identity: { author: null },
      },
      update,
      retrieve,
    }
  }

  function capturedUpdateProps(
    update: ReturnType<typeof vi.fn>,
    pageId: string,
  ): Record<string, unknown> {
    for (const call of update.mock.calls) {
      const args = call[0] as
        | { page_id: string; properties: Record<string, unknown> }
        | undefined
      if (args && args.page_id === pageId) return args.properties
    }
    throw new Error(`no pages.update call for ${pageId}`)
  }

  function capturedConfidenceScore(
    update: ReturnType<typeof vi.fn>,
    pageId: string,
  ): number {
    const props = capturedUpdateProps(update, pageId)
    return (props["Confidence Score"] as { number: number }).number
  }

  it("stored-and-fresh source: 0.9 / today → 0.45 (no decay)", async () => {
    const fact = makeFact("fact-1", { sourceMemoryId: "mem-fresh" })
    const sourcePage = memoryPage({
      id: "mem-fresh",
      confidence: "certain",
      confidenceScore: 0.9,
      lastReferencedAt: TODAY,
    })
    const mockServer = createMockServer()
    const ctx = makeIntegrationServices({ fact, sourcePage })
    registerKnowledgeTools(mockServer.server, ctx.services as never)
    const invalidate = mockServer.getActionHandler("lore-fact", "invalidate")

    await invalidate({ factId: "fact-1" } as never)

    const score = capturedConfidenceScore(ctx.update, "mem-fresh")
    expect(score).toBeCloseTo(0.45, 6)
    // Last Referenced At resets to today: contradiction is a (negative)
    // cite, so the decay clock restarts — pinned at the service layer
    // but verified end-to-end here too.
    const props = capturedUpdateProps(ctx.update, "mem-fresh")
    expect(props["Last Referenced At"]).toEqual({ date: { start: TODAY } })
  })

  it("stored-and-stale source: 0.9 / 200d ago → decrementConfidenceScore(decayConfidenceScore(0.9, ref, today)) ≈ 0.110", async () => {
    // 200 days elapsed → 140 stale days past 60-day grace.
    // 0.9 * 0.99^140 ≈ 0.220 → halve → ≈ 0.110, NOT 0.45.
    const fact = makeFact("fact-2", { sourceMemoryId: "mem-stale" })
    const staleDate = "2025-10-11" // 200 days before 2026-04-29
    const sourcePage = memoryPage({
      id: "mem-stale",
      confidence: "certain",
      confidenceScore: 0.9,
      lastReferencedAt: staleDate,
    })
    const mockServer = createMockServer()
    const ctx = makeIntegrationServices({ fact, sourcePage })
    registerKnowledgeTools(mockServer.server, ctx.services as never)
    const invalidate = mockServer.getActionHandler("lore-fact", "invalidate")

    await invalidate({ factId: "fact-2" } as never)

    const score = capturedConfidenceScore(ctx.update, "mem-stale")
    const expected = 0.9 * Math.pow(0.99, 140) * 0.5
    expect(score).toBeCloseTo(expected, 6)
    // Sanity: the stale-path score is well below the 0.45 fresh-path
    // baseline. A regression that dropped the decay realization would
    // produce 0.45 here, masking the convergence guarantee.
    expect(score).toBeLessThan(0.2)
  })

  it("null-score source (pre-migration): 200d-old `certain` → seed-decay-then-decrement ≈ 0.110", async () => {
    // Convergence guarantee: a contradiction on a never-scored row
    // lands at the same effective value the bulk migration would
    // write, so a read-before-migrate path and a migrate-before-read
    // path produce identical stored values. seed("certain") = 0.9 →
    // decay against createdAt (200d) → halve → ≈ 0.110, NOT 0.45.
    const fact = makeFact("fact-3", { sourceMemoryId: "mem-null" })
    const sourcePage = memoryPage({
      id: "mem-null",
      confidence: "certain",
      confidenceScore: null,
      lastReferencedAt: null,
      createdAt: "2025-10-11T00:00:00.000Z",
    })
    const mockServer = createMockServer()
    const ctx = makeIntegrationServices({ fact, sourcePage })
    registerKnowledgeTools(mockServer.server, ctx.services as never)
    const invalidate = mockServer.getActionHandler("lore-fact", "invalidate")

    await invalidate({ factId: "fact-3" } as never)

    const score = capturedConfidenceScore(ctx.update, "mem-null")
    const expected = 0.9 * Math.pow(0.99, 140) * 0.5
    expect(score).toBeCloseTo(expected, 6)
    // Sanity: NOT 0.45 (which is what a non-converging
    // "seed-then-halve" would produce). The 0.45 assertion would
    // silently regress the convergence guarantee with #11's migration.
    expect(score).toBeLessThan(0.2)
  })
})

describe("lore-query action='audit' Overdue Decisions trust indicator (0.9.0/DEFERRED-07)", () => {
  // Pinned at the surface so a future contributor swapping the audit
  // renderer would see the trust line disappear from the audit's
  // Overdue Decisions section. Bullet-shaped surface with continuation
  // lines — the trust line lands between the title row and the Review
  // By row so the audit reader sees the signal before the staleness
  // detail.

  function auditServices(decisions: Decision[]) {
    return {
      projects: { findByName: vi.fn() },
      facts: { queryOverdue: vi.fn().mockResolvedValue([]) },
      decisions: { queryOverdue: vi.fn().mockResolvedValue(decisions) },
      context: { project: null },
    }
  }

  it("renders the trust line between the title row and the Review by row on a low-confidence decision", async () => {
    const decision = makeDecision("dec-low", {
      title: "Low-confidence decision",
      reviewBy: "2026-01-01",
      confidenceScore: 0.3,
    })
    const mockServer = createMockServer()
    registerKnowledgeTools(mockServer.server, auditServices([decision]) as never)
    registerQueryTools(mockServer.server, auditServices([decision]) as never)
    const handler = mockServer.getActionHandler("lore-query", "audit")

    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    const lines = text.split("\n")
    const titleIdx = lines.findIndex((l) =>
      l.includes("**Low-confidence decision**"),
    )
    expect(titleIdx).toBeGreaterThanOrEqual(0)
    expect(lines[titleIdx + 1]).toBe("  _low confidence_")
    // Review by row follows the trust line, matching the
    // title → trust → review-by → ID envelope.
    expect(lines[titleIdx + 2]).toMatch(/^ {2}Review by:/)
  })

  it("omits the trust line when confidenceScore is null (pre-migration vault)", async () => {
    const decision = makeDecision("dec-null", {
      title: "Pre-migration overdue decision",
      reviewBy: "2026-01-01",
      confidenceScore: null,
    })
    const mockServer = createMockServer()
    registerKnowledgeTools(mockServer.server, auditServices([decision]) as never)
    registerQueryTools(mockServer.server, auditServices([decision]) as never)
    const handler = mockServer.getActionHandler("lore-query", "audit")

    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("Pre-migration overdue decision")
    expect(text).not.toContain("confidence_")
  })

  it("omits the trust line when the score is at or above the display threshold", async () => {
    const decision = makeDecision("dec-healthy", {
      title: "Healthy overdue decision",
      reviewBy: "2026-01-01",
      confidenceScore: 0.5,
    })
    const mockServer = createMockServer()
    registerKnowledgeTools(mockServer.server, auditServices([decision]) as never)
    registerQueryTools(mockServer.server, auditServices([decision]) as never)
    const handler = mockServer.getActionHandler("lore-query", "audit")

    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("Healthy overdue decision")
    expect(text).not.toContain("confidence_")
  })
})
