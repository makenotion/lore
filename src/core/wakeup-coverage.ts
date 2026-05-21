import type { DecisionSummary, Fact, Memory, TaskSummary } from "../types.js"
import { DEFAULT_DIGEST_FRESHNESS_DAYS } from "./wakeup-constants.js"
import { digestAgeDays, isFreshDigest, sanitizeUserQuery } from "./wakeup-utils.js"

export type WakeUpCoverageMode = "ranked" | "default" | "error"
export type WakeUpRetrievalMode = "full" | "task-only"
export type WakeUpCoverageReason =
  | "no-ranked-search"
  | "already-ranked-for-session"
  | "load-failed"

export interface WakeUpSectionCounts {
  digest: number
  currentTaskMemories: number
  recentMemories: number
  relatedMemories: number
  tasks: number
  knowledgeFacts: number
  decisions: number
  proposedDecisions: number
  overdueDecisions: number
  proposedMemories: number
  staleConfidence: number
}

export interface WakeUpDigestCoverage {
  /** Whether a latest digest row existed, regardless of freshness. */
  available: boolean
  /** Whether that digest was fresh enough by age for full wake-up. */
  fresh: boolean
  /** Age of the latest digest in whole days, or null when absent/future-dated. */
  ageDays: number | null
}

export interface WakeUpCoverageMetrics {
  mode: WakeUpCoverageMode
  /** Full session-start context or narrow current-task-only retrieval. */
  wakeUpMode: WakeUpRetrievalMode
  /** Why ranked retrieval did not produce a normal ranked coverage line. */
  reason?: WakeUpCoverageReason
  /** Length of the sanitized user query. Zero when ranked search did not run. */
  queryLength: number
  digest: WakeUpDigestCoverage
  sectionCounts: WakeUpSectionCounts
}

export interface WakeUpCoverageOverrides extends Omit<
  Partial<WakeUpCoverageMetrics>,
  "digest" | "sectionCounts"
> {
  digest?: Partial<WakeUpDigestCoverage>
  sectionCounts?: Partial<WakeUpSectionCounts>
}

export interface WakeUpCoverageInput {
  wakeUpMode?: WakeUpRetrievalMode
  userQuery?: string
  now?: number
  /** True only when the user-query relevance search actually ran. */
  rankedSearchAttempted?: boolean
  latestDigest: Memory | null
  digestFreshnessDays?: number
  memories: readonly Memory[]
  relatedMemories: readonly Memory[]
  taskMemories: readonly Memory[]
  /** Rendered task count after applying the task section cap. */
  renderedTaskCount?: number
  tasks: readonly TaskSummary[]
  knowledgeFacts: readonly Fact[]
  proposedDecisions: readonly DecisionSummary[]
  overdueDecisions: readonly DecisionSummary[]
  /**
   * Optional so call sites that don't render proposed memories and
   * test fixtures stay structurally compatible. Defaults to `[]`
   * inside `computeWakeUpCoverage` — `sectionCounts.proposedMemories`
   * collapses to zero in that case.
   */
  proposedMemories?: readonly Memory[]
  /**
   * True inbox depth from `MemoryService.countProposed`. When
   * supplied, takes precedence over `proposedMemories.length` for
   * `sectionCounts.proposedMemories` so a deep inbox isn't
   * under-reported by the rendered-slice cap. Optional for the same
   * back-compat reason as `proposedMemories`.
   */
  proposedMemoriesTotal?: number
  staleConfidence: readonly Memory[]
}

export interface WakeUpCoverageCaps {
  memoryLimit?: number
  relatedMemoryLimit?: number
  knowledgeFactLimit?: number
  taskMemoryLimit?: number
}

function emptyWakeUpSectionCounts(): WakeUpSectionCounts {
  return {
    digest: 0,
    currentTaskMemories: 0,
    recentMemories: 0,
    relatedMemories: 0,
    tasks: 0,
    knowledgeFacts: 0,
    decisions: 0,
    proposedDecisions: 0,
    overdueDecisions: 0,
    proposedMemories: 0,
    staleConfidence: 0,
  }
}

export function emptyWakeUpCoverageMetrics(
  mode: Exclude<WakeUpCoverageMode, "ranked">,
  reason: WakeUpCoverageReason,
  wakeUpMode: WakeUpRetrievalMode = "full"
): WakeUpCoverageMetrics {
  return {
    mode,
    wakeUpMode,
    reason,
    queryLength: 0,
    digest: { available: false, fresh: false, ageDays: null },
    sectionCounts: emptyWakeUpSectionCounts(),
  }
}

export function buildEmptyWakeUpCoverage(
  overrides: WakeUpCoverageOverrides = {}
): WakeUpCoverageMetrics {
  return {
    mode: overrides.mode ?? "default",
    wakeUpMode: overrides.wakeUpMode ?? "full",
    reason: overrides.reason,
    queryLength: overrides.queryLength ?? 0,
    digest: {
      available: false,
      fresh: false,
      ageDays: null,
      ...overrides.digest,
    },
    sectionCounts: {
      digest: 0,
      currentTaskMemories: 0,
      recentMemories: 0,
      relatedMemories: 0,
      tasks: 0,
      knowledgeFacts: 0,
      decisions: 0,
      proposedDecisions: 0,
      overdueDecisions: 0,
      proposedMemories: 0,
      staleConfidence: 0,
      ...overrides.sectionCounts,
    },
  }
}

export function computeWakeUpCoverage(input: WakeUpCoverageInput): WakeUpCoverageMetrics {
  const userQuery = sanitizeUserQuery(input.userQuery)
  const ranked = Boolean(userQuery && input.rankedSearchAttempted)
  const wakeUpMode = input.wakeUpMode ?? "full"
  const taskOnly = wakeUpMode === "task-only"
  const proposedDecisionCount = input.proposedDecisions.length
  const overdueDecisionCount = input.overdueDecisions.length
  const taskSectionCount = input.renderedTaskCount ?? input.tasks.length
  const now = input.now ?? Date.now()
  const digestFresh = isFreshDigest(
    input.latestDigest,
    input.digestFreshnessDays ?? DEFAULT_DIGEST_FRESHNESS_DAYS,
    now
  )

  return {
    mode: ranked ? "ranked" : "default",
    wakeUpMode,
    reason: ranked ? undefined : "no-ranked-search",
    queryLength: ranked ? (userQuery?.length ?? 0) : 0,
    digest: {
      available: input.latestDigest !== null,
      fresh: digestFresh,
      ageDays: digestAgeDays(input.latestDigest, now),
    },
    sectionCounts: {
      digest: !taskOnly && digestFresh ? 1 : 0,
      currentTaskMemories: input.taskMemories.length,
      recentMemories: input.memories.length,
      relatedMemories: input.relatedMemories.length,
      tasks: Math.max(0, taskSectionCount),
      knowledgeFacts: input.knowledgeFacts.length,
      // Keep this rollup adjacent to its addends so any new decision bucket
      // updates the aggregate and the per-bucket counters together.
      decisions: proposedDecisionCount + overdueDecisionCount,
      proposedDecisions: proposedDecisionCount,
      overdueDecisions: overdueDecisionCount,
      // Use the true total when threaded; fall back to slice length
      // for callers and tests that don't compute the total. Operators
      // with deep inboxes need to see depth here, not the capped
      // slice — `proposedMemoriesTotal` carries the pre-cap total
      // precisely so the counter doesn't degrade to "≤ slice cap" on
      // large inboxes.
      proposedMemories:
        input.proposedMemoriesTotal ?? input.proposedMemories?.length ?? 0,
      staleConfidence: input.staleConfidence.length,
    },
  }
}

export function formatWakeUpCoverage(
  coverage: WakeUpCoverageMetrics,
  caps: WakeUpCoverageCaps = {}
): string {
  const counts = coverage.sectionCounts
  const parts = [
    "[lore] wakeup:",
    `mode=${coverage.mode}`,
    `shape=${coverage.wakeUpMode}`,
    `ranked=${coverage.mode === "ranked"}`,
  ]

  if (coverage.mode === "ranked") {
    parts.push(`queryLen=${coverage.queryLength}`)
  } else {
    parts.push(`reason=${coverage.reason ?? "no-ranked-search"}`)
  }

  if (caps.memoryLimit !== undefined) parts.push(`memory=${caps.memoryLimit}`)
  if (caps.relatedMemoryLimit !== undefined) {
    parts.push(`related=${caps.relatedMemoryLimit}`)
  }
  if (caps.knowledgeFactLimit !== undefined) {
    parts.push(`knowledge=${caps.knowledgeFactLimit}`)
  }
  if (caps.taskMemoryLimit !== undefined) {
    parts.push(`taskMemories=${caps.taskMemoryLimit}`)
  }

  parts.push(
    `digestAvailable=${coverage.digest.available}`,
    `digestFresh=${coverage.digest.fresh}`,
    `digestAgeDays=${coverage.digest.ageDays ?? "none"}`,
    `sections.digest=${counts.digest}`,
    `sections.currentTask=${counts.currentTaskMemories}`,
    `sections.recent=${counts.recentMemories}`,
    `sections.related=${counts.relatedMemories}`,
    `sections.tasks=${counts.tasks}`,
    `sections.facts=${counts.knowledgeFacts}`,
    `sections.decisions=${counts.decisions}`,
    `sections.proposedDecisions=${counts.proposedDecisions}`,
    `sections.overdueDecisions=${counts.overdueDecisions}`,
    `sections.proposedMemories=${counts.proposedMemories}`,
    `sections.staleConfidence=${counts.staleConfidence}`
  )

  return parts.join(" ")
}

export function formatWakeUpCoverageReport(coverage: WakeUpCoverageMetrics): string[] {
  return ["Wake-up coverage:", `  ${formatWakeUpCoverage(coverage)}`]
}
