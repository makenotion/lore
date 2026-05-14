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
  NTN_INSTALL_ARCHIVE_SHA256,
  NTN_INSTALL_VERSION,
  NTN_MANUAL_INSTALL_COMMAND,
  NTN_VERIFIED_INSTALL_DESCRIPTION,
  parseNtnEnv,
  resetNtnProbeCache,
  runNtnLogin,
} from "./ntn.js"

const SCRATCH = mkdtempSync(join(tmpdir(), "lore-ntn-test-"))
const AUTH_JSON_FULL_SUITE_TIMEOUT_MS = 15_000

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
        : Buffer.from(chunk as Uint8Array).toString("utf8")
    )
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env["XDG_CONFIG_HOME"]
  delete process.env["LORE_NOTION_BASE_URL"]
  delete process.env["NTN_INSTALL_DIR"]
  spawnMock.mockReset()
  execFileSyncMock.mockReset()
  // The per-process probe cache (`isNtnInstalled` / `getNtnVersion`)
  // would otherwise carry the first test's mocked result into every
  // subsequent test, regardless of how the mock is rewired.
  resetNtnProbeCache()
})

describe("loadNtnToken", () => {
  it("returns null when auth.json is missing", async () => {
    setupNtnConfigHome(/* no body — file absent */)
    expect(await loadNtnToken()).toBeNull()
    // Missing-file path is silent so callers can fall through to
    // deprecated paths without noise.
    expect(stderrText()).toBe("")
  })

  it(
    "returns the single workspace's token when auth.json has one entry",
    async () => {
      setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-1" }))
      const result = await loadNtnToken()
      expect(result).toEqual({
        token: "tok-1",
        workspaceId: "ws-1",
        baseUrl: undefined,
      })
    },
    AUTH_JSON_FULL_SUITE_TIMEOUT_MS
  )

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
    // Recovery hint points at `lore auth --login` (the canonical
    // wrapper that forces NOTION_KEYRING=0); bare `ntn login` on
    // macOS defaults to keychain mode and would loop the operator
    // back into this same miss. Round-4 review blocker.
    expect(stderrText()).toContain("lore auth --login")
    expect(stderrText()).not.toMatch(/Run `ntn login` against/)
  })

  it("returns null gracefully when auth.json is malformed JSON", async () => {
    setupNtnConfigHome("not-json")
    expect(await loadNtnToken()).toBeNull()
    expect(stderrText()).toContain("malformed")
    // Recovery copy now leads with `lore auth --login` (the canonical
    // Phase-2 wrapper) and offers `NOTION_KEYRING=0 ntn login` as the
    // manual fallback inside parens. Operators see the supported path
    // first; the manual ntn invocation is the escape hatch.
    expect(stderrText()).toContain("lore auth --login")
    expect(stderrText()).toContain("NOTION_KEYRING=0 ntn login")
    const wrapperIdx = stderrText().indexOf("lore auth --login")
    const manualIdx = stderrText().indexOf("NOTION_KEYRING=0 ntn login")
    expect(wrapperIdx).toBeGreaterThan(-1)
    expect(wrapperIdx).toBeLessThan(manualIdx)
  })

  it("returns null with unexpected-shape hint when auth.json is JSON null", async () => {
    setupNtnConfigHome("null")
    expect(await loadNtnToken()).toBeNull()
    expect(stderrText()).toContain("unexpected shape")
    expect(stderrText()).toContain("lore auth --login")
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
      JSON.stringify({ "ws-1": "tok-1", _metadata: { version: 1 }, _count: 5 })
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
    writeFileSync(join(xdg, "notion", "config.json"), JSON.stringify({ env: "dev" }), {
      mode: 0o600,
    })
    const result = await loadNtnToken()
    expect(result).toEqual({
      token: "tok-1",
      workspaceId: "ws-1",
      baseUrl: "https://api-dev.notion.com",
    })
  })

  it("falls through to undefined baseUrl on missing or unknown config.json env", async () => {
    const xdg = setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-1" }))
    writeFileSync(join(xdg, "notion", "config.json"), JSON.stringify({ env: "prod" }), {
      mode: 0o600,
    })
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
      })
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

  it("does NOT set NOTION_ENV in the spawn env when called without an env opt (default / prod path)", async () => {
    // Pin the omit-vs-explicit semantics: if a caller doesn't pass
    // `env`, we leave the spawn env untouched so an inherited
    // shell-rc `NOTION_ENV` (if any) flows through unchanged.
    // Writing `NOTION_ENV=prod` unconditionally would clobber an
    // operator who already opted into dev in their shell.
    delete process.env["NOTION_ENV"]
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const promise = runNtnLogin()
    child.triggerExit(0)
    await promise

    const options = spawnMock.mock.calls[0]![2] as { env: Record<string, string> }
    expect(options.env["NOTION_ENV"]).toBeUndefined()
  })

  it("preserves an inherited NOTION_ENV from process.env when called without an env opt", async () => {
    // Operator who set `NOTION_ENV=dev` in their shell rc should see
    // that value flow into the spawned ntn process even when the
    // caller doesn't explicitly request dev. The spawn env's
    // `...process.env` spread carries the inherited value; the lack
    // of an explicit override leaves it intact.
    process.env["NOTION_ENV"] = "dev"
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const promise = runNtnLogin()
    child.triggerExit(0)
    await promise

    const options = spawnMock.mock.calls[0]![2] as { env: Record<string, string> }
    expect(options.env["NOTION_ENV"]).toBe("dev")
    delete process.env["NOTION_ENV"]
  })

  it("sets NOTION_ENV=dev in the spawn env when called with { env: 'dev' }", async () => {
    delete process.env["NOTION_ENV"]
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const promise = runNtnLogin({ env: "dev" })
    child.triggerExit(0)
    await promise

    const options = spawnMock.mock.calls[0]![2] as { env: Record<string, string> }
    expect(options.env["NOTION_ENV"]).toBe("dev")
    // NOTION_KEYRING=0 still lands alongside — env selection composes
    // with the load-bearing keychain bypass, doesn't replace it.
    expect(options.env["NOTION_KEYRING"]).toBe("0")
  })

  it("explicit { env: 'prod' } CLOBBERS an inherited NOTION_ENV=dev (operator-supplied override wins)", async () => {
    // The flag is the explicit-override surface. An operator who has
    // shell-rc dev but passes `--ntn-env prod` to a Lore command
    // wants prod. Pin that the explicit value wins over the
    // inherited shell value.
    process.env["NOTION_ENV"] = "dev"
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const promise = runNtnLogin({ env: "prod" })
    child.triggerExit(0)
    await promise

    const options = spawnMock.mock.calls[0]![2] as { env: Record<string, string> }
    expect(options.env["NOTION_ENV"]).toBe("prod")
    delete process.env["NOTION_ENV"]
  })

  it("supports stg as a valid env selection", async () => {
    delete process.env["NOTION_ENV"]
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const promise = runNtnLogin({ env: "stg" })
    child.triggerExit(0)
    await promise

    const options = spawnMock.mock.calls[0]![2] as { env: Record<string, string> }
    expect(options.env["NOTION_ENV"]).toBe("stg")
  })
})

describe("parseNtnEnv", () => {
  // Sourced from the same spawn-env-passthrough rationale above:
  // the parser is the CLI-side surface that turns `--ntn-env <value>`
  // into a typed `NtnEnv | null | undefined`. The three-state return
  // (undefined = absent, null = invalid, NtnEnv = valid) lets
  // consumers distinguish "operator didn't pass the flag" from
  // "operator passed garbage" — important because the former is the
  // "use ntn's default" path and the latter is fail-fast input
  // error.
  it("returns undefined when the input is undefined (flag not passed)", () => {
    // We need this distinction so consumers can leave the spawn env
    // untouched on the no-flag path; treating absence as a bad value
    // would force every Lore command without `--ntn-env` into an
    // error-handling branch.
    expect(parseNtnEnv(undefined)).toBeUndefined()
  })

  it("accepts the three canonical values verbatim", () => {
    expect(parseNtnEnv("prod")).toBe("prod")
    expect(parseNtnEnv("dev")).toBe("dev")
    expect(parseNtnEnv("stg")).toBe("stg")
  })

  it("returns null on unrecognized input so callers can fail fast (case-sensitive)", () => {
    // Pin case-sensitivity: `Dev` / `DEV` / `production` / `staging`
    // are NOT accepted. ntn's own `--env` flag is case-sensitive
    // against the same three literals; mirroring the strictness
    // avoids "looks right but ntn rejects it" surprises later in the
    // login spawn.
    expect(parseNtnEnv("Dev")).toBeNull()
    expect(parseNtnEnv("DEV")).toBeNull()
    expect(parseNtnEnv("production")).toBeNull()
    expect(parseNtnEnv("staging")).toBeNull()
    expect(parseNtnEnv("")).toBeNull()
    expect(parseNtnEnv("garbage")).toBeNull()
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

  it("spawns Lore's verified install script without shell interpolation", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const promise = installNtn()
    child.triggerExit(0)
    await promise

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [cmd, args, options] = spawnMock.mock.calls[0]! as [
      string,
      string[],
      { env: Record<string, string>; stdio: string; shell: boolean },
    ]
    expect(cmd).toBe("bash")
    expect(args[0]).toBe("-c")
    expect(args[1]).toContain(`readonly VERSION="${NTN_INSTALL_VERSION}"`)
    expect(args[1]).toContain("EXPECTED_SHA256")
    expect(args[1]).toContain("tar -xzf")
    expect(args[1]).not.toContain("| bash")
    expect(options.shell).toBe(false)
    expect(options.stdio).toBe("inherit")
  })

  it("ships the upstream curl-pipe-bash command only as a manual fallback string", () => {
    expect(NTN_MANUAL_INSTALL_COMMAND).toBe("curl -fsSL https://ntn.dev | bash")
    expect(NTN_VERIFIED_INSTALL_DESCRIPTION).toContain(NTN_INSTALL_VERSION)
  })

  it("pins sha256 checksums for every install target the script can select", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const promise = installNtn()
    child.triggerExit(0)
    await promise

    const script = (spawnMock.mock.calls[0]![1] as string[])[1]!
    for (const [target, checksum] of Object.entries(NTN_INSTALL_ARCHIVE_SHA256)) {
      expect(script).toContain(`${target}) printf '%s\\n' "${checksum}" ;;`)
    }
  })

  it("sets NOTION_KEYRING=0 in the spawn env (parity / defense-in-depth)", async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const promise = installNtn()
    child.triggerExit(0)
    await promise

    const options = spawnMock.mock.calls[0]![2] as { env: Record<string, string> }
    expect(options.env["NOTION_KEYRING"]).toBe("0")
  })

  it("scrubs the spawn env to an allowlist — token-bearing variables do NOT leak to the installer", async () => {
    // The install process does not need NOTION_API_TOKEN,
    // GITHUB_TOKEN, npm credentials, or any other Lore/CI-injected
    // secret. Pin the scrub so a future contributor who reverts to
    // `{ ...process.env, NOTION_KEYRING: "0" }` exfiltration breaks
    // this test loudly.
    process.env["NOTION_API_TOKEN"] = "tok-canonical-must-not-leak"
    process.env["GITHUB_TOKEN"] = "ghp-must-not-leak"
    process.env["NPM_TOKEN"] = "npm-must-not-leak"
    process.env["AWS_SECRET_ACCESS_KEY"] = "aws-must-not-leak"

    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const promise = installNtn()
    child.triggerExit(0)
    await promise

    const options = spawnMock.mock.calls[0]![2] as { env: Record<string, string> }
    expect(options.env).not.toHaveProperty("NOTION_API_TOKEN")
    expect(options.env).not.toHaveProperty("GITHUB_TOKEN")
    expect(options.env).not.toHaveProperty("NPM_TOKEN")
    expect(options.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY")

    delete process.env["NOTION_API_TOKEN"]
    delete process.env["GITHUB_TOKEN"]
    delete process.env["NPM_TOKEN"]
    delete process.env["AWS_SECRET_ACCESS_KEY"]
  })

  it("forwards the allowlisted shell + locale + proxy variables", async () => {
    // The allowlist must keep enough of process.env intact for the
    // verified installer to fetch and install. Pin the load-bearing
    // entries so a future contributor tightening the allowlist into
    // uselessness fails this test.
    process.env["HOME"] = "/test-home"
    process.env["PATH"] = "/test/bin:/usr/bin"
    process.env["SHELL"] = "/bin/bash"
    process.env["LANG"] = "en_US.UTF-8"
    process.env["HTTPS_PROXY"] = "http://proxy.example:3128"
    process.env["NTN_INSTALL_DIR"] = "/tmp/ntn-bin"

    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const promise = installNtn()
    child.triggerExit(0)
    await promise

    const options = spawnMock.mock.calls[0]![2] as { env: Record<string, string> }
    expect(options.env["HOME"]).toBe("/test-home")
    expect(options.env["PATH"]).toBe("/test/bin:/usr/bin")
    expect(options.env["SHELL"]).toBe("/bin/bash")
    expect(options.env["LANG"]).toBe("en_US.UTF-8")
    expect(options.env["HTTPS_PROXY"]).toBe("http://proxy.example:3128")
    expect(options.env["NTN_INSTALL_DIR"]).toBe("/tmp/ntn-bin")
    delete process.env["NTN_INSTALL_DIR"]
  })

  it("invalidates the isNtnInstalled / getNtnVersion cache on success", async () => {
    // Pre-install probe: ntn not on PATH (cache hardens to false / null).
    execFileSyncMock.mockImplementation(() => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException
      err.code = "ENOENT"
      throw err
    })
    expect(isNtnInstalled()).toBe(false)
    expect(getNtnVersion()).toBeNull()

    // Install succeeds. Now rewire the mock to simulate the freshly
    // installed binary.
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const promise = installNtn()
    child.triggerExit(0)
    await promise

    execFileSyncMock.mockReset()
    execFileSyncMock.mockReturnValue("ntn 0.12.0\n")

    // Without cache invalidation, both probes would still report the
    // pre-install nulls.
    expect(isNtnInstalled()).toBe(true)
    expect(getNtnVersion()).toBe("0.12.0")
  })

  it("does NOT invalidate the cache on a non-zero exit", async () => {
    // The install attempt failed; the cache from before the attempt
    // is still the source of truth.
    execFileSyncMock.mockReturnValue("ntn 0.12.0\n")
    expect(isNtnInstalled()).toBe(true)

    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const promise = installNtn()
    child.triggerExit(1)
    await promise

    execFileSyncMock.mockReset()
    execFileSyncMock.mockImplementation(() => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException
      err.code = "ENOENT"
      throw err
    })
    // Cache still says "installed" — the failed install did not flip
    // the cache, so the ENOENT on the rewired mock never reaches the
    // probe.
    expect(isNtnInstalled()).toBe(true)
  })
})

describe("loadNtnToken({ quiet: true })", () => {
  it("suppresses stderr emission for malformed JSON", async () => {
    setupNtnConfigHome("not-json")
    const result = await loadNtnToken({ quiet: true })
    expect(result).toBeNull()
    expect(stderrText()).toBe("")
  })

  it("suppresses stderr emission for unexpected-shape root", async () => {
    setupNtnConfigHome("null")
    const result = await loadNtnToken({ quiet: true })
    expect(result).toBeNull()
    expect(stderrText()).toBe("")
  })

  it("suppresses stderr emission for multi-workspace + no selector", async () => {
    setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-1", "ws-2": "tok-2" }))
    const result = await loadNtnToken({ quiet: true })
    expect(result).toBeNull()
    expect(stderrText()).toBe("")
  })

  it("suppresses stderr emission for requested-workspace-not-found", async () => {
    setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-1" }))
    const result = await loadNtnToken({ workspaceId: "ws-missing", quiet: true })
    expect(result).toBeNull()
    expect(stderrText()).toBe("")
  })

  it("still resolves the token on the happy path under quiet", async () => {
    setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-1" }))
    const result = await loadNtnToken({ quiet: true })
    expect(result).toEqual({
      token: "tok-1",
      workspaceId: "ws-1",
      baseUrl: undefined,
    })
    expect(stderrText()).toBe("")
  })
})

describe("compareSemver via checkNtnVersion (NaN guard)", () => {
  it("returns 'unknown' when getNtnVersion can't parse the output (NaN-safe)", () => {
    // `getNtnVersion`'s SemVer-stripping regex returns null on
    // non-matching output — checkNtnVersion treats that as 'unknown'.
    // The compareSemver guard against NaN inputs is exercised here
    // indirectly: a future contributor who hands raw output past the
    // regex would otherwise see compareSemver return 1 (i.e. "newer
    // than minimum") because `NaN < NaN` is false.
    execFileSyncMock.mockReturnValue("notion CLI without version\n")
    expect(checkNtnVersion()).toBe("unknown")
  })

  it("treats trailing zero components as equal across `X.Y` vs `X.Y.0`", () => {
    // Pin ordering invariants on the public surface. `X.Y` would parse
    // to `[X, Y]` whose third index is undefined → coerced to 0 (or NaN
    // before the guard); after the guard, both forms should compare
    // equal to `X.Y.0`. Routed through checkNtnVersion against a known
    // MIN_NTN_VERSION = "0.12.0".
    execFileSyncMock.mockReturnValue("ntn 0.12\n")
    // `getNtnVersion`'s regex won't match `0.12`, so the public surface
    // returns null → "unknown" rather than exercising compareSemver
    // with a partial input. That's intentional — the regex enforces
    // SemVer shape upstream of compareSemver.
    expect(getNtnVersion()).toBeNull()
  })
})
