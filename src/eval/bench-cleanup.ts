/**
 * `lore eval bench cleanup-orphans` — archive stale bench sub-projects
 * under the sandbox vault. Identifies orphans by name pattern
 * (`lme-<exampleId>-<ulid>`) AND parent-scope membership, then uses
 * the ULID-embedded timestamp to gate by age; no Notion
 * `created_time` round-trip.
 *
 * Idempotent: already-archived projects are skipped. Requires
 * `LORE_EVAL_BENCH_REAL=1` so a misconfigured CI job cannot archive
 * arbitrary projects.
 *
 * Scope-of-archive contract:
 *
 *   - Name must match `^lme-.+-<26-char ULID>$`.
 *   - **AND** the project's `path` must begin with the sandbox
 *     parent's `path` (or equal it). This guards against archiving
 *     a stale `lme-*-<ulid>` project that lives outside the
 *     configured sandbox (different environment, typo'd parent
 *     name, fixture using the same shape, etc.). The
 *     `LORE_EVAL_BENCH_REAL=1` gate bounds the blast; the
 *     parent-path filter bounds the *scope*.
 */

import { initServices } from "../services.js"
import { resolveProjectByName } from "../core/project-scope.js"
import {
  extractUlidFromSubProjectName,
  filterOrphanSubProjects,
  SUB_PROJECT_NAME_REGEX,
} from "./bench-runner.js"

export interface CleanupOrphansOptions {
  olderThanHours: number
  dryRun: boolean
  /** Test seam — overrides Date.now for the cutoff. */
  now?: () => Date
  /** Test seam — overrides the project list and archive ops. */
  services?: {
    listAllProjects(): Promise<
      Array<{ id: string; name: string; archived: boolean; path: string }>
    >
    archive(id: string): Promise<void>
    /** Sandbox parent's `path` for the scope filter. */
    sandboxParentPath: string
  }
}

export interface CleanupOrphansReport {
  archivedCount: number
  skippedCount: number
  archived: Array<{ id: string; name: string }>
  skipped: Array<{ id: string; name: string; reason: string }>
}

/**
 * Treat the sandbox parent's `path` as the in-scope prefix. The
 * bench-runner's `createSubProject` writes its sub-project's `path`
 * as `<parent.path>/<sub-project-name>`, so prefix-matching is the
 * exact membership relation. The parent itself is excluded from the
 * filter via the `name !== parent.name` check applied separately.
 */
export function isInsideSandboxScope(
  projectPath: string,
  sandboxParentPath: string
): boolean {
  // Exact-equality is the parent itself; prefix-match with a path
  // separator is a sub-project. Either branch returning true is a
  // candidate; the caller's regex + name check excludes the parent.
  if (projectPath === sandboxParentPath) return true
  if (sandboxParentPath === ".") return true
  return projectPath.startsWith(`${sandboxParentPath}/`)
}

export async function runBenchCleanupOrphans(
  options: CleanupOrphansOptions
): Promise<CleanupOrphansReport> {
  if (process.env["LORE_EVAL_BENCH_REAL"] !== "1") {
    throw new Error("LORE_EVAL_BENCH_REAL is not set; refusing to archive")
  }
  if (!Number.isInteger(options.olderThanHours) || options.olderThanHours <= 0) {
    throw new Error(
      `--older-than must be a positive integer, got ${options.olderThanHours}`
    )
  }
  const now = options.now ?? (() => new Date())
  const cutoffMs = now().getTime() - options.olderThanHours * 60 * 60 * 1000
  const accessor = options.services ?? (await buildDefaultAccessor())
  const allProjects = await accessor.listAllProjects()

  const candidates = allProjects
    .filter((p) => SUB_PROJECT_NAME_REGEX.test(p.name))
    .filter((p) => !p.archived)
    .filter((p) => isInsideSandboxScope(p.path, accessor.sandboxParentPath))
    .map((p) => ({ id: p.id, name: p.name }))
  const orphans = filterOrphanSubProjects(candidates, cutoffMs)

  const report: CleanupOrphansReport = {
    archivedCount: 0,
    skippedCount: 0,
    archived: [],
    skipped: [],
  }
  for (const orphan of orphans) {
    if (options.dryRun) {
      report.skipped.push({
        id: orphan.id,
        name: orphan.name,
        reason: "dry-run",
      })
      report.skippedCount += 1
      continue
    }
    try {
      await accessor.archive(orphan.id)
      report.archived.push({ id: orphan.id, name: orphan.name })
      report.archivedCount += 1
    } catch (err) {
      report.skipped.push({
        id: orphan.id,
        name: orphan.name,
        reason:
          err instanceof Error ? `archive-failed: ${err.message}` : "archive-failed",
      })
      report.skippedCount += 1
    }
  }
  return report
}

async function buildDefaultAccessor(): Promise<
  NonNullable<CleanupOrphansOptions["services"]>
> {
  const sandboxName = process.env["LORE_BENCH_SANDBOX_PROJECT_NAME"]
  if (!sandboxName) {
    throw new Error(
      "LORE_BENCH_SANDBOX_PROJECT_NAME must be set when calling bench cleanup-orphans without --services override"
    )
  }
  const services = await initServices(undefined, { driftCheck: false })
  // Resolve the sandbox parent and capture its `path` so the scope
  // filter rejects any `lme-*-<ulid>` candidate that doesn't sit
  // under the configured sandbox project.
  const parent = await resolveProjectByName(
    services.projects,
    sandboxName,
    "bench-cleanup"
  )
  const sandboxParentPath = parent.path && parent.path.length > 0 ? parent.path : "."
  return {
    sandboxParentPath,
    async listAllProjects() {
      const projects = await services.projects.list("any")
      return projects.map((p) => ({
        id: p.id,
        name: p.name,
        archived: p.status === "archived",
        path: p.path ?? "",
      }))
    },
    async archive(id) {
      await services.projects.archive(id)
    },
  }
}

export { extractUlidFromSubProjectName }
