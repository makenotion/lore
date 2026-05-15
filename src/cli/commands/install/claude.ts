import { join } from "node:path"
import { homedir } from "node:os"
import { createInterface } from "node:readline/promises"
import type { AuthSource } from "../../../config.js"
import { resolveClaudeSettingsPath } from "../claude-paths.js"
import type {
  BinDispatchShape,
  HookStatus,
  InstallContext,
  McpLauncherClassificationOptions,
} from "./types.js"
import { buildMcpEnv, installerMcpPaths, mergeMcpEnvForClaudeOrCursor } from "./env.js"
import {
  confirm,
  deepEqual,
  displayHomePath,
  isEffectivelyCurrent,
  postWriteLabel,
  readJsonSafe,
  statusLabel,
  toPortablePath,
  writeJsonFile,
} from "./utils.js"
import {
  buildClaudeHookCommand,
  detectClaudeHook,
  removeClaudeScriptEntries,
  stripLoreOwnedSessionEndEntries,
  upsertClaudeHookCommand,
  type ClaudeHookEntry,
} from "./hooks.js"
import { ensureHookPrerequisites, wakeupStatusSuffix } from "./preflight.js"
import {
  printBackgroundAgentSummary,
  printHookDisclosure,
  resolveBackgroundAgentForInstall,
} from "./background.js"

interface ClaudeMcpEntry {
  command: string
  args: string[]
  /**
   * Absolute (or `${HOME}`-prefixed) directory the legacy launcher
   * cd's into before invoking the absolute-path MCP entry. Bin-
   * dispatch entries omit this field — the host assistant's launch
   * cwd (typically the project root) is correct for .lore.yaml
   * discovery, and pinning a specific cwd would defeat the
   * portability the bin-dispatch shape provides.
   */
  cwd?: string
  env: Record<string, string>
}

/**
 * Build the bin-dispatch .mcp.json entry for Lore. Emits
 * `{ command: "lore", args: ["mcp"], env: ... }` for `shape: "bare"`
 * (default), or `{ command: "yarn", args: ["lore", "mcp"], env: ... }`
 * for `shape: "yarn"` (Yarn Berry PnP consumers — see
 * `BinDispatchShape`). The env block carries:
 *   - Conditional `${NOTION_API_TOKEN}` /
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
  notionBaseUrlLiteral?: string
): ClaudeMcpEntry {
  const build = buildMcpEnv(configRoot, envSource, {
    // PnP entries are committed to the workspace root and shared
    // across developers; an absolute `LORE_CONFIG_ROOT` would leak
    // one developer's machine path into everyone else's checkout.
    // The `yarn run -T` launch always lands at workspace root, so
    // the spawned MCP server's `findConfigFile(cwd)` walk resolves
    // .lore.yaml without help.
    omitConfigRoot: shape === "yarn",
    authSource,
    notionBaseUrlLiteral,
  })
  const env = mergeMcpEnvForClaudeOrCursor(build)
  if (shape === "yarn") {
    return { command: "yarn", args: ["run", "-T", "lore", "mcp"], env }
  }
  return { command: "lore", args: ["mcp"], env }
}

/**
 * Legacy absolute-path .mcp.json shape used to detect and upgrade
 * `~/.lore` consumers.
 *
 * The 0.10.0 ntn-first env shape applies on this path too — the MCP
 * server's startup `resolveAuth` consults `LORE_CONFIG_ROOT` to find
 * .lore.yaml regardless of which launch shape the host uses.
 */
export function buildLegacyClaudeMcpEntry(
  mcpJsPath: string,
  cwd: string,
  configRoot: string = process.cwd(),
  envSource: NodeJS.ProcessEnv = process.env,
  authSource?: AuthSource,
  notionBaseUrlLiteral?: string
): ClaudeMcpEntry {
  const build = buildMcpEnv(configRoot, envSource, {
    authSource,
    notionBaseUrlLiteral,
  })
  return {
    command: "node",
    args: [mcpJsPath],
    cwd,
    env: mergeMcpEnvForClaudeOrCursor(build),
  }
}

export function classifyClaudeMcpLauncher(
  existingMcp: Record<string, unknown> | undefined,
  options: McpLauncherClassificationOptions
): HookStatus {
  if (!existingMcp) return "missing"
  const { portableMcpJsPath, portablePkgRoot } = installerMcpPaths()
  const binShape: BinDispatchShape = options.yarnPnp ? "yarn" : "bare"
  const binMcpEntry = buildClaudeMcpEntry(
    binShape,
    options.configRoot,
    options.envSource,
    options.authSource,
    options.notionBaseUrlLiteral
  )
  const legacyMcpEntry = buildLegacyClaudeMcpEntry(
    portableMcpJsPath,
    portablePkgRoot,
    options.configRoot,
    options.envSource,
    options.authSource,
    options.notionBaseUrlLiteral
  )
  if (deepEqual(existingMcp, binMcpEntry)) return "current"
  if (deepEqual(existingMcp, legacyMcpEntry)) return "legacy-current"
  return "stale"
}

export async function runClaudeInstall(
  context: InstallContext,
  rl: ReturnType<typeof createInterface> | null
): Promise<void> {
  await ensureHookPrerequisites(context)
  const settingsPath = resolveClaudeSettingsPath(context.projectDir, homedir())
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
    binAutosaveCommand
  )
  const wakeupStatus = detectClaudeHook(
    hooks["UserPromptSubmit"],
    "wakeup.sh",
    context.wakeupPath,
    binWakeupCommand
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
    (settings.mcpServers as Record<string, unknown> | undefined)?.["lore"]
  )

  const mcpServers = (mcpJson.mcpServers ?? {}) as Record<string, unknown>
  const existingMcp = mcpServers["lore"] as Record<string, unknown> | undefined
  const portableMcpJsPath = toPortablePath(context.mcpJsPath)
  const portablePkgRoot = toPortablePath(context.pkgRoot)
  const binMcpEntry = buildClaudeMcpEntry(
    binShape,
    configRoot,
    process.env,
    context.authSource,
    context.notionBaseUrlLiteral
  )
  const legacyMcpEntry = buildLegacyClaudeMcpEntry(
    portableMcpJsPath,
    portablePkgRoot,
    configRoot,
    process.env,
    context.authSource,
    context.notionBaseUrlLiteral
  )
  // Desired entry for the WRITE path (driven by legacy absolute-path mode and
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
    `  Wakeup hook:       ${statusLabel(wakeupStatus, context.legacyPaths)}${wakeupStatusSuffix(context.wakeUpConfig)}`
  )
  if (hasSessionEndShim) console.log("  Session-end hook:  will remove")
  if (hasLegacyAutosave)
    console.log("  Legacy hook:       PostToolUse/Stop -> will migrate")
  if (hasLegacyWakeup) console.log("  Legacy hook:       PreToolUse/Task -> will migrate")
  if (hasLegacySessionEndAutosave)
    console.log("  Legacy hook:       SessionEnd/autosave.sh -> will remove")
  if (hasLegacyPreCompact) console.log("  Legacy hook:       PreCompact -> will remove")
  if (hasLegacyMcp)
    console.log("  Legacy MCP:        settings.json -> will migrate to .mcp.json")
  // Surface background-agent install-time health on Claude Code
  // installs too. An operator who set `LORE_BACKGROUND_COMMAND` or
  // overrode `hooks.backgroundAgent` on a Claude Code project is just
  // as exposed as a `--client codex` operator — the configuration
  // applies regardless of which host registered the hook.
  printBackgroundAgentSummary(await resolveBackgroundAgentForInstall(context))
  // Surface hook-side-effects disclosure at install time, not just
  // at `lore init`. Operators who clone a teammate's repo or upgrade
  // an existing install pass through here, and the hooks start
  // firing the moment this install completes.
  printHookDisclosure()

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
  const proceed = await confirm(
    rl,
    "Install Lore Claude Code integration for this project?"
  )
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
  // downgrading bin-dispatch → legacy under legacy absolute-path mode, we strip
  // any existing bin-dispatch entry (no `.sh` suffix), then write the
  // legacy path. The shared helper below covers both directions.
  const desiredAutosaveCommand = context.legacyPaths
    ? context.autosavePath
    : binAutosaveCommand
  const desiredWakeupCommand = context.legacyPaths ? context.wakeupPath : binWakeupCommand

  if (!isEffectivelyCurrent(autosaveStatus, context.legacyPaths)) {
    mergedHooks["Stop"] = upsertClaudeHookCommand(
      hooks["Stop"],
      "autosave.sh",
      desiredAutosaveCommand,
      // Claude settings use hook timeouts in milliseconds.
      { matcher: "", timeout: 10000 }
    )
  }

  if (!isEffectivelyCurrent(wakeupStatus, context.legacyPaths)) {
    mergedHooks["UserPromptSubmit"] = upsertClaudeHookCommand(
      hooks["UserPromptSubmit"],
      "wakeup.sh",
      desiredWakeupCommand,
      // Claude settings use hook timeouts in milliseconds.
      { matcher: "", timeout: 10000, runOnce: true }
    )
  }

  if (hasLegacyAutosave) {
    mergedHooks["PostToolUse"] = removeClaudeScriptEntries(
      hooks["PostToolUse"],
      "autosave.sh"
    )
    if (!mergedHooks["PostToolUse"]) delete mergedHooks["PostToolUse"]
  }
  if (hasLegacyWakeup) {
    mergedHooks["PreToolUse"] = removeClaudeScriptEntries(
      hooks["PreToolUse"],
      "wakeup.sh"
    )
    if (!mergedHooks["PreToolUse"]) delete mergedHooks["PreToolUse"]
  }
  // Lore does not register a SessionEnd hook. The pre-computed cleanup
  // result strips Lore-owned entries (both the `session-end.sh` shim
  // path and the older `autosave.sh`-on-SessionEnd legacy path) while
  // preserving unrelated user hooks on the same event.
  if (hasSessionEndShim || hasLegacySessionEndAutosave) {
    if (sessionEndCleanup.result) {
      mergedHooks["SessionEnd"] = sessionEndCleanup.result
    } else {
      delete mergedHooks["SessionEnd"]
    }
  }
  if (hasLegacyPreCompact) {
    mergedHooks["PreCompact"] = removeClaudeScriptEntries(
      hooks["PreCompact"],
      "autosave.sh"
    )
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
      `  MCP server:        ${postWriteLabel(mcpStatus, context.legacyPaths)} (.mcp.json)`
    )
  }
  if (!isEffectivelyCurrent(autosaveStatus, context.legacyPaths)) {
    console.log(
      `  Autosave hook:     ${postWriteLabel(autosaveStatus, context.legacyPaths)}`
    )
  }
  if (!isEffectivelyCurrent(wakeupStatus, context.legacyPaths)) {
    console.log(
      `  Wakeup hook:       ${postWriteLabel(wakeupStatus, context.legacyPaths)}`
    )
  }
  if (hasSessionEndShim || hasLegacySessionEndAutosave)
    console.log("  Session-end hook:  removed (autosave covers Stop only)")
  if (hasLegacyMcp) console.log("  Legacy MCP:        removed from settings.json")
  console.log("  Restart Claude Code for changes to take effect.")
}
