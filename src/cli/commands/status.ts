import { Command } from "commander"
import { initServices } from "../../services.js"
import type { LoreServices } from "../../services.js"
import type { Memory } from "../../types.js"
import { subProjectNames } from "../../core/context.js"
import { DIGEST_STALE_DAYS } from "../../core/digest.js"
import { digestMarkerAgeDays } from "../../hooks/digest-marker.js"

export const statusCommand = new Command("status")
  .description("Show vault status and project list")
  .action(async () => {
    try {
      // `lore status` is the canonical operator-facing surface for drift
      // warnings — always run the check, bypass the debounce marker.
      const services = await initServices(undefined, { driftCheck: true })
      const stats = await services.vault.stats()
      const project = services.context.project

      console.log("Lore Vault Status")
      console.log("─".repeat(40))
      console.log(`  Vault page: ${services.context.vault.pageId}`)
      console.log(
        `  Current project: ${project ? `${project.name} (${project.path || "root"})` : "none"}`
      )
      console.log()
      console.log("Database counts:")
      console.log(`  Projects: ${stats.projects}`)
      console.log(`  Topics:   ${stats.topics}`)
      console.log(`  Memories: ${stats.memories}`)
      console.log(`  Facts:    ${stats.facts}`)

      // List projects
      const projects = await services.projects.list("active")
      if (projects.length > 0) {
        console.log()
        console.log("Active projects:")
        for (const p of projects) {
          const path = p.path ? ` (${p.path})` : ""
          console.log(`  - ${p.name}${path} [${p.type}]`)
        }
      }

      const digestReport = await loadDigestStatus(services, services.configRoot, {
        autoDigestEnvOverride: process.env["LORE_AUTO_DIGEST"],
      })
      const digestLines = formatDigestStatus(digestReport)
      if (digestLines.length > 0) {
        console.log()
        for (const line of digestLines) console.log(line)
      }
    } catch (err) {
      console.error("Status failed:", err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

// Sub-commands
const projectsCmd = new Command("projects")
  .description("List all projects")
  .option("-a, --all", "Include archived projects")
  .action(async (opts: { all?: boolean }) => {
    try {
      // Sub-commands are narrow read-only listings — they don't surface
      // drift, so they take the default `false`. Made explicit so a
      // future contributor adding a third subcommand sees the policy in
      // grep, not just the AGENTS.md table.
      const services = await initServices(undefined, { driftCheck: false })
      const projects = await services.projects.list(opts.all ? undefined : "active")

      if (projects.length === 0) {
        console.log("No projects found.")
        return
      }

      for (const p of projects) {
        const path = p.path ? `  ${p.path}` : ""
        const desc = p.description ? `  ${p.description}` : ""
        console.log(`${p.name} [${p.type}, ${p.status}]${path}${desc}`)
      }
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

const topicsCmd = new Command("topics")
  .description("List topics in a project")
  .argument("[project]", "Project name (default: current project)")
  .action(async (projectName: string | undefined) => {
    try {
      // See `projectsCmd` above — narrow listing, default `false` made
      // explicit for grep discoverability.
      const services = await initServices(undefined, { driftCheck: false })

      let projectId: string | undefined
      if (projectName) {
        const found = await services.projects.findByName(projectName)
        if (!found) {
          console.error(`Project "${projectName}" not found.`)
          process.exit(1)
        }
        projectId = found.id
      } else if (services.context.project) {
        projectId = services.context.project.id
      } else {
        console.error("No project specified and none detected from cwd.")
        process.exit(1)
      }

      const topics = await services.topics.listByProject(projectId!)

      if (topics.length === 0) {
        console.log("No topics found.")
        return
      }

      for (const t of topics) {
        const desc = t.description ? `  ${t.description}` : ""
        console.log(`${t.name}${desc}`)
      }
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

statusCommand.addCommand(projectsCmd)
statusCommand.addCommand(topicsCmd)

// ---------------------------------------------------------------------------
// Digests section
// ---------------------------------------------------------------------------

/**
 * Per-project state surfaced in the Digests section. Pure data so the
 * renderer is a deterministic function of the loader's output — both halves
 * are independently testable.
 */
export interface DigestRow {
  /** Configured project name (matches `.lore.yaml` and the marker filename). */
  name: string
  /**
   * Latest existing `source: digest` memory linked to this project, or null
   * when none exists yet.
   */
  lastDigest: { date: string; daysAgo: number } | null
  /**
   * Marker mtime age in days. `null` when no marker file exists — i.e., the
   * session-end auto-digest has never fired (or was cleared by a spawn-failed
   * rollback). Distinguished from `Infinity` so the renderer can show
   * "marker missing" rather than treating it as just very stale.
   */
  markerAgeDays: number | null
}

export interface DigestStatusReport {
  /**
   * Why auto-digest is disabled, or null when it's enabled. When non-null,
   * the section header surfaces the reason so an operator who set
   * `LORE_AUTO_DIGEST=false` in their shell rc and forgot sees it on the
   * first `lore status`.
   */
  disabledReason:
    | { source: "config"; detail: string }
    | { source: "env"; detail: string }
    | null
  rows: DigestRow[]
  /**
   * True when the underlying digest list query returned exactly the cap
   * (`DIGEST_LIST_LIMIT`). At saturation, a project that hasn't been
   * digested recently could be missing from the grouping despite having a
   * historical digest, so the renderer footnotes that "no digest yet" rows
   * may be truncation artifacts rather than genuine absences.
   */
  truncated: boolean
}

export interface DigestStatusDeps {
  /**
   * Value of `LORE_AUTO_DIGEST` from the environment. Threaded through as a
   * dep so tests don't have to mutate `process.env` to drive the disabled
   * path. Pass `undefined` when the env var isn't set.
   */
  autoDigestEnvOverride?: string
  /**
   * Marker-age probe. Defaults to the real filesystem stat; tests inject a
   * fake to drive each row's age deterministically.
   */
  markerAge?: (configRoot: string, projectName: string) => Promise<number>
}

/**
 * Cap on the vault-wide digest list query. With auto-digest firing ≤ 1 per
 * project per 7 days, 50 recent digests cover ~50 projects' worth of latest
 * digests on the freshness window the operator cares about. A vault with
 * more configured projects than this falls back to "no digest yet" for the
 * tail; the alternative (per-project queries) was the original concern in
 * the issue's risk notes.
 */
const DIGEST_LIST_LIMIT = 50

/**
 * Gather per-project digest watermark data for the Digests section.
 *
 * Issues exactly one extra Notion call beyond what `lore status` already
 * pays for — a vault-wide `memories.list({ source: digest })` — and groups
 * the result client-side by project ID. Per-project marker stats are pure
 * filesystem work and proportional to the number of configured sub-projects.
 *
 * Returns an empty `rows` list when no sub-projects are configured (a
 * single-project vault with only a catch-all has nothing project-scoped to
 * watermark) — the renderer omits the section entirely in that case.
 */
export async function loadDigestStatus(
  services: LoreServices,
  configRoot: string,
  deps: DigestStatusDeps = {},
): Promise<DigestStatusReport> {
  const subProjects = subProjectNames(services.config)
  const disabledReason = deriveDisabledReason(
    services.config.hooks?.autoDigest,
    deps.autoDigestEnvOverride,
  )

  if (subProjects.length === 0) {
    return { disabledReason, rows: [], truncated: false }
  }

  const markerAge = deps.markerAge ?? digestMarkerAgeDays

  // One vault-wide list of recent digest memories. Grouped client-side by
  // project ID below — see DIGEST_LIST_LIMIT for the bounded-recall
  // tradeoff.
  const { items: digestMemories } = await services.memories.list({
    source: "digest",
    limit: DIGEST_LIST_LIMIT,
    sortBy: "created_time",
    includeContent: false,
  })

  const latestByProject = groupLatestDigestByProject(digestMemories)

  // Resolve project name → Notion ID via the existing name-resolver cache
  // (`ProjectService.findByName` is cached). Concurrent because each lookup
  // is independent and the cache de-dups any repeats.
  const rows = await Promise.all(
    subProjects.map(async (name): Promise<DigestRow> => {
      const project = await services.projects.findByName(name)
      const latest = project ? latestByProject.get(project.id) ?? null : null
      const ageDays = await markerAge(configRoot, name)
      return {
        name,
        lastDigest: latest
          ? {
              date: latest.createdAt.split("T")[0] ?? latest.createdAt,
              daysAgo: daysBetween(latest.createdAt, new Date()),
            }
          : null,
        markerAgeDays: Number.isFinite(ageDays) ? ageDays : null,
      }
    }),
  )

  return {
    disabledReason,
    rows,
    truncated: digestMemories.length >= DIGEST_LIST_LIMIT,
  }
}

/**
 * Group digest memories by project ID, keeping only the most recently
 * created memory per project. A digest memory can be linked to multiple
 * projects via `projectIds`, but in practice each one is scoped to a single
 * sub-project — fan it out to every linked ID anyway so a multi-project
 * digest doesn't silently drop from the watermark for the secondary
 * project.
 */
export function groupLatestDigestByProject(
  digestMemories: Memory[],
): Map<string, Memory> {
  const latest = new Map<string, Memory>()
  for (const mem of digestMemories) {
    const ids = mem.projectIds.length > 0 ? mem.projectIds : [""]
    for (const projectId of ids) {
      const current = latest.get(projectId)
      if (!current || current.createdAt < mem.createdAt) {
        latest.set(projectId, mem)
      }
    }
  }
  return latest
}

function deriveDisabledReason(
  configValue: boolean | undefined,
  envValue: string | undefined,
): DigestStatusReport["disabledReason"] {
  if (envValue === "false") {
    return { source: "env", detail: "LORE_AUTO_DIGEST=false" }
  }
  if (configValue === false) {
    return { source: "config", detail: "hooks.autoDigest: false" }
  }
  return null
}

function daysBetween(iso: string, now: Date): number {
  const then = new Date(iso).getTime()
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000))
}

/**
 * Render a Digests section from a loader report. Returns one line per
 * output row, including the section header. Empty result list ⇒ no lines
 * ⇒ caller suppresses the entire section.
 *
 * Pure function: deterministic in `report`, no I/O. Tests cover the
 * disabled-state header, the missing-marker branch, and the next-fire
 * arithmetic so a future refactor can't quietly regress the operator UX.
 */
export function formatDigestStatus(report: DigestStatusReport): string[] {
  if (report.rows.length === 0) return []

  const header = report.disabledReason
    ? `Digests (autoDigest=false via ${report.disabledReason.detail}):`
    : "Digests:"

  const longestName = report.rows.reduce(
    (max, row) => Math.max(max, row.name.length),
    0,
  )

  const lines: string[] = [header]
  for (const row of report.rows) {
    lines.push(formatDigestRow(row, longestName))
  }
  if (report.truncated) {
    lines.push(
      `  (showing latest ${DIGEST_LIST_LIMIT} digests; older may be truncated)`,
    )
  }
  return lines
}

function formatDigestRow(row: DigestRow, longestName: number): string {
  const parts: string[] = []

  if (row.lastDigest) {
    parts.push(`last digest ${row.lastDigest.date} (${row.lastDigest.daysAgo}d ago)`)
  } else {
    parts.push("no digest yet")
  }

  if (row.markerAgeDays === null) {
    parts.push("marker missing")
    parts.push("next fire on next session-end")
  } else {
    const ageDays = Math.floor(row.markerAgeDays)
    parts.push(`marker ${ageDays}d old`)
    const remaining = DIGEST_STALE_DAYS - row.markerAgeDays
    if (remaining <= 0) {
      parts.push("next fire on next session-end")
    } else {
      parts.push(`next fire ~${Math.ceil(remaining)}d`)
    }
  }

  // `${name}:` colon mimics the example in the issue. Pad on the colon-
  // suffixed string so the alignment column starts after the longest name.
  const label = `${row.name}:`.padEnd(longestName + 2)
  return `  ${label}${parts.join(" · ")}`
}
