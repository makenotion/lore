import { describe, expect, it } from "vitest"
import {
  ALLOWED_TOOLS_PLACEHOLDER,
  CODEX_BACKGROUND_ARGS,
  DEFAULT_BACKGROUND_ARGS,
  DEFAULT_BACKGROUND_COMMAND,
  KNOWN_COMMAND_PRESETS,
  mergeHookDefaults,
} from "./config.js"

describe("mergeHookDefaults", () => {
  it("defaults wakeUp, autoSave, autoDigest, and learningExtraction to true when no hooks section is provided", () => {
    const config = mergeHookDefaults(undefined)
    expect(config.wakeUp).toBe(true)
    expect(config.autoSave).toBe(true)
    expect(config.autoDigest).toBe(true)
    expect(config.learningExtraction).toBe(true)
    expect(config.saveInterval).toBe(5)
    expect(config.catchAllName).toBeNull()
    expect(config.subProjects).toEqual([])
  })

  it("respects hooks.learningExtraction: false without affecting autoSave / autoDigest (0.9.0/08)", () => {
    // The atomic-learning extraction knob is orthogonal to autoSave —
    // an operator can keep per-session synopses while pausing
    // learning-fanout if vault noise gets out of hand. Same posture
    // as the autoDigest regression below.
    const config = mergeHookDefaults({ learningExtraction: false })
    expect(config.learningExtraction).toBe(false)
    expect(config.autoSave).toBe(true)
    expect(config.autoDigest).toBe(true)
  })

  it("defaults proposeAutosaveLearnings to false (issue #281, AC #1)", () => {
    // Phase 3 of the proposed-memory inbox epic. Default-off so
    // existing installs see byte-identical autosave behavior — only
    // operators who explicitly opt in via `hooks.proposeAutosaveLearnings: true`
    // route auto-extracted learnings through the review inbox.
    const config = mergeHookDefaults(undefined)
    expect(config.proposeAutosaveLearnings).toBe(false)
  })

  it("respects hooks.proposeAutosaveLearnings: true without affecting other knobs", () => {
    const config = mergeHookDefaults({ proposeAutosaveLearnings: true })
    expect(config.proposeAutosaveLearnings).toBe(true)
    expect(config.learningExtraction).toBe(true)
    expect(config.autoSave).toBe(true)
    expect(config.autoDigest).toBe(true)
  })

  it("respects hooks.autoDigest: false without affecting autoSave", () => {
    const config = mergeHookDefaults({ autoDigest: false })
    expect(config.autoDigest).toBe(false)
    expect(config.autoSave).toBe(true)
  })

  it("respects hooks.wakeUp: false from config", () => {
    const config = mergeHookDefaults({ wakeUp: false })
    expect(config.wakeUp).toBe(false)
  })

  it("respects hooks.wakeUp: true without disturbing other defaults", () => {
    const config = mergeHookDefaults({ wakeUp: true })
    expect(config.wakeUp).toBe(true)
    expect(config.autoSave).toBe(true)
  })

  it("carries the catch-all name and sub-project list through unchanged", () => {
    const config = mergeHookDefaults({ wakeUp: false }, "Widget", ["Widget Backend", "Widget Web"])
    expect(config.catchAllName).toBe("Widget")
    expect(config.subProjects).toEqual(["Widget Backend", "Widget Web"])
    expect(config.wakeUp).toBe(false)
  })

  it("respects hooks.autoSave: false without affecting wakeUp", () => {
    const config = mergeHookDefaults({ autoSave: false })
    expect(config.autoSave).toBe(false)
    expect(config.wakeUp).toBe(true)
  })

  it("uses a non-default saveInterval when configured", () => {
    const config = mergeHookDefaults({ saveInterval: 12 })
    expect(config.saveInterval).toBe(12)
    expect(config.autoSave).toBe(true)
    expect(config.wakeUp).toBe(true)
  })

  describe("backgroundAgent (issue #194)", () => {
    it("defaults to claude -p when no override is provided", () => {
      const config = mergeHookDefaults(undefined, null, [], {})
      expect(config.backgroundAgent.command).toBe(DEFAULT_BACKGROUND_COMMAND)
      expect(config.backgroundAgent.args).toEqual([...DEFAULT_BACKGROUND_ARGS])
      // Sanity-check that the placeholder is in the default args at all —
      // the spawn primitive substitutes it, and removing it from the
      // default would silently drop the allowlist hand-off.
      expect(config.backgroundAgent.args).toContain(ALLOWED_TOOLS_PLACEHOLDER)
    })

    it("honors LORE_BACKGROUND_COMMAND env override on command", () => {
      const config = mergeHookDefaults(undefined, null, [], {
        LORE_BACKGROUND_COMMAND: "codex",
      })
      expect(config.backgroundAgent.command).toBe("codex")
      // Issue #194 follow-up: command-only override picks up the
      // matching preset's args automatically. Without this, `command:
      // codex` would inherit Claude's flag dialect (`-p`,
      // `--allowedTools`, `--model sonnet`) and Codex would reject the
      // flags at spawn time. The `KNOWN_COMMAND_PRESETS` table is what
      // makes the documented common case work.
      expect(config.backgroundAgent.args).toEqual([...CODEX_BACKGROUND_ARGS])
    })

    it("env override beats config override on command", () => {
      const config = mergeHookDefaults(
        { backgroundAgent: { command: "from-config" } },
        null,
        [],
        { LORE_BACKGROUND_COMMAND: "from-env" },
      )
      expect(config.backgroundAgent.command).toBe("from-env")
    })

    it("treats whitespace-only LORE_BACKGROUND_COMMAND as unset", () => {
      const config = mergeHookDefaults(
        { backgroundAgent: { command: "from-config" } },
        null,
        [],
        { LORE_BACKGROUND_COMMAND: "   " },
      )
      expect(config.backgroundAgent.command).toBe("from-config")
    })

    it("honors `.lore.yaml` hooks.backgroundAgent.command override", () => {
      const config = mergeHookDefaults(
        { backgroundAgent: { command: "/opt/codex/bin/codex" } },
        null,
        [],
        {},
      )
      expect(config.backgroundAgent.command).toBe("/opt/codex/bin/codex")
    })

    it("honors `.lore.yaml` hooks.backgroundAgent.args override", () => {
      const customArgs = ["exec", "--full-auto", ALLOWED_TOOLS_PLACEHOLDER]
      const config = mergeHookDefaults(
        { backgroundAgent: { args: customArgs } },
        null,
        [],
        {},
      )
      expect(config.backgroundAgent.args).toEqual(customArgs)
    })

    it("returns a fresh args array so callers can mutate without affecting the default", () => {
      const a = mergeHookDefaults(undefined, null, [], {})
      const b = mergeHookDefaults(undefined, null, [], {})
      a.backgroundAgent.args.push("--mutated")
      expect(b.backgroundAgent.args).not.toContain("--mutated")
    })

    describe("KNOWN_COMMAND_PRESETS", () => {
      it("picks up the codex preset on `command: codex` without args", () => {
        // The dominant override case for Codex-only operators. Without
        // a preset path the command-only override would inherit
        // Claude's `-p --allowedTools ... --model sonnet` shape and
        // Codex would reject the flags at spawn time. This is the
        // blocking fix called out in PR #211 review.
        const config = mergeHookDefaults(
          { backgroundAgent: { command: "codex" } },
          null,
          [],
          {},
        )
        expect(config.backgroundAgent.args).toEqual([...CODEX_BACKGROUND_ARGS])
        // Sanity: the codex preset deliberately omits the
        // `{{allowedTools}}` placeholder because Codex's `exec` mode
        // doesn't accept an allowlist flag — operators configure that
        // out-of-band via `.codex/config.toml`.
        expect(config.backgroundAgent.args).not.toContain(
          ALLOWED_TOOLS_PLACEHOLDER,
        )
      })

      it("picks up the codex preset via env override too", () => {
        // Same path as the yaml-override case but driven by env. Pinned
        // separately because the env path bypasses the yaml struct and
        // could regress independently.
        const config = mergeHookDefaults(undefined, null, [], {
          LORE_BACKGROUND_COMMAND: "codex",
        })
        expect(config.backgroundAgent.args).toEqual([...CODEX_BACKGROUND_ARGS])
      })

      it("picks up the claude preset on explicit `command: claude` (parity with default)", () => {
        const config = mergeHookDefaults(
          { backgroundAgent: { command: "claude" } },
          null,
          [],
          {},
        )
        expect(config.backgroundAgent.args).toEqual([...DEFAULT_BACKGROUND_ARGS])
      })

      it("falls through to Claude-shaped defaults for unknown commands without args", () => {
        // An operator on `command: claude-next` (a hypothetical claude
        // rebrand) keeps Claude's flag dialect — this is the
        // back-compat behavior. The install-time path warns about
        // unknown commands so the operator sees the mismatch before
        // runtime.
        const config = mergeHookDefaults(
          { backgroundAgent: { command: "claude-next" } },
          null,
          [],
          {},
        )
        expect(config.backgroundAgent.args).toEqual([...DEFAULT_BACKGROUND_ARGS])
      })

      it("explicit `args` override always wins over the preset", () => {
        // The opt-out: an operator who supplies `args` explicitly gets
        // their shape verbatim, even when `command` matches a preset.
        // This lets a Codex operator pin a custom flag spelling (e.g.
        // an older Codex version with different args) without losing
        // the redirect.
        const customArgs = ["my-custom-flag", "value"]
        const config = mergeHookDefaults(
          { backgroundAgent: { command: "codex", args: customArgs } },
          null,
          [],
          {},
        )
        expect(config.backgroundAgent.args).toEqual(customArgs)
      })

      it("absolute-path commands match presets by basename (PR review fix)", () => {
        // The reviewer caught an absolute-path preset miss: an operator
        // on `command: /opt/homebrew/bin/codex` (or `LORE_BACKGROUND_COMMAND=
        // /usr/local/bin/codex`) MUST pick up the codex preset.
        // Absolute paths are a common way to survive hook environments
        // with a minimal `PATH`, and exact-string matching would
        // silently let a Codex operator pinning their absolute path
        // inherit Claude flags. Basename matching is the fix.
        const config = mergeHookDefaults(
          { backgroundAgent: { command: "/opt/homebrew/bin/codex" } },
          null,
          [],
          {},
        )
        expect(config.backgroundAgent.args).toEqual([...CODEX_BACKGROUND_ARGS])
        // Confirm it works for the env-override path too.
        const envConfig = mergeHookDefaults(undefined, null, [], {
          LORE_BACKGROUND_COMMAND: "/usr/local/bin/codex",
        })
        expect(envConfig.backgroundAgent.args).toEqual([...CODEX_BACKGROUND_ARGS])
      })

      it("absolute paths to unknown binaries still fall through to Claude defaults", () => {
        // Basename matching applies only to known presets. An operator
        // on an unrecognized binary (`/opt/local/bin/aider`) keeps the
        // Claude-shaped fallthrough, plus the install-time warning.
        const config = mergeHookDefaults(
          { backgroundAgent: { command: "/opt/local/bin/aider" } },
          null,
          [],
          {},
        )
        expect(config.backgroundAgent.args).toEqual([...DEFAULT_BACKGROUND_ARGS])
      })

      it("preset table includes claude and codex (acceptance criterion)", () => {
        // Pin the preset surface so adding/removing a preset is an
        // explicit test change, not an unobserved behavior shift.
        expect(Object.keys(KNOWN_COMMAND_PRESETS).sort()).toEqual([
          "claude",
          "codex",
        ])
      })
    })

    describe("agent-context-derived default (PR review fix)", () => {
      // Codex installs prefix every hook command with
      // `LORE_AGENT_NAME=Codex `. The runtime resolver consults that env
      // to derive `command: codex` automatically — Codex-only operators
      // get a working background-agent setup without per-project
      // `.lore.yaml` or `LORE_BACKGROUND_COMMAND` setup.

      it("derives `command: codex` from `LORE_AGENT_NAME=Codex` (the Codex hook prefix)", () => {
        const config = mergeHookDefaults(undefined, null, [], {
          LORE_AGENT_NAME: "Codex",
        })
        expect(config.backgroundAgent.command).toBe("codex")
        // The codex preset's args follow automatically — full pipeline
        // through the basename-aware preset lookup.
        expect(config.backgroundAgent.args).toEqual([...CODEX_BACKGROUND_ARGS])
      })

      it("explicit override beats LORE_AGENT_NAME derivation (LORE_BACKGROUND_COMMAND wins)", () => {
        // Operator's shell-rc-exported override is tier 1 — wins over
        // the tier-3 derivation. Lets a Codex user temporarily switch
        // the background agent without touching the host's hook setup.
        const config = mergeHookDefaults(undefined, null, [], {
          LORE_AGENT_NAME: "Codex",
          LORE_BACKGROUND_COMMAND: "claude",
        })
        expect(config.backgroundAgent.command).toBe("claude")
      })

      it("explicit override beats LORE_AGENT_NAME derivation (yaml command wins)", () => {
        // `.lore.yaml` is tier 2 — wins over the tier-3 derivation.
        // Lets a Codex project commit a custom override (e.g. an
        // alternate Codex install path) without depending on env.
        const config = mergeHookDefaults(
          { backgroundAgent: { command: "claude" } },
          null,
          [],
          { LORE_AGENT_NAME: "Codex" },
        )
        expect(config.backgroundAgent.command).toBe("claude")
      })

      it("Claude Code installs (no LORE_AGENT_NAME) get the historical claude default", () => {
        // The dominant case: Claude Code doesn't set `LORE_AGENT_NAME`
        // (it relies on `CLAUDECODE=1` / `CLAUDE_CODE_*` markers, which
        // `mergeHookDefaults` doesn't read for command derivation).
        // Falls through to the historical `claude` default — back-compat
        // preserved byte-for-byte.
        const config = mergeHookDefaults(undefined, null, [], {
          CLAUDECODE: "1",
        })
        expect(config.backgroundAgent.command).toBe("claude")
      })

      it("unrecognized LORE_AGENT_NAME falls through to claude default", () => {
        // An operator setting `LORE_AGENT_NAME=Cursor` (or any other
        // value not in `AGENT_BACKGROUND_COMMAND`) doesn't get a
        // derivation — they fall through to the historical `claude`
        // default and the install-time warning catches the mismatch.
        const config = mergeHookDefaults(undefined, null, [], {
          LORE_AGENT_NAME: "Cursor",
        })
        expect(config.backgroundAgent.command).toBe("claude")
      })

      it("treats whitespace-only LORE_AGENT_NAME as unset", () => {
        // Whitespace-only must not pollute the canonicalization step
        // (which runs `trim()` first). Explicit guard prevents a
        // ` Codex ` value spuriously matching the preset.
        const config = mergeHookDefaults(undefined, null, [], {
          LORE_AGENT_NAME: "   ",
        })
        expect(config.backgroundAgent.command).toBe("claude")
      })
    })
  })
})
