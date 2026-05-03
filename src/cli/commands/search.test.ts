import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { initServices } from "../../services.js"
import { parseSearchCliOptions, searchCommand, type SearchCliOptions } from "./search.js"

vi.mock("../../services.js", () => ({
  initServices: vi.fn(),
}))

function makeServices() {
  return {
    projects: {
      findByName: vi.fn(),
    },
    context: {
      project: { id: "p-mail", name: "Mail", path: "." },
    },
    memories: {
      search: vi.fn().mockResolvedValue([
        {
          id: "m-1",
          title: "Memory 1",
          tags: ["cli"],
          source: "manual",
          updatedAt: "2026-05-03T00:00:00.000Z",
          content: "A matching memory",
        },
      ]),
    },
  }
}

describe("parseSearchCliOptions", () => {
  it("accepts a strict limit and forwards optional filters", () => {
    const result = parseSearchCliOptions({
      project: "Mail",
      tags: "cli, validation",
      limit: "10",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual<SearchCliOptions>({
        projectName: "Mail",
        tags: ["cli", "validation"],
        limit: 10,
      })
    }
  })
})

describe("searchCommand", () => {
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
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("passes a strict --limit through to memory search", async () => {
    const services = makeServices()
    vi.mocked(initServices).mockResolvedValue(services as never)

    await searchCommand.parseAsync(["needle", "--limit", "10"], {
      from: "user",
    })

    expect(services.memories.search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "needle",
        projectId: "p-mail",
        limit: 10,
      })
    )
  })

  it.each(["0", "3.7", "3abc", "1e3", "+5", "-1", ""])(
    "exits before initializing services for invalid --limit %j",
    async (raw) => {
      await expect(
        searchCommand.parseAsync(["needle", "--limit", raw], { from: "user" })
      ).rejects.toThrow("__process_exit_1__")

      expect(vi.mocked(initServices)).not.toHaveBeenCalled()
      expect(errorSpy.mock.calls.join("\n")).toContain("--limit")
    }
  )

  it("exits non-zero and skips search when --project cannot resolve", async () => {
    const search = vi.fn()
    vi.mocked(initServices).mockResolvedValue({
      projects: { findByName: vi.fn().mockResolvedValue(null) },
      memories: { search },
      context: { project: { id: "proj-ambient", name: "Ambient" } },
    } as never)

    await expect(
      searchCommand.parseAsync(["auth", "--project", "Missing"], { from: "user" })
    ).rejects.toThrow("__process_exit_1__")

    expect(search).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.join("\n")).toContain("Search failed:")
    expect(errorSpy.mock.calls.join("\n")).toContain(
      'Project "Missing" could not be resolved'
    )
    expect(errorSpy.mock.calls.join("\n")).toContain("Fix the project scope")
  })

  it("exits non-zero and skips search when --project is blank", async () => {
    const findByName = vi.fn()
    const search = vi.fn()
    vi.mocked(initServices).mockResolvedValue({
      projects: { findByName },
      memories: { search },
      context: { project: { id: "proj-ambient", name: "Ambient" } },
    } as never)

    await expect(
      searchCommand.parseAsync(["auth", "--project", ""], { from: "user" })
    ).rejects.toThrow("__process_exit_1__")

    expect(findByName).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.join("\n")).toContain('Project "" could not be resolved')
  })

  it("uses the auto-detected project when --project is omitted", async () => {
    const search = vi.fn().mockResolvedValue([])
    vi.mocked(initServices).mockResolvedValue({
      projects: { findByName: vi.fn() },
      memories: { search },
      context: { project: { id: "proj-context", name: "Context" } },
    } as never)

    await searchCommand.parseAsync(["auth"], { from: "user" })

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "auth", projectId: "proj-context" })
    )
    expect(logSpy).toHaveBeenCalledWith('No memories found for: "auth"')
  })
})
