/**
 * `lore debt` — memory debt audit and maintenance workflow.
 *
 * Two subcommands today:
 *
 * - `scan`         — Read-only. Walks the same service methods
 *                    the conflict scan and `lore status` already use,
 *                    classifies findings into debt categories, and
 *                    emits a prioritized markdown / JSON report.
 * - `create-tasks` — Idempotent `lore-task` creation for the
 *                    surfaced P1/P2 debt items so memory hygiene folds
 *                    into normal task triage.
 *
 * A future safe-targeted-autofix surface is deliberately deferred;
 * the scanner stays strictly read-only by default.
 */

import { Command } from "commander"
import { initServices, type LoreServices } from "../../services.js"
import { redactDebugError } from "../../debug-redact.js"
import {
  debtTaskMarker,
  scanDebt,
  type DebtCategory,
  type DebtItem,
  type DebtReport,
} from "../../core/memory-debt.js"
import { DEBT_CATEGORIES } from "../../core/memory-debt.js"
import {
  resolveProjectScopeName,
  validateExplicitProjectScopeName,
} from "../../core/project-scope.js"
import { parsePositiveDecimalInteger } from "../parse.js"

interface DebtScanCliOptions {
  projectName: string | undefined
  allProjects: boolean
  limit: number | undefined
  perCategoryLimit: number | undefined
  categories: DebtCategory[] | undefined
  json: boolean
}

interface DebtCreateTasksCliOptions {
  projectName: string | undefined
  allProjects: boolean
  priorityFloor: "P1" | "P2"
  limit: number
  dryRun: boolean
}

function parseDebtScanCliOptions(raw: {
  project?: string
  allProjects?: boolean
  limit?: string
  perCategoryLimit?: string
  category?: string[]
  json?: boolean
}): { ok: true; value: DebtScanCliOptions } | { ok: false; message: string } {
  // Explicit `--project` and `--all-projects` together is ambiguous —
  // the operator either wants one project's debt or every project's;
  // silently picking one would violate the CLI's fail-closed rule for
  // explicit project-scope misses. Reject before parsing the rest so
  // the operator gets a clear error.
  if (raw.project !== undefined && raw.allProjects === true) {
    return {
      ok: false,
      message:
        "--project and --all-projects are mutually exclusive; pass one or the other",
    }
  }
  let limit: number | undefined
  if (raw.limit !== undefined) {
    const parsed = parsePositiveDecimalInteger("--limit", raw.limit)
    if (!parsed.ok) return parsed
    limit = parsed.value
  }
  let perCategoryLimit: number | undefined
  if (raw.perCategoryLimit !== undefined) {
    const parsed = parsePositiveDecimalInteger(
      "--per-category-limit",
      raw.perCategoryLimit
    )
    if (!parsed.ok) return parsed
    perCategoryLimit = parsed.value
  }
  let categories: DebtCategory[] | undefined
  if (raw.category !== undefined && raw.category.length > 0) {
    const unknown: string[] = []
    const accepted: DebtCategory[] = []
    for (const c of raw.category) {
      if ((DEBT_CATEGORIES as string[]).includes(c)) {
        accepted.push(c as DebtCategory)
      } else {
        unknown.push(c)
      }
    }
    if (unknown.length > 0) {
      return {
        ok: false,
        message: `unknown --category value(s): ${unknown.join(", ")}. Valid: ${DEBT_CATEGORIES.join(", ")}`,
      }
    }
    categories = accepted
  }

  return {
    ok: true,
    value: {
      projectName: raw.project,
      allProjects: !!raw.allProjects,
      limit,
      perCategoryLimit,
      categories,
      json: !!raw.json,
    },
  }
}

function parseDebtCreateTasksCliOptions(raw: {
  project?: string
  allProjects?: boolean
  priorityFloor?: string
  limit?: string
  dryRun?: boolean
}): { ok: true; value: DebtCreateTasksCliOptions } | { ok: false; message: string } {
  // Mutually-exclusive parity with `parseDebtScanCliOptions`. Same
  // rationale.
  if (raw.project !== undefined && raw.allProjects === true) {
    return {
      ok: false,
      message:
        "--project and --all-projects are mutually exclusive; pass one or the other",
    }
  }
  let priorityFloor: "P1" | "P2" = "P2"
  if (raw.priorityFloor !== undefined) {
    if (raw.priorityFloor !== "P1" && raw.priorityFloor !== "P2") {
      return {
        ok: false,
        message: `--priority-floor must be P1 or P2 (P3 would create unbounded tasks); got "${raw.priorityFloor}"`,
      }
    }
    priorityFloor = raw.priorityFloor
  }
  let limit = 25
  if (raw.limit !== undefined) {
    const parsed = parsePositiveDecimalInteger("--limit", raw.limit)
    if (!parsed.ok) return parsed
    limit = parsed.value
  }
  return {
    ok: true,
    value: {
      projectName: raw.project,
      allProjects: !!raw.allProjects,
      priorityFloor,
      limit,
      dryRun: !!raw.dryRun,
    },
  }
}

/**
 * Resolve `--project NAME` against the active projects in the vault.
 * Mirrors the conflict scan's resolution shape so error messages stay
 * uniform across the two commands.
 */
async function resolveTargetProject(
  services: LoreServices,
  projectName: string | undefined,
  allProjects: boolean
): Promise<{ id: string; name: string } | undefined> {
  if (allProjects || projectName === undefined) return undefined
  const explicit = validateExplicitProjectScopeName(projectName, "--project", {
    listHint: "run `lore status projects` to list configured projects",
  })
  if (explicit === undefined) return undefined
  const project = await resolveProjectScopeName(
    services.projects,
    explicit,
    "--project",
    { listHint: "run `lore status projects` to list configured projects" }
  )
  return { id: project.id, name: project.name }
}

export function renderDebtMarkdown(report: DebtReport): string {
  const lines: string[] = []
  const scope = report.project ? `project "${report.project}"` : "all projects"
  lines.push(`# Memory Debt — ${scope}`)
  lines.push("")
  lines.push(
    `**Summary:** ${report.summary.total} items (P1: ${report.summary.p1}, P2: ${report.summary.p2}, P3: ${report.summary.p3})`
  )
  lines.push(`**Scanned at:** ${report.scannedAt}`)
  lines.push(`**Day anchor:** ${report.today}`)
  lines.push("")

  // Compute capped / degraded warnings up front so they can attach
  // BOTH to the empty-report path and to the populated path. A
  // partial scan that surfaced zero items because the only debt
  // sits past `--per-category-limit` MUST NOT render as "the vault
  // is clean" — the false-clean signal would mask real debt the
  // operator hasn't paid for yet.
  const cappedCategories: string[] = []
  if (report.stats.orphanFactsCapped) cappedCategories.push("orphan_fact")
  if (report.stats.staleTasksScanCapped)
    cappedCategories.push("overdue_governance (stale-task probe)")
  if (report.stats.ownerlessScanCapped) cappedCategories.push("ownerless")
  // `scopeAnomalies === null` is the degraded-probe signal ONLY when
  // the probe was actually attempted. A category-filtered scan that
  // excluded `scope_anomaly` (`--category orphan_fact`) sets
  // `scopeAnomalyProbeSkipped: true` and reports `0` instead, so the
  // false-clean message and the `lore migrate` prompt don't fire on
  // scans that deliberately skipped the category.
  const scopeProbeDegraded =
    !report.stats.scopeAnomalyProbeSkipped && report.stats.scopeAnomalies === null

  if (report.summary.total === 0) {
    // Honest "partial-clean" wording for both partial-scan branches
    // — capped categories AND degraded scope probe. "The vault is
    // clean" only fires when EVERY probe ran end-to-end. Without
    // this gate, an un-migrated vault with zero non-scope debt would
    // render the same green output as a fully-clean migrated vault,
    // masking the migration prerequisite.
    if (cappedCategories.length > 0) {
      lines.push(
        `No debt detected in the inspected window, BUT the scan was capped for: ${cappedCategories.join(", ")}. More debt may exist past the inspected window — raise \`--per-category-limit\` to continue.`
      )
    } else if (scopeProbeDegraded) {
      lines.push(
        "No debt detected in the inspected window, BUT the scope-anomaly probe degraded (pre-#283 vault). Run `lore migrate` to enable the full audit."
      )
    } else {
      lines.push("No debt detected. The vault is clean.")
    }
    if (scopeProbeDegraded && cappedCategories.length > 0) {
      // Surface the degraded probe alongside the capped warning so
      // the operator sees both prerequisites in one place; the
      // alternate branch above already inlined the degraded message.
      lines.push("")
      lines.push(
        "_Note: scope-anomaly probe degraded (pre-#283 vault — Scope Kind / Expires At columns missing). Run `lore migrate` to enable._"
      )
    }
    lines.push("")
    return lines.join("\n")
  }

  // Group by priority for readability — within priority, the items
  // are already sorted by score / category / id by `scanDebt`.
  for (const priority of ["P1", "P2", "P3"] as const) {
    const slice = report.items.filter((i) => i.priority === priority)
    if (slice.length === 0) continue
    lines.push(`## ${priority} — ${slice.length} item${slice.length === 1 ? "" : "s"}`)
    lines.push("")
    for (const item of slice) {
      lines.push(...renderItemMarkdown(item))
      lines.push("")
    }
  }

  if (report.stats.truncated) {
    lines.push("---")
    lines.push("")
    lines.push(
      `_Output truncated. Raise \`--limit\` to surface more items, or run with \`--category\` to drill into one dimension._`
    )
    lines.push("")
  }
  if (cappedCategories.length > 0) {
    lines.push("---")
    lines.push("")
    lines.push(
      `_Per-category scan window hit \`--per-category-limit\` for: ${cappedCategories.join(", ")}. More debt may exist past the inspected window — raise \`--per-category-limit\` to continue._`
    )
    lines.push("")
  }
  if (scopeProbeDegraded) {
    lines.push("---")
    lines.push("")
    lines.push(
      "_Scope-anomaly probe degraded (pre-#283 vault). Run `lore migrate` to enable the Scope Kind / Expires At columns._"
    )
    lines.push("")
  }

  return lines.join("\n")
}

function renderItemMarkdown(item: DebtItem): string[] {
  const lines: string[] = []
  lines.push(`### ${item.title}`)
  lines.push(
    `- **Category:** \`${item.category}\` · **Score:** ${item.score} · **Type:** ${item.entityType}`
  )
  lines.push(`- **ID:** \`${item.entityId}\``)
  if (item.projects && item.projects.length > 0) {
    lines.push(`- **Projects:** ${item.projects.join(", ")}`)
  }
  if (item.reasons.length > 0) {
    lines.push(`- **Why:**`)
    for (const reason of item.reasons) {
      lines.push(`  - ${reason}`)
    }
  }
  if (item.suggestedActions.length > 0) {
    lines.push(`- **Suggested:** ${item.suggestedActions.join(", ")}`)
  }
  return lines
}

export function renderDebtJson(report: DebtReport): string {
  return JSON.stringify(report, null, 2) + "\n"
}

const scanSubcommand = new Command("scan")
  .description(
    "Inventory memory debt across the vault: low-trust memories, orphan facts, overdue governance, duplicate clusters, topic sprawl, scope anomalies, and ownerless rows."
  )
  .option("-p, --project <name>", "Restrict scan to one project (default: all projects)")
  .option(
    "--all-projects",
    "Scan every active project (default when --project is omitted)"
  )
  .option("-n, --limit <n>", "Cap on total items surfaced after sort (default 200)")
  .option(
    "--per-category-limit <n>",
    "Cap on raw rows fetched per category (default 200)"
  )
  .option(
    "-c, --category <category...>",
    `Restrict to one or more categories. Valid: ${DEBT_CATEGORIES.join(", ")}`
  )
  .option("--json", "Emit JSON instead of human-readable markdown")
  .action(
    async (raw: {
      project?: string
      allProjects?: boolean
      limit?: string
      perCategoryLimit?: string
      category?: string[]
      json?: boolean
    }) => {
      try {
        const parsed = parseDebtScanCliOptions(raw)
        if (!parsed.ok) {
          console.error(`Debt scan failed: ${parsed.message}`)
          process.exit(1)
          return
        }
        const services = await initServices()
        const project = await resolveTargetProject(
          services,
          parsed.value.projectName,
          parsed.value.allProjects
        )
        const report = await scanDebt(services, {
          ...(project ? { projectId: project.id, projectLabel: project.name } : {}),
          ...(parsed.value.limit !== undefined ? { limit: parsed.value.limit } : {}),
          ...(parsed.value.perCategoryLimit !== undefined
            ? { perCategoryLimit: parsed.value.perCategoryLimit }
            : {}),
          ...(parsed.value.categories ? { categories: parsed.value.categories } : {}),
        })
        if (parsed.value.json) {
          process.stdout.write(renderDebtJson(report))
        } else {
          process.stdout.write(renderDebtMarkdown(report))
        }
      } catch (err) {
        console.error("Debt scan failed:", err instanceof Error ? err.message : err)
        process.exit(1)
      }
    }
  )

/**
 * Probe for a pre-existing debt-derived task by its stable marker
 * token. Returns the existing task's id (any state) if found, or `null`.
 *
 * Uses `MemoryService.search` in `contains` mode so the substring
 * filter on `Keywords` is applied server-side. Post-filtered on a
 * literal `keywords` substring as defense in depth — a future schema
 * change that introduces another column-with-similar-text would
 * otherwise risk false positives.
 *
 * **Three search passes, not one per status.** `TaskService.create`
 * does NOT write the `Status` select column when a debt-derived task
 * lands — Notion stores the row with an empty `Status` value. A
 * search with `status: "informational"` would filter via Notion's
 * server-side `select equals informational`, which does NOT match an
 * empty select. The earlier per-status iteration shape silently
 * missed the exact rows the command had just created and let a
 * rerun mint duplicates. The three passes here cover the full
 * Status space:
 *
 *  - **Default pass** (`includeProposed` left default-false, no
 *    `status` filter): Notion applies `does_not_equal: "proposed"`
 *    AND `does_not_equal: "rejected"`. An empty `Status` select
 *    passes both (`does_not_equal` is permissive on null), so this
 *    pass covers `informational`, `accepted`, `deprecated`,
 *    `superseded`, AND empty — the exact shape `TaskService.create`
 *    produces.
 *  - **Proposed pass** (`status: "proposed"`): explicit `equals`
 *    overrides the default exclusion and surfaces proposed rows.
 *  - **Rejected pass** (`status: "rejected"`): same, for rejected
 *    audit rows the operator explicitly rejected.
 *
 * Searches across all task states (including `done` / `cancelled`)
 * deliberately: an operator who closed a previous debt task closed it
 * for a reason, and the idempotency contract honors that decision.
 * Re-running create-tasks should not re-mint a closed audit row.
 */
export async function findExistingDebtTask(
  services: LoreServices,
  item: DebtItem,
  projectId: string | undefined
): Promise<string | null> {
  const marker = debtTaskMarker(item.id)
  const baseQuery = {
    query: marker,
    mode: "contains" as const,
    kind: "task" as const,
    ...(projectId ? { projectId } : {}),
    includeContent: false,
    limit: 5,
  }
  // Order matters only for short-circuit latency: the default pass
  // covers the most common case (a debt task created by this command
  // with empty Status) and lets the probe return without firing the
  // proposed / rejected passes.
  const probes = [
    baseQuery,
    { ...baseQuery, status: "proposed" as const },
    { ...baseQuery, status: "rejected" as const },
  ]
  const seen = new Set<string>()
  for (const probe of probes) {
    const matches = await services.memories.search(probe)
    for (const m of matches) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      if (typeof m.keywords === "string" && m.keywords.includes(marker)) {
        return m.id
      }
    }
  }
  return null
}

const createTasksSubcommand = new Command("create-tasks")
  .description(
    "Create one lore-task per surfaced debt item. Idempotent by debt id: " +
      "re-running skips items whose audit task already exists in the vault " +
      "(any state). Defaults to P1/P2 only and 25 items per run; raise " +
      "--limit deliberately. Exits non-zero on per-item failure."
  )
  .option("-p, --project <name>", "Restrict to one project")
  .option("--all-projects", "Process every active project")
  .option(
    "--priority-floor <level>",
    "P1 surfaces only the highest-severity debt; P2 includes most actionable items (default P2)"
  )
  .option("-n, --limit <n>", "Cap on tasks created per run (default 25)")
  .option("--dry-run", "Show the tasks that would be created without writing to Notion")
  .action(
    async (raw: {
      project?: string
      allProjects?: boolean
      priorityFloor?: string
      limit?: string
      dryRun?: boolean
    }) => {
      try {
        const parsed = parseDebtCreateTasksCliOptions(raw)
        if (!parsed.ok) {
          console.error(`Debt create-tasks failed: ${parsed.message}`)
          process.exit(1)
          return
        }
        const services = await initServices()
        const project = await resolveTargetProject(
          services,
          parsed.value.projectName,
          parsed.value.allProjects
        )
        const report = await scanDebt(services, {
          ...(project ? { projectId: project.id, projectLabel: project.name } : {}),
        })
        const eligible = report.items.filter((item) => {
          if (parsed.value.priorityFloor === "P1") return item.priority === "P1"
          return item.priority === "P1" || item.priority === "P2"
        })
        const slice = eligible.slice(0, parsed.value.limit)

        if (slice.length === 0) {
          process.stdout.write(
            `No ${parsed.value.priorityFloor}-or-higher debt to surface as tasks.\n`
          )
          return
        }

        // Preflight: probe every eligible debt item for an existing
        // audit task with the stable marker token. Skips collapse onto
        // the existing row instead of creating a duplicate (idempotency
        // contract). The preflight runs even under --dry-run so the
        // plan output names reuse outcomes too.
        type PlanRow = {
          item: DebtItem
          action: "create" | "reuse"
          existingTaskId: string | null
        }
        const plan: PlanRow[] = []
        for (const item of slice) {
          const existing = await findExistingDebtTask(services, item, project?.id)
          plan.push({
            item,
            action: existing === null ? "create" : "reuse",
            existingTaskId: existing,
          })
        }

        // Plan-line prefix carries the action so dry-run output and
        // applied-run output stay distinguishable on a glance — a
        // bare `DRY-RUN task:` would force the operator to read the
        // parenthetical to learn whether the line is a create or a
        // reuse.
        const planLines: string[] = []
        for (const row of plan) {
          const verb = row.action === "reuse" ? "REUSE" : "CREATE"
          const prefix = parsed.value.dryRun ? `DRY-RUN ${verb}` : verb
          if (row.action === "reuse") {
            planLines.push(
              `${prefix} task: [${row.item.priority}/${row.item.category}] "${row.item.title}" (existing ${row.existingTaskId})`
            )
          } else {
            planLines.push(
              `${prefix} task: [${row.item.priority}/${row.item.category}] "${row.item.title}" (${row.item.entityId})`
            )
          }
        }
        process.stdout.write(planLines.join("\n") + "\n")

        const toCreate = plan.filter((p) => p.action === "create")
        const reused = plan.length - toCreate.length

        if (parsed.value.dryRun) {
          const wouldNoun = toCreate.length === 1 ? "task" : "tasks"
          const reusedNoun = reused === 1 ? "task" : "tasks"
          process.stdout.write(
            `\n--dry-run: would create ${toCreate.length} ${wouldNoun}, reuse ${reused} ${reusedNoun}.\n`
          )
          return
        }

        let created = 0
        let failed = 0
        for (const { item } of toCreate) {
          const subject = `[debt:${item.category}] ${item.title}`.slice(0, 200)
          const description = renderDebtTaskBody(item)
          const marker = debtTaskMarker(item.id)
          try {
            await services.tasks.create({
              subject,
              description,
              ...(project ? { projectIds: [project.id] } : {}),
              entity: item.entityId,
              tags: ["audit"],
              // `keywords` carries the marker token the preflight
              // probes against. Order matters only for human-
              // readability; Notion's contains search is substring.
              keywords: `${marker} debt-${item.category} ${item.entityId}`,
            })
            created++
          } catch (err) {
            failed++
            process.stderr.write(
              `  ! failed to create task for ${item.entityId}: ${redactDebugError(err)}\n`
            )
          }
        }
        const createdNoun = created === 1 ? "task" : "tasks"
        const reusedNoun = reused === 1 ? "task" : "tasks"
        process.stdout.write(
          `\nCreated ${created} ${createdNoun}, reused ${reused} ${reusedNoun}.\n`
        )
        if (failed > 0) {
          const failedNoun = failed === 1 ? "task" : "tasks"
          // Partial-failure contract: per-item create failures must
          // not let the command exit `0` and let automation treat
          // an incomplete maintenance pass as clean. The non-zero
          // exit pairs with the per-item stderr lines above so a
          // script consumer sees both the count and the cause.
          process.stderr.write(
            `Debt create-tasks: ${failed} ${failedNoun} failed to create; exit 1.\n`
          )
          process.exit(1)
          return
        }
      } catch (err) {
        console.error(
          "Debt create-tasks failed:",
          err instanceof Error ? err.message : err
        )
        process.exit(1)
      }
    }
  )

function renderDebtTaskBody(item: DebtItem): string {
  const lines: string[] = []
  lines.push(`Debt ID: \`${item.id}\``)
  lines.push(`Priority: ${item.priority}`)
  lines.push(`Category: ${item.category}`)
  lines.push(`Score: ${item.score}`)
  lines.push(`Source: \`${item.entityType}\` row \`${item.entityId}\``)
  lines.push("")
  lines.push("## Why")
  for (const reason of item.reasons) {
    lines.push(`- ${reason}`)
  }
  lines.push("")
  lines.push("## Suggested remediation")
  for (const action of item.suggestedActions) {
    lines.push(`- ${action}`)
  }
  return lines.join("\n")
}

export const debtCommand = new Command("debt")
  .description("Memory debt audit and maintenance workflow (issue #288)")
  .addCommand(scanSubcommand)
  .addCommand(createTasksSubcommand)
