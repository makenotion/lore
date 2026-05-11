import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
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
  const actual = await vi.importActual<typeof import("../../auth/ntn.js")>(
    "../../auth/ntn.js",
  )
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
  const actual = await vi.importActual<typeof import("../../auth/oauth.js")>(
    "../../auth/oauth.js",
  )
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
    "../../notion/client.js",
  )
  return { ...actual, createClient: fakeClientHolder.createClient }
})
vi.mock("../../notion/rate-limit.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../notion/rate-limit.js")
  >("../../notion/rate-limit.js")
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
  classifyVaultError,
  computeNtnLoginEnvOverride,
  confirmPrompt,
  findShellRcReferencingLoreToken,
  formatUnsetInstructions,
  inferNtnEnvFromBaseUrl,
  pickAuthAction,
  printAuthSourceLines,
  renderWhoamiIdentity,
  resolveLoginTargetBaseUrl,
  resolveNtnEnvBaseUrl,
  runLogin,
  runLogout,
  runMigrate,
  runStatus,
  runWhoami,
  type MigrateDeps,
} from "./auth.js"
import { MIN_NTN_VERSION } from "../../auth/ntn.js"
import type { ResolvedAuth } from "../../config.js"
import type { LoreConfig } from "../../types.js"

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
    (opts.authToken
      ? `auth:\n  token: ${opts.authToken}\n`
      : "")
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
const ORIGINAL_ISTTY_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  process.stdin,
  "isTTY",
)

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
  ;(fakeClientHolder.client.users.me as unknown as ReturnType<typeof vi.fn>)
    .mockReset()
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
  delete process.env["LORE_NOTION_TOKEN"]
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


// ---------------------------------------------------------------------------
// --migrate (issue 0.10.0/07) tests, helpers
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

  it("returns the canonical prod URL for explicit NOTION_ENV=prod", () => {
    // Round-7 review: returning `undefined` for explicit prod let a
    // stale `auth.baseUrl: <dev URL>` win over an explicit
    // `NOTION_ENV=prod lore auth --migrate` via
    // `computeNtnLoginEnvOverride`'s `resolveNtnEnvBaseUrl(env) ??
    // configBaseUrl` fallback. The fix: return the canonical URL so
    // explicit operator intent is recorded; the prod → "no override"
    // normalization happens later at the spawn / client boundary
    // (`computeNtnLoginEnvOverride` returns `undefined` when migrate's
    // target equals ntn login's native target — both prod URLs match,
    // so no override forwarded; ntn login defaults to prod).
    expect(resolveNtnEnvBaseUrl({ NOTION_ENV: "prod" })).toBe(
      "https://api.notion.so",
    )
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

  it("returns NOTION_ENV mapped to canonical URL (including explicit prod)", () => {
    expect(resolveLoginTargetBaseUrl({ NOTION_ENV: "dev" })).toBe(
      "https://api-dev.notion.com",
    )
    expect(resolveLoginTargetBaseUrl({ NOTION_ENV: "stg" })).toBe(
      "https://api-stg.notion.com",
    )
    // Round-7 review: explicit `NOTION_ENV=prod` returns the canonical
    // prod URL so it pairs symmetrically with `resolveNtnEnvBaseUrl` —
    // `computeNtnLoginEnvOverride`'s "no override when login native
    // target equals migrate target" gate then collapses to "both prod
    // → no override → ntn login defaults to prod" without leaking a
    // stale `auth.baseUrl` past the explicit selector.
    expect(resolveLoginTargetBaseUrl({ NOTION_ENV: "prod" })).toBe(
      "https://api.notion.so",
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

  it("explicit NOTION_ENV=prod beats stale auth.baseUrl=dev (round-7 regression)", () => {
    // Round-7 review blocking finding #1: pre-fix,
    // `resolveNtnEnvBaseUrl({NOTION_ENV: "prod"})` returned `undefined`,
    // so `resolveNtnEnvBaseUrl(env) ?? configBaseUrl` fell through to
    // the stale dev URL. The migrate spawn forwarded
    // `NOTION_BASE_URL=https://api-dev.notion.com` despite the explicit
    // `NOTION_ENV=prod` selector — silently overruling operator intent.
    //
    // Post-fix: the resolver returns the canonical prod URL, so
    // migrateTarget is prod and matches `resolveLoginTargetBaseUrl`'s
    // prod return. They match → no override forwarded → ntn login uses
    // its default (prod). Operator intent preserved.
    expect(
      computeNtnLoginEnvOverride("https://api-dev.notion.com", {
        NOTION_ENV: "prod",
      }),
    ).toBeUndefined()
  })

  it("explicit NOTION_ENV=dev beats stale auth.baseUrl=prod (symmetry)", () => {
    // Symmetric guard: an operator with `auth.baseUrl: https://api.notion.so`
    // in committed config but explicit `NOTION_ENV=dev` in shell wants
    // a dev token; the env var is the more recent / specific signal.
    // ntn login natively reads NOTION_ENV → dev URL; migrateTarget is
    // also dev URL (env wins over config). Match → no override needed
    // because ntn login already gets NOTION_ENV via process.env spread.
    expect(
      computeNtnLoginEnvOverride("https://api.notion.so", {
        NOTION_ENV: "dev",
      }),
    ).toBeUndefined()
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
    expect(err).toContain("Re-run `lore auth --migrate`")
    expect(err).toContain("NOTION_KEYRING=0")
    expect(err).not.toContain("Run `ntn login` again")
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
  // exactly (src/config.ts:243-258), which on this branch resolves the
  // base URL via `resolveOperatorBaseUrl()` — honoring (in priority
  // order) LORE_NOTION_BASE_URL → NOTION_BASE_URL → NOTION_API_BASE_URL
  // → NOTION_ENV. Anything narrower creates a false positive in the
  // opposite direction: a dev operator with `NOTION_API_TOKEN` plus
  // `NOTION_BASE_URL=<dev URL>` would have the guard verify prod
  // (LORE_-only) while the next Lore process verifies dev (via
  // resolveOperatorBaseUrl) — silently greenlighting a migration whose
  // post-migrate session targets a host the api token doesn't authorize,
  // OR falsely aborting a valid migration when the api token IS valid
  // for dev but not prod. Round-7 review blocking finding #2 corrected
  // an earlier round-of-review claim that resolveAuth's source was
  // LORE_-only; on this branch it isn't.
  // -------------------------------------------------------------------------

  it("NOTION_API_TOKEN guard inherits LORE_NOTION_BASE_URL when set (top priority)", async () => {
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

  it("NOTION_API_TOKEN guard inherits NOTION_BASE_URL when LORE_ is unset", async () => {
    // Mirrors `resolveOperatorBaseUrl`'s second-tier priority — the
    // env var that ntn login natively reads, also picked up by the
    // env-notion-api-token resolveAuth path.
    const { deps, spies } = makeScenario({
      envToken: "legacy-tok",
      notionApiTokenEnv: "api-tok",
      notionBaseUrlEnv: "https://api-dev.notion.com",
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    expect(spies.makeClient).toHaveBeenNthCalledWith(
      3,
      "api-tok",
      "https://api-dev.notion.com",
    )
  })

  it("NOTION_API_TOKEN guard inherits NOTION_API_BASE_URL when LORE_ and NOTION_BASE_URL are unset", async () => {
    // ntn-native runtime API-host var; third-tier priority in
    // resolveOperatorBaseUrl. Covered here so the guard's behavior
    // stays in lockstep with resolveAuth's actual env-notion-api-token
    // resolution.
    const { deps, spies } = makeScenario({
      envToken: "legacy-tok",
      notionApiTokenEnv: "api-tok",
      notionApiBaseUrlNativeEnv: "https://api-dev.notion.com",
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    expect(spies.makeClient).toHaveBeenNthCalledWith(
      3,
      "api-tok",
      "https://api-dev.notion.com",
    )
  })

  it("NOTION_API_TOKEN guard inherits NOTION_ENV mapped to canonical URL", async () => {
    // Fourth-tier priority — env-name shortcut. resolveOperatorBaseUrl
    // maps it via ntnEnvBaseUrl, so the guard must too.
    const { deps, spies } = makeScenario({
      envToken: "legacy-tok",
      notionApiTokenEnv: "api-tok",
      notionEnvEnv: "dev",
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    expect(spies.makeClient).toHaveBeenNthCalledWith(
      3,
      "api-tok",
      "https://api-dev.notion.com",
    )
  })

  it("NOTION_API_TOKEN guard LORE_NOTION_BASE_URL beats NOTION_BASE_URL beats NOTION_API_BASE_URL beats NOTION_ENV (priority pin)", async () => {
    // Pin the full priority chain so a future refactor reordering
    // resolveOperatorBaseUrl loudly breaks the guard's mirror. With
    // all four set, the LORE_-prefixed value wins.
    const { deps, spies } = makeScenario({
      envToken: "legacy-tok",
      notionApiTokenEnv: "api-tok",
      notionApiBaseUrlEnv: "https://lore-tier.example",
      notionBaseUrlEnv: "https://middle-tier.example",
      notionApiBaseUrlNativeEnv: "https://ntn-tier.example",
      notionEnvEnv: "dev",
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    expect(spies.makeClient).toHaveBeenNthCalledWith(
      3,
      "api-tok",
      "https://lore-tier.example",
    )
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

  it("explicit NOTION_ENV=prod beats stale config auth.baseUrl=dev (round-7 regression)", async () => {
    // Round-7 review blocking finding #1, full-orchestrator coverage
    // for the pure-helper pin in the computeNtnLoginEnvOverride
    // describe block above. An operator running
    // `NOTION_ENV=prod lore auth --migrate` in a repo whose
    // `.lore.yaml` still carries `auth.baseUrl: https://api-dev.notion.com`
    // pre-fix had the dev config win — the migrate spawn forwarded
    // `NOTION_BASE_URL=dev` despite the explicit prod selector. This
    // pins that the explicit operator selector is preserved end-to-end:
    // no override is forwarded to ntn login (because ntn login
    // natively reads NOTION_ENV=prod via process.env spread), and the
    // user-facing "Forwarding from" log doesn't fire.
    const { deps, run, spies } = makeScenario({
      envToken: "legacy-tok",
      configBaseUrl: "https://api-dev.notion.com",
      notionEnvEnv: "prod",
    })
    const result = await runMigrate({}, deps)
    expect(result.exitCode).toBe(0)
    expect(spies.runNtnLogin).toHaveBeenCalledTimes(1)
    expect(spies.runNtnLogin).toHaveBeenCalledWith(undefined)
    expect(run.stdout.join("\n")).not.toContain("Forwarding from")
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

describe("inferNtnEnvFromBaseUrl", () => {
  it("maps the dev base URL to 'dev'", () => {
    expect(inferNtnEnvFromBaseUrl("https://api-dev.notion.com")).toBe("dev")
  })

  it("maps the stg base URL to 'stg'", () => {
    expect(inferNtnEnvFromBaseUrl("https://api-stg.notion.com")).toBe("stg")
  })

  it("maps the prod base URL (legacy `.so`) to 'prod'", () => {
    expect(inferNtnEnvFromBaseUrl("https://api.notion.so")).toBe("prod")
  })

  it("maps the prod base URL (`.com` variant) to 'prod'", () => {
    // Notion is migrating public surfaces from `.so` to `.com`; both
    // resolve. The mapping must accept either form so a future
    // .lore.yaml update doesn't silently demote prod to "unknown".
    expect(inferNtnEnvFromBaseUrl("https://api.notion.com")).toBe("prod")
  })

  it("returns undefined for an unrecognized URL — caller falls through to ntn's default", () => {
    expect(inferNtnEnvFromBaseUrl("https://attacker.example")).toBeUndefined()
    expect(inferNtnEnvFromBaseUrl("https://internal.notion.team/api")).toBeUndefined()
  })

  it("returns undefined for empty / undefined / null inputs", () => {
    expect(inferNtnEnvFromBaseUrl(undefined)).toBeUndefined()
    expect(inferNtnEnvFromBaseUrl("")).toBeUndefined()
  })

  it("is exact-match — a canonical URL with extra path does NOT match", () => {
    // Pin the consolidated exact-match policy. A `.lore.yaml`
    // carrying `auth.baseUrl: https://api-dev.notion.com/v1` would
    // not round-trip cleanly through ntn's resolution anyway (ntn
    // appends its own path), so refusing the inference is the right
    // call. Exact-match also closes a small attack surface where a
    // substring matcher could be tricked by a hostile baseUrl whose
    // path embeds a canonical URL fragment.
    expect(
      inferNtnEnvFromBaseUrl("https://api-dev.notion.com/v1"),
    ).toBeUndefined()
    expect(
      inferNtnEnvFromBaseUrl("https://attacker.example/api.notion.so"),
    ).toBeUndefined()
  })
})

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
    // stderr warning. (--migrate is added by issue 0.10.0/07; this
    // PR's ladder reserves the top slot.)
    expect(
      pickAuthAction({
        status: true,
        login: true,
        whoami: true,
        logout: true,
      }),
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

  it("prints LORE_NOTION_TOKEN soft-deprecation + migrate recommendation", () => {
    const auth: ResolvedAuth = {
      token: "tok",
      source: "env-lore-notion-token",
    }
    printAuthSourceLines(auth)
    expect(stdoutText()).toContain(
      "Source: LORE_NOTION_TOKEN (env, soft-deprecated)",
    )
    expect(stdoutText()).toContain("lore auth --migrate")
  })

  it("prints config-auth-token soft-deprecation copy", () => {
    const auth: ResolvedAuth = {
      token: "tok",
      source: "config-auth-token",
    }
    printAuthSourceLines(auth)
    expect(stdoutText()).toContain(
      "Source: auth.token in .lore.yaml (soft-deprecated)",
    )
    expect(stdoutText()).toContain("then remove auth.token from .lore.yaml")
  })

  it("surfaces a Shadow line when LORE_NOTION_TOKEN is set but not active", () => {
    process.env["LORE_NOTION_TOKEN"] = "shadow-tok"
    const auth: ResolvedAuth = {
      token: "tok",
      source: "ntn-auth-json",
      workspaceId: "ws-1",
    }
    printAuthSourceLines(auth)
    expect(stdoutText()).toContain(
      "Shadow: LORE_NOTION_TOKEN is set in env but not active",
    )
  })

  it("does NOT add a Shadow line when LORE_NOTION_TOKEN itself is the active source", () => {
    process.env["LORE_NOTION_TOKEN"] = "shadow-tok"
    const auth: ResolvedAuth = {
      token: "shadow-tok",
      source: "env-lore-notion-token",
    }
    printAuthSourceLines(auth)
    expect(stdoutText()).not.toContain("Shadow")
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
    expect(stdoutText()).toContain("docs/internal-rollout.md")
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

  it("prints config-auth-token source when only auth.token is set", async () => {
    setupVaultProject({ authToken: "tok-from-config" })
    // Suppress deprecation marker writes (debounced filesystem state)
    process.env["LORE_SUPPRESS_DEPRECATIONS"] = "1"
    verifyVaultAccessMock.mockResolvedValue({
      kind: "ok",
      pageTitle: "Cfg Vault",
    })
    await runStatus()
    expect(stdoutText()).toContain(
      "Source: auth.token in .lore.yaml (soft-deprecated)",
    )
    expect(stdoutText()).toContain("✓ Vault page accessible: Cfg Vault")
  })

  it("prints LORE_NOTION_TOKEN source + migrate recommendation", async () => {
    setupVaultProject()
    process.env["LORE_NOTION_TOKEN"] = "tok-legacy"
    process.env["LORE_SUPPRESS_DEPRECATIONS"] = "1"
    verifyVaultAccessMock.mockResolvedValue({
      kind: "ok",
      pageTitle: null,
    })
    await runStatus()
    expect(stdoutText()).toContain("Source: LORE_NOTION_TOKEN (env, soft-deprecated)")
    expect(stdoutText()).toContain("lore auth --migrate")
  })

  it("surfaces preflight not-found with the documented message", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    verifyVaultAccessMock.mockResolvedValue({
      kind: "not-found",
      pageId: "abc",
      message: "Vault page not accessible. Wrong workspace or not shared.",
    })
    await runStatus()
    expect(stdoutText()).toContain("✗ Vault page NOT accessible")
    expect(stdoutText()).toContain("Wrong workspace or not shared")
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

  it("surfaces preflight unauthorized with re-auth recommendation (distinct from not-found)", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    verifyVaultAccessMock.mockResolvedValue({
      kind: "unauthorized",
      pageId: "abc",
      message:
        "Notion rejected the bearer token. The token is invalid, expired, or revoked.",
    })
    await runStatus()
    expect(stdoutText()).toContain(
      "✗ Vault preflight: token rejected (unauthorized)",
    )
    expect(stdoutText()).toContain("invalid, expired, or revoked")
    // Re-auth is the right next action — distinct from `not-found`'s
    // workspace / share-mismatch messaging.
    expect(stdoutText()).toContain(
      "Recommended: run `lore auth --login` to issue a fresh token",
    )
    // Must NOT collapse into the wrong-workspace/sharing copy.
    expect(stdoutText()).not.toContain("workspace containing the page")
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
      "Recommended: run `lore auth --login` to issue a fresh token",
    )
  })

  it("prints not-authenticated + ntn-not-installed hint when no token resolves AND ntn is missing", async () => {
    setupVaultProject()
    ntnMocks.isNtnInstalled.mockReturnValue(false)
    // No env vars, no auth.token in config — resolveAuth throws.
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

  it("surfaces auth.baseUrl in --status output when set in .lore.yaml on a legacy source", async () => {
    // resolveAuth pulls `auth.baseUrl` from .lore.yaml on the legacy
    // paths only (the canonical paths drop the override for
    // security). Surface it on --status so a malicious-yaml redirect
    // is at least visible to the operator instead of silently
    // routing their token to attacker.example.
    const dir = mkdtempSync(join(SCRATCH, "vault-baseurl-"))
    scratchDirsToClean.push(dir)
    writeFileSync(
      join(dir, ".lore.yaml"),
      `vault:\n  pageId: page-baseurl\nauth:\n  baseUrl: https://api-dev.notion.com\n`,
      "utf-8",
    )
    process.chdir(dir)
    process.env["LORE_NOTION_TOKEN"] = "tok-legacy"
    process.env["LORE_SUPPRESS_DEPRECATIONS"] = "1"
    verifyVaultAccessMock.mockResolvedValue({ kind: "ok", pageTitle: "V" })
    await runStatus()
    expect(stdoutText()).toContain("Notion base URL:")
    expect(stdoutText()).toContain("https://api-dev.notion.com")
  })

  it("prints the file-path-specific note for the config-auth-token source", async () => {
    const dir = setupVaultProject({ authToken: "tok-from-config" })
    process.env["LORE_SUPPRESS_DEPRECATIONS"] = "1"
    verifyVaultAccessMock.mockResolvedValue({ kind: "ok", pageTitle: null })
    await runStatus()
    // findConfigFile resolves through realpath on macOS (/tmp ->
    // /private/var/folders/...), so just match the structural
    // wording — the path itself is exercised by the smoke test.
    expect(stdoutText()).toMatch(
      /\(Edit .*\.lore\.yaml to remove the auth\.token field\.\)/,
    )
    // The resolved path the test created MUST appear somewhere in
    // the body — under either /tmp/... or its /private/... realpath
    // form depending on the host OS.
    expect(stdoutText()).toContain(realpathSync(dir))
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
    await expect(runLogin({ yes: false })).rejects.toThrow(
      "__process_exit_1__",
    )
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
    expect(stdoutText()).toContain("Running `NOTION_KEYRING=0 NOTION_ENV=dev ntn login`...")
  })

  it("threads NOTION_ENV=stg through (not just dev) — pin so a future hard-coded `dev` regresses loudly", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    process.env["NOTION_ENV"] = "stg"
    ntnMocks.runNtnLogin.mockResolvedValue({ kind: "success" })
    verifyVaultAccessMock.mockResolvedValue({ kind: "ok", pageTitle: "V" })

    await runLogin({ yes: true })

    expect(ntnMocks.runNtnLogin).toHaveBeenCalledWith({ env: "stg" })
    expect(stdoutText()).toContain("Running `NOTION_KEYRING=0 NOTION_ENV=stg ntn login`...")
  })

  it("infers `--env dev` from .lore.yaml `auth.baseUrl` when shell NOTION_ENV is unset (Mail-style dev project)", async () => {
    // Round-5 review blocker: a Mail-style dev project ships
    // `auth.baseUrl: https://api-dev.notion.com` in committed
    // .lore.yaml. Without this fix, `lore auth --login` from that
    // project (without shell NOTION_ENV) ran bare `ntn login` (prod)
    // and silently mismatched the operator's vault. Now Lore reads
    // the config baseUrl, infers `dev`, and prints a transparency
    // line so the operator sees which env is being targeted.
    const dir = mkdtempSync(join(SCRATCH, "vault-dev-"))
    scratchDirsToClean.push(dir)
    writeFileSync(
      join(dir, ".lore.yaml"),
      `vault:\n  pageId: page-dev\nauth:\n  baseUrl: https://api-dev.notion.com\n`,
      "utf-8",
    )
    process.chdir(dir)
    process.env["NOTION_API_TOKEN"] = "tok"
    delete process.env["NOTION_ENV"]
    ntnMocks.runNtnLogin.mockResolvedValue({ kind: "success" })
    verifyVaultAccessMock.mockResolvedValue({ kind: "ok", pageTitle: "V" })

    await runLogin({ yes: true })

    expect(ntnMocks.runNtnLogin).toHaveBeenCalledWith({ env: "dev" })
    expect(stdoutText()).toContain(
      "(Inferring `NOTION_ENV=dev` from auth.baseUrl in .lore.yaml.)",
    )
    expect(stdoutText()).toContain("Running `NOTION_KEYRING=0 NOTION_ENV=dev ntn login`...")
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
      "utf-8",
    )
    process.chdir(dir)
    process.env["NOTION_API_TOKEN"] = "tok"
    process.env["NOTION_ENV"] = "stg"
    ntnMocks.runNtnLogin.mockResolvedValue({ kind: "success" })
    verifyVaultAccessMock.mockResolvedValue({ kind: "ok", pageTitle: "V" })

    await runLogin({ yes: true })

    expect(ntnMocks.runNtnLogin).toHaveBeenCalledWith({ env: "stg" })
    expect(stdoutText()).toContain("Running `NOTION_KEYRING=0 NOTION_ENV=stg ntn login`...")
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
      "utf-8",
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

  it("Mail-style end-to-end: config-derived dev env, no NOTION_API_TOKEN, post-login resolves ntn-auth-json with dev baseUrl, createClient receives api-dev.notion.com", async () => {
    // Round-6 coverage gap: the config-derived `--env dev` test above
    // sets `NOTION_API_TOKEN` so it short-circuits past the
    // ntn-auth-json branch — proving the spawn selector but NOT the
    // post-login preflight client construction. This pins the full
    // Mail-style flow:
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
    const dir = mkdtempSync(join(SCRATCH, "vault-mail-style-"))
    scratchDirsToClean.push(dir)
    writeFileSync(
      join(dir, ".lore.yaml"),
      `vault:\n  pageId: page-mail\nauth:\n  baseUrl: https://api-dev.notion.com\n`,
      "utf-8",
    )
    process.chdir(dir)
    delete process.env["NOTION_API_TOKEN"]
    delete process.env["LORE_NOTION_TOKEN"]
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
      pageTitle: "Mail Vault",
    })

    await runLogin({ yes: true })

    // Step 3 — config-derived `--env dev` reaches the spawn.
    expect(ntnMocks.runNtnLogin).toHaveBeenCalledWith({ env: "dev" })
    expect(stdoutText()).toContain(
      "(Inferring `NOTION_ENV=dev` from auth.baseUrl in .lore.yaml.)",
    )
    expect(stdoutText()).toContain("Running `NOTION_KEYRING=0 NOTION_ENV=dev ntn login`...")

    // Step 4 — createClient receives the ntn-resolved (dev) baseUrl.
    // This is the round-6 reviewer's specific ask: prove that the
    // post-login preflight client targets api-dev, not the prod
    // default that bare-args createClient would resolve.
    expect(fakeClientHolder.createClient).toHaveBeenCalledWith(
      "tok-ntn-dev",
      "https://api-dev.notion.com",
    )

    // Step 4 — preflight ran against the constructed client and the
    // operator sees the workspace label confirming the ntn-auth-json
    // path resolved.
    expect(verifyVaultAccessMock).toHaveBeenCalledTimes(1)
    expect(stdoutText()).toContain(
      "✓ Authenticated; vault page reachable: Mail Vault",
    )
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
    ntnMocks.isNtnInstalled
      .mockReturnValueOnce(true)
      .mockReturnValue(false)
    ntnMocks.installNtn.mockResolvedValue({ kind: "success" })
    const exit = mockProcessExit()
    await expect(runLogin({ yes: true })).rejects.toThrow("__process_exit_1__")
    // Acceptance criterion text from Phase-2/06: "handled differently
    // from exit-non-zero; surfaces 'ntn not found on PATH' and offers
    // re-install if appropriate."
    expect(stderrText()).toContain("`ntn` does not appear to be on PATH")
    expect(stderrText()).toContain("Re-installing via:")
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
    ntnMocks.isNtnInstalled
      .mockReturnValueOnce(true)
      .mockReturnValue(false)
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    })
    const exit = mockProcessExit()
    await expect(runLogin({ yes: false })).rejects.toThrow(
      "__process_exit_1__",
    )
    // Re-install offer is gated on (--yes || TTY); this branch hits
    // neither, so we fall through to the manual-recovery copy.
    expect(stderrText()).toContain("`ntn` does not appear to be on PATH")
    expect(stderrText()).toContain("Manual re-install:")
    // The --yes hint MUST appear so a CI script consumer hitting
    // this knows about the auto-recovery option, mirroring the
    // install-from-missing branch's hint.
    expect(stderrText()).toContain(
      "Pass --yes (next run) to consent to the canonical re-install",
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
    expect(stderrText()).toContain(
      "authenticated against the wrong workspace",
    )
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
      "✗ Vault page not accessible after login (unauthorized)",
    )
    expect(stderrText()).toContain("Notion rejected the bearer token")
    expect(stderrText()).toContain(
      "Recommended: re-run `lore auth --login` to issue a fresh token.",
    )
    expect(stderrText()).toContain("workspace")
    // The wrong-workspace numbered list MUST NOT fire — that's the
    // not-found branch's copy.
    expect(stderrText()).not.toContain(
      "1. You authenticated against the wrong workspace",
    )
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
      "✗ Vault page not accessible after login (rate-limited)",
    )
    expect(stderrText()).toContain("throttled")
    expect(stderrText()).toContain(
      "Wait a few seconds and re-run `lore auth --login`",
    )
    // 429 is transient — must NOT trigger re-auth or wrong-workspace
    // copy.
    expect(stderrText()).not.toContain(
      "1. You authenticated against the wrong workspace",
    )
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
      "✗ Vault page not accessible after login (unknown-error)",
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
            workspace_name: "Mail",
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
            workspace_name: "Mail",
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
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)
    const client = {
      users: { me: vi.fn().mockResolvedValue({ bot: {} }) },
    } as unknown as Client
    expect(await renderWhoamiIdentity(client)).toBe("<unknown>")
    // The breadcrumb tells the operator the token is valid but the
    // identity is opaque — distinguishes "valid token, opaque shape"
    // from "the CLI silently returned a sentinel."
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("identity is opaque"),
    )
    stderrSpy.mockRestore()
  })

  it("renderWhoamiIdentity exits 1 with the documented error wording when users.me throws", async () => {
    const client = {
      users: {
        me: vi.fn().mockRejectedValue(new Error("network exploded")),
      },
    } as unknown as Client
    const exit = mockProcessExit()
    await expect(renderWhoamiIdentity(client)).rejects.toThrow(
      "__process_exit_1__",
    )
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
    ;(fakeClientHolder.client.users.me as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue({
        bot: {
          owner: {
            type: "user",
            user: { id: "id-x", name: "Hesham", object: "user" },
          },
        },
      })
    await runWhoami()
    expect(stdoutText()).toBe("Hesham\n")
  })

  it("runWhoami without .lore.yaml AND no global auth: exits 1 with the Not authenticated message", async () => {
    setupNoVaultContext()
    const exit = mockProcessExit()
    await expect(runWhoami()).rejects.toThrow("__process_exit_1__")
    expect(stderrText()).toContain("Not authenticated. Run `lore auth --login`")
    exit.restore()
  })

  it("runWhoami without .lore.yaml resolves the legacy LORE_NOTION_TOKEN source", async () => {
    // Pin the legacy-env path's behavior outside a vault context.
    // `LORE_SUPPRESS_DEPRECATIONS=1` keeps the test deterministic by
    // bypassing the deprecation marker; the default branch (no
    // suppress) runs on the same code path with marker noise.
    setupNoVaultContext()
    process.env["LORE_NOTION_TOKEN"] = "tok-legacy"
    process.env["LORE_SUPPRESS_DEPRECATIONS"] = "1"
    ;(fakeClientHolder.client.users.me as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue({
        bot: {
          owner: {
            type: "user",
            user: { id: "id-legacy", name: "Legacy", object: "user" },
          },
        },
      })
    await runWhoami()
    expect(stdoutText()).toBe("Legacy\n")
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
    ;(fakeClientHolder.client.users.me as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue({
        bot: {
          owner: {
            type: "user",
            user: { id: "id-1", name: "Hesham", object: "user" },
          },
        },
      })
    await runWhoami()
    // Single trailing newline; the only stdout line is the identity.
    expect(stdoutText()).toBe("Hesham\n")
  })

  it("runWhoami prints just the id when only an id is present (script-friendly)", async () => {
    setupVaultProject()
    process.env["NOTION_API_TOKEN"] = "tok"
    ;(fakeClientHolder.client.users.me as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue({
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
    ;(fakeClientHolder.client.users.me as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue({
        bot: {
          owner: { type: "workspace", workspace: true },
          workspace_name: "Notion HQ",
        },
      })
    await runWhoami()
    expect(stdoutText()).toBe("<bot in Notion HQ>\n")
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

  it("points at unset LORE_NOTION_TOKEN for the env-lore-notion-token source", async () => {
    setupVaultProject()
    process.env["LORE_NOTION_TOKEN"] = "tok"
    process.env["LORE_SUPPRESS_DEPRECATIONS"] = "1"
    await runLogout()
    expect(stdoutText()).toContain("unset LORE_NOTION_TOKEN")
    expect(stdoutText()).toContain("lore auth --migrate")
  })

  it("names the .lore.yaml path for the config-auth-token source", async () => {
    const dir = setupVaultProject({ authToken: "tok-cfg" })
    process.env["LORE_SUPPRESS_DEPRECATIONS"] = "1"
    await runLogout()
    expect(stdoutText()).toContain("auth.token field")
    expect(stdoutText()).toContain(dir)
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
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    })
    try {
      expect(await confirmPrompt("Install?")).toBe(false)
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("non-interactive context"),
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
      "Warning: multiple auth flags supplied; running --logout and ignoring --whoami, --status",
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
