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
  TaskSummary,
} from "../types.js"

export const MS_PER_DAY = 86_400_000

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
      limit?: number
      includeContent?: boolean
      includeUnscoped?: boolean
      sortBy?: "created_time" | "last_edited_time"
    }): Promise<{ items: Memory[]; nextCursor?: string }>
    search(input: {
      query: string
      projectId?: string
      limit?: number
      includeContent?: boolean
      mode?: "contains" | "semantic" | "hybrid"
    }): Promise<Memory[]>
  }
  facts: {
    listRecent(opts: {
      projectId?: string
      limit?: number
    }): Promise<{ items: Fact[]; hasMore: boolean }>
  }
  decisions: {
    list(opts?: ListDecisionsOpts): Promise<{ items: DecisionSummary[]; nextCursor?: string }>
    queryOverdue(opts?: {
      projectId?: string
      limit?: number
    }): Promise<DecisionSummary[]>
  }
  tasks: {
    list(opts?: ListTasksOpts): Promise<{ items: TaskSummary[]; nextCursor?: string }>
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
  /** Override Date.now() for testing. */
  now?: number
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
  /**
   * Memories relevance-matched against the entities surfaced in active
   * tasks via one semantic search (Notion's vector index scores both
   * titles and page bodies against the seed query). Deduped against
   * `digest` and `memories` so the same page never renders twice. Empty
   * when there are no active tasks to seed from.
   */
  relatedMemories: Memory[]
  /**
   * Active task memories (Kind = task) capped at `taskLimit`. Sorted by
   * due-date ascending so most-pressing rows are first.
   */
  tasks: TaskSummary[]
  /**
   * Memories relevance-matched against the user's first message
   * (`userQuery`). Notion's vector index scores titles AND bodies against
   * the (possibly truncated) query. Deduped against `digest`, `memories`,
   * AND `relatedMemories` so the same page never renders across the three
   * memory sections. Empty when `userQuery` was absent or whitespace-only.
   */
  taskMemories: Memory[]
}

export async function loadWakeUpData(
  services: WakeUpServices,
  opts: WakeUpOptions = {},
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
  const now = opts.now ?? Date.now()
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
  // `taskCandidates: Memory[]` — annotated explicitly because this is the
  // only entry in the fan-out whose two arms (a real `services.memories.search`
  // call vs. `Promise.resolve([])`) produce identical shapes by coincidence
  // rather than by a `{ items, ... }` envelope. The annotation makes the
  // contract obvious for the next reader and pins the resolution shape if
  // `MemoryService.search`'s return type ever changes.
  const [
    { items: rawMemories },
    { items: latestDigestList },
    { items: knowledgeFacts },
    { items: proposedDecisions },
    overdueDecisions,
    { items: tasks },
    taskCandidates,
  ]: [
    { items: Memory[] },
    { items: Memory[] },
    { items: Fact[]; hasMore: boolean },
    { items: DecisionSummary[] },
    DecisionSummary[],
    { items: TaskSummary[] },
    Memory[],
  ] = await Promise.all([
    services.memories.list({
      projectId,
      limit: memoryLimit + 1,
      includeContent,
    }),
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
    projectId
      ? services.facts.listRecent({
          projectId,
          limit: knowledgeLimit,
        })
      : Promise.resolve({ items: [] as Fact[], hasMore: false }),
    projectId && includeDecisions
      ? services.decisions.list({ projectId, status: "proposed", limit: 20 })
      : Promise.resolve({ items: [] as DecisionSummary[] }),
    projectId && includeDecisions
      ? services.decisions.queryOverdue({ projectId })
      : Promise.resolve([] as DecisionSummary[]),
    projectId && taskLimit > 0
      ? services.tasks.list({
          projectId,
          // Default `states` (active set) lives inside `TaskService.list`.
          limit: taskLimit,
        })
      : Promise.resolve({ items: [] as TaskSummary[] }),
    projectId && userQuery && taskFetchLimit > 0
      ? services.memories.search({
          query: userQuery,
          projectId,
          limit: taskFetchLimit,
          includeContent,
        })
      : Promise.resolve([] as Memory[]),
  ])

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

  return {
    digest,
    memories,
    knowledgeFacts,
    proposedDecisions,
    overdueDecisions,
    relatedMemories,
    tasks,
    taskMemories,
  }
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
