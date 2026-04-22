/**
 * Project CRUD.
 *
 * Each project is a row in the Projects database. Projects group
 * memories by codebase, person, or agent identity.
 */

import type { Client } from "@notionhq/client"
import type { PageObjectResponse } from "@notionhq/client"
import type {
  Project,
  CreateProjectInput,
  ProjectType,
  ProjectStatus,
  DatabaseRef,
} from "../types.js"
import { buildProjectProps } from "../notion/schema.js"
import {
  isFullPage,
  extractTitle,
  extractRichText,
  extractSelect,
} from "../notion/extractors.js"

export class ProjectService {
  constructor(
    private client: Client,
    private db: DatabaseRef
  ) {}

  async create(input: CreateProjectInput): Promise<Project> {
    const page = await this.client.pages.create({
      parent: { type: "database_id", database_id: this.db.databaseId },
      properties: buildProjectProps({
        name: input.name,
        type: input.type ?? "project",
        path: input.path,
        description: input.description,
      }),
    })

    return this.pageToProject(page as PageObjectResponse)
  }

  async getById(id: string): Promise<Project> {
    const page = await this.client.pages.retrieve({ page_id: id })
    return this.pageToProject(page as PageObjectResponse)
  }

  async list(status?: ProjectStatus): Promise<Project[]> {
    const filter = status ? { property: "Status", select: { equals: status } } : undefined

    const results: PageObjectResponse[] = []
    let cursor: string | undefined

    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter,
        sorts: [{ property: "Name", direction: "ascending" }],
        start_cursor: cursor,
      })
      results.push(...(response.results.filter(isFullPage) as PageObjectResponse[]))
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined
    } while (cursor)

    return results.map((p) => this.pageToProject(p))
  }

  async findByPath(path: string): Promise<Project | null> {
    const response = await this.client.dataSources.query({
      data_source_id: this.db.dataSourceId,
      filter: {
        property: "Path",
        rich_text: { equals: path },
      },
    })
    const page = response.results.filter(isFullPage)[0] as PageObjectResponse | undefined
    return page ? this.pageToProject(page) : null
  }

  async findByName(name: string): Promise<Project | null> {
    const response = await this.client.dataSources.query({
      data_source_id: this.db.dataSourceId,
      filter: {
        property: "Name",
        title: { equals: name },
      },
    })
    const page = response.results.filter(isFullPage)[0] as PageObjectResponse | undefined
    return page ? this.pageToProject(page) : null
  }

  async archive(id: string): Promise<void> {
    await this.client.pages.update({
      page_id: id,
      properties: {
        Status: { select: { name: "archived" } },
      },
    })
  }

  private pageToProject(page: PageObjectResponse): Project {
    const props = page.properties
    return {
      id: page.id,
      name: extractTitle(props["Name"]),
      type: extractSelect(props["Type"], "project") as ProjectType,
      path: extractRichText(props["Path"]),
      status: extractSelect(props["Status"], "active") as ProjectStatus,
      description: extractRichText(props["Description"]),
    }
  }
}
