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
  const realConfig =
    await vi.importActual<typeof import("../../config.js")>("../../config.js")
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
    "../../notion/rate-limit.js"
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

  it("auto-installs ntn under --ntn --yes and proceeds", async () => {
    // The auto-install branch is `--ntn`-only since the
    // 2026-05-13 PAT announcement. Default `lore install` does NOT
    // curl-pipe-bash; only the explicit internal-engineer opt-in does.
    vi.mocked(isNtnInstalled).mockReturnValue(false)
    vi.mocked(installNtn).mockResolvedValue({ kind: "success" })
    vi.mocked(checkNtnVersion).mockReturnValue("ok")
    vi.mocked(getNtnVersion).mockReturnValue("0.12.0")

    const result = await ensurePrerequisites(makeContext(), {
      yes: true,
      ntn: true,
    })

    expect(installNtn).toHaveBeenCalled()
    expect(result.ready).toBe(true)
    const out = captured(consoleLogSpy)
    expect(out).toContain("curl -fsSL https://ntn.dev | bash")
    expect(out).toMatch(/ntn installed/)
  })

  it("returns ready=false when installNtn fails non-zero (--ntn path)", async () => {
    vi.mocked(isNtnInstalled).mockReturnValue(false)
    vi.mocked(installNtn).mockResolvedValue({ kind: "exit-non-zero", code: 1 })

    const result = await ensurePrerequisites(makeContext(), {
      yes: true,
      ntn: true,
    })

    expect(result.ready).toBe(false)
    expect(captured(consoleErrorSpy)).toMatch(/ntn install failed/)
  })

  it("returns ready=false when installNtn spawn-errors under --ntn (laptop offline during curl-pipe-bash)", async () => {
    // The most likely real-world failure mode for the install path —
    // the auto-install spawn fails before the script can run. The
    // `kind: "spawn-error"` branch is what `auth/ntn.ts` returns
    // on `child_process.spawn` throwing or emitting `error`.
    vi.mocked(isNtnInstalled).mockReturnValue(false)
    vi.mocked(installNtn).mockResolvedValue({
      kind: "spawn-error",
      error: new Error("ENETUNREACH"),
    })

    const result = await ensurePrerequisites(makeContext(), {
      yes: true,
      ntn: true,
    })

    expect(result.ready).toBe(false)
    expect(captured(consoleErrorSpy)).toMatch(/ntn install failed/)
  })

  it("returns ready=false in non-TTY when ntn is missing and --yes is not passed (--ntn path)", async () => {
    vi.mocked(isNtnInstalled).mockReturnValue(false)
    // confirmPrompt detects non-TTY and returns false; we simulate
    // that by stubbing process.stdin.isTTY for the duration of this
    // test.
    const originalIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })
    try {
      const result = await ensurePrerequisites(makeContext(), { ntn: true })
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

describe("ensurePrerequisites — persona routing (PAT vs ntn vs neither)", () => {
  // Default `lore install` (no `--ntn`) routes by persona signal:
  //
  //   - `NOTION_API_TOKEN` set → external (PAT) path; skip `ntn`.
  //   - `ntn` installed → internal path; preserve backward compat for
  //     engineers who upgraded Lore without changing their habits.
  //   - Neither → persona prompt; bail with both-paths guidance.
  //
  // `--ntn` forces the internal path regardless of env state.

  const PRIOR_NOTION_API_TOKEN = process.env["NOTION_API_TOKEN"]

  beforeEach(() => {
    delete process.env["NOTION_API_TOKEN"]
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/prereqs-fake-project/.lore.yaml",
      root: "/tmp/prereqs-fake-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({ vault: { pageId: "page-123" } } as never)
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: "PAT Vault" })
    vi.mocked(checkNtnVersion).mockReturnValue("ok")
    vi.mocked(getNtnVersion).mockReturnValue("0.12.0")
  })

  afterEach(() => {
    vi.clearAllMocks()
    consoleLogSpy.mockClear()
    consoleWarnSpy.mockClear()
    consoleErrorSpy.mockClear()
    if (PRIOR_NOTION_API_TOKEN === undefined) {
      delete process.env["NOTION_API_TOKEN"]
    } else {
      process.env["NOTION_API_TOKEN"] = PRIOR_NOTION_API_TOKEN
    }
  })

  it("takes the PAT path when NOTION_API_TOKEN is set (skips ntn install + version probes)", async () => {
    process.env["NOTION_API_TOKEN"] = "ntn_pat-bearer"
    vi.mocked(isNtnInstalled).mockReturnValue(false)
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "ntn_pat-bearer",
      source: "env-notion-api-token",
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(true)
    // The PAT path must NOT touch `ntn` — neither install nor version
    // probes should fire when an operator pasted a PAT. Routing
    // through them would be both pointless and a noisy onboarding.
    expect(installNtn).not.toHaveBeenCalled()
    expect(runNtnLogin).not.toHaveBeenCalled()
    const out = captured(consoleLogSpy)
    expect(out).toMatch(/Auth path:\s+✓ Personal Access Token \(NOTION_API_TOKEN\)/)
    expect(out).toMatch(/Auth source:\s+✓ NOTION_API_TOKEN/)
    expect(out).toMatch(/Vault page:\s+✓ PAT Vault/)
  })

  it("flags an integration token (`secret_…`) shape on the PAT path with rate-limit guidance", async () => {
    process.env["NOTION_API_TOKEN"] = "secret_oops-integration-token"
    vi.mocked(isNtnInstalled).mockReturnValue(false)
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "secret_oops-integration-token",
      source: "env-notion-api-token",
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    // Informational, not blocking — verifyVaultAccess still runs and
    // returns `ok`, so the install proceeds. The hint exists so the
    // operator can self-diagnose the rate-limit-collapse risk.
    expect(result.ready).toBe(true)
    const out = captured(consoleLogSpy)
    expect(out).toMatch(/integration token from notion\.so\/profile\/integrations/)
    expect(out).toMatch(/PAT/)
    expect(out).toMatch(/notion\.so\/developers\/tokens/)
  })

  it("surfaces persona prompt when ntn is NOT installed AND NOTION_API_TOKEN is unset", async () => {
    // The new "I don't know your persona yet" branch. Print both
    // paths and bail so the operator's next invocation carries
    // enough state to dispatch.
    vi.mocked(isNtnInstalled).mockReturnValue(false)

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(false)
    expect(installNtn).not.toHaveBeenCalled()
    expect(runNtnLogin).not.toHaveBeenCalled()
    const out = captured(consoleLogSpy)
    expect(out).toMatch(/Internal Notion engineer\?/)
    expect(out).toMatch(/lore install --ntn/)
    expect(out).toMatch(/External operator\?/)
    expect(out).toMatch(/notion\.so\/developers\/tokens/)
    expect(out).toMatch(/Do NOT paste an integration token/)
  })

  it("persona prompt mentions --dev when --dev was passed alone", async () => {
    vi.mocked(isNtnInstalled).mockReturnValue(false)

    const result = await ensurePrerequisites(makeContext(), {
      yes: true,
      dev: true,
    })

    expect(result.ready).toBe(false)
    const out = captured(consoleLogSpy)
    // The recovery `--ntn` invocation should preserve the operator's
    // `--dev` choice; the PAT example should use the dev prefix.
    expect(out).toMatch(/lore install --ntn --dev/)
    expect(out).toMatch(/development_ntn_/)
    expect(out).toMatch(/lore install --dev/)
  })

  it("falls back to the ntn path when ntn is installed but no PAT is set (backward compat)", async () => {
    // Internal engineers who upgraded Lore without changing their
    // habits keep their existing flow: ntn-resolved auth.json, no
    // `--ntn` flag required. Matches the install behavior before the
    // PAT announcement so the upgrade isn't a surprise.
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "ntn_resolved-from-auth-json",
      source: "ntn-auth-json",
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(true)
    const out = captured(consoleLogSpy)
    expect(out).toMatch(/ntn installed:\s+✓/)
    expect(out).toMatch(/Auth source:\s+✓ ntn-issued/)
  })
})

describe("ensurePrerequisites — --dev flag propagation", () => {
  // `--dev` explicit wins over both `NOTION_ENV` shell var and
  // `.lore.yaml`'s `auth.baseUrl`. The flag is the most recent
  // explicit operator intent — honoring it preserves the principle
  // that "what the operator just typed" beats stored signals.

  const PRIOR_NOTION_ENV = process.env["NOTION_ENV"]

  beforeEach(() => {
    delete process.env["NOTION_ENV"]
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(checkNtnVersion).mockReturnValue("ok")
    vi.mocked(getNtnVersion).mockReturnValue("0.12.0")
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/dev-flag-test/.lore.yaml",
      root: "/tmp/dev-flag-test",
    })
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    vi.mocked(runNtnLogin).mockResolvedValue({ kind: "success" })
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

  it("forwards NOTION_ENV=dev to ntn login under --ntn --dev when no other env signal is present", async () => {
    // No NOTION_ENV in shell, no auth.baseUrl in config — only the
    // `--dev` flag. The auto-login flow must respect it.
    vi.mocked(loadConfig).mockResolvedValue({ vault: { pageId: "page" } } as never)
    vi.mocked(resolveAuth)
      .mockRejectedValueOnce(new Error("No Notion auth configured."))
      .mockResolvedValueOnce({ token: "tok", source: "ntn-auth-json" })

    const result = await ensurePrerequisites(makeContext(), {
      yes: true,
      ntn: true,
      dev: true,
    })

    expect(result.ready).toBe(true)
    expect(runNtnLogin).toHaveBeenCalledWith({ env: "dev" })
    const out = captured(consoleLogSpy)
    expect(out).toMatch(/--dev was passed/)
  })

  it("--dev overrides a stale auth.baseUrl pointing at prod", async () => {
    // An operator who explicitly types `--dev` against a project
    // whose `.lore.yaml` carries `auth.baseUrl: https://api.notion.so`
    // is saying "ignore that, I want dev today." Honor it.
    vi.mocked(loadConfig).mockResolvedValue({
      vault: { pageId: "page" },
      auth: { baseUrl: "https://api.notion.so" },
    } as never)
    vi.mocked(resolveAuth)
      .mockRejectedValueOnce(new Error("No Notion auth configured."))
      .mockResolvedValueOnce({ token: "tok", source: "ntn-auth-json" })

    const result = await ensurePrerequisites(makeContext(), {
      yes: true,
      ntn: true,
      dev: true,
    })

    expect(result.ready).toBe(true)
    expect(runNtnLogin).toHaveBeenCalledWith({ env: "dev" })
  })
})

describe("ensurePrerequisites — --dev / shell-signal conflict guard", () => {
  // Reviewer call-out: under the previous behavior, `--dev` planted
  // `NOTION_BASE_URL=dev` only when no shell signal existed, but
  // `runInstall` always wrote a literal dev `NOTION_BASE_URL` into
  // MCP env. So `--dev` + `NOTION_ENV=prod` (or `NOTION_BASE_URL=prod`,
  // or `LORE_NOTION_BASE_URL=prod`) preflighted prod and installed
  // dev MCP config. Worse, `LORE_NOTION_BASE_URL` outranks
  // `NOTION_BASE_URL` in `resolveOperatorBaseUrl`'s chain, so the
  // literal would silently lose to the operator's stale signal at
  // MCP-spawn time.
  //
  // Fix: fail-fast at install when `--dev` conflicts with a shell
  // signal. Operator picks which one is real — Lore won't guess.

  const PRIOR = {
    NOTION_ENV: process.env["NOTION_ENV"],
    NOTION_BASE_URL: process.env["NOTION_BASE_URL"],
    NOTION_API_BASE_URL: process.env["NOTION_API_BASE_URL"],
    LORE_NOTION_BASE_URL: process.env["LORE_NOTION_BASE_URL"],
    NOTION_API_TOKEN: process.env["NOTION_API_TOKEN"],
  }

  beforeEach(() => {
    delete process.env["NOTION_ENV"]
    delete process.env["NOTION_BASE_URL"]
    delete process.env["NOTION_API_BASE_URL"]
    delete process.env["LORE_NOTION_BASE_URL"]
    delete process.env["NOTION_API_TOKEN"]
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/conflict-test/.lore.yaml",
      root: "/tmp/conflict-test",
    })
    vi.mocked(loadConfig).mockResolvedValue({ vault: { pageId: "page" } } as never)
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(checkNtnVersion).mockReturnValue("ok")
    vi.mocked(getNtnVersion).mockReturnValue("0.12.0")
  })

  afterEach(() => {
    vi.clearAllMocks()
    consoleLogSpy.mockClear()
    consoleWarnSpy.mockClear()
    consoleErrorSpy.mockClear()
    for (const [k, v] of Object.entries(PRIOR)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it("aborts when --dev conflicts with shell NOTION_ENV=prod", async () => {
    process.env["NOTION_ENV"] = "prod"
    process.env["NOTION_API_TOKEN"] = "ntn_pat-bearer"

    const result = await ensurePrerequisites(makeContext(), { yes: true, dev: true })

    expect(result.ready).toBe(false)
    // verifyVaultAccess must NOT run — install aborts before
    // preflight so we can't validate a target the MCP child won't
    // use.
    expect(verifyVaultAccess).not.toHaveBeenCalled()
    const err = captured(consoleErrorSpy)
    expect(err).toMatch(/--dev was passed but NOTION_ENV=prod routes auth/)
    expect(err).toMatch(/Unset the conflicting shell variable/)
    expect(err).toMatch(/Drop --dev/)
  })

  it("aborts when --dev conflicts with shell NOTION_BASE_URL=prod", async () => {
    process.env["NOTION_BASE_URL"] = "https://api.notion.so"
    process.env["NOTION_API_TOKEN"] = "ntn_pat-bearer"

    const result = await ensurePrerequisites(makeContext(), { yes: true, dev: true })

    expect(result.ready).toBe(false)
    expect(verifyVaultAccess).not.toHaveBeenCalled()
    expect(captured(consoleErrorSpy)).toMatch(
      /NOTION_BASE_URL=https:\/\/api\.notion\.so routes auth/
    )
  })

  it("aborts when --dev conflicts with shell LORE_NOTION_BASE_URL=prod (the placeholder-outranks-literal case)", async () => {
    // The trickiest case from the reviewer's analysis:
    // `LORE_NOTION_BASE_URL` outranks the literal `NOTION_BASE_URL`
    // in the resolver chain. Even if Lore wrote dev as a literal,
    // the operator's shell would re-route runtime to prod via
    // the higher-priority placeholder. Fail-fast catches it before
    // either side lands.
    process.env["LORE_NOTION_BASE_URL"] = "https://api.notion.so"
    process.env["NOTION_API_TOKEN"] = "ntn_pat-bearer"

    const result = await ensurePrerequisites(makeContext(), { yes: true, dev: true })

    expect(result.ready).toBe(false)
    expect(verifyVaultAccess).not.toHaveBeenCalled()
    expect(captured(consoleErrorSpy)).toMatch(
      /LORE_NOTION_BASE_URL=https:\/\/api\.notion\.so routes auth/
    )
  })

  it("aborts when --dev conflicts with shell NOTION_API_BASE_URL=prod", async () => {
    process.env["NOTION_API_BASE_URL"] = "https://api.notion.so"
    process.env["NOTION_API_TOKEN"] = "ntn_pat-bearer"

    const result = await ensurePrerequisites(makeContext(), { yes: true, dev: true })

    expect(result.ready).toBe(false)
    expect(captured(consoleErrorSpy)).toMatch(
      /NOTION_API_BASE_URL=https:\/\/api\.notion\.so routes auth/
    )
  })

  it("aborts when --dev conflicts with a non-canonical shell base URL (corporate proxy)", async () => {
    // `ntnEnvFromBaseUrl` returns undefined for a corporate proxy
    // or any URL Lore doesn't recognize. The safe default is to
    // refuse rather than guess — the operator's signal might mean
    // dev, prod, or something else entirely.
    process.env["NOTION_BASE_URL"] = "https://corporate-proxy.example/notion"
    process.env["NOTION_API_TOKEN"] = "ntn_pat-bearer"

    const result = await ensurePrerequisites(makeContext(), { yes: true, dev: true })

    expect(result.ready).toBe(false)
    expect(captured(consoleErrorSpy)).toMatch(/corporate-proxy/)
  })

  it("proceeds when --dev matches the shell signal (NOTION_ENV=dev)", async () => {
    // The operator's shell already says dev — no conflict.
    process.env["NOTION_ENV"] = "dev"
    process.env["NOTION_API_TOKEN"] = "development_ntn_pat-bearer"
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "development_ntn_pat-bearer",
      source: "env-notion-api-token",
      baseUrl: "https://api-dev.notion.com",
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true, dev: true })

    expect(result.ready).toBe(true)
    expect(verifyVaultAccess).toHaveBeenCalled()
  })

  it("proceeds when --dev is passed with no shell base-URL signal (planting fills in dev)", async () => {
    // No conflicting signal; the existing plant-NOTION_BASE_URL
    // logic in `resolveAndPreflight` handles install-time dev.
    process.env["NOTION_API_TOKEN"] = "development_ntn_pat-bearer"
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "development_ntn_pat-bearer",
      source: "env-notion-api-token",
      baseUrl: "https://api-dev.notion.com",
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true, dev: true })

    expect(result.ready).toBe(true)
    expect(verifyVaultAccess).toHaveBeenCalled()
  })
})

describe("ensurePrerequisites — --ntn shadow advisory when NOTION_API_TOKEN is set", () => {
  // Reviewer concern: under the resolver chain (`NOTION_API_TOKEN >
  // ntn-auth-json`), an operator who runs `lore install --ntn` with
  // a PAT set in their shell silently uses the PAT for the spawned
  // MCP child — not the ntn token they just minted. The describe
  // line was the only signal. Add an explicit advisory naming the
  // shadow + the `unset NOTION_API_TOKEN` remediation.

  const PRIOR = process.env["NOTION_API_TOKEN"]

  beforeEach(() => {
    process.env["NOTION_API_TOKEN"] = "ntn_pat-bearer-token"
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(checkNtnVersion).mockReturnValue("ok")
    vi.mocked(getNtnVersion).mockReturnValue("0.12.0")
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/shadow-test/.lore.yaml",
      root: "/tmp/shadow-test",
    })
    vi.mocked(loadConfig).mockResolvedValue({ vault: { pageId: "page" } } as never)
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
  })

  afterEach(() => {
    vi.clearAllMocks()
    consoleLogSpy.mockClear()
    consoleWarnSpy.mockClear()
    consoleErrorSpy.mockClear()
    if (PRIOR === undefined) delete process.env["NOTION_API_TOKEN"]
    else process.env["NOTION_API_TOKEN"] = PRIOR
  })

  it("prints the shadow advisory when --ntn is explicit and NOTION_API_TOKEN is set", async () => {
    // PAT outranks ntn-auth-json — the MCP child will use the PAT
    // even though --ntn just ran ntn login. Make that visible.
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "ntn_pat-bearer-token",
      source: "env-notion-api-token",
    })

    const result = await ensurePrerequisites(makeContext(), {
      yes: true,
      ntn: true,
    })

    expect(result.ready).toBe(true)
    const out = captured(consoleLogSpy)
    expect(out).toMatch(/NOTION_API_TOKEN:\s+!\s+set in shell — outranks ntn/)
    expect(out).toMatch(/resolver chain \(NOTION_API_TOKEN > ntn-auth-json\)/)
    expect(out).toMatch(/unset NOTION_API_TOKEN/)
  })

  it("does NOT print the shadow advisory when --ntn is set but NOTION_API_TOKEN is unset", async () => {
    // Regression guard: the advisory only fires on the specific
    // shadow case, not as background noise on every --ntn install.
    delete process.env["NOTION_API_TOKEN"]
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok",
      source: "ntn-auth-json",
    })

    const result = await ensurePrerequisites(makeContext(), {
      yes: true,
      ntn: true,
    })

    expect(result.ready).toBe(true)
    const out = captured(consoleLogSpy)
    expect(out).not.toMatch(/NOTION_API_TOKEN:\s+!\s+set in shell/)
    expect(out).not.toMatch(/outranks ntn/)
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
    vi.mocked(resolveAuth).mockRejectedValueOnce(new Error("No Notion auth configured."))

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(false)
    expect(runNtnLogin).not.toHaveBeenCalled()
    const err = captured(consoleErrorSpy)
    expect(err).toMatch(/doesn't[\s\S]*match a known ntn environment/)
    expect(err).toMatch(/NOTION_KEYRING=0 NOTION_ENV=<env> ntn login/)
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
    // the inferred env so the manual `NOTION_KEYRING=0 NOTION_ENV=... ntn login`
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
    vi.mocked(resolveAuth).mockRejectedValueOnce(new Error("No Notion auth configured."))
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

describe("ensurePrerequisites — PAT-source preflight-failure recovery", () => {
  // Reviewer call-out: PAT installs were routing through ntn-specific
  // recovery copy on `not-found` / `unauthorized` — telling external
  // operators to "re-run `NOTION_KEYRING=0 ntn login`" when the right
  // remediation is "rotate the PAT at notion.so/developers/tokens".
  // These tests pin the source-aware split.

  const PRIOR_NOTION_API_TOKEN = process.env["NOTION_API_TOKEN"]

  beforeEach(() => {
    delete process.env["NOTION_API_TOKEN"]
    process.env["NOTION_API_TOKEN"] = "ntn_pat-bearer-token"
    vi.mocked(isNtnInstalled).mockReturnValue(false)
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/prereqs-fake-project/.lore.yaml",
      root: "/tmp/prereqs-fake-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({ vault: { pageId: "page-123" } } as never)
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "ntn_pat-bearer-token",
      source: "env-notion-api-token",
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    consoleLogSpy.mockClear()
    consoleWarnSpy.mockClear()
    consoleErrorSpy.mockClear()
    if (PRIOR_NOTION_API_TOKEN === undefined) {
      delete process.env["NOTION_API_TOKEN"]
    } else {
      process.env["NOTION_API_TOKEN"] = PRIOR_NOTION_API_TOKEN
    }
  })

  it("PAT-source `not-found` routes to PAT-specific recovery (no ntn login mention)", async () => {
    vi.mocked(verifyVaultAccess).mockResolvedValue({
      kind: "not-found",
      pageId: "page-123",
      message: "...",
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(false)
    const err = captured(consoleErrorSpy)
    // PAT-specific recovery: rotate at developers/tokens, share with
    // the PAT's Notion identity.
    expect(err).toMatch(/PAT install/)
    expect(err).toMatch(/notion\.so\/developers\/tokens/)
    expect(err).toMatch(/personal permissions|share/)
    expect(err).toMatch(/Refusing to write MCP config/)
    // MUST NOT route a PAT operator through `ntn login` — that was
    // the reviewer's blocker. The PAT branch never mentions it.
    expect(err).not.toMatch(/ntn login/)
    expect(err).not.toMatch(/NOTION_KEYRING=0/)
    expect(err).not.toMatch(/auth\.json/)
  })

  it("PAT-source `unauthorized` routes to PAT-rotate recovery (no ntn login mention)", async () => {
    vi.mocked(verifyVaultAccess).mockResolvedValue({
      kind: "unauthorized",
      pageId: "page-123",
      message: "Notion rejected the bearer token.",
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(false)
    const err = captured(consoleErrorSpy)
    expect(err).toMatch(/Vault page:\s+✗ unauthorized/)
    expect(err).toMatch(/Rotate the PAT/)
    expect(err).toMatch(/notion\.so\/developers\/tokens/)
    expect(err).toMatch(/Refusing to write MCP config/)
    expect(err).not.toMatch(/ntn login/)
    expect(err).not.toMatch(/NOTION_KEYRING=0/)
  })

  it("PAT-source `unauthorized` flags `secret_` token shape before PAT recovery", async () => {
    process.env["NOTION_API_TOKEN"] = "secret_integration-bearer"
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "secret_integration-bearer",
      source: "env-notion-api-token",
    })
    vi.mocked(verifyVaultAccess).mockResolvedValue({
      kind: "unauthorized",
      pageId: "page-123",
      message: "Notion rejected the bearer token.",
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(false)
    const err = captured(consoleErrorSpy)
    const secretIndex = err.indexOf("secret_…")
    expect(secretIndex).toBeGreaterThanOrEqual(0)
    expect(secretIndex).toBeLessThan(err.indexOf("Recovery:"))
    expect(secretIndex).toBeLessThan(err.indexOf("Rotate the PAT"))
    expect(err).toMatch(/notion\.so\/profile\/integrations/)
  })

  it("PAT-source `not-found` flags `secret_` token shape before PAT recovery", async () => {
    process.env["NOTION_API_TOKEN"] = "secret_integration-bearer"
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "secret_integration-bearer",
      source: "env-notion-api-token",
    })
    vi.mocked(verifyVaultAccess).mockResolvedValue({
      kind: "not-found",
      pageId: "page-123",
      message: "...",
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(false)
    const err = captured(consoleErrorSpy)
    const secretIndex = err.indexOf("secret_…")
    expect(secretIndex).toBeGreaterThanOrEqual(0)
    expect(secretIndex).toBeLessThan(err.indexOf("Most likely causes"))
    expect(secretIndex).toBeLessThan(err.indexOf("The PAT was created"))
    expect(err).toMatch(/notion\.so\/profile\/integrations/)
    expect(err).toMatch(/Rotate to a PAT/)
  })

  it("ntn-source preflight failures still get ntn-specific recovery (regression guard)", async () => {
    // The split must NOT change behavior for ntn operators — they
    // still get `ntn login` recovery + auth.json mention + env-aware
    // command suggestion.
    delete process.env["NOTION_API_TOKEN"]
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(checkNtnVersion).mockReturnValue("ok")
    vi.mocked(getNtnVersion).mockReturnValue("0.12.0")
    vi.mocked(resolveAuth).mockResolvedValue({ token: "tok", source: "ntn-auth-json" })
    vi.mocked(verifyVaultAccess).mockResolvedValue({
      kind: "not-found",
      pageId: "page-123",
      message: "...",
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(false)
    const err = captured(consoleErrorSpy)
    expect(err).toMatch(/ntn login/)
    expect(err).toMatch(/NOTION_KEYRING=0/)
    expect(err).toMatch(/auth\.json|wrong env/)
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
    expect(err).toMatch(/doesn't match a canonical ntn env[\s\S]*substitute <env>/)
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

describe("ensurePrerequisites — Notion environment display", () => {
  // The `Notion environment:` line is driven by the resolved auth's
  // `baseUrl` because that struct is what `createClient` consumes —
  // displaying anything else lies about what the spawned MCP child
  // will actually resolve. The annotation names where that runtime
  // value came from:
  //
  //   - shell env wins for all auth sources (operator-controlled).
  //   - `ntn-auth-json` otherwise reads ntn's `~/.config/notion/config.json`.
  //   - `env-notion-api-token` is shell-only.
  //   - legacy paths honor `.lore.yaml auth.baseUrl` directly.
  //
  // The mismatch warning catches the silent footgun where canonical
  // auth resolves to one deployment but `.lore.yaml auth.baseUrl`
  // declares another — `resolveAuth` intentionally ignores
  // `auth.baseUrl` on canonical paths for security. `.lore.yaml` is
  // local-only but still persistent (backed up, synced, pasteable,
  // one `git add -f` away from history), so it's less trusted than
  // operator env. A `.lore.yaml: auth.baseUrl:
  // https://attacker.example` could otherwise redirect a bearer
  // token; see `resolveAuth` in `src/config.ts`.
  //
  // Keep the PRIOR_ENV map below in lockstep with
  // `describeBaseUrlSource`'s shell-var checks in `install.ts` —
  // adding a new shell signal there without snapshotting it here
  // leaks state between tests.

  const PRIOR_ENV: Record<string, string | undefined> = {
    NOTION_ENV: process.env["NOTION_ENV"],
    LORE_NOTION_BASE_URL: process.env["LORE_NOTION_BASE_URL"],
    NOTION_BASE_URL: process.env["NOTION_BASE_URL"],
    NOTION_API_BASE_URL: process.env["NOTION_API_BASE_URL"],
  }

  beforeEach(() => {
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(checkNtnVersion).mockReturnValue("ok")
    vi.mocked(getNtnVersion).mockReturnValue("0.12.0")
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: "Vault" })
    for (const key of Object.keys(PRIOR_ENV)) {
      delete process.env[key]
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
    consoleLogSpy.mockClear()
    consoleWarnSpy.mockClear()
    consoleErrorSpy.mockClear()
    for (const [key, value] of Object.entries(PRIOR_ENV)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it("displays the env mapped from auth.baseUrl with (from ntn config.json) for ntn-resolved auth", async () => {
    // ntn-resolved with a dev baseUrl that came from ntn's
    // `config.json` (the operator ran `NOTION_ENV=dev ntn login`).
    // Display reflects the runtime baseUrl; annotation names ntn's
    // config.json as the source.
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/dev-project/.lore.yaml",
      root: "/tmp/dev-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({ vault: { pageId: "dev-page" } } as never)
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok",
      source: "ntn-auth-json",
      baseUrl: "https://api-dev.notion.com",
    })

    const result = await ensurePrerequisites(makeContext(), { yes: true })

    expect(result.ready).toBe(true)
    const out = captured(consoleLogSpy)
    expect(out).toMatch(/Notion environment:\s+dev \(from ntn config\.json\)/)
  })

  it("displays prod (ntn default) when ntn-resolved auth.baseUrl is undefined", async () => {
    // `resolveNtnBaseUrl` returns `undefined` for prod (intentional;
    // prod is the SDK default). Pre-fix the line was suppressed;
    // post-fix the operator sees the explicit "prod" target so
    // there's no doubt about which deployment the install will hit.
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/prod-project/.lore.yaml",
      root: "/tmp/prod-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({ vault: { pageId: "page" } } as never)
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok",
      source: "ntn-auth-json",
    })

    await ensurePrerequisites(makeContext(), { yes: true })

    const out = captured(consoleLogSpy)
    expect(out).toMatch(
      /Notion environment:\s+prod \(ntn default; no shell or ntn config\.json override\)/
    )
  })

  it("warns when .lore.yaml auth.baseUrl declares a target the canonical auth source ignores (the silent footgun)", async () => {
    // The bug-repro under the corrected contract: operator's
    // `.lore.yaml` says dev, but ntn-resolved auth landed on prod
    // (operator ran `ntn login` without `NOTION_ENV=dev`). Display
    // is honest about the runtime (prod), AND the warning names the
    // mismatch and the actionable fix. Without this surface the
    // operator hits a generic "vault not accessible" trail with no
    // signal that `.lore.yaml` was silently dropped.
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/dev-project/.lore.yaml",
      root: "/tmp/dev-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({
      vault: { pageId: "dev-page" },
      auth: { baseUrl: "https://api-dev.notion.com" },
    } as never)
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok",
      source: "ntn-auth-json",
    })

    await ensurePrerequisites(makeContext(), { yes: true })

    const out = captured(consoleLogSpy)
    expect(out).toMatch(/Notion environment:\s+prod \(ntn default;/)
    expect(out).toMatch(
      /! \.lore\.yaml declares auth\.baseUrl=dev but resolved auth targets prod/
    )
    expect(out).toMatch(/ntn's config\.json/)
    expect(out).toMatch(/set NOTION_ENV in your shell/)
  })

  it("warns when env-notion-api-token resolves prod and .lore.yaml declares dev", async () => {
    // Same security contract as ntn-auth-json — `auth.baseUrl` is
    // intentionally ignored on `env-notion-api-token` per
    // `src/config.ts:357-358`. The mismatch warning fires for this
    // path too, with a different `sourceHint` reflecting the API
    // token environment as the runtime origin.
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/dev-project/.lore.yaml",
      root: "/tmp/dev-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({
      vault: { pageId: "dev-page" },
      auth: { baseUrl: "https://api-dev.notion.com" },
    } as never)
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok",
      source: "env-notion-api-token",
    })

    await ensurePrerequisites(makeContext(), { yes: true })

    const out = captured(consoleLogSpy)
    expect(out).toMatch(
      /Notion environment:\s+prod \(default; no shell base-URL override\)/
    )
    expect(out).toMatch(/! \.lore\.yaml declares auth\.baseUrl=dev/)
    expect(out).toMatch(/the NOTION_API_TOKEN environment/)
  })

  it("does NOT warn when .lore.yaml auth.baseUrl matches resolved via the .com prod alias", async () => {
    // `https://api.notion.com` aliases to prod via
    // `NTN_ENV_BASE_URL_ALIASES`; resolved is also prod (default).
    // The two map to the same canonical env so the mismatch
    // warning suppresses — pinning the canonical-mapping collapse
    // so a future alias-table change can't silently regress to a
    // false-positive warning on the migration window.
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/prod-project/.lore.yaml",
      root: "/tmp/prod-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({
      vault: { pageId: "prod-page" },
      auth: { baseUrl: "https://api.notion.com" },
    } as never)
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok",
      source: "ntn-auth-json",
    })

    await ensurePrerequisites(makeContext(), { yes: true })

    const out = captured(consoleLogSpy)
    expect(out).toMatch(/Notion environment:\s+prod \(ntn default;/)
    expect(out).not.toMatch(/declares auth\.baseUrl=/)
  })

  it("annotates (from shell LORE_NOTION_BASE_URL) when the shell base-URL var is set, and suppresses any mismatch warning", async () => {
    // Operator explicitly steered the runtime via a shell base-URL
    // var. The annotation names the var so an operator who forgot
    // it was set in a stale shell rc can see why the inference is
    // overridden, and the mismatch warning suppresses because this
    // is no longer a silent footgun.
    process.env["LORE_NOTION_BASE_URL"] = "https://api-dev.notion.com"
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/prod-project/.lore.yaml",
      root: "/tmp/prod-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({
      vault: { pageId: "prod-page" },
      auth: { baseUrl: "https://api.notion.so" },
    } as never)
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok",
      source: "ntn-auth-json",
      baseUrl: "https://api-dev.notion.com",
    })

    await ensurePrerequisites(makeContext(), { yes: true })

    const out = captured(consoleLogSpy)
    expect(out).toMatch(/Notion environment:\s+dev \(from shell LORE_NOTION_BASE_URL\)/)
    expect(out).not.toMatch(/declares auth\.baseUrl=/)
  })

  it("does not annotate NOTION_ENV nor suppress the mismatch warning when NOTION_ENV is unparseable", async () => {
    // `resolveOperatorBaseUrl` only honors `NOTION_ENV` values that
    // `ntnEnvBaseUrl` recognizes; a typo like `NOTION_ENV=devv` does
    // NOT drive the runtime baseUrl. The display must reflect that:
    // attribute the resolved value to its actual source (the
    // auth-source-specific resolver) and keep the mismatch warning
    // eligible so the silent-footgun surface this PR exists to
    // expose isn't silenced by garbage shell input. Without this
    // gate, an operator with a typo'd `NOTION_ENV` and a dev-pinned
    // `.lore.yaml` against a prod ntn login would see
    // `prod (from shell NOTION_ENV=devv)` with no warning — strictly
    // worse than the pre-PR no-line behavior.
    process.env["NOTION_ENV"] = "devv"
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/typo-project/.lore.yaml",
      root: "/tmp/typo-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({
      vault: { pageId: "page" },
      auth: { baseUrl: "https://api-dev.notion.com" },
    } as never)
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok",
      source: "ntn-auth-json",
    })

    await ensurePrerequisites(makeContext(), { yes: true })

    const out = captured(consoleLogSpy)
    expect(out).toMatch(/Notion environment:\s+prod \(ntn default;/)
    expect(out).not.toMatch(/from shell NOTION_ENV=/)
    expect(out).toMatch(
      /! \.lore\.yaml declares auth\.baseUrl=dev but resolved auth targets prod/
    )
  })

  it("annotates (from shell NOTION_ENV=...) when only NOTION_ENV is set", async () => {
    // `NOTION_ENV` is the lowest-priority shell signal; it falls
    // through `resolveOperatorBaseUrl`'s chain to `ntnEnvBaseUrl`.
    // The annotation includes the literal value so an operator
    // sees what's pinned without having to grep their shell rc.
    process.env["NOTION_ENV"] = "stg"
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/stg-project/.lore.yaml",
      root: "/tmp/stg-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({ vault: { pageId: "stg-page" } } as never)
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok",
      source: "ntn-auth-json",
      baseUrl: "https://api-stg.notion.com",
    })

    await ensurePrerequisites(makeContext(), { yes: true })

    const out = captured(consoleLogSpy)
    expect(out).toMatch(/Notion environment:\s+stg \(from shell NOTION_ENV=stg\)/)
  })

  it("displays a non-canonical resolved baseUrl with the URL itself rather than mapping it to an env", async () => {
    // Corporate-proxy / unknown deployment URLs that
    // `ntnEnvFromBaseUrl` can't recognize. Surface the URL itself
    // tagged `non-canonical` so the operator sees what's pinned
    // even though Lore can't name the env.
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/corp-project/.lore.yaml",
      root: "/tmp/corp-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({
      vault: { pageId: "corp-page" },
      auth: { baseUrl: "https://notion.corp.example.com" },
    } as never)
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok",
      source: "ntn-auth-json",
      baseUrl: "https://notion.corp.example.com",
    })

    await ensurePrerequisites(makeContext(), { yes: true })

    const out = captured(consoleLogSpy)
    expect(out).toMatch(
      /Notion environment:\s+https:\/\/notion\.corp\.example\.com \(from ntn config\.json\), non-canonical/
    )
  })

  it("treats empty-string .lore.yaml auth.baseUrl as no signal (no mismatch warning)", async () => {
    // Defensive pin against a future refactor that switches to a
    // strict `!== undefined` check on the config baseUrl probe.
    // The Zod schema for `auth.baseUrl` allows any URL string, but
    // an empty string slipping through must NOT fire the mismatch
    // warning with a `(non-canonical)` empty-URL message.
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/prod-project/.lore.yaml",
      root: "/tmp/prod-project",
    })
    vi.mocked(loadConfig).mockResolvedValue({
      vault: { pageId: "prod-page" },
      auth: { baseUrl: "" },
    } as never)
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok",
      source: "ntn-auth-json",
    })

    await ensurePrerequisites(makeContext(), { yes: true })

    const out = captured(consoleLogSpy)
    expect(out).toMatch(/Notion environment:\s+prod \(ntn default;/)
    expect(out).not.toMatch(/declares auth\.baseUrl=/)
  })
})
