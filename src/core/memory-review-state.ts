import type { PageObjectResponse } from "@notionhq/client"
import { MEMORY_PROPS } from "../notion/schema.js"
import { extractSelect } from "../notion/extractors.js"

/**
 * Status values whose rows are excluded from default recall.
 */
export const REVIEW_TERMINAL_STATUSES = ["proposed", "rejected"] as const

/**
 * Default-recall exclusion filter clauses for review-terminal statuses.
 */
export function reviewTerminalStatusExclusionFilters(): Array<Record<string, unknown>> {
  return REVIEW_TERMINAL_STATUSES.map((status) => ({
    property: MEMORY_PROPS.STATUS,
    select: { does_not_equal: status },
  }))
}

/**
 * Client-side counterpart for semantic-search post-filtering.
 */
export function isNotReviewTerminalStatus(page: PageObjectResponse): boolean {
  const status = extractSelect(page.properties[MEMORY_PROPS.STATUS], "informational")
  return !REVIEW_TERMINAL_STATUSES.includes(
    status as (typeof REVIEW_TERMINAL_STATUSES)[number]
  )
}
