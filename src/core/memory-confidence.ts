/**
 * Confidence dynamics I/O behind the `MemoryService` facade.
 *
 * `MemoryConfidence` owns the Notion writes around dynamic confidence, the
 * stale-confidence triage query, and the paginated backfill/statistics walkers.
 * The imported algebra helpers own pure score math and range clamping; this
 * module owns how those helpers are applied to memory rows and how
 * stale-confidence triage behaves.
 *
 * ## Confidence dynamics
 *
 * `Confidence Score` is a system-managed numeric column. Read paths bump it,
 * contradiction paths decrement it, and neglect decays it. It is distinct from
 * the agent-curated categorical `Confidence` select: the categorical value
 * seeds the numeric score on first touch, while the numeric score carries the
 * dynamic reliability signal afterward. Agents must not write `Confidence
 * Score` directly through memory save or update tools; the schema marks it as
 * system-managed and the algebra layer clamps every write-boundary value.
 *
 * ## I/O wrappers (`MemoryService.touchOnRead` / `decrementConfidence`)
 *
 * Both wrappers seed, decay, then mutate when `confidenceScore === null`. That
 * keeps pre-migration reads convergent with the bulk confidence-score
 * migration: a never-scored 200-day-old row read before migration should not
 * seed fresh at 0.9 and permanently lose the accrued decay just because the
 * later migration skips already-scored rows.
 *
 * `touchOnRead` short-circuits each row when `lastReferencedAt === today` and
 * `confidenceScore !== null`, intentionally limiting read bumps to once per
 * day. Failures route through `onError` and degrade to a no-op for that row;
 * the caller's read result is preserved and the touch is advisory. Successful
 * writes mirror the updated `Last Referenced At` and `Confidence Score` onto
 * the caller's memory objects so cached wake-up payloads do not re-fire the
 * same once-per-day touch.
 *
 * `decrementConfidence` writes `Last Referenced At = today` alongside the
 * score decrement. A contradiction is a negative citation: it should reset the
 * decay clock, while the explicit decrement carries the negative signal so the
 * row does not double-count the same event as both contradiction and neglect.
 *
 * Both wrappers issue exactly one `pages.update` per affected memory. Notion
 * has no batch-update primitive; per-call concurrency is bounded by the shared
 * Notion rate-limit middleware.
 *
 * ## Stale Confidence wake-up subsection
 *
 * `MemoryService.queryStaleConfidence` backs the `### Stale Confidence`
 * subsection on `lore-context action='wake-up'`. It is a triage view for
 * memories that need attention, surfaced through either of two OR branches:
 * `Confidence Score < CONFIDENCE_DISPLAY_THRESHOLD` or `Last Referenced At`
 * older than `STALE_CONFIDENCE_DAYS`.
 *
 * The neglect branch is load-bearing under write-realized lazy decay. A memory
 * cited six months ago at score 0.9 keeps stored score 0.9 and can still rank
 * highly until a touch, decrement, or migration realizes the accrued decay; the
 * neglect branch is what surfaces that row for triage. Reading the row through
 * `lore-memory action='expand'` realizes the accrued decay through the
 * touch-on-read path.
 *
 * Pre-migration vaults render this section empty. The query requires
 * `Confidence Score is_not_empty`, so null-score rows satisfy neither the low
 * score branch nor the neglect branch. The section populates after the
 * confidence-score migration seeds existing rows or after read paths
 * organically touch them. "No scores yet" is an absence of system decision, not
 * a decision that every row is stale.
 *
 * Rows in the Stale Confidence subsection are not touched during wake-up.
 * They surface because they need triage; bumping the score or resetting `Last
 * Referenced At` merely by listing them would mask the signal that made them
 * visible. The agent acts on a row by expanding it, at which point
 * `touchOnRead` fires through the normal read wrapper.
 */

import type {
  Client,
  CreatePageParameters,
  PageObjectResponse,
  QueryDataSourceParameters,
} from "@notionhq/client"
import type { DatabaseRef, Memory } from "../types.js"
import {
  CONFIDENCE_DISPLAY_THRESHOLD,
  MS_PER_DAY,
  STALE_CONFIDENCE_DAYS,
} from "../types.js"
import { MEMORY_PROPS, encodeCompareNotesRichText } from "../notion/schema.js"
import { projectOrUnscopedFilter } from "../notion/filters.js"
import { isMissingPropertyError } from "../notion/errors.js"
import { isLiveFullPage } from "../notion/extractors.js"
import { collectLivePages, warnLivePageCapFired } from "../notion/live-pages.js"
import {
  bumpConfidenceScore,
  decayConfidenceScore,
  decrementConfidenceScore,
  seedConfidenceScore,
} from "./decay.js"
import { todayUtc } from "./task.js"
import {
  cleanupOrphanExclusionFilter,
  withCleanupOrphanExclusion,
} from "./memory-filters.js"
import { reviewTerminalStatusExclusionFilters } from "./memory-review-state.js"

type PageToMemory = (page: PageObjectResponse, content: string) => Promise<Memory>

export interface MemoryConfidenceStats {
  totalMemories: number
  scoredMemories: number
  averageScore: number
  belowThreshold: number
}

export class MemoryConfidence {
  constructor(
    private client: Client,
    private db: DatabaseRef,
    private readonly pageToMemory: PageToMemory
  ) {}

  /**
   * Advisory read-side confidence touch. Writes `Last Referenced At`
   * and the lazily decayed/bumped score, then mirrors the updated fields
   * onto the caller's memory objects so cached wake-up payloads do not
   * re-fire the same once-per-day touch.
   */
  async touchOnRead(
    memories: ReadonlyArray<
      Pick<
        Memory,
        "id" | "confidence" | "confidenceScore" | "lastReferencedAt" | "createdAt"
      >
    >,
    opts?: {
      today?: string
      onError?: (memoryId: string, error: unknown) => void
    }
  ): Promise<void> {
    const today = opts?.today ?? todayUtc()
    await Promise.all(
      memories.map(async (memory) => {
        if (memory.lastReferencedAt === today && memory.confidenceScore !== null) {
          return
        }
        try {
          let nextScore: number
          if (memory.confidenceScore === null) {
            const seeded = seedConfidenceScore(memory.confidence)
            const decayed = decayConfidenceScore(
              seeded,
              memory.createdAt.slice(0, 10),
              today
            )
            nextScore = bumpConfidenceScore(decayed)
          } else {
            const decayed = decayConfidenceScore(
              memory.confidenceScore,
              memory.lastReferencedAt,
              today
            )
            nextScore = bumpConfidenceScore(decayed)
          }
          await this.client.pages.update({
            page_id: memory.id,
            properties: {
              [MEMORY_PROPS.LAST_REFERENCED_AT]: { date: { start: today } },
              [MEMORY_PROPS.CONFIDENCE_SCORE]: { number: nextScore },
            },
          })
          memory.lastReferencedAt = today
          memory.confidenceScore = nextScore
        } catch (error) {
          opts?.onError?.(memory.id, error)
        }
      })
    )
  }

  /**
   * Apply a contradiction decrement after realizing any accrued lazy
   * decay. Contradictions reset `Last Referenced At` because they are
   * negative citations; the explicit decrement carries the negative
   * signal.
   */
  async decrementConfidence(
    memory: Pick<
      Memory,
      "id" | "confidence" | "confidenceScore" | "lastReferencedAt" | "createdAt"
    >,
    opts?: { today?: string; compareNotes?: string }
  ): Promise<number> {
    const today = opts?.today ?? todayUtc()
    let current: number
    if (memory.confidenceScore === null) {
      const seeded = seedConfidenceScore(memory.confidence)
      current = decayConfidenceScore(seeded, memory.createdAt.slice(0, 10), today)
    } else {
      current = decayConfidenceScore(
        memory.confidenceScore,
        memory.lastReferencedAt,
        today
      )
    }
    const next = decrementConfidenceScore(current)
    const properties: CreatePageParameters["properties"] = {
      [MEMORY_PROPS.CONFIDENCE_SCORE]: { number: next },
      [MEMORY_PROPS.LAST_REFERENCED_AT]: { date: { start: today } },
    }
    if (opts?.compareNotes !== undefined) {
      properties[MEMORY_PROPS.COMPARE_NOTES] = {
        rich_text: encodeCompareNotesRichText(opts.compareNotes),
      }
    }
    await this.client.pages.update({
      page_id: memory.id,
      properties,
    })
    return next
  }

  /**
   * Memories that need triage: either scored low, OR long-neglected
   * regardless of stored score. Backs the Stale Confidence wake-up
   * subsection.
   *
   * Server-side filter (when `opts.projectId` is supplied):
   *
   * (Project contains projectId OR Project is_empty)
   * AND Confidence Score is_not_empty
   * AND (
   * Confidence Score < CONFIDENCE_DISPLAY_THRESHOLD
   * OR Last Referenced At on_or_before today - STALE_CONFIDENCE_DAYS
   * )
   *
   * Server-side filter (vault-wide, when `opts.projectId` is omitted):
   * the project clause is dropped entirely so the query covers every
   * memory regardless of project scoping. Same posture as
   * `MemoryService.list`.
   *
   * The neglect-OR clause is load-bearing under the
   * **write-realized lazy decay** model. RRF reads stored
   * Confidence Score verbatim — no decay applied at read. So a memory
   * touched once 6 months ago at score 0.9 keeps a stored 0.9 (and
   * ranks high in retrieval) until something disturbs it. The
   * neglect-OR clause is what surfaces it for triage. When the agent
   * reads it, `touchOnRead` realizes the accrued decay (decay-then-bump),
   * the stored score drops, and the row either continues surfacing
   * (if now actually low-score) or rotates out.
   *
   * The `is_not_empty` guard excludes never-scored rows — those have
   * not yet been touched by any read path; flagging them as stale
   * would conflate "never scored" with "needs triage." Operators
   * backfill them via `lore migrate --build-confidence-scores`.
   *
   * `projectOrUnscopedFilter` matches `MemoryService.list` etc. —
   * repo-wide memories surface in the Stale Confidence section the
   * same way they surface in Recent Memories.
   *
   * Sorted by score ascending so most-decayed rows surface first;
   * neglected-but-fresh-score rows fall to the end of the list. Notion
   * page size = 100 so archive-heavy windows can refill efficiently;
   * archived rows are filtered client-side (matches the established Memories
   * DS pattern). No body fetch — the wake-up subsection renders title +
   * synopsis + trust label + meta only, never bodies.
   */
  async queryStaleConfidence(opts: {
    /** Omit for vault-wide wake-up; matches `MemoryService.list` shape. */
    projectId?: string
    limit: number
    /** YYYY-MM-DD anchor; same shape as `taskDaysOverdue` etc. */
    today: string
    /**
     * When `true`, do NOT exclude `Status = proposed` rows. Defaults
     * to `false` so the wake-up Stale Confidence subsection mirrors
     * the rest of the default-recall posture:
     * proposed memories belong in the inbox surface, not in normal
     * triage lists. The inbox-review flow opts in.
     */
    includeProposed?: boolean
  }): Promise<Memory[]> {
    const neglectCutoff = new Date(
      new Date(opts.today).getTime() - STALE_CONFIDENCE_DAYS * MS_PER_DAY
    )
      .toISOString()
      .slice(0, 10)

    const filters: Array<Record<string, unknown>> = []
    if (opts.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }
    if (opts.includeProposed !== true) {
      // Same default-exclude posture as `MemoryService.list` and
      // `MemoryService.search`: hide both `proposed` (inbox-pending)
      // and `rejected` (terminal-off-recall) rows from triage so
      // review-state never leaks into the Stale Confidence subsection.
      filters.push(...reviewTerminalStatusExclusionFilters())
    }
    filters.push({
      property: MEMORY_PROPS.CONFIDENCE_SCORE,
      number: { is_not_empty: true },
    })
    filters.push({
      or: [
        {
          property: MEMORY_PROPS.CONFIDENCE_SCORE,
          number: { less_than: CONFIDENCE_DISPLAY_THRESHOLD },
        },
        {
          property: MEMORY_PROPS.LAST_REFERENCED_AT,
          date: { on_or_before: neglectCutoff },
        },
      ],
    })
    // Resurfaced cleanup-orphan exclusion. A restored-
    // from-trash orphan that was scored by `--build-confidence-scores`
    // before this filter shipped would otherwise show up in the
    // wake-up Stale Confidence triage view as an empty-body shell —
    // confusing for the operator and noise in the section meant to
    // surface real low-confidence memories.
    filters.push(cleanupOrphanExclusionFilter())

    const filter = { and: filters } as QueryDataSourceParameters["filter"]

    // Pre-migration vaults that haven't yet run `lore migrate` against
    // the 0.8.0 schema lack the `Confidence Score` and
    // `Last Referenced At` columns entirely. Notion responds with a
    // `validation_error` ("Could not find sort property with name or
    // id: Confidence Score") rather than an empty result, which would
    // otherwise propagate up through `loadWakeUpData`'s `Promise.all`
    // and fail the entire wake-up. Degrade to an empty section
    // instead — same posture as `FactService.queryByEntityTextOnUnmigrated`
    // and `TaskService.countClosedSince`, both of which silently
    // suppress their feature on vaults that pre-date the column they
    // depend on. The schema-drift detector
    // (`migrateVaultSchema` / `lore migrate --dry-run`) is the
    // canonical operator-facing surface for "you need to migrate";
    // wake-up itself stays decorative. Transient 5xx / rate-limit /
    // network errors do NOT match `isMissingPropertyError` and still
    // propagate so a real outage isn't masked.
    const limit = opts.limit
    if (limit <= 0) return []

    let result: Awaited<ReturnType<typeof collectLivePages>>
    try {
      result = await collectLivePages({
        limit,
        source: "MemoryService.queryStaleConfidence",
        query: ({ page_size, start_cursor }) =>
          this.client.dataSources.query({
            data_source_id: this.db.dataSourceId,
            filter,
            sorts: [{ property: MEMORY_PROPS.CONFIDENCE_SCORE, direction: "ascending" }],
            page_size,
            start_cursor,
          }),
      })
    } catch (err) {
      if (isMissingPropertyError(err)) return []
      throw err
    }
    if (result.capped) {
      warnLivePageCapFired({
        source: "MemoryService.queryStaleConfidence",
        pages: result.pageCount,
        accumulated: result.pages.length,
        limit,
      })
    }

    return Promise.all(result.pages.map((page) => this.pageToMemory(page, "")))
  }

  async *listAllForBackfill(
    opts: {
      projectId?: string
    } = {}
  ): AsyncGenerator<Memory, void, void> {
    let cursor: string | undefined
    do {
      const baseFilter = opts.projectId
        ? projectOrUnscopedFilter(opts.projectId)
        : undefined
      const filter = withCleanupOrphanExclusion(baseFilter)
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: [{ timestamp: "created_time", direction: "ascending" }],
        page_size: 100,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isLiveFullPage)) {
        yield await this.pageToMemory(page, "")
      }
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)
  }

  async applyBackfillScore(
    memoryId: string,
    score: number,
    lastReferencedAt: string
  ): Promise<void> {
    await this.client.pages.update({
      page_id: memoryId,
      properties: {
        [MEMORY_PROPS.CONFIDENCE_SCORE]: { number: score },
        [MEMORY_PROPS.LAST_REFERENCED_AT]: { date: { start: lastReferencedAt } },
      },
    })
  }

  async confidenceStats(
    opts: { projectId?: string } = {}
  ): Promise<MemoryConfidenceStats> {
    let totalMemories = 0
    let scoredMemories = 0
    let scoreSum = 0
    let belowThreshold = 0
    for await (const memory of this.listAllForBackfill(opts)) {
      totalMemories += 1
      if (memory.confidenceScore !== null) {
        scoredMemories += 1
        scoreSum += memory.confidenceScore
        if (memory.confidenceScore < CONFIDENCE_DISPLAY_THRESHOLD) {
          belowThreshold += 1
        }
      }
    }
    const averageScore = scoredMemories > 0 ? scoreSum / scoredMemories : 0
    return { totalMemories, scoredMemories, averageScore, belowThreshold }
  }
}
