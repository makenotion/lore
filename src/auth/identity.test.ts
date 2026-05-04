import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Client } from "@notionhq/client"
import {
  createAuthorIdentityResolver,
  resetIdentityCache,
  resolveAuthorIdentity,
} from "./identity.js"

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  // Drop any test-leaked LORE_USER_NAME so the env-override branch is
  // exercised intentionally per-test, not by ambient shell state.
  delete process.env["LORE_USER_NAME"]
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

function makeClient(meResponse: unknown, throws = false): Client {
  const me = vi.fn(async () => {
    if (throws) throw new Error("network failure")
    return meResponse
  })
  return { users: { me } } as unknown as Client
}

describe("resolveAuthorIdentity — users.me shape walking", () => {
  // The internal `extractOwnerUserName` helper isn't exported (the
  // module keeps that JSON walker private). Tests exercise every walk
  // branch through the public resolver by mocking `client.users.me`
  // per case.

  async function resolveWithMe(meResponse: unknown): Promise<string | null> {
    const client = makeClient(meResponse)
    const result = await resolveAuthorIdentity(client)
    return result.author
  }

  it("walks bot.owner.user.name on the canonical ntn-issued shape", async () => {
    expect(
      await resolveWithMe({
        bot: { owner: { user: { name: "Hesham Salman", id: "abc" } } },
      })
    ).toBe("Hesham Salman")
  })

  it("trims surrounding whitespace so an over-eager Notion display name doesn't render padded", async () => {
    expect(
      await resolveWithMe({
        bot: { owner: { user: { name: "  Hesham Salman  " } } },
      })
    ).toBe("Hesham Salman")
  })

  it("returns null when the response carries only a workspace label", async () => {
    // workspace_name is per-team, not per-engineer — substituting it
    // would re-fragment attribution back to the pre-DEFERRED-ATTRIBUTION
    // baseline. The contract returns null so the caller omits the
    // Author write entirely.
    expect(await resolveWithMe({ bot: { workspace_name: "Notion Team" } })).toBeNull()
  })

  it("returns null on each missing-field shape so transient response drift never throws", async () => {
    // Each shape exercises one nesting level of the JSON walk. A
    // single rolled-up `it` would be terser, but separating means a
    // future test failure points at the exact branch; preserving the
    // pre-inline test's coverage (10 shapes) without losing the
    // individual-branch diagnostic.
    expect(await resolveWithMe(null)).toBeNull()
    expect(await resolveWithMe(undefined)).toBeNull()
    expect(await resolveWithMe("string-response")).toBeNull()
    expect(await resolveWithMe({})).toBeNull()
    expect(await resolveWithMe({ bot: null })).toBeNull()
    expect(await resolveWithMe({ bot: { owner: null } })).toBeNull()
    expect(await resolveWithMe({ bot: { owner: { user: null } } })).toBeNull()
    expect(await resolveWithMe({ bot: { owner: { user: { name: "" } } } })).toBeNull()
    expect(await resolveWithMe({ bot: { owner: { user: { name: "   " } } } })).toBeNull()
    expect(await resolveWithMe({ bot: { owner: { user: { name: 42 } } } })).toBeNull()
  })
})

describe("resolveAuthorIdentity", () => {
  it("prefers LORE_USER_NAME env override and skips the users.me call", async () => {
    process.env["LORE_USER_NAME"] = "hsalman"
    const client = makeClient({ bot: { owner: { user: { name: "Other" } } } })
    const result = await resolveAuthorIdentity(client)
    expect(result.author).toBe("hsalman")
    // Critical: env override means no API call is made — the
    // synchronous escape hatch must not pay a Notion round-trip.
    expect(
      (client.users as unknown as { me: ReturnType<typeof vi.fn> }).me
    ).not.toHaveBeenCalled()
  })

  it("trims whitespace on the LORE_USER_NAME path", async () => {
    process.env["LORE_USER_NAME"] = "  hsalman  "
    const client = makeClient({})
    const result = await resolveAuthorIdentity(client)
    expect(result.author).toBe("hsalman")
  })

  it("treats whitespace-only LORE_USER_NAME as unset and falls through to users.me", async () => {
    process.env["LORE_USER_NAME"] = "   "
    const client = makeClient({
      bot: { owner: { user: { name: "Hesham Salman" } } },
    })
    const result = await resolveAuthorIdentity(client)
    expect(result.author).toBe("Hesham Salman")
    expect(
      (client.users as unknown as { me: ReturnType<typeof vi.fn> }).me
    ).toHaveBeenCalledOnce()
  })

  it("falls back to users.me when no env override is set", async () => {
    const client = makeClient({
      bot: { owner: { user: { name: "Hesham Salman", id: "abc" } } },
    })
    const result = await resolveAuthorIdentity(client)
    expect(result.author).toBe("Hesham Salman")
  })

  it("returns null author when users.me carries only a workspace label", async () => {
    // Workspace-owned bots, legacy integrations, or any token whose
    // users.me doesn't surface bot.owner.user — the column stays empty
    // rather than collapsing to a per-team label.
    const client = makeClient({ bot: { workspace_name: "Notion Team" } })
    const result = await resolveAuthorIdentity(client)
    expect(result.author).toBeNull()
  })

  it("returns null author on users.me throw and never propagates the error", async () => {
    const client = makeClient(undefined, true)
    const result = await resolveAuthorIdentity(client)
    expect(result.author).toBeNull()
  })

  it("resolver memoizes users.me by auth snapshot", async () => {
    const client = makeClient({
      bot: { owner: { user: { name: "Hesham Salman" } } },
    })
    const resolver = createAuthorIdentityResolver(client, () => ({ token: "token-a" }))
    const first = await resolver.resolveAuthor()
    const second = await resolver.resolveAuthor()
    expect(first).toBe("Hesham Salman")
    expect(second).toBe("Hesham Salman")
    expect(
      (client.users as unknown as { me: ReturnType<typeof vi.fn> }).me
    ).toHaveBeenCalledOnce()
  })

  it("does not cache LORE_USER_NAME so the synchronous override always wins", async () => {
    process.env["LORE_USER_NAME"] = "hsalman"
    const client = makeClient({})
    const resolver = createAuthorIdentityResolver(client, () => ({ token: "token-a" }))
    const first = await resolver.resolveAuthor()
    process.env["LORE_USER_NAME"] = "different"
    const second = await resolver.resolveAuthor()
    expect(first).toBe("hsalman")
    expect(second).toBe("different")
    expect(
      (client.users as unknown as { me: ReturnType<typeof vi.fn> }).me
    ).not.toHaveBeenCalled()
  })

  it("does not reuse a cached author across token or base URL changes", async () => {
    let snapshot = { token: "token-a", baseUrl: "https://api-a.notion.test" }
    const me = vi
      .fn()
      .mockResolvedValueOnce({
        bot: { owner: { user: { name: "Author A" } } },
      })
      .mockResolvedValueOnce({
        bot: { owner: { user: { name: "Author B" } } },
      })
      .mockResolvedValueOnce({
        bot: { owner: { user: { name: "Author C" } } },
      })
    const client = { users: { me } } as unknown as Client
    const resolver = createAuthorIdentityResolver(client, () => snapshot)

    await expect(resolver.resolveAuthor()).resolves.toBe("Author A")
    await expect(resolver.resolveAuthor()).resolves.toBe("Author A")

    snapshot = { token: "token-b", baseUrl: "https://api-a.notion.test" }
    await expect(resolver.resolveAuthor()).resolves.toBe("Author B")

    snapshot = { token: "token-b", baseUrl: "https://api-b.notion.test" }
    await expect(resolver.resolveAuthor()).resolves.toBe("Author C")

    expect(me).toHaveBeenCalledTimes(3)
  })

  it("does not cache an in-flight old-token result under a refreshed auth snapshot", async () => {
    let snapshot = { token: "token-a", baseUrl: "https://api-a.notion.test" }
    let resolveMe!: (value: unknown) => void
    const me = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveMe = resolve
        })
    )
    const client = { users: { me } } as unknown as Client
    const resolver = createAuthorIdentityResolver(client, () => snapshot)

    const first = resolver.resolveAuthor()
    await Promise.resolve()
    expect(me).toHaveBeenCalledTimes(1)

    snapshot = { token: "token-b", baseUrl: "https://api-a.notion.test" }
    resolveMe({ bot: { owner: { user: { name: "Author A" } } } })
    await expect(first).resolves.toBe("Author A")

    me.mockResolvedValueOnce({ bot: { owner: { user: { name: "Author B" } } } })
    await expect(resolver.resolveAuthor()).resolves.toBe("Author B")
    expect(me).toHaveBeenCalledTimes(2)
  })

  it("does not let an old in-flight lookup clobber a newer auth snapshot cache", async () => {
    let snapshot = { token: "token-a", baseUrl: "https://api-a.notion.test" }
    const pending: Array<(value: unknown) => void> = []
    const me = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          pending.push(resolve)
        })
    )
    const client = { users: { me } } as unknown as Client
    const resolver = createAuthorIdentityResolver(client, () => snapshot)

    const first = resolver.resolveAuthor()
    await Promise.resolve()

    snapshot = { token: "token-b", baseUrl: "https://api-a.notion.test" }
    const second = resolver.resolveAuthor()
    await Promise.resolve()
    expect(me).toHaveBeenCalledTimes(2)

    pending[1]!({ bot: { owner: { user: { name: "Author B" } } } })
    await expect(second).resolves.toBe("Author B")
    pending[0]!({ bot: { owner: { user: { name: "Author A" } } } })
    await expect(first).resolves.toBe("Author A")

    await expect(resolver.resolveAuthor()).resolves.toBe("Author B")
    expect(me).toHaveBeenCalledTimes(2)
  })

  it("retries after a users.me failure instead of caching null for the auth snapshot", async () => {
    const me = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValueOnce({ bot: { owner: { user: { name: "Author A" } } } })
    const client = { users: { me } } as unknown as Client
    const resolver = createAuthorIdentityResolver(client, () => ({ token: "token-a" }))

    await expect(resolver.resolveAuthor()).resolves.toBeNull()
    await expect(resolver.resolveAuthor()).resolves.toBe("Author A")
    expect(me).toHaveBeenCalledTimes(2)
  })

  it("dedupes concurrent first resolves under the same auth snapshot", async () => {
    let resolveMe!: (value: unknown) => void
    const me = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveMe = resolve
        })
    )
    const client = { users: { me } } as unknown as Client
    const resolver = createAuthorIdentityResolver(client, () => ({ token: "token-a" }))

    const first = resolver.resolveAuthor()
    const second = resolver.resolveAuthor()
    await Promise.resolve()
    expect(me).toHaveBeenCalledOnce()

    resolveMe({ bot: { owner: { user: { name: "Author A" } } } })
    await expect(Promise.all([first, second])).resolves.toEqual(["Author A", "Author A"])
  })

  it("dedupes concurrent users.me failures but retries after they settle", async () => {
    const me = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValueOnce({ bot: { owner: { user: { name: "Author A" } } } })
    const client = { users: { me } } as unknown as Client
    const resolver = createAuthorIdentityResolver(client, () => ({ token: "token-a" }))

    const first = resolver.resolveAuthor()
    const second = resolver.resolveAuthor()
    await expect(Promise.all([first, second])).resolves.toEqual([null, null])
    expect(me).toHaveBeenCalledOnce()

    await expect(resolver.resolveAuthor()).resolves.toBe("Author A")
    expect(me).toHaveBeenCalledTimes(2)
  })

  it("dedupes an in-flight old snapshot while a newer snapshot is resolving", async () => {
    let snapshot = { token: "token-a", baseUrl: "https://api-a.notion.test" }
    const pending: Array<(value: unknown) => void> = []
    const me = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          pending.push(resolve)
        })
    )
    const client = { users: { me } } as unknown as Client
    const resolver = createAuthorIdentityResolver(client, () => snapshot)

    const first = resolver.resolveAuthor()
    await Promise.resolve()

    snapshot = { token: "token-b", baseUrl: "https://api-a.notion.test" }
    const second = resolver.resolveAuthor()
    await Promise.resolve()

    snapshot = { token: "token-a", baseUrl: "https://api-a.notion.test" }
    const third = resolver.resolveAuthor()
    await Promise.resolve()
    expect(me).toHaveBeenCalledTimes(2)

    pending[0]!({ bot: { owner: { user: { name: "Author A" } } } })
    pending[1]!({ bot: { owner: { user: { name: "Author B" } } } })
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      "Author A",
      "Author B",
      "Author A",
    ])

    await expect(resolver.resolveAuthor()).resolves.toBe("Author A")
    expect(me).toHaveBeenCalledTimes(2)
  })

  it("keeps only the latest auth snapshot cached", async () => {
    let snapshot = { token: "token-a", baseUrl: "https://api-a.notion.test" }
    const me = vi
      .fn()
      .mockResolvedValueOnce({ bot: { owner: { user: { name: "Author A1" } } } })
      .mockResolvedValueOnce({ bot: { owner: { user: { name: "Author B" } } } })
      .mockResolvedValueOnce({ bot: { owner: { user: { name: "Author A2" } } } })
    const client = { users: { me } } as unknown as Client
    const resolver = createAuthorIdentityResolver(client, () => snapshot)

    await expect(resolver.resolveAuthor()).resolves.toBe("Author A1")
    snapshot = { token: "token-b", baseUrl: "https://api-a.notion.test" }
    await expect(resolver.resolveAuthor()).resolves.toBe("Author B")
    snapshot = { token: "token-a", baseUrl: "https://api-a.notion.test" }
    await expect(resolver.resolveAuthor()).resolves.toBe("Author A2")
    expect(me).toHaveBeenCalledTimes(3)
  })

  it("emits LORE_DEBUG diagnostics for env, users.me, and failure paths", async () => {
    const priorDebug = process.env["LORE_DEBUG"]
    process.env["LORE_DEBUG"] = "1"
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

    try {
      process.env["LORE_USER_NAME"] = "Env Author"
      const envResolver = createAuthorIdentityResolver(makeClient({}), () => ({
        token: "env-token",
      }))
      await expect(envResolver.resolveAuthor()).resolves.toBe("Env Author")
      await expect(envResolver.resolveAuthor()).resolves.toBe("Env Author")

      delete process.env["LORE_USER_NAME"]
      const usersMeResolver = createAuthorIdentityResolver(
        makeClient({ bot: { owner: { user: { name: "API Author" } } } }),
        () => ({ token: "api-token" })
      )
      await expect(usersMeResolver.resolveAuthor()).resolves.toBe("API Author")

      const failingResolver = createAuthorIdentityResolver(
        makeClient(undefined, true),
        () => ({ token: "failure-token" })
      )
      await expect(failingResolver.resolveAuthor()).resolves.toBeNull()
    } finally {
      stderrSpy.mockRestore()
      if (priorDebug === undefined) {
        delete process.env["LORE_DEBUG"]
      } else {
        process.env["LORE_DEBUG"] = priorDebug
      }
    }

    expect(stderrChunks).toEqual([
      "[lore] identity: resolved author (source=env)\n",
      "[lore] identity: resolved author (source=users.me, author=present)\n",
      "[lore] identity: users.me failed: network failure\n",
    ])
  })

  it("redacts page-id-shaped substrings in users.me failure messages (issue #488)", async () => {
    // `users.me` is exactly the failure path the Notion SDK is most
    // likely to interpolate request-scoped detail into. Pin that the
    // identity debug logger routes the message through the shared
    // redactor so a vault page id leaked into `Error.message` does
    // not flow into the operator's centralized log surface.
    const priorDebug = process.env["LORE_DEBUG"]
    process.env["LORE_DEBUG"] = "1"
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

    try {
      const failingClient = {
        users: {
          me: vi.fn(async () => {
            throw new Error(
              "InvalidPathParameterError: page abcdef0123456789abcdef0123456789 not found",
            )
          }),
        },
      } as unknown as Client
      const resolver = createAuthorIdentityResolver(failingClient, () => ({
        token: "failure-token",
      }))
      await expect(resolver.resolveAuthor()).resolves.toBeNull()
    } finally {
      stderrSpy.mockRestore()
      if (priorDebug === undefined) {
        delete process.env["LORE_DEBUG"]
      } else {
        process.env["LORE_DEBUG"] = priorDebug
      }
    }

    expect(stderrChunks).toHaveLength(1)
    expect(stderrChunks[0]).toContain("<page-id>")
    expect(stderrChunks[0]).not.toContain("abcdef0123456789abcdef0123456789")
  })

  it("keeps resetIdentityCache callable without arguments and clears every live resolver", async () => {
    const firstMe = vi
      .fn()
      .mockResolvedValueOnce({ bot: { owner: { user: { name: "Author A1" } } } })
      .mockResolvedValueOnce({ bot: { owner: { user: { name: "Author A2" } } } })
    const secondMe = vi
      .fn()
      .mockResolvedValueOnce({ bot: { owner: { user: { name: "Author B1" } } } })
      .mockResolvedValueOnce({ bot: { owner: { user: { name: "Author B2" } } } })
    const first = createAuthorIdentityResolver(
      { users: { me: firstMe } } as unknown as Client,
      () => ({ token: "token-a" })
    )
    const second = createAuthorIdentityResolver(
      { users: { me: secondMe } } as unknown as Client,
      () => ({ token: "token-b" })
    )

    await expect(first.resolveAuthor()).resolves.toBe("Author A1")
    await expect(second.resolveAuthor()).resolves.toBe("Author B1")
    expect(firstMe).toHaveBeenCalledOnce()
    expect(secondMe).toHaveBeenCalledOnce()

    resetIdentityCache()

    await expect(first.resolveAuthor()).resolves.toBe("Author A2")
    await expect(second.resolveAuthor()).resolves.toBe("Author B2")
    expect(firstMe).toHaveBeenCalledTimes(2)
    expect(secondMe).toHaveBeenCalledTimes(2)
  })

  it("can reset one resolver without clearing another resolver's cache", async () => {
    const firstMe = vi
      .fn()
      .mockResolvedValueOnce({ bot: { owner: { user: { name: "Author A1" } } } })
      .mockResolvedValueOnce({ bot: { owner: { user: { name: "Author A2" } } } })
    const secondMe = vi.fn(async () => ({
      bot: { owner: { user: { name: "Author B" } } },
    }))
    const first = createAuthorIdentityResolver(
      { users: { me: firstMe } } as unknown as Client,
      () => ({ token: "token-a" })
    )
    const second = createAuthorIdentityResolver(
      { users: { me: secondMe } } as unknown as Client,
      () => ({ token: "token-b" })
    )

    await expect(first.resolveAuthor()).resolves.toBe("Author A1")
    await expect(second.resolveAuthor()).resolves.toBe("Author B")

    resetIdentityCache(first)

    await expect(first.resolveAuthor()).resolves.toBe("Author A2")
    await expect(second.resolveAuthor()).resolves.toBe("Author B")
    expect(firstMe).toHaveBeenCalledTimes(2)
    expect(secondMe).toHaveBeenCalledOnce()
  })
})
