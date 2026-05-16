// ABOUTME: Owns FactService maintenance for touch-on-read, source repair, expiration, and backfills.
// ABOUTME: Edit when fact confidence, scoped status, or review-extension maintenance changes.

import type {
  Client,
  PageObjectResponse,
  QueryDataSourceParameters,
  UpdatePageParameters,
} from "@notionhq/client"
import type { DatabaseRef, Fact, MemoryScopeContext } from "../types.js"
import { EXPIRING_SOON_DAYS, MS_PER_DAY } from "../types.js"
import { FACT_PROPS } from "../notion/schema.js"
import { projectOrUnscopedFilter } from "../notion/filters.js"
import { isFullPage } from "../notion/extractors.js"
import {
  bumpConfidenceScore,
  decayConfidenceScore,
  seedConfidenceScore,
} from "./decay.js"
import { todayUtc } from "./task.js"

export type FactPageToFact = (page: PageObjectResponse) => Promise<Fact | null>

/**
 * Read `Fact.createdAt` with an explicit invariant check.
 *
 * `Fact.createdAt` is typed as optional on the public boundary so
 * adding the field doesn't break external consumers building
 * `Fact`-shaped object literals. At runtime, every `Fact` produced by
 * `pageToFact` carries `createdAt` because the field comes from Notion's
 * built-in `created_time` page property. Internal maintenance helpers can
 * rely on that runtime guarantee.
 */
export function readFactCreatedAt(
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

export class FactMaintenance {
  constructor(
    private client: Client,
    private db: DatabaseRef,
    private readonly pageToFact: FactPageToFact,
    private readonly getScopeContext: () => MemoryScopeContext
  ) {}

  async extendReview(id: string, reviewBy: string | null): Promise<void> {
    await this.client.pages.update({
      page_id: id,
      properties: {
        [FACT_PROPS.REVIEW_BY]:
          reviewBy === null ? { date: null } : { date: { start: reviewBy } },
      },
    })
  }

  async setSource(id: string, sourceMemoryId: string): Promise<void> {
    await this.client.pages.update({
      page_id: id,
      properties: {
        [FACT_PROPS.SOURCE]: { relation: [{ id: sourceMemoryId }] },
      },
    })
  }

  /**
   * Advisory read-side confidence touch. Writes `Last Referenced At`
   * and the lazily decayed/bumped score, then mirrors the updated fields
   * onto the caller's fact objects so cached wake-up payloads do not
   * re-fire the same once-per-day touch.
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
          fact.lastReferencedAt = today
          fact.confidenceScore = nextScore
        } catch (error) {
          opts?.onError?.(fact.id, error)
        }
      })
    )
  }

  async expiringScopedStats(opts: { projectId?: string } = {}): Promise<{
    expired: number
    expiringSoon: number
    narrowScopeOutOfContext: number
  }> {
    const today = todayUtc()
    const horizonMs = Date.parse(today) + EXPIRING_SOON_DAYS * MS_PER_DAY
    const horizon = new Date(horizonMs).toISOString().slice(0, 10)
    let expired = 0
    let expiringSoon = 0
    let narrowScopeOutOfContext = 0
    const ctx = this.getScopeContext()
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
      /**
       * When true, drop the default `Valid Until is_empty` filter so
       * invalidated rows surface alongside live ones. Used by the
       * `--backfill-fact-observed-at` migration so the walker sees
       * historical invalidations.
       */
      includeInvalidated?: boolean
    } = {}
  ): AsyncGenerator<Fact, void, void> {
    const filters: Array<Record<string, unknown>> = []
    if (!opts.includeInvalidated) {
      filters.push({ property: FACT_PROPS.VALID_UNTIL, date: { is_empty: true } })
    }
    if (opts.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId, FACT_PROPS.PROJECT))
    }
    const filter =
      filters.length > 1
        ? { and: filters }
        : filters.length === 1
          ? filters[0]
          : undefined
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

  async applyObservedAtBackfill(
    factId: string,
    values: { observedAt: string | null; invalidatedAt: string | null }
  ): Promise<void> {
    const properties: Record<string, unknown> = {}
    if (values.observedAt !== null) {
      properties[FACT_PROPS.OBSERVED_AT] = { date: { start: values.observedAt } }
    }
    if (values.invalidatedAt !== null) {
      properties[FACT_PROPS.INVALIDATED_AT] = {
        date: { start: values.invalidatedAt },
      }
    }
    if (Object.keys(properties).length === 0) return
    await this.client.pages.update({
      page_id: factId,
      properties: properties as UpdatePageParameters["properties"],
    })
  }
}
