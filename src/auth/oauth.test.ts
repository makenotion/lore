import type { Client } from "@notionhq/client"
import { describe, expect, it } from "vitest"
import { extractPageTitle, verifyVaultAccess } from "./oauth.js"

/**
 * Build a minimal stand-in for `Client` whose `pages.retrieve` is
 * either a value-returning resolver or a thrower. The real SDK has a
 * sprawling surface; the preflight only touches `pages.retrieve`, so
 * the cast is the cleanest way to express that the test scope is
 * intentionally narrow.
 */
function mockClient(retrieve: () => unknown | Promise<unknown>): Client {
  return {
    pages: {
      retrieve: async () => retrieve(),
    },
  } as unknown as Client
}

describe("verifyVaultAccess", () => {
  it("returns { kind: 'ok', pageTitle } when retrieve succeeds and the page has a title", async () => {
    // The success branch carries the page title back so a caller like
    // `lore init` can echo "Created vault: <title>" — letting the
    // operator catch a wrong-workspace mistake before it propagates.
    const client = mockClient(() => ({
      object: "page",
      id: "valid-page-id",
      properties: { title: { title: [{ plain_text: "Vault Title" }] } },
    }))

    const result = await verifyVaultAccess(client, "valid-page-id")

    expect(result).toEqual({ kind: "ok", pageTitle: "Vault Title" })
  })

  it("returns { kind: 'ok', pageTitle: null } when retrieve succeeds but the page has no title shape", async () => {
    // A database-row page (rare for vaults, but possible if an operator
    // points `vault.pageId` at a row) doesn't carry a `title` property
    // at the well-known key. The helper still treats the read as a
    // success — we authorized fine, we just can't cheaply name the
    // page back to the operator.
    const client = mockClient(() => ({
      object: "page",
      id: "no-title-page",
      properties: {},
    }))

    const result = await verifyVaultAccess(client, "no-title-page")

    expect(result).toEqual({ kind: "ok", pageTitle: null })
  })

  it("returns { kind: 'not-found' } when retrieve throws { status: 404, code: 'object_not_found' }", async () => {
    // The most common operator failure under ntn-first auth: they ran
    // `ntn login` against the wrong workspace, OR their Notion
    // identity isn't a member of the workspace where the vault page
    // lives. The message must reference both possibilities so the
    // operator can self-diagnose without a runbook trip.
    const apiError = Object.assign(new Error("object_not_found"), {
      status: 404,
      code: "object_not_found",
    })
    const client = mockClient(() => {
      throw apiError
    })

    const result = await verifyVaultAccess(client, "missing-page-id")

    expect(result.kind).toBe("not-found")
    if (result.kind === "not-found") {
      expect(result.pageId).toBe("missing-page-id")
      // Pin the load-bearing parts of the message: the framing ("not
      // accessible") and the ntn-first failure modes (wrong workspace,
      // sharing). The exact prose can drift across follow-up PRs as
      // the operator UX evolves; these substrings are the contract.
      expect(result.message).toMatch(/not accessible/i)
      expect(result.message).toMatch(/wrong workspace/i)
      expect(result.message).toMatch(/shared with you/i)
    }
  })

  it("returns { kind: 'not-found' } when retrieve throws { code: 'object_not_found' } with no status", async () => {
    // Belt-and-suspenders: a future SDK revision (or a non-standard
    // error path inside the SDK) might surface only the `code`
    // discriminant without a numeric `status`. Both check arms must
    // route to `not-found` so the operator-friendly message survives
    // SDK shape evolution.
    const codeOnlyError = Object.assign(new Error("object_not_found"), {
      code: "object_not_found",
    })
    const client = mockClient(() => {
      throw codeOnlyError
    })

    const result = await verifyVaultAccess(client, "missing-page-id")

    expect(result.kind).toBe("not-found")
  })

  it("returns { kind: 'not-found' } when retrieve throws { status: 404 } with no code", async () => {
    // Mirror of the code-only test: an older SDK or a fetch-layer
    // shim that surfaces only `status` must still route to
    // `not-found`. Both arms of the `||` matter.
    const statusOnlyError = Object.assign(new Error("not found"), { status: 404 })
    const client = mockClient(() => {
      throw statusOnlyError
    })

    const result = await verifyVaultAccess(client, "missing-page-id")

    expect(result.kind).toBe("not-found")
  })

  it("returns { kind: 'unknown-error' } for non-404 throws so callers can decide retry/surface policy", async () => {
    // Transient 5xx, network errors, validation errors against a
    // malformed page id — none are a clean "you're in the wrong
    // workspace" signal. The caller surfaces the raw error or
    // retries; the helper deliberately does not.
    const serverError = Object.assign(new Error("internal server error"), {
      status: 500,
    })
    const client = mockClient(() => {
      throw serverError
    })

    const result = await verifyVaultAccess(client, "page-id")

    expect(result.kind).toBe("unknown-error")
    if (result.kind === "unknown-error") {
      expect(result.pageId).toBe("page-id")
      expect(result.error).toBe(serverError)
    }
  })

  it("does not retry on transient errors — surfaces immediately so the SDK's own retry layer owns that policy", async () => {
    // This pins the contract that *the helper itself* issues exactly
    // one `pages.retrieve` regardless of error class. It is NOT a test
    // of the SDK's retry behavior — by the time a 429 reaches the
    // helper's catch block, the Notion SDK has already exhausted its
    // own `Retry-After`-driven retry budget. The 429 is the cleanest
    // proxy for "transient error that bubbled out of the SDK"; the
    // assertion (calls === 1) would hold equally for a 500, a network
    // disconnect, or any other thrown shape. A second retry layer
    // here would double the wall-clock cost of a genuine outage and
    // complicate the no-retry contract documented in the issue's
    // "Risk / notes."
    let calls = 0
    const client = mockClient(() => {
      calls++
      throw Object.assign(new Error("rate limited"), { status: 429 })
    })

    await verifyVaultAccess(client, "page-id")

    expect(calls).toBe(1)
  })
})

describe("extractPageTitle", () => {
  it("returns the plain_text of the first title segment for a regular page", async () => {
    expect(
      extractPageTitle({
        properties: { title: { title: [{ plain_text: "Vault" }] } },
      })
    ).toBe("Vault")
  })

  it("returns null when handed undefined (cheap call-site safety)", () => {
    // Callers shouldn't have to pre-guard. The success branch of
    // `verifyVaultAccess` always has a page object, but defensive
    // null-handling here keeps the helper safe to use from other
    // contexts (e.g., a future caller that probes a search result
    // shape that may legitimately lack `properties`).
    expect(extractPageTitle(undefined)).toBeNull()
  })

  it("returns null when properties is empty (e.g., a page object that doesn't expose its title)", () => {
    expect(extractPageTitle({ properties: {} })).toBeNull()
  })

  it("returns null when title property is present but its title array is empty", () => {
    // Notion serialises a cleared title as `{ title: { title: [] } }`.
    // The extractor must surface this as null so a caller's
    // success-branch log doesn't read "Created vault: undefined".
    expect(extractPageTitle({ properties: { title: { title: [] } } })).toBeNull()
  })

  it("returns null when title segment is missing plain_text (defensive against partial SDK shapes)", () => {
    expect(extractPageTitle({ properties: { title: { title: [{}] } } })).toBeNull()
  })

  it("returns null when properties is not object-shaped", () => {
    // Edge case where a future SDK or a degraded response lands a
    // string at the `properties` key. Without the `typeof` guard, the
    // subsequent property reads would crash; with it, the helper
    // gracefully returns null and the success-branch caller falls
    // back to the page id.
    expect(extractPageTitle({ properties: "not-an-object" })).toBeNull()
  })

  it("returns null when title is not object-shaped", () => {
    expect(extractPageTitle({ properties: { title: "not-an-object" } })).toBeNull()
  })
})
