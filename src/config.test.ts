import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { parse as parseYaml } from "yaml"
import {
  loadConfig,
  parseConfigAllowingInvalidHooks,
  resolveAuth,
  resolveToken,
} from "./config.js"
import { configKey } from "./hooks/marker-key.js"
import type { LoreConfig } from "./types.js"

describe("parseConfigAllowingInvalidHooks", () => {
  it("preserves a valid hooks section", () => {
    const { config, warnings } = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
hooks:
  wakeUp: false
  saveInterval: 3
`)

    expect(warnings).toEqual([])
    expect(config.hooks).toEqual({ wakeUp: false, saveInterval: 3 })
  })

  it("parses hooks.learningExtraction as a boolean (0.9.0/08)", () => {
    // The 0.9.0 atomic-learning extraction knob lives next to autoSave /
    // wakeUp / autoDigest in the hooks Zod schema. Pin both polarities
    // so a future schema edit that drops the field surfaces here as a
    // failure rather than silently degrading to "always-on".
    const off = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
hooks:
  learningExtraction: false
`)
    expect(off.warnings).toEqual([])
    expect(off.config.hooks).toEqual({ learningExtraction: false })

    const on = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
hooks:
  learningExtraction: true
`)
    expect(on.warnings).toEqual([])
    expect(on.config.hooks).toEqual({ learningExtraction: true })
  })

  it("rejects non-boolean hooks.learningExtraction the same way it rejects other invalid hook flags", () => {
    // Same fail-open posture as the existing wakeUp regression: a
    // typo'd value drops the entire hooks section and warns rather
    // than crashing the helper.
    const { config, warnings } = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
hooks:
  learningExtraction: maybe
`)

    expect(config.vault.pageId).toBe("abc123")
    expect(config.hooks).toBeUndefined()
    expect(warnings).toEqual(["Ignoring invalid hooks config and using hook defaults."])
  })

  it("drops invalid hooks values while keeping the rest of the config", () => {
    const { config, warnings } = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
hooks:
  wakeUp: nope
`)

    expect(config.vault.pageId).toBe("abc123")
    expect(config.hooks).toBeUndefined()
    expect(warnings).toEqual(["Ignoring invalid hooks config and using hook defaults."])
  })

  it("drops the hooks section after YAML parse errors so wake-up fails open", () => {
    const { config, warnings } = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
hooks:
    wakeUp: false
   saveInterval: 5
`)

    expect(config.vault.pageId).toBe("abc123")
    expect(config.hooks).toBeUndefined()
    expect(warnings[0]).toContain("All mapping items must start at the same column")
  })

  it("parses optional vault topology fields without changing single-vault defaults", () => {
    const single = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
`)
    expect(single.warnings).toEqual([])
    expect(single.config.upstreamVaults).toBeUndefined()
    expect(single.config.promotionTargets).toBeUndefined()

    const { config, warnings } = parseConfigAllowingInvalidHooks(`
vault:
  pageId: project-vault
upstreamVaults:
  - name: Engineering
    pageId: engineering-vault
    priority: 10
promotionTargets:
  - name: Team
    pageId: team-vault
    requireReview: true
`)

    expect(warnings).toEqual([])
    expect(config.upstreamVaults).toEqual([
      {
        name: "Engineering",
        pageId: "engineering-vault",
        priority: 10,
      },
    ])
    expect(config.promotionTargets).toEqual([
      { name: "Team", pageId: "team-vault", requireReview: true },
    ])
  })

  it("rejects bearer-shaped auth.token values at parse time", () => {
    for (const token of [
      "secret_real_notion_integration_token",
      "ntn_real_notion_user_token",
      "Bearer secret_real_notion_integration_token",
    ]) {
      expect(() =>
        parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
auth:
  token: ${token}
`),
      ).toThrow(/auth\.token in \.lore\.yaml cannot contain a Notion bearer token/)
    }
  })

  it("allows non-bearer legacy auth.token placeholders", () => {
    const { config, warnings } = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
auth:
  token: tok-from-config
`)

    expect(warnings).toEqual([])
    expect(config.auth?.token).toBe("tok-from-config")
  })

  it("rejects bearer-shaped auth.token values loaded from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-config-load-"))
    const path = join(dir, ".lore.yaml")
    writeFileSync(
      path,
      `
vault:
  pageId: abc123
auth:
  token: ntn_real_notion_user_token
`,
    )

    try {
      await expect(loadConfig(path)).rejects.toThrow(
        /auth\.token in \.lore\.yaml cannot contain a Notion bearer token/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects starter page ID placeholders before Notion calls", () => {
    expect(() =>
      parseConfigAllowingInvalidHooks(`
vault:
  pageId: "<your-vault-page-id>"
`),
    ).toThrow(/starter placeholder/)
  })

  it("rejects placeholder page IDs in named vault references", () => {
    expect(() =>
      parseConfigAllowingInvalidHooks(`
vault:
  pageId: primary-vault
upstreamVaults:
  - name: Engineering
    pageId: "<engineering-vault-page-id>"
`),
    ).toThrow(/starter placeholder/)
  })
})

describe("committed .lore.yaml", () => {
  it("ships with shared vault config and without credentials", () => {
    const raw = readFileSync(new URL("../.lore.yaml", import.meta.url), "utf-8")
    const parsed = parseYaml(raw) as {
      auth?: { token?: unknown }
      vault?: { pageId?: unknown }
    }
    const serializedConfig = JSON.stringify(parsed)
    const pageId = parsed.vault?.pageId

    expect(parsed.auth?.token).toBeUndefined()
    expect(pageId).toBe("343b35e6e67f81a0afa9c9801b35199f")
    expect(serializedConfig).not.toMatch(/ntn_|secret_/)
  })

  it("fails fast at config load time until a placeholder is replaced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-placeholder-config-"))
    const path = join(dir, ".lore.yaml")
    writeFileSync(
      path,
      `
vault:
  pageId: "<your-vault-page-id>"
`,
    )

    try {
      await expect(loadConfig(path)).rejects.toThrow(/starter placeholder/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// resolveAuth (0.10.0 ntn-first priority chain)
// ---------------------------------------------------------------------------

const SCRATCH = mkdtempSync(join(tmpdir(), "lore-config-resolveauth-"))

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

/**
 * Lay down a fresh `XDG_CONFIG_HOME` so #02's `loadNtnToken` resolves
 * against an isolated scratch dir. With `body` undefined, no
 * `auth.json` is written — i.e. ntn is "not logged in" for this test.
 *
 * Test-isolation contract: this helper relies on `ntnAuthJsonPath()` in
 * `src/auth/ntn.ts` reading `XDG_CONFIG_HOME` at call time, NOT at module
 * load. Do not introduce a module-scope cache in `auth/ntn.ts` for the
 * resolved path or the parsed `auth.json` — vitest's per-file module
 * registry would carry that cache across test cases and silently break
 * isolation here.
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

/**
 * Lay down a fresh hook state dir for the deprecation marker. Each test
 * gets its own directory so concurrent runs (and within-suite ordering)
 * never see each other's markers.
 */
function setupHookStateDir(): string {
  const dir = mkdtempSync(join(SCRATCH, "hook-state-"))
  process.env["LORE_HOOK_STATE_DIR"] = dir
  return dir
}

/**
 * Path the deprecation marker should land at for the given configRoot —
 * mirrors `emitDeprecationWarningOnce`'s join, so a drift between the
 * production code and the test surfaces here as a missing-file
 * assertion.
 */
function deprecationMarkerPath(configRoot: string): string {
  const stateDir = process.env["LORE_HOOK_STATE_DIR"]
  if (!stateDir) throw new Error("LORE_HOOK_STATE_DIR not set")
  return join(stateDir, `auth-deprecation.${configKey(configRoot)}.last`)
}

let stderrChunks: string[] = []
const stderrText = (): string => stderrChunks.join("")

const ENV_KEYS_TO_CLEAR = [
  "NOTION_API_TOKEN",
  "LORE_NOTION_TOKEN",
  "NOTION_WORKSPACE_ID",
  "LORE_NOTION_BASE_URL",
  // ntn-native base-URL fallbacks consumed by `resolveOperatorBaseUrl`.
  "NOTION_BASE_URL",
  "NOTION_API_BASE_URL",
  "NOTION_ENV",
  "LORE_SUPPRESS_DEPRECATIONS",
  "XDG_CONFIG_HOME",
  "LORE_HOOK_STATE_DIR",
]

describe("resolveAuth", () => {
  // Scoped to this describe block so the stderr spy + env cleanup
  // doesn't fire on every parseConfigAllowingInvalidHooks test.
  beforeEach(() => {
    stderrChunks = []
    // Clear inherited shell env BEFORE each test so a developer with
    // (e.g.) LORE_NOTION_BASE_URL or LORE_NOTION_TOKEN exported in
    // their shell rc doesn't see false positives. afterEach also
    // clears, but starting clean defends against the very first test
    // in the file.
    for (const key of ENV_KEYS_TO_CLEAR) delete process.env[key]
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
    for (const key of ENV_KEYS_TO_CLEAR) delete process.env[key]
  })

  it("returns source: env-notion-api-token when NOTION_API_TOKEN is set", async () => {
    setupNtnConfigHome() // no auth.json — ntn path returns null
    setupHookStateDir()
    process.env["NOTION_API_TOKEN"] = "tok-from-env-api"

    const result = await resolveAuth(undefined, SCRATCH)
    expect(result).toEqual({
      token: "tok-from-env-api",
      baseUrl: undefined,
      source: "env-notion-api-token",
    })
    // Canonical-source path is silent — no deprecation warning.
    expect(stderrText()).toBe("")
  })

  it("REJECTS auth.baseUrl from .lore.yaml on the NOTION_API_TOKEN path (security: token-redirect attack)", async () => {
    // A checked-in `.lore.yaml` is repo-controlled, not
    // operator-controlled. If `auth.baseUrl` from config flowed into
    // the canonical NOTION_API_TOKEN path, a malicious `.lore.yaml`
    // could redirect every Notion call to an attacker-controlled host
    // and exfiltrate the engineer's bearer token. Pin the rejection
    // so a regression here surfaces as a test failure rather than a
    // production exfiltration. Operators who genuinely need a custom
    // base URL set `LORE_NOTION_BASE_URL` (operator-controlled env).
    setupNtnConfigHome()
    setupHookStateDir()
    process.env["NOTION_API_TOKEN"] = "tok-from-env-api"

    const config: LoreConfig = {
      vault: { pageId: "abc" },
      auth: { baseUrl: "https://attacker.example" },
    }
    const result = await resolveAuth(config, SCRATCH)
    expect(result.baseUrl).toBeUndefined()
  })

  it("HONORS LORE_NOTION_BASE_URL env on the NOTION_API_TOKEN path (operator-controlled override)", async () => {
    // The shell-rc env var is the operator-controlled escape hatch
    // for non-prod endpoints. Since shell rc lives outside the repo,
    // it can't be hijacked by a malicious checked-in `.lore.yaml`.
    setupNtnConfigHome()
    setupHookStateDir()
    process.env["NOTION_API_TOKEN"] = "tok-from-env-api"
    process.env["LORE_NOTION_BASE_URL"] = "https://api-dev.notion.com"

    const result = await resolveAuth(undefined, SCRATCH)
    expect(result.baseUrl).toBe("https://api-dev.notion.com")
  })

  it("HONORS NOTION_BASE_URL (ntn-native) on the NOTION_API_TOKEN path when LORE_NOTION_BASE_URL is unset", async () => {
    // ntn's documented native base-URL override. Operators who export
    // NOTION_BASE_URL (the `ntn --help`-documented form) must see it
    // honored — otherwise install-time preflight would resolve dev
    // (via this path) but the shell rc would feel inconsistent.
    setupNtnConfigHome()
    setupHookStateDir()
    process.env["NOTION_API_TOKEN"] = "tok-from-env-api"
    process.env["NOTION_BASE_URL"] = "https://api-dev.notion.com"

    const result = await resolveAuth(undefined, SCRATCH)
    expect(result.baseUrl).toBe("https://api-dev.notion.com")
  })

  it("HONORS NOTION_API_BASE_URL (legacy ntn name) when neither LORE_NOTION_BASE_URL nor NOTION_BASE_URL is set", async () => {
    // Same posture as NOTION_BASE_URL — `resolveOperatorBaseUrl`
    // walks all three names in priority order, so the lowest-priority
    // ntn name still gets honored when nothing higher is set.
    setupNtnConfigHome()
    setupHookStateDir()
    process.env["NOTION_API_TOKEN"] = "tok-from-env-api"
    process.env["NOTION_API_BASE_URL"] = "https://api-stg.notion.com"

    const result = await resolveAuth(undefined, SCRATCH)
    expect(result.baseUrl).toBe("https://api-stg.notion.com")
  })

  it("LORE_NOTION_BASE_URL still wins over the ntn-native names (priority order)", async () => {
    // The Lore-namespaced override is the highest priority — when
    // both are set, the operator's explicit Lore choice beats the
    // ambient ntn-shaped value.
    setupNtnConfigHome()
    setupHookStateDir()
    process.env["NOTION_API_TOKEN"] = "tok-from-env-api"
    process.env["LORE_NOTION_BASE_URL"] = "https://lore-explicit.notion.com"
    process.env["NOTION_BASE_URL"] = "https://ntn-fallback.notion.com"

    const result = await resolveAuth(undefined, SCRATCH)
    expect(result.baseUrl).toBe("https://lore-explicit.notion.com")
  })

  it("REJECTS auth.baseUrl from .lore.yaml on the ntn-auth-json path (security)", async () => {
    // Same security rationale as the NOTION_API_TOKEN path. ntn-issued
    // tokens are bearer credentials inheriting the engineer's Notion
    // permissions; redirecting them would be just as exfiltration-y.
    setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-ntn" }))
    setupHookStateDir()

    const config: LoreConfig = {
      vault: { pageId: "abc" },
      auth: { baseUrl: "https://attacker.example" },
    }
    const result = await resolveAuth(config, SCRATCH)
    expect(result.source).toBe("ntn-auth-json")
    expect(result.baseUrl).toBeUndefined()
    // ntn's own LORE_NOTION_BASE_URL handling is verified separately;
    // the point of this test is purely "do NOT pick up the repo
    // override when the canonical source resolved."
  })

  it("HONORS auth.baseUrl from .lore.yaml on the LEGACY env-lore-notion-token path (back-compat)", async () => {
    // Operators on the soft-deprecated path are already trusting
    // `.lore.yaml` for their workflow — preserving auth.baseUrl
    // semantics keeps existing setups working. The migration path
    // (#07) routes them off the legacy token entirely.
    setupNtnConfigHome()
    setupHookStateDir()
    process.env["LORE_NOTION_TOKEN"] = "tok-legacy-env"

    const config: LoreConfig = {
      vault: { pageId: "abc" },
      auth: { baseUrl: "https://api-dev.notion.com" },
    }
    const result = await resolveAuth(config, SCRATCH)
    expect(result.source).toBe("env-lore-notion-token")
    expect(result.baseUrl).toBe("https://api-dev.notion.com")
  })

  it("HONORS auth.baseUrl from .lore.yaml on the LEGACY config-auth-token path (back-compat)", async () => {
    setupNtnConfigHome()
    setupHookStateDir()

    const config: LoreConfig = {
      vault: { pageId: "abc" },
      auth: {
        token: "tok-from-config",
        baseUrl: "https://api-dev.notion.com",
      },
    }
    const result = await resolveAuth(config, SCRATCH)
    expect(result.source).toBe("config-auth-token")
    expect(result.baseUrl).toBe("https://api-dev.notion.com")
  })

  it("returns source: ntn-auth-json with workspaceId when only ntn resolves a token", async () => {
    setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-ntn" }))
    setupHookStateDir()

    const result = await resolveAuth(undefined, SCRATCH)
    expect(result).toEqual({
      token: "tok-ntn",
      baseUrl: undefined,
      source: "ntn-auth-json",
      workspaceId: "ws-1",
    })
    expect(stderrText()).toBe("")
  })

  it("threads NOTION_WORKSPACE_ID env into the ntn selector", async () => {
    setupNtnConfigHome(
      JSON.stringify({ "ws-1": "tok-1", "ws-2": "tok-2" }),
    )
    setupHookStateDir()
    process.env["NOTION_WORKSPACE_ID"] = "ws-2"

    const result = await resolveAuth(undefined, SCRATCH)
    expect(result).toMatchObject({ token: "tok-2", workspaceId: "ws-2" })
  })

  it("threads config.auth.workspaceId into the ntn selector when env is absent", async () => {
    setupNtnConfigHome(
      JSON.stringify({ "ws-1": "tok-1", "ws-2": "tok-2" }),
    )
    setupHookStateDir()

    const config: LoreConfig = {
      vault: { pageId: "abc" },
      auth: { workspaceId: "ws-1" },
    }
    const result = await resolveAuth(config, SCRATCH)
    expect(result).toMatchObject({ token: "tok-1", workspaceId: "ws-1" })
  })

  it("returns source: env-lore-notion-token AND emits deprecation warning when only LORE_NOTION_TOKEN is set", async () => {
    setupNtnConfigHome() // ntn returns null
    setupHookStateDir()
    process.env["LORE_NOTION_TOKEN"] = "tok-legacy-env"

    const result = await resolveAuth(undefined, SCRATCH)
    expect(result).toEqual({
      token: "tok-legacy-env",
      baseUrl: undefined,
      source: "env-lore-notion-token",
    })
    expect(stderrText()).toContain("LORE_NOTION_TOKEN is soft-deprecated")
    // Recommended migration command is `lore auth --migrate` (the
    // canonical Phase-2 wrapper for env-source migration); the
    // unset-and-rerun path is the manual fallback inside the same line.
    expect(stderrText()).toContain("lore auth --migrate")
    expect(stderrText()).toContain("LORE_SUPPRESS_DEPRECATIONS=1")
  })

  it("returns source: config-auth-token AND emits deprecation warning when only auth.token is set", async () => {
    setupNtnConfigHome()
    setupHookStateDir()

    const config: LoreConfig = {
      vault: { pageId: "abc" },
      auth: { token: "tok-from-config" },
    }
    const result = await resolveAuth(config, SCRATCH)
    expect(result).toEqual({
      token: "tok-from-config",
      baseUrl: undefined,
      source: "config-auth-token",
    })
    expect(stderrText()).toContain("auth.token in .lore.yaml is soft-deprecated")
    // Pin the branch-specific recommendation so a copy-paste swap of
    // the env-vs-config message bodies is caught. The config branch
    // recommends `lore auth --login` (re-auth via ntn) plus a
    // remove-auth.token instruction; the env branch recommends
    // `lore auth --migrate` instead.
    expect(stderrText()).toContain("lore auth --login")
    expect(stderrText()).toContain("remove the auth.token field")
    expect(stderrText()).not.toContain("lore auth --migrate")
  })

  it("priority: NOTION_API_TOKEN wins over ntn + LORE_NOTION_TOKEN + auth.token", async () => {
    setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-ntn" }))
    setupHookStateDir()
    process.env["NOTION_API_TOKEN"] = "tok-canonical"
    process.env["LORE_NOTION_TOKEN"] = "tok-legacy-env"

    const config: LoreConfig = {
      vault: { pageId: "abc" },
      auth: { token: "tok-from-config" },
    }
    const result = await resolveAuth(config, SCRATCH)
    expect(result.source).toBe("env-notion-api-token")
    expect(result.token).toBe("tok-canonical")
    // The canonical source still wins, but a token sitting in the
    // committable repo config is warned about even when masked.
    expect(stderrText()).toContain("auth.token in .lore.yaml is soft-deprecated")
    expect(stderrText()).toContain("remove the auth.token field")
  })

  it("priority: ntn wins over LORE_NOTION_TOKEN", async () => {
    setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-ntn" }))
    setupHookStateDir()
    process.env["LORE_NOTION_TOKEN"] = "tok-legacy-env"

    const result = await resolveAuth(undefined, SCRATCH)
    expect(result.source).toBe("ntn-auth-json")
    expect(result.token).toBe("tok-ntn")
    expect(stderrText()).toBe("")
  })

  it("priority: LORE_NOTION_TOKEN wins over auth.token", async () => {
    setupNtnConfigHome() // ntn absent
    setupHookStateDir()
    process.env["LORE_NOTION_TOKEN"] = "tok-legacy-env"

    const config: LoreConfig = {
      vault: { pageId: "abc" },
      auth: { token: "tok-from-config" },
    }
    const result = await resolveAuth(config, SCRATCH)
    expect(result.source).toBe("env-lore-notion-token")
    expect(result.token).toBe("tok-legacy-env")
    // The env token wins, but the inline token is still unsafe in a
    // committable `.lore.yaml`, so the config-specific warning fires.
    expect(stderrText()).toContain("auth.token in .lore.yaml is soft-deprecated")
    expect(stderrText()).toContain("remove the auth.token field")
  })

  it("debounces the deprecation warning — second call within 24h does not re-emit", async () => {
    setupNtnConfigHome()
    setupHookStateDir()
    process.env["LORE_NOTION_TOKEN"] = "tok-legacy-env"

    await resolveAuth(undefined, SCRATCH)
    const firstEmission = stderrText()
    expect(firstEmission).toContain("LORE_NOTION_TOKEN is soft-deprecated")

    // Marker landed.
    expect(() => statSync(deprecationMarkerPath(SCRATCH))).not.toThrow()

    stderrChunks = []
    await resolveAuth(undefined, SCRATCH)
    expect(stderrText()).toBe("")
  })

  it("re-emits after the marker mtime falls outside the 24h debounce window", async () => {
    setupNtnConfigHome()
    setupHookStateDir()
    process.env["LORE_NOTION_TOKEN"] = "tok-legacy-env"

    await resolveAuth(undefined, SCRATCH)
    expect(stderrText()).toContain("LORE_NOTION_TOKEN is soft-deprecated")

    // Backdate the marker so the next call sees an aged-out window.
    const marker = deprecationMarkerPath(SCRATCH)
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(marker, twoDaysAgo, twoDaysAgo)

    stderrChunks = []
    await resolveAuth(undefined, SCRATCH)
    expect(stderrText()).toContain("LORE_NOTION_TOKEN is soft-deprecated")
  })

  it("LORE_SUPPRESS_DEPRECATIONS=1 suppresses both emission AND marker write", async () => {
    setupNtnConfigHome()
    setupHookStateDir()
    process.env["LORE_NOTION_TOKEN"] = "tok-legacy-env"
    process.env["LORE_SUPPRESS_DEPRECATIONS"] = "1"

    const result = await resolveAuth(undefined, SCRATCH)
    expect(result.source).toBe("env-lore-notion-token")
    expect(stderrText()).toBe("")
    // Suppressed runs do NOT touch the marker — a later un-suppressed
    // call within the same window otherwise loses the chance to emit.
    expect(() => statSync(deprecationMarkerPath(SCRATCH))).toThrow()
  })

  it("after a suppressed call, a subsequent un-suppressed call still emits", async () => {
    setupNtnConfigHome()
    setupHookStateDir()
    process.env["LORE_NOTION_TOKEN"] = "tok-legacy-env"

    process.env["LORE_SUPPRESS_DEPRECATIONS"] = "1"
    await resolveAuth(undefined, SCRATCH)
    expect(stderrText()).toBe("")

    delete process.env["LORE_SUPPRESS_DEPRECATIONS"]
    stderrChunks = []
    await resolveAuth(undefined, SCRATCH)
    expect(stderrText()).toContain("LORE_NOTION_TOKEN is soft-deprecated")
  })

  it("suppressed run within debounce window does NOT extend the window — pre-existing marker still no-ops the next un-suppressed call", async () => {
    // Spec acceptance criterion: "Suppressed runs do not extend the
    // debounce window, so an un-suppressed call within 24h of the
    // *original* marker write still no-ops via the existing marker."
    // Sequence: emit (marker landed) → suppressed call within window
    // (must NOT touch marker) → un-suppressed call within window
    // (the original marker still suppresses).
    setupNtnConfigHome()
    setupHookStateDir()
    process.env["LORE_NOTION_TOKEN"] = "tok-legacy-env"

    // T=0: first un-suppressed call emits and lands the marker.
    await resolveAuth(undefined, SCRATCH)
    expect(stderrText()).toContain("LORE_NOTION_TOKEN is soft-deprecated")
    const markerStat = statSync(deprecationMarkerPath(SCRATCH))
    const originalMtimeMs = markerStat.mtimeMs

    // T=10h (simulated): suppressed call. The mtime must NOT be touched.
    process.env["LORE_SUPPRESS_DEPRECATIONS"] = "1"
    stderrChunks = []
    await resolveAuth(undefined, SCRATCH)
    expect(stderrText()).toBe("")
    expect(statSync(deprecationMarkerPath(SCRATCH)).mtimeMs).toBe(originalMtimeMs)

    // T=12h (simulated): un-suppressed call. The original marker still
    // sits within the 24h window, so emission must remain silent — the
    // suppressed call did NOT slide the window forward.
    delete process.env["LORE_SUPPRESS_DEPRECATIONS"]
    stderrChunks = []
    await resolveAuth(undefined, SCRATCH)
    expect(stderrText()).toBe("")
  })

  it("throws with the documented recommendation when no source produces a token", async () => {
    setupNtnConfigHome() // ntn absent
    setupHookStateDir()

    // Now that issue 0.10.0/06 has shipped `lore auth --login`, the
    // throw message recommends the canonical wrapper as the primary
    // path and `NOTION_API_TOKEN` as the alternative. The thrown
    // message is forwarded to the operator by `lore auth --status` /
    // `--login` / `--whoami`; it must NOT contain stale
    // "Phase 2 will ship" copy that would contradict the wrapper
    // those very commands provide.
    await expect(resolveAuth(undefined, SCRATCH)).rejects.toThrow(
      /No Notion auth configured/,
    )
    await expect(resolveAuth(undefined, SCRATCH)).rejects.toThrow(
      /lore auth --login/,
    )
    await expect(resolveAuth(undefined, SCRATCH)).rejects.toThrow(
      /NOTION_API_TOKEN/,
    )
    // The stale "Phase 2 will ship" copy must be gone.
    await expect(resolveAuth(undefined, SCRATCH)).rejects.not.toThrow(
      /once Phase 2/,
    )
  })

  it("throw message inlines the ntn ambiguity hint when auth.json carries multiple workspaces", async () => {
    // The hint is suppressed (via `quiet: true`) on the `loadNtnToken`
    // call so it doesn't fight the deprecation emitter when a legacy
    // fallback resolves. At the throw site (no source resolved), we
    // re-detect the ambiguity case and surface a single hint listing
    // the available workspaces — gives operators a concrete next step.
    setupNtnConfigHome(
      JSON.stringify({ "ws-1": "tok-1", "ws-2": "tok-2" }),
    )
    setupHookStateDir()

    await expect(resolveAuth(undefined, SCRATCH)).rejects.toThrow(
      /carries 2 workspaces/,
    )
    await expect(resolveAuth(undefined, SCRATCH)).rejects.toThrow(
      /NOTION_WORKSPACE_ID/,
    )
    await expect(resolveAuth(undefined, SCRATCH)).rejects.toThrow(
      /Available: ws-1, ws-2/,
    )
  })

  it("throw message inlines the selector-miss hint when auth.json doesn't carry the requested workspace", async () => {
    setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-1" }))
    setupHookStateDir()
    process.env["NOTION_WORKSPACE_ID"] = "ws-missing"

    await expect(resolveAuth(undefined, SCRATCH)).rejects.toThrow(
      /requested workspaceId \(ws-missing\) is not among them/,
    )
    await expect(resolveAuth(undefined, SCRATCH)).rejects.toThrow(
      /Available: ws-1/,
    )
    // Recovery recommendation MUST point at `lore auth --login` (the
    // canonical wrapper that forces NOTION_KEYRING=0). Bare
    // `ntn login` on macOS defaults to keychain mode and writes
    // nothing to auth.json, so a recovery hint that recommended it
    // would loop the operator back into this same selector miss on
    // the next run. Round-4 review blocker; pin against revert.
    await expect(resolveAuth(undefined, SCRATCH)).rejects.toThrow(
      /lore auth --login/,
    )
    // The bare-ntn-login wording must NOT appear standalone (the
    // recommendation can't substitute it for the wrapper).
    await expect(resolveAuth(undefined, SCRATCH)).rejects.not.toThrow(
      /Run `ntn login` against/,
    )
  })

  it("multi-workspace ntn + no selector falls through to LORE_NOTION_TOKEN WITHOUT ntn stderr noise", async () => {
    // Strong-concern from the 0.10.0/01 review: when ntn has multiple
    // workspaces and no selector AND a legacy fallback resolves, the
    // operator must NOT see two contradictory stderr lines (ntn's
    // "set NOTION_WORKSPACE_ID" + the deprecation emitter's "migrate
    // away from LORE_NOTION_TOKEN"). `quiet: true` on the
    // `loadNtnToken` call suppresses the ntn hint so only the
    // deprecation warning fires.
    setupNtnConfigHome(
      JSON.stringify({ "ws-1": "tok-1", "ws-2": "tok-2" }),
    )
    setupHookStateDir()
    process.env["LORE_NOTION_TOKEN"] = "tok-legacy-env"

    const result = await resolveAuth(undefined, SCRATCH)
    expect(result.source).toBe("env-lore-notion-token")
    // The ntn ambiguity hint must NOT have fired.
    expect(stderrText()).not.toContain("specify one via NOTION_WORKSPACE_ID")
    // The deprecation warning is the only stderr output.
    expect(stderrText()).toContain("LORE_NOTION_TOKEN is soft-deprecated")
  })
})

describe("resolveToken", () => {
  beforeEach(() => {
    stderrChunks = []
    // Clear inherited shell env BEFORE each test so a developer with
    // (e.g.) LORE_NOTION_BASE_URL or LORE_NOTION_TOKEN exported in
    // their shell rc doesn't see false positives. afterEach also
    // clears, but starting clean defends against the very first test
    // in the file.
    for (const key of ENV_KEYS_TO_CLEAR) delete process.env[key]
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
    for (const key of ENV_KEYS_TO_CLEAR) delete process.env[key]
  })

  it("returns the same token resolveAuth produces", async () => {
    setupNtnConfigHome()
    setupHookStateDir()
    process.env["NOTION_API_TOKEN"] = "tok-from-env-api"

    expect(await resolveToken(undefined, SCRATCH)).toBe("tok-from-env-api")
  })

  it("propagates configRoot to the deprecation-marker keying", async () => {
    setupNtnConfigHome()
    setupHookStateDir()
    process.env["LORE_NOTION_TOKEN"] = "tok-legacy-env"

    const altRoot = join(SCRATCH, "alt-root")
    await resolveToken(undefined, altRoot)
    // Marker lands under the alt-root's hash, not SCRATCH's — proves
    // the configRoot argument flowed through.
    expect(() => statSync(deprecationMarkerPath(altRoot))).not.toThrow()
    expect(() => statSync(deprecationMarkerPath(SCRATCH))).toThrow()
  })
})
