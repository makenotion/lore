/**
 * Tests for the agent-identity canonicalizer (PF3-02).
 *
 * Pins the eight internal-vault variants to a single canonical string and the
 * PF1-04 explicit-override contract for third-party agents. A regression in
 * either direction would re-fragment the `Agent` column or steamroll a
 * deliberately-set integrator name — both visibly bad outcomes.
 */
import { describe, expect, it } from "vitest"
import { CANONICAL_CLAUDE_CODE, canonicalizeAgentName } from "./agent-identity.js"

describe("canonicalizeAgentName", () => {
  describe("internal-vault Claude variants collapse to Claude Code", () => {
    // PF3-02's spec lists seven variants observed on an internal-vault
    // memories (see /Phase-3-Followups/PF3-02-agent-identity-normalization.md).
    // The eighth — bare-version `Claude Opus 4.7` without a parenthetical —
    // isn't in the spec's bullet list but the regex grammar already covers it,
    // so it's pinned here as a stake-in-the-ground: the canonicalizer accepts
    // bare-version cousins of the spec's parenthesized form, and a regression
    // that started passing them through unchanged would be a real fragmentation
    // bug. Production `--dry-run` against an internal vault confirms 20 memories
    // with non-canonical Agent strings, all 7 spec'd variants present.
    const claudeVariants = [
      "Claude Code",
      "claude-code",
      "Claude Opus 4.7 (1M context)",
      "Claude Code (Opus 4.7)",
      "claude-opus-4.7",
      "claude-opus-4-7",
      "claude-code-opus-4-7",
      "Claude Opus 4.7",
    ]

    for (const variant of claudeVariants) {
      it(`canonicalizes "${variant}" → ${CANONICAL_CLAUDE_CODE}`, () => {
        expect(canonicalizeAgentName(variant)).toBe(CANONICAL_CLAUDE_CODE)
      })
    }

    it("collapses every observed variant onto exactly one bucket", () => {
      const distinctBuckets = new Set(claudeVariants.map(canonicalizeAgentName))
      expect(distinctBuckets.size).toBe(1)
      expect(distinctBuckets).toContain(CANONICAL_CLAUDE_CODE)
    })

    // `Claude Code ()` and `Claude Opus 4.7 ()` are produced only by a busted
    // detection path (an empty parenthetical context suffix), but the regex's
    // `(?: \(.*\))?` clause matches `()` because `.*` accepts empty content.
    // Pin each case as its own `it()` so the test report names the exact
    // variant on regression, matching the per-case style used by the
    // collapsing-set and no-over-match blocks above.
    const emptyParens = ["Claude Code ()", "claude code ()", "Claude Opus 4.7 ()"]
    for (const variant of emptyParens) {
      it(`collapses "${variant}" → ${CANONICAL_CLAUDE_CODE} (empty parenthetical)`, () => {
        expect(canonicalizeAgentName(variant)).toBe(CANONICAL_CLAUDE_CODE)
      })
    }

    it("is idempotent — canonicalizing the canonical form is a no-op", () => {
      expect(canonicalizeAgentName(CANONICAL_CLAUDE_CODE)).toBe(CANONICAL_CLAUDE_CODE)
      // Double-canonicalization equals single-canonicalization for every
      // observed variant; a regression here would mean the canonical form
      // itself drifts on re-write.
      for (const variant of claudeVariants) {
        const once = canonicalizeAgentName(variant)
        expect(canonicalizeAgentName(once)).toBe(once)
      }
    })
  })

  describe("explicit LORE_AGENT_NAME overrides pass through unchanged (PF1-04 contract)", () => {
    // The acceptance criterion calls these out by name — third-party
    // integrators set them via `LORE_AGENT_NAME=Codex`/`Cline` and the
    // canonicalizer must not eat them. A regression that started rewriting
    // these would be the explicit-over-inferred contract violation PF1-04
    // shipped to fix.
    const passthroughs = [
      "Codex",
      "Cline",
      "Cursor",
      "Aider",
      "windsurf",
      // Single-word, custom integrator names that *contain* the substring
      // "claude" but aren't the Claude Code instance. The regex is anchored
      // and structured, so names like these stay verbatim.
      "Claudette",
      "claudette-hooks",
      "ClaudiaAI",
      "ClaudeForge",
      "anti-claude-bot",
    ]

    for (const name of passthroughs) {
      it(`leaves "${name}" unchanged`, () => {
        expect(canonicalizeAgentName(name)).toBe(name)
      })
    }
  })

  describe("trim and empty-input behavior", () => {
    it("trims surrounding whitespace before matching", () => {
      expect(canonicalizeAgentName("  Claude Code  ")).toBe(CANONICAL_CLAUDE_CODE)
      expect(canonicalizeAgentName("\tclaude-code\n")).toBe(CANONICAL_CLAUDE_CODE)
    })

    it("preserves the trim on passthrough inputs (no surrounding whitespace ever returned)", () => {
      expect(canonicalizeAgentName("  Codex  ")).toBe("Codex")
    })

    it("returns the empty string for empty / whitespace-only input", () => {
      expect(canonicalizeAgentName("")).toBe("")
      expect(canonicalizeAgentName("   ")).toBe("")
      expect(canonicalizeAgentName("\t\n")).toBe("")
    })
  })

  describe("does not over-match adjacent strings", () => {
    // Each of these starts with `claude` but carries an unrelated suffix
    // outside the variant grammar — they must pass through. The risk in a
    // looser regex is silently relabelling these as `Claude Code`, which
    // would corrupt agent attribution for any future integration whose
    // naming convention overlaps.
    const noMatch = [
      "claude-code-cli",
      "claude code v2",
      "claude proxy",
      "claude-code-bot",
      "Claude-Bot-1",
      "claude-pilot",
      // The ambiguous bare-brand cases — these are explicitly *not*
      // collapsed because an integrator named `"Claude"` (the brand) must
      // not lose attribution to the Claude Code instance. Same rationale
      // for `"Claude Opus"` without a version: it could be a wrapper agent
      // that uses the Opus model name as its identifier.
      "Claude",
      "claude",
      "Claude Opus",
      "claude opus",
      // Empty parenthetical — the canonicalizer's parenthetical clause
      // accepts arbitrary content but only after `code` or `opus N`. Bare
      // `claude ()` has no discriminator and stays as-is.
      "claude ()",
      "Claude ()",
    ]
    for (const name of noMatch) {
      it(`leaves "${name}" unchanged`, () => {
        expect(canonicalizeAgentName(name)).toBe(name)
      })
    }
  })

  describe("future Anthropic model families pass through (extension recipe in agent-identity.ts)", () => {
    // The closed table is `code` and `opus`-versioned variants only. When
    // Anthropic ships a new model family that Claude Code routes to,
    // autosave will start producing strings these tests pin as passthrough.
    // A regression here means an over-eager regex started silently
    // re-attributing a non-spec'd variant — but the *intended* fix when a
    // family ships is to extend the regex AND update these tests in lockstep
    // (see the "Future Anthropic model families" comment at the top of
    // agent-identity.ts for the extension recipe).
    const futureFamilies = [
      "claude-sonnet-4-5",
      "Claude Sonnet 4.5 (1M context)",
      "claude-haiku-4",
      "Claude Haiku 4",
      // Three-component versions — current regex is N(.M)?( K)? so a
      // `4.7.1` style version is out of grammar.
      "Claude Opus 4.7.1",
      "claude-opus-4-7-1",
      // Internal model IDs that Anthropic uses in API headers — passthrough
      // because they're not user-facing Agent strings, but pin them so a
      // future maintainer who sees one in the wild has a fixture to align to.
      "claude-3-5-sonnet-20241022",
    ]
    for (const name of futureFamilies) {
      it(`leaves "${name}" unchanged (extend the regex when this family ships)`, () => {
        expect(canonicalizeAgentName(name)).toBe(name)
      })
    }
  })
})
