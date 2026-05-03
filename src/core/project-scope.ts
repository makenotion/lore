/**
 * Shared wording for explicit project-scope misses.
 */

import type { Project } from "../types.js"
import type { ProjectNameResolution } from "./project.js"

export interface FormatUnresolvedProjectScopeErrorOptions {
  docsHint?: string
  includeArchivedHint?: string
  listHint?: string
  omittedScopeLabel?: string
}

export const PROJECT_SCOPE_MIGRATION_DOC =
  "docs/memory-workflows.md#migrating-from-unscoped-writes"

export function formatUnresolvedProjectScopeError(
  names: readonly string[],
  scopeFields: string,
  options: FormatUnresolvedProjectScopeErrorOptions = {}
): string {
  const quoted = names.map((name) => `"${name}"`).join(", ")
  const subject = names.length === 1 ? `Project ${quoted}` : `Projects ${quoted}`
  const noun = names.length === 1 ? "name" : "names"
  const hint = options.listHint ? ` (${options.listHint})` : ""
  const omittedScopeLabel = options.omittedScopeLabel ?? "auto-detected scope"
  const includeArchived = options.includeArchivedHint
    ? ` ${options.includeArchivedHint}.`
    : ""
  const docsHint = options.docsHint ? ` See ${options.docsHint}.` : ""
  return (
    `${subject} could not be resolved (not found, archived, or inaccessible). ` +
    `Fix the project scope by correcting the project ${noun}${hint}, ` +
    `or omit ${scopeFields} intentionally to use ${omittedScopeLabel}.` +
    includeArchived +
    docsHint
  )
}

function causeMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message
  if (typeof cause === "string" && cause.length > 0) return cause
  return "unknown transient Notion error"
}

export class TransientProjectResolutionError extends Error {
  readonly code = "transient_project_resolution"
  readonly retryable = true
  readonly names: readonly string[]
  readonly scopeFields: string

  constructor(
    names: readonly string[],
    scopeFields: string,
    cause: unknown,
    options: FormatUnresolvedProjectScopeErrorOptions = {}
  ) {
    const quoted = names.map((name) => `"${name}"`).join(", ")
    const subject = names.length === 1 ? `Project ${quoted}` : `Projects ${quoted}`
    const docsHint = options.docsHint ? ` See ${options.docsHint}.` : ""
    super(
      `${subject} could not be resolved because Notion returned a transient error. ` +
        `Retry ${scopeFields} resolution later; do not treat this as a missing project. ` +
        `Cause: ${causeMessage(cause)}.${docsHint}`,
      { cause }
    )
    this.name = "TransientProjectResolutionError"
    this.names = names
    this.scopeFields = scopeFields
  }
}

export function isRetryableError(err: unknown): err is Error & {
  code: string
  retryable: true
} {
  return (
    err instanceof Error &&
    (err as { retryable?: unknown }).retryable === true &&
    typeof (err as { code?: unknown }).code === "string"
  )
}

export interface ProjectNameResolver {
  findByName(
    name: string,
    options?: { includeArchived?: boolean }
  ): Promise<Project | null>
  resolveByName?(
    name: string,
    options?: { includeArchived?: boolean }
  ): Promise<ProjectNameResolution>
}

function findByNameFallback(
  projects: ProjectNameResolver,
  name: string,
  includeArchived: boolean | undefined
): Promise<Project | null> {
  return includeArchived === undefined
    ? projects.findByName(name)
    : projects.findByName(name, { includeArchived })
}

export async function resolveProjectScopeName(
  projects: ProjectNameResolver,
  name: string,
  scopeFields: string,
  options: FormatUnresolvedProjectScopeErrorOptions & {
    includeArchived?: boolean
  } = {}
): Promise<Project> {
  const result = projects.resolveByName
    ? await projects.resolveByName(name, { includeArchived: options.includeArchived })
    : ((await findByNameFallback(projects, name, options.includeArchived)) ?? null)

  if (result === null) {
    throw new Error(formatUnresolvedProjectScopeError([name], scopeFields, options))
  }
  if ("kind" in result) {
    switch (result.kind) {
      case "resolved":
        return result.project
      case "missing":
        throw new Error(formatUnresolvedProjectScopeError([name], scopeFields, options))
      case "transient-error":
        throw new TransientProjectResolutionError(
          [name],
          scopeFields,
          result.cause,
          options
        )
    }
  }
  return result
}

export async function resolveProjectScopeNames(
  projects: ProjectNameResolver,
  names: readonly string[],
  scopeFields: string,
  options: FormatUnresolvedProjectScopeErrorOptions & {
    includeArchived?: boolean
  } = {}
): Promise<Project[]> {
  const resolved = await Promise.all(
    names.map(async (name) => ({
      name,
      result: projects.resolveByName
        ? await projects.resolveByName(name, {
            includeArchived: options.includeArchived,
          })
        : ((await findByNameFallback(projects, name, options.includeArchived)) ?? null),
    }))
  )

  const missing: string[] = []
  const transient: Array<{ name: string; cause: unknown }> = []
  const projectsOut: Project[] = []

  for (const entry of resolved) {
    const { name, result } = entry
    if (result === null) {
      missing.push(name)
      continue
    }
    if ("kind" in result) {
      if (result.kind === "resolved") projectsOut.push(result.project)
      else if (result.kind === "missing") missing.push(name)
      else transient.push({ name, cause: result.cause })
      continue
    }
    projectsOut.push(result)
  }

  if (transient.length > 0) {
    throw new TransientProjectResolutionError(
      transient.map((entry) => entry.name),
      scopeFields,
      transient[0]!.cause,
      options
    )
  }
  if (missing.length > 0) {
    throw new Error(formatUnresolvedProjectScopeError(missing, scopeFields, options))
  }

  return projectsOut
}

export function validateExplicitProjectScopeName(
  name: string | undefined,
  scopeFields: string,
  options: FormatUnresolvedProjectScopeErrorOptions = {}
): string | undefined {
  if (name === undefined) return undefined
  if (name.trim().length === 0) {
    throw new Error(formatUnresolvedProjectScopeError([""], scopeFields, options))
  }
  return name
}

export function validateExplicitProjectScopeNames(
  names: readonly string[] | undefined,
  scopeFields: string,
  options: FormatUnresolvedProjectScopeErrorOptions = {}
): readonly string[] | undefined {
  if (names === undefined) return undefined
  if (names.length === 0) {
    throw new Error(formatUnresolvedProjectScopeError([""], scopeFields, options))
  }
  const blankName = names.find((name) => name.trim().length === 0)
  if (blankName !== undefined) {
    throw new Error(
      formatUnresolvedProjectScopeError([blankName.trim()], scopeFields, options)
    )
  }
  return names
}
