import type { Client, PageObjectResponse } from "@notionhq/client"
import pLimit from "p-limit"
import { extractTitle, isLiveFullPage } from "../notion/extractors.js"
import { requireQueryResults } from "../notion/query-response.js"
import { MEMORY_PROPS } from "../notion/schema.js"
import type { DatabaseRef } from "../types.js"

const AGENT_DIARY_WRITE_CONCURRENCY = 4

export interface AgentDiaryMigrationRow {
  id: string
  title: string
  kind: string | null
  status: string | null
}

export interface AgentDiaryMigrationFailure extends AgentDiaryMigrationRow {
  action: "reject-null-kind" | "resource-note"
  message: string
}

export interface AgentDiaryMigrationResult {
  mode: "dry-run" | "apply"
  total: number
  rejectNullKind: AgentDiaryMigrationRow[]
  alreadyRejectedNullKind: AgentDiaryMigrationRow[]
  resourceNotes: AgentDiaryMigrationRow[]
  manualReview: AgentDiaryMigrationRow[]
  samples: {
    rejectNullKind: AgentDiaryMigrationRow[]
    alreadyRejectedNullKind: AgentDiaryMigrationRow[]
    resourceNotes: AgentDiaryMigrationRow[]
    manualReview: AgentDiaryMigrationRow[]
  }
  applied: {
    rejected: number
    resourced: number
    failures: AgentDiaryMigrationFailure[]
  }
}

export async function migrateAgentDiaryMemories(input: {
  client: Client
  memories: DatabaseRef
  apply?: boolean
  sampleLimit?: number
}): Promise<AgentDiaryMigrationResult> {
  const sampleLimit = input.sampleLimit ?? 5
  const pages = await listAgentDiaryPages(input.client, input.memories)
  const rejectNullKind: AgentDiaryMigrationRow[] = []
  const alreadyRejectedNullKind: AgentDiaryMigrationRow[] = []
  const resourceNotes: AgentDiaryMigrationRow[] = []
  const manualReview: AgentDiaryMigrationRow[] = []

  for (const page of pages) {
    const row = rowFromPage(page)
    if (row.kind === null) {
      if (row.status === "rejected") {
        alreadyRejectedNullKind.push(row)
      } else {
        rejectNullKind.push(row)
      }
      continue
    }
    if (row.kind === "note") {
      resourceNotes.push(row)
      continue
    }
    manualReview.push(row)
  }

  const applied = input.apply
    ? await applyAgentDiaryMigration(input.client, { rejectNullKind, resourceNotes })
    : { rejected: 0, resourced: 0, failures: [] }

  return {
    mode: input.apply ? "apply" : "dry-run",
    total: pages.length,
    rejectNullKind,
    alreadyRejectedNullKind,
    resourceNotes,
    manualReview,
    samples: {
      rejectNullKind: sampleRows(rejectNullKind, sampleLimit),
      alreadyRejectedNullKind: sampleRows(alreadyRejectedNullKind, sampleLimit),
      resourceNotes: sampleRows(resourceNotes, sampleLimit),
      manualReview: sampleRows(manualReview, sampleLimit),
    },
    applied,
  }
}

async function listAgentDiaryPages(
  client: Client,
  memories: DatabaseRef
): Promise<PageObjectResponse[]> {
  const pages: PageObjectResponse[] = []
  let cursor: string | undefined
  do {
    const response = await client.dataSources.query({
      data_source_id: memories.dataSourceId,
      filter: {
        property: MEMORY_PROPS.SOURCE,
        select: { equals: "agent_diary" },
      },
      sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
      page_size: 100,
      start_cursor: cursor,
    })
    pages.push(
      ...requireQueryResults(response, "migrateAgentDiaryMemories").filter(isLiveFullPage)
    )
    cursor = response.has_more && response.next_cursor ? response.next_cursor : undefined
  } while (cursor)

  return pages
}

async function applyAgentDiaryMigration(
  client: Client,
  rows: {
    rejectNullKind: AgentDiaryMigrationRow[]
    resourceNotes: AgentDiaryMigrationRow[]
  }
): Promise<AgentDiaryMigrationResult["applied"]> {
  const limit = pLimit(AGENT_DIARY_WRITE_CONCURRENCY)
  let rejected = 0
  let resourced = 0
  const failures: AgentDiaryMigrationFailure[] = []

  await Promise.all([
    ...rows.rejectNullKind.map((row) =>
      limit(async () => {
        try {
          await client.pages.update({
            page_id: row.id,
            properties: {
              [MEMORY_PROPS.STATUS]: { select: { name: "rejected" } },
            },
          })
          rejected++
        } catch (err) {
          failures.push({
            ...row,
            action: "reject-null-kind",
            message: errorMessage(err),
          })
        }
      })
    ),
    ...rows.resourceNotes.map((row) =>
      limit(async () => {
        try {
          await client.pages.update({
            page_id: row.id,
            properties: {
              [MEMORY_PROPS.SOURCE]: { select: { name: "conversation" } },
            },
          })
          resourced++
        } catch (err) {
          failures.push({
            ...row,
            action: "resource-note",
            message: errorMessage(err),
          })
        }
      })
    ),
  ])

  return { rejected, resourced, failures }
}

function rowFromPage(page: PageObjectResponse): AgentDiaryMigrationRow {
  return {
    id: page.id,
    title: extractTitle(page.properties[MEMORY_PROPS.TITLE]) || "(untitled)",
    kind: selectName(page.properties[MEMORY_PROPS.KIND]),
    status: selectName(page.properties[MEMORY_PROPS.STATUS]),
  }
}

function selectName(prop: unknown): string | null {
  // Migration classification needs to distinguish an empty select from a fallback value.
  if (
    typeof prop === "object" &&
    prop !== null &&
    (prop as { type?: unknown }).type === "select"
  ) {
    const select = (prop as { select?: { name?: unknown } | null }).select
    return typeof select?.name === "string" ? select.name : null
  }
  return null
}

function sampleRows(
  rows: AgentDiaryMigrationRow[],
  sampleLimit: number
): AgentDiaryMigrationRow[] {
  return rows.slice(0, Math.max(0, sampleLimit))
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === "string" ? err : String(err)
}
