import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { initServices } from "../../services.js"
import { parseSearchCliOptions, searchCommand, type SearchCliOptions } from "./search.js"
import { INVALID_LIMIT_STRINGS, trapProcessExit } from "../test-helpers.js"

vi.mock("../../services.js", () => ({
  initServices: vi.fn(),
}))

function makeServices() {
  return {
    projects: {
      findByName: vi.fn(),
    },
    context: {
      project: { id: "p-widget", name: "Widget", path: "." },
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
      project: "Widget",
      tags: "cli, validation",
      limit: "10",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual<SearchCliOptions>({
        projectName: "Widget",
        tags: ["cli", "validation"],
        limit: 10,
      })
    }
  })
})

describe("searchCommand", () => {
  let errorSpy: ReturnType<typeof vi.fn>
  let logSpy: ReturnType<typeof vi.fn>
  let exitTrap: ReturnType<typeof trapProcessExit>

  beforeEach(() => {
    vi.mocked(initServices).mockReset()
    exitTrap = trapProcessExit()
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
        projectId: "p-widget",
        limit: 10,
      })
    )
  })

  it.each(INVALID_LIMIT_STRINGS)(
    "exits 1 once before initializing services for invalid --limit %j",
    async (raw) => {
      await searchCommand.parseAsync(["needle", "--limit", raw], { from: "user" })

      expect(vi.mocked(initServices)).not.toHaveBeenCalled()
      // Pin the exact `Search failed:` prefix so a future refactor that
      // drops it (e.g., switches to a thrown error and lets Commander
      // format the exit) breaks the test loudly instead of silently
      // changing operator output that shell scripts grep against.
      expect(errorSpy.mock.calls.join("\n")).toContain("Search failed:")
      expect(errorSpy.mock.calls.join("\n")).toContain("--limit")
      // `toEqual([1])` — not `toContain(1)` — pins the exit-once
      // contract. `search.ts:46` includes the defensive `return` after
      // `process.exit(1)` so this branch already exits cleanly; the
      // strict assertion guards against a future refactor that drops
      // the return and re-introduces the doubled-emission failure mode
      // that motivated PR #512's review.
      expect(exitTrap.exitCodes).toEqual([1])
      expect(errorSpy).toHaveBeenCalledTimes(1)
    }
  )

  it("exits 1 once on empty-string --limit", async () => {
    // `parseInt("")` returns `NaN` rather than a number, so the
    // empty-string parse path differs subtly from the
    // `INVALID_LIMIT_STRINGS` numeric-coercion fuzz set above. Split
    // out as its own test so a parse-helper change that mishandles
    // empty surfaces clearly instead of melting into the fuzz-array
    // assertion. Same exit-once contract.
    await searchCommand.parseAsync(["needle", "--limit", ""], { from: "user" })

    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.join("\n")).toContain("Search failed:")
    expect(errorSpy.mock.calls.join("\n")).toContain("--limit")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it("exits non-zero and surfaces stderr when memories.search itself throws (catch-all)", async () => {
    // Distinct from the project-resolution-throws path: this is the bare
    // "Notion call inside the action body raised" branch — operators rely
    // on a non-zero exit code so `if ! lore search ...; then` shell
    // integrations fail fast rather than treat an outage as no-results.
    const search = vi.fn().mockRejectedValue(new Error("notion 503: gateway"))
    vi.mocked(initServices).mockResolvedValue({
      projects: { findByName: vi.fn() },
      memories: { search },
      context: { project: { id: "proj-context", name: "Context" } },
    } as never)

    await searchCommand.parseAsync(["needle"], { from: "user" })

    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Search failed:")
    expect(errorText).toContain("notion 503: gateway")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it("exits non-zero and skips search when --project cannot resolve", async () => {
    const search = vi.fn()
    vi.mocked(initServices).mockResolvedValue({
      projects: { findByName: vi.fn().mockResolvedValue(null) },
      memories: { search },
      context: { project: { id: "proj-ambient", name: "Ambient" } },
    } as never)

    await searchCommand.parseAsync(["auth", "--project", "Missing"], { from: "user" })

    expect(search).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.join("\n")).toContain("Search failed:")
    expect(errorSpy.mock.calls.join("\n")).toContain(
      'Project "Missing" could not be resolved'
    )
    expect(errorSpy.mock.calls.join("\n")).toContain("Fix the project scope")
    expect(exitTrap.exitCodes).toEqual([1])
  })

  it("exits non-zero with archived wording when --project resolves only as archived", async () => {
    const search = vi.fn()
    const findByName = vi.fn(
      async (name: string, options?: { includeArchived?: boolean }) =>
        options?.includeArchived
          ? {
              id: "proj-archive",
              name,
              path: "archive",
              type: "project",
              status: "archived",
              description: "",
            }
          : null
    )
    vi.mocked(initServices).mockResolvedValue({
      projects: { findByName },
      memories: { search },
      context: { project: { id: "proj-ambient", name: "Ambient" } },
    } as never)

    await searchCommand.parseAsync(["auth", "--project", "Archive"], { from: "user" })

    expect(search).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.join("\n")).toContain(
      'Project "Archive" could not be resolved because it is archived'
    )
    expect(findByName).toHaveBeenNthCalledWith(1, "Archive")
    expect(findByName).toHaveBeenNthCalledWith(2, "Archive", {
      includeArchived: true,
    })
    expect(exitTrap.exitCodes).toEqual([1])
  })

  it("exits non-zero and skips search when --project is blank", async () => {
    const findByName = vi.fn()
    const search = vi.fn()
    vi.mocked(initServices).mockResolvedValue({
      projects: { findByName },
      memories: { search },
      context: { project: { id: "proj-ambient", name: "Ambient" } },
    } as never)

    await searchCommand.parseAsync(["auth", "--project", ""], { from: "user" })

    expect(findByName).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.join("\n")).toContain('Project "" could not be resolved')
    expect(exitTrap.exitCodes).toEqual([1])
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
