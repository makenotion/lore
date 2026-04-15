import { Command } from "commander"
import { readFile, writeFile, mkdir, access, chmod } from "node:fs/promises"
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
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8")
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
  const mcpJsPath = join(pkgRoot, "dist", "mcp.js")

  console.log()
  console.log("Lore — Claude Code Integration")
  console.log("─".repeat(40))
  console.log(`Project: ${projectDir}`)
  console.log()

  // --- Phase 1: Verify built artifacts exist ---

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
    for (const m of missing) console.error(m)
    console.error()
    console.error("Run 'npm run build' first.")
    process.exit(1)
  }

  // Ensure hook scripts are executable
  await Promise.all([chmod(autosavePath, 0o755), chmod(wakeupPath, 0o755)])

  // --- Phase 2: Check prerequisites ---

  console.log("Checking prerequisites...")

  let token: string | null = null
  const envToken = process.env["LORE_NOTION_TOKEN"]
  if (envToken) {
    token = envToken
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

  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>
  const mcpServers = (settings.mcpServers ?? {}) as Record<string, unknown>

  // Autosave registers under Stop and PreCompact.
  // Check Stop as the primary indicator.
  const autosaveStatus = detectHook(hooks["Stop"], "autosave.sh", autosavePath)
  const wakeupStatus = detectHook(hooks["UserPromptSubmit"], "wakeup.sh", wakeupPath)

  // Detect legacy (broken) registrations that need cleanup
  const hasLegacyAutosave = detectHook(hooks["PostToolUse"], "autosave.sh", "") !== "missing"
  const hasLegacyWakeup = detectHook(hooks["PreToolUse"], "wakeup.sh", "") !== "missing"
  const hasLegacySessionEnd = detectHook(hooks["SessionEnd"], "autosave.sh", "") !== "missing"

  const existingMcp = mcpServers["lore"] as { args?: string[] } | undefined
  const mcpStatus: HookStatus = !existingMcp
    ? "missing"
    : existingMcp.args?.[0] === mcpJsPath
      ? "current"
      : "stale"

  const statusLabel = (s: HookStatus): string =>
    s === "current" ? "already installed" : s === "stale" ? "update available" : "not installed"

  console.log("Components:")
  console.log(`  MCP server:    ${statusLabel(mcpStatus)}`)
  console.log(`  Autosave hook: ${statusLabel(autosaveStatus)}`)
  console.log(`  Wakeup hook:   ${statusLabel(wakeupStatus)}`)

  if (hasLegacyAutosave) console.log("  Legacy hook:   PostToolUse/Stop → will migrate")
  if (hasLegacyWakeup) console.log("  Legacy hook:   PreToolUse/Task → will migrate")
  if (hasLegacySessionEnd) console.log("  Legacy hook:   SessionEnd → will remove")

  const allCurrent =
    autosaveStatus === "current" &&
    wakeupStatus === "current" &&
    mcpStatus === "current" &&
    !hasLegacyAutosave &&
    !hasLegacyWakeup &&
    !hasLegacySessionEnd

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
      const autosaveConfig = { matcher: "", timeout: 10000 }
      for (const event of ["Stop", "PreCompact"]) {
        mergedHooks[event] = mergeHookEntries(
          hooks[event],
          "autosave.sh",
          autosavePath,
          autosaveConfig
        )
      }
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
      mergedHooks["SessionEnd"] = removeScriptEntries(hooks["SessionEnd"], "autosave.sh")
      if (!mergedHooks["SessionEnd"]) delete mergedHooks["SessionEnd"]
    }

    merged.hooks = mergedHooks

    // Merge MCP server
    if (mcpStatus !== "current") {
      const mcpEnv: Record<string, string> = {}
      if (token) mcpEnv["LORE_NOTION_TOKEN"] = token

      merged.mcpServers = {
        ...((settings.mcpServers as Record<string, unknown>) ?? {}),
        lore: {
          command: "node",
          args: [mcpJsPath],
          cwd: pkgRoot,
          ...(Object.keys(mcpEnv).length > 0 ? { env: mcpEnv } : {}),
        },
      }
    }

    const displayPath = settingsPath.replace(homedir(), "~")
    console.log()
    console.log(`Writing: ${displayPath}`)
    await writeJsonFile(settingsPath, merged)

    console.log()
    if (mcpStatus !== "current") console.log("  MCP server:    installed")
    if (autosaveStatus !== "current") console.log("  Autosave hook: installed")
    if (wakeupStatus !== "current") console.log("  Wakeup hook:   installed")

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
