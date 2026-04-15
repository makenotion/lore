/**
 * Fact operations — the knowledge graph layer.
 *
 * Facts store entity-relationship triples with temporal validity windows.
 * Example: "AuthMiddleware" --uses--> "JWT" (valid from 2025-01-15)
 */

import type { Client } from "@notionhq/client"
import type { PageObjectResponse, QueryDataSourceParameters } from "@notionhq/client"
import type { Fact, CreateFactInput, FactPredicate, FactConfidence, DatabaseRef } from "../types.js"
import { buildFactProps } from "../notion/schema.js"
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
    const page = await this.client.pages.create({
      parent: { type: "database_id", database_id: this.db.databaseId },
      properties: buildFactProps({
        subject: input.subject,
        predicate: input.predicate,
        object: input.object,
        projectId: input.projectId,
        validFrom: input.validFrom ?? new Date().toISOString().split("T")[0],
        sourceMemoryId: input.sourceMemoryId,
        confidence: input.confidence ?? "certain",
      }),
    })

    return this.pageToFact(page as PageObjectResponse)
  }

  async queryBySubject(
    subject: string,
    opts?: { projectId?: string; includeInvalidated?: boolean }
  ): Promise<Fact[]> {
    const filters: Array<Record<string, unknown>> = []

    // Allow empty subject to list all facts in scope
    if (subject) {
      filters.push({ property: "Subject", title: { contains: subject } })
    }

    if (opts?.projectId) {
      filters.push({
        property: "Project",
        relation: { contains: opts.projectId },
      })
    }

    if (!opts?.includeInvalidated) {
      filters.push({
        property: "Valid Until",
        date: { is_empty: true },
      })
    }

    const filter =
      filters.length > 1
        ? { and: filters }
        : filters.length === 1
          ? filters[0]
          : undefined

    const response = await this.client.dataSources.query({
      data_source_id: this.db.dataSourceId,
      filter: filter as QueryDataSourceParameters["filter"],
      sorts: [{ timestamp: "created_time", direction: "descending" }],
    })

    return (response.results.filter(isFullPage) as PageObjectResponse[]).map((p) =>
      this.pageToFact(p)
    )
  }

  async queryByEntity(entity: string, opts?: { projectId?: string }): Promise<Fact[]> {
    const asSubject = await this.queryBySubject(entity, opts)

    const objectFilters: Array<Record<string, unknown>> = [
      { property: "Object", rich_text: { contains: entity } },
      { property: "Valid Until", date: { is_empty: true } },
    ]
    if (opts?.projectId) {
      objectFilters.push({
        property: "Project",
        relation: { contains: opts.projectId },
      })
    }

    const response = await this.client.dataSources.query({
      data_source_id: this.db.dataSourceId,
      filter: { and: objectFilters } as QueryDataSourceParameters["filter"],
    })

    const asObject = (response.results.filter(isFullPage) as PageObjectResponse[]).map(
      (p) => this.pageToFact(p)
    )

    const seen = new Set(asSubject.map((f) => f.id))
    return [...asSubject, ...asObject.filter((f) => !seen.has(f.id))]
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
    const projectIds = extractRelationIds(props["Project"])
    const sourceIds = extractRelationIds(props["Source"])

    return {
      id: page.id,
      subject: extractTitle(props["Subject"]),
      predicate: extractSelect(props["Predicate"], "related_to") as FactPredicate,
      object: extractRichText(props["Object"]),
      projectId: projectIds[0] ?? null,
      validFrom: extractDate(props["Valid From"]),
      validUntil: extractDate(props["Valid Until"]),
      sourceMemoryId: sourceIds[0] ?? null,
      confidence: extractSelect(props["Confidence"], "certain") as FactConfidence,
    }
  }
}
