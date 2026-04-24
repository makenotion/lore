import { Command } from "commander"
import { initServices, type LoreServices } from "../../services.js"
import type { MemoryTagPlan } from "../../core/tag-migration.js"
import { classifyTags, planMemoryMigration } from "../../core/tag-migration.js"

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
  .option(
    "--tags",
    "Reclassify out-of-vocabulary tags. Obvious free-form tokens (PR numbers, ticket IDs, file names, class names) move to Keywords; ambiguous tags are reported for manual triage. Combine with --dry-run for a preview."
  )
  .action(
    async (opts: {
      dryRun?: boolean
      upgradeDecisionTags?: boolean
      mergeDuplicateTopics?: boolean
      fixTopicEncoding?: boolean
      tags?: boolean
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
          !opts.upgradeDecisionTags &&
          !opts.tags
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

        if (opts.tags) {
          // Pre-flight: the --tags pass writes the `Keywords` column, which
          // is itself a schema addition in this release. On --dry-run the
          // schema pass above is also a dry-run, so Keywords may still be
          // missing live; abort with a directive error rather than letting
          // a later, non-dry-run --tags pass fail mid-loop against Notion.
          const memoriesDiff = diffs.find((d) => d.database === "memories")
          const keywordsMissing = memoriesDiff?.missing.includes("Keywords") ?? false
          if (keywordsMissing && opts.dryRun) {
            console.log(
              "\n--tags requires the `Keywords` property, which the live schema is missing. " +
                "Re-run `lore migrate` (no --dry-run) first to add it, then re-run `lore migrate --tags --dry-run`."
            )
          } else if (keywordsMissing) {
            throw new Error(
              "Cannot reclassify tags: the Memories database is missing the `Keywords` property. " +
                "The schema migration above should have added it — inspect that output and retry."
            )
          } else {
            await migrateOutOfVocabTags(services, { dryRun: opts.dryRun })
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
 * Scan every memory, reclassify obvious free-form tags into `Keywords`, and
 * report ambiguous out-of-vocab tags for manual triage.
 *
 * Two-phase: snapshot every memory across all cursor pages first, then
 * apply updates. `MemoryService.list()` sorts by `last_edited_time desc`,
 * which the update step mutates — iterating and writing in the same loop
 * would shuffle memories between cursor pages and either double-process or
 * skip rows. Snapshot-then-apply eliminates that correctness hazard and
 * lets the final totals be authoritative.
 *
 * Idempotent: after running, the surviving out-of-vocab tags are exactly
 * the ambiguous ones, and re-running the migration moves nothing further
 * (the heuristic is deterministic per tag string).
 */
async function migrateOutOfVocabTags(
  services: LoreServices,
  options: { dryRun?: boolean }
): Promise<void> {
  const PAGE_SIZE = 100
  let cursor: string | undefined
  let scanned = 0
  const plans: MemoryTagPlan[] = []
  const ambiguousFreq = new Map<string, number>()

  // Phase 1 — scan: collect plans across every cursor page without
  // writing. No update() call inside this loop, so the sort order is
  // stable for the duration of pagination.
  for (;;) {
    const { items, nextCursor } = await services.memories.list({
      limit: PAGE_SIZE,
      includeContent: false,
      startCursor: cursor,
    })
    if (items.length === 0 && !nextCursor) break

    for (const memory of items) {
      scanned++
      if (memory.tags.length === 0) continue

      const classification = classifyTags(memory.tags)
      for (const tag of classification.ambiguous) {
        ambiguousFreq.set(tag, (ambiguousFreq.get(tag) ?? 0) + 1)
      }

      const plan = planMemoryMigration(memory)
      if (plan) plans.push(plan)
    }

    cursor = nextCursor
    if (!cursor) break
  }

  const movedTotal = plans.reduce((n, p) => n + p.moved.length, 0)
  const verb = options.dryRun ? "Would reclassify" : "Reclassified"
  console.log(
    `\n${verb} ${plans.length} memor${plans.length === 1 ? "y" : "ies"} ` +
      `(${movedTotal} token${movedTotal === 1 ? "" : "s"} moved to Keywords, ` +
      `${scanned} memor${scanned === 1 ? "y" : "ies"} scanned).`
  )

  if (plans.length > 0) {
    console.log("\nSample reclassifications:")
    for (const plan of plans.slice(0, 10)) {
      console.log(
        `  ${plan.memoryId} — "${plan.title}"\n` +
          `    moved: ${plan.moved.join(", ") || "(none — case-drift normalization only)"}\n` +
          `    tags:  [${plan.before.tags.join(", ")}] → [${plan.after.tags.join(", ")}]`
      )
    }
    if (plans.length > 10) {
      console.log(`  … and ${plans.length - 10} more.`)
    }
  }

  // Phase 2 — apply: one update per snapshotted plan. Sequential writes
  // match the Notion API's rate ceiling and keep the per-memory error
  // blast radius contained.
  if (!options.dryRun && plans.length > 0) {
    let failed = 0
    for (const plan of plans) {
      try {
        await services.memories.update(plan.memoryId, {
          tags: plan.after.tags,
          keywords: plan.after.keywords,
        })
      } catch (err) {
        failed++
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`  failed ${plan.memoryId}: ${msg}`)
      }
    }
    if (failed > 0) {
      console.log(
        `(Applied ${plans.length - failed} of ${plans.length}; ${failed} failed — see errors above.)`
      )
    }
  }

  if (ambiguousFreq.size > 0) {
    const ranked = Array.from(ambiguousFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
    console.log(
      `\nAmbiguous tags left in place (top ${ranked.length} of ${ambiguousFreq.size}):`
    )
    for (const [tag, count] of ranked) {
      console.log(`  ${tag.padEnd(40)} ${count}`)
    }
    console.log(
      "\nTriage manually: rename to a vocabulary term, move into Keywords, or accept as-is."
    )
  }
}

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
