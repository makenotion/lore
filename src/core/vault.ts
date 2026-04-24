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
import {
  findDuplicateTopicNames,
  findEncodedTopicNames,
  findPostDecodeTopicCollisions,
  fixTopicEncoding,
  mergeDuplicateTopics,
  mergeTopicsByAliasPlans,
  type DuplicateTopicGroup,
  type EncodedTopicRow,
  type TopicAliasMergePlan,
  type TopicAliasMergeResult,
  type TopicEncodingFixResult,
  type TopicMergeResult,
} from "./topic-merge.js"

export interface VaultMigrateResult {
  /** Per-database schema drift (missing props, added options, relation upgrades). */
  diffs: MigrationDiff[]
  /** Duplicate-name topic groups found in the Topics DB. */
  duplicateTopics: DuplicateTopicGroup[]
  /** Populated only when the migration actually ran a merge (non-dryRun + flag). */
  mergeResults: TopicMergeResult[]
  /** Topic rows whose Name contained HTML entity escape sequences. */
  encodedTopics: EncodedTopicRow[]
  /** Populated only when the migration actually rewrote encoded topic names
   *  (non-dryRun + `--fix-topic-encoding`). */
  encodingFixResults: TopicEncodingFixResult[]
}

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
    // schema is behind the code. Never blocks: transient API errors during
    // the check should not prevent the vault from loading. Unlike a bare
    // `.catch(() => {})`, failures are logged so we don't silently lose the
    // "run `lore migrate`" nudge when the drift check itself is broken.
    this.detectDrift().catch((err) => {
      console.error(
        "[lore] Schema drift check failed:",
        err instanceof Error ? err.message : err
      )
    })
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
    const duplicates = await findDuplicateTopicNames(
      this.client,
      this.vault.databases.topics
    )
    const encoded = await findEncodedTopicNames(
      this.client,
      this.vault.databases.topics
    )

    const missingProps = diffs.reduce((n, d) => n + d.missing.length, 0)
    const missingOptions = diffs.reduce(
      (n, d) => n + d.addedOptions.reduce((m, a) => m + a.options.length, 0),
      0
    )
    const relationUpgrades = diffs.reduce(
      (n, d) => n + d.addedRelationConfig.length,
      0
    )
    const duplicateRowCount = duplicates.reduce((n, d) => n + d.topicIds.length, 0)

    if (
      missingProps === 0 &&
      missingOptions === 0 &&
      relationUpgrades === 0 &&
      duplicates.length === 0 &&
      encoded.length === 0
    ) {
      return
    }

    const parts: string[] = []
    if (missingProps > 0) {
      parts.push(`${missingProps} propert${missingProps === 1 ? "y" : "ies"}`)
    }
    if (missingOptions > 0) {
      parts.push(`${missingOptions} select option${missingOptions === 1 ? "" : "s"}`)
    }
    if (relationUpgrades > 0) {
      parts.push(
        `${relationUpgrades} relation config${relationUpgrades === 1 ? "" : "s"}`
      )
    }
    if (duplicates.length > 0) {
      parts.push(
        `${duplicates.length} duplicate topic group${duplicates.length === 1 ? "" : "s"} (${duplicateRowCount} rows)`
      )
    }
    if (encoded.length > 0) {
      parts.push(
        `${encoded.length} HTML-encoded topic name${encoded.length === 1 ? "" : "s"}`
      )
    }
    const hints: string[] = []
    if (encoded.length > 0) hints.push("--fix-topic-encoding")
    if (duplicates.length > 0) hints.push("--merge-duplicate-topics")
    // The drift hint is a single `lore migrate` invocation; multiple flags
    // chain with a space (shell-literal), not " and ".
    const hint =
      hints.length > 0
        ? `Run \`lore migrate ${hints.join(" ")}\` to update your vault.`
        : "Run `lore migrate` to update your vault."
    console.error(`[lore] Schema drift detected: ${parts.join(" and ")} out of date. ${hint}`)
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
   * Apply schema drift fixes and (optionally) merge duplicate-name topics
   * or decode HTML-escaped topic names.
   *
   * Add-only for schema: never renames or removes properties. Pass
   * `dryRun: true` to compute the diff without writing.
   *
   * When HTML-encoded topic names exist:
   * - `dryRun: true` — reports them, no writes.
   * - `fixTopicEncoding: true` (and not dryRun) — rewrites each encoded
   *   row's Name to the decoded form before duplicate detection runs, so
   *   cross-encoding dup pairs (e.g. `Build & Tooling` alongside a legacy
   *   `Build &amp;amp; Tooling`) collapse naturally when
   *   `mergeDuplicateTopics` is also passed.
   *
   * When duplicate-name topics exist:
   * - `dryRun: true` — reports them, no writes.
   * - `mergeDuplicateTopics: true` (and not dryRun) — merges each group
   *   into one canonical topic before applying schema drift.
   * - neither — throws, so a legacy vault with duplicates can't silently
   *   end up with a dual-property schema where `getOrCreate` would extend
   *   an arbitrary duplicate and strand the siblings.
   */
  async migrate(
    options: {
      dryRun?: boolean
      mergeDuplicateTopics?: boolean
      fixTopicEncoding?: boolean
    } = {}
  ): Promise<VaultMigrateResult> {
    const vault = this.get()
    const encodedTopics = await findEncodedTopicNames(
      this.client,
      vault.databases.topics
    )

    // Validate all preconditions BEFORE writing anything. If the vault has
    // cross-encoding pairs (e.g. `Build & Tooling` next to a legacy
    // `Build &amp;amp; Tooling`), decoding the encoded row turns the two
    // into a duplicate-name group. Running `fixTopicEncoding` alone would
    // write the decoded name, *then* the subsequent dup check would throw
    // — leaving the vault half-migrated and the error message's
    // "re-run with --merge-duplicate-topics" advice incomplete.
    //
    // Checking collisions first closes that gap: if any post-decode
    // duplicates would exist and the user didn't authorize the merge, we
    // throw before any write lands. The decoder is idempotent so a clean
    // re-run with both flags leaves the vault in the intended final state.
    if (
      options.fixTopicEncoding &&
      !options.dryRun &&
      encodedTopics.length > 0 &&
      !options.mergeDuplicateTopics
    ) {
      const postDecodeDups = await findPostDecodeTopicCollisions(
        this.client,
        vault.databases.topics
      )
      if (postDecodeDups.length > 0) {
        const preview = postDecodeDups
          .slice(0, 5)
          .map((g) => `"${g.name}" (${g.topicIds.length} rows)`)
          .join(", ")
        const more =
          postDecodeDups.length > 5 ? `, and ${postDecodeDups.length - 5} more` : ""
        throw new Error(
          `Decoding would surface ${postDecodeDups.length} duplicate-name topic group${postDecodeDups.length === 1 ? "" : "s"}: ${preview}${more}. ` +
            "Re-run with `--merge-duplicate-topics` alongside `--fix-topic-encoding` so the cross-encoding pairs are collapsed in the same pass; the decoder is idempotent, so nothing has been written yet."
        )
      }
    }

    // Decoding happens first so subsequent duplicate detection sees a
    // clean view of the Topics DB.
    let encodingFixResults: TopicEncodingFixResult[] = []
    if (encodedTopics.length > 0 && !options.dryRun && options.fixTopicEncoding) {
      encodingFixResults = await fixTopicEncoding(this.client, vault.databases.topics)
    }

    const duplicateTopics = await findDuplicateTopicNames(
      this.client,
      vault.databases.topics
    )

    let mergeResults: TopicMergeResult[] = []
    if (duplicateTopics.length > 0 && !options.dryRun) {
      if (!options.mergeDuplicateTopics) {
        const preview = duplicateTopics
          .slice(0, 5)
          .map((g) => `"${g.name}" (${g.topicIds.length} rows)`)
          .join(", ")
        const more =
          duplicateTopics.length > 5
            ? `, and ${duplicateTopics.length - 5} more`
            : ""
        throw new Error(
          `${duplicateTopics.length} duplicate-name topic group${duplicateTopics.length === 1 ? "" : "s"} detected: ${preview}${more}. ` +
            "Re-run with `--merge-duplicate-topics` to merge each group into a canonical topic before upgrading the schema."
        )
      }
      mergeResults = await mergeDuplicateTopics(
        this.client,
        vault.databases.topics,
        vault.databases.memories,
        duplicateTopics
      )
    }

    const diffs = await migrateVaultSchema(this.client, vault, {
      dryRun: options.dryRun,
    })
    return {
      diffs,
      duplicateTopics,
      mergeResults,
      encodedTopics,
      encodingFixResults,
    }
  }

  /**
   * Apply an operator-curated list of alias → canonical topic merges.
   * Each plan in `plans` names a canonical topic and one or more aliases;
   * every topic row with an alias name is re-pointed onto the canonical
   * and then archived. Memories referencing an archived alias get their
   * Topic relation replaced with the canonical id.
   *
   * Separate entry point from `migrate()` because the alias consolidation
   * is conceptually distinct from schema drift and encoding repair: its
   * input is a human-authored YAML, not a diff the code can compute. Pass
   * `dryRun: true` to preview without writing.
   *
   * Idempotent: a second run finds no alias rows and reports every plan
   * as `noop: true`.
   */
  async migrateAliasMerges(
    plans: TopicAliasMergePlan[],
    options: { dryRun?: boolean } = {}
  ): Promise<TopicAliasMergeResult[]> {
    const vault = this.get()
    return mergeTopicsByAliasPlans(
      this.client,
      vault.databases.topics,
      vault.databases.memories,
      plans,
      options
    )
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
