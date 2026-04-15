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
import { resolveProject } from "./core/context.js"
import type { LoreConfig, ResolvedContext } from "./types.js"

export interface LoreServices {
  vault: VaultManager
  projects: ProjectService
  topics: TopicService
  memories: MemoryService
  facts: FactService
  context: ResolvedContext
  config: LoreConfig
  configRoot: string
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
  const auth = await resolveAuth(config)
  const client = createClient(auth.token, auth.baseUrl)

  const vault = new VaultManager(client, config.vault.pageId)
  await vault.load()

  const db = vault.databases
  const projects = new ProjectService(client, db.projects)
  const topics = new TopicService(client, db.topics)
  const memories = new MemoryService(client, db.memories)
  const facts = new FactService(client, db.facts)

  const project = await resolveProject(workDir, found.root, config, projects)

  return {
    vault,
    projects,
    topics,
    memories,
    facts,
    context: {
      vault: vault.get(),
      project,
      cwd: workDir,
    },
    config,
    configRoot: found.root,
  }
}
