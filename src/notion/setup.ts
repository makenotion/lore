/**
 * Create and verify the Notion database structure for a Lore vault.
 *
 * A vault is a Notion page containing four child databases:
 * Projects, Topics, Memories, Facts — linked by relations.
 */

import type { Client } from "@notionhq/client"
import type { BlockObjectResponse } from "@notionhq/client"
import type { Vault, VaultDatabases } from "../types.js"
import {
  PROJECTS_DB_TITLE,
  PROJECTS_DB_ICON,
  projectsProperties,
  TOPICS_DB_TITLE,
  TOPICS_DB_ICON,
  topicsProperties,
  MEMORIES_DB_TITLE,
  MEMORIES_DB_ICON,
  memoriesProperties,
  memoriesSelfRelationProperties,
  FACTS_DB_TITLE,
  FACTS_DB_ICON,
  factsProperties,
} from "./schema.js"

// The SDK expects InitialDataSourceRequest.properties typed as
// Record<string, PropertyConfigurationRequest>. Our schema definitions
// are structurally compatible but need a cast at the boundary.
type AnyProperties = Record<string, Record<string, unknown>>

function createDbArgs(
  pageId: string,
  title: string,
  icon: string,
  properties: AnyProperties
) {
  return {
    parent: { type: "page_id" as const, page_id: pageId },
    title: [{ text: { content: title } }],
    icon: { emoji: icon as "🗂️" },
    initial_data_source: {
      properties: properties as Parameters<
        Client["databases"]["create"]
      >[0]["initial_data_source"] extends { properties?: infer P }
        ? P
        : never,
    },
  }
}

/**
 * Create all four Lore databases inside a Notion page.
 */
export async function createVaultDatabases(
  client: Client,
  pageId: string
): Promise<Vault> {
  // Extract the data source ID from a database creation response.
  // Relations reference data sources, not database block IDs.
  const dsId = (db: Record<string, unknown>): string => {
    const ds = db["data_sources"] as Array<{ id: string }> | undefined
    return ds?.[0]?.id ?? (db["id"] as string)
  }

  // 1. Projects (no deps)
  const projectsDb = await client.databases.create(
    createDbArgs(pageId, PROJECTS_DB_TITLE, PROJECTS_DB_ICON, projectsProperties)
  )

  // 2. Topics (depends on Projects)
  const topicsDb = await client.databases.create(
    createDbArgs(pageId, TOPICS_DB_TITLE, TOPICS_DB_ICON, topicsProperties(dsId(projectsDb as unknown as Record<string, unknown>)))
  )

  // 3. Memories (depends on Projects + Topics)
  // Self-relations (Supersedes, Affects) are added after creation — Notion
  // cannot resolve `data_source_id = self` during `databases.create`.
  const memoriesDb = await client.databases.create(
    createDbArgs(
      pageId,
      MEMORIES_DB_TITLE,
      MEMORIES_DB_ICON,
      memoriesProperties(dsId(projectsDb as unknown as Record<string, unknown>), dsId(topicsDb as unknown as Record<string, unknown>))
    )
  )

  // 3b. Patch Memories DB with self-relation properties.
  const memoriesDsId = dsId(memoriesDb as unknown as Record<string, unknown>)
  await client.dataSources.update({
    data_source_id: memoriesDsId,
    properties: memoriesSelfRelationProperties(memoriesDsId) as Parameters<
      Client["dataSources"]["update"]
    >[0]["properties"],
  })

  // 4. Facts (depends on Projects + Memories)
  const factsDb = await client.databases.create(
    createDbArgs(
      pageId,
      FACTS_DB_TITLE,
      FACTS_DB_ICON,
      factsProperties(dsId(projectsDb as unknown as Record<string, unknown>), dsId(memoriesDb as unknown as Record<string, unknown>))
    )
  )

  // Resolve both IDs for each database:
  // - databaseId (block ID) for pages.create() parent
  // - dataSourceId for dataSources.query()
  const toRef = (db: Record<string, unknown>): { databaseId: string; dataSourceId: string } => {
    const id = db["id"] as string
    const ds = db["data_sources"] as Array<{ id: string }> | undefined
    return { databaseId: id, dataSourceId: ds?.[0]?.id ?? id }
  }

  return {
    pageId,
    databases: {
      projects: toRef(projectsDb as unknown as Record<string, unknown>),
      topics: toRef(topicsDb as unknown as Record<string, unknown>),
      memories: toRef(memoriesDb as unknown as Record<string, unknown>),
      facts: toRef(factsDb as unknown as Record<string, unknown>),
    },
  }
}

/**
 * Per-database summary of a migration run: which property names are missing
 * from the live data source, and which select/multi_select properties are
 * missing option values that the expected schema defines.
 */
export interface MigrationDiff {
  database: keyof VaultDatabases
  /** Property names present in the expected schema but absent from the live DB. */
  missing: string[]
  /** Per-property new select option names that need to be appended. */
  addedOptions: Array<{ property: string; options: string[] }>
}

/**
 * An option on a live select/multi_select property, carrying its internal
 * Notion-assigned ID so option updates can preserve it (rather than creating
 * duplicate options with the same name).
 */
interface LiveSelectOption {
  id?: string
  name: string
  color?: string
}

/**
 * Compute how a single expected select/multi_select property differs from
 * the live property. Returns `null` if the property isn't a select type, if
 * the types mismatch, or if there are no new options to add.
 *
 * When there ARE new options, returns the merged property config to send
 * via `dataSources.update` — live options keep their internal `id` (so Notion
 * preserves them), new options are sent without IDs (Notion assigns new ones).
 */
export function computeSelectOptionDiff(
  propertyName: string,
  liveProperty: unknown,
  expectedProperty: unknown
): {
  property: string
  newOptions: string[]
  mergedProperty: Record<string, unknown>
} | null {
  const selectType = detectSelectType(liveProperty)
  if (!selectType) return null
  if (detectSelectType(expectedProperty) !== selectType) return null

  const live = liveProperty as Record<string, Record<string, unknown>>
  const expected = expectedProperty as Record<string, Record<string, unknown>>

  const liveOptions = extractOptions(live[selectType])
  const expectedOptions = extractOptions(expected[selectType])

  const liveNames = new Set(liveOptions.map((o) => o.name))
  const newOptions = expectedOptions.filter((o) => !liveNames.has(o.name))
  if (newOptions.length === 0) return null

  // Preserve live IDs on existing options, append new options without IDs.
  const merged: LiveSelectOption[] = [
    ...liveOptions.map((o) => ({
      ...(o.id ? { id: o.id } : {}),
      name: o.name,
      ...(o.color ? { color: o.color } : {}),
    })),
    ...newOptions.map((o) => ({
      name: o.name,
      ...(o.color ? { color: o.color } : {}),
    })),
  ]

  return {
    property: propertyName,
    newOptions: newOptions.map((o) => o.name),
    mergedProperty: { [selectType]: { options: merged } },
  }
}

function detectSelectType(prop: unknown): "select" | "multi_select" | null {
  if (!prop || typeof prop !== "object") return null
  if ("select" in prop) return "select"
  if ("multi_select" in prop) return "multi_select"
  return null
}

function extractOptions(config: unknown): LiveSelectOption[] {
  if (!config || typeof config !== "object") return []
  const opts = (config as { options?: unknown }).options
  if (!Array.isArray(opts)) return []
  return opts.filter(
    (o): o is LiveSelectOption =>
      typeof o === "object" && o !== null && typeof (o as { name?: unknown }).name === "string"
  )
}

/**
 * Compare the expected property schema against each live data source and
 * add any properties or select options that are missing. Never renames or
 * removes anything — additions only, to keep vaults stable across Lore
 * versions.
 *
 * Idempotent: re-running against an up-to-date vault issues no writes.
 */
export async function migrateVaultSchema(
  client: Client,
  vault: Vault,
  options: { dryRun?: boolean } = {}
): Promise<MigrationDiff[]> {
  const db = vault.databases
  const expectedByDb: Record<keyof VaultDatabases, AnyProperties> = {
    projects: projectsProperties,
    topics: topicsProperties(db.projects.dataSourceId),
    memories: memoriesProperties(
      db.projects.dataSourceId,
      db.topics.dataSourceId,
      db.memories.dataSourceId
    ),
    facts: factsProperties(db.projects.dataSourceId, db.memories.dataSourceId),
  }

  const diffs: MigrationDiff[] = []

  for (const key of Object.keys(expectedByDb) as Array<keyof VaultDatabases>) {
    const expected = expectedByDb[key]
    const dsId = db[key].dataSourceId

    const live = await client.dataSources.retrieve({ data_source_id: dsId })
    const liveProps = (live as { properties: Record<string, unknown> }).properties

    // Phase 1: detect missing property names.
    const missing = Object.keys(expected).filter((name) => !(name in liveProps))

    // Phase 2: detect missing select options on properties that exist in both.
    const addedOptions: Array<{ property: string; options: string[] }> = []
    const optionUpdates: AnyProperties = {}
    for (const name of Object.keys(expected)) {
      if (!(name in liveProps)) continue
      const diff = computeSelectOptionDiff(name, liveProps[name], expected[name])
      if (!diff) continue
      addedOptions.push({ property: diff.property, options: diff.newOptions })
      optionUpdates[name] = diff.mergedProperty
    }

    diffs.push({ database: key, missing, addedOptions })

    if (missing.length === 0 && addedOptions.length === 0) continue
    if (options.dryRun) continue

    const updateProps: AnyProperties = { ...optionUpdates }
    for (const name of missing) updateProps[name] = expected[name]

    await client.dataSources.update({
      data_source_id: dsId,
      properties: updateProps as Parameters<
        Client["dataSources"]["update"]
      >[0]["properties"],
    })
  }

  return diffs
}

/**
 * Verify that a vault page has the expected databases.
 */
export async function verifyVaultDatabases(
  client: Client,
  pageId: string
): Promise<Vault> {
  const response = await client.blocks.children.list({
    block_id: pageId,
    page_size: 100,
  })

  const expectedTitles: Record<keyof VaultDatabases, string> = {
    projects: PROJECTS_DB_TITLE,
    topics: TOPICS_DB_TITLE,
    memories: MEMORIES_DB_TITLE,
    facts: FACTS_DB_TITLE,
  }

  const dbBlockIds: Partial<Record<keyof VaultDatabases, string>> = {}

  for (const block of response.results) {
    if (!("type" in block)) continue
    const fullBlock = block as BlockObjectResponse
    if (fullBlock.type !== "child_database") continue

    const title = fullBlock.child_database.title
    for (const [key, expectedTitle] of Object.entries(expectedTitles)) {
      if (title === expectedTitle) {
        dbBlockIds[key as keyof VaultDatabases] = fullBlock.id
      }
    }
  }

  const missing = Object.entries(expectedTitles)
    .filter(([key]) => !dbBlockIds[key as keyof VaultDatabases])
    .map(([, title]) => title)

  if (missing.length > 0) {
    throw new Error(
      `Vault at ${pageId} is missing databases: ${missing.join(", ")}. ` +
        `Run 'lore init' to create them.`
    )
  }

  // Resolve both IDs from each database block:
  // - databaseId (block ID) for pages.create() parent
  // - dataSourceId for dataSources.query()
  const resolved: Partial<VaultDatabases> = {}
  for (const [key, dbId] of Object.entries(dbBlockIds)) {
    const db = await client.databases.retrieve({ database_id: dbId! })
    const dataSources = (db as Record<string, unknown>)["data_sources"] as
      | Array<{ id: string }>
      | undefined
    resolved[key as keyof VaultDatabases] = {
      databaseId: dbId!,
      dataSourceId: dataSources?.[0]?.id ?? dbId!,
    }
  }

  return {
    pageId,
    databases: resolved as VaultDatabases,
  }
}
