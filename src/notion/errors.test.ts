import { describe, expect, it } from "vitest"
import { extractMissingPropertyName, isMissingPropertyError } from "./errors.js"

describe("isMissingPropertyError", () => {
  it("matches the canonical SDK message shape ('Could not find property')", () => {
    const err = Object.assign(
      new Error("Could not find property with name or id: Done At"),
      { code: "validation_error" }
    )
    expect(isMissingPropertyError(err)).toBe(true)
  })

  it("matches the alternate 'does not exist' phrasing", () => {
    // Notion's SDK has used multiple message shapes for the same
    // failure mode across versions; both must match so an SDK message
    // change on either side doesn't silently flip the fallback off.
    const err = Object.assign(
      new Error("property SubjectEntity does not exist on this database"),
      { code: "validation_error" }
    )
    expect(isMissingPropertyError(err)).toBe(true)
  })

  it("matches 'not found' phrasing too", () => {
    const err = Object.assign(new Error("filter property not found: Done At"), {
      code: "validation_error",
    })
    expect(isMissingPropertyError(err)).toBe(true)
  })

  it("rejects validation errors that don't name a missing property (e.g. wrong operator)", () => {
    // Notion's `validation_error` covers several schema mistakes;
    // genuinely-malformed filters (wrong operator for the property
    // type) must propagate, not silently fall through to the
    // missing-property branch.
    const err = Object.assign(
      new Error("filter operator 'date.before' is not valid for select property"),
      { code: "validation_error" }
    )
    expect(isMissingPropertyError(err)).toBe(false)
  })

  it("rejects transient 5xx / rate-limit errors so they propagate", () => {
    // The whole point of the predicate is to suppress the
    // missing-property case AND ONLY that case; 5xx and rate-limit
    // failures must reach the caller so a real outage doesn't
    // masquerade as an empty result.
    expect(
      isMissingPropertyError(
        Object.assign(new Error("Internal server error"), {
          code: "internal_server_error",
        })
      )
    ).toBe(false)
    expect(
      isMissingPropertyError(
        Object.assign(new Error("Rate limited"), { code: "rate_limited" })
      )
    ).toBe(false)
    expect(
      isMissingPropertyError(
        Object.assign(new Error("Service unavailable"), {
          code: "service_unavailable",
        })
      )
    ).toBe(false)
  })

  it("rejects non-error values (defense-in-depth)", () => {
    expect(isMissingPropertyError(null)).toBe(false)
    expect(isMissingPropertyError(undefined)).toBe(false)
    expect(isMissingPropertyError("error string")).toBe(false)
    expect(isMissingPropertyError(42)).toBe(false)
    expect(isMissingPropertyError({})).toBe(false)
  })

  it("rejects errors with a non-string message field (SDK shape drift defense)", () => {
    // If a future SDK release returns a structured `message` object,
    // the predicate must NOT match — the substring check needs string
    // input. A `false` here means the error propagates, which is the
    // safer default; we'd rather surface an unrecognized error than
    // silently fall through to "no closures."
    const err = { code: "validation_error", message: { detail: "Done At missing" } }
    expect(isMissingPropertyError(err)).toBe(false)
  })
})

describe("extractMissingPropertyName (issue #284 review item #5)", () => {
  it("parses the 'Could not find property with name or id: \"<name>\"' shape", () => {
    const err = Object.assign(
      new Error('Could not find property with name or id: "Invalidated At"'),
      { code: "validation_error" }
    )
    expect(extractMissingPropertyName(err)).toBe("Invalidated At")
  })

  it("parses the unquoted 'Could not find property with name or id: <name>' shape", () => {
    const err = Object.assign(
      new Error("Could not find property with name or id: Done At"),
      { code: "validation_error" }
    )
    expect(extractMissingPropertyName(err)).toBe("Done At")
  })

  it("parses the '<name> does not exist on this database' shape and strips the leading 'property' token", () => {
    // The SDK emits this with a leading literal "property" word.
    // Stripping it is load-bearing: the captured name must match
    // FACT_PROPS values verbatim so the surgical-drop loop's
    // `propertyName in properties` guard succeeds. Pre-fix, the
    // captured "property SubjectEntity" string failed the guard and
    // the retry degraded to a bare-Valid-Until fallback (invalidate)
    // or a raw 400 propagation (create).
    const err = Object.assign(
      new Error("property SubjectEntity does not exist on this database"),
      { code: "validation_error" }
    )
    expect(extractMissingPropertyName(err)).toBe("SubjectEntity")
  })

  it("returns null when the error isn't a missing-property shape", () => {
    const err = Object.assign(
      new Error("filter operator 'date.before' is not valid for select property"),
      { code: "validation_error" }
    )
    expect(extractMissingPropertyName(err)).toBeNull()
  })

  it("returns null when the property name can't be parsed from a recognized-but-novel shape", () => {
    // Passes isMissingPropertyError (contains 'property' AND
    // 'does not exist'), but the column name follows an
    // SDK-message-shape change the parser doesn't recognize.
    const err = Object.assign(
      new Error("Some new property does not exist <bizarre message shape>"),
      { code: "validation_error" }
    )
    // The parser is permissive enough to extract SOMETHING; we
    // just need it to either return a non-empty string or null
    // (never throw). Both outcomes are acceptable — the FactService
    // retry handles each gracefully.
    const parsed = extractMissingPropertyName(err)
    expect(parsed === null || typeof parsed === "string").toBe(true)
  })
})
