import { describe, expect, it } from "vitest"
import {
  canonicalVocabTag,
  classifyTags,
  isObviousFreeformTag,
  planMemoryMigration,
} from "./tag-migration.js"
import type { Memory } from "../types.js"

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem-1",
    title: "test memory",
    projectIds: [],
    topicId: null,
    source: "manual",
    kind: "note",
    status: "informational",
    confidence: "certain",
    reviewBy: null,
    decidedAt: null,
    supersedesIds: [],
    affectsIds: [],
    alternatives: "",
    consequences: "",
    author: "",
    agent: "",
    tags: [],
    keywords: "",
    session: "",
    content: "",
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  }
}

describe("isObviousFreeformTag", () => {
  it.each([
    "pr-25701",
    "PR-12345",
    "pr25701",
    "SENTRY-MAIL-IOS-2DY",
    "MAIL-1234",
    "MailboxViewStore.swift",
    "config.yaml",
    "ThreadListStore",
    "camelCaseName",
    "processBatchedItems",
    "a1b2c3d4e5f6",
  ])("matches %s as free-form", (tag) => {
    expect(isObviousFreeformTag(tag)).toBe(true)
  })

  it.each([
    "ios",
    "performance",
    "workflow",
    "testing",
    "gotcha",
    "code-review",
    "error-handling",
    "frontend",
  ])("does NOT match %s (in vocab or lowercase kebab)", (tag) => {
    expect(isObviousFreeformTag(tag)).toBe(false)
  })

  // Regression: the first-pass heuristic (`[A-Z] && [a-z]`) over-reached
  // and yanked curated human-readable labels into Keywords. The tightened
  // rule requires contiguous PascalCase or camelCase — a hyphen-separated
  // label that happens to capitalize one segment must NOT match. (`iOS`
  // is structurally camelCase but is still protected by the case-
  // insensitive vocab pre-check — see classifyTags tests below.)
  it.each([
    "UX-Design",
    "API-Design",
    "Growth",
    "MailApp-v2",
    "code-Review",
  ])("does NOT match %s (curated capitalized label, not an identifier)", (tag) => {
    expect(isObviousFreeformTag(tag)).toBe(false)
  })
})

describe("canonicalVocabTag", () => {
  it("returns the tag unchanged when already canonical", () => {
    expect(canonicalVocabTag("ios")).toBe("ios")
    expect(canonicalVocabTag("code-review")).toBe("code-review")
  })

  it("normalizes case variants of vocab terms", () => {
    expect(canonicalVocabTag("iOS")).toBe("ios")
    expect(canonicalVocabTag("IOS")).toBe("ios")
    expect(canonicalVocabTag("Ios")).toBe("ios")
    expect(canonicalVocabTag("ARCHITECTURE")).toBe("architecture")
  })

  it("returns null when not in the vocabulary", () => {
    expect(canonicalVocabTag("custom-tag")).toBeNull()
    expect(canonicalVocabTag("pr-25701")).toBeNull()
  })
})

describe("classifyTags", () => {
  it("splits tags into vocab / freeform / ambiguous", () => {
    const result = classifyTags([
      "ios",
      "performance",
      "pr-25701",
      "MailboxViewStore.swift",
      "thread-list-store",
      "custom-project-tag",
    ])
    expect(result.vocab).toEqual(["ios", "performance"])
    expect(result.freeform).toEqual(["pr-25701", "MailboxViewStore.swift"])
    expect(result.ambiguous).toEqual(["thread-list-store", "custom-project-tag"])
  })

  it("returns all-vocab when every tag is in the vocabulary", () => {
    const result = classifyTags(["ios", "performance", "workflow"])
    expect(result.freeform).toEqual([])
    expect(result.ambiguous).toEqual([])
    expect(result.vocab).toEqual(["ios", "performance", "workflow"])
  })

  it("normalizes case-variant vocab tags to their canonical form", () => {
    const result = classifyTags(["iOS", "PERFORMANCE", "Workflow"])
    expect(result.vocab).toEqual(["ios", "performance", "workflow"])
    expect(result.freeform).toEqual([])
    expect(result.ambiguous).toEqual([])
  })

  it("keeps curated capitalized labels as ambiguous rather than freeform", () => {
    const result = classifyTags(["UX-Design", "API-Design", "Growth"])
    expect(result.freeform).toEqual([])
    expect(result.ambiguous).toEqual(["UX-Design", "API-Design", "Growth"])
  })
})

describe("planMemoryMigration", () => {
  it("returns null when nothing needs to move", () => {
    const memory = makeMemory({ tags: ["ios", "performance"] })
    expect(planMemoryMigration(memory)).toBeNull()
  })

  it("returns null when only ambiguous tags exist (no freeform to move)", () => {
    const memory = makeMemory({ tags: ["custom-one", "custom-two"] })
    expect(planMemoryMigration(memory)).toBeNull()
  })

  it("moves obvious freeform tokens to Keywords, preserves vocab + ambiguous", () => {
    const memory = makeMemory({
      tags: ["ios", "performance", "pr-25701", "ThreadListStore", "custom-proj"],
      keywords: "",
    })
    const plan = planMemoryMigration(memory)
    expect(plan).not.toBeNull()
    expect(plan!.after.tags).toEqual(["ios", "performance", "custom-proj"])
    expect(plan!.after.keywords).toBe("pr-25701 ThreadListStore")
    expect(plan!.moved).toEqual(["pr-25701", "ThreadListStore"])
    expect(plan!.ambiguous).toEqual(["custom-proj"])
  })

  it("appends to existing Keywords without duplicating", () => {
    const memory = makeMemory({
      tags: ["performance", "pr-25701"],
      keywords: "existing pr-25701",
    })
    const plan = planMemoryMigration(memory)
    expect(plan).not.toBeNull()
    expect(plan!.after.keywords).toBe("existing pr-25701")
    expect(plan!.after.tags).toEqual(["performance"])
  })

  it("rewrites case drift even when no freeform tokens need to move", () => {
    const memory = makeMemory({ tags: ["iOS", "Performance"], keywords: "" })
    const plan = planMemoryMigration(memory)
    expect(plan).not.toBeNull()
    expect(plan!.moved).toEqual([])
    expect(plan!.after.tags).toEqual(["ios", "performance"])
  })
})
