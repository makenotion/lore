/**
 * `lore auth` — authentication subcommands for the 0.10.0 ntn-first model.
 *
 * Surfaces:
 *   --status   Show authentication status (default; runs vault preflight)
 *   --login    Auto-install ntn (if missing), shell out to `ntn login`,
 *              and run a post-login `verifyVaultAccess` preflight.
 *   --whoami   Resolve the active token and print the bot identity from
 *              `users.me` on a single line (script-friendly).
 *   --logout   Print source-specific logout instructions (informational
 *              only — Lore doesn't manage ntn's storage; for legacy paths
 *              it points at the unset / config-edit step).
 *   --migrate  Walk an operator with LORE_NOTION_TOKEN (or auth.token in
 *              config) through migrating to ntn-first auth.
 */

import { Command } from "commander"
import { readFile } from "node:fs/promises"
import { createInterface } from "node:readline/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Client } from "@notionhq/client"

import {
  findConfigFile,
  loadConfig,
  resolveAuth,
  type ResolvedAuth,
} from "../../config.js"
import {
  checkNtnVersion,
  getNtnVersion,
  installNtn,
  isNtnInstalled,
  listNtnWorkspaces,
  loadNtnToken,
  MIN_NTN_VERSION,
  type NtnEnv,
  NTN_INSTALL_COMMAND,
  parseNtnEnv,
  resetNtnProbeCache,
  runNtnLogin,
  type NtnInstallResult,
  type NtnLoginResult,
  type NtnTokenRecord,
} from "../../auth/ntn.js"
import {
  verifyVaultAccess,
  type VaultAccessResult,
} from "../../auth/oauth.js"
import { createClient } from "../../notion/client.js"
import { createLimitedClient } from "../../notion/rate-limit.js"

interface AuthOpts {
  status?: boolean
  login?: boolean
  logout?: boolean
  whoami?: boolean
  migrate?: boolean
  yes?: boolean
}

export type AuthAction = "login" | "logout" | "whoami" | "status" | "migrate"

/**
 * Documented precedence for multi-flag invocations:
 *   --migrate > --login > --logout > --whoami > --status
 *
 * Defaults to `--status` when no flag is set.
 *
 * Returns the picked action plus a list of flags that lost the
 * tie-break, so the caller can emit a stderr warning naming the flags
 * that were ignored. Pure — separated from the I/O so tests can pin the
 * ordering without driving the CLI surface.
 */
export function pickAuthAction(opts: AuthOpts): {
  action: AuthAction
  ignored: string[]
} {
  const ladder: Array<{ name: string; on: boolean | undefined; action: AuthAction }> = [
    { name: "--migrate", on: opts.migrate, action: "migrate" },
    { name: "--login", on: opts.login, action: "login" },
    { name: "--logout", on: opts.logout, action: "logout" },
    { name: "--whoami", on: opts.whoami, action: "whoami" },
    { name: "--status", on: opts.status, action: "status" },
  ]
  const enabled = ladder.filter((entry) => entry.on === true)
  if (enabled.length === 0) return { action: "status", ignored: [] }
  return {
    action: enabled[0]!.action,
    ignored: enabled.slice(1).map((entry) => entry.name),
  }
}

export const authCommand = new Command("auth")
  .description("Authenticate with Notion and inspect auth state")
  .option("--status", "Show authentication status (default)")
  .option(
    "--login",
    "Run `ntn login` (auto-installs ntn if missing) + vault preflight",
  )
  .option("--whoami", "Print the authenticated identity (one line)")
  .option("--logout", "Show how to log out of the active auth source")
  .option(
    "--migrate",
    "Walk through migrating from LORE_NOTION_TOKEN (or auth.token in config) to ntn-first auth",
  )
  .option(
    "-y, --yes",
    'Auto-confirm prompts (e.g., "Install ntn? [Y/n]")',
  )
  .action(async (opts: AuthOpts) => {
    const { action, ignored } = pickAuthAction(opts)
    if (ignored.length > 0) {
      console.warn(
        `Warning: multiple auth flags supplied; running --${action} and ignoring ${ignored.join(", ")}.`,
      )
    }
    switch (action) {
      case "migrate": {
        const result = await runMigrate({ yes: opts.yes }, productionMigrateDeps())
        if (result.exitCode !== 0) process.exit(result.exitCode)
        return
      }
      case "login":
        await runLogin({ yes: opts.yes ?? false })
        return
      case "logout":
        await runLogout()
        return
      case "whoami":
        await runWhoami()
        return
      case "status":
        await runStatus()
        return
    }
  })

// ---------------------------------------------------------------------------
// --status
// ---------------------------------------------------------------------------

/**
 * Run the `--status` body. Routes on whether `.lore.yaml` is reachable
 * upward from cwd:
 *
 * - **No vault context**: print general auth state. We still attempt
 *   `resolveAuth(undefined, cwd)` so an operator running the command
 *   outside any Lore project sees their canonical / ntn-resolved token
 *   (if any). Surfaces `listNtnWorkspaces()` so the operator knows
 *   which workspaces ntn carries before they navigate into a project.
 *
 * - **With vault context**: load config, resolve auth, run a
 *   `verifyVaultAccess` preflight against the configured vault page.
 *   The preflight is the single most-actionable diagnostic — it
 *   catches "valid token, wrong workspace" and "valid token, page
 *   not shared" — and operators run `--status` rarely enough that
 *   the one-call cost is acceptable. A `--no-verify` opt-out is a
 *   plausible follow-up if telemetry surfaces friction.
 */
export async function runStatus(): Promise<void> {
  const cwd = process.cwd()
  const found = await findConfigFile(cwd)

  if (!found) {
    console.log("Lore auth status (no vault context)")
    console.log("")
    let globalAuth: ResolvedAuth | undefined
    let globalErr: unknown
    try {
      // Pass `homedir()` rather than `cwd` as the deprecation-marker
      // keying input — without a vault context every cwd would mint
      // its own marker, so an operator with `LORE_NOTION_TOKEN` set
      // running from `~/proj-a` and then `~/proj-b` would re-fire
      // the warning. `homedir()` collapses all no-vault calls onto a
      // single per-operator marker. `LORE_SUPPRESS_DEPRECATIONS=1`
      // remains the silence escape.
      globalAuth = await resolveAuth(undefined, homedir())
    } catch (err) {
      globalErr = err
    }
    printAuthSourceLines(globalAuth)
    if (!globalAuth) {
      // Carry resolveAuth's diagnostic forward (multi-workspace
      // ambiguity hint, selector-not-found, etc.) — without it the
      // no-vault-context surface drops the most useful piece of
      // information the resolver produced.
      if (globalErr instanceof Error && globalErr.message.length > 0) {
        console.log("")
        for (const line of globalErr.message.split("\n")) {
          console.log(`  ${line}`)
        }
      }
      if (!isNtnInstalled()) {
        console.log("")
        console.log("  Note: `ntn` does not appear to be installed.")
        console.log(
          "  Install per the rollout runbook: docs/internal-rollout.md",
        )
      }
    }
    const workspaces = await listNtnWorkspaces()
    if (workspaces.length > 0) {
      console.log("")
      console.log(`ntn workspaces with tokens: ${workspaces.length}`)
      console.log(`  ${workspaces.join(", ")}`)
      console.log(
        "(Run `lore auth --status` from inside a Lore project to see vault-specific details.)",
      )
    }
    return
  }

  const config = await loadConfig(found.path)

  console.log(`Lore auth status for ${found.path}`)
  console.log("")

  let auth: ResolvedAuth | undefined
  let resolveError: unknown
  try {
    auth = await resolveAuth(config, found.root)
  } catch (err) {
    resolveError = err
  }

  if (!auth) {
    console.log("  Status: not authenticated")
    console.log("")
    // Surface resolveAuth's own diagnostic — it carries multi-workspace
    // ambiguity hints (workspace listing + selector recommendation) and
    // requested-workspace-not-found details that the operator needs to
    // self-diagnose. A bare "not authenticated" replacing it would
    // silently strand operators on the ntn ambiguity branches.
    if (resolveError instanceof Error && resolveError.message.length > 0) {
      for (const line of resolveError.message.split("\n")) {
        console.log(`  ${line}`)
      }
      console.log("")
    }
    console.log("  No token resolves from any source. Recommended:")
    console.log("    lore auth --login")
    console.log("  This auto-installs ntn (if missing), runs `ntn login`")
    console.log("  with NOTION_KEYRING=0 forced inside the spawn, and")
    console.log("  verifies vault access. No shell-rc edits required.")
    console.log("")
    console.log("  Legacy fallback (soft-deprecated):")
    console.log("    export LORE_NOTION_TOKEN=<your-integration-token>")

    if (!isNtnInstalled()) {
      console.log("")
      console.log("  Note: `ntn` does not appear to be installed.")
      console.log("  Install per the rollout runbook: docs/internal-rollout.md")
    }
    return
  }

  printAuthSourceLines(auth)
  // Source-specific note that needs the resolved config path. The
  // generic source lines live in `printAuthSourceLines`; the
  // file-path callout has to live here because the helper has no
  // access to the resolved path.
  if (auth.source === "config-auth-token") {
    console.log(`  (Edit ${found.path} to remove the auth.token field.)`)
  }

  console.log("")
  console.log(`  Vault page id:  ${config.vault.pageId}`)
  if (config.auth?.workspaceId) {
    console.log(`  Pinned workspace: ${config.auth.workspaceId}`)
  }
  // Surface the active baseUrl so operators on legacy sources see what
  // host their next preflight call will hit. A `.lore.yaml`-supplied
  // override can silently redirect a token to an arbitrary host on the
  // legacy paths (see `resolveAuth`'s security note); printing the
  // value here is one free defense-in-depth line.
  if (auth.baseUrl) {
    console.log(`  Notion base URL:  ${auth.baseUrl}`)
  }

  console.log("")
  console.log("  Verifying vault access...")
  const client = createLimitedClient(createClient(auth.token, auth.baseUrl))
  const result = await verifyVaultAccess(client, config.vault.pageId)
  if (result.kind === "ok") {
    console.log(
      `  ✓ Vault page accessible: ${result.pageTitle ?? config.vault.pageId}`,
    )
  } else if (result.kind === "not-found") {
    console.log("  ✗ Vault page NOT accessible")
    console.log(`    ${result.message}`)
  } else if (result.kind === "unauthorized") {
    // Token rejected (401 / 403). Distinct from `not-found` so the
    // remediation actually helps: the operator's next step is
    // re-auth, not workspace re-share.
    console.log("  ✗ Vault preflight: token rejected (unauthorized)")
    console.log(`    ${result.message}`)
    console.log("")
    console.log("  Recommended: run `lore auth --login` to issue a fresh token.")
  } else if (result.kind === "rate-limited") {
    // Transient throttling — bearer token is fine; the issue is
    // request-rate volume. Don't bounce the operator to re-auth.
    console.log("  ⏸ Vault preflight: rate-limited (429)")
    console.log(`    ${result.message}`)
  } else {
    console.log("  ? Vault preflight returned an unknown error (transient?)")
    // Surface the underlying error message — `unknown-error` carries an
    // `error: unknown` that operators debugging a 5xx need to see. Same
    // posture as `runLogin`'s post-login `not-found` branch which
    // already prints `result.message`.
    const detail =
      result.error instanceof Error ? result.error.message : String(result.error)
    if (detail) console.log(`    ${detail}`)
  }
}

/**
 * Render the source / status lines for an active or absent
 * `ResolvedAuth`. Pure-ish (writes to console.log) so tests can pin the
 * exact lines per source without driving the entire `runStatus` flow.
 *
 * Single-arg signature — the previous `configPath` parameter was used
 * by exactly one source (`config-auth-token`) to name the file the
 * operator edits; that copy moved into `runStatus`'s vault-context
 * branch where the path is already in scope.
 */
export function printAuthSourceLines(auth: ResolvedAuth | undefined): void {
  if (!auth) {
    console.log("  Status: not authenticated")
    return
  }

  switch (auth.source) {
    case "env-notion-api-token":
      console.log("  Source: NOTION_API_TOKEN (env)")
      console.log("  Status: ✓ active")
      break
    case "ntn-auth-json":
      console.log("  Source: ntn (auth.json)")
      if (auth.workspaceId) {
        console.log(`  Workspace: ${auth.workspaceId}`)
      }
      console.log("  Status: ✓ active")
      console.log("")
      console.log(
        "  Note: reading auth.json directly is a temporary coupling.",
      )
      console.log(
        "  When `ntn auth token` ships, this becomes a clean export.",
      )
      break
    case "env-lore-notion-token":
      console.log("  Source: LORE_NOTION_TOKEN (env, soft-deprecated)")
      console.log("  Status: ✓ active (legacy)")
      console.log("")
      console.log(
        "  Recommended: run `lore auth --migrate` to upgrade to ntn.",
      )
      break
    case "config-auth-token":
      console.log("  Source: auth.token in .lore.yaml (soft-deprecated)")
      console.log("  Status: ✓ active (legacy)")
      console.log("")
      console.log(
        "  Recommended: run `lore auth --migrate` to upgrade to ntn-issued auth",
      )
      console.log(
        "  (or `lore auth --login` if you'd rather skip the legacy-token preflight),",
      )
      console.log("  then remove auth.token from .lore.yaml.")
      break
  }

  // Surface accidentally-set LORE_NOTION_TOKEN. The most common operator
  // confusion: migrated to ntn, never unset the legacy env var. Listing
  // every shadow source (NOTION_API_TOKEN when ntn is active, etc.)
  // would clutter the output; only the dominant shadow gets a line.
  if (
    auth.source !== "env-lore-notion-token" &&
    process.env["LORE_NOTION_TOKEN"]
  ) {
    console.log("")
    console.log(
      "  Shadow: LORE_NOTION_TOKEN is set in env but not active for this vault.",
    )
    console.log(
      "  (Higher-priority source wins. Remove the env var when convenient.)",
    )
  }
}

// ---------------------------------------------------------------------------
// --login
// ---------------------------------------------------------------------------

/**
 * Run the `--login` body. The four-step chain:
 *
 *   1. ntn install (optional, gated on operator consent)
 *   2. version warning (non-blocking)
 *   3. `ntn login` shell-out (forces NOTION_KEYRING=0 in the spawn)
 *   4. `resolveAuth` re-resolution + `verifyVaultAccess` preflight
 *
 * Step 1 prompts for confirmation in interactive contexts; `--yes`
 * skips the prompt for non-interactive automation. A non-interactive
 * environment without `--yes` exits with a clear pointer at the flag.
 *
 * Step 4's preflight is the load-bearing UX: an operator who picked
 * the wrong workspace at the ntn login screen sees the error
 * immediately, rather than three commands later.
 */
export async function runLogin(opts: { yes: boolean }): Promise<void> {
  const cwd = process.cwd()
  const found = await findConfigFile(cwd)

  if (!found) {
    console.error(
      "No .lore.yaml found. `lore auth --login` requires a vault context.",
    )
    console.error("Run `lore init` first (or `cd` to a Lore-managed project).")
    process.exit(1)
    return
  }

  const config = await loadConfig(found.path)

  // Step 1 — ntn install (if missing). Order matters: the
  // non-interactive guard runs BEFORE the prompt copy is printed,
  // so a CI log doesn't show "Install ntn now? [Y/n]" followed by
  // an "I bailed because non-interactive" line — the operator sees
  // the abort message cleanly.
  if (!isNtnInstalled()) {
    if (!opts.yes && !process.stdin.isTTY) {
      console.error(
        "ntn is not installed and `lore auth --login` is running in a non-interactive context.",
      )
      console.error(
        "Pass --yes to consent to the canonical install non-interactively:",
      )
      console.error(`  ${NTN_INSTALL_COMMAND}`)
      process.exit(1)
      return
    }

    console.log("ntn is not installed.")
    console.log("")
    console.log("Lore can install it for you using the canonical path:")
    console.log(`  ${NTN_INSTALL_COMMAND}`)
    console.log("")

    const okToInstall = opts.yes || (await confirmPrompt("Install ntn now?"))
    if (!okToInstall) {
      console.error(
        "ntn is required for `lore auth --login`. Install manually:",
      )
      console.error(`  ${NTN_INSTALL_COMMAND}`)
      process.exit(1)
      return
    }

    const installResult = await installNtn()
    if (installResult.kind !== "success") {
      console.error("ntn install failed.")
      console.error(
        "Check your network and shell, then re-run `lore auth --login`.",
      )
      process.exit(1)
      return
    }
    console.log("✓ ntn installed.")
    console.log("")
  }

  // Step 2 — non-blocking version warning.
  if (checkNtnVersion() === "too-old") {
    const installed = getNtnVersion()
    console.log(
      `Note: your ntn version (${installed ?? "unknown"}) is below Lore's tested minimum (${MIN_NTN_VERSION}). ` +
        "Lore will proceed, but if you hit auth resolution issues, run `ntn update` and try again.",
    )
    console.log("")
  }

  // Step 3 — ntn login (NOTION_KEYRING=0 forced inside runNtnLogin's spawn).
  //
  // Environment selection precedence:
  //   1. `NOTION_ENV` env var (operator-set, wins).
  //   2. Inferred from `.lore.yaml`'s `auth.baseUrl` (Mail-style dev
  //      projects carry `auth.baseUrl: https://api-dev.notion.com`;
  //      threading that into `ntn login --env dev` keeps the
  //      Lore-managed login pointed at the same environment the
  //      operator's vault config already declares).
  //   3. Fall through to ntn's own default (typically prod from its
  //      `~/.config/notion/config.json`).
  //
  // The inferred form is the load-bearing piece: a dev-environment
  // operator without `NOTION_ENV=dev` in their shell would otherwise
  // run bare `ntn login` (prod) and then fail Step 4 preflight
  // against a dev vault — the failure would be visible but the cause
  // (mismatched env) would not. Inferring from `auth.baseUrl` closes
  // the loop.
  const shellNtnEnvRaw = process.env["NOTION_ENV"]
  const shellNtnEnv = parseNtnEnv(shellNtnEnvRaw) ?? undefined
  const inferredNtnEnv = inferNtnEnvFromBaseUrl(config.auth?.baseUrl)
  const ntnEnv: NtnEnv | undefined = shellNtnEnv ?? inferredNtnEnv
  if (!shellNtnEnv && inferredNtnEnv) {
    console.log(
      `(Inferring \`NOTION_ENV=${inferredNtnEnv}\` from auth.baseUrl in .lore.yaml.)`,
    )
  }
  console.log(
    ntnEnv
      ? `Running \`NOTION_ENV=${ntnEnv} ntn login\`...`
      : "Running `ntn login`...",
  )
  console.log("")
  const loginResult = await runNtnLogin(ntnEnv ? { env: ntnEnv } : {})
  if (loginResult.kind !== "success") {
    console.error("")
    console.error("ntn login did not complete successfully.")
    if (loginResult.kind === "exit-non-zero") {
      console.error(`  ntn exited with code ${loginResult.code}`)
      console.error("Re-run `lore auth --login` to retry.")
    } else {
      // spawn-error: the most-common cause is that the ntn binary
      // disappeared between the install probe and the login spawn
      // (uninstalled mid-flow, PATH munged by an interactive shell
      // change, etc.). Per the spec acceptance criterion this branch
      // is "handled differently from exit-non-zero" and "offers
      // re-install if appropriate" — re-install is appropriate when
      // ntn is no longer on PATH at this point. Probe again and
      // either offer re-install (TTY/--yes) or surface the install
      // command as a manual recovery path.
      console.error(
        `  ntn could not be spawned: ${formatErrorDetail(loginResult.error)}`,
      )
      // `isNtnInstalled` memoizes its first result per process — Step 1
      // already populated the cache with `true`. Bust it before the
      // second probe so we actually re-shell-out to detect a mid-flow
      // disappearance from PATH (the dominant spawn-error cause).
      // Without the reset the cache returns the stale `true` and the
      // re-install offer never fires in production. Tests that mock
      // `isNtnInstalled` directly bypass the cache and don't depend on
      // this call, but it has to land here for the live-binary path.
      resetNtnProbeCache()
      const stillInstalled = isNtnInstalled()
      if (!stillInstalled) {
        console.error("  `ntn` does not appear to be on PATH.")
        if (opts.yes || process.stdin.isTTY) {
          const reinstall =
            opts.yes ||
            (await confirmPrompt(
              "Re-install ntn now via the canonical curl-pipe-bash path?",
            ))
          if (reinstall) {
            console.error("")
            console.error(`Re-installing via: ${NTN_INSTALL_COMMAND}`)
            const installResult = await installNtn()
            if (installResult.kind === "success") {
              // No checkmark — the current `--login` invocation
              // never reached Step 4, so the operator is NOT logged
              // in yet. Pairing a "✓" with an exit-1 misreads as
              // success; phrase the line as the next-step it is.
              console.error(
                "ntn re-installed. Re-run `lore auth --login` to complete login.",
              )
            } else {
              console.error(
                "ntn re-install failed. Install manually and re-run `lore auth --login`:",
              )
              console.error(`  ${NTN_INSTALL_COMMAND}`)
            }
            process.exit(1)
            return
          }
        }
        console.error(`  Manual re-install: ${NTN_INSTALL_COMMAND}`)
        console.error("  Then re-run `lore auth --login`.")
        if (!opts.yes && !process.stdin.isTTY) {
          // Mirror the install-from-missing branch's hint so a script
          // consumer hitting this in CI sees the auto-recovery option.
          console.error(
            "  Pass --yes (next run) to consent to the canonical re-install non-interactively.",
          )
        }
      } else {
        console.error("Re-run `lore auth --login` to retry.")
      }
    }
    process.exit(1)
    return
  }
  console.log("")

  // Step 4 — re-resolve + preflight.
  console.log("Verifying auth resolves to the configured vault...")
  let auth: ResolvedAuth
  try {
    auth = await resolveAuth(config, found.root)
  } catch (err) {
    console.error(
      "ntn login completed, but Lore could not resolve a token.",
    )
    // Preserve resolveAuth's diagnostic — multi-workspace ambiguity
    // and selector-not-found cases carry the actionable next step
    // (which workspaces are present, which env var to set). Dropping
    // it would strand the operator on `lore auth --status` for a
    // hint they can already see right here.
    if (err instanceof Error && err.message.length > 0) {
      console.error("")
      for (const line of err.message.split("\n")) {
        console.error(`  ${line}`)
      }
    }
    process.exit(1)
    return
  }

  const client = createLimitedClient(createClient(auth.token, auth.baseUrl))
  const result = await verifyVaultAccess(client, config.vault.pageId)
  if (result.kind !== "ok") {
    console.error(`✗ Vault page not accessible after login (${result.kind}).`)
    // Per-branch copy: each `VaultAccessResult` failure shape demands
    // different operator action. Collapsing them into the generic
    // "wrong workspace / not shared" wording would mislead an
    // operator hitting a 401 (re-auth needed, NOT a sharing issue)
    // or a 429 (wait, NOT investigate).
    if (result.kind === "not-found") {
      console.error(`  ${result.message}`)
      console.error("")
      console.error("Most likely causes:")
      console.error(
        "  1. You authenticated against the wrong workspace during ntn login.",
      )
      console.error(
        `     Re-run \`lore auth --login\` and pick the workspace containing ${config.vault.pageId}.`,
      )
      console.error(
        "  2. The vault page isn't shared with you (your Notion identity)",
      )
      console.error(
        "     in this workspace. Your ntn-issued token inherits your",
      )
      console.error(
        "     personal Notion permissions, so any page you can see in",
      )
      console.error(
        "     Notion's UI is reachable. Ask whoever owns the vault to",
      )
      console.error(
        "     share it with you, or check that you're a member of the",
      )
      console.error("     workspace containing the page.")
    } else if (result.kind === "unauthorized") {
      console.error(`  ${result.message}`)
      console.error("")
      // Surprise case: ntn login just succeeded yet the freshly-issued
      // token is being rejected. Most plausible cause is a clock skew
      // / propagation delay between ntn's token write and the API's
      // recognition of it; second-most plausible is an integration-side
      // restriction (`restricted_resource`) the engineer's identity
      // can't bypass.
      console.error("Recommended: re-run `lore auth --login` to issue a fresh token.")
      console.error(
        "If the issue persists, check that your Notion identity is a member of the workspace.",
      )
    } else if (result.kind === "rate-limited") {
      console.error(`  ${result.message}`)
      console.error("")
      console.error("Wait a few seconds and re-run `lore auth --login` to retry the preflight.")
    } else {
      console.error(`  ${formatErrorDetail(result.error)}`)
      console.error("")
      console.error("Re-run `lore auth --login` after investigating the error above.")
    }
    process.exit(1)
    return
  }

  console.log(
    `✓ Authenticated; vault page reachable: ${result.pageTitle ?? config.vault.pageId}`,
  )
  if (auth.workspaceId) {
    console.log(`  Workspace: ${auth.workspaceId}`)
  }
}

// ---------------------------------------------------------------------------
// --whoami
// ---------------------------------------------------------------------------

/**
 * Run the `--whoami` body. Resolves the active token, calls
 * `users.me`, and prints the bot identity on a single line for
 * scriptability.
 *
 * Three-fallback identity logic: owner-user-name → owner-user-id →
 * `<bot in <workspace_name>>`. The shape of `users.me` differs
 * between user-owned and workspace-owned bots; ntn-issued tokens
 * may surface either depending on Notion's internal policy.
 *
 * Mirrors `--status` / `--logout`'s no-vault-context fallback —
 * `whoami` is a script-friendly identity probe and must work
 * outside a Lore project when a `NOTION_API_TOKEN` env or a
 * single-workspace `auth.json` resolves. Inside a vault context
 * we still load the config so the resolver can honor
 * `auth.workspaceId` and the legacy `auth.token` source.
 */
export async function runWhoami(): Promise<void> {
  const cwd = process.cwd()
  const found = await findConfigFile(cwd)
  const config = found ? await loadConfig(found.path) : undefined
  // Outside a vault, key the deprecation marker off `homedir()` so
  // running `lore auth --whoami` from different project dirs doesn't
  // re-fire the legacy `LORE_NOTION_TOKEN` warning per cwd.
  const configRoot = found ? found.root : homedir()

  let auth: ResolvedAuth
  try {
    auth = await resolveAuth(config, configRoot)
  } catch (err) {
    console.error("Not authenticated. Run `lore auth --login`.")
    if (err instanceof Error && err.message.length > 0) {
      // Surface resolveAuth's diagnostic (e.g. ntn multi-workspace
      // ambiguity, requested-workspace-not-found) so a script consumer
      // hitting `lore auth --whoami` for the first time knows what to
      // fix beyond the generic redirect at --login.
      for (const line of err.message.split("\n")) {
        console.error(`  ${line}`)
      }
    }
    process.exit(1)
    return
  }

  const client = createLimitedClient(createClient(auth.token, auth.baseUrl))
  console.log(await renderWhoamiIdentity(client))
}

/**
 * Probe `users.me` and pick a one-line identity. Exported for unit
 * tests so the three identity fallbacks can be exercised without
 * driving the whole CLI surface.
 *
 * Throws on `users.me` failure (callers exit 1 with the documented
 * error wording).
 */
export async function renderWhoamiIdentity(client: Client): Promise<string> {
  let me: unknown
  try {
    me = await client.users.me({})
  } catch (err) {
    console.error(
      "Could not fetch identity:",
      err instanceof Error ? err.message : err,
    )
    process.exit(1)
    // process.exit doesn't throw under mocked test setups, so fall
    // through to a sentinel string the test harness can assert on.
    // In production this line is unreachable.
    return "<unreachable>"
  }

  const bot = (me as { bot?: Record<string, unknown> }).bot
  const owner = bot?.["owner"] as Record<string, unknown> | undefined
  const ownerUser = owner?.["user"] as Record<string, unknown> | undefined

  if (typeof ownerUser?.["name"] === "string" && ownerUser["name"].length > 0) {
    return ownerUser["name"]
  }
  if (typeof ownerUser?.["id"] === "string" && ownerUser["id"].length > 0) {
    return ownerUser["id"]
  }
  if (
    typeof bot?.["workspace_name"] === "string" &&
    bot["workspace_name"].length > 0
  ) {
    return `<bot in ${bot["workspace_name"]}>`
  }

  // The `users.me` response carried neither a bot owner identity nor a
  // workspace name. The token is valid (the call succeeded) but the
  // response shape is unexpected — log a one-line stderr hint so the
  // operator can distinguish "valid token, opaque identity" from "the
  // CLI silently returned a sentinel."
  process.stderr.write(
    "[lore] users.me returned no bot owner or workspace name; identity is opaque.\n",
  )
  return "<unknown>"
}

// ---------------------------------------------------------------------------
// --logout
// ---------------------------------------------------------------------------

/**
 * Run the `--logout` body. Informational only — Lore doesn't manage
 * ntn's storage, doesn't unset env vars on the operator's behalf, and
 * doesn't edit `.lore.yaml`. The right action depends on the source;
 * this command names it.
 */
export async function runLogout(): Promise<void> {
  const cwd = process.cwd()
  const found = await findConfigFile(cwd)

  let auth: ResolvedAuth | undefined
  if (found) {
    try {
      const config = await loadConfig(found.path)
      auth = await resolveAuth(config, found.root)
    } catch {
      // No active auth — fall through.
    }
  } else {
    try {
      // homedir() keying — see `runStatus`/`runWhoami` notes; collapses
      // all no-vault calls onto a single per-operator deprecation marker.
      auth = await resolveAuth(undefined, homedir())
    } catch {
      // No active auth — fall through.
    }
  }

  if (!auth) {
    console.log("No active Lore auth. Nothing to log out of.")
    return
  }

  switch (auth.source) {
    case "env-notion-api-token":
      console.log("Lore is using NOTION_API_TOKEN from your environment.")
      console.log("To log out: unset NOTION_API_TOKEN")
      console.log(
        "(If this was set by `eval $(ntn auth token --eval)`, also run `ntn logout`.)",
      )
      break
    case "ntn-auth-json":
      console.log("Lore is using your ntn-issued token (auth.json).")
      console.log("")
      console.log("To log out, run:")
      console.log("  ntn logout")
      console.log("")
      console.log(
        "This is ntn's responsibility; Lore reads but doesn't write auth.json.",
      )
      break
    case "env-lore-notion-token":
      console.log(
        "Lore is using LORE_NOTION_TOKEN from your environment.",
      )
      console.log("To log out: unset LORE_NOTION_TOKEN")
      console.log("")
      console.log("Consider migrating to ntn: `lore auth --migrate`")
      break
    case "config-auth-token":
      console.log("Lore is using auth.token in .lore.yaml.")
      if (found) {
        console.log(`To log out: remove the auth.token field from ${found.path}`)
      } else {
        console.log("To log out: remove the auth.token field from .lore.yaml")
      }
      console.log("")
      console.log("Consider migrating to ntn: `lore auth --migrate`")
      break
  }
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/**
 * Confirm a yes/no prompt. Synthesizes the `[Y/n]` / `[y/N]` suffix
 * internally so callers pass just the question. `defaultYes = true`
 * (default) accepts a bare Enter as yes; `defaultYes = false` makes
 * Enter mean no. Refuses to prompt on a non-TTY (script / CI) and
 * writes a stderr breadcrumb so a misconfigured caller sees a
 * debuggable failure mode instead of a silent false.
 *
 * **Cross-PR coordination with `Iron-Ham/0.10.0-07-lore-auth-migrate`
 * (PR #176)**. As of #176's head `4f317fdc`, both PRs export this
 * helper with the same `(message, defaultYes = true)` signature, the
 * same suffix synthesis, and the same non-TTY breadcrumb — and #176's
 * call sites pass plain messages (no in-message `[Y/n]`). The helper
 * itself is byte-equivalent across the two PRs; the late-merger
 * deletes one of the two definitions cleanly.
 *
 * The residual divergence is structural, not in this helper:
 * **#176's dispatcher still uses the OLD `if (opts.migrate) /
 * if (opts.login) / await status()` chain**, while this PR replaces
 * that chain with `pickAuthAction` + switch. The late-merger's task
 * is therefore one well-named integration:
 *
 *   1. Delete one of the two `confirmPrompt` definitions (either is
 *      a clean delete; the helpers are byte-equivalent).
 *   2. Add `migrate?: boolean` to `AuthOpts` (this PR's interface).
 *   3. Add `--migrate` to the `pickAuthAction` ladder at the top
 *      slot the precedence comment already names.
 *   4. Add `case "migrate": await runMigrate(...)` to the dispatch
 *      switch in `authCommand.action(...)`.
 *
 * No call-site rewrites; no behavioral conflicts; one file touched.
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
 * Format the detail line for an `unknown` thrown value. Centralized so
 * every `unknown-error` / `spawn-error` branch surfaces the same
 * message shape — a future change to error formatting touches one
 * spot.
 */
function formatErrorDetail(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err === undefined || err === null) return String(err)
  return String(err)
}

/**
 * Infer ntn's environment name (`dev` / `stg` / `prod`) from a
 * Notion API base URL. Inverse of `auth/ntn.ts:resolveNtnBaseUrl`'s
 * env→URL mapping; ntn's own per-environment endpoints are:
 *
 *   prod → https://api.notion.so   (also the legacy `.com` variant)
 *   dev  → https://api-dev.notion.com
 *   stg  → https://api-stg.notion.com
 *
 * Returns `undefined` when the input is missing, null, or doesn't
 * match a known environment — the caller falls through to ntn's own
 * default rather than guessing wrong.
 *
 * Exported for unit tests so the mapping is pinned independently of
 * the `runLogin` call site that consumes it.
 */
export function inferNtnEnvFromBaseUrl(
  baseUrl: string | undefined,
): NtnEnv | undefined {
  if (!baseUrl) return undefined
  if (baseUrl.includes("api-dev.notion.com")) return "dev"
  if (baseUrl.includes("api-stg.notion.com")) return "stg"
  if (
    baseUrl.includes("api.notion.so") ||
    baseUrl.includes("api.notion.com")
  ) {
    return "prod"
  }
  return undefined
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
