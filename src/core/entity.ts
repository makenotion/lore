/**
 * Entity CRUD + canonical-resolution helpers.
 *
 * The Entities DB (PF3-01) is the canonical-handle registry that
 * `FactService` joins against via `SubjectEntity` / `ObjectEntity`
 * relations. `lore-fact action='create'`, `lore-ask`, and the
 * `--build-entities` migration all funnel through `resolveOrCreateEntity`
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
import type {
  PageObjectResponse,
  QueryDataSourceParameters,
} from "@notionhq/client"
import type {
  CreateEntityInput,
  DatabaseRef,
  Entity,
  EntityKind,
  EntityResolution,
} from "../types.js"
import { ENTITY_KINDS } from "../types.js"
import { buildEntityProps } from "../notion/schema.js"
import { computeSubjectKey } from "../notion/normalize.js"
import {
  isFullPage,
  extractTitle,
  extractRichText,
  extractSelect,
} from "../notion/extractors.js"
import { LruCache } from "./cache.js"

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
  /** Optional project scope to attach to a freshly-created Entity. */
  projectIds?: string[]
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
 * — not a sweep across every caller of `lore-task` action='list'
 * that does its own ad-hoc string composition. The `lore-ask` task
 * recall path is the canonical caller; future surfaces should reuse
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
  cap = ENTITY_QUERY_VARIANT_CAP,
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
      }),
    })

    const entity = this.pageToEntity(page as PageObjectResponse)
    // Drop any stale negative-lookup entry under either the name or any
    // alias key so the freshly-created row is reachable on the next
    // resolve.
    this.invalidateAllKeys(entity)
    this.cacheEntity(entity)
    return entity
  }

  async getById(id: string): Promise<Entity> {
    const page = await this.client.pages.retrieve({ page_id: id })
    return this.pageToEntity(page as PageObjectResponse)
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
        sorts: [{ property: "Name", direction: "ascending" }],
        page_size: NOTION_MAX_PAGE_SIZE,
        start_cursor: cursor,
      })
      results.push(
        ...(response.results.filter(isFullPage) as PageObjectResponse[])
      )
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined
    } while (cursor)

    return results.map((p) => this.pageToEntity(p))
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

    const cached = this.nameCache.get(key)
    if (cached) return cached

    return this.nameCache.getOrLoad(key, async () => {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: {
          property: "Name",
          title: { equals: name },
        } as QueryDataSourceParameters["filter"],
        page_size: 5,
      })

      const pages = response.results.filter(isFullPage) as PageObjectResponse[]
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
        let cursor: string | undefined
        let pagesFetched = 0
        while (true) {
          const fallback = await this.client.dataSources.query({
            data_source_id: this.db.dataSourceId,
            filter: {
              property: "Name",
              title: { contains: name },
            } as QueryDataSourceParameters["filter"],
            page_size: NOTION_MAX_PAGE_SIZE,
            start_cursor: cursor,
          })
          pagesFetched += 1
          const fallbackPages = fallback.results.filter(isFullPage) as PageObjectResponse[]
          for (const page of fallbackPages) {
            const entity = this.pageToEntity(page)
            if (normalizeEntityKey(entity.name) === key) return entity
          }
          if (!fallback.has_more || pagesFetched >= NAME_LOOKUP_MAX_PAGES) {
            return null
          }
          cursor = fallback.next_cursor ?? undefined
        }
      }

      return this.pageToEntity(pages[0])
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

    // Paginate up to `NAME_LOOKUP_MAX_PAGES` so a high-cardinality
    // alias like "User" stored on many entities (the very ambiguity
    // case the resolver is trying to surface) doesn't get clipped at
    // page one. Recall hole caught by review on PR #88. Post-filter
    // the substring hits down to exact normalized-key matches so an
    // alias like `MemoryService.create` doesn't match a search for
    // `Service`.
    const matches: Entity[] = []
    let cursor: string | undefined
    let pagesFetched = 0
    while (true) {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: {
          property: "Aliases",
          rich_text: { contains: alias },
        } as QueryDataSourceParameters["filter"],
        page_size: NOTION_MAX_PAGE_SIZE,
        start_cursor: cursor,
      })
      pagesFetched += 1
      const pages = response.results.filter(isFullPage) as PageObjectResponse[]
      for (const page of pages) {
        const entity = this.pageToEntity(page)
        if (entity.aliases.some((a) => normalizeEntityKey(a) === key)) {
          matches.push(entity)
        }
      }
      if (!response.has_more || pagesFetched >= NAME_LOOKUP_MAX_PAGES) break
      cursor = response.next_cursor ?? undefined
    }

    return matches
  }

  /**
   * Resolve a free-form input string to a canonical Entity row.
   *
   * - Exact-name match → return.
   * - Alias hit on exactly one entity → return.
   * - Multiple alias hits → return ambiguous; caller decides whether
   *   to surface candidates or pick deterministically.
   * - No match → auto-create unless `autoCreate: false`.
   *
   * `Name` always matches with priority over `Aliases` so an entity
   * deliberately renamed (its old name moved into `Aliases`) still
   * resolves to itself when the agent uses the new name.
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
      return { entity: byName, ambiguous: false, candidates: [byName], created: false }
    }

    const byAlias = await this.findByAlias(trimmed)
    if (byAlias.length === 1) {
      return {
        entity: byAlias[0],
        ambiguous: false,
        candidates: byAlias,
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
          normalizeEntityKey(b.name),
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
    const existingKeys = new Set(
      existing.aliases.map((a) => normalizeEntityKey(a))
    )
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

  // `merge(winnerId, loserId)` was drafted on this branch but pulled
  // before merge: it requires a `FactService.repointEntity` helper to
  // re-point facts referencing the loser before the loser is archived,
  // and that helper is not in this PR. Shipping `merge` without the
  // re-point step would silently strand the loser's facts on a deleted
  // row. The follow-up issue tracking the operator-driven entity
  // consolidation surface will land both pieces together. For now,
  // operators can manually merge by editing the canonical's `Aliases`
  // in Notion and archiving the loser; downstream `lore-ask` calls
  // resolve via `findByName` / `findByAlias` against the canonical.
  // Removed per PR #88 review.
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

  private pageToEntity(page: PageObjectResponse): Entity {
    const props = page.properties
    const rawKind = extractSelect(props["Kind"], "")
    const kind = (ENTITY_KINDS as string[]).includes(rawKind)
      ? (rawKind as EntityKind)
      : null

    return {
      id: page.id,
      name: extractTitle(props["Name"]),
      aliases: parseAliases(extractRichText(props["Aliases"])),
      kind,
      description: extractRichText(props["Description"]),
    }
  }
}
