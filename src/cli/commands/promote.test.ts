import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { initServices } from "../../services.js"
import { trapProcessExit } from "../test-helpers.js"
import { promoteCommand } from "./promote.js"

vi.mock("../../services.js", () => ({
  initServices: vi.fn(),
}))

vi.mock("../../core/promote.js", async () => {
  const actual = await vi.importActual<typeof import("../../core/promote.js")>(
    "../../core/promote.js"
  )
  return {
    ...actual,
    promoteMemory: vi.fn(),
    preparePromotion: vi.fn(),
  }
})

import { preparePromotion, promoteMemory } from "../../core/promote.js"

/**
 * CLI-only branches for `lore promote`:
 *   - the target lookup against `config.promotionTargets` (no-match
 *     surfaces a configured-list-aware error; empty list nudges
 *     toward `.lore.yaml`),
 *   - the promoter-identity fallback chain (explicit `--promoter`
 *     wins over `services.identity.resolveAuthor()`),
 *   - the success-line shape including the `(awaiting review)`
 *     suffix when the target requires review,
 *   - the `--dry-run` branch (calls preparePromotion, never
 *     promoteMemory, renders the audit block to stdout).
 *
 * Uses `trapProcessExit` from `src/cli/test-helpers.ts` per the
 * "Testing exit paths" pattern in `src/cli/AGENTS.md`. The no-throw
 * spy + the defensive `return` after every `process.exit(1)` in
 * `promote.ts` keep `exitCodes === [1]` and the error-emission
 * single-fire — refactors that drop the `return`s would surface as
 * `[1, 1]` and doubled `console.error` here.
 *
 * The service-level invariants (audit-block format, primary-vault
 * rejection, projectIds drop, source live-page validation, etc.)
 * are pinned in `promote.test.ts` — this file is intentionally
 * narrow and treats `promoteMemory` / `preparePromotion` as mocks
 * to focus on CLI plumbing.
 */

interface CommandHarness {
  errorSpy: ReturnType<typeof vi.fn>
  logSpy: ReturnType<typeof vi.fn>
  exitTrap: ReturnType<typeof trapProcessExit>
}

function makeHarness(): CommandHarness {
  const errorSpy = vi.fn()
  const logSpy = vi.fn()
  const exitTrap = trapProcessExit()
  vi.spyOn(console, "error").mockImplementation(errorSpy)
  vi.spyOn(console, "log").mockImplementation(logSpy)
  return { errorSpy, logSpy, exitTrap }
}

function makeServicesStub(
  options: {
    promotionTargets?: Array<{
      name: string
      pageId: string
      requireReview?: boolean
    }>
    resolveAuthor?: () => Promise<string | null>
  } = {}
): unknown {
  return {
    client: {} as unknown,
    memories: {} as unknown,
    config: {
      vault: { pageId: "primary-vault" },
      promotionTargets: options.promotionTargets ?? [],
    },
    identity: {
      resolveAuthor: options.resolveAuthor ?? (async () => "Resolved Engineer"),
    },
  }
}

describe("promoteCommand", () => {
  beforeEach(() => {
    vi.mocked(initServices).mockReset()
    vi.mocked(promoteMemory).mockReset()
    vi.mocked(preparePromotion).mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("errors with a configured-targets hint when --to does not match any target", async () => {
    const { errorSpy, exitTrap } = makeHarness()
    vi.mocked(initServices).mockResolvedValue(
      makeServicesStub({
        promotionTargets: [
          { name: "Team", pageId: "team-vault" },
          { name: "Org", pageId: "org-vault" },
        ],
      }) as never
    )

    await promoteCommand.parseAsync(["mem-1", "--to", "Mistype"], { from: "user" })

    expect(promoteMemory).not.toHaveBeenCalled()
    expect(preparePromotion).not.toHaveBeenCalled()
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const text = errorSpy.mock.calls.flat().map(String).join("\n")
    expect(text).toContain("Promote failed:")
    expect(text).toContain('no promotion target named "Mistype"')
    expect(text).toContain('configured targets: "Team", "Org"')
  })

  it("nudges toward .lore.yaml when no promotion targets are configured", async () => {
    const { errorSpy, exitTrap } = makeHarness()
    vi.mocked(initServices).mockResolvedValue(makeServicesStub() as never)

    await promoteCommand.parseAsync(["mem-1", "--to", "Team"], { from: "user" })

    expect(promoteMemory).not.toHaveBeenCalled()
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const text = errorSpy.mock.calls.flat().map(String).join("\n")
    expect(text).toContain("Promote failed:")
    expect(text).toContain("no promotion targets are configured")
    expect(text).toContain(".lore.yaml")
  })

  it("rejects when no promoter identity can be resolved", async () => {
    const { errorSpy, exitTrap } = makeHarness()
    vi.mocked(initServices).mockResolvedValue(
      makeServicesStub({
        promotionTargets: [{ name: "Team", pageId: "team-vault" }],
        resolveAuthor: async () => null,
      }) as never
    )

    await promoteCommand.parseAsync(["mem-1", "--to", "Team"], { from: "user" })

    expect(promoteMemory).not.toHaveBeenCalled()
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const text = errorSpy.mock.calls.flat().map(String).join("\n")
    expect(text).toContain("Promote failed:")
    expect(text).toContain("LORE_USER_NAME")
    expect(text).toContain("--promoter")
  })

  it("surfaces initServices failures via the standard 'Promote failed:' prefix and exit 1", async () => {
    const { errorSpy, exitTrap } = makeHarness()
    vi.mocked(initServices).mockRejectedValue(new Error("notion 503"))

    await promoteCommand.parseAsync(["mem-1", "--to", "Team"], { from: "user" })

    expect(promoteMemory).not.toHaveBeenCalled()
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const text = errorSpy.mock.calls.flat().map(String).join("\n")
    expect(text).toContain("Promote failed:")
    expect(text).toContain("notion 503")
  })

  it("prefers --promoter over the resolveAuthor chain", async () => {
    const { logSpy } = makeHarness()
    vi.mocked(initServices).mockResolvedValue(
      makeServicesStub({
        promotionTargets: [{ name: "Team", pageId: "team-vault" }],
        resolveAuthor: async () => "Auto Engineer",
      }) as never
    )
    vi.mocked(promoteMemory).mockResolvedValue({
      promoted: { id: "promoted-1", title: "Promoted memory title" } as never,
      targetVaultLabel: "Team",
      status: "accepted",
    })

    await promoteCommand.parseAsync(
      ["mem-1", "--to", "Team", "--promoter", "Override Engineer"],
      { from: "user" }
    )

    expect(promoteMemory).toHaveBeenCalledTimes(1)
    const inputArg = vi.mocked(promoteMemory).mock.calls[0]?.[1]
    expect(inputArg?.promoter).toBe("Override Engineer")
    const logText = logSpy.mock.calls.map((c) => String(c[0])).join("\n")
    expect(logText).toContain("Promoter: Override Engineer")
  })

  it("renders (awaiting review) suffix when target.requireReview is true", async () => {
    const { logSpy } = makeHarness()
    vi.mocked(initServices).mockResolvedValue(
      makeServicesStub({
        promotionTargets: [{ name: "Team", pageId: "team-vault", requireReview: true }],
      }) as never
    )
    vi.mocked(promoteMemory).mockResolvedValue({
      promoted: { id: "promoted-1", title: "Title" } as never,
      targetVaultLabel: "Team",
      status: "proposed",
    })

    await promoteCommand.parseAsync(["mem-1", "--to", "Team"], { from: "user" })

    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n")
    expect(text).toContain("Promoted to Team:")
    expect(text).toContain("(awaiting review)")
    expect(text).toContain("Status: proposed")
  })

  it("passes the reason through to promoteMemory and echoes it on success", async () => {
    const { logSpy } = makeHarness()
    vi.mocked(initServices).mockResolvedValue(
      makeServicesStub({
        promotionTargets: [{ name: "Team", pageId: "team-vault" }],
      }) as never
    )
    vi.mocked(promoteMemory).mockResolvedValue({
      promoted: { id: "promoted-1", title: "Title" } as never,
      targetVaultLabel: "Team",
      status: "accepted",
    })

    await promoteCommand.parseAsync(
      ["mem-1", "--to", "Team", "--reason", "Generalizes pattern"],
      { from: "user" }
    )

    const callArgs = vi.mocked(promoteMemory).mock.calls[0]?.[1]
    expect(callArgs?.reason).toBe("Generalizes pattern")
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n")
    expect(text).toContain("Reason: Generalizes pattern")
  })

  it("on --dry-run, calls preparePromotion and renders the audit block without writing", async () => {
    const { logSpy } = makeHarness()
    vi.mocked(initServices).mockResolvedValue(
      makeServicesStub({
        promotionTargets: [{ name: "Team", pageId: "team-vault", requireReview: true }],
      }) as never
    )
    vi.mocked(preparePromotion).mockResolvedValue({
      source: { id: "source-mem-1", title: "Source title" } as never,
      auditBlock: "## Promoted from Primary\n\n- **Source memory:** source-mem-1",
      body: "## Promoted from Primary\n\n- **Source memory:** source-mem-1\n\nbody",
      promoter: "Resolved Engineer",
      status: "proposed",
    })

    await promoteCommand.parseAsync(["mem-1", "--to", "Team", "--dry-run"], {
      from: "user",
    })

    expect(preparePromotion).toHaveBeenCalledTimes(1)
    expect(promoteMemory).not.toHaveBeenCalled()
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n")
    expect(text).toContain("[dry-run] Would promote to Team:")
    expect(text).toContain("(awaiting review)")
    expect(text).toContain("[dry-run] Resolved status: proposed")
    expect(text).toContain("## Promoted from Primary")
    expect(text).toContain(
      "[dry-run] No target-vault write was issued. Re-run without --dry-run to apply."
    )
  })
})
