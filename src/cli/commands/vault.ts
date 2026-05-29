import { Command } from "commander"
import {
  migrateAgentDiaryMemories,
  type AgentDiaryMigrationResult,
  type AgentDiaryMigrationRow,
} from "../../core/agent-diary-migration.js"
import { initServices } from "../../services.js"
import { parsePositiveDecimalInteger, type CliParseResult } from "../parse.js"
import {
  ensureConfiguredEntitiesDatabase,
  summarizeMigrationDiffs,
  type EnsureConfiguredEntitiesResult,
} from "../vault-repair.js"

export interface MigrateAgentDiaryCliOptions {
  apply: boolean
  sampleLimit: number
  json: boolean
}

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

export function parseMigrateAgentDiaryOptions(raw: {
  apply?: boolean
  sample?: string
  json?: boolean
}): CliParseResult<MigrateAgentDiaryCliOptions> {
  const parsedSample = parsePositiveDecimalInteger("--sample", raw.sample ?? "5")
  if (!parsedSample.ok) return parsedSample
  return {
    ok: true,
    value: {
      apply: raw.apply === true,
      sampleLimit: parsedSample.value,
      json: raw.json === true,
    },
  }
}

export const migrateAgentDiaryCommand = new Command("migrate-agent-diary")
  .description(
    "Audit and migrate source=agent_diary memories without removing the select option"
  )
  .option("--apply", "Write updates. Omitted mode prints a dry-run audit.")
  .option("--sample <n>", "Rows to show per bucket", "5")
  .option("--json", "Emit machine-readable JSON instead of human-readable text")
  .action(async (opts: { apply?: boolean; sample?: string; json?: boolean } = {}) => {
    try {
      const parsed = parseMigrateAgentDiaryOptions(opts)
      if (!parsed.ok) {
        console.error(`Vault migrate-agent-diary failed: ${parsed.message}`)
        process.exit(1)
        return
      }

      const services = await initServices()
      const result = await migrateAgentDiaryMemories({
        client: services.client,
        memories: services.context.vault.databases.memories,
        apply: parsed.value.apply,
        sampleLimit: parsed.value.sampleLimit,
      })

      if (parsed.value.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        for (const line of formatAgentDiaryMigrationResult(result)) {
          console.log(line)
        }
      }

      if (result.applied.failures.length > 0) {
        console.error(
          `Vault migrate-agent-diary failed: ${result.applied.failures.length} update${result.applied.failures.length === 1 ? "" : "s"} failed.`
        )
        process.exit(1)
        return
      }
    } catch (err) {
      console.error(
        "Vault migrate-agent-diary failed:",
        err instanceof Error ? err.message : err
      )
      process.exit(1)
    }
  })

export const vaultCommand = new Command("vault")
  .description("Vault maintenance commands")
  .addCommand(ensureEntitiesCommand)
  .addCommand(migrateAgentDiaryCommand)

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

export function formatAgentDiaryMigrationResult(
  result: AgentDiaryMigrationResult
): string[] {
  const lines: string[] = []
  const applying = result.mode === "apply"
  lines.push(
    applying ? "Applied agent_diary migration." : "Agent diary migration dry run."
  )
  lines.push(
    `Found ${result.total} live source=agent_diary memor${result.total === 1 ? "y" : "ies"}.`
  )
  lines.push(
    `${applying ? "Rejected" : "Would reject"} ${result.rejectNullKind.length} null-kind narration row${result.rejectNullKind.length === 1 ? "" : "s"} by setting Status to rejected.`
  )
  if (result.alreadyRejectedNullKind.length > 0) {
    lines.push(
      `${result.alreadyRejectedNullKind.length} null-kind narration row${result.alreadyRejectedNullKind.length === 1 ? " is" : "s are"} already rejected.`
    )
  }
  lines.push(
    `${applying ? "Re-sourced" : "Would re-source"} ${result.resourceNotes.length} note row${result.resourceNotes.length === 1 ? "" : "s"} to source=conversation.`
  )
  if (result.manualReview.length > 0) {
    lines.push(
      `${result.manualReview.length} source=agent_diary row${result.manualReview.length === 1 ? " needs" : "s need"} manual review because Kind is neither empty nor note.`
    )
  }
  if (applying) {
    lines.push(
      `Applied writes: rejected=${result.applied.rejected}, resourced=${result.applied.resourced}, failed=${result.applied.failures.length}.`
    )
  } else {
    lines.push("No changes written. Re-run with --apply after reviewing the samples.")
  }

  appendSample(lines, "Sample null-kind rows to reject", result.samples.rejectNullKind)
  appendSample(
    lines,
    "Sample already rejected null-kind rows",
    result.samples.alreadyRejectedNullKind
  )
  appendSample(lines, "Sample note rows to re-source", result.samples.resourceNotes)
  appendSample(lines, "Sample rows needing manual review", result.samples.manualReview)

  if (result.applied.failures.length > 0) {
    lines.push("Failed updates:")
    for (const failure of result.applied.failures) {
      lines.push(
        `  - ${failure.title} (${failure.id}, action=${failure.action}): ${failure.message}`
      )
    }
  }

  return lines
}

function appendSample(
  lines: string[],
  label: string,
  rows: AgentDiaryMigrationRow[]
): void {
  if (rows.length === 0) return
  lines.push(`${label}:`)
  for (const row of rows) {
    lines.push(
      `  - ${row.title} (${row.id}, kind=${row.kind ?? "null"}, status=${row.status ?? "null"})`
    )
  }
}
