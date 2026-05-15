import type { LoreServices } from "../../../services.js"
import {
  buildEntities,
  type EntityMigrationResult,
} from "../../../core/entity-migration.js"
import {
  releaseMigrationLock,
  tryAcquireMigrationLock,
  type MigrationLock,
} from "../../migration-lock.js"

/**
 * Drive `--build-entities`. Plan-only by default; `--yes` flips to
 * apply. Mirrors the structure of `runFactEncodingFix` and friends so
 * the operator-facing language is consistent across the encoding /
 * task / entity migration family.
 *
 * Requires the standard five-database vault shape. `initServices` performs
 * that verification before this function runs, so this pass only
 * canonicalizes existing Fact rows.
 */
export async function runBuildEntitiesMigration(
  services: LoreServices,
  options: {
    apply: boolean
    dryRun?: boolean
    lock?: MigrationLock
    projectId?: string
  }
): Promise<EntityMigrationResult | null> {
  const ownsLock = options.lock === undefined
  const lock = options.lock ?? acquireBuildEntitiesMigrationLock(services, options)
  try {
    const planOnly = !options.apply
    const result = await buildEntities(services.facts, services.entities, {
      apply: options.apply,
      dryRun: options.dryRun,
      projectId: options.projectId,
    })

    if (result.plans.length === 0) {
      console.log("\nNo fact subjects/objects found — nothing to canonicalize.")
      return result
    }

    const verb = planOnly ? "Would canonicalize" : "Canonicalized"
    const newRows = result.entitiesCreated
    const aliasRows = result.aliasesAdded
    console.log(
      `\n${verb} ${result.plans.length} entity group${result.plans.length === 1 ? "" : "s"} ` +
        `(${planOnly ? "would create" : "created"} ${newRows} new entit${newRows === 1 ? "y" : "ies"}, ` +
        `${planOnly ? "would extend" : "extended"} ${aliasRows} alias${aliasRows === 1 ? "" : "es"} on existing rows; ` +
        `${planOnly ? "would fill" : "filled"} ${result.factsRepointed} fact row${result.factsRepointed === 1 ? "" : "s"} with empty entity relations).`
    )

    // Preview — surface the largest collapses first so the operator can
    // sanity-check the canonical/alias picks. Cap at 15 so a vault with
    // hundreds of groups doesn't flood the terminal.
    const PREVIEW_LIMIT = 15
    for (const plan of result.plans.slice(0, PREVIEW_LIMIT)) {
      const status = plan.existing ? " (existing)" : " (new)"
      const aliasPreview =
        plan.aliases.length === 0
          ? ""
          : `\n    aliases: ${plan.aliases
              .slice(0, 5)
              .map((a) => `"${a}"`)
              .join(
                ", "
              )}${plan.aliases.length > 5 ? `, …${plan.aliases.length - 5} more` : ""}`
      console.log(
        `  "${plan.canonical}"${status} — ${plan.factCount} fact${plan.factCount === 1 ? "" : "s"}${aliasPreview}`
      )
    }
    if (result.plans.length > PREVIEW_LIMIT) {
      console.log(`  … and ${result.plans.length - PREVIEW_LIMIT} more groups.`)
    }

    if (result.errors.length > 0) {
      console.log(
        `\nFailed on ${result.errors.length} item${result.errors.length === 1 ? "" : "s"}:`
      )
      for (const e of result.errors.slice(0, PREVIEW_LIMIT)) {
        const where = e.factId ? `fact ${e.factId}` : `entity "${e.entityKey ?? "?"}"`
        console.log(`  ${where}: ${e.message}`)
      }
      if (result.errors.length > PREVIEW_LIMIT) {
        console.log(`  … and ${result.errors.length - PREVIEW_LIMIT} more failures.`)
      }
    }

    if (planOnly) {
      console.log(
        "\nPlan only — no changes written. Re-run with `--yes` to create entity rows and fill empty fact relations."
      )
    }

    return result
  } finally {
    if (ownsLock && lock) releaseMigrationLock(lock)
  }
}

export function acquireBuildEntitiesMigrationLock(
  services: LoreServices,
  options: { apply: boolean; dryRun?: boolean }
): MigrationLock | null {
  if (!options.apply || options.dryRun === true) return null

  const result = tryAcquireMigrationLock({
    name: "build-entities",
    configRoot: services.configRoot,
    vaultPageId: services.config.vault.pageId,
  })
  if (result.acquired) return result.lock

  const owner = result.ownerPid ? `PID ${result.ownerPid}` : "an unknown process"
  throw new Error(
    "Another build-entities migration is already active for this vault " +
      `(${owner}). Wait for it to finish, then retry. If the process is no ` +
      `longer running or this lock is clearly stale, clear it with ` +
      `\`rm ${result.path}\`.`
  )
}
