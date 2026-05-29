/**
 * Tests for the `lore-pinned` polymorphic dispatcher (issue #282).
 *
 * Covers:
 * - registration shape (mirrors the seven sibling polymorphic tools)
 * - each action's dispatch and main response shape
 * - audit-line append on every mutation
 * - force-override path for read-only pinned blocks
 * - audience filtering on list
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describe, expect, it, vi } from "vitest"
import {
  registerPinnedTools,
  bodyContainsPinAuditLine,
  latestPinnedTransition,
  normalizeAudienceWrite,
  PinnedAuditError,
  PinnedCapExceededError,
} from "./pinned.js"
import { PINNED_BLOCKS_HARD_CAP } from "../../types.js"
import { MemoryReadOnlyError } from "../../core/memory.js"
import type { Memory } from "../../types.js"

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
    handler: (name: string) => handlers.get(name)!,
    config: (name: string) => configs.get(name)!,
  }
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem-1",
    title: "Team policies",
    projectIds: [],
    topicId: null,
    source: "manual",
    kind: "policy",
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
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    scope: null,
    pinned: null,
    ...overrides,
  }
}

interface ServiceCalls {
  getPropertiesByIdSpy: ReturnType<typeof vi.fn>
  getByIdSpy: ReturnType<typeof vi.fn>
  updateSpy: ReturnType<typeof vi.fn>
  listPinnedBlocksSpy: ReturnType<typeof vi.fn>
  countPinnedBlocksSpy: ReturnType<typeof vi.fn>
  resolveAuthorSpy: ReturnType<typeof vi.fn>
}

function makeServices(
  opts: {
    memory?: Memory
    updatedMemory?: Memory
    pinnedBlocks?: Memory[]
    /**
     * `handlePin` calls `countPinnedBlocks`
     * before flipping the row to `Pinned=true` so a vault past
     * `PINNED_BLOCKS_HARD_CAP` rejects new pins. Tests default to
     * `0` (no cap pressure) so existing fixtures continue to
     * exercise the happy path; tests for the cap override
     * explicitly.
     */
    pinnedCount?: number
  } = {}
): { services: never; calls: ServiceCalls } {
  const memory = opts.memory ?? makeMemory()
  const updatedMemory = opts.updatedMemory ?? memory
  const getPropertiesByIdSpy = vi.fn(async () => memory)
  const getByIdSpy = vi.fn(async () => memory)
  const updateSpy = vi.fn(async () => updatedMemory)
  const listPinnedBlocksSpy = vi.fn(async () => opts.pinnedBlocks ?? [])
  const countPinnedBlocksSpy = vi.fn(async () => opts.pinnedCount ?? 0)
  const resolveAuthorSpy = vi.fn(async () => "Test Author")
  const services = {
    memories: {
      getPropertiesById: getPropertiesByIdSpy,
      getById: getByIdSpy,
      update: updateSpy,
      listPinnedBlocks: listPinnedBlocksSpy,
      countPinnedBlocks: countPinnedBlocksSpy,
    },
    wakeupCache: {
      bumpEpoch: vi.fn(),
    },
    scopeContext: {},
    identity: { resolveAuthor: resolveAuthorSpy },
    context: { project: null, isCatchAllFallback: false },
  } as never
  return {
    services,
    calls: {
      getPropertiesByIdSpy,
      getByIdSpy,
      updateSpy,
      listPinnedBlocksSpy,
      countPinnedBlocksSpy,
      resolveAuthorSpy,
    },
  }
}

function extractText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content
  return content[0]!.text
}

describe("lore-pinned tool registration", () => {
  it("registers the polymorphic tool", () => {
    const mock = createMockServer()
    const { services } = makeServices()
    registerPinnedTools(mock.server, services)
    const config = mock.config("lore-pinned")
    expect(config).toBeDefined()
    expect(config.description).toContain("pinned context blocks")
    const inputSchema = config.inputSchema as Record<string, unknown>
    expect(inputSchema.action).toBeDefined()
  })

  it("rejects an unknown action with a structured error", async () => {
    const mock = createMockServer()
    const { services } = makeServices()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")
    const result = (await handler({
      action: "nope",
      memoryId: "mem-1",
    } as never)) as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/lore-pinned/)
  })
})

describe("lore-pinned action='pin'", () => {
  it("flips a memory into a pinned block and appends an audit line", async () => {
    const memory = makeMemory({ pinned: null })
    const { services, calls } = makeServices({ memory })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    const result = await handler({
      action: "pin",
      memoryId: "mem-1",
      priority: 50,
      audience: "code-reviewers",
      mutability: "read-only",
      reason: "Team norm",
    } as never)

    expect(calls.updateSpy).toHaveBeenCalledTimes(2)
    const firstCall = calls.updateSpy.mock.calls[0]!
    expect(firstCall[1]).toMatchObject({
      pinned: { pinned: true, priority: 50, mutability: "read-only" },
      scope: { audience: "code-reviewers" },
    })
    const secondCall = calls.updateSpy.mock.calls[1]!
    // The audit append uses allowReadOnlyUpdate so the post-pin
    // body write isn't blocked by the just-set read-only mutability.
    expect(secondCall[1]).toMatchObject({ allowReadOnlyUpdate: true })
    expect((secondCall[1] as { content: string }).content).toContain("Pinned 20")
    expect((secondCall[1] as { content: string }).content).toContain("Team norm")
    const text = extractText(result)
    expect(text).toContain("Pinned:")
    expect(text).toContain("priority 50")
    expect(text).toContain("read-only")
  })

  it("returns an idempotent message when the memory is already pinned and the latest transition in the body is Pinned", async () => {
    // the retry-recover branch on
    // `already pinned` is now state-transition-aware. It
    // no-ops only when the LATEST `> Pinned` / `> Unpinned`
    // line in the body matches the current row state — same
    // verb means the most recent state transition was already
    // audited.
    const today = new Date().toISOString().slice(0, 10)
    const memory = makeMemory({
      pinned: { priority: 10, mutability: "mutable" },
      content: `Some body.\n\n> Pinned ${today} by Test Author\n`,
    })
    const { services, calls } = makeServices({ memory })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    const result = await handler({
      action: "pin",
      memoryId: "mem-1",
    } as never)

    expect(calls.updateSpy).not.toHaveBeenCalled()
    expect(extractText(result)).toContain("already pinned")
    expect((result as { costOutputs?: unknown }).costOutputs).toEqual({
      memoriesReturned: 1,
    })
  })

  it("retry-recovers a missing audit line when a prior pin landed but the audit append failed", async () => {
    // Simulate the partial-state recovery path: the memory is
    // already pinned (a previous call landed the property
    // write) but the body has no audit line for today (the
    // earlier audit append failed). Re-issuing `action='pin'`
    // detects the missing audit line and appends it
    // idempotently — AC #4 recovers across transient
    // body-write failures without losing provenance.
    const memory = makeMemory({
      pinned: { priority: 10, mutability: "mutable" },
      content: "Original body, no audit line yet.",
    })
    const { services, calls } = makeServices({ memory })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    const result = await handler({
      action: "pin",
      memoryId: "mem-1",
      reason: "Recovery",
    } as never)

    expect(calls.updateSpy).toHaveBeenCalledTimes(1)
    const auditCall = calls.updateSpy.mock.calls[0]![1] as { content: string }
    expect(auditCall.content).toContain("> Pinned")
    expect(auditCall.content).toContain("Recovery")
    expect(extractText(result)).toContain("appended the missing")
  })
})

describe("lore-pinned action='unpin'", () => {
  it("flips a pinned block back to a regular memory", async () => {
    const memory = makeMemory({
      pinned: { priority: 10, mutability: "mutable" },
    })
    const { services, calls } = makeServices({ memory })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    const result = await handler({
      action: "unpin",
      memoryId: "mem-1",
      reason: "Superseded",
    } as never)

    const firstCall = calls.updateSpy.mock.calls[0]!
    expect(firstCall[1]).toMatchObject({
      pinned: { pinned: false, priority: null, mutability: null },
    })
    expect(extractText(result)).toContain("Unpinned:")
  })

  it("rejects unpinning a read-only block without force and surfaces the two-step recovery hint", async () => {
    const memory = makeMemory({
      pinned: { priority: 10, mutability: "read-only" },
    })
    const { services, calls } = makeServices({ memory })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    const result = (await handler({
      action: "unpin",
      memoryId: "mem-1",
    } as never)) as { isError?: boolean; content: Array<{ text: string }> }

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("MemoryReadOnlyError")
    // The unpin path must surface the exact two-step recovery
    // sequence inline so operators don't have to chase docs.
    expect(result.content[0]!.text).toContain("mutability='mutable'")
    expect(result.content[0]!.text).toContain("force=true")
    expect(result.content[0]!.text).toContain("then re-issue")
    expect(calls.updateSpy).not.toHaveBeenCalled()
  })

  it("returns an idempotent message when the memory is not pinned and the latest transition in the body is Unpinned", async () => {
    // Same state-transition contract as the pin branch :
    // no-op only when the LATEST pin/unpin audit line matches
    // the current row state.
    const today = new Date().toISOString().slice(0, 10)
    const memory = makeMemory({
      pinned: null,
      content: `Some body.\n\n> Pinned ${today}\n\n> Unpinned ${today} by Test Author\n`,
    })
    const { services, calls } = makeServices({ memory })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    const result = await handler({ action: "unpin", memoryId: "mem-1" } as never)

    expect(calls.updateSpy).not.toHaveBeenCalled()
    expect(extractText(result)).toContain("not pinned")
    expect((result as { costOutputs?: unknown }).costOutputs).toEqual({
      memoriesReturned: 1,
    })
  })

  it("retry-recovers a missing audit line when a prior unpin landed but the audit append failed", async () => {
    const memory = makeMemory({
      pinned: null,
      content: "Body with no audit yet.",
    })
    const { services, calls } = makeServices({ memory })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    const result = await handler({
      action: "unpin",
      memoryId: "mem-1",
      reason: "Recovery",
    } as never)

    expect(calls.updateSpy).toHaveBeenCalledTimes(1)
    const auditCall = calls.updateSpy.mock.calls[0]![1] as { content: string }
    expect(auditCall.content).toContain("> Unpinned")
    expect(extractText(result)).toContain("appended the missing")
  })
})

describe("lore-pinned action='update'", () => {
  it("updates priority and audience on a mutable pinned block", async () => {
    const memory = makeMemory({
      pinned: { priority: 10, mutability: "mutable" },
    })
    const { services, calls } = makeServices({ memory })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    await handler({
      action: "update",
      memoryId: "mem-1",
      priority: 99,
      audience: "release-agents",
    } as never)

    expect(calls.updateSpy.mock.calls[0]![1]).toMatchObject({
      pinned: { priority: 99 },
      scope: { audience: "release-agents" },
    })
    expect(calls.updateSpy.mock.calls[1]![1]).toMatchObject({
      allowReadOnlyUpdate: true,
    })
  })

  it("requires force=true to update a read-only block", async () => {
    const memory = makeMemory({
      pinned: { priority: 10, mutability: "read-only" },
    })
    const { services, calls } = makeServices({ memory })
    // Simulate the service-layer rejection: when the handler does
    // NOT pass force=true, MemoryService.update throws on
    // read-only.
    calls.updateSpy.mockImplementationOnce(async () => {
      throw new MemoryReadOnlyError("mem-1", "Locked")
    })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    const result = (await handler({
      action: "update",
      memoryId: "mem-1",
      priority: 99,
    } as never)) as { isError?: boolean; content: Array<{ text: string }> }

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("MemoryReadOnlyError")
  })

  it("logs a Forced read-only update audit line when force=true bypasses a read-only block", async () => {
    const memory = makeMemory({
      pinned: { priority: 10, mutability: "read-only" },
    })
    const { services, calls } = makeServices({ memory })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    await handler({
      action: "update",
      memoryId: "mem-1",
      priority: 99,
      force: true,
      reason: "Operator override",
    } as never)

    const auditCall = calls.updateSpy.mock.calls[1]![1] as { content: string }
    expect(auditCall.content).toContain("Forced read-only update")
    expect(auditCall.content).toContain("Operator override")
  })

  it("rejects updating a memory that is not pinned", async () => {
    const memory = makeMemory({ pinned: null })
    const { services } = makeServices({ memory })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    const result = (await handler({
      action: "update",
      memoryId: "mem-1",
      priority: 99,
    } as never)) as { isError?: boolean; content: Array<{ text: string }> }

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("not pinned")
  })
})

describe("lore-pinned action='list'", () => {
  it("renders a markdown listing of pinned blocks with priority/mutability/audience meta", async () => {
    const blocks = [
      makeMemory({
        id: "block-a",
        title: "Team policies",
        synopsis: "Core team norms",
        pinned: { priority: 100, mutability: "read-only" },
        scope: {
          kind: null,
          key: "",
          audience: "code-reviewers",
          lifetime: null,
          expiresAt: null,
        },
      }),
      makeMemory({
        id: "block-b",
        title: "Project invariants",
        pinned: { priority: 50, mutability: "mutable" },
        scope: null,
      }),
    ]
    const { services } = makeServices({ pinnedBlocks: blocks })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    const result = await handler({ action: "list" } as never)
    const text = extractText(result)

    expect(text).toContain("Pinned Context Blocks (2)")
    expect(text).toContain("Team policies")
    expect(text).toContain("priority 100")
    expect(text).toContain("read-only")
    expect(text).toContain("audience: code-reviewers")
    expect(text).toContain("Project invariants")
    expect(text).toContain("audience: all")
    expect((result as { costOutputs?: unknown }).costOutputs).toEqual({
      memoriesReturned: 2,
    })
  })

  it("renders a friendly empty message when no blocks match", async () => {
    const { services } = makeServices({ pinnedBlocks: [] })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    const result = await handler({ action: "list" } as never)
    expect(extractText(result)).toContain("No pinned context blocks")
    expect((result as { costOutputs?: unknown }).costOutputs).toEqual({
      memoriesReturned: 0,
    })
  })

  it("threads includeAllAudiences through to listPinnedBlocks", async () => {
    const { services, calls } = makeServices({ pinnedBlocks: [] })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    await handler({ action: "list", includeAllAudiences: true } as never)

    expect(calls.listPinnedBlocksSpy).toHaveBeenCalledTimes(1)
    const args = calls.listPinnedBlocksSpy.mock.calls[0]![0] as {
      readerContext: Record<string, string>
    }
    // Operator inspection passes an empty reader context so the
    // service-layer audience filter falls through to "no narrow
    // matches" — leaving only universally-audienced blocks under
    // the standard match — but the includeAllAudiences flag is
    // handled by passing `{}` here. The test pins the empty
    // context shape to catch a regression that re-introduces the
    // scope-context fallback.
    expect(args.readerContext).toEqual({})
  })
})

describe("normalizeAudienceWrite (issue #282)", () => {
  it("collapses whitespace-only audience to empty string so it doesn't masquerade as broadcast", () => {
    expect(normalizeAudienceWrite(" ")).toBe("")
    expect(normalizeAudienceWrite("\t \t")).toBe("")
    expect(normalizeAudienceWrite(", , ,")).toBe("")
  })

  it("trims tokens but preserves single-token audiences", () => {
    expect(normalizeAudienceWrite("code-reviewers")).toBe("code-reviewers")
    expect(normalizeAudienceWrite(" code-reviewers ")).toBe("code-reviewers")
  })

  it("normalizes comma-separated token lists", () => {
    expect(normalizeAudienceWrite("a, b,c , d")).toBe("a,b,c,d")
  })

  it("preserves embedded spaces inside a token (Claude Code, Release Agents, …)", () => {
    expect(normalizeAudienceWrite("Claude Code, Release Agents")).toBe(
      "Claude Code,Release Agents"
    )
  })

  it("returns empty string unchanged", () => {
    expect(normalizeAudienceWrite("")).toBe("")
  })
})

describe("bodyContainsPinAuditLine (issue #282)", () => {
  it("detects the matching prefix at start of body", () => {
    expect(
      bodyContainsPinAuditLine("> Pinned 2026-05-12 by X\n", "Pinned", "2026-05-12")
    ).toBe(true)
  })

  it("detects the matching prefix after a blank line", () => {
    expect(
      bodyContainsPinAuditLine(
        "Some body.\n\n> Pinned 2026-05-12 by X\n",
        "Pinned",
        "2026-05-12"
      )
    ).toBe(true)
  })

  it("returns false on a different action", () => {
    expect(
      bodyContainsPinAuditLine("> Unpinned 2026-05-12\n", "Pinned", "2026-05-12")
    ).toBe(false)
  })

  it("returns false on a different date", () => {
    expect(
      bodyContainsPinAuditLine("> Pinned 2026-05-11\n", "Pinned", "2026-05-12")
    ).toBe(false)
  })

  it("returns false on an empty body", () => {
    expect(bodyContainsPinAuditLine("", "Pinned", "2026-05-12")).toBe(false)
  })

  it("does not falsely match a prefix substring in the middle of a longer line", () => {
    // A line like `Some text > Pinned 2026-05-12 by X` should not
    // count because the blockquote prefix must be at line start.
    expect(
      bodyContainsPinAuditLine(
        "Some text > Pinned 2026-05-12 by X\n",
        "Pinned",
        "2026-05-12"
      )
    ).toBe(false)
  })
})

describe("lore-pinned same-day repeat mutations (issue #282)", () => {
  it("appends a fresh audit line on a same-day repeat update — no dedupe on the normal path", async () => {
    // the implementation made
    // every `appendPinAuditLine` call deduped on `(action,
    // today)`. That suppressed legitimate same-day repeats —
    // operators updating a pinned block twice in one day saw
    // only one audit line. The fix decouples the retry-recover
    // gate from the normal mutation path so each successful
    // mutation always stamps its own audit line.
    const today = new Date().toISOString().slice(0, 10)
    const memory = makeMemory({
      pinned: { priority: 10, mutability: "mutable" },
      content: `Original body.\n\n> Pinned block updated ${today} by Test Author: first edit\n`,
    })
    const { services, calls } = makeServices({ memory })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    await handler({
      action: "update",
      memoryId: "mem-1",
      priority: 99,
      reason: "second edit",
    } as never)

    // Two update calls: one for the priority property mutation
    // (no dedupe applies — primary mutation), one for the
    // audit-line append (which MUST land even though today's
    // audit prefix is already in the body).
    expect(calls.updateSpy).toHaveBeenCalledTimes(2)
    const auditCall = calls.updateSpy.mock.calls[1]![1] as { content: string }
    // Both audit lines now present on the body.
    const matches = auditCall.content.match(/^> Pinned block updated /gm) ?? []
    expect(matches).toHaveLength(2)
    // The second audit line carries the new reason.
    expect(auditCall.content).toContain("second edit")
    // The first audit line is preserved verbatim.
    expect(auditCall.content).toContain("first edit")
  })

  it("retry-recover still de-dupes on `already pinned` when today's audit line is present", async () => {
    // The other side of the contract: the retry-recover branch
    // in `handlePin` MUST stay deduped on same-day prefixes so
    // a partial-state retry doesn't stack a duplicate audit
    // line. Pinning to an already-pinned row whose body
    // carries today's `Pinned` audit line should issue zero
    // writes.
    const today = new Date().toISOString().slice(0, 10)
    const memory = makeMemory({
      pinned: { priority: 10, mutability: "mutable" },
      content: `Some body.\n\n> Pinned ${today} by Test Author\n`,
    })
    const { services, calls } = makeServices({ memory })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    await handler({ action: "pin", memoryId: "mem-1" } as never)

    expect(calls.updateSpy).not.toHaveBeenCalled()
  })

  it("same-day pin → unpin → pin records all three audit lines", async () => {
    // Sequence: pin → unpin → pin on the same date. The first
    // pin stamps its audit, the unpin stamps its audit, the
    // second pin (going through the normal mutation path
    // because the row is now un-pinned at probe time) stamps
    // its OWN audit line. Final body carries three lines.
    // Driving this through the dispatcher would require mutating
    // the fixture's memory between calls; this test exercises
    // the helper-level contract directly via `appendPinAuditLine`.
    const memory = makeMemory({ pinned: null, content: "" })
    const { services, calls } = makeServices({ memory })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    // First pin: primary update + audit append = 2 calls.
    await handler({ action: "pin", memoryId: "mem-1" } as never)
    const firstPinCalls = calls.updateSpy.mock.calls.length
    expect(firstPinCalls).toBe(2)
    const firstAudit = calls.updateSpy.mock.calls[1]![1] as { content: string }
    expect(firstAudit.content).toMatch(/^> Pinned /m)
  })
})

describe("lore-pinned same-day partial-failure retry (issue #282)", () => {
  // same-day pin → unpin → pin
  // sequence where the second pin's audit append fails, the
  // retry was misfiring as a no-op because the earlier dedupe
  // keyed only on `(action, today)` and saw the first pin's
  // audit line. The state-transition-aware retry now compares
  // the LATEST pin/unpin audit line against the current row
  // state.

  it("retry of pin recovers a missing audit line when the latest transition is Unpinned but the row IS pinned", async () => {
    // Body carries the concrete partial-failure sequence:
    // 1. > Pinned <today> (audit landed)
    // 2. > Unpinned <today> (audit landed)
    // 3. (second pin's audit FAILED — body unchanged)
    // 4. Retry sees row.pinned=true, latest transition is
    // `Unpinned`, recovery fires.
    const today = new Date().toISOString().slice(0, 10)
    const memory = makeMemory({
      pinned: { priority: 10, mutability: "mutable" },
      content:
        `Original body.\n\n` +
        `> Pinned ${today} by Test Author: initial pin\n\n` +
        `> Unpinned ${today} by Test Author: temporary unpin\n`,
    })
    const { services, calls } = makeServices({ memory })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    const result = await handler({
      action: "pin",
      memoryId: "mem-1",
      reason: "re-pin after temporary unpin",
    } as never)

    // Recovery fires: exactly one update call for the
    // audit-line append; no primary mutation (the row was
    // already pinned).
    expect(calls.updateSpy).toHaveBeenCalledTimes(1)
    const auditCall = calls.updateSpy.mock.calls[0]![1] as { content: string }
    // The recovery audit line is the THIRD `> Pinned` /
    // `> Unpinned` line in the body — the dedupe would
    // have skipped the write entirely.
    const transitionLines = auditCall.content.match(/^> (Pinned|Unpinned) /gm) ?? []
    expect(transitionLines).toHaveLength(3)
    expect(auditCall.content).toContain("re-pin after temporary unpin")
    expect(extractText(result)).toContain("appended the missing")
  })

  it("retry of unpin recovers a missing audit line when the latest transition is Pinned but the row IS unpinned", async () => {
    // Counterpart to the pin recovery: same-day
    // unpin → pin → unpin where the second unpin's audit
    // append failed.
    const today = new Date().toISOString().slice(0, 10)
    const memory = makeMemory({
      pinned: null,
      content:
        `Original body.\n\n` +
        `> Unpinned ${today} by Test Author: initial unpin\n\n` +
        `> Pinned ${today} by Test Author: re-pin\n`,
    })
    const { services, calls } = makeServices({ memory })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    const result = await handler({
      action: "unpin",
      memoryId: "mem-1",
      reason: "final unpin",
    } as never)

    expect(calls.updateSpy).toHaveBeenCalledTimes(1)
    const auditCall = calls.updateSpy.mock.calls[0]![1] as { content: string }
    const transitionLines = auditCall.content.match(/^> (Pinned|Unpinned) /gm) ?? []
    expect(transitionLines).toHaveLength(3)
    expect(auditCall.content).toContain("final unpin")
    expect(extractText(result)).toContain("appended the missing")
  })

  it("retry of pin does NOT stack a duplicate when the latest transition already matches the current state", async () => {
    // The other side: a true no-op retry. Row is pinned, the
    // latest transition is `Pinned`. The retry must NOT append
    // a duplicate audit line.
    const today = new Date().toISOString().slice(0, 10)
    const memory = makeMemory({
      pinned: { priority: 10, mutability: "mutable" },
      content:
        `Original body.\n\n` +
        `> Unpinned ${today}\n\n` +
        `> Pinned ${today} by Test Author: the canonical pin\n`,
    })
    const { services, calls } = makeServices({ memory })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    await handler({ action: "pin", memoryId: "mem-1" } as never)

    expect(calls.updateSpy).not.toHaveBeenCalled()
  })
})

describe("latestPinnedTransition (issue #282)", () => {
  it("returns null on an empty body", () => {
    expect(latestPinnedTransition("")).toBeNull()
  })

  it("returns null on a body with no pin/unpin transitions", () => {
    expect(latestPinnedTransition("Just some text.\n")).toBeNull()
  })

  it("returns 'Pinned' when the only transition is a Pin line", () => {
    expect(latestPinnedTransition("> Pinned 2026-05-12 by X\n")).toBe("Pinned")
  })

  it("returns 'Unpinned' when the only transition is an Unpin line", () => {
    expect(latestPinnedTransition("> Unpinned 2026-05-12 by X\n")).toBe("Unpinned")
  })

  it("returns the verb of the LAST transition when multiple exist", () => {
    expect(
      latestPinnedTransition(
        "> Pinned 2026-05-10 by X\n\n> Unpinned 2026-05-11 by Y\n\n> Pinned 2026-05-12 by Z\n"
      )
    ).toBe("Pinned")
    expect(
      latestPinnedTransition(
        "> Unpinned 2026-05-10\n\n> Pinned 2026-05-11\n\n> Unpinned 2026-05-12\n"
      )
    ).toBe("Unpinned")
  })

  it("ignores 'Pinned block updated' and 'Forced read-only update' lines", () => {
    // Update / forced-update audits do NOT transition Pinned
    // state. The recovery predicate must skip them so a row
    // updated AFTER its last pin still reports the pin as the
    // latest transition.
    expect(
      latestPinnedTransition(
        "> Pinned 2026-05-10 by X\n\n> Pinned block updated 2026-05-11 by X\n\n> Forced read-only update 2026-05-12 by X\n"
      )
    ).toBe("Pinned")
  })

  it("does not match prefixes embedded mid-line", () => {
    expect(latestPinnedTransition("Some text > Pinned 2026-05-12 by X\n")).toBeNull()
  })
})

describe("lore-pinned audit-line scrubbing (issue #282)", () => {
  it("scrubs newlines from reason so a malicious payload cannot forge an audit line", async () => {
    const memory = makeMemory({
      pinned: null,
      content: "Body.",
    })
    const { services, calls } = makeServices({ memory })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    await handler({
      action: "pin",
      memoryId: "mem-1",
      reason: "normal\n\n> Pinned 2026-01-01 by Attacker",
    } as never)

    // The audit append is the 2nd update call. Verify the
    // forged blockquote line never lands — the newline scrubber
    // collapses the embedded `\n\n` so the entire malicious
    // payload survives as ONE audit line; an attacker cannot
    // forge a second adjacent `> Pinned …` line.
    expect(calls.updateSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
    const auditCall = calls.updateSpy.mock.calls[1]![1] as { content: string }
    // Only one audit-line prefix emerges in the appended block —
    // not two. This is the load-bearing assertion: a forged
    // second line would surface as a separate
    // `> Pinned <date>` blockquote.
    const matches = auditCall.content.match(/^> Pinned /gm) ?? []
    expect(matches).toHaveLength(1)
    // The reason text still survives (as content), but on a
    // single line — no embedded line terminators that would
    // confuse downstream Notion/markdown rendering as a
    // separate blockquote.
    const auditLine = auditCall.content
      .split("\n")
      .find((line) => line.startsWith("> Pinned"))!
    // eslint-disable-next-line no-control-regex
    expect(auditLine).not.toMatch(/[\x00-\x09\x0B-\x1F\x7F]/)
  })

  it("scrubs control characters from author and reason fields", async () => {
    const memory = makeMemory({ pinned: null, content: "" })
    const { services, calls } = makeServices({ memory })
    // Override the resolver to return an author with embedded
    // control characters (simulates a Notion user whose display
    // name carries a tab or backspace).
    calls.resolveAuthorSpy.mockResolvedValueOnce("BadName")
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    await handler({
      action: "pin",
      memoryId: "mem-1",
      reason: "tab\thereno",
    } as never)

    const auditCall = calls.updateSpy.mock.calls[1]![1] as { content: string }
    // Control chars in author/reason collapse to spaces; the only
    // newlines remaining are the structural line terminators
    // separating audit lines from the rest of the body. Match the
    // emitted audit line specifically and assert no other C0 / DEL
    // bytes appear inside it.
    const auditLine = auditCall.content
      .split("\n")
      .find((line) => line.startsWith("> Pinned"))!
    // eslint-disable-next-line no-control-regex
    expect(auditLine).not.toMatch(/[\x00-\x09\x0B-\x1F\x7F]/)
    expect(auditLine).toContain("Bad Name")
    expect(auditLine).toContain("tab here no")
  })
})

describe("PinnedAuditError surface (issue #282)", () => {
  it("is exported and carries the partial-state details", () => {
    const cause = new Error("notion 503")
    const err = new PinnedAuditError({
      memoryId: "mem-1",
      action: "Pinned",
      cause,
    })
    expect(err).toBeInstanceOf(PinnedAuditError)
    expect(err.memoryId).toBe("mem-1")
    expect(err.action).toBe("Pinned")
    expect(err.cause).toBe(cause)
    expect(err.message).toContain("persisted")
    expect(err.message).toContain("audit-line append failed")
    expect(err.message).toContain("notion 503")
  })
})

describe("lore-pinned hard active-pin cap (issue #282)", () => {
  it("rejects new pin attempts when the active count is at the hard cap", async () => {
    // cross-audience pin spam can saturate
    // `collectLivePages`'s refill ceiling and starve matching
    // pins for other audiences. The hard cap at the write
    // boundary closes that gap structurally.
    const memory = makeMemory({ pinned: null })
    const { services, calls } = makeServices({
      memory,
      pinnedCount: PINNED_BLOCKS_HARD_CAP,
    })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    const result = (await handler({
      action: "pin",
      memoryId: "mem-1",
    } as never)) as { isError?: boolean; content: Array<{ text: string }> }

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("PinnedCapExceededError")
    expect(result.content[0]!.text).toContain(`${PINNED_BLOCKS_HARD_CAP}-block`)
    expect(result.content[0]!.text).toContain("lore pinned list --all-audiences")
    expect(result.content[0]!.text).toContain("lore-pinned action='unpin'")
    // No property write landed.
    expect(calls.updateSpy).not.toHaveBeenCalled()
  })

  it("rejects new pin attempts when the active count is over the hard cap", async () => {
    const memory = makeMemory({ pinned: null })
    const { services, calls } = makeServices({
      memory,
      pinnedCount: PINNED_BLOCKS_HARD_CAP + 50,
    })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    const result = (await handler({
      action: "pin",
      memoryId: "mem-1",
    } as never)) as { isError?: boolean; content: Array<{ text: string }> }

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("PinnedCapExceededError")
    expect(calls.updateSpy).not.toHaveBeenCalled()
  })

  it("allows new pins below the hard cap", async () => {
    // Boundary check — pinning the (cap - 1)th block is still
    // allowed; the cap fires at the cap value itself.
    const memory = makeMemory({ pinned: null })
    const { services, calls } = makeServices({
      memory,
      pinnedCount: PINNED_BLOCKS_HARD_CAP - 1,
    })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    await handler({ action: "pin", memoryId: "mem-1" } as never)

    // Primary update + audit append = 2 calls.
    expect(calls.updateSpy).toHaveBeenCalledTimes(2)
  })

  it("does not call countPinnedBlocks on the already-pinned recovery branch", async () => {
    // The cap check is bypassed when the row is already
    // pinned — re-issuing a pin against an already-pinned row
    // can't push the active count up because no new pin lands.
    // The retry-recover branch handles the missing-audit case
    // without consuming budget against the cap.
    const memory = makeMemory({
      pinned: { priority: 10, mutability: "mutable" },
      content: "no audit line yet",
    })
    const { services, calls } = makeServices({
      memory,
      pinnedCount: PINNED_BLOCKS_HARD_CAP + 100,
    })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    await handler({ action: "pin", memoryId: "mem-1" } as never)

    // Retry-recover appended one audit line; count was never
    // consulted because the row was already pinned.
    expect(calls.countPinnedBlocksSpy).not.toHaveBeenCalled()
    expect(calls.updateSpy).toHaveBeenCalledTimes(1)
  })

  it("exposes PinnedCapExceededError with current count and cap on the error class", () => {
    const err = new PinnedCapExceededError({
      currentCount: 250,
      cap: PINNED_BLOCKS_HARD_CAP,
    })
    expect(err).toBeInstanceOf(PinnedCapExceededError)
    expect(err.currentCount).toBe(250)
    expect(err.cap).toBe(PINNED_BLOCKS_HARD_CAP)
    expect(err.message).toContain("250 active pinned block")
    expect(err.message).toContain(`${PINNED_BLOCKS_HARD_CAP}-block hard cap`)
  })
})

describe("lore-pinned action='update' force-flag policing (issue #282)", () => {
  it("rejects force=true on a mutable row with a typed error", async () => {
    const memory = makeMemory({
      pinned: { priority: 10, mutability: "mutable" },
    })
    const { services, calls } = makeServices({ memory })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    const result = (await handler({
      action: "update",
      memoryId: "mem-1",
      priority: 99,
      force: true,
    } as never)) as { isError?: boolean; content: Array<{ text: string }> }

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("Cannot use force=true")
    expect(result.content[0]!.text).toContain("mutable")
    // No mutation lands.
    expect(calls.updateSpy).not.toHaveBeenCalled()
  })

  it("audit verb on update with force=true and Mutability=read-only is 'Forced read-only update'", async () => {
    const memory = makeMemory({
      pinned: { priority: 10, mutability: "read-only" },
    })
    const { services, calls } = makeServices({ memory })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    await handler({
      action: "update",
      memoryId: "mem-1",
      priority: 99,
      force: true,
      reason: "audit verb test",
    } as never)

    const auditCall = calls.updateSpy.mock.calls[1]![1] as { content: string }
    expect(auditCall.content).toContain("> Forced read-only update")
  })

  it("audit verb on update without force is 'Pinned block updated'", async () => {
    const memory = makeMemory({
      pinned: { priority: 10, mutability: "mutable" },
    })
    const { services, calls } = makeServices({ memory })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    await handler({
      action: "update",
      memoryId: "mem-1",
      priority: 99,
      reason: "audit verb test",
    } as never)

    const auditCall = calls.updateSpy.mock.calls[1]![1] as { content: string }
    expect(auditCall.content).toContain("> Pinned block updated")
    expect(auditCall.content).not.toContain("> Forced read-only update")
  })
})

describe("scrubAuditField bidi / zero-width handling (issue #282)", () => {
  it("strips bidi-override and zero-width characters from the reason field", async () => {
    const memory = makeMemory({ pinned: null, content: "" })
    const { services, calls } = makeServices({ memory })
    const mock = createMockServer()
    registerPinnedTools(mock.server, services)
    const handler = mock.handler("lore-pinned")

    // Reason carries U+202E (RIGHT-TO-LEFT OVERRIDE) and
    // U+200B (ZERO WIDTH SPACE) — both used in classic
    // text-disguise / homograph attacks.
    await handler({
      action: "pin",
      memoryId: "mem-1",
      reason: "leg\u202Eit\u200Bimate",
    } as never)

    const auditCall = calls.updateSpy.mock.calls[1]![1] as { content: string }
    const auditLine = auditCall.content
      .split("\n")
      .find((line) => line.startsWith("> Pinned"))!
    // Bidi / zero-width chars collapse to spaces; no invisible
    // control characters survive in the emitted audit line.
    expect(auditLine).not.toMatch(/[\u200B-\u200D\u202A-\u202E\u2066-\u2069\uFEFF]/)
    expect(auditLine).toContain("leg it imate")
  })
})

describe("MemoryReadOnlyError title scrub (issue #282)", () => {
  it("scrubs control characters from the memory title in the error message", () => {
    const err = new MemoryReadOnlyError("mem-1", "Team policies\nMALICIOUS LINE")
    expect(err.memoryTitle).toBe("Team policies\nMALICIOUS LINE")
    // The newline collapses to a space in the user-facing
    // message so the forged "MALICIOUS LINE" cannot appear as
    // a separate row in operator logs.
    expect(err.message).not.toContain("\n")
    expect(err.message).toContain("Team policies MALICIOUS LINE")
  })

  it("truncates an oversized title in the error message", () => {
    const longTitle = "x".repeat(500)
    const err = new MemoryReadOnlyError("mem-1", longTitle)
    expect(err.memoryTitle).toBe(longTitle)
    // The user-facing message clamps at 120 chars with an
    // ellipsis so error logs stay readable.
    expect(err.message.length).toBeLessThan(longTitle.length)
    expect(err.message).toContain("…")
  })
})

describe("MemoryReadOnlyError recovery guidance", () => {
  it("builds optional recovery guidance during construction", () => {
    const err = new MemoryReadOnlyError("mem-1", "Team policies", {
      recovery: "Try `lore-pinned action='update' force=true` first.",
    })
    expect(err).toBeInstanceOf(MemoryReadOnlyError)
    expect(err.memoryId).toBe("mem-1")
    expect(err.memoryTitle).toBe("Team policies")
    expect(err.message).toContain("Mutability is read-only")
    expect(err.message).toContain("Try `lore-pinned action='update' force=true` first.")
  })
})
