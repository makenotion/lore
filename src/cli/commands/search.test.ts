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

  beforeEach(() => {
    vi.mocked(initServices).mockReset()
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__process_exit_${typeof code === "number" ? code : 0}__`)
    }) as never)
    errorSpy = vi.fn()
    vi.spyOn(console, "error").mockImplementation(errorSpy)
    vi.spyOn(console, "log").mockImplementation(() => {})
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
})
