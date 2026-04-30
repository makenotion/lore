import { describe, expect, it } from "vitest"
import { parseConfigAllowingInvalidHooks } from "./config.js"

describe("parseConfigAllowingInvalidHooks", () => {
  it("preserves a valid hooks section", () => {
    const { config, warnings } = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
hooks:
  wakeUp: false
  saveInterval: 3
`)

    expect(warnings).toEqual([])
    expect(config.hooks).toEqual({ wakeUp: false, saveInterval: 3 })
  })

  it("parses hooks.learningExtraction as a boolean (0.9.0/08)", () => {
    // The 0.9.0 atomic-learning extraction knob lives next to autoSave /
    // wakeUp / autoDigest in the hooks Zod schema. Pin both polarities
    // so a future schema edit that drops the field surfaces here as a
    // failure rather than silently degrading to "always-on".
    const off = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
hooks:
  learningExtraction: false
`)
    expect(off.warnings).toEqual([])
    expect(off.config.hooks).toEqual({ learningExtraction: false })

    const on = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
hooks:
  learningExtraction: true
`)
    expect(on.warnings).toEqual([])
    expect(on.config.hooks).toEqual({ learningExtraction: true })
  })

  it("rejects non-boolean hooks.learningExtraction the same way it rejects other invalid hook flags", () => {
    // Same fail-open posture as the existing wakeUp regression: a
    // typo'd value drops the entire hooks section and warns rather
    // than crashing the helper.
    const { config, warnings } = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
hooks:
  learningExtraction: maybe
`)

    expect(config.vault.pageId).toBe("abc123")
    expect(config.hooks).toBeUndefined()
    expect(warnings).toEqual(["Ignoring invalid hooks config and using hook defaults."])
  })

  it("drops invalid hooks values while keeping the rest of the config", () => {
    const { config, warnings } = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
hooks:
  wakeUp: nope
`)

    expect(config.vault.pageId).toBe("abc123")
    expect(config.hooks).toBeUndefined()
    expect(warnings).toEqual(["Ignoring invalid hooks config and using hook defaults."])
  })

  it("drops the hooks section after YAML parse errors so wake-up fails open", () => {
    const { config, warnings } = parseConfigAllowingInvalidHooks(`
vault:
  pageId: abc123
hooks:
    wakeUp: false
   saveInterval: 5
`)

    expect(config.vault.pageId).toBe("abc123")
    expect(config.hooks).toBeUndefined()
    expect(warnings[0]).toContain("All mapping items must start at the same column")
  })
})
