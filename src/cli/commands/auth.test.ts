import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Client } from "@notionhq/client"

// Hoisted mocks for the auth-layer dependencies. The pattern matches
// `src/auth/ntn.test.ts` — hoisting is required because ES modules
// evaluate imports before top-level statements; without it, the
// `./auth.js` import below would resolve `../../auth/ntn.js` to its
// real export before the mock is registered.
//
// `loadNtnToken` is mocked alongside the other ntn helpers because the
// real implementation reads `~/.config/notion/auth.json` from disk;
// any Notion-internal dev box that ran `ntn login` for other tooling
// has the file populated, which would non-deterministically resolve
// the ntn-auth-json source mid-test. The hoisted mock makes
// `resolveAuth`'s priority chain deterministic regardless of host
// environment.
const ntnMocks = vi.hoisted(() => ({
  isNtnInstalled: vi.fn<() => boolean>(),
  installNtn: vi.fn(),
  runNtnLogin: vi.fn(),
  checkNtnVersion: vi.fn<() => "unknown" | "too-old" | "ok">(),
  getNtnVersion: vi.fn<() => string | null>(),
  listNtnWorkspaces: vi.fn<() => Promise<string[]>>(),
  loadNtnToken: vi.fn(),
  resetNtnProbeCache: vi.fn(),
}))

vi.mock("../../auth/ntn.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../auth/ntn.js")>("../../auth/ntn.js")
  return {
    ...actual,
    isNtnInstalled: ntnMocks.isNtnInstalled,
    installNtn: ntnMocks.installNtn,
    runNtnLogin: ntnMocks.runNtnLogin,
    checkNtnVersion: ntnMocks.checkNtnVersion,
    getNtnVersion: ntnMocks.getNtnVersion,
    listNtnWorkspaces: ntnMocks.listNtnWorkspaces,
    loadNtnToken: ntnMocks.loadNtnToken,
    resetNtnProbeCache: ntnMocks.resetNtnProbeCache,
  }
})

const verifyVaultAccessMock = vi.hoisted(() => vi.fn())
vi.mock("../../auth/oauth.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../auth/oauth.js")>("../../auth/oauth.js")
  return { ...actual, verifyVaultAccess: verifyVaultAccessMock }
})

// Stub createClient + createLimitedClient so resolveAuth's ntn-resolved
// client never reaches a real Notion endpoint. The stub returns the
// same instance through createLimitedClient so tests can pre-stash a
// `users.me` mock on it before runWhoami runs. The `createClient`
// spy is exposed on the holder so tests can assert what token /
// baseUrl pair the post-login preflight constructed (round-6 coverage
// gap on the ntn-auth-json + config-derived dev baseUrl path).
const fakeClientHolder = vi.hoisted(() => {
  const client = { users: { me: vi.fn() } } as unknown as Client
  const createClient = vi.fn(() => client)
  return { client, createClient }
})
vi.mock("../../notion/client.js", async () => {
  const actual = await vi.importActual<typeof import("../../notion/client.js")>(
    "../../notion/client.js"
  )
  return { ...actual, createClient: fakeClientHolder.createClient }
})
vi.mock("../../notion/rate-limit.js", async () => {
  const actual = await vi.importActual<typeof import("../../notion/rate-limit.js")>(
    "../../notion/rate-limit.js"
  )
  return {
    ...actual,
    createLimitedClient: vi.fn((c: Client) => c),
  }
})

// Drive the interactive prompt's answer from tests. Default empty
// string ⇒ Enter (which respects the helper's `defaultYes`). Override
// via `readlineHolder.answer = "n"` (or "y") to simulate explicit
// answers. Also captures the rendered question so tests can verify
// the [Y/n] / [y/N] suffix.
const readlineHolder = vi.hoisted(() => ({
  answer: "",
  lastQuestion: "" as string,
}))
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: vi.fn().mockImplementation(async (q: string) => {
      readlineHolder.lastQuestion = q
      return readlineHolder.answer
    }),
    close: vi.fn(),
  }),
}))

import {
  authCommand,
  confirmPrompt,
  pickAuthAction,
  printAuthSourceLines,
  renderWhoamiIdentity,
  runLogin,
  runLogout,
  runStatus,
  runWhoami,
} from "./auth.js"
import { MIN_NTN_VERSION } from "../../auth/ntn.js"
import type { ResolvedAuth } from "../../config.js"

const SCRATCH = mkdtempSync(join(tmpdir(), "lore-auth-cli-test-"))
afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

// Track every scratch dir created in a test so afterEach can clean
// them up. Without this, SCRATCH accumulates ~30 subdirectories per
// run — cosmetic, but the tighter footprint helps debugging.
const scratchDirsToClean: string[] = []

/**
 * Set up a scratch project directory containing a `.lore.yaml` with a
 * minimal vault config, and chdir into it. Returns the directory path
 * so tests can pin assertions against the resolved config path.
 *
 * The cwd switch is undone in afterEach so an early-failing test
 * doesn't leak a stale cwd into the next case.
 */
function setupVaultProject(opts: { authToken?: string } = {}): string {
  const dir = mkdtempSync(join(SCRATCH, "vault-"))
  const yaml =
    `vault:\n  pageId: page-${Math.random().toString(36).slice(2, 10)}\n` +
    (opts.authToken ? `auth:\n  token: ${opts.authToken}\n` : "")
  writeFileSync(join(dir, ".lore.yaml"), yaml, "utf-8")
  scratchDirsToClean.push(dir)
  process.chdir(dir)
  return dir
}

/** Set up a no-vault-context scratch dir and chdir into it. */
function setupNoVaultContext(): string {
  const dir = mkdtempSync(join(SCRATCH, "no-vault-"))
  scratchDirsToClean.push(dir)
  process.chdir(dir)
  return dir
}

let stdoutLines: string[] = []
let stderrLines: string[] = []
const stdoutText = (): string => stdoutLines.join("")
const stderrText = (): string => stderrLines.join("")

const ORIGINAL_CWD = process.cwd()

// Capture the descriptor for `process.stdin.isTTY` once so afterEach
// can restore it. Several tests `Object.defineProperty(process.stdin,
// "isTTY", { value: ... })` to drive the TTY-gated branches; without
// this restore, an isTTY override from one test leaks into the next
// and subtle order-dependence creeps in.
const ORIGINAL_ISTTY_DESCRIPTOR = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")

function restoreIsTTY(): void {
  if (ORIGINAL_ISTTY_DESCRIPTOR) {
    Object.defineProperty(process.stdin, "isTTY", ORIGINAL_ISTTY_DESCRIPTOR)
  } else {
    // Property wasn't an own property originally — drop the override
    // so the prototype getter takes over again.
    delete (process.stdin as { isTTY?: boolean }).isTTY
  }
}

beforeEach(() => {
  stdoutLines = []
  stderrLines = []
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdoutLines.push(args.map(String).join(" ") + "\n")
  })
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderrLines.push(args.map(String).join(" ") + "\n")
  })
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    stderrLines.push(args.map(String).join(" ") + "\n")
  })
  ntnMocks.isNtnInstalled.mockReset()
  ntnMocks.installNtn.mockReset()
  ntnMocks.runNtnLogin.mockReset()
  ntnMocks.checkNtnVersion.mockReset()
  ntnMocks.getNtnVersion.mockReset()
  ntnMocks.listNtnWorkspaces.mockReset().mockResolvedValue([])
  ntnMocks.loadNtnToken.mockReset().mockResolvedValue(null)
  ntnMocks.resetNtnProbeCache.mockReset()
  verifyVaultAccessMock.mockReset()
  ;(fakeClientHolder.client.users.me as unknown as ReturnType<typeof vi.fn>).mockReset()
  // Reset createClient spy and re-arm with the default factory so per-test
  // call counts are clean, but the same `client` is still returned (tests
  // that assert on `users.me` calls keep working).
  fakeClientHolder.createClient.mockReset()
  fakeClientHolder.createClient.mockImplementation(() => fakeClientHolder.client)
  readlineHolder.answer = ""
  readlineHolder.lastQuestion = ""

  // Default: ntn appears installed at MIN_NTN_VERSION so tests don't
  // have to pre-set the probe result for happy paths.
  ntnMocks.isNtnInstalled.mockReturnValue(true)
  ntnMocks.checkNtnVersion.mockReturnValue("ok")
  ntnMocks.getNtnVersion.mockReturnValue(MIN_NTN_VERSION)
})

afterEach(() => {
  vi.restoreAllMocks()
  process.chdir(ORIGINAL_CWD)
  // Wipe any token env vars the priority chain consults.
  delete process.env["NOTION_API_TOKEN"]
  delete process.env["NOTION_WORKSPACE_ID"]
  delete process.env["NOTION_ENV"]
  delete process.env["LORE_NOTION_BASE_URL"]
  delete process.env["LORE_SUPPRESS_DEPRECATIONS"]
  delete process.env["XDG_CONFIG_HOME"]
  restoreIsTTY()
  // Drop scratch dirs created by this test so SCRATCH stays small.
  while (scratchDirsToClean.length > 0) {
    rmSync(scratchDirsToClean.pop()!, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// pickAuthAction
// ---------------------------------------------------------------------------

describe("pickAuthAction", () => {
  it("defaults to --status when no flag is set", () => {
    expect(pickAuthAction({})).toEqual({ action: "status", ignored: [] })
  })

  it("dispatches each single flag to its action", () => {
    expect(pickAuthAction({ status: true })).toEqual({
      action: "status",
      ignored: [],
    })
    expect(pickAuthAction({ login: true })).toEqual({
      action: "login",
      ignored: [],
    })
    expect(pickAuthAction({ whoami: true })).toEqual({
      action: "whoami",
      ignored: [],
    })
    expect(pickAuthAction({ logout: true })).toEqual({
      action: "logout",
      ignored: [],
    })
  })

  it("follows the documented precedence ladder when multiple flags are passed", () => {
    // --login > --logout > --whoami > --status. The lower-precedence
    // flags appear in `ignored` so the caller can name them in a
    // stderr warning.
    expect(
      pickAuthAction({
        status: true,
        login: true,
        whoami: true,
        logout: true,
      })
    ).toEqual({
      action: "login",
      ignored: ["--logout", "--whoami", "--status"],
    })
    expect(pickAuthAction({ logout: true, whoami: true })).toEqual({
      action: "logout",
      ignored: ["--whoami"],
    })
  })
})

// ---------------------------------------------------------------------------
// printAuthSourceLines
// ---------------------------------------------------------------------------

describe("printAuthSourceLines", () => {
  it("prints the not-authenticated banner when auth is undefined", () => {
    printAuthSourceLines(undefined)
    expect(stdoutText()).toContain("Status: not authenticated")
  })

  it("prints NOTION_API_TOKEN source + active status", () => {
    const auth: ResolvedAuth = {
      token: "tok",
      source: "env-notion-api-token",
    }
    printAuthSourceLines(auth)
    expect(stdoutText()).toContain("Source: NOTION_API_TOKEN (env)")
    expect(stdoutText()).toContain("Status: ✓ active")
  })

  it("prints ntn-auth-json source + workspace + active status", () => {
    const auth: ResolvedAuth = {
      token: "tok",
      source: "ntn-auth-json",
      workspaceId: "ws-1",
    }
    printAuthSourceLines(auth)
    expect(stdoutText()).toContain("Source: ntn (auth.json)")
    expect(stdoutText()).toContain("Workspace: ws-1")
    expect(stdoutText()).toContain("Status: ✓ active")
  })
})

// ---------------------------------------------------------------------------
// runStatus
// ---------------------------------------------------------------------------

describe("runStatus — no vault context", () => {
  it("prints the no-vault-context banner and not-authenticated when no token resolves", async () => {
    setupNoVaultContext()
    await runStatus()
    expect(stdoutText()).toContain("Lore auth status (no vault context)")
    expect(stdoutText()).toContain("Status: not authenticated")
  })

  it("surfaces the ntn-not-installed hint when ntn is missing AND no token resolves", async () => {
    setupNoVaultContext()
    ntnMocks.isNtnInstalled.mockReturnValue(false)
    await runStatus()
    expect(stdoutText()).toContain("ntn` does not appear to be installed")
    expect(stdoutText()).toContain("docs/team-rollout.md")
  })

  it("lists ntn workspaces when listNtnWorkspaces returns any", async () => {
    setupNoVaultContext()
    ntnMocks.listNtnWorkspaces.mockResolvedValue(["ws-1", "ws-2"])
    await runStatus()
    expect(stdoutText()).toContain("ntn workspaces with tokens: 2")
    expect(stdoutText()).toContain("ws-1, ws-2")
  })

  it("does not list workspaces when listNtnWorkspaces returns empty", async () => {
    setupNoVaultContext()
    ntnMocks.listNtnWorkspaces.mockResolvedValue([])
    await runStatus()
    expect(stdoutText()).not.toContain("ntn workspaces with tokens")
  })
})

describe("runStatus — vault context", () => {
  it("prints NOTION_API_TOKEN source on the env path and runs preflight", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok-canonical"
    verifyVaultAccessMock.mockResolvedValue({
      kind: "ok",
      pageTitle: "My Vault",
    })
    await runStatus()
    expect(stdoutText()).toContain("Source: NOTION_API_TOKEN (env)")
    expect(stdoutText()).toContain("✓ Vault page accessible: My Vault")
    expect(verifyVaultAccessMock).toHaveBeenCalledTimes(1)
  })

  it("surfaces PAT preflight not-found with PAT workspace and page-access recovery", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    verifyVaultAccessMock.mockResolvedValue({
      kind: "not-found",
      pageId: "abc",
      message: "Vault page not accessible. The resolved token cannot read this page.",
    })
    await runStatus()
    expect(stdoutText()).toContain("✗ Vault page NOT accessible")
    expect(stdoutText()).toContain("NOTION_API_TOKEN / PAT")
    expect(stdoutText()).toContain("notion.so/developers/tokens")
    expect(stdoutText()).toContain("PAT's owning Notion identity")
    expect(stdoutText()).toContain("Export the PAT as NOTION_API_TOKEN")
    expect(stdoutText()).not.toContain("lore auth --login")
  })

  it("surfaces integration-token warning before PAT-source not-found recovery", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "secret_integration-bearer"
    verifyVaultAccessMock.mockResolvedValue({
      kind: "not-found",
      pageId: "abc",
      message: "Vault page not accessible. The resolved token cannot read this page.",
    })
    await runStatus()
    const out = stdoutText()
    const secretIndex = out.indexOf("secret_…")
    expect(secretIndex).toBeGreaterThanOrEqual(0)
    expect(secretIndex).toBeLessThan(
      out.indexOf("Recommended for NOTION_API_TOKEN / PAT")
    )
    expect(secretIndex).toBeLessThan(out.indexOf("Confirm the PAT was created"))
    expect(out).not.toContain("    4.")
  })

  it("surfaces preflight unknown-error message AND transient hint", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    verifyVaultAccessMock.mockResolvedValue({
      kind: "unknown-error",
      pageId: "abc",
      error: new Error("5xx Bad Gateway"),
    })
    await runStatus()
    expect(stdoutText()).toContain("unknown error (transient?)")
    // The underlying error must be surfaced — operators debugging a
    // 5xx need the actual message, not just the transient hint.
    expect(stdoutText()).toContain("5xx Bad Gateway")
  })

  it("surfaces PAT preflight unauthorized with PAT rotation/export recovery", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    verifyVaultAccessMock.mockResolvedValue({
      kind: "unauthorized",
      pageId: "abc",
      message:
        "Notion rejected the bearer token. The token is invalid, expired, or revoked.",
    })
    await runStatus()
    expect(stdoutText()).toContain("✗ Vault preflight: token rejected (unauthorized)")
    expect(stdoutText()).toContain("invalid, expired, or revoked")
    expect(stdoutText()).toContain("NOTION_API_TOKEN / PAT")
    expect(stdoutText()).toContain("Rotate the PAT")
    expect(stdoutText()).toContain("notion.so/developers/tokens")
    expect(stdoutText()).toContain("PAT's owning Notion identity")
    expect(stdoutText()).toContain("Export the PAT as NOTION_API_TOKEN")
    expect(stdoutText()).not.toContain("lore auth --login")
  })

  it("surfaces integration-token warning on PAT-source unauthorized preflight", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "secret_integration-bearer"
    verifyVaultAccessMock.mockResolvedValue({
      kind: "unauthorized",
      pageId: "abc",
      message:
        "Notion rejected the bearer token. The token is invalid, expired, or revoked.",
    })
    await runStatus()
    const out = stdoutText()
    const secretIndex = out.indexOf("secret_…")
    expect(secretIndex).toBeGreaterThanOrEqual(0)
    expect(secretIndex).toBeLessThan(
      out.indexOf("Recommended for NOTION_API_TOKEN / PAT")
    )
    expect(secretIndex).toBeLessThan(out.indexOf("Rotate the PAT"))
    expect(out).toContain("notion.so/profile/integrations")
    expect(out).toContain("notion.so/developers/tokens")
    expect(out).not.toContain("lore auth --login")
    expect(out).not.toContain("    4.")
  })

  it("surfaces ntn preflight unauthorized with ntn re-login recovery", async () => {
    setupVaultProject()
    ntnMocks.loadNtnToken.mockResolvedValue({
      token: "ntn_prod-bearer",
      workspaceId: "ws-1",
      baseUrl: undefined,
    })
    verifyVaultAccessMock.mockResolvedValue({
      kind: "unauthorized",
      pageId: "abc",
      message:
        "Notion rejected the bearer token. The token is invalid, expired, or revoked.",
    })
    await runStatus()
    expect(stdoutText()).toContain("✗ Vault preflight: token rejected (unauthorized)")
    expect(stdoutText()).toContain("Recommended for ntn auth")
    expect(stdoutText()).toContain("lore auth --login")
    expect(stdoutText()).not.toContain("Rotate the PAT")
  })

  it("surfaces preflight rate-limited with wait/retry copy (NOT a re-auth recommendation)", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    verifyVaultAccessMock.mockResolvedValue({
      kind: "rate-limited",
      pageId: "abc",
      message:
        "Notion's API throttled this preflight (429). Wait a few seconds and retry.",
    })
    await runStatus()
    expect(stdoutText()).toContain("⏸ Vault preflight: rate-limited (429)")
    expect(stdoutText()).toContain("throttled")
    expect(stdoutText()).toContain("Wait a few seconds")
    // 429 is transient — re-auth would be misleading and waste the
    // operator's time. Pin against a future revert that lumps it
    // back into `unauthorized`'s copy.
    expect(stdoutText()).not.toContain(
      "Recommended: run `lore auth --login` to issue a fresh token"
    )
  })

  it("prints not-authenticated + ntn-not-installed hint when no token resolves AND ntn is missing", async () => {
    setupVaultProject()
    ntnMocks.isNtnInstalled.mockReturnValue(false)
    // No supported env vars or ntn token — resolveAuth throws.
    await runStatus()
    expect(stdoutText()).toContain("Status: not authenticated")
    expect(stdoutText()).toContain("lore auth --login")
    expect(stdoutText()).toContain("ntn` does not appear to be installed")
  })

  it("preserves resolveAuth's diagnostic message when no token resolves (vault context)", async () => {
    // Stub loadNtnToken to surface the multi-workspace ambiguity that
    // resolveAuth would otherwise hand to the operator. Without this
    // PR's fix, the bare catch swallowed the message and the operator
    // only saw generic login advice.
    setupVaultProject()
    ntnMocks.isNtnInstalled.mockReturnValue(true)
    ntnMocks.listNtnWorkspaces.mockResolvedValue(["ws-1", "ws-2"])
    await runStatus()
    expect(stdoutText()).toContain("Status: not authenticated")
    // resolveAuth's error message names the multi-workspace remediation
    // path; preserve a substring that proves the diagnostic was carried
    // forward rather than silently dropped.
    expect(stdoutText()).toMatch(/NOTION_WORKSPACE_ID|workspaces|specify one/i)
  })
})

// ---------------------------------------------------------------------------
// runLogin
// ---------------------------------------------------------------------------

/**
 * Spy on `process.exit` so an early-exit test can assert without
 * actually killing the test runner. We throw instead of exiting; the
 * caller awaits the rejection to confirm the exit code.
 */
function mockProcessExit(): { calls: number[]; restore: () => void } {
  const calls: number[] = []
  const spy = vi.spyOn(process, "exit").mockImplementation((code) => {
    calls.push(typeof code === "number" ? code : 0)
    throw new Error(`__process_exit_${typeof code === "number" ? code : 0}__`)
  })
  return {
    calls,
    restore: () => spy.mockRestore(),
  }
}

describe("runLogin", () => {
  it("exits 1 with vault-context error when no .lore.yaml is found", async () => {
    setupNoVaultContext()
    const exit = mockProcessExit()
    await expect(runLogin({ yes: false })).rejects.toThrow("__process_exit_1__")
    expect(stderrText()).toContain("requires a vault context")
    expect(exit.calls).toContain(1)
    exit.restore()
  })

  it("auto-installs ntn under --yes when ntn is missing, then proceeds", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    ntnMocks.isNtnInstalled.mockReturnValue(false)
    ntnMocks.installNtn.mockResolvedValue({ kind: "success" })
    ntnMocks.runNtnLogin.mockResolvedValue({ kind: "success" })
    verifyVaultAccessMock.mockResolvedValue({ kind: "ok", pageTitle: "V" })

    await runLogin({ yes: true })

    expect(ntnMocks.installNtn).toHaveBeenCalledTimes(1)
    expect(ntnMocks.runNtnLogin).toHaveBeenCalledTimes(1)
    expect(verifyVaultAccessMock).toHaveBeenCalledTimes(1)
    expect(stdoutText()).toContain("✓ ntn installed")
    expect(stdoutText()).toContain("Authenticated; vault page reachable: V")
  })

  it("aborts with manual-install pointer when interactive prompt declines (TTY + answer 'n')", async () => {
    setupVaultProject()
    ntnMocks.isNtnInstalled.mockReturnValue(false)
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    })
    readlineHolder.answer = "n"
    const exit = mockProcessExit()
    await expect(runLogin({ yes: false })).rejects.toThrow("__process_exit_1__")
    expect(stderrText()).toContain("ntn is required for `lore auth --login`")
    expect(stderrText()).toContain("curl -fsSL https://ntn.dev | bash")
    expect(ntnMocks.installNtn).not.toHaveBeenCalled()
    expect(exit.calls).toContain(1)
    exit.restore()
  })

  it("non-interactive context with ntn missing AND no --yes: exit 1 with --yes hint, no prompt copy on stdout, no install", async () => {
    setupVaultProject()
    ntnMocks.isNtnInstalled.mockReturnValue(false)
    // Force non-TTY so the prompt path bails on its own.
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    })
    const exit = mockProcessExit()
    await expect(runLogin({ yes: false })).rejects.toThrow("__process_exit_1__")
    expect(stderrText()).toContain("non-interactive context")
    expect(stderrText()).toContain("Pass --yes")
    // The prompt-copy MUST NOT have leaked to stdout — that's the
    // bug the TTY-check ordering fix protects against (CI logs that
    // showed the prompt followed by an abort were misleading).
    expect(stdoutText()).not.toContain("Install ntn now?")
    expect(ntnMocks.installNtn).not.toHaveBeenCalled()
    expect(exit.calls).toContain(1)
    exit.restore()
  })

  it("warns non-blocking when ntn version < MIN_NTN_VERSION but proceeds", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    ntnMocks.checkNtnVersion.mockReturnValue("too-old")
    ntnMocks.getNtnVersion.mockReturnValue("0.11.0")
    ntnMocks.runNtnLogin.mockResolvedValue({ kind: "success" })
    verifyVaultAccessMock.mockResolvedValue({ kind: "ok", pageTitle: "V" })

    await runLogin({ yes: true })

    const out = stdoutText()
    expect(out).toContain("0.11.0")
    expect(out).toContain(MIN_NTN_VERSION)
    expect(out).toContain("below Lore's tested minimum")
    expect(ntnMocks.runNtnLogin).toHaveBeenCalledTimes(1)
  })

  it("default behavior: invokes runNtnLogin with no env so ntn picks its config.json default", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    delete process.env["NOTION_ENV"]
    ntnMocks.runNtnLogin.mockResolvedValue({ kind: "success" })
    verifyVaultAccessMock.mockResolvedValue({ kind: "ok", pageTitle: "V" })

    await runLogin({ yes: true })

    expect(ntnMocks.runNtnLogin).toHaveBeenCalledTimes(1)
    // Pin the bare-call so an operator without NOTION_ENV set targets
    // ntn's own default environment.
    expect(ntnMocks.runNtnLogin).toHaveBeenCalledWith({})
    expect(stdoutText()).toContain("Running `NOTION_KEYRING=0 ntn login`...")
    expect(stdoutText()).not.toContain("--env")
  })

  it("threads NOTION_ENV=dev into runNtnLogin so the spawned ntn login uses --env dev", async () => {
    // Engineers on the Notion dev environment can't get there through
    // `lore auth --login` unless this PR threads NOTION_ENV through to
    // ntn — round-4 review blocker. The selection has to be visible in
    // both the spawn argv (asserted via the mock call signature) AND in
    // the operator's stdout (so a CI log shows which env was targeted).
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    process.env["NOTION_ENV"] = "dev"
    ntnMocks.runNtnLogin.mockResolvedValue({ kind: "success" })
    verifyVaultAccessMock.mockResolvedValue({ kind: "ok", pageTitle: "V" })

    await runLogin({ yes: true })

    expect(ntnMocks.runNtnLogin).toHaveBeenCalledWith({ env: "dev" })
    expect(stdoutText()).toContain(
      "Running `NOTION_KEYRING=0 NOTION_ENV=dev ntn login`..."
    )
  })

  it("threads NOTION_ENV=stg through (not just dev) — pin so a future hard-coded `dev` regresses loudly", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    process.env["NOTION_ENV"] = "stg"
    ntnMocks.runNtnLogin.mockResolvedValue({ kind: "success" })
    verifyVaultAccessMock.mockResolvedValue({ kind: "ok", pageTitle: "V" })

    await runLogin({ yes: true })

    expect(ntnMocks.runNtnLogin).toHaveBeenCalledWith({ env: "stg" })
    expect(stdoutText()).toContain(
      "Running `NOTION_KEYRING=0 NOTION_ENV=stg ntn login`..."
    )
  })

  it("infers `--env dev` from .lore.yaml `auth.baseUrl` when shell NOTION_ENV is unset (PnP-style dev project)", async () => {
    // Round-5 review blocker: a PnP-style dev project's local
    // `.lore.yaml` carries `auth.baseUrl: https://api-dev.notion.com`.
    // Without this fix, `lore auth --login` from that project
    // (without shell NOTION_ENV) ran bare `ntn login` (prod) and
    // silently mismatched the operator's vault. Now Lore reads the
    // config baseUrl, infers `dev`, and prints a transparency line
    // so the operator sees which env is being targeted.
    const dir = mkdtempSync(join(SCRATCH, "vault-dev-"))
    scratchDirsToClean.push(dir)
    writeFileSync(
      join(dir, ".lore.yaml"),
      `vault:\n  pageId: page-dev\nauth:\n  baseUrl: https://api-dev.notion.com\n`,
      "utf-8"
    )
    process.chdir(dir)
    process.env["NOTION_API_TOKEN"] = "tok"
    delete process.env["NOTION_ENV"]
    ntnMocks.runNtnLogin.mockResolvedValue({ kind: "success" })
    verifyVaultAccessMock.mockResolvedValue({ kind: "ok", pageTitle: "V" })

    await runLogin({ yes: true })

    expect(ntnMocks.runNtnLogin).toHaveBeenCalledWith({ env: "dev" })
    expect(stdoutText()).toContain(
      "(Inferring `NOTION_ENV=dev` from auth.baseUrl in .lore.yaml.)"
    )
    expect(stdoutText()).toContain(
      "Running `NOTION_KEYRING=0 NOTION_ENV=dev ntn login`..."
    )
  })

  it("shell NOTION_ENV beats config-derived env (operator override wins)", async () => {
    // If the config says dev but the operator explicitly sets
    // NOTION_ENV=stg, the operator wins — they presumably know what
    // they want. The transparency line about config inference must
    // NOT print, since we're not actually inferring.
    const dir = mkdtempSync(join(SCRATCH, "vault-override-"))
    scratchDirsToClean.push(dir)
    writeFileSync(
      join(dir, ".lore.yaml"),
      `vault:\n  pageId: page-x\nauth:\n  baseUrl: https://api-dev.notion.com\n`,
      "utf-8"
    )
    process.chdir(dir)
    process.env["NOTION_API_TOKEN"] = "tok"
    process.env["NOTION_ENV"] = "stg"
    ntnMocks.runNtnLogin.mockResolvedValue({ kind: "success" })
    verifyVaultAccessMock.mockResolvedValue({ kind: "ok", pageTitle: "V" })

    await runLogin({ yes: true })

    expect(ntnMocks.runNtnLogin).toHaveBeenCalledWith({ env: "stg" })
    expect(stdoutText()).toContain(
      "Running `NOTION_KEYRING=0 NOTION_ENV=stg ntn login`..."
    )
    expect(stdoutText()).not.toContain("Inferring `NOTION_ENV=")
  })

  it("config baseUrl that doesn't map to a known env falls through (no --env arg)", async () => {
    // Defense against config-driven env-switching attacks: an
    // arbitrary baseUrl that isn't in the known-env table doesn't
    // get pasted into ntn's argv. ntn defaults to its own
    // config.json (typically prod) — Lore stays out of guessing.
    const dir = mkdtempSync(join(SCRATCH, "vault-unknown-"))
    scratchDirsToClean.push(dir)
    writeFileSync(
      join(dir, ".lore.yaml"),
      `vault:\n  pageId: page-x\nauth:\n  baseUrl: https://internal.team/api\n`,
      "utf-8"
    )
    process.chdir(dir)
    process.env["NOTION_API_TOKEN"] = "tok"
    delete process.env["NOTION_ENV"]
    ntnMocks.runNtnLogin.mockResolvedValue({ kind: "success" })
    verifyVaultAccessMock.mockResolvedValue({ kind: "ok", pageTitle: "V" })

    await runLogin({ yes: true })

    expect(ntnMocks.runNtnLogin).toHaveBeenCalledWith({})
    expect(stdoutText()).toContain("Running `NOTION_KEYRING=0 ntn login`...")
    expect(stdoutText()).not.toContain("Inferring")
  })

  it("PnP-style end-to-end: config-derived dev env, no NOTION_API_TOKEN, post-login resolves ntn-auth-json with dev baseUrl, createClient receives api-dev.notion.com", async () => {
    // Round-6 coverage gap: the config-derived `--env dev` test above
    // sets `NOTION_API_TOKEN` so it short-circuits past the
    // ntn-auth-json branch — proving the spawn selector but NOT the
    // post-login preflight client construction. This pins the full
    // PnP-style flow:
    //
    //   1. .lore.yaml carries `auth.baseUrl: https://api-dev.notion.com`.
    //   2. No NOTION_API_TOKEN, no shell NOTION_ENV.
    //   3. runLogin infers `--env dev` from the config baseUrl and
    //      calls runNtnLogin("dev") — pinned by spy.
    //   4. After login, resolveAuth picks up the ntn-auth-json source
    //      (loadNtnToken returns the dev workspace + dev baseUrl).
    //   5. createClient receives the ntn-resolved dev baseUrl when
    //      constructing the preflight client — the load-bearing piece
    //      the reviewer flagged.
    //   6. verifyVaultAccess returns ok against the constructed client.
    const dir = mkdtempSync(join(SCRATCH, "vault-pnp-style-"))
    scratchDirsToClean.push(dir)
    writeFileSync(
      join(dir, ".lore.yaml"),
      `vault:\n  pageId: page-dev\nauth:\n  baseUrl: https://api-dev.notion.com\n`,
      "utf-8"
    )
    process.chdir(dir)
    delete process.env["NOTION_API_TOKEN"]
    delete process.env["NOTION_ENV"]
    // Post-login auth.json read returns the dev workspace token with
    // ntn's own dev baseUrl — the same shape `loadNtnToken` produces
    // when ntn's `~/.config/notion/config.json` carries `env: "dev"`.
    ntnMocks.loadNtnToken.mockResolvedValue({
      token: "tok-ntn-dev",
      workspaceId: "ws-dev",
      baseUrl: "https://api-dev.notion.com",
    })
    ntnMocks.runNtnLogin.mockResolvedValue({ kind: "success" })
    verifyVaultAccessMock.mockResolvedValue({
      kind: "ok",
      pageTitle: "Test Vault",
    })

    await runLogin({ yes: true })

    // Step 3 — config-derived `--env dev` reaches the spawn.
    expect(ntnMocks.runNtnLogin).toHaveBeenCalledWith({ env: "dev" })
    expect(stdoutText()).toContain(
      "(Inferring `NOTION_ENV=dev` from auth.baseUrl in .lore.yaml.)"
    )
    expect(stdoutText()).toContain(
      "Running `NOTION_KEYRING=0 NOTION_ENV=dev ntn login`..."
    )

    // Step 4 — createClient receives the ntn-resolved (dev) baseUrl.
    // This is the round-6 reviewer's specific ask: prove that the
    // post-login preflight client targets api-dev, not the prod
    // default that bare-args createClient would resolve.
    expect(fakeClientHolder.createClient).toHaveBeenCalledWith(
      "tok-ntn-dev",
      "https://api-dev.notion.com"
    )

    // Step 4 — preflight ran against the constructed client and the
    // operator sees the workspace label confirming the ntn-auth-json
    // path resolved.
    expect(verifyVaultAccessMock).toHaveBeenCalledTimes(1)
    expect(stdoutText()).toContain("✓ Authenticated; vault page reachable: Test Vault")
    expect(stdoutText()).toContain("Workspace: ws-dev")
  })

  it("aborts with retry recommendation on runNtnLogin exit-non-zero", async () => {
    setupVaultProject()
    ntnMocks.runNtnLogin.mockResolvedValue({ kind: "exit-non-zero", code: 7 })
    const exit = mockProcessExit()
    await expect(runLogin({ yes: true })).rejects.toThrow("__process_exit_1__")
    expect(stderrText()).toContain("ntn login did not complete")
    expect(stderrText()).toContain("ntn exited with code 7")
    expect(stderrText()).toContain("Re-run `lore auth --login`")
    exit.restore()
  })

  it("aborts on runNtnLogin spawn-error with a PATH hint and surfaces the underlying error", async () => {
    setupVaultProject()
    ntnMocks.runNtnLogin.mockResolvedValue({
      kind: "spawn-error",
      error: new Error("ENOENT spawn ntn"),
    })
    // ntn was probed-installed at start AND still appears installed
    // on the post-spawn-error re-probe. The fallback path stays on
    // the no-reinstall branch ("Re-run lore auth --login to retry").
    ntnMocks.isNtnInstalled.mockReturnValue(true)
    const exit = mockProcessExit()
    await expect(runLogin({ yes: true })).rejects.toThrow("__process_exit_1__")
    expect(stderrText()).toContain("ntn could not be spawned")
    expect(stderrText()).toContain("ENOENT spawn ntn")
    // Cache reset MUST happen before the re-probe so the live path
    // doesn't return the stale Step-1 cache. The mocked
    // `isNtnInstalled` itself bypasses the cache, but the production
    // code path depends on `resetNtnProbeCache()` running first; pin
    // the call in tests so a future contributor who removes the
    // reset breaks the suite loudly.
    expect(ntnMocks.resetNtnProbeCache).toHaveBeenCalledTimes(1)
    exit.restore()
  })

  it("offers re-install on runNtnLogin spawn-error when ntn is no longer on PATH (--yes)", async () => {
    setupVaultProject()
    ntnMocks.runNtnLogin.mockResolvedValue({
      kind: "spawn-error",
      error: new Error("ENOENT"),
    })
    // First probe (Step 1) returns true; cache reset fires before
    // the spawn-error branch's second probe, which then returns
    // false → re-install offer fires under --yes.
    ntnMocks.isNtnInstalled.mockReturnValueOnce(true).mockReturnValue(false)
    ntnMocks.installNtn.mockResolvedValue({ kind: "success" })
    const exit = mockProcessExit()
    await expect(runLogin({ yes: true })).rejects.toThrow("__process_exit_1__")
    // Acceptance criterion text from Phase-2/06: "handled differently
    // from exit-non-zero; surfaces 'ntn not found on PATH' and offers
    // re-install if appropriate."
    expect(stderrText()).toContain("`ntn` does not appear to be on PATH")
    expect(stderrText()).toContain("Re-installing: ntn v0.13.2")
    expect(ntnMocks.installNtn).toHaveBeenCalledTimes(1)
    // Re-install success copy is phrased as the next step (not as a
    // success of the current --login invocation) — pin both the
    // "ntn re-installed" prefix and the "Re-run" suffix so a future
    // contributor who re-adds the misleading "✓" gets caught.
    expect(stderrText()).toContain("ntn re-installed")
    expect(stderrText()).toContain("Re-run `lore auth --login` to complete login")
    expect(stderrText()).not.toContain("✓ ntn re-installed")
    expect(ntnMocks.resetNtnProbeCache).toHaveBeenCalledTimes(1)
    exit.restore()
  })

  it("non-interactive spawn-error with ntn missing AND no --yes: surfaces manual re-install + --yes hint", async () => {
    setupVaultProject()
    ntnMocks.runNtnLogin.mockResolvedValue({
      kind: "spawn-error",
      error: new Error("ENOENT"),
    })
    ntnMocks.isNtnInstalled.mockReturnValueOnce(true).mockReturnValue(false)
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    })
    const exit = mockProcessExit()
    await expect(runLogin({ yes: false })).rejects.toThrow("__process_exit_1__")
    // Re-install offer is gated on (--yes || TTY); this branch hits
    // neither, so we fall through to the manual-recovery copy.
    expect(stderrText()).toContain("`ntn` does not appear to be on PATH")
    expect(stderrText()).toContain("Manual re-install:")
    // The --yes hint MUST appear so a CI script consumer hitting
    // this knows about the auto-recovery option, mirroring the
    // install-from-missing branch's hint.
    expect(stderrText()).toContain(
      "Pass --yes (next run) to consent to the verified re-install"
    )
    expect(ntnMocks.installNtn).not.toHaveBeenCalled()
    exit.restore()
  })

  it("preserves resolveAuth's diagnostic when post-login token resolution fails", async () => {
    // The spec calls out multi-workspace ambiguity as the dominant
    // post-login failure: an operator with two workspaces in
    // auth.json hits the throw without a selector. Without this fix
    // the operator was bounced to `lore auth --status` for the same
    // diagnostic that's already in scope.
    setupVaultProject()
    ntnMocks.runNtnLogin.mockResolvedValue({ kind: "success" })
    // Force loadNtnToken's multi-workspace branch by listing two
    // workspaces; the throw site re-detects ambiguity for the hint.
    ntnMocks.listNtnWorkspaces.mockResolvedValue(["ws-1", "ws-2"])
    const exit = mockProcessExit()
    await expect(runLogin({ yes: true })).rejects.toThrow("__process_exit_1__")
    expect(stderrText()).toContain("Lore could not resolve a token")
    // The resolveAuth error message names the workspaces and the
    // selector remediation — surface a substring that proves the
    // diagnostic landed.
    expect(stderrText()).toMatch(/NOTION_WORKSPACE_ID|workspaces|specify one/i)
    exit.restore()
  })

  it("aborts after successful ntn login but failed preflight with workspace + sharing copy", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    ntnMocks.runNtnLogin.mockResolvedValue({ kind: "success" })
    verifyVaultAccessMock.mockResolvedValue({
      kind: "not-found",
      pageId: "abc",
      message: "Vault page not accessible. wrong workspace or not shared.",
    })
    const exit = mockProcessExit()
    await expect(runLogin({ yes: true })).rejects.toThrow("__process_exit_1__")
    expect(stderrText()).toContain("✗ Vault page not accessible after login")
    expect(stderrText()).toContain("authenticated against the wrong workspace")
    expect(stderrText()).toContain("personal Notion permissions")
    exit.restore()
  })

  it("post-flow preflight unauthorized: prints re-auth + workspace-membership advice (NOT wrong-workspace copy)", async () => {
    // The post-flow `unauthorized` branch is a surprise: ntn login
    // just succeeded yet the token is rejected. The most plausible
    // causes (clock skew / restricted_resource) point at re-auth +
    // workspace-membership check, NOT at the wrong-workspace path.
    // Pin per-branch copy so a future contributor who collapses the
    // branches back into one regresses loudly.
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    ntnMocks.runNtnLogin.mockResolvedValue({ kind: "success" })
    verifyVaultAccessMock.mockResolvedValue({
      kind: "unauthorized",
      pageId: "abc",
      message: "Notion rejected the bearer token.",
    })
    const exit = mockProcessExit()
    await expect(runLogin({ yes: true })).rejects.toThrow("__process_exit_1__")
    expect(stderrText()).toContain(
      "✗ Vault page not accessible after login (unauthorized)"
    )
    expect(stderrText()).toContain("Notion rejected the bearer token")
    expect(stderrText()).toContain(
      "Recommended: re-run `lore auth --login` to issue a fresh token."
    )
    expect(stderrText()).toContain("workspace")
    // The wrong-workspace numbered list MUST NOT fire — that's the
    // not-found branch's copy.
    expect(stderrText()).not.toContain("1. You authenticated against the wrong workspace")
    exit.restore()
  })

  it("post-flow preflight rate-limited: prints wait/retry copy (NOT re-auth)", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    ntnMocks.runNtnLogin.mockResolvedValue({ kind: "success" })
    verifyVaultAccessMock.mockResolvedValue({
      kind: "rate-limited",
      pageId: "abc",
      message: "Notion's API throttled this preflight (429).",
    })
    const exit = mockProcessExit()
    await expect(runLogin({ yes: true })).rejects.toThrow("__process_exit_1__")
    expect(stderrText()).toContain(
      "✗ Vault page not accessible after login (rate-limited)"
    )
    expect(stderrText()).toContain("throttled")
    expect(stderrText()).toContain("Wait a few seconds and re-run `lore auth --login`")
    // 429 is transient — must NOT trigger re-auth or wrong-workspace
    // copy.
    expect(stderrText()).not.toContain("1. You authenticated against the wrong workspace")
    expect(stderrText()).not.toContain("Recommended: re-run")
    exit.restore()
  })

  it("post-flow preflight unknown-error: surfaces the underlying error message", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    ntnMocks.runNtnLogin.mockResolvedValue({ kind: "success" })
    verifyVaultAccessMock.mockResolvedValue({
      kind: "unknown-error",
      pageId: "abc",
      error: new Error("5xx Bad Gateway"),
    })
    const exit = mockProcessExit()
    await expect(runLogin({ yes: true })).rejects.toThrow("__process_exit_1__")
    expect(stderrText()).toContain(
      "✗ Vault page not accessible after login (unknown-error)"
    )
    expect(stderrText()).toContain("5xx Bad Gateway")
    expect(stderrText()).toContain("Re-run `lore auth --login` after investigating")
    exit.restore()
  })
})

// ---------------------------------------------------------------------------
// runWhoami
// ---------------------------------------------------------------------------

describe("runWhoami / renderWhoamiIdentity", () => {
  it("prints the bot owner-user name when present", async () => {
    const client = {
      users: {
        me: vi.fn().mockResolvedValue({
          object: "user",
          id: "bot-id",
          type: "bot",
          bot: {
            owner: {
              type: "user",
              user: { id: "user-id", name: "Alice", object: "user" },
            },
            workspace_name: "Widget",
          },
        }),
      },
    } as unknown as Client
    expect(await renderWhoamiIdentity(client)).toBe("Alice")
  })

  it("falls back to owner-user id when name is missing", async () => {
    const client = {
      users: {
        me: vi.fn().mockResolvedValue({
          bot: {
            owner: {
              type: "user",
              user: { id: "user-id-only", object: "user" },
            },
            workspace_name: "Widget",
          },
        }),
      },
    } as unknown as Client
    expect(await renderWhoamiIdentity(client)).toBe("user-id-only")
  })

  it("falls back to <bot in workspace> when no owner-user identity is present", async () => {
    const client = {
      users: {
        me: vi.fn().mockResolvedValue({
          bot: {
            owner: { type: "workspace", workspace: true },
            workspace_name: "Notion HQ",
          },
        }),
      },
    } as unknown as Client
    expect(await renderWhoamiIdentity(client)).toBe("<bot in Notion HQ>")
  })

  it("returns <unknown> as the final fallback AND emits a stderr breadcrumb", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const client = {
      users: { me: vi.fn().mockResolvedValue({ bot: {} }) },
    } as unknown as Client
    expect(await renderWhoamiIdentity(client)).toBe("<unknown>")
    // The breadcrumb tells the operator the token is valid but the
    // identity is opaque — distinguishes "valid token, opaque shape"
    // from "the CLI silently returned a sentinel."
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("identity is opaque"))
    stderrSpy.mockRestore()
  })

  it("renderWhoamiIdentity exits 1 with the documented error wording when users.me throws", async () => {
    const client = {
      users: {
        me: vi.fn().mockRejectedValue(new Error("network exploded")),
      },
    } as unknown as Client
    const exit = mockProcessExit()
    await expect(renderWhoamiIdentity(client)).rejects.toThrow("__process_exit_1__")
    expect(stderrText()).toContain("Could not fetch identity")
    expect(stderrText()).toContain("network exploded")
    expect(exit.calls).toContain(1)
    exit.restore()
  })

  it("runWhoami without .lore.yaml falls back to global auth (NOTION_API_TOKEN)", async () => {
    // Mirrors --status / --logout's no-vault-context behavior so
    // `lore auth --whoami` works as a script-friendly identity probe
    // outside any Lore project. With NOTION_API_TOKEN set, the bot
    // identity prints to stdout; no vault-context error.
    setupNoVaultContext()
    process.env["NOTION_API_TOKEN"] = "tok"
    ;(
      fakeClientHolder.client.users.me as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      bot: {
        owner: {
          type: "user",
          user: { id: "id-x", name: "Test", object: "user" },
        },
      },
    })
    await runWhoami()
    expect(stdoutText()).toBe("Test\n")
  })

  it("runWhoami without .lore.yaml AND no global auth: exits 1 with the Not authenticated message", async () => {
    setupNoVaultContext()
    const exit = mockProcessExit()
    await expect(runWhoami()).rejects.toThrow("__process_exit_1__")
    expect(stderrText()).toContain("Not authenticated. Run `lore auth --login`")
    exit.restore()
  })

  it("runWhoami exits 1 with the documented Not authenticated message when no token resolves", async () => {
    setupVaultProject()
    const exit = mockProcessExit()
    await expect(runWhoami()).rejects.toThrow("__process_exit_1__")
    expect(stderrText()).toContain("Not authenticated. Run `lore auth --login`")
    exit.restore()
  })

  it("runWhoami prints just the name on the happy path", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    ;(
      fakeClientHolder.client.users.me as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      bot: {
        owner: {
          type: "user",
          user: { id: "id-1", name: "Test", object: "user" },
        },
      },
    })
    await runWhoami()
    // Single trailing newline; the only stdout line is the identity.
    expect(stdoutText()).toBe("Test\n")
  })

  it("runWhoami prints just the id when only an id is present (script-friendly)", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    ;(
      fakeClientHolder.client.users.me as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      bot: {
        owner: { type: "user", user: { id: "user-id-only", object: "user" } },
      },
    })
    await runWhoami()
    expect(stdoutText()).toBe("user-id-only\n")
  })

  it("runWhoami prints just the workspace fallback when bot owner is workspace-typed", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    ;(
      fakeClientHolder.client.users.me as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      bot: {
        owner: { type: "workspace", workspace: true },
        workspace_name: "Notion HQ",
      },
    })
    await runWhoami()
    expect(stdoutText()).toBe("<bot in Notion HQ>\n")
  })

  it("runWhoami appends `(personal token — ntn_)` for prod PAT / ntn-issued tokens", async () => {
    // The PAT-prefix label lets an operator confirm token shape from
    // --whoami alone — the headline value-add of the 2026-05-13 PAT
    // announcement's UX work. Prefix labels are display-only; they
    // don't change AuthSource or any on-wire behavior.
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "ntn_prod-token-bearer"
    ;(
      fakeClientHolder.client.users.me as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      bot: {
        owner: { type: "user", user: { id: "id", name: "Hesham", object: "user" } },
      },
    })
    await runWhoami()
    expect(stdoutText()).toBe("Hesham  (personal token — ntn_)\n")
  })

  it("runWhoami appends `(personal token — development_ntn_)` for dev-environment tokens", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "development_ntn_dev-bearer"
    ;(
      fakeClientHolder.client.users.me as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      bot: {
        owner: { type: "user", user: { id: "id", name: "Hesham", object: "user" } },
      },
    })
    await runWhoami()
    expect(stdoutText()).toBe("Hesham  (personal token — development_ntn_)\n")
  })

  it("runWhoami flags an integration-token shape with stdout label + stderr advisory", async () => {
    // The "I pasted an integration token from notion.so/profile/integrations
    // instead of a PAT from notion.so/developers/tokens" failure mode is
    // exactly what the prefix label surfaces — operators can spot it
    // straight from --whoami output instead of reading the docs.
    //
    // The split between stdout (identity + paren-free prefix label)
    // and stderr (rate-limit advisory) keeps the stdout line
    // script-friendly: a downstream consumer parsing `lore auth
    // --whoami` output gets one identity line, no nested parens.
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "secret_integration-bearer"
    ;(
      fakeClientHolder.client.users.me as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      bot: {
        owner: { type: "user", user: { id: "id", name: "Hesham", object: "user" } },
      },
    })
    await runWhoami()
    const out = stdoutText()
    expect(out).toContain("Hesham")
    expect(out).toContain("integration token — secret_")
    // Negative-paren regression guard: a future refactor that folds
    // the rate-limit advisory back into the prefix label (or that
    // wraps the label in something that already carries parens)
    // would land nested parens like `Hesham  ((integration token …))`.
    // Pin the absence of double-open-paren so the script-friendly
    // identity contract survives refactors.
    expect(out).not.toMatch(/\(\(/)
    // Advisory lands on stderr, not stdout.
    const err = stderrText()
    expect(err.toLowerCase()).toContain("rate-limited")
    expect(err.toLowerCase()).toContain("pat")
    expect(err).toContain("notion.so/developers/tokens")
  })

  it("runWhoami emits no stderr advisory for personal-token prefixes", async () => {
    // Negative coverage for the advisory — only `integration`-classified
    // tokens trigger the stderr write; `ntn_…` and `development_ntn_…`
    // stdout output stays clean.
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "ntn_prod-bearer"
    ;(
      fakeClientHolder.client.users.me as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      bot: {
        owner: { type: "user", user: { id: "id", name: "Hesham", object: "user" } },
      },
    })
    await runWhoami()
    expect(stderrText()).toBe("")
  })

  it("runWhoami carries resolveAuth's diagnostic into stderr alongside the redirect", async () => {
    setupVaultProject()
    ntnMocks.listNtnWorkspaces.mockResolvedValue(["ws-1", "ws-2"])
    const exit = mockProcessExit()
    await expect(runWhoami()).rejects.toThrow("__process_exit_1__")
    expect(stderrText()).toContain("Not authenticated. Run `lore auth --login`")
    expect(stderrText()).toMatch(/NOTION_WORKSPACE_ID|workspaces|specify one/i)
    exit.restore()
  })
})

// ---------------------------------------------------------------------------
// runLogout
// ---------------------------------------------------------------------------

describe("runLogout", () => {
  it("prints 'Nothing to log out of' when no auth resolves", async () => {
    setupVaultProject()
    await runLogout()
    expect(stdoutText()).toContain("Nothing to log out of")
  })

  it("points at unset NOTION_API_TOKEN for the env-notion-api-token source", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    await runLogout()
    expect(stdoutText()).toContain("NOTION_API_TOKEN")
    expect(stdoutText()).toContain("unset NOTION_API_TOKEN")
  })

  it("points at `ntn logout` for the ntn-auth-json source", async () => {
    setupVaultProject()
    // Make resolveAuth land on ntn-auth-json by stubbing the
    // `loadNtnToken` mock to return a workspace token. Avoids a
    // real-filesystem `auth.json` write so the test stays
    // deterministic regardless of the host's XDG_CONFIG_HOME.
    ntnMocks.loadNtnToken.mockResolvedValue({
      token: "tok-1",
      workspaceId: "ws-1",
      baseUrl: undefined,
    })
    await runLogout()
    expect(stdoutText()).toContain("ntn logout")
    expect(stdoutText()).toContain("Lore reads but doesn't write auth.json")
  })
})

// ---------------------------------------------------------------------------
// confirmPrompt — signature alignment with PR #176, non-TTY breadcrumb
// ---------------------------------------------------------------------------

describe("confirmPrompt", () => {
  it("synthesizes the [Y/n] suffix when defaultYes=true (default)", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    })
    readlineHolder.answer = ""
    expect(await confirmPrompt("Install ntn now?")).toBe(true)
    expect(readlineHolder.lastQuestion).toBe("Install ntn now? [Y/n] ")
  })

  it("synthesizes the [y/N] suffix when defaultYes=false", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    })
    readlineHolder.answer = ""
    expect(await confirmPrompt("Drop the table?", false)).toBe(false)
    expect(readlineHolder.lastQuestion).toBe("Drop the table? [y/N] ")
  })

  it("treats explicit 'y' / 'yes' (case-insensitive) as yes regardless of default", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    })
    readlineHolder.answer = "Y"
    expect(await confirmPrompt("Q?", false)).toBe(true)
    readlineHolder.answer = "yes"
    expect(await confirmPrompt("Q?", false)).toBe(true)
  })

  it("treats anything other than y/yes as no when there's a non-empty answer", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    })
    readlineHolder.answer = "n"
    expect(await confirmPrompt("Q?")).toBe(false)
    readlineHolder.answer = "no"
    expect(await confirmPrompt("Q?")).toBe(false)
    readlineHolder.answer = "maybe"
    expect(await confirmPrompt("Q?")).toBe(false)
  })

  it("refuses on non-TTY and writes a breadcrumb to stderr (signal, not silence)", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    })
    try {
      expect(await confirmPrompt("Install?")).toBe(false)
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("non-interactive context")
      )
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: true,
      })
      stderrSpy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// authCommand action handler — multi-flag warning dispatch
// ---------------------------------------------------------------------------

describe("authCommand action handler", () => {
  it("emits a stderr warning naming the ignored flags when multiple are passed", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    verifyVaultAccessMock.mockResolvedValue({ kind: "ok", pageTitle: "V" })
    // Drive commander directly. The action handler in authCommand
    // is what wires `pickAuthAction`'s `ignored` list into the
    // stderr `console.warn` call — without this integration test,
    // a future contributor refactoring the warning to console.log
    // (which would pollute `lore auth --whoami` script consumers)
    // breaks the spec without a test failing.
    await authCommand.parseAsync([
      "node",
      "lore-auth",
      "--status",
      "--whoami",
      "--logout",
    ])
    // Logout wins per precedence (--login > --logout > --whoami > --status).
    expect(stderrText()).toContain(
      "Warning: multiple auth flags supplied; running --logout and ignoring --whoami, --status"
    )
    // Logout body actually ran (NOTION_API_TOKEN source).
    expect(stdoutText()).toContain("unset NOTION_API_TOKEN")
  })

  it("does not warn when a single flag is passed", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    verifyVaultAccessMock.mockResolvedValue({ kind: "ok", pageTitle: "V" })
    await authCommand.parseAsync(["node", "lore-auth", "--status"])
    expect(stderrText()).not.toContain("multiple auth flags")
  })

  it("defaults to --status when no flag is passed", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    verifyVaultAccessMock.mockResolvedValue({ kind: "ok", pageTitle: "V" })
    await authCommand.parseAsync(["node", "lore-auth"])
    expect(stdoutText()).toContain("Lore auth status for")
  })
})
