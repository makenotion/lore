import type { Client } from "@notionhq/client"
import { Command } from "commander"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline/promises"

import {
  installNtn,
  isNtnInstalled,
  loadNtnToken,
  NTN_INSTALL_COMMAND,
  runNtnLogin,
  type NtnInstallResult,
  type NtnLoginResult,
  type NtnTokenRecord,
} from "../../auth/ntn.js"
import {
  loadCredentials,
  runOAuthFlow,
  verifyVaultAccess,
  type VaultAccessResult,
} from "../../auth/oauth.js"
import { findConfigFile, loadConfig } from "../../config.js"
import { createClient } from "../../notion/client.js"
import { createLimitedClient } from "../../notion/rate-limit.js"

export const authCommand = new Command("auth")
  .description("Authenticate with Notion via OAuth or check token status")
  .option("--login", "Start the OAuth browser login flow")
  .option("--status", "Check authentication status (default)")
  .option(
    "--migrate",
    "Walk through migrating from LORE_NOTION_TOKEN (or auth.token in config) to ntn-first auth",
  )
  .option("-y, --yes", "Skip confirmation prompts (non-interactive automation)")
  .action(
    async (opts: {
      login?: boolean
      status?: boolean
      migrate?: boolean
      yes?: boolean
    }) => {
      if (opts.migrate) {
        const result = await runMigrate({ yes: opts.yes }, productionMigrateDeps())
        if (result.exitCode !== 0) process.exit(result.exitCode)
        return
      }
      if (opts.login) {
        await login()
        return
      }
      await status()
    },
  )

async function login(): Promise<void> {
  const clientId = process.env["LORE_OAUTH_CLIENT_ID"]
  const clientSecret = process.env["LORE_OAUTH_CLIENT_SECRET"]

  if (!clientId || !clientSecret) {
    console.error("OAuth client credentials not configured.")
    console.error("")
    console.error("Set these environment variables:")
    console.error("  LORE_OAUTH_CLIENT_ID=<your integration's OAuth client ID>")
    console.error("  LORE_OAUTH_CLIENT_SECRET=<your integration's OAuth client secret>")
    console.error("")
    console.error("Create a public integration at:")
    console.error("  https://www.notion.so/profile/integrations")
    process.exit(1)
  }

  try {
    const credentials = await runOAuthFlow({ clientId, clientSecret })
    console.log("Authenticated successfully!")
    console.log(`  Workspace: ${credentials.workspace_name ?? credentials.workspace_id}`)
    console.log(`  Credentials saved to ~/.lore/credentials.json`)
  } catch (err) {
    console.error("Authentication failed:", err instanceof Error ? err.message : err)
    process.exit(1)
  }
}

async function status(): Promise<void> {
  // Check all auth sources in priority order
  const envToken = process.env["LORE_NOTION_TOKEN"]
  if (envToken) {
    console.log("Auth method: environment variable (LORE_NOTION_TOKEN)")
    console.log(`Token: configured (${envToken.length} characters)`)
    return
  }

  const creds = await loadCredentials()
  if (creds) {
    console.log("Auth method: OAuth")
    console.log(`  Workspace: ${creds.workspace_name ?? creds.workspace_id}`)
    console.log(`  Authorized: ${creds.created_at.split("T")[0]}`)
    return
  }

  console.log("Not authenticated.")
  console.log("")
  console.log("Options:")
  console.log("  lore auth --login            Authenticate via OAuth (opens browser)")
  console.log("  export LORE_NOTION_TOKEN=...  Set an integration token")
}

// ---------------------------------------------------------------------------
// `lore auth --migrate`
//
// Walks an operator with `LORE_NOTION_TOKEN` set (or `auth.token` in config)
// through running `ntn login`, double-preflights before/after to confirm the
// new token reaches the same vault, and prints unset instructions with
// shell-rc location detection. See Phase-2/07-lore-auth-migrate.md for the
// full design.
//
// `runMigrate` takes a dependency bag so tests can stub the Notion-touching
// pieces, the spawn helpers, and the prompt without process globals — same
// posture as `runReconcile` / `dispatchInstall`. The commander dispatch above
// supplies `productionMigrateDeps()` for the live path.
// ---------------------------------------------------------------------------

/**
 * Confirmation-prompt helper. **Shared seam with #06 (PR #179).**
 *
 * `lore auth --status` / `--login` / `--whoami` / `--logout` (issue
 * #06) and this issue (#07) both prompt the operator on
 * potentially-destructive actions. The two issues ship in parallel;
 * whoever lands first in the merge train introduces the helper, the
 * other rebases on the lexical seam.
 *
 * The signature matches PR #179 byte-for-byte so the late-merge
 * rebase collapses one of the two definitions cleanly:
 *
 * - **`(message, defaultYes = true)`**. The helper appends the
 *   `[Y/n]` / `[y/N]` suffix internally so every call site reads as
 *   the bare prompt the operator means, not the literal terminal
 *   line. Empty input returns `defaultYes` (so a `[y/N]` prompt with
 *   empty input refuses, matching the convention).
 * - **Non-TTY breadcrumb**. The defensive `process.stdin.isTTY`
 *   guard returns `false` rather than hanging on a stdin that will
 *   never deliver. It also writes a stderr line so an operator
 *   chasing why their automation refused has something to grep
 *   on — without the breadcrumb, "lore exited 1 silently" is the
 *   trail. Under normal flow callers gate on `--yes` /
 *   `process.stdin.isTTY` before invoking; the guard is the
 *   fail-closed safety net for a missed gate.
 * - Closes readline cleanly on every exit path.
 */
export async function confirmPrompt(
  message: string,
  defaultYes = true,
): Promise<boolean> {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "[lore] confirmPrompt called in a non-interactive context; refusing. Pass --yes to skip prompts.\n",
    )
    return false
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const suffix = defaultYes ? "[Y/n]" : "[y/N]"
    const answer = await rl.question(`${message} ${suffix} `)
    const normalized = answer.trim().toLowerCase()
    if (normalized === "") return defaultYes
    return normalized === "y" || normalized === "yes"
  } finally {
    rl.close()
  }
}

/**
 * Result of a `runMigrate` invocation. Returning `{ exitCode }` rather
 * than calling `process.exit` directly lets tests assert outcomes
 * without process globals; the commander dispatch above maps the code
 * onto `process.exit`.
 */
export interface MigrateResult {
  exitCode: 0 | 1
}

export interface MigrateOptions {
  yes?: boolean
}

/**
 * Outcome of a candidate-shell-rc-files walk. Returns the first file
 * containing `LORE_NOTION_TOKEN`, or null when no candidate matched.
 * Best-effort: missing files / unreadable permissions / unconventional
 * shell-rc locations all fall through to null and the generic
 * unset-instruction message.
 */
export type ShellRcFinder = () => Promise<string | null>

/**
 * Canonical Notion API base URLs per ntn's `NOTION_ENV` switch.
 *
 * Mirrors the env→URL mapping in `src/auth/ntn.ts:resolveNtnBaseUrl`
 * (private to that module) so a future change in one place needs the
 * other updated. `prod` resolves to `undefined` rather than the literal
 * URL because the `@notionhq/client` SDK default is prod — passing
 * `undefined` lets the SDK pick its canonical value rather than
 * pinning it here. Unknown env names also resolve to `undefined`
 * (treat as prod, matching ntn's own behavior).
 */
const NTN_ENV_BASE_URLS: Record<string, string> = {
  dev: "https://api-dev.notion.com",
  stg: "https://api-stg.notion.com",
}

/**
 * Resolve the Notion API base URL the migrate flow should use,
 * priority order:
 *
 *   1. `LORE_NOTION_BASE_URL` — Lore-specific override. Matches the
 *      shape `resolveAuth` uses for its `env-notion-api-token` source
 *      (`src/config.ts:246-253`).
 *   2. `NOTION_BASE_URL` — the env-var name PR #178's
 *      `resolveOperatorBaseUrl` introduces between the Lore-prefixed
 *      and ntn-API names. Including it here keeps migrate's
 *      env-resolution byte-compatible with #178's contract; the
 *      late-merger collapses both helpers cleanly.
 *   3. `NOTION_API_BASE_URL` — ntn's native override. Documented in
 *      `ntn --help` as the explicit dev/staging endpoint switch. An
 *      operator following ntn's docs sets this; without consulting it
 *      Lore would silently verify against prod while ntn login itself
 *      targeted dev — the round-4 blocking finding that prompted this
 *      helper's introduction.
 *   4. `NOTION_ENV` — ntn's environment switch (`dev` / `stg`),
 *      mapped to the canonical URL via `NTN_ENV_BASE_URLS`. Covers
 *      the case where the operator uses the env-name shortcut rather
 *      than the literal URL.
 *
 * Returns `undefined` when no override applies (SDK default = prod).
 *
 * **Used at every Notion-touching site in the migrate flow** — Step 4
 * ntn-verify (when `loadNtnToken` returns no baseUrl) and the
 * post-Step-4 NOTION_API_TOKEN guard. The login spawn (Step 3)
 * receives an explicit env-override via `computeNtnLoginEnvOverride`
 * so the config-driven `auth.baseUrl: <dev URL>` case threads through
 * correctly even when no env var is set.
 *
 * Takes `env: NodeJS.ProcessEnv` rather than reading `process.env`
 * directly so tests can stub via `MigrateDeps.env()`.
 */
export function resolveNtnEnvBaseUrl(
  env: NodeJS.ProcessEnv,
): string | undefined {
  const loreOverride = env["LORE_NOTION_BASE_URL"]
  if (loreOverride) return loreOverride
  const middleOverride = env["NOTION_BASE_URL"]
  if (middleOverride) return middleOverride
  const nativeOverride = env["NOTION_API_BASE_URL"]
  if (nativeOverride) return nativeOverride
  const envName = env["NOTION_ENV"]
  if (envName) return NTN_ENV_BASE_URLS[envName]
  return undefined
}

/**
 * Resolve the URL `ntn login` would natively target without any
 * Lore-driven env override. ntn login reads only `NOTION_BASE_URL`
 * and `NOTION_ENV` per `ntn login --help` — it does NOT read
 * `LORE_NOTION_BASE_URL` (a Lore-specific name) or
 * `NOTION_API_BASE_URL` (the runtime API-host var, used by
 * already-issued requests). The split between this helper and
 * `resolveNtnEnvBaseUrl` is load-bearing: an operator who set only
 * `NOTION_API_BASE_URL=<dev URL>` has signalled their dev intent for
 * Lore's verifies, but ntn login itself wouldn't know — so migrate
 * has to translate that intent into a `NOTION_BASE_URL=<URL>`
 * spawn override.
 *
 * Returns `undefined` when ntn login would default to prod.
 */
export function resolveLoginTargetBaseUrl(
  env: NodeJS.ProcessEnv,
): string | undefined {
  const direct = env["NOTION_BASE_URL"]
  if (direct) return direct
  const envName = env["NOTION_ENV"]
  if (envName) return NTN_ENV_BASE_URLS[envName]
  return undefined
}

/**
 * Compute the env-override (if any) that `runNtnLogin` should spawn
 * with so ntn login targets the same Notion host every other migrate
 * site is using.
 *
 * The blind spot this closes: a project with `.lore.yaml` carrying
 * `auth.baseUrl: https://api-dev.notion.com` (or with only
 * `NOTION_API_BASE_URL` / `LORE_NOTION_BASE_URL` set in env) would
 * have Step 1 verify the legacy token against dev, then run a bare
 * `ntn login` that defaults to prod (because none of those vars are
 * what ntn login natively reads), then verify a freshly-issued prod
 * token at Step 4 against the dev vault — silent host mismatch.
 *
 * Resolution:
 *
 *   1. **Compute migrate's intended target** via
 *      `resolveNtnEnvBaseUrl(env) ?? configBaseUrl`. This is the
 *      URL Lore's verifies will use.
 *   2. **Compute ntn login's native target** via
 *      `resolveLoginTargetBaseUrl(env)`. This is what ntn login
 *      itself would read from process.env.
 *   3. **If migrate has no target intent, no override needed.**
 *      Both ntn login and migrate's verifies default to prod.
 *      Consistent.
 *   4. **If migrate's target matches ntn login's native target, no
 *      override needed.** ntn login already inherits the var via
 *      process.env (e.g., the operator set `NOTION_BASE_URL` or
 *      `NOTION_ENV` directly).
 *   5. **Otherwise, forward `NOTION_BASE_URL=<migrateTarget>`.**
 *      Translates Lore's intent (LORE_NOTION_BASE_URL,
 *      NOTION_API_BASE_URL, config auth.baseUrl) into the env var
 *      ntn login natively respects.
 *
 * Returns `undefined` when no override is needed; `{ NOTION_BASE_URL: ... }`
 * when migrate's intended target needs to be translated for the spawn.
 */
export function computeNtnLoginEnvOverride(
  configBaseUrl: string | undefined,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv | undefined {
  const migrateTarget = resolveNtnEnvBaseUrl(env) ?? configBaseUrl
  if (!migrateTarget) return undefined
  const loginNativeTarget = resolveLoginTargetBaseUrl(env)
  if (migrateTarget === loginNativeTarget) return undefined
  return { NOTION_BASE_URL: migrateTarget }
}

/**
 * Operator-advice category for a `VaultAccessResult` failure.
 *
 * - `permission` — the page exists but the token can't read it (404
 *   under the current 3-arm shape on `main`). Routes to the
 *   integration-sharing / wrong-workspace / personal-permissions
 *   diagnostic copy.
 * - `auth` — the token itself is invalid or expired (401 / 403).
 *   Routes to a re-auth recommendation. Surfaced by PR #178's 5-arm
 *   refinement of `VaultAccessResult`; dead code under the current
 *   3-arm shape, activates the moment #178 lands.
 * - `throttle` — the request was rate-limited (429). Routes to a
 *   back-off recommendation. Same forward-compat posture as `auth`.
 * - `transient` — 5xx, DNS, proxy, or any other not-explicitly-
 *   classified failure. Routes to the retry-with-status.notion.so
 *   advice. Catch-all so a future kind value lands somewhere
 *   harmless rather than silently misrouting.
 */
type VaultErrorClass = "permission" | "auth" | "throttle" | "transient"

/**
 * Classify a `VaultAccessResult` failure into one of four operator-
 * advice categories. Each abort site (Step 1 legacy, Step 4 ntn,
 * post-Step-4 NOTION_API_TOKEN guard) routes the four classes to
 * site-specific copy.
 *
 * **Takes `kind: string` rather than the typed discriminator** so the
 * helper is forward-compatible with PR #178's 5-arm shape (`ok` /
 * `not-found` / `unauthorized` / `rate-limited` / `unknown-error`).
 * Under the current 3-arm shape on `main` only `permission` and
 * `transient` ever route through; the `auth` and `throttle` branches
 * activate the moment #178 lands. Doing the forward-compat now means
 * the #178 rebase touches zero migrate sites.
 *
 * The fall-through to `transient` is intentional: any future kind
 * we haven't yet routed lands on the safest non-misleading copy
 * (retry advice) rather than wrong remediation.
 */
export function classifyVaultError(kind: string): VaultErrorClass {
  if (kind === "not-found") return "permission"
  if (kind === "unauthorized") return "auth"
  if (kind === "rate-limited") return "throttle"
  return "transient"
}

/**
 * Build a Notion client from a token + base URL. Defaulted to
 * `createLimitedClient(createClient(...))` — wrapped in a factory so
 * tests can inject a fake without touching `@notionhq/client`.
 */
export type NotionClientFactory = (token: string, baseUrl?: string) => Client

export interface MigrateDeps {
  cwd: () => string
  env: () => NodeJS.ProcessEnv
  log: (line: string) => void
  error: (line: string) => void
  findConfigFile: typeof findConfigFile
  loadConfig: typeof loadConfig
  makeClient: NotionClientFactory
  verifyVaultAccess: (client: Client, pageId: string) => Promise<VaultAccessResult>
  loadNtnToken: typeof loadNtnToken
  isNtnInstalled: () => boolean
  installNtn: () => Promise<NtnInstallResult>
  /**
   * Optional `envOverride` lets the caller direct ntn login at a
   * specific Notion environment when the config's `auth.baseUrl` is
   * set but no env var directs ntn. The production wiring temporarily
   * mutates `process.env` for the spawn (since the underlying
   * `runNtnLogin` reads `process.env` directly) and restores on
   * completion. Tests inject a spy that captures the argument
   * directly without process-env mutation.
   */
  runNtnLogin: (envOverride?: NodeJS.ProcessEnv) => Promise<NtnLoginResult>
  confirmPrompt: (message: string, defaultYes?: boolean) => Promise<boolean>
  findShellRc: ShellRcFinder
}

/**
 * Production wiring of `MigrateDeps`. Threads the live helpers from
 * `auth/ntn.ts`, `auth/oauth.ts`, `config.ts`, and `notion/client.ts`
 * into the orchestrator. Tests replace this with `vi.fn()`-shaped
 * stubs.
 */
export function productionMigrateDeps(): MigrateDeps {
  // `homedir()` resolves once at factory build; the closure below
  // reuses it for every `findShellRc` call. One syscall instead of N.
  const home = homedir()
  return {
    cwd: () => process.cwd(),
    env: () => process.env,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    findConfigFile,
    loadConfig,
    makeClient: (token, baseUrl) => createLimitedClient(createClient(token, baseUrl)),
    verifyVaultAccess,
    loadNtnToken,
    isNtnInstalled,
    installNtn,
    // Wrap the underlying ntn login spawn so a caller-supplied
    // `envOverride` lands in `process.env` for the duration of the
    // spawn. `runNtnLogin` (`src/auth/ntn.ts`) reads `process.env`
    // directly via its `...process.env` spread; without this wrapper
    // the override would have no effect. Restored in `finally` so an
    // overridden var doesn't leak past the spawn.
    runNtnLogin: async (envOverride) => {
      if (!envOverride) return runNtnLogin()
      const restore: Array<[string, string | undefined]> = []
      for (const [key, value] of Object.entries(envOverride)) {
        if (typeof value !== "string") continue
        restore.push([key, process.env[key]])
        process.env[key] = value
      }
      try {
        return await runNtnLogin()
      } finally {
        for (const [key, prior] of restore) {
          if (prior === undefined) delete process.env[key]
          else process.env[key] = prior
        }
      }
    },
    confirmPrompt,
    findShellRc: () => findShellRcReferencingLoreToken(home),
  }
}

/**
 * Walk the candidate-shell-rc list looking for a `LORE_NOTION_TOKEN`
 * reference. Order matches the priority operators on macOS / Linux
 * actually use: zsh first (Notion-internal default), then bash, then
 * the POSIX fallback, then fish.
 *
 * Public so tests can construct a custom `homedir`-rooted scratch and
 * verify each branch independently.
 */
export async function findShellRcReferencingLoreToken(
  home: string,
): Promise<string | null> {
  const candidates = [
    join(home, ".zshrc"),
    join(home, ".bashrc"),
    join(home, ".bash_profile"),
    join(home, ".profile"),
    join(home, ".config", "fish", "config.fish"),
  ]
  for (const path of candidates) {
    try {
      const contents = await readFile(path, "utf-8")
      if (contents.includes("LORE_NOTION_TOKEN")) return path
    } catch {
      // file doesn't exist OR is unreadable — try the next.
    }
  }
  return null
}

/**
 * Orchestrate the four-step migrate flow. Returns `{ exitCode }`;
 * commander dispatches that onto `process.exit` in the live path.
 *
 * Step 1: verify the legacy token reaches the configured vault.
 * Step 2: ensure ntn is installed (offer auto-install on miss).
 * Step 3: shell out to `ntn login` interactively.
 * Step 4: re-resolve auth via the ntn path and verify the new token
 *         reaches the same vault.
 *
 * On any non-success outcome the operator's environment / config is
 * unchanged and the failure message points at the remediation path.
 */
export async function runMigrate(
  opts: MigrateOptions,
  deps: MigrateDeps,
): Promise<MigrateResult> {
  const cwd = deps.cwd()
  const found = await deps.findConfigFile(cwd)

  if (!found) {
    deps.error("No .lore.yaml found. `lore auth --migrate` requires a vault context.")
    deps.error("Run from inside a Lore-managed project directory.")
    return { exitCode: 1 }
  }

  const config = await deps.loadConfig(found.path)

  // 1. Detect the legacy source (env or config). At least one must be set.
  const env = deps.env()
  const envToken = env["LORE_NOTION_TOKEN"]
  const configToken = config.auth?.token

  if (!envToken && !configToken) {
    deps.log("Nothing to migrate.")
    deps.log("")
    deps.log("Lore detected no LORE_NOTION_TOKEN env var and no auth.token in")
    deps.log(`${found.path}.`)
    deps.log("")
    deps.log("If you're already on ntn-first auth, run `lore auth --status` to verify.")
    deps.log("If you want to set up ntn-first auth fresh: run `lore auth --login`.")
    deps.log("(Auto-installs ntn if missing, runs `ntn login` with the right env.)")
    return { exitCode: 0 }
  }

  const legacyToken = envToken ?? configToken!
  const legacySource: "env" | "config" = envToken ? "env" : "config"

  deps.log("Lore migration: LORE_NOTION_TOKEN → ntn-first auth")
  deps.log("")

  // Step 1 — verify the legacy token reaches the vault.
  deps.log("Step 1/4 — Verify legacy token reaches the configured vault...")
  const legacyClient = deps.makeClient(legacyToken, config.auth?.baseUrl)
  const legacyResult = await deps.verifyVaultAccess(legacyClient, config.vault.pageId)
  if (legacyResult.kind !== "ok") {
    const sourceLabel =
      legacySource === "env" ? "LORE_NOTION_TOKEN" : "auth.token"
    deps.error(
      `  ✗ Legacy ${sourceLabel} cannot reach ${config.vault.pageId} (${legacyResult.kind}).`,
    )
    deps.error("")
    deps.error("  Migration aborted — fix the legacy token first.")
    const cls = classifyVaultError(legacyResult.kind)
    if (cls === "permission") {
      deps.error("  Most likely cause: the integration backing the legacy token")
      deps.error("  doesn't have the vault page shared with it. Check Notion's UI")
      deps.error(`  on ${config.vault.pageId} → Add connections.`)
      deps.error("  (This is the integration-sharing model the legacy")
      deps.error("   shared-token deployment uses. ntn-first auth, by contrast,")
      deps.error("   inherits your personal Notion permissions and doesn't need")
      deps.error("   this step.)")
    } else if (cls === "auth") {
      // 401 / 403 — legacy token is invalid or expired. Two paths
      // forward: rotate the legacy token, OR skip the migration
      // entirely and run `lore auth --login` to set up ntn-first
      // auth fresh (which doesn't need the legacy token at all).
      deps.error(`  The legacy ${sourceLabel} is invalid or expired (401 / 403).`)
      deps.error("  Either rotate the legacy token, OR run `lore auth --login` to")
      deps.error("  set up ntn-first auth without going through migration.")
    } else if (cls === "throttle") {
      // 429 — back off rather than retry instantly.
      deps.error("  Notion rate-limited the request (429). Wait a moment, then")
      deps.error("  re-run `lore auth --migrate`.")
    } else {
      // transient — 5xx, network outage, proxy failure, etc. The
      // "share with integration" advice is wrong here; the integration
      // may be perfectly fine. Recommend retry + status check.
      deps.error("  Notion returned an unexpected error (transient 5xx, network,")
      deps.error("  or proxy outage). Retry in a moment, or check status.notion.so.")
      deps.error("  Re-run `lore auth --migrate` once the underlying issue clears.")
    }
    return { exitCode: 1 }
  }
  deps.log(
    `  ✓ Legacy token reaches: ${legacyResult.pageTitle ?? config.vault.pageId}`,
  )
  deps.log("")

  // Step 2 — check ntn install state; offer auto-install if missing.
  deps.log("Step 2/4 — Check ntn is installed...")
  if (!deps.isNtnInstalled()) {
    deps.log("  ✗ `ntn` is not installed.")
    deps.log("")
    deps.log("  Lore can install it via the canonical command:")
    deps.log(`    ${NTN_INSTALL_COMMAND}`)
    deps.log("")
    const ok =
      opts.yes === true || (await deps.confirmPrompt("  Install ntn now?"))
    if (!ok) {
      deps.error("  Skipping. Install ntn manually, then re-run `lore auth --migrate`.")
      return { exitCode: 1 }
    }
    const installResult = await deps.installNtn()
    if (installResult.kind !== "success") {
      deps.error("  ntn install failed.")
      deps.error("  Check your network and shell, then re-run `lore auth --migrate`.")
      return { exitCode: 1 }
    }
    deps.log("  ✓ ntn installed.")
  } else {
    deps.log("  ✓ ntn is installed")
  }
  // Note: no NOTION_KEYRING=0 check. `runNtnLogin()` (#02) sets it in
  // the spawn env so the operator doesn't need it in their shell rc.
  deps.log("")

  // Step 3 — shell out to ntn login (interactive).
  //
  // `runNtnLogin` (`src/auth/ntn.ts`) inherits the full `process.env`
  // (plus `NOTION_KEYRING=0`), so ntn's native dev/staging controls
  // (`NOTION_ENV`, `NOTION_BASE_URL` per `ntn login --help`) flow
  // through automatically. An operator running migration in a dev
  // environment with `NOTION_ENV=dev` set in their shell gets a
  // dev-environment ntn token.
  //
  // `computeNtnLoginEnvOverride` closes the config-driven dev gap:
  // when `.lore.yaml` carries `auth.baseUrl: <dev URL>` but NO env
  // var directs ntn, the override forwards `NOTION_BASE_URL` into
  // the spawn so ntn login targets the same host Step 1's legacy
  // preflight verified. Without this, Step 1 verifies dev and Step 3
  // silently logs in to prod — the round-5 finding's headline
  // scenario.
  const loginEnvOverride = computeNtnLoginEnvOverride(config.auth?.baseUrl, env)
  // **Capture the effective Step 3 target URL BEFORE running Step 3.**
  // The override mutates `process.env` only for the duration of the
  // ntn login spawn (production wiring restores via try/finally), so
  // by Step 4 the env has been restored. Without capturing here,
  // Step 4's `resolveNtnEnvBaseUrl(env)` re-reads the un-overridden
  // env and falls back to prod — exactly the silent-host-drift the
  // round-5 reviewer flagged. Capturing once at Step 3-prep time
  // makes Step 3 and Step 4 share the same target by construction,
  // regardless of whether ntn persists the env to its config.json.
  const step3EffectiveBaseUrl =
    loginEnvOverride?.["NOTION_BASE_URL"] ?? resolveNtnEnvBaseUrl(env)
  deps.log("Step 3/4 — Running `ntn login`...")
  deps.log("")
  if (loginEnvOverride) {
    // Surface the override so the operator knows which environment
    // they're being directed at. Concrete copy beats a silent env
    // mutation — if the operator wanted prod they can interrupt and
    // unset `auth.baseUrl` in their config first.
    const envSummary = Object.entries(loginEnvOverride)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")
    deps.log(
      `  Forwarding from ${found.path}: ${envSummary}`,
    )
    deps.log("  (so ntn login targets the same host Step 1 just verified)")
    deps.log("")
  }
  deps.log("  ntn will prompt you to pick a workspace and complete the browser")
  deps.log("  flow. Confirm the workspace selector matches the workspace")
  deps.log(`  containing ${config.vault.pageId}.`)
  deps.log("  (If unsure, check the page in Notion's UI — the workspace name")
  deps.log("   appears in the top-left.)")
  deps.log("")

  const loginResult = await deps.runNtnLogin(loginEnvOverride)
  if (loginResult.kind !== "success") {
    deps.error("")
    deps.error("ntn login did not complete successfully.")
    if (loginResult.kind === "exit-non-zero") {
      deps.error(`  ntn exited with code ${loginResult.code}`)
    } else if (loginResult.kind === "spawn-error") {
      deps.error("  ntn could not be spawned — is it on PATH?")
      deps.error("  (Run `lore auth --login` to use Lore's auto-install path.)")
    }
    deps.error("")
    deps.error(
      "LORE_NOTION_TOKEN is unchanged. Re-run `lore auth --migrate` to retry.",
    )
    return { exitCode: 1 }
  }
  deps.log("")

  // Step 4 — verify the new ntn-issued token reaches the same vault.
  deps.log("Step 4/4 — Verify ntn-issued token reaches the same vault...")
  // `quiet: true` so loadNtnToken's own multi-line stderr hint
  // (multi-workspace ambiguity, requested-workspace-not-present)
  // doesn't fight the migrate flow's user-visible failure copy below.
  // Same posture `resolveAuth` uses (`src/config.ts:266-269`); the
  // migrate flow owns the operator-facing error block.
  const ntnRecord: NtnTokenRecord | null = await deps.loadNtnToken({
    workspaceId: env["NOTION_WORKSPACE_ID"] ?? config.auth?.workspaceId,
    quiet: true,
  })
  if (!ntnRecord) {
    deps.error("  ✗ Lore could not resolve a ntn token from auth.json.")
    deps.error("")
    deps.error("  Check `lore auth --status` for diagnostic info.")
    deps.error(
      "  LORE_NOTION_TOKEN is unchanged — your existing setup still works.",
    )
    return { exitCode: 1 }
  }
  // `ntnRecord.baseUrl` is what `loadNtnToken` resolved (LORE_NOTION_BASE_URL
  // env or ntn's own config.json env=dev/stg). Fall back to
  // `step3EffectiveBaseUrl` (captured pre-spawn) so Step 3 and Step 4
  // share the same effective target — even when ntn doesn't persist
  // the dev base URL to its config.json. Without that fallback, the
  // config-only-dev path (`auth.baseUrl: <dev URL>` in YAML, no env
  // vars set) would have Step 3 log in to dev (via the override) but
  // Step 4 verify against prod (because `loadNtnToken` returns
  // baseUrl=undefined and the override has been restored from
  // process.env).
  const ntnClient = deps.makeClient(
    ntnRecord.token,
    ntnRecord.baseUrl ?? step3EffectiveBaseUrl,
  )
  const ntnResult = await deps.verifyVaultAccess(ntnClient, config.vault.pageId)
  if (ntnResult.kind !== "ok") {
    deps.error(
      `  ✗ ntn-issued token cannot reach ${config.vault.pageId} (${ntnResult.kind}).`,
    )
    deps.error("")
    const cls = classifyVaultError(ntnResult.kind)
    if (cls === "permission") {
      deps.error("  Most likely causes:")
      deps.error(
        "    1. You authenticated against the wrong workspace during ntn login.",
      )
      deps.error(
        `       Run \`ntn login\` again, picking the workspace containing ${config.vault.pageId}.`,
      )
      deps.error("    2. The vault page isn't shared with you (your Notion identity)")
      deps.error("       in this workspace. ntn-first auth inherits your personal")
      deps.error("       permissions; if you can't open the page in Notion's UI,")
      deps.error("       the token can't read it either. Ask whoever owns the")
      deps.error("       vault to share it with you, or check your workspace")
      deps.error("       membership.")
    } else if (cls === "auth") {
      // 401 / 403 — rare immediately after `ntn login`. Most plausible
      // cause: the operator picked a workspace during login that
      // doesn't authorize the token Lore is trying to use, OR ntn
      // wrote a malformed entry to auth.json. `ntn login` again is
      // the right next step.
      deps.error("  The ntn-issued token is invalid or expired (401 / 403). This is")
      deps.error("  rare immediately after `ntn login` — the most plausible cause is")
      deps.error(`  picking the wrong workspace during login. Run \`ntn login\` again,`)
      deps.error(`  picking the workspace containing ${config.vault.pageId}.`)
    } else if (cls === "throttle") {
      deps.error("  Notion rate-limited the request (429). Wait a moment, then")
      deps.error("  re-run `lore auth --migrate`.")
    } else {
      // transient — same retry advice as Step 1's parallel branch.
      deps.error("  Notion returned an unexpected error (transient 5xx, network,")
      deps.error("  or proxy outage). Retry in a moment, or check status.notion.so.")
      deps.error("  Re-run `lore auth --migrate` once the underlying issue clears.")
    }
    deps.error("")
    deps.error(
      "  LORE_NOTION_TOKEN is unchanged — your existing setup still works.",
    )
    return { exitCode: 1 }
  }
  deps.log(
    `  ✓ ntn-issued token reaches: ${ntnResult.pageTitle ?? config.vault.pageId}`,
  )
  deps.log(`  ✓ Workspace: ${ntnRecord.workspaceId}`)
  deps.log("")

  // Defensive: per #01's resolver chain, `NOTION_API_TOKEN` env
  // outranks ntn-resolved auth. If the operator has both set, the
  // next Lore process will use `NOTION_API_TOKEN`, not the ntn token
  // Step 4 just verified. Confirm `NOTION_API_TOKEN` also reaches
  // the vault — abort if it doesn't, since "migration succeeded but
  // next session breaks" would be the worst possible silent
  // failure. If both work, qualify the reassurance copy below so
  // the operator knows which token is actually active.
  const apiTokenEnv = env["NOTION_API_TOKEN"]
  let notionApiTokenActive = false
  if (apiTokenEnv) {
    deps.log("NOTION_API_TOKEN is set and ranks above ntn; verifying it reaches the vault...")
    // **Mirror `resolveAuth`'s `env-notion-api-token` source exactly.**
    // Per `src/config.ts:246-253`, that source uses `LORE_NOTION_BASE_URL`
    // ONLY — it does NOT honor `NOTION_BASE_URL`, `NOTION_API_BASE_URL`,
    // or `NOTION_ENV`. So the next Lore process will verify against
    // `LORE_NOTION_BASE_URL` (or undefined → SDK default = prod) when
    // it resolves NOTION_API_TOKEN.
    //
    // Anything broader here creates a false positive: an operator with
    // only `NOTION_API_BASE_URL=<dev URL>` set would have this guard
    // verify against dev (because `resolveNtnEnvBaseUrl` honors it)
    // while the next process verifies against prod (because
    // `resolveAuth` doesn't). The guard's job is to verify the same
    // thing the next process will, so scope this to `LORE_NOTION_BASE_URL`
    // until #178's broader `resolveOperatorBaseUrl` lands and the
    // late-merger broadens both `resolveAuth` and this guard
    // together.
    const apiClient = deps.makeClient(apiTokenEnv, env["LORE_NOTION_BASE_URL"])
    const apiResult = await deps.verifyVaultAccess(apiClient, config.vault.pageId)
    if (apiResult.kind !== "ok") {
      deps.error(
        `  ✗ NOTION_API_TOKEN cannot reach ${config.vault.pageId} (${apiResult.kind}).`,
      )
      deps.error("")
      deps.error("  Per the resolver chain, NOTION_API_TOKEN ranks above ntn — so the")
      deps.error("  next Lore process would use NOTION_API_TOKEN, even though the")
      deps.error("  ntn-issued token Step 4 just verified is fine.")
      deps.error("")
      const cls = classifyVaultError(apiResult.kind)
      if (cls === "permission") {
        // Misconfigured api token — wrong workspace, wrong integration,
        // or the integration doesn't have the page shared. Operator's
        // remediation is to either fix the token or fall through to ntn.
        deps.error("  To resolve, either:")
        deps.error("    - unset NOTION_API_TOKEN to fall through to your ntn-issued token,")
        deps.error("      OR")
        deps.error("    - update NOTION_API_TOKEN to a value that reaches the vault.")
        deps.error("")
        deps.error("  Then re-run `lore auth --migrate` to confirm.")
      } else if (cls === "auth") {
        // 401 / 403 — NOTION_API_TOKEN is invalid or expired. Same two
        // remediations as not-found; the underlying problem is
        // structurally the same ("api token doesn't authorize this
        // vault read"), just signalled by Notion via a different status.
        deps.error("  NOTION_API_TOKEN is invalid or expired (401 / 403). To resolve:")
        deps.error("    - unset NOTION_API_TOKEN to fall through to your ntn-issued token,")
        deps.error("      OR")
        deps.error("    - rotate NOTION_API_TOKEN to a working value.")
        deps.error("")
        deps.error("  Then re-run `lore auth --migrate` to confirm.")
      } else if (cls === "throttle") {
        deps.error("  Notion rate-limited the request (429) on the NOTION_API_TOKEN")
        deps.error("  verify. Wait a moment, then re-run `lore auth --migrate`.")
      } else {
        // transient — same retry advice as Steps 1 / 4. The api
        // token may be perfectly fine; the operator just needs to
        // wait out the underlying outage.
        deps.error("  Notion returned an unexpected error (transient 5xx, network,")
        deps.error("  or proxy outage). Retry in a moment, or check status.notion.so.")
        deps.error("  Re-run `lore auth --migrate` once the underlying issue clears.")
      }
      return { exitCode: 1 }
    }
    notionApiTokenActive = true
    deps.log(
      `  ✓ NOTION_API_TOKEN reaches: ${apiResult.pageTitle ?? config.vault.pageId}`,
    )
    deps.log("")
  }

  // Print unset instructions, source-aware. The dual-source case
  // (operator has BOTH `LORE_NOTION_TOKEN` env AND `auth.token` in
  // config) emits both housekeeping pointers; the resolver-priority
  // case (`NOTION_API_TOKEN` is the actual active source) qualifies
  // the reassurance copy so the operator knows ntn isn't winning.
  const alsoSetSource: "config" | undefined =
    legacySource === "env" && configToken ? "config" : undefined
  for (const line of formatUnsetInstructions({
    legacySource,
    configPath: found.path,
    alsoSetSource,
    notionApiTokenActive,
  })) {
    deps.log(line)
  }

  // Shell-rc-location helper only for the env-source branch; an
  // operator using `auth.token` already has the file path printed.
  if (legacySource === "env") {
    const matched = await deps.findShellRc()
    if (matched) {
      deps.log("")
      deps.log(
        `(Found LORE_NOTION_TOKEN reference in ${matched} — that's where to remove it.)`,
      )
    }
  }

  return { exitCode: 0 }
}

/**
 * Options that vary the unset-instructions block.
 *
 * - `legacySource` — primary source detected at Step 1. Determines
 *   the main copy (shell-rc edit for env, YAML field-removal for
 *   config).
 * - `configPath` — resolved `.lore.yaml` path. Surfaced verbatim in
 *   the config-source branch so the operator knows which file to
 *   edit.
 * - `alsoSetSource` — when set, BOTH legacy sources are present in
 *   the operator's environment. The primary block emits as normal;
 *   an additional housekeeping block points at the secondary source
 *   so the operator gets both pointers in the one-shot migrate run.
 *   In practice today the only value passed is `"config"`, since the
 *   resolver picks env over config when both are set, but the param
 *   is symmetric in case future resolver order changes.
 * - `notionApiTokenActive` — when true, the operator has
 *   `NOTION_API_TOKEN` set AND it reaches the vault, so it (not
 *   ntn) is the active source. The "your ntn token is already
 *   active" reassurance is replaced with honest copy naming
 *   `NOTION_API_TOKEN` as the active token.
 */
export interface FormatUnsetInstructionsOptions {
  legacySource: "env" | "config"
  configPath: string
  alsoSetSource?: "env" | "config"
  notionApiTokenActive?: boolean
}

/**
 * Build the unset-instructions block. Pure: takes a typed options
 * bag and returns the lines to emit. Tested in isolation so copy
 * regressions surface here rather than buried inside an integration
 * assertion.
 *
 * The env / config branches differ in mechanics (shell concern vs
 * file concern) so the main copy is source-shaped. The reassurance
 * footer is honest about which token is actually active — under the
 * default it's ntn (rank 2 in the resolver chain), but
 * `NOTION_API_TOKEN` (rank 1) overrides ntn whenever the operator has
 * the env var set, so the copy switches accordingly.
 */
export function formatUnsetInstructions(
  opts: FormatUnsetInstructionsOptions,
): string[] {
  const { legacySource, configPath, alsoSetSource, notionApiTokenActive } = opts
  const out: string[] = []
  out.push("Migration verified!")
  out.push("")

  if (legacySource === "env") {
    out.push("To activate ntn-first auth, remove LORE_NOTION_TOKEN from your shell:")
    out.push("")
    out.push("  unset LORE_NOTION_TOKEN")
    out.push("")
    out.push(
      "Then remove the export line from your shell rc (~/.zshrc, ~/.bashrc,",
    )
    out.push(
      "or wherever it's set), source the rc (or open a new terminal) to pick",
    )
    out.push("up the change.")
  } else {
    out.push("To activate ntn-first auth, remove the auth.token field from")
    out.push(`${configPath}:`)
    out.push("")
    out.push("  # Before:")
    out.push("  auth:")
    out.push("    token: <secret>")
    out.push("")
    out.push("  # After:")
    out.push("  # (remove the auth: section entirely if no other auth fields)")
    out.push("")
    out.push("Then commit the change.")
  }

  // Dual-source housekeeping: when both legacy sources are set,
  // append the secondary pointer so the migrate's one-shot output
  // covers both.
  if (alsoSetSource === "config") {
    out.push("")
    out.push(`Also: \`auth.token\` is set in ${configPath} and will continue to`)
    out.push("emit a soft-deprecation warning until removed. Once the env unset")
    out.push("is done, also delete the `auth.token` line:")
    out.push("")
    out.push("  # Before:")
    out.push("  auth:")
    out.push("    token: <secret>")
    out.push("")
    out.push("  # After:")
    out.push("  # (remove the auth: section entirely if no other auth fields)")
    out.push("")
    out.push("Then commit the change.")
  } else if (alsoSetSource === "env") {
    out.push("")
    out.push("Also: `LORE_NOTION_TOKEN` is set in your shell and will continue")
    out.push("to emit a soft-deprecation warning until removed. After committing")
    out.push("the config edit:")
    out.push("")
    out.push("  unset LORE_NOTION_TOKEN")
    out.push("")
    out.push(
      "Then remove the export line from your shell rc (~/.zshrc, ~/.bashrc,",
    )
    out.push(
      "or wherever it's set), source the rc (or open a new terminal) to pick",
    )
    out.push("up the change.")
  }

  out.push("")

  // Reassurance footer — honest about which token is active.
  if (notionApiTokenActive) {
    out.push(
      "(Per #01's resolver priority — NOTION_API_TOKEN > ntn > LORE_NOTION_TOKEN",
    )
    out.push(
      " > auth.token — NOTION_API_TOKEN is in your environment and outranks ntn,",
    )
    out.push(
      " so NOTION_API_TOKEN is the active token right now, not the ntn-issued",
    )
    out.push(
      " one Step 4 verified. Both reach the vault, so this is fine — but if you",
    )
    out.push(
      " want ntn to be active instead, also unset NOTION_API_TOKEN. The legacy",
    )
    out.push(" unset above is housekeeping either way.)")
    return out
  }

  if (legacySource === "env") {
    out.push(
      "(Per #01's resolver priority — NOTION_API_TOKEN > ntn > LORE_NOTION_TOKEN >",
    )
    out.push(
      " auth.token — your ntn-issued token is ALREADY active, since ntn ranks",
    )
    out.push(
      " above LORE_NOTION_TOKEN. The unset is housekeeping: it stops the",
    )
    out.push(" deprecation warning and prevents shadowed-token confusion in")
    out.push(" `lore auth --status` output. The new token is in use right now.)")
    return out
  }

  out.push(
    "(Per #01's resolver priority — NOTION_API_TOKEN > ntn > LORE_NOTION_TOKEN",
  )
  out.push(
    " > auth.token — your ntn-issued token is ALREADY active, since ntn ranks",
  )
  out.push(" above auth.token. Removing the field is housekeeping: it deletes a")
  out.push(
    " deprecated fallback, stops the deprecation warning, and avoids future",
  )
  out.push(
    " confusion when reading the config. The new token is in use right now.)",
  )
  return out
}
