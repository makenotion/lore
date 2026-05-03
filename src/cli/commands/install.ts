import { Command } from "commander"
import { readFile, writeFile, mkdir, access, chmod, rename, unlink } from "node:fs/promises"
import { join, dirname, resolve } from "node:path"
import { homedir } from "node:os"
import { stdin, stdout } from "node:process"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline/promises"
import { findConfigFile, loadConfig, resolveAuth, type AuthSource, type ResolvedAuth } from "../../config.js"
import type { LoreConfig } from "../../types.js"
import { ntnEnvFromBaseUrl, verifyVaultAccess } from "../../auth/oauth.js"
import { findBackgroundBinary } from "../../hooks/background.js"
import {
  ALLOWED_TOOLS_PLACEHOLDER,
  lookupCommandPreset,
  mergeHookDefaults,
} from "../../hooks/config.js"
import {
  checkNtnVersion,
  getNtnVersion,
  installNtn,
  isNtnInstalled,
  MIN_NTN_VERSION,
  type NtnEnv,
  NTN_INSTALL_COMMAND,
  parseNtnEnv,
  runNtnLogin,
} from "../../auth/ntn.js"
import {
  RUNTIME_FORWARDED_AUTH_TOKEN_KEYS,
  RUNTIME_FORWARDED_KEYS,
  type RuntimeForwardedKey,
} from "../../auth/forwarded-env.js"

export type InstallClient = "claude" | "codex" | "cursor" | "all"

/**
 * Status of a single Lore-owned config entry on disk.
 *
 * - `current` — entry is in the bin-dispatch form (`lore mcp` /
 *   `lore hooks <event>`), matching `buildClaudeMcpEntry()` /
 *   `buildClaudeHookCommand()` / `buildCodexMcpSection()` /
 *   `buildCodexHookCommand()` byte-for-byte.
 * - `legacy-current` — entry is in the absolute-path form and matches
 *   `buildLegacyClaudeMcpEntry(...)` / etc. for the resolved `pkgRoot`.
 *   Default `lore install` (no `--legacy-paths`) reports this and
 *   rewrites to bin-dispatch; `lore install --legacy-paths` treats it
 *   as `current`.
 * - `stale` — entry exists but matches neither shape (e.g., points at
 *   a different `pkgRoot`, hand-edited args). Reinstall replaces it.
 * - `missing` — no Lore entry at all.
 */
export type HookStatus = "current" | "legacy-current" | "stale" | "missing"

/**
 * The shape of the bin-dispatched command lore writes into committed
 * config. Two valid shapes:
 *
 * - `bare` — `command: "lore"`, `args: ["mcp"]`. Resolves through the
 *   consumer's `node_modules/.bin/lore` symlink that npm and Yarn 1
 *   create. Default for non-Yarn-PnP consumers.
 *
 * - `yarn` — `command: "yarn"`, `args: ["run", "-T", "lore", "mcp"]`.
 *   Resolves through Yarn Berry / Yarn 4 PnP, which does NOT populate
 *   `node_modules/.bin` and therefore cannot satisfy the bare shape
 *   when a host launches `command: "lore"` directly. The `yarn run
 *   -T` (top-level) form resolves the workspace-root binary even
 *   when the host launches the MCP from a workspace subdirectory —
 *   bare `yarn lore` only resolves bins in the cwd's package and
 *   fails on subdirectory launches that monorepo hosts often
 *   produce. `-T` is Yarn 4's flag spelling; pre-Berry Yarn 1
 *   silently ignores unknown flags and falls back to top-level
 *   resolution by default, so the same shape is portable across
 *   versions.
 *
 * The legacy absolute-path shape (`node <pkgRoot>/dist/mcp.js`) is
 * orthogonal — selected via `legacyPaths`, not via this enum — and
 * remains unchanged through the deprecation window.
 */
export type BinDispatchShape = "bare" | "yarn"

export interface McpEnvBuild {
  /**
   * `${VAR}` placeholder entries the MCP host resolves at spawn time
   * from the operator's env. Suitable for direct merge into Claude /
   * Cursor `env: { ... }` blocks; Codex consumes the keys via
   * `env_vars = [...]`.
   */
  env: Record<string, string>
  /**
   * Literal KEY=value entries always present:
   *   - `LORE_CONFIG_ROOT`  — so the spawned MCP child resolves the
   *     right `.lore.yaml` even when the host's spawn-time cwd does
   *     not match the operator's vault directory.
   *   - `LORE_SUPPRESS_DEPRECATIONS` — silences per-session
   *     deprecation warnings in the spawned child; the parent CLI
   *     emits them already.
   * Claude / Cursor consumers merge these into `env` directly. Codex
   * consumers prefix them onto its `bash -lc` launch command because
   * its `env_vars = [...]` shape only carries name-only references.
   */
  staticEnv: Record<string, string>
  /**
   * Which runtime-forwarded keys were detected in the install-time
   * env. Used by the install action to print a one-line note when a
   * legacy forwarder (`LORE_NOTION_TOKEN`) was picked up so the
   * operator sees a deprecation reminder. The exact wording stays
   * command-agnostic until `lore auth --migrate` (issue #07) ships;
   * see the call site for the active phrasing.
   */
  forwarded: RuntimeForwardedKey[]
}

export interface BuildMcpEnvOptions {
  /**
   * Skip the `LORE_CONFIG_ROOT` static entry. Used by the Yarn-PnP
   * shape because committed `.mcp.json` / `.cursor/mcp.json` /
   * `.codex/config.toml` files are workspace-shared across
   * developers, and an absolute machine path (`/Users/foo/myrepo`)
   * leaks one developer's checkout into the others'. Under PnP
   * launches via `yarn run -T lore mcp`, the spawned MCP server's
   * cwd is the workspace root — `findConfigFile(cwd)` walks
   * upward from there and resolves `.lore.yaml` without help.
   * Bare-bin (non-PnP) installs keep the static because the host's
   * spawn cwd may not match the operator's vault directory.
   */
  omitConfigRoot?: boolean
  /**
   * Which `resolveAuth` source the install-time CLI landed on. When
   * set to `"ntn-auth-json"`, the auth-token placeholders in
   * `RUNTIME_FORWARDED_AUTH_TOKEN_KEYS` are *not* emitted into the
   * MCP entry's `env` block — the spawned MCP server's `resolveAuth`
   * picks the same ntn path on its own at startup, so the
   * placeholders only fingerprint the operator's install-time shell
   * and produce host-validator warnings (e.g. Claude Code's
   * `/doctor`) when the underlying env vars later unset.
   *
   * Other sources (`env-notion-api-token`, `env-lore-notion-token`,
   * `config-auth-token`) keep the legacy conditional-forward
   * behavior: a placeholder is still emitted for whichever auth-token
   * env var the operator had set at install time, because their
   * spawned MCP server's `resolveAuth` cannot fall back to ntn the
   * way an `ntn-auth-json` install can. `undefined` (no opinion) also
   * preserves the pre-fix behavior — used by the print-config and
   * legacy-forwarded-note callers when they don't have an auth source
   * to consult.
   */
  authSource?: AuthSource
}

/**
 * Build the env map written into MCP entries (Claude / Cursor / Codex).
 *
 * Source-of-truth precedence matches `resolveAuth` (`src/config.ts`)
 * so the MCP server resolves identically to the CLI: NOTION_API_TOKEN
 * (env, canonical) > ntn-resolved (`auth.json`, no install-time
 * forwarding required) > LORE_NOTION_TOKEN (env, soft-deprecated) >
 * `auth.token` in `.lore.yaml` (soft-deprecated).
 *
 * Forwarding posture in 0.10.0:
 * - **Conditional**: each `RUNTIME_FORWARDED_KEYS` entry forwards
 *   only when the operator has that key set in their install-time
 *   env. The MCP server re-runs `resolveAuth` at startup, so a
 *   committed entry never carries a literal token value — only
 *   `${VAR}` placeholders the host resolves at runtime from
 *   operator env.
 * - **ntn-source suppression**: when `options.authSource ===
 *   "ntn-auth-json"`, the auth-token keys
 *   (`RUNTIME_FORWARDED_AUTH_TOKEN_KEYS`) are NOT forwarded even if
 *   set in the install-time env. The spawned MCP server's
 *   `resolveAuth` picks the same `ntn-auth-json` path on its own
 *   from `~/.config/notion/auth.json` (path 2), so the placeholders
 *   would fingerprint the operator's install-time shell and produce
 *   host-validator warnings (e.g. Claude Code `/doctor`'s "Missing
 *   environment variables") when the underlying vars later unset.
 *   Environment selectors (`NOTION_ENV`, `NOTION_BASE_URL`, etc.)
 *   and `LORE_USER_NAME` keep forwarding regardless of source —
 *   they're operator inputs orthogonal to token resolution.
 * - **Static `LORE_SUPPRESS_DEPRECATIONS=1`** always forwards (it's
 *   a literal "1", not machine-specific).
 * - **Static `LORE_CONFIG_ROOT`** forwards by default but omits
 *   under `omitConfigRoot: true` (the PnP path; see
 *   `BuildMcpEnvOptions`).
 *
 * Claude / Cursor consumers merge `staticEnv` into `env` directly.
 * Codex prefixes `staticEnv` entries onto its `bash -lc` launch
 * command (its `env_vars = [...]` shape can't carry literal values).
 *
 * `envSource` is injectable for test determinism; production callers
 * use `process.env`.
 */
export function buildMcpEnv(
  configRoot: string,
  envSource: NodeJS.ProcessEnv = process.env,
  options: BuildMcpEnvOptions = {},
): McpEnvBuild {
  const env: Record<string, string> = {}
  const forwarded: RuntimeForwardedKey[] = []
  const skipAuthTokens = options.authSource === "ntn-auth-json"
  const authTokenKeys: ReadonlySet<RuntimeForwardedKey> = new Set(
    RUNTIME_FORWARDED_AUTH_TOKEN_KEYS,
  )

  for (const key of RUNTIME_FORWARDED_KEYS) {
    if (skipAuthTokens && authTokenKeys.has(key)) continue
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

  return { env, staticEnv, forwarded }
}

function resolvePkgRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..")
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

function encodeProjectPath(absPath: string): string {
  return absPath.replace(/\//g, "-")
}

interface ClaudeMcpEntry {
  command: string
  args: string[]
  /**
   * Absolute (or `${HOME}`-prefixed) directory the legacy launcher cd's
   * into before invoking `node dist/mcp.js`. Bin-dispatch entries omit
   * this field — the host assistant's launch cwd (typically the project
   * root) is correct for `.lore.yaml` discovery, and pinning a specific
   * cwd would defeat the portability the bin-dispatch shape provides.
   */
  cwd?: string
  env: Record<string, string>
}

/**
 * Merge the Claude / Cursor `env` block. Both hosts accept literal
 * values alongside `${VAR}` placeholders, so static and runtime
 * entries collapse into the single `env` map. Static wins on any
 * collision (defensive — the two key sets shouldn't overlap by
 * design).
 */
function mergeMcpEnvForClaudeOrCursor(build: McpEnvBuild): Record<string, string> {
  return { ...build.env, ...build.staticEnv }
}

/**
 * Build the bin-dispatch `.mcp.json` entry for Lore. Emits
 * `{ command: "lore", args: ["mcp"], env: ... }` for `shape: "bare"`
 * (default), or `{ command: "yarn", args: ["lore", "mcp"], env: ... }`
 * for `shape: "yarn"` (Yarn Berry PnP consumers — see
 * `BinDispatchShape`). The env block carries:
 *   - Conditional `${NOTION_API_TOKEN}` / `${LORE_NOTION_TOKEN}` /
 *     `${LORE_NOTION_BASE_URL}` placeholders for keys the operator
 *     had set at install time.
 *   - Always-on `LORE_CONFIG_ROOT` (literal vault directory) and
 *     `LORE_SUPPRESS_DEPRECATIONS=1`.
 *
 * Hosts resolve `lore` through the consumer repo's
 * `node_modules/.bin/lore` symlink in the bare shape, or through
 * `yarn run lore` PnPAPI resolution in the yarn shape. Both produce
 * committed config that is portable across every engineer's checkout
 * regardless of the absolute path of the consumer repo on disk.
 */
export function buildClaudeMcpEntry(
  shape: BinDispatchShape = "bare",
  configRoot: string = process.cwd(),
  envSource: NodeJS.ProcessEnv = process.env,
  authSource?: AuthSource,
): ClaudeMcpEntry {
  const build = buildMcpEnv(configRoot, envSource, {
    // PnP entries are committed to the workspace root and shared
    // across developers; an absolute `LORE_CONFIG_ROOT` would leak
    // one developer's machine path into everyone else's checkout.
    // The `yarn run -T` launch always lands at workspace root, so
    // the spawned MCP server's `findConfigFile(cwd)` walk resolves
    // `.lore.yaml` without help.
    omitConfigRoot: shape === "yarn",
    authSource,
  })
  const env = mergeMcpEnvForClaudeOrCursor(build)
  if (shape === "yarn") {
    return { command: "yarn", args: ["run", "-T", "lore", "mcp"], env }
  }
  return { command: "lore", args: ["mcp"], env }
}

/**
 * Legacy absolute-path `.mcp.json` shape used by `~/.lore` consumers
 * pre-0.11.0. Preserved through 0.11.x for the deprecation window;
 * `lore install --legacy-paths` opts back in. Targeted for removal in
 * 0.12.0 alongside the standalone `dist/mcp.js` tsup entry.
 *
 * The 0.10.0 ntn-first env shape applies on this path too — the MCP
 * server's startup `resolveAuth` consults `LORE_CONFIG_ROOT` to find
 * `.lore.yaml` regardless of which launch shape the host uses.
 */
export function buildLegacyClaudeMcpEntry(
  mcpJsPath: string,
  cwd: string,
  configRoot: string = process.cwd(),
  envSource: NodeJS.ProcessEnv = process.env,
  authSource?: AuthSource,
): ClaudeMcpEntry {
  const build = buildMcpEnv(configRoot, envSource, { authSource })
  return {
    command: "node",
    args: [mcpJsPath],
    cwd,
    env: mergeMcpEnvForClaudeOrCursor(build),
  }
}

/**
 * Cursor's `.cursor/mcp.json` schema accepts the same `command` / `args` /
 * `cwd` / `env` shape as Claude Code's `.mcp.json`. The two formats are
 * documented as JSON-compatible; the only practical difference is the file
 * location and the lack of session-end hook integration on the Cursor side.
 *
 * Source: Cursor MCP docs at https://docs.cursor.com/context/mcp.
 * Verify against current Cursor docs if the schema needs updating.
 */
export interface CursorMcpEntry {
  command: string
  args: string[]
  cwd?: string
  env: Record<string, string>
}

/**
 * Options for `buildCursorMcpEntry`.
 *
 * `useGlobalScope` flips the entry from "committed project-scoped
 * config" semantics to "machine-local global config" semantics. The
 * project-scoped default writes the entry into
 * `<project>/.cursor/mcp.json` which is shared across every engineer
 * with a checkout, so the PnP shape omits machine-specific anchors
 * (`cwd`, `LORE_CONFIG_ROOT`) and trusts Cursor's launch cwd to land
 * inside the PnP project. The global shape writes to
 * `~/.cursor/mcp.json` which is per-machine — Cursor launches the
 * server from its own process cwd at fire time, which is NOT
 * guaranteed to be inside any PnP project. Under PnP + global, the
 * entry has to anchor itself with `cwd` (so `yarn run -T` finds the
 * right `.pnp.cjs` upward) and keep `LORE_CONFIG_ROOT` (so the
 * spawned MCP child resolves the right `.lore.yaml`); without those
 * anchors, the global launcher fires from Cursor's process cwd and
 * neither yarn nor `.lore.yaml` discovery succeeds.
 *
 * `launchCwd` and `LORE_CONFIG_ROOT` derive from DIFFERENT roots and
 * the function won't conflate them:
 *
 * - `launchCwd` must sit at or below the Yarn PnP workspace root
 *   (the directory containing `.pnp.cjs`) so `yarn run -T`'s upward
 *   walk resolves the right project. `prepareInstallContext`
 *   guarantees this by passing `context.projectDir` — the exact
 *   directory `detectYarnPnp` was called against, so when it
 *   returned `true`, the directory is at-or-below the PnP root.
 * - `LORE_CONFIG_ROOT` (sourced from `configRoot`) must point at
 *   the `.lore.yaml` directory. `findConfigFile` walks upward, and
 *   `.lore.yaml` can legitimately live ABOVE the PnP workspace —
 *   for example, a monorepo umbrella containing multiple PnP
 *   workspaces with one shared `.lore.yaml` at the umbrella root.
 *   In that layout, deriving `cwd` from `configRoot` would anchor
 *   the launcher to a directory OUTSIDE the PnP workspace, and
 *   `yarn run -T` would never walk into `.pnp.cjs` territory.
 *
 * `launchCwd` defaults to `configRoot` when omitted — the safe
 * default for the typical case where `.lore.yaml` lives inside the
 * PnP workspace. Production callers (`runCursorInstall`) pass
 * `context.projectDir` explicitly so the split-roots case (config
 * above workspace) doesn't break.
 *
 * The bare (non-PnP) shape already retains `LORE_CONFIG_ROOT` on
 * both project and global paths because `omitConfigRoot` only
 * triggers under `shape === "yarn"`. The bare path doesn't need
 * `cwd` because `lore` is on PATH and the spawned MCP child reads
 * `LORE_CONFIG_ROOT` to short-circuit config discovery; `launchCwd`
 * is ignored on the bare path.
 */
export interface BuildCursorMcpEntryOptions {
  useGlobalScope?: boolean
  launchCwd?: string
  /**
   * Pass-through to `buildMcpEnv`'s `authSource` option. Suppresses
   * auth-token placeholders when the install-time CLI resolved its
   * token via `ntn-auth-json`. See `BuildMcpEnvOptions.authSource`
   * for the rationale.
   */
  authSource?: AuthSource
}

export function buildCursorMcpEntry(
  shape: BinDispatchShape = "bare",
  configRoot: string = process.cwd(),
  envSource: NodeJS.ProcessEnv = process.env,
  options: BuildCursorMcpEntryOptions = {},
): CursorMcpEntry {
  const useGlobalScope = options.useGlobalScope ?? false
  // PnP omission rationale only applies to committed config. Under
  // global scope the entry is machine-local; an absolute
  // `LORE_CONFIG_ROOT` is the right anchor, not a portability leak.
  const omitConfigRoot = shape === "yarn" && !useGlobalScope
  const build = buildMcpEnv(configRoot, envSource, {
    omitConfigRoot,
    authSource: options.authSource,
  })
  const env = mergeMcpEnvForClaudeOrCursor(build)
  if (shape === "yarn") {
    const entry: CursorMcpEntry = {
      command: "yarn",
      args: ["run", "-T", "lore", "mcp"],
      env,
    }
    if (useGlobalScope) {
      // Anchor `yarn run -T` to a directory inside the PnP
      // workspace. `launchCwd` (typically `context.projectDir`)
      // can differ from `configRoot` when `.lore.yaml` lives
      // above the workspace. See `BuildCursorMcpEntryOptions`
      // for the split-roots rationale.
      entry.cwd = toPortablePath(options.launchCwd ?? configRoot)
    }
    return entry
  }
  return { command: "lore", args: ["mcp"], env }
}

export function buildLegacyCursorMcpEntry(
  mcpJsPath: string,
  cwd: string,
  configRoot: string = process.cwd(),
  envSource: NodeJS.ProcessEnv = process.env,
  authSource?: AuthSource,
): CursorMcpEntry {
  const build = buildMcpEnv(configRoot, envSource, { authSource })
  return {
    command: "node",
    args: [mcpJsPath],
    cwd,
    env: mergeMcpEnvForClaudeOrCursor(build),
  }
}

/**
 * Resolve the on-disk path for Cursor's `mcp.json`. Cursor reads MCP servers
 * from `<projectDir>/.cursor/mcp.json` (project-scoped, takes precedence) and
 * `~/.cursor/mcp.json` (global, fallback) — mirroring Claude Code's
 * project-vs-user split. `useGlobalScope` opts into the global file (driven
 * by `--cursor-global`).
 */
export function resolveCursorMcpPath(projectDir: string, useGlobalScope: boolean): string {
  return useGlobalScope
    ? join(homedir(), ".cursor", "mcp.json")
    : join(projectDir, ".cursor", "mcp.json")
}

/**
 * Build the stderr note printed when `--cursor-global` is passed alongside
 * a `--client` value that doesn't include Cursor. Returns `null` when the
 * flag combination is meaningful (Cursor is in scope) so the caller can
 * skip emitting noise. Soft-worded by design — an operator who scripted
 * `--cursor-global` ahead of an `--client all` rollout shouldn't get a
 * chiding message.
 *
 * Pure so unit tests can pin the exact wording and the Cursor / non-Cursor
 * branch decisions without spinning up Commander.
 */
export function buildCursorGlobalIgnoredNotice(
  cursorGlobal: boolean | undefined,
  client: InstallClient,
): string | null {
  if (!cursorGlobal) return null
  if (client === "cursor" || client === "all") return null
  return `Note: --cursor-global has no effect under --client ${client} (Cursor not selected); ignored.`
}

function formatTomlArray(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`
}

/**
 * Build the bin-dispatch `[mcp_servers.lore]` block for
 * `.codex/config.toml`. Codex's MCP launcher resolves `command` against
 * the same PATH the legacy `bash -lc 'node ...'` wrapper relied on for
 * `node` resolution, so the bare form `command = "lore"` works as long
 * as `lore` is on PATH (npm / Yarn 1 consumers via
 * `node_modules/.bin/lore`). Yarn Berry PnP consumers don't populate
 * `node_modules/.bin`, so they need `shape: "yarn"` which emits
 * `command = "yarn"` / `args = ["lore", "mcp"]` and lets Yarn's
 * PnPAPI resolve the bin.
 */
/**
 * POSIX single-quote a value for safe interpolation into a `bash -lc`
 * argument. Single quotes inhibit ALL shell expansion ($, backtick,
 * `\`, history) — the only character that needs escaping inside
 * single quotes is `'` itself, which the helper close-escape-reopens
 * via `'\''`.
 *
 * Why not double quotes / `JSON.stringify`? Double quotes preserve
 * spaces but do NOT inhibit `$` / backtick / `\` interpretation under
 * `bash -lc`. A vault path like `/Users/foo/$bar/project` would have
 * `$bar` parameter-expanded to empty before the assignment ran.
 * Single-quoting closes that hole.
 */
export function shellQuoteSingle(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Quote a path that may carry the `${HOME}` portability marker for
 * safe interpolation into a `bash -lc` argument. Two competing
 * requirements:
 *
 * 1. **`${HOME}` MUST expand at bash time.** `toPortablePath` rewrites
 *    `/Users/foo/...` into `${HOME}/...` so committed config is
 *    portable across machines — bash receives the literal string
 *    `${HOME}/.lore/dist/mcp.js`, expands `${HOME}` to the runtime
 *    operator's home, then runs `node /Users/runtime/.lore/dist/mcp.js`.
 *    Wrapping the entire path in single quotes turns `${HOME}` into a
 *    literal four-character string and `node` can't find the file.
 * 2. **Other shell metacharacters MUST NOT expand.** Same hazard
 *    `shellQuoteSingle` already addresses for the static env prefix —
 *    a path containing `$build_dir` or `` `whoami` `` must reach
 *    `node` as a literal, not be re-interpreted by bash.
 *
 * Resolution: split on the `${HOME}` prefix. The prefix gets emitted
 * **double-quoted** (so bash expands it) and the suffix gets emitted
 * **single-quoted** (so bash treats every other metachar as literal).
 * Bash's adjacent-string concatenation joins the two halves into a
 * single argument, so `node "${HOME}"'/.../$bar/mcp.js'` becomes one
 * argv entry pointing at `/Users/runtime/.../$bar/mcp.js`.
 *
 * Paths that don't carry the `${HOME}` marker (e.g., a Lore install
 * outside the operator's home) fall through to plain
 * `shellQuoteSingle` — there's no expansion to preserve.
 */
export function shellQuotePortablePath(path: string): string {
  if (path === "${HOME}") {
    return `"\${HOME}"`
  }
  if (path.startsWith("${HOME}/")) {
    const suffix = path.slice("${HOME}".length)
    return `"\${HOME}"${shellQuoteSingle(suffix)}`
  }
  return shellQuoteSingle(path)
}

/**
 * Compose a `bash -lc` launch command with the build's static
 * `KEY=value` pairs prepended. Codex's TOML shape (`env_vars =
 * [...]`) carries name-only references to runtime env, so static
 * values like `LORE_CONFIG_ROOT` cannot live there; they go on the
 * shell command line instead. Values are POSIX single-quoted (see
 * `shellQuoteSingle`) so paths containing `$`, backticks, or `\` do
 * NOT trigger shell expansion when bash re-evaluates the line.
 */
function codexLaunchCommand(staticEnv: Record<string, string>, command: string): string {
  const prefix = Object.entries(staticEnv)
    .map(([key, value]) => `${key}=${shellQuoteSingle(value)}`)
    .join(" ")
  return prefix ? `${prefix} ${command}` : command
}

/**
 * Codex `env_vars = [...]` ordering follows `RUNTIME_FORWARDED_KEYS`
 * declaration order (NOT `Object.keys(build.env)` insertion order).
 * Pinning order on the source-of-truth array keeps the emitted TOML
 * deterministic across refactors that might shuffle the build of
 * `build.env`.
 */
function runtimeForwardedKeys(build: McpEnvBuild): string[] {
  return RUNTIME_FORWARDED_KEYS.filter((key) => key in build.env)
}

export function buildCodexMcpSection(
  shape: BinDispatchShape = "bare",
  configRoot: string = process.cwd(),
  envSource: NodeJS.ProcessEnv = process.env,
  authSource?: AuthSource,
): string {
  const build = buildMcpEnv(configRoot, envSource, {
    omitConfigRoot: shape === "yarn",
    authSource,
  })
  const baseCommand = shape === "yarn" ? "yarn run -T lore mcp" : "lore mcp"
  const launchCommand = codexLaunchCommand(build.staticEnv, baseCommand)
  return [
    "[mcp_servers.lore]",
    'command = "bash"',
    `args = ["-lc", ${JSON.stringify(launchCommand)}]`,
    `env_vars = ${formatTomlArray(runtimeForwardedKeys(build))}`,
  ].join("\n")
}

export function buildLegacyCodexMcpSection(
  mcpJsPath: string,
  configRoot: string = process.cwd(),
  envSource: NodeJS.ProcessEnv = process.env,
  authSource?: AuthSource,
): string {
  const portableMcpJsPath = toPortablePath(mcpJsPath)
  const build = buildMcpEnv(configRoot, envSource, { authSource })
  // The mcp.js path is interpolated INTO the `bash -lc` arg string,
  // so it must be quoted to inhibit shell re-interpretation — but
  // with the wrinkle that `toPortablePath` may have rewritten the
  // path into a `${HOME}/...` portability marker, and that marker
  // MUST be allowed to expand at bash time (otherwise the committed
  // config carries a literal four-character string `${HOME}` to
  // node, which can't find the file). `shellQuotePortablePath`
  // resolves the conflict by emitting `"${HOME}"'/<rest>'` —
  // double-quoted prefix bash expands, single-quoted suffix bash
  // treats as literal. Plain `shellQuoteSingle` would over-quote
  // the prefix and break portable installs; `JSON.stringify` would
  // under-quote the suffix and re-introduce the original injection
  // hazard. The bin-dispatch path (`buildCodexMcpSection`) doesn't
  // hit this because its tail is a literal command name, not a
  // path — only the legacy `node <path>` shape needs the home-aware
  // defense.
  const launchCommand = codexLaunchCommand(
    build.staticEnv,
    `node ${shellQuotePortablePath(portableMcpJsPath)}`,
  )

  return [
    "[mcp_servers.lore]",
    'command = "bash"',
    `args = ["-lc", ${JSON.stringify(launchCommand)}]`,
    `env_vars = ${formatTomlArray(runtimeForwardedKeys(build))}`,
  ].join("\n")
}

/**
 * Env var the hook helpers read via `deriveAgentName` to stamp `Agent:` on
 * saved memories. Codex has no runtime marker equivalent to Claude Code's
 * `CLAUDECODE=1`, so the installer injects this prefix into the hook
 * command itself. Other third-party agent integrations (Cline, Cursor,
 * Aider) should follow the same convention.
 */
const CODEX_AGENT_ENV_PREFIX = "LORE_AGENT_NAME=Codex "

/**
 * Build the shell-string form of a Codex hook invocation with the
 * `LORE_AGENT_NAME` override baked in.
 *
 * Load-bearing assumption: Codex executes `hooks.json` `type: "command"`
 * entries through a POSIX shell (`/bin/sh` or equivalent), so a leading
 * `VAR=VALUE ` pair is parsed as a single-command env assignment. That is
 * the same convention `buildCodexMcpSection` relies on when wrapping the
 * MCP launcher in `bash -lc`. If a future Codex release executes hook
 * commands via `execve` with no shell, this prefix would be parsed as
 * argv[0] and every Codex install would silently stop firing hooks — a
 * visible regression we'd catch in the next Codex upgrade test. Worth
 * confirming against the Codex hook spec when it stabilizes.
 *
 * **Windows caveat**: `cmd.exe` does not parse `VAR=VALUE cmd` as an env
 * assignment. If Codex supports Windows hook execution via `cmd.exe`, this
 * prefix will be wrong there. Codex is currently POSIX-only (macOS /
 * Linux) per the integration docs, so the hook installer targets that
 * baseline; revisit if Windows support ships.
 */
/**
 * Build the bin-dispatch shell-string command for a Codex hook event.
 * Codex executes `hooks.json` `type: "command"` entries through `/bin/sh`
 * (the env-prefix shape `LORE_AGENT_NAME=Codex ...` depends on it), so
 * the bin-dispatch form keeps the prefix and trades the quoted absolute
 * `.sh` path for a `lore hooks <event>` invocation. PATH must include
 * the consumer repo's `node_modules/.bin` for `lore` to resolve at
 * hook-fire time — Claude Code and many shells set this up
 * automatically; if Codex's hook context doesn't, operators may need to
 * fall back to `--legacy-paths` until Codex's hook runner exposes a
 * project-local PATH hook.
 */
/**
 * Build the bin-dispatch shell-string command Claude registers for a
 * hook event. Two layered concerns:
 *
 * - **`cd "$CLAUDE_PROJECT_DIR"` prefix.** Claude Code's hook runner
 *   fires hook commands with cwd set to whatever Claude Code's
 *   process happens to have at fire time — frequently the binary's
 *   install directory or the user's `~`, NOT the project root. Lore's
 *   hook helpers walk upward from `process.cwd()` to find
 *   `.lore.yaml`; without anchoring, a hook fired from the wrong cwd
 *   resolves the wrong vault (or fails entirely on a fresh laptop).
 *   Claude Code exposes the project-root path via `$CLAUDE_PROJECT_DIR`
 *   for exactly this case. The literal `$` in the emitted command
 *   stays unexpanded by Lore's writer (it's a JSON string-valued
 *   field in `settings.json`); Claude's hook shell substitutes it at
 *   fire time.
 * - **Yarn-PnP shape.** `yarn run -T lore` (top-level) resolves the
 *   workspace-root binary even when the hook fires from a nested
 *   workspace package's cwd. Bare `yarn lore` resolves only against
 *   the cwd's `package.json` and fails on subdirectory cwds —
 *   exactly the case the `cd "$CLAUDE_PROJECT_DIR"` wrapper exposes.
 */
export function buildClaudeHookCommand(
  eventName: HookEventName,
  shape: BinDispatchShape = "bare",
): string {
  const tail =
    shape === "yarn" ? `yarn run -T lore hooks ${eventName}` : `lore hooks ${eventName}`
  return `cd "$CLAUDE_PROJECT_DIR" && ${tail}`
}

/**
 * Codex hook command. Codex's hook runner already exposes the
 * project root via Codex's own context (`.codex/hooks.json` is
 * trusted-project-scoped, and Codex's hook shell launches with the
 * project as cwd by convention), so the `cd` prefix that Claude
 * needs isn't required here. The yarn-PnP shape uses `yarn run -T`
 * for the same workspace-root resolution reason that the Claude
 * variant does.
 */
export function buildCodexHookCommand(
  eventName: HookEventName,
  shape: BinDispatchShape = "bare",
): string {
  const tail =
    shape === "yarn" ? `yarn run -T lore hooks ${eventName}` : `lore hooks ${eventName}`
  return `${CODEX_AGENT_ENV_PREFIX}${tail}`
}

export function buildLegacyCodexHookCommand(scriptPath: string): string {
  return CODEX_AGENT_ENV_PREFIX + JSON.stringify(toPortablePath(scriptPath))
}

/**
 * Hook event names the bin-dispatch surface accepts. The closed set
 * exists so `buildClaudeHookCommand` / `buildCodexHookCommand` can't be
 * called with an arbitrary string — a typo'd event name would silently
 * produce a hook command that the helper rejects at runtime, and the
 * detector wouldn't recognize it as Lore-owned. The four values cover
 * the entire deploy surface today: `wakeup` (UserPromptSubmit), `autosave`
 * (Stop), and `session-end` (compatibility shim).
 */
export type HookEventName = "wakeup" | "autosave" | "session-end"

/**
 * Structural equality for plain JSON-ish values. Used to decide whether an
 * on-disk config entry already matches the entry Lore would write now.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== "object") return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj)
  const bKeys = Object.keys(bObj)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false
    if (!deepEqual(aObj[key], bObj[key])) return false
  }
  return true
}

/**
 * Rewrite an absolute path under the user's home directory into a portable
 * `${HOME}`-prefixed form for project config that may be committed and shared.
 */
export function toPortablePath(absPath: string): string {
  const home = homedir()
  // A home of "/" would turn every absolute path into a `${HOME}` path.
  if (home === "/" || home === "") return absPath
  if (absPath === home) return "${HOME}"
  const prefix = home.endsWith("/") ? home : home + "/"
  if (absPath.startsWith(prefix)) {
    return "${HOME}/" + absPath.slice(prefix.length)
  }
  return absPath
}

/**
 * Display-format an absolute path, replacing the user's home directory with
 * `~`. Anchors at the home prefix so a path like
 * `/Users/foo/work/Users/foo/legacy` doesn't get its inner occurrence
 * mangled — the unanchored `String.replace(homedir(), "~")` shortcut hits
 * the first match, which may be the wrong one.
 */
export function displayHomePath(absPath: string): string {
  const home = homedir()
  if (home === "/" || home === "") return absPath
  if (absPath === home) return "~"
  const prefix = home.endsWith("/") ? home : home + "/"
  if (absPath.startsWith(prefix)) {
    return "~/" + absPath.slice(prefix.length)
  }
  return absPath
}

async function readJsonSafe(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(filePath, "utf-8")
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch (err) {
      throw new Error(
        `Failed to parse ${filePath}: ${err instanceof Error ? err.message : err}`,
        { cause: err },
      )
    }
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "ENOENT") return {}
    throw err
  }
}

async function readTextSafe(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf-8")
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "ENOENT") return ""
    throw err
  }
}

async function writeJsonFile(
  filePath: string,
  data: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  // Write to a sibling temp file and rename so a failed write never leaves a
  // half-written config on disk.
  const tmpPath = `${filePath}.${process.pid}.tmp`
  try {
    await writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8")
    await rename(tmpPath, filePath)
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    throw err
  }
}

async function writeTextFile(filePath: string, data: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.tmp`
  const normalized = data.endsWith("\n") ? data : data + "\n"
  try {
    await writeFile(tmpPath, normalized, "utf-8")
    await rename(tmpPath, filePath)
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    throw err
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

async function confirm(
  rl: ReturnType<typeof createInterface> | null,
  message: string,
  defaultYes = true,
): Promise<boolean> {
  if (!rl) return defaultYes
  const suffix = defaultYes ? "[Y/n]" : "[y/N]"
  const answer = await rl.question(`${message} ${suffix} `)
  const normalized = answer.trim().toLowerCase()
  if (normalized === "") return defaultYes
  return normalized === "y" || normalized === "yes"
}

function statusLabel(status: HookStatus, legacyPaths: boolean): string {
  if (status === "current") return "already installed"
  // Under `--legacy-paths`, a `legacy-current` entry IS the desired
  // shape — it should read as already installed. Under bin-dispatch
  // (default), the same entry is upgrade-eligible.
  if (status === "legacy-current") {
    return legacyPaths ? "already installed" : "legacy form (will upgrade)"
  }
  if (status === "stale") return "update available"
  return "not installed"
}

/**
 * Post-write status line for the install summary. Differentiates
 * "rewrote a legacy-current entry to bin-dispatch" from a fresh write
 * so an operator running `lore install` after upgrading from 0.10.x
 * sees an explicit signal that their committed config diff is
 * intentional, not a hand-rolled drift fix.
 */
function postWriteLabel(prevStatus: HookStatus, legacyPaths: boolean): string {
  if (prevStatus === "legacy-current" && !legacyPaths) {
    return "upgraded (legacy → bin-dispatch)"
  }
  return "installed"
}

export interface ClaudeHookEntry {
  matcher: string
  hooks: Array<{
    type: string
    command: string
    timeout?: number
    runOnce?: boolean
  }>
}

/**
 * Classify a Lore-owned Claude Code hook entry against the new
 * bin-dispatch shape and the legacy absolute-path shape.
 *
 * `binDispatchCommand` is what `buildClaudeHookCommand(event)`
 * produces (`lore hooks <event>`). `legacyExpectedPath` is the
 * canonical legacy path for the resolved `pkgRoot`
 * (`buildLegacyClaudeMcpEntry`-shaped). `scriptName` is the legacy
 * script-file name (`autosave.sh` / `wakeup.sh` / `session-end.sh`)
 * used to identify Lore-owned legacy entries even when the recorded
 * absolute path no longer matches the current install (a Lore checkout
 * that moved still classifies as `legacy-current` if the path resolves
 * the same way today, or `stale` otherwise).
 */
export function detectClaudeHook(
  entries: ClaudeHookEntry[] | undefined,
  scriptName: string,
  legacyExpectedPath: string,
  binDispatchCommand?: string,
): HookStatus {
  if (!entries) return "missing"

  // Pattern matching all known Lore-owned bin-dispatch shapes. Same
  // pattern `upsertClaudeHookCommand` uses for filter — so any entry
  // the upsert would strip on reinstall surfaces here as something
  // OTHER than `missing`, giving operators an accurate "update
  // available" status before the rewrite. Without this match, an
  // older `lore hooks <event>` (no cd anchor) would classify as
  // `missing`, status would say "not installed", but the upsert
  // would still strip it — confusing.
  const allBinDispatchShapes =
    /^(?:cd "\$CLAUDE_PROJECT_DIR" && )?(?:yarn (?:run -T )?)?lore hooks (?:wakeup|autosave|session-end)$/

  for (const entry of entries) {
    for (const hook of entry.hooks ?? []) {
      const cmd = hook.command
      if (typeof cmd !== "string") continue
      // Bin-dispatch form: exact match against the desired-write
      // shape is `current`; match against any other Lore-owned
      // bin-dispatch variant is `stale` (eligible for upgrade).
      if (binDispatchCommand && cmd === binDispatchCommand) return "current"
      if (allBinDispatchShapes.test(cmd)) return "stale"
      // Legacy absolute-path form: identified by the script-name
      // suffix, then classified by whether the full path matches the
      // resolved legacy path for this `pkgRoot`.
      if (cmd.endsWith(`/${scriptName}`)) {
        return cmd === legacyExpectedPath ? "legacy-current" : "stale"
      }
    }
  }
  return "missing"
}

/**
 * Upsert a Lore-owned Claude hook entry, accepting either the
 * bin-dispatch shape (`lore hooks <event>`) or a legacy absolute-path
 * shape on either side of the operation:
 *
 * - Filters existing entries by both shapes simultaneously: any entry
 *   whose command ends with `/<scriptName>` (legacy) OR exactly matches
 *   `lore hooks <event>` (bin-dispatch) is treated as Lore-owned and
 *   removed before the new entry is appended.
 * - Writes the new entry verbatim from `newCommand`, which the caller
 *   selects based on `context.legacyPaths`.
 *
 * The two-shape filter is what lets `lore install --legacy-paths` rewrite
 * a bin-dispatch entry back to legacy without leaving the bin-dispatch
 * entry behind, and lets default `lore install` rewrite a legacy entry
 * without leaving the legacy entry behind. Without the dual filter, an
 * upgrade or downgrade would land BOTH shapes in `Stop[]` and Claude
 * Code would fire both hooks back-to-back.
 */
function upsertClaudeHookCommand(
  existing: ClaudeHookEntry[] | undefined,
  scriptName: string,
  newCommand: string,
  config: { matcher: string; timeout?: number; runOnce?: boolean },
): ClaudeHookEntry[] {
  // Recognize ALL Lore-owned bin-dispatch hook shapes so an upgrade
  // path strips the old entry before writing the new one — preventing
  // duplicate Lore hooks from accumulating in `Stop[]` /
  // `UserPromptSubmit[]` across reinstalls. The shapes the pattern
  // covers:
  //   1. Pre-`cd` bare bin: `lore hooks <event>`
  //   2. Pre-`cd` yarn-PnP bin: `yarn lore hooks <event>`
  //   3. Current bare with cd-anchor: `cd "$CLAUDE_PROJECT_DIR" && lore hooks <event>`
  //   4. Current yarn-PnP with cd-anchor + `run -T`:
  //      `cd "$CLAUDE_PROJECT_DIR" && yarn run -T lore hooks <event>`
  //   5. Transition: `cd "..." && yarn lore hooks <event>`
  //      (cd added, yarn shape not yet upgraded)
  // The two halves are independent: the cd-prefix is optional, the
  // yarn variant has two acceptable command shapes (legacy `yarn
  // lore` and current `yarn run -T lore`). Matching all combinations
  // means any prior install can be cleanly upgraded.
  const binDispatchPattern =
    /^(?:cd "\$CLAUDE_PROJECT_DIR" && )?(?:yarn (?:run -T )?)?lore hooks (?:wakeup|autosave|session-end)$/
  const filtered = (existing ?? []).filter(
    (entry) =>
      !entry.hooks?.some((hook) => {
        if (typeof hook.command !== "string") return false
        if (hook.command.endsWith(`/${scriptName}`)) return true
        if (binDispatchPattern.test(hook.command)) return true
        return false
      }),
  )
  filtered.push({
    matcher: config.matcher,
    hooks: [{
      type: "command",
      command: newCommand,
      ...(config.timeout != null ? { timeout: config.timeout } : {}),
      ...(config.runOnce != null ? { runOnce: config.runOnce } : {}),
    }],
  })
  return filtered
}

/**
 * Whether the on-disk hook status matches the desired install shape.
 * Drives the "everything already installed" / "needs install" decision
 * across both Claude and Codex runners.
 *
 * - Default install (bin-dispatch): only `current` (bin-dispatch shape)
 *   counts as effectively current.
 * - `--legacy-paths`: only `legacy-current` counts. A bin-dispatch
 *   entry on disk is NOT effectively current under `--legacy-paths`,
 *   so the runner rewrites it back to the legacy shape — that's the
 *   intended downgrade semantic for an operator on `~/.lore` who
 *   accidentally upgraded.
 */
function isEffectivelyCurrent(status: HookStatus, legacyPaths: boolean): boolean {
  return legacyPaths ? status === "legacy-current" : status === "current"
}

export function removeClaudeScriptEntries(
  entries: ClaudeHookEntry[] | undefined,
  scriptName: string,
): ClaudeHookEntry[] | undefined {
  if (!entries) return undefined
  const filtered = entries.filter(
    (entry) =>
      !entry.hooks?.some(
        (hook) => typeof hook.command === "string" && hook.command.endsWith(`/${scriptName}`),
      ),
  )
  return filtered.length > 0 ? filtered : undefined
}

/**
 * Plan the SessionEnd cleanup that `lore install --client claude` applies on
 * reinstall. Pure function: takes the existing `hooks.SessionEnd` array,
 * returns the post-cleanup array (or `undefined` when every entry was
 * Lore-owned and the caller should `delete settings.hooks.SessionEnd`)
 * along with flags describing what was removed for status / "will remove"
 * messaging.
 *
 * 0.6.0 dropped active SessionEnd registration. Two historical Lore-owned
 * shapes need to be stripped: the post-P2-04 `session-end.sh` registration
 * and the older `autosave.sh`-on-SessionEnd legacy form. Unrelated user
 * hooks on `SessionEnd` are preserved entry-by-entry.
 *
 * Note: cleanup runs at the `ClaudeHookEntry` granularity. A hand-edited
 * settings.json that mixes a Lore-owned and a user-owned hook command in
 * a single `entry.hooks[]` array would lose the sibling on cleanup —
 * Lore's writer never produces that shape, but it's a sharp edge worth
 * being aware of.
 */
export function stripLoreOwnedSessionEndEntries(
  entries: ClaudeHookEntry[] | undefined,
): {
  /** Post-cleanup entries, or `undefined` when every entry was Lore-owned. */
  result: ClaudeHookEntry[] | undefined
  /** True when a `session-end.sh` registration was removed. */
  removedShim: boolean
  /** True when a legacy `autosave.sh`-on-SessionEnd registration was removed. */
  removedLegacyAutosave: boolean
} {
  const removedShim = detectClaudeHook(entries, "session-end.sh", "") !== "missing"
  const removedLegacyAutosave =
    detectClaudeHook(entries, "autosave.sh", "") !== "missing"

  let next = entries
  if (removedShim) next = removeClaudeScriptEntries(next, "session-end.sh")
  if (removedLegacyAutosave) next = removeClaudeScriptEntries(next, "autosave.sh")

  return {
    result: next && next.length > 0 ? next : undefined,
    removedShim,
    removedLegacyAutosave,
  }
}

interface CodexHookCommand {
  type: "command"
  command: string
  timeout?: number
  statusMessage?: string
}

export interface CodexHookEntry {
  matcher?: string
  hooks: CodexHookCommand[]
}

function stripShellQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Strip leading shell-style `KEY=VALUE` env assignments. Lets the Codex
 * hook detector look through the `LORE_AGENT_NAME=Codex ` prefix (and any
 * future additions) to find the script path at the tail of the command.
 *
 * Recognition pattern (load-bearing for third-party integrators):
 * - Keys must match `[A-Z_][A-Z0-9_]*` — conventional POSIX env-var spelling.
 *   Lower-case (`agent=codex`) will NOT be stripped; keep the convention.
 * - Values are bare tokens — no whitespace, no quotes (`[^\s"']+`). A
 *   quoted value like `LORE_AGENT_NAME="My Agent"` is rejected wholesale
 *   so the detector classifies the hook as unrecognized and reinstall
 *   replaces it, rather than partially stripping up to the first space
 *   and leaving a malformed command. Integrators who need a multi-word
 *   agent name should collapse it to a single token.
 * - Multiple sequential env prefixes are supported (`FOO=1 BAR=2 cmd`).
 *
 * Exported for unit-test coverage; not part of the CLI's public surface.
 */
export function stripShellEnvPrefix(command: string): string {
  return command.replace(/^(\s*[A-Z_][A-Z0-9_]*=[^\s"']+\s+)+/, "")
}

function commandTargetsScript(command: string, scriptName: string): boolean {
  const normalized = stripShellQuotes(stripShellEnvPrefix(command))
  return normalized === scriptName || normalized.endsWith(`/${scriptName}`)
}

/**
 * Classify a Lore-owned Codex hook entry. Mirrors `detectClaudeHook`'s
 * dual-shape recognition:
 *
 * - `binDispatchCommand` matches `LORE_AGENT_NAME=Codex lore hooks <event>`
 *   (the 0.11.0+ form `buildCodexHookCommand` produces).
 * - `legacyExpectedCommand` matches the canonical legacy form
 *   `LORE_AGENT_NAME=Codex "<absolute-path>/<script>.sh"` for the
 *   resolved `pkgRoot`. `scriptName` identifies Lore-owned legacy
 *   entries by tail.
 */
export function detectCodexHook(
  entries: CodexHookEntry[] | undefined,
  scriptName: string,
  legacyExpectedCommand: string,
  binDispatchCommand?: string,
): HookStatus {
  if (!entries) return "missing"

  // Same shape-coverage rationale as `detectClaudeHook` — recognize
  // pre-`yarn run -T` bin-dispatch entries as `stale` so the install
  // summary surfaces "update available" before the upsert strips
  // and rewrites them. Codex entries always carry the
  // `LORE_AGENT_NAME=Codex ` env prefix; the strip helper handles
  // any number of leading env assignments.
  const allBinDispatchTails =
    /^(?:yarn (?:run -T )?)?lore hooks (?:wakeup|autosave|session-end)$/

  for (const entry of entries) {
    for (const hook of entry.hooks ?? []) {
      const cmd = hook.command
      if (typeof cmd !== "string") continue
      if (binDispatchCommand && cmd === binDispatchCommand) return "current"
      // Recognize Lore-owned bin-dispatch entries that don't match
      // the desired-write shape — older `yarn lore` form, or any
      // other valid pre-`run -T` shape. Strip the LORE_AGENT_NAME
      // prefix first so the regex sees just the command tail.
      const tail = stripShellEnvPrefix(cmd)
      if (allBinDispatchTails.test(tail)) return "stale"
      if (commandTargetsScript(cmd, scriptName)) {
        return cmd === legacyExpectedCommand ? "legacy-current" : "stale"
      }
    }
  }
  return "missing"
}

/**
 * Append a Codex hook entry. Caller is expected to have already
 * stripped any prior Lore-owned entries (legacy and bin-dispatch) from
 * the target event via `stripCodexScriptFromAllEvents` and
 * `stripCodexBinDispatchHook` so this helper can stay a pure append.
 *
 * Pre-bin-dispatch this function did its own scriptName-based filter,
 * but with two recognizable shapes the filter would need to know about
 * both (and the runner already strips both before calling this), so the
 * pre-pass moved out and the helper became a strict append.
 */
function mergeCodexHookEntries(
  existing: CodexHookEntry[] | undefined,
  command: string,
  config: { matcher?: string; timeout?: number; statusMessage?: string },
): CodexHookEntry[] {
  const next = [...(existing ?? [])]
  next.push({
    ...(config.matcher ? { matcher: config.matcher } : {}),
    hooks: [{
      type: "command",
      command,
      ...(config.timeout != null ? { timeout: config.timeout } : {}),
      ...(config.statusMessage ? { statusMessage: config.statusMessage } : {}),
    }],
  })
  return next
}

/**
 * Remove every Codex hook entry whose command is a Lore-owned
 * bin-dispatch shape — current AND prior — for the given event. The
 * runner needs all variants stripped so flipping between shapes
 * (legacy `.sh` ↔ pre-`run -T` bare ↔ pre-`run -T` yarn ↔ current
 * `yarn run -T`) leaves only the single canonical entry behind.
 *
 * Detection uses the same regex-after-env-prefix-strip approach as
 * `detectCodexHook` so the strip and the detect agree on what
 * counts as Lore-owned.
 */
function stripCodexBinDispatchHook(
  hooks: Record<string, CodexHookEntry[]>,
  eventName: HookEventName,
): Record<string, CodexHookEntry[]> {
  const tailPattern = new RegExp(
    `^(?:yarn (?:run -T )?)?lore hooks ${eventName}$`,
  )
  const next: Record<string, CodexHookEntry[]> = {}
  for (const [event, entries] of Object.entries(hooks)) {
    const filtered = entries.filter(
      (entry) =>
        !entry.hooks?.some((hook) => {
          if (typeof hook.command !== "string") return false
          const tail = stripShellEnvPrefix(hook.command)
          return tailPattern.test(tail)
        }),
    )
    if (filtered.length > 0) next[event] = filtered
  }
  return next
}

function removeCodexScriptEntries(
  entries: CodexHookEntry[] | undefined,
  scriptName: string,
): CodexHookEntry[] | undefined {
  if (!entries) return undefined
  const filtered = entries.filter(
    (entry) =>
      !entry.hooks?.some(
        (hook) => typeof hook.command === "string" && commandTargetsScript(hook.command, scriptName),
      ),
  )
  return filtered.length > 0 ? filtered : undefined
}

function stripCodexScriptFromAllEvents(
  hooks: Record<string, CodexHookEntry[]>,
  scriptName: string,
): Record<string, CodexHookEntry[]> {
  const next: Record<string, CodexHookEntry[]> = {}
  for (const [eventName, entries] of Object.entries(hooks)) {
    const filtered = removeCodexScriptEntries(entries, scriptName)
    if (filtered) next[eventName] = filtered
  }
  return next
}

function splitTomlLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n")
  if (normalized === "") return []
  return normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n")
}

function joinTomlLines(lines: string[]): string {
  return lines.length > 0 ? lines.join("\n") + "\n" : ""
}

interface TomlSection {
  name: string
  start: number
  end: number
}

function parseTomlSections(text: string): TomlSection[] {
  const lines = splitTomlLines(text)
  const sections: TomlSection[] = []
  const headingPattern = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/

  for (let i = 0; i < lines.length; i++) {
    const match = headingPattern.exec(lines[i])
    if (!match) continue

    if (sections.length > 0) {
      sections[sections.length - 1].end = i
    }

    sections.push({
      name: match[1].trim(),
      start: i,
      end: lines.length,
    })
  }

  return sections
}

export function containsTomlArrayOfTables(text: string): boolean {
  return splitTomlLines(text).some((line) => /^\s*\[\[/.test(line))
}

function assertTomlSupportsLoreRewrite(text: string, filePath: string): void {
  if (!containsTomlArrayOfTables(text)) return
  const displayPath = displayHomePath(filePath)
  throw new Error(
    `${displayPath} contains TOML array-of-tables ([[...]]). ` +
      "lore install cannot safely rewrite that file yet; update the Lore sections manually instead.",
  )
}

function appendTomlBlock(text: string, block: string): string {
  const existing = text.trimEnd()
  const nextBlock = block.trim()
  if (existing === "") return nextBlock + "\n"
  return `${existing}\n\n${nextBlock}\n`
}

function removeTomlTableGroup(text: string, tablePrefix: string): string {
  const lines = splitTomlLines(text)
  const sections = parseTomlSections(text)
    .filter((section) => section.name === tablePrefix || section.name.startsWith(`${tablePrefix}.`))
    .sort((a, b) => b.start - a.start)

  for (const section of sections) {
    lines.splice(section.start, section.end - section.start)
  }

  return joinTomlLines(lines).replace(/\n{3,}/g, "\n\n")
}

function extractTomlTableGroup(text: string, tablePrefix: string): string | null {
  const lines = splitTomlLines(text)
  const matches = parseTomlSections(text).filter(
    (section) => section.name === tablePrefix || section.name.startsWith(`${tablePrefix}.`),
  )
  if (matches.length === 0) return null

  const start = matches[0].start
  const end = matches[matches.length - 1].end
  return lines.slice(start, end).join("\n")
}

function extractTomlKeyValue(
  text: string,
  tableName: string,
  key: string,
): string | undefined {
  const lines = splitTomlLines(text)
  const section = parseTomlSections(text).find((candidate) => candidate.name === tableName)
  if (!section) return undefined

  const keyPattern = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*(?:#.*)?$`)
  for (let i = section.start + 1; i < section.end; i++) {
    const match = keyPattern.exec(lines[i])
    if (match) return match[1].trim()
  }
  return undefined
}

function upsertTomlTableKey(
  text: string,
  tableName: string,
  key: string,
  value: string,
): string {
  const lines = splitTomlLines(text)
  const sections = parseTomlSections(text)
  const section = sections.find((candidate) => candidate.name === tableName)
  const keyPattern = new RegExp(`^\\s*${key}\\s*=`)

  if (!section) {
    return appendTomlBlock(text, `[${tableName}]\n${key} = ${value}`)
  }

  for (let i = section.start + 1; i < section.end; i++) {
    if (keyPattern.test(lines[i])) {
      lines[i] = `${key} = ${value}`
      return joinTomlLines(lines)
    }
  }

  lines.splice(section.end, 0, `${key} = ${value}`)
  return joinTomlLines(lines)
}

export interface InstallContext {
  projectDir: string
  pkgRoot: string
  /**
   * Resolved `.lore.yaml` directory — `findConfigFile(projectDir).root`
   * when a config exists, falling back to `projectDir` otherwise. This
   * is the value forwarded into the MCP entry as `LORE_CONFIG_ROOT` so
   * the spawned MCP server's `resolveAuth` walks the right `.lore.yaml`
   * regardless of the host's spawn-time cwd.
   */
  configRoot: string
  autosavePath: string
  wakeupPath: string
  mcpJsPath: string
  skipPrompts: boolean
  /**
   * `true`/`false` when `.lore.yaml` sets `hooks.wakeUp` explicitly; `null`
   * when no config exists yet or the flag is unset (hook default applies).
   */
  wakeUpConfig: boolean | null
  /**
   * `--legacy-paths` opt-in. When `true`, the install path emits the
   * 0.10.x absolute-path shape (`node ${HOME}/.lore/dist/mcp.js`,
   * `${HOME}/.lore/hooks/wakeup.sh`) and the prerequisite checks verify
   * `hooks/*.sh` exist. When `false` (default for 0.11.0+), the install
   * path emits the bin-dispatch shape (`lore mcp`, `lore hooks <event>`)
   * and the prerequisite checks skip the `.sh` verification entirely
   * because the bin-dispatch path doesn't depend on the legacy hook
   * scripts. Removal targeted for 0.12.0 alongside `hooks/*.sh` and the
   * standalone `dist/mcp.js` tsup entry.
   */
  legacyPaths: boolean
  /**
   * `--yarn-pnp` (auto-detected via `.pnp.cjs` marker). When `true`,
   * the install path emits the yarn-wrapped bin-dispatch shape
   * (`command: "yarn", args: ["run", "-T", "lore", "mcp"]` and
   * `yarn run -T lore hooks <event>`) so the host assistant can
   * invoke the lore bin through Yarn Berry / Yarn 4 PnP, which does
   * NOT populate `node_modules/.bin/`. The `run -T` (top-level) flag
   * resolves the workspace-root binary even when the host launches
   * from a nested workspace package's cwd. Ignored when
   * `legacyPaths === true` (legacy
   * shape predates the PnP question). Operators can force-disable via
   * `--no-yarn-pnp` if their consumer fixes PnP bin resolution
   * out-of-band.
   */
  yarnPnp: boolean
  /**
   * `resolveAuth` source the install-time prerequisites flow landed
   * on. Populated by `ensurePrerequisites` / `preflightAndReport` and
   * threaded into the per-client runners so they can pass it through
   * to `buildClaudeMcpEntry` / `buildCursorMcpEntry` /
   * `buildCodexMcpSection`. When set to `"ntn-auth-json"`, the build
   * helpers suppress the auth-token `${VAR}` placeholders that
   * otherwise produce host-validator warnings (e.g. Claude Code
   * `/doctor`'s "Missing environment variables") on every startup
   * after the operator's install-time shell drifts. `undefined` when
   * prereqs hasn't run (tests, `--print-config`) or auth resolution
   * failed — both cases preserve the pre-fix unconditional-forward
   * behavior so legacy operators never lose access by upgrading.
   */
  authSource?: AuthSource
}

/**
 * Read `hooks.wakeUp` from the project's `.lore.yaml`. Returns:
 *   - `true`/`false` when the flag is set explicitly
 *   - `null` when no config exists, the flag is unset, or the file fails to
 *     parse/validate — callers should treat `null` as "fall back to runtime
 *     default" and must not distinguish the three cases
 *
 * Parse/validation failures emit a stderr warning so a broken `.lore.yaml`
 * does not silently defeat the installer's `(disabled by config)` hint.
 */
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
        `[lore] Installer status may not reflect hooks.wakeUp — fix the config and re-run 'lore install'.\n`,
    )
    return null
  }
}

function wakeupStatusSuffix(wakeUpConfig: boolean | null): string {
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
export async function prepareInstallContext(
  opts: {
    yes?: boolean
    project?: string
    legacyPaths?: boolean
    yarnPnp?: boolean
  },
): Promise<InstallContext> {
  const projectDir = resolve(opts.project ?? process.cwd())
  const pkgRoot = resolvePkgRoot()
  const skipPrompts = opts.yes || !process.stdin.isTTY
  const legacyPaths = !!opts.legacyPaths
  // PnP auto-detection runs only on the bin-dispatch path. Under
  // `--legacy-paths` the absolute-path shape doesn't depend on PATH
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
  // launches the MCP server via lazy-import from `dist/cli.js` (which
  // tsup also bundles in the same `npm run build`); the legacy path
  // invokes `dist/mcp.js` directly. Either entry's existence proves the
  // build ran, so we keep the existing `dist/mcp.js` check as the
  // tripwire — checking the legacy entry is harmless on the default
  // path because both files ship together.
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
 * `--legacy-paths` opt-in path needs the .sh prerequisites verified.
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
      `Required hook scripts not found: ${missing.join(", ")}. Run 'npm run build' first.`,
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
 * Local to install.ts even though `--status` (#06) emits a similar
 * line — the two surfaces evolve separately and consolidation can
 * happen later if their wording converges.
 */
function describeAuthSource(source: AuthSource): string {
  switch (source) {
    case "env-notion-api-token":
      return "NOTION_API_TOKEN (env)"
    case "ntn-auth-json":
      return "ntn-issued (auth.json)"
    case "env-lore-notion-token":
      return "LORE_NOTION_TOKEN (env, legacy)"
    case "config-auth-token":
      return "auth.token in .lore.yaml (legacy)"
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
      "Non-interactive context detected. Pass --yes to confirm prompts non-interactively.",
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
}

interface NtnLoginRecovery {
  /**
   * Paste-ready shell command. The full prefix
   * (`NOTION_KEYRING=0`) is always present so the resulting token
   * lands in `auth.json` (file mode) rather than the macOS keychain
   * — Lore can't read the keychain, so a recovery command without
   * the env-var prefix would write to a place Lore can't see.
   *
   * `NOTION_ENV=<value>` is included when the env can be resolved
   * (operator's shell or `.lore.yaml`'s `auth.baseUrl` mapped to a
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
 *   2. **`.lore.yaml`'s `auth.baseUrl` is canonical** → infer env
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
  envSource: NodeJS.ProcessEnv = process.env,
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
 * Build a human-readable summary of the ntn environment selectors
 * the operator currently has set in their shell. Returns `undefined`
 * when no selectors are set (the implicit prod-default case — no
 * line worth printing).
 *
 * The line shape is `<env or url> (<source-name>)` so an operator
 * scanning prereqs output sees both the resolved value AND which
 * env var carried it. Helps when an operator forgot they had
 * `NOTION_BASE_URL` set in a stale shell rc.
 */
function describeNtnEnvSelectors(
  envSource: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const env = envSource["NOTION_ENV"]
  const baseUrl =
    envSource["LORE_NOTION_BASE_URL"] ||
    envSource["NOTION_BASE_URL"] ||
    envSource["NOTION_API_BASE_URL"]
  if (!env && !baseUrl) return undefined

  const parts: string[] = []
  if (env) parts.push(`NOTION_ENV=${env}`)
  if (baseUrl) {
    const sourceName = envSource["LORE_NOTION_BASE_URL"]
      ? "LORE_NOTION_BASE_URL"
      : envSource["NOTION_BASE_URL"]
        ? "NOTION_BASE_URL"
        : "NOTION_API_BASE_URL"
    parts.push(`${sourceName}=${baseUrl}`)
  }
  return parts.join(", ")
}

/**
 * Audit prerequisites for `lore install` and remediate when the
 * operator opts in.
 *
 * Three probes:
 *   1. **ntn installed**: probes via `isNtnInstalled` (memoized
 *      `execFileSync ntn --version`). On miss, offers
 *      `installNtn()` (curl-pipe-bash via the canonical
 *      `NTN_INSTALL_COMMAND`); operator must confirm explicitly.
 *   2. **ntn version**: non-blocking warning when
 *      `checkNtnVersion()` returns `"too-old"`. Lore never
 *      auto-upgrades — operators pin ntn versions for other tooling
 *      and we don't override that.
 *   3. **Auth source**: runs `resolveAuth(config, configRoot)` and
 *      reports the resolved source. On no-source-resolved, offers
 *      `runNtnLogin()` (which forces `NOTION_KEYRING=0` inside its
 *      own spawn so `auth.json` lands in file mode); operator
 *      confirms.
 *
 * Post-resolution preflight: when auth resolves AND `.lore.yaml`
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
 * `runNtnLogin()` and `installNtn()` (in `src/auth/ntn.ts`) force
 * `NOTION_KEYRING=0` inside their own spawn env, so the operator
 * never has to set the env var themselves for the install path.
 * Operators who later run `ntn login` directly (outside Lore)
 * without the env var hit ntn's keychain default — the runbook
 * (#05) documents this gotcha.
 */
export async function ensurePrerequisites(
  context: InstallContext,
  opts: EnsurePrerequisitesOptions = {},
): Promise<{ ready: boolean; authSource?: AuthSource }> {
  console.log("Checking prerequisites...")

  // 1. ntn install state. Offer auto-install on miss. The local
  // does not need to be reassigned post-install — the version check
  // below calls `getNtnVersion` directly (which probes via the same
  // memoized `execFileSync` and reflects the freshly installed
  // binary after `installNtn` clears the cache on success).
  const ntnInstalled = isNtnInstalled()
  console.log(`  ntn installed:        ${ntnInstalled ? "✓" : "✗"}`)
  if (!ntnInstalled) {
    console.log("")
    console.log("    ntn is required for Lore 0.10.x.")
    console.log("    Lore can install it via the canonical command:")
    console.log(`      ${NTN_INSTALL_COMMAND}`)
    console.log("")
    const ok = opts.yes ?? (await confirmPrompt("    Install ntn now? [Y/n] "))
    if (!ok) {
      console.log("    Skipping install. Re-run after installing ntn manually:")
      console.log(`      ${NTN_INSTALL_COMMAND}`)
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
      `  ntn version:          ! ${installedVersion ?? "unknown"} (below tested minimum ${MIN_NTN_VERSION})`,
    )
    console.log("    Lore will proceed, but consider running `ntn update` if you")
    console.log("    hit auth resolution issues.")
  } else if (versionStatus === "ok") {
    console.log(`  ntn version:          ✓ ${installedVersion ?? "unknown"}`)
  }

  // Surface ntn environment selectors so dev / staging operators see
  // which env their install will resolve against. The MCP entry
  // forwards these names (`RUNTIME_FORWARDED_KEYS`), and ntn's own
  // `runNtnLogin` spawn inherits them via `process.env` spread —
  // showing the resolved values up front prevents the "I thought I
  // was logging into dev but the install captured prod" footgun.
  const envSelectors = describeNtnEnvSelectors()
  if (envSelectors) {
    console.log(`  Notion environment:   ${envSelectors}`)
  }

  // 3. Auth resolution. Offer ntn login on no-source-resolved.
  //
  // The catch around `resolveAuth` is narrow on purpose: a malformed
  // `.lore.yaml` is a different problem from "no auth token", and
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
    console.log(`  Auth source:          ✓ ${describeAuthSource(auth.source)}`)
    if (
      auth.source === "env-lore-notion-token" ||
      auth.source === "config-auth-token"
    ) {
      // `lore auth --migrate` lands in #07. Until then, point operators
      // at the manual ntn flow so the prompt names a working command.
      console.log("                          (soft-deprecated; switch to ntn via `NOTION_KEYRING=0 ntn login`)")
    }
    return await preflightAndReport(auth, found, config)
  }

  // No auth resolved — derive the ntn-login env target before
  // offering. Priority: operator's `NOTION_ENV` env var (if set in
  // shell) wins; otherwise infer from `.lore.yaml`'s
  // `auth.baseUrl`. A non-canonical `auth.baseUrl` (e.g., a corporate
  // proxy) without an explicit `NOTION_ENV` means we can't safely
  // pick an ntn env — refuse auto-login with a recovery message
  // rather than mint a prod token for what's almost certainly NOT a
  // prod project. Without this gate, `lore install -y` against a
  // project whose `auth.baseUrl: https://api-dev.notion.com` would
  // mint a prod token and fall into the generic vault-not-accessible
  // path — exactly the dev-onboarding footgun an early review flagged.
  const operatorEnv = process.env["NOTION_ENV"]
  const operatorEnvParsed = parseNtnEnv(operatorEnv)
  let resolvedNtnEnv: NtnEnv | undefined
  let resolvedNtnEnvSource: "operator-env" | "config-baseurl" | "default" = "default"
  if (operatorEnv) {
    if (operatorEnvParsed === null) {
      // Operator's shell carries `NOTION_ENV=<garbage>`. Refuse to
      // forward it to ntn — bare ntn would also reject, but Lore can
      // surface a clearer message at the install seam.
      console.log("  Auth source:          ✗ no token resolved")
      console.error("")
      console.error(
        `    NOTION_ENV=${operatorEnv} is not a recognized ntn environment.`,
      )
      console.error("    Expected one of: prod, dev, stg.")
      console.error("")
      console.error("    Recovery: unset or correct NOTION_ENV in your shell, then re-run")
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
      console.error(`    .lore.yaml carries auth.baseUrl=${config.auth.baseUrl}, which doesn't`)
      console.error("    match a known ntn environment. Lore can't safely pick a `NOTION_ENV`")
      console.error("    target for `ntn login` from this — minting a prod token for a")
      console.error("    non-prod project would land you on the generic vault-not-accessible")
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
  if (resolvedNtnEnvSource === "config-baseurl") {
    console.log(
      `    .lore.yaml's auth.baseUrl maps to ntn env "${resolvedNtnEnv}" — Lore will`,
    )
    console.log(`    pass NOTION_ENV=${resolvedNtnEnv} to ntn login so the resulting token`)
    console.log("    authorizes against the right Notion deployment.")
    console.log("")
  } else if (resolvedNtnEnvSource === "operator-env") {
    console.log(
      `    Using NOTION_ENV=${resolvedNtnEnv} from your shell — ntn login will mint a`,
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
    // `lore auth --login` (issue #06) wraps this same flow with the
    // version probe and post-login preflight; until it ships, point
    // operators at the manual ntn invocation that already works. The
    // `NOTION_KEYRING=0` prefix is required so the token lands in
    // auth.json (file mode) instead of the macOS keychain.
    const manualEnvPrefix = resolvedNtnEnv ? `NOTION_ENV=${resolvedNtnEnv} ` : ""
    console.log(
      `    Skipping. Run \`NOTION_KEYRING=0 ${manualEnvPrefix}ntn login\` directly when you're`,
    )
    console.log("    ready, then re-run `lore install`. The env var prefix is required so")
    console.log("    the token lands in auth.json (where Lore reads from) instead of the")
    console.log("    macOS keychain.")
    return { ready: false }
  }

  const loginResult = await runNtnLogin(
    resolvedNtnEnv ? { env: resolvedNtnEnv } : {},
  )
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
  // (ntn login doesn't move `.lore.yaml`), so reuse the `config`
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
  // `lore auth --status` (issue #06) is the future diagnostic surface
  // for the ntn-aware path; until it ships, the manual fallback is
  // checking auth.json contents directly.
  console.error("    Inspect `~/.config/notion/auth.json` to confirm a workspace token landed,")
  console.error("    or re-run with `LORE_DEBUG=1` for verbose resolveAuth tracing.")
  return { ready: false }
}

/**
 * Run the post-resolution vault preflight (#03's `verifyVaultAccess`)
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
 * Skips entirely when no `.lore.yaml` exists — auth resolved without
 * a vault config is unusual but acceptable (e.g., post-`lore install`
 * before `lore init`).
 */
async function preflightAndReport(
  auth: ResolvedAuth,
  found: { root: string; path: string } | null,
  config: LoreConfig | undefined,
): Promise<{ ready: boolean; authSource?: AuthSource }> {
  if (!found || !config) {
    return { ready: true, authSource: auth.source }
  }

  const { createClient } = await import("../../notion/client.js")
  const { createLimitedClient } = await import("../../notion/rate-limit.js")
  const client = createLimitedClient(createClient(auth.token, auth.baseUrl))
  const result = await verifyVaultAccess(client, config.vault.pageId)

  if (result.kind === "ok") {
    console.log(`  Vault page:           ✓ ${result.pageTitle ?? config.vault.pageId}`)
    return { ready: true, authSource: auth.source }
  }

  if (result.kind === "not-found") {
    // Recovery copy is env-aware: a project whose `.lore.yaml` says
    // dev (or whose operator has `NOTION_ENV=dev` exported) gets a
    // paste-ready `NOTION_KEYRING=0 NOTION_ENV=dev ntn login`
    // command. Bare `ntn login` would default to prod and write to
    // the macOS keychain (which Lore can't read) — the exact
    // misrecovery that produces "I logged in, why doesn't Lore see
    // my token?" loops.
    const recovery = ntnLoginRecovery(config)
    console.error(`  Vault page:           ✗ not accessible (${config.vault.pageId})`)
    console.error("")
    console.error("    Most likely causes:")
    console.error("      1. You authenticated against the wrong workspace during ntn login,")
    console.error("         OR the auth.json on disk carries a token for the wrong env")
    console.error("         (e.g., a prod token while this project's auth.baseUrl is dev).")
    console.error("         Re-auth with the right env selector:")
    console.error("")
    console.error(`           ${recovery.command}`)
    if (recovery.manualEnvNote) {
      console.error(`           ${recovery.manualEnvNote}`)
    }
    console.error("")
    console.error(`         then pick the workspace containing ${config.vault.pageId}.`)
    console.error("      2. The vault page isn't shared with you (your Notion identity)")
    console.error("         in this workspace. ntn-issued tokens inherit your personal")
    console.error("         Notion permissions; if you can't open the page in Notion's UI,")
    console.error("         the token can't read it either. Ask whoever owns the vault to")
    console.error("         share it with you, or check that you're a member of the")
    console.error("         workspace.")
    console.error("")
    console.error("    Refusing to write MCP config — fix vault access and re-run `lore install`.")
    return { ready: false }
  }

  if (result.kind === "unauthorized") {
    // Same env-aware recovery as `not-found`: 401/403 means the
    // resolved token is wrong (invalid, expired, or for the wrong
    // env). Bare `ntn login` would re-make the same mistake when
    // the project is non-prod.
    const recovery = ntnLoginRecovery(config)
    console.error(`  Vault page:           ✗ unauthorized (${config.vault.pageId})`)
    console.error("")
    console.error("    The resolved token is invalid, expired, or for the wrong Notion")
    console.error("    environment. Re-auth with the right env selector:")
    console.error("")
    console.error(`      ${recovery.command}`)
    if (recovery.manualEnvNote) {
      console.error(`      ${recovery.manualEnvNote}`)
    }
    console.error("")
    console.error("    then re-run `lore install`.")
    console.error("")
    console.error("    Refusing to write MCP config — fix auth and re-run `lore install`.")
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
  console.warn(`  Vault page:           ? preflight returned an unexpected error (${config.vault.pageId})`)
  console.warn("    Lore will install anyway; if the issue persists, re-run `lore install`")
  console.warn("    or check Notion's status page.")
  return { ready: true, authSource: auth.source }
}

async function preflightCodexInstall(context: InstallContext): Promise<void> {
  const codexConfigPath = join(context.projectDir, ".codex", "config.toml")
  const codexHooksPath = join(context.projectDir, ".codex", "hooks.json")
  const codexConfig = await readTextSafe(codexConfigPath)
  assertTomlSupportsLoreRewrite(codexConfig, codexConfigPath)
  await readJsonSafe(codexHooksPath)
}

async function runClaudeInstall(
  context: InstallContext,
  rl: ReturnType<typeof createInterface> | null,
): Promise<void> {
  await ensureHookPrerequisites(context)
  const encodedPath = encodeProjectPath(context.projectDir)
  const settingsPath = join(homedir(), ".claude", "projects", encodedPath, "settings.json")
  const settings = await readJsonSafe(settingsPath)
  const mcpJsonPath = join(context.projectDir, ".mcp.json")
  const mcpJson = await readJsonSafe(mcpJsonPath)

  // Bin-dispatch is the canonical command shape for hooks. Detection
  // recognizes the legacy absolute-path shape and the bin-dispatch
  // shape that matches `context.yarnPnp` so we can distinguish "stale"
  // (truly drift) from "legacy-current" (legacy shape pointing at the
  // right pkgRoot, upgrade candidate). The desired command for the
  // WRITE path depends on `context.legacyPaths` and `context.yarnPnp`.
  const binShape: BinDispatchShape = context.yarnPnp ? "yarn" : "bare"
  const binAutosaveCommand = buildClaudeHookCommand("autosave", binShape)
  const binWakeupCommand = buildClaudeHookCommand("wakeup", binShape)
  const configRoot = context.configRoot

  const hooks = (settings.hooks ?? {}) as Record<string, ClaudeHookEntry[]>
  const autosaveStatus = detectClaudeHook(
    hooks["Stop"],
    "autosave.sh",
    context.autosavePath,
    binAutosaveCommand,
  )
  const wakeupStatus = detectClaudeHook(
    hooks["UserPromptSubmit"],
    "wakeup.sh",
    context.wakeupPath,
    binWakeupCommand,
  )

  // Active SessionEnd registration was removed in 0.6.0. The cleanup planner
  // returns the post-cleanup array (or undefined when every entry was
  // Lore-owned and the SessionEnd key should be deleted) along with flags
  // describing what was removed for the status output below.
  const sessionEndCleanup = stripLoreOwnedSessionEndEntries(hooks["SessionEnd"])
  const hasSessionEndShim = sessionEndCleanup.removedShim
  const hasLegacySessionEndAutosave = sessionEndCleanup.removedLegacyAutosave
  const hasLegacyAutosave =
    detectClaudeHook(hooks["PostToolUse"], "autosave.sh", "") !== "missing"
  const hasLegacyWakeup =
    detectClaudeHook(hooks["PreToolUse"], "wakeup.sh", "") !== "missing"
  const hasLegacyPreCompact =
    detectClaudeHook(hooks["PreCompact"], "autosave.sh", "") !== "missing"
  const hasLegacyMcp = Boolean(
    (settings.mcpServers as Record<string, unknown> | undefined)?.["lore"],
  )

  const mcpServers = (mcpJson.mcpServers ?? {}) as Record<string, unknown>
  const existingMcp = mcpServers["lore"] as Record<string, unknown> | undefined
  const portableMcpJsPath = toPortablePath(context.mcpJsPath)
  const portablePkgRoot = toPortablePath(context.pkgRoot)
  const binMcpEntry = buildClaudeMcpEntry(binShape, configRoot, process.env, context.authSource)
  const legacyMcpEntry = buildLegacyClaudeMcpEntry(
    portableMcpJsPath,
    portablePkgRoot,
    configRoot,
    process.env,
    context.authSource,
  )
  // Desired entry for the WRITE path (driven by --legacy-paths and
  // --yarn-pnp). Detection below recognizes the canonical-for-this-mode
  // bin-dispatch entry exactly: a PnP project with a bare bin entry on
  // disk classifies as `stale` (write target shape mismatch) and gets
  // rewritten to yarn-wrapped on reinstall. Same posture in reverse.
  const desiredMcpEntry = context.legacyPaths ? legacyMcpEntry : binMcpEntry
  const mcpStatus: HookStatus = !existingMcp
    ? "missing"
    : deepEqual(existingMcp, binMcpEntry)
      ? "current"
      : deepEqual(existingMcp, legacyMcpEntry)
        ? "legacy-current"
        : "stale"

  console.log("Claude Code:")
  console.log(`  MCP server:        ${statusLabel(mcpStatus, context.legacyPaths)}`)
  console.log(`  Autosave hook:     ${statusLabel(autosaveStatus, context.legacyPaths)}`)
  console.log(
    `  Wakeup hook:       ${statusLabel(wakeupStatus, context.legacyPaths)}${wakeupStatusSuffix(context.wakeUpConfig)}`,
  )
  if (hasSessionEndShim) console.log("  Session-end hook:  will remove")
  if (hasLegacyAutosave) console.log("  Legacy hook:       PostToolUse/Stop -> will migrate")
  if (hasLegacyWakeup) console.log("  Legacy hook:       PreToolUse/Task -> will migrate")
  if (hasLegacySessionEndAutosave)
    console.log("  Legacy hook:       SessionEnd/autosave.sh -> will remove")
  if (hasLegacyPreCompact) console.log("  Legacy hook:       PreCompact -> will remove")
  if (hasLegacyMcp) console.log("  Legacy MCP:        settings.json -> will migrate to .mcp.json")
  // Issue #194: surface background-agent install-time health on Claude
  // Code installs too. An operator who set `LORE_BACKGROUND_COMMAND` or
  // overrode `hooks.backgroundAgent` on a Claude Code project is just
  // as exposed as a `--client codex` operator — the configuration
  // applies regardless of which host registered the hook.
  printBackgroundAgentSummary(await resolveBackgroundAgentForInstall(context))

  const allCurrent =
    isEffectivelyCurrent(autosaveStatus, context.legacyPaths) &&
    isEffectivelyCurrent(wakeupStatus, context.legacyPaths) &&
    !hasSessionEndShim &&
    isEffectivelyCurrent(mcpStatus, context.legacyPaths) &&
    !hasLegacyAutosave &&
    !hasLegacyWakeup &&
    !hasLegacySessionEndAutosave &&
    !hasLegacyPreCompact &&
    !hasLegacyMcp

  if (allCurrent) {
    console.log("  Everything is already installed.")
    return
  }

  console.log()
  const proceed = await confirm(rl, "Install Lore Claude Code integration for this project?")
  if (!proceed) {
    console.log("  Skipped.")
    return
  }

  const merged: Record<string, unknown> = { ...settings }
  const mergedHooks: Record<string, unknown> = {
    ...((settings.hooks as Record<string, unknown>) ?? {}),
  }

  // `mergeClaudeHookEntries` filters by script-name suffix, which only
  // recognizes the legacy `.sh` paths. When upgrading from
  // legacy-current → bin-dispatch we run two passes: first strip the
  // legacy script entry, then write the bin-dispatch command. When
  // downgrading bin-dispatch → legacy under `--legacy-paths`, we strip
  // any existing bin-dispatch entry (no `.sh` suffix), then write the
  // legacy path. The shared helper below covers both directions.
  const desiredAutosaveCommand = context.legacyPaths
    ? context.autosavePath
    : binAutosaveCommand
  const desiredWakeupCommand = context.legacyPaths
    ? context.wakeupPath
    : binWakeupCommand

  if (!isEffectivelyCurrent(autosaveStatus, context.legacyPaths)) {
    mergedHooks["Stop"] = upsertClaudeHookCommand(
      hooks["Stop"],
      "autosave.sh",
      desiredAutosaveCommand,
      // Claude settings use hook timeouts in milliseconds.
      { matcher: "", timeout: 10000 },
    )
  }

  if (!isEffectivelyCurrent(wakeupStatus, context.legacyPaths)) {
    mergedHooks["UserPromptSubmit"] = upsertClaudeHookCommand(
      hooks["UserPromptSubmit"],
      "wakeup.sh",
      desiredWakeupCommand,
      // Claude settings use hook timeouts in milliseconds.
      { matcher: "", timeout: 10000, runOnce: true },
    )
  }

  if (hasLegacyAutosave) {
    mergedHooks["PostToolUse"] = removeClaudeScriptEntries(hooks["PostToolUse"], "autosave.sh")
    if (!mergedHooks["PostToolUse"]) delete mergedHooks["PostToolUse"]
  }
  if (hasLegacyWakeup) {
    mergedHooks["PreToolUse"] = removeClaudeScriptEntries(hooks["PreToolUse"], "wakeup.sh")
    if (!mergedHooks["PreToolUse"]) delete mergedHooks["PreToolUse"]
  }
  // 0.6.0: Lore no longer registers a SessionEnd hook. The pre-computed
  // cleanup result strips Lore-owned entries (both the `session-end.sh`
  // shim path and the older `autosave.sh`-on-SessionEnd legacy path) while
  // preserving unrelated user hooks on the same event.
  if (hasSessionEndShim || hasLegacySessionEndAutosave) {
    if (sessionEndCleanup.result) {
      mergedHooks["SessionEnd"] = sessionEndCleanup.result
    } else {
      delete mergedHooks["SessionEnd"]
    }
  }
  if (hasLegacyPreCompact) {
    mergedHooks["PreCompact"] = removeClaudeScriptEntries(hooks["PreCompact"], "autosave.sh")
    if (!mergedHooks["PreCompact"]) delete mergedHooks["PreCompact"]
  }

  merged.hooks = mergedHooks

  if (hasLegacyMcp) {
    const stale = { ...((settings.mcpServers as Record<string, unknown>) ?? {}) }
    delete stale["lore"]
    if (Object.keys(stale).length > 0) {
      merged.mcpServers = stale
    } else {
      delete merged.mcpServers
    }
  }

  const settingsDisplay = displayHomePath(settingsPath)
  console.log()
  console.log(`  Writing: ${settingsDisplay}`)
  await writeJsonFile(settingsPath, merged)

  if (!isEffectivelyCurrent(mcpStatus, context.legacyPaths)) {
    const mergedMcpJson: Record<string, unknown> = { ...mcpJson }
    mergedMcpJson.mcpServers = {
      ...((mcpJson.mcpServers as Record<string, unknown>) ?? {}),
      lore: desiredMcpEntry,
    }

    const mcpJsonDisplay = displayHomePath(mcpJsonPath)
    console.log(`  Writing: ${mcpJsonDisplay}`)
    await writeJsonFile(mcpJsonPath, mergedMcpJson)

    if (context.legacyPaths && !portableMcpJsPath.startsWith("${HOME}")) {
      console.warn()
      console.warn("  Warning: lore is installed outside your home directory")
      console.warn(`    (${context.pkgRoot}).`)
      console.warn("  The generated .mcp.json uses an absolute path and is not")
      console.warn("  portable across machines - avoid committing it, or reinstall")
      console.warn("  lore under ~/.lore so the path can use ${HOME}.")
    }
  }

  console.log()
  if (!isEffectivelyCurrent(mcpStatus, context.legacyPaths)) {
    console.log(
      `  MCP server:        ${postWriteLabel(mcpStatus, context.legacyPaths)} (.mcp.json)`,
    )
  }
  if (!isEffectivelyCurrent(autosaveStatus, context.legacyPaths)) {
    console.log(
      `  Autosave hook:     ${postWriteLabel(autosaveStatus, context.legacyPaths)}`,
    )
  }
  if (!isEffectivelyCurrent(wakeupStatus, context.legacyPaths)) {
    console.log(
      `  Wakeup hook:       ${postWriteLabel(wakeupStatus, context.legacyPaths)}`,
    )
  }
  if (hasSessionEndShim || hasLegacySessionEndAutosave)
    console.log("  Session-end hook:  removed (autosave covers Stop only)")
  if (hasLegacyMcp) console.log("  Legacy MCP:        removed from settings.json")
  console.log("  Restart Claude Code for changes to take effect.")
}

/**
 * Resolve the background-agent shape the project's `.lore.yaml` would
 * use at hook-fire time and probe its install-time health. Returns:
 *
 * - `command` — the resolved binary name, after env > yaml > default
 *   precedence (matches the runtime resolution in `mergeHookDefaults`).
 * - `args` — the resolved args array, after preset / explicit-override
 *   resolution.
 * - `present` — whether the binary resolves on PATH (or exists at its
 *   configured absolute path).
 * - `presetMatched` — whether the resolved `command` value is in
 *   `KNOWN_COMMAND_PRESETS`. Operators on a known binary can rely on
 *   the bundled preset; operators on an unknown binary need to supply
 *   their own `args` (or accept the Claude-shaped fallthrough, which
 *   only works for Claude variants).
 * - `argsContainAllowedToolsPlaceholder` — whether the resolved args
 *   pass the allowlist string through to the spawned agent. When this
 *   is `false`, the agent's allowlist must be configured out-of-band.
 *
 * Issue #194 — Codex installs register Stop hooks that shell out to a
 * background agent CLI. Without this preflight, operators see hooks
 * fire and silently produce nothing (binary-missing) or fail at first
 * spawn (incompatible flags). The five fields above are what the
 * install-time warning needs to direct an operator at the actual gap.
 *
 * Used by both Claude Code AND Codex installers — the configuration
 * applies regardless of which host registered the hook (and an
 * operator who set `LORE_BACKGROUND_COMMAND=codex` on a Claude Code
 * install is just as exposed as a `--client codex` operator would be).
 */
export async function resolveBackgroundAgentForInstall(
  context: InstallContext,
  envSource: NodeJS.ProcessEnv = process.env,
  /**
   * Agent identity context for the install-time resolution. When set,
   * the resolver reads `LORE_AGENT_NAME` from this overlay BEFORE the
   * live `envSource`. Used by `runCodexInstall` to ensure the
   * install-time output reflects what will happen at hook-fire time
   * (where the Codex hook prefix `LORE_AGENT_NAME=Codex ` is always in
   * effect) regardless of whether the operator's install-time shell
   * happens to have the var set. Pass `undefined` (default) to read
   * `envSource` directly — the right call for `runClaudeInstall`,
   * which doesn't inject any agent prefix on hook commands and falls
   * through to the historical Claude-default at hook-fire time.
   */
  agentNameOverride?: string,
): Promise<{
  command: string
  args: string[]
  present: boolean
  presetMatched: boolean
  argsContainAllowedToolsPlaceholder: boolean
}> {
  let configHooks: LoreConfig["hooks"] | undefined
  const found = await findConfigFile(context.projectDir)
  if (found) {
    try {
      const config = await loadConfig(found.path)
      configHooks = config.hooks
    } catch {
      // Malformed `.lore.yaml` — fall through to defaults. The
      // wakeUp-config reader (`readWakeUpConfig`) emits a stderr line
      // for this; we don't double-log here.
    }
  }
  // Layer the agent override on top of the live env so the resolver
  // sees what hook-fire time will see. The Codex installer always
  // prefixes hook commands with `LORE_AGENT_NAME=Codex ` (see
  // `CODEX_AGENT_ENV_PREFIX` above), so install-time output should
  // mirror that — otherwise an operator who ran `lore install --client
  // codex` from a clean shell sees `Background agent: claude` in the
  // status block while the runtime hooks resolve to codex.
  const resolverEnv = agentNameOverride
    ? { ...envSource, LORE_AGENT_NAME: agentNameOverride }
    : envSource
  const merged = mergeHookDefaults(configHooks, null, [], resolverEnv)
  const command = merged.backgroundAgent.command
  const args = merged.backgroundAgent.args
  const present = findBackgroundBinary(command) !== null
  // Basename-aware preset match — mirrors the runtime resolver so the
  // install-time `presetMatched` flag agrees with what `mergeHookDefaults`
  // actually selected for `args`. Without this, an operator on
  // `command: /opt/homebrew/bin/codex` would see `presetMatched: false`
  // even though the runtime resolver picked up the codex preset.
  const presetMatched = lookupCommandPreset(command) !== undefined
  const argsContainAllowedToolsPlaceholder = args.some((a) =>
    a.includes(ALLOWED_TOOLS_PLACEHOLDER),
  )
  return {
    command,
    args,
    present,
    presetMatched,
    argsContainAllowedToolsPlaceholder,
  }
}

type BackgroundAgentInstallSummary = Awaited<
  ReturnType<typeof resolveBackgroundAgentForInstall>
>

/**
 * Render the install-time status line + any warnings for the resolved
 * background-agent shape. Shared between `runClaudeInstall` and
 * `runCodexInstall` so the two surfaces emit byte-identical output for
 * the same resolved shape — an operator running `--client all` sees
 * the warning surface once per host with consistent wording.
 *
 * Three independent warning bands fire as appropriate:
 *
 * 1. **Binary missing** — the resolved command isn't on PATH. The
 *    spawn will fail at runtime with `binary-missing`. Most actionable
 *    of the three; printed first.
 * 2. **Unknown command without preset** — the resolved command isn't
 *    in `KNOWN_COMMAND_PRESETS` AND no operator-supplied `args`. The
 *    args fall through to Claude's flag dialect, which works only for
 *    Claude variants. An operator on `command: codex-next` with no
 *    args will spawn `codex-next -p --allowedTools ...` and Codex will
 *    reject the flags.
 * 3. **Allowlist hand-off missing** — the resolved args do not contain
 *    `{{allowedTools}}`. The agent runs without a tool allowlist
 *    enforcing the lore prompt's expectations; the operator must
 *    configure the agent's allowlist out-of-band.
 *
 * Each warning is independent — an operator can hit all three at once
 * (e.g. `command: aider` with custom args lacking the placeholder, on
 * a system where aider isn't installed).
 */
export function printBackgroundAgentSummary(
  summary: BackgroundAgentInstallSummary,
): void {
  console.log(
    `  Background agent:  ${summary.command}${
      summary.present ? " (found on PATH)" : " (NOT FOUND on PATH)"
    }`,
  )
  if (!summary.present) {
    console.warn("")
    console.warn(
      `  Warning: background command "${summary.command}" is not on PATH.`,
    )
    console.warn(
      "    Stop hooks will fire, but the autosave / auto-digest spawn will skip",
    )
    console.warn(
      "    with a `[lore] binary-missing` stderr line until the binary is",
    )
    console.warn("    installed. Recovery options:")
    console.warn("      - Install Claude Code (default), or")
    console.warn(
      "      - Override hooks.backgroundAgent in .lore.yaml to point at a",
    )
    console.warn(
      "        different agent CLI (Lore ships presets for `claude` and `codex`):",
    )
    console.warn("            hooks:")
    console.warn("              backgroundAgent:")
    console.warn("                command: codex")
    console.warn(
      "      - Or set LORE_BACKGROUND_COMMAND=<binary> in your shell rc for an",
    )
    console.warn("        ad-hoc override.")
  }
  if (summary.present && !summary.presetMatched) {
    // The binary exists but it's not in the preset table. Args fell
    // through to `DEFAULT_BACKGROUND_ARGS` (Claude's flag dialect),
    // which works for Claude variants only. Operators on an unknown
    // binary need to supply their own `args` shape.
    console.warn("")
    console.warn(
      `  Warning: "${summary.command}" is not a known agent — Lore is using`,
    )
    console.warn(
      `    Claude's flag dialect (\`-p --allowedTools ... --model sonnet\`) by`,
    )
    console.warn(
      "    default. If your binary doesn't accept those flags, the spawn will",
    )
    console.warn(
      "    fail at runtime. Override hooks.backgroundAgent.args in .lore.yaml",
    )
    console.warn(
      "    with the binary's headless-mode flags. Use `{{allowedTools}}` where",
    )
    console.warn("    the tool allowlist string should be substituted.")
  }
  if (summary.present && !summary.argsContainAllowedToolsPlaceholder) {
    // Args resolved (preset or explicit) without the placeholder. The
    // spawn will succeed but the lore tool allowlist won't reach the
    // spawned agent — operators on such CLIs must configure the
    // agent's allowlist out-of-band. This is informational, not an
    // error: Codex's preset (and any Codex install) lands here by
    // design.
    console.warn("")
    console.warn(
      `  Note: "${summary.command}" args do not carry the {{allowedTools}}`,
    )
    console.warn(
      "    placeholder. The lore tool allowlist will not be passed through; you",
    )
    console.warn(
      "    must configure the agent's allowlist out-of-band (for Codex, set",
    )
    console.warn(
      "    `mcp_servers.lore.allowed_tools` in `.codex/config.toml`).",
    )
  }
}

export async function runCodexInstall(
  context: InstallContext,
  rl: ReturnType<typeof createInterface> | null,
): Promise<void> {
  await ensureHookPrerequisites(context)
  const codexConfigPath = join(context.projectDir, ".codex", "config.toml")
  const codexHooksPath = join(context.projectDir, ".codex", "hooks.json")
  const codexConfig = await readTextSafe(codexConfigPath)
  assertTomlSupportsLoreRewrite(codexConfig, codexConfigPath)
  const codexHooksJson = await readJsonSafe(codexHooksPath)
  const codexHooks = (codexHooksJson.hooks ?? {}) as Record<string, CodexHookEntry[]>

  const binShape: BinDispatchShape = context.yarnPnp ? "yarn" : "bare"
  const binMcpSection = buildCodexMcpSection(
    binShape,
    context.configRoot,
    process.env,
    context.authSource,
  )
  const legacyMcpSection = buildLegacyCodexMcpSection(
    context.mcpJsPath,
    context.configRoot,
    process.env,
    context.authSource,
  )
  const desiredMcpSection = context.legacyPaths ? legacyMcpSection : binMcpSection
  const existingMcpSection = extractTomlTableGroup(codexConfig, "mcp_servers.lore")
  const hooksFeatureValue = extractTomlKeyValue(codexConfig, "features", "codex_hooks")
  const binWakeupCommand = buildCodexHookCommand("wakeup", binShape)
  const binAutosaveCommand = buildCodexHookCommand("autosave", binShape)
  const legacyWakeupCommand = buildLegacyCodexHookCommand(context.wakeupPath)
  const legacyAutosaveCommand = buildLegacyCodexHookCommand(context.autosavePath)
  const desiredWakeupCommand = context.legacyPaths ? legacyWakeupCommand : binWakeupCommand
  const desiredAutosaveCommand = context.legacyPaths ? legacyAutosaveCommand : binAutosaveCommand

  const mcpStatus: HookStatus = !existingMcpSection
    ? "missing"
    : existingMcpSection.trim() === binMcpSection.trim()
      ? "current"
      : existingMcpSection.trim() === legacyMcpSection.trim()
        ? "legacy-current"
        : "stale"
  // The Codex hooks feature has no legacy/bin-dispatch axis — it's a
  // single boolean (`codex_hooks = true`). Re-using HookStatus here
  // would surface a meaningless legacy-current state, so we keep the
  // narrow three-value taxonomy for this row only.
  const hooksFeatureStatus: "current" | "stale" | "missing" =
    hooksFeatureValue == null
      ? "missing"
      : hooksFeatureValue === "true"
        ? "current"
        : "stale"
  const wakeupStatus = detectCodexHook(
    codexHooks["UserPromptSubmit"],
    "wakeup.sh",
    legacyWakeupCommand,
    binWakeupCommand,
  )
  const autosaveStatus = detectCodexHook(
    codexHooks["Stop"],
    "autosave.sh",
    legacyAutosaveCommand,
    binAutosaveCommand,
  )
  const hasLegacySessionStartWakeup =
    detectCodexHook(
      codexHooks["SessionStart"],
      "wakeup.sh",
      legacyWakeupCommand,
      binWakeupCommand,
    ) !== "missing"

  console.log("Codex:")
  console.log(`  MCP server:        ${statusLabel(mcpStatus, context.legacyPaths)}`)
  console.log(
    `  Hooks feature:     ${
      hooksFeatureStatus === "current"
        ? "already installed"
        : hooksFeatureStatus === "stale"
          ? "update available"
          : "not installed"
    }`,
  )
  console.log(
    `  Wakeup hook:       ${statusLabel(wakeupStatus, context.legacyPaths)}${wakeupStatusSuffix(context.wakeUpConfig)}`,
  )
  console.log(`  Autosave hook:     ${statusLabel(autosaveStatus, context.legacyPaths)}`)
  if (hasLegacySessionStartWakeup) {
    console.log("  Legacy hook:       SessionStart/wakeup -> will migrate")
  }

  // Issue #194: Stop hooks shell out to a background agent CLI for
  // autosave / digest synthesis. Default is `claude -p` for Claude Code
  // installs; Codex installs prefix every hook command with
  // `LORE_AGENT_NAME=Codex` so the runtime resolver derives `command:
  // codex` automatically (no per-project setup required). Pass `"Codex"`
  // explicitly to the resolver here so the install-time status block
  // mirrors what hook-fire time will produce, even when the operator's
  // install-time shell doesn't have `LORE_AGENT_NAME` exported.
  printBackgroundAgentSummary(
    await resolveBackgroundAgentForInstall(context, process.env, "Codex"),
  )

  const allCurrent =
    isEffectivelyCurrent(mcpStatus, context.legacyPaths) &&
    hooksFeatureStatus === "current" &&
    isEffectivelyCurrent(wakeupStatus, context.legacyPaths) &&
    isEffectivelyCurrent(autosaveStatus, context.legacyPaths) &&
    !hasLegacySessionStartWakeup

  if (allCurrent) {
    console.log("  Everything is already installed.")
    return
  }

  console.log()
  const proceed = await confirm(rl, "Install Lore Codex integration for this project?")
  if (!proceed) {
    console.log("  Skipped.")
    return
  }

  let nextConfig = codexConfig
  nextConfig = removeTomlTableGroup(nextConfig, "mcp_servers.lore")
  nextConfig = upsertTomlTableKey(nextConfig, "features", "codex_hooks", "true")
  nextConfig = appendTomlBlock(nextConfig, desiredMcpSection)

  // Strip both legacy `.sh`-named entries AND any prior bin-dispatch
  // entries so a flip in either direction (legacy → bin or bin →
  // legacy) leaves only the single canonical entry behind.
  let nextHookEvents = stripCodexScriptFromAllEvents(codexHooks, "wakeup.sh")
  nextHookEvents = stripCodexScriptFromAllEvents(nextHookEvents, "autosave.sh")
  nextHookEvents = stripCodexBinDispatchHook(nextHookEvents, "wakeup")
  nextHookEvents = stripCodexBinDispatchHook(nextHookEvents, "autosave")
  nextHookEvents["UserPromptSubmit"] = mergeCodexHookEntries(
    nextHookEvents["UserPromptSubmit"],
    desiredWakeupCommand,
    {
      statusMessage: "Loading Lore context",
    },
  )
  nextHookEvents["Stop"] = mergeCodexHookEntries(
    nextHookEvents["Stop"],
    desiredAutosaveCommand,
    {
      // Codex hook timeouts are expressed in seconds.
      timeout: 30,
      statusMessage: "Saving Lore context",
    },
  )

  const nextHooksJson: Record<string, unknown> = {
    ...codexHooksJson,
    hooks: nextHookEvents,
  }

  if (nextConfig !== codexConfig) {
    const configDisplay = displayHomePath(codexConfigPath)
    console.log()
    console.log(`  Writing: ${configDisplay}`)
    await writeTextFile(codexConfigPath, nextConfig)
  }

  if (!deepEqual(nextHooksJson, codexHooksJson)) {
    const hooksDisplay = displayHomePath(codexHooksPath)
    console.log(`  Writing: ${hooksDisplay}`)
    await writeJsonFile(codexHooksPath, nextHooksJson)
  }

  const portableMcpJsPath = toPortablePath(context.mcpJsPath)
  if (context.legacyPaths && !portableMcpJsPath.startsWith("${HOME}")) {
    console.warn()
    console.warn("  Warning: lore is installed outside your home directory")
    console.warn(`    (${context.pkgRoot}).`)
    console.warn("  The generated .codex/config.toml uses an absolute path and is not")
    console.warn("  portable across machines - avoid committing it, or reinstall")
    console.warn("  lore under ~/.lore so the path can use ${HOME}.")
  }

  console.log()
  if (!isEffectivelyCurrent(mcpStatus, context.legacyPaths)) {
    console.log(
      `  MCP server:        ${postWriteLabel(mcpStatus, context.legacyPaths)} (.codex/config.toml)`,
    )
  }
  if (hooksFeatureStatus !== "current") console.log("  Hooks feature:     enabled")
  if (!isEffectivelyCurrent(wakeupStatus, context.legacyPaths)) {
    console.log(
      `  Wakeup hook:       ${postWriteLabel(wakeupStatus, context.legacyPaths)}`,
    )
  }
  if (!isEffectivelyCurrent(autosaveStatus, context.legacyPaths)) {
    console.log(
      `  Autosave hook:     ${postWriteLabel(autosaveStatus, context.legacyPaths)}`,
    )
  }
  console.log("  Start a new Codex session after trusting this project.")
  console.log("  Codex only loads project-scoped .codex/* files for trusted projects.")
}

/**
 * Install Lore's Cursor integration. The caller is responsible for resolving
 * `cursorMcpPath` via `resolveCursorMcpPath` (or any other path source) — this
 * function only does the read/diff/write loop and the post-install messaging.
 * Keeping path resolution outside lets `runInstall` honor `--cursor-global`
 * once and lets tests target a tmpdir without stubbing `os.homedir`.
 *
 * `useGlobalScope` controls only the post-install messaging label
 * (`global` vs `project`) and the absolute-path portability warning gate;
 * `cursorMcpPath` is the actual write target.
 */
export async function runCursorInstall(
  context: InstallContext,
  rl: ReturnType<typeof createInterface> | null,
  cursorMcpPath: string,
  useGlobalScope: boolean,
): Promise<void> {
  const cursorMcpJson = await readJsonSafe(cursorMcpPath)
  const mcpServers = (cursorMcpJson.mcpServers ?? {}) as Record<string, unknown>
  const existingMcp = mcpServers["lore"] as Record<string, unknown> | undefined

  const portableMcpJsPath = toPortablePath(context.mcpJsPath)
  const portablePkgRoot = toPortablePath(context.pkgRoot)
  const binShape: BinDispatchShape = context.yarnPnp ? "yarn" : "bare"
  // Under `--cursor-global` + PnP, the entry needs to carry `cwd`
  // and `LORE_CONFIG_ROOT` because Cursor's launch cwd is not
  // guaranteed to be inside the PnP project at fire time.
  //
  // `launchCwd` and `LORE_CONFIG_ROOT` (= configRoot) thread
  // separately. `projectDir` is the directory `detectYarnPnp`
  // resolved against, so when `context.yarnPnp === true` it sits
  // at or below the PnP root and `yarn run -T`'s upward walk is
  // guaranteed to reach `.pnp.cjs`. `configRoot` may live ABOVE
  // the PnP workspace when `.lore.yaml` resolves to a parent
  // (monorepo umbrella with shared lore config); using it for
  // `cwd` would anchor the launcher OUTSIDE the workspace and
  // re-introduce the failure mode this fix exists to close. See
  // `BuildCursorMcpEntryOptions` for the full rationale.
  const binMcpEntry = buildCursorMcpEntry(binShape, context.configRoot, process.env, {
    useGlobalScope,
    launchCwd: context.projectDir,
    authSource: context.authSource,
  })
  const legacyMcpEntry = buildLegacyCursorMcpEntry(
    portableMcpJsPath,
    portablePkgRoot,
    context.configRoot,
    process.env,
    context.authSource,
  )
  const desiredMcpEntry = context.legacyPaths ? legacyMcpEntry : binMcpEntry
  const mcpStatus: HookStatus = !existingMcp
    ? "missing"
    : deepEqual(existingMcp, binMcpEntry)
      ? "current"
      : deepEqual(existingMcp, legacyMcpEntry)
        ? "legacy-current"
        : "stale"

  const scopeLabel = useGlobalScope ? "global" : "project"
  const cursorMcpDisplay = displayHomePath(cursorMcpPath)

  console.log("Cursor:")
  console.log(`  Scope:             ${scopeLabel} (${cursorMcpDisplay})`)
  console.log(`  MCP server:        ${statusLabel(mcpStatus, context.legacyPaths)}`)

  if (isEffectivelyCurrent(mcpStatus, context.legacyPaths)) {
    console.log("  Everything is already installed.")
    return
  }

  console.log()
  const proceed = await confirm(rl, "Install Lore Cursor integration for this project?")
  if (!proceed) {
    console.log("  Skipped.")
    return
  }

  const mergedMcpJson: Record<string, unknown> = { ...cursorMcpJson }
  mergedMcpJson.mcpServers = {
    ...((cursorMcpJson.mcpServers as Record<string, unknown>) ?? {}),
    lore: desiredMcpEntry,
  }

  console.log()
  console.log(`  Writing: ${cursorMcpDisplay}`)
  await writeJsonFile(cursorMcpPath, mergedMcpJson)

  if (
    context.legacyPaths &&
    !useGlobalScope &&
    !portableMcpJsPath.startsWith("${HOME}")
  ) {
    console.warn()
    console.warn("  Warning: lore is installed outside your home directory")
    console.warn(`    (${context.pkgRoot}).`)
    console.warn("  The generated .cursor/mcp.json uses an absolute path and is not")
    console.warn("  portable across machines - avoid committing it, or reinstall")
    console.warn("  lore under ~/.lore so the path can use ${HOME}.")
  }

  console.log()
  console.log(
    `  MCP server:        ${postWriteLabel(mcpStatus, context.legacyPaths)} (${cursorMcpDisplay})`,
  )
  console.log(
    "  Cursor does not currently support Stop hooks. The Stop-triggered\n" +
      "  autosave and the detached auto-digest spawn will not run when lore is\n" +
      "  invoked from Cursor. Lore tools work the same; only the background\n" +
      "  session-close persistence differs.",
  )
  console.log("  Restart Cursor for changes to take effect.")
}

/**
 * Per-assistant install runners injected into `runInstall`. Tests pass mocks
 * to verify orchestration behavior (independent failure isolation, error
 * aggregation, exit code) without touching the real filesystem; production
 * uses `defaultInstallRunners`.
 */
export interface InstallRunners {
  claude: (context: InstallContext, rl: ReturnType<typeof createInterface> | null) => Promise<void>
  codex: (context: InstallContext, rl: ReturnType<typeof createInterface> | null) => Promise<void>
  cursor: (
    context: InstallContext,
    rl: ReturnType<typeof createInterface> | null,
    cursorMcpPath: string,
    useGlobalScope: boolean,
  ) => Promise<void>
}

export const defaultInstallRunners: InstallRunners = {
  claude: runClaudeInstall,
  codex: runCodexInstall,
  cursor: runCursorInstall,
}

/**
 * Options consumed by `dispatchInstall`. A subset of `runInstall`'s opts —
 * the dispatcher only needs the routing target and the Cursor scope flag.
 * Tighter than passing the public `runInstall` shape so tests don't need to
 * synthesize fields the dispatcher won't read.
 */
export interface DispatchOpts {
  client: InstallClient
  cursorGlobal?: boolean
}

/**
 * Run the per-client install steps and aggregate errors. Pure-ish: takes a
 * pre-built `context` and `rl` and dispatches into the supplied `runners`.
 * Caller is responsible for prepping the context, opening/closing the
 * readline, and acting on the returned errors (typically by calling
 * `process.exit(1)`).
 *
 * Splitting this out from `runInstall` lets tests drive orchestration —
 * "did all three runners get called when one threw?" — without needing
 * `dist/mcp.js` and the hook scripts on disk.
 */
export async function dispatchInstall(
  context: InstallContext,
  rl: ReturnType<typeof createInterface> | null,
  opts: DispatchOpts,
  runners: InstallRunners,
): Promise<Array<{ client: string; error: unknown }>> {
  const errors: Array<{ client: string; error: unknown }> = []
  const cursorMcpPath = resolveCursorMcpPath(context.projectDir, !!opts.cursorGlobal)
  const runWithCapture = async (
    client: string,
    fn: () => Promise<void>,
  ): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      if (opts.client === "all") {
        errors.push({ client, error: err })
        console.error(`  ${client}: install failed (${formatInstallError(err)})`)
      } else {
        throw err
      }
    }
  }

  if (opts.client === "claude" || opts.client === "all") {
    await runWithCapture("claude", () => runners.claude(context, rl))
  }
  if (opts.client === "all") console.log()
  if (opts.client === "codex" || opts.client === "all") {
    await runWithCapture("codex", () => runners.codex(context, rl))
  }
  if (opts.client === "all") console.log()
  if (opts.client === "cursor" || opts.client === "all") {
    await runWithCapture("cursor", () =>
      runners.cursor(context, rl, cursorMcpPath, !!opts.cursorGlobal),
    )
  }

  return errors
}

export async function runInstall(
  opts: {
    client: InstallClient
    yes?: boolean
    project?: string
    cursorGlobal?: boolean
    legacyPaths?: boolean
    yarnPnp?: boolean
  },
  runners: InstallRunners = defaultInstallRunners,
): Promise<void> {
  const context = await prepareInstallContext(opts)

  const title =
    opts.client === "claude"
      ? "Claude Code Integration"
      : opts.client === "codex"
        ? "Codex Integration"
        : opts.client === "cursor"
          ? "Cursor Integration"
          : "AI Assistant Integration"

  console.log()
  console.log(`Lore — ${title}`)
  console.log("─".repeat(40))
  console.log(`Project: ${context.projectDir}`)
  console.log()

  const prereqs = await ensurePrerequisites(context, { yes: opts.yes })
  if (!prereqs.ready) {
    process.exit(1)
  }
  // Stash the resolved auth source onto the install context so per-client
  // runners can pass it into `buildMcpEnv` and suppress auth-token
  // placeholders on the `ntn-auth-json` path (issue #451). Mutation is
  // intentional: `prepareInstallContext` returns a fresh `InstallContext`,
  // the field is unset until this point, and only `runInstall` (this
  // function) populates it.
  context.authSource = prereqs.authSource

  // Detect legacy-forwarded env vars so the install summary can
  // surface a deprecation reminder. Read here (not inside the
  // runners) so the note prints once per install command, not once
  // per host. Probes the **unfiltered** shape (no `authSource`) so a
  // mid-migration operator on `ntn-auth-json` whose shell rc still
  // exports `LORE_NOTION_TOKEN` still sees the cleanup nudge — the
  // note's job is "your shell carries a stale legacy var; clean it up
  // to drop the shared 1Password coupling," not "this install just
  // baked one in." Under ntn-source the install does NOT forward the
  // token (the runners pass `context.authSource` into the build
  // helpers), so the note advises shell-rc cleanup independent of
  // whether the committed `.mcp.json` carries the placeholder.
  // Phrasing is command-agnostic until `lore auth --migrate`
  // (issue #07) ships — naming a non-existent command would be a
  // confidence-eroding way for new engineers to start.
  const legacyForwarded = buildMcpEnv(context.configRoot).forwarded.filter(
    (key): key is "LORE_NOTION_TOKEN" => key === "LORE_NOTION_TOKEN",
  )
  if (legacyForwarded.length > 0) {
    console.log("")
    console.log(
      "  Note: LORE_NOTION_TOKEN is forwarded into the MCP entry. The legacy",
    )
    console.log(
      "  env-var path still works in 0.10.x; switching to ntn-issued workspace",
    )
    console.log(
      "  tokens (`NOTION_KEYRING=0 ntn login`, then unset LORE_NOTION_TOKEN) gets",
    )
    console.log("  you per-engineer rate limits and removes the shared 1Password coupling.")
  }
  console.log()

  // Codex preflight is gating only when Codex is the sole target — failing
  // before the readline opens keeps the prompt session from spinning up for
  // a config that's going to error anyway. Under `--client all`, the same
  // assertion runs inside `runCodexInstall` and surfaces through the
  // captured-errors path so a bad Codex config doesn't take down Claude or
  // Cursor.
  if (opts.client === "codex") {
    await preflightCodexInstall(context)
  }

  const rl = context.skipPrompts
    ? null
    : createInterface({ input: process.stdin, output: process.stdout })

  let errors: Array<{ client: string; error: unknown }>
  try {
    errors = await dispatchInstall(context, rl, opts, runners)
  } finally {
    rl?.close()
  }

  if (errors.length > 0) {
    // Default summary stays on the `client: message` line — the CLI's
    // clean-output convention. Stack traces gate behind
    // LORE_INSTALL_DEBUG=1 so an expected failure (malformed JSON / TOML,
    // missing build artifact) doesn't drown the operator in V8 frames; an
    // unexpected failure can be re-run with the env var to surface them.
    const showStacks = process.env["LORE_INSTALL_DEBUG"] === "1"
    console.error()
    console.error(`Install completed with ${errors.length} failure(s):`)
    for (const { client, error } of errors) {
      console.error(`  ${client}: ${formatInstallError(error)}`)
      if (showStacks && error instanceof Error && error.stack) {
        console.error(
          error.stack
            .split("\n")
            .slice(1)
            .map((l) => `    ${l}`)
            .join("\n"),
        )
      }
    }
    if (!showStacks) {
      console.error()
      console.error("  Re-run with LORE_INSTALL_DEBUG=1 to include stack traces.")
    }
    process.exit(1)
  }
}

function formatInstallError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Map a `--client` argument to an `InstallClient`. Returns `null` for an
 * unrecognized value so the caller can emit its own error and exit.
 *
 * Only `undefined` (option not passed at all) maps to the `"all"` default —
 * an explicit empty string `--client ""` returns `null` so the caller can
 * route to the unrecognized-value error path. Empty-string-means-default
 * would be a silent dispatch that no operator could reasonably expect.
 *
 * `"both"` is accepted as a deprecated alias for `"all"` so 0.8.x scripts
 * keep working through one minor version. Callers detect the deprecated
 * spelling via `isDeprecatedInstallClient` and emit a warning before
 * dispatching.
 */
export function parseInstallClient(value: string | undefined): InstallClient | null {
  if (value === undefined) return "all"
  if (value === "claude" || value === "codex" || value === "cursor" || value === "all") {
    return value
  }
  if (value === "both") return "all"
  return null
}

export function isDeprecatedInstallClient(value: string | undefined): boolean {
  return value === "both"
}

export type PrintConfigFormat = "json" | "toml"

export function parsePrintConfigFormat(value: string): PrintConfigFormat | null {
  if (value === "json" || value === "toml") return value
  return null
}

/**
 * Render a paste-ready MCP config snippet as a string.
 *
 * Pure: takes resolved paths in, returns the snippet out. Reuses
 * `buildClaudeMcpEntry` / `buildCodexMcpSection` (or their `Legacy`
 * counterparts when `legacyPaths === true`) so the snippet stays
 * byte-identical to what `--client claude` writes to `.mcp.json` and
 * what `--client codex` writes to `.codex/config.toml` for the same
 * `--legacy-paths` flag value. Drift between the printed shape and the
 * on-disk shape is the failure mode this reuse exists to prevent.
 *
 * `mcpJsPath` and `pkgRoot` are unused on the bin-dispatch path —
 * accepted for API compatibility with the legacy path, ignored when
 * `legacyPaths === false`.
 */
export function buildPrintConfigOutput(
  format: PrintConfigFormat,
  mcpJsPath: string,
  pkgRoot: string,
  configRoot: string = process.cwd(),
  legacyPaths = false,
  binShape: BinDispatchShape = "bare",
  envSource: NodeJS.ProcessEnv = process.env,
  authSource?: AuthSource,
): string {
  const portableMcpJsPath = toPortablePath(mcpJsPath)
  const portablePkgRoot = toPortablePath(pkgRoot)

  if (format === "json") {
    const entry = legacyPaths
      ? buildLegacyClaudeMcpEntry(
          portableMcpJsPath,
          portablePkgRoot,
          configRoot,
          envSource,
          authSource,
        )
      : buildClaudeMcpEntry(binShape, configRoot, envSource, authSource)
    return JSON.stringify({ mcpServers: { lore: entry } }, null, 2) + "\n"
  }

  const section = legacyPaths
    ? buildLegacyCodexMcpSection(portableMcpJsPath, configRoot, envSource, authSource)
    : buildCodexMcpSection(binShape, configRoot, envSource, authSource)
  return section + "\n"
}

/**
 * `--print-config` runtime path. Resolves `pkgRoot` and `mcpJsPath` via the
 * same helpers the install paths use, validates `dist/mcp.js` exists (the
 * printed `args[0]` would otherwise point at a non-existent file), and
 * writes the snippet to stdout. No filesystem writes — but `--project`
 * (when present) resolves the configRoot embedded in the snippet's
 * `LORE_CONFIG_ROOT` static so the printed entry points the spawned MCP
 * server at the right `.lore.yaml`.
 *
 * On a legacy-forwarded source (operator has `LORE_NOTION_TOKEN` set),
 * a one-line stderr note surfaces a deprecation reminder so the
 * print-config path stays in lockstep with the file-write path's
 * messaging. The phrasing is command-agnostic until
 * `lore auth --migrate` (issue #07) ships.
 */
async function runPrintConfig(
  format: PrintConfigFormat,
  legacyPaths: boolean,
  binShape: BinDispatchShape,
  projectDir?: string,
): Promise<void> {
  const pkgRoot = resolvePkgRoot()
  const mcpJsPath = join(pkgRoot, "dist", "mcp.js")

  if (!(await fileExists(mcpJsPath))) {
    throw new Error(
      `dist/mcp.js not found at ${mcpJsPath}. Run 'npm run build' first.`,
    )
  }

  const projectRoot = resolve(projectDir ?? process.cwd())
  const found = await findConfigFile(projectRoot)
  const configRoot = found?.root ?? projectRoot

  // Best-effort auth-source resolution so the printed snippet matches
  // what `--client claude` / `--client codex` would write to disk
  // (issue #451): under `ntn-auth-json`, suppress the auth-token
  // placeholders that produce host-validator warnings. Note that
  // `resolveAuth` also has the side effect of emitting debounced
  // deprecation warnings to stderr for the legacy paths
  // (`config-auth-token`, `env-lore-notion-token`); print-config now
  // surfaces those warnings where it didn't pre-#451, which keeps the
  // messaging consistent with the file-write path's behavior. Print-
  // config is intentionally non-interactive — auth resolution failure
  // (no `.lore.yaml`, no token resolved) is silently treated as "no
  // opinion" and the legacy unconditional-forward shape stands. The
  // catch is narrow: print-config exists for unsupported hosts and a
  // hard failure here would break the very escape hatch operators
  // depend on.
  let printConfigAuthSource: AuthSource | undefined
  if (found) {
    try {
      const config = await loadConfig(found.path)
      const auth = await resolveAuth(config, found.root)
      printConfigAuthSource = auth.source
    } catch {
      // Auth unresolvable — fall through to undefined (pre-fix shape).
    }
  }

  process.stdout.write(
    buildPrintConfigOutput(
      format,
      mcpJsPath,
      pkgRoot,
      configRoot,
      legacyPaths,
      binShape,
      process.env,
      printConfigAuthSource,
    ),
  )

  // Mirror the file-write path's legacy-forwarded note so operators of
  // unsupported hosts see the same shell-rc-cleanup recommendation.
  // Probes the unfiltered shape (no `authSource`) for the same reason
  // `runInstall` does: an ntn-source operator with a stray
  // `LORE_NOTION_TOKEN` still in their shell rc gets the cleanup nudge,
  // even though the printed snippet itself no longer forwards the
  // token. The advice — drop the shared 1Password coupling and switch
  // to per-engineer ntn tokens — is independent of whether *this*
  // snippet bakes the placeholder in.
  const build = buildMcpEnv(configRoot)
  if (build.forwarded.includes("LORE_NOTION_TOKEN")) {
    process.stderr.write(
      "Note: LORE_NOTION_TOKEN forwarded — soft-deprecated. Switch via " +
        "`NOTION_KEYRING=0 ntn login`, then unset LORE_NOTION_TOKEN.\n",
    )
  }
}

export const installCommand = new Command("install")
  .description("Install Lore assistant integrations for the current project")
  .option(
    "--client <assistant>",
    "assistant to configure: claude, codex, cursor, or all (default: all)",
  )
  .option("--project <path>", "project directory (default: cwd)")
  .option(
    "--cursor-global",
    "Cursor only: write to ~/.cursor/mcp.json instead of <projectDir>/.cursor/mcp.json (overrides --project for the Cursor branch)",
  )
  .option(
    "--print-config <format>",
    "print a paste-ready MCP config snippet to stdout (no files written); format: json or toml",
  )
  .option(
    "--legacy-paths",
    "emit the absolute-path 0.10.x config shape (node dist/mcp.js, hooks/*.sh) instead of the bin-dispatched 'lore mcp' / 'lore hooks <event>' default. Removal targeted for 0.12.0",
  )
  .option(
    "--yarn-pnp",
    "force the yarn-wrapped bin-dispatch shape ('yarn run -T lore mcp', 'yarn run -T lore hooks <event>'). Auto-detected from a .pnp.cjs marker; this flag pins it explicitly",
  )
  .option(
    "--no-yarn-pnp",
    "force the bare bin-dispatch shape ('lore mcp', 'lore hooks <event>'), overriding .pnp.cjs auto-detection. Use when your PnP project shims node_modules/.bin out-of-band",
  )
  .option("-y, --yes", "skip confirmation prompts")
  .action(
    async (opts: {
      client?: string
      project?: string
      printConfig?: string
      yes?: boolean
      cursorGlobal?: boolean
      legacyPaths?: boolean
      yarnPnp?: boolean
    }) => {
      try {
        if (opts.printConfig != null) {
          const format = parsePrintConfigFormat(opts.printConfig)
          if (!format) {
            // Message intentionally starts with `Install failed:` so the shape
            // matches the outer-catch path's `Install failed: <msg>` rendering;
            // a top-level rethrow would be redundant. Same posture as the
            // `--client` rejection a few lines below.
            console.error(
              `Install failed: --print-config must be 'json' or 'toml', got '${opts.printConfig}'.`,
            )
            process.exit(1)
          }
          // --client, --project, and --cursor-global are accepted but ignored
          // when --print-config is set. The escape-hatch flag prints to stdout
          // regardless of which assistant the operator nominally targeted;
          // --project would have controlled the on-disk write directory but
          // no file is written. --legacy-paths and --yarn-pnp / --no-yarn-pnp
          // ARE honored — they control the shape of the printed snippet so
          // operators can copy-paste the right form for their consumer
          // (bin-dispatch shape default; yarn-wrapped under --yarn-pnp; legacy
          // absolute-path under --legacy-paths). Auto-detection from
          // `.pnp.cjs` is skipped on this path because no project dir is
          // resolved.
          const printBinShape: BinDispatchShape =
            opts.yarnPnp === true ? "yarn" : "bare"
          // --project resolves the configRoot embedded in the
          // printed snippet's LORE_CONFIG_ROOT so the MCP server
          // spawned from a paste finds the right .lore.yaml. This
          // is a behavior tweak from the prior "accepted but
          // ignored" comment on --project: the file-write path was
          // never meaningful, but the configRoot WAS — so honor it
          // for that one purpose only.
          await runPrintConfig(
            format,
            !!opts.legacyPaths,
            printBinShape,
            opts.project,
          )
          return
        }

        if (isDeprecatedInstallClient(opts.client)) {
          // `console.warn` writes to stderr — kept distinct from the install
          // body's stdout so CI scripts that capture stdout for diffing don't
          // see deprecation noise mixed with install output.
          console.warn(
            "Warning: --client both is deprecated; use --client all (mapped automatically).",
          )
        }
        const client = parseInstallClient(opts.client)
        if (!client) {
          console.error(
            "Install failed: --client must be one of claude, codex, cursor, or all.",
          )
          process.exit(1)
        }

        const cursorGlobalNotice = buildCursorGlobalIgnoredNotice(
          opts.cursorGlobal,
          client,
        )
        if (cursorGlobalNotice) {
          console.warn(cursorGlobalNotice)
        }

        await runInstall({
          client,
          project: opts.project,
          yes: opts.yes,
          cursorGlobal: opts.cursorGlobal,
          legacyPaths: opts.legacyPaths,
          yarnPnp: opts.yarnPnp,
        })
      } catch (err) {
        console.error("Install failed:", err instanceof Error ? err.message : err)
        process.exit(1)
      }
    },
  )
