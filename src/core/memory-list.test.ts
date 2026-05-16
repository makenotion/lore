import type { Client, PageObjectResponse } from "@notionhq/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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

function makePage(id: string): PageObjectResponse {
  return {
    object: "page",
    id,
    archived: false,
    properties: {},
  } as unknown as PageObjectResponse
}

function makeLister(options: {
  request?: ReturnType<typeof vi.fn>
  query?: ReturnType<typeof vi.fn>
  getPropertiesById: (id: string) => Promise<Memory>
}): MemoryList {
  return new MemoryList(
    {
      request: options.request ?? vi.fn(async () => ({ results: [], has_more: false })),
      dataSources: {
        query:
          options.query ??
          vi.fn(async () => ({ results: [], has_more: false, next_cursor: null })),
      },
    } as unknown as Client,
    db,
    defaultFeatureFlags(),
    () => ({}),
    () => false,
    async (page) => makeMemory(page.id),
    options.getPropertiesById
  )
}

describe("MemoryList.listForNearDuplicates", () => {
  let savedDebug: string | undefined
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    savedDebug = process.env["LORE_DEBUG"]
    process.env["LORE_DEBUG"] = "1"
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true) as unknown as typeof stderrSpy
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    if (savedDebug === undefined) delete process.env["LORE_DEBUG"]
    else process.env["LORE_DEBUG"] = savedDebug
  })

  it("drops 404 object_not_found hydration failures and keeps remaining candidates", async () => {
    const request = vi.fn(async () => ({
      results: [{ id: "ok-id" }, { id: "gone-id" }],
      has_more: false,
    }))
    const getPropertiesById = vi.fn(async (id: string) => {
      if (id === "gone-id") {
        const err = new Error("not found") as Error & {
          status: number
          code: string
        }
        err.status = 404
        err.code = "object_not_found"
        throw err
      }
      return makeMemory(id)
    })
    const lister = makeLister({ request, getPropertiesById })

    await expect(
      lister.listForNearDuplicates({ projectId: "project-id", limit: 5 })
    ).resolves.toEqual([makeMemory("ok-id")])

    expect(stderrSpy).toHaveBeenCalledTimes(1)
    const line = String(stderrSpy.mock.calls[0]![0])
    expect(line).toContain("[lore] partial-failure:")
    expect(line).toContain("source=near-duplicate-hydrate")
    expect(line).toContain("pageId=gone-id")
    expect(line).toContain("error=not found")
  })

  it("drops archived hydration failures and redacts one-line diagnostics", async () => {
    const request = vi.fn(async () => ({
      results: [{ id: "ok-id" }, { id: "bad\nid" }],
      has_more: false,
    }))
    const getPropertiesById = vi.fn(async (id: string) => {
      if (id === "bad\nid") {
        throw new Error(
          "Memory 0123456789abcdef0123456789abcdef is archived.\n" +
            "secret_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"
        )
      }
      return makeMemory(id)
    })
    const lister = makeLister({ request, getPropertiesById })

    await expect(
      lister.listForNearDuplicates({ projectId: "project-id", limit: 5 })
    ).resolves.toEqual([makeMemory("ok-id")])

    expect(stderrSpy).toHaveBeenCalledTimes(1)
    const line = String(stderrSpy.mock.calls[0]![0])
    expect(line).toContain("[lore] partial-failure:")
    expect(line).toContain("source=near-duplicate-hydrate")
    expect(line).toContain("pageId=bad id")
    expect(line).toContain("error=Memory <page-id> is archived. <redacted-token>")
    expect(line).not.toContain("0123456789abcdef0123456789abcdef")
    expect(line).not.toContain("secret_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890")
    expect(line.endsWith("\n")).toBe(true)
    expect(line.slice(0, -1)).not.toContain("\n")
  })

  it("falls back to REST when hydration fails with a systemic error", async () => {
    const request = vi.fn(async () => ({
      results: [{ id: "ok-id" }, { id: "down-id" }],
      has_more: false,
    }))
    const query = vi.fn(async () => ({
      results: [makePage("rest-id")],
      has_more: false,
      next_cursor: null,
    }))
    const getPropertiesById = vi.fn(async (id: string) => {
      if (id === "down-id") {
        throw { status: 503, code: "service_unavailable", message: "try later" }
      }
      return makeMemory(id)
    })
    const lister = makeLister({ request, query, getPropertiesById })

    await expect(
      lister.listForNearDuplicates({ projectId: "project-id", limit: 5 })
    ).resolves.toEqual([makeMemory("rest-id")])

    expect(query).toHaveBeenCalledTimes(1)
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    const line = String(stderrSpy.mock.calls[0]![0])
    expect(line).toContain("source=near-duplicate-hydrate")
    expect(line).toContain("status=503")
    expect(line).toContain("code=service_unavailable")
    expect(line).toContain("runtool-fallback=1")
  })

  it("surfaces SQL validation errors instead of falling back to REST", async () => {
    const sqlError = { status: 400, code: "validation_error", message: "bad sql" }
    const request = vi.fn(async () => {
      throw sqlError
    })
    const query = vi.fn(async () => ({
      results: [makePage("rest-id")],
      has_more: false,
      next_cursor: null,
    }))
    const getPropertiesById = vi.fn(async (id: string) => makeMemory(id))
    const lister = makeLister({ request, query, getPropertiesById })

    await expect(
      lister.listForNearDuplicates({ projectId: "project-id", limit: 5 })
    ).rejects.toBe(sqlError)

    expect(query).not.toHaveBeenCalled()
    expect(stderrSpy).not.toHaveBeenCalled()
  })
})
