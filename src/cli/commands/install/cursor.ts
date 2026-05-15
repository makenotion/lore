import { join } from "node:path"
import { homedir } from "node:os"
import { createInterface } from "node:readline/promises"
import type { AuthSource } from "../../../config.js"
import type {
  BinDispatchShape,
  CursorMcpLauncherClassificationOptions,
  HookStatus,
  InstallClient,
  InstallContext,
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
 * project-scoped default writes the entry into the project's
 * .cursor/mcp.json which is shared across every engineer
 * with a checkout, so the PnP shape omits machine-specific anchors
 * (`cwd`, `LORE_CONFIG_ROOT`) and trusts Cursor's launch cwd to land
 * inside the PnP project. The global shape writes to
 * ~/.cursor/mcp.json which is per-machine — Cursor launches the
 * server from its own process cwd at fire time, which is NOT
 * guaranteed to be inside any PnP project. Under PnP + global, the
 * entry has to anchor itself with `cwd` (so `yarn run -T` finds the
 * right `.pnp.cjs` upward) and keep `LORE_CONFIG_ROOT` (so the
 * spawned MCP child resolves the right .lore.yaml); without those
 * anchors, the global launcher fires from Cursor's process cwd and
 * neither yarn nor .lore.yaml discovery succeeds.
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
 *   the .lore.yaml directory. `findConfigFile` walks upward, and
 *   .lore.yaml can legitimately live ABOVE the PnP workspace —
 *   for example, a monorepo umbrella containing multiple PnP
 *   workspaces with one shared .lore.yaml at the umbrella root.
 *   In that layout, deriving `cwd` from `configRoot` would anchor
 *   the launcher to a directory OUTSIDE the PnP workspace, and
 *   `yarn run -T` would never walk into `.pnp.cjs` territory.
 *
 * `launchCwd` defaults to `configRoot` when omitted — the safe
 * default for the typical case where .lore.yaml lives inside the
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
  /**
   * Pass-through to `buildMcpEnv`'s `notionBaseUrlLiteral` option.
   * See `BuildMcpEnvOptions.notionBaseUrlLiteral` for the rationale —
   * `lore install --dev` populates this so the spawned MCP child
   * targets the dev base URL via a literal env entry rather than a
   * `${VAR}` placeholder that would silently degrade to prod on
   * operator shells without the matching signal.
   */
  notionBaseUrlLiteral?: string
}

export function buildCursorMcpEntry(
  shape: BinDispatchShape = "bare",
  configRoot: string = process.cwd(),
  envSource: NodeJS.ProcessEnv = process.env,
  options: BuildCursorMcpEntryOptions = {}
): CursorMcpEntry {
  const useGlobalScope = options.useGlobalScope ?? false
  // PnP omission rationale only applies to committed config. Under
  // global scope the entry is machine-local; an absolute
  // `LORE_CONFIG_ROOT` is the right anchor, not a portability leak.
  const omitConfigRoot = shape === "yarn" && !useGlobalScope
  const build = buildMcpEnv(configRoot, envSource, {
    omitConfigRoot,
    authSource: options.authSource,
    notionBaseUrlLiteral: options.notionBaseUrlLiteral,
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
      // can differ from `configRoot` when .lore.yaml lives
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
  notionBaseUrlLiteral?: string
): CursorMcpEntry {
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

export function classifyCursorMcpLauncher(
  existingMcp: Record<string, unknown> | undefined,
  options: CursorMcpLauncherClassificationOptions
): HookStatus {
  if (!existingMcp) return "missing"
  const { portableMcpJsPath, portablePkgRoot } = installerMcpPaths()
  const binShape: BinDispatchShape = options.yarnPnp ? "yarn" : "bare"
  const binMcpEntry = buildCursorMcpEntry(
    binShape,
    options.configRoot,
    options.envSource,
    {
      useGlobalScope: options.useGlobalScope,
      launchCwd: options.launchCwd ?? options.configRoot,
      authSource: options.authSource,
      notionBaseUrlLiteral: options.notionBaseUrlLiteral,
    }
  )
  const legacyMcpEntry = buildLegacyCursorMcpEntry(
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

/**
 * Resolve the on-disk path for Cursor's mcp.json. Cursor reads MCP servers
 * from <projectDir>/.cursor/mcp.json (project-scoped, takes precedence) and
 * ~/.cursor/mcp.json (global, fallback) — mirroring Claude Code's
 * project-vs-user split. `useGlobalScope` opts into the global file (driven
 * by `--cursor-global`).
 */
export function resolveCursorMcpPath(
  projectDir: string,
  useGlobalScope: boolean
): string {
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
  client: InstallClient
): string | null {
  if (!cursorGlobal) return null
  if (client === "cursor" || client === "all") return null
  return `Note: --cursor-global has no effect under --client ${client} (Cursor not selected); ignored.`
}

export async function runCursorInstall(
  context: InstallContext,
  rl: ReturnType<typeof createInterface> | null,
  cursorMcpPath: string,
  useGlobalScope: boolean
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
  // the PnP workspace when .lore.yaml resolves to a parent
  // (monorepo umbrella with shared lore config); using it for
  // `cwd` would anchor the launcher OUTSIDE the workspace and
  // re-introduce the failure mode this fix exists to close. See
  // `BuildCursorMcpEntryOptions` for the full rationale.
  const binMcpEntry = buildCursorMcpEntry(binShape, context.configRoot, process.env, {
    useGlobalScope,
    launchCwd: context.projectDir,
    authSource: context.authSource,
    notionBaseUrlLiteral: context.notionBaseUrlLiteral,
  })
  const legacyMcpEntry = buildLegacyCursorMcpEntry(
    portableMcpJsPath,
    portablePkgRoot,
    context.configRoot,
    process.env,
    context.authSource,
    context.notionBaseUrlLiteral
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
    `  MCP server:        ${postWriteLabel(mcpStatus, context.legacyPaths)} (${cursorMcpDisplay})`
  )
  console.log(
    "  Cursor does not currently support Stop hooks. The Stop-triggered\n" +
      "  autosave and the detached auto-digest spawn will not run when lore is\n" +
      "  invoked from Cursor. Lore tools work the same; only the background\n" +
      "  session-close persistence differs."
  )
  console.log("  Restart Cursor for changes to take effect.")
}
