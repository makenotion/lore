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
import { isFullPage, extractTitle, extractRelationIds } from "../notion/extractors.js"
import { buildTopicProps, MEMORY_PROPS, TOPIC_PROPS } from "../notion/schema.js"
import { decodeTextEntities } from "../notion/html-entities.js"
import { hydrateRelationPropertiesForPages } from "../notion/relation-properties.js"
import { normalizeTopicNameForLookup } from "./topic-normalize.js"

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
      const name = extractTitle(page.properties[TOPIC_PROPS.NAME])
      if (name.length > 0) allTopics.push({ id: page.id, name })
    }
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
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
      const rawName = extractTitle(page.properties[TOPIC_PROPS.NAME])
      if (rawName.length === 0) continue
      snapshot.push({
        id: page.id,
        rawName,
        decodedName: decodeTextEntities(rawName),
      })
    }
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
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
        [TOPIC_PROPS.NAME]: { title: [{ text: { content: row.decodedName } }] },
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

  const canonicalProjectIds = extractRelationIds(canonical.properties[TOPIC_PROPS.PROJECT])
  const union = unionAllProjectIds(pages)
  const missing = union.filter((id) => !canonicalProjectIds.includes(id))
  const mergedProjectIds = [...canonicalProjectIds, ...missing]

  if (missing.length > 0) {
    await client.pages.update({
      page_id: canonical.id,
      properties: {
        [TOPIC_PROPS.PROJECT]: { relation: mergedProjectIds.map((id) => ({ id })) },
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
          [MEMORY_PROPS.TOPIC]: { relation: [{ id: canonical.id }] },
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
        property: TOPIC_PROPS.NAME,
        title: { equals: name },
      },
      start_cursor: cursor,
    })
    results.push(...(response.results.filter(isFullPage) as PageObjectResponse[]))
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
  } while (cursor)

  return hydrateRelationPropertiesForPages(client, results, [TOPIC_PROPS.PROJECT])
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
        property: MEMORY_PROPS.TOPIC,
        relation: { contains: topicId },
      },
      start_cursor: cursor,
      page_size: 100,
    })
    for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
      ids.push(page.id)
    }
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
  } while (cursor)

  return ids
}

function unionAllProjectIds(pages: PageObjectResponse[]): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const page of pages) {
    for (const id of extractRelationIds(page.properties[TOPIC_PROPS.PROJECT])) {
      if (seen.has(id)) continue
      seen.add(id)
      ordered.push(id)
    }
  }
  return ordered
}

// ---------------------------------------------------------------------------
// Normalized-equivalent (similar) merges — issue #109 cleanup pass
// ---------------------------------------------------------------------------

/** One normalized-equivalent topic group detected in the Topics DB. Unlike
 *  `DuplicateTopicGroup`, the member rows have *different* stored names —
 *  they only collide once normalized via `normalizeTopicNameForLookup`. */
export interface SimilarTopicGroup {
  /** The normalized comparison key shared by every row in the group. */
  normalizedKey: string
  /** The chosen canonical's stored name. Selected by the same oldest-row
   *  rule used by `mergeDuplicateTopics`, so a re-run of the same scan
   *  produces the same canonical. */
  canonicalName: string
  /** The chosen canonical's id. */
  canonicalId: string
  /** Sibling topic ids whose stored names normalize to `normalizedKey`
   *  but differ from `canonicalName`. These are the rows the apply pass
   *  will collapse onto the canonical. */
  siblingIds: string[]
  /** Sibling stored names paired with their ids. Surfaced in the plan
   *  output so the operator can read what's about to be archived without
   *  having to cross-reference page ids in Notion. */
  siblings: Array<{ id: string; name: string }>
}

/**
 * Result of merging a single normalized-equivalent group. Mirrors the
 * shape of `TopicMergeResult` so the CLI's table-printing code can
 * uniformly report exact-match and normalized-equivalent passes.
 */
export interface SimilarTopicMergeResult {
  normalizedKey: string
  canonicalName: string
  canonicalId: string
  /** Final Project relation on the canonical, as the union of every
   *  sibling's pre-merge relation. */
  canonicalProjectIds: string[]
  /** Sibling topic ids that were archived (memories re-pointed off them). */
  archivedIds: string[]
  /** Memory ids whose Topic relation was re-pointed to `canonicalId`. */
  reassignedMemoryIds: string[]
}

/**
 * Scan the Topics DB and return every normalized-key group with two or
 * more rows where at least one row's stored name differs from another's.
 * Pure exact-name dupes are filtered out — those flow through
 * `findDuplicateTopicNames` / `--merge-duplicate-topics`, which is
 * the simpler, lower-blast-radius pass an operator runs first.
 *
 * Stable ordering by `normalizedKey` so console output is deterministic.
 */
export async function findSimilarTopicGroups(
  client: Client,
  topicsDb: DatabaseRef
): Promise<SimilarTopicGroup[]> {
  const allTopics: PageObjectResponse[] = []
  let cursor: string | undefined

  do {
    const response = await client.dataSources.query({
      data_source_id: topicsDb.dataSourceId,
      start_cursor: cursor,
      page_size: 100,
    })
    allTopics.push(...(response.results.filter(isFullPage) as PageObjectResponse[]))
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
  } while (cursor)

  const byKey = new Map<string, PageObjectResponse[]>()
  for (const page of allTopics) {
    const name = extractTitle(page.properties[TOPIC_PROPS.NAME])
    if (name.length === 0) continue
    const key = normalizeTopicNameForLookup(name)
    if (key.length === 0) continue
    const existing = byKey.get(key) ?? []
    existing.push(page)
    byKey.set(key, existing)
  }

  const groups: SimilarTopicGroup[] = []
  for (const [normalizedKey, pages] of byKey.entries()) {
    if (pages.length < 2) continue

    const distinctNames = new Set(pages.map((p) => extractTitle(p.properties[TOPIC_PROPS.NAME])))
    // Pure exact-name duplicates surface via `findDuplicateTopicNames`;
    // here we want only groups where stored names actually differ.
    if (distinctNames.size < 2) continue

    const sorted = [...pages].sort((a, b) => {
      const timeCompare = a.created_time.localeCompare(b.created_time)
      if (timeCompare !== 0) return timeCompare
      return a.id.localeCompare(b.id)
    })
    const [canonical, ...rest] = sorted
    groups.push({
      normalizedKey,
      canonicalName: extractTitle(canonical.properties[TOPIC_PROPS.NAME]),
      canonicalId: canonical.id,
      siblingIds: rest.map((p) => p.id),
      siblings: rest.map((p) => ({
        id: p.id,
        name: extractTitle(p.properties[TOPIC_PROPS.NAME]),
      })),
    })
  }

  return groups.sort((a, b) => a.normalizedKey.localeCompare(b.normalizedKey))
}

/**
 * Collapse every normalized-equivalent group into one canonical topic.
 * Idempotent: a second run finds no groups and returns an empty array.
 *
 * Same merge mechanics as `mergeDuplicateTopics`:
 *   1. Union every group member's Project relation onto the canonical.
 *   2. Re-point every memory whose Topic relation contains a sibling id
 *      to the canonical.
 *   3. Archive each sibling.
 *
 * Plan-then-execute: the caller passes `dryRun: true` to preview without
 * writing. Posture matches `--fix-fact-encoding` / `--fix-memory-encoding`
 * because the rewrite renames a topic out from under any URL or external
 * link the operator may hold to the loser row, and is harder to roll
 * back than the exact-name merge (un-archiving the loser leaves the
 * memories pointing at the canonical).
 */
export async function mergeSimilarTopics(
  client: Client,
  topicsDb: DatabaseRef,
  memoriesDb: DatabaseRef,
  groups: SimilarTopicGroup[],
  options: { dryRun?: boolean } = {}
): Promise<SimilarTopicMergeResult[]> {
  const results: SimilarTopicMergeResult[] = []
  for (const group of groups) {
    results.push(
      await mergeOneSimilarGroup(client, topicsDb, memoriesDb, group, {
        dryRun: options.dryRun === true,
      })
    )
  }
  return results
}

async function mergeOneSimilarGroup(
  client: Client,
  topicsDb: DatabaseRef,
  memoriesDb: DatabaseRef,
  group: SimilarTopicGroup,
  options: { dryRun: boolean }
): Promise<SimilarTopicMergeResult> {
  // Re-fetch canonical + siblings by id so we operate on the freshest
  // state — the scan that produced `group` may be minutes old by the
  // time the operator confirms the apply pass.
  const allIds = [group.canonicalId, ...group.siblingIds]
  const fetchedPages: PageObjectResponse[] = []
  for (const id of allIds) {
    const page = (await client.pages.retrieve({ page_id: id })) as PageObjectResponse
    if (page.archived) continue
    fetchedPages.push(page)
  }
  const pages = await hydrateRelationPropertiesForPages(client, fetchedPages, [TOPIC_PROPS.PROJECT])

  const canonical = pages.find((p) => p.id === group.canonicalId)
  if (!canonical) {
    // Canonical was archived between scan and apply. Skip the group —
    // a second scan after apply will pick a new canonical from the
    // surviving siblings.
    return {
      normalizedKey: group.normalizedKey,
      canonicalName: group.canonicalName,
      canonicalId: group.canonicalId,
      canonicalProjectIds: [],
      archivedIds: [],
      reassignedMemoryIds: [],
    }
  }
  const siblings = pages.filter((p) => p.id !== group.canonicalId)

  const canonicalProjectIds = extractRelationIds(canonical.properties[TOPIC_PROPS.PROJECT])
  const union = unionAllProjectIds(pages)
  const missing = union.filter((id) => !canonicalProjectIds.includes(id))
  const mergedProjectIds = [...canonicalProjectIds, ...missing]

  if (missing.length > 0 && !options.dryRun) {
    await client.pages.update({
      page_id: canonical.id,
      properties: {
        [TOPIC_PROPS.PROJECT]: { relation: mergedProjectIds.map((id) => ({ id })) },
      } as CreatePageParameters["properties"],
    })
  }

  const reassignedMemoryIds: string[] = []
  for (const sibling of siblings) {
    const memoryIds = await listMemoryIdsByTopic(client, memoriesDb, sibling.id)
    for (const memoryId of memoryIds) {
      if (!options.dryRun) {
        await client.pages.update({
          page_id: memoryId,
          properties: {
            [MEMORY_PROPS.TOPIC]: { relation: [{ id: canonical.id }] },
          } as CreatePageParameters["properties"],
        })
      }
      reassignedMemoryIds.push(memoryId)
    }
  }

  const archivedIds: string[] = []
  for (const sibling of siblings) {
    if (!options.dryRun) {
      await client.pages.update({
        page_id: sibling.id,
        archived: true,
      })
    }
    archivedIds.push(sibling.id)
  }

  return {
    normalizedKey: group.normalizedKey,
    canonicalName: group.canonicalName,
    canonicalId: group.canonicalId,
    canonicalProjectIds: mergedProjectIds,
    archivedIds,
    reassignedMemoryIds,
  }
}

// ---------------------------------------------------------------------------
// Alias-list semantic merges
// ---------------------------------------------------------------------------

/**
 * One canonical ↔ aliases merge plan — the unit of operator-curated
 * semantic consolidation. Unlike `DuplicateTopicGroup` (which only collapses
 * rows with identical names), an alias plan consolidates *different* names
 * onto one canonical, e.g. `{ canonical: "Build & Tooling", aliases:
 * ["Build System", "Build tooling"] }`.
 */
export interface TopicAliasMergePlan {
  canonical: string
  aliases: string[]
}

/**
 * Outcome of one alias merge plan. Same shape for dry-run preview and
 * actual apply: on dry-run, the fields describe what would happen.
 *
 * Multi-row aliases: if an alias name resolves to more than one topic
 * row (because a legacy vault double-created it), every row is archived
 * and every memory under every row is re-pointed onto the canonical.
 * No tiebreaker is needed because the alias is never the survivor —
 * same-name duplicates between aliases collapse as a side effect of
 * the canonical merge.
 */
export interface TopicAliasMergeResult {
  canonical: string
  /** The canonical topic id.
   *  - apply: always populated (pre-existing row or row created here).
   *  - dryRun: null when the plan would create a new canonical row. */
  canonicalId: string | null
  /** True when the canonical row would be (dryRun) / was (apply) created. */
  canonicalCreated: boolean
  /** Final Project relation on canonical — union of canonical + all
   *  aliases. On dry-run, what the union would be. */
  canonicalProjectIds: string[]
  /** Alias topic rows archived (or that would be archived). Grouped by
   *  alias name for output clarity. */
  archivedAliases: Array<{ name: string; id: string }>
  /** Memory ids whose Topic relation was / would be re-pointed to the
   *  canonical. */
  reassignedMemoryIds: string[]
  /** Alias names in the plan that matched no topic row. Typically means
   *  the migration already ran — but can also surface a stale alias in
   *  the YAML that never existed. */
  unmatchedAliases: string[]
  /** True when the plan has no effect — every alias is already absent. */
  noop: boolean
}

/**
 * Reject overlapping or malformed merge plans before any Notion work
 * runs. Throws with a message that names the specific conflict so the
 * operator can fix their YAML without re-running the migration.
 *
 * Catches:
 * - empty canonical or alias strings
 * - a plan with no aliases
 * - duplicate aliases within a plan
 * - alias equal to its own canonical
 * - the same canonical listed in two plans
 * - the same alias listed in two plans with different canonicals
 * - a canonical in one plan appearing as an alias in another
 */
export function validateTopicAliasMergePlans(plans: TopicAliasMergePlan[]): void {
  const canonicals = new Set<string>()
  const aliasOwner = new Map<string, string>()

  for (const plan of plans) {
    const canonical = plan.canonical.trim()
    if (canonical.length === 0) {
      throw new Error("Merge plan has an empty canonical name.")
    }
    if (plan.aliases.length === 0) {
      throw new Error(`Merge plan for "${canonical}" has no aliases.`)
    }
    if (canonicals.has(canonical)) {
      throw new Error(
        `Canonical "${canonical}" appears in more than one merge plan. ` +
          "List every alias for a canonical under a single plan."
      )
    }
    canonicals.add(canonical)

    const seenInPlan = new Set<string>()
    for (const rawAlias of plan.aliases) {
      const alias = rawAlias.trim()
      if (alias.length === 0) {
        throw new Error(`Merge plan for "${canonical}" has an empty alias.`)
      }
      if (alias === canonical) {
        throw new Error(
          `Alias "${alias}" equals its canonical in the plan for "${canonical}".`
        )
      }
      if (seenInPlan.has(alias)) {
        throw new Error(`Alias "${alias}" listed twice in the plan for "${canonical}".`)
      }
      seenInPlan.add(alias)

      const owner = aliasOwner.get(alias)
      if (owner !== undefined && owner !== canonical) {
        throw new Error(
          `Alias "${alias}" appears in plans for both "${owner}" and ` +
            `"${canonical}". An alias can belong to exactly one canonical.`
        )
      }
      aliasOwner.set(alias, canonical)
    }
  }

  for (const canonical of canonicals) {
    const otherCanonical = aliasOwner.get(canonical)
    if (otherCanonical !== undefined) {
      throw new Error(
        `Topic "${canonical}" is a canonical in its own plan but an alias ` +
          `in the plan for "${otherCanonical}". Resolve the chain before merging.`
      )
    }
  }
}

/**
 * Apply a curated list of alias merges. For each plan, every topic row
 * whose name matches an alias is re-pointed onto the canonical and then
 * archived. Memories referencing an archived alias get their Topic
 * relation replaced with the canonical id.
 *
 * Canonical resolution:
 * - exactly one row with `canonical` name → use it
 * - zero rows → create a new canonical row (with the project union as
 *   its initial Project relation). Skipped on dry-run.
 * - multiple rows → throws, with a directive to run
 *   `--merge-duplicate-topics` first.
 *
 * Idempotency: after a successful run, re-running finds no alias rows
 * and every plan returns `noop: true`. This is the property the task's
 * acceptance criterion relies on.
 *
 * Names in `plans` are decoded via the shared HTML-entity helper on
 * entry so a YAML listing `Build & Tooling` matches DB rows that still
 * read `Build &amp; Tooling`. In practice the encoding migration (P1-10)
 * should run first, but decoding on entry keeps the two migrations
 * order-independent for well-formed YAML.
 */
export async function mergeTopicsByAliasPlans(
  client: Client,
  topicsDb: DatabaseRef,
  memoriesDb: DatabaseRef,
  plans: TopicAliasMergePlan[],
  options: { dryRun?: boolean } = {}
): Promise<TopicAliasMergeResult[]> {
  const normalized = plans.map((p) => ({
    canonical: decodeTextEntities(p.canonical),
    aliases: p.aliases.map((a) => decodeTextEntities(a)),
  }))
  validateTopicAliasMergePlans(normalized)

  const results: TopicAliasMergeResult[] = []
  for (const plan of normalized) {
    results.push(
      await mergeOneAliasPlan(client, topicsDb, memoriesDb, plan, {
        dryRun: options.dryRun === true,
      })
    )
  }
  return results
}

async function mergeOneAliasPlan(
  client: Client,
  topicsDb: DatabaseRef,
  memoriesDb: DatabaseRef,
  plan: TopicAliasMergePlan,
  options: { dryRun: boolean }
): Promise<TopicAliasMergeResult> {
  const canonicalRows = await listTopicPagesByName(client, topicsDb, plan.canonical)
  if (canonicalRows.length > 1) {
    throw new Error(
      `Canonical "${plan.canonical}" resolves to ${canonicalRows.length} topic rows. ` +
        "Run `lore migrate --merge-duplicate-topics` to collapse same-name duplicates first."
    )
  }

  const aliasMatches: Array<{ alias: string; rows: PageObjectResponse[] }> = []
  const unmatchedAliases: string[] = []
  for (const alias of plan.aliases) {
    const rows = await listTopicPagesByName(client, topicsDb, alias)
    if (rows.length === 0) {
      unmatchedAliases.push(alias)
    } else {
      aliasMatches.push({ alias, rows })
    }
  }

  const aliasRows = aliasMatches.flatMap((m) => m.rows)
  const existingCanonical = canonicalRows[0] ?? null

  // Noop short-circuit. Report canonical state (if any) so dry-run output
  // can distinguish "nothing to do" from "canonical would be newly created".
  if (aliasRows.length === 0) {
    return {
      canonical: plan.canonical,
      canonicalId: existingCanonical?.id ?? null,
      canonicalCreated: false,
      canonicalProjectIds: existingCanonical
        ? extractRelationIds(existingCanonical.properties[TOPIC_PROPS.PROJECT])
        : [],
      archivedAliases: [],
      reassignedMemoryIds: [],
      unmatchedAliases,
      noop: true,
    }
  }

  const unionProjectIds = unionAllProjectIds([
    ...(existingCanonical ? [existingCanonical] : []),
    ...aliasRows,
  ])

  let canonicalId: string | null = existingCanonical?.id ?? null
  let canonicalCreated = false
  if (!existingCanonical) {
    if (!options.dryRun) {
      const created = (await client.pages.create({
        parent: { type: "database_id", database_id: topicsDb.databaseId },
        properties: buildTopicProps({
          name: plan.canonical,
          projectIds: unionProjectIds,
        }),
      })) as PageObjectResponse
      canonicalId = created.id
    }
    canonicalCreated = true
  } else {
    const canonicalProjectIds = extractRelationIds(
      existingCanonical.properties[TOPIC_PROPS.PROJECT]
    )
    const missing = unionProjectIds.filter((id) => !canonicalProjectIds.includes(id))
    if (missing.length > 0 && !options.dryRun) {
      await client.pages.update({
        page_id: existingCanonical.id,
        properties: {
          [TOPIC_PROPS.PROJECT]: { relation: unionProjectIds.map((id) => ({ id })) },
        } as CreatePageParameters["properties"],
      })
    }
  }

  const archivedAliases: Array<{ name: string; id: string }> = []
  const reassignedMemoryIds: string[] = []

  for (const match of aliasMatches) {
    for (const row of match.rows) {
      const memoryIds = await listMemoryIdsByTopic(client, memoriesDb, row.id)
      for (const memoryId of memoryIds) {
        if (!options.dryRun && canonicalId !== null) {
          await client.pages.update({
            page_id: memoryId,
            properties: {
              [MEMORY_PROPS.TOPIC]: { relation: [{ id: canonicalId }] },
            } as CreatePageParameters["properties"],
          })
        }
        reassignedMemoryIds.push(memoryId)
      }
      if (!options.dryRun) {
        await client.pages.update({
          page_id: row.id,
          archived: true,
        })
      }
      archivedAliases.push({ name: match.alias, id: row.id })
    }
  }

  return {
    canonical: plan.canonical,
    canonicalId,
    canonicalCreated,
    canonicalProjectIds: unionProjectIds,
    archivedAliases,
    reassignedMemoryIds,
    unmatchedAliases,
    noop: false,
  }
}
