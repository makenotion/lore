import { afterEach, describe, expect, it, vi } from "vitest"
import { MEMORY_PROPS } from "../../../notion/schema.js"
import { runBackfillAutosaveLearningSource } from "./autosave-learning-source.js"

function makePage(id: string, title: string, session: string) {
  return {
    object: "page",
    id,
    archived: false,
    properties: {
      [MEMORY_PROPS.TITLE]: {
        type: "title",
        title: [{ plain_text: title }],
      },
      [MEMORY_PROPS.SESSION]: {
        type: "rich_text",
        rich_text: [{ plain_text: session }],
      },
    },
  }
}

describe("runBackfillAutosaveLearningSource", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("plans legacy autosave source rows without writing in dry-run mode", async () => {
    const query = vi.fn(async (_args: unknown) => ({
      results: [makePage("mem-1", "Relation filters", "session-1")],
      has_more: false,
      next_cursor: null,
    }))
    const update = vi.fn()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    const result = await runBackfillAutosaveLearningSource(
      {
        client: { dataSources: { query }, pages: { update } },
        vault: { databases: { memories: { dataSourceId: "memories-ds" } } },
      } as never,
      { apply: false, dryRun: true }
    )

    expect(result.written).toBe(0)
    expect(result.candidates.map((row) => row.id)).toEqual(["mem-1"])
    expect(update).not.toHaveBeenCalled()
    const filter = (query.mock.calls[0]![0] as { filter: unknown }).filter
    expect(JSON.stringify(filter)).toContain('"Source"')
    expect(JSON.stringify(filter)).toContain('"conversation"')
    expect(JSON.stringify(filter)).toContain('"Confidence"')
    expect(JSON.stringify(filter)).toContain('"likely"')
    expect(JSON.stringify(filter)).toContain('"is_not_empty"')
  })

  it("writes Source=autosave_learning in apply mode", async () => {
    const query = vi.fn(async (_args: unknown) => ({
      results: [
        makePage("mem-1", "Relation filters", "session-1"),
        makePage("mem-2", "RunTool fallback", "session-2"),
      ],
      has_more: false,
      next_cursor: null,
    }))
    const update = vi.fn(async (_args: unknown) => undefined)
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    const result = await runBackfillAutosaveLearningSource(
      {
        client: { dataSources: { query }, pages: { update } },
        vault: { databases: { memories: { dataSourceId: "memories-ds" } } },
      } as never,
      { apply: true, dryRun: false }
    )

    expect(result.written).toBe(2)
    expect(update).toHaveBeenCalledTimes(2)
    expect(update.mock.calls[0]![0]).toEqual({
      page_id: "mem-1",
      properties: {
        [MEMORY_PROPS.SOURCE]: { select: { name: "autosave_learning" } },
      },
    })
  })

  it("adds project scope when provided", async () => {
    const query = vi.fn(async (_args: unknown) => ({
      results: [],
      has_more: false,
      next_cursor: null,
    }))
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    await runBackfillAutosaveLearningSource(
      {
        client: { dataSources: { query }, pages: { update: vi.fn() } },
        vault: { databases: { memories: { dataSourceId: "memories-ds" } } },
      } as never,
      { apply: false, dryRun: true, projectId: "project-1" }
    )

    const filter = (query.mock.calls[0]![0] as { filter: unknown }).filter
    expect(JSON.stringify(filter)).toContain('"Project"')
    expect(JSON.stringify(filter)).toContain('"project-1"')
  })
})
