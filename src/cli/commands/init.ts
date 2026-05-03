import { Command } from "commander"
import { access, writeFile } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { Document, isMap } from "yaml"
import type { Client, CreatePageParameters } from "@notionhq/client"
import { createClient } from "../../notion/client.js"
import { createLimitedClient } from "../../notion/rate-limit.js"
import { VaultManager } from "../../core/vault.js"
import { resolveAuth, type ResolvedAuth } from "../../config.js"
import { ntnEnvBaseUrl, ntnEnvFromBaseUrl, verifyVaultAccess } from "../../auth/oauth.js"
import {
  installNtn,
  isNtnInstalled,
  listNtnWorkspaces,
  parseNtnEnv,
  runNtnLogin,
  NTN_INSTALL_COMMAND,
  type NtnEnv,
} from "../../auth/ntn.js"
import type { LoreConfig } from "../../types.js"
import { confirmPrompt } from "./init-prompt.js"

/**
 * Build the `.lore.yaml` text emitted by `lore init`. Pure so tests can
 * assert the comment placement without spinning up the Notion-touching
 * command path.
 *
 * The 0.9.0/08 `learningExtraction` knob and the issue #281
 * `proposeAutosaveLearnings` knob are surfaced as *commented*
 * defaults inside the `hooks:` block — operators see the fields
 * exist without them changing behavior on a fresh install. The
 * comments are attached to the `hooks` YAMLMap node (not
 * concatenated onto the file tail) so they land under `hooks:`
 * regardless of future top-level key additions or yaml-lib output
 * reordering.
 *
 * `workspaceId` is the optional ntn-source workspace id surfaced by
 * `ResolvedAuth`. When set, the generated config carries an
 * `auth.workspaceId` so subsequent commands resolve cleanly on
 * multi-workspace operators. Single-workspace operators (no `workspaceId`)
 * get a minimal config with the `auth:` block absent.
 */
export function buildInitConfigYaml(pageId: string, workspaceId?: string): string {
  const config: LoreConfig = {
    vault: { pageId },
    ...(workspaceId !== undefined && {
      auth: { workspaceId },
    }),
    projects: [],
    hooks: {
      autoSave: true,
      wakeUp: true,
      saveInterval: 5,
    },
  }

  const doc = new Document(config)
  const hooks = doc.get("hooks", true)
  if (isMap(hooks)) {
    // YAMLMap.comment renders after the map's last child at the map's
    // own indent — i.e., as the final line inside the `hooks:` block.
    // Leading space is required: yaml-lib prefixes `# ` so the rendered
    // line reads `  # learningExtraction: true …`. Two commented
    // defaults so a fresh install advertises both the on/off
    // extraction knob and the inbox-routing knob.
    hooks.comment =
      " learningExtraction: true  # 0.9.0/08 — autosave atomic-learning extraction\n" +
      " proposeAutosaveLearnings: false  # issue #281 — route auto-extracted learnings through the proposed-memory review inbox"
  }
  return doc.toString()
}

/**
 * Create a workspace-level vault page via `pages.create({ parent: { type:
 * "workspace", workspace: true } })`. Per Notion's docs this shape is
 * "available only for bots of public connections" — the `Notion Workers
 * CLI` integration that ntn issues tokens against IS a public connection,
 * so this works under ntn-first auth.
 *
 * `title` is the operator-visible page name in Notion's UI. The default
 * is repo-derived (`defaultVaultTitle`) so a workspace with multiple
 * vaults doesn't collapse to indistinguishable `Lore Vault` private
 * pages; operators can override via `--name`.
 *
 * The v5 SDK's `CreatePageParameters` is a strict discriminated union;
 * the workspace-parent variant may not infer cleanly through structural
 * typing. The cast follows `src/notion/CLAUDE.md`'s "Filter Type
 * Casting" precedent — verify at SDK-upgrade time and drop the cast if
 * the inference improves.
 */
export async function createWorkspaceLevelPage(
  client: Client,
  title: string
): Promise<{ id: string }> {
  const params = {
    parent: { type: "workspace", workspace: true },
    properties: {
      title: {
        title: [{ type: "text", text: { content: title } }],
      },
    },
  } as CreatePageParameters

  const response = await client.pages.create(params)
  return { id: response.id }
}

/**
 * Default `Lore Vault` page title, repo-derived from the cwd basename.
 * Falls back to the bare `Lore Vault` string when the basename is
 * empty (cwd is at the filesystem root) so we never produce a malformed
 * title like `"Lore Vault — "`.
 *
 * Pure so tests can pin the basename → title mapping without spinning
 * up `runNoArgInit`. The em-dash separator (`—`, not `-`) intentionally
 * matches the "vault for the <repo> project" framing that surfaces in
 * Notion's UI sidebar; ASCII `-` would compose ambiguously with hyphens
 * inside the repo name (`my-cool-repo` → `Lore Vault - my-cool-repo`).
 *
 * Title-collision footgun (by design): two engineers running `lore init`
 * from different machines but in directories with the same basename
 * (e.g., both have `~/Developer/Mail`) produce identically-titled
 * private pages in the same workspace. The page id distinguishes them
 * structurally — Lore identity is page-id-keyed, not title-keyed — but
 * Notion's UI sidebar shows both rows the same way. Operators who hit
 * this rename via `--name`. Not surfaced as a warning at init time
 * because the collision is invisible to the engineer (they can only see
 * their own Private area before sharing).
 */
export function defaultVaultTitle(cwd: string): string {
  const name = basename(cwd).trim()
  if (!name) return "Lore Vault"
  return `Lore Vault — ${name}`
}

/**
 * Best-effort `resolveAuth` wrapper that converts the throw-on-no-source
 * shape into a `null` return. The no-arg init flow uses the null path to
 * branch into the ntn-install / ntn-login interactive recovery; bubbling
 * the throw would skip the recovery and force operators back to the
 * shell.
 */
async function tryResolveAuth(cwd: string): Promise<ResolvedAuth | null> {
  try {
    return await resolveAuth(undefined, cwd)
  } catch {
    return null
  }
}

/**
 * Check whether a resolved auth's baseUrl corresponds to the operator's
 * requested `--ntn-env`. Distinguishes the "operator already had auth
 * resolving to prod, but runs `lore init --ntn-env dev`" footgun: pre-
 * fix, the flag was silently ignored when auth resolved on the first
 * try, leading to a vault created in prod despite the explicit dev
 * request.
 *
 * Delegates the URL → env mapping to `oauth.ts:ntnEnvFromBaseUrl` so
 * every Lore-managed ntn login surface (#06 / #07 / #08 / #09) agrees
 * on the canonical URL table — per the milestone spec's "Centralize
 * this so every surface agrees" guidance.
 *
 * The `undefined === prod` rule is load-bearing and lives here, NOT
 * in `ntnEnvFromBaseUrl`: ntn-source auth pointing at prod returns
 * `baseUrl: undefined` (the SDK then defaults to `api.notion.so`),
 * and forcing it to write the explicit string would diverge the
 * in-memory shape from the on-disk config.json shape. Re-encoding the
 * undefined→prod equivalence in the inverse mapper would over-broaden
 * its surface; only init's mismatch gate cares.
 *
 * Pure so tests can pin the equality without spinning up the
 * orchestrator.
 */
export function authBaseUrlMatchesEnv(
  authBaseUrl: string | undefined,
  requestedEnv: NtnEnv
): boolean {
  if (authBaseUrl === undefined) return requestedEnv === "prod"
  return ntnEnvFromBaseUrl(authBaseUrl) === requestedEnv
}

/**
 * Map an `NtnEnv` literal to the canonical Notion API base URL the
 * env-mismatch recovery copy should hand operators on env-token
 * sources. Returns `undefined` for `prod` (the SDK's default; explicit
 * URLs would diverge from the on-disk shape ntn writes for prod).
 *
 * Delegates to `oauth.ts:ntnEnvBaseUrl` for the URL — `expectedBaseUrlForEnv`
 * exists only to apply the prod-special-case (return undefined instead
 * of the canonical URL) on top of the shared mapping.
 */
function expectedBaseUrlForEnv(env: NtnEnv): string | undefined {
  if (env === "prod") return undefined
  return ntnEnvBaseUrl(env)
}

/**
 * `lore init <page-id>` legacy path. Operator already owns a vault page
 * (created in Notion's UI or via a prior install) and hands its id to
 * Lore. Adds a `verifyVaultAccess` preflight ahead of the heavy
 * database-creation work — if the operator pasted a page id their auth
 * can't reach, we want a clean "page not accessible" error rather than
 * letting `vault.init()` throw a less-clear 404 mid-fan-out.
 *
 * `name` is accepted for option-shape symmetry with the no-arg flow
 * but ignored here — the page already exists, Lore doesn't rename it.
 * A truthy value emits a one-line stderr note (matching the
 * `--cursor-global ignored under --client claude` precedent in
 * `install.ts`) so an operator who scripted `--name` against the wrong
 * shape isn't surprised by silent drop.
 */
export async function runExplicitPageInit(
  pageId: string,
  opts: { token?: string; name?: string; ntnEnv?: string }
): Promise<void> {
  if (opts.name && opts.name.trim().length > 0) {
    console.error(
      "[lore] --name is ignored when a page id is provided (Lore doesn't rename existing pages)."
    )
  }
  if (opts.ntnEnv !== undefined) {
    // `--ntn-env` only affects the spawned `ntn login` in the no-arg
    // recovery flow; the explicit-page path expects the operator's
    // auth (env / ntn-resolved / config) to already be configured. A
    // truthy value emits a one-line stderr note matching the `--name`
    // precedent so an operator who scripted the wrong shape isn't
    // surprised by silent drop.
    console.error(
      "[lore] --ntn-env is ignored when a page id is provided (no ntn login is spawned on the explicit-page path)."
    )
  }
  // Two paths:
  // - `--token` provided: operator hands us a literal token. We don't
  //   know the base URL (the operator can set `LORE_NOTION_BASE_URL`
  //   env if they need a non-prod endpoint), and we have no workspace
  //   id to thread into the generated config.
  // - Otherwise: route through `resolveAuth` which threads the
  //   ntn-resolved baseUrl (dev/stg endpoint detection from ntn's
  //   own config.json) into `createClient`. Without this, an
  //   engineer using a dev-environment ntn token would silently
  //   send their dev token to the prod API. The ntn-source path also
  //   carries `workspaceId`; capture it so the generated config can
  //   pin `auth.workspaceId` for multi-workspace operators — without
  //   that pin every subsequent command on a multi-workspace machine
  //   re-hits the ambiguity case the no-arg path's probe-then-branch
  //   short-circuits.
  let token: string
  let baseUrl: string | undefined
  let workspaceId: string | undefined
  if (opts.token) {
    token = opts.token
    baseUrl = process.env["LORE_NOTION_BASE_URL"]
    // workspaceId stays undefined — the operator handed us a raw
    // token; we have no metadata about which workspace it authorizes.
  } else {
    const auth = await resolveAuth(undefined, process.cwd())
    token = auth.token
    baseUrl = auth.baseUrl
    workspaceId = auth.workspaceId
  }
  // Wrap the raw client so `lore init`'s database-creation fan-out
  // (four pages.create + assorted reads) stays under Notion's rps
  // ceiling just like the MCP/CLI hot paths. No config is loaded here
  // yet so use the default concurrency; operators with a custom value
  // in `.lore.yaml` pick it up on subsequent commands.
  const client = createLimitedClient(createClient(token, baseUrl))

  // Preflight before doing the heavy database-creation work. If the
  // operator passed a page id their auth can't reach, fail with the
  // documented copy rather than letting database creation throw a
  // less-clear 404.
  const preflight = await verifyVaultAccess(client, pageId)
  if (preflight.kind !== "ok") {
    console.error(`Cannot access page ${pageId} — ${preflight.kind}.`)
    if (preflight.kind === "not-found") {
      console.error(`  ${preflight.message}`)
    } else if (preflight.kind === "unknown-error" && preflight.error instanceof Error) {
      // Surface the underlying SDK / network error so operators have
      // actionable diagnostic detail to attach to a bug report.
      // `verifyVaultAccess`'s contract puts the raw error on this
      // branch only.
      console.error(`  Detail: ${preflight.error.message}`)
    }
    console.error("")
    console.error("Fix the page sharing in Notion's UI, then re-run.")
    process.exit(1)
  }

  const vault = new VaultManager(client, pageId)

  console.log("Creating Lore databases in Notion...")

  try {
    const result = await vault.init()
    console.log("Vault initialized successfully!")
    console.log(`  Projects DB: ${result.databases.projects}`)
    console.log(`  Topics DB:   ${result.databases.topics}`)
    console.log(`  Memories DB: ${result.databases.memories}`)
    console.log(`  Entities DB: ${result.databases.entities}`)
    console.log(`  Facts DB:    ${result.databases.facts}`)

    const configPath = resolve(process.cwd(), ".lore.yaml")
    // Pass the ntn-source `workspaceId` through to the generated YAML
    // so multi-workspace operators using `lore init <page-id>` get
    // `auth.workspaceId` pinned just like the no-arg path. Without
    // this, the legacy path silently re-introduced the ambiguity case
    // every subsequent command would re-discover.
    await writeFile(configPath, buildInitConfigYaml(pageId, workspaceId))
    console.log(`\nConfig written to ${configPath}`)
    console.log("\nNext steps:")
    console.log("  1. Add projects to .lore.yaml")
    console.log("  2. Add the MCP server to your AI assistant config")
    console.log("  3. Run `lore mine` to index project files")
  } catch (err) {
    if (err instanceof Error && err.message.includes("already initialized")) {
      console.log("Vault already exists at this page. Use `lore status` to check.")
    } else {
      console.error(
        "Failed to initialize vault:",
        err instanceof Error ? err.message : err
      )
      process.exit(1)
    }
  }
}

/**
 * `lore init` no-arg path. Resolves the ntn-issued token (or recovers
 * via interactive ntn install/login), creates a workspace-level vault
 * page, runs `verifyVaultAccess` post-creation, initializes the four
 * databases, and writes `.lore.yaml`. End-to-end onboarding for a fresh
 * project under ntn-first auth.
 */
export async function runNoArgInit(opts: {
  yes?: boolean
  name?: string
  ntnEnv?: string
}): Promise<void> {
  const cwd = process.cwd()
  const yesFlag = opts.yes === true
  // Parse `--ntn-env` BEFORE any side effect so an invalid value
  // fails fast without touching Notion / spawning ntn / prompting.
  // `parseNtnEnv` returns `undefined` for "operator didn't pass the
  // flag" (use ntn's default) and `null` for "operator passed an
  // unrecognized value" (input error).
  const ntnEnv: NtnEnv | undefined | null = parseNtnEnv(opts.ntnEnv)
  if (ntnEnv === null) {
    console.error(
      `Invalid --ntn-env value: ${JSON.stringify(opts.ntnEnv)}. Expected one of: prod, dev, stg.`
    )
    process.exit(1)
    return
  }
  // Operator-supplied name wins over the cwd-derived default. An empty
  // `--name ""` falls through to the default rather than being treated
  // as an explicit empty title (commander's missing-value semantics make
  // `--name ""` an unusual but possible shape).
  const vaultTitle =
    opts.name && opts.name.trim().length > 0 ? opts.name.trim() : defaultVaultTitle(cwd)

  // Refuse to overwrite an existing `.lore.yaml`. Check existence
  // outside the early-exit branch so a future `process.exit` mock (or a
  // hook that catches PromiseRejection) can't silently fall through into
  // the create path.
  const configPath = resolve(cwd, ".lore.yaml")
  let configExists = false
  try {
    await access(configPath)
    configExists = true
  } catch {
    // File doesn't exist — proceed.
  }
  if (configExists) {
    console.error(`A .lore.yaml already exists at ${configPath}.`)
    console.error(
      "If you want to re-initialize, delete it first or run from a different directory."
    )
    process.exit(1)
    return
  }

  // Resolve auth via the existing chain (NOTION_API_TOKEN env →
  // ntn auth.json → LORE_NOTION_TOKEN → auth.token). No-arg
  // init's only constraint: there must be a resolvable token.
  let auth = await tryResolveAuth(cwd)

  // `tryResolveAuth` returns null on at least two distinct failure
  // shapes from `loadNtnToken`:
  //
  //   (a) ntn not installed / not logged in / auth.json missing → genuine
  //       "no auth, recover via interactive install + login".
  //   (b) ntn installed, logged in, but `auth.json` carries multiple
  //       workspaces with no selector (no NOTION_WORKSPACE_ID env, no
  //       .lore.yaml yet — we're initializing, so there isn't one) →
  //       `loadNtnToken` writes a stderr hint and returns null.
  //
  // The recovery flow below is only correct for (a). Falling into it
  // for (b) prints a misleading "ntn is not installed" copy or routes
  // the operator into a redundant `ntn login` that doesn't fix the
  // ambiguity. The actual fix is `NOTION_WORKSPACE_ID=<id> lore init`
  // (or equivalent .lore.yaml seeding before init, but `lore init`'s
  // contract is "no .lore.yaml exists yet").
  //
  // Probe-then-branch: `isNtnInstalled` is a cheap synchronous
  // `execFileSync ntn --version` (memoized per-process). Hoisted to a
  // single local because the recovery flow below also reads the same
  // value; calling twice is free (cached) but the local makes the
  // control flow easier to read.
  //
  // If ntn IS installed AND auth still didn't resolve, walk
  // auth.json's workspace list. >1 workspace = ambiguity case →
  // print the actionable copy and exit 1 BEFORE entering the
  // install/login recovery.
  const ntnInstalled = isNtnInstalled()
  if (!auth && ntnInstalled) {
    const workspaces = await listNtnWorkspaces()
    if (workspaces.length > 1) {
      console.error(
        `Multiple workspaces in ntn auth.json (${workspaces.length}); ` +
          `Lore can't pick one without a selector.`
      )
      console.error(`Available: ${workspaces.join(", ")}`)
      console.error("")
      // Single actionable next step — `auth.workspaceId in .lore.yaml`
      // is bootstrap-impossible during init (no `.lore.yaml` exists
      // yet), so listing it as a parallel option misleads readers
      // skimming for what to type. The env-var route is the only
      // surface that works at first run; subsequent commands pick up
      // `auth.workspaceId` once init writes it for them.
      //
      // Preserve operator-supplied flags in the recovery copy. The
      // recovery is "re-run with the workspace selector resolved" —
      // if the operator originally typed `--ntn-env dev` (or a
      // custom `--name`), pasting the recovery without those flags
      // would silently demote the request: the second run would
      // bypass the env-mismatch gate (post-NOTION_WORKSPACE_ID auth
      // resolves cleanly, no flag means no constraint to check) and
      // could land a vault in prod despite the explicit dev
      // request. Append the original flags so the paste is
      // transitively safe.
      const recoveryFlags = [
        ntnEnv ? `--ntn-env ${ntnEnv}` : null,
        opts.name && opts.name.trim().length > 0
          ? `--name ${JSON.stringify(opts.name.trim())}`
          : null,
      ]
        .filter((f): f is string => f !== null)
        .join(" ")
      const recoveryCommand = recoveryFlags
        ? `NOTION_WORKSPACE_ID=<id> lore init ${recoveryFlags}`
        : "NOTION_WORKSPACE_ID=<id> lore init"
      console.error("Re-run with the workspace id in env:")
      console.error(`  ${recoveryCommand}`)
      process.exit(1)
      return
    }
    // workspaces.length === 0 means ntn is installed but never logged
    // in (auth.json absent or empty), or auth.json is malformed. Fall
    // through to the install/login recovery — `runNtnLogin` is the
    // right action.
  }

  // If no auth resolves, offer to run ntn login (after checking ntn
  // install state). Same shell-out pattern as Phase 2's `lore auth
  // --login` and `lore install`. Reuses helpers from #02
  // (`isNtnInstalled`, `installNtn`, `runNtnLogin`). No
  // `NOTION_KEYRING=0` check — `runNtnLogin()` forces it inside the
  // spawn per Option A.
  if (!auth) {
    console.log("Cannot initialize vault — no Notion auth available.")
    console.log("")

    if (!ntnInstalled) {
      console.log("ntn is not installed.")
      console.log("Lore can install it via the canonical command:")
      console.log(`  ${NTN_INSTALL_COMMAND}`)
      console.log("")
      const ok = await confirmPrompt("Install ntn now? [Y/n] ", yesFlag)
      if (!ok) {
        console.error("ntn is required for `lore init`. Install manually:")
        console.error(`  ${NTN_INSTALL_COMMAND}`)
        console.error("Then re-run `lore init`.")
        process.exit(1)
        return
      }
      const installResult = await installNtn()
      if (installResult.kind !== "success") {
        console.error("ntn install failed.")
        console.error("Check your network and shell, then re-run `lore init`.")
        process.exit(1)
        return
      }
      console.log("✓ ntn installed.")
      console.log("")
    }

    // Offer ntn login. If the operator declines the Lore-spawned path,
    // the manual fallback must include NOTION_KEYRING=0; otherwise ntn
    // can write to the macOS keychain where Lore cannot read the token.
    const manualLoginCommand = ntnEnv
      ? `NOTION_KEYRING=0 NOTION_ENV=${ntnEnv} ntn login`
      : "NOTION_KEYRING=0 ntn login"
    const ok = await confirmPrompt(`Run \`${manualLoginCommand}\` now? [Y/n] `, yesFlag)
    if (!ok) {
      console.error(
        `ntn login is required to initialize a vault. Run \`${manualLoginCommand}\` manually,`
      )
      console.error("then re-run `lore init`.")
      process.exit(1)
      return
    }
    // Thread the operator-supplied environment selection through so
    // ntn writes the matching `env` field into config.json — which
    // `loadNtnToken` + `resolveNtnBaseUrl` then read on the post-login
    // `tryResolveAuth(cwd)` below to surface the dev/stg base URL.
    // `undefined` means "use ntn's default" (prod, unless the
    // operator's shell rc carries `NOTION_ENV=dev` already, which we
    // deliberately don't clobber — see RunNtnLoginOpts).
    const loginResult = await runNtnLogin(ntnEnv ? { env: ntnEnv } : {})
    if (loginResult.kind !== "success") {
      console.error("ntn login did not complete successfully.")
      if (loginResult.kind === "exit-non-zero") {
        console.error(`  ntn exited with code ${loginResult.code}`)
      }
      console.error("Re-run `lore init` to retry.")
      process.exit(1)
      return
    }
    console.log("")

    // Re-resolve after login.
    auth = await tryResolveAuth(cwd)
    if (!auth) {
      console.error("ntn login completed, but Lore could not resolve a token.")
      console.error("Run `lore auth --status` for diagnostic info.")
      process.exit(1)
      return
    }
  }

  // Env-mismatch gate: if the operator requested `--ntn-env <env>` but
  // resolved auth points at a different environment, fail early with
  // recovery copy. Pre-fix bug (round-5 review): the flag was only
  // threaded into the recovery-branch `runNtnLogin` call; if auth
  // resolved on the first try (prod ntn login already in place,
  // operator runs `lore init --ntn-env dev`), the flag was silently
  // ignored and the vault landed in prod despite the explicit dev
  // request.
  //
  // The check fires regardless of whether auth resolved on the first
  // try OR post-login, because either path can land on a baseUrl that
  // disagrees with the requested env (e.g., ntn 0.13 not honoring
  // NOTION_ENV consistently in some edge case).
  if (ntnEnv && !authBaseUrlMatchesEnv(auth.baseUrl, ntnEnv)) {
    const resolvedDescription = auth.baseUrl ?? "(prod default — api.notion.so)"
    console.error(
      `--ntn-env ${ntnEnv} requested, but resolved auth points at ${resolvedDescription}.`
    )
    console.error(`Auth source: ${auth.source}`)
    console.error("")
    console.error("Recovery options:")
    if (auth.source === "ntn-auth-json") {
      // ntn owns auth.json's contents; the right move is to logout +
      // re-login under the requested env so config.json reflects it.
      console.error(`  ntn logout && NOTION_KEYRING=0 NOTION_ENV=${ntnEnv} ntn login`)
      console.error("  (then re-run lore init)")
    } else if (auth.source === "env-notion-api-token") {
      // The operator pasted a token into NOTION_API_TOKEN env that
      // doesn't match. Either let ntn-resolved auth take over, or set
      // LORE_NOTION_BASE_URL to point at the requested env.
      console.error("  Unset NOTION_API_TOKEN to fall through to ntn-resolved auth,")
      console.error(`  or set LORE_NOTION_BASE_URL to the ${ntnEnv} endpoint:`)
      console.error(
        `    export LORE_NOTION_BASE_URL=${expectedBaseUrlForEnv(ntnEnv) ?? "https://api.notion.so"}`
      )
    } else if (auth.source === "env-lore-notion-token") {
      // Soft-deprecated path. The right migration is `lore auth
      // --migrate` once Phase 2 #07 ships; for now the operator
      // unsets and re-logs. Unlike NOTION_API_TOKEN, this legacy path
      // does not honor LORE_NOTION_BASE_URL from operator env.
      console.error("  Unset LORE_NOTION_TOKEN to fall through to ntn-resolved auth,")
      console.error("  or migrate legacy auth before retrying:")
      console.error("    lore auth --migrate")
    } else {
      // `config-auth-token` — structurally unreachable from the no-arg
      // init flow because resolveAuth is called with config=undefined
      // (no .lore.yaml exists yet). Branch handled defensively in case
      // a future refactor changes the call shape.
      console.error("  Remove auth.token from .lore.yaml and re-init via ntn.")
    }
    process.exit(1)
    return
  }

  console.log(
    `Initializing Lore vault in workspace ${
      auth.workspaceId ?? `(unknown — resolved from ${auth.source})`
    }`
  )
  console.log("")

  const client = createLimitedClient(createClient(auth.token, auth.baseUrl))

  // Create the vault root page at workspace level.
  console.log(`Creating workspace-level vault page "${vaultTitle}"...`)
  let vaultPageId: string
  try {
    const page = await createWorkspaceLevelPage(client, vaultTitle)
    vaultPageId = page.id
    console.log(`  ✓ Created page: ${page.id} ("${vaultTitle}")`)
  } catch (err) {
    console.error(
      "Failed to create workspace-level page:",
      err instanceof Error ? err.message : err
    )
    console.error("")
    console.error("Most likely causes:")
    console.error("  1. The integration backing your auth doesn't support")
    console.error("     workspace-level page creation. Per Notion's docs, this is")
    console.error("     'available only for bots of public connections.' Notion")
    console.error("     Workers CLI is a public connection, so this should work")
    console.error("     under ntn-issued tokens. If you're on legacy")
    console.error("     LORE_NOTION_TOKEN auth, the integration may not support it.")
    console.error("  2. Your token's capabilities don't include 'Insert Content'.")
    console.error("")
    console.error("Fallback: create a vault page manually in Notion's UI in a")
    console.error("workspace your engineers belong to (no special integration share")
    console.error("needed for ntn-issued auth — engineers' tokens inherit their")
    console.error("personal Notion permissions). Then run:")
    console.error("  lore init <page-id-from-notion-url>")
    process.exit(1)
    return
  }

  // Preflight: confirm we can read the page we just created.
  // Belt-and-suspenders against permission edge cases. If preflight
  // fails here we have an orphan page in the operator's Notion Private
  // area — surface its id so the operator can either retry via
  // `lore init <id>` (which re-runs preflight against the same page)
  // or delete it from Notion's UI.
  console.log("")
  console.log("Verifying vault access...")
  const preflight = await verifyVaultAccess(client, vaultPageId)
  if (preflight.kind !== "ok") {
    console.error(`  ✗ Cannot read the page we just created — ${preflight.kind}.`)
    console.error(`  Orphan page id: ${vaultPageId}`)
    if (preflight.kind === "unknown-error" && preflight.error instanceof Error) {
      // Surface the underlying SDK / network error so operators
      // diagnosing a transient 5xx vs. a permission edge case have
      // detail to attach to a bug report. `not-found`'s message is
      // already user-facing copy from `verifyVaultAccess`; the
      // `unknown-error` branch carries the raw error instead.
      console.error(`  Detail: ${preflight.error.message}`)
    }
    console.error("")
    console.error("  Recovery options:")
    console.error(`    1. Retry with the explicit page: lore init ${vaultPageId}`)
    console.error("       (preflight runs again; if it now succeeds the flow continues)")
    console.error(
      `    2. Delete the orphan page in Notion's UI (search by id ${vaultPageId})`
    )
    console.error("")
    console.error(
      "  This is unusual; please open an issue if it persists, including the auth source from `lore auth --status`."
    )
    process.exit(1)
    return
  }
  console.log(`  ✓ Page accessible: ${preflight.pageTitle ?? vaultPageId}`)
  console.log("")

  // Create the five databases under the vault page.
  console.log("Creating Lore databases...")
  const vault = new VaultManager(client, vaultPageId)
  try {
    const result = await vault.init()
    console.log(`  ✓ Projects DB: ${result.databases.projects}`)
    console.log(`  ✓ Topics DB:   ${result.databases.topics}`)
    console.log(`  ✓ Memories DB: ${result.databases.memories}`)
    console.log(`  ✓ Entities DB: ${result.databases.entities}`)
    console.log(`  ✓ Facts DB:    ${result.databases.facts}`)
  } catch (err) {
    // "Already initialized" is FATAL in the no-arg flow: we just
    // created the page seconds ago via `pages.create`. If
    // `verifyVaultDatabases` finds an existing five-database structure
    // on a freshly-created page, it's a genuine anomaly (concurrent
    // Lore process, Notion misbehavior, real bug) — burying it under a
    // friendly "already exists" message would silently land a config
    // pointing at a vault we don't understand. Surface the page id so
    // the operator can investigate / clean up.
    //
    // Compare to `runExplicitPageInit` where the operator hands us a
    // page id and "already initialized" is the documented contract for
    // re-running init on a known vault — that branch keeps the
    // non-fatal behavior intentionally.
    if (err instanceof Error && err.message.includes("already initialized")) {
      console.error(
        "  ✗ Freshly-created page reports 'already initialized'. This should not happen."
      )
      console.error(`  Orphan page id: ${vaultPageId}`)
      console.error("")
      console.error(
        "  Please open an issue with the page id, the auth source from `lore auth --status`,"
      )
      console.error(
        "  and any other Lore processes that may have been running concurrently."
      )
      process.exit(1)
      return
    }
    console.error("Failed to initialize vault:", err instanceof Error ? err.message : err)
    console.error(`  Orphan page id: ${vaultPageId}`)
    console.error(`  Recovery: re-run via the explicit path — lore init ${vaultPageId}`)
    process.exit(1)
    return
  }

  // Write .lore.yaml.
  await writeFile(configPath, buildInitConfigYaml(vaultPageId, auth.workspaceId))
  console.log("")
  console.log(`Config written to ${configPath}`)

  console.log("")
  console.log("Next steps:")
  console.log(
    "  1. Add projects to .lore.yaml (or auto-detect via the `detect.patterns` config)"
  )
  console.log("  2. Run `lore install` to wire Lore into your assistant")
  console.log("  3. Run `lore mine` to index project files")
}

/**
 * Options accepted on the `lore init` action. Single source of truth so
 * `runExplicitPageInit` / `runNoArgInit` and the commander dispatch
 * can't drift if a future option is added.
 *
 * `--name` is a post-spec addition (PR #177 review feedback): the spec
 * lists `<page-id>` / `--token` / `-y/--yes` only, but the cwd-derived
 * default title plus the explicit override addresses the multi-vault-
 * per-workspace footgun the reviewer flagged. Worth carrying forward
 * into the issue spec on the next pass.
 */
interface InitOpts {
  token?: string
  yes?: boolean
  name?: string
  ntnEnv?: string
}

export const initCommand = new Command("init")
  .description("Initialize a Lore vault in a Notion page")
  .argument(
    "[page-id]",
    "Existing Notion page ID to use as the vault root (omitted: create a new workspace-level page via ntn-resolved auth)"
  )
  .option(
    "--token <token>",
    "Notion integration token (or set NOTION_API_TOKEN / LORE_NOTION_TOKEN). Ignored under no-arg init."
  )
  .option("-y, --yes", "Auto-confirm prompts (e.g., 'Install ntn?', 'Run ntn login?')")
  .option(
    "--name <name>",
    "Page title for the new workspace-level vault (no-arg only; ignored when a page id is provided). Defaults to 'Lore Vault — <basename(cwd)>'"
  )
  .option(
    "--ntn-env <env>",
    "Notion environment for ntn login (prod | dev | stg). When omitted, ntn's own default applies (prod unless NOTION_ENV is set in the operator's shell). Sets NOTION_ENV in the spawned ntn process so the post-login auth resolution surfaces the matching base URL."
  )
  .action(async (pageId: string | undefined, opts: InitOpts) => {
    if (pageId) {
      await runExplicitPageInit(pageId, opts)
    } else {
      await runNoArgInit(opts)
    }
  })
