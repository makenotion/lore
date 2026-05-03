/**
 * Shared wording for explicit project-scope misses.
 */

export interface FormatUnresolvedProjectScopeErrorOptions {
  listHint?: string
  omittedScopeLabel?: string
}

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
  return (
    `${subject} could not be resolved (not found, archived, or inaccessible). ` +
    `Fix the project scope by correcting the project ${noun}${hint}, ` +
    `or omit ${scopeFields} intentionally to use ${omittedScopeLabel}.`
  )
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
