/**
 * Entity CRUD + canonical-resolution helpers.
 *
 * The Entities DB (PF3-01) is the canonical-handle registry that
 * `FactService` joins against via `SubjectEntity` / `ObjectEntity`
 * relations. `lore-fact action='create'`, `lore-query action='ask'`,
 * and the `--build-entities` migration all funnel through `resolveOrCreateEntity`
 * so a single string input maps to one Entity row regardless of case
 * variants or richer-vs-bare handle suffixes.
 *
 * **Resolution model.**
 * 1. Exact match on `Name` (case-insensitive via the same `normalize`
 *    helper Facts use for `SubjectKey`).
 * 2. Substring match on `Aliases` (Notion's `rich_text contains` runs
 *    server-side; the cell stores a comma-separated list).
 * 3. Tie-break: a single match wins. Multiple matches surface as
 *    ambiguous, and the caller decides whether to surface candidates
 *    back to the user or pick deterministically (the migration picks
 *    longest-form).
 * 4. No match: auto-create when allowed (default), refuse in strict
 *    mode (the build-entities second-pass flag).
 *
 * The resolver does NOT auto-link memories or facts on create. That
 * lives in the call sites that have the surrounding context — keeping
 * the service narrow keeps the Entities DB usable as a manual editing
 * surface inside Notion.
 */

import type { Client } from "@notionhq/client"
import type { PageObjectResponse, QueryDataSourceParameters } from "@notionhq/client"
import type {
  CreateEntityInput,
  DatabaseRef,
  Entity,
  EntityKind,
  EntityResolution,
} from "../types.js"
import { ENTITY_KINDS } from "../types.js"
import { buildEntityProps, ENTITY_PROPS } from "../notion/schema.js"
import { computeSubjectKey } from "../notion/normalize.js"
import {
  isFullPage,
  extractTitle,
  extractRichText,
  extractSelect,
  extractRelationIds,
} from "../notion/extractors.js"
import { hydrateRelationProperties } from "../notion/relation-properties.js"
import { LruCache } from "./cache.js"
import {
  fetchEntitiesByAliasSubstring,
  fetchEntityByNormalizedName,
  isRunToolFilterSqlEnabled,
} from "../notion/runtool/index.js"
import { isSqlValidationError, logRunToolFallback } from "../notion/runtool/error-helpers.js"

/**
 * Cache TTL is short on purpose. Aliases are mutable (a `merge` or
 * manual edit appends to the list) and a stale alias-list view would
 * silently lose resolution accuracy. 60s mirrors `ProjectService` /
 * `TopicService`; tune down if alias drift becomes user-visible.
 */
const NAME_CACHE_TTL_MS = 60_000
const NAME_CACHE_MAX = 1000

/**
 * In-process per-instance cache of `normalized name → Entity`. Aliases
 * also resolve through the same cache when they hit the lookup path —
 * the cached entry's alias list is consulted first, which keeps the
 * common "agent re-asks the same name" pattern at one Notion query
 * across a session.
 */
type CacheEntry = Entity

/** Aliases stored on a single rich_text cell as `, `-joined. */
const ALIAS_DELIMITER_RE = /\s*,\s*/

/**
 * Parse the `Aliases` rich_text payload back into a string array.
 * Empty or missing cells become `[]`; whitespace-only entries are
 * dropped so a leading/trailing comma doesn't surface as `""`.
 */
export function parseAliases(raw: string): string[] {
  if (!raw) return []
  return raw
    .split(ALIAS_DELIMITER_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Normalize an alias for index-side comparison. Same shape as
 * `computeSubjectKey` so a fact that was canonicalized via SubjectKey
 * (P3-03 Part A) lines up with an Entity matched via this helper —
 * one mental model for "two strings collapse to the same key".
 */
export function normalizeEntityKey(value: string): string {
  return computeSubjectKey(value)
}

export interface ResolveOptions {
  /**
   * When false, `resolveOrCreateEntity` returns `{ entity: null, ambiguous: false,
   * candidates: [], created: false }` on no-match instead of minting a
   * new row. The migration uses this in its dry-run pass.
   */
  autoCreate?: boolean
  /** Optional kind hint for newly-created entities. */
  kind?: EntityKind
  /**
   * Project scope to attach to the resolved Entity row. Two paths:
   *
   * - **No match → auto-create:** the new row is minted with these
   *   projects on the `Project` relation.
   * - **Match (byName, or single byAlias) → union:** the existing row's
   *   `Project` relation is unioned with these ids, so a canonical
   *   entity touched repeatedly from different project-scoped fact
   *   creates accumulates union scope rather than staying frozen at
   *   whichever project first auto-created it. No-op when every id
   *   is already present.
   *
   * Ambiguous matches are not touched — there is no single target.
   */
  projectIds?: string[]
}

export interface GetEntityOptions {
  includeArchived?: boolean
}

export interface ArchiveEntityOptions {
  mergedInto?: Pick<Entity, "id" | "name">
  mergedAt?: string
}

/**
 * Page-size cap when listing entities for a "give me everything" pass
 * (the build-entities migration). Notion's hard ceiling is 100; we
 * paginate at the ceiling and let the runtime rate limiter throttle.
 */
const NOTION_MAX_PAGE_SIZE = 100

/**
 * Maximum number of `Entity rich_text contains` predicates that
 * `expandEntityQueryVariants` will compose for a single resolved
 * entity. Notion's filter nesting is bounded and `TaskService.list`
 * still slices to a 100-row response window — a runaway alias set
 * would inflate the filter shape without improving recall, the worst
 * of both worlds.
 *
 * 10 covers every alias set we have observed in the Mail vault by
 * an order of magnitude (the widest alias entries hover at 2–3),
 * leaves headroom for legacy spellings + the canonical name + the
 * raw user input, and is small enough that an alias drift to "every
 * subject ever seen" fails loudly via the warning channel rather
 * than silently. Tune up only if a real vault hits the cap on
 * legitimate aliases — and surface the bump alongside the warning
 * UI so operators can see why their cap moved.
 */
export const ENTITY_QUERY_VARIANT_CAP = 10

/**
 * Result of {@link expandEntityQueryVariants}.
 *
 * `variants` is the deduplicated, capped list of strings that should
 * be OR'd against the `Entity rich_text contains` filter. Always
 * non-empty when a meaningful input was passed (the raw input is the
 * baseline variant). `hitCap` flags when the canonical entity has
 * more aliases than the cap absorbs — callers surface this as a
 * warning so an operator can see that recall is being clipped rather
 * than the cap silently degrading task lookup.
 *
 * `dropped` lists alias variants the cap excluded (canonical
 * preserved, raw input preserved, alias overflow trimmed). Surfaced
 * for the warning text so operators see exactly which aliases stop
 * being recalled when the cap fires.
 */
export interface EntityQueryVariants {
  variants: string[]
  hitCap: boolean
  dropped: string[]
}

/**
 * Expand a resolved entity into the case-insensitively-deduped set of
 * strings to feed `TaskService.list`'s `entities` filter.
 *
 * Variant ownership lives on `EntityService` rather than the call
 * site so a future extension (e.g. include normalized synonyms, drop
 * the raw input on a guaranteed-canonical caller) is one helper edit
 * — not a sweep across every caller of `lore-task action='list'`
 * that does its own ad-hoc string composition. The
 * `lore-query action='ask'` task recall path is the canonical caller;
 * future surfaces should reuse
 * this helper or accept that they will re-derive the same logic
 * incorrectly.
 *
 * Behavior:
 * - The raw user input is always preserved as the first variant so
 *   un-migrated tasks that store a free-form spelling (the Mail
 *   vault has many) still match. The canonical name follows when
 *   distinct.
 * - Aliases are appended in their stored order so a `--build-entities`
 *   migration that placed canonical-adjacent variants first surfaces
 *   them first under the cap.
 * - Deduplication runs on the same normalized key Facts use
 *   (`normalizeEntityKey`), so case variants and trailing-punct
 *   variants collapse rather than burning slots under the cap.
 * - Output preserves original spelling — Notion `contains` is
 *   case-insensitive but the variant text surfaces in the warning
 *   message, so showing the user-recognisable form matters.
 *
 * Returns `{ variants: [trimmed], hitCap: false, dropped: [] }` for an
 * empty / null `entity` resolution so callers can pass through the
 * raw input untouched (legacy vault path).
 */
export function expandEntityQueryVariants(
  rawInput: string,
  entity: Pick<Entity, "name" | "aliases"> | null,
  cap = ENTITY_QUERY_VARIANT_CAP
): EntityQueryVariants {
  const trimmed = rawInput.trim()
  if (!trimmed) {
    return { variants: [], hitCap: false, dropped: [] }
  }

  const seen = new Set<string>()
  const variants: string[] = []
  const pushIfFresh = (value: string): boolean => {
    const candidate = value.trim()
    if (!candidate) return false
    const key = normalizeEntityKey(candidate)
    if (!key || seen.has(key)) return false
    seen.add(key)
    variants.push(candidate)
    return true
  }

  pushIfFresh(trimmed)
  if (entity) {
    pushIfFresh(entity.name)
  }

  const dropped: string[] = []
  if (entity) {
    for (const alias of entity.aliases) {
      if (variants.length >= cap) {
        const candidate = alias.trim()
        if (!candidate) continue
        const key = normalizeEntityKey(candidate)
        if (!key || seen.has(key)) continue
        // Track only fresh aliases we had to drop — duplicates of an
        // already-included variant don't represent lost recall.
        dropped.push(candidate)
        continue
      }
      pushIfFresh(alias)
    }
  }

  return { variants, hitCap: dropped.length > 0, dropped }
}

/**
 * Safety cap on `findByName`'s contains-fallback and `findByAlias`
 * pagination. At 100 rows per page this caps at 1000 candidates per
 * lookup — large enough that real-world ambiguity surfaces still fit
 * (the spec's flagship "User" / "User (auth)" / "User (db)" case is
 * <10 entities), small enough that a pathologically common token
 * doesn't turn one resolve into a vault-wide scan. `findByName`'s
 * post-filter is exact normalized-key match, so the cap clips the
 * search-pool size rather than the result-set size; the legitimate
 * exact-match candidate must appear within the first
 * `NAME_LOOKUP_MAX_PAGES` pages of substring hits or the resolver
 * misses it.
 */
const NAME_LOOKUP_MAX_PAGES = 10

function isActiveEntityPage(
  page: Parameters<typeof isFullPage>[0]
): page is PageObjectResponse {
  return isFullPage(page) && !page.archived
}

export class EntityService {
  /**
   * Name + alias → Entity. Keyed on `normalizeEntityKey(name)` so case
   * variants share a slot. Aliases use the same key — when the alias
   * resolves we re-cache under the alias's normalized form pointing at
   * the same Entity reference, so the next lookup is one map hit.
   */
  private readonly nameCache = new LruCache<string, CacheEntry>(
    NAME_CACHE_MAX,
    NAME_CACHE_TTL_MS
  )

  constructor(
    private client: Client,
    private db: DatabaseRef
  ) {}

  async create(input: CreateEntityInput): Promise<Entity> {
    const page = await this.client.pages.create({
      parent: { type: "database_id", database_id: this.db.databaseId },
      properties: buildEntityProps({
        name: input.name,
        aliases: input.aliases ?? [],
        kind: input.kind,
        description: input.description,
        projectIds: input.projectIds,
      }),
    })

    const entity = await this.pageToEntity(page as PageObjectResponse)
    // Drop any stale negative-lookup entry under either the name or any
    // alias key so the freshly-created row is reachable on the next
    // resolve.
    this.invalidateAllKeys(entity)
    this.cacheEntity(entity)
    return entity
  }

  async getById(id: string, options: GetEntityOptions = {}): Promise<Entity> {
    const page = await this.client.pages.retrieve({ page_id: id })
    if (!isFullPage(page)) {
      throw new Error(`Entity ${id} could not be retrieved as a full Notion page`)
    }
    if (page.archived && !options.includeArchived) {
      throw new Error(`Entity ${id} is archived`)
    }
    return await this.pageToEntity(page as PageObjectResponse)
  }

  /**
   * Return every entity in the vault. Used by the build-entities
   * migration to seed an alias index without paying N queries.
   * Paginated.
   */
  async listAll(): Promise<Entity[]> {
    const results: PageObjectResponse[] = []
    let cursor: string | undefined

    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        sorts: [{ property: ENTITY_PROPS.NAME, direction: "ascending" }],
        page_size: NOTION_MAX_PAGE_SIZE,
        start_cursor: cursor,
      })
      results.push(
        ...(response.results.filter(isActiveEntityPage) as PageObjectResponse[])
      )
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined
    } while (cursor)

    return Promise.all(results.map((p) => this.pageToEntity(p)))
  }

  /**
   * Look up an entity by its canonical Name (exact match,
   * case-insensitive via the same `normalize` helper Facts use). Returns
   * the first hit — Names should be unique, but a legacy migration that
   * raced two creates is possible and handled by the resolver via its
   * ambiguity surface.
   */
  async findByName(name: string): Promise<Entity | null> {
    const key = normalizeEntityKey(name)
    if (!key) return null

    const cached = await this.getActiveCachedEntity(key)
    if (cached) return cached

    return this.nameCache.getOrLoad(key, async () => {
      // Issue #535: when `LORE_USE_RUNTOOL_FILTER_SQL` is on and a
      // RunTool wrapper is wired, ask SQL to widen the candidate
      // pool to every row whose lowercased name contains the
      // normalized key as a substring (one round-trip, no
      // pagination). The JS post-filter then narrows to exact
      // `normalizeEntityKey(rawName) === key` matches — same
      // contract as the REST path's `title.contains` + post-
      // filter pipeline. `LOWER()` is ASCII-only so the SQL
      // alone cannot authoritatively decide a negative match; the
      // post-filter side normalizes the stored name with the same
      // helper Lore uses everywhere (NFC + whitespace collapse +
      // trailing-punct strip + lowercase). Without the post-
      // filter, a stored `"Memory Service. "` would silently
      // miss `findByName("memoryservice")` (issue #539 review
      // blocker #2).
      //
      // Archived-row safety: the SQL pool is NOT filtered server-
      // side because the gateway's `archived` column shape is a
      // Phase 0 open question. Each candidate is gated by
      // `pages.retrieve` + `isActiveEntityPage` so an archived
      // row at substring-rank 1 cannot mask a live row at
      // substring-rank 2.
      //
      // Validation errors (`RunToolError.kind === "validation"`)
      // are NOT swallowed — they indicate query-shape drift
      // (column rename, gateway syntax change) and would silently
      // turn the SQL rollout into a permanent REST fallback. The
      // ambient `RunToolError` catch lets transient (network,
      // 5xx, restricted, rate_limited, unauthorized, malformed)
      // failures fall back per call; validation propagates to the
      // operator.
      if (isRunToolFilterSqlEnabled()) {
        try {
          const candidates = await fetchEntityByNormalizedName(this.client, {
            dataSourceId: this.db.dataSourceId,
            nameProperty: ENTITY_PROPS.NAME,
            normalizedName: key,
          })
          for (const candidate of candidates) {
            if (normalizeEntityKey(candidate.rawName) !== key) continue
            const page = await this.client.pages.retrieve({
              page_id: candidate.pageId,
            })
            if (!isActiveEntityPage(page)) continue
            return await this.pageToEntity(page as PageObjectResponse)
          }
          // SQL ran cleanly to completion (the helper threw
          // `SqlPartialResultError` if `has_more: true`, so reaching
          // here means the gateway returned the full filtered
          // candidate pool) and surfaced no live exact-key match
          // among the substring candidates. The negative is
          // authoritative — same outcome the REST paginated walk
          // would produce on the same vault state.
          return null
        } catch (err) {
          if (isSqlValidationError(err)) {
            // Surface to the operator. A 400 / validation_error
            // means the SQL query is malformed (column rename,
            // gateway syntax change, parameter binding shape
            // drift); silently falling back masks an issue worth
            // alerting on. The error message already carries
            // the gateway's specifics.
            throw err
          }
          // Every other failure mode (network / 5xx / 401 / 403 /
          // 429 / `SqlPartialResultError` from a saturated SQL
          // window) falls through to the REST path. The REST
          // paginated walk handles up to `NAME_LOOKUP_MAX_PAGES`
          // pages of substring matches, which is the authoritative
          // worst case.
          logRunToolFallback("entity-find-by-name", err)
        }
      }

      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: {
          property: ENTITY_PROPS.NAME,
          title: { equals: name },
        } as QueryDataSourceParameters["filter"],
        page_size: 5,
      })

      const pages = response.results.filter(isActiveEntityPage) as PageObjectResponse[]
      if (pages.length === 0) {
        // Notion's `title.equals` is case-sensitive. Paginate a
        // case-folded `title.contains` pass against the same-key
        // prefix so a user-typed "memoryservice" still finds
        // "MemoryService". The post-filter narrows back to exact
        // normalized-key match so we don't return spurious substring
        // hits.
        //
        // Pagination matters: a common substring like "User" or
        // "Service" can plausibly produce >25 candidate rows on a
        // mature vault. Walking up to `NAME_LOOKUP_MAX_PAGES` pages
        // (cap = 1000 candidates) keeps the recall hole closed without
        // turning one resolve into a vault-wide scan. Caught by review
        // on PR #88.
        //
        // Pre-filter on the synchronously-available `Name` title before
        // calling `pageToEntity` — `pageToEntity` hydrates the `Project`
        // relation column and can issue `pages.properties.retrieve` per
        // candidate. Hydrating every substring hit collapses the worst
        // case (1000-row scan) into 1000 sequential rate-limited round
        // trips. Issue #487.
        let cursor: string | undefined
        let pagesFetched = 0
        while (true) {
          const fallback = await this.client.dataSources.query({
            data_source_id: this.db.dataSourceId,
            filter: {
              property: ENTITY_PROPS.NAME,
              title: { contains: name },
            } as QueryDataSourceParameters["filter"],
            page_size: NOTION_MAX_PAGE_SIZE,
            start_cursor: cursor,
          })
          pagesFetched += 1
          const fallbackPages = fallback.results.filter(
            isActiveEntityPage
          ) as PageObjectResponse[]
          for (const page of fallbackPages) {
            const rawName = extractTitle(page.properties[ENTITY_PROPS.NAME])
            if (normalizeEntityKey(rawName) !== key) continue
            return await this.pageToEntity(page)
          }
          if (!fallback.has_more || pagesFetched >= NAME_LOOKUP_MAX_PAGES) {
            return null
          }
          cursor = fallback.next_cursor ?? undefined
        }
      }

      return await this.pageToEntity(pages[0])
    })
  }

  /**
   * Find every entity whose Aliases cell contains `alias` as a substring.
   * Returns post-filtered exact-token matches — a stored alias of
   * `MemoryService.create` will not match a query for `Service` even
   * though Notion's substring filter would surface it.
   *
   * Returns an array because aliases are deliberately not unique across
   * entities (that's how disambiguation works: two entities both
   * aliased `User` produce a 2-element ambiguity list).
   */
  async findByAlias(alias: string): Promise<Entity[]> {
    const key = normalizeEntityKey(alias)
    if (!key) return []

    // Issue #535: when `LORE_USE_RUNTOOL_FILTER_SQL` is on and a
    // RunTool wrapper is wired, ask SQL to widen the candidate
    // pool to every row whose lowercased Aliases column contains
    // the normalized key as a substring (one round-trip, no
    // pagination). The JS post-filter then narrows to exact
    // alias-token matches via `parseAliases` +
    // `normalizeEntityKey` — same contract as the REST path's
    // `rich_text contains` + post-filter pipeline.
    //
    // `LOWER()` is ASCII-only and Notion's `rich_text contains`
    // is also case-insensitive substring; both surface the same
    // false-positive class (`"User"` matching `"UserService"`),
    // and both rely on the JS post-filter for correctness.
    //
    // SQL pool saturation (cap=100, no JS-confirmed exact match)
    // falls through to REST. A high-cardinality alias like
    // `"User"` stored on >100 entities walks past the cap; the
    // REST paginated path then handles up to the 1000-row
    // budget.
    //
    // Validation errors propagate to the operator (same posture
    // as `findByName`).
    if (isRunToolFilterSqlEnabled()) {
      try {
        const candidates = await fetchEntitiesByAliasSubstring(this.client, {
          dataSourceId: this.db.dataSourceId,
          aliasesProperty: ENTITY_PROPS.ALIASES,
          normalizedAlias: key,
        })
        // SQL ran cleanly to completion (the helper threw
        // `SqlPartialResultError` if `has_more: true`, so reaching
        // here means the gateway returned the full substring pool).
        // The JS post-filter narrows to exact alias-token matches
        // — same shape as the REST `rich_text contains` +
        // post-filter pipeline. Aliases are deliberately
        // non-unique, so a complete pool may surface multiple
        // matches; return them all.
        const matches: Entity[] = []
        const seen = new Set<string>()
        for (const candidate of candidates) {
          const aliases = parseAliases(candidate.rawAliases)
          if (!aliases.some((a) => normalizeEntityKey(a) === key)) continue
          if (seen.has(candidate.pageId)) continue
          seen.add(candidate.pageId)
          const page = await this.client.pages.retrieve({
            page_id: candidate.pageId,
          })
          if (!isActiveEntityPage(page)) continue
          matches.push(await this.pageToEntity(page as PageObjectResponse))
        }
        return matches
      } catch (err) {
        if (isSqlValidationError(err)) throw err
        // Every other failure mode (network / 5xx / 401 / 403 /
        // 429 / `SqlPartialResultError` from a saturated SQL
        // window) falls through to the REST paginated walk.
        // Saturation specifically: aliases are non-unique, so a
        // 100-row SQL window with 3 exact matches may have 5+
        // more on later REST pages — `SqlPartialResultError`
        // routes through here so the REST path's
        // `NAME_LOOKUP_MAX_PAGES` pagination becomes
        // authoritative.
        logRunToolFallback("entity-find-by-alias", err)
      }
    }

    // Paginate up to `NAME_LOOKUP_MAX_PAGES` so a high-cardinality
    // alias like "User" stored on many entities (the very ambiguity
    // case the resolver is trying to surface) doesn't get clipped at
    // page one. Recall hole caught by review on PR #88. Post-filter
    // the substring hits down to exact normalized-key matches so an
    // alias like `MemoryService.create` doesn't match a search for
    // `Service`.
    //
    // Pre-filter on the synchronously-available `Aliases` rich_text
    // cell before calling `pageToEntity`. `pageToEntity` hydrates the
    // `Project` relation and can issue `pages.properties.retrieve`
    // per candidate; hydrating every substring hit collapses the
    // worst case (1000-row scan) into 1000 sequential rate-limited
    // round trips. Unlike `findByName`, this loop accumulates
    // matches across pages rather than returning on the first hit,
    // so the substring pre-filter is what bounds the hydration
    // count to actual exact-key aliases rather than every substring
    // hit on every page. Issue #487.
    const matches: Entity[] = []
    let cursor: string | undefined
    let pagesFetched = 0
    while (true) {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: {
          property: ENTITY_PROPS.ALIASES,
          rich_text: { contains: alias },
        } as QueryDataSourceParameters["filter"],
        page_size: NOTION_MAX_PAGE_SIZE,
        start_cursor: cursor,
      })
      pagesFetched += 1
      const pages = response.results.filter(isActiveEntityPage) as PageObjectResponse[]
      for (const page of pages) {
        const rawAliases = parseAliases(extractRichText(page.properties[ENTITY_PROPS.ALIASES]))
        if (!rawAliases.some((a) => normalizeEntityKey(a) === key)) continue
        matches.push(await this.pageToEntity(page))
      }
      if (!response.has_more || pagesFetched >= NAME_LOOKUP_MAX_PAGES) break
      cursor = response.next_cursor ?? undefined
    }

    return matches
  }

  /**
   * Resolve a free-form input string to a canonical Entity row.
   *
   * - Exact-name match → return; if `options.projectIds` carries new
   *   ids, union them into the existing row's `Project` relation
   *   first.
   * - Alias hit on exactly one entity → return; same union-on-touch
   *   semantics.
   * - Multiple alias hits → return ambiguous; caller decides whether
   *   to surface candidates or pick deterministically. NO project
   *   union — there is no single target.
   * - No match → auto-create unless `autoCreate: false`. New row
   *   carries `options.projectIds` on its `Project` relation.
   *
   * `Name` always matches with priority over `Aliases` so an entity
   * deliberately renamed (its old name moved into `Aliases`) still
   * resolves to itself when the agent uses the new name.
   *
   * The union-on-match semantics close the multi-project case: an
   * entity first auto-created from project A and later touched from a
   * fact scoped to project B accumulates `[A, B]` rather than staying
   * frozen at `[A]`.
   *
   * **Concurrent-create race is benign.** Two parallel `lore-fact
   * action='create'` calls on the same fresh subject can both pass
   * `findByName` / `findByAlias`'s probe miss, both auto-create, and
   * produce two Entity rows under different ids — Notion has no
   * unique-index primitive and the resolver does not lock. Same
   * posture as the documented concurrent-upsert risk on
   * `MemoryService.upsertByTopicKey`. The failure mode is duplicate
   * rows (not data loss); the authoritative collapse is `lore migrate
   * --build-entities`, which groups every fact's subject/object
   * strings by normalized key and re-points each fact's
   * `SubjectEntity` / `ObjectEntity` relation to the canonical row.
   */
  async resolveOrCreateEntity(
    input: string,
    options: ResolveOptions = {}
  ): Promise<EntityResolution> {
    const trimmed = input.trim()
    if (!trimmed) {
      return {
        entity: null,
        ambiguous: false,
        candidates: [],
        created: false,
      }
    }

    const byName = await this.findByName(trimmed)
    if (byName) {
      const merged = options.projectIds?.length
        ? await this.addProjectIds(byName, options.projectIds)
        : byName
      return { entity: merged, ambiguous: false, candidates: [merged], created: false }
    }

    const byAlias = await this.findByAlias(trimmed)
    if (byAlias.length === 1) {
      const merged = options.projectIds?.length
        ? await this.addProjectIds(byAlias[0], options.projectIds)
        : byAlias[0]
      return {
        entity: merged,
        ambiguous: false,
        candidates: [merged],
        created: false,
      }
    }
    if (byAlias.length > 1) {
      // Sort deterministically before returning. Notion's
      // `dataSources.query` result order is not stable across calls,
      // so two consecutive resolves on the same input could otherwise
      // produce different candidate orders — and the operator-facing
      // ambiguity warning text would change between runs. Sort by
      // normalized name first (so `User (auth context)` and `User (db
      // schema)` always land in the same order regardless of which
      // Notion returned first), then by id as a tiebreaker.
      const sorted = [...byAlias].sort((a, b) => {
        const keyDiff = normalizeEntityKey(a.name).localeCompare(
          normalizeEntityKey(b.name)
        )
        if (keyDiff !== 0) return keyDiff
        return a.id.localeCompare(b.id)
      })
      return {
        entity: null,
        ambiguous: true,
        candidates: sorted,
        created: false,
      }
    }

    if (options.autoCreate === false) {
      return {
        entity: null,
        ambiguous: false,
        candidates: [],
        created: false,
      }
    }

    const entity = await this.create({
      name: trimmed,
      aliases: [],
      kind: options.kind,
      projectIds: options.projectIds,
    })
    return {
      entity,
      ambiguous: false,
      candidates: [entity],
      created: true,
    }
  }

  /**
   * Append aliases to an existing entity, deduplicated against the
   * existing list. No-ops when the requested aliases are all already
   * present.
   */
  async addAliases(id: string, aliases: string[]): Promise<Entity> {
    const existing = await this.getById(id)
    const existingKeys = new Set(existing.aliases.map((a) => normalizeEntityKey(a)))
    const newAliases = aliases.filter(
      (a) => a.trim().length > 0 && !existingKeys.has(normalizeEntityKey(a))
    )
    if (newAliases.length === 0) return existing

    const merged = [...existing.aliases, ...newAliases]
    await this.client.pages.update({
      page_id: id,
      properties: buildEntityProps({
        name: existing.name,
        aliases: merged,
      }),
    })

    const updated: Entity = { ...existing, aliases: merged }
    this.invalidateAllKeys(existing)
    this.cacheEntity(updated)
    return updated
  }

  /**
   * Union new project ids into an existing entity's `Project` relation.
   * Mirror of `addAliases`: dedup against the existing list, no-op when
   * every requested id is already present, otherwise issue one
   * `pages.update` writing the merged relation. Used by
   * `resolveOrCreateEntity`'s match branches to grow scope on touch
   * (the multi-project canonical-handle case).
   *
   * Pass an in-memory `existing` snapshot (typically the entity that
   * just came out of `findByName` / `findByAlias`) to skip the
   * `pages.retrieve` round-trip — the resolver already has it. Cache
   * mutates fall through `cacheEntity` so the next lookup sees the
   * unioned ids without paying a Notion read.
   *
   * **No body audit trail.** Unlike `MemoryService.upsertByTopicKey`'s
   * `## Revision N (date)` blocks or `MemoryService.rekeyTopicKey`'s
   * `## Re-keyed (date)` blocks, this helper writes the relation
   * silently and leaves no trace of "this entity was scoped to project
   * B on YYYY-MM-DD because a fact in B referenced it." The Entities
   * DB is a registry, not a document — body fields are reserved for
   * agent-curated descriptions, and stamping a relation-write entry on
   * every fact-create touch would generate audit noise dwarfing the
   * actual content. Deliberate non-decision; if a future operator
   * surface needs this, the right shape is a separate "scope history"
   * column on the Entities DB, not a body block.
   *
   * **`existing.projectIds` is optional on the exported `Entity` type**
   * (preserved across this PR for source-compat with external
   * consumers — see `Entity` JSDoc). Service-internal entities flowing
   * out of `pageToEntity` always carry a populated array, but the
   * `?? []` normalization here means a partially-constructed external
   * Entity (test fixture, adapter mock) doesn't crash the helper.
   */
  async addProjectIds(existing: Entity, projectIds: string[]): Promise<Entity> {
    // Walk via a single Set seeded with the existing list so we drop both
    // ids already on the entity AND duplicates within `projectIds` itself.
    // `filter` alone would keep intra-input duplicates and produce a
    // merged list with repeats — silently breaking the union contract.
    const existingIds = existing.projectIds ?? []
    const seen = new Set(existingIds)
    const fresh: string[] = []
    for (const id of projectIds) {
      if (!id || seen.has(id)) continue
      seen.add(id)
      fresh.push(id)
    }
    if (fresh.length === 0) return existing

    const merged = [...existingIds, ...fresh]
    await this.client.pages.update({
      page_id: existing.id,
      properties: buildEntityProps({
        name: existing.name,
        projectIds: merged,
      }),
    })

    const updated: Entity = { ...existing, projectIds: merged }
    this.invalidateAllKeys(existing)
    this.cacheEntity(updated)
    return updated
  }

  /**
   * Archive an Entity row after its fact relations have been re-pointed by
   * the merge orchestrator. Accepts an existing snapshot so the caller that
   * already fetched the loser does not pay a second retrieve just to evict
   * stale name/alias cache entries.
   */
  async archive(
    entityOrId: Entity | string,
    options: ArchiveEntityOptions = {}
  ): Promise<void> {
    const entity =
      typeof entityOrId === "string"
        ? await this.getById(entityOrId, { includeArchived: true })
        : entityOrId

    this.invalidateAllKeys(entity)

    if (entity.archived) return

    if (options.mergedInto) {
      const mergedAt = options.mergedAt ?? new Date().toISOString().split("T")[0]
      const existing = await this.client.pages.retrieveMarkdown({
        page_id: entity.id,
      })
      const mergeLine =
        `Merged into ${options.mergedInto.name} (${options.mergedInto.id})`
      if (!existing.markdown.includes(mergeLine)) {
        const mergeBlock =
          `## Merged into ${options.mergedInto.name}\n\n` +
          `${mergeLine} on ${mergedAt}.`
        const separator = existing.markdown.trim() ? "\n\n---\n\n" : ""
        const content = `${existing.markdown}${separator}${mergeBlock}`
        await this.client.pages.updateMarkdown({
          page_id: entity.id,
          type: "replace_content_range",
          replace_content_range: {
            content,
            content_range: "full_page",
            allow_deleting_content: true,
          },
        })
      }
    }

    await this.client.pages.update({
      page_id: entity.id,
      archived: true,
    })
  }

  /** Reset the in-process name/alias cache. Used by tests. */
  clearNameCache(): void {
    this.nameCache.clear()
  }

  private cacheEntity(entity: Entity): void {
    const nameKey = normalizeEntityKey(entity.name)
    if (nameKey) this.nameCache.set(nameKey, entity)
    for (const alias of entity.aliases) {
      const aliasKey = normalizeEntityKey(alias)
      if (aliasKey && aliasKey !== nameKey) this.nameCache.set(aliasKey, entity)
    }
  }

  private invalidateAllKeys(entity: Entity): void {
    const nameKey = normalizeEntityKey(entity.name)
    if (nameKey) this.nameCache.delete(nameKey)
    for (const alias of entity.aliases) {
      const aliasKey = normalizeEntityKey(alias)
      if (aliasKey) this.nameCache.delete(aliasKey)
    }
  }

  private async getActiveCachedEntity(key: string): Promise<Entity | null> {
    const cached = this.nameCache.get(key)
    if (!cached) return null

    let page: Awaited<ReturnType<Client["pages"]["retrieve"]>>
    try {
      page = await this.client.pages.retrieve({ page_id: cached.id })
    } catch {
      this.invalidateAllKeys(cached)
      return null
    }
    if (!isFullPage(page) || page.archived) {
      this.invalidateAllKeys(cached)
      return null
    }

    const entity = await this.pageToEntity(page as PageObjectResponse)
    this.invalidateAllKeys(cached)
    this.cacheEntity(entity)

    const activeKeys = [entity.name, ...entity.aliases].map(normalizeEntityKey)
    return activeKeys.includes(key) ? entity : null
  }

  private async pageToEntity(page: PageObjectResponse): Promise<Entity> {
    page = await hydrateRelationProperties(this.client, page, [ENTITY_PROPS.PROJECT])
    const props = page.properties
    const rawKind = extractSelect(props[ENTITY_PROPS.KIND], "")
    const kind = (ENTITY_KINDS as string[]).includes(rawKind)
      ? (rawKind as EntityKind)
      : null

    return {
      id: page.id,
      name: extractTitle(props[ENTITY_PROPS.NAME]),
      aliases: parseAliases(extractRichText(props[ENTITY_PROPS.ALIASES])),
      kind,
      description: extractRichText(props[ENTITY_PROPS.DESCRIPTION]),
      projectIds: extractRelationIds(props[ENTITY_PROPS.PROJECT]),
      archived: page.archived,
    }
  }
}
