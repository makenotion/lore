import { describe, expect, it } from "vitest"
import { subjectToTopicKey } from "./memory-subject.js"

describe("subjectToTopicKey", () => {
  it("maps a plain subject to the state topic-key family", () => {
    expect(subjectToTopicKey("auth")).toBe("state/auth")
  })

  it("normalizes multi-word subjects into stable ASCII slugs", () => {
    expect(subjectToTopicKey("Lore PAT auth")).toBe("state/lore-pat-auth")
    expect(subjectToTopicKey("Café auth / PAT")).toBe("state/cafe-auth-pat")
  })

  it("passes through already-canonical state topic keys", () => {
    expect(subjectToTopicKey("state/lore-auth")).toBe("state/lore-auth")
  })

  it("rejects subjects that cannot produce an ASCII slug", () => {
    expect(() => subjectToTopicKey("会員")).toThrow(/ASCII letter or number/)
  })
})
