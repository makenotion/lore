/**
 * Topic CRUD.
 *
 * Topics organize memories within a project by subject area.
 */

import type { Client } from "@notionhq/client"
import type { PageObjectResponse, QueryDataSourceParameters } from "@notionhq/client"
import type { Topic, CreateTopicInput, DatabaseRef } from "../types.js"
import { buildTopicProps } from "../notion/schema.js"
import {
  isFullPage,
  extractTitle,
  extractRichText,
  extractRelationIds,
} from "../notion/extractors.js"

export class TopicService {
  constructor(
    private client: Client,
    private db: DatabaseRef
  ) {}

  async create(input: CreateTopicInput): Promise<Topic> {
    const page = await this.client.pages.create({
      parent: { type: "database_id", database_id: this.db.databaseId },
      properties: buildTopicProps({
        name: input.name,
        projectId: input.projectId,
        description: input.description,
      }),
    })

    return this.pageToTopic(page as PageObjectResponse)
  }

  async getById(id: string): Promise<Topic> {
    const page = await this.client.pages.retrieve({ page_id: id })
    return this.pageToTopic(page as PageObjectResponse)
  }

  async listByProject(projectId: string): Promise<Topic[]> {
    const results: PageObjectResponse[] = []
    let cursor: string | undefined

    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: {
          property: "Project",
          relation: { contains: projectId },
        },
        sorts: [{ property: "Name", direction: "ascending" }],
        start_cursor: cursor,
      })
      results.push(...(response.results.filter(isFullPage) as PageObjectResponse[]))
      cursor = response.next_cursor ?? undefined
    } while (cursor)

    return results.map((p) => this.pageToTopic(p))
  }

  async findByName(name: string, projectId?: string): Promise<Topic | null> {
    const filters: Array<Record<string, unknown>> = [
      { property: "Name", title: { equals: name } },
    ]
    if (projectId) {
      filters.push({ property: "Project", relation: { contains: projectId } })
    }

    const filter = filters.length > 1 ? { and: filters } : filters[0]

    const response = await this.client.dataSources.query({
      data_source_id: this.db.dataSourceId,
      filter: filter as QueryDataSourceParameters["filter"],
    })

    const page = response.results.filter(isFullPage)[0] as PageObjectResponse | undefined
    return page ? this.pageToTopic(page) : null
  }

  async getOrCreate(name: string, projectId: string): Promise<Topic> {
    const existing = await this.findByName(name, projectId)
    if (existing) return existing
    return this.create({ name, projectId })
  }

  private pageToTopic(page: PageObjectResponse): Topic {
    const props = page.properties
    const projectIds = extractRelationIds(props["Project"])
    return {
      id: page.id,
      name: extractTitle(props["Name"]),
      projectId: projectIds[0] ?? "",
      description: extractRichText(props["Description"]),
    }
  }
}
