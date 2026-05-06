import { APIErrorCode, APIResponseError, LogLevel } from "@notionhq/client"
import type { Client } from "@notionhq/client"
import { describe, expect, it, vi } from "vitest"
import {
  createAuthRefreshingClient,
  resolveSdkDebugOptions,
  stderrSdkLogger,
  wrapWithRunToolEnvelopeNormalizer,
} from "./client.js"
import { createLimitedClient } from "./rate-limit.js"

describe("resolveSdkDebugOptions", () => {
  it("returns null when LORE_DEBUG is unset so the SDK keeps its default LogLevel.WARN", () => {
    // Default-quiet is the contract operators rely on — adding INFO
    // to every CLI session would re-introduce stderr noise in normal
    // operation. The opt-in gate is the load-bearing rule.
    expect(resolveSdkDebugOptions({})).toBeNull()
  })

  it("returns null for non-'1' LORE_DEBUG values (no truthy interpretation)", () => {
    // We intentionally do NOT treat `LORE_DEBUG=true` /
    // `LORE_DEBUG=yes` as opt-in — the codebase's existing
    // `LORE_DEBUG=1` convention (memory.ts, near-duplicate probe) is
    // the single shape, and a parallel truthy ladder here would
    // silently diverge from it.
    expect(resolveSdkDebugOptions({ LORE_DEBUG: "0" })).toBeNull()
    expect(resolveSdkDebugOptions({ LORE_DEBUG: "true" })).toBeNull()
    expect(resolveSdkDebugOptions({ LORE_DEBUG: "" })).toBeNull()
  })

  it("returns LogLevel.INFO + the stderr logger when LORE_DEBUG=1", () => {
    // INFO is the level at which the Notion SDK emits "retrying
    // request" with `{ method, path, attempt, delayMs }` — the
    // diagnostic that distinguishes a quiet `Retry-After`-induced
    // sleep from a genuine hang. DEBUG would also expose request
    // bodies, which can leak vault content into operator-shared
    // logs; INFO is the right tradeoff.
    const opts = resolveSdkDebugOptions({ LORE_DEBUG: "1" })
    expect(opts).not.toBeNull()
    expect(opts?.logLevel).toBe(LogLevel.INFO)
    expect(opts?.logger).toBe(stderrSdkLogger)
  })
})

describe("stderrSdkLogger", () => {
  it("writes to stderr with a [lore] prefix so log aggregation patterns keep working", () => {
    // The SDK's default `makeConsoleLogger` routes INFO through
    // `console.info` → stdout in Node, which would silently
    // pollute the stdout of any CLI command piped into a parser.
    // stderr is the right destination; the `[lore]` prefix matches
    // the `[lore] partial-failure:` shape used elsewhere so a
    // single grep keeps surfacing both.
    const stderrChunks: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8")
        )
        return true
      })

    stderrSdkLogger(LogLevel.INFO, "retrying request", {
      method: "POST",
      path: "/v1/data_sources/abc/query",
      attempt: 2,
      delayMs: 1000,
    })

    stderrSpy.mockRestore()

    expect(stderrChunks).toHaveLength(1)
    const line = stderrChunks[0]!
    expect(line).toMatch(/^\[lore\] notion-sdk info: retrying request /)
    expect(line).toContain('"method":"POST"')
    expect(line).toContain('"delayMs":1000')
    expect(line.endsWith("\n")).toBe(true)
  })

  it("breaks circular references in extraInfo via redactDebugExtraInfo's WeakSet", () => {
    // Circular references in SDK extra-info (an error with a `cause`
    // chain pointing back at itself, a request object holding a
    // reference to its own response) used to fall back to a literal
    // `[unserializable extraInfo]` sentinel. Issue #488's redaction
    // pipeline walks `extraInfo` recursively and substitutes circular
    // back-references with `<circular>`, so the diagnostic value
    // survives even when the SDK passes a self-referencing payload.
    // The try/catch around `JSON.stringify` is still load-bearing for
    // non-circular failures (BigInt, symbol, function values) — see
    // the `[unserializable extraInfo]` test below.
    const stderrChunks: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8")
        )
        return true
      })

    const circular: Record<string, unknown> = {}
    circular["self"] = circular

    expect(() => stderrSdkLogger(LogLevel.WARN, "circular extra", circular)).not.toThrow()

    stderrSpy.mockRestore()

    expect(stderrChunks).toEqual([
      '[lore] notion-sdk warn: circular extra {"self":"<circular>"}\n',
    ])
  })

  it("falls back to [unserializable extraInfo] when JSON.stringify throws on a non-circular value", () => {
    // The redactor walks circular refs cleanly, so the residual case
    // for the try/catch is non-circular `JSON.stringify` failures —
    // BigInt values, symbols, and other shapes the SDK could plausibly
    // attach to a future extra-info payload. Pin the fallback so a
    // refactor that drops the try/catch surfaces here.
    const stderrChunks: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8")
        )
        return true
      })

    // BigInt is not JSON-serializable and `JSON.stringify` throws a
    // TypeError. The redactor passes scalars through unchanged, so the
    // post-redaction value still trips the same path.
    const bigintExtra = { id: 9007199254740993n }

    expect(() =>
      stderrSdkLogger(LogLevel.WARN, "bigint extra", bigintExtra)
    ).not.toThrow()

    stderrSpy.mockRestore()

    expect(stderrChunks).toEqual([
      "[lore] notion-sdk warn: bigint extra [unserializable extraInfo]\n",
    ])
  })

  it("redacts page-id substrings in SDK paths (issue #488 — primary leak vector)", () => {
    // The SDK's INFO-level "Retrying request" trace passes
    // `path: "/v1/pages/<32-hex>"` on every retry, which is the strictly
    // worst page-id leak under LORE_DEBUG=1 — every retry attempt emits
    // a structurally-guaranteed page id to stderr. Pin the redactor
    // routing so the leak can't regress without this test failing.
    const stderrChunks: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8")
        )
        return true
      })

    stderrSdkLogger(LogLevel.INFO, "Retrying request", {
      method: "PATCH",
      path: "/v1/pages/abcdef0123456789abcdef0123456789",
      attempt: 2,
      delayMs: 1000,
    })

    stderrSpy.mockRestore()

    const line = stderrChunks[0]!
    expect(line).toContain('"path":"/v1/pages/<page-id>"')
    expect(line).not.toContain("abcdef0123456789abcdef0123456789")
    // Operator-actionable scalars survive unchanged.
    expect(line).toContain('"attempt":2')
    expect(line).toContain('"delayMs":1000')
  })

  it("redacts page-id substrings in the SDK message itself", () => {
    // Some SDK error paths interpolate a page id directly into
    // `message` (e.g. InvalidPathParameterError) rather than carrying
    // it on `extraInfo.path`. Both paths route through the redactor.
    const stderrChunks: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8")
        )
        return true
      })

    stderrSdkLogger(
      LogLevel.WARN,
      "InvalidPathParameterError: page abcdef0123456789abcdef0123456789 not found",
      {},
    )

    stderrSpy.mockRestore()

    expect(stderrChunks[0]).toContain("page <page-id> not found")
    expect(stderrChunks[0]).not.toContain("abcdef0123456789abcdef0123456789")
  })

  it("wholesale-redacts the headers key in extraInfo, neutralizing bearer-token leaks at the source", () => {
    // Today's SDK does not interpolate Authorization headers into the
    // logger payload. The defense is forward-compatible — historical
    // SDK regressions in adjacent ecosystems (axios pre-1.x echoing
    // Authorization headers in retry traces) make the guard
    // load-bearing. Under the issue-#488 review-4 key-aware extraInfo
    // contract, `headers` is in `SENSITIVE_EXTRA_INFO_KEYS` and is
    // wholesale-redacted before the bearer-token substring regex
    // would run — so the protection is strictly stronger than
    // substring-scrubbing alone (the entire structure under the key
    // is replaced, not just the token-shaped leaf).
    const stderrChunks: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8")
        )
        return true
      })

    stderrSdkLogger(LogLevel.WARN, "auth retry", {
      headers: { authorization: "Bearer ntn_aaaaaaaaaaaaaaaaaaaaaaaa" },
    })

    stderrSpy.mockRestore()

    const line = stderrChunks[0]!
    // The structured payload under `headers` collapses to `<redacted>`
    // BEFORE the bearer-token regex sees the leaf — the token never
    // appears in stderr at all.
    expect(line).toContain('"headers":"<redacted>"')
    expect(line).not.toContain("ntn_aaaaaaaaaaaaaaaaaaaaaaaa")
    expect(line).not.toContain("Bearer")
    expect(line).not.toContain("authorization")
  })

  it("wholesale-redacts a body= structured payload in extraInfo (issue #488 review-4 blocker)", () => {
    // Concrete reproduction of review #6's blocker: an SDK shape
    // like `{ body: { properties: { Name: { title: [...] } } } }`
    // walked recursively under the leaf-only redactor and the title
    // content survived. Key-aware redaction under
    // `SENSITIVE_EXTRA_INFO_KEYS` collapses the entire structure
    // before the substring regex runs.
    const stderrChunks: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8")
        )
        return true
      })

    stderrSdkLogger(LogLevel.WARN, "request failed", {
      body: {
        properties: { Name: { title: [{ text: { content: "private workspace body" } }] } },
        parent: { page_id: "abcdef0123456789abcdef0123456789" },
      },
    })

    stderrSpy.mockRestore()

    const line = stderrChunks[0]!
    expect(line).toContain('"body":"<redacted>"')
    expect(line).not.toContain("private workspace body")
    expect(line).not.toContain("properties")
    expect(line).not.toContain("title")
    expect(line).not.toContain("abcdef0123456789abcdef0123456789")
  })

  it("omits the JSON suffix when extraInfo is empty so plain messages stay readable", () => {
    const stderrChunks: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8")
        )
        return true
      })

    stderrSdkLogger(LogLevel.WARN, "hello", {})

    stderrSpy.mockRestore()

    expect(stderrChunks).toEqual(["[lore] notion-sdk warn: hello\n"])
  })
})

describe("createAuthRefreshingClient", () => {
  function unauthorizedError(message = "unauthorized"): APIResponseError {
    return new APIResponseError({
      code: APIErrorCode.Unauthorized,
      status: 401,
      message,
      headers: new Headers(),
      rawBodyText: `{"code":"unauthorized","message":"${message}"}`,
      additional_data: undefined,
      request_id: undefined,
    })
  }

  it("rebuilds the SDK client, emits an event, and retries once after refreshed auth changes", async () => {
    const oldRetrieve = vi.fn(async () => {
      throw unauthorizedError()
    })
    const newRetrieve = vi.fn(async () => ({ id: "ok" }))
    const createClient = vi.fn((token: string) => {
      const retrieve = token === "old-token" ? oldRetrieve : newRetrieve
      return { pages: { retrieve } } as unknown as Client
    })
    const refreshAuth = vi.fn(async () => ({
      kind: "refreshed" as const,
      auth: { token: "new-token" },
      source: "ntn-auth-json",
    }))
    const refreshEvents: unknown[] = []
    const authChanges: unknown[] = []

    const client = createAuthRefreshingClient({ token: "old-token" }, refreshAuth, {
      createClient,
      onRefresh: (event) => refreshEvents.push(event),
      onAuthChange: (auth) => authChanges.push(auth),
    })

    await expect(client.pages.retrieve({ page_id: "page" })).resolves.toEqual({
      id: "ok",
    })
    expect(refreshAuth).toHaveBeenCalledWith({ token: "old-token" })
    expect(createClient).toHaveBeenCalledTimes(2)
    expect(oldRetrieve).toHaveBeenCalledTimes(1)
    expect(newRetrieve).toHaveBeenCalledTimes(1)
    expect(refreshEvents).toEqual([{ kind: "refreshed", source: "ntn-auth-json" }])
    expect(authChanges).toEqual([{ token: "new-token" }])
  })

  it("does not call refreshAuth a second time when refresh reports unchanged auth", async () => {
    const retrieve = vi.fn(async () => {
      throw unauthorizedError("still unauthorized")
    })
    const createClient = vi.fn(() => ({ pages: { retrieve } }) as unknown as Client)
    const refreshAuth = vi.fn(async () => ({ kind: "unchanged" as const }))
    const refreshEvents: unknown[] = []
    const client = createAuthRefreshingClient({ token: "same-token" }, refreshAuth, {
      createClient,
      onRefresh: (event) => refreshEvents.push(event),
    })

    await expect(client.pages.retrieve({ page_id: "page" })).rejects.toThrow(
      "still unauthorized"
    )
    expect(refreshAuth).toHaveBeenCalledTimes(1)
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(retrieve).toHaveBeenCalledTimes(1)
    expect(refreshEvents).toEqual([{ kind: "skipped", reason: "unchanged" }])
  })

  it("bounds retry to one refreshed attempt", async () => {
    const oldRetrieve = vi.fn(async () => {
      throw unauthorizedError("old unauthorized")
    })
    const newRetrieve = vi.fn(async () => {
      throw unauthorizedError("new unauthorized")
    })
    const createClient = vi.fn((token: string) => {
      const retrieve = token === "old-token" ? oldRetrieve : newRetrieve
      return { pages: { retrieve } } as unknown as Client
    })
    const refreshAuth = vi.fn(async () => ({
      kind: "refreshed" as const,
      auth: { token: "new-token" },
      source: "ntn-auth-json",
    }))
    const client = createAuthRefreshingClient({ token: "old-token" }, refreshAuth, {
      createClient,
      onRefresh: () => {},
    })

    await expect(client.pages.retrieve({ page_id: "page" })).rejects.toThrow(
      "new unauthorized"
    )
    expect(refreshAuth).toHaveBeenCalledTimes(1)
    expect(oldRetrieve).toHaveBeenCalledTimes(1)
    expect(newRetrieve).toHaveBeenCalledTimes(1)
  })

  it("dedupes concurrent 401 refresh attempts and retries both calls with the new client", async () => {
    let resolveRefresh!: (value: {
      kind: "refreshed"
      auth: { token: string }
      source: string
    }) => void
    const refreshGate = new Promise<{
      kind: "refreshed"
      auth: { token: string }
      source: string
    }>((resolve) => {
      resolveRefresh = resolve
    })
    let markRefreshStarted!: () => void
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const oldRetrieve = vi.fn(async () => {
      throw unauthorizedError()
    })
    const newRetrieve = vi.fn(async () => ({ id: "ok" }))
    const createClient = vi.fn((token: string) => {
      const retrieve = token === "old-token" ? oldRetrieve : newRetrieve
      return { pages: { retrieve } } as unknown as Client
    })
    const refreshAuth = vi.fn(() => {
      markRefreshStarted()
      return refreshGate
    })
    const client = createAuthRefreshingClient({ token: "old-token" }, refreshAuth, {
      createClient,
      onRefresh: () => {},
    })

    const first = client.pages.retrieve({ page_id: "one" })
    const second = client.pages.retrieve({ page_id: "two" })
    await refreshStarted
    expect(oldRetrieve).toHaveBeenCalledTimes(2)
    expect(refreshAuth).toHaveBeenCalledTimes(1)

    resolveRefresh({
      kind: "refreshed",
      auth: { token: "new-token" },
      source: "ntn-auth-json",
    })

    await expect(Promise.all([first, second])).resolves.toEqual([
      { id: "ok" },
      { id: "ok" },
    ])
    expect(createClient).toHaveBeenCalledTimes(2)
    expect(newRetrieve).toHaveBeenCalledTimes(2)
  })

  it("does not refresh for non-Notion errors that merely look like 401s", async () => {
    const lookalike = Object.assign(new Error("not a notion sdk error"), {
      status: 401,
      code: "unauthorized",
    })
    const retrieve = vi.fn(async () => {
      throw lookalike
    })
    const refreshAuth = vi.fn(async () => ({ kind: "unchanged" as const }))
    const client = createAuthRefreshingClient({ token: "same-token" }, refreshAuth, {
      createClient: () => ({ pages: { retrieve } }) as unknown as Client,
      onRefresh: () => {},
    })

    await expect(client.pages.retrieve({ page_id: "page" })).rejects.toBe(lookalike)
    expect(refreshAuth).not.toHaveBeenCalled()
  })

  it("memoizes proxied namespaces and methods so captured methods survive refresh", async () => {
    const oldRetrieve = vi.fn(async () => {
      throw unauthorizedError()
    })
    const newRetrieve = vi.fn(async () => ({ id: "ok" }))
    const createClient = vi.fn((token: string) => {
      const retrieve = token === "old-token" ? oldRetrieve : newRetrieve
      return { pages: { retrieve } } as unknown as Client
    })
    const refreshAuth = vi.fn(async () => ({
      kind: "refreshed" as const,
      auth: { token: "new-token" },
      source: "ntn-auth-json",
    }))
    const client = createAuthRefreshingClient({ token: "old-token" }, refreshAuth, {
      createClient,
      onRefresh: () => {},
    })

    const pages = client.pages
    const retrieve = client.pages.retrieve
    expect(client.pages).toBe(pages)
    expect(client.pages.retrieve).toBe(retrieve)

    await expect(retrieve({ page_id: "page" })).resolves.toEqual({ id: "ok" })
    expect(newRetrieve).toHaveBeenCalledTimes(1)
  })

  it("emits refresh diagnostics by default and skip diagnostics only under LORE_DEBUG", async () => {
    const stderrChunks: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8")
        )
        return true
      })

    const refreshedClient = createAuthRefreshingClient(
      { token: "old-token" },
      async () => ({
        kind: "refreshed" as const,
        auth: { token: "new-token" },
        source: "ntn-auth-json",
      }),
      {
        createClient: (token) =>
          ({
            pages: {
              retrieve: async () => {
                if (token === "old-token") throw unauthorizedError()
                return { id: "ok" }
              },
            },
          }) as unknown as Client,
      }
    )
    await refreshedClient.pages.retrieve({ page_id: "page" })

    const priorDebug = process.env["LORE_DEBUG"]
    const createUnauthorizedClient = () =>
      ({
        pages: {
          retrieve: async () => {
            throw unauthorizedError()
          },
        },
      }) as unknown as Client

    try {
      delete process.env["LORE_DEBUG"]
      const quietUnchangedClient = createAuthRefreshingClient(
        { token: "same-token" },
        async () => ({ kind: "unchanged" as const }),
        { createClient: createUnauthorizedClient }
      )
      await expect(
        quietUnchangedClient.pages.retrieve({ page_id: "page" })
      ).rejects.toThrow("unauthorized")
      expect(stderrChunks).toEqual([
        "[lore] auth: refreshed ntn token after 401 (source=ntn-auth-json)\n",
      ])

      process.env["LORE_DEBUG"] = "1"
      const unchangedClient = createAuthRefreshingClient(
        { token: "same-token" },
        async () => ({ kind: "unchanged" as const }),
        { createClient: createUnauthorizedClient }
      )
      await expect(unchangedClient.pages.retrieve({ page_id: "page" })).rejects.toThrow(
        "unauthorized"
      )

      const unavailableClient = createAuthRefreshingClient(
        { token: "same-token" },
        async () => {
          throw new Error("auth resolver exploded")
        },
        { createClient: createUnauthorizedClient }
      )
      await expect(unavailableClient.pages.retrieve({ page_id: "page" })).rejects.toThrow(
        "unauthorized"
      )
    } finally {
      if (priorDebug === undefined) {
        delete process.env["LORE_DEBUG"]
      } else {
        process.env["LORE_DEBUG"] = priorDebug
      }
      stderrSpy.mockRestore()
    }

    expect(stderrChunks).toEqual([
      "[lore] auth: refreshed ntn token after 401 (source=ntn-auth-json)\n",
      "[lore] auth: 401 refresh skipped (token unchanged)\n",
      "[lore] auth: 401 refresh skipped (auth unavailable): auth resolver exploded\n",
    ])
  })

  it("routes 401 refresh-skipped suffix through redactDebugMessage (issue #488)", async () => {
    // The auth-resolver's failure surface (auth.json read errors,
    // users.me network blips) is the same SDK / network / config-walk
    // path that produces the messages every other LORE_DEBUG emitter
    // scrubs. Pin that the suffix routes through the shared redactor
    // so a resolver error carrying a page-id substring cannot bypass
    // the helper just because this emitter sits in src/notion/.
    const stderrChunks: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8")
        )
        return true
      })

    const priorDebug = process.env["LORE_DEBUG"]
    process.env["LORE_DEBUG"] = "1"
    try {
      const client = createAuthRefreshingClient(
        { token: "same-token" },
        async () => {
          throw new Error("read failed for page abcdef0123456789abcdef0123456789")
        },
        {
          createClient: () =>
            ({
              pages: {
                retrieve: async () => {
                  throw unauthorizedError()
                },
              },
            }) as unknown as Client,
        },
      )
      await expect(client.pages.retrieve({ page_id: "page" })).rejects.toThrow(
        "unauthorized",
      )
    } finally {
      if (priorDebug === undefined) {
        delete process.env["LORE_DEBUG"]
      } else {
        process.env["LORE_DEBUG"] = priorDebug
      }
      stderrSpy.mockRestore()
    }

    const skippedLine = stderrChunks.find((line) => line.includes("auth unavailable"))
    expect(skippedLine).toBeDefined()
    expect(skippedLine).toContain("<page-id>")
    expect(skippedLine).not.toContain("abcdef0123456789abcdef0123456789")
  })

  it("retries top-level client.request after refreshed auth — RunTool dispatch path (issue #534)", async () => {
    // RunTool calls dispatch through `client.request({ path: "tools/run",
    // method: "post", body })`. (The path is SDK-relative — the Notion v5
    // SDK's `Client.request()` builds `${prefixUrl}${path}` where
    // `prefixUrl = ${baseUrl}/v1/`, so the wire URL is
    // `https://api.notion.com/v1/tools/run`.) The auth-refreshing Proxy's
    // recursive wrap memoizes wrapped methods at every namespace depth,
    // including top-level callables — but a regression that
    // special-cased the typed namespaces (`pages`, `dataSources`, etc.)
    // without including `request` would silently let RunTool call sites
    // bypass the 401 refresh. Pin the contract explicitly so the wrap
    // can't drift off the dispatch path used by every issue-#534
    // anchored block edit.
    const oldRequest = vi.fn(async () => {
      throw unauthorizedError()
    })
    const newRequest = vi.fn(async () => ({ ok: true, page_id: "post-refresh" }))
    const createClient = vi.fn((token: string) => {
      const request = token === "old-token" ? oldRequest : newRequest
      return { request } as unknown as Client
    })
    const refreshAuth = vi.fn(async () => ({
      kind: "refreshed" as const,
      auth: { token: "new-token" },
      source: "ntn-auth-json",
    }))

    const client = createAuthRefreshingClient({ token: "old-token" }, refreshAuth, {
      createClient,
      onRefresh: () => {},
    })

    await expect(
      client.request({ path: "tools/run", method: "post", body: {} }),
    ).resolves.toEqual({ ok: true, page_id: "post-refresh" })
    expect(refreshAuth).toHaveBeenCalledTimes(1)
    expect(createClient).toHaveBeenCalledTimes(2)
    expect(oldRequest).toHaveBeenCalledTimes(1)
    expect(newRequest).toHaveBeenCalledTimes(1)
  })
})

// Surfaced by the issue #535 vault-validation harness on 2026-05-06:
// Notion's `tools/run` gateway can resolve with a `200 OK` body shaped
// like `{ object: "error", status: 429, code: "rate_limited" }`
// instead of throwing. Without normalization at the SDK-`request`
// layer, the rate-limit and auth-refresh proxies miss the throw and
// their bucket-pause / 401-retry hooks never engage. The wrapper
// re-shapes the envelope as `APIResponseError` so the proxies catch
// it exactly as they would a native SDK error.
describe("wrapWithRunToolEnvelopeNormalizer", () => {
  function stubRequestClient(
    impl: () => Promise<unknown> | unknown,
  ): { client: Client; calls: { count: number } } {
    const calls = { count: 0 }
    const client = {
      request: vi.fn(async () => {
        calls.count += 1
        return await impl()
      }),
    } as unknown as Client
    return { client, calls }
  }

  it("returns a successful body unchanged", async () => {
    const { client } = stubRequestClient(() => ({ ok: true, page_id: "p" }))
    const wrapped = wrapWithRunToolEnvelopeNormalizer(client)
    await expect(
      wrapped.request({ path: "tools/run", method: "post", body: {} }),
    ).resolves.toEqual({ ok: true, page_id: "p" })
  })

  it("throws APIResponseError on a 200-wrapped error envelope", async () => {
    const { client } = stubRequestClient(() => ({
      object: "error",
      status: 429,
      code: "rate_limited",
      message: "You have been rate limited.",
      request_id: "req-1",
    }))
    const wrapped = wrapWithRunToolEnvelopeNormalizer(client)
    await expect(
      wrapped.request({ path: "tools/run", method: "post", body: {} }),
    ).rejects.toBeInstanceOf(APIResponseError)
    await expect(
      wrapped.request({ path: "tools/run", method: "post", body: {} }),
    ).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      message: "You have been rate limited.",
      request_id: "req-1",
    })
  })

  it("preserves non-`request` methods unchanged so namespace methods like `pages.create` still work", async () => {
    const create = vi.fn(async () => ({ id: "page-x" }))
    const client = {
      pages: { create },
      request: vi.fn(),
    } as unknown as Client
    const wrapped = wrapWithRunToolEnvelopeNormalizer(client)
    await expect(wrapped.pages.create({} as never)).resolves.toEqual({ id: "page-x" })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it("composes with createLimitedClient: a 200-wrapped 429 envelope pauses the shared bucket", async () => {
    // Composition order mirrors `services.ts` — the normalizer wraps
    // the bare client first, then the rate-limit proxy wraps the
    // normalized client. The bucket pause fires inside the proxy's
    // `catch` only if the underlying call throws; the normalizer is
    // what turns the 200 envelope into a thrown error.
    let calls = 0
    const responses: unknown[] = [
      {
        object: "error",
        status: 429,
        code: "rate_limited",
        message: "rate limited",
      },
      { ok: true, page_id: "second" },
    ]
    const client = {
      request: vi.fn(async () => {
        const r = responses[calls]
        calls += 1
        return r
      }),
    } as unknown as Client
    const normalized = wrapWithRunToolEnvelopeNormalizer(client)
    const onBackoff = vi.fn()
    const limited = createLimitedClient(
      normalized,
      { concurrency: 1, requestsPerSecond: 100, burstSize: 5 },
      { onBackoff },
    )

    await expect(
      limited.request({ path: "tools/run", method: "post", body: {} }),
    ).rejects.toBeInstanceOf(APIResponseError)
    // Bucket pause emitted via the rate-limit `catch` — proves the
    // normalizer's throw reaches the proxy layer where the
    // shared-bucket backoff fires. Without the normalizer, a 200-
    // wrapped 429 would skip this hook entirely.
    expect(onBackoff).toHaveBeenCalledTimes(1)
    const [, source] = onBackoff.mock.calls[0]!
    expect(source).toBe("default")
  })

  it("composes with createAuthRefreshingClient: a 200-wrapped 401 envelope triggers the one-shot refresh + retry", async () => {
    // `createAuthRefreshingClient` rebuilds the inner client through
    // its `createClient` dep on every refresh. Layering: the
    // normalizer wraps each rebuild so a 200-wrapped 401 envelope
    // surfaces as `APIResponseError(code: unauthorized)` and the
    // wrapper's 401 catch engages.
    const oldRequest = vi.fn(async () => ({
      object: "error",
      status: 401,
      code: "unauthorized",
      message: "unauthorized",
    }))
    const newRequest = vi.fn(async () => ({ ok: true, page_id: "post-refresh" }))
    const createClient = vi.fn((token: string) => {
      const request = token === "old-token" ? oldRequest : newRequest
      return wrapWithRunToolEnvelopeNormalizer({ request } as unknown as Client)
    })
    const refreshAuth = vi.fn(async () => ({
      kind: "refreshed" as const,
      auth: { token: "new-token" },
      source: "ntn-auth-json",
    }))

    const client = createAuthRefreshingClient({ token: "old-token" }, refreshAuth, {
      createClient,
      onRefresh: () => {},
    })

    await expect(
      client.request({ path: "tools/run", method: "post", body: {} }),
    ).resolves.toEqual({ ok: true, page_id: "post-refresh" })
    expect(refreshAuth).toHaveBeenCalledTimes(1)
    expect(oldRequest).toHaveBeenCalledTimes(1)
    expect(newRequest).toHaveBeenCalledTimes(1)
  })

  it("defaults status to 500 when the envelope omits it so downstream classifiers don't mis-route as 2xx", async () => {
    const { client } = stubRequestClient(() => ({
      object: "error",
      code: "internal_server_error",
    }))
    const wrapped = wrapWithRunToolEnvelopeNormalizer(client)
    await expect(
      wrapped.request({ path: "tools/run", method: "post", body: {} }),
    ).rejects.toMatchObject({
      status: 500,
      code: "internal_server_error",
    })
  })
})
