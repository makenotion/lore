import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Hoisted mocks for the two `node:child_process` primitives the module
// uses. The pattern matches `src/hooks/digest-scheduler.test.ts` —
// hoisting is required because ES modules evaluate imports before
// top-level statements; without it, the `./ntn.js` import below would
// resolve `node:child_process` to its real export before the mock is
// registered.
const { spawnMock, execFileSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileSyncMock: vi.fn(),
}))

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>("node:child_process")
  return { ...actual, spawn: spawnMock, execFileSync: execFileSyncMock }
})

import { EventEmitter } from "node:events"

import {
  checkNtnVersion,
  getNtnVersion,
  installNtn,
  isNtnInstalled,
  listNtnWorkspaces,
  loadNtnToken,
  MIN_NTN_VERSION,
  NTN_INSTALL_COMMAND,
  runNtnLogin,
} from "./ntn.js"

const SCRATCH = mkdtempSync(join(tmpdir(), "lore-ntn-test-"))

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

/**
 * Create a fresh XDG_CONFIG_HOME-rooted scratch dir, optionally
 * seeded with an `auth.json` whose contents are the literal `body`
 * string (so callers can inject malformed JSON, JSON null, etc.).
 * Sets `process.env.XDG_CONFIG_HOME` for the duration of the test so
 * the module's `ntnAuthJsonPath()` resolves into the scratch.
 */
function setupNtnConfigHome(body?: string): string {
  const xdg = mkdtempSync(join(SCRATCH, "xdg-"))
  const notionDir = join(xdg, "notion")
  mkdirSync(notionDir, { recursive: true })
  if (body !== undefined) {
    writeFileSync(join(notionDir, "auth.json"), body, { mode: 0o600 })
  }
  process.env["XDG_CONFIG_HOME"] = xdg
  return xdg
}

// `process.stderr.write` is heavily overloaded — typing a top-level
// `let stderrSpy` would force a generic spy shape that conflicts with
// the concrete return type. Capture chunks into an array instead and
// assert against the joined string, mirroring the pattern in
// `cli/commands/migrate.test.ts`.
let stderrChunks: string[] = []
const stderrText = (): string => stderrChunks.join("")

beforeEach(() => {
  stderrChunks = []
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrChunks.push(
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk as Uint8Array).toString("utf8"),
    )
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env["XDG_CONFIG_HOME"]
  delete process.env["LORE_NOTION_BASE_URL"]
  spawnMock.mockReset()
  execFileSyncMock.mockReset()
})

describe("loadNtnToken", () => {
  it("returns null when auth.json is missing", async () => {
    setupNtnConfigHome(/* no body — file absent */)
    expect(await loadNtnToken()).toBeNull()
    // Missing-file path is silent so callers can fall through to
    // deprecated paths without noise.
    expect(stderrText()).toBe("")
  })

  it("returns the single workspace's token when auth.json has one entry", async () => {
    setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-1" }))
    const result = await loadNtnToken()
    expect(result).toEqual({
      token: "tok-1",
      workspaceId: "ws-1",
      baseUrl: undefined,
    })
  })

  it("returns null with stderr hint when auth.json has multiple entries and no selector", async () => {
    setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-1", "ws-2": "tok-2" }))
    expect(await loadNtnToken()).toBeNull()
    expect(stderrText()).toContain("specify one via NOTION_WORKSPACE_ID")
    expect(stderrText()).toContain("ws-1, ws-2")
  })

  it("picks the requested workspace when multiple are present", async () => {
    setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-1", "ws-2": "tok-2" }))
    const result = await loadNtnToken({ workspaceId: "ws-2" })
    expect(result).toEqual({
      token: "tok-2",
      workspaceId: "ws-2",
      baseUrl: undefined,
    })
  })

  it("returns null with stderr hint when the requested workspace is not present", async () => {
    setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-1" }))
    expect(await loadNtnToken({ workspaceId: "ws-missing" })).toBeNull()
    expect(stderrText()).toContain("not among them")
    expect(stderrText()).toContain("ws-1")
  })

  it("returns null gracefully when auth.json is malformed JSON", async () => {
    setupNtnConfigHome("not-json")
    expect(await loadNtnToken()).toBeNull()
    expect(stderrText()).toContain("malformed")
    expect(stderrText()).toContain("lore auth --login")
    expect(stderrText()).toContain("NOTION_KEYRING=0 ntn login")
  })

  it("returns null with unexpected-shape hint when auth.json is JSON null", async () => {
    setupNtnConfigHome("null")
    expect(await loadNtnToken()).toBeNull()
    expect(stderrText()).toContain("unexpected shape")
    expect(stderrText()).toContain("lore auth --login")
    expect(stderrText()).toContain("NOTION_KEYRING=0 ntn login")
  })

  it("returns null with unexpected-shape hint when auth.json is a JSON array", async () => {
    setupNtnConfigHome("[1, 2]")
    expect(await loadNtnToken()).toBeNull()
    expect(stderrText()).toContain("unexpected shape")
  })

  it("returns null with unexpected-shape hint when auth.json is a JSON primitive", async () => {
    setupNtnConfigHome('"a-bare-string"')
    expect(await loadNtnToken()).toBeNull()
    expect(stderrText()).toContain("unexpected shape")
  })

  it("ignores non-string entries in auth.json (metadata sub-objects, numbers)", async () => {
    setupNtnConfigHome(
      JSON.stringify({ "ws-1": "tok-1", _metadata: { version: 1 }, _count: 5 }),
    )
    // Single string-valued entry survives the filter → auto-pick.
    expect(await loadNtnToken()).toEqual({
      token: "tok-1",
      workspaceId: "ws-1",
      baseUrl: undefined,
    })
  })

  it("ignores empty-string token values", async () => {
    setupNtnConfigHome(JSON.stringify({ "ws-1": "", "ws-2": "tok-2" }))
    // The empty-string entry is filtered out before workspace selection
    // — only `ws-2` survives, so the auto-pick branch fires.
    expect(await loadNtnToken()).toEqual({
      token: "tok-2",
      workspaceId: "ws-2",
      baseUrl: undefined,
    })
  })

  it("returns null on an empty-object auth.json", async () => {
    setupNtnConfigHome("{}")
    expect(await loadNtnToken()).toBeNull()
    // No selector, no entries, no shape complaint — silent.
    expect(stderrText()).toBe("")
  })

  it("honors XDG_CONFIG_HOME for the auth.json path", async () => {
    // Two scratches: the first never sees a write; the second carries
    // the fixture. Pointing XDG_CONFIG_HOME at the second proves the
    // env var drives path resolution (and is not e.g. hardcoded to
    // ~/.config).
    setupNtnConfigHome() // sets XDG to an empty scratch
    expect(await loadNtnToken()).toBeNull()

    setupNtnConfigHome(JSON.stringify({ "ws-target": "tok-target" }))
    expect(await loadNtnToken()).toEqual({
      token: "tok-target",
      workspaceId: "ws-target",
      baseUrl: undefined,
    })
  })

  it("honors LORE_NOTION_BASE_URL as the baseUrl override", async () => {
    setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-1" }))
    process.env["LORE_NOTION_BASE_URL"] = "https://staging.example.com"
    const result = await loadNtnToken()
    expect(result).toEqual({
      token: "tok-1",
      workspaceId: "ws-1",
      baseUrl: "https://staging.example.com",
    })
  })

  it("resolves baseUrl from ntn config.json env=dev", async () => {
    const xdg = setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-1" }))
    writeFileSync(
      join(xdg, "notion", "config.json"),
      JSON.stringify({ env: "dev" }),
      { mode: 0o600 },
    )
    const result = await loadNtnToken()
    expect(result).toEqual({
      token: "tok-1",
      workspaceId: "ws-1",
      baseUrl: "https://api-dev.notion.com",
    })
  })

  it("falls through to undefined baseUrl on missing or unknown config.json env", async () => {
    const xdg = setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-1" }))
    writeFileSync(
      join(xdg, "notion", "config.json"),
      JSON.stringify({ env: "prod" }),
      { mode: 0o600 },
    )
    const result = await loadNtnToken()
    expect(result?.baseUrl).toBeUndefined()
  })

  it("never logs the resolved token to stderr", async () => {
    setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-secret-do-not-leak" }))
    // Trigger every branch that emits stderr by switching scenarios:
    //   - happy path (silent)
    //   - missing-workspace (stderr line)
    //   - multi-workspace no selector (stderr line)
    await loadNtnToken()
    setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-secret-1", "ws-2": "tok-secret-2" }))
    await loadNtnToken()
    await loadNtnToken({ workspaceId: "ws-missing" })
    expect(stderrText()).not.toContain("tok-secret")
  })
})

describe("listNtnWorkspaces", () => {
  it("returns [] when auth.json is missing", async () => {
    setupNtnConfigHome()
    expect(await listNtnWorkspaces()).toEqual([])
  })

  it("returns [] when auth.json is empty object", async () => {
    setupNtnConfigHome("{}")
    expect(await listNtnWorkspaces()).toEqual([])
  })

  it("returns [] when auth.json is malformed JSON", async () => {
    setupNtnConfigHome("not-json")
    expect(await listNtnWorkspaces()).toEqual([])
  })

  it("returns [] when auth.json root is JSON null (Object.entries(null) would throw)", async () => {
    setupNtnConfigHome("null")
    expect(await listNtnWorkspaces()).toEqual([])
  })

  it("returns [] when auth.json root is a JSON array", async () => {
    setupNtnConfigHome("[1, 2]")
    expect(await listNtnWorkspaces()).toEqual([])
  })

  it("returns only workspace ids whose value is a non-empty string", async () => {
    setupNtnConfigHome(
      JSON.stringify({
        "ws-string": "tok-1",
        "ws-empty": "",
        "ws-meta": { foo: "bar" },
        "ws-num": 42,
      }),
    )
    expect(await listNtnWorkspaces()).toEqual(["ws-string"])
  })

  it("returns both workspace ids in insertion order for a two-entry auth.json", async () => {
    setupNtnConfigHome(JSON.stringify({ "ws-alpha": "tok-a", "ws-beta": "tok-b" }))
    expect(await listNtnWorkspaces()).toEqual(["ws-alpha", "ws-beta"])
  })
})

describe("isNtnInstalled", () => {
  it("returns true when `ntn --version` succeeds", () => {
    execFileSyncMock.mockImplementation(() => Buffer.from("ntn 0.12.0"))
    expect(isNtnInstalled()).toBe(true)
  })

  it("returns false when `ntn` is not on PATH (ENOENT)", () => {
    execFileSyncMock.mockImplementation(() => {
      const err = new Error("spawn ntn ENOENT") as NodeJS.ErrnoException
      err.code = "ENOENT"
      throw err
    })
    expect(isNtnInstalled()).toBe(false)
  })

  it("returns false on any error (permission denied) without throwing", () => {
    execFileSyncMock.mockImplementation(() => {
      const err = new Error("EACCES") as NodeJS.ErrnoException
      err.code = "EACCES"
      throw err
    })
    expect(() => isNtnInstalled()).not.toThrow()
    expect(isNtnInstalled()).toBe(false)
  })
})

describe("getNtnVersion / checkNtnVersion", () => {
  it("parses 'ntn 0.12.0' into '0.12.0'", () => {
    execFileSyncMock.mockReturnValue("ntn 0.12.0\n")
    expect(getNtnVersion()).toBe("0.12.0")
  })

  it("parses a build-suffix version output", () => {
    execFileSyncMock.mockReturnValue("ntn 0.13.2-rc1+abc123\n")
    expect(getNtnVersion()).toBe("0.13.2")
  })

  it("returns null when ntn is not on PATH", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("ENOENT")
    })
    expect(getNtnVersion()).toBeNull()
  })

  it("returns null when output is unparseable (no SemVer found)", () => {
    execFileSyncMock.mockReturnValue("notion CLI – built without version metadata\n")
    expect(getNtnVersion()).toBeNull()
  })

  it("checkNtnVersion returns 'ok' when installed >= MIN_NTN_VERSION", () => {
    execFileSyncMock.mockReturnValue(`ntn ${MIN_NTN_VERSION}\n`)
    expect(checkNtnVersion()).toBe("ok")
  })

  it("checkNtnVersion returns 'ok' when installed > MIN_NTN_VERSION", () => {
    execFileSyncMock.mockReturnValue("ntn 1.0.0\n")
    expect(checkNtnVersion()).toBe("ok")
  })

  it("checkNtnVersion returns 'too-old' when installed < MIN_NTN_VERSION", () => {
    execFileSyncMock.mockReturnValue("ntn 0.11.5\n")
    expect(checkNtnVersion()).toBe("too-old")
  })

  it("checkNtnVersion returns 'unknown' when ntn is not installed", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("ENOENT")
    })
    expect(checkNtnVersion()).toBe("unknown")
  })

  it("checkNtnVersion returns 'unknown' on unparseable version output", () => {
    execFileSyncMock.mockReturnValue("notion CLI\n")
    expect(checkNtnVersion()).toBe("unknown")
  })

  // Internal `compareSemver` helper invariants exercised through the
  // public `checkNtnVersion` surface above. The acceptance-criterion
  // assertions about literal -1/0/1 ordering are verified through the
  // ok/too-old/unknown three-way mapping; a dedicated test on the
  // private helper would over-couple the test surface to the module's
  // file shape.
})

/**
 * Build a minimal EventEmitter-backed fake child whose `on("error",
 * ...)` and `on("exit", ...)` handler-registration matches the
 * production code path, and expose `triggerExit` / `triggerError` so
 * the test can drive the resolution synchronously.
 */
function makeFakeChild(): EventEmitter & {
  triggerExit: (code: number | null) => void
  triggerError: (err: unknown) => void
} {
  const emitter = new EventEmitter() as EventEmitter & {
    triggerExit: (code: number | null) => void
    triggerError: (err: unknown) => void
  }
  emitter.triggerExit = (code) => emitter.emit("exit", code)
  emitter.triggerError = (err) => emitter.emit("error", err)
  return emitter
}

describe("runNtnLogin", () => {
  it("resolves to { kind: 'success' } on exit code 0", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const promise = runNtnLogin()
    child.triggerExit(0)
    expect(await promise).toEqual({ kind: "success" })
  })

  it("resolves to { kind: 'exit-non-zero', code: N } on non-zero exit", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const promise = runNtnLogin()
    child.triggerExit(1)
    expect(await promise).toEqual({ kind: "exit-non-zero", code: 1 })
  })

  it("normalizes a null exit code to -1 in the exit-non-zero result", async () => {
    // child_process surfaces null when the child was killed by a
    // signal rather than exiting cleanly. The result type carries a
    // numeric code, so the helper coerces null → -1 (the runbook
    // distinguishes "exit -1 means signal-killed" from "exit > 0
    // means error").
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const promise = runNtnLogin()
    child.triggerExit(null)
    expect(await promise).toEqual({ kind: "exit-non-zero", code: -1 })
  })

  it("resolves to { kind: 'spawn-error' } when the child emits an error event (ENOENT)", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const enoent = new Error("spawn ntn ENOENT") as NodeJS.ErrnoException
    enoent.code = "ENOENT"
    const promise = runNtnLogin()
    child.triggerError(enoent)
    const result = await promise
    expect(result.kind).toBe("spawn-error")
    if (result.kind === "spawn-error") expect(result.error).toBe(enoent)
  })

  it("resolves to { kind: 'spawn-error' } when spawn() itself throws synchronously", async () => {
    const sentinel = new Error("spawn rejected synchronously")
    spawnMock.mockImplementation(() => {
      throw sentinel
    })
    const result = await runNtnLogin()
    expect(result).toEqual({ kind: "spawn-error", error: sentinel })
  })

  it("sets NOTION_KEYRING=0 in the spawn env (load-bearing for Option A)", async () => {
    // Without this, the seamless-onboarding posture collapses back
    // to "engineer must edit shell rc." Pin the env var explicitly.
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const promise = runNtnLogin()
    child.triggerExit(0)
    await promise

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [bin, args, options] = spawnMock.mock.calls[0]! as [
      string,
      string[],
      { env: Record<string, string>; stdio: string; shell: boolean },
    ]
    expect(bin).toBe("ntn")
    expect(args).toEqual(["login"])
    expect(options.env["NOTION_KEYRING"]).toBe("0")
    // Inherits stdio so the operator can interact with ntn's prompts.
    expect(options.stdio).toBe("inherit")
    expect(options.shell).toBe(false)
  })

  it("preserves the rest of process.env alongside the NOTION_KEYRING override", async () => {
    process.env["LORE_NTN_TEST_SENTINEL"] = "passthrough-value"
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const promise = runNtnLogin()
    child.triggerExit(0)
    await promise

    const options = spawnMock.mock.calls[0]![2] as { env: Record<string, string> }
    expect(options.env["LORE_NTN_TEST_SENTINEL"]).toBe("passthrough-value")
    delete process.env["LORE_NTN_TEST_SENTINEL"]
  })
})

describe("installNtn", () => {
  it("resolves to { kind: 'success' } on exit code 0", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const promise = installNtn()
    child.triggerExit(0)
    expect(await promise).toEqual({ kind: "success" })
  })

  it("resolves to { kind: 'exit-non-zero', code: N } on non-zero exit", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const promise = installNtn()
    child.triggerExit(2)
    expect(await promise).toEqual({ kind: "exit-non-zero", code: 2 })
  })

  it("resolves to { kind: 'spawn-error' } on a spawn error event", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const err = new Error("install spawn failed")
    const promise = installNtn()
    child.triggerError(err)
    const result = await promise
    expect(result).toEqual({ kind: "spawn-error", error: err })
  })

  it("invokes spawn with the documented NTN_INSTALL_COMMAND constant verbatim", async () => {
    // No string concatenation, no user-controlled interpolation. The
    // command is a hardcoded constant; this test is the regression
    // gate against any future contributor wiring user input into the
    // shell composition.
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const promise = installNtn()
    child.triggerExit(0)
    await promise

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [cmd, options] = spawnMock.mock.calls[0]! as [
      string,
      { env: Record<string, string>; stdio: string; shell: boolean },
    ]
    expect(cmd).toBe(NTN_INSTALL_COMMAND)
    expect(NTN_INSTALL_COMMAND).toBe("curl -fsSL https://ntn.dev | bash")
    expect(options.shell).toBe(true)
    expect(options.stdio).toBe("inherit")
  })

  it("sets NOTION_KEYRING=0 in the spawn env (parity / defense-in-depth)", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const promise = installNtn()
    child.triggerExit(0)
    await promise

    const options = spawnMock.mock.calls[0]![1] as { env: Record<string, string> }
    expect(options.env["NOTION_KEYRING"]).toBe("0")
  })
})
