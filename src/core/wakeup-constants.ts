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
 * Cap on the proposed-memory inbox section rendered at session start.
 * Mirrors the `proposedDecisions` cap of 20: a
 * triage surface, not an inventory. Operators with deeper inbox depth
 * see the full count surfaced via `WakeUpSectionCounts.proposedMemories`
 * + `lore status`'s Proposed memories line; the wake-up section caps
 * to keep the prompt budget bounded.
 */
export const DEFAULT_WAKEUP_PROPOSED_MEMORY_LIMIT = 20

/**
 * Per-upstream cap for the inherited-memory section
 * ("Read inheritance"). Three rows is the sparse
 * default: "a team/org vault is useful only
 * if inherited memory is sparse, labeled, and intentionally
 * capped." Operators with a different signal/noise tradeoff can
 * override per call via `WakeUpOptions.inheritedMemoryLimit`.
 */
export const DEFAULT_WAKEUP_INHERITED_MEMORY_LIMIT = 3
/**
 * Per-section caps applied when the caller passes a non-empty `userQuery`
 * and hasn't overridden the section explicitly. Tighter than the
 * surface-default caps above because relevance-ranked top hits carry more
 * signal-per-row than timestamp-ordered recents — a smaller bundle yields
 * better wake-up density. Values come from the relevance-section spec.
 *
 * Shared across both wake-up surfaces (the hook helper and the
 * `lore-context` MCP tool) so the prompt-budget contract stays
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
export const MAX_USER_QUERY_LENGTH = 1000
/**
 * Notion's hard ceiling on rows returned from a single `list` call. We scale
 * the related-memory fetch window up to this bound so large `relatedLimit`
 * callers aren't silently starved — the service layer (`MemoryService.list`)
 * already clamps here, but stating it at the call site keeps the scaling
 * formula self-documenting.
 */
export const NOTION_PAGE_SIZE = 100

/**
 * Multiplier applied to `taskLimit` when the data layer fetches each active
 * task bucket for wake-up. The renderer caps each bucket at `taskLimit`; 4×
 * leaves room to report hidden lower-bound counts while keeping every query
 * to one Notion page.
 */
export const WAKEUP_TASK_OVERFETCH_MULTIPLIER = 4
export const MAX_ENTITY_CANDIDATES = 10
/** Skip entity strings shorter than this — too noisy to match on. */
export const MIN_ENTITY_LENGTH = 3
