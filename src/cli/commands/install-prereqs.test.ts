import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// IMPORTANT: vi.mock calls are hoisted to the top of the file. These
// mocks replace the auth / oauth / config modules with stubs we drive
// per-test via vi.mocked().mockReturnValue / .mockResolvedValue. The
// install module under test imports from these paths; the mocked
// versions are what its calls reach.
//
// We keep ensurePrerequisites tests in a dedicated file so this
// module-level mocking does not collide with the rest of install.test.ts
// (which exercises buildClaudeMcpEntry, runCursorInstall, etc., none of
// which need the auth modules mocked).

vi.mock("../../auth/ntn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auth/ntn.js")>()
  return {
    ...actual,
    isNtnInstalled: vi.fn(),
    getNtnVersion: vi.fn(),
    checkNtnVersion: vi.fn(),
    installNtn: vi.fn(),
    runNtnLogin: vi.fn(),
    // Let pure helpers (`parseNtnEnv`) through; they're table lookups
    // with no Notion / process I/O, and the env-aware preflight tests
    // exercise their real behavior.
  }
})

vi.mock("../../auth/oauth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auth/oauth.js")>()
  return {
    ...actual,
    verifyVaultAccess: vi.fn(),
    // `resolveOperatorBaseUrl` and `ntnEnvFromBaseUrl` are pure
    // env-string helpers; let the real implementations through so
    // the URL-to-env mapping the offer-login branch consults
    // matches production. We only override `verifyVaultAccess` (the
    // Notion round-trip) for test determinism.
  }
})

vi.mock("../../config.js", async () => {
  const realConfig = await vi.importActual<typeof import("../../config.js")>("../../config.js")
  return {
    ...realConfig,
    findConfigFile: vi.fn(),
    loadConfig: vi.fn(),
    resolveAuth: vi.fn(),
  }
})

vi.mock("../../notion/client.js", () => ({
  createClient: vi.fn(() => ({}) as unknown),
}))

vi.mock("../../notion/rate-limit.js", async () => {
  const real = await vi.importActual<typeof import("../../notion/rate-limit.js")>(
    "../../notion/rate-limit.js",
  )
  return {
    ...real,
    createLimitedClient: vi.fn((c: unknown) => c),
  }
})

import {
  isNtnInstalled,
  getNtnVersion,
  checkNtnVersion,
  installNtn,
  runNtnLogin,
} from "../../auth/ntn.js"
import { verifyVaultAccess } from "../../auth/oauth.js"
import { findConfigFile, loadConfig, resolveAuth } from "../../config.js"
import { ensurePrerequisites, type InstallContext } from "./install.js"

const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

function captured(spy: typeof consoleLogSpy): string {
  return spy.mock.calls.map((args) => args.join(" ")).join("\n")
}

function makeContext(): InstallContext {
  return {
    projectDir: "/tmp/prereqs-fake-project",
    pkgRoot: "/tmp/prereqs-fake-pkg",
    configRoot: "/tmp/prereqs-fake-project",
    autosavePath: "/tmp/prereqs-fake-pkg/hooks/autosave.sh",
    wakeupPath: "/tmp/prereqs-fake-pkg/hooks/wakeup.sh",
    mcpJsPath: "/tmp/prereqs-fake-pkg/dist/mcp.js",
    skipPrompts: true,
    legacyPaths: false,
    yarnPnp: false,
    wakeUpConfig: null,
  }
}

describe("ensurePrerequisites — happy path", () => {
  beforeEach(() => {
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(checkNtnVersion).mockReturnValue("ok")
    vi.mocked(getNtnVersion).mockReturnValue("0.12.0")
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/prereqs-fake-project/.lore.yaml",
      root: "/tmp/prereqs-fake-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({ vault: { pageId: "page-123" } } as never)
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok",
      source: "ntn-auth-json",
    })
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: "My Vault" })
  })

  afterEach(() => {
    vi.clearAllMocks()
    consoleLogSpy.mockClear()
    consoleWarnSpy.mockClear()
    consoleErrorSpy.mockClear()
  })

  it("reports each probe with ✓ and returns ready=true when everything resolves", async () => {
    const result = await ensurePrerequisites(makeContext(), { yes: true })
    expect(result.ready).toBe(true)
    const out = captured(consoleLogSpy)
    expect(out).toMatch(/ntn installed:\s+✓/)
    expect(out).toMatch(/ntn version:\s+✓ 0\.12\.0/)
    expect(out).toMatch(/Auth source:\s+✓ ntn-issued/)
    expect(out).toMatch(/Vault page:\s+✓ My Vault/)
  })

  it("annotates legacy auth sources with the migration recommendation", async () => {
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok",
      source: "env-lore-notion-token",
    })
    const result = await ensurePrerequisites(makeContext(), { yes: true })
    expect(result.ready).toBe(true)
    const out = captured(consoleLogSpy)
    expect(out).toMatch(/Auth source:\s+✓ LORE_NOTION_TOKEN \(env, legacy\)/)
    expect(out).toMatch(/soft-deprecated; switch to ntn via `NOTION_KEYRING=0 ntn login`/)
  })
})

describe("ensurePrerequisites — version warning", () => {
  beforeEach(() => {
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/prereqs-fake-project/.lore.yaml",
      root: "/tmp/prereqs-fake-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({ vault: { pageId: "page-123" } } as never)
    vi.mocked(resolveAuth).mockResolvedValue({ token: "tok", source: "ntn-auth-json" })
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
  })

  afterEach(() => {
    vi.clearAllMocks()
    consoleLogSpy.mockClear()
    consoleWarnSpy.mockClear()
    consoleErrorSpy.mockClear()
  })

  it("prints a non-blocking warning when ntn is below MIN_NTN_VERSION (proceeds)", async () => {
    vi.mocked(checkNtnVersion).mockReturnValue("too-old")
    vi.mocked(getNtnVersion).mockReturnValue("0.11.5")

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(true)
    const out = captured(consoleLogSpy)
    expect(out).toMatch(/ntn version:\s+! 0\.11\.5 \(below tested minimum 0\.12\.0\)/)
    expect(out).toMatch(/consider running `ntn update`/)
  })

  it("proceeds silently on checkNtnVersion='unknown' (malformed --version output)", async () => {
    // ntn --version output that doesn't match the SemVer regex (e.g.,
    // a future build flavor or a corrupted binary) returns "unknown"
    // from checkNtnVersion. The install path treats this as
    // informational — no warning, no abort, just no version line.
    // The auth probe still runs and gates `ready`.
    vi.mocked(checkNtnVersion).mockReturnValue("unknown")
    vi.mocked(getNtnVersion).mockReturnValue(null)

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(true)
    const out = captured(consoleLogSpy)
    // Version line is absent on the unknown branch; the install
    // continues to auth resolution.
    expect(out).not.toMatch(/ntn version:/)
    expect(out).toMatch(/Auth source:/)
  })
})

describe("ensurePrerequisites — ntn auto-install branch", () => {
  beforeEach(() => {
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/prereqs-fake-project/.lore.yaml",
      root: "/tmp/prereqs-fake-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({ vault: { pageId: "page-123" } } as never)
    vi.mocked(resolveAuth).mockResolvedValue({ token: "tok", source: "ntn-auth-json" })
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
  })

  afterEach(() => {
    vi.clearAllMocks()
    consoleLogSpy.mockClear()
    consoleWarnSpy.mockClear()
    consoleErrorSpy.mockClear()
  })

  it("auto-installs ntn under --yes and proceeds", async () => {
    vi.mocked(isNtnInstalled).mockReturnValue(false)
    vi.mocked(installNtn).mockResolvedValue({ kind: "success" })
    vi.mocked(checkNtnVersion).mockReturnValue("ok")
    vi.mocked(getNtnVersion).mockReturnValue("0.12.0")

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(installNtn).toHaveBeenCalled()
    expect(result.ready).toBe(true)
    const out = captured(consoleLogSpy)
    expect(out).toContain("curl -fsSL https://ntn.dev | bash")
    expect(out).toMatch(/ntn installed/)
  })

  it("returns ready=false when installNtn fails non-zero", async () => {
    vi.mocked(isNtnInstalled).mockReturnValue(false)
    vi.mocked(installNtn).mockResolvedValue({ kind: "exit-non-zero", code: 1 })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(false)
    expect(captured(consoleErrorSpy)).toMatch(/ntn install failed/)
  })

  it("returns ready=false when installNtn spawn-errors (e.g., laptop offline during curl-pipe-bash)", async () => {
    // The most likely real-world failure mode for the install path —
    // the auto-install spawn fails before the script can run. The
    // `kind: "spawn-error"` branch is what `auth/ntn.ts:485` returns
    // on `child_process.spawn` throwing or emitting `error`.
    vi.mocked(isNtnInstalled).mockReturnValue(false)
    vi.mocked(installNtn).mockResolvedValue({
      kind: "spawn-error",
      error: new Error("ENETUNREACH"),
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(false)
    expect(captured(consoleErrorSpy)).toMatch(/ntn install failed/)
  })

  it("returns ready=false in non-TTY when ntn is missing and --yes is not passed", async () => {
    vi.mocked(isNtnInstalled).mockReturnValue(false)
    // confirmPrompt detects non-TTY and returns false; we simulate
    // that by stubbing process.stdin.isTTY for the duration of this
    // test.
    const originalIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })
    try {
      const result = await ensurePrerequisites(makeContext(), {})
      expect(result.ready).toBe(false)
      expect(installNtn).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      })
    }
  })
})

describe("ensurePrerequisites — auto-login branch", () => {
  beforeEach(() => {
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(checkNtnVersion).mockReturnValue("ok")
    vi.mocked(getNtnVersion).mockReturnValue("0.12.0")
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/prereqs-fake-project/.lore.yaml",
      root: "/tmp/prereqs-fake-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({ vault: { pageId: "page-123" } } as never)
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
  })

  afterEach(() => {
    vi.clearAllMocks()
    consoleLogSpy.mockClear()
    consoleWarnSpy.mockClear()
    consoleErrorSpy.mockClear()
  })

  it("runs ntn login when auth fails and --yes is passed; re-resolves and proceeds", async () => {
    // First resolveAuth call rejects (no auth). After login, second
    // call resolves successfully.
    vi.mocked(resolveAuth)
      .mockRejectedValueOnce(new Error("No Notion auth configured."))
      .mockResolvedValueOnce({ token: "tok", source: "ntn-auth-json" })
    vi.mocked(runNtnLogin).mockResolvedValue({ kind: "success" })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(runNtnLogin).toHaveBeenCalled()
    expect(result.ready).toBe(true)
    expect(captured(consoleLogSpy)).toMatch(/ntn login completed/)
  })

  it("returns ready=false when ntn login exits non-zero", async () => {
    vi.mocked(resolveAuth).mockRejectedValueOnce(new Error("No Notion auth configured."))
    vi.mocked(runNtnLogin).mockResolvedValue({ kind: "exit-non-zero", code: 1 })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(false)
    expect(captured(consoleErrorSpy)).toMatch(/ntn login did not complete successfully/)
  })

  it("returns ready=false when ntn login spawn-errors", async () => {
    // Symmetric coverage with installNtn's spawn-error case — same
    // operator-facing class (laptop offline, ntn not on PATH after
    // a half-finished install, etc.).
    vi.mocked(resolveAuth).mockRejectedValueOnce(new Error("No Notion auth configured."))
    vi.mocked(runNtnLogin).mockResolvedValue({
      kind: "spawn-error",
      error: new Error("EACCES"),
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(false)
    expect(captured(consoleErrorSpy)).toMatch(/ntn login did not complete successfully/)
  })

  it("returns ready=false when login succeeds but auth still fails to resolve", async () => {
    vi.mocked(resolveAuth)
      .mockRejectedValueOnce(new Error("first attempt fails"))
      .mockRejectedValueOnce(new Error("post-login still fails"))
    vi.mocked(runNtnLogin).mockResolvedValue({ kind: "success" })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(false)
    // The post-login still-failing path points operators at concrete
    // diagnostics (auth.json contents + LORE_DEBUG=1) rather than
    // `lore auth --status` (which lands in #06).
    expect(captured(consoleErrorSpy)).toMatch(/auth\.json|LORE_DEBUG=1/)
  })
})

describe("ensurePrerequisites — ntn env derivation for ntn login", () => {
  // The auto-login flow has to choose a NOTION_ENV target before
  // spawning ntn login. Without explicit derivation, ntn defaults
  // to prod and a `lore install -y` against a dev project mints a
  // prod token that fails the post-login preflight with a confusing
  // generic vault-not-accessible error. The derivation logic walks:
  //
  //   1. operator's `NOTION_ENV` (highest priority — explicit shell choice)
  //   2. inferred from `.lore.yaml`'s `auth.baseUrl` via canonical mapping
  //   3. fall through to ntn's default (prod) when neither signals
  //
  // A non-canonical `auth.baseUrl` (e.g., a corporate proxy) with no
  // operator NOTION_ENV refuses auto-login outright — minting prod
  // for what's almost certainly a non-prod project is the worst
  // outcome.

  const PRIOR_NOTION_ENV = process.env["NOTION_ENV"]

  beforeEach(() => {
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(checkNtnVersion).mockReturnValue("ok")
    vi.mocked(getNtnVersion).mockReturnValue("0.12.0")
    // No auth at first; install-time vault preflight returns ok
    // post-login so the test focuses on the env-derivation gate.
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    vi.mocked(runNtnLogin).mockResolvedValue({ kind: "success" })
    delete process.env["NOTION_ENV"]
  })

  afterEach(() => {
    vi.clearAllMocks()
    consoleLogSpy.mockClear()
    consoleWarnSpy.mockClear()
    consoleErrorSpy.mockClear()
    if (PRIOR_NOTION_ENV === undefined) {
      delete process.env["NOTION_ENV"]
    } else {
      process.env["NOTION_ENV"] = PRIOR_NOTION_ENV
    }
  })

  it("infers env=dev from .lore.yaml auth.baseUrl=https://api-dev.notion.com and passes to runNtnLogin", async () => {
    // The flagged scenario: `lore install -y` against a dev project
    // must NOT default to prod. The derived NOTION_ENV flows into
    // ntn login's spawn env so the resulting token authorizes
    // against the dev workspace.
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/dev-project/.lore.yaml",
      root: "/tmp/dev-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({
      vault: { pageId: "dev-page" },
      auth: { baseUrl: "https://api-dev.notion.com" },
    } as never)
    vi.mocked(resolveAuth)
      .mockRejectedValueOnce(new Error("No Notion auth configured."))
      .mockResolvedValueOnce({ token: "tok", source: "ntn-auth-json" })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(true)
    expect(runNtnLogin).toHaveBeenCalledWith({ env: "dev" })
    const out = captured(consoleLogSpy)
    expect(out).toMatch(/auth\.baseUrl maps to ntn env "dev"/)
    expect(out).toMatch(/NOTION_ENV=dev to ntn login/)
  })

  it("infers env=stg from a staging baseUrl", async () => {
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/stg-project/.lore.yaml",
      root: "/tmp/stg-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({
      vault: { pageId: "stg-page" },
      auth: { baseUrl: "https://api-stg.notion.com" },
    } as never)
    vi.mocked(resolveAuth)
      .mockRejectedValueOnce(new Error("No Notion auth configured."))
      .mockResolvedValueOnce({ token: "tok", source: "ntn-auth-json" })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(true)
    expect(runNtnLogin).toHaveBeenCalledWith({ env: "stg" })
  })

  it("operator's NOTION_ENV wins over config auth.baseUrl inference", async () => {
    // An operator who explicitly exports NOTION_ENV=stg in their
    // shell while working in a dev project (unusual but possible)
    // gets stg. The operator's explicit choice always beats the
    // config-derived inference.
    process.env["NOTION_ENV"] = "stg"
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/dev-project/.lore.yaml",
      root: "/tmp/dev-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({
      vault: { pageId: "page" },
      auth: { baseUrl: "https://api-dev.notion.com" },
    } as never)
    vi.mocked(resolveAuth)
      .mockRejectedValueOnce(new Error("No Notion auth configured."))
      .mockResolvedValueOnce({ token: "tok", source: "ntn-auth-json" })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(true)
    expect(runNtnLogin).toHaveBeenCalledWith({ env: "stg" })
  })

  it("calls runNtnLogin with no env when neither NOTION_ENV nor auth.baseUrl is set (prod default)", async () => {
    // Plain prod project: no env signals, runNtnLogin inherits
    // ntn's default (prod). Pinning this so a future refactor that
    // accidentally always passes `env: "prod"` (which would be
    // visible-but-equivalent) doesn't drift the contract — when
    // there's no signal, we don't fabricate one.
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/prod-project/.lore.yaml",
      root: "/tmp/prod-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({
      vault: { pageId: "page" },
    } as never)
    vi.mocked(resolveAuth)
      .mockRejectedValueOnce(new Error("No Notion auth configured."))
      .mockResolvedValueOnce({ token: "tok", source: "ntn-auth-json" })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(true)
    expect(runNtnLogin).toHaveBeenCalledWith({})
  })

  it("REFUSES auto-login when auth.baseUrl is non-canonical and operator NOTION_ENV is unset", async () => {
    // Corporate proxy or a future env Lore doesn't map. We can't
    // safely pick a NOTION_ENV target — minting a prod token for
    // what's clearly NOT a prod project is the worst outcome.
    // Refuse auto-login entirely with explicit recovery copy.
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/proxy-project/.lore.yaml",
      root: "/tmp/proxy-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({
      vault: { pageId: "page" },
      auth: { baseUrl: "https://my-corporate-proxy.example" },
    } as never)
    vi.mocked(resolveAuth).mockRejectedValueOnce(
      new Error("No Notion auth configured."),
    )

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(false)
    expect(runNtnLogin).not.toHaveBeenCalled()
    const err = captured(consoleErrorSpy)
    expect(err).toMatch(/doesn't[\s\S]*match a known ntn environment/)
    expect(err).toMatch(/NOTION_ENV=<env> ntn login/)
  })

  it("operator's explicit NOTION_ENV bypasses the non-canonical-baseUrl refusal", async () => {
    // If the operator HAS set NOTION_ENV explicitly, we trust their
    // choice — even when auth.baseUrl is non-canonical. The proxy
    // case is "I'm tunneling traffic through this URL but the
    // workspace is genuinely on dev" and Lore shouldn't second-guess.
    process.env["NOTION_ENV"] = "dev"
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/proxy-project/.lore.yaml",
      root: "/tmp/proxy-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({
      vault: { pageId: "page" },
      auth: { baseUrl: "https://my-corporate-proxy.example" },
    } as never)
    vi.mocked(resolveAuth)
      .mockRejectedValueOnce(new Error("No Notion auth configured."))
      .mockResolvedValueOnce({ token: "tok", source: "ntn-auth-json" })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(true)
    expect(runNtnLogin).toHaveBeenCalledWith({ env: "dev" })
  })

  it("offer-login skip surfaces the inferred env in the manual-fallback copy", async () => {
    // Operator declines the auto-login. The recovery copy must name
    // the inferred env so the manual `NOTION_ENV=... ntn login`
    // command they paste back matches what auto-login would have
    // done.
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/dev-project/.lore.yaml",
      root: "/tmp/dev-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({
      vault: { pageId: "page" },
      auth: { baseUrl: "https://api-dev.notion.com" },
    } as never)
    vi.mocked(resolveAuth).mockRejectedValueOnce(
      new Error("No Notion auth configured."),
    )
    // Simulate operator declining: stub stdin.isTTY=false so
    // confirmPrompt returns false (non-TTY guard).
    const originalIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })
    try {
      const result = await ensurePrerequisites(makeContext(), {})
      expect(result.ready).toBe(false)
      const out = captured(consoleLogSpy)
      expect(out).toMatch(/NOTION_KEYRING=0 NOTION_ENV=dev ntn login/)
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      })
    }
  })
})

describe("ensurePrerequisites — vault preflight", () => {
  beforeEach(() => {
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(checkNtnVersion).mockReturnValue("ok")
    vi.mocked(getNtnVersion).mockReturnValue("0.12.0")
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/prereqs-fake-project/.lore.yaml",
      root: "/tmp/prereqs-fake-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({ vault: { pageId: "page-123" } } as never)
    vi.mocked(resolveAuth).mockResolvedValue({ token: "tok", source: "ntn-auth-json" })
  })

  afterEach(() => {
    vi.clearAllMocks()
    consoleLogSpy.mockClear()
    consoleWarnSpy.mockClear()
    consoleErrorSpy.mockClear()
  })

  it("returns ready=false on `not-found` and prints the wrong-workspace guidance", async () => {
    // Acceptance criterion: a `not-found` from verifyVaultAccess
    // ABORTS the install — refusing to write MCP config is the whole
    // point of the post-resolution preflight.
    vi.mocked(verifyVaultAccess).mockResolvedValue({
      kind: "not-found",
      pageId: "page-123",
      message: "...",
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(false)
    const err = captured(consoleErrorSpy)
    expect(err).toMatch(/Vault page:\s+✗ not accessible/)
    expect(err).toMatch(/wrong workspace/)
    expect(err).toMatch(/Refusing to write MCP config/)
  })

  it("returns ready=true on `unknown-error` (genuine transient) with a warning", async () => {
    vi.mocked(verifyVaultAccess).mockResolvedValue({
      kind: "unknown-error",
      pageId: "page-123",
      error: new Error("503 Service Unavailable"),
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(true)
    expect(captured(consoleWarnSpy)).toMatch(/preflight returned an unexpected error/)
  })

  it("returns ready=false on `unauthorized` (401/403) — install must NOT write MCP config on a token problem", async () => {
    // Reviewer call-out: the original PR collapsed 401/403 into the
    // generic transient bucket, so MCP config would land and the
    // operator's first tool call would also 401 — exactly the
    // failure mode the preflight was supposed to prevent. After
    // refinement, unauthorized is its own branch and gates ready=false.
    vi.mocked(verifyVaultAccess).mockResolvedValue({
      kind: "unauthorized",
      pageId: "page-123",
      message: "Notion rejected the bearer token.",
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(false)
    const err = captured(consoleErrorSpy)
    expect(err).toMatch(/Vault page:\s+✗ unauthorized/)
    expect(err).toMatch(/Refusing to write MCP config/)
    // Recovery copy is env-aware: a project with no auth.baseUrl
    // and no operator NOTION_ENV gets the prod-default command,
    // which still carries the load-bearing NOTION_KEYRING=0 prefix.
    expect(err).toMatch(/NOTION_KEYRING=0 ntn login/)
  })

  it("returns ready=true on `rate-limited` with a throttling-aware warning", async () => {
    // 429 is plausibly transient under sustained traffic. Different
    // copy from generic 5xx because the recovery (wait + retry) is
    // distinct from "check Notion's status page."
    vi.mocked(verifyVaultAccess).mockResolvedValue({
      kind: "rate-limited",
      pageId: "page-123",
      message: "Notion's API throttled this preflight (429).",
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(true)
    expect(captured(consoleWarnSpy)).toMatch(/rate-limited/)
  })

  it("skips preflight when no .lore.yaml exists (auth resolved without a vault config)", async () => {
    vi.mocked(findConfigFile).mockResolvedValue(null)
    // resolveAuth still works (env-only path); no vault to verify.
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok",
      source: "env-notion-api-token",
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(true)
    expect(verifyVaultAccess).not.toHaveBeenCalled()
  })
})

describe("ensurePrerequisites — env-aware preflight-failure recovery", () => {
  // The recovery copy emitted on `not-found` / `unauthorized` MUST
  // be paste-ready for the operator's actual env, not bare
  // `ntn login`. Bare `ntn login` defaults to prod AND writes to
  // the macOS keychain (Lore can't read keychain auth) — both
  // wrong for a dev project. The regression here pins the
  // load-bearing case: stale prod ntn-auth-json + dev `.lore.yaml`
  // + preflight `not-found` → recovery names dev env AND keeps
  // the NOTION_KEYRING=0 prefix.

  const PRIOR_NOTION_ENV = process.env["NOTION_ENV"]

  beforeEach(() => {
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(checkNtnVersion).mockReturnValue("ok")
    vi.mocked(getNtnVersion).mockReturnValue("0.12.0")
    delete process.env["NOTION_ENV"]
  })

  afterEach(() => {
    vi.clearAllMocks()
    consoleLogSpy.mockClear()
    consoleWarnSpy.mockClear()
    consoleErrorSpy.mockClear()
    if (PRIOR_NOTION_ENV === undefined) {
      delete process.env["NOTION_ENV"]
    } else {
      process.env["NOTION_ENV"] = PRIOR_NOTION_ENV
    }
  })

  it("not-found on dev project with stale prod ntn-auth-json: recovery names dev env + keychain prefix", async () => {
    // The reviewer's flagged scenario. Operator has a stale prod
    // token in auth.json from an earlier `ntn login`; project
    // `.lore.yaml` says dev. resolveAuth succeeds (token exists),
    // preflight fails because the prod token can't see the dev
    // page. Without env-aware recovery, the operator pastes
    // bare `ntn login` and gets prod again — minting a NEW prod
    // token they still can't use.
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/dev-project/.lore.yaml",
      root: "/tmp/dev-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({
      vault: { pageId: "dev-page-id" },
      auth: { baseUrl: "https://api-dev.notion.com" },
    } as never)
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "stale-prod-tok",
      source: "ntn-auth-json",
    })
    vi.mocked(verifyVaultAccess).mockResolvedValue({
      kind: "not-found",
      pageId: "dev-page-id",
      message: "...",
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(false)
    const err = captured(consoleErrorSpy)
    expect(err).toMatch(/Vault page:\s+✗ not accessible/)
    expect(err).toMatch(/NOTION_KEYRING=0 NOTION_ENV=dev ntn login/)
    expect(err).toMatch(/dev env inferred from \.lore\.yaml auth\.baseUrl/)
    expect(err).not.toMatch(/Re-run `ntn login`(?!.*NOTION_KEYRING)/)
    expect(err).toMatch(/Refusing to write MCP config/)
  })

  it("unauthorized (401) on dev project: recovery names dev env + keychain prefix", async () => {
    // Symmetric to the not-found case: a 401 on a dev project
    // means the operator's resolved token is invalid for dev (or
    // valid for the wrong env entirely). Recovery must name dev.
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/dev-project/.lore.yaml",
      root: "/tmp/dev-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({
      vault: { pageId: "dev-page-id" },
      auth: { baseUrl: "https://api-dev.notion.com" },
    } as never)
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "stale-prod-tok",
      source: "ntn-auth-json",
    })
    vi.mocked(verifyVaultAccess).mockResolvedValue({
      kind: "unauthorized",
      pageId: "dev-page-id",
      message: "Notion rejected the bearer token.",
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(false)
    const err = captured(consoleErrorSpy)
    expect(err).toMatch(/NOTION_KEYRING=0 NOTION_ENV=dev ntn login/)
  })

  it("non-canonical baseUrl on preflight failure: recovery says NOTION_ENV=<env> placeholder + explanation", async () => {
    // Corporate proxy or a future env Lore doesn't map. Recovery
    // can't name a specific env so it directs the operator to
    // substitute one for their workspace.
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/proxy-project/.lore.yaml",
      root: "/tmp/proxy-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({
      vault: { pageId: "page-id" },
      auth: { baseUrl: "https://my-corporate-proxy.example" },
    } as never)
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "stale-tok",
      source: "ntn-auth-json",
    })
    vi.mocked(verifyVaultAccess).mockResolvedValue({
      kind: "not-found",
      pageId: "page-id",
      message: "...",
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(false)
    const err = captured(consoleErrorSpy)
    expect(err).toMatch(/NOTION_KEYRING=0 NOTION_ENV=<env> ntn login/)
    expect(err).toMatch(
      /doesn't match a canonical ntn env[\s\S]*substitute <env>/,
    )
  })

  it("operator NOTION_ENV beats config inference in recovery copy", async () => {
    // An operator who set NOTION_ENV=stg in their shell during a
    // dev project's install gets stg in the recovery copy — the
    // explicit shell choice always wins. (Unusual setup but the
    // contract should match `runNtnLogin` env-derivation.)
    process.env["NOTION_ENV"] = "stg"
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/dev-project/.lore.yaml",
      root: "/tmp/dev-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({
      vault: { pageId: "page-id" },
      auth: { baseUrl: "https://api-dev.notion.com" },
    } as never)
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok",
      source: "ntn-auth-json",
    })
    vi.mocked(verifyVaultAccess).mockResolvedValue({
      kind: "not-found",
      pageId: "page-id",
      message: "...",
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(false)
    const err = captured(consoleErrorSpy)
    expect(err).toMatch(/NOTION_KEYRING=0 NOTION_ENV=stg ntn login/)
  })

  it("prod-default project (no auth.baseUrl, no NOTION_ENV): recovery is bare prod login WITH keychain prefix", async () => {
    // Pinning the prod-default contract: bare command (no NOTION_ENV)
    // is fine when no signal disagrees with prod, but the
    // NOTION_KEYRING=0 prefix is STILL required so the resulting
    // token lands where Lore can read it.
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/prod-project/.lore.yaml",
      root: "/tmp/prod-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({
      vault: { pageId: "page-id" },
    } as never)
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok",
      source: "ntn-auth-json",
    })
    vi.mocked(verifyVaultAccess).mockResolvedValue({
      kind: "not-found",
      pageId: "page-id",
      message: "...",
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(false)
    const err = captured(consoleErrorSpy)
    expect(err).toMatch(/NOTION_KEYRING=0 ntn login/)
    expect(err).not.toMatch(/NOTION_ENV=/)
  })
})
