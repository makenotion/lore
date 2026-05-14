import { access, readFile } from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { parse as parseYaml, parseDocument } from "yaml"
import { z } from "zod"
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

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/
const MANIFEST_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

const profileAllowedInstallSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("git"),
    url: z.string().min(1, "url is required for git allow-list entries"),
    commit: z
      .string()
      .regex(COMMIT_SHA_PATTERN, "commit must be a 40-character lowercase hex SHA"),
    manifestDigest: z
      .string()
      .regex(MANIFEST_DIGEST_PATTERN, "manifestDigest must be sha256:<64-hex>"),
  }),
  z.object({
    kind: z.literal("path"),
    path: z.string().min(1, "path is required for path allow-list entries"),
    manifestDigest: z
      .string()
      .regex(MANIFEST_DIGEST_PATTERN, "manifestDigest must be sha256:<64-hex>"),
  }),
])

const profilesConfigSchema = z
  .object({
    allowedInstallSources: z.array(profileAllowedInstallSourceSchema).optional(),
  })
  .optional()

const configSchema = z.object({
  vault: z.object({
    pageId: pageIdSchema("vault.pageId is required"),
  }),
  profile: profileSelectorSchema.optional(),
  profiles: profilesConfigSchema,
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
      token: z
        .undefined({
          invalid_type_error:
            "auth.token has been removed. Use `lore auth --login` or set NOTION_API_TOKEN, then remove auth.token from .lore.yaml.",
        })
        .optional(),
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
 * Which source produced the resolved token. Used in `lore auth --status`
 * output, install summaries, and error messages — never to gate runtime
 * behavior, since every source produces a static bearer token with the same
 * SDK call shape.
 *
 * `env-notion-api-token` is the canonical injection source: ntn itself
 * reads the same env var, so operators who export `NOTION_API_TOKEN`
 * (e.g. from a secret manager) bypass auth.json entirely.
 * `ntn-auth-json` is the read path for operators who use `ntn login`;
 * the public ntn CLI does not expose a token-export command, so the
 * direct file read is the contract rather than a temporary bridge
 * (the auth-layer agent guide carries the full rationale).
 */
export type AuthSource = "env-notion-api-token" | "ntn-auth-json"

export interface ResolvedAuth {
  token: string
  baseUrl?: string
  /**
   * Which supported source produced the token. See `AuthSource`.
   */
  source: AuthSource
  /**
   * Workspace id this token authorizes. Populated by the `ntn-auth-json`
   * source; absent on the env source because there's no way to know
   * without an API call. Consumed by `lore auth --status` /
   * `--whoami`; `resolveAuth` itself does not depend on it.
   */
  workspaceId?: string
}

/**
 * Options for `resolveAuth`. Reserved for synthetic call sites that
 * need to preserve the public signature while auth resolution remains
 * side-effect-light.
 */
export interface ResolveAuthOptions {
  quiet?: boolean
}

/**
 * Resolution priority:
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
 *
 * Throws when no source produces a token. The error message recommends
 * `lore auth --login` (the canonical wrapper that auto-installs ntn,
 * forces `NOTION_KEYRING=0` in the spawn, and runs vault preflight) over
 * bare `ntn login` — the wrapper handles the env var that makes the
 * resulting token Lore-readable.
 *
 * `configRoot` is the directory containing .lore.yaml (or
 * `process.cwd()` when no config has been loaded yet — e.g. the no-arg
 * `lore init` flow).
 */
export async function resolveAuth(
  config: LoreConfig | undefined,
  configRoot: string,
  options: ResolveAuthOptions = {}
): Promise<ResolvedAuth> {
  void configRoot
  void options

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
  // module's stderr hints are surfaced only once through the final
  // operator-facing error when ntn-state is ambiguous.
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

  // No source resolved. Now we surface the ntn ambiguity hint that we
  // suppressed above, if it applies — that's what gives operators
  // hitting "no auth" the right next step. If auth.json carries
  // multiple workspaces, recommend setting a selector. If the
  // requested selector wasn't found, recommend logging in against the
  // right workspace. Otherwise drop the hint.
  const ntnHint = await buildNtnAmbiguityHint(ntnModule, ntnSelector)
  // The thrown message is forwarded to the operator by `lore auth
  // --status` / `--login` / `--whoami`. `lore auth --login` is the
  // canonical wrapper; the ntn ambiguity hint is the actionable
  // piece when it applies, otherwise point at the wrapper.
  const legacyEnvHint = process.env["LORE_NOTION_TOKEN"]
    ? "Detected LORE_NOTION_TOKEN in the environment. This source was removed; " +
      "move the value to NOTION_API_TOKEN only if it is a Notion Personal Access " +
      "Token, otherwise rotate to a PAT."
    : undefined
  throw new Error(
    "No Notion auth configured.\n" +
      (legacyEnvHint ? legacyEnvHint + "\n" : "") +
      (ntnHint ? ntnHint + "\n" : "") +
      "Recommended: run `lore auth --login` to authenticate via ntn.\n" +
      "Alternative: set NOTION_API_TOKEN with a Notion Personal Access Token."
  )
}

/**
 * Re-detect the ntn-ambiguity case at the throw site so we can surface
 * a helpful hint through the same error message as the primary auth
 * recovery instructions.
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

export function _resetConfigAuthTokenWarningStateForTests(): void {}

/**
 * Convenience wrapper that returns just the token string.
 */
export async function resolveToken(
  config: LoreConfig | undefined,
  configRoot: string
): Promise<string> {
  const auth = await resolveAuth(config, configRoot)
  return auth.token
}
