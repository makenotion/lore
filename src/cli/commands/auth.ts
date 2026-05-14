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
 *              only — Lore doesn't manage ntn's storage or shell env).
 */

import { Command } from "commander"
import { createInterface } from "node:readline/promises"
import { homedir } from "node:os"
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
  MIN_NTN_VERSION,
  type NtnEnv,
  NTN_INSTALL_COMMAND,
  parseNtnEnv,
  resetNtnProbeCache,
  runNtnLogin,
} from "../../auth/ntn.js"
import {
  ntnEnvFromBaseUrl,
  verifyVaultAccess,
} from "../../auth/oauth.js"
import {
  classifyTokenPrefix,
  describeTokenPrefix,
  tokenPrefixAdvisory,
} from "../../auth/token-prefix.js"
import { createClient } from "../../notion/client.js"
import { createLimitedClient } from "../../notion/rate-limit.js"

interface AuthOpts {
  status?: boolean
  login?: boolean
  logout?: boolean
  whoami?: boolean
  yes?: boolean
}

export type AuthAction = "login" | "logout" | "whoami" | "status"

/**
 * Documented precedence for multi-flag invocations:
 *   --login > --logout > --whoami > --status
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
 * Run the `--status` body. Routes on whether .lore.yaml is reachable
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
      // Pass `homedir()` rather than `cwd` when there is no vault
      // context so global auth resolution has a stable root for ntn
      // workspace selection and diagnostics.
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
          "  Install per the rollout runbook: docs/team-rollout.md",
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
    if (!isNtnInstalled()) {
      console.log("")
      console.log("  Note: `ntn` does not appear to be installed.")
      console.log("  Install per the rollout runbook: docs/team-rollout.md")
    }
    return
  }

  printAuthSourceLines(auth)

  console.log("")
  console.log(`  Vault page id:  ${config.vault.pageId}`)
  if (config.auth?.workspaceId) {
    console.log(`  Pinned workspace: ${config.auth.workspaceId}`)
  }
  // Surface the active baseUrl so operators see what host their next
  // preflight call will hit.
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
    console.log("")
    printStatusVaultRecovery(auth, "not-found", config.vault.pageId)
  } else if (result.kind === "unauthorized") {
    // Token rejected (401 / 403). Distinct from `not-found` so the
    // remediation actually helps: the operator's next step is
    // source-specific auth recovery, not generic workspace re-share.
    console.log("  ✗ Vault preflight: token rejected (unauthorized)")
    console.log(`    ${result.message}`)
    console.log("")
    printStatusVaultRecovery(auth, "unauthorized", config.vault.pageId)
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

function printStatusVaultRecovery(
  auth: ResolvedAuth,
  kind: "not-found" | "unauthorized",
  vaultPageId: string
): void {
  if (auth.source === "env-notion-api-token") {
    if (auth.token.startsWith("secret_")) {
      console.log(
        "  The token shape is `secret_…` — an integration token from notion.so/profile/integrations, NOT a PAT.",
      )
      console.log(
        "  Rotate to a PAT from notion.so/developers/tokens for per-user isolation.",
      )
      console.log("")
    }
    console.log("  Recommended for NOTION_API_TOKEN / PAT:")
    if (kind === "unauthorized") {
      console.log(
        "    1. Rotate the PAT at https://www.notion.so/developers/tokens.",
      )
      console.log(
        "       The current value may be expired, revoked, or scoped to the wrong workspace.",
      )
      console.log(
        "    2. Confirm the vault page is shared with the PAT's owning Notion identity.",
      )
    } else {
      console.log(
        `    1. Confirm the PAT was created in the workspace containing ${vaultPageId}.`,
      )
      console.log(
        "       Create or rotate it at https://www.notion.so/developers/tokens.",
      )
      console.log(
        "    2. Confirm the vault page is shared with the PAT's owning Notion identity.",
      )
    }
    console.log(
      "       If you can't open the page in Notion's UI, the PAT can't read it either.",
    )
    console.log(
      "    3. Export the PAT as NOTION_API_TOKEN, then re-run `lore auth --status`.",
    )
    return
  }

  console.log("  Recommended for ntn auth:")
  if (kind === "unauthorized") {
    console.log("    Run `lore auth --login` to issue a fresh ntn token.")
    console.log(
      "    If the issue persists, check that your Notion identity is a member of the workspace.",
    )
    return
  }

  console.log(
    `    1. Run \`lore auth --login\` and pick the workspace containing ${vaultPageId}.`,
  )
  console.log("    2. Confirm the vault page is shared with your Notion identity.")
  console.log(
    "       If you can't open it in Notion's UI, the ntn token can't read it either.",
  )
}

/**
 * Render the source / status lines for an active or absent
 * `ResolvedAuth`. Pure-ish (writes to console.log) so tests can pin the
 * exact lines per source without driving the entire `runStatus` flow.
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
      break
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
  //   2. Inferred from .lore.yaml's `auth.baseUrl` (PnP-style dev
  //      projects carry `auth.baseUrl: https://api-dev.notion.com`;
  //      threading that into `ntn login --env dev` keeps the
  //      Lore-managed login pointed at the same environment the
  //      operator's vault config already declares).
  //   3. Fall through to ntn's own default (typically prod from its
  //      ~/.config/notion/config.json).
  //
  // The inferred form is the load-bearing piece: a dev-environment
  // operator without `NOTION_ENV=dev` in their shell would otherwise
  // run bare `ntn login` (prod) and then fail Step 4 preflight
  // against a dev vault — the failure would be visible but the cause
  // (mismatched env) would not. Inferring from `auth.baseUrl` closes
  // the loop.
  const shellNtnEnvRaw = process.env["NOTION_ENV"]
  const shellNtnEnv = parseNtnEnv(shellNtnEnvRaw) ?? undefined
  const inferredNtnEnv = ntnEnvFromBaseUrl(config.auth?.baseUrl)
  const ntnEnv: NtnEnv | undefined = shellNtnEnv ?? inferredNtnEnv
  if (!shellNtnEnv && inferredNtnEnv) {
    console.log(
      `(Inferring \`NOTION_ENV=${inferredNtnEnv}\` from auth.baseUrl in .lore.yaml.)`,
    )
  }
  console.log(
    ntnEnv
      ? `Running \`NOTION_KEYRING=0 NOTION_ENV=${ntnEnv} ntn login\`...`
      : "Running `NOTION_KEYRING=0 ntn login`...",
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
      // change, etc.). This branch is handled differently from
      // exit-non-zero — re-install is appropriate when ntn is missing
      // from PATH at this point. Probe again and either offer
      // re-install (TTY/--yes) or surface the install command as a
      // manual recovery path.
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
 * single-workspace auth.json resolves. Inside a vault context
 * we still load the config so the resolver can honor
 * `auth.workspaceId`.
 */
export async function runWhoami(): Promise<void> {
  const cwd = process.cwd()
  const found = await findConfigFile(cwd)
  const config = found ? await loadConfig(found.path) : undefined
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
  const identity = await renderWhoamiIdentity(client)
  const prefixKind = classifyTokenPrefix(auth.token)
  const prefixLabel = describeTokenPrefix(prefixKind)
  // Append `(<prefix label>)` so the operator can self-diagnose the
  // "I pasted an integration token instead of a PAT" failure mode
  // straight from --whoami output. Empty for unknown-prefix tokens so
  // we don't render an unhelpful `(unknown)` suffix. The label itself
  // MUST be single-line, paren-free — `tokenPrefixAdvisory` emits the
  // integration-token rate-limit hint on stderr so the stdout
  // identity stays script-friendly and avoids nested-paren rendering.
  console.log(prefixLabel ? `${identity}  (${prefixLabel})` : identity)
  const advisory = tokenPrefixAdvisory(prefixKind)
  if (advisory) {
    // `console.error` (not `process.stderr.write`) so the test
    // harness's `console.error` spy captures the line alongside the
    // other auth-command stderr output, and so `vi.spyOn(console,
    // "error")` is the single capture point. Stays script-friendly:
    // stdout carries only the identity line.
    console.error(advisory)
  }
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
 * doesn't edit .lore.yaml. The right action depends on the source;
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
 * `defaultYes = true` accepts a bare Enter as yes; `false` makes Enter
 * mean no. Refuses to prompt on a non-TTY (script / CI) and writes a
 * stderr breadcrumb so a misconfigured caller sees a debuggable failure
 * mode instead of a silent false.
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
