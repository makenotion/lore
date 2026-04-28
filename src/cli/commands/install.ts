import { Command } from "commander"
import { readFile, writeFile, mkdir, access, chmod, rename, unlink } from "node:fs/promises"
import { join, dirname, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline/promises"
import { findConfigFile, loadConfig } from "../../config.js"
import { loadCredentials } from "../../auth/oauth.js"

type InstallClient = "claude" | "codex" | "both"
export type HookStatus = "current" | "stale" | "missing"

/**
 * Env variables the MCP server honors at runtime and that the installer
 * forwards into Claude and Codex project config. Emission is unconditional:
 * shared config must not depend on which developer ran `lore install` first.
 */
const LORE_MCP_ENV_VARS = ["LORE_NOTION_TOKEN", "LORE_NOTION_BASE_URL"] as const

function resolvePkgRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..")
}

function encodeProjectPath(absPath: string): string {
  return absPath.replace(/\//g, "-")
}

interface ClaudeMcpEntry {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

function buildClaudeMcpEntry(mcpJsPath: string, cwd: string): ClaudeMcpEntry {
  const env: Record<string, string> = {}
  for (const key of LORE_MCP_ENV_VARS) {
    env[key] = `\${${key}}`
  }
  return {
    command: "node",
    args: [mcpJsPath],
    cwd,
    env,
  }
}

function formatTomlArray(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`
}

function buildCodexMcpSection(mcpJsPath: string): string {
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
export function buildCodexHookCommand(scriptPath: string): string {
  return CODEX_AGENT_ENV_PREFIX + JSON.stringify(toPortablePath(scriptPath))
}

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

function statusLabel(status: HookStatus): string {
  return status === "current"
    ? "already installed"
    : status === "stale"
      ? "update available"
      : "not installed"
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

export function detectClaudeHook(
  entries: ClaudeHookEntry[] | undefined,
  scriptName: string,
  expectedPath: string,
): HookStatus {
  if (!entries) return "missing"

  for (const entry of entries) {
    for (const hook of entry.hooks ?? []) {
      if (typeof hook.command === "string" && hook.command.endsWith(`/${scriptName}`)) {
        return hook.command === expectedPath ? "current" : "stale"
      }
    }
  }
  return "missing"
}

function mergeClaudeHookEntries(
  existing: ClaudeHookEntry[] | undefined,
  scriptName: string,
  newPath: string,
  config: { matcher: string; timeout?: number; runOnce?: boolean },
): ClaudeHookEntry[] {
  const filtered = (existing ?? []).filter(
    (entry) =>
      !entry.hooks?.some(
        (hook) => typeof hook.command === "string" && hook.command.endsWith(`/${scriptName}`),
      ),
  )
  filtered.push({
    matcher: config.matcher,
    hooks: [{
      type: "command",
      command: newPath,
      ...(config.timeout != null ? { timeout: config.timeout } : {}),
      ...(config.runOnce != null ? { runOnce: config.runOnce } : {}),
    }],
  })
  return filtered
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

export function detectCodexHook(
  entries: CodexHookEntry[] | undefined,
  scriptName: string,
  expectedCommand: string,
): HookStatus {
  if (!entries) return "missing"

  for (const entry of entries) {
    for (const hook of entry.hooks ?? []) {
      if (typeof hook.command === "string" && commandTargetsScript(hook.command, scriptName)) {
        return hook.command === expectedCommand ? "current" : "stale"
      }
    }
  }
  return "missing"
}

function mergeCodexHookEntries(
  existing: CodexHookEntry[] | undefined,
  scriptName: string,
  command: string,
  config: { matcher?: string; timeout?: number; statusMessage?: string },
): CodexHookEntry[] {
  const filtered = (existing ?? []).filter(
    (entry) =>
      !entry.hooks?.some(
        (hook) => typeof hook.command === "string" && commandTargetsScript(hook.command, scriptName),
      ),
  )
  filtered.push({
    ...(config.matcher ? { matcher: config.matcher } : {}),
    hooks: [{
      type: "command",
      command,
      ...(config.timeout != null ? { timeout: config.timeout } : {}),
      ...(config.statusMessage ? { statusMessage: config.statusMessage } : {}),
    }],
  })
  return filtered
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
  const displayPath = filePath.replace(homedir(), "~")
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

interface InstallContext {
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
    const displayPath = found.path.replace(homedir(), "~")
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
  opts: { yes?: boolean; project?: string },
): Promise<InstallContext> {
  const projectDir = resolve(opts.project ?? process.cwd())
  const pkgRoot = resolvePkgRoot()
  const skipPrompts = opts.yes || !process.stdin.isTTY

  const autosavePath = join(pkgRoot, "hooks", "autosave.sh")
  const wakeupPath = join(pkgRoot, "hooks", "wakeup.sh")
  const mcpJsPath = join(pkgRoot, "dist", "mcp.js")

  const [hasAutosave, hasWakeup, hasMcpJs] = await Promise.all([
    fileExists(autosavePath),
    fileExists(wakeupPath),
    fileExists(mcpJsPath),
  ])

  if (!hasAutosave || !hasWakeup || !hasMcpJs) {
    const missing: string[] = []
    if (!hasAutosave) missing.push("  hooks/autosave.sh")
    if (!hasWakeup) missing.push("  hooks/wakeup.sh")
    if (!hasMcpJs) missing.push("  dist/mcp.js")
    console.error("Required files not found:")
    for (const path of missing) console.error(path)
    console.error()
    console.error("Run 'npm run build' first.")
    process.exit(1)
  }

  await Promise.all([
    chmod(autosavePath, 0o755),
    chmod(wakeupPath, 0o755),
  ])

  const wakeUpConfig = await readWakeUpConfig(projectDir)

  return {
    projectDir,
    pkgRoot,
    autosavePath,
    wakeupPath,
    mcpJsPath,
    skipPrompts,
    wakeUpConfig,
  }
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
  const encodedPath = encodeProjectPath(context.projectDir)
  const settingsPath = join(homedir(), ".claude", "projects", encodedPath, "settings.json")
  const settings = await readJsonSafe(settingsPath)
  const mcpJsonPath = join(context.projectDir, ".mcp.json")
  const mcpJson = await readJsonSafe(mcpJsonPath)

  const hooks = (settings.hooks ?? {}) as Record<string, ClaudeHookEntry[]>
  const autosaveStatus = detectClaudeHook(hooks["Stop"], "autosave.sh", context.autosavePath)
  const wakeupStatus = detectClaudeHook(
    hooks["UserPromptSubmit"],
    "wakeup.sh",
    context.wakeupPath,
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
  const expectedMcpEntry = buildClaudeMcpEntry(portableMcpJsPath, portablePkgRoot)
  const mcpStatus: HookStatus = !existingMcp
    ? "missing"
    : deepEqual(existingMcp, expectedMcpEntry)
      ? "current"
      : "stale"

  console.log("Claude Code:")
  console.log(`  MCP server:        ${statusLabel(mcpStatus)}`)
  console.log(`  Autosave hook:     ${statusLabel(autosaveStatus)}`)
  console.log(
    `  Wakeup hook:       ${statusLabel(wakeupStatus)}${wakeupStatusSuffix(context.wakeUpConfig)}`,
  )
  if (hasSessionEndShim) console.log("  Session-end hook:  will remove")
  if (hasLegacyAutosave) console.log("  Legacy hook:       PostToolUse/Stop -> will migrate")
  if (hasLegacyWakeup) console.log("  Legacy hook:       PreToolUse/Task -> will migrate")
  if (hasLegacySessionEndAutosave)
    console.log("  Legacy hook:       SessionEnd/autosave.sh -> will remove")
  if (hasLegacyPreCompact) console.log("  Legacy hook:       PreCompact -> will remove")
  if (hasLegacyMcp) console.log("  Legacy MCP:        settings.json -> will migrate to .mcp.json")

  const allCurrent =
    autosaveStatus === "current" &&
    wakeupStatus === "current" &&
    !hasSessionEndShim &&
    mcpStatus === "current" &&
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

  if (autosaveStatus !== "current") {
    mergedHooks["Stop"] = mergeClaudeHookEntries(
      hooks["Stop"],
      "autosave.sh",
      context.autosavePath,
      // Claude settings use hook timeouts in milliseconds.
      { matcher: "", timeout: 10000 },
    )
  }

  if (wakeupStatus !== "current") {
    mergedHooks["UserPromptSubmit"] = mergeClaudeHookEntries(
      hooks["UserPromptSubmit"],
      "wakeup.sh",
      context.wakeupPath,
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

  const settingsDisplay = settingsPath.replace(homedir(), "~")
  console.log()
  console.log(`  Writing: ${settingsDisplay}`)
  await writeJsonFile(settingsPath, merged)

  if (mcpStatus !== "current") {
    const mergedMcpJson: Record<string, unknown> = { ...mcpJson }
    mergedMcpJson.mcpServers = {
      ...((mcpJson.mcpServers as Record<string, unknown>) ?? {}),
      lore: expectedMcpEntry,
    }

    const mcpJsonDisplay = mcpJsonPath.replace(homedir(), "~")
    console.log(`  Writing: ${mcpJsonDisplay}`)
    await writeJsonFile(mcpJsonPath, mergedMcpJson)

    if (!portableMcpJsPath.startsWith("${HOME}")) {
      console.warn()
      console.warn("  Warning: lore is installed outside your home directory")
      console.warn(`    (${context.pkgRoot}).`)
      console.warn("  The generated .mcp.json uses an absolute path and is not")
      console.warn("  portable across machines - avoid committing it, or reinstall")
      console.warn("  lore under ~/.lore so the path can use ${HOME}.")
    }
  }

  console.log()
  if (mcpStatus !== "current") console.log("  MCP server:        installed (.mcp.json)")
  if (autosaveStatus !== "current") console.log("  Autosave hook:     installed")
  if (wakeupStatus !== "current") console.log("  Wakeup hook:       installed")
  if (hasSessionEndShim || hasLegacySessionEndAutosave)
    console.log("  Session-end hook:  removed (autosave covers Stop only)")
  if (hasLegacyMcp) console.log("  Legacy MCP:        removed from settings.json")
  console.log("  Restart Claude Code for changes to take effect.")
}

async function runCodexInstall(
  context: InstallContext,
  rl: ReturnType<typeof createInterface> | null,
): Promise<void> {
  const codexConfigPath = join(context.projectDir, ".codex", "config.toml")
  const codexHooksPath = join(context.projectDir, ".codex", "hooks.json")
  const codexConfig = await readTextSafe(codexConfigPath)
  assertTomlSupportsLoreRewrite(codexConfig, codexConfigPath)
  const codexHooksJson = await readJsonSafe(codexHooksPath)
  const codexHooks = (codexHooksJson.hooks ?? {}) as Record<string, CodexHookEntry[]>

  const expectedMcpSection = buildCodexMcpSection(context.mcpJsPath)
  const existingMcpSection = extractTomlTableGroup(codexConfig, "mcp_servers.lore")
  const hooksFeatureValue = extractTomlKeyValue(codexConfig, "features", "codex_hooks")
  const wakeupCommand = buildCodexHookCommand(context.wakeupPath)
  const autosaveCommand = buildCodexHookCommand(context.autosavePath)

  const mcpStatus: HookStatus = !existingMcpSection
    ? "missing"
    : existingMcpSection.trim() === expectedMcpSection.trim()
      ? "current"
      : "stale"
  const hooksFeatureStatus: HookStatus =
    hooksFeatureValue == null
      ? "missing"
      : hooksFeatureValue === "true"
        ? "current"
        : "stale"
  const wakeupStatus = detectCodexHook(codexHooks["SessionStart"], "wakeup.sh", wakeupCommand)
  const autosaveStatus = detectCodexHook(codexHooks["Stop"], "autosave.sh", autosaveCommand)

  console.log("Codex:")
  console.log(`  MCP server:        ${statusLabel(mcpStatus)}`)
  console.log(`  Hooks feature:     ${statusLabel(hooksFeatureStatus)}`)
  console.log(
    `  Wakeup hook:       ${statusLabel(wakeupStatus)}${wakeupStatusSuffix(context.wakeUpConfig)}`,
  )
  console.log(`  Autosave hook:     ${statusLabel(autosaveStatus)}`)

  const allCurrent =
    mcpStatus === "current" &&
    hooksFeatureStatus === "current" &&
    wakeupStatus === "current" &&
    autosaveStatus === "current"

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
  nextConfig = appendTomlBlock(nextConfig, expectedMcpSection)

  let nextHookEvents = stripCodexScriptFromAllEvents(codexHooks, "wakeup.sh")
  nextHookEvents = stripCodexScriptFromAllEvents(nextHookEvents, "autosave.sh")
  nextHookEvents["SessionStart"] = mergeCodexHookEntries(
    nextHookEvents["SessionStart"],
    "wakeup.sh",
    wakeupCommand,
    {
      matcher: "startup|resume",
      statusMessage: "Loading Lore context",
    },
  )
  nextHookEvents["Stop"] = mergeCodexHookEntries(
    nextHookEvents["Stop"],
    "autosave.sh",
    autosaveCommand,
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
    const configDisplay = codexConfigPath.replace(homedir(), "~")
    console.log()
    console.log(`  Writing: ${configDisplay}`)
    await writeTextFile(codexConfigPath, nextConfig)
  }

  if (!deepEqual(nextHooksJson, codexHooksJson)) {
    const hooksDisplay = codexHooksPath.replace(homedir(), "~")
    console.log(`  Writing: ${hooksDisplay}`)
    await writeJsonFile(codexHooksPath, nextHooksJson)
  }

  const portableMcpJsPath = toPortablePath(context.mcpJsPath)
  if (!portableMcpJsPath.startsWith("${HOME}")) {
    console.warn()
    console.warn("  Warning: lore is installed outside your home directory")
    console.warn(`    (${context.pkgRoot}).`)
    console.warn("  The generated .codex/config.toml uses an absolute path and is not")
    console.warn("  portable across machines - avoid committing it, or reinstall")
    console.warn("  lore under ~/.lore so the path can use ${HOME}.")
  }

  console.log()
  if (mcpStatus !== "current") console.log("  MCP server:        installed (.codex/config.toml)")
  if (hooksFeatureStatus !== "current") console.log("  Hooks feature:     enabled")
  if (wakeupStatus !== "current") console.log("  Wakeup hook:       installed")
  if (autosaveStatus !== "current") console.log("  Autosave hook:     installed")
  console.log("  Start a new Codex session after trusting this project.")
  console.log("  Codex only loads project-scoped .codex/* files for trusted projects.")
}

async function runInstall(opts: {
  client: InstallClient
  yes?: boolean
  project?: string
}): Promise<void> {
  const context = await prepareInstallContext(opts)

  const title =
    opts.client === "claude"
      ? "Claude Code Integration"
      : opts.client === "codex"
        ? "Codex Integration"
        : "AI Assistant Integration"

  console.log()
  console.log(`Lore — ${title}`)
  console.log("─".repeat(40))
  console.log(`Project: ${context.projectDir}`)
  console.log()

  await printPrerequisites(context.projectDir)
  console.log()

  if (opts.client === "codex" || opts.client === "both") {
    await preflightCodexInstall(context)
  }

  const rl = context.skipPrompts
    ? null
    : createInterface({ input: process.stdin, output: process.stdout })

  try {
    if (opts.client === "claude" || opts.client === "both") {
      await runClaudeInstall(context, rl)
    }
    if (opts.client === "both") console.log()
    if (opts.client === "codex" || opts.client === "both") {
      await runCodexInstall(context, rl)
    }
  } finally {
    rl?.close()
  }
}

export function parseInstallClient(value: string | undefined): InstallClient | null {
  if (!value) return "both"
  if (value === "claude" || value === "codex") {
    return value
  }
  return null
}

export const installCommand = new Command("install")
  .description("Install Lore assistant integrations for the current project")
  .option(
    "--client <assistant>",
    "assistant to configure: claude or codex; omit --client to install both",
  )
  .option("--project <path>", "project directory (default: cwd)")
  .option("-y, --yes", "skip confirmation prompts")
  .action(async (opts: { client?: string; project?: string; yes?: boolean }) => {
    try {
      const client = parseInstallClient(opts.client)
      if (!client) {
        console.error("Install failed: --client must be one of claude or codex.")
        process.exit(1)
      }

      await runInstall({
        client,
        project: opts.project,
        yes: opts.yes,
      })
    } catch (err) {
      console.error("Install failed:", err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })
