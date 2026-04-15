/**
 * Shared Notion query filter builders.
 */

/**
 * Build a project filter that includes both project-scoped and unscoped
 * (repo-wide) entries. This is the core of the scope inheritance model:
 * when querying within a project, you always also see repo-wide entries.
 */
export function projectOrUnscopedFilter(projectId: string): Record<string, unknown> {
  return {
    or: [
      { property: "Project", relation: { contains: projectId } },
      { property: "Project", relation: { is_empty: true } },
    ],
  }
}
