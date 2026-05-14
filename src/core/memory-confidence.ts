import type {
  Client,
  CreatePageParameters,
  PageObjectResponse,
  QueryDataSourceParameters,
} from "@notionhq/client"
import type { DatabaseRef, Memory } from "../types.js"
import { CONFIDENCE_DISPLAY_THRESHOLD } from "../types.js"
import { MEMORY_PROPS, encodeCompareNotesRichText } from "../notion/schema.js"
import { projectOrUnscopedFilter } from "../notion/filters.js"
import { isLiveFullPage } from "../notion/extractors.js"
import {
  bumpConfidenceScore,
  decayConfidenceScore,
  decrementConfidenceScore,
  seedConfidenceScore,
} from "./decay.js"
import { todayUtc } from "./task.js"
import { withCleanupOrphanExclusion } from "./memory-filters.js"

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
