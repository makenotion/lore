import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { initServices } from "../../services.js"
import { statusCommand } from "./status.js"

vi.mock("../../services.js", () => ({
  initServices: vi.fn(),
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
    expect(logSpy.mock.calls.join("\n")).toContain(
      "Archive [project, archived]  archive"
    )
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
})
