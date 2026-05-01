import type { Client } from "@notionhq/client"
import { describe, expect, it } from "vitest"
import {
  extractPageTitle,
  ntnEnvFromBaseUrl,
  resolveOperatorBaseUrl,
  verifyVaultAccess,
} from "./oauth.js"

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

  it("returns { kind: 'unauthorized' } on 401 so the caller can route to re-auth, not vault-share-permission", async () => {
    // 401 means the token itself is invalid/expired. The recovery is
    // running ntn login again, NOT fixing workspace membership /
    // page-share permissions. Distinct from `not-found` because the
    // operator's actions to recover differ.
    const authError = Object.assign(new Error("unauthorized"), { status: 401 })
    const client = mockClient(() => {
      throw authError
    })

    const result = await verifyVaultAccess(client, "page-id")

    expect(result.kind).toBe("unauthorized")
    if (result.kind === "unauthorized") {
      expect(result.pageId).toBe("page-id")
      expect(result.message).toContain("Notion rejected the bearer token")
    }
  })

  it("returns { kind: 'unauthorized' } on 403 (token lacks permission, distinct from token invalid)", async () => {
    // 403 = token valid but lacks permission for THIS resource. Same
    // bucket as 401 from the install's perspective: writing MCP config
    // would land an immediately-broken install, so the gate is
    // ready=false either way.
    const forbidden = Object.assign(new Error("forbidden"), { status: 403 })
    const client = mockClient(() => {
      throw forbidden
    })

    const result = await verifyVaultAccess(client, "page-id")

    expect(result.kind).toBe("unauthorized")
  })

  it("returns { kind: 'unauthorized' } when SDK code is 'unauthorized' / 'restricted_resource' (no status)", async () => {
    // Defense pattern: future SDK shape changes that drop the numeric
    // status but keep the textual code shouldn't silently demote a
    // 401/403 into the unknown-error bucket.
    const codeOnly = Object.assign(new Error("unauthorized"), { code: "unauthorized" })
    const client = mockClient(() => {
      throw codeOnly
    })

    const result = await verifyVaultAccess(client, "page-id")
    expect(result.kind).toBe("unauthorized")
  })

  it("returns { kind: 'rate-limited' } on 429 so the caller can distinguish throttling from generic transients", async () => {
    // 429 is plausibly transient under sustained traffic but is
    // auth-orthogonal — the install's gating policy may differ from
    // a 5xx, so the discriminated branch lets the caller decide.
    const throttled = Object.assign(new Error("rate limited"), { status: 429 })
    const client = mockClient(() => {
      throw throttled
    })

    const result = await verifyVaultAccess(client, "page-id")
    expect(result.kind).toBe("rate-limited")
    if (result.kind === "rate-limited") {
      expect(result.pageId).toBe("page-id")
    }
  })

  it("returns { kind: 'unknown-error' } for genuine transient classes (5xx, network) so callers can decide retry/surface policy", async () => {
    // Pure transient: 5xx server error or network failure. Distinct
    // from the auth/throttle buckets — the recovery is "wait and try
    // again", not "fix auth" or "back off harder."
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
    // of the SDK's retry behavior — by the time a 5xx reaches the
    // helper's catch block, the Notion SDK has already exhausted its
    // own `Retry-After`-driven retry budget. A second retry layer
    // here would double the wall-clock cost of a genuine outage and
    // complicate the no-retry contract documented in the issue's
    // "Risk / notes."
    let calls = 0
    const client = mockClient(() => {
      calls++
      throw Object.assign(new Error("internal server error"), { status: 500 })
    })

    await verifyVaultAccess(client, "page-id")

    expect(calls).toBe(1)
  })

  it("returns { kind: 'unauthorized' } on 401 — token rejected", async () => {
    // 401 with `code: 'unauthorized'` is the SDK's signal that the
    // bearer token is invalid / expired / revoked. Distinct from
    // `not-found` because the remediation differs: re-auth, not
    // re-share. Distinct from `unknown-error` because the cause is
    // diagnosed (not-transient).
    const apiError = Object.assign(new Error("unauthorized"), {
      status: 401,
      code: "unauthorized",
    })
    const client = mockClient(() => {
      throw apiError
    })

    const result = await verifyVaultAccess(client, "page-id")

    expect(result.kind).toBe("unauthorized")
    if (result.kind === "unauthorized") {
      expect(result.pageId).toBe("page-id")
      expect(result.message).toMatch(/lore auth --login/)
      expect(result.message).toMatch(/invalid|expired|revoked/i)
    }
  })

  it("returns { kind: 'unauthorized' } on 403 (`restricted_resource`)", async () => {
    // 403 maps to the same caller-action: re-auth via the wrapper.
    // ntn-issued tokens inherit the engineer's identity, so re-auth
    // picks up any access-policy update they need.
    const apiError = Object.assign(new Error("restricted resource"), {
      status: 403,
      code: "restricted_resource",
    })
    const client = mockClient(() => {
      throw apiError
    })

    const result = await verifyVaultAccess(client, "page-id")

    expect(result.kind).toBe("unauthorized")
  })

  it("returns { kind: 'unauthorized' } on a code-only `unauthorized` (no numeric status)", async () => {
    // Same belt-and-suspenders shape as the not-found code-only test
    // — pin both check arms so a future SDK revision that drops
    // `status` doesn't silently demote 401 to `unknown-error`.
    const codeOnly = Object.assign(new Error("unauthorized"), {
      code: "unauthorized",
    })
    const client = mockClient(() => {
      throw codeOnly
    })

    const result = await verifyVaultAccess(client, "page-id")

    expect(result.kind).toBe("unauthorized")
  })

  it("returns { kind: 'rate-limited' } on 429 — wait/retry, not investigate", async () => {
    const apiError = Object.assign(new Error("rate limited"), {
      status: 429,
      code: "rate_limited",
    })
    const client = mockClient(() => {
      throw apiError
    })

    const result = await verifyVaultAccess(client, "page-id")

    expect(result.kind).toBe("rate-limited")
    if (result.kind === "rate-limited") {
      expect(result.pageId).toBe("page-id")
      expect(result.message).toMatch(/throttled|wait/i)
      // Specifically NOT a re-auth recommendation — that would
      // mislead operators away from the wait/retry remediation.
      expect(result.message).not.toMatch(/lore auth --login/)
    }
  })

  it("returns { kind: 'rate-limited' } on a code-only `rate_limited`", async () => {
    const codeOnly = Object.assign(new Error("rate limited"), {
      code: "rate_limited",
    })
    const client = mockClient(() => {
      throw codeOnly
    })

    const result = await verifyVaultAccess(client, "page-id")

    expect(result.kind).toBe("rate-limited")
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

describe("resolveOperatorBaseUrl", () => {
  // Lore honors ntn-native base-URL env vars (NOTION_BASE_URL,
  // NOTION_API_BASE_URL) as fallbacks for LORE_NOTION_BASE_URL so an
  // operator who sets the ntn-shaped variant (the `ntn --help`-
  // documented form) gets the same base URL Lore would resolve under
  // the Lore-namespaced name. Without the fallback chain, install-
  // time preflight would resolve dev but the spawned MCP child would
  // silently default to prod.

  it("returns LORE_NOTION_BASE_URL when set (highest priority)", () => {
    expect(
      resolveOperatorBaseUrl({
        LORE_NOTION_BASE_URL: "https://lore.dev.notion.com",
        NOTION_BASE_URL: "https://ntn.dev.notion.com",
        NOTION_API_BASE_URL: "https://api.dev.notion.com",
      }),
    ).toBe("https://lore.dev.notion.com")
  })

  it("falls back to NOTION_BASE_URL when LORE_NOTION_BASE_URL is unset", () => {
    expect(
      resolveOperatorBaseUrl({
        NOTION_BASE_URL: "https://api-dev.notion.com",
        NOTION_API_BASE_URL: "https://api-stg.notion.com",
      }),
    ).toBe("https://api-dev.notion.com")
  })

  it("falls back to NOTION_API_BASE_URL when neither Lore nor NOTION_BASE_URL is set", () => {
    expect(
      resolveOperatorBaseUrl({ NOTION_API_BASE_URL: "https://api-stg.notion.com" }),
    ).toBe("https://api-stg.notion.com")
  })

  it("returns undefined when no base-URL env var is set (caller applies its own default)", () => {
    expect(resolveOperatorBaseUrl({})).toBeUndefined()
  })

  it("treats empty-string env values as unset (skips to next priority level)", () => {
    expect(
      resolveOperatorBaseUrl({
        LORE_NOTION_BASE_URL: "",
        NOTION_BASE_URL: "https://api-dev.notion.com",
      }),
    ).toBe("https://api-dev.notion.com")
  })

  it("maps NOTION_ENV=dev to the canonical dev URL when no explicit URL var is set", () => {
    // The ntn-native shorthand: `NOTION_ENV=dev` with no URL var
    // should resolve to the canonical dev URL on the direct-token
    // path (NOTION_API_TOKEN). Without this fallback, an operator
    // who only sets NOTION_ENV would silently default to prod.
    expect(resolveOperatorBaseUrl({ NOTION_ENV: "dev" })).toBe(
      "https://api-dev.notion.com",
    )
  })

  it("maps NOTION_ENV=stg to the canonical staging URL", () => {
    expect(resolveOperatorBaseUrl({ NOTION_ENV: "stg" })).toBe(
      "https://api-stg.notion.com",
    )
  })

  it("maps NOTION_ENV=prod to the canonical prod URL", () => {
    // Explicit `NOTION_ENV=prod` resolves to the canonical prod URL
    // rather than falling through to undefined — the operator chose
    // prod, the resolver should reflect that.
    expect(resolveOperatorBaseUrl({ NOTION_ENV: "prod" })).toBe(
      "https://api.notion.so",
    )
  })

  it("returns undefined for unrecognized NOTION_ENV values (no silent fallback)", () => {
    // A typo or future-env value that the canonical mapping doesn't
    // know about should NOT silently route to prod. Returning
    // undefined lets the caller (`getBaseUrl`) apply its own default.
    expect(resolveOperatorBaseUrl({ NOTION_ENV: "qa" })).toBeUndefined()
  })

  it("explicit URL var still wins over NOTION_ENV mapping", () => {
    // An operator setting both `NOTION_ENV=dev` AND
    // `LORE_NOTION_BASE_URL=https://my-proxy.example` chose the
    // explicit URL — the proxy takes precedence over the env's
    // canonical mapping.
    expect(
      resolveOperatorBaseUrl({
        NOTION_ENV: "dev",
        LORE_NOTION_BASE_URL: "https://my-proxy.example",
      }),
    ).toBe("https://my-proxy.example")
  })
})

describe("ntnEnvFromBaseUrl (URL → ntn env selector)", () => {
  // Inverse of `ntnEnvBaseUrl`. Used by `lore install` to derive the
  // ntn-login env target from `.lore.yaml`'s `auth.baseUrl` so a dev
  // project's auto-login mints a dev token instead of ntn's prod
  // default.

  it("maps the canonical prod URL to env=prod", () => {
    expect(ntnEnvFromBaseUrl("https://api.notion.so")).toBe("prod")
  })

  it("maps the canonical dev URL to env=dev", () => {
    expect(ntnEnvFromBaseUrl("https://api-dev.notion.com")).toBe("dev")
  })

  it("maps the canonical staging URL to env=stg", () => {
    expect(ntnEnvFromBaseUrl("https://api-stg.notion.com")).toBe("stg")
  })

  it("returns undefined for non-canonical URLs (corporate proxies, future envs)", () => {
    // The install path treats `undefined` as "can't safely infer" —
    // it refuses auto-login rather than minting a prod token for a
    // proxy URL that's almost certainly NOT prod.
    expect(ntnEnvFromBaseUrl("https://my-corporate-proxy.example")).toBeUndefined()
    expect(ntnEnvFromBaseUrl("https://api.future-env.notion.com")).toBeUndefined()
  })

  it("returns undefined for undefined / empty string input", () => {
    expect(ntnEnvFromBaseUrl(undefined)).toBeUndefined()
    expect(ntnEnvFromBaseUrl("")).toBeUndefined()
  })

  it("is exact-match — does NOT match a URL with extra trailing path", () => {
    // Defensive: a `.lore.yaml` carrying
    // `auth.baseUrl: https://api-dev.notion.com/v1` would NOT round-
    // trip cleanly through ntn's resolution anyway (ntn appends its
    // own path). Refusing the inference is the right call.
    expect(ntnEnvFromBaseUrl("https://api-dev.notion.com/v1")).toBeUndefined()
  })
})
