import { describe, expect, it } from "vitest"
import {
  buildProjectSelectionGuidance,
  buildSavePrompt,
  buildSessionEndPrompt,
} from "./prompts.js"

describe("buildProjectSelectionGuidance", () => {
  it("returns empty when no projects are configured", () => {
    expect(buildProjectSelectionGuidance([], null)).toBe("")
  })

  it("lists sub-projects when provided", () => {
    const guidance = buildProjectSelectionGuidance(["Mail Backend", "Mail Web"], null)
    expect(guidance).toContain("Mail Backend, Mail Web")
  })

  it("names the catch-all and warns against defaulting to it", () => {
    const guidance = buildProjectSelectionGuidance(["Mail Backend"], "Mail")
    expect(guidance).toContain(`"Mail"`)
    expect(guidance).toContain("ONLY when the work is genuinely repo-wide")
  })

  it("instructs explicit projectName passing on all save tools", () => {
    const guidance = buildProjectSelectionGuidance(["Mail Backend"], "Mail")
    expect(guidance).toContain("lore-journal")
    expect(guidance).toContain("lore-remember")
    expect(guidance).toContain("lore-learn")
    expect(guidance).toContain("lore-decide")
  })

  it("renders cleanly when only the catch-all is configured", () => {
    const guidance = buildProjectSelectionGuidance([], "Mail")
    expect(guidance).toContain(`"Mail"`)
    // Should not claim there are sub-projects when the list is empty
    expect(guidance).not.toMatch(/sub-projects:\s*\./)
  })
})

describe("buildSavePrompt", () => {
  it("opens with the autosave marker", () => {
    const prompt = buildSavePrompt([], null)
    expect(prompt.startsWith("[Lore auto-save]")).toBe(true)
  })

  it("includes the no-op escape hatch", () => {
    const prompt = buildSavePrompt([], null)
    expect(prompt).toContain(`"No Lore context to save."`)
  })

  it("lists all four save tools", () => {
    const prompt = buildSavePrompt([], null)
    expect(prompt).toContain("lore-journal")
    expect(prompt).toContain("lore-remember")
    expect(prompt).toContain("lore-learn")
    expect(prompt).toContain("lore-decide")
  })

  it("includes field-completeness guidance for lever #2", () => {
    const prompt = buildSavePrompt([], null)
    expect(prompt).toContain("Fill every field you can confidently populate")
    expect(prompt).toContain("kind")
    expect(prompt).toContain("reviewBy")
    expect(prompt).toContain("sourceMemoryId")
  })

  it("injects project guidance when sub-projects exist", () => {
    const prompt = buildSavePrompt(["Mail Backend", "Router"], "Mail")
    expect(prompt).toContain("Mail Backend, Router")
    expect(prompt).toContain(`catch-all "Mail"`)
  })

  it("omits project guidance when the vault has no projects", () => {
    const prompt = buildSavePrompt([], null)
    expect(prompt).not.toContain("catch-all")
    expect(prompt).not.toContain("sub-projects")
  })
})

describe("buildSessionEndPrompt", () => {
  it("opens with the session-end marker and labels the transcript untrusted", () => {
    const prompt = buildSessionEndPrompt([], null, "Session content")
    expect(prompt.startsWith("[Lore session-end save]")).toBe(true)
    expect(prompt).toContain("untrusted session data")
  })

  it("indents the transcript content to visually separate it from instructions", () => {
    const prompt = buildSessionEndPrompt([], null, "line one\nline two")
    expect(prompt).toContain("    line one")
    expect(prompt).toContain("    line two")
  })

  it("lists only tools the session-end sub-agent is actually allowed to call", () => {
    // spawnBackgroundSave allows: lore-journal, lore-remember, lore-learn, lore-decide
    const prompt = buildSessionEndPrompt([], null, "")
    expect(prompt).toContain("lore-journal")
    expect(prompt).toContain("lore-remember")
    expect(prompt).toContain("lore-learn")
    expect(prompt).toContain("lore-decide")
  })

  it("injects project guidance when sub-projects exist", () => {
    const prompt = buildSessionEndPrompt(["Mail Backend"], "Mail", "...")
    expect(prompt).toContain("Mail Backend")
    expect(prompt).toContain(`"Mail"`)
  })
})
