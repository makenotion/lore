/**
 * Bounded, defensively-scrubbed redaction for SDK error messages and
 * structured SDK-logger payloads routed to `LORE_DEBUG=1`-gated stderr
 * emitters.
 *
 * Lore documents `LORE_DEBUG=1` as a recommended diagnostic flag for
 * wake-up failures, partial-write failures, and identity-resolution
 * blips. Those are exactly the conditions under which the underlying
 * Notion SDK error carries the most request-scoped detail — page IDs
 * interpolated into messages by errors like `InvalidPathParameterError`,
 * truncated query fragments, sometimes echoed bodies. When stderr feeds
 * a centralized log aggregator (or a CI runner that captures stderr for
 * the duration of a run), that detail leaks recon-grade vault-locator
 * data to any reader of the log surface — including readers with weaker
 * access controls than the underlying Notion workspace itself.
 *
 * Two threat classes the helper distinguishes:
 *
 * - **Must-redact (token-leak class).** Bearer tokens (`ntn_…`,
 *   `development_ntn_…`, `secret_…`) are full credentials. The current
 *   Notion SDK does not interpolate them into `Error.message`, but historical
 *   SDK regressions in adjacent ecosystems (axios pre-1.x echoing
 *   `Authorization` headers in retry traces) make a forward-compatible guard
 *   load-bearing.
 * - **Should-redact (recon class).** Page IDs are not bearer secrets,
 *   but they are access locators that let an outsider enumerate vault
 *   structure they would
 *   otherwise need a working Notion grant to see. Truncated query
 *   fragments, response bodies echoed into messages, and request paths
 *   sit in the same class.
 *
 * Four defenses, in order. Order matters: SDK-field scrubbing substitutes
 * structured payloads with `<redacted>` first, so the bearer-token and
 * page-id passes only see the residual surface. Truncation runs last so
 * the budget is spent on already-scrubbed content.
 *
 * 1. **Scrub known SDK leak shapes** (`body=…`, `headers=…`, `payload=…`,
 *    `response=…`, `request=…`, `cause=…`, `query=…`). A small
 *    state-machine scanner walks the message, finds each `<field>=`
 *    marker via a word-boundary regex, and consumes the value via a
 *    delimiter-aware loop that handles four shapes:
 *
 *    - **Quoted strings** (`"…"` / `'…'`) with C-style backslash escapes.
 *    - **Balanced braces / brackets** at arbitrary nesting depth — the
 *      scanner increments a depth counter on each open, decrements on
 *      each close, and exits when depth returns to zero. Quoted spans
 *      inside a structured payload are skipped via the quoted-string
 *      handler so an embedded `}` inside `"…"` doesn't confuse the
 *      counter.
 *    - **Unbalanced or malformed structured input** — the scanner
 *      consumes through end-of-string rather than producing a partial
 *      redaction. Deliberate over-redaction is the conservative choice
 *      when the boundary is ambiguous; pinned by an unbalanced-input
 *      test fixture.
 *    - **Bare tokens** (the fallback) — consume until a hard stop
 *      character (`,`, `;`, `}`, `)`, `]`) OR until the next whitespace
 *      that's followed by another `<name>=` field-shape. The
 *      whitespace-with-field-lookahead heuristic handles the
 *      stringified-Error-cause case (`cause=Error: page lookup failed
 *      status=500`) where the bare-token branch would otherwise stop at
 *      the first space and leak the descriptive remainder; with the
 *      lookahead, the scanner consumes through the descriptive phrase
 *      and stops at the next field marker (`status=`), redacting the
 *      whole `cause=` value cleanly.
 *
 *    An earlier regex-only branch handled at most one level of nested
 *    braces; a two-level payload like
 *    `body={"outer":{"inner":{"a":"secret"}}, "message":"…"}`
 *    fell through to the bare-token fallback and leaked the tail. The
 *    scanner's depth counter resolves that by walking arbitrary nesting.
 *
 * 2. **Redact bearer-token-shaped substrings** (`ntn_…` /
 *    `development_ntn_…` / `secret_…` followed by ≥20 url-safe
 *    characters) to `<redacted-token>`. The threshold matches the
 *    shortest known Notion bearer prefix to avoid misfiring on unrelated
 *    identifiers; the upper bound is open because real tokens run >40
 *    characters.
 * 3. **Redact Notion page-id-shaped substrings** (`[a-f0-9]{32}` and the
 *    dashed UUID form `8-4-4-4-12`) to the literal `<page-id>`.
 * 4. **Truncate to `MAX_DEBUG_MESSAGE_LENGTH` characters**, appending
 *    `…(truncated)`. The budget is sized to capture an error category
 *    plus the first sentence of typical SDK messages (~200 chars on the
 *    observed `InvalidPathParameterError` / `RequestTimeoutError` /
 *    `APIResponseError` shapes) with 1.5× headroom.
 *
 * **Structured-payload key-aware redaction (extraInfo walker).**
 * Structured SDK logger payloads use the same sensitive field list as the
 * flat-string scrubber. `redactDebugExtraInfo` walks objects recursively,
 * replaces non-Error values under sensitive keys with `<redacted>` wholesale,
 * preserves Error diagnostics as `{ name, message, cause }` with scrubbed
 * messages, and stops at a bounded recursion depth so hostile or malformed
 * payloads cannot induce a stack overflow.
 *
 * Control-character coercion (the one-event-per-line invariant log
 * aggregators rely on) is a separate concern handled at each call site
 * by `oneLine` / equivalent. The two responsibilities are orthogonal —
 * splitting them keeps this helper scoped to "bounded + SDK-scrubbed"
 * and lets the one-line discipline live alongside the other
 * interpolated-field guards (`rootId`, `memoryId`, `entity`) where it
 * applies.
 *
 * The lint backstop rejects direct stderr interpolation of common error
 * message shapes. It is a defense-in-depth guard, not the full security
 * boundary: review still has to ensure every debug-only stderr emitter
 * routes unknown errors through this redactor and normalizes interpolated
 * fields to one line.
 *
 * The redactor preserves the error category and the first sentence of
 * the message, since those carry the diagnostic value an operator
 * needs to distinguish a transient 429 from a pathological loop.
 */

const PAGE_ID_HEX32 = /\b[a-f0-9]{32}\b/gi
const PAGE_ID_UUID = /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi

/**
 * Bearer-token shape matcher. Notion's static-integration tokens carry
 * the `secret_` prefix; personal tokens (ntn-issued and PAT) carry
 * `ntn_` in prod and `development_ntn_` on the dev environment. The
 * dev prefix is a distinct alternation, not an extension of `ntn_`,
 * because `_` is a regex word character — a `\b` between the embedded
 * `_` and `ntn_` does not match, so without listing the full dev prefix
 * here a dev PAT would pass through unredacted. All three pin the
 * `[A-Za-z0-9_-]{20,}` body to keep the match precise enough that a
 * field name like `secret_field_id` isn't mistaken for a token. The
 * trailing lookahead treats the full token alphabet as non-delimiters
 * so terminal `-` / `_` characters are consumed rather than exposed by
 * a word-boundary backtrack. The minimum length is conservative (real
 * tokens are >40 characters).
 */
const BEARER_TOKEN =
  /\b(?:development_ntn_|ntn_|secret_)[A-Za-z0-9_-]{20,}(?=$|[^A-Za-z0-9_-])/g

/**
 * Single source of truth for SDK field names treated as sensitive
 * across both the flat-string scrubber (`scrubSdkFields`) and the
 * structured-payload walker (`redactDebugExtraInfo`). A future
 * contributor adding a new sensitive name updates one literal and the
 * regex / set both pick it up automatically — no drift between the
 * two surfaces.
 *
 * The eight names mirror Notion SDK error / extra-info shapes whose
 * values may carry request-scoped detail. `headers` covers both the
 * singular and plural forms via the regex's `headers?` alternation
 * and via an explicit `header` entry in the set so `extraInfo.header`
 * (singular) gets the same wholesale redaction.
 */
const SDK_SENSITIVE_FIELD_NAMES = [
  "body",
  "headers",
  "payload",
  "request",
  "response",
  "cause",
  "query",
] as const

/**
 * Field-name marker for the SDK scrubber. Word-boundary anchored so
 * `subbody=` (a hypothetical SDK field that contains "body" as a
 * suffix) doesn't trigger the redactor. Case-insensitive because
 * historical SDK error messages have inconsistently capitalized.
 * `headers` matches both `header=` and `headers=` so a singular form
 * doesn't slip past the regex; the structured-payload walker's
 * `SENSITIVE_EXTRA_INFO_KEYS` set adds an explicit `"header"` entry
 * for the same reason.
 *
 * Each consumer reads the regex with its own `lastIndex`; we don't
 * mutate the literal's state across calls.
 */
const SDK_FIELD_NAMES = new RegExp(
  `\\b(${SDK_SENSITIVE_FIELD_NAMES.map((name) =>
    name === "headers" ? "headers?" : name
  ).join("|")})=`,
  "gi"
)

/**
 * Permissive `name=` shape used by the bare-token consumer's
 * whitespace-stop heuristic to recognize that a non-redactable
 * field follows the current value. Loose by design (any
 * identifier-shaped name) — the goal is to detect that the next
 * whitespace-separated token is structurally a new key/value, not
 * to enumerate the full field set. False positives over-redact the
 * bare-token tail (defensive over-redaction); false negatives leak a
 * descriptive phrase across whitespace into the next sentence
 * (already the pre-scanner behavior).
 */
const NEXT_FIELD_SHAPE = /^[A-Za-z_][\w-]*=/

const FIELD_VALUE_HARD_STOPS = new Set([",", ";", "}", "]", ")"])

/**
 * Bound for the post-redaction message body. Sized to capture an error
 * category plus the first sentence of typical SDK messages — the
 * observed `InvalidPathParameterError` / `RequestTimeoutError` /
 * `APIResponseError` shapes run ~200 chars on Notion v5; 300 is 1.5×
 * headroom for that. The bound is in characters (JS string-length
 * semantics), not bytes — `TRUNCATION_SUFFIX` carries a U+2026 ellipsis
 * that takes 3 bytes in UTF-8, so a downstream byte-cap consumer
 * should account for the encoding gap (typical max byte length is
 * `MAX_DEBUG_MESSAGE_LENGTH × 4 + 14`). Tune on observed real-world
 * SDK message lengths if "…(truncated)" starts appearing on
 * diagnostics that need their first sentence intact.
 */
export const MAX_DEBUG_MESSAGE_LENGTH = 300
const TRUNCATION_SUFFIX = "…(truncated)"
const REDACTED_FIELD_VALUE = "<redacted>"

/**
 * Depth bound for `redactInner`'s recursion. Notion SDK extra-info
 * payloads observed in practice are 2–4 levels deep (`{ method, path,
 * attempt, delayMs }` is one; `{ headers: { authorization: "..." } }` is
 * two). 32 is order-of-magnitude headroom for a future SDK that ships
 * a moderately deep response shape, while still catching pathological
 * inputs (the JS engine's default stack-size limit blows up around
 * ~10k recursive calls; a defensive bound at 32 closes the gap before
 * we get anywhere near the engine ceiling).
 *
 * Without this bound, a deeply-nested payload would surface as a
 * `RangeError: Maximum call stack size exceeded` thrown from the
 * helper. `stderrSdkLogger` already wraps the call in `try/catch` so
 * the user-visible failure is contained, but the bound prevents the
 * throw at the source so a future direct caller of the helper can't
 * be surprised. Returns the wholesale-redact sentinel (NOT a "too
 * deep" tagged sentinel) because the caller's contract is already
 * "anything past this point is opaque" — surfacing a different
 * sentinel would just create a third state log parsers have to
 * handle.
 */
const MAX_EXTRA_INFO_DEPTH = 32

/**
 * Walk `<field>=<value>` markers in a message, replacing each value
 * with the `<redacted>` sentinel. The module docstring's first defense
 * carries the threat model; `consumeFieldValue` carries the per-shape
 * boundary rules.
 *
 * The scanner is exported only for tests — production callers use
 * `redactDebugMessage` so the bearer-token / page-id / truncation
 * passes compose in one well-defined order.
 */
export function scrubSdkFields(message: string): string {
  if (message.length === 0) return message

  const fieldRegex = new RegExp(SDK_FIELD_NAMES.source, SDK_FIELD_NAMES.flags)
  let result = ""
  let pos = 0
  let match: RegExpExecArray | null

  while ((match = fieldRegex.exec(message)) !== null) {
    const fieldStart = match.index
    const valueStart = fieldStart + match[0].length
    const valueEnd = consumeFieldValue(message, valueStart)

    if (valueEnd > valueStart) {
      result += message.slice(pos, fieldStart) + match[1] + "=" + REDACTED_FIELD_VALUE
      pos = valueEnd
      fieldRegex.lastIndex = valueEnd
    } else {
      // No value to redact (field name immediately followed by a
      // delimiter / EOF). Leave the marker as-is and advance past
      // the equals sign so the next exec doesn't loop.
      result += message.slice(pos, valueStart)
      pos = valueStart
      fieldRegex.lastIndex = valueStart
    }
  }
  result += message.slice(pos)
  return result
}

/**
 * Consume a `<field>=` value starting at `start`. Dispatches on the
 * first character to one of four shapes (quoted / brace / bracket /
 * bare token) and returns the index immediately past the consumed
 * value. Out-of-bounds input returns `start` (no consumption).
 */
function consumeFieldValue(message: string, start: number): number {
  if (start >= message.length) return start
  const c = message[start]
  if (c === '"' || c === "'") return consumeQuoted(message, start, c)
  if (c === "{") return consumeBalanced(message, start, "{", "}")
  if (c === "[") return consumeBalanced(message, start, "[", "]")
  return consumeBareToken(message, start)
}

/**
 * Consume a quoted string starting at `start` (which must be the
 * opening quote). Handles C-style backslash escapes so `\"` does not
 * prematurely terminate. Unterminated quotes consume to end-of-string —
 * deliberate over-redaction on malformed input.
 */
function consumeQuoted(message: string, start: number, quote: string): number {
  let i = start + 1
  while (i < message.length) {
    const c = message[i]
    if (c === "\\" && i + 1 < message.length) {
      i += 2
      continue
    }
    if (c === quote) return i + 1
    i++
  }
  return message.length
}

/**
 * Consume a balanced brace / bracket payload starting at `start`
 * (which must be the opening delimiter). Walks a depth counter through
 * arbitrary nesting; quoted spans inside the payload are skipped via
 * `consumeQuoted` so an embedded `}` inside `"…"` doesn't confuse the
 * counter. Unbalanced input consumes to end-of-string.
 */
function consumeBalanced(
  message: string,
  start: number,
  open: string,
  close: string
): number {
  let depth = 0
  let i = start
  while (i < message.length) {
    const c = message[i]
    if (c === '"' || c === "'") {
      i = consumeQuoted(message, i, c)
      continue
    }
    if (c === open) {
      depth++
      i++
      continue
    }
    if (c === close) {
      depth--
      if (depth === 0) return i + 1
      i++
      continue
    }
    i++
  }
  return message.length
}

/**
 * Consume a bare-token field value. Hard-stops at the closing
 * delimiters listed in `FIELD_VALUE_HARD_STOPS`. On whitespace, peeks
 * ahead via `NEXT_FIELD_SHAPE` to see if the next non-space token is
 * an identifier-shaped `<name>=` token (any `[A-Za-z_][\w-]*=`, NOT
 * just SDK-known field names); if so, stops at the whitespace so the
 * outer scanner can re-enter. Otherwise, continues across the
 * whitespace into the next descriptive token — addressing the
 * stringified-Error-cause case where a token-only stop would leak
 * the phrase between `Error:` and the next field marker.
 *
 * **The lookahead is permissive by design.** It triggers on ANY
 * `<name>=` shape, not just the eight SDK-leak field names — so on
 * shapes like `cause=Error: parsed key1=val1 status=500`, the
 * consumer stops at the first whitespace before `key1=val1` rather
 * than redacting through to `status=`. That's still the correct
 * posture: descriptive `key1=val1` is operator-readable, AND it
 * means the outer scanner re-enters cleanly and any follow-up SDK
 * field (`status=` here) survives intact. A test fixture pins this
 * (`debug-redact.test.ts:redacts a bare-token cause= value through
 * a non-SDK key= phrase`) so a future contributor can't tighten the
 * lookahead to "only SDK field names" without re-introducing the
 * NS1 leak class on shapes the test corpus didn't cover.
 *
 * **URL query-fragment boundary.** The lookahead only fires at
 * whitespace boundaries — a URL with a `?key=val` query fragment
 * has no whitespace before the `?k=` substring, so the URL is
 * consumed as one bare token through to the next true whitespace +
 * field-shape boundary (or end-of-string, whichever comes first).
 * Concretely, `cause=Error: failed see https://example.com?k=v and
 * retry` redacts the WHOLE phrase including the trailing `and
 * retry` — over-redaction on ambiguous boundary, the safe choice.
 * Pinned by `consumes a URL with a ?k=v query fragment as one bare
 * token` so the behavior is intentional rather than incidental.
 */
function consumeBareToken(message: string, start: number): number {
  let i = start
  while (i < message.length) {
    const c = message[i]
    if (FIELD_VALUE_HARD_STOPS.has(c)) return i
    if (isWhitespace(c)) {
      let j = i + 1
      while (j < message.length && isWhitespace(message[j])) j++
      if (j >= message.length) return i
      if (NEXT_FIELD_SHAPE.test(message.slice(j))) return i
      i = j
      continue
    }
    i++
  }
  return i
}

function isWhitespace(c: string): boolean {
  // Includes ASCII space + tabs + form-feed + vertical tab + LF / CR.
  // Some call sites collapse control characters to spaces via
  // `oneLine` before the line is written, but not all paths do —
  // `rejectionToLogLine` routes through `redactDebugMessage` BEFORE
  // its `HYBRID_LOG_CONTROL_CHARS` collapse, and a future caller
  // could skip the post-collapse entirely. Covering `\n` / `\r`
  // directly here keeps the bare-token consumer correct regardless
  // of the call site's post-processing.
  return c === " " || c === "\t" || c === "\f" || c === "\v" || c === "\n" || c === "\r"
}

/**
 * Scrub an SDK-or-internal error message before routing it to a
 * `LORE_DEBUG=1`-gated stderr emitter. See module docstring for the
 * threat model and per-defense rationale.
 *
 * Callers that surface user-facing recovery guidance can disable truncation;
 * the same SDK-field, token, and page-id scrubbing still applies.
 *
 * Idempotent under the default truncating mode: applying the helper twice
 * produces the same output as applying it once.
 */
export function redactDebugMessage(
  message: string,
  options: { truncate?: boolean } = {}
): string {
  if (message.length === 0) return message

  const scrubbed = scrubSdkFields(message)
    .replace(BEARER_TOKEN, "<redacted-token>")
    .replace(PAGE_ID_UUID, "<page-id>")
    .replace(PAGE_ID_HEX32, "<page-id>")

  if ((options.truncate ?? true) && scrubbed.length > MAX_DEBUG_MESSAGE_LENGTH) {
    return scrubbed.slice(0, MAX_DEBUG_MESSAGE_LENGTH) + TRUNCATION_SUFFIX
  }
  return scrubbed
}

/**
 * Convenience wrapper that coerces an unknown thrown value to a
 * scrubbed string. Mirrors the `error instanceof Error ? error.message
 * : String(error)` shape every existing `LORE_DEBUG`-gated emitter
 * already uses, with the redaction step folded in.
 *
 * The fallback path uses `String(...)`, which invokes `toString()` and
 * tolerates non-string returns — primitive thrown values (numbers,
 * booleans, symbols), null, and objects with custom `toString` are all
 * coerced to a string. A `toString` that throws will propagate the
 * throw, which is acceptable: a logger taking down the caller is
 * strictly worse than a logger surfacing an unrecognized rejection
 * shape, and any LORE_DEBUG emitter routing through here is already
 * inside a debug-only branch the caller controls.
 */
export function redactDebugError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return redactDebugMessage(raw)
}

/**
 * Set of object keys whose value is wholesale-redacted in
 * `redactDebugExtraInfo`. Derived from `SDK_SENSITIVE_FIELD_NAMES`
 * with `header` added explicitly — the regex covers `header=` via
 * `headers?` matching, but the set needs both spellings since plain
 * objects might use either key form. A single `as const` array
 * upstream feeds both this set and the regex so a contributor adding
 * a new sensitive name lands it on both surfaces by touching one
 * literal.
 *
 * The leaf-only redaction approach in earlier revisions caught
 * substring-shape leaks (page ids, bearer tokens) but not the
 * structured-content class — an SDK shape like `{ body: { properties:
 * { title: [{ text: { content: "private workspace body" } }] } } }`
 * walked recursively and the title content survived because it wasn't
 * substring-shaped. Key-aware redaction closes that — when a key
 * lands in this set, the entire value is replaced with `<redacted>`
 * regardless of nested shape, so SDK-side schema drift can't expose
 * new leak surfaces under a recognized sensitive field.
 *
 * Operational fields like `path`, `method`, `attempt`, and `delayMs`
 * are deliberately NOT in this set: their values continue through
 * substring scrubbing so per-retry diagnostics remain useful.
 */
const SENSITIVE_EXTRA_INFO_KEYS = new Set<string>([
  ...SDK_SENSITIVE_FIELD_NAMES,
  "header", // singular form — the regex handles `headers?=` already
])

/**
 * Recursively scrub a structured SDK-logger payload (the `extraInfo`
 * object the Notion SDK passes to `Logger`). Three defenses compose:
 *
 * 1. **Key-aware wholesale redaction.** When a property key matches
 *    `SENSITIVE_EXTRA_INFO_KEYS` (case-insensitive), the value is
 *    replaced with `<redacted>` rather than recursed — closes the
 *    structured-content leak class where an SDK shape like
 *    `{ body: { properties: ... } }` would walk recursively and only
 *    have its string leaves scrubbed.
 * 2. **Substring scrubbing on operational fields.** Non-sensitive
 *    string leaves route through `redactDebugMessage` so per-retry
 *    diagnostics like `path: "/v1/pages/<id>"` get page-id-shape
 *    redaction without losing operator value.
 * 3. **Scalar preservation.** Numbers, booleans, and null pass through
 *    unchanged — diagnostics like `attempt: 2` / `delayMs: 1000`
 *    survive unscrubbed.
 *
 * **Error wins over key-sensitivity.** When a property's *value* is
 * an `Error` instance, the Error special-case fires regardless of
 * whether the *key* is in the sensitive set. So an SDK shape like
 * `{ cause: new Error("page <id> not found") }` walks the Error to
 * extract `{ name, message: "page <page-id> not found" }` instead
 * of redacting the whole thing wholesale — the operator-actionable
 * diagnostic is preserved AND scrubbed. Plain (non-Error) values
 * under sensitive keys are still wholesale-redacted.
 *
 * **Error properties are non-enumerable**, so a naive
 * `Object.entries(new Error("x"))` returns `[]` and the message is
 * silently lost. The walker special-cases `instanceof Error` to
 * extract `name` / `message` / `cause` explicitly: `name` is preserved
 * (operator-actionable error category), `message` is routed through
 * `redactDebugMessage`, and `cause` recurses through `redactInner` so
 * Node 16+ `Error.cause` chains scrub end-to-end.
 *
 * **Circular references** are guarded via a `WeakSet` so a future SDK
 * shape with a cause-chain back reference can't trip the walker into
 * infinite recursion.
 *
 * Returns a new value rather than mutating in place: the SDK retains
 * ownership of `extraInfo` and may re-use the object across calls; an
 * in-place rewrite would corrupt the SDK's view of its own payload.
 */
export function redactDebugExtraInfo(value: unknown): unknown {
  return redactInner(value, new WeakSet(), 0)
}

function redactInner(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "string") return redactDebugMessage(value)
  if (value === null || typeof value !== "object") return value
  if (seen.has(value as object)) return "<circular>"
  if (depth >= MAX_EXTRA_INFO_DEPTH) return REDACTED_FIELD_VALUE
  seen.add(value as object)
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: redactDebugMessage(value.message),
    }
    const cause = (value as { cause?: unknown }).cause
    if (cause !== undefined) out["cause"] = redactInner(cause, seen, depth + 1)
    return out
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactInner(item, seen, depth + 1))
  }
  // `Object.entries(...)` yields [] for non-plain-object containers
  // (`Map`, `Set`, `WeakMap`, `WeakRef`, typed arrays' raw symbols) —
  // those collapse to `{}` and the diagnostic content vanishes
  // silently. Today's Notion SDK uses plain objects and arrays
  // exclusively for `extraInfo`, so this is documented forward-compat
  // surface area: if the SDK ever emits a `Map`-shaped payload, the
  // walker's "if you can't safely walk it, drop it" posture is the
  // safer default than synthesizing an unverified walk. A future SDK
  // schema drift would surface as a dropped-content bug rather than a
  // new leak vector. `Buffer` instances are technically integer-keyed
  // objects and would walk byte-by-byte, but in practice they appear
  // under sensitive keys (`body: Buffer.from(...)`) and the
  // wholesale-redact rule fires before the walker sees the bytes.
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_EXTRA_INFO_KEYS.has(key.toLowerCase()) && !(item instanceof Error)) {
      // Key is sensitive AND the value isn't an Error — wholesale
      // redact so nested structured payloads can't leak content
      // under recognized SDK field names. The Error escape-hatch is
      // load-bearing: a SENSITIVE-keyed Error (e.g. `request: new
      // Error("...")`) still walks through the Error special-case
      // so the diagnostic message survives, scrubbed.
      out[key] = REDACTED_FIELD_VALUE
    } else {
      out[key] = redactInner(item, seen, depth + 1)
    }
  }
  return out
}
