import { Command } from "commander"
import { initServices, type LoreServices } from "../../services.js"
import { mergeEntities, type EntityMergeResult } from "../../core/entity-merge.js"
import type { Entity } from "../../types.js"

export interface EntityMergeCliOptions {
  winnerId: string
  loserId: string
  apply: boolean
  dryRun?: boolean
}

export function parseEntityMergeCliOptions(
  positionalWinnerId: string | undefined,
  positionalLoserId: string | undefined,
  raw: { from?: string; into?: string; yes?: boolean; dryRun?: boolean }
):
  | { ok: true; value: EntityMergeCliOptions }
  | { ok: false; message: string } {
  const hasNamed = Boolean(raw.from || raw.into)
  const hasPositional = Boolean(positionalWinnerId || positionalLoserId)

  if (hasNamed && hasPositional) {
    return {
      ok: false,
      message: "Use either --from/--into or positional ids, not both.",
    }
  }

  if (hasNamed) {
    if (!raw.from || !raw.into) {
      return {
        ok: false,
        message: "--from and --into must be passed together.",
      }
    }
    if (raw.from === raw.into) {
      return {
        ok: false,
        message: "--from and --into must differ.",
      }
    }
    return {
      ok: true,
      value: {
        winnerId: raw.into,
        loserId: raw.from,
        apply: Boolean(raw.yes) && !raw.dryRun,
        dryRun: raw.dryRun,
      },
    }
  }

  if (!positionalWinnerId || !positionalLoserId) {
    return {
      ok: false,
      message:
        "Pass --from <loser-id> --into <winner-id> (preferred) or both positional ids.",
    }
  }
  if (positionalWinnerId === positionalLoserId) {
    return {
      ok: false,
      message: "winner-id and loser-id must differ.",
    }
  }

  return {
    ok: true,
    value: {
      winnerId: positionalWinnerId,
      loserId: positionalLoserId,
      apply: Boolean(raw.yes) && !raw.dryRun,
      dryRun: raw.dryRun,
    },
  }
}

export async function runEntityMerge(
  services: LoreServices,
  options: EntityMergeCliOptions
): Promise<EntityMergeResult> {
  if (!services.entities) {
    throw new Error(
      "Entities database is not available. Run `lore migrate --build-entities --yes` first."
    )
  }

  return mergeEntities(services.entities, services.facts, {
    winnerId: options.winnerId,
    loserId: options.loserId,
    apply: options.apply,
    dryRun: options.dryRun,
  })
}

function entityLabel(entity: Entity): string {
  return `"${entity.name}" (${entity.id})`
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

export function formatEntityMergeResult(result: EntityMergeResult): string {
  const lines: string[] = []
  const mode = result.planOnly
    ? "Entity merge plan:"
    : result.errors.length > 0
      ? "Entity merge partially applied:"
      : "Entity merge applied:"

  lines.push(mode)
  lines.push(`  Winner: ${entityLabel(result.winner)}`)
  lines.push(`  Loser: ${entityLabel(result.loser)}`)

  if (result.aliasesToAdd.length > 0) {
    const aliasList = result.aliasesToAdd.map((a) => `"${a}"`).join(", ")
    if (result.planOnly) {
      lines.push(
        `  Would add ${plural(result.aliasesPlanned, "alias", "aliases")}: ` +
          aliasList
      )
    } else if (result.aliasesAdded > 0) {
      lines.push(
        `  Added ${plural(result.aliasesAdded, "alias", "aliases")}: ` +
          aliasList
      )
    } else {
      lines.push(
        `  Aliases not written: ${plural(result.aliasesPlanned, "alias", "aliases")} ` +
          `still pending (${aliasList}).`
      )
    }
  } else {
    lines.push("  No aliases to add.")
  }

  const factVerb = result.planOnly ? "Would re-point" : "Re-pointed"
  lines.push(
    `  ${factVerb} ${plural(result.repoint.factsRepointed, "fact row")} ` +
      `(${plural(result.repoint.subjectRelationsRepointed, "subject relation")}, ` +
      `${plural(result.repoint.objectRelationsRepointed, "object relation")}).`
  )

  if (result.planOnly) {
    lines.push("  Would archive loser entity.")
  } else if (result.loserArchived) {
    lines.push("  Archived loser entity.")
    if (result.postArchiveRepoint && result.postArchiveRepoint.factsMatched > 0) {
      lines.push(
        `  Post-archive scan re-pointed ${plural(
          result.postArchiveRepoint.factsRepointed,
          "late fact row"
        )}.`
      )
    }
  } else {
    lines.push("  Loser entity not archived.")
  }

  if (result.errors.length > 0) {
    lines.push("")
    lines.push(`Failed on ${plural(result.errors.length, "step")}:`)
    for (const error of result.errors) {
      const target = error.factId ? ` fact ${error.factId}` : ""
      lines.push(`  ${error.phase}${target}: ${error.message}`)
    }
  }

  if (result.planOnly) {
    lines.push("")
    lines.push("Plan only -- no changes written. Re-run with `--yes` to apply.")
  } else if (result.errors.length > 0) {
    lines.push("")
    lines.push(
      "Fix the failed step, then re-run the merge command to finish safely. " +
        "Alias and fact retries are idempotent."
    )
  }

  return lines.join("\n")
}

const mergeCommand = new Command("merge")
  .description("Merge a duplicate Entity row into a canonical winner")
  .usage("[options] --from <loser-id> --into <winner-id>")
  .argument("[winner-id]", "Entity row ID to keep (legacy positional form)")
  .argument("[loser-id]", "Duplicate Entity row ID to merge and archive (legacy positional form)")
  .option("--from <loser-id>", "Duplicate Entity row ID to merge and archive")
  .option("--into <winner-id>", "Entity row ID to keep")
  .option("--yes", "Apply the merge. Without this, only print the plan.")
  .option("--dry-run", "Force plan-only mode even when --yes is present.")
  .action(
    async (
      winnerId: string | undefined,
      loserId: string | undefined,
      opts: { from?: string; into?: string; yes?: boolean; dryRun?: boolean }
    ) => {
      try {
        const parsed = parseEntityMergeCliOptions(winnerId, loserId, opts)
        if (!parsed.ok) {
          console.error(`Entity merge failed: ${parsed.message}`)
          process.exitCode = 1
          return
        }
        const services = await initServices(undefined, { driftCheck: true })
        const result = await runEntityMerge(services, parsed.value)
        console.log(formatEntityMergeResult(result))
        if (result.errors.length > 0) process.exitCode = 1
      } catch (err) {
        console.error("Entity merge failed:", err instanceof Error ? err.message : err)
        process.exitCode = 1
      }
    }
  )

export const entitiesCommand = new Command("entities")
  .description("Entity registry operations")
  .addCommand(mergeCommand)
