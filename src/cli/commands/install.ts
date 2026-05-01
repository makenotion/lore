import { Command } from "commander"
import { readFile, writeFile, mkdir, access, chmod, rename, unlink } from "node:fs/promises"
import { join, dirname, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline/promises"
import { findConfigFile, loadConfig } from "../../config.js"
import { loadCredentials } from "../../auth/oauth.js"

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
 * - `yarn` — `command: "yarn"`, `args: ["lore", "mcp"]`. Resolves
 *   through Yarn Berry / Yarn 4 PnP, which does NOT populate
 *   `node_modules/.bin` and therefore cannot satisfy the bare shape
 *   when a host launches `command: "lore"` directly. The `yarn`
 *   wrapper loads `.pnp.cjs` and resolves the bin via PnPAPI.
 *
 * The legacy absolute-path shape (`node <pkgRoot>/dist/mcp.js`) is
 * orthogonal — selected via `legacyPaths`, not via this enum — and
 * remains unchanged through the deprecation window.
 */
export type BinDispatchShape = "bare" | "yarn"

/**
 * Env variables the MCP server honors at runtime and that the installer
 * forwards into Claude and Codex project config. Emission is unconditional:
 * shared config must not depend on which developer ran `lore install` first.
 */
const LORE_MCP_ENV_VARS = ["LORE_NOTION_TOKEN", "LORE_NOTION_BASE_URL"] as const

function resolvePkgRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..")
}

/**
 * Detect whether `projectDir` (or any ancestor up to `homedir()`) is a
 * Yarn Berry / Yarn 4 PnP consumer. Yarn PnP installs do NOT populate
 * `node_modules/.bin/lore`, so the bare bin-dispatch shape
 * (`command: "lore"`) cannot resolve at host-launch time. Detection
 * here drives the install runner to emit the yarn-wrapped shape
 * (`command: "yarn", args: ["lore", "mcp"]`) instead.
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

const LORE_MCP_ENV_PASSTHROUGH = (): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const key of LORE_MCP_ENV_VARS) {
    env[key] = `\${${key}}`
  }
  return env
}

/**
 * Build the bin-dispatch `.mcp.json` entry for Lore. Emits
 * `{ command: "lore", args: ["mcp"], env: ... }` for `shape: "bare"`
 * (default), or `{ command: "yarn", args: ["lore", "mcp"], env: ... }`
 * for `shape: "yarn"` (Yarn Berry PnP consumers — see
 * `BinDispatchShape`). The Notion env-var passthrough block is
 * preserved either way.
 *
 * Hosts resolve `lore` through the consumer repo's
 * `node_modules/.bin/lore` symlink in the bare shape, or through
 * `yarn run lore` PnPAPI resolution in the yarn shape. Both produce
 * committed config that is portable across every engineer's checkout
 * regardless of the absolute path of the consumer repo on disk.
 */
export function buildClaudeMcpEntry(shape: BinDispatchShape = "bare"): ClaudeMcpEntry {
  if (shape === "yarn") {
    return {
      command: "yarn",
      args: ["lore", "mcp"],
      env: LORE_MCP_ENV_PASSTHROUGH(),
    }
  }
  return {
    command: "lore",
    args: ["mcp"],
    env: LORE_MCP_ENV_PASSTHROUGH(),
  }
}

/**
 * Legacy absolute-path `.mcp.json` shape used by `~/.lore` consumers
 * pre-0.11.0. Preserved through 0.11.x for the deprecation window;
 * `lore install --legacy-paths` opts back in. Targeted for removal in
 * 0.12.0 alongside the standalone `dist/mcp.js` tsup entry.
 */
export function buildLegacyClaudeMcpEntry(mcpJsPath: string, cwd: string): ClaudeMcpEntry {
  return {
    command: "node",
    args: [mcpJsPath],
    cwd,
    env: LORE_MCP_ENV_PASSTHROUGH(),
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

export function buildCursorMcpEntry(shape: BinDispatchShape = "bare"): CursorMcpEntry {
  if (shape === "yarn") {
    return {
      command: "yarn",
      args: ["lore", "mcp"],
      env: LORE_MCP_ENV_PASSTHROUGH(),
    }
  }
  return {
    command: "lore",
    args: ["mcp"],
    env: LORE_MCP_ENV_PASSTHROUGH(),
  }
}

export function buildLegacyCursorMcpEntry(mcpJsPath: string, cwd: string): CursorMcpEntry {
  return {
    command: "node",
    args: [mcpJsPath],
    cwd,
    env: LORE_MCP_ENV_PASSTHROUGH(),
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
export function buildCodexMcpSection(shape: BinDispatchShape = "bare"): string {
  if (shape === "yarn") {
    return [
      "[mcp_servers.lore]",
      'command = "yarn"',
      'args = ["lore", "mcp"]',
      `env_vars = ${formatTomlArray(LORE_MCP_ENV_VARS)}`,
    ].join("\n")
  }
  return [
    "[mcp_servers.lore]",
    'command = "lore"',
    'args = ["mcp"]',
    `env_vars = ${formatTomlArray(LORE_MCP_ENV_VARS)}`,
  ].join("\n")
}

export function buildLegacyCodexMcpSection(mcpJsPath: string): string {
  const portableMcpJsPath = toPortablePath(mcpJsPath)
  const launchCommand = `node ${JSON.stringify(portableMcpJsPath)}`

  return [
    "[mcp_servers.lore]",
    'command = "bash"',
    `args = ["-lc", ${JSON.stringify(launchCommand)}]`,
    `env_vars = ${formatTomlArray(LORE_MCP_ENV_VARS)}`,
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
export function buildClaudeHookCommand(
  eventName: HookEventName,
  shape: BinDispatchShape = "bare",
): string {
  return shape === "yarn" ? `yarn lore hooks ${eventName}` : `lore hooks ${eventName}`
}

export function buildCodexHookCommand(
  eventName: HookEventName,
  shape: BinDispatchShape = "bare",
): string {
  const tail = shape === "yarn" ? `yarn lore hooks ${eventName}` : `lore hooks ${eventName}`
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
 * the entire deploy surface today: `wakeup` (UserPromptSubmit /
 * SessionStart), `autosave` (Stop), and `session-end` (compatibility
 * shim).
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

  for (const entry of entries) {
    for (const hook of entry.hooks ?? []) {
      const cmd = hook.command
      if (typeof cmd !== "string") continue
      // Bin-dispatch form: exact match against `lore hooks <event>`.
      if (binDispatchCommand && cmd === binDispatchCommand) return "current"
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
  // Match BOTH bin-dispatch shapes — bare (`lore hooks <event>`) and
  // yarn-wrapped (`yarn lore hooks <event>`) — so a Yarn-PnP-aware
  // reinstall over a bare bin entry (or vice versa) doesn't leave
  // both shapes in `Stop[]`. Same posture as the legacy `.sh` strip
  // below.
  const binDispatchPattern =
    /^(?:yarn )?lore hooks (?:wakeup|autosave|session-end)$/
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

  for (const entry of entries) {
    for (const hook of entry.hooks ?? []) {
      const cmd = hook.command
      if (typeof cmd !== "string") continue
      if (binDispatchCommand && cmd === binDispatchCommand) return "current"
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
 * Remove every Codex hook entry whose command is one of the
 * bin-dispatch shapes (`LORE_AGENT_NAME=Codex lore hooks <event>` OR
 * `LORE_AGENT_NAME=Codex yarn lore hooks <event>`) for the given
 * event. The runner needs both stripped so flipping between any pair
 * of shapes (legacy ↔ bare-bin ↔ yarn-bin) leaves only the single
 * canonical entry behind.
 */
function stripCodexBinDispatchHook(
  hooks: Record<string, CodexHookEntry[]>,
  eventName: HookEventName,
): Record<string, CodexHookEntry[]> {
  const targets = new Set([
    buildCodexHookCommand(eventName, "bare"),
    buildCodexHookCommand(eventName, "yarn"),
  ])
  const next: Record<string, CodexHookEntry[]> = {}
  for (const [event, entries] of Object.entries(hooks)) {
    const filtered = entries.filter(
      (entry) =>
        !entry.hooks?.some(
          (hook) => typeof hook.command === "string" && targets.has(hook.command),
        ),
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
   * (`command: "yarn", args: ["lore", "mcp"]` and
   * `yarn lore hooks <event>`) so the host assistant can invoke the
   * lore bin through Yarn Berry / Yarn 4 PnP, which does NOT populate
   * `node_modules/.bin/`. Ignored when `legacyPaths === true` (legacy
   * shape predates the PnP question). Operators can force-disable via
   * `--no-yarn-pnp` if their consumer fixes PnP bin resolution
   * out-of-band.
   */
  yarnPnp: boolean
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

async function prepareInstallContext(
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

  return {
    projectDir,
    pkgRoot,
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

async function printPrerequisites(projectDir: string): Promise<void> {
  console.log("Checking prerequisites...")

  const envToken = process.env["LORE_NOTION_TOKEN"]
  if (envToken) {
    console.log("  Auth: LORE_NOTION_TOKEN (environment variable)")
  } else {
    const creds = await loadCredentials()
    if (creds?.access_token) {
      console.log("  Auth: OAuth credentials")
    } else {
      console.log("  Auth: not configured")
      console.log("    Set LORE_NOTION_TOKEN or run 'lore auth --login'")
    }
  }

  const configFound = await findConfigFile(projectDir)
  if (configFound) {
    console.log("  Vault: .lore.yaml found")
  } else {
    console.log("  Vault: .lore.yaml not found")
    console.log("    Run 'lore init <page-id>' to create a vault")
  }
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
  const binMcpEntry = buildClaudeMcpEntry(binShape)
  const legacyMcpEntry = buildLegacyClaudeMcpEntry(portableMcpJsPath, portablePkgRoot)
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

async function runCodexInstall(
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
  const binMcpSection = buildCodexMcpSection(binShape)
  const legacyMcpSection = buildLegacyCodexMcpSection(context.mcpJsPath)
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
    codexHooks["SessionStart"],
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

  const allCurrent =
    isEffectivelyCurrent(mcpStatus, context.legacyPaths) &&
    hooksFeatureStatus === "current" &&
    isEffectivelyCurrent(wakeupStatus, context.legacyPaths) &&
    isEffectivelyCurrent(autosaveStatus, context.legacyPaths)

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
  nextHookEvents["SessionStart"] = mergeCodexHookEntries(
    nextHookEvents["SessionStart"],
    desiredWakeupCommand,
    {
      matcher: "startup|resume",
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
  const binMcpEntry = buildCursorMcpEntry(binShape)
  const legacyMcpEntry = buildLegacyCursorMcpEntry(portableMcpJsPath, portablePkgRoot)
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

  await printPrerequisites(context.projectDir)
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
  legacyPaths = false,
  binShape: BinDispatchShape = "bare",
): string {
  const portableMcpJsPath = toPortablePath(mcpJsPath)
  const portablePkgRoot = toPortablePath(pkgRoot)

  if (format === "json") {
    const entry = legacyPaths
      ? buildLegacyClaudeMcpEntry(portableMcpJsPath, portablePkgRoot)
      : buildClaudeMcpEntry(binShape)
    return JSON.stringify({ mcpServers: { lore: entry } }, null, 2) + "\n"
  }

  const section = legacyPaths
    ? buildLegacyCodexMcpSection(portableMcpJsPath)
    : buildCodexMcpSection(binShape)
  return section + "\n"
}

/**
 * `--print-config` runtime path. Resolves `pkgRoot` and `mcpJsPath` via the
 * same helpers the install paths use, validates `dist/mcp.js` exists (the
 * printed `args[0]` would otherwise point at a non-existent file), and
 * writes the snippet to stdout. No filesystem writes — `--project` is
 * accepted upstream as a no-op and never reaches this function.
 */
async function runPrintConfig(
  format: PrintConfigFormat,
  legacyPaths: boolean,
  binShape: BinDispatchShape,
): Promise<void> {
  const pkgRoot = resolvePkgRoot()
  const mcpJsPath = join(pkgRoot, "dist", "mcp.js")

  if (!(await fileExists(mcpJsPath))) {
    throw new Error(
      `dist/mcp.js not found at ${mcpJsPath}. Run 'npm run build' first.`,
    )
  }

  process.stdout.write(
    buildPrintConfigOutput(format, mcpJsPath, pkgRoot, legacyPaths, binShape),
  )
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
    "force the yarn-wrapped bin-dispatch shape ('yarn lore mcp', 'yarn lore hooks <event>'). Auto-detected from a .pnp.cjs marker; this flag pins it explicitly",
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
          await runPrintConfig(format, !!opts.legacyPaths, printBinShape)
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
