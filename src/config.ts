import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { resolve, dirname, join } from "node:path"
import { parse as parseYaml, parseDocument } from "yaml"
import { z } from "zod"
import { getStateDir } from "./hooks/lock.js"
import { configKey } from "./hooks/marker-key.js"
import { parseProfileSelector } from "./profile/index.js"
import type { LoreConfig } from "./types.js"

const CONFIG_FILENAME = ".lore.yaml"
const PLACEHOLDER_PAGE_ID_PATTERN = /^<.+>$/

const hookConfigSchema = z
  .object({
    autoSave: z.boolean().optional(),
    wakeUp: z.boolean().optional(),
    autoDigest: z.boolean().optional(),
    learningExtraction: z.boolean().optional(),
    proposeAutosaveLearnings: z.boolean().optional(),
    saveInterval: z.number().int().min(1).optional(),
    backgroundAgent: z
      .object({
        command: z.string().min(1).optional(),
        args: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .optional()

const pageIdSchema = (requiredMessage = "pageId is required") =>
  z
    .string()
    .min(1, requiredMessage)
    .refine((value) => !PLACEHOLDER_PAGE_ID_PATTERN.test(value.trim()), {
      message:
        "pageId still contains the starter placeholder; replace it with a real Notion page ID.",
    })

const namedVaultRefSchema = z.object({
  name: z.string().min(1),
  pageId: pageIdSchema(),
})

const bearerShapedAuthTokenPattern = /^(?:Bearer\s+)?(?:development_ntn_|ntn_|secret_)/

const configAuthTokenSchema = z
  .string()
  .refine((token) => !bearerShapedAuthTokenPattern.test(token.trim()), {
    message:
      "auth.token in .lore.yaml cannot contain a Notion bearer token; run `lore auth --login` or set NOTION_API_TOKEN, then remove auth.token.",
  })

const profileSelectorSchema = z.string().superRefine((selector, ctx) => {
  try {
    parseProfileSelector(selector)
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: err instanceof Error ? err.message : String(err),
    })
  }
})

const configSchema = z.object({
  vault: z.object({
    pageId: pageIdSchema("vault.pageId is required"),
  }),
  profile: profileSelectorSchema.optional(),
  upstreamVaults: z
    .array(
      namedVaultRefSchema.extend({
        priority: z.number().int().optional(),
      })
    )
    .optional(),
  promotionTargets: z
    .array(
      namedVaultRefSchema.extend({
        requireReview: z.boolean().optional(),
      })
    )
    .optional(),
  auth: z
    .object({
      token: configAuthTokenSchema.optional(),
      baseUrl: z.string().url().optional(),
      workspaceId: z.string().optional(),
    })
    .optional(),
  notion: z
    .object({
      rateLimit: z
        .object({
          concurrency: z.number().int().positive().optional(),
          requestsPerSecond: z.number().positive().optional(),
          burstSize: z.number().int().positive().optional(),
          endpointOverrides: z
            .record(
              z.string().min(1),
              z.object({
                concurrency: z.number().int().positive().optional(),
                requestsPerSecond: z.number().positive().optional(),
                burstSize: z.number().int().positive().optional(),
              })
            )
            .optional(),
        })
        .optional(),
    })
    .optional(),
  projects: z
    .array(
      z.object({
        name: z.string(),
        path: z.string(),
        tags: z.array(z.string()).optional(),
      })
    )
    .optional(),
  detect: z
    .object({
      patterns: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    })
    .optional(),
  hooks: hookConfigSchema,
})

function toPlainConfigValue(value: unknown): unknown {
  if (value instanceof Map) {
    const object: Record<string, unknown> = {}
    for (const [key, child] of value.entries()) {
      object[String(key)] = toPlainConfigValue(child)
    }
    return object
  }

  if (Array.isArray(value)) {
    return value.map((child) => toPlainConfigValue(child))
  }

  return value
}

function omitHooks(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const next = { ...(value as Record<string, unknown>) }
  delete next["hooks"]
  return next
}

export interface LoadedConfigResult {
  config: LoreConfig
  warnings: string[]
}

export function parseConfigAllowingInvalidHooks(raw: string): LoadedConfigResult {
  const document = parseDocument(raw)
  const warnings = document.errors.map((error) => error.message)
  const parsed = toPlainConfigValue(document.toJS({ mapAsMap: true }))

  if (warnings.length > 0) {
    return {
      config: configSchema.parse(omitHooks(parsed)),
      warnings,
    }
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const hooksResult = hookConfigSchema.safeParse(
      (parsed as Record<string, unknown>)["hooks"]
    )
    if (!hooksResult.success) {
      return {
        config: configSchema.parse(omitHooks(parsed)),
        warnings: ["Ignoring invalid hooks config and using hook defaults."],
      }
    }
  }

  return {
    config: configSchema.parse(parsed),
    warnings,
  }
}

/**
 * Search upward from `startDir` for a .lore.yaml file.
 * Returns the path to the file and the directory it was found in.
 */
export async function findConfigFile(
  startDir: string
): Promise<{ path: string; root: string } | null> {
  let dir = resolve(startDir)
  const { root } = { root: "/" }

  while (true) {
    const candidate = resolve(dir, CONFIG_FILENAME)
    try {
      await access(candidate)
      return { path: candidate, root: dir }
    } catch {
      // File doesn't exist at this level — go up
    }
    const parent = dirname(dir)
    if (parent === dir || dir === root) return null
    dir = parent
  }
}

/**
 * Load and validate a .lore.yaml config from disk.
 */
export async function loadConfig(configPath: string): Promise<LoreConfig> {
  const raw = await readFile(configPath, "utf-8")
  const parsed = parseYaml(raw)
  return configSchema.parse(parsed)
}

/**
 * Load a .lore.yaml while treating any broken `hooks` section as absent.
 *
 * Used by shell hooks so `hooks.wakeUp: false` can fail open: a malformed
 * `hooks` section should not suppress session-start context injection.
 */
export async function loadConfigAllowingInvalidHooks(
  configPath: string
): Promise<LoadedConfigResult> {
  const raw = await readFile(configPath, "utf-8")
  return parseConfigAllowingInvalidHooks(raw)
}

/**
 * Which source produced the resolved token. Used in deprecation warnings,
 * `lore auth --status` output, and error messages — never to gate runtime
 * behavior, since every source produces a static bearer token with the same
 * SDK call shape.
 *
 * `env-notion-api-token` is the canonical injection source: ntn itself
 * reads the same env var, so operators who export `NOTION_API_TOKEN`
 * (e.g. from a secret manager) bypass auth.json entirely.
 * `ntn-auth-json` is the read path for operators who use `ntn login`;
 * the public ntn CLI does not expose a token-export command, so the
 * direct file read is the contract rather than a temporary bridge
 * (the auth-layer agent guide carries the full rationale). The
 * remaining two sources are soft-deprecated and continue to work but
 * surface deprecation warnings on different cadences.
 * `LORE_NOTION_TOKEN` warns when selected, debounced to once per 24h per
 * config root, and silenceable via `LORE_SUPPRESS_DEPRECATIONS=1`. Config
 * `auth.token` warns on field presence (even when masked by a higher-
 * priority source), every invocation, and is NOT silenceable —
 * .lore.yaml is local-only but still persistent (backed up, synced,
 * pasted, and one `git add -f` away from history), so the warning
 * tracks the static file condition rather than session state.
 */
export type AuthSource =
  | "env-notion-api-token"
  | "ntn-auth-json"
  | "env-lore-notion-token"
  | "config-auth-token"

export interface ResolvedAuth {
  token: string
  baseUrl?: string
  /**
   * Which of the four 0.10.0 sources produced the token. See `AuthSource`.
   */
  source: AuthSource
  /**
   * Workspace id this token authorizes. Populated by the `ntn-auth-json`
   * source; absent on the env / config sources because there's no way to
   * know without an API call. Consumed by `lore auth --status` /
   * `--whoami`; `resolveAuth` itself does not depend on it.
   */
  workspaceId?: string
}

/**
 * Options for `resolveAuth`. `quiet: true` suppresses the
 * deprecation-warning emission for both soft-deprecated paths
 * (`config-auth-token` per-process gate and the
 * `env-lore-notion-token` 24h debounced warning). Used by
 * synthetic-resolution call sites (e.g. the Stop-hook auth-source
 * derivation via `deriveStopAuthSource`)
 * where the warning has already fired through the foreground
 * host's primary `resolveAuth` call (MCP server init, CLI
 * preflight) and the synthetic call is the SECOND emission for
 * the same operator condition. Each `lore hooks autosave` is a
 * fresh Node process — the per-process gate inside
 * `emitConfigAuthTokenWarning` does NOT cover it, so without
 * `quiet` the operator would see the warning emit on every Stop
 * fire alongside the warning their primary `lore` process
 * already produced.
 *
 * `quiet` is internal-only: every operator-facing surface (CLI,
 * MCP boundary, primary hook init) must omit the option so the
 * warning reaches them via at least one path. Token-resolution
 * semantics are unaffected — the resolved `source` is identical
 * with or without `quiet`.
 *
 * Note: `emitConfigAuthTokenWarning` is intentionally
 * NOT silenceable via `LORE_SUPPRESS_DEPRECATIONS=1` because
 * .lore.yaml is local-only but a token written there still rides
 * every backup, sync, and `git add -f`, so the warning is a
 * second-line defense against tokens slipping into git. `quiet` is a
 * narrower mechanism — it suppresses ONE specific synthetic
 * call site that has already paid the emission via the
 * foreground, NOT a blanket operator-facing silencer. Adding
 * other `quiet: true` call sites requires the same
 * "foreground already emitted via the primary path" argument.
 */
export interface ResolveAuthOptions {
  quiet?: boolean
}

/**
 * Resolution priority for 0.10.0:
 *
 * 1. **`NOTION_API_TOKEN` env** — canonical injection. Operators export
 *    it explicitly (often from a secret manager). ntn itself reads the
 *    same env var, so this path is also how an operator who'd rather
 *    not have Lore read auth.json opts out — exporting
 *    `NOTION_API_TOKEN` short-circuits the file read entirely.
 * 2. **ntn-resolved (auth.json via `loadNtnToken`)** — picks a workspace
 *    token via `NOTION_WORKSPACE_ID` env / `auth.workspaceId` config /
 *    single-workspace auto-pick. The public `ntn` CLI does not expose a
 *    token-export command, so the direct file read is the contract for
 *    the `ntn login` flow.
 * 3. **`LORE_NOTION_TOKEN` env** — soft-deprecated. Returns
 *    `source: "env-lore-notion-token"` and emits a debounced deprecation
 *    warning on first call per session.
 * 4. **`config.auth.token` in .lore.yaml** — soft-deprecated. Emits
 *    a warning as soon as the field is present, even when a higher-priority
 *    source masks it, because .lore.yaml is local-only but still
 *    persistent (backed up, synced, pasted, one `git add -f` away
 *    from history). Unlike the env-var path, this warning fires on
 *    every invocation and is NOT silenceable by
 *    `LORE_SUPPRESS_DEPRECATIONS=1` — `auth.token` is static file
 *    state, not session state, so the cross-CI-run silencing the
 *    env-var debounce produced was hiding a
 *    committed-secret class of mistake.
 *
 * Throws when no source produces a token. The error message recommends
 * `lore auth --login` (the canonical wrapper that auto-installs ntn,
 * forces `NOTION_KEYRING=0` in the spawn, and runs vault preflight) over
 * bare `ntn login` — the wrapper handles the env var that makes the
 * resulting token Lore-readable.
 *
 * `configRoot` is the directory containing .lore.yaml (or
 * `process.cwd()` when no config has been loaded yet — e.g. the no-arg
 * `lore init` flow). Used as the keying input for the
 * `LORE_NOTION_TOKEN` debounce marker so multiple worktrees pointing at
 * the same vault share one 24-hour window. The auth.token in .lore.yaml
 * warning fires every invocation and never reads the marker, so
 * `configRoot` is irrelevant on that path.
 *
 * `options.quiet` suppresses both deprecation-warning emissions for
 * synthetic-resolution call sites; `ResolveAuthOptions` above carries
 * the full rationale.
 */
export async function resolveAuth(
  config: LoreConfig | undefined,
  configRoot: string,
  options: ResolveAuthOptions = {}
): Promise<ResolvedAuth> {
  const quiet = options.quiet === true
  if (config?.auth?.token && !quiet) {
    emitConfigAuthTokenWarning()
  }

  // `auth.baseUrl` from .lore.yaml is **only** honored on the
  // soft-deprecated paths (`env-lore-notion-token`, `config-auth-token`),
  // never on the canonical 0.10.0 paths (`env-notion-api-token`,
  // `ntn-auth-json`). Reason: .lore.yaml is persistent file state
  // beside the repo. Even though the file is local-only, it can still
  // be copied, synced, pasted, or force-added into history, which is
  // less trusted than operator-controlled env vars set in shell rc.
  // A .lore.yaml carrying `auth.baseUrl: https://attacker.example`
  // would otherwise redirect an engineer's ntn-issued bearer token to
  // an arbitrary host on the first Notion call. For canonical sources,
  // the only base-URL override is `LORE_NOTION_BASE_URL` env
  // (operator-controlled, set in shell rc), which `loadNtnToken` honors
  // directly when populating `fromNtn.baseUrl`. Legacy paths preserve
  // the existing `auth.baseUrl` semantics for backward compat —
  // operators on those paths are already trusting .lore.yaml for
  // their token.
  const legacyBaseUrlOverride = config?.auth?.baseUrl

  // 1. NOTION_API_TOKEN env (canonical). Operator-controlled
  // base-URL overrides are honored in priority order
  // `LORE_NOTION_BASE_URL` → `NOTION_BASE_URL` → `NOTION_API_BASE_URL`
  // (the latter two are ntn's documented native names — operators
  // who switch envs via the ntn-shaped shell vars don't have to
  // also export the Lore-namespaced alias). `auth.baseUrl` from
  // repo config is intentionally ignored here.
  const fromApiTokenEnv = process.env["NOTION_API_TOKEN"]
  if (fromApiTokenEnv) {
    const { resolveOperatorBaseUrl } = await import("./auth/oauth.js")
    return {
      token: fromApiTokenEnv,
      baseUrl: resolveOperatorBaseUrl(),
      source: "env-notion-api-token",
    }
  }

  // 2. ntn-resolved (reads ~/.config/notion/auth.json). Lazy
  // import preserves the no-ntn-needed paths from paying the import
  // cost. ESM caches the imported binding after the first call, so
  // warm-path lookups are amortized — do NOT lift this to a top-level
  // import as a "performance optimization." `quiet: true` so the ntn
  // module's stderr hints don't fight the deprecation emitter when
  // ntn-state is ambiguous AND a legacy fallback resolves; if no
  // source resolves we re-detect at the throw site.
  const ntnModule = await import("./auth/ntn.js")
  const ntnSelector = process.env["NOTION_WORKSPACE_ID"] ?? config?.auth?.workspaceId
  const fromNtn = await ntnModule.loadNtnToken({
    workspaceId: ntnSelector,
    quiet: true,
  })
  if (fromNtn) {
    return {
      token: fromNtn.token,
      // ntn's own `fromNtn.baseUrl` is operator-derived (env override
      // or ntn's config.json) — no repo-config override is layered on
      // top, see the security note above.
      baseUrl: fromNtn.baseUrl,
      source: "ntn-auth-json",
      workspaceId: fromNtn.workspaceId,
    }
  }

  // 3. LORE_NOTION_TOKEN env (soft-deprecated).
  const fromLoreEnv = process.env["LORE_NOTION_TOKEN"]
  if (fromLoreEnv) {
    if (!quiet) {
      await emitLoreNotionTokenDeprecationWarningOnce(configRoot)
    }
    return {
      token: fromLoreEnv,
      baseUrl: legacyBaseUrlOverride,
      source: "env-lore-notion-token",
    }
  }

  // 4. auth.token in .lore.yaml (soft-deprecated).
  const fromConfigToken = config?.auth?.token
  if (fromConfigToken) {
    return {
      token: fromConfigToken,
      baseUrl: legacyBaseUrlOverride,
      source: "config-auth-token",
    }
  }

  // No source resolved. Now we surface the ntn ambiguity hint that we
  // suppressed above, IF it applies — that's what gives operators
  // hitting "no auth" the right next step. If auth.json carries
  // multiple workspaces, recommend setting a selector. If the
  // requested selector wasn't found, recommend logging in against the
  // right workspace. Otherwise drop the hint.
  const ntnHint = await buildNtnAmbiguityHint(ntnModule, ntnSelector)
  // The thrown message is forwarded to the operator by `lore auth
  // --status` / `--login` / `--whoami`. `lore auth --login` is the
  // canonical wrapper; the ntn ambiguity hint is the actionable
  // piece when it applies, otherwise point at the wrapper.
  throw new Error(
    "No Notion auth configured.\n" +
      (ntnHint ? ntnHint + "\n" : "") +
      "Recommended: run `lore auth --login` to authenticate via ntn.\n" +
      "Alternative: set NOTION_API_TOKEN with a Notion integration token."
  )
}

/**
 * Re-detect the ntn-ambiguity case at the throw site so we can surface
 * a helpful hint without fighting the deprecation emitter for stderr.
 *
 * Returns one of:
 * - A hint listing the available workspaces and recommending a selector
 *   (multi-workspace case).
 * - A hint naming the requested-but-missing workspace and listing the
 *   available ones (selector miss case).
 * - `undefined` when there's nothing actionable about ntn (no
 *   auth.json, single-workspace already auto-picked, etc.).
 *
 * Best-effort — uses the public `listNtnWorkspaces` surface rather
 * than re-implementing the parse path. If the file walked fine on the
 * earlier `loadNtnToken` call, this re-walk is sub-millisecond cached
 * filesystem; otherwise it gracefully falls through to no hint.
 */
async function buildNtnAmbiguityHint(
  ntnModule: typeof import("./auth/ntn.js"),
  selector: string | undefined
): Promise<string | undefined> {
  const workspaces = await ntnModule.listNtnWorkspaces()
  if (workspaces.length === 0) return undefined
  if (selector && !workspaces.includes(selector)) {
    // Recovery recommends `lore auth --login` (the canonical wrapper
    // that forces NOTION_KEYRING=0 inside the spawn) NOT bare
    // `ntn login` — on macOS bare `ntn login` defaults to keychain
    // mode and writes nothing to auth.json, which leaves Lore
    // unable to read the new token and re-fires this same hint on
    // the next call.
    return (
      `ntn auth.json carries ${workspaces.length} workspace(s) but ` +
      `the requested workspaceId (${selector}) is not among them. ` +
      `Available: ${workspaces.join(", ")}. Run ` +
      `\`lore auth --login\` against the right workspace, or update ` +
      `auth.workspaceId in .lore.yaml.`
    )
  }
  if (!selector && workspaces.length > 1) {
    return (
      `ntn auth.json carries ${workspaces.length} workspaces; ` +
      `specify one via NOTION_WORKSPACE_ID env or auth.workspaceId in ` +
      `.lore.yaml. Available: ${workspaces.join(", ")}.`
    )
  }
  // Single workspace already on disk but loadNtnToken still returned
  // null — this is the very narrow "happy path returned a token then
  // race-condition removed the file" case. No actionable hint; defer
  // to the recommended commands in the throw.
  return undefined
}

/**
 * Debounce window for the `LORE_NOTION_TOKEN` deprecation warning, in
 * milliseconds. 24 hours — short enough that a returning operator sees
 * the prompt within one working day of running Lore, long enough that an
 * operator who runs `lore` ten times in a session sees the warning once.
 *
 * The auth.token in .lore.yaml warning intentionally does NOT use this
 * debounce — `emitConfigAuthTokenWarning` carries the rationale.
 */
const DEPRECATION_DEBOUNCE_MS = 24 * 60 * 60 * 1000

/**
 * Emit the `LORE_NOTION_TOKEN` deprecation warning to stderr, debounced
 * once per 24-hour window per config root and silenceable via
 * `LORE_SUPPRESS_DEPRECATIONS=1`. The marker is keyed via `configKey`
 * under `getStateDir()`, the same per-config-root-marker pattern the
 * drift and digest schedulers use.
 *
 * Two override paths:
 * - `LORE_SUPPRESS_DEPRECATIONS=1` neither emits nor touches the marker.
 *   A suppressed run inside the debounce window therefore does NOT extend
 *   the window — the next un-suppressed call after the marker expires
 *   re-emits.
 * - A fresh marker (mtime within `DEPRECATION_DEBOUNCE_MS`) skips the
 *   emission. Two concurrent processes may both miss the marker between
 *   stat and write; double-emission of an informational warning is
 *   acceptable.
 *
 * `LORE_NOTION_TOKEN` is ephemeral session state (an exported env var
 * dies with the shell), so a session-scoped debounce + a silenceable
 * escape hatch is the right shape: an operator running `lore` ten times
 * in a session sees the warning once, and a CI run that has migrated to
 * a different auth source can opt out cleanly. Compare with
 * `emitConfigAuthTokenWarning`, which deliberately does neither because
 * `auth.token` in .lore.yaml is persistent file state (local but
 * still backed up, synced, and easy to force into git), not session
 * state, and behaves differently under the same threat model.
 */
async function emitLoreNotionTokenDeprecationWarningOnce(
  configRoot: string
): Promise<void> {
  if (process.env["LORE_SUPPRESS_DEPRECATIONS"] === "1") return

  const stateDir = getStateDir()
  const marker = join(stateDir, `auth-deprecation.${configKey(configRoot)}.last`)

  try {
    const st = await stat(marker)
    if (Date.now() - st.mtimeMs < DEPRECATION_DEBOUNCE_MS) return
  } catch {
    // Marker missing — proceed to emit.
  }

  // Post-2026-05-13: `lore auth --migrate` defaults to the PAT
  // three-step flow (verify legacy → walk operator through creating
  // a Personal Access Token at notion.so/developers/tokens →
  // verify the PAT reaches the same vault), and `--migrate --ntn`
  // is the internal-engineer ntn-login opt-in. The warning names
  // both branches so external PAT operators and internal-engineer
  // ntn operators each see their own path. Sibling parity with
  // `emitConfigAuthTokenWarning` — both surfaces ship the same
  // contract (both branches + 0.14.0 hard-removal target).
  const message =
    "[lore] LORE_NOTION_TOKEN is soft-deprecated in 0.10.0 (hard-removal targeted for 0.14.0).\n" +
    "[lore] Migrate: run `lore auth --migrate` to migrate to a PAT in NOTION_API_TOKEN,\n" +
    "[lore] or `lore auth --migrate --ntn` to migrate to ntn-issued auth instead, then unset LORE_NOTION_TOKEN.\n" +
    "[lore] Set LORE_SUPPRESS_DEPRECATIONS=1 to silence this warning."

  process.stderr.write(message + "\n")

  try {
    await mkdir(stateDir, { recursive: true })
    await writeFile(marker, "", { mode: 0o600 })
  } catch {
    // Best-effort. A marker write failure means the next call re-emits;
    // that's noisier than ideal but never wrong.
  }
}

/**
 * Per-process gate for the `auth.token` deprecation warning. Set on the
 * first emission within this Node process; subsequent calls within the
 * same process short-circuit. `emitConfigAuthTokenWarning` carries the
 * rationale; `_resetConfigAuthTokenWarningStateForTests` exposes the
 * test-only escape hatch.
 */
let configAuthTokenWarningEmittedThisProcess = false

/**
 * Emit the auth.token in .lore.yaml deprecation warning to stderr,
 * gated to one emission per Node process. NOT silenceable via
 * `LORE_SUPPRESS_DEPRECATIONS=1`. NOT debounced across processes.
 *
 * The asymmetry with `emitLoreNotionTokenDeprecationWarningOnce` is
 * deliberate. `LORE_NOTION_TOKEN` is
 * ephemeral session state that dies with the shell; debouncing + a
 * silence env is appropriate noise management for that case.
 * .lore.yaml is local-only, but a token pasted there still rides
 * every backup, sync, and is one `git add -f` away from history. That
 * is a different class of misconfiguration than an ephemeral env var.
 * Treating both with the same noise budget hides the persistent-secret
 * signal across CI runs and across engineers in the same worktree:
 *
 * - The 24-hour marker would suppress the warning between sequential CI
 *   runs (each engineer running `lore` once in a workday only ever sees
 *   the warning the first time).
 * - `LORE_SUPPRESS_DEPRECATIONS=1` is a reasonable thing to set in CI
 *   for log hygiene, but silencing a "you committed a token" signal is
 *   not the right tradeoff.
 *
 * The schema bearer-shape guard (`bearerShapedAuthTokenPattern` at the
 * top of this file) catches `ntn_…` / `secret_…`, but a typo, a future
 * Notion token format, or a different vendor's token mis-pasted into
 * the same field bypasses that guard. The unsuppressible warning is the
 * second-line defense.
 *
 * The warning intentionally does NOT mention `LORE_SUPPRESS_DEPRECATIONS=1`
 * because the env var does not silence this source — pointing operators
 * at it would be misleading. The remediation is removing the field, not
 * silencing the signal.
 *
 * **Per-process gate** is distinct from a 24h debounce. The shape is
 * "one emission per process startup, regardless of how many times
 * `resolveAuth` is called within that process." Different processes
 * always re-emit (no cross-process marker file). The gate exists so
 * that long-running MCP servers — where `createNtnAuthRefresh`
 * re-calls `resolveAuth` on every 401-driven token refresh — don't fan
 * out per-401 stderr noise. Per-CLI-invocation semantics are preserved:
 * a CLI process resolves auth at most a handful of times during its
 * lifetime, all collapsing to one emission.
 */
function emitConfigAuthTokenWarning(): void {
  if (configAuthTokenWarningEmittedThisProcess) return
  configAuthTokenWarningEmittedThisProcess = true

  const message =
    "[lore] auth.token in .lore.yaml is soft-deprecated in 0.10.0 (hard-removal targeted for 0.14.0).\n" +
    "[lore] Migrate: run `lore auth --migrate` to migrate to a PAT in NOTION_API_TOKEN,\n" +
    "[lore] or `lore auth --migrate --ntn` to migrate to ntn-issued auth instead, then remove the auth.token field.\n" +
    "[lore] This warning is not silenceable; remove auth.token from .lore.yaml to clear it."

  process.stderr.write(message + "\n")
}

/**
 * Reset the per-process `auth.token` warning gate. Test-only — production
 * callers must NOT use this.
 *
 * Vitest runs every test in this file's companion test suite inside the same Node
 * process, so the module-level `configAuthTokenWarningEmittedThisProcess`
 * flag would carry across test cases and silently break isolation
 * (the second test would never see the warning). Each `resolveAuth`
 * test simulates a distinct "lore invocation"; calling this reset in
 * `beforeEach` restores that mental model.
 *
 * Underscore-prefixed export name signals "internal/test-only" — the
 * standing convention for test-isolation helpers in this codebase.
 */
export function _resetConfigAuthTokenWarningStateForTests(): void {
  configAuthTokenWarningEmittedThisProcess = false
}

/**
 * Convenience wrapper that returns just the token string. `configRoot`
 * threads through to `resolveAuth` for the deprecation-warning marker —
 * pass the directory containing .lore.yaml, or `process.cwd()` when no
 * config has been loaded yet.
 */
export async function resolveToken(
  config: LoreConfig | undefined,
  configRoot: string
): Promise<string> {
  const auth = await resolveAuth(config, configRoot)
  return auth.token
}
