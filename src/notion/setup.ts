/**
 * Create and verify the Notion database structure for a Lore vault.
 *
 * A vault is a Notion page containing four child databases:
 * Projects, Topics, Memories, Facts — linked by relations.
 */

import type { Client } from "@notionhq/client"
import type { BlockObjectResponse } from "@notionhq/client"
import type { DatabaseRef, Vault, VaultDatabases } from "../types.js"
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
  ENTITIES_DB_TITLE,
  ENTITIES_DB_ICON,
  entitiesProperties,
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

  // 4. Entities (depends on Projects + Memories) — PF3-01
  const entitiesDb = await client.databases.create(
    createDbArgs(
      pageId,
      ENTITIES_DB_TITLE,
      ENTITIES_DB_ICON,
      entitiesProperties(
        dsId(projectsDb as unknown as Record<string, unknown>),
        dsId(memoriesDb as unknown as Record<string, unknown>)
      )
    )
  )

  // 5. Facts (depends on Projects + Memories + Entities). The Facts DB
  // gains `SubjectEntity` / `ObjectEntity` relation columns post-PF3-01;
  // wiring them up at creation time means new vaults skip the
  // `lore migrate --build-entities` schema-drift detour entirely.
  const factsDb = await client.databases.create(
    createDbArgs(
      pageId,
      FACTS_DB_TITLE,
      FACTS_DB_ICON,
      factsProperties(
        dsId(projectsDb as unknown as Record<string, unknown>),
        dsId(memoriesDb as unknown as Record<string, unknown>),
        dsId(entitiesDb as unknown as Record<string, unknown>)
      )
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
      entities: toRef(entitiesDb as unknown as Record<string, unknown>),
      facts: toRef(factsDb as unknown as Record<string, unknown>),
    },
  }
}

/**
 * Create the Entities database (PF3-01) on an existing vault page that
 * was set up before the database existed. Idempotent: returns the
 * existing database when one is already present, only writing on a
 * true cold start.
 *
 * Used by `lore migrate --build-entities` to upgrade legacy vaults in
 * place. New vaults skip this entirely because `createVaultDatabases`
 * already creates Entities as part of the standard init flow.
 *
 * Returns the `DatabaseRef` so the caller can stitch the new database
 * into a refreshed `Vault` snapshot before invoking the rest of the
 * migration.
 */
export async function ensureEntitiesDatabase(
  client: Client,
  vault: Vault
): Promise<{ ref: DatabaseRef; created: boolean }> {
  if (vault.databases.entities) {
    return { ref: vault.databases.entities, created: false }
  }

  const dsId = (db: Record<string, unknown>): string => {
    const ds = db["data_sources"] as Array<{ id: string }> | undefined
    return ds?.[0]?.id ?? (db["id"] as string)
  }

  const entitiesDb = await client.databases.create({
    parent: { type: "page_id" as const, page_id: vault.pageId },
    title: [{ text: { content: ENTITIES_DB_TITLE } }],
    icon: { emoji: ENTITIES_DB_ICON as "🪪" },
    initial_data_source: {
      properties: entitiesProperties(
        vault.databases.projects.dataSourceId,
        vault.databases.memories.dataSourceId
      ) as Parameters<
        Client["databases"]["create"]
      >[0]["initial_data_source"] extends { properties?: infer P }
        ? P
        : never,
    },
  })

  const dbRecord = entitiesDb as unknown as Record<string, unknown>
  const id = dbRecord["id"] as string
  return {
    ref: {
      databaseId: id,
      dataSourceId: dsId(dbRecord),
    },
    created: true,
  }
}

/**
 * Per-database summary of a migration run: property names missing from the
 * live data source, select/multi_select properties with new option values,
 * and relation properties whose live config needs upgrading to match the
 * expected schema (e.g. `single_property` → `dual_property`).
 */
export interface MigrationDiff {
  database: keyof VaultDatabases
  /** Property names present in the expected schema but absent from the live DB. */
  missing: string[]
  /** Per-property new select option names that need to be appended. */
  addedOptions: Array<{ property: string; options: string[] }>
  /**
   * Per-property relation config upgrades (e.g. single_property →
   * dual_property). Existing relation values are preserved by Notion across
   * this transition.
   */
  addedRelationConfig: Array<{
    property: string
    from: "single_property" | "dual_property"
    to: "single_property" | "dual_property"
  }>
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
 * Detect which relation variant a property is configured as. Returns `null`
 * for non-relation properties. Accepts both the Notion response shape
 * (`{ type: "relation", relation: {...} }`) and the request/schema shape
 * (`{ relation: {...} }`, no outer `type`) — we need to compare live and
 * expected configs directly and the schema helpers emit the shorter form.
 */
function detectRelationType(
  prop: unknown
): "single_property" | "dual_property" | null {
  if (!prop || typeof prop !== "object") return null
  const p = prop as { type?: string; relation?: Record<string, unknown> }
  if (p.type !== undefined && p.type !== "relation") return null
  if (!p.relation || typeof p.relation !== "object") return null
  if ("single_property" in p.relation) return "single_property"
  if ("dual_property" in p.relation) return "dual_property"
  return null
}

/**
 * Compute how an expected relation property differs in shape from the live
 * one. Returns `null` when either side isn't a relation, when the relation
 * variant already matches, or when the live/expected `data_source_id`
 * differs (a pointer change is a different kind of drift — phase 1 or
 * human intervention handles it).
 *
 * When there IS a variant mismatch, returns the payload to send via
 * `dataSources.update`. Notion preserves existing relation values across
 * this transition and auto-assigns the synced back-reference name when the
 * target variant is `dual_property` with an empty config.
 */
export function computeRelationConfigDiff(
  propertyName: string,
  liveProperty: unknown,
  expectedProperty: unknown
): {
  property: string
  liveType: "single_property" | "dual_property"
  expectedType: "single_property" | "dual_property"
  updatePayload: Record<string, unknown>
} | null {
  const liveType = detectRelationType(liveProperty)
  const expectedType = detectRelationType(expectedProperty)
  if (!liveType || !expectedType) return null
  if (liveType === expectedType) return null

  const liveDsId = (
    (liveProperty as { relation?: { data_source_id?: string } }).relation ?? {}
  ).data_source_id
  const expectedDsId = (
    (expectedProperty as { relation?: { data_source_id?: string } }).relation ?? {}
  ).data_source_id
  if (liveDsId && expectedDsId && liveDsId !== expectedDsId) return null

  const dataSourceId = expectedDsId ?? liveDsId
  if (!dataSourceId) return null

  const relationConfig: Record<string, unknown> = {
    data_source_id: dataSourceId,
    type: expectedType,
    [expectedType]: {},
  }

  return {
    property: propertyName,
    liveType,
    expectedType,
    updatePayload: { type: "relation", relation: relationConfig },
  }
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
  // Entities DB is optional in `VaultDatabases`. When present, the Facts
  // schema sees the entity DS id and grows the `SubjectEntity` /
  // `ObjectEntity` relation columns. When absent, the Facts schema stays
  // at its pre-PF3-01 shape — `migrateVaultSchema` won't surface the new
  // columns as drift on a vault that hasn't run the build-entities
  // migration yet.
  const entitiesDsId = db.entities?.dataSourceId
  const expectedByDb: Partial<Record<keyof VaultDatabases, AnyProperties>> = {
    projects: projectsProperties,
    topics: topicsProperties(db.projects.dataSourceId),
    memories: memoriesProperties(
      db.projects.dataSourceId,
      db.topics.dataSourceId,
      db.memories.dataSourceId
    ),
    facts: factsProperties(
      db.projects.dataSourceId,
      db.memories.dataSourceId,
      entitiesDsId
    ),
  }
  if (db.entities) {
    expectedByDb.entities = entitiesProperties(
      db.projects.dataSourceId,
      db.memories.dataSourceId
    )
  }

  const diffs: MigrationDiff[] = []

  // Phase A — fan out the live-schema retrieves. Each retrieve is independent
  // and the diff logic is purely local computation, so the only wall-clock
  // cost worth shaving here is the retrieve fan-out. The shared rate-limited
  // client gates concurrency, so this never bursts past the configured cap.
  const targets = (Object.keys(expectedByDb) as Array<keyof VaultDatabases>)
    .flatMap((key) => {
      const expected = expectedByDb[key]
      const ref = db[key]
      if (!expected || !ref) return []
      return [{ key, expected, dsId: ref.dataSourceId }] as const
    })

  // Colocate each target with its retrieved live properties so Phase B
  // never has to index two parallel arrays (a known footgun if anything
  // ever filters between A and B).
  const resolved = await Promise.all(
    targets.map(async (t) => {
      const live = await client.dataSources.retrieve({ data_source_id: t.dsId })
      const liveProps = (live as { properties: Record<string, unknown> }).properties
      return { ...t, liveProps }
    }),
  )

  // Phase B — per-database diff and (for non-dry-run) update. Stays
  // sequential so the phase-attributed `Schema migration failed on ...`
  // error message keeps pointing at a single DB instead of a batched
  // rejection.
  for (const { key, expected, dsId, liveProps } of resolved) {
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

    // Phase 3: detect relation config drift (e.g. single_property → dual_property).
    const addedRelationConfig: MigrationDiff["addedRelationConfig"] = []
    const relationUpdates: AnyProperties = {}
    for (const name of Object.keys(expected)) {
      if (!(name in liveProps)) continue
      const diff = computeRelationConfigDiff(name, liveProps[name], expected[name])
      if (!diff) continue
      addedRelationConfig.push({
        property: diff.property,
        from: diff.liveType,
        to: diff.expectedType,
      })
      relationUpdates[name] = diff.updatePayload
    }

    diffs.push({ database: key, missing, addedOptions, addedRelationConfig })

    if (
      missing.length === 0 &&
      addedOptions.length === 0 &&
      addedRelationConfig.length === 0
    )
      continue
    if (options.dryRun) continue

    const updateProps: AnyProperties = { ...optionUpdates, ...relationUpdates }
    for (const name of missing) updateProps[name] = expected[name]

    try {
      await client.dataSources.update({
        data_source_id: dsId,
        properties: updateProps as Parameters<
          Client["dataSources"]["update"]
        >[0]["properties"],
      })
    } catch (err) {
      // Re-throw with phase attribution so a Notion "validation_error" on
      // the merged update payload is diagnosable: the user learns which DB
      // and which phase's contribution most likely caused the failure.
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Schema migration failed on ${key} DB ` +
          `(missing=${missing.length}, options=${addedOptions.length}, relation=${addedRelationConfig.length}): ${msg}`,
        { cause: err }
      )
    }
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

  // Required-vs-optional split. Entities (PF3-01) is optional so vaults
  // created before the migration ran still load — `lore migrate
  // --build-entities` is the path that lifts a legacy vault into a
  // post-PF3-01 schema. The four core databases (Projects / Topics /
  // Memories / Facts) remain mandatory; their absence is a setup error
  // worth blocking on.
  const requiredTitles: Record<
    Exclude<keyof VaultDatabases, "entities">,
    string
  > = {
    projects: PROJECTS_DB_TITLE,
    topics: TOPICS_DB_TITLE,
    memories: MEMORIES_DB_TITLE,
    facts: FACTS_DB_TITLE,
  }
  const optionalTitles: Record<"entities", string> = {
    entities: ENTITIES_DB_TITLE,
  }

  const dbBlockIds: Partial<Record<keyof VaultDatabases, string>> = {}

  for (const block of response.results) {
    if (!("type" in block)) continue
    const fullBlock = block as BlockObjectResponse
    if (fullBlock.type !== "child_database") continue

    const title = fullBlock.child_database.title
    for (const [key, expectedTitle] of Object.entries({
      ...requiredTitles,
      ...optionalTitles,
    })) {
      if (title === expectedTitle) {
        dbBlockIds[key as keyof VaultDatabases] = fullBlock.id
      }
    }
  }

  const missing = Object.entries(requiredTitles)
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
  // Retrieves are independent — fan them out concurrently. The shared
  // rate-limited client gates concurrency, so this never bursts past the
  // configured cap.
  const entries = Object.entries(dbBlockIds) as Array<
    [keyof VaultDatabases, string]
  >
  const retrieved = await Promise.all(
    entries.map(async ([key, dbId]) => {
      const db = await client.databases.retrieve({ database_id: dbId })
      const dataSources = (db as Record<string, unknown>)["data_sources"] as
        | Array<{ id: string }>
        | undefined
      return [
        key,
        { databaseId: dbId, dataSourceId: dataSources?.[0]?.id ?? dbId },
      ] as const
    }),
  )
  const resolved: Partial<VaultDatabases> = {}
  for (const [key, ref] of retrieved) {
    resolved[key] = ref
  }

  return {
    pageId,
    databases: resolved as VaultDatabases,
  }
}
