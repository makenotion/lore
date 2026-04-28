/**
 * Context resolution — figure out which project we're in based on cwd.
 *
 * When a developer runs Lore from within a monorepo, we match their
 * current working directory against the project paths in .lore.yaml
 * to auto-select the right project scope.
 */

import { resolve, relative } from "node:path"
import type { LoreConfig, Project, ProjectConfig } from "../types.js"
import type { ProjectService } from "./project.js"

/**
 * True when a project entry is configured as the monorepo catch-all — i.e.,
 * its path matches any cwd within the config root. These entries are the
 * last-resort fallback when no sub-project prefix matches.
 */
export function isCatchAllProject(project: ProjectConfig): boolean {
  const normalized = project.path === "." ? "" : project.path.replace(/^\//, "")
  return normalized === ""
}

/**
 * Names of the non-catch-all projects in the config, in declaration order.
 * Used by callers that want to disambiguate when resolution fell back to a
 * catch-all so they can surface candidate sub-projects to the user or agent.
 */
export function subProjectNames(config: LoreConfig): string[] {
  return (config.projects ?? []).filter((p) => !isCatchAllProject(p)).map((p) => p.name)
}

/**
 * Name of the catch-all project in the config, if any. Projects with path
 * `"."` or `""` match every cwd inside the config root, which makes them a
 * silent default unless callers know to warn.
 */
export function catchAllProjectName(config: LoreConfig): string | null {
  const catchAll = (config.projects ?? []).find(isCatchAllProject)
  return catchAll?.name ?? null
}

/**
 * Shared lead-in for the catch-all-scope warning, used by every surface
 * that needs to tell an operator "you're scoped to the catch-all because
 * no sub-project prefix matched, here are the alternatives." The save
 * tools (`src/mcp/resolve.ts`) and the read tools' framing block
 * (`src/core/project-context.ts`) call this so the wording and the
 * sub-project list stay byte-identical across surfaces — operators see
 * one consistent message regardless of which path triggered it.
 *
 * Per-surface call-to-action tails (save: "pass projectName or
 * projectNames on future calls"; read: "pass projectName to scope to a
 * specific sub-project") are appended by the caller because the read
 * tools don't accept `projectNames`. The shared template stops at the
 * sentence break so the divergent CTAs read as natural continuations.
 */
export function formatCatchAllScopeSummary(name: string, candidates: string[]): string {
  return (
    `Scoped to catch-all "${name}" (monorepo-wide). ` +
    `Sub-projects available: ${candidates.join(", ")}.`
  )
}

/**
 * Pure-filesystem variant of `resolveProject` that returns the configured
 * project *entry* (name + path) a cwd would resolve to, without the Notion
 * round-trip. Used by hot-path hooks that want to scope a cheap per-project
 * side effect (e.g., the Stop-triggered digest debounce marker) before
 * paying for full service initialization.
 *
 * Returns `null` when the cwd sits outside the config root, no projects are
 * configured, or only a catch-all would match — the caller then skips rather
 * than firing an ambiguously-scoped action.
 */
export function resolveProjectPathFromCwd(
  cwd: string,
  configRoot: string,
  config: LoreConfig,
): { name: string; path: string } | null {
  if (!config.projects?.length) return null

  const relPath = relative(resolve(configRoot), resolve(cwd))
  if (relPath.startsWith("..")) return null

  let bestMatch: ProjectConfig | null = null
  let bestLength = -1

  for (const project of config.projects) {
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

  if (!bestMatch || isCatchAllProject(bestMatch)) return null
  return { name: bestMatch.name, path: bestMatch.path }
}

export interface ProjectResolution {
  /** The resolved project, or null if no config projects matched. */
  project: Project | null
  /**
   * True when the winning match was a catch-all entry (path `"."` or `""`).
   * Callers that care about scope accuracy (e.g., save tools in a monorepo)
   * should surface a warning so the agent can narrow the scope explicitly.
   */
  isCatchAllFallback: boolean
  /** Non-catch-all project names from the config, useful for error messages. */
  candidates: string[]
}

/**
 * Resolve the current project based on the working directory and config.
 *
 * Matching logic:
 * 1. Compute the relative path from the config root to cwd.
 * 2. Find the project whose path is the longest prefix of the relative path.
 * 3. Catch-all projects (path `"."` or `""`) match everything with length 0,
 *    so any sub-project prefix wins over them.
 * 4. If no match, return `{ project: null }` (vault-wide scope).
 */
export async function resolveProject(
  cwd: string,
  configRoot: string,
  config: LoreConfig,
  projectService: ProjectService,
): Promise<ProjectResolution> {
  const candidates = subProjectNames(config)

  if (!config.projects?.length) {
    return { project: null, isCatchAllFallback: false, candidates }
  }

  const relPath = relative(resolve(configRoot), resolve(cwd))

  // Don't match if cwd is outside the config root
  if (relPath.startsWith("..")) {
    return { project: null, isCatchAllFallback: false, candidates }
  }

  // Find the best matching project by longest prefix
  let bestMatch: ProjectConfig | null = null
  let bestLength = -1

  for (const project of config.projects) {
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

  if (!bestMatch) {
    return { project: null, isCatchAllFallback: false, candidates }
  }

  const isCatchAllFallback = isCatchAllProject(bestMatch)

  // Look up the project in Notion by name or path
  const byPath = await projectService.findByPath(bestMatch.path)
  const project = byPath ?? (await projectService.findByName(bestMatch.name))

  return { project, isCatchAllFallback, candidates }
}
