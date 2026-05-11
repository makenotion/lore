/**
 * Convert Notion REST property shapes (`buildFactProps` /
 * `buildMemoryProps` output) into the flat SQLite-style property
 * map RunTool's `create_pages` consumes (issue #533).
 *
 * **Why this exists.** The `notion-create-pages` MCP tool's schema
 * advertises `properties: Record<string, string | number | null>`
 * with a "Some property types require expanded format" note. The
 * exact expansion rules are not documented in the visible portion
 * of the public schema, so the conversion below is grounded in an
 * empirical inspection of an existing Facts DB row at the pinned
 * PR-#538 review time. The observed wire format on a live
 * `mentions` fact, captured via `query_data_sources`:
 *
 * | Notion REST shape                              | SQLite-flat shape                                |
 * | ---------------------------------------------- | ------------------------------------------------ |
 * | `{ title: [{ text: { content: "x" } }] }`      | `"x"` (string)                                   |
 * | `{ rich_text: [{ text: { content: "x" } }] }`  | `"x"` (string)                                   |
 * | `{ select: { name: "x" } }`                    | `"x"` (string)                                   |
 * | `{ select: null }`                             | `null`                                           |
 * | `{ number: 0.3 }`                              | `0.3` (number)                                   |
 * | `{ number: null }`                             | `null`                                           |
 * | `{ date: { start: "2026-04-30" } }`            | three keys: `date:<col>:start`, `:end`, `:is_datetime` |
 * | `{ date: null }`                               | three keys all `null`                            |
 * | `{ relation: [{ id: "abc" }, { id: "def" }] }` | JSON-stringified `[ "https://www.notion.so/abc", "https://www.notion.so/def" ]` |
 *
 * The pinned read-shape verification fired against the production
 * internal vault Facts DB at `collection://<facts-db-id>` and observed
 * rows like:
 *
 * ```jsonc
 * {
 *   "Subject": "WebView: customSchemeHandler.update(with:) ...",
 *   "Object": "BaseView",
 *   "Predicate": "mentions",
 *   "Project": "[\"https://dev.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"]",
 *   "Source": "[\"https://dev.notion.so/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"]",
 *   "Confidence": "speculative",
 *   "date:Valid From:start": "2026-04-30",
 *   "date:Valid From:end": null,
 *   "date:Valid From:is_datetime": 0,
 *   "Confidence Score": 0.3,
 *   "Scope Kind": null,
 *   ...
 * }
 * ```
 *
 * That's the canonical wire shape. A future schema-pin refresh that
 * changes the relation URL form (e.g. switches from `notion.so`
 * to `notion.com`) is the single update point — `RELATION_URL_BASE`
 * below is the constant.
 *
 * **URL form for relations.** The empirical sample shows
 * `https://dev.notion.so/<32hex>` for a vault on `api-dev.notion.com`.
 * Live verification at PR #538 review time confirmed that the host
 * MUST match the workspace's actual user-facing domain — the server
 * rejects `https://www.notion.so/<id>` against a dev workspace
 * (`Invalid page URL ... for property Project.`) and likewise the
 * reverse. The bare id and `notion.com` are also rejected. So the
 * relation URL base is environment-coupled and must be derived
 * from the auth chain's API host:
 *
 * | API host (`auth.baseUrl`)        | User-facing relation URL base |
 * | -------------------------------- | ----------------------------- |
 * | `https://api-dev.notion.com`     | `https://dev.notion.so/`      |
 * | `https://api.notion.com` (default) | `https://www.notion.so/`    |
 * | unknown / custom                 | falls back to `www.notion.so` |
 *
 * The mapping lives in `services.ts:deriveRelationUrlBase` and is
 * threaded through `FactService` to the converter via the
 * `createPagesViaRunTool` input. The converter accepts the base as
 * an optional parameter that defaults to `RELATION_URL_BASE_DEFAULT`
 * (`https://www.notion.so/`) for tests that don't care about
 * environment coupling. **Production callers MUST pass the
 * derived base explicitly** — relying on the production default
 * against a dev workspace produces a 400 from the server. The
 * default exists only so unit tests of the converter (where the
 * URL host is incidental to the assertion being made) can omit
 * the parameter without a fixture-rebuild churn.
 */

/**
 * Hardcoded production fallback used by tests that don't care about
 * environment coupling. Production callers MUST resolve the base
 * via `services.ts:deriveRelationUrlBase` and pass it explicitly.
 */
export const RELATION_URL_BASE_DEFAULT = "https://www.notion.so/"

/**
 * Strip dashes from a Notion page id and lowercase it. Notion accepts
 * both forms via the SDK; the SQLite wire form on read uses the
 * undashed form, so we normalize on write so the stored value is
 * stable regardless of the caller's id form.
 */
function normalizePageId(id: string): string {
  return id.replace(/-/g, "").toLowerCase()
}

function relationToUrlArrayString(
  relation: ReadonlyArray<{ id: string }>,
  relationUrlBase: string
): string {
  const urls = relation.map(
    (entry) => `${relationUrlBase}${normalizePageId(entry.id)}`
  )
  return JSON.stringify(urls)
}

/**
 * Internal type guard for the Notion REST property shape. The
 * actual Notion SDK types are very wide — `buildFactProps` /
 * `buildMemoryProps` produce a narrower writeable shape. The guard
 * runs at the property-type discriminator level and trusts that the
 * leaf-shape matches what those builders emit.
 */
type NotionRestProperty = Record<string, unknown>

export type SqlitePropertyValue = string | number | boolean | null

/**
 * The keys we emit are a superset of the input keys: every date
 * property expands into 3 keys (`<col>:start`, `<col>:end`,
 * `<col>:is_datetime`).
 */
export type SqliteProperties = Record<string, SqlitePropertyValue>

/**
 * Convert a single Notion REST property value into one or more
 * SQLite property entries. Date values produce 3 entries (the
 * expanded shape); every other type produces 1.
 *
 * Returns the entries to merge onto the result map. Returns `[]`
 * for properties that are structurally undefined-shaped (e.g. a
 * missing-discriminator object); those land in the SQLite map as
 * absent rather than null so the server's "leave column unchanged"
 * semantic is preserved.
 */
function convertProperty(
  columnName: string,
  value: unknown,
  relationUrlBase: string
): Array<[string, SqlitePropertyValue]> {
  if (value === null || value === undefined) return []
  if (typeof value !== "object") return []

  const prop = value as NotionRestProperty

  // `{ title: [{ text: { content: "x" } }] }` → "x"
  if ("title" in prop) {
    return [[columnName, extractTextArrayContent(prop["title"])]]
  }

  // `{ rich_text: [{ text: { content: "x" } }] }` → "x"
  if ("rich_text" in prop) {
    return [[columnName, extractTextArrayContent(prop["rich_text"])]]
  }

  // `{ select: { name: "x" } }` → "x"; `{ select: null }` → null
  if ("select" in prop) {
    const sel = prop["select"]
    if (sel === null) return [[columnName, null]]
    if (typeof sel === "object" && sel !== null && "name" in sel) {
      const name = (sel as { name: unknown }).name
      return [[columnName, typeof name === "string" ? name : null]]
    }
    return [[columnName, null]]
  }

  // `{ number: 0.3 }` → 0.3; `{ number: null }` → null
  if ("number" in prop) {
    const n = prop["number"]
    if (n === null) return [[columnName, null]]
    if (typeof n === "number") return [[columnName, n]]
    return [[columnName, null]]
  }

  // `{ date: { start: "2026-04-30" } }` →
  //   `date:<col>:start` = "2026-04-30",
  //   `date:<col>:end` = null,
  //   `date:<col>:is_datetime` = 0
  // `{ date: null }` → all three null.
  if ("date" in prop) {
    const date = prop["date"]
    if (date === null) {
      return [
        [`date:${columnName}:start`, null],
        [`date:${columnName}:end`, null],
        [`date:${columnName}:is_datetime`, null],
      ]
    }
    if (typeof date === "object" && date !== null) {
      const dateObj = date as { start?: unknown; end?: unknown }
      const start = typeof dateObj.start === "string" ? dateObj.start : null
      const end = typeof dateObj.end === "string" ? dateObj.end : null
      // Datetime detection: a Notion date with a time component
      // (`T` separator) is a datetime; `YYYY-MM-DD` alone is a
      // date. Mirrors the SQLite `is_datetime` integer convention
      // (0 = date, 1 = datetime) observed on read.
      const isDatetime = start !== null && start.includes("T") ? 1 : 0
      return [
        [`date:${columnName}:start`, start],
        [`date:${columnName}:end`, end],
        [`date:${columnName}:is_datetime`, isDatetime],
      ]
    }
    return []
  }

  // `{ relation: [{ id: "..." }] }` → JSON array of URLs as a
  // string. The empirical wire form is a JSON-encoded string; the
  // SDK row reads it back as a string and downstream consumers
  // `JSON.parse` it. An empty relation array still produces a
  // valid `"[]"` payload — the server treats that as "clear the
  // column," same as the REST equivalent.
  if ("relation" in prop) {
    const rel = prop["relation"]
    if (!Array.isArray(rel)) return []
    const items: Array<{ id: string }> = []
    for (const entry of rel) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        "id" in entry &&
        typeof (entry as { id: unknown }).id === "string"
      ) {
        items.push({ id: (entry as { id: string }).id })
      }
    }
    return [[columnName, relationToUrlArrayString(items, relationUrlBase)]]
  }

  // Unknown property type — pass through nothing rather than
  // silently corrupt the wire payload. The wrapper-side fallback
  // contract (`FactService.createBatchWithDedup`'s catch block) will
  // surface any server-side rejection downstream.
  return []
}

function extractTextArrayContent(value: unknown): string {
  if (!Array.isArray(value)) return ""
  let text = ""
  for (const entry of value) {
    if (typeof entry === "object" && entry !== null) {
      const e = entry as { text?: { content?: unknown }; plain_text?: unknown }
      if (
        typeof e.text === "object" &&
        e.text !== null &&
        typeof (e.text as { content?: unknown }).content === "string"
      ) {
        text += (e.text as { content: string }).content
      } else if (typeof e.plain_text === "string") {
        text += e.plain_text
      }
    }
  }
  return text
}

/**
 * Convert a full Notion REST `properties` map into the flat
 * SQLite-shape map RunTool's `create_pages` expects.
 *
 * `relationUrlBase` MUST be the user-facing host root for the
 * workspace (e.g. `https://dev.notion.so/` for dev,
 * `https://www.notion.so/` for production). Live-verification on
 * an internal vault at PR #538 review time confirmed that
 * the server rejects relation URLs whose host doesn't match the
 * workspace environment with `400 validation_error: Invalid page
 * URL`. The base must be derived from the configured auth host,
 * NOT hardcoded — see `services.ts:deriveRelationUrlBase`.
 *
 * Idempotent and pure; no I/O.
 */
export function convertNotionRestToSqliteProperties(
  notionRestProps: Record<string, unknown>,
  relationUrlBase: string = RELATION_URL_BASE_DEFAULT
): SqliteProperties {
  const out: SqliteProperties = {}
  for (const [name, value] of Object.entries(notionRestProps)) {
    for (const [outKey, outValue] of convertProperty(
      name,
      value,
      relationUrlBase
    )) {
      out[outKey] = outValue
    }
  }
  return out
}
