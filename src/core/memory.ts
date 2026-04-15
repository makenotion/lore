/**
 * Memory CRUD + search — the core content store.
 *
 * Each memory is a Notion page in the Memories database. The page body
 * holds verbatim content. Page properties hold metadata for filtering
 * and categorization.
 *
 * Semantic search leverages Notion's existing embedding + vector search
 * pipeline: content written to Notion pages is automatically chunked,
 * embedded, and indexed. We search via the Notion search API.
 */

import type { Client } from "@notionhq/client"
import type {
  PageObjectResponse,
  CreatePageParameters,
  QueryDataSourceParameters,
} from "@notionhq/client"
import type {
  Memory,
  CreateMemoryInput,
  UpdateMemoryInput,
  SearchMemoriesInput,
  MemorySource,
  DatabaseRef,
} from "../types.js"
import { buildMemoryProps } from "../notion/schema.js"
import { projectOrUnscopedFilter } from "../notion/filters.js"
import {
  isFullPage,
  extractTitle,
  extractRichText,
  extractSelect,
  extractMultiSelect,
  extractRelationIds,
} from "../notion/extractors.js"

export class MemoryService {
  constructor(
    private client: Client,
    private db: DatabaseRef
  ) {}

  async create(input: CreateMemoryInput): Promise<Memory> {
    // Create the page with properties only
    const page = await this.client.pages.create({
      parent: { type: "database_id", database_id: this.db.databaseId },
      properties: buildMemoryProps({
        title: input.title,
        projectIds: input.projectIds,
        topicId: input.topicId,
        source: input.source ?? "manual",
        author: input.author,
        agent: input.agent,
        tags: input.tags,
        session: input.session,
      }),
    })

    // Write content via markdown API
    if (input.content) {
      await this.client.pages.updateMarkdown({
        page_id: page.id,
        type: "insert_content",
        insert_content: { content: input.content },
      })
    }

    return this.pageToMemory(page as PageObjectResponse, input.content ?? "")
  }

  async getById(id: string): Promise<Memory> {
    const [page, md] = await Promise.all([
      this.client.pages.retrieve({ page_id: id }),
      this.client.pages.retrieveMarkdown({ page_id: id }),
    ])
    return this.pageToMemory(page as PageObjectResponse, md.markdown)
  }

  async update(id: string, input: UpdateMemoryInput): Promise<Memory> {
    const props: Record<string, unknown> = {}

    if (input.title) {
      props["Title"] = { title: [{ text: { content: input.title } }] }
    }
    if (input.projectIds) {
      props["Project"] = { relation: input.projectIds.map((id) => ({ id })) }
    }
    if (input.topicId) {
      props["Topic"] = { relation: [{ id: input.topicId }] }
    }
    if (input.tags) {
      props["Tags"] = {
        multi_select: input.tags.map((t) => ({ name: t })),
      }
    }

    if (Object.keys(props).length > 0) {
      await this.client.pages.update({
        page_id: id,
        // Cast needed: we're building update props dynamically
        properties: props as CreatePageParameters["properties"],
      })
    }

    if (input.content) {
      await this.client.pages.updateMarkdown({
        page_id: id,
        type: "replace_content_range",
        replace_content_range: {
          content: input.content,
          content_range: "full_page",
          allow_deleting_content: true,
        },
      })
    }

    return this.getById(id)
  }

  async archive(id: string): Promise<void> {
    await this.client.pages.update({
      page_id: id,
      archived: true,
    })
  }

  async list(opts?: {
    projectId?: string
    topicId?: string
    source?: MemorySource
    limit?: number
    since?: string
    until?: string
  }): Promise<Memory[]> {
    const filters: Array<Record<string, unknown>> = []

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }
    if (opts?.topicId) {
      filters.push({
        property: "Topic",
        relation: { contains: opts.topicId },
      })
    }
    if (opts?.source) {
      filters.push({
        property: "Source",
        select: { equals: opts.source },
      })
    }
    if (opts?.since) {
      filters.push({
        timestamp: "created_time",
        created_time: { on_or_after: opts.since },
      })
    }
    if (opts?.until) {
      filters.push({
        timestamp: "created_time",
        created_time: { before: opts.until },
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
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: Math.min(opts?.limit ?? 20, 100),
    })

    const pages = response.results.filter(isFullPage) as PageObjectResponse[]
    return Promise.all(
      pages.map(async (page) => {
        const md = await this.client.pages.retrieveMarkdown({ page_id: page.id })
        return this.pageToMemory(page, md.markdown)
      })
    )
  }

  /**
   * Semantic search for memories using Notion's search API.
   *
   * Content stored in Notion is automatically embedded and indexed by
   * Notion's vector search pipeline. This search leverages that index.
   */
  async search(input: SearchMemoriesInput): Promise<Memory[]> {
    const response = await this.client.search({
      query: input.query,
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: Math.min(input.limit ?? 10, 100),
    })

    // Filter results to only pages in our Memories database
    const memoryPages = (response.results as PageObjectResponse[]).filter((page) => {
      if (!("parent" in page)) return false
      if (page.parent.type !== "database_id") return false
      return page.parent.database_id === this.db.databaseId
    })

    // Apply additional filters (project, topic, tags)
    let filtered = memoryPages
    if (input.projectId) {
      filtered = filtered.filter((page) => {
        const ids = extractRelationIds(page.properties["Project"])
        return ids.length === 0 || ids.includes(input.projectId!)
      })
    }
    if (input.topicId) {
      filtered = filtered.filter((page) => {
        const ids = extractRelationIds(page.properties["Topic"])
        return ids.includes(input.topicId!)
      })
    }
    if (input.tags?.length) {
      filtered = filtered.filter((page) => {
        const pageTags = extractMultiSelect(page.properties["Tags"])
        return input.tags!.some((t) => pageTags.includes(t))
      })
    }

    return Promise.all(
      filtered.map(async (page) => {
        const md = await this.client.pages.retrieveMarkdown({ page_id: page.id })
        return this.pageToMemory(page, md.markdown)
      })
    )
  }

  private pageToMemory(page: PageObjectResponse, content?: string): Memory {
    const props = page.properties
    const topicIds = extractRelationIds(props["Topic"])

    return {
      id: page.id,
      title: extractTitle(props["Title"]),
      projectIds: extractRelationIds(props["Project"]),
      topicId: topicIds[0] ?? null,
      source: extractSelect(props["Source"], "manual") as MemorySource,
      author: extractRichText(props["Author"]),
      agent: extractRichText(props["Agent"]),
      tags: extractMultiSelect(props["Tags"]),
      session: extractRichText(props["Session"]),
      content: content ?? "",
      createdAt: page.created_time,
      updatedAt: page.last_edited_time,
    }
  }
}
