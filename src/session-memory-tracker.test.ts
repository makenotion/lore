import { describe, expect, it } from "vitest"
import { SessionMemoryTracker } from "./session-memory-tracker.js"

describe("SessionMemoryTracker", () => {
  it("returns the memory recorded for a composite (agent, session) key", () => {
    const tracker = new SessionMemoryTracker()
    tracker.record(
      { agent: "claude-code", session: "s1" },
      { memoryId: "mem-abc", projectIds: ["proj-a"] }
    )
    const got = tracker.get({ agent: "claude-code", session: "s1" })
    expect(got?.memoryId).toBe("mem-abc")
    expect(got?.projectIds).toEqual(["proj-a"])
  })

  it("returns undefined for an unknown key", () => {
    const tracker = new SessionMemoryTracker()
    expect(
      tracker.get({ agent: "claude-code", session: "never-recorded" })
    ).toBeUndefined()
  })

  it("keeps entries isolated across agents even with identical session values", () => {
    // Multi-agent MCP scenario: two agents using the same default session ID
    // must not cross-link. The composite key is the safety boundary.
    const tracker = new SessionMemoryTracker()
    tracker.record(
      { agent: "claude-code", session: "default" },
      { memoryId: "mem-claude", projectIds: [] }
    )
    tracker.record(
      { agent: "codex", session: "default" },
      { memoryId: "mem-codex", projectIds: [] }
    )
    expect(tracker.get({ agent: "claude-code", session: "default" })?.memoryId).toBe(
      "mem-claude"
    )
    expect(tracker.get({ agent: "codex", session: "default" })?.memoryId).toBe(
      "mem-codex"
    )
  })

  it("overwrites within the same key when a new memory is recorded", () => {
    const tracker = new SessionMemoryTracker()
    tracker.record({ session: "s1" }, { memoryId: "mem-first", projectIds: [] })
    tracker.record({ session: "s1" }, { memoryId: "mem-second", projectIds: [] })
    expect(tracker.get({ session: "s1" })?.memoryId).toBe("mem-second")
  })

  it("ignores record / get with empty session regardless of agent", () => {
    // Anonymous shared-default keys would otherwise collide across unrelated
    // callers and produce wrong auto-links.
    const tracker = new SessionMemoryTracker()
    tracker.record({ agent: "a", session: "" }, { memoryId: "mem-x", projectIds: [] })
    tracker.record(
      { agent: "b", session: undefined },
      { memoryId: "mem-y", projectIds: [] }
    )
    expect(tracker.get({ agent: "a", session: "" })).toBeUndefined()
    expect(tracker.get({ agent: "b", session: undefined })).toBeUndefined()
  })

  it("preserves project scope on the recorded entry", () => {
    // Project scope is what lore-learn uses to guard against cross-project
    // auto-links; the tracker must round-trip it verbatim.
    const tracker = new SessionMemoryTracker()
    tracker.record(
      { session: "s1" },
      { memoryId: "mem-1", projectIds: ["proj-a", "proj-b"] }
    )
    expect(tracker.get({ session: "s1" })?.projectIds).toEqual(["proj-a", "proj-b"])
  })

  it("evicts the least-recently-touched entry when the LRU cap is exceeded", () => {
    // We don't expose the cap as a constructor parameter; prove the LRU
    // works by overflowing it. 256 is the documented max.
    const tracker = new SessionMemoryTracker()
    for (let i = 0; i < 260; i++) {
      tracker.record({ session: `s${i}` }, { memoryId: `mem${i}`, projectIds: [] })
    }
    // Oldest four should have evicted.
    expect(tracker.get({ session: "s0" })).toBeUndefined()
    expect(tracker.get({ session: "s3" })).toBeUndefined()
    // Within-cap survivor present.
    expect(tracker.get({ session: "s259" })?.memoryId).toBe("mem259")
  })

  it("touches on get so active sessions are never evicted", () => {
    const tracker = new SessionMemoryTracker()
    tracker.record({ session: "keep-me" }, { memoryId: "mem-keep", projectIds: [] })
    for (let i = 0; i < 260; i++) {
      // Interleave reads on the active session so it keeps moving to the
      // "most recent" slot.
      if (i % 20 === 0) tracker.get({ session: "keep-me" })
      tracker.record({ session: `s${i}` }, { memoryId: `mem${i}`, projectIds: [] })
    }
    expect(tracker.get({ session: "keep-me" })?.memoryId).toBe("mem-keep")
  })
})
