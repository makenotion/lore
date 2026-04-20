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
