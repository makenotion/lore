/**
 * Tests for the shared hook-disclosure module (PR #567 round-2). The
 * production callers (`commands/init.ts` and `commands/install.ts`)
 * each have their own end-to-end coverage; this file pins the module's
 * own invariants — fragment coverage, structural drift guards against
 * `mergeHookDefaults`, and the `.lore.example.yaml` cross-check that
 * keeps the static file in sync with the runtime strings.
 */
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  HOOK_DISCLOSURE_ROWS,
  HOOK_DOCS_REFERENCE,
  HOOK_PRIVACY_FRAMING,
  buildHookDisclosureLines,
  buildHookYamlCommentBefore,
  buildOptOutHint,
} from "./hook-disclosure.js"
import { mergeHookDefaults } from "../hooks/config.js"

const HERE = dirname(fileURLToPath(import.meta.url))
// Repo root sits three levels up from src/cli/.
const REPO_ROOT = join(HERE, "..", "..")

describe("HOOK_DISCLOSURE_ROWS", () => {
  it("covers every default-true hook in mergeHookDefaults (structural drift guard)", () => {
    // The table is the source of truth for which knobs appear in the
    // disclosure; if `mergeHookDefaults` adds a fifth default-true
    // hook without updating this table, the disclosure silently
    // omits a side-effecting code path. The reverse must also hold:
    // listing a row whose mergeHookDefaults default is `false` would
    // mis-advertise the actual install posture.
    const defaults = mergeHookDefaults({})
    const trueDefaults = (Object.keys(defaults) as (keyof typeof defaults)[]).filter(
      (key) => defaults[key] === true
    )
    const tableKnobs = HOOK_DISCLOSURE_ROWS.map((r) => r.knob).sort()
    expect(tableKnobs).toEqual(trueDefaults.sort())
  })

  it("supplies env overrides for autoSave / autoDigest / learningExtraction", () => {
    // `wakeUp` is intentionally missing — there's no env knob for
    // it; the .lore.yaml flag is the only off-switch. The other
    // three have widely-used env overrides (autosave runs use
    // `LORE_AUTOSAVE=false`; auto-digest spawns honor
    // `LORE_AUTO_DIGEST=false`; learning extraction has
    // `LORE_DISABLE_LEARNING_EXTRACTION=1`).
    const byKnob = Object.fromEntries(HOOK_DISCLOSURE_ROWS.map((r) => [r.knob, r]))
    expect(byKnob["autoSave"]?.envOverride).toBe("LORE_AUTOSAVE=false")
    expect(byKnob["autoDigest"]?.envOverride).toBe("LORE_AUTO_DIGEST=false")
    expect(byKnob["learningExtraction"]?.envOverride).toBe(
      "LORE_DISABLE_LEARNING_EXTRACTION=1"
    )
    expect(byKnob["wakeUp"]?.envOverride).toBeUndefined()
  })
})

describe("buildOptOutHint", () => {
  it("returns two lines: the in-config knobs and the per-session env knobs", () => {
    const lines = buildOptOutHint()
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^Disable in \.lore\.yaml with any of:/)
    expect(lines[1]).toMatch(/^Per-session env overrides:/)
  })

  it("the in-config hint names every boolean knob and never names saveInterval", () => {
    // PR #567 review: saveInterval is numeric; including it in the
    // disable hint would silently invalidate the entire hooks block
    // if an operator literally types `saveInterval: false`.
    const [inConfigLine] = buildOptOutHint()
    for (const row of HOOK_DISCLOSURE_ROWS) {
      expect(inConfigLine).toContain(`hooks.${row.knob}: false`)
    }
    expect(inConfigLine).not.toContain("saveInterval")
  })
})

describe("buildHookDisclosureLines (stdout shape)", () => {
  it("first line carries the privacy framing", () => {
    const [first] = buildHookDisclosureLines()
    expect(first).toContain(HOOK_PRIVACY_FRAMING)
  })

  it("emits one bullet line per default-true hook with ASCII `-` bullets", () => {
    const lines = buildHookDisclosureLines()
    const bulletLines = lines.filter((l) => /^\s*-\s/.test(l))
    expect(bulletLines).toHaveLength(HOOK_DISCLOSURE_ROWS.length)
    for (const row of HOOK_DISCLOSURE_ROWS) {
      const matched = bulletLines.find((l) => l.includes(row.knob))
      expect(matched, `expected a bullet line naming ${row.knob}`).toBeDefined()
    }
    // No mojibake-prone glyphs.
    for (const line of lines) {
      expect(line).not.toContain("•")
    }
  })

  it("ends with the canonical docs reference", () => {
    const lines = buildHookDisclosureLines()
    expect(lines[lines.length - 1]).toContain(HOOK_DOCS_REFERENCE)
  })
})

describe("buildHookYamlCommentBefore (yaml-lib commentBefore shape)", () => {
  it("uses leading-space convention so yaml-lib renders one `#` per line", () => {
    const text = buildHookYamlCommentBefore()
    for (const line of text.split("\n")) {
      // Every line must start with at least one space — yaml-lib
      // prepends `#` and a content separator. A line starting
      // without leading whitespace would render as a bare `#text`
      // (unconventional comment glyph) and might fail downstream
      // parsing on stricter yaml consumers.
      expect(line.startsWith(" ")).toBe(true)
    }
  })

  it("describes saveInterval as numeric and explicitly invalid for `false`", () => {
    // Round-1 review: an operator who maps the boolean opt-out
    // pattern onto saveInterval breaks their entire hooks block.
    // Round-2 keeps the explicit "false is invalid" wording in the
    // generated config too.
    const text = buildHookYamlCommentBefore()
    expect(text).toContain("- saveInterval: numeric minutes")
    expect(text).toContain("setting it to `false` is invalid")
  })

  it("names every default-true hook and every env override", () => {
    const text = buildHookYamlCommentBefore()
    for (const row of HOOK_DISCLOSURE_ROWS) {
      expect(text).toContain(`- ${row.knob}:`)
      if (row.envOverride) {
        expect(text).toContain(row.envOverride)
      }
    }
  })
})

describe(".lore.example.yaml mirrors the shared module (cross-file drift guard)", () => {
  it("includes every default-true hook description by knob name", async () => {
    // The static example file can't import the runtime module, so
    // this test enforces lockstep: every knob from the canonical
    // table must surface in the example yaml. A future copy edit
    // that drops `autoDigest` from the example fails this test
    // loudly.
    const examplePath = join(REPO_ROOT, ".lore.example.yaml")
    const example = await readFile(examplePath, "utf-8")
    for (const row of HOOK_DISCLOSURE_ROWS) {
      expect(example, `expected .lore.example.yaml to name ${row.knob}`).toContain(
        `- ${row.knob}:`
      )
    }
  })

  it("includes every env-override knob and the docs reference", async () => {
    const examplePath = join(REPO_ROOT, ".lore.example.yaml")
    const example = await readFile(examplePath, "utf-8")
    for (const row of HOOK_DISCLOSURE_ROWS) {
      if (row.envOverride) {
        expect(example).toContain(row.envOverride)
      }
    }
    expect(example).toContain("docs/hooks.md")
  })
})
