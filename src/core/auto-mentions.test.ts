import { afterEach, describe, expect, it, vi } from "vitest"
import type { Memory } from "../types.js"
import {
  buildAutoMentionEntities,
  emitAutoMentions,
  MAX_AUTO_MENTION_ENTITIES,
} from "./auto-mentions.js"
import type { CreateFactResult } from "./fact.js"

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem-1",
    title: "AuthService mentions Notion API",
    projectIds: ["proj-1"],
    topicId: null,
    source: "conversation",
    kind: "note",
    status: "informational",
    confidence: "likely",
    confidenceScore: null,
    reviewBy: null,
    doneAt: null,
    decidedAt: null,
    lastReferencedAt: null,
    supersedesIds: [],
    affectsIds: [],
    alternatives: "",
    consequences: "",
    author: "",
    agent: "",
    tags: [],
    keywords: "PR-1234",
    synopsis: "OAuth &amp; billing follow-up.",
    session: null,
    content: "",
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
    taskState: null,
    blockedBy: "",
    entity: "",
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
    scope: null,
    pinned: null,
    ...overrides,
  }
}

function result(deduped: boolean): CreateFactResult {
  return {
    fact: {} as CreateFactResult["fact"],
    deduped,
    enriched: [],
  }
}

describe("buildAutoMentionEntities", () => {
  it("merges regex and structured entities, decodes, dedupes, and caps", () => {
    const entities = buildAutoMentionEntities({
      memory: memory(),
      extraEntities: [
        "OAuth &amp; billing",
        "Notion API",
        ...Array.from({ length: MAX_AUTO_MENTION_ENTITIES }, (_, i) => `Entity ${i}`),
      ],
    })
    expect(entities).toContain("OAuth & billing")
    expect(entities.filter((entity) => entity === "Notion API")).toHaveLength(1)
    expect(entities.length).toBe(MAX_AUTO_MENTION_ENTITIES)
  })
})

describe("emitAutoMentions", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("reports attempted, fulfilled, fresh-created, and Notion mutation counts", async () => {
    const createBatchWithDedup = vi.fn(async () => [
      { status: "fulfilled" as const, value: result(false) },
      { status: "fulfilled" as const, value: result(true) },
      { status: "rejected" as const, reason: new Error("bad entity") },
    ])
    const onError = vi.fn()

    const emitted = await emitAutoMentions({
      facts: { createBatchWithDedup },
      memory: memory({ title: "", keywords: "", synopsis: "" }),
      extraEntities: ["Fresh", "Deduped", "Rejected"],
      onError,
    })

    expect(emitted).toEqual({
      attempted: 3,
      fulfilled: 2,
      freshCreated: 1,
      notionMutationCount: 1,
    })
    expect(onError).toHaveBeenCalledWith("Rejected", expect.any(Error))
    expect(createBatchWithDedup).toHaveBeenCalledTimes(1)
  })

  it("honors the resolved disabled flag without calling FactService", async () => {
    const createBatchWithDedup = vi.fn()

    const emitted = await emitAutoMentions({
      facts: { createBatchWithDedup },
      memory: memory(),
      disabled: true,
    })

    expect(emitted.attempted).toBe(0)
    expect(createBatchWithDedup).not.toHaveBeenCalled()
  })
})
