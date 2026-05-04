/**
 * Shared Notion query filter builders.
 */

import { MEMORY_PROPS } from "./schema.js"

/**
 * Build a project filter that includes both project-scoped and unscoped
 * (repo-wide) entries. This is the core of the scope inheritance model:
 * when querying within a project, you always also see repo-wide entries.
 *
 * `projectProperty` defaults to `MEMORY_PROPS.PROJECT` (the most common
 * caller). Callers querying a different database — Topics, Entities, or
 * Facts — must pass their own `*_PROPS.PROJECT` constant so the rename
 * invariant is locally enforceable per call site rather than relying on
 * the four `*_PROPS.PROJECT` constants staying equal forever. Today they
 * all resolve to `"Project"` and the schema-drift test in `schema.test.ts`
 * pins each one to its database's builder; the parameter exists so a
 * future rename touching only one DB cannot silently send the wrong key
 * into the other three's queries through this helper.
 */
export function projectOrUnscopedFilter(
  projectId: string,
  projectProperty: string = MEMORY_PROPS.PROJECT,
): Record<string, unknown> {
  return {
    or: [
      { property: projectProperty, relation: { contains: projectId } },
      { property: projectProperty, relation: { is_empty: true } },
    ],
  }
}
