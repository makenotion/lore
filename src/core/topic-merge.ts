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
import { decodeTopicHtmlEntities } from "./topic.js"

/** One duplicate-name group detected in the Topics DB. */
export interface DuplicateTopicGroup {
  name: string
  topicIds: string[]
}

/** One topic row whose stored name contains HTML entities that would decode
 *  to a different (cleaner) string. Also used as the return shape of an
 *  in-place fix — once the row is decoded in Notion, the `rawName` field
 *  captures what the write replaced. */
export interface EncodedTopicRow {
  id: string
  /** The raw stored name, as Notion has it today. */
  rawName: string
  /** The decoded name — what the row should be updated to. */
  decodedName: string
}

/** Result of decoding a single encoded topic row's Name in place. Identical
 *  shape to `EncodedTopicRow` — kept as a semantic alias so call sites can
 *  distinguish "found" from "rewrote". */
export type TopicEncodingFixResult = EncodedTopicRow

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
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined
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

/** All topic rows in the DB together with their decoded name, as a single
 *  snapshot callers can branch on without re-querying Notion. */
interface TopicNameSnapshot {
  id: string
  rawName: string
  decodedName: string
}

async function scanTopicNames(
  client: Client,
  topicsDb: DatabaseRef
): Promise<TopicNameSnapshot[]> {
  const snapshot: TopicNameSnapshot[] = []
  let cursor: string | undefined

  do {
    const response = await client.dataSources.query({
      data_source_id: topicsDb.dataSourceId,
      start_cursor: cursor,
      page_size: 100,
    })
    for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
      const rawName = extractTitle(page.properties["Name"])
      if (rawName.length === 0) continue
      snapshot.push({
        id: page.id,
        rawName,
        decodedName: decodeTopicHtmlEntities(rawName),
      })
    }
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined
  } while (cursor)

  return snapshot
}

/**
 * Scan the Topics DB for rows whose Name contains HTML entity escape
 * sequences. Each returned row exposes both the raw name and the decoded
 * form it should be updated to.
 *
 * Paginates through the full database; result order is stable
 * (alphabetical by raw name). A no-op on a clean vault.
 */
export async function findEncodedTopicNames(
  client: Client,
  topicsDb: DatabaseRef
): Promise<EncodedTopicRow[]> {
  const snapshot = await scanTopicNames(client, topicsDb)
  return snapshot
    .filter((s) => s.rawName !== s.decodedName)
    .sort((a, b) => a.rawName.localeCompare(b.rawName))
}

/**
 * Predict the duplicate-name groups that `findDuplicateTopicNames` would
 * report *after* `fixTopicEncoding` runs, without mutating anything.
 *
 * Groups every topic row (including already-clean rows) by its decoded
 * name and returns any bucket of size ≥2. This is what lets
 * `VaultManager.migrate` validate all preconditions — encoding + post-decode
 * dups — before writing a single decoded Name, so a half-migrated state
 * isn't silently reachable by running `--fix-topic-encoding` alone on a
 * vault with cross-encoding pairs.
 *
 * Group `name` is the decoded form (what the canonical topic will carry
 * after the merge) so the returned values remain stable if the caller
 * displays them to the user.
 */
export async function findPostDecodeTopicCollisions(
  client: Client,
  topicsDb: DatabaseRef
): Promise<DuplicateTopicGroup[]> {
  const snapshot = await scanTopicNames(client, topicsDb)
  const byDecoded = new Map<string, string[]>()
  for (const t of snapshot) {
    const existing = byDecoded.get(t.decodedName) ?? []
    existing.push(t.id)
    byDecoded.set(t.decodedName, existing)
  }
  return [...byDecoded.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, topicIds]) => ({ name, topicIds }))
}

/**
 * Rewrite each encoded topic row's Name to the decoded form via
 * `pages.update`. Returns one result per row actually updated.
 *
 * Intended to run *before* `mergeDuplicateTopics` in the migration flow:
 * once every row carries its clean name, the standard name-equality
 * duplicate scan will collapse cross-encoding pairs (e.g. a legacy
 * `Build &amp;amp; Tooling` row and its cleanly-written `Build & Tooling`
 * sibling) without requiring the merger itself to understand entities.
 */
export async function fixTopicEncoding(
  client: Client,
  topicsDb: DatabaseRef
): Promise<TopicEncodingFixResult[]> {
  const encoded = await findEncodedTopicNames(client, topicsDb)
  const results: TopicEncodingFixResult[] = []

  for (const row of encoded) {
    await client.pages.update({
      page_id: row.id,
      properties: {
        Name: { title: [{ text: { content: row.decodedName } }] },
      } as CreatePageParameters["properties"],
    })
    results.push({
      id: row.id,
      rawName: row.rawName,
      decodedName: row.decodedName,
    })
  }

  return results
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
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined
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
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined
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
