import { describe, expect, it } from "vitest"
import { buildProjectSelectionGuidance, buildSessionEndPrompt } from "./prompts.js"

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

  it("instructs explicit projectName passing on the save tools that remain in the prompt", () => {
    const guidance = buildProjectSelectionGuidance(["Mail Backend"], "Mail")
    expect(guidance).toContain("lore-remember")
    expect(guidance).toContain("lore-learn")
    expect(guidance).toContain("lore-decide")
    // lore-journal is soft-deprecated and no longer invited from the prompt.
    expect(guidance).not.toContain("lore-journal")
  })

  it("renders cleanly when only the catch-all is configured", () => {
    const guidance = buildProjectSelectionGuidance([], "Mail")
    expect(guidance).toContain(`"Mail"`)
    // Should not claim there are sub-projects when the list is empty
    expect(guidance).not.toMatch(/sub-projects:\s*\./)
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
    // spawnBackgroundSave allows: lore-journal, lore-remember, lore-learn, lore-decide.
    // The prompt itself only invites the three non-deprecated writers.
    const prompt = buildSessionEndPrompt([], null, "")
    expect(prompt).toContain("lore-remember")
    expect(prompt).toContain("lore-learn")
    expect(prompt).toContain("lore-decide")
    expect(prompt).not.toContain("lore-journal")
  })

  it("injects project guidance when sub-projects exist", () => {
    const prompt = buildSessionEndPrompt(["Mail Backend"], "Mail", "...")
    expect(prompt).toContain("Mail Backend")
    expect(prompt).toContain(`"Mail"`)
  })

  it("forbids session narration explicitly", () => {
    const prompt = buildSessionEndPrompt([], null, "")
    expect(prompt).toContain("not logging the session")
    expect(prompt).toContain("Do not paraphrase the session")
  })

  it("renders the session id and agent name when supplied", () => {
    const prompt = buildSessionEndPrompt([], null, "transcript", "sess-xyz", "Codex")
    expect(prompt).toContain("Session ID: sess-xyz")
    expect(prompt).toContain("Agent: Codex")
    expect(prompt).toContain(`session: "sess-xyz"`)
    expect(prompt).toContain(`agent: "Codex"`)
  })

  it("omits the identity block when no session/agent are supplied", () => {
    const prompt = buildSessionEndPrompt([], null, "transcript")
    expect(prompt).not.toContain("Session ID:")
    expect(prompt).not.toContain("Agent:")
  })

  it("places the identity block before the extraction filter", () => {
    const prompt = buildSessionEndPrompt([], null, "transcript", "sess-xyz", "Codex")
    const identityIdx = prompt.indexOf("Session ID:")
    const filterIdx = prompt.indexOf("You are not logging")
    expect(identityIdx).toBeGreaterThan(-1)
    expect(filterIdx).toBeGreaterThan(-1)
    expect(identityIdx).toBeLessThan(filterIdx)
  })
})
