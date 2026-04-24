/**
 * Fact operations — the knowledge graph layer.
 *
 * Facts store entity-relationship triples with temporal validity windows.
 * Example: "AuthMiddleware" --uses--> "JWT" (valid from 2025-01-15)
 */

import type { Client } from "@notionhq/client"
import type {
  PageObjectResponse,
  QueryDataSourceParameters,
  UpdatePageParameters,
} from "@notionhq/client"
import type {
  Fact,
  CreateFactInput,
  FactPredicate,
  FactConfidence,
  DatabaseRef,
} from "../types.js"
import { TRACKING_PREDICATES } from "../types.js"
import { buildFactProps } from "../notion/schema.js"
import { projectOrUnscopedFilter } from "../notion/filters.js"
import { computeFactDedupKey } from "../notion/normalize.js"
import { decodeTextEntities } from "../notion/html-entities.js"
import {
  runFactDedupBackfill,
  type FactDedupBackfillResult,
  type FactDedupOptions,
} from "./fact-dedup.js"
import {
  isFullPage,
  extractTitle,
  extractRichText,
  extractSelect,
  extractRelationIds,
  extractDate,
} from "../notion/extractors.js"

type QueryFactsOpts = {
  projectId?: string
  includeInvalidated?: boolean
  predicates?: FactPredicate[]
  /**
   * Cap total results. Pagination stops as soon as this is reached.
   * Without a limit, all matching facts are fetched across pages.
   */
  limit?: number
}

type ListRecentOpts = {
  projectId?: string
  /**
   * Predicates to exclude server-side via `AND (Predicate does_not_equal ...)`.
   * Callers partitioning the knowledge graph (e.g. wake-up splitting open
   * loops from recent knowledge facts) pass `TRACKING_PREDICATES` here so the
   * filter runs in Notion, not after the page is loaded.
   */
  excludePredicates?: FactPredicate[]
  /**
   * Maximum rows returned. The query is single-page by design — callers on
   * the hot path (`loadWakeUpData`) cannot afford pagination loops. Clamped
   * to Notion's 100-row ceiling.
   */
  limit?: number
  includeInvalidated?: boolean
}

/** Notion's hard ceiling on `page_size`. */
const NOTION_MAX_PAGE_SIZE = 100

/**
 * A created-or-deduped fact. `deduped === true` means the write was absorbed
 * into an existing live row (same normalized triple) and the caller should
 * surface that to the user instead of silently returning a stale-looking ID.
 *
 * `enriched` lists the metadata fields that were merged onto the existing row
 * on dedup hit — projects union'd, source memory linked, review extended.
 * Empty when the probe missed (fresh row) or hit with nothing new to add.
 * Exposed so `lore-learn` can tell the agent "this wasn't a no-op, we
 * attached your session to the pre-existing fact."
 */
export interface CreateFactResult {
  fact: Fact
  deduped: boolean
  enriched: string[]
}

/**
 * On a pre-migration vault every `lore-learn` probe fails with the same
 * "DedupKey column missing" error. Autosave fires every 5 messages, so
 * logging per-probe turns the MCP server's stderr into a firehose. The
 * fix is guaranteed by `lore migrate`, so we warn once per process and
 * then stay quiet.
 */
let probeFailureLogged = false
function logProbeFailureOnce(err: unknown): void {
  if (probeFailureLogged) return
  probeFailureLogged = true
  console.error(
    "[lore] Fact dedup probe failed, falling back to blind create. " +
      "Run `lore migrate` to add the DedupKey column. Underlying error:",
    err instanceof Error ? err.message : err
  )
}

/** Reset between tests. Not exported on the public API surface. */
export function __resetProbeFailureLogForTests(): void {
  probeFailureLogged = false
}

export class FactService {
  constructor(
    private client: Client,
    private db: DatabaseRef
  ) {}

  async create(input: CreateFactInput): Promise<Fact> {
    const { fact } = await this.createWithDedup(input)
    return fact
  }

  /**
   * Create a fact with write-side deduplication.
   *
   * Probes for a live (Valid Until IS NULL) row with the same normalized
   * triple via the `DedupKey` column before writing. On hit, merges the
   * new call's metadata onto the existing row and returns it with
   * `deduped: true`:
   *
   * - `reviewBy` replaces the existing value when newer (extend runway).
   * - `projectIds` are unioned into `Project` (a fact learned from project Y
   *   that already exists on X becomes scoped to both).
   * - `sourceMemoryId` fills `Source` only when the existing row is
   *   orphaned (first-writer-wins — preserves the "no orphan facts"
   *   contract without clobbering an earlier provenance link).
   *
   * The set of mutations is returned in `enriched` so `lore-learn` can
   * surface them; "deduped" without enrichment means "matched, nothing new
   * to merge."
   *
   * On miss — or on probe failure — falls through to a plain create with
   * the dedup key attached. Cost: one extra `dataSources.query` per write
   * on cold miss, which is cheaper than the eventual `lore-ask` /
   * wake-up tax from duplicates.
   *
   * Concurrency: Notion has no unique-index or conditional-write primitive,
   * so two concurrent writers with the same triple can both see an empty
   * probe and both create rows. This applies to both cross-process callers
   * and intra-process back-to-back autosaves (Notion's query index is
   * eventually consistent by a few hundred ms). The
   * `lore migrate --dedup-keys --merge` pass is the authoritative collapse
   * path for any duplicates that slip through.
   */
  async createWithDedup(input: CreateFactInput): Promise<CreateFactResult> {
    // Decode at the write boundary so a doubly-encoded `Foo &amp;amp; Bar`
    // input flowing in from the autosave/markdown path lands in Notion as
    // `Foo & Bar`. Idempotent — a clean value passes through unchanged.
    // Done before dedup-key computation so two inputs that differ only by
    // encoding level collapse onto the same live row.
    const decodedInput: CreateFactInput = {
      ...input,
      subject: decodeTextEntities(input.subject),
      object: decodeTextEntities(input.object),
    }

    let reviewBy = decodedInput.reviewBy
    if (!reviewBy && TRACKING_PREDICATES.includes(decodedInput.predicate)) {
      const d = new Date()
      d.setDate(d.getDate() + 7)
      reviewBy = d.toISOString().split("T")[0]
    }

    const dedupKey = computeFactDedupKey({
      subject: decodedInput.subject,
      predicate: decodedInput.predicate,
      object: decodedInput.object,
    })

    const existing = await this.findLiveByDedupKey(dedupKey).catch((err) => {
      // Probe failure (e.g. transient network blip, or a pre-migration vault
      // that still lacks the DedupKey column) must not block the write. Log
      // once per process and fall through to the blind-create path —
      // worst case we create a duplicate the next migrate pass will
      // collapse.
      logProbeFailureOnce(err)
      return null
    })

    if (existing) {
      const enriched = await this.mergeOntoExisting(existing, decodedInput, reviewBy)
      return { fact: existing, deduped: true, enriched }
    }

    const page = await this.client.pages.create({
      parent: { type: "database_id", database_id: this.db.databaseId },
      properties: buildFactProps({
        subject: decodedInput.subject,
        predicate: decodedInput.predicate,
        object: decodedInput.object,
        projectIds: decodedInput.projectIds,
        validFrom: decodedInput.validFrom ?? new Date().toISOString().split("T")[0],
        reviewBy,
        sourceMemoryId: decodedInput.sourceMemoryId,
        confidence: decodedInput.confidence ?? "certain",
        dedupKey,
      }),
    })

    return {
      fact: this.pageToFact(page as PageObjectResponse),
      deduped: false,
      enriched: [],
    }
  }

  /**
   * Merge an incoming `CreateFactInput` onto a deduped existing row via a
   * single atomic `pages.update` that touches only the properties which
   * actually need mutation. A no-op call (same review, projects already
   * linked, source already set) issues zero API calls and returns `[]`.
   * Mutates `existing` in place so the returned fact reflects the new state.
   *
   * One request instead of three serial writes halves round-trip cost on
   * full-enrichment hits and eliminates the intermediate "2 of 3 written"
   * state the old sequential path could leave behind on failure —
   * `pages.update` is per-request atomic at the Notion API, so either the
   * whole properties payload lands or none of it does.
   *
   * `enriched[]` order is deterministic: `Review By`, then `Project`, then
   * `Source`. Previously each string was pushed after its own successful
   * update so the array reflected Notion confirmation order; after the
   * collapse, ordering is mechanical. No user-visible change — no
   * downstream renderer relies on the order — but the test suite does
   * pin it at `fact.test.ts:737`, so a future refactor that flips the
   * order must update the fixture. Worth noting so a future reader
   * doesn't read it as an accidental invariant.
   *
   * The `decodedInput` parameter name is load-bearing: `createWithDedup`
   * decodes HTML entities on subject/object BEFORE calling this method, and
   * the dedup-key collision semantics depend on the decoded values. A
   * future caller that passes raw `CreateFactInput` would re-open the
   * PF1-06 bug class — the name forces that mistake to be visible.
   */
  private async mergeOntoExisting(
    existing: Fact,
    decodedInput: CreateFactInput,
    reviewBy: string | undefined
  ): Promise<string[]> {
    const properties: Record<string, unknown> = {}
    const enriched: string[] = []

    // Parallel boolean flags for the three mutations. Hoisted so the
    // post-write mirror block doesn't re-evaluate the same conditions.
    const extendingReview = Boolean(reviewBy) && reviewBy !== existing.reviewBy
    const missingProjectIds = (decodedInput.projectIds ?? []).filter(
      (id) => !existing.projectIds.includes(id)
    )
    const mergedProjectIds =
      missingProjectIds.length > 0
        ? [...existing.projectIds, ...missingProjectIds]
        : null
    // First-writer-wins on Source: if the existing row already has a
    // source memory we don't clobber it (PR #44's "no orphans" contract
    // only cares about filling the gap, not re-pointing a linked row).
    const fillingSource = Boolean(!existing.sourceMemoryId && decodedInput.sourceMemoryId)

    if (extendingReview) {
      properties["Review By"] = { date: { start: reviewBy } }
      enriched.push(`extended review to ${reviewBy}`)
    }
    if (mergedProjectIds) {
      properties["Project"] = {
        relation: mergedProjectIds.map((id) => ({ id })),
      }
      enriched.push(
        `added ${missingProjectIds.length} project${missingProjectIds.length === 1 ? "" : "s"}`
      )
    }
    if (fillingSource) {
      properties["Source"] = {
        relation: [{ id: decodedInput.sourceMemoryId }],
      }
      enriched.push("linked source memory")
    }

    if (Object.keys(properties).length === 0) return []

    // Single atomic write — Notion accepts every mutated property in one
    // request. On failure the throw propagates; the caller sees no
    // `enriched` result, matching the old sequential path's error shape.
    await this.client.pages.update({
      page_id: existing.id,
      properties: properties as UpdatePageParameters["properties"],
    })

    // Mirror the write into the in-memory fact only after the round-trip
    // succeeds so a throw leaves `existing` untouched.
    if (extendingReview) existing.reviewBy = reviewBy ?? null
    if (mergedProjectIds) existing.projectIds = mergedProjectIds
    // `?? null` is dead at runtime — `fillingSource` truthy implies
    // `decodedInput.sourceMemoryId` is a non-empty string — but required for
    // TS to narrow `string | undefined` to `Fact.sourceMemoryId: string | null`.
    if (fillingSource) existing.sourceMemoryId = decodedInput.sourceMemoryId ?? null

    return enriched
  }

  /**
   * Look up a live fact (Valid Until IS NULL) by normalized dedup key.
   * Returns `null` when no live match exists. Invalidated rows with the
   * same key are deliberately ignored so history stays intact and the
   * caller writes a fresh live row when a triple is re-asserted after
   * correction.
   */
  private async findLiveByDedupKey(dedupKey: string): Promise<Fact | null> {
    const response = await this.client.dataSources.query({
      data_source_id: this.db.dataSourceId,
      filter: {
        and: [
          { property: "DedupKey", rich_text: { equals: dedupKey } },
          { property: "Valid Until", date: { is_empty: true } },
        ],
      } as QueryDataSourceParameters["filter"],
      page_size: 1,
    })

    const pages = response.results.filter(isFullPage) as PageObjectResponse[]
    if (pages.length === 0) return null
    return this.pageToFact(pages[0])
  }

  async queryBySubject(
    subject: string,
    opts?: QueryFactsOpts,
  ): Promise<Fact[]> {
    const filters: Array<Record<string, unknown>> = []

    // Allow empty subject to list all facts in scope
    if (subject) {
      filters.push({ property: "Subject", title: { contains: subject } })
    }

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }

    if (!opts?.includeInvalidated) {
      filters.push({
        property: "Valid Until",
        date: { is_empty: true },
      })
    }

    if (opts?.predicates?.length) {
      if (opts.predicates.length === 1) {
        filters.push({
          property: "Predicate",
          select: { equals: opts.predicates[0] },
        })
      } else {
        filters.push({
          or: opts.predicates.map((p) => ({
            property: "Predicate",
            select: { equals: p },
          })),
        })
      }
    }

    const filter =
      filters.length > 1
        ? { and: filters }
        : filters.length === 1
          ? filters[0]
          : undefined

    const results: PageObjectResponse[] = []
    let cursor: string | undefined = undefined
    const limit = opts?.limit
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: 100,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
        results.push(page)
        if (limit !== undefined && results.length >= limit) break
      }
      if (limit !== undefined && results.length >= limit) break
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined
    } while (cursor)

    return results.map((p) => this.pageToFact(p))
  }

  async queryByObject(
    object: string,
    opts?: QueryFactsOpts,
  ): Promise<Fact[]> {
    const filters: Array<Record<string, unknown>> = []

    if (object) {
      filters.push({ property: "Object", rich_text: { contains: object } })
    }

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }

    if (!opts?.includeInvalidated) {
      filters.push({
        property: "Valid Until",
        date: { is_empty: true },
      })
    }

    if (opts?.predicates?.length) {
      if (opts.predicates.length === 1) {
        filters.push({
          property: "Predicate",
          select: { equals: opts.predicates[0] },
        })
      } else {
        filters.push({
          or: opts.predicates.map((p) => ({
            property: "Predicate",
            select: { equals: p },
          })),
        })
      }
    }

    const filter =
      filters.length > 1
        ? { and: filters }
        : filters.length === 1
          ? filters[0]
          : undefined

    const results: PageObjectResponse[] = []
    let cursor: string | undefined = undefined
    const limit = opts?.limit
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: 100,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
        results.push(page)
        if (limit !== undefined && results.length >= limit) break
      }
      if (limit !== undefined && results.length >= limit) break
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined
    } while (cursor)

    return results.map((p) => this.pageToFact(p))
  }

  async queryBySourceMemory(
    sourceMemoryId: string,
    opts?: QueryFactsOpts,
  ): Promise<Fact[]> {
    const filters: Array<Record<string, unknown>> = [
      {
        property: "Source",
        relation: { contains: sourceMemoryId },
      },
    ]

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }

    if (!opts?.includeInvalidated) {
      filters.push({
        property: "Valid Until",
        date: { is_empty: true },
      })
    }

    if (opts?.predicates?.length) {
      if (opts.predicates.length === 1) {
        filters.push({
          property: "Predicate",
          select: { equals: opts.predicates[0] },
        })
      } else {
        filters.push({
          or: opts.predicates.map((p) => ({
            property: "Predicate",
            select: { equals: p },
          })),
        })
      }
    }

    const filter = filters.length > 1 ? { and: filters } : filters[0]

    const results: PageObjectResponse[] = []
    let cursor: string | undefined = undefined
    const limit = opts?.limit
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: 100,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
        results.push(page)
        if (limit !== undefined && results.length >= limit) break
      }
      if (limit !== undefined && results.length >= limit) break
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined
    } while (cursor)

    return results.map((p) => this.pageToFact(p))
  }

  /**
   * List the most recently created facts in a project, with server-side
   * predicate exclusion. Single page by design — the caller (wake-up) runs
   * on every hook fire and cannot absorb pagination latency. Use
   * `queryBySubject` when the full result set is required.
   *
   * Returns `{ items, hasMore }`. `hasMore` is true when Notion reports
   * additional rows past the requested window, letting saturation-aware
   * callers (e.g. a ranked-open-loops renderer that wants to show a "+N
   * more" affordance) detect truncation without issuing a second query.
   */
  async listRecent(
    opts: ListRecentOpts = {},
  ): Promise<{ items: Fact[]; hasMore: boolean }> {
    const filters: Array<Record<string, unknown>> = []

    if (opts.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }

    if (!opts.includeInvalidated) {
      filters.push({
        property: "Valid Until",
        date: { is_empty: true },
      })
    }

    if (opts.excludePredicates?.length) {
      // AND-of-does_not_equal is simpler than OR-of-equals over the complement
      // set and sidesteps Notion's compound-filter ceiling when the knowledge
      // vocabulary grows.
      for (const p of opts.excludePredicates) {
        filters.push({
          property: "Predicate",
          select: { does_not_equal: p },
        })
      }
    }

    const filter =
      filters.length > 1
        ? { and: filters }
        : filters.length === 1
          ? filters[0]
          : undefined

    const limit = opts.limit ?? NOTION_MAX_PAGE_SIZE
    const pageSize = Math.min(Math.max(limit, 1), NOTION_MAX_PAGE_SIZE)

    const response = await this.client.dataSources.query({
      data_source_id: this.db.dataSourceId,
      filter: filter as QueryDataSourceParameters["filter"],
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: pageSize,
    })

    const pages = response.results.filter(isFullPage) as PageObjectResponse[]
    return {
      items: pages.map((p) => this.pageToFact(p)),
      hasMore: response.has_more ?? false,
    }
  }

  async queryByEntity(entity: string, opts?: { projectId?: string }): Promise<Fact[]> {
    const asSubject = await this.queryBySubject(entity, opts)

    const asObject = await this.queryByObject(entity, opts)

    const seen = new Set(asSubject.map((f) => f.id))
    return [...asSubject, ...asObject.filter((f) => !seen.has(f.id))]
  }

  /**
   * Return facts whose `Source` relation is empty (no supporting memory) and
   * which are still valid. Used by `lore migrate --backfill-fact-sources` to
   * surface orphan facts for remediation. Excludes internal decision-graph
   * predicates that are auto-sourced elsewhere and should never be orphans.
   */
  async queryOrphans(opts?: { projectId?: string }): Promise<Fact[]> {
    const filters: Array<Record<string, unknown>> = [
      { property: "Source", relation: { is_empty: true } },
      { property: "Valid Until", date: { is_empty: true } },
    ]

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }

    const results: PageObjectResponse[] = []
    let cursor: string | undefined = undefined
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: { and: filters } as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: 100,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
        results.push(page)
      }
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined
    } while (cursor)

    return results.map((p) => this.pageToFact(p))
  }

  async queryOverdue(opts?: { projectId?: string }): Promise<Fact[]> {
    const today = new Date().toISOString().split("T")[0]
    const filters: Array<Record<string, unknown>> = [
      { property: "Review By", date: { on_or_before: today } },
      { property: "Valid Until", date: { is_empty: true } },
    ]

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }

    const response = await this.client.dataSources.query({
      data_source_id: this.db.dataSourceId,
      filter: { and: filters } as QueryDataSourceParameters["filter"],
      sorts: [{ property: "Review By", direction: "ascending" }],
    })

    return (response.results.filter(isFullPage) as PageObjectResponse[]).map((p) =>
      this.pageToFact(p)
    )
  }

  async extendReview(id: string, reviewBy: string): Promise<void> {
    await this.client.pages.update({
      page_id: id,
      properties: {
        "Review By": { date: { start: reviewBy } },
      },
    })
  }

  /**
   * Set the `Source` relation on an existing fact to point at a supporting
   * memory. Used by the `lore migrate --backfill-fact-sources` path to
   * retroactively link orphan facts found in the Mail vault audit.
   *
   * Overwrites any existing Source relation — facts in the current model have
   * a single source memory, so re-running the backfill replaces rather than
   * appending. The backfill caller is expected to run during a quiet window
   * (no concurrent autosave creating or re-pointing facts); we don't
   * re-read before the write.
   */
  async setSource(id: string, sourceMemoryId: string): Promise<void> {
    await this.client.pages.update({
      page_id: id,
      properties: {
        Source: { relation: [{ id: sourceMemoryId }] },
      },
    })
  }

  /**
   * Run the DedupKey backfill / merge pass against this service's Facts DB.
   * Thin wrapper over the standalone migration function so callers don't
   * need to reach through the service to grab the raw client + DatabaseRef.
   */
  async backfillDedupKeys(
    options: FactDedupOptions = {}
  ): Promise<FactDedupBackfillResult> {
    return runFactDedupBackfill(this.client, this.db, options)
  }

  async invalidate(id: string): Promise<void> {
    await this.client.pages.update({
      page_id: id,
      properties: {
        "Valid Until": {
          date: { start: new Date().toISOString().split("T")[0] },
        },
      },
    })
  }

  private pageToFact(page: PageObjectResponse): Fact {
    const props = page.properties
    const sourceIds = extractRelationIds(props["Source"])

    return {
      id: page.id,
      subject: extractTitle(props["Subject"]),
      predicate: extractSelect(props["Predicate"], "related_to") as FactPredicate,
      object: extractRichText(props["Object"]),
      projectIds: extractRelationIds(props["Project"]),
      validFrom: extractDate(props["Valid From"]),
      validUntil: extractDate(props["Valid Until"]),
      reviewBy: extractDate(props["Review By"]),
      sourceMemoryId: sourceIds[0] ?? null,
      confidence: extractSelect(props["Confidence"], "certain") as FactConfidence,
    }
  }
}
