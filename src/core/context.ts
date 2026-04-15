/**
 * Context resolution — figure out which project we're in based on cwd.
 *
 * When a developer runs Lore from within a monorepo, we match their
 * current working directory against the project paths in .lore.yaml
 * to auto-select the right project scope.
 */

import { resolve, relative } from "node:path"
import type { LoreConfig, Project } from "../types.js"
import type { ProjectService } from "./project.js"

/**
 * Resolve the current project based on the working directory and config.
 *
 * Matching logic:
 * 1. Compute the relative path from the config root to cwd
 * 2. Find the project whose path is the longest prefix of the relative path
 * 3. If no match, return null (vault-wide scope)
 */
export async function resolveProject(
  cwd: string,
  configRoot: string,
  config: LoreConfig,
  projectService: ProjectService
): Promise<Project | null> {
  if (!config.projects?.length) return null

  const relPath = relative(resolve(configRoot), resolve(cwd))

  // Don't match if cwd is outside the config root
  if (relPath.startsWith("..")) return null

  // Find the best matching project by longest prefix
  let bestMatch: { name: string; path: string } | null = null
  let bestLength = -1

  for (const project of config.projects) {
    // Normalize: "." and "" both mean the root
    const projectPath = project.path === "." ? "" : project.path.replace(/^\//, "")
    if (
      relPath === projectPath ||
      relPath.startsWith(projectPath + "/") ||
      projectPath === ""
    ) {
      if (projectPath.length > bestLength) {
        bestMatch = project
        bestLength = projectPath.length
      }
    }
  }

  if (!bestMatch) return null

  // Look up the project in Notion by name or path
  const byPath = await projectService.findByPath(bestMatch.path)
  if (byPath) return byPath

  const byName = await projectService.findByName(bestMatch.name)
  return byName
}
