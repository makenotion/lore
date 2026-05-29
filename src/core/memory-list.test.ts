import type { Client, PageObjectResponse } from "@notionhq/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defaultFeatureFlags } from "../feature-flags.js"
import { MEMORY_PROPS } from "../notion/schema.js"
import type { DatabaseRef, Memory, MemoryScopeContext } from "../types.js"
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

function makePage(
  id: string,
  properties: Record<string, unknown> = {}
): PageObjectResponse {
  return {
    object: "page",
    id,
    archived: false,
    properties,
  } as unknown as PageObjectResponse
}

function missingPinnedPropertyError(): Error & { code: string } {
  const err = new Error(
    `Could not find property with name or id: ${MEMORY_PROPS.PINNED}`
  ) as Error & { code: string }
  err.code = "validation_error"
  return err
}

function makeLister(options: {
  request?: ReturnType<typeof vi.fn>
  query?: ReturnType<typeof vi.fn>
  scopeContext?: MemoryScopeContext
  scopeFilterEnabled?: boolean
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
    () => options.scopeContext ?? {},
    () => options.scopeFilterEnabled === true,
    async (page) => makeMemory(page.id),
    options.getPropertiesById
  )
}

describe("MemoryList.list", () => {
  it("default-excludes non-knowledge sources and kinds from recall filters", async () => {
    const query = vi.fn(async () => ({ results: [], has_more: false, next_cursor: null }))
    const lister = makeLister({
      query,
      getPropertiesById: async (id) => makeMemory(id),
    })

    await lister.list({ projectId: "project-id", limit: 3 })

    const calls = query.mock.calls as unknown as Array<[{ filter?: unknown }]>
    const serialized = JSON.stringify(calls[0]?.[0].filter)
    expect(serialized).toContain(
      JSON.stringify({
        property: MEMORY_PROPS.SOURCE,
        select: { does_not_equal: "agent_diary" },
      })
    )
    expect(serialized).toContain(
      JSON.stringify({
        property: MEMORY_PROPS.SOURCE,
        select: { does_not_equal: "digest" },
      })
    )
    expect(serialized).toContain(
      JSON.stringify({
        property: MEMORY_PROPS.KIND,
        select: { does_not_equal: "task" },
      })
    )
    expect(serialized).toContain(
      JSON.stringify({
        property: MEMORY_PROPS.KIND,
        select: { does_not_equal: "operational" },
      })
    )
  })

  it("lets explicit source and kind requests bypass their default exclusions", async () => {
    const query = vi.fn(async () => ({ results: [], has_more: false, next_cursor: null }))
    const lister = makeLister({
      query,
      getPropertiesById: async (id) => makeMemory(id),
    })

    await lister.list({
      source: "digest",
      kind: "task",
      limit: 3,
    })

    const calls = query.mock.calls as unknown as Array<[{ filter?: unknown }]>
    const serialized = JSON.stringify(calls[0]?.[0].filter)
    expect(serialized).toContain(
      JSON.stringify({
        property: MEMORY_PROPS.SOURCE,
        select: { equals: "digest" },
      })
    )
    expect(serialized).toContain(
      JSON.stringify({
        property: MEMORY_PROPS.KIND,
        select: { equals: "task" },
      })
    )
    expect(serialized).not.toContain('"does_not_equal":"digest"')
    expect(serialized).not.toContain('"does_not_equal":"agent_diary"')
    expect(serialized).not.toContain('"does_not_equal":"task"')
    expect(serialized).not.toContain('"does_not_equal":"operational"')
  })

  it("lets full-vault maintenance scans bypass default source and kind exclusions", async () => {
    const query = vi.fn(async () => ({ results: [], has_more: false, next_cursor: null }))
    const lister = makeLister({
      query,
      getPropertiesById: async (id) => makeMemory(id),
    })

    await lister.list({ recallPolicy: "all", limit: 3 })

    const calls = query.mock.calls as unknown as Array<[{ filter?: unknown }]>
    const serialized = JSON.stringify(calls[0]?.[0].filter)
    expect(serialized).not.toContain('"does_not_equal":"agent_diary"')
    expect(serialized).not.toContain('"does_not_equal":"digest"')
    expect(serialized).not.toContain('"does_not_equal":"task"')
    expect(serialized).not.toContain('"does_not_equal":"operational"')
  })

  it("can restrict list results to rows without project relations", async () => {
    const query = vi.fn(async () => ({ results: [], has_more: false, next_cursor: null }))
    const lister = makeLister({
      query,
      getPropertiesById: async (id) => makeMemory(id),
    })

    await lister.list({ unscopedOnly: true, limit: 3 })

    const calls = query.mock.calls as unknown as Array<[{ filter?: unknown }]>
    const serialized = JSON.stringify(calls[0]?.[0].filter)
    expect(serialized).toContain(
      JSON.stringify({
        property: MEMORY_PROPS.PROJECT,
        relation: { is_empty: true },
      })
    )
  })

  it("keeps includeRetiredSources as a full-vault compatibility opt-in", async () => {
    const query = vi.fn(async () => ({ results: [], has_more: false, next_cursor: null }))
    const lister = makeLister({
      query,
      getPropertiesById: async (id) => makeMemory(id),
    })

    await lister.list({ includeRetiredSources: true, limit: 3 })

    const calls = query.mock.calls as unknown as Array<[{ filter?: unknown }]>
    const serialized = JSON.stringify(calls[0]?.[0].filter)
    expect(serialized).not.toContain('"does_not_equal":"agent_diary"')
    expect(serialized).not.toContain('"does_not_equal":"digest"')
    expect(serialized).not.toContain('"does_not_equal":"task"')
    expect(serialized).not.toContain('"does_not_equal":"operational"')
  })

  it("pushes excludePinned into the Notion filter", async () => {
    const query = vi.fn(async () => ({ results: [], has_more: false, next_cursor: null }))
    const lister = makeLister({
      query,
      getPropertiesById: async (id) => makeMemory(id),
    })

    await lister.list({ projectId: "project-id", excludePinned: true, limit: 3 })

    const calls = query.mock.calls as unknown as Array<[{ filter?: unknown }]>
    const firstCall = calls[0]?.[0]
    expect(firstCall).toBeDefined()
    const serialized = JSON.stringify(firstCall?.filter)
    expect(serialized).toContain(MEMORY_PROPS.PINNED)
    expect(serialized).toContain("does_not_equal")
    expect(serialized).toContain("true")
  })

  it("retries excludePinned without the pinned filter on pre-migration vaults", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(missingPinnedPropertyError())
      .mockResolvedValueOnce({
        results: [makePage("normal-id")],
        has_more: false,
        next_cursor: null,
      })
    const lister = makeLister({
      query,
      getPropertiesById: async (id) => makeMemory(id),
    })

    const result = await lister.list({
      excludePinned: true,
      limit: 3,
      since: "2026-01-01",
      until: "2026-02-01",
    })

    expect(result.items.map((memory) => memory.id)).toEqual(["normal-id"])
    expect(query).toHaveBeenCalledTimes(2)
    const firstFilter = JSON.stringify(query.mock.calls[0]![0].filter)
    const retryFilter = JSON.stringify(query.mock.calls[1]![0].filter)
    expect(firstFilter).toContain(MEMORY_PROPS.PINNED)
    expect(retryFilter).not.toContain(MEMORY_PROPS.PINNED)
    expect(retryFilter).toContain("2026-01-01")
    expect(retryFilter).toContain("2026-02-01")
  })

  it("uses the caller-supplied today anchor for scope expiry filtering", async () => {
    const active = makePage("active-id", {
      [MEMORY_PROPS.EXPIRES_AT]: {
        type: "date",
        date: { start: "2026-04-21" },
      },
      [MEMORY_PROPS.SCOPE_KIND]: { type: "select", select: null },
    })
    const expired = makePage("expired-id", {
      [MEMORY_PROPS.EXPIRES_AT]: {
        type: "date",
        date: { start: "2026-04-20" },
      },
      [MEMORY_PROPS.SCOPE_KIND]: { type: "select", select: null },
    })
    const query = vi.fn(async () => ({
      results: [active, expired],
      has_more: false,
      next_cursor: null,
    }))
    const lister = makeLister({
      query,
      scopeFilterEnabled: true,
      getPropertiesById: async (id) => makeMemory(id),
    })

    const defaultResult = await lister.list({ limit: 10, today: "2026-04-21" })
    const withExpired = await lister.list({
      limit: 10,
      today: "2026-04-21",
      includeExpired: true,
    })

    expect(defaultResult.items.map((m) => m.id)).toEqual(["active-id"])
    expect(withExpired.items.map((m) => m.id)).toEqual(["active-id", "expired-id"])
    const calls = query.mock.calls as unknown as Array<[{ filter?: unknown }]>
    expect(JSON.stringify(calls[0]?.[0].filter)).toContain("2026-04-21")
    expect(JSON.stringify(calls[1]?.[0].filter)).not.toContain(MEMORY_PROPS.EXPIRES_AT)
  })
})

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
