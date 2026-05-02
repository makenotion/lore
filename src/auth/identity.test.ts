import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Client } from "@notionhq/client"
import { resetIdentityCache, resolveAuthorIdentity } from "./identity.js"

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  resetIdentityCache()
  // Drop any test-leaked LORE_USER_NAME so the env-override branch is
  // exercised intentionally per-test, not by ambient shell state.
  delete process.env["LORE_USER_NAME"]
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  resetIdentityCache()
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
  // module's public surface is `resolveAuthorIdentity` +
  // `resetIdentityCache`). Tests exercise every walk branch through
  // the public resolver by mocking `client.users.me` per case.
  // `resetIdentityCache()` between cases prevents the per-process
  // memoization from masking later assertions.

  async function resolveWithMe(meResponse: unknown): Promise<string | null> {
    resetIdentityCache()
    const client = makeClient(meResponse)
    const result = await resolveAuthorIdentity(client)
    return result.author
  }

  it("walks bot.owner.user.name on the canonical ntn-issued shape", async () => {
    expect(
      await resolveWithMe({
        bot: { owner: { user: { name: "Hesham Salman", id: "abc" } } },
      }),
    ).toBe("Hesham Salman")
  })

  it("trims surrounding whitespace so an over-eager Notion display name doesn't render padded", async () => {
    expect(
      await resolveWithMe({
        bot: { owner: { user: { name: "  Hesham Salman  " } } },
      }),
    ).toBe("Hesham Salman")
  })

  it("returns null when the response carries only a workspace label", async () => {
    // workspace_name is per-team, not per-engineer — substituting it
    // would re-fragment attribution back to the pre-DEFERRED-ATTRIBUTION
    // baseline. The contract returns null so the caller omits the
    // Author write entirely.
    expect(
      await resolveWithMe({ bot: { workspace_name: "Notion Team" } }),
    ).toBeNull()
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
    expect(
      await resolveWithMe({ bot: { owner: { user: { name: "   " } } } }),
    ).toBeNull()
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
    expect((client.users as unknown as { me: ReturnType<typeof vi.fn> }).me).not.toHaveBeenCalled()
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
    expect((client.users as unknown as { me: ReturnType<typeof vi.fn> }).me).toHaveBeenCalledOnce()
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

  it("memoizes the result across calls so users.me is hit at most once per process", async () => {
    const client = makeClient({
      bot: { owner: { user: { name: "Hesham Salman" } } },
    })
    const first = await resolveAuthorIdentity(client)
    const second = await resolveAuthorIdentity(client)
    expect(first).toEqual({ author: "Hesham Salman" })
    expect(second).toEqual({ author: "Hesham Salman" })
    expect(
      (client.users as unknown as { me: ReturnType<typeof vi.fn> }).me,
    ).toHaveBeenCalledOnce()
  })

  it("memoizes the env-override result so resetIdentityCache is the single re-resolution path", async () => {
    process.env["LORE_USER_NAME"] = "hsalman"
    const client = makeClient({})
    const first = await resolveAuthorIdentity(client)
    process.env["LORE_USER_NAME"] = "different"
    const second = await resolveAuthorIdentity(client)
    expect(first.author).toBe("hsalman")
    expect(second.author).toBe("hsalman")
    resetIdentityCache()
    const third = await resolveAuthorIdentity(client)
    expect(third.author).toBe("different")
  })
})
