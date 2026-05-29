import { afterEach, describe, expect, it, vi } from "vitest"
import type { Memory } from "../../../types.js"
import { upgradeLegacyDecisionTags } from "./decision-tags.js"
import { runOutOfVocabTagMigration } from "./tags.js"

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem-1",
    title: "Legacy memory",
    projectIds: [],
    topicId: null,
    source: "manual",
    kind: "note",
    status: "informational",
    confidence: "certain",
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
    keywords: "",
    synopsis: "",
    session: null,
    content: "",
    taskState: null,
    blockedBy: "",
    entity: "",
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  }
}

describe("legacy memory migrations and retired sources", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("includes retired sources when scanning out-of-vocabulary tags", async () => {
    const list = vi.fn(async () => ({ items: [], nextCursor: undefined }))
    vi.spyOn(console, "log").mockImplementation(() => {})

    await runOutOfVocabTagMigration(
      {
        profile: { taxonomy: { tags: [] } },
        memories: { list },
      } as never,
      { dryRun: true, diffs: [] }
    )

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        includeProposed: true,
        includeRetiredSources: true,
      })
    )
  })

  it("includes retired sources when upgrading legacy decision tags", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          makeMemory({
            id: "mem-decision",
            source: "agent_diary",
            tags: ["decision"],
          }),
        ],
      })
      .mockResolvedValueOnce({ items: [] })
    const update = vi.fn()

    const upgraded = await upgradeLegacyDecisionTags({
      memories: { list, update },
    } as never)

    expect(upgraded).toBe(1)
    expect(list.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        includeProposed: true,
        includeRetiredSources: true,
      })
    )
    expect(update).toHaveBeenCalledWith("mem-decision", {
      kind: "decision",
      tags: [],
    })
  })
})
