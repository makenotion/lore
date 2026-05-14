/**
 * Shared wording for explicit project-scope misses.
 */

import type { Project } from "../types.js"
import type { ProjectNameResolution } from "./project.js"
import { LoreError, errorCauseMessage } from "../errors.js"

export interface FormatUnresolvedProjectScopeErrorOptions {
  archivedHint?: string
  archivedNames?: readonly string[]
  docsHint?: string
  includeArchivedHint?: string
  listHint?: string
  omittedScopeLabel?: string
}

export const PROJECT_SCOPE_MIGRATION_DOC =
  "docs/memory-workflows.md#migrating-from-unscoped-writes"

function formatProjectSubject(names: readonly string[]): string {
  const quoted = names.map((name) => `"${name}"`).join(", ")
  return names.length === 1 ? `Project ${quoted}` : `Projects ${quoted}`
}

function formatUnresolvedNames(
  names: readonly string[],
  scopeFields: string,
  options: FormatUnresolvedProjectScopeErrorOptions
): string {
  const subject = formatProjectSubject(names)
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

function formatArchivedNames(
  names: readonly string[],
  options: FormatUnresolvedProjectScopeErrorOptions
): string {
  const subject = formatProjectSubject(names)
  const verb = names.length === 1 ? "is" : "are"
  const hint = options.listHint ? ` (${options.listHint})` : ""
  const recovery =
    options.archivedHint ??
    options.includeArchivedHint ??
    `Unarchive ${names.length === 1 ? "it" : "them"} or choose an active project${hint}`
  const docsHint = options.docsHint ? ` See ${options.docsHint}.` : ""
  return (
    `${subject} could not be resolved because ${names.length === 1 ? "it" : "they"} ` +
    `${verb} archived. ${recovery}.${docsHint}`
  )
}

export function formatUnresolvedProjectScopeError(
  names: readonly string[],
  scopeFields: string,
  options: FormatUnresolvedProjectScopeErrorOptions = {}
): string {
  const archived = new Set(options.archivedNames ?? [])
  const archivedNames = names.filter((name) => archived.has(name))
  const unresolvedNames = names.filter((name) => !archived.has(name))
  const messages: string[] = []

  if (archivedNames.length > 0) {
    messages.push(formatArchivedNames(archivedNames, options))
  }
  if (unresolvedNames.length > 0) {
    messages.push(formatUnresolvedNames(unresolvedNames, scopeFields, options))
  }

  return messages.join(" ")
}

export class TransientProjectResolutionError extends LoreError<"transient-project-resolution"> {
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
    const causeText = errorCauseMessage(cause, "unknown transient Notion error")
    super(
      "transient-project-resolution",
      `${subject} could not be resolved because Notion returned a transient error. ` +
        `Retry ${scopeFields} resolution later; do not treat this as a missing project. ` +
        `Cause: ${causeText}.${docsHint}`,
      { names, scopeFields, causeMessage: causeText },
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

async function resolveProjectNameResult(
  projects: ProjectNameResolver,
  name: string,
  includeArchived: boolean | undefined
): Promise<ProjectNameResolution | Project | null> {
  if (projects.resolveByName) {
    return projects.resolveByName(name, { includeArchived })
  }

  const project = await findByNameFallback(projects, name, includeArchived)
  if (project !== null || includeArchived) return project

  // Fatal explicit-scope misses pay one archived-inclusive probe so
  // archived names can get a precise recovery hint. Do not collapse
  // this into an unconditional include-archived lookup: active lookup
  // owns the duplicate-active-name contract and the hot-path cache.
  const archived = await findByNameFallback(projects, name, true)
  if (archived?.status === "archived") {
    return { kind: "archived", project: archived }
  }
  return null
}

export async function resolveProjectScopeName(
  projects: ProjectNameResolver,
  name: string,
  scopeFields: string,
  options: FormatUnresolvedProjectScopeErrorOptions & {
    includeArchived?: boolean
  } = {}
): Promise<Project> {
  const result = await resolveProjectNameResult(projects, name, options.includeArchived)

  if (result === null) {
    throw new Error(formatUnresolvedProjectScopeError([name], scopeFields, options))
  }
  if ("kind" in result) {
    switch (result.kind) {
      case "resolved":
        return result.project
      case "archived":
        throw new Error(
          formatUnresolvedProjectScopeError([name], scopeFields, {
            ...options,
            archivedNames: [name],
          })
        )
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
      result: await resolveProjectNameResult(projects, name, options.includeArchived),
    }))
  )

  const missing: string[] = []
  const archived: string[] = []
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
      else if (result.kind === "archived") archived.push(name)
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
  if (archived.length > 0 || missing.length > 0) {
    throw new Error(
      formatUnresolvedProjectScopeError([...archived, ...missing], scopeFields, {
        ...options,
        archivedNames: archived,
      })
    )
  }

  return projectsOut
}

export const resolveProjectByName = resolveProjectScopeName
export const resolveProjectsByNames = resolveProjectScopeNames

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
