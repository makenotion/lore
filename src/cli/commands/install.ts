import { Command } from "commander"
import { readFile, writeFile, mkdir, access, chmod, rename, unlink } from "node:fs/promises"
import { join, dirname, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline/promises"
import { findConfigFile } from "../../config.js"
import { loadCredentials } from "../../auth/oauth.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolvePkgRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..")
}

function encodeProjectPath(absPath: string): string {
  return absPath.replace(/\//g, "-")
}

/**
 * Env variables the MCP server honors at runtime and that the installer
 * forwards into `.mcp.json`. Values are the `${VAR}` token form — Claude
 * Code expands them from the caller's environment at server launch time,
 * so emitting a key the installing user has not exported is harmless (the
 * expansion yields an empty string, same as it would for any unset var).
 *
 * Emission is unconditional on purpose: `.mcp.json` is committed to the
 * consumer repo, so the set of keys must not depend on which developer
 * happened to run `lore install` first. A developer whose shell defines
 * `LORE_NOTION_BASE_URL` needs it forwarded even if the original installer
 * did not have that var set.
 */
const MCP_FORWARDED_ENV_VARS = ["LORE_NOTION_TOKEN", "LORE_NOTION_BASE_URL"] as const

interface McpEntry {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

function buildMcpEntry(mcpJsPath: string, cwd: string): McpEntry {
  const env: Record<string, string> = {}
  for (const key of MCP_FORWARDED_ENV_VARS) {
    env[key] = `\${${key}}`
  }
  return {
    command: "node",
    args: [mcpJsPath],
    cwd,
    env,
  }
}

/**
 * Structural equality for plain JSON-ish values. Used to decide whether an
 * on-disk `.mcp.json` entry already matches the entry we would write right
 * now, so the installer doesn't churn the file on every run.
 */
function deepEqual(a: unknown, b: unknown): boolean {
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
 * Rewrite an absolute path under the user's home directory into a
 * `${HOME}`-prefixed form. `.mcp.json` is committed to consumer repos and
 * shared across developers, so any absolute path inside `$HOME` would break
 * on every other machine. Claude Code expands `${VAR}` inside `command`,
 * `args`, `cwd`, and `env` values when it reads `.mcp.json`.
 *
 * Paths outside `$HOME` (e.g. a global npm install under `/opt` or
 * `/usr/local`) are returned unchanged — there is no portable substitution.
 */
function toPortablePath(absPath: string): string {
  const home = homedir()
  // A home of "/" (extremely unusual, e.g. root with no home set) would make
  // the prefix check below match every absolute path and turn `/opt/x` into
  // `${HOME}/opt/x` — the very breakage this helper is meant to prevent.
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
    return JSON.parse(raw) as Record<string, unknown>
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "ENOENT") return {}
    throw err
  }
}

async function writeJsonFile(
  filePath: string,
  data: Record<string, unknown>
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  // Write to a sibling temp file then rename — POSIX `rename` on the same
  // filesystem is atomic, so a crash or I/O error mid-write cannot leave
  // a half-written file on disk. Matters especially for `.mcp.json`, which
  // is committed to consumer repos.
  const tmpPath = `${filePath}.${process.pid}.tmp`
  try {
    await writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8")
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
  defaultYes = true
): Promise<boolean> {
  if (!rl) return defaultYes
  const suffix = defaultYes ? "[Y/n]" : "[y/N]"
  const answer = await rl.question(`${message} ${suffix} `)
  const normalized = answer.trim().toLowerCase()
  if (normalized === "") return defaultYes
  return normalized === "y" || normalized === "yes"
}

// ---------------------------------------------------------------------------
// Hook detection
// ---------------------------------------------------------------------------

type HookStatus = "current" | "stale" | "missing"

interface HookEntry {
  matcher: string
  hooks: Array<{
    type: string
    command: string
    timeout?: number
    runOnce?: boolean
  }>
}

function detectHook(
  entries: HookEntry[] | undefined,
  scriptName: string,
  expectedPath: string
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

function mergeHookEntries(
  existing: HookEntry[] | undefined,
  scriptName: string,
  newPath: string,
  config: { matcher: string; timeout?: number; runOnce?: boolean }
): HookEntry[] {
  // Remove any existing entry pointing to this script (handles stale paths)
  const filtered = (existing ?? []).filter(
    (entry) =>
      !entry.hooks?.some(
        (h) => typeof h.command === "string" && h.command.endsWith(`/${scriptName}`)
      )
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

/**
 * Remove entries referencing a script from a hook event array.
 * Used to clean up legacy registrations under wrong event names.
 */
function removeScriptEntries(
  entries: HookEntry[] | undefined,
  scriptName: string
): HookEntry[] | undefined {
  if (!entries) return undefined
  const filtered = entries.filter(
    (entry) =>
      !entry.hooks?.some(
        (h) => typeof h.command === "string" && h.command.endsWith(`/${scriptName}`)
      )
  )
  return filtered.length > 0 ? filtered : undefined
}

// ---------------------------------------------------------------------------
// Install logic
// ---------------------------------------------------------------------------

async function runInstall(opts: { yes?: boolean; project?: string }): Promise<void> {
  const projectDir = resolve(opts.project ?? process.cwd())
  const pkgRoot = resolvePkgRoot()
  const skipPrompts = opts.yes || !process.stdin.isTTY

  const autosavePath = join(pkgRoot, "hooks", "autosave.sh")
  const wakeupPath = join(pkgRoot, "hooks", "wakeup.sh")
  const sessionEndPath = join(pkgRoot, "hooks", "session-end.sh")
  const mcpJsPath = join(pkgRoot, "dist", "mcp.js")

  console.log()
  console.log("Lore — Claude Code Integration")
  console.log("─".repeat(40))
  console.log(`Project: ${projectDir}`)
  console.log()

  // --- Phase 1: Verify built artifacts exist ---

  const [hasAutosave, hasWakeup, hasSessionEnd, hasMcpJs] = await Promise.all([
    fileExists(autosavePath),
    fileExists(wakeupPath),
    fileExists(sessionEndPath),
    fileExists(mcpJsPath),
  ])

  if (!hasAutosave || !hasWakeup || !hasSessionEnd || !hasMcpJs) {
    const missing: string[] = []
    if (!hasAutosave) missing.push("  hooks/autosave.sh")
    if (!hasWakeup) missing.push("  hooks/wakeup.sh")
    if (!hasSessionEnd) missing.push("  hooks/session-end.sh")
    if (!hasMcpJs) missing.push("  dist/mcp.js")
    console.error("Required files not found:")
    for (const m of missing) console.error(m)
    console.error()
    console.error("Run 'npm run build' first.")
    process.exit(1)
  }

  // Ensure hook scripts are executable
  await Promise.all([
    chmod(autosavePath, 0o755),
    chmod(wakeupPath, 0o755),
    chmod(sessionEndPath, 0o755),
  ])

  // --- Phase 2: Check prerequisites ---

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

  console.log()

  // --- Phase 3: Detect current state ---

  const encodedPath = encodeProjectPath(projectDir)
  const settingsPath = join(homedir(), ".claude", "projects", encodedPath, "settings.json")
  const settings = await readJsonSafe(settingsPath)
  const mcpJsonPath = join(projectDir, ".mcp.json")
  const mcpJson = await readJsonSafe(mcpJsonPath)

  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>

  // Autosave registers under Stop only.
  const autosaveStatus = detectHook(hooks["Stop"], "autosave.sh", autosavePath)
  const wakeupStatus = detectHook(hooks["UserPromptSubmit"], "wakeup.sh", wakeupPath)
  const sessionEndStatus = detectHook(hooks["SessionEnd"], "session-end.sh", sessionEndPath)

  // Detect legacy registrations that need cleanup
  const hasLegacyAutosave = detectHook(hooks["PostToolUse"], "autosave.sh", "") !== "missing"
  const hasLegacyWakeup = detectHook(hooks["PreToolUse"], "wakeup.sh", "") !== "missing"
  const hasLegacySessionEnd = detectHook(hooks["SessionEnd"], "autosave.sh", "") !== "missing"
  const hasLegacyPreCompact = detectHook(hooks["PreCompact"], "autosave.sh", "") !== "missing"

  // Detect stale MCP config in settings.json (legacy location — never worked)
  const hasLegacyMcp = Boolean(
    (settings.mcpServers as Record<string, unknown> | undefined)?.["lore"]
  )

  // MCP server is configured in .mcp.json (project scope), not settings.json.
  // Build the entry we would write *now* and treat "current" as a full deep
  // match against what's already on disk. A partial match (e.g. matching
  // paths but a drifted `env` block, or an absolute path that happens to
  // resolve to the same file) registers as "stale" so migrations propagate.
  const mcpServers = (mcpJson.mcpServers ?? {}) as Record<string, unknown>
  const existingMcp = mcpServers["lore"] as Record<string, unknown> | undefined
  const portableMcpJsPath = toPortablePath(mcpJsPath)
  const portablePkgRoot = toPortablePath(pkgRoot)
  const expectedMcpEntry = buildMcpEntry(portableMcpJsPath, portablePkgRoot)
  const mcpStatus: HookStatus = !existingMcp
    ? "missing"
    : deepEqual(existingMcp, expectedMcpEntry)
      ? "current"
      : "stale"

  const statusLabel = (s: HookStatus): string =>
    s === "current" ? "already installed" : s === "stale" ? "update available" : "not installed"

  console.log("Components:")
  console.log(`  MCP server:    ${statusLabel(mcpStatus)}`)
  console.log(`  Autosave hook:     ${statusLabel(autosaveStatus)}`)
  console.log(`  Wakeup hook:       ${statusLabel(wakeupStatus)}`)
  console.log(`  Session-end hook:  ${statusLabel(sessionEndStatus)}`)

  if (hasLegacyAutosave) console.log("  Legacy hook:   PostToolUse/Stop → will migrate")
  if (hasLegacyWakeup) console.log("  Legacy hook:   PreToolUse/Task → will migrate")
  if (hasLegacySessionEnd) console.log("  Legacy hook:   SessionEnd → will remove")
  if (hasLegacyPreCompact) console.log("  Legacy hook:   PreCompact → will remove")
  if (hasLegacyMcp) console.log("  Legacy MCP:    settings.json → will migrate to .mcp.json")

  const allCurrent =
    autosaveStatus === "current" &&
    wakeupStatus === "current" &&
    sessionEndStatus === "current" &&
    mcpStatus === "current" &&
    !hasLegacyAutosave &&
    !hasLegacyWakeup &&
    !hasLegacySessionEnd &&
    !hasLegacyPreCompact &&
    !hasLegacyMcp

  if (allCurrent) {
    console.log()
    console.log("Everything is already installed.")
    return
  }

  console.log()

  // --- Phase 4: Confirm and write ---

  const rl = skipPrompts ? null : createInterface({ input: process.stdin, output: process.stdout })

  try {
    const proceed = await confirm(rl, "Install Lore integration for this project?")
    if (!proceed) {
      console.log("Cancelled.")
      return
    }

    const merged: Record<string, unknown> = { ...settings }

    // Merge hooks
    const mergedHooks: Record<string, unknown> = {
      ...((settings.hooks as Record<string, unknown>) ?? {}),
    }

    if (autosaveStatus !== "current") {
      mergedHooks["Stop"] = mergeHookEntries(
        hooks["Stop"],
        "autosave.sh",
        autosavePath,
        { matcher: "", timeout: 10000 }
      )
    }

    if (wakeupStatus !== "current") {
      mergedHooks["UserPromptSubmit"] = mergeHookEntries(
        hooks["UserPromptSubmit"],
        "wakeup.sh",
        wakeupPath,
        { matcher: "", timeout: 10000, runOnce: true }
      )
    }

    // Clean up legacy registrations from old broken config
    if (hasLegacyAutosave) {
      mergedHooks["PostToolUse"] = removeScriptEntries(hooks["PostToolUse"], "autosave.sh")
      if (!mergedHooks["PostToolUse"]) delete mergedHooks["PostToolUse"]
    }
    if (hasLegacyWakeup) {
      mergedHooks["PreToolUse"] = removeScriptEntries(hooks["PreToolUse"], "wakeup.sh")
      if (!mergedHooks["PreToolUse"]) delete mergedHooks["PreToolUse"]
    }
    if (hasLegacySessionEnd) {
      // Remove legacy autosave.sh from SessionEnd — distinct from session-end.sh
      mergedHooks["SessionEnd"] = removeScriptEntries(hooks["SessionEnd"], "autosave.sh")
      if (!mergedHooks["SessionEnd"]) delete mergedHooks["SessionEnd"]
    }
    // Register session-end.sh after legacy cleanup so the base array is clean
    if (sessionEndStatus !== "current") {
      mergedHooks["SessionEnd"] = mergeHookEntries(
        mergedHooks["SessionEnd"] as HookEntry[] | undefined,
        "session-end.sh",
        sessionEndPath,
        { matcher: "" }
      )
    }
    if (hasLegacyPreCompact) {
      mergedHooks["PreCompact"] = removeScriptEntries(hooks["PreCompact"], "autosave.sh")
      if (!mergedHooks["PreCompact"]) delete mergedHooks["PreCompact"]
    }

    merged.hooks = mergedHooks

    // Remove stale MCP config from settings.json (legacy location)
    if (hasLegacyMcp) {
      const stale = { ...((settings.mcpServers as Record<string, unknown>) ?? {}) }
      delete stale["lore"]
      if (Object.keys(stale).length > 0) {
        merged.mcpServers = stale
      } else {
        delete merged.mcpServers
      }
    }

    const displayPath = settingsPath.replace(homedir(), "~")
    console.log()
    console.log(`Writing: ${displayPath}`)
    await writeJsonFile(settingsPath, merged)

    // Write MCP server to .mcp.json (project scope — where Claude Code reads it).
    // .mcp.json is typically committed to the consumer repo and shared across
    // machines, so prefer `${HOME}/…` over absolute paths whenever the package
    // lives under the current user's home directory.
    if (mcpStatus !== "current") {
      const mergedMcpJson: Record<string, unknown> = { ...mcpJson }
      mergedMcpJson.mcpServers = {
        ...((mcpJson.mcpServers as Record<string, unknown>) ?? {}),
        lore: expectedMcpEntry,
      }

      const mcpJsonDisplay = mcpJsonPath.replace(homedir(), "~")
      console.log(`Writing: ${mcpJsonDisplay}`)
      await writeJsonFile(mcpJsonPath, mergedMcpJson)

      if (!portableMcpJsPath.startsWith("${HOME}")) {
        console.warn()
        console.warn("  Warning: lore is installed outside your home directory")
        console.warn(`    (${pkgRoot}).`)
        console.warn("  The generated .mcp.json uses an absolute path and is not")
        console.warn("  portable across machines — avoid committing it, or reinstall")
        console.warn("  lore under ~/.lore so the path can use ${HOME}.")
      }
    }

    console.log()
    if (mcpStatus !== "current") console.log("  MCP server:        installed (.mcp.json)")
    if (autosaveStatus !== "current") console.log("  Autosave hook:     installed")
    if (wakeupStatus !== "current") console.log("  Wakeup hook:       installed")
    if (sessionEndStatus !== "current") console.log("  Session-end hook:  installed")
    if (hasLegacyMcp) console.log("  Legacy MCP:        removed from settings.json")

    console.log()
    console.log("Restart Claude Code for changes to take effect.")
  } finally {
    rl?.close()
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const installCommand = new Command("install")
  .description("Install Claude Code hooks and MCP server for the current project")
  .option("--project <path>", "project directory (default: cwd)")
  .option("-y, --yes", "skip confirmation prompts")
  .action(async (opts: { project?: string; yes?: boolean }) => {
    try {
      await runInstall(opts)
    } catch (err) {
      console.error("Install failed:", err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })
