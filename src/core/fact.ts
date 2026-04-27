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
import { computeFactDedupKey, computeSubjectKey } from "../notion/normalize.js"
import { decodeTextEntities } from "../notion/html-entities.js"
import {
  runFactDedupBackfill,
  type FactDedupBackfillResult,
  type FactDedupOptions,
} from "./fact-dedup.js"
import {
  fixFactEncoding,
  type FactEncodingReport,
} from "./fact-encoding.js"
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

type ListTrackingOpts = {
  projectId?: string
  /**
   * Substring matched against both `Subject` (title) and `Object` (rich_text)
   * via `or: [{contains}, {contains}]`. Scoping the filter server-side keeps
   * entity-filtered `lore-open-loops` cheap on vaults where tracking facts
   * outnumber the caller's interest (the Mail vault has 271 open loops; a
   * PR-specific slice typically touches under 20).
   */
  entity?: string
  /**
   * Pre-resolved canonical Entity ID. When supplied, the entity filter
   * additionally OR-s a relation match against `SubjectEntity` /
   * `ObjectEntity` so post-PF3-01 rows that share the canonical entity
   * surface even when their Subject/Object text wouldn't substring-
   * match the caller's input. The substring branch still runs in the
   * same OR for un-migrated rows. PR #88 closeout.
   */
  entityId?: string
  /**
   * Cap total rows fetched across pages. `undefined` means "fetch all" and
   * paginates until the cursor is exhausted — unlike `listRecent`, which is
   * single-page by design for the wake-up hot path. Callers wanting every
   * tracking row (e.g. `lore-open-loops` with `all: true`) pass `undefined`.
   */
  limit?: number
  includeInvalidated?: boolean
}

/** Notion's hard ceiling on `page_size`. */
const NOTION_MAX_PAGE_SIZE = 100

/**
 * Match Notion API errors that signal "the property you're filtering
 * on doesn't exist on this data source." Used to gate the recall-
 * preserving empty-result path in `queryByEntityTextOnUnmigrated`:
 * legacy vaults whose Facts DB lacks the `SubjectEntity` /
 * `ObjectEntity` columns 400 with `validation_error`, and we want
 * those to silently fall through to the relation-only result set.
 * Transient 5xx / rate-limit / network errors must NOT match — those
 * propagate so the caller sees the failure instead of getting a
 * silently-halved union.
 *
 * Matches by error `code` rather than checking `instanceof
 * APIResponseError` to keep the dependency surface narrow (the SDK's
 * error class hierarchy has churned between v4 and v5). The
 * `validation_error` code is stable across versions per the SDK
 * `APIErrorCode` enum.
 */
function isMissingPropertyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const code = (err as { code?: unknown }).code
  if (code !== "validation_error") return false
  const message =
    typeof (err as { message?: unknown }).message === "string"
      ? ((err as { message: string }).message)
      : ""
  // Notion's validation_error wraps several distinct schema mistakes;
  // match the substring that names the missing-property case so a
  // genuinely-malformed-filter validation_error (e.g. wrong operator
  // for the property type) still propagates. The SDK's error message
  // shape is "Could not find property with name or id: <name>" or
  // similar — match either spelling defensively.
  return /property/i.test(message) && /(not found|could not find|does not exist)/i.test(message)
}

/**
 * Safety cap on `listTracking` pagination: at 100 rows per page this caps at
 * 10 000 rows, which is ~35× the Mail vault's worst-case open-loop count. A
 * runaway cursor (bug or adversarial filter) cannot turn one tool call into
 * an unbounded Notion scan.
 */
const LIST_TRACKING_MAX_PAGES = 100

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
   * Set or replace the `SubjectEntity` / `ObjectEntity` relation on an
   * existing fact. Used by `lore migrate --build-entities` to re-point
   * historical rows after their canonical Entity is created. Either side
   * may be passed independently; `null` clears the column.
   */
  async setEntityRelations(
    id: string,
    relations: { subjectEntityId?: string | null; objectEntityId?: string | null }
  ): Promise<void> {
    const properties: Record<string, unknown> = {}
    if (relations.subjectEntityId !== undefined) {
      properties["SubjectEntity"] = {
        relation: relations.subjectEntityId
          ? [{ id: relations.subjectEntityId }]
          : [],
      }
    }
    if (relations.objectEntityId !== undefined) {
      properties["ObjectEntity"] = {
        relation: relations.objectEntityId
          ? [{ id: relations.objectEntityId }]
          : [],
      }
    }
    if (Object.keys(properties).length === 0) return

    await this.client.pages.update({
      page_id: id,
      properties: properties as UpdatePageParameters["properties"],
    })
  }

  /**
   * Find live facts where the given Entity row appears on either the
   * Subject or Object side via the canonical relation columns. This is
   * the post-PF3-01 read path: a single round-trip with deduped results
   * across both sides, no substring fragility.
   *
   * Returns `[]` on a vault that hasn't run the build-entities migration
   * yet — no rows reference the entity, so the result is empty by
   * construction. Callers that want substring fallback should fan out
   * to `queryByEntity(name)` after consulting the entity name.
   */
  async queryByEntityId(
    entityId: string,
    opts?: { projectId?: string; includeInvalidated?: boolean }
  ): Promise<Fact[]> {
    const filters: Array<Record<string, unknown>> = [
      {
        or: [
          { property: "SubjectEntity", relation: { contains: entityId } },
          { property: "ObjectEntity", relation: { contains: entityId } },
        ],
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

    const filter = filters.length > 1 ? { and: filters } : filters[0]
    const results: PageObjectResponse[] = []
    let cursor: string | undefined = undefined
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: NOTION_MAX_PAGE_SIZE,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
        results.push(page)
      }
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined
    } while (cursor)

    return results.map((p) => this.pageToFact(p))
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
    const subjectKey = computeSubjectKey(decodedInput.subject)

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
        subjectKey,
        // PF3-01 — optional entity ids. When the caller has resolved
        // them upstream (`lore-fact action='create'` after
        // `EntityService.resolveOrCreateEntity`), the new fact lands
        // with canonical relations from day one. Omitted callers
        // (legacy paths, internal decision-graph helpers) still write
        // valid rows; the migration backfills relations later.
        subjectEntityId: decodedInput.subjectEntityId,
        objectEntityId: decodedInput.objectEntityId,
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
      // Case-insensitive match via the normalized SubjectKey column
      // (P3-03 Part A) so `MemoryService` and `memoryservice` resolve to
      // the same fact set. The OR with a raw Subject `contains` keeps
      // pre-migration rows reachable until `lore migrate --dedup-keys`
      // backfills SubjectKey on every fact — once the backfill lands the
      // raw-side branch becomes redundant, but it costs one cheap clause
      // and avoids a window where queries silently lose results.
      //
      // Punctuation/whitespace-only inputs (`"."`, `"   "`, `"!!!"`) all
      // normalize to `""`. Notion's `rich_text contains ""` matches every
      // row with a non-null SubjectKey value — i.e., it broadens the
      // query to "every fact in scope" rather than restricting it. Skip
      // the SubjectKey clause when the normalized form is empty and fall
      // back to the raw `Subject contains <input>` filter, which
      // preserves pre-P3-03 literal-substring semantics for these edge
      // inputs.
      const normalizedKey = computeSubjectKey(subject)
      if (normalizedKey) {
        filters.push({
          or: [
            {
              property: "SubjectKey",
              rich_text: { contains: normalizedKey },
            },
            { property: "Subject", title: { contains: subject } },
          ],
        })
      } else {
        filters.push({ property: "Subject", title: { contains: subject } })
      }
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
    const pageSize =
      limit !== undefined
        ? Math.min(Math.max(limit, 1), NOTION_MAX_PAGE_SIZE)
        : NOTION_MAX_PAGE_SIZE
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: pageSize,
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
      // Case-sensitive `contains` on the raw Object column — symmetric
      // with the pre-P3-03 `queryBySubject` semantics. P3-03 Part A only
      // canonicalizes Subject because Part A's spec adds `SubjectKey`
      // alone; an `ObjectKey` mirror is Part B work (Entities DB) and
      // intentionally out of scope. Until then, `queryByEntity` is
      // half-canonical: case-folded against Subject, raw against Object.
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
    const pageSize =
      limit !== undefined
        ? Math.min(Math.max(limit, 1), NOTION_MAX_PAGE_SIZE)
        : NOTION_MAX_PAGE_SIZE
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: pageSize,
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
    const pageSize =
      limit !== undefined
        ? Math.min(Math.max(limit, 1), NOTION_MAX_PAGE_SIZE)
        : NOTION_MAX_PAGE_SIZE
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: pageSize,
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

  /**
   * Paginate through every live tracking-predicate fact (needs_action,
   * waiting_on, blocked_by) in scope, optionally filtered by an entity
   * substring that must match either `Subject` or `Object`.
   *
   * Unlike `listRecent` — which is single-page for the wake-up hot path —
   * this helper paginates. `lore-open-loops` needs to bucket results into
   * Overdue vs Active and rank each bucket independently, so a single
   * Notion page ordered by `Review By` asc would under-fill Active on
   * vaults dominated by overdue rows. Fetching the full slice up-front
   * lets the tool-layer ranker slice each bucket to its cap.
   *
   * `limit: undefined` fetches everything (bounded by
   * `LIST_TRACKING_MAX_PAGES` as a runaway safety valve). A numeric limit
   * stops pagination as soon as the requested count is reached and reports
   * `hasMore: true` if the last Notion page still signalled additional
   * rows. This is the contract P2-07 needs: the tool asks for "enough to
   * rank," the service tells it whether more exist beyond that window.
   *
   * Sort order: `Review By` ascending, `created_time` descending. The
   * tool layer always re-ranks inside each bucket, so on the happy path
   * (full result set fits in one `lore-open-loops` call) this order is
   * discarded. Its purpose is purely a safety-cap bias: if the 100-page
   * safety valve ever clips a pathological walk, the truncation lands
   * on rows with no review date rather than on the most-overdue ones
   * agents care about. Changing this sort is safe as long as that
   * invariant holds.
   */
  async listTracking(
    opts: ListTrackingOpts = {},
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

    // Tracking predicates are fixed at three today, which fits well under
    // Notion's compound-filter ceiling. OR-of-equals is the cleanest way to
    // say "predicate is one of these".
    filters.push({
      or: TRACKING_PREDICATES.map((p) => ({
        property: "Predicate",
        select: { equals: p },
      })),
    })

    if (opts.entity || opts.entityId) {
      // Subject is a `title` column; Object is `rich_text`. Notion's typed
      // filter param requires the right slot on each side — a `title` filter
      // with `rich_text.contains` is a runtime 400.
      //
      // Three branches OR'd into one server-side clause:
      // 1. PF3-01 relation match: when `entityId` is supplied, OR a
      //    `SubjectEntity contains entityId` and `ObjectEntity contains
      //    entityId` so post-migration rows surface by exact relation
      //    regardless of the raw Subject/Object text.
      // 2. SubjectKey case-fold (P3-03 Part A): rides on the Subject
      //    side so case-variant entity inputs resolve against the
      //    canonicalized column; suppressed when normalize collapses
      //    to empty (punctuation/whitespace-only input).
      // 3. Raw Subject + Object substring: preserves pre-P3-03
      //    semantics and covers un-migrated rows whose SubjectKey is
      //    blank.
      const orClauses: Array<Record<string, unknown>> = []
      if (opts.entityId) {
        orClauses.push(
          { property: "SubjectEntity", relation: { contains: opts.entityId } },
          { property: "ObjectEntity", relation: { contains: opts.entityId } },
        )
      }
      if (opts.entity) {
        const entityKey = computeSubjectKey(opts.entity)
        if (entityKey) {
          orClauses.push({
            property: "SubjectKey",
            rich_text: { contains: entityKey },
          })
        }
        orClauses.push(
          { property: "Subject", title: { contains: opts.entity } },
          { property: "Object", rich_text: { contains: opts.entity } },
        )
      }
      filters.push({ or: orClauses })
    }

    const filter =
      filters.length > 1
        ? { and: filters }
        : filters.length === 1
          ? filters[0]
          : undefined

    const limit = opts.limit
    const items: Fact[] = []
    let cursor: string | undefined = undefined
    let pagesFetched = 0
    let hasMore: boolean

    while (true) {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [
          { property: "Review By", direction: "ascending" },
          { timestamp: "created_time", direction: "descending" },
        ],
        page_size: NOTION_MAX_PAGE_SIZE,
        start_cursor: cursor,
      })
      pagesFetched += 1
      const pages = response.results.filter(isFullPage) as PageObjectResponse[]
      const nextCursor = response.has_more ? response.next_cursor ?? undefined : undefined

      let appended = 0
      for (const page of pages) {
        items.push(this.pageToFact(page))
        appended += 1
        if (limit !== undefined && items.length >= limit) break
      }

      if (limit !== undefined && items.length >= limit) {
        // Stopped because the cap was hit. More rows exist if we cut the
        // current page short or if Notion signalled another page beyond it.
        hasMore = appended < pages.length || Boolean(nextCursor)
        break
      }

      if (!nextCursor) {
        // Walked to exhaustion — `items` is the full set.
        hasMore = false
        break
      }

      if (pagesFetched >= LIST_TRACKING_MAX_PAGES) {
        // Safety valve fired with rows still unread. Surface this so the
        // caller can distinguish an exhaustive walk from a clipped one.
        hasMore = true
        break
      }

      cursor = nextCursor
    }

    return { items, hasMore }
  }

  /**
   * Find facts where an entity appears on either side of the triple.
   *
   * **PF3-01 path (preferred when `entityId` resolves).** Runs a
   * relation-based query (`SubjectEntity contains entityId OR
   * ObjectEntity contains entityId`) AND an unbackfilled-only
   * substring query in parallel, then unions the two. Symmetric, exact
   * on the relation side; recall-preserving for transition-window
   * vaults where some facts haven't been re-pointed yet.
   *
   * Why the parallel substring is gated on un-backfilled rows: a
   * relation-only path silently drops every fact whose
   * `SubjectEntity`/`ObjectEntity` is still empty even when the
   * `Subject`/`Object` text would have matched. The substring path is
   * filtered to rows where BOTH relation columns are empty so we
   * don't double-count rows that the relation path already returned.
   * Caught by review on PR #88.
   *
   * **Pre-PF3-01 fallback.** When `entityId` is null/undefined (the
   * caller's resolver couldn't pick a canonical row), falls back to
   * the pre-PF3-01 shape: Subject side is case-folded via
   * `queryBySubject` (P3-03 Part A), Object side stays case-sensitive
   * `contains`. Asymmetric on the Object side — callers should
   * normalize input or accept the asymmetry.
   *
   * Returns deduped: a fact whose Subject AND Object both reference
   * the entity surfaces once.
   */
  async queryByEntity(
    entity: string,
    opts?: { projectId?: string; entityId?: string | null }
  ): Promise<Fact[]> {
    if (opts?.entityId) {
      // Hot-path: relation hits + un-backfilled substring hits, run in
      // parallel so wall-clock is one round-trip, not two.
      const [byRelation, byTextOnUnmigrated] = await Promise.all([
        this.queryByEntityId(opts.entityId, { projectId: opts.projectId }),
        this.queryByEntityTextOnUnmigrated(entity, { projectId: opts.projectId }),
      ])
      const seen = new Set(byRelation.map((f) => f.id))
      return [
        ...byRelation,
        ...byTextOnUnmigrated.filter((f) => !seen.has(f.id)),
      ]
    }

    const asSubject = await this.queryBySubject(entity, opts)
    const asObject = await this.queryByObject(entity, opts)
    const seen = new Set(asSubject.map((f) => f.id))
    return [...asSubject, ...asObject.filter((f) => !seen.has(f.id))]
  }

  /**
   * Substring search restricted to facts whose `SubjectEntity` AND
   * `ObjectEntity` relations are both empty — i.e. rows the
   * build-entities migration hasn't re-pointed yet. Used by
   * `queryByEntity` to keep recall on transition-window vaults where
   * some facts still lack relation columns.
   *
   * Mirrors `queryBySubject`'s SubjectKey-aware OR + `queryByObject`'s
   * raw `contains`. Returns the union deduped by id.
   */
  private async queryByEntityTextOnUnmigrated(
    entity: string,
    opts?: { projectId?: string }
  ): Promise<Fact[]> {
    if (!entity) return []

    const baseFilters: Array<Record<string, unknown>> = [
      // The relation columns may not exist on the live schema yet (a
      // legacy vault that hasn't run schema migration). Notion's
      // `relation.is_empty` filter on a missing column is a 400, so
      // we wrap the whole query in a try/catch and treat the failure
      // as "vault has no Entities DB; substring fallback already ran
      // through the legacy path elsewhere — return empty here so we
      // don't double-count."
      { property: "SubjectEntity", relation: { is_empty: true } },
      { property: "ObjectEntity", relation: { is_empty: true } },
      { property: "Valid Until", date: { is_empty: true } },
    ]
    if (opts?.projectId) {
      baseFilters.push(projectOrUnscopedFilter(opts.projectId))
    }

    const subjectKey = computeSubjectKey(entity)
    const textOr: Array<Record<string, unknown>> = []
    if (subjectKey) {
      textOr.push({
        property: "SubjectKey",
        rich_text: { contains: subjectKey },
      })
    }
    textOr.push(
      { property: "Subject", title: { contains: entity } },
      { property: "Object", rich_text: { contains: entity } },
    )
    baseFilters.push({ or: textOr })

    try {
      const results: PageObjectResponse[] = []
      let cursor: string | undefined = undefined
      do {
        const response = await this.client.dataSources.query({
          data_source_id: this.db.dataSourceId,
          filter: { and: baseFilters } as QueryDataSourceParameters["filter"],
          sorts: [{ timestamp: "created_time", direction: "descending" }],
          page_size: NOTION_MAX_PAGE_SIZE,
          start_cursor: cursor,
        })
        for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
          results.push(page)
        }
        cursor = response.has_more ? response.next_cursor ?? undefined : undefined
      } while (cursor)
      return results.map((p) => this.pageToFact(p))
    } catch (err) {
      // Narrow swallow: only the "relation column doesn't exist on the
      // schema yet" case (a legacy vault that hasn't run schema
      // migration) should silently return `[]`. Transient errors —
      // 5xx, rate-limit blips, network — must propagate so the
      // relation-path side of the union surfaces a real failure to
      // the caller instead of silently halving the result set.
      //
      // Notion's SDK reports the missing-column case via
      // `validation_error` (HTTP 400). We match by code prefix to
      // tolerate both v5 and any future SDK variants.
      if (isMissingPropertyError(err)) {
        return []
      }
      throw err
    }
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
   * Run the DedupKey + SubjectKey backfill / merge pass against this
   * service's Facts DB. Thin wrapper over the standalone migration
   * function so callers don't need to reach through the service to grab
   * the raw client + DatabaseRef.
   *
   * **Schema dependency**: writes target the `DedupKey` and `SubjectKey`
   * rich_text columns. Both must exist on the live data source, or
   * `pages.update` returns 400 from Notion. The expected call chain is
   * `lore migrate` (which auto-runs `migrateVaultSchema` to add any
   * missing columns) → `lore migrate --dedup-keys` (which calls this
   * method). Direct callers outside that orchestration must invoke
   * `migrateVaultSchema` first.
   */
  async backfillDedupKeys(
    options: FactDedupOptions = {}
  ): Promise<FactDedupBackfillResult> {
    return runFactDedupBackfill(this.client, this.db, options)
  }

  /**
   * Run the HTML-entity decode pass against this service's Facts DB.
   * Same shape as `backfillDedupKeys` — thin wrapper over the standalone
   * migration function in `fact-encoding.ts` so the CLI doesn't need to
   * reach past the service boundary for the client + DatabaseRef.
   */
  async fixEncoding(
    options: { dryRun?: boolean } = {}
  ): Promise<FactEncodingReport> {
    return fixFactEncoding(this.client, this.db, options)
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

  /**
   * Map a Notion page to the `Fact` domain type.
   *
   * `SubjectKey` and `DedupKey` are deliberately *not* projected onto
   * `Fact` — they're query-only indexes derived from the canonical
   * `Subject` / `Object` / `Predicate` triple, not domain data. Surfacing
   * them on `Fact` would invite callers to read the cached normalized
   * form instead of recomputing it from the source-of-truth fields, and
   * a stale cache (e.g. mid-encoding-fix) would silently diverge from
   * the canonical value. The repo `AGENTS.md` rule that adding a DB
   * property requires updating `Fact` + `pageToFact` is intentionally
   * waived for these two columns; the next contributor should not
   * "fix" the asymmetry by exposing them.
   */
  private pageToFact(page: PageObjectResponse): Fact {
    const props = page.properties
    const sourceIds = extractRelationIds(props["Source"])
    // PF3-01 — relation columns return `[]` on un-migrated rows
    // because Notion responds with an empty list when the column
    // exists in the schema but is unset on the row. Treat any populated
    // relation as the canonical entity id; ignore the [1+] case (a
    // Fact only ever points at one canonical Entity per side).
    const subjectEntityIds = extractRelationIds(props["SubjectEntity"])
    const objectEntityIds = extractRelationIds(props["ObjectEntity"])

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
      subjectEntityId: subjectEntityIds[0] ?? null,
      objectEntityId: objectEntityIds[0] ?? null,
    }
  }
}
