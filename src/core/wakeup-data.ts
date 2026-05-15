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
 * realistic case where task subjects read like phrases (e.g.
 * "label.applied classifier rollout") that do not appear verbatim in memory
 * titles but are semantically adjacent to the explaining memory.
 *
 * When the caller has the user's first message (the hook fires on
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
  MemoryScopeContext,
  MemorySource,
  MemoryKind,
  MemoryStatus,
  TaskSummary,
} from "../types.js"
import { DEFAULT_PINNED_BLOCK_LIMIT, STALE_CONFIDENCE_LIMIT } from "../types.js"
import { computeWakeUpCacheKey, WakeUpCache } from "./wakeup-cache.js"
import type { UpstreamVaultBundle } from "./topology-readers.js"
import {
  DEFAULT_DIGEST_FRESHNESS_DAYS,
  DEFAULT_WAKEUP_INHERITED_MEMORY_LIMIT,
  DEFAULT_WAKEUP_KNOWLEDGE_FACT_LIMIT,
  DEFAULT_WAKEUP_MEMORY_LIMIT,
  DEFAULT_WAKEUP_MEMORY_LIMIT_WITH_DIGEST,
  DEFAULT_WAKEUP_PROPOSED_MEMORY_LIMIT,
  DEFAULT_WAKEUP_RELATED_MEMORY_LIMIT,
  DEFAULT_WAKEUP_TASK_LIMIT,
  DEFAULT_WAKEUP_TASK_MEMORY_LIMIT,
  NOTION_PAGE_SIZE,
} from "./wakeup-constants.js"
import { computeWakeUpCoverage, type WakeUpCoverageMetrics } from "./wakeup-coverage.js"
import {
  loadInheritedMemorySections,
  type InheritedMemorySection,
} from "./wakeup-inherited.js"
import {
  computeTasksFetchLimit,
  emptyTaskBucketCoverage,
  loadWakeUpTaskWindow,
  queryOverdueDecisionWindow,
  type WakeUpTaskBucketCoverage,
} from "./wakeup-tasks.js"
import { extractTaskEntities, isFreshDigest, sanitizeUserQuery } from "./wakeup-utils.js"

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
     * Confidence wake-up subsection. Required on the
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
     * True proposed-memory inbox depth. Required on the
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
    /**
     * Pinned context blocks. Required on the structural
     * type so the type system catches a forgotten wiring — same
     * posture as `queryStaleConfidence` / `countProposed`. Hook
     * callers skip the query via `includePinnedBlocks: false` /
     * `pinnedBlockLimit: 0`, NOT by omitting the method.
     */
    listPinnedBlocks(opts: {
      projectId?: string
      limit?: number
      today?: string
      readerContext?: MemoryScopeContext
      includeContent?: boolean
      audienceFilter?: boolean
      includeOutOfScope?: boolean
    }): Promise<Memory[]>
    /** Active-pinned-block count (issue #282). Backs the abuse-
     *  warning surfaced by the wake-up renderer when the total
     *  exceeds `PINNED_BLOCKS_ABUSE_THRESHOLD`. */
    countPinnedBlocks(): Promise<number>
  }
  facts: {
    listRecent(opts: {
      projectId?: string
      limit?: number
    }): Promise<{ items: Fact[]; hasMore: boolean }>
  }
  decisions: {
    list(
      opts?: ListDecisionsOpts
    ): Promise<{ items: DecisionSummary[]; nextCursor?: string }>
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
  /**
   * Per-upstream read-only service bundles for inherited-memory
   * fan-out ("Read inheritance"). Optional so the
   * structural type stays source-compatible with single-vault
   * fixtures and the shell hook's lightweight wake-up wiring;
   * absent / empty array suppresses the inherited section entirely
   * (byte-identical behavior to single-vault wake-up). Production wiring
   * threads `LoreServices.upstreams` through directly.
   *
   * **Optional is the deliberate test-fixture compatibility
   * choice**, not a feature toggle. The
   * downstream consumer `runWakeUpFanOut` treats `undefined` and
   * `[]` identically — both suppress the section. New callers
   * constructing a `WakeUpServices` standalone should thread the
   * `LoreServices.upstreams` array directly; the optionality is
   * for existing test stubs that don't carry the field.
   */
  upstreams?: readonly UpstreamVaultBundle[]
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
   * When this is provided, the hook caller should also tighten
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
   * When false, skip the Stale Confidence query. The shell
   * hook never renders the section, so it has no reason to pay the
   * extra Notion round-trip on every session start. Defaults to true
   * so MCP callers (which DO render the section) keep working. Same
   * posture as `includeDecisions`.
   */
  includeStaleConfidence?: boolean
  /**
   * When false, skip the proposed-memory inbox query. The shell
   * hook never renders the section, so it has no
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
   * When false, skip the pinned context blocks query.
   * The shell hook never renders the section, so it has no reason
   * to pay the extra Notion round-trip on every session start.
   * Defaults to true so MCP callers (which DO render the section)
   * keep working. Same posture as `includeDecisions` /
   * `includeStaleConfidence` / `includeProposedMemories`.
   */
  includePinnedBlocks?: boolean
  /**
   * Override the pinned context blocks section cap. Defaults to
   * `DEFAULT_PINNED_BLOCK_LIMIT` (10). Pass `0` to skip the query
   * without touching `includePinnedBlocks`.
   */
  pinnedBlockLimit?: number
  /**
   * Reader identity slots for pinned-block audience matching.
   * When omitted, only universally-targeted pins (audience empty
   * or `all`) surface. Same shape as `MemoryScopeContext` — pinned
   * blocks ride atop the same identity resolution, so a caller
   * that already populates the context for scope filtering reuses
   * it here without duplication.
   */
  pinnedReaderContext?: MemoryScopeContext
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
   * Process-local result cache. When supplied,
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
  /**
   * When false, skip the upstream-vault fan-out entirely.
   * Same posture as `includeDecisions` /
   * `includeStaleConfidence` / `includeProposedMemories`: the shell
   * hook currently renders no inherited section, so it has no reason
   * to pay per-upstream Notion round-trips. Defaults to true so MCP
   * callers (which DO render the section) keep working. Vaults
   * without any configured upstreams skip the fan-out regardless of
   * this flag.
   */
  includeInheritedMemories?: boolean
  /**
   * Per-upstream cap for the inherited-memory section. Defaults to
   * `DEFAULT_WAKEUP_INHERITED_MEMORY_LIMIT` (3). Pass `0` to skip
   * the fan-out without touching `includeInheritedMemories`. The
   * issue calls out a sparse-and-labeled posture deliberately — a
   * cap above ~5 is almost always wrong (multiplies prompt noise
   * across upstreams). The constant is exported so tests and
   * diagnostic surfaces can reference the same value.
   */
  inheritedMemoryLimit?: number
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
   * surface of the proposed-memory inbox.
   * Project-scoped when `projectId` is supplied, vault-wide
   * otherwise. Capped at `PROPOSED_MEMORY_LIMIT` so a large inbox
   * cannot dominate wake-up; the count surfaces in
   * `WakeUpSectionCounts.proposedMemories` so an operator sees the
   * total even when the rendered slice is capped.
   *
   * Disjoint by construction: this section is the only surface that
   * sees `Status = proposed` rows; every other section applies the
   * default-exclude on `Status = proposed`. No id-dedup
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
   * `Last Referenced At` past the `STALE_CONFIDENCE_DAYS` cutoff.
   * Sorted by score ascending, capped at
   * `STALE_CONFIDENCE_LIMIT`. Empty when the option
   * `includeStaleConfidence` is false (hook path) or the underlying
   * service does not implement the optional `queryStaleConfidence`
   * method. NOT deduped against the other memory sections — a row
   * surfacing in Recent and in Stale Confidence is meaningful: it
   * tells the agent the row is recent AND triage-worthy.
   */
  staleConfidence: Memory[]
  /**
   * Pinned context blocks for the wake-up Pinned Context section.
   * Sorted by `Pinned Priority` descending, then by `created_time`
   * descending. Capped at `pinnedBlockLimit` (default
   * `DEFAULT_PINNED_BLOCK_LIMIT`). Empty when `includePinnedBlocks:
   * false` or the vault has no pinned rows matching the reader's
   * project + audience.
   *
   * Rendered BEFORE the relevance-ranked sections per the
   * "always-visible, shareable, optionally read-only memory as a
   * coordination primitive" framing — pinned blocks are governance
   * context, not retrieved content.
   *
   * NOT deduped against other memory sections (recent / related /
   * task-memories). A pinned policy that also surfaces in Recent
   * Memories carries meaningful signal: the agent sees the pin as
   * governance AND the recency as a touch signal. The wake-up
   * renderer renders the pinned section first so the duplicate is
   * a "remembered twice" emphasis, not "doubled into noise."
   */
  pinnedBlocks: Memory[]
  /**
   * Total active-pinned-block count across the vault.
   * Surfaced separately from `pinnedBlocks.length` so the wake-up
   * renderer can compare against `PINNED_BLOCKS_ABUSE_THRESHOLD` and
   * append an inline operator-facing warning when the count is
   * unusually high — the abuse signal for a malicious caller
   * spamming pins to evict legitimate governance from the visible
   * window. Always >= `pinnedBlocks.length`; equal when the visible
   * cap wasn't binding. `null` when the pinned-blocks query was
   * skipped (`includePinnedBlocks: false`) or returned zero.
   */
  pinnedBlocksTotal: number | null
  /**
   * Privacy-conscious wake-up coverage counters for observability and
   * on-demand status surfaces. Null unless `includeCoverage` was requested.
   * Counts track rendered section rows; the data layer caps flat-rendered task
   * counts, and renderers that collapse or re-bucket rows must adjust affected
   * counts before logging or rendering debug output.
   */
  coverage: WakeUpCoverageMetrics | null
  /**
   * Per-upstream inherited-memory sections. Empty array
   * when no upstreams are configured OR `includeInheritedMemories`
   * was disabled. Order matches the upstream priority order from
   * `buildVaultTopology` (ascending). Each section carries its own
   * `error` field so upstream failures degrade gracefully without
   * suppressing the others — the upstream-failure-isolation
   * invariant the inherited-memory section is built around.
   */
  inheritedMemories: InheritedMemorySection[]
}

export async function loadWakeUpData(
  services: WakeUpServices,
  opts: WakeUpOptions = {}
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
    const effectiveTodayDate = opts.todayDate ?? new Date(now).toISOString().slice(0, 10)
    const keyOpts: WakeUpOptions = { ...opts, todayDate: effectiveTodayDate }
    const cacheKey = computeWakeUpCacheKey(keyOpts)
    // Capture the start epoch BEFORE dispatch — see
    // `WakeUpCache.currentEpoch`'s docstring for the sandwich
    // contract. `getOrLoad` collapses concurrent cold-start callers
    // onto a single fan-out so a SessionStart and UserPromptSubmit
    // firing close together cost one wake-up, not two.
    const startEpoch = cache.currentEpoch
    return cache.getOrLoad(cacheKey, startEpoch, () =>
      runWakeUpFanOut(services, opts, now, effectiveTodayDate)
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
  todayDate: string
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
  // Stale Confidence: single-page query, runs in parallel
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

  // Proposed-memory inbox surface. Two parallel
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
  // Pinned context blocks. Wake-up always runs the
  // query unless the caller explicitly disables it; defaults to
  // `DEFAULT_PINNED_BLOCK_LIMIT` (10). Single round-trip,
  // server-filtered by `Pinned = true` and (when supplied) project
  // scope + lifetime hygiene. Audience matching is applied
  // client-side inside `listPinnedBlocks` — see its docstring for
  // the comma-split exact-match rule.
  //
  // Hook callers turn the query off via `includePinnedBlocks:
  // false`; the numeric escape `pinnedBlockLimit: 0` skips without
  // changing the boolean. Vault-wide wake-up (`projectId ===
  // undefined`) still fires the query — `listPinnedBlocks` returns
  // every pinned row regardless of project scope when no project
  // id is supplied.
  const includePinnedBlocks = opts.includePinnedBlocks ?? true
  const pinnedBlockLimit = opts.pinnedBlockLimit ?? DEFAULT_PINNED_BLOCK_LIMIT
  const pinnedBlocksQuery =
    includePinnedBlocks && pinnedBlockLimit > 0
      ? services.memories.listPinnedBlocks({
          projectId,
          limit: pinnedBlockLimit,
          today: todayDate,
          readerContext: opts.pinnedReaderContext,
          includeContent: false,
        })
      : Promise.resolve([] as Memory[])
  // Total active pinned-block count for the abuse-warning gate.
  // Only fires when the section runs — skipping pinned blocks
  // skips the abuse signal too.
  const pinnedBlocksTotalQuery =
    includePinnedBlocks && pinnedBlockLimit > 0
      ? services.memories.countPinnedBlocks()
      : Promise.resolve(null as number | null)

  const includeProposedSection = includeProposedMemories && proposedMemoryLimit > 0
  const proposedMemoriesQuery = includeProposedSection
    ? services.memories.list({
        projectId,
        status: "proposed",
        // `excludeKinds: ["decision"]` matches `proposedMemoryFilter()`'s
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
        // Hardcoded `false`: the proposed-memories renderer
        // (`formatMemoryListItem`) reads title / synopsis /
        // confidenceScore / meta and never `memory.content`.
        // Threading the caller's `includeContent` here paid an
        // N-way `retrieveMarkdown` fan-out per `expand: true`
        // wake-up for bodies that were fetched, deserialized, and
        // dropped on the floor.
        includeContent: false,
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
    pinnedBlocks,
    pinnedBlocksTotal,
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
    Memory[],
    number | null,
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
          // The wake-up renderer prints the stored digest body verbatim.
          includeContent: true,
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
    pinnedBlocksQuery,
    pinnedBlocksTotalQuery,
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
      const fetchLimit = Math.min(NOTION_PAGE_SIZE, relatedLimit + alreadySurfaced.size)
      // Join entities into a single relevance query so Notion's vector
      // index scores memory titles AND bodies against the union. This is
      // strictly more permissive than substring title matching — task
      // subjects like "outlook label.applied classifier work" are
      // phrase-shaped, not bare entity names, and only relevance ranking
      // finds the "label.applied classifier: false positives…"
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
  // overlap suppression heuristic; pin tests first
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

  // Upstream fan-out runs AFTER the primary fan-out and renders
  // sections AFTER the primary sections — the issue's "Local
  // memories should outrank inherited memories by default" rule.
  // Bounded per-upstream cap keeps the prompt-noise multiplier in
  // check; the fan-out posture (failure isolation, redaction at
  // capture) is documented inside `loadInheritedMemorySections`.
  const includeInheritedMemories = opts.includeInheritedMemories ?? true
  const inheritedMemoryLimit =
    opts.inheritedMemoryLimit ?? DEFAULT_WAKEUP_INHERITED_MEMORY_LIMIT
  const inheritedMemories: InheritedMemorySection[] =
    includeInheritedMemories &&
    inheritedMemoryLimit > 0 &&
    services.upstreams &&
    services.upstreams.length > 0
      ? await loadInheritedMemorySections(
          services.upstreams,
          inheritedMemoryLimit,
          includeContent
        )
      : []

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
    pinnedBlocks,
    pinnedBlocksTotal,
    coverage,
    inheritedMemories,
  }
}
