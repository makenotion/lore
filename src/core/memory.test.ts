import { createHash } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { APIErrorCode, APIResponseError } from "@notionhq/client"
import {
  MemoryService,
  MemoryCreatePartialFailureError,
  MemoryUpdatePartialFailureError,
  pageToMemory,
  tieBreakingRrfCompare,
  appendCompareNote,
  appendCompareDispatchLedgerEntry,
  buildCompareDispatchLedgerEntry,
  COMPARE_NOTES_MAX_CHARS,
  RecordComparedPartialWriteError,
  RekeyAuditError,
  hasCompareDispatchLedgerEntry,
  hasMatchingCompareNote,
  recordContradiction,
  recordSupersedence,
  computePromotionAdvisory,
  PROMOTE_BODY_LENGTH_THRESHOLD,
  PROMOTE_REVISION_THRESHOLD,
  SEMANTIC_SEARCH_MAX_PAGES,
  type RrfEntry,
} from "./memory.js"
import { RICH_TEXT_PROPERTY_MAX_LEN } from "./rich-text-schema.js"
import { AutosaveLearningDuplicateProbeError } from "./near-duplicate.js"
import { encodeCompareNotesRichText } from "../notion/schema.js"
import {
  SYNOPSIS_MAX,
  type CreateMemoryInput,
  type DatabaseRef,
  type UpdateMemoryInput,
} from "../types.js"
import { buildMemoryProps } from "../notion/schema.js"

/**
 * Build a synthetic `PageObjectResponse` with only the properties listed.
 * Everything else is omitted — mirrors how pre-migration pages look to the
 * Notion API (missing columns simply don't appear in `properties`).
 */
function buildPage(
  properties: Record<string, unknown>,
  overrides: Partial<PageObjectResponse> = {}
): PageObjectResponse {
  return {
    object: "page",
    id: "page-id-123",
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-02-01T00:00:00.000Z",
    archived: false,
    properties: properties as PageObjectResponse["properties"],
    parent: { type: "database_id", database_id: "db-id" },
    url: "https://notion.so/page-id-123",
    ...overrides,
  } as PageObjectResponse
}

describe("pageToMemory — backward compatibility with pre-migration pages", () => {
  it("returns safe defaults for every new field when all new properties are absent", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Old note" }] },
      Project: { type: "relation", relation: [] },
      Topic: { type: "relation", relation: [] },
      Source: { type: "select", select: { name: "manual" } },
      Author: { type: "rich_text", rich_text: [] },
      Agent: { type: "rich_text", rich_text: [] },
      Tags: { type: "multi_select", multi_select: [] },
      Session: { type: "rich_text", rich_text: [] },
    })

    const memory = pageToMemory(page, "body content")

    expect(memory.title).toBe("Old note")
    expect(memory.source).toBe("manual")

    // Every new field must default gracefully:
    expect(memory.kind).toBe("note")
    expect(memory.status).toBe("informational")
    expect(memory.confidence).toBe("certain")
    expect(memory.reviewBy).toBeNull()
    expect(memory.doneAt).toBeNull()
    expect(memory.decidedAt).toBeNull()
    expect(memory.lastReferencedAt).toBeNull()
    expect(memory.supersedesIds).toEqual([])
    expect(memory.affectsIds).toEqual([])
    expect(memory.alternatives).toBe("")
    expect(memory.consequences).toBe("")
    expect(memory.synopsis).toBe("")
    expect(memory.session).toBeNull()
    expect(memory.confidenceScore).toBeNull()
    expect(memory.lastReferencedAt).toBeNull()
    expect(memory.content).toBe("body content")
  })

  it("does not throw when the properties object is completely empty", () => {
    const page = buildPage({})
    expect(() => pageToMemory(page)).not.toThrow()

    const memory = pageToMemory(page)
    expect(memory.title).toBe("")
    expect(memory.projectIds).toEqual([])
    expect(memory.topicId).toBeNull()
    expect(memory.source).toBe("manual")
    expect(memory.kind).toBe("note")
    expect(memory.status).toBe("informational")
    expect(memory.confidence).toBe("certain")
    expect(memory.content).toBe("")
  })
})

describe("pageToMemory — fully populated decision page", () => {
  it("extracts every new field correctly when all properties are present", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Use DecisionService" }] },
      Project: {
        type: "relation",
        relation: [{ id: "proj-1" }, { id: "proj-2" }],
      },
      Topic: { type: "relation", relation: [{ id: "topic-1" }] },
      Source: { type: "select", select: { name: "conversation" } },
      Kind: { type: "select", select: { name: "decision" } },
      Status: { type: "select", select: { name: "accepted" } },
      Confidence: { type: "select", select: { name: "likely" } },
      "Review By": { type: "date", date: { start: "2026-10-20" } },
      "Done At": { type: "date", date: { start: "2026-04-25" } },
      "Decided At": { type: "date", date: { start: "2026-04-20" } },
      "Last Referenced At": { type: "date", date: { start: "2026-04-29" } },
      Supersedes: { type: "relation", relation: [{ id: "old-decision" }] },
      Affects: {
        type: "relation",
        relation: [{ id: "affected-1" }, { id: "affected-2" }],
      },
      Alternatives: {
        type: "rich_text",
        rich_text: [{ plain_text: "Alt A; Alt B" }],
      },
      Consequences: {
        type: "rich_text",
        rich_text: [{ plain_text: "Must migrate extractors" }],
      },
      Author: { type: "rich_text", rich_text: [{ plain_text: "testuser" }] },
      Agent: { type: "rich_text", rich_text: [{ plain_text: "claude" }] },
      Tags: {
        type: "multi_select",
        multi_select: [{ name: "architecture" }, { name: "core" }],
      },
      Keywords: {
        type: "rich_text",
        rich_text: [{ plain_text: "pr-1234 WidgetListStore.swift" }],
      },
      Synopsis: {
        type: "rich_text",
        rich_text: [{ plain_text: "Adopt DecisionService for the rationale chain." }],
      },
      Session: { type: "rich_text", rich_text: [{ plain_text: "sess-42" }] },
    })

    const memory = pageToMemory(page, "Rationale prose.")

    expect(memory.title).toBe("Use DecisionService")
    expect(memory.projectIds).toEqual(["proj-1", "proj-2"])
    expect(memory.topicId).toBe("topic-1")
    expect(memory.source).toBe("conversation")
    expect(memory.kind).toBe("decision")
    expect(memory.status).toBe("accepted")
    expect(memory.confidence).toBe("likely")
    expect(memory.reviewBy).toBe("2026-10-20")
    expect(memory.doneAt).toBe("2026-04-25")
    expect(memory.decidedAt).toBe("2026-04-20")
    expect(memory.lastReferencedAt).toBe("2026-04-29")
    expect(memory.supersedesIds).toEqual(["old-decision"])
    expect(memory.affectsIds).toEqual(["affected-1", "affected-2"])
    expect(memory.alternatives).toBe("Alt A; Alt B")
    expect(memory.consequences).toBe("Must migrate extractors")
    expect(memory.author).toBe("testuser")
    expect(memory.agent).toBe("claude")
    expect(memory.tags).toEqual(["architecture", "core"])
    expect(memory.keywords).toBe("pr-1234 WidgetListStore.swift")
    expect(memory.synopsis).toBe("Adopt DecisionService for the rationale chain.")
    expect(memory.session).toBe("sess-42")
    expect(memory.content).toBe("Rationale prose.")
  })

  it("extracts Confidence Score and Last Referenced At when present", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Touched memory" }] },
      "Confidence Score": { type: "number", number: 0.72 },
      "Last Referenced At": { type: "date", date: { start: "2026-04-29" } },
    })

    const memory = pageToMemory(page)
    expect(memory.confidenceScore).toBe(0.72)
    expect(memory.lastReferencedAt).toBe("2026-04-29")
  })

  it("preserves null when Confidence Score is present-but-empty", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Cleared" }] },
      "Confidence Score": { type: "number", number: null },
      "Last Referenced At": { type: "date", date: null },
    })

    const memory = pageToMemory(page)
    expect(memory.confidenceScore).toBeNull()
    expect(memory.lastReferencedAt).toBeNull()
  })
})

describe("Confidence Score property round-trip (#01)", () => {
  it("returns null on a pre-migration page with no Confidence Score column", () => {
    // A vault upgraded from <0.8.0 has no `Confidence Score` column on
    // its Memories DB pages. `pageToMemory` must surface this as `null`
    // so #08's RRF integration can branch on "never scored" without an
    // extra schema check.
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Pre-migration" }] },
    })
    expect(pageToMemory(page).confidenceScore).toBeNull()
  })

  it("extracts a populated Confidence Score number", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Scored" }] },
      "Confidence Score": { type: "number", number: 0.85 },
    })
    expect(pageToMemory(page).confidenceScore).toBe(0.85)
  })

  it("returns null when the column exists but is empty on Notion's side", () => {
    // A row whose Confidence Score was explicitly cleared (e.g. by an
    // operator or the #11 migration) round-trips as `null`. Distinct
    // from "scored to zero" — the floor of the range, which must remain
    // a number through pageToMemory.
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Cleared" }] },
      "Confidence Score": { type: "number", number: null },
    })
    expect(pageToMemory(page).confidenceScore).toBeNull()
  })

  it("preserves zero as a populated value (not collapsed to null)", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Floor" }] },
      "Confidence Score": { type: "number", number: 0 },
    })
    expect(pageToMemory(page).confidenceScore).toBe(0)
  })

  it("round-trips a Confidence Score through buildMemoryProps + pageToMemory", () => {
    const built = buildMemoryProps({ title: "x", confidenceScore: 0.42 }) as Record<
      string,
      { number: number | null }
    >
    expect(built["Confidence Score"]).toEqual({ number: 0.42 })

    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "x" }] },
      "Confidence Score": { type: "number", number: built["Confidence Score"].number },
    })
    expect(pageToMemory(page).confidenceScore).toBe(0.42)
  })
})

describe("MemoryService.create — Confidence Score write semantics (#01)", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function makeCreateClient() {
    const createSpy = vi.fn(
      async (_args: { parent: unknown; properties: Record<string, unknown> }) => ({
        object: "page",
        id: "mem-1",
        created_time: "2026-04-20T00:00:00.000Z",
        last_edited_time: "2026-04-20T00:00:00.000Z",
        archived: false,
        properties: { Title: { type: "title", title: [{ plain_text: "x" }] } },
        parent: { type: "database_id", database_id: db.databaseId },
        url: "",
      })
    )
    const updateMarkdownSpy = vi.fn(async () => ({}))
    const client = {
      pages: { create: createSpy, updateMarkdown: updateMarkdownSpy },
    } as unknown as Client
    return { client, createSpy }
  }

  it("writes `{ number: <value> }` when confidenceScore is a number", async () => {
    const { client, createSpy } = makeCreateClient()
    const service = new MemoryService(client, db)

    await service.create({ title: "x", content: "", confidenceScore: 0.85 })

    expect(createSpy).toHaveBeenCalledTimes(1)
    const props = createSpy.mock.calls[0]![0].properties
    expect(props["Confidence Score"]).toEqual({ number: 0.85 })
  })

  it("omits Confidence Score when the input does not include it", async () => {
    // Production callers leave confidenceScore unset — the column is
    // system-managed via #03/#06. Omission must produce a create payload
    // with no `Confidence Score` key so Notion stores `null` (the
    // "never scored" sentinel) rather than a default value.
    const { client, createSpy } = makeCreateClient()
    const service = new MemoryService(client, db)

    await service.create({ title: "x", content: "" })

    const props = createSpy.mock.calls[0]![0].properties
    expect("Confidence Score" in props).toBe(false)
  })
})

describe("MemoryService.create — rich_text metadata cap", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }
  type RichTextFieldCase = readonly [
    string,
    (value: string) => Partial<CreateMemoryInput>,
    string,
  ]
  type RejectCase = readonly [string, Partial<CreateMemoryInput>, number]

  const richTextFields: RichTextFieldCase[] = [
    ["alternatives", (value: string) => ({ alternatives: value }), "Alternatives"],
    ["consequences", (value: string) => ({ consequences: value }), "Consequences"],
    ["author", (value: string) => ({ author: value }), "Author"],
    ["agent", (value: string) => ({ agent: value }), "Agent"],
    ["keywords", (value: string) => ({ keywords: value }), "Keywords"],
    ["session", (value: string) => ({ session: value }), "Session"],
    ["blockedBy", (value: string) => ({ blockedBy: value }), "Blocked By"],
    ["entity", (value: string) => ({ entity: value }), "Entity"],
    ["topicKey", (value: string) => ({ topicKey: value }), "Topic Key"],
  ]
  const rejectCases: RejectCase[] = [
    ...richTextFields.map(
      ([field, buildInput]) =>
        [
          field,
          buildInput("x".repeat(RICH_TEXT_PROPERTY_MAX_LEN + 1)),
          RICH_TEXT_PROPERTY_MAX_LEN,
        ] as const
    ),
    ["synopsis", { synopsis: "x".repeat(SYNOPSIS_MAX + 1) }, SYNOPSIS_MAX],
  ]

  function makeCreateClient() {
    const createSpy = vi.fn(
      async (_args: { parent: unknown; properties: Record<string, unknown> }) => ({
        object: "page",
        id: "mem-1",
        created_time: "2026-04-20T00:00:00.000Z",
        last_edited_time: "2026-04-20T00:00:00.000Z",
        archived: false,
        properties: { Title: { type: "title", title: [{ plain_text: "x" }] } },
        parent: { type: "database_id", database_id: db.databaseId },
        url: "",
      })
    )
    const client = {
      pages: { create: createSpy, updateMarkdown: vi.fn(async () => ({})) },
    } as unknown as Client
    return { client, createSpy }
  }

  it.each(richTextFields)(
    "accepts %s at the Notion rich_text cap",
    async (_field, buildInput, propertyName) => {
      const { client, createSpy } = makeCreateClient()
      const service = new MemoryService(client, db)
      const atCap = "x".repeat(RICH_TEXT_PROPERTY_MAX_LEN)

      await service.create({
        title: "Keep metadata capped",
        content: "",
        ...buildInput(atCap),
      })

      const props = createSpy.mock.calls[0]![0].properties as Record<
        string,
        { rich_text: Array<{ text: { content: string } }> }
      >
      expect(props[propertyName].rich_text[0].text.content).toBe(atCap)
    }
  )

  it("accepts synopsis at SYNOPSIS_MAX", async () => {
    const { client, createSpy } = makeCreateClient()
    const service = new MemoryService(client, db)
    const atCap = "x".repeat(SYNOPSIS_MAX)

    await service.create({
      title: "Keep metadata capped",
      content: "",
      synopsis: atCap,
    })

    const props = createSpy.mock.calls[0]![0].properties as {
      Synopsis: { rich_text: Array<{ text: { content: string } }> }
    }
    expect(props.Synopsis.rich_text[0].text.content).toBe(atCap)
  })

  it.each(rejectCases)(
    "rejects over-cap %s before any Notion write",
    async (field, input, cap) => {
      const { client, createSpy } = makeCreateClient()
      const service = new MemoryService(client, db)

      await expect(
        service.create({
          title: "Keep metadata capped",
          content: "",
          ...input,
        })
      ).rejects.toThrow(new RegExp(`MemoryService\\.create.*${field}.*${cap}`))
      expect(createSpy).not.toHaveBeenCalled()
    }
  )
})

describe("MemoryService.create — autosave-learning duplicate gate", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildAutosaveLearningPage(id: string): PageObjectResponse {
    return buildPage(
      {
        Title: {
          type: "title",
          title: [{ plain_text: "Relation filters reject empty arrays" }],
        },
        Project: { type: "relation", relation: [{ id: "proj-a" }] },
        Source: { type: "select", select: { name: "conversation" } },
        Kind: { type: "select", select: { name: "note" } },
        Confidence: { type: "select", select: { name: "likely" } },
        Session: { type: "rich_text", rich_text: [{ plain_text: "session-1" }] },
      },
      { id }
    )
  }

  it("reuses an existing likely conversation note before creating a duplicate", async () => {
    const querySpy = vi.fn(async () => ({
      results: [buildAutosaveLearningPage("mem-existing")],
      has_more: false,
      next_cursor: null,
    }))
    const createSpy = vi.fn()
    const client = {
      dataSources: { query: querySpy },
      pages: {
        create: createSpy,
        updateMarkdown: vi.fn(),
        retrieveMarkdown: vi.fn(async () => ({
          markdown:
            "Notion dataSources.query rejects relation filters with empty arrays.",
        })),
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const result = await service.createWithResult({
      title: "Relation filters reject empty arrays",
      content: "Notion dataSources.query rejects relation filters with empty arrays.",
      projectIds: ["proj-a"],
      source: "conversation",
      kind: "note",
      confidence: "likely",
      session: "session-2",
    })

    expect(result.memory.id).toBe("mem-existing")
    expect(result.autosaveLearningDuplicate?.id).toBe("mem-existing")
    expect(createSpy).not.toHaveBeenCalled()
    expect(querySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data_source_id: "memories-ds",
        filter: expect.any(Object),
      })
    )
  })

  it("fails closed when the duplicate probe errors", async () => {
    const queryError = new Error("Notion 429")
    const querySpy = vi.fn(async () => {
      throw queryError
    })
    const createSpy = vi.fn()
    const client = {
      dataSources: { query: querySpy },
      pages: {
        create: createSpy,
        updateMarkdown: vi.fn(),
        retrieveMarkdown: vi.fn(),
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await expect(
      service.createWithResult({
        title: "Relation filters reject empty arrays",
        content: "Notion dataSources.query rejects relation filters with empty arrays.",
        projectIds: ["proj-a"],
        source: "conversation",
        kind: "note",
        confidence: "likely",
        session: "session-2",
      })
    ).rejects.toBeInstanceOf(AutosaveLearningDuplicateProbeError)

    expect(createSpy).not.toHaveBeenCalled()
  })

  it("keeps the autosave lock until a fresh create is query-visible", async () => {
    vi.stubEnv("LORE_AUTOSAVE_LEARNING_POST_CREATE_STABILIZE_MS", "200")
    const events: string[] = []
    const querySpy = vi
      .fn()
      .mockImplementationOnce(async () => {
        events.push("preflight")
        return { results: [], has_more: false, next_cursor: null }
      })
      .mockImplementationOnce(async () => {
        events.push("stabilize-miss")
        return { results: [], has_more: false, next_cursor: null }
      })
      .mockImplementationOnce(async () => {
        events.push("stabilize-hit")
        return {
          results: [buildAutosaveLearningPage("mem-created")],
          has_more: false,
          next_cursor: null,
        }
      })
    const createSpy = vi.fn(async () => {
      events.push("create")
      return buildAutosaveLearningPage("mem-created")
    })
    const client = {
      dataSources: { query: querySpy },
      pages: {
        create: createSpy,
        updateMarkdown: vi.fn(),
        retrieveMarkdown: vi.fn(async () => ({
          markdown:
            "Notion dataSources.query rejects relation filters with empty arrays.",
        })),
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    try {
      const result = await service.createWithResult({
        title: "Relation filters reject empty arrays",
        content: "Notion dataSources.query rejects relation filters with empty arrays.",
        projectIds: ["proj-a"],
        source: "conversation",
        kind: "note",
        confidence: "likely",
        session: "session-2",
      })

      expect(result.memory.id).toBe("mem-created")
      expect(result.autosaveLearningDuplicate).toBeNull()
      expect(querySpy).toHaveBeenCalledTimes(3)
      expect(events).toEqual(["preflight", "create", "stabilize-miss", "stabilize-hit"])
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe("MemoryService.create — partial-failure on body write (issue #190)", () => {
  // The Notion SDK splits memory creation across two calls: properties
  // first via `pages.create`, body second via `pages.updateMarkdown`.
  // A failure between them used to leave a properties-only orphan that
  // a naive retry would duplicate. These pins cover the structured
  // partial-failure handling that replaced the silent-orphan behavior.
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function makePartialFailureClient(opts: {
    bodyWriteError: Error
    cleanupError?: Error
  }) {
    const createSpy = vi.fn(
      async (_args: { parent: unknown; properties: Record<string, unknown> }) => ({
        object: "page",
        id: "mem-orphan",
        created_time: "2026-05-02T00:00:00.000Z",
        last_edited_time: "2026-05-02T00:00:00.000Z",
        archived: false,
        properties: { Title: { type: "title", title: [{ plain_text: "x" }] } },
        parent: { type: "database_id", database_id: db.databaseId },
        url: "",
      })
    )
    const updateMarkdownSpy = vi.fn(async () => {
      throw opts.bodyWriteError
    })
    const updateSpy = vi.fn(
      async (_args: {
        page_id: string
        archived?: boolean
        properties?: Record<string, unknown>
      }) => {
        if (opts.cleanupError) throw opts.cleanupError
        return {}
      }
    )
    const client = {
      pages: {
        create: createSpy,
        updateMarkdown: updateMarkdownSpy,
        update: updateSpy,
      },
    } as unknown as Client
    return { client, createSpy, updateMarkdownSpy, updateSpy }
  }

  it("body-write failure with successful cleanup: archives the orphan and throws MemoryCreatePartialFailureError(cleanedUp=true)", async () => {
    const bodyWriteError = new Error("Notion body update failed (502)")
    const { client, updateSpy, updateMarkdownSpy } = makePartialFailureClient({
      bodyWriteError,
    })
    const service = new MemoryService(client, db)

    let caught: unknown
    try {
      await service.create({ title: "x", content: "body prose" })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(MemoryCreatePartialFailureError)
    const partial = caught as MemoryCreatePartialFailureError
    expect(partial.pageId).toBe("mem-orphan")
    expect(partial.cleanedUp).toBe(true)
    expect(partial.bodyWriteError).toBe(bodyWriteError)
    expect(partial.cleanupError).toBeUndefined()
    expect(partial.message).toMatch(/Memories DB row was created/)
    expect(partial.message).toContain("mem-orphan")
    // Tightened message (issue #477): the orphan is soft-archived AND
    // tagged with a sentinel keyword so a Notion-trash restore does
    // not re-introduce it as a dedup target. The old wording
    // ("archived to keep the vault consistent") falsely implied the
    // row had been removed from the recovery surface. The polished
    // wording closes with an outcome-shaped sentence the operator can
    // act on — "your retry will land cleanly" — instead of leaving
    // them to infer behavior from the implementation detail.
    expect(partial.message).toMatch(/soft-archived to Notion's trash/)
    expect(partial.message).toMatch(/__lore-cleanup-orphan/)
    expect(partial.message).toMatch(/restored from trash/)
    expect(partial.message).toMatch(/Your retry will land cleanly/)

    // Body write was attempted; cleanup archive followed. The cleanup
    // call writes BOTH `archived: true` AND the sentinel keyword in
    // a single atomic `pages.update` (issue #477) so an
    // archive-success / sentinel-write-failure split state is not
    // possible — Notion's API is per-request atomic. The fixture
    // create call passed no `keywords`, so the cleanup write is the
    // bare-sentinel branch; see the `preserves the caller's keywords`
    // test below for the concatenated-keywords branch.
    expect(updateMarkdownSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy.mock.calls[0]![0]).toEqual({
      page_id: "mem-orphan",
      archived: true,
      properties: {
        Keywords: {
          rich_text: [{ text: { content: "__lore-cleanup-orphan" } }],
        },
      },
    })
  })

  it("body-write failure with cleanup also failing: throws MemoryCreatePartialFailureError(cleanedUp=false) carrying both errors", async () => {
    // The orphan remains live in the vault. The error must surface the
    // page id AND the cleanup failure so an operator can finish what
    // the system couldn't, and the message must direct them to manual
    // archive before retry to avoid a duplicate row.
    const bodyWriteError = new Error("Notion body update failed (502)")
    const cleanupError = new Error("Notion archive failed (429)")
    const { client, updateSpy } = makePartialFailureClient({
      bodyWriteError,
      cleanupError,
    })
    const service = new MemoryService(client, db)

    let caught: unknown
    try {
      await service.create({ title: "x", content: "body prose" })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(MemoryCreatePartialFailureError)
    const partial = caught as MemoryCreatePartialFailureError
    expect(partial.pageId).toBe("mem-orphan")
    expect(partial.cleanedUp).toBe(false)
    expect(partial.bodyWriteError).toBe(bodyWriteError)
    expect(partial.cleanupError).toBe(cleanupError)
    expect(partial.message).toMatch(/cleanup archive also failed/)
    // Tightened wording (issue #477) directs the operator either to
    // archive manually OR to hard-delete from Notion's trash, since
    // the soft-archive recovery surface is what made the orphan
    // resurface vector exist in the first place.
    expect(partial.message).toMatch(/Archive it manually/)
    expect(partial.message).toMatch(/hard-delete from Notion's trash/)
    expect(partial.message).toContain("mem-orphan")

    // Cleanup archive was attempted exactly once even though it failed
    // — best-effort, not retried inside the create path.
    expect(updateSpy).toHaveBeenCalledTimes(1)
  })

  it("no body content: skips updateMarkdown entirely so a body-write surface cannot fail", async () => {
    // The partial-failure path is gated on `decoded.content`. A create
    // with no body must not touch `pages.updateMarkdown` at all — pin
    // the no-op so a future "always insert empty body" refactor can't
    // silently re-introduce the partial-failure surface for properties-
    // only memories (e.g. the wake-up digest's task-summary rows).
    const createSpy = vi.fn(
      async (_args: { parent: unknown; properties: Record<string, unknown> }) => ({
        object: "page",
        id: "mem-empty",
        created_time: "2026-05-02T00:00:00.000Z",
        last_edited_time: "2026-05-02T00:00:00.000Z",
        archived: false,
        properties: { Title: { type: "title", title: [{ plain_text: "x" }] } },
        parent: { type: "database_id", database_id: db.databaseId },
        url: "",
      })
    )
    const updateMarkdownSpy = vi.fn(async () => ({}))
    const updateSpy = vi.fn(async () => ({}))
    const client = {
      pages: {
        create: createSpy,
        updateMarkdown: updateMarkdownSpy,
        update: updateSpy,
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const result = await service.create({ title: "x", content: "" })

    expect(result.id).toBe("mem-empty")
    expect(updateMarkdownSpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("happy path: body write succeeds, no cleanup attempted", async () => {
    // Pins that the partial-failure path is dormant on the success
    // case — `pages.update` is NOT called when the body write resolves.
    // Without this pin, a future "always archive on create" refactor
    // could ship without anyone noticing.
    const createSpy = vi.fn(
      async (_args: { parent: unknown; properties: Record<string, unknown> }) => ({
        object: "page",
        id: "mem-ok",
        created_time: "2026-05-02T00:00:00.000Z",
        last_edited_time: "2026-05-02T00:00:00.000Z",
        archived: false,
        properties: { Title: { type: "title", title: [{ plain_text: "x" }] } },
        parent: { type: "database_id", database_id: db.databaseId },
        url: "",
      })
    )
    const updateMarkdownSpy = vi.fn(async () => ({}))
    const updateSpy = vi.fn(async () => ({}))
    const client = {
      pages: {
        create: createSpy,
        updateMarkdown: updateMarkdownSpy,
        update: updateSpy,
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const result = await service.create({ title: "x", content: "prose" })

    expect(result.id).toBe("mem-ok")
    expect(result.content).toBe("prose")
    expect(updateMarkdownSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("non-Error thrown values fall back through String() in the message", async () => {
    // Notion SDK rejections are typically `Error` instances, but
    // network-layer wrappers and custom retry shims can surface a
    // bare string or number. Pin the `String(...)` fallback path so
    // a future "throw new MyCustomError" refactor doesn't silently
    // regress message quality. The structured `bodyWriteError` field
    // still carries the raw value for callers that want it.
    const createSpy = vi.fn(
      async (_args: { parent: unknown; properties: Record<string, unknown> }) => ({
        object: "page",
        id: "mem-string-throw",
        created_time: "2026-05-02T00:00:00.000Z",
        last_edited_time: "2026-05-02T00:00:00.000Z",
        archived: false,
        properties: { Title: { type: "title", title: [{ plain_text: "x" }] } },
        parent: { type: "database_id", database_id: db.databaseId },
        url: "",
      })
    )
    const updateMarkdownSpy = vi.fn(async () => {
      throw "503 Service Unavailable"
    })
    const updateSpy = vi.fn(async () => ({}))
    const client = {
      pages: {
        create: createSpy,
        updateMarkdown: updateMarkdownSpy,
        update: updateSpy,
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    let caught: unknown
    try {
      await service.create({ title: "x", content: "prose" })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(MemoryCreatePartialFailureError)
    const partial = caught as MemoryCreatePartialFailureError
    expect(partial.bodyWriteError).toBe("503 Service Unavailable")
    expect(partial.message).toContain("503 Service Unavailable")
    expect(partial.cleanedUp).toBe(true)
  })

  it("pages.create rejection bubbles untouched: no cleanup, no body-write attempt, no structured wrap", async () => {
    // The partial-failure surface is gated on a SUCCESSFUL `pages.create`
    // followed by a FAILED body write. A rejection at the create call
    // means no orphan row exists — there is nothing to clean up, and
    // wrapping the create error in `MemoryCreatePartialFailureError`
    // would falsely imply a partial state that does not exist. Pin
    // the bubble-through behavior so a future "wrap every create
    // failure" refactor can't regress this.
    const createError = new Error("Notion 400: invalid relation")
    const createSpy = vi.fn(async () => {
      throw createError
    })
    const updateMarkdownSpy = vi.fn(async () => ({}))
    const updateSpy = vi.fn(async () => ({}))
    const client = {
      pages: {
        create: createSpy,
        updateMarkdown: updateMarkdownSpy,
        update: updateSpy,
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await expect(service.create({ title: "x", content: "prose" })).rejects.toBe(
      createError
    )

    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(updateMarkdownSpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("cleanup write tags the orphan with the cleanup-orphan sentinel in the same atomic update (issue #477)", async () => {
    // Notion's `archived: true` is a soft delete — within ~30 days an
    // operator restoring from the workspace trash reanimates the
    // properties-only orphan as a live row that `isLiveFullPage` no
    // longer excludes. The sentinel keyword survives archive/restore
    // round-trips and is the load-bearing signal for `findByTopicKey`,
    // `findNearDuplicates`, and `findAutosaveLearningDuplicate`
    // ignoring the resurfaced empty-body shell. Pin the atomic shape
    // so a future split-write refactor (archive in one call, sentinel
    // in another) cannot silently re-open the gap between the two
    // mutations.
    const bodyWriteError = new Error("Notion body update failed (502)")
    const { client, updateSpy } = makePartialFailureClient({ bodyWriteError })
    const service = new MemoryService(client, db)

    await service.create({ title: "x", content: "body prose" }).catch(() => {})

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const call = updateSpy.mock.calls[0]![0]
    expect(call).toMatchObject({
      page_id: "mem-orphan",
      archived: true,
      properties: {
        Keywords: {
          rich_text: [{ text: { content: "__lore-cleanup-orphan" } }],
        },
      },
    })
  })

  it("cleanup write preserves the caller's keywords by writing two rich_text segments (issue #477 review-feedback)", async () => {
    // Notion `rich_text` writes are full-replace, not append. Writing
    // only the sentinel would clobber whatever the caller passed in
    // `keywords`, leaving an operator inspecting Notion's trash with
    // "your original keywords are gone — only the sentinel survives."
    // Splitting into two segments — `[originalKeywords, " sentinel"]`
    // — preserves both: the substring filter still matches the sentinel
    // (Notion concatenates segments when evaluating `contains` /
    // `does_not_contain`), and the operator's content stays visible
    // if they restore to recover keywords. The two-segment form is
    // unconditional when keywords are present so the at-cap edge
    // (a 2000-char keyword string + the 22-char sentinel suffix would
    // exceed the per-segment cap) is handled by the same code path as
    // a short-keyword caller. Single-space separator keeps the
    // sentinel word-tokenizable in any future tag-aware view.
    const bodyWriteError = new Error("Notion body update failed (502)")
    const { client, updateSpy } = makePartialFailureClient({ bodyWriteError })
    const service = new MemoryService(client, db)

    await service
      .create({
        title: "x",
        content: "body prose",
        keywords: "auth, middleware",
      })
      .catch(() => {})

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const call = updateSpy.mock.calls[0]![0]
    expect(call.properties).toEqual({
      Keywords: {
        rich_text: [
          { text: { content: "auth, middleware" } },
          { text: { content: " __lore-cleanup-orphan" } },
        ],
      },
    })
  })

  it("cleanup write does not regress to cleanedUp=false when caller's keywords are at the segment cap (issue #477 review-feedback)", async () => {
    // The MCP boundary's `keywordsSchema` accepts keywords up to
    // exactly `RICH_TEXT_PROPERTY_MAX_LEN` (2000 chars). A naive
    // concatenated single-segment cleanup write
    // (`${atCap} __lore-cleanup-orphan`) would produce a 2022-char
    // segment that Notion rejects with a validation error — flipping
    // `cleanedUp` to `false` and leaving the orphan live in the vault.
    // This regresses exactly the partial-failure recovery path issue
    // #477 is meant to protect: a create payload that was valid before
    // the PR could no longer cleanly recover under the same body-write
    // failure scenario. The two-segment write keeps each segment well
    // under the cap.
    const atCapKeywords = "x".repeat(RICH_TEXT_PROPERTY_MAX_LEN)
    const bodyWriteError = new Error("Notion body update failed (502)")
    const { client, updateSpy } = makePartialFailureClient({ bodyWriteError })
    const service = new MemoryService(client, db)

    let caught: unknown
    try {
      await service.create({
        title: "x",
        content: "body prose",
        keywords: atCapKeywords,
      })
    } catch (err) {
      caught = err
    }

    // The partial-failure error must report cleanedUp=true — the
    // cleanup write succeeded.
    expect(caught).toBeInstanceOf(MemoryCreatePartialFailureError)
    const partial = caught as MemoryCreatePartialFailureError
    expect(partial.cleanedUp).toBe(true)

    // The cleanup write must include archived: true AND carry the
    // sentinel via a second segment so each rich_text segment stays
    // within the 2000-char cap.
    expect(updateSpy).toHaveBeenCalledTimes(1)
    const call = updateSpy.mock.calls[0]![0]
    expect(call.archived).toBe(true)
    const richText = (
      call.properties as { Keywords: { rich_text: Array<{ text: { content: string } }> } }
    ).Keywords.rich_text
    expect(richText).toEqual([
      { text: { content: atCapKeywords } },
      { text: { content: " __lore-cleanup-orphan" } },
    ])
    // Each segment must be ≤ the per-segment cap.
    for (const seg of richText) {
      expect(seg.text.content.length).toBeLessThanOrEqual(RICH_TEXT_PROPERTY_MAX_LEN)
    }
    // Concatenated form (what `extractRichText` returns) carries the
    // sentinel substring — the `does_not_contain` filter still excludes
    // a resurfaced row.
    const concat = richText.map((s) => s.text.content).join("")
    expect(concat.includes("__lore-cleanup-orphan")).toBe(true)
  })

  it("cleanup write collapses to bare sentinel when the caller's keywords are whitespace-only (issue #477 review-feedback)", async () => {
    // Whitespace-only `keywords` is structurally indistinguishable from
    // empty for the purposes of the concatenated form — a bare-sentinel
    // write is preferred to preserve the simplest filter contract.
    // Without this guard, a stray space in the caller's input would
    // produce a leading-space keyword (`" __lore-cleanup-orphan"`)
    // that's still substring-matched but visually noisy.
    const bodyWriteError = new Error("Notion body update failed (502)")
    const { client, updateSpy } = makePartialFailureClient({ bodyWriteError })
    const service = new MemoryService(client, db)

    await service
      .create({ title: "x", content: "body prose", keywords: "   " })
      .catch(() => {})

    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy.mock.calls[0]![0].properties).toEqual({
      Keywords: {
        rich_text: [{ text: { content: "__lore-cleanup-orphan" } }],
      },
    })
  })

  it("archive→restore round-trip: orphan is soft-archived with sentinel, restoring it from trash leaves the sentinel in place, and findByTopicKey filters it out (issue #477)", async () => {
    // Bug repro from the original issue. Steps:
    //   1. createFresh body-write fails → cleanup archive lands sentinel
    //   2. Operator restores the orphan from Notion's workspace trash
    //   3. The next lore-memory action='save' against the same topic key
    //      runs findByTopicKey
    //   4. WITHOUT the fix, the resurfaced row matches the topic-key
    //      query and the upsert path appends a revision to an
    //      empty-body shell; WITH the fix, the server-side
    //      `Keywords does_not_contain` filter excludes the row before
    //      it can reach the upsert path.
    //
    // The previous tests collapsed step 2 (restore) into the fixture by
    // building a "live" row with the keyword preset — they confirm the
    // probes filter the row but not that the property survives the
    // archive/restore round-trip. This test wires steps 1→4 end-to-end
    // through a single client mock so the keyword written in step 1 is
    // the same keyword the query in step 4 has to filter on.

    // Step 1: simulate the partial-failure cleanup write.
    const bodyWriteError = new Error("Notion body update failed (502)")
    const { client: createClient, updateSpy: createUpdateSpy } =
      makePartialFailureClient({ bodyWriteError })
    const createService = new MemoryService(createClient, db)
    await createService
      .create({
        title: "Decision: replace auth middleware",
        content: "body prose",
        keywords: "auth",
      })
      .catch(() => {})
    expect(createUpdateSpy).toHaveBeenCalledTimes(1)
    const cleanupCall = createUpdateSpy.mock.calls[0]![0]
    const cleanupKeywordsProp = (
      cleanupCall.properties as { Keywords: { rich_text: Array<{ text: { content: string } }> } }
    ).Keywords
    // The cleanup write uses two rich_text segments when keywords are
    // present (issue #477 review-feedback) so the at-cap edge cannot
    // overflow the 2000-char Notion segment cap. Concatenating the
    // segments mirrors `extractRichText` semantics — what Notion
    // returns on read is the joined string, which is what the
    // server-side `does_not_contain` filter and JS `keywords.includes`
    // post-filter both see.
    const archivedKeywords = cleanupKeywordsProp.rich_text
      .map((seg) => seg.text.content)
      .join("")
    expect(archivedKeywords).toBe("auth __lore-cleanup-orphan")

    // Steps 2–4: build a query client whose dataSources.query response
    // ignores the does_not_contain filter (i.e. simulates a Notion API
    // that returns the row regardless), confirms the filter is REQUESTED,
    // AND confirms the test's understanding of Notion's filter semantics
    // is what `findByTopicKey` relies on. The presence of the sentinel
    // in the request filter is the contract — Notion enforces the
    // exclusion server-side.
    const restoredOrphan: PageObjectResponse = {
      object: "page",
      id: "mem-orphan-resurfaced",
      created_time: "2026-04-01T00:00:00.000Z",
      last_edited_time: "2026-05-04T00:00:00.000Z",
      archived: false, // restored from trash
      in_trash: false,
      parent: { type: "database_id", database_id: db.databaseId },
      properties: {
        Title: {
          id: "title",
          type: "title",
          title: [
            {
              type: "text",
              text: { content: "Decision: replace auth middleware", link: null },
              plain_text: "Decision: replace auth middleware",
              annotations: {
                bold: false,
                italic: false,
                strikethrough: false,
                underline: false,
                code: false,
                color: "default",
              },
              href: null,
            },
          ],
        },
        Project: {
          id: "project",
          type: "relation",
          relation: [{ id: "P1" }],
          has_more: false,
        },
        "Topic Key": {
          id: "topic-key",
          type: "rich_text",
          rich_text: [
            {
              type: "text",
              text: { content: "decision/auth-middleware", link: null },
              plain_text: "decision/auth-middleware",
              annotations: {
                bold: false,
                italic: false,
                strikethrough: false,
                underline: false,
                code: false,
                color: "default",
              },
              href: null,
            },
          ],
        },
        Keywords: {
          id: "keywords",
          type: "rich_text",
          rich_text: [
            {
              type: "text",
              text: { content: archivedKeywords, link: null },
              plain_text: archivedKeywords,
              annotations: {
                bold: false,
                italic: false,
                strikethrough: false,
                underline: false,
                code: false,
                color: "default",
              },
              href: null,
            },
          ],
        },
      },
      url: "",
      public_url: null,
      cover: null,
      icon: null,
    } as unknown as PageObjectResponse

    // The mock does NOT filter — it returns the orphan. The contract
    // we're pinning is that `findByTopicKey` REQUESTED the
    // `does_not_contain` filter; the server-side Notion enforcement
    // is what the integration relies on. (Real-vault behavior was
    // verified by the author; see the cleanupOrphanExclusionFilter
    // docstring in memory.ts for the verification record.)
    let capturedFilter: unknown
    const querySpy = vi.fn(async (args: { filter?: unknown }) => {
      capturedFilter = args.filter
      return { results: [restoredOrphan], has_more: false, next_cursor: null }
    })
    const queryClient = {
      dataSources: { query: querySpy },
    } as unknown as Client
    const queryService = new MemoryService(queryClient, db)

    await queryService.findByTopicKey({
      topicKey: "decision/auth-middleware",
      projectIds: ["P1"],
    })

    // Pin: the request that reaches Notion includes the
    // does_not_contain clause, so a Notion-side enforcement excludes
    // the resurfaced orphan before it ever reaches the JS layer.
    const filter = capturedFilter as { and: Array<Record<string, unknown>> }
    expect(filter.and).toContainEqual({
      property: "Keywords",
      rich_text: { does_not_contain: "__lore-cleanup-orphan" },
    })
  })
})

describe("MemoryService.update — Confidence Score write semantics (#01)", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function makeUpdateClient() {
    const updateSpy = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => ({})
    )
    const retrieveSpy = vi.fn(async () => ({
      object: "page",
      id: "mem-1",
      created_time: "2026-04-20T00:00:00.000Z",
      last_edited_time: "2026-04-20T00:00:00.000Z",
      archived: false,
      properties: {
        Title: { type: "title", title: [{ plain_text: "x" }] },
      },
      parent: { type: "database_id", database_id: db.databaseId },
      url: "",
    }))
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "" }))
    const client = {
      pages: {
        update: updateSpy,
        retrieve: retrieveSpy,
        retrieveMarkdown: retrieveMarkdownSpy,
      },
    } as unknown as Client
    return { client, updateSpy, retrieveSpy }
  }

  it("writes `{ number: <value> }` when confidenceScore is a number", async () => {
    const { client, updateSpy } = makeUpdateClient()
    const service = new MemoryService(client, db)

    await service.update("mem-1", { confidenceScore: 0.85 })

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const props = updateSpy.mock.calls[0]![0].properties
    expect(props["Confidence Score"]).toEqual({ number: 0.85 })
  })

  it("writes `{ number: null }` when confidenceScore is explicitly null (clear)", async () => {
    const { client, updateSpy } = makeUpdateClient()
    const service = new MemoryService(client, db)

    await service.update("mem-1", { confidenceScore: null })

    const props = updateSpy.mock.calls[0]![0].properties
    expect(props["Confidence Score"]).toEqual({ number: null })
  })

  it("does NOT touch the column when confidenceScore is omitted (undefined leaves it untouched)", async () => {
    // A `Title`-only update must leave the Confidence Score column
    // entirely alone — both the touch-on-read helper (#03) and the
    // contradiction-decrement path (#06) rely on this distinction so
    // they can co-exist with title/body edits without clobbering the
    // system-managed signal.
    const { client, updateSpy } = makeUpdateClient()
    const service = new MemoryService(client, db)

    await service.update("mem-1", { title: "new title" })

    const props = updateSpy.mock.calls[0]![0].properties
    expect("Confidence Score" in props).toBe(false)
  })

  it("preserves zero as a valid write target", async () => {
    const { client, updateSpy } = makeUpdateClient()
    const service = new MemoryService(client, db)

    await service.update("mem-1", { confidenceScore: 0 })

    const props = updateSpy.mock.calls[0]![0].properties
    expect(props["Confidence Score"]).toEqual({ number: 0 })
  })
})

describe("MemoryService.update — rich_text metadata cap", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }
  type RichTextFieldCase = readonly [string, (value: string) => UpdateMemoryInput, string]
  type RejectCase = readonly [string, UpdateMemoryInput, number]

  const richTextFields: RichTextFieldCase[] = [
    ["alternatives", (value: string) => ({ alternatives: value }), "Alternatives"],
    ["consequences", (value: string) => ({ consequences: value }), "Consequences"],
    ["keywords", (value: string) => ({ keywords: value }), "Keywords"],
    ["blockedBy", (value: string) => ({ blockedBy: value }), "Blocked By"],
    ["entity", (value: string) => ({ entity: value }), "Entity"],
  ]
  const rejectCases: RejectCase[] = [
    ...richTextFields.map(
      ([field, buildInput]) =>
        [
          field,
          buildInput("x".repeat(RICH_TEXT_PROPERTY_MAX_LEN + 1)),
          RICH_TEXT_PROPERTY_MAX_LEN,
        ] as const
    ),
    ["synopsis", { synopsis: "x".repeat(SYNOPSIS_MAX + 1) }, SYNOPSIS_MAX],
  ]

  function makeUpdateClient() {
    const updateSpy = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => ({})
    )
    const retrieveSpy = vi.fn(async () =>
      buildPage(
        {
          Title: { type: "title", title: [{ plain_text: "Memory" }] },
          Project: { type: "relation", relation: [] },
          Topic: { type: "relation", relation: [] },
          Source: { type: "select", select: { name: "manual" } },
        },
        { id: "mem-1" }
      )
    )
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "" }))
    const client = {
      pages: {
        update: updateSpy,
        retrieve: retrieveSpy,
        retrieveMarkdown: retrieveMarkdownSpy,
      },
    } as unknown as Client
    return { client, updateSpy, retrieveSpy, retrieveMarkdownSpy }
  }

  it.each(richTextFields)(
    "accepts %s at the Notion rich_text cap",
    async (_field, buildInput, propertyName) => {
      const { client, updateSpy } = makeUpdateClient()
      const service = new MemoryService(client, db)
      const atCap = "x".repeat(RICH_TEXT_PROPERTY_MAX_LEN)

      await service.update("mem-1", buildInput(atCap))

      const props = updateSpy.mock.calls[0]![0].properties as Record<
        string,
        { rich_text: Array<{ text: { content: string } }> }
      >
      expect(props[propertyName].rich_text[0].text.content).toBe(atCap)
    }
  )

  it("accepts synopsis at SYNOPSIS_MAX", async () => {
    const { client, updateSpy } = makeUpdateClient()
    const service = new MemoryService(client, db)
    const atCap = "x".repeat(SYNOPSIS_MAX)

    await service.update("mem-1", { synopsis: atCap })

    const props = updateSpy.mock.calls[0]![0].properties as {
      Synopsis: { rich_text: Array<{ text: { content: string } }> }
    }
    expect(props.Synopsis.rich_text[0].text.content).toBe(atCap)
  })

  it.each(rejectCases)(
    "rejects over-cap %s before any Notion write",
    async (field, input, cap) => {
      const { client, updateSpy, retrieveSpy, retrieveMarkdownSpy } = makeUpdateClient()
      const service = new MemoryService(client, db)

      await expect(service.update("mem-1", input)).rejects.toThrow(
        new RegExp(`MemoryService\\.update.*${field}.*${cap}`)
      )
      expect(updateSpy).not.toHaveBeenCalled()
      expect(retrieveSpy).not.toHaveBeenCalled()
      expect(retrieveMarkdownSpy).not.toHaveBeenCalled()
    }
  )
})

describe("MemoryService.update — partial-failure on body write", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  it("throws a structured partial-failure error when properties land but body write fails", async () => {
    const bodyWriteError = new Error("notion 503")
    const updateSpy = vi.fn(async () => ({}))
    const updateMarkdownSpy = vi.fn().mockRejectedValue(bodyWriteError)
    const retrieveSpy = vi.fn()
    const retrieveMarkdownSpy = vi.fn()
    const client = {
      pages: {
        update: updateSpy,
        updateMarkdown: updateMarkdownSpy,
        retrieve: retrieveSpy,
        retrieveMarkdown: retrieveMarkdownSpy,
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    let caught: unknown
    try {
      await service.update("mem-1", {
        title: "Updated title",
        content: "Updated body",
      })
    } catch (err) {
      caught = err
    }

    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateMarkdownSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy.mock.invocationCallOrder[0]).toBeLessThan(
      updateMarkdownSpy.mock.invocationCallOrder[0]
    )
    expect(retrieveSpy).not.toHaveBeenCalled()
    expect(retrieveMarkdownSpy).not.toHaveBeenCalled()
    expect(caught).toBeInstanceOf(MemoryUpdatePartialFailureError)
    const partial = caught as MemoryUpdatePartialFailureError
    expect(partial.memoryId).toBe("mem-1")
    expect(partial.failedPhase).toBe("body")
    expect(partial.persisted).toEqual({ properties: true, body: false })
    expect(partial.bodyWriteError).toBe(bodyWriteError)
    expect(partial.message).toContain("properties for memory mem-1 persisted")
    expect(partial.message).toContain('phase "body"')
    expect(partial.message).toContain("body content was not written")

    const cachedTitle = await service.getTitleById("mem-1")
    expect(cachedTitle).toBe("Updated title")
    expect(retrieveSpy).not.toHaveBeenCalled()
  })

  it("treats empty content as an explicit body clear on the partial-failure path", async () => {
    const bodyWriteError = new Error("notion 503")
    const updateSpy = vi.fn(async () => ({}))
    const updateMarkdownSpy = vi.fn().mockRejectedValue(bodyWriteError)
    const client = {
      pages: {
        update: updateSpy,
        updateMarkdown: updateMarkdownSpy,
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    let caught: unknown
    try {
      await service.update("mem-1", {
        title: "Updated title",
        content: "",
      })
    } catch (err) {
      caught = err
    }

    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateMarkdownSpy).toHaveBeenCalledTimes(1)
    expect(updateMarkdownSpy.mock.calls[0]![0].replace_content.new_str).toBe("")
    expect(caught).toBeInstanceOf(MemoryUpdatePartialFailureError)
    const partial = caught as MemoryUpdatePartialFailureError
    expect(partial.persisted).toEqual({ properties: true, body: false })
    expect(partial.bodyWriteError).toBe(bodyWriteError)
  })

  it("does not wrap body-only failures because no earlier update persisted", async () => {
    const bodyWriteError = new Error("notion 503")
    const updateSpy = vi.fn()
    const updateMarkdownSpy = vi.fn().mockRejectedValue(bodyWriteError)
    const client = {
      pages: {
        update: updateSpy,
        updateMarkdown: updateMarkdownSpy,
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await expect(service.update("mem-1", { content: "Updated body" })).rejects.toBe(
      bodyWriteError
    )
    expect(updateSpy).not.toHaveBeenCalled()
    expect(updateMarkdownSpy).toHaveBeenCalledTimes(1)
  })

  it("includes non-Error body-write rejections in the structured message", async () => {
    const bodyWriteError = "notion string failure"
    const updateSpy = vi.fn(async () => ({}))
    const updateMarkdownSpy = vi.fn().mockRejectedValue(bodyWriteError)
    const client = {
      pages: {
        update: updateSpy,
        updateMarkdown: updateMarkdownSpy,
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    let caught: unknown
    try {
      await service.update("mem-1", {
        title: "Updated title",
        content: "Updated body",
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(MemoryUpdatePartialFailureError)
    const partial = caught as MemoryUpdatePartialFailureError
    expect(partial.bodyWriteError).toBe(bodyWriteError)
    expect(partial.message).toContain("notion string failure")
  })

  it("keeps body-only empty-content failures raw because no earlier update persisted", async () => {
    const bodyWriteError = new Error("notion 503")
    const updateSpy = vi.fn()
    const updateMarkdownSpy = vi.fn().mockRejectedValue(bodyWriteError)
    const client = {
      pages: {
        update: updateSpy,
        updateMarkdown: updateMarkdownSpy,
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await expect(service.update("mem-1", { content: "" })).rejects.toBe(bodyWriteError)
    expect(updateSpy).not.toHaveBeenCalled()
    expect(updateMarkdownSpy).toHaveBeenCalledTimes(1)
    expect(updateMarkdownSpy.mock.calls[0]![0].replace_content.new_str).toBe("")
  })
})

describe("Synopsis property round-trip", () => {
  it("round-trips a Synopsis string through buildMemoryProps + pageToMemory", () => {
    const synopsis = "Adopt DecisionService so rationale chains stay traversable."
    const built = buildMemoryProps({ title: "x", synopsis }) as Record<
      string,
      { rich_text: Array<{ text: { content: string } }> }
    >

    const richTextProp = built["Synopsis"]
    expect(richTextProp).toBeDefined()
    expect(richTextProp.rich_text[0].text.content).toBe(synopsis)

    const liveShape = {
      type: "rich_text" as const,
      rich_text: richTextProp.rich_text.map((segment) => ({
        plain_text: segment.text.content,
      })),
    }
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "x" }] },
      Synopsis: liveShape,
    })
    expect(pageToMemory(page).synopsis).toBe(synopsis)
  })

  it("omits the Synopsis property when the input is undefined (unchanged semantic)", () => {
    const built = buildMemoryProps({ title: "x" }) as Record<string, unknown>
    expect("Synopsis" in built).toBe(false)
  })

  it("emits a Synopsis property when explicitly set to empty (clears the field)", () => {
    const built = buildMemoryProps({ title: "x", synopsis: "" }) as Record<
      string,
      unknown
    >
    expect("Synopsis" in built).toBe(true)
  })

  it("returns empty string on a pre-migration page with no Synopsis column", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Old" }] },
    })
    expect(pageToMemory(page).synopsis).toBe("")
  })
})

describe("Confidence Score / Last Referenced At — buildMemoryProps three-state semantics", () => {
  it("omits both properties when the inputs are undefined (untouched)", () => {
    const built = buildMemoryProps({ title: "x" }) as Record<string, unknown>
    expect("Confidence Score" in built).toBe(false)
    expect("Last Referenced At" in built).toBe(false)
  })

  it("emits null clears when explicitly set to null", () => {
    const built = buildMemoryProps({
      title: "x",
      confidenceScore: null,
      lastReferencedAt: null,
    }) as Record<string, unknown>
    expect(built["Confidence Score"]).toEqual({ number: null })
    expect(built["Last Referenced At"]).toEqual({ date: null })
  })

  it("emits the value when set to a number / ISO date", () => {
    const built = buildMemoryProps({
      title: "x",
      confidenceScore: 0.85,
      lastReferencedAt: "2026-04-29",
    }) as Record<string, unknown>
    expect(built["Confidence Score"]).toEqual({ number: 0.85 })
    expect(built["Last Referenced At"]).toEqual({
      date: { start: "2026-04-29" },
    })
  })
})

describe("Keywords property round-trip", () => {
  // The schema builder emits a `rich_text` property with a single text
  // segment. The live Notion response fills that in with `plain_text`; we
  // reconstruct the same shape here so `pageToMemory` can consume it.
  it("round-trips a Keywords string through buildMemoryProps + pageToMemory", () => {
    const keywords = "pr-1234 WidgetListStore.swift SENTRY-APP-123"
    const built = buildMemoryProps({ title: "x", keywords }) as Record<
      string,
      { rich_text: Array<{ text: { content: string } }> }
    >

    const richTextProp = built["Keywords"]
    expect(richTextProp).toBeDefined()
    expect(richTextProp.rich_text[0].text.content).toBe(keywords)

    const liveShape = {
      type: "rich_text" as const,
      rich_text: richTextProp.rich_text.map((segment) => ({
        plain_text: segment.text.content,
      })),
    }
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "x" }] },
      Keywords: liveShape,
    })
    expect(pageToMemory(page).keywords).toBe(keywords)
  })

  it("omits the Keywords property when the input is undefined (unchanged semantic)", () => {
    const built = buildMemoryProps({ title: "x" }) as Record<string, unknown>
    expect("Keywords" in built).toBe(false)
  })

  it("emits a Keywords property when explicitly set to empty (clears the field)", () => {
    const built = buildMemoryProps({ title: "x", keywords: "" }) as Record<
      string,
      unknown
    >
    expect("Keywords" in built).toBe(true)
  })
})

describe("Last Referenced At property round-trip (0.8.0/02)", () => {
  it("round-trips a YYYY-MM-DD value through buildMemoryProps + pageToMemory", () => {
    const built = buildMemoryProps({
      title: "x",
      lastReferencedAt: "2026-04-29",
    }) as Record<string, { date: { start: string } | null }>

    expect(built["Last Referenced At"]).toEqual({ date: { start: "2026-04-29" } })

    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "x" }] },
      "Last Referenced At": {
        type: "date",
        date: { start: "2026-04-29" },
      },
    })
    expect(pageToMemory(page).lastReferencedAt).toBe("2026-04-29")
  })

  it("returns null on a pre-migration page that has no Last Referenced At column", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Old" }] },
    })
    expect(pageToMemory(page).lastReferencedAt).toBeNull()
  })
})

describe("MemoryService.create / update — lastReferencedAt three-state semantics (0.8.0/02)", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function makeCreateClient() {
    const createSpy = vi.fn(async (_args: { properties: Record<string, unknown> }) => ({
      object: "page",
      id: "new-id",
      created_time: "2026-04-29T00:00:00.000Z",
      last_edited_time: "2026-04-29T00:00:00.000Z",
      archived: false,
      properties: {},
      parent: { type: "database_id", database_id: db.databaseId },
      url: "https://notion.so/new-id",
    }))
    const updateSpy = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => ({})
    )
    const updateMarkdownSpy = vi.fn(async () => ({}))
    const retrieveSpy = vi.fn(async () => ({
      object: "page",
      id: "existing-id",
      created_time: "2026-04-29T00:00:00.000Z",
      last_edited_time: "2026-04-29T00:00:00.000Z",
      archived: false,
      properties: {
        Title: { type: "title", title: [{ plain_text: "x" }] },
      },
      parent: { type: "database_id", database_id: db.databaseId },
      url: "https://notion.so/existing-id",
    }))
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "" }))
    const client = {
      pages: {
        create: createSpy,
        update: updateSpy,
        updateMarkdown: updateMarkdownSpy,
        retrieve: retrieveSpy,
        retrieveMarkdown: retrieveMarkdownSpy,
      },
    } as unknown as Client
    return { client, createSpy, updateSpy }
  }

  it("create() writes the Last Referenced At date when lastReferencedAt is provided", async () => {
    const { client, createSpy } = makeCreateClient()
    const service = new MemoryService(client, db)

    await service.create({
      title: "x",
      content: "",
      lastReferencedAt: "2026-04-29",
    })

    const props = createSpy.mock.calls[0]![0].properties as Record<
      string,
      { date: { start: string } | null }
    >
    expect(props["Last Referenced At"]).toEqual({ date: { start: "2026-04-29" } })
  })

  it("update() with lastReferencedAt: null clears the column (date:null)", async () => {
    const { client, updateSpy } = makeCreateClient()
    const service = new MemoryService(client, db)

    await service.update("existing-id", { lastReferencedAt: null })

    const props = updateSpy.mock.calls[0]![0].properties as Record<
      string,
      { date: { start: string } | null }
    >
    expect(props["Last Referenced At"]).toEqual({ date: null })
  })

  it("update() without lastReferencedAt leaves the column untouched (no Last Referenced At in props)", async () => {
    const { client, updateSpy } = makeCreateClient()
    const service = new MemoryService(client, db)

    await service.update("existing-id", { title: "y" })

    // No update is issued at all when no fields apart from title flow
    // through; the title path triggers a single `pages.update`. The Last
    // Referenced At key must not appear in that payload.
    expect(updateSpy).toHaveBeenCalledTimes(1)
    const props = updateSpy.mock.calls[0]![0].properties as Record<string, unknown>
    expect("Last Referenced At" in props).toBe(false)
  })

  it("update() with lastReferencedAt: 'YYYY-MM-DD' writes the date through", async () => {
    const { client, updateSpy } = makeCreateClient()
    const service = new MemoryService(client, db)

    await service.update("existing-id", { lastReferencedAt: "2026-04-29" })

    const props = updateSpy.mock.calls[0]![0].properties as Record<
      string,
      { date: { start: string } | null }
    >
    expect(props["Last Referenced At"]).toEqual({ date: { start: "2026-04-29" } })
  })
})

describe("Topic Key + Revision Count property round-trip (0.9.0/01)", () => {
  it("returns empty string for topicKey on a pre-migration page with no Topic Key column", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Pre-migration" }] },
    })
    expect(pageToMemory(page).topicKey).toBe("")
  })

  it("returns 1 for revisionCount on a pre-migration page with no Revision Count column", () => {
    // Legacy rows have null in the column — every existing row has been
    // saved exactly once, so the coalesced default is 1. #10's render
    // uses `>= 2` as the threshold for surfacing the count, so legacy
    // rows surface no `rev` line.
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Pre-migration" }] },
    })
    expect(pageToMemory(page).revisionCount).toBe(1)
  })

  it("returns 1 when Revision Count column is present-but-empty (null on Notion's side)", () => {
    // Distinct from confidenceScore which preserves null — Revision
    // Count carries no "uninitialized" semantic; the row exists, so
    // it has been saved at least once.
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Cleared" }] },
      "Revision Count": { type: "number", number: null },
    })
    expect(pageToMemory(page).revisionCount).toBe(1)
  })

  it("extracts a populated topicKey", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Decision" }] },
      "Topic Key": {
        type: "rich_text",
        rich_text: [{ plain_text: "decision/jwt-auth-model" }],
      },
    })
    expect(pageToMemory(page).topicKey).toBe("decision/jwt-auth-model")
  })

  it("extracts a populated revisionCount", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Revised" }] },
      "Revision Count": { type: "number", number: 5 },
    })
    expect(pageToMemory(page).revisionCount).toBe(5)
  })

  it("round-trips topicKey through buildMemoryProps + pageToMemory", () => {
    const built = buildMemoryProps({
      title: "x",
      topicKey: "runbook/database-migration",
    }) as Record<string, { rich_text: Array<{ text: { content: string } }> }>

    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "x" }] },
      "Topic Key": {
        type: "rich_text",
        rich_text: built["Topic Key"].rich_text.map((seg) => ({
          plain_text: seg.text.content,
        })),
      },
    })
    expect(pageToMemory(page).topicKey).toBe("runbook/database-migration")
  })

  it("round-trips revisionCount through buildMemoryProps + pageToMemory", () => {
    const built = buildMemoryProps({ title: "x", revisionCount: 7 }) as Record<
      string,
      { number: number }
    >
    expect(built["Revision Count"]).toEqual({ number: 7 })

    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "x" }] },
      "Revision Count": { type: "number", number: built["Revision Count"].number },
    })
    expect(pageToMemory(page).revisionCount).toBe(7)
  })
})

describe("MemoryService.findByTopicKey (0.9.0/01)", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  /** Build a minimum Memory page for fixture queries. */
  function buildTopicKeyPage(
    id: string,
    opts: {
      topicKey: string
      projectIds: string[]
      revisionCount?: number
      lastReferencedAt?: string | null
      archived?: boolean
    }
  ): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: id }] },
        Project: {
          type: "relation",
          relation: opts.projectIds.map((pid) => ({ id: pid })),
        },
        "Topic Key": {
          type: "rich_text",
          rich_text: [{ plain_text: opts.topicKey }],
        },
        ...(opts.revisionCount !== undefined && {
          "Revision Count": { type: "number", number: opts.revisionCount },
        }),
        ...(opts.lastReferencedAt !== undefined && {
          "Last Referenced At": {
            type: "date",
            date:
              opts.lastReferencedAt === null ? null : { start: opts.lastReferencedAt },
          },
        }),
      },
      { id, archived: opts.archived ?? false }
    )
  }

  /** Stub `dataSources.query` returning a fixed set of pages, optionally
   *  paginated across multiple Notion pages. */
  function makeQueryClient(
    pages: Array<{
      results: PageObjectResponse[]
      has_more?: boolean
      next_cursor?: string | null
    }>
  ) {
    let callIndex = 0
    const querySpy = vi.fn(
      async (_args: {
        data_source_id: string
        filter?: unknown
        start_cursor?: string
      }) => {
        const result = pages[callIndex]
        callIndex++
        return {
          results: result?.results ?? [],
          has_more: result?.has_more ?? false,
          next_cursor: result?.next_cursor ?? null,
        }
      }
    )
    const client = {
      dataSources: { query: querySpy },
    } as unknown as Client
    return { client, querySpy }
  }

  it("returns null without issuing any Notion query when projectIds is empty", async () => {
    const { client, querySpy } = makeQueryClient([])
    const service = new MemoryService(client, db)

    const result = await service.findByTopicKey({
      topicKey: "decision/anything",
      projectIds: [],
    })

    expect(result).toBeNull()
    expect(querySpy).not.toHaveBeenCalled()
  })

  it("returns null without issuing any Notion query when topicKey is the empty string", async () => {
    // Without this guard, `rich_text: { equals: "" }` matches every
    // legacy row whose Topic Key column is empty (i.e. every
    // pre-#06 memory). The project-set post-filter would narrow to
    // the project's most-recently-referenced legacy memory — the
    // helper would silently return an unrelated row that #06's
    // upsert would then append a revision onto. Empty topicKey is
    // the same class of foot-gun as empty projectIds; both must
    // short-circuit before any Notion call.
    const { client, querySpy } = makeQueryClient([])
    const service = new MemoryService(client, db)

    const result = await service.findByTopicKey({
      topicKey: "",
      projectIds: ["P1"],
    })

    expect(result).toBeNull()
    expect(querySpy).not.toHaveBeenCalled()
  })

  it("returns the single matching memory under a one-project query", async () => {
    const { client } = makeQueryClient([
      {
        results: [
          buildTopicKeyPage("mem-1", {
            topicKey: "decision/foo",
            projectIds: ["P1"],
            revisionCount: 1,
          }),
        ],
      },
    ])
    const service = new MemoryService(client, db)

    const result = await service.findByTopicKey({
      topicKey: "decision/foo",
      projectIds: ["P1"],
    })
    expect(result?.id).toBe("mem-1")
  })

  it("enforces project-set EQUALITY: a query for [P1] excludes a memory in [P1, P2]", async () => {
    // Notion's relation filter only supports `contains`, so the query
    // would naively match any memory whose Project relation includes
    // P1. The JS post-filter narrows to true equality.
    const { client } = makeQueryClient([
      {
        results: [
          buildTopicKeyPage("mem-extra", {
            topicKey: "decision/foo",
            projectIds: ["P1", "P2"],
          }),
        ],
      },
    ])
    const service = new MemoryService(client, db)

    const result = await service.findByTopicKey({
      topicKey: "decision/foo",
      projectIds: ["P1"],
    })
    expect(result).toBeNull()
  })

  it("symmetric: a query for [P1, P2] excludes a memory in [P1]", async () => {
    const { client } = makeQueryClient([
      {
        results: [
          buildTopicKeyPage("mem-fewer", {
            topicKey: "decision/foo",
            projectIds: ["P1"],
          }),
        ],
      },
    ])
    const service = new MemoryService(client, db)

    const result = await service.findByTopicKey({
      topicKey: "decision/foo",
      projectIds: ["P1", "P2"],
    })
    expect(result).toBeNull()
  })

  it("project-order independence: [P2, P1] matches a memory in [P1, P2]", async () => {
    const { client } = makeQueryClient([
      {
        results: [
          buildTopicKeyPage("mem-both", {
            topicKey: "decision/foo",
            projectIds: ["P1", "P2"],
          }),
        ],
      },
    ])
    const service = new MemoryService(client, db)

    const result = await service.findByTopicKey({
      topicKey: "decision/foo",
      projectIds: ["P2", "P1"],
    })
    expect(result?.id).toBe("mem-both")
  })

  it("excludes archived rows: a vault with one archived match returns null", async () => {
    // `dataSources.query` cannot filter on the page-metadata `archived`
    // flag, so the JS post-filter handles it. Without this filter,
    // archived candidates would surface as if they were live.
    const { client } = makeQueryClient([
      {
        results: [
          buildTopicKeyPage("mem-archived", {
            topicKey: "decision/foo",
            projectIds: ["P1"],
            archived: true,
          }),
        ],
      },
    ])
    const service = new MemoryService(client, db)

    const result = await service.findByTopicKey({
      topicKey: "decision/foo",
      projectIds: ["P1"],
    })
    expect(result).toBeNull()
  })

  it("orders by Revision Count desc — row with Revision Count 5 wins over Revision Count 3", async () => {
    const { client } = makeQueryClient([
      {
        results: [
          buildTopicKeyPage("low-rev", {
            topicKey: "decision/foo",
            projectIds: ["P1"],
            revisionCount: 3,
          }),
          buildTopicKeyPage("high-rev", {
            topicKey: "decision/foo",
            projectIds: ["P1"],
            revisionCount: 5,
          }),
        ],
      },
    ])
    const service = new MemoryService(client, db)

    const result = await service.findByTopicKey({
      topicKey: "decision/foo",
      projectIds: ["P1"],
    })
    expect(result?.id).toBe("high-rev")
  })

  it("tiebreaker by Last Referenced At desc when Revision Count is equal", async () => {
    const { client } = makeQueryClient([
      {
        results: [
          buildTopicKeyPage("older", {
            topicKey: "decision/foo",
            projectIds: ["P1"],
            revisionCount: 2,
            lastReferencedAt: "2026-01-15",
          }),
          buildTopicKeyPage("newer", {
            topicKey: "decision/foo",
            projectIds: ["P1"],
            revisionCount: 2,
            lastReferencedAt: "2026-04-29",
          }),
        ],
      },
    ])
    const service = new MemoryService(client, db)

    const result = await service.findByTopicKey({
      topicKey: "decision/foo",
      projectIds: ["P1"],
    })
    expect(result?.id).toBe("newer")
  })

  it("tiebreaker degenerates gracefully when both rows have null Last Referenced At — returns the first input", async () => {
    // Two legacy rows (pre-touchOnRead, pre-#11 backfill) tie on
    // Revision Count AND on a null Last Referenced At. The tiebreaker
    // sort uses `(b.lastReferencedAt ?? "").localeCompare(a.lastReferencedAt ?? "")`
    // which produces a stable 0 when both sides are null —
    // Array.prototype.sort is stable in ES2019+, so original order
    // wins. Pinning the behavior so a future refactor that switches
    // to a non-stable comparator (or "fixes" the empty-string fallback
    // to undefined) surfaces here.
    const { client } = makeQueryClient([
      {
        results: [
          buildTopicKeyPage("first", {
            topicKey: "decision/foo",
            projectIds: ["P1"],
            revisionCount: 2,
            lastReferencedAt: null,
          }),
          buildTopicKeyPage("second", {
            topicKey: "decision/foo",
            projectIds: ["P1"],
            revisionCount: 2,
            lastReferencedAt: null,
          }),
        ],
      },
    ])
    const service = new MemoryService(client, db)

    const result = await service.findByTopicKey({
      topicKey: "decision/foo",
      projectIds: ["P1"],
    })
    expect(result?.id).toBe("first")
  })

  it("sources data_source_id from this.db.dataSourceId — not a stale flat field", async () => {
    // Pin the field reference: an injected DatabaseRef with a custom
    // dataSourceId must flow into the dataSources.query call's
    // `data_source_id` parameter. NOT this.databaseId (the v4-era
    // database ID, structurally distinct).
    const customDb: DatabaseRef = {
      databaseId: "block-id",
      dataSourceId: "ds-custom-9999",
    }
    const { client, querySpy } = makeQueryClient([{ results: [] }])
    const service = new MemoryService(client, customDb)

    await service.findByTopicKey({ topicKey: "decision/foo", projectIds: ["P1"] })

    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(querySpy.mock.calls[0]![0].data_source_id).toBe("ds-custom-9999")
  })

  it("paginates: aggregates results across multiple Notion pages and finds the highest-revision match", async () => {
    // First Notion page returns rev=2 (a stale candidate); second
    // page returns rev=5 (the live candidate). Without pagination
    // the helper would return the rev=2 row and silently leak a
    // stale revision into the upsert chain.
    const firstPage = Array.from({ length: 100 }, (_, i) =>
      buildTopicKeyPage(`older-${i}`, {
        topicKey: "decision/foo",
        projectIds: ["P1"],
        revisionCount: 2,
      })
    )
    const secondPage = [
      buildTopicKeyPage("latest", {
        topicKey: "decision/foo",
        projectIds: ["P1"],
        revisionCount: 5,
      }),
    ]
    const { client, querySpy } = makeQueryClient([
      { results: firstPage, has_more: true, next_cursor: "cursor-1" },
      { results: secondPage, has_more: false },
    ])
    const service = new MemoryService(client, db)

    const result = await service.findByTopicKey({
      topicKey: "decision/foo",
      projectIds: ["P1"],
    })

    expect(result?.id).toBe("latest")
    expect(querySpy).toHaveBeenCalledTimes(2)
    // Second call uses the cursor returned from the first.
    expect(querySpy.mock.calls[1]![0].start_cursor).toBe("cursor-1")
  })

  it("excludes resurfaced cleanup-orphans server-side via Keywords does_not_contain (issue #477)", async () => {
    // The filter `Keywords does_not_contain '__lore-cleanup-orphan'` is
    // pushed server-side so a restored-from-trash properties-only orphan
    // never reaches the JS post-filter. Without this clause, an operator
    // who restores an archived orphan from Notion's workspace trash
    // would see the live row resurface as a topic-key match the next
    // time `lore-memory action='save'` ran — silently routing into the
    // upsert path against an empty-body shell.
    const { client, querySpy } = makeQueryClient([{ results: [] }])
    const service = new MemoryService(client, db)

    await service.findByTopicKey({
      topicKey: "decision/foo",
      projectIds: ["P1"],
    })

    expect(querySpy).toHaveBeenCalledTimes(1)
    const filter = querySpy.mock.calls[0]![0].filter as {
      and: Array<Record<string, unknown>>
    }
    expect(filter.and).toContainEqual({
      property: "Keywords",
      rich_text: { does_not_contain: "__lore-cleanup-orphan" },
    })
  })

  it("does NOT exclude memories whose Keywords column is empty — does_not_contain semantics on empty rich_text (issue #477 review-feedback)", async () => {
    // Notion's `rich_text.does_not_contain` filter excludes rows whose
    // value contains the substring; an empty rich_text value contains
    // no substring at all and is therefore included. Pin this behavior
    // at the request-shape level so a future contributor cannot
    // silently add an `is_not_empty` precondition that would flip the
    // semantics — that flip would silently exclude every memory with
    // no keywords from `findByTopicKey` queries, producing false
    // negatives on the upsert path that re-create rows that should
    // have been upserted.
    //
    // The bare filter clause is the contract; the test asserts the
    // EXACT clause that lands in the Notion request, with no
    // surrounding `is_not_empty` guard. Real-vault verification of
    // Notion's empty-rich_text behavior is recorded in
    // `cleanupOrphanExclusionFilter`'s docstring in memory.ts.
    const { client, querySpy } = makeQueryClient([{ results: [] }])
    const service = new MemoryService(client, db)

    await service.findByTopicKey({
      topicKey: "decision/foo",
      projectIds: ["P1"],
    })

    expect(querySpy).toHaveBeenCalledTimes(1)
    const filter = querySpy.mock.calls[0]![0].filter as {
      and: Array<Record<string, unknown>>
    }
    const keywordClauses = filter.and.filter(
      (c) => (c as { property?: string }).property === "Keywords"
    )
    expect(keywordClauses).toHaveLength(1)
    // The clause must be EXACTLY the does_not_contain shape. NO
    // `is_not_empty` AND-guard, NO `or` with an empty-check branch —
    // those would silently exclude memories with no keywords.
    expect(keywordClauses[0]).toEqual({
      property: "Keywords",
      rich_text: { does_not_contain: "__lore-cleanup-orphan" },
    })
  })
})

describe("MemoryService.upsertByTopicKey (0.9.0/06)", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }
  type UpsertInput = Parameters<MemoryService["upsertByTopicKey"]>[0]
  type UpsertRejectCase = readonly [string, Partial<UpsertInput>, number]

  /** Build a Memory page that will round-trip through findByTopicKey. */
  function buildExistingMemoryPage(
    id: string,
    opts: {
      topicKey: string
      projectIds: string[]
      revisionCount?: number
      kind?: string
      title?: string
      source?: string
      confidence?: string
      synopsis?: string
      keywords?: string
      author?: string
    }
  ): PageObjectResponse {
    const properties: Record<string, unknown> = {
      Title: {
        type: "title",
        title: [{ plain_text: opts.title ?? `Memory ${id}` }],
      },
      Project: {
        type: "relation",
        relation: opts.projectIds.map((pid) => ({ id: pid })),
      },
      "Topic Key": {
        type: "rich_text",
        rich_text: [{ plain_text: opts.topicKey }],
      },
      "Revision Count": {
        type: "number",
        number: opts.revisionCount ?? 1,
      },
      Kind: { type: "select", select: { name: opts.kind ?? "note" } },
    }
    if (opts.source !== undefined) {
      properties.Source = { type: "select", select: { name: opts.source } }
    }
    if (opts.confidence !== undefined) {
      properties.Confidence = {
        type: "select",
        select: { name: opts.confidence },
      }
    }
    if (opts.synopsis !== undefined) {
      properties.Synopsis = {
        type: "rich_text",
        rich_text: [{ plain_text: opts.synopsis }],
      }
    }
    if (opts.keywords !== undefined) {
      properties.Keywords = {
        type: "rich_text",
        rich_text: [{ plain_text: opts.keywords }],
      }
    }
    if (opts.author !== undefined) {
      properties.Author = {
        type: "rich_text",
        rich_text: [{ plain_text: opts.author }],
      }
    }

    return {
      object: "page",
      id,
      created_time: "2026-01-01T00:00:00.000Z",
      last_edited_time: "2026-02-01T00:00:00.000Z",
      archived: false,
      properties,
      parent: { type: "database_id", database_id: db.databaseId },
      url: `https://notion.so/${id}`,
    } as unknown as PageObjectResponse
  }

  /**
   * Build a stub `Client` that combines `dataSources.query` (for the
   * `findByTopicKey` lookup), `pages.create` / `pages.update` (for the
   * fresh-create + property-update writes), and `pages.retrieveMarkdown`
   * / `pages.updateMarkdown` (for the body-append step). Tests inspect
   * the spies to assert call ordering and payloads.
   */
  function makeUpsertClient(
    opts: {
      findResults?: PageObjectResponse[]
      existingBody?: string
    } = {}
  ) {
    const querySpy = vi.fn(
      async (_args: {
        data_source_id: string
        filter?: unknown
        start_cursor?: string
      }) => ({
        results: opts.findResults ?? [],
        has_more: false,
        next_cursor: null,
      })
    )
    const createdId = "new-page-id"
    const createSpy = vi.fn(async (_args: { properties: Record<string, unknown> }) => ({
      object: "page",
      id: createdId,
      properties: {},
    }))
    const updateSpy = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => ({})
    )
    const retrieveMarkdownSpy = vi.fn(async (_args: { page_id: string }) => ({
      markdown: opts.existingBody ?? "Initial body content",
    }))
    const updateMarkdownSpy = vi.fn(
      async (_args: {
        page_id: string
        type: string
        replace_content_range?: {
          content: string
          content_range: string
          allow_deleting_content: boolean
        }
        insert_content?: { content: string }
      }) => ({})
    )
    const client = {
      dataSources: { query: querySpy },
      pages: {
        create: createSpy,
        update: updateSpy,
        retrieveMarkdown: retrieveMarkdownSpy,
        updateMarkdown: updateMarkdownSpy,
      },
    } as unknown as Client
    return {
      client,
      querySpy,
      createSpy,
      updateSpy,
      retrieveMarkdownSpy,
      updateMarkdownSpy,
    }
  }

  function testTopicUpsertFingerprint(input: {
    kind?: string
    title: string
    content: string
    synopsis: string
    keywords: string
    source: string
    confidence: string
    author: string
  }): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          kind: input.kind ?? "decision",
          title: input.title,
          content: input.content,
          synopsis: input.synopsis,
          keywords: input.keywords,
          source: input.source,
          confidence: input.confidence,
          author: input.author,
        })
      )
      .digest("hex")
  }

  const upsertRejectCases: UpsertRejectCase[] = [
    [
      "topicKey",
      { topicKey: "x".repeat(RICH_TEXT_PROPERTY_MAX_LEN + 1) },
      RICH_TEXT_PROPERTY_MAX_LEN,
    ],
    [
      "keywords",
      { keywords: "x".repeat(RICH_TEXT_PROPERTY_MAX_LEN + 1) },
      RICH_TEXT_PROPERTY_MAX_LEN,
    ],
    [
      "author",
      { author: "x".repeat(RICH_TEXT_PROPERTY_MAX_LEN + 1) },
      RICH_TEXT_PROPERTY_MAX_LEN,
    ],
    [
      "agent",
      { agent: "x".repeat(RICH_TEXT_PROPERTY_MAX_LEN + 1) },
      RICH_TEXT_PROPERTY_MAX_LEN,
    ],
    [
      "session",
      { session: "x".repeat(RICH_TEXT_PROPERTY_MAX_LEN + 1) },
      RICH_TEXT_PROPERTY_MAX_LEN,
    ],
    ["synopsis", { synopsis: "x".repeat(SYNOPSIS_MAX + 1) }, SYNOPSIS_MAX],
  ]

  it.each(upsertRejectCases)(
    "rejects over-cap %s before any Notion call",
    async (field, input, cap) => {
      const {
        client,
        querySpy,
        createSpy,
        updateSpy,
        retrieveMarkdownSpy,
        updateMarkdownSpy,
      } = makeUpsertClient()
      const service = new MemoryService(client, db)

      await expect(
        service.upsertByTopicKey({
          topicKey: "decision/jwt-auth",
          projectIds: ["P1"],
          title: "JWT auth model",
          content: "We chose JWT.",
          kind: "decision",
          ...input,
        })
      ).rejects.toThrow(new RegExp(`MemoryService\\.upsertByTopicKey.*${field}.*${cap}`))

      expect(querySpy).not.toHaveBeenCalled()
      expect(createSpy).not.toHaveBeenCalled()
      expect(updateSpy).not.toHaveBeenCalled()
      expect(retrieveMarkdownSpy).not.toHaveBeenCalled()
      expect(updateMarkdownSpy).not.toHaveBeenCalled()
    }
  )

  it("creates a fresh memory with Revision Count: 1 when no existing match is found", async () => {
    // No existing match — the upsert path falls through to the
    // standard create path with `revisionCount: 1` seeded so the
    // upsert chain can grow on the next save.
    const { client, createSpy, updateMarkdownSpy } = makeUpsertClient({
      findResults: [],
    })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      title: "JWT auth model",
      content: "We chose JWT.",
      kind: "decision",
    })

    expect(result.upserted).toBe(false)
    expect(result.revisionCount).toBe(1)
    expect(createSpy).toHaveBeenCalledTimes(1)
    const createArgs = createSpy.mock.calls[0]![0] as {
      properties: Record<string, unknown>
    }
    // Topic Key + Revision Count flow through buildMemoryProps onto
    // the new page so the next save against this key + project-set
    // upserts.
    expect(createArgs.properties["Topic Key"]).toEqual({
      rich_text: [{ text: { content: "decision/jwt-auth" } }],
    })
    expect(createArgs.properties["Revision Count"]).toEqual({ number: 1 })
    // Body write fires on initial create via `insert_content`, NOT
    // `replace_content_range` — the upsert path's append shape is
    // reserved for subsequent revisions.
    expect(updateMarkdownSpy).toHaveBeenCalledTimes(1)
    const mdArgs = updateMarkdownSpy.mock.calls[0]![0] as {
      type: string
    }
    expect(mdArgs.type).toBe("insert_content")
  })

  it("appends a revision block, bumps Revision Count, and updates Title when an existing match is found", async () => {
    // Existing memory at revision 1; upsert produces revision 2 with
    // a `## Revision 2 (YYYY-MM-DD)` block appended to the existing
    // body via `replace_content_range`. Title bumps to the new value.
    const existing = buildExistingMemoryPage("existing-mem", {
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      revisionCount: 1,
      kind: "decision",
      title: "JWT auth model",
    })
    const { client, retrieveMarkdownSpy, updateMarkdownSpy, updateSpy } =
      makeUpsertClient({
        findResults: [existing],
        existingBody: "Initial body about JWT.",
      })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      title: "JWT auth model with refresh rotation",
      content: "Now we rotate refresh tokens.",
      kind: "decision",
      today: "2026-04-30",
    })

    expect(result.upserted).toBe(true)
    expect(result.revisionCount).toBe(2)
    expect(result.memory.id).toBe("existing-mem")
    expect(result.memory.title).toBe("JWT auth model with refresh rotation")

    expect(retrieveMarkdownSpy).toHaveBeenCalledTimes(1)
    expect(updateMarkdownSpy).toHaveBeenCalledTimes(1)
    const mdArgs = updateMarkdownSpy.mock.calls[0]![0] as {
      type: string
      replace_content_range: {
        content: string
        content_range: string
        allow_deleting_content: boolean
      }
    }
    expect(mdArgs.type).toBe("replace_content_range")
    expect(mdArgs.replace_content_range.content_range).toBe("full_page")
    expect(mdArgs.replace_content_range.allow_deleting_content).toBe(true)
    // Append shape: existing body, then `---`, then the H2 revision
    // header, then the title-at-this-revision line, then the new body.
    expect(mdArgs.replace_content_range.content).toContain("Initial body about JWT.")
    expect(mdArgs.replace_content_range.content).toContain("---")
    expect(mdArgs.replace_content_range.content).toContain("## Revision 2 (2026-04-30)")
    expect(mdArgs.replace_content_range.content).toContain(
      "**Title at this revision:** JWT auth model with refresh rotation"
    )
    expect(mdArgs.replace_content_range.content).toContain(
      "Now we rotate refresh tokens."
    )

    // Property update bumps Title and Revision Count.
    expect(updateSpy).toHaveBeenCalledTimes(1)
    const updateArgs = updateSpy.mock.calls[0]![0] as {
      page_id: string
      properties: Record<string, unknown>
    }
    expect(updateArgs.page_id).toBe("existing-mem")
    expect(updateArgs.properties["Revision Count"]).toEqual({ number: 2 })
    expect(updateArgs.properties["Title"]).toEqual({
      title: [{ text: { content: "JWT auth model with refresh rotation" } }],
    })
  })

  it("does not append a duplicate revision when retry input matches revision 1", async () => {
    const existing = buildExistingMemoryPage("existing-mem", {
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      revisionCount: 1,
      kind: "decision",
      title: "JWT auth model",
      synopsis: "JWT decision.",
      keywords: "jwt,auth",
      source: "manual",
      confidence: "certain",
      author: "Test User",
    })
    const { client, retrieveMarkdownSpy, updateMarkdownSpy, updateSpy } =
      makeUpsertClient({
        findResults: [existing],
        existingBody: "We chose JWT.",
      })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      title: "JWT auth model",
      content: "We chose JWT.",
      kind: "decision",
      synopsis: "JWT decision.",
      keywords: "jwt,auth",
      source: "manual",
      confidence: "certain",
      author: "Test User",
    })

    expect(result.upserted).toBe(true)
    expect(result.revisionCount).toBe(1)
    expect(result.memory.id).toBe("existing-mem")
    expect(result.promotionAdvisory).toBeNull()
    expect(retrieveMarkdownSpy).toHaveBeenCalledTimes(1)
    expect(updateMarkdownSpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("does not append when empty input.author is the only difference", async () => {
    const existing = buildExistingMemoryPage("existing-mem", {
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      revisionCount: 1,
      kind: "decision",
      title: "JWT auth model",
      author: "Engineer A",
    })
    const { client, updateMarkdownSpy, updateSpy } = makeUpsertClient({
      findResults: [existing],
      existingBody: "We chose JWT.",
    })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      title: "JWT auth model",
      content: "We chose JWT.",
      kind: "decision",
      author: "",
    })

    expect(result.revisionCount).toBe(1)
    expect(result.memory.author).toBe("Engineer A")
    expect(updateMarkdownSpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("does not append a duplicate revision when retry input matches the latest appended revision", async () => {
    const existing = buildExistingMemoryPage("existing-mem", {
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      revisionCount: 2,
      kind: "decision",
      title: "JWT auth model with refresh rotation",
      synopsis: "Refresh rotation adopted.",
      keywords: "jwt,refresh",
      source: "manual",
      confidence: "likely",
      author: "Test User",
    })
    const existingBody = [
      "Initial body about JWT.",
      "",
      "---",
      "",
      "## Revision 2 (2026-04-30)",
      "",
      `<!-- lore-topic-upsert-sha256: ${testTopicUpsertFingerprint({
        title: "JWT auth model with refresh rotation",
        content: "Now we rotate refresh tokens.",
        synopsis: "Refresh rotation adopted.",
        keywords: "jwt,refresh",
        source: "manual",
        confidence: "likely",
        author: "Test User",
      })} -->`,
      "",
      "**Title at this revision:** JWT auth model with refresh rotation",
      "",
      "Now we rotate refresh tokens.",
    ].join("\n")
    const { client, updateMarkdownSpy, updateSpy } = makeUpsertClient({
      findResults: [existing],
      existingBody,
    })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      title: "JWT auth model with refresh rotation",
      content: "Now we rotate refresh tokens.",
      kind: "decision",
      synopsis: "Refresh rotation adopted.",
      keywords: "jwt,refresh",
      source: "manual",
      confidence: "likely",
      author: "Test User",
    })

    expect(result.revisionCount).toBe(2)
    expect(result.memory.title).toBe("JWT auth model with refresh rotation")
    expect(updateMarkdownSpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("repairs stale properties without appending when retry follows a body-write-only partial failure", async () => {
    // Failure shape: the previous attempt landed `updateMarkdown`
    // (body now contains Revision 2), but timed out before
    // `pages.update` bumped Revision Count and metadata. Retrying the
    // same save must complete the property write, not append another
    // Revision 2/3 block.
    const existing = buildExistingMemoryPage("existing-mem", {
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      revisionCount: 1,
      kind: "decision",
      title: "JWT auth model",
      synopsis: "Old synopsis.",
      keywords: "old,keywords",
      source: "manual",
      confidence: "certain",
      author: "Engineer A",
    })
    const existingBody = [
      "Initial body about JWT.",
      "",
      "---",
      "",
      "## Revision 2 (2026-04-30)",
      "",
      `<!-- lore-topic-upsert-sha256: ${testTopicUpsertFingerprint({
        title: "JWT auth model with refresh rotation",
        content: "Now we rotate refresh tokens.",
        synopsis: "Refresh rotation adopted.",
        keywords: "jwt,refresh",
        source: "manual",
        confidence: "likely",
        author: "Engineer B",
      })} -->`,
      "",
      "**Title at this revision:** JWT auth model with refresh rotation",
      "",
      "Now we rotate refresh tokens.",
    ].join("\n")
    const { client, updateMarkdownSpy, updateSpy } = makeUpsertClient({
      findResults: [existing],
      existingBody,
    })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      title: "JWT auth model with refresh rotation",
      content: "Now we rotate refresh tokens.",
      kind: "decision",
      synopsis: "Refresh rotation adopted.",
      keywords: "jwt,refresh",
      source: "manual",
      confidence: "likely",
      author: "Engineer B",
    })

    expect(result.revisionCount).toBe(2)
    expect(result.memory.title).toBe("JWT auth model with refresh rotation")
    expect(result.memory.synopsis).toBe("Refresh rotation adopted.")
    expect(result.memory.keywords).toBe("jwt,refresh")
    expect(result.memory.confidence).toBe("likely")
    expect(result.memory.author).toBe("Engineer B")
    expect(updateMarkdownSpy).not.toHaveBeenCalled()
    expect(updateSpy).toHaveBeenCalledTimes(1)
    const updateArgs = updateSpy.mock.calls[0]![0] as {
      properties: Record<string, unknown>
    }
    expect(updateArgs.properties["Revision Count"]).toEqual({ number: 2 })
    expect(updateArgs.properties["Title"]).toEqual({
      title: [{ text: { content: "JWT auth model with refresh rotation" } }],
    })
    expect(updateArgs.properties["Synopsis"]).toEqual({
      rich_text: [{ text: { content: "Refresh rotation adopted." } }],
    })
    expect(updateArgs.properties["Keywords"]).toEqual({
      rich_text: [{ text: { content: "jwt,refresh" } }],
    })
    expect(updateArgs.properties["Confidence"]).toEqual({
      select: { name: "likely" },
    })
    expect(updateArgs.properties["Author"]).toEqual({
      rich_text: [{ text: { content: "Engineer B" } }],
    })
  })

  it("recovers after pages.update fails following a successful body append", async () => {
    const existing = buildExistingMemoryPage("existing-mem", {
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      revisionCount: 1,
      kind: "decision",
      title: "JWT auth model",
      synopsis: "Old synopsis.",
      keywords: "old,keywords",
      source: "manual",
      confidence: "certain",
      author: "Engineer A",
    })
    const clientOpts = {
      findResults: [existing],
      existingBody: "Initial body about JWT.",
    }
    const { client, updateMarkdownSpy, updateSpy } = makeUpsertClient(clientOpts)
    updateSpy.mockRejectedValueOnce(new Error("property update timed out"))
    const service = new MemoryService(client, db)
    const input = {
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      title: "JWT auth model with refresh rotation",
      content: "Now we rotate refresh tokens.",
      kind: "decision" as const,
      synopsis: "Refresh rotation adopted.",
      keywords: "jwt,refresh",
      source: "manual" as const,
      confidence: "likely" as const,
      author: "Engineer B",
      today: "2026-04-30",
    }

    await expect(service.upsertByTopicKey(input)).rejects.toThrow(
      /property update timed out/
    )
    const firstWriteArgs = updateMarkdownSpy.mock.calls[0]![0] as {
      replace_content_range: { content: string }
    }
    clientOpts.existingBody = firstWriteArgs.replace_content_range.content

    const result = await service.upsertByTopicKey(input)

    expect(result.revisionCount).toBe(2)
    expect(updateMarkdownSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy).toHaveBeenCalledTimes(2)
    const repairArgs = updateSpy.mock.calls[1]![0] as {
      properties: Record<string, unknown>
    }
    expect(repairArgs.properties["Revision Count"]).toEqual({ number: 2 })
    expect(repairArgs.properties["Title"]).toEqual({
      title: [{ text: { content: "JWT auth model with refresh rotation" } }],
    })
    expect(repairArgs.properties["Synopsis"]).toEqual({
      rich_text: [{ text: { content: "Refresh rotation adopted." } }],
    })
    expect(repairArgs.properties["Keywords"]).toEqual({
      rich_text: [{ text: { content: "jwt,refresh" } }],
    })
  })

  it("appends from the markdown revision count when body is ahead but input metadata is new", async () => {
    // Body already contains Revision 2, but the row properties still
    // say Revision Count: 1. Because the incoming metadata does not
    // match Revision 2's fingerprint, this is a new save on top of the
    // body-ahead state; it must append Revision 3, not another
    // Revision 2.
    const existing = buildExistingMemoryPage("existing-mem", {
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      revisionCount: 1,
      kind: "decision",
      title: "JWT auth model",
      synopsis: "Old synopsis.",
      keywords: "old,keywords",
      source: "manual",
      confidence: "certain",
      author: "Engineer A",
    })
    const existingBody = [
      "Initial body about JWT.",
      "",
      "---",
      "",
      "## Revision 2 (2026-04-30)",
      "",
      `<!-- lore-topic-upsert-sha256: ${testTopicUpsertFingerprint({
        title: "JWT auth model with refresh rotation",
        content: "Now we rotate refresh tokens.",
        synopsis: "Refresh rotation adopted.",
        keywords: "jwt,refresh",
        source: "manual",
        confidence: "likely",
        author: "Engineer B",
      })} -->`,
      "",
      "**Title at this revision:** JWT auth model with refresh rotation",
      "",
      "Now we rotate refresh tokens.",
    ].join("\n")
    const { client, updateMarkdownSpy, updateSpy } = makeUpsertClient({
      findResults: [existing],
      existingBody,
    })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      title: "JWT auth model with refresh rotation",
      content: "Now we rotate refresh tokens.",
      kind: "decision",
      synopsis: "Refresh rotation adopted with a caveat.",
      keywords: "jwt,refresh,caveat",
      source: "manual",
      confidence: "likely",
      author: "Engineer B",
      today: "2026-05-01",
    })

    expect(result.revisionCount).toBe(3)
    expect(updateMarkdownSpy).toHaveBeenCalledTimes(1)
    const mdArgs = updateMarkdownSpy.mock.calls[0]![0] as {
      replace_content_range: { content: string }
    }
    expect(mdArgs.replace_content_range.content).toContain("## Revision 3 (2026-05-01)")
    expect(mdArgs.replace_content_range.content.match(/## Revision 2/g)).toHaveLength(1)
    expect(updateSpy).toHaveBeenCalledTimes(1)
    const updateArgs = updateSpy.mock.calls[0]![0] as {
      properties: Record<string, unknown>
    }
    expect(updateArgs.properties["Revision Count"]).toEqual({ number: 3 })
  })

  it("appends from the markdown count when body-ahead content and properties match but fingerprint differs", async () => {
    const existing = buildExistingMemoryPage("existing-mem", {
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      revisionCount: 1,
      kind: "decision",
      title: "JWT auth model with refresh rotation",
      synopsis: "Refresh rotation adopted.",
      keywords: "jwt,refresh",
      source: "manual",
      confidence: "likely",
      author: "Engineer B",
    })
    const existingBody = [
      "Initial body about JWT.",
      "",
      "---",
      "",
      "## Revision 2 (2026-04-30)",
      "",
      `<!-- lore-topic-upsert-sha256: ${testTopicUpsertFingerprint({
        title: "JWT auth model with refresh rotation",
        content: "Now we rotate refresh tokens.",
        synopsis: "Refresh rotation adopted.",
        keywords: "different,fingerprint",
        source: "manual",
        confidence: "likely",
        author: "Engineer B",
      })} -->`,
      "",
      "**Title at this revision:** JWT auth model with refresh rotation",
      "",
      "Now we rotate refresh tokens.",
    ].join("\n")
    const { client, updateMarkdownSpy, updateSpy } = makeUpsertClient({
      findResults: [existing],
      existingBody,
    })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      title: "JWT auth model with refresh rotation",
      content: "Now we rotate refresh tokens.",
      kind: "decision",
      synopsis: "Refresh rotation adopted.",
      keywords: "jwt,refresh",
      source: "manual",
      confidence: "likely",
      author: "Engineer B",
      today: "2026-05-01",
    })

    expect(result.revisionCount).toBe(3)
    expect(updateMarkdownSpy).toHaveBeenCalledTimes(1)
    const mdArgs = updateMarkdownSpy.mock.calls[0]![0] as {
      replace_content_range: { content: string }
    }
    expect(mdArgs.replace_content_range.content).toContain("## Revision 3 (2026-05-01)")
    expect(updateSpy).toHaveBeenCalledTimes(1)
    const updateArgs = updateSpy.mock.calls[0]![0] as {
      properties: Record<string, unknown>
    }
    expect(updateArgs.properties["Revision Count"]).toEqual({ number: 3 })
  })

  it("does not let unfingerprinted user markdown advance the revision base", async () => {
    const existing = buildExistingMemoryPage("existing-mem", {
      topicKey: "runbook/db-migration",
      projectIds: ["P1"],
      revisionCount: 2,
      kind: "runbook",
      title: "DB migration",
      synopsis: "Migration runbook.",
      keywords: "db,migration",
    })
    const existingBody = [
      "Initial body.",
      "",
      "---",
      "",
      "## Revision 2 (2026-04-30)",
      "",
      `<!-- lore-topic-upsert-sha256: ${testTopicUpsertFingerprint({
        kind: "runbook",
        title: "DB migration",
        content: [
          "Step 2.",
          "",
          "---",
          "",
          "## Revision 99 (2099-01-01)",
          "",
          "**Title at this revision:** Example copied from docs",
          "",
          "Not a Lore revision.",
        ].join("\n"),
        synopsis: "Migration runbook.",
        keywords: "db,migration",
        source: "manual",
        confidence: "certain",
        author: "",
      })} -->`,
      "",
      "**Title at this revision:** DB migration",
      "",
      "Step 2.",
      "",
      "---",
      "",
      "## Revision 99 (2099-01-01)",
      "",
      "**Title at this revision:** Example copied from docs",
      "",
      "Not a Lore revision.",
    ].join("\n")
    const { client, updateMarkdownSpy, updateSpy } = makeUpsertClient({
      findResults: [existing],
      existingBody,
    })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "runbook/db-migration",
      projectIds: ["P1"],
      title: "DB migration",
      content: "Step 3.",
      kind: "runbook",
      synopsis: "Migration runbook.",
      keywords: "db,migration",
      today: "2026-05-01",
    })

    expect(result.revisionCount).toBe(3)
    const mdArgs = updateMarkdownSpy.mock.calls[0]![0] as {
      replace_content_range: { content: string }
    }
    expect(mdArgs.replace_content_range.content).toContain("## Revision 3 (2026-05-01)")
    expect(mdArgs.replace_content_range.content).not.toContain(
      "## Revision 100 (2026-05-01)"
    )
    const updateArgs = updateSpy.mock.calls[0]![0] as {
      properties: Record<string, unknown>
    }
    expect(updateArgs.properties["Revision Count"]).toEqual({ number: 3 })
  })

  it("prefers a fingerprinted stored-count revision over same-count user markdown on retry", async () => {
    const copiedExample = [
      "Step 2.",
      "",
      "---",
      "",
      "## Revision 2 (2099-01-01)",
      "",
      "**Title at this revision:** Example copied from docs",
      "",
      "Not a Lore revision.",
    ].join("\n")
    const existing = buildExistingMemoryPage("existing-mem", {
      topicKey: "runbook/db-migration",
      projectIds: ["P1"],
      revisionCount: 2,
      kind: "runbook",
      title: "DB migration",
      synopsis: "Migration runbook.",
      keywords: "db,migration",
    })
    const existingBody = [
      "Initial body.",
      "",
      "---",
      "",
      "## Revision 2 (2026-04-30)",
      "",
      `<!-- lore-topic-upsert-sha256: ${testTopicUpsertFingerprint({
        kind: "runbook",
        title: "DB migration",
        content: copiedExample,
        synopsis: "Migration runbook.",
        keywords: "db,migration",
        source: "manual",
        confidence: "certain",
        author: "",
      })} -->`,
      "",
      "**Title at this revision:** DB migration",
      "",
      copiedExample,
    ].join("\n")
    const { client, updateMarkdownSpy, updateSpy } = makeUpsertClient({
      findResults: [existing],
      existingBody,
    })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "runbook/db-migration",
      projectIds: ["P1"],
      title: "DB migration",
      content: copiedExample,
      kind: "runbook",
      synopsis: "Migration runbook.",
      keywords: "db,migration",
    })

    expect(result.revisionCount).toBe(2)
    expect(updateMarkdownSpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("legacy unfingerprinted stored-count retry uses the canonical revision before later user-pasted lookalikes", async () => {
    const copiedExample = [
      "Step 2.",
      "",
      "---",
      "",
      "## Revision 2 (2099-01-01)",
      "",
      "**Title at this revision:** Example copied from docs",
      "",
      "Not a Lore revision.",
    ].join("\n")
    const existing = buildExistingMemoryPage("existing-mem", {
      topicKey: "runbook/db-migration",
      projectIds: ["P1"],
      revisionCount: 2,
      kind: "runbook",
      title: "DB migration",
      synopsis: "Migration runbook.",
      keywords: "db,migration",
    })
    const existingBody = [
      "Initial body.",
      "",
      "---",
      "",
      "## Revision 2 (2026-04-30)",
      "",
      "**Title at this revision:** DB migration",
      "",
      copiedExample,
    ].join("\n")
    const { client, updateMarkdownSpy, updateSpy } = makeUpsertClient({
      findResults: [existing],
      existingBody,
    })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "runbook/db-migration",
      projectIds: ["P1"],
      title: "DB migration",
      content: copiedExample,
      kind: "runbook",
      synopsis: "Migration runbook.",
      keywords: "db,migration",
    })

    expect(result.revisionCount).toBe(2)
    expect(updateMarkdownSpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("appends a revision when content changes but title and metadata match", async () => {
    const existing = buildExistingMemoryPage("existing-mem", {
      topicKey: "runbook/db-migration",
      projectIds: ["P1"],
      revisionCount: 1,
      kind: "runbook",
      title: "DB migration",
      synopsis: "Migration runbook.",
      keywords: "db,migration",
    })
    const { client, updateMarkdownSpy, updateSpy } = makeUpsertClient({
      findResults: [existing],
      existingBody: "Step 1 only.",
    })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "runbook/db-migration",
      projectIds: ["P1"],
      title: "DB migration",
      content: "Step 1 and step 2.",
      kind: "runbook",
      synopsis: "Migration runbook.",
      keywords: "db,migration",
    })

    expect(result.revisionCount).toBe(2)
    expect(updateMarkdownSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy).toHaveBeenCalledTimes(1)
  })

  it("appends a revision when synopsis or keywords change even if title and content match", async () => {
    for (const changed of ["synopsis", "keywords"] as const) {
      const existing = buildExistingMemoryPage(`existing-${changed}`, {
        topicKey: `runbook/db-migration-${changed}`,
        projectIds: ["P1"],
        revisionCount: 1,
        kind: "runbook",
        title: "DB migration",
        synopsis: "Old synopsis.",
        keywords: "old,keywords",
      })
      const { client, updateMarkdownSpy, updateSpy } = makeUpsertClient({
        findResults: [existing],
        existingBody: "Step 1 only.",
      })
      const service = new MemoryService(client, db)

      const result = await service.upsertByTopicKey({
        topicKey: `runbook/db-migration-${changed}`,
        projectIds: ["P1"],
        title: "DB migration",
        content: "Step 1 only.",
        kind: "runbook",
        synopsis: changed === "synopsis" ? "New synopsis." : "Old synopsis.",
        keywords: changed === "keywords" ? "new,keywords" : "old,keywords",
      })

      expect(result.revisionCount).toBe(2)
      expect(updateMarkdownSpy, changed).toHaveBeenCalledTimes(1)
      expect(updateSpy, changed).toHaveBeenCalledTimes(1)
    }
  })

  // -------------------------------------------------------------------
  // DEFERRED-ATTRIBUTION (0.10.0): Author stamping on the upsert path.
  //
  // Fresh-create routes through `create()` and inherits its author
  // handling. The append-revision branch is the load-bearing case the
  // PR review flagged: legacy unattributed rows must pick up an author
  // when the next revision carries one, AND a fresh revision by a
  // different engineer must overwrite the prior chain author rather
  // than silently preserve it. The "REPLACE on every save" policy
  // matches Title / Synopsis / Keywords / Source.
  // -------------------------------------------------------------------

  function buildExistingMemoryPageWithAuthor(
    id: string,
    opts: { topicKey: string; projectIds: string[]; author?: string }
  ): PageObjectResponse {
    const page = buildExistingMemoryPage(id, {
      topicKey: opts.topicKey,
      projectIds: opts.projectIds,
      kind: "decision",
      revisionCount: 1,
    })
    if (opts.author !== undefined) {
      ;(page.properties as Record<string, unknown>)["Author"] = {
        type: "rich_text",
        rich_text: [{ plain_text: opts.author }],
      }
    }
    return page
  }

  it("append-revision: input.author overwrites the prior Author column on the property update", async () => {
    // Engineer B revises a topic that engineer A authored. The
    // attribution flips to B because the upsert path's "latest write
    // wins" policy covers the human attribution column. Returned
    // shape echoes the post-write author so the MCP layer's auto-
    // mentions emitter reads the new value.
    const existing = buildExistingMemoryPageWithAuthor("existing-mem", {
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      author: "Engineer A",
    })
    const { client, updateSpy } = makeUpsertClient({ findResults: [existing] })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      title: "JWT auth model with refresh rotation",
      content: "...",
      kind: "decision",
      author: "Engineer B",
    })

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const updateArgs = updateSpy.mock.calls[0]![0] as {
      properties: Record<string, unknown>
    }
    expect(updateArgs.properties["Author"]).toEqual({
      rich_text: [{ text: { content: "Engineer B" } }],
    })
    expect(result.memory.author).toBe("Engineer B")
  })

  it("append-revision: legacy unattributed row picks up Author when input.author is supplied", async () => {
    // The reviewer's specific concern: a row created pre-DEFERRED-
    // ATTRIBUTION has Author=""; the next upsert backfills it rather
    // than leaving the column permanently empty. The post-write
    // returned shape reflects the new author.
    const existing = buildExistingMemoryPageWithAuthor("existing-mem", {
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      // No author — pre-DEFERRED-ATTRIBUTION shape.
    })
    const { client, updateSpy } = makeUpsertClient({ findResults: [existing] })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      title: "JWT auth model with refresh rotation",
      content: "...",
      kind: "decision",
      author: "Test User",
    })

    const updateArgs = updateSpy.mock.calls[0]![0] as {
      properties: Record<string, unknown>
    }
    expect(updateArgs.properties["Author"]).toEqual({
      rich_text: [{ text: { content: "Test User" } }],
    })
    expect(result.memory.author).toBe("Test User")
  })

  it("append-revision: input.author === undefined preserves the existing Author (service-layer no-clobber)", async () => {
    // Service-layer callers (migrations, internal tooling) that omit
    // `author` must NOT clobber the prior chain author with null. This
    // is distinct from the MCP boundary — the tool handler always
    // resolves to either an explicit override or `services.identity.
    // author`, both of which are forwarded as the input. A bare-call
    // without `author` is a service-layer signal of "preserve."
    const existing = buildExistingMemoryPageWithAuthor("existing-mem", {
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      author: "Engineer A",
    })
    const { client, updateSpy } = makeUpsertClient({ findResults: [existing] })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      title: "JWT auth model",
      content: "...",
      kind: "decision",
      // No `author` field — service-layer caller signals "preserve."
    })

    const updateArgs = updateSpy.mock.calls[0]![0] as {
      properties: Record<string, unknown>
    }
    expect(updateArgs.properties["Author"]).toEqual({
      rich_text: [{ text: { content: "Engineer A" } }],
    })
    expect(result.memory.author).toBe("Engineer A")
  })

  it("append-revision: empty input.author preserves the existing Author in writes and return shape", async () => {
    // `buildMemoryProps` omits empty author values, so the service must
    // normalize empty input to the existing author before both the
    // property write and the returned Memory shape. Otherwise a retry
    // with author="" would report a value Notion never stored.
    const existing = buildExistingMemoryPageWithAuthor("existing-mem", {
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      author: "Engineer A",
    })
    const { client, updateSpy } = makeUpsertClient({ findResults: [existing] })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      title: "JWT auth model",
      content: "...",
      kind: "decision",
      author: "",
    })

    const updateArgs = updateSpy.mock.calls[0]![0] as {
      properties: Record<string, unknown>
    }
    expect(updateArgs.properties["Author"]).toEqual({
      rich_text: [{ text: { content: "Engineer A" } }],
    })
    expect(result.memory.author).toBe("Engineer A")
  })

  it("fresh-create: stamps input.author onto the new page's Author column", async () => {
    // Symmetric to append-revision: the fresh-create branch routes
    // through `create()`, which forwards `author` into
    // `buildMemoryProps`. Pin the contract here too so a future
    // refactor that drops `author` from the upsert→create forward
    // breaks the test.
    const { client, createSpy } = makeUpsertClient({ findResults: [] })
    const service = new MemoryService(client, db)

    await service.upsertByTopicKey({
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      title: "JWT auth model",
      content: "We chose JWT.",
      kind: "decision",
      author: "Test User",
    })

    const createArgs = createSpy.mock.calls[0]![0] as {
      properties: Record<string, unknown>
    }
    expect(createArgs.properties["Author"]).toEqual({
      rich_text: [{ text: { content: "Test User" } }],
    })
  })

  it("throws on kind mismatch BEFORE any Notion write — pages.retrieveMarkdown and pages.updateMarkdown are never called", async () => {
    // The acceptance criterion: a kind-mismatched upsert must throw
    // before the body read/write so a rejected upsert leaves the
    // existing page untouched. An earlier draft of #06 had the
    // validation AFTER retrieveMarkdown + updateMarkdown — a real
    // correctness bug.
    const existing = buildExistingMemoryPage("existing-mem", {
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      revisionCount: 1,
      kind: "decision",
    })
    const { client, retrieveMarkdownSpy, updateMarkdownSpy, updateSpy } =
      makeUpsertClient({ findResults: [existing] })
    const service = new MemoryService(client, db)

    await expect(
      service.upsertByTopicKey({
        topicKey: "decision/jwt-auth",
        projectIds: ["P1"],
        title: "JWT auth model",
        content: "...",
        kind: "runbook",
      })
    ).rejects.toThrow(/Kind cannot change on upsert/)

    expect(retrieveMarkdownSpy).not.toHaveBeenCalled()
    expect(updateMarkdownSpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("throws when projectIds is empty without issuing any Notion call", async () => {
    // Empty project-set is structurally undefined for upsert — the
    // set-equality on the empty set would match every projectless
    // memory in the vault. The guard fires before findByTopicKey.
    const { client, querySpy } = makeUpsertClient()
    const service = new MemoryService(client, db)

    await expect(
      service.upsertByTopicKey({
        topicKey: "decision/jwt-auth",
        projectIds: [],
        title: "JWT auth model",
        content: "...",
        kind: "decision",
      })
    ).rejects.toThrow(/topicKey requires at least one projectId/)

    expect(querySpy).not.toHaveBeenCalled()
  })

  it("treats Revision Count: null (legacy row) as 1 and appends as revision 2", async () => {
    // pageToMemory coalesces a missing/null Revision Count to 1, so
    // the upsert path's `existing.revisionCount + 1` produces 2 on
    // legacy rows. Pin that behavior so a future change to the
    // coalesce default doesn't silently shift legacy upserts to
    // revision 3.
    const legacyExisting = {
      object: "page",
      id: "legacy-mem",
      created_time: "2025-01-01T00:00:00.000Z",
      last_edited_time: "2025-02-01T00:00:00.000Z",
      archived: false,
      properties: {
        Title: { type: "title", title: [{ plain_text: "Legacy" }] },
        Project: { type: "relation", relation: [{ id: "P1" }] },
        "Topic Key": {
          type: "rich_text",
          rich_text: [{ plain_text: "decision/jwt-auth" }],
        },
        // Revision Count column is missing — pre-#06 legacy row.
        Kind: { type: "select", select: { name: "decision" } },
      },
      parent: { type: "database_id", database_id: db.databaseId },
      url: "https://notion.so/legacy",
    } as unknown as PageObjectResponse
    const { client } = makeUpsertClient({ findResults: [legacyExisting] })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      title: "Legacy",
      content: "next",
      kind: "decision",
    })
    expect(result.revisionCount).toBe(2)
  })

  it("REPLACES title / synopsis / keywords on the property update; UNTOUCHED Confidence Score and Last Referenced At", async () => {
    // Title bumps; synopsis and keywords replace; Kind / Status /
    // Project / Confidence Score / Last Referenced At are NOT in the
    // property update (the spec's "untouched" list).
    const existing = buildExistingMemoryPage("existing-mem", {
      topicKey: "runbook/db-migration",
      projectIds: ["P1"],
      revisionCount: 2,
      kind: "runbook",
    })
    const { client, updateSpy } = makeUpsertClient({ findResults: [existing] })
    const service = new MemoryService(client, db)

    await service.upsertByTopicKey({
      topicKey: "runbook/db-migration",
      projectIds: ["P1"],
      title: "DB migration v3",
      content: "step 4 added.",
      kind: "runbook",
      synopsis: "Now with step 4.",
      keywords: "PR-123 migration",
      today: "2026-04-30",
    })

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const updateArgs = updateSpy.mock.calls[0]![0] as {
      properties: Record<string, unknown>
    }
    expect(updateArgs.properties["Title"]).toBeDefined()
    expect(updateArgs.properties["Revision Count"]).toEqual({ number: 3 })
    expect(updateArgs.properties["Synopsis"]).toEqual({
      rich_text: [{ text: { content: "Now with step 4." } }],
    })
    expect(updateArgs.properties["Keywords"]).toEqual({
      rich_text: [{ text: { content: "PR-123 migration" } }],
    })
    // The "untouched" set MUST NOT appear in the property update —
    // bumping Last Referenced At would conflate writes with reads
    // (breaking the staleness signal driving the wake-up Stale
    // Confidence section), and Confidence Score is system-managed.
    expect(updateArgs.properties).not.toHaveProperty("Last Referenced At")
    expect(updateArgs.properties).not.toHaveProperty("Confidence Score")
    // Kind / Status / Project / Topic relation are not in the update
    // either — they are either pinned (Kind, Project) or silently
    // preserved (Status, Topic).
    expect(updateArgs.properties).not.toHaveProperty("Kind")
    expect(updateArgs.properties).not.toHaveProperty("Status")
    expect(updateArgs.properties).not.toHaveProperty("Project")
    expect(updateArgs.properties).not.toHaveProperty("Topic")
  })

  it("returned memory shape carries the post-write title / synopsis / keywords so auto-mentions extracts on new content", async () => {
    // The auto-mentions emitter at the MCP layer reads
    // `memory.title / keywords / synopsis` to extract entities. The
    // returned memory shape must reflect the post-upsert state, NOT
    // the pre-upsert existing row.
    const existing = buildExistingMemoryPage("existing-mem", {
      topicKey: "runbook/db-migration",
      projectIds: ["P1"],
      revisionCount: 2,
      kind: "runbook",
      title: "DB migration v2",
    })
    const { client } = makeUpsertClient({ findResults: [existing] })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "runbook/db-migration",
      projectIds: ["P1"],
      title: "DB migration v3",
      content: "...",
      kind: "runbook",
      synopsis: "Now with step 4.",
      keywords: "PR-123 migration",
    })

    expect(result.memory.title).toBe("DB migration v3")
    expect(result.memory.synopsis).toBe("Now with step 4.")
    expect(result.memory.keywords).toBe("PR-123 migration")
  })

  it("invalidates and write-through-installs the post-upsert title in the title cache", async () => {
    // Mirrors the `update()` cache discipline. Without the write-
    // through, `getTitleById` would keep returning the pre-upsert
    // title from the in-memory cache until the 60s TTL expired, even
    // though the new title has landed in Notion. Render-layer
    // resolvers (`render.ts:resolveTitles`, wake-up listings) all
    // hit `getTitleById`, so a stale cache surfaces the wrong label
    // on every consumer.
    //
    // The test seeds the cache with the pre-upsert title, runs the
    // upsert, then re-reads via `getTitleById` and asserts:
    //   1. The new title is returned.
    //   2. No additional `pages.retrieve` call fires (the write-
    //      through committed the new value, so the read short-
    //      circuits on the cache hit).
    const existing = buildExistingMemoryPage("existing-mem", {
      topicKey: "runbook/db-migration",
      projectIds: ["P1"],
      revisionCount: 1,
      kind: "runbook",
      title: "Old title",
    })
    const { client } = makeUpsertClient({ findResults: [existing] })
    // `makeUpsertClient` doesn't expose a `pages.retrieve` spy because
    // the upsert path doesn't use it. Add one so we can prove the
    // post-upsert `getTitleById` reads from the cache, not Notion.
    const retrieveSpy = vi.fn(async () =>
      buildExistingMemoryPage("existing-mem", {
        topicKey: "runbook/db-migration",
        projectIds: ["P1"],
        revisionCount: 1,
        kind: "runbook",
        title: "Stale fallback",
      })
    )
    ;(client as unknown as { pages: { retrieve: typeof retrieveSpy } }).pages.retrieve =
      retrieveSpy

    const service = new MemoryService(client, db)

    // Seed the cache with the pre-upsert title.
    expect(await service.getTitleById("existing-mem")).toBe("Stale fallback")
    expect(retrieveSpy).toHaveBeenCalledTimes(1)

    await service.upsertByTopicKey({
      topicKey: "runbook/db-migration",
      projectIds: ["P1"],
      title: "Brand new title",
      content: "rev-2 body.",
      kind: "runbook",
    })

    // Post-upsert read returns the new title — the write-through
    // installed it; the cache is no longer stale.
    expect(await service.getTitleById("existing-mem")).toBe("Brand new title")
    // And critically, the read short-circuited on the cache hit —
    // no additional `pages.retrieve` was issued. Without the write-
    // through, the cache would still hold the seeded pre-upsert
    // title and this assertion would fail (the call would either
    // return the stale value or refetch via Notion).
    expect(retrieveSpy).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------
  // Promotion advisory on upsert response (0.9.0/15)
  // -------------------------------------------------------------------
  // The advisory fires only on the append-revision branch and only
  // when at least one threshold (`PROMOTE_REVISION_THRESHOLD = 5` OR
  // `PROMOTE_BODY_LENGTH_THRESHOLD = 5000`) is met. Fresh-create and
  // sub-threshold upserts return `null`. The values are starting
  // points; if real-vault data warrants a retune, update the const
  // and these test boundaries together.

  it("returns promotionAdvisory: null when revision count and body length are both below threshold", async () => {
    // Revision Count: 4 (existing 3 → 4) and an existing body well
    // under 5KB; neither threshold crosses, no advisory fires.
    const existing = buildExistingMemoryPage("existing-mem", {
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      revisionCount: 3,
      kind: "decision",
    })
    const { client } = makeUpsertClient({
      findResults: [existing],
      existingBody: "short body",
    })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      title: "JWT auth model",
      content: "small revision",
      kind: "decision",
    })

    expect(result.upserted).toBe(true)
    expect(result.revisionCount).toBe(4)
    expect(result.promotionAdvisory).toBeNull()
  })

  it("returns advisory with revisions reason only when revision count crosses but body length does not", async () => {
    // Revision Count: 5 (existing 4 → 5) — crosses
    // PROMOTE_REVISION_THRESHOLD; body stays small.
    const existing = buildExistingMemoryPage("existing-mem", {
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      revisionCount: 4,
      kind: "decision",
    })
    const { client } = makeUpsertClient({
      findResults: [existing],
      existingBody: "short body",
    })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      title: "JWT auth model",
      content: "small revision",
      kind: "decision",
    })

    expect(result.revisionCount).toBe(5)
    expect(result.promotionAdvisory).not.toBeNull()
    expect(result.promotionAdvisory!.reasons).toContain("5 revisions accumulated")
    expect(
      result.promotionAdvisory!.reasons.some((r) => r.startsWith("body length"))
    ).toBe(false)
    // Suggestion is the frozen ready-to-paste form documented in #15.
    // Test ID is the post-write memory's id; the MCP layer substitutes
    // `<this-memory-id>` at render time, so the service-layer string
    // carries the placeholder verbatim.
    expect(result.promotionAdvisory!.suggestion).toBe(
      "Consider promoting via lore-decision action='create' " +
        "with supersedesIds: [<this-memory-id>], or splitting " +
        "the topic into narrower topicKeys."
    )
  })

  it("returns advisory with body-length reason only when body crosses but revision count does not", async () => {
    // Revision Count: 3 (existing 2 → 3); existing body crosses 5KB,
    // so the assembled body (existing + revision block) certainly
    // crosses too.
    const longBody = "a".repeat(PROMOTE_BODY_LENGTH_THRESHOLD + 100)
    const existing = buildExistingMemoryPage("existing-mem", {
      topicKey: "runbook/db-migration",
      projectIds: ["P1"],
      revisionCount: 2,
      kind: "runbook",
    })
    const { client } = makeUpsertClient({
      findResults: [existing],
      existingBody: longBody,
    })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "runbook/db-migration",
      projectIds: ["P1"],
      title: "DB migration",
      content: "another step",
      kind: "runbook",
    })

    expect(result.revisionCount).toBe(3)
    expect(result.promotionAdvisory).not.toBeNull()
    expect(
      result.promotionAdvisory!.reasons.some((r) => r.startsWith("body length"))
    ).toBe(true)
    expect(result.promotionAdvisory!.reasons).not.toContain("3 revisions accumulated")
    expect(
      result.promotionAdvisory!.reasons.some((r) => r === "5 revisions accumulated")
    ).toBe(false)
    // Runbook is a non-decision kind. The upsert path forwards
    // `input.kind` to `computePromotionAdvisory`, which selects the
    // non-decision suggestion that drops `supersedesIds`
    // (DecisionService.getById would reject the non-decision id —
    // see the principal review on 0.9.0/15). Pinned end-to-end
    // through the upsert integration so a future contributor that
    // forgets to thread `kind` doesn't silently regress the user-
    // facing CTA back to the broken decision-only wording.
    expect(result.promotionAdvisory!.suggestion).not.toContain("supersedesIds")
    expect(result.promotionAdvisory!.suggestion).not.toContain("<this-memory-id>")
    expect(result.promotionAdvisory!.suggestion).toContain(
      "splitting the topic into narrower topicKeys"
    )
  })

  it("returns advisory with BOTH reasons when both thresholds cross", async () => {
    // Revision Count: 6 AND assembled body > 5KB — both reasons
    // appear in the same advisory, in the documented order
    // (revisions first, then body length).
    const longBody = "a".repeat(PROMOTE_BODY_LENGTH_THRESHOLD + 200)
    const existing = buildExistingMemoryPage("existing-mem", {
      topicKey: "runbook/db-migration",
      projectIds: ["P1"],
      revisionCount: 5,
      kind: "runbook",
    })
    const { client } = makeUpsertClient({
      findResults: [existing],
      existingBody: longBody,
    })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "runbook/db-migration",
      projectIds: ["P1"],
      title: "DB migration",
      content: "x",
      kind: "runbook",
    })

    expect(result.revisionCount).toBe(6)
    expect(result.promotionAdvisory).not.toBeNull()
    expect(result.promotionAdvisory!.reasons).toEqual([
      "6 revisions accumulated",
      expect.stringMatching(/^body length \d+ chars$/),
    ])
  })

  it("fresh-create upsert returns promotionAdvisory: null even when content is very long", async () => {
    // No existing match → create path → `upserted: false`. Even if
    // the caller passes a 6KB body, the spec deliberately scopes the
    // advisory to the append-revision branch only. Long-single-save
    // advisory is out of scope for 0.9.0.
    const longContent = "a".repeat(PROMOTE_BODY_LENGTH_THRESHOLD + 1000)
    const { client } = makeUpsertClient({ findResults: [] })
    const service = new MemoryService(client, db)

    const result = await service.upsertByTopicKey({
      topicKey: "decision/foo",
      projectIds: ["P1"],
      title: "Foo",
      content: longContent,
      kind: "decision",
    })

    expect(result.upserted).toBe(false)
    expect(result.revisionCount).toBe(1)
    expect(result.promotionAdvisory).toBeNull()
  })

  describe("LORE_USE_RUNTOOL_BLOCK_EDIT (issue #534)", () => {
    /** Build a body containing a fingerprinted revision-1 block whose
     *  fingerprint matches the existing memory's effective snapshot.
     *  The `pickRevisionAppendAnchor` helper requires a fingerprint
     *  line that occurs exactly once; this helper constructs the
     *  canonical revision-1 shape that `upsertByTopicKey` produces. */
    function fingerprintedRevisionBody(opts: {
      title: string
      content: string
      synopsis?: string
      keywords?: string
      source?: string
      confidence?: string
      author?: string
      preface?: string
    }): { body: string; fingerprint: string } {
      const fp = testTopicUpsertFingerprint({
        kind: "decision",
        title: opts.title,
        content: opts.content,
        synopsis: opts.synopsis ?? "",
        keywords: opts.keywords ?? "",
        source: opts.source ?? "manual",
        confidence: opts.confidence ?? "likely",
        author: opts.author ?? "",
      })
      // The revision block's prefix must start with `\n---\n` for
      // `extractLatestTopicRevision`'s regex; preface content gives
      // us a body that already has prior content above the latest
      // fingerprinted revision.
      const preface = opts.preface ?? "Initial body content"
      const block = [
        "",
        "---",
        "",
        "## Revision 1 (2026-04-01)",
        "",
        `<!-- lore-topic-upsert-sha256: ${fp} -->`,
        "",
        `**Title at this revision:** ${opts.title}`,
        "",
        opts.content,
      ].join("\n")
      return { body: preface + block, fingerprint: fp }
    }

    /** Make a client where `client.request` (the RunTool transport)
     *  is captured alongside the standard upsert spies. */
    function makeRunToolClient(
      base: ReturnType<typeof makeUpsertClient>,
      runToolBehavior: (body: unknown) => unknown = () => ({ page_id: "ok" })
    ) {
      const requestSpy = vi.fn(async (args: { path: string; body: unknown }) => {
        if (args.path === "tools/run") return runToolBehavior(args.body)
        throw new Error(`unexpected request path: ${args.path}`)
      })
      const wrapped = {
        ...base.client,
        request: requestSpy,
      } as unknown as Client
      return { client: wrapped, requestSpy }
    }

    afterEach(() => {
      delete process.env.LORE_USE_RUNTOOL_BLOCK_EDIT
      delete process.env.LORE_USE_RUNTOOL
    })

    it("uses update_content via RunTool when the flag is on and a fingerprinted anchor exists", async () => {
      // Fingerprinted revision-1 in the existing body gives the
      // `pickRevisionAppendAnchor` helper a unique anchor. With the
      // flag on the body write goes through `client.request` (RunTool)
      // and `pages.updateMarkdown` is NOT called — the issue #534
      // round-trip-reduction acceptance criterion.
      process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "1"
      const existing = buildExistingMemoryPage("11111111111111111111111111111111", {
        topicKey: "decision/jwt",
        projectIds: ["P1"],
        revisionCount: 1,
        kind: "decision",
        title: "JWT auth",
        source: "manual",
        confidence: "likely",
      })
      const { body } = fingerprintedRevisionBody({
        title: "JWT auth",
        content: "v1 content",
      })
      const base = makeUpsertClient({
        findResults: [existing],
        existingBody: body,
      })
      const { client, requestSpy } = makeRunToolClient(base)
      const service = new MemoryService(client, db)

      const result = await service.upsertByTopicKey({
        topicKey: "decision/jwt",
        projectIds: ["P1"],
        title: "JWT auth",
        content: "v2 content",
        kind: "decision",
        today: "2026-05-01",
      })

      expect(result.upserted).toBe(true)
      expect(result.revisionCount).toBe(2)
      expect(requestSpy).toHaveBeenCalledTimes(1)
      const call = requestSpy.mock.calls[0]![0] as {
        path: string
        body: { update_page: { command: string; content_updates: Array<unknown> } }
      }
      expect(call.path).toBe("tools/run")
      expect(call.body.update_page.command).toBe("update_content")
      expect(call.body.update_page.content_updates).toHaveLength(1)
      // The full-body fallback path stays unused on the happy path.
      expect(base.updateMarkdownSpy).not.toHaveBeenCalled()
    })

    it("falls back to full-body replace when no fingerprinted revision exists", async () => {
      // Pre-fingerprint legacy bodies (no `<!-- lore-topic-upsert-sha256:`
      // marker) cannot anchor safely; the helper returns null and the
      // canonical full-body path takes over. The flag-on test still
      // produces correctly-revised output — the flag toggle must never
      // break the save.
      process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "1"
      const existing = buildExistingMemoryPage("11111111111111111111111111111111", {
        topicKey: "decision/legacy",
        projectIds: ["P1"],
        revisionCount: 1,
        kind: "decision",
        title: "Legacy",
      })
      const base = makeUpsertClient({
        findResults: [existing],
        existingBody: "Plain body, no fingerprint.",
      })
      const { client, requestSpy } = makeRunToolClient(base)
      const service = new MemoryService(client, db)

      const result = await service.upsertByTopicKey({
        topicKey: "decision/legacy",
        projectIds: ["P1"],
        title: "Legacy v2",
        content: "new content",
        kind: "decision",
        today: "2026-05-01",
      })

      expect(result.upserted).toBe(true)
      expect(requestSpy).not.toHaveBeenCalled()
      expect(base.updateMarkdownSpy).toHaveBeenCalledTimes(1)
    })

    it("falls back to full-body replace when RunTool reports no_match", async () => {
      // The anchor was structurally valid at compose time but the
      // server saw a different body. Falling back to the full-body
      // path lets the save land — anchored failures must NOT leave
      // the revision unwritten.
      process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "1"
      const existing = buildExistingMemoryPage("11111111111111111111111111111111", {
        topicKey: "decision/jwt",
        projectIds: ["P1"],
        revisionCount: 1,
        kind: "decision",
        title: "JWT auth",
        source: "manual",
        confidence: "likely",
      })
      const { body } = fingerprintedRevisionBody({
        title: "JWT auth",
        content: "v1 content",
      })
      const base = makeUpsertClient({
        findResults: [existing],
        existingBody: body,
      })
      const noMatch = new APIResponseError({
        code: APIErrorCode.ValidationError,
        status: 400,
        message: "old_str did not match any content on the page",
        headers: new Headers(),
        rawBodyText: "{}",
        additional_data: undefined,
        request_id: undefined,
      })
      const { client, requestSpy } = makeRunToolClient(base, () => {
        throw noMatch
      })
      const service = new MemoryService(client, db)

      const result = await service.upsertByTopicKey({
        topicKey: "decision/jwt",
        projectIds: ["P1"],
        title: "JWT auth",
        content: "v2 content",
        kind: "decision",
        today: "2026-05-01",
      })

      expect(result.upserted).toBe(true)
      expect(requestSpy).toHaveBeenCalledTimes(1)
      expect(base.updateMarkdownSpy).toHaveBeenCalledTimes(1)
    })

    it("propagates non-validation RunTool errors verbatim (no silent fallback)", async () => {
      // 401 / 5xx must reach the auth-refresh proxy and the caller's
      // normal error path. Silently falling back here would mask a
      // genuine outage and could lead to runaway retries.
      process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "1"
      const existing = buildExistingMemoryPage("11111111111111111111111111111111", {
        topicKey: "decision/jwt",
        projectIds: ["P1"],
        revisionCount: 1,
        kind: "decision",
        title: "JWT auth",
        source: "manual",
        confidence: "likely",
      })
      const { body } = fingerprintedRevisionBody({
        title: "JWT auth",
        content: "v1 content",
      })
      const base = makeUpsertClient({
        findResults: [existing],
        existingBody: body,
      })
      const unauthorized = new APIResponseError({
        code: APIErrorCode.Unauthorized,
        status: 401,
        message: "unauthorized",
        headers: new Headers(),
        rawBodyText: "{}",
        additional_data: undefined,
        request_id: undefined,
      })
      const { client } = makeRunToolClient(base, () => {
        throw unauthorized
      })
      const service = new MemoryService(client, db)

      await expect(
        service.upsertByTopicKey({
          topicKey: "decision/jwt",
          projectIds: ["P1"],
          title: "JWT auth",
          content: "v2 content",
          kind: "decision",
        })
      ).rejects.toBe(unauthorized)
      expect(base.updateMarkdownSpy).not.toHaveBeenCalled()
    })

    it.each([
      [
        "multiple_matches",
        new APIResponseError({
          code: APIErrorCode.ValidationError,
          status: 400,
          message: "old_str matches more than once",
          headers: new Headers(),
          rawBodyText: "{}",
          additional_data: undefined,
          request_id: undefined,
        }),
      ],
      [
        "restricted_resource — integration-secret token can't pass actor check",
        new APIResponseError({
          code: APIErrorCode.RestrictedResource,
          status: 403,
          message: "Only public integrations can access this API.",
          headers: new Headers(),
          rawBodyText: "{}",
          additional_data: undefined,
          request_id: undefined,
        }),
      ],
    ])(
      "falls back to full-body replace on RunTool fall-back-able failure (%s)",
      async (_label, err) => {
        // Three of the four `RunToolBlockEditError` kinds drop the
        // upsert into the canonical full-body path: `no_match`
        // (covered above), `multiple_matches` (the body's anchor
        // recurs), and `restricted_resource` (issue-#534 security
        // review B1 — auth-class capability rejection that the
        // auth-refresh proxy cannot repair). Pinning all three at
        // the integration boundary so a future contributor narrowing
        // the catch (e.g. on `kind === "no_match"` only) is caught
        // by a failing test, not by a production outage on
        // integration-secret operators.
        process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "1"
        const stderrSpy = vi
          .spyOn(process.stderr, "write")
          .mockImplementation(() => true)
        try {
          const existing = buildExistingMemoryPage(
            "11111111111111111111111111111111",
            {
              topicKey: "decision/jwt",
              projectIds: ["P1"],
              revisionCount: 1,
              kind: "decision",
              title: "JWT auth",
              source: "manual",
              confidence: "likely",
            }
          )
          const { body } = fingerprintedRevisionBody({
            title: "JWT auth",
            content: "v1 content",
          })
          const base = makeUpsertClient({
            findResults: [existing],
            existingBody: body,
          })
          const { client, requestSpy } = makeRunToolClient(base, () => {
            throw err
          })
          const service = new MemoryService(client, db)

          const result = await service.upsertByTopicKey({
            topicKey: "decision/jwt",
            projectIds: ["P1"],
            title: "JWT auth",
            content: "v2 content",
            kind: "decision",
            today: "2026-05-01",
          })

          expect(result.upserted).toBe(true)
          expect(requestSpy).toHaveBeenCalledTimes(1)
          expect(base.updateMarkdownSpy).toHaveBeenCalledTimes(1)
        } finally {
          stderrSpy.mockRestore()
        }
      }
    )

    it("falls back to full-body replace on deletion_warning (200 + warning, no opt-in)", async () => {
      // The server can return a 200 with a deletion warning when the
      // edit would remove child pages and `allow_deleting_content`
      // wasn't opted in. Wrapper raises `RunToolBlockEditError({
      // kind: "deletion_warning" })`; the call site falls back so
      // the existing SDK path's `allow_deleting_content: true`
      // posture applies.
      process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "1"
      const existing = buildExistingMemoryPage("11111111111111111111111111111111", {
        topicKey: "decision/jwt",
        projectIds: ["P1"],
        revisionCount: 1,
        kind: "decision",
        title: "JWT auth",
        source: "manual",
        confidence: "likely",
      })
      const { body } = fingerprintedRevisionBody({
        title: "JWT auth",
        content: "v1 content",
      })
      const base = makeUpsertClient({
        findResults: [existing],
        existingBody: body,
      })
      const { client, requestSpy } = makeRunToolClient(base, () => ({
        page_id: "11111111111111111111111111111111",
        deletion_warning: { message: "would remove 1 child page" },
      }))
      const service = new MemoryService(client, db)

      const result = await service.upsertByTopicKey({
        topicKey: "decision/jwt",
        projectIds: ["P1"],
        title: "JWT auth",
        content: "v2 content",
        kind: "decision",
      })

      expect(result.upserted).toBe(true)
      expect(requestSpy).toHaveBeenCalledTimes(1)
      expect(base.updateMarkdownSpy).toHaveBeenCalledTimes(1)
    })

    it("default-off: dispatches REST even when a flag-on path WOULD have used RunTool", async () => {
      // Acceptance criterion #6 + Principal review #5: the
      // tautological version of this test only proves the spy isn't
      // invoked, which would also pass if `MemoryService` lost its
      // RunTool import entirely. The meaningful version pairs
      // flag-on (which MUST hit `client.request`) with flag-off
      // (which MUST NOT) so the assertion's pass/fail is wired to
      // the actual path-selection logic, not just to the spy's call
      // count.
      const existing = buildExistingMemoryPage("11111111111111111111111111111111", {
        topicKey: "decision/jwt",
        projectIds: ["P1"],
        revisionCount: 1,
        kind: "decision",
        title: "JWT auth",
        source: "manual",
        confidence: "likely",
      })
      const { body } = fingerprintedRevisionBody({
        title: "JWT auth",
        content: "v1 content",
      })

      // Phase 1: with the flag ON, the fingerprinted body MUST drive
      // a RunTool dispatch. If it doesn't, the fixture is broken and
      // the flag-off assertion below is meaningless.
      process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "1"
      const baseOn = makeUpsertClient({
        findResults: [existing],
        existingBody: body,
      })
      const { client: clientOn, requestSpy: requestSpyOn } = makeRunToolClient(baseOn)
      await new MemoryService(clientOn, db).upsertByTopicKey({
        topicKey: "decision/jwt",
        projectIds: ["P1"],
        title: "JWT auth",
        content: "v2 content",
        kind: "decision",
      })
      expect(requestSpyOn).toHaveBeenCalledTimes(1) // Pins the fixture is wired.

      // Phase 2: same fixture, flag explicitly OFF. The
      // path-selection logic must skip RunTool and go through
      // `pages.updateMarkdown`. A regression that lost the flag
      // check in `memory.ts` would make this test fail.
      // Issue #543 flipped the default to ON, so flag-off must be
      // set explicitly here rather than relying on env-unset.
      process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "0"
      process.env.LORE_USE_RUNTOOL = "0"
      const baseOff = makeUpsertClient({
        findResults: [existing],
        existingBody: body,
      })
      const { client: clientOff, requestSpy: requestSpyOff } =
        makeRunToolClient(baseOff)
      await new MemoryService(clientOff, db).upsertByTopicKey({
        topicKey: "decision/jwt",
        projectIds: ["P1"],
        title: "JWT auth",
        content: "v2 content",
        kind: "decision",
      })
      expect(requestSpyOff).not.toHaveBeenCalled()
      expect(baseOff.updateMarkdownSpy).toHaveBeenCalledTimes(1)
    })
  })
})

describe("computePromotionAdvisory (0.9.0/15)", () => {
  // Threshold-edge cases pin the inclusive (`>=`) semantics so a
  // future contributor can't silently shift to strict-greater and
  // quietly raise the firing point. These tests are purposefully
  // value-by-value rather than parametrized so a regression names
  // the exact boundary that drifted.
  //
  // Off-axis sentinel values are zero throughout so a single regex
  // sweep catches every reference if the threshold ever needs
  // retuning. The body-length reason renders the literal numeric
  // value (no thousands separator) — matches the prose-code form
  // in the spec at `0.9.0/Phase-3/15` and is asserted exactly so
  // any future reformatting (`toLocaleString`, etc.) requires an
  // intentional test update.

  it("returns null when both inputs are well below threshold", () => {
    expect(
      computePromotionAdvisory({
        revisionCount: 1,
        bodyLength: 100,
        kind: "decision",
      })
    ).toBeNull()
  })

  it("returns null on zero-state inputs (defensive — guards against `>=` mis-firing on initialized-but-empty state)", () => {
    // Defensive: a future caller that synthesizes the inputs from
    // null-coalesced fields (`existing.revisionCount ?? 0`, an empty
    // body) must not trigger the advisory. Pins the lower bound of
    // the inclusive `>=` semantics.
    expect(
      computePromotionAdvisory({
        revisionCount: 0,
        bodyLength: 0,
        kind: "decision",
      })
    ).toBeNull()
  })

  it("returns null at exactly one-below-threshold on both axes (revision=4, body=4999)", () => {
    expect(
      computePromotionAdvisory({
        revisionCount: PROMOTE_REVISION_THRESHOLD - 1,
        bodyLength: PROMOTE_BODY_LENGTH_THRESHOLD - 1,
        kind: "decision",
      })
    ).toBeNull()
  })

  it("fires the revisions reason at exactly the threshold (inclusive `>=`)", () => {
    const advisory = computePromotionAdvisory({
      revisionCount: PROMOTE_REVISION_THRESHOLD,
      bodyLength: 0,
      kind: "decision",
    })
    expect(advisory).not.toBeNull()
    expect(advisory!.reasons).toEqual(["5 revisions accumulated"])
  })

  it("fires the body-length reason at exactly the threshold (inclusive `>=`)", () => {
    const advisory = computePromotionAdvisory({
      revisionCount: 0,
      bodyLength: PROMOTE_BODY_LENGTH_THRESHOLD,
      kind: "decision",
    })
    expect(advisory).not.toBeNull()
    expect(advisory!.reasons).toEqual([
      `body length ${PROMOTE_BODY_LENGTH_THRESHOLD} chars`,
    ])
  })

  it("orders reasons revisions-first, body-length-second when both fire", () => {
    const advisory = computePromotionAdvisory({
      revisionCount: 7,
      bodyLength: 6000,
      kind: "decision",
    })
    expect(advisory).not.toBeNull()
    expect(advisory!.reasons).toEqual([
      "7 revisions accumulated",
      "body length 6000 chars",
    ])
  })

  it("returns the decision-kind suggestion string with the placeholder intact", () => {
    // The placeholder substitution happens at the MCP boundary — see
    // `formatPromotionAdvisory` in `src/mcp/tools/memory.ts`. The
    // service-layer return MUST carry the placeholder verbatim so the
    // boundary substitution is observable to tests. Decision-kind
    // memories are the ONLY topic-key-chain kind for which
    // `lore-decision action='create' supersedesIds: [...]` is a valid
    // ready-to-paste command (DecisionService.getById throws for
    // non-decision kinds), so the placeholder lives in this branch
    // alone.
    const advisory = computePromotionAdvisory({
      revisionCount: 5,
      bodyLength: 0,
      kind: "decision",
    })
    expect(advisory!.suggestion).toBe(
      "Consider promoting via lore-decision action='create' " +
        "with supersedesIds: [<this-memory-id>], or splitting " +
        "the topic into narrower topicKeys."
    )
  })

  it.each([["runbook"], ["incident"], ["postmortem"], ["policy"]] as const)(
    "returns the non-decision suggestion (no supersedesIds, no placeholder) for kind=%s",
    (kind) => {
      // Non-decision kinds are valid topic-key chains (per the
      // README's `runbook/database-migration`,
      // `incident/login-redirect-502`, `postmortem/payment-gateway-timeout`,
      // `policy/code-review-min-reviewers` examples) but
      // `lore-decision action='create' supersedesIds: [<id>]` rejects
      // a non-decision id at the `DecisionService.getById` resolver
      // step — handing the operator a broken ready-to-paste command.
      // The non-decision branch drops the supersedesIds wording and
      // surfaces the universally-valid split / archive paths
      // instead.
      const advisory = computePromotionAdvisory({
        revisionCount: 5,
        bodyLength: 0,
        kind,
      })
      expect(advisory!.suggestion).toBe(
        "Consider splitting the topic into narrower topicKeys, " +
          "or archiving this chain via lore-memory action='archive' " +
          "and starting a fresh chain with a more specific topicKey."
      )
      // The placeholder appears in the decision branch only — no
      // substitution surface lives in the non-decision path. Pinning
      // its absence here means the MCP boundary's `replaceAll` call
      // becomes a no-op for these kinds without any worry that a
      // partial replace could leak into the rendered footer.
      expect(advisory!.suggestion).not.toContain("<this-memory-id>")
      expect(advisory!.suggestion).not.toContain("supersedesIds")
    }
  )
})

describe("MemoryService.rekeyTopicKey (0.9.0/14)", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  /**
   * Build a `pages.retrieve` response shaped like a memory with the
   * given Topic Key + project set + revision count. Mirrors
   * `findByTopicKey` test fixtures so both describe blocks read off
   * the same page shape.
   */
  function buildMemoryPage(
    id: string,
    opts: {
      title?: string
      topicKey: string
      projectIds: string[]
      revisionCount?: number
      archived?: boolean
    }
  ): PageObjectResponse {
    const properties: Record<string, unknown> = {
      Title: { type: "title", title: [{ plain_text: opts.title ?? id }] },
      Project: {
        type: "relation",
        relation: opts.projectIds.map((pid) => ({ id: pid })),
      },
      "Topic Key": {
        type: "rich_text",
        rich_text: [{ plain_text: opts.topicKey }],
      },
    }
    if (opts.revisionCount !== undefined) {
      properties["Revision Count"] = { type: "number", number: opts.revisionCount }
    }
    return {
      object: "page",
      id,
      created_time: "2026-04-20T00:00:00.000Z",
      last_edited_time: "2026-04-20T00:00:00.000Z",
      archived: opts.archived ?? false,
      properties: properties as PageObjectResponse["properties"],
      parent: { type: "database_id", database_id: db.databaseId },
      url: `https://notion.so/${id}`,
    } as PageObjectResponse
  }

  function makeRekeyClient(opts: {
    targetMemory: PageObjectResponse
    targetMarkdown: string
    collisionPages?: PageObjectResponse[]
  }) {
    const retrieveSpy = vi.fn(async (_args: { page_id: string }) => opts.targetMemory)
    const retrieveMarkdownSpy = vi.fn(async (_args: { page_id: string }) => ({
      markdown: opts.targetMarkdown,
    }))
    const querySpy = vi.fn(
      async (_args: {
        data_source_id: string
        filter?: unknown
        start_cursor?: string
      }) => ({
        results: opts.collisionPages ?? [],
        has_more: false,
        next_cursor: null,
      })
    )
    const updateSpy = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => ({})
    )
    const updateMarkdownSpy = vi.fn(
      async (_args: {
        page_id: string
        type: string
        replace_content: { new_str: string; allow_deleting_content: boolean }
      }) => ({})
    )
    const client = {
      pages: {
        retrieve: retrieveSpy,
        retrieveMarkdown: retrieveMarkdownSpy,
        update: updateSpy,
        updateMarkdown: updateMarkdownSpy,
      },
      dataSources: { query: querySpy },
    } as unknown as Client
    return {
      client,
      retrieveSpy,
      retrieveMarkdownSpy,
      querySpy,
      updateSpy,
      updateMarkdownSpy,
    }
  }

  it("happy path: writes Topic Key and appends an audit block; Revision Count untouched", async () => {
    const target = buildMemoryPage("mem-1", {
      title: "Use JWT auth",
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
      revisionCount: 3,
    })
    const { client, updateSpy, updateMarkdownSpy } = makeRekeyClient({
      targetMemory: target,
      targetMarkdown: "Original body content.",
    })
    const service = new MemoryService(client, db)

    const result = await service.rekeyTopicKey({
      memoryId: "mem-1",
      newTopicKey: "decision/jwt-auth-model",
    })

    expect(result.oldTopicKey).toBe("decision/jwt-auth")
    expect(result.memory.topicKey).toBe("decision/jwt-auth-model")

    // Property update wrote ONLY Topic Key (not Revision Count, not
    // Last Referenced At, not Title). Pinning the exact key set so a
    // future "always re-write all properties" refactor can't silently
    // bump the counter.
    expect(updateSpy).toHaveBeenCalledTimes(1)
    const props = updateSpy.mock.calls[0]![0].properties as Record<string, unknown>
    expect(Object.keys(props)).toEqual(["Topic Key"])
    expect(props["Topic Key"]).toEqual({
      rich_text: [{ text: { content: "decision/jwt-auth-model" } }],
    })

    // Body write appended the audit block to the existing content.
    expect(updateMarkdownSpy).toHaveBeenCalledTimes(1)
    const body = updateMarkdownSpy.mock.calls[0]![0]
    expect(body.type).toBe("replace_content")
    const newStr = body.replace_content.new_str as string
    expect(newStr).toContain("Original body content.")
    // Audit block layout: leading empty line + `---` separator +
    // blank line + heading + blank line + From/To pair. The spec's
    // "audit block format is exact" criterion pins everything from
    // the heading onwards.
    expect(newStr).toMatch(
      /\n---\n\n## Re-keyed \(\d{4}-\d{2}-\d{2}\)\n\n\*\*From:\*\* `decision\/jwt-auth`\n\*\*To:\*\* `decision\/jwt-auth-model`$/
    )
  })

  it("no-op when newTopicKey matches existing: no body write, no property write", async () => {
    const target = buildMemoryPage("mem-1", {
      topicKey: "decision/jwt-auth",
      projectIds: ["P1"],
    })
    const { client, updateSpy, updateMarkdownSpy, querySpy } = makeRekeyClient({
      targetMemory: target,
      targetMarkdown: "body",
    })
    const service = new MemoryService(client, db)

    const result = await service.rekeyTopicKey({
      memoryId: "mem-1",
      newTopicKey: "decision/jwt-auth",
    })

    expect(result.oldTopicKey).toBe("decision/jwt-auth")
    expect(updateSpy).not.toHaveBeenCalled()
    expect(updateMarkdownSpy).not.toHaveBeenCalled()
    // The collision-check `dataSources.query` is also not issued — the
    // no-op short-circuit fires BEFORE the collision probe.
    expect(querySpy).not.toHaveBeenCalled()
  })

  it("rejects re-key on a memory with empty projectIds (structural undefined identity)", async () => {
    const target = buildMemoryPage("mem-1", {
      topicKey: "decision/old",
      projectIds: [],
    })
    const { client, updateSpy, updateMarkdownSpy } = makeRekeyClient({
      targetMemory: target,
      targetMarkdown: "body",
    })
    const service = new MemoryService(client, db)

    await expect(
      service.rekeyTopicKey({ memoryId: "mem-1", newTopicKey: "decision/new" })
    ).rejects.toThrow(/empty projectIds/)

    // Guard fires before any mutation.
    expect(updateSpy).not.toHaveBeenCalled()
    expect(updateMarkdownSpy).not.toHaveBeenCalled()
  })

  it("rejects re-key when the new key collides with another live memory in the same project-set", async () => {
    const target = buildMemoryPage("mem-1", {
      topicKey: "decision/old",
      projectIds: ["P1"],
    })
    const collider = buildMemoryPage("mem-collider", {
      topicKey: "decision/new",
      projectIds: ["P1"],
    })
    const { client, updateSpy, updateMarkdownSpy } = makeRekeyClient({
      targetMemory: target,
      targetMarkdown: "body",
      collisionPages: [collider],
    })
    const service = new MemoryService(client, db)

    await expect(
      service.rekeyTopicKey({ memoryId: "mem-1", newTopicKey: "decision/new" })
    ).rejects.toThrow(/already in use by memory mem-collider/)

    // Collision check fires BEFORE any mutation — pin the no-write
    // posture so a future refactor that re-orders the body write
    // before the collision check breaks the test.
    expect(updateSpy).not.toHaveBeenCalled()
    expect(updateMarkdownSpy).not.toHaveBeenCalled()
  })

  it("renders `(unset)` in the audit block when re-keying a memory with no prior topic key", async () => {
    const target = buildMemoryPage("mem-1", {
      topicKey: "",
      projectIds: ["P1"],
    })
    const { client, updateMarkdownSpy } = makeRekeyClient({
      targetMemory: target,
      targetMarkdown: "body",
    })
    const service = new MemoryService(client, db)

    await service.rekeyTopicKey({
      memoryId: "mem-1",
      newTopicKey: "decision/fresh",
    })

    const newStr = updateMarkdownSpy.mock.calls[0]![0].replace_content.new_str as string
    expect(newStr).toContain("**From:** `(unset)`")
    expect(newStr).toContain("**To:** `decision/fresh`")
  })

  it("integration: a sequential `update` then `rekeyTopicKey` against a stateful client produces a final body containing BOTH new content and the audit block", async () => {
    // Pin for the P1 fix: `handleUpdate` dispatches
    // `services.memories.update` FIRST, then
    // `services.memories.rekeyTopicKey`. This integration-style
    // test wires a stateful fake Notion client whose `replace_content`
    // writes mutate a tracked body string, so a subsequent
    // `retrieveMarkdown` reflects the prior write — the same shape
    // a real Notion API would expose.
    //
    // Without this ordering, `rekeyTopicKey`'s audit append (when
    // run first) would be silently clobbered by
    // `MemoryService.update`'s full-body `replace_content`. The MCP
    // call-order test on its own is necessary but not sufficient
    // because it mocks both service methods and never touches body
    // state — that's the regression the prior coverage missed.
    const memoryId = "mem-1"
    const props: Record<string, unknown> = {
      Title: { type: "title", title: [{ plain_text: "Use JWT auth" }] },
      Project: { type: "relation", relation: [{ id: "P1" }] },
      "Topic Key": {
        type: "rich_text",
        rich_text: [{ plain_text: "decision/old" }],
      },
    }
    let body = "Original content."

    const buildPageResponse = (): PageObjectResponse =>
      ({
        object: "page",
        id: memoryId,
        created_time: "2026-04-20T00:00:00.000Z",
        last_edited_time: "2026-04-20T00:00:00.000Z",
        archived: false,
        properties: { ...props } as PageObjectResponse["properties"],
        parent: { type: "database_id", database_id: db.databaseId },
        url: "",
      }) as PageObjectResponse

    const client = {
      pages: {
        retrieve: vi.fn(async (_args: { page_id: string }) => buildPageResponse()),
        retrieveMarkdown: vi.fn(async (_args: { page_id: string }) => ({
          markdown: body,
        })),
        update: vi.fn(
          async (args: { page_id: string; properties: Record<string, unknown> }) => {
            for (const [k, v] of Object.entries(args.properties)) {
              props[k] = v
            }
            return {}
          }
        ),
        updateMarkdown: vi.fn(
          async (args: {
            page_id: string
            type: string
            replace_content?: { new_str: string }
          }) => {
            if (args.type === "replace_content" && args.replace_content) {
              body = args.replace_content.new_str
            }
            return {}
          }
        ),
      },
      dataSources: {
        query: vi.fn(
          async (_args: {
            data_source_id: string
            filter?: unknown
            start_cursor?: string
          }) => ({ results: [], has_more: false, next_cursor: null })
        ),
      },
    } as unknown as Client

    const service = new MemoryService(client, db)

    // Mirror the dispatch order that the MCP `handleUpdate` uses
    // for combined `topicKey + content` calls: content update
    // FIRST, re-key SECOND.
    await service.update(memoryId, { content: "New body content" })
    await service.rekeyTopicKey({
      memoryId,
      newTopicKey: "decision/new",
    })

    expect(body).toContain("New body content")
    expect(body).toMatch(/## Re-keyed \(\d{4}-\d{2}-\d{2}\)/)
    expect(body).toContain("**From:** `decision/old`")
    expect(body).toContain("**To:** `decision/new`")
  })

  it("property-write failure: throws the underlying error and leaves the body entirely untouched (no audit append)", async () => {
    // Pin for the P2 fix's reverse ordering. With property-first /
    // audit-second, a property-write rejection at the start of
    // `rekeyTopicKey` throws BEFORE any body mutation. The page's
    // body, the page's properties, and any retry-state are
    // untouched — the error is the standard Notion error, NOT a
    // `RekeyAuditError`. A retry runs the full pipeline cleanly:
    // collision check is still valid, no body drift to undo, no
    // duplicate audit blocks.
    const target = buildMemoryPage("mem-1", {
      topicKey: "decision/old",
      projectIds: ["P1"],
    })
    const propertyError = new Error("Notion property update failed (validation_error)")
    const updateSpy = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => {
        throw propertyError
      }
    )
    const updateMarkdownSpy = vi.fn(
      async (_args: {
        page_id: string
        type: string
        replace_content: { new_str: string; allow_deleting_content: boolean }
      }) => ({})
    )
    const client = {
      pages: {
        retrieve: vi.fn(async () => target),
        retrieveMarkdown: vi.fn(async () => ({ markdown: "body" })),
        update: updateSpy,
        updateMarkdown: updateMarkdownSpy,
      },
      dataSources: {
        query: vi.fn(async () => ({ results: [], has_more: false, next_cursor: null })),
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await expect(
      service.rekeyTopicKey({ memoryId: "mem-1", newTopicKey: "decision/new" })
    ).rejects.toBe(propertyError)

    // Property write was attempted exactly once; body write was
    // NOT attempted — the audit block never lands on a row whose
    // property update failed. Pinning the no-body-write posture so
    // a future "always append audit, then property" reordering
    // would break this test.
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateMarkdownSpy).not.toHaveBeenCalled()
  })

  it("audit-append failure after property success: throws RekeyAuditError carrying the partial-state details", async () => {
    // Pin for P2's structured partial-state error. With
    // property-first / audit-second, an audit-append failure
    // after a successful property write leaves the row in a
    // partial state: the Topic Key column is updated (the
    // load-bearing identity change persisted) but the body audit
    // trail is missing. `rekeyTopicKey` raises a distinct
    // `RekeyAuditError` so the MCP layer (and any future operator
    // tooling) can distinguish "rekey didn't happen" from "rekey
    // happened but audit is missing." A retry will short-circuit
    // through the no-op guard since the property now matches the
    // new key — the audit block cannot be recovered automatically;
    // operators inspect the error message for the remediation hint.
    const target = buildMemoryPage("mem-1", {
      topicKey: "decision/old",
      projectIds: ["P1"],
    })
    const auditError = new Error("Notion body update failed (502)")
    const updateSpy = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => ({})
    )
    const updateMarkdownSpy = vi.fn(
      async (_args: {
        page_id: string
        type: string
        replace_content: { new_str: string; allow_deleting_content: boolean }
      }) => {
        throw auditError
      }
    )
    const client = {
      pages: {
        retrieve: vi.fn(async () => target),
        retrieveMarkdown: vi.fn(async () => ({ markdown: "body" })),
        update: updateSpy,
        updateMarkdown: updateMarkdownSpy,
      },
      dataSources: {
        query: vi.fn(async () => ({ results: [], has_more: false, next_cursor: null })),
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    let caught: unknown
    try {
      await service.rekeyTopicKey({
        memoryId: "mem-1",
        newTopicKey: "decision/new",
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(RekeyAuditError)
    const rekeyErr = caught as RekeyAuditError
    expect(rekeyErr.memoryId).toBe("mem-1")
    expect(rekeyErr.oldTopicKey).toBe("decision/old")
    expect(rekeyErr.newTopicKey).toBe("decision/new")
    expect(rekeyErr.cause).toBe(auditError)
    expect(rekeyErr.message).toMatch(/Re-key persisted/)
    expect(rekeyErr.message).toMatch(/audit-block append failed/)
    expect(rekeyErr.message).toContain("decision/old")
    expect(rekeyErr.message).toContain("decision/new")

    // Both writes were attempted; property write succeeded
    // (load-bearing identity change persisted), audit failed
    // (cosmetic body trail missing).
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateMarkdownSpy).toHaveBeenCalledTimes(1)
  })

  it("validateRekey: returns willRekey=false on no-op (newKey === oldKey) without issuing collision query", async () => {
    // The preflight short-circuits the no-op case BEFORE the
    // collision query fires. Pin verifies the no-op path is one
    // `getById` round-trip and zero `dataSources.query` calls.
    // This matters because `handleUpdate`'s no-op branch reads
    // `willRekey: false` and skips the actual `rekeyTopicKey`
    // call — if validateRekey ever started doing the query
    // anyway, the preflight would burn a round-trip on a path
    // that's structurally guaranteed to be a no-op.
    const target = buildMemoryPage("mem-1", {
      topicKey: "decision/same",
      projectIds: ["P1"],
    })
    const { client, querySpy, updateSpy, updateMarkdownSpy } = makeRekeyClient({
      targetMemory: target,
      targetMarkdown: "body",
    })
    const service = new MemoryService(client, db)

    const result = await service.validateRekey({
      memoryId: "mem-1",
      newTopicKey: "decision/same",
    })

    expect(result.willRekey).toBe(false)
    expect(result.oldTopicKey).toBe("decision/same")
    expect(querySpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
    expect(updateMarkdownSpy).not.toHaveBeenCalled()
  })

  it("validateRekey: throws on empty projectIds without issuing collision query (no mutation either way)", async () => {
    // The empty-projectIds guard fires before the collision query.
    // Pin both the throw AND the query short-circuit so a future
    // re-order doesn't accidentally start querying first.
    const target = buildMemoryPage("mem-1", {
      topicKey: "decision/old",
      projectIds: [],
    })
    const { client, querySpy, updateSpy, updateMarkdownSpy } = makeRekeyClient({
      targetMemory: target,
      targetMarkdown: "body",
    })
    const service = new MemoryService(client, db)

    await expect(
      service.validateRekey({ memoryId: "mem-1", newTopicKey: "decision/new" })
    ).rejects.toThrow(/empty projectIds/)
    expect(querySpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
    expect(updateMarkdownSpy).not.toHaveBeenCalled()
  })

  it("validateRekey: throws collision error naming the colliding memory; no mutation occurs", async () => {
    // Same collision-detection contract as `rekeyTopicKey`'s own
    // collision check, surfaced as a preflight so the MCP handler
    // can fail fast before running an unrelated content update.
    // Pin the no-mutation posture so callers can rely on
    // validateRekey being structurally side-effect-free.
    const target = buildMemoryPage("mem-1", {
      topicKey: "decision/old",
      projectIds: ["P1"],
    })
    const collider = buildMemoryPage("mem-collider", {
      topicKey: "decision/new",
      projectIds: ["P1"],
    })
    const { client, updateSpy, updateMarkdownSpy } = makeRekeyClient({
      targetMemory: target,
      targetMarkdown: "body",
      collisionPages: [collider],
    })
    const service = new MemoryService(client, db)

    await expect(
      service.validateRekey({ memoryId: "mem-1", newTopicKey: "decision/new" })
    ).rejects.toThrow(/already in use by memory mem-collider/)
    expect(updateSpy).not.toHaveBeenCalled()
    expect(updateMarkdownSpy).not.toHaveBeenCalled()
  })

  it("validateRekey: returns willRekey=true with current state for a clean re-key", async () => {
    // Happy-path pin: a clean re-key resolves to
    // `{ memory, oldTopicKey, willRekey: true }` after exactly one
    // `getById` plus one `dataSources.query` (the collision check).
    // No mutations.
    const target = buildMemoryPage("mem-1", {
      topicKey: "decision/old",
      projectIds: ["P1"],
    })
    const { client, querySpy, updateSpy, updateMarkdownSpy } = makeRekeyClient({
      targetMemory: target,
      targetMarkdown: "body",
    })
    const service = new MemoryService(client, db)

    const result = await service.validateRekey({
      memoryId: "mem-1",
      newTopicKey: "decision/new",
    })

    expect(result.willRekey).toBe(true)
    expect(result.oldTopicKey).toBe("decision/old")
    expect(result.memory.id).toBe("mem-1")
    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(updateSpy).not.toHaveBeenCalled()
    expect(updateMarkdownSpy).not.toHaveBeenCalled()
  })

  describe("LORE_USE_RUNTOOL_BLOCK_EDIT (issue #534)", () => {
    function makeRekeyRunToolClient(
      base: ReturnType<typeof makeRekeyClient>,
      runToolBehavior: (body: unknown) => unknown = () => ({ page_id: "ok" })
    ) {
      const requestSpy = vi.fn(async (args: { path: string; body: unknown }) => {
        if (args.path === "tools/run") return runToolBehavior(args.body)
        throw new Error(`unexpected request path: ${args.path}`)
      })
      const wrapped = {
        ...base.client,
        request: requestSpy,
      } as unknown as Client
      return { client: wrapped, requestSpy }
    }

    afterEach(() => {
      delete process.env.LORE_USE_RUNTOOL_BLOCK_EDIT
      delete process.env.LORE_USE_RUNTOOL
    })

    it("uses update_content via RunTool when the flag is on and the body has a unique tail anchor", async () => {
      // The non-empty body trivially satisfies the tail-anchor
      // uniqueness check (one occurrence). The audit append rides
      // through `client.request` and the canonical
      // `pages.updateMarkdown` path is NOT called.
      process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "1"
      const target = buildMemoryPage("11111111111111111111111111111111", {
        title: "Use JWT",
        topicKey: "decision/jwt-old",
        projectIds: ["P1"],
        revisionCount: 1,
      })
      const base = makeRekeyClient({
        targetMemory: target,
        targetMarkdown: "Distinct body content with the JWT decision details.",
      })
      const { client, requestSpy } = makeRekeyRunToolClient(base)
      const service = new MemoryService(client, db)

      const result = await service.rekeyTopicKey({
        memoryId: "11111111111111111111111111111111",
        newTopicKey: "decision/jwt-new",
      })

      expect(result.oldTopicKey).toBe("decision/jwt-old")
      expect(requestSpy).toHaveBeenCalledTimes(1)
      const call = requestSpy.mock.calls[0]![0] as {
        path: string
        body: { update_page: { command: string; content_updates: Array<unknown> } }
      }
      expect(call.path).toBe("tools/run")
      expect(call.body.update_page.command).toBe("update_content")
      expect(base.updateMarkdownSpy).not.toHaveBeenCalled()
      // The property write (Topic Key) is unchanged from default-off.
      expect(base.updateSpy).toHaveBeenCalledTimes(1)
    })

    it("falls back to full-body replace_content on empty body (no anchor available)", async () => {
      // An empty body has no tail to anchor on; helper returns null
      // and the canonical `replace_content` path with `new_str =
      // auditBlock` runs. Mirrors the default-off behavior shape so a
      // re-key against a freshly-seeded body still produces the audit
      // block.
      process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "1"
      const target = buildMemoryPage("11111111111111111111111111111111", {
        title: "Use JWT",
        topicKey: "decision/jwt-old",
        projectIds: ["P1"],
        revisionCount: 1,
      })
      const base = makeRekeyClient({
        targetMemory: target,
        targetMarkdown: "",
      })
      const { client, requestSpy } = makeRekeyRunToolClient(base)
      const service = new MemoryService(client, db)

      await service.rekeyTopicKey({
        memoryId: "11111111111111111111111111111111",
        newTopicKey: "decision/jwt-new",
      })

      expect(requestSpy).not.toHaveBeenCalled()
      expect(base.updateMarkdownSpy).toHaveBeenCalledTimes(1)
    })

    it("preserves the RekeyAuditError contract when the RunTool audit fails AND fallback also fails", async () => {
      // Acceptance criterion #4: the partial-state error contract
      // must hold across paths. RunTool's structured fall-back-able
      // signals (no_match etc.) drop into the canonical path; that
      // path's failures wrap as `RekeyAuditError` exactly as before.
      // Here we force the canonical path to fail too so the error
      // shape is observable end-to-end with the flag on.
      process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "1"
      const target = buildMemoryPage("11111111111111111111111111111111", {
        title: "Use JWT",
        topicKey: "decision/jwt-old",
        projectIds: ["P1"],
        revisionCount: 1,
      })
      const base = makeRekeyClient({
        targetMemory: target,
        targetMarkdown: "Some body content that is sufficient for an anchor.",
      })
      const noMatch = new APIResponseError({
        code: APIErrorCode.ValidationError,
        status: 400,
        message: "old_str did not match any content on the page",
        headers: new Headers(),
        rawBodyText: "{}",
        additional_data: undefined,
        request_id: undefined,
      })
      const { client, requestSpy } = makeRekeyRunToolClient(base, () => {
        throw noMatch
      })
      // Force the fallback canonical path to also fail.
      base.updateMarkdownSpy.mockRejectedValueOnce(new Error("fallback failed"))
      const service = new MemoryService(client, db)

      await expect(
        service.rekeyTopicKey({ memoryId: "11111111111111111111111111111111", newTopicKey: "decision/jwt-new" })
      ).rejects.toMatchObject({
        name: "RekeyAuditError",
        memoryId: "11111111111111111111111111111111",
        oldTopicKey: "decision/jwt-old",
        newTopicKey: "decision/jwt-new",
      })

      // Both paths were attempted and the property write landed —
      // load-bearing for the partial-state contract semantics.
      expect(requestSpy).toHaveBeenCalledTimes(1)
      expect(base.updateMarkdownSpy).toHaveBeenCalledTimes(1)
      expect(base.updateSpy).toHaveBeenCalledTimes(1)
    })

    it("wraps RunTool non-validation failures as RekeyAuditError (not silent fallback)", async () => {
      // 401 / 5xx from RunTool must not silently fall through to the
      // canonical path — the partial state is the same shape (property
      // wrote, audit didn't), so the operator gets the same
      // diagnostic surface regardless of which transport the audit
      // attempt used.
      process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "1"
      const target = buildMemoryPage("11111111111111111111111111111111", {
        title: "Use JWT",
        topicKey: "decision/jwt-old",
        projectIds: ["P1"],
        revisionCount: 1,
      })
      const base = makeRekeyClient({
        targetMemory: target,
        targetMarkdown: "Some body content that is sufficient for an anchor.",
      })
      const unauthorized = new APIResponseError({
        code: APIErrorCode.Unauthorized,
        status: 401,
        message: "unauthorized",
        headers: new Headers(),
        rawBodyText: "{}",
        additional_data: undefined,
        request_id: undefined,
      })
      const { client } = makeRekeyRunToolClient(base, () => {
        throw unauthorized
      })
      const service = new MemoryService(client, db)

      await expect(
        service.rekeyTopicKey({ memoryId: "11111111111111111111111111111111", newTopicKey: "decision/jwt-new" })
      ).rejects.toMatchObject({
        name: "RekeyAuditError",
        memoryId: "11111111111111111111111111111111",
      })

      // The canonical fallback was NOT attempted — we want the
      // operator to see the underlying transport failure rather than
      // double up on writes.
      expect(base.updateMarkdownSpy).not.toHaveBeenCalled()
      expect(base.updateSpy).toHaveBeenCalledTimes(1)
    })

    it.each([
      [
        "multiple_matches",
        () => ({
          throw: new APIResponseError({
            code: APIErrorCode.ValidationError,
            status: 400,
            message: "old_str matches more than once",
            headers: new Headers(),
            rawBodyText: "{}",
            additional_data: undefined,
            request_id: undefined,
          }),
        }),
      ],
      [
        "restricted_resource — integration-secret token can't pass actor check",
        () => ({
          throw: new APIResponseError({
            code: APIErrorCode.RestrictedResource,
            status: 403,
            message: "Only public integrations can access this API.",
            headers: new Headers(),
            rawBodyText: "{}",
            additional_data: undefined,
            request_id: undefined,
          }),
        }),
      ],
      [
        "deletion_warning — server reports child-page removal without opt-in",
        () => ({
          return: {
            page_id: "11111111111111111111111111111111",
            deletion_warning: { message: "would remove 1 child page" },
          },
        }),
      ],
    ])(
      "falls back to canonical replace_content on RunTool fall-back-able failure (%s)",
      async (_label, makeBehavior) => {
        // Issue-#534 security review B1+B2: 403 RestrictedResource
        // must drop into the canonical REST path instead of raising
        // a misleading `RekeyAuditError`. Pinning all three
        // fall-back-able kinds at the integration boundary so a
        // future contributor narrowing the catch is caught by a
        // failing test, not by a production false-positive
        // partial-state error.
        process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "1"
        const stderrSpy = vi
          .spyOn(process.stderr, "write")
          .mockImplementation(() => true)
        try {
          const target = buildMemoryPage("11111111111111111111111111111111", {
            title: "Use JWT",
            topicKey: "decision/jwt-old",
            projectIds: ["P1"],
            revisionCount: 1,
          })
          const base = makeRekeyClient({
            targetMemory: target,
            targetMarkdown: "Some body content that is sufficient for an anchor.",
          })
          const behavior = makeBehavior()
          const { client, requestSpy } = makeRekeyRunToolClient(base, () => {
            if ("throw" in behavior) throw behavior.throw
            return behavior.return
          })
          const service = new MemoryService(client, db)

          await service.rekeyTopicKey({
            memoryId: "11111111111111111111111111111111",
            newTopicKey: "decision/jwt-new",
          })

          // RunTool was attempted, then the canonical REST path took
          // over — and the property-write happened exactly once
          // (load-bearing for the no-double-write contract).
          expect(requestSpy).toHaveBeenCalledTimes(1)
          expect(base.updateMarkdownSpy).toHaveBeenCalledTimes(1)
          expect(base.updateSpy).toHaveBeenCalledTimes(1)
        } finally {
          stderrSpy.mockRestore()
        }
      }
    )

    it("emits a LORE_DEBUG-gated stderr line when the rekey anchor is not unique (Principal review #4)", async () => {
      // Operator observability for the anchor-miss case. The
      // pickRekeyAuditAnchor fall-back is silent under default
      // logging (correct; not noisy on every common case) but emits
      // one stderr line under LORE_DEBUG=1 so an operator running
      // dogfood can distinguish "RunTool engaged" from "anchor
      // missed → REST fallback ran" without inspecting the wire.
      const priorDebug = process.env.LORE_DEBUG
      process.env.LORE_DEBUG = "1"
      process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "1"
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true)
      try {
        const target = buildMemoryPage("11111111111111111111111111111111", {
          title: "Repetitive",
          topicKey: "decision/old",
          projectIds: ["P1"],
          revisionCount: 1,
        })
        // Build a body whose 256-byte tail is NOT unique. The simplest
        // shape: a body that's exactly the same 8-byte sequence
        // repeated ~64 times — the tail substring recurs throughout.
        const repetitive = "ABCDEFGH".repeat(64)
        const base = makeRekeyClient({
          targetMemory: target,
          targetMarkdown: repetitive,
        })
        const { client, requestSpy } = makeRekeyRunToolClient(base)
        const service = new MemoryService(client, db)

        await service.rekeyTopicKey({
          memoryId: "11111111111111111111111111111111",
          newTopicKey: "decision/new",
        })

        const writes = stderrSpy.mock.calls.map((args) => String(args[0]))
        expect(writes.some((w) => w.includes("rekey-anchor-miss"))).toBe(true)
        // Anchor was not unique → the helper returned null → RunTool
        // was never attempted.
        expect(requestSpy).not.toHaveBeenCalled()
        expect(base.updateMarkdownSpy).toHaveBeenCalledTimes(1)
      } finally {
        if (priorDebug === undefined) delete process.env.LORE_DEBUG
        else process.env.LORE_DEBUG = priorDebug
        stderrSpy.mockRestore()
      }
    })

    it("default-off: dispatches REST even when a flag-on path WOULD have used RunTool", async () => {
      // Principal review #5: paired flag-on / flag-off assertion so
      // the test cannot pass tautologically. With the flag on, the
      // unique tail anchor MUST drive a `client.request` call; with
      // the flag off, it MUST NOT. A regression that lost the flag
      // check in `memory.ts` would trip Phase 2.
      const target = buildMemoryPage("11111111111111111111111111111111", {
        title: "Use JWT",
        topicKey: "decision/jwt-old",
        projectIds: ["P1"],
        revisionCount: 1,
      })
      const targetMarkdown =
        "Body content that is unique end-to-end so the tail anchor is well-formed."

      // Phase 1: flag ON — must dispatch RunTool.
      process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "1"
      const baseOn = makeRekeyClient({
        targetMemory: target,
        targetMarkdown,
      })
      const { client: clientOn, requestSpy: requestSpyOn } =
        makeRekeyRunToolClient(baseOn)
      await new MemoryService(clientOn, db).rekeyTopicKey({
        memoryId: "11111111111111111111111111111111",
        newTopicKey: "decision/jwt-new",
      })
      expect(requestSpyOn).toHaveBeenCalledTimes(1) // Pins the fixture is wired.

      // Phase 2: flag explicitly OFF — must skip RunTool and use the
      // canonical path. Issue #543 flipped the default to ON, so
      // flag-off must be set explicitly here rather than relying on
      // env-unset.
      process.env.LORE_USE_RUNTOOL_BLOCK_EDIT = "0"
      process.env.LORE_USE_RUNTOOL = "0"
      const baseOff = makeRekeyClient({
        targetMemory: target,
        targetMarkdown,
      })
      const { client: clientOff, requestSpy: requestSpyOff } =
        makeRekeyRunToolClient(baseOff)
      await new MemoryService(clientOff, db).rekeyTopicKey({
        memoryId: "11111111111111111111111111111111",
        newTopicKey: "decision/jwt-new",
      })
      expect(requestSpyOff).not.toHaveBeenCalled()
      expect(baseOff.updateMarkdownSpy).toHaveBeenCalledTimes(1)
    })
  })
})

// ---------------------------------------------------------------------------
// MemoryService.recordReview — issue #281, AC #3 + AC #4
// ---------------------------------------------------------------------------

describe("MemoryService.recordReview", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildProposedPage(
    id: string,
    overrides: { archived?: boolean; kind?: string } = {},
  ): PageObjectResponse {
    // `kind` defaults to `"note"` — not optional / undefined — because
    // `pageToMemory` resolves `Kind` via `extractSelect(props["Kind"], "note")`
    // (`src/core/memory.ts` `pageToMemory` helper), which substitutes
    // `"note"` for any missing-or-empty Kind property at parse time.
    // Test fixtures must match production parse semantics or the
    // `recordReview` decision-guard test below would diverge from
    // real-vault behavior — a future fixture-author tempted to
    // make `kind?: string | undefined` would break that parity
    // silently. Keep the default explicit here.
    return {
      object: "page",
      id,
      created_time: "2026-04-01T00:00:00Z",
      last_edited_time: "2026-05-01T00:00:00Z",
      archived: overrides.archived ?? false,
      properties: {
        Title: { type: "title", title: [{ plain_text: "Proposed memory" }] },
        Status: { type: "select", select: { name: "proposed" } },
        Kind: {
          type: "select",
          select: { name: overrides.kind ?? "note" },
        },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
      } as unknown as PageObjectResponse["properties"],
      parent: { type: "data_source_id", data_source_id: db.dataSourceId },
      url: `https://notion.so/${id}`,
    } as PageObjectResponse
  }

  function buildAcceptedPage(id: string): PageObjectResponse {
    return {
      object: "page",
      id,
      created_time: "2026-04-01T00:00:00Z",
      last_edited_time: "2026-05-01T00:00:00Z",
      archived: false,
      properties: {
        Title: { type: "title", title: [{ plain_text: "Accepted memory" }] },
        Status: { type: "select", select: { name: "accepted" } },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
      } as unknown as PageObjectResponse["properties"],
      parent: { type: "data_source_id", data_source_id: db.dataSourceId },
      url: `https://notion.so/${id}`,
    } as PageObjectResponse
  }

  it("approve flips Status to accepted and appends a Reviewed audit block", async () => {
    const retrieveSpy = vi.fn().mockResolvedValueOnce(buildProposedPage("mem-1"))
    const retrieveMarkdownSpy = vi
      .fn()
      .mockResolvedValueOnce({ markdown: "# Original body\n" })
    const updateSpy = vi.fn().mockResolvedValueOnce(undefined)
    const updateMarkdownSpy = vi.fn().mockResolvedValueOnce(undefined)
    const client = {
      pages: {
        retrieve: retrieveSpy,
        retrieveMarkdown: retrieveMarkdownSpy,
        update: updateSpy,
        updateMarkdown: updateMarkdownSpy,
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const result = await service.recordReview({
      memoryId: "mem-1",
      verdict: "approve",
      reviewer: "Alice",
    })

    expect(result.previousStatus).toBe("proposed")
    expect(result.memory.status).toBe("accepted")

    // Property write FIRST — load-bearing partial-state posture.
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy.mock.calls[0]![0]).toMatchObject({
      page_id: "mem-1",
      properties: { Status: { select: { name: "accepted" } } },
    })

    // Audit block appended SECOND.
    expect(updateMarkdownSpy).toHaveBeenCalledTimes(1)
    const body = (updateMarkdownSpy.mock.calls[0]![0] as {
      replace_content: { new_str: string }
    }).replace_content.new_str
    expect(body).toContain("# Original body")
    expect(body).toContain("## Reviewed (")
    expect(body).toContain("**Verdict:** approved")
    expect(body).toContain("**Reviewer:** Alice")
    // ISO 8601 timestamp (issue #281, AC #4 — durable reviewer +
    // timestamp evidence). Pinned via regex so the assertion
    // doesn't bind to a specific second.
    expect(body).toMatch(
      /\*\*Reviewed At:\*\* \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/,
    )
  })

  it("reject flips Status to rejected and records the optional reason", async () => {
    const retrieveSpy = vi.fn().mockResolvedValueOnce(buildProposedPage("mem-2"))
    const retrieveMarkdownSpy = vi
      .fn()
      .mockResolvedValueOnce({ markdown: "Body" })
    const updateSpy = vi.fn().mockResolvedValueOnce(undefined)
    const updateMarkdownSpy = vi.fn().mockResolvedValueOnce(undefined)
    const client = {
      pages: {
        retrieve: retrieveSpy,
        retrieveMarkdown: retrieveMarkdownSpy,
        update: updateSpy,
        updateMarkdown: updateMarkdownSpy,
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const result = await service.recordReview({
      memoryId: "mem-2",
      verdict: "reject",
      reviewer: "Bob",
      reason: "Duplicate of an earlier note",
    })

    expect(result.memory.status).toBe("rejected")
    expect(updateSpy.mock.calls[0]![0]).toMatchObject({
      properties: { Status: { select: { name: "rejected" } } },
    })
    const body = (updateMarkdownSpy.mock.calls[0]![0] as {
      replace_content: { new_str: string }
    }).replace_content.new_str
    expect(body).toContain("**Verdict:** rejected")
    expect(body).toContain("**Reviewer:** Bob")
    expect(body).toContain("**Reason:** Duplicate of an earlier note")
    // Same ISO 8601 timestamp invariant on the reject path.
    expect(body).toMatch(
      /\*\*Reviewed At:\*\* \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/,
    )
  })

  it("throws MemoryReviewStateError when Status is not 'proposed'", async () => {
    const retrieveSpy = vi.fn().mockResolvedValueOnce(buildAcceptedPage("mem-3"))
    const retrieveMarkdownSpy = vi
      .fn()
      .mockResolvedValueOnce({ markdown: "Body" })
    const updateSpy = vi.fn()
    const updateMarkdownSpy = vi.fn()
    const client = {
      pages: {
        retrieve: retrieveSpy,
        retrieveMarkdown: retrieveMarkdownSpy,
        update: updateSpy,
        updateMarkdown: updateMarkdownSpy,
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { MemoryReviewStateError } = await import("./memory.js")

    await expect(
      service.recordReview({
        memoryId: "mem-3",
        verdict: "approve",
        reviewer: "Alice",
      }),
    ).rejects.toBeInstanceOf(MemoryReviewStateError)
    // Property + body writes must NOT fire on the rejected branch — the
    // load-bearing fail-fast guard.
    expect(updateSpy).not.toHaveBeenCalled()
    expect(updateMarkdownSpy).not.toHaveBeenCalled()
    // The body fetch must ALSO not fire — `recordReview` reads
    // properties via `getPropertiesById` for the structural guards
    // and defers `retrieveMarkdown` until after the property write.
    // Pinning the absence here proves the round-trip savings on
    // the failure path that the `getPropertiesById` swap was meant
    // to deliver.
    expect(retrieveMarkdownSpy).not.toHaveBeenCalled()
  })

  it("throws on empty / whitespace-only reviewer", async () => {
    const retrieveSpy = vi.fn().mockResolvedValueOnce(buildProposedPage("mem-4"))
    const retrieveMarkdownSpy = vi
      .fn()
      .mockResolvedValueOnce({ markdown: "Body" })
    const updateSpy = vi.fn()
    const updateMarkdownSpy = vi.fn()
    const client = {
      pages: {
        retrieve: retrieveSpy,
        retrieveMarkdown: retrieveMarkdownSpy,
        update: updateSpy,
        updateMarkdown: updateMarkdownSpy,
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await expect(
      service.recordReview({
        memoryId: "mem-4",
        verdict: "approve",
        reviewer: "   ",
      }),
    ).rejects.toThrow(/reviewer must be a non-empty string/)
    expect(updateSpy).not.toHaveBeenCalled()
    expect(updateMarkdownSpy).not.toHaveBeenCalled()
  })

  it("throws MemoryReviewAuditError when audit-block write fails after status flip", async () => {
    const retrieveSpy = vi.fn().mockResolvedValueOnce(buildProposedPage("mem-5"))
    const retrieveMarkdownSpy = vi
      .fn()
      .mockResolvedValueOnce({ markdown: "Body" })
    const updateSpy = vi.fn().mockResolvedValueOnce(undefined)
    const updateMarkdownSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error("notion 5xx"))
    const client = {
      pages: {
        retrieve: retrieveSpy,
        retrieveMarkdown: retrieveMarkdownSpy,
        update: updateSpy,
        updateMarkdown: updateMarkdownSpy,
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { MemoryReviewAuditError } = await import("./memory.js")

    await expect(
      service.recordReview({
        memoryId: "mem-5",
        verdict: "approve",
        reviewer: "Alice",
      }),
    ).rejects.toBeInstanceOf(MemoryReviewAuditError)
    // Property write DID land — the partial-state contract pinned by
    // the docstring. Operators see a clear error and the row is in
    // its load-bearing post-review state.
    expect(updateSpy).toHaveBeenCalledTimes(1)
  })

  it("throws MemoryReviewStateError when Kind is 'decision' (decisions have their own lifecycle)", async () => {
    // Issue #281's `proposedMemoryFilter()` excludes
    // `Kind = decision` so the inbox count and slice surfaces
    // never include proposed-state decisions. The mutation path
    // must enforce the same contract — without this guard, an
    // operator running `lore inbox approve <decision-id>` or
    // `lore-memory action='reject' memoryId='<decision-id>'`
    // would mutate the decision lifecycle through the memory inbox
    // path, bypassing the decision surface that owns governance.
    // Two stub calls (one per service.recordReview invocation) so
    // the same fixture supports both the rejects-instanceof check
    // and the message-contains check below.
    const retrieveSpy = vi
      .fn()
      .mockResolvedValue(buildProposedPage("dec-1", { kind: "decision" }))
    const retrieveMarkdownSpy = vi
      .fn()
      .mockResolvedValue({ markdown: "Body" })
    const updateSpy = vi.fn()
    const updateMarkdownSpy = vi.fn()
    const client = {
      pages: {
        retrieve: retrieveSpy,
        retrieveMarkdown: retrieveMarkdownSpy,
        update: updateSpy,
        updateMarkdown: updateMarkdownSpy,
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { MemoryReviewStateError } = await import("./memory.js")

    let caught: unknown
    try {
      await service.recordReview({
        memoryId: "dec-1",
        verdict: "approve",
        reviewer: "Alice",
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(MemoryReviewStateError)
    // Pre-write guard: status property + body audit must NOT fire.
    expect(updateSpy).not.toHaveBeenCalled()
    expect(updateMarkdownSpy).not.toHaveBeenCalled()
    // The decision-guard read uses `getPropertiesById`, so the body
    // fetch must NOT fire on the rejected branch. Companion to the
    // status-guard assertion above — both inbox-touching guards
    // share the property-only-read posture.
    expect(retrieveMarkdownSpy).not.toHaveBeenCalled()
    // Error message redirects at the decision-lifecycle surface.
    expect((caught as Error).message).toContain('Kind is "decision"')
    expect((caught as Error).message).toContain(
      "lore-decision action='supersede'",
    )
  })

  it("rejects archived memory pages with the live-memory error before the Status guard runs", async () => {
    // Strict-improvement contract pinning: the `getById → getPropertiesById`
    // swap on the structural-guard fetch (issue #281 Phase 4 review r4)
    // routes through `requireLiveMemoryPage`, which `getById` did not.
    // An archived row therefore now rejects with "Memory <id> is
    // archived." instead of falling through `pageToMemory`'s
    // backward-compatible defaults and then hitting the Status guard
    // for whatever residual status the parser inferred. Same posture
    // applies to sibling-DB pages (rejected as "not in the Memories
    // database"). Pin both branches so a future "let's relax
    // requireLiveMemoryPage" refactor can't silently widen the
    // inbox-approve attack surface.
    const archivedPage = {
      ...buildProposedPage("mem-archived"),
      archived: true,
    } as PageObjectResponse
    const retrieveSpy = vi.fn().mockResolvedValueOnce(archivedPage)
    const retrieveMarkdownSpy = vi.fn()
    const updateSpy = vi.fn()
    const updateMarkdownSpy = vi.fn()
    const client = {
      pages: {
        retrieve: retrieveSpy,
        retrieveMarkdown: retrieveMarkdownSpy,
        update: updateSpy,
        updateMarkdown: updateMarkdownSpy,
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await expect(
      service.recordReview({
        memoryId: "mem-archived",
        verdict: "approve",
        reviewer: "Alice",
      }),
    ).rejects.toThrow(/Memory mem-archived is archived/)
    // No Notion writes should land on the archived branch.
    expect(updateSpy).not.toHaveBeenCalled()
    expect(updateMarkdownSpy).not.toHaveBeenCalled()
    expect(retrieveMarkdownSpy).not.toHaveBeenCalled()
  })
})

describe("MemoryService.search", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildSearchPage(
    id: string,
    title: string,
    opts: {
      parentDb?: string
      parentDataSource?: string
      parentType?: "database_id" | "data_source_id"
      tags?: string[]
    } = {}
  ): PageObjectResponse {
    const parentType = opts.parentType ?? "database_id"
    const parent =
      parentType === "data_source_id"
        ? {
            type: "data_source_id" as const,
            data_source_id: opts.parentDataSource ?? db.dataSourceId,
          }
        : {
            type: "database_id" as const,
            database_id: opts.parentDb ?? db.databaseId,
          }
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: {
          type: "multi_select",
          multi_select: (opts.tags ?? []).map((name) => ({ name })),
        },
      },
      { id, parent } as Partial<PageObjectResponse>
    )
  }

  it("semantic mode requests relevance-ranked results — no sort parameter — with a 100-page fetch window", async () => {
    const searchSpy = vi.fn(async (_args: Record<string, unknown>) => ({ results: [] }))
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "" }))
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: retrieveMarkdownSpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await service.search({ query: "autolabel", limit: 5, mode: "semantic" })

    expect(searchSpy).toHaveBeenCalledTimes(1)
    const args = searchSpy.mock.calls[0][0]
    expect(args["query"]).toBe("autolabel")
    expect(args["page_size"]).toBe(100)
    // Critical: without `sort`, Notion ranks by relevance. With `sort`, it
    // ranks by the given timestamp and demotes the query to a filter.
    expect(args).not.toHaveProperty("sort")
  })

  it("semantic mode filters to the Memories database and caps at the caller's limit before fetching markdown", async () => {
    const client = {
      search: vi.fn(async () => ({
        results: [
          // Three pages belong to the memories DB.
          buildSearchPage("mem-1", "Mem one"),
          buildSearchPage("mem-2", "Mem two"),
          buildSearchPage("mem-3", "Mem three"),
          // Two pages from a different DB should be filtered out.
          buildSearchPage("other-1", "Other one", { parentDb: "some-other-db" }),
          buildSearchPage("other-2", "Other two", { parentDb: "some-other-db" }),
        ],
      })),
      pages: {
        retrieveMarkdown: vi.fn(async () => ({ markdown: "body" })),
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({ query: "q", limit: 2, mode: "semantic" })

    expect(results.map((m) => m.id)).toEqual(["mem-1", "mem-2"])
    // Markdown fetched only for the capped subset — not wasted on filtered-out
    // or over-limit results.
    expect(
      (client.pages.retrieveMarkdown as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBe(2)
  })

  it("semantic mode skips the per-page markdown fetch when includeContent: false", async () => {
    // Callers that render only title / date / tags (e.g. the hook wake-up
    // path's related-memories section) pass includeContent: false to avoid
    // N+1 `retrieveMarkdown` round-trips on a hot path.
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "body" }))
    const client = {
      search: vi.fn(async () => ({
        results: [
          buildSearchPage("mem-1", "Mem one"),
          buildSearchPage("mem-2", "Mem two"),
        ],
      })),
      pages: { retrieveMarkdown: retrieveMarkdownSpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      includeContent: false,
      mode: "semantic",
    })

    expect(results).toHaveLength(2)
    expect(results.every((m) => m.content === "")).toBe(true)
    expect(retrieveMarkdownSpy).not.toHaveBeenCalled()
  })

  it("semantic mode accepts pages with a data_source_id parent (Notion SDK v5 shape)", async () => {
    // Regression test: Notion's `client.search()` returns pages with
    // `parent.type === "data_source_id"` in v5 workspaces — which is the
    // shape observed in production. If the filter only accepted
    // `database_id` parents it would silently return zero results for every
    // real query. Match `parent.data_source_id` against `db.dataSourceId`.
    const client = {
      search: vi.fn(async () => ({
        results: [
          buildSearchPage("ds-hit", "data-source match", {
            parentType: "data_source_id",
          }),
          buildSearchPage("db-hit", "database match", {
            parentType: "database_id",
          }),
          buildSearchPage("ds-miss", "unrelated data source", {
            parentType: "data_source_id",
            parentDataSource: "other-ds",
          }),
        ],
      })),
      pages: {
        retrieveMarkdown: vi.fn(async () => ({ markdown: "" })),
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({ query: "q", limit: 10, mode: "semantic" })

    expect(results.map((m) => m.id).sort()).toEqual(["db-hit", "ds-hit"])
  })

  it("semantic mode excludes archived pages before property post-filters run", async () => {
    // `client.search` exposes no archived filter — soft-deleted pages
    // would otherwise leak into recall, wake-up's related-memories
    // pass, and every other `MemoryService.search` caller. Pin the
    // post-filter at the same layer where the parent-shape narrowing
    // happens so an archived row never costs a `Project`/`Topic`/
    // `Tags` extraction it would be discarded for. Same posture as
    // `MemoryService.list`.
    const livePage = buildSearchPage("live-row", "live row", {
      parentType: "data_source_id",
    })
    const archivedPage = buildPage(
      {
        Title: { type: "title", title: [{ plain_text: "archived row" }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
      },
      {
        id: "archived-row",
        archived: true,
        parent: { type: "data_source_id", data_source_id: db.dataSourceId },
      } as Partial<PageObjectResponse>
    )
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "" }))
    const client = {
      search: vi.fn(async () => ({ results: [livePage, archivedPage] })),
      pages: { retrieveMarkdown: retrieveMarkdownSpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({ query: "q", mode: "semantic" })

    expect(results.map((m) => m.id)).toEqual(["live-row"])
    // Materialization runs only on the surviving live row — an archived
    // row never pays a `retrieveMarkdown` round-trip it would be dropped
    // from.
    expect(retrieveMarkdownSpy).toHaveBeenCalledTimes(1)
    expect(retrieveMarkdownSpy).toHaveBeenCalledWith({ page_id: "live-row" })
  })

  it("semantic mode applies kind/status as client-side post-filters (search API has no property filters)", async () => {
    // Regression-safety pin for P3-04: callers passing `kind` / `status`
    // in semantic mode still get post-filtering, since `client.search`
    // ignores property filters. The service narrows the result set to
    // matching kind/status before fetching markdown.
    const decisionPage = buildPage(
      {
        Title: { type: "title", title: [{ plain_text: "decision row" }] },
        Kind: { type: "select", select: { name: "decision" } },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
      },
      { id: "a", parent: { type: "database_id", database_id: db.databaseId } }
    )
    const notePage = buildPage(
      {
        Title: { type: "title", title: [{ plain_text: "note row" }] },
        Kind: { type: "select", select: { name: "note" } },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
      },
      { id: "b", parent: { type: "database_id", database_id: db.databaseId } }
    )
    const searchSpy = vi.fn(async () => ({ results: [decisionPage, notePage] }))
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      kind: "decision",
      mode: "semantic",
      includeContent: false,
    })

    // Only the decision row survives — the note is post-filtered out.
    expect(results.map((m) => m.id)).toEqual(["a"])
    // The post-filter path goes through `client.search`, not `dataSources.query`.
    expect(searchSpy).toHaveBeenCalledTimes(1)
  })

  it("semantic mode paginates client.search until the requested limit is satisfied", async () => {
    // Issue #192: workspace-wide search returns relevance-ranked pages
    // across the entire workspace; Lore filters those down to the
    // Memories DS afterwards. When the first 100 raw hits are dominated
    // by non-Lore pages, matching memories on the second page must
    // still surface — single-page fetch silently starved them pre-fix.
    //
    // Setup: page 1 is all non-memory pages (filtered out client-side);
    // page 2 carries the matching Lore memories. The caller asks for 2.
    const page1 = Array.from({ length: 100 }, (_, i) =>
      buildSearchPage(`other-${i}`, `other ${i}`, { parentDb: "some-other-db" })
    )
    const page2 = [
      buildSearchPage("mem-1", "Mem one"),
      buildSearchPage("mem-2", "Mem two"),
    ]
    const searchSpy = vi.fn(async (args: Record<string, unknown>) => {
      if (args["start_cursor"] === undefined) {
        return { results: page1, has_more: true, next_cursor: "cursor-1" }
      }
      return { results: page2, has_more: false, next_cursor: null }
    })
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({ query: "q", limit: 2, mode: "semantic" })

    expect(results.map((m) => m.id)).toEqual(["mem-1", "mem-2"])
    expect(searchSpy).toHaveBeenCalledTimes(2)
    // First page primes pagination with no cursor; second page threads
    // the `next_cursor` returned by the first.
    expect(searchSpy.mock.calls[0][0]["start_cursor"]).toBeUndefined()
    expect(searchSpy.mock.calls[1][0]["start_cursor"]).toBe("cursor-1")
  })

  it("semantic mode keeps paginating when client-side post-filters reject most of the first raw page", async () => {
    // Acceptance criterion #2: project / kind / status post-filtering
    // can still fill the requested limit when enough matches exist past
    // the first raw page. Setup: page 1 has 100 memory-DB pages but all
    // are kind=note; page 2 has 3 kind=decision rows. Caller asks for
    // 2 decisions.
    const note = (id: string): PageObjectResponse =>
      buildPage(
        {
          Title: { type: "title", title: [{ plain_text: `note ${id}` }] },
          Kind: { type: "select", select: { name: "note" } },
          Project: { type: "relation", relation: [] },
          Topic: { type: "relation", relation: [] },
        },
        { id, parent: { type: "database_id", database_id: db.databaseId } }
      )
    const decision = (id: string): PageObjectResponse =>
      buildPage(
        {
          Title: { type: "title", title: [{ plain_text: `decision ${id}` }] },
          Kind: { type: "select", select: { name: "decision" } },
          Project: { type: "relation", relation: [] },
          Topic: { type: "relation", relation: [] },
        },
        { id, parent: { type: "database_id", database_id: db.databaseId } }
      )

    const page1 = Array.from({ length: 100 }, (_, i) => note(`note-${i}`))
    const page2 = [decision("dec-1"), decision("dec-2"), decision("dec-3")]

    const searchSpy = vi.fn(async (args: Record<string, unknown>) => {
      if (args["start_cursor"] === undefined) {
        return { results: page1, has_more: true, next_cursor: "cursor-1" }
      }
      return { results: page2, has_more: false, next_cursor: null }
    })
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      limit: 2,
      kind: "decision",
      mode: "semantic",
      includeContent: false,
    })

    expect(results.map((m) => m.id)).toEqual(["dec-1", "dec-2"])
    expect(searchSpy).toHaveBeenCalledTimes(2)
  })

  it("semantic mode stops paginating once Notion reports has_more: false even without saturation", async () => {
    // Exhaustion path: a workspace genuinely has fewer matching memories
    // than the requested limit. The loop must exit at `has_more: false`
    // without burning through the full scan cap.
    const page1 = [buildSearchPage("mem-1", "Mem one")]
    const searchSpy = vi.fn(async () => ({
      results: page1,
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({ query: "q", limit: 50, mode: "semantic" })

    expect(results.map((m) => m.id)).toEqual(["mem-1"])
    expect(searchSpy).toHaveBeenCalledTimes(1)
  })

  it("semantic mode bounds the scan at SEMANTIC_SEARCH_MAX_PAGES even when has_more keeps returning true", async () => {
    // Acceptance criterion #3: the search path remains bounded by an
    // explicit maximum number of search pages. Pathological case — a
    // workspace where every page matches the query lexically but no
    // page belongs to the Memories DS (every raw hit is filtered out).
    // Without the cap, the loop would never terminate; with the cap, it
    // exits after exactly `SEMANTIC_SEARCH_MAX_PAGES` calls and returns
    // an empty result set.
    const allOther = Array.from({ length: 100 }, (_, i) =>
      buildSearchPage(`other-${i}`, `other ${i}`, { parentDb: "some-other-db" })
    )
    const searchSpy = vi.fn(async () => ({
      results: allOther,
      has_more: true,
      next_cursor: "more",
    }))
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({ query: "q", limit: 10, mode: "semantic" })

    expect(results).toEqual([])
    expect(searchSpy).toHaveBeenCalledTimes(SEMANTIC_SEARCH_MAX_PAGES)
  })

  it("semantic mode treats next_cursor: null with has_more: true as exhaustion (defensive guard)", async () => {
    // Notion's documented contract is that `next_cursor` is only null
    // when `has_more` is false, but the SDK's response type permits
    // `string | null` regardless. Ensure the loop terminates cleanly on
    // the inconsistent shape rather than spinning on a `start_cursor:
    // undefined` repeat (which Notion treats as "start from the
    // beginning" — an infinite loop).
    const page1 = [buildSearchPage("mem-1", "Mem one")]
    const searchSpy = vi.fn(async () => ({
      results: page1,
      has_more: true,
      next_cursor: null,
    }))
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({ query: "q", limit: 50, mode: "semantic" })

    expect(results.map((m) => m.id)).toEqual(["mem-1"])
    expect(searchSpy).toHaveBeenCalledTimes(1)
  })

  it("semantic mode dedupes across paginated pages so a cross-page-promoted row surfaces only once", async () => {
    // Notion's `client.search` does NOT live-rerank between cursor
    // steps (each call is a fresh workspace-wide query, not a slice of
    // a frozen result set), so concurrent edits between the page-1 and
    // page-2 fetches CAN promote the same memory across both pages.
    // Pre-pagination this couldn't happen — single page meant single
    // observation. Without dedup, hybrid's RRF accumulator
    // double-credits the duplicated row (intra-branch double-credit
    // inflates fused score) AND the semantic-only caller sees the same
    // memory rendered twice (visible correctness bug). One Set guards
    // both consumers.
    const sharedMem = buildSearchPage("mem-shared", "shared")
    const page1 = [
      sharedMem,
      ...Array.from({ length: 99 }, (_, i) =>
        buildSearchPage(`other-${i}`, `other ${i}`, { parentDb: "some-other-db" })
      ),
    ]
    const page2 = [sharedMem, buildSearchPage("mem-2", "Mem two")]
    const searchSpy = vi.fn(async (args: Record<string, unknown>) => {
      if (args["start_cursor"] === undefined) {
        return { results: page1, has_more: true, next_cursor: "cursor-1" }
      }
      return { results: page2, has_more: false, next_cursor: null }
    })
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({ query: "q", limit: 5, mode: "semantic" })

    // `mem-shared` appears exactly once even though raw pages observed
    // it twice. `mem-2` follows.
    expect(results.map((m) => m.id)).toEqual(["mem-shared", "mem-2"])
  })

  it("semantic mode does not fire a second client.search when the first page already saturates the limit", async () => {
    // Saturation path: the first raw page already carries enough
    // post-filtered Lore memories. Pagination must short-circuit before
    // burning a second round-trip — otherwise rate-limit cost compounds
    // on every common-case query.
    const page1 = [
      buildSearchPage("mem-1", "Mem one"),
      buildSearchPage("mem-2", "Mem two"),
      buildSearchPage("mem-3", "Mem three"),
    ]
    const searchSpy = vi.fn(async () => ({
      results: page1,
      has_more: true,
      next_cursor: "cursor-1",
    }))
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({ query: "q", limit: 2, mode: "semantic" })

    expect(results.map((m) => m.id)).toEqual(["mem-1", "mem-2"])
    expect(searchSpy).toHaveBeenCalledTimes(1)
  })

  it("semantic mode excludes archived memory pages so they do not occupy result slots", async () => {
    // `client.search` ignores Notion's `archived` flag. Under
    // pagination, an archived memory pushed into the accumulator
    // counts toward `limit` and can stop the loop before later live
    // matches are fetched, so the caller would get fewer usable
    // results than requested. Mirror the every-other-walker contract.
    const archivedMem = buildPage(
      {
        Title: { type: "title", title: [{ plain_text: "archived" }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
      },
      {
        id: "mem-archived",
        archived: true,
        parent: { type: "database_id", database_id: db.databaseId },
      } as Partial<PageObjectResponse>
    )
    const live1 = buildSearchPage("mem-live-1", "live one")
    const live2 = buildSearchPage("mem-live-2", "live two")
    const searchSpy = vi.fn(async (args: Record<string, unknown>) => {
      if (args["start_cursor"] === undefined) {
        // First page: archived row would saturate `limit: 2` if it
        // counted, masking the live row on page 2.
        return { results: [archivedMem, live1], has_more: true, next_cursor: "cursor-1" }
      }
      return { results: [live2], has_more: false, next_cursor: null }
    })
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({ query: "q", limit: 2, mode: "semantic" })

    // Archived row excluded; live rows fill the limit across both pages.
    expect(results.map((m) => m.id)).toEqual(["mem-live-1", "mem-live-2"])
    expect(searchSpy).toHaveBeenCalledTimes(2)
  })

  it("semantic mode returns the full pagination accumulator (no early limit trim) so hybrid RRF sees rows past `limit`", async () => {
    // The under-shoot RRF case in `searchByHybridPages` benefits from a
    // wider semantic pool: a row at semantic-rank 11 that ALSO appears
    // in contains can plausibly beat a contains-only row via fused
    // score — but ONLY if it survives long enough to reach the
    // accumulator. A premature `slice(0, limit)` inside
    // `fetchSemanticPages` silently nullifies that cross-branch signal.
    //
    // Regression pin: after the saturation gate breaks the loop,
    // `fetchSemanticPages` must return EVERY accumulated post-filter
    // survivor (up to `limit + page_size − 1`), not just the first
    // `limit`. `runSearch`'s `pages.slice(0, limit)` is the
    // authoritative final cap for the semantic-only path; hybrid
    // consumes the wider pool.
    const page1 = Array.from({ length: 50 }, (_, i) =>
      buildSearchPage(`mem-${i}`, `Mem ${i}`)
    )
    const searchSpy = vi.fn(async () => ({
      results: page1,
      has_more: false,
      next_cursor: null,
    }))
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "" }))
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: retrieveMarkdownSpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    // Spy on the public path. Cap at limit=10 — the semantic-only
    // caller still sees 10 (runSearch trims), but we need a probe of
    // the helper output to assert the wider pool. Use `searchWithExplain`
    // and the indirect side effect — markdown is fetched only for the
    // capped subset, so we can't probe pool width through there.
    //
    // Direct probe: call the private `fetchSemanticPages` via
    // unknown-cast indirection. Established pattern in this file.
    type FetchSemanticPagesFn = (
      input: { query: string; limit?: number },
      intent: string | null
    ) => Promise<PageObjectResponse[]>
    const fetcher = (
      service as unknown as { fetchSemanticPages: FetchSemanticPagesFn }
    ).fetchSemanticPages.bind(service)

    const pages = await fetcher({ query: "q", limit: 10 }, null)

    // All 50 post-filter survivors flow through, not just the first 10.
    expect(pages).toHaveLength(50)
    expect(pages.slice(0, 3).map((p) => p.id)).toEqual(["mem-0", "mem-1", "mem-2"])
    // The `limit + page_size − 1` upper bound holds: one full page of
    // 100 in flight plus the saturation gate gives at most ~109 rows.
    expect(pages.length).toBeLessThanOrEqual(109)
  })

  it("semantic mode logs a stderr signal under LORE_DEBUG=1 when the scan cap fires without saturating", async () => {
    // Operator-triage signal: when the cap fires with
    // `accumulated.length < limit`, a caller cannot distinguish "no
    // matches in workspace" from "pathological query, cap fired,
    // matches may exist past 500 rows." The `[lore]
    // semantic-search-cap-fired:` line under LORE_DEBUG=1 closes the
    // gap. Format mirrors `debugLogHybridBranchFailure`.
    const allOther = Array.from({ length: 100 }, (_, i) =>
      buildSearchPage(`other-${i}`, `other ${i}`, { parentDb: "some-other-db" })
    )
    const searchSpy = vi.fn(async () => ({
      results: allOther,
      has_more: true,
      next_cursor: "more",
    }))
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const original = process.env["LORE_DEBUG"]
    process.env["LORE_DEBUG"] = "1"
    try {
      await service.search({ query: "q", limit: 10, mode: "semantic" })

      const lines = stderrSpy.mock.calls.map((c) => String(c[0]))
      const capLines = lines.filter((l) => l.includes("semantic-search-cap-fired"))
      expect(capLines).toHaveLength(1)
      expect(capLines[0]).toContain(`pages=${SEMANTIC_SEARCH_MAX_PAGES}`)
      expect(capLines[0]).toContain("accumulated=0")
      expect(capLines[0]).toContain("limit=10")
      expect(capLines[0]).toContain("source=fetch-semantic-pages")
      expect(capLines[0].endsWith("\n")).toBe(true)
    } finally {
      stderrSpy.mockRestore()
      if (original === undefined) {
        delete process.env["LORE_DEBUG"]
      } else {
        process.env["LORE_DEBUG"] = original
      }
    }
  })

  it("semantic mode does NOT log the cap-fired signal under LORE_DEBUG=1 when the loop saturates", async () => {
    // Saturation is the success path; logging here would be noise on
    // every common-case query an operator runs with LORE_DEBUG=1 set.
    const page1 = [
      buildSearchPage("mem-1", "Mem one"),
      buildSearchPage("mem-2", "Mem two"),
    ]
    const searchSpy = vi.fn(async () => ({
      results: page1,
      has_more: true,
      next_cursor: "cursor-1",
    }))
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const original = process.env["LORE_DEBUG"]
    process.env["LORE_DEBUG"] = "1"
    try {
      await service.search({ query: "q", limit: 2, mode: "semantic" })

      const lines = stderrSpy.mock.calls.map((c) => String(c[0]))
      expect(lines.some((l) => l.includes("semantic-search-cap-fired"))).toBe(false)
    } finally {
      stderrSpy.mockRestore()
      if (original === undefined) {
        delete process.env["LORE_DEBUG"]
      } else {
        process.env["LORE_DEBUG"] = original
      }
    }
  })

  it("semantic mode does NOT log the cap-fired signal when LORE_DEBUG is unset", async () => {
    // Without `LORE_DEBUG=1`, even a cap-fire stays silent — operators
    // who don't opt in shouldn't see search internals on stderr.
    const allOther = Array.from({ length: 100 }, (_, i) =>
      buildSearchPage(`other-${i}`, `other ${i}`, { parentDb: "some-other-db" })
    )
    const searchSpy = vi.fn(async () => ({
      results: allOther,
      has_more: true,
      next_cursor: "more",
    }))
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const original = process.env["LORE_DEBUG"]
    delete process.env["LORE_DEBUG"]
    try {
      await service.search({ query: "q", limit: 10, mode: "semantic" })

      const lines = stderrSpy.mock.calls.map((c) => String(c[0]))
      expect(lines.some((l) => l.includes("semantic-search-cap-fired"))).toBe(false)
    } finally {
      stderrSpy.mockRestore()
      if (original !== undefined) process.env["LORE_DEBUG"] = original
    }
  })
})

describe("MemoryService.search — contains mode", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function makeQueryClient(rows: PageObjectResponse[]) {
    const querySpy = vi.fn(async (_args: Record<string, unknown>) => ({
      results: rows,
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({ results: [] }))
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "body" }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: retrieveMarkdownSpy },
    } as unknown as Client
    return { client, querySpy, searchSpy, retrieveMarkdownSpy }
  }

  function buildContainsPage(
    id: string,
    title: string,
    opts: { archived?: boolean } = {}
  ): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
      },
      {
        id,
        archived: opts.archived ?? false,
        parent: {
          type: "data_source_id",
          data_source_id: db.dataSourceId,
        },
      } as Partial<PageObjectResponse>
    )
  }

  it("issues dataSources.query against the Memories DS — never client.search", async () => {
    const { client, querySpy, searchSpy } = makeQueryClient([
      buildContainsPage("c-1", "PR #25650 autolabel notes"),
    ])
    const service = new MemoryService(client, db)

    await service.search({ query: "autolabel", mode: "contains", includeContent: false })

    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).not.toHaveBeenCalled()
    const args = querySpy.mock.calls[0][0]
    expect(args["data_source_id"]).toBe(db.dataSourceId)
  })

  it("surfaces the live-page refill cap through searchWithExplain", async () => {
    const querySpy = vi.fn(async () => ({
      results: [buildContainsPage("archived", "archived hit", { archived: true })],
      has_more: true,
      next_cursor: "more-archived",
    }))
    const client = {
      dataSources: { query: querySpy },
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "body" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    try {
      const result = await service.searchWithExplain({
        query: "archived",
        mode: "contains",
        limit: 3,
        includeContent: false,
      })

      expect(result.memories).toEqual([])
      expect(result.capped).toBe(true)
      expect(querySpy).toHaveBeenCalledTimes(5)
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it("filters by Title OR Keywords OR Synopsis contains for non-empty queries", async () => {
    const { client, querySpy } = makeQueryClient([])
    const service = new MemoryService(client, db)

    // Pass `includeProposed: true` so the default `Status !=
    // proposed` clause (issue #281, AC #2) is suppressed for this
    // assertion — the test's focus is the title/keywords/synopsis
    // contains-OR, not the proposed-exclusion default. The default
    // behavior is pinned by its own dedicated tests.
    await service.search({ query: "PR-25650", mode: "contains", includeProposed: true })

    const filter = querySpy.mock.calls[0][0]["filter"] as
      | { or?: Array<Record<string, unknown>>; and?: Array<Record<string, unknown>> }
      | undefined
    // The OR of Title, Keywords, and Synopsis contains is the
    // text-precision lane. Synopsis joined the lane as of issue
    // 0.7.0/04 so an agent-curated short summary that doesn't appear
    // verbatim in a title or keyword string still surfaces. The
    // surrounding wrapper is `and` because the cleanup-orphan
    // exclusion (issue #477) is always appended — a restored-from-trash
    // orphan must not surface in the contains lane and saturate the
    // hybrid threshold against real semantic hits.
    expect(filter?.and).toBeDefined()
    expect(filter?.and).toContainEqual({
      or: [
        { property: "Title", title: { contains: "PR-25650" } },
        { property: "Keywords", rich_text: { contains: "PR-25650" } },
        { property: "Synopsis", rich_text: { contains: "PR-25650" } },
      ],
    })
    expect(filter?.and).toContainEqual({
      property: "Keywords",
      rich_text: { does_not_contain: "__lore-cleanup-orphan" },
    })
  })

  it("composes server-side property filters: kind + status + tags", async () => {
    // Acceptance criterion: kind/status/tags currently post-filter in
    // semantic mode become server-side filters in contains mode.
    const { client, querySpy } = makeQueryClient([])
    const service = new MemoryService(client, db)

    await service.search({
      query: "anything",
      mode: "contains",
      kind: "decision",
      status: "accepted",
      tags: ["architecture", "backend"],
    })

    const filter = querySpy.mock.calls[0][0]["filter"] as {
      and: Array<Record<string, unknown>>
    }
    expect(filter.and).toBeDefined()
    // Kind, Status, Tags-OR, and the title/keywords OR all land in the
    // `and` block — DS-scoped, server-side.
    expect(filter.and).toEqual(
      expect.arrayContaining([
        { property: "Kind", select: { equals: "decision" } },
        { property: "Status", select: { equals: "accepted" } },
        {
          or: [
            { property: "Tags", multi_select: { contains: "architecture" } },
            { property: "Tags", multi_select: { contains: "backend" } },
          ],
        },
      ])
    )
  })

  it("composes the project-or-unscoped filter when projectId is set", async () => {
    const { client, querySpy } = makeQueryClient([])
    const service = new MemoryService(client, db)

    await service.search({
      query: "x",
      projectId: "proj-1",
      mode: "contains",
    })

    const filter = querySpy.mock.calls[0][0]["filter"] as {
      and: Array<Record<string, unknown>>
    }
    expect(filter.and).toEqual(
      expect.arrayContaining([
        {
          or: [
            { property: "Project", relation: { contains: "proj-1" } },
            { property: "Project", relation: { is_empty: true } },
          ],
        },
      ])
    )
  })

  it("drops the text clause for an empty query — falls back to property-filter recency listing", async () => {
    const { client, querySpy } = makeQueryClient([])
    const service = new MemoryService(client, db)

    // An empty query in semantic mode degenerates because `contains: ""`
    // matches every row. Skip the text clause entirely so the surrounding
    // property filters drive the result set. `includeProposed: true`
    // suppresses the default proposed-exclusion clause (issue #281)
    // so the assertion can pin the bare project filter shape.
    await service.search({
      query: "   ",
      projectId: "proj-1",
      mode: "contains",
      includeProposed: true,
    })

    const filter = querySpy.mock.calls[0][0]["filter"] as
      | { and?: Array<Record<string, unknown>>; or?: Array<Record<string, unknown>> }
      | undefined
    // Project filter present — text clause omitted. The surrounding
    // wrapper is `and` because the cleanup-orphan exclusion (issue
    // #477) is always appended; the project OR-clause is one of the
    // top-level `and` members alongside it.
    expect(filter?.and).toBeDefined()
    expect(filter?.and).toContainEqual({
      or: [
        { property: "Project", relation: { contains: "proj-1" } },
        { property: "Project", relation: { is_empty: true } },
      ],
    })
    expect(filter?.and).toContainEqual({
      property: "Keywords",
      rich_text: { does_not_contain: "__lore-cleanup-orphan" },
    })
  })

  it("sorts by last_edited_time desc and requests a full page for refill efficiency", async () => {
    const { client, querySpy } = makeQueryClient([])
    const service = new MemoryService(client, db)

    await service.search({ query: "q", mode: "contains", limit: 7 })

    const args = querySpy.mock.calls[0][0]
    expect(args["sorts"]).toEqual([
      { timestamp: "last_edited_time", direction: "descending" },
    ])
    expect(args["page_size"]).toBe(100)
  })

  it("honors includeContent: false on the materialization step", async () => {
    const { client, retrieveMarkdownSpy } = makeQueryClient([
      buildContainsPage("c-1", "row"),
    ])
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "contains",
      includeContent: false,
    })

    expect(results).toHaveLength(1)
    expect(results[0].content).toBe("")
    expect(retrieveMarkdownSpy).not.toHaveBeenCalled()
  })

  it("excludes archived rows from the contains-mode result set", async () => {
    // `dataSources.query` cannot filter on the page-metadata `archived`
    // flag, so the JS post-filter handles it — same posture as
    // `MemoryService.list`. Without this, soft-deleted memories leak
    // into recall, wake-up's related-memories pass, and every other
    // `MemoryService.search` caller via the contains and hybrid paths.
    const { client } = makeQueryClient([
      buildContainsPage("c-live", "live row"),
      buildContainsPage("c-archived", "archived row", { archived: true }),
    ])
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "row",
      mode: "contains",
      includeContent: false,
    })

    expect(results.map((m) => m.id)).toEqual(["c-live"])
  })

  it("refills contains-mode results past archived rows across pages", async () => {
    const querySpy = vi
      .fn()
      .mockResolvedValueOnce({
        results: [
          buildContainsPage("c-archived-before", "archived before", { archived: true }),
          buildContainsPage("c-live-1", "live one"),
          buildContainsPage("c-archived-between", "archived between", {
            archived: true,
          }),
        ],
        has_more: true,
        next_cursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        results: [
          buildContainsPage("c-live-2", "live two"),
          buildContainsPage("c-archived-after", "archived after", { archived: true }),
        ],
        has_more: true,
        next_cursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        results: [buildContainsPage("c-live-3", "live three")],
        has_more: false,
        next_cursor: null,
      })
    const client = {
      dataSources: { query: querySpy },
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "body" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "row",
      mode: "contains",
      limit: 3,
      includeContent: false,
    })

    expect(results.map((m) => m.id)).toEqual(["c-live-1", "c-live-2", "c-live-3"])
    expect(querySpy).toHaveBeenCalledTimes(3)
    expect(querySpy.mock.calls[1][0].start_cursor).toBe("cursor-1")
    expect(querySpy.mock.calls[2][0].start_cursor).toBe("cursor-2")
    expect(querySpy.mock.calls[0][0].page_size).toBe(100)
    expect(querySpy.mock.calls[1][0].page_size).toBe(100)
    expect(querySpy.mock.calls[2][0].page_size).toBe(100)
  })

  it("text-clause OR composes with surrounding kind/tags filters under `and`", async () => {
    // Pins the structural shape: when surrounding server-side filters
    // (kind / tags) are present, the text-clause OR sits inside the `and`
    // alongside them, untouched. End-to-end superset / parity / eviction
    // invariants — the spec's fixture-vault acceptance — are pinned in
    // `memory-search.integration.test.ts` against a stateful filter
    // evaluator that mirrors Notion's `contains` predicate.
    const { client, querySpy } = makeQueryClient([])
    const service = new MemoryService(client, db)

    await service.search({
      query: "DecisionService",
      mode: "contains",
      kind: "decision",
      tags: ["architecture"],
    })

    const filter = querySpy.mock.calls[0][0]["filter"] as {
      and: Array<Record<string, unknown>>
    }
    expect(filter.and).toEqual(
      expect.arrayContaining([
        {
          or: [
            { property: "Title", title: { contains: "DecisionService" } },
            { property: "Keywords", rich_text: { contains: "DecisionService" } },
            { property: "Synopsis", rich_text: { contains: "DecisionService" } },
          ],
        },
      ])
    )
  })

  it("excludes archived rows that dataSources.query returns by default", async () => {
    // Notion's `archived` flag lives on PageObjectResponse, NOT as a DB
    // column, so `dataSources.query` returns archived rows alongside
    // live ones. Without client-side exclusion, an archived row at the
    // top of recency could occupy a result slot a live row would
    // otherwise fill. Mirror the every-other-walker contract
    // (`findByTopicKey`, `listAllForBackfill`, `listForScan`).
    const live = buildContainsPage("c-live", "live row")
    const archived = buildPage(
      {
        Title: { type: "title", title: [{ plain_text: "archived row" }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
      },
      {
        id: "c-archived",
        archived: true,
        parent: { type: "data_source_id", data_source_id: db.dataSourceId },
      } as Partial<PageObjectResponse>
    )
    const { client } = makeQueryClient([archived, live])
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "row",
      mode: "contains",
      includeContent: false,
    })

    expect(results.map((m) => m.id)).toEqual(["c-live"])
  })
})

describe("MemoryService.search — hybrid mode", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildHybridPage(
    id: string,
    title: string,
    opts: { archived?: boolean } = {}
  ): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
      },
      {
        id,
        archived: opts.archived ?? false,
        parent: {
          type: "data_source_id",
          data_source_id: db.dataSourceId,
        },
      } as Partial<PageObjectResponse>
    )
  }

  it("hybrid mode excludes archived rows from BOTH branches transitively", async () => {
    // Hybrid composes the raw `fetchContainsPages` and `fetchSemanticPages`
    // (per the "Fetch/sort pipeline split" doc in core/CLAUDE.md). If
    // the archived filter only landed on one branch, RRF merging would
    // surface archived rows from the other. Pin both branches at once.
    const querySpy = vi.fn(async () => ({
      results: [
        buildHybridPage("c-live", "live contains"),
        buildHybridPage("c-archived", "archived contains", { archived: true }),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [
        buildHybridPage("s-live", "live semantic"),
        buildHybridPage("s-archived", "archived semantic", { archived: true }),
      ],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    const ids = new Set(results.map((m) => m.id))
    expect(ids.has("c-live")).toBe(true)
    expect(ids.has("s-live")).toBe(true)
    expect(ids.has("c-archived")).toBe(false)
    expect(ids.has("s-archived")).toBe(false)
  })

  it("is the default mode and returns contains-only results when contains saturates", async () => {
    // Three contains hits is the threshold; the parallel semantic call
    // still fires (speculative parallelism keeps wall-clock at one
    // round-trip) but its result is discarded.
    const querySpy = vi.fn(async () => ({
      results: [
        buildHybridPage("a", "Title a"),
        buildHybridPage("b", "Title b"),
        buildHybridPage("c", "Title c"),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      // Semantic returns rows that would be merged on under-shoot — but
      // contains saturated, so this whole result is dropped.
      results: [buildHybridPage("z-discarded", "would-be-semantic")],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    // No `mode` argument — exercises the "default to hybrid" branch.
    const results = await service.search({ query: "q", includeContent: false })

    expect(results.map((m) => m.id)).toEqual(["a", "b", "c"])
    // Both queries fire in parallel — the saturation decision happens
    // after Promise.all settles, not before the second call dispatches.
    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).toHaveBeenCalledTimes(1)
  })

  it("hybrid fires both queries in parallel — wall-clock is max(contains, semantic), not sum", async () => {
    // Pin the speculative-parallelism contract: Promise.all dispatches
    // both the dataSources.query and the client.search before either
    // resolves. Without this, an under-shooting hybrid would pay
    // contains-then-semantic sequentially, regressing wall-clock vs the
    // pre-PR single-call path.
    let dispatchedSearchAt = 0
    let containsResolvedAt = 0
    let now = 0
    const querySpy = vi.fn(async () => {
      // The query takes 50 simulated ms to resolve.
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          containsResolvedAt = ++now
          resolve()
        }, 0)
      )
      return {
        results: [buildHybridPage("c-1", "one")],
        has_more: false,
        next_cursor: null,
      }
    })
    const searchSpy = vi.fn(async () => {
      dispatchedSearchAt = ++now
      return { results: [] }
    })
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await service.search({ query: "q", mode: "hybrid", includeContent: false })

    // Search dispatched BEFORE contains resolved → parallel, not sequential.
    expect(dispatchedSearchAt).toBeGreaterThan(0)
    expect(dispatchedSearchAt).toBeLessThan(containsResolvedAt)
  })

  it("falls back to semantic when contains returns < 3 hits and merges unique rows", async () => {
    const querySpy = vi.fn(async () => ({
      results: [buildHybridPage("contains-only", "Substring hit")],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [
        // Same row that contains already returned — should be deduped.
        buildHybridPage("contains-only", "Substring hit"),
        // New rows that contains missed (semantic ranking found body matches).
        buildHybridPage("semantic-only-1", "Something else"),
        buildHybridPage("semantic-only-2", "And another"),
      ],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      limit: 5,
      includeContent: false,
    })

    // Contains row first, then unique semantic rows, no duplicate id.
    expect(results.map((m) => m.id)).toEqual([
      "contains-only",
      "semantic-only-1",
      "semantic-only-2",
    ])
    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).toHaveBeenCalledTimes(1)
  })

  it("hybrid caps the merged result list at the caller's limit", async () => {
    const querySpy = vi.fn(async () => ({
      results: [buildHybridPage("c-1", "one")],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [
        buildHybridPage("s-1", "two"),
        buildHybridPage("s-2", "three"),
        buildHybridPage("s-3", "four"),
        buildHybridPage("s-4", "five"),
      ],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      limit: 2,
      includeContent: false,
    })

    // Limit caps the merged list at 2 even though more semantic rows exist.
    expect(results.map((m) => m.id)).toEqual(["c-1", "s-1"])
  })

  it("hybrid materializes markdown only for the final capped set, never for discarded candidates", async () => {
    // Round-trip protection: under-shooting hybrid with includeContent: true
    // must not fetch markdown for every contains + semantic candidate
    // before the dedupe+cap. Concretely: limit=3, contains returns 1,
    // semantic returns 4 (1 dedup'd) → final merged size is 3 → exactly
    // 3 retrieveMarkdown calls, not 5.
    const querySpy = vi.fn(async () => ({
      results: [buildHybridPage("c-1", "contains row")],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [
        // Dup'd against contains — would pre-fetch markdown if materialization
        // happened in the per-mode helpers.
        buildHybridPage("c-1", "contains row"),
        buildHybridPage("s-1", "semantic 1"),
        buildHybridPage("s-2", "semantic 2"),
        buildHybridPage("s-3", "semantic 3 — over the cap"),
      ],
    }))
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "body" }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: retrieveMarkdownSpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      limit: 3,
      includeContent: true, // forces the materialization path
    })

    expect(results.map((m) => m.id)).toEqual(["c-1", "s-1", "s-2"])
    // 3 markdown fetches — not 5 (1 contains + 4 semantic candidates).
    expect(retrieveMarkdownSpy).toHaveBeenCalledTimes(3)
  })

  it("hybrid fires exactly two data round-trips (one dataSources.query + one client.search)", async () => {
    // Pin the round-trip count contract for hybrid: parallelism keeps
    // wall-clock at one round-trip, but the work is two API calls.
    // Adding a third (e.g. a sequential semantic call after contains)
    // would regress.
    const querySpy = vi.fn(async () => ({
      results: [buildHybridPage("c-1", "one"), buildHybridPage("c-2", "two")],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({ results: [] }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await service.search({ query: "q", mode: "hybrid", includeContent: false })

    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).toHaveBeenCalledTimes(1)
  })
})

describe("MemoryService.search — RRF fusion under saturation threshold", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildHybridPage(id: string, title: string): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
      },
      {
        id,
        parent: {
          type: "data_source_id",
          data_source_id: db.dataSourceId,
        },
      } as Partial<PageObjectResponse>
    )
  }

  it("a row ranked #1 in both branches sorts above a row ranked #1 in only one branch", async () => {
    // Cross-branch agreement is the signal RRF surfaces. Pre-RRF concat
    // would have placed `contains-only-top` first because contains rows
    // always came first; under RRF, `cross-branch-#1` wins because it
    // scores 2/(60+1) ≈ 0.0328 vs the other rows' 1/61 ≈ 0.0164.
    const querySpy = vi.fn(async () => ({
      results: [
        buildHybridPage("contains-only-top", "first in contains only"),
        buildHybridPage("cross-branch-1", "in both branches"),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [
        buildHybridPage("cross-branch-1", "in both branches"),
        buildHybridPage("semantic-only-top", "first in semantic only"),
      ],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    expect(results.map((m) => m.id)).toEqual([
      "cross-branch-1",
      "contains-only-top",
      "semantic-only-top",
    ])
  })

  it("RRF score for a known input pair matches 1/(60+rank+1)", async () => {
    // Pin the RRF formula. A row ranked #0 in contains and absent from
    // semantic scores exactly 1/61. Surfaces via the explain trace.
    const querySpy = vi.fn(async () => ({
      results: [buildHybridPage("solo-contains", "alone in contains")],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({ results: [] }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { explain } = await service.searchWithExplain({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    expect(explain).toHaveLength(1)
    expect(explain[0].rrfScore).toBeCloseTo(1 / 61, 10)
  })

  it("saturation cutoff still short-circuits at the threshold — RRF does not run", async () => {
    // Three contains hits is the threshold. Pre-RRF behavior is preserved
    // verbatim above the new merge code: the contains rows are returned
    // in their original order, the semantic branch's output is discarded.
    const querySpy = vi.fn(async () => ({
      results: [
        buildHybridPage("c-0", "first"),
        buildHybridPage("c-1", "second"),
        buildHybridPage("c-2", "third"),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      // If RRF ran on this saturating case, semantic-only would float in
      // and the test would fail. The cutoff prevents that.
      results: [buildHybridPage("semantic-only", "would float in under RRF")],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    expect(results.map((m) => m.id)).toEqual(["c-0", "c-1", "c-2"])
  })
})

describe("MemoryService.search — confidence-weighted RRF (issue 0.8.0/08)", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildScoredPage(
    id: string,
    title: string,
    confidenceScore: number | null
  ): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
        "Confidence Score": { type: "number", number: confidenceScore },
      },
      {
        id,
        parent: {
          type: "data_source_id",
          data_source_id: db.dataSourceId,
        },
      } as Partial<PageObjectResponse>
    )
  }

  it("hybrid mode: rows with identical ranks but different Confidence Scores sort by confidence", async () => {
    // Both rows: contains-only at rank 0 and rank 1. Without confidence
    // weighting, contains rank 0 wins. With confidence weighting, the
    // 0.9-scored row at rank 1 (score 1/62 * (0.5+0.5*0.9) = 1/62 * 0.95)
    // sorts above the 0.1-scored row at rank 0 (score 1/61 * 0.55) ONLY
    // when the confidence delta is large enough. With these constants:
    //   row-low:  (1/61) * 0.55 ≈ 0.00902
    //   row-high: (1/62) * 0.95 ≈ 0.01532
    // So the higher-confidence rank-1 row beats the lower-confidence
    // rank-0 row. Pin this end-to-end through hybrid's RRF accumulator.
    const querySpy = vi.fn(async () => ({
      results: [
        buildScoredPage("row-low", "rank 0 in contains, decayed", 0.1),
        buildScoredPage("row-high", "rank 1 in contains, fresh", 0.9),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({ results: [] }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    // High-confidence row at rank 1 beats low-confidence row at rank 0
    // because the confidence-factor delta (0.95 vs 0.55) outweighs the
    // single-rank gap.
    expect(results.map((m) => m.id)).toEqual(["row-high", "row-low"])
  })

  it("contains mode: a fresh-rank-3 row sorts above a decayed-rank-1 row", async () => {
    // The acceptance-criteria worked example:
    //   rank 3 with confidence=0.95: (1/64) * (0.5+0.5*0.95) = (1/64) * 0.975 ≈ 0.01523
    //   rank 1 with confidence=0.0:  (1/62) * 0.5 ≈ 0.00806
    // Fresh-rank-3 wins.
    const querySpy = vi.fn(async () => ({
      results: [
        buildScoredPage("decay-rank-0", "alphabetically first, decayed", 0.0),
        buildScoredPage("decay-rank-1", "rank 1, decayed", 0.0),
        buildScoredPage("decay-rank-2", "rank 2, decayed", 0.0),
        buildScoredPage("fresh-rank-3", "rank 3, fresh", 0.95),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy },
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "contains",
      includeContent: false,
    })

    expect(results[0].id).toBe("fresh-rank-3")
  })

  it("unscored rows (Confidence Score = null) yield byte-identical pre-0.8.0 ordering", async () => {
    // Pre-migration vault: every row has `Confidence Score = null`.
    // `confidenceFactor(null) = 1.0` and the all-unscored short-circuit in
    // `rerankByConfidence` returns Notion's input order verbatim. Pinning
    // this preserves the soft-dep contract from the spec: 0.8.0 ships
    // visibly inert until #11's backfill / Phase 2 read-touches populate
    // scores.
    const querySpy = vi.fn(async () => ({
      results: [
        buildScoredPage("first", "first by recency", null),
        buildScoredPage("second", "second by recency", null),
        buildScoredPage("third", "third by recency", null),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy },
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "contains",
      includeContent: false,
    })

    expect(results.map((m) => m.id)).toEqual(["first", "second", "third"])
  })

  it("hybrid mode: scored row at Confidence Score=0.0 has effective weight 0.5*baseWeight, NOT 0.25 (no double application)", async () => {
    // The spec's flagship double-application regression test. In hybrid
    // mode, a row at Confidence Score=0.0 with contains-rank=0 and absent
    // from semantic should score `(1/61) * 1 * 0.5`, not
    // `(1/61) * 1 * 0.5 * 0.5`. If hybrid composed the public single-
    // branch wrappers (which apply the factor in their sort), the factor
    // would be applied here AND in the RRF accumulator — collapsing the
    // documented [0.5, 1.0] floor to [0.25, 1.0]. The fetch/sort split
    // pins this.
    const querySpy = vi.fn(async () => ({
      results: [buildScoredPage("decayed", "decayed row", 0.0)],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({ results: [] }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { explain } = await service.searchWithExplain({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    expect(explain).toHaveLength(1)
    // Single-application: (1/61) * 0.5
    expect(explain[0].rrfScore).toBeCloseTo((1 / 61) * 0.5, 10)
    // Sanity: NOT the double-applied value
    expect(explain[0].rrfScore).not.toBeCloseTo((1 / 61) * 0.5 * 0.5, 10)
    expect(explain[0].confidenceFactor).toBeCloseTo(0.5, 10)
  })

  it("LORE_DISABLE_CONFIDENCE_FACTOR=1 reverts ordering to pre-0.8.0", async () => {
    // Operator escape hatch. With the kill switch set, every row's
    // factor is forced to 1.0 and ordering matches pre-0.8.0 — even on
    // a vault with populated scores. Verified end-to-end on the same
    // contains-mode fixture as the "fresh-rank-3 wins" test above.
    const querySpy = vi.fn(async () => ({
      results: [
        buildScoredPage("decay-rank-0", "alphabetically first, decayed", 0.0),
        buildScoredPage("decay-rank-1", "rank 1, decayed", 0.0),
        buildScoredPage("decay-rank-2", "rank 2, decayed", 0.0),
        buildScoredPage("fresh-rank-3", "rank 3, fresh", 0.95),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy },
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const original = process.env["LORE_DISABLE_CONFIDENCE_FACTOR"]
    process.env["LORE_DISABLE_CONFIDENCE_FACTOR"] = "1"
    try {
      const results = await service.search({
        query: "q",
        mode: "contains",
        includeContent: false,
      })
      // Without the factor, Notion's recency order is preserved.
      expect(results.map((m) => m.id)).toEqual([
        "decay-rank-0",
        "decay-rank-1",
        "decay-rank-2",
        "fresh-rank-3",
      ])
    } finally {
      if (original === undefined) {
        delete process.env["LORE_DISABLE_CONFIDENCE_FACTOR"]
      } else {
        process.env["LORE_DISABLE_CONFIDENCE_FACTOR"] = original
      }
    }
  })

  it("saturation cutoff is unchanged — vault with 3+ high-confidence contains hits skips the RRF merge", async () => {
    // Pin that 0.8.0 does NOT modify the saturation cutoff. The spec
    // explicitly defers any "saturated-but-low-confidence" bypass to
    // a follow-up; the RRF merge runs only when contains under-shoots.
    // Even when contains saturates with low-confidence rows, the
    // semantic branch's output is discarded as before. (The trace's
    // confidenceFactor field still surfaces per-row factors so #09's
    // rendering can still highlight stale rows.)
    const querySpy = vi.fn(async () => ({
      results: [
        buildScoredPage("c-0", "decayed first", 0.0),
        buildScoredPage("c-1", "decayed second", 0.0),
        buildScoredPage("c-2", "decayed third", 0.0),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [buildScoredPage("would-float-in", "fresh semantic hit", 0.95)],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    // Cutoff fires; semantic-only row is discarded.
    expect(results.map((m) => m.id)).toEqual(["c-0", "c-1", "c-2"])
  })

  it("searchWithExplain populates confidenceFactor on every row across every branch", async () => {
    // Pin the SearchExplain shape contract: confidenceFactor is now
    // a required field, populated for every row regardless of branch.
    // The single-branch contains case maps each row to its
    // confidenceFactor; the hybrid RRF case carries it via the trace;
    // the contains-saturated case carries it via the saturation trace.
    const containsRows = [
      buildScoredPage("scored", "fresh row", 0.8),
      buildScoredPage("unscored", "pre-migration row", null),
    ]
    const querySpy = vi.fn(async () => ({
      results: containsRows,
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy },
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { explain } = await service.searchWithExplain({
      query: "q",
      mode: "contains",
      includeContent: false,
    })

    expect(explain).toHaveLength(2)
    for (const e of explain) {
      expect(typeof e.confidenceFactor).toBe("number")
      expect(e.confidenceFactor).toBeGreaterThanOrEqual(0.5)
      expect(e.confidenceFactor).toBeLessThanOrEqual(1.0)
    }
    // Specifically: scored row at 0.8 → factor 0.5 + 0.5*0.8 = 0.9.
    const scored = explain.find((e) => e.memoryId === "scored")!
    expect(scored.confidenceFactor).toBeCloseTo(0.9, 10)
    // Unscored row → factor 1.0 (neutral).
    const unscored = explain.find((e) => e.memoryId === "unscored")!
    expect(unscored.confidenceFactor).toBe(1.0)
  })

  it("score (level 1) dominates page-id (level 4) tie-break — comparator runs on factor-weighted scores", async () => {
    // Pin that the comparator runs on the factor-weighted score (level
    // 1), not on raw `1/(RRF_K + rank + 1)`. Two rows have factor 1.0
    // each (so no factor delta) and the higher rank's higher score
    // dominates the alphabetic page-id fall-through (level 4). If a
    // future refactor wired the comparator to read raw scores from
    // some pre-factor field, the tie-break levels would still trigger
    // but on the wrong values; this test would catch a level-1
    // collision on factor-weighted scores even when none should exist.
    //
    // The factor-driven ordering flip is covered by the companion test
    // below ("decayed rank-0 sorts below fresh rank-1") — that one
    // proves the factor is what changes the ordering. This test pins
    // the comparator's read-side: it operates on the same scored
    // values that come out of the accumulator.
    const querySpy = vi.fn(async () => ({
      results: [
        // Both rows scored at 1.0 → both factors 1.0 → score is purely
        // rank-driven. Use scored rows (not unscored) so the
        // all-unscored short-circuit doesn't fire.
        buildScoredPage("z-id-rank-0", "fresh, alphabetically late", 1.0),
        buildScoredPage("a-id-rank-1", "fresh, alphabetically early", 1.0),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy },
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "contains",
      includeContent: false,
    })

    // (1/61) > (1/62), so z-id-rank-0 wins on level 1 score even
    // though page-id ascending (level 4) would put a-id first. Score
    // dominates because the comparator decides at the first level
    // that produces a non-zero result.
    expect(results.map((m) => m.id)).toEqual(["z-id-rank-0", "a-id-rank-1"])
  })

  it("decayed rank-0 sorts below fresh rank-1 in contains mode — factor flips ordering at level 1", async () => {
    // Companion to the fresh-rank-3 worked example, scoped to the
    // adjacent-rank case the spec calls out: pin that the factor
    // multiplies in BEFORE the score comparison. A row at contains-
    // rank 0 with `Confidence Score = 0.0` (factor = 0.5) scores
    // (1/61) * 0.5 ≈ 0.00820. A row at contains-rank 1 with
    // `Confidence Score = 1.0` (factor = 1.0) scores (1/62) * 1.0
    // ≈ 0.01613. Fresh-rank-1 wins on level 1. If a future refactor
    // accidentally applied the factor AFTER the comparator (or
    // skipped it on the single-branch path), the comparator would
    // see the unweighted scores and rank 0 would win — flipping this
    // assertion.
    //
    // This case is distinct from the fresh-rank-3 test in that it
    // pins the closest possible adjacent-rank flip — the smallest
    // ordering change the factor can produce in a single-branch
    // path — so a future tightening of `CONFIDENCE_FACTOR_MIN` toward
    // 1.0 (which would shrink the factor's effective range and
    // potentially un-flip this case) is caught here at the boundary.
    const querySpy = vi.fn(async () => ({
      results: [
        buildScoredPage("rank-0-decayed", "rank 0, fully decayed", 0.0),
        buildScoredPage("rank-1-fresh", "rank 1, fully trusted", 1.0),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy },
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "contains",
      includeContent: false,
    })

    expect(results.map((m) => m.id)).toEqual(["rank-1-fresh", "rank-0-decayed"])
  })
})

describe("MemoryService.searchByHybridPages — structural pipeline split (issue 0.8.0/08)", () => {
  // Pin that hybrid composes the **raw** fetch helpers, not the public
  // confidence-aware sort wrappers. Going through the public wrappers
  // would double-apply the confidence factor and collapse the
  // documented [0.5, 1.0] floor to [0.25, 1.0] in hybrid mode.
  //
  // We can't spy on private methods directly without exposing them, so
  // the structural test goes through the observable Notion calls: the
  // raw fetch helpers each issue exactly one Notion call (the
  // dataSources.query and client.search respectively). If hybrid called
  // the public sort wrappers, the wrappers would still issue one Notion
  // call each (they pass through to the raw helpers), so the round-trip
  // count is identical. The double-application detection lives in the
  // `confidenceFactor` numerical pin in the test above.

  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildScoredPage(
    id: string,
    confidenceScore: number | null
  ): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: id }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
        "Confidence Score": { type: "number", number: confidenceScore },
      },
      {
        id,
        parent: {
          type: "data_source_id",
          data_source_id: db.dataSourceId,
        },
      } as Partial<PageObjectResponse>
    )
  }

  it("hybrid issues exactly one dataSources.query and one client.search — same shape as pre-0.8.0", async () => {
    // Round-trip pinning: hybrid calls the raw fetchContains/fetchSemantic
    // helpers exactly once each. If a future refactor wired hybrid to call
    // the public confidence-aware searchByContainsPages /
    // searchBySemanticPages instead, the raw helpers would still be called
    // exactly once each (transitively, via the public wrappers), so this
    // test alone wouldn't catch the regression. The double-application
    // numerical pin above is the load-bearing test; this one ensures the
    // round-trip cost contract didn't drift.
    const querySpy = vi.fn(async () => ({
      results: [buildScoredPage("c-only", 0.5)],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [buildScoredPage("s-only", 0.7)],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).toHaveBeenCalledTimes(1)
  })

  it("the documented [0.5, 1.0] confidence-factor floor holds in hybrid mode (no factor² collapse)", async () => {
    // The cleanest cross-check that hybrid does NOT call the public
    // wrappers. If it did, the score for a Confidence Score=0.0 row
    // would be `(1/61) * 0.5 * 0.5 = ~0.00410`. With the correct fetch/
    // sort split, the score is `(1/61) * 0.5 = ~0.00820`. The 2x gap
    // is wide enough that floating-point noise can't mask the
    // regression.
    const querySpy = vi.fn(async () => ({
      results: [buildScoredPage("decayed", 0.0)],
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy },
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { explain } = await service.searchWithExplain({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    expect(explain).toHaveLength(1)
    const single = (1 / 61) * 0.5
    const doubled = single * 0.5
    expect(explain[0].rrfScore).toBeCloseTo(single, 10)
    // Belt-and-braces: explicitly assert NOT the doubled value.
    expect(Math.abs((explain[0].rrfScore ?? 0) - doubled)).toBeGreaterThan(1e-6)
  })
})

describe("MemoryService.search — RRF tie-break determinism", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildHybridPage(id: string, title: string): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
      },
      {
        id,
        parent: {
          type: "data_source_id",
          data_source_id: db.dataSourceId,
        },
      } as Partial<PageObjectResponse>
    )
  }

  it("end-to-end: when scores and best-rank tie via mirrored ranks, page id ascending decides", async () => {
    // With weight=1 and integer ranks, two rows with the same multiset
    // of ranks across branches necessarily share both score AND
    // best-rank — so end-to-end coverage of level 2 alone (different
    // best-rank, same score) is impossible without a per-call weight
    // knob. The direct comparator unit tests below cover level 2; this
    // integration test pins the level 4 fall-through that the
    // mirrored-rank fixture actually exercises.
    const querySpy = vi.fn(async () => ({
      results: [
        buildHybridPage("c-rank-1", "ranked second in contains"),
        buildHybridPage("c-rank-0", "ranked first in contains"),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [
        buildHybridPage("c-rank-0", "ranked second in semantic"),
        buildHybridPage("c-rank-1", "ranked first in semantic"),
      ],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    // Both rows score 1/61 + 1/62 (identical), best-rank 0 (each was
    // #1 in some branch), contains-presence on both. Tie-break falls
    // through to page id ascending → c-rank-0 wins lexically.
    expect(results.map((m) => m.id)).toEqual(["c-rank-0", "c-rank-1"])
  })

  it("tie-break level 3: contains-presence wins on score+rank tie", async () => {
    // A contains-only row at rank 0 and a semantic-only row at rank 0
    // both score 1/61 with best-rank 0. Contains-presence breaks the
    // tie. This is the "contains is precision" intuition the prior
    // concat-first heuristic encoded — a future contributor tempted
    // to "make tie-break symmetric" would silently shift this case.
    const querySpy = vi.fn(async () => ({
      results: [buildHybridPage("aaaa-contains", "contains hit")],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      // `zzzz-semantic` sorts after `aaaa-contains` lexically, but the
      // tie-break stops at contains-presence (level 3), never reaching
      // page id. To prove contains-presence is what wins, we put the
      // semantic-only row's id alphabetically *before* the contains
      // row's id — if the comparator fell through to page id, the
      // semantic row would win.
      results: [
        buildHybridPage("aaaa-semantic-but-alphabetically-before", "semantic hit"),
      ],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    // contains-presence wins on score+rank tie even when the
    // semantic-only row sorts earlier alphabetically.
    expect(results.map((m) => m.id)[0]).toBe("aaaa-contains")
  })

  it("tie-break level 4: page id ascending is the final deterministic fallback", async () => {
    // Two semantic-only rows at the same rank are impossible (a single
    // branch returns rows in distinct positions). Construct the page id
    // tie-break by having two rows that both score 1/61 + 1/61 = 2/61
    // (each appears at rank 0 in both branches). Both have contains-
    // presence, identical scores, identical best-rank. Page id
    // determines order.
    //
    // We can't have two rows simultaneously at rank 0 in the same
    // branch, so this test exercises the tie-break by way of the
    // sort's secondary stability — the comparator must reach level 4
    // to resolve the order between rows that genuinely tie at every
    // earlier level. We verify by sandwiching: if we have two pairs
    // and the comparator reaches level 4, the pair-internal order is
    // page id ascending.
    const querySpy = vi.fn(async () => ({
      // Two rows; the alphabetically-later id is at rank 0, the earlier
      // at rank 1.
      results: [buildHybridPage("zzz-1", "z one"), buildHybridPage("aaa-1", "a one")],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      // Swap the order in semantic: alphabetically-earlier at rank 0,
      // later at rank 1. Now zzz-1 has (contains 0, semantic 1) and
      // aaa-1 has (contains 1, semantic 0). Both score 1/61 + 1/62 =
      // identical. Both best-rank 0. Both contains-presence. Tie-break
      // falls through to page id ascending → aaa-1 wins.
      results: [buildHybridPage("aaa-1", "a one"), buildHybridPage("zzz-1", "z one")],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    expect(results.map((m) => m.id)).toEqual(["aaa-1", "zzz-1"])
  })
})

describe("tieBreakingRrfCompare — direct unit tests, one per tie-break level", () => {
  // Direct unit tests against the comparator. End-to-end coverage of
  // level 2 (different best-rank, equal score) is impossible with
  // weight=1 and integer ranks, because two rows with identical scores
  // necessarily share their rank multiset and therefore their min-rank.
  // The unit tests synthesize fixtures the end-to-end fixture cannot
  // produce, ensuring a contributor who simplifies the comparator
  // (e.g. drops level 2) is caught.

  function entry(
    id: string,
    score: number,
    containsRank: number | null,
    semanticRank: number | null,
    confidenceFactor: number = 1.0
  ): RrfEntry {
    return {
      page: { id } as unknown as PageObjectResponse,
      score,
      containsRank,
      semanticRank,
      confidenceFactor,
    }
  }

  it("level 1: higher score wins", () => {
    const a = entry("a", 0.05, 5, 5)
    const b = entry("b", 0.01, 0, 0)
    // Even though `b` has better best-rank, score wins primarily.
    expect(tieBreakingRrfCompare(a, b)).toBeLessThan(0)
    expect(tieBreakingRrfCompare(b, a)).toBeGreaterThan(0)
  })

  it("level 2: lower best-rank wins on score tie", () => {
    const a = entry("a", 0.0322, 0, 5) // best-rank 0
    const b = entry("b", 0.0322, 2, 1) // best-rank 1
    // Same score; level 2 (best-rank) breaks the tie. `a` wins.
    expect(tieBreakingRrfCompare(a, b)).toBeLessThan(0)
    expect(tieBreakingRrfCompare(b, a)).toBeGreaterThan(0)
  })

  it("level 3: contains-presence wins on score+best-rank tie", () => {
    const a = entry("a", 0.0164, 0, null) // contains-only
    const b = entry("b", 0.0164, null, 0) // semantic-only
    // Equal score (1/61), equal best-rank (0). Contains-presence breaks.
    expect(tieBreakingRrfCompare(a, b)).toBeLessThan(0)
    expect(tieBreakingRrfCompare(b, a)).toBeGreaterThan(0)
  })

  it("level 4: page id ascending is the final fallback", () => {
    // Both rows: same score, same best-rank, both contains-present.
    const a = entry("aaa", 0.0322, 0, 1)
    const b = entry("zzz", 0.0322, 0, 1)
    expect(tieBreakingRrfCompare(a, b)).toBeLessThan(0)
    expect(tieBreakingRrfCompare(b, a)).toBeGreaterThan(0)
  })

  it("equal entries (identical id and ranks) compare to 0", () => {
    const a = entry("same", 0.0322, 0, 1)
    const b = entry("same", 0.0322, 0, 1)
    expect(tieBreakingRrfCompare(a, b)).toBe(0)
  })
})

describe("MemoryService.search — intent parameter (#17)", () => {
  // Pin the contains-vs-semantic asymmetry, normalize-once rule (whitespace-only
  // = unset), saturation-bypass-under-intent gate, and contains-lane up-weight
  // under RRF. The tests below mirror the acceptance criteria in
  // `Phase-2/17-search-intent-parameter.md` one-for-one.
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildIntentPage(id: string, title: string): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
      },
      {
        id,
        parent: {
          type: "data_source_id",
          data_source_id: db.dataSourceId,
        },
      } as Partial<PageObjectResponse>
    )
  }

  function makeContainsClause(args: Record<string, unknown>): {
    property: string
    rich_text?: { contains: string }
    title?: { contains: string }
  }[] {
    // Walk into the composed filter and pull out the `(Title contains q) OR
    // (Keywords contains q)` clause so we can pin "intent never enters
    // contains" by string-comparing the contains payload.
    const filter = args["filter"] as { and?: unknown[] } | { or?: unknown[] } | undefined
    if (!filter) return []
    const ands = (filter as { and?: unknown[] }).and
    const direct = (filter as { or?: unknown[] }).or
    const orClause = ands
      ? (ands.find((c) => typeof c === "object" && c !== null && "or" in c) as
          | { or: unknown[] }
          | undefined)
      : direct
        ? { or: direct }
        : undefined
    if (!orClause) return []
    return orClause.or as ReturnType<typeof makeContainsClause>
  }

  it("intent does NOT enter the contains branch's filter — substring stays query-only", async () => {
    // The motivating rule: appending intent into the substring filter would
    // narrow recall in the wrong direction (Titles missing the literal
    // disambiguator drop out). Pin contains' filter equals `query` alone.
    const querySpy = vi.fn(async (_args: Record<string, unknown>) => ({
      results: [],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({ results: [] }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await service.search({
      query: "auth",
      intent: "WeChat session cookie",
      mode: "hybrid",
      includeContent: false,
    })

    expect(querySpy).toHaveBeenCalledTimes(1)
    const containsArgs = querySpy.mock.calls[0][0] as Record<string, unknown>
    const orClause = makeContainsClause(containsArgs)
    // Both inner clauses contain `"auth"`, never `"WeChat"` or the joined string.
    expect(orClause.length).toBeGreaterThan(0)
    for (const clause of orClause) {
      const needle = clause.rich_text?.contains ?? clause.title?.contains ?? ""
      expect(needle).toBe("auth")
      expect(needle).not.toContain("WeChat")
    }
  })

  it("intent enters the semantic branch's query when non-empty after trim", async () => {
    // Composition is `[query.trim(), intent].filter(Boolean).join(" ")`.
    // Standard non-empty case: `"auth WeChat session cookie"`.
    const searchSpy = vi.fn(async (_args: Record<string, unknown>) => ({ results: [] }))
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await service.search({
      query: "auth",
      intent: "WeChat session cookie",
      mode: "semantic",
    })

    expect(searchSpy).toHaveBeenCalledTimes(1)
    expect(searchSpy.mock.calls[0][0]["query"]).toBe("auth WeChat session cookie")
  })

  it("intent composition handles empty query without a leading space", async () => {
    // Edge case from Fix 3: `MemoryService.search` callers may pass `""`
    // for unscoped relevance lookups. Naive `${query.trim()} ${intent}`
    // would produce `" intent"` — Notion ranks that differently from
    // `"intent"`. The `filter(Boolean)` shape protects against this.
    const searchSpy = vi.fn(async (_args: Record<string, unknown>) => ({ results: [] }))
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await service.search({
      query: "",
      intent: "performance",
      mode: "semantic",
    })

    expect(searchSpy.mock.calls[0][0]["query"]).toBe("performance")
  })

  it("whitespace-only intent (`'   '`) is byte-identical to unset on the semantic-branch composition", async () => {
    // Pins the semantic-branch consumer of the normalize-once rule —
    // whitespace-only intent collapses to `null` and the composed query
    // is `"auth"`, not `"auth "` or `"auth    "`. The other two
    // consumers (saturation gate, lane weighting under hybrid) are
    // pinned independently by the dedicated test
    // `"whitespace-only intent triggers neither saturation bypass nor
    // lane up-weight"` below.
    const searchSpy = vi.fn(async (_args: Record<string, unknown>) => ({ results: [] }))
    const client = {
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await service.search({ query: "auth", intent: "   ", mode: "semantic" })

    // Whitespace-only intent → semantic query is `"auth"`, NOT `"auth    "`
    // and NOT `"auth "` — byte-identical to the unset path.
    expect(searchSpy.mock.calls[0][0]["query"]).toBe("auth")
  })

  it("mode='contains' ignores intent entirely — server-side filter identical to intent-unset", async () => {
    // Acceptance: contains-mode filter shape is byte-identical with or
    // without intent. Drive both calls and snapshot the filter argument.
    const querySpy = vi.fn(async (_args: Record<string, unknown>) => ({
      results: [],
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy },
      // contains mode never touches client.search; presence here is just
      // to satisfy the constructor.
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await service.search({ query: "auth", mode: "contains", includeContent: false })
    const filterUnset = (querySpy.mock.calls[0][0] as Record<string, unknown>)["filter"]

    await service.search({
      query: "auth",
      intent: "WeChat session cookie",
      mode: "contains",
      includeContent: false,
    })
    const filterWithIntent = (querySpy.mock.calls[1][0] as Record<string, unknown>)[
      "filter"
    ]

    expect(filterWithIntent).toEqual(filterUnset)
  })

  it("mode='hybrid' bypasses the saturation cutoff when intent is non-empty after trim", async () => {
    // Three contains hits would normally saturate. With intent set, the
    // RRF merge runs anyway so the semantic lane can influence ordering.
    const containsHits = [
      buildIntentPage("c-0", "first"),
      buildIntentPage("c-1", "second"),
      buildIntentPage("c-2", "third"),
    ]
    const querySpy = vi.fn(async () => ({
      results: containsHits,
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      // A row only the semantic branch surfaces. If the saturation cutoff
      // fired, this row would be discarded and the result would be
      // contains-only (`["c-0", "c-1", "c-2"]`).
      results: [buildIntentPage("semantic-only", "would float in under RRF")],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { explain } = await service.searchWithExplain({
      query: "auth",
      intent: "WeChat session cookie",
      mode: "hybrid",
      includeContent: false,
    })

    // The branch must be `rrf`, not `contains-saturated` — that is the
    // signal the saturation gate was bypassed. The semantic-only row
    // surfaces somewhere in the result set as well, but its position is
    // covered by the dedicated lane-weighting test below.
    expect(explain.every((e) => e.branch === "rrf")).toBe(true)
    const ids = explain.map((e) => e.memoryId)
    expect(ids).toContain("semantic-only")
  })

  it("mode='hybrid' with intent: contains lane is up-weighted (weight=2) under RRF", async () => {
    // Up-weighting only matters when both branches return the same row.
    // Construct a fixture where one row appears in both branches and one
    // appears in only the semantic branch. Under weight=1 on contains
    // (no intent), both rows would score 2/61 and 1/61 — same ordering.
    // The cleanest way to pin "weight=2 actually applied" is the rrfScore
    // on the cross-branch row: `2 * (1/61) + 1 * (1/61) = 3/61` instead
    // of the unweighted `2/61`.
    const querySpy = vi.fn(async () => ({
      results: [buildIntentPage("cross", "in both branches")],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [buildIntentPage("cross", "in both branches")],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { explain } = await service.searchWithExplain({
      query: "auth",
      intent: "WeChat",
      mode: "hybrid",
      includeContent: false,
    })

    expect(explain).toHaveLength(1)
    expect(explain[0].memoryId).toBe("cross")
    // contains weight=2 → 2/61; semantic weight=1 → 1/61; sum = 3/61.
    expect(explain[0].rrfScore).toBeCloseTo(3 / 61, 10)
  })

  it("mode='hybrid' with intent unset: saturation cutoff fires + RRF weights default to 1 below it", async () => {
    // Acceptance: when intent is unset, behavior is byte-identical to
    // #16's baseline. Drive two scenarios under intent-unset and pin
    // them both: (a) saturating cutoff still fires at the threshold,
    // and (b) below-threshold RRF runs with both weights = 1.

    // (a) Saturating: 3 contains hits → contains-saturated branch.
    {
      const querySpy = vi.fn(async () => ({
        results: [
          buildIntentPage("c-0", "first"),
          buildIntentPage("c-1", "second"),
          buildIntentPage("c-2", "third"),
        ],
        has_more: false,
        next_cursor: null,
      }))
      const searchSpy = vi.fn(async () => ({
        results: [buildIntentPage("semantic-only", "would float in under RRF")],
      }))
      const client = {
        dataSources: { query: querySpy },
        search: searchSpy,
        pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
      } as unknown as Client
      const service = new MemoryService(client, db)

      const { explain } = await service.searchWithExplain({
        query: "auth",
        mode: "hybrid",
        includeContent: false,
      })

      expect(explain.every((e) => e.branch === "contains-saturated")).toBe(true)
      expect(explain.map((e) => e.memoryId)).toEqual(["c-0", "c-1", "c-2"])
    }

    // (b) Under-shoot: intent unset, both lanes weight=1 → cross-branch row scores 2/61.
    {
      const querySpy = vi.fn(async () => ({
        results: [buildIntentPage("cross", "in both branches")],
        has_more: false,
        next_cursor: null,
      }))
      const searchSpy = vi.fn(async () => ({
        results: [buildIntentPage("cross", "in both branches")],
      }))
      const client = {
        dataSources: { query: querySpy },
        search: searchSpy,
        pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
      } as unknown as Client
      const service = new MemoryService(client, db)

      const { explain } = await service.searchWithExplain({
        query: "auth",
        mode: "hybrid",
        includeContent: false,
      })

      expect(explain).toHaveLength(1)
      expect(explain[0].rrfScore).toBeCloseTo(2 / 61, 10)
    }
  })

  it("whitespace-only intent triggers neither saturation bypass nor lane up-weight", async () => {
    // Reinforces the "whitespace-only is unset" rule across the two
    // hybrid-only consumers: saturation gate must fire, and the RRF
    // weights below the threshold must default to 1.

    // Saturation case — whitespace-only intent should NOT bypass the cutoff.
    {
      const querySpy = vi.fn(async () => ({
        results: [
          buildIntentPage("c-0", "first"),
          buildIntentPage("c-1", "second"),
          buildIntentPage("c-2", "third"),
        ],
        has_more: false,
        next_cursor: null,
      }))
      const searchSpy = vi.fn(async () => ({
        results: [buildIntentPage("semantic-only", "would float in under RRF")],
      }))
      const client = {
        dataSources: { query: querySpy },
        search: searchSpy,
        pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
      } as unknown as Client
      const service = new MemoryService(client, db)

      const { explain } = await service.searchWithExplain({
        query: "auth",
        intent: "   ",
        mode: "hybrid",
        includeContent: false,
      })

      expect(explain.every((e) => e.branch === "contains-saturated")).toBe(true)
      expect(explain.map((e) => e.memoryId)).toEqual(["c-0", "c-1", "c-2"])
    }

    // Under-shoot case — whitespace-only intent should NOT up-weight contains.
    {
      const querySpy = vi.fn(async () => ({
        results: [buildIntentPage("cross", "in both branches")],
        has_more: false,
        next_cursor: null,
      }))
      const searchSpy = vi.fn(async () => ({
        results: [buildIntentPage("cross", "in both branches")],
      }))
      const client = {
        dataSources: { query: querySpy },
        search: searchSpy,
        pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
      } as unknown as Client
      const service = new MemoryService(client, db)

      const { explain } = await service.searchWithExplain({
        query: "auth",
        intent: "   ",
        mode: "hybrid",
        includeContent: false,
      })

      expect(explain).toHaveLength(1)
      // Both weights = 1 → 2/61, NOT 3/61.
      expect(explain[0].rrfScore).toBeCloseTo(2 / 61, 10)
    }
  })
})

describe("MemoryService.searchWithExplain — branch-field rules and explain alignment", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildPageInDb(id: string, title: string): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
      },
      {
        id,
        parent: {
          type: "data_source_id",
          data_source_id: db.dataSourceId,
        },
      } as Partial<PageObjectResponse>
    )
  }

  it("MemoryService.search return type is unchanged — Memory[]", async () => {
    // Structural pin: a future contributor cannot accidentally add a
    // wrapper return type to `search()` without breaking this fixture.
    const querySpy = vi.fn(async () => ({
      results: [buildPageInDb("a", "first")],
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy },
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "contains",
      includeContent: false,
    })

    expect(Array.isArray(results)).toBe(true)
    expect(results[0].id).toBe("a")
    // Each entry is a `Memory` — has the structural-domain fields.
    expect(results[0].title).toBe("first")
  })

  it("explain[i] aligns with memories[i] by page id", async () => {
    // The alignment guarantee is what makes the trace useful — a caller
    // can iterate both arrays in lockstep and know the trace describes
    // the same row.
    const querySpy = vi.fn(async () => ({
      results: [buildPageInDb("c-1", "contains hit")],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [buildPageInDb("s-1", "semantic 1"), buildPageInDb("s-2", "semantic 2")],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { memories, explain } = await service.searchWithExplain({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    expect(memories).toHaveLength(explain.length)
    for (let i = 0; i < memories.length; i++) {
      expect(explain[i].memoryId).toBe(memories[i].id)
    }
  })

  it("contains mode: branch is 'contains-only', semanticRank and rrfScore are null", async () => {
    const querySpy = vi.fn(async () => ({
      results: [buildPageInDb("a", "first"), buildPageInDb("b", "second")],
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy },
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { explain } = await service.searchWithExplain({
      query: "q",
      mode: "contains",
      includeContent: false,
    })

    expect(explain).toHaveLength(2)
    for (let i = 0; i < explain.length; i++) {
      expect(explain[i].branch).toBe("contains-only")
      expect(explain[i].containsRank).toBe(i)
      expect(explain[i].semanticRank).toBeNull()
      expect(explain[i].rrfScore).toBeNull()
    }
  })

  it("semantic mode: branch is 'semantic-only', containsRank and rrfScore are null", async () => {
    const searchSpy = vi.fn(async () => ({
      results: [buildPageInDb("a", "first"), buildPageInDb("b", "second")],
    }))
    const client = {
      dataSources: { query: vi.fn() },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { explain } = await service.searchWithExplain({
      query: "q",
      mode: "semantic",
      includeContent: false,
    })

    expect(explain).toHaveLength(2)
    for (let i = 0; i < explain.length; i++) {
      expect(explain[i].branch).toBe("semantic-only")
      expect(explain[i].containsRank).toBeNull()
      expect(explain[i].semanticRank).toBe(i)
      expect(explain[i].rrfScore).toBeNull()
    }
  })

  it("hybrid saturated branch: semanticRank is null even when semantic surfaced the row", async () => {
    // The semantic branch ran in parallel and may even have returned the
    // same id, but its output was discarded — surfacing semanticRank
    // would imply influence on ordering that did not happen.
    const querySpy = vi.fn(async () => ({
      results: [
        buildPageInDb("a", "first"),
        buildPageInDb("b", "second"),
        buildPageInDb("c", "third"),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      // Semantic returns row `a` at rank 0 — but contains saturated, so
      // its rank is suppressed in the trace.
      results: [buildPageInDb("a", "first")],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { explain } = await service.searchWithExplain({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    expect(explain).toHaveLength(3)
    for (let i = 0; i < explain.length; i++) {
      expect(explain[i].branch).toBe("contains-saturated")
      expect(explain[i].containsRank).toBe(i)
      expect(explain[i].semanticRank).toBeNull()
      expect(explain[i].rrfScore).toBeNull()
    }
  })

  it("hybrid saturation: 3 contains hits land on contains-saturated regardless of which property each row matched on", async () => {
    // Structural pin for the saturation-cutoff. Synopsis hits count
    // toward HYBRID_FALLBACK_THRESHOLD the same way Title/Keywords hits
    // do — three rows in the contains result list saturate, the parallel
    // semantic call's output is discarded, and every row carries
    // `contains-saturated`. The actual pre-#04→post-#04 threshold
    // *crossing* (where adding Synopsis takes the hit count from 2 to
    // 3) is demonstrated end-to-end in
    // `memory-search.integration.test.ts` against a fixture vault that
    // evaluates the contains predicate. Here we pin only the post-#04
    // outcome at the threshold boundary.
    const querySpy = vi.fn(async () => ({
      results: [
        buildPageInDb("title-hit", "PR-25650 row"),
        buildPageInDb("keywords-hit", "Other row"),
        buildPageInDb("synopsis-hit", "Yet another row"),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [buildPageInDb("semantic-only", "would float in under RRF")],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { memories, explain } = await service.searchWithExplain({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    // Three contains hits hit the saturation threshold — semantic
    // result is discarded and every row carries `contains-saturated`.
    expect(memories.map((m) => m.id)).toEqual([
      "title-hit",
      "keywords-hit",
      "synopsis-hit",
    ])
    for (const e of explain) {
      expect(e.branch).toBe("contains-saturated")
      expect(e.semanticRank).toBeNull()
      expect(e.rrfScore).toBeNull()
    }
  })

  it("hybrid stable branch: zero contains hits stays on rrf regardless of Synopsis OR branch", async () => {
    // Companion to the threshold-crossing test: when the post-#04
    // contains count stays on the same side of the threshold as
    // pre-#04 (here, 0 → 0), the resolved branch is unchanged. Pins
    // the "stable-branch fixture" half of issue 0.7.0/04's
    // branch-stability acceptance.
    const querySpy = vi.fn(async () => ({
      results: [],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [buildPageInDb("s-1", "semantic 1"), buildPageInDb("s-2", "semantic 2")],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { explain } = await service.searchWithExplain({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    // Zero contains hits → RRF runs (the saturation gate doesn't fire).
    // Every row sits on `rrf`, semantic-only.
    for (const e of explain) {
      expect(e.branch).toBe("rrf")
      expect(e.containsRank).toBeNull()
      expect(e.semanticRank).not.toBeNull()
    }
  })

  it("hybrid rrf branch: both ranks reflect actual branch presence; rrfScore populated", async () => {
    const querySpy = vi.fn(async () => ({
      results: [buildPageInDb("c-only", "contains alone")],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({
      results: [
        buildPageInDb("c-only", "contains alone"),
        buildPageInDb("s-only", "semantic alone"),
      ],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { memories, explain } = await service.searchWithExplain({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    const cOnly = explain.find((e) => e.memoryId === "c-only")
    const sOnly = explain.find((e) => e.memoryId === "s-only")

    expect(cOnly?.branch).toBe("rrf")
    expect(cOnly?.containsRank).toBe(0)
    expect(cOnly?.semanticRank).toBe(0)
    expect(cOnly?.rrfScore).toBeCloseTo(2 / 61, 10)

    expect(sOnly?.branch).toBe("rrf")
    expect(sOnly?.containsRank).toBeNull()
    expect(sOnly?.semanticRank).toBe(1)
    expect(sOnly?.rrfScore).toBeCloseTo(1 / 62, 10)

    // c-only sorts above s-only because cross-branch agreement scores
    // higher than single-branch presence.
    expect(memories.map((m) => m.id)).toEqual(["c-only", "s-only"])
  })

  it("LORE_FORCE_SEMANTIC_SEARCH=1 routes mode='hybrid' through 'semantic-only'", async () => {
    // Pin the kill-switch path: when the operator forces semantic, the
    // explain trace reports `semantic-only`, not `rrf` or
    // `contains-saturated`. The `mode` argument is ignored.
    const prev = process.env["LORE_FORCE_SEMANTIC_SEARCH"]
    process.env["LORE_FORCE_SEMANTIC_SEARCH"] = "1"
    try {
      const searchSpy = vi.fn(async () => ({
        results: [buildPageInDb("a", "first")],
      }))
      const client = {
        dataSources: { query: vi.fn() },
        search: searchSpy,
        pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
      } as unknown as Client
      const service = new MemoryService(client, db)

      const { explain } = await service.searchWithExplain({
        query: "q",
        mode: "hybrid",
        includeContent: false,
      })

      expect(explain).toHaveLength(1)
      expect(explain[0].branch).toBe("semantic-only")
      expect(explain[0].containsRank).toBeNull()
    } finally {
      if (prev === undefined) delete process.env["LORE_FORCE_SEMANTIC_SEARCH"]
      else process.env["LORE_FORCE_SEMANTIC_SEARCH"] = prev
    }
  })

  it("SearchExplain field names are canonical to lore (containsRank, not lexRank)", async () => {
    // qmd uses `lexRank` for the contains lane. Pin lore's vocabulary so
    // a future contributor doesn't silently rename chasing qmd's words.
    const querySpy = vi.fn(async () => ({
      results: [buildPageInDb("a", "first")],
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy },
      search: vi.fn(async () => ({ results: [] })),
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { explain } = await service.searchWithExplain({
      query: "q",
      mode: "contains",
      includeContent: false,
    })

    const entry = explain[0]
    expect(Object.keys(entry).sort()).toEqual([
      "branch",
      "confidenceFactor",
      "containsRank",
      "memoryId",
      "rrfScore",
      "semanticRank",
    ])
  })
})

describe("MemoryService.search — hybrid single-branch resilience (PF3-03)", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildHybridPage(id: string, title: string): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
      },
      {
        id,
        parent: {
          type: "data_source_id",
          data_source_id: db.dataSourceId,
        },
      } as Partial<PageObjectResponse>
    )
  }

  it("returns contains-only results when the semantic branch rejects", async () => {
    // Pre-PF3-03 (Promise.all): a transient 429 from client.search would
    // propagate to the caller even though contains saturated independently.
    // With Promise.allSettled the surviving branch's rows pass through.
    const querySpy = vi.fn(async () => ({
      results: [
        buildHybridPage("c-1", "one"),
        buildHybridPage("c-2", "two"),
        buildHybridPage("c-3", "three"),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => {
      throw new Error("simulated 429 from client.search")
    })
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    expect(results.map((m) => m.id)).toEqual(["c-1", "c-2", "c-3"])
    // Both branches were dispatched — the failure path runs after settle,
    // not before dispatch.
    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).toHaveBeenCalledTimes(1)
  })

  it("returns semantic-only results when the contains branch rejects", async () => {
    // Inverted scenario: a Notion outage on dataSources.query while
    // client.search still serves vector hits. Contains' empty result is
    // treated as "no contains rows", semantic provides the full output.
    const querySpy = vi.fn(async () => {
      throw new Error("simulated 5xx from dataSources.query")
    })
    const searchSpy = vi.fn(async () => ({
      results: [
        buildHybridPage("s-1", "semantic 1"),
        buildHybridPage("s-2", "semantic 2"),
      ],
    }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
    })

    expect(results.map((m) => m.id)).toEqual(["s-1", "s-2"])
    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).toHaveBeenCalledTimes(1)
  })

  it("surfaces an error when both branches reject (no silent empty)", async () => {
    // Both-failure case must propagate. A genuinely broken search
    // subsystem should not look identical to "no results found" — that
    // would mask a production outage.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const containsError = new Error("contains-failed")
      const semanticError = new Error("semantic-failed")
      const querySpy = vi.fn(async () => {
        throw containsError
      })
      const searchSpy = vi.fn(async () => {
        throw semanticError
      })
      const client = {
        dataSources: { query: querySpy },
        search: searchSpy,
        pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
      } as unknown as Client
      const service = new MemoryService(client, db)

      await expect(
        service.search({ query: "q", mode: "hybrid", includeContent: false })
      ).rejects.toThrow("contains-failed")
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it("LORE_DEBUG=1 emits one stderr line per failing branch with branch= and error=", async () => {
    // Operator observability: under LORE_DEBUG=1 a failed branch logs
    // exactly one line so log aggregators can correlate transient blips
    // without the caller seeing them. No log line under default LORE_DEBUG.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const original = process.env["LORE_DEBUG"]
    process.env["LORE_DEBUG"] = "1"
    try {
      const querySpy = vi.fn(async () => ({
        results: [
          buildHybridPage("c-1", "one"),
          buildHybridPage("c-2", "two"),
          buildHybridPage("c-3", "three"),
        ],
        has_more: false,
        next_cursor: null,
      }))
      const searchSpy = vi.fn(async () => {
        throw new Error("simulated rate-limit")
      })
      const client = {
        dataSources: { query: querySpy },
        search: searchSpy,
        pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
      } as unknown as Client
      const service = new MemoryService(client, db)

      await service.search({
        query: "q",
        mode: "hybrid",
        includeContent: false,
      })

      const lines = stderrSpy.mock.calls.map((c) => String(c[0]))
      const hybridLines = lines.filter((l) => l.includes("source=hybrid-search"))
      expect(hybridLines).toHaveLength(1)
      expect(hybridLines[0]).toContain("branch=semantic")
      expect(hybridLines[0]).toContain("error=simulated rate-limit")
      // One-event-per-line invariant — the line is newline-terminated.
      expect(hybridLines[0].endsWith("\n")).toBe(true)
    } finally {
      stderrSpy.mockRestore()
      if (original === undefined) {
        delete process.env["LORE_DEBUG"]
      } else {
        process.env["LORE_DEBUG"] = original
      }
    }
  })

  it("emits no stderr line when LORE_DEBUG is unset (default-quiet)", async () => {
    // The default operator experience: a transient blip degrades to a
    // surviving-branch-only result with zero stderr noise. Operators
    // who want visibility opt in via LORE_DEBUG=1.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const original = process.env["LORE_DEBUG"]
    delete process.env["LORE_DEBUG"]
    try {
      const querySpy = vi.fn(async () => ({
        results: [
          buildHybridPage("c-1", "one"),
          buildHybridPage("c-2", "two"),
          buildHybridPage("c-3", "three"),
        ],
        has_more: false,
        next_cursor: null,
      }))
      const searchSpy = vi.fn(async () => {
        throw new Error("simulated rate-limit")
      })
      const client = {
        dataSources: { query: querySpy },
        search: searchSpy,
        pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
      } as unknown as Client
      const service = new MemoryService(client, db)

      await service.search({
        query: "q",
        mode: "hybrid",
        includeContent: false,
      })

      const hybridLines = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("source=hybrid-search"))
      expect(hybridLines).toHaveLength(0)
    } finally {
      stderrSpy.mockRestore()
      if (original === undefined) {
        delete process.env["LORE_DEBUG"]
      } else {
        process.env["LORE_DEBUG"] = original
      }
    }
  })

  it("returns an empty result when one branch rejects and the survivor genuinely has zero hits", async () => {
    // The visibility cost called out in the spec: a caller cannot
    // distinguish "contains down + no semantic match" from "clean miss".
    // This is by design — the surviving branch's empty result IS the
    // honest answer to the query — but pinning the contract here keeps
    // the tradeoff greppable. LORE_DEBUG=1 is the operator-side
    // mitigation; the production followup is an error-counter dashboard.
    //
    // stderrSpy is defensive: under default LORE_DEBUG the partial-failure
    // helper is a no-op, but a parent test that leaks LORE_DEBUG=1 (or a
    // future vitest pool config flip from `forks` to `threads`) would let
    // stderr noise pollute test output. Cheap insurance.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const querySpy = vi.fn(async () => {
        throw new Error("simulated 5xx from dataSources.query")
      })
      const searchSpy = vi.fn(async () => ({ results: [] }))
      const client = {
        dataSources: { query: querySpy },
        search: searchSpy,
        pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
      } as unknown as Client
      const service = new MemoryService(client, db)

      const results = await service.search({
        query: "q",
        mode: "hybrid",
        includeContent: false,
      })

      // Zero rows surfaced — same shape a genuine clean-miss would return.
      // The caller cannot tell the difference; only the operator can, via
      // the LORE_DEBUG=1 stderr line covered by a separate test.
      expect(results).toEqual([])
      expect(querySpy).toHaveBeenCalledTimes(1)
      expect(searchSpy).toHaveBeenCalledTimes(1)
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it("both-fail emits a [lore] both-failure line UNCONDITIONALLY (not gated on LORE_DEBUG)", async () => {
    // Reviewer concern: the both-fail case is the worst-case scenario —
    // there is no surviving response to mask noise on, the caller's
    // try/catch only sees the chosen throw, and the operator needs every
    // rejection reason on stderr regardless of LORE_DEBUG. Logging
    // unconditionally is the right tradeoff here even though the
    // partial-failure path stays opt-in.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const original = process.env["LORE_DEBUG"]
    delete process.env["LORE_DEBUG"]
    try {
      const querySpy = vi.fn(async () => {
        throw new Error("contains-down")
      })
      const searchSpy = vi.fn(async () => {
        throw new Error("semantic-down")
      })
      const client = {
        dataSources: { query: querySpy },
        search: searchSpy,
        pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
      } as unknown as Client
      const service = new MemoryService(client, db)

      await expect(
        service.search({ query: "q", mode: "hybrid", includeContent: false })
      ).rejects.toThrow("contains-down")

      const bothFailureLines = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("[lore] both-failure:"))
      expect(bothFailureLines).toHaveLength(1)
      const line = bothFailureLines[0]
      // Both rejection messages on the single line — operators see the
      // suppressed-branch error alongside the thrown one.
      expect(line).toContain("contains=contains-down")
      expect(line).toContain("semantic=semantic-down")
      expect(line).toContain("source=hybrid-search")
      expect(line.endsWith("\n")).toBe(true)
    } finally {
      stderrSpy.mockRestore()
      if (original === undefined) {
        delete process.env["LORE_DEBUG"]
      } else {
        process.env["LORE_DEBUG"] = original
      }
    }
  })

  it("non-Error rejection reasons (undefined, null, plain string) render as diagnostic strings, not 'undefined'", async () => {
    // Defensive log-quality fallback: a sloppy `Promise.reject()` (no arg)
    // would otherwise read `error=undefined`, which is parsable but not
    // diagnostic. Plain-string rejections pass through unchanged.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const original = process.env["LORE_DEBUG"]
    process.env["LORE_DEBUG"] = "1"
    try {
      const querySpy = vi.fn(async () => ({
        results: [
          buildHybridPage("c-1", "one"),
          buildHybridPage("c-2", "two"),
          buildHybridPage("c-3", "three"),
        ],
        has_more: false,
        next_cursor: null,
      }))
      const searchSpy = vi.fn(async () => Promise.reject(undefined))
      const client = {
        dataSources: { query: querySpy },
        search: searchSpy,
        pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
      } as unknown as Client
      const service = new MemoryService(client, db)

      await service.search({
        query: "q",
        mode: "hybrid",
        includeContent: false,
      })

      const hybridLines = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("source=hybrid-search"))
      expect(hybridLines).toHaveLength(1)
      expect(hybridLines[0]).toContain("error=<non-error rejection>")
      // Crucially NOT this — that's the bug the fallback fixes.
      expect(hybridLines[0]).not.toContain("error=undefined")
    } finally {
      stderrSpy.mockRestore()
      if (original === undefined) {
        delete process.env["LORE_DEBUG"]
      } else {
        process.env["LORE_DEBUG"] = original
      }
    }
  })
})

describe("MemoryService.search — hybrid abort on contains saturation (issue #490)", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildHybridPage(id: string, title: string): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
      },
      {
        id,
        parent: {
          type: "data_source_id",
          data_source_id: db.dataSourceId,
        },
      } as Partial<PageObjectResponse>
    )
  }

  // Build a PageObjectResponse whose parent is the test's Memories DS so
  // `applySemanticPostFilters` keeps it. `client.search` returns
  // workspace-wide results that Lore filters down — fixtures that don't
  // set the parent correctly are silently dropped and confuse abort
  // tests.
  function buildSemanticPage(id: string, title: string): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
      },
      {
        id,
        parent: {
          type: "data_source_id",
          data_source_id: db.dataSourceId,
        },
      } as Partial<PageObjectResponse>
    )
  }

  type SemanticPage = {
    results: PageObjectResponse[]
    has_more?: boolean
    next_cursor?: string | null
  }

  type ContainsResponse =
    | { kind: "fulfilled"; results: PageObjectResponse[] }
    | { kind: "rejected"; reason: Error }

  /**
   * Build a `Client` mock for the abort/saturation tests. The four
   * abort tests differ only in:
   *
   *   - the contains result shape (saturating vs under-shooting vs
   *     rejected),
   *   - the cursor → semantic-page map,
   *   - whether the first semantic page yields to a macrotask before
   *     resolving (the load-bearing pin for the "exactly one
   *     `client.search` call" assertion in the synchronous-mock
   *     setup; production gets the same residual-call bound from the
   *     actual `client.search` HTTP latency).
   *
   * Without this helper, each test inlined ~30 lines of mock client
   * construction with subtle differences that obscured the actual
   * test contract. The helper surfaces the contract directly: WHAT
   * contains returns, WHAT each semantic page returns, WHETHER page 1
   * yields to a macrotask.
   */
  function buildHybridSearchMockClient(opts: {
    contains: ContainsResponse
    /**
     * Map of `start_cursor` → page response. `undefined` is the first
     * page; subsequent pages are keyed by the `next_cursor` returned
     * by the previous page. A request whose cursor isn't in the map
     * returns an empty exhaustion shape (`has_more: false`,
     * `next_cursor: null`).
     */
    semanticPagesByCursor: Map<string | undefined, SemanticPage>
    /**
     * When true, semantic page 1's mock awaits `setTimeout(0)` before
     * resolving — a macrotask boundary that lets every microtask
     * queued before it run, so contains' saturation handler has time
     * to call `controller.abort()` before the next iteration's
     * pre-call signal check fires. Without this, the synchronous
     * mock can produce 2 in-flight `client.search` calls in the
     * worst microtask ordering even though production would only
     * produce 1 (the network round-trip provides the same yield).
     */
    yieldOnFirstSemanticPage: boolean
  }): { client: Client; querySpy: ReturnType<typeof vi.fn>; searchSpy: ReturnType<typeof vi.fn> } {
    const querySpy =
      opts.contains.kind === "fulfilled"
        ? vi.fn(async () => ({
            results: (opts.contains as { kind: "fulfilled"; results: PageObjectResponse[] })
              .results,
            has_more: false,
            next_cursor: null,
          }))
        : vi.fn(async () => {
            throw (opts.contains as { kind: "rejected"; reason: Error }).reason
          })

    let semanticCallCount = 0
    const searchSpy = vi.fn(async (args: Record<string, unknown>) => {
      const cursor = args["start_cursor"] as string | undefined
      const page = opts.semanticPagesByCursor.get(cursor) ?? {
        results: [],
        has_more: false,
        next_cursor: null,
      }
      const isFirstPage = ++semanticCallCount === 1
      if (isFirstPage && opts.yieldOnFirstSemanticPage) {
        await new Promise<void>((r) => setTimeout(r, 0))
      }
      return {
        results: page.results,
        has_more: page.has_more ?? false,
        next_cursor: page.next_cursor ?? null,
      }
    })

    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client

    return { client, querySpy, searchSpy }
  }

  it("aborts the in-flight semantic pagination after contains saturates — second client.search never fires", async () => {
    // Pre-fix: a saturating contains query still paid up to
    // SEMANTIC_SEARCH_MAX_PAGES (5) sequential semantic round-trips
    // before the discarded result resolved. Post-fix: the semantic
    // loop terminates after the in-flight page lands, so subsequent
    // pages never dispatch.
    //
    // Synchronization rationale: contains resolves immediately and
    // the side-effect saturation handler attached in
    // `searchByHybridPages` queues as a microtask. Semantic page 1
    // awaits `setTimeout(0)` — a macrotask boundary that lets every
    // microtask queued before it run before the macrotask continues
    // — so by the time page 1 resolves, contains has settled, the
    // saturation handler has called `controller.abort()`, and the
    // post-filter signal check inside `applySemanticPostFilters`
    // throws before page 2 dispatches. This pin reflects the
    // production-typical bound (residual = 1) rather than the
    // worst-case synchronous-mock bound (residual = 2 in the
    // semantic-continuation-runs-first microtask ordering); see
    // `fetchSemanticPages`'s docstring for the full residual-call
    // analysis.
    const { service, searchSpy } = buildHybridSearchTestRig({
      contains: {
        kind: "fulfilled",
        results: [
          buildHybridPage("c-1", "one"),
          buildHybridPage("c-2", "two"),
          buildHybridPage("c-3", "three"),
        ],
      },
      semanticPagesByCursor: new Map<string | undefined, SemanticPage>([
        [
          undefined,
          {
            results: [
              buildSemanticPage("s-1", "semantic 1"),
              buildSemanticPage("s-2", "semantic 2"),
            ],
            has_more: true,
            next_cursor: "cursor-1",
          },
        ],
        [
          "cursor-1",
          {
            results: [buildSemanticPage("s-3", "semantic 3")],
            has_more: false,
            next_cursor: null,
          },
        ],
      ]),
      yieldOnFirstSemanticPage: true,
    })

    const results = await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
      // limit > saturation threshold so semantic would NOT saturate on
      // its own — only the abort can stop the second page.
      limit: 10,
    })

    // Saturation cutoff: contains rows alone are the answer; semantic
    // result is discarded.
    expect(results.map((m) => m.id)).toEqual(["c-1", "c-2", "c-3"])
    // The win: exactly one `client.search` call. Pre-fix this would
    // have been 2 (or up to 5 on a pathological query).
    expect(searchSpy).toHaveBeenCalledTimes(1)
  })

  it("does not abort when contains under-shoots the saturation threshold", async () => {
    // Defensive contract: under-shoot means RRF runs and the semantic
    // pagination must complete normally. An over-eager abort here
    // would silently lose semantic rows that should fuse with contains
    // under RRF.
    const semanticPage1 = Array.from({ length: 100 }, (_, i) =>
      buildSemanticPage(`s-page1-${i}`, `semantic page1 ${i}`)
    )
    const { service, searchSpy } = buildHybridSearchTestRig({
      contains: {
        kind: "fulfilled",
        // Two contains hits — below HYBRID_FALLBACK_THRESHOLD (3).
        results: [buildHybridPage("c-1", "one"), buildHybridPage("c-2", "two")],
      },
      semanticPagesByCursor: new Map<string | undefined, SemanticPage>([
        [undefined, { results: semanticPage1, has_more: true, next_cursor: "cursor-1" }],
        [
          "cursor-1",
          {
            results: [buildSemanticPage("s-page2-1", "semantic page2 1")],
            has_more: false,
            next_cursor: null,
          },
        ],
      ]),
      yieldOnFirstSemanticPage: false,
    })

    // limit=200 forces semantic to keep paginating past page 1 because
    // accumulated < limit. If abort fired incorrectly, only page 1
    // would land.
    await service.search({
      query: "q",
      mode: "hybrid",
      includeContent: false,
      limit: 200,
    })

    // No abort — semantic paginates through to exhaustion (2 pages).
    expect(searchSpy).toHaveBeenCalledTimes(2)
  })

  it("does not abort when intent is set even if contains would saturate", async () => {
    // Per #17, a non-empty intent disables the saturation cutoff so
    // the intent-augmented semantic lane gets to influence ordering
    // under RRF. Aborting here would silently nullify intent on every
    // query whose contains branch produces 3+ hits — the common case
    // intent exists to fix.
    const semanticPage1 = Array.from({ length: 100 }, (_, i) =>
      buildSemanticPage(`s-page1-${i}`, `semantic page1 ${i}`)
    )
    const { service, searchSpy } = buildHybridSearchTestRig({
      contains: {
        kind: "fulfilled",
        results: [
          buildHybridPage("c-1", "one"),
          buildHybridPage("c-2", "two"),
          buildHybridPage("c-3", "three"),
        ],
      },
      semanticPagesByCursor: new Map<string | undefined, SemanticPage>([
        [undefined, { results: semanticPage1, has_more: true, next_cursor: "cursor-1" }],
        [
          "cursor-1",
          {
            results: [buildSemanticPage("s-page2-1", "semantic page2 1")],
            has_more: false,
            next_cursor: null,
          },
        ],
      ]),
      yieldOnFirstSemanticPage: false,
    })

    await service.search({
      query: "q",
      mode: "hybrid",
      intent: "disambiguator",
      includeContent: false,
      limit: 200,
    })

    // No abort under intent — semantic paginates through to exhaustion.
    expect(searchSpy).toHaveBeenCalledTimes(2)
  })

  it("LORE_DEBUG=1 does NOT log the cooperative abort as a partial-failure", async () => {
    // The abort signal we raise on contains saturation produces an
    // AbortError-shaped rejection on the semantic Promise — but it's
    // a cooperative discard, not a real branch failure. Logging it
    // under LORE_DEBUG=1 would drown the legitimate transient blip
    // signal in operator-issued cancellations on every saturating
    // hybrid call.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const original = process.env["LORE_DEBUG"]
    process.env["LORE_DEBUG"] = "1"
    try {
      const { service, searchSpy } = buildHybridSearchTestRig({
        contains: {
          kind: "fulfilled",
          results: [
            buildHybridPage("c-1", "one"),
            buildHybridPage("c-2", "two"),
            buildHybridPage("c-3", "three"),
          ],
        },
        semanticPagesByCursor: new Map<string | undefined, SemanticPage>([
          [
            undefined,
            {
              results: [buildSemanticPage("s-1", "semantic 1")],
              has_more: true,
              next_cursor: "cursor-1",
            },
          ],
        ]),
        yieldOnFirstSemanticPage: true,
      })

      await service.search({
        query: "q",
        mode: "hybrid",
        includeContent: false,
        limit: 10,
      })

      // Strong assertion: zero `[lore]`-prefixed lines landed at all.
      // The earlier shape of this test asserted only the
      // `source=hybrid-search` filter, which a refactor moving the
      // log line to a different surface (structured logger, prefix
      // change, alternate event marker) would have silently passed.
      // The `[lore]` prefix is the broader greppable contract every
      // hybrid-search log line shares — pinning it catches both the
      // current path and any near-future variant. Two checks, one
      // contract: the prefix-level pin is the strong invariant; the
      // surface-specific pin remains as a localized regression
      // signal.
      const allLines = stderrSpy.mock.calls.map((c) => String(c[0]))
      const loreLines = allLines.filter((l) => l.includes("[lore]"))
      const hybridLines = allLines.filter((l) => l.includes("source=hybrid-search"))
      expect(loreLines).toHaveLength(0)
      expect(hybridLines).toHaveLength(0)
      // Sanity: the abort actually fired (one client.search call).
      expect(searchSpy).toHaveBeenCalledTimes(1)
    } finally {
      stderrSpy.mockRestore()
      if (original === undefined) {
        delete process.env["LORE_DEBUG"]
      } else {
        process.env["LORE_DEBUG"] = original
      }
    }
  })

  it("a contains rejection does NOT abort the semantic branch — semantic completes pagination", async () => {
    // The abort-on-saturation handler must observe contains FULFILLED
    // with a saturating result. A contains rejection is a partial
    // failure that surfaces as zero contains rows — and zero is NOT
    // saturating. Aborting semantic here would convert a recoverable
    // contains-down case into a both-down outage from the caller's
    // perspective.
    const semanticPage1 = Array.from({ length: 100 }, (_, i) =>
      buildSemanticPage(`s-page1-${i}`, `semantic page1 ${i}`)
    )
    const { service, searchSpy } = buildHybridSearchTestRig({
      contains: {
        kind: "rejected",
        reason: new Error("simulated 5xx from dataSources.query"),
      },
      semanticPagesByCursor: new Map<string | undefined, SemanticPage>([
        [undefined, { results: semanticPage1, has_more: true, next_cursor: "cursor-1" }],
        [
          "cursor-1",
          {
            results: [buildSemanticPage("s-page2-1", "semantic page2 1")],
            has_more: false,
            next_cursor: null,
          },
        ],
      ]),
      yieldOnFirstSemanticPage: false,
    })

    // Stub stderr so the partial-failure log doesn't pollute test
    // output (LORE_DEBUG is unset by default in this test, so nothing
    // would write — but defensive against env leakage between tests).
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      await service.search({
        query: "q",
        mode: "hybrid",
        includeContent: false,
        limit: 200,
      })
    } finally {
      stderrSpy.mockRestore()
    }

    // Contains failed; semantic ran to completion across both pages.
    expect(searchSpy).toHaveBeenCalledTimes(2)
  })

  // Helper: every test instantiates the same `MemoryService(client, db)`
  // pair from the mock client. Pulling that construction into one
  // closure avoids a per-test boilerplate line and keeps the test
  // body focused on the contract.
  function buildHybridSearchTestRig(
    opts: Parameters<typeof buildHybridSearchMockClient>[0]
  ): {
    service: MemoryService
    querySpy: ReturnType<typeof vi.fn>
    searchSpy: ReturnType<typeof vi.fn>
  } {
    const { client, querySpy, searchSpy } = buildHybridSearchMockClient(opts)
    return { service: new MemoryService(client, db), querySpy, searchSpy }
  }
})

describe("MemoryService.search — kill switch", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  it("LORE_FORCE_SEMANTIC_SEARCH=1 routes every call through client.search regardless of caller mode", async () => {
    // Operator escape hatch for the rollback story raised in review:
    // if contains under-recalls in a vault that hasn't run
    // `lore migrate --fix-memory-encoding` yet, set this env var to
    // force every search through the legacy workspace-wide path.
    const querySpy = vi.fn(async () => ({
      results: [],
      has_more: false,
      next_cursor: null,
    }))
    const searchSpy = vi.fn(async () => ({ results: [] }))
    const client = {
      dataSources: { query: querySpy },
      search: searchSpy,
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const original = process.env["LORE_FORCE_SEMANTIC_SEARCH"]
    process.env["LORE_FORCE_SEMANTIC_SEARCH"] = "1"
    try {
      await service.search({ query: "q", mode: "contains" })
      await service.search({ query: "q", mode: "hybrid" })
    } finally {
      if (original === undefined) {
        delete process.env["LORE_FORCE_SEMANTIC_SEARCH"]
      } else {
        process.env["LORE_FORCE_SEMANTIC_SEARCH"] = original
      }
    }

    // Both calls routed through client.search, neither touched dataSources.query.
    expect(searchSpy).toHaveBeenCalledTimes(2)
    expect(querySpy).not.toHaveBeenCalled()
  })
})

describe("pageToMemory — partial migration (mixed defaults + real values)", () => {
  it("handles a page that has Kind but not Status (intermediate migration state)", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Half-migrated" }] },
      Kind: { type: "select", select: { name: "runbook" } },
      // Status intentionally absent
    })

    const memory = pageToMemory(page)
    expect(memory.kind).toBe("runbook")
    expect(memory.status).toBe("informational") // default kicks in
    expect(memory.confidence).toBe("certain")
  })

  it("handles a page with Status: null select (column exists, no value chosen)", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Status-cleared" }] },
      Kind: { type: "select", select: { name: "decision" } },
      Status: { type: "select", select: null },
    })

    const memory = pageToMemory(page)
    expect(memory.kind).toBe("decision")
    expect(memory.status).toBe("informational") // null select → fallback
  })

  it("handles a page where date properties exist but are unset", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Dateless" }] },
      "Review By": { type: "date", date: null },
      "Done At": { type: "date", date: null },
      "Decided At": { type: "date", date: null },
      "Last Referenced At": { type: "date", date: null },
    })

    const memory = pageToMemory(page)
    expect(memory.reviewBy).toBeNull()
    expect(memory.doneAt).toBeNull()
    expect(memory.decidedAt).toBeNull()
    expect(memory.lastReferencedAt).toBeNull()
  })
})

describe("MemoryService.list — pagination", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildListPage(id: string, title: string): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
      },
      { id } as Partial<PageObjectResponse>
    )
  }

  function createClient(response: {
    results: PageObjectResponse[]
    has_more?: boolean
    next_cursor?: string | null
  }) {
    const querySpy = vi.fn(async (_args: Record<string, unknown>) => ({
      results: response.results,
      has_more: response.has_more ?? false,
      next_cursor: response.next_cursor ?? null,
    }))
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "body" }))
    return {
      client: {
        dataSources: { query: querySpy },
        pages: { retrieveMarkdown: retrieveMarkdownSpy },
      } as unknown as Client,
      querySpy,
      retrieveMarkdownSpy,
    }
  }

  it("exposes nextCursor when the Notion response reports has_more", async () => {
    const { client } = createClient({
      results: [buildListPage("mem-1", "one")],
      has_more: true,
      next_cursor: "notion-cursor-abc",
    })
    const service = new MemoryService(client, db)

    const { items, nextCursor } = await service.list({
      limit: 1,
      includeContent: false,
    })

    expect(items).toHaveLength(1)
    expect(nextCursor).toBe("notion-cursor-abc")
  })

  it("omits nextCursor when has_more is false (ignoring any stale next_cursor Notion returns)", async () => {
    const { client } = createClient({
      results: [buildListPage("mem-1", "one")],
      has_more: false,
      next_cursor: "should-be-ignored",
    })
    const service = new MemoryService(client, db)

    const { nextCursor } = await service.list({ includeContent: false })

    expect(nextCursor).toBeUndefined()
  })

  it("forwards startCursor to dataSources.query as start_cursor", async () => {
    const { client, querySpy } = createClient({ results: [] })
    const service = new MemoryService(client, db)

    await service.list({ startCursor: "resume-from-here", includeContent: false })

    expect(querySpy.mock.calls[0][0]).toMatchObject({
      start_cursor: "resume-from-here",
    })
  })

  it("adds a Session rich_text filter when session is provided", async () => {
    const { client, querySpy } = createClient({ results: [] })
    const service = new MemoryService(client, db)

    // `includeProposed: true` suppresses the default proposed-status
    // exclusion (issue #281) so this assertion can pin the bare Session
    // filter without an `and:` wrapper.
    await service.list({
      session: "session-1",
      includeContent: false,
      includeProposed: true,
    })

    // The cleanup-orphan exclusion (issue #477) is always appended,
    // so a single-property caller filter lands inside an `and` array
    // rather than as the bare clause.
    expect(querySpy.mock.calls[0][0].filter).toEqual({
      and: [
        { property: "Session", rich_text: { equals: "session-1" } },
        {
          property: "Keywords",
          rich_text: { does_not_contain: "__lore-cleanup-orphan" },
        },
      ],
    })
  })

  it("adds a Confidence select filter when confidence is provided", async () => {
    const { client, querySpy } = createClient({ results: [] })
    const service = new MemoryService(client, db)

    await service.list({
      confidence: "likely",
      includeContent: false,
      includeProposed: true,
    })

    expect(querySpy.mock.calls[0][0].filter).toEqual({
      and: [
        { property: "Confidence", select: { equals: "likely" } },
        {
          property: "Keywords",
          rich_text: { does_not_contain: "__lore-cleanup-orphan" },
        },
      ],
    })
  })
})

// ---------------------------------------------------------------------------
// Default-recall proposed-status exclusion (issue #281, AC #2)
// ---------------------------------------------------------------------------

describe("MemoryService.list — default-excludes review-terminal statuses", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  it("emits Status does_not_equal clauses for both proposed and rejected by default", async () => {
    // Phase 4 of issue #281 broadened the default-exclude from
    // `Status = proposed` to the review-terminal pair (`proposed` +
    // `rejected`). Without this, a `lore inbox reject <id>` flips
    // the row to `rejected` but leaves it eligible for default
    // recall.
    const query = vi
      .fn()
      .mockResolvedValueOnce({ results: [], has_more: false, next_cursor: null })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.list({ includeContent: false })

    expect(query).toHaveBeenCalledTimes(1)
    // The cleanup-orphan exclusion (issue #477) is always appended.
    // The default Status != proposed clause was a single-property
    // filter pre-#477; it is now wrapped in `and: [..., sentinel]`.
    expect(query.mock.calls[0]![0].filter).toEqual({
      and: [
        { property: "Status", select: { does_not_equal: "proposed" } },
        { property: "Status", select: { does_not_equal: "rejected" } },
        {
          property: "Keywords",
          rich_text: { does_not_contain: "__lore-cleanup-orphan" },
        },
      ],
    })
  })

  it("suppresses the default Status exclusion when includeProposed is true (cleanup-orphan exclusion still applies)", async () => {
    // Pre-issue-477 this was `filter: undefined`. The cleanup-orphan
    // exclusion is independent of `includeProposed` — it filters
    // resurfaced empty-body shells, not proposed-status memories — so
    // it remains present even under the includeProposed opt-in.
    const query = vi
      .fn()
      .mockResolvedValueOnce({ results: [], has_more: false, next_cursor: null })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.list({ includeContent: false, includeProposed: true })

    expect(query.mock.calls[0]![0].filter).toEqual({
      property: "Keywords",
      rich_text: { does_not_contain: "__lore-cleanup-orphan" },
    })
  })

  it("explicit status: 'proposed' wins over the default exclusion", async () => {
    // The inbox-review path passes `status: "proposed"` to surface the
    // very rows the default exclusion would otherwise hide. The
    // explicit equals filter must short-circuit the default
    // does_not_equal clauses — they cannot both be in the filter. The
    // cleanup-orphan exclusion (issue #477) is independent and still
    // applies.
    const query = vi
      .fn()
      .mockResolvedValueOnce({ results: [], has_more: false, next_cursor: null })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.list({ status: "proposed", includeContent: false })

    expect(query.mock.calls[0]![0].filter).toEqual({
      and: [
        { property: "Status", select: { equals: "proposed" } },
        {
          property: "Keywords",
          rich_text: { does_not_contain: "__lore-cleanup-orphan" },
        },
      ],
    })
  })

  it("explicit status: 'rejected' surfaces the audit path without re-triggering the exclusion", async () => {
    // The audit path (`lore inbox audit --status rejected`, a future
    // tooling surface) must be able to surface rejected rows via
    // explicit-status opt-in. Pinning that the explicit filter
    // short-circuits the default-exclude branch. The cleanup-orphan
    // exclusion (issue #477) is independent and still applies.
    const query = vi
      .fn()
      .mockResolvedValueOnce({ results: [], has_more: false, next_cursor: null })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.list({ status: "rejected", includeContent: false })

    expect(query.mock.calls[0]![0].filter).toEqual({
      and: [
        { property: "Status", select: { equals: "rejected" } },
        {
          property: "Keywords",
          rich_text: { does_not_contain: "__lore-cleanup-orphan" },
        },
      ],
    })
  })

  it("composes the exclusion with project scope under an `and:` wrapper", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ results: [], has_more: false, next_cursor: null })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.list({ projectId: "p1", includeContent: false })

    // Three-clause `and:`: project scope + Status != proposed
    // (issue #281) + Keywords does_not_contain sentinel (issue #477).
    expect(query.mock.calls[0]![0].filter).toEqual({
      and: [
        {
          or: [
            { property: "Project", relation: { contains: "p1" } },
            { property: "Project", relation: { is_empty: true } },
          ],
        },
        { property: "Status", select: { does_not_equal: "proposed" } },
        { property: "Status", select: { does_not_equal: "rejected" } },
        {
          property: "Keywords",
          rich_text: { does_not_contain: "__lore-cleanup-orphan" },
        },
      ],
    })
  })
})

describe("MemoryService.search — default-excludes Status = proposed (contains)", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  it("contains mode emits the does_not_equal proposed clause by default", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ results: [], has_more: false, next_cursor: null })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.search({ query: "foo", mode: "contains" })

    const filter = query.mock.calls[0]![0].filter as { and: Array<unknown> }
    expect(filter.and).toEqual(
      expect.arrayContaining([
        { property: "Status", select: { does_not_equal: "proposed" } },
      ]),
    )
  })

  it("contains mode suppresses the exclusion under includeProposed: true", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ results: [], has_more: false, next_cursor: null })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.search({ query: "foo", mode: "contains", includeProposed: true })

    const filter = query.mock.calls[0]![0].filter as { and?: Array<unknown> } | undefined
    const serialized = JSON.stringify(filter)
    expect(serialized).not.toContain("does_not_equal")
  })
})

describe("MemoryService.queryStaleConfidence — default-excludes Status = proposed", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  it("includes the does_not_equal proposed clause by default", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ results: [], has_more: false, next_cursor: null })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.queryStaleConfidence({ limit: 5, today: "2026-05-03" })

    const filter = query.mock.calls[0]![0].filter as { and: Array<unknown> }
    expect(filter.and).toEqual(
      expect.arrayContaining([
        { property: "Status", select: { does_not_equal: "proposed" } },
      ]),
    )
  })

  it("suppresses the exclusion under includeProposed: true", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ results: [], has_more: false, next_cursor: null })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.queryStaleConfidence({
      limit: 5,
      today: "2026-05-03",
      includeProposed: true,
    })

    const filter = query.mock.calls[0]![0].filter as { and: Array<unknown> }
    const serialized = JSON.stringify(filter)
    expect(serialized).not.toContain("does_not_equal")
  })
})

describe("MemoryService.list — excludeKinds (issue #281)", () => {
  // Pin the per-kind `does_not_equal` clauses emitted by the
  // `excludeKinds` parameter. The wake-up Proposed Memories slice and
  // `lore inbox list` rely on this knob to mirror
  // `proposedMemoryFilter()`'s `Kind != decision` half. Without this
  // unit test, a future refactor that swaps the per-kind loop for an
  // unsupported `not_in` operator (or drops the loop entirely) would
  // slip past the indirect end-to-end coverage.
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  it("emits one Status / Kind clause per excluded kind", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ results: [], has_more: false, next_cursor: null })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.list({
      includeContent: false,
      includeProposed: true,
      excludeKinds: ["decision"],
    })

    expect(query).toHaveBeenCalledTimes(1)
    // The cleanup-orphan exclusion (issue #477) is always appended,
    // so a single excludeKinds clause lands inside `and:` alongside
    // the sentinel exclusion.
    expect(query.mock.calls[0]![0].filter).toEqual({
      and: [
        { property: "Kind", select: { does_not_equal: "decision" } },
        {
          property: "Keywords",
          rich_text: { does_not_contain: "__lore-cleanup-orphan" },
        },
      ],
    })
  })

  it("emits separate clauses for two excluded kinds (Notion select has no not_in operator)", async () => {
    // Pinned because the per-kind loop at `MemoryService.list` is the
    // load-bearing detail — Notion's select filter doesn't support
    // `not_in`, so each excluded kind needs its own clause. A future
    // refactor that swaps the loop for an unsupported `not_in` would
    // silently match nothing.
    const query = vi
      .fn()
      .mockResolvedValueOnce({ results: [], has_more: false, next_cursor: null })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.list({
      includeContent: false,
      includeProposed: true,
      excludeKinds: ["decision", "task"],
    })

    // Three-clause `and:`: per-kind exclusions + cleanup-orphan
    // exclusion (issue #477).
    expect(query.mock.calls[0]![0].filter).toEqual({
      and: [
        { property: "Kind", select: { does_not_equal: "decision" } },
        { property: "Kind", select: { does_not_equal: "task" } },
        {
          property: "Keywords",
          rich_text: { does_not_contain: "__lore-cleanup-orphan" },
        },
      ],
    })
  })

  it("treats an empty excludeKinds array as a no-op (cleanup-orphan exclusion still applies)", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ results: [], has_more: false, next_cursor: null })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.list({
      includeContent: false,
      includeProposed: true,
      excludeKinds: [],
    })

    // Pre-issue-477 this was `filter: undefined`. The cleanup-orphan
    // exclusion is always present so a vault-wide unscoped query
    // doesn't surface empty-body shells from the partial-failure path.
    expect(query.mock.calls[0]![0].filter).toEqual({
      property: "Keywords",
      rich_text: { does_not_contain: "__lore-cleanup-orphan" },
    })
  })
})

describe("MemoryService.list — archived filter", () => {
  // Pins the archived post-filter — see `MemoryService.list` for the rationale.
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildListPage(
    id: string,
    title: string,
    overrides: Partial<PageObjectResponse> = {}
  ): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
        Tags: { type: "multi_select", multi_select: [] },
      },
      { id, ...overrides } as Partial<PageObjectResponse>
    )
  }

  function createClient(response: {
    results: PageObjectResponse[]
    has_more?: boolean
    next_cursor?: string | null
  }) {
    const querySpy = vi.fn(async (_args: Record<string, unknown>) => ({
      results: response.results,
      has_more: response.has_more ?? false,
      next_cursor: response.next_cursor ?? null,
    }))
    const retrieveMarkdownSpy = vi.fn(async (args: { page_id: string }) => ({
      markdown: `body for ${args.page_id}`,
    }))
    return {
      client: {
        dataSources: { query: querySpy },
        pages: { retrieveMarkdown: retrieveMarkdownSpy },
      } as unknown as Client,
      querySpy,
      retrieveMarkdownSpy,
    }
  }

  it("excludes archived rows in includeContent: false mode", async () => {
    const { client } = createClient({
      results: [
        buildListPage("mem-live", "live one"),
        buildListPage("mem-archived", "archived one", { archived: true }),
      ],
    })
    const service = new MemoryService(client, db)

    const { items } = await service.list({ includeContent: false })

    expect(items).toHaveLength(1)
    expect(items[0].id).toBe("mem-live")
  })

  it("excludes archived rows in default content-hydrating mode and skips their markdown fetch", async () => {
    // Filtering BEFORE the per-page `retrieveMarkdown` fan-out matters:
    // a soft-deleted vault should not pay N+1 round-trips for rows the
    // caller will never see.
    const { client, retrieveMarkdownSpy } = createClient({
      results: [
        buildListPage("mem-live", "live one"),
        buildListPage("mem-archived", "archived one", { archived: true }),
      ],
    })
    const service = new MemoryService(client, db)

    const { items } = await service.list()

    expect(items).toHaveLength(1)
    expect(items[0].id).toBe("mem-live")
    expect(retrieveMarkdownSpy).toHaveBeenCalledTimes(1)
    expect(retrieveMarkdownSpy).toHaveBeenCalledWith({ page_id: "mem-live" })
  })

  it("continues past an all-archived page before returning live rows", async () => {
    const querySpy = vi
      .fn()
      .mockResolvedValueOnce({
        results: [buildListPage("mem-archived", "archived one", { archived: true })],
        has_more: true,
        next_cursor: "notion-cursor-after-archived-page",
      })
      .mockResolvedValueOnce({
        results: [buildListPage("mem-live", "live one")],
        has_more: false,
        next_cursor: null,
      })
    const client = {
      dataSources: { query: querySpy },
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "body" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { items, nextCursor } = await service.list({
      limit: 1,
      includeContent: false,
    })

    expect(items.map((item) => item.id)).toEqual(["mem-live"])
    expect(nextCursor).toBeUndefined()
    expect(querySpy).toHaveBeenCalledTimes(2)
    expect(querySpy.mock.calls[1][0].start_cursor).toBe(
      "notion-cursor-after-archived-page"
    )
  })

  it("refills list results past archived rows across pages", async () => {
    const querySpy = vi
      .fn()
      .mockResolvedValueOnce({
        results: [
          buildListPage("mem-archived-before", "archived before", { archived: true }),
          buildListPage("mem-live-1", "live one"),
          buildListPage("mem-archived-between", "archived between", {
            archived: true,
          }),
        ],
        has_more: true,
        next_cursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        results: [
          buildListPage("mem-live-2", "live two"),
          buildListPage("mem-archived-after", "archived after", { archived: true }),
        ],
        has_more: true,
        next_cursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        results: [buildListPage("mem-live-3", "live three")],
        has_more: false,
        next_cursor: null,
      })
    const client = {
      dataSources: { query: querySpy },
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "body" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const { items, nextCursor } = await service.list({
      limit: 3,
      includeContent: false,
    })

    expect(items.map((item) => item.id)).toEqual([
      "mem-live-1",
      "mem-live-2",
      "mem-live-3",
    ])
    expect(nextCursor).toBeUndefined()
    expect(querySpy).toHaveBeenCalledTimes(3)
    expect(querySpy.mock.calls[1][0].start_cursor).toBe("cursor-1")
    expect(querySpy.mock.calls[2][0].start_cursor).toBe("cursor-2")
    expect(querySpy.mock.calls[0][0].page_size).toBe(100)
    expect(querySpy.mock.calls[1][0].page_size).toBe(100)
    expect(querySpy.mock.calls[2][0].page_size).toBe(100)
  })

  it("returns an opaque refill cursor instead of skipping live rows from a partially consumed page", async () => {
    const querySpy = vi.fn(async ({ start_cursor }: Record<string, unknown>) => {
      if (start_cursor === undefined) {
        return {
          results: [
            buildListPage("mem-live-1", "live one"),
            buildListPage("mem-live-2", "live two"),
            buildListPage("mem-live-3", "live three"),
            buildListPage("mem-live-4", "live four"),
          ],
          has_more: true,
          next_cursor: "notion-cursor-after-current-page",
        }
      }
      return {
        results: [buildListPage("mem-live-5", "live five")],
        has_more: false,
        next_cursor: null,
      }
    })
    const client = {
      dataSources: { query: querySpy },
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "body" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const first = await service.list({ limit: 2, includeContent: false })
    const second = await service.list({
      limit: 2,
      includeContent: false,
      startCursor: first.nextCursor,
    })

    expect(first.items.map((item) => item.id)).toEqual(["mem-live-1", "mem-live-2"])
    expect(first.nextCursor).toBeDefined()
    expect(first.nextCursor).not.toBe("notion-cursor-after-current-page")
    expect(second.items.map((item) => item.id)).toEqual(["mem-live-3", "mem-live-4"])
    expect(second.nextCursor).toBe("notion-cursor-after-current-page")
    expect(querySpy).toHaveBeenCalledTimes(2)
    expect(querySpy.mock.calls[1][0].start_cursor).toBeUndefined()
  })

  it("bounds refill walks and logs when the cap fires before saturation", async () => {
    const querySpy = vi.fn(async () => ({
      results: [buildListPage("mem-archived", "archived", { archived: true })],
      has_more: true,
      next_cursor: "more-archived",
    }))
    const client = {
      dataSources: { query: querySpy },
      pages: { retrieveMarkdown: vi.fn(async () => ({ markdown: "body" })) },
    } as unknown as Client
    const service = new MemoryService(client, db)
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const original = process.env["LORE_DEBUG"]
    process.env["LORE_DEBUG"] = "1"
    try {
      const { items, nextCursor, capped } = await service.list({
        limit: 3,
        includeContent: false,
      })

      expect(items).toEqual([])
      expect(nextCursor).toBe("more-archived")
      expect(capped).toBe(true)
      expect(querySpy).toHaveBeenCalledTimes(5)
      const lines = stderrSpy.mock.calls.map((call) => String(call[0]))
      expect(lines.some((line) => line.includes("live-page-refill-cap-fired"))).toBe(true)
      expect(lines.some((line) => line.includes("source=MemoryService.list"))).toBe(true)
    } finally {
      stderrSpy.mockRestore()
      if (original === undefined) {
        delete process.env["LORE_DEBUG"]
      } else {
        process.env["LORE_DEBUG"] = original
      }
    }
  })
})

describe("MemoryService.create — HTML entity decode at write", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  type CreateArgs = {
    properties: {
      Title: { title: Array<{ text: { content: string } }> }
    }
  }
  type UpdateMarkdownArgs = { insert_content: { content: string } }

  it("decodes doubly-encoded title and content before writing to Notion", async () => {
    const createSpy = vi.fn(async (_args: CreateArgs) =>
      buildPage(
        { Title: { type: "title", title: [{ plain_text: "PR #25650's diff" }] } },
        { id: "mem-1" }
      )
    )
    const updateMarkdownSpy = vi.fn(async (_args: UpdateMarkdownArgs) => ({}))
    const client = {
      pages: { create: createSpy, updateMarkdown: updateMarkdownSpy },
    } as unknown as Client

    const service = new MemoryService(client, db)
    await service.create({
      title: "PR #25650&amp;#8217;s diff",
      content: "Fix the &amp;amp; in build logs",
    })

    const createArgs = createSpy.mock.calls[0][0]
    // `&amp;#8217;` collapses to `&#8217;` and then to the curly right single
    // quote ’ — the fixed-point loop keeps decoding until stable.
    expect(createArgs.properties.Title.title[0].text.content).toBe("PR #25650’s diff")

    const mdArgs = updateMarkdownSpy.mock.calls[0][0]
    expect(mdArgs.insert_content.content).toBe("Fix the & in build logs")
  })

  it("is idempotent — clean input passes through unchanged", async () => {
    const createSpy = vi.fn(async (_args: CreateArgs) =>
      buildPage(
        { Title: { type: "title", title: [{ plain_text: "Clean title" }] } },
        { id: "mem-2" }
      )
    )
    const updateMarkdownSpy = vi.fn(async (_args: UpdateMarkdownArgs) => ({}))
    const client = {
      pages: { create: createSpy, updateMarkdown: updateMarkdownSpy },
    } as unknown as Client

    const service = new MemoryService(client, db)
    await service.create({
      title: "Clean title",
      content: "Body with a literal & character",
    })

    const createArgs = createSpy.mock.calls[0][0]
    expect(createArgs.properties.Title.title[0].text.content).toBe("Clean title")
    const mdArgs = updateMarkdownSpy.mock.calls[0][0]
    expect(mdArgs.insert_content.content).toBe("Body with a literal & character")
  })

  it("decodes every rich_text field — alternatives, consequences, author, agent, keywords, session", async () => {
    // P3-03 (entity canonicalization) will read `author`/`agent` for
    // normalization; P2-03 (near-duplicate detection) will trigram over
    // `alternatives`/`consequences`/`keywords`. All of them flow through
    // the same autosave encoder as `title`, so decode them at the write
    // boundary too. `session` is included for consistency — unlikely to
    // carry encoded content in practice, but cheap to decode and keeps
    // the rich_text coverage exhaustive.
    type FullCreateArgs = {
      properties: {
        Title: { title: Array<{ text: { content: string } }> }
        Alternatives: { rich_text: Array<{ text: { content: string } }> }
        Consequences: { rich_text: Array<{ text: { content: string } }> }
        Author: { rich_text: Array<{ text: { content: string } }> }
        Agent: { rich_text: Array<{ text: { content: string } }> }
        Keywords: { rich_text: Array<{ text: { content: string } }> }
        Synopsis: { rich_text: Array<{ text: { content: string } }> }
        Session: { rich_text: Array<{ text: { content: string } }> }
      }
    }
    const createSpy = vi.fn(async (_args: FullCreateArgs) =>
      buildPage(
        { Title: { type: "title", title: [{ plain_text: "T" }] } },
        { id: "mem-3" }
      )
    )
    const updateMarkdownSpy = vi.fn(async (_args: UpdateMarkdownArgs) => ({}))
    const client = {
      pages: { create: createSpy, updateMarkdown: updateMarkdownSpy },
    } as unknown as Client

    const service = new MemoryService(client, db)
    await service.create({
      title: "Encoded &amp; title",
      content: "body",
      alternatives: "Alt A &amp; Alt B",
      consequences: "Cost: &amp;amp; risk",
      author: "name &amp; co",
      agent: "tool &amp; script",
      keywords: "PR &amp; branch",
      synopsis: "Foo &amp;amp; Bar",
      session: "sess-&amp;-123",
    })

    const p = createSpy.mock.calls[0][0].properties
    expect(p.Title.title[0].text.content).toBe("Encoded & title")
    expect(p.Alternatives.rich_text[0].text.content).toBe("Alt A & Alt B")
    expect(p.Consequences.rich_text[0].text.content).toBe("Cost: & risk")
    expect(p.Author.rich_text[0].text.content).toBe("name & co")
    expect(p.Agent.rich_text[0].text.content).toBe("tool & script")
    expect(p.Keywords.rich_text[0].text.content).toBe("PR & branch")
    expect(p.Synopsis.rich_text[0].text.content).toBe("Foo & Bar")
    expect(p.Session.rich_text[0].text.content).toBe("sess-&-123")
  })
})

describe("MemoryService.update — HTML entity decode at write", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  it("decodes title, content, and rich_text fields on update — parallels create", async () => {
    // Reviewer concern: without this, `update` would write encoded text
    // around the freshly-decoded rows `create` produces. Same autosave
    // path can re-encode values on subsequent saves, so the `update`
    // write boundary must also decode.
    type FullUpdateArgs = {
      properties: {
        Title?: { title: Array<{ text: { content: string } }> }
        Alternatives?: { rich_text: Array<{ text: { content: string } }> }
        Consequences?: { rich_text: Array<{ text: { content: string } }> }
        Keywords?: { rich_text: Array<{ text: { content: string } }> }
        Synopsis?: { rich_text: Array<{ text: { content: string } }> }
      }
    }
    const updateSpy = vi.fn(async (_args: FullUpdateArgs) => ({}))
    const updateMarkdownSpy = vi.fn(
      async (_args: { replace_content: { new_str: string } }) => ({})
    )
    const retrieveSpy = vi.fn(async () =>
      buildPage(
        {
          Title: { type: "title", title: [{ plain_text: "Updated" }] },
          Project: { type: "relation", relation: [] },
          Topic: { type: "relation", relation: [] },
          Source: { type: "select", select: { name: "manual" } },
        },
        { id: "mem-1" }
      )
    )
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "" }))
    const client = {
      pages: {
        update: updateSpy,
        updateMarkdown: updateMarkdownSpy,
        retrieve: retrieveSpy,
        retrieveMarkdown: retrieveMarkdownSpy,
      },
    } as unknown as Client

    const service = new MemoryService(client, db)
    await service.update("mem-1", {
      title: "Updated &amp; saved",
      content: "Body &amp; body",
      alternatives: "Alt &amp; Alt",
      consequences: "Cons &amp; cons",
      keywords: "PR &amp; branch",
      synopsis: "Synopsis &amp; cause",
    })

    const props = updateSpy.mock.calls[0][0].properties
    expect(props.Title?.title[0].text.content).toBe("Updated & saved")
    expect(props.Alternatives?.rich_text[0].text.content).toBe("Alt & Alt")
    expect(props.Consequences?.rich_text[0].text.content).toBe("Cons & cons")
    expect(props.Keywords?.rich_text[0].text.content).toBe("PR & branch")
    expect(props.Synopsis?.rich_text[0].text.content).toBe("Synopsis & cause")

    const mdArgs = updateMarkdownSpy.mock.calls[0][0]
    expect(mdArgs.replace_content.new_str).toBe("Body & body")
  })

  it("emits an empty Synopsis when explicitly cleared, omits when undefined", async () => {
    type SynopsisOnlyUpdateArgs = {
      properties: {
        Synopsis?: { rich_text: Array<{ text: { content: string } }> }
      }
    }
    const updateSpy = vi.fn(async (_args: SynopsisOnlyUpdateArgs) => ({}))
    const retrieveSpy = vi.fn(async () =>
      buildPage(
        {
          Title: { type: "title", title: [{ plain_text: "T" }] },
          Project: { type: "relation", relation: [] },
          Topic: { type: "relation", relation: [] },
          Source: { type: "select", select: { name: "manual" } },
        },
        { id: "mem-1" }
      )
    )
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "" }))
    const client = {
      pages: {
        update: updateSpy,
        retrieve: retrieveSpy,
        retrieveMarkdown: retrieveMarkdownSpy,
      },
    } as unknown as Client

    const service = new MemoryService(client, db)

    // Empty string clears the property — `undefined` would skip emission.
    await service.update("mem-1", { synopsis: "" })
    const cleared = updateSpy.mock.calls[0][0].properties
    expect(cleared.Synopsis).toBeDefined()
    expect(cleared.Synopsis?.rich_text[0].text.content).toBe("")

    // No synopsis arg → no Synopsis key in the update properties.
    await service.update("mem-1", { keywords: "leave synopsis alone" })
    const untouched = updateSpy.mock.calls[1][0].properties
    expect("Synopsis" in untouched).toBe(false)
  })
})

describe("MemoryService.getTitleById — title cache", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function titlePage(id: string, title: string): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: title }] },
        Project: { type: "relation", relation: [] },
        Topic: { type: "relation", relation: [] },
        Source: { type: "select", select: { name: "manual" } },
      },
      { id, parent: { type: "database_id", database_id: db.databaseId } }
    )
  }

  function buildApiError(code: APIErrorCode, status: number): APIResponseError {
    return new APIResponseError({
      code,
      status,
      message: code,
      headers: new Headers(),
      rawBodyText: `{"code":"${code}","message":"${code}"}`,
      additional_data: undefined,
      request_id: undefined,
    })
  }

  it("skips the Notion call on repeat reads within the TTL window", async () => {
    const retrieveSpy = vi.fn(async ({ page_id }: { page_id: string }) =>
      titlePage(page_id, "Cached title")
    )
    const client = { pages: { retrieve: retrieveSpy } } as unknown as Client
    const service = new MemoryService(client, db)

    const first = await service.getTitleById("mem-1")
    const second = await service.getTitleById("mem-1")

    expect(first).toBe("Cached title")
    expect(second).toBe("Cached title")
    expect(retrieveSpy).toHaveBeenCalledTimes(1)
  })

  it("collapses concurrent cold-start misses onto a single retrieve", async () => {
    const retrieveSpy = vi.fn(async ({ page_id }: { page_id: string }) => {
      await new Promise((r) => setTimeout(r, 5))
      return titlePage(page_id, "Once")
    })
    const client = { pages: { retrieve: retrieveSpy } } as unknown as Client
    const service = new MemoryService(client, db)

    const values = await Promise.all([
      service.getTitleById("mem-1"),
      service.getTitleById("mem-1"),
      service.getTitleById("mem-1"),
      service.getTitleById("mem-1"),
    ])

    expect(values).toEqual(["Once", "Once", "Once", "Once"])
    expect(retrieveSpy).toHaveBeenCalledTimes(1)
  })

  it("evicts on update so a subsequent read sees the new title", async () => {
    let currentTitle = "Old"
    const retrieveSpy = vi.fn(async ({ page_id }: { page_id: string }) =>
      titlePage(page_id, currentTitle)
    )
    const updateSpy = vi.fn(async () => {
      currentTitle = "New"
      return titlePage("mem-1", "New")
    })
    const markdownSpy = vi.fn(async () => ({ markdown: "" }))
    const client = {
      pages: {
        retrieve: retrieveSpy,
        update: updateSpy,
        retrieveMarkdown: markdownSpy,
        updateMarkdown: vi.fn(async () => ({})),
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    expect(await service.getTitleById("mem-1")).toBe("Old")
    await service.update("mem-1", { title: "New" })
    // The cache was evicted before the update write, so this read goes
    // back to Notion and picks up the post-update state.
    expect(await service.getTitleById("mem-1")).toBe("New")
  })

  it("caches a null tombstone after archive so subsequent reads issue zero Notion calls", async () => {
    // Reviewer concern: Notion returns archived pages as full
    // PageObjectResponse with `archived: true` and every property
    // populated (including Title). A lazy evict-only implementation would
    // re-fetch after archive and `extractTitle` would happily read the
    // archived title — a real-world bug the earlier test missed by
    // faking the post-archive shape as a throw.
    //
    // The correct behaviour: `archive()` installs a null tombstone in
    // the cache, so the next `getTitleById` short-circuits without a
    // network call at all.
    const retrieveSpy = vi.fn(async ({ page_id }: { page_id: string }) =>
      titlePage(page_id, "Before")
    )
    const updateSpy = vi.fn(async () => ({}))
    const client = {
      pages: { retrieve: retrieveSpy, update: updateSpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    expect(await service.getTitleById("mem-1")).toBe("Before")
    const beforeArchiveCalls = retrieveSpy.mock.calls.length

    await service.archive("mem-1")

    expect(await service.getTitleById("mem-1")).toBeNull()
    // Zero additional fetches after archive — the tombstone cached at
    // archive time short-circuits the read path.
    expect(retrieveSpy.mock.calls.length).toBe(beforeArchiveCalls)
  })

  it("caches a null tombstone when the underlying page is archived at fetch time", async () => {
    // The faithful Notion semantic: archived pages return a full
    // PageObjectResponse with `archived: true` and a populated title.
    // `getTitleById` must treat that as absent and return null without
    // reading the Title property — otherwise we'd serve titles for
    // pages the user has explicitly archived.
    const archivedPage = buildPage(
      { Title: { type: "title", title: [{ plain_text: "Archived title" }] } },
      { id: "mem-1", archived: true }
    )
    const retrieveSpy = vi.fn(async () => archivedPage)
    const client = {
      pages: { retrieve: retrieveSpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    expect(await service.getTitleById("mem-1")).toBeNull()
    // Second call hits the tombstone — zero additional fetches.
    expect(await service.getTitleById("mem-1")).toBeNull()
    expect(retrieveSpy).toHaveBeenCalledTimes(1)
  })

  it("does not cache transient errors — next caller retries", async () => {
    // Rate-limit blip and network error paths must NOT install a
    // tombstone, or a 60-second TTL window would degrade every render
    // of the affected ID to `(?)`. The next caller must retry.
    const retrieveSpy = vi
      .fn<(args: { page_id: string }) => Promise<PageObjectResponse>>()
      .mockImplementationOnce(async () => {
        throw new Error("transient 429")
      })
      .mockImplementationOnce(async ({ page_id }) => titlePage(page_id, "Recovered"))
    const client = {
      pages: { retrieve: retrieveSpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    expect(await service.getTitleById("mem-1")).toBeNull()
    // Second call runs the loader again — no poisoned tombstone.
    expect(await service.getTitleById("mem-1")).toBe("Recovered")
    expect(retrieveSpy).toHaveBeenCalledTimes(2)
  })

  it("does not cache real 429 (rate_limited) — next caller retries", async () => {
    // The SDK-shaped variant of the transient-errors guard: an
    // `APIResponseError` with `code: rate_limited` must NOT tombstone.
    // The bare-catch implementation collapsed every catch into the same
    // uncached null; the discriminated catch must keep the rate-limit
    // case in the transient bucket.
    const retrieveSpy = vi
      .fn<(args: { page_id: string }) => Promise<PageObjectResponse>>()
      .mockImplementationOnce(async () => {
        throw buildApiError(APIErrorCode.RateLimited, 429)
      })
      .mockImplementationOnce(async ({ page_id }) => titlePage(page_id, "Recovered"))
    const client = {
      pages: { retrieve: retrieveSpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    expect(await service.getTitleById("mem-1")).toBeNull()
    expect(await service.getTitleById("mem-1")).toBe("Recovered")
    expect(retrieveSpy).toHaveBeenCalledTimes(2)
  })

  it("caches a null tombstone when retrieve throws object_not_found", async () => {
    // The acceptance criterion for issue #478. A genuinely-deleted id
    // (the SDK throws `APIResponseError` with `code: object_not_found`)
    // must install a tombstone so the next wake-up over the same id
    // set issues zero retrieves on the dead id.
    //
    // The pre-fix bare `catch` collapsed 404 / 401 / 403 / 429 / 5xx
    // into a single uncached-null return; every wake-up then re-issued
    // `pages.retrieve` for every dead id, paced by the 3 rps token
    // bucket.
    const retrieveSpy = vi.fn(async () => {
      throw buildApiError(APIErrorCode.ObjectNotFound, 404)
    })
    const client = { pages: { retrieve: retrieveSpy } } as unknown as Client
    const service = new MemoryService(client, db)

    expect(await service.getTitleById("mem-gone")).toBeNull()
    // Second call hits the tombstone — zero additional fetches.
    expect(await service.getTitleById("mem-gone")).toBeNull()
    expect(retrieveSpy).toHaveBeenCalledTimes(1)
  })

  it("caches a null tombstone when retrieve throws restricted_resource", async () => {
    // 403 / restricted_resource: the page exists but the integration
    // does not have access. From the caller's perspective this id is
    // permanently absent until the operator changes the share grant —
    // tombstoning is correct.
    const retrieveSpy = vi.fn(async () => {
      throw buildApiError(APIErrorCode.RestrictedResource, 403)
    })
    const client = { pages: { retrieve: retrieveSpy } } as unknown as Client
    const service = new MemoryService(client, db)

    expect(await service.getTitleById("mem-restricted")).toBeNull()
    expect(await service.getTitleById("mem-restricted")).toBeNull()
    expect(retrieveSpy).toHaveBeenCalledTimes(1)
  })

  it("does not cache unauthorized (401) — next caller retries after auth recovers", async () => {
    // 401 / unauthorized is a broad token-level signal, not a per-page
    // absence signal: the SDK wrapper at
    // `src/notion/client.ts:isUnauthorizedError` already attempts one
    // auth refresh on 401 and only surfaces the error when refresh is
    // unavailable / unchanged or the retried request is still 401.
    //
    // If we tombstoned 401s, a temporary bad-token window would poison
    // every id resolved during a wake-up render pass for up to 60s
    // after the operator fixes auth. Stay on the transient path so the
    // next call re-attempts and surfaces the now-recovered title.
    const retrieveSpy = vi
      .fn<(args: { page_id: string }) => Promise<PageObjectResponse>>()
      .mockImplementationOnce(async () => {
        throw buildApiError(APIErrorCode.Unauthorized, 401)
      })
      .mockImplementationOnce(async ({ page_id }) => titlePage(page_id, "Recovered"))
    const client = { pages: { retrieve: retrieveSpy } } as unknown as Client
    const service = new MemoryService(client, db)

    expect(await service.getTitleById("mem-no-auth")).toBeNull()
    expect(await service.getTitleById("mem-no-auth")).toBe("Recovered")
    expect(retrieveSpy).toHaveBeenCalledTimes(2)
  })

  it("tombstones expire on TTL — restored ids re-fetch after 60s", async () => {
    // Defense against a future drive-by that "optimizes" tombstones
    // into a separate `Set<string>` of dead ids without TTL — that
    // refactor would silently re-introduce a permanent-tombstone
    // failure mode for ids that were genuinely 404 at first read but
    // restored before the next render. The current `LruCache` shares
    // `expiresAt` semantics across `null` and `string` values, so this
    // test pins that the tombstone respects the same 60s TTL as a
    // resolved title.
    vi.useFakeTimers()
    try {
      let throwOnNextCall = true
      const retrieveSpy = vi.fn(async ({ page_id }: { page_id: string }) => {
        if (throwOnNextCall) {
          throwOnNextCall = false
          throw buildApiError(APIErrorCode.ObjectNotFound, 404)
        }
        return titlePage(page_id, "Restored")
      })
      const client = { pages: { retrieve: retrieveSpy } } as unknown as Client
      const service = new MemoryService(client, db)

      // First read tombstones; second read inside the TTL window hits
      // the cache and issues no fetch.
      expect(await service.getTitleById("mem-1")).toBeNull()
      expect(await service.getTitleById("mem-1")).toBeNull()
      expect(retrieveSpy).toHaveBeenCalledTimes(1)

      // Advance past the 60s TTL — the tombstone expires and the next
      // read re-fetches, surfacing the restored title.
      vi.advanceTimersByTime(61_000)

      expect(await service.getTitleById("mem-1")).toBe("Restored")
      expect(retrieveSpy).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("re-fetches after TTL expiry", async () => {
    // Spec acceptance criterion: TTL expiry re-fetches. Pins that the
    // cache isn't accidentally holding values forever.
    vi.useFakeTimers()
    try {
      const retrieveSpy = vi.fn(async ({ page_id }: { page_id: string }) =>
        titlePage(page_id, "T")
      )
      const client = {
        pages: { retrieve: retrieveSpy },
      } as unknown as Client
      const service = new MemoryService(client, db)

      expect(await service.getTitleById("mem-1")).toBe("T")
      expect(retrieveSpy).toHaveBeenCalledTimes(1)

      // Advance past the 60s TTL.
      vi.advanceTimersByTime(61_000)

      expect(await service.getTitleById("mem-1")).toBe("T")
      expect(retrieveSpy).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("25-UUID repeat wake-up (24 present + 1 archived) issues zero pages.retrieve on the second run", async () => {
    // Integration-level acceptance criterion for PF1-07: repeat
    // `resolveTitles` calls (the render-layer batch used by
    // `lore-wake-up`) over the same id set must hit the cache on the
    // second run.
    //
    // The mixed id is *archived*, not a 404 — Notion returns a full
    // response with `archived: true`, which is the "known-absent"
    // tombstone-cacheable case. Genuinely-missing ids (`pages.retrieve`
    // throws `object_not_found` / `restricted_resource`) ALSO tombstone
    // — that shape is covered by a separate test below (issue #478).
    // Other thrown errors (`rate_limited` / 5xx / `unauthorized` /
    // network) take the transient path and are NOT cached, covered by
    // their own tests further below. Keeping the three scenarios
    // distinct prevents the earlier ambiguity where "missing-id" was
    // named like a 404 but mocked like an archive, and pins the
    // selective-tombstoning contract introduced by #478 — only
    // id-level absence cases tombstone; broad token-level / transport
    // errors do not.
    const ids = Array.from(
      { length: 24 },
      (_, i) => `mem-${i.toString().padStart(2, "0")}`
    )
    ids.push("archived-id")

    const retrieveSpy = vi.fn(async ({ page_id }: { page_id: string }) => {
      if (page_id === "archived-id") {
        return buildPage(
          { Title: { type: "title", title: [{ plain_text: "doesn't matter" }] } },
          { id: page_id, archived: true }
        )
      }
      return titlePage(page_id, `Title of ${page_id}`)
    })
    const client = { pages: { retrieve: retrieveSpy } } as unknown as Client
    const service = new MemoryService(client, db)

    const loader = (id: string) => service.getTitleById(id)

    // First run — one retrieve per distinct id.
    const { resolveTitles } = await import("../mcp/render.js")
    const first = await resolveTitles(ids, loader)
    // Present ids render their title; the archived id is dropped by resolveTitles.
    expect(first.size).toBe(24)
    const firstRunCalls = retrieveSpy.mock.calls.length
    expect(firstRunCalls).toBe(25)

    // Second run — every id hits the cache (values + archived tombstone). Zero fetches.
    const second = await resolveTitles(ids, loader)
    expect(second.size).toBe(24)
    expect(retrieveSpy.mock.calls.length).toBe(firstRunCalls)
  })

  it("genuinely-deleted ids (object_not_found) tombstone — second wake-up issues zero retrieves on the dead id", async () => {
    // The render-layer acceptance criterion for issue #478: a wake-up
    // where one id has been genuinely deleted (the SDK throws
    // `APIResponseError` with `code: object_not_found`) tombstones on
    // the first run, so the second run's `resolveTitles` issues zero
    // retrieves on the dead id while still hitting the cache for the
    // live ones.
    const ids = ["mem-01", "truly-gone"]
    const retrieveSpy = vi.fn(async ({ page_id }: { page_id: string }) => {
      if (page_id === "truly-gone") {
        throw buildApiError(APIErrorCode.ObjectNotFound, 404)
      }
      return titlePage(page_id, `Title of ${page_id}`)
    })
    const client = { pages: { retrieve: retrieveSpy } } as unknown as Client
    const service = new MemoryService(client, db)

    const loader = (id: string) => service.getTitleById(id)
    const { resolveTitles } = await import("../mcp/render.js")

    await resolveTitles(ids, loader)
    await resolveTitles(ids, loader)

    // Both ids fetch exactly once. The deleted-id tombstone short-
    // circuits the second wake-up — the contract violated by the
    // pre-fix bare `catch`.
    const callsForPresent = retrieveSpy.mock.calls.filter(
      (c) => c[0].page_id === "mem-01"
    ).length
    const callsForMissing = retrieveSpy.mock.calls.filter(
      (c) => c[0].page_id === "truly-gone"
    ).length
    expect(callsForPresent).toBe(1)
    expect(callsForMissing).toBe(1)
  })

  it("does not clobber the writer's post-update title when a reader was already in flight", async () => {
    // The dispatched-before-write race: reader A's `getTitleById` is
    // dispatched BEFORE the writer's `update()` runs, so the loader
    // installs a pending slot first. The writer then runs through its
    // pre-write `titleCache.delete(id)` (which drops the reader's
    // pending slot via `LruCache`'s delete-clears-pending discipline)
    // and post-write `titleCache.set(id, "New title")` (which also
    // drops any pending slot via the symmetric set-clears-pending
    // discipline). When reader A's `pages.retrieve` finally resolves
    // with the pre-update page, `getOrLoad`'s identity guard
    // (`pending.get(id) === loaderPromise` → `undefined ===
    // loaderPromise` → false) suppresses the stale commit, so the
    // writer's authoritative value stays in the cache. Pre-PF1-09
    // this protection lived on `MemoryService` as a `writeEpoch`
    // counter checked at commit time; the migration folded that
    // invariant into `LruCache.set`/`delete` themselves so the
    // protection is now primitive-level.
    let releaseRead!: () => void
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const updateSpy = vi.fn(async () => ({}))
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "" }))
    // `getById` after update needs its own retrieve; return "New title".
    let retrieveCount = 0
    const retrieveAll = vi.fn(async ({ page_id }: { page_id: string }) => {
      retrieveCount++
      // First retrieve (reader A) is gated + returns "Old".
      if (retrieveCount === 1) {
        await readGate
        return titlePage(page_id, "Old title")
      }
      // Subsequent retrieves (post-update getById) return "New".
      return titlePage(page_id, "New title")
    })
    const client = {
      pages: {
        retrieve: retrieveAll,
        update: updateSpy,
        retrieveMarkdown: retrieveMarkdownSpy,
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    // Dispatch reader A; it awaits the gate.
    const readerA = service.getTitleById("mem-1")

    // Writer runs to completion: its `update()` call issues a
    // `pages.update` + post-update `getById` (returns "New title") + a
    // write-through `titleCache.set("mem-1", "New title")`.
    await service.update("mem-1", { title: "New title" })

    // Release reader A. The retrieve resolves with the pre-update page.
    releaseRead()
    const readerAResult = await readerA

    // Reader A sees the pre-update page content — reads don't block on
    // writes.
    expect(readerAResult).toBe("Old title")

    // But the cache retains the writer's authoritative "New title" —
    // reader A's stale value was NOT committed because `LruCache`'s
    // identity guard saw the pending slot had been dropped (by the
    // writer's `titleCache.delete` and post-write `titleCache.set`)
    // and refused to commit on resolution.
    expect(await service.getTitleById("mem-1")).toBe("New title")
    expect(updateSpy).toHaveBeenCalledTimes(1)
  })

  it("does not clobber when a reader dispatches DURING the writer's pages.update", async () => {
    // Finding #5 from PR #54 round-2 review (originally guarded by the
    // bespoke `writeEpoch` sandwich; PF1-09 collapsed onto the shared
    // `LruCache.getOrLoad` primitive whose identity guard, paired with
    // `LruCache.set` clearing the pending slot, suppresses the same
    // stale commit). The race: reader's loader's `pages.retrieve` is
    // dispatched AFTER the writer's pre-write `titleCache.delete` but
    // is still in flight when the writer's post-write
    // `titleCache.set("Newest")` fires. Without the pending-clearing
    // discipline on `set`, the reader's `getOrLoad` commit would
    // clobber the writer's authoritative value.
    //
    // The scenario, using only the public API:
    //   t0: writer.update("Newest") fires pre-write delete (sync),
    //       awaits gated pages.update
    //   t1: reader.getTitleById dispatches loader → pages.retrieve
    //       (gated) → installs pending slot
    //   t2: release writer's pages.update → writer continues:
    //       getById (2nd retrieve → "Newest"), titleCache.set("Newest")
    //       which clears the reader's pending slot
    //   t3: release reader's pages.retrieve → loader resolves
    //       "Pre-race". `getOrLoad`'s identity guard
    //       (`pending.get(id) === loaderPromise`) sees `undefined ===
    //       loaderPromise` → false → commit suppressed.
    //   final: reader's caller observes "Pre-race" (one-shot stale
    //          read; reads do not block on writes); cache retains
    //          the writer's authoritative "Newest".
    let releaseWriterUpdate!: () => void
    const writerUpdateGate = new Promise<void>((resolve) => {
      releaseWriterUpdate = resolve
    })
    let releaseReaderRetrieve!: () => void
    const readerRetrieveGate = new Promise<void>((resolve) => {
      releaseReaderRetrieve = resolve
    })

    let retrieveCount = 0
    const retrieveSpy = vi.fn(async ({ page_id }: { page_id: string }) => {
      retrieveCount++
      if (retrieveCount === 1) {
        // Reader's retrieve — gated so it is still in flight when the
        // writer's set fires.
        await readerRetrieveGate
        return titlePage(page_id, "Pre-race")
      }
      // Writer's getById after pages.update — returns "Newest".
      return titlePage(page_id, "Newest")
    })
    const updateSpy = vi.fn(async () => {
      await writerUpdateGate
      return {}
    })
    const client = {
      pages: {
        retrieve: retrieveSpy,
        update: updateSpy,
        retrieveMarkdown: vi.fn(async () => ({ markdown: "" })),
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    // Writer starts: pre-write `titleCache.delete` runs synchronously,
    // then awaits gated `pages.update`.
    const writerPromise = service.update("mem-1", { title: "Newest" })
    // Yield so the writer reaches its gated await.
    await Promise.resolve()

    // Reader dispatches AFTER the writer's delete: cache empty,
    // `getOrLoad` installs a fresh pending slot, loader awaits the
    // gated retrieve. This is the dispatched-during-write window.
    const readerPromise = service.getTitleById("mem-1")
    await Promise.resolve()

    // Release the writer. It runs to completion: getById's
    // pages.retrieve (2nd call → "Newest"), then
    // `titleCache.set("mem-1", "Newest")` — which clears the reader's
    // pending slot via `LruCache.set`'s pending-clearing discipline.
    releaseWriterUpdate()
    await writerPromise

    // Release the reader's retrieve. Loader resolves with the pre-race
    // page, `getOrLoad`'s identity guard suppresses the commit, and
    // the reader's caller still sees "Pre-race".
    releaseReaderRetrieve()
    expect(await readerPromise).toBe("Pre-race")

    // The cache still holds the writer's authoritative "Newest". The
    // next read short-circuits on it; no additional retrieve.
    const beforeFinalReadCalls = retrieveSpy.mock.calls.length
    expect(await service.getTitleById("mem-1")).toBe("Newest")
    expect(retrieveSpy.mock.calls.length).toBe(beforeFinalReadCalls)
  })
})

describe("MemoryService.materializeContent", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function makeIndexTierMemory(id: string) {
    return {
      id,
      title: "Some memory",
      projectIds: [],
      topicId: null,
      source: "manual" as const,
      kind: "note" as const,
      status: "informational" as const,
      confidence: "certain" as const,
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
      synopsis: "Short synopsis",
      session: "",
      content: "",
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      taskState: null,
      blockedBy: "",
      entity: "",
      topicKey: "",
      revisionCount: 1,
      comparedWith: [],
      compareNotes: "",
    }
  }

  it("issues exactly one pages.retrieveMarkdown call and zero pages.retrieve calls", async () => {
    const retrieveSpy = vi.fn()
    const retrieveMarkdownSpy = vi.fn(async () => ({
      markdown: "# Body\n\nlong content",
    }))
    const client = {
      pages: { retrieve: retrieveSpy, retrieveMarkdown: retrieveMarkdownSpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const memory = makeIndexTierMemory("mem-1")
    const hydrated = await service.materializeContent(memory)

    expect(retrieveMarkdownSpy).toHaveBeenCalledTimes(1)
    expect(retrieveMarkdownSpy).toHaveBeenCalledWith({ page_id: "mem-1" })
    expect(retrieveSpy).not.toHaveBeenCalled()
    expect(hydrated.content).toBe("# Body\n\nlong content")
  })

  it("preserves all non-content fields from the input row", async () => {
    const client = {
      pages: {
        retrieve: vi.fn(),
        retrieveMarkdown: vi.fn(async () => ({ markdown: "body" })),
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const memory = makeIndexTierMemory("mem-1")
    const hydrated = await service.materializeContent(memory)

    expect(hydrated.id).toBe(memory.id)
    expect(hydrated.title).toBe(memory.title)
    expect(hydrated.synopsis).toBe(memory.synopsis)
    expect(hydrated.kind).toBe(memory.kind)
    expect(hydrated.createdAt).toBe(memory.createdAt)
  })

  it("propagates pages.retrieveMarkdown failures (caller catches and degrades)", async () => {
    const client = {
      pages: {
        retrieve: vi.fn(),
        retrieveMarkdown: vi.fn(async () => {
          throw new Error("notion 503")
        }),
      },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const memory = makeIndexTierMemory("mem-1")
    await expect(service.materializeContent(memory)).rejects.toThrow("notion 503")
  })
})

describe("MemoryService.getPropertiesById", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildMemoryPage(
    id: string,
    overrides: Partial<PageObjectResponse> = {}
  ): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: `Memory ${id}` }] },
      },
      {
        id,
        parent: { type: "database_id", database_id: db.databaseId },
        ...overrides,
      }
    )
  }

  it("returns property-tier shape for a live Memories row without fetching markdown", async () => {
    const retrieve = vi.fn(async () => buildMemoryPage("mem-live"))
    const retrieveMarkdown = vi.fn()
    const client = { pages: { retrieve, retrieveMarkdown } } as unknown as Client
    const service = new MemoryService(client, db)

    const memory = await service.getPropertiesById("mem-live")

    expect(memory.id).toBe("mem-live")
    expect(memory.title).toBe("Memory mem-live")
    expect(memory.content).toBe("")
    expect(retrieve).toHaveBeenCalledWith({ page_id: "mem-live" })
    expect(retrieveMarkdown).not.toHaveBeenCalled()
  })

  it("accepts v5 data_source_id parents for live Memories rows", async () => {
    const retrieve = vi.fn(async () =>
      buildMemoryPage("mem-live", {
        parent: {
          type: "data_source_id",
          data_source_id: db.dataSourceId,
          database_id: db.databaseId,
        },
      })
    )
    const client = { pages: { retrieve } } as unknown as Client
    const service = new MemoryService(client, db)

    await expect(service.getPropertiesById("mem-live")).resolves.toMatchObject({
      id: "mem-live",
    })
  })

  it("rejects archived Memories rows", async () => {
    const retrieve = vi.fn(async () =>
      buildMemoryPage("mem-archived", { archived: true })
    )
    const client = { pages: { retrieve } } as unknown as Client
    const service = new MemoryService(client, db)

    await expect(service.getPropertiesById("mem-archived")).rejects.toThrow(
      "Memory mem-archived is archived."
    )
  })

  it("rejects accessible pages outside the Memories database", async () => {
    const retrieve = vi.fn(async () =>
      buildMemoryPage("fact-page", {
        parent: { type: "database_id", database_id: "facts-db" },
      })
    )
    const client = { pages: { retrieve } } as unknown as Client
    const service = new MemoryService(client, db)

    await expect(service.getPropertiesById("fact-page")).rejects.toThrow(
      "Memory fact-page is not in the Memories database."
    )
  })
})

// ---------------------------------------------------------------------------
// getManyById — batched fetch used by `lore-query action='ask'` to seed
// `touchOnRead` (issue 0.8.0/05). Pinned here so a future refactor of
// the underlying `getById` semantics surfaces the round-trip + 404
// filter contract this method publishes.
// ---------------------------------------------------------------------------

describe("MemoryService.getManyById", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function buildMemoryPage(id: string, title: string): PageObjectResponse {
    return {
      ...buildPage({
        Title: { type: "title", title: [{ plain_text: title }] },
      }),
      id,
      parent: { type: "database_id", database_id: db.databaseId },
      url: `https://notion.so/${id}`,
    } as PageObjectResponse
  }

  it("returns a Memory per input id, in input order, when every id resolves", async () => {
    const retrieve = vi.fn(async ({ page_id }: { page_id: string }) =>
      buildMemoryPage(page_id, `Memory ${page_id}`)
    )
    const retrieveMarkdown = vi.fn()
    const client = { pages: { retrieve, retrieveMarkdown } } as unknown as Client
    const service = new MemoryService(client, db)

    const memories = await service.getManyById(["m-1", "m-2", "m-3"])

    expect(memories.map((m) => m.id)).toEqual(["m-1", "m-2", "m-3"])
    expect(memories.map((m) => m.title)).toEqual([
      "Memory m-1",
      "Memory m-2",
      "Memory m-3",
    ])
    expect(retrieve).toHaveBeenCalledTimes(3)
  })

  it("issues exactly one pages.retrieve and zero pages.retrieveMarkdown per id", async () => {
    // Spec budget for `getManyById` (issue 0.8.0/05): "one
    // `pages.retrieve` per memory beyond the original read." Routing
    // through `getById` would also fire `retrieveMarkdown` per id,
    // doubling the Notion call count for cited source-memories on the
    // ask hot path. The properties-only posture is load-bearing —
    // `touchOnRead` only reads property fields off the row.
    const retrieve = vi.fn(async ({ page_id }: { page_id: string }) =>
      buildMemoryPage(page_id, `Memory ${page_id}`)
    )
    const retrieveMarkdown = vi.fn()
    const client = { pages: { retrieve, retrieveMarkdown } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.getManyById(["m-1", "m-2", "m-3"])

    expect(retrieve).toHaveBeenCalledTimes(3)
    expect(retrieveMarkdown).not.toHaveBeenCalled()
  })

  it("filters out 404 / archived / permission failures rather than rejecting the batch", async () => {
    // touchOnRead callers pass IDs they believe exist (from list/search
    // results); rows that disappeared between the read and the touch
    // must be silently dropped so the touch never inflates the
    // surrounding tool's failure surface.
    const retrieve = vi.fn(async ({ page_id }: { page_id: string }) => {
      if (page_id === "m-gone") throw new Error("notion 404")
      if (page_id === "m-archived") {
        return { ...buildMemoryPage(page_id, `Memory ${page_id}`), archived: true }
      }
      return buildMemoryPage(page_id, `Memory ${page_id}`)
    })
    const retrieveMarkdown = vi.fn()
    const client = { pages: { retrieve, retrieveMarkdown } } as unknown as Client
    const service = new MemoryService(client, db)

    const memories = await service.getManyById(["m-1", "m-gone", "m-archived", "m-3"])

    expect(memories.map((m) => m.id)).toEqual(["m-1", "m-3"])
  })

  it("returns an empty array for an empty input — no Notion calls", async () => {
    const retrieve = vi.fn()
    const retrieveMarkdown = vi.fn()
    const client = { pages: { retrieve, retrieveMarkdown } } as unknown as Client
    const service = new MemoryService(client, db)

    const memories = await service.getManyById([])

    expect(memories).toEqual([])
    expect(retrieve).not.toHaveBeenCalled()
    expect(retrieveMarkdown).not.toHaveBeenCalled()
  })

  it("dispatches retrieve calls in parallel — every fetch starts before any returns", async () => {
    // Mirrors the lore-expand parallel-dispatch invariant: a serial
    // `for await` loop would only kick off one fetch at a time.
    const inflight = new Map<string, () => void>()
    const started: string[] = []

    const retrieve = vi.fn(({ page_id }: { page_id: string }) => {
      started.push(page_id)
      return new Promise<PageObjectResponse>((resolve) => {
        inflight.set(page_id, () => resolve(buildMemoryPage(page_id, `T ${page_id}`)))
      })
    })
    const retrieveMarkdown = vi.fn()
    const client = { pages: { retrieve, retrieveMarkdown } } as unknown as Client
    const service = new MemoryService(client, db)

    const pending = service.getManyById(["m-a", "m-b", "m-c"])
    await new Promise((r) => setImmediate(r))
    expect(started).toEqual(["m-a", "m-b", "m-c"])

    inflight.get("m-a")?.()
    inflight.get("m-b")?.()
    inflight.get("m-c")?.()

    const memories = await pending
    expect(memories.map((m) => m.id)).toEqual(["m-a", "m-b", "m-c"])
  })

  it("dedupes repeated input ids before dispatching — one fetch per distinct id", async () => {
    // Mirrors `lore-memory action='expand'`'s dedup-on-input contract:
    // a caller passing `["a", "a", "b"]` gets one fetch per distinct
    // id and one Memory per distinct id back. Saves an unnecessary
    // Notion round-trip when the upstream collector hasn't deduped.
    const retrieve = vi.fn(async ({ page_id }: { page_id: string }) =>
      buildMemoryPage(page_id, `Memory ${page_id}`)
    )
    const retrieveMarkdown = vi.fn()
    const client = { pages: { retrieve, retrieveMarkdown } } as unknown as Client
    const service = new MemoryService(client, db)

    const memories = await service.getManyById(["m-a", "m-a", "m-b"])

    expect(retrieve).toHaveBeenCalledTimes(2)
    expect(memories.map((m) => m.id)).toEqual(["m-a", "m-b"])
  })

  it("returns memories with empty content — properties-only fetch", async () => {
    // The Memory shape carries `content` for downstream renderers.
    // Property-only fetch leaves it empty; callers needing the body
    // must use `getById` instead. Pinned so a future contributor
    // doesn't "helpfully" route through `getById` and silently
    // re-introduce the doubled Notion budget the spec rejected.
    const retrieve = vi.fn(async ({ page_id }: { page_id: string }) =>
      buildMemoryPage(page_id, `Memory ${page_id}`)
    )
    const retrieveMarkdown = vi.fn()
    const client = { pages: { retrieve, retrieveMarkdown } } as unknown as Client
    const service = new MemoryService(client, db)

    const memories = await service.getManyById(["m-1"])

    expect(memories[0]!.content).toBe("")
    expect(retrieveMarkdown).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// touchOnRead + decrementConfidence — confidence dynamics I/O
// ---------------------------------------------------------------------------

describe("MemoryService.touchOnRead", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }
  const TODAY = "2026-04-29"

  function makeMemoryShape(
    overrides: {
      id?: string
      confidence?: "certain" | "likely" | "speculative"
      confidenceScore?: number | null
      lastReferencedAt?: string | null
      createdAt?: string
    } = {}
  ) {
    return {
      id: overrides.id ?? "m1",
      confidence: overrides.confidence ?? ("certain" as const),
      confidenceScore: overrides.confidenceScore ?? null,
      lastReferencedAt: overrides.lastReferencedAt ?? null,
      createdAt: overrides.createdAt ?? "2026-04-29T00:00:00.000Z",
    }
  }

  it("short-circuits when lastReferencedAt is today AND confidenceScore is non-null", async () => {
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.touchOnRead(
      [
        makeMemoryShape({
          id: "m1",
          confidenceScore: 0.85,
          lastReferencedAt: TODAY,
        }),
      ],
      { today: TODAY }
    )

    expect(update).not.toHaveBeenCalled()
  })

  it("does not short-circuit when lastReferencedAt is today but confidenceScore is null", async () => {
    // Realistic concurrent-read scenario: another touch wrote
    // `Last Referenced At` but the score column is still empty (the
    // companion column write would only diverge under a partial Notion
    // failure, but the helper must not skip on the in-memory snapshot).
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.touchOnRead(
      [
        makeMemoryShape({
          id: "m1",
          confidenceScore: null,
          lastReferencedAt: TODAY,
        }),
      ],
      { today: TODAY }
    )

    expect(update).toHaveBeenCalledTimes(1)
  })

  it("seed-decay-then-bumps a never-scored row whose createdAt is recent", async () => {
    // createdAt is today → zero stale days → decay no-ops, only the
    // bump applies. seed("certain") = 0.9; bump(0.9) = 0.9 + 0.1*0.05
    // = 0.905.
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.touchOnRead(
      [
        makeMemoryShape({
          confidence: "certain",
          confidenceScore: null,
          lastReferencedAt: null,
          createdAt: `${TODAY}T00:00:00.000Z`,
        }),
      ],
      { today: TODAY }
    )

    expect(update).toHaveBeenCalledTimes(1)
    const writtenScore = (
      update.mock.calls[0]![0] as unknown as {
        properties: { "Confidence Score": { number: number } }
      }
    ).properties["Confidence Score"].number
    expect(writtenScore).toBeCloseTo(0.905, 6)
  })

  it("seed-decay-then-bumps a never-scored 200-day-old row (pre-migration convergence)", async () => {
    // 2026-04-29 minus 200 days = 2025-10-11 → 200 days elapsed →
    // 140 stale days past the 60-day grace.
    // seed("certain") = 0.9 → decay = 0.9 * 0.99^140 → bump.
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.touchOnRead(
      [
        makeMemoryShape({
          confidence: "certain",
          confidenceScore: null,
          lastReferencedAt: null,
          createdAt: "2025-10-11T00:00:00.000Z",
        }),
      ],
      { today: TODAY }
    )

    const writtenScore = (
      update.mock.calls[0]![0] as unknown as {
        properties: { "Confidence Score": { number: number } }
      }
    ).properties["Confidence Score"].number
    const decayed = 0.9 * Math.pow(0.99, 140)
    const expected = decayed + (1 - decayed) * 0.05
    expect(writtenScore).toBeCloseTo(expected, 6)
    // Sanity: should land far below the no-decay baseline (~0.905).
    expect(writtenScore).toBeLessThan(0.3)
  })

  it("decays-then-bumps a stale row instead of bumping the stored score directly", async () => {
    // 2026-04-29 minus 100 days = 2026-01-19 → 100 days elapsed →
    // 40 stale days past the 60-day grace. Stored 0.9 → decay
    // 0.9 * 0.99^40 ≈ 0.602 → bump → ≈ 0.622. NOT bump(0.9) ≈ 0.905.
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.touchOnRead(
      [
        makeMemoryShape({
          confidenceScore: 0.9,
          lastReferencedAt: "2026-01-19",
        }),
      ],
      { today: TODAY }
    )

    const writtenScore = (
      update.mock.calls[0]![0] as unknown as {
        properties: { "Confidence Score": { number: number } }
      }
    ).properties["Confidence Score"].number
    const decayed = 0.9 * Math.pow(0.99, 40)
    const expected = decayed + (1 - decayed) * 0.05
    expect(writtenScore).toBeCloseTo(expected, 6)
    // Sanity: should not be the no-decay bump value (~0.905).
    expect(writtenScore).toBeLessThan(0.7)
  })

  it("writes both Confidence Score and Last Referenced At in a single pages.update", async () => {
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.touchOnRead([makeMemoryShape()], { today: TODAY })

    expect(update).toHaveBeenCalledTimes(1)
    const args = update.mock.calls[0]![0] as {
      properties: Record<string, unknown>
    }
    expect(args.properties["Last Referenced At"]).toEqual({
      date: { start: TODAY },
    })
    expect(args.properties["Confidence Score"]).toMatchObject({
      number: expect.any(Number),
    })
  })

  it("isolates per-row failures and continues processing the rest of the batch", async () => {
    const update = vi.fn(async (args: { page_id: string }) => {
      if (args.page_id === "m-bad") throw new Error("notion 503")
      return undefined
    })
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)
    const errors: Array<{ id: string; message: string }> = []

    await service.touchOnRead(
      [
        makeMemoryShape({ id: "m-good-1" }),
        makeMemoryShape({ id: "m-bad" }),
        makeMemoryShape({ id: "m-good-2" }),
      ],
      {
        today: TODAY,
        onError: (id, error) => {
          errors.push({
            id,
            message: error instanceof Error ? error.message : String(error),
          })
        },
      }
    )

    expect(update).toHaveBeenCalledTimes(3)
    expect(errors).toEqual([{ id: "m-bad", message: "notion 503" }])
  })

  it("does not throw when a row fails and onError is omitted (the callback is optional)", async () => {
    // Sibling to the `onError` failure-isolation test above: the
    // helper's signature marks `onError` as optional, so a caller that
    // doesn't pass one must still get advisory non-throwing semantics
    // — the read result is preserved regardless of write outcome.
    const update = vi.fn(
      async (args: { page_id: string; properties: Record<string, unknown> }) => {
        if (args.page_id === "m-bad") throw new Error("notion 503")
        return undefined
      }
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await expect(
      service.touchOnRead(
        [
          makeMemoryShape({ id: "m-good-1" }),
          makeMemoryShape({ id: "m-bad" }),
          makeMemoryShape({ id: "m-good-2" }),
        ],
        { today: TODAY }
      )
    ).resolves.toBeUndefined()
    expect(update).toHaveBeenCalledTimes(3)
  })

  it("is a no-op (and issues no Notion calls) for an empty memory list", async () => {
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.touchOnRead([], { today: TODAY })

    expect(update).not.toHaveBeenCalled()
  })

  it("treats `confidenceScore non-null + lastReferencedAt null` as no-op decay (corner-case safety net)", async () => {
    // Production callers always write both columns together via
    // `touchOnRead` / `decrementConfidence`, so a row with a stored
    // score but no last-reference date shouldn't exist. The type
    // system permits the shape, though, and the implementation leans
    // on `decayConfidenceScore`'s null-tolerant pass-through for this
    // case — pin it so a future "narrow lastReferencedAt to non-null
    // here" refactor surfaces this corner case.
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.touchOnRead(
      [
        makeMemoryShape({
          confidenceScore: 0.7,
          lastReferencedAt: null, // pathological — production never produces this
        }),
      ],
      { today: TODAY }
    )

    const writtenScore = (
      update.mock.calls[0]![0] as unknown as {
        properties: { "Confidence Score": { number: number } }
      }
    ).properties["Confidence Score"].number
    // No decay applies (lastReferencedAt is null) → bump 0.7 directly:
    // 0.7 + (1 − 0.7) * 0.05 = 0.715.
    expect(writtenScore).toBeCloseTo(0.715, 6)
  })

  it("converges with the bulk-migration baseline on the never-scored branch", async () => {
    // Pre-migration / post-migration convergence test. The migration
    // would compute decay(seed, createdAt, today) — no bump. touchOnRead
    // computes bump(decay(seed, createdAt, today)). Modulo the single
    // bump step (representing the cite the touchOnRead path embodies),
    // the two paths land on the same intermediate decayed value.
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.touchOnRead(
      [
        makeMemoryShape({
          confidence: "likely",
          confidenceScore: null,
          lastReferencedAt: null,
          createdAt: "2025-10-11T00:00:00.000Z",
        }),
      ],
      { today: TODAY }
    )

    const writtenScore = (
      update.mock.calls[0]![0] as unknown as {
        properties: { "Confidence Score": { number: number } }
      }
    ).properties["Confidence Score"].number
    // seed("likely") = 0.6 → decay over 140 stale days → bump.
    const migrationValue = 0.6 * Math.pow(0.99, 140)
    const touchValue = migrationValue + (1 - migrationValue) * 0.05
    expect(writtenScore).toBeCloseTo(touchValue, 6)
  })

  it("mutates the input row's lastReferencedAt and confidenceScore in place after a successful update (issue #495)", async () => {
    // The wake-up cache (issue #495) hands the same `Memory[]`
    // reference back on subsequent hits within TTL. Without this
    // mutation, the once-per-day gate at the top of touchOnRead
    // would key on the cached row's pre-touch `lastReferencedAt`
    // and re-fire `pages.update` for every row on every cache hit.
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    const row = makeMemoryShape({
      id: "m1",
      confidence: "certain",
      confidenceScore: null,
      lastReferencedAt: null,
      createdAt: `${TODAY}T00:00:00.000Z`,
    })

    await service.touchOnRead([row], { today: TODAY })
    expect(update).toHaveBeenCalledTimes(1)
    expect(row.lastReferencedAt).toBe(TODAY)
    expect(row.confidenceScore).toBeCloseTo(0.905, 6)

    // A second call with the SAME reference must hit the
    // once-per-day short-circuit (zero new updates).
    await service.touchOnRead([row], { today: TODAY })
    expect(update).toHaveBeenCalledTimes(1)
  })

  it("does not mutate the input row when the update throws", async () => {
    const update = vi.fn(async () => {
      throw new Error("notion 429")
    })
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    const row = makeMemoryShape({
      id: "m1",
      confidence: "certain",
      confidenceScore: null,
      lastReferencedAt: null,
      createdAt: `${TODAY}T00:00:00.000Z`,
    })

    await service.touchOnRead([row], { today: TODAY })
    expect(row.lastReferencedAt).toBeNull()
    expect(row.confidenceScore).toBeNull()
  })
})

describe("MemoryService.decrementConfidence", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }
  const TODAY = "2026-04-29"

  function makeMemoryShape(
    overrides: {
      id?: string
      confidence?: "certain" | "likely" | "speculative"
      confidenceScore?: number | null
      lastReferencedAt?: string | null
      createdAt?: string
    } = {}
  ) {
    return {
      id: overrides.id ?? "m1",
      confidence: overrides.confidence ?? ("certain" as const),
      confidenceScore: overrides.confidenceScore ?? null,
      lastReferencedAt: overrides.lastReferencedAt ?? null,
      createdAt: overrides.createdAt ?? "2026-04-29T00:00:00.000Z",
    }
  }

  it("writes both Confidence Score and Last Referenced At in a single pages.update", async () => {
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.decrementConfidence(
      makeMemoryShape({ confidenceScore: 0.9, lastReferencedAt: TODAY }),
      { today: TODAY }
    )

    expect(update).toHaveBeenCalledTimes(1)
    const args = update.mock.calls[0]![0] as {
      properties: Record<string, unknown>
    }
    expect(args.properties["Last Referenced At"]).toEqual({
      date: { start: TODAY },
    })
    expect(args.properties["Confidence Score"]).toMatchObject({
      number: expect.any(Number),
    })
  })

  it("halves a fresh, non-stale, non-null score (no decay applied)", async () => {
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    const next = await service.decrementConfidence(
      makeMemoryShape({ confidenceScore: 0.9, lastReferencedAt: TODAY }),
      { today: TODAY }
    )

    expect(next).toBeCloseTo(0.45, 6)
  })

  it("decays-then-decrements on a stale row (200 days neglected)", async () => {
    // 200 days elapsed → 140 stale days past 60-day grace.
    // 0.9 * 0.99^140 ≈ 0.220 → halve → ≈ 0.110.
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    const next = await service.decrementConfidence(
      makeMemoryShape({
        confidenceScore: 0.9,
        lastReferencedAt: "2025-10-11",
      }),
      { today: TODAY }
    )

    const decayed = 0.9 * Math.pow(0.99, 140)
    const expected = decayed * 0.5
    expect(next).toBeCloseTo(expected, 6)
    // Sanity: well below the no-decay baseline (0.45).
    expect(next).toBeLessThan(0.2)
  })

  it("seed-decay-then-decrements a never-scored row", async () => {
    // Pre-migration row contradicted directly. seed("certain") = 0.9 →
    // decay against createdAt → halve. Same convergence guarantee as
    // touchOnRead's null-score branch.
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    const next = await service.decrementConfidence(
      makeMemoryShape({
        confidence: "certain",
        confidenceScore: null,
        lastReferencedAt: null,
        createdAt: "2025-10-11T00:00:00.000Z",
      }),
      { today: TODAY }
    )

    const decayed = 0.9 * Math.pow(0.99, 140)
    const expected = decayed * 0.5
    expect(next).toBeCloseTo(expected, 6)
  })

  it("returns the new score from the call", async () => {
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    const next = await service.decrementConfidence(
      makeMemoryShape({ confidenceScore: 0.5, lastReferencedAt: TODAY }),
      { today: TODAY }
    )

    expect(next).toBeCloseTo(0.25, 6)
  })

  it("propagates errors from the underlying pages.update (no onError swallow)", async () => {
    const update = vi.fn(async () => {
      throw new Error("notion 429")
    })
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await expect(
      service.decrementConfidence(
        makeMemoryShape({ confidenceScore: 0.9, lastReferencedAt: TODAY }),
        { today: TODAY }
      )
    ).rejects.toThrow("notion 429")
  })
})

// ---------------------------------------------------------------------------
// listAllForBackfill + applyBackfillScore — confidence-score migration helpers
// (issue 0.8.0/11). Pinned here so a future refactor does not silently break
// the migration's contract.
// ---------------------------------------------------------------------------

describe("MemoryService.listAllForBackfill", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function makePage(
    id: string,
    overrides: Partial<PageObjectResponse> = {},
    properties: Record<string, unknown> = {}
  ): PageObjectResponse {
    return {
      object: "page",
      id,
      created_time: "2026-01-01T00:00:00.000Z",
      last_edited_time: "2026-02-01T00:00:00.000Z",
      archived: false,
      properties: {
        Title: { type: "title", title: [{ plain_text: id, text: { content: id } }] },
        ...properties,
      } as unknown as PageObjectResponse["properties"],
      parent: { type: "database_id", database_id: "db-id" },
      url: `https://notion.so/${id}`,
      ...overrides,
    } as PageObjectResponse
  }

  it("paginates through every page and yields every non-archived row", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        results: [makePage("m1"), makePage("m2")],
        has_more: true,
        next_cursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        results: [makePage("m3")],
        has_more: false,
        next_cursor: null,
      })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    const ids: string[] = []
    for await (const memory of service.listAllForBackfill()) {
      ids.push(memory.id)
    }
    expect(ids).toEqual(["m1", "m2", "m3"])
    expect(query).toHaveBeenCalledTimes(2)
    // Second call carries the cursor from the first response.
    expect(query.mock.calls[1]![0]).toMatchObject({ start_cursor: "cursor-1" })
  })

  it("filters out archived rows client-side", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      results: [
        makePage("m-live"),
        makePage("m-archived", { archived: true }),
        makePage("m-also-live"),
      ],
      has_more: false,
      next_cursor: null,
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    const ids: string[] = []
    for await (const memory of service.listAllForBackfill()) {
      ids.push(memory.id)
    }
    expect(ids).toEqual(["m-live", "m-also-live"])
  })

  it("scopes to a project via the project-or-unscoped filter when projectId is set", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    const iter = service.listAllForBackfill({ projectId: "project-123" })
    // Drain.
    for await (const _m of iter) void _m
    expect(query).toHaveBeenCalledTimes(1)
    const args = query.mock.calls[0]![0] as {
      filter: unknown
      sorts: unknown
      page_size: number
    }
    expect(args.filter).toBeDefined()
    // Sanity: the filter mentions the project id (exact shape comes from
    // `projectOrUnscopedFilter`, pinned in its own tests).
    expect(JSON.stringify(args.filter)).toContain("project-123")
    expect(args.sorts).toEqual([{ timestamp: "created_time", direction: "ascending" }])
    expect(args.page_size).toBe(100)
  })

  it("issues only the cleanup-orphan exclusion filter when projectId is omitted (vault-wide scope, issue #477)", async () => {
    // Pre-issue-477 this was `filter: undefined` — vault-wide scope
    // meant zero filtering. The cleanup-orphan exclusion is now the
    // only filter on the unscoped path so the backfill doesn't seed a
    // confidence score onto a resurfaced empty-body shell.
    const query = vi.fn().mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    for await (const _m of service.listAllForBackfill()) void _m
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]![0]).toMatchObject({
      filter: {
        property: "Keywords",
        rich_text: { does_not_contain: "__lore-cleanup-orphan" },
      },
    })
  })
})

describe("MemoryService.applyBackfillScore", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  it("writes both Confidence Score and Last Referenced At in a single pages.update", async () => {
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.applyBackfillScore("memory-1", 0.42, "2025-10-11")

    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0]![0]).toEqual({
      page_id: "memory-1",
      properties: {
        "Confidence Score": { number: 0.42 },
        "Last Referenced At": { date: { start: "2025-10-11" } },
      },
    })
  })

  it("propagates errors from the underlying pages.update", async () => {
    const update = vi.fn(async () => {
      throw new Error("notion 429")
    })
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await expect(
      service.applyBackfillScore("memory-1", 0.5, "2025-10-11")
    ).rejects.toThrow("notion 429")
  })
})

// ---------------------------------------------------------------------------
// confidenceStats — `lore status` confidence-summary line (DEFERRED-04)
// ---------------------------------------------------------------------------

describe("MemoryService.confidenceStats", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function makePage(
    id: string,
    confidenceScore: number | null,
    overrides: Partial<PageObjectResponse> = {}
  ): PageObjectResponse {
    const props: Record<string, unknown> = {
      Title: { type: "title", title: [{ plain_text: id, text: { content: id } }] },
    }
    if (confidenceScore !== null) {
      props["Confidence Score"] = { type: "number", number: confidenceScore }
    }
    return {
      object: "page",
      id,
      created_time: "2026-01-01T00:00:00.000Z",
      last_edited_time: "2026-02-01T00:00:00.000Z",
      archived: false,
      properties: props as unknown as PageObjectResponse["properties"],
      parent: { type: "database_id", database_id: "db-id" },
      url: `https://notion.so/${id}`,
      ...overrides,
    } as PageObjectResponse
  }

  it("returns all-zero stats on an empty vault", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    const stats = await service.confidenceStats()
    expect(stats).toEqual({
      totalMemories: 0,
      scoredMemories: 0,
      averageScore: 0,
      belowThreshold: 0,
    })
  })

  it("counts every non-archived row as totalMemories regardless of score", async () => {
    // Pre-#11 vault shape: every page has a null `Confidence Score`.
    // The total count must still include them so the operator sees
    // "N total, 0 scored" rather than "0 total".
    const query = vi.fn().mockResolvedValueOnce({
      results: [makePage("m1", null), makePage("m2", null), makePage("m3", null)],
      has_more: false,
      next_cursor: null,
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    const stats = await service.confidenceStats()
    expect(stats.totalMemories).toBe(3)
    expect(stats.scoredMemories).toBe(0)
    expect(stats.averageScore).toBe(0)
    expect(stats.belowThreshold).toBe(0)
  })

  it("computes the arithmetic mean across only scored rows", async () => {
    // Mixed vault: scored 0.9 + 0.6 + 0.3 = 1.8 / 3 = 0.6 average.
    // Unscored rows must NOT pull the average toward zero — the
    // divisor is `scoredMemories`, not `totalMemories`.
    const query = vi.fn().mockResolvedValueOnce({
      results: [
        makePage("scored-high", 0.9),
        makePage("unscored", null),
        makePage("scored-mid", 0.6),
        makePage("scored-low", 0.3),
      ],
      has_more: false,
      next_cursor: null,
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    const stats = await service.confidenceStats()
    expect(stats.totalMemories).toBe(4)
    expect(stats.scoredMemories).toBe(3)
    expect(stats.averageScore).toBeCloseTo(0.6, 5)
  })

  it("counts only scored rows strictly below CONFIDENCE_DISPLAY_THRESHOLD", async () => {
    // Threshold gate matches the trust indicator + Stale Confidence
    // wake-up. A row exactly at the threshold (0.5) does NOT count as
    // below — same `<` semantics `getTrustLabel` uses.
    const query = vi.fn().mockResolvedValueOnce({
      results: [
        makePage("at-threshold", 0.5),
        makePage("below-1", 0.49),
        makePage("below-2", 0.2),
        makePage("above", 0.8),
      ],
      has_more: false,
      next_cursor: null,
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    const stats = await service.confidenceStats()
    expect(stats.belowThreshold).toBe(2)
  })

  it("paginates through every result page and aggregates across them", async () => {
    // Two response pages — confirms the iterator follows `next_cursor`
    // and the aggregator accumulates across pages rather than resetting.
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        results: [makePage("m1", 0.9), makePage("m2", 0.4)],
        has_more: true,
        next_cursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        results: [makePage("m3", null)],
        has_more: false,
        next_cursor: null,
      })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    const stats = await service.confidenceStats()
    expect(query).toHaveBeenCalledTimes(2)
    expect(stats).toEqual({
      totalMemories: 3,
      scoredMemories: 2,
      averageScore: 0.65,
      belowThreshold: 1,
    })
  })

  it("excludes archived rows from every count", async () => {
    // Archived rows are filtered client-side by `listAllForBackfill`;
    // confidenceStats inherits that behavior. A backfilled-then-
    // archived row should NOT pull the live-vault stats around.
    const query = vi.fn().mockResolvedValueOnce({
      results: [
        makePage("live-scored", 0.9),
        makePage("archived-scored", 0.1, { archived: true }),
        makePage("live-unscored", null),
      ],
      has_more: false,
      next_cursor: null,
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    const stats = await service.confidenceStats()
    expect(stats.totalMemories).toBe(2)
    expect(stats.scoredMemories).toBe(1)
    expect(stats.belowThreshold).toBe(0)
  })

  it("scopes to a project via projectOrUnscopedFilter when projectId is set", async () => {
    // Pin the project-scoping seam: `confidenceStats({ projectId })`
    // forwards through to `listAllForBackfill`, so the operator running
    // `lore status` inside a sub-project sees the per-project number,
    // not vault-wide.
    const query = vi.fn().mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.confidenceStats({ projectId: "project-123" })
    expect(query).toHaveBeenCalledTimes(1)
    const args = query.mock.calls[0]![0] as { filter: unknown }
    expect(JSON.stringify(args.filter)).toContain("project-123")
  })
})

// ---------------------------------------------------------------------------
// countProposed — `lore status` proposed-memory inbox primitive (issue #281)
// ---------------------------------------------------------------------------

describe("MemoryService.countProposed", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function makeProposedPage(
    id: string,
    source: string | null,
    agent: string,
    overrides: Partial<PageObjectResponse> & { kind?: string } = {}
  ): PageObjectResponse {
    const { kind, ...pageOverrides } = overrides
    const props: Record<string, unknown> = {
      Title: { type: "title", title: [{ plain_text: id, text: { content: id } }] },
      Status: { type: "select", select: { name: "proposed" } },
      Kind: { type: "select", select: kind ? { name: kind } : null },
      Source: {
        type: "select",
        select: source !== null ? { name: source } : null,
      },
      Agent: {
        type: "rich_text",
        rich_text:
          agent.length > 0
            ? [{ type: "text", plain_text: agent, text: { content: agent } }]
            : [],
      },
    }
    return {
      object: "page",
      id,
      created_time: "2026-01-01T00:00:00.000Z",
      last_edited_time: "2026-02-01T00:00:00.000Z",
      archived: false,
      properties: props as unknown as PageObjectResponse["properties"],
      parent: { type: "database_id", database_id: "db-id" },
      url: `https://notion.so/${id}`,
      ...pageOverrides,
    } as PageObjectResponse
  }

  it("returns zeros and empty maps on an empty inbox", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    const result = await service.countProposed()
    expect(result).toEqual({ total: 0, bySource: {}, byAgent: {} })
  })

  it("aggregates total, per-source, and per-agent counts across one page", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      results: [
        makeProposedPage("m1", "conversation", "Claude Code"),
        makeProposedPage("m2", "conversation", "Claude Code"),
        makeProposedPage("m3", "manual", "Codex"),
      ],
      has_more: false,
      next_cursor: null,
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    const result = await service.countProposed()
    expect(result.total).toBe(3)
    expect(result.bySource).toEqual({ conversation: 2, manual: 1 })
    expect(result.byAgent).toEqual({ "Claude Code": 2, Codex: 1 })
  })

  it("paginates through every page until has_more is false", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        results: [makeProposedPage("m1", "conversation", "Claude Code")],
        has_more: true,
        next_cursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        results: [makeProposedPage("m2", "manual", "Codex")],
        has_more: false,
        next_cursor: null,
      })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    const result = await service.countProposed()
    expect(result.total).toBe(2)
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1]![0]).toMatchObject({ start_cursor: "cursor-1" })
  })

  it("filters out archived pages client-side", async () => {
    // Notion's `archived` flag is on the page object, not a DB column,
    // so `dataSources.query` cannot exclude it server-side. The count
    // primitive must skip archived rows itself — same posture as
    // `listAllForBackfill` and `findByTopicKey`.
    const query = vi.fn().mockResolvedValueOnce({
      results: [
        makeProposedPage("m-live", "conversation", "Claude Code"),
        makeProposedPage("m-archived", "conversation", "Claude Code", {
          archived: true,
        }),
      ],
      has_more: false,
      next_cursor: null,
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    const result = await service.countProposed()
    expect(result.total).toBe(1)
    expect(result.bySource).toEqual({ conversation: 1 })
    expect(result.byAgent).toEqual({ "Claude Code": 1 })
  })

  it("buckets empty / whitespace-only Agent values under 'unknown'", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      results: [
        makeProposedPage("m1", "conversation", ""),
        makeProposedPage("m2", "manual", "   "),
        makeProposedPage("m3", "conversation", "Claude Code"),
      ],
      has_more: false,
      next_cursor: null,
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    const result = await service.countProposed()
    expect(result.byAgent).toEqual({ unknown: 2, "Claude Code": 1 })
  })

  it("filters server-side on Status = proposed AND Kind != decision", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.countProposed()
    expect(query).toHaveBeenCalledTimes(1)
    const args = query.mock.calls[0]![0] as { filter: unknown }
    // The filter must reference the Status property and the literal
    // `proposed` select option — without these, accepted memories
    // would inflate the inbox count. It must ALSO exclude
    // `Kind = decision` so proposed-state decisions (a normal
    // in-flight lifecycle state per `ACTIVE_DECISION_STATUSES`)
    // don't conflate with auto-extracted learnings awaiting review.
    const serialized = JSON.stringify(args.filter)
    expect(serialized).toContain('"Status"')
    expect(serialized).toContain('"proposed"')
    expect(serialized).toContain('"Kind"')
    expect(serialized).toContain('"does_not_equal":"decision"')
  })

  it("composes the proposedMemoryFilter helper as flat siblings, not a nested compound", async () => {
    // Pin the flatness contract: `countProposed` spreads
    // `proposedMemoryFilter().and` into the outer filter array
    // rather than pushing the helper as a single nested clause.
    // Notion accepts both `{ and: [{ and: [a, b] }, c] }` and
    // `{ and: [a, b, c] }`, but the flat shape is conventional and
    // easier to debug in API logs. A future refactor that wraps
    // the helper would silently double-nest under project scope.
    const query = vi.fn().mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.countProposed({ projectId: "proj-1" })
    const args = query.mock.calls[0]![0] as {
      filter: { and?: Array<Record<string, unknown>> }
    }
    expect(args.filter.and).toBeDefined()
    // No element of the outer `and:` is itself wrapped in `{ and: }`.
    for (const clause of args.filter.and!) {
      expect(clause).not.toHaveProperty("and")
    }
  })

  it("buckets a missing Source column under 'unknown' rather than 'manual'", async () => {
    // `extractSelect` defaults a missing Source to `"manual"` for
    // `pageToMemory`, but the inbox surface needs to distinguish
    // "operator saved this as manual" from "Source column was
    // empty". Bucketing as `"unknown"` mirrors the Agent fallback.
    const query = vi.fn().mockResolvedValueOnce({
      results: [
        makeProposedPage("m1", "conversation", "Claude Code"),
        makeProposedPage("m2", null, "Claude Code"),
        makeProposedPage("m3", null, "Codex"),
      ],
      has_more: false,
      next_cursor: null,
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    const result = await service.countProposed()
    expect(result.bySource).toEqual({ conversation: 1, unknown: 2 })
  })

  it("scopes to a project via the project-or-unscoped filter when projectId is supplied", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.countProposed({ projectId: "project-widget" })
    expect(query).toHaveBeenCalledTimes(1)
    const args = query.mock.calls[0]![0] as { filter: unknown }
    expect(JSON.stringify(args.filter)).toContain("project-widget")
  })

  it("omits the project clause for vault-wide counts", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.countProposed()
    expect(query).toHaveBeenCalledTimes(1)
    // No project clause: the filter is the bare Status equality.
    const args = query.mock.calls[0]![0] as { filter: unknown }
    expect(JSON.stringify(args.filter)).not.toContain("Project")
  })

  it("includes the cleanup-orphan exclusion so the count matches the proposed-inbox slice (issue #477 review-feedback)", async () => {
    // `loadWakeUpData` documents that the proposed-inbox slice
    // (`MemoryService.list({ status: "proposed", excludeKinds:
    // ["decision"] })`) and the proposed-inbox count
    // (`MemoryService.countProposed`) must surface the same row set.
    // After issue #477's broad sentinel-exclusion sweep, `list` drops
    // resurfaced cleanup-orphans automatically — `countProposed` must
    // do the same or the wake-up renderer prints a count that doesn't
    // match its row list. Pin both halves of the contract: the
    // request filter carries the does_not_contain clause, AND the
    // resulting count excludes the sentinel-tagged row.
    const sentinelRow = {
      object: "page",
      id: "mem-resurfaced-orphan",
      created_time: "2026-04-01T00:00:00.000Z",
      last_edited_time: "2026-05-04T00:00:00.000Z",
      archived: false,
      parent: { type: "data_source_id", data_source_id: db.dataSourceId },
      properties: {
        Status: { type: "select", select: { name: "proposed" } },
        Kind: { type: "select", select: { name: "note" } },
        Source: { type: "select", select: { name: "conversation" } },
        Agent: { type: "rich_text", rich_text: [{ plain_text: "Claude Code" }] },
        Keywords: {
          type: "rich_text",
          rich_text: [{ plain_text: "auth __lore-cleanup-orphan" }],
        },
      },
    } as unknown as PageObjectResponse
    // The mock simulates Notion's server-side filter enforcement: when
    // the query carries `does_not_contain "__lore-cleanup-orphan"`,
    // the row with the sentinel keyword is filtered out of the
    // response. The test thereby covers BOTH the filter contract AND
    // the count semantic.
    const query = vi.fn().mockImplementation(async (args: { filter: unknown }) => {
      const serialized = JSON.stringify(args.filter)
      if (serialized.includes("__lore-cleanup-orphan")) {
        return { results: [], has_more: false, next_cursor: null }
      }
      return { results: [sentinelRow], has_more: false, next_cursor: null }
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    const result = await service.countProposed()

    // Filter shape: the cleanup-orphan exclusion is composed alongside
    // the proposed-status / non-decision clauses as a flat sibling.
    expect(query).toHaveBeenCalledTimes(1)
    const args = query.mock.calls[0]![0] as {
      filter: { and?: Array<Record<string, unknown>> }
    }
    expect(args.filter.and).toBeDefined()
    expect(args.filter.and).toContainEqual({
      property: "Keywords",
      rich_text: { does_not_contain: "__lore-cleanup-orphan" },
    })
    // Count semantic: zero rows because the only candidate carries the
    // sentinel and Notion's server-side filter excluded it.
    expect(result.total).toBe(0)
  })

  it("composes the cleanup-orphan exclusion alongside project scope without breaking the flat shape (issue #477 review-feedback)", async () => {
    // Project-scoped variant of the above. The flat-sibling contract
    // pinned at line 10655 must continue to hold — the cleanup-orphan
    // exclusion is appended as a sibling, not nested as a sub-`and`.
    const query = vi.fn().mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    })
    const client = { dataSources: { query } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.countProposed({ projectId: "proj-1" })

    const args = query.mock.calls[0]![0] as {
      filter: { and?: Array<Record<string, unknown>> }
    }
    expect(args.filter.and).toBeDefined()
    // Four flat siblings: status, kind, project, sentinel.
    expect(args.filter.and).toHaveLength(4)
    expect(args.filter.and).toContainEqual({
      property: "Keywords",
      rich_text: { does_not_contain: "__lore-cleanup-orphan" },
    })
    // No element of the outer `and:` is itself wrapped in `{ and: }`.
    for (const clause of args.filter.and!) {
      expect(clause).not.toHaveProperty("and")
    }
  })
})

// ---------------------------------------------------------------------------
// queryStaleConfidence — wake-up Stale Confidence subsection (issue 0.8.0/#10)
// ---------------------------------------------------------------------------

describe("MemoryService.queryStaleConfidence", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }
  const TODAY = "2026-04-29"

  function buildStalePage(
    id: string,
    extras: {
      confidenceScore?: number | null
      lastReferencedAt?: string | null
      archived?: boolean
    } = {}
  ): PageObjectResponse {
    const props: Record<string, unknown> = {
      Title: { type: "title", title: [{ plain_text: id }] },
      Project: { type: "relation", relation: [] },
      Topic: { type: "relation", relation: [] },
      Source: { type: "select", select: { name: "manual" } },
      Author: { type: "rich_text", rich_text: [] },
      Agent: { type: "rich_text", rich_text: [] },
      Tags: { type: "multi_select", multi_select: [] },
      Session: { type: "rich_text", rich_text: [] },
    }
    if (extras.confidenceScore !== undefined) {
      props["Confidence Score"] = { type: "number", number: extras.confidenceScore }
    }
    if (extras.lastReferencedAt !== undefined) {
      props["Last Referenced At"] = {
        type: "date",
        date: extras.lastReferencedAt ? { start: extras.lastReferencedAt } : null,
      }
    }
    return buildPage(props, { id, archived: extras.archived ?? false })
  }

  function makeQueryClient(pages: PageObjectResponse[]) {
    const querySpy = vi.fn(async (_args: Record<string, unknown>) => ({
      object: "list" as const,
      results: pages,
      has_more: false,
      next_cursor: null,
      type: "page_or_database" as const,
      page_or_database: {},
    }))
    const client = {
      dataSources: { query: querySpy },
    } as unknown as Client
    return { client, querySpy }
  }

  it("composes the projectOrUnscopedFilter when projectId is supplied", async () => {
    const { client, querySpy } = makeQueryClient([])
    const service = new MemoryService(client, db)

    await service.queryStaleConfidence({
      projectId: "proj-1",
      limit: 5,
      today: TODAY,
    })

    const filter = querySpy.mock.calls[0][0]["filter"] as {
      and: Array<Record<string, unknown>>
    }
    expect(filter.and).toEqual(
      expect.arrayContaining([
        {
          or: [
            { property: "Project", relation: { contains: "proj-1" } },
            { property: "Project", relation: { is_empty: true } },
          ],
        },
      ])
    )
  })

  it("omits the project clause for vault-wide wake-up (projectId undefined)", async () => {
    // Vault-wide wake-up: handleWakeUp running without a resolved
    // project (cwd outside any configured project). Without this
    // branch, an unconditional `projectOrUnscopedFilter(undefined)`
    // would either produce a Notion filter error or silently filter
    // to memories whose Project relation contains the literal
    // `undefined` (zero rows).
    const { client, querySpy } = makeQueryClient([])
    const service = new MemoryService(client, db)

    await service.queryStaleConfidence({ limit: 5, today: TODAY })

    const filter = querySpy.mock.calls[0][0]["filter"] as {
      and: Array<Record<string, unknown>>
    }
    // No `Project` clause ANYWHERE in the filter — checked via a deep
    // serialized scan rather than per-clause shape assertions because
    // a future refactor that nests the filter in additional and/or
    // envelopes would let a leaked Project clause pass per-clause
    // checks while still being structurally present. The serialized
    // form catches both the current top-level shape and any future
    // nested form.
    expect(JSON.stringify(filter)).not.toContain('"property":"Project"')
    // Surviving clauses (`is_not_empty` + the score-or-neglect OR)
    // are pinned positively below so a refactor that DROPS them is
    // also caught.
    expect(filter.and).toEqual(
      expect.arrayContaining([
        { property: "Confidence Score", number: { is_not_empty: true } },
      ])
    )
  })

  it("includes the is_not_empty guard so pre-migration rows are excluded", async () => {
    const { client, querySpy } = makeQueryClient([])
    const service = new MemoryService(client, db)

    await service.queryStaleConfidence({ limit: 5, today: TODAY })

    const filter = querySpy.mock.calls[0][0]["filter"] as {
      and: Array<Record<string, unknown>>
    }
    expect(filter.and).toEqual(
      expect.arrayContaining([
        { property: "Confidence Score", number: { is_not_empty: true } },
      ])
    )
  })

  it("composes the load-bearing OR clause: low-score OR neglected", async () => {
    // The neglect-OR clause is what surfaces a memory at stored 0.9
    // touched 6 months ago — RRF reads stored values verbatim, so
    // without this branch a never-disturbed high-score row never
    // gets triaged. `today - STALE_CONFIDENCE_DAYS` (60) =
    // 2026-02-28 (60 days before 2026-04-29).
    const { client, querySpy } = makeQueryClient([])
    const service = new MemoryService(client, db)

    await service.queryStaleConfidence({ limit: 5, today: TODAY })

    const filter = querySpy.mock.calls[0][0]["filter"] as {
      and: Array<Record<string, unknown>>
    }
    expect(filter.and).toEqual(
      expect.arrayContaining([
        {
          or: [
            { property: "Confidence Score", number: { less_than: 0.5 } },
            { property: "Last Referenced At", date: { on_or_before: "2026-02-28" } },
          ],
        },
      ])
    )
  })

  it("sorts by Confidence Score ascending — most-decayed first", async () => {
    const { client, querySpy } = makeQueryClient([])
    const service = new MemoryService(client, db)

    await service.queryStaleConfidence({ limit: 5, today: TODAY })

    const args = querySpy.mock.calls[0][0]
    expect(args["sorts"]).toEqual([
      { property: "Confidence Score", direction: "ascending" },
    ])
  })

  it("requests a full page for refill efficiency", async () => {
    const { client, querySpy } = makeQueryClient([])
    const service = new MemoryService(client, db)

    await service.queryStaleConfidence({ limit: 5, today: TODAY })

    expect(querySpy.mock.calls[0][0]["page_size"]).toBe(100)
  })

  it("filters out archived rows client-side", async () => {
    // Notion's `dataSources.query` returns archived rows by default;
    // every Memories DS read in this codebase post-filters them out
    // (see `MemoryService.list`). Pin the same posture for the stale
    // section so a row archived after a heavy decrement doesn't
    // re-surface.
    const { client } = makeQueryClient([
      buildStalePage("live-1", {
        confidenceScore: 0.3,
        lastReferencedAt: "2026-04-25",
        archived: false,
      }),
      buildStalePage("archived-1", {
        confidenceScore: 0.1,
        lastReferencedAt: "2026-04-25",
        archived: true,
      }),
    ])
    const service = new MemoryService(client, db)

    const memories = await service.queryStaleConfidence({ limit: 5, today: TODAY })

    expect(memories.map((m) => m.id)).toEqual(["live-1"])
  })

  it("refills stale-confidence results past archived rows across pages", async () => {
    const querySpy = vi
      .fn()
      .mockResolvedValueOnce({
        object: "list" as const,
        results: [
          buildStalePage("archived-before", {
            confidenceScore: 0.1,
            archived: true,
          }),
          buildStalePage("live-1", { confidenceScore: 0.2 }),
          buildStalePage("archived-between", {
            confidenceScore: 0.1,
            archived: true,
          }),
        ],
        has_more: true,
        next_cursor: "cursor-1",
        type: "page_or_database" as const,
        page_or_database: {},
      })
      .mockResolvedValueOnce({
        object: "list" as const,
        results: [
          buildStalePage("live-2", { confidenceScore: 0.3 }),
          buildStalePage("archived-after", {
            confidenceScore: 0.4,
            archived: true,
          }),
        ],
        has_more: true,
        next_cursor: "cursor-2",
        type: "page_or_database" as const,
        page_or_database: {},
      })
      .mockResolvedValueOnce({
        object: "list" as const,
        results: [buildStalePage("live-3", { confidenceScore: 0.45 })],
        has_more: false,
        next_cursor: null,
        type: "page_or_database" as const,
        page_or_database: {},
      })
    const client = {
      dataSources: { query: querySpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const memories = await service.queryStaleConfidence({
      limit: 3,
      today: TODAY,
    })

    expect(memories.map((m) => m.id)).toEqual(["live-1", "live-2", "live-3"])
    expect(querySpy).toHaveBeenCalledTimes(3)
    expect(querySpy.mock.calls[1][0].start_cursor).toBe("cursor-1")
    expect(querySpy.mock.calls[2][0].start_cursor).toBe("cursor-2")
    expect(querySpy.mock.calls[0][0].page_size).toBe(100)
    expect(querySpy.mock.calls[1][0].page_size).toBe(100)
    expect(querySpy.mock.calls[2][0].page_size).toBe(100)
  })

  it("degrades to [] on `validation_error` from a pre-migration vault missing the Confidence Score column", async () => {
    // Production smoke test against an internal vault (vault hadn't run
    // `lore migrate` against the 0.8.0 schema yet) caught this:
    // Notion responds with `code: 'validation_error'`, message
    // "Could not find sort property with name or id: Confidence Score"
    // when the column doesn't exist on the DS. Without this guard the
    // failure propagates up through `loadWakeUpData`'s `Promise.all`
    // and fails the entire wake-up. Degrading to [] matches the
    // posture of `FactService.queryByEntityTextOnUnmigrated` and
    // `TaskService.countClosedSince`, both of which silently suppress
    // their 0.7.0/PF3-01 feature on pre-column vaults. The schema-
    // drift detector is the canonical "run lore migrate" nudge.
    const querySpy = vi.fn(async () => {
      const err = Object.assign(
        new Error("Could not find sort property with name or id: Confidence Score"),
        {
          code: "validation_error",
        }
      )
      throw err
    })
    const client = {
      dataSources: { query: querySpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const memories = await service.queryStaleConfidence({ limit: 5, today: TODAY })

    expect(memories).toEqual([])
    expect(querySpy).toHaveBeenCalledTimes(1)
  })

  it("propagates non-schema errors (transient 5xx / rate-limit / network) instead of masking them", async () => {
    // A 429 / 503 / network error MUST propagate so a real outage
    // surfaces to the operator rather than rendering as a silently-
    // empty section that's indistinguishable from a healthy empty
    // vault. `isMissingPropertyError` only matches `validation_error`
    // with a missing-property message; everything else throws.
    const querySpy = vi.fn(async () => {
      const err = Object.assign(new Error("rate_limited"), {
        code: "rate_limited",
        status: 429,
      })
      throw err
    })
    const client = {
      dataSources: { query: querySpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    await expect(
      service.queryStaleConfidence({ limit: 5, today: TODAY })
    ).rejects.toThrow("rate_limited")
  })

  it("returns Memory shapes with empty bodies — no markdown round-trip", async () => {
    // The wake-up subsection renders title + synopsis + trust label
    // + meta — never the body. Skipping `retrieveMarkdown` keeps the
    // section's per-row cost at exactly zero extra Notion calls.
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "should not be called" }))
    const querySpy = vi.fn(async () => ({
      object: "list" as const,
      results: [
        buildStalePage("m-1", {
          confidenceScore: 0.2,
          lastReferencedAt: "2026-04-25",
        }),
      ],
      has_more: false,
      next_cursor: null,
      type: "page_or_database" as const,
      page_or_database: {},
    }))
    const client = {
      dataSources: { query: querySpy },
      pages: { retrieveMarkdown: retrieveMarkdownSpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const memories = await service.queryStaleConfidence({ limit: 5, today: TODAY })

    expect(memories).toHaveLength(1)
    expect(memories[0].content).toBe("")
    expect(retrieveMarkdownSpy).not.toHaveBeenCalled()
  })
})

describe("pageToMemory — Compared With + Compare Notes (0.9.0/02)", () => {
  it("returns empty defaults on a pre-migration page (no Compared With or Compare Notes columns)", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Pre-#02 row" }] },
    })
    const memory = pageToMemory(page)
    expect(memory.comparedWith).toEqual([])
    expect(memory.compareNotes).toBe("")
  })

  it("extracts Compared With as a relation id list and Compare Notes as the joined NDJSON string", () => {
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "Compared row" }] },
      "Compared With": {
        type: "relation",
        relation: [{ id: "page-a" }, { id: "page-b" }],
      },
      "Compare Notes": {
        type: "rich_text",
        rich_text: [
          { plain_text: '{"verdict":"scoped","target":"page-a"}\n' },
          { plain_text: '{"verdict":"related","target":"page-b"}' },
        ],
      },
    })
    const memory = pageToMemory(page)
    expect(memory.comparedWith).toEqual(["page-a", "page-b"])
    expect(memory.compareNotes).toBe(
      '{"verdict":"scoped","target":"page-a"}\n{"verdict":"related","target":"page-b"}'
    )
  })

  it("round-trips through buildMemoryProps + pageToMemory for a populated entry", () => {
    const built = buildMemoryProps({
      title: "x",
      comparedWith: ["page-a"],
      compareNotes: '{"verdict":"scoped","target":"page-a"}',
    }) as Record<string, unknown>

    // Reconstruct a Notion-shaped page from buildMemoryProps's output and
    // confirm pageToMemory surfaces the same values back.
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "x" }] },
      "Compared With": {
        type: "relation",
        relation: (built["Compared With"] as { relation: { id: string }[] }).relation,
      },
      "Compare Notes": {
        type: "rich_text",
        rich_text: (
          built["Compare Notes"] as {
            rich_text: { text: { content: string }; plain_text?: string }[]
          }
        ).rich_text.map((r) => ({ plain_text: r.text.content })),
      },
    })
    const memory = pageToMemory(page)
    expect(memory.comparedWith).toEqual(["page-a"])
    expect(memory.compareNotes).toBe('{"verdict":"scoped","target":"page-a"}')
  })
})

describe("appendCompareNote (0.9.0/02)", () => {
  const sampleEntry = {
    verdict: "scoped",
    target: "page-a",
    affected: null,
    reason: "different projects",
    judgedAt: "2026-04-30",
    promptVersion: "1",
  }

  it("appends the JSON-serialized entry as the first line when existing is empty", () => {
    const next = appendCompareNote("", sampleEntry)
    expect(next).toBe(JSON.stringify(sampleEntry))
  })

  it("joins subsequent entries with a single newline (no trailing newline)", () => {
    const first = appendCompareNote("", sampleEntry)
    const second = appendCompareNote(first, {
      ...sampleEntry,
      verdict: "related",
      target: "page-b",
    })
    expect(second.split("\n")).toHaveLength(2)
    expect(second.endsWith("\n")).toBe(false)
  })

  it("throws with the documented overflow message when the next entry would push past the cap", () => {
    // Build an existing payload such that adding sampleEntry exceeds the
    // cap. JSON.stringify(sampleEntry) length is the same on every call,
    // so we pad the existing string to within one entry of the cap.
    const entryLen = JSON.stringify(sampleEntry).length
    const padTo = COMPARE_NOTES_MAX_CHARS - entryLen + 1
    const existing = "a".repeat(padTo)

    expect(() => appendCompareNote(existing, sampleEntry)).toThrow(
      /Compare Notes overflow/
    )
    expect(() => appendCompareNote(existing, sampleEntry)).toThrow(
      String(COMPARE_NOTES_MAX_CHARS)
    )
  })

  it("permits an entry that lands exactly at the cap (boundary: total === cap)", () => {
    // Boundary behavior — appending an entry where total length equals
    // COMPARE_NOTES_MAX_CHARS is allowed; only `>` triggers the throw.
    const entryLen = JSON.stringify(sampleEntry).length
    // existing + "\n" + entry must equal the cap exactly. So:
    //   existing.length = cap - entryLen - 1
    const existing = "a".repeat(COMPARE_NOTES_MAX_CHARS - entryLen - 1)
    const next = appendCompareNote(existing, sampleEntry)
    expect(next.length).toBe(COMPARE_NOTES_MAX_CHARS)
  })

  it("permits an entry that lands one byte under the cap (boundary: total === cap - 1)", () => {
    // Pin the `<` side of the strict-`>` overflow check: an append
    // ending one byte under the cap stays comfortably inside.
    const entryLen = JSON.stringify(sampleEntry).length
    const existing = "a".repeat(COMPARE_NOTES_MAX_CHARS - entryLen - 2)
    const next = appendCompareNote(existing, sampleEntry)
    expect(next.length).toBe(COMPARE_NOTES_MAX_CHARS - 1)
  })

  it("rejects an entry that would land one byte over the cap (boundary: total === cap + 1)", () => {
    // Pin the strict-`>` overflow contract: a single byte past the cap
    // throws. Together with the `=== cap` and `=== cap - 1` boundary
    // pins above, this fixes the throw threshold at exactly `> cap`.
    const entryLen = JSON.stringify(sampleEntry).length
    const existing = "a".repeat(COMPARE_NOTES_MAX_CHARS - entryLen)
    expect(() => appendCompareNote(existing, sampleEntry)).toThrow(
      /Compare Notes overflow/
    )
  })
})

describe("encodeCompareNotesRichText (0.9.0/02)", () => {
  it("returns an empty array when the input is empty (Notion treats this as a clear)", () => {
    expect(encodeCompareNotesRichText("")).toEqual([])
  })

  it("permits an input that lands exactly at COMPARE_NOTES_MAX_CHARS (boundary)", () => {
    // The encoder's cap check is strict-`>`, mirroring `appendCompareNote`'s
    // overflow contract. Exactly-at-cap input encodes successfully; only
    // `> cap` throws.
    const atCap = "a".repeat(COMPARE_NOTES_MAX_CHARS)
    const chunks = encodeCompareNotesRichText(atCap)
    expect(chunks.length).toBeGreaterThan(0)
    // Reassemble: the chunked payload's content concatenated equals the
    // input (the encoder doesn't transform content, only chunks it).
    const joined = chunks
      .map((c) => (c as { text: { content: string } }).text.content)
      .join("")
    expect(joined).toBe(atCap)
  })

  it("throws with the documented overflow message when input exceeds COMPARE_NOTES_MAX_CHARS", () => {
    // The encoder is the chokepoint cap. Any caller — `buildMemoryProps`,
    // a future migration that synthesizes a Compare Notes string from
    // external data, #05's compare-write path bypassing `appendCompareNote`
    // — hits the same threshold here, so an over-cap rich_text payload
    // can never reach Notion.
    const overCap = "a".repeat(COMPARE_NOTES_MAX_CHARS + 1)
    expect(() => encodeCompareNotesRichText(overCap)).toThrow(/Compare Notes overflow/)
    expect(() => encodeCompareNotesRichText(overCap)).toThrow(
      String(COMPARE_NOTES_MAX_CHARS)
    )
    // The error names the input length too so the operator can quickly
    // see how far over the cap they are.
    expect(() => encodeCompareNotesRichText(overCap)).toThrow(
      String(COMPARE_NOTES_MAX_CHARS + 1)
    )
  })

  it("emits a single text sub-block when content fits within the chunk budget", () => {
    const notes = '{"verdict":"scoped","target":"page-a"}'
    const chunks = encodeCompareNotesRichText(notes)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual({ type: "text", text: { content: notes } })
  })

  it("splits across the 1900-char boundary into exactly two sub-blocks for a 3000-char input", () => {
    const notes = "a".repeat(3000)
    const chunks = encodeCompareNotesRichText(notes)
    expect(chunks).toHaveLength(2)
    // First chunk fills the 1900-char budget; second carries the remainder.
    const first = chunks[0] as { type: "text"; text: { content: string } }
    const second = chunks[1] as { type: "text"; text: { content: string } }
    expect(first.text.content).toHaveLength(1900)
    expect(second.text.content).toHaveLength(1100)
    expect(first.text.content + second.text.content).toBe(notes)
  })

  it("round-trips a multi-line NDJSON payload through extractRichText (across the chunk boundary)", () => {
    // Build NDJSON with several entries totalling more than one chunk's
    // worth of characters. Round-tripping through `extractRichText`
    // confirms the chunk boundaries don't corrupt newlines and
    // pre-migration reads (where Notion returns multiple `text`
    // sub-blocks) reconstruct cleanly.
    const lines: string[] = []
    for (let i = 0; i < 30; i++) {
      lines.push(
        JSON.stringify({
          verdict: "scoped",
          target: `page-${i}`,
          reason: "lorem ipsum dolor sit amet consectetur adipiscing elit",
          judgedAt: "2026-04-30",
          promptVersion: "1",
        })
      )
    }
    const payload = lines.join("\n")
    expect(payload.length).toBeGreaterThan(1900)

    const chunks = encodeCompareNotesRichText(payload)
    // Reconstruct as a Notion property using each chunk's text.content as
    // its plain_text — that's how Notion serializes `text` sub-blocks on
    // read. `pageToMemory` consumes this same shape via `extractRichText`.
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "round-trip" }] },
      "Compare Notes": {
        type: "rich_text",
        rich_text: chunks.map((c) => ({
          plain_text: (c as { type: "text"; text: { content: string } }).text.content,
        })),
      },
    })
    expect(pageToMemory(page).compareNotes).toBe(payload)
  })

  it("emits exactly one block per 1900 chars at the boundary (boundary slicing pin)", () => {
    // Three boundary lengths: 1899 (one block, just under), 1900 (one
    // block, exactly the budget), 1901 (two blocks, just over). Pins
    // the slicing arithmetic so a future contributor reordering
    // `i + CHUNK` vs `slice(i, i + CHUNK)` can't silently shift the
    // boundary. The 1901 case lands in the single-line fallback path
    // (the input is one NDJSON line that exceeds the budget).
    expect(encodeCompareNotesRichText("a".repeat(1899))).toHaveLength(1)
    expect(encodeCompareNotesRichText("a".repeat(1900))).toHaveLength(1)
    expect(encodeCompareNotesRichText("a".repeat(1901))).toHaveLength(2)
  })

  it("splits at NDJSON line boundaries when cumulative length exceeds the chunk budget", () => {
    // Two ~1500-char NDJSON entries totalling 3001 chars. With
    // line-boundary chunking, each entry lands in its own sub-block;
    // a naive fixed-stride char-slice would put part of entry 1 in
    // chunk 2, fragmenting Notion's per-block full-text search index.
    const e1 = "x".repeat(1500)
    const e2 = "y".repeat(1500)
    const notes = e1 + "\n" + e2
    const chunks = encodeCompareNotesRichText(notes)
    expect(chunks).toHaveLength(2)
    // First chunk is the first entry verbatim (no leading "\n").
    expect((chunks[0] as { text: { content: string } }).text.content).toBe(e1)
    // Second chunk preserves the leading "\n" separator so an
    // `extractRichText` concatenation (which inserts no separators)
    // reconstructs the original NDJSON byte-for-byte.
    expect((chunks[1] as { text: { content: string } }).text.content).toBe("\n" + e2)
  })

  it("packs multiple entries into one chunk when they collectively fit", () => {
    // Three small entries totalling well under 1900 chars stay in a
    // single sub-block. Pins the "fill, don't fragment" behavior so
    // a future contributor can't silently revert to one-block-per-entry.
    const e1 = '{"verdict":"scoped","target":"a"}'
    const e2 = '{"verdict":"related","target":"b"}'
    const e3 = '{"verdict":"compatible","target":"c"}'
    const notes = [e1, e2, e3].join("\n")
    const chunks = encodeCompareNotesRichText(notes)
    expect(chunks).toHaveLength(1)
    expect((chunks[0] as { text: { content: string } }).text.content).toBe(notes)
  })

  it("preserves astral codepoints in NDJSON entries via line-boundary splits", () => {
    // The line-boundary path is inherently surrogate-safe because
    // JSON.stringify never emits a literal "\n" between the two
    // halves of a UTF-16 surrogate pair. Build NDJSON with an emoji
    // (🟢 = U+1F7E2 → surrogate pair D83D DFE2) inside a `reason`
    // field positioned to land exactly at the boundary, and confirm
    // the round-trip preserves the codepoint.
    const reasonPad = "x".repeat(1850)
    const e1 = JSON.stringify({
      verdict: "scoped",
      target: "page-a",
      reason: reasonPad + "🟢",
      judgedAt: "2026-04-30",
      promptVersion: "1",
    })
    const e2 = JSON.stringify({
      verdict: "related",
      target: "page-b",
      reason: "🔴 second entry",
      judgedAt: "2026-04-30",
      promptVersion: "1",
    })
    const notes = e1 + "\n" + e2
    expect(notes.length).toBeGreaterThan(1900)

    const chunks = encodeCompareNotesRichText(notes)
    // Each emitted chunk must be a valid UTF-16 string (no lone
    // surrogates at either edge). Notion may normalize lone
    // surrogates server-side, so a well-formed write is the only
    // way to guarantee round-trip fidelity.
    for (const chunk of chunks) {
      const content = (chunk as { text: { content: string } }).text.content
      if (content.length === 0) continue
      const first = content.charCodeAt(0)
      const last = content.charCodeAt(content.length - 1)
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    }

    // Round-trip via extractRichText reconstructs the original NDJSON
    // byte-for-byte. The emoji codepoints survive intact.
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "x" }] },
      "Compare Notes": {
        type: "rich_text",
        rich_text: chunks.map((c) => ({
          plain_text: (c as { text: { content: string } }).text.content,
        })),
      },
    })
    expect(pageToMemory(page).compareNotes).toBe(notes)
  })

  it("backs off from a UTF-16 surrogate pair in the single-line fallback path", () => {
    // The fallback only fires for a single NDJSON entry exceeding the
    // chunk budget — rare in practice, but if it does, the char-slice
    // must not split a surrogate pair. Construct an input with a
    // surrogate pair landing exactly at the chunk boundary and assert
    // (a) no chunk holds a lone surrogate at either edge, and (b)
    // round-trip via `extractRichText` recovers the original.
    //
    // Place the astral codepoint 𝓐 (U+1D4D0 → surrogate pair D835
    // DCD0) starting at index 1899 of a 2001-char single-line input.
    // Naive slicing at index 1900 would split D835 (chunk 1's last
    // char) from DCD0 (chunk 2's first char).
    const padding = "a".repeat(1899)
    const tail = "a".repeat(100)
    const notes = padding + "𝓐" + tail
    expect(notes.length).toBe(2001)
    expect(notes.includes("\n")).toBe(false) // forces fallback path

    const chunks = encodeCompareNotesRichText(notes)
    expect(chunks.length).toBeGreaterThan(1)

    // No chunk may end with a high surrogate (D800-DBFF) or start
    // with a low surrogate (DC00-DFFF) — that's the surrogate-safe
    // contract.
    for (const chunk of chunks) {
      const content = (chunk as { text: { content: string } }).text.content
      if (content.length === 0) continue
      const first = content.charCodeAt(0)
      const last = content.charCodeAt(content.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false)
    }

    // Round-trip recovers the original codepoint intact.
    const page = buildPage({
      Title: { type: "title", title: [{ plain_text: "x" }] },
      "Compare Notes": {
        type: "rich_text",
        rich_text: chunks.map((c) => ({
          plain_text: (c as { text: { content: string } }).text.content,
        })),
      },
    })
    expect(pageToMemory(page).compareNotes).toBe(notes)
  })
})

describe("hasMatchingCompareNote (0.9.0/05)", () => {
  it("returns false on an empty notes string (no entries to match)", () => {
    expect(
      hasMatchingCompareNote("", {
        target: "page-a",
        verdict: "scoped",
        affected: null,
      })
    ).toBe(false)
  })

  it("returns true when a line matches target, verdict, and affected (symmetric verdict, affected: null on both sides)", () => {
    const notes = JSON.stringify({
      verdict: "scoped",
      target: "page-a",
      affected: null,
      reason: "different projects",
      judgedAt: "2026-04-30",
      promptVersion: "1",
    })
    expect(
      hasMatchingCompareNote(notes, {
        target: "page-a",
        verdict: "scoped",
        affected: null,
      })
    ).toBe(true)
  })

  it("returns true for asymmetric verdict when target+verdict+affected all match", () => {
    const notes = JSON.stringify({
      verdict: "conflicts_with",
      target: "page-a",
      affected: "page-a",
      reason: "A loses",
      judgedAt: "2026-04-30",
      promptVersion: "1",
    })
    expect(
      hasMatchingCompareNote(notes, {
        target: "page-a",
        verdict: "conflicts_with",
        affected: "page-a",
      })
    ).toBe(true)
  })

  it("returns false when target+verdict match but affected differs (corrected-direction re-judgment must re-dispatch)", () => {
    // The reviewer's #2 finding pinned. After
    // `(A, B, conflicts_with, affected=B)` the entry on A's notes
    // is `{target: B, affected: B}`. A corrected call
    // `(A, B, conflicts_with, affected=A)` queries B's notes for
    // `{target: A, affected: A}` — and B's notes also have
    // `{target: A, affected: B}` (the same prior verdict mirrored on
    // B's side). The mismatch on `affected` MUST surface as no-match
    // so the dispatch fires and A's confidence finally halves.
    const notes = JSON.stringify({
      verdict: "conflicts_with",
      target: "page-a",
      affected: "page-b",
      reason: "B loses (prior call)",
      judgedAt: "2026-04-30",
      promptVersion: "1",
    })
    expect(
      hasMatchingCompareNote(notes, {
        target: "page-a",
        verdict: "conflicts_with",
        affected: "page-a", // corrected direction
      })
    ).toBe(false)
  })

  it("returns false when target matches but verdict differs", () => {
    // Documents the "verdict change is allowed" contract — a prior
    // `not_conflict` entry must NOT suppress a fresh `conflicts_with`
    // judgment on the same pair.
    const notes = JSON.stringify({
      verdict: "not_conflict",
      target: "page-a",
      affected: null,
      reason: "unrelated",
      judgedAt: "2026-04-30",
      promptVersion: "1",
    })
    expect(
      hasMatchingCompareNote(notes, {
        target: "page-a",
        verdict: "conflicts_with",
        affected: "page-a",
      })
    ).toBe(false)
  })

  it("returns false when verdict matches but target differs", () => {
    // Pair-scoped: a `scoped` verdict against a different counterpart
    // is a different pair entirely. The check must NOT collapse on
    // verdict alone.
    const notes = JSON.stringify({
      verdict: "scoped",
      target: "page-other",
      affected: null,
      reason: "different projects",
      judgedAt: "2026-04-30",
      promptVersion: "1",
    })
    expect(
      hasMatchingCompareNote(notes, {
        target: "page-a",
        verdict: "scoped",
        affected: null,
      })
    ).toBe(false)
  })

  it("scans every line in a multi-entry NDJSON payload", () => {
    const notes = [
      JSON.stringify({ verdict: "scoped", target: "page-other", affected: null }),
      JSON.stringify({ verdict: "related", target: "page-a", affected: null }),
      JSON.stringify({ verdict: "compatible", target: "page-third", affected: null }),
    ].join("\n")
    expect(
      hasMatchingCompareNote(notes, {
        target: "page-a",
        verdict: "related",
        affected: null,
      })
    ).toBe(true)
  })

  it("ignores blank lines without breaking the scan", () => {
    const notes =
      JSON.stringify({ verdict: "scoped", target: "page-a", affected: null }) +
      "\n\n" +
      JSON.stringify({ verdict: "related", target: "page-b", affected: null })
    expect(
      hasMatchingCompareNote(notes, {
        target: "page-a",
        verdict: "scoped",
        affected: null,
      })
    ).toBe(true)
    expect(
      hasMatchingCompareNote(notes, {
        target: "page-b",
        verdict: "related",
        affected: null,
      })
    ).toBe(true)
  })

  it("returns false on a malformed line — does NOT throw and does NOT gate the write", () => {
    // A malformed line must NOT short-circuit the lookup: the cost of
    // missing the dedup is one extra audit-trail line; the cost of
    // suppressing a legitimate dispatch is a silent no-op. So a parse
    // error skips the line and continues scanning later lines.
    const notes =
      "not-json{" +
      "\n" +
      JSON.stringify({ verdict: "scoped", target: "page-a", affected: null })
    expect(
      hasMatchingCompareNote(notes, {
        target: "page-a",
        verdict: "scoped",
        affected: null,
      })
    ).toBe(true)
  })

  it("treats a legacy entry without an `affected` field as `affected: null` (matches symmetric lookups)", () => {
    // Legacy entries written before this PR add the field. Coalesce
    // missing → null so a legacy symmetric-verdict entry still
    // matches a symmetric lookup and the gate fires correctly.
    const legacyNotes = JSON.stringify({
      verdict: "scoped",
      target: "page-a",
      reason: "legacy",
      judgedAt: "2026-04-30",
      promptVersion: "1",
    })
    expect(
      hasMatchingCompareNote(legacyNotes, {
        target: "page-a",
        verdict: "scoped",
        affected: null,
      })
    ).toBe(true)
  })

  it("ignores compare_dispatch ledger lines for final audit matching", () => {
    const ledger = buildCompareDispatchLedgerEntry({
      verdict: "conflicts_with",
      sourceMemoryId: "winner",
      affectedMemoryId: "loser",
    })
    const notes = appendCompareDispatchLedgerEntry("", ledger)

    expect(
      hasMatchingCompareNote(notes, {
        target: "winner",
        verdict: "conflicts_with",
        affected: "loser",
      })
    ).toBe(false)
    expect(
      hasCompareDispatchLedgerEntry(notes, {
        dispatchKey: ledger.dispatchKey,
        step: "confidence_decrement",
      })
    ).toBe(true)
  })
})

describe("compare dispatch ledger (issue #239)", () => {
  it("uses source, affected, verdict, and step as the retry marker key", () => {
    const ledger = buildCompareDispatchLedgerEntry({
      verdict: "supersedes",
      sourceMemoryId: "new-decision",
      affectedMemoryId: "old-decision",
    })
    const notes = appendCompareDispatchLedgerEntry("", ledger)

    expect(
      hasCompareDispatchLedgerEntry(notes, {
        dispatchKey: ledger.dispatchKey,
        step: "confidence_decrement",
      })
    ).toBe(true)
    expect(
      hasCompareDispatchLedgerEntry(notes, {
        dispatchKey: buildCompareDispatchLedgerEntry({
          verdict: "supersedes",
          sourceMemoryId: "other-decision",
          affectedMemoryId: "old-decision",
        }).dispatchKey,
        step: "confidence_decrement",
      })
    ).toBe(false)
  })
})

describe("MemoryService.recordCompared (0.9.0/05)", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  function makeMemoryShape(
    overrides: {
      id?: string
      comparedWith?: string[]
      compareNotes?: string
    } = {}
  ) {
    return {
      id: overrides.id ?? "m1",
      comparedWith: overrides.comparedWith ?? [],
      compareNotes: overrides.compareNotes ?? "",
    }
  }

  it("issues exactly two pages.update calls — one per side — with both Compared With and Compare Notes (symmetric verdict carries affected: null)", async () => {
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.recordCompared({
      memoryA: makeMemoryShape({ id: "page-a" }),
      memoryB: makeMemoryShape({ id: "page-b" }),
      verdict: "scoped",
      affected: null,
      reason: "different projects",
      judgedAt: "2026-04-30T00:00:00.000Z",
      promptVersion: "1",
    })

    expect(update).toHaveBeenCalledTimes(2)
    const calls = update.mock.calls.map(
      (c) =>
        c[0] as {
          page_id: string
          properties: Record<string, unknown>
        }
    )
    const sideA = calls.find((c) => c.page_id === "page-a")!
    const sideB = calls.find((c) => c.page_id === "page-b")!

    // Each side names its counterpart in Compared With.
    expect(
      (sideA.properties["Compared With"] as { relation: { id: string }[] }).relation
    ).toEqual([{ id: "page-b" }])
    expect(
      (sideB.properties["Compared With"] as { relation: { id: string }[] }).relation
    ).toEqual([{ id: "page-a" }])
    // Each side carries an NDJSON entry naming the OTHER memory.
    // Symmetric verdicts persist `affected: null` so the idempotency
    // gate distinguishes symmetric from asymmetric judgments stored
    // on the same pair.
    const notesA = (
      sideA.properties["Compare Notes"] as {
        rich_text: Array<{ text: { content: string } }>
      }
    ).rich_text
      .map((r) => r.text.content)
      .join("")
    const notesB = (
      sideB.properties["Compare Notes"] as {
        rich_text: Array<{ text: { content: string } }>
      }
    ).rich_text
      .map((r) => r.text.content)
      .join("")
    expect(JSON.parse(notesA)).toMatchObject({
      target: "page-b",
      verdict: "scoped",
      affected: null,
    })
    expect(JSON.parse(notesB)).toMatchObject({
      target: "page-a",
      verdict: "scoped",
      affected: null,
    })
  })

  it("persists the loser memory's id as `affected` on each side for asymmetric verdicts", async () => {
    // Direction is part of the pair-scoped idempotency key — both
    // sides record the loser's id so a corrected re-judgment with a
    // flipped affected side bypasses the gate and re-dispatches.
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.recordCompared({
      memoryA: makeMemoryShape({ id: "page-a" }),
      memoryB: makeMemoryShape({ id: "page-b" }),
      verdict: "conflicts_with",
      affected: "page-b",
      reason: "B loses",
      judgedAt: "2026-04-30T00:00:00.000Z",
      promptVersion: "1",
    })

    const calls = update.mock.calls.map(
      (c) =>
        c[0] as {
          page_id: string
          properties: Record<string, unknown>
        }
    )
    for (const call of calls) {
      const notes = (
        call.properties["Compare Notes"] as {
          rich_text: Array<{ text: { content: string } }>
        }
      ).rich_text
        .map((r) => r.text.content)
        .join("")
      const entry = JSON.parse(notes) as { affected: string }
      expect(entry.affected).toBe("page-b")
    }
  })

  it("appends the verdict to existing Compare Notes without rewriting earlier entries", async () => {
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    const priorEntry = JSON.stringify({
      verdict: "not_conflict",
      target: "page-b",
      affected: null,
      reason: "earlier judgment",
      judgedAt: "2026-04-29T00:00:00.000Z",
      promptVersion: "1",
    })

    await service.recordCompared({
      memoryA: makeMemoryShape({ id: "page-a", compareNotes: priorEntry }),
      memoryB: makeMemoryShape({ id: "page-b" }),
      verdict: "conflicts_with",
      affected: "page-b",
      reason: "actual contradiction",
      judgedAt: "2026-04-30T00:00:00.000Z",
      promptVersion: "1",
    })

    const sideA = update.mock.calls
      .map((c) => c[0] as { page_id: string; properties: Record<string, unknown> })
      .find((c) => c.page_id === "page-a")!
    const notes = (
      sideA.properties["Compare Notes"] as {
        rich_text: Array<{ text: { content: string } }>
      }
    ).rich_text
      .map((r) => r.text.content)
      .join("")
    const lines = notes.split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ verdict: "not_conflict" })
    expect(JSON.parse(lines[1]!)).toMatchObject({ verdict: "conflicts_with" })
  })

  it("does NOT duplicate the counterpart in Compared With when the relation already includes it", async () => {
    // A verdict change on a previously-judged pair (`not_conflict` →
    // `conflicts_with`) replays through `recordCompared` with both
    // memories' `comparedWith` already populated. The relation list
    // should NOT grow with a duplicate id — Notion's relation column
    // is set-semantic but the local compose step de-dupes anyway so
    // an over-long array isn't sent over the wire.
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.recordCompared({
      memoryA: makeMemoryShape({ id: "page-a", comparedWith: ["page-b"] }),
      memoryB: makeMemoryShape({ id: "page-b", comparedWith: ["page-a"] }),
      verdict: "conflicts_with",
      affected: "page-b",
      reason: "different verdict on same pair",
      judgedAt: "2026-04-30T00:00:00.000Z",
      promptVersion: "1",
    })

    for (const call of update.mock.calls) {
      const args = call[0] as { properties: Record<string, unknown> }
      const relation = (
        args.properties["Compared With"] as {
          relation: { id: string }[]
        }
      ).relation
      // Each side's relation has exactly one entry naming the
      // counterpart — not two.
      expect(relation).toHaveLength(1)
    }
  })

  it("throws via appendCompareNote when an over-cap append is composed (preflight contract)", async () => {
    // recordCompared's docstring requires the caller to preflight via
    // appendCompareNote BEFORE calling. If the caller skips the
    // preflight, the destructive path inside recordCompared still
    // catches the overflow — the error surfaces from the helper, NOT
    // from a partial write at Notion. Verifies that no pages.update
    // ever fires when the compose step throws.
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    // Pad memoryA's existing notes to within one entry of the cap.
    const sampleEntry = {
      verdict: "scoped",
      target: "page-b",
      affected: null,
      reason: "x",
      judgedAt: "2026-04-30T00:00:00.000Z",
      promptVersion: "1",
    }
    const entryLen = JSON.stringify(sampleEntry).length
    const padTo = COMPARE_NOTES_MAX_CHARS - entryLen + 1
    const overflowing = "a".repeat(padTo)

    await expect(
      service.recordCompared({
        memoryA: makeMemoryShape({ id: "page-a", compareNotes: overflowing }),
        memoryB: makeMemoryShape({ id: "page-b" }),
        verdict: "scoped",
        affected: null,
        reason: "x",
        judgedAt: "2026-04-30T00:00:00.000Z",
        promptVersion: "1",
      })
    ).rejects.toThrow(/Compare Notes overflow/)
    expect(update).not.toHaveBeenCalled()
  })

  it("returns { wroteA: true, wroteB: true } on a fresh judgment where neither side has the entry", async () => {
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    const result = await service.recordCompared({
      memoryA: makeMemoryShape({ id: "page-a" }),
      memoryB: makeMemoryShape({ id: "page-b" }),
      verdict: "scoped",
      affected: null,
      reason: "fresh",
      judgedAt: "2026-04-30T00:00:00.000Z",
      promptVersion: "1",
    })

    expect(result).toEqual({ wroteA: true, wroteB: true })
    expect(update).toHaveBeenCalledTimes(2)
  })

  it("per-side idempotent: skips A's pages.update when A's loaded snapshot already carries a matching entry, writes B alone", async () => {
    // The reviewer's [P2] regression at the service layer. Models a
    // partial-success state where the prior call landed A's update
    // but failed on B's. A retry MUST skip A (entry present) and
    // write B (entry missing). Result: { wroteA: false, wroteB: true }.
    const partialEntryOnA = JSON.stringify({
      verdict: "scoped",
      target: "page-b",
      affected: null,
      reason: "prior",
      judgedAt: "2026-04-29T00:00:00.000Z",
      promptVersion: "1",
    })
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    const result = await service.recordCompared({
      memoryA: makeMemoryShape({
        id: "page-a",
        compareNotes: partialEntryOnA,
        comparedWith: ["page-b"],
      }),
      memoryB: makeMemoryShape({ id: "page-b" }),
      verdict: "scoped",
      affected: null,
      reason: "retry — same target, verdict, affected",
      judgedAt: "2026-04-30T00:00:00.000Z",
      promptVersion: "1",
    })

    expect(result).toEqual({ wroteA: false, wroteB: true })
    expect(update).toHaveBeenCalledTimes(1)
    expect((update.mock.calls[0]![0] as { page_id: string }).page_id).toBe("page-b")
  })

  it("per-side idempotent (mirror): skips B and writes A when only B carried the entry", async () => {
    const partialEntryOnB = JSON.stringify({
      verdict: "scoped",
      target: "page-a",
      affected: null,
      reason: "prior",
      judgedAt: "2026-04-29T00:00:00.000Z",
      promptVersion: "1",
    })
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    const result = await service.recordCompared({
      memoryA: makeMemoryShape({ id: "page-a" }),
      memoryB: makeMemoryShape({
        id: "page-b",
        compareNotes: partialEntryOnB,
        comparedWith: ["page-a"],
      }),
      verdict: "scoped",
      affected: null,
      reason: "retry",
      judgedAt: "2026-04-30T00:00:00.000Z",
      promptVersion: "1",
    })

    expect(result).toEqual({ wroteA: true, wroteB: false })
    expect(update).toHaveBeenCalledTimes(1)
    expect((update.mock.calls[0]![0] as { page_id: string }).page_id).toBe("page-a")
  })

  it("per-side idempotent: returns { wroteA: false, wroteB: false } and issues ZERO updates when both sides already carry the entry", async () => {
    // The handler-level both-sides gate normally short-circuits before
    // reaching this method when both sides have the entry, but the
    // service-level no-op behavior is the safety net. Both flags
    // false signals "nothing actually written this call."
    const entryOnA = JSON.stringify({
      verdict: "scoped",
      target: "page-b",
      affected: null,
      reason: "prior",
      judgedAt: "2026-04-29T00:00:00.000Z",
      promptVersion: "1",
    })
    const entryOnB = JSON.stringify({
      verdict: "scoped",
      target: "page-a",
      affected: null,
      reason: "prior",
      judgedAt: "2026-04-29T00:00:00.000Z",
      promptVersion: "1",
    })
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    const result = await service.recordCompared({
      memoryA: makeMemoryShape({
        id: "page-a",
        compareNotes: entryOnA,
        comparedWith: ["page-b"],
      }),
      memoryB: makeMemoryShape({
        id: "page-b",
        compareNotes: entryOnB,
        comparedWith: ["page-a"],
      }),
      verdict: "scoped",
      affected: null,
      reason: "service-level no-op — handler gate normally short-circuits this",
      judgedAt: "2026-04-30T00:00:00.000Z",
      promptVersion: "1",
    })

    expect(result).toEqual({ wroteA: false, wroteB: false })
    expect(update).not.toHaveBeenCalled()
  })

  it("forceWrite persists a ledger on a side that already has the final audit without duplicating the audit line", async () => {
    const entryOnB = JSON.stringify({
      verdict: "conflicts_with",
      target: "page-a",
      affected: "page-b",
      reason: "prior",
      judgedAt: "2026-04-29T00:00:00.000Z",
      promptVersion: "1",
    })
    const ledger = buildCompareDispatchLedgerEntry({
      verdict: "conflicts_with",
      sourceMemoryId: "page-a",
      affectedMemoryId: "page-b",
    })
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    const result = await service.recordCompared({
      memoryA: makeMemoryShape({ id: "page-a" }),
      memoryB: makeMemoryShape({
        id: "page-b",
        comparedWith: ["page-a"],
        compareNotes: appendCompareDispatchLedgerEntry(entryOnB, ledger),
      }),
      verdict: "conflicts_with",
      affected: "page-b",
      reason: "repair",
      judgedAt: "2026-04-30T00:00:00.000Z",
      promptVersion: "1",
      forceWriteB: true,
    })

    expect(result).toEqual({ wroteA: true, wroteB: true })
    expect(update).toHaveBeenCalledTimes(2)
    const sideB = update.mock.calls
      .map((c) => c[0] as { page_id: string; properties: Record<string, unknown> })
      .find((c) => c.page_id === "page-b")!
    const notesB = (
      sideB.properties["Compare Notes"] as {
        rich_text: Array<{ text: { content: string } }>
      }
    ).rich_text
      .map((r) => r.text.content)
      .join("")
    const lines = notesB.split("\n").map(
      (line) =>
        JSON.parse(line) as {
          entryType?: string
          verdict?: string
        }
    )
    expect(
      lines.filter(
        (line) =>
          line.entryType !== "compare_dispatch" && line.verdict === "conflicts_with"
      )
    ).toHaveLength(1)
    expect(lines.some((line) => line.entryType === "compare_dispatch")).toBe(true)
  })

  it("per-side idempotency keys on (target, verdict, affected) — a different verdict on the same pair triggers a fresh write on both sides", async () => {
    // The skip key is (target, verdict, affected), not just target.
    // A prior `not_conflict` entry must NOT cause a fresh
    // `conflicts_with` retry to skip the side. Pin: existing
    // not_conflict on A + empty B → fresh conflicts_with retry
    // writes both sides.
    const priorNotConflict = JSON.stringify({
      verdict: "not_conflict",
      target: "page-b",
      affected: null,
      reason: "earlier",
      judgedAt: "2026-04-29T00:00:00.000Z",
      promptVersion: "1",
    })
    const update = vi.fn(
      async (_args: { page_id: string; properties: Record<string, unknown> }) => undefined
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    const result = await service.recordCompared({
      memoryA: makeMemoryShape({ id: "page-a", compareNotes: priorNotConflict }),
      memoryB: makeMemoryShape({ id: "page-b" }),
      verdict: "conflicts_with",
      affected: "page-b",
      reason: "actually a conflict",
      judgedAt: "2026-04-30T00:00:00.000Z",
      promptVersion: "1",
    })

    // Both sides write — A appends conflicts_with alongside the
    // prior not_conflict; B writes its first entry.
    expect(result).toEqual({ wroteA: true, wroteB: true })
    expect(update).toHaveBeenCalledTimes(2)
  })

  it("partial-write: throws RecordComparedPartialWriteError when side B rejects but side A landed", async () => {
    // Issue #471 — `Promise.all` rejected on first failure and discarded
    // the concurrent success, leaving the caller unable to distinguish
    // "both failed" from "A landed, B failed." `Promise.allSettled` plus
    // the structured error preserves the partial-success signal so the
    // MCP handler can self-heal on retry without duplicating A's audit
    // line.
    const update = vi.fn(
      async (args: { page_id: string; properties: Record<string, unknown> }) => {
        if (args.page_id === "page-b") {
          throw new Error("notion 503 — page-b update rejected")
        }
        return undefined
      }
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    let thrown: unknown
    try {
      await service.recordCompared({
        memoryA: makeMemoryShape({ id: "page-a" }),
        memoryB: makeMemoryShape({ id: "page-b" }),
        verdict: "scoped",
        affected: null,
        reason: "partial",
        judgedAt: "2026-04-30T00:00:00.000Z",
        promptVersion: "1",
      })
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(RecordComparedPartialWriteError)
    const partial = thrown as RecordComparedPartialWriteError
    expect(partial.failedSide).toBe("B")
    // The result reflects what actually landed: A wrote, B did not.
    expect(partial.result).toEqual({ wroteA: true, wroteB: false })
    // The underlying SDK error is reachable via `cause` for diagnosis.
    expect(partial.cause).toBeInstanceOf(Error)
    expect((partial.cause as Error).message).toContain("page-b update rejected")
    // BOTH writes were attempted — Promise.allSettled does not
    // short-circuit. The successful one landed in Notion.
    expect(update).toHaveBeenCalledTimes(2)
    const aCall = update.mock.calls.find((c) => c[0]!.page_id === "page-a")
    expect(aCall).toBeDefined()
  })

  it("partial-write (mirror): throws RecordComparedPartialWriteError with failedSide='A' when side A rejects but side B landed", async () => {
    const update = vi.fn(
      async (args: { page_id: string; properties: Record<string, unknown> }) => {
        if (args.page_id === "page-a") {
          throw new Error("notion 503 — page-a update rejected")
        }
        return undefined
      }
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    let thrown: unknown
    try {
      await service.recordCompared({
        memoryA: makeMemoryShape({ id: "page-a" }),
        memoryB: makeMemoryShape({ id: "page-b" }),
        verdict: "scoped",
        affected: null,
        reason: "partial mirror",
        judgedAt: "2026-04-30T00:00:00.000Z",
        promptVersion: "1",
      })
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(RecordComparedPartialWriteError)
    const partial = thrown as RecordComparedPartialWriteError
    expect(partial.failedSide).toBe("A")
    expect(partial.result).toEqual({ wroteA: false, wroteB: true })
  })

  it("both-writes-fail: throws the underlying rejection (NOT RecordComparedPartialWriteError) — retry safe via per-side idempotency", async () => {
    // No partial-success state to surface, so no structured error is
    // warranted. The thrown error is the first underlying rejection so
    // the caller's existing retry posture (per-side idempotency on a
    // fresh snapshot) handles it cleanly. A `RecordComparedPartialWriteError`
    // here would imply a partial success that didn't happen.
    const aRejection = new Error("notion 500 — page-a")
    const bRejection = new Error("notion 500 — page-b")
    const update = vi.fn(
      async (args: { page_id: string; properties: Record<string, unknown> }) => {
        if (args.page_id === "page-a") throw aRejection
        if (args.page_id === "page-b") throw bRejection
        return undefined
      }
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    let thrown: unknown
    try {
      await service.recordCompared({
        memoryA: makeMemoryShape({ id: "page-a" }),
        memoryB: makeMemoryShape({ id: "page-b" }),
        verdict: "scoped",
        affected: null,
        reason: "both fail",
        judgedAt: "2026-04-30T00:00:00.000Z",
        promptVersion: "1",
      })
    } catch (err) {
      thrown = err
    }

    expect(thrown).not.toBeInstanceOf(RecordComparedPartialWriteError)
    expect(thrown).toBe(aRejection)
    // Both writes were attempted (Promise.allSettled).
    expect(update).toHaveBeenCalledTimes(2)
  })

  it("partial-write where one side was idempotent-skipped: failedSide names the only side that was attempted, the survivor 'was already present'", async () => {
    // Edge case: side A was skipped via per-side idempotency (already
    // had matching entry from a prior call), and side B's solo write
    // rejected. Result reports the skipped side as `wroteA: false` and
    // names B as the failedSide — the survivor's audit entry is durable
    // (it was already in Notion before this call), so the partial-write
    // surface is structurally identical to the "A landed, B failed" case
    // for retry purposes.
    const partialEntryOnA = JSON.stringify({
      verdict: "scoped",
      target: "page-b",
      affected: null,
      reason: "prior",
      judgedAt: "2026-04-29T00:00:00.000Z",
      promptVersion: "1",
    })
    const update = vi.fn(
      async (args: { page_id: string; properties: Record<string, unknown> }) => {
        if (args.page_id === "page-b") {
          throw new Error("notion 503 — page-b update rejected")
        }
        return undefined
      }
    )
    const client = { pages: { update } } as unknown as Client
    const service = new MemoryService(client, db)

    let thrown: unknown
    try {
      await service.recordCompared({
        memoryA: makeMemoryShape({
          id: "page-a",
          compareNotes: partialEntryOnA,
          comparedWith: ["page-b"],
        }),
        memoryB: makeMemoryShape({ id: "page-b" }),
        verdict: "scoped",
        affected: null,
        reason: "skip-A, fail-B",
        judgedAt: "2026-04-30T00:00:00.000Z",
        promptVersion: "1",
      })
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(RecordComparedPartialWriteError)
    const partial = thrown as RecordComparedPartialWriteError
    expect(partial.failedSide).toBe("B")
    expect(partial.result).toEqual({ wroteA: false, wroteB: false })
    // Only side B was attempted — A was skipped via per-side idempotency.
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0]![0]!.page_id).toBe("page-b")
  })
})

describe("recordContradiction (0.9.0/05)", () => {
  function memShape(
    overrides: {
      id?: string
      title?: string
      projectIds?: string[]
      confidence?: "certain" | "likely" | "speculative"
      confidenceScore?: number | null
      lastReferencedAt?: string | null
      createdAt?: string
    } = {}
  ) {
    return {
      id: overrides.id ?? "m1",
      title: overrides.title ?? "Memory",
      projectIds: overrides.projectIds ?? ["proj-a"],
      confidence: overrides.confidence ?? ("certain" as const),
      confidenceScore: overrides.confidenceScore ?? 0.9,
      lastReferencedAt: overrides.lastReferencedAt ?? "2026-04-30",
      createdAt: overrides.createdAt ?? "2026-04-29T00:00:00.000Z",
    }
  }

  function makeMockServices(
    opts: {
      decrementConfidence?: ReturnType<typeof vi.fn>
      createWithDedup?: ReturnType<typeof vi.fn>
      supersede?: ReturnType<typeof vi.fn>
    } = {}
  ) {
    return {
      memories: {
        decrementConfidence:
          opts.decrementConfidence ?? vi.fn(async (_m: unknown) => 0.45),
      },
      facts: {
        createWithDedup:
          opts.createWithDedup ??
          vi.fn(async (_input: unknown) => ({
            fact: { id: "fact-1" },
            deduped: false,
          })),
      },
      decisions: { supersede: opts.supersede ?? vi.fn(async () => undefined) },
    }
  }

  it("emits a conflicts_with fact FIRST, then decrements the contradicted memory's confidence", async () => {
    // Reorder is load-bearing for retry safety: the idempotent
    // createWithDedup runs first; the non-idempotent decrement runs
    // last so a fact-create failure leaves nothing destructive landed.
    // Verified by recording call order via a shared timeline counter.
    const calls: string[] = []
    const decrementConfidence = vi.fn(async (_m: unknown) => {
      calls.push("decrement")
      return 0.45
    })
    const createWithDedup = vi.fn(async (_input: unknown) => {
      calls.push("fact")
      return { fact: { id: "fact-1" }, deduped: false }
    })
    const services = makeMockServices({ decrementConfidence, createWithDedup })

    const result = await recordContradiction(services, {
      contradictedMemory: memShape({ id: "loser", title: "Loser" }),
      sourceMemory: memShape({ id: "winner", title: "Winner" }),
      judgeConfidence: 0.9,
    })

    expect(calls).toEqual(["fact", "decrement"])
    expect(decrementConfidence.mock.calls[0]![0]).toMatchObject({ id: "loser" })
    const decrementCall = decrementConfidence.mock.calls[0] as unknown as [
      unknown,
      { compareNotes: string },
    ]
    const decrementOpts = decrementCall[1]
    expect(decrementOpts.compareNotes).toContain('"entryType":"compare_dispatch"')
    expect(decrementOpts.compareNotes).toContain('"affected":"loser"')
    expect(createWithDedup.mock.calls[0]![0]).toMatchObject({
      subject: "Winner",
      predicate: "conflicts_with",
      object: "Loser",
      sourceMemoryId: "winner",
      confidence: "certain", // judgeConfidence 0.9 → certain (>= 0.85)
    })
    expect(result.factId).toBe("fact-1")
    expect(result.decremented).toBe(true)
  })

  it("does NOT decrement when the fact create fails (retry-safe — nothing destructive landed)", async () => {
    const decrementConfidence = vi.fn(async (_m: unknown) => 0.45)
    const createWithDedup = vi.fn(async (_input: unknown) => {
      throw new Error("notion 500 — fact create failed")
    })
    const services = makeMockServices({ decrementConfidence, createWithDedup })

    await expect(
      recordContradiction(services, {
        contradictedMemory: memShape({ id: "loser", title: "L" }),
        sourceMemory: memShape({ id: "winner", title: "W" }),
        judgeConfidence: 0.9,
      })
    ).rejects.toThrow("notion 500")
    // Decrement never fires — retry is safe because no destructive
    // write landed.
    expect(decrementConfidence).not.toHaveBeenCalled()
  })

  it("throws CompareDispatchPartialFailureError when fact lands but decrement fails (partial-state)", async () => {
    const decrementConfidence = vi.fn(async (_m: unknown) => {
      throw new Error("notion 429 — decrement failed")
    })
    const createWithDedup = vi.fn(async (_input: unknown) => ({
      fact: { id: "fact-99" },
      deduped: false,
    }))
    const services = makeMockServices({ decrementConfidence, createWithDedup })

    const promise = recordContradiction(services, {
      contradictedMemory: memShape({ id: "loser", title: "L" }),
      sourceMemory: memShape({ id: "winner", title: "W" }),
      judgeConfidence: 0.9,
    })
    // Typed properties — preserved on the Error subclass for any
    // structured consumer (e.g., a future operator-side reconciler).
    await expect(promise).rejects.toMatchObject({
      name: "CompareDispatchPartialFailureError",
      step: "fact",
      affectedMemoryId: "loser",
      factId: "fact-99",
    })
    // Diagnostic fields ALSO interpolated into `.message` so they
    // survive `toolError`'s message-only forwarding at the MCP
    // boundary. Pin every field by name+value so a future refactor
    // that drops them from the message string fails this test.
    await expect(
      recordContradiction(services, {
        contradictedMemory: memShape({ id: "loser", title: "L" }),
        sourceMemory: memShape({ id: "winner", title: "W" }),
        judgeConfidence: 0.9,
      })
    ).rejects.toThrow(/step=fact/)
    await expect(
      recordContradiction(services, {
        contradictedMemory: memShape({ id: "loser", title: "L" }),
        sourceMemory: memShape({ id: "winner", title: "W" }),
        judgeConfidence: 0.9,
      })
    ).rejects.toThrow(/affectedMemoryId=loser/)
    await expect(
      recordContradiction(services, {
        contradictedMemory: memShape({ id: "loser", title: "L" }),
        sourceMemory: memShape({ id: "winner", title: "W" }),
        judgeConfidence: 0.9,
      })
    ).rejects.toThrow(/factId=fact-99/)
    await expect(
      recordContradiction(services, {
        contradictedMemory: memShape({ id: "loser", title: "L" }),
        sourceMemory: memShape({ id: "winner", title: "W" }),
        judgeConfidence: 0.9,
      })
    ).rejects.toThrow(/inconsistentState: true/)
  })

  it("retry after a landed decrement marker skips decrement and still returns the deduped fact", async () => {
    const ledger = buildCompareDispatchLedgerEntry({
      verdict: "conflicts_with",
      sourceMemoryId: "winner",
      affectedMemoryId: "loser",
    })
    const decrementConfidence = vi.fn(async (_m: unknown) => 0.45)
    const createWithDedup = vi.fn(async (_input: unknown) => ({
      fact: { id: "fact-existing" },
      deduped: true,
    }))
    const services = makeMockServices({ decrementConfidence, createWithDedup })

    const result = await recordContradiction(services, {
      contradictedMemory: {
        ...memShape({ id: "loser", title: "L" }),
        compareNotes: appendCompareDispatchLedgerEntry("", ledger),
      },
      sourceMemory: memShape({ id: "winner", title: "W" }),
      judgeConfidence: 0.9,
    })

    expect(createWithDedup).toHaveBeenCalledTimes(1)
    expect(decrementConfidence).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      factId: "fact-existing",
      decremented: false,
    })
    const recordedLedger = JSON.parse(result.affectedCompareNotes) as {
      dispatchKey: string
    }
    expect(recordedLedger.dispatchKey).toBe(ledger.dispatchKey)
  })

  it("uses the project intersection when both memories belong to multiple projects", async () => {
    const createWithDedup = vi.fn(async (_input: unknown) => ({
      fact: { id: "fact-2" },
      deduped: false,
    }))
    const services = makeMockServices({ createWithDedup })

    await recordContradiction(services, {
      contradictedMemory: memShape({ id: "loser", projectIds: ["P", "Q"] }),
      sourceMemory: memShape({ id: "winner", projectIds: ["Q", "R"] }),
      judgeConfidence: undefined,
    })

    // Intersection is [Q] in winner-first order.
    expect(createWithDedup.mock.calls[0]![0]).toMatchObject({
      projectIds: ["Q"],
    })
  })

  describe("factConfidenceFromJudge boundary mapping", () => {
    // Pin every threshold of the categorical mapping so a future
    // refactor re-tuning the cutoffs (e.g., switching to >0.85 vs
    // >=0.85) breaks the test rather than silently shifting which
    // emitted facts land at which categorical.
    it.each([
      ["undefined", undefined, "likely"],
      ["below speculative cutoff (0.0)", 0.0, "speculative"],
      ["just below likely cutoff (0.59)", 0.59, "speculative"],
      ["exactly at likely cutoff (0.6)", 0.6, "likely"],
      ["just below certain cutoff (0.84)", 0.84, "likely"],
      ["exactly at certain cutoff (0.85)", 0.85, "certain"],
      ["above certain cutoff (1.0)", 1.0, "certain"],
    ])("judgeConfidence %s maps to %s", async (_label, judgeConfidence, expected) => {
      const createWithDedup = vi.fn(async (_input: unknown) => ({
        fact: { id: `fact-${expected}` },
        deduped: false,
      }))
      const services = makeMockServices({ createWithDedup })

      await recordContradiction(services, {
        contradictedMemory: memShape({ id: "loser", title: "L" }),
        sourceMemory: memShape({ id: "winner", title: "W" }),
        judgeConfidence: judgeConfidence as number | undefined,
      })

      expect(createWithDedup.mock.calls[0]![0]).toMatchObject({
        confidence: expected,
      })
    })
  })
})

describe("recordSupersedence (0.9.0/05)", () => {
  function memShape(
    overrides: {
      id?: string
      title?: string
      projectIds?: string[]
      confidence?: "certain" | "likely" | "speculative"
      confidenceScore?: number | null
      lastReferencedAt?: string | null
      createdAt?: string
    } = {}
  ) {
    return {
      id: overrides.id ?? "m1",
      title: overrides.title ?? "Memory",
      projectIds: overrides.projectIds ?? ["proj-a"],
      confidence: overrides.confidence ?? ("certain" as const),
      confidenceScore: overrides.confidenceScore ?? 0.9,
      lastReferencedAt: overrides.lastReferencedAt ?? "2026-04-30",
      createdAt: overrides.createdAt ?? "2026-04-29T00:00:00.000Z",
    }
  }

  function makeMockServices(
    opts: {
      decrementConfidence?: ReturnType<typeof vi.fn>
      createWithDedup?: ReturnType<typeof vi.fn>
      supersede?: ReturnType<typeof vi.fn>
    } = {}
  ) {
    return {
      memories: {
        decrementConfidence:
          opts.decrementConfidence ?? vi.fn(async (_m: unknown) => 0.45),
      },
      facts: {
        createWithDedup:
          opts.createWithDedup ??
          vi.fn(async (_input: unknown) => ({
            fact: { id: "fact-9" },
            deduped: false,
          })),
      },
      decisions: { supersede: opts.supersede ?? vi.fn(async () => undefined) },
    }
  }

  it("calls decisions.supersede(winner.id, loser.id) before fact emission and decrement", async () => {
    // The reviewer's #1 finding: prior implementation skipped this
    // step, so the new decision's Supersedes relation was never
    // updated and the old decision's Status stayed at "accepted." Pin
    // the call order: supersede → fact → decrement.
    const calls: string[] = []
    const supersede = vi.fn(async () => {
      calls.push("supersede")
    })
    const createWithDedup = vi.fn(async (_input: unknown) => {
      calls.push("fact")
      return { fact: { id: "fact-9" }, deduped: false }
    })
    const decrementConfidence = vi.fn(async (_m: unknown) => {
      calls.push("decrement")
      return 0.45
    })
    const services = makeMockServices({ supersede, createWithDedup, decrementConfidence })

    const result = await recordSupersedence(services, {
      supersedingMemory: memShape({ id: "new-decision", title: "Use JWT" }),
      supersededMemory: memShape({ id: "old-decision", title: "Use sessions" }),
      judgeConfidence: 0.95,
    })

    expect(calls).toEqual(["supersede", "fact", "decrement"])
    expect(supersede).toHaveBeenCalledWith("new-decision", "old-decision")
    expect(decrementConfidence.mock.calls[0]![0]).toMatchObject({
      id: "old-decision",
    })
    const decrementCall = decrementConfidence.mock.calls[0] as unknown as [
      unknown,
      { compareNotes: string },
    ]
    const decrementOpts = decrementCall[1]
    expect(decrementOpts.compareNotes).toContain('"entryType":"compare_dispatch"')
    expect(decrementOpts.compareNotes).toContain('"affected":"old-decision"')
    // Fact uses IDs (matching `lore-decision action='supersede'`'s
    // existing shape) so the supersession edge in the decision graph
    // is canonically identified by id, not title.
    expect(createWithDedup.mock.calls[0]![0]).toMatchObject({
      subject: "new-decision",
      predicate: "supersedes_decision",
      object: "old-decision",
      sourceMemoryId: "new-decision",
      confidence: "certain",
    })
    expect(result.factId).toBe("fact-9")
    expect(result.decremented).toBe(true)
  })

  it("throws CompareDispatchPartialFailureError(step: 'supersede') when fact create fails after decisions.supersede landed — diagnostic fields embedded in message", async () => {
    const supersede = vi.fn(async () => undefined)
    const createWithDedup = vi.fn(async (_input: unknown) => {
      throw new Error("notion 429 — fact create failed")
    })
    const decrementConfidence = vi.fn(async (_m: unknown) => 0.45)
    const services = makeMockServices({ supersede, createWithDedup, decrementConfidence })

    await expect(
      recordSupersedence(services, {
        supersedingMemory: memShape({ id: "new", title: "N" }),
        supersededMemory: memShape({ id: "old", title: "O" }),
        judgeConfidence: 0.9,
      })
    ).rejects.toMatchObject({
      name: "CompareDispatchPartialFailureError",
      step: "supersede",
      affectedMemoryId: "old",
    })
    // Message-side pins so the operator's view through the MCP
    // boundary carries enough context to manually create the
    // missing supersedes_decision fact.
    await expect(
      recordSupersedence(services, {
        supersedingMemory: memShape({ id: "new", title: "N" }),
        supersededMemory: memShape({ id: "old", title: "O" }),
        judgeConfidence: 0.9,
      })
    ).rejects.toThrow(/step=supersede/)
    await expect(
      recordSupersedence(services, {
        supersedingMemory: memShape({ id: "new", title: "N" }),
        supersededMemory: memShape({ id: "old", title: "O" }),
        judgeConfidence: 0.9,
      })
    ).rejects.toThrow(/affectedMemoryId=old/)
    await expect(
      recordSupersedence(services, {
        supersedingMemory: memShape({ id: "new", title: "N" }),
        supersededMemory: memShape({ id: "old", title: "O" }),
        judgeConfidence: 0.9,
      })
    ).rejects.toThrow(/supersedingMemoryId=new/)
    expect(decrementConfidence).not.toHaveBeenCalled()
  })

  it("throws CompareDispatchPartialFailureError(step: 'fact') when decrement fails after supersede + fact landed", async () => {
    const supersede = vi.fn(async () => undefined)
    const createWithDedup = vi.fn(async (_input: unknown) => ({
      fact: { id: "fact-99" },
      deduped: false,
    }))
    const decrementConfidence = vi.fn(async (_m: unknown) => {
      throw new Error("notion 429 — decrement failed")
    })
    const services = makeMockServices({ supersede, createWithDedup, decrementConfidence })

    await expect(
      recordSupersedence(services, {
        supersedingMemory: memShape({ id: "new", title: "N" }),
        supersededMemory: memShape({ id: "old", title: "O" }),
        judgeConfidence: 0.9,
      })
    ).rejects.toMatchObject({
      name: "CompareDispatchPartialFailureError",
      step: "fact",
      affectedMemoryId: "old",
      factId: "fact-99",
    })
  })

  it("retry after a landed supersedes decrement marker completes without double-decrementing", async () => {
    const ledger = buildCompareDispatchLedgerEntry({
      verdict: "supersedes",
      sourceMemoryId: "new",
      affectedMemoryId: "old",
    })
    const supersede = vi.fn(async () => undefined)
    const createWithDedup = vi.fn(async (_input: unknown) => ({
      fact: { id: "fact-existing" },
      deduped: true,
    }))
    const decrementConfidence = vi.fn(async (_m: unknown) => 0.45)
    const services = makeMockServices({ supersede, createWithDedup, decrementConfidence })

    const result = await recordSupersedence(services, {
      supersedingMemory: memShape({ id: "new", title: "N" }),
      supersededMemory: {
        ...memShape({ id: "old", title: "O" }),
        compareNotes: appendCompareDispatchLedgerEntry("", ledger),
      },
      judgeConfidence: 0.9,
    })

    expect(supersede).toHaveBeenCalledWith("new", "old")
    expect(createWithDedup).toHaveBeenCalledTimes(1)
    expect(decrementConfidence).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      factId: "fact-existing",
      decremented: false,
    })
  })

  it("does NOT call fact create or decrement when decisions.supersede itself fails", async () => {
    const supersede = vi.fn(async () => {
      throw new Error("notion 500 — supersede failed")
    })
    const createWithDedup = vi.fn(async (_input: unknown) => ({
      fact: { id: "fact-99" },
      deduped: false,
    }))
    const decrementConfidence = vi.fn(async (_m: unknown) => 0.45)
    const services = makeMockServices({ supersede, createWithDedup, decrementConfidence })

    await expect(
      recordSupersedence(services, {
        supersedingMemory: memShape({ id: "new", title: "N" }),
        supersededMemory: memShape({ id: "old", title: "O" }),
        judgeConfidence: 0.9,
      })
    ).rejects.toThrow("notion 500")
    expect(createWithDedup).not.toHaveBeenCalled()
    expect(decrementConfidence).not.toHaveBeenCalled()
  })
})

describe("MemoryService.listForScan (0.9.0/09)", () => {
  const db: DatabaseRef = { databaseId: "memories-db", dataSourceId: "memories-ds" }

  /** Build a Memory page with the minimum properties listForScan reads. */
  function buildScanPage(
    id: string,
    opts: {
      title?: string
      projectIds: string[]
      archived?: boolean
    }
  ): PageObjectResponse {
    return buildPage(
      {
        Title: { type: "title", title: [{ plain_text: opts.title ?? `Memory ${id}` }] },
        Project: {
          type: "relation",
          relation: opts.projectIds.map((pid) => ({ id: pid })),
        },
      },
      { id, archived: opts.archived ?? false }
    )
  }

  function makeQueryClient(
    pagesByCall: Array<{
      results: PageObjectResponse[]
      has_more?: boolean
      next_cursor?: string | null
    }>
  ) {
    let callIndex = 0
    const querySpy = vi.fn(
      async (_args: {
        data_source_id: string
        filter?: unknown
        start_cursor?: string
        page_size?: number
      }) => {
        const result = pagesByCall[callIndex]
        callIndex++
        return {
          results: result?.results ?? [],
          has_more: result?.has_more ?? false,
          next_cursor: result?.next_cursor ?? null,
        }
      }
    )
    return { querySpy }
  }

  it("returns one Memory[] per project, aligned by index with input projectIds", async () => {
    const { querySpy } = makeQueryClient([
      { results: [buildScanPage("m1", { projectIds: ["P1"] })] },
      {
        results: [
          buildScanPage("m2", { projectIds: ["P2"] }),
          buildScanPage("m3", { projectIds: ["P2"] }),
        ],
      },
    ])
    const client = { dataSources: { query: querySpy } } as unknown as Client
    const service = new MemoryService(client, db)

    const grouped = await service.listForScan({ projectIds: ["P1", "P2"] })

    expect(grouped).toHaveLength(2)
    expect(grouped[0]!.map((m) => m.id)).toEqual(["m1"])
    expect(grouped[1]!.map((m) => m.id)).toEqual(["m2", "m3"])
  })

  it("filters archived rows client-side (Notion query cannot filter archived flag)", async () => {
    const { querySpy } = makeQueryClient([
      {
        results: [
          buildScanPage("alive", { projectIds: ["P1"] }),
          buildScanPage("archived-1", { projectIds: ["P1"], archived: true }),
        ],
      },
    ])
    const client = { dataSources: { query: querySpy } } as unknown as Client
    const service = new MemoryService(client, db)

    const grouped = await service.listForScan({ projectIds: ["P1"] })

    expect(grouped).toHaveLength(1)
    expect(grouped[0]!.map((m) => m.id)).toEqual(["alive"])
  })

  it("paginates: aggregates results across multiple Notion pages per project", async () => {
    // First Notion page (100 rows) returns has_more=true with a cursor.
    // Without pagination, the second page's row would be silently dropped.
    const firstPage = Array.from({ length: 100 }, (_, i) =>
      buildScanPage(`m-${i}`, { projectIds: ["P1"] })
    )
    const secondPage = [buildScanPage("m-late", { projectIds: ["P1"] })]
    const { querySpy } = makeQueryClient([
      { results: firstPage, has_more: true, next_cursor: "cursor-1" },
      { results: secondPage, has_more: false },
    ])
    const client = { dataSources: { query: querySpy } } as unknown as Client
    const service = new MemoryService(client, db)

    const grouped = await service.listForScan({ projectIds: ["P1"] })

    expect(grouped[0]!.map((m) => m.id)).toContain("m-late")
    expect(grouped[0]).toHaveLength(101)
    expect(querySpy).toHaveBeenCalledTimes(2)
    expect(querySpy.mock.calls[1]![0].start_cursor).toBe("cursor-1")
  })

  it("uses page_size: 100 and strict-scoped Project relation contains filter (NOT projectOrUnscopedFilter)", async () => {
    // The strict filter shape is load-bearing: an unscoped row paired
    // against a project-scoped row would fail findConflictCandidates'
    // per-pair project intersection anyway, so including unscoped rows
    // would inflate O(n²) pair work for zero useful output.
    const { querySpy } = makeQueryClient([{ results: [] }])
    const client = { dataSources: { query: querySpy } } as unknown as Client
    const service = new MemoryService(client, db)

    await service.listForScan({ projectIds: ["P1"] })

    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(querySpy.mock.calls[0]![0].page_size).toBe(100)
    // Strict-scoped project filter composed with the cleanup-orphan
    // exclusion (issue #477). The filter must include the
    // `relation contains` clause AND the sentinel does_not_contain
    // clause so the conflict scanner's lexical pair-detector cannot
    // pair a resurfaced empty-body orphan against legitimate rows.
    expect(querySpy.mock.calls[0]![0].filter).toEqual({
      and: [
        { property: "Project", relation: { contains: "P1" } },
        {
          property: "Keywords",
          rich_text: { does_not_contain: "__lore-cleanup-orphan" },
        },
      ],
    })
  })

  it("skips pages.retrieveMarkdown when includeBodies is false (default)", async () => {
    const retrieveMarkdownSpy = vi.fn(async () => ({ markdown: "" }))
    const { querySpy } = makeQueryClient([
      { results: [buildScanPage("m1", { projectIds: ["P1"] })] },
    ])
    const client = {
      dataSources: { query: querySpy },
      pages: { retrieveMarkdown: retrieveMarkdownSpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const grouped = await service.listForScan({ projectIds: ["P1"] })

    expect(grouped[0]![0]!.content).toBe("")
    expect(retrieveMarkdownSpy).not.toHaveBeenCalled()
  })

  it("fetches body via pages.retrieveMarkdown when includeBodies is true", async () => {
    const retrieveMarkdownSpy = vi.fn(async (args: { page_id: string }) => ({
      markdown: `body for ${args.page_id}`,
    }))
    const { querySpy } = makeQueryClient([
      {
        results: [
          buildScanPage("m1", { projectIds: ["P1"] }),
          buildScanPage("m2", { projectIds: ["P1"] }),
        ],
      },
    ])
    const client = {
      dataSources: { query: querySpy },
      pages: { retrieveMarkdown: retrieveMarkdownSpy },
    } as unknown as Client
    const service = new MemoryService(client, db)

    const grouped = await service.listForScan({
      projectIds: ["P1"],
      includeBodies: true,
    })

    expect(retrieveMarkdownSpy).toHaveBeenCalledTimes(2)
    expect(grouped[0]![0]!.content).toBe("body for m1")
    expect(grouped[0]![1]!.content).toBe("body for m2")
  })

  it("fires onProgress once per Notion page received with project label and running total", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) =>
      buildScanPage(`m-${i}`, { projectIds: ["P1"] })
    )
    const secondPage = [buildScanPage("m-late", { projectIds: ["P1"] })]
    const { querySpy } = makeQueryClient([
      { results: firstPage, has_more: true, next_cursor: "cursor-1" },
      { results: secondPage, has_more: false },
    ])
    const client = { dataSources: { query: querySpy } } as unknown as Client
    const service = new MemoryService(client, db)

    const events: Array<{
      projectId: string
      projectLabel: string
      pageIndex: number
      runningTotal: number
    }> = []
    await service.listForScan({
      projectIds: ["P1"],
      projectLabels: ["Project One"],
      onProgress: (info) => events.push(info),
    })

    expect(events).toEqual([
      { projectId: "P1", projectLabel: "Project One", pageIndex: 1, runningTotal: 100 },
      { projectId: "P1", projectLabel: "Project One", pageIndex: 2, runningTotal: 101 },
    ])
  })

  it("returns an empty array when projectIds is empty without any Notion call", async () => {
    const { querySpy } = makeQueryClient([])
    const client = { dataSources: { query: querySpy } } as unknown as Client
    const service = new MemoryService(client, db)

    const grouped = await service.listForScan({ projectIds: [] })

    expect(grouped).toEqual([])
    expect(querySpy).not.toHaveBeenCalled()
  })
})
