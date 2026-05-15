import { join } from "node:path"
import { createInterface } from "node:readline/promises"
import type { AuthSource } from "../../../config.js"
import { RUNTIME_FORWARDED_KEYS } from "../../../auth/forwarded-env.js"
import type {
  BinDispatchShape,
  HookStatus,
  InstallContext,
  McpEnvBuild,
  McpLauncherClassificationOptions,
} from "./types.js"
import { buildMcpEnv, installerMcpPaths } from "./env.js"
import {
  confirm,
  deepEqual,
  displayHomePath,
  isEffectivelyCurrent,
  postWriteLabel,
  readJsonSafe,
  readTextSafe,
  statusLabel,
  toPortablePath,
  writeJsonFile,
  writeTextFile,
} from "./utils.js"
import {
  buildCodexHookCommand,
  buildLegacyCodexHookCommand,
  detectCodexHook,
  mergeCodexHookEntries,
  stripCodexBinDispatchHook,
  stripCodexScriptFromAllEvents,
  CODEX_HOOKS_FEATURE_KEY,
  type CodexHookEntry,
} from "./hooks.js"
import {
  appendTomlBlock,
  assertTomlSupportsLoreRewrite,
  extractTomlKeyValue,
  extractTomlTableGroup,
  removeTomlTableGroup,
  upsertTomlTableKey,
} from "./toml.js"
import { ensureHookPrerequisites, wakeupStatusSuffix } from "./preflight.js"
import {
  printBackgroundAgentSummary,
  printHookDisclosure,
  resolveBackgroundAgentForInstall,
} from "./background.js"

function formatTomlArray(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`
}

/**
 * Build the bin-dispatch `[mcp_servers.lore]` block for
 * .codex/config.toml. Codex's MCP launcher resolves `command` against
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
 *    starting with `${HOME}/`, expands `${HOME}` to the runtime
 *    operator's home, then runs node against the expanded absolute path.
 *    Wrapping the entire path in single quotes turns `${HOME}` into a
 *    literal four-character string and `node` can't find the file.
 * 2. **Other shell metacharacters MUST NOT expand.** Same hazard
 *    `shellQuoteSingle` already handles for the static env prefix —
 *    a path containing `$build_dir` or `` `whoami` `` must reach
 *    `node` as a literal, not be re-interpreted by bash.
 *
 * Resolution: split on the `${HOME}` prefix. The prefix gets emitted
 * **double-quoted** (so bash expands it) and the suffix gets emitted
 * **single-quoted** (so bash treats every other metachar as literal).
 * Bash's adjacent-string concatenation joins the two halves into a
 * single argument, so the resulting expansion is one argv entry
 * pointing at the expanded absolute path under the operator's home.
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
 * shell command line instead. Values are quoted with the same
 * home-aware helper used for legacy launch paths: normal absolute
 * values remain POSIX single-quoted so `$`, backticks, or `\` do
 * NOT trigger shell expansion, while committed `${HOME}/...` values
 * keep the `${HOME}` prefix expandable for portability.
 */
function codexLaunchCommand(staticEnv: Record<string, string>, command: string): string {
  const prefix = Object.entries(staticEnv)
    .map(([key, value]) => `${key}=${shellQuotePortablePath(value)}`)
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
  notionBaseUrlLiteral?: string
): string {
  const build = buildMcpEnv(configRoot, envSource, {
    omitConfigRoot: shape === "yarn",
    authSource,
    notionBaseUrlLiteral,
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
  notionBaseUrlLiteral?: string
): string {
  const portableMcpJsPath = toPortablePath(mcpJsPath)
  const build = buildMcpEnv(configRoot, envSource, {
    authSource,
    notionBaseUrlLiteral,
  })
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
    `node ${shellQuotePortablePath(portableMcpJsPath)}`
  )

  return [
    "[mcp_servers.lore]",
    'command = "bash"',
    `args = ["-lc", ${JSON.stringify(launchCommand)}]`,
    `env_vars = ${formatTomlArray(runtimeForwardedKeys(build))}`,
  ].join("\n")
}

export function classifyCodexMcpLauncher(
  existingMcpSection: string | null,
  options: McpLauncherClassificationOptions
): HookStatus {
  if (!existingMcpSection) return "missing"
  const { portableMcpJsPath } = installerMcpPaths()
  const binShape: BinDispatchShape = options.yarnPnp ? "yarn" : "bare"
  const binMcpSection = buildCodexMcpSection(
    binShape,
    options.configRoot,
    options.envSource,
    options.authSource,
    options.notionBaseUrlLiteral
  )
  const legacyMcpSection = buildLegacyCodexMcpSection(
    portableMcpJsPath,
    options.configRoot,
    options.envSource,
    options.authSource,
    options.notionBaseUrlLiteral
  )
  const normalized = existingMcpSection.trim()
  if (normalized === binMcpSection.trim()) return "current"
  if (normalized === legacyMcpSection.trim()) return "legacy-current"
  return "stale"
}

export async function runCodexInstall(
  context: InstallContext,
  rl: ReturnType<typeof createInterface> | null
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
    context.notionBaseUrlLiteral
  )
  const legacyMcpSection = buildLegacyCodexMcpSection(
    context.mcpJsPath,
    context.configRoot,
    process.env,
    context.authSource,
    context.notionBaseUrlLiteral
  )
  const desiredMcpSection = context.legacyPaths ? legacyMcpSection : binMcpSection
  const existingMcpSection = extractTomlTableGroup(codexConfig, "mcp_servers.lore")
  const hooksFeatureValue = extractTomlKeyValue(
    codexConfig,
    "features",
    CODEX_HOOKS_FEATURE_KEY
  )
  const binWakeupCommand = buildCodexHookCommand("wakeup", binShape)
  const binAutosaveCommand = buildCodexHookCommand("autosave", binShape)
  const legacyWakeupCommand = buildLegacyCodexHookCommand(context.wakeupPath)
  const legacyAutosaveCommand = buildLegacyCodexHookCommand(context.autosavePath)
  const desiredWakeupCommand = context.legacyPaths
    ? legacyWakeupCommand
    : binWakeupCommand
  const desiredAutosaveCommand = context.legacyPaths
    ? legacyAutosaveCommand
    : binAutosaveCommand

  const mcpStatus: HookStatus = !existingMcpSection
    ? "missing"
    : existingMcpSection.trim() === binMcpSection.trim()
      ? "current"
      : existingMcpSection.trim() === legacyMcpSection.trim()
        ? "legacy-current"
        : "stale"
  // The Codex hooks feature has no legacy/bin-dispatch axis — it's a
  // single boolean (`hooks = true`). Re-using HookStatus here
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
    binWakeupCommand
  )
  const autosaveStatus = detectCodexHook(
    codexHooks["Stop"],
    "autosave.sh",
    legacyAutosaveCommand,
    binAutosaveCommand
  )
  const hasLegacySessionStartWakeup =
    detectCodexHook(
      codexHooks["SessionStart"],
      "wakeup.sh",
      legacyWakeupCommand,
      binWakeupCommand
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
    }`
  )
  console.log(
    `  Wakeup hook:       ${statusLabel(wakeupStatus, context.legacyPaths)}${wakeupStatusSuffix(context.wakeUpConfig)}`
  )
  console.log(`  Autosave hook:     ${statusLabel(autosaveStatus, context.legacyPaths)}`)
  if (hasLegacySessionStartWakeup) {
    console.log("  Legacy hook:       SessionStart/wakeup -> will migrate")
  }

  // Stop hooks shell out to a background agent CLI for autosave /
  // digest synthesis. Default is `claude -p` for Claude Code
  // installs; Codex installs prefix every hook command with
  // `LORE_AGENT_NAME=Codex` so the runtime resolver derives `command:
  // codex` automatically (no per-project setup required). Pass `"Codex"`
  // explicitly to the resolver here so the install-time status block
  // matches what hook-fire time will produce, even when the operator's
  // install-time shell doesn't have `LORE_AGENT_NAME` exported.
  printBackgroundAgentSummary(
    await resolveBackgroundAgentForInstall(context, process.env, "Codex")
  )
  // Parity with the Claude install path — surface the
  // hook-side-effects disclosure on Codex too. The same Stop /
  // UserPromptSubmit hooks fire under Codex once
  // `features.hooks` is set and the project is trusted.
  printHookDisclosure()

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
  nextConfig = upsertTomlTableKey(nextConfig, "features", CODEX_HOOKS_FEATURE_KEY, "true")
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
    }
  )
  nextHookEvents["Stop"] = mergeCodexHookEntries(
    nextHookEvents["Stop"],
    desiredAutosaveCommand,
    {
      // Codex hook timeouts are expressed in seconds.
      timeout: 30,
      statusMessage: "Saving Lore context",
    }
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
      `  MCP server:        ${postWriteLabel(mcpStatus, context.legacyPaths)} (.codex/config.toml)`
    )
  }
  if (hooksFeatureStatus !== "current") console.log("  Hooks feature:     enabled")
  if (!isEffectivelyCurrent(wakeupStatus, context.legacyPaths)) {
    console.log(
      `  Wakeup hook:       ${postWriteLabel(wakeupStatus, context.legacyPaths)}`
    )
  }
  if (!isEffectivelyCurrent(autosaveStatus, context.legacyPaths)) {
    console.log(
      `  Autosave hook:     ${postWriteLabel(autosaveStatus, context.legacyPaths)}`
    )
  }
  console.log("  Start a new Codex session after trusting this project.")
  console.log("  Codex only loads project-scoped .codex/* files for trusted projects.")
}
