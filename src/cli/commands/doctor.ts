import { Command } from "commander"
import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

import {
  findConfigFile,
  loadConfig,
  resolveAuth,
  type AuthSource,
  type ResolvedAuth,
} from "../../config.js"
import type { LoreConfig } from "../../types.js"
import { verifyVaultAccess, ntnEnvFromBaseUrl } from "../../auth/oauth.js"
import { classifyTokenPrefix } from "../../auth/token-prefix.js"
import { createClient } from "../../notion/client.js"
import { createLimitedClient } from "../../notion/rate-limit.js"
import { verifyVaultDatabases, MissingVaultDatabasesError } from "../../notion/setup.js"
import {
  formatBackgroundFailureStatus,
  loadBackgroundFailureStatus,
} from "../../hooks/background-failure-status.js"
import { encodeClaudeProjectPath, resolveClaudeSettingsPath } from "./claude-paths.js"
import {
  classifyClaudeMcpLauncher,
  classifyCodexMcpLauncher,
  classifyCursorMcpLauncher,
  detectYarnPnp,
  type HookStatus,
} from "./install.js"

type ProblemKind = "config" | "auth" | "vault" | "host-config" | "hooks"
type HookPresence = "present" | "stale" | "missing"

interface DoctorProblem {
  kind: ProblemKind
  message: string
  nextAction: string | string[]
}

interface ConfigCheck {
  cwd: string
  envRootRaw?: string
  envRoot?: string
  envRootDirectoryExists?: boolean
  envRootConfigExists?: boolean
  discovered: { path: string; root: string } | null
  effective: {
    path: string
    root: string
    source: "LORE_CONFIG_ROOT" | "discovery"
  } | null
  config: LoreConfig | null
  problem: DoctorProblem | null
}

interface HostCheck {
  lines: string[]
  problems: DoctorProblem[]
}

interface JsonMcpCheck extends HostCheck {
  hasLoreEntry: boolean
}

interface HostConfigInspection {
  configRoot: string
  envSource: NodeJS.ProcessEnv
  authSource?: AuthSource
  yarnPnp: boolean
  notionBaseUrlLiteral?: string
}

interface HostConfigRoots {
  claude: string
  codex: string
  cursor: string
}

type JsonMcpLauncher =
  | { kind: "claude"; inspect: HostConfigInspection }
  | {
      kind: "cursor"
      inspect: HostConfigInspection
      useGlobalScope: boolean
      launchCwd: string
    }

export interface DoctorDeps {
  resolveAuth: typeof resolveAuth
  createClient: typeof createClient
  createLimitedClient: typeof createLimitedClient
  verifyVaultAccess: typeof verifyVaultAccess
  verifyVaultDatabases: typeof verifyVaultDatabases
  loadBackgroundFailureStatus: typeof loadBackgroundFailureStatus
}

export interface RunDoctorOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  homeDir?: string
  emit?: boolean
  deps?: Partial<DoctorDeps>
}

export interface DoctorResult {
  exitCode: number
  lines: string[]
  problems: DoctorProblem[]
}

const CONFIG_FILENAME = ".lore.yaml"
const DEFAULT_NOTION_BASE_URL = "https://api.notion.so"

const DEFAULT_DEPS: DoctorDeps = {
  resolveAuth,
  createClient,
  createLimitedClient,
  verifyVaultAccess,
  verifyVaultDatabases,
  loadBackgroundFailureStatus,
}

export const doctorCommand = new Command("doctor")
  .description("Run read-only setup diagnostics for config, auth, vault, MCP, and hooks")
  .action(async () => {
    try {
      const result = await runDoctor()
      if (result.exitCode !== 0) {
        process.exit(result.exitCode)
        return
      }
    } catch (err) {
      console.error("Doctor failed:", formatError(err))
      process.exit(1)
      return
    }
  })

export async function runDoctor(options: RunDoctorOptions = {}): Promise<DoctorResult> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const env = options.env ?? process.env
  const deps = { ...DEFAULT_DEPS, ...(options.deps ?? {}) }
  const homeDir = options.homeDir ?? homedir()
  const lines: string[] = []
  const problems: DoctorProblem[] = []

  const configCheck = await loadConfigCheck(cwd, env)
  const configRoot = configCheck.effective?.root ?? configCheck.discovered?.root
  const inspectionRoot = configRoot ?? cwd
  lines.push("Config")
  lines.push(...formatConfigLines(configCheck))
  if (configCheck.problem) problems.push(configCheck.problem)

  let auth: ResolvedAuth | null = null
  lines.push("")
  lines.push("Auth")
  if (!configCheck.config || !configCheck.effective) {
    lines.push("  Skipped: config did not load.")
  } else {
    const authResult = await runAuthCheck(
      configCheck.config,
      configCheck.effective.root,
      env,
      deps
    )
    auth = authResult.auth
    lines.push(...authResult.lines)
    if (authResult.problem) problems.push(authResult.problem)
  }

  lines.push("")
  lines.push("Vault")
  if (!configCheck.config || !configCheck.effective || !auth) {
    lines.push("  Skipped: config and auth must resolve first.")
  } else {
    const vaultResult = await runVaultCheck(configCheck.config, auth, deps)
    lines.push(...vaultResult.lines)
    if (vaultResult.problem) problems.push(vaultResult.problem)
  }

  lines.push("")
  lines.push("MCP host config")
  const hostConfigRoots = await resolveHostConfigRoots(cwd, inspectionRoot)
  const hostCheck = await inspectHostConfig(hostConfigRoots, homeDir, configRoot, {
    configRoot: configRoot ?? inspectionRoot,
    envSource: env,
    authSource: auth?.source,
    yarnPnp: await detectYarnPnp(cwd),
  })
  lines.push(...hostCheck.lines)
  problems.push(...hostCheck.problems)

  lines.push("")
  lines.push("Hooks")
  const hookCheck = await inspectHooks(hostConfigRoots, homeDir, configRoot, deps)
  lines.push(...hookCheck.lines)
  problems.push(...hookCheck.problems)

  lines.push("")
  lines.push("Next action:")
  lines.push(...formatNextAction(selectNextAction(problems)))

  if (options.emit !== false) {
    for (const line of lines) console.log(line)
  }

  return {
    exitCode: problems.length > 0 ? 1 : 0,
    lines,
    problems,
  }
}

async function loadConfigCheck(
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<ConfigCheck> {
  const envRootRaw = env["LORE_CONFIG_ROOT"]
  const envRoot = envRootRaw?.trim() ? resolve(envRootRaw.trim()) : undefined
  const discovered = await findConfigFile(cwd)
  const base: Omit<ConfigCheck, "effective" | "config" | "problem"> = {
    cwd,
    ...(envRootRaw !== undefined ? { envRootRaw } : {}),
    ...(envRoot !== undefined ? { envRoot } : {}),
    discovered,
  }

  if (envRoot) {
    const envRootDirectoryExists = await directoryExists(envRoot)
    const envConfigPath = join(envRoot, CONFIG_FILENAME)
    const envRootConfigExists = await fileExists(envConfigPath)
    const nextBase = { ...base, envRootDirectoryExists, envRootConfigExists }

    if (!envRootDirectoryExists || !envRootConfigExists) {
      return {
        ...nextBase,
        effective: null,
        config: null,
        problem: {
          kind: "config",
          message:
            "LORE_CONFIG_ROOT does not point at a directory containing .lore.yaml.",
          nextAction: ["unset LORE_CONFIG_ROOT", "lore doctor"],
        },
      }
    }

    return loadConfigFromPath(nextBase, {
      path: envConfigPath,
      root: envRoot,
      source: "LORE_CONFIG_ROOT",
    })
  }

  if (!discovered) {
    return {
      ...base,
      effective: null,
      config: null,
      problem: {
        kind: "config",
        message: "No .lore.yaml was found from the current directory.",
        nextAction: "lore init",
      },
    }
  }

  return loadConfigFromPath(base, { ...discovered, source: "discovery" })
}

async function loadConfigFromPath(
  base: Omit<ConfigCheck, "effective" | "config" | "problem">,
  effective: ConfigCheck["effective"]
): Promise<ConfigCheck> {
  try {
    const config = await loadConfig(effective!.path)
    return { ...base, effective, config, problem: null }
  } catch (err) {
    return {
      ...base,
      effective,
      config: null,
      problem: {
        kind: "config",
        message: `Config failed to load: ${formatError(err)}`,
        nextAction: [`Fix ${effective!.path}`, "lore doctor"],
      },
    }
  }
}

function formatConfigLines(check: ConfigCheck): string[] {
  const lines = [`  Current working directory: ${check.cwd}`]
  if (check.envRootRaw === undefined || check.envRootRaw.trim() === "") {
    lines.push("  LORE_CONFIG_ROOT: not set")
  } else {
    lines.push(`  LORE_CONFIG_ROOT: ${check.envRoot}`)
    lines.push(`    directory: ${check.envRootDirectoryExists ? "present" : "missing"}`)
    lines.push(`    .lore.yaml: ${check.envRootConfigExists ? "present" : "missing"}`)
  }

  if (check.discovered) {
    lines.push(`  Normal discovery: ${check.discovered.path}`)
  } else {
    lines.push("  Normal discovery: no .lore.yaml found from cwd")
  }

  if (check.effective) {
    lines.push(`  Effective config: ${check.effective.path} (${check.effective.source})`)
  } else {
    lines.push("  Effective config: none")
  }

  if (check.problem) {
    lines.push(`  Status: blocking - ${check.problem.message}`)
  } else {
    lines.push("  Status: ok")
  }
  return lines
}

async function runAuthCheck(
  config: LoreConfig,
  configRoot: string,
  env: NodeJS.ProcessEnv,
  deps: DoctorDeps
): Promise<{
  auth: ResolvedAuth | null
  lines: string[]
  problem: DoctorProblem | null
}> {
  try {
    const auth = await deps.resolveAuth(config, configRoot)
    const lines = [
      `  Source: ${formatAuthSource(auth)}`,
      `  Token prefix: ${formatTokenPrefix(auth.token)}`,
      `  Workspace selector: ${formatWorkspaceSelector(config, env)}`,
    ]
    if (auth.workspaceId) lines.push(`  Resolved workspace: ${auth.workspaceId}`)
    lines.push(`  Notion environment: ${formatNotionEnvironment(auth.baseUrl)}`)
    lines.push("  Status: ok")
    return { auth, lines, problem: null }
  } catch (err) {
    return {
      auth: null,
      lines: [`  Status: blocking - ${formatError(err)}`],
      problem: {
        kind: "auth",
        message: "No Notion auth source resolved.",
        nextAction: authMissingNextAction(env),
      },
    }
  }
}

function formatAuthSource(auth: ResolvedAuth): string {
  switch (auth.source) {
    case "env-notion-api-token":
      return "NOTION_API_TOKEN (env)"
    case "ntn-auth-json":
      return "ntn auth.json"
  }
}

function formatTokenPrefix(token: string): string {
  switch (classifyTokenPrefix(token)) {
    case "personal-prod":
      return "personal token (ntn_)"
    case "personal-dev":
      return "personal token (development_ntn_)"
    case "integration":
      return "integration token (secret_)"
    case "unknown":
      return "unknown"
  }
}

function formatWorkspaceSelector(config: LoreConfig, env: NodeJS.ProcessEnv): string {
  if (env["NOTION_WORKSPACE_ID"]) return `${env["NOTION_WORKSPACE_ID"]} (env)`
  if (config.auth?.workspaceId) return `${config.auth.workspaceId} (.lore.yaml)`
  return "none"
}

function formatNotionEnvironment(baseUrl: string | undefined): string {
  const effective = baseUrl ?? DEFAULT_NOTION_BASE_URL
  const env = ntnEnvFromBaseUrl(effective)
  if (!baseUrl) return `prod (${DEFAULT_NOTION_BASE_URL}; default)`
  if (env) return `${env} (${effective})`
  return `custom (${effective})`
}

function authMissingNextAction(env: NodeJS.ProcessEnv): string {
  if (env["NOTION_API_TOKEN"]?.trim()) return "lore auth --status"
  return "lore auth --login"
}

async function runVaultCheck(
  config: LoreConfig,
  auth: ResolvedAuth,
  deps: DoctorDeps
): Promise<{ lines: string[]; problem: DoctorProblem | null }> {
  const client = deps.createLimitedClient(deps.createClient(auth.token, auth.baseUrl))
  const access = await deps.verifyVaultAccess(client, config.vault.pageId)
  if (access.kind !== "ok") {
    return formatVaultAccessFailure(access, auth)
  }

  const lines = [`  Vault page: accessible (${access.pageTitle ?? config.vault.pageId})`]
  try {
    await deps.verifyVaultDatabases(client, config.vault.pageId)
    lines.push("  Required databases: present")
    lines.push("  Status: ok")
    return { lines, problem: null }
  } catch (err) {
    if (err instanceof MissingVaultDatabasesError) {
      lines.push(`  Required databases: missing ${err.missing.join(", ")}`)
      lines.push(
        err.present.length > 0
          ? `  Present databases: ${err.present.join(", ")}`
          : "  Present databases: none"
      )
      return {
        lines,
        problem: {
          kind: "vault",
          message: err.message,
          nextAction: missingDatabaseNextAction(err),
        },
      }
    }
    lines.push(`  Required databases: check failed - ${formatError(err)}`)
    return {
      lines,
      problem: {
        kind: "vault",
        message: "Required database probe failed.",
        nextAction: "lore status",
      },
    }
  }
}

function formatVaultAccessFailure(
  result: Exclude<Awaited<ReturnType<typeof verifyVaultAccess>>, { kind: "ok" }>,
  auth: ResolvedAuth
): { lines: string[]; problem: DoctorProblem } {
  if (result.kind === "unknown-error") {
    return {
      lines: [`  Vault page: check failed - ${formatError(result.error)}`],
      problem: {
        kind: "vault",
        message: "Vault preflight returned an unexpected error.",
        nextAction: "lore auth --status",
      },
    }
  }

  const nextAction =
    result.kind === "rate-limited"
      ? "lore doctor"
      : auth.source === "ntn-auth-json"
        ? "lore auth --login"
        : ["Rotate or export NOTION_API_TOKEN for the vault workspace", "lore doctor"]

  return {
    lines: [`  Vault page: ${result.kind} - ${result.message}`],
    problem: {
      kind: "vault",
      message: result.message,
      nextAction,
    },
  }
}

function missingDatabaseNextAction(err: MissingVaultDatabasesError): string {
  const missing = new Set(err.missing)
  if (missing.size === 1 && missing.has("Entities")) return "lore vault ensure-entities"
  if (err.present.length === 0) return "lore init"
  return "lore status"
}

async function inspectHostConfig(
  roots: HostConfigRoots,
  homeDir: string,
  expectedConfigRoot: string | undefined,
  inspect: HostConfigInspection
): Promise<HostCheck> {
  const problems: DoctorProblem[] = []
  const lines: string[] = []
  const [claudeYarnPnp, codexYarnPnp, cursorYarnPnp] = await Promise.all([
    detectYarnPnp(roots.claude),
    detectYarnPnp(roots.codex),
    detectYarnPnp(roots.cursor),
  ])

  const claudeMcp = await inspectJsonMcpFile(
    ".mcp.json",
    join(roots.claude, ".mcp.json"),
    expectedConfigRoot,
    { launcher: { kind: "claude", inspect: { ...inspect, yarnPnp: claudeYarnPnp } } }
  )
  lines.push(...claudeMcp.lines)
  problems.push(...claudeMcp.problems)

  const claudeSettings = await inspectClaudeSettingsMcp(
    claudeSettingsLabel(roots.claude),
    resolveClaudeSettingsPath(roots.claude, homeDir),
    expectedConfigRoot
  )
  lines.push(...claudeSettings.lines)
  problems.push(...claudeSettings.problems)

  const codexConfig = await inspectCodexConfig(
    ".codex/config.toml",
    join(roots.codex, ".codex", "config.toml"),
    expectedConfigRoot,
    { ...inspect, yarnPnp: codexYarnPnp }
  )
  lines.push(...codexConfig.lines)
  problems.push(...codexConfig.problems)

  const codexHooksPath = join(roots.codex, ".codex", "hooks.json")
  lines.push(
    (await fileExists(codexHooksPath))
      ? "  .codex/hooks.json: present (hook checks below)"
      : "  .codex/hooks.json: not present"
  )

  const projectCursor = await inspectJsonMcpFile(
    ".cursor/mcp.json",
    join(roots.cursor, ".cursor", "mcp.json"),
    expectedConfigRoot,
    {
      cursor: true,
      launcher: {
        kind: "cursor",
        inspect: { ...inspect, yarnPnp: cursorYarnPnp },
        useGlobalScope: false,
        launchCwd: roots.cursor,
      },
    }
  )
  lines.push(...projectCursor.lines)
  problems.push(...projectCursor.problems)

  const globalCursor = await inspectJsonMcpFile(
    "~/.cursor/mcp.json",
    join(homeDir, ".cursor", "mcp.json"),
    expectedConfigRoot,
    {
      cursor: true,
      shadowedBy: projectCursor.hasLoreEntry ? "project .cursor/mcp.json" : undefined,
      launcher: {
        kind: "cursor",
        inspect: { ...inspect, yarnPnp: cursorYarnPnp },
        useGlobalScope: true,
        launchCwd: roots.cursor,
      },
    }
  )
  lines.push(...globalCursor.lines)
  problems.push(...globalCursor.problems)

  return { lines, problems }
}

async function resolveHostConfigRoots(
  cwd: string,
  fallbackRoot: string
): Promise<HostConfigRoots> {
  const [claude, codex, cursor] = await Promise.all([
    findNearestHostConfigRoot(cwd, [[".mcp.json"]], fallbackRoot),
    findNearestHostConfigRoot(
      cwd,
      [
        [".codex", "config.toml"],
        [".codex", "hooks.json"],
      ],
      fallbackRoot
    ),
    findNearestHostConfigRoot(cwd, [[".cursor", "mcp.json"]], fallbackRoot),
  ])
  return { claude, codex, cursor }
}

async function findNearestHostConfigRoot(
  startDir: string,
  relativePaths: readonly (readonly string[])[],
  fallbackRoot: string
): Promise<string> {
  let dir = resolve(startDir)
  const fallback = resolve(fallbackRoot)

  while (true) {
    for (const relativePath of relativePaths) {
      if (await fileExists(join(dir, ...relativePath))) return dir
    }
    if (dir === fallback) return fallback
    const parent = dirname(dir)
    if (parent === dir) return fallback
    dir = parent
  }
}

async function inspectJsonMcpFile(
  label: string,
  path: string,
  expectedConfigRoot: string | undefined,
  opts: { cursor?: boolean; shadowedBy?: string; launcher?: JsonMcpLauncher } = {}
): Promise<JsonMcpCheck> {
  const parsed = await readJsonIfPresent(path)
  if (parsed.kind === "missing")
    return { lines: [`  ${label}: not present`], problems: [], hasLoreEntry: false }
  if (parsed.kind === "invalid") {
    if (opts.shadowedBy) {
      return {
        lines: [
          `  ${label}: invalid JSON - ${parsed.error} (shadowed by ${opts.shadowedBy})`,
        ],
        problems: [],
        hasLoreEntry: false,
      }
    }
    return {
      ...hostConfigProblem(label, `invalid JSON - ${parsed.error}`),
      hasLoreEntry: false,
    }
  }

  const mcpServers = objectRecord(parsed.value)?.["mcpServers"]
  const loreEntry = objectRecord(mcpServers)?.["lore"]
  if (!loreEntry) {
    return {
      lines: [`  ${label}: present, Lore MCP entry missing`],
      problems: [],
      hasLoreEntry: false,
    }
  }

  const lines = opts.shadowedBy
    ? [`  ${label}: Lore MCP entry present (shadowed by ${opts.shadowedBy})`]
    : [`  ${label}: Lore MCP entry present`]
  if (opts.cursor)
    lines.push("    hooks: MCP-only (Cursor has no Lore Stop/session hooks)")
  if (opts.shadowedBy) return { lines, problems: [], hasLoreEntry: true }

  const rootLine = describeLoreConfigRoot(objectRecord(loreEntry), expectedConfigRoot)
  if (rootLine.problem) {
    lines.push(`    ${rootLine.line}`)
    return {
      lines,
      hasLoreEntry: true,
      problems: [
        {
          kind: "host-config",
          message: `${label} has a stale LORE_CONFIG_ROOT.`,
          nextAction: "lore install",
        },
      ],
    }
  }
  if (rootLine.line) lines.push(`    ${rootLine.line}`)
  const launcher = objectRecord(loreEntry)
  const launcherStatus =
    launcher && opts.launcher ? classifyJsonMcpLauncher(launcher, opts.launcher) : null
  if (launcherStatus) lines.push(`    launcher: ${launcherStatus}`)
  if (launcherStatus === "stale") {
    return {
      lines,
      problems: [
        {
          kind: "host-config",
          message: `${label} has a stale Lore MCP launcher.`,
          nextAction: "lore install",
        },
      ],
      hasLoreEntry: true,
    }
  }
  return { lines, problems: [], hasLoreEntry: true }
}

function classifyJsonMcpLauncher(
  loreEntry: Record<string, unknown>,
  launcher: JsonMcpLauncher
): HookStatus {
  const notionBaseUrlLiteral = extractJsonMcpNotionBaseUrlLiteral(loreEntry)
  if (launcher.kind === "claude") {
    return classifyClaudeMcpLauncher(loreEntry, {
      ...launcherOptions(launcher.inspect),
      notionBaseUrlLiteral,
    })
  }
  return classifyCursorMcpLauncher(loreEntry, {
    ...launcherOptions(launcher.inspect),
    notionBaseUrlLiteral,
    useGlobalScope: launcher.useGlobalScope,
    launchCwd: launcher.launchCwd,
  })
}

function launcherOptions(inspect: HostConfigInspection): {
  configRoot: string
  yarnPnp: boolean
  envSource: NodeJS.ProcessEnv
  authSource?: AuthSource
  notionBaseUrlLiteral?: string
} {
  return {
    configRoot: inspect.configRoot,
    yarnPnp: inspect.yarnPnp,
    envSource: inspect.envSource,
    authSource: inspect.authSource,
    notionBaseUrlLiteral: inspect.notionBaseUrlLiteral,
  }
}

function extractJsonMcpNotionBaseUrlLiteral(
  loreEntry: Record<string, unknown>
): string | undefined {
  const env = objectRecord(loreEntry["env"])
  const value =
    typeof env?.["NOTION_BASE_URL"] === "string" ? env["NOTION_BASE_URL"] : null
  return canonicalNotionBaseUrlLiteral(value)
}

async function inspectClaudeSettingsMcp(
  label: string,
  path: string,
  expectedConfigRoot: string | undefined
): Promise<HostCheck> {
  const parsed = await readJsonIfPresent(path)
  if (parsed.kind === "missing")
    return { lines: [`  ${label}: not present`], problems: [] }
  if (parsed.kind === "invalid") {
    return hostConfigProblem(label, `invalid JSON - ${parsed.error}`)
  }

  const mcpServers = objectRecord(parsed.value)?.["mcpServers"]
  const loreEntry = objectRecord(mcpServers)?.["lore"]
  if (!loreEntry) {
    return { lines: [`  ${label}: present; no legacy Lore MCP entry`], problems: [] }
  }

  const lines = [`  ${label}: legacy Lore MCP entry present (will migrate)`]
  const rootLine = describeLoreConfigRoot(objectRecord(loreEntry), expectedConfigRoot)
  if (rootLine.line) lines.push(`    ${rootLine.line}`)
  return {
    lines,
    problems: [
      {
        kind: "host-config",
        message: `${label} still carries a legacy Lore MCP entry.`,
        nextAction: "lore install",
      },
    ],
  }
}

async function inspectCodexConfig(
  label: string,
  path: string,
  expectedConfigRoot: string | undefined,
  inspect: HostConfigInspection
): Promise<HostCheck> {
  const text = await readTextIfPresent(path)
  if (text.kind === "missing") return { lines: [`  ${label}: not present`], problems: [] }
  const block = extractTomlTableGroup(text.value, "mcp_servers.lore")
  if (!block) {
    return { lines: [`  ${label}: present, Lore MCP entry missing`], problems: [] }
  }

  const lines = [`  ${label}: Lore MCP entry present`]
  const configRoot = extractShellEnvAssignment(block, "LORE_CONFIG_ROOT")
  const rootLine = compareConfigRoot(configRoot, expectedConfigRoot)
  if (rootLine.problem) {
    lines.push(`    ${rootLine.line}`)
    return {
      lines,
      problems: [
        {
          kind: "host-config",
          message: ".codex/config.toml has a stale LORE_CONFIG_ROOT.",
          nextAction: "lore install",
        },
      ],
    }
  }
  if (rootLine.line) lines.push(`    ${rootLine.line}`)
  const notionBaseUrlLiteral = canonicalNotionBaseUrlLiteral(
    extractShellEnvAssignment(block, "NOTION_BASE_URL")
  )
  const launcherStatus = classifyCodexMcpLauncher(block, {
    ...launcherOptions(inspect),
    notionBaseUrlLiteral,
  })
  lines.push(`    launcher: ${launcherStatus}`)
  if (launcherStatus === "stale") {
    return {
      lines,
      problems: [
        {
          kind: "host-config",
          message: ".codex/config.toml has a stale Lore MCP launcher.",
          nextAction: "lore install",
        },
      ],
    }
  }
  return { lines, problems: [] }
}

function hostConfigProblem(label: string, detail: string): HostCheck {
  return {
    lines: [`  ${label}: ${detail}`],
    problems: [
      {
        kind: "host-config",
        message: `${label}: ${detail}`,
        nextAction: "lore install",
      },
    ],
  }
}

function describeLoreConfigRoot(
  loreEntry: Record<string, unknown> | null,
  expectedConfigRoot: string | undefined
): { line: string | null; problem: boolean } {
  const env = objectRecord(loreEntry?.["env"])
  const root =
    typeof env?.["LORE_CONFIG_ROOT"] === "string" ? env["LORE_CONFIG_ROOT"] : null
  return compareConfigRoot(root, expectedConfigRoot)
}

function compareConfigRoot(
  actualRoot: string | null,
  expectedConfigRoot: string | undefined
): { line: string | null; problem: boolean } {
  if (!actualRoot)
    return { line: "LORE_CONFIG_ROOT: not carried by entry", problem: false }
  if (!expectedConfigRoot) {
    return {
      line: `LORE_CONFIG_ROOT: ${actualRoot} (no discovered root to compare)`,
      problem: false,
    }
  }
  const normalizedActual = resolve(expandHome(actualRoot))
  const normalizedExpected = resolve(expectedConfigRoot)
  if (normalizedActual === normalizedExpected) {
    return { line: `LORE_CONFIG_ROOT: matches ${normalizedExpected}`, problem: false }
  }
  return {
    line: `LORE_CONFIG_ROOT: ${normalizedActual} (expected ${normalizedExpected})`,
    problem: true,
  }
}

async function inspectHooks(
  roots: HostConfigRoots,
  homeDir: string,
  configRoot: string | undefined,
  deps: DoctorDeps
): Promise<HostCheck> {
  const problems: DoctorProblem[] = []
  const lines: string[] = []
  const claudeMcpHasLore = await jsonMcpFileHasLoreEntry(join(roots.claude, ".mcp.json"))
  const claude = await inspectClaudeHooks(
    resolveClaudeSettingsPath(roots.claude, homeDir),
    claudeMcpHasLore
  )
  lines.push(...claude.lines)
  problems.push(...claude.problems)
  const codex = await inspectCodexHooks(
    join(roots.codex, ".codex", "hooks.json"),
    join(roots.codex, ".codex", "config.toml")
  )
  lines.push(...codex.lines)
  problems.push(...codex.problems)

  if (!configRoot) {
    lines.push("  Background failures: skipped (no config root)")
    return { lines, problems }
  }

  const report = await deps.loadBackgroundFailureStatus(configRoot)
  const backgroundLines = formatBackgroundFailureStatus(report).map((line) => `  ${line}`)
  lines.push(...backgroundLines)
  if (report.failures.length > 0) {
    problems.push({
      kind: "hooks",
      message: "Recent background hook failures are present.",
      nextAction: "lore status",
    })
  }
  return { lines, problems }
}

function claudeSettingsLabel(projectDir: string): string {
  return `~/.claude/projects/${encodeClaudeProjectPath(projectDir)}/settings.json`
}

async function inspectClaudeHooks(path: string, required: boolean): Promise<HostCheck> {
  const parsed = await readJsonIfPresent(path)
  if (parsed.kind === "missing") {
    return {
      lines: [
        required
          ? "  Claude Code hooks: not present (required by .mcp.json Lore MCP entry)"
          : "  Claude Code hooks: not present",
      ],
      problems: required
        ? [
            {
              kind: "hooks",
              message:
                "Claude Code hooks are missing while Claude Code Lore MCP is configured.",
              nextAction: "lore install",
            },
          ]
        : [],
    }
  }
  if (parsed.kind === "invalid") {
    return hookProblem("Claude Code hooks", `invalid JSON - ${parsed.error}`)
  }
  const hooks = objectRecord(objectRecord(parsed.value)?.["hooks"])
  const wakeup = classifyClaudeHookCommand(hooks?.["UserPromptSubmit"], "wakeup")
  const autosave = classifyClaudeHookCommand(hooks?.["Stop"], "autosave")
  const sessionEnd = hasHookCommand(hooks?.["SessionEnd"], "session-end")
  const hasLoreOwnedHook = wakeup !== "missing" || autosave !== "missing" || sessionEnd
  const enforceHooks = required || hasLoreOwnedHook
  const lines = [
    `  Claude Code wakeup hook: ${wakeup}`,
    `  Claude Code autosave hook: ${autosave}`,
  ]
  const problems: DoctorProblem[] = []
  if (!required && hasLoreOwnedHook) {
    problems.push({
      kind: "hooks",
      message:
        "Claude Code hooks are present while Claude Code Lore MCP is not configured.",
      nextAction: "lore install",
    })
  }
  if (enforceHooks && (wakeup !== "present" || autosave !== "present")) {
    problems.push({
      kind: "hooks",
      message: "Claude Code hook config is missing or has a stale Lore hook.",
      nextAction: "lore install",
    })
  }
  if (sessionEnd) {
    lines.push("  Claude Code SessionEnd hook: legacy Lore entry present")
    problems.push({
      kind: "hooks",
      message: "Claude Code SessionEnd still carries a legacy Lore hook.",
      nextAction: "lore install",
    })
  }
  return { lines, problems }
}

async function inspectCodexHooks(
  hooksPath: string,
  configPath: string
): Promise<HostCheck> {
  const feature = await inspectCodexHooksFeature(configPath)
  const parsed = await readJsonIfPresent(hooksPath)
  if (parsed.kind === "missing") {
    if (!feature.hasLoreConfig) {
      return { lines: ["  Codex hooks: not present"], problems: [] }
    }
    const lines = [
      `  Codex hooks feature: ${feature.status}`,
      "  Codex hooks: not present",
    ]
    const problems: DoctorProblem[] = [
      {
        kind: "hooks",
        message: "Codex hooks file is missing while Codex Lore MCP is configured.",
        nextAction: "lore install",
      },
    ]
    if (!feature.enabled) problems.push(codexHooksFeatureProblem(feature.status))
    return {
      lines,
      problems,
    }
  }

  const problems: DoctorProblem[] = []
  const lines = [`  Codex hooks feature: ${feature.status}`]
  if (parsed.kind === "invalid") {
    lines.push(`  Codex hooks: invalid JSON - ${parsed.error}`)
    problems.push({
      kind: "hooks",
      message: `Codex hooks: invalid JSON - ${parsed.error}`,
      nextAction: "lore install",
    })
    return { lines, problems }
  }

  const hooks = objectRecord(objectRecord(parsed.value)?.["hooks"])
  const wakeup = hasHookCommand(hooks?.["UserPromptSubmit"], "wakeup")
  const autosave = hasHookCommand(hooks?.["Stop"], "autosave")
  const enforceHooks = feature.hasLoreConfig || wakeup || autosave
  lines.push(
    `  Codex wakeup hook: ${wakeup ? "present" : "missing"}`,
    `  Codex autosave hook: ${autosave ? "present" : "missing"}`
  )
  if (!feature.hasLoreConfig && (wakeup || autosave)) {
    problems.push({
      kind: "hooks",
      message: "Codex hooks are present while Codex Lore MCP is not configured.",
      nextAction: "lore install",
    })
  }
  if (!feature.enabled && enforceHooks) {
    problems.push(codexHooksFeatureProblem(feature.status))
  }
  if (enforceHooks && (!wakeup || !autosave)) {
    problems.push({
      kind: "hooks",
      message: "Codex hook config is missing a Lore hook.",
      nextAction: "lore install",
    })
  }
  return { lines, problems }
}

function codexHooksFeatureProblem(status: string): DoctorProblem {
  return {
    kind: "hooks",
    message: `Codex hooks feature is not enabled (${status}).`,
    nextAction: "lore install",
  }
}

async function inspectCodexHooksFeature(
  path: string
): Promise<{ enabled: boolean; hasLoreConfig: boolean; status: string }> {
  const text = await readTextIfPresent(path)
  if (text.kind === "missing") {
    return {
      enabled: false,
      hasLoreConfig: false,
      status: "missing (.codex/config.toml not present)",
    }
  }

  const hasLoreConfig = extractTomlTableGroup(text.value, "mcp_servers.lore") !== null
  const value = extractTomlKeyValue(text.value, "features", "hooks")
  if (value === undefined) {
    return { enabled: false, hasLoreConfig, status: "missing" }
  }
  if (value === "true") return { enabled: true, hasLoreConfig, status: "enabled" }
  return { enabled: false, hasLoreConfig, status: `not true (${value})` }
}

function hookProblem(label: string, detail: string): HostCheck {
  return {
    lines: [`  ${label}: ${detail}`],
    problems: [
      { kind: "hooks", message: `${label}: ${detail}`, nextAction: "lore install" },
    ],
  }
}

function hasHookCommand(
  value: unknown,
  eventName: "wakeup" | "autosave" | "session-end"
): boolean {
  if (!Array.isArray(value)) return false
  const legacyScript = `${eventName}.sh`
  const commandPattern = new RegExp(`\\blore hooks ${eventName}\\b`)
  return value.some((entry) => {
    const hooks = objectRecord(entry)?.["hooks"]
    if (!Array.isArray(hooks)) return false
    return hooks.some((hook) => {
      const command = objectRecord(hook)?.["command"]
      return typeof command === "string"
        ? commandPattern.test(command) || command.includes(`/${legacyScript}`)
        : false
    })
  })
}

function classifyClaudeHookCommand(
  value: unknown,
  eventName: "wakeup" | "autosave"
): HookPresence {
  if (!Array.isArray(value)) return "missing"
  const legacyScript = `${eventName}.sh`
  const currentCommands = new Set([
    `cd "$CLAUDE_PROJECT_DIR" && lore hooks ${eventName}`,
    `cd "$CLAUDE_PROJECT_DIR" && yarn run -T lore hooks ${eventName}`,
  ])
  const loreBinDispatchPattern = new RegExp(
    `^(?:cd "\\$CLAUDE_PROJECT_DIR" && )?(?:yarn (?:run -T )?)?lore hooks ${eventName}$`
  )
  let stale = false

  for (const entry of value) {
    const hooks = objectRecord(entry)?.["hooks"]
    if (!Array.isArray(hooks)) continue
    for (const hook of hooks) {
      const command = objectRecord(hook)?.["command"]
      if (typeof command !== "string") continue
      if (currentCommands.has(command)) return "present"
      if (loreBinDispatchPattern.test(command) || command.endsWith(`/${legacyScript}`)) {
        stale = true
      }
    }
  }

  return stale ? "stale" : "missing"
}

function selectNextAction(problems: DoctorProblem[]): string | string[] {
  const order: ProblemKind[] = ["config", "auth", "vault", "host-config", "hooks"]
  for (const kind of order) {
    const problem = problems.find((candidate) => candidate.kind === kind)
    if (problem) return problem.nextAction
  }
  return "No action needed."
}

function formatNextAction(nextAction: string | string[]): string[] {
  if (Array.isArray(nextAction)) {
    return nextAction.map((action, index) => `  ${index + 1}. ${action}`)
  }
  return [`  ${nextAction}`]
}

async function readJsonIfPresent(
  path: string
): Promise<
  | { kind: "missing" }
  | { kind: "invalid"; error: string }
  | { kind: "ok"; value: unknown }
> {
  const text = await readTextIfPresent(path)
  if (text.kind === "missing") return text
  try {
    return { kind: "ok", value: JSON.parse(text.value) }
  } catch (err) {
    return { kind: "invalid", error: formatError(err) }
  }
}

async function jsonMcpFileHasLoreEntry(path: string): Promise<boolean> {
  const parsed = await readJsonIfPresent(path)
  if (parsed.kind !== "ok") return false
  const mcpServers = objectRecord(parsed.value)?.["mcpServers"]
  return objectRecord(mcpServers)?.["lore"] !== undefined
}

async function readTextIfPresent(
  path: string
): Promise<{ kind: "missing" } | { kind: "ok"; value: string }> {
  try {
    return { kind: "ok", value: await readFile(path, "utf-8") }
  } catch (err) {
    if (isNodeErrorCode(err, "ENOENT")) return { kind: "missing" }
    throw err
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function splitTomlLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n")
  if (normalized === "") return []
  return normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n")
}

function extractTomlTableGroup(text: string, tablePrefix: string): string | null {
  const lines = splitTomlLines(text)
  const sections: Array<{ name: string; start: number; end: number }> = []
  const headingPattern = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/
  for (let i = 0; i < lines.length; i++) {
    const match = headingPattern.exec(lines[i])
    if (!match) continue
    if (sections.length > 0) sections[sections.length - 1]!.end = i
    sections.push({ name: match[1]!.trim(), start: i, end: lines.length })
  }
  const matches = sections.filter(
    (section) =>
      section.name === tablePrefix || section.name.startsWith(`${tablePrefix}.`)
  )
  if (matches.length === 0) return null
  return lines.slice(matches[0]!.start, matches[matches.length - 1]!.end).join("\n")
}

function extractTomlKeyValue(
  text: string,
  tableName: string,
  key: string
): string | undefined {
  const lines = splitTomlLines(text)
  const headingPattern = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/
  const keyPattern = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*(?:#.*)?$`)
  let inTable = false

  for (const line of lines) {
    const heading = headingPattern.exec(line)
    if (heading) {
      inTable = heading[1]!.trim() === tableName
      continue
    }
    if (!inTable) continue
    const match = keyPattern.exec(line)
    if (match) return match[1]!.trim()
  }

  return undefined
}

function extractShellEnvAssignment(text: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const normalized = text.replace(/\\"/g, '"')
  const match = new RegExp(`\\b${escaped}=`).exec(normalized)
  if (!match) return null

  let index = match.index + match[0].length
  let value = ""
  while (index < normalized.length) {
    const char = normalized[index]
    if (!char || /\s/.test(char)) break

    if (char === "'" || char === '"') {
      const quote = char
      index += 1
      const start = index
      while (index < normalized.length && normalized[index] !== quote) {
        index += 1
      }
      value += normalized.slice(start, index)
      if (normalized[index] === quote) index += 1
      continue
    }

    const start = index
    while (
      index < normalized.length &&
      normalized[index] !== "'" &&
      normalized[index] !== '"' &&
      !/\s/.test(normalized[index]!)
    ) {
      index += 1
    }
    value += normalized.slice(start, index)
  }

  return value.length > 0 ? value : null
}

function canonicalNotionBaseUrlLiteral(value: string | null): string | undefined {
  if (!value) return undefined
  if (value.startsWith("${") && value.endsWith("}")) return undefined
  return ntnEnvFromBaseUrl(value) ? value : undefined
}

function expandHome(path: string): string {
  if (path === "~" || path === "${HOME}") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  if (path.startsWith("${HOME}/")) return join(homedir(), path.slice("${HOME}/".length))
  return path
}

function isNodeErrorCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === code
  )
}

function formatError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === "string") return err
  return String(err)
}
