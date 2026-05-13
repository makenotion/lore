/**
 * Narrow predicates over Notion SDK error shapes.
 *
 * `@notionhq/client` ships its own error class hierarchy, but its
 * shape has churned across v4 → v5 and the project filters by the
 * stable `code` discriminant rather than `instanceof APIResponseError`
 * to keep the dependency surface narrow. Helpers here translate raw
 * SDK errors into the structural facts the call sites actually care
 * about: "is this a missing-property validation error" / etc.
 */

/**
 * Match Notion's `validation_error` raised when a filter references a
 * property that doesn't exist on the data source.
 *
 * Used by:
 *
 * - `FactService.queryByEntityTextOnUnmigrated` — during a narrow schema
 *   drift window, the required `SubjectEntity` / `ObjectEntity` columns
 *   may not have been added yet; the recall path falls through to the
 *   relation-only result set so the union doesn't silently halve.
 * - `TaskService.countClosedSince` — vaults that pre-date `Done At`
 *   lack the column; the closure-rate line is suppressed entirely
 *   instead of throwing.
 *
 * Transient 5xx / rate-limit / network errors must NOT match — those
 * propagate so the caller surfaces the failure rather than getting a
 * silently-empty result.
 *
 * Matches by error `code` (the `validation_error` value is stable
 * across SDK versions per `APIErrorCode`) plus a substring check on
 * the message — Notion wraps several distinct schema mistakes under
 * the same `validation_error` code, so a genuinely-malformed-filter
 * error (wrong operator for the property type, etc.) still
 * propagates.
 */
export function isMissingPropertyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const code = (err as { code?: unknown }).code
  if (code !== "validation_error") return false
  const message =
    typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message
      : ""
  // Notion's SDK emits messages like "Could not find property with
  // name or id: <name>" or "<name> does not exist on this database."
  // Match either spelling defensively so an SDK message-shape change
  // doesn't silently drop the missing-property fallback.
  return (
    /property/i.test(message) &&
    /(not found|could not find|does not exist)/i.test(message)
  )
}

/**
 * Extract the property name from a Notion `validation_error` raised
 * when a write references a column that doesn't exist on the data
 * source. Returns `null` when the error isn't a missing-property
 * shape or when the property name can't be parsed.
 *
 * Used by call sites that want to surgically drop ONLY the failing
 * column from the retry payload rather than dropping every recently-
 * added column unconditionally (which would silently swallow writes
 * the schema actually does support on a partially-migrated vault).
 *
 * Matches the two message shapes the SDK emits today, both with and
 * without surrounding quotes:
 *
 *   Could not find property with name or id: "<name>"
 *   <name> does not exist on this database
 */
export function extractMissingPropertyName(err: unknown): string | null {
  if (!isMissingPropertyError(err)) return null
  const message = (err as { message: string }).message
  // Pattern 1: "Could not find property with name or id: <name>"
  // Anchor on "name or id:" so we don't match other intermediate
  // tokens (e.g. the "find property" prefix would otherwise capture
  // its own clause).
  const findMatch = message.match(
    /(?:name or id)[: ]+["']?([^"'.\n]+?)["']?\s*(?:[.\n]|$)/i
  )
  if (findMatch?.[1]) return findMatch[1]!.trim()
  // Pattern 1b: bare "Could not find property: <name>" without
  // the "name or id" prefix (older SDK shape, defense in depth).
  const findBare = message.match(
    /(?:could not find|not found).*?property[: ]+["']?([^"'.\n]+?)["']?\s*(?:[.\n]|$)/i
  )
  if (findBare?.[1]) return findBare[1]!.trim()
  // Pattern 2: "<name> does not exist on this database" — including
  // the SDK shape that prefixes the name with the literal word
  // "property" (e.g. `property SubjectEntity does not exist...`).
  // The non-capturing `(?:property\s+)?` prefix strips that word so
  // the captured name matches the FACT_PROPS values verbatim (e.g.
  // `SubjectEntity`, NOT `property SubjectEntity`). Without this
  // strip, the surgical-drop loop in `FactService.invalidate` /
  // `createPageWithMissingPropertyRetry` would fail the
  // `propertyName in properties` guard for every Pattern 2 emission
  // and fall through to a degraded recovery — invalidate to a bare
  // `Valid Until` write (dropping every supported column), create
  // to a raw 400 (blocking every new fact write on a stale vault).
  const existMatch = message.match(
    /(?:property\s+)?["']?([^"'\n]+?)["']?\s+does not exist/i
  )
  if (existMatch?.[1]) return existMatch[1]!.trim()
  return null
}

/**
 * Match transient Notion/API transport failures that are worth retrying
 * rather than recasting as domain absence.
 *
 * This intentionally excludes 401/403/404 and validation errors: those are
 * auth, permission, missing-object, or schema problems with different
 * recovery paths. It includes 429, 5xx, the SDK's `rate_limited` code, and
 * common Node/fetch network error codes that can surface when the request
 * never receives a stable Notion response.
 */
export function isTransientNotionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const status = (err as { status?: unknown }).status
  const code = (err as { code?: unknown }).code

  if (status === 429 || code === "rate_limited") return true
  if (typeof status === "number" && status >= 500 && status <= 599) return true

  if (typeof code === "string") {
    return [
      "ECONNRESET",
      "ECONNREFUSED",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(code)
  }

  return err instanceof TypeError
}
