/**
 * RunTool client + create-pages wrapper tests (issue #533, also
 * landing the Phase 1 client surface from issue #532 narrowed to
 * `create_pages`).
 *
 * These exercise the wire-shape envelope, the success / 401 / 403 /
 * 429 / 5xx / malformed paths, defensive chunking, and partial-commit
 * handling. Mocked HTTP only — no live Notion calls. The shared
 * stub `makeStubClientWithRequest` simulates the Notion SDK's
 * `client.request<T>(args)` contract by validating envelope shape
 * and returning either a stubbed `RunToolCreatePagesResponse` or a
 * thrown error mirroring `APIResponseError`'s discriminants
 * (`status` + `code`).
 */

import { describe, expect, it } from "vitest"
import type { Client } from "@notionhq/client"
import { runTool, RUNTOOL_PATH } from "./client.js"
import {
  BatchCreateError,
  createPagesViaRunTool,
  isBatchCreateError,
  RUNTOOL_CREATE_PAGES_DEFAULT_CHUNK,
  RUNTOOL_CREATE_PAGES_MAX_CHUNK,
} from "./create-pages.js"
import type {
  RunToolCreatePagesInputPage,
  RunToolCreatePagesParams,
  RunToolCreatePagesResponse,
} from "./types.js"

interface CapturedRequest {
  method: unknown
  path: unknown
  body: unknown
}

interface RequestStub {
  client: Client
  captured: CapturedRequest[]
}

/**
 * Build a stand-in `Client` whose `request` method captures every
 * call and dispatches via the supplied responder. The responder
 * receives the per-call request args and returns either a typed
 * RunTool response (resolved) or throws to simulate a Notion SDK
 * error path.
 */
function makeStubClientWithRequest(
  responder: (
    args: { method: string; path: string; body: Record<string, unknown> },
    callIndex: number
  ) => unknown | Promise<unknown>
): RequestStub {
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
      const result = await responder(args, i)
      return result
    },
  } as unknown as Client
  return { client: stub, captured }
}

function makePage(suffix: string): RunToolCreatePagesInputPage {
  return {
    properties: {
      Subject: { title: [{ text: { content: `subject-${suffix}` } }] },
      Object: { rich_text: [{ text: { content: `object-${suffix}` } }] },
    },
  }
}

function makeCreatePagesResponse(ids: string[]): RunToolCreatePagesResponse {
  return { pages: ids.map((id) => ({ id })) }
}

describe("runTool client envelope", () => {
  it("dispatches POST /v1/tools/run with `{ type, [type]: params }`", async () => {
    const params: RunToolCreatePagesParams = {
      parent: { type: "data_source_id", data_source_id: "ds-1" },
      pages: [makePage("a")],
    }
    const { client, captured } = makeStubClientWithRequest(() =>
      makeCreatePagesResponse(["page-a"])
    )

    const response = await runTool(client, "create_pages", params)

    expect(captured).toHaveLength(1)
    expect(captured[0]!.method).toBe("post")
    expect(captured[0]!.path).toBe(RUNTOOL_PATH)
    expect(captured[0]!.body).toEqual({
      type: "create_pages",
      create_pages: params,
    })
    // Asymmetric envelope: response is the bare per-tool shape, not
    // re-wrapped under `{ type, create_pages: ... }`.
    expect(response).toEqual({ pages: [{ id: "page-a" }] })
  })

  it("propagates SDK errors verbatim so callers can branch on status / code", async () => {
    const sdkError = Object.assign(new Error("rate_limited"), {
      status: 429,
      code: "rate_limited",
      headers: { "retry-after": "1" },
    })
    const { client } = makeStubClientWithRequest(() => {
      throw sdkError
    })

    await expect(
      runTool(client, "create_pages", {
        parent: { type: "data_source_id", data_source_id: "ds-1" },
        pages: [makePage("a")],
      })
    ).rejects.toBe(sdkError)
  })

  it.each([
    { status: 401, code: "unauthorized" },
    { status: 403, code: "restricted_resource" },
    { status: 500, code: "internal_server_error" },
  ])(
    "surfaces $status without retry so the caller's flag-on fallback can engage",
    async ({ status, code }) => {
      const sdkError = Object.assign(new Error(code), { status, code })
      let calls = 0
      const { client } = makeStubClientWithRequest(() => {
        calls += 1
        throw sdkError
      })
      await expect(
        runTool(client, "create_pages", {
          parent: { type: "data_source_id", data_source_id: "ds-1" },
          pages: [makePage("a")],
        })
      ).rejects.toBe(sdkError)
      // The wrapper itself does NOT retry — that's the SDK / rate-
      // limit middleware's job. One call, one error surfaced.
      expect(calls).toBe(1)
    }
  )

  // Envelope normalization (200-wrapped `{ object: "error" }` bodies)
  // belongs at the SDK-`request` layer where the rate-limit and
  // auth-refresh proxies can observe the throw — not here, where it
  // would land AFTER the proxies have already resolved successfully
  // and miss the bucket pause + ntn-refresh hooks. Tests that pin the
  // wrapper layering live in `client.test.ts` under
  // `wrapWithRunToolEnvelopeNormalizer`. The runTool dispatcher
  // propagates whatever the underlying `client.request` returns or
  // throws — verbatim.
})

describe("createPagesViaRunTool — empty + single chunk", () => {
  it("returns no-op on empty input without dispatching a request", async () => {
    const { client, captured } = makeStubClientWithRequest(() => {
      throw new Error("should not be called")
    })

    const result = await createPagesViaRunTool({
      client,
      parentDataSourceId: "ds-1",
      pages: [],
    })

    expect(result.createdPageIds).toEqual([])
    expect(captured).toHaveLength(0)
  })

  it("dispatches one request when input fits in one chunk", async () => {
    const pages = Array.from({ length: 3 }, (_, i) => makePage(`p${i}`))
    const { client, captured } = makeStubClientWithRequest(() =>
      makeCreatePagesResponse(["id-0", "id-1", "id-2"])
    )

    const result = await createPagesViaRunTool({
      client,
      parentDataSourceId: "ds-1",
      pages,
    })

    expect(result.createdPageIds).toEqual(["id-0", "id-1", "id-2"])
    expect(captured).toHaveLength(1)
    const body = captured[0]!.body as {
      type: string
      create_pages: RunToolCreatePagesParams
    }
    expect(body.type).toBe("create_pages")
    expect(body.create_pages.parent).toEqual({
      type: "data_source_id",
      data_source_id: "ds-1",
    })
    expect(body.create_pages.pages).toHaveLength(3)
  })
})

describe("createPagesViaRunTool — chunking", () => {
  it("clamps chunkSize to the documented server cap", async () => {
    const pages = Array.from({ length: 200 }, (_, i) => makePage(`p${i}`))
    let callIndex = 0
    const { client, captured } = makeStubClientWithRequest((_args, i) => {
      callIndex = i
      const start = i * RUNTOOL_CREATE_PAGES_MAX_CHUNK
      const length = Math.min(
        RUNTOOL_CREATE_PAGES_MAX_CHUNK,
        pages.length - start
      )
      return makeCreatePagesResponse(
        Array.from({ length }, (_, j) => `id-${start + j}`)
      )
    })

    const result = await createPagesViaRunTool({
      client,
      parentDataSourceId: "ds-1",
      pages,
      // Asking for 500 must not bypass the server cap.
      chunkSize: 500,
    })

    // 200 pages / 100-page cap = 2 chunks
    expect(captured).toHaveLength(2)
    expect(callIndex).toBe(1)
    expect(result.createdPageIds).toHaveLength(200)
    expect(result.createdPageIds[0]).toBe("id-0")
    expect(result.createdPageIds[199]).toBe("id-199")
  })

  it("uses the default chunk size when none is provided", async () => {
    const pages = Array.from(
      { length: RUNTOOL_CREATE_PAGES_DEFAULT_CHUNK + 1 },
      (_, i) => makePage(`p${i}`)
    )
    const { client, captured } = makeStubClientWithRequest((_args, i) => {
      const start = i * RUNTOOL_CREATE_PAGES_DEFAULT_CHUNK
      const length = Math.min(
        RUNTOOL_CREATE_PAGES_DEFAULT_CHUNK,
        pages.length - start
      )
      return makeCreatePagesResponse(
        Array.from({ length }, (_, j) => `id-${start + j}`)
      )
    })

    await createPagesViaRunTool({
      client,
      parentDataSourceId: "ds-1",
      pages,
    })

    expect(captured).toHaveLength(2)
    const firstChunk = (
      captured[0]!.body as {
        create_pages: RunToolCreatePagesParams
      }
    ).create_pages.pages
    const secondChunk = (
      captured[1]!.body as {
        create_pages: RunToolCreatePagesParams
      }
    ).create_pages.pages
    expect(firstChunk).toHaveLength(RUNTOOL_CREATE_PAGES_DEFAULT_CHUNK)
    expect(secondChunk).toHaveLength(1)
  })

  it("falls back to the default when chunkSize is non-positive", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => makePage(`p${i}`))
    const { client, captured } = makeStubClientWithRequest(() =>
      makeCreatePagesResponse(["a", "b", "c", "d"])
    )

    await createPagesViaRunTool({
      client,
      parentDataSourceId: "ds-1",
      pages,
      chunkSize: 0,
    })

    // 4 pages / default-100 → 1 chunk
    expect(captured).toHaveLength(1)
  })
})

describe("createPagesViaRunTool — converts Notion REST to SQLite-flat on the wire", () => {
  it("issues `create_pages` with SQLite-shape properties matching the empirical Facts DB schema", async () => {
    // Wire-format pin (PR #538 live-verification result against the
    // internal vault Facts DB schema). The `notion-create-pages`
    // alias schema notes "Some property types require expanded
    // format" without documenting the rules; we derived the rules
    // from a `query_data_sources` read and pinned them in
    // `sqlite-properties.test.ts`. This test confirms the
    // wrapper actually applies the conversion before dispatching —
    // a regression where the wrapper skipped the converter would
    // fail this assertion immediately.
    const { client, captured } = makeStubClientWithRequest(() =>
      makeCreatePagesResponse(["new-fact"])
    )

    await createPagesViaRunTool({
      client,
      parentDataSourceId: "ds-1",
      pages: [
        {
          properties: {
            Subject: {
              title: [{ text: { content: "WebView mentions BaseView" } }],
            },
            Predicate: { select: { name: "mentions" } },
            Object: { rich_text: [{ text: { content: "BaseView" } }] },
            Project: { relation: [{ id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] },
            "Valid From": { date: { start: "2026-05-05" } },
          },
        },
      ],
    })

    expect(captured).toHaveLength(1)
    const body = captured[0]!.body as {
      type: string
      create_pages: {
        parent: unknown
        pages: Array<{ properties: Record<string, unknown> }>
      }
    }
    expect(body.type).toBe("create_pages")
    expect(body.create_pages.pages).toHaveLength(1)

    const wireProps = body.create_pages.pages[0]!.properties
    // Title / select / rich_text are flat strings on the wire.
    expect(wireProps["Subject"]).toBe("WebView mentions BaseView")
    expect(wireProps["Predicate"]).toBe("mentions")
    expect(wireProps["Object"]).toBe("BaseView")
    // Relation is a JSON-stringified array of canonical Notion URLs.
    expect(wireProps["Project"]).toBe(
      '["https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]'
    )
    // Date is the 3-key expansion.
    expect(wireProps["date:Valid From:start"]).toBe("2026-05-05")
    expect(wireProps["date:Valid From:end"]).toBe(null)
    expect(wireProps["date:Valid From:is_datetime"]).toBe(0)
    // The bare "Valid From" key MUST NOT appear on the wire — the
    // server rejects it (`no such column: Valid From`).
    expect(wireProps).not.toHaveProperty("Valid From")
  })
})

describe("createPagesViaRunTool — failure semantics", () => {
  it("propagates the SDK error verbatim when the very first chunk fails", async () => {
    const sdkError = Object.assign(new Error("validation"), {
      status: 400,
      code: "validation_error",
    })
    const { client } = makeStubClientWithRequest(() => {
      throw sdkError
    })

    await expect(
      createPagesViaRunTool({
        client,
        parentDataSourceId: "ds-1",
        pages: [makePage("a")],
      })
    ).rejects.toBe(sdkError)
  })

  it("surfaces partial commit as BatchCreateError carrying the committed prefix", async () => {
    const sdkError = Object.assign(new Error("server error"), {
      status: 500,
      code: "internal_server_error",
    })
    const pages = Array.from({ length: 150 }, (_, i) => makePage(`p${i}`))
    // First chunk (100 pages) lands; second chunk (50 pages) throws.
    const { client } = makeStubClientWithRequest((_args, i) => {
      if (i === 0) {
        return makeCreatePagesResponse(
          Array.from({ length: 100 }, (_, j) => `id-${j}`)
        )
      }
      throw sdkError
    })

    let thrown: unknown
    try {
      await createPagesViaRunTool({
        client,
        parentDataSourceId: "ds-1",
        pages,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(BatchCreateError)
    expect(isBatchCreateError(thrown)).toBe(true)
    const batchErr = thrown as BatchCreateError
    expect(batchErr.committedIds).toHaveLength(100)
    expect(batchErr.committedIds[0]).toBe("id-0")
    expect(batchErr.committedIds[99]).toBe("id-99")
    expect(batchErr.cause).toBe(sdkError)
  })

  it("accumulates committed ids across multiple successful chunks before failing on a later chunk (PR #538 strong rec #1)", async () => {
    // The single-chunk-success / single-chunk-fail test above covers the
    // first→nth chunk transition for N=2. The wrapper accumulates
    // `createdPageIds` across all chunks (`create-pages.ts` `for`
    // loop), so a 3-chunk case where chunks 1 and 2 commit and chunk
    // 3 fails is a meaningfully different code path. Asserting
    // `committedIds.length === 200` and the order of ids across
    // chunks 1 + 2 pins multi-prefix accumulation against a future
    // refactor that might collapse the array tracking.
    const sdkError = Object.assign(new Error("server error"), {
      status: 500,
      code: "internal_server_error",
    })
    const pages = Array.from({ length: 250 }, (_, i) => makePage(`p${i}`))
    // 250 pages / 100 cap = 3 chunks (100/100/50). Chunks 1 + 2 land;
    // chunk 3 throws.
    const { client, captured } = makeStubClientWithRequest((_args, i) => {
      if (i === 0) {
        return makeCreatePagesResponse(
          Array.from({ length: 100 }, (_, j) => `id-${j}`)
        )
      }
      if (i === 1) {
        return makeCreatePagesResponse(
          Array.from({ length: 100 }, (_, j) => `id-${100 + j}`)
        )
      }
      throw sdkError
    })

    let thrown: unknown
    try {
      await createPagesViaRunTool({
        client,
        parentDataSourceId: "ds-1",
        pages,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(BatchCreateError)
    const batchErr = thrown as BatchCreateError
    expect(batchErr.committedIds).toHaveLength(200)
    expect(batchErr.committedIds[0]).toBe("id-0")
    expect(batchErr.committedIds[99]).toBe("id-99")
    expect(batchErr.committedIds[100]).toBe("id-100")
    expect(batchErr.committedIds[199]).toBe("id-199")
    expect(batchErr.cause).toBe(sdkError)
    // Three chunks dispatched: two committed, one failed.
    expect(captured).toHaveLength(3)
  })

  it("treats malformed responses (missing pages array) as protocol errors", async () => {
    const { client } = makeStubClientWithRequest(
      () => ({ /* missing pages */ }) as unknown
    )

    await expect(
      createPagesViaRunTool({
        client,
        parentDataSourceId: "ds-1",
        pages: [makePage("a")],
      })
    ).rejects.toThrow(/malformed response/)
  })

  it("treats malformed responses (page missing id) as protocol errors", async () => {
    const { client } = makeStubClientWithRequest(
      () => ({ pages: [{}] }) as unknown
    )

    await expect(
      createPagesViaRunTool({
        client,
        parentDataSourceId: "ds-1",
        pages: [makePage("a")],
      })
    ).rejects.toThrow(/malformed response/)
  })

  it("rejects when the response page count does not match the chunk size", async () => {
    const { client } = makeStubClientWithRequest(
      () => makeCreatePagesResponse(["only-one"]) as unknown
    )

    let thrown: unknown
    try {
      await createPagesViaRunTool({
        client,
        parentDataSourceId: "ds-1",
        pages: [makePage("a"), makePage("b")],
      })
    } catch (err) {
      thrown = err
    }
    // Mismatched page count after at least one valid id was credited
    // surfaces as a partial-commit error: the honest committed
    // prefix (`["only-one"]`) is on `committedIds`, the protocol
    // error is on `cause`. This is the wrapper's "honest prefix"
    // posture from the docstring — never silently consume a
    // structurally-invalid response.
    expect(thrown).toBeInstanceOf(BatchCreateError)
    const batchErr = thrown as BatchCreateError
    expect(batchErr.committedIds).toEqual(["only-one"])
    expect((batchErr.cause as Error).message).toMatch(
      /does not match request chunk size/
    )
  })
})

describe("BatchCreateError — message formatting", () => {
  it("singular vs plural for committed-id count", () => {
    const cause = new Error("server")
    const errOne = new BatchCreateError(["id-0"], cause)
    expect(errOne.message).toContain("1 page created")
    expect(errOne.message).not.toContain("1 pages created")

    const errMany = new BatchCreateError(["id-0", "id-1"], cause)
    expect(errMany.message).toContain("2 pages created")

    const errZero = new BatchCreateError([], cause)
    // Zero-prefix is a structural impossibility from
    // `createPagesViaRunTool` (the wrapper rethrows the SDK error
    // when no commits have landed) but the constructor does not
    // assume — guard via the plural form.
    expect(errZero.message).toContain("0 pages created")
  })
})
