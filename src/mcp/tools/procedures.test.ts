import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { registerProcedureTools } from "./procedures.js"
import type { Memory } from "../../types.js"

type Handler = (...args: unknown[]) => Promise<{
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
  costOutputs?: Record<string, number>
}>

function createMockServer() {
  const handlers = new Map<string, Handler>()
  const server = {
    registerTool: vi.fn((name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler)
    }),
  } as unknown as McpServer
  return {
    server,
    get(name: string): Handler {
      const handler = handlers.get(name)
      if (!handler) throw new Error(`missing handler ${name}`)
      return handler
    },
    has(name: string): boolean {
      return handlers.has(name)
    },
  }
}

function makeMemory(overrides: Partial<Memory> & { id: string; title: string }): Memory {
  return {
    projectIds: ["proj-A"],
    topicId: null,
    source: "manual",
    kind: "procedure",
    status: "proposed",
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
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
    taskState: null,
    blockedBy: "",
    entity: "",
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
    scope: null,
    ...overrides,
  }
}

interface StubServices {
  config: unknown
  context: { project: { id: string; name: string } | null; vault: { pageId: string } }
  projects: { list: ReturnType<typeof vi.fn>; findByName: ReturnType<typeof vi.fn> }
  memories: {
    list: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    getById: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    findByTopicKey: ReturnType<typeof vi.fn>
  }
  tasks: { list: ReturnType<typeof vi.fn> }
  // `withWakeUpCacheBump` is wrapped around `propose` / `deprecate`
  // so a long-running MCP server cannot serve a pre-write wake-up
  // snapshot for the 30s TTL after a procedure write. The stub
  // mirrors `services.ts`'s shape; tests assert `bumpEpoch` fires.
  wakeupCache: { bumpEpoch: ReturnType<typeof vi.fn> }
}

/**
 * Stub source memory used by the propose tests. Default shape is a
 * live incident in the SandboxProject scope — `resolveProcedureSources`
 * accepts these without raising. Tests that need a rejection wire up
 * a one-off override.
 */
function makeSourceStub(id: string, overrides: Partial<Memory> = {}): Memory {
  return makeMemory({
    id,
    title: `Stub source ${id.slice(0, 6)}`,
    kind: "incident",
    status: "accepted",
    ...overrides,
  })
}

function makeServices(): StubServices {
  // Default `getById` returns a live, accepted incident in scope so the
  // happy-path propose tests don't need to wire fixtures for every
  // source id; tests that want a rejection override per call.
  const getById = vi.fn(async (id: string) =>
    makeSourceStub(id, { projectIds: ["proj-A"] })
  )
  return {
    config: { vault: { pageId: "v1" }, projects: [] },
    context: { project: { id: "proj-A", name: "Alpha" }, vault: { pageId: "v1" } },
    projects: {
      list: vi.fn(async () => []),
      findByName: vi.fn(async () => null),
    },
    memories: {
      list: vi.fn(async () => ({ items: [], nextCursor: undefined, capped: false })),
      create: vi.fn(),
      getById,
      update: vi.fn(async () => undefined),
      // Default: no existing procedure on the topic-key slot (fresh-
      // create path). Tests that want to exercise reuse / conflict
      // override per call.
      findByTopicKey: vi.fn(async () => null),
    },
    tasks: {
      list: vi.fn(async () => ({ items: [], nextCursor: undefined, capped: false })),
    },
    wakeupCache: { bumpEpoch: vi.fn() },
  }
}

describe("lore-procedure registration", () => {
  it("registers exactly one tool name `lore-procedure`", () => {
    const mock = createMockServer()
    registerProcedureTools(mock.server, makeServices() as never)
    expect(mock.has("lore-procedure")).toBe(true)
  })
})

describe("lore-procedure wake-up cache invalidation", () => {
  // `withWakeUpCacheBump` bumps the wake-up cache epoch around every
  // write action so a long-running MCP server cannot serve a pre-
  // write snapshot for the 30s cache TTL after a procedure write.
  // The dispatcher wraps `propose` and `deprecate`; `scan-candidates`
  // is read-only and must NOT bump.

  it("scan-candidates does NOT bump the wake-up cache epoch (read-only)", async () => {
    const mock = createMockServer()
    const services = makeServices()
    registerProcedureTools(mock.server, services as never)
    await mock.get("lore-procedure")({ action: "scan-candidates" })
    expect(services.wakeupCache.bumpEpoch).not.toHaveBeenCalled()
  })

  it("propose bumps the wake-up cache epoch", async () => {
    const mock = createMockServer()
    const services = makeServices()
    services.memories.create = vi.fn(async () =>
      makeMemory({
        id: "11111111-1111-1111-1111-111111111111",
        title: "Created",
        kind: "procedure",
        status: "proposed",
      })
    ) as never
    registerProcedureTools(mock.server, services as never)
    await mock.get("lore-procedure")({
      action: "propose",
      title: "Test",
      entity: "cache",
      steps: ["one"],
      sourceMemoryIds: [
        "abababababababababababababababab",
        "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      ],
    })
    expect(services.wakeupCache.bumpEpoch).toHaveBeenCalled()
  })

  it("deprecate bumps the wake-up cache epoch", async () => {
    const mock = createMockServer()
    const services = makeServices()
    services.memories.getById = vi.fn(async () =>
      makeMemory({
        id: "1234567890abcdef1234567890abcdef",
        title: "Accepted procedure",
        kind: "procedure",
        status: "accepted",
        content: "## Activation Conditions\n- always",
      })
    ) as never
    registerProcedureTools(mock.server, services as never)
    await mock.get("lore-procedure")({
      action: "deprecate",
      memoryId: "1234567890abcdef1234567890abcdef",
    })
    expect(services.wakeupCache.bumpEpoch).toHaveBeenCalled()
  })
})

describe("lore-procedure action='scan-candidates'", () => {
  let mock: ReturnType<typeof createMockServer>
  let services: ReturnType<typeof makeServices>

  beforeEach(() => {
    mock = createMockServer()
    services = makeServices()
    registerProcedureTools(mock.server, services as never)
  })

  it("returns no-candidates copy on an empty vault", async () => {
    const result = await mock.get("lore-procedure")({ action: "scan-candidates" })
    expect(result.isError).toBeFalsy()
    expect(result.content[0]!.text).toContain("No procedure candidates surfaced")
    expect(result.costOutputs).toEqual({ proceduresReturned: 0 })
  })

  it("surfaces ranked clusters when source memories pass the threshold", async () => {
    services.memories.list = vi.fn(async (opts?: { kind?: Memory["kind"] }) => {
      if (opts?.kind === "incident") {
        return {
          items: [
            makeMemory({
              id: "i1",
              title: "PR #1234 latency",
              kind: "incident",
              keywords: "PR-1234",
              status: "accepted",
            }),
            makeMemory({
              id: "i2",
              title: "PR #1234 followup",
              kind: "incident",
              keywords: "PR-1234",
              status: "accepted",
            }),
          ],
          nextCursor: undefined,
          capped: false,
        }
      }
      return { items: [], nextCursor: undefined, capped: false }
    })
    const result = await mock.get("lore-procedure")({ action: "scan-candidates" })
    expect(result.isError).toBeFalsy()
    expect(result.content[0]!.text).toContain("Procedure candidates (1)")
    expect(result.content[0]!.text).toContain("pr-1234")
    expect(result.costOutputs).toEqual({ proceduresReturned: 1 })
  })

  it("returns an error when no project is resolved", async () => {
    services.context = { project: null, vault: { pageId: "v1" } } as never
    const result = await mock.get("lore-procedure")({ action: "scan-candidates" })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("No project resolved")
  })

  it("rejects an out-of-range limit at the dispatch boundary", async () => {
    const result = await mock.get("lore-procedure")({
      action: "scan-candidates",
      limit: 10000,
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("lore-procedure")
  })
})

describe("lore-procedure action='propose'", () => {
  let mock: ReturnType<typeof createMockServer>
  let services: ReturnType<typeof makeServices>

  beforeEach(() => {
    mock = createMockServer()
    services = makeServices()
    registerProcedureTools(mock.server, services as never)
  })

  it("creates a kind=procedure status=proposed memory with composed body", async () => {
    services.memories.create = vi.fn(async (input: unknown) => {
      const typed = input as {
        title: string
        kind: string
        status: string
        content: string
      }
      return makeMemory({
        id: "proc-new",
        title: typed.title,
        kind: typed.kind as Memory["kind"],
        status: typed.status as Memory["status"],
        content: typed.content,
      })
    }) as never
    const result = await mock.get("lore-procedure")({
      action: "propose",
      title: "PR-1234 latency triage",
      entity: "PR-1234",
      activationConditions: ["Entity matches PR-1234"],
      steps: ["Check Grafana", "Page oncall"],
      sourceMemoryIds: [
        "abababababababababababababababab",
        "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      ],
    })
    expect(result.isError).toBeFalsy()
    expect(result.content[0]!.text).toContain("Proposed procedure:")
    expect(result.content[0]!.text).toContain("Status: proposed")
    expect(result.costOutputs).toEqual({ memoriesCreated: 1 })
    const callArg = (services.memories.create as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as {
      kind: string
      status: string
      content: string
      topicKey?: string
    }
    expect(callArg.kind).toBe("procedure")
    expect(callArg.status).toBe("proposed")
    expect(callArg.content).toContain("## Activation Conditions")
    expect(callArg.content).toContain("## Steps")
    expect(callArg.topicKey).toBe("procedure/pr-1234")
  })

  it("rejects a propose call with zero steps at the schema boundary", async () => {
    const result = await mock.get("lore-procedure")({
      action: "propose",
      title: "Empty procedure",
      steps: [],
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("lore-procedure")
  })

  it("rejects a propose call with whitespace-only title at the schema boundary", async () => {
    const result = await mock.get("lore-procedure")({
      action: "propose",
      title: "   ",
      steps: ["one"],
    })
    expect(result.isError).toBe(true)
  })

  it("threads supersedesIds onto the create input", async () => {
    // `resolveProcedureSupersedesIds` runs liveness + kind-set
    // validation on supersedes targets; stub getById to return a
    // procedure for the supersedes id (default stub returns
    // `incident` which is not a valid supersedes target).
    const supersedesIdCanonical = "efefefef-efef-efef-efef-efefefefefef"
    services.memories.getById = vi.fn(async (id: string) => {
      if (id === supersedesIdCanonical) {
        return makeMemory({
          id,
          title: "Older procedure to retire",
          kind: "procedure",
          status: "accepted",
          projectIds: ["proj-A"],
        })
      }
      return makeSourceStub(id, { projectIds: ["proj-A"] })
    })
    services.memories.create = vi.fn(async (input: unknown) => {
      const typed = input as { title: string }
      return makeMemory({ id: "proc-new", title: typed.title })
    }) as never
    const result = await mock.get("lore-procedure")({
      action: "propose",
      title: "Replacement",
      entity: "cache",
      steps: ["one"],
      sourceMemoryIds: [
        "abababababababababababababababab",
        "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      ],
      supersedesIds: ["efefefefefefefefefefefefefefefef"],
    })
    expect(result.isError).toBeFalsy()
    const callArg = (services.memories.create as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as {
      supersedesIds?: string[]
    }
    // The notionPageIdSchema canonicalizes 32-char hex into dashed UUID.
    expect(callArg.supersedesIds).toEqual([supersedesIdCanonical])
  })

  it("rejects whitespace-only steps at the schema boundary", async () => {
    const result = await mock.get("lore-procedure")({
      action: "propose",
      title: "Procedure with blank step",
      entity: "cache",
      steps: ["   "],
      sourceMemoryIds: [
        "abababababababababababababababab",
        "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      ],
    })
    // Without this gate `composeProcedureBody` renders the trimmed
    // step as a bare `1. ` and defeats the procedure-vs-note boundary.
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("lore-procedure")
  })

  it("rejects propose with zero source memory ids", async () => {
    const result = await mock.get("lore-procedure")({
      action: "propose",
      title: "Procedure with no provenance",
      entity: "cache",
      steps: ["one"],
      sourceMemoryIds: [],
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("lore-procedure")
  })

  it("rejects propose with a single source memory id (below MIN_SOURCES)", async () => {
    // The propose path mirrors the scan's `PROCEDURE_MIN_SOURCES`
    // threshold so the auditable evidence trail can't be bypassed.
    const result = await mock.get("lore-procedure")({
      action: "propose",
      title: "Procedure with one source only",
      entity: "cache",
      steps: ["one"],
      sourceMemoryIds: ["abababababababababababababababab"],
    })
    expect(result.isError).toBe(true)
  })

  it("rejects propose when sourceMemoryIds is omitted entirely", async () => {
    const result = await mock.get("lore-procedure")({
      action: "propose",
      title: "Procedure with omitted sources",
      entity: "cache",
      steps: ["one"],
    })
    expect(result.isError).toBe(true)
  })

  it("rejects propose when entity + title both normalize to empty (no derivable topic key)", async () => {
    const result = await mock.get("lore-procedure")({
      action: "propose",
      // Title satisfies the non-blank schema but contains no
      // alphanumeric characters — normalizeClusterKey returns "".
      title: "!!!",
      entity: "???",
      steps: ["one"],
      sourceMemoryIds: [
        "abababababababababababababababab",
        "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      ],
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("non-empty topic key")
    expect(result.content[0]!.text).toContain("topicKey")
    expect(services.memories.create).not.toHaveBeenCalled()
  })

  it("rejects propose when topicKey is whitespace-only", async () => {
    // Whitespace-only topicKey would defeat the idempotency probe
    // (`findByTopicKey` only short-circuits on exactly "").
    const result = await mock.get("lore-procedure")({
      action: "propose",
      title: "Procedure with bogus topic key",
      entity: "cache",
      steps: ["one"],
      sourceMemoryIds: [
        "abababababababababababababababab",
        "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      ],
      topicKey: "   ",
    })
    expect(result.isError).toBe(true)
    expect(services.memories.create).not.toHaveBeenCalled()
  })

  it("runs the idempotency probe BEFORE source resolution (reuse short-circuit saves getById round-trips)", async () => {
    const existingProposed = makeMemory({
      id: "feedfeedfeedfeedfeedfeedfeedfeed",
      title: "Existing in-flight procedure",
      kind: "procedure",
      status: "proposed",
      topicKey: "procedure/pr-1234",
      projectIds: ["proj-A"],
    })
    services.memories.findByTopicKey = vi.fn(async () => existingProposed)
    // If the source resolution ran first, the probe's reuse short-
    // circuit would still pay N getById round-trips. Make getById
    // throw so this test fails if the order regresses.
    services.memories.getById = vi.fn(async () => {
      throw new Error("getById must not run before the topic-key probe on the reuse path")
    })
    const result = await mock.get("lore-procedure")({
      action: "propose",
      title: "Retry propose",
      entity: "PR-1234",
      steps: ["one"],
      sourceMemoryIds: [
        "abababababababababababababababab",
        "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      ],
    })
    expect(result.isError).toBeFalsy()
    expect(result.content[0]!.text).toContain("Reused existing proposed procedure")
    expect(services.memories.getById).not.toHaveBeenCalled()
  })

  it("rejects propose when a source memory id does not resolve to a live memory", async () => {
    // Source id #2 returns null-equivalent: simulate getById throwing
    // 404 / archived. The validator collects every failure and surfaces
    // them with per-id reasons.
    services.memories.getById = vi.fn(async (id: string) => {
      if (id === "cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd") {
        throw new Error("Notion 404 (archived or not found)")
      }
      return makeSourceStub(id, { projectIds: ["proj-A"] })
    })
    const result = await mock.get("lore-procedure")({
      action: "propose",
      title: "Procedure with bad source",
      entity: "cache",
      steps: ["one"],
      sourceMemoryIds: [
        "abababababababababababababababab",
        "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      ],
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("Procedure source validation failed")
    expect(result.content[0]!.text).toContain("lookup failed")
  })

  it("rejects propose when a source memory has incompatible kind", async () => {
    services.memories.getById = vi.fn(async (id: string) =>
      makeSourceStub(id, { kind: "decision", projectIds: ["proj-A"] })
    )
    const result = await mock.get("lore-procedure")({
      action: "propose",
      title: "Procedure with wrong-kind source",
      entity: "cache",
      steps: ["one"],
      sourceMemoryIds: [
        "abababababababababababababababab",
        "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      ],
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain(
      "kind 'decision' is not a valid procedure source"
    )
  })

  it("rejects propose when a source memory's project scope does not overlap", async () => {
    services.memories.getById = vi.fn(async (id: string) =>
      makeSourceStub(id, { projectIds: ["proj-OTHER"] })
    )
    const result = await mock.get("lore-procedure")({
      action: "propose",
      title: "Procedure with wrong-project source",
      entity: "cache",
      steps: ["one"],
      sourceMemoryIds: [
        "abababababababababababababababab",
        "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      ],
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("project scope")
    expect(result.content[0]!.text).toContain("does not overlap")
  })

  it("reuses an existing proposed procedure on the same (topicKey, project-set) slot", async () => {
    const existingProposed = makeMemory({
      id: "feedfeedfeedfeedfeedfeedfeedfeed",
      title: "Existing in-flight procedure",
      kind: "procedure",
      status: "proposed",
      topicKey: "procedure/pr-1234",
      projectIds: ["proj-A"],
    })
    services.memories.findByTopicKey = vi.fn(async () => existingProposed)
    const result = await mock.get("lore-procedure")({
      action: "propose",
      title: "Duplicate propose attempt",
      entity: "PR-1234",
      steps: ["one"],
      sourceMemoryIds: [
        "abababababababababababababababab",
        "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      ],
    })
    expect(result.isError).toBeFalsy()
    expect(result.content[0]!.text).toContain("Reused existing proposed procedure")
    expect(result.content[0]!.text).toContain(existingProposed.id)
    expect(result.costOutputs).toEqual({ memoriesReturned: 1 })
    // No create on the reuse path.
    expect(services.memories.create).not.toHaveBeenCalled()
  })

  it("rejects propose when an accepted procedure already holds the topic-key slot", async () => {
    services.memories.findByTopicKey = vi.fn(async () =>
      makeMemory({
        id: "11111111111111111111111111111111",
        title: "Existing accepted procedure",
        kind: "procedure",
        status: "accepted",
        topicKey: "procedure/pr-1234",
        projectIds: ["proj-A"],
      })
    )
    const result = await mock.get("lore-procedure")({
      action: "propose",
      title: "Replacement attempt without explicit deprecate",
      entity: "PR-1234",
      steps: ["one"],
      sourceMemoryIds: [
        "abababababababababababababababab",
        "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      ],
    })
    expect(result.isError).toBe(true)
    // Error guides the operator at the deprecate path.
    expect(result.content[0]!.text).toContain("An accepted procedure already exists")
    expect(result.content[0]!.text).toContain("deprecate")
  })

  it("rejects propose when a non-procedure kind holds the same topic-key slot", async () => {
    services.memories.findByTopicKey = vi.fn(async () =>
      makeMemory({
        id: "22222222222222222222222222222222",
        title: "Existing runbook on the slot",
        kind: "runbook",
        status: "accepted",
        topicKey: "procedure/pr-1234",
        projectIds: ["proj-A"],
      })
    )
    const result = await mock.get("lore-procedure")({
      action: "propose",
      title: "Procedure claiming runbook's slot",
      entity: "PR-1234",
      steps: ["one"],
      sourceMemoryIds: [
        "abababababababababababababababab",
        "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      ],
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("already held by a kind='runbook'")
  })

  it("emits an explicit supersession footer instructing deprecate after approval", async () => {
    // The supersedes target must be a live procedure or runbook in
    // scope — `resolveProcedureSupersedesIds` validates it before
    // the write. Stub getById to return an accepted runbook for the
    // supersedes id; sources keep the default incident shape.
    const supersedesId = "44444444-4444-4444-4444-444444444444"
    services.memories.getById = vi.fn(async (id: string) => {
      if (id === supersedesId) {
        return makeMemory({
          id,
          title: "Old runbook to retire",
          kind: "runbook",
          status: "accepted",
          projectIds: ["proj-A"],
        })
      }
      return makeSourceStub(id, { projectIds: ["proj-A"] })
    })
    services.memories.create = vi.fn(async (input: unknown) =>
      makeMemory({
        id: "33333333-3333-3333-3333-333333333333",
        title: (input as { title: string }).title,
        kind: "procedure",
        status: "proposed",
        supersedesIds: [supersedesId],
      })
    ) as never
    const result = await mock.get("lore-procedure")({
      action: "propose",
      title: "Replacement procedure",
      entity: "cache",
      steps: ["one"],
      sourceMemoryIds: [
        "abababababababababababababababab",
        "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      ],
      supersedesIds: ["44444444444444444444444444444444"],
    })
    expect(result.isError).toBeFalsy()
    expect(result.content[0]!.text).toContain("Supersession recorded")
    expect(result.content[0]!.text).toContain("Notion does NOT auto-deprecate")
    expect(result.content[0]!.text).toContain("lore-procedure action='deprecate'")
  })

  it("rejects propose when a supersedesIds target does not resolve to a live memory", async () => {
    const supersedesId = "44444444-4444-4444-4444-444444444444"
    services.memories.getById = vi.fn(async (id: string) => {
      if (id === supersedesId) {
        throw new Error("Notion 404 (archived or not found)")
      }
      return makeSourceStub(id, { projectIds: ["proj-A"] })
    })
    const result = await mock.get("lore-procedure")({
      action: "propose",
      title: "Replacement attempt",
      entity: "cache",
      steps: ["one"],
      sourceMemoryIds: [
        "abababababababababababababababab",
        "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      ],
      supersedesIds: ["44444444444444444444444444444444"],
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("supersedesIds validation failed")
    expect(result.content[0]!.text).toContain("lookup failed")
    expect(services.memories.create).not.toHaveBeenCalled()
  })

  it("rejects propose when a supersedesIds target has incompatible kind", async () => {
    const supersedesId = "44444444-4444-4444-4444-444444444444"
    services.memories.getById = vi.fn(async (id: string) => {
      if (id === supersedesId) {
        // Can't supersede a decision via a procedure — decisions
        // carry their own supersession semantics.
        return makeMemory({
          id,
          title: "Decision (wrong kind for supersedes)",
          kind: "decision",
          status: "accepted",
          projectIds: ["proj-A"],
        })
      }
      return makeSourceStub(id, { projectIds: ["proj-A"] })
    })
    const result = await mock.get("lore-procedure")({
      action: "propose",
      title: "Replacement attempt",
      entity: "cache",
      steps: ["one"],
      sourceMemoryIds: [
        "abababababababababababababababab",
        "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      ],
      supersedesIds: ["44444444444444444444444444444444"],
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain(
      "kind 'decision' is not a valid supersedesIds target"
    )
    expect(services.memories.create).not.toHaveBeenCalled()
  })
})

describe("lore-procedure action='deprecate'", () => {
  let mock: ReturnType<typeof createMockServer>
  let services: ReturnType<typeof makeServices>

  beforeEach(() => {
    mock = createMockServer()
    services = makeServices()
    registerProcedureTools(mock.server, services as never)
  })

  it("flips an accepted procedure to status='deprecated' and writes once", async () => {
    services.memories.getById = vi.fn(async () =>
      makeMemory({
        id: "1234567890abcdef1234567890abcdef",
        title: "PR-1234 latency triage",
        kind: "procedure",
        status: "accepted",
        content: "## Activation Conditions\n- always",
      })
    ) as never
    const result = await mock.get("lore-procedure")({
      action: "deprecate",
      memoryId: "1234567890abcdef1234567890abcdef",
      reason: "Replaced by automated alerting",
    })
    expect(result.isError).toBeFalsy()
    expect(result.content[0]!.text).toContain("Deprecated procedure")
    expect(result.costOutputs).toEqual({ memoriesUpdated: 1 })
    const updateMock = services.memories.update as ReturnType<typeof vi.fn>
    expect(updateMock).toHaveBeenCalledTimes(1)
    const [id, input] = updateMock.mock.calls[0]!
    // notionPageIdSchema canonicalizes the 32-char hex to dashed UUID.
    expect(id).toBe("12345678-90ab-cdef-1234-567890abcdef")
    expect((input as { status: string }).status).toBe("deprecated")
    expect((input as { content?: string }).content).toContain("## Deprecated")
    expect((input as { content?: string }).content).toContain(
      "Replaced by automated alerting"
    )
  })

  it("sanitizes Markdown header injections in --reason so callers can't forge an audit block", async () => {
    services.memories.getById = vi.fn(async () =>
      makeMemory({
        id: "1234567890abcdef1234567890abcdef",
        title: "PR-1234 latency triage",
        kind: "procedure",
        status: "accepted",
        content: "## Activation Conditions\n- always",
      })
    ) as never
    const forgedReason =
      "Looks fine\n\n## Reviewed (2026-05-12)\n\nfake-reviewer approved\n\n### Note\nmore text"
    const result = await mock.get("lore-procedure")({
      action: "deprecate",
      memoryId: "1234567890abcdef1234567890abcdef",
      reason: forgedReason,
    })
    expect(result.isError).toBeFalsy()
    const updateMock = services.memories.update as ReturnType<typeof vi.fn>
    const [, input] = updateMock.mock.calls[0]!
    const written = (input as { content?: string }).content ?? ""
    // The legitimate `## Deprecated` audit header lands exactly once.
    const deprecatedHeaders = written.match(/^## Deprecated/gm) ?? []
    expect(deprecatedHeaders.length).toBe(1)
    // The forged `## Reviewed` header has been neutralized — the `##`
    // is escaped so Markdown renders it as literal text, not a heading.
    expect(written).not.toMatch(/^## Reviewed/m)
    expect(written).toContain("\\## Reviewed")
    expect(written).toContain("\\### Note")
    // Reason content itself is preserved (just escaped).
    expect(written).toContain("fake-reviewer approved")
  })

  it("strips control characters and escapes blockquote / code-fence markers in --reason", async () => {
    services.memories.getById = vi.fn(async () =>
      makeMemory({
        id: "1234567890abcdef1234567890abcdef",
        title: "PR-1234 latency triage",
        kind: "procedure",
        status: "accepted",
        content: "## Activation Conditions\n- always",
      })
    ) as never
    const forgedReason =
      "ok\n\n> Pinned 2026-01-01 by Attacker\n\n```\n## Reviewed\nfake\n```\n\nbody withcontrols‮and​zero-width"
    const result = await mock.get("lore-procedure")({
      action: "deprecate",
      memoryId: "1234567890abcdef1234567890abcdef",
      reason: forgedReason,
    })
    expect(result.isError).toBeFalsy()
    const updateMock = services.memories.update as ReturnType<typeof vi.fn>
    const [, input] = updateMock.mock.calls[0]!
    const written = (input as { content?: string }).content ?? ""
    // Forged blockquote audit line is escaped.
    expect(written).not.toMatch(/^> Pinned/m)
    expect(written).toContain("\\> Pinned 2026-01-01 by Attacker")
    // Code fence markers are escaped so the audit block stays closed.
    expect(written).toMatch(/\\```/)
    // Nested `## Reviewed` inside the fenced block is still escaped.
    expect(written).not.toMatch(/^## Reviewed/m)
    // C0 controls, bidi-override, and zero-width characters are stripped
    // entirely (preserving `\n` would be deliberate but these are not).
    // eslint-disable-next-line no-control-regex
    expect(written).not.toMatch(/[\u0000\u0007\u200B\u202E]/)
    // The legitimate audit block lands exactly once.
    const deprecatedHeaders = written.match(/^## Deprecated/gm) ?? []
    expect(deprecatedHeaders.length).toBe(1)
    // The plain prose tail of the reason survives ("withcontrolsandzero-width"
    // after the stripped chars; the test pins the substring that survives).
    expect(written).toContain("bodywithcontrolsandzero-width")
  })

  it("refuses to deprecate non-procedure memories", async () => {
    services.memories.getById = vi.fn(async () =>
      makeMemory({
        id: "abcdef1234567890abcdef1234567890",
        title: "Not a procedure",
        kind: "note",
      })
    ) as never
    const result = await mock.get("lore-procedure")({
      action: "deprecate",
      memoryId: "abcdef1234567890abcdef1234567890",
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('not "procedure"')
  })

  it("rejects deprecate on a Status: proposed procedure (must leave via review)", async () => {
    services.memories.getById = vi.fn(async () =>
      makeMemory({
        id: "1234567890abcdef1234567890abcdef",
        title: "Proposed procedure",
        kind: "procedure",
        status: "proposed",
      })
    ) as never
    const result = await mock.get("lore-procedure")({
      action: "deprecate",
      memoryId: "1234567890abcdef1234567890abcdef",
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain(
      "Status: proposed and must leave the inbox via review"
    )
    expect(result.content[0]!.text).toContain("lore-memory action='reject'")
    expect(services.memories.update).not.toHaveBeenCalled()
  })

  it("rejects deprecate on a Status: superseded procedure", async () => {
    services.memories.getById = vi.fn(async () =>
      makeMemory({
        id: "1234567890abcdef1234567890abcdef",
        title: "Superseded procedure",
        kind: "procedure",
        status: "superseded",
      })
    ) as never
    const result = await mock.get("lore-procedure")({
      action: "deprecate",
      memoryId: "1234567890abcdef1234567890abcdef",
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("Status: superseded")
    expect(services.memories.update).not.toHaveBeenCalled()
  })

  it("idempotent on already-deprecated procedures (no second write)", async () => {
    services.memories.getById = vi.fn(async () =>
      makeMemory({
        id: "1234567890abcdef1234567890abcdef",
        title: "Old procedure",
        kind: "procedure",
        status: "deprecated",
      })
    ) as never
    const result = await mock.get("lore-procedure")({
      action: "deprecate",
      memoryId: "1234567890abcdef1234567890abcdef",
    })
    expect(result.isError).toBeFalsy()
    expect(result.content[0]!.text).toContain("already deprecated")
    expect(result.costOutputs).toEqual({ memoriesReturned: 1 })
    expect(services.memories.update).not.toHaveBeenCalled()
  })
})

describe("lore-procedure dispatch errors", () => {
  let mock: ReturnType<typeof createMockServer>

  beforeEach(() => {
    mock = createMockServer()
    registerProcedureTools(mock.server, makeServices() as never)
  })

  it("returns a clean dispatch error on an unknown action", async () => {
    const result = await mock.get("lore-procedure")({ action: "explode" })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("lore-procedure")
  })
})
