import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { resolve, dirname, join } from "node:path"
import { parse as parseYaml, parseDocument } from "yaml"
import { z } from "zod"
import { getStateDir } from "./hooks/lock.js"
import { configKey } from "./hooks/marker-key.js"
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

const bearerShapedAuthTokenPattern = /^(?:Bearer\s+)?(?:ntn_|secret_)/

const configAuthTokenSchema = z.string().refine(
  (token) => !bearerShapedAuthTokenPattern.test(token.trim()),
  {
    message:
      "auth.token in .lore.yaml cannot contain a Notion bearer token; run `lore auth --login` or set NOTION_API_TOKEN, then remove auth.token.",
  },
)

const configSchema = z.object({
  vault: z.object({
    pageId: pageIdSchema("vault.pageId is required"),
  }),
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
    const hooksResult = hookConfigSchema.safeParse((parsed as Record<string, unknown>)["hooks"])
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
 * Search upward from `startDir` for a `.lore.yaml` file.
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
 * Load and validate a `.lore.yaml` config from disk.
 */
export async function loadConfig(configPath: string): Promise<LoreConfig> {
  const raw = await readFile(configPath, "utf-8")
  const parsed = parseYaml(raw)
  return configSchema.parse(parsed)
}

/**
 * Load a `.lore.yaml` while treating any broken `hooks` section as absent.
 *
 * Used by shell hooks so `hooks.wakeUp: false` can fail open: a malformed
 * `hooks` section should not suppress session-start context injection.
 */
export async function loadConfigAllowingInvalidHooks(
  configPath: string,
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
 * `env-notion-api-token` is the canonical source: ntn itself reads the same
 * env var, and a future `eval "$(ntn auth token --eval)"` shell-rc wiring
 * will land on path 1 directly. `ntn-auth-json` is the temporary bridge
 * that reads ntn's private storage until DEFERRED-OFFICIAL-EXPORT ships.
 * The remaining two sources are soft-deprecated; they continue to work but
 * surface debounced warnings. `LORE_NOTION_TOKEN` warns when selected, while
 * config `auth.token` warns on field presence because `.lore.yaml` is
 * committable repo config.
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
   * `--whoami` (#06); `resolveAuth` itself does not depend on it.
   */
  workspaceId?: string
}

/**
 * Resolution priority for 0.10.0:
 *
 * 1. **`NOTION_API_TOKEN` env** — canonical. Set by the operator
 *    explicitly OR by a future `eval "$(ntn auth token --eval)"` shell-rc
 *    wiring once `ntn` ships official export (DEFERRED-OFFICIAL-EXPORT).
 * 2. **ntn-resolved (`auth.json` via `loadNtnToken`)** — picks a workspace
 *    token via `NOTION_WORKSPACE_ID` env / `auth.workspaceId` config /
 *    single-workspace auto-pick. Temporary coupling to ntn's private
 *    storage; removed when official export ships.
 * 3. **`LORE_NOTION_TOKEN` env** — soft-deprecated. Returns
 *    `source: "env-lore-notion-token"` and emits a debounced deprecation
 *    warning on first call per session.
 * 4. **`config.auth.token` in `.lore.yaml`** — soft-deprecated. Emits
 *    a warning as soon as the field is present, even when a higher-priority
 *    source masks it, because `.lore.yaml` is a committable repo config.
 *
 * Throws when no source produces a token. The error message recommends
 * `lore auth --login` (the canonical wrapper that auto-installs ntn,
 * forces `NOTION_KEYRING=0` in the spawn, and runs vault preflight) over
 * bare `ntn login` — the wrapper handles the env var that makes the
 * resulting token Lore-readable.
 *
 * `configRoot` is the directory containing `.lore.yaml` (or
 * `process.cwd()` when no config has been loaded yet — e.g. the no-arg
 * `lore init` flow). Used solely as the keying input for the
 * deprecation-warning marker so multiple worktrees pointing at the same
 * vault share one debounce window.
 */
export async function resolveAuth(
  config: LoreConfig | undefined,
  configRoot: string
): Promise<ResolvedAuth> {
  if (config?.auth?.token) {
    await emitDeprecationWarningOnce(configRoot, "config-auth-token")
  }

  // `auth.baseUrl` from `.lore.yaml` is **only** honored on the
  // soft-deprecated paths (`env-lore-notion-token`, `config-auth-token`),
  // never on the canonical 0.10.0 paths (`env-notion-api-token`,
  // `ntn-auth-json`). Reason: a checked-in `.lore.yaml` is repo-controlled,
  // not operator-controlled. A malicious `.lore.yaml` carrying
  // `auth.baseUrl: https://attacker.example` would otherwise redirect
  // an engineer's ntn-issued bearer token to an arbitrary host on the
  // first Notion call. For canonical sources, the only base-URL override
  // is `LORE_NOTION_BASE_URL` env (operator-controlled, set in shell rc),
  // which `loadNtnToken` honors directly when populating `fromNtn.baseUrl`.
  // Legacy paths preserve the existing `auth.baseUrl` semantics for
  // backward compat — operators on those paths are already trusting
  // `.lore.yaml` for their token.
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

  // 2. ntn-resolved (reads ~/.config/notion/auth.json via #02). Lazy
  // import preserves the no-ntn-needed paths from paying the import
  // cost. ESM caches the imported binding after the first call, so
  // warm-path lookups are amortized — do NOT lift this to a top-level
  // import as a "performance optimization." `quiet: true` so the ntn
  // module's stderr hints don't fight the deprecation emitter when
  // ntn-state is ambiguous AND a legacy fallback resolves; if no
  // source resolves we re-detect at the throw site.
  const ntnModule = await import("./auth/ntn.js")
  const ntnSelector =
    process.env["NOTION_WORKSPACE_ID"] ?? config?.auth?.workspaceId
  const fromNtn = await ntnModule.loadNtnToken({
    workspaceId: ntnSelector,
    quiet: true,
  })
  if (fromNtn) {
    return {
      token: fromNtn.token,
      // ntn's own `fromNtn.baseUrl` is operator-derived (env override
      // or ntn's `config.json`) — no repo-config override is layered on
      // top, see the security note above.
      baseUrl: fromNtn.baseUrl,
      source: "ntn-auth-json",
      workspaceId: fromNtn.workspaceId,
    }
  }

  // 3. LORE_NOTION_TOKEN env (soft-deprecated).
  const fromLoreEnv = process.env["LORE_NOTION_TOKEN"]
  if (fromLoreEnv) {
    await emitDeprecationWarningOnce(configRoot, "env-lore-notion-token")
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
  // hitting "no auth" the right next step. If `auth.json` carries
  // multiple workspaces, recommend setting a selector. If the
  // requested selector wasn't found, recommend logging in against the
  // right workspace. Otherwise drop the hint.
  const ntnHint = await buildNtnAmbiguityHint(ntnModule, ntnSelector)
  // The thrown message is forwarded to the operator by `lore auth
  // --status` / `--login` / `--whoami`; it must not contain stale
  // "Phase 2 will ship" copy now that `lore auth --login` is the
  // canonical wrapper. The ntn ambiguity hint is the actionable
  // piece — keep it; otherwise point at the wrapper.
  throw new Error(
    "No Notion auth configured.\n" +
      (ntnHint ? ntnHint + "\n" : "") +
      "Recommended: run `lore auth --login` to authenticate via ntn.\n" +
      "Alternative: set NOTION_API_TOKEN with a Notion integration token.",
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
 *   `auth.json`, single-workspace already auto-picked, etc.).
 *
 * Best-effort — uses the public `listNtnWorkspaces` surface rather
 * than re-implementing the parse path. If the file walked fine on the
 * earlier `loadNtnToken` call, this re-walk is sub-millisecond cached
 * filesystem; otherwise it gracefully falls through to no hint.
 */
async function buildNtnAmbiguityHint(
  ntnModule: typeof import("./auth/ntn.js"),
  selector: string | undefined,
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
 * Debounce window for the deprecation warning, in milliseconds. 24 hours
 * — short enough that a returning operator sees the prompt within one
 * working day of running Lore, long enough that an operator who runs
 * `lore` ten times in a session sees the warning once.
 */
const DEPRECATION_DEBOUNCE_MS = 24 * 60 * 60 * 1000

/**
 * Emit a one-time-per-session-per-config-root deprecation warning to
 * stderr, debounced by a filesystem marker under `getStateDir()`. Mirrors
 * the per-config-root-marker pattern already used by the drift and digest
 * schedulers — `configKey` and the state dir are shared so the
 * truncation/sanitization rules stay in lockstep across markers.
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
 */
async function emitDeprecationWarningOnce(
  configRoot: string,
  source: "env-lore-notion-token" | "config-auth-token",
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

  // The recommended commands are split by source so an operator
  // hitting either legacy path sees the right migration target.
  // `lore auth --login` is the canonical wrapper for re-authing
  // through ntn; `lore auth --migrate` (Phase 2 issue 0.10.0/07)
  // walks operators with `LORE_NOTION_TOKEN` set through the same
  // flow with the legacy unset step layered on top — recommend it
  // by name on the env path even when #07 hasn't merged yet, so
  // the warning stays consistent across PR-merge order.
  const message =
    source === "env-lore-notion-token"
      ? "[lore] LORE_NOTION_TOKEN is soft-deprecated in 0.10.0.\n" +
        "[lore] Migrate: run `lore auth --migrate` (or unset LORE_NOTION_TOKEN and run `lore auth --login`).\n" +
        "[lore] Set LORE_SUPPRESS_DEPRECATIONS=1 to silence this warning."
      : "[lore] auth.token in .lore.yaml is soft-deprecated in 0.10.0.\n" +
        "[lore] Migrate: run `lore auth --login` to re-auth via ntn, then remove the auth.token field.\n" +
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
 * Convenience wrapper that returns just the token string. `configRoot`
 * threads through to `resolveAuth` for the deprecation-warning marker —
 * pass the directory containing `.lore.yaml`, or `process.cwd()` when no
 * config has been loaded yet.
 */
export async function resolveToken(
  config: LoreConfig | undefined,
  configRoot: string,
): Promise<string> {
  const auth = await resolveAuth(config, configRoot)
  return auth.token
}
