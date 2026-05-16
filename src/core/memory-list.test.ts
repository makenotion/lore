import type { Client } from "@notionhq/client"
import { describe, expect, it, vi } from "vitest"
import { defaultFeatureFlags } from "../feature-flags.js"
import type { DatabaseRef, Memory } from "../types.js"
import { MemoryList } from "./memory-list.js"

const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

function makeMemory(id: string): Memory {
  return {
    id,
    title: `Memory ${id}`,
    projectIds: ["project-id"],
    topicId: null,
    source: "manual",
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
    keywords: "",
    synopsis: "",
    session: null,
    content: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    taskState: null,
    blockedBy: "",
    entity: "",
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
    scope: null,
    pinned: null,
  }
}

describe("MemoryList.listForNearDuplicates", () => {
  it("redacts and one-lines SQL hydration partial-failure diagnostics", async () => {
    const savedDebug = process.env["LORE_DEBUG"]
    process.env["LORE_DEBUG"] = "1"
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const request = vi.fn(async () => ({
        results: [{ id: "ok-id" }, { id: "bad\nid" }],
        has_more: false,
      }))
      const getPropertiesById = vi.fn(async (id: string) => {
        if (id === "bad\nid") {
          throw new Error(
            "lookup failed for 0123456789abcdef0123456789abcdef\n" +
              "secret_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"
          )
        }
        return makeMemory(id)
      })
      const lister = new MemoryList(
        { request } as unknown as Client,
        db,
        defaultFeatureFlags(),
        () => ({}),
        () => false,
        async () => makeMemory("unused"),
        getPropertiesById
      )

      await expect(
        lister.listForNearDuplicates({ projectId: "project-id", limit: 5 })
      ).resolves.toEqual([makeMemory("ok-id")])

      const line = String(stderrSpy.mock.calls[0]![0])
      expect(line).toContain("[lore] partial-failure:")
      expect(line).toContain("source=near-duplicate-hydrate")
      expect(line).toContain("pageId=bad id")
      expect(line).toContain("error=lookup failed for <page-id> <redacted-token>")
      expect(line).not.toContain("0123456789abcdef0123456789abcdef")
      expect(line).not.toContain("secret_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890")
      expect(line.endsWith("\n")).toBe(true)
      expect(line.slice(0, -1)).not.toContain("\n")
    } finally {
      stderrSpy.mockRestore()
      if (savedDebug === undefined) delete process.env["LORE_DEBUG"]
      else process.env["LORE_DEBUG"] = savedDebug
    }
  })
})
