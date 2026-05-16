import type { LoreServices } from "../../../services.js"
import {
  PROJECT_SCOPE_MIGRATION_DOC,
  resolveProjectScopeName,
  validateExplicitProjectScopeName,
} from "../../../core/project-scope.js"

export { PROJECT_SCOPE_MIGRATION_DOC }

export interface MigrationScopeIntent {
  fixFactEncoding?: boolean
  fixMemoryEncoding?: boolean
  normalizeAgents?: boolean
  buildEntities?: boolean
  backfillFactSources?: boolean
  backfillSynopses?: boolean
  buildConfidenceScores?: boolean
  buildFactConfidenceScores?: boolean
  backfillFactObservedAt?: boolean
  project?: string
  projectId?: string
  includeArchived?: boolean
}

export interface MigrationProjectScope {
  projectId?: string
  projectName?: string
}

export function isProjectScopedMigrationRequested(opts: MigrationScopeIntent): boolean {
  return Boolean(
    opts.fixFactEncoding ||
    opts.fixMemoryEncoding ||
    opts.normalizeAgents ||
    opts.buildEntities ||
    opts.backfillFactSources ||
    opts.backfillSynopses ||
    opts.buildConfidenceScores ||
    opts.buildFactConfidenceScores ||
    opts.backfillFactObservedAt
  )
}

export async function resolveMigrationProjectScope(
  services: LoreServices,
  opts: MigrationScopeIntent
): Promise<MigrationProjectScope> {
  if (!isProjectScopedMigrationRequested(opts)) {
    return {}
  }

  const explicitProjectName = validateExplicitProjectScopeName(
    opts.project,
    "--project",
    {
      listHint: "run `lore status projects` to list configured projects",
      omittedScopeLabel: "vault-wide scope",
      includeArchivedHint:
        "If this is an archived project migration, pass --include-archived",
      docsHint: PROJECT_SCOPE_MIGRATION_DOC,
    }
  )
  if (opts.projectId !== undefined) {
    return { projectId: opts.projectId, projectName: explicitProjectName }
  }
  if (explicitProjectName === undefined) return {}

  const project = await resolveProjectScopeName(
    services.projects,
    explicitProjectName,
    "--project",
    {
      listHint: "run `lore status projects` to list configured projects",
      omittedScopeLabel: "vault-wide scope",
      includeArchivedHint:
        "If this is an archived project migration, pass --include-archived",
      docsHint: PROJECT_SCOPE_MIGRATION_DOC,
      includeArchived: opts.includeArchived,
    }
  )
  return { projectId: project.id, projectName: project.name }
}

/**
 * Stderr breadcrumb fired before a paginating discovery call so the
 * operator sees activity before the first (potentially long-blocking)
 * Notion query lands. The Notion SDK absorbs 429s with `Retry-After`-
 * driven sleeps capped at `DEFAULT_MAX_RETRY_DELAY_MS` (60s), and the
 * sleep happens inside a single `await` — without this breadcrumb, a
 * stalled discovery is indistinguishable from a hang.
 *
 * `label` is the noun phrase describing the rows being discovered
 * ("memories with empty Synopsis"). The helper appends a fixed
 * `LORE_DEBUG=1` pointer so every discovery surface points at the
 * same retry-trace switch — operators only have to remember the one
 * env var.
 *
 * Exported so the migrate-dispatcher tests can pin the breadcrumb
 * fragments without going through commander.
 */
export function printDiscoveryBreadcrumb(label: string): void {
  process.stderr.write(
    `Discovering ${label} (paginating Notion; set LORE_DEBUG=1 to trace retries)...\n`
  )
}
