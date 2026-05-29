import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { trapProcessExit } from "../test-helpers.js"
import { pinnedCommand } from "./pinned.js"
import { initServices } from "../../services.js"
import type { Memory } from "../../types.js"

vi.mock("../../services.js", () => ({
  initServices: vi.fn(),
}))

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
    synopsis: "Team norm",
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
    pinned: { priority: 100, mutability: "mutable" },
    ...overrides,
  }
}

function makeServicesStub(opts: { blocks?: Memory[] } = {}): {
  listPinnedBlocks: ReturnType<typeof vi.fn>
} {
  const listPinnedBlocks = vi.fn(async () => opts.blocks ?? [])
  vi.mocked(initServices).mockResolvedValue({
    memories: { listPinnedBlocks },
    context: { project: null, isCatchAllFallback: false },
    scopeContext: {},
  } as never)
  return { listPinnedBlocks }
}

describe("lore pinned list", () => {
  let logSpy: ReturnType<typeof vi.fn>
  let errorSpy: ReturnType<typeof vi.fn>
  let stdoutWriteSpy: ReturnType<typeof vi.fn>
  let exitTrap: ReturnType<typeof trapProcessExit>

  beforeEach(() => {
    exitTrap = trapProcessExit()
    logSpy = vi.fn()
    errorSpy = vi.fn()
    stdoutWriteSpy = vi.fn().mockReturnValue(true)
    vi.spyOn(console, "log").mockImplementation(logSpy)
    vi.spyOn(console, "error").mockImplementation(errorSpy)
    vi.spyOn(process.stdout, "write").mockImplementation(stdoutWriteSpy)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders pinned blocks with priority / mutability / audience meta", async () => {
    makeServicesStub({
      blocks: [
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
      ],
    })
    await pinnedCommand.parseAsync(["list"], { from: "user" })
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(output).toContain("Pinned context blocks (1)")
    expect(output).toContain("Team policies")
    expect(output).toContain("priority 100")
    expect(output).toContain("read-only")
    expect(output).toContain("audience: code-reviewers")
    expect(output).toContain("Core team norms")
    expect(exitTrap.exitCodes).toEqual([])
  })

  it("renders 'audience: all' when the block has no audience", async () => {
    makeServicesStub({
      blocks: [
        makeMemory({
          id: "block-a",
          title: "Global block",
          scope: null,
        }),
      ],
    })
    await pinnedCommand.parseAsync(["list"], { from: "user" })
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(output).toContain("audience: all")
  })

  it("emits a friendly empty message when no blocks match", async () => {
    makeServicesStub({ blocks: [] })
    await pinnedCommand.parseAsync(["list"], { from: "user" })
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(output).toContain("No pinned context blocks")
  })

  it("threads --all-audiences through as `audienceFilter: false`", async () => {
    const stub = makeServicesStub({ blocks: [] })
    await pinnedCommand.parseAsync(["list", "--all-audiences"], { from: "user" })
    expect(stub.listPinnedBlocks).toHaveBeenCalledTimes(1)
    const args = stub.listPinnedBlocks.mock.calls[0]![0] as {
      audienceFilter: boolean
      readerContext: Record<string, string>
    }
    expect(args.audienceFilter).toBe(false)
    expect(args.readerContext).toEqual({})
  })

  it("threads --audience <token> through as a single-token reader", async () => {
    const stub = makeServicesStub({ blocks: [] })
    await pinnedCommand.parseAsync(["list", "--audience", "code-reviewers"], {
      from: "user",
    })
    const args = stub.listPinnedBlocks.mock.calls[0]![0] as {
      audienceFilter: boolean
      readerContext: { agent?: string }
    }
    expect(args.audienceFilter).toBe(true)
    expect(args.readerContext).toEqual({ agent: "code-reviewers" })
  })

  it("emits JSON when --json is set", async () => {
    makeServicesStub({
      blocks: [
        makeMemory({
          id: "block-a",
          title: "JSON block",
          pinned: { priority: 50, mutability: "mutable" },
        }),
      ],
    })
    await pinnedCommand.parseAsync(["list", "--json"], { from: "user" })
    const written = stdoutWriteSpy.mock.calls.map((c) => c[0]).join("")
    const payload = JSON.parse(written) as Array<{
      id: string
      title: string
      priority: number
      mutability: string
    }>
    expect(payload).toEqual([
      expect.objectContaining({
        id: "block-a",
        title: "JSON block",
        priority: 50,
        mutability: "mutable",
      }),
    ])
  })

  it("rejects malformed --limit with a non-zero exit and a Pinned list failed prefix", async () => {
    makeServicesStub()
    await pinnedCommand.parseAsync(["list", "-n", "banana"], { from: "user" })
    expect(exitTrap.exitCodes).toEqual([1])
    const errorOutput = errorSpy.mock.calls.flat().join("\n")
    expect(errorOutput).toContain("Pinned list failed:")
    expect(errorOutput).toContain("--limit")
  })

  it("rejects --limit of 0 (positive-integer contract)", async () => {
    makeServicesStub()
    await pinnedCommand.parseAsync(["list", "-n", "0"], { from: "user" })
    expect(exitTrap.exitCodes).toEqual([1])
    const errorOutput = errorSpy.mock.calls.flat().join("\n")
    expect(errorOutput).toContain("Pinned list failed:")
    expect(errorOutput).toContain("positive integer")
  })

  it("propagates initServices failures as a Pinned list failed exit 1", async () => {
    vi.mocked(initServices).mockRejectedValue(new Error("notion 503"))
    await pinnedCommand.parseAsync(["list"], { from: "user" })
    expect(exitTrap.exitCodes).toEqual([1])
    const errorOutput = errorSpy.mock.calls.flat().join("\n")
    expect(errorOutput).toContain("Pinned list failed:")
    expect(errorOutput).toContain("notion 503")
  })
})
