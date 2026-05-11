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
  MemoryScopeContext,
  MemoryScopeInput,
  MemoryScope,
  MemoryScopeKind,
  MemoryLifetime,
  DatabaseRef,
} from "../types.js"
import { EXPIRING_SOON_DAYS, MS_PER_DAY } from "../types.js"
import { buildFactProps, FACT_PROPS } from "../notion/schema.js"
import { isMissingPropertyError } from "../notion/errors.js"
import {
  projectOrUnscopedFilter,
  withDefaultScopeFilter,
  FACT_SCOPE_PROPS,
} from "../notion/filters.js"
import { matchesDefaultScope } from "./memory.js"
import { computeFactDedupKey, computeSubjectKey } from "../notion/normalize.js"
import { decodeTextEntities } from "../notion/html-entities.js"
import { withEntityRelationLocks } from "./entity-relation-lock.js"
import {
  createPagesViaRunTool,
  isBatchCreateError,
} from "../notion/runtool/create-pages.js"
import type { RunToolCreatePagesInputPage } from "../notion/runtool/types.js"
import {
  runFactDedupBackfill,
  type FactDedupBackfillResult,
  type FactDedupOptions,
} from "./fact-dedup.js"
import { fixFactEncoding, type FactEncodingReport } from "./fact-encoding.js"
import {
  bumpConfidenceScore,
  decayConfidenceScore,
  decrementConfidenceScore,
  seedConfidenceScore,
} from "./decay.js"
import { todayUtc } from "./task.js"
import {
  isFullPage,
  isLiveFullPage,
  extractTitle,
  extractRichText,
  extractSelect,
  extractRelationIds,
  extractDate,
  extractNumber,
} from "../notion/extractors.js"
import {
  hydrateRelationProperties,
  hydrateRelationPropertiesForPages,
} from "../notion/relation-properties.js"

type QueryFactsOpts = {
  projectId?: string
  includeInvalidated?: boolean
  predicates?: FactPredicate[]
  /**
   * Cap total results. Pagination stops as soon as this is reached.
   * Without a limit, all matching facts are fetched across pages.
   */
  limit?: number
  /**
   * Opt into the "list every fact in scope" branch when the subject /
   * object argument is strict-empty (`""`). Without this flag the
   * service short-circuits to `[]` so a typoed / blank caller cannot
   * accidentally enumerate the entire vault. Internal callers that
   * genuinely want vault-wide enumeration (the `--build-entities`
   * migration scan) pass `true`. Agent-facing surfaces (MCP
   * `lore-query action='ask'`, `lore-decision action='context'`,
   * `lore-fact action='create'`) never set this — they're guarded at
   * the Zod boundary instead, so the agent gets a validation error
   * before any service call runs.
   */
  allowUnfiltered?: boolean
  /**
   * Issue #283. When `true`, skip the default scope filter that
   * excludes narrow-scope facts whose `Scope Key` does not match the
   * resolved scope context, and skip the expired-row exclusion.
   * Defaults to `false`. Operator audit paths
   * (`lore migrate --build-entities`, conflict scanner, status
   * surfaces) opt in.
   */
  includeOutOfScope?: boolean
}

type ListRecentOpts = {
  projectId?: string
  /**
   * Maximum rows returned. The query is single-page by design — callers on
   * the hot path (`loadWakeUpData`) cannot afford pagination loops. Clamped
   * to Notion's 100-row ceiling.
   */
  limit?: number
  includeInvalidated?: boolean
  /**
   * Issue #283. When `true`, skip the default scope filter that
   * excludes narrow-scope facts whose `Scope Key` doesn't match the
   * resolved scope context, and skip the expired-row exclusion.
   * Defaults to `false`. Operator audit paths opt in.
   */
  includeOutOfScope?: boolean
}

/** Notion's hard ceiling on `page_size`. */
const NOTION_MAX_PAGE_SIZE = 100

/**
 * Issue #283 round-4 — warning emitted once per process when the
 * scope-constrained dedup probe finds more than one live row for
 * the same `(dedupKey, scope bundle)`. Structurally that's a
 * duplicate state Notion permits (no unique constraint on the
 * combined key) and that `--dedup-keys --merge` collapses on its
 * next pass. The probe still picks the deterministic-first row
 * (`created_time ASC`) and proceeds; this warning surfaces the
 * gap to operators so they know to run the migration.
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

// Only multi-relation columns belong here. Source/SubjectEntity/ObjectEntity
// are 0-or-1 relation columns, so they cannot be truncated by Notion's
// inline relation limit.
const FACT_RELATION_PROPERTIES = [FACT_PROPS.PROJECT] as const

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
 * Clamp a caller-supplied `limit` to a Notion-safe `page_size`. Six
 * `FactService` retrieval methods share this shape: unlimited
 * (`undefined`) → Notion's max; bounded → `min(max(limit, 1), 100)`.
 *
 * - `limit: undefined` paginates to exhaustion at `NOTION_MAX_PAGE_SIZE`
 *   (callers that need the full slice — wake-up paths, migration scans).
 * - `limit: 0` is clamped up to 1; passing `0` to `dataSources.query`
 *   either infinite-loops or 400s depending on SDK version.
 * - `limit: > NOTION_MAX_PAGE_SIZE` is clamped down to the ceiling;
 *   pagination satisfies the over-100 case via the cursor loop, not by
 *   inflating `page_size`.
 *
 * The verbose name is load-bearing: a bare `clampPageSize` invites
 * callers from a future non-Notion query layer (a search index, an
 * upstream aggregator) that has a different ceiling. The `Notion`
 * prefix is the constraint that protects future correctness — this
 * helper is **not** a general clamping utility.
 *
 * `queryOverdue` is deliberately left on its own clamp shape
 * (`Math.min(limit ?? 100, 100)`, missing the `Math.max(_, 1)` guard)
 * — folding it onto this helper would change behavior for the
 * `limit: 0` caller (a 400 today, an empty result tomorrow). Worth
 * doing in a separate, scoped refactor; out of scope here.
 *
 * @internal — Notion-specific. Not a general clamping utility.
 */
export function clampNotionPageSize(limit: number | undefined): number {
  if (limit === undefined) return NOTION_MAX_PAGE_SIZE
  return Math.min(Math.max(limit, 1), NOTION_MAX_PAGE_SIZE)
}

/**
 * Build the server-side `Predicate` filter clause for a list of predicates.
 * Returns `undefined` when the input is empty so callers can skip pushing
 * a no-op clause. A single predicate collapses to `select.equals`; multiple
 * predicates fan out as an OR-of-equals (Notion's `select` filter has no
 * `is_one_of` primitive).
 *
 * Centralized so `queryBySubject`, `queryByObject`, `queryByEntityId`, and
 * `queryByEntityTextOnUnmigrated` apply the same shape — the predicate
 * filter is a recurring need across the entity-side read paths and a
 * helper avoids drift.
 */
function predicateFilterClause(
  predicates: FactPredicate[] | undefined
): Record<string, unknown> | undefined {
  if (!predicates?.length) return undefined
  if (predicates.length === 1) {
    return {
      property: FACT_PROPS.PREDICATE,
      select: { equals: predicates[0] },
    }
  }
  return {
    or: predicates.map((p) => ({
      property: FACT_PROPS.PREDICATE,
      select: { equals: p },
    })),
  }
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
 * On a pre-migration vault every `lore-fact action='create'` probe fails with the same
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
 * implementing the README's "loud enough" mandate (issue #533 +
 * security review S2 follow-up). The runtool README explicitly
 * pins:
 *
 * > silently degrading every legacy-auth caller to "RunTool
 * > unavailable" is the correct behavior, but it must be loud
 * > enough that an operator on `LORE_NOTION_TOKEN` knows why their
 * > flagged-on calls never use the new path.
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
      ? ((err as { status: number }).status)
      : undefined
  const code =
    typeof (err as { code?: unknown }).code === "string"
      ? ((err as { code: string }).code)
      : undefined
  if (status !== 401 && status !== 403 && code !== "restricted_resource") {
    return
  }
  runtoolBatchCreatesAuthFallbackLogged = true
  process.stderr.write(
    "[lore] runtool batch_create: " +
      `${status ?? "?"} ${code ?? "auth"} on token; falling back ` +
      "to per-input pages.create. RunTool requires an ntn-issued " +
      "user-actor token. See src/notion/runtool/README.md for the " +
      "auth-source matrix. Set LORE_USE_RUNTOOL_BATCH_CREATES=0 to " +
      "silence this and skip the wasted RunTool round-trip per save.\n"
  )
}

/** Reset between tests. Not exported on the public API surface. */
export function __resetRunToolBatchCreatesAuthFallbackLogForTests(): void {
  runtoolBatchCreatesAuthFallbackLogged = false
}

/**
 * Read `Fact.createdAt` with an explicit invariant check (DEFERRED-02).
 *
 * `Fact.createdAt` is typed as optional on the public boundary so
 * adding the field doesn't break external consumers building
 * `Fact`-shaped object literals (the public type is exported via
 * `src/index.ts`). At runtime, every `Fact` produced by `pageToFact`
 * carries `createdAt` because the field comes from Notion's built-in
 * `created_time` page property — present on every page since the
 * vault was created. So internal helpers (`invalidate`,
 * `touchOnRead`, the build-fact-confidence-scores migration) can
 * rely on the runtime guarantee.
 *
 * The helper exists to give a meaningful error if the invariant is
 * violated (a partial `Fact` reaches an internal helper without
 * `createdAt`) instead of letting `.slice(0, 10)` throw a generic
 * `Cannot read properties of undefined`. The error names the
 * affected method so debugging starts at the right call site.
 */
function readFactCreatedAt(
  fact: { id: string; createdAt?: string },
  callsite: string
): string {
  if (fact.createdAt === undefined) {
    throw new Error(
      `FactService.${callsite}: Fact.createdAt is unexpectedly undefined ` +
        `(fact id=${fact.id}). pageToFact always populates createdAt from ` +
        `Notion's built-in created_time; a missing value indicates a ` +
        `partial Fact constructed outside pageToFact reached an internal ` +
        `helper.`
    )
  }
  return fact.createdAt
}

export class FactService {
  /**
   * Resolved scope context (issue #283). Same posture as
   * `MemoryService.scopeCtx`. Default reads filter the Facts DB by
   * the same scope-inclusion rule as the Memories DB.
   */
  private scopeCtx: MemoryScopeContext = {}

  /**
   * Opt-in flag mirroring `MemoryService.scopeFilterEnabled`. Tests
   * constructing FactService without a scope context get pre-#283
   * retrieval shape; production callers that pass a context (even
   * empty) get the new filter.
   */
  private scopeFilterEnabled = false

  /**
   * Issue #533: opt-in to batching auto-`mentions` fact creates via
   * RunTool's `create_pages` tool. When false (default),
   * `createBatchWithDedup` reproduces the pre-#533 fan-out shape
   * exactly — `Promise.allSettled(map(createWithDedup))` — so the
   * flag-off behavior is byte-equivalent to today's emission. When
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
   * `https://www.notion.so/`. Live verification at PR #538 review
   * time confirmed the server rejects host-mismatched URLs.
   */
  private relationUrlBase: string | undefined

  constructor(
    private client: Client,
    private db: DatabaseRef,
    scopeCtx?: MemoryScopeContext,
    options?: { useRunToolBatchCreates?: boolean; relationUrlBase?: string }
  ) {
    if (scopeCtx) {
      this.scopeCtx = scopeCtx
      this.scopeFilterEnabled = true
    }
    if (options?.useRunToolBatchCreates === true) {
      this.useRunToolBatchCreates = true
    }
    this.relationUrlBase = options?.relationUrlBase
  }

  /**
   * Issue #533 — toggle the batch-create path at runtime. Mirrors
   * the constructor option so a test can flip the flag without
   * re-instantiating, and `setScopeContext`-style mid-process
   * reconfiguration stays consistent with how other flags are
   * threaded through this service.
   */
  setUseRunToolBatchCreates(enabled: boolean): void {
    this.useRunToolBatchCreates = enabled
  }

  setScopeContext(ctx: MemoryScopeContext): void {
    this.scopeCtx = ctx
    this.scopeFilterEnabled = true
  }

  getScopeContext(): Readonly<MemoryScopeContext> {
    return this.scopeCtx
  }

  /**
   * Wrap a caller-built filter with the issue #283 default scope
   * inclusion clauses (`Scope Kind` broadcast / narrow-key match,
   * `Expires At` not-past). Threaded through every public read on
   * the Facts DB so a session-scoped fact created by another reader
   * cannot surface in this reader's `queryByEntity` /
   * `queryBySubject` / `queryByObject` / `queryBySourceMemory`
   * results.
   *
   * No-ops on two paths:
   * - Caller passes `includeOutOfScope: true` (audit / migration paths).
   * - The service was constructed without a scope context (test
   *   fixtures running on the pre-#283 filter shape).
   *
   * Mirrors the corresponding helpers on `MemoryService`. Centralized
   * so a future contributor adding a new public read on `FactService`
   * threads the same gate by calling this one method rather than
   * re-deriving the scope clause.
   */
  private applyDefaultScope(
    filter: Record<string, unknown> | undefined,
    includeOutOfScope: boolean | undefined
  ): Record<string, unknown> | undefined {
    if (includeOutOfScope === true || !this.scopeFilterEnabled) return filter
    return withDefaultScopeFilter(filter, this.scopeCtx, todayUtc(), FACT_SCOPE_PROPS)
  }

  /**
   * Companion client-side post-filter for `applyDefaultScope`
   * (issue #283). Notion's compound-filter language caps nesting
   * at 2 levels, so the server-side filter narrows to "scope kind
   * is broadcast OR one of the reader's narrow kinds" without
   * binding kind+key. The kind+key binding runs here client-side:
   * a row whose `Scope Kind` is `session` and whose `Scope Key`
   * does not equal the reader's `LORE_SESSION_ID` drops at this
   * step. The over-fetch is small in practice; pagination loops
   * in the public reads continue past dropped rows so the result
   * still hits the caller's `limit`.
   *
   * Returns `undefined` when scope filtering is disabled (audit
   * caller / no scope context) so the caller can skip the
   * post-filter step entirely.
   */
  private postScopeFilterPredicate(
    includeOutOfScope: boolean | undefined
  ): ((page: PageObjectResponse) => boolean) | undefined {
    if (includeOutOfScope === true || !this.scopeFilterEnabled) return undefined
    const today = todayUtc()
    const ctx = this.scopeCtx
    return (page) => matchesDefaultScope(page.properties, ctx, today, FACT_SCOPE_PROPS)
  }

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
          objectEntityId: extractRelationIds(page.properties[FACT_PROPS.OBJECT_ENTITY])[0] ?? null,
        })
      }
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)

    return hits
  }

  /**
   * Find live facts where the given Entity row appears on either the
   * Subject or Object side via the canonical relation columns. This is
   * the post-PF3-01 read path: a single round-trip with deduped results
   * across both sides, no substring fragility.
   *
   * Returns `[]` on a vault that hasn't run the build-entities migration
   * yet — no rows reference the entity, so the result is empty by
   * construction. Private by design — exposing it would invite a caller
   * to skip the unbackfilled-text companion in `queryByEntity` and ship
   * a silent recall regression on transition-window vaults. Symmetric
   * with the also-private `queryByEntityTextOnUnmigrated`; both are
   * union members, neither is a public read path. External consumers
   * must go through `queryByEntity`, which unions the two branches.
   */
  private async queryByEntityId(
    entityId: string,
    opts?: {
      projectId?: string
      includeInvalidated?: boolean
      predicates?: FactPredicate[]
      /**
       * Cap total results. Pagination stops as soon as this is reached and
       * the per-request `page_size` is clamped to `min(limit, 100)` so a
       * top-N consumer doesn't pay for a full unbounded walk. Mirrors the
       * shape of `queryBySubject` / `queryByObject` / `queryBySourceMemory`.
       */
      limit?: number
      /** Issue #283. See `applyDefaultScope` for semantics. */
      includeOutOfScope?: boolean
    }
  ): Promise<Fact[]> {
    const filters: Array<Record<string, unknown>> = [
      {
        or: [
          { property: FACT_PROPS.SUBJECT_ENTITY, relation: { contains: entityId } },
          { property: FACT_PROPS.OBJECT_ENTITY, relation: { contains: entityId } },
        ],
      },
    ]

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId, FACT_PROPS.PROJECT))
    }
    if (!opts?.includeInvalidated) {
      filters.push({
        property: FACT_PROPS.VALID_UNTIL,
        date: { is_empty: true },
      })
    }

    const predicateClause = predicateFilterClause(opts?.predicates)
    if (predicateClause) filters.push(predicateClause)

    const baseFilter = filters.length > 1 ? { and: filters } : filters[0]
    // Issue #283 — narrow-scope facts whose Scope Key doesn't match
    // the reader drop out of default `queryByEntity` recall. The
    // server-side filter narrows to broadcast + reader's narrow
    // kinds; the kind+key binding runs in `postScopePredicate`.
    const filter = this.applyDefaultScope(baseFilter, opts?.includeOutOfScope)
    const postScopePredicate = this.postScopeFilterPredicate(opts?.includeOutOfScope)
    const results: PageObjectResponse[] = []
    let cursor: string | undefined = undefined
    const limit = opts?.limit
    const pageSize = clampNotionPageSize(limit)
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: pageSize,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
        if (postScopePredicate && !postScopePredicate(page)) continue
        results.push(page)
        if (limit !== undefined && results.length >= limit) break
      }
      if (limit !== undefined && results.length >= limit) break
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)

    return await this.pageToFacts(results)
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

    // Issue #283 round-4 — scope/lifetime participates in the merge
    // contract via a server-side filter. The probe binds every
    // scope component (`Scope Kind`, `Scope Key`, `Audience`,
    // `Lifetime`, `Expires At`) plus `DedupKey` and `Valid Until is_empty`,
    // so the result is exactly the row that should merge or empty.
    // No client-side walk, no arbitrary cap — Notion does the
    // bundle-equality match itself. Both directions of the round-2
    // review's "same-triple-different-scope" test still pass
    // because every scope column is bound on the server.
    //
    // The `lore migrate --dedup-keys --merge` migration uses the
    // matching grouping (`computeFactGroupKey` joins all five
    // columns) so create-time dedup and migration-time merge
    // converge on the same identity rule.
    const compatibleExisting = await this.findScopeMatchingLiveByDedupKey(
      dedupKey,
      relationSafeInput.scope
    ).catch((err) => {
      // Probe failure (e.g. transient network blip, or a pre-migration
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
   * reuse it on the per-input fallback path (issue #533) without
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
    const page = await this.client.pages.create({
      parent: { type: "database_id", database_id: this.db.databaseId },
      properties: buildFactProps({
        subject: relationSafeInput.subject,
        predicate: relationSafeInput.predicate,
        object: relationSafeInput.object,
        projectIds: relationSafeInput.projectIds,
        validFrom: relationSafeInput.validFrom ?? new Date().toISOString().split("T")[0],
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
      }),
    })

    // We just created the row with a typed `FactPredicate` value, so
    // `pageToFact`'s historical-tracking filter cannot reject it.
    return {
      fact: (await this.pageToFact(page as PageObjectResponse))!,
      deduped: false,
      enriched: [],
    }
  }

  /**
   * Batch sibling of `createWithDedup` — same dedup + provenance
   * semantics applied across many inputs (issue #533).
   *
   * Two execution paths:
   *
   * 1. **Flag off** (default): byte-equivalent to today's auto-mention
   *    emission shape — `Promise.allSettled(inputs.map(createWithDedup))`.
   *    The acceptance criterion's "behavioral equivalence under the
   *    flag-off path" is satisfied by construction: this branch is the
   *    same fan-out the MCP layer used to issue inline.
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
   *      via createWithDedup` test in `fact-batch.test.ts`.
   *
   * Returns `PromiseSettledResult<CreateFactResult>[]` so per-input
   * failures stay isolated — the same shape `Promise.allSettled` gives
   * the auto-mention caller today, just routed through one method.
   *
   * Empty `inputs` returns `[]` without any Notion call. Single-input
   * `inputs` short-circuits to `createWithDedup` to keep the
   * single-call path on its existing locking discipline.
   *
   * **Concurrency caveat (PR #538 strong rec #4).** The flag-on
   * path runs N dedup probes in parallel for the same `inputs`
   * batch, expanding the cross-process dedup race window from
   * `createWithDedup`'s 1× to N× — between any pair of
   * `(probe, fresh-create)` operations on the same triple, an
   * out-of-process writer could land a matching row that this
   * batch's probes did not see. The result on a race is at most
   * one extra duplicate row per racing input, collapsed by the
   * authoritative `lore migrate --dedup-keys --merge` pass per
   * the existing dedup contract documentation in
   * `src/core/AGENTS.md`. The blast radius is acceptable for
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
      return await Promise.allSettled(
        inputs.map((input) => this.createWithDedup(input))
      )
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
    const results: PromiseSettledResult<CreateFactResult>[] = new Array(
      inputs.length
    )

    type ReadyMiss = {
      idx: number
      relationSafeInput: CreateFactInput
      dedupKey: string
      subjectKey: string
      reviewBy: string | undefined
    }

    // Phase 1: probe dedup for every input in parallel. Any failure
    // here (decode / archive-relation drop / probe error path that
    // throws unexpectedly) becomes a per-input rejection rather
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
          const relationSafeInput =
            await this.dropArchivedEntityRelations(decodedInput)
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

    // Phase 2: build the page payloads and dispatch one
    // `create_pages` call. The wrapper chunks defensively — see
    // `RUNTOOL_CREATE_PAGES_MAX_CHUNK` — so callers can pass any
    // number of misses without thinking about the server cap.
    const validFromDefault = new Date().toISOString().split("T")[0]
    const pagePayloads: RunToolCreatePagesInputPage[] = misses.map((m) => ({
      properties: buildFactProps({
        subject: m.relationSafeInput.subject,
        predicate: m.relationSafeInput.predicate,
        object: m.relationSafeInput.object,
        projectIds: m.relationSafeInput.projectIds,
        validFrom: m.relationSafeInput.validFrom ?? validFromDefault,
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

    // PR #538 review (optional refactor + Round 2 transport-drop fix):
    // discriminated union over the three terminal states of the batch
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
    //   had no server-side effects (Round 2 review).
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
      // Security review S1 (PR #538) + Round 2: classify the
      // underlying cause to decide whether the tail fallback
      // must re-probe. Transport-class failures (no HTTP
      // status — network drop, read timeout) and 5xx server
      // errors might have committed before we lost the
      // response, so the tail must re-probe via
      // `createWithDedup` to absorb the orphan commit.
      // Pre-commit 4xx validation errors cannot have committed,
      // so the tail safely uses `freshCreateAfterDedupMiss`
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
            validFromDefault
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
            const result = await this.createWithDedupLocked(
              m.relationSafeInput
            )
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
   * fixture in `fact.test.ts`, so a future refactor that flips the
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
    // source memory we don't clobber it (PR #44's "no orphans" contract
    // only cares about filling the gap, not re-pointing a linked row).
    // Same posture below for the entity relations.
    const fillingSource = Boolean(!existing.sourceMemoryId && decodedInput.sourceMemoryId)
    // First-writer-wins on the entity relations, mirroring Source's
    // posture. Cold creates already populate `SubjectEntity` /
    // `ObjectEntity` from `decodedInput` via `buildFactProps`; the dedup
    // path used to drop them on the floor, leaving canonical relations
    // absent on rows that match a legacy (pre-PF3-01) or partially
    // migrated row even though the current write already resolved the
    // ids. We fill only when the existing relation is empty AND the
    // incoming write resolved one — preserving an existing relation
    // matches the no-clobber rule on Source. Concurrency analysis vs
    // `lore migrate --build-entities` lives in `src/core/AGENTS.md`.
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
   * Issue #283 round-4 review — the pre-fix walker paginated through
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
   * the round-3 follow-on shape `defaultScopeInclusionFilter`
   * adopted elsewhere in the codebase. Scope columns that are
   * `null` / empty on the incoming write get `is_empty` clauses on
   * the corresponding column so a broadcast write doesn't match a
   * narrow-scoped row (or vice versa). The scope-bundle equality
   * the previous candidate walker enforced via
   * `scopesMatchForMerge` is now structurally enforced by the
   * filter itself; both directions of the round-2 review's
   * "same-triple-different-scope" test still pass because the
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

    const audience =
      scope?.audience && scope.audience.length > 0 ? scope.audience : null
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
    // Strict-empty subject (`""`) used to silently fall through to "list
    // every fact in scope" — a quiet way for an MCP caller or a future
    // internal caller to enumerate the entire vault. Gate that branch
    // behind an explicit `allowUnfiltered: true` opt-in (issue #481).
    // Internal callers that genuinely want vault-wide enumeration (the
    // `--build-entities` migration scan) pass the flag.
    //
    // DO NOT tighten this to `subject.trim() === ""`. Whitespace-only
    // inputs (`"   "`) intentionally still pass through to the literal-
    // substring `Subject contains <raw>` fallback below — same posture
    // as the punctuation-only case (`"."`, `"!!!"`) pinned by the
    // `falls back to raw Subject when input normalizes to empty
    // (punctuation/whitespace only)` test in `fact.test.ts`. The agent-
    // facing surface guards empty / whitespace at the `queryByEntity`
    // and MCP boundaries (which is where typoed /
    // `expandEntityQueryVariants`-empty values reach the system) so
    // this internal helper does not need a tighter trim check.
    if (subject === "" && !opts?.allowUnfiltered) return []

    const filters: Array<Record<string, unknown>> = []

    // Allow empty subject to list all facts in scope (only reachable
    // via `allowUnfiltered: true` per the guard above).
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
              property: FACT_PROPS.SUBJECT_KEY,
              rich_text: { contains: normalizedKey },
            },
            { property: FACT_PROPS.SUBJECT, title: { contains: subject } },
          ],
        })
      } else {
        filters.push({ property: FACT_PROPS.SUBJECT, title: { contains: subject } })
      }
    }

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId, FACT_PROPS.PROJECT))
    }

    if (!opts?.includeInvalidated) {
      filters.push({
        property: FACT_PROPS.VALID_UNTIL,
        date: { is_empty: true },
      })
    }

    if (opts?.predicates?.length) {
      if (opts.predicates.length === 1) {
        filters.push({
          property: FACT_PROPS.PREDICATE,
          select: { equals: opts.predicates[0] },
        })
      } else {
        filters.push({
          or: opts.predicates.map((p) => ({
            property: FACT_PROPS.PREDICATE,
            select: { equals: p },
          })),
        })
      }
    }

    const baseFilter =
      filters.length > 1
        ? { and: filters }
        : filters.length === 1
          ? filters[0]
          : undefined

    // Issue #283 — apply the default scope filter before pagination so
    // narrow-scope facts whose Scope Key doesn't match the reader drop
    // out of `lore-query action='ask'` Subject substring recall.
    const filter = this.applyDefaultScope(baseFilter, opts?.includeOutOfScope)
    const postScopePredicate = this.postScopeFilterPredicate(opts?.includeOutOfScope)

    const results: PageObjectResponse[] = []
    let cursor: string | undefined = undefined
    const limit = opts?.limit
    const pageSize = clampNotionPageSize(limit)
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: pageSize,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
        if (postScopePredicate && !postScopePredicate(page)) continue
        results.push(page)
        if (limit !== undefined && results.length >= limit) break
      }
      if (limit !== undefined && results.length >= limit) break
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)

    return await this.pageToFacts(results)
  }

  async queryByObject(object: string, opts?: QueryFactsOpts): Promise<Fact[]> {
    // Mirror `queryBySubject`'s strict-empty guard. `Object rich_text
    // contains ""` matches every populated row in scope, so a strict-
    // empty string would silently produce a vault-wide scan. Whitespace-
    // only inputs still pass through to a literal-substring filter
    // (same posture as `queryBySubject`).
    if (object === "" && !opts?.allowUnfiltered) return []

    const filters: Array<Record<string, unknown>> = []

    if (object) {
      // Case-sensitive `contains` on the raw Object column — symmetric
      // with the pre-P3-03 `queryBySubject` semantics. P3-03 Part A only
      // canonicalizes Subject because Part A's spec adds `SubjectKey`
      // alone; an `ObjectKey` mirror is Part B work (Entities DB) and
      // intentionally out of scope. Until then, `queryByEntity` is
      // half-canonical: case-folded against Subject, raw against Object.
      filters.push({ property: FACT_PROPS.OBJECT, rich_text: { contains: object } })
    }

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId, FACT_PROPS.PROJECT))
    }

    if (!opts?.includeInvalidated) {
      filters.push({
        property: FACT_PROPS.VALID_UNTIL,
        date: { is_empty: true },
      })
    }

    if (opts?.predicates?.length) {
      if (opts.predicates.length === 1) {
        filters.push({
          property: FACT_PROPS.PREDICATE,
          select: { equals: opts.predicates[0] },
        })
      } else {
        filters.push({
          or: opts.predicates.map((p) => ({
            property: FACT_PROPS.PREDICATE,
            select: { equals: p },
          })),
        })
      }
    }

    const baseFilter =
      filters.length > 1
        ? { and: filters }
        : filters.length === 1
          ? filters[0]
          : undefined

    // Issue #283 — apply default scope filter on Object substring recall
    // so narrow-scope facts referenced in another reader's session
    // don't surface here.
    const filter = this.applyDefaultScope(baseFilter, opts?.includeOutOfScope)
    const postScopePredicate = this.postScopeFilterPredicate(opts?.includeOutOfScope)

    const results: PageObjectResponse[] = []
    let cursor: string | undefined = undefined
    const limit = opts?.limit
    const pageSize = clampNotionPageSize(limit)
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: pageSize,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
        if (postScopePredicate && !postScopePredicate(page)) continue
        results.push(page)
        if (limit !== undefined && results.length >= limit) break
      }
      if (limit !== undefined && results.length >= limit) break
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)

    return await this.pageToFacts(results)
  }

  async queryBySourceMemory(
    sourceMemoryId: string,
    opts?: QueryFactsOpts
  ): Promise<Fact[]> {
    const filters: Array<Record<string, unknown>> = [
      {
        property: FACT_PROPS.SOURCE,
        relation: { contains: sourceMemoryId },
      },
    ]

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId, FACT_PROPS.PROJECT))
    }

    if (!opts?.includeInvalidated) {
      filters.push({
        property: FACT_PROPS.VALID_UNTIL,
        date: { is_empty: true },
      })
    }

    if (opts?.predicates?.length) {
      if (opts.predicates.length === 1) {
        filters.push({
          property: FACT_PROPS.PREDICATE,
          select: { equals: opts.predicates[0] },
        })
      } else {
        filters.push({
          or: opts.predicates.map((p) => ({
            property: FACT_PROPS.PREDICATE,
            select: { equals: p },
          })),
        })
      }
    }

    const baseFilter = filters.length > 1 ? { and: filters } : filters[0]

    // Issue #283 — narrow-scope facts whose Scope Key doesn't match
    // the reader drop out of `queryBySourceMemory` recall by default.
    // The auto-mentions diff path in `MemoryService.update` opts out
    // (`includeOutOfScope: true`) because the diff must see every
    // fact the row sourced regardless of scope, otherwise the
    // re-emission would leave orphan facts whose source memory was
    // re-titled.
    const filter = this.applyDefaultScope(baseFilter, opts?.includeOutOfScope)
    const postScopePredicate = this.postScopeFilterPredicate(opts?.includeOutOfScope)

    const results: PageObjectResponse[] = []
    let cursor: string | undefined = undefined
    const limit = opts?.limit
    const pageSize = clampNotionPageSize(limit)
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: pageSize,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
        if (postScopePredicate && !postScopePredicate(page)) continue
        results.push(page)
        if (limit !== undefined && results.length >= limit) break
      }
      if (limit !== undefined && results.length >= limit) break
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)

    return await this.pageToFacts(results)
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
    const filters: Array<Record<string, unknown>> = []

    if (opts.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId, FACT_PROPS.PROJECT))
    }

    if (!opts.includeInvalidated) {
      filters.push({
        property: FACT_PROPS.VALID_UNTIL,
        date: { is_empty: true },
      })
    }

    const baseFilter =
      filters.length > 1
        ? { and: filters }
        : filters.length === 1
          ? filters[0]
          : undefined

    // Default scope filter (issue #283). The wake-up Active Facts
    // section reads through this method — without scope filtering,
    // a session-scoped fact would surface in every other session's
    // wake-up, which is the load-bearing acceptance-criterion failure
    // mode. `includeOutOfScope: true` opts out for audit paths; the
    // filter also no-ops when `scopeFilterEnabled` is false.
    const filter =
      opts.includeOutOfScope === true || !this.scopeFilterEnabled
        ? baseFilter
        : withDefaultScopeFilter(baseFilter, this.scopeCtx, todayUtc(), FACT_SCOPE_PROPS)

    const pageSize = clampNotionPageSize(opts.limit)

    const response = await this.client.dataSources.query({
      data_source_id: this.db.dataSourceId,
      filter: filter as QueryDataSourceParameters["filter"],
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: pageSize,
    })

    let pages = response.results.filter(isFullPage) as PageObjectResponse[]
    // Issue #283 — kind+key binding via client-side post-filter.
    // `listRecent` is single-page by design (the wake-up hot
    // path), so dropped narrow-key-mismatch rows just shrink the
    // result; we do NOT paginate to backfill, mirroring the
    // pre-#283 single-page contract.
    const postScopePredicate = this.postScopeFilterPredicate(opts.includeOutOfScope)
    if (postScopePredicate) {
      pages = pages.filter(postScopePredicate)
    }
    return {
      items: await this.pageToFacts(pages),
      hasMore: response.has_more ?? false,
    }
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
   * **Unresolved-entity fallback.** When `entityId` is null/undefined
   * (the caller's resolver couldn't pick a canonical row), falls back
   * to text matching: Subject side is case-folded via
   * `queryBySubject` (P3-03 Part A), Object side stays case-sensitive
   * `contains`. Asymmetric on the Object side — callers should
   * normalize input or accept the asymmetry.
   *
   * Returns deduped: a fact whose Subject AND Object both reference
   * the entity surfaces once.
   */
  async queryByEntity(
    entity: string,
    opts?: {
      projectId?: string
      entityId?: string | null
      predicates?: FactPredicate[]
      /**
       * Cap total results returned to the caller. Forwarded into both
       * underlying branches as a per-branch `page_size` clamp + early-stop,
       * and applied again as a post-dedup slice so a `limit: 25` consumer
       * never sees more than 25 rows even when both branches contribute
       * distinct hits. `undefined` paginates each branch to exhaustion —
       * required by wake-up paths and migration scans that need the full
       * slice.
       */
      limit?: number
      /**
       * Issue #283. Forwarded into both underlying branches so the
       * scope filter applies symmetrically across the relation and
       * substring legs. Audit / migration paths set `true`.
       */
      includeOutOfScope?: boolean
    }
  ): Promise<Fact[]> {
    // Empty / whitespace entity would otherwise reach `queryBySubject`
    // and `queryByObject` — and the `queryByEntityTextOnUnmigrated`
    // path below — all of which match every live fact in scope on a
    // bare `contains: ""`. Short-circuit to `[]` so an MCP caller that
    // lets an empty / trimmed-empty string through, or an
    // `expandEntityQueryVariants` reduction that yields empty, cannot
    // trigger a full-vault paginated scan. The relation branch via
    // `entityId` is inherently filtered, but we guard at the top so
    // the no-`entityId` fallback and the parallel substring branch
    // share the same posture.
    if (!entity.trim()) return []

    const limit = opts?.limit
    const sliceToLimit = (rows: Fact[]): Fact[] =>
      limit !== undefined ? rows.slice(0, limit) : rows

    if (opts?.entityId) {
      // Hot-path: relation hits + un-backfilled substring hits, run in
      // parallel so wall-clock is one round-trip, not two. Predicate
      // filter applies server-side on both branches so callers like
      // `lore-decision action='context'` (predicates: ["decided_by"]) don't
      // over-fetch unrelated facts touching the same entity. The limit
      // is forwarded into both branches so each underlying query clamps
      // its `page_size` and stops after `limit` rows; the post-dedup
      // slice below caps the union (two branches × `limit` could
      // otherwise return up to `2 × limit` distinct rows).
      const [byRelation, byTextOnUnmigrated] = await Promise.all([
        this.queryByEntityId(opts.entityId, {
          projectId: opts.projectId,
          predicates: opts.predicates,
          limit,
          includeOutOfScope: opts.includeOutOfScope,
        }),
        this.queryByEntityTextOnUnmigrated(entity, {
          projectId: opts.projectId,
          predicates: opts.predicates,
          limit,
          includeOutOfScope: opts.includeOutOfScope,
        }),
      ])
      const seen = new Set(byRelation.map((f) => f.id))
      return sliceToLimit([
        ...byRelation,
        ...byTextOnUnmigrated.filter((f) => !seen.has(f.id)),
      ])
    }

    const asSubject = await this.queryBySubject(entity, opts)
    const asObject = await this.queryByObject(entity, opts)
    const seen = new Set(asSubject.map((f) => f.id))
    return sliceToLimit([...asSubject, ...asObject.filter((f) => !seen.has(f.id))])
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
    opts?: {
      projectId?: string
      predicates?: FactPredicate[]
      limit?: number
      /** Issue #283 — forwarded from `queryByEntity`. */
      includeOutOfScope?: boolean
    }
  ): Promise<Fact[]> {
    // Whitespace-only entity must short-circuit too. `Subject contains
    // ""` and `Object contains ""` are vault-wide matches in Notion,
    // so the OR group below would otherwise bypass every other
    // narrowing clause and emit every un-backfilled live fact.
    if (!entity.trim()) return []

    const baseFilters: Array<Record<string, unknown>> = [
      // The relation columns may not exist on a stale live schema yet
      // (a vault that hasn't run schema migration). Notion's
      // `relation.is_empty` filter on a missing column is a 400, so
      // we wrap the whole query in a try/catch and treat the failure
      // as "schema drift has not been repaired; substring fallback
      // already ran through the unresolved-entity path elsewhere —
      // return empty here so we don't double-count."
      { property: FACT_PROPS.SUBJECT_ENTITY, relation: { is_empty: true } },
      { property: FACT_PROPS.OBJECT_ENTITY, relation: { is_empty: true } },
      { property: FACT_PROPS.VALID_UNTIL, date: { is_empty: true } },
    ]
    if (opts?.projectId) {
      baseFilters.push(projectOrUnscopedFilter(opts.projectId, FACT_PROPS.PROJECT))
    }

    const predicateClause = predicateFilterClause(opts?.predicates)
    if (predicateClause) baseFilters.push(predicateClause)

    const subjectKey = computeSubjectKey(entity)
    const textOr: Array<Record<string, unknown>> = []
    if (subjectKey) {
      textOr.push({
        property: FACT_PROPS.SUBJECT_KEY,
        rich_text: { contains: subjectKey },
      })
    }
    textOr.push(
      { property: FACT_PROPS.SUBJECT, title: { contains: entity } },
      { property: FACT_PROPS.OBJECT, rich_text: { contains: entity } }
    )
    baseFilters.push({ or: textOr })

    // Issue #283 — apply default scope filter on the unmigrated-text
    // branch. Symmetric with the relation branch via `queryByEntityId`,
    // so a session-scoped fact does not surface in this reader's
    // `queryByEntity` result regardless of which branch finds it.
    const scopedFilter = this.applyDefaultScope(
      { and: baseFilters },
      opts?.includeOutOfScope
    )
    const postScopePredicate = this.postScopeFilterPredicate(opts?.includeOutOfScope)

    try {
      const results: PageObjectResponse[] = []
      let cursor: string | undefined = undefined
      const limit = opts?.limit
      const pageSize = clampNotionPageSize(limit)
      do {
        const response = await this.client.dataSources.query({
          data_source_id: this.db.dataSourceId,
          filter: scopedFilter as QueryDataSourceParameters["filter"],
          sorts: [{ timestamp: "created_time", direction: "descending" }],
          page_size: pageSize,
          start_cursor: cursor,
        })
        for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
          if (postScopePredicate && !postScopePredicate(page)) continue
          results.push(page)
          if (limit !== undefined && results.length >= limit) break
        }
        if (limit !== undefined && results.length >= limit) break
        cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
      } while (cursor)
      return await this.pageToFacts(results)
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
      { property: FACT_PROPS.SOURCE, relation: { is_empty: true } },
      { property: FACT_PROPS.VALID_UNTIL, date: { is_empty: true } },
    ]

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId, FACT_PROPS.PROJECT))
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
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)

    return await this.pageToFacts(results)
  }

  async queryOverdue(opts?: {
    projectId?: string
    limit?: number
    /**
     * Issue #283 — opt out of the default-scope filter so audit /
     * migration callers can see narrow-scope and expired rows. The
     * MCP `lore-query action='audit'` surface keeps this `false`
     * (default): a session-scoped overdue fact must not surface to
     * a different reader through audit any more than it does
     * through `queryBySubject` / `queryByObject`. Mirrors the
     * other public reads on this service.
     */
    includeOutOfScope?: boolean
  }): Promise<Fact[]> {
    const today = new Date().toISOString().split("T")[0]
    const filters: Array<Record<string, unknown>> = [
      { property: FACT_PROPS.REVIEW_BY, date: { on_or_before: today } },
      { property: FACT_PROPS.VALID_UNTIL, date: { is_empty: true } },
    ]

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId, FACT_PROPS.PROJECT))
    }

    const baseFilter = { and: filters }
    // Issue #283 — narrow-scope and expired-row filtering. Server-side
    // clauses come from `applyDefaultScope`; the kind+key binding runs
    // client-side via `postScopeFilterPredicate` because Notion's
    // compound-filter language caps nesting at 2 levels (see
    // `defaultScopeInclusionFilter`'s docstring for the empirical
    // confirmation). The audit surface (`lore-query action='audit'`,
    // wake-up's "Overdue for Review") consumes this method, so the
    // gate is required to keep session-scoped overdue rows from
    // bleeding to other readers.
    const filter = this.applyDefaultScope(baseFilter, opts?.includeOutOfScope)
    const postScopePredicate = this.postScopeFilterPredicate(opts?.includeOutOfScope)

    // Paginate to exhaustion (or to `limit`) — Notion's default page is 100
    // rows, so a single-shot query silently truncates a vault that has more
    // than 100 overdue facts. Mirror the `queryBySubject` loop shape so the
    // service exposes one consistent paginating-read pattern.
    const limit = opts?.limit
    const items: Fact[] = []
    let cursor: string | undefined = undefined
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ property: FACT_PROPS.REVIEW_BY, direction: "ascending" }],
        page_size: Math.min(limit ?? NOTION_MAX_PAGE_SIZE, NOTION_MAX_PAGE_SIZE),
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
        if (postScopePredicate && !postScopePredicate(page)) continue
        const fact = await this.pageToFact(page)
        if (fact === null) continue
        items.push(fact)
        if (limit !== undefined && items.length >= limit) break
      }
      if (limit !== undefined && items.length >= limit) break
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)

    return items
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
   * **Archived-row guarantee (issue #497).** This gate prevents archived
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
    const page = await this.client.pages.retrieve({ page_id: id })
    if (!isLiveFullPage(page)) return null
    return await this.pageToFact(page)
  }

  async extendReview(id: string, reviewBy: string | null): Promise<void> {
    await this.client.pages.update({
      page_id: id,
      properties: {
        [FACT_PROPS.REVIEW_BY]: reviewBy === null ? { date: null } : { date: { start: reviewBy } },
      },
    })
  }

  /**
   * Set the `Source` relation on an existing fact to point at a supporting
   * memory. Used by the `lore migrate --backfill-fact-sources` path to
   * retroactively link orphan facts found in an internal vault audit.
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
        [FACT_PROPS.SOURCE]: { relation: [{ id: sourceMemoryId }] },
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
   * **The read+compute+write trio is NOT atomic at the Notion API.**
   * Notion has no compare-and-swap or conditional-write primitive (same
   * posture as `createWithDedup`'s dedup race). Two concurrent
   * invalidates of the same fact — cross-process autosaves, a
   * `lore-correct` racing a `lore-fact action='invalidate'` in the
   * same session, or (post-#491) a `lore-memory action='update'`
   * computing the same `staleFacts` list as a parallel explicit
   * invalidate — can land EITHER one OR two confidence decrements
   * depending on interleaving:
   *
   * - **Both reads before either write** (A.read → B.read → A.write
   *   → B.write): both readers see the same pre-decrement
   *   `confidenceScore`, both compute `s * 0.5`, and the second
   *   writer overwrites with the same halved value. Final state is
   *   `s * 0.5` — halved exactly once.
   * - **Read interleaved with write** (A.read → A.write → B.read →
   *   B.write): the second reader sees the post-first-write
   *   `s * 0.5`, computes `s * 0.25`, and the second writer lands
   *   that quarter value. Final state is `s * 0.25` — halved twice.
   *
   * Which interleaving lands depends on Notion API latency, the
   * shared rate-limit middleware queue position, and the mix of
   * concurrent callers; the runtime can't choose between them. The
   * decrement is therefore advisory under concurrency: the
   * invalidate contract (`Valid Until = today`) holds because the
   * final `pages.update` is atomic, but the score lands somewhere
   * in `[s * 0.25, s * 0.5]` for two parallel invalidators on the
   * same row. Mirror of `MemoryService.decrementConfidence`'s
   * concurrency posture; both ship under the same contract.
   * `src/core/AGENTS.md`'s "Concurrent invalidate against the same
   * fact id" block is the cross-reference; same description in two
   * places.
   *
   * **Archived rows short-circuit (issue #497).** The helper retrieves
   * the row directly (rather than via `getById`, which collapses the
   * archived / partial / tracking-predicate cases into a single `null`)
   * so it can distinguish archived from the other null reasons. Notion
   * accepts `pages.update` against archived pages, so without this gate
   * an invalidate against an already-archived row would write
   * `Valid Until = today` onto a row that is already excluded from
   * active queries — leaving an audit-visible contradictory
   * `archived: true` plus `Valid Until: <date>` combination. The
   * confidence-decrement branch is also skipped because `Confidence`
   * on an archived row is no longer load-bearing for retrieval.
   *
   * The historical-tracking-predicate filter in `pageToFact` returns
   * `null` for legacy rows whose Predicate is `needs_action` /
   * `waiting_on` / `blocked_by`. Those rows still need to be invalidated
   * (operators running cleanup expect the call to land), but there's no
   * `Fact` shape from which to read the score, so the helper degrades
   * to a `Valid Until`-only write — the same pre-DEFERRED-02 behavior
   * for those rows. The score column stays untouched.
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
  async invalidate(id: string): Promise<void> {
    const today = todayUtc()
    let page: PageObjectResponse | null = null
    try {
      const retrieved = await this.client.pages.retrieve({ page_id: id })
      if (isFullPage(retrieved)) {
        page = retrieved
      }
    } catch {
      // Fall through: the read failed but the invalidate write must
      // still happen. The decrement is best-effort. A read failure
      // CANNOT trigger the archived short-circuit; the contract favors
      // landing the invalidate over silently dropping a write because
      // we couldn't confirm the row's state.
    }

    // Archived row: the page is already excluded from active queries.
    // Writing `Valid Until = today` would leave a contradictory
    // `archived: true` + `Valid Until: <date>` combination visible to
    // any audit walking every fact row. Skip both the invalidate write
    // and the confidence decrement.
    if (page !== null && page.archived) {
      return
    }

    let fact: Fact | null = null
    if (page !== null) {
      try {
        fact = await this.pageToFact(page)
      } catch {
        // pageToFact failed (e.g. relation hydration 5xx); fall through
        // to a `Valid Until`-only write.
        fact = null
      }
    }

    const properties: Record<string, unknown> = {
      [FACT_PROPS.VALID_UNTIL]: { date: { start: today } },
    }

    if (fact !== null) {
      // Seed-decay-then-decrement. Mirror MemoryService.decrementConfidence
      // — the same convergence guarantee: a contradiction landed before
      // the migration produces the same effective score as one landed
      // after.
      let current: number
      if (fact.confidenceScore == null) {
        const seeded = seedConfidenceScore(fact.confidence)
        current = decayConfidenceScore(
          seeded,
          readFactCreatedAt(fact, "invalidate").slice(0, 10),
          today
        )
      } else {
        current = decayConfidenceScore(
          fact.confidenceScore,
          fact.lastReferencedAt ?? null,
          today
        )
      }
      const next = decrementConfidenceScore(current)
      properties[FACT_PROPS.CONFIDENCE_SCORE] = { number: next }
      properties[FACT_PROPS.LAST_REFERENCED_AT] = { date: { start: today } }
    }

    try {
      await this.client.pages.update({
        page_id: id,
        properties: properties as UpdatePageParameters["properties"],
      })
    } catch (err) {
      // If the write failed because the schema column doesn't exist on
      // legacy vaults that haven't run `lore migrate`, fall back to the
      // bare `Valid Until` write so the invalidate still lands. The
      // operator's next migrate run will add the columns; subsequent
      // invalidates pick up the full atom.
      if (isMissingPropertyError(err)) {
        await this.client.pages.update({
          page_id: id,
          properties: {
            [FACT_PROPS.VALID_UNTIL]: { date: { start: today } },
          },
        })
        return
      }
      throw err
    }
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
    const today = opts?.today ?? todayUtc()
    await Promise.all(
      facts.map(async (fact) => {
        if (fact.lastReferencedAt === today && fact.confidenceScore != null) {
          return
        }
        try {
          let nextScore: number
          if (fact.confidenceScore == null) {
            const seeded = seedConfidenceScore(fact.confidence)
            const decayed = decayConfidenceScore(
              seeded,
              readFactCreatedAt(fact, "touchOnRead").slice(0, 10),
              today
            )
            nextScore = bumpConfidenceScore(decayed)
          } else {
            const decayed = decayConfidenceScore(
              fact.confidenceScore,
              fact.lastReferencedAt ?? null,
              today
            )
            nextScore = bumpConfidenceScore(decayed)
          }
          await this.client.pages.update({
            page_id: fact.id,
            properties: {
              [FACT_PROPS.LAST_REFERENCED_AT]: { date: { start: today } },
              [FACT_PROPS.CONFIDENCE_SCORE]: { number: nextScore },
            },
          })
          // Mirror the post-write state onto the caller's `Fact`
          // reference (issue #495). `loadWakeUpData`'s wake-up cache
          // hands the same `Fact[]` reference back on subsequent
          // hits within the 30s TTL; without this mutation, the
          // once-per-day gate above keys on the cached row's stale
          // `lastReferencedAt` and `pages.update` re-fires for every
          // Active Fact on every cache hit. Same posture as
          // `MemoryService.touchOnRead` — the picked fields are
          // mutable on `Fact` and `ReadonlyArray<Pick<...>>` only
          // freezes the array shape, not element properties.
          fact.lastReferencedAt = today
          fact.confidenceScore = nextScore
        } catch (error) {
          opts?.onError?.(fact.id, error)
        }
      })
    )
  }

  /**
   * Paginating async iterator over every live (`Valid Until is_empty`)
   * fact in this service's Facts DB, optionally scoped to a single
   * project. Yields `Fact` objects in created-time-ascending order so
   * the migration's plan output is deterministic.
   *
   * Used by `runBuildFactConfidenceScoresMigration` (DEFERRED-02). Mirrors
   * `MemoryService.listAllForBackfill` shape — same projection, same
   * project-scope semantics, same `null`-tolerant `pageToFact` filter.
   *
   * Tracking-predicate facts (filtered by `pageToFact`) are skipped so
   * the migration doesn't try to seed scores onto historical rows whose
   * domain shape we no longer recognize.
   */
  /**
   * Operator-facing counters for the `lore status` expiring/expired
   * scoped-facts surface (issue #283). Mirrors
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
    const today = todayUtc()
    const horizonMs =
      Date.parse(today) + EXPIRING_SOON_DAYS * MS_PER_DAY
    const horizon = new Date(horizonMs).toISOString().slice(0, 10)
    let expired = 0
    let expiringSoon = 0
    let narrowScopeOutOfContext = 0
    const ctx = this.scopeCtx
    for await (const fact of this.listAllForBackfill(opts)) {
      const scope = fact.scope ?? null
      if (scope === null) continue
      const expiresAt = scope.expiresAt
      if (expiresAt !== null) {
        if (expiresAt < today) {
          expired += 1
        } else if (expiresAt <= horizon) {
          expiringSoon += 1
        }
      }
      const kind = scope.kind
      if (kind === null) continue
      if (kind === "team" || kind === "project" || kind === "global") continue
      const expected =
        kind === "user"
          ? ctx.userId
          : kind === "agent"
            ? ctx.agent
            : kind === "role"
              ? ctx.role
              : kind === "session"
                ? ctx.session
                : kind === "run"
                  ? ctx.run
                  : kind === "environment"
                    ? ctx.environment
                    : undefined
      if (expected === undefined || scope.key !== expected) {
        narrowScopeOutOfContext += 1
      }
    }
    return { expired, expiringSoon, narrowScopeOutOfContext }
  }

  async *listAllForBackfill(
    opts: {
      projectId?: string
    } = {}
  ): AsyncGenerator<Fact, void, void> {
    const filters: Array<Record<string, unknown>> = [
      { property: FACT_PROPS.VALID_UNTIL, date: { is_empty: true } },
    ]
    if (opts.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId, FACT_PROPS.PROJECT))
    }
    const filter = filters.length > 1 ? { and: filters } : filters[0]
    let cursor: string | undefined
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "ascending" }],
        page_size: 100,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
        const fact = await this.pageToFact(page)
        if (fact === null) continue
        yield fact
      }
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)
  }

  /**
   * Single `pages.update` writing both `Confidence Score` and
   * `Last Referenced At` (DEFERRED-02). Mirrors
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
    await this.client.pages.update({
      page_id: factId,
      properties: {
        [FACT_PROPS.CONFIDENCE_SCORE]: { number: score },
        [FACT_PROPS.LAST_REFERENCED_AT]: { date: { start: lastReferencedAt } },
      },
    })
  }

  /**
   * Count live facts (`Valid Until is_empty`) whose Notion `Predicate`
   * select value matches one of the given raw select-value strings.
   *
   * **Deliberate double back door** — do not refactor either asymmetry:
   *
   * 1. `string[]` over `FactPredicate[]`. The 0.6.0 deprecation purge
   *    (#23) contracts the `FactPredicate` union to drop
   *    `needs_action` / `waiting_on` / `blocked_by`. A typed-predicate
   *    signature would refuse to compile against those literals once
   *    they leave the union, breaking the preflight that exists
   *    precisely to detect them. Raw strings let the `lore status`
   *    preflight keep recognizing historical Notion `Predicate` values
   *    after the type contraction.
   *
   * 2. `Promise<number>` over `Promise<Fact[]>`. The same #23 PR adds a
   *    filter inside `pageToFact` that returns `null` for rows whose
   *    predicate is no longer in the typed union, so a `Fact[]`-shape
   *    method would silently drop every historical tracking row from
   *    its result set on 0.6.0 — and the preflight count would regress
   *    to zero even when the vault still carries the rows in Notion.
   *    Walking `response.results.length` directly never instantiates
   *    `Fact` objects, so the count remains correct across the
   *    `pageToFact` filter change.
   *
   * Routing this through `pageToFact`, or wrapping a `queryBy*`
   * accessor and converting back to a count, silently breaks the
   * preflight on the next release. The `Raw` suffix marks the
   * intentional bypass — same convention as the `raw` paths under
   * `src/notion/`.
   *
   * Empty input returns 0 without issuing a query.
   */
  async countByPredicateRaw(strings: string[]): Promise<number> {
    if (strings.length === 0) return 0

    const predicateClause: Record<string, unknown> =
      strings.length === 1
        ? { property: FACT_PROPS.PREDICATE, select: { equals: strings[0] } }
        : {
            or: strings.map((p) => ({
              property: FACT_PROPS.PREDICATE,
              select: { equals: p },
            })),
          }

    const filter = {
      and: [{ property: FACT_PROPS.VALID_UNTIL, date: { is_empty: true } }, predicateClause],
    }

    let count = 0
    let cursor: string | undefined = undefined
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        page_size: NOTION_MAX_PAGE_SIZE,
        start_cursor: cursor,
      })
      count += response.results.length
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)

    return count
  }

  /**
   * Map a Notion page to the `Fact` domain type, or `null` for rows
   * whose raw `Predicate` select value is one of the historical
   * tracking strings (`needs_action` / `waiting_on` / `blocked_by`).
   *
   * Tracking predicates were removed from `FactPredicate` in 0.6.0
   * (`lore-task` is the canonical surface for tracked work). Historical
   * Notion rows still carry those select values — the schema is
   * additive-only — so the deserialization boundary filters them so
   * no live read path surfaces them as a `Fact`. `countByPredicateRaw`
   * deliberately bypasses this filter so the `lore status` preflight
   * keeps counting the rows.
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
  private async pageToFact(page: PageObjectResponse): Promise<Fact | null> {
    page = await hydrateRelationProperties(this.client, page, FACT_RELATION_PROPERTIES)
    return this.pageToFactSync(page)
  }

  /**
   * Batched sibling of `pageToFact`: hydrates relation overflow for the
   * full result set in a single `p-limit(3)`-gated call (via
   * `hydrateRelationPropertiesForPages`), then runs the synchronous
   * deserialization over the already-hydrated pages and drops historical
   * tracking-predicate `null` returns.
   *
   * Result-set callers (paginated `dataSources.query` consumers) must
   * route through this method instead of `Promise.all(results.map(p =>
   * this.pageToFact(p)))`. The shapes are observationally equivalent —
   * both inherit the rate-limit Proxy's concurrency-3 gate — but
   * routing through here consolidates relation-property semantics on
   * the batched helper so a future change to retry policy, hydration
   * scope, or column set has one chokepoint instead of one per call
   * site.
   *
   * The single-row `pageToFact` callers (`getById`, `lookupByDedupKey`,
   * and the inner-loop iterators in `queryOverdue` /
   * `listAllForBackfill` that process one row per outer page) keep the
   * per-page hydration path — there is no result set to batch.
   */
  private async pageToFacts(pages: readonly PageObjectResponse[]): Promise<Fact[]> {
    if (pages.length === 0) return []
    const hydrated = await hydrateRelationPropertiesForPages(
      this.client,
      pages,
      FACT_RELATION_PROPERTIES
    )
    const facts: Fact[] = []
    for (const page of hydrated) {
      const fact = this.pageToFactSync(page)
      if (fact !== null) facts.push(fact)
    }
    return facts
  }

  /**
   * Synchronous deserialization of an already-hydrated fact page.
   * `pageToFact` and `pageToFacts` both delegate here after their
   * respective hydration step. Returns `null` for historical
   * tracking-predicate rows so callers can filter them at the
   * deserialization boundary.
   */
  private pageToFactSync(page: PageObjectResponse): Fact | null {
    const props = page.properties
    const rawPredicate = extractSelect(props[FACT_PROPS.PREDICATE], "related_to")
    if (HISTORICAL_TRACKING_PREDICATE_VALUES.has(rawPredicate)) {
      return null
    }
    const sourceIds = extractRelationIds(props[FACT_PROPS.SOURCE])
    // PF3-01 — relation columns return `[]` on un-migrated rows
    // because Notion responds with an empty list when the column
    // exists in the schema but is unset on the row. Treat any populated
    // relation as the canonical entity id; ignore the [1+] case (a
    // Fact only ever points at one canonical Entity per side).
    const subjectEntityIds = extractRelationIds(props[FACT_PROPS.SUBJECT_ENTITY])
    const objectEntityIds = extractRelationIds(props[FACT_PROPS.OBJECT_ENTITY])

    return {
      id: page.id,
      subject: extractTitle(props[FACT_PROPS.SUBJECT]),
      predicate: rawPredicate as FactPredicate,
      object: extractRichText(props[FACT_PROPS.OBJECT]),
      projectIds: extractRelationIds(props[FACT_PROPS.PROJECT]),
      validFrom: extractDate(props[FACT_PROPS.VALID_FROM]),
      validUntil: extractDate(props[FACT_PROPS.VALID_UNTIL]),
      reviewBy: extractDate(props[FACT_PROPS.REVIEW_BY]),
      sourceMemoryId: sourceIds[0] ?? null,
      confidence: extractSelect(props[FACT_PROPS.CONFIDENCE], "certain") as FactConfidence,
      // DEFERRED-02 — system-managed numeric mirror of the categorical
      // `Confidence` select. `null` on pre-migration rows; populated by
      // `touchOnRead` / `decrementConfidence` / the build-fact-confidence-
      // scores migration. `extractNumber` returns `null` for missing
      // columns so legacy vaults that haven't run schema migration deserialize
      // cleanly.
      confidenceScore: extractNumber(props[FACT_PROPS.CONFIDENCE_SCORE]),
      lastReferencedAt: extractDate(props[FACT_PROPS.LAST_REFERENCED_AT]),
      createdAt: page.created_time,
      subjectEntityId: subjectEntityIds[0] ?? null,
      objectEntityId: objectEntityIds[0] ?? null,
      scope: extractFactScope(props),
    }
  }
}

/**
 * Read the five scope columns on a Facts DB row into a `MemoryScope`
 * bundle. Mirrors `extractMemoryScope` in `core/memory.ts` — same
 * "all-empty → null" rule so pre-#283 rows deserialize as null.
 */
function extractFactScope(
  props: PageObjectResponse["properties"]
): MemoryScope | null {
  const kindProp = props[FACT_PROPS.SCOPE_KIND]
  const kind =
    kindProp && kindProp.type === "select" && kindProp.select
      ? (kindProp.select.name as MemoryScopeKind)
      : null
  const key = extractRichText(props[FACT_PROPS.SCOPE_KEY])
  const audience = extractRichText(props[FACT_PROPS.AUDIENCE])
  const lifetimeProp = props[FACT_PROPS.LIFETIME]
  const lifetime =
    lifetimeProp && lifetimeProp.type === "select" && lifetimeProp.select
      ? (lifetimeProp.select.name as MemoryLifetime)
      : null
  const expiresAt = extractDate(props[FACT_PROPS.EXPIRES_AT])
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

/**
 * Raw Notion `Predicate` select values that the 0.6.0 deprecation purge
 * removed from `FactPredicate`. Notion rows still exist for vaults that
 * skipped the `--migrate-tracking-to-tasks` migration (the schema is
 * additive-only — see `src/notion/setup.ts`), so `pageToFact` filters
 * them at the deserialization boundary. Inlined as a plain set rather
 * than re-exported from `types.ts` because the `FactPredicate` union
 * itself no longer includes these values.
 */
const HISTORICAL_TRACKING_PREDICATE_VALUES: ReadonlySet<string> = new Set([
  "needs_action",
  "waiting_on",
  "blocked_by",
])

/**
 * Decide whether `createWithDedup`'s probe hit on an existing row
 * should merge into that row, or fall through to a blind create
 * (issue #283).
 *
 * Returns `true` only when the existing row's scope deep-equals the
 * incoming write's scope. The match is exact:
 *
 * - Both null (or absent): match — pre-#283 rows or untouched-scope
 *   writes coalesce as before.
 * - One null, one populated: NO match — adding scope to a previously-
 *   broadcast row, or vice versa, must not silently merge. The
 *   narrow-scope write needs its own row; the broadcast write also
 *   needs its own row so default team reads can see it.
 * - Both populated: must match on every component (`kind`, `key`,
 *   `audience`, `lifetime`, `expiresAt`).
 *
 * The `key`, `audience` rich_text comparison normalizes empty string
 * and whitespace-only on both sides to "not declared" so an explicit
 * `key: ""` clear from one side doesn't structurally split from a
 * legacy null on the other side. Select / date columns compare with
 * strict equality.
 *
 * The function is intentionally narrow: a future contributor adding
 * a sixth scope column to the type bundle gets a typecheck error
 * here when they forget to compare it, because the incoming side is
 * destructured and the destructure-rest pattern is `{ ...rest } =
 * input` — any leftover key blocks the same-shape assertion. (The
 * destructure-rest pattern is itself the test fixture's
 * regression detector; see scope-builder.test.ts.)
 */
export function scopesMatchForMerge(
  existing: import("../types.js").MemoryScope | null,
  incoming: import("../types.js").MemoryScopeInput | undefined
): boolean {
  // Treat all-undefined incoming and null existing as the same case:
  // a write with no scope bundle merging into a row with no scope.
  const incomingDeclared =
    incoming !== undefined &&
    (incoming.kind !== undefined ||
      incoming.lifetime !== undefined ||
      incoming.expiresAt !== undefined ||
      isMeaningful(incoming.key) ||
      isMeaningful(incoming.audience))
  if (existing === null && !incomingDeclared) return true
  if (existing === null || !incomingDeclared) return false

  // Both sides declare scope — every column must align. The Memory-
  // Scope-Input type allows partial writes (e.g. just `lifetime:
  // "expires"` + `expiresAt: ...` without a `kind`); for merge
  // purposes, `undefined` on the incoming side AND a non-null value
  // on the existing side is a mismatch — caller didn't declare the
  // same identity slot.
  const existingKey = existing.key.trim().length > 0 ? existing.key : null
  const incomingKey =
    incoming.key !== undefined && incoming.key.trim().length > 0 ? incoming.key : null
  const existingAudience =
    existing.audience.trim().length > 0 ? existing.audience : null
  const incomingAudience =
    incoming.audience !== undefined && incoming.audience.trim().length > 0
      ? incoming.audience
      : null

  return (
    existing.kind === (incoming.kind ?? null) &&
    existingKey === incomingKey &&
    existingAudience === incomingAudience &&
    existing.lifetime === (incoming.lifetime ?? null) &&
    existing.expiresAt === (incoming.expiresAt ?? null)
  )
}

function isMeaningful(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0
}

/**
 * Translate the agent-facing `MemoryScopeInput` shape into the flat
 * primitive arguments `buildFactProps` consumes (issue #283). Mirrors
 * `scopeInputToBuilderProps` in `core/memory.ts` — see that helper's
 * docstring for the rationale on keeping the bundle-to-primitive
 * translation outside the builder.
 */
function factScopeInputToBuilderProps(
  scope: MemoryScopeInput | undefined
): {
  scopeKind?: string | null
  scopeKey?: string
  audience?: string
  lifetime?: string | null
  expiresAt?: string | null
} {
  if (scope === undefined) return {}
  const out: ReturnType<typeof factScopeInputToBuilderProps> = {}
  if (scope.kind !== undefined) out.scopeKind = scope.kind
  if (scope.key !== undefined) out.scopeKey = scope.key
  if (scope.audience !== undefined) out.audience = scope.audience
  if (scope.lifetime !== undefined) out.lifetime = scope.lifetime
  if (scope.expiresAt !== undefined) out.expiresAt = scope.expiresAt
  return out
}

/**
 * Synthesize a `Fact` shape from a freshly-created page id + the
 * `CreateFactInput` that produced it (issue #533, batch path).
 *
 * The batch `create_pages` response carries only `{ id }` per page,
 * so the caller cannot route through `pageToFact`'s
 * `PageObjectResponse` extractor. Re-fetching every created row
 * via `pages.retrieve` would give back the N round-trips the batch
 * call just saved (see `FactService.createBatchWithDedupRunToolLocked`'s
 * "load-bearing batching win" note). Synthesizing from the input
 * preserves the wall-clock win at the cost of leaving the
 * system-managed read-side fields (`confidenceScore`,
 * `lastReferencedAt`) at their fresh-row default of `null`, which
 * is exactly what `pageToFact` would return for a never-touched
 * post-create row anyway.
 *
 * `createdAt` defaults to "now" because Notion's `created_time` is
 * server-side and not in the response. The Fact carries this as
 * an optional field per the `Fact.createdAt` doc comment.
 *
 * Auto-mention emission — the canonical caller — only checks
 * fulfilled / rejected on each result and never reads back the
 * synthesized fields, so the "approximate fields" cost is entirely
 * paid by hypothetical future consumers, which the type's optional
 * markers permit.
 *
 * **Invariant — keep aligned with `pageToFact`.** This synthesizer
 * deliberately bypasses `pageToFact`'s historical-tracking-predicate
 * filter (the `pageToFactSync` null-return for legacy
 * `needs_action` / `waiting_on` / `blocked_by` rows). The bypass is
 * safe today because the batch path validates `predicate` upstream
 * via the `FactPredicate` type — historical strings cannot reach
 * here. A future contributor who tightens `pageToFact`'s filter
 * (e.g. adding a new historical-only predicate to the null-return
 * set) MUST mirror that change here, otherwise the batch path
 * would silently surface filtered rows that the single-input path
 * would drop. Audited at PR-#538 review time; pinned only by
 * documentation, not test scaffolding.
 */
function synthesizeFactFromCreateInput(
  id: string,
  input: CreateFactInput,
  validFromDefault: string
): Fact {
  return {
    id,
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    projectIds: input.projectIds ? [...input.projectIds] : [],
    validFrom: input.validFrom ?? validFromDefault,
    validUntil: null,
    reviewBy: input.reviewBy ?? null,
    sourceMemoryId: input.sourceMemoryId ?? null,
    confidence: input.confidence ?? "certain",
    confidenceScore: null,
    lastReferencedAt: null,
    createdAt: new Date().toISOString(),
    subjectEntityId: input.subjectEntityId ?? null,
    objectEntityId: input.objectEntityId ?? null,
    scope: input.scope
      ? {
          kind: input.scope.kind ?? null,
          key: input.scope.key ?? "",
          audience: input.scope.audience ?? "",
          lifetime: input.scope.lifetime ?? null,
          expiresAt: input.scope.expiresAt ?? null,
        }
      : null,
  }
}
