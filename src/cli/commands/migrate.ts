import { Command } from "commander"
import { initServices, type LoreServices } from "../../services.js"

export const migrateCommand = new Command("migrate")
  .description("Add missing schema properties to the vault's data sources")
  .option("--dry-run", "Show what would be added without writing")
  .option(
    "--upgrade-decision-tags",
    "Upgrade memories tagged 'decision' to Kind: decision and strip the tag. Auto-runs schema migration first."
  )
  .action(async (opts: { dryRun?: boolean; upgradeDecisionTags?: boolean }) => {
    try {
      const services = await initServices()

      // When `--upgrade-decision-tags` is combined with `--dry-run`, we still
      // want to report schema drift but NOT apply anything. So dry-run always
      // suppresses writes; `--upgrade-decision-tags` without `--dry-run`
      // triggers the tag upgrade after the schema migration completes.
      const diffs = await services.vault.migrate({ dryRun: opts.dryRun })

      const totalMissing = diffs.reduce((n, d) => n + d.missing.length, 0)
      const totalAddedOptions = diffs.reduce(
        (n, d) => n + d.addedOptions.reduce((m, a) => m + a.options.length, 0),
        0
      )

      const verb = opts.dryRun ? "Would add" : "Added"

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

      if (totalMissing === 0 && totalAddedOptions === 0 && !opts.upgradeDecisionTags) {
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
        console.log("\nDry run — no changes written. Re-run without --dry-run to apply.")
      }
    } catch (err) {
      console.error("Migrate failed:", err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

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
    const batch = await services.memories.list({
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
