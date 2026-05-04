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
import { buildFactProps } from "../notion/schema.js"
import { isMissingPropertyError } from "../notion/errors.js"
import { projectOrUnscopedFilter } from "../notion/filters.js"
import { computeFactDedupKey, computeSubjectKey } from "../notion/normalize.js"
import { decodeTextEntities } from "../notion/html-entities.js"
import { withEntityRelationLocks } from "./entity-relation-lock.js"
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
}

/** Notion's hard ceiling on `page_size`. */
const NOTION_MAX_PAGE_SIZE = 100

// Only multi-relation columns belong here. Source/SubjectEntity/ObjectEntity
// are 0-or-1 relation columns, so they cannot be truncated by Notion's
// inline relation limit.
const FACT_RELATION_PROPERTIES = ["Project"] as const

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
      property: "Predicate",
      select: { equals: predicates[0] },
    }
  }
  return {
    or: predicates.map((p) => ({
      property: "Predicate",
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
        relation: relations.subjectEntityId ? [{ id: relations.subjectEntityId }] : [],
      }
    }
    if (relations.objectEntityId !== undefined) {
      properties["ObjectEntity"] = {
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
          { property: "SubjectEntity", relation: { contains: entityId } },
          { property: "ObjectEntity", relation: { contains: entityId } },
        ],
      },
    ]

    if (!opts?.includeInvalidated) {
      filters.push({
        property: "Valid Until",
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
            extractRelationIds(page.properties["SubjectEntity"])[0] ?? null,
          objectEntityId: extractRelationIds(page.properties["ObjectEntity"])[0] ?? null,
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
    }
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

    const predicateClause = predicateFilterClause(opts?.predicates)
    if (predicateClause) filters.push(predicateClause)

    const filter = filters.length > 1 ? { and: filters } : filters[0]
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
      const enriched = await this.mergeOntoExisting(existing, relationSafeInput, reviewBy)
      return { fact: existing, deduped: true, enriched }
    }

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
    if (fillingSubjectEntity) {
      properties["SubjectEntity"] = {
        relation: [{ id: decodedInput.subjectEntityId }],
      }
      enriched.push("linked subject entity")
    }
    if (fillingObjectEntity) {
      properties["ObjectEntity"] = {
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
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }

    if (!opts.includeInvalidated) {
      filters.push({
        property: "Valid Until",
        date: { is_empty: true },
      })
    }

    const filter =
      filters.length > 1
        ? { and: filters }
        : filters.length === 1
          ? filters[0]
          : undefined

    const pageSize = clampNotionPageSize(opts.limit)

    const response = await this.client.dataSources.query({
      data_source_id: this.db.dataSourceId,
      filter: filter as QueryDataSourceParameters["filter"],
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: pageSize,
    })

    const pages = response.results.filter(isFullPage) as PageObjectResponse[]
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
        }),
        this.queryByEntityTextOnUnmigrated(entity, {
          projectId: opts.projectId,
          predicates: opts.predicates,
          limit,
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
    opts?: { projectId?: string; predicates?: FactPredicate[]; limit?: number }
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
      { property: "SubjectEntity", relation: { is_empty: true } },
      { property: "ObjectEntity", relation: { is_empty: true } },
      { property: "Valid Until", date: { is_empty: true } },
    ]
    if (opts?.projectId) {
      baseFilters.push(projectOrUnscopedFilter(opts.projectId))
    }

    const predicateClause = predicateFilterClause(opts?.predicates)
    if (predicateClause) baseFilters.push(predicateClause)

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
      { property: "Object", rich_text: { contains: entity } }
    )
    baseFilters.push({ or: textOr })

    try {
      const results: PageObjectResponse[] = []
      let cursor: string | undefined = undefined
      const limit = opts?.limit
      const pageSize = clampNotionPageSize(limit)
      do {
        const response = await this.client.dataSources.query({
          data_source_id: this.db.dataSourceId,
          filter: { and: baseFilters } as QueryDataSourceParameters["filter"],
          sorts: [{ timestamp: "created_time", direction: "descending" }],
          page_size: pageSize,
          start_cursor: cursor,
        })
        for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
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
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)

    return await this.pageToFacts(results)
  }

  async queryOverdue(opts?: { projectId?: string; limit?: number }): Promise<Fact[]> {
    const today = new Date().toISOString().split("T")[0]
    const filters: Array<Record<string, unknown>> = [
      { property: "Review By", date: { on_or_before: today } },
      { property: "Valid Until", date: { is_empty: true } },
    ]

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }

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
        filter: { and: filters } as QueryDataSourceParameters["filter"],
        sorts: [{ property: "Review By", direction: "ascending" }],
        page_size: Math.min(limit ?? NOTION_MAX_PAGE_SIZE, NOTION_MAX_PAGE_SIZE),
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isFullPage) as PageObjectResponse[]) {
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
        "Review By": reviewBy === null ? { date: null } : { date: { start: reviewBy } },
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
   * invalidates of the same fact — cross-process autosaves, or a
   * `lore-correct` racing a `lore-fact action='invalidate'` in the
   * same session — both read the same `confidenceScore`, both compute
   * `s * 0.5`, and the second writer overwrites with the same halved
   * value rather than a quarter (`s * 0.25`). The decrement is
   * therefore advisory under concurrency: the invalidate contract
   * (`Valid Until = today`) holds because the final `pages.update` is
   * atomic, but the score may end up halved-once instead of
   * halved-twice. Mirror of `MemoryService.decrementConfidence`'s
   * concurrency posture; both ship under the same contract.
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
      "Valid Until": { date: { start: today } },
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
      properties["Confidence Score"] = { number: next }
      properties["Last Referenced At"] = { date: { start: today } }
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
            "Valid Until": { date: { start: today } },
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
              "Last Referenced At": { date: { start: today } },
              "Confidence Score": { number: nextScore },
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
  async *listAllForBackfill(
    opts: {
      projectId?: string
    } = {}
  ): AsyncGenerator<Fact, void, void> {
    const filters: Array<Record<string, unknown>> = [
      { property: "Valid Until", date: { is_empty: true } },
    ]
    if (opts.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
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
        "Confidence Score": { number: score },
        "Last Referenced At": { date: { start: lastReferencedAt } },
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
        ? { property: "Predicate", select: { equals: strings[0] } }
        : {
            or: strings.map((p) => ({
              property: "Predicate",
              select: { equals: p },
            })),
          }

    const filter = {
      and: [{ property: "Valid Until", date: { is_empty: true } }, predicateClause],
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
    const rawPredicate = extractSelect(props["Predicate"], "related_to")
    if (HISTORICAL_TRACKING_PREDICATE_VALUES.has(rawPredicate)) {
      return null
    }
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
      predicate: rawPredicate as FactPredicate,
      object: extractRichText(props["Object"]),
      projectIds: extractRelationIds(props["Project"]),
      validFrom: extractDate(props["Valid From"]),
      validUntil: extractDate(props["Valid Until"]),
      reviewBy: extractDate(props["Review By"]),
      sourceMemoryId: sourceIds[0] ?? null,
      confidence: extractSelect(props["Confidence"], "certain") as FactConfidence,
      // DEFERRED-02 — system-managed numeric mirror of the categorical
      // `Confidence` select. `null` on pre-migration rows; populated by
      // `touchOnRead` / `decrementConfidence` / the build-fact-confidence-
      // scores migration. `extractNumber` returns `null` for missing
      // columns so legacy vaults that haven't run schema migration deserialize
      // cleanly.
      confidenceScore: extractNumber(props["Confidence Score"]),
      lastReferencedAt: extractDate(props["Last Referenced At"]),
      createdAt: page.created_time,
      subjectEntityId: subjectEntityIds[0] ?? null,
      objectEntityId: objectEntityIds[0] ?? null,
    }
  }
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
