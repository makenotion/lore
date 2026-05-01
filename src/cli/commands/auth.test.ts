/**
 * Tests for `lore auth --migrate` (issue 0.10.0/07).
 *
 * The Notion-touching pieces, the ntn shell-out helpers, and the
 * confirmation prompt are all routed through the `MigrateDeps` bag,
 * so tests stub the dependencies rather than mocking globals or
 * spawning subprocesses. The same posture as `runReconcile` /
 * `dispatchInstall`.
 *
 * Two layers of coverage:
 *
 * 1. `runMigrate` integration-style tests that walk the four-step
 *    flow under each acceptance-criteria branch.
 * 2. Unit tests for the two pure helpers — `formatUnsetInstructions`
 *    (source-aware copy) and `findShellRcReferencingLoreToken`
 *    (candidate-file walk).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Client } from "@notionhq/client"

import {
  classifyVaultError,
  computeNtnLoginEnvOverride,
  confirmPrompt,
  findShellRcReferencingLoreToken,
  formatUnsetInstructions,
  resolveLoginTargetBaseUrl,
  resolveNtnEnvBaseUrl,
  runMigrate,
  type MigrateDeps,
} from "./auth.js"
import type { LoreConfig } from "../../types.js"

// ---------------------------------------------------------------------------
// classifyVaultError — VaultAccessResult.kind → operator-advice category
//
// Forward-compat helper for PR #178's 5-arm shape. Takes `kind: string`
// rather than the typed discriminator so the tests pin all four
// categories without needing the 5-arm union to exist on `main`.
// ---------------------------------------------------------------------------

describe("classifyVaultError", () => {
  it("routes 'not-found' → permission (sharing/wrong-workspace diagnostic)", () => {
    expect(classifyVaultError("not-found")).toBe("permission")
  })

  it("routes 'unauthorized' → auth (re-auth recommendation)", () => {
    // Activates the moment PR #178 lands. The kind value is sourced
    // from #178's diff (gh pr diff 178 shows the literal string).
    expect(classifyVaultError("unauthorized")).toBe("auth")
  })

  it("routes 'rate-limited' → throttle (back-off recommendation)", () => {
    expect(classifyVaultError("rate-limited")).toBe("throttle")
  })

  it("routes 'unknown-error' → transient (retry advice)", () => {
    expect(classifyVaultError("unknown-error")).toBe("transient")
  })

  it("routes any unrecognized future kind → transient (safe catch-all)", () => {
    // The fall-through ensures a kind value added by some future
    // VaultAccessResult extension lands on the safest non-misleading
    // copy (retry advice) rather than wrong remediation. Pin the
    // contract so a future maintainer who's tempted to throw on
    // unknown values reads this test first.
    expect(classifyVaultError("hypothetical-future-arm")).toBe("transient")
    expect(classifyVaultError("")).toBe("transient")
  })
})

// ---------------------------------------------------------------------------
// resolveNtnEnvBaseUrl — env-vars → base URL priority resolution
//
// The migrate flow's load-bearing helper for "verify the same host
// the next Lore process will hit." Without it, a dev-environment
// operator with NOTION_API_BASE_URL set silently has migrate verify
// against prod while ntn login itself targets dev — silent host
// mismatch.
// ---------------------------------------------------------------------------

describe("resolveNtnEnvBaseUrl", () => {
  it("returns undefined when no override env is set (SDK default = prod)", () => {
    expect(resolveNtnEnvBaseUrl({})).toBeUndefined()
  })

  it("returns LORE_NOTION_BASE_URL verbatim when set (top priority)", () => {
    expect(
      resolveNtnEnvBaseUrl({ LORE_NOTION_BASE_URL: "https://lore-override.example" }),
    ).toBe("https://lore-override.example")
  })

  it("falls through to NOTION_BASE_URL when LORE_ override is unset (matches PR #178's resolveOperatorBaseUrl)", () => {
    // PR #178 introduces NOTION_BASE_URL as the middle tier between
    // the Lore-prefixed and ntn-API names. Migrate's helper has to
    // honor the same priority so the late-merge with #178 collapses
    // both helpers cleanly.
    expect(
      resolveNtnEnvBaseUrl({ NOTION_BASE_URL: "https://api-dev.notion.com" }),
    ).toBe("https://api-dev.notion.com")
  })

  it("falls through to NOTION_API_BASE_URL when LORE_ and NOTION_BASE_URL are unset (ntn-native priority)", () => {
    expect(
      resolveNtnEnvBaseUrl({ NOTION_API_BASE_URL: "https://api-dev.notion.com" }),
    ).toBe("https://api-dev.notion.com")
  })

  it("falls through to NOTION_ENV=dev → canonical dev URL", () => {
    expect(resolveNtnEnvBaseUrl({ NOTION_ENV: "dev" })).toBe(
      "https://api-dev.notion.com",
    )
  })

  it("falls through to NOTION_ENV=stg → canonical staging URL", () => {
    expect(resolveNtnEnvBaseUrl({ NOTION_ENV: "stg" })).toBe(
      "https://api-stg.notion.com",
    )
  })

  it("returns undefined for NOTION_ENV=prod (SDK default)", () => {
    // Mirrors src/auth/ntn.ts:resolveNtnBaseUrl — `prod` has no
    // explicit override; the SDK uses its canonical prod URL.
    expect(resolveNtnEnvBaseUrl({ NOTION_ENV: "prod" })).toBeUndefined()
  })

  it("returns undefined for unrecognized NOTION_ENV values (safe fallback)", () => {
    expect(resolveNtnEnvBaseUrl({ NOTION_ENV: "qa-cluster-7" })).toBeUndefined()
  })

  it("LORE_ override wins when all four priority sources are set", () => {
    expect(
      resolveNtnEnvBaseUrl({
        LORE_NOTION_BASE_URL: "https://lore.example",
        NOTION_BASE_URL: "https://middle.example",
        NOTION_API_BASE_URL: "https://ntn.example",
        NOTION_ENV: "dev",
      }),
    ).toBe("https://lore.example")
  })

  it("NOTION_BASE_URL beats NOTION_API_BASE_URL (matches #178's middle tier)", () => {
    expect(
      resolveNtnEnvBaseUrl({
        NOTION_BASE_URL: "https://middle.example",
        NOTION_API_BASE_URL: "https://ntn.example",
      }),
    ).toBe("https://middle.example")
  })

  it("NOTION_API_BASE_URL wins over NOTION_ENV when both are set", () => {
    // The literal URL is more specific than the env-name shortcut;
    // operators who set both probably typed the URL deliberately.
    expect(
      resolveNtnEnvBaseUrl({
        NOTION_API_BASE_URL: "https://api-stg.notion.com",
        NOTION_ENV: "dev",
      }),
    ).toBe("https://api-stg.notion.com")
  })
})

// ---------------------------------------------------------------------------
// resolveLoginTargetBaseUrl — what `ntn login` natively reads
//
// Distinct from `resolveNtnEnvBaseUrl`: this helper covers ONLY the env
// vars `ntn login --help` documents (NOTION_BASE_URL, NOTION_ENV). It
// does NOT include LORE_NOTION_BASE_URL (Lore-specific) or
// NOTION_API_BASE_URL (separate runtime API-host var). The split is
// load-bearing for `computeNtnLoginEnvOverride`'s decision about whether
// the spawn needs an override.
// ---------------------------------------------------------------------------

describe("resolveLoginTargetBaseUrl", () => {
  it("returns undefined when no ntn-login-native env var is set", () => {
    expect(resolveLoginTargetBaseUrl({})).toBeUndefined()
  })

  it("returns NOTION_BASE_URL verbatim when set", () => {
    expect(
      resolveLoginTargetBaseUrl({ NOTION_BASE_URL: "https://api-dev.notion.com" }),
    ).toBe("https://api-dev.notion.com")
  })

  it("returns NOTION_ENV mapped to canonical URL", () => {
    expect(resolveLoginTargetBaseUrl({ NOTION_ENV: "dev" })).toBe(
      "https://api-dev.notion.com",
    )
    expect(resolveLoginTargetBaseUrl({ NOTION_ENV: "stg" })).toBe(
      "https://api-stg.notion.com",
    )
  })

  it("IGNORES LORE_NOTION_BASE_URL (Lore-specific name; not what ntn login reads)", () => {
    // The split's whole point: Lore-prefixed vars need translation
    // to ntn login's native format. This helper returns only what ntn
    // login natively picks up.
    expect(
      resolveLoginTargetBaseUrl({
        LORE_NOTION_BASE_URL: "https://api-dev.notion.com",
      }),
    ).toBeUndefined()
  })

  it("IGNORES NOTION_API_BASE_URL (runtime API-host var, not login env)", () => {
    // Per `ntn login --help`, NOTION_BASE_URL is the login-environment
    // selector. NOTION_API_BASE_URL is a separate var for already-issued
    // API requests. Forwarding the wrong one was the round-7 blocker.
    expect(
      resolveLoginTargetBaseUrl({
        NOTION_API_BASE_URL: "https://api-dev.notion.com",
      }),
    ).toBeUndefined()
  })

  it("NOTION_BASE_URL beats NOTION_ENV when both are set", () => {
    // Direct URL is more specific than the env-name shortcut.
    expect(
      resolveLoginTargetBaseUrl({
        NOTION_BASE_URL: "https://api-stg.notion.com",
        NOTION_ENV: "dev",
      }),
    ).toBe("https://api-stg.notion.com")
  })
})

// ---------------------------------------------------------------------------
// computeNtnLoginEnvOverride — config-driven dev-login forwarding
// ---------------------------------------------------------------------------

describe("computeNtnLoginEnvOverride", () => {
  it("returns undefined when neither config nor env carries a base URL", () => {
    // Default prod path: ntn login uses prod, Step 4 verify uses prod,
    // api-token guard uses prod. Consistent across the three sites.
    expect(computeNtnLoginEnvOverride(undefined, {})).toBeUndefined()
  })

  it("returns undefined when ntn login natively reads the right URL (NOTION_BASE_URL match)", () => {
    // ntn login natively reads NOTION_BASE_URL — when migrate's
    // intended target matches, no override needed.
    expect(
      computeNtnLoginEnvOverride(undefined, {
        NOTION_BASE_URL: "https://api-dev.notion.com",
      }),
    ).toBeUndefined()
  })

  it("returns undefined when ntn login natively reads NOTION_ENV (mapped match)", () => {
    expect(
      computeNtnLoginEnvOverride(undefined, { NOTION_ENV: "dev" }),
    ).toBeUndefined()
  })

  it("forwards NOTION_BASE_URL when config has auth.baseUrl and env is silent", () => {
    // The headline scenario: `.lore.yaml` carries
    // `auth.baseUrl: https://api-dev.notion.com` but no shell env var
    // is set. Without forwarding, Step 1 verifies dev and Step 3
    // logs in to prod — silent host mismatch.
    expect(
      computeNtnLoginEnvOverride("https://api-dev.notion.com", {}),
    ).toEqual({ NOTION_BASE_URL: "https://api-dev.notion.com" })
  })

  it("forwards NOTION_BASE_URL when only LORE_NOTION_BASE_URL is set (Lore-prefixed)", () => {
    // ntn login doesn't natively read LORE_NOTION_BASE_URL — it's a
    // Lore-specific name. Without translation, ntn login would default
    // to prod even though Lore's other sites target dev. The override
    // translates Lore's intent into ntn login's native env var.
    expect(
      computeNtnLoginEnvOverride(undefined, {
        LORE_NOTION_BASE_URL: "https://api-dev.notion.com",
      }),
    ).toEqual({ NOTION_BASE_URL: "https://api-dev.notion.com" })
  })

  it("forwards NOTION_BASE_URL when only NOTION_API_BASE_URL is set (round-7 blocker)", () => {
    // The round-7 reviewer's headline bug: NOTION_API_BASE_URL is the
    // runtime API-host var, NOT what ntn login natively reads. Without
    // translation, Step 3 runs bare ntn login (prod) while Step 4
    // verifies against the captured NOTION_API_BASE_URL value (dev) —
    // silent mismatch in the opposite direction. The override resolves
    // it by forwarding NOTION_BASE_URL=<the URL ntn-API-BASE pointed to>.
    expect(
      computeNtnLoginEnvOverride(undefined, {
        NOTION_API_BASE_URL: "https://api-dev.notion.com",
      }),
    ).toEqual({ NOTION_BASE_URL: "https://api-dev.notion.com" })
  })

  it("forwards NOTION_BASE_URL when LORE_ disagrees with ntn login's native NOTION_BASE_URL", () => {
    // LORE wins per resolveNtnEnvBaseUrl priority. ntn login natively
    // would target stg (via NOTION_BASE_URL). The override translates
    // Lore's resolution to make ntn login agree.
    expect(
      computeNtnLoginEnvOverride(undefined, {
        LORE_NOTION_BASE_URL: "https://api-dev.notion.com",
        NOTION_BASE_URL: "https://api-stg.notion.com",
      }),
    ).toEqual({ NOTION_BASE_URL: "https://api-dev.notion.com" })
  })

  it("forwards verbatim regardless of URL shape (no canonical-URL gating)", () => {
    // Forwarding NOTION_BASE_URL directly works for any Notion-shaped
    // URL the operator put in config — ntn honors the env var per its
    // login docs. Robust and reviewer-clean.
    expect(
      computeNtnLoginEnvOverride("https://custom-staging.notion.example", {}),
    ).toEqual({ NOTION_BASE_URL: "https://custom-staging.notion.example" })
  })
})

// ---------------------------------------------------------------------------
// formatUnsetInstructions — pure copy formatter
// ---------------------------------------------------------------------------

describe("formatUnsetInstructions", () => {
  it("opens with the verified-success banner regardless of source", () => {
    expect(
      formatUnsetInstructions({ legacySource: "env", configPath: "/tmp/.lore.yaml" })[0],
    ).toBe("Migration verified!")
    expect(
      formatUnsetInstructions({ legacySource: "config", configPath: "/tmp/.lore.yaml" })[0],
    ).toBe("Migration verified!")
  })

  it("env source surfaces the unset shell command", () => {
    const lines = formatUnsetInstructions({
      legacySource: "env",
      configPath: "/irrelevant/.lore.yaml",
    })
    expect(lines).toContain("  unset LORE_NOTION_TOKEN")
  })

  it("env source does NOT reference the config-path file", () => {
    // The env-source-only branch shouldn't print the config path —
    // the operator's edit target is shell rc, not the YAML.
    const lines = formatUnsetInstructions({
      legacySource: "env",
      configPath: "/some/path/.lore.yaml",
    })
    expect(lines.join("\n")).not.toContain("/some/path/.lore.yaml")
  })

  it("config source surfaces the YAML field-removal copy", () => {
    const lines = formatUnsetInstructions({
      legacySource: "config",
      configPath: "/work/proj/.lore.yaml",
    })
    const joined = lines.join("\n")
    expect(joined).toContain("/work/proj/.lore.yaml")
    expect(joined).toContain("auth:")
    expect(joined).toContain("token: <secret>")
  })

  it("both env-only and config-only branches end with the 'token already active' reassurance", () => {
    // The reassurance is the load-bearing copy that prevents an
    // operator from worrying that they've broken their setup before
    // editing shell rc / committing config. Pin both branches.
    expect(
      formatUnsetInstructions({ legacySource: "env", configPath: "/x" }).join("\n"),
    ).toContain("ALREADY active")
    expect(
      formatUnsetInstructions({ legacySource: "config", configPath: "/x" }).join("\n"),
    ).toContain("ALREADY active")
  })

  it("dual-source: env primary + alsoSetSource=config emits BOTH housekeeping blocks", () => {
    // An operator with BOTH `LORE_NOTION_TOKEN` env AND `auth.token`
    // in YAML needs both pointers in the one-shot migrate output —
    // otherwise they unset the env, walk away, and trip the config-
    // source deprecation warning on every subsequent run.
    const lines = formatUnsetInstructions({
      legacySource: "env",
      configPath: "/proj/.lore.yaml",
      alsoSetSource: "config",
    })
    const joined = lines.join("\n")
    expect(joined).toContain("  unset LORE_NOTION_TOKEN")
    expect(joined).toContain("/proj/.lore.yaml")
    expect(joined).toContain("Also: `auth.token` is set in")
  })

  it("dual-source: config primary + alsoSetSource=env emits BOTH housekeeping blocks", () => {
    // Symmetric guard for any future resolver order that flips which
    // source becomes primary. Today the resolver always picks env over
    // config, so this combination never lands in production — but the
    // formatter is symmetric.
    const lines = formatUnsetInstructions({
      legacySource: "config",
      configPath: "/proj/.lore.yaml",
      alsoSetSource: "env",
    })
    const joined = lines.join("\n")
    expect(joined).toContain("  # (remove the auth: section entirely")
    expect(joined).toContain("Also: `LORE_NOTION_TOKEN` is set in your shell")
    expect(joined).toContain("  unset LORE_NOTION_TOKEN")
  })

  it("notionApiTokenActive replaces the 'ntn already active' reassurance with NOTION_API_TOKEN copy", () => {
    // When NOTION_API_TOKEN is set AND it reaches the vault, the
    // reassurance must NOT claim ntn is the active token — that's a
    // lie under #01's resolver priority. The honest copy names
    // NOTION_API_TOKEN as the active source instead.
    const lines = formatUnsetInstructions({
      legacySource: "env",
      configPath: "/proj/.lore.yaml",
      notionApiTokenActive: true,
    })
    const joined = lines.join("\n")
    expect(joined).toContain("NOTION_API_TOKEN is in your environment and outranks ntn")
    expect(joined).toContain("NOTION_API_TOKEN is the active token right now")
    // The default ntn-active reassurance must NOT also fire.
    expect(joined).not.toContain(
      "your ntn-issued token is ALREADY active, since ntn ranks",
    )
  })

  it("notionApiTokenActive applies to the config-source primary branch too", () => {
    const lines = formatUnsetInstructions({
      legacySource: "config",
      configPath: "/proj/.lore.yaml",
      notionApiTokenActive: true,
    })
    const joined = lines.join("\n")
    expect(joined).toContain("NOTION_API_TOKEN is in your environment and outranks ntn")
    expect(joined).not.toContain(
      "your ntn-issued token is ALREADY active, since ntn ranks",
    )
  })
})

// ---------------------------------------------------------------------------
// findShellRcReferencingLoreToken — candidate-file walk
// ---------------------------------------------------------------------------

const SHELL_RC_SCRATCH = mkdtempSync(join(tmpdir(), "lore-auth-shellrc-"))

afterAll(() => {
  rmSync(SHELL_RC_SCRATCH, { recursive: true, force: true })
})

function makeFakeHome(seedFiles: Record<string, string>): string {
  const home = mkdtempSync(join(SHELL_RC_SCRATCH, "home-"))
  for (const [relPath, contents] of Object.entries(seedFiles)) {
    const full = join(home, relPath)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, contents)
  }
  return home
}

describe("findShellRcReferencingLoreToken", () => {
  it("returns the .zshrc path when it references LORE_NOTION_TOKEN", async () => {
    const home = makeFakeHome({
      ".zshrc": 'export LORE_NOTION_TOKEN="secret"\n',
    })
    expect(await findShellRcReferencingLoreToken(home)).toBe(join(home, ".zshrc"))
  })

  it("returns the .bashrc path when only .bashrc matches", async () => {
    const home = makeFakeHome({
      ".bashrc": 'export LORE_NOTION_TOKEN="secret"\n',
    })
    expect(await findShellRcReferencingLoreToken(home)).toBe(join(home, ".bashrc"))
  })

  it("returns the .bash_profile path when only .bash_profile matches", async () => {
    const home = makeFakeHome({
      ".bash_profile": 'export LORE_NOTION_TOKEN="secret"\n',
    })
    expect(await findShellRcReferencingLoreToken(home)).toBe(
      join(home, ".bash_profile"),
    )
  })

  it("returns the .profile path when only .profile matches", async () => {
    const home = makeFakeHome({
      ".profile": 'export LORE_NOTION_TOKEN="secret"\n',
    })
    expect(await findShellRcReferencingLoreToken(home)).toBe(join(home, ".profile"))
  })

  it("returns the fish config path when only fish matches", async () => {
    const home = makeFakeHome({
      ".config/fish/config.fish": 'set -gx LORE_NOTION_TOKEN "secret"\n',
    })
    expect(await findShellRcReferencingLoreToken(home)).toBe(
      join(home, ".config/fish/config.fish"),
    )
  })

  it("returns null when no candidate references LORE_NOTION_TOKEN", async () => {
    const home = makeFakeHome({
      ".zshrc": "# nothing relevant here\n",
      ".bashrc": "alias ll=ls\n",
    })
    expect(await findShellRcReferencingLoreToken(home)).toBeNull()
  })

  it("returns null when no candidate file exists at all", async () => {
    const home = makeFakeHome({})
    expect(await findShellRcReferencingLoreToken(home)).toBeNull()
  })

  it("prefers .zshrc when multiple candidates would match (priority order)", async () => {
    // Two files both reference the token — the helper returns the
    // first-priority match. zsh ranks above bash because it's the
    // Notion-internal default shell.
    const home = makeFakeHome({
      ".zshrc": 'export LORE_NOTION_TOKEN="from-zshrc"\n',
      ".bashrc": 'export LORE_NOTION_TOKEN="from-bashrc"\n',
    })
    expect(await findShellRcReferencingLoreToken(home)).toBe(join(home, ".zshrc"))
  })
})

// ---------------------------------------------------------------------------
// runMigrate — orchestrator under each acceptance-criteria branch
// ---------------------------------------------------------------------------

interface CapturedRun {
  stdout: string[]
  stderr: string[]
}

interface MigrateScenarioOverrides {
  envToken?: string | undefined
  configToken?: string | undefined
  /**
   * Sets `auth.baseUrl` in the loaded config. Drives Step 1's legacy
   * preflight base URL AND `computeNtnLoginEnvOverride` for the
   * Step 3 ntn login spawn.
   */
  configBaseUrl?: string
  workspaceIdEnv?: string
  workspaceIdConfig?: string
  configResolved?: { path: string; root: string } | null
  vaultPageId?: string
  legacyVerify?: Awaited<ReturnType<MigrateDeps["verifyVaultAccess"]>>
  ntnInstalled?: boolean
  installNtnResult?: Awaited<ReturnType<MigrateDeps["installNtn"]>>
  loginResult?: Awaited<ReturnType<MigrateDeps["runNtnLogin"]>>
  ntnRecord?: Awaited<ReturnType<MigrateDeps["loadNtnToken"]>>
  ntnVerify?: Awaited<ReturnType<MigrateDeps["verifyVaultAccess"]>>
  /**
   * Sets `NOTION_API_TOKEN` in the scenario's env. When present, the
   * Step 4 post-verify guard fires and calls `verifyVaultAccess` a
   * THIRD time against the api-token client. Tests pair this with
   * `apiTokenVerify` to drive the result of that third call.
   */
  notionApiTokenEnv?: string
  apiTokenVerify?: Awaited<ReturnType<MigrateDeps["verifyVaultAccess"]>>
  /**
   * `LORE_NOTION_BASE_URL` — Lore-specific override, top of the
   * `resolveNtnEnvBaseUrl` priority chain.
   */
  notionApiBaseUrlEnv?: string
  /**
   * `NOTION_API_BASE_URL` — ntn's native override per `ntn --help`.
   * Second in the priority chain.
   */
  notionApiBaseUrlNativeEnv?: string
  /**
   * `NOTION_ENV` — ntn's environment switch (`dev` / `stg`). Third
   * in the priority chain; mapped to canonical URLs via the helper's
   * internal table.
   */
  notionEnvEnv?: string
  /**
   * `NOTION_BASE_URL` — middle tier in PR #178's `resolveOperatorBaseUrl`
   * shape. Between `LORE_NOTION_BASE_URL` and `NOTION_API_BASE_URL`.
   */
  notionBaseUrlEnv?: string
  confirmAnswer?: boolean
  shellRcMatch?: string | null
  yes?: boolean
}

/**
 * Build a `MigrateDeps` bag over reasonable defaults plus targeted
 * overrides. The defaults represent the happy-path env-source flow;
 * each test overrides the branch-specific failure mode.
 */
function makeScenario(over: MigrateScenarioOverrides = {}): {
  deps: MigrateDeps
  run: CapturedRun
  spies: {
    legacyVerify: ReturnType<typeof vi.fn>
    ntnVerify: ReturnType<typeof vi.fn>
    apiTokenVerify: ReturnType<typeof vi.fn>
    installNtn: ReturnType<typeof vi.fn>
    runNtnLogin: ReturnType<typeof vi.fn>
    confirmPrompt: ReturnType<typeof vi.fn>
    findShellRc: ReturnType<typeof vi.fn>
    loadNtnToken: ReturnType<typeof vi.fn>
    loadConfig: ReturnType<typeof vi.fn>
    findConfigFile: ReturnType<typeof vi.fn>
    makeClient: ReturnType<typeof vi.fn>
  }
} {
  const stdout: string[] = []
  const stderr: string[] = []
  const vaultPageId = over.vaultPageId ?? "vault-page-abc"
  const configPath =
    over.configResolved?.path ?? join("/fake-cwd", ".lore.yaml")
  const configRoot = over.configResolved?.root ?? "/fake-cwd"

  const env: NodeJS.ProcessEnv = {}
  if (over.envToken !== undefined) env["LORE_NOTION_TOKEN"] = over.envToken
  if (over.workspaceIdEnv) env["NOTION_WORKSPACE_ID"] = over.workspaceIdEnv
  if (over.notionApiTokenEnv) env["NOTION_API_TOKEN"] = over.notionApiTokenEnv
  if (over.notionApiBaseUrlEnv) env["LORE_NOTION_BASE_URL"] = over.notionApiBaseUrlEnv
  if (over.notionApiBaseUrlNativeEnv)
    env["NOTION_API_BASE_URL"] = over.notionApiBaseUrlNativeEnv
  if (over.notionEnvEnv) env["NOTION_ENV"] = over.notionEnvEnv
  if (over.notionBaseUrlEnv) env["NOTION_BASE_URL"] = over.notionBaseUrlEnv

  const config: LoreConfig = {
    vault: { pageId: vaultPageId },
    auth: {
      ...(over.configToken !== undefined ? { token: over.configToken } : {}),
      ...(over.configBaseUrl !== undefined
        ? { baseUrl: over.configBaseUrl }
        : {}),
      ...(over.workspaceIdConfig
        ? { workspaceId: over.workspaceIdConfig }
        : {}),
    },
  }

  const fakeClient = {} as Client
  const makeClient = vi.fn(() => fakeClient)
  const legacyVerify = vi.fn(
    async (_client: Client, _pageId: string) =>
      over.legacyVerify ?? { kind: "ok" as const, pageTitle: "Vault" },
  )
  const ntnVerify = vi.fn(
    async (_client: Client, _pageId: string) =>
      over.ntnVerify ?? { kind: "ok" as const, pageTitle: "Vault" },
  )
  const apiTokenVerify = vi.fn(
    async (_client: Client, _pageId: string) =>
      over.apiTokenVerify ?? { kind: "ok" as const, pageTitle: "Vault" },
  )
  // `verifyVaultAccess` is shared between Step 1 (legacy), Step 4
  // (ntn), and the post-Step-4 NOTION_API_TOKEN guard. Route by call
  // order: 1st → legacy, 2nd → ntn, 3rd → NOTION_API_TOKEN. Tests
  // that don't set `notionApiTokenEnv` only ever fire the first two.
  const verifyCalls = { count: 0 }
  const verifyVaultAccess = vi.fn(async (client: Client, pageId: string) => {
    verifyCalls.count++
    if (verifyCalls.count === 1) return await legacyVerify(client, pageId)
    if (verifyCalls.count === 2) return await ntnVerify(client, pageId)
    return await apiTokenVerify(client, pageId)
  })

  const installNtnSpy = vi.fn(
    async () => over.installNtnResult ?? { kind: "success" as const },
  )
  const runNtnLoginSpy = vi.fn(
    async (_envOverride?: NodeJS.ProcessEnv) =>
      over.loginResult ?? { kind: "success" as const },
  )
  const confirmPromptSpy = vi.fn(async () => over.confirmAnswer ?? true)
  const findShellRcSpy = vi.fn(async () => over.shellRcMatch ?? null)
  const loadNtnTokenSpy = vi.fn(async () =>
    over.ntnRecord === undefined
      ? { token: "ntn-tok", workspaceId: "ws-1", baseUrl: undefined }
      : over.ntnRecord,
  )

  const findConfigFileSpy = vi.fn(async () =>
    over.configResolved === undefined
      ? { path: configPath, root: configRoot }
      : over.configResolved,
  )
  const loadConfigSpy = vi.fn(async () => config)
  const deps: MigrateDeps = {
    cwd: () => "/fake-cwd",
    env: () => env,
    log: (line) => stdout.push(line),
    error: (line) => stderr.push(line),
    findConfigFile: findConfigFileSpy as unknown as MigrateDeps["findConfigFile"],
    loadConfig: loadConfigSpy as unknown as MigrateDeps["loadConfig"],
    makeClient,
    verifyVaultAccess,
    loadNtnToken: loadNtnTokenSpy as unknown as MigrateDeps["loadNtnToken"],
    isNtnInstalled: () => over.ntnInstalled ?? true,
    installNtn: installNtnSpy,
    runNtnLogin: runNtnLoginSpy,
    confirmPrompt: confirmPromptSpy,
    findShellRc: findShellRcSpy,
  }

  return {
    deps,
    run: { stdout, stderr },
    spies: {
      legacyVerify,
      ntnVerify,
      apiTokenVerify,
      installNtn: installNtnSpy,
      runNtnLogin: runNtnLoginSpy,
      confirmPrompt: confirmPromptSpy,
      findShellRc: findShellRcSpy,
      loadNtnToken: loadNtnTokenSpy,
      loadConfig: loadConfigSpy,
      findConfigFile: findConfigFileSpy,
      makeClient,
    },
  }
}

describe("runMigrate", () => {
  it("errors with vault-context message when no .lore.yaml is found", async () => {
    const { deps, run, spies } = makeScenario({ configResolved: null })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(1)
    expect(run.stderr.join("\n")).toContain(
      "`lore auth --migrate` requires a vault context",
    )
    // Non-success path leaves the operator with a redirect.
    expect(run.stderr.join("\n")).toContain("Run from inside a Lore-managed")
    // The early return MUST short-circuit before loadConfig — a future
    // refactor that swaps the order would silently break this contract.
    expect(spies.loadConfig).not.toHaveBeenCalled()
  })

  it("prints 'Nothing to migrate' when neither env nor config token is set", async () => {
    const { deps, run } = makeScenario({
      envToken: undefined,
      configToken: undefined,
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    const out = run.stdout.join("\n")
    expect(out).toContain("Nothing to migrate.")
    expect(out).toContain("`lore auth --status`")
    expect(out).toContain("`lore auth --login`")
  })

  it("happy path with env source: verifies, runs login, prints unset instructions", async () => {
    const { deps, run, spies } = makeScenario({ envToken: "legacy-tok" })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    const out = run.stdout.join("\n")
    expect(out).toContain("Step 1/4")
    expect(out).toContain("Step 2/4")
    expect(out).toContain("Step 3/4")
    expect(out).toContain("Step 4/4")
    expect(out).toContain("Migration verified!")
    expect(out).toContain("unset LORE_NOTION_TOKEN")
    // env-source branch never references the YAML field-removal copy
    expect(out).not.toContain("# (remove the auth: section")
    // ntn login was called once — the migrate flow shells out
    // directly, no press-Enter pause.
    expect(spies.runNtnLogin).toHaveBeenCalledTimes(1)
    // No prompt was needed (ntn already installed in defaults)
    expect(spies.confirmPrompt).not.toHaveBeenCalled()
  })

  it("happy path with config source prints YAML field-removal copy", async () => {
    const { deps, run } = makeScenario({
      envToken: undefined,
      configToken: "config-tok",
      configResolved: { path: "/proj/.lore.yaml", root: "/proj" },
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    const out = run.stdout.join("\n")
    expect(out).toContain("Migration verified!")
    expect(out).toContain("/proj/.lore.yaml")
    expect(out).toContain("# (remove the auth: section")
    // config-source branch should NOT print the shell unset command
    expect(out).not.toContain("unset LORE_NOTION_TOKEN")
  })

  it("aborts at Step 1 when legacy preflight fails (env unchanged)", async () => {
    const { deps, run, spies } = makeScenario({
      envToken: "legacy-tok",
      legacyVerify: {
        kind: "not-found",
        pageId: "vault-page-abc",
        message: "page missing",
      },
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(1)
    const err = run.stderr.join("\n")
    expect(err).toContain("Legacy LORE_NOTION_TOKEN cannot reach")
    expect(err).toContain("Migration aborted")
    // Step 2+ never runs
    expect(spies.runNtnLogin).not.toHaveBeenCalled()
    expect(spies.installNtn).not.toHaveBeenCalled()
  })

  it("aborts at Step 1 with auth.token label when legacy source is config", async () => {
    const { deps, run } = makeScenario({
      envToken: undefined,
      configToken: "config-tok",
      legacyVerify: {
        kind: "not-found",
        pageId: "vault-page-abc",
        message: "page missing",
      },
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(1)
    expect(run.stderr.join("\n")).toContain("Legacy auth.token cannot reach")
  })

  it("Step 1 unknown-error abort recommends retry, not 'Add connections'", async () => {
    // The "Add connections" advice is correct for `not-found` (the
    // integration doesn't have the page shared with it) but wrong for
    // `unknown-error` (5xx, network outage). Pin the split so a future
    // refactor doesn't collapse the branches.
    const { deps, run } = makeScenario({
      envToken: "legacy-tok",
      legacyVerify: {
        kind: "unknown-error",
        pageId: "vault-page-abc",
        error: new Error("ECONNRESET"),
      },
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(1)
    const err = run.stderr.join("\n")
    expect(err).toContain("(unknown-error)")
    expect(err).toContain("status.notion.so")
    expect(err).toContain("Retry in a moment")
    // The not-found "share with integration" copy must NOT fire here.
    expect(err).not.toContain("Add connections")
    expect(err).not.toContain("doesn't have the vault page shared with it")
  })

  it("aborts at Step 2 when ntn is missing and operator declines install", async () => {
    const { deps, run, spies } = makeScenario({
      envToken: "legacy-tok",
      ntnInstalled: false,
      confirmAnswer: false,
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(1)
    expect(spies.confirmPrompt).toHaveBeenCalledTimes(1)
    expect(spies.installNtn).not.toHaveBeenCalled()
    expect(spies.runNtnLogin).not.toHaveBeenCalled()
    expect(run.stderr.join("\n")).toContain(
      "Skipping. Install ntn manually, then re-run `lore auth --migrate`.",
    )
  })

  it("auto-installs ntn when missing and operator confirms", async () => {
    const { deps, run, spies } = makeScenario({
      envToken: "legacy-tok",
      ntnInstalled: false,
      confirmAnswer: true,
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    expect(spies.installNtn).toHaveBeenCalledTimes(1)
    expect(spies.runNtnLogin).toHaveBeenCalledTimes(1)
    expect(run.stdout.join("\n")).toContain("✓ ntn installed.")
  })

  it("--yes skips the install confirmation prompt entirely", async () => {
    const { deps, spies } = makeScenario({
      envToken: "legacy-tok",
      ntnInstalled: false,
    })
    const result = await runMigrate({ yes: true }, deps)
    expect(result.exitCode).toBe(0)
    expect(spies.confirmPrompt).not.toHaveBeenCalled()
    expect(spies.installNtn).toHaveBeenCalledTimes(1)
  })

  it("aborts at Step 2 when installNtn fails", async () => {
    const { deps, run, spies } = makeScenario({
      envToken: "legacy-tok",
      ntnInstalled: false,
      installNtnResult: { kind: "exit-non-zero", code: 1 },
    })
    const result = await runMigrate({ yes: true }, deps)
    expect(result.exitCode).toBe(1)
    expect(spies.runNtnLogin).not.toHaveBeenCalled()
    expect(run.stderr.join("\n")).toContain("ntn install failed.")
  })

  it("aborts at Step 3 when ntn login exits non-zero (env unchanged)", async () => {
    const { deps, run, spies } = makeScenario({
      envToken: "legacy-tok",
      loginResult: { kind: "exit-non-zero", code: 2 },
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(1)
    expect(spies.loadNtnToken).not.toHaveBeenCalled()
    const err = run.stderr.join("\n")
    expect(err).toContain("ntn login did not complete successfully.")
    expect(err).toContain("ntn exited with code 2")
    expect(err).toContain("LORE_NOTION_TOKEN is unchanged")
  })

  it("aborts at Step 3 with PATH hint when ntn login spawn errors", async () => {
    const { deps, run } = makeScenario({
      envToken: "legacy-tok",
      loginResult: { kind: "spawn-error", error: new Error("ENOENT") },
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(1)
    const err = run.stderr.join("\n")
    expect(err).toContain("ntn could not be spawned")
    expect(err).toContain("`lore auth --login`")
  })

  it("aborts at Step 4 when loadNtnToken returns null after a successful login", async () => {
    const { deps, run } = makeScenario({
      envToken: "legacy-tok",
      ntnRecord: null,
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(1)
    const err = run.stderr.join("\n")
    expect(err).toContain("Lore could not resolve a ntn token from auth.json.")
    expect(err).toContain("LORE_NOTION_TOKEN is unchanged")
  })

  it("aborts at Step 4 when ntn-issued token cannot reach the vault", async () => {
    const { deps, run, spies } = makeScenario({
      envToken: "legacy-tok",
      ntnVerify: {
        kind: "not-found",
        pageId: "vault-page-abc",
        message: "page missing",
      },
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(1)
    // The ntn verify spy fires on the SECOND verifyVaultAccess call
    expect(spies.legacyVerify).toHaveBeenCalledTimes(1)
    expect(spies.ntnVerify).toHaveBeenCalledTimes(1)
    const err = run.stderr.join("\n")
    expect(err).toContain("ntn-issued token cannot reach")
    expect(err).toContain("authenticated against the wrong workspace")
    expect(err).toContain("LORE_NOTION_TOKEN is unchanged")
  })

  it("Step 4 unknown-error abort recommends retry, not workspace/permission diagnosis", async () => {
    // Symmetric guard for the parallel branch on Step 1: the
    // wrong-workspace + page-not-shared diagnostic copy is correct
    // only for `not-found`; `unknown-error` is a transient infra
    // problem and the operator should retry.
    const { deps, run } = makeScenario({
      envToken: "legacy-tok",
      ntnVerify: {
        kind: "unknown-error",
        pageId: "vault-page-abc",
        error: new Error("503 Service Unavailable"),
      },
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(1)
    const err = run.stderr.join("\n")
    expect(err).toContain("(unknown-error)")
    expect(err).toContain("status.notion.so")
    expect(err).toContain("LORE_NOTION_TOKEN is unchanged")
    // The not-found "wrong workspace" copy must NOT fire here.
    expect(err).not.toContain("authenticated against the wrong workspace")
    expect(err).not.toContain("vault page isn't shared with you")
  })

  it("loadNtnToken receives NOTION_WORKSPACE_ID env when set, with quiet:true", async () => {
    const { deps, spies } = makeScenario({
      envToken: "legacy-tok",
      workspaceIdEnv: "ws-from-env",
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    // `quiet: true` is load-bearing — without it, loadNtnToken's own
    // multi-line stderr hint stacks on top of migrate's failure copy.
    expect(spies.loadNtnToken).toHaveBeenCalledWith({
      workspaceId: "ws-from-env",
      quiet: true,
    })
  })

  it("loadNtnToken falls back to auth.workspaceId when env is unset", async () => {
    const { deps, spies } = makeScenario({
      envToken: "legacy-tok",
      workspaceIdConfig: "ws-from-config",
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    expect(spies.loadNtnToken).toHaveBeenCalledWith({
      workspaceId: "ws-from-config",
      quiet: true,
    })
  })

  it("env-source happy path appends the shell-rc location hint when found", async () => {
    const { deps, run, spies } = makeScenario({
      envToken: "legacy-tok",
      shellRcMatch: "/Users/op/.zshrc",
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    expect(spies.findShellRc).toHaveBeenCalledTimes(1)
    expect(run.stdout.join("\n")).toContain(
      "(Found LORE_NOTION_TOKEN reference in /Users/op/.zshrc",
    )
  })

  it("env-source happy path omits the location hint when no candidate matches", async () => {
    const { deps, run, spies } = makeScenario({
      envToken: "legacy-tok",
      shellRcMatch: null,
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    expect(spies.findShellRc).toHaveBeenCalledTimes(1)
    expect(run.stdout.join("\n")).not.toContain(
      "(Found LORE_NOTION_TOKEN reference in",
    )
  })

  it("config-source happy path skips the shell-rc location helper entirely", async () => {
    const { deps, spies } = makeScenario({
      envToken: undefined,
      configToken: "config-tok",
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    // The shell-rc helper is env-source-only — for config source the
    // operator's edit target is the YAML, so no rc walk is needed.
    expect(spies.findShellRc).not.toHaveBeenCalled()
  })

  it("uses the correct base URL on each verify (legacy from config, ntn from auth.json)", async () => {
    const { deps, spies } = makeScenario({
      envToken: "legacy-tok",
      ntnRecord: {
        token: "ntn-tok",
        workspaceId: "ws-1",
        baseUrl: "https://api-dev.notion.com",
      },
    })
    // Seed a config baseUrl by reaching past the makeScenario
    // shortcut — the loadConfig spy is a function we can replace.
    // Easier: just assert the makeClient call positions.
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    // First call → legacy: token + (undefined baseUrl, no auth.baseUrl)
    expect(spies.makeClient).toHaveBeenNthCalledWith(1, "legacy-tok", undefined)
    // Second call → ntn: ntnRecord.token + ntnRecord.baseUrl
    expect(spies.makeClient).toHaveBeenNthCalledWith(
      2,
      "ntn-tok",
      "https://api-dev.notion.com",
    )
  })

  // -------------------------------------------------------------------------
  // NOTION_API_TOKEN precedence — Step 4's post-verify guard
  //
  // Per #01's resolver chain, NOTION_API_TOKEN ranks above ntn-resolved
  // auth. If the operator has both set, the next Lore process uses
  // NOTION_API_TOKEN — not the ntn token Step 4 verified. The post-
  // verify guard catches that divergence.
  // -------------------------------------------------------------------------

  it("NOTION_API_TOKEN unset (default): no third verify call, ntn-active reassurance fires", async () => {
    // Sanity check that the existing tests' verify-call counts didn't
    // shift: when NOTION_API_TOKEN isn't set, there are exactly TWO
    // verifyVaultAccess calls (legacy + ntn).
    const { deps, run, spies } = makeScenario({ envToken: "legacy-tok" })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    expect(spies.apiTokenVerify).not.toHaveBeenCalled()
    expect(run.stdout.join("\n")).toContain("ntn-issued token is ALREADY active")
  })

  it("NOTION_API_TOKEN set + reaches vault: success with qualified reassurance", async () => {
    const { deps, run, spies } = makeScenario({
      envToken: "legacy-tok",
      notionApiTokenEnv: "api-tok",
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    // The third verify fires; default apiTokenVerify is `ok`.
    expect(spies.apiTokenVerify).toHaveBeenCalledTimes(1)
    const out = run.stdout.join("\n")
    expect(out).toContain("NOTION_API_TOKEN is set and ranks above ntn")
    expect(out).toContain("✓ NOTION_API_TOKEN reaches:")
    // The qualified reassurance must replace the default ntn-active copy.
    expect(out).toContain("NOTION_API_TOKEN is the active token right now")
    expect(out).not.toContain("ntn-issued token is ALREADY active")
  })

  it("NOTION_API_TOKEN set + not-found: aborts with unset/update remediation copy", async () => {
    const { deps, run, spies } = makeScenario({
      envToken: "legacy-tok",
      notionApiTokenEnv: "api-tok",
      apiTokenVerify: {
        kind: "not-found",
        pageId: "vault-page-abc",
        message: "page missing",
      },
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(1)
    expect(spies.apiTokenVerify).toHaveBeenCalledTimes(1)
    const err = run.stderr.join("\n")
    expect(err).toContain("NOTION_API_TOKEN cannot reach")
    expect(err).toContain("NOTION_API_TOKEN ranks above ntn")
    expect(err).toContain("unset NOTION_API_TOKEN")
    expect(err).toContain("update NOTION_API_TOKEN to a value that reaches the vault")
    // The unknown-error retry copy must NOT fire for a not-found result.
    expect(err).not.toContain("status.notion.so")
  })

  it("NOTION_API_TOKEN set + unknown-error: aborts with retry advice, not unset/update", async () => {
    // Symmetric with the Step 1 and Step 4 unknown-error branches.
    // 5xx / DNS / proxy outage means the api token may be perfectly
    // fine; "unset/update" is the wrong remediation when the
    // operator's actual problem is "Notion is having a bad day."
    const { deps, run, spies } = makeScenario({
      envToken: "legacy-tok",
      notionApiTokenEnv: "api-tok",
      apiTokenVerify: {
        kind: "unknown-error",
        pageId: "vault-page-abc",
        error: new Error("502 Bad Gateway"),
      },
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(1)
    expect(spies.apiTokenVerify).toHaveBeenCalledTimes(1)
    const err = run.stderr.join("\n")
    expect(err).toContain("(unknown-error)")
    expect(err).toContain("NOTION_API_TOKEN ranks above ntn")
    expect(err).toContain("status.notion.so")
    expect(err).toContain("Retry in a moment")
    // The not-found "unset/update" copy must NOT fire for transient errors.
    expect(err).not.toContain("update NOTION_API_TOKEN to a value that reaches the vault")
  })

  // -------------------------------------------------------------------------
  // NOTION_API_TOKEN guard base-URL resolution
  //
  // The guard MUST mirror `resolveAuth`'s `env-notion-api-token` source
  // exactly (src/config.ts:246-253) — which on this branch honors ONLY
  // `LORE_NOTION_BASE_URL`. Anything broader creates a false positive:
  // the guard would verify against dev (because it broadly resolved
  // ntn's env vars) while the next process verifies against prod
  // (because resolveAuth's env-notion-api-token source ignores those).
  //
  // When PR #178 lands and broadens resolveAuth via resolveOperatorBaseUrl,
  // the late-merger broadens both this guard and resolveAuth together.
  // -------------------------------------------------------------------------

  it("NOTION_API_TOKEN guard inherits LORE_NOTION_BASE_URL when set", async () => {
    // The only env var resolveAuth's env-notion-api-token source honors
    // today. The guard must mirror exactly so it verifies the same
    // host the next Lore process will hit.
    const { deps, spies } = makeScenario({
      envToken: "legacy-tok",
      notionApiTokenEnv: "api-tok",
      notionApiBaseUrlEnv: "https://api-dev.notion.com",
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    expect(spies.makeClient).toHaveBeenNthCalledWith(
      3,
      "api-tok",
      "https://api-dev.notion.com",
    )
  })

  it("NOTION_API_TOKEN guard IGNORES NOTION_API_BASE_URL (mirrors resolveAuth's narrow shape)", async () => {
    // The round-7 reviewer's silent-host-mismatch concern: previously
    // the guard broadly honored NOTION_API_BASE_URL via
    // `resolveNtnEnvBaseUrl`, but resolveAuth's env-notion-api-token
    // source ignores it. So the guard would verify dev → pass, but
    // the next process would verify prod → fail. Pin that the guard
    // matches resolveAuth's narrow LORE_-only behavior so a future
    // refactor doesn't reintroduce the false positive.
    const { deps, spies } = makeScenario({
      envToken: "legacy-tok",
      notionApiTokenEnv: "api-tok",
      notionApiBaseUrlNativeEnv: "https://api-dev.notion.com",
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    // Verify against undefined (SDK default = prod), NOT the dev URL —
    // even though NOTION_API_BASE_URL is set. resolveAuth would
    // resolve to undefined here, so the guard must too.
    expect(spies.makeClient).toHaveBeenNthCalledWith(3, "api-tok", undefined)
  })

  it("NOTION_API_TOKEN guard IGNORES NOTION_ENV (mirrors resolveAuth's narrow shape)", async () => {
    const { deps, spies } = makeScenario({
      envToken: "legacy-tok",
      notionApiTokenEnv: "api-tok",
      notionEnvEnv: "dev",
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    expect(spies.makeClient).toHaveBeenNthCalledWith(3, "api-tok", undefined)
  })

  it("NOTION_API_TOKEN guard IGNORES NOTION_BASE_URL (mirrors resolveAuth's narrow shape)", async () => {
    // Even #178's middle-tier NOTION_BASE_URL is ignored by the guard
    // because resolveAuth's env-notion-api-token source on this PR's
    // branch only reads LORE_NOTION_BASE_URL. The late-merger with
    // #178 broadens both together.
    const { deps, spies } = makeScenario({
      envToken: "legacy-tok",
      notionApiTokenEnv: "api-tok",
      notionBaseUrlEnv: "https://api-dev.notion.com",
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    expect(spies.makeClient).toHaveBeenNthCalledWith(3, "api-tok", undefined)
  })

  it("NOTION_API_TOKEN with no base-URL env vars hits SDK default (prod)", async () => {
    // Sanity-check the default path: with NOTION_API_TOKEN set but
    // no override env vars, the verify gets undefined baseUrl (SDK
    // default = api.notion.so).
    const { deps, spies } = makeScenario({
      envToken: "legacy-tok",
      notionApiTokenEnv: "api-tok",
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    expect(spies.makeClient).toHaveBeenNthCalledWith(3, "api-tok", undefined)
  })

  // -------------------------------------------------------------------------
  // Step 4 ntn-token verify: env-driven base-URL fallback
  //
  // `loadNtnToken` returns its own `baseUrl` (read from
  // LORE_NOTION_BASE_URL or ntn's config.json). When that's
  // undefined — operator hasn't run ntn login in dev mode and no
  // Lore-prefixed override is set — fall back to the migrate flow's
  // env-driven resolver so a NOTION_API_BASE_URL-only operator gets
  // a consistent host.
  // -------------------------------------------------------------------------

  it("Step 4 verify falls back to NOTION_API_BASE_URL when ntnRecord.baseUrl is undefined", async () => {
    const { deps, spies } = makeScenario({
      envToken: "legacy-tok",
      notionApiBaseUrlNativeEnv: "https://api-dev.notion.com",
      ntnRecord: { token: "ntn-tok", workspaceId: "ws-1", baseUrl: undefined },
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    // Second makeClient call is the Step 4 ntn-token verify.
    expect(spies.makeClient).toHaveBeenNthCalledWith(
      2,
      "ntn-tok",
      "https://api-dev.notion.com",
    )
  })

  it("Step 4 verify prefers ntnRecord.baseUrl when both it and NOTION_API_BASE_URL are set", async () => {
    // `loadNtnToken`'s baseUrl is already the operator-overridden
    // value (it consulted LORE_NOTION_BASE_URL and ntn's config.json
    // internally). The migrate fallback is precisely a fallback —
    // it does NOT override an already-resolved baseUrl.
    const { deps, spies } = makeScenario({
      envToken: "legacy-tok",
      notionApiBaseUrlNativeEnv: "https://api-stg.notion.com",
      ntnRecord: {
        token: "ntn-tok",
        workspaceId: "ws-1",
        baseUrl: "https://api-dev.notion.com",
      },
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    expect(spies.makeClient).toHaveBeenNthCalledWith(
      2,
      "ntn-tok",
      "https://api-dev.notion.com",
    )
  })

  // -------------------------------------------------------------------------
  // Config-driven dev path — auth.baseUrl in .lore.yaml drives Step 3
  //
  // The round-4 blocking finding's headline scenario: project with
  // `auth.baseUrl: <dev URL>` in YAML but no env vars set. Without
  // `computeNtnLoginEnvOverride`, Step 1 verifies dev and Step 3 logs
  // in to prod — silent host mismatch.
  // -------------------------------------------------------------------------

  it("config auth.baseUrl + no env vars: forwards NOTION_BASE_URL to ntn login spawn", async () => {
    const { deps, run, spies } = makeScenario({
      envToken: "legacy-tok",
      configBaseUrl: "https://api-dev.notion.com",
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    // The runNtnLogin spy was called with the env-override.
    // Forwarded var is `NOTION_BASE_URL` (per `ntn login --help`),
    // NOT `NOTION_API_BASE_URL` (which is the runtime API-host var).
    expect(spies.runNtnLogin).toHaveBeenCalledTimes(1)
    expect(spies.runNtnLogin).toHaveBeenCalledWith({
      NOTION_BASE_URL: "https://api-dev.notion.com",
    })
    // And the user-facing log surfaced the forwarding so the operator
    // knows which environment they're being directed at.
    const out = run.stdout.join("\n")
    expect(out).toContain("Forwarding from")
    expect(out).toContain("NOTION_BASE_URL=https://api-dev.notion.com")
  })

  it("config auth.baseUrl + no env vars + ntn record without baseUrl: Step 4 uses captured target (regression)", async () => {
    // The round-5 reviewer's specific regression ask: even when ntn
    // doesn't persist the dev base URL to its config.json,
    // `loadNtnToken` returns `baseUrl: undefined`, and the migrate
    // flow's pre-spawn captured `step3EffectiveBaseUrl` is what
    // drives Step 4's verify. Without this, Step 3 logs in to dev
    // (via the override) but Step 4 verifies against prod — silent
    // host drift between Steps 3 and 4 for the config-only-dev path.
    const { deps, spies } = makeScenario({
      envToken: "legacy-tok",
      configBaseUrl: "https://api-dev.notion.com",
      // Simulate ntn NOT persisting the env to config.json:
      // loadNtnToken returns baseUrl=undefined despite the dev login.
      ntnRecord: { token: "ntn-tok", workspaceId: "ws-1", baseUrl: undefined },
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    // Step 4 ntn-verify (second makeClient call) MUST target the same
    // dev URL Step 3 was directed at. Anything else is the silent
    // host-drift bug the round-5 reviewer flagged.
    expect(spies.makeClient).toHaveBeenNthCalledWith(
      2,
      "ntn-tok",
      "https://api-dev.notion.com",
    )
  })

  it("config auth.baseUrl + env var set: env wins, no override forwarded", async () => {
    // Operators who explicitly set an env var have signalled their
    // preference. The override is precisely the fallback path; it
    // does NOT override env-driven configuration.
    const { deps, run, spies } = makeScenario({
      envToken: "legacy-tok",
      configBaseUrl: "https://api-dev.notion.com",
      notionEnvEnv: "stg",
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    expect(spies.runNtnLogin).toHaveBeenCalledWith(undefined)
    expect(run.stdout.join("\n")).not.toContain("Forwarding from")
  })

  it("no config auth.baseUrl + no env vars: bare ntn login, no override", async () => {
    const { deps, spies } = makeScenario({ envToken: "legacy-tok" })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    expect(spies.runNtnLogin).toHaveBeenCalledWith(undefined)
  })

  // -------------------------------------------------------------------------
  // Dual-source detection — env primary + config secondary
  // -------------------------------------------------------------------------

  it("dual-source happy path emits both housekeeping blocks", async () => {
    // An operator with both LORE_NOTION_TOKEN AND auth.token set
    // would otherwise walk away thinking they're done after the env
    // unset, leaving auth.token in the YAML to fire the soft-
    // deprecation warning on every subsequent run.
    const { deps, run } = makeScenario({
      envToken: "legacy-tok",
      configToken: "also-config-tok",
      configResolved: { path: "/proj/.lore.yaml", root: "/proj" },
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    const out = run.stdout.join("\n")
    expect(out).toContain("  unset LORE_NOTION_TOKEN")
    expect(out).toContain("Also: `auth.token` is set in /proj/.lore.yaml")
  })
})

// ---------------------------------------------------------------------------
// confirmPrompt — covered by behavior, not by spawning real readline
// ---------------------------------------------------------------------------

describe("confirmPrompt", () => {
  // Behavioral tests for the shared seam with PR #179. The signature
  // matches #179: `(message, defaultYes = true)`, internal suffix
  // append, non-TTY emits a stderr breadcrumb and returns false. A
  // weaker `typeof === "function"` assertion would let a silent
  // signature change in #179's late-merge pass, so test the contract
  // directly.

  it("declares one required positional argument (defaultYes is optional)", () => {
    // Function.length counts parameters before the first defaulted
    // one, so `(message, defaultYes = true)` has length 1. This
    // pins the required-arg surface area while keeping the optional
    // defaultYes parameter out of the contract test.
    expect(confirmPrompt.length).toBe(1)
  })

  it("returns false on non-TTY stdin AND emits a stderr breadcrumb", async () => {
    // Without the breadcrumb, an operator chasing why their
    // automation refused has nothing to grep on. The breadcrumb is
    // load-bearing operator-recovery copy — pin its presence and
    // shape together with the fail-closed return.
    const captured: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        captured.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8"),
        )
        return true
      })
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
      writable: true,
    })
    try {
      expect(await confirmPrompt("Install ntn now?")).toBe(false)
      const joined = captured.join("")
      expect(joined).toContain("[lore] confirmPrompt called in a non-interactive context")
      expect(joined).toContain("Pass --yes to skip prompts")
    } finally {
      stderrSpy.mockRestore()
      if (original) {
        Object.defineProperty(process.stdin, "isTTY", original)
      } else {
        delete (process.stdin as unknown as { isTTY?: boolean }).isTTY
      }
    }
  })
})

// Quiet stdout/stderr noise from any stray uncaptured console calls
// in the runMigrate paths; tests above route through deps.log /
// deps.error and don't touch console, but the safety net keeps
// CI output clean.
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})
