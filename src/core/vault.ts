/**
 * Vault management — the root container for all Lore data.
 *
 * A vault is backed by a single Notion page containing four linked databases.
 */

import type { Client } from "@notionhq/client"
import type { Vault, VaultDatabases } from "../types.js"
import { createVaultDatabases, verifyVaultDatabases } from "../notion/setup.js"

export class VaultManager {
  private vault: Vault | null = null

  constructor(
    private client: Client,
    private pageId: string
  ) {}

  async init(): Promise<Vault> {
    try {
      await verifyVaultDatabases(this.client, this.pageId)
      throw new Error("Vault already initialized at this page. Use `load()` to connect.")
    } catch (e) {
      if (e instanceof Error && e.message.includes("already initialized")) {
        throw e
      }
      // If verify threw about missing databases, that's expected — proceed to create them
      if (!(e instanceof Error && e.message.includes("missing databases"))) {
        throw e // Re-throw unexpected errors (network, auth, etc.)
      }
    }

    this.vault = await createVaultDatabases(this.client, this.pageId)
    return this.vault
  }

  async load(): Promise<Vault> {
    this.vault = await verifyVaultDatabases(this.client, this.pageId)
    return this.vault
  }

  get(): Vault {
    if (!this.vault) {
      throw new Error("Vault not loaded. Call init() or load() first.")
    }
    return this.vault
  }

  get databases(): VaultDatabases {
    return this.get().databases
  }

  async stats(): Promise<{
    projects: number
    topics: number
    memories: number
    facts: number
  }> {
    const db = this.databases

    const [projects, topics, memories, facts] = await Promise.all([
      this.countDatabase(db.projects.dataSourceId),
      this.countDatabase(db.topics.dataSourceId),
      this.countDatabase(db.memories.dataSourceId),
      this.countDatabase(db.facts.dataSourceId),
    ])

    return { projects, topics, memories, facts }
  }

  private async countDatabase(databaseId: string): Promise<number> {
    let count = 0
    let cursor: string | undefined

    do {
      const response = await this.client.dataSources.query({
        data_source_id: databaseId,
        page_size: 100,
        start_cursor: cursor,
      })
      count += response.results.length
      cursor = response.next_cursor ?? undefined
      if (!response.has_more) break
    } while (cursor)

    return count
  }
}
