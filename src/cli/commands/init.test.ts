/**
 * Tests for the pure `.lore.yaml`-emit helper used by `lore init`. The
 * Notion-touching command path itself is not exercised here — these tests
 * pin the format of the freshly emitted config so a regression in
 * `learningExtraction`'s commented-default placement (issue 0.9.0/08)
 * surfaces here rather than in the wild.
 */
import { describe, expect, it } from "vitest"
import { parse as yamlParse } from "yaml"
import { buildInitConfigYaml } from "./init.js"

describe("buildInitConfigYaml", () => {
  it("emits a parseable YAML document with the expected top-level shape", () => {
    const text = buildInitConfigYaml("abc123")
    const parsed = yamlParse(text)
    expect(parsed).toEqual({
      vault: { pageId: "abc123" },
      projects: [],
      hooks: {
        autoSave: true,
        wakeUp: true,
        saveInterval: 5,
      },
    })
  })

  it("includes the learningExtraction commented-default line under hooks: (0.9.0/08)", () => {
    const text = buildInitConfigYaml("abc123")
    // Pin the exact line so the indentation, comment marker, and 0.9.0/08
    // attribution can't drift silently. Two-space indent matches the
    // hooks block; the leading `#` is what hides the line from the YAML
    // parser. The trailing `\n` is part of the line.
    expect(text).toContain(
      "  # learningExtraction: true  # 0.9.0/08 — autosave atomic-learning extraction\n",
    )
  })

  it("places the learningExtraction comment AFTER the saveInterval entry inside hooks", () => {
    // Order is contract: an operator scanning the hooks: block reads
    // the active settings first, then the commented opt-out. Snapshotting
    // the slice from `hooks:` to the comment defends against a future
    // reordering that would land the comment above the active fields.
    const text = buildInitConfigYaml("abc123")
    const hooksIdx = text.indexOf("hooks:")
    const saveIntervalIdx = text.indexOf("saveInterval: 5")
    const commentIdx = text.indexOf("# learningExtraction:")
    expect(hooksIdx).toBeGreaterThan(-1)
    expect(saveIntervalIdx).toBeGreaterThan(hooksIdx)
    expect(commentIdx).toBeGreaterThan(saveIntervalIdx)
  })

  it("emits a YAML document whose comment-stripped re-parse matches the typed shape", () => {
    // Defense against a future yaml-lib upgrade that changes how
    // `YAMLMap.comment` renders: if the comment somehow leaks into the
    // active config (e.g. wrong escape, missing `#`), `yamlParse` would
    // either throw or return an extra `learningExtraction` key. Both
    // would fail this assertion.
    const text = buildInitConfigYaml("abc123")
    const parsed = yamlParse(text) as { hooks: Record<string, unknown> }
    expect(parsed.hooks).not.toHaveProperty("learningExtraction")
    expect(Object.keys(parsed.hooks).sort()).toEqual([
      "autoSave",
      "saveInterval",
      "wakeUp",
    ])
  })
})
