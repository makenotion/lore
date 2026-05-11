/**
 * Agent identity canonicalization (PF3-02).
 *
 * `deriveAgentName` (in `helpers.ts`) infers the saving agent from runtime
 * markers — `CLAUDECODE=1`, `CLAUDE_CODE_*` env vars, or an explicit
 * `LORE_AGENT_NAME` override. The inference path has produced eight different
 * spellings of the same Claude Code instance in the wild (`Claude Code`,
 * `claude-code`, `Claude Opus 4.7 (1M context)`, `claude-opus-4-7`, …),
 * fragmenting the `Agent` column on saved memories so per-agent grouping,
 * retention queries, and dashboards split each Claude session across
 * multiple buckets.
 *
 * `canonicalizeAgentName` collapses every observed Claude variant onto the
 * single canonical string `"Claude Code"`. Anything that doesn't match the
 * Claude pattern — including third-party names like `Codex`, `Cline`, or
 * `Cursor` set explicitly via `LORE_AGENT_NAME` — is returned unchanged so
 * the explicit-over-inferred contract from PF1-04 stays intact.
 *
 * This module is the canonical-table source for both:
 * - the write-time wrap inside `deriveAgentName` (so new memories never
 *   re-fragment), and
 * - the `lore migrate --normalize-agents` backfill that rewrites historical
 *   Agent strings to their canonical form.
 */

/**
 * Pattern for the Claude variant family. Operates on a *normalized* form
 * (whitespace + hyphens collapsed to single spaces, lowercased) so the
 * grammar doesn't have to enumerate every separator combination. The shape
 * requires *at least one* discriminator beyond bare `claude` so that an
 * integrator running a wrapper agent literally named `"Claude"` doesn't
 * silently get re-attributed to `"Claude Code"` — the explicit-override
 * contract from PF1-04 must beat inference even for ambiguous brand names.
 *
 * The matched language is exactly:
 *   claude code [ opus N(.M)?( K)? ] [ (...) ]
 *   claude opus N(.M)?( K)? [ (...) ]
 *
 * Adding entries: only when a new *default-detection* variant appears in the
 * wild (i.e. another Claude string we ourselves produce). Third-party
 * integrations carry their own `LORE_AGENT_NAME` and should not be added —
 * the explicit-override path is their canonical source.
 *
 * **Future Anthropic model families.** This regex is deliberately scoped
 * to `code` and `opus`-versioned variants — the only spellings observed in
 * the internal vault (PF3-02 audit, April 2026). When Anthropic
 * ships a model family Claude Code can route to (Sonnet, Haiku, or any
 * three-component version like `Claude Opus 4.7.1`), autosave will start
 * producing `claude-sonnet-4-5` / `Claude Haiku 4 (1M context)` style
 * strings that this regex *intentionally* leaves unchanged. The extension
 * recipe at that point is:
 *
 *   1. Add the new family to the alternation, e.g.
 *      `code(...)|opus \d+...|sonnet \d+...|haiku \d+...`. Mirror the
 *      `\d+(?:\.\d+)?(?: \d+)?` shape so dotted and hyphen-split versions
 *      both match.
 *   2. Pin the new variants in `agent-identity.test.ts` under both the
 *      collapsing-set and the no-over-match block (e.g. `claude sonnet`
 *      without a version stays passthrough — same rule as `claude opus`).
 *   3. Re-run `lore migrate --normalize-agents --dry-run` against the
 *      production vault to surface the new variant counts; document the
 *      observed spellings in this comment so the next maintainer has the
 *      same audit trail.
 *
 * The closed-table discipline is what keeps the regex auditable; widening
 * it pre-emptively to a `claude (?:\w+).*` shape would let a third-party
 * `"Claude Forge"` agent silently lose attribution.
 */
const CLAUDE_VARIANTS =
  /^claude (?:code(?: opus \d+(?:\.\d+)?(?: \d+)?)?|opus \d+(?:\.\d+)?(?: \d+)?)(?: \(.*\))?$/

/**
 * Canonical Claude Code agent string. Exported so callers (e.g. test fixtures
 * that filter internal-vault memories by agent) can reference one source of truth
 * rather than re-spelling the literal.
 */
export const CANONICAL_CLAUDE_CODE = "Claude Code"

/**
 * Map a stored or inferred agent string to its canonical form.
 *
 * **Scope: Claude default-detection variants only.** The function name is
 * generic but the canonical table is narrow — only the messy Claude
 * spellings we ourselves produce get rewritten. Third-party agents
 * (`Codex`, `Cline`, `Cursor`, …) pass through by design so the PF1-04
 * explicit-over-inferred contract stays intact. Do not extend this
 * function with non-Claude rules — those belong on the integrator's
 * `LORE_AGENT_NAME` setup, not here.
 *
 * - The seven internal-vault Claude variants from the PF3-02 audit, plus the
 *   bare-version eighth (`Claude Opus 4.7` without a parenthetical),
 *   collapse to `"Claude Code"`.
 * - Empty / whitespace-only input → returned trimmed (callers treat the
 *   empty string as "no agent recorded" the same way `deriveAgentName`
 *   returns `undefined`).
 * - Anything else passes through unchanged.
 *
 * Idempotent: `canonicalizeAgentName(canonicalizeAgentName(x)) === canonicalizeAgentName(x)`.
 */
export function canonicalizeAgentName(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return trimmed
  // Collapse separators for matching only — the original is what we return
  // when the pattern doesn't match.
  const normalized = trimmed.toLowerCase().replace(/[\s-]+/g, " ").trim()
  if (CLAUDE_VARIANTS.test(normalized)) return CANONICAL_CLAUDE_CODE
  return trimmed
}
