/**
 * Vault management — the root container for all Lore data.
 *
 * A vault is backed by a single Notion page containing four linked databases.
 */

import type { Client } from "@notionhq/client"
import type { Vault, VaultDatabases } from "../types.js"
import {
  createVaultDatabases,
  migrateVaultSchema,
  verifyVaultDatabases,
  type MigrationDiff,
} from "../notion/setup.js"

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
    // Best-effort drift detection — surfaces a stderr warning when the live
    // schema is behind the code. Never blocks or throws: transient API errors
    // during the check should not prevent the vault from loading.
    this.detectDrift().catch(() => {})
    return this.vault
  }

  /**
   * Compare live schema to expected schema read-only. When drift is found,
   * emit a stderr warning nudging the user to run `lore migrate`. Does not
   * throw and does not write anything.
   */
  private async detectDrift(): Promise<void> {
    if (!this.vault) return
    const diffs = await migrateVaultSchema(this.client, this.vault, { dryRun: true })
    const missingProps = diffs.reduce((n, d) => n + d.missing.length, 0)
    const missingOptions = diffs.reduce(
      (n, d) => n + d.addedOptions.reduce((m, a) => m + a.options.length, 0),
      0
    )
    if (missingProps === 0 && missingOptions === 0) return
    const parts: string[] = []
    if (missingProps > 0) {
      parts.push(`${missingProps} propert${missingProps === 1 ? "y" : "ies"}`)
    }
    if (missingOptions > 0) {
      parts.push(`${missingOptions} select option${missingOptions === 1 ? "" : "s"}`)
    }
    console.error(
      `[lore] Schema drift detected: ${parts.join(" and ")} missing. ` +
        "Run `lore migrate` to update your vault."
    )
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

  /**
   * Add any expected properties that are missing from the live data sources.
   * Add-only; never renames or removes. Pass `dryRun: true` to compute the
   * diff without writing.
   */
  async migrate(options: { dryRun?: boolean } = {}): Promise<MigrationDiff[]> {
    return migrateVaultSchema(this.client, this.get(), options)
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
