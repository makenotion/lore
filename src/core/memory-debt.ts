/**
 * Memory debt scanner.
 *
 * Read-only inventory of maintainability problems across a Lore vault.
 * Walks the same services the conflict scan / wake-up / overdue surfaces
 * already use — `queryStaleConfidence`, `queryOrphans`, `queryOverdue`,
 * `expiringScopedStats`, `findSimilarTopicGroups`, `findConflictCandidates` —
 * and turns the union of their results into prioritized `DebtItem`s with
 * category-specific reasons and suggested remediation commands.
 *
 * The scanner itself is strictly read-only: this module does not mutate
 * any Notion row. `lore debt create-tasks` layers idempotent task
 * creation on top of this report; a future safe-autofix surface is
 * deliberately deferred.
 *
 * Scoring formula (per issue):
 *
 *   score = severityWeight + retrievalRisk + stalenessWeight
 *         + confidenceRisk + governanceRisk
 *
 * The weights are pragmatic starting points; the load-bearing contract is
 * *stable, testable ordering* — a P1 item ranks above every P2, ties
 * break by `(entityType, entityId)` so the JSON report is deterministic
 * across runs over the same vault state.
 */

import { probeScopeColumnsPresent, type LoreServices } from "../services.js"
import { isMissingPropertyError } from "../notion/errors.js"
import type {
  DecisionSummary,
  Fact,
  Memory,
  MemoryKind,
  MemoryWithoutContent,
  TaskSummary,
} from "../types.js"
import {
  CONFIDENCE_DISPLAY_THRESHOLD,
  MS_PER_DAY,
  STALE_CONFIDENCE_DAYS,
  STALE_TASK_DAYS,
} from "../types.js"
import { findConflictCandidates } from "./conflict.js"
import { findSimilarTopicGroups, type SimilarTopicGroup } from "./topic-merge.js"
import { loadExpiringScopedStatus } from "./expiring-scoped.js"
import { taskDaysOverdue, taskDaysStale, todayUtc } from "./task.js"

/**
 * Closed vocabulary of debt categories the scanner emits. New categories
 * land as new enum values, never as free-form strings — the JSON shape is
 * a stable contract for future UI/automation.
 */
export type DebtCategory =
  | "low_trust"
  | "orphan_fact"
  | "ownerless"
  | "duplicate_cluster"
  | "topic_sprawl"
  | "overdue_governance"
  | "scope_anomaly"

/**
 * Three-bucket priority. Maps from the numeric score via
 * `priorityForScore`; serializing the bucket separately keeps consumers
 * from re-deriving it (and silently disagreeing with the renderer) on
 * every read.
 */
export type DebtPriority = "P1" | "P2" | "P3"

/**
 * Stable marker token written into a debt-derived task's `keywords`
 * (and body) so a subsequent `lore debt create-tasks` run can locate
 * the existing row via a contains search and skip recreation
 * (the `lore debt create-tasks` idempotency contract).
 *
 * Format: `lore-debt-id-<debt-id-with-double-colons-flattened>`. The
 * `::` separators in raw debt ids (e.g. `duplicate_cluster::<lo>::<hi>`)
 * would tokenize awkwardly under Notion contains; flattening to `-`
 * keeps the marker a single search-friendly token. The prefix
 * `lore-debt-id-` is deliberately unique enough that the contains
 * search has near-zero false-positive risk against unrelated task
 * titles, keywords, or synopses.
 */
export function debtTaskMarker(debtId: string): string {
  return `lore-debt-id-${debtId.replace(/::/g, "-")}`
}

export const DEBT_CATEGORIES: DebtCategory[] = [
  "low_trust",
  "orphan_fact",
  "ownerless",
  "duplicate_cluster",
  "topic_sprawl",
  "overdue_governance",
  "scope_anomaly",
]

/**
 * Map a numeric debt score to its priority bucket. Single source of
 * truth for the renderer, the create-tasks gate (`P1`/`P2` by default),
 * and any future automation. Thresholds are starting points: P1 ≥ 70
 * captures orphan facts and overdue decisions; P2 ≥ 40 captures
 * duplicates and most low-trust signals; the rest fall to P3.
 */
export function priorityForScore(score: number): DebtPriority {
  if (score >= 70) return "P1"
  if (score >= 40) return "P2"
  return "P3"
}

export interface DebtItem {
  /**
   * Stable, idempotent identifier composed of the category and entity
   * id. `create-tasks` keys on this so re-runs don't mint
   * duplicate task rows.
   */
  id: string
  priority: DebtPriority
  category: DebtCategory
  entityType: "memory" | "fact" | "task" | "decision" | "topic" | "scope"
  /**
   * Notion page id for the offending row, or — for category-level
   * counters with no single row (currently `scope_anomaly`) — a stable
   * synthetic key. Renderers must not assume this is a hyperlinkable
   * Notion id; check `entityType` first.
   */
  entityId: string
  title: string
  /** Final blended score (see module header for the formula). */
  score: number
  /** One human-readable phrase per reason; concatenated under the item in markdown. */
  reasons: string[]
  /**
   * Suggested remediation tokens — short verbs the renderer can expand
   * into command strings. Stable strings so future tooling can match
   * on them (`attach_source`, `archive`, ...).
   */
  suggestedActions: string[]
  /**
   * Forward-compatibility flag for the deferred safe-autofix surface.
   * Always `false` today because the read-only scanner has no autofix
   * path. A future autofix surface will flip selected categories
   * (empty-`rejected` rows older than N days, explicit-operator-input
   * review-date extensions, etc.) to `true`. Callers MUST NOT key
   * behavior off this flag today — it would be a no-op signal.
   * Documented as part of the stable JSON schema so the field's
   * appearance in `--json` output doesn't mislead a future consumer
   * that learns about the autofix surface.
   */
  safeToAutoFix: boolean
  /** Optional project label(s) for the row, when known. */
  projects?: string[]
}

export interface DebtSummary {
  total: number
  p1: number
  p2: number
  p3: number
  byCategory: Record<DebtCategory, number>
}

export interface DebtReport {
  /** Vault-wide when undefined; otherwise the project this scan was scoped to. */
  project: string | undefined
  scannedAt: string
  /** Day anchor (`YYYY-MM-DD`) used for staleness / overdue arithmetic. */
  today: string
  summary: DebtSummary
  items: DebtItem[]
  /**
   * Diagnostic counters surfaced in `--json` so an operator can tell
   * "no items reported" apart from "the scanner couldn't probe that
   * category" (e.g., a vault with no scope columns).
   */
  stats: DebtStats
}

export interface DebtStats {
  staleConfidenceCandidates: number
  orphanFacts: number
  /**
   * `true` when the orphan-fact fetch hit `perCategoryLimit` before
   * Notion was exhausted — more orphans exist past the inspected
   * window. Operators raise `--per-category-limit` to continue.
   */
  orphanFactsCapped: boolean
  overdueDecisions: number
  overdueFacts: number
  overdueTasks: number
  staleTasks: number
  /**
   * `true` when the stale-task probe stopped at `perCategoryLimit`
   * before walking every active task. Operators raise
   * `--per-category-limit` to continue.
   */
  staleTasksScanCapped: boolean
  ownerlessMemories: number
  /**
   * `true` when the ownerless-memory probe stopped at
   * `perCategoryLimit` before walking every memory in scope.
   */
  ownerlessScanCapped: boolean
  duplicateClusterPairs: number
  similarTopicGroups: number
  /**
   * Anomaly count from `loadExpiringScopedStatus`. Three observable
   * shapes:
   *
   *  - **`number`** — probe ran successfully (including `0` for "no
   *    anomalies found").
   *  - **`null`** — probe was attempted AND degraded against a
   *    vault without scope columns (Scope Kind / Expires At missing).
   *    The renderer surfaces a `lore migrate` prompt in this case.
   *  - **`0` with `scopeAnomalyProbeSkipped: true`** — probe was
   *    skipped by a category filter (e.g.
   *    `--category orphan_fact`); the `null` value would collide
   *    semantically with the degraded-probe meaning, so we use the
   *    paired boolean to disambiguate.
   *
   * Old code initialized this to `null` and only mutated inside the
   * `wantCategory("scope_anomaly")` branch — a `--category orphan_fact`
   * scan never entered the branch and silently surfaced a bogus
   * `lore migrate` prompt for vaults that had already migrated.
   */
  scopeAnomalies: number | null
  /**
   * `true` when the scope_anomaly category was filtered out of this
   * scan (the probe never ran). Renderers MUST check this flag
   * before treating `scopeAnomalies === null` as a degraded-probe
   * signal.
   */
  scopeAnomalyProbeSkipped: boolean
  /** Capped scans surface this so the operator knows to raise the limit. */
  truncated: boolean
}

export interface ScanDebtOpts {
  /** Notion project id; omit for vault-wide scan. */
  projectId?: string
  /** Optional human-readable label aligned with `projectId`. */
  projectLabel?: string
  /**
   * When set, restricts the scan to these categories. Empty / undefined
   * runs every category. The unselected categories still contribute a
   * `0` to `summary.byCategory` so the JSON shape stays stable.
   */
  categories?: DebtCategory[]
  /**
   * Soft cap on the number of items the scanner accumulates before
   * truncating. Defaults to 200 — enough for one operator triage pass
   * without overwhelming the markdown view. The truncation is applied
   * AFTER sort so the highest-priority items survive.
   */
  limit?: number
  /**
   * YYYY-MM-DD day anchor for staleness / overdue arithmetic. Defaults
   * to `todayUtc()`. Threaded as a parameter for deterministic tests.
   */
  today?: string
  /**
   * Soft cap on the per-category raw fetch (e.g. number of stale-
   * confidence rows to inspect). Defaults to 200.
   */
  perCategoryLimit?: number
  /**
   * ISO 8601 timestamp stamped onto the `report.scannedAt` field.
   * Defaults to `new Date().toISOString()`. Threaded as a parameter
   * for deterministic JSON snapshot tests — without this seam, the
   * snapshot would need to redact the timestamp on every run.
   */
  scannedAt?: string
}

const DEFAULT_LIMIT = 200
const DEFAULT_PER_CATEGORY_LIMIT = 200

/**
 * Severity weight per category. The starting values match the issue's
 * intuition: orphan facts and overdue governance are P1-leaning by
 * default; topic/entity sprawl is P3-leaning. Tunable in one place so a
 * future operator-tuning pass doesn't have to chase per-detector
 * branches.
 */
const SEVERITY_WEIGHT: Record<DebtCategory, number> = {
  orphan_fact: 55,
  overdue_governance: 35,
  scope_anomaly: 25,
  duplicate_cluster: 25,
  low_trust: 20,
  ownerless: 15,
  topic_sprawl: 15,
}

/** Memory kinds that surface in retrieval more often — weight them up. */
const HIGH_RETRIEVAL_KINDS = new Set<MemoryKind>([
  "decision",
  "policy",
  "state",
  "runbook",
  "postmortem",
])

export async function scanDebt(
  services: LoreServices,
  opts: ScanDebtOpts = {}
): Promise<DebtReport> {
  const today = opts.today ?? todayUtc()
  const limit = opts.limit ?? DEFAULT_LIMIT
  const perCategoryLimit = opts.perCategoryLimit ?? DEFAULT_PER_CATEGORY_LIMIT
  const wantCategory = (c: DebtCategory): boolean =>
    !opts.categories || opts.categories.length === 0 || opts.categories.includes(c)

  const items: DebtItem[] = []
  const stats: DebtStats = {
    staleConfidenceCandidates: 0,
    orphanFacts: 0,
    orphanFactsCapped: false,
    overdueDecisions: 0,
    overdueFacts: 0,
    overdueTasks: 0,
    staleTasks: 0,
    staleTasksScanCapped: false,
    ownerlessMemories: 0,
    ownerlessScanCapped: false,
    duplicateClusterPairs: 0,
    similarTopicGroups: 0,
    // Default to `0` (probe not run, no anomalies observed) rather
    // than `null`. Only the explicit "probe ran and degraded" path
    // below sets `null` so the renderer's `lore migrate` prompt
    // never fires on a category-filtered scan that excluded
    // `scope_anomaly`.
    scopeAnomalies: 0,
    scopeAnomalyProbeSkipped: !wantCategory("scope_anomaly"),
    truncated: false,
  }

  // ---------------------------------------------------------------
  // 1. Low-trust / neglected memories
  //    Reuse MemoryService.queryStaleConfidence, which already encodes
  //    the "score below threshold OR last referenced > STALE_CONFIDENCE_DAYS
  //    ago" predicate that wake-up's Stale Confidence surface uses.
  // ---------------------------------------------------------------
  if (wantCategory("low_trust")) {
    const stale = await services.memories.queryStaleConfidence({
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      limit: perCategoryLimit,
      today,
    })
    stats.staleConfidenceCandidates = stale.length
    for (const m of stale) {
      items.push(buildLowTrustItem(m, today))
    }
  }

  // ---------------------------------------------------------------
  // 2. Orphan / weak-provenance facts
  //    queryOrphans returns facts with empty Source AND empty Valid
  //    Until (still active). Excludes auto-sourced decision-graph
  //    predicates by construction.
  // ---------------------------------------------------------------
  if (wantCategory("orphan_fact")) {
    // Fetch one extra row beyond the budget so a saturated response
    // (`orphans.length > perCategoryLimit`) is an unambiguous signal
    // that more orphans exist past the inspected window. The service
    // breaks early at `limit`, so the extra row costs at most one
    // extra page-end probe.
    const orphans = await services.facts.queryOrphans({
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      limit: perCategoryLimit + 1,
    })
    stats.orphanFactsCapped = orphans.length > perCategoryLimit
    const surfaced = orphans.slice(0, perCategoryLimit)
    stats.orphanFacts = surfaced.length
    for (const f of surfaced) {
      items.push(buildOrphanFactItem(f))
    }
  }

  // ---------------------------------------------------------------
  // 3. Overdue governance — facts, decisions, tasks.
  //    Three distinct service methods, each already encoding the
  //    "Review By <= today AND still active" predicate. Tasks also
  //    contribute "stale active task" rows (no edit in
  //    STALE_TASK_DAYS) via taskDaysStale — same signal the wake-up
  //    Tasks surface uses.
  // ---------------------------------------------------------------
  if (wantCategory("overdue_governance")) {
    const [overdueFacts, overdueDecisions, overdueTasks] = await Promise.all([
      services.facts.queryOverdue({
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        limit: perCategoryLimit,
      }),
      services.decisions.queryOverdue({
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        limit: perCategoryLimit,
      }),
      services.tasks.queryOverdue({
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        limit: perCategoryLimit,
      }),
    ])
    stats.overdueFacts = overdueFacts.length
    stats.overdueDecisions = overdueDecisions.length
    stats.overdueTasks = overdueTasks.length
    for (const f of overdueFacts) {
      items.push(buildOverdueFactItem(f, today))
    }
    for (const d of overdueDecisions) {
      items.push(buildOverdueDecisionItem(d, today))
    }
    for (const t of overdueTasks) {
      items.push(buildOverdueTaskItem(t, today))
    }

    // Stale active tasks — no edit in STALE_TASK_DAYS. We paginate
    // via `nextCursor` until `perCategoryLimit` rows are inspected OR
    // Notion is exhausted, using `sortBy: "updatedAtAsc"` so the
    // oldest-edited rows (the actual stale-task signal) appear first.
    // Without ascending sort, the default review-by triage order can
    // hide stale tasks past the first page, producing a false-clean
    // audit on vaults with many active tasks.
    const staleInspectionBudget = perCategoryLimit
    let staleInspected = 0
    let staleCount = 0
    let staleCursor: string | undefined = undefined
    let staleCapped = false
    // Two explicit bail flags: one fires when the for-loop detects a
    // row past the staleness window (ascending sort makes every later
    // row safe to skip), the other fires when the budget is exhausted.
    // Use named flags instead of overloading `staleCursor === undefined`
    // — that value also encodes the legitimate "first iteration, no
    // cursor yet" case and would otherwise terminate the do-while
    // after page 0.
    let staleBailedFresh = false
    let firstPage = true
    while (firstPage || staleCursor !== undefined) {
      firstPage = false
      if (staleInspected >= staleInspectionBudget) {
        staleCapped = true
        break
      }
      const remainingBudget = staleInspectionBudget - staleInspected
      const page = await services.tasks.list({
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        sortBy: "updatedAtAsc",
        limit: Math.min(100, remainingBudget),
        ...(staleCursor !== undefined ? { startCursor: staleCursor } : {}),
      })
      for (const t of page.items) {
        if (staleInspected >= staleInspectionBudget) {
          staleCapped = true
          break
        }
        staleInspected++
        const stale = taskDaysStale(t, today)
        if (stale === null) continue
        if (stale < STALE_TASK_DAYS) {
          // Ascending updatedAt means every later row is even less
          // stale — safe to stop the whole walk.
          staleBailedFresh = true
          break
        }
        const overdueDays = taskDaysOverdue(t, today)
        // Already surfaced under "overdue" — don't double-report. The
        // overdue branch carries the stronger signal and the same
        // remediation set, so skip the stale duplicate.
        if (overdueDays !== null) continue
        staleCount++
        items.push(buildStaleTaskItem(t, stale))
      }
      if (staleBailedFresh || staleCapped) break
      staleCursor = page.nextCursor
      if (staleCursor !== undefined && staleInspected >= staleInspectionBudget) {
        staleCapped = true
        break
      }
    }
    stats.staleTasks = staleCount
    stats.staleTasksScanCapped = staleCapped
  }

  // ---------------------------------------------------------------
  // 4. Duplicate and near-duplicate clusters
  //    Two complementary signals: trigram pair candidates from
  //    findConflictCandidates (lexical overlap, no LLM); plus topic-key
  //    revision chains via the revisionCount column. The conflict
  //    scanner emits each pair once; we surface the pair as a single
  //    debt item keyed on the unordered pair so re-runs are stable.
  // ---------------------------------------------------------------
  if (wantCategory("duplicate_cluster")) {
    let projectIds: string[]
    let projectLabels: string[]
    if (opts.projectId) {
      projectIds = [opts.projectId]
      projectLabels = [opts.projectLabel ?? opts.projectId]
    } else {
      const all = await services.projects.list("active")
      projectIds = all.map((p) => p.id)
      projectLabels = all.map((p) => p.name)
    }

    if (projectIds.length > 0) {
      const memoriesByProject = await services.memories.listForScan({
        projectIds,
        projectLabels,
        includeBodies: false,
      })
      const seen = new Set<string>()
      let pairs = 0
      for (let i = 0; i < memoriesByProject.length; i++) {
        const memories = memoriesByProject[i]!
        const label = projectLabels[i]!
        const candidates = findConflictCandidates(memories, {
          pairLimit: perCategoryLimit,
        })
        for (const c of candidates) {
          const [lo, hi] =
            c.memoryA.id < c.memoryB.id
              ? [c.memoryA.id, c.memoryB.id]
              : [c.memoryB.id, c.memoryA.id]
          const key = `${lo}::${hi}`
          if (seen.has(key)) continue
          seen.add(key)
          // Skip pairs already judged — already-compared pairs aren't
          // debt, they're resolved relationships. The conflict scan
          // CLI does this server-side; here we read off the row.
          if (
            c.memoryA.comparedWith.includes(c.memoryB.id) ||
            c.memoryB.comparedWith.includes(c.memoryA.id)
          ) {
            continue
          }
          pairs++
          items.push(buildDuplicateClusterItem(c.memoryA, c.memoryB, c.similarity, label))
        }
      }
      stats.duplicateClusterPairs = pairs
    }
  }

  // ---------------------------------------------------------------
  // 5. Topic and entity sprawl
  //    findSimilarTopicGroups returns normalized-equivalent topic
  //    groups (stored names differ but normalize to the same key).
  //    Each group surfaces as one debt item; the suggested action is
  //    a topic-merge dry-run that the operator drives manually.
  // ---------------------------------------------------------------
  if (wantCategory("topic_sprawl")) {
    // Thread `projectId` so a project-scoped audit does not surface
    // similar-topic groups from unrelated projects. When the operator
    // runs `lore debt scan --project Mail`,
    // a Calendar-only topic group must not appear; otherwise a
    // subsequent `lore debt create-tasks --project Mail` would mint a
    // Mail-scoped audit task for Calendar debt.
    const topicGroups = await findSimilarTopicGroups(
      services.client,
      services.vault.databases.topics,
      opts.projectId ? { projectId: opts.projectId } : {}
    )
    stats.similarTopicGroups = topicGroups.length
    for (const group of topicGroups) {
      items.push(buildTopicSprawlItem(group))
    }
  }

  // ---------------------------------------------------------------
  // 6. Scope and lifetime anomalies
  //    expiringScopedStats already aggregates expired / expiringSoon /
  //    narrow-scope-out-of-context counters. We synthesize one debt
  //    item per non-zero counter (not per-row, because the counters
  //    return numbers rather than ids — the row-level surface lives
  //    in `lore status` already).
  // ---------------------------------------------------------------
  if (wantCategory("scope_anomaly")) {
    const scope = await safeLoadExpiringScopedStatus(services, opts.projectId)
    if (scope === null) {
      // Scope columns missing on this vault. Leave the counter at
      // null so JSON consumers can distinguish "couldn't probe" from
      // "no anomalies."
      stats.scopeAnomalies = null
    } else {
      let total = 0
      if (scope.expiredMemories + scope.expiredFacts > 0) {
        const count = scope.expiredMemories + scope.expiredFacts
        total += count
        items.push(
          buildScopeAnomalyItem(
            "expired",
            count,
            scope.expiredMemories,
            scope.expiredFacts
          )
        )
      }
      if (scope.expiringSoonMemories + scope.expiringSoonFacts > 0) {
        const count = scope.expiringSoonMemories + scope.expiringSoonFacts
        total += count
        items.push(
          buildScopeAnomalyItem(
            "expiring_soon",
            count,
            scope.expiringSoonMemories,
            scope.expiringSoonFacts
          )
        )
      }
      if (
        scope.narrowScopeOutOfContextMemories + scope.narrowScopeOutOfContextFacts >
        0
      ) {
        const count =
          scope.narrowScopeOutOfContextMemories + scope.narrowScopeOutOfContextFacts
        total += count
        items.push(
          buildScopeAnomalyItem(
            "out_of_context",
            count,
            scope.narrowScopeOutOfContextMemories,
            scope.narrowScopeOutOfContextFacts
          )
        )
      }
      stats.scopeAnomalies = total
    }
  }

  // ---------------------------------------------------------------
  // 7. Ownerless / unclassifiable memories
  //    We list memories scoped to the project (or vault-wide); flag
  //    rows whose Topic is null in a project with topics. The signal
  //    is intentionally narrow in phase 1: empty Topic where peers
  //    have one. Empty Project on a multi-project vault is already
  //    surfaced by the scope-anomaly category.
  // ---------------------------------------------------------------
  if (wantCategory("ownerless")) {
    // Paginate via `nextCursor` so a vault with many memories does
    // not silently report a false-clean audit. `MemoryService.list`
    // returns at most 100 rows per call and signals truncation via
    // `nextCursor` / `capped`; the single-page form ignored both.
    //
    // Same named-bail-flag posture as the stale-task probe above:
    // `ownerlessCursor === undefined` legitimately means "first
    // iteration, no cursor yet," so we drive the loop with an
    // explicit `firstPage` gate plus a `capped` flag.
    let ownerlessCount = 0
    let ownerlessInspected = 0
    let ownerlessCursor: string | undefined = undefined
    let ownerlessCapped = false
    let firstOwnerlessPage = true
    while (firstOwnerlessPage || ownerlessCursor !== undefined) {
      firstOwnerlessPage = false
      if (ownerlessInspected >= perCategoryLimit) {
        ownerlessCapped = true
        break
      }
      const remaining = perCategoryLimit - ownerlessInspected
      // Explicit type annotation breaks a flow-sensitive inference
      // cycle: `page.nextCursor` is reassigned to `ownerlessCursor` at
      // the bottom of the loop, and the next iteration's call passes
      // `ownerlessCursor` back into `list({ startCursor: ... })`.
      // `MemoryService.list`'s overload-resolved return type depends on
      // the input shape, so TS detects an input → output → input
      // dependency and falls back to `any` unless the receiving
      // variable carries a non-inferred type.
      const page: {
        items: MemoryWithoutContent[]
        nextCursor?: string
        capped: boolean
      } = await services.memories.list({
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        limit: Math.min(100, remaining),
        includeContent: false,
        ...(ownerlessCursor !== undefined ? { startCursor: ownerlessCursor } : {}),
      })
      for (const m of page.items) {
        if (ownerlessInspected >= perCategoryLimit) {
          ownerlessCapped = true
          break
        }
        ownerlessInspected++
        if (m.topicId !== null) continue
        if (m.projectIds.length === 0) continue
        // Repo-wide memories with no topic are normal (vault index
        // notes). Flag only rows in a project where the row is
        // missing both topic AND author/agent attribution.
        if (m.author.length > 0 || m.agent.length > 0) continue
        ownerlessCount++
        items.push(buildOwnerlessItem(m, today))
      }
      if (ownerlessCapped) break
      ownerlessCursor = page.nextCursor
      if (ownerlessCursor !== undefined && ownerlessInspected >= perCategoryLimit) {
        ownerlessCapped = true
        break
      }
    }
    stats.ownerlessMemories = ownerlessCount
    stats.ownerlessScanCapped = ownerlessCapped
  }

  // ---------------------------------------------------------------
  // Sort + truncate + summarize.
  //
  // Order: priority bucket descending (P1 > P2 > P3), then score
  // descending, then category, then entityId. The last two ensure
  // deterministic order under ties so JSON consumers see stable runs.
  // ---------------------------------------------------------------
  items.sort(compareDebtItems)
  if (items.length > limit) {
    stats.truncated = true
    items.length = limit
  }

  const summary: DebtSummary = {
    total: items.length,
    p1: items.filter((i) => i.priority === "P1").length,
    p2: items.filter((i) => i.priority === "P2").length,
    p3: items.filter((i) => i.priority === "P3").length,
    byCategory: emptyByCategory(),
  }
  for (const item of items) {
    summary.byCategory[item.category]++
  }

  return {
    project: opts.projectLabel ?? (opts.projectId ? opts.projectId : undefined),
    scannedAt: opts.scannedAt ?? new Date().toISOString(),
    today,
    summary,
    items,
    stats,
  }
}

function emptyByCategory(): Record<DebtCategory, number> {
  return {
    low_trust: 0,
    orphan_fact: 0,
    ownerless: 0,
    duplicate_cluster: 0,
    topic_sprawl: 0,
    overdue_governance: 0,
    scope_anomaly: 0,
  }
}

function compareDebtItems(a: DebtItem, b: DebtItem): number {
  const priorityRank: Record<DebtPriority, number> = { P1: 0, P2: 1, P3: 2 }
  const pa = priorityRank[a.priority]
  const pb = priorityRank[b.priority]
  if (pa !== pb) return pa - pb
  if (b.score !== a.score) return b.score - a.score
  if (a.category !== b.category) return a.category.localeCompare(b.category)
  return a.entityId.localeCompare(b.entityId)
}

// ---------------------------------------------------------------------------
// Per-category builders
// ---------------------------------------------------------------------------

function buildLowTrustItem(memory: Memory, today: string): DebtItem {
  const reasons: string[] = []
  const confidenceScore = memory.confidenceScore ?? null
  if (confidenceScore !== null && confidenceScore < CONFIDENCE_DISPLAY_THRESHOLD) {
    reasons.push(
      `Confidence Score ${confidenceScore.toFixed(2)} below display threshold ${CONFIDENCE_DISPLAY_THRESHOLD}`
    )
  }
  const daysNeglected = daysSinceLastReferenced(memory, today)
  if (daysNeglected !== null && daysNeglected >= STALE_CONFIDENCE_DAYS) {
    reasons.push(
      `Last referenced ${daysNeglected}d ago (≥ ${STALE_CONFIDENCE_DAYS}d neglect cutoff)`
    )
  }
  if (memory.confidence === "speculative") {
    reasons.push('Categorical confidence is "speculative"')
  }

  const blended =
    SEVERITY_WEIGHT.low_trust +
    retrievalRiskFromMemory(memory, today) +
    stalenessFromNeglect(daysNeglected) +
    confidenceRiskFromScore(confidenceScore) +
    governanceRiskFromKind(memory.kind)

  return {
    id: `low_trust::${memory.id}`,
    priority: priorityForScore(blended),
    category: "low_trust",
    entityType:
      memory.kind === "decision"
        ? "decision"
        : memory.kind === "task"
          ? "task"
          : "memory",
    entityId: memory.id,
    title: memory.title,
    score: Math.round(blended),
    reasons: reasons.length > 0 ? reasons : ["Surfaced by stale-confidence probe"],
    suggestedActions: [
      "review_and_refresh",
      "archive",
      "supersede_with_decision",
      "compare_with_conflicting",
    ],
    safeToAutoFix: false,
    projects: memory.projectIds.length > 0 ? memory.projectIds : undefined,
  }
}

function buildOrphanFactItem(fact: Fact): DebtItem {
  const reasons: string[] = [
    "Source relation is empty",
    "Fact is still active (no Valid Until)",
  ]
  const blended =
    SEVERITY_WEIGHT.orphan_fact +
    retrievalRiskFromFact(fact) +
    confidenceRiskFromFactConfidence(fact.confidence) +
    governanceRiskFromKind("policy") // facts carry policy-shaped governance weight
  return {
    id: `orphan_fact::${fact.id}`,
    priority: priorityForScore(blended),
    category: "orphan_fact",
    entityType: "fact",
    entityId: fact.id,
    title: `${fact.subject} ${fact.predicate} ${fact.object}`,
    score: Math.round(blended),
    reasons,
    suggestedActions: ["attach_source", "invalidate_fact", "recreate_with_provenance"],
    safeToAutoFix: false,
    projects: fact.projectIds.length > 0 ? fact.projectIds : undefined,
  }
}

function buildOverdueFactItem(fact: Fact, today: string): DebtItem {
  const days = daysOverdue(fact.reviewBy, today)
  const reasons = [
    days !== null
      ? `Review By overdue by ${days}d`
      : `Review By overdue (Review By: ${fact.reviewBy ?? "n/a"})`,
    "Fact is still active (no Valid Until)",
  ]
  const blended =
    SEVERITY_WEIGHT.overdue_governance +
    retrievalRiskFromFact(fact) +
    (days !== null ? Math.min(20, days / 3) : 0) +
    confidenceRiskFromFactConfidence(fact.confidence) +
    governanceRiskFromKind("policy")
  return {
    id: `overdue_fact::${fact.id}`,
    priority: priorityForScore(blended),
    category: "overdue_governance",
    entityType: "fact",
    entityId: fact.id,
    title: `${fact.subject} ${fact.predicate} ${fact.object}`,
    score: Math.round(blended),
    reasons,
    suggestedActions: ["review_and_extend", "supersede_or_deprecate", "invalidate_fact"],
    safeToAutoFix: false,
    projects: fact.projectIds.length > 0 ? fact.projectIds : undefined,
  }
}

function buildOverdueDecisionItem(decision: DecisionSummary, today: string): DebtItem {
  const days = daysOverdue(decision.reviewBy, today)
  const reasons = [
    days !== null
      ? `Review By overdue by ${days}d`
      : `Review By overdue (Review By: ${decision.reviewBy ?? "n/a"})`,
    `Status: ${decision.status}`,
  ]
  const blended =
    SEVERITY_WEIGHT.overdue_governance +
    retrievalRiskFromMemory(decision, today) +
    (days !== null ? Math.min(20, days / 3) : 0) +
    confidenceRiskFromScore(decision.confidenceScore) +
    governanceRiskFromKind("decision")
  return {
    id: `overdue_decision::${decision.id}`,
    priority: priorityForScore(blended),
    category: "overdue_governance",
    entityType: "decision",
    entityId: decision.id,
    title: decision.title,
    score: Math.round(blended),
    reasons,
    suggestedActions: ["review_and_extend", "supersede_decision", "deprecate"],
    safeToAutoFix: false,
    projects: decision.projectIds.length > 0 ? decision.projectIds : undefined,
  }
}

function buildOverdueTaskItem(task: TaskSummary, today: string): DebtItem {
  const days = daysOverdue(task.reviewBy, today)
  const reasons = [
    days !== null
      ? `Review By overdue by ${days}d`
      : `Review By overdue (Review By: ${task.reviewBy ?? "n/a"})`,
    `Task state: ${task.taskState ?? "open"}`,
  ]
  if (task.blockedBy && task.blockedBy.length > 0) {
    reasons.push(`Blocked by: ${task.blockedBy}`)
  }
  const blended =
    SEVERITY_WEIGHT.overdue_governance +
    retrievalRiskFromMemory(task, today) +
    (days !== null ? Math.min(20, days / 3) : 0) +
    governanceRiskFromKind("task")
  return {
    id: `overdue_task::${task.id}`,
    priority: priorityForScore(blended),
    category: "overdue_governance",
    entityType: "task",
    entityId: task.id,
    title: task.title,
    score: Math.round(blended),
    reasons,
    suggestedActions: ["close_task", "extend_due_date", "escalate_blocker", "cancel"],
    safeToAutoFix: false,
    projects: task.projectIds.length > 0 ? task.projectIds : undefined,
  }
}

function buildStaleTaskItem(task: TaskSummary, staleDays: number): DebtItem {
  const reasons = [
    `Untouched ${staleDays}d (≥ ${STALE_TASK_DAYS}d stale cutoff)`,
    `Task state: ${task.taskState ?? "open"}`,
  ]
  const blended =
    SEVERITY_WEIGHT.overdue_governance * 0.7 +
    Math.min(15, (staleDays - STALE_TASK_DAYS) / 4) +
    governanceRiskFromKind("task")
  return {
    id: `stale_task::${task.id}`,
    priority: priorityForScore(blended),
    category: "overdue_governance",
    entityType: "task",
    entityId: task.id,
    title: task.title,
    score: Math.round(blended),
    reasons,
    suggestedActions: ["close_task", "cancel", "escalate_blocker"],
    safeToAutoFix: false,
    projects: task.projectIds.length > 0 ? task.projectIds : undefined,
  }
}

function buildDuplicateClusterItem(
  a: Memory,
  b: Memory,
  similarity: number,
  projectLabel: string
): DebtItem {
  const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id]
  const reasons = [
    `Title trigram similarity ${similarity.toFixed(2)}`,
    `Members: "${a.title}" and "${b.title}"`,
    `Project: ${projectLabel}`,
  ]
  const blended =
    SEVERITY_WEIGHT.duplicate_cluster +
    Math.round(similarity * 30) +
    (HIGH_RETRIEVAL_KINDS.has(a.kind) || HIGH_RETRIEVAL_KINDS.has(b.kind) ? 10 : 5)
  return {
    id: `duplicate_cluster::${lo}::${hi}`,
    priority: priorityForScore(blended),
    category: "duplicate_cluster",
    entityType: "memory",
    entityId: lo,
    title: `Duplicate candidates: "${a.title}" ↔ "${b.title}"`,
    score: Math.round(blended),
    reasons,
    suggestedActions: ["compare_memories", "archive_duplicate", "synthesize_canonical"],
    safeToAutoFix: false,
    projects: [projectLabel],
  }
}

function buildTopicSprawlItem(group: SimilarTopicGroup): DebtItem {
  const siblingNames = group.siblings.map((s) => s.name)
  const reasons = [
    `${group.siblings.length + 1} topic rows normalize to the same key`,
    `Canonical: "${group.canonicalName}"`,
    `Siblings: ${siblingNames.map((n) => `"${n}"`).join(", ")}`,
  ]
  const blended = SEVERITY_WEIGHT.topic_sprawl + Math.min(15, group.siblings.length * 4)
  return {
    id: `topic_sprawl::${group.canonicalId}`,
    priority: priorityForScore(blended),
    category: "topic_sprawl",
    entityType: "topic",
    entityId: group.canonicalId,
    title: `Topic sprawl: "${group.canonicalName}" + ${group.siblings.length} similar`,
    score: Math.round(blended),
    reasons,
    suggestedActions: ["merge_topics_dry_run", "normalize_topic_names"],
    safeToAutoFix: false,
  }
}

function buildScopeAnomalyItem(
  kind: "expired" | "expiring_soon" | "out_of_context",
  total: number,
  memoryCount: number,
  factCount: number
): DebtItem {
  const titlePart =
    kind === "expired"
      ? "Expired scoped rows"
      : kind === "expiring_soon"
        ? "Scoped rows expiring soon"
        : "Narrow-scope rows out of context"
  const reasons = [`Memories: ${memoryCount}`, `Facts: ${factCount}`]
  const score =
    SEVERITY_WEIGHT.scope_anomaly +
    (kind === "expired" ? 15 : 0) +
    (kind === "out_of_context" ? 10 : 0) +
    Math.min(20, total)
  return {
    id: `scope_anomaly::${kind}`,
    priority: priorityForScore(score),
    category: "scope_anomaly",
    entityType: "scope",
    entityId: kind,
    title: `${titlePart}: ${total}`,
    score: Math.round(score),
    reasons,
    suggestedActions:
      kind === "expired"
        ? ["archive_expired_memories", "invalidate_expired_facts"]
        : kind === "expiring_soon"
          ? ["review_and_extend", "archive", "invalidate_fact"]
          : ["review_scope_assignment", "narrow_scope", "archive"],
    safeToAutoFix: false,
  }
}

function buildOwnerlessItem(memory: Memory, today: string): DebtItem {
  const reasons: string[] = []
  if (memory.topicId === null) reasons.push("Topic is empty")
  if (memory.author.length === 0 && memory.agent.length === 0) {
    reasons.push("Author and Agent are both empty")
  }
  const blended =
    SEVERITY_WEIGHT.ownerless +
    retrievalRiskFromMemory(memory, today) +
    governanceRiskFromKind(memory.kind)
  return {
    id: `ownerless::${memory.id}`,
    priority: priorityForScore(blended),
    category: "ownerless",
    entityType: "memory",
    entityId: memory.id,
    title: memory.title,
    score: Math.round(blended),
    reasons,
    suggestedActions: [
      "assign_project",
      "assign_topic",
      "convert_to_decision",
      "archive",
    ],
    safeToAutoFix: false,
    projects: memory.projectIds.length > 0 ? memory.projectIds : undefined,
  }
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/**
 * Five Memory fields this helper actually reads. Both `DecisionSummary`
 * and `TaskSummary` already satisfy this shape (they are
 * `Omit<Memory, "content">` projections), so widening the parameter
 * from `Memory` to this structural subset removes the
 * `as unknown as Memory` double-cast at the decision / task call
 * sites without compromising type safety.
 */
type RetrievalRiskInput = Pick<
  Memory,
  "confidence" | "confidenceScore" | "kind" | "projectIds" | "updatedAt"
>

function retrievalRiskFromMemory(memory: RetrievalRiskInput, today: string): number {
  let risk = 0
  if (memory.confidence === "certain") risk += 5
  if (memory.confidenceScore !== null && memory.confidenceScore >= 0.7) {
    risk += 5
  }
  if (HIGH_RETRIEVAL_KINDS.has(memory.kind)) risk += 5
  if (memory.projectIds.length >= 2) risk += 5
  // Recent edits → more likely to be surfaced; widen window to 30 days.
  const days = daysBetween(memory.updatedAt, today)
  if (days !== null && days <= 30) risk += 5
  return risk
}

function retrievalRiskFromFact(fact: Fact): number {
  let risk = 0
  if (fact.confidence === "certain") risk += 5
  if (fact.confidenceScore !== null && (fact.confidenceScore ?? 0) >= 0.7) risk += 5
  if (fact.projectIds.length >= 2) risk += 5
  return risk
}

function stalenessFromNeglect(daysNeglected: number | null): number {
  if (daysNeglected === null) return 0
  if (daysNeglected < STALE_CONFIDENCE_DAYS) return 0
  return Math.min(15, Math.floor((daysNeglected - STALE_CONFIDENCE_DAYS) / 4))
}

function confidenceRiskFromScore(score: number | null | undefined): number {
  if (score === null || score === undefined) return 0
  if (score >= CONFIDENCE_DISPLAY_THRESHOLD) return 0
  // 0.5 → 0, 0 → 15. Linear within [0, threshold).
  return Math.round((CONFIDENCE_DISPLAY_THRESHOLD - score) * 30)
}

function confidenceRiskFromFactConfidence(confidence: Fact["confidence"]): number {
  if (confidence === "speculative") return 8
  if (confidence === "likely") return 4
  return 0
}

function governanceRiskFromKind(kind: MemoryKind): number {
  switch (kind) {
    case "decision":
      return 15
    case "policy":
      return 12
    case "state":
      return 10
    case "runbook":
      return 10
    case "postmortem":
      return 8
    case "task":
      return 5
    default:
      return 0
  }
}

function daysOverdue(reviewBy: string | null, today: string): number | null {
  if (!reviewBy) return null
  const diff = new Date(today).getTime() - new Date(reviewBy).getTime()
  if (!Number.isFinite(diff)) return null
  return Math.max(0, Math.floor(diff / MS_PER_DAY))
}

function daysSinceLastReferenced(memory: Memory, today: string): number | null {
  if (!memory.lastReferencedAt) return null
  const diff = new Date(today).getTime() - new Date(memory.lastReferencedAt).getTime()
  if (!Number.isFinite(diff)) return null
  return Math.max(0, Math.floor(diff / MS_PER_DAY))
}

function daysBetween(iso: string | null | undefined, today: string): number | null {
  if (!iso) return null
  const a = new Date(iso.slice(0, 10)).getTime()
  const b = new Date(today).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.max(0, Math.floor((b - a) / MS_PER_DAY))
}

/**
 * Wrap `loadExpiringScopedStatus` with an **explicit schema probe**
 * so vaults without scope columns degrade to a `null` counter instead
 * of silently reporting a clean scan.
 *
 * **Why the schema probe matters.** `MemoryService.expiringScopedStats`
 * and `FactService.expiringScopedStats` walk `listAllForBackfill`
 * and deserialize each row via the extractor pipeline. On a vault
 * whose data source has no scope columns, the extractors see missing
 * `Scope Kind` / `Expires At` properties as empty values and return
 * `scope: null` without throwing. Counters land at all-zero,
 * `loadExpiringScopedStatus` returns successfully, and the renderer
 * cheerfully reports "no scope anomalies" — which is exactly the
 * false-clean failure mode the `null` sentinel is supposed to
 * prevent. An earlier try/catch shape here assumed the walk would
 * throw on missing columns; it doesn't.
 *
 * The fix is to consult `probeScopeColumnsPresent` (one
 * `dataSources.retrieve` per DB — caller-cached at init time in
 * production) BEFORE walking. If the columns are absent on either
 * the Memories or Facts DB, return null without burning the walk.
 * The shared `isMissingPropertyError`
 * remains as a defensive secondary fallback for any service that
 * does throw — but the load-bearing detection is the explicit
 * schema probe.
 */
async function safeLoadExpiringScopedStatus(
  services: LoreServices,
  projectId: string | undefined
): Promise<Awaited<ReturnType<typeof loadExpiringScopedStatus>> | null> {
  // Transient `dataSources.retrieve` failures (5xx, rate-limit blip)
  // MUST NOT silently degrade to "vault needs migration" — that
  // would print bogus `lore migrate` guidance on a healthy vault
  // during an outage. We deliberately do NOT wrap this in
  // try/catch: errors propagate to the scanner's outer catch and
  // bubble to the operator. Schema-shape errors (missing scope
  // columns) don't throw here — they return `false` from the
  // explicit property check inside `probeScopeColumnsPresent`.
  const columnsPresent = await probeScopeColumnsPresent(
    services.client,
    services.vault.databases
  )
  if (!columnsPresent) return null
  try {
    return await loadExpiringScopedStatus(services, projectId ? { projectId } : {})
  } catch (err) {
    // Defensive fallback: a service that DOES throw a missing-
    // property error on a legacy vault still degrades cleanly.
    // The shared helper checks `code === "validation_error"` AND
    // the message shape, so unrelated "could not find page / data
    // source" errors don't get recast as a migration hint.
    if (isMissingPropertyError(err)) return null
    throw err
  }
}
