/**
 * Duplicate-topic detection and merge for legacy vaults.
 *
 * Pre-PR, `TopicService.getOrCreate(name, projectId)` only enforced
 * uniqueness *within* a project: a vault with "GraphQL federation" in
 * three projects genuinely had three Topic rows. After the single→dual
 * relation upgrade, `getOrCreate` routes through a global `findByName`
 * and extends the relation on the matched row — silently stranding
 * siblings. Running this merge collapses each duplicate-name group into
 * one canonical topic: union the Project relation onto the canonical,
 * re-point every memory that references a loser, archive the losers.
 */

import type { Client } from "@notionhq/client"
import type { CreatePageParameters, PageObjectResponse } from "@notionhq/client"
import type { DatabaseRef } from "../types.js"
import {
  isFullPage,
  extractTitle,
  extractRelationIds,
} from "../notion/extractors.js"

/** One duplicate-name group detected in the Topics DB. */
export interface DuplicateTopicGroup {
  name: string
  topicIds: string[]
}

/** Result of merging a single duplicate-name group. */
export interface TopicMergeResult {
  name: string
  /** The surviving Topic id. All sibling memories now reference this. */
  canonicalId: string
  /** Final Project relation on the canonical, as the union of all inputs. */
  canonicalProjectIds: string[]
  /** Topic ids that were archived (memories re-pointed off them). */
  archivedIds: string[]
  /** Memory ids whose Topic relation was re-pointed to `canonicalId`. */
  reassignedMemoryIds: string[]
}

/**
 * Scan the Topics DB and return every name that appears on ≥2 rows.
 *
 * Pulls one page of up to 100 at a time with cursor-based pagination, so
 * a vault with thousands of topics still reports faithfully. The result
 * is ordered by name (stable sort) so console output is deterministic.
 */
export async function findDuplicateTopicNames(
  client: Client,
  topicsDb: DatabaseRef
): Promise<DuplicateTopicGroup[]> {
  const allTopics: Array<{ id: string; name: string }> = []
  let cursor: string | undefined

  do {
    const response = await client.dataSources.query({
      data_source_id: topicsDb.dataSourceId,
      start_cursor: cursor,
      page_size: 100,
    })
    for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
      const name = extractTitle(page.properties["Name"])
      if (name.length > 0) allTopics.push({ id: page.id, name })
    }
    cursor = response.next_cursor ?? undefined
  } while (cursor)

  const byName = new Map<string, string[]>()
  for (const t of allTopics) {
    const existing = byName.get(t.name) ?? []
    existing.push(t.id)
    byName.set(t.name, existing)
  }

  return [...byName.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, topicIds]) => ({ name, topicIds }))
}

/**
 * Collapse every duplicate-name topic group in the vault into a single
 * canonical topic. Idempotent: a second run finds no duplicates and
 * returns an empty array.
 *
 * Merge algorithm per group:
 *   1. Fetch all rows sharing the name (paginated).
 *   2. Canonical = oldest `created_time`; ties broken by lexicographic
 *      page id so runs are reproducible across machines.
 *   3. Union every row's Project relation onto the canonical via one
 *      `pages.update` (only when a change is needed).
 *   4. For each loser, find every memory whose Topic relation contains
 *      that loser's id and re-point it to the canonical via
 *      `pages.update`.
 *   5. Archive each loser with `pages.update({ archived: true })`.
 *
 * Does not delete — `archived: true` is reversible in the Notion UI,
 * which matters if the merge picks the wrong canonical (e.g., when
 * descriptions diverge and the user wanted the loser's).
 */
export async function mergeDuplicateTopics(
  client: Client,
  topicsDb: DatabaseRef,
  memoriesDb: DatabaseRef,
  duplicates: DuplicateTopicGroup[]
): Promise<TopicMergeResult[]> {
  const results: TopicMergeResult[] = []
  for (const group of duplicates) {
    const result = await mergeOneGroup(client, topicsDb, memoriesDb, group.name)
    if (result) results.push(result)
  }
  return results
}

async function mergeOneGroup(
  client: Client,
  topicsDb: DatabaseRef,
  memoriesDb: DatabaseRef,
  name: string
): Promise<TopicMergeResult | null> {
  const pages = await listTopicPagesByName(client, topicsDb, name)
  if (pages.length <= 1) return null

  const sorted = [...pages].sort((a, b) => {
    const timeCompare = a.created_time.localeCompare(b.created_time)
    if (timeCompare !== 0) return timeCompare
    return a.id.localeCompare(b.id)
  })
  const [canonical, ...losers] = sorted

  const canonicalProjectIds = extractRelationIds(canonical.properties["Project"])
  const union = unionAllProjectIds(pages)
  const missing = union.filter((id) => !canonicalProjectIds.includes(id))
  const mergedProjectIds = [...canonicalProjectIds, ...missing]

  if (missing.length > 0) {
    await client.pages.update({
      page_id: canonical.id,
      properties: {
        Project: { relation: mergedProjectIds.map((id) => ({ id })) },
      } as CreatePageParameters["properties"],
    })
  }

  const reassignedMemoryIds: string[] = []
  for (const loser of losers) {
    const memoryIds = await listMemoryIdsByTopic(client, memoriesDb, loser.id)
    for (const memoryId of memoryIds) {
      await client.pages.update({
        page_id: memoryId,
        properties: {
          Topic: { relation: [{ id: canonical.id }] },
        } as CreatePageParameters["properties"],
      })
      reassignedMemoryIds.push(memoryId)
    }
  }

  const archivedIds: string[] = []
  for (const loser of losers) {
    await client.pages.update({
      page_id: loser.id,
      archived: true,
    })
    archivedIds.push(loser.id)
  }

  return {
    name,
    canonicalId: canonical.id,
    canonicalProjectIds: mergedProjectIds,
    archivedIds,
    reassignedMemoryIds,
  }
}

async function listTopicPagesByName(
  client: Client,
  topicsDb: DatabaseRef,
  name: string
): Promise<PageObjectResponse[]> {
  const results: PageObjectResponse[] = []
  let cursor: string | undefined

  do {
    const response = await client.dataSources.query({
      data_source_id: topicsDb.dataSourceId,
      filter: {
        property: "Name",
        title: { equals: name },
      },
      start_cursor: cursor,
    })
    results.push(...(response.results.filter(isFullPage) as PageObjectResponse[]))
    cursor = response.next_cursor ?? undefined
  } while (cursor)

  return results
}

async function listMemoryIdsByTopic(
  client: Client,
  memoriesDb: DatabaseRef,
  topicId: string
): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | undefined

  do {
    const response = await client.dataSources.query({
      data_source_id: memoriesDb.dataSourceId,
      filter: {
        property: "Topic",
        relation: { contains: topicId },
      },
      start_cursor: cursor,
      page_size: 100,
    })
    for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
      ids.push(page.id)
    }
    cursor = response.next_cursor ?? undefined
  } while (cursor)

  return ids
}

function unionAllProjectIds(pages: PageObjectResponse[]): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const page of pages) {
    for (const id of extractRelationIds(page.properties["Project"])) {
      if (seen.has(id)) continue
      seen.add(id)
      ordered.push(id)
    }
  }
  return ordered
}
