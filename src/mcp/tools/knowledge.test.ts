import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describe, expect, it, vi } from "vitest"
import type { z } from "zod"
import { registerKnowledgeTools } from "./knowledge.js"
import type { Decision, Fact } from "../../types.js"

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
    reviewBy: null,
    decidedAt: "2026-04-20",
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
    const loreAsk = mockServer.getHandler("lore-ask")

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
    const loreAsk = mockServer.getHandler("lore-ask")

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
    const loreAsk = mockServer.getHandler("lore-ask")
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
        "[lore] partial-failure: root=bad-root error=notion 5xx tool=lore-ask\n",
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
    const loreAsk = mockServer.getHandler("lore-ask")
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
        "[lore] partial-failure: root=bad-root error=line one line two tabbed cr tool=lore-ask\n",
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
    const loreAsk = mockServer.getHandler("lore-ask")
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
    const handler = mockServer.getHandler("lore-ask")
    const result = await handler({ entity: "AuthService", ...args } as never)
    return (result as { content: Array<{ text: string }> }).content[0].text
  }

  it("renders three bucket headings with counts when all classes are present", async () => {
    const facts: Fact[] = [
      makeFact("struct-1", { predicate: "uses", object: "JWT" }),
      makeFact("track-1", {
        predicate: "needs_action",
        object: "Audit",
        // Review not past today — active, not overdue.
        reviewBy: "2099-01-01",
      }),
      makeFact("gov-1", {
        predicate: "supersedes_decision",
        subject: "AuthService",
        object: "LegacyDecision",
      }),
    ]
    const text = await invokeAsk(facts)
    expect(text).toContain('3 facts about "AuthService"')
    expect(text).toMatch(/### Governance \(1\)/)
    expect(text).toMatch(/### Structure \(1\)/)
    expect(text).toMatch(/### Tracking \(0 overdue, 1 active\)/)
  })

  it("omits bucket headings for empty classes", async () => {
    const text = await invokeAsk([
      makeFact("struct-1", { predicate: "uses", object: "JWT" }),
    ])
    expect(text).toContain("### Structure")
    expect(text).not.toContain("### Governance")
    expect(text).not.toContain("### Tracking")
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

  it("surfaces overdue tracking facts first with ⚠ marker and days-overdue text", async () => {
    // Today is fixed via the fact's review date math below; we just need
    // today ≥ reviewBy for overdue, < reviewBy for active.
    const today = new Date().toISOString().split("T")[0]
    const twentyDaysAgo = new Date(Date.now() - 20 * 86_400_000)
      .toISOString()
      .split("T")[0]
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().split("T")[0]

    const facts: Fact[] = [
      makeFact("active", {
        predicate: "waiting_on",
        object: "Vendor response",
        reviewBy: tomorrow,
      }),
      makeFact("overdue", {
        predicate: "needs_action",
        object: "Rotate keys",
        reviewBy: twentyDaysAgo,
      }),
    ]
    const text = await invokeAsk(facts)

    // Heading reflects the split.
    expect(text).toMatch(/### Tracking \(1 overdue, 1 active\)/)
    // Overdue row carries the ⚠ marker and a days-overdue annotation.
    expect(text).toMatch(/⚠ \*\*AuthService\*\* needs action \*\*Rotate keys\*\*/)
    expect(text).toMatch(/20 days overdue/)
    // Overdue must appear before the active row in the rendered output.
    expect(text.indexOf("Rotate keys")).toBeLessThan(text.indexOf("Vendor response"))
    // Active row does NOT get the ⚠ marker.
    expect(text).not.toMatch(/⚠ \*\*AuthService\*\* waiting on/)
    // Today's date is the implicit anchor — sanity that we didn't flip
    // overdue/active by looking at the wrong side.
    expect(today >= twentyDaysAgo).toBe(true)
  })

  it("renders a due-today tracking row as 'due today' instead of '0 days overdue'", async () => {
    // The overdue gate is `reviewBy <= today` (matches core/fact.ts and
    // lore-audit), so a row whose `reviewBy` is today still fires the ⚠
    // prefix. But the text "0 days overdue" would read as a bug — so the
    // day-zero branch emits "due today" instead.
    const today = new Date().toISOString().split("T")[0]
    const facts: Fact[] = [
      makeFact("due-today", {
        predicate: "needs_action",
        object: "Rotate keys",
        reviewBy: today,
      }),
    ]
    const text = await invokeAsk(facts)

    expect(text).toContain("⚠ **AuthService** needs action **Rotate keys**")
    expect(text).toContain("due today")
    expect(text).not.toMatch(/0 days? overdue/)
    // Overdue count still includes this row — the gating did not change,
    // only the display text for the day-zero branch.
    expect(text).toMatch(/### Tracking \(1 overdue, 0 active\)/)
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

  it("annotates the Tracking heading with a hidden count when rows overflow", async () => {
    const reviewPast = "2026-01-01"
    const facts: Fact[] = Array.from({ length: 7 }, (_, i) =>
      makeFact(`t-${i}`, {
        predicate: "needs_action",
        object: `Task${i}`,
        reviewBy: reviewPast,
      }),
    )
    const text = await invokeAsk(facts)
    // All seven are overdue; cap to 5 so 2 are hidden and surface in the
    // heading inside a single parenthesized suffix.
    expect(text).toMatch(/### Tracking \(7 overdue, 0 active, 2 hidden\)/)
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
      context: { project: { id: "proj-ambient", name: "Ambient" } },
    }

    registerKnowledgeTools(mockServer.server, services as never)
    const handler = mockServer.getHandler("lore-ask")

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
    const loreLearn = mockServer.getHandler("lore-learn")

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
    const loreLearn = mockServer.getHandler("lore-learn")

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
    const loreLearn = mockServer.getHandler("lore-learn")

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
    const loreLearn = mockServer.getHandler("lore-learn")

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
    const loreLearn = mockServer.getHandler("lore-learn")

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
    const loreLearn = mockServer.getHandler("lore-learn")

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
    const loreLearn = mockServer.getHandler("lore-learn")

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
    })
    registerKnowledgeTools(mockServer.server, services as never)
    const loreLearn = mockServer.getHandler("lore-learn")

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

describe("lore-open-loops", () => {
  // Compute dates relative to the test-runner's "today" so the tool's
  // `Date.now()`-driven bucketing is stable across clocks. Hardcoding
  // `2026-04-24` would rot the moment the system clock advanced.
  const today = new Date()
  const dateNDaysFromToday = (days: number): string => {
    const d = new Date(today)
    d.setUTCDate(d.getUTCDate() + days)
    return d.toISOString().split("T")[0]
  }

  function makeLoop(id: string, overrides: Partial<Fact> = {}): Fact {
    return {
      id,
      subject: `subject-${id}`,
      predicate: "needs_action",
      object: `object-${id}`,
      projectIds: [],
      validFrom: dateNDaysFromToday(-30),
      validUntil: null,
      reviewBy: null,
      sourceMemoryId: null,
      confidence: "certain",
      subjectEntityId: null,
      objectEntityId: null,
      ...overrides,
    }
  }

  function servicesWith(loops: Fact[], hasMore = false) {
    return {
      projects: { findByName: vi.fn().mockResolvedValue(null) },
      facts: {
        listTracking: vi
          .fn()
          .mockResolvedValue({ items: loops, hasMore }),
      },
      context: { project: { id: "proj", name: "proj" } },
    }
  }

  it("defaults to a 10-row cap per section and emits the overflow hint when truncated", async () => {
    // The cap is the core P2-07 UX win. 271 loops in the Mail vault
    // flooded agent context; 10+10 gives the urgency spread without the
    // noise, and the hint teaches agents how to escape it.
    const mockServer = createMockServer()
    const overdueRows = Array.from({ length: 15 }, (_, i) =>
      makeLoop(`o-${i}`, { reviewBy: dateNDaysFromToday(-(i + 1)) }),
    )
    const activeRows = Array.from({ length: 15 }, (_, i) =>
      makeLoop(`a-${i}`, { reviewBy: dateNDaysFromToday(i + 1) }),
    )
    const services = servicesWith([...overdueRows, ...activeRows])
    registerKnowledgeTools(mockServer.server, services as never)
    const handler = mockServer.getHandler("lore-open-loops")

    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("### Overdue (10 shown of 15, hiding 5)")
    expect(text).toContain("### Active (10 shown of 15, hiding 5)")
    expect(text).toContain("Pass `{all: true}` to see everything")
  })

  it("truncates both sections independently and shows the hint once when both overflow", async () => {
    // Pinned: the hint fires from EITHER section being truncated. Previous
    // tests only exercise one section being truncated at a time, so this
    // catches a regression where `anyTruncated` accidentally became
    // `overdue && active` (AND) instead of `overdue || active` (OR).
    const mockServer = createMockServer()
    const overdueRows = Array.from({ length: 12 }, (_, i) =>
      makeLoop(`overdue-${i}`, { reviewBy: dateNDaysFromToday(-(i + 1)) }),
    )
    const activeRows = Array.from({ length: 12 }, (_, i) =>
      makeLoop(`active-${i}`, { reviewBy: dateNDaysFromToday(i + 1) }),
    )
    const services = servicesWith([...overdueRows, ...activeRows])
    registerKnowledgeTools(mockServer.server, services as never)
    const handler = mockServer.getHandler("lore-open-loops")

    const result = await handler({ limit: 5 } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("### Overdue (5 shown of 12, hiding 7)")
    expect(text).toContain("### Active (5 shown of 12, hiding 7)")
    // The hint appears exactly once, not once per truncated section.
    const hintMatches = text.match(/Pass `\{all: true\}`/g) ?? []
    expect(hintMatches).toHaveLength(1)
  })

  it("all: true bypasses the cap and omits the overflow hint", async () => {
    const mockServer = createMockServer()
    const loops = Array.from({ length: 15 }, (_, i) =>
      makeLoop(`a-${i}`, { reviewBy: dateNDaysFromToday(i + 1) }),
    )
    const services = servicesWith(loops)
    registerKnowledgeTools(mockServer.server, services as never)
    const handler = mockServer.getHandler("lore-open-loops")

    const result = await handler({ all: true } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("### Active (15)")
    expect(text).not.toContain("shown of")
    expect(text).not.toContain("Pass `{all: true}`")
  })

  it("explicit limit overrides the default", async () => {
    const mockServer = createMockServer()
    const loops = Array.from({ length: 10 }, (_, i) =>
      makeLoop(`a-${i}`, { reviewBy: dateNDaysFromToday(i + 1) }),
    )
    const services = servicesWith(loops)
    registerKnowledgeTools(mockServer.server, services as never)
    const handler = mockServer.getHandler("lore-open-loops")

    const result = await handler({ limit: 3 } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("### Active (3 shown of 10, hiding 7)")
  })

  it("passes the entity filter through to FactService.listTracking", async () => {
    // Server-side filter is the scalability lever — capping client-side
    // on 271 rows wastes a request's worth of payload every time.
    const mockServer = createMockServer()
    const services = servicesWith([])
    registerKnowledgeTools(mockServer.server, services as never)
    const handler = mockServer.getHandler("lore-open-loops")

    await handler({ entity: "PR #25751" } as never)

    expect(services.facts.listTracking).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "PR #25751" }),
    )
  })

  it("annotates the total line with the entity filter and handles the empty case", async () => {
    const mockServer = createMockServer()
    const services = servicesWith([])
    registerKnowledgeTools(mockServer.server, services as never)
    const handler = mockServer.getHandler("lore-open-loops")

    const result = await handler({ entity: "ghost-entity" } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain('No open loops found matching "ghost-entity"')
  })

  it("marks ⚠⚠ for >=14 days overdue, ⚠ for >=1 day, and ranks most-overdue first", async () => {
    // Urgency thresholds are pinned because agents parse them — flipping
    // `>=14` to `>14` silently downgrades a two-week-overdue blocker.
    // IDs chosen so none is a prefix of another (avoids `indexOf` false
    // matches when one row embeds a shorter row's id in its subject).
    const mockServer = createMockServer()
    const loops = [
      makeLoop("mild3d", { reviewBy: dateNDaysFromToday(-3) }),
      makeLoop("severe20d", { reviewBy: dateNDaysFromToday(-20) }),
      makeLoop("edge14d", { reviewBy: dateNDaysFromToday(-14) }),
      makeLoop("edge1d", { reviewBy: dateNDaysFromToday(-1) }),
    ]
    const services = servicesWith(loops)
    registerKnowledgeTools(mockServer.server, services as never)
    const handler = mockServer.getHandler("lore-open-loops")

    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    // Order: 20-day > 14-day > 3-day > 1-day (most-overdue first).
    const idx20 = text.indexOf("severe20d")
    const idx14 = text.indexOf("edge14d")
    const idx3 = text.indexOf("mild3d")
    const idx1 = text.indexOf("edge1d")
    expect(idx20).toBeGreaterThanOrEqual(0)
    expect(idx20).toBeLessThan(idx14)
    expect(idx14).toBeLessThan(idx3)
    expect(idx3).toBeLessThan(idx1)

    // Marker boundaries.
    expect(text).toMatch(/⚠⚠ 20 days overdue:.*severe20d/)
    expect(text).toMatch(/⚠⚠ 14 days overdue:.*edge14d/)
    expect(text).toMatch(/⚠ 3 days overdue:.*mild3d/)
    expect(text).toMatch(/⚠ 1 day overdue:.*edge1d/)
  })

  it("breaks ties via id lex when days-overdue and validFrom both match", async () => {
    // Deterministic ultimate tiebreaker. Without it, two same-day
    // assertions of identical triples rely on Notion's result-page order,
    // which is implementation-defined and could silently flip under a
    // future Notion API change. id-lex is cheap and test-pinnable.
    const mockServer = createMockServer()
    const sameReview = dateNDaysFromToday(-5)
    const sameValidFrom = dateNDaysFromToday(-10)
    const loops = [
      makeLoop("loop-zeta", { reviewBy: sameReview, validFrom: sameValidFrom }),
      makeLoop("loop-alpha", { reviewBy: sameReview, validFrom: sameValidFrom }),
      makeLoop("loop-mu", { reviewBy: sameReview, validFrom: sameValidFrom }),
    ]
    const services = servicesWith(loops)
    registerKnowledgeTools(mockServer.server, services as never)
    const handler = mockServer.getHandler("lore-open-loops")

    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    const idxAlpha = text.indexOf("loop-alpha")
    const idxMu = text.indexOf("loop-mu")
    const idxZeta = text.indexOf("loop-zeta")
    expect(idxAlpha).toBeLessThan(idxMu)
    expect(idxMu).toBeLessThan(idxZeta)
  })

  it("rejects limit: 0 at the schema boundary", async () => {
    // `.min(1)` on the Zod schema means `limit: 0` never reaches the
    // handler. Zero-cap output is a nonsense state (every section
    // rendered as `0 shown of N, hiding N`); callers wanting full
    // output use `{all: true}`, callers wanting the default omit `limit`.
    const mockServer = createMockServer()
    const services = servicesWith([makeLoop("a-1", { reviewBy: dateNDaysFromToday(1) })])
    registerKnowledgeTools(mockServer.server, services as never)
    // Find the config passed to registerTool so we can validate the schema
    // directly (the handler itself is post-validation).
    const registerSpy = mockServer.server.registerTool as unknown as ReturnType<typeof vi.fn>
    const call = registerSpy.mock.calls.find((c) => c[0] === "lore-open-loops")
    expect(call).toBeDefined()
    const config = call![1] as { inputSchema: Record<string, z.ZodTypeAny> }
    const parsed = config.inputSchema.limit.safeParse(0)
    expect(parsed.success).toBe(false)

    // Sanity: `all: true` remains a valid escape hatch.
    const handler = mockServer.getHandler("lore-open-loops")
    const okResult = await handler({ all: true } as never)
    expect((okResult as { content: Array<{ text: string }> }).content[0].text).toContain(
      "### Active",
    )
  })

  it("ranks Active by soonest review date, with no-review rows sinking to the bottom", async () => {
    const mockServer = createMockServer()
    const loops = [
      makeLoop("a-far", { reviewBy: dateNDaysFromToday(30) }),
      makeLoop("a-no-review", { reviewBy: null }),
      makeLoop("a-soon", { reviewBy: dateNDaysFromToday(2) }),
    ]
    const services = servicesWith(loops)
    registerKnowledgeTools(mockServer.server, services as never)
    const handler = mockServer.getHandler("lore-open-loops")

    const result = await handler({ all: true } as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    const idxSoon = text.indexOf("a-soon")
    const idxFar = text.indexOf("a-far")
    const idxNone = text.indexOf("a-no-review")
    expect(idxSoon).toBeLessThan(idxFar)
    expect(idxFar).toBeLessThan(idxNone)
    expect(text).toContain("— no review date")
  })

  it("surfaces the service-layer safety-cap clip as a warning", async () => {
    // Defense in depth: if the service paginator ever hits its safety
    // valve (bug, adversarial filter), the tool layer must tell the
    // agent the result set is incomplete — not silently return a
    // clipped list.
    const mockServer = createMockServer()
    const services = servicesWith([makeLoop("x")], true)
    registerKnowledgeTools(mockServer.server, services as never)
    const handler = mockServer.getHandler("lore-open-loops")

    const result = await handler({} as never)
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain("Warnings:")
    expect(text).toContain("safety cap")
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
    const handler = mockServer.getHandler("lore-audit")

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
    const loreLearn = mockServer.getHandler("lore-learn")

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
    const loreLearn = mockServer.getHandler("lore-learn")

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

describe("lore-learn — P3-02 tracking predicate rejection", () => {
  function makeServices() {
    return {
      projects: { findByName: vi.fn() },
      facts: { create: vi.fn(), createWithDedup: vi.fn() },
      sessionMemories: {
        record: vi.fn(),
        get: vi.fn().mockReturnValue(undefined),
      },
      context: { project: null, isCatchAllFallback: false },
    }
  }

  it.each(["needs_action", "waiting_on", "blocked_by"])(
    "rejects %s with a redirect to the polymorphic lore-task action='create'",
    async (predicate) => {
      const mockServer = createMockServer()
      const services = makeServices()
      registerKnowledgeTools(mockServer.server, services as never)
      const loreLearn = mockServer.getHandler("lore-learn")

      const result = await loreLearn({
        subject: "AuthService",
        predicate,
        object: "Audit secret rotation",
      } as never)

      const payload = result as { content: Array<{ text: string }>; isError?: boolean }
      expect(payload.isError).toBe(true)
      // The error message names the polymorphic surface (PF3-06) — not the
      // deprecated `lore-task-create` alias. The rejection is the
      // moment-of-mistake nudge, so it must teach the surface that's not
      // itself deprecated.
      expect(payload.content[0].text).toContain("lore-task")
      expect(payload.content[0].text).toContain("action: 'create'")
      expect(payload.content[0].text).not.toMatch(/`lore-task-create`/)
      expect(payload.content[0].text).toContain("subject")
      expect(payload.content[0].text).toContain("description")
      // Crucially: no fact was written.
      expect(services.facts.createWithDedup).not.toHaveBeenCalled()
    }
  )
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
    const loreAsk = mockServer.getHandler("lore-ask")

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
    const loreAsk = mockServer.getHandler("lore-ask")

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
    const loreAsk = mockServer.getHandler("lore-ask")

    await loreAsk({ entity: "AuthService" } as never)

    const callArgs = (services.tasks.list as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
    expect(callArgs).not.toHaveProperty("states")
  })

  it("renders 'No facts or tasks' when both queries return empty", async () => {
    const mockServer = createMockServer()
    const services = makeAskServices()
    registerKnowledgeTools(mockServer.server, services as never)
    const loreAsk = mockServer.getHandler("lore-ask")

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
    const loreAsk = mockServer.getHandler("lore-ask")

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
    const loreAsk = mockServer.getHandler("lore-ask")

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
    const loreAsk = mockServer.getHandler("lore-ask")

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
    const loreAsk = mockServer.getHandler("lore-ask")

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
    const loreAsk = mockServer.getHandler("lore-ask")

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
    const loreAsk = mockServer.getHandler("lore-ask")

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
