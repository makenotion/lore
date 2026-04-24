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
  MemoryKind,
  MemoryStatus,
  MemoryConfidence,
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
  extractDate,
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
        kind: input.kind,
        status: input.status,
        confidence: input.confidence,
        reviewBy: input.reviewBy,
        decidedAt: input.decidedAt,
        supersedesIds: input.supersedesIds,
        affectsIds: input.affectsIds,
        alternatives: input.alternatives,
        consequences: input.consequences,
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

  /**
   * Read a memory's `Title` property without fetching its markdown body.
   * Single `pages.retrieve` round-trip; used by render-layer resolvers
   * that only need a human-readable label for a page ID. Returns `null`
   * on not-found / permission errors so callers can fall through to the
   * raw ID with a `(?)` hint. Works across `Kind = decision` and every
   * other memory kind — both live in the Memories DB.
   */
  async getTitleById(id: string): Promise<string | null> {
    try {
      const page = await this.client.pages.retrieve({ page_id: id })
      if (!isFullPage(page)) return null
      const title = extractTitle(
        (page as PageObjectResponse).properties["Title"],
      )
      return title || null
    } catch {
      return null
    }
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
    if (input.kind) {
      props["Kind"] = { select: { name: input.kind } }
    }
    if (input.status) {
      props["Status"] = { select: { name: input.status } }
    }
    if (input.confidence) {
      props["Confidence"] = { select: { name: input.confidence } }
    }
    // `null` explicitly clears a date; `undefined` leaves it untouched.
    if (input.reviewBy !== undefined) {
      props["Review By"] = input.reviewBy
        ? { date: { start: input.reviewBy } }
        : { date: null }
    }
    if (input.decidedAt !== undefined) {
      props["Decided At"] = input.decidedAt
        ? { date: { start: input.decidedAt } }
        : { date: null }
    }
    if (input.supersedesIds) {
      props["Supersedes"] = { relation: input.supersedesIds.map((id) => ({ id })) }
    }
    if (input.affectsIds) {
      props["Affects"] = { relation: input.affectsIds.map((id) => ({ id })) }
    }
    if (input.alternatives !== undefined) {
      props["Alternatives"] = {
        rich_text: [{ text: { content: input.alternatives } }],
      }
    }
    if (input.consequences !== undefined) {
      props["Consequences"] = {
        rich_text: [{ text: { content: input.consequences } }],
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
    kind?: MemoryKind
    status?: MemoryStatus
    reviewBefore?: string
    tags?: string[]
    limit?: number
    since?: string
    until?: string
    /**
     * When false, skip the per-page markdown fetch and return memories with
     * `content: ""`. Use for index-tier listings (decisions, wake-up
     * summaries) and list views that render only title/date/tags — avoids
     * N+1 `retrieveMarkdown` calls.
     */
    includeContent?: boolean
    /**
     * When false, scope project queries to memories explicitly linked to the
     * given project, excluding repo-wide/unscoped entries.
     */
    includeUnscoped?: boolean
    /**
     * Notion timestamp field to sort by. Defaults to `last_edited_time`
     * (general-purpose "most recently touched"). Pass `created_time` for
     * "most recently created" ordering — e.g. latest-digest lookup.
     */
    sortBy?: "created_time" | "last_edited_time"
    /**
     * Opaque cursor from a previous page's `nextCursor`. When provided,
     * continues enumeration from where that page ended. The filter/sort
     * must match the originating query — Notion returns the cursor's
     * contents under the assumption the query shape is unchanged.
     */
    startCursor?: string
  }): Promise<{ items: Memory[]; nextCursor?: string }> {
    const filters: Array<Record<string, unknown>> = []

    if (opts?.projectId) {
      filters.push(
        opts.includeUnscoped === false
          ? { property: "Project", relation: { contains: opts.projectId } }
          : projectOrUnscopedFilter(opts.projectId)
      )
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
    if (opts?.kind) {
      filters.push({
        property: "Kind",
        select: { equals: opts.kind },
      })
    }
    if (opts?.status) {
      filters.push({
        property: "Status",
        select: { equals: opts.status },
      })
    }
    if (opts?.reviewBefore) {
      filters.push({
        property: "Review By",
        date: { on_or_before: opts.reviewBefore },
      })
    }
    if (opts?.tags?.length) {
      if (opts.tags.length === 1) {
        filters.push({ property: "Tags", multi_select: { contains: opts.tags[0] } })
      } else {
        filters.push({
          or: opts.tags.map((t) => ({
            property: "Tags",
            multi_select: { contains: t },
          })),
        })
      }
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
      sorts: [{ timestamp: opts?.sortBy ?? "last_edited_time", direction: "descending" }],
      page_size: Math.min(opts?.limit ?? 20, 100),
      start_cursor: opts?.startCursor,
    })

    const pages = response.results.filter(isFullPage) as PageObjectResponse[]
    const nextCursor =
      response.has_more && response.next_cursor ? response.next_cursor : undefined

    if (opts?.includeContent === false) {
      return {
        items: pages.map((page) => this.pageToMemory(page, "")),
        nextCursor,
      }
    }

    const items = await Promise.all(
      pages.map(async (page) => {
        const md = await this.client.pages.retrieveMarkdown({ page_id: page.id })
        return this.pageToMemory(page, md.markdown)
      })
    )
    return { items, nextCursor }
  }

  /**
   * Semantic search for memories using Notion's search API.
   *
   * Content stored in Notion is automatically embedded and indexed by
   * Notion's vector search pipeline. This search leverages that index.
   *
   * Notion's `search` endpoint returns results ranked by relevance when no
   * `sort` parameter is passed. Passing `sort` switches to recency ordering
   * and demotes the query to a lexical filter — which defeats the point.
   * We pay for a larger `page_size` instead so the client-side filter to
   * the Memories database has enough headroom when the workspace contains
   * other pages that happen to match the query tokens.
   */
  async search(input: SearchMemoriesInput): Promise<Memory[]> {
    const response = await this.client.search({
      query: input.query,
      filter: { property: "object", value: "page" },
      page_size: 100,
    })

    // Filter results to only pages in our Memories database. Notion SDK v5
    // returns two parent-type shapes depending on how the page was created /
    // what the workspace has since been upgraded to: classic `database_id`
    // parents, and data-source-backed `data_source_id` parents. Match either
    // against our `DatabaseRef`.
    const memoryPages = (response.results as PageObjectResponse[]).filter((page) => {
      if (!("parent" in page)) return false
      const parent = page.parent
      if (parent.type === "database_id") {
        return parent.database_id === this.db.databaseId
      }
      if (parent.type === "data_source_id") {
        return parent.data_source_id === this.db.dataSourceId
      }
      return false
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

    // Cap at the caller's requested limit before paying the per-page markdown
    // round-trip. `client.search()` ignores our limit and returns up to
    // `page_size`, so we trim here.
    const capped = filtered.slice(0, input.limit ?? 10)

    if (input.includeContent === false) {
      return capped.map((page) => this.pageToMemory(page, ""))
    }

    return Promise.all(
      capped.map(async (page) => {
        const md = await this.client.pages.retrieveMarkdown({ page_id: page.id })
        return this.pageToMemory(page, md.markdown)
      })
    )
  }

  private pageToMemory(page: PageObjectResponse, content?: string): Memory {
    return pageToMemory(page, content)
  }
}

/**
 * Convert a Notion page object to a `Memory` domain type. Pure function —
 * exported for unit testing. The hardened extractors guarantee graceful
 * defaults for pages that pre-date any schema addition: a pre-migration
 * page returns `kind: "note"`, `status: "informational"`, etc.
 */
export function pageToMemory(page: PageObjectResponse, content?: string): Memory {
  const props = page.properties
  const topicIds = extractRelationIds(props["Topic"])

  return {
    id: page.id,
    title: extractTitle(props["Title"]),
    projectIds: extractRelationIds(props["Project"]),
    topicId: topicIds[0] ?? null,
    source: extractSelect(props["Source"], "manual") as MemorySource,
    // Decision-related columns. Pre-migration pages default gracefully
    // via the hardened extractors — no backfill required.
    kind: extractSelect(props["Kind"], "note") as MemoryKind,
    status: extractSelect(props["Status"], "informational") as MemoryStatus,
    confidence: extractSelect(props["Confidence"], "certain") as MemoryConfidence,
    reviewBy: extractDate(props["Review By"]),
    decidedAt: extractDate(props["Decided At"]),
    supersedesIds: extractRelationIds(props["Supersedes"]),
    affectsIds: extractRelationIds(props["Affects"]),
    alternatives: extractRichText(props["Alternatives"]),
    consequences: extractRichText(props["Consequences"]),
    author: extractRichText(props["Author"]),
    agent: extractRichText(props["Agent"]),
    tags: extractMultiSelect(props["Tags"]),
    session: extractRichText(props["Session"]),
    content: content ?? "",
    createdAt: page.created_time,
    updatedAt: page.last_edited_time,
  }
}
