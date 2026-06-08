import type { PageObjectResponse, QueryDataSourceParameters } from "@notionhq/client"
import type { LoreServices } from "../../../services.js"
import {
  extractRichText,
  extractTitle,
  isLiveFullPage,
} from "../../../notion/extractors.js"
import { projectOrUnscopedFilter } from "../../../notion/filters.js"
import { MEMORY_PROPS } from "../../../notion/schema.js"
import { printDiscoveryBreadcrumb } from "./shared.js"

interface LegacyAutosaveLearningRow {
  id: string
  title: string
  session: string | null
}

export interface BackfillAutosaveLearningSourceResult {
  scanned: number
  candidates: LegacyAutosaveLearningRow[]
  written: number
}

function legacyAutosaveLearningFilter(
  projectId?: string
): QueryDataSourceParameters["filter"] {
  const filters: Array<Record<string, unknown>> = [
    { property: MEMORY_PROPS.SOURCE, select: { equals: "conversation" } },
    { property: MEMORY_PROPS.KIND, select: { equals: "note" } },
    { property: MEMORY_PROPS.CONFIDENCE, select: { equals: "likely" } },
    { property: MEMORY_PROPS.SESSION, rich_text: { is_not_empty: true } },
  ]
  if (projectId) filters.unshift(projectOrUnscopedFilter(projectId))
  return { and: filters } as QueryDataSourceParameters["filter"]
}

async function hasLegacyConfidenceColumn(services: LoreServices): Promise<boolean> {
  const response = await services.client.dataSources.retrieve({
    data_source_id: services.vault.databases.memories.dataSourceId,
  })
  const properties =
    (response as { properties?: Record<string, unknown> }).properties ?? {}
  return Object.hasOwn(properties, MEMORY_PROPS.CONFIDENCE)
}

function rowFromPage(page: PageObjectResponse): LegacyAutosaveLearningRow {
  const session = extractRichText(page.properties[MEMORY_PROPS.SESSION]).trim()
  return {
    id: page.id,
    title: extractTitle(page.properties[MEMORY_PROPS.TITLE]) || page.id,
    session: session.length > 0 ? session : null,
  }
}

export async function runBackfillAutosaveLearningSource(
  services: LoreServices,
  options: {
    apply: boolean
    dryRun: boolean
    projectId?: string
  }
): Promise<BackfillAutosaveLearningSourceResult> {
  const apply = options.apply && !options.dryRun
  printDiscoveryBreadcrumb("legacy autosave learning memories")

  if (!(await hasLegacyConfidenceColumn(services))) {
    console.log(
      "\nNo legacy autosave learning candidates: Memories data source has no " +
        "legacy Confidence column."
    )
    return { scanned: 0, candidates: [], written: 0 }
  }

  let cursor: string | undefined
  let scanned = 0
  const candidates: LegacyAutosaveLearningRow[] = []
  do {
    const response = await services.client.dataSources.query({
      data_source_id: services.vault.databases.memories.dataSourceId,
      filter: legacyAutosaveLearningFilter(options.projectId),
      page_size: 100,
      start_cursor: cursor,
    })
    for (const page of response.results.filter(isLiveFullPage)) {
      scanned++
      candidates.push(rowFromPage(page))
    }
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
  } while (cursor)

  const verb = apply ? "Backfilled" : "Would backfill"
  console.log(
    `\n${verb} ${candidates.length} legacy autosave learning ` +
      `memor${candidates.length === 1 ? "y" : "ies"} (${scanned} scanned).`
  )

  for (const row of candidates.slice(0, 10)) {
    console.log(
      `  ${row.id} — ${row.title}${row.session ? ` (session ${row.session})` : ""}`
    )
  }
  if (candidates.length > 10) {
    console.log(`  … and ${candidates.length - 10} more.`)
  }

  let written = 0
  if (apply) {
    for (const row of candidates) {
      await services.client.pages.update({
        page_id: row.id,
        properties: {
          [MEMORY_PROPS.SOURCE]: { select: { name: "autosave_learning" } },
        },
      })
      written++
    }
    console.log(
      `\n[lore] backfill-autosave-learning-source: wrote ${written} row${written === 1 ? "" : "s"}.`
    )
  } else if (candidates.length > 0) {
    console.log("\n[lore] dry-run: no writes performed. Re-run with --yes to apply.")
  }

  return { scanned, candidates, written }
}
