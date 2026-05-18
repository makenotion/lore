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
import type { Fact, CreateFactInput, MemoryScopeContext, DatabaseRef } from "../types.js"
import { FACT_PROPS } from "../notion/schema.js"
import {
  FactInvalidation,
  type FactInvalidateOptions,
  type FactInvalidateResult,
} from "./fact-invalidation.js"
import { FactMaintenance } from "./fact-maintenance.js"
import {
  runFactDedupBackfill,
  type FactDedupBackfillResult,
  type FactDedupOptions,
} from "./fact-dedup.js"
import {
  FactCreatePipeline,
  type CreateFactResult as FactCreateResult,
} from "./fact-create.js"
import { fixFactEncoding, type FactEncodingReport } from "./fact-encoding.js"
import { isFullPage, extractRelationIds } from "../notion/extractors.js"
import { hydrateRelationPropertiesForPages } from "../notion/relation-properties.js"
import { pageToFact as mapPageToFact } from "./fact-mapper.js"
import { FactQueries, NOTION_MAX_PAGE_SIZE } from "./fact-queries.js"
import type {
  ListRecentOpts,
  QueryByEntityOpts,
  QueryFactsOpts,
  QueryOverdueOpts,
} from "./fact-queries.js"
import type { RelationUrlBaseResolver } from "../notion/runtool/create-pages.js"

export { scopesMatchForMerge } from "./fact-scope.js"
export { clampNotionPageSize } from "./fact-queries.js"
export {
  __resetDedupDuplicateScopeMatchWarnedForTests,
  __resetFactCreateMissingColumnWarningForTests,
  __resetProbeFailureLogForTests,
  __resetRunToolBatchCreatesAuthFallbackLogForTests,
  classifyTailFallback,
} from "./fact-create.js"
export type { CreateFactResult, TailFallback } from "./fact-create.js"
export type { FactInvalidateResult, FactInvalidateStatus } from "./fact-invalidation.js"
export type {
  ListRecentOpts,
  QueryByEntityOpts,
  QueryFactsOpts,
  QueryOverdueOpts,
} from "./fact-queries.js"

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from(
    { length: Math.min(Math.max(concurrency, 1), items.length) },
    async () => {
      while (next < items.length) {
        const index = next
        next += 1
        results[index] = await mapper(items[index]!)
      }
    }
  )
  await Promise.all(workers)
  return results
}

function repointRelationIds(
  ids: string[],
  fromEntityId: string,
  toEntityId: string
): string[] {
  const next: string[] = []
  let emittedToEntityId = false
  for (const id of ids) {
    const relationId = id === fromEntityId ? toEntityId : id
    if (relationId === toEntityId) {
      if (emittedToEntityId) continue
      emittedToEntityId = true
    }
    next.push(relationId)
  }
  return next
}

export interface FactEntityRepointPlan {
  factId: string
  subject: boolean
  object: boolean
}

export interface FactEntityRepointResult {
  plans: FactEntityRepointPlan[]
  factsMatched: number
  factsRepointed: number
  subjectRelationsRepointed: number
  objectRelationsRepointed: number
  errors: Array<{ factId: string; message: string }>
  planOnly: boolean
}

export interface RepointEntityOptions {
  fromEntityId: string
  toEntityId: string
  apply: boolean
  /**
   * Defaults to true so entity merges preserve historical fact graph
   * relations as well as live rows. Callers doing live-only maintenance can
   * opt out explicitly.
   */
  includeInvalidated?: boolean
}

export const REPOINT_ENTITY_CONCURRENCY = 8
const RAW_ENTITY_REPOINT_RELATION_PROPERTIES = [
  FACT_PROPS.SUBJECT_ENTITY,
  FACT_PROPS.OBJECT_ENTITY,
] as const

interface RawEntityRelationHit {
  factId: string
  subjectEntityIds: string[]
  objectEntityIds: string[]
}

interface EntityRelationRepointPlan extends FactEntityRepointPlan {
  subjectEntityIds: string[]
  objectEntityIds: string[]
}

/** Reset between tests. Not exported on the public API surface. */
export { __resetInvalidateMissingColumnWarningForTests } from "./fact-invalidation.js"

export class FactService {
  private readonly queries: FactQueries
  private readonly createPipeline: FactCreatePipeline
  private readonly invalidation: FactInvalidation
  private readonly maintenance: FactMaintenance

  constructor(
    private client: Client,
    private db: DatabaseRef,
    scopeCtx?: MemoryScopeContext,
    options?: {
      useRunToolBatchCreates?: boolean
      relationUrlBase?: RelationUrlBaseResolver
    }
  ) {
    this.queries = new FactQueries({
      client,
      db,
      scopeCtx,
    })
    this.createPipeline = new FactCreatePipeline({
      client,
      db,
      pageToFact: (page) => this.pageToFact(page),
      useRunToolBatchCreates: options?.useRunToolBatchCreates,
      relationUrlBase: options?.relationUrlBase,
    })
    this.invalidation = new FactInvalidation(this.client, (page) => this.pageToFact(page))
    this.maintenance = new FactMaintenance(
      this.client,
      this.db,
      (page) => this.pageToFact(page),
      () => this.queries.getScopeContext()
    )
  }

  /**
   * Toggle the batch-create path at runtime. Parallels
   * the constructor option so a test can flip the flag without
   * re-instantiating, and `setScopeContext`-style mid-process
   * reconfiguration stays consistent with how other flags are
   * threaded through this service.
   */
  setUseRunToolBatchCreates(enabled: boolean): void {
    this.createPipeline.setUseRunToolBatchCreates(enabled)
  }

  setScopeContext(ctx: MemoryScopeContext): void {
    this.queries.setScopeContext(ctx)
  }

  getScopeContext(): Readonly<MemoryScopeContext> {
    return this.queries.getScopeContext()
  }

  async create(input: CreateFactInput): Promise<Fact> {
    const { fact } = await this.createWithDedup(input)
    return fact
  }

  /**
   * Set or replace the `SubjectEntity` / `ObjectEntity` relation on an
   * existing fact. Used by `lore migrate --build-entities` to fill empty
   * historical relations and by entity merges to repoint duplicate entity
   * rows. Either side may be passed independently; `null` clears the column.
   */
  async setEntityRelations(
    id: string,
    relations: { subjectEntityId?: string | null; objectEntityId?: string | null }
  ): Promise<void> {
    await this.setEntityRelationIds(id, {
      subjectEntityIds:
        relations.subjectEntityId === undefined
          ? undefined
          : relations.subjectEntityId
            ? [relations.subjectEntityId]
            : [],
      objectEntityIds:
        relations.objectEntityId === undefined
          ? undefined
          : relations.objectEntityId
            ? [relations.objectEntityId]
            : [],
    })
  }

  private async setEntityRelationIds(
    id: string,
    relations: { subjectEntityIds?: string[]; objectEntityIds?: string[] }
  ): Promise<void> {
    const properties: Record<string, unknown> = {}
    if (relations.subjectEntityIds !== undefined) {
      properties[FACT_PROPS.SUBJECT_ENTITY] = {
        relation: relations.subjectEntityIds.map((relationId) => ({ id: relationId })),
      }
    }
    if (relations.objectEntityIds !== undefined) {
      properties[FACT_PROPS.OBJECT_ENTITY] = {
        relation: relations.objectEntityIds.map((relationId) => ({ id: relationId })),
      }
    }
    if (Object.keys(properties).length === 0) return

    await this.client.pages.update({
      page_id: id,
      properties: properties as UpdatePageParameters["properties"],
    })
  }

  /**
   * Move every SubjectEntity and/or ObjectEntity reference from one Entity row
   * to another. Plan-only by default at the operator layer; when `apply` is
   * true this keeps per-fact failure isolated so a transient Notion error
   * does not block unrelated facts from being repaired.
   */
  async repointEntity(options: RepointEntityOptions): Promise<FactEntityRepointResult> {
    if (!options.fromEntityId) {
      throw new Error("FactService.repointEntity: fromEntityId is required")
    }
    if (!options.toEntityId) {
      throw new Error("FactService.repointEntity: toEntityId is required")
    }
    if (options.fromEntityId === options.toEntityId) {
      throw new Error(
        "FactService.repointEntity: fromEntityId and toEntityId must differ"
      )
    }

    const facts = await this.queryRawEntityRelationHits(options.fromEntityId, {
      includeInvalidated: options.includeInvalidated ?? true,
    })
    const repointPlans = facts
      .map(
        (fact): EntityRelationRepointPlan => ({
          factId: fact.factId,
          subject: fact.subjectEntityIds.includes(options.fromEntityId),
          object: fact.objectEntityIds.includes(options.fromEntityId),
          subjectEntityIds: fact.subjectEntityIds,
          objectEntityIds: fact.objectEntityIds,
        })
      )
      .filter((plan) => plan.subject || plan.object)
    const plans: FactEntityRepointPlan[] = repointPlans.map(
      ({ factId, subject, object }) => ({
        factId,
        subject,
        object,
      })
    )

    const plannedSubject = repointPlans.filter((p) => p.subject).length
    const plannedObject = repointPlans.filter((p) => p.object).length

    if (!options.apply) {
      return {
        plans,
        factsMatched: facts.length,
        factsRepointed: plans.length,
        subjectRelationsRepointed: plannedSubject,
        objectRelationsRepointed: plannedObject,
        errors: [],
        planOnly: true,
      }
    }

    const outcomes = await mapWithConcurrency(
      repointPlans,
      REPOINT_ENTITY_CONCURRENCY,
      async (plan) => {
        const updates: {
          subjectEntityIds?: string[]
          objectEntityIds?: string[]
        } = {}
        if (plan.subject) {
          updates.subjectEntityIds = repointRelationIds(
            plan.subjectEntityIds,
            options.fromEntityId,
            options.toEntityId
          )
        }
        if (plan.object) {
          updates.objectEntityIds = repointRelationIds(
            plan.objectEntityIds,
            options.fromEntityId,
            options.toEntityId
          )
        }

        try {
          await this.setEntityRelationIds(plan.factId, updates)
          return { plan, error: null }
        } catch (err) {
          return { plan, error: err }
        }
      }
    )

    let factsRepointed = 0
    let subjectRelationsRepointed = 0
    let objectRelationsRepointed = 0
    const errors: Array<{ factId: string; message: string }> = []

    for (const outcome of outcomes) {
      if (outcome.error) {
        errors.push({
          factId: outcome.plan.factId,
          message:
            outcome.error instanceof Error
              ? outcome.error.message
              : String(outcome.error),
        })
        continue
      }

      factsRepointed += 1
      if (outcome.plan.subject) subjectRelationsRepointed += 1
      if (outcome.plan.object) objectRelationsRepointed += 1
    }

    return {
      plans,
      factsMatched: facts.length,
      factsRepointed,
      subjectRelationsRepointed,
      objectRelationsRepointed,
      errors,
      planOnly: false,
    }
  }

  private async queryRawEntityRelationHits(
    entityId: string,
    opts?: {
      includeInvalidated?: boolean
    }
  ): Promise<RawEntityRelationHit[]> {
    const filters: Array<Record<string, unknown>> = [
      {
        or: [
          { property: FACT_PROPS.SUBJECT_ENTITY, relation: { contains: entityId } },
          { property: FACT_PROPS.OBJECT_ENTITY, relation: { contains: entityId } },
        ],
      },
    ]

    if (!opts?.includeInvalidated) {
      filters.push({
        property: FACT_PROPS.VALID_UNTIL,
        date: { is_empty: true },
      })
    }

    const filter = filters.length > 1 ? { and: filters } : filters[0]
    const hits: RawEntityRelationHit[] = []
    let cursor: string | undefined = undefined
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: NOTION_MAX_PAGE_SIZE,
        start_cursor: cursor,
      })
      const pages = response.results.filter(isFullPage) as PageObjectResponse[]
      const hydratedPages = await hydrateRelationPropertiesForPages(
        this.client,
        pages,
        RAW_ENTITY_REPOINT_RELATION_PROPERTIES
      )
      for (const page of hydratedPages) {
        hits.push({
          factId: page.id,
          subjectEntityIds: extractRelationIds(
            page.properties[FACT_PROPS.SUBJECT_ENTITY]
          ),
          objectEntityIds: extractRelationIds(page.properties[FACT_PROPS.OBJECT_ENTITY]),
        })
      }
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)

    return hits
  }

  async createWithDedup(input: CreateFactInput): Promise<FactCreateResult> {
    return await this.createPipeline.createWithDedup(input)
  }

  async createBatchWithDedup(
    inputs: CreateFactInput[]
  ): Promise<PromiseSettledResult<FactCreateResult>[]> {
    return await this.createPipeline.createBatchWithDedup(inputs)
  }

  async queryBySubject(subject: string, opts?: QueryFactsOpts): Promise<Fact[]> {
    return this.queries.queryBySubject(subject, opts)
  }

  async queryByObject(object: string, opts?: QueryFactsOpts): Promise<Fact[]> {
    return this.queries.queryByObject(object, opts)
  }

  async queryBySourceMemory(
    sourceMemoryId: string,
    opts?: QueryFactsOpts
  ): Promise<Fact[]> {
    return this.queries.queryBySourceMemory(sourceMemoryId, opts)
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
    opts: ListRecentOpts = {}
  ): Promise<{ items: Fact[]; hasMore: boolean }> {
    return this.queries.listRecent(opts)
  }

  /**
   * Find facts where an entity appears on either side of the triple.
   *
   * **PF3-01 path (preferred when `entityId` resolves).** Runs a
   * relation-based query (`SubjectEntity contains entityId OR
   * ObjectEntity contains entityId`) AND an unbackfilled-only
   * substring query in parallel, then unions the two. Symmetric, exact
   * on the relation side; recall-preserving for transition-window
   * vaults where some facts do not have entity relations yet.
   *
   * Why the parallel substring is gated on un-backfilled rows: a
   * relation-only path silently drops every fact whose
   * `SubjectEntity`/`ObjectEntity` is still empty even when the
   * `Subject`/`Object` text would have matched. The substring path is
   * filtered to rows where BOTH relation columns are empty so we
   * don't double-count rows that the relation path already returned.
   *
   * **Unresolved-entity fallback.** When `entityId` is null/undefined
   * (the caller's resolver couldn't pick a canonical row), falls back
   * to text matching: Subject side is case-folded via
   * `queryBySubject`, Object side stays case-sensitive
   * `contains`. Asymmetric on the Object side — callers should
   * normalize input or accept the asymmetry.
   *
   * Returns deduped: a fact whose Subject AND Object both reference
   * the entity surfaces once.
   */
  async queryByEntity(entity: string, opts?: QueryByEntityOpts): Promise<Fact[]> {
    return this.queries.queryByEntity(entity, opts)
  }

  /**
   * Return facts whose `Source` relation is empty (no supporting memory) and
   * which are still valid. Used by `lore migrate --backfill-fact-sources`
   * (full walk) and `lore debt scan` (bounded audit). Excludes internal
   * decision-graph predicates that are auto-sourced elsewhere and should
   * never be orphans.
   *
   * `limit` is an opt-in upper bound on the number of orphan rows
   * returned. The migration omits it and walks the full Facts data
   * source; the debt scanner threads its per-category budget so a
   * bounded audit pass against a large vault doesn't pay for
   * thousands of orphan rows when the report will only surface the
   * first N.
   */
  async queryOrphans(opts?: { projectId?: string; limit?: number }): Promise<Fact[]> {
    return this.queries.queryOrphans(opts)
  }

  async queryOverdue(opts?: QueryOverdueOpts): Promise<Fact[]> {
    return this.queries.queryOverdue(opts)
  }

  /**
   * Read a single fact by page ID. Returns `null` for three reasons: the
   * page is partial (Notion `is_full_page` guard fails), the page is
   * archived, or the row's raw `Predicate` is one of the historical
   * tracking strings filtered at the deserialization boundary. Used by
   * `lore-fact action='invalidate'` to capture `sourceMemoryId` BEFORE the
   * invalidate write — invalidating first would leave the handler with no
   * fact shape to read the source from.
   *
   * **Archived-row guarantee.** This gate prevents archived
   * fact rows from deserializing as live `Fact` objects. The downstream
   * effect is that `handleInvalidate` reads `sourceMemoryId` as `null`
   * and skips the contradiction-decrement branch — no
   * `decrementConfidence` call lands against the archived row's source
   * memory. The mirror live-row gate in `MemoryService.requireLiveMemoryPage`
   * and `DecisionService.getById` throws; this gate returns `null` to
   * keep callers symmetric across the "row missing" and "row archived"
   * cases without forcing every caller to grow a `try/catch`.
   *
   * **Out of scope here:** the no-`Valid Until`-write guarantee on
   * archived rows is enforced separately by `FactService.invalidate`,
   * which retrieves the page directly and short-circuits on
   * `archived: true` before any `pages.update`. See its docblock for
   * the no-write contract; this method only governs the deserialization
   * boundary.
   */
  async getById(id: string): Promise<Fact | null> {
    return this.queries.getById(id)
  }

  async extendReview(id: string, reviewBy: string | null): Promise<void> {
    return this.maintenance.extendReview(id, reviewBy)
  }

  /**
   * Set the `Source` relation on an existing fact to point at a supporting
   * memory. Used by the `lore migrate --backfill-fact-sources` path to
   * retroactively link orphan facts found in an internal vault audit.
   *
   * Overwrites any existing Source relation — facts in the current model have
   * a single source memory, so re-running the backfill replaces rather than
   * appending. The backfill caller is expected to run during a quiet window
   * (no concurrent autosave creating facts or filling entity relations);
   * we don't re-read before the write.
   */
  async setSource(id: string, sourceMemoryId: string): Promise<void> {
    return this.maintenance.setSource(id, sourceMemoryId)
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
   * migration function so the CLI doesn't need to
   * reach past the service boundary for the client + DatabaseRef.
   */
  async fixEncoding(
    options: { dryRun?: boolean; projectId?: string } = {}
  ): Promise<FactEncodingReport> {
    return fixFactEncoding(this.client, this.db, options)
  }

  /**
   * Invalidate a fact (set `Valid Until = today`) and decrement its
   * `Confidence Score` (DEFERRED-02).
   *
   * Mirrors `MemoryService.decrementConfidence`'s decay-then-decrement
   * algebra: the helper reads the fact first, lazily seeds from the
   * categorical `Confidence` when `confidenceScore === null`, realizes
   * any decay accrued since `lastReferencedAt` (or `createdAt` for
   * never-touched rows), then halves the result via
   * `decrementConfidenceScore`. The decremented score, refreshed
   * `Last Referenced At = today`, AND `Valid Until = today` land in a
   * single `pages.update` so the WRITE itself is atomic — a transient
   * failure either lands all three columns or none.
   *
   * The read+compute+write trio is serialized per fact id because Notion
   * has no compare-and-swap or conditional-write primitive. The lock makes
   * concurrent invalidators queue behind the first writer, then read the
   * updated score, so each invalidate call contributes exactly one
   * confidence decrement. The final `pages.update` remains the atomic
   * boundary for `Valid Until`, `Invalidated At`, and the score columns.
   *
   * **Archived rows short-circuit.** The helper retrieves
   * the row directly (rather than via `getById`, which collapses the
   * archived / partial / tracking-predicate cases into a single `null`)
   * so it can distinguish archived from the other null reasons. Notion
   * accepts `pages.update` against archived pages, so without this gate
   * an invalidate against an already-archived row would write
   * `Valid Until = today` onto a row that is already excluded from
   * active queries — leaving an audit-visible contradictory
   * `archived: true` plus `Valid Until: <date>` combination. The
   * confidence-decrement branch is also skipped because `Confidence`
   * on an archived row is not load-bearing for retrieval.
   *
   * The historical-tracking-predicate filter in `pageToFact` returns
   * `null` for legacy rows whose Predicate is `needs_action` /
   * `waiting_on` / `blocked_by`. Those rows still need to be invalidated
   * (operators running cleanup expect the call to land), but there's no
   * `Fact` shape from which to read the score, so the helper degrades
   * to a `Valid Until`-only write — the same behavior the original
   * pre-decrement implementation used for those rows. The score
   * column stays untouched.
   *
   * Failure modes:
   * - `pages.retrieve` 5xx / 404: the catch routes to a `Valid Until`-only
   *   write so an invalidate call never fails on the read alone. Missing
   *   or inaccessible rows still fail at the `pages.update` boundary if
   *   the write cannot land. The decrement is advisory; the invalidate is
   *   the contract.
   * - `extractNumber` returns `null` for missing schema column: same
   *   path as a never-scored row, the decrement still runs against the
   *   seeded categorical.
   */
  async invalidate(
    id: string,
    opts: FactInvalidateOptions = {}
  ): Promise<FactInvalidateResult> {
    return this.invalidation.invalidate(id, opts)
  }

  /**
   * Update `Last Referenced At` to today and lazily seed / decay / bump
   * `Confidence Score` for the given facts (DEFERRED-02). Mirrors
   * `MemoryService.touchOnRead` — every contract decision documented
   * there applies here:
   *
   * - Same-day short-circuit: `lastReferencedAt === today && confidenceScore !== null`
   *   issues no Notion call.
   * - Seed-decay-then-bump on never-scored rows; decay-then-bump on
   *   stale; lazily realizes accrued decay on every touch.
   * - Per-row failures route through `onError` and degrade to a no-op
   *   for that fact. The caller's read result is always preserved;
   *   `touchOnRead` is advisory, never blocking.
   * - Bump-once-per-day: a fact cited 50 times in one session bumps
   *   exactly once.
   *
   * Each update is its own `pages.update` (Notion has no batch primitive);
   * the rate-limit middleware bounds in-flight count.
   */
  async touchOnRead(
    facts: ReadonlyArray<
      Pick<
        Fact,
        "id" | "confidence" | "confidenceScore" | "lastReferencedAt" | "createdAt"
      >
    >,
    opts?: {
      today?: string
      onError?: (factId: string, error: unknown) => void
    }
  ): Promise<void> {
    return this.maintenance.touchOnRead(facts, opts)
  }

  /**
   * Operator-facing counters for the `lore status` expiring/expired
   * scoped-facts surface. Matches
   * `MemoryService.expiringScopedStats` exactly — single paginated
   * walk over live (non-invalidated) facts, classifying each by
   * `Expires At` and by narrow-scope context match.
   *
   * Counts only live facts (`Valid Until is_empty`) — invalidated
   * facts are already historical and don't need an expiry surface.
   */
  async expiringScopedStats(opts: { projectId?: string } = {}): Promise<{
    expired: number
    expiringSoon: number
    narrowScopeOutOfContext: number
  }> {
    return this.maintenance.expiringScopedStats(opts)
  }

  /**
   * Paginating async iterator over every live (`Valid Until is_empty`)
   * fact in this service's Facts DB, optionally scoped to a single
   * project. Yields `Fact` objects in created-time-ascending order so
   * the migration's plan output is deterministic.
   *
   * Used by `runBuildFactConfidenceScoresMigration` (DEFERRED-02). Matches
   * `MemoryService.listAllForBackfill` shape — same projection, same
   * project-scope semantics, same `null`-tolerant `pageToFact` filter.
   *
   * Tracking-predicate facts (filtered by `pageToFact`) are skipped so
   * the migration doesn't try to seed scores onto historical rows whose
   * domain shape is not part of the current `FactPredicate` union.
   */
  async *listAllForBackfill(
    opts: {
      projectId?: string
      /**
       * When true, drop the default `Valid Until is_empty` filter so
       * invalidated rows surface alongside live ones. Used by the
       * `--backfill-fact-observed-at` migration so the walker sees
       * historical invalidations (whose `Invalidated At` needs
       * backfilling from `Valid Until`). Defaults to false — the
       * confidence-score migration only needs live rows.
       */
      includeInvalidated?: boolean
    } = {}
  ): AsyncGenerator<Fact, void, void> {
    yield* this.maintenance.listAllForBackfill(opts)
  }

  /**
   * Single `pages.update` writing both `Confidence Score` and
   * `Last Referenced At` (DEFERRED-02). Matches
   * `MemoryService.applyBackfillScore`: the migration sets
   * `Last Referenced At` to the fact's `createdAt` (sliced YYYY-MM-DD),
   * not today — the migration's contract is "treat creation as the
   * implicit first reference," so the row's decay anchor IS its creation
   * date.
   *
   * Caller is responsible for clamping `score`. Production callers
   * (`runBuildFactConfidenceScoresMigration`) hand off scores produced
   * by `decayConfidenceScore`, which clamps internally.
   */
  async applyBackfillScore(
    factId: string,
    score: number,
    lastReferencedAt: string
  ): Promise<void> {
    return this.maintenance.applyBackfillScore(factId, score, lastReferencedAt)
  }

  /**
   * Single `pages.update` writing the transaction-time provenance
   * columns (`Observed At` / `Invalidated At`). Either argument may be
   * `null` to skip writing that column; both `null` issues no Notion
   * call. Callers (`runBackfillFactObservedAtMigration`) compute the
   * values from `page.created_time` (for `Observed At`) and
   * `Valid Until` (for `Invalidated At`) and hand them in.
   * `Invalidated By` is NOT written by this path — the relation
   * column requires an explicit source memory id, which historical
   * invalidations don't carry; operators wanting to backfill
   * provenance retroactively use `lore-fact action='invalidate'` with
   * `sourceMemoryId` on a per-row basis.
   */
  async applyObservedAtBackfill(
    factId: string,
    values: { observedAt: string | null; invalidatedAt: string | null }
  ): Promise<void> {
    return this.maintenance.applyObservedAtBackfill(factId, values)
  }

  /**
   * Count live facts (`Valid Until is_empty`) whose Notion `Predicate`
   * select value matches one of the given raw select-value strings.
   *
   * **Deliberate double back door** — do not refactor either asymmetry:
   *
   * 1. `string[]` over `FactPredicate[]`. The `FactPredicate` union
   *    does not include the historical tracking strings
   *    `needs_action` / `waiting_on` / `blocked_by`. A typed-predicate
   *    signature would refuse to compile against those literals,
   *    breaking the preflight that exists precisely to detect them.
   *    Raw strings let the `lore status` preflight keep recognizing
   *    historical Notion `Predicate` values.
   *
   * 2. `Promise<number>` over `Promise<Fact[]>`. `pageToFact` returns
   *    `null` for rows whose
   *    predicate is not in the typed union, so a `Fact[]`-shape
   *    method would silently drop every historical tracking row from
   *    its result set — and the preflight count would regress
   *    to zero even when the vault still carries the rows in Notion.
   *    Walking `response.results.length` directly never instantiates
   *    `Fact` objects, so the count remains correct across the
   *    `pageToFact` filter contract.
   *
   * Routing this through `pageToFact`, or wrapping a `queryBy*`
   * accessor and converting back to a count, silently breaks the
   * preflight. The `Raw` suffix marks the
   * intentional bypass — same convention as the `raw` paths
   * elsewhere in the SDK layer.
   *
   * Empty input returns 0 without issuing a query.
   */
  async countByPredicateRaw(strings: string[]): Promise<number> {
    return this.queries.countByPredicateRaw(strings)
  }

  private async pageToFact(page: PageObjectResponse): Promise<Fact | null> {
    return await mapPageToFact(this.client, page)
  }
}
