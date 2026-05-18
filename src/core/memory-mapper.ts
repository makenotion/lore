// ABOUTME: Owns conversion from Notion memory pages into Memory domain objects and relation hydration.
// ABOUTME: Edit when memory schema fields, scope extraction, or materialization shape change.

import type { Client, PageObjectResponse } from "@notionhq/client"
import type {
  Memory,
  MemoryConfidence as MemoryConfidenceLevel,
  MemoryKind,
  MemoryLifetime,
  MemoryScope,
  MemoryScopeKind,
  MemorySource,
  MemoryStatus,
  TaskState,
} from "../types.js"
import { MEMORY_PROPS } from "../notion/schema.js"
import {
  extractDate,
  extractMultiSelect,
  extractNumber,
  extractRelationIds,
  extractRichText,
  extractSelect,
  extractTitle,
} from "../notion/extractors.js"
import {
  hydrateRelationProperties,
  hydrateRelationPropertiesForPages,
} from "../notion/relation-properties.js"
import { extractMemoryPinned } from "./memory-pinned.js"

const MEMORY_RELATION_PROPERTIES = [
  MEMORY_PROPS.PROJECT,
  MEMORY_PROPS.TOPIC,
  MEMORY_PROPS.SUPERSEDES,
  MEMORY_PROPS.AFFECTS,
  MEMORY_PROPS.COMPARED_WITH,
] as const

export async function hydrateMemoryRelationProperties(
  client: Client,
  page: PageObjectResponse
): Promise<PageObjectResponse> {
  return hydrateRelationProperties(client, page, MEMORY_RELATION_PROPERTIES)
}

export async function hydrateMemoryRelationPropertiesForPages(
  client: Client,
  pages: readonly PageObjectResponse[]
): Promise<PageObjectResponse[]> {
  return hydrateRelationPropertiesForPages(client, pages, MEMORY_RELATION_PROPERTIES)
}

export class MemoryMapper {
  constructor(private readonly client: Client) {}

  async pageToMemory(page: PageObjectResponse, content?: string): Promise<Memory> {
    return pageToMemory(await hydrateMemoryRelationProperties(this.client, page), content)
  }

  /**
   * Hydrate a list of `PageObjectResponse` rows into `Memory` domain types,
   * honoring `includeContent`. Called exactly once at the top of `search()`
   * on the final merged-and-capped page list, so hybrid never fetches
   * markdown for candidates that won't survive the dedupe and limit cap.
   */
  async materializeMemories(
    pages: PageObjectResponse[],
    includeContent: boolean | undefined
  ): Promise<Memory[]> {
    if (includeContent === false) {
      return Promise.all(pages.map((page) => this.pageToMemory(page, "")))
    }
    return Promise.all(
      pages.map(async (page) => {
        const md = await this.client.pages.retrieveMarkdown({ page_id: page.id })
        return await this.pageToMemory(page, md.markdown)
      })
    )
  }
}

/**
 * Convert a Notion page object to a `Memory` domain type. Pure function —
 * exported for unit testing. The hardened extractors guarantee graceful
 * defaults for pages that pre-date any schema addition: an unmigrated
 * page returns `kind: "note"`, `status: "informational"`, etc.
 */
export function pageToMemory(page: PageObjectResponse, content?: string): Memory {
  const props = page.properties
  const topicIds = extractRelationIds(props[MEMORY_PROPS.TOPIC])
  const session = extractRichText(props[MEMORY_PROPS.SESSION]).trim()

  // Read `Task State` only when the column exists *and* a select is set.
  // `extractSelect` falls back when the column is missing — fine for
  // unmigrated pages — but we want a true `null` (not `"open"`) on
  // every non-task memory so downstream code can branch on the field.
  const taskStateProp = props[MEMORY_PROPS.TASK_STATE]
  const taskState =
    taskStateProp && taskStateProp.type === "select" && taskStateProp.select
      ? (taskStateProp.select.name as TaskState)
      : null

  return {
    id: page.id,
    title: extractTitle(props[MEMORY_PROPS.TITLE]),
    projectIds: extractRelationIds(props[MEMORY_PROPS.PROJECT]),
    topicId: topicIds[0] ?? null,
    source: extractSelect(props[MEMORY_PROPS.SOURCE], "manual") as MemorySource,
    // Decision-related columns. Pre-migration pages default gracefully
    // via the hardened extractors — no backfill required.
    kind: extractSelect(props[MEMORY_PROPS.KIND], "note") as MemoryKind,
    status: extractSelect(props[MEMORY_PROPS.STATUS], "informational") as MemoryStatus,
    confidence: extractSelect(
      props[MEMORY_PROPS.CONFIDENCE],
      "certain"
    ) as MemoryConfidenceLevel,
    confidenceScore: extractNumber(props[MEMORY_PROPS.CONFIDENCE_SCORE]),
    reviewBy: extractDate(props[MEMORY_PROPS.REVIEW_BY]),
    doneAt: extractDate(props[MEMORY_PROPS.DONE_AT]),
    decidedAt: extractDate(props[MEMORY_PROPS.DECIDED_AT]),
    lastReferencedAt: extractDate(props[MEMORY_PROPS.LAST_REFERENCED_AT]),
    supersedesIds: extractRelationIds(props[MEMORY_PROPS.SUPERSEDES]),
    affectsIds: extractRelationIds(props[MEMORY_PROPS.AFFECTS]),
    alternatives: extractRichText(props[MEMORY_PROPS.ALTERNATIVES]),
    consequences: extractRichText(props[MEMORY_PROPS.CONSEQUENCES]),
    author: extractRichText(props[MEMORY_PROPS.AUTHOR]),
    agent: extractRichText(props[MEMORY_PROPS.AGENT]),
    tags: extractMultiSelect(props[MEMORY_PROPS.TAGS]),
    keywords: extractRichText(props[MEMORY_PROPS.KEYWORDS]),
    synopsis: extractRichText(props[MEMORY_PROPS.SYNOPSIS]),
    session: session.length > 0 ? session : null,
    content: content ?? "",
    createdAt: page.created_time,
    updatedAt: page.last_edited_time,
    taskState,
    blockedBy: extractRichText(props[MEMORY_PROPS.BLOCKED_BY]),
    entity: extractRichText(props[MEMORY_PROPS.ENTITY]),
    topicKey: extractRichText(props[MEMORY_PROPS.TOPIC_KEY]),
    // Legacy rows have a null `Revision Count` column. Coalesce
    // to 1 — every existing row has been "saved once," so
    // `formatMemoryListItem` treats the count as single-revision
    // and surfaces no `rev` line. Distinct from the Confidence Score
    // path (which preserves null to signal "never scored") because
    // Revision Count carries no "uninitialized" semantic — every row
    // has been written at least once by definition.
    revisionCount: extractNumber(props[MEMORY_PROPS.REVISION_COUNT]) ?? 1,
    comparedWith: extractRelationIds(props[MEMORY_PROPS.COMPARED_WITH]),
    compareNotes: extractRichText(props[MEMORY_PROPS.COMPARE_NOTES]),
    promotionSourceKey: extractRichText(props[MEMORY_PROPS.PROMOTION_SOURCE_KEY]),
    scope: extractMemoryScope(props),
    pinned: extractMemoryPinned(props),
  }
}

/**
 * Read the five scope columns into a `MemoryScope` bundle. Returns
 * `null` when all five columns are empty/missing. Vaults with the
 * scope schema migration applied but without backfilled scope still
 * pass through this branch; default retrieval treats null scope as
 * broadcast.
 *
 * Returns a populated `MemoryScope` with `kind: null` / `lifetime:
 * null` when only one column has been written (e.g. an operator set
 * `Lifetime` on a row but left `Scope Kind` empty) — same surface as
 * a row mid-scope-migration.
 */
export function extractMemoryScope(
  props: PageObjectResponse["properties"]
): MemoryScope | null {
  const kindProp = props[MEMORY_PROPS.SCOPE_KIND]
  const kind =
    kindProp && kindProp.type === "select" && kindProp.select
      ? (kindProp.select.name as MemoryScopeKind)
      : null
  const key = extractRichText(props[MEMORY_PROPS.SCOPE_KEY])
  const audience = extractRichText(props[MEMORY_PROPS.AUDIENCE])
  const lifetimeProp = props[MEMORY_PROPS.LIFETIME]
  const lifetime =
    lifetimeProp && lifetimeProp.type === "select" && lifetimeProp.select
      ? (lifetimeProp.select.name as MemoryLifetime)
      : null
  const expiresAt = extractDate(props[MEMORY_PROPS.EXPIRES_AT])
  if (
    kind === null &&
    lifetime === null &&
    expiresAt === null &&
    key.length === 0 &&
    audience.length === 0
  ) {
    return null
  }
  return { kind, key, audience, lifetime, expiresAt }
}
