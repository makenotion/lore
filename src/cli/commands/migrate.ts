import { Command } from "commander"
import { initServices } from "../../services.js"

export const migrateCommand = new Command("migrate")
  .description("Add missing schema properties to the vault's data sources")
  .option("--dry-run", "Show what would be added without writing")
  .action(async (opts: { dryRun?: boolean }) => {
    try {
      const services = await initServices()
      const diffs = await services.vault.migrate({ dryRun: opts.dryRun })

      const totalMissing = diffs.reduce((n, d) => n + d.missing.length, 0)
      const totalAddedOptions = diffs.reduce(
        (n, d) => n + d.addedOptions.reduce((m, a) => m + a.options.length, 0),
        0
      )

      if (totalMissing === 0 && totalAddedOptions === 0) {
        console.log("Vault schema is up to date. Nothing to migrate.")
        return
      }

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

      if (opts.dryRun) {
        console.log("\nDry run — no changes written. Re-run without --dry-run to apply.")
      }
    } catch (err) {
      console.error("Migrate failed:", err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })
