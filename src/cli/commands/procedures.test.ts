import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseProposeCliOptions, proceduresCommand } from "./procedures.js"
import { initServices } from "../../services.js"
import type { Memory } from "../../types.js"
import { trapProcessExit } from "../test-helpers.js"

vi.mock("../../services.js", () => ({
  initServices: vi.fn(),
}))

function makeMemory(overrides: Partial<Memory> & { id: string; title: string }): Memory {
  return {
    projectIds: ["P1"],
    topicId: null,
    source: "manual",
    kind: "procedure",
    status: "accepted",
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
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
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

describe("parseProposeCliOptions", () => {
  const baseValidRaw = {
    title: "PR-1234 latency triage",
    entity: "PR-1234",
    step: ["check Grafana", "page oncall"],
    source: [
      "1234567890abcdef1234567890abcdef",
      "abcdef1234567890abcdef1234567890",
    ],
  }

  it("accepts a fully populated payload", () => {
    const result = parseProposeCliOptions(baseValidRaw)
    expect(result.ok).toBe(true)
  })

  it("rejects empty title", () => {
    const result = parseProposeCliOptions({ ...baseValidRaw, title: "   " })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("--title")
  })

  it("rejects empty steps array", () => {
    const result = parseProposeCliOptions({ ...baseValidRaw, step: [] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("--step")
  })

  it("rejects whitespace-only step entries", () => {
    const result = parseProposeCliOptions({
      ...baseValidRaw,
      step: ["check Grafana", "   "],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("non-blank")
      // Names the failing index so an operator can locate the bad input.
      expect(result.message).toContain("#2")
    }
  })

  it("rejects propose with zero --source entries", () => {
    const result = parseProposeCliOptions({ ...baseValidRaw, source: [] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("--source")
      expect(result.message).toContain("at least 2")
    }
  })

  it("rejects propose with one --source entry (below MIN_SOURCES)", () => {
    const result = parseProposeCliOptions({
      ...baseValidRaw,
      source: ["1234567890abcdef1234567890abcdef"],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("at least 2")
  })

  it("rejects propose when --source is omitted entirely", () => {
    const { source: _drop, ...withoutSource } = baseValidRaw
    void _drop
    const result = parseProposeCliOptions(withoutSource)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("--source")
  })

  it("rejects --supersedes with no other validation issue", () => {
    // Confirms the parse layer accepts --supersedes without requiring
    // a separate flag (existing behavior); page-id canonicalization
    // happens in the action handler, not the parser.
    const result = parseProposeCliOptions({
      ...baseValidRaw,
      supersedes: ["1234567890abcdef1234567890abcdef"],
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.supersedes).toEqual([
      "1234567890abcdef1234567890abcdef",
    ])
  })

  it("threads normalized fields onto the parsed value", () => {
    const result = parseProposeCliOptions({
      ...baseValidRaw,
      project: "Alpha",
      activation: ["entity matches PR-1234"],
      failureMode: ["do not restart cache"],
      notes: "borrowed from postmortem",
      supersedes: ["efefefefefefefefefefefefefefefef"],
      topicKey: "procedure/pr-1234-runbook",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.project).toBe("Alpha")
      expect(result.value.activation).toEqual(["entity matches PR-1234"])
      expect(result.value.failureMode).toEqual(["do not restart cache"])
      expect(result.value.notes).toBe("borrowed from postmortem")
      expect(result.value.supersedes).toEqual([
        "efefefefefefefefefefefefefefefef",
      ])
      expect(result.value.topicKey).toBe("procedure/pr-1234-runbook")
      expect(result.value.source).toEqual(baseValidRaw.source)
      expect(result.value.step).toEqual(baseValidRaw.step)
    }
  })
})

// -------------------------------------------------------------------------
// Deprecate command action coverage. The parser-level tests above don't
// exercise the CLI action's status-boundary / page-id / idempotency
// guards — those live in the `.action(...)` callback. This block fills
// the gap by driving `proceduresCommand` through `parseAsync` with
// mocked services.
// -------------------------------------------------------------------------

// -------------------------------------------------------------------------
// Propose command action coverage. The parser-level tests above don't
// exercise the CLI action's source-canonicalization, source-resolution,
// and idempotency-probe guards — those live in the `.action(...)`
// callback.
// -------------------------------------------------------------------------

describe("proceduresCommand propose action", () => {
  let errorSpy: ReturnType<typeof vi.fn>
  let logSpy: ReturnType<typeof vi.fn>
  let exitTrap: ReturnType<typeof trapProcessExit>

  const PROJ = { id: "proj-A", name: "Alpha" }
  const SOURCE_A = "abababababababababababababababab"
  const SOURCE_B = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"

  function makeServices(): unknown {
    return {
      context: { project: PROJ },
      projects: { findByName: vi.fn(async () => null), list: vi.fn(async () => []) },
      memories: {
        getById: vi.fn(async (id: string) =>
          makeMemory({
            id,
            title: `stub ${id.slice(0, 6)}`,
            kind: "incident",
            status: "accepted",
            projectIds: [PROJ.id],
          })
        ),
        findByTopicKey: vi.fn(async () => null),
        create: vi.fn(async () =>
          makeMemory({
            id: "11111111-1111-1111-1111-111111111111",
            title: "Created",
            kind: "procedure",
            status: "proposed",
            topicKey: "procedure/cache-miss",
          })
        ),
      },
    }
  }

  beforeEach(() => {
    vi.mocked(initServices).mockReset()
    exitTrap = trapProcessExit()
    errorSpy = vi.fn()
    logSpy = vi.fn()
    vi.spyOn(console, "error").mockImplementation(errorSpy)
    vi.spyOn(console, "log").mockImplementation(logSpy)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("rejects --source #1 when it's not a valid Notion page id", async () => {
    vi.mocked(initServices).mockResolvedValue(makeServices() as never)
    await proceduresCommand.parseAsync(
      [
        "propose",
        "--title", "P",
        "--entity", "cache",
        "--step", "do",
        "--source", "not-a-page-id",
        "--source", SOURCE_B,
      ],
      { from: "user" }
    )
    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("--source #1")
    expect(errorText).toContain("not a valid Notion page id")
    expect(exitTrap.exitCodes).toEqual([1])
  })

  it("short-circuits to reuse when an existing proposed procedure holds the slot", async () => {
    const services = makeServices() as {
      memories: {
        findByTopicKey: ReturnType<typeof vi.fn>
        create: ReturnType<typeof vi.fn>
        getById: ReturnType<typeof vi.fn>
      }
    }
    const existing = makeMemory({
      id: "feedfeed-feed-feed-feed-feedfeedfeed",
      title: "Existing proposed",
      kind: "procedure",
      status: "proposed",
      topicKey: "procedure/cache",
      projectIds: [PROJ.id],
    })
    services.memories.findByTopicKey = vi.fn(async () => existing)
    // If source resolution runs before the probe, this throws and
    // the test fails — pinning the reorder fix.
    services.memories.getById = vi.fn(async () => {
      throw new Error("getById must not run on the reuse short-circuit")
    })
    vi.mocked(initServices).mockResolvedValue(services as never)
    await proceduresCommand.parseAsync(
      [
        "propose",
        "--title", "Retry propose",
        "--entity", "cache",
        "--step", "do",
        "--source", SOURCE_A,
        "--source", SOURCE_B,
      ],
      { from: "user" }
    )
    const logText = logSpy.mock.calls.flat().join("\n")
    expect(logText).toContain("Reused existing proposed procedure")
    expect(exitTrap.exitCodes).toEqual([])
    expect(services.memories.create).not.toHaveBeenCalled()
    expect(services.memories.getById).not.toHaveBeenCalled()
  })

  it("rejects propose when an accepted procedure holds the topic-key slot", async () => {
    const services = makeServices() as {
      memories: { findByTopicKey: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> }
    }
    services.memories.findByTopicKey = vi.fn(async () =>
      makeMemory({
        id: "deadbeef-dead-beef-dead-beefdeadbeef",
        title: "Existing accepted",
        kind: "procedure",
        status: "accepted",
        topicKey: "procedure/cache",
        projectIds: [PROJ.id],
      })
    )
    vi.mocked(initServices).mockResolvedValue(services as never)
    await proceduresCommand.parseAsync(
      [
        "propose",
        "--title", "Replacement attempt",
        "--entity", "cache",
        "--step", "do",
        "--source", SOURCE_A,
        "--source", SOURCE_B,
      ],
      { from: "user" }
    )
    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("An accepted procedure already exists")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(services.memories.create).not.toHaveBeenCalled()
  })

  it("rejects when source resolution fails (incompatible kind)", async () => {
    const services = makeServices() as {
      memories: {
        getById: ReturnType<typeof vi.fn>
        create: ReturnType<typeof vi.fn>
        findByTopicKey: ReturnType<typeof vi.fn>
      }
    }
    services.memories.getById = vi.fn(async (id: string) =>
      makeMemory({
        id,
        title: `stub ${id.slice(0, 6)}`,
        kind: "decision",
        status: "accepted",
        projectIds: [PROJ.id],
      })
    )
    vi.mocked(initServices).mockResolvedValue(services as never)
    await proceduresCommand.parseAsync(
      [
        "propose",
        "--title", "Wrong-kind source",
        "--entity", "cache",
        "--step", "do",
        "--source", SOURCE_A,
        "--source", SOURCE_B,
      ],
      { from: "user" }
    )
    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("kind 'decision' is not a valid procedure source")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(services.memories.create).not.toHaveBeenCalled()
  })

  it("rejects propose when entity + title both normalize to empty (no derivable topic key)", async () => {
    vi.mocked(initServices).mockResolvedValue(makeServices() as never)
    await proceduresCommand.parseAsync(
      [
        "propose",
        "--title", "!!!",
        "--entity", "???",
        "--step", "do",
        "--source", SOURCE_A,
        "--source", SOURCE_B,
      ],
      { from: "user" }
    )
    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("could not derive a topic key")
    expect(exitTrap.exitCodes).toEqual([1])
  })

  it("rejects propose with whitespace-only --topic-key at the parser boundary", async () => {
    // Whitespace-only key passes the existing non-empty check but
    // defeats `findByTopicKey`'s idempotency probe.
    await proceduresCommand.parseAsync(
      [
        "propose",
        "--title", "P",
        "--entity", "cache",
        "--step", "do",
        "--source", SOURCE_A,
        "--source", SOURCE_B,
        "--topic-key", "   ",
      ],
      { from: "user" }
    )
    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("--topic-key")
    expect(errorText).toContain("non-blank")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
  })

  it("rejects propose with --notes over the 8000-char cap", async () => {
    await proceduresCommand.parseAsync(
      [
        "propose",
        "--title", "P",
        "--entity", "cache",
        "--step", "do",
        "--source", SOURCE_A,
        "--source", SOURCE_B,
        "--notes", "x".repeat(8001),
      ],
      { from: "user" }
    )
    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("--notes exceeds 8000 chars")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
  })

  it("happy path: creates the procedure when all guards pass", async () => {
    const services = makeServices()
    vi.mocked(initServices).mockResolvedValue(services as never)
    await proceduresCommand.parseAsync(
      [
        "propose",
        "--title", "Cache miss triage",
        "--entity", "cache-miss",
        "--step", "Inspect grafana",
        "--step", "Check deploys",
        "--source", SOURCE_A,
        "--source", SOURCE_B,
      ],
      { from: "user" }
    )
    const logText = logSpy.mock.calls.flat().join("\n")
    expect(logText).toContain("Proposed procedure:")
    expect(logText).toContain("Status: proposed")
    expect(exitTrap.exitCodes).toEqual([])
    expect(
      (services as { memories: { create: ReturnType<typeof vi.fn> } }).memories.create
    ).toHaveBeenCalledTimes(1)
  })
})

describe("proceduresCommand deprecate action", () => {
  let errorSpy: ReturnType<typeof vi.fn>
  let logSpy: ReturnType<typeof vi.fn>
  let exitTrap: ReturnType<typeof trapProcessExit>

  const VALID_ID = "12345678-90ab-cdef-1234-567890abcdef"

  beforeEach(() => {
    vi.mocked(initServices).mockReset()
    exitTrap = trapProcessExit()
    errorSpy = vi.fn()
    logSpy = vi.fn()
    vi.spyOn(console, "error").mockImplementation(errorSpy)
    vi.spyOn(console, "log").mockImplementation(logSpy)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("exits 1 once before initServices on a malformed memoryId", async () => {
    await proceduresCommand.parseAsync(["deprecate", "not-a-page-id"], {
      from: "user",
    })
    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Procedure deprecate failed:")
    expect(errorText).toContain("not a valid Notion page id")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
  })

  it("exits 1 once before initServices on --reason over the 500-char cap", async () => {
    const longReason = "x".repeat(501)
    await proceduresCommand.parseAsync(
      ["deprecate", VALID_ID, "--reason", longReason],
      { from: "user" }
    )
    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Procedure deprecate failed:")
    expect(errorText).toContain("--reason exceeds 500 chars")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
  })

  it("rejects deprecate on a non-procedure memory kind", async () => {
    const services = {
      memories: {
        getById: vi.fn(async () =>
          makeMemory({ id: VALID_ID, title: "Not a procedure", kind: "note" })
        ),
        update: vi.fn(),
      },
    }
    vi.mocked(initServices).mockResolvedValue(services as never)
    await proceduresCommand.parseAsync(["deprecate", VALID_ID], { from: "user" })
    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain('kind="note"')
    expect(exitTrap.exitCodes).toEqual([1])
    expect(services.memories.update).not.toHaveBeenCalled()
  })

  it("rejects deprecate on a Status: proposed procedure (must leave via review)", async () => {
    const services = {
      memories: {
        getById: vi.fn(async () =>
          makeMemory({
            id: VALID_ID,
            title: "Proposed procedure",
            kind: "procedure",
            status: "proposed",
          })
        ),
        update: vi.fn(),
      },
    }
    vi.mocked(initServices).mockResolvedValue(services as never)
    await proceduresCommand.parseAsync(["deprecate", VALID_ID], { from: "user" })
    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Status: proposed and must leave the inbox via review")
    expect(errorText).toContain("lore inbox reject")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(services.memories.update).not.toHaveBeenCalled()
  })

  it("rejects deprecate on a Status: superseded procedure", async () => {
    const services = {
      memories: {
        getById: vi.fn(async () =>
          makeMemory({
            id: VALID_ID,
            title: "Old procedure",
            kind: "procedure",
            status: "superseded",
          })
        ),
        update: vi.fn(),
      },
    }
    vi.mocked(initServices).mockResolvedValue(services as never)
    await proceduresCommand.parseAsync(["deprecate", VALID_ID], { from: "user" })
    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Status: superseded")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(services.memories.update).not.toHaveBeenCalled()
  })

  it("no-ops on an already-deprecated procedure (no second write)", async () => {
    const services = {
      memories: {
        getById: vi.fn(async () =>
          makeMemory({
            id: VALID_ID,
            title: "Old procedure",
            kind: "procedure",
            status: "deprecated",
          })
        ),
        update: vi.fn(),
      },
    }
    vi.mocked(initServices).mockResolvedValue(services as never)
    await proceduresCommand.parseAsync(["deprecate", VALID_ID], { from: "user" })
    const logText = logSpy.mock.calls.flat().join("\n")
    expect(logText).toContain("Procedure already deprecated")
    expect(exitTrap.exitCodes).toEqual([])
    expect(services.memories.update).not.toHaveBeenCalled()
  })

  it("flips an accepted procedure to deprecated and appends the audit block", async () => {
    const services = {
      memories: {
        getById: vi.fn(async () =>
          makeMemory({
            id: VALID_ID,
            title: "Accepted procedure",
            kind: "procedure",
            status: "accepted",
            content: "## Activation Conditions\n- always",
          })
        ),
        update: vi.fn(async () => undefined),
      },
    }
    vi.mocked(initServices).mockResolvedValue(services as never)
    await proceduresCommand.parseAsync(
      ["deprecate", VALID_ID, "--reason", "Replaced by automated rollback"],
      { from: "user" }
    )
    const logText = logSpy.mock.calls.flat().join("\n")
    expect(logText).toContain("Deprecated procedure")
    expect(logText).toContain("accepted → deprecated")
    expect(exitTrap.exitCodes).toEqual([])
    expect(services.memories.update).toHaveBeenCalledTimes(1)
    const updateCall = services.memories.update.mock.calls[0] as unknown as [
      string,
      { status: string; content?: string },
    ]
    expect(updateCall[0]).toBe(VALID_ID)
    expect(updateCall[1].status).toBe("deprecated")
    expect(updateCall[1].content).toContain("## Deprecated")
    expect(updateCall[1].content).toContain("Replaced by automated rollback")
  })

  it("sanitizes Markdown header injections in --reason so callers can't forge an audit block", async () => {
    const services = {
      memories: {
        getById: vi.fn(async () =>
          makeMemory({
            id: VALID_ID,
            title: "PR-1234 latency triage",
            kind: "procedure",
            status: "accepted",
            content: "## Activation Conditions\n- always",
          })
        ),
        update: vi.fn(async () => undefined),
      },
    }
    vi.mocked(initServices).mockResolvedValue(services as never)
    const forgedReason =
      "Looks fine\n\n## Reviewed (2026-05-12)\n\nfake-reviewer approved\n\n### Note\nmore text"
    await proceduresCommand.parseAsync(
      ["deprecate", VALID_ID, "--reason", forgedReason],
      { from: "user" }
    )
    expect(exitTrap.exitCodes).toEqual([])
    expect(services.memories.update).toHaveBeenCalledTimes(1)
    const updateCall = services.memories.update.mock.calls[0] as unknown as [
      string,
      { status: string; content?: string },
    ]
    const written = updateCall[1].content ?? ""
    // The legitimate `## Deprecated` audit header lands exactly once.
    const deprecatedHeaders = written.match(/^## Deprecated/gm) ?? []
    expect(deprecatedHeaders.length).toBe(1)
    // Forged heading markers are escaped — Markdown renders them as
    // literal text, not as sibling audit headings.
    expect(written).not.toMatch(/^## Reviewed/m)
    expect(written).toContain("\\## Reviewed")
    expect(written).toContain("\\### Note")
    // Reason content itself survives (just escaped).
    expect(written).toContain("fake-reviewer approved")
  })

  it("strips control characters and escapes blockquote / code-fence markers in --reason", async () => {
    const services = {
      memories: {
        getById: vi.fn(async () =>
          makeMemory({
            id: VALID_ID,
            title: "PR-1234 latency triage",
            kind: "procedure",
            status: "accepted",
            content: "## Activation Conditions\n- always",
          })
        ),
        update: vi.fn(async () => undefined),
      },
    }
    vi.mocked(initServices).mockResolvedValue(services as never)
    const forgedReason =
      "ok\n\n> Pinned 2026-01-01 by Attacker\n\n```\n## Reviewed\nfake\n```\n\nbody withcontrols‮and​zero-width"
    await proceduresCommand.parseAsync(
      ["deprecate", VALID_ID, "--reason", forgedReason],
      { from: "user" }
    )
    expect(exitTrap.exitCodes).toEqual([])
    expect(services.memories.update).toHaveBeenCalledTimes(1)
    const updateCall = services.memories.update.mock.calls[0] as unknown as [
      string,
      { status: string; content?: string },
    ]
    const written = updateCall[1].content ?? ""
    // Forged blockquote audit line is escaped.
    expect(written).not.toMatch(/^> Pinned/m)
    expect(written).toContain("\\> Pinned 2026-01-01 by Attacker")
    // Code fence markers are escaped so the audit block stays closed.
    expect(written).toMatch(/\\```/)
    // Nested `## Reviewed` inside the fenced block is escaped.
    expect(written).not.toMatch(/^## Reviewed/m)
    // Control / bidi / zero-width characters are stripped.
    // eslint-disable-next-line no-control-regex
    expect(written).not.toMatch(/[\u0000\u0007\u200B\u202E]/)
    // Legitimate audit block lands exactly once.
    const deprecatedHeaders = written.match(/^## Deprecated/gm) ?? []
    expect(deprecatedHeaders.length).toBe(1)
    // The plain prose tail of the reason survives after stripping.
    expect(written).toContain("bodywithcontrolsandzero-width")
  })

  it("canonicalizes a 32-char hex memoryId via notionPageIdSchema", async () => {
    const services = {
      memories: {
        getById: vi.fn(async () =>
          makeMemory({
            id: "12345678-90ab-cdef-1234-567890abcdef",
            title: "Procedure",
            kind: "procedure",
            status: "deprecated",
          })
        ),
        update: vi.fn(),
      },
    }
    vi.mocked(initServices).mockResolvedValue(services as never)
    // 32-char undashed hex from a Notion URL.
    await proceduresCommand.parseAsync(
      ["deprecate", "1234567890abcdef1234567890abcdef"],
      { from: "user" }
    )
    expect(services.memories.getById).toHaveBeenCalledWith(
      "12345678-90ab-cdef-1234-567890abcdef"
    )
  })
})
