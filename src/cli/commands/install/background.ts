import { findConfigFile, loadConfig } from "../../../config.js"
import type { LoreConfig } from "../../../types.js"
import { findBackgroundBinary } from "../../../hooks/background.js"
import {
  ALLOWED_TOOLS_PLACEHOLDER,
  lookupCommandPreset,
  mergeHookDefaults,
} from "../../../hooks/config.js"
import { buildHookDisclosureLines } from "../../hook-disclosure.js"
import type { InstallContext } from "./types.js"

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
  agentNameOverride?: string
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
      // Malformed .lore.yaml — fall through to defaults. The
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
  // Basename-aware preset match — matches the runtime resolver so the
  // install-time `presetMatched` flag agrees with what `mergeHookDefaults`
  // actually selected for `args`. Without this, an operator on
  // `command: /opt/homebrew/bin/codex` would observe `presetMatched: false`
  // even though the runtime resolver picked up the codex preset.
  const presetMatched = lookupCommandPreset(command) !== undefined
  const argsContainAllowedToolsPlaceholder = args.some((a) =>
    a.includes(ALLOWED_TOOLS_PLACEHOLDER)
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
  summary: BackgroundAgentInstallSummary
): void {
  console.log(
    `  Background agent:  ${summary.command}${
      summary.present ? " (found on PATH)" : " (NOT FOUND on PATH)"
    }`
  )
  if (!summary.present) {
    console.warn("")
    console.warn(`  Warning: background command "${summary.command}" is not on PATH.`)
    console.warn(
      "    Stop hooks will fire, but the autosave / auto-digest spawn will skip"
    )
    console.warn("    with a `[lore] binary-missing` stderr line until the binary is")
    console.warn("    installed. Recovery options:")
    console.warn("      - Install Claude Code (default), or")
    console.warn("      - Override hooks.backgroundAgent in .lore.yaml to point at a")
    console.warn(
      "        different agent CLI (Lore ships presets for `claude` and `codex`):"
    )
    console.warn("            hooks:")
    console.warn("              backgroundAgent:")
    console.warn("                command: codex")
    console.warn(
      "      - Or set LORE_BACKGROUND_COMMAND=<binary> in your shell rc for an"
    )
    console.warn("        ad-hoc override.")
  }
  if (summary.present && !summary.presetMatched) {
    // The binary exists but it's not in the preset table. Args fell
    // through to `DEFAULT_BACKGROUND_ARGS` (Claude's flag dialect),
    // which works for Claude variants only. Operators on an unknown
    // binary need to supply their own `args` shape.
    console.warn("")
    console.warn(`  Warning: "${summary.command}" is not a known agent — Lore is using`)
    console.warn(
      `    Claude's flag dialect (\`-p --allowedTools ... --model sonnet\`) by`
    )
    console.warn("    default. If your binary doesn't accept those flags, the spawn will")
    console.warn("    fail at runtime. Override hooks.backgroundAgent.args in .lore.yaml")
    console.warn(
      "    with the binary's headless-mode flags. Use `{{allowedTools}}` where"
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
    console.warn(`  Note: "${summary.command}" args do not carry the {{allowedTools}}`)
    console.warn(
      "    placeholder. The lore tool allowlist will not be passed through; you"
    )
    console.warn("    must configure the agent's allowlist out-of-band (for Codex, set")
    console.warn("    `mcp_servers.lore.allowed_tools` in `.codex/config.toml`).")
  }
}

/**
 * Print the hook-disclosure block as part of the install
 * preflight summary. Claude Code AND Codex installs both wire Lore's
 * Stop / UserPromptSubmit hooks into the host config, which means the
 * default-`true` hooks listed in `mergeHookDefaults` start firing the
 * moment the install completes — regardless of whether the operator
 * just ran `lore init` or is upgrading an existing .lore.yaml install.
 *
 * Cursor's MCP runtime doesn't activate these hooks, so
 * `runCursorInstall` deliberately omits the disclosure — there's
 * nothing to disclose on that host.
 *
 * The block sits between `printBackgroundAgentSummary` and the
 * "Install Lore X integration?" confirm prompt so an operator with
 * `--yes` automation also sees the lines flushed before any
 * configuration write lands.
 */
export function printHookDisclosure(): void {
  console.log("")
  for (const line of buildHookDisclosureLines()) {
    console.log(`  ${line}`)
  }
}
