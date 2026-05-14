/**
 * Domain-level adapters for `query_data_sources` SQL queries.
 *
 * Contract: keep arbitrary SQL out of the domain services.
 * Services call typed adapters (`fetchEntityByNormalizedName`,
 * `fetchNearDuplicateCandidatePageIds`) that accept structural
 * inputs and return structural outputs. The adapters own:
 *
 * 1. SQL composition (parameter binding, identifier quoting).
 * 2. Result-row narrowing from `Record<string, SqlCellValue>` to
 *    typed Lore page-id arrays.
 * 3. The capability/rate-limit/null-semantics caveats documented
 *    inline next to each query.
 *
 * Each helper takes a `Client` and dispatches through the shared
 * `runTool(client, "query_data_sources", params)` dispatcher, which
 * routes via the SDK's `client.request<T>(...)` surface so RunTool
 * calls share the same rate-limit gate, auth-
 * refreshing proxy, and User-Agent as every other Notion call.
 *
 * The core services (`EntityService`, `findNearDuplicates`) check
 * the {@link isRunToolFilterSqlEnabled} flag and either dispatch
 * through one of these adapters OR fall through to the existing
 * REST/SDK path. Per-call fallback on a non-validation error is
 * the caller's responsibility — each domain has different
 * invariants about "fall back silently" vs "surface to operator,"
 * and the adapter stays narrow.
 */

import type { Client } from "@notionhq/client"
import type { Memory } from "../../types.js"
import { runTool } from "./client.js"
import { SqlPartialResultError } from "./error-helpers.js"
import { dataSourceUrl, type SqlCellValue } from "./types.js"

/**
 * Fetch candidate Entity rows whose `Name` matches a normalized
 * key — SQL is the candidate-pool narrower, NOT the authoritative
 * matcher.
 *
 * **Why narrow-then-rematch.** SQLite's `LOWER()` only folds
 * ASCII. Lore's `normalizeEntityKey` runs Unicode NFC + lowercase
 * + whitespace collapse + trailing-punct strip, and the REST
 * fallback in `EntityService.findByName` post-filters with
 * `normalizeEntityKey(rawName) === key` — i.e. it normalizes BOTH
 * sides at compare time. If SQL alone authoritatively decided a
 * negative match, a stored `"Memory Service. "` (trailing space +
 * period) would silently miss a query for `"memoryservice"`
 * because SQL's `LOWER()` produces `"memory service. "` which is
 * not equal to `"memoryservice"`. The REST path catches this
 * via the title-contains pass; the SQL path closes the hole by
 * using a substring filter to widen the candidate pool, then
 * re-applying the same normalization at the JS boundary.
 *
 * **Substring filter.** The query becomes
 * `LOWER(Name) LIKE '%key%'` (with the key as the SQL parameter,
 * `%`-wrapped at compose time). This matches the REST path's
 * `title.contains` substring sweep but in one round-trip with no
 * cursor pagination. Notion's title column commonly contains
 * single-token names so the substring pool is small in practice;
 * the JS post-filter narrows to exact normalized-key matches.
 *
 * **Cap.** `LIMIT 100` matches Notion's `dataSources.query` page
 * size — large enough that real ambiguity surfaces fit, small
 * enough that a degenerate one-letter substring doesn't return
 * the entire data source. Pre-PR review pointed out the
 * pre-existing `LIMIT 2` was a worse correctness hazard: a
 * matching row at substring-rank 3 with the live entity at rank
 * 4 would have been silently missed. The wider pool plus
 * JS-post-filter is the safe shape.
 *
 * **Archived rows are NOT excluded server-side.** The Notion SQL
 * gateway's `archived` column shape is an open question;
 * rather than guessing the column name, the SQL
 * returns every row that survives the substring pool and the
 * caller (`EntityService.findByName`) drops archived rows via
 * `pages.retrieve` + `isActiveEntityPage`, the same gate the
 * REST path uses. This means more `pages.retrieve` round-trips
 * on a substring-ambiguous query, but the safety property
 * (never return an archived row, never let an archived first
 * row mask a live second row) holds without depending on a
 * gateway column name.
 *
 * **Returns.** Every candidate's id + raw name; the caller
 * picks the first whose normalized name matches the key AND
 * whose `pages.retrieve` confirms it's live. Empty array when
 * SQL returned no rows.
 */
export interface SqlEntityNameMatch {
  pageId: string
  rawName: string
}

export async function fetchEntityByNormalizedName(
  client: Client,
  opts: {
    dataSourceId: string
    nameProperty: string
    normalizedName: string
  }
): Promise<SqlEntityNameMatch[]> {
  if (!opts.normalizedName) return []
  const url = dataSourceUrl(opts.dataSourceId)
  const column = quoteIdent(opts.nameProperty)
  // `LOWER(...) LIKE %key%` widens the candidate pool to every row
  // whose lowercased name contains the normalized key as a
  // substring. The JS post-filter inside `EntityService.findByName`
  // narrows back to exact `normalizeEntityKey(rawName) === key`
  // matches — same shape as the REST path's
  // `title.contains` + post-filter pipeline, but in one round-trip.
  const query =
    `SELECT id, ${column} AS name FROM ${quoteTable(url)} ` +
    `WHERE LOWER(${column}) LIKE ? LIMIT 100`
  const response = await runTool(client, "query_data_sources", {
    data: {
      mode: "sql",
      data_source_urls: [url],
      query,
      params: [`%${opts.normalizedName}%`],
    },
  })
  // F6 saturation handling. Throwing `SqlPartialResultError` routes
  // the call site (`EntityService.findByName`) through its per-call
  // REST fallback so a saturated SQL window can never be mistaken
  // for an authoritative negative. `fetchNearDuplicateCandidatePageIds`
  // applies the same contract on its consumer.
  if (response.has_more) {
    throw new SqlPartialResultError("entity-find-by-name")
  }
  const matches: SqlEntityNameMatch[] = []
  for (const row of response.results) {
    const pageId = sqlString(row["id"])
    if (!pageId) continue
    const rawName = sqlString(row["name"]) ?? ""
    matches.push({ pageId, rawName })
  }
  return matches
}

/**
 * Fetch candidate Entity rows whose `Aliases` column contains the
 * normalized key as a substring — SQL is the candidate-pool
 * narrower; the caller JS-post-filters via
 * `parseAliases` + `normalizeEntityKey` to confirm exact-alias
 * membership.
 *
 * **Why narrow-then-rematch (same posture as
 * {@link fetchEntityByNormalizedName}).** The Aliases column is a
 * Notion `rich_text` cell storing comma-separated alias strings.
 * SQLite's `LOWER()` is ASCII-only, and even an exact `LIKE
 * '%key%'` substring match would surface false positives — a query
 * for `"User"` would match a stored alias `"UserService"`. Lore's
 * existing REST `findByAlias` uses Notion's `rich_text contains`
 * with the same false-positive risk and post-filters via
 * `parseAliases(...).some((a) => normalizeEntityKey(a) === key)`.
 * The SQL path matches that exactly: substring narrower, then JS
 * exact-token check.
 *
 * **`LIMIT 100` cap.** Matches the entity-name SQL helper and
 * Notion's `dataSources.query` page size. A pathologically common
 * substring (e.g. one-letter alias) saturates the cap; the caller
 * (`EntityService.findByAlias`) detects saturation and falls
 * through to the REST paginated path so high-cardinality aliases
 * surface every match.
 *
 * **Archived rows are NOT excluded server-side** for the same
 * reason as `fetchEntityByNormalizedName`: the Notion SQL
 * gateway's `archived` column shape is an open question.
 * The caller drops archived rows via `pages.retrieve` +
 * `isActiveEntityPage`.
 *
 * **Returns.** Every candidate row's `(pageId, rawAliases)`. The
 * caller parses `rawAliases` and confirms at least one alias
 * normalizes to the requested key.
 */
export interface SqlEntityAliasMatch {
  pageId: string
  rawAliases: string
}

export async function fetchEntitiesByAliasSubstring(
  client: Client,
  opts: {
    dataSourceId: string
    aliasesProperty: string
    normalizedAlias: string
  }
): Promise<SqlEntityAliasMatch[]> {
  if (!opts.normalizedAlias) return []
  const url = dataSourceUrl(opts.dataSourceId)
  const column = quoteIdent(opts.aliasesProperty)
  const query =
    `SELECT id, ${column} AS aliases FROM ${quoteTable(url)} ` +
    `WHERE LOWER(${column}) LIKE ? LIMIT 100`
  const response = await runTool(client, "query_data_sources", {
    data: {
      mode: "sql",
      data_source_urls: [url],
      query,
      params: [`%${opts.normalizedAlias}%`],
    },
  })
  // F6 saturation handling — same contract as the
  // entity-name and near-duplicate helpers. A `has_more: true`
  // window means the JS post-filter cannot authoritatively
  // decide whether the REST paginated walk would surface
  // additional alias matches; throw and let the call site fall
  // back to REST.
  if (response.has_more) {
    throw new SqlPartialResultError("entity-find-by-alias")
  }
  const matches: SqlEntityAliasMatch[] = []
  for (const row of response.results) {
    const pageId = sqlString(row["id"])
    if (!pageId) continue
    const rawAliases = sqlString(row["aliases"]) ?? ""
    matches.push({ pageId, rawAliases })
  }
  return matches
}

/**
 * Server-side pre-filter for the conflict scanner's already-judged
 * check. Returns a `Set` of unordered pair-keys (`"<lo>::<hi>"`)
 * for every memory in the requested project whose `Compared With`
 * relation column is non-empty, paired with each id it contains.
 *
 * **Why this matches the spec's "Compared With negative relation
 * checks" target.** Today the conflict scanner walks every memory
 * (loaded via REST `dataSources.query`), then applies a JS
 * post-filter `memoryA.comparedWith.includes(memoryB.id) ||
 * memoryB.comparedWith.includes(memoryA.id)` against the loaded
 * `comparedWith` arrays. The data is in memory because
 * `pageToMemory` extracts it eagerly. With this SQL helper, the
 * scanner can either:
 *
 * - Pre-build the pair-key set with one targeted SQL query that
 *   server-side narrows to rows with non-empty `Compared With`
 *   (typically a small subset of the project's memories), instead
 *   of inheriting comparedWith data via the broad list-walk.
 * - JS-filter pairs in O(1) Set lookup against the pre-built set.
 *
 * The structural win: the SQL query is a narrow-pull (`Compared
 * With IS NOT NULL`) instead of a broad row-walk that happens to
 * carry comparedWith as a side payload. On a typical vault where
 * most memories have never been compared, this drops the
 * compared-pair fetch from O(N) row-walks to O(K) where K is the
 * number of judged rows.
 *
 * **`LIKE '%<id>%'` decomposition.** Notion's relation column
 * surfaces as a textual representation of the related ids in
 * SQLite. The SQL gateway's exact representation is an open
 * question, but every other relation-column predicate Lore
 * issues uses substring matching (the
 * `fetchNearDuplicateCandidatePageIds` `Project LIKE %projectId%`
 * shape is the canonical example). Same posture here: select rows
 * whose `Compared With` is non-empty AND whose project relation
 * matches.
 *
 * **JS-side pair extraction.** SQL returns `(id, comparedWith)`;
 * the helper parses each `comparedWith` string for embedded UUIDs
 * (Notion id shape: 32-char hex with optional dashes) and emits
 * one pair-key per `(rowId, otherId)` combination. Pair keys are
 * unordered (`<lo>::<hi>`).
 */
const NOTION_ID_RE = /[a-f0-9]{8}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{12}/gi

export async function fetchAlreadyComparedPairKeys(
  client: Client,
  opts: {
    dataSourceId: string
    projectProperty: string
    comparedWithProperty: string
    projectId: string
  }
): Promise<Set<string>> {
  const url = dataSourceUrl(opts.dataSourceId)
  const projectColumn = quoteIdent(opts.projectProperty)
  const comparedColumn = quoteIdent(opts.comparedWithProperty)
  // Pre-narrow server-side: only rows whose Compared With is
  // non-empty AND whose project relation matches the requested
  // project. Empty relation column representations (`NULL`,
  // `''`, `'[]'`) all fall out of `IS NOT NULL AND != ''` here.
  const query =
    `SELECT id, ${comparedColumn} AS compared FROM ${quoteTable(url)} ` +
    `WHERE ${projectColumn} LIKE ? ` +
    `AND ${comparedColumn} IS NOT NULL ` +
    `AND ${comparedColumn} != '' ` +
    `AND ${comparedColumn} != '[]' ` +
    `LIMIT 1000`
  const response = await runTool(client, "query_data_sources", {
    data: {
      mode: "sql",
      data_source_urls: [url],
      query,
      params: [`%${undash(opts.projectId)}%`],
    },
  })
  const pairs = new Set<string>()
  for (const row of response.results) {
    const id = sqlString(row["id"])
    const compared = sqlString(row["compared"])
    if (!id || !compared) continue
    const otherIds = compared.match(NOTION_ID_RE) ?? []
    const normalizedSelf = id.replace(/-/g, "").toLowerCase()
    for (const raw of otherIds) {
      const other = raw.replace(/-/g, "").toLowerCase()
      if (other === normalizedSelf) continue
      const [lo, hi] =
        normalizedSelf < other ? [normalizedSelf, other] : [other, normalizedSelf]
      pairs.add(`${lo}::${hi}`)
    }
  }
  return pairs
}

/**
 * Build the unordered pair-key two ids hash to (`"<lo>::<hi>"`)
 * mirror the keying scheme `fetchAlreadyComparedPairKeys` emits.
 * Used at the call site to look up whether a candidate pair has
 * been pre-judged.
 */
export function comparedPairKey(idA: string, idB: string): string {
  const a = idA.replace(/-/g, "").toLowerCase()
  const b = idB.replace(/-/g, "").toLowerCase()
  return a < b ? `${a}::${b}` : `${b}::${a}`
}

/**
 * Pull the candidate pool for {@link findNearDuplicates}'s memory
 * / decision probes via SQL with `Status IN (...)` and
 * `Kind NOT IN (...)` predicates pushed BEFORE the row limit.
 *
 * Contract: "Near-duplicate status and kind filters move before
 * candidate-pool truncation, so `limit` means SQL-filtered
 * candidates rather than candidates later pruned in JS." The REST
 * path in `MemoryService.list`
 * supports `excludeKinds` server-side already (Notion's `select
 * does_not_equal` array filter), but `statuses` (`accepted |
 * proposed`) is not expressible in one `dataSources.query` call
 * — Notion's filter DSL takes one `select.equals` clause per
 * status and OR-composing them through the existing list shape
 * would balloon the call site. The SQL path keeps the filter in
 * one query and one predicate set.
 *
 * **Predicate set.**
 * - `Project` relation contains `projectId` (always required —
 *   the probe never runs vault-wide).
 * - Optional `Topic` relation contains `topicId` (decision
 *   path).
 * - Optional `Kind = ?` (memory probes pass no kind; decision
 *   probe passes `"decision"`).
 * - Optional `Kind NOT IN (?, ?, ...)` (memory probe passes
 *   `["decision"]` to keep decisions out of memory near-dup
 *   responses).
 * - Optional `Status IN (?, ?, ...)` (decision probe passes
 *   `["accepted", "proposed"]`).
 * - Always-on cleanup-orphan exclusion via `Keywords NOT LIKE
 *   '%__lore-cleanup-orphan%'` (matches the REST path's
 *   sentinel-substring filter).
 * - Archived rows are filtered by the SQL gateway by default
 *   (verified 2026-05-05: the `archived` column does not exist
 *   in the SQL surface and a `WHERE archived = 0` clause errors
 *   with `no such column`). No client-side archived gate is
 *   needed or possible.
 *
 * **Tags are pushed server-side via the verified exact-token
 * JSON-quoted form** `Tags LIKE '%"<tag>"%'`. Production-vault
 * verification (2026-05-05) confirmed the SQL gateway stores
 * `Tags` as a JSON array of double-quoted strings (e.g.
 * `["onboarding","lore","secrets"]`); the closing `"` in the
 * `%"<tag>"%` pattern ensures only discrete tokens match —
 * `"refactor"` does NOT match `"refactor-old"` /
 * `"refactor-trade-off"` even though substring `%refactor%`
 * would. SQL applies the tag predicate BEFORE the `LIMIT`,
 * identical to REST `multi_select.contains` semantics, so
 * `LIMIT N` truthfully bounds N tag-matching candidates. Tag
 * values are validated against `^[a-zA-Z0-9][a-zA-Z0-9-]*$` as
 * defense in depth against LIKE special characters. See
 * `NearDuplicateSqlOpts.tags` for the per-call contract.
 *
 * **Return shape.** Page ids only — the caller hydrates each
 * id through `pages.retrieve` + `pageToMemory` to reuse the
 * existing Notion → `Memory` extractor. SQL-side hydration of
 * every Memory column would couple this query to the schema's
 * relation-property hydration discipline (the property-extractor
 * pattern); page ids + REST hydration
 * keeps the SQL surface narrow and the materialized `Memory`
 * shape identical to the REST path.
 */
export interface NearDuplicateSqlOpts {
  dataSourceId: string
  /** Project relation column name (`MEMORY_PROPS.PROJECT`). */
  projectProperty: string
  /** Topic relation column name (`MEMORY_PROPS.TOPIC`). */
  topicProperty: string
  /** Kind select column name (`MEMORY_PROPS.KIND`). */
  kindProperty: string
  /** Status select column name (`MEMORY_PROPS.STATUS`). */
  statusProperty: string
  /** Keywords rich_text column name (`MEMORY_PROPS.KEYWORDS`). */
  keywordsProperty: string
  /**
   * Project relation must contain this id.
   *
   * **Semantics match `projectOrUnscopedFilter`** — the REST
   * path's `MemoryService.list` uses `projectOrUnscopedFilter`
   * by default (`Project contains id OR Project is_empty`), so
   * unscoped (vault-wide) memories surface in project-scoped
   * probes. The SQL path matches this with
   * `(Project LIKE %id% OR Project IS NULL OR Project = '')`.
   * Pin `includeUnscoped: false` to drop the unscoped clause —
   * matches `MemoryService.list({ includeUnscoped: false })`.
   */
  projectId: string
  /**
   * When false, exclude unscoped (no-project) rows. Defaults to
   * true to match `MemoryService.list`'s default behavior.
   */
  includeUnscoped?: boolean
  /** Optional topic relation must contain this id. */
  topicId?: string
  /**
   * Optional exact-tag whitelist applied server-side as
   * `(Tags LIKE %"tag1"% OR Tags LIKE %"tag2"% ...)`, mirroring
   * REST `multi_select.contains` exact-token semantics. The SQL
   * gateway stores `Tags` as a JSON array of double-quoted
   * strings (verified 2026-05-05 on the production vault), so a
   * `%"<tag>"%` pattern matches only when `<tag>` appears as a
   * complete token — `"refactor"` does NOT match
   * `"refactor-old"`, `"refactor-trade-off"`, etc. The exact-token
   * shape was verified against production data.
   *
   * Tag values must be drawn from `TAG_VOCABULARY` (a closed
   * vocabulary) — none contain `"`, `%`, `_`,
   * or `\`, so SQL LIKE special characters are not a concern.
   * The helper validates each tag against a kebab-case regex as
   * defense in depth.
   */
  tags?: readonly string[]
  /** Notion `Tags` column name (`MEMORY_PROPS.TAGS`). Required when `tags` is non-empty. */
  tagsProperty?: string
  /** Optional `Kind = ?` filter. */
  kind?: string
  /** Excluded kinds (server-side `Kind NOT IN (...)`). */
  excludeKinds?: readonly string[]
  /** Status whitelist (server-side `Status IN (...)`). */
  statuses?: readonly string[]
  /**
   * Status blacklist (server-side `Status NOT IN (...)`). Used by
   * `MemoryService.listForNearDuplicates` to match `MemoryService.list`'s
   * default `Status != proposed` filter when no `statuses` whitelist
   * narrows the candidate pool — without this, the SQL path surfaces
   * proposed rows the REST path drops by default, breaking A/B
   * equivalence.
   *
   * Like {@link excludeKinds}, the predicate explicitly OR's
   * `Status IS NULL` so a row with no Status passes — matches
   * Notion's `does_not_equal` null-permissive posture.
   */
  excludeStatuses?: readonly string[]
  /** Sentinel substring excluded via `Keywords NOT LIKE '%sentinel%'`. */
  cleanupOrphanSentinel: string
  /** Result-row cap. Applied AFTER predicates, by contract. */
  limit: number
}

export async function fetchNearDuplicateCandidatePageIds(
  client: Client,
  opts: NearDuplicateSqlOpts
): Promise<string[]> {
  const url = dataSourceUrl(opts.dataSourceId)
  const params: Array<string | number | null> = []
  const predicates: string[] = []

  // Project filter matches `projectOrUnscopedFilter`: by default,
  // both project-scoped rows AND unscoped rows surface.
  //
  // **Production-vault verification (2026-05-05).** The Notion SQL
  // gateway stores relation columns as a JSON array of full URLs
  // containing the **undashed** page id form (e.g.
  // `["https://dev.notion.so/<undashed-uuid>"]`). A `LIKE '%dashed-uuid%'`
  // pattern silently returns zero rows. The helper undashes
  // `projectId` before building the LIKE pattern so callers can
  // pass either form.
  //
  // Empty-relation surface forms observed: `NULL`, empty string,
  // and the literal `[]`. The unscoped clause OR's all three.
  const includeUnscoped = opts.includeUnscoped !== false
  if (includeUnscoped) {
    predicates.push(
      `(${quoteIdent(opts.projectProperty)} LIKE ? ` +
        `OR ${quoteIdent(opts.projectProperty)} IS NULL ` +
        `OR ${quoteIdent(opts.projectProperty)} = '' ` +
        `OR ${quoteIdent(opts.projectProperty)} = '[]')`
    )
  } else {
    predicates.push(`${quoteIdent(opts.projectProperty)} LIKE ?`)
  }
  params.push(`%${undash(opts.projectId)}%`)

  if (opts.topicId) {
    predicates.push(`${quoteIdent(opts.topicProperty)} LIKE ?`)
    params.push(`%${undash(opts.topicId)}%`)
  }
  // **Exact-tag predicate via JSON-quoted form.** Verified
  // 2026-05-05 on the production vault that `Tags LIKE '%"<tag>"%'`
  // correctly matches only rows whose Tags JSON array contains
  // `<tag>` as a discrete token. The previous overfetch heuristic
  // (`SQL LIMIT = limit * 4` + JS post-filter) was rejected by
  // review iteration 4: a corpus where the first `limit * 4`
  // rows are all wrong-tag rows would silently truncate
  // tag-matching candidates that REST's pre-LIMIT filter would
  // surface. The exact-token SQL form fixes this: SQL applies
  // tag membership BEFORE the LIMIT, identical to REST
  // `multi_select.contains` semantics.
  //
  // Tag values are validated against a kebab-case regex (defense
  // in depth — `TAG_VOCABULARY` is closed and contains only
  // identifier-shaped tokens, but bypassing the closed
  // vocabulary at a future call site would be a footgun).
  if (opts.tags && opts.tags.length > 0) {
    if (!opts.tagsProperty) {
      throw new Error(
        "fetchNearDuplicateCandidatePageIds: `tags` requires `tagsProperty` " +
          "to be set so the predicate can target the right Notion column."
      )
    }
    for (const tag of opts.tags) {
      if (!SAFE_TAG_VALUE_RE.test(tag)) {
        throw new Error(
          `fetchNearDuplicateCandidatePageIds: tag value ${JSON.stringify(tag)} ` +
            `contains characters outside the kebab-case identifier vocabulary; ` +
            `SQL parameters with raw "/%/_/\\\\ would corrupt the LIKE pattern.`
        )
      }
    }
    const tagClauses = opts.tags
      .map(() => `${quoteIdent(opts.tagsProperty!)} LIKE ?`)
      .join(" OR ")
    predicates.push(`(${tagClauses})`)
    for (const t of opts.tags) params.push(`%"${t}"%`)
  }
  if (opts.kind) {
    predicates.push(`${quoteIdent(opts.kindProperty)} = ?`)
    params.push(opts.kind)
  }
  if (opts.excludeKinds && opts.excludeKinds.length > 0) {
    // Explicit `Kind IS NULL` allowance closes the SQL `NOT IN`
    // null-permissive trap: SQLite evaluates `NULL NOT IN (...)`
    // to NULL (falsy), so a row whose Kind is null would silently
    // drop from the candidate pool. Notion's `does_not_equal`
    // filter is null-permissive (a row with no Kind passes); the
    // SQL path matches that posture by OR-ing `Kind IS NULL` into
    // the predicate. Acceptance criterion #4: null/missing-property
    // semantics are documented per query.
    const placeholders = opts.excludeKinds.map(() => "?").join(", ")
    predicates.push(
      `(${quoteIdent(opts.kindProperty)} NOT IN (${placeholders}) ` +
        `OR ${quoteIdent(opts.kindProperty)} IS NULL)`
    )
    for (const k of opts.excludeKinds) params.push(k)
  }
  if (opts.statuses && opts.statuses.length > 0) {
    // `Status IN (...)` is null-restrictive on its own (a row with
    // no Status would drop), which matches the REST path's
    // explicit `select.equals` whitelist where a null status row
    // also fails. Documented for symmetry with the `excludeKinds`
    // null-permissive case.
    const placeholders = opts.statuses.map(() => "?").join(", ")
    predicates.push(`${quoteIdent(opts.statusProperty)} IN (${placeholders})`)
    for (const s of opts.statuses) params.push(s)
  }
  if (opts.excludeStatuses && opts.excludeStatuses.length > 0) {
    // Null-permissive `NOT IN` with explicit `IS NULL` allowance,
    // mirroring the `excludeKinds` posture above. The REST path's
    // `does_not_equal` is null-permissive too — a row with no
    // Status surfaces in both branches.
    const placeholders = opts.excludeStatuses.map(() => "?").join(", ")
    predicates.push(
      `(${quoteIdent(opts.statusProperty)} NOT IN (${placeholders}) ` +
        `OR ${quoteIdent(opts.statusProperty)} IS NULL)`
    )
    for (const s of opts.excludeStatuses) params.push(s)
  }

  predicates.push(
    `(${quoteIdent(opts.keywordsProperty)} NOT LIKE ? ` +
      `OR ${quoteIdent(opts.keywordsProperty)} IS NULL)`
  )
  params.push(`%${opts.cleanupOrphanSentinel}%`)

  // **Archived rows.** Verified 2026-05-05 that the SQL gateway
  // does NOT expose an `archived` column (`no such column:
  // archived`). The gateway appears to filter archived rows
  // out of the result set by default, so no client-side gate is
  // needed for the SQL path. Callers that need to confirm
  // archival status retrieve via `pages.retrieve` and read
  // `PageObjectResponse.archived`.
  //
  // **Sort order.** Verified 2026-05-05 that
  // `last_edited_time` / `lastEditedTime` are NOT valid SQL
  // columns; `createdTime` is. The near-duplicate probe doesn't
  // depend on a specific sort (the candidate pool is JS-scored
  // by trigram similarity afterwards), so omitting `ORDER BY`
  // is the safe shape — the SQL gateway returns rows in
  // gateway-default order.
  const limit = clampLimit(opts.limit)
  const query =
    `SELECT id FROM ${quoteTable(url)} ` +
    `WHERE ${predicates.join(" AND ")} ` +
    `LIMIT ${limit}`

  const response = await runTool(client, "query_data_sources", {
    data: {
      mode: "sql",
      data_source_urls: [url],
      query,
      params,
    },
  })
  // `has_more: true` means the gateway clamped
  // LIMIT and returned only the first page of the filtered
  // candidate set. The Notion request envelope exposes no
  // cursor / offset / page-size, so the helper cannot fetch the
  // next page. Throwing routes the call site through its
  // per-call REST fallback rather than silently returning a
  // partial result. The thrown error is NOT a `validation_error`
  // — the query composed correctly — so `isSqlValidationError`
  // returns false and `logRunToolFallback` emits the
  // `LORE_DEBUG=1` line under the same path as a transient 5xx.
  if (response.has_more) {
    throw new SqlPartialResultError("near-duplicate-candidates")
  }
  const ids: string[] = []
  for (const row of response.results) {
    const id = sqlString(row["id"])
    if (id) ids.push(id)
  }
  return ids
}

/**
 * Server-side aggregate over the Facts data source for the
 * orphan-rate metric.
 *
 * **What it does.** Issues a single `query_data_sources` SQL query
 * that groups every fact by its raw `SubjectEntity` relation value
 * AND its raw `Subject` title, then counts rows per group. The
 * caller (`computeOrphanRateFromAggregateRows`) folds the rows into
 * the canonical metric key — `subjectEntityId ?? computeSubjectKey(subject)`
 * — and computes the orphan rate.
 *
 * **Why group by both columns.** The metric key is a JS expression
 * that depends on `computeSubjectKey`'s Unicode NFC + lowercase +
 * whitespace-collapse + trailing-punct-strip pipeline. SQLite's
 * `LOWER()` is ASCII-only and the SQL gateway carries no
 * `computeSubjectKey` UDF, so the helper deliberately under-narrows
 * server-side: GROUP BY emits one row per `(SubjectEntity, raw
 * Subject)` distinct pair, and the JS folder applies
 * `computeSubjectKey` over the raw Subject before merging groups
 * that share a canonical key. Two unmigrated rows whose raw
 * Subjects differ only in case (`MemoryService` and `memoryservice`)
 * therefore arrive as two SQL rows; the JS fold collapses them onto
 * the same canonical key. This is the same posture as
 * `fetchEntityByNormalizedName`'s "narrow-then-rematch" rule —
 * SQL is the candidate-pool narrower, JS is the authoritative
 * canonicalizer.
 *
 * **Counts both live AND invalidated facts.** Notion's SQL gateway
 * does not expose date columns: production-vault verification
 * confirmed `"Valid Until"`, `validUntil`, `valid_until`, and
 * `ValidUntil` all fail with `no such column` (same shape as the
 * README's `last_edited_time` / `lastEditedTime` finding). With no
 * way to filter invalidated facts server-side, the SQL aggregate
 * counts EVERY fact in scope. The migrate-time call site
 * (`runOrphanRateReport`) keeps the two paths semantically
 * equivalent by passing `includeInvalidated: true` to the JS
 * enumeration fallback — both paths produce the same metric on
 * the same fact corpus.
 *
 * The semantic shift from "live facts only" to "all facts" is
 * operationally inconsequential: the orphan-rate question (does
 * case-folding canonicalization collapse the graph below 50%?)
 * is unchanged because invalidated facts contributed subjects to
 * the canonical grouping just like live ones did. Invalidated
 * facts on the dogfood vault are a single-digit percentage of
 * the corpus.
 *
 * **Filters applied server-side.**
 *
 * - Optional `Project LIKE %<undashed-projectId>%` when `projectId`
 *   is provided. Matches the relation-column substring posture
 *   `fetchNearDuplicateCandidatePageIds` uses (production-verified
 *   2026-05-05: relations store JSON arrays of full URLs containing
 *   the **undashed** id form). Project-set semantics for
 *   the orphan-rate metric mirror the existing migration's
 *   `queryBySubject("", { projectId })` — the migration scopes
 *   strictly when `projectId` is set.
 *
 * **No `LIMIT` clamp** other than the gateway's implicit cap.
 * Production-vault verification on 2026-05-06 found that the
 * gateway's implicit cap is small enough that **most non-trivial
 * vaults trip `has_more: true` on this aggregate** — the dogfood
 * vault's 269 distinct `(SubjectEntity, Subject)` groups across 924
 * facts saturated the response. The helper throws
 * `SqlPartialResultError` and the caller falls back to JS
 * enumeration, which is the expected production posture for the
 * aggregate path on non-trivial vaults. The aggregate path's
 * practical speedup is therefore limited to small vaults / narrow
 * project scopes where the distinct-group count fits under the
 * gateway cap. A future server-side pagination knob on
 * `query_data_sources` would lift this limitation.
 *
 * **Returns.** Each row carries:
 *
 * - `subjectEntityRaw`: the raw `SubjectEntity` cell value as
 *   stored in the SQL gateway (JSON-stringified array of full URLs
 *   on populated rows, or `null` / empty string on rows the
 *   migration hasn't re-pointed yet). The caller normalizes via
 *   `extractFirstRelationId(raw)` to recover the canonical Notion
 *   page id; passing the raw form through preserves the gateway's
 *   shape for callers that want to debug / log.
 * - `subject`: the raw Subject title text. The caller passes this
 *   through `computeSubjectKey` for the metric key fallback.
 * - `count`: row count for this `(SubjectEntity, Subject)` group.
 *
 * **Capability gate.** `query_data_sources` is gated behind
 * `hasAdvancedTools` (Enterprise + AI workspace tier). On a
 * workspace below that tier, the call returns 403
 * `RestrictedResource` and the call site falls back to JS — the
 * `logRunToolFallback` helper and the parent
 * `LORE_USE_RUNTOOL_AGGREGATE` flag's docstring carry the recipe.
 */
export interface SqlSubjectGroupCount {
  subjectEntityRaw: string | null
  subject: string | null
  count: number
}

export async function querySubjectGroupCountsViaRunTool(
  client: Client,
  opts: {
    factsDataSourceId: string
    subjectProperty: string
    subjectEntityProperty: string
    projectProperty: string
    projectId?: string
  }
): Promise<SqlSubjectGroupCount[]> {
  const url = dataSourceUrl(opts.factsDataSourceId)
  const subjectColumn = quoteIdent(opts.subjectProperty)
  const subjectEntityColumn = quoteIdent(opts.subjectEntityProperty)
  const projectColumn = quoteIdent(opts.projectProperty)

  const params: Array<string | number | null> = []
  const predicates: string[] = []

  if (opts.projectId) {
    predicates.push(`${projectColumn} LIKE ?`)
    params.push(`%${undash(opts.projectId)}%`)
  }

  const whereClause = predicates.length > 0 ? `WHERE ${predicates.join(" AND ")} ` : ""
  const query =
    `SELECT ${subjectEntityColumn} AS subjectEntity, ` +
    `${subjectColumn} AS subject, ` +
    `COUNT(*) AS cnt ` +
    `FROM ${quoteTable(url)} ` +
    whereClause +
    `GROUP BY ${subjectEntityColumn}, ${subjectColumn}`

  const response = await runTool(client, "query_data_sources", {
    data: {
      mode: "sql",
      data_source_urls: [url],
      query,
      params,
    },
  })

  // F6 saturation handling — same contract as the filter helpers
  // above. The gateway exposes no cursor / offset / page-size, so
  // a `has_more: true` aggregate response is structurally a partial
  // metric. Throwing routes the caller through the JS enumeration
  // fallback rather than letting a clamped GROUP BY masquerade as
  // an authoritative count.
  if (response.has_more) {
    throw new SqlPartialResultError("orphan-rate-aggregate")
  }

  const rows: SqlSubjectGroupCount[] = []
  for (const row of response.results) {
    const subjectEntityRaw = sqlString(row["subjectEntity"])
    const subject = sqlString(row["subject"])
    const count = sqlNumber(row["cnt"])
    if (count === null) continue
    rows.push({ subjectEntityRaw, subject, count })
  }
  return rows
}

/**
 * Extract the first Notion page id embedded in a relation column's
 * raw SQL gateway value. Production-vault verification (2026-05-05)
 * confirmed relation columns store JSON arrays of full URLs
 * containing **undashed** uuids (`["https://dev.notion.so/<undashed-uuid>"]`);
 * empty-relation forms observed: `null`, empty string, `'[]'`.
 *
 * **Returns.** The first matched page id rehydrated to the dashed
 * canonical form (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) so the
 * caller can compare against `Fact.subjectEntityId` (always dashed
 * by `pageToFact`). Returns `null` when the input is empty / null /
 * `'[]'` or contains no recognizable Notion id in URL form.
 *
 * **URL-anchored.** The regex requires the id to follow `://<host>/`
 * — i.e. it must appear in the documented JSON-array-of-URLs shape,
 * not as a free-floating 32-hex run anywhere in the cell. A looser
 * shape is a real correctness hazard: a cell whose
 * Subject value happened to contain `garbage 11111111111111111111111111111111
 * trailing` (32 contiguous hex chars from any source) would have
 * been silently treated as a populated `SubjectEntity` and the
 * orphan-rate metric would key the row on `entity:11111111-...`
 * instead of `key:<computeSubjectKey(subject)>`. The URL anchor is
 * what closes that hole.
 *
 * The regex accepts BOTH forms Notion's gateway might surface:
 * undashed (32 hex) and dashed (8-4-4-4-12). Today only the undashed
 * form is verified live; the dashed alternation is defense in depth
 * against a future schema-pin refresh.
 *
 * Why "first" rather than "all": `SubjectEntity` is a single-relation
 * column on the Facts schema (`relation: { single_property: {} }`),
 * so the JSON array always carries 0 or 1 entries in the wild.
 * Picking the first is structurally sound; if a future schema bump
 * promotes the column to multi-relation, the orphan-rate metric's
 * keying on `subjectEntityId ?? computeSubjectKey(subject)` already
 * accepts a single canonical id, so this stays the right shape.
 */
const NOTION_RELATION_URL_ID_RE =
  /https?:\/\/[^\s"'/]+\/([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i

export function extractFirstRelationId(raw: string | null): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (trimmed === "" || trimmed === "[]") return null
  const match = NOTION_RELATION_URL_ID_RE.exec(trimmed)
  if (!match) return null
  return redash(match[1])
}

/**
 * Rehydrate a Notion id (dashed or undashed) into the canonical
 * 8-4-4-4-12 dashed form used throughout the rest of the codebase
 * (`Fact.subjectEntityId`, `EntityService` ids).
 *
 * Idempotent — already-dashed input returns lowercased dashed form.
 */
function redash(id: string): string {
  const stripped = id.replace(/-/g, "").toLowerCase()
  if (stripped.length !== 32) return id.toLowerCase()
  return (
    stripped.slice(0, 8) +
    "-" +
    stripped.slice(8, 12) +
    "-" +
    stripped.slice(12, 16) +
    "-" +
    stripped.slice(16, 20) +
    "-" +
    stripped.slice(20)
  )
}

/**
 * Coerce a {@link SqlCellValue} that is expected to be a string.
 * `null` and non-string values return `null` so callers can branch
 * cleanly on "row had no value" vs "value was the empty string."
 */
export function sqlString(value: SqlCellValue | undefined): string | null {
  if (typeof value === "string") return value
  return null
}

/**
 * Coerce a {@link SqlCellValue} that is expected to be a number.
 * SQLite `COUNT(*)` lands as a JS number through the gateway, but
 * defensively also accept a numeric string ("12") in case the
 * gateway widens its representation. `null` / non-numeric values
 * return `null` so the caller can drop malformed aggregate rows.
 */
function sqlNumber(value: SqlCellValue | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * Hydrate a list of memory page ids into full `Memory` rows by
 * issuing one `pages.retrieve` per id through the supplied
 * fetcher. Provided here (rather than inline at the call site)
 * so the SQL-branch ergonomics match the REST branch's
 * `MemoryService.list` semantics — the call site stays a single
 * function call.
 *
 * Concurrency is bounded by the upstream rate-limit gate; this
 * helper just composes the fan-out via `Promise.all`. Failures on
 * an individual id are NOT swallowed — the helper rejects on the
 * first failure, and the caller (`findNearDuplicates`) wraps the
 * whole SQL branch in a try/catch that falls back to the REST
 * path on any failure mode.
 */
export async function hydrateMemoryPageIds<T extends NonNullable<unknown> = Memory>(
  pageIds: readonly string[],
  fetchOne: (pageId: string) => Promise<T | null>
): Promise<T[]> {
  if (pageIds.length === 0) return []
  const settled = await Promise.all(pageIds.map((id) => fetchOne(id)))
  const results: T[] = []
  for (const value of settled) {
    if (value !== null) results.push(value)
  }
  return results
}

/**
 * Quote a SQLite identifier with double quotes per the gateway's
 * documented contract. Embedded double quotes are doubled (the
 * SQL standard) so a property name like `My "favorite" tag`
 * survives.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * Quote the `collection://...` URL as a SQL table reference.
 * Same shape as {@link quoteIdent}; documented separately so a
 * future contributor reading the call site sees the
 * "URL-as-table-name" intent named.
 */
function quoteTable(url: string): string {
  return `"${url.replace(/"/g, '""')}"`
}

/**
 * Defensive bound on the SQL `LIMIT` clause. The runtime cap on
 * `query_data_sources` is documented as "needs runtime verification";
 * we cap at 1000 here so a caller passing
 * `Number.MAX_SAFE_INTEGER` doesn't generate a query the gateway
 * rejects with a 400. Real callers (`findNearDuplicates`)
 * already pass small bounded values (default 50).
 */
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 50
  return Math.min(Math.floor(limit), 1000)
}

/**
 * Strip dashes from a Notion page id.
 *
 * Notion's SQL gateway stores relation columns as JSON arrays of
 * full URLs (`["https://dev.notion.so/<undashed-uuid>", ...]`),
 * verified against the production vault on 2026-05-05.
 * `Project LIKE '%<dashed-uuid>%'` returns zero rows; the dashed
 * input must be normalized to the undashed page-id form before
 * binding into the LIKE pattern. Idempotent for already-undashed
 * input.
 */
function undash(id: string): string {
  return id.replace(/-/g, "")
}

/**
 * Identifier-shape regex for tag values. Tags binding into the
 * SQL `LIKE '%"<tag>"%'` pattern must not contain LIKE special
 * characters (`%`, `_`, `\`) or the JSON-quote anchor (`"`),
 * because those would let an attacker (or a buggy caller
 * bypassing `TAG_VOCABULARY`) forge unintended matches.
 *
 * `TAG_VOCABULARY` (a closed vocabulary) holds
 * only kebab-case identifiers — alphanumeric + hyphen. The
 * regex enforces that shape as defense in depth.
 */
const SAFE_TAG_VALUE_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/
