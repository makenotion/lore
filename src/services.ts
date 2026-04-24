/**
 * Shared service initialization.
 *
 * The LoreServices interface and initServices() function are used by both
 * the MCP server and CLI commands. Extracted here to avoid a dependency
 * from CLI → MCP layer.
 */

import { findConfigFile, loadConfig, resolveAuth } from "./config.js"
import { createClient } from "./notion/client.js"
import { VaultManager } from "./core/vault.js"
import { ProjectService } from "./core/project.js"
import { TopicService } from "./core/topic.js"
import { MemoryService } from "./core/memory.js"
import { FactService } from "./core/fact.js"
import { DecisionService } from "./core/decision.js"
import { resolveProject } from "./core/context.js"
import { SessionMemoryTracker } from "./session-memory-tracker.js"
import type { LoreConfig, ResolvedContext } from "./types.js"

export interface LoreServices {
  vault: VaultManager
  projects: ProjectService
  topics: TopicService
  memories: MemoryService
  facts: FactService
  decisions: DecisionService
  context: ResolvedContext
  config: LoreConfig
  configRoot: string
  /**
   * Per-process map of session_id → last-created memory id. MCP save tools
   * record into it; `lore-learn` reads it to auto-link `sourceMemoryId` when
   * the caller omits it. Empty (and unused) in one-shot CLI/hook contexts.
   */
  sessionMemories: SessionMemoryTracker
}

export async function initServicesFromConfig(
  cwd: string,
  configRoot: string,
  config: LoreConfig,
): Promise<LoreServices> {
  const auth = await resolveAuth(config)
  const client = createClient(auth.token, auth.baseUrl)

  const vault = new VaultManager(client, config.vault.pageId)
  await vault.load()

  const db = vault.databases
  const projects = new ProjectService(client, db.projects)
  const topics = new TopicService(client, db.topics)
  const memories = new MemoryService(client, db.memories)
  const facts = new FactService(client, db.facts)
  // Decisions are backed by the Memories DB — same DatabaseRef, different
  // business logic (Kind = decision discriminator, supersession chains,
  // index-tier listings without body fetch).
  const decisions = new DecisionService(client, db.memories)

  const resolution = await resolveProject(cwd, configRoot, config, projects)

  return {
    vault,
    projects,
    topics,
    memories,
    facts,
    decisions,
    context: {
      vault: vault.get(),
      project: resolution.project,
      cwd,
      isCatchAllFallback: resolution.isCatchAllFallback,
    },
    config,
    configRoot,
    sessionMemories: new SessionMemoryTracker(),
  }
}

/**
 * Initialize all services from config. Shared by both MCP server and CLI.
 */
export async function initServices(cwd?: string): Promise<LoreServices> {
  const workDir = cwd ?? process.cwd()

  const found = await findConfigFile(workDir)
  if (!found) {
    throw new Error("No .lore.yaml found. Run `lore init` to set up a vault.")
  }

  const config = await loadConfig(found.path)
  return initServicesFromConfig(workDir, found.root, config)
}

/**
 * Drop every in-process resolver cache attached to `services`. Tests
 * call this to force-fresh reads between fixtures; production code
 * leaves the caches alone and lets TTLs do the work.
 */
export function clearServiceCaches(services: LoreServices): void {
  services.projects.clearNameCache()
  services.topics.clearNameCache()
  services.decisions.clearCache()
}
