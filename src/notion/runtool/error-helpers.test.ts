import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  __resetWarnRunToolRestrictedResourceOnceForTest,
  isSqlValidationError,
  logRunToolFallback,
  SqlPartialResultError,
  warnRunToolRestrictedResourceOnce,
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

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true) as unknown as typeof stderrSpy
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  it("emits one line with source / status / code", () => {
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
    expect(line).toContain("reason=restricted_resource")
    expect(line).toContain("runtool-fallback=1")
    expect(line).toContain("used-rest=1")
  })

  it("renders unknown when status / code are absent", () => {
    logRunToolFallback("entity-find-by-alias", new TypeError("network"))
    const line = (stderrSpy.mock.calls[0]![0] as string).trim()
    expect(line).toContain("status=unknown")
    expect(line).toContain("code=unknown")
    expect(line).toContain("reason=transport_or_unknown")
  })

  it("does not throw for non-string error codes", () => {
    expect(() =>
      logRunToolFallback("entity-find-by-name", { code: 123, status: 503 })
    ).not.toThrow()
    const line = (stderrSpy.mock.calls[0]![0] as string).trim()
    expect(line).toContain("status=503")
    expect(line).toContain("code=123")
    expect(line).toContain("reason=server_error")
  })

  it("uses RunToolBlockEditError kind as the fallback reason", () => {
    const err = Object.assign(new Error("old_str did not match"), {
      name: "RunToolBlockEditError",
      kind: "no_match",
    })

    logRunToolFallback("memory-topic-key-revision-append", err)

    const line = (stderrSpy.mock.calls[0]![0] as string).trim()
    expect(line).toContain("source=memory-topic-key-revision-append")
    expect(line).toContain("reason=no_match")
    expect(line).toContain("runtool-fallback=1")
    expect(line).toContain("used-rest=1")
  })

  it("redacts and one-lines fallback errors", () => {
    logRunToolFallback(
      "entity-find-by-name\nretry",
      new Error(
        "lookup failed for 0123456789abcdef0123456789abcdef\n" +
          "secret_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"
      )
    )
    const line = stderrSpy.mock.calls[0]![0] as string
    expect(line).toContain("source=entity-find-by-name retry")
    expect(line).toContain("error=lookup failed for <page-id> <redacted-token>")
    expect(line).not.toContain("0123456789abcdef0123456789abcdef")
    expect(line).not.toContain("secret_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890")
    expect(line.endsWith("\n")).toBe(true)
    expect(line.slice(0, -1)).not.toContain("\n")
  })
})

describe("warnRunToolRestrictedResourceOnce", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    __resetWarnRunToolRestrictedResourceOnceForTest()
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true) as unknown as typeof stderrSpy
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  it("deduplicates repeated identical outcomes but preserves fallback/error distinction", () => {
    const err = new Error("denied")

    warnRunToolRestrictedResourceOnce("search", err, { usedRest: false })
    warnRunToolRestrictedResourceOnce("search", err, { usedRest: false })
    warnRunToolRestrictedResourceOnce("update_page", err, { usedRest: true })
    warnRunToolRestrictedResourceOnce("update_page", err, { usedRest: true })

    const lines = stderrSpy.mock.calls.map((call) => String(call[0]))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("search")
    expect(lines[0]).toContain("runtool-error=1")
    expect(lines[0]).toContain("used-rest=0")
    expect(lines[1]).toContain("update_page")
    expect(lines[1]).toContain("runtool-fallback=1")
    expect(lines[1]).toContain("used-rest=1")
  })

  it("surfaces the server error instead of blaming integration tokens", () => {
    const err = new Error("Endpoint unavailable")

    warnRunToolRestrictedResourceOnce("search", err, {
      usedRest: false,
    })

    const line = String(stderrSpy.mock.calls[0][0])

    expect(line).toContain("Endpoint unavailable")
    expect(line).toContain("403 RestrictedResource")
    expect(line).not.toContain("integration tokens (secret_...) are unsupported")
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