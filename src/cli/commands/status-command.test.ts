import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { initServices } from "../../services.js"
import { statusCommand } from "./status.js"

vi.mock("../../services.js", () => ({
  initServices: vi.fn(),
}))

vi.mock("../../core/task.js", () => ({
  taskStats: vi.fn(async () => ({
    total: 0,
    overdue: 0,
    stale: 0,
    inProgress: 0,
    blocked: 0,
    closedLast30Days: null,
  })),
  todayUtc: vi.fn(() => "2026-05-03"),
  formatTaskSummary: vi.fn(() => ["Tasks: 0 active"]),
}))

vi.mock("../../core/wakeup.js", () => ({
  loadWakeUpData: vi.fn(async () => ({ coverage: null })),
  formatWakeUpCoverageReport: vi.fn(() => []),
}))

describe("statusCommand", () => {
  let errorSpy: ReturnType<typeof vi.fn>
  let logSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.mocked(initServices).mockReset()
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__process_exit_${typeof code === "number" ? code : 0}__`)
    }) as never)
    errorSpy = vi.fn()
    logSpy = vi.fn()
    vi.spyOn(console, "error").mockImplementation(errorSpy)
    vi.spyOn(console, "log").mockImplementation(logSpy)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("lists only archived projects with --archived-only", async () => {
    const list = vi.fn(async () => [
      {
        id: "p-archive",
        name: "Archive",
        path: "archive",
        type: "project",
        status: "archived",
        description: "",
      },
    ])
    vi.mocked(initServices).mockResolvedValue({
      projects: { list },
    } as never)

    await statusCommand.parseAsync(["projects", "--archived-only"], {
      from: "user",
    })

    expect(list).toHaveBeenCalledWith("archived")
    expect(logSpy.mock.calls.join("\n")).toContain("Archive [project, archived]  archive")
  })

  it("rejects mutually exclusive project listing modes before service init", async () => {
    await expect(
      statusCommand.parseAsync(["projects", "--all", "--archived-only"], {
        from: "user",
      })
    ).rejects.toThrow("__process_exit_1__")

    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.join("\n")).toContain(
      "--all and --archived-only cannot be combined."
    )
  })

  it("exits with archived-specific wording for archived topic scopes", async () => {
    const findByName = vi.fn(
      async (name: string, options?: { includeArchived?: boolean }) =>
        options?.includeArchived
          ? {
              id: "p-archive",
              name,
              path: "archive",
              type: "project",
              status: "archived",
              description: "",
            }
          : null
    )
    const listByProject = vi.fn(async () => [])
    vi.mocked(initServices).mockResolvedValue({
      context: { project: null },
      projects: { findByName },
      topics: { listByProject },
    } as never)

    await expect(
      statusCommand.parseAsync(["topics", "Archive"], { from: "user" })
    ).rejects.toThrow("__process_exit_1__")

    expect(errorSpy.mock.calls.join("\n")).toContain(
      'Project "Archive" could not be resolved because it is archived'
    )
    expect(findByName).toHaveBeenNthCalledWith(1, "Archive")
    expect(findByName).toHaveBeenNthCalledWith(2, "Archive", {
      includeArchived: true,
    })
    expect(listByProject).not.toHaveBeenCalled()
  })

  it("renders configured topology health and reuses cached probes", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lore-cli-topology-status-"))
    const previousStateDir = process.env["LORE_HOOK_STATE_DIR"]
    process.env["LORE_HOOK_STATE_DIR"] = stateDir

    try {
      const listBlocks = vi.fn(async ({ block_id }: { block_id: string }) => {
        throw new Error(`not shared: ${block_id}`)
      })
      vi.mocked(initServices).mockResolvedValue({
        client: {
          blocks: { children: { list: listBlocks } },
          databases: { retrieve: vi.fn() },
        },
        configRoot: "/repo",
        config: {
          vault: { pageId: "primary-page" },
          upstreamVaults: [
            { name: "Engineering", pageId: "upstream-page", priority: 10 },
          ],
          promotionTargets: [{ name: "Team", pageId: "team-page", requireReview: true }],
        },
        context: {
          vault: { pageId: "primary-page" },
          project: null,
        },
        vault: {
          stats: vi.fn(async () => ({
            projects: 1,
            topics: 1,
            memories: 0,
            facts: 0,
          })),
        },
        facts: { countByPredicateRaw: vi.fn(async () => 0) },
        memories: {
          confidenceStats: vi.fn(async () => ({
            totalMemories: 0,
            scoredMemories: 0,
            averageScore: 0,
            belowThreshold: 0,
          })),
        },
        projects: { list: vi.fn(async () => []) },
      } as never)

      await statusCommand.parseAsync([], { from: "user" })
      expect(listBlocks).toHaveBeenCalledTimes(2)

      logSpy.mockClear()
      await statusCommand.parseAsync([], { from: "user" })

      expect(listBlocks).toHaveBeenCalledTimes(2)
      const text = logSpy.mock.calls.map(([line]) => String(line)).join("\n")
      expect(text).toContain("Vault topology:")
      expect(text).toContain("Engineering · mode read-only · priority 10")
      expect(text).toContain("health unavailable (not shared: upstream-page; cached")
      expect(text).toContain("Team · mode promotion (review required)")
      expect(text).toContain("health unavailable (not shared: team-page; cached")
    } finally {
      if (previousStateDir === undefined) {
        delete process.env["LORE_HOOK_STATE_DIR"]
      } else {
        process.env["LORE_HOOK_STATE_DIR"] = previousStateDir
      }
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})
