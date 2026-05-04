/**
 * Wake-up data loading — shared by the MCP
 * `lore-context action='wake-up'` tool and the shell wake-up hook.
 *
 * When a project has a recently saved digest (source = "digest"), wake-up
 * surfaces that digest as the primary context and trims the raw-memory
 * list underneath it. A digest is a condensed, project-scoped summary and
 * is a denser starting point than N individual memory entries.
 *
 * Wake-up also pulls "related memories": memories that match the entities
 * already surfaced as active tasks, via a single relevance-ranked semantic
 * search. Seed phrases come from active task subjects — signal the user
 * wrote with intent — joined into one query so Notion's vector index
 * scores memory titles AND bodies against the union. This handles the
 * realistic case where task subjects read like phrases (e.g. "PR
 * #25650 label.applied classifier") that do not appear verbatim in memory
 * titles but are semantically adjacent to the explaining memory.
 *
 * When the caller has the user's first message (P3-05: hook fires on
 * `UserPromptSubmit`, not `SessionStart`), passing it via `userQuery`
 * fires an additional relevance search seeded by that message. The hits
 * surface as `taskMemories`, deduped against digest + recent + related,
 * so the most-relevant-to-the-current-task memories aren't buried under
 * timestamp-ordered or task-seeded sections.
 */

import type {
  DecisionSummary,
  Fact,
  ListDecisionsOpts,
  ListTasksOpts,
  Memory,
  MemorySource,
  MemoryKind,
  MemoryStatus,
  TaskSummary,
} from "../types.js"
import { MS_PER_DAY, STALE_CONFIDENCE_LIMIT, STALE_TASK_DAYS } from "../types.js"
import { taskDaysOverdue, taskDaysStale } from "./task.js"
import { computeWakeUpCacheKey, WakeUpCache } from "./wakeup-cache.js"

export { WakeUpCache, computeWakeUpCacheKey }
// Re-exported so existing callers that import `MS_PER_DAY` from
// `wakeup.ts` keep working — the canonical declaration moved to
// `types.ts` (issue 0.8.0/#10 follow-up) so day-arithmetic across
// services shares one source of truth.
export { MS_PER_DAY }

export const DEFAULT_WAKEUP_MEMORY_LIMIT = 10
export const DEFAULT_WAKEUP_MEMORY_LIMIT_WITH_DIGEST = 3
export const DEFAULT_DIGEST_FRESHNESS_DAYS = 7
/**
 * Safety cap on rendered knowledge facts. A long-lived project can accumulate
 * hundreds of facts; wake-up surfaces the most recent ones to stay useful
 * without blowing the consumer's context budget.
 */
export const DEFAULT_WAKEUP_KNOWLEDGE_FACT_LIMIT = 25
/**
 * Cap on related-memory results. Wake-up is on the hot path; a handful of
 * targeted memories is the right budget — more and the section buries the
 * digest.
 */
export const DEFAULT_WAKEUP_RELATED_MEMORY_LIMIT = 5
/**
 * Cap on tasks rendered in wake-up's Tasks section. Mirrors the spec's
 * "Tasks section capped at 10" guidance and the `lore-task action='list'`
 * per-section default — a triage list, not an inventory.
 */
export const DEFAULT_WAKEUP_TASK_LIMIT = 10
/**
 * Cap on task-memory results — memories matched against the user's first
 * message via semantic search. Distinct from `taskLimit` (which bounds
 * structured `Kind = task` tasks): this caps the count of *memories*
 * surfaced under the "For Your Current Task" relevance section.
 * Tighter than `relatedMemoryLimit` because relevance ranking (Notion
 * vector index against the user's actual question) carries more signal-
 * per-row than open-loop-seeded matches. Three is the spec's recommended
 * default.
 */
export const DEFAULT_WAKEUP_TASK_MEMORY_LIMIT = 3
/**
 * Cap on the proposed-memory inbox section rendered at session start
 * (issue #281, AC #2). Mirrors the `proposedDecisions` cap of 20: a
 * triage surface, not an inventory. Operators with deeper inbox depth
 * see the full count surfaced via `WakeUpSectionCounts.proposedMemories`
 * + `lore status`'s Proposed memories line; the wake-up section caps
 * to keep the prompt budget bounded.
 */
export const DEFAULT_WAKEUP_PROPOSED_MEMORY_LIMIT = 20
/**
 * Per-section caps applied when the caller passes a non-empty `userQuery`
 * and hasn't overridden the section explicitly. Tighter than the
 * surface-default caps above because relevance-ranked top hits carry more
 * signal-per-row than timestamp-ordered recents — a smaller bundle yields
 * better wake-up density. Values come straight from the P3-05 spec.
 *
 * Shared across both wake-up surfaces (`src/hooks/helpers.ts` and
 * `src/mcp/tools/context.ts`) so the prompt-budget contract stays
 * identical regardless of which surface fired wake-up. A caller-supplied
 * value still wins — these are defaults, not ceilings.
 *
 * The MCP tool layers `COLLAPSE_OVERFETCH_MULTIPLIER` on top of these
 * caps to leave headroom for topical collapse before the cluster slice;
 * the hook applies them flat because it skips collapse. Both surfaces
 * end up rendering the same number of visible rows for the same input.
 *
 * `taskMemoryLimit` matches the no-query default deliberately — the
 * task-memory section only renders when `userQuery` is set, so the
 * default cap and the ranked cap are the same number.
 *
 * `memoryLimitWithDigest` is pinned explicitly rather than letting the
 * digest branch fall back to `DEFAULT_WAKEUP_MEMORY_LIMIT_WITH_DIGEST`.
 * Without it, the no-digest branch follows the ranked cap while the
 * digest branch follows an unrelated constant — a future tightening of
 * `memoryLimit` would silently desync the two intra-surface branches and
 * across surfaces. Pinning both branches in one place keeps the contract
 * "ranked wake-up renders this many memory rows" true regardless of
 * whether a fresh digest exists.
 */
export const RANKED_WAKEUP_LIMITS = {
  memoryLimit: 3,
  memoryLimitWithDigest: 3,
  relatedMemoryLimit: 2,
  knowledgeFactLimit: 10,
  taskMemoryLimit: DEFAULT_WAKEUP_TASK_MEMORY_LIMIT,
} as const
/**
 * Hard cap on `userQuery` length before it's sent to the search API.
 * A user pasting an entire log file or transcript would otherwise either
 * blow Notion's query-string budget or drown the relevance signal in
 * noise. 1000 chars is the spec's recommendation — long enough to capture
 * a multi-sentence task description, short enough to keep the
 * vector-index hit set focused.
 */
const MAX_USER_QUERY_LENGTH = 1000
/**
 * Notion's hard ceiling on rows returned from a single `list` call. We scale
 * the related-memory fetch window up to this bound so large `relatedLimit`
 * callers aren't silently starved — the service layer (`MemoryService.list`)
 * already clamps here, but stating it at the call site keeps the scaling
 * formula self-documenting.
 */
const NOTION_PAGE_SIZE = 100

/**
 * Multiplier applied to `taskLimit` when the data layer fetches each active
 * task bucket for wake-up. The renderer caps each bucket at `taskLimit`; 4×
 * leaves room to report hidden lower-bound counts while keeping every query
 * to one Notion page.
 */
const WAKEUP_TASK_OVERFETCH_MULTIPLIER = 4

/**
 * Compute the per-bucket row cap for wake-up task queries. Single source of
 * truth shared by `loadWakeUpData` and the MCP renderer's saturation
 * fallback. Returns `0` when `taskLimit` is `0` or negative — the caller
 * skips task queries entirely in that case.
 *
 * The result stays bounded by Notion's per-page ceiling so each bucket is
 * predictable on the wake-up hot path.
 */
export function computeTasksFetchLimit(taskLimit: number): number {
  return taskLimit > 0
    ? Math.min(NOTION_PAGE_SIZE, taskLimit * WAKEUP_TASK_OVERFETCH_MULTIPLIER)
    : 0
}
/** Upper bound on entity-name seeds passed into the `titleAny` filter. */
const MAX_ENTITY_CANDIDATES = 10
/** Skip entity strings shorter than this — too noisy to match on. */
const MIN_ENTITY_LENGTH = 3

/**
 * Structural contract for the services wake-up needs. Both the real
 * `MemoryService` / `FactService` / `DecisionService` classes and test
 * stubs satisfy this shape.
 */
export interface WakeUpServices {
  memories: {
    list(opts: {
      projectId?: string
      source?: MemorySource
      status?: MemoryStatus
      excludeKinds?: MemoryKind[]
      limit?: number
      includeContent?: boolean
      includeUnscoped?: boolean
      includeProposed?: boolean
      sortBy?: "created_time" | "last_edited_time"
      direction?: "ascending" | "descending"
    }): Promise<{ items: Memory[]; nextCursor?: string }>
    search(input: {
      query: string
      projectId?: string
      limit?: number
      includeContent?: boolean
      mode?: "contains" | "semantic" | "hybrid"
    }): Promise<Memory[]>
    /**
     * Surfaces low-score-or-long-neglected memories for the Stale
     * Confidence wake-up subsection (0.8.0/#10). Required on the
     * structural type so the type system catches "I forgot to wire
     * the new method" at compile time rather than letting it
     * silently degrade to an empty section at runtime. Hook callers
     * skip the query via `includeStaleConfidence: false`, NOT by
     * omitting the method — every consumer of `WakeUpServices` must
     * implement it.
     */
    queryStaleConfidence(opts: {
      projectId?: string
      limit: number
      today: string
    }): Promise<Memory[]>
    /**
     * True proposed-memory inbox depth (issue #281). Required on the
     * structural type so the type system catches a forgotten wiring
     * — same posture as `queryStaleConfidence`. Hook callers skip
     * the query via `includeProposedMemories: false` /
     * `proposedMemoryLimit: 0`, NOT by omitting the method.
     */
    countProposed(opts: { projectId?: string }): Promise<{
      total: number
      bySource: Record<string, number>
      byAgent: Record<string, number>
    }>
  }
  facts: {
    listRecent(opts: {
      projectId?: string
      limit?: number
    }): Promise<{ items: Fact[]; hasMore: boolean }>
  }
  decisions: {
    list(opts?: ListDecisionsOpts): Promise<{ items: DecisionSummary[]; nextCursor?: string }>
    queryOverdueWindow?(opts?: {
      projectId?: string
      limit?: number
    }): Promise<{ items: DecisionSummary[]; capped: boolean }>
    queryOverdue(opts?: {
      projectId?: string
      limit?: number
    }): Promise<DecisionSummary[]>
  }
  tasks: {
    list(
      opts?: ListTasksOpts
    ): Promise<{ items: TaskSummary[]; nextCursor?: string; capped?: boolean }>
  }
}

export interface WakeUpTaskBucketCoverage {
  overdueCapped: boolean
  staleCapped: boolean
  activeCapped: boolean
}

export type WakeUpCoverageMode = "ranked" | "default" | "error"
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
  /** Whether that digest was fresh enough to render in wake-up. */
  fresh: boolean
  /** Age of the latest digest in whole days, or null when absent/future-dated. */
  ageDays: number | null
}

export interface WakeUpCoverageMetrics {
  mode: WakeUpCoverageMode
  /** Why ranked retrieval did not produce a normal ranked coverage line. */
  reason?: WakeUpCoverageReason
  /** Length of the sanitized user query. Zero when ranked search did not run. */
  queryLength: number
  digest: WakeUpDigestCoverage
  sectionCounts: WakeUpSectionCounts
}

export interface WakeUpCoverageOverrides
  extends Omit<Partial<WakeUpCoverageMetrics>, "digest" | "sectionCounts"> {
  digest?: Partial<WakeUpDigestCoverage>
  sectionCounts?: Partial<WakeUpSectionCounts>
}

export interface WakeUpCoverageInput {
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
   * Optional so pre-Phase-2 (issue #281) call sites and test
   * fixtures stay structurally compatible. Defaults to `[]` inside
   * `computeWakeUpCoverage` — `sectionCounts.proposedMemories`
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
): WakeUpCoverageMetrics {
  return {
    mode,
    reason,
    queryLength: 0,
    digest: { available: false, fresh: false, ageDays: null },
    sectionCounts: emptyWakeUpSectionCounts(),
  }
}

export interface WakeUpOptions {
  projectId?: string
  /** Max non-digest memories when no fresh digest exists. */
  memoryLimit?: number
  /** Max non-digest memories when a fresh digest is surfaced. */
  memoryLimitWithDigest?: number
  /** Max age in days for a digest to still count as "fresh". */
  digestFreshnessDays?: number
  /** Max rendered knowledge facts. */
  knowledgeFactLimit?: number
  /** Max related memories. */
  relatedMemoryLimit?: number
  /**
   * Max active tasks (Kind = task) surfaced in the Tasks section.
   * `0` skips the Notion query entirely. Tasks are the canonical
   * surface for tracked work.
   */
  taskLimit?: number
  /**
   * The user's first message text. When set, wake-up fires an additional
   * relevance search seeded by this text and surfaces the hits as the
   * `taskMemories` section. Empty / whitespace-only strings are treated
   * as absent (no extra search, `taskMemories` returns `[]`). Truncated
   * to 1000 chars before search to bound query size and keep the vector
   * index focused.
   *
   * P3-05: when this is provided, the hook caller should also tighten
   * the per-section caps (recent: 3, related: 2, knowledge: 10) —
   * relevance-ranked top hits carry more weight than timestamp ordering,
   * so a smaller bundle yields better wake-up signal density.
   */
  userQuery?: string
  /**
   * Max memories surfaced for the user's current task. Honored only when
   * `userQuery` is non-empty. Defaults to 3 (`DEFAULT_WAKEUP_TASK_MEMORY_LIMIT`).
   */
  taskMemoryLimit?: number
  /**
   * When false, fetch recent memories without their markdown body.
   * Used by hook wake-up which only renders title/date. The digest memory
   * is always fetched with content since it IS the content.
   */
  includeMemoryContent?: boolean
  /**
   * When false, skip the proposed + overdue decision queries. The hook
   * wake-up path renders no decision sections, so it has no reason to
   * pay the two Notion round-trips on every session start. Defaults to
   * true so MCP callers (which DO render decisions) keep working.
   */
  includeDecisions?: boolean
  /**
   * When false, skip the Stale Confidence query (0.8.0/#10). The shell
   * hook never renders the section, so it has no reason to pay the
   * extra Notion round-trip on every session start. Defaults to true
   * so MCP callers (which DO render the section) keep working. Same
   * posture as `includeDecisions`.
   */
  includeStaleConfidence?: boolean
  /**
   * When false, skip the proposed-memory inbox query (issue #281,
   * AC #2). The shell hook never renders the section, so it has no
   * reason to pay the extra Notion round-trip on every session
   * start. Defaults to true so MCP callers (which DO render the
   * section) keep working. Same posture as `includeDecisions` /
   * `includeStaleConfidence`.
   */
  includeProposedMemories?: boolean
  /**
   * Override the proposed-memory inbox section cap. Defaults to
   * `DEFAULT_WAKEUP_PROPOSED_MEMORY_LIMIT` (20). Pass `0` to skip
   * the query without touching `includeProposedMemories`.
   */
  proposedMemoryLimit?: number
  /**
   * When true, compute privacy-conscious wake-up coverage counters for
   * observability surfaces (`LORE_DEBUG=1` hook logging and MCP
   * `lore-context action='wake-up' debug: true`). Defaults to false so
   * normal wake-up callers do not pay for counters they do not render.
   */
  includeCoverage?: boolean
  /**
   * Anchor date (`YYYY-MM-DD`) for the Stale Confidence query's
   * neglect cutoff and the renderer's `Nd ago` arithmetic. Threaded
   * from the caller so the query and the render see the exact same
   * day — without this, a wake-up that crosses UTC midnight between
   * fetch and render would compute the cutoff against one day and the
   * rendered age against the next. Optional; defaults to
   * `new Date(now).toISOString().slice(0, 10)`.
   */
  todayDate?: string
  /** Override Date.now() for testing. */
  now?: number
  /**
   * Process-local result cache (issue #495). When supplied,
   * `loadWakeUpData` consults it before fan-out and stores the
   * computed result on the way out. Bumping `cache.bumpEpoch()` on
   * every MCP write action invalidates stale entries so a save +
   * wake-up sequence re-fetches; entries also expire on a 30s TTL
   * as a hard staleness ceiling.
   *
   * The long-running MCP server is the only surface that lands
   * repeated cache hits. One-shot processes (CLI, hooks) thread the
   * cache through `loadWakeUpData` for shape uniformity but never
   * see a hit because they exit before the next caller arrives —
   * cross-process sharing is a follow-up. See `WakeUpCache`'s header
   * docstring for the full surface picture.
   */
  cache?: WakeUpCache
}

export interface WakeUpData {
  /** Fresh project digest, if one exists within the freshness window. */
  digest: Memory | null
  /** Non-digest memories to surface underneath the digest. */
  memories: Memory[]
  /** Knowledge facts, capped at `knowledgeFactLimit`. */
  knowledgeFacts: Fact[]
  /** Proposed decisions awaiting resolution (project-scoped). */
  proposedDecisions: DecisionSummary[]
  /** Active decisions past their review-by date (project-scoped). */
  overdueDecisions: DecisionSummary[]
  /** True when the overdue-decision scan hit its safety cap. */
  overdueDecisionsCapped: boolean
  /**
   * Memories relevance-matched against the entities surfaced in active
   * tasks via one semantic search (Notion's vector index scores both
   * titles and page bodies against the seed query). Deduped against
   * `digest` and `memories` so the same page never renders twice. Empty
   * when there are no active tasks to seed from.
   */
  relatedMemories: Memory[]
  /**
   * Active task memories (Kind = task), fetched via bounded per-bucket
   * windows so a large due-dated set cannot starve Stale / Active rows.
   * Ordered Overdue, Stale, Active so flat renderers still lead with the
   * strongest urgency signal.
   *
   * Flat-rendering callers should slice this array to `taskLimit`
   * before iterating; bucketed renderers should bucket first and
   * slice each bucket to `taskLimit`.
   */
  tasks: TaskSummary[]
  /** Whether any task bucket hit its bounded fetch window. */
  taskBucketCoverage: WakeUpTaskBucketCoverage
  /**
   * Memories relevance-matched against the user's first message
   * (`userQuery`). Notion's vector index scores titles AND bodies against
   * the (possibly truncated) query. Deduped against `digest`, `memories`,
   * AND `relatedMemories` so the same page never renders across the three
   * memory sections. Empty when `userQuery` was absent or whitespace-only.
   */
  taskMemories: Memory[]
  /**
   * Memories awaiting review (`Status = proposed`) — the wake-up
   * surface of the proposed-memory inbox (issue #281, AC #2).
   * Project-scoped when `projectId` is supplied, vault-wide
   * otherwise. Capped at `PROPOSED_MEMORY_LIMIT` so a large inbox
   * cannot dominate wake-up; the count surfaces in
   * `WakeUpSectionCounts.proposedMemories` so an operator sees the
   * total even when the rendered slice is capped.
   *
   * Disjoint by construction: this section is the only surface that
   * sees `Status = proposed` rows; every other section applies the
   * default-exclude added by Phase 2 of issue #281. No id-dedup
   * needed. Empty when the option `includeProposedMemories` is
   * false (hook path) or no proposed rows exist for the requested
   * scope. Sorted oldest-first so stale review debt surfaces ahead
   * of recent additions.
   */
  proposedMemories: Memory[]
  /**
   * True proposed-memory inbox depth — `MemoryService.countProposed`'s
   * total, NOT `proposedMemories.length` (which is the rendered
   * slice capped at `proposedMemoryLimit`). Surfaced separately so
   * the section heading and `WakeUpSectionCounts.proposedMemories`
   * reflect inbox depth on operators-most-at-risk-of-nudge-fatigue
   * — a 25-row inbox with a 20-row cap renders as
   * `(25 pending review)`, not `(20 pending review)`.
   */
  proposedMemoriesTotal: number
  /**
   * Memories scored below `CONFIDENCE_DISPLAY_THRESHOLD` OR with
   * `Last Referenced At` past the `STALE_CONFIDENCE_DAYS` cutoff
   * (0.8.0/#10). Sorted by score ascending, capped at
   * `STALE_CONFIDENCE_LIMIT`. Empty when the option
   * `includeStaleConfidence` is false (hook path) or the underlying
   * service does not implement the optional `queryStaleConfidence`
   * method. NOT deduped against the other memory sections — a row
   * surfacing in Recent and in Stale Confidence is meaningful: it
   * tells the agent the row is recent AND triage-worthy.
   */
  staleConfidence: Memory[]
  /**
   * Privacy-conscious wake-up coverage counters for observability and
   * on-demand status surfaces. Null unless `includeCoverage` was requested.
   * Counts track rendered section rows; the data layer caps flat-rendered task
   * counts, and renderers that collapse or re-bucket rows must adjust affected
   * counts before logging or rendering debug output.
   */
  coverage: WakeUpCoverageMetrics | null
}

export function buildEmptyWakeUpCoverage(
  overrides: WakeUpCoverageOverrides = {},
): WakeUpCoverageMetrics {
  return {
    mode: overrides.mode ?? "default",
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
  const proposedDecisionCount = input.proposedDecisions.length
  const overdueDecisionCount = input.overdueDecisions.length
  const taskSectionCount = input.renderedTaskCount ?? input.tasks.length
  const now = input.now ?? Date.now()
  const digestFresh = isFreshDigest(
    input.latestDigest,
    input.digestFreshnessDays ?? DEFAULT_DIGEST_FRESHNESS_DAYS,
    now,
  )

  return {
    mode: ranked ? "ranked" : "default",
    reason: ranked ? undefined : "no-ranked-search",
    queryLength: ranked ? userQuery?.length ?? 0 : 0,
    digest: {
      available: input.latestDigest !== null,
      fresh: digestFresh,
      ageDays: digestAgeDays(input.latestDigest, now),
    },
    sectionCounts: {
      digest: digestFresh ? 1 : 0,
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
      // for pre-#281 callers and tests that don't compute the total.
      // Operators with deep inboxes need to see depth here, not the
      // capped slice — see `WakeUpData.proposedMemoriesTotal`'s
      // docstring.
      proposedMemories:
        input.proposedMemoriesTotal ?? input.proposedMemories?.length ?? 0,
      staleConfidence: input.staleConfidence.length,
    },
  }
}

export function formatWakeUpCoverage(
  coverage: WakeUpCoverageMetrics,
  caps: WakeUpCoverageCaps = {},
): string {
  const counts = coverage.sectionCounts
  const parts = [
    "[lore] wakeup:",
    `mode=${coverage.mode}`,
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
    `sections.staleConfidence=${counts.staleConfidence}`,
  )

  return parts.join(" ")
}

export function formatWakeUpCoverageReport(
  coverage: WakeUpCoverageMetrics,
): string[] {
  return ["Wake-up coverage:", `  ${formatWakeUpCoverage(coverage)}`]
}

export async function loadWakeUpData(
  services: WakeUpServices,
  opts: WakeUpOptions = {},
): Promise<WakeUpData> {
  const cache = opts.cache
  if (cache) {
    // `todayDate` must be defaulted into the cache key so a wake-up
    // cached just before UTC midnight cannot serve a snapshot just
    // after midnight under the same key — the data layer's effective
    // `todayDate` would have advanced (driving stale-confidence
    // cutoffs and `Nd ago` arithmetic) but a key built from raw
    // `opts` would collide. `lore-context action='status'` and the
    // hook wake-up path both omit `todayDate` and rely on this
    // defaulting. Mirrors the same `now → todayDate` derivation
    // applied below for the fan-out.
    const now = opts.now ?? Date.now()
    const effectiveTodayDate =
      opts.todayDate ?? new Date(now).toISOString().slice(0, 10)
    const keyOpts: WakeUpOptions = { ...opts, todayDate: effectiveTodayDate }
    const cacheKey = computeWakeUpCacheKey(keyOpts)
    // Capture the start epoch BEFORE dispatch — see
    // `WakeUpCache.currentEpoch`'s docstring for the sandwich
    // contract. `getOrLoad` collapses concurrent cold-start callers
    // onto a single fan-out so a SessionStart and UserPromptSubmit
    // firing close together cost one wake-up, not two.
    const startEpoch = cache.currentEpoch
    return cache.getOrLoad(cacheKey, startEpoch, () =>
      runWakeUpFanOut(services, opts, now, effectiveTodayDate),
    )
  }

  const now = opts.now ?? Date.now()
  const todayDate = opts.todayDate ?? new Date(now).toISOString().slice(0, 10)
  return runWakeUpFanOut(services, opts, now, todayDate)
}

async function runWakeUpFanOut(
  services: WakeUpServices,
  opts: WakeUpOptions,
  now: number,
  todayDate: string,
): Promise<WakeUpData> {
  const projectId = opts.projectId
  const memoryLimit = opts.memoryLimit ?? DEFAULT_WAKEUP_MEMORY_LIMIT
  const memoryLimitWithDigest =
    opts.memoryLimitWithDigest ?? DEFAULT_WAKEUP_MEMORY_LIMIT_WITH_DIGEST
  const freshnessDays = opts.digestFreshnessDays ?? DEFAULT_DIGEST_FRESHNESS_DAYS
  const knowledgeLimit = opts.knowledgeFactLimit ?? DEFAULT_WAKEUP_KNOWLEDGE_FACT_LIMIT
  const relatedLimit = opts.relatedMemoryLimit ?? DEFAULT_WAKEUP_RELATED_MEMORY_LIMIT
  const taskLimit = opts.taskLimit ?? DEFAULT_WAKEUP_TASK_LIMIT
  const taskMemoryLimit = opts.taskMemoryLimit ?? DEFAULT_WAKEUP_TASK_MEMORY_LIMIT
  const includeContent = opts.includeMemoryContent ?? true
  const includeDecisions = opts.includeDecisions ?? true
  const includeStaleConfidence = opts.includeStaleConfidence ?? true
  const includeProposedMemories = opts.includeProposedMemories ?? true
  const proposedMemoryLimit =
    opts.proposedMemoryLimit ?? DEFAULT_WAKEUP_PROPOSED_MEMORY_LIMIT
  const userQuery = sanitizeUserQuery(opts.userQuery)

  // Request one extra memory so we can drop a digest entry without running
  // short after filtering.
  //
  // Knowledge facts load as one targeted single-page query bounded by
  // `knowledgeLimit`. Server-side filters collapse that to one Notion
  // page per session start.
  //
  // The task-memories search runs in the same `Promise.all` as the other
  // queries so its latency overlaps with the existing wake-up fan-out
  // instead of stacking on top. Only fire when scoped to a project AND
  // the user query is present — without scope the relevance hits would
  // come from arbitrary projects, and without a query there's nothing to
  // seed.
  //
  // Over-fetch accounting: `taskMemories` dedupes against the union of
  // (digest, `memories`, `relatedMemories`). Worst case those sets are
  // disjoint and every task candidate collides with one of them, so the
  // slack must cover the maximum cardinality of each:
  //   - `1` — at most one digest memory.
  //   - `memoryLimit` — upper bound on `memories`. We use the no-digest
  //     ceiling rather than `memoryLimitWithDigest` because the digest
  //     branch is mutually exclusive with the no-digest branch, so adding
  //     `1 + memoryLimit` over-counts by `memoryLimit - memoryLimitWithDigest`
  //     in the digest case. The over-count is harmless (we already cap
  //     at `NOTION_PAGE_SIZE`) and keeps the slack independent of whether
  //     a digest is fresh — without that the slack would have to be
  //     recomputed after the digest probe lands, which would either
  //     require the parallel fan-out to wait for the digest query or
  //     pessimise the slack by always assuming the looser case anyway.
  //   - `relatedLimit` — upper bound on `relatedMemories`.
  // Bounded by Notion's per-page ceiling so this hot-path query never
  // paginates.
  const taskFetchSlack = 1 + memoryLimit + relatedLimit
  const taskFetchLimit =
    userQuery && taskMemoryLimit > 0
      ? Math.min(NOTION_PAGE_SIZE, taskMemoryLimit + taskFetchSlack)
      : 0
  const rankedSearchAttempted = Boolean(projectId && userQuery && taskFetchLimit > 0)
  // Fetch active tasks through bounded per-bucket windows instead of one
  // due-date-sorted window. Notion sorts null `Review By` dates after
  // dated rows, so one active due-dated cluster can otherwise fill the
  // whole wake-up task budget before null-date Stale / Active rows appear.
  // The three bucket queries run in the same fan-out below, each capped by
  // `computeTasksFetchLimit(taskLimit)` so latency remains predictable.
  const tasksFetchLimit = computeTasksFetchLimit(taskLimit)
  // `taskCandidates: Memory[]` — annotated explicitly because this is the
  // only entry in the fan-out whose two arms (a real `services.memories.search`
  // call vs. `Promise.resolve([])`) produce identical shapes by coincidence
  // rather than by a `{ items, ... }` envelope. The annotation makes the
  // contract obvious for the next reader and pins the resolution shape if
  // `MemoryService.search`'s return type ever changes.
  // Stale Confidence (0.8.0/#10): single-page query, runs in parallel
  // with the rest of the fan-out so the section costs no extra wall-
  // clock. Hook callers turn it off via `includeStaleConfidence:
  // false` (the hook never renders the section); the method itself is
  // required on `WakeUpServices` so the type system catches "I forgot
  // to wire the new method" at compile time rather than letting a
  // missing implementation silently surface as an empty section.
  // Vault-wide wake-up (`projectId === undefined`) also fires the
  // query — `queryStaleConfidence` skips the project filter in that
  // branch.
  const staleConfidenceQuery = includeStaleConfidence
    ? services.memories.queryStaleConfidence({
        projectId,
        limit: STALE_CONFIDENCE_LIMIT,
        today: todayDate,
      })
    : Promise.resolve([] as Memory[])

  // Proposed-memory inbox surface (issue #281, AC #2). Two parallel
  // queries: a slice (rendered as the section body, sorted oldest-
  // first so stale review debt surfaces ahead of recent additions)
  // and a count (the true inbox depth, surfaced in the section
  // heading + `WakeUpSectionCounts.proposedMemories` so an operator
  // sees `(25 pending review)` even when only 20 fit in the
  // section).
  //
  // Both Notion round-trips overlap with the rest of the wake-up
  // fan-out so they cost no extra wall-clock. Hook callers turn the
  // pair off via `includeProposedMemories: false`; the numeric
  // escape `proposedMemoryLimit: 0` skips both without changing the
  // boolean. Vault-wide wake-up (`projectId === undefined`) also
  // fires the queries — `MemoryService.list` /
  // `MemoryService.countProposed` skip the project filter in that
  // branch, matching the `MemoryService.confidenceStats` /
  // `queryStaleConfidence` posture.
  const includeProposedSection =
    includeProposedMemories && proposedMemoryLimit > 0
  const proposedMemoriesQuery = includeProposedSection
    ? services.memories.list({
        projectId,
        status: "proposed",
        // `excludeKinds: ["decision"]` mirrors `proposedMemoryFilter()`'s
        // `Kind != decision` clause so the slice and the count surface
        // the SAME row set. Without this, a proposed-Kind-`decision`
        // row would render in the section body but `countProposed`
        // (and the section heading driven by `proposedMemoriesTotal`)
        // would exclude it — heading-vs-slice drift the
        // single-source-of-truth helper exists to prevent. The
        // `lore-decision action='accept'` / `'supersede'` flow is the
        // canonical lifecycle for proposed-state decisions, not the
        // memory inbox.
        excludeKinds: ["decision"],
        limit: proposedMemoryLimit,
        includeContent,
        sortBy: "created_time",
        direction: "ascending",
      })
    : Promise.resolve({ items: [] as Memory[] })
  const proposedMemoriesTotalQuery = includeProposedSection
    ? services.memories.countProposed({ projectId })
    : Promise.resolve({
        total: 0,
        bySource: {} as Record<string, number>,
        byAgent: {} as Record<string, number>,
      })

  const [
    { items: rawMemories },
    { items: latestDigestList },
    { items: knowledgeFacts },
    { items: proposedDecisions },
    overdueDecisionWindow,
    taskWindow,
    taskCandidates,
    staleConfidence,
    { items: proposedMemories },
    { total: proposedMemoriesTotal },
  ]: [
    { items: Memory[] },
    { items: Memory[] },
    { items: Fact[]; hasMore: boolean },
    { items: DecisionSummary[] },
    { items: DecisionSummary[]; capped: boolean },
    { tasks: TaskSummary[]; coverage: WakeUpTaskBucketCoverage },
    Memory[],
    Memory[],
    { items: Memory[] },
    {
      total: number
      bySource: Record<string, number>
      byAgent: Record<string, number>
    },
  ] = await Promise.all([
    memoryLimit > 0 || memoryLimitWithDigest > 0
      ? services.memories.list({
          projectId,
          limit: memoryLimit + 1,
          includeContent,
        })
      : // Both memory limits are zero — render no memories regardless of
        // whether a digest exists. Skip the Notion query rather than
        // fetching `memoryLimit + 1 = 1` row only to slice it away.
        // Mirrors the gate pattern on the sibling fact / task / task-
        // candidate arms so every limit-bearing query in the fan-out
        // shares the same `0 = skip` discipline.
        Promise.resolve({ items: [] as Memory[] }),
    projectId
      ? // Sort by creation so freshness (`createdAt`) aligns with "latest":
        // an edit to an older digest must not mask a newer one.
        services.memories.list({
          projectId,
          source: "digest",
          limit: 1,
          includeUnscoped: false,
          sortBy: "created_time",
        })
      : Promise.resolve({ items: [] as Memory[] }),
    projectId && knowledgeLimit > 0
      ? services.facts.listRecent({
          projectId,
          limit: knowledgeLimit,
        })
      : Promise.resolve({ items: [] as Fact[], hasMore: false }),
    projectId && includeDecisions
      ? services.decisions.list({ projectId, status: "proposed", limit: 20 })
      : Promise.resolve({ items: [] as DecisionSummary[] }),
    projectId && includeDecisions
      ? queryOverdueDecisionWindow(services.decisions, { projectId })
      : Promise.resolve({ items: [] as DecisionSummary[], capped: false }),
    projectId && tasksFetchLimit > 0
      ? loadWakeUpTaskWindow(services.tasks, {
          projectId,
          today: todayDate,
          limit: tasksFetchLimit,
        })
      : Promise.resolve({
          tasks: [] as TaskSummary[],
          coverage: emptyTaskBucketCoverage(),
        }),
    projectId && userQuery && taskFetchLimit > 0
      ? services.memories.search({
          query: userQuery,
          projectId,
          limit: taskFetchLimit,
          includeContent,
        })
      : Promise.resolve([] as Memory[]),
    staleConfidenceQuery,
    proposedMemoriesQuery,
    proposedMemoriesTotalQuery,
  ])
  const tasks = taskWindow.tasks
  const overdueDecisions = overdueDecisionWindow.items

  const latestDigest = latestDigestList[0] ?? null
  const digest = isFreshDigest(latestDigest, freshnessDays, now) ? latestDigest : null

  const digestCreatedAt = digest ? new Date(digest.createdAt).getTime() : null
  const nonDigestMemories = rawMemories.filter((m) => {
    if (m.source === "digest") return false
    if (digestCreatedAt === null) return true
    return new Date(m.createdAt).getTime() > digestCreatedAt
  })
  const effectiveLimit = digest ? memoryLimitWithDigest : memoryLimit
  const memories = nonDigestMemories.slice(0, effectiveLimit)

  // Related memories: seed from active task entities, dedupe against the
  // memories + digest we already plan to render. Skip the round-trip when
  // there are no active tasks or no project scope — there's nothing to seed
  // from and wake-up runs every session.
  const alreadySurfaced = new Set<string>()
  if (digest) alreadySurfaced.add(digest.id)
  for (const mem of memories) alreadySurfaced.add(mem.id)

  let relatedMemories: Memory[] = []
  if (projectId && tasks.length > 0 && relatedLimit > 0) {
    const entities = extractTaskEntities(tasks)
    if (entities.length > 0) {
      // Scale the candidate pool so dedupe doesn't starve the section: at
      // worst every hit collides with an already-surfaced memory (digest +
      // recents), so `relatedLimit + alreadySurfaced.size` candidates are
      // enough to guarantee `relatedLimit` survivors. Bounded by Notion's
      // per-query row cap.
      const fetchLimit = Math.min(
        NOTION_PAGE_SIZE,
        relatedLimit + alreadySurfaced.size,
      )
      // Join entities into a single relevance query so Notion's vector
      // index scores memory titles AND bodies against the union. This is
      // strictly more permissive than substring title matching — task
      // subjects like "PR #25650 outlook label.applied classifier" are
      // phrase-shaped, not bare entity names, and only relevance ranking
      // finds the "PR #25650 label.applied classifier: false positives…"
      // memory that explains them.
      //
      // `mode: "semantic"` is explicit (rather than relying on the default
      // hybrid) because the contains leg of hybrid will mostly miss for
      // phrase-shaped seed queries — running it would just add a Notion
      // round-trip per wake-up before the inevitable semantic fallback
      // fires. The cost saving is one round-trip per session start.
      const candidates = await services.memories.search({
        query: entities.join(" "),
        projectId,
        limit: fetchLimit,
        includeContent,
        mode: "semantic",
      })
      relatedMemories = candidates
        .filter((m) => !alreadySurfaced.has(m.id))
        .slice(0, relatedLimit)
    }
  }

  // Task memories: rank against the user's first message. Dedupe against
  // digest + recents AND against `relatedMemories` so the same page
  // never renders across the three memory sections. The candidate set
  // was already fetched in the parallel fan-out above; this is just the
  // dedupe + slice. An empty `taskCandidates` (no project, no query, or
  // a query that produced zero hits) yields `taskMemories: []`.
  //
  // The task search and the related-memories search both fire when both
  // signals are present — `userQuery` AND open loops. When the user's
  // query is itself about an active open loop (the common case for first
  // prompts), the two queries seed adjacent vector neighborhoods and may
  // overlap topically. We dedupe by id, not by topic, so adjacent-but-
  // distinct memories survive both sections; the hook caps
  // `relatedMemoryLimit: 2` on the ranked path to keep the overlap from
  // dominating prompt budget. Suppressing the related-memory search
  // when `userQuery` is present is intentionally NOT done here — the
  // user query reflects the current message, but the open loops reflect
  // the project's active work, and the two are not always the same
  // (a user can ask about anything, and the related section keeps active-
  // work context visible regardless). Future tuning may add a topical-
  // overlap suppression heuristic; pin tests in `wakeup.test.ts` first
  // before wiring it.
  const taskMemories: Memory[] = []
  if (taskCandidates.length > 0 && taskMemoryLimit > 0) {
    const taskSurfaced = new Set(alreadySurfaced)
    for (const mem of relatedMemories) taskSurfaced.add(mem.id)
    for (const candidate of taskCandidates) {
      if (taskSurfaced.has(candidate.id)) continue
      taskMemories.push(candidate)
      if (taskMemories.length >= taskMemoryLimit) break
    }
  }

  const coverage = opts.includeCoverage
    ? computeWakeUpCoverage({
        userQuery,
        now,
        rankedSearchAttempted,
        latestDigest,
        digestFreshnessDays: freshnessDays,
        memories,
        relatedMemories,
        taskMemories,
        renderedTaskCount: taskLimit > 0 ? Math.min(tasks.length, taskLimit) : 0,
        tasks,
        knowledgeFacts,
        proposedDecisions,
        overdueDecisions,
        proposedMemories,
        proposedMemoriesTotal,
        staleConfidence,
      })
    : null

  return {
    digest,
    memories,
    knowledgeFacts,
    proposedDecisions,
    overdueDecisions,
    overdueDecisionsCapped: overdueDecisionWindow.capped,
    relatedMemories,
    tasks,
    taskBucketCoverage: taskWindow.coverage,
    taskMemories,
    proposedMemories,
    proposedMemoriesTotal,
    staleConfidence,
    coverage,
  }
}

async function loadWakeUpTaskWindow(
  tasks: WakeUpServices["tasks"],
  opts: { projectId: string; today: string; limit: number },
): Promise<{ tasks: TaskSummary[]; coverage: WakeUpTaskBucketCoverage }> {
  // Three bounded windows are intentional. Notion gives one sort order
  // per query, while wake-up needs the soonest overdue rows, the oldest
  // non-overdue rows for Stale, and the newest non-overdue rows for
  // Active. Collapsing these would reintroduce the null-date starvation
  // this loader exists to prevent.
  const [overdueWindow, staleCandidatesWindow, activeCandidatesWindow] =
    await Promise.all([
      tasks.list({
        projectId: opts.projectId,
        dueBefore: opts.today,
        limit: opts.limit,
        sortBy: "reviewByAsc",
      }),
      tasks.list({
        projectId: opts.projectId,
        dueAfterOrEmpty: opts.today,
        limit: opts.limit,
        sortBy: "updatedAtAsc",
      }),
      tasks.list({
        projectId: opts.projectId,
        dueAfterOrEmpty: opts.today,
        limit: opts.limit,
        sortBy: "updatedAtDesc",
      }),
    ])

  const overdue = overdueWindow.items.filter(
    (task) => taskDaysOverdue(task, opts.today) !== null,
  )
  const stale = staleCandidatesWindow.items.filter((task) => {
    if (taskDaysOverdue(task, opts.today) !== null) return false
    const staleDays = taskDaysStale(task, opts.today)
    return staleDays !== null && staleDays >= STALE_TASK_DAYS
  })
  const active = activeCandidatesWindow.items.filter((task) => {
    if (taskDaysOverdue(task, opts.today) !== null) return false
    const staleDays = taskDaysStale(task, opts.today)
    return staleDays === null || staleDays < STALE_TASK_DAYS
  })

  return {
    tasks: dedupeTaskBuckets([overdue, stale, active]),
    coverage: {
      overdueCapped: taskWindowCapped(overdueWindow),
      // Candidate-window saturation alone is not enough for Stale /
      // Active lower-bound claims. Because the two candidate queries
      // sort away from the opposite bucket, a saturated window with
      // fewer than `limit` survivors means later pages cannot fill that
      // bucket.
      staleCapped:
        taskWindowCapped(staleCandidatesWindow) &&
        stale.length >= opts.limit,
      activeCapped:
        taskWindowCapped(activeCandidatesWindow) &&
        active.length >= opts.limit,
    },
  }
}

function dedupeTaskBuckets(buckets: TaskSummary[][]): TaskSummary[] {
  // Current filters make overlap structurally impossible, but keep the
  // merge defensive against future filter loosening, timezone edge cases,
  // or eventual-consistency duplicates from Notion.
  const seen = new Set<string>()
  const merged: TaskSummary[] = []
  for (const bucket of buckets) {
    for (const task of bucket) {
      if (seen.has(task.id)) continue
      seen.add(task.id)
      merged.push(task)
    }
  }
  return merged
}

function taskWindowCapped(
  window: { items: TaskSummary[]; nextCursor?: string; capped?: boolean },
): boolean {
  return Boolean(window.capped || window.nextCursor)
}

function emptyTaskBucketCoverage(): WakeUpTaskBucketCoverage {
  return {
    overdueCapped: false,
    staleCapped: false,
    activeCapped: false,
  }
}

async function queryOverdueDecisionWindow(
  decisions: WakeUpServices["decisions"],
  opts: { projectId?: string },
): Promise<{ items: DecisionSummary[]; capped: boolean }> {
  if (typeof decisions.queryOverdueWindow === "function") {
    return decisions.queryOverdueWindow(opts)
  }
  return { items: await decisions.queryOverdue(opts), capped: false }
}

/**
 * Normalize a caller-supplied user query: trim, drop empty/whitespace-only
 * inputs, truncate to 1000 chars. Returning `undefined` means "no query"
 * — the caller shouldn't fire the extra search and `taskMemories` stays
 * empty.
 *
 * Truncation is naive at the codepoint level (`slice(0, MAX_USER_QUERY_LENGTH)`),
 * not word- or sentence-aware. Notion's relevance ranking is robust to
 * mid-word cuts, and a smarter trim would risk dropping a critical late-
 * clause keyword (`"... causing the OOM in classifier.ts:213"`) for
 * cosmetic reasons. We do strip a trailing UTF-16 high surrogate post-
 * slice: a user paste with non-BMP characters (emoji, certain CJK)
 * landing on the 1000-char boundary would otherwise produce a lone
 * surrogate, which is invalid UTF-16 and a malformed prefix of the
 * user's actual input.
 */
function sanitizeUserQuery(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.length <= MAX_USER_QUERY_LENGTH) return trimmed
  return trimmed.slice(0, MAX_USER_QUERY_LENGTH).replace(/[\uD800-\uDBFF]$/, "")
}

/**
 * Pull deduped entity-name candidates from a set of active tasks. The
 * task `entity` field carries the normalized subject (PR number, file,
 * service); `title` is the human-friendly version. Prefer `entity`
 * when populated — it's the structurally-indexed handle that
 * `lore-task action='list'` filters against — and fall back to `title`
 * for tasks created before the `entity` column was filled.
 * Case-insensitive dedupe; short fragments dropped as too noisy.
 */
function extractTaskEntities(tasks: TaskSummary[]): string[] {
  const seen = new Set<string>()
  const entities: string[] = []
  for (const task of tasks) {
    const raw = (task.entity || task.title).trim()
    if (raw.length < MIN_ENTITY_LENGTH) continue
    const key = raw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    entities.push(raw)
    if (entities.length >= MAX_ENTITY_CANDIDATES) return entities
  }
  return entities
}

function isFreshDigest(digest: Memory | null, maxAgeDays: number, now: number): boolean {
  if (!digest) return false
  const ageMs = now - new Date(digest.createdAt).getTime()
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < maxAgeDays * MS_PER_DAY
}

function digestAgeDays(digest: Memory | null, now: number): number | null {
  if (!digest) return null
  const ageMs = now - new Date(digest.createdAt).getTime()
  if (!Number.isFinite(ageMs) || ageMs < 0) return null
  return Math.floor(ageMs / MS_PER_DAY)
}

/**
 * Classify an ISO timestamp relative to `now` into a human-readable bucket
 * for wake-up rendering. Shared by the MCP tool and the shell hook so both
 * surfaces group memories identically.
 */
export function dateBucket(
  isoDate: string,
  now: number = Date.now(),
): "Today" | "Yesterday" | "Earlier" {
  const d = isoDate.split("T")[0]
  const today = new Date(now).toISOString().split("T")[0]
  const yesterday = new Date(now - MS_PER_DAY).toISOString().split("T")[0]
  if (d === today) return "Today"
  if (d === yesterday) return "Yesterday"
  return "Earlier"
}
