/**
 * Read/query collaborator for the Facts data source.
 *
 * FactService owns writes, deduplication, invalidation, and entity merge
 * maintenance. This class owns read-side filter construction, pagination,
 * scope filtering, and raw preflight counts.
 */

import type {
  Client,
  PageObjectResponse,
  QueryDataSourceParameters,
} from "@notionhq/client"
import type { DatabaseRef, Fact, FactPredicate, MemoryScopeContext } from "../types.js"
import { FACT_PROPS } from "../notion/schema.js"
import {
  FACT_SCOPE_PROPS,
  projectOrUnscopedFilter,
  withDefaultScopeFilter,
} from "../notion/filters.js"
import { isMissingPropertyError } from "../notion/errors.js"
import { computeSubjectKey } from "../notion/normalize.js"
import { isFullPage, isLiveFullPage } from "../notion/extractors.js"
import { pageToFact, pageToFacts } from "./fact-mapper.js"
import { matchesDefaultScope } from "./memory-scope.js"
import { todayUtc } from "./task.js"

export type QueryFactsOpts = {
  projectId?: string
  includeInvalidated?: boolean
  predicates?: FactPredicate[]
  /**
   * Transaction-time as-of cutoff in `YYYY-MM-DD` form. When
   * set, the read returns the slice of facts Lore knew about at `asOf`
   * (Observed At <= asOf) and had not yet invalidated by `asOf`
   * (Invalidated At is empty or > asOf). Empty Observed At rows stay
   * visible during the transaction-time backfill window.
   */
  asOf?: string
  /**
   * Cap total results. Pagination stops as soon as this is reached.
   * Without a limit, all matching facts are fetched across pages.
   */
  limit?: number
  /**
   * Opt into the "list every fact in scope" branch when the subject /
   * object argument is strict-empty (`""`).
   */
  allowUnfiltered?: boolean
  /**
   * Skip default scope filtering and expired-row exclusion.
   */
  includeOutOfScope?: boolean
}

export type ListRecentOpts = {
  projectId?: string
  /**
   * Maximum rows returned. This query is single-page by design and the
   * value is clamped to Notion's 100-row ceiling.
   */
  limit?: number
  includeInvalidated?: boolean
  /**
   * Skip default scope filtering and expired-row exclusion.
   */
  includeOutOfScope?: boolean
}

export type QueryByEntityOpts = {
  projectId?: string
  entityId?: string | null
  predicates?: FactPredicate[]
  /**
   * Cap total results returned to the caller. Forwarded into both
   * underlying branches and applied again after deduplication.
   */
  limit?: number
  /**
   * Skip default scope filtering and expired-row exclusion.
   */
  includeOutOfScope?: boolean
  /**
   * Transaction-time as-of cutoff in `YYYY-MM-DD` form.
   */
  asOf?: string
  /**
   * Include invalidated rows alongside live rows.
   */
  includeInvalidated?: boolean
}

export type QueryOverdueOpts = {
  projectId?: string
  limit?: number
  /**
   * Skip default scope filtering and expired-row exclusion.
   */
  includeOutOfScope?: boolean
}

type FactQueriesDeps = {
  client: Client
  db: DatabaseRef
  scopeCtx?: MemoryScopeContext
}

/** Notion's hard ceiling on `page_size`. */
export const NOTION_MAX_PAGE_SIZE = 100

/**
 * Clamp a caller-supplied `limit` to a Notion-safe `page_size`.
 */
export function clampNotionPageSize(limit: number | undefined): number {
  if (limit === undefined) return NOTION_MAX_PAGE_SIZE
  return Math.min(Math.max(limit, 1), NOTION_MAX_PAGE_SIZE)
}

function predicateFilterClause(
  predicates: FactPredicate[] | undefined
): Record<string, unknown> | undefined {
  if (!predicates?.length) return undefined
  if (predicates.length === 1) {
    return {
      property: FACT_PROPS.PREDICATE,
      select: { equals: predicates[0] },
    }
  }
  return {
    or: predicates.map((p) => ({
      property: FACT_PROPS.PREDICATE,
      select: { equals: p },
    })),
  }
}

function asOfFilterClauses(
  asOf: string,
  opts: { includeInvalidated?: boolean } = {}
): Array<Record<string, unknown>> {
  const clauses: Array<Record<string, unknown>> = [
    {
      or: [
        { property: FACT_PROPS.OBSERVED_AT, date: { is_empty: true } },
        { property: FACT_PROPS.OBSERVED_AT, date: { on_or_before: asOf } },
      ],
    },
  ]

  if (!opts.includeInvalidated) {
    clauses.push({
      or: [
        {
          and: [
            { property: FACT_PROPS.INVALIDATED_AT, date: { is_empty: true } },
            {
              or: [
                { property: FACT_PROPS.VALID_UNTIL, date: { is_empty: true } },
                { property: FACT_PROPS.VALID_UNTIL, date: { after: asOf } },
              ],
            },
          ],
        },
        { property: FACT_PROPS.INVALIDATED_AT, date: { after: asOf } },
      ],
    })
  }
  return clauses
}

function pushLiveOrAsOfClauses(
  filters: Array<Record<string, unknown>>,
  opts: { asOf?: string; includeInvalidated?: boolean } | undefined
): void {
  if (opts?.asOf) {
    filters.push(
      ...asOfFilterClauses(opts.asOf, {
        includeInvalidated: opts.includeInvalidated,
      })
    )
  } else if (!opts?.includeInvalidated) {
    filters.push({
      property: FACT_PROPS.VALID_UNTIL,
      date: { is_empty: true },
    })
  }
}

export class FactQueries {
  private scopeCtx: MemoryScopeContext = {}
  private scopeFilterEnabled = false

  constructor(private deps: FactQueriesDeps) {
    if (deps.scopeCtx) {
      this.scopeCtx = deps.scopeCtx
      this.scopeFilterEnabled = true
    }
  }

  setScopeContext(ctx: MemoryScopeContext): void {
    this.scopeCtx = ctx
    this.scopeFilterEnabled = true
  }

  getScopeContext(): Readonly<MemoryScopeContext> {
    return this.scopeCtx
  }

  async getById(id: string): Promise<Fact | null> {
    const page = await this.deps.client.pages.retrieve({ page_id: id })
    if (!isLiveFullPage(page)) return null
    return await pageToFact(this.deps.client, page)
  }

  async queryBySubject(subject: string, opts?: QueryFactsOpts): Promise<Fact[]> {
    if (subject === "" && !opts?.allowUnfiltered) return []

    const filters: Array<Record<string, unknown>> = []

    if (subject) {
      const normalizedKey = computeSubjectKey(subject)
      if (normalizedKey) {
        filters.push({
          or: [
            {
              property: FACT_PROPS.SUBJECT_KEY,
              rich_text: { contains: normalizedKey },
            },
            { property: FACT_PROPS.SUBJECT, title: { contains: subject } },
          ],
        })
      } else {
        filters.push({ property: FACT_PROPS.SUBJECT, title: { contains: subject } })
      }
    }

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId, FACT_PROPS.PROJECT))
    }

    pushLiveOrAsOfClauses(filters, opts)

    const predicateClause = predicateFilterClause(opts?.predicates)
    if (predicateClause) filters.push(predicateClause)

    const baseFilter =
      filters.length > 1
        ? { and: filters }
        : filters.length === 1
          ? filters[0]
          : undefined
    const filter = this.applyDefaultScope(baseFilter, opts?.includeOutOfScope)
    const postScopePredicate = this.postScopeFilterPredicate(opts?.includeOutOfScope)

    const results: PageObjectResponse[] = []
    let cursor: string | undefined = undefined
    const limit = opts?.limit
    const pageSize = clampNotionPageSize(limit)
    do {
      const response = await this.deps.client.dataSources.query({
        data_source_id: this.deps.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: pageSize,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
        if (postScopePredicate && !postScopePredicate(page)) continue
        results.push(page)
        if (limit !== undefined && results.length >= limit) break
      }
      if (limit !== undefined && results.length >= limit) break
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)

    return await pageToFacts(this.deps.client, results)
  }

  async queryByObject(object: string, opts?: QueryFactsOpts): Promise<Fact[]> {
    if (object === "" && !opts?.allowUnfiltered) return []

    const filters: Array<Record<string, unknown>> = []

    if (object) {
      filters.push({ property: FACT_PROPS.OBJECT, rich_text: { contains: object } })
    }

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId, FACT_PROPS.PROJECT))
    }

    pushLiveOrAsOfClauses(filters, opts)

    const predicateClause = predicateFilterClause(opts?.predicates)
    if (predicateClause) filters.push(predicateClause)

    const baseFilter =
      filters.length > 1
        ? { and: filters }
        : filters.length === 1
          ? filters[0]
          : undefined
    const filter = this.applyDefaultScope(baseFilter, opts?.includeOutOfScope)
    const postScopePredicate = this.postScopeFilterPredicate(opts?.includeOutOfScope)

    const results: PageObjectResponse[] = []
    let cursor: string | undefined = undefined
    const limit = opts?.limit
    const pageSize = clampNotionPageSize(limit)
    do {
      const response = await this.deps.client.dataSources.query({
        data_source_id: this.deps.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: pageSize,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
        if (postScopePredicate && !postScopePredicate(page)) continue
        results.push(page)
        if (limit !== undefined && results.length >= limit) break
      }
      if (limit !== undefined && results.length >= limit) break
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)

    return await pageToFacts(this.deps.client, results)
  }

  async queryBySourceMemory(
    sourceMemoryId: string,
    opts?: QueryFactsOpts
  ): Promise<Fact[]> {
    const filters: Array<Record<string, unknown>> = [
      {
        property: FACT_PROPS.SOURCE,
        relation: { contains: sourceMemoryId },
      },
    ]

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId, FACT_PROPS.PROJECT))
    }

    if (!opts?.includeInvalidated) {
      filters.push({
        property: FACT_PROPS.VALID_UNTIL,
        date: { is_empty: true },
      })
    }

    const predicateClause = predicateFilterClause(opts?.predicates)
    if (predicateClause) filters.push(predicateClause)

    const baseFilter = filters.length > 1 ? { and: filters } : filters[0]
    const filter = this.applyDefaultScope(baseFilter, opts?.includeOutOfScope)
    const postScopePredicate = this.postScopeFilterPredicate(opts?.includeOutOfScope)

    const results: PageObjectResponse[] = []
    let cursor: string | undefined = undefined
    const limit = opts?.limit
    const pageSize = clampNotionPageSize(limit)
    do {
      const response = await this.deps.client.dataSources.query({
        data_source_id: this.deps.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: pageSize,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
        if (postScopePredicate && !postScopePredicate(page)) continue
        results.push(page)
        if (limit !== undefined && results.length >= limit) break
      }
      if (limit !== undefined && results.length >= limit) break
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)

    return await pageToFacts(this.deps.client, results)
  }

  async listRecent(
    opts: ListRecentOpts = {}
  ): Promise<{ items: Fact[]; hasMore: boolean }> {
    const filters: Array<Record<string, unknown>> = []

    if (opts.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId, FACT_PROPS.PROJECT))
    }

    if (!opts.includeInvalidated) {
      filters.push({
        property: FACT_PROPS.VALID_UNTIL,
        date: { is_empty: true },
      })
    }

    const baseFilter =
      filters.length > 1
        ? { and: filters }
        : filters.length === 1
          ? filters[0]
          : undefined
    const filter =
      opts.includeOutOfScope === true || !this.scopeFilterEnabled
        ? baseFilter
        : withDefaultScopeFilter(baseFilter, this.scopeCtx, todayUtc(), FACT_SCOPE_PROPS)

    const pageSize = clampNotionPageSize(opts.limit)

    const response = await this.deps.client.dataSources.query({
      data_source_id: this.deps.db.dataSourceId,
      filter: filter as QueryDataSourceParameters["filter"],
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: pageSize,
    })

    let pages = response.results.filter(isFullPage) as PageObjectResponse[]
    const postScopePredicate = this.postScopeFilterPredicate(opts.includeOutOfScope)
    if (postScopePredicate) {
      pages = pages.filter(postScopePredicate)
    }
    return {
      items: await pageToFacts(this.deps.client, pages),
      hasMore: response.has_more ?? false,
    }
  }

  async queryByEntity(entity: string, opts?: QueryByEntityOpts): Promise<Fact[]> {
    if (!entity.trim()) return []

    const limit = opts?.limit
    const sliceToLimit = (rows: Fact[]): Fact[] =>
      limit !== undefined ? rows.slice(0, limit) : rows

    if (opts?.entityId) {
      const [byRelation, byTextOnUnmigrated] = await Promise.all([
        this.queryByEntityId(opts.entityId, {
          projectId: opts.projectId,
          predicates: opts.predicates,
          limit,
          includeOutOfScope: opts.includeOutOfScope,
          asOf: opts.asOf,
          includeInvalidated: opts.includeInvalidated,
        }),
        this.queryByEntityTextOnUnmigrated(entity, {
          projectId: opts.projectId,
          predicates: opts.predicates,
          limit,
          includeOutOfScope: opts.includeOutOfScope,
          asOf: opts.asOf,
          includeInvalidated: opts.includeInvalidated,
        }),
      ])
      const seen = new Set(byRelation.map((f) => f.id))
      return sliceToLimit([
        ...byRelation,
        ...byTextOnUnmigrated.filter((f) => !seen.has(f.id)),
      ])
    }

    const asSubject = await this.queryBySubject(entity, opts)
    const asObject = await this.queryByObject(entity, opts)
    const seen = new Set(asSubject.map((f) => f.id))
    return sliceToLimit([...asSubject, ...asObject.filter((f) => !seen.has(f.id))])
  }

  async queryOrphans(opts?: { projectId?: string; limit?: number }): Promise<Fact[]> {
    const filters: Array<Record<string, unknown>> = [
      { property: FACT_PROPS.SOURCE, relation: { is_empty: true } },
      { property: FACT_PROPS.VALID_UNTIL, date: { is_empty: true } },
    ]

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId, FACT_PROPS.PROJECT))
    }

    const limit = opts?.limit
    const results: PageObjectResponse[] = []
    let cursor: string | undefined = undefined
    do {
      const pageSize =
        limit !== undefined ? Math.min(100, Math.max(1, limit - results.length)) : 100
      const response = await this.deps.client.dataSources.query({
        data_source_id: this.deps.db.dataSourceId,
        filter: { and: filters } as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: pageSize,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
        results.push(page)
        if (limit !== undefined && results.length >= limit) break
      }
      if (limit !== undefined && results.length >= limit) break
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)

    return await pageToFacts(this.deps.client, results)
  }

  async queryOverdue(opts?: QueryOverdueOpts): Promise<Fact[]> {
    const today = new Date().toISOString().split("T")[0]
    const filters: Array<Record<string, unknown>> = [
      { property: FACT_PROPS.REVIEW_BY, date: { on_or_before: today } },
      { property: FACT_PROPS.VALID_UNTIL, date: { is_empty: true } },
    ]

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId, FACT_PROPS.PROJECT))
    }

    const baseFilter = { and: filters }
    const filter = this.applyDefaultScope(baseFilter, opts?.includeOutOfScope)
    const postScopePredicate = this.postScopeFilterPredicate(opts?.includeOutOfScope)

    const limit = opts?.limit
    const items: Fact[] = []
    let cursor: string | undefined = undefined
    do {
      const response = await this.deps.client.dataSources.query({
        data_source_id: this.deps.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ property: FACT_PROPS.REVIEW_BY, direction: "ascending" }],
        page_size: Math.min(limit ?? NOTION_MAX_PAGE_SIZE, NOTION_MAX_PAGE_SIZE),
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
        if (postScopePredicate && !postScopePredicate(page)) continue
        const fact = await pageToFact(this.deps.client, page)
        if (fact === null) continue
        items.push(fact)
        if (limit !== undefined && items.length >= limit) break
      }
      if (limit !== undefined && items.length >= limit) break
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)

    return items
  }

  async countByPredicateRaw(strings: string[]): Promise<number> {
    if (strings.length === 0) return 0

    const predicateClause: Record<string, unknown> =
      strings.length === 1
        ? { property: FACT_PROPS.PREDICATE, select: { equals: strings[0] } }
        : {
            or: strings.map((p) => ({
              property: FACT_PROPS.PREDICATE,
              select: { equals: p },
            })),
          }

    const filter = {
      and: [
        { property: FACT_PROPS.VALID_UNTIL, date: { is_empty: true } },
        predicateClause,
      ],
    }

    let count = 0
    let cursor: string | undefined = undefined
    do {
      const response = await this.deps.client.dataSources.query({
        data_source_id: this.deps.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        page_size: NOTION_MAX_PAGE_SIZE,
        start_cursor: cursor,
      })
      count += response.results.length
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)

    return count
  }

  private async queryByEntityId(
    entityId: string,
    opts?: {
      projectId?: string
      includeInvalidated?: boolean
      predicates?: FactPredicate[]
      limit?: number
      includeOutOfScope?: boolean
      asOf?: string
    }
  ): Promise<Fact[]> {
    const filters: Array<Record<string, unknown>> = [
      {
        or: [
          { property: FACT_PROPS.SUBJECT_ENTITY, relation: { contains: entityId } },
          { property: FACT_PROPS.OBJECT_ENTITY, relation: { contains: entityId } },
        ],
      },
    ]

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId, FACT_PROPS.PROJECT))
    }
    pushLiveOrAsOfClauses(filters, opts)

    const predicateClause = predicateFilterClause(opts?.predicates)
    if (predicateClause) filters.push(predicateClause)

    const baseFilter = filters.length > 1 ? { and: filters } : filters[0]
    const filter = this.applyDefaultScope(baseFilter, opts?.includeOutOfScope)
    const postScopePredicate = this.postScopeFilterPredicate(opts?.includeOutOfScope)
    const results: PageObjectResponse[] = []
    let cursor: string | undefined = undefined
    const limit = opts?.limit
    const pageSize = clampNotionPageSize(limit)
    do {
      const response = await this.deps.client.dataSources.query({
        data_source_id: this.deps.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: pageSize,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
        if (postScopePredicate && !postScopePredicate(page)) continue
        results.push(page)
        if (limit !== undefined && results.length >= limit) break
      }
      if (limit !== undefined && results.length >= limit) break
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)

    return await pageToFacts(this.deps.client, results)
  }

  private async queryByEntityTextOnUnmigrated(
    entity: string,
    opts?: {
      projectId?: string
      predicates?: FactPredicate[]
      limit?: number
      includeOutOfScope?: boolean
      asOf?: string
      includeInvalidated?: boolean
    }
  ): Promise<Fact[]> {
    if (!entity.trim()) return []

    const baseFilters: Array<Record<string, unknown>> = [
      { property: FACT_PROPS.SUBJECT_ENTITY, relation: { is_empty: true } },
      { property: FACT_PROPS.OBJECT_ENTITY, relation: { is_empty: true } },
    ]
    pushLiveOrAsOfClauses(baseFilters, opts)
    if (opts?.projectId) {
      baseFilters.push(projectOrUnscopedFilter(opts.projectId, FACT_PROPS.PROJECT))
    }

    const predicateClause = predicateFilterClause(opts?.predicates)
    if (predicateClause) baseFilters.push(predicateClause)

    const subjectKey = computeSubjectKey(entity)
    const textOr: Array<Record<string, unknown>> = []
    if (subjectKey) {
      textOr.push({
        property: FACT_PROPS.SUBJECT_KEY,
        rich_text: { contains: subjectKey },
      })
    }
    textOr.push(
      { property: FACT_PROPS.SUBJECT, title: { contains: entity } },
      { property: FACT_PROPS.OBJECT, rich_text: { contains: entity } }
    )
    baseFilters.push({ or: textOr })

    const scopedFilter = this.applyDefaultScope(
      { and: baseFilters },
      opts?.includeOutOfScope
    )
    const postScopePredicate = this.postScopeFilterPredicate(opts?.includeOutOfScope)

    try {
      const results: PageObjectResponse[] = []
      let cursor: string | undefined = undefined
      const limit = opts?.limit
      const pageSize = clampNotionPageSize(limit)
      do {
        const response = await this.deps.client.dataSources.query({
          data_source_id: this.deps.db.dataSourceId,
          filter: scopedFilter as QueryDataSourceParameters["filter"],
          sorts: [{ timestamp: "created_time", direction: "descending" }],
          page_size: pageSize,
          start_cursor: cursor,
        })
        for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
          if (postScopePredicate && !postScopePredicate(page)) continue
          results.push(page)
          if (limit !== undefined && results.length >= limit) break
        }
        if (limit !== undefined && results.length >= limit) break
        cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
      } while (cursor)
      return await pageToFacts(this.deps.client, results)
    } catch (err) {
      if (isMissingPropertyError(err)) {
        return []
      }
      throw err
    }
  }

  private applyDefaultScope(
    filter: Record<string, unknown> | undefined,
    includeOutOfScope: boolean | undefined
  ): Record<string, unknown> | undefined {
    if (includeOutOfScope === true || !this.scopeFilterEnabled) return filter
    return withDefaultScopeFilter(filter, this.scopeCtx, todayUtc(), FACT_SCOPE_PROPS)
  }

  private postScopeFilterPredicate(
    includeOutOfScope: boolean | undefined
  ): ((page: PageObjectResponse) => boolean) | undefined {
    if (includeOutOfScope === true || !this.scopeFilterEnabled) return undefined
    const today = todayUtc()
    const ctx = this.scopeCtx
    return (page) => matchesDefaultScope(page.properties, ctx, today, FACT_SCOPE_PROPS)
  }
}
