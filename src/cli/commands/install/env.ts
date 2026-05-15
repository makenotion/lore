import { access } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import {
  RUNTIME_FORWARDED_AUTH_TOKEN_KEYS,
  RUNTIME_FORWARDED_KEYS,
  type RuntimeForwardedKey,
} from "../../../auth/forwarded-env.js"
import { toPortablePath } from "./utils.js"
import type { BuildMcpEnvOptions, McpEnvBuild } from "./types.js"

export function buildMcpEnv(
  configRoot: string,
  envSource: NodeJS.ProcessEnv = process.env,
  options: BuildMcpEnvOptions = {}
): McpEnvBuild {
  const env: Record<string, string> = {}
  const forwarded: RuntimeForwardedKey[] = []
  const skipAuthTokens = options.authSource === "ntn-auth-json"
  const authTokenKeys: ReadonlySet<RuntimeForwardedKey> = new Set(
    RUNTIME_FORWARDED_AUTH_TOKEN_KEYS
  )

  // When `notionBaseUrlLiteral` is set, suppress ALL four base-URL
  // selector placeholders that influence `resolveOperatorBaseUrl`'s
  // priority chain — not just `NOTION_BASE_URL`. The chain is
  // `LORE_NOTION_BASE_URL || NOTION_BASE_URL || NOTION_API_BASE_URL
  // || ntnEnvBaseUrl(NOTION_ENV)`, so `LORE_NOTION_BASE_URL`
  // OUTRANKS the literal `NOTION_BASE_URL` we write into `staticEnv`.
  // Forwarding any of the four placeholders would let the operator's
  // shell at MCP-spawn time override the install-time `--dev` choice
  // — e.g. `LORE_NOTION_BASE_URL=https://api.notion.so` set later
  // routes the child to prod despite the dev literal. Suppressing
  // all four keeps the literal load-bearing.
  const literalBaseUrl = options.notionBaseUrlLiteral
  const baseUrlSelectorKeys: ReadonlySet<RuntimeForwardedKey> = new Set([
    "LORE_NOTION_BASE_URL",
    "NOTION_BASE_URL",
    "NOTION_API_BASE_URL",
    "NOTION_ENV",
  ])
  for (const key of RUNTIME_FORWARDED_KEYS) {
    if (skipAuthTokens && authTokenKeys.has(key)) continue
    if (literalBaseUrl && baseUrlSelectorKeys.has(key)) continue
    const value = envSource[key]
    if (typeof value === "string" && value.length > 0) {
      env[key] = `\${${key}}`
      forwarded.push(key)
    }
  }

  // Insertion order is observable: `Object.entries(staticEnv)` is
  // what Codex's bash-prefix builder iterates, so the ordering of
  // KEY=value pairs in the launch command tracks this object's
  // insertion order. `LORE_CONFIG_ROOT` lands first (when present)
  // so its absence on the PnP path doesn't reshuffle the surviving
  // entries' positions.
  const staticEnv: Record<string, string> = {}
  if (!options.omitConfigRoot) {
    staticEnv["LORE_CONFIG_ROOT"] = configRoot
  }
  staticEnv["LORE_SUPPRESS_DEPRECATIONS"] = "1"
  if (literalBaseUrl) {
    // Literal NOTION_BASE_URL — set when --dev is passed (or when
    // any future flag wants a known dev/staging target). The MCP
    // child reads NOTION_BASE_URL via `resolveOperatorBaseUrl`
    // priority 2; literal placement here means the spawned server
    // hits the right host regardless of operator shell state.
    staticEnv["NOTION_BASE_URL"] = literalBaseUrl
  }

  return { env, staticEnv, forwarded }
}

/**
 * Merge the Claude / Cursor `env` block. Both hosts accept literal
 * values alongside `${VAR}` placeholders, so static and runtime
 * entries collapse into the single `env` map. Static wins on any
 * collision (defensive — the two key sets shouldn't overlap by
 * design).
 */
export function mergeMcpEnvForClaudeOrCursor(build: McpEnvBuild): Record<string, string> {
  return { ...build.env, ...build.staticEnv }
}

export function resolvePkgRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // Unbundled module execution adds one directory level compared with
  // the bundled CLI entry point.
  return basename(here) === "install" ? resolve(here, "..", "..") : resolve(here, "..")
}

/**
 * Detect whether `projectDir` (or any ancestor up to `homedir()`) is a
 * Yarn Berry / Yarn 4 PnP consumer. Yarn PnP installs do NOT populate
 * `node_modules/.bin/lore`, so the bare bin-dispatch shape
 * (`command: "lore"`) cannot resolve at host-launch time. Detection
 * here drives the install runner to emit the yarn-wrapped shape
 * (`command: "yarn", args: ["run", "-T", "lore", "mcp"]`) instead.
 *
 * Marker file: `.pnp.cjs` (Yarn 4's PnP loader). `.pnp.loader.mjs` is
 * an alternate spelling some configurations produce; we accept either.
 *
 * Walking up to home (not the filesystem root) avoids rare false
 * positives from a system-level pnp file outside any user project.
 * The walk is bounded — it stops the first time it sees a marker, hits
 * `homedir()`, or runs out of parent directories.
 */
export async function detectYarnPnp(projectDir: string): Promise<boolean> {
  let current = resolve(projectDir)
  const stop = homedir()
  while (true) {
    for (const marker of [".pnp.cjs", ".pnp.loader.mjs"]) {
      if (await fileExists(join(current, marker))) return true
    }
    if (current === stop) return false
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

export function installerMcpPaths(): {
  portableMcpJsPath: string
  portablePkgRoot: string
} {
  const pkgRoot = resolvePkgRoot()
  return {
    portableMcpJsPath: toPortablePath(join(pkgRoot, "dist", "mcp.js")),
    portablePkgRoot: toPortablePath(pkgRoot),
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
