/**
 * RunTool `search` consumer tests (issue #541, Phase 2 of #532).
 *
 * Mocked HTTP only — no live Notion calls. Pin:
 *   - Wire envelope shape: `{ type: "search", search: { query, … } }`
 *     against `POST /v1/tools/run`.
 *   - `data_source_url` scoping uses the canonical
 *     `collection://<id>` form.
 *   - `page_size` clamps to `RUNTOOL_SEARCH_MAX_PAGE_SIZE`.
 *   - `max_highlight_length: 0` is the wrapper's default.
 *   - 403 RestrictedResource throws `RunToolSearchRestrictedError`
 *     and emits the once-per-process stderr warning exactly once.
 *   - 401 / 429 / 5xx / 400 / malformed propagate verbatim.
 *   - External connector hits (`url` ≠ Notion page id) drop out.
 *   - Empty `query` and empty `dataSourceId` reject pre-call.
 *   - `saturated` flag fires when raw response returns the cap.
 */

import { describe, expect, it, vi } from "vitest"
import { APIErrorCode, APIResponseError, type Client } from "@notionhq/client"
import {
  __resetRunToolSearchWarningsForTest,
  RUNTOOL_SEARCH_MAX_PAGE_SIZE,
  RunToolSearchRestrictedError,
  searchViaRunTool,
} from "./search.js"
import { isRunToolEnabled, isRunToolSearchEnabled } from "./flag.js"
import { RUNTOOL_PATH } from "./client.js"
import type { RunToolInternalSearchResponse } from "./types.js"

function buildApiError(
  code: APIErrorCode,
  status: number,
  message: string
): APIResponseError {
  return new APIResponseError({
    code,
    status,
    message,
    headers: new Headers(),
    rawBodyText: `{"code":"${code}","message":${JSON.stringify(message)}}`,
    additional_data: undefined,
    request_id: undefined,
  })
}

interface CapturedRequest {
  method: unknown
  path: unknown
  body: unknown
}

function makeStubClient(
  responder: (
    args: { method: string; path: string; body: Record<string, unknown> },
    callIndex: number
  ) => unknown | Promise<unknown>
): { client: Client; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = []
  let callIndex = 0
  const stub = {
    request: async (args: {
      method: string
      path: string
      body: Record<string, unknown>
    }) => {
      captured.push({ method: args.method, path: args.path, body: args.body })
      const i = callIndex
      callIndex += 1
      return await responder(args, i)
    },
  } as unknown as Client
  return { client: stub, captured }
}

const DASHED_UUID = "11111111-2222-3333-4444-555555555555"
const ANOTHER_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const UNDASHED_UUID = "ffffffffffffffffffffffffffffffff"

function makeNotionHit(
  id: string,
  title: string
): RunToolInternalSearchResponse["results"][number] {
  return {
    id,
    title,
    url: id,
    type: "page",
    highlight: "",
    timestamp: "2026-05-06T12:00:00.000Z",
  }
}

function makeAiSearchResponse(
  results: RunToolInternalSearchResponse["results"]
): RunToolInternalSearchResponse {
  return { type: "ai_search", results }
}

describe("isRunToolSearchEnabled", () => {
  it("inherits from LORE_USE_RUNTOOL when the sub-flag is unset", () => {
    expect(isRunToolSearchEnabled({ LORE_USE_RUNTOOL: "1" })).toBe(true)
    expect(isRunToolSearchEnabled({ LORE_USE_RUNTOOL: "0" })).toBe(false)
  })

  it("lets LORE_USE_RUNTOOL_SEARCH override the parent flag", () => {
    expect(
      isRunToolSearchEnabled({
        LORE_USE_RUNTOOL: "1",
        LORE_USE_RUNTOOL_SEARCH: "0",
      })
    ).toBe(false)
    expect(
      isRunToolSearchEnabled({
        LORE_USE_RUNTOOL: "0",
        LORE_USE_RUNTOOL_SEARCH: "1",
      })
    ).toBe(true)
  })

  it("defaults on with no env vars set (issue #543 Phase 4 flip)", () => {
    expect(isRunToolSearchEnabled({})).toBe(true)
    expect(isRunToolEnabled({})).toBe(true)
  })

  it("ignores unrecognized values, falling through to the default-on parent", () => {
    expect(isRunToolSearchEnabled({ LORE_USE_RUNTOOL: "maybe" })).toBe(true)
    expect(isRunToolSearchEnabled({ LORE_USE_RUNTOOL_SEARCH: "garbage" })).toBe(true)
  })
})

describe("searchViaRunTool — wire envelope", () => {
  it("dispatches POST /v1/tools/run with `{ type: 'search', search: { … } }`", async () => {
    const { client, captured } = makeStubClient(() =>
      makeAiSearchResponse([makeNotionHit(DASHED_UUID, "Memory A")])
    )

    const result = await searchViaRunTool(client, {
      query: "auth refactor",
      dataSourceId: "ds-mem",
      pageSize: 10,
    })

    expect(captured).toHaveLength(1)
    expect(captured[0]!.method).toBe("post")
    expect(captured[0]!.path).toBe(RUNTOOL_PATH)
    expect(captured[0]!.body).toEqual({
      type: "search",
      search: {
        query: "auth refactor",
        data_source_url: "collection://ds-mem",
        page_size: 10,
        max_highlight_length: 0,
      },
    })
    expect(result.hits).toEqual([
      { id: DASHED_UUID, title: "Memory A", url: DASHED_UUID, isArchived: false },
    ])
    expect(result.saturated).toBe(false)
    expect(result.searchType).toBe("ai_search")
  })

  it("clamps page_size to RUNTOOL_SEARCH_MAX_PAGE_SIZE", async () => {
    const { client, captured } = makeStubClient(() => makeAiSearchResponse([]))

    await searchViaRunTool(client, {
      query: "x",
      dataSourceId: "ds-mem",
      pageSize: 100,
    })

    const body = captured[0]!.body as {
      search: { page_size: number }
    }
    expect(body.search.page_size).toBe(RUNTOOL_SEARCH_MAX_PAGE_SIZE)
  })

  it("clamps page_size lower bound to 1", async () => {
    const { client, captured } = makeStubClient(() => makeAiSearchResponse([]))

    await searchViaRunTool(client, {
      query: "x",
      dataSourceId: "ds-mem",
      pageSize: 0,
    })

    const body = captured[0]!.body as { search: { page_size: number } }
    expect(body.search.page_size).toBe(1)
  })

  it("defaults page_size to RUNTOOL_SEARCH_MAX_PAGE_SIZE when omitted", async () => {
    const { client, captured } = makeStubClient(() => makeAiSearchResponse([]))

    await searchViaRunTool(client, {
      query: "x",
      dataSourceId: "ds-mem",
    })

    const body = captured[0]!.body as { search: { page_size: number } }
    expect(body.search.page_size).toBe(RUNTOOL_SEARCH_MAX_PAGE_SIZE)
  })

  it("defaults page_size to RUNTOOL_SEARCH_MAX_PAGE_SIZE on NaN / Infinity (Number.isFinite defense)", async () => {
    for (const bogus of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const { client, captured } = makeStubClient(() => makeAiSearchResponse([]))

      await searchViaRunTool(client, {
        query: "x",
        dataSourceId: "ds-mem",
        pageSize: bogus,
      })

      const body = captured[0]!.body as { search: { page_size: number } }
      // Must NOT serialize as `null` (which would 400 server-side)
      // and must NOT propagate `NaN` / `Infinity` through the
      // clamp math.
      expect(body.search.page_size).toBe(RUNTOOL_SEARCH_MAX_PAGE_SIZE)
    }
  })

  it("does not set query_type or content_search_mode (preserves workflow-bot compatibility)", async () => {
    const { client, captured } = makeStubClient(() => makeAiSearchResponse([]))

    await searchViaRunTool(client, {
      query: "x",
      dataSourceId: "ds-mem",
      pageSize: 5,
    })

    const body = captured[0]!.body as { search: Record<string, unknown> }
    expect(body.search).not.toHaveProperty("query_type")
    expect(body.search).not.toHaveProperty("content_search_mode")
  })
})

describe("searchViaRunTool — pre-call validation", () => {
  it("rejects empty query before issuing the request", async () => {
    const { client, captured } = makeStubClient(() => {
      throw new Error("should not be called")
    })

    await expect(
      searchViaRunTool(client, {
        query: "",
        dataSourceId: "ds-mem",
        pageSize: 10,
      })
    ).rejects.toThrow(/non-empty/i)
    expect(captured).toHaveLength(0)
  })

  it("rejects empty dataSourceId", async () => {
    const { client, captured } = makeStubClient(() => {
      throw new Error("should not be called")
    })

    await expect(
      searchViaRunTool(client, {
        query: "x",
        dataSourceId: "",
        pageSize: 10,
      })
    ).rejects.toThrow(/dataSourceId is required/i)
    expect(captured).toHaveLength(0)
  })
})

describe("searchViaRunTool — error classification", () => {
  it("converts 403 RestrictedResource to RunToolSearchRestrictedError and warns once", async () => {
    __resetRunToolSearchWarningsForTest()
    const sdkError = buildApiError(
      APIErrorCode.RestrictedResource,
      403,
      "Only public integrations can access this API."
    )
    const { client } = makeStubClient(() => {
      throw sdkError
    })
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    try {
      await expect(
        searchViaRunTool(client, {
          query: "x",
          dataSourceId: "ds-mem",
          pageSize: 5,
        })
      ).rejects.toBeInstanceOf(RunToolSearchRestrictedError)

      // Second call should also reject but NOT emit a second warning.
      await expect(
        searchViaRunTool(client, {
          query: "y",
          dataSourceId: "ds-mem",
          pageSize: 5,
        })
      ).rejects.toBeInstanceOf(RunToolSearchRestrictedError)

      const restrictedLines = stderrSpy.mock.calls.filter((call) =>
        String(call[0]).includes("RestrictedResource")
      )
      expect(restrictedLines).toHaveLength(1)
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it.each([
    { status: 401, code: "unauthorized" },
    { status: 400, code: "validation_error" },
    { status: 429, code: "rate_limited" },
    { status: 500, code: "internal_server_error" },
  ])(
    "propagates $status verbatim so proxy chain stays authoritative",
    async ({ status, code }) => {
      const sdkError = Object.assign(new Error(code), { status, code })
      let calls = 0
      const { client } = makeStubClient(() => {
        calls += 1
        throw sdkError
      })

      await expect(
        searchViaRunTool(client, {
          query: "x",
          dataSourceId: "ds-mem",
          pageSize: 5,
        })
      ).rejects.toBe(sdkError)
      expect(calls).toBe(1)
    }
  )

  it("rejects malformed responses", async () => {
    const { client } = makeStubClient(() => ({ unexpected: "shape" }))

    await expect(
      searchViaRunTool(client, {
        query: "x",
        dataSourceId: "ds-mem",
        pageSize: 5,
      })
    ).rejects.toThrow(/malformed response/i)
  })

  it("rejects user_search discriminator (Lore only consumes internal search)", async () => {
    const { client } = makeStubClient(() => ({
      type: "user_search",
      results: [],
    }))

    await expect(
      searchViaRunTool(client, {
        query: "x",
        dataSourceId: "ds-mem",
        pageSize: 5,
      })
    ).rejects.toThrow(/malformed response/i)
  })

  it("rejects results with non-string or empty id fields (structural-guard regression)", async () => {
    // Pin the structural guard against silent loosening: a future
    // contributor relaxing the type check on result.id to permit
    // numbers or empty strings would silently bypass the malformed-
    // response branch.
    const { client: numericIdClient } = makeStubClient(() => ({
      type: "ai_search",
      results: [
        {
          id: 123 as unknown as string,
          title: "M",
          url: "u",
          type: "page",
          highlight: "",
          timestamp: "t",
        },
      ],
    }))
    await expect(
      searchViaRunTool(numericIdClient, {
        query: "x",
        dataSourceId: "ds-mem",
        pageSize: 5,
      })
    ).rejects.toThrow(/malformed response/i)

    const { client: emptyIdClient } = makeStubClient(() => ({
      type: "ai_search",
      results: [
        { id: "", title: "M", url: "u", type: "page", highlight: "", timestamp: "t" },
      ],
    }))
    await expect(
      searchViaRunTool(emptyIdClient, {
        query: "x",
        dataSourceId: "ds-mem",
        pageSize: 5,
      })
    ).rejects.toThrow(/malformed response/i)
  })

  it("rejects results with non-string url field (structural-guard regression)", async () => {
    const { client } = makeStubClient(() => ({
      type: "ai_search",
      results: [
        {
          id: "abc",
          title: "M",
          url: { not: "a string" } as unknown as string,
          type: "page",
          highlight: "",
          timestamp: "t",
        },
      ],
    }))
    await expect(
      searchViaRunTool(client, {
        query: "x",
        dataSourceId: "ds-mem",
        pageSize: 5,
      })
    ).rejects.toThrow(/malformed response/i)
  })
})

describe("searchViaRunTool — result narrowing", () => {
  it("filters out external connector hits (non-Notion-page-id urls)", async () => {
    const { client } = makeStubClient(() =>
      makeAiSearchResponse([
        makeNotionHit(DASHED_UUID, "Memory A"),
        // External connector hit — `url` is a full URL, not a page id
        {
          id: "slack-msg-1",
          title: "Slack message",
          url: "https://slack.com/archives/C123/p1234",
          type: "external",
          highlight: "",
          timestamp: "2026-05-06T12:00:00.000Z",
        },
        makeNotionHit(UNDASHED_UUID, "Memory B"),
      ])
    )

    const result = await searchViaRunTool(client, {
      query: "x",
      dataSourceId: "ds-mem",
      pageSize: 10,
    })

    expect(result.hits.map((h) => h.id)).toEqual([DASHED_UUID, UNDASHED_UUID])
  })

  it("strict-coerces non-boolean is_archived to false (defensive at the wire boundary)", async () => {
    // The wire-format guard at `search.ts` uses `result.is_archived ===
    // true` strict coercion. A future schema drift that surfaces a
    // string `"true"` / numeric `1` / `null` for the field MUST NOT
    // promote those values into a `true` `isArchived` flag — the
    // canonical archive signal lives on `page.archived` after
    // `pages.retrieve`, and `applySemanticPostFilters` re-checks it.
    // This test pins the strict-equality behavior so a future
    // contributor "loosening" the check (`Boolean(result.is_archived)`)
    // can't silently change semantics.
    const { client } = makeStubClient(() =>
      makeAiSearchResponse([
        // Each non-boolean value must coerce to false.
        {
          ...makeNotionHit(DASHED_UUID, "M1"),
          is_archived: "true" as unknown as boolean,
        },
        { ...makeNotionHit(ANOTHER_UUID, "M2"), is_archived: 1 as unknown as boolean },
        {
          ...makeNotionHit(UNDASHED_UUID, "M3"),
          is_archived: null as unknown as boolean,
        },
      ])
    )

    const result = await searchViaRunTool(client, {
      query: "x",
      dataSourceId: "ds-mem",
      pageSize: 10,
    })

    expect(result.hits.map((h) => h.isArchived)).toEqual([false, false, false])
  })

  it("preserves is_archived when the server returns it", async () => {
    const { client } = makeStubClient(() =>
      makeAiSearchResponse([
        { ...makeNotionHit(DASHED_UUID, "Memory A"), is_archived: true },
        makeNotionHit(ANOTHER_UUID, "Memory B"),
      ])
    )

    const result = await searchViaRunTool(client, {
      query: "x",
      dataSourceId: "ds-mem",
      pageSize: 10,
    })

    expect(result.hits[0]!.isArchived).toBe(true)
    expect(result.hits[1]!.isArchived).toBe(false)
  })

  it("flags saturated=true when raw response returns the cap", async () => {
    const ids = Array.from(
      { length: RUNTOOL_SEARCH_MAX_PAGE_SIZE },
      (_, i) => `${i.toString(16).padStart(8, "0")}-aaaa-bbbb-cccc-dddddddddddd`
    )
    const { client } = makeStubClient(() =>
      makeAiSearchResponse(ids.map((id) => makeNotionHit(id, `M-${id}`)))
    )

    const result = await searchViaRunTool(client, {
      query: "x",
      dataSourceId: "ds-mem",
      pageSize: RUNTOOL_SEARCH_MAX_PAGE_SIZE,
    })

    expect(result.hits).toHaveLength(RUNTOOL_SEARCH_MAX_PAGE_SIZE)
    expect(result.saturated).toBe(true)
  })

  it("flags saturated=false when raw response is short", async () => {
    const { client } = makeStubClient(() =>
      makeAiSearchResponse([
        makeNotionHit(DASHED_UUID, "M1"),
        makeNotionHit(ANOTHER_UUID, "M2"),
      ])
    )

    const result = await searchViaRunTool(client, {
      query: "x",
      dataSourceId: "ds-mem",
      pageSize: 25,
    })

    expect(result.saturated).toBe(false)
  })

  it("returns searchType verbatim across the discriminated union", async () => {
    for (const type of ["ai_search", "workspace_search", "none"] as const) {
      const { client } = makeStubClient(() => ({ type, results: [] }))
      const result = await searchViaRunTool(client, {
        query: "x",
        dataSourceId: "ds-mem",
        pageSize: 5,
      })
      expect(result.searchType).toBe(type)
    }
  })
})
