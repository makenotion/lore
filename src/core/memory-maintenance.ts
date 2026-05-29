/**
 * Memory maintenance I/O behind the `MemoryService` facade.
 */

import type {
  Client,
  CreatePageParameters,
  PageObjectResponse,
  QueryDataSourceParameters,
} from "@notionhq/client"
import type { DatabaseRef, Memory } from "../types.js"
import { MEMORY_PROPS, encodeCompareNotesRichText } from "../notion/schema.js"
import { projectOrUnscopedFilter } from "../notion/filters.js"
import { isLiveFullPage } from "../notion/extractors.js"
import { todayUtc } from "./task.js"
import { withCleanupOrphanExclusion } from "./memory-filters.js"

type PageToMemory = (page: PageObjectResponse, content: string) => Promise<Memory>

export class MemoryMaintenance {
  constructor(
    private readonly client: Client,
    private readonly db: DatabaseRef,
    private readonly pageToMemory: PageToMemory
  ) {}

  async touchOnRead(
    memories: ReadonlyArray<Pick<Memory, "id" | "lastReferencedAt">>,
    opts?: {
      today?: string
      onError?: (memoryId: string, error: unknown) => void
    }
  ): Promise<void> {
    const today = opts?.today ?? todayUtc()
    await Promise.all(
      memories.map(async (memory) => {
        if (memory.lastReferencedAt === today) return
        try {
          await this.client.pages.update({
            page_id: memory.id,
            properties: {
              [MEMORY_PROPS.LAST_REFERENCED_AT]: { date: { start: today } },
            },
          })
          memory.lastReferencedAt = today
        } catch (error) {
          opts?.onError?.(memory.id, error)
        }
      })
    )
  }

  async appendCompareNotes(memoryId: string, compareNotes: string): Promise<void> {
    const properties: CreatePageParameters["properties"] = {
      [MEMORY_PROPS.COMPARE_NOTES]: {
        rich_text: encodeCompareNotesRichText(compareNotes),
      },
    }
    await this.client.pages.update({ page_id: memoryId, properties })
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
}
