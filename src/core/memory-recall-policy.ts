import type { PageObjectResponse } from "@notionhq/client"
import { MEMORY_PROPS } from "../notion/schema.js"
import { extractSelect } from "../notion/extractors.js"
import type { MemoryKind, MemorySource } from "../types.js"

export const DEFAULT_RECALL_EXCLUDED_SOURCES = [
  "agent_diary",
  "digest",
] as const satisfies readonly MemorySource[]

export const DEFAULT_RECALL_EXCLUDED_KINDS = [
  "task",
  "operational",
] as const satisfies readonly MemoryKind[]

export function defaultSourceExclusionFilters(): Array<Record<string, unknown>> {
  return DEFAULT_RECALL_EXCLUDED_SOURCES.map((source) => ({
    property: MEMORY_PROPS.SOURCE,
    select: { does_not_equal: source },
  }))
}

export function defaultKindExclusionFilters(
  explicitExclusions: readonly MemoryKind[] = []
): Array<Record<string, unknown>> {
  const explicit = new Set(explicitExclusions)
  return DEFAULT_RECALL_EXCLUDED_KINDS.filter((kind) => !explicit.has(kind)).map(
    (kind) => ({
      property: MEMORY_PROPS.KIND,
      select: { does_not_equal: kind },
    })
  )
}

export function isDefaultRecallSource(page: PageObjectResponse): boolean {
  const source = extractSelect(page.properties[MEMORY_PROPS.SOURCE], "manual")
  return !DEFAULT_RECALL_EXCLUDED_SOURCES.includes(
    source as (typeof DEFAULT_RECALL_EXCLUDED_SOURCES)[number]
  )
}

export function isDefaultRecallKind(page: PageObjectResponse): boolean {
  const kind = extractSelect(page.properties[MEMORY_PROPS.KIND], "note")
  return !DEFAULT_RECALL_EXCLUDED_KINDS.includes(
    kind as (typeof DEFAULT_RECALL_EXCLUDED_KINDS)[number]
  )
}
