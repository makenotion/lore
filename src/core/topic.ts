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
import type { Topic, CreateTopicInput, DatabaseRef } from "../types.js"
import { buildTopicProps } from "../notion/schema.js"
import { decodeTextEntities } from "../notion/html-entities.js"
import {
  isFullPage,
  extractTitle,
  extractRichText,
  extractRelationIds,
} from "../notion/extractors.js"
import { LruCache } from "./cache.js"
import { normalizeTopicNameForLookup } from "./topic-normalize.js"
import { trigramJaccard } from "./similarity.js"

/** Max retries for the optimistic `getOrCreate` extend loop when a concurrent
 *  writer clobbers the relation mid-update. Two retries is enough to cover
 *  single-writer jitter without turning a collision into an API hammer. */
const GET_OR_CREATE_MAX_RETRIES = 2

/**
 * Trigram-Jaccard threshold above which the slow-path probe rejects a
 * fresh-name create and surfaces the candidate to the caller. Tighter
 * than the memory near-duplicate probe (0.7) because a topic-create
 * rejection is *blocking*, not advisory: a false positive becomes a
 * dead end for the agent until they pass `forceNew: true`.
 *
 * The dominant collapse axis (case / plural / `&`-vs-`and` / punctuation)
 * is already handled by `normalizeTopicNameForLookup`, so the trigram
 * pass is the residual safety net for typos and casing-only twins that
 * survive normalization.
 */
const TOPIC_TRIGRAM_REJECT_THRESHOLD = 0.85

/**
 * How many similar candidates to surface in the structured error. Three
 * is enough to be useful (the agent can pick one) and short enough to
 * fit in a single tool-response line per candidate.
 */
const TOPIC_SIMILAR_CANDIDATES_SURFACED = 3

/**
 * Probe candidate returned to the caller in the structured error. Carries
 * the trigram score so an operator triaging a noisy probe can read the
 * margin without re-running the calculation.
 */
export interface SimilarTopicCandidate {
  id: string
  name: string
  similarity: number
}

/**
 * Thrown by `getOrCreate` when the slow-path probe finds a topic in the
 * resolved project scope whose trigram similarity exceeds the reject
 * threshold and no normalized-equivalent canonical exists. The structured
 * `candidates` field lets the MCP tool layer render a copy-pasteable list
 * without re-parsing the message.
 */
export class SimilarTopicError extends Error {
  readonly attempted: string
  readonly candidates: SimilarTopicCandidate[]

  constructor(attempted: string, candidates: SimilarTopicCandidate[]) {
    const lines = candidates
      .map(
        (c) =>
          `  - "${c.name}" (similarity ${c.similarity.toFixed(2)}, id: ${c.id})`
      )
      .join("\n")
    super(
      `Topic "${attempted}" looks similar to ${candidates.length} existing topic${candidates.length === 1 ? "" : "s"} in this project:\n` +
        `${lines}\n` +
        "Use one of the existing topic names verbatim, or pass `forceNew: true` to create a new topic anyway."
    )
    this.name = "SimilarTopicError"
    this.attempted = attempted
    this.candidates = candidates
  }
}

/**
 * Backwards-compatible alias for the shared `decodeTextEntities` helper.
 * The decoder originally lived here as `decodeTopicHtmlEntities`, but the
 * same pathology affects memory titles, fact subject/object text, and any
 * other plain-text field that flows through the autosave path. The
 * implementation now lives in `src/notion/html-entities.ts` so every write
 * site can import it without pulling in the whole topic service.
 *
 * Re-exported under the old name so the topic-merge migration and existing
 * tests don't have to rename in the same PR as the decoder hoist.
 *
 * @deprecated Import `decodeTextEntities` from `src/notion/html-entities.ts`
 * instead. This alias will be removed the next time `topic.ts` or
 * `topic-merge.ts` is touched — there is no feature it enables, only a
 * naming bridge from the pre-hoist world.
 */
export const decodeTopicHtmlEntities = decodeTextEntities

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
    //
    // `getOrLoad` collapses concurrent cold-start callers resolving the
    // same topic name — e.g. a fan-out of autosaves that each resolve
    // `topicName` before writing memories — onto one Notion query.
    const fetch = async (): Promise<Topic | null> => {
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

      return this.pageToTopic(pages[0])
    }

    if (projectId) return fetch()
    return this.nameCache.getOrLoad(decoded, fetch)
  }

  /**
   * Get a topic by name, creating or extending as needed so its Project
   * relation includes every id in `projectIds`.
   *
   * Resolution order:
   *
   * 1. **Exact-name match** (via `findByName`) → extend the relation and
   *    return. Relies on `findByName`'s global-uniqueness invariant
   *    established by `lore migrate --merge-duplicate-topics`.
   * 2. **Normalized-equivalent match** in any of the resolved projects
   *    (via the slow-path probe) → silently extend that canonical row's
   *    relation. Closes the issue #109 fan-out where agents drifted
   *    pluralization / `&` ↔ `and` / casing variants of the same topic.
   * 3. **Trigram-similar candidates ≥ `TOPIC_TRIGRAM_REJECT_THRESHOLD`**
   *    in any of the resolved projects → throw `SimilarTopicError` with
   *    the candidate list so the caller can use the existing name
   *    verbatim, or pass `opts.forceNew = true` to create anyway.
   * 4. **No matches at all** → create with the given `projectIds`.
   *
   * The probe runs on the slow path only (no exact match). Cost: one
   * `dataSources.query` per project in `projectIds` to materialize the
   * candidate pool. Skipped entirely when `projectIds` is empty (no
   * project scope to probe) or `opts.forceNew` is set.
   */
  async getOrCreate(
    name: string,
    projectIds: string[],
    opts: { forceNew?: boolean } = {}
  ): Promise<Topic> {
    const decoded = decodeTopicHtmlEntities(name)

    // Writeback uses `existing.projectIds` as the merge base, so a stale
    // cached value would let us clobber relations added by another
    // writer inside the TTL window. Evict before reading so the
    // internal `findByName` hits Notion fresh; the refetch and the
    // successful-extend path below re-populate the cache with the
    // authoritative post-write state. Key on the decoded name so the
    // cache and the storage agree.
    this.nameCache.delete(decoded)

    const exact = await this.findByName(decoded)
    if (exact) return this.extendOrReturn(exact, projectIds, decoded)

    if (projectIds.length > 0 && !opts.forceNew) {
      const probe = await this.probeSimilarInProjects(decoded, projectIds)
      if (probe.canonicalByNormalize) {
        // Treat the normalized-equivalent row as the canonical for this
        // save: extend its relation if needed. The cache slot is keyed on
        // the canonical's stored name, not the caller's input — a fresh
        // `findByName(canonical.name)` should hit the post-extend state.
        return this.extendOrReturn(
          probe.canonicalByNormalize,
          projectIds,
          probe.canonicalByNormalize.name
        )
      }
      if (probe.similar.length > 0) {
        throw new SimilarTopicError(decoded, probe.similar)
      }
    }

    return this.create({ name: decoded, projectIds })
  }

  /**
   * Extend an existing topic's `Project` relation to include every id in
   * `projectIds`, retrying on concurrent-writer clobber. `cacheKey` is
   * the name we should populate the post-extend state under — for
   * exact-match callers it's the decoded input; for normalized-canonical
   * callers it's the canonical row's stored name.
   */
  private async extendOrReturn(
    initial: Topic,
    projectIds: string[],
    cacheKey: string
  ): Promise<Topic> {
    let existing = initial
    for (let attempt = 0; attempt <= GET_OR_CREATE_MAX_RETRIES; attempt++) {
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
        // Cache now holds the pre-extend projectIds from the read at
        // the top of `getOrCreate`. Replace with the authoritative
        // post-extend state rather than leaving the cache to serve
        // stale relations until TTL.
        this.nameCache.set(cacheKey, refetched)
        return refetched
      }
      // Lost-update detected; try again from the freshly-read state.
      this.nameCache.delete(cacheKey)
      existing = refetched
    }

    // Fall through after retries — return whatever authoritative state
    // currently exists. The caller's desired relation may still be
    // incomplete; this is the documented failure mode under concurrency.
    return existing
  }

  /**
   * Pull every topic in the resolved projects, deduped by id, and probe
   * for normalized-equivalent and trigram-similar matches against
   * `decoded`. Cost: one `listByProject` per project. Returns:
   *
   * - `canonicalByNormalize` — a topic whose normalized name matches
   *   `decoded`'s normalized name. Tiebreak by lex-smallest id when more
   *   than one row in the pool normalizes the same way (rare; would
   *   indicate a normalized-equivalent duplicate that
   *   `--merge-similar-topics` should collapse).
   * - `similar` — up to `TOPIC_SIMILAR_CANDIDATES_SURFACED` topics whose
   *   trigram similarity meets `TOPIC_TRIGRAM_REJECT_THRESHOLD`,
   *   sorted by similarity descending. Empty when no candidate beats
   *   the threshold.
   */
  private async probeSimilarInProjects(
    decoded: string,
    projectIds: string[]
  ): Promise<{
    canonicalByNormalize: Topic | null
    similar: SimilarTopicCandidate[]
  }> {
    const seen = new Map<string, Topic>()
    for (const projectId of projectIds) {
      const topics = await this.listByProject(projectId)
      for (const t of topics) {
        if (!seen.has(t.id)) seen.set(t.id, t)
      }
    }

    const targetNorm = normalizeTopicNameForLookup(decoded)
    if (targetNorm.length === 0) {
      return { canonicalByNormalize: null, similar: [] }
    }

    let canonicalByNormalize: Topic | null = null
    const similar: SimilarTopicCandidate[] = []
    for (const t of seen.values()) {
      const candidateNorm = normalizeTopicNameForLookup(t.name)
      if (candidateNorm.length === 0) continue

      if (candidateNorm === targetNorm) {
        // Multiple normalized-equivalent rows can exist on a vault that
        // hasn't run `--merge-similar-topics` yet. Lex-smallest id is a
        // deterministic tiebreaker independent of pagination order.
        if (!canonicalByNormalize || t.id < canonicalByNormalize.id) {
          canonicalByNormalize = t
        }
        continue
      }

      const sim = trigramJaccard(decoded, t.name)
      if (sim >= TOPIC_TRIGRAM_REJECT_THRESHOLD) {
        similar.push({ id: t.id, name: t.name, similarity: sim })
      }
    }

    similar.sort((a, b) => b.similarity - a.similarity)
    return {
      canonicalByNormalize,
      similar: similar.slice(0, TOPIC_SIMILAR_CANDIDATES_SURFACED),
    }
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
