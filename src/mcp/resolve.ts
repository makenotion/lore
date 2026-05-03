/**
 * Shared project resolution for MCP tools.
 */

import type { LoreServices } from "../services.js"
import { formatCatchAllScopeSummary, subProjectNames } from "../core/context.js"
import {
  formatUnresolvedProjectScopeError,
  validateExplicitProjectScopeName,
  validateExplicitProjectScopeNames,
} from "../core/project-scope.js"
import type { Project } from "../types.js"

export interface ResolvedProjects {
  ids: string[]
  warnings: string[]
}

export interface ResolvedReadProjectScope {
  projectId?: string
  project: Project | null
  isCatchAllFallback: boolean
}

/**
 * Resolve project name(s) to IDs. Supports both singular and plural inputs.
 * When neither is provided, falls back to the auto-detected context project.
 *
 * Explicit names are strict: every name must resolve before callers perform
 * reads or writes scoped by the result.
 *
 * When the auto-detected project was a monorepo catch-all, a warning is
 * attached so the agent can re-scope the memory if the work actually
 * belonged to a specific sub-project. Explicitly-named projects never
 * trigger the catch-all warning — if the agent picked, we trust the pick.
 */
export async function resolveProjectIds(
  services: LoreServices,
  projectName?: string,
  projectNames?: string[]
): Promise<ResolvedProjects> {
  // Plural takes precedence over singular
  const scopeErrorOptions = {
    listHint: "call `lore-project action='list'` to see configured projects",
  }
  const names: readonly string[] =
    projectNames !== undefined
      ? validateExplicitProjectScopeNames(
          projectNames,
          "projectName/projectNames",
          scopeErrorOptions
        )!
      : projectName !== undefined
        ? [
            validateExplicitProjectScopeName(
              projectName,
              "projectName/projectNames",
              scopeErrorOptions
            )!,
          ]
        : []

  if (names.length > 0) {
    const resolved = await Promise.all(
      names.map(async (name) => ({
        name,
        project: await services.projects.findByName(name),
      }))
    )
    const missing = resolved.filter((entry) => !entry.project).map((entry) => entry.name)
    if (missing.length > 0) {
      throw new Error(
        formatUnresolvedProjectScopeError(
          missing,
          "projectName/projectNames",
          scopeErrorOptions
        )
      )
    }
    return {
      ids: resolved.flatMap((entry) => (entry.project ? [entry.project.id] : [])),
      warnings: [],
    }
  }

  // Fall back to auto-detected project
  const { project, isCatchAllFallback } = services.context
  const warnings: string[] = []

  if (project && isCatchAllFallback) {
    const candidates = subProjectNames(services.config)
    if (candidates.length > 0) {
      warnings.push(
        `${formatCatchAllScopeSummary(project.name, candidates)} ` +
          `If this belongs to a specific sub-project, pass projectName or projectNames on future calls.`
      )
    }
  }

  return {
    ids: project ? [project.id] : [],
    warnings,
  }
}

export async function resolveReadProjectScope(
  services: LoreServices,
  projectName?: string
): Promise<ResolvedReadProjectScope> {
  // Deliberately singular today: read tools only expose `projectName`.
  // If a read tool gains plural `projectNames`, keep the same all-or-
  // nothing semantics as `resolveProjectIds` instead of accepting partial
  // matches.
  const explicitProjectName = validateExplicitProjectScopeName(
    projectName,
    "projectName",
    {
      listHint: "call `lore-project action='list'` to see configured projects",
    }
  )
  if (explicitProjectName !== undefined) {
    const project = await services.projects.findByName(explicitProjectName)
    if (!project) {
      throw new Error(
        formatUnresolvedProjectScopeError([explicitProjectName], "projectName", {
          listHint: "call `lore-project action='list'` to see configured projects",
        })
      )
    }
    return {
      projectId: project.id,
      project,
      isCatchAllFallback: false,
    }
  }

  const project = services.context.project
  return {
    projectId: project?.id,
    project,
    isCatchAllFallback: services.context.isCatchAllFallback ?? false,
  }
}
