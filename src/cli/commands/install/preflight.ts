import { chmod } from "node:fs/promises"
import { join, resolve } from "node:path"
import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline/promises"
import {
  findConfigFile,
  loadConfig,
  resolveAuth,
  type AuthSource,
  type ResolvedAuth,
} from "../../../config.js"
import type { LoreConfig } from "../../../types.js"
import {
  ntnEnvBaseUrl,
  ntnEnvFromBaseUrl,
  resolveOperatorBaseUrl,
  verifyVaultAccess,
} from "../../../auth/oauth.js"
import {
  checkNtnVersion,
  getNtnVersion,
  installNtn,
  isNtnInstalled,
  MIN_NTN_VERSION,
  type NtnEnv,
  NTN_MANUAL_INSTALL_COMMAND,
  NTN_VERIFIED_INSTALL_DESCRIPTION,
  parseNtnEnv,
  runNtnLogin,
} from "../../../auth/ntn.js"
import type { InstallContext } from "./types.js"
import { detectYarnPnp, resolvePkgRoot } from "./env.js"
import { displayHomePath, fileExists, readJsonSafe, readTextSafe } from "./utils.js"
import { assertTomlSupportsLoreRewrite } from "./toml.js"

async function readWakeUpConfig(projectDir: string): Promise<boolean | null> {
  const found = await findConfigFile(projectDir)
  if (!found) return null
  try {
    const config = await loadConfig(found.path)
    return config.hooks?.wakeUp ?? null
  } catch (err) {
    const displayPath = displayHomePath(found.path)
    process.stderr.write(
      `[lore] Could not read hooks.wakeUp from ${displayPath}: ${err instanceof Error ? err.message : err}\n` +
        `[lore] Installer status may not reflect hooks.wakeUp — fix the config and re-run 'lore install'.\n`
    )
    return null
  }
}

export function wakeupStatusSuffix(wakeUpConfig: boolean | null): string {
  return wakeUpConfig === false ? " (disabled by config)" : ""
}

/**
 * Resolve the InstallContext threaded into every per-client runner.
 *
 * The seam this function pins:
 *
 * - `opts.project` → `projectDir` via `resolve()` (relative paths
 *   land against `process.cwd()` at call time).
 * - `projectDir` → `yarnPnp` via the priority chain documented on
 *   the field: `legacyPaths` forces false; an explicit
 *   `opts.yarnPnp` override (true OR false) wins over auto-detect;
 *   otherwise `detectYarnPnp(projectDir)` walks upward for a
 *   `.pnp.cjs` / `.pnp.loader.mjs` marker.
 *
 * Exported for integration tests that pin the full pipe (project
 * arg → upward `.pnp.cjs` walk → runner-bound `yarnPnp`).
 * Production callers go through `runInstall`.
 */
export async function prepareInstallContext(opts: {
  yes?: boolean
  project?: string
  legacyPaths?: boolean
  yarnPnp?: boolean
}): Promise<InstallContext> {
  const projectDir = resolve(opts.project ?? process.cwd())
  const pkgRoot = resolvePkgRoot()
  const skipPrompts = opts.yes || !process.stdin.isTTY
  const legacyPaths = !!opts.legacyPaths
  // PnP auto-detection runs only on the bin-dispatch path. Under
  // legacy absolute-path mode the absolute-path shape doesn't depend on PATH
  // resolution at all, so the question is moot. An explicit
  // `opts.yarnPnp` override (true OR false) wins over auto-detection
  // — set via `--yarn-pnp` / `--no-yarn-pnp` so an operator can pin
  // either shape regardless of what the marker file says.
  const yarnPnp = legacyPaths
    ? false
    : opts.yarnPnp !== undefined
      ? opts.yarnPnp
      : await detectYarnPnp(projectDir)

  const autosavePath = join(pkgRoot, "hooks", "autosave.sh")
  const wakeupPath = join(pkgRoot, "hooks", "wakeup.sh")
  const mcpJsPath = join(pkgRoot, "dist", "mcp.js")

  // Sanity check that the package was built. The bin-dispatch path
  // launches the MCP server via lazy-import from the CLI bundle (which
  // tsup also produces in the same `npm run build`); the legacy path
  // invokes the standalone MCP entry directly. Either entry's
  // existence proves the build ran, so the existing standalone MCP
  // entry check remains the tripwire — checking the legacy entry is
  // harmless on the default path because both files ship together.
  if (!(await fileExists(mcpJsPath))) {
    console.error("Required file not found:")
    console.error("  dist/mcp.js")
    console.error()
    console.error("Run 'npm run build' first.")
    process.exit(1)
  }

  const wakeUpConfig = await readWakeUpConfig(projectDir)
  const found = await findConfigFile(projectDir)
  const configRoot = found?.root ?? projectDir

  return {
    projectDir,
    pkgRoot,
    configRoot,
    autosavePath,
    wakeupPath,
    mcpJsPath,
    skipPrompts,
    wakeUpConfig,
    legacyPaths,
    yarnPnp,
  }
}

/**
 * Verify that the hook scripts Claude / Codex install registrations point
 * at exist on disk and are executable. Throws when a hook script is
 * missing so the failure surfaces through the per-client captured-error
 * path under `--client all`. Idempotent — safe for both Claude and Codex
 * runners to call (the chmod is a no-op once the bits are set).
 *
 * No-op on the bin-dispatch default path (`context.legacyPaths === false`)
 * because the bin-dispatch shape doesn't depend on `hooks/*.sh` — the
 * `lore` bin owns the hook entry points directly. Only the
 * legacy absolute-path mode opt-in path needs the .sh prerequisites verified.
 *
 * Cursor's runner does NOT call this — Cursor doesn't currently support
 * session-end / Stop hooks, so the hook scripts are irrelevant for that
 * branch regardless of the install shape.
 */
export async function ensureHookPrerequisites(context: InstallContext): Promise<void> {
  if (!context.legacyPaths) return
  const [hasAutosave, hasWakeup] = await Promise.all([
    fileExists(context.autosavePath),
    fileExists(context.wakeupPath),
  ])
  if (!hasAutosave || !hasWakeup) {
    const missing: string[] = []
    if (!hasAutosave) missing.push("hooks/autosave.sh")
    if (!hasWakeup) missing.push("hooks/wakeup.sh")
    throw new Error(
      `Required hook scripts not found: ${missing.join(", ")}. Run 'npm run build' first.`
    )
  }
  await Promise.all([
    chmod(context.autosavePath, 0o755),
    chmod(context.wakeupPath, 0o755),
  ])
}

/**
 * Display name for a `ResolvedAuth.source` discriminator.
 *
 * Local to install.ts even though `--status` emits a similar
 * line — the two surfaces evolve separately and consolidation can
 * happen later if their wording converges.
 */
function describeAuthSource(source: AuthSource): string {
  switch (source) {
    case "env-notion-api-token":
      return "NOTION_API_TOKEN (env)"
    case "ntn-auth-json":
      return "ntn-issued (auth.json)"
  }
}

/**
 * `[Y/n]`-style confirmation prompt with non-interactive guard.
 *
 * Returns `false` and prints non-interactive guidance when stdin is
 * not a TTY — callers are expected to skip the action and surface a
 * `--yes` recommendation. Empty input accepts the default (yes); any
 * trimmed answer starting with `n` declines.
 *
 * Each call opens and closes its own readline interface so the
 * prompt is independent of any rl the install action manages for
 * its per-runner confirmations.
 */
async function confirmPrompt(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error(
      "Non-interactive context detected. Pass --yes to confirm prompts non-interactively."
    )
    return false
  }
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const answer = await rl.question(message)
    const normalized = answer.trim().toLowerCase()
    if (normalized === "") return true
    return !normalized.startsWith("n")
  } finally {
    rl.close()
  }
}

interface EnsurePrerequisitesOptions {
  yes?: boolean
  /**
   * Explicit opt-in to the internal-engineer `ntn` path. When true,
   * `ensurePrerequisites` auto-installs `ntn` (if missing) and runs
   * `ntn login`. When false (the default), Lore takes the
   * external-operator path: expect `NOTION_API_TOKEN` to be set
   * (PAT pasted from `notion.so/developers/tokens`) and skip `ntn`
   * entirely. Backed by the `--ntn` flag on the install command.
   *
   * When `--ntn` is NOT set AND `NOTION_API_TOKEN` is NOT set AND
   * `ntn` is already installed, the install path treats that as
   * "looks like an internal engineer" and proceeds with the ntn
   * flow without auto-installing. This preserves backward
   * compatibility for engineers who upgraded Lore without changing
   * their habits. The auto-install branch ONLY fires when `--ntn`
   * is explicitly set.
   */
  ntn?: boolean
  /**
   * Target the Notion dev environment. Composes with `ntn: true`
   * (forwards `NOTION_ENV=dev` to the `ntn login` spawn) and with
   * the PAT path (the external operator is expected to have pasted
   * a `development_ntn_…` token; the install surfaces dev-PAT
   * guidance and routes vault preflight through the dev base URL).
   * Backed by the `--dev` flag on the install command.
   */
  dev?: boolean
}

interface NtnLoginRecovery {
  /**
   * Paste-ready shell command. The full prefix
   * (`NOTION_KEYRING=0`) is always present so the resulting token
   * lands in auth.json (file mode) rather than the macOS keychain
   * — Lore can't read the keychain, so a recovery command without
   * the env-var prefix would write to a place Lore can't see.
   *
   * `NOTION_ENV=<value>` is included when the env can be resolved
   * (operator's shell or .lore.yaml's `auth.baseUrl` mapped to a
   * canonical env). When the operator must pick the env themselves
   * (non-canonical baseUrl), the literal string `<env>` appears in
   * the command and `manualEnvNote` carries the explanation.
   */
  command: string
  /**
   * Optional one-line note explaining the env source so the
   * operator pasting the command knows whether they need to
   * substitute anything. `undefined` for the canonical / prod
   * default cases; populated for inferred-from-config and
   * non-canonical cases.
   */
  manualEnvNote?: string
}

/**
 * Build the paste-ready ntn-login recovery command for the current
 * project + operator-env state. Three cases:
 *
 *   1. **Operator `NOTION_ENV` set** → use it verbatim. Explicit
 *      shell choice always wins.
 *   2. **.lore.yaml's `auth.baseUrl` is canonical** → infer env
 *      via `ntnEnvFromBaseUrl` and bake it into the command. The
 *      `manualEnvNote` records the inference source so the operator
 *      sees which signal Lore picked up.
 *   3. **`auth.baseUrl` is non-canonical** (corporate proxy, etc.)
 *      → emit `NOTION_ENV=<env>` literal placeholder and direct the
 *      operator to pick the right env for their workspace.
 *   4. **No signal** (no `NOTION_ENV`, no `auth.baseUrl`) → bare
 *      `NOTION_KEYRING=0 ntn login`. ntn defaults to prod; that's
 *      the right call when nothing in config or shell disagrees.
 *
 * The `NOTION_KEYRING=0` prefix is always emitted — without it the
 * resulting token lands in the macOS keychain (ntn's default on
 * darwin), which Lore can't read. Bare `ntn login` is the direct
 * cause of the "I logged in, why doesn't Lore see my token?"
 * footgun documented in the runbook.
 */
export function ntnLoginRecovery(
  config: LoreConfig | undefined,
  envSource: NodeJS.ProcessEnv = process.env
): NtnLoginRecovery {
  const operatorEnv = envSource["NOTION_ENV"]
  if (operatorEnv) {
    return {
      command: `NOTION_KEYRING=0 NOTION_ENV=${operatorEnv} ntn login`,
    }
  }
  const baseUrl = config?.auth?.baseUrl
  if (baseUrl) {
    const inferred = ntnEnvFromBaseUrl(baseUrl)
    if (inferred) {
      return {
        command: `NOTION_KEYRING=0 NOTION_ENV=${inferred} ntn login`,
        manualEnvNote: `(${inferred} env inferred from .lore.yaml auth.baseUrl)`,
      }
    }
    return {
      command: "NOTION_KEYRING=0 NOTION_ENV=<env> ntn login",
      manualEnvNote: `(.lore.yaml auth.baseUrl=${baseUrl} doesn't match a canonical ntn env — substitute <env> with the right selector for your workspace)`,
    }
  }
  return { command: "NOTION_KEYRING=0 ntn login" }
}

/**
 * Build a human-readable summary of the Notion environment the spawned
 * MCP child will actually resolve to at startup. Driven by the
 * resolved `ResolvedAuth` because that struct's `baseUrl` IS the
 * runtime source of truth — it's the value `createClient` consumes —
 * and `resolveAuth` intentionally branches by auth source so canonical
 * paths (`env-notion-api-token`, `ntn-auth-json`) ignore `.lore.yaml
 * auth.baseUrl` for security. .lore.yaml is local-only, but it's
 * still persistent file state (backed up, synced, pasteable, one
 * `git add -f` away from history), so it's less trusted than
 * operator-controlled env vars — a malicious .lore.yaml carrying
 * `auth.baseUrl: https://attacker.example` could otherwise redirect a
 * bearer token. `resolveAuth` carries the security contract.
 *
 * The annotation names where the resolved value came from so an
 * operator who forgot they had `LORE_NOTION_BASE_URL` set, or who has
 * a stale ntn config.json env, can see it at install time:
 *
 *   - shell env wins for all auth sources (operator-controlled).
 *   - `ntn-auth-json` otherwise consults ntn's
 *     ~/.config/notion/config.json (`undefined` baseUrl == prod,
 *     the SDK default; `resolveNtnBaseUrl` is the helper).
 *   - `env-notion-api-token`: shell-only; `undefined` baseUrl == prod.
 * Always returns a line on the auth-resolved branch — operators
 * benefit from "yes, this is targeting prod" being explicit even on
 * the silent-default case. The previous shell-env-only display
 * suppressed the line whenever no shell var was set, which silenced
 * exactly the `.lore.yaml auth.baseUrl` ↔ ntn-config.json mismatch
 * footgun this surface exists to prevent.
 */
function describeNtnEnvSelectors(
  auth: ResolvedAuth,
  envSource: NodeJS.ProcessEnv = process.env
): string {
  const baseUrl = auth.baseUrl
  const env = baseUrl ? ntnEnvFromBaseUrl(baseUrl) : "prod"
  const annotation = describeBaseUrlSource(auth, envSource, baseUrl)
  if (env) return `${env} ${annotation}`
  return `${baseUrl} ${annotation}, non-canonical`
}

/**
 * Annotate where `auth.baseUrl` came from for the
 * `Notion environment:` display. Walks the same priority order as
 * `resolveOperatorBaseUrl` for shell vars, then falls back to
 * auth-source-specific knowledge: ntn-auth-json reads ntn's
 * config.json; env tokens consult shell only. Pure presentation — no
 * further resolution work happens here.
 */
function describeBaseUrlSource(
  auth: ResolvedAuth,
  envSource: NodeJS.ProcessEnv,
  resolvedBaseUrl: string | undefined
): string {
  for (const key of [
    "LORE_NOTION_BASE_URL",
    "NOTION_BASE_URL",
    "NOTION_API_BASE_URL",
  ] as const) {
    if (envSource[key]) return `(from shell ${key})`
  }
  // `NOTION_ENV` only feeds `resolveOperatorBaseUrl` when
  // `ntnEnvBaseUrl` recognizes it (`prod`/`dev`/`stg`). An unrecognized
  // value (typo, retired env name) returns `undefined` from
  // `parseNtnEnv` and does NOT drive runtime baseUrl — annotating the
  // line with it would falsely attribute the resolved value to a
  // shell var that didn't take effect. Fall through to the
  // auth-source-specific annotation in that case.
  const notionEnv = envSource["NOTION_ENV"]
  if (notionEnv && parseNtnEnv(notionEnv) !== null) {
    return `(from shell NOTION_ENV=${notionEnv})`
  }

  switch (auth.source) {
    case "ntn-auth-json":
      return resolvedBaseUrl
        ? "(from ntn config.json)"
        : "(ntn default; no shell or ntn config.json override)"
    case "env-notion-api-token":
      return "(default; no shell base-URL override)"
  }
}

/**
 * Detect the silent footgun where `.lore.yaml auth.baseUrl` declares a
 * Notion deployment that the resolved canonical auth source
 * intentionally ignores, and the declared target disagrees with the
 * runtime resolution. Returns a multi-line warning the caller surfaces
 * under the `Notion environment:` line, or `undefined` when no
 * mismatch.
 *
 * Concrete scenario: operator pins `auth.baseUrl: <dev URL>` in
 * .lore.yaml, runs `ntn login` with the prod default (no
 * `NOTION_ENV=dev`), the canonical security contract drops the repo
 * config (`resolveAuth` enforces the drop), and every Notion call
 * goes to prod with a confusing "vault not accessible" trail.
 * Surfacing the mismatch
 * names the actionable next step.
 *
 * Suppressed when:
 *   - The auth source is a legacy path — `auth.baseUrl` already wins
 *     there by construction, no mismatch is possible.
 *   - The operator's shell has any base-URL or `NOTION_ENV` override
 *     set — they're explicitly steering the runtime, this is not a
 *     silent footgun.
 *   - The declared and resolved baseUrls map to the same canonical
 *     env (e.g., `https://api.notion.com` alias for prod).
 */
function describeAuthBaseUrlConfigMismatch(
  auth: ResolvedAuth,
  config: LoreConfig | undefined,
  envSource: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (auth.source !== "ntn-auth-json" && auth.source !== "env-notion-api-token") {
    return undefined
  }
  const configBaseUrl = config?.auth?.baseUrl
  if (!configBaseUrl) return undefined
  if (
    envSource["LORE_NOTION_BASE_URL"] ||
    envSource["NOTION_BASE_URL"] ||
    envSource["NOTION_API_BASE_URL"]
  ) {
    return undefined
  }
  // `NOTION_ENV` suppresses the warning only when it parses to a
  // recognized env. An unparseable value (e.g., a typo like
  // `NOTION_ENV=devv`) does NOT drive `resolveOperatorBaseUrl`, so
  // the silent-footgun configuration this warning exists to surface
  // is still in play — keep it eligible.
  const notionEnv = envSource["NOTION_ENV"]
  if (notionEnv && parseNtnEnv(notionEnv) !== null) return undefined
  const resolvedEnv = auth.baseUrl ? ntnEnvFromBaseUrl(auth.baseUrl) : "prod"
  const configEnv = ntnEnvFromBaseUrl(configBaseUrl)
  if (resolvedEnv && configEnv && resolvedEnv === configEnv) return undefined

  const declared = configEnv ?? configBaseUrl
  const resolved = resolvedEnv ?? auth.baseUrl ?? "prod"
  const sourceHint =
    auth.source === "ntn-auth-json"
      ? "ntn's config.json"
      : "the NOTION_API_TOKEN environment"
  return [
    `.lore.yaml declares auth.baseUrl=${declared} but resolved auth targets ${resolved}.`,
    `Repo-controlled auth.baseUrl is ignored on canonical sources for security; runtime`,
    `consults ${sourceHint}. To target ${declared}, set NOTION_ENV in your shell or run`,
    `\`ntn login\` against the right env.`,
  ].join(" ")
}

function printPatIntegrationTokenPreflightHint(): void {
  console.error("    The token shape is `secret_…` — an integration token from")
  console.error("    notion.so/profile/integrations, NOT a PAT. This is almost")
  console.error("    certainly the cause of the preflight failure.")
  console.error("    Rotate to a PAT from notion.so/developers/tokens for per-user")
  console.error("    isolation and personal-permission inheritance.")
  console.error("")
}

/**
 * Audit prerequisites for `lore install` and remediate when the
 * operator opts in.
 *
 * Three probes:
 *   1. **ntn installed**: probes via `isNtnInstalled` (memoized
 *      `execFileSync ntn --version`). On miss, offers
 *      `installNtn()` (verified release archive with Lore-pinned
 *      sha256); operator must confirm explicitly.
 *   2. **ntn version**: non-blocking warning when
 *      `checkNtnVersion()` returns `"too-old"`. Lore never
 *      auto-upgrades — operators pin ntn versions for other tooling
 *      and we don't override that.
 *   3. **Auth source**: runs `resolveAuth(config, configRoot)` and
 *      reports the resolved source. On no-source-resolved, offers
 *      `runNtnLogin()` (which forces `NOTION_KEYRING=0` inside its
 *      own spawn so auth.json lands in file mode); operator
 *      confirms.
 *
 * Post-resolution preflight: when auth resolves AND .lore.yaml
 * exists, runs `verifyVaultAccess` against the configured vault
 * page. A `not-found` flips `ready` to false so the install action
 * exits without writing MCP config — engineers running `lore
 * install` and seeing a success message followed by a working
 * assistant connection is the seamless-onboarding promise; a
 * preflight failure that lands MCP config anyway breaks that
 * promise. `unknown-error` (transient 5xx) is logged but lets the
 * install proceed.
 *
 * `--yes` auto-confirms every prompt; non-TTY context with no
 * `--yes` returns `ready: false` and prints non-interactive
 * guidance.
 *
 * `runNtnLogin()` and `installNtn()` force
 * `NOTION_KEYRING=0` inside their own spawn env, so the operator
 * never has to set the env var themselves for the install path.
 * Operators who later run `ntn login` directly (outside Lore)
 * without the env var hit ntn's keychain default — the operator
 * runbook documents this gotcha.
 */
/**
 * Name the specific shell variable that conflicts with `--dev` so the
 * fail-fast error tells the operator exactly which one to unset.
 * Walks `resolveOperatorBaseUrl`'s priority chain — first match wins —
 * so the message matches the variable Lore would actually have used
 * for auth resolution.
 */
export function describeConflictingDevSignal(env: NodeJS.ProcessEnv): string {
  if (env["LORE_NOTION_BASE_URL"]) {
    return `LORE_NOTION_BASE_URL=${env["LORE_NOTION_BASE_URL"]}`
  }
  if (env["NOTION_BASE_URL"]) {
    return `NOTION_BASE_URL=${env["NOTION_BASE_URL"]}`
  }
  if (env["NOTION_API_BASE_URL"]) {
    return `NOTION_API_BASE_URL=${env["NOTION_API_BASE_URL"]}`
  }
  if (env["NOTION_ENV"]) {
    return `NOTION_ENV=${env["NOTION_ENV"]}`
  }
  // Defensive — caller gates on `resolveOperatorBaseUrl(env) !== undefined`
  // so one of the four MUST be set when this helper is called.
  return "an operator-set base URL signal"
}

/**
 * External-operator (PAT) install path. Loads config, runs
 * `resolveAuth` (which picks up `NOTION_API_TOKEN` since the caller
 * already verified the env var is set), surfaces the describe lines
 * the ntn path also emits, and runs `preflightAndReport`.
 *
 * On auth-resolution failure (for example, `.lore.yaml` carrying the
 * removed `auth.token` field or a Zod validation error elsewhere in
 * the config), prints PAT-specific recovery guidance.
 *
 * Does NOT call `installNtn()` or `runNtnLogin()` — the PAT path
 * intentionally never touches `ntn`.
 */
async function resolveAndPreflight(
  context: InstallContext,
  opts: EnsurePrerequisitesOptions
): Promise<{ ready: boolean; authSource?: AuthSource }> {
  const found = await findConfigFile(context.projectDir)
  let config: LoreConfig | undefined
  if (found) {
    config = await loadConfig(found.path)
  }

  // `--dev` install-time effectiveness for the PAT path: when no
  // base-URL signal is present in the operator's shell, plant
  // `NOTION_BASE_URL` so `resolveAuth` + `verifyVaultAccess` target
  // dev. This mutation survives the install lifetime (so subsequent
  // `buildMcpEnv` calls also see it) but only fills the gap when no
  // explicit signal is already present — we never override an
  // operator's existing choice.
  if (opts.dev && !resolveOperatorBaseUrl(process.env)) {
    process.env["NOTION_BASE_URL"] = ntnEnvBaseUrl("dev")
  }

  let auth: ResolvedAuth | undefined
  try {
    auth = await resolveAuth(config, found?.root ?? context.configRoot)
  } catch (err) {
    console.error("")
    console.error(
      `    Auth resolution failed: ${err instanceof Error ? err.message : String(err)}`
    )
    console.error("")
    console.error("    NOTION_API_TOKEN is set in your environment but Lore could not")
    console.error("    resolve it. The most common cause is an `auth.token` field in")
    console.error("    .lore.yaml; Lore rejects every auth.token value. Remove it and")
    console.error("    re-run `lore install`.")
    return { ready: false }
  }

  if (!auth) {
    console.error("")
    console.error("    NOTION_API_TOKEN is set but did not resolve to a usable auth.")
    console.error("    Confirm the value is a Notion bearer token, then re-run.")
    return { ready: false }
  }

  console.log(`  Notion environment:   ${describeNtnEnvSelectors(auth)}`)
  const mismatch = describeAuthBaseUrlConfigMismatch(auth, config)
  if (mismatch) {
    console.log(`                        ! ${mismatch}`)
  }
  console.log(`  Auth source:          ✓ ${describeAuthSource(auth.source)}`)

  // PAT-shape sanity hint. The PAT path accepts any bearer Notion
  // recognizes, but pasting a `secret_…` integration token from
  // `notion.so/profile/integrations` re-collapses the team into a
  // shared rate-limit bucket — exactly the failure mode the
  // 2026-05-13 PAT announcement asks Lore to surface clearly. The
  // hint is informational, not blocking; `verifyVaultAccess` runs
  // either way.
  if (auth.token.startsWith("secret_")) {
    console.log(
      "                          ! Token shape is `secret_…` (integration token from notion.so/profile/integrations)."
    )
    console.log(
      "                          Integration tokens are integration-level rate-limited, which"
    )
    console.log(
      "                          re-collapses Lore into one shared bucket. Rotate to a PAT"
    )
    console.log("                          from https://www.notion.so/developers/tokens.")
  }

  // No `--dev` mismatch advisory here: the fail-fast at the top of
  // `ensurePrerequisites` already aborts when `--dev` conflicts with
  // a shell-set base-URL signal. By the time we reach this point,
  // either no operator signal exists (planting above filled in dev)
  // or the operator's signal resolves to dev — both consistent with
  // `--dev`. A second advisory would be unreachable noise.

  return await preflightAndReport(auth, found, config)
}

export async function ensurePrerequisites(
  context: InstallContext,
  opts: EnsurePrerequisitesOptions = {}
): Promise<{ ready: boolean; authSource?: AuthSource }> {
  console.log("Checking prerequisites...")

  // `--dev` ↔ shell-signal conflict guard.
  //
  // When `--dev` is passed AND the operator's shell already carries
  // a base-URL signal that does NOT resolve to dev, abort before
  // preflight. The alternative — letting one signal win silently —
  // breaks the install contract: `resolveAndPreflight` plants
  // `NOTION_BASE_URL=dev` only when no shell signal exists, but
  // `runInstall` always writes a literal dev `NOTION_BASE_URL` into
  // MCP env when `--dev` is set, so preflight could verify prod
  // while the install lands dev MCP config. Worse, the
  // `${LORE_NOTION_BASE_URL}` placeholder forwarded into MCP env
  // outranks the literal `NOTION_BASE_URL` in
  // `resolveOperatorBaseUrl`'s priority chain — so an operator with
  // `LORE_NOTION_BASE_URL=prod` in their shell would silently keep
  // hitting prod at MCP-spawn time despite the `--dev` install.
  //
  // The fail-fast posture matches the principle Lore uses
  // elsewhere: when explicit signals conflict, the operator picks
  // which one is real, not Lore. Two clean recoveries: unset the
  // shell signal, or drop `--dev`.
  if (opts.dev) {
    const operatorBaseUrl = resolveOperatorBaseUrl(process.env)
    if (operatorBaseUrl !== undefined && ntnEnvFromBaseUrl(operatorBaseUrl) !== "dev") {
      const conflicting = describeConflictingDevSignal(process.env)
      console.log(`  --dev:                ✗ conflicts with operator-set base URL`)
      console.error("")
      console.error(
        `    --dev was passed but ${conflicting} routes auth to ${operatorBaseUrl}`
      )
      console.error(
        "    (not the dev base URL). Lore cannot install a coherent --dev MCP"
      )
      console.error(
        "    config while the shell carries a conflicting signal — preflight would"
      )
      console.error("    verify one base URL and the MCP child would read another.")
      console.error("")
      console.error("    Recovery (pick one):")
      console.error(
        "      1. Unset the conflicting shell variable, then re-run `lore install --dev`."
      )
      console.error("      2. Drop --dev and re-run `lore install` to target prod.")
      return { ready: false }
    }
  }

  // Persona routing. External operators are first-class: `lore install`
  // does not auto-install `ntn` by default. Three branches:
  //
  //   - `--ntn` explicitly set: internal-engineer path; auto-install
  //     `ntn` on miss, run `ntn login`.
  //   - `NOTION_API_TOKEN` is set: external-operator path; skip `ntn`
  //     entirely, resolve auth from env, verify and proceed.
  //   - Neither flag nor env: if `ntn` is already installed, fall
  //     through to the ntn path (backward compat for internal engineers
  //     who upgraded Lore without changing their habits). If `ntn` is
  //     NOT installed, surface persona-aware guidance and bail.
  //
  // `--dev` overlays on either branch:
  //   - With `--ntn`: forwarded to `ntn login` as `NOTION_ENV=dev`.
  //   - With the PAT path: surfaces `development_ntn_` guidance and
  //     resolves the dev base URL via the existing `NOTION_ENV` /
  //     `auth.baseUrl` chain in `resolveOperatorBaseUrl`.
  const ntnInstalled = isNtnInstalled()
  const patEnv = process.env["NOTION_API_TOKEN"]
  const personaIsExternal = !opts.ntn && (patEnv !== undefined || !ntnInstalled)

  if (personaIsExternal && !patEnv && !opts.ntn) {
    // No PAT, no `--ntn`, and `ntn` is not installed. The operator
    // either intended internal but forgot `--ntn`, or intended
    // external but hasn't pasted a PAT yet. Show both paths and
    // exit; the next invocation carries enough state to dispatch.
    console.log(`  ntn installed:        ✗`)
    console.log(`  NOTION_API_TOKEN:     ✗ not set`)
    console.log("")
    console.log("    Lore needs a Notion bearer token. Two supported paths:")
    console.log("")
    console.log("    Internal Notion engineer? Re-run with --ntn:")
    console.log(`        lore install --ntn${opts.dev ? " --dev" : ""}`)
    console.log("      Lore will install `ntn`, run `ntn login`, and write MCP config.")
    console.log("")
    console.log("    External operator? Create a Personal Access Token at")
    console.log("      https://www.notion.so/developers/tokens")
    console.log("      then export it and re-run `lore install`:")
    console.log("")
    console.log(
      `        export NOTION_API_TOKEN="${opts.dev ? "development_ntn_" : "ntn_"}..."`
    )
    console.log(`        lore install${opts.dev ? " --dev" : ""}`)
    console.log("")
    console.log(
      "    Do NOT paste an integration token from notion.so/profile/integrations —"
    )
    console.log(
      "    those are integration-level rate-limited and re-collapse Lore into one"
    )
    console.log("    shared bucket. See docs/authentication.md for the full contract.")
    return { ready: false }
  }

  if (personaIsExternal) {
    // PAT path — `NOTION_API_TOKEN` is set. Skip `ntn` install /
    // version probes entirely; `resolveAuth` will pick up the env
    // token and `preflightAndReport` runs the vault probe. The PAT
    // path doesn't need `ntn` at all.
    console.log(`  Auth path:            ✓ Personal Access Token (NOTION_API_TOKEN)`)
    return await resolveAndPreflight(context, opts)
  }

  // `--ntn` shadow advisory. When the operator explicitly requests
  // the ntn path AND `NOTION_API_TOKEN` is set in their shell, the
  // resolver chain (`NOTION_API_TOKEN > ntn`) means the spawned MCP
  // child will use the PAT — not the freshly-minted ntn token —
  // for every Lore call after the install. Name the outcome
  // concretely so the operator can spot the silent shadow without
  // reading the docs. Symmetric to `formatUnsetInstructions`'s
  // `notionApiTokenActive` reassurance footer.
  if (opts.ntn && patEnv !== undefined) {
    console.log(`  NOTION_API_TOKEN:     ! set in shell — outranks ntn`)
    console.log("")
    console.log(
      "    Per the resolver chain (NOTION_API_TOKEN > ntn-auth-json), the spawned"
    )
    console.log(
      "    MCP child will use NOTION_API_TOKEN even though --ntn just ran `ntn login`."
    )
    console.log("    If you intended ntn to be active, also run:")
    console.log("")
    console.log("        unset NOTION_API_TOKEN")
    console.log("")
    console.log(
      "    and remove the export from your shell rc. If NOTION_API_TOKEN is the"
    )
    console.log("    PAT you want Lore to use, drop --ntn instead — `lore install` will")
    console.log("    skip ntn entirely.")
    console.log("")
  }

  // 1. ntn install state. Offer auto-install on miss. The local
  // does not need to be reassigned post-install — the version check
  // below calls `getNtnVersion` directly (which probes via the same
  // memoized `execFileSync` and reflects the freshly installed
  // binary after `installNtn` clears the cache on success).
  console.log(`  ntn installed:        ${ntnInstalled ? "✓" : "✗"}`)
  if (!ntnInstalled) {
    console.log("")
    console.log("    ntn is required for the --ntn install path.")
    console.log("    Lore can install it using a verified release archive:")
    console.log(`      ${NTN_VERIFIED_INSTALL_DESCRIPTION}`)
    console.log("")
    const ok = opts.yes ?? (await confirmPrompt("    Install ntn now? [Y/n] "))
    if (!ok) {
      console.log("    Skipping install. Re-run after installing ntn manually:")
      console.log(`      ${NTN_MANUAL_INSTALL_COMMAND}`)
      return { ready: false }
    }
    const installResult = await installNtn()
    if (installResult.kind !== "success") {
      console.error("    ntn install failed.")
      console.error("    Check your network and shell, then re-run `lore install`.")
      return { ready: false }
    }
    console.log("    ✓ ntn installed.")
  }

  // 2. Version check (non-blocking warning).
  const versionStatus = checkNtnVersion()
  const installedVersion = getNtnVersion()
  if (versionStatus === "too-old") {
    console.log(
      `  ntn version:          ! ${installedVersion ?? "unknown"} (below tested minimum ${MIN_NTN_VERSION})`
    )
    console.log("    Lore will proceed, but consider running `ntn update` if you")
    console.log("    hit auth resolution issues.")
  } else if (versionStatus === "ok") {
    console.log(`  ntn version:          ✓ ${installedVersion ?? "unknown"}`)
  }

  // 3. Auth resolution. Offer ntn login on no-source-resolved.
  //
  // The catch around `resolveAuth` is narrow on purpose: a malformed
  // .lore.yaml is a different problem from "no auth token", and
  // offering ntn login won't fix Zod validation errors. So
  // `loadConfig` runs OUTSIDE the catch — its errors bubble up to
  // the install action's outer catch, which renders them via
  // `Install failed:`. Only `resolveAuth`'s no-token-resolved throw
  // routes into the offer-login branch.
  const found = await findConfigFile(context.projectDir)
  let config: LoreConfig | undefined
  if (found) {
    config = await loadConfig(found.path)
  }

  let auth: ResolvedAuth | undefined
  try {
    auth = await resolveAuth(config, found?.root ?? context.configRoot)
  } catch {
    // Auth resolution failed — fall through to the offer-login branch.
  }

  if (auth) {
    // Surface the runtime Notion environment so dev / staging operators
    // see which deployment their install will land on. Driven by
    // `auth.baseUrl` because that's what the spawned MCP child will
    // actually use; canonical auth sources intentionally ignore
    // `.lore.yaml auth.baseUrl` for security so deriving from config
    // would lie on exactly the configurations this surface most needs
    // to be honest about. The mismatch warning catches the silent
    // footgun where a project pins `auth.baseUrl: <dev URL>` but
    // canonical auth resolved against prod.
    console.log(`  Notion environment:   ${describeNtnEnvSelectors(auth)}`)
    const mismatch = describeAuthBaseUrlConfigMismatch(auth, config)
    if (mismatch) {
      console.log(`                        ! ${mismatch}`)
    }
    console.log(`  Auth source:          ✓ ${describeAuthSource(auth.source)}`)
    return await preflightAndReport(auth, found, config)
  }

  // No auth resolved — derive the ntn-login env target before
  // offering. Priority: explicit `--dev` flag wins; otherwise
  // operator's `NOTION_ENV` env var (if set in shell); otherwise
  // infer from .lore.yaml's `auth.baseUrl`. A non-canonical
  // `auth.baseUrl` (e.g., a corporate proxy) without `--dev` or an
  // explicit `NOTION_ENV` means we can't safely pick an ntn env —
  // refuse auto-login with a recovery message rather than mint a
  // prod token for what's almost certainly NOT a prod project.
  // Without this gate, `lore install -y` against a project whose
  // `auth.baseUrl: https://api-dev.notion.com` would mint a prod
  // token and fall into the generic vault-not-accessible path —
  // exactly the dev-onboarding footgun this gate exists to prevent.
  const operatorEnv = process.env["NOTION_ENV"]
  const operatorEnvParsed = parseNtnEnv(operatorEnv)
  let resolvedNtnEnv: NtnEnv | undefined
  let resolvedNtnEnvSource: "cli-flag" | "operator-env" | "config-baseurl" | "default" =
    "default"
  if (opts.dev) {
    // `--dev` is the most explicit signal — wins over both env vars
    // and .lore.yaml's `auth.baseUrl`. The operator typed it just
    // now, so honoring it preserves the principle that the most
    // recent explicit operator intent wins.
    resolvedNtnEnv = "dev"
    resolvedNtnEnvSource = "cli-flag"
  } else if (operatorEnv) {
    if (operatorEnvParsed === null) {
      // Operator's shell carries `NOTION_ENV=<garbage>`. Refuse to
      // forward it to ntn — bare ntn would also reject, but Lore can
      // surface a clearer message at the install seam.
      console.log("  Auth source:          ✗ no token resolved")
      console.error("")
      console.error(`    NOTION_ENV=${operatorEnv} is not a recognized ntn environment.`)
      console.error("    Expected one of: prod, dev, stg.")
      console.error("")
      console.error(
        "    Recovery: unset or correct NOTION_ENV in your shell, then re-run"
      )
      console.error("    `lore install`.")
      return { ready: false }
    }
    resolvedNtnEnv = operatorEnvParsed
    resolvedNtnEnvSource = "operator-env"
  } else if (config?.auth?.baseUrl) {
    const inferred = ntnEnvFromBaseUrl(config.auth.baseUrl)
    if (inferred) {
      resolvedNtnEnv = inferred
      resolvedNtnEnvSource = "config-baseurl"
    } else {
      // Non-canonical baseUrl in config; can't infer env. Refuse to
      // auto-login since "default = prod" is almost certainly wrong
      // for a project whose config disagrees with prod.
      console.log("  Auth source:          ✗ no token resolved")
      console.error("")
      console.error(
        `    .lore.yaml carries auth.baseUrl=${config.auth.baseUrl}, which doesn't`
      )
      console.error(
        "    match a known ntn environment. Lore can't safely pick a `NOTION_ENV`"
      )
      console.error("    target for `ntn login` from this — minting a prod token for a")
      console.error(
        "    non-prod project would land you on the generic vault-not-accessible"
      )
      console.error("    error after install.")
      console.error("")
      console.error("    Recovery: run `NOTION_KEYRING=0 NOTION_ENV=<env> ntn login`")
      console.error("    directly with the right env")
      console.error("    selector for your workspace, then re-run `lore install`.")
      return { ready: false }
    }
  }

  console.log("  Auth source:          ✗ no token resolved")
  console.log("")
  if (resolvedNtnEnvSource === "cli-flag") {
    console.log(
      `    --dev was passed — Lore will pass NOTION_ENV=${resolvedNtnEnv} to ntn login so the`
    )
    console.log("    resulting token authorizes against the dev deployment.")
    console.log("")
  } else if (resolvedNtnEnvSource === "config-baseurl") {
    console.log(
      `    .lore.yaml's auth.baseUrl maps to ntn env "${resolvedNtnEnv}" — Lore will`
    )
    console.log(
      `    pass NOTION_ENV=${resolvedNtnEnv} to ntn login so the resulting token`
    )
    console.log("    authorizes against the right Notion deployment.")
    console.log("")
  } else if (resolvedNtnEnvSource === "operator-env") {
    console.log(
      `    Using NOTION_ENV=${resolvedNtnEnv} from your shell — ntn login will mint a`
    )
    console.log("    token for that environment.")
    console.log("")
  }
  console.log("    Lore needs a Notion bearer token. Lore can run `ntn login` for you")
  console.log("    now (handles `NOTION_KEYRING=0` inside the spawn so the resulting")
  console.log("    token lands in auth.json where Lore can read it).")
  console.log("")
  const promptLabel =
    resolvedNtnEnv && resolvedNtnEnvSource !== "operator-env"
      ? `    Run \`NOTION_KEYRING=0 NOTION_ENV=${resolvedNtnEnv} ntn login\` now? [Y/n] `
      : "    Run `NOTION_KEYRING=0 ntn login` now? [Y/n] "
  const okLogin = opts.yes ?? (await confirmPrompt(promptLabel))
  if (!okLogin) {
    // `lore auth --login` wraps this same flow with the version
    // probe and post-login preflight; the manual ntn invocation below
    // is the fallback. The `NOTION_KEYRING=0` prefix is required so
    // the token lands in auth.json (file mode) instead of the macOS
    // keychain.
    const manualEnvPrefix = resolvedNtnEnv ? `NOTION_ENV=${resolvedNtnEnv} ` : ""
    console.log(
      `    Skipping. Run \`NOTION_KEYRING=0 ${manualEnvPrefix}ntn login\` directly when you're`
    )
    console.log(
      "    ready, then re-run `lore install`. The env var prefix is required so"
    )
    console.log("    the token lands in auth.json (where Lore reads from) instead of the")
    console.log("    macOS keychain.")
    return { ready: false }
  }

  const loginResult = await runNtnLogin(resolvedNtnEnv ? { env: resolvedNtnEnv } : {})
  if (loginResult.kind !== "success") {
    console.error("    ntn login did not complete successfully.")
    if (loginResult.kind === "exit-non-zero") {
      console.error(`    ntn exited with code ${loginResult.code}`)
    }
    console.error("    Re-run `lore install` to retry.")
    return { ready: false }
  }
  console.log("    ✓ ntn login completed.")
  console.log("")

  // Re-resolve after login. The config file location is unchanged
  // (ntn login doesn't move .lore.yaml), so reuse the `config`
  // and `found` values from the pre-login lookup. Same narrow-catch
  // pattern as above — only `resolveAuth`'s no-token throw is
  // swallowed so we can fall through to the "still failed after
  // ntn login" diagnostic.
  try {
    auth = await resolveAuth(config, found?.root ?? context.configRoot)
  } catch {
    auth = undefined
  }
  if (auth) {
    console.log(`  Auth source:          ✓ ${describeAuthSource(auth.source)}`)
    return await preflightAndReport(auth, found, config)
  }

  console.error("    Auth resolution still failed after ntn login.")
  // `lore auth --status` is the diagnostic surface for the ntn-aware
  // path; the manual fallback is checking auth.json contents directly.
  console.error(
    "    Inspect `~/.config/notion/auth.json` to confirm a workspace token landed,"
  )
  console.error("    or re-run with `LORE_DEBUG=1` for verbose resolveAuth tracing.")
  return { ready: false }
}

/**
 * Run the post-resolution vault preflight (`verifyVaultAccess`)
 * and surface the result in install output. Gating policy is
 * per-failure-mode:
 *
 * - `ok` → install proceeds; prints `Vault page: ✓ <title>`.
 * - `not-found` → refuse to write MCP config. Most common cause:
 *   operator authenticated against the wrong workspace, or the vault
 *   page isn't shared with their identity.
 * - `unauthorized` (401/403) → refuse to write MCP config. Token is
 *   invalid/expired (401) or lacks permission for the page (403).
 *   Recovery is re-auth, NOT a wait-and-retry — landing MCP config
 *   here would put the operator one tool call away from a 401 they
 *   can't easily diagnose.
 * - `rate-limited` (429) → log a throttling warning and proceed.
 *   Plausibly transient under sustained traffic; install-time
 *   blocking would force the operator to retry the install instead
 *   of letting the rate-limit window pass.
 * - `unknown-error` (5xx, network) → log and proceed. Genuine
 *   transients shouldn't block onboarding; the next `lore`
 *   invocation will surface the issue clearly if it persists.
 *
 * Skips entirely when no .lore.yaml exists — auth resolved without
 * a vault config is unusual but acceptable (e.g., post-`lore install`
 * before `lore init`).
 */
async function preflightAndReport(
  auth: ResolvedAuth,
  found: { root: string; path: string } | null,
  config: LoreConfig | undefined
): Promise<{ ready: boolean; authSource?: AuthSource }> {
  if (!found || !config) {
    return { ready: true, authSource: auth.source }
  }

  const { createClient } = await import("../../../notion/client.js")
  const { createLimitedClient } = await import("../../../notion/rate-limit.js")
  const client = createLimitedClient(createClient(auth.token, auth.baseUrl))
  const result = await verifyVaultAccess(client, config.vault.pageId)

  if (result.kind === "ok") {
    console.log(`  Vault page:           ✓ ${result.pageTitle ?? config.vault.pageId}`)
    return { ready: true, authSource: auth.source }
  }

  // PAT-source (`env-notion-api-token`) vs ntn-source recovery copy
  // diverges. ntn-source operators recover via `ntn login`;
  // PAT-source operators recover by rotating their token at
  // `notion.so/developers/tokens`, sharing pages with their Notion
  // identity, or checking workspace membership. Telling a PAT
  // operator to "re-run ntn login" would be the wrong remediation
  // for the external-operator default path.
  const isPatSource = auth.source === "env-notion-api-token"
  const isIntegrationToken = isPatSource && auth.token.startsWith("secret_")

  if (result.kind === "not-found") {
    console.error(`  Vault page:           ✗ not accessible (${config.vault.pageId})`)
    console.error("")
    if (isPatSource) {
      if (isIntegrationToken) {
        printPatIntegrationTokenPreflightHint()
      }
      console.error("    Most likely causes for a PAT install:")
      console.error(
        "      1. The PAT was created against a different workspace than the vault."
      )
      console.error(
        "         Go to https://www.notion.so/developers/tokens, create a new PAT"
      )
      console.error(
        `         in the workspace that contains ${config.vault.pageId}, then`
      )
      console.error("         export it as NOTION_API_TOKEN and re-run `lore install`.")
      console.error(
        "      2. The vault page isn't shared with the PAT's owning Notion identity."
      )
      console.error(
        "         PATs inherit the operator's personal permissions; if you can't"
      )
      console.error(
        "         open the page in Notion's UI, the PAT can't read it either."
      )
      console.error("         Ask whoever owns the vault to share it with you, or check")
      console.error("         workspace membership.")
    } else {
      // ntn-source: env-aware ntn-login recovery. A project whose
      // .lore.yaml says dev (or whose operator has `NOTION_ENV=dev`
      // exported) gets a paste-ready
      // `NOTION_KEYRING=0 NOTION_ENV=dev ntn login` command.
      const recovery = ntnLoginRecovery(config)
      console.error("    Most likely causes:")
      console.error(
        "      1. You authenticated against the wrong workspace during ntn login,"
      )
      console.error("         OR the auth.json on disk carries a token for the wrong env")
      console.error(
        "         (e.g., a prod token while this project's auth.baseUrl is dev)."
      )
      console.error("         Re-auth with the right env selector:")
      console.error("")
      console.error(`           ${recovery.command}`)
      if (recovery.manualEnvNote) {
        console.error(`           ${recovery.manualEnvNote}`)
      }
      console.error("")
      console.error(`         then pick the workspace containing ${config.vault.pageId}.`)
      console.error(
        "      2. The vault page isn't shared with you (your Notion identity)"
      )
      console.error("         in this workspace. ntn-issued tokens inherit your personal")
      console.error(
        "         Notion permissions; if you can't open the page in Notion's UI,"
      )
      console.error(
        "         the token can't read it either. Ask whoever owns the vault to"
      )
      console.error("         share it with you, or check that you're a member of the")
      console.error("         workspace.")
    }
    console.error("")
    console.error(
      "    Refusing to write MCP config — fix vault access and re-run `lore install`."
    )
    return { ready: false }
  }

  if (result.kind === "unauthorized") {
    console.error(`  Vault page:           ✗ unauthorized (${config.vault.pageId})`)
    console.error("")
    if (isPatSource) {
      if (isIntegrationToken) {
        printPatIntegrationTokenPreflightHint()
      }
      console.error(
        "    The PAT is invalid, expired, revoked, or lacks permission for this page."
      )
      console.error("    Recovery:")
      console.error(
        "      - Rotate the PAT at https://www.notion.so/developers/tokens (the"
      )
      console.error(
        "        existing PAT may have been revoked; a fresh one is the cleanest fix)."
      )
      console.error(
        "      - Confirm the vault page is shared with the PAT's owning Notion"
      )
      console.error(
        "        identity; PATs cannot read pages you can't open in Notion's UI."
      )
      console.error(
        "      - Export the new PAT as NOTION_API_TOKEN, then re-run `lore install`."
      )
    } else {
      // ntn-source: env-aware ntn-login recovery. 401/403 means the
      // resolved token is wrong (invalid, expired, or for the wrong
      // env).
      const recovery = ntnLoginRecovery(config)
      console.error("    The resolved token is invalid, expired, or for the wrong Notion")
      console.error("    environment. Re-auth with the right env selector:")
      console.error("")
      console.error(`      ${recovery.command}`)
      if (recovery.manualEnvNote) {
        console.error(`      ${recovery.manualEnvNote}`)
      }
      console.error("")
      console.error("    then re-run `lore install`.")
    }
    console.error("")
    console.error(
      "    Refusing to write MCP config — fix auth and re-run `lore install`."
    )
    return { ready: false }
  }

  if (result.kind === "rate-limited") {
    console.warn(`  Vault page:           ? rate-limited (${config.vault.pageId})`)
    console.warn("    Notion's API throttled the preflight check. Lore will install")
    console.warn("    anyway; if your first tool call also rate-limits, wait a minute")
    console.warn("    and retry.")
    return { ready: true, authSource: auth.source }
  }

  // unknown-error: genuine 5xx / network blip. Warn but proceed.
  console.warn(
    `  Vault page:           ? preflight returned an unexpected error (${config.vault.pageId})`
  )
  console.warn(
    "    Lore will install anyway; if the issue persists, re-run `lore install`"
  )
  console.warn("    or check Notion's status page.")
  return { ready: true, authSource: auth.source }
}

export async function preflightCodexInstall(context: InstallContext): Promise<void> {
  const codexConfigPath = join(context.projectDir, ".codex", "config.toml")
  const codexHooksPath = join(context.projectDir, ".codex", "hooks.json")
  const codexConfig = await readTextSafe(codexConfigPath)
  assertTomlSupportsLoreRewrite(codexConfig, codexConfigPath)
  await readJsonSafe(codexHooksPath)
}
