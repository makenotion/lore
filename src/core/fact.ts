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
import { buildFactProps, FACT_PROPS } from "../notion/schema.js"
import { extractMissingPropertyName, isMissingPropertyError } from "../notion/errors.js"
import { computeFactDedupKey, computeSubjectKey } from "../notion/normalize.js"
import { decodeTextEntities } from "../notion/html-entities.js"
import { withEntityRelationLocks } from "./entity-relation-lock.js"
import {
  createPagesViaRunTool,
  isBatchCreateError,
} from "../notion/runtool/create-pages.js"
import type { RunToolCreatePagesInputPage } from "../notion/runtool/types.js"
import { FactInvalidation, type FactInvalidateOptions } from "./fact-invalidation.js"
import { FactMaintenance } from "./fact-maintenance.js"
import {
  runFactDedupBackfill,
  type FactDedupBackfillResult,
  type FactDedupOptions,
} from "./fact-dedup.js"
import { fixFactEncoding, type FactEncodingReport } from "./fact-encoding.js"
import { todayUtc } from "./task.js"
import { isFullPage, extractRelationIds } from "../notion/extractors.js"
import {
  pageToFact as mapPageToFact,
  pageToFacts as mapPageToFacts,
  pageToFactSync as mapPageToFactSync,
} from "./fact-mapper.js"
import { factScopeInputToBuilderProps } from "./fact-scope.js"
import { synthesizeFactFromCreateInput } from "./fact-synthesis.js"
import { FactQueries, NOTION_MAX_PAGE_SIZE } from "./fact-queries.js"
import type {
  ListRecentOpts,
  QueryByEntityOpts,
  QueryFactsOpts,
  QueryOverdueOpts,
} from "./fact-queries.js"

export { scopesMatchForMerge } from "./fact-scope.js"
export { clampNotionPageSize } from "./fact-queries.js"
export type {
  ListRecentOpts,
  QueryByEntityOpts,
  QueryFactsOpts,
  QueryOverdueOpts,
} from "./fact-queries.js"

/**
 * Once-per-process stderr warning when
 * `freshCreateAfterDedupMiss` drops a missing column on retry.
 * Symmetric with `warnInvalidateMissingColumnOnce` for the
 * partially-migrated-vault create path: operators triaging "fact
 * creation succeeded despite missing schema column X" see WHICH
 * column the schema lacks and the right migration to seed it.
 */
const factCreateMissingColumnWarned = new Set<string>()
function warnFactCreateMissingColumnOnce(propertyName: string): void {
  if (factCreateMissingColumnWarned.has(propertyName)) return
  factCreateMissingColumnWarned.add(propertyName)
  const hint =
    propertyName === "Observed At" ||
    propertyName === "Invalidated At" ||
    propertyName === "Invalidated By"
      ? "Run `lore migrate` to add issue #284 transaction-time columns, then `lore migrate --backfill-fact-observed-at` to seed pre-#284 rows."
      : "Run `lore migrate` to add missing schema columns."
  process.stderr.write(
    `[lore] fact-create: vault schema lacks \`${propertyName}\`; ` +
      `dropping that column from the create write so the fact still lands. ${hint}\n`
  )
}

/**
 * Warn once when the scope-constrained dedup probe finds more than
 * one live row for the same `(dedupKey, scope bundle)`. Notion permits
 * that duplicate state, and `--dedup-keys --merge` collapses it on its
 * next pass. The probe still picks the deterministic-first row and proceeds.
 */
let dedupDuplicateScopeMatchWarned = false
function logDedupDuplicateScopeMatchOnce(dedupKey: string): void {
  if (dedupDuplicateScopeMatchWarned) return
  dedupDuplicateScopeMatchWarned = true
  process.stderr.write(
    "[lore] fact-dedup: scope-constrained probe found multiple live " +
      `rows for dedup key ${dedupKey.slice(0, 12)}... — using the ` +
      "earliest-created match. Run `lore migrate --dedup-keys --merge` " +
      "to collapse the duplicate state (the migration's grouping is " +
      "scope-aware so legitimate same-triple-different-scope rows " +
      "stay distinct).\n"
  )
}

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

/**
 * A created-or-deduped fact. `deduped === true` means the write was absorbed
 * into an existing live row (same normalized triple) and the caller should
 * surface that to the user instead of silently returning a stale-looking ID.
 *
 * `enriched` lists the metadata fields that were merged onto the existing row
 * on dedup hit — projects union'd, source memory linked, review extended.
 * Empty when the probe missed (fresh row) or hit with nothing new to add.
 * Exposed so `lore-fact action='create'` can tell the agent "this
 * wasn't a no-op, we attached your session to the pre-existing fact."
 */
export interface CreateFactResult {
  fact: Fact
  deduped: boolean
  enriched: string[]
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

interface RawEntityRelationHit {
  factId: string
  subjectEntityId: string | null
  objectEntityId: string | null
}

/**
 * On an unmigrated vault every `lore-fact action='create'` probe fails with the same
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

/** Reset between tests. Not exported on the public API surface. */
export { __resetInvalidateMissingColumnWarningForTests } from "./fact-invalidation.js"

/** Reset between tests. Not exported on the public API surface. */
export function __resetFactCreateMissingColumnWarningForTests(): void {
  factCreateMissingColumnWarned.clear()
}

/**
 * Decide whether the tail fallback after a failed batch-create
 * call must re-probe the dedup path. Two distinct branches:
 *
 * - `"reprobe"` — the underlying error MAY have produced a
 *   server-side commit we missed. This applies to transport-class
 *   failures (no HTTP status — `ECONNRESET`, read timeout) and 5xx
 *   server errors (the request reached the server, which then
 *   either committed or didn't, but we can't tell). Falling back
 *   via `freshCreateAfterDedupMiss` (which skips the probe) would
 *   create duplicates of any pages the server processed before we
 *   lost the response. Re-probe via `createWithDedupLocked`
 *   instead — the per-input dedup probe absorbs a server-side
 *   orphan commit.
 *
 * - `"fresh-create"` — the underlying error CANNOT have produced a
 *   commit. 4xx pre-commit validation errors (Notion's standard
 *   `validation_error` body shape), auth-class denials (401/403),
 *   and capability gates all reject before any write. Skip the
 *   probe and use `freshCreateAfterDedupMiss` to avoid wasted
 *   round-trips per fallback input.
 *
 * The `BatchCreateError` from the wrapper's mid-batch failure
 * carries the underlying SDK error on `cause`; the full-failure
 * path passes the SDK error directly. Both routes through this
 * helper.
 *
 * Conservative default: when `status` is undefined we treat it as
 * transport-class. The caller's failure recovery cost is one extra
 * probe per input — much cheaper than a duplicate row.
 */
export type TailFallback = "reprobe" | "fresh-create"

export function classifyTailFallback(err: unknown): TailFallback {
  if (!err || typeof err !== "object") return "reprobe"
  const errObj = err as { status?: unknown }
  const status = typeof errObj.status === "number" ? errObj.status : undefined

  // Transport-class: no HTTP status reached us. Network drop, read
  // timeout, DNS failure. The server may or may not have processed
  // the request — re-probe to be safe.
  if (status === undefined) return "reprobe"

  // 5xx server errors: the request reached the server, but the
  // response is opaque. Server might have committed before
  // failing. Re-probe.
  if (status >= 500) return "reprobe"

  // 4xx pre-commit failures: validation errors, restricted
  // resource, unauthorized, rate_limited, etc. The server rejected
  // before writing. Safe to skip the probe.
  //
  // Notion's standard error codes here are `validation_error`,
  // `unauthorized`, `restricted_resource`, `object_not_found`,
  // `conflict_error`, `rate_limited`. None of these can produce a
  // committed row.
  if (status >= 400 && status < 500) return "fresh-create"

  // 1xx-3xx: shouldn't happen on Notion's API surface (no normal
  // success path produces those statuses on a `request()` rejection).
  // Be conservative — re-probe on the unknown.
  return "reprobe"
}

/**
 * Once-per-process stderr nudge when a flag-on RunTool batch-create
 * call surfaces a 403 RestrictedResource (or any auth-class denial),
 * implementing the RunTool restricted-resource recovery contract:
 *
 * > silently degrading every legacy-auth caller to "RunTool
 * > unavailable" is the correct behavior, but it must be loud
 * > enough that an operator using integration-secret auth knows why
 * > their flagged-on calls never use the new path.
 *
 * The wrapper falls back per-input via `pages.create` regardless,
 * so the operator's writes still land — but without this warning
 * an operator running on integration-secret auth and having flipped
 * `LORE_USE_RUNTOOL_BATCH_CREATES=1` would burn a wasted RunTool
 * round-trip per save and never learn why the new path silently
 * doesn't apply. One warning per process keeps stderr quiet on
 * happy-path callers; once-per-process matches the existing
 * `logProbeFailureOnce` posture above.
 */
let runtoolBatchCreatesAuthFallbackLogged = false
function logRunToolBatchCreatesAuthFallbackOnce(err: unknown): void {
  if (runtoolBatchCreatesAuthFallbackLogged) return
  // Detect 403 / RestrictedResource via the SDK's standard
  // `status` + `code` discriminants. A 401 also surfaces here on
  // first call before the SDK's auth-refresh hook gets a chance
  // to retry; lump both into the same loud-enough warning since
  // the operator action ("check your auth source") is the same.
  const status =
    typeof (err as { status?: unknown }).status === "number"
      ? (err as { status: number }).status
      : undefined
  const code =
    typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : undefined
  if (status !== 401 && status !== 403 && code !== "restricted_resource") {
    return
  }
  runtoolBatchCreatesAuthFallbackLogged = true
  process.stderr.write(
    "[lore] runtool batch_create: " +
      `${status ?? "?"} ${code ?? "auth"} on token; falling back ` +
      "to per-input pages.create. RunTool requires an ntn-issued " +
      "user-actor token; integration-secret auth cannot use RunTool. " +
      "Set LORE_USE_RUNTOOL_BATCH_CREATES=0 to " +
      "silence this and skip the wasted RunTool round-trip per save.\n"
  )
}

/** Reset between tests. Not exported on the public API surface. */
export function __resetRunToolBatchCreatesAuthFallbackLogForTests(): void {
  runtoolBatchCreatesAuthFallbackLogged = false
}

export class FactService {
  private readonly queries: FactQueries

  /**
   * Opt-in to batching auto-`mentions` fact creates via
   * RunTool's `create_pages` tool. When false (default),
   * `createBatchWithDedup` reproduces the fan-out shape
   * `Promise.allSettled(map(createWithDedup))` — so the
   * flag-off behavior is byte-equivalent to per-call emission. When
   * true, the batch path probes dedup, accumulates fresh-create
   * candidates, and flushes via one `runTool("create_pages", ...)` call
   * per chunk; on failure it falls back to the per-input `createWithDedup`
   * path so default-off semantics protect data integrity.
   */
  private useRunToolBatchCreates = false

  /**
   * User-facing host root for relation URLs in `create_pages`
   * payloads. Threaded from `services.ts:deriveRelationUrlBase` —
   * dev workspaces need `https://dev.notion.so/`, production needs
   * `https://www.notion.so/`. The server rejects host-mismatched URLs.
   */
  private relationUrlBase: string | undefined

  private readonly invalidation: FactInvalidation
  private readonly maintenance: FactMaintenance

  constructor(
    private client: Client,
    private db: DatabaseRef,
    scopeCtx?: MemoryScopeContext,
    options?: { useRunToolBatchCreates?: boolean; relationUrlBase?: string }
  ) {
    this.queries = new FactQueries({
      client,
      db,
      scopeCtx,
    })
    if (options?.useRunToolBatchCreates === true) {
      this.useRunToolBatchCreates = true
    }
    this.relationUrlBase = options?.relationUrlBase
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
    this.useRunToolBatchCreates = enabled
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
    const properties: Record<string, unknown> = {}
    if (relations.subjectEntityId !== undefined) {
      properties[FACT_PROPS.SUBJECT_ENTITY] = {
        relation: relations.subjectEntityId ? [{ id: relations.subjectEntityId }] : [],
      }
    }
    if (relations.objectEntityId !== undefined) {
      properties[FACT_PROPS.OBJECT_ENTITY] = {
        relation: relations.objectEntityId ? [{ id: relations.objectEntityId }] : [],
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
    const plans = facts
      .map(
        (fact): FactEntityRepointPlan => ({
          factId: fact.factId,
          subject: fact.subjectEntityId === options.fromEntityId,
          object: fact.objectEntityId === options.fromEntityId,
        })
      )
      .filter((plan) => plan.subject || plan.object)

    const plannedSubject = plans.filter((p) => p.subject).length
    const plannedObject = plans.filter((p) => p.object).length

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
      plans,
      REPOINT_ENTITY_CONCURRENCY,
      async (plan) => {
        const updates: {
          subjectEntityId?: string
          objectEntityId?: string
        } = {}
        if (plan.subject) updates.subjectEntityId = options.toEntityId
        if (plan.object) updates.objectEntityId = options.toEntityId

        try {
          await this.setEntityRelations(plan.factId, updates)
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
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
        hits.push({
          factId: page.id,
          subjectEntityId:
            extractRelationIds(page.properties[FACT_PROPS.SUBJECT_ENTITY])[0] ?? null,
          objectEntityId:
            extractRelationIds(page.properties[FACT_PROPS.OBJECT_ENTITY])[0] ?? null,
        })
      }
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)

    return hits
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
   * The set of mutations is returned in `enriched` so
   * `lore-fact action='create'` can surface them; "deduped" without
   * enrichment means "matched, nothing new to merge."
   *
   * On miss — or on probe failure — falls through to a plain create with
   * the dedup key attached. Cost: one extra `dataSources.query` per write
   * on cold miss, which is cheaper than the eventual
   * `lore-query action='ask'` / wake-up tax from duplicates.
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
    return withEntityRelationLocks([input.subjectEntityId, input.objectEntityId], () =>
      this.createWithDedupLocked(input)
    )
  }

  private async createWithDedupLocked(input: CreateFactInput): Promise<CreateFactResult> {
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
    const relationSafeInput = await this.dropArchivedEntityRelations(decodedInput)

    const reviewBy = relationSafeInput.reviewBy

    const dedupKey = computeFactDedupKey({
      subject: relationSafeInput.subject,
      predicate: relationSafeInput.predicate,
      object: relationSafeInput.object,
    })
    const subjectKey = computeSubjectKey(relationSafeInput.subject)

    // Scope/lifetime participates in the merge contract via a
    // server-side filter. The probe binds every scope component
    // (`Scope Kind`, `Scope Key`, `Audience`, `Lifetime`, `Expires At`)
    // plus `DedupKey` and `Valid Until is_empty`, so the result is
    // exactly the row that should merge or empty. No client-side walk,
    // no arbitrary cap — Notion does the bundle-equality match itself.
    // Same-triple-different-scope inputs remain distinct rows because
    // every scope column is bound on the server.
    //
    // The `lore migrate --dedup-keys --merge` migration uses the
    // matching grouping (`computeFactGroupKey` joins all five
    // columns) so create-time dedup and migration-time merge
    // converge on the same identity rule.
    const compatibleExisting = await this.findScopeMatchingLiveByDedupKey(
      dedupKey,
      relationSafeInput.scope
    ).catch((err) => {
      // Probe failure (e.g. transient network blip, or an unmigrated
      // vault that still lacks the DedupKey column) must not block the
      // write. Log once per process and fall through to the blind-
      // create path — worst case we create a duplicate the next
      // migrate pass will collapse.
      logProbeFailureOnce(err)
      return null
    })
    if (compatibleExisting) {
      const enriched = await this.mergeOntoExisting(
        compatibleExisting,
        relationSafeInput,
        reviewBy
      )
      return { fact: compatibleExisting, deduped: true, enriched }
    }

    return await this.freshCreateAfterDedupMiss({
      relationSafeInput,
      dedupKey,
      subjectKey,
      reviewBy,
    })
  }

  /**
   * Tail half of `createWithDedupLocked`: blind `pages.create` after
   * the dedup probe missed. Extracted so `createBatchWithDedup` can
   * reuse it on the per-input fallback path without
   * re-running the probe — a fallback after a failed batch already
   * has the probe result in hand and re-issuing the probe would
   * waste a round-trip per fallback.
   */
  private async freshCreateAfterDedupMiss(args: {
    relationSafeInput: CreateFactInput
    dedupKey: string
    subjectKey: string
    reviewBy: string | undefined
  }): Promise<CreateFactResult> {
    const { relationSafeInput, dedupKey, subjectKey, reviewBy } = args
    const validFrom =
      relationSafeInput.validFrom ?? new Date().toISOString().split("T")[0]!
    const properties = buildFactProps({
      subject: relationSafeInput.subject,
      predicate: relationSafeInput.predicate,
      object: relationSafeInput.object,
      projectIds: relationSafeInput.projectIds,
      validFrom,
      // `Observed At` is the transaction-time anchor: when
      // Lore learned about the fact. Defaults to today (matching
      // `validFrom`'s default) so a vanilla create lands with both
      // axes seeded; callers backfilling historical facts can decouple
      // by passing `validFrom` explicitly while leaving `observedAt`
      // to the today default.
      observedAt: todayUtc(),
      reviewBy,
      sourceMemoryId: relationSafeInput.sourceMemoryId,
      confidence: relationSafeInput.confidence ?? "certain",
      dedupKey,
      subjectKey,
      // PF3-01 — optional entity ids. When the caller has resolved
      // them upstream (`lore-fact action='create'` after
      // `EntityService.resolveOrCreateEntity`), the new fact lands
      // with canonical relations from day one. Omitted callers
      // (legacy paths, internal decision-graph helpers) still write
      // valid rows; the migration backfills relations later.
      subjectEntityId: relationSafeInput.subjectEntityId,
      objectEntityId: relationSafeInput.objectEntityId,
      ...factScopeInputToBuilderProps(relationSafeInput.scope),
    }) as Record<string, unknown>
    // Surgical retry on stale-schema vaults. The migration runner
    // normally adds new columns before new code ships writes for them.
    // Adding `Observed At` to the create payload can break that
    // invariant: a vault that pulled this code but has not yet run
    // `lore migrate` 400s on every fact write, since Notion rejects
    // unknown properties before creating the page.
    //
    // Mirror the surgical-drop loop `invalidate` uses on the same
    // partially-migrated failure class: parse the failing property
    // name, drop it from the payload, retry, up to the number of
    // optional columns we might be writing. Unlike `invalidate`,
    // create has no minimum-viable bare-write fallback — the dedup key,
    // subject/predicate/object, and project relations are all
    // load-bearing for the dedup contract, so on an unparseable error
    // we propagate the failure rather than silently degrading.
    const page = await this.createPageWithMissingPropertyRetry(properties)

    // We just created the row with a typed `FactPredicate` value, so
    // `pageToFact`'s historical-tracking filter cannot reject it.
    return {
      fact: (await this.pageToFact(page))!,
      deduped: false,
      enriched: [],
    }
  }

  /**
   * `pages.create` wrapper with iterative missing-property drop.
   * Identical drop-loop shape to `invalidate`'s schema-mismatch retry,
   * but with no bare-properties fallback (create has no
   * minimum-viable degraded write — the dedup key and identity
   * columns are all load-bearing).
   *
   * **Loop budget.** `MAX_OPTIONAL_DROPS = 4` is the count of optional
   * columns we might drop on a maximally-stale vault (transaction-time
   * `Observed At` + `Invalidated At` + `Invalidated By`, plus
   * `Confidence Score`). The loop runs at most
   * `MAX_OPTIONAL_DROPS + 1` iterations: up to MAX missing-column
   * drops followed by a single final retry with the trimmed payload.
   * The +1 is load-bearing — without it, four sequential missing-
   * property errors exhaust the iteration count before the final
   * retry fires and the function falls through to the post-loop
   * throw without ever issuing a successful create. An earlier `<`
   * bound (instead of `<=`) silently dropped the trailing retry.
   *
   * On parse failure (unrecognized SDK message shape) propagates the
   * original error so the caller surfaces the failure instead of
   * silently landing a partial row.
   */
  private async createPageWithMissingPropertyRetry(
    properties: Record<string, unknown>
  ): Promise<PageObjectResponse> {
    const MAX_OPTIONAL_DROPS = 4
    for (let attempt = 0; attempt <= MAX_OPTIONAL_DROPS; attempt += 1) {
      try {
        const page = await this.client.pages.create({
          parent: { type: "database_id", database_id: this.db.databaseId },
          properties: properties as Parameters<
            (typeof this.client)["pages"]["create"]
          >[0]["properties"],
        })
        return page as PageObjectResponse
      } catch (err) {
        if (!isMissingPropertyError(err)) throw err
        const missing = extractMissingPropertyName(err)
        if (missing && missing in properties) {
          warnFactCreateMissingColumnOnce(missing)
          delete properties[missing]
          if (Object.keys(properties).length === 0) throw err
          continue
        }
        // Unparseable validation_error: propagate so the caller can
        // surface the failure. No bare-fallback for create — silently
        // dropping every optional column would land a row missing the
        // load-bearing dedup key.
        throw err
      }
    }
    // Reached only if the loop's post-drop retry ALSO returned a
    // parseable missing-property error — i.e. more than MAX optional
    // columns were missing in sequence. Surface a clear error rather
    // than landing a row with no observable state.
    throw new Error(
      `FactService.createPageWithMissingPropertyRetry: exhausted ${MAX_OPTIONAL_DROPS} drops + 1 retry; ` +
        `vault schema appears to be severely out of date — run \`lore migrate\` to refresh.`
    )
  }

  /**
   * Batch sibling of `createWithDedup` — same dedup + provenance
   * semantics applied across many inputs.
   *
   * Two execution paths:
   *
   * 1. **Flag off** (default): byte-equivalent to the per-call auto-mention
   *    emission shape — `Promise.allSettled(inputs.map(createWithDedup))`.
   *    Behavioral equivalence under the flag-off path is satisfied by
   *    construction: this branch is the same fan-out the MCP layer
   *    issues inline.
   *
   * 2. **Flag on**: probes dedup for every input in parallel, runs
   *    the merge inline for hits, batches fresh-create candidates
   *    via `createPagesViaRunTool`, and falls back to per-input
   *    create on failure. The fallback selects between two paths
   *    based on whether the failure could have produced a
   *    server-side commit we lost the response for:
   *
   *    - **Pre-commit failures** (4xx validation, etc., where the
   *      server rejected before writing): use
   *      `freshCreateAfterDedupMiss` — the dedup probe was already
   *      done, no need to re-issue.
   *    - **Maybe-committed failures** (transport drops with no
   *      HTTP status, 5xx server errors, full-failure paths): use
   *      `createWithDedupLocked` so the per-input dedup probe
   *      catches a server-side commit whose response we lost.
   *      This applies to both full-failure and partial-commit-tail
   *      branches: a transport drop AFTER chunk 1 succeeded can
   *      still leave chunk 2 partially landed on the server, so
   *      the partial-commit tail must re-probe too. Pinned by the
   *      `mid-batch transport drop on chunk 2 → tail re-probes
   *      via createWithDedup` test case.
   *
   * Returns `PromiseSettledResult<CreateFactResult>[]` so per-input
   * failures stay isolated — the same shape `Promise.allSettled` gives
   * the auto-mention caller via the per-call path, just routed through
   * one method.
   *
   * Empty `inputs` returns `[]` without any Notion call. Single-input
   * `inputs` short-circuits to `createWithDedup` to keep the
   * single-call path on its existing locking discipline.
   *
   * **Concurrency caveat.** The flag-on
   * path runs N dedup probes in parallel for the same `inputs`
   * batch, expanding the cross-process dedup race window from
   * `createWithDedup`'s 1× to N× — between any pair of
   * `(probe, fresh-create)` operations on the same triple, an
   * out-of-process writer could land a matching row that this
   * batch's probes did not see. The result on a race is at most
   * one extra duplicate row per racing input, collapsed by the
   * authoritative `lore migrate --dedup-keys --merge` pass per
   * the existing dedup contract. The blast radius is acceptable for
   * auto-mention emission (the documented caller, where mentions
   * facts ship at `confidence: speculative` and the migration
   * sweeps regularly); a higher-stakes future caller adopting
   * this surface should consider whether the wider race window
   * matters and either accept it or fall back to the single-input
   * path.
   */
  async createBatchWithDedup(
    inputs: CreateFactInput[]
  ): Promise<PromiseSettledResult<CreateFactResult>[]> {
    if (inputs.length === 0) return []

    if (!this.useRunToolBatchCreates || inputs.length === 1) {
      // Flag-off and single-input paths route through the existing
      // per-call dedup+create path. `Promise.allSettled` preserves
      // the per-input failure isolation the auto-mention caller
      // historically achieved via `Promise.all` with inline
      // `.then(success, failure)` — same shape, fewer call-site
      // boilerplate per emitter.
      return await Promise.allSettled(inputs.map((input) => this.createWithDedup(input)))
    }

    // Flag-on path: batch fresh creates via RunTool. Acquire every
    // input's entity-relation locks at once via the shared helper,
    // which sorts and dedups so concurrent batch calls cannot
    // deadlock on overlapping lock sets. Auto-mention emission
    // (the canonical caller) typically passes inputs without
    // entity ids, so the lock helper short-circuits to a no-op for
    // the common case.
    const allEntityIds = inputs.flatMap((input) => [
      input.subjectEntityId,
      input.objectEntityId,
    ])
    return await withEntityRelationLocks(allEntityIds, () =>
      this.createBatchWithDedupRunToolLocked(inputs)
    )
  }

  /**
   * Flag-on body of `createBatchWithDedup`. Probes dedup per input,
   * batches fresh creates, hydrates synthesized Facts on success,
   * and falls back per-input on batch failure.
   */
  private async createBatchWithDedupRunToolLocked(
    inputs: CreateFactInput[]
  ): Promise<PromiseSettledResult<CreateFactResult>[]> {
    const results: PromiseSettledResult<CreateFactResult>[] = new Array(inputs.length)

    type ReadyMiss = {
      idx: number
      relationSafeInput: CreateFactInput
      dedupKey: string
      subjectKey: string
      reviewBy: string | undefined
    }

    // Dedup-probe pass: probe dedup for every input in parallel. Any
    // failure here (decode / archive-relation drop / probe error path
    // that throws unexpectedly) becomes a per-input rejection rather
    // than collapsing the whole batch — preserves the per-call
    // isolation the auto-mention emitter relies on.
    const misses: ReadyMiss[] = []
    await Promise.all(
      inputs.map(async (input, idx) => {
        try {
          const decodedInput: CreateFactInput = {
            ...input,
            subject: decodeTextEntities(input.subject),
            object: decodeTextEntities(input.object),
          }
          const relationSafeInput = await this.dropArchivedEntityRelations(decodedInput)
          const reviewBy = relationSafeInput.reviewBy
          const dedupKey = computeFactDedupKey({
            subject: relationSafeInput.subject,
            predicate: relationSafeInput.predicate,
            object: relationSafeInput.object,
          })
          const subjectKey = computeSubjectKey(relationSafeInput.subject)
          const compatibleExisting = await this.findScopeMatchingLiveByDedupKey(
            dedupKey,
            relationSafeInput.scope
          ).catch((err) => {
            logProbeFailureOnce(err)
            return null
          })
          if (compatibleExisting) {
            const enriched = await this.mergeOntoExisting(
              compatibleExisting,
              relationSafeInput,
              reviewBy
            )
            results[idx] = {
              status: "fulfilled",
              value: { fact: compatibleExisting, deduped: true, enriched },
            }
            return
          }
          misses.push({
            idx,
            relationSafeInput,
            dedupKey,
            subjectKey,
            reviewBy,
          })
        } catch (err) {
          results[idx] = { status: "rejected", reason: err }
        }
      })
    )

    if (misses.length === 0) return results

    // Create-dispatch pass: build the page payloads and dispatch one
    // `create_pages` call. The wrapper chunks defensively at
    // `RUNTOOL_CREATE_PAGES_MAX_CHUNK` so callers can pass any
    // number of misses without thinking about the server cap.
    const validFromDefault = new Date().toISOString().split("T")[0]
    const observedAtDefault = todayUtc()
    const pagePayloads: RunToolCreatePagesInputPage[] = misses.map((m) => ({
      properties: buildFactProps({
        subject: m.relationSafeInput.subject,
        predicate: m.relationSafeInput.predicate,
        object: m.relationSafeInput.object,
        projectIds: m.relationSafeInput.projectIds,
        validFrom: m.relationSafeInput.validFrom ?? validFromDefault,
        // Batch path seeds `Observed At` to mirror the
        // single-call create's transaction-time anchor.
        observedAt: observedAtDefault,
        reviewBy: m.reviewBy,
        sourceMemoryId: m.relationSafeInput.sourceMemoryId,
        confidence: m.relationSafeInput.confidence ?? "certain",
        dedupKey: m.dedupKey,
        subjectKey: m.subjectKey,
        subjectEntityId: m.relationSafeInput.subjectEntityId,
        objectEntityId: m.relationSafeInput.objectEntityId,
        ...factScopeInputToBuilderProps(m.relationSafeInput.scope),
      }) as Record<string, unknown>,
    }))

    // Discriminated union over the three terminal states of the batch
    // dispatch. Each terminal state carries a `tailFallback` mode that
    // determines whether per-input fallback re-probes the dedup path:
    //
    // - "fresh-create" → use `freshCreateAfterDedupMiss` (probe
    //   already done; pre-commit failures cannot have produced a
    //   server-side commit we missed).
    // - "reprobe" → use `createWithDedupLocked` so the per-input
    //   probe catches a server-side commit whose response we lost.
    //   Transport-class and 5xx failures fall here on BOTH the
    //   full-failure path AND the partial-commit-tail path,
    //   because chunk-order ALONE doesn't prove the failing chunk
    //   had no server-side effects.
    type BatchOutcome =
      | { kind: "full-success"; ids: string[] }
      | { kind: "partial-commit"; ids: string[]; tailFallback: TailFallback }
      | { kind: "full-failure"; tailFallback: TailFallback }

    let outcome: BatchOutcome
    try {
      const batchResult = await createPagesViaRunTool({
        client: this.client,
        parentDataSourceId: this.db.dataSourceId,
        pages: pagePayloads,
        relationUrlBase: this.relationUrlBase,
      })
      outcome = { kind: "full-success", ids: batchResult.createdPageIds }
    } catch (err) {
      // Classify the underlying cause to decide whether the tail
      // fallback must re-probe. Transport-class failures (no HTTP
      // status — network drop, read timeout) and 5xx server errors
      // might have committed before we lost the response, so the
      // tail must re-probe via `createWithDedup` to absorb the orphan
      // commit. Pre-commit 4xx validation errors cannot have
      // committed, so the tail safely uses `freshCreateAfterDedupMiss`
      // and skips a wasted probe per input.
      if (isBatchCreateError(err)) {
        // Partial-commit failures expose the underlying SDK error
        // on `cause`; surface auth-class causes (401/403) once
        // per process so operators see the actionable reason for
        // the per-input fallback.
        logRunToolBatchCreatesAuthFallbackOnce(err.cause)
        outcome = {
          kind: "partial-commit",
          ids: err.committedIds,
          tailFallback: classifyTailFallback(err.cause),
        }
      } else {
        // Full failures: the SDK error itself carries the status.
        // 401/403/RestrictedResource → loud-enough warning; other
        // failures stay silent (the surviving fallback creates
        // are the operator-visible signal).
        logRunToolBatchCreatesAuthFallbackOnce(err)
        outcome = {
          kind: "full-failure",
          tailFallback: classifyTailFallback(err),
        }
      }
    }

    // Phase 3a: credit the committed prefix (full success or
    // partial-commit prefix) by synthesizing Fact objects from the
    // input + new id. Skipping `pages.retrieve` for each created row
    // is the load-bearing batching win — re-fetching N pages would
    // give back the round-trips the batch saved.
    const committedIds: string[] =
      outcome.kind === "full-success" || outcome.kind === "partial-commit"
        ? outcome.ids
        : []
    for (let j = 0; j < committedIds.length; j += 1) {
      const m = misses[j]
      if (!m) break
      results[m.idx] = {
        status: "fulfilled",
        value: {
          fact: synthesizeFactFromCreateInput(
            committedIds[j]!,
            m.relationSafeInput,
            validFromDefault,
            observedAtDefault
          ),
          deduped: false,
          enriched: [],
        },
      }
    }

    // Phase 3b: fall back per-input for misses the batch did not
    // commit (partial-commit tail or full failure). The fallback
    // mode is set by `classifyTailFallback` based on whether the
    // underlying error class could have produced a server-side
    // commit we missed:
    //
    // - `"reprobe"` (transport-class, 5xx, unknown) → re-probe
    //   via `createWithDedupLocked` so a server-side orphan
    //   commit is absorbed by the per-input dedup match.
    // - `"fresh-create"` (4xx validation, auth, capability) →
    //   skip the probe via `freshCreateAfterDedupMiss` because
    //   the failure class cannot have produced a commit.
    //
    // Both partial-commit tails AND full failures go through this
    // selector now (Round 2 review): a transport drop on chunk 2
    // after chunk 1 succeeded can still leave chunk 2 partially
    // landed on the server, so the tail must re-probe.
    const tail = misses.slice(committedIds.length)
    if (tail.length === 0) return results

    const tailFallback: TailFallback =
      outcome.kind === "full-success" ? "fresh-create" : outcome.tailFallback
    await Promise.all(
      tail.map(async (m) => {
        try {
          if (tailFallback === "reprobe") {
            // Re-probe path: an extra `dataSources.query` per input
            // catches a server-side commit the wrapper lost the
            // response for. Cost: N probes per failed batch.
            // Benefit: idempotent recovery from network drops on
            // an undelivered RunTool response.
            const result = await this.createWithDedupLocked(m.relationSafeInput)
            results[m.idx] = { status: "fulfilled", value: result }
          } else {
            const result = await this.freshCreateAfterDedupMiss({
              relationSafeInput: m.relationSafeInput,
              dedupKey: m.dedupKey,
              subjectKey: m.subjectKey,
              reviewBy: m.reviewBy,
            })
            results[m.idx] = { status: "fulfilled", value: result }
          }
        } catch (createErr) {
          results[m.idx] = { status: "rejected", reason: createErr }
        }
      })
    )

    return results
  }

  private async dropArchivedEntityRelations(
    input: CreateFactInput
  ): Promise<CreateFactInput> {
    const [subjectEntityId, objectEntityId] = await Promise.all([
      this.liveEntityRelationId(input.subjectEntityId),
      this.liveEntityRelationId(input.objectEntityId),
    ])
    if (
      subjectEntityId === input.subjectEntityId &&
      objectEntityId === input.objectEntityId
    ) {
      return input
    }

    // Avoid half-canonical rows. `queryByEntity`'s text fallback is
    // relation-empty scoped; writing only one side would hide the dropped
    // side from both the relation branch and the fallback branch.
    if (
      (input.subjectEntityId && !subjectEntityId && objectEntityId) ||
      (input.objectEntityId && !objectEntityId && subjectEntityId)
    ) {
      return { ...input, subjectEntityId: undefined, objectEntityId: undefined }
    }

    return { ...input, subjectEntityId, objectEntityId }
  }

  /**
   * Probe an entity-relation id for liveness before a fact write.
   *
   * Returns `id` when the row exists and isn't archived; `undefined`
   * when the entity is genuinely gone (404 / `object_not_found`).
   * **Re-throws every other error** — transient transport failures
   * (`isTransientNotionError`: 429 / 5xx / network blips), auth /
   * permission errors, and schema-validation errors all propagate.
   *
   * The earlier bare `catch {}` collapsed all three classes onto
   * "entity is archived" and let `dropArchivedEntityRelations` strip
   * both sides of a fact whose relations the caller had correctly
   * resolved upstream — silently violating the five-database integrity
   * contract during a Notion incident or a sustained 429 backoff window.
   * Failing loud is correct: surfacing a 503 to `createWithDedup` is
   * worse than landing a relation-empty row that the next
   * `lore migrate --build-entities` run would have to repair.
   */
  private async liveEntityRelationId(
    id: string | undefined
  ): Promise<string | undefined> {
    if (!id) return undefined
    try {
      const page = await this.client.pages.retrieve({ page_id: id })
      return isFullPage(page) && !page.archived ? id : undefined
    } catch (err) {
      const { status, code } = err as { status?: unknown; code?: unknown }
      if (status === 404 || code === "object_not_found") return undefined
      throw err
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
   * `enriched[]` order is deterministic: `Review By`, then `Project`,
   * then `Source`, then `SubjectEntity`, then `ObjectEntity`. Previously
   * each string was pushed after its own successful update so the array
   * reflected Notion confirmation order; after the collapse, ordering
   * is mechanical. No user-visible change — no downstream renderer
   * relies on the order — but the test suite pins it via the
   * `bundles entity backfill with review/project/source merges`
   * fixture, so a future refactor that flips the
   * order must update that fixture. Worth noting so a future reader
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

    // Parallel boolean flags for the five mutations. Hoisted so the
    // post-write mirror block doesn't re-evaluate the same conditions.
    //
    // Review By is monotonic: a dedup hit must only ever push the date
    // forward. Without the strict `>` comparison, a stale or repeated
    // agent write whose `reviewBy` predates `existing.reviewBy` would
    // overwrite it with the older value, regressing the row into a
    // premature overdue/audit window. ISO `YYYY-MM-DD` strings compare
    // lexicographically as dates so `>` is a date comparison; the null
    // branch lets an initial `reviewBy` land on a deduped row.
    const extendingReview =
      reviewBy !== undefined &&
      reviewBy !== "" &&
      (existing.reviewBy === null || reviewBy > existing.reviewBy)
    const missingProjectIds = (decodedInput.projectIds ?? []).filter(
      (id) => !existing.projectIds.includes(id)
    )
    const mergedProjectIds =
      missingProjectIds.length > 0 ? [...existing.projectIds, ...missingProjectIds] : null
    // First-writer-wins on Source: if the existing row already has a
    // source memory we don't clobber it (the "no orphans" contract
    // only cares about filling the gap, not re-pointing a linked row).
    // Same posture below for the entity relations.
    const fillingSource = Boolean(!existing.sourceMemoryId && decodedInput.sourceMemoryId)
    // First-writer-wins on the entity relations, mirroring Source's
    // posture. Cold creates already populate `SubjectEntity` /
    // `ObjectEntity` from `decodedInput` via `buildFactProps`; on a
    // dedup hit we fill those relations only when the existing row
    // has them empty AND the incoming write resolved an id. Without
    // the fill, canonical relations would stay absent on rows that
    // match a legacy or partially migrated row even when the current
    // write already resolved the ids. Preserving an existing relation
    // matches the no-clobber rule on Source.
    const fillingSubjectEntity = Boolean(
      !existing.subjectEntityId && decodedInput.subjectEntityId
    )
    const fillingObjectEntity = Boolean(
      !existing.objectEntityId && decodedInput.objectEntityId
    )

    if (extendingReview) {
      properties[FACT_PROPS.REVIEW_BY] = { date: { start: reviewBy } }
      enriched.push(`extended review to ${reviewBy}`)
    }
    if (mergedProjectIds) {
      properties[FACT_PROPS.PROJECT] = {
        relation: mergedProjectIds.map((id) => ({ id })),
      }
      enriched.push(
        `added ${missingProjectIds.length} project${missingProjectIds.length === 1 ? "" : "s"}`
      )
    }
    if (fillingSource) {
      properties[FACT_PROPS.SOURCE] = {
        relation: [{ id: decodedInput.sourceMemoryId }],
      }
      enriched.push("linked source memory")
    }
    if (fillingSubjectEntity) {
      properties[FACT_PROPS.SUBJECT_ENTITY] = {
        relation: [{ id: decodedInput.subjectEntityId }],
      }
      enriched.push("linked subject entity")
    }
    if (fillingObjectEntity) {
      properties[FACT_PROPS.OBJECT_ENTITY] = {
        relation: [{ id: decodedInput.objectEntityId }],
      }
      enriched.push("linked object entity")
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
    if (fillingSubjectEntity) {
      existing.subjectEntityId = decodedInput.subjectEntityId ?? null
    }
    if (fillingObjectEntity) {
      existing.objectEntityId = decodedInput.objectEntityId ?? null
    }

    return enriched
  }

  /**
   * Look up a live fact (Valid Until IS NULL) by normalized dedup key.
   * Returns `null` when no live match exists. Invalidated rows with the
   * same key are deliberately ignored so history stays intact and the
   * caller writes a fresh live row when a triple is re-asserted after
   * correction.
   *
   * `pageToFact` returns `Fact | null` and filters historical
   * tracking-predicate rows (`needs_action` / `waiting_on` /
   * `blocked_by`). A dedup-key collision against a tracking row is
   * structurally impossible because the new write's predicate is
   * `FactPredicate`-typed (the contracted union excludes those values),
   * and the dedup hash incorporates the predicate — so a tracking row's
   * key cannot match a fresh `lore-fact action='create'` write. The
   * `null` branch from `pageToFact` here only fires if a future
   * deserialization-filter rule lands; today it's effectively dead.
   */
  /**
   * Probe for the live fact matching `(dedupKey, scope bundle)`.
   * Returns at most one row by construction — the server-side
   * filter binds every scope component, so two rows that pass it
   * are duplicates the migration would collapse.
   *
   * An earlier candidate walker paginated through
   * up to `MAX_DEDUP_CANDIDATE_PAGES * MAX_DEDUP_CANDIDATES` (250)
   * mismatched rows and gave up at the cap. In a high-cardinality
   * vault where the same triple legitimately spans many sessions /
   * runs / users, the compatible row could sit past the cap and
   * `createWithDedup` would blind-create a duplicate. The
   * scope-constrained query removes the cap problem entirely:
   * Notion does the kind+key match server-side, so the result is
   * either the compatible row (returned) or empty (caller blind-
   * creates a fresh row under the requested scope).
   *
   * The filter is a flat 1-deep `and:` of property filters — well
   * inside Notion's 2-level compound-filter limit and aligned with
   * the `defaultScopeInclusionFilter` shape used
   * elsewhere in the codebase. Scope columns that are
   * `null` / empty on the incoming write get `is_empty` clauses on
   * the corresponding column so a broadcast write doesn't match a
   * narrow-scoped row (or vice versa). The scope-bundle equality
   * an earlier candidate walker enforced via
   * `scopesMatchForMerge` is structurally enforced by the
   * filter itself; the `same-triple-different-scope` test still
   * passes because the
   * filter binds kind+key+audience+lifetime+expiresAt all on the
   * server.
   *
   * Internal `_locked` invariant: caller holds the per-key entity
   * relation locks and is single-shotting a probe → write sequence.
   * Concurrent writers on the same dedup-key+scope combination
   * are the (Notion-eventually-consistent) duplicate-create race
   * the existing `--dedup-keys --merge` migration covers.
   */
  private async findScopeMatchingLiveByDedupKey(
    dedupKey: string,
    scope: import("../types.js").MemoryScopeInput | undefined
  ): Promise<Fact | null> {
    const filters: Array<Record<string, unknown>> = [
      { property: FACT_PROPS.DEDUP_KEY, rich_text: { equals: dedupKey } },
      { property: FACT_PROPS.VALID_UNTIL, date: { is_empty: true } },
    ]

    // Bind every scope column server-side. The clauses are
    // structurally one-per-column so a future contributor adding
    // a sixth scope field gets a typecheck error here when they
    // forget to extend the filter (the input shape forces them
    // through this list).
    const scopeKind = scope?.kind ?? null
    if (scopeKind === null) {
      filters.push({
        property: FACT_PROPS.SCOPE_KIND,
        select: { is_empty: true },
      })
    } else {
      filters.push({
        property: FACT_PROPS.SCOPE_KIND,
        select: { equals: scopeKind },
      })
    }

    const scopeKey = scope?.key && scope.key.length > 0 ? scope.key : null
    if (scopeKey === null) {
      filters.push({
        property: FACT_PROPS.SCOPE_KEY,
        rich_text: { is_empty: true },
      })
    } else {
      filters.push({
        property: FACT_PROPS.SCOPE_KEY,
        rich_text: { equals: scopeKey },
      })
    }

    const audience = scope?.audience && scope.audience.length > 0 ? scope.audience : null
    if (audience === null) {
      filters.push({
        property: FACT_PROPS.AUDIENCE,
        rich_text: { is_empty: true },
      })
    } else {
      filters.push({
        property: FACT_PROPS.AUDIENCE,
        rich_text: { equals: audience },
      })
    }

    const lifetime = scope?.lifetime ?? null
    if (lifetime === null) {
      filters.push({
        property: FACT_PROPS.LIFETIME,
        select: { is_empty: true },
      })
    } else {
      filters.push({
        property: FACT_PROPS.LIFETIME,
        select: { equals: lifetime },
      })
    }

    const expiresAt = scope?.expiresAt ?? null
    if (expiresAt === null) {
      filters.push({
        property: FACT_PROPS.EXPIRES_AT,
        date: { is_empty: true },
      })
    } else {
      filters.push({
        property: FACT_PROPS.EXPIRES_AT,
        date: { equals: expiresAt },
      })
    }

    // Single-page query — `page_size: 2` (not 1) so a future
    // duplicate-row state surfaces as "more than one match"
    // instead of silently picking position 0. We log a stderr
    // warning when that happens; the caller still merges into the
    // first match (deterministic by the explicit `created_time
    // ASC` sort below) and `lore migrate --dedup-keys --merge`
    // collapses the duplicates on the next pass.
    const response = await this.client.dataSources.query({
      data_source_id: this.db.dataSourceId,
      filter: { and: filters } as QueryDataSourceParameters["filter"],
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
      page_size: 2,
    })

    const pages = response.results.filter(isFullPage) as PageObjectResponse[]
    if (pages.length === 0) return null
    if (pages.length > 1) {
      logDedupDuplicateScopeMatchOnce(dedupKey)
    }
    return await this.pageToFact(pages[0])
  }

  /**
   * Legacy single-row dedup probe retained for non-create call
   * sites that need "any live row with this key" without scope
   * compatibility. Currently unused — kept for the primitive shape
   * the scope-constrained probe builds on.
   */
  private async findLiveByDedupKey(dedupKey: string): Promise<Fact | null> {
    const response = await this.client.dataSources.query({
      data_source_id: this.db.dataSourceId,
      filter: {
        and: [
          { property: FACT_PROPS.DEDUP_KEY, rich_text: { equals: dedupKey } },
          { property: FACT_PROPS.VALID_UNTIL, date: { is_empty: true } },
        ],
      } as QueryDataSourceParameters["filter"],
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
      page_size: 1,
    })
    const pages = response.results.filter(isFullPage) as PageObjectResponse[]
    if (pages.length === 0) return null
    return await this.pageToFact(pages[0])
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
   *   write so an invalidate call never fails for a transient read
   *   problem. The decrement is advisory; the invalidate is the
   *   contract. Archived short-circuit is conservative — a row that
   *   reads as not-archived (or fails to read) still gets the write.
   * - `extractNumber` returns `null` for missing schema column: same
   *   path as a never-scored row, the decrement still runs against the
   *   seeded categorical.
   */
  async invalidate(id: string, opts: FactInvalidateOptions = {}): Promise<void> {
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

  private async pageToFacts(pages: readonly PageObjectResponse[]): Promise<Fact[]> {
    return await mapPageToFacts(this.client, pages)
  }

  private pageToFactSync(page: PageObjectResponse): Fact | null {
    return mapPageToFactSync(page)
  }
}
