import type { BinDispatchShape, HookStatus } from "./types.js"
import { toPortablePath } from "./utils.js"

const CODEX_AGENT_ENV_PREFIX = "LORE_AGENT_NAME=Codex "
export const CODEX_HOOKS_FEATURE_KEY = "hooks"

/**
 * Build the shell-string form of a Codex hook invocation with the
 * `LORE_AGENT_NAME` override baked in.
 *
 * Load-bearing assumption: Codex executes hooks.json `type: "command"`
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
 * Codex executes hooks.json `type: "command"` entries through `/bin/sh`
 * (the env-prefix shape `LORE_AGENT_NAME=Codex ...` depends on it), so
 * the bin-dispatch form keeps the prefix and trades the quoted absolute
 * `.sh` path for a `lore hooks <event>` invocation. PATH must include
 * the consumer repo's `node_modules/.bin` for `lore` to resolve at
 * hook-fire time — Claude Code and many shells set this up
 * automatically; if Codex's hook context doesn't, operators may need to
 * fall back to legacy absolute-path mode until Codex's hook runner exposes a
 * project-local PATH hook.
 */
/**
 * Build the bin-dispatch shell-string command Claude registers for a
 * hook event. Two layered concerns:
 *
 * - **`cd "$CLAUDE_PROJECT_DIR"` prefix.** Claude Code's hook runner
 *   fires hook commands with cwd set to whatever Claude Code's
 *   process happens to have at fire time — frequently the binary's
 *   install directory or the user's `~`, NOT the project root. Lore's
 *   hook helpers walk upward from `process.cwd()` to find
 *   .lore.yaml; without anchoring, a hook fired from the wrong cwd
 *   resolves the wrong vault (or fails entirely on a fresh laptop).
 *   Claude Code exposes the project-root path via `$CLAUDE_PROJECT_DIR`
 *   for exactly this case. The literal `$` in the emitted command
 *   stays unexpanded by Lore's writer (it's a JSON string-valued
 *   field in settings.json); Claude's hook shell substitutes it at
 *   fire time.
 * - **Yarn-PnP shape.** `yarn run -T lore` (top-level) resolves the
 *   workspace-root binary even when the hook fires from a nested
 *   workspace package's cwd. Bare `yarn lore` resolves only against
 *   the cwd's package manifest and fails on subdirectory cwds —
 *   exactly the case the `cd "$CLAUDE_PROJECT_DIR"` wrapper exposes.
 */
export function buildClaudeHookCommand(
  eventName: HookEventName,
  shape: BinDispatchShape = "bare"
): string {
  const tail =
    shape === "yarn" ? `yarn run -T lore hooks ${eventName}` : `lore hooks ${eventName}`
  return `cd "$CLAUDE_PROJECT_DIR" && ${tail}`
}

/**
 * Codex hook command. Codex's hook runner already exposes the
 * project root via Codex's own context (.codex/hooks.json is
 * trusted-project-scoped, and Codex's hook shell launches with the
 * project as cwd by convention), so the `cd` prefix that Claude
 * needs isn't required here. The yarn-PnP shape uses `yarn run -T`
 * for the same workspace-root resolution reason that the Claude
 * variant does.
 */
export function buildCodexHookCommand(
  eventName: HookEventName,
  shape: BinDispatchShape = "bare"
): string {
  const tail =
    shape === "yarn" ? `yarn run -T lore hooks ${eventName}` : `lore hooks ${eventName}`
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
 * the entire deploy surface today: `wakeup` (UserPromptSubmit), `autosave`
 * (Stop), and `session-end` (compatibility shim).
 */
export type HookEventName = "wakeup" | "autosave" | "session-end"

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
 * identifies Lore-owned legacy entries even when the recorded
 * absolute path does not match the current install (a Lore checkout
 * that moved still classifies as `legacy-current` if the path resolves
 * the same way today, or `stale` otherwise).
 */
export function detectClaudeHook(
  entries: ClaudeHookEntry[] | undefined,
  scriptName: string,
  legacyExpectedPath: string,
  binDispatchCommand?: string
): HookStatus {
  if (!entries) return "missing"

  // Pattern matching all known Lore-owned bin-dispatch shapes. Same
  // pattern `upsertClaudeHookCommand` uses for filter — so any entry
  // the upsert would strip on reinstall surfaces here as something
  // OTHER than `missing`, giving operators an accurate "update
  // available" status before the rewrite. Without this match, an
  // older `lore hooks <event>` (no cd anchor) would classify as
  // `missing`, status would say "not installed", but the upsert
  // would still strip it — confusing.
  const allBinDispatchShapes =
    /^(?:cd "\$CLAUDE_PROJECT_DIR" && )?(?:yarn (?:run -T )?)?lore hooks (?:wakeup|autosave|session-end)$/

  for (const entry of entries) {
    for (const hook of entry.hooks ?? []) {
      const cmd = hook.command
      if (typeof cmd !== "string") continue
      // Bin-dispatch form: exact match against the desired-write
      // shape is `current`; match against any other Lore-owned
      // bin-dispatch variant is `stale` (eligible for upgrade).
      if (binDispatchCommand && cmd === binDispatchCommand) return "current"
      if (allBinDispatchShapes.test(cmd)) return "stale"
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
 * The two-shape filter is what lets `lore install` rewrite
 * a bin-dispatch entry back to legacy without leaving the bin-dispatch
 * entry behind, and lets default `lore install` rewrite a legacy entry
 * without leaving the legacy entry behind. Without the dual filter, an
 * upgrade or downgrade would land BOTH shapes in `Stop[]` and Claude
 * Code would fire both hooks back-to-back.
 */
export function upsertClaudeHookCommand(
  existing: ClaudeHookEntry[] | undefined,
  scriptName: string,
  newCommand: string,
  config: { matcher: string; timeout?: number; runOnce?: boolean }
): ClaudeHookEntry[] {
  // Recognize ALL Lore-owned bin-dispatch hook shapes so an upgrade
  // path strips the old entry before writing the new one — preventing
  // duplicate Lore hooks from accumulating in `Stop[]` /
  // `UserPromptSubmit[]` across reinstalls. The shapes the pattern
  // covers:
  //   1. Pre-`cd` bare bin: `lore hooks <event>`
  //   2. Pre-`cd` yarn-PnP bin: `yarn lore hooks <event>`
  //   3. Current bare with cd-anchor: `cd "$CLAUDE_PROJECT_DIR" && lore hooks <event>`
  //   4. Current yarn-PnP with cd-anchor + `run -T`:
  //      `cd "$CLAUDE_PROJECT_DIR" && yarn run -T lore hooks <event>`
  //   5. Transition: `cd "..." && yarn lore hooks <event>`
  //      (cd added, yarn shape not yet upgraded)
  // The two halves are independent: the cd-prefix is optional, the
  // yarn variant has two acceptable command shapes (legacy `yarn
  // lore` and current `yarn run -T lore`). Matching all combinations
  // means any prior install can be cleanly upgraded.
  const binDispatchPattern =
    /^(?:cd "\$CLAUDE_PROJECT_DIR" && )?(?:yarn (?:run -T )?)?lore hooks (?:wakeup|autosave|session-end)$/
  const filtered = (existing ?? []).filter(
    (entry) =>
      !entry.hooks?.some((hook) => {
        if (typeof hook.command !== "string") return false
        if (hook.command.endsWith(`/${scriptName}`)) return true
        if (binDispatchPattern.test(hook.command)) return true
        return false
      })
  )
  filtered.push({
    matcher: config.matcher,
    hooks: [
      {
        type: "command",
        command: newCommand,
        ...(config.timeout != null ? { timeout: config.timeout } : {}),
        ...(config.runOnce != null ? { runOnce: config.runOnce } : {}),
      },
    ],
  })
  return filtered
}

export function removeClaudeScriptEntries(
  entries: ClaudeHookEntry[] | undefined,
  scriptName: string
): ClaudeHookEntry[] | undefined {
  if (!entries) return undefined
  const filtered = entries.filter(
    (entry) =>
      !entry.hooks?.some(
        (hook) =>
          typeof hook.command === "string" && hook.command.endsWith(`/${scriptName}`)
      )
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
 * Two historical Lore-owned SessionEnd shapes need to be stripped:
 * the `session-end.sh` registration
 * and the older `autosave.sh`-on-SessionEnd legacy form. Unrelated user
 * hooks on `SessionEnd` are preserved entry-by-entry.
 *
 * Note: cleanup runs at the `ClaudeHookEntry` granularity. A hand-edited
 * settings.json that mixes a Lore-owned and a user-owned hook command in
 * a single `entry.hooks[]` array would lose the sibling on cleanup —
 * Lore's writer never produces that shape, but it's a sharp edge worth
 * being aware of.
 */
export function stripLoreOwnedSessionEndEntries(entries: ClaudeHookEntry[] | undefined): {
  /** Post-cleanup entries, or `undefined` when every entry was Lore-owned. */
  result: ClaudeHookEntry[] | undefined
  /** True when a `session-end.sh` registration was removed. */
  removedShim: boolean
  /** True when a legacy `autosave.sh`-on-SessionEnd registration was removed. */
  removedLegacyAutosave: boolean
} {
  const removedShim = detectClaudeHook(entries, "session-end.sh", "") !== "missing"
  const removedLegacyAutosave = detectClaudeHook(entries, "autosave.sh", "") !== "missing"

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
  binDispatchCommand?: string
): HookStatus {
  if (!entries) return "missing"

  // Same shape-coverage rationale as `detectClaudeHook` — recognize
  // pre-`yarn run -T` bin-dispatch entries as `stale` so the install
  // summary surfaces "update available" before the upsert strips
  // and rewrites them. Codex entries always carry the
  // `LORE_AGENT_NAME=Codex ` env prefix; the strip helper handles
  // any number of leading env assignments.
  const allBinDispatchTails =
    /^(?:yarn (?:run -T )?)?lore hooks (?:wakeup|autosave|session-end)$/

  for (const entry of entries) {
    for (const hook of entry.hooks ?? []) {
      const cmd = hook.command
      if (typeof cmd !== "string") continue
      if (binDispatchCommand && cmd === binDispatchCommand) return "current"
      // Recognize Lore-owned bin-dispatch entries that don't match
      // the desired-write shape — older `yarn lore` form, or any
      // other valid pre-`run -T` shape. Strip the LORE_AGENT_NAME
      // prefix first so the regex sees just the command tail.
      const tail = stripShellEnvPrefix(cmd)
      if (allBinDispatchTails.test(tail)) return "stale"
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
export function mergeCodexHookEntries(
  existing: CodexHookEntry[] | undefined,
  command: string,
  config: { matcher?: string; timeout?: number; statusMessage?: string }
): CodexHookEntry[] {
  const next = [...(existing ?? [])]
  next.push({
    ...(config.matcher ? { matcher: config.matcher } : {}),
    hooks: [
      {
        type: "command",
        command,
        ...(config.timeout != null ? { timeout: config.timeout } : {}),
        ...(config.statusMessage ? { statusMessage: config.statusMessage } : {}),
      },
    ],
  })
  return next
}

/**
 * Remove every Codex hook entry whose command is a Lore-owned
 * bin-dispatch shape — current AND prior — for the given event. The
 * runner needs all variants stripped so flipping between shapes
 * (legacy `.sh` ↔ pre-`run -T` bare ↔ pre-`run -T` yarn ↔ current
 * `yarn run -T`) leaves only the single canonical entry behind.
 *
 * Detection uses the same regex-after-env-prefix-strip approach as
 * `detectCodexHook` so the strip and the detect agree on what
 * counts as Lore-owned.
 */
export function stripCodexBinDispatchHook(
  hooks: Record<string, CodexHookEntry[]>,
  eventName: HookEventName
): Record<string, CodexHookEntry[]> {
  const tailPattern = new RegExp(`^(?:yarn (?:run -T )?)?lore hooks ${eventName}$`)
  const next: Record<string, CodexHookEntry[]> = {}
  for (const [event, entries] of Object.entries(hooks)) {
    const filtered = entries.filter(
      (entry) =>
        !entry.hooks?.some((hook) => {
          if (typeof hook.command !== "string") return false
          const tail = stripShellEnvPrefix(hook.command)
          return tailPattern.test(tail)
        })
    )
    if (filtered.length > 0) next[event] = filtered
  }
  return next
}

function removeCodexScriptEntries(
  entries: CodexHookEntry[] | undefined,
  scriptName: string
): CodexHookEntry[] | undefined {
  if (!entries) return undefined
  const filtered = entries.filter(
    (entry) =>
      !entry.hooks?.some(
        (hook) =>
          typeof hook.command === "string" &&
          commandTargetsScript(hook.command, scriptName)
      )
  )
  return filtered.length > 0 ? filtered : undefined
}

export function stripCodexScriptFromAllEvents(
  hooks: Record<string, CodexHookEntry[]>,
  scriptName: string
): Record<string, CodexHookEntry[]> {
  const next: Record<string, CodexHookEntry[]> = {}
  for (const [eventName, entries] of Object.entries(hooks)) {
    const filtered = removeCodexScriptEntries(entries, scriptName)
    if (filtered) next[eventName] = filtered
  }
  return next
}
