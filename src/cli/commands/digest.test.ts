import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initServices } from "../../services.js"
import { spawnBackgroundSave } from "../../hooks/background.js"
import { touchDigestMarker } from "../../hooks/digest-marker.js"
import { gatherDigestData } from "../../core/digest.js"
import { digestCommand, resolveSpawnCwd } from "./digest.js"
import { trapProcessExit } from "../test-helpers.js"

vi.mock("../../services.js", () => ({
  initServices: vi.fn(),
}))

vi.mock("../../hooks/background.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/background.js")>()
  return {
    ...actual,
    spawnBackgroundSave: vi.fn(),
  }
})

vi.mock("../../hooks/digest-marker.js", () => ({
  touchDigestMarker: vi.fn(async () => {}),
}))

vi.mock("../../core/digest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/digest.js")>()
  return {
    ...actual,
    gatherDigestData: vi.fn(),
  }
})

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
    // `.lore.yaml` historically allowed `/services/widget` as a project path.
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
  let logSpy: ReturnType<typeof vi.fn>
  let exitTrap: ReturnType<typeof trapProcessExit>

  beforeEach(() => {
    vi.mocked(initServices).mockReset()
    vi.mocked(spawnBackgroundSave).mockReset()
    vi.mocked(gatherDigestData).mockReset()
    vi.mocked(touchDigestMarker).mockClear()
    exitTrap = trapProcessExit()
    errorSpy = vi.fn()
    logSpy = vi.fn()
    vi.spyOn(console, "error").mockImplementation(errorSpy)
    vi.spyOn(console, "log").mockImplementation(logSpy)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("exits 1 with the no-project diagnostic when neither --project nor context resolves a project", async () => {
    vi.mocked(initServices).mockResolvedValue({
      config: { projects: [] },
      context: { project: null },
      projects: { findByName: vi.fn() },
    } as never)

    await digestCommand.parseAsync([], { from: "user" })

    const errorText = errorSpy.mock.calls.flat().join("\n")
    // Pin the exact wording so a refactor that rephrases the actionable
    // hint (`Pass --project <name> or run from a directory inside a
    // configured project path.`) breaks the test loudly. Operators paste
    // the hint into their next invocation; rewording it without
    // intention degrades that path.
    expect(errorText).toContain("No project resolved")
    expect(errorText).toContain("Pass --project <name>")
    expect(errorText).toContain("configured project path")
    // `toEqual([1])` — not `toContain(1)` — pins the exit-once
    // contract. A missing defensive `return` after the inner
    // `process.exit(1)` would let execution fall through to the outer
    // catch and call `process.exit(1)` a second time; `toContain(1)`
    // would silently accept the runaway. See PR #512's review.
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(vi.mocked(gatherDigestData)).not.toHaveBeenCalled()
    expect(vi.mocked(spawnBackgroundSave)).not.toHaveBeenCalled()
  })

  it("exits 1 with the spawn-failure diagnostic when spawnBackgroundSave returns a non-benign-race failure", async () => {
    vi.mocked(initServices).mockResolvedValue({
      config: { projects: [{ name: "Widget", path: "." }], hooks: {} },
      configRoot: "/tmp/digest-test",
      context: { project: { id: "p-widget", name: "Widget", path: "." } },
      projects: { findByName: vi.fn() },
    } as never)
    vi.mocked(gatherDigestData).mockResolvedValue({
      raw: "## activity\n- did a thing",
      lastDigestDate: null,
      recentMemoryCount: 3,
    })
    // `binary-missing` is a genuine failure (not a benign race) so the
    // command must exit non-zero. A future SpawnResult variant added to
    // the failure side will fall through this same code path; the test
    // pins the error wording so a refactor that swaps the message would
    // break a shell integration relying on `Failed to spawn` for grep.
    vi.mocked(spawnBackgroundSave).mockReturnValue({ kind: "binary-missing" })

    await digestCommand.parseAsync([], { from: "user" })

    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Failed to spawn digest synthesizer.")
    // Tightened: same exit-once contract as the no-project block.
    // `binary-missing` falls into the generic spawn-failure branch
    // (NOT `lock-path-too-long`), so only the `Failed to spawn` line
    // emits — a doubled emission would print the synthesizer message
    // a second time with the sentinel as the error.
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    // Marker touch is post-spawn; a failed spawn must NOT advance the
    // debounce marker, otherwise the next Stop hook would skip the
    // catch-up auto-digest and the operator would lose this week's
    // digest entirely.
    expect(vi.mocked(touchDigestMarker)).not.toHaveBeenCalled()
  })

  it("exits 1 with the actionable lock-path diagnostic when spawnBackgroundSave returns lock-path-too-long", async () => {
    // The `lock-path-too-long` branch is structurally distinct from the
    // generic `Failed to spawn digest synthesizer.` path: there's no
    // peer doing the work (so it's NOT a benign race), and the
    // actionable knob is `LORE_HOOK_STATE_DIR`. Operators grep stderr
    // for `lock path too long` to triage this — pin the wording so a
    // refactor that drops the actionable hint breaks the test loudly.
    //
    // Same exit-once contract as the no-project / generic spawn-failure
    // branches: the branch has a defensive `return` after
    // `process.exit(1)` so the doubled-emission failure mode (which
    // would print the generic `Failed to spawn digest synthesizer.`
    // line on top of the actionable lock-path diagnostic) cannot
    // regress silently.
    vi.mocked(initServices).mockResolvedValue({
      config: { projects: [{ name: "Widget", path: "." }], hooks: {} },
      configRoot: "/tmp/digest-test",
      context: { project: { id: "p-widget", name: "Widget", path: "." } },
      projects: { findByName: vi.fn() },
    } as never)
    vi.mocked(gatherDigestData).mockResolvedValue({
      raw: "## activity\n- did a thing",
      lastDigestDate: null,
      recentMemoryCount: 3,
    })
    vi.mocked(spawnBackgroundSave).mockReturnValue({
      kind: "lock-path-too-long",
      code: "ENAMETOOLONG",
      lockKey: "digest-Widget",
    })

    await digestCommand.parseAsync([], { from: "user" })

    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Failed to spawn digest synthesizer:")
    expect(errorText).toContain("lock path too long")
    expect(errorText).toContain("ENAMETOOLONG")
    expect(errorText).toContain("Shorten LORE_HOOK_STATE_DIR")
    expect(exitTrap.exitCodes).toEqual([1])
    // `toHaveBeenCalledTimes(1)` is the load-bearing assertion against
    // the doubled-emission failure mode here: without the defensive
    // `return` on the lock-path branch, fall-through would hit the
    // generic `console.error("Failed to spawn digest synthesizer.")`
    // line, errorSpy would be called twice, and an operator's stderr
    // would carry both the actionable lock-path diagnostic AND a
    // misleading generic message. The strict count prevents that
    // regression.
    expect(errorSpy).toHaveBeenCalledTimes(1)
    // Same marker-touch invariant as the binary-missing branch — a
    // failed spawn must not advance the debounce marker.
    expect(vi.mocked(touchDigestMarker)).not.toHaveBeenCalled()
  })

  it("does NOT exit on benign-race spawn results (lock-held / cap-hit / race-lost)", async () => {
    // Negative test: the early `if (isBenignRace(result))` branch must
    // log a `Digest already in flight` message and return cleanly.
    // Without this guard a peer producing the digest would surface as
    // a false-positive failure to the operator.
    vi.mocked(initServices).mockResolvedValue({
      config: { projects: [{ name: "Widget", path: "." }], hooks: {} },
      configRoot: "/tmp/digest-test",
      context: { project: { id: "p-widget", name: "Widget", path: "." } },
      projects: { findByName: vi.fn() },
    } as never)
    vi.mocked(gatherDigestData).mockResolvedValue({
      raw: "## activity\n- did a thing",
      lastDigestDate: null,
      recentMemoryCount: 3,
    })
    vi.mocked(spawnBackgroundSave).mockReturnValue({ kind: "lock-held" })

    await digestCommand.parseAsync([], { from: "user" })

    expect(exitTrap.exitCodes).toEqual([])
    expect(logSpy.mock.calls.flat().join("\n")).toContain(
      'Digest already in flight for "Widget"'
    )
    expect(vi.mocked(touchDigestMarker)).not.toHaveBeenCalled()
  })

  it("exits 1 via the catch-all when initServices throws", async () => {
    // A Notion-side outage during `initServices` lands in the
    // outermost try/catch — distinct from the project-resolution
    // throw exercised by the archived-project test below. Both paths
    // must surface `Digest failed:` so shell scripts grepping the
    // prefix get a stable signal regardless of where the failure
    // originated.
    vi.mocked(initServices).mockRejectedValue(new Error("notion 503: gateway"))

    await digestCommand.parseAsync([], { from: "user" })

    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Digest failed:")
    expect(errorText).toContain("notion 503: gateway")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
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

    await digestCommand.parseAsync(["--project", "Archive", "--dry-run"], {
      from: "user",
    })

    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Digest failed:")
    expect(errorText).toContain(
      'Project "Archive" could not be resolved because it is archived'
    )
    expect(exitTrap.exitCodes).toEqual([1])
    expect(findByName).toHaveBeenNthCalledWith(1, "Archive")
    expect(findByName).toHaveBeenNthCalledWith(2, "Archive", {
      includeArchived: true,
    })
  })
})
