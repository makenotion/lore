/**
 * Fact operations — the knowledge graph layer.
 *
 * Facts store entity-relationship triples with temporal validity windows.
 * Example: "AuthMiddleware" --uses--> "JWT" (valid from 2025-01-15)
 */

import type { Client } from "@notionhq/client"
import type { PageObjectResponse, QueryDataSourceParameters } from "@notionhq/client"
import type {
  Fact,
  CreateFactInput,
  FactPredicate,
  FactConfidence,
  DatabaseRef,
} from "../types.js"
import { TRACKING_PREDICATES } from "../types.js"

type QueryFactsOpts = {
  projectId?: string
  includeInvalidated?: boolean
  predicates?: FactPredicate[]
  /**
   * Cap total results. Pagination stops as soon as this is reached.
   * Without a limit, all matching facts are fetched across pages.
   */
  limit?: number
}
import { buildFactProps } from "../notion/schema.js"
import { projectOrUnscopedFilter } from "../notion/filters.js"
import {
  isFullPage,
  extractTitle,
  extractRichText,
  extractSelect,
  extractRelationIds,
  extractDate,
} from "../notion/extractors.js"

export class FactService {
  constructor(
    private client: Client,
    private db: DatabaseRef
  ) {}

  async create(input: CreateFactInput): Promise<Fact> {
    let reviewBy = input.reviewBy
    if (!reviewBy && TRACKING_PREDICATES.includes(input.predicate)) {
      const d = new Date()
      d.setDate(d.getDate() + 7)
      reviewBy = d.toISOString().split("T")[0]
    }

    const page = await this.client.pages.create({
      parent: { type: "database_id", database_id: this.db.databaseId },
      properties: buildFactProps({
        subject: input.subject,
        predicate: input.predicate,
        object: input.object,
        projectIds: input.projectIds,
        validFrom: input.validFrom ?? new Date().toISOString().split("T")[0],
        reviewBy,
        sourceMemoryId: input.sourceMemoryId,
        confidence: input.confidence ?? "certain",
      }),
    })

    return this.pageToFact(page as PageObjectResponse)
  }

  async queryBySubject(
    subject: string,
    opts?: QueryFactsOpts,
  ): Promise<Fact[]> {
    const filters: Array<Record<string, unknown>> = []

    // Allow empty subject to list all facts in scope
    if (subject) {
      filters.push({ property: "Subject", title: { contains: subject } })
    }

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }

    if (!opts?.includeInvalidated) {
      filters.push({
        property: "Valid Until",
        date: { is_empty: true },
      })
    }

    if (opts?.predicates?.length) {
      if (opts.predicates.length === 1) {
        filters.push({
          property: "Predicate",
          select: { equals: opts.predicates[0] },
        })
      } else {
        filters.push({
          or: opts.predicates.map((p) => ({
            property: "Predicate",
            select: { equals: p },
          })),
        })
      }
    }

    const filter =
      filters.length > 1
        ? { and: filters }
        : filters.length === 1
          ? filters[0]
          : undefined

    const results: PageObjectResponse[] = []
    let cursor: string | undefined = undefined
    const limit = opts?.limit
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: 100,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
        results.push(page)
        if (limit !== undefined && results.length >= limit) break
      }
      if (limit !== undefined && results.length >= limit) break
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined
    } while (cursor)

    return results.map((p) => this.pageToFact(p))
  }

  async queryByObject(
    object: string,
    opts?: QueryFactsOpts,
  ): Promise<Fact[]> {
    const filters: Array<Record<string, unknown>> = []

    if (object) {
      filters.push({ property: "Object", rich_text: { contains: object } })
    }

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }

    if (!opts?.includeInvalidated) {
      filters.push({
        property: "Valid Until",
        date: { is_empty: true },
      })
    }

    if (opts?.predicates?.length) {
      if (opts.predicates.length === 1) {
        filters.push({
          property: "Predicate",
          select: { equals: opts.predicates[0] },
        })
      } else {
        filters.push({
          or: opts.predicates.map((p) => ({
            property: "Predicate",
            select: { equals: p },
          })),
        })
      }
    }

    const filter =
      filters.length > 1
        ? { and: filters }
        : filters.length === 1
          ? filters[0]
          : undefined

    const results: PageObjectResponse[] = []
    let cursor: string | undefined = undefined
    const limit = opts?.limit
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: 100,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
        results.push(page)
        if (limit !== undefined && results.length >= limit) break
      }
      if (limit !== undefined && results.length >= limit) break
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined
    } while (cursor)

    return results.map((p) => this.pageToFact(p))
  }

  async queryBySourceMemory(
    sourceMemoryId: string,
    opts?: QueryFactsOpts,
  ): Promise<Fact[]> {
    const filters: Array<Record<string, unknown>> = [
      {
        property: "Source",
        relation: { contains: sourceMemoryId },
      },
    ]

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }

    if (!opts?.includeInvalidated) {
      filters.push({
        property: "Valid Until",
        date: { is_empty: true },
      })
    }

    if (opts?.predicates?.length) {
      if (opts.predicates.length === 1) {
        filters.push({
          property: "Predicate",
          select: { equals: opts.predicates[0] },
        })
      } else {
        filters.push({
          or: opts.predicates.map((p) => ({
            property: "Predicate",
            select: { equals: p },
          })),
        })
      }
    }

    const filter = filters.length > 1 ? { and: filters } : filters[0]

    const results: PageObjectResponse[] = []
    let cursor: string | undefined = undefined
    const limit = opts?.limit
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: 100,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
        results.push(page)
        if (limit !== undefined && results.length >= limit) break
      }
      if (limit !== undefined && results.length >= limit) break
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined
    } while (cursor)

    return results.map((p) => this.pageToFact(p))
  }

  async queryByEntity(entity: string, opts?: { projectId?: string }): Promise<Fact[]> {
    const asSubject = await this.queryBySubject(entity, opts)

    const asObject = await this.queryByObject(entity, opts)

    const seen = new Set(asSubject.map((f) => f.id))
    return [...asSubject, ...asObject.filter((f) => !seen.has(f.id))]
  }

  async queryOverdue(opts?: { projectId?: string }): Promise<Fact[]> {
    const today = new Date().toISOString().split("T")[0]
    const filters: Array<Record<string, unknown>> = [
      { property: "Review By", date: { on_or_before: today } },
      { property: "Valid Until", date: { is_empty: true } },
    ]

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }

    const response = await this.client.dataSources.query({
      data_source_id: this.db.dataSourceId,
      filter: { and: filters } as QueryDataSourceParameters["filter"],
      sorts: [{ property: "Review By", direction: "ascending" }],
    })

    return (response.results.filter(isFullPage) as PageObjectResponse[]).map((p) =>
      this.pageToFact(p)
    )
  }

  async extendReview(id: string, reviewBy: string): Promise<void> {
    await this.client.pages.update({
      page_id: id,
      properties: {
        "Review By": { date: { start: reviewBy } },
      },
    })
  }

  async invalidate(id: string): Promise<void> {
    await this.client.pages.update({
      page_id: id,
      properties: {
        "Valid Until": {
          date: { start: new Date().toISOString().split("T")[0] },
        },
      },
    })
  }

  private pageToFact(page: PageObjectResponse): Fact {
    const props = page.properties
    const sourceIds = extractRelationIds(props["Source"])

    return {
      id: page.id,
      subject: extractTitle(props["Subject"]),
      predicate: extractSelect(props["Predicate"], "related_to") as FactPredicate,
      object: extractRichText(props["Object"]),
      projectIds: extractRelationIds(props["Project"]),
      validFrom: extractDate(props["Valid From"]),
      validUntil: extractDate(props["Valid Until"]),
      reviewBy: extractDate(props["Review By"]),
      sourceMemoryId: sourceIds[0] ?? null,
      confidence: extractSelect(props["Confidence"], "certain") as FactConfidence,
    }
  }
}
