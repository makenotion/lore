import { Command } from "commander"
import { initServices, type LoreServices } from "../../services.js"

export const migrateCommand = new Command("migrate")
  .description("Add missing schema properties to the vault's data sources")
  .option("--dry-run", "Show what would be added without writing")
  .option(
    "--upgrade-decision-tags",
    "Upgrade memories tagged 'decision' to Kind: decision and strip the tag. Auto-runs schema migration first."
  )
  .option(
    "--merge-duplicate-topics",
    "Merge duplicate-name topic rows into one canonical topic (union projects, re-point memories, archive losers). Required when the vault has legacy duplicate topics before the schema upgrade."
  )
  .option(
    "--fix-topic-encoding",
    "Decode HTML entities (`&amp;`, `&lt;`, …) in topic names so rows like `Build &amp;amp; Tooling` become `Build & Tooling`. Runs before duplicate detection, so pair with `--merge-duplicate-topics` to collapse cross-encoding duplicates."
  )
  .action(
    async (opts: {
      dryRun?: boolean
      upgradeDecisionTags?: boolean
      mergeDuplicateTopics?: boolean
      fixTopicEncoding?: boolean
    }) => {
      try {
        const services = await initServices()

        // When `--upgrade-decision-tags` is combined with `--dry-run`, we still
        // want to report schema drift but NOT apply anything. So dry-run always
        // suppresses writes; `--upgrade-decision-tags` without `--dry-run`
        // triggers the tag upgrade after the schema migration completes.
        const {
          diffs,
          duplicateTopics,
          mergeResults,
          encodedTopics,
          encodingFixResults,
        } = await services.vault.migrate({
          dryRun: opts.dryRun,
          mergeDuplicateTopics: opts.mergeDuplicateTopics,
          fixTopicEncoding: opts.fixTopicEncoding,
        })

        const totalMissing = diffs.reduce((n, d) => n + d.missing.length, 0)
        const totalAddedOptions = diffs.reduce(
          (n, d) => n + d.addedOptions.reduce((m, a) => m + a.options.length, 0),
          0
        )
        const totalRelationConfig = diffs.reduce(
          (n, d) => n + d.addedRelationConfig.length,
          0
        )

        const verb = opts.dryRun ? "Would add" : "Added"
        const upgradeVerb = opts.dryRun ? "Would upgrade" : "Upgraded"
        const mergeVerb = opts.dryRun ? "Would merge" : "Merged"

        if (encodedTopics.length > 0) {
          // The write happened iff `migrate()` actually ran fixTopicEncoding;
          // dry-run or flag-omitted both leave encodingFixResults empty, and
          // both should preview the rows as "would decode" rather than claim
          // a decode that never ran.
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
          totalRelationConfig === 0 &&
          duplicateTopics.length === 0 &&
          encodedTopics.length === 0 &&
          !opts.upgradeDecisionTags
        ) {
          console.log("Vault schema is up to date. Nothing to migrate.")
        }

        if (opts.upgradeDecisionTags) {
          if (opts.dryRun) {
            console.log("\n--upgrade-decision-tags with --dry-run is a no-op (schema diff above).")
          } else {
            const upgraded = await upgradeLegacyDecisionTags(services)
            console.log(
              `\nUpgraded ${upgraded} memor${upgraded === 1 ? "y" : "ies"} from legacy 'decision' tag to Kind: decision.`
            )
          }
        }

        if (opts.dryRun) {
          const flagHints: string[] = []
          if (encodedTopics.length > 0 && !opts.fixTopicEncoding) {
            flagHints.push("`--fix-topic-encoding`")
          }
          if (duplicateTopics.length > 0 && !opts.mergeDuplicateTopics) {
            flagHints.push("`--merge-duplicate-topics`")
          }
          if (flagHints.length > 0) {
            console.log(
              `\nDry run — no changes written. Re-run without --dry-run and with ${flagHints.join(" and ")} to apply.`
            )
          } else {
            console.log("\nDry run — no changes written. Re-run without --dry-run to apply.")
          }
        } else if (encodedTopics.length > 0 && !opts.fixTopicEncoding) {
          // Duplicate-name topics throw in `migrate()` when the flag is
          // omitted, but encoded names proceed silently — surface a nudge so
          // the user doesn't assume the listed rows were decoded.
          console.log(
            "\nRe-run with `--fix-topic-encoding` to decode the topic names listed above."
          )
        }
      } catch (err) {
        console.error("Migrate failed:", err instanceof Error ? err.message : err)
        process.exit(1)
      }
    }
  )

/**
 * Upgrade legacy memories tagged `decision` to `Kind: decision`, stripping
 * the tag in the process. Idempotent: after upgrade, the query returns no
 * results and re-running is a no-op.
 *
 * Iterates in a loop calling `list({ tags: ["decision"] })` — since each
 * iteration upgrades the matched pages (removing the tag), subsequent
 * iterations only see remaining un-upgraded memories.
 */
async function upgradeLegacyDecisionTags(services: LoreServices): Promise<number> {
  const BATCH_SIZE = 100
  let upgraded = 0

  while (true) {
    const { items: batch } = await services.memories.list({
      tags: ["decision"],
      limit: BATCH_SIZE,
      includeContent: false,
    })

    // Defensive filter in case a memory is already Kind=decision but still
    // has the tag for some reason — we still strip the tag in that case.
    const toUpgrade = batch.filter((m) => m.tags.includes("decision"))
    if (toUpgrade.length === 0) break

    for (const m of toUpgrade) {
      const newTags = m.tags.filter((t) => t !== "decision")
      await services.memories.update(m.id, {
        kind: "decision",
        tags: newTags,
      })
      upgraded++
    }
  }

  return upgraded
}
