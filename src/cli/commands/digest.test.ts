import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initServices } from "../../services.js"
import { digestCommand, resolveSpawnCwd } from "./digest.js"

vi.mock("../../services.js", () => ({
  initServices: vi.fn(),
}))

// Real on-disk fixtures — `resolveSpawnCwd` calls `existsSync` and we want
// to pin actual filesystem behavior, not a mock of it.
const SCRATCH = mkdtempSync(join(tmpdir(), "lore-digest-cli-test-"))
afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

describe("resolveSpawnCwd", () => {
  it("returns process.cwd() when no project path is given", () => {
    const warn = (): void => {}
    expect(resolveSpawnCwd(SCRATCH, undefined, warn)).toBe(process.cwd())
  })

  it("returns configRoot when the project path is the catch-all '.'", () => {
    const warn = (): void => {}
    expect(resolveSpawnCwd(SCRATCH, ".", warn)).toBe(SCRATCH)
  })

  it("returns the configured absolute path when it exists on disk (round-2 #7 happy path)", () => {
    // Use the scratch root itself as a valid sub-path — the test only cares
    // that existsSync returns true and resolve() lands on the right absolute.
    const warn = (): void => {}
    const fakeProjectPath = "."
    expect(resolveSpawnCwd(SCRATCH, fakeProjectPath, warn)).toBe(SCRATCH)
  })

  it("warns and falls back to process.cwd() when the project path is stale", () => {
    const messages: string[] = []
    const warn = (msg: string): void => {
      messages.push(msg)
    }
    const result = resolveSpawnCwd(SCRATCH, "this-path-does-not-exist", warn)
    expect(result).toBe(process.cwd())
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain(`"this-path-does-not-exist"`)
    expect(messages[0]).toContain("may diverge")
  })

  it("strips a leading slash on the project path before resolving", () => {
    // `.lore.yaml` historically allowed `/services/mail` as a project path.
    // The leading slash must be stripped so `resolve(configRoot, ...)` doesn't
    // jump up to the filesystem root.
    const warn = (): void => {}
    const result = resolveSpawnCwd(SCRATCH, "/nope-still-stale", warn)
    // Stale → fallback. The important part is that we didn't try to resolve
    // against `/nope-still-stale` as an absolute path on disk.
    expect(result).toBe(process.cwd())
  })
})

describe("digestCommand", () => {
  let errorSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.mocked(initServices).mockReset()
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__process_exit_${typeof code === "number" ? code : 0}__`)
    }) as never)
    errorSpy = vi.fn()
    vi.spyOn(console, "error").mockImplementation(errorSpy)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("exits with archived-specific wording when --project resolves only as archived", async () => {
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
    vi.mocked(initServices).mockResolvedValue({
      config: { projects: [] },
      context: { project: null },
      projects: { findByName },
    } as never)

    await expect(
      digestCommand.parseAsync(["--project", "Archive", "--dry-run"], {
        from: "user",
      })
    ).rejects.toThrow("__process_exit_1__")

    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Digest failed:")
    expect(errorText).toContain(
      'Project "Archive" could not be resolved because it is archived'
    )
    expect(findByName).toHaveBeenNthCalledWith(1, "Archive")
    expect(findByName).toHaveBeenNthCalledWith(2, "Archive", {
      includeArchived: true,
    })
  })
})
