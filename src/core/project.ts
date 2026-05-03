/**
 * Project CRUD.
 *
 * Each project is a row in the Projects database. Projects group
 * memories by codebase, person, or agent identity.
 */

import type { Client } from "@notionhq/client"
import type { PageObjectResponse, QueryDataSourceParameters } from "@notionhq/client"
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
import { isTransientNotionError } from "../notion/errors.js"
import { LruCache } from "./cache.js"

/** Project name → Project cache. TTL is short enough that a rename in
 *  Notion surfaces within a minute; cap is generous because projects are
 *  few and long-lived. */
const NAME_CACHE_TTL_MS = 60_000
const NAME_CACHE_MAX = 200

function activeProjectLookupFilter(
  lookup: Record<string, unknown>
): QueryDataSourceParameters["filter"] {
  return {
    and: [lookup, { property: "Status", select: { equals: "active" } }],
  } as QueryDataSourceParameters["filter"]
}

export type ProjectNameResolution =
  | { kind: "resolved"; project: Project }
  | { kind: "missing" }
  | { kind: "transient-error"; cause: unknown }

export class ProjectService {
  /**
   * Name → Project cache. **Invariant**: every mutation that changes a
   * Project's `Name` property must invalidate this cache, or a 60s
   * stale-name→id window opens for every caller that names the project.
   * Today only `create` and `archive` touch the cache; a future rename
   * or `update` method must extend this list.
   */
  private readonly nameCache = new LruCache<string, Project>(
    NAME_CACHE_MAX,
    NAME_CACHE_TTL_MS
  )

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

    // Drop any prior cache entry for this name so a negative-lookup
    // replayed against a stale session sees the new page.
    this.nameCache.delete(input.name)
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
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)

    return results.map((p) => this.pageToProject(p))
  }

  async findByPath(path: string): Promise<Project | null> {
    const response = await this.client.dataSources.query({
      data_source_id: this.db.dataSourceId,
      filter: activeProjectLookupFilter({
        property: "Path",
        rich_text: { equals: path },
      }),
    })
    const page = response.results.filter(isFullPage)[0] as PageObjectResponse | undefined
    return page ? this.pageToProject(page) : null
  }

  /**
   * Look up an active project by exact name match. Cached in-process for
   * `NAME_CACHE_TTL_MS` so a multi-tool MCP conversation referencing the
   * same project pays one Notion round-trip, not one per tool call.
   *
   * Uses `getOrLoad` so N concurrent cold-start callers — an MCP batch
   * that fans out `lore-memory` + `lore-fact` + `lore-query` action='ask'
   * against the same project in a single tick — share a single
   * `dataSources.query`.
   *
   * Negative lookups are not cached — a `create` followed by a
   * `findByName` in the same session must see the new page.
   */
  async findByName(
    name: string,
    options: { includeArchived?: boolean } = {}
  ): Promise<Project | null> {
    if (options.includeArchived) {
      return this.loadByName(name, { includeArchived: true })
    }
    return this.nameCache.getOrLoad(name, async () => {
      return this.loadByName(name, { includeArchived: false })
    })
  }

  async resolveByName(
    name: string,
    options: { includeArchived?: boolean } = {}
  ): Promise<ProjectNameResolution> {
    try {
      const project = await this.findByName(name, options)
      return project ? { kind: "resolved", project } : { kind: "missing" }
    } catch (err) {
      if (isTransientNotionError(err)) return { kind: "transient-error", cause: err }
      throw err
    }
  }

  async archive(id: string): Promise<void> {
    await this.client.pages.update({
      page_id: id,
      properties: {
        Status: { select: { name: "archived" } },
      },
    })
    // Archiving flips a status field inside any cached copy. We don't
    // track the name→id reverse mapping, so drop the whole cache rather
    // than serve stale Status values. Archives are rare.
    this.nameCache.clear()
  }

  /** Reset the in-process name cache. Used by tests and by the
   *  cross-service `clearServiceCaches()` helper. */
  clearNameCache(): void {
    this.nameCache.clear()
  }

  private async loadByName(
    name: string,
    options: { includeArchived: boolean }
  ): Promise<Project | null> {
    const lookup = {
      property: "Name",
      title: { equals: name },
    }
    const response = await this.client.dataSources.query({
      data_source_id: this.db.dataSourceId,
      filter: options.includeArchived
        ? (lookup as QueryDataSourceParameters["filter"])
        : activeProjectLookupFilter(lookup),
      page_size: 2,
    })
    const pages = response.results.filter(isFullPage) as PageObjectResponse[]
    if (pages.length > 1) {
      const ids = pages.map((page) => page.id).join(", ")
      const qualifier = options.includeArchived ? "projects" : "active projects"
      throw new Error(
        `Multiple ${qualifier} named "${name}" found (${ids}). ` +
          `Rename or archive duplicates before using explicit project scope.`
      )
    }
    const page = pages[0]
    return page ? this.pageToProject(page) : null
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
