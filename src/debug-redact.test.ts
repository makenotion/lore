import { describe, expect, it } from "vitest"

import {
  MAX_DEBUG_MESSAGE_LENGTH,
  redactDebugError,
  redactDebugExtraInfo,
  redactDebugMessage,
} from "./debug-redact.js"

describe("redactDebugMessage (issue #488)", () => {
  it("passes a clean diagnostic string through unchanged", () => {
    // The redactor preserves the error category and the first sentence
    // since those carry the diagnostic value an operator needs to
    // distinguish a transient 429 from a pathological loop.
    const message = "InvalidPathParameterError: ID 'foo' is not a valid page id"
    expect(redactDebugMessage(message)).toBe(message)
  })

  it("returns the empty string unchanged", () => {
    expect(redactDebugMessage("")).toBe("")
  })

  it("redacts a 32-char hex page id wherever it appears in the message", () => {
    // Notion page-id shape per the issue's mitigation list. Same
    // substring redacted regardless of position so a future SDK error
    // that interpolates the id mid-sentence is covered.
    const id = "abcdef0123456789abcdef0123456789"
    const before = `Failed to load page ${id} (status 404)`
    expect(redactDebugMessage(before)).toBe("Failed to load page <page-id> (status 404)")
  })

  it("redacts the dashed UUID page-id shape too", () => {
    // Notion v5 surfaces page ids in either bare-hex or
    // `8-4-4-4-12` UUID form depending on which SDK call returned
    // them. Redact both shapes so the fix isn't one-sided.
    const dashed = "e8794b62-fb86-4148-a52f-66c8b40b00bc"
    expect(redactDebugMessage(`page=${dashed} not found`)).toBe(
      "page=<page-id> not found",
    )
  })

  it("redacts multiple page ids in one message", () => {
    const a = "abcdef0123456789abcdef0123456789"
    const b = "fedcba9876543210fedcba9876543210"
    expect(redactDebugMessage(`Edge from ${a} to ${b} broken`)).toBe(
      "Edge from <page-id> to <page-id> broken",
    )
  })

  it("does NOT redact short hex substrings — only the full 32-char shape", () => {
    // A 16-char hex span is not a Notion page id; redacting it would
    // drop diagnostic value (commit hashes, request ids) without
    // closing a leak vector.
    expect(redactDebugMessage("error code abc12345 at offset 0xdeadbeef")).toBe(
      "error code abc12345 at offset 0xdeadbeef",
    )
  })

  it("strips a forward-compatible body= attachment", () => {
    // The current Notion SDK does not interpolate `body=` into
    // `Error.message`. The strip is forward-compatible — if a future
    // SDK regression dumps the response body into the message, the
    // redactor neutralizes it before stderr.
    expect(redactDebugMessage('APIError: body={"page":"secret"} status=500')).toBe(
      "APIError: body=<redacted> status=500",
    )
  })

  it("strips headers= and payload= attachments under the same defense", () => {
    expect(redactDebugMessage("RequestFailed headers={Authorization:Bearer} retries=3")).toBe(
      "RequestFailed headers=<redacted> retries=3",
    )
    expect(redactDebugMessage("payload=binary-blob status=413")).toBe(
      "payload=<redacted> status=413",
    )
  })

  it("redacts a JSON body= value containing whitespace after commas (review-2 regression #1)", () => {
    // The pre-#488-review-2 token-only stop-char regex was
    // `[^\\s,;]+` — it stopped at the first internal comma and left the
    // sensitive remainder visible. Pin the conservative regex against
    // the canonical example from the review.
    const out = redactDebugMessage(
      'APIError: body={"object":"error", "message":"private workspace body"} status=500',
    )
    expect(out).toBe("APIError: body=<redacted> status=500")
  })

  it("redacts a headers= value containing a bearer token after a space (review-2 regression #2)", () => {
    // `headers={Authorization: Bearer secret_123, Notion-Version: ...}`
    // would otherwise become `headers=<redacted> Bearer secret_123,
    // Notion-Version: ...}` under the token-only stripper. The brace
    // branch swallows the whole structured value.
    const out = redactDebugMessage(
      "RequestFailed headers={Authorization: Bearer secret_aaaaaaaaaaaaaaaaaaaaaaaa, Notion-Version: 2022-06-28} retries=3",
    )
    expect(out).toBe("RequestFailed headers=<redacted> retries=3")
  })

  it("redacts a quoted body= value with embedded escaped quotes", () => {
    // The quoted branch handles C-style escapes so a `\\"` sequence
    // does not prematurely terminate the match.
    const out = redactDebugMessage(
      'APIError: body="{\\"object\\":\\"error\\"}" status=500',
    )
    expect(out).toBe("APIError: body=<redacted> status=500")
  })

  it("redacts a single-quoted body= value", () => {
    const out = redactDebugMessage("APIError: body='inner value' status=500")
    expect(out).toBe("APIError: body=<redacted> status=500")
  })

  it("redacts a one-level-nested JSON body= value", () => {
    // The brace branch handles one level of nested objects so
    // `body={"nested":{"a":"b"}, "ok":true}` redacts cleanly.
    const out = redactDebugMessage(
      'APIError: body={"nested":{"a":"b"}, "ok":true} status=500',
    )
    expect(out).toBe("APIError: body=<redacted> status=500")
  })

  it("redacts an arbitrarily nested JSON body= value (review-3 blocker)", () => {
    // The pre-#488-review-3 implementation used a regex with a
    // depth-1 brace branch; a two-level payload like
    // `body={"outer":{"inner":{"a":"secret"}}, ...}` fell through to
    // the bare-token fallback and emitted `body=<redacted>}}, "message":"..."`,
    // leaking the descriptive tail. The scanner's depth counter
    // resolves arbitrary nesting.
    const out = redactDebugMessage(
      'APIError: body={"outer":{"inner":{"a":"secret"}}, "message":"private workspace body"} status=500',
    )
    expect(out).toBe("APIError: body=<redacted> status=500")
    expect(out).not.toContain("private workspace body")
    expect(out).not.toContain("inner")
    expect(out).not.toContain("secret")
  })

  it("redacts a deeply-nested array+object mix without leaking the tail", () => {
    const out = redactDebugMessage(
      'APIError: body=[{"a":[{"b":{"c":"x"}}]}, {"d":[1,2]}] status=500',
    )
    expect(out).toBe("APIError: body=<redacted> status=500")
  })

  it("over-redacts on unbalanced/malformed body= value (deliberate conservative posture)", () => {
    // An unbalanced opening brace that never closes is structurally
    // ambiguous: stopping early would leak whatever follows the
    // partial payload; consuming to end-of-string is the safe
    // choice and matches the helper docstring's "deliberate
    // over-redaction" contract.
    const out = redactDebugMessage(
      'APIError: body={"outer":{"inner": status=500',
    )
    // Whole tail consumed; the `status=500` is collateral damage of
    // the malformed input. Pin so a future "fix" that papers over
    // the boundary by emitting partial output is loudly visible.
    expect(out).toBe("APIError: body=<redacted>")
  })

  it("over-redacts on unterminated quoted body= value", () => {
    const out = redactDebugMessage('APIError: body="unterminated value status=500')
    expect(out).toBe("APIError: body=<redacted>")
  })

  it("redacts a stringified Error chain across whitespace into the next field (NS1 fix)", () => {
    // Stringified Error.cause shapes like `cause=Error: page lookup
    // failed status=500` would otherwise bare-token-stop at the
    // first space, leaking the descriptive phrase. The bare-token
    // consumer's whitespace-with-field-lookahead heuristic redacts
    // the whole `cause=` value and stops at the next field marker.
    const out = redactDebugMessage(
      "APIError: cause=Error: page lookup failed status=500",
    )
    expect(out).toBe("APIError: cause=<redacted> status=500")
    expect(out).not.toContain("page lookup failed")
  })

  it("preserves a bare-token cause= value that runs to end-of-string", () => {
    // The whitespace-lookahead heuristic only stops at next-field
    // shapes; a description with no follow-up field is correctly
    // consumed to the end.
    const out = redactDebugMessage("APIError: cause=Error: page lookup failed")
    expect(out).toBe("APIError: cause=<redacted>")
  })

  it("redacts a bare-token cause= value through a non-SDK key= phrase (NewS1 boundary)", () => {
    // The bare-token consumer's whitespace lookahead stops at ANY
    // identifier-shaped `name=` token, not just SDK-known field
    // names. So a descriptive phrase containing a non-SDK `key=val`
    // shape (e.g. operator log noise) terminates the redaction at
    // the first such token. This is correct posture — the
    // operator-readable trailing remainder is preserved AND the
    // outer scanner re-enters at the new field. Pin the boundary so
    // a future "tighten the lookahead to only SDK names" refactor
    // can't silently re-introduce the NS1 leak class on shapes the
    // test corpus didn't cover.
    const out = redactDebugMessage(
      "APIError: cause=Error: parsed key1=val1 status=500",
    )
    expect(out).toBe("APIError: cause=<redacted> key1=val1 status=500")
  })

  it("consumes a URL with a `?k=v` query fragment as one bare token (NewS2 boundary)", () => {
    // URL query fragments contain `?key=val` shapes, but the
    // whitespace-with-`NEXT_FIELD_SHAPE` lookahead only fires at
    // whitespace boundaries — `?key=` is mid-token because no
    // whitespace precedes it. So the URL plus any trailing
    // descriptive remainder (until either a true whitespace + field
    // shape OR end-of-string) is consumed as one bare token. This
    // is over-redaction (the "and retry" tail vanishes) and is the
    // safe choice — the alternative would be a stop at every `?k=`
    // shape inside arbitrary identifiers, which would break the
    // outer scanner's cursor invariants. Pin so the boundary is
    // intentional rather than incidental.
    const out = redactDebugMessage(
      "APIError: cause=Error: failed see https://example.com?k=v and retry",
    )
    expect(out).toBe("APIError: cause=<redacted>")
  })

  it("does stop at a true whitespace + field-shape boundary even with a URL prefix", () => {
    // The URL itself doesn't trigger the lookahead, but the
    // whitespace before a follow-up SDK field DOES. So a shape
    // like `cause=URL describing X status=500` redacts up to the
    // next whitespace whose successor is field-shaped.
    const out = redactDebugMessage(
      "APIError: cause=Error: see https://example.com?k=v then status=500",
    )
    expect(out).toBe("APIError: cause=<redacted> status=500")
  })

  it("handles raw newlines in bare-token whitespace lookahead", () => {
    // Some call sites collapse control characters before stderr
    // emission (`oneLine`); others (e.g. `rejectionToLogLine` in
    // core/memory.ts) route redaction first. The bare-token
    // consumer's whitespace check covers `\n` / `\r` directly so the
    // lookahead works regardless of post-redaction control-char
    // handling at the call site.
    const out = redactDebugMessage("APIError: cause=Error: failed\nstatus=500")
    expect(out).toBe("APIError: cause=<redacted>\nstatus=500")
  })

  it("redacts cause= and query= attachments under the expanded SDK-field set", () => {
    // SDK error chains commonly attach `cause` (Node 16+ Error.cause)
    // and `query` (Notion `dataSources.query` failures). Both shapes
    // are covered by the same conservative branch logic.
    expect(redactDebugMessage("APIError: cause={inner: 'detail'} status=500")).toBe(
      "APIError: cause=<redacted> status=500",
    )
    expect(
      redactDebugMessage('SearchFailed: query="user secret data" code=500'),
    ).toBe("SearchFailed: query=<redacted> code=500")
  })

  it("redacts ntn_-prefixed bearer tokens (must-redact threat class)", () => {
    // Forward-compatible: today's Notion SDK does not interpolate
    // bearer tokens into Error.message, but adjacent SDK regressions
    // (axios pre-1.x echoing Authorization headers) make the guard
    // load-bearing. ntn-prefix is the ntn-issued token shape.
    const out = redactDebugMessage(
      "auth retry failed: Authorization=Bearer ntn_aaaaaaaaaaaaaaaaaaaaaaaa",
    )
    expect(out).toContain("<redacted-token>")
    expect(out).not.toContain("ntn_aaaaaaaaaaaaaaaaaaaaaaaa")
  })

  it("redacts secret_-prefixed bearer tokens (legacy integration shape)", () => {
    // Pre-0.10.0 LORE_NOTION_TOKEN integration secrets carry the
    // `secret_` prefix. Both shapes redact to the same sentinel.
    const out = redactDebugMessage(
      "leaked: secret_abcdefghijklmnopqrstuvwx in trace",
    )
    expect(out).toBe("leaked: <redacted-token> in trace")
  })

  it("redacts development_ntn_-prefixed PATs (dev-environment shape)", () => {
    // Dev-environment PATs carry the `development_ntn_` prefix. The
    // embedded `_` is a regex word character, so a `\b` between
    // `development_` and `ntn_` does not match — the full prefix must
    // appear as its own alternation in BEARER_TOKEN. Without that, dev
    // PATs leak unredacted to `LORE_DEBUG=1` stderr.
    const out = redactDebugMessage(
      "leaked: development_ntn_abcdefghijklmnopqrstuvwx in trace",
    )
    expect(out).toBe("leaked: <redacted-token> in trace")
  })

  it("does NOT redact short ntn-prefixed identifiers (≥20-char body bound)", () => {
    // The `[A-Za-z0-9_-]{20,}` body bound keeps the match narrow
    // enough that a field name like `ntn_short` or `secret_field_id`
    // is not mistaken for a token.
    expect(redactDebugMessage("ntn_short")).toBe("ntn_short")
    expect(redactDebugMessage("secret_field_id")).toBe("secret_field_id")
  })

  it("pins the lower bound: a 19-char `secret_` body does NOT match", () => {
    // The contract is `[A-Za-z0-9_-]{20,}` — pinning both ends of
    // the bound makes any future tightening explicit. The 19-char
    // body should pass through; one extra character should redact.
    const nineteen = "a".repeat(19)
    const twenty = "a".repeat(20)
    expect(redactDebugMessage(`secret_${nineteen}`)).toBe(`secret_${nineteen}`)
    expect(redactDebugMessage(`secret_${twenty}`)).toBe("<redacted-token>")
  })

  it("truncates oversized messages with a marker so an aggregator sees the boundary", () => {
    const oversized = "x".repeat(MAX_DEBUG_MESSAGE_LENGTH + 100)
    const out = redactDebugMessage(oversized)
    expect(out.length).toBe(MAX_DEBUG_MESSAGE_LENGTH + "…(truncated)".length)
    expect(out.endsWith("…(truncated)")).toBe(true)
  })

  it("composes truncation with redaction (page id present in long message)", () => {
    // A long message whose page-id substring sits inside the kept
    // window still gets redacted before truncation runs.
    const id = "abcdef0123456789abcdef0123456789"
    const tail = "y".repeat(MAX_DEBUG_MESSAGE_LENGTH)
    const out = redactDebugMessage(`page ${id}: ${tail}`)
    expect(out.includes(id)).toBe(false)
    expect(out.includes("<page-id>")).toBe(true)
    expect(out.endsWith("…(truncated)")).toBe(true)
  })

  it("is idempotent: applying the helper twice equals applying it once", () => {
    // Defends against a future caller accidentally double-wrapping
    // (e.g. a refactor that routes a message through the helper at
    // two layers). The output should remain a fixed-point.
    const id = "abcdef0123456789abcdef0123456789"
    const message = `Failed to load page ${id} body={"x":1}`
    const once = redactDebugMessage(message)
    const twice = redactDebugMessage(once)
    expect(twice).toBe(once)
  })
})

describe("redactDebugError (unknown-thrown coercion)", () => {
  it("renders an Error's message", () => {
    expect(redactDebugError(new Error("boom"))).toBe("boom")
  })

  it("stringifies non-Error rejections so a thrown string still surfaces", () => {
    expect(redactDebugError("bare-string-throw")).toBe("bare-string-throw")
  })

  it("redacts page-id substrings inside the coerced message", () => {
    const id = "abcdef0123456789abcdef0123456789"
    expect(redactDebugError(new Error(`failed on ${id}`))).toBe(
      "failed on <page-id>",
    )
  })

  it("coerces an object that throws on String() via Error inheritance", () => {
    // Defensive: not all SDK errors are `Error`, but every Error has a
    // `.message` field. The non-Error fallback uses `String(...)` —
    // pin that no exotic toString path leaks more than the message.
    class Custom {
      toString(): string {
        return "custom-error"
      }
    }
    expect(redactDebugError(new Custom() as unknown)).toBe("custom-error")
  })

  it("coerces a thrown non-string return from toString without leaking page-id detail", () => {
    // The genuine non-Error edge: a thrown object whose `toString`
    // returns the SDK-shape interpolation a redactor must scrub. The
    // String(...) fallback must still flow through redactDebugMessage.
    class WithSdkLeak {
      toString(): string {
        return "leaked page abcdef0123456789abcdef0123456789"
      }
    }
    const out = redactDebugError(new WithSdkLeak() as unknown)
    expect(out).toBe("leaked page <page-id>")
  })

  it("coerces primitive thrown values (numbers, booleans, null) safely", () => {
    expect(redactDebugError(42)).toBe("42")
    expect(redactDebugError(false)).toBe("false")
    expect(redactDebugError(null)).toBe("null")
    expect(redactDebugError(undefined)).toBe("undefined")
  })
})

describe("redactDebugExtraInfo (structured SDK-logger payloads)", () => {
  it("walks string leaves through the redactor while preserving scalars", () => {
    // The Notion SDK passes flat retry traces like
    // `{ method, path, attempt, delayMs }`. Operational fields get
    // substring scrubbing; numeric / boolean scalars survive so
    // per-retry diagnostics keep their operator-actionable value.
    // Sensitive fields like `body` are wholesale redacted regardless
    // of leaf shape.
    const input = {
      method: "PATCH",
      path: "/v1/pages/abcdef0123456789abcdef0123456789",
      attempt: 2,
      delayMs: 1000,
      body: '{"hidden":"value"}',
    }
    expect(redactDebugExtraInfo(input)).toEqual({
      method: "PATCH",
      path: "/v1/pages/<page-id>",
      attempt: 2,
      delayMs: 1000,
      body: "<redacted>",
    })
  })

  it("wholesale-redacts body= structured payloads regardless of nested shape (review-4 blocker)", () => {
    // The pre-#488-review-4 leaf-only walker scrubbed page-id
    // substrings but recursed into structured payloads — an SDK shape
    // with `body: { properties: { Name: { title: [...] } } }`
    // serialized the title content verbatim. Key-aware redaction
    // closes the structured-content leak class.
    const input = {
      body: {
        properties: { Name: { title: [{ text: { content: "private workspace body" } }] } },
        parent: { page_id: "abcdef0123456789abcdef0123456789" },
      },
    }
    expect(redactDebugExtraInfo(input)).toEqual({ body: "<redacted>" })
  })

  it("wholesale-redacts request, response, headers, payload, query keys", () => {
    expect(redactDebugExtraInfo({ request: { url: "https://x" } })).toEqual({
      request: "<redacted>",
    })
    expect(redactDebugExtraInfo({ response: { status: 500 } })).toEqual({
      response: "<redacted>",
    })
    expect(redactDebugExtraInfo({ headers: { auth: "Bearer x" } })).toEqual({
      headers: "<redacted>",
    })
    expect(redactDebugExtraInfo({ payload: ["leaked"] })).toEqual({
      payload: "<redacted>",
    })
    expect(redactDebugExtraInfo({ query: "user secret data" })).toEqual({
      query: "<redacted>",
    })
  })

  it("wholesale-redacts a sensitive key whose value is a primitive too", () => {
    // String / number primitives under sensitive keys redact wholesale
    // even though substring scrubbing alone would leave them visible.
    expect(redactDebugExtraInfo({ body: "raw bytes" })).toEqual({ body: "<redacted>" })
    expect(redactDebugExtraInfo({ body: 42 })).toEqual({ body: "<redacted>" })
  })

  it("treats sensitive-key matching as case-insensitive", () => {
    expect(redactDebugExtraInfo({ Body: { x: 1 } })).toEqual({ Body: "<redacted>" })
    expect(redactDebugExtraInfo({ HEADERS: { auth: "x" } })).toEqual({
      HEADERS: "<redacted>",
    })
  })

  it("preserves an Error value under a sensitive key (Error special-case wins)", () => {
    // `request: new Error("...")` is a plausible SDK shape — the
    // Error special-case fires regardless of the sensitive-key
    // wholesale-redact rule so the operator-actionable name +
    // (scrubbed) message survives.
    const id = "abcdef0123456789abcdef0123456789"
    const out = redactDebugExtraInfo({
      request: new Error(`failed on page ${id}`),
    }) as Record<string, Record<string, unknown>>
    expect(out.request.name).toBe("Error")
    expect(out.request.message).toBe("failed on page <page-id>")
  })

  it("recurses through non-sensitive keys to catch nested sensitive keys", () => {
    // A plain `cause: { body: ... }` cause-payload is not an Error,
    // so the Error special-case doesn't fire — but `cause` IS in
    // the sensitive-key set, so the wholesale-redact rule applies
    // here directly.
    const out = redactDebugExtraInfo({ cause: { body: "secret" } }) as Record<
      string,
      unknown
    >
    expect(out.cause).toBe("<redacted>")
  })

  it("preserves operational fields like path with substring scrubbing intact", () => {
    // Non-sensitive keys continue to receive substring scrubbing on
    // string leaves — operators triaging a retry storm still see
    // `path: "/v1/pages/<page-id>"` even though the page id is
    // redacted. This is the core diagnostic value the helper
    // docstring promises to preserve.
    const out = redactDebugExtraInfo({
      path: "/v1/pages/abcdef0123456789abcdef0123456789",
      method: "PATCH",
      attempt: 3,
    })
    expect(out).toEqual({
      path: "/v1/pages/<page-id>",
      method: "PATCH",
      attempt: 3,
    })
  })

  it("walks nested objects and arrays recursively", () => {
    const input = {
      retries: [
        { path: "/v1/pages/abcdef0123456789abcdef0123456789" },
        { path: "/v1/pages/fedcba9876543210fedcba9876543210" },
      ],
    }
    expect(redactDebugExtraInfo(input)).toEqual({
      retries: [
        { path: "/v1/pages/<page-id>" },
        { path: "/v1/pages/<page-id>" },
      ],
    })
  })

  it("breaks circular references with a <circular> sentinel rather than throwing", () => {
    // SDK error payloads with self-referential `cause` chains used to
    // trip JSON.stringify's circularity check. The WeakSet walker
    // substitutes the back-reference and returns a serializable shape.
    const circular: Record<string, unknown> = { id: "abc" }
    circular["self"] = circular
    const out = redactDebugExtraInfo(circular) as Record<string, unknown>
    expect(out["id"]).toBe("abc")
    expect(out["self"]).toBe("<circular>")
  })

  it("returns a NEW object rather than mutating the input", () => {
    const input = { path: "/v1/pages/abcdef0123456789abcdef0123456789" }
    const out = redactDebugExtraInfo(input) as Record<string, unknown>
    expect(out["path"]).toBe("/v1/pages/<page-id>")
    // Input untouched — the SDK retains ownership of `extraInfo` and
    // an in-place rewrite would corrupt its view of the payload.
    expect(input.path).toBe("/v1/pages/abcdef0123456789abcdef0123456789")
  })

  it("passes scalars and null through unchanged", () => {
    expect(redactDebugExtraInfo(null)).toBe(null)
    expect(redactDebugExtraInfo(42)).toBe(42)
    expect(redactDebugExtraInfo(true)).toBe(true)
    expect(redactDebugExtraInfo("clean string")).toBe("clean string")
  })

  it("special-cases Error to extract name + scrubbed message (NS2 fix)", () => {
    // `Object.entries(new Error(...))` returns `[]` because Error
    // properties are non-enumerable. Without the special-case the
    // walker would emit `{}` and the message would never have been
    // visible to the redactor. The special-case keeps the diagnostic
    // visible AND scrubbed.
    const id = "abcdef0123456789abcdef0123456789"
    const err = new Error(`page ${id} not found`)
    const out = redactDebugExtraInfo({ cause: err }) as Record<
      string,
      Record<string, unknown>
    >
    expect(out.cause.name).toBe("Error")
    expect(out.cause.message).toBe("page <page-id> not found")
  })

  it("recurses through Error.cause chains, redacting each link", () => {
    const inner = new Error("inner abcdef0123456789abcdef0123456789")
    const outer = new Error("outer wrap")
    ;(outer as { cause?: unknown }).cause = inner
    const out = redactDebugExtraInfo(outer) as Record<string, unknown>
    expect(out.message).toBe("outer wrap")
    const innerOut = out.cause as Record<string, unknown>
    expect(innerOut.message).toBe("inner <page-id>")
  })

  it("preserves a custom Error subclass's name field", () => {
    class APIError extends Error {
      constructor(message: string) {
        super(message)
        this.name = "APIError"
      }
    }
    const out = redactDebugExtraInfo(new APIError("boom")) as Record<string, unknown>
    expect(out.name).toBe("APIError")
    expect(out.message).toBe("boom")
  })

  it("does NOT throw on deeply-nested non-cyclic input (NewS4 depth bound)", () => {
    // Without the depth bound, a 5000-level-deep payload triggers
    // `RangeError: Maximum call stack size exceeded` from the
    // recursive walk. The bound at MAX_EXTRA_INFO_DEPTH replaces the
    // tail with the wholesale-redact sentinel before the engine
    // stack ceiling. `stderrSdkLogger` wraps the helper in
    // `try/catch`, but a future direct caller would otherwise be
    // surprised — pin the failure-closed behavior at the helper.
    let deep: Record<string, unknown> = { leaf: "value" }
    for (let i = 0; i < 5000; i++) deep = { wrap: deep }
    expect(() => redactDebugExtraInfo(deep)).not.toThrow()
  })

  it("returns the wholesale-redact sentinel at depths beyond the bound", () => {
    // Walk into a depth-50 payload and confirm the leaf collapses
    // to `<redacted>` at MAX_EXTRA_INFO_DEPTH = 32. Doesn't pin the
    // exact depth (a future tuning could move it) — pins that the
    // walker terminates with the sentinel rather than throwing or
    // returning the leaf verbatim.
    let deep: Record<string, unknown> = { leaf: "value" }
    for (let i = 0; i < 50; i++) deep = { wrap: deep }
    const out = JSON.stringify(redactDebugExtraInfo(deep))
    expect(out).toContain('"<redacted>"')
    expect(out).not.toContain('"leaf":"value"')
  })
})
