import { Command } from "commander"
import { initServices } from "../../services.js"
import type { LoreServices } from "../../services.js"
import type { FactService } from "../../core/fact.js"
import {
  formatProposedInboxStatus,
  loadProposedInboxStatus,
} from "../../core/proposed-inbox.js"
import {
  formatVaultTopologyStatus,
  loadVaultTopologyStatus,
} from "../../core/topology-status.js"
import { formatTaskSummary, taskStats, todayUtc } from "../../core/task.js"
import { formatWakeUpCoverageReport, loadWakeUpData } from "../../core/wakeup.js"
import type { Memory } from "../../types.js"
import {
  formatExpiringScopedSummary,
  loadExpiringScopedStatus,
} from "../../core/expiring-scoped.js"
import { subProjectNames } from "../../core/context.js"
import { DIGEST_STALE_DAYS } from "../../core/digest.js"
import {
  resolveProjectScopeName,
  validateExplicitProjectScopeName,
} from "../../core/project-scope.js"
import { digestMarkerAgeDays } from "../../hooks/digest-marker.js"
import { DRIFT_DEBOUNCE_DAYS, driftMarkerAgeDays } from "../../hooks/drift-marker.js"
import {
  formatBackgroundFailureStatus,
  loadBackgroundFailureStatus,
} from "../../hooks/background-failure-status.js"
import {
  defaultTodayRange,
  eventInRange,
  formatMalformedLedgerWarning,
  formatUsd,
  monthRange,
  readCostLedgerAppendErrorMarker,
  readLedgerEventsWithDiagnostics,
  summarizeCostEvents,
  type CostLedgerAppendErrorMarkerRead,
  type ResolvedCostTracking,
} from "../../core/cost-ledger.js"
import { defaultProfileSelector } from "../../profile/index.js"
import { notionPageUrl, terminalLink } from "../output.js"

/**
 * Raw Notion `Predicate` select values for the legacy tracking-predicate
 * facts that are dropped from `pageToFact` and from the `FactPredicate`
 * typed union.
 *
 * Inlined as raw strings rather than imported from `TRACKING_PREDICATES`
 * because that exported list shrinks over time — depending on it would
 * make the preflight silently match a shrinking set. The preflight
 * needs to keep matching the historical Notion select values
 * regardless of what the typed union looks like in any given release.
 */
const TRACKING_PREDICATE_PREFLIGHT_VALUES: string[] = [
  "needs_action",
  "waiting_on",
  "blocked_by",
]

export const statusCommand = new Command("status")
  .description(
    "Show vault status and project list. Renders a Vault topology section " +
      "when upstreamVaults or promotionTargets are configured; see " +
      "docs/topology.md for the full output contract."
  )
  .option("--project <name>", "Scope project-dependent status sections to a project")
  .action(async (opts: { project?: string }) => {
    try {
      const explicitProjectName = validateExplicitProjectScopeName(
        opts.project,
        "--project",
        {
          listHint: "run `lore status projects` to list configured projects",
        }
      )
      // `lore status` is the canonical operator-facing surface for drift
      // warnings — always run the check, bypass the debounce marker.
      const services = await initServices(undefined, { driftCheck: true })
      const stats = await services.vault.stats()
      const project =
        explicitProjectName !== undefined
          ? await resolveProjectScopeName(
              services.projects,
              explicitProjectName,
              "--project",
              {
                listHint: "run `lore status projects` to list configured projects",
              }
            )
          : services.context.project

      // Tracking-predicate preflight. Renders
      // a warning when the vault still carries facts whose predicate is
      // one of the historical tracking values (`needs_action`,
      // `waiting_on`, `blocked_by`). Informational only — the rest of
      // status output runs unconditionally so operators can still
      // diagnose other vault state.
      const preflight = await loadTrackingPreflight(services)
      const preflightLines = formatTrackingPreflight(preflight)
      if (preflightLines.length > 0) {
        for (const line of preflightLines) console.log(line)
        console.log()
      }

      console.log("Lore Vault Status")
      console.log("─".repeat(40))
      console.log(`  Vault page: ${services.context.vault.pageId}`)
      const profileLabel = services.profile
        ? `${services.profile.name}@${services.profile.version} (${services.profile.source})`
        : `${defaultProfileSelector()} (built-in)`
      console.log(`  Profile: ${profileLabel}`)
      const projectLabel = project
        ? `${terminalLink(project.name, notionPageUrl(project.id))} (${project.path || "root"})`
        : "none"
      console.log(`  Current project: ${projectLabel}`)
      const topologyLines = formatVaultTopologyStatus(
        await loadVaultTopologyStatus(services)
      )
      if (topologyLines.length > 0) {
        console.log()
        for (const line of topologyLines) console.log(line)
      }
      console.log()
      console.log("Database counts:")
      console.log(`  Projects: ${stats.projects}`)
      console.log(`  Topics:   ${stats.topics}`)
      console.log(`  Memories: ${stats.memories}`)
      console.log(`  Facts:    ${stats.facts}`)

      const costLines = await loadCostStatusLines(services)
      if (costLines.length > 0) {
        console.log()
        for (const line of costLines) console.log(line)
      }

      // Background hook markers are filesystem-only operator health, so keep
      // their scope disclaimer near the top before longer project/digest lists.
      const backgroundFailureReport = await loadBackgroundFailureStatus(
        services.configRoot
      )
      const backgroundFailureLines = formatBackgroundFailureStatus(
        backgroundFailureReport
      )
      if (backgroundFailureLines.length > 0) {
        console.log()
        for (const line of backgroundFailureLines) console.log(line)
      }

      // Status probes fan out via `Promise.all` — task summary,
      // memory confidence summary, proposed-memory inbox count, and
      // wake-up coverage. All probes read the same project scope,
      // so wall-clock at the orchestration level is `max(probe_i)`
      // rather than the sum. Adding a future probe extends the
      // tuple and the destructure; the comment is generic on
      // purpose so it can't drift on the next addition.
      // Vaults missing the `Done At` column silently omit the
      // closure-rate line — `countClosedSince` returns null on the
      // missing-property error path. Vaults whose `Confidence Score`
      // column has not been backfilled render the confidence line
      // with `0 scored` and no avg/below-threshold suffix; the line
      // itself never disappears. The proposed-inbox line is
      // suppressed entirely on `total === 0` so an empty inbox
      // doesn't occupy a row of vault state.
      //
      // `Promise.all` (not `allSettled`) is deliberate. A 5xx that
      // takes down one of these calls likely takes down the others —
      // they walk the same vault under the same scope, paginated through
      // the same rate-limited client, so
      // any partial-recovery the `allSettled` posture would buy us
      // is mostly the case where exactly one transient failure
      // happens to the smaller of the queries. The rate-limit
      // middleware doesn't retry through 5xx either; an outage
      // surfaces as a thrown error and the outer try/catch renders
      // `Status failed: ...`. Matches `taskStats`'s pre-DEFERRED-04
      // posture and the `searchByHybridPages` design rule that
      // "fully-broken subsystem doesn't masquerade as no-results".
      //
      // `confidenceStats` is internally sequential — its pagination
      // dominates wall-clock on large vaults. The fan-out gives us
      // parallel dispatch of the top-level probes; it does not
      // parallelize the iterator inside `confidenceStats`. The
      // method's docstring documents the cost gap.
      const [tasks, confidence, proposedInbox, expiringScoped, wakeUp] =
        await Promise.all([
          taskStats(services.tasks, {
            projectId: project?.id,
            today: todayUtc(),
          }),
          services.memories.confidenceStats({ projectId: project?.id }),
          loadProposedInboxStatus(services, { projectId: project?.id }),
          // Surfaces expired/expiring/out-of-context rows for cleanup.
          // Same fan-out posture as the other probes; wall-clock at the
          // orchestration level stays `max(...)`.
          loadExpiringScopedStatus(services, { projectId: project?.id }),
          loadWakeUpData(services, {
            projectId: project?.id,
            includeMemoryContent: false,
            includeCoverage: true,
          }),
        ])
      for (const line of formatTaskSummary(tasks)) console.log(line)
      for (const line of formatConfidenceSummary(confidence)) console.log(line)
      for (const line of formatProposedInboxStatus(proposedInbox)) console.log(line)
      for (const line of formatExpiringScopedSummary(expiringScoped)) console.log(line)
      if (wakeUp.coverage) {
        for (const line of formatWakeUpCoverageReport(wakeUp.coverage)) {
          console.log(line)
        }
      }

      // List projects
      const projects = await services.projects.list("active")
      if (projects.length > 0) {
        console.log()
        console.log("Active projects:")
        for (const p of projects) {
          const path = p.path ? ` (${p.path})` : ""
          const linkedName = terminalLink(p.name, notionPageUrl(p.id))
          console.log(`  - ${linkedName}${path} [${p.type}]`)
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

      // Drift section reflects what *debounced* callers (MCP server, shell
      // hooks, digest scheduler) will see on their next fire. `lore status`
      // itself runs with `driftCheck: true`, so `resolveDriftCheck` has
      // already touched the marker — the watermark is purely informational
      // on this path.
      const driftReport = await loadDriftStatus(services.configRoot)
      const driftLines = formatDriftStatus(driftReport)
      if (driftLines.length > 0) {
        console.log()
        for (const line of driftLines) console.log(line)
      }
    } catch (err) {
      console.error("Status failed:", err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

// Sub-commands
const projectsCmd = new Command("projects")
  .description("List active projects")
  .option("-a, --all", "Include archived projects")
  .option("--archived-only", "List only archived projects")
  .action(async (opts: { all?: boolean; archivedOnly?: boolean }) => {
    if (opts.all && opts.archivedOnly) {
      console.error("--all and --archived-only cannot be combined.")
      process.exit(1)
      return
    }

    try {
      // Sub-commands are narrow read-only listings — they don't surface
      // drift, so they take the default `false`. Made explicit so a
      // future contributor adding a third subcommand sees the policy
      // on a grep of the call sites rather than inferring it.
      const services = await initServices(undefined, { driftCheck: false })
      const status = opts.all ? "any" : opts.archivedOnly ? "archived" : "active"
      const projects = await services.projects.list(status)

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
      const explicitProjectName = validateExplicitProjectScopeName(
        projectName,
        "project",
        {
          listHint: "run `lore status projects` to list configured projects",
          omittedScopeLabel: "the current project detected from cwd",
        }
      )
      if (explicitProjectName !== undefined) {
        const found = await resolveProjectScopeName(
          services.projects,
          explicitProjectName,
          "project",
          {
            listHint: "run `lore status projects` to list configured projects",
            omittedScopeLabel: "the current project detected from cwd",
          }
        )
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
// Cost tracking section
// ---------------------------------------------------------------------------

export async function loadCostStatusLines(services: LoreServices): Promise<string[]> {
  const costTracking = services.costTracking
  if (!costTracking?.enabled) return []
  const todayRange = defaultTodayRange()
  const now = new Date()
  const monthLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  const currentMonthRange = monthRange(monthLabel)
  const [appendError, ledger] = await Promise.all([
    readCostLedgerAppendErrorMarker(costTracking),
    readLedgerEventsForStatus(costTracking),
  ])
  const todayRows = ledger.rows.filter((row) => eventInRange(row.event, todayRange))
  const monthRows = ledger.rows.filter((row) =>
    eventInRange(row.event, currentMonthRange)
  )
  const today = summarizeCostEvents(
    todayRows.map((row) => row.event),
    todayRange.label
  )
  const month = summarizeCostEvents(
    monthRows.map((row) => row.event),
    monthLabel
  )

  const lines = [`Cost tracking: enabled (ledger: ${costTracking.displayLedgerPath})`]
  if (appendError) {
    lines.push(formatCostAppendErrorLine(costTracking, appendError))
  }
  if (ledger.unreadable) {
    lines.push("Warning: cost ledger could not be read; totals may be incomplete.")
  }
  const warning = formatMalformedLedgerWarning(ledger.malformedLineCount)
  if (warning) lines.push(warning)
  if (today.eventCount === 0) {
    lines.push("Today: no cost events yet")
  } else {
    lines.push(`Today: ${formatCompactCostLine(today)}`)
  }
  if (month.eventCount > 0) {
    lines.push(`This month: ${formatCompactCostLine(month, { omitNotionWrites: true })}`)
  }
  return lines
}

type CostStatusLedgerRead = Awaited<
  ReturnType<typeof readLedgerEventsWithDiagnostics>
> & {
  unreadable: boolean
}

async function readLedgerEventsForStatus(
  costTracking: Extract<ResolvedCostTracking, { enabled: true }>
): Promise<CostStatusLedgerRead> {
  try {
    return {
      ...(await readLedgerEventsWithDiagnostics(costTracking)),
      unreadable: false,
    }
  } catch {
    return { rows: [], malformedLineCount: 0, unreadable: true }
  }
}

function formatCostAppendErrorLine(
  costTracking: Extract<ResolvedCostTracking, { enabled: true }>,
  appendError: CostLedgerAppendErrorMarkerRead
): string {
  if (appendError.marker) {
    return `Warning: cost ledger appends have failed since ${appendError.marker.timestamp} (ledger: ${appendError.marker.ledgerPath}; error: ${appendError.marker.error})`
  }
  const detail = appendError.readError
    ? `; marker unreadable: ${appendError.readError}`
    : ""
  return `Warning: cost ledger appends have failed (ledger: ${costTracking.displayLedgerPath}${detail})`
}

function formatCompactCostLine(
  summary: ReturnType<typeof summarizeCostEvents>,
  opts: { omitNotionWrites?: boolean } = {}
): string {
  const parts = [
    formatCompactModelCost(summary),
    `${summary.wakeupEstimatedTokens.toLocaleString()} wake-up tokens (cost unknown)`,
    `${summary.mcpTotal} MCP calls`,
  ]
  if (!opts.omitNotionWrites) {
    parts.push(`${summary.notionWrites} Notion writes`)
  }
  if (summary.modelUnknownEvents > 0) {
    parts.push(`${summary.modelUnknownEvents} model events with unknown cost`)
  }
  return parts.join(", ")
}

function formatCompactModelCost(summary: ReturnType<typeof summarizeCostEvents>): string {
  if (summary.modelExactUsd > 0 && summary.modelEstimatedUsd > 0) {
    return `${formatUsd(summary.modelExactUsd)} exact + ~${formatUsd(summary.modelEstimatedUsd)} prompt-estimated Lore-owned model`
  }
  if (summary.modelEstimatedUsd > 0) {
    return `~${formatUsd(summary.modelEstimatedUsd)} prompt-estimated Lore-owned model`
  }
  if (summary.modelExactUsd > 0) {
    return `${formatUsd(summary.modelExactUsd)} exact Lore-owned model`
  }
  return `${formatUsd(0)} Lore-owned model`
}

// ---------------------------------------------------------------------------
// Digests section
// ---------------------------------------------------------------------------

/**
 * Per-project state surfaced in the Digests section. Pure data so the
 * renderer is a deterministic function of the loader's output — both halves
 * are independently testable.
 */
export interface DigestRow {
  /** Configured project name (matches .lore.yaml and the marker filename). */
  name: string
  /**
   * Latest existing `source: digest` memory linked to this project, or null
   * when none exists yet.
   */
  lastDigest: { date: string; daysAgo: number } | null
  /**
   * Marker mtime age in days. `null` when no marker file exists — i.e., the
   * Stop-triggered auto-digest has never fired (or was cleared by a
   * spawn-failed rollback). Distinguished from `Infinity` so the renderer
   * can show "marker missing" rather than treating it as just very stale.
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
  deps: DigestStatusDeps = {}
): Promise<DigestStatusReport> {
  const subProjects = subProjectNames(services.config)
  const disabledReason = deriveDisabledReason(
    services.config.hooks?.autoDigest,
    deps.autoDigestEnvOverride
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
      const latest = project ? (latestByProject.get(project.id) ?? null) : null
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
    })
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
  digestMemories: Memory[]
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
  envValue: string | undefined
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

  const longestName = report.rows.reduce((max, row) => Math.max(max, row.name.length), 0)

  const lines: string[] = [header]
  for (const row of report.rows) {
    lines.push(formatDigestRow(row, longestName))
  }
  if (report.truncated) {
    lines.push(`  (showing latest ${DIGEST_LIST_LIMIT} digests; older may be truncated)`)
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
    parts.push("next fire on next Stop hook")
  } else {
    const ageDays = Math.floor(row.markerAgeDays)
    parts.push(`marker ${ageDays}d old`)
    const remaining = DIGEST_STALE_DAYS - row.markerAgeDays
    if (remaining <= 0) {
      parts.push("next fire on next Stop hook")
    } else {
      parts.push(`next fire ~${Math.ceil(remaining)}d`)
    }
  }

  // `${name}:` colon mimics the example in the issue. Pad on the colon-
  // suffixed string so the alignment column starts after the longest name.
  const label = `${row.name}:`.padEnd(longestName + 2)
  return `  ${label}${parts.join(" · ")}`
}

// ---------------------------------------------------------------------------
// Drift section
// ---------------------------------------------------------------------------

/**
 * State surfaced in the Drift section. Single row per vault — the drift
 * marker is keyed on `configRoot`, not project name — so the report
 * collapses to a single age value rather than the per-project list the
 * digest section carries.
 */
export interface DriftStatusReport {
  /**
   * Marker mtime age in days, or `null` when no marker file exists. The
   * loader normalizes `driftMarkerAgeDays`'s `Infinity` sentinel into `null`
   * at this seam so the renderer can show "marker missing" instead of
   * "Infinity days old". `configured: false` is the orthogonal seam for
   * the no-config-root case.
   */
  markerAgeDays: number | null
  /**
   * False when the loader was called without a .lore.yaml config root —
   * the renderer drops the entire section so the output stays clean. Always
   * true when called from `lore status`, since `initServices()` requires a
   * config root to succeed; the seam exists for symmetry with how
   * `loadDigestStatus` suppresses the section on no-sub-projects vaults.
   */
  configured: boolean
}

export interface DriftStatusDeps {
  /**
   * Marker-age probe. Defaults to the real filesystem stat; tests inject a
   * fake to drive the age deterministically.
   */
  markerAge?: (configRoot: string) => Promise<number>
}

/**
 * Gather drift watermark data for the Drift section.
 *
 * Zero Notion calls — the marker is filesystem-only. Returns a report whose
 * rendering is empty when no `configRoot` is provided, matching the
 * digest path's "section omitted entirely" suppression behavior.
 */
export async function loadDriftStatus(
  configRoot: string | null | undefined,
  deps: DriftStatusDeps = {}
): Promise<DriftStatusReport> {
  if (!configRoot) {
    return { markerAgeDays: null, configured: false }
  }
  const markerAge = deps.markerAge ?? driftMarkerAgeDays
  const ageDays = await markerAge(configRoot)
  return {
    markerAgeDays: Number.isFinite(ageDays) ? ageDays : null,
    configured: true,
  }
}

/**
 * Render the Drift section from a loader report. Returns an empty array
 * when `configured` is false so the caller can suppress the entire section
 * with a single length check, mirroring the digest section's contract.
 *
 * Pure function: deterministic in `report`, no I/O.
 */
export function formatDriftStatus(report: DriftStatusReport): string[] {
  if (!report.configured) return []

  const lines: string[] = ["Drift check:"]
  // Defense-in-depth pair with `loadDriftStatus`: non-finite ages
  // (`Infinity`, `NaN`) collapse to the same "marker missing" branch as a
  // genuine `null`, so a future caller constructing a `DriftStatusReport`
  // directly without going through the loader can't render
  // "marker Infinityd old". The loader still does this translation so the
  // rest of `report.markerAgeDays`'s type narrows cleanly to `number`.
  if (report.markerAgeDays === null || !Number.isFinite(report.markerAgeDays)) {
    lines.push("  marker missing · next fire on next debounced session")
    return lines
  }

  const ageDays = Math.floor(report.markerAgeDays)
  const remaining = DRIFT_DEBOUNCE_DAYS - report.markerAgeDays
  if (remaining <= 0) {
    // Matches `resolveDriftCheck`'s `ageDays < DRIFT_DEBOUNCE_DAYS` check —
    // a marker exactly at the boundary fires on the next debounced caller.
    lines.push(`  marker ${ageDays}d old · next fire on next debounced session`)
  } else {
    lines.push(`  marker ${ageDays}d old · next fire ~${Math.ceil(remaining)}d`)
  }
  return lines
}

// ---------------------------------------------------------------------------
// Tracking-predicate preflight
// ---------------------------------------------------------------------------

/**
 * Single-row report on whether the vault still carries facts whose
 * `Predicate` Notion select value is one of the historical tracking
 * predicates (`needs_action`, `waiting_on`, `blocked_by`).
 *
 * `count` is the integer number of live (`Valid Until is_empty`) rows.
 * The renderer treats `0` as the silent path (no warning, byte-identical
 * pre-issue status output) and any non-zero value as the warning path.
 */
export interface TrackingPreflightReport {
  count: number
}

export interface TrackingPreflightDeps {
  /**
   * Predicate-count probe. Defaults to the real
   * `FactService.countByPredicateRaw`; tests inject a fake to drive the
   * count deterministically without standing up a Notion mock.
   */
  countByPredicateRaw?: (strings: string[]) => Promise<number>
}

/**
 * Subset of `LoreServices` the preflight loader actually reads. Lets
 * tests pass a one-method fake instead of the full services object.
 */
export type TrackingPreflightServices = {
  facts: Pick<FactService, "countByPredicateRaw">
}

/**
 * Count live tracking-predicate facts to drive the `lore status`
 * preflight warning. One additional vault-wide Notion query beyond the
 * existing status output — paginated server-side via the predicate
 * probe — and zero `pageToFact` round-trips.
 */
export async function loadTrackingPreflight(
  services: TrackingPreflightServices,
  deps: TrackingPreflightDeps = {}
): Promise<TrackingPreflightReport> {
  const probe =
    deps.countByPredicateRaw ?? services.facts.countByPredicateRaw.bind(services.facts)
  const count = await probe(TRACKING_PREDICATE_PREFLIGHT_VALUES)
  return { count }
}

/**
 * Render the preflight warning. Returns an empty array when `count` is
 * zero so the caller can suppress the entire block with a single
 * length check — same contract shape as `formatDigestStatus` /
 * `formatDriftStatus`.
 *
 * Prose: the tracking predicates are removed from
 * `FactPredicate`, the read paths filter historical rows at
 * `pageToFact`, and the migration command (`lore migrate
 * --migrate-tracking-to-tasks`) has been deleted. Operators who still
 * see this warning are looking at rows lore does not surface;
 * the only remediation paths left are restoring the migration code from
 * git history or hand-editing the Notion rows.
 *
 * Pure function: deterministic in `report`, no I/O.
 */
export function formatTrackingPreflight(report: TrackingPreflightReport): string[] {
  if (report.count <= 0) return []

  const noun = report.count === 1 ? "row" : "rows"
  return [
    `⚠ Tracking-predicate facts detected: ${report.count} live ${noun}.`,
    "  These predicates (`needs_action`, `waiting_on`, `blocked_by`)",
    "  were removed from lore in version 0.6.0.",
    "  The migration command (`lore migrate --migrate-tracking-to-tasks`)",
    "  is no longer available. Remediation options:",
    "  (a) restore the migration code from git history and run it",
    "      manually against your vault, or",
    "  (b) hand-edit the Notion rows to convert them to tasks.",
    "  Until remediated, these rows are invisible to lore.",
  ]
}

// ---------------------------------------------------------------------------
// Confidence summary (DEFERRED-04)
// ---------------------------------------------------------------------------

/**
 * Aggregated `Confidence Score` distribution surfaced as a single line
 * on `lore status` next to the Tasks summary. Memory-side parallel of
 * `TaskStats`'s closure-rate row.
 *
 * `averageScore` is `0` when `scoredMemories === 0`; the renderer
 * suppresses the avg surface in that case rather than rendering
 * `avg 0.00`. The placeholder zero is a typing artifact, not an
 * operator signal.
 */
export interface ConfidenceStatsReport {
  totalMemories: number
  scoredMemories: number
  averageScore: number
  belowThreshold: number
}

/**
 * Render the confidence-summary line from a `ConfidenceStatsReport`.
 *
 * Returns at most one line:
 *
 * - Empty / non-positive `totalMemories` ⇒ `[]` so the caller's single
 *   length check suppresses the line entirely (same contract as
 *   `formatDigestStatus` / `formatDriftStatus` / `formatTrackingPreflight`).
 * - `scoredMemories === 0` ⇒ `Memory confidence: N total, 0 scored`.
 *   Vaults that haven't run `lore migrate --build-confidence-scores`
 *   land here. The `(avg …)`
 *   suffix is suppressed — there is no meaningful average over zero
 *   rows.
 * - `belowThreshold === 0` ⇒
 *   `Memory confidence: N total, M scored (avg X.XX)`. Drops the
 *   trailing `, K below threshold` when nothing is below the
 *   `CONFIDENCE_DISPLAY_THRESHOLD` gate, matching `formatTaskSummary`'s
 *   "only render non-zero substats" posture.
 * - Otherwise ⇒
 *   `Memory confidence: N total, M scored (avg X.XX, K below threshold)`.
 *
 * Average is the arithmetic mean across scored rows, rendered to two
 * decimal places — same precision the Tasks closure rate uses, so
 * the two summary lines read as one visual cluster. Floating-point
 * accumulation can leave the displayed value off by one ULP from the
 * "true" mean on long pagination; the line is signal, not financial,
 * so this is acceptable. The renderer clamps `averageScore` to
 * `[0, 1]` defensively so a ULP drift past 1.0 (or a future caller
 * constructing the report directly with an out-of-band value)
 * cannot render `avg 1.0000…2` or `avg 99.00`.
 *
 * Pure function: deterministic in `report`, no I/O.
 */
export function formatConfidenceSummary(report: ConfidenceStatsReport): string[] {
  if (report.totalMemories <= 0) return []

  // Defense-in-depth on the structural invariants `confidenceStats`
  // upholds — `scoredMemories <= totalMemories`, `belowThreshold <=
  // scoredMemories`, and `0 <= averageScore <= 1`. The loader cannot
  // produce inconsistent values, but a future caller constructing a
  // `ConfidenceStatsReport` directly (a JSON-import test fixture, a
  // hypothetical MCP parallel surface that reuses this renderer)
  // could pass `{ totalMemories: 100, scoredMemories: 200 }` or
  // `{ averageScore: 99 }` and render a structurally impossible line
  // like `(avg 99.00, …)`. Same posture as the negative-
  // `totalMemories` short-circuit above and the
  // `formatTrackingPreflight` non-positive guard. The score clamp
  // also absorbs the FP-mean's ULP drift past 1.0 noted in
  // `MemoryService.confidenceStats`'s docstring.
  const scoredMemories = Math.min(
    Math.max(0, report.scoredMemories),
    report.totalMemories
  )
  const belowThreshold = Math.min(Math.max(0, report.belowThreshold), scoredMemories)
  const averageScore = Math.min(1, Math.max(0, report.averageScore))

  // `Memory confidence:` rather than `Memories:` deliberately —
  // the bare `Memories:` prefix would visually collide with the
  // `Database counts → Memories: N` line two rows above on
  // vaults where archive-rate is low. Two summaries reading as
  // a duplicate count is the failure mode this naming sidesteps.
  let line = `Memory confidence: ${report.totalMemories} total, ${scoredMemories} scored`
  if (scoredMemories > 0) {
    const subStats: string[] = [`avg ${averageScore.toFixed(2)}`]
    if (belowThreshold > 0) {
      subStats.push(`${belowThreshold} below threshold`)
    }
    line += ` (${subStats.join(", ")})`
  }
  return [line]
}

// Proposed-memory inbox — `loadProposedInboxStatus` and
// `formatProposedInboxStatus` live in the core layer so the CLI and
// MCP `lore-context action='status'` surfaces emit the same line for
// the same vault state. Same parity contract as `taskStats` /
// `formatTaskSummary`.
//
// Expiring scoped rows — `loadExpiringScopedStatus` and
// `formatExpiringScopedSummary` live in the core layer for the same
// parity reason.
