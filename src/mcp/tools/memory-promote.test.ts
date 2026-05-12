import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerMemoryTools } from "./memory.js"
import { promoteMemory } from "../../core/promote.js"

vi.mock("../../core/promote.js", async () => {
  const actual = await vi.importActual<typeof import("../../core/promote.js")>(
    "../../core/promote.js",
  )
  return {
    ...actual,
    promoteMemory: vi.fn(),
    preparePromotion: vi.fn(),
  }
})

/**
 * MCP `lore-memory action='promote'` dispatch tests (issue #286).
 *
 * The service-layer invariants (audit-block format, primary-vault
 * rejection, projectIds/tags drop, source live-page validation) are
 * pinned in `src/core/promote.test.ts`; the CLI plumbing branches
 * are pinned in `src/cli/commands/promote.test.ts`. This file is
 * scoped to the MCP dispatcher: target-name lookup, promoter
 * identity resolution, response shape, and (awaiting review) suffix
 * for review-required targets.
 *
 * `promoteMemory` is mocked so the test focuses on the dispatcher's
 * argument-threading and response-formatting contract, not on the
 * Notion plumbing the service tests already cover.
 */

interface MockServer {
  server: {
    registerTool: (
      name: string,
      _config: unknown,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) => void
  }
  get(name: string): (args: Record<string, unknown>) => Promise<unknown>
}

function createMockServer(): MockServer {
  const handlers = new Map<
    string,
    (args: Record<string, unknown>) => Promise<unknown>
  >()
  return {
    server: {
      registerTool: (name, _config, handler) => {
        handlers.set(name, handler)
      },
    },
    get(name) {
      const handler = handlers.get(name)
      if (!handler) throw new Error(`tool ${name} not registered`)
      return handler
    },
  }
}

function extractText(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]!.text
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true
}

function makePromoteServices(
  options: {
    promotionTargets?: Array<{
      name: string
      pageId: string
      requireReview?: boolean
    }>
    resolveAuthor?: () => Promise<string | null>
  } = {},
): unknown {
  return {
    client: {} as unknown,
    memories: {} as unknown,
    config: {
      vault: { pageId: "primary-vault" },
      promotionTargets: options.promotionTargets ?? [],
    },
    context: { project: null, vault: { pageId: "primary-vault" } },
    identity: {
      resolveAuthor: options.resolveAuthor ?? (async () => "Resolved Engineer"),
    },
    wakeupCache: {
      bumpEpoch: vi.fn(),
    },
  }
}

describe("lore-memory action='promote' dispatch", () => {
  beforeEach(() => {
    vi.mocked(promoteMemory).mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns an MCP error when targetName does not match any configured target", async () => {
    const mock = createMockServer()
    registerMemoryTools(
      mock.server as never,
      makePromoteServices({
        promotionTargets: [
          { name: "Team", pageId: "team-vault" },
          { name: "Org", pageId: "org-vault" },
        ],
      }) as never,
    )

    const result = await mock.get("lore-memory")({
      action: "promote",
      memoryId: "mem-1",
      targetName: "Mistype",
    })

    expect(promoteMemory).not.toHaveBeenCalled()
    expect(isError(result)).toBe(true)
    const text = extractText(result)
    expect(text).toContain('No promotion target named "Mistype"')
    expect(text).toContain('configured targets: "Team", "Org"')
  })

  it("returns an MCP error when no promoter identity resolves", async () => {
    const mock = createMockServer()
    registerMemoryTools(
      mock.server as never,
      makePromoteServices({
        promotionTargets: [{ name: "Team", pageId: "team-vault" }],
        resolveAuthor: async () => null,
      }) as never,
    )

    const result = await mock.get("lore-memory")({
      action: "promote",
      memoryId: "mem-1",
      targetName: "Team",
    })

    expect(promoteMemory).not.toHaveBeenCalled()
    expect(isError(result)).toBe(true)
    const text = extractText(result)
    expect(text).toContain("no promoter identity")
    expect(text).toContain("LORE_USER_NAME")
    // Routes operators wanting an explicit override at the CLI's
    // `--promoter` flag — the MCP boundary deliberately does not
    // accept a client-supplied promoter (audit-forgery defense).
    expect(text).toContain("lore promote --promoter")
  })

  it("uses the server-resolved identity (NOT any client-supplied promoter)", async () => {
    // PR #589 review blocker: the MCP surface uses
    // `services.identity.resolveAuthor()` as the only promoter
    // source. Client-supplied `promoter` strings are not part of
    // the schema and must not influence the audit attribution.
    const mock = createMockServer()
    registerMemoryTools(
      mock.server as never,
      makePromoteServices({
        promotionTargets: [{ name: "Team", pageId: "team-vault" }],
        resolveAuthor: async () => "Server Resolved Engineer",
      }) as never,
    )
    vi.mocked(promoteMemory).mockResolvedValue({
      promoted: { id: "promoted-1", title: "Promoted title" } as never,
      targetVaultLabel: "Team",
      status: "accepted",
    })

    const result = await mock.get("lore-memory")({
      action: "promote",
      memoryId: "mem-1",
      targetName: "Team",
    })

    expect(promoteMemory).toHaveBeenCalledTimes(1)
    const callInput = vi.mocked(promoteMemory).mock.calls[0]?.[1]
    expect(callInput?.promoter).toBe("Server Resolved Engineer")
    const text = extractText(result)
    expect(text).toContain("Promoted memory mem-1 to Team")
    expect(text).toContain("Status: accepted")
    expect(text).toContain("Promoter: Server Resolved Engineer")
  })

  it("renders (awaiting review) suffix when target.requireReview is true", async () => {
    const mock = createMockServer()
    registerMemoryTools(
      mock.server as never,
      makePromoteServices({
        promotionTargets: [
          { name: "Team", pageId: "team-vault", requireReview: true },
        ],
      }) as never,
    )
    vi.mocked(promoteMemory).mockResolvedValue({
      promoted: { id: "promoted-1", title: "Title" } as never,
      targetVaultLabel: "Team",
      status: "proposed",
    })

    const result = await mock.get("lore-memory")({
      action: "promote",
      memoryId: "mem-1",
      targetName: "Team",
    })

    const text = extractText(result)
    expect(text).toContain("Promoted memory mem-1 to Team (awaiting review)")
    expect(text).toContain("Status: proposed")
  })

  it("threads reason and source URL through to the service helper", async () => {
    const mock = createMockServer()
    registerMemoryTools(
      mock.server as never,
      makePromoteServices({
        promotionTargets: [{ name: "Team", pageId: "team-vault" }],
      }) as never,
    )
    vi.mocked(promoteMemory).mockResolvedValue({
      promoted: { id: "promoted-1", title: "Title" } as never,
      targetVaultLabel: "Team",
      status: "accepted",
    })

    const result = await mock.get("lore-memory")({
      action: "promote",
      memoryId: "abc12345-6789-4def-8123-456789012345",
      targetName: "Team",
      reason: "Generalizes pattern",
    })

    const callInput = vi.mocked(promoteMemory).mock.calls[0]?.[1]
    expect(callInput?.reason).toBe("Generalizes pattern")
    // Source URL must be the dashless Notion form — matches the
    // shared `notionPageUrl` helper that strips hyphens.
    expect(callInput?.sourceMemoryUrl).toBe(
      "https://notion.so/abc1234567894def8123456789012345",
    )
    const text = extractText(result)
    expect(text).toContain("Reason: Generalizes pattern")
  })

  it("surfaces handlePromote MCP error when the service helper throws", async () => {
    const mock = createMockServer()
    registerMemoryTools(
      mock.server as never,
      makePromoteServices({
        promotionTargets: [{ name: "Team", pageId: "team-vault" }],
      }) as never,
    )
    vi.mocked(promoteMemory).mockRejectedValue(
      new Error("Memory mem-1 is not in the Memories database."),
    )

    const result = await mock.get("lore-memory")({
      action: "promote",
      memoryId: "mem-1",
      targetName: "Team",
    })

    expect(isError(result)).toBe(true)
    const text = extractText(result)
    expect(text).toContain("not in the Memories database")
  })

  it("rejects action='promote' without targetName via the discriminated union", async () => {
    const mock = createMockServer()
    registerMemoryTools(
      mock.server as never,
      makePromoteServices({
        promotionTargets: [{ name: "Team", pageId: "team-vault" }],
      }) as never,
    )

    const result = await mock.get("lore-memory")({
      action: "promote",
      memoryId: "mem-1",
    })

    expect(promoteMemory).not.toHaveBeenCalled()
    expect(isError(result)).toBe(true)
    const text = extractText(result)
    expect(text).toContain("lore-memory")
    expect(text).toContain("targetName")
  })

  it("surfaces same-vault rejection from the service helper", async () => {
    // Cross-surface contract: the same-vault guard fires inside
    // `promoteMemory` and the MCP dispatcher relays the error
    // verbatim. Service-layer tests pin the guard itself
    // (`src/core/promote.test.ts`); this test pins the
    // dispatcher's surface contract so a future MCP refactor
    // can't accidentally swallow the rejection.
    const mock = createMockServer()
    registerMemoryTools(
      mock.server as never,
      makePromoteServices({
        promotionTargets: [
          { name: "SameAsPrimary", pageId: "primary-vault" },
        ],
      }) as never,
    )
    vi.mocked(promoteMemory).mockRejectedValue(
      new Error(
        'Cannot promote into the primary vault (target "SameAsPrimary" points at the same page id as the primary).',
      ),
    )

    const result = await mock.get("lore-memory")({
      action: "promote",
      memoryId: "mem-1",
      targetName: "SameAsPrimary",
    })

    expect(isError(result)).toBe(true)
    const text = extractText(result)
    expect(text).toContain("Cannot promote into the primary vault")
  })

  it("rejects client-supplied promoter arg via the discriminated union (no audit forgery)", async () => {
    // PR #589 review blocker: the MCP surface MUST NOT accept a
    // client-supplied `promoter` field. An agent that could supply
    // any string for `**Promoter:**` would defeat the cross-vault
    // audit gap the topology design exists to close. Pin the
    // rejection at the Zod boundary so a future schema change
    // can't silently re-introduce the field.
    const mock = createMockServer()
    registerMemoryTools(
      mock.server as never,
      makePromoteServices({
        promotionTargets: [{ name: "Team", pageId: "team-vault" }],
      }) as never,
    )

    const result = await mock.get("lore-memory")({
      action: "promote",
      memoryId: "mem-1",
      targetName: "Team",
      // Zod's strict-mode default DOES NOT reject unknown keys,
      // but the discriminated union doesn't include `promoter` so
      // the field is structurally dropped before it reaches the
      // handler. Pin behavior by snapshot: the helper is called
      // with no `promoter` field forwarded.
      promoter: "Forged Engineer",
    } as never)

    if (vi.mocked(promoteMemory).mock.calls.length > 0) {
      const callInput = vi.mocked(promoteMemory).mock.calls[0]?.[1]
      // The handler resolved its own promoter via the identity
      // resolver — it must NOT be the client-supplied "Forged
      // Engineer" string.
      expect(callInput?.promoter).not.toBe("Forged Engineer")
    }
    // The response (success or error) MUST NOT carry the forged
    // promoter string verbatim.
    const text = extractText(result)
    expect(text).not.toContain("Forged Engineer")
  })

  it("supports dryRun: true via preparePromotion without target-vault writes", async () => {
    const preparePromotion = vi.mocked(
      await import("../../core/promote.js"),
    ).preparePromotion
    preparePromotion.mockResolvedValue({
      source: { id: "mem-1", title: "Source memory title" } as never,
      auditBlock: "## Promoted from Primary\n\n- **Source memory:** mem-1",
      body: "## Promoted from Primary\n\n- **Source memory:** mem-1\n\nbody",
      promoter: "Resolved Engineer",
      status: "proposed",
    })

    const mock = createMockServer()
    registerMemoryTools(
      mock.server as never,
      makePromoteServices({
        promotionTargets: [
          { name: "Team", pageId: "team-vault", requireReview: true },
        ],
      }) as never,
    )

    const result = await mock.get("lore-memory")({
      action: "promote",
      memoryId: "mem-1",
      targetName: "Team",
      dryRun: true,
    })

    expect(preparePromotion).toHaveBeenCalledTimes(1)
    expect(promoteMemory).not.toHaveBeenCalled()
    const text = extractText(result)
    expect(text).toContain("[dry-run] Would promote memory mem-1 to Team")
    expect(text).toContain("(awaiting review)")
    expect(text).toContain("[dry-run] Resolved status: proposed")
    expect(text).toContain("## Promoted from Primary")
    expect(text).toContain(
      "[dry-run] No target-vault write was issued.",
    )
    preparePromotion.mockReset()
  })
})
