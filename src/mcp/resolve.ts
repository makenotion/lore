/**
 * Shared project resolution for MCP tools.
 */

import type { LoreServices } from "../services.js"
import { subProjectNames } from "../core/context.js"

export interface ResolvedProjects {
  ids: string[]
  warnings: string[]
}

/**
 * Resolve project name(s) to IDs. Supports both singular and plural inputs.
 * When neither is provided, falls back to the auto-detected context project.
 *
 * Returns warnings for any names that couldn't be resolved so callers
 * can surface them to the user.
 *
 * When the auto-detected project was a monorepo catch-all, a warning is
 * attached so the agent can re-scope the memory if the work actually
 * belonged to a specific sub-project. Explicitly-named projects never
 * trigger the catch-all warning — if the agent picked, we trust the pick.
 */
export async function resolveProjectIds(
  services: LoreServices,
  projectName?: string,
  projectNames?: string[],
): Promise<ResolvedProjects> {
  // Plural takes precedence over singular
  const names = projectNames?.length ? projectNames : projectName ? [projectName] : []

  if (names.length > 0) {
    const ids: string[] = []
    const warnings: string[] = []
    for (const name of names) {
      const found = await services.projects.findByName(name)
      if (found) {
        ids.push(found.id)
      } else {
        warnings.push(`Project "${name}" not found`)
      }
    }
    return { ids, warnings }
  }

  // Fall back to auto-detected project
  const { project, isCatchAllFallback } = services.context
  const warnings: string[] = []

  if (project && isCatchAllFallback) {
    const candidates = subProjectNames(services.config)
    if (candidates.length > 0) {
      warnings.push(
        `Scoped to catch-all "${project.name}" (monorepo-wide). ` +
          `Sub-projects available: ${candidates.join(", ")}. ` +
          `If this belongs to a specific sub-project, pass projectName or projectNames on future calls.`,
      )
    }
  }

  return {
    ids: project ? [project.id] : [],
    warnings,
  }
}
