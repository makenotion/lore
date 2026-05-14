/**
 * Hook config shape + defaulting policy.
 *
 * Kept separate because that module runs `main()` at import
 * time. Pulling the pure helpers out keeps them importable from tests and
 * from anywhere else that needs to know what a missing flag means.
 */

import { basename, isAbsolute } from "node:path"
import type { LoreConfig } from "../types.js"
import { canonicalizeAgentName } from "./agent-identity.js"
import { resolveFeatureFlags, type LoreFeatureFlags } from "../feature-flags.js"

/** Real user messages between structured AI-driven saves, when unset. */
export const DEFAULT_SAVE_INTERVAL = 5

/**
 * Default background-agent binary. Claude Code's headless
 * `claude -p` is what every Stop-spawn autosave and Stop-spawn digest
 * synthesizer has shelled out to since the hooks layer existed. The
 * `LoreConfig.hooks.backgroundAgent` knob plus `LORE_BACKGROUND_COMMAND`
 * env override let Codex-only (or other-CLI) operators redirect the spawn
 * without touching the spawn primitive.
 */
export const DEFAULT_BACKGROUND_COMMAND = "claude"

/**
 * Placeholder in `BackgroundAgentConfig.args` that the spawn primitive
 * substitutes with the tool allowlist string at fire time. Operators whose
 * agent CLI does not accept an allowlist flag should omit the placeholder
 * from their override; the spawn primitive then skips the allowlist
 * hand-off entirely.
 */
export const ALLOWED_TOOLS_PLACEHOLDER = "{{allowedTools}}"

/**
 * Default args for `claude -p`. Matches what `spawnBackgroundSave`
 * ships:
 *   - `-p` headless prompt mode
 *   - `--allowedTools <list>` (the substitution lands here)
 *   - `--dangerously-skip-permissions` (background save can't prompt)
 *   - `--no-session-persistence` (each save is independent)
 *   - `--model sonnet` (cheap, fast — synthesis-quality work doesn't need
 *     a frontier model)
 */
export const DEFAULT_BACKGROUND_ARGS: readonly string[] = [
  "-p",
  "--allowedTools",
  ALLOWED_TOOLS_PLACEHOLDER,
  "--dangerously-skip-permissions",
  "--no-session-persistence",
  "--model",
  "sonnet",
]

/**
 * Best-effort headless-mode args for `codex exec`. Codex's CLI does NOT
 * accept Claude's `-p` / `--allowedTools` / `--dangerously-skip-permissions`
 * / `--model sonnet` flags, so falling through to `DEFAULT_BACKGROUND_ARGS`
 * on a `command: codex` override produces a guaranteed spawn failure.
 *
 * The shape here uses Codex's `exec` subcommand with `workspace-write`
 * sandboxing and an explicit git-trust bypass so hook-spawned temp
 * workspaces can run non-interactively. There is NO
 * `{{allowedTools}}` placeholder because Codex's exec mode doesn't
 * carry an analogous flag — the agent's
 * allowlist must be configured out-of-band (Codex's .codex/config.toml
 * `approval_mode` / `mcp_servers.<name>.allowed_tools` entries are the
 * canonical knobs). The install-time path emits an explicit warning
 * about this when an operator's resolved args lack the placeholder.
 *
 * Operators who pin Codex to a different shape (e.g. an older Codex
 * version that uses different flag spelling) override `args` in their
 * .lore.yaml to drop or replace these defaults.
 */
export const CODEX_BACKGROUND_ARGS: readonly string[] = [
  "exec",
  "--sandbox",
  "workspace-write",
  "--skip-git-repo-check",
]

/**
 * Known-good arg presets keyed on `command` basename. When an operator
 * overrides `command` without overriding `args`, the resolver picks the
 * matching preset rather than blindly handing `DEFAULT_BACKGROUND_ARGS`
 * to a binary that doesn't speak Claude's flag dialect.
 *
 * Lookup is **basename-aware** — `/opt/homebrew/bin/codex` and bare
 * `codex` both resolve to the codex preset. Absolute paths are a
 * common way to survive hook environments with a minimal `PATH`, and
 * an exact-string-only match would silently let a Codex operator
 * pinning their absolute path inherit Claude flags. The basename of a
 * non-absolute command is the command itself, so bare names match the
 * same way they always did.
 *
 * Unknown basenames (e.g. `claude-next`, `aider`, `my-custom-agent`)
 * fall through to `DEFAULT_BACKGROUND_ARGS` for back-compat — an
 * operator setting `command: claude-next` keeps Claude's flag dialect,
 * which is the historical fallthrough behavior.
 *
 * The install-time path warns when args was NOT supplied AND the
 * command's basename falls outside this map, so an operator on an
 * unsupported binary sees the gap before the runtime spawn fails.
 *
 * Adding a preset is a one-line change here plus a paired test.
 * New presets MUST honor the `{{allowedTools}}`
 * placeholder convention OR document explicitly (in their args
 * docstring) that the agent's allowlist must be configured
 * out-of-band — `renderAgentArgs` silently drops the value when the
 * placeholder is absent, so a missing placeholder means a missing
 * allowlist hand-off.
 */
export const KNOWN_COMMAND_PRESETS: Readonly<Record<string, readonly string[]>> = {
  claude: DEFAULT_BACKGROUND_ARGS,
  codex: CODEX_BACKGROUND_ARGS,
}

/**
 * Look up the args preset for a `command` value, matching by basename
 * for absolute paths. Returns `undefined` when no preset matches —
 * callers fall through to `DEFAULT_BACKGROUND_ARGS` for back-compat.
 *
 * Exported for tests and for the install-time `presetMatched` flag.
 */
export function lookupCommandPreset(command: string): readonly string[] | undefined {
  const key = isAbsolute(command) ? basename(command) : command
  return KNOWN_COMMAND_PRESETS[key]
}

/**
 * Map from canonical agent name (`LORE_AGENT_NAME` env, after
 * `canonicalizeAgentName`) to the background-agent command name that
 * agent's installer should default to. Lets the resolver pick a
 * compatible default WITHOUT requiring per-project .lore.yaml setup
 * or a shell-rc-exported `LORE_BACKGROUND_COMMAND` — a Codex install
 * already prefixes hook commands with `LORE_AGENT_NAME=Codex `, so the
 * hook-fire-time env carries everything needed to derive `command:
 * codex`.
 *
 * Resolution priority (highest first) per `resolveBackgroundAgent`:
 *   1. `LORE_BACKGROUND_COMMAND` env (operator-scoped override)
 *   2. `hooks.backgroundAgent.command` in .lore.yaml (project-scoped)
 *   3. `AGENT_BACKGROUND_COMMAND[canonicalAgent]` derived default
 *   4. `DEFAULT_BACKGROUND_COMMAND` (`"claude"`, the historical default)
 *
 * Claude Code installs do NOT typically set `LORE_AGENT_NAME` — they
 * rely on `CLAUDECODE=1` / `CLAUDE_CODE_*` runtime markers — so the
 * derived-default tier is a no-op for them and they continue to
 * resolve `claude` from tier 4. Codex installs set the prefix at
 * install time so tier 3 fires every hook.
 *
 * Adding a derivation is a one-line change here plus a paired
 * test. The keyspace MUST use canonical agent names —
 * matched against `canonicalizeAgentName(envSource["LORE_AGENT_NAME"])`
 * — so a future change to canonicalization (e.g., a new Claude
 * variant the regex collapses) doesn't silently shift derivations.
 */
export const AGENT_BACKGROUND_COMMAND: Readonly<Record<string, string>> = {
  Codex: "codex",
}

/**
 * Resolved background-agent shape consumed by `spawnBackgroundSave`. The
 * config layer collapses the optional `LoreConfig.hooks.backgroundAgent`
 * shape onto this — every field is always present, defaults applied.
 */
export interface BackgroundAgentConfig {
  command: string
  args: string[]
}

export interface HookConfig {
  saveInterval: number
  autoSave: boolean
  wakeUp: boolean
  /**
   * Whether the Stop hook may schedule a background digest synthesizer.
   * Orthogonal to `autoSave` so an operator can keep per-session saves
   * while pausing auto-digest (e.g. to audit synthesizer output quality).
   * The CLI `lore digest` path ignores this flag — manual runs are always
   * honored.
   */
  autoDigest: boolean
  /**
   * Whether the Stop-spawn autosave sub-agent should extract atomic
   * learnings in addition to the session synopsis. Honored by
   * the prompt builder; the helper layer combines this with the
   * `LORE_DISABLE_LEARNING_EXTRACTION` env override before passing the
   * resolved boolean to `buildBackgroundSavePrompt`.
   */
  learningExtraction: boolean
  /**
   * Whether the Stop-spawn autosave sub-agent should write atomic
   * learnings as `status: "proposed"`. Default
   * `false` so existing installs see byte-identical autosave
   * behavior. When `true` AND `learningExtraction` is also `true`,
   * the prompt builder instructs the sub-agent to add `status:
   * "proposed"` to every atomic-learning save so the rows land in
   * the review inbox.
   */
  proposeAutosaveLearnings: boolean
  /**
   * Resolved background-agent shape. Defaults to
   * `{ command: "claude", args: <DEFAULT_BACKGROUND_ARGS> }`. Honors
   * `LoreConfig.hooks.backgroundAgent.{command,args}` overrides plus the
   * `LORE_BACKGROUND_COMMAND` env-var override on `command`. The spawn
   * primitive (`spawnBackgroundSave`) consumes this directly.
   */
  backgroundAgent: BackgroundAgentConfig
  /**
   * Runtime feature flags needed by the hook layer. Resolved once from
   * config plus env so Stop processing does not consult process.env at
   * each decision point.
   */
  features: Pick<LoreFeatureFlags, "learningExtraction">
  /**
   * Name of the catch-all project (path `"."` or `""`) in this workspace, if
   * configured. The save prompts name it explicitly and tell the AI to avoid
   * defaulting to it for sub-project-specific work.
   */
  catchAllName: string | null
  /**
   * Non-catch-all project names from the config, in declaration order. Used
   * by the save prompts to enumerate the buckets the AI should pick from.
   */
  subProjects: string[]
}

/**
 * Merge a .lore.yaml hooks section with built-in defaults.
 *
 * `autoSave`, `wakeUp`, `autoDigest`, and `learningExtraction` default to
 * true: hooks are opt-out, not opt-in, once the integration is installed.
 * Users who want to suppress any of them set the flag to `false` explicitly.
 *
 * `envSource` is injectable for test determinism — production callers use
 * `process.env`. The env source is consulted only for
 * `LORE_BACKGROUND_COMMAND`; other env-var overrides
 * (`LORE_AUTO_DIGEST`, `LORE_DISABLE_LEARNING_EXTRACTION`) live at the
 * spawn / prompt-build layer where they're combined with the merged
 * config.
 */
export function mergeHookDefaults(
  hooks: LoreConfig["hooks"] | undefined,
  catchAllName: string | null = null,
  subProjects: string[] = [],
  envSource: NodeJS.ProcessEnv = process.env,
  featuresConfig: LoreConfig["features"] | undefined = undefined
): HookConfig {
  return {
    saveInterval: hooks?.saveInterval ?? DEFAULT_SAVE_INTERVAL,
    autoSave: hooks?.autoSave ?? true,
    wakeUp: hooks?.wakeUp ?? true,
    autoDigest: hooks?.autoDigest ?? true,
    learningExtraction: hooks?.learningExtraction ?? true,
    proposeAutosaveLearnings: hooks?.proposeAutosaveLearnings ?? false,
    backgroundAgent: resolveBackgroundAgent(hooks?.backgroundAgent, envSource),
    features: {
      learningExtraction: resolveFeatureFlags(envSource, {
        features: featuresConfig,
      }).learningExtraction,
    },
    catchAllName,
    subProjects,
  }
}

/**
 * Resolve the background-agent shape from the optional config knob,
 * the `LORE_BACKGROUND_COMMAND` env override, and the agent context
 * derived from `LORE_AGENT_NAME`.
 *
 * Command resolution chain (highest priority first):
 *   1. `LORE_BACKGROUND_COMMAND` env — operator-scoped ad-hoc override
 *      (a developer experimenting with a different agent CLI in their
 *      shell rc).
 *   2. `hooks.backgroundAgent.command` in .lore.yaml — project-scoped
 *      override committed for the whole team.
 *   3. `AGENT_BACKGROUND_COMMAND[canonicalAgent]` — derived from the
 *      `LORE_AGENT_NAME` env the installer set on the host's hook
 *      command prefix (Codex prefixes `LORE_AGENT_NAME=Codex` on every
 *      hook entry, which makes `command: codex` the natural default
 *      without per-project setup).
 *   4. `DEFAULT_BACKGROUND_COMMAND` (`"claude"`) — historical default,
 *      preserves Claude Code installs byte-for-byte.
 *
 * Args resolution: explicit `override.args` wins; otherwise fall through
 * to the preset for the resolved `command` value (`lookupCommandPreset`,
 * basename-aware so `/opt/homebrew/bin/codex` matches `codex`). Without
 * the preset table, `command: codex` would inherit Claude's flag
 * dialect (`-p`, `--allowedTools`, `--model sonnet`) which Codex's CLI
 * rejects — making the documented common case (swap binary, keep
 * everything else) silently broken. There's no env-var path for args
 * because the value is a structured array (env vars are scalar);
 * operators who need to pin a custom shape edit .lore.yaml.
 *
 * Unknown commands fall through to `DEFAULT_BACKGROUND_ARGS` so the
 * historical Claude flag shape is preserved as the conservative
 * back-compat default. The install-time path emits a warning for
 * unknown-command-without-args so the operator sees the mismatch
 * before runtime.
 *
 * The returned `args` is a fresh array on each call so callers downstream
 * of `mergeHookDefaults` can pass it by reference without worrying about
 * cross-process aliasing of the default constant. The shape is treated as
 * read-only by every consumer — `renderAgentArgs` returns a fresh array
 * rather than mutating in place — but the defensive copy ensures a future
 * caller that does a one-shot push (`args.push("--verbose")`) can't poison
 * other in-process consumers reading the same `HookConfig`.
 */
function resolveBackgroundAgent(
  override: NonNullable<LoreConfig["hooks"]>["backgroundAgent"] | undefined,
  envSource: NodeJS.ProcessEnv
): BackgroundAgentConfig {
  const envCommand = envSource["LORE_BACKGROUND_COMMAND"]
  const trimmedEnvCommand =
    envCommand && envCommand.trim().length > 0 ? envCommand.trim() : undefined
  // Derive default from agent context. Canonicalization matches what
  // `deriveAgentName` does to populate the Memory `Agent:` field — a
  // future Claude-variant the regex collapses won't silently shift
  // tier-3 lookups because canonical Claude Code does NOT appear in
  // `AGENT_BACKGROUND_COMMAND` (it would resolve to the same `"claude"`
  // as tier 4, so the entry would be a no-op).
  const agentNameRaw = envSource["LORE_AGENT_NAME"]
  const canonicalAgent =
    agentNameRaw && agentNameRaw.trim().length > 0
      ? canonicalizeAgentName(agentNameRaw)
      : undefined
  const derivedDefault = canonicalAgent
    ? AGENT_BACKGROUND_COMMAND[canonicalAgent]
    : undefined
  const command =
    trimmedEnvCommand ?? override?.command ?? derivedDefault ?? DEFAULT_BACKGROUND_COMMAND
  // Args resolution: explicit override > basename-aware preset for the
  // resolved command > Claude-shaped fallthrough. There is no
  // `LORE_BACKGROUND_ARGS` env path because args is structurally an
  // array and env vars are scalar — a split-on-whitespace parser would
  // re-introduce the quoting bugs (`--flag "value with spaces"`) the
  // structured shape exists to avoid. Operators who need ad-hoc arg
  // overrides edit .lore.yaml.
  const presetArgs = lookupCommandPreset(command) ?? DEFAULT_BACKGROUND_ARGS
  const args = override?.args ? [...override.args] : [...presetArgs]
  return { command, args }
}
