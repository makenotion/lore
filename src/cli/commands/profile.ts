import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { Command } from "commander"
import { findConfigFile, loadConfig } from "../../config.js"
import { initServices } from "../../services.js"
import {
  PROFILE_PROMPT_KEYS,
  ProfileLoadError,
  discoverProfiles,
  isProfileBundleRoot,
  loadProfileFromRoot,
  parseProfileSelector,
  resolveProfileFromConfigAtRoot,
  resolveProfileSelector,
  type DiscoveredProfile,
  type ProfileSource,
  type ResolvedProfile,
} from "../../profile/index.js"
import {
  ProfileInstallError,
  applyInstall,
  findAllowedInstallSourceMatch,
  findLockNoOpReinstall,
  listBundleFiles,
  parseInstallSource,
  previewInstall,
  readProfilesLock,
  type InstallPreview,
} from "../../profile/install.js"
import {
  ProfileMigrationError,
  applyMigrationPlan,
  buildMigrationPlan,
  defaultConfigPath,
  listProfileMigrations,
  rewriteConfigProfilePin,
  summarizeProfile,
  validateProfileBundle,
} from "../../profile/migrate.js"
import {
  releaseMigrationLock,
  tryAcquireMigrationLock,
  type MigrationLock,
} from "../migration-lock.js"

export const profileCommand = new Command("profile").description(
  "Manage Lore profiles: list / show / validate / preview / install / set / migrate."
)

profileCommand
  .command("list")
  .description("List active and available profiles with source and shadowing info.")
  .action(async () => {
    try {
      const services = await initServices()
      const discoveries = discoverProfiles(services.configRoot)
      const active = services.profile
      console.log(`Active profile: ${active.selector} (${active.source})`)
      console.log(`Config root:    ${services.configRoot}`)
      console.log("")
      printDiscoveryTable(discoveries, active)
    } catch (err) {
      console.error(
        "Profile list failed:",
        err instanceof Error ? err.message : String(err)
      )
      process.exit(1)
      return
    }
  })

profileCommand
  .command("show <selector>")
  .description("Print manifest details for a built-in / local / installed profile.")
  .action(async (selectorArg: string) => {
    try {
      const services = await initServices()
      const profile = resolveByArgOrBare(services.configRoot, selectorArg)
      const summary = summarizeProfile(profile)
      printProfileSummary(summary)
    } catch (err) {
      console.error(
        "Profile show failed:",
        err instanceof Error ? err.message : String(err)
      )
      process.exit(1)
      return
    }
  })

profileCommand
  .command("validate <path>")
  .description(
    "Validate a profile bundle root containing profile.yaml. Exits non-zero on any error."
  )
  .action(async (pathArg: string) => {
    try {
      const path = resolve(pathArg)
      if (!existsSync(path)) {
        console.error(`Profile validate failed: ${path} does not exist.`)
        process.exit(1)
        return
      }
      if (!isProfileBundleRoot(path)) {
        console.error(
          `Profile validate failed: ${path} is not a profile bundle root (no profile.yaml).`
        )
        process.exit(1)
        return
      }
      const profile = validateProfileBundle(path)
      console.log(`Profile bundle at ${profile.rootDir} is valid.`)
      console.log(`Selector:       ${profile.selector}`)
      console.log(`Manifest digest: ${profile.manifestDigest}`)
      console.log(`Tags:           ${profile.taxonomy.tags.length}`)
      console.log(`Entity kinds:   ${profile.taxonomy.entityKinds.length}`)
      console.log(
        `Writable preds: ${profile.taxonomy.writableFactPredicates.length}`
      )
      const migrations = listProfileMigrations(profile.rootDir)
      console.log(`Migrations:     ${migrations.length}`)
    } catch (err) {
      console.error(
        "Profile validate failed:",
        err instanceof Error ? err.message : String(err)
      )
      process.exit(1)
      return
    }
  })

profileCommand
  .command("preview <selector>")
  .description("Print the effective profile that would resolve for this config.")
  .action(async (selectorArg: string) => {
    try {
      const services = await initServices()
      const profile = resolveByArgOrBare(services.configRoot, selectorArg)
      const summary = summarizeProfile(profile)
      console.log(
        `Preview: ${summary.selector} would resolve from ${summary.source} (${summary.rootDir}).`
      )
      console.log(`Manifest digest: ${summary.manifestDigest}`)
      console.log("`profile.yaml extends` was rejected: built-in validator enforces #577.")
      console.log("Schema additions:")
      for (const [db, count] of Object.entries(summary.schemaAdditions)) {
        console.log(`  - ${db}: ${count}`)
      }
      console.log(
        `Taxonomy: ${summary.tags} tags, ${summary.entityKinds} entity kinds, ${summary.writableFactPredicates} writable predicates`
      )
      console.log(
        `Prompt keys: ${summary.prompts.length}/${PROFILE_PROMPT_KEYS.length} provided`
      )
      console.log("  " + summary.prompts.join(", "))
      console.log(`Eval suites: ${summary.evalSuites.length}`)
      if (summary.evalSuites.length > 0) {
        console.log("  " + summary.evalSuites.join(", "))
      }
    } catch (err) {
      console.error(
        "Profile preview failed:",
        err instanceof Error ? err.message : String(err)
      )
      process.exit(1)
      return
    }
  })

profileCommand
  .command("install <source>")
  .description(
    "Install a profile bundle from a local path or git URL pinned to a 40-hex commit SHA."
  )
  .option(
    "-y, --yes",
    "Non-interactive install. Requires an exact allowedInstallSources entry in .lore.yaml or a same-digest lock no-op."
  )
  .action(async (sourceArg: string, opts: { yes?: boolean }) => {
    let preview: InstallPreview | null = null
    try {
      const found = await findConfigFile(process.cwd())
      if (!found) {
        console.error(
          "Profile install failed: no .lore.yaml found. Run `lore init` first."
        )
        process.exit(1)
        return
      }
      const config = await loadConfig(found.path)
      const source = parseInstallSource(sourceArg, process.cwd())
      preview = previewInstall({
        configRoot: found.root,
        source,
      })
      const lockNoOp = findLockNoOpReinstall(found.root, preview)
      const allowMatch = findAllowedInstallSourceMatch(
        preview,
        config.profiles?.allowedInstallSources,
        found.root
      )
      printInstallSummary(preview, allowMatch !== null, lockNoOp !== null)
      if (opts.yes) {
        if (!allowMatch && !lockNoOp) {
          console.error(
            "Profile install failed: --yes requires either an entry under profiles.allowedInstallSources matching this source+digest, or a same-digest lock no-op reinstall. Run interactively (without --yes) to print the digest and add an allow-list entry."
          )
          process.exit(1)
          return
        }
      } else {
        const confirmed = await confirmInstall(preview)
        if (!confirmed) {
          console.log("Aborted; nothing installed.")
          return
        }
      }
      const result = applyInstall(preview, found.root)
      preview = null
      if (result.outcome === "already-installed") {
        console.log(
          `Already installed: ${result.entry.name}@${result.entry.version} at ${result.installTarget}.`
        )
      } else {
        console.log(
          `Installed ${result.entry.name}@${result.entry.version} to ${result.installTarget}.`
        )
      }
    } catch (err) {
      preview?.cleanup()
      console.error(
        "Profile install failed:",
        err instanceof Error ? err.message : String(err)
      )
      process.exit(1)
      return
    }
  })

profileCommand
  .command("set <selector>")
  .description("Pin `.lore.yaml profile:` to an exact <name>@<version> selector.")
  .action(async (selectorArg: string) => {
    try {
      const parsed = parseProfileSelector(selectorArg)
      const found = await findConfigFile(process.cwd())
      if (!found) {
        console.error(
          "Profile set failed: no .lore.yaml found. Run `lore init` first."
        )
        process.exit(1)
        return
      }
      const resolution = resolveProfileSelector(parsed, found.root)
      if (!resolution) {
        console.error(
          `Profile set failed: ${parsed.selector} is not resolvable under built-in, local, or installed profiles. Install it first with \`lore profile install\`.`
        )
        process.exit(1)
        return
      }
      loadProfileFromRoot(resolution.rootDir, {
        source: resolution.source,
        selector: parsed.selector,
      })
      rewriteConfigProfilePin(found.path, parsed.selector)
      console.log(`Pinned ${found.path} profile to ${parsed.selector}.`)
    } catch (err) {
      console.error(
        "Profile set failed:",
        err instanceof Error ? err.message : String(err)
      )
      process.exit(1)
      return
    }
  })

profileCommand
  .command("migrate <selector>")
  .description(
    "Plan or apply a profile migration. Dry-run by default; pass --apply after reviewing the plan."
  )
  .option("--from <selector>", "Source selector; defaults to the currently pinned profile.")
  .option("--apply", "Apply the migration after planning. Requires the migration lock.")
  .action(
    async (
      targetSelectorArg: string,
      opts: { from?: string; apply?: boolean }
    ) => {
      let lock: MigrationLock | null = null
      try {
        const services = await initServices()
        const fromSelector = opts.from ?? services.profile.selector
        const targetSelector = targetSelectorArg
        const plan = await buildMigrationPlan({
          services,
          sourceSelector: fromSelector,
          targetSelector,
        })
        printMigrationPlan(plan)
        if (!opts.apply) {
          console.log("\nDry-run only; pass --apply to execute.")
          return
        }
        const acquire = tryAcquireMigrationLock({
          name: `profile.${plan.document.profile}`,
          configRoot: services.configRoot,
          vaultPageId: services.config.vault.pageId,
        })
        if (!acquire.acquired) {
          console.error(
            `Profile migrate failed: migration lock held by pid ${
              acquire.ownerPid ?? "<unknown>"
            } at ${acquire.path}.`
          )
          process.exit(1)
          return
        }
        lock = acquire.lock
        const result = await applyMigrationPlan(services, plan, {
          configPath: defaultConfigPath(services.configRoot),
        })
        console.log(
          `\nApplied ${result.appliedStepIds.length} step(s); skipped ${result.skippedStepIds.length}.`
        )
        console.log(`Ledger written to ${result.plan.ledgerPath}.`)
      } catch (err) {
        console.error(
          "Profile migrate failed:",
          err instanceof Error ? err.message : String(err)
        )
        process.exit(1)
        return
      } finally {
        if (lock) releaseMigrationLock(lock)
      }
    }
  )

function printDiscoveryTable(
  discoveries: DiscoveredProfile[],
  active: ResolvedProfile
): void {
  if (discoveries.length === 0) {
    console.log("No profiles discovered.")
    return
  }
  const grouped = new Map<string, DiscoveredProfile[]>()
  for (const d of discoveries) {
    const key = `${d.name}@${d.version}`
    const existing = grouped.get(key) ?? []
    existing.push(d)
    grouped.set(key, existing)
  }
  const priority: Record<ProfileSource, number> = {
    local: 0,
    "built-in": 1,
    external: 2,
  }
  console.log("Profile                       Source     Path")
  console.log("------------------------------------------------------------------")
  const keys = [...grouped.keys()].sort()
  for (const key of keys) {
    const variants = grouped.get(key)!.sort(
      (a, b) => priority[a.source] - priority[b.source]
    )
    for (let i = 0; i < variants.length; i += 1) {
      const variant = variants[i]!
      const isActive = variant.rootDir === active.rootDir && active.selector === key
      const marker = isActive ? "*" : i === 0 ? " " : "↳"
      const shadowed = i > 0 ? " (shadowed)" : ""
      console.log(
        `${marker} ${key.padEnd(28)} ${variant.source.padEnd(10)} ${variant.rootDir}${shadowed}`
      )
    }
  }
  console.log("")
  console.log("* = active profile, ↳ = shadowed by higher-priority resolution.")
}

function resolveByArgOrBare(configRoot: string, selectorArg: string): ResolvedProfile {
  if (selectorArg.includes("@")) {
    return resolveProfileFromConfigAtRoot({ profile: selectorArg }, configRoot)
  }
  const discoveries = discoverProfiles(configRoot).filter(
    (d) => d.name === selectorArg
  )
  if (discoveries.length === 0) {
    throw new ProfileLoadError(`profile not found: ${selectorArg}`)
  }
  const versions = new Set(discoveries.map((d) => d.version))
  if (versions.size > 1) {
    const choices = [...versions]
      .sort()
      .map((v) => `${selectorArg}@${v}`)
      .join(", ")
    throw new ProfileLoadError(
      `profile ${selectorArg} resolves to multiple versions. Pick one: ${choices}.`
    )
  }
  const [version] = versions
  return resolveProfileFromConfigAtRoot(
    { profile: `${selectorArg}@${version}` },
    configRoot
  )
}

function printProfileSummary(summary: ReturnType<typeof summarizeProfile>): void {
  console.log(`Profile:        ${summary.selector}`)
  console.log(`Source:         ${summary.source}`)
  console.log(`Root:           ${summary.rootDir}`)
  console.log(`Manifest digest:${summary.manifestDigest}`)
  console.log("Schema additions:")
  for (const [db, count] of Object.entries(summary.schemaAdditions)) {
    console.log(`  - ${db}: ${count}`)
  }
  console.log(
    `Taxonomy: ${summary.tags} tags, ${summary.entityKinds} entity kinds, ${summary.writableFactPredicates} writable predicates`
  )
  console.log(`Prompts:  ${summary.prompts.join(", ")}`)
  console.log(`Eval suites: ${summary.evalSuites.length}`)
  for (const suite of summary.evalSuites) {
    console.log(`  - ${suite}`)
  }
  console.log(`Migrations: ${summary.migrations.length}`)
  for (const m of summary.migrations) {
    console.log(`  - ${m.from} → ${m.to} (${m.path})`)
  }
}

function printInstallSummary(
  preview: InstallPreview,
  allowMatch: boolean,
  lockNoOp: boolean
): void {
  console.log("Profile install preview")
  console.log("-----------------------------------------------")
  console.log(`Name:           ${preview.profile.name}`)
  console.log(`Version:        ${preview.profile.version}`)
  console.log(
    `Source:         ${
      preview.source.kind === "git"
        ? `${preview.source.url}#${preview.source.commit}`
        : preview.source.path
    }`
  )
  console.log(`Manifest digest: ${preview.manifestDigest}`)
  console.log(`Install target:  ${preview.installTarget}`)
  switch (preview.collision.kind) {
    case "none":
      console.log("Collision:       none")
      break
    case "same-digest":
      console.log("Collision:       same-digest no-op (install will only refresh the lock)")
      break
    case "different-digest":
      console.log(
        `Collision:       DIFFERENT digest (${preview.collision.existingDigest}) — refusing to install`
      )
      break
  }
  switch (preview.shadowing.kind) {
    case "none":
      console.log("Shadowing:       none")
      break
    case "local-shadow":
      console.log(
        `Shadowing:       local profile at ${preview.shadowing.localDir} (${
          preview.shadowing.sameDigest ? "same digest" : "DIFFERENT digest"
        })`
      )
      break
    case "built-in-shadow":
      console.log(
        `Shadowing:       built-in profile at ${preview.shadowing.builtInDir} (${
          preview.shadowing.sameDigest ? "same digest" : "DIFFERENT digest"
        })`
      )
      break
  }
  const schema = preview.profile.schema
  console.log("Schema additions:")
  for (const key of Object.keys(schema)) {
    const count = Object.keys(schema[key as keyof typeof schema]).length
    console.log(`  - ${key}: ${count}`)
  }
  console.log(
    `Taxonomy: ${preview.profile.taxonomy.tags.length} tags, ${preview.profile.taxonomy.entityKinds.length} entity kinds, ${preview.profile.taxonomy.writableFactPredicates.length} writable predicates`
  )
  const includedPromptKeys = Object.values(preview.profile.prompts)
    .filter((prompt) => prompt.source === "active-profile")
    .map((prompt) => prompt.key)
  console.log(
    `Prompt keys:     ${
      includedPromptKeys.length > 0 ? includedPromptKeys.join(", ") : "(none)"
    }`
  )
  console.log(
    `Eval suites:     ${
      preview.profile.evalSuites.length > 0
        ? preview.profile.evalSuites.join(", ")
        : "(none)"
    }`
  )
  const migrations = listProfileMigrations(preview.profile.rootDir)
  console.log(
    `Migrations:      ${
      migrations.length > 0
        ? migrations.map((m) => `${m.from}→${m.to}`).join(", ")
        : "(none)"
    }`
  )
  console.log(`Files (${listBundleFiles(preview.bundleRoot).length}):`)
  for (const file of listBundleFiles(preview.bundleRoot).slice(0, 20)) {
    console.log(`  - ${file}`)
  }
  console.log("")
  console.log(
    "Warning: profile prompts directly influence what agents save to Notion. Review the source before installing."
  )
  if (allowMatch) {
    console.log("Allow-list match: yes (CI/automation may proceed with --yes).")
  } else if (lockNoOp) {
    console.log("Lock no-op: identical install already recorded; --yes will refresh the lock.")
  } else {
    console.log("Allow-list match: no — add to profiles.allowedInstallSources for non-interactive installs.")
  }
}

async function confirmInstall(preview: InstallPreview): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "Interactive confirmation requires a TTY. Re-run with --yes after adding an allowedInstallSources entry, or run interactively."
    )
    return false
  }
  process.stdout.write(
    `\nInstall ${preview.profile.name}@${preview.profile.version}? [y/N] `
  )
  const answer: string = await new Promise((res) => {
    const chunks: Buffer[] = []
    process.stdin.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk))
      const buffered = Buffer.concat(chunks).toString("utf-8")
      if (buffered.includes("\n")) {
        res(buffered.trim())
      }
    })
  })
  return /^y(es)?$/i.test(answer)
}

function printMigrationPlan(
  plan: Awaited<ReturnType<typeof buildMigrationPlan>>
): void {
  console.log(`Migration plan: ${plan.sourceSelector} → ${plan.targetSelector}`)
  console.log(`Source root: ${plan.sourceRoot}`)
  console.log(`Target root: ${plan.targetRoot ?? "(target not installed)"}`)
  console.log(`Migration file: ${plan.migrationPath}`)
  console.log(`Ledger path: ${plan.ledgerPath}`)
  console.log("")
  console.log("Steps:")
  console.log(
    "  id                              kind                          status                       writes"
  )
  console.log(
    "  -------------------------------------------------------------------------------------------------"
  )
  for (const entry of plan.entries) {
    const step = entry.step
    const dbProp =
      "database" in step
        ? ` ${(step as { database: string }).database}.${(step as { property: string }).property}`
        : ""
    const id = step.id.padEnd(30)
    const kind = step.kind.padEnd(28)
    const status = entry.status.padEnd(28)
    console.log(`  ${id} ${kind} ${status} ${entry.estimatedWrites}${dbProp}`)
    if (entry.reason) {
      console.log(`    note: ${entry.reason}`)
    }
  }
  const total = plan.entries.reduce(
    (sum, e) => sum + (e.status === "would-run" ? e.estimatedWrites : 0),
    0
  )
  console.log("")
  console.log(`Estimated Notion writes if applied: ${total}`)
  console.log("Re-run with --apply to execute. The migration lock must be free.")
}

/**
 * Read-only helper used by tests to assert lock-file contents without
 * hitting Notion. Exposed here because tests live alongside the CLI.
 */
export function readProfilesLockForConfig(configRoot: string) {
  return readProfilesLock(configRoot)
}

// Suppress unused-export warnings for the typed error classes that are
// referenced only through `instanceof` checks in callers.
export { ProfileInstallError, ProfileMigrationError }
