/**
 * Shared project resolution for MCP tools.
 */

import type { LoreServices } from "../services.js"

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
  return {
    ids: services.context.project ? [services.context.project.id] : [],
    warnings: [],
  }
}
