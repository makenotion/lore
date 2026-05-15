import type { LoreServices } from "../../../services.js"

export type SchemaMigrationResult = Awaited<
  ReturnType<LoreServices["vault"]["migrate"]>
> & { totalBlockedOptions: number }

export async function runSchemaMigration(
  services: LoreServices,
  opts: {
    dryRun?: boolean
    mergeDuplicateTopics?: boolean
    fixTopicEncoding?: boolean
    upgradeDecisionTags?: boolean
    tags?: boolean
    dedupKeys?: boolean
    hasAliasMergePlans?: boolean
  }
): Promise<SchemaMigrationResult> {
  const migrationResult = await services.vault.migrate({
    dryRun: opts.dryRun,
    mergeDuplicateTopics: opts.mergeDuplicateTopics,
    fixTopicEncoding: opts.fixTopicEncoding,
  })
  const { diffs, duplicateTopics, mergeResults, encodedTopics, encodingFixResults } =
    migrationResult

  const totalMissing = diffs.reduce((n, d) => n + d.missing.length, 0)
  const totalAddedOptions = diffs.reduce(
    (n, d) => n + d.addedOptions.reduce((m, a) => m + a.options.length, 0),
    0
  )
  const totalBlockedOptions = diffs.reduce(
    (n, d) => n + d.blockedOptions.reduce((m, a) => m + a.options.length, 0),
    0
  )
  const totalRelationConfig = diffs.reduce((n, d) => n + d.addedRelationConfig.length, 0)

  const verb = opts.dryRun ? "Would add" : "Added"
  const blockedVerb = opts.dryRun ? "Cannot add" : "Skipped"
  const upgradeVerb = opts.dryRun ? "Would upgrade" : "Upgraded"
  const mergeVerb = opts.dryRun ? "Would merge" : "Merged"

  if (encodedTopics.length > 0) {
    const didWrite = encodingFixResults.length > 0
    const rows = didWrite ? encodingFixResults : encodedTopics
    const decodeVerb = didWrite ? "Decoded" : "Would decode"
    console.log(
      `${decodeVerb} ${rows.length} HTML-encoded topic name${rows.length === 1 ? "" : "s"}:`
    )
    for (const row of rows) {
      console.log(`  "${row.rawName}" → "${row.decodedName}"`)
    }
  }

  if (duplicateTopics.length > 0) {
    const rowCount = duplicateTopics.reduce((n, g) => n + g.topicIds.length, 0)
    if (mergeResults.length > 0) {
      console.log(
        `${mergeVerb} ${mergeResults.length} duplicate-name topic group${mergeResults.length === 1 ? "" : "s"} (${rowCount} rows):`
      )
      for (const result of mergeResults) {
        console.log(
          `  "${result.name}" → canonical ${result.canonicalId}: ` +
            `${result.canonicalProjectIds.length} projects; ` +
            `archived ${result.archivedIds.length}; ` +
            `re-pointed ${result.reassignedMemoryIds.length} memor${result.reassignedMemoryIds.length === 1 ? "y" : "ies"}`
        )
      }
    } else {
      console.log(
        `${mergeVerb} ${duplicateTopics.length} duplicate-name topic group${duplicateTopics.length === 1 ? "" : "s"} (${rowCount} rows):`
      )
      for (const group of duplicateTopics) {
        console.log(
          `  "${group.name}": ${group.topicIds.length} rows (${group.topicIds.join(", ")})`
        )
      }
    }
  }

  if (totalMissing > 0) {
    console.log(
      `${verb} ${totalMissing} missing propert${totalMissing === 1 ? "y" : "ies"}:`
    )
    for (const diff of diffs) {
      if (diff.missing.length === 0) continue
      console.log(`  ${diff.database}: ${diff.missing.join(", ")}`)
    }
  }

  if (totalAddedOptions > 0) {
    console.log(
      `${verb} ${totalAddedOptions} new select option${totalAddedOptions === 1 ? "" : "s"}:`
    )
    for (const diff of diffs) {
      if (diff.addedOptions.length === 0) continue
      for (const added of diff.addedOptions) {
        console.log(`  ${diff.database}.${added.property}: ${added.options.join(", ")}`)
      }
    }
  }

  if (totalBlockedOptions > 0) {
    console.log(
      `${blockedVerb} ${totalBlockedOptions} select option${totalBlockedOptions === 1 ? "" : "s"} because Notion caps property options at 100:`
    )
    for (const diff of diffs) {
      if (diff.blockedOptions.length === 0) continue
      for (const blocked of diff.blockedOptions) {
        console.log(
          `  ${diff.database}.${blocked.property} (${blocked.type}): ` +
            `live=${blocked.liveCount}, attempted=${blocked.attemptedCount}, ` +
            `limit=${blocked.limit}; ${blocked.options.join(", ")}`
        )
      }
    }
    console.log(
      "Prune options from the listed properties or reduce the active profile vocabulary, then rerun `lore migrate`."
    )
  }

  if (totalRelationConfig > 0) {
    console.log(
      `${upgradeVerb} ${totalRelationConfig} relation config${totalRelationConfig === 1 ? "" : "s"}:`
    )
    for (const diff of diffs) {
      if (diff.addedRelationConfig.length === 0) continue
      for (const upgrade of diff.addedRelationConfig) {
        console.log(
          `  ${diff.database}.${upgrade.property}: ${upgrade.from} → ${upgrade.to}`
        )
      }
    }
  }

  if (
    totalMissing === 0 &&
    totalAddedOptions === 0 &&
    totalBlockedOptions === 0 &&
    totalRelationConfig === 0 &&
    duplicateTopics.length === 0 &&
    encodedTopics.length === 0 &&
    !opts.upgradeDecisionTags &&
    !opts.tags &&
    !opts.dedupKeys &&
    !opts.hasAliasMergePlans
  ) {
    console.log("Vault schema is up to date. Nothing to migrate.")
  }

  return { ...migrationResult, totalBlockedOptions }
}
