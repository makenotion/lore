/**
 * Single source of truth for the hook-disclosure copy that
 * `lore init` and `lore install --client {claude, codex}` both print,
 * and that .lore.example.yaml parallels as a prose block. Centralized
 * here so a typo fix in one surface cannot silently desync the others.
 *
 * Cursor's MCP runtime does not activate Lore's Stop / UserPromptSubmit
 * hooks, so `runCursorInstall` deliberately does NOT print this block
 * — there's nothing to disclose on that host.
 *
 * Fragments (knob list, descriptions, env overrides, privacy framing,
 * docs reference) are exported as constants so tests can pin them; the
 * two assembly helpers (`buildHookDisclosureLines`,
 * `buildHookYamlCommentBefore`) are what production callers use.
 */

/**
 * The four `.lore.yaml > hooks` knobs whose schema default is `true`
 * (`mergeHookDefaults`). Every entry here
 * triggers a background side effect — either a write to the operator's
 * Notion vault, a read from it, or both. Adding a fifth default-true
 * hook in a future change MUST add a row to this table; the test bed
 * compares the table length against `mergeHookDefaults`'s output as a
 * structural guard.
 */
export interface HookDisclosureRow {
  /** `hooks.<name>` knob in .lore.yaml. Used in the disable hint. */
  readonly knob: string
  /** One-sentence description of the side effect. */
  readonly description: string
  /**
   * Optional per-session env-var override. `LORE_AUTOSAVE=false` and
   * friends short-circuit the hook without editing config. Not every
   * hook has one — `wakeUp` is governed by .lore.yaml only.
   */
  readonly envOverride?: string
}

export const HOOK_DISCLOSURE_ROWS: readonly HookDisclosureRow[] = [
  {
    knob: "autoSave",
    description:
      "on assistant Stop, a detached sub-agent writes a session synopsis to your vault as Memory rows.",
    envOverride: "LORE_AUTOSAVE=false",
  },
  {
    knob: "wakeUp",
    description:
      "on session start, fetches recent memories / facts / digest and injects them into the assistant's context.",
  },
  {
    knob: "autoDigest",
    description:
      "after autosave, regenerates the weekly project digest in a detached background spawn.",
    envOverride: "LORE_AUTO_DIGEST=false",
  },
  {
    knob: "learningExtraction",
    description:
      "the autosave sub-agent extracts atomic single-fact learnings from the transcript (up to 5 per save).",
    envOverride: "LORE_DISABLE_LEARNING_EXTRACTION=1",
  },
]

/**
 * Honest description of where data flows. Earlier drafts said "nothing
 * leaves your account" — true for the writes (Memory rows land in the
 * operator's own Notion vault) but misleading about the autosave /
 * learning-extraction LLM call, which sends the transcript to whichever
 * background-agent CLI the operator has configured (Claude API by
 * default, Codex if `LORE_AGENT_NAME=Codex`, or a custom command under
 * `hooks.backgroundAgent.command`).
 */
export const HOOK_PRIVACY_FRAMING =
  "Writes land in your Notion vault; transcript content is sent to your configured background-agent LLM (Claude API by default; Codex if LORE_AGENT_NAME=Codex)."

/** Canonical documentation link surfaced in every disclosure surface. */
export const HOOK_DOCS_REFERENCE = "Full reference: docs/hooks.md."

/**
 * The four-line opt-out instruction. Names the boolean knobs explicitly
 * — an earlier "Set any value below to `false`" implied
 * `saveInterval: false` would work; that's a number in the schema and
 * `false` trips `parseConfigAllowingInvalidHooks` into dropping the
 * entire hooks block, silently re-enabling the very hooks the operator
 * was trying to disable. Mentions the env overrides for the three
 * hooks that have one — `wakeUp` has no env knob, so the line covers
 * what exists rather than implying parity.
 */
export function buildOptOutHint(): string[] {
  const knobs = HOOK_DISCLOSURE_ROWS.map((r) => `hooks.${r.knob}: false`).join(" / ")
  const envs = HOOK_DISCLOSURE_ROWS.flatMap((r) =>
    r.envOverride ? [r.envOverride] : []
  ).join(" / ")
  return [
    `Disable in .lore.yaml with any of: ${knobs}.`,
    `Per-session env overrides: ${envs}.`,
  ]
}

/**
 * Lines printed to stdout by `lore init` (both no-arg and explicit-page
 * paths) and `lore install --client {claude,codex}`. Two-space indent
 * on the bullets matches the existing `Next steps:` / install summary
 * shape; bullets use ASCII `-` because `•` mojibakes on legacy Windows
 * consoles, and the CLI does run on Windows even though the hook
 * runner is POSIX-only.
 */
export function buildHookDisclosureLines(): string[] {
  const knobColumnWidth = Math.max(...HOOK_DISCLOSURE_ROWS.map((r) => r.knob.length))
  const bulletLines = HOOK_DISCLOSURE_ROWS.map(
    (r) => `  - ${r.knob.padEnd(knobColumnWidth)} — ${r.description}`
  )
  return [
    `Default-enabled hooks. ${HOOK_PRIVACY_FRAMING}`,
    ...bulletLines,
    ...buildOptOutHint().map((line) => `  ${line}`),
    `  ${HOOK_DOCS_REFERENCE}`,
  ]
}

/**
 * Multi-line string set on the `hooks:` key's yaml-lib `commentBefore`
 * in `buildInitConfigYaml`. yaml-lib prefixes each line with `# `, so
 * the leading-space convention is load-bearing (a line starting with
 * `-` becomes `#  - autoSave: ...` in output, which is what we want).
 *
 * Output shape differs from `buildHookDisclosureLines` in two ways:
 *   - rendered as a single string with `\n` separators (yaml-lib API),
 *   - bullets indent one less because yaml-lib's `# ` prefix already
 *     adds an indent character.
 */
export function buildHookYamlCommentBefore(): string {
  const lines: string[] = [
    " Background hooks (issue #560 disclosure):",
    ` ${HOOK_PRIVACY_FRAMING}`,
  ]
  for (const row of HOOK_DISCLOSURE_ROWS) {
    lines.push(` - ${row.knob}: ${row.description}`)
  }
  lines.push(
    " - saveInterval: numeric minutes between autosaves in one session",
    "   (positive integer; setting it to `false` is invalid and silently",
    "   falls back to defaults, re-enabling autoSave/wakeUp)."
  )
  for (const line of buildOptOutHint()) {
    lines.push(` ${line}`)
  }
  lines.push(` ${HOOK_DOCS_REFERENCE}`)
  return lines.join("\n")
}
