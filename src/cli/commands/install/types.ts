import type { AuthSource } from "../../../config.js"
import type { RuntimeForwardedKey } from "../../../auth/forwarded-env.js"

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
 *   Default `lore install` (no legacy absolute-path mode) reports this and
 *   rewrites to bin-dispatch; `lore install` treats it
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
 * The legacy absolute-path shape (an explicit `node` invocation
 * against the built MCP entry under the package root) is orthogonal
 * — selected via `legacyPaths`, not via this enum.
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
   *     right .lore.yaml even when the host's spawn-time cwd does
   *     not match the operator's vault directory.
   *   - `LORE_SUPPRESS_DEPRECATIONS` — keeps older spawned children quiet
   *     when an operator runs mixed local/global versions during upgrade.
   * Claude / Cursor consumers merge these into `env` directly. Codex
   * consumers prefix them onto its `bash -lc` launch command because
   * its `env_vars = [...]` shape only carries name-only references.
   */
  staticEnv: Record<string, string>
  /** Which runtime-forwarded keys were detected in the install-time env. */
  forwarded: RuntimeForwardedKey[]
}

export interface BuildMcpEnvOptions {
  /**
   * Skip the `LORE_CONFIG_ROOT` static entry. Used by the Yarn-PnP
   * shape because committed .mcp.json / .cursor/mcp.json /
   * .codex/config.toml files are workspace-shared across
   * developers, and an absolute machine path (`/Users/foo/myrepo`)
   * leaks one developer's checkout into the others'. Under PnP
   * launches via `yarn run -T lore mcp`, the spawned MCP server's
   * cwd is the workspace root — `findConfigFile(cwd)` walks
   * upward from there and resolves .lore.yaml without help.
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
   * The env-token source keeps the conditional forward: a placeholder
   * is still emitted when the operator had NOTION_API_TOKEN set at
   * install time because the spawned MCP server cannot fall back to
   * ntn the way an `ntn-auth-json` install can. `undefined` preserves
   * the same conditional-forward behavior for print-config callers
   * that do not have an auth source to consult.
   */
  authSource?: AuthSource
  /**
   * When set, write `NOTION_BASE_URL` to the MCP env as a LITERAL
   * value (not a `${VAR}` placeholder), and suppress the conditional
   * forwarding of the same key. Used by `lore install --dev` so the
   * spawned MCP child targets the configured Notion API regardless
   * of whether the operator's shell carries `NOTION_BASE_URL` /
   * `NOTION_ENV` at MCP-spawn time. Without this, `--dev` would be
   * effective at install-time preflight (process.env mutation
   * survives the install lifetime) but would silently degrade to
   * prod at runtime when the operator's shell rc doesn't export the
   * dev signals.
   *
   * Literal-value MCP env entries are the same shape Codex's
   * `bash -lc` prefix uses for `LORE_CONFIG_ROOT` and
   * `LORE_SUPPRESS_DEPRECATIONS`; this is the recognized pattern for
   * "the install knows the right value, don't depend on operator
   * shell."
   */
  notionBaseUrlLiteral?: string
}

export interface McpLauncherClassificationOptions {
  configRoot: string
  yarnPnp?: boolean
  envSource?: NodeJS.ProcessEnv
  authSource?: AuthSource
  notionBaseUrlLiteral?: string
}

export interface CursorMcpLauncherClassificationOptions extends McpLauncherClassificationOptions {
  useGlobalScope?: boolean
  launchCwd?: string
}

export interface InstallContext {
  projectDir: string
  pkgRoot: string
  /**
   * Resolved .lore.yaml directory — `findConfigFile(projectDir).root`
   * when a config exists, falling back to `projectDir` otherwise. This
   * is the value forwarded into the MCP entry as `LORE_CONFIG_ROOT` so
   * the spawned MCP server's `resolveAuth` walks the right .lore.yaml
   * regardless of the host's spawn-time cwd.
   */
  configRoot: string
  autosavePath: string
  wakeupPath: string
  mcpJsPath: string
  skipPrompts: boolean
  /**
   * `true`/`false` when .lore.yaml sets `hooks.wakeUp` explicitly; `null`
   * when no config exists yet or the flag is unset (hook default applies).
   */
  wakeUpConfig: boolean | null
  /**
   * legacy absolute-path mode opt-in. When `true`, the install path emits the
   * legacy absolute-path shape (an explicit `node` invocation against
   * the built MCP entry under `${HOME}/.lore/`, plus the matching shell
   * wakeup wrapper) and the prerequisite checks verify the legacy
   * shell wrappers exist. When `false` (default), the install path
   * emits the bin-dispatch shape (`lore mcp`, `lore hooks <event>`)
   * and the prerequisite checks skip the shell-wrapper verification
   * entirely because the bin-dispatch path doesn't depend on the
   * legacy hook scripts.
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
   * failed — both cases preserve the earlier unconditional-forward
   * behavior so legacy operators never lose access by upgrading.
   */
  authSource?: AuthSource
  /**
   * Literal `NOTION_BASE_URL` value to inject into the spawned MCP
   * env when set. Populated by `runInstall` when `--dev` is passed,
   * making `--dev` runtime-effective for the spawned MCP child
   * regardless of whether the operator's shell carries the matching
   * env signal. Threaded through to `buildMcpEnv`'s
   * `notionBaseUrlLiteral` option.
   *
   * Mutually exclusive with `${NOTION_BASE_URL}` placeholder
   * forwarding inside the same install: when this is set,
   * `buildMcpEnv` suppresses the placeholder so the static literal
   * is the single source of truth for that env entry.
   */
  notionBaseUrlLiteral?: string
}
