import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  __resetWarnRunToolIntegrationSecretForTest,
  isKnownIntegrationSecretAuthSource,
  isSqlValidationError,
  logRunToolFallback,
  SqlPartialResultError,
  warnRunToolIntegrationSecretOnce,
} from "./error-helpers.js"

describe("isSqlValidationError", () => {
  it("classifies 400 status as validation", () => {
    expect(isSqlValidationError({ status: 400 })).toBe(true)
  })

  it("classifies code=validation_error as validation", () => {
    expect(isSqlValidationError({ code: "validation_error" })).toBe(true)
  })

  it("does NOT classify 401 / 403 / 429 / 5xx as validation", () => {
    for (const status of [401, 403, 429, 500, 502, 503]) {
      expect(isSqlValidationError({ status })).toBe(false)
    }
  })

  it("does NOT classify network-shaped errors (no status, no code) as validation", () => {
    expect(isSqlValidationError(new TypeError("fetch failed"))).toBe(false)
    expect(isSqlValidationError({})).toBe(false)
  })

  it("handles non-object inputs", () => {
    expect(isSqlValidationError(null)).toBe(false)
    expect(isSqlValidationError(undefined)).toBe(false)
    expect(isSqlValidationError("not an error")).toBe(false)
  })
})

describe("logRunToolFallback", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let originalDebug: string | undefined

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true) as unknown as typeof stderrSpy
    originalDebug = process.env["LORE_DEBUG"]
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    if (originalDebug === undefined) delete process.env["LORE_DEBUG"]
    else process.env["LORE_DEBUG"] = originalDebug
  })

  it("is a no-op when LORE_DEBUG is unset", () => {
    delete process.env["LORE_DEBUG"]
    logRunToolFallback("entity-find-by-name", { status: 403 })
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it("emits one line with source / status / code under LORE_DEBUG=1", () => {
    process.env["LORE_DEBUG"] = "1"
    logRunToolFallback("near-duplicate-candidates", {
      status: 403,
      code: "restricted_resource",
      message: "blocked",
    })
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    const line = (stderrSpy.mock.calls[0]![0] as string).trim()
    expect(line).toContain("[lore] partial-failure:")
    expect(line).toContain("source=near-duplicate-candidates")
    expect(line).toContain("status=403")
    expect(line).toContain("code=restricted_resource")
    expect(line).toContain("runtool-fallback=1")
  })

  it("renders unknown when status / code are absent", () => {
    process.env["LORE_DEBUG"] = "1"
    logRunToolFallback("entity-find-by-alias", new TypeError("network"))
    const line = (stderrSpy.mock.calls[0]![0] as string).trim()
    expect(line).toContain("status=unknown")
    expect(line).toContain("code=unknown")
  })
})

describe("SqlPartialResultError", () => {
  it("preserves source name in the message and is named", () => {
    const err = new SqlPartialResultError("near-duplicate-candidates")
    expect(err.name).toBe("SqlPartialResultError")
    expect(err.message).toContain("near-duplicate-candidates")
    expect(err.message).toContain("has_more: true")
  })

  it("is NOT classified as validation, so the per-call fallback engages", () => {
    expect(isSqlValidationError(new SqlPartialResultError("test"))).toBe(false)
  })
})

describe("warnRunToolIntegrationSecretOnce + isKnownIntegrationSecretAuthSource", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true) as unknown as typeof stderrSpy
    __resetWarnRunToolIntegrationSecretForTest()
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    __resetWarnRunToolIntegrationSecretForTest()
  })

  it("does NOT classify ntn-resolved or ambiguous env sources as integration-secret", () => {
    // ntn-auth-json is the canonical user-actor path.
    expect(isKnownIntegrationSecretAuthSource("ntn-auth-json")).toBe(false)
    // env-notion-api-token is ambiguous (could be either an
    // integration secret or an ntn-resolved token); deliberately
    // out of the known-rejected set per the helper's docstring.
    expect(isKnownIntegrationSecretAuthSource("env-notion-api-token")).toBe(false)
  })

  it("is silent for non-integration-secret sources", () => {
    warnRunToolIntegrationSecretOnce("ntn-auth-json")
    warnRunToolIntegrationSecretOnce("env-notion-api-token")
    expect(stderrSpy).not.toHaveBeenCalled()
  })

})
