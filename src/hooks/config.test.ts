import { describe, expect, it } from "vitest"
import { mergeHookDefaults } from "./config.js"

describe("mergeHookDefaults", () => {
  it("defaults wakeUp and autoSave to true when no hooks section is provided", () => {
    const config = mergeHookDefaults(undefined)
    expect(config.wakeUp).toBe(true)
    expect(config.autoSave).toBe(true)
    expect(config.saveInterval).toBe(5)
    expect(config.catchAllName).toBeNull()
    expect(config.subProjects).toEqual([])
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
    const config = mergeHookDefaults({ wakeUp: false }, "Mail", ["Mail Backend", "Mail Web"])
    expect(config.catchAllName).toBe("Mail")
    expect(config.subProjects).toEqual(["Mail Backend", "Mail Web"])
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
})
