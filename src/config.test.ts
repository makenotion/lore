import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  loadConfig,
  parseConfigAllowingInvalidHooks,
  resolveAuth,
  resolveToken,
} from "./config.js"
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

  it("parses hooks.proposeAutosaveLearnings as a boolean (issue #281, AC #1)", () => {
    // Phase 3 of the proposed-memory inbox epic ships the
    // `hooks.proposeAutosaveLearnings` flag for routing
    // auto-extracted learnings through the review inbox. The Zod
    // schema must accept the field; without it Zod's default strip
    // mode silently drops the key and `mergeHookDefaults` falls back
    // to `false`, defeating the operator's opt-in.
    const off = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
hooks:
  proposeAutosaveLearnings: false
`)
    expect(off.warnings).toEqual([])
    expect(off.config.hooks).toEqual({ proposeAutosaveLearnings: false })

    const on = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
hooks:
  proposeAutosaveLearnings: true
`)
    expect(on.warnings).toEqual([])
    expect(on.config.hooks).toEqual({ proposeAutosaveLearnings: true })
  })

  it("rejects non-boolean hooks.proposeAutosaveLearnings the same way it rejects other invalid hook flags", () => {
    const { config, warnings } = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
hooks:
  proposeAutosaveLearnings: maybe
`)

    expect(config.vault.pageId).toBe("abc123")
    expect(config.hooks).toBeUndefined()
    expect(warnings).toEqual(["Ignoring invalid hooks config and using hook defaults."])
  })

  it("parses hooks.memoryCaptureMode as durable or conversational", () => {
    const durable = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
hooks:
  memoryCaptureMode: durable
`)
    expect(durable.warnings).toEqual([])
    expect(durable.config.hooks).toEqual({ memoryCaptureMode: "durable" })

    const conversational = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
hooks:
  memoryCaptureMode: conversational
`)
    expect(conversational.warnings).toEqual([])
    expect(conversational.config.hooks).toEqual({
      memoryCaptureMode: "conversational",
    })
  })

  it("rejects invalid hooks.memoryCaptureMode values", () => {
    const { config, warnings } = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
hooks:
  memoryCaptureMode: chatty
`)

    expect(config.vault.pageId).toBe("abc123")
    expect(config.hooks).toBeUndefined()
    expect(warnings).toEqual(["Ignoring invalid hooks config and using hook defaults."])
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

  it("parses an optional exact profile selector", () => {
    const { config, warnings } = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
profile: default@1.0.0
`)

    expect(warnings).toEqual([])
    expect(config.profile).toBe("default@1.0.0")
  })

  it("parses runtime feature flags", () => {
    const { config, warnings } = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
features:
  nearDuplicateProbe: false
  autoMentions: false
  queryPlanning: false
  forceSemanticSearch: true
  runTool:
    enabled: false
    search: true
    batchCreates: true
`)

    expect(warnings).toEqual([])
    expect(config.features).toEqual({
      nearDuplicateProbe: false,
      autoMentions: false,
      queryPlanning: false,
      forceSemanticSearch: true,
      runTool: {
        enabled: false,
        search: true,
        batchCreates: true,
      },
    })
  })

  it("parses optional cost tracking config", () => {
    const { config, warnings } = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
costTracking:
  enabled: true
  ledgerPath: ./state/lore-costs.jsonl
  pricing:
    builtinTable: openai-2026-05
    overridesPath: ~/.config/lore/pricing.json
`)

    expect(warnings).toEqual([])
    expect(config.costTracking).toEqual({
      enabled: true,
      ledgerPath: "./state/lore-costs.jsonl",
      pricing: {
        builtinTable: "openai-2026-05",
        overridesPath: "~/.config/lore/pricing.json",
      },
    })
  })

  it("parses memory authoring policy config", () => {
    const { config, warnings } = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
memory:
  synopsisMaxChars: 220
`)

    expect(warnings).toEqual([])
    expect(config.memory).toEqual({ synopsisMaxChars: 220 })
  })

  it("rejects memory synopsis caps outside the storage ceiling", () => {
    expect(() =>
      parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
memory:
  synopsisMaxChars: 501
`)
    ).toThrow(/less than or equal to 500/)

    expect(() =>
      parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
memory:
  synopsisMaxChars: 0
`)
    ).toThrow(/greater than or equal to 1/)
  })

  it("keeps cost tracking disabled by default when omitted", () => {
    const { config, warnings } = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
`)

    expect(warnings).toEqual([])
    expect(config.costTracking).toBeUndefined()
  })

  it("rejects malformed profile selectors", () => {
    expect(() =>
      parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
profile: default
`)
    ).toThrow(/Expected exact <name>@<semver>/)
  })

  it("parses profile install allow-list entries", () => {
    const { config, warnings } = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
profiles:
  allowedInstallSources:
    - kind: git
      url: git@github.com:org/lore-sales-profile.git
      commit: 0123456789abcdef0123456789abcdef01234567
      manifestDigest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    - kind: path
      path: ./profiles/sales
      manifestDigest: sha256:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd
`)

    expect(warnings).toEqual([])
    expect(config.profiles?.allowedInstallSources).toHaveLength(2)
  })

  it("rejects allow-list entries with malformed manifest digests", () => {
    expect(() =>
      parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
profiles:
  allowedInstallSources:
    - kind: path
      path: ./profiles/sales
      manifestDigest: sha256:not-a-digest
`)
    ).toThrow(/manifestDigest must be sha256:<64-hex>/)
  })

  it("rejects auth.token values at parse time", () => {
    for (const token of [
      "secret_real_notion_integration_token",
      "ntn_real_notion_user_token",
      "development_ntn_real_notion_dev_pat_token",
      "Bearer secret_real_notion_integration_token",
      "Bearer development_ntn_real_notion_dev_pat_token",
      "tok-from-config",
    ]) {
      expect(() =>
        parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
auth:
  token: ${token}
`)
      ).toThrow(/auth\.token has been removed/)
    }
  })

  it("rejects auth.token values loaded from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-config-load-"))
    const path = join(dir, ".lore.yaml")
    writeFileSync(
      path,
      `
vault:
  pageId: abc123
auth:
  token: ntn_real_notion_user_token
`
    )

    try {
      await expect(loadConfig(path)).rejects.toThrow(/auth\.token has been removed/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects starter page ID placeholders before Notion calls", () => {
    expect(() =>
      parseConfigAllowingInvalidHooks(`
vault:
  pageId: "<your-vault-page-id>"
`)
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
`)
    ).toThrow(/starter placeholder/)
  })
})

describe("loadConfig placeholder rejection", () => {
  it("fails fast at config load time until a placeholder is replaced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-placeholder-config-"))
    const path = join(dir, ".lore.yaml")
    writeFileSync(
      path,
      `
vault:
  pageId: "<your-vault-page-id>"
`
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

function setupHookStateDir(): string {
  const dir = mkdtempSync(join(SCRATCH, "hook-state-"))
  process.env["LORE_HOOK_STATE_DIR"] = dir
  return dir
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
  "XDG_CONFIG_HOME",
  "LORE_HOOK_STATE_DIR",
]

describe("resolveAuth", () => {
  // Scoped to this describe block so the stderr spy + env cleanup
  // doesn't fire on every parseConfigAllowingInvalidHooks test.
  beforeEach(() => {
    stderrChunks = []
    // Clear inherited shell env BEFORE each test so a developer with
    // (e.g.) LORE_NOTION_BASE_URL exported in their shell rc doesn't
    // see false positives. afterEach also clears, but starting clean
    // defends against the very first test in the file.
    for (const key of ENV_KEYS_TO_CLEAR) delete process.env[key]
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
    // `.lore.yaml` is persistent file state beside the repo; even
    // local-only, it can be copied, synced, pasted, or force-added to
    // history, which is less trusted than operator-controlled env vars.
    // If `auth.baseUrl` from config flowed into the canonical
    // NOTION_API_TOKEN path, a malicious `.lore.yaml` could redirect
    // every Notion call to an attacker-controlled host and exfiltrate
    // the engineer's bearer token. Pin the rejection so a regression
    // here surfaces as a test failure rather than a production
    // exfiltration. Operators who genuinely need a custom base URL set
    // `LORE_NOTION_BASE_URL` (operator-controlled env).
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
    // for non-prod endpoints. Since shell rc lives outside the
    // `.lore.yaml` blast radius (no sync, no paste, no `git add -f`),
    // it can't be hijacked by a malicious `.lore.yaml`.
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

  it("rejects invalid base URL env on the NOTION_API_TOKEN path before client construction", async () => {
    setupNtnConfigHome()
    setupHookStateDir()
    process.env["NOTION_API_TOKEN"] = "tok-from-env-api"
    process.env["LORE_NOTION_BASE_URL"] = "api.notion.so"

    await expect(resolveAuth(undefined, SCRATCH)).rejects.toThrow(
      /Invalid Notion API base URL from LORE_NOTION_BASE_URL/
    )
  })

  it("rejects invalid NOTION_ENV selectors on the NOTION_API_TOKEN path", async () => {
    setupNtnConfigHome()
    setupHookStateDir()
    process.env["NOTION_API_TOKEN"] = "tok-from-env-api"
    process.env["NOTION_ENV"] = "qa"

    await expect(resolveAuth(undefined, SCRATCH)).rejects.toThrow(
      /Invalid Notion API base URL from NOTION_ENV/
    )
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
    setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-1", "ws-2": "tok-2" }))
    setupHookStateDir()
    process.env["NOTION_WORKSPACE_ID"] = "ws-2"

    const result = await resolveAuth(undefined, SCRATCH)
    expect(result).toMatchObject({ token: "tok-2", workspaceId: "ws-2" })
  })

  it("threads config.auth.workspaceId into the ntn selector when env is absent", async () => {
    setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-1", "ws-2": "tok-2" }))
    setupHookStateDir()

    const config: LoreConfig = {
      vault: { pageId: "abc" },
      auth: { workspaceId: "ws-1" },
    }
    const result = await resolveAuth(config, SCRATCH)
    expect(result).toMatchObject({ token: "tok-1", workspaceId: "ws-1" })
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
      /No Notion auth configured/
    )
    await expect(resolveAuth(undefined, SCRATCH)).rejects.toThrow(/lore auth --login/)
    await expect(resolveAuth(undefined, SCRATCH)).rejects.toThrow(/NOTION_API_TOKEN/)
    // The stale "Phase 2 will ship" copy must be gone.
    await expect(resolveAuth(undefined, SCRATCH)).rejects.not.toThrow(/once Phase 2/)
  })

  it("adds a removed LORE_NOTION_TOKEN hint when no supported source resolves", async () => {
    setupNtnConfigHome()
    setupHookStateDir()
    process.env["LORE_NOTION_TOKEN"] = "legacy-removed-token"

    let thrown: Error | undefined
    try {
      await resolveAuth(undefined, SCRATCH)
    } catch (err) {
      thrown = err as Error
    }

    expect(thrown?.message).toContain("No Notion auth configured.")
    expect(thrown?.message).toContain("Detected LORE_NOTION_TOKEN")
    expect(thrown?.message).toContain("NOTION_API_TOKEN")
    expect(thrown?.message).toContain("rotate to a PAT")
    expect(thrown?.message).not.toContain("legacy-removed-token")
  })

  it("throw message inlines the ntn ambiguity hint when auth.json carries multiple workspaces", async () => {
    // The hint is suppressed (via `quiet: true`) on the `loadNtnToken`
    // call so it doesn't fight the deprecation emitter when a legacy
    // fallback resolves. At the throw site (no source resolved), we
    // re-detect the ambiguity case and surface a single hint listing
    // the available workspaces — gives operators a concrete next step.
    setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-1", "ws-2": "tok-2" }))
    setupHookStateDir()

    await expect(resolveAuth(undefined, SCRATCH)).rejects.toThrow(/carries 2 workspaces/)
    await expect(resolveAuth(undefined, SCRATCH)).rejects.toThrow(/NOTION_WORKSPACE_ID/)
    await expect(resolveAuth(undefined, SCRATCH)).rejects.toThrow(/Available: ws-1, ws-2/)
  })

  it("throw message inlines the selector-miss hint when auth.json doesn't carry the requested workspace", async () => {
    setupNtnConfigHome(JSON.stringify({ "ws-1": "tok-1" }))
    setupHookStateDir()
    process.env["NOTION_WORKSPACE_ID"] = "ws-missing"

    await expect(resolveAuth(undefined, SCRATCH)).rejects.toThrow(
      /requested workspaceId \(ws-missing\) is not among them/
    )
    await expect(resolveAuth(undefined, SCRATCH)).rejects.toThrow(/Available: ws-1/)
    // Recovery recommendation MUST point at `lore auth --login` (the
    // canonical wrapper that forces NOTION_KEYRING=0). Bare
    // `ntn login` on macOS defaults to keychain mode and writes
    // nothing to auth.json, so a recovery hint that recommended it
    // would loop the operator back into this same selector miss on
    // the next run. Round-4 review blocker; pin against revert.
    await expect(resolveAuth(undefined, SCRATCH)).rejects.toThrow(/lore auth --login/)
    // The bare-ntn-login wording must NOT appear standalone (the
    // recommendation can't substitute it for the wrapper).
    await expect(resolveAuth(undefined, SCRATCH)).rejects.not.toThrow(
      /Run `ntn login` against/
    )
  })
})

describe("resolveToken", () => {
  beforeEach(() => {
    stderrChunks = []
    // Clear inherited shell env BEFORE each test so a developer with
    // (e.g.) LORE_NOTION_BASE_URL exported in their shell rc doesn't
    // see false positives. afterEach also
    // clears, but starting clean defends against the very first test
    // in the file.
    for (const key of ENV_KEYS_TO_CLEAR) delete process.env[key]
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
    for (const key of ENV_KEYS_TO_CLEAR) delete process.env[key]
  })

  it("returns the same token resolveAuth produces", async () => {
    setupNtnConfigHome()
    setupHookStateDir()
    process.env["NOTION_API_TOKEN"] = "tok-from-env-api"

    expect(await resolveToken(undefined, SCRATCH)).toBe("tok-from-env-api")
  })
})
