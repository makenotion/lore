import { APIErrorCode, APIResponseError, LogLevel } from "@notionhq/client"
import type { Client } from "@notionhq/client"
import { describe, expect, it, vi } from "vitest"
import {
  createAuthRefreshingClient,
  resolveSdkDebugOptions,
  stderrSdkLogger,
} from "./client.js"

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

  it("falls back to [unserializable extraInfo] when JSON.stringify throws (e.g. circular references)", () => {
    // The "retrying request" path passes a flat
    // `{ method, path, attempt, delayMs }` and never trips this
    // branch today. The guard exists so a future SDK extra-info
    // shape carrying a circular reference (an error with a `cause`
    // chain pointing back at itself, a request object holding a
    // reference to its own response) cannot turn the diagnostic
    // logger into the source of a CLI crash.
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
      "[lore] notion-sdk warn: circular extra [unserializable extraInfo]\n",
    ])
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

    const client = createAuthRefreshingClient({ token: "old-token" }, refreshAuth, {
      createClient,
      onRefresh: (event) => refreshEvents.push(event),
    })

    await expect(client.pages.retrieve({ page_id: "page" })).resolves.toEqual({
      id: "ok",
    })
    expect(refreshAuth).toHaveBeenCalledWith({ token: "old-token" })
    expect(createClient).toHaveBeenCalledTimes(2)
    expect(oldRetrieve).toHaveBeenCalledTimes(1)
    expect(newRetrieve).toHaveBeenCalledTimes(1)
    expect(refreshEvents).toEqual([{ kind: "refreshed", source: "ntn-auth-json" }])
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
})
