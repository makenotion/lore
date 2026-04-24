/**
 * Topic CRUD.
 *
 * Topics organize memories by subject area. A topic may belong to one or
 * more projects: cross-cutting subjects (e.g. "GraphQL federation") can
 * span every project that participates in them.
 */

import type { Client } from "@notionhq/client"
import type {
  CreatePageParameters,
  PageObjectResponse,
  QueryDataSourceParameters,
} from "@notionhq/client"
import { decodeHTML } from "entities"
import type { Topic, CreateTopicInput, DatabaseRef } from "../types.js"
import { buildTopicProps } from "../notion/schema.js"
import {
  isFullPage,
  extractTitle,
  extractRichText,
  extractRelationIds,
} from "../notion/extractors.js"
import { LruCache } from "./cache.js"

/** Max retries for the optimistic `getOrCreate` extend loop when a concurrent
 *  writer clobbers the relation mid-update. Two retries is enough to cover
 *  single-writer jitter without turning a collision into an API hammer. */
const GET_OR_CREATE_MAX_RETRIES = 2

/**
 * Fully decode HTML entities in a topic name, looping until stable so
 * double-encoded inputs like `&amp;amp;` collapse all the way to `&`.
 *
 * Topic names are plain text, not markup. An upstream producer somewhere in
 * the autosave path (Claude Code rendering transcript context as markdown,
 * or the agent itself when emitting names that quote file-system or markup
 * content) has been observed to HTML-encode `&` before the name reaches the
 * MCP boundary; on re-save the already-encoded value gets encoded again.
 * Decoding here — both on write (`create`) and on lookup (`findByName`,
 * `getOrCreate`) — makes the service idempotent regardless of how many
 * rounds of encoding the caller has accumulated.
 *
 * Uses `entities.decodeHTML` rather than a hand-rolled table so the full
 * HTML5 named + numeric entity set is covered; a future upstream producer
 * emitting `&nbsp;`, `&rsquo;`, `&#8217;`, etc. doesn't reopen this bug.
 *
 * The fixed-point loop is the important bit: `decodeHTML("&amp;amp;")` only
 * peels off one layer. Every decoding pass strictly shrinks the string when
 * it changes (the shortest entity is 4 chars and decodes to ≤1), so
 * `name.length` iterations is a principled upper bound. Real-world cases
 * max out at two.
 */
export function decodeTopicHtmlEntities(name: string): string {
  let current = name
  for (let i = 0; i < name.length; i++) {
    const next = decodeHTML(current)
    if (next === current) return current
    current = next
  }
  return current
}

/** Topic name → Topic cache. Covers only global (unscoped) lookups — the
 *  scoped variant is a rarely-used safety valve and is not cached. The
 *  cap is generous because topics are numerous but not unbounded in a
 *  typical vault. The cache is keyed on the decoded name so encoded and
 *  decoded inputs hit the same entry. */
const NAME_CACHE_TTL_MS = 60_000
const NAME_CACHE_MAX = 500

export class TopicService {
  private readonly nameCache = new LruCache<string, Topic>(
    NAME_CACHE_MAX,
    NAME_CACHE_TTL_MS
  )

  constructor(
    private client: Client,
    private db: DatabaseRef
  ) {}

  async create(input: CreateTopicInput): Promise<Topic> {
    const name = decodeTopicHtmlEntities(input.name)
    const page = await this.client.pages.create({
      parent: { type: "database_id", database_id: this.db.databaseId },
      properties: buildTopicProps({
        name,
        projectIds: input.projectIds,
        description: input.description,
      }),
    })

    // Drop any stale entry for this name so a negative cached lookup
    // can't mask the newly created topic inside the same TTL window.
    // Key on the decoded name so we evict whatever `findByName` cached.
    this.nameCache.delete(name)
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
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined
    } while (cursor)

    return results.map((p) => this.pageToTopic(p))
  }

  /**
   * List every topic with the given name. Used by the duplicate-merge
   * migration (`mergeDuplicatesByName`) and by `findByName` as a safety
   * probe. Topic names should be globally unique after migration; the
   * pagination loop handles the degenerate case of a legacy vault with
   * many like-named rows.
   */
  async listByName(name: string): Promise<Topic[]> {
    const results: PageObjectResponse[] = []
    let cursor: string | undefined

    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: {
          property: "Name",
          title: { equals: name },
        },
        start_cursor: cursor,
      })
      results.push(...(response.results.filter(isFullPage) as PageObjectResponse[]))
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined
    } while (cursor)

    return results.map((p) => this.pageToTopic(p))
  }

  /**
   * Find a topic by name. Topic names are globally unique after migration;
   * duplicates are resolved by `lore migrate --merge-duplicate-topics`.
   *
   * - Without `projectId`: global lookup by name.
   * - With `projectId`: additionally require that id be present in the
   *   topic's Project relation (scoped lookup).
   *
   * If the query returns more than one match in global mode, an
   * explanatory error is thrown — `getOrCreate` would otherwise silently
   * pick an arbitrary duplicate and extend it, stranding the siblings.
   * Callers that know they need scoped behaviour can pass `projectId`.
   */
  async findByName(name: string, projectId?: string): Promise<Topic | null> {
    const decoded = decodeTopicHtmlEntities(name)

    // Only the global (unscoped) lookup is cached: it's the hot path used
    // by `getOrCreate` and every MCP tool that accepts `topicName`. The
    // scoped form exists for vaults still carrying pre-migration
    // duplicates and is infrequent enough to query live. Key on `decoded`
    // so encoded and decoded inputs share a cache slot.
    if (!projectId) {
      const cached = this.nameCache.get(decoded)
      if (cached) return cached
    }

    const filters: Array<Record<string, unknown>> = [
      { property: "Name", title: { equals: decoded } },
    ]
    if (projectId) {
      filters.push({ property: "Project", relation: { contains: projectId } })
    }

    const filter = filters.length > 1 ? { and: filters } : filters[0]

    const response = await this.client.dataSources.query({
      data_source_id: this.db.dataSourceId,
      filter: filter as QueryDataSourceParameters["filter"],
    })

    const pages = response.results.filter(isFullPage) as PageObjectResponse[]
    if (pages.length === 0) return null

    if (!projectId && pages.length > 1) {
      const ids = pages.map((p) => p.id).join(", ")
      throw new Error(
        `Multiple topics named "${decoded}" found (${ids}). ` +
          `Run \`lore migrate --merge-duplicate-topics\` to merge them.`
      )
    }

    const topic = this.pageToTopic(pages[0])
    if (!projectId) this.nameCache.set(decoded, topic)
    return topic
  }

  /**
   * Get a topic by name, creating or extending as needed so its Project
   * relation includes every id in `projectIds`.
   *
   * - Not found → create with the given `projectIds`.
   * - Found with all requested ids already linked → return existing.
   * - Found but missing some ids → extend the relation via `pages.update`.
   *   Re-reads after the write and verifies the requested ids landed; if a
   *   concurrent writer clobbered us (replace semantics on relation
   *   updates), retries up to `GET_OR_CREATE_MAX_RETRIES` times.
   *
   * Relies on `findByName`'s global-uniqueness invariant. That invariant is
   * established by `lore migrate --merge-duplicate-topics`; this method
   * will throw if a legacy vault still has duplicate-name topics.
   */
  async getOrCreate(name: string, projectIds: string[]): Promise<Topic> {
    const decoded = decodeTopicHtmlEntities(name)

    // Writeback uses `existing.projectIds` as the merge base, so a stale
    // cached value would let us clobber relations added by another
    // writer inside the TTL window. Evict before reading so the
    // internal `findByName` hits Notion fresh; the refetch and the
    // successful-extend path below re-populate the cache with the
    // authoritative post-write state. Key on the decoded name so the
    // cache and the storage agree.
    this.nameCache.delete(decoded)
    for (let attempt = 0; attempt <= GET_OR_CREATE_MAX_RETRIES; attempt++) {
      const existing = await this.findByName(decoded)
      if (!existing) return this.create({ name: decoded, projectIds })

      const missing = projectIds.filter((id) => !existing.projectIds.includes(id))
      if (missing.length === 0) return existing

      const merged = [...existing.projectIds, ...missing]
      await this.client.pages.update({
        page_id: existing.id,
        properties: {
          Project: { relation: merged.map((id) => ({ id })) },
        } as CreatePageParameters["properties"],
      })

      // Re-read to confirm our additions landed. Notion's pages.update
      // replaces the relation array wholesale, so a concurrent writer that
      // read the same pre-state could have just clobbered our extension.
      const refetched = await this.getById(existing.id)
      if (projectIds.every((id) => refetched.projectIds.includes(id))) {
        // Cache now holds the pre-extend projectIds from the
        // `findByName` at the top of this loop. Replace with the
        // authoritative post-extend state rather than leaving the
        // cache to serve stale relations until TTL.
        this.nameCache.set(name, refetched)
        return refetched
      }
      // Lost-update detected; try again.
      this.nameCache.delete(name)
    }

    // Fall through after retries — return whatever authoritative state
    // currently exists. The caller's desired relation may still be
    // incomplete; this is the documented failure mode under concurrency.
    const final = await this.findByName(decoded)
    if (!final) {
      throw new Error(
        `Topic "${decoded}" disappeared during concurrent getOrCreate retries`
      )
    }
    return final
  }

  /** Reset the in-process name cache. Used by tests and by the
   *  cross-service `clearServiceCaches()` helper. */
  clearNameCache(): void {
    this.nameCache.clear()
  }

  private pageToTopic(page: PageObjectResponse): Topic {
    const props = page.properties
    return {
      id: page.id,
      name: extractTitle(props["Name"]),
      projectIds: extractRelationIds(props["Project"]),
      description: extractRichText(props["Description"]),
    }
  }
}
