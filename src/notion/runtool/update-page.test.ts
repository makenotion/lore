import { APIErrorCode, APIResponseError, Client as NotionClient } from "@notionhq/client"
import type { Client } from "@notionhq/client"
import { describe, expect, it, vi } from "vitest"
import {
  RUN_TOOL_PATH,
  RunToolBlockEditError,
  __resetRunToolWarningsForTest,
  runUpdatePageContent,
} from "./client.js"
import { isRunToolBlockEditEnabled, isRunToolEnabled } from "./flag.js"
import { updatePageContentViaRunTool } from "./update-page.js"

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

function buildClient(
  request: (args: { path: string; method: string; body: object }) => Promise<unknown>
): Client {
  return { request } as unknown as Client
}

describe("isRunToolBlockEditEnabled", () => {
  it("inherits from LORE_USE_RUNTOOL when the sub-flag is unset", () => {
    expect(isRunToolBlockEditEnabled({ LORE_USE_RUNTOOL: "1" })).toBe(true)
    expect(isRunToolBlockEditEnabled({ LORE_USE_RUNTOOL: "0" })).toBe(false)
  })

  it("lets LORE_USE_RUNTOOL_BLOCK_EDIT override the parent flag", () => {
    expect(
      isRunToolBlockEditEnabled({
        LORE_USE_RUNTOOL: "1",
        LORE_USE_RUNTOOL_BLOCK_EDIT: "0",
      })
    ).toBe(false)
    expect(
      isRunToolBlockEditEnabled({
        LORE_USE_RUNTOOL: "0",
        LORE_USE_RUNTOOL_BLOCK_EDIT: "1",
      })
    ).toBe(true)
  })

  it("defaults off with no env vars set", () => {
    expect(isRunToolBlockEditEnabled({})).toBe(false)
    expect(isRunToolEnabled({})).toBe(false)
  })

  it("ignores unrecognized values rather than crashing", () => {
    expect(isRunToolBlockEditEnabled({ LORE_USE_RUNTOOL: "maybe" })).toBe(false)
  })
})

describe("updatePageContentViaRunTool", () => {
  it("posts to /v1/tools/run with the update_page envelope on success", async () => {
    const requestSpy = vi.fn(async () => ({ page_id: "11111111111111111111111111111111" }))
    const client = buildClient(requestSpy)

    const result = await updatePageContentViaRunTool(client, {
      pageId: "11111111111111111111111111111111",
      updates: [{ oldStr: "anchor", newStr: "anchor + suffix" }],
    })

    expect(result).toEqual({ ok: true, deletionWarning: false })
    expect(requestSpy).toHaveBeenCalledTimes(1)
    expect(requestSpy).toHaveBeenCalledWith({
      path: RUN_TOOL_PATH,
      method: "post",
      body: {
        type: "update_page",
        update_page: {
          page_id: "11111111111111111111111111111111",
          command: "update_content",
          content_updates: [{ old_str: "anchor", new_str: "anchor + suffix" }],
        },
      },
    })
  })

  it("threads allow_deleting_content into the request when opted in", async () => {
    let captured: Record<string, unknown> | null = null
    const client = buildClient(async (args) => {
      captured = args.body as Record<string, unknown>
      return { page_id: "11111111111111111111111111111111" }
    })

    await updatePageContentViaRunTool(client, {
      pageId: "11111111111111111111111111111111",
      updates: [{ oldStr: "x", newStr: "y" }],
      allowDeletingContent: true,
    })

    const body = captured as unknown as {
      update_page: { allow_deleting_content?: boolean }
    } | null
    expect(body?.update_page.allow_deleting_content).toBe(true)
  })

  it("propagates replace_all_matches=true into the wire payload", async () => {
    let captured: Record<string, unknown> | null = null
    const client = buildClient(async (args) => {
      captured = args.body as Record<string, unknown>
      return { page_id: "11111111111111111111111111111111" }
    })

    await updatePageContentViaRunTool(client, {
      pageId: "11111111111111111111111111111111",
      updates: [{ oldStr: "x", newStr: "y", replaceAllMatches: true }],
    })

    const body = captured as unknown as {
      update_page: { content_updates: Array<{ replace_all_matches?: boolean }> }
    } | null
    expect(body?.update_page.content_updates[0]?.replace_all_matches).toBe(true)
  })

  it("throws no_match when the server reports the anchor was absent", async () => {
    // No-match validation errors must surface as fall-back-able so the
    // caller can re-issue against the existing REST/SDK full-body path
    // rather than silently leaving the body untouched.
    const err = buildApiError(
      APIErrorCode.ValidationError,
      400,
      "old_str did not match any content on the page"
    )
    const client = buildClient(async () => {
      throw err
    })

    await expect(
      updatePageContentViaRunTool(client, {
        pageId: "11111111111111111111111111111111",
        updates: [{ oldStr: "anchor", newStr: "anchor + suffix" }],
      })
    ).rejects.toMatchObject({
      name: "RunToolBlockEditError",
      kind: "no_match",
    })
  })

  it("throws multiple_matches when old_str is ambiguous server-side", async () => {
    const err = buildApiError(
      APIErrorCode.ValidationError,
      400,
      "old_str matches more than once and replace_all_matches is false"
    )
    const client = buildClient(async () => {
      throw err
    })

    await expect(
      updatePageContentViaRunTool(client, {
        pageId: "11111111111111111111111111111111",
        updates: [{ oldStr: "anchor", newStr: "anchor + suffix" }],
      })
    ).rejects.toMatchObject({
      name: "RunToolBlockEditError",
      kind: "multiple_matches",
    })
  })

  it("throws deletion_warning when the server flags removal without opt-in", async () => {
    // The wrapper must NOT silently bypass the warning even on a 200 —
    // pre-call uniqueness checks cannot detect "this edit removes a
    // child page", only the server can. Falling back lets the existing
    // SDK path apply, where allow_deleting_content semantics are
    // already well-established for the Lore caller.
    const requestSpy = vi.fn(async () => ({
      page_id: "11111111111111111111111111111111",
      deletion_warning: { message: "would remove 1 child page" },
    }))
    const client = buildClient(requestSpy)

    await expect(
      updatePageContentViaRunTool(client, {
        pageId: "11111111111111111111111111111111",
        updates: [{ oldStr: "x", newStr: "y" }],
      })
    ).rejects.toMatchObject({
      name: "RunToolBlockEditError",
      kind: "deletion_warning",
    })
  })

  it("surfaces the deletion warning flag when the caller opted in", async () => {
    // The opt-in path tolerates the warning so the audit surface above
    // can render it; the wrapper must NOT throw because the caller has
    // explicitly accepted the deletion semantics.
    const requestSpy = vi.fn(async () => ({
      page_id: "11111111111111111111111111111111",
      deletion_warning: [{ message: "would remove 1 child page" }],
    }))
    const client = buildClient(requestSpy)

    const result = await updatePageContentViaRunTool(client, {
      pageId: "11111111111111111111111111111111",
      updates: [{ oldStr: "x", newStr: "y" }],
      allowDeletingContent: true,
    })
    expect(result).toEqual({ ok: true, deletionWarning: true })
  })

  it.each([
    [APIErrorCode.Unauthorized, 401],
    [APIErrorCode.RateLimited, 429],
    [APIErrorCode.InternalServerError, 500],
  ])(
    "rethrows non-validation, non-restricted SDK errors verbatim (code=%s, status=%i)",
    async (code, status) => {
      // 401 / 429 / 5xx must propagate so the auth-refreshing proxy
      // gets its retry attempt and the existing 429 backoff path keeps
      // governing client-side pacing. Mapping them to
      // RunToolBlockEditError would break those gates. 403
      // RestrictedResource is the deliberate exception (see the
      // dedicated test below) — it cannot be repaired by auth refresh,
      // so it is classified as fall-back-able.
      const err = buildApiError(code, status, code)
      const client = buildClient(async () => {
        throw err
      })

      await expect(
        updatePageContentViaRunTool(client, {
          pageId: "11111111111111111111111111111111",
          updates: [{ oldStr: "x", newStr: "y" }],
        })
      ).rejects.toBe(err)
    }
  )

  it("classifies 403 RestrictedResource as restricted_resource (fall-back-able, not a hard error)", async () => {
    // Issue #534 security review: an integration-secret token (the
    // `LORE_NOTION_TOKEN` / pre-ntn `NOTION_API_TOKEN` paths) cannot
    // pass RunTool's actor-type check; the server returns 403
    // RestrictedResource. The auth-refresh proxy CANNOT repair this
    // (it only refreshes on 401 Unauthorized). If the wrapper
    // re-threw verbatim, every revision-append against an
    // integration-secret operator would fail end-to-end — turning a
    // flag flip into a hard outage. Classifying as fall-back-able
    // lets the call site drop into the canonical REST/SDK path,
    // which has a different capability surface and is already known
    // to work for that operator. README's "silently degrade … but
    // loud enough" rule pins this posture.
    __resetRunToolWarningsForTest()
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const err = buildApiError(
        APIErrorCode.RestrictedResource,
        403,
        "Only public integrations can access this API."
      )
      const client = buildClient(async () => {
        throw err
      })

      await expect(
        updatePageContentViaRunTool(client, {
          pageId: "11111111111111111111111111111111",
          updates: [{ oldStr: "x", newStr: "y" }],
        })
      ).rejects.toMatchObject({
        name: "RunToolBlockEditError",
        kind: "restricted_resource",
      })

      // Once-per-process stderr warning is the observability surface.
      // Without it, an operator on `LORE_NOTION_TOKEN` flipping
      // `LORE_USE_RUNTOOL=1` would see flag-on calls silently downgrade
      // with no diagnostic.
      const writes = stderrSpy.mock.calls.map((args) => String(args[0]))
      expect(writes.some((w) => w.includes("RestrictedResource"))).toBe(true)
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it("emits the restricted_resource warning at most once per process", async () => {
    // Sustained 403 from a misconfigured operator must not spam stderr
    // on every call. Pinning the once-per-process semantics so a future
    // refactor doesn't accidentally widen the emission.
    __resetRunToolWarningsForTest()
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const err = buildApiError(APIErrorCode.RestrictedResource, 403, "denied")
      const client = buildClient(async () => {
        throw err
      })
      for (let i = 0; i < 3; i++) {
        await expect(
          updatePageContentViaRunTool(client, {
            pageId: "11111111111111111111111111111111",
            updates: [{ oldStr: "x", newStr: "y" }],
          })
        ).rejects.toBeInstanceOf(RunToolBlockEditError)
      }
      const writes = stderrSpy.mock.calls.map((args) => String(args[0]))
      const restrictedWrites = writes.filter((w) => w.includes("RestrictedResource"))
      expect(restrictedWrites).toHaveLength(1)
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it("does NOT classify generic 400s as no_match (tightened from earlier permissive substrings)", async () => {
    // Earlier the classifier matched bare `"did not match"` /
    // `"not found in"` / `"no match"`, which would catch unrelated 400s
    // like `"User not found in workspace"` or
    // `"Could not find page with ID: <id> did not match a valid Notion ID"`
    // and silently re-classify them as `no_match`. The tightened
    // matchers require the `old_str` prefix that the `update_content`
    // path uses specifically — generic 400s now propagate verbatim so
    // the caller sees the actual server complaint.
    const userNotFound = buildApiError(
      APIErrorCode.ValidationError,
      400,
      "User not found in workspace"
    )
    const idMalformed = buildApiError(
      APIErrorCode.ValidationError,
      400,
      "Could not find page with ID: 1234 did not match a valid Notion ID"
    )
    for (const err of [userNotFound, idMalformed]) {
      const client = buildClient(async () => {
        throw err
      })
      await expect(
        updatePageContentViaRunTool(client, {
          pageId: "11111111111111111111111111111111",
          updates: [{ oldStr: "anchor", newStr: "x" }],
        })
      ).rejects.toBe(err)
    }
  })

  it("rejects malformed pageId (programmer-bug shape) before any wire call", async () => {
    // Defensive against accidental template-literal substitutions
    // (`undefined`, `[object Object]`) and bare strings that were
    // never UUIDs to begin with. Notion would reject these server-side
    // anyway; the local fail-fast keeps the diagnostic sharp.
    const requestSpy = vi.fn()
    for (const bad of ["undefined", "[object Object]", "page-1", "abc"]) {
      await expect(
        updatePageContentViaRunTool(buildClient(requestSpy as never), {
          pageId: bad,
          updates: [{ oldStr: "x", newStr: "y" }],
        })
      ).rejects.toThrow(/does not look like a Notion page id/)
    }
    expect(requestSpy).not.toHaveBeenCalled()
  })

  it("accepts the dashed-UUID and bare-32-hex page id forms", async () => {
    const requestSpy = vi.fn(async () => ({
      page_id: "11111111111111111111111111111111",
    }))
    const client = buildClient(requestSpy)
    for (const ok of [
      "11111111-1111-1111-1111-111111111111",
      "11111111111111111111111111111111",
    ]) {
      await expect(
        updatePageContentViaRunTool(client, {
          pageId: ok,
          updates: [{ oldStr: "x", newStr: "y" }],
        })
      ).resolves.toEqual({ ok: true, deletionWarning: false })
    }
    expect(requestSpy).toHaveBeenCalledTimes(2)
  })

  it("rethrows malformed/unknown errors verbatim (not a RunToolBlockEditError)", async () => {
    const err = new Error("parse error: Unexpected token <")
    const client = buildClient(async () => {
      throw err
    })

    await expect(
      updatePageContentViaRunTool(client, {
        pageId: "11111111111111111111111111111111",
        updates: [{ oldStr: "x", newStr: "y" }],
      })
    ).rejects.toBe(err)
  })

  it("rejects empty pageId before any wire call", async () => {
    const requestSpy = vi.fn()
    await expect(
      updatePageContentViaRunTool(buildClient(requestSpy as never), {
        pageId: "  ",
        updates: [{ oldStr: "x", newStr: "y" }],
      })
    ).rejects.toThrow(/pageId is required/)
    expect(requestSpy).not.toHaveBeenCalled()
  })

  it("rejects empty updates array before any wire call", async () => {
    const requestSpy = vi.fn()
    await expect(
      updatePageContentViaRunTool(buildClient(requestSpy as never), {
        pageId: "11111111111111111111111111111111",
        updates: [],
      })
    ).rejects.toThrow(/non-empty/)
    expect(requestSpy).not.toHaveBeenCalled()
  })

  it("rejects empty old_str before any wire call", async () => {
    // Empty anchor cannot be a unique substring, and the server's
    // matching semantics on it are documented as ambiguous. Failing
    // fast keeps a programming error from looking like a transient
    // "no match" the caller would silently fall back from.
    const requestSpy = vi.fn()
    await expect(
      updatePageContentViaRunTool(buildClient(requestSpy as never), {
        pageId: "11111111111111111111111111111111",
        updates: [{ oldStr: "", newStr: "y" }],
      })
    ).rejects.toThrow(/oldStr cannot be empty/)
    expect(requestSpy).not.toHaveBeenCalled()
  })

  it("rejects intra-batch duplicate anchors when replace_all_matches is unset", async () => {
    // Two edits with the same old_str but no replace_all_matches would
    // hit the second edit's "multiple matches" failure server-side
    // — surface the diagnosis up front so the caller fixes the bug
    // rather than retrying into the same wall.
    const requestSpy = vi.fn()
    await expect(
      updatePageContentViaRunTool(buildClient(requestSpy as never), {
        pageId: "11111111111111111111111111111111",
        updates: [
          { oldStr: "x", newStr: "a" },
          { oldStr: "x", newStr: "b" },
        ],
      })
    ).rejects.toThrow(/duplicate oldStr/)
    expect(requestSpy).not.toHaveBeenCalled()
  })

  it("allows duplicate anchors when replace_all_matches is set", async () => {
    const requestSpy = vi.fn(async () => ({ page_id: "11111111111111111111111111111111" }))
    await expect(
      updatePageContentViaRunTool(buildClient(requestSpy), {
        pageId: "11111111111111111111111111111111",
        updates: [
          { oldStr: "x", newStr: "a", replaceAllMatches: true },
          { oldStr: "x", newStr: "b", replaceAllMatches: true },
        ],
      })
    ).resolves.toEqual({ ok: true, deletionWarning: false })
  })
})

describe("runUpdatePageContent", () => {
  it("returns the bare resource response without an outer envelope", async () => {
    // The README's "asymmetric envelope" rule pinned: response is the
    // per-tool resource, not `{ type, [tool]: ... }`. A wrapper that
    // typed the response mirroring the request would trip on first
    // call.
    const requestSpy = vi.fn(async () => ({
      page_id: "11111111111111111111111111111111",
      results: ["something"],
    }))
    const client = buildClient(requestSpy)

    const response = await runUpdatePageContent(client, {
      page_id: "11111111111111111111111111111111",
      command: "update_content",
      content_updates: [{ old_str: "anchor", new_str: "anchor + suffix" }],
    })
    expect(response).toMatchObject({ page_id: "11111111111111111111111111111111", results: ["something"] })
  })

  it("classifies 'not found in' wording as no_match", async () => {
    const err = buildApiError(
      APIErrorCode.ValidationError,
      400,
      "old_str was not found in the document body"
    )
    const client = buildClient(async () => {
      throw err
    })
    await expect(
      runUpdatePageContent(client, {
        page_id: "11111111111111111111111111111111",
        command: "update_content",
        content_updates: [{ old_str: "anchor", new_str: "x" }],
      })
    ).rejects.toBeInstanceOf(RunToolBlockEditError)
  })
})

describe("RUN_TOOL_PATH (SDK-relative path contract — issue #534 cycle 18 review)", () => {
  it("instantiates a real Notion v5 SDK Client and asserts the URL it builds is /v1/tools/run (NOT /v1//v1/tools/run)", async () => {
    // The Notion v5 SDK builds the wire URL as `${prefixUrl}${path}`
    // where `prefixUrl = ${baseUrl}/v1/`. Passing an absolute
    // "/v1/tools/run" would produce a double-prefixed URL
    // ("https://api.notion.com/v1//v1/tools/run") and miss the
    // endpoint entirely — every flagged-on call would hard-fail with
    // a non-fall-back-able 404 / unknown-path error, defeating the
    // wrapper's per-call fallback contract.
    //
    // This test threads a stub `fetch` into a real `Client` so the
    // SDK's actual URL construction is observable. A regression that
    // re-introduces the leading "/v1/" (or any other path-prefix
    // mistake) fails the URL assertion before the bare-mock
    // wrapper-level tests above ever get a chance to mask it.
    let capturedUrl: URL | null = null
    const stubFetch = vi.fn(async (input: URL | Request | string) => {
      capturedUrl =
        input instanceof URL
          ? input
          : input instanceof Request
            ? new URL(input.url)
            : new URL(String(input))
      return new Response(JSON.stringify({ page_id: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })
    const realClient = new NotionClient({
      auth: "ntn_test_token",
      fetch: stubFetch as unknown as typeof fetch,
    })

    await runUpdatePageContent(realClient, {
      page_id: "11111111111111111111111111111111",
      command: "update_content",
      content_updates: [{ old_str: "anchor", new_str: "x" }],
    })

    expect(capturedUrl).not.toBeNull()
    // The SDK's `prefixUrl` is `https://api.notion.com/v1/` (with
    // trailing slash); the wrapper's path is `tools/run` (relative,
    // no leading slash). Concatenated produces the canonical
    // endpoint URL with exactly one `/v1/` segment.
    const url = capturedUrl as unknown as URL
    expect(url.pathname).toBe("/v1/tools/run")
    expect(url.host).toBe("api.notion.com")
    // Defensive: the regression we're guarding against is the double-
    // prefix shape. Asserting it explicitly so the failure message
    // names the bug if the constant ever drifts back to absolute.
    expect(url.pathname).not.toContain("//")
    expect(url.pathname).not.toMatch(/\/v1\/v1\//)

    expect(stubFetch).toHaveBeenCalledTimes(1)
  })

  it("RUN_TOOL_PATH is the SDK-relative form (no leading slash, no v1 prefix)", () => {
    // Pin the constant's shape so a future contributor can't change
    // it back to absolute without a failing test naming the wire
    // contract.
    expect(RUN_TOOL_PATH).toBe("tools/run")
    expect(RUN_TOOL_PATH.startsWith("/")).toBe(false)
    expect(RUN_TOOL_PATH.startsWith("v1/")).toBe(false)
  })
})
