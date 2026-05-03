import { access } from "node:fs/promises"
import { resolve } from "node:path"
import type { Client } from "@notionhq/client"
import { findConfigFile, loadConfig, resolveAuth } from "../config.js"
import { createClient } from "../notion/client.js"
import { createLimitedClient } from "../notion/rate-limit.js"
import {
  ensureEntitiesDatabase,
  migrateVaultSchema,
  verifyVaultDatabasesForEntityRepair,
  type EnsureEntitiesDatabaseResult,
  type MigrationDiff,
} from "../notion/setup.js"
import type { LoreConfig, Vault } from "../types.js"

export interface ConfiguredVaultClient {
  client: Client
  config: LoreConfig
  configRoot: string
}

export interface EnsureConfiguredEntitiesResult {
  pageId: string
  ensure: EnsureEntitiesDatabaseResult
  diffs: MigrationDiff[]
}

export async function loadConfiguredVaultClient(
  cwd = process.cwd()
): Promise<ConfiguredVaultClient> {
  const rawRoot = process.env["LORE_CONFIG_ROOT"]
  const explicitRoot = rawRoot?.trim() ? rawRoot.trim() : undefined

  let configRoot: string
  let config: LoreConfig
  if (explicitRoot) {
    configRoot = resolve(explicitRoot)
    const configPath = resolve(configRoot, ".lore.yaml")
    try {
      await access(configPath)
    } catch {
      throw new Error(
        `LORE_CONFIG_ROOT=${configRoot} but no .lore.yaml exists there. ` +
          "Re-run `lore install` from the project directory or unset " +
          "LORE_CONFIG_ROOT to fall back to the upward search."
      )
    }
    config = await loadConfig(configPath)
  } else {
    const found = await findConfigFile(cwd)
    if (!found) {
      throw new Error("No .lore.yaml found. Run `lore init` to set up a vault.")
    }
    configRoot = found.root
    config = await loadConfig(found.path)
  }

  const auth = await resolveAuth(config, configRoot)
  const client = createLimitedClient(
    createClient(auth.token, auth.baseUrl),
    config.notion?.rateLimit ?? {}
  )
  return { client, config, configRoot }
}

export async function ensureConfiguredEntitiesDatabase(
  options: { dryRun?: boolean; cwd?: string } = {},
  deps: { loadClient?: (cwd?: string) => Promise<ConfiguredVaultClient> } = {}
): Promise<EnsureConfiguredEntitiesResult> {
  const loadClient = deps.loadClient ?? loadConfiguredVaultClient
  const { client, config } = await loadClient(options.cwd)
  const pageId = config.vault.pageId
  const partialVault = await verifyVaultDatabasesForEntityRepair(client, pageId)
  const ensure = await ensureEntitiesDatabase(client, partialVault, {
    dryRun: options.dryRun,
  })

  if (ensure.status === "would-create") {
    return { pageId, ensure, diffs: [] }
  }

  const vault: Vault = {
    pageId,
    databases: {
      ...partialVault.databases,
      entities: ensure.ref,
    },
  }
  const diffs = await migrateVaultSchema(client, vault, {
    dryRun: options.dryRun,
  })
  return { pageId, ensure, diffs }
}

export function summarizeMigrationDiffs(diffs: MigrationDiff[]): {
  missingProperties: number
  addedOptions: number
  relationConfigs: number
} {
  return {
    missingProperties: diffs.reduce((n, d) => n + d.missing.length, 0),
    addedOptions: diffs.reduce(
      (n, d) => n + d.addedOptions.reduce((m, a) => m + a.options.length, 0),
      0
    ),
    relationConfigs: diffs.reduce((n, d) => n + d.addedRelationConfig.length, 0),
  }
}
