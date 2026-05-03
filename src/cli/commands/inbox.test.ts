import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { initServices } from "../../services.js"
import {
  MemoryReviewAuditError,
  MemoryReviewStateError,
} from "../../core/memory.js"
import { inboxCommand } from "./inbox.js"

vi.mock("../../services.js", () => ({
  initServices: vi.fn(),
}))

/**
 * `lore inbox` CLI tests. The MCP-side dispatch surface is covered by
 * `src/mcp/tools/polymorphic.test.ts`; this file pins the CLI-only
 * branches: the archive Status guard, the audit-error exit-code-2
 * split, the reviewer-fallback chain, and the `lore inbox list`
 * filter shape (Kind != decision, oldest-first ordering).
 */

interface CommandHarness {
  errorSpy: ReturnType<typeof vi.fn>
  logSpy: ReturnType<typeof vi.fn>
  exitCodes: number[]
}

function makeHarness(): CommandHarness {
  const errorSpy = vi.fn()
  const logSpy = vi.fn()
  const exitCodes: number[] = []
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCodes.push(typeof code === "number" ? code : 0)
    throw new Error(
      `__process_exit_${typeof code === "number" ? code : 0}__`,
    )
  }) as never)
  vi.spyOn(console, "error").mockImplementation(errorSpy)
  vi.spyOn(console, "log").mockImplementation(logSpy)
  return { errorSpy, logSpy, exitCodes }
}

describe("inboxCommand", () => {
  beforeEach(() => {
    vi.mocked(initServices).mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("inbox list", () => {
    it("calls memories.list with excludeKinds: ['decision'] and direction: 'ascending'", async () => {
      // Composition contract with `proposedMemoryFilter()` (#281):
      // the listing surface and the count surface must agree on
      // what counts as inbox memories. Without `excludeKinds:
      // ["decision"]`, a proposed-state decision row would surface
      // here but not in `lore status`'s count.
      // `direction: "ascending"` aligns with the wake-up Proposed
      // Memories section so stale review debt surfaces first.
      const { logSpy } = makeHarness()
      type ListArgs = Record<string, unknown>
      const memoriesList = vi.fn(async (_args: ListArgs) => ({ items: [] }))
      vi.mocked(initServices).mockResolvedValue({
        memories: { list: memoriesList },
        context: { project: null },
        projects: { findByName: vi.fn(async () => null) },
      } as never)

      await inboxCommand.parseAsync(["list"], { from: "user" })

      expect(memoriesList).toHaveBeenCalledTimes(1)
      const args = memoriesList.mock.calls[0]?.[0] ?? {}
      expect(args).toMatchObject({
        status: "proposed",
        excludeKinds: ["decision"],
        direction: "ascending",
        sortBy: "created_time",
        includeContent: false,
      })
      expect(logSpy.mock.calls.join("\n")).toContain(
        "No proposed memories pending review",
      )
    })
  })

  describe("inbox archive", () => {
    it("rejects a non-proposed memory with exit 1 and a clear redirect", async () => {
      // Inbox-only contract: an operator who fat-fingers an
      // accepted memory's UUID into `lore inbox archive` must hit
      // a Status guard before the soft-delete fires. Pin the exit
      // code (1) and the redirect-to-`lore-memory action='archive'`
      // text so a future refactor can't loosen the guard.
      const { errorSpy, exitCodes } = makeHarness()
      const archive = vi.fn(async () => undefined)
      const getPropertiesById = vi.fn(async () => ({
        id: "mem-accepted",
        status: "accepted",
      }))
      vi.mocked(initServices).mockResolvedValue({
        memories: { getPropertiesById, archive },
      } as never)

      await expect(
        inboxCommand.parseAsync(["archive", "mem-accepted"], { from: "user" }),
      ).rejects.toThrow("__process_exit_1__")

      expect(archive).not.toHaveBeenCalled()
      // The mock makes process.exit throw, which gets caught by the
      // outer try/catch and re-fires process.exit. Pin the FIRST
      // exit code (the load-bearing one); the trailing repeat is an
      // artifact of the mock harness, not the production behavior.
      expect(exitCodes[0]).toBe(1)
      const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(errText).toContain('current status is "accepted"')
      expect(errText).toContain("lore-memory action='archive'")
    })

    it("archives a proposed memory and emits a success line", async () => {
      const { logSpy } = makeHarness()
      const archive = vi.fn(async () => undefined)
      const getPropertiesById = vi.fn(async () => ({
        id: "mem-proposed",
        status: "proposed",
        kind: "note",
      }))
      vi.mocked(initServices).mockResolvedValue({
        memories: { getPropertiesById, archive },
      } as never)

      await inboxCommand.parseAsync(["archive", "mem-proposed"], {
        from: "user",
      })

      expect(archive).toHaveBeenCalledWith("mem-proposed")
      expect(logSpy.mock.calls.join("\n")).toContain("Archived memory mem-proposed")
    })

    it("rejects a proposed-state decision with exit 1 and a redirect to the decision lifecycle", async () => {
      // Companion to the recordReview decision-kind guard. A pasted
      // decision id with `Status: proposed` would otherwise pass the
      // status guard above and soft-delete a proposed-state decision
      // through the memory inbox surface — bypassing the decision
      // lifecycle that owns governance. Mirrors the
      // `proposedMemoryFilter()` `Kind != decision` exclusion that
      // gates the list / count / wake-up / approve / reject surfaces;
      // archive must agree with them, otherwise the inbox boundary
      // disagrees with itself.
      const { errorSpy, exitCodes } = makeHarness()
      const archive = vi.fn(async () => undefined)
      const getPropertiesById = vi.fn(async () => ({
        id: "dec-proposed",
        status: "proposed",
        kind: "decision",
      }))
      vi.mocked(initServices).mockResolvedValue({
        memories: { getPropertiesById, archive },
      } as never)

      await expect(
        inboxCommand.parseAsync(["archive", "dec-proposed"], { from: "user" }),
      ).rejects.toThrow("__process_exit_1__")

      // Archive must NOT fire — the kind guard is pre-write fail-fast.
      expect(archive).not.toHaveBeenCalled()
      expect(exitCodes[0]).toBe(1)
      const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(errText).toContain('Kind is "decision"')
      expect(errText).toContain("lore-decision action='supersede'")
    })
  })

  describe("inbox approve / reject", () => {
    it("uses --reviewer when explicitly provided over the identity resolver", async () => {
      const { logSpy } = makeHarness()
      const recordReview = vi.fn(async () => ({
        memory: { id: "mem-1", status: "accepted" },
        previousStatus: "proposed",
      }))
      const resolveAuthor = vi.fn(async () => "Someone Else")
      vi.mocked(initServices).mockResolvedValue({
        memories: { recordReview },
        identity: { resolveAuthor },
      } as never)

      await inboxCommand.parseAsync(
        ["approve", "mem-1", "--reviewer", "Alice"],
        { from: "user" },
      )

      expect(resolveAuthor).not.toHaveBeenCalled()
      expect(recordReview).toHaveBeenCalledWith({
        memoryId: "mem-1",
        verdict: "approve",
        reviewer: "Alice",
        reason: undefined,
      })
      expect(logSpy.mock.calls.join("\n")).toContain("Reviewer: Alice")
    })

    it("falls back to identity.resolveAuthor when --reviewer is omitted", async () => {
      const { logSpy } = makeHarness()
      const recordReview = vi.fn(async () => ({
        memory: { id: "mem-2", status: "rejected" },
        previousStatus: "proposed",
      }))
      const resolveAuthor = vi.fn(async () => "Engineer From users.me")
      vi.mocked(initServices).mockResolvedValue({
        memories: { recordReview },
        identity: { resolveAuthor },
      } as never)

      await inboxCommand.parseAsync(["reject", "mem-2"], { from: "user" })

      expect(resolveAuthor).toHaveBeenCalled()
      expect(recordReview).toHaveBeenCalledWith({
        memoryId: "mem-2",
        verdict: "reject",
        reviewer: "Engineer From users.me",
        reason: undefined,
      })
      expect(logSpy.mock.calls.join("\n")).toContain(
        "Reviewer: Engineer From users.me",
      )
    })

    it("exits 1 with an actionable error when no reviewer identity resolves", async () => {
      const { errorSpy, exitCodes } = makeHarness()
      const recordReview = vi.fn()
      const resolveAuthor = vi.fn(async () => null)
      vi.mocked(initServices).mockResolvedValue({
        memories: { recordReview },
        identity: { resolveAuthor },
      } as never)

      await expect(
        inboxCommand.parseAsync(["approve", "mem-3"], { from: "user" }),
      ).rejects.toThrow("__process_exit_1__")

      expect(recordReview).not.toHaveBeenCalled()
      // The mock makes process.exit throw, which gets caught by the
      // outer try/catch and re-fires process.exit. Pin the FIRST
      // exit code (the load-bearing one); the trailing repeat is an
      // artifact of the mock harness, not the production behavior.
      expect(exitCodes[0]).toBe(1)
      const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(errText).toContain("no reviewer identity available")
      expect(errText).toContain("--reviewer <name>")
    })

    it("exits 2 (not 1) on MemoryReviewAuditError so wrappers can disambiguate", async () => {
      // `MemoryReviewAuditError` signals a load-bearing partial
      // state: the Status flip persisted, only the audit block is
      // missing. Exit code 2 (vs 1 for state errors) lets a
      // wrapper script detect "review landed, audit missing" and
      // re-trigger remediation without parsing the message string.
      const { errorSpy, exitCodes } = makeHarness()
      const recordReview = vi.fn(async () => {
        throw new MemoryReviewAuditError(
          "Review persisted (status: proposed → accepted) but audit-block append failed: notion 5xx",
          {
            memoryId: "mem-4",
            previousStatus: "proposed",
            newStatus: "accepted",
            cause: new Error("notion 5xx"),
          },
        )
      })
      const resolveAuthor = vi.fn(async () => "Alice")
      vi.mocked(initServices).mockResolvedValue({
        memories: { recordReview },
        identity: { resolveAuthor },
      } as never)

      await expect(
        inboxCommand.parseAsync(["approve", "mem-4"], { from: "user" }),
      ).rejects.toThrow("__process_exit_2__")

      expect(exitCodes[0]).toBe(2)
      const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(errText).toContain(
        "Inbox approve completed with audit-trail failure:",
      )
    })

    it("exits 1 (not 2) on MemoryReviewStateError", async () => {
      // State errors are pre-write — the row never flipped. Exit
      // code 1 distinguishes "didn't happen" from the audit-error
      // partial-success at exit code 2.
      const { errorSpy, exitCodes } = makeHarness()
      const recordReview = vi.fn(async () => {
        throw new MemoryReviewStateError(
          'Cannot approve memory mem-5: current status is "accepted"',
          { memoryId: "mem-5", currentStatus: "accepted" },
        )
      })
      const resolveAuthor = vi.fn(async () => "Alice")
      vi.mocked(initServices).mockResolvedValue({
        memories: { recordReview },
        identity: { resolveAuthor },
      } as never)

      await expect(
        inboxCommand.parseAsync(["approve", "mem-5"], { from: "user" }),
      ).rejects.toThrow("__process_exit_1__")

      // The mock makes process.exit throw, which gets caught by the
      // outer try/catch and re-fires process.exit. Pin the FIRST
      // exit code (the load-bearing one); the trailing repeat is an
      // artifact of the mock harness, not the production behavior.
      expect(exitCodes[0]).toBe(1)
      const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(errText).toContain("Inbox approve failed:")
      expect(errText).not.toContain("audit-trail failure")
    })

    it("forwards --reason to recordReview when provided", async () => {
      const { logSpy } = makeHarness()
      const recordReview = vi.fn(async () => ({
        memory: { id: "mem-6", status: "rejected" },
        previousStatus: "proposed",
      }))
      const resolveAuthor = vi.fn(async () => "Alice")
      vi.mocked(initServices).mockResolvedValue({
        memories: { recordReview },
        identity: { resolveAuthor },
      } as never)

      await inboxCommand.parseAsync(
        ["reject", "mem-6", "--reason", "Duplicate of an earlier note"],
        { from: "user" },
      )

      expect(recordReview).toHaveBeenCalledWith({
        memoryId: "mem-6",
        verdict: "reject",
        reviewer: "Alice",
        reason: "Duplicate of an earlier note",
      })
      expect(logSpy.mock.calls.join("\n")).toContain(
        "Reason: Duplicate of an earlier note",
      )
    })
  })
})
