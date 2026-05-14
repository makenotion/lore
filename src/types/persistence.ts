/**
 * Persistence-adjacent types for Notion vault and database references.
 */

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export interface Vault {
  /** Notion page ID that contains all Lore databases */
  pageId: string
  /** Database IDs created within the vault page */
  databases: VaultDatabases
}

/**
 * References both IDs for a Notion database.
 *
 * In SDK v5, `dataSources.query()` requires the data-source ID while
 * `pages.create()` requires the database (block) ID. They differ.
 */
export interface DatabaseRef {
  /** Database block ID — used as parent in pages.create() */
  databaseId: string
  /** Data source ID — used in dataSources.query() */
  dataSourceId: string
}

export interface VaultDatabases {
  projects: DatabaseRef
  topics: DatabaseRef
  memories: DatabaseRef
  /**
   * Canonical-entity registry. Sits between Memories and Facts in the
   * dependency graph because Facts relate to Entity rows via
   * `SubjectEntity` / `ObjectEntity` while Entities themselves reference
   * Projects + Memories.
   */
  entities: DatabaseRef
  facts: DatabaseRef
}
