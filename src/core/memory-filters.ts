import { MEMORY_PROPS } from "../notion/schema.js"
import { MEMORY_CLEANUP_ORPHAN_SENTINEL } from "./near-duplicate.js"
import { extractSelect } from "../notion/extractors.js"
import type { PageObjectResponse } from "@notionhq/client"

export const RETIRED_RECALL_SOURCES = ["agent_diary"] as const

/**
 * Server-side filter clause that excludes memories carrying the
 * cleanup-orphan sentinel (`MEMORY_CLEANUP_ORPHAN_SENTINEL`) in their
 * `Keywords` column.
 *
 * Threaded into every `dataSources.query` walker that surfaces live
 * memories to readers or other write paths. The semantic-search
 * post-filter applies the same exclusion client-side because
 * `client.search` has no property-filter support.
 */
export function cleanupOrphanExclusionFilter(): Record<string, unknown> {
  return {
    property: MEMORY_PROPS.KEYWORDS,
    rich_text: { does_not_contain: MEMORY_CLEANUP_ORPHAN_SENTINEL },
  }
}

/**
 * Compose the cleanup-orphan exclusion onto whatever filter shape the
 * caller already has. Each call returns fresh literals because caller
 * `and: [...]` arrays may be extended before reaching the SDK.
 */
export function withCleanupOrphanExclusion(
  filter: Record<string, unknown> | undefined
): Record<string, unknown> {
  const exclusion = cleanupOrphanExclusionFilter()
  if (filter === undefined) return exclusion
  if (Array.isArray((filter as { and?: unknown[] }).and)) {
    return {
      ...filter,
      and: [...((filter as { and: unknown[] }).and as unknown[]), exclusion],
    }
  }
  return { and: [filter, exclusion] }
}

export function retiredRecallSourceExclusionFilters(): Array<Record<string, unknown>> {
  return RETIRED_RECALL_SOURCES.map((source) => ({
    property: MEMORY_PROPS.SOURCE,
    select: { does_not_equal: source },
  }))
}

export function isNotRetiredRecallSource(page: PageObjectResponse): boolean {
  const source = extractSelect(page.properties[MEMORY_PROPS.SOURCE], "manual")
  return !RETIRED_RECALL_SOURCES.includes(
    source as (typeof RETIRED_RECALL_SOURCES)[number]
  )
}
