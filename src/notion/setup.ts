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
  // 1. Projects (no deps)
  const projectsDb = await client.databases.create(
    createDbArgs(pageId, PROJECTS_DB_TITLE, PROJECTS_DB_ICON, projectsProperties)
  )

  // 2. Topics (depends on Projects)
  const topicsDb = await client.databases.create(
    createDbArgs(pageId, TOPICS_DB_TITLE, TOPICS_DB_ICON, topicsProperties(projectsDb.id))
  )

  // 3. Memories (depends on Projects + Topics)
  const memoriesDb = await client.databases.create(
    createDbArgs(
      pageId,
      MEMORIES_DB_TITLE,
      MEMORIES_DB_ICON,
      memoriesProperties(projectsDb.id, topicsDb.id)
    )
  )

  // 4. Facts (depends on Projects + Memories)
  const factsDb = await client.databases.create(
    createDbArgs(
      pageId,
      FACTS_DB_TITLE,
      FACTS_DB_ICON,
      factsProperties(projectsDb.id, memoriesDb.id)
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
