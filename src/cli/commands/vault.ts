import { Command } from "commander"
import {
  ensureConfiguredEntitiesDatabase,
  summarizeMigrationDiffs,
  type EnsureConfiguredEntitiesResult,
} from "../vault-repair.js"

export const ensureEntitiesCommand = new Command("ensure-entities")
  .description(
    "Create the Entities database on legacy vaults and add related schema drift"
  )
  .option("--dry-run", "Show what would be changed without writing")
  .action(async (opts: { dryRun?: boolean }) => {
    try {
      const result = await ensureConfiguredEntitiesDatabase({
        dryRun: opts.dryRun,
      })
      for (const line of formatEnsureEntitiesResult(result, {
        dryRun: opts.dryRun,
      })) {
        console.log(line)
      }
      const summary = summarizeMigrationDiffs(result.diffs)
      if (!opts.dryRun && summary.blockedOptions > 0) {
        console.error(
          "Vault ensure-entities failed: schema migration is incomplete because one or more select option updates exceed Notion's option limit."
        )
        process.exit(1)
        return
      }
    } catch (err) {
      console.error(
        "Vault ensure-entities failed:",
        err instanceof Error ? err.message : err
      )
      process.exit(1)
    }
  })

export const vaultCommand = new Command("vault")
  .description("Vault maintenance commands")
  .addCommand(ensureEntitiesCommand)

export function formatEnsureEntitiesResult(
  result: EnsureConfiguredEntitiesResult,
  options: { dryRun?: boolean } = {}
): string[] {
  const lines: string[] = []
  if (result.ensure.status === "would-create") {
    lines.push("Would create the Entities database on the configured vault page.")
    lines.push(
      "Would run schema migration after creation so Facts gains SubjectEntity/ObjectEntity relation columns."
    )
    return lines
  }

  if (result.ensure.status === "created") {
    lines.push(`Created Entities database: ${result.ensure.ref.databaseId}`)
  } else {
    lines.push(`Entities database already exists: ${result.ensure.ref.databaseId}`)
  }

  const summary = summarizeMigrationDiffs(result.diffs)
  const verb = options.dryRun ? "Would add" : "Added"
  const upgradeVerb = options.dryRun ? "Would upgrade" : "Upgraded"

  if (summary.missingProperties > 0) {
    lines.push(
      `${verb} ${summary.missingProperties} missing propert${summary.missingProperties === 1 ? "y" : "ies"}:`
    )
    for (const diff of result.diffs) {
      if (diff.missing.length === 0) continue
      lines.push(`  ${diff.database}: ${diff.missing.join(", ")}`)
    }
  }

  if (summary.addedOptions > 0) {
    lines.push(
      `${verb} ${summary.addedOptions} new select option${summary.addedOptions === 1 ? "" : "s"}:`
    )
    for (const diff of result.diffs) {
      for (const added of diff.addedOptions) {
        lines.push(`  ${diff.database}.${added.property}: ${added.options.join(", ")}`)
      }
    }
  }

  if (summary.blockedOptions > 0) {
    lines.push(
      `Cannot add ${summary.blockedOptions} select option${summary.blockedOptions === 1 ? "" : "s"} because Notion caps property options at 100:`
    )
    for (const diff of result.diffs) {
      for (const blocked of diff.blockedOptions) {
        lines.push(
          `  ${diff.database}.${blocked.property}: live=${blocked.liveCount}, attempted=${blocked.attemptedCount}, limit=${blocked.limit}; ${blocked.options.join(", ")}`
        )
      }
    }
    lines.push(
      "Prune options from the listed properties or reduce the active profile vocabulary, then rerun the command."
    )
  }

  if (summary.relationConfigs > 0) {
    lines.push(
      `${upgradeVerb} ${summary.relationConfigs} relation config${summary.relationConfigs === 1 ? "" : "s"}:`
    )
    for (const diff of result.diffs) {
      for (const upgrade of diff.addedRelationConfig) {
        lines.push(
          `  ${diff.database}.${upgrade.property}: ${upgrade.from} -> ${upgrade.to}`
        )
      }
    }
  }

  if (
    summary.missingProperties === 0 &&
    summary.addedOptions === 0 &&
    summary.blockedOptions === 0 &&
    summary.relationConfigs === 0
  ) {
    lines.push("Vault schema is up to date.")
  }

  return lines
}
