/**
 * Core domain types for Lore.
 *
 * Vault → Project → Topic → Memory
 *                         → Fact (knowledge graph)
 */

// ---------------------------------------------------------------------------
// Tag vocabulary
// ---------------------------------------------------------------------------

/**
 * Closed vocabulary of memory tags.
 *
 * `Tags` is a taxonomy — a small, stable set of category labels that make
 * tag-based queries meaningful. Free-form labels (PR numbers, session IDs,
 * file paths, class names, ticket IDs) belong in `Keywords`, which is
 * indexed by Notion's text search.
 *
 * Curated from a frequency census against the Mail production vault: the
 * high-signal labels cluster into engineering discipline (`architecture`,
 * `testing`, `performance`), platform (`ios`, `backend`, `web`), document
 * kind (`gotcha`, `runbook`, `postmortem`), and workflow (`code-review`,
 * `migration`, `deployment`). Technology-specific names (`tuist`, `tca`,
 * `prisma`) intentionally live in `Keywords` — they don't survive across
 * vaults and would bloat the enum.
 */
export const TAG_VOCABULARY = [
  "android",
  "api",
  "architecture",
  "audit",
  "backend",
  "bug",
  "build",
  "ci",
  "code-review",
  "concurrency",
  "config",
  "convention",
  "data-model",
  "db",
  "decision-context",
  "dependency",
  "deployment",
  "docs",
  "error-handling",
  "frontend",
  "gotcha",
  "incident",
  "infrastructure",
  "investigation",
  "ios",
  "migration",
  "observability",
  "onboarding",
  "performance",
  "policy",
  "postmortem",
  "refactor",
  "runbook",
  "security",
  "testing",
  "tooling",
  "ui",
  "ux",
  "web",
  "workflow",
] as const

export type Tag = (typeof TAG_VOCABULARY)[number]

/**
 * Soft cap on the Synopsis property at the MCP boundary. The Notion
 * rich_text per-block ceiling is 2000; 500 is the value tools enforce
 * via Zod and the value tests pin. Bump only with a coordinated
 * design-doc update — agents that have learned to write 500-char
 * synopses would silently see truncation without one.
 *
 * Lives in `src/types.ts` because the cap is structural to the
 * property, not specific to any one consumer. The write-side Zod, the
 * renderer, and the backfill synthesizer all import it.
 */
export const SYNOPSIS_MAX = 500

/**
 * Days since `last_edited_time` past which an active task is considered
 * stale and surfaces with a "consider closing" prompt in wake-up.
 * Conservative: 30 days is long enough to absorb a vacation or a
 * context-switched project, short enough to flag truly-forgotten work.
 * Read by `src/core/task.ts` (`taskDaysStale` helper), the wake-up
 * Tasks rendering in `src/mcp/tools/context.ts` (issue 0.7.0/12), and
 * the `lore status` / `lore-context action='status'` task summary
 * line (issue 0.7.0/13).
 *
 * A future operator-tuning knob (`hooks.staleTaskDays` in `.lore.yaml`)
 * is the next step if real-vault feedback shows 30 is wrong; the const
 * is the single source of truth in 0.7.0.
 */
export const STALE_TASK_DAYS = 30

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export interface Vault {
  /** Notion page ID that contains all Lore databases */
  pageId: string
  /** Database IDs created within the vault page */
  databases: VaultDatabases
}

/**
 * References both IDs for a Notion database.
 *
 * In SDK v5, `dataSources.query()` requires the data-source ID while
 * `pages.create()` requires the database (block) ID. They differ.
 */
export interface DatabaseRef {
  /** Database block ID — used as parent in pages.create() */
  databaseId: string
  /** Data source ID — used in dataSources.query() */
  dataSourceId: string
}

export interface VaultDatabases {
  projects: DatabaseRef
  topics: DatabaseRef
  memories: DatabaseRef
  /**
   * Canonical-entity registry. Sits between Memories and Facts in the
   * dependency graph because Facts relate to Entity rows via
   * `SubjectEntity` / `ObjectEntity` while Entities themselves reference
   * Projects + Memories.
   */
  entities: DatabaseRef
  facts: DatabaseRef
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export type ProjectType = "project" | "person" | "agent"
export type ProjectStatus = "active" | "archived"

export interface Project {
  id: string
  name: string
  type: ProjectType
  path: string
  status: ProjectStatus
  description: string
}

export interface CreateProjectInput {
  name: string
  type?: ProjectType
  path?: string
  description?: string
}

// ---------------------------------------------------------------------------
// Topic
// ---------------------------------------------------------------------------

export interface Topic {
  id: string
  name: string
  projectIds: string[]
  description: string
}

export interface CreateTopicInput {
  name: string
  projectIds: string[]
  description?: string
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Where a memory originated. Note the asymmetry: `agent_diary` is no
 * longer writeable from the live tool surface. Its only writer was the
 * legacy journal dispatcher, which the 0.6.0 deprecation purge removed;
 * production vaults still carry historical `agent_diary` rows, so the
 * value stays in the union to keep recall paths (`lore-query
 * action='recall'` with `source: "agent_diary"`, the digest grouping
 * in `core/digest.ts`, and the Notion `Source` select option) working
 * over legacy data. New memories should pick from the four live
 * sources — `conversation`, `file`, `manual`, `digest`.
 */
export type MemorySource = "conversation" | "file" | "manual" | "agent_diary" | "digest"

/**
 * What kind of memory this is. Used as a server-side discriminator so
 * tools like `lore-decision action='list'` can filter without post-processing.
 *
 * `task` memories carry tracking-style state (open / blocked / done) and
 * are the canonical surface for tracked work. The Memories DB hosts them
 * so the title is a structured subject and the body holds the full
 * description — compare to facts where the Object field is a 2000-char
 * rich_text and structural queries fall apart on prose.
 */
export type MemoryKind =
  | "note"
  | "decision"
  | "incident"
  | "runbook"
  | "postmortem"
  | "policy"
  | "task"

/**
 * Lifecycle state for `Kind = task` memories.
 *
 * - `open` — needs action; no one yet picking it up. Default for fresh
 *   tasks.
 * - `in-progress` — actively being worked.
 * - `blocked` — waiting on an external dependency. Pair with `Blocked By`
 *   to name the blocker (PR number, person, service).
 * - `done` — closed successfully. `lore-task action='close'` writes this.
 * - `cancelled` — dropped without completion. Distinct from `done` so
 *   metrics distinguish "shipped" from "abandoned".
 *
 * Non-task memories carry no Task State; the field is read off the
 * `Task State` Notion column when present and elided otherwise.
 */
export type TaskState =
  | "open"
  | "in-progress"
  | "blocked"
  | "done"
  | "cancelled"

/** Task states that count as "still owing work" — surfaced by
 *  `lore-task action='list'` and the wake-up Tasks section by default. */
export const ACTIVE_TASK_STATES: TaskState[] = ["open", "in-progress", "blocked"]

/**
 * Lifecycle state for memories that have one. Non-decision memories
 * (e.g., plain notes) default to `informational`.
 */
export type MemoryStatus =
  | "informational"
  | "proposed"
  | "accepted"
  | "superseded"
  | "deprecated"
  | "rejected"

/**
 * Confidence calibration for memories. Parallels `FactConfidence`.
 */
export type MemoryConfidence = "certain" | "likely" | "speculative"

/**
 * Confidence Score is constrained to [CONFIDENCE_SCORE_MIN,
 * CONFIDENCE_SCORE_MAX] inclusive. Out-of-range writes are clamped by
 * `clampConfidenceScore` in `src/core/decay.ts`. Notion's number column
 * has no native range constraint, so the clamp is the single
 * enforcement point.
 */
export const CONFIDENCE_SCORE_MIN = 0
export const CONFIDENCE_SCORE_MAX = 1

/**
 * Initial Confidence Score seeded from the categorical Confidence select
 * on first read-touch (or by `lore migrate --build-confidence-scores`).
 * Empirical: `certain` lands at 0.9 (not 1.0 — leaves headroom for
 * repeated confirmation to push higher), `likely` at 0.6, `speculative`
 * at 0.3. A memory written without an explicit `Confidence` defaults to
 * `certain` per `pageToMemory`, so the seeded value is 0.9.
 */
export const CONFIDENCE_SEED: Record<MemoryConfidence, number> = {
  certain: 0.9,
  likely: 0.6,
  speculative: 0.3,
}

/**
 * Days of neglect (no read-citation) past which `decayConfidenceScore`
 * begins multiplying the stored value by `DECAY_RATE` per stale day.
 * Pinned at 60 — empirical, the same shape as `STALE_TASK_DAYS`.
 */
export const STALE_CONFIDENCE_DAYS = 60

/**
 * Bump multiplier applied on every read-citation. The bump uses
 * `next = current + (1 - current) * BUMP_RATE` so high-confidence rows
 * ratchet slowly and stay below 1.0; low-confidence rows recover
 * faster than a high-confidence row decays per stale day.
 */
export const BUMP_RATE = 0.05

/**
 * Per-day multiplier applied past the `STALE_CONFIDENCE_DAYS` grace.
 * `next = current * DECAY_RATE^staleDays` — at 0.99, half-life past
 * the grace is ~69 stale days.
 */
export const DECAY_RATE = 0.99

/**
 * Multiplier applied on a contradiction signal (`lore-correct`,
 * `lore-supersede`). Aggressive: a single contradiction halves the
 * stored score. Asymmetry vs. `BUMP_RATE` is deliberate — contradiction
 * is high-quality negative evidence, not the diffuse signal neglect
 * carries.
 */
export const DECREMENT_FACTOR = 0.5

/**
 * Floor for the RRF weighting factor exposed by `confidenceFactor`.
 * `score = 0` maps to this value; `score = 1` maps to 1. Preserves the
 * "score is a tiebreaker, not a veto" intuition — a maximally-decayed
 * memory still surfaces at half the weight of a fully-trusted one.
 */
export const CONFIDENCE_FACTOR_MIN = 0.5

/**
 * Threshold below which `formatMemoryListItem` renders an italic trust
 * indicator between the heading and the synopsis. Pinned at 0.5 to match
 * `CONFIDENCE_FACTOR_MIN` — a row whose RRF factor has bottomed out IS
 * the row that needs the visible signal. Above this threshold, listings
 * render byte-identically to pre-0.8.0 (modulo the synopsis line that
 * 0.7.0 introduced); a `null` Confidence Score never renders the
 * indicator either, so pre-migration vaults look unchanged until
 * `lore migrate --build-confidence-scores` populates scores.
 *
 * Single source of truth for the per-row trust indicator (#09) AND the
 * low-score branch of the Stale Confidence wake-up subsection (#10).
 * Diverging the two would mean a row could surface in Stale Confidence's
 * low-score branch AND fail to flag in Recent Memories (or vice versa),
 * which is incoherent for a score-driven signal. The neglect branch of
 * #10 is governed by `STALE_CONFIDENCE_DAYS` instead and is allowed to
 * surface rows whose stored score is above this threshold.
 */
export const CONFIDENCE_DISPLAY_THRESHOLD = 0.5

/**
 * Map a numeric Confidence Score to the human-readable label rendered
 * below the heading on recall / search / wake-up listings (#09). Three
 * empirical buckets:
 *
 *   `score < 0.2` → `"very low confidence"`
 *   `score < 0.4` → `"low confidence"`
 *   `score < CONFIDENCE_DISPLAY_THRESHOLD` (0.5) → `"moderate confidence"`
 *   `score >= CONFIDENCE_DISPLAY_THRESHOLD` → `null` (no indicator)
 *
 * The above-threshold case returns `null` so the function is the single
 * gate — a forgetful caller that drops the surrounding `score < threshold`
 * predicate cannot accidentally print `"moderate confidence"` next to a
 * 0.95 row. Callers `??`-or-skip on `null`. Three tiers (not five, not
 * two) is the pragmatic granularity: agents already triage 25 rows per
 * wake-up, and a literal "0.34" is technically more precise but harder
 * to read at a glance than `"low confidence"`. Bucket thresholds are
 * pinned in code; tuning is one-line.
 *
 * Returns `null` only above the display threshold — never on a valid
 * in-range score. The caller's `null` check on `Memory.confidenceScore`
 * (the "no score yet / pre-migration row" case) stays at the call site
 * because `null` there is structurally different from "scored above
 * the indicator threshold."
 */
export function formatTrustLabel(score: number): string | null {
  if (score >= CONFIDENCE_DISPLAY_THRESHOLD) return null
  if (score < 0.2) return "very low confidence"
  if (score < 0.4) return "low confidence"
  return "moderate confidence"
}

/**
 * Maximum rows surfaced in the Stale Confidence wake-up subsection
 * (0.8.0/#10). Default 5 — tight enough to keep the subsection a
 * triage prompt rather than an exhaustive list. When the section is
 * saturated (returned exactly STALE_CONFIDENCE_LIMIT rows), the heading
 * prefixes the count with `≥` (e.g. `≥5`) to signal "at least this
 * many"; no exact total is computed (one query, no inventory). See
 * 0.8.0/#10 spec for the design-decision rationale.
 */
export const STALE_CONFIDENCE_LIMIT = 5

/**
 * Milliseconds in a day. Cross-cutting constant — every native-`Date`
 * day-arithmetic site (`taskDaysOverdue`, `decayConfidenceScore`,
 * `MemoryService.queryStaleConfidence`, the wake-up renderer's
 * `Last referenced: Nd ago` builder, `task-reconcile`'s age scoring,
 * `loadWakeUpData`'s digest-freshness window, `dateBucket`) divides
 * by this value. Pinned in `src/types.ts` rather than a per-module
 * local so a future tweak (or the inevitable contributor who writes
 * `1000 * 60 * 60 * 24` from muscle memory) finds one source of truth.
 */
export const MS_PER_DAY = 86_400_000

export interface Memory {
  id: string
  title: string
  projectIds: string[]
  topicId: string | null
  source: MemorySource
  kind: MemoryKind
  status: MemoryStatus
  confidence: MemoryConfidence
  /**
   * System-managed numeric confidence in [0, 1]. `null` until the memory
   * has been touched once by a read path (or backfilled by `lore migrate
   * --build-confidence-scores`). RRF reads this as a weighting factor
   * (#08); rendering surfaces a trust indicator when below
   * `CONFIDENCE_DISPLAY_THRESHOLD` (#09). Distinct from the agent-curated
   * `confidence` categorical above.
   */
  confidenceScore: number | null
  reviewBy: string | null
  /**
   * Most recent close timestamp for tasks. YYYY-MM-DD, or `null` for
   * non-task memories and for tasks that have never reached a terminal
   * state. Set automatically by `TaskService.close()` and by
   * `TaskService.update()` whenever the incoming state is
   * `done` / `cancelled`; preserved on re-open (`update({ state:
   * 'open' })`) as historical fact. Not directly writable from the MCP
   * surface — the field is owned by the task lifecycle paths, not the
   * generic memory write tools.
   */
  doneAt: string | null
  decidedAt: string | null
  /**
   * Most-recent read-citation date in `YYYY-MM-DD` form; `null` until the
   * memory has been touched once by a read path (or backfilled by
   * `lore migrate --build-confidence-scores`, #11). Distinct from
   * `updatedAt` (Notion built-in, edit timestamp) and from `createdAt`
   * (Notion built-in, creation timestamp).
   *
   * Decay (#03) reads this; the stale-confidence wake-up subsection (#10)
   * reads this. RRF (#08) does NOT read this directly — the decay
   * function mediates between `lastReferencedAt` and the confidence
   * score.
   */
  lastReferencedAt: string | null
  supersedesIds: string[]
  affectsIds: string[]
  alternatives: string
  consequences: string
  author: string
  agent: string
  tags: string[]
  /**
   * Free-form space-separated tokens for things that don't belong in the
   * closed `Tags` vocabulary — PR numbers, ticket IDs, file paths, class or
   * function names, session identifiers. Indexed by Notion's text search so
   * `lore-query action='search'` finds them, but kept out of the tag index.
   */
  keywords: string
  /**
   * Short 1–2 sentence synopsis of the memory. Surfaces on title-tier
   * rendering (recall, search, wake-up) so listings give the agent a
   * one-line gist without a body fetch. Soft-capped at 500 chars at the
   * MCP boundary; empty string when not set.
   */
  synopsis: string
  session: string
  content: string
  createdAt: string
  updatedAt: string
  /**
   * Task-specific lifecycle. Populated only when `kind === "task"`; null
   * on every other memory kind. Reading the field off a non-task page
   * yields null even if the column exists in the schema.
   */
  taskState: TaskState | null
  /**
   * Free-form name of the blocker for `taskState === "blocked"` tasks
   * (PR number, person, external service). Empty string when not set —
   * matches the rich_text default elsewhere on the type.
   */
  blockedBy: string
  /**
   * Normalized subject the task is about. Matches the legacy fact
   * Subject field for migrated tasks. Empty string when not set;
   * `lore-query action='ask'` and `lore-task action='list'` filter
   * against this column server-side.
   */
  entity: string
  /**
   * Stable identifier for upsert grouping (0.9.0/#01). Empty string
   * when unset (legacy rows and pre-#06 saves). Distinct from the
   * `Topic` relation column — Topic is a faceted-browsing axis,
   * Topic Key groups revisions of the same canonical concept so
   * `lore-memory action='save'` can append-revision instead of
   * creating a new row. Format is kebab-case path like
   * `decision/jwt-auth`, enforced at #06's save-path validation.
   */
  topicKey: string
  /**
   * System-managed counter incremented on every topic-key upsert
   * (0.9.0/#06). Defaults to 1 for fresh rows and for legacy rows
   * (`extractNumber` returns null, coalesced to 1 by `pageToMemory`).
   * #10 surfaces the count on listings when ≥2.
   */
  revisionCount: number
  /**
   * Memory page IDs this memory has been judged against by
   * `lore-memory action='compare'` (0.9.0/#05). Empty for legacy rows
   * and for memories that have never been compared. The relation is
   * `single_property` on the Notion side, so #05's calling code is
   * responsible for symmetric writes (A→B and B→A).
   */
  comparedWith: string[]
  /**
   * Append-only NDJSON audit trail for compare verdicts. Final audit
   * lines use one JSON line per call to `lore-memory action='compare'`:
   * `{"verdict": ..., "target": ..., "reason": ..., "judgedAt": ...,
   * "promptVersion": ...}`. Actionable verdicts may also append
   * internal `{"entryType":"compare_dispatch", ...}` ledger lines
   * so retries can prove a Confidence Score decrement already landed.
   * Empty string for legacy rows. Capped via `COMPARE_NOTES_MAX_CHARS`
   * in `src/core/memory.ts`; the append helpers throw on overflow
   * rather than truncating so over-compared memories surface to the
   * operator.
   */
  compareNotes: string
}

export interface CreateMemoryInput {
  title: string
  content: string
  projectIds?: string[]
  topicId?: string
  source?: MemorySource
  kind?: MemoryKind
  status?: MemoryStatus
  confidence?: MemoryConfidence
  /**
   * Optional initial Confidence Score. Production callers leave this
   * unset — the column is system-managed via `touchOnRead` (#03) / decay
   * (#03) / contradiction signals (#06). Test fixtures and migrations may
   * set it explicitly. `null` clears the column to "never scored".
   */
  confidenceScore?: number | null
  reviewBy?: string
  decidedAt?: string
  /**
   * Service-layer-only field. Not exposed on the MCP tool surface — the
   * column is system-managed by `MemoryService.touchOnRead` (#03) and the
   * `--build-confidence-scores` migration (#11), not by agents.
   */
  lastReferencedAt?: string
  supersedesIds?: string[]
  affectsIds?: string[]
  alternatives?: string
  consequences?: string
  author?: string
  agent?: string
  /**
   * Writes from MCP tools are constrained to the closed `Tag` vocabulary by
   * Zod; the service layer accepts `string[]` so legacy data and internal
   * migrations (which re-save existing tags) can flow through without a
   * second validation pass.
   */
  tags?: string[]
  keywords?: string
  /**
   * 1–2 sentence synopsis. Soft-capped at 500 chars by Zod at the MCP
   * boundary; the service layer accepts any string for legacy data and
   * internal migrations.
   */
  synopsis?: string
  session?: string
  /** Task-specific. Defaults to `"open"` when `kind === "task"`. */
  taskState?: TaskState
  /** Free-form blocker label. Only meaningful on `kind === "task"`. */
  blockedBy?: string
  /** Normalized subject. Only meaningful on `kind === "task"`. */
  entity?: string
  /**
   * Stable identifier for upsert grouping (0.9.0/#01). Format is
   * kebab-case path like `decision/jwt-auth`. Validation lives at the
   * MCP boundary; the service layer accepts any string so internal
   * migrations can re-write existing keys without re-validating.
   */
  topicKey?: string
  /**
   * Initial revision count. Production callers leave this unset — the
   * column defaults to 1 for fresh creates. Set explicitly by
   * `upsertByTopicKey` when seeding a fresh row in the upsert path.
   */
  revisionCount?: number
}

export interface UpdateMemoryInput {
  title?: string
  content?: string
  projectIds?: string[]
  topicId?: string
  tags?: string[]
  keywords?: string
  synopsis?: string
  kind?: MemoryKind
  status?: MemoryStatus
  confidence?: MemoryConfidence
  /**
   * Optional Confidence Score update. Production callers leave this unset —
   * the column is system-managed via `touchOnRead` (#03) / decay (#03) /
   * contradiction signals (#06). Test fixtures and migrations may set it
   * explicitly. `null` clears the column to "never scored".
   */
  confidenceScore?: number | null
  reviewBy?: string | null
  decidedAt?: string | null
  /**
   * Service-layer-only field. Pass `null` to clear; `undefined` (the
   * default) leaves the column untouched. Not exposed on the MCP tool
   * surface — `Last Referenced At` is system-managed by
   * `MemoryService.touchOnRead` (#03) and the `--build-confidence-scores`
   * migration (#11).
   */
  lastReferencedAt?: string | null
  supersedesIds?: string[]
  affectsIds?: string[]
  alternatives?: string
  consequences?: string
  taskState?: TaskState
  blockedBy?: string
  entity?: string
}

/**
 * Search execution mode. Trades off scope precision against ranking quality:
 *
 * - `"contains"` — `dataSources.query` against the Memories DB with
 *   `Title contains` / `Keywords contains` / `Synopsis contains` filters.
 *   Strictly DS-scoped (no workspace leakage), supports server-side property
 *   filters (`kind` / `status` / `tags`), but loses Notion's vector relevance
 *   ranking over page bodies. Best for substring/exact-phrase queries on
 *   titles, keyword tokens (PR numbers, ticket IDs, function names), and the
 *   short curated synopsis written at save time.
 * - `"semantic"` — workspace-wide `client.search` ranked by Notion's vector
 *   index over titles AND bodies. Preserves relevance ranking, but cannot
 *   apply server-side property filters and may rank non-Memory pages from
 *   the same workspace ahead of real hits when the query is niche. Best for
 *   phrase-shaped or conceptual queries where body matches matter.
 * - `"hybrid"` (default) — fires `contains` and `semantic` in parallel via
 *   `Promise.allSettled`. If contains saturates
 *   (`>= HYBRID_FALLBACK_THRESHOLD` hits), the contains rows are used
 *   alone and the parallel semantic result is discarded; otherwise the
 *   two ranked lists are merged via Reciprocal Rank Fusion (RRF) with
 *   a deterministic tie-break (`score → best-rank → contains-presence
 *   → page id`). Speculative parallelism keeps the worst-case wall-clock
 *   at one round-trip (≈ `client.search` latency) regardless of which
 *   leg saturates — the cheap-path waste is one discarded Notion call
 *   governed by the shared rate limiter.
 */
export type SearchMode = "contains" | "semantic" | "hybrid"

export interface SearchMemoriesInput {
  query: string
  projectId?: string
  topicId?: string
  /**
   * Search/read filters accept any tag string, not just the closed
   * `Tag` vocabulary — legacy memories predate the vocabulary and must
   * remain filterable. Applied server-side in `mode: "contains"` (and the
   * contains leg of `"hybrid"`); applied as a post-filter in `"semantic"`.
   */
  tags?: string[]
  /**
   * Server-side filter in `"contains"` (and the contains leg of `"hybrid"`);
   * post-filter in `"semantic"` because `client.search` does not accept
   * property filters.
   */
  kind?: MemoryKind
  status?: MemoryStatus
  limit?: number
  /**
   * When false, skip the per-page `retrieveMarkdown` round-trip and return
   * memories with `content: ""`. Used by callers that render only title /
   * date / tags — e.g. the shell wake-up hook's related-memories section —
   * so the hot path doesn't pay N+1 markdown fetches.
   */
  includeContent?: boolean
  /**
   * Search execution mode. Defaults to `"hybrid"`. See `SearchMode` for the
   * tradeoffs between scope precision and ranking quality.
   */
  mode?: SearchMode
  /**
   * Optional disambiguator. Threaded into the semantic branch's
   * relevance query as context, NEVER into the contains branch's
   * substring match. Use when `query` is short and ambiguous and the
   * caller knows which sense they mean (e.g. `query: "auth"`,
   * `intent: "WeChat session cookie"`).
   *
   * Whitespace-only intent (`"   "`) normalizes to unset across every
   * consumer.
   *
   * Under `mode: "hybrid"` (default), setting intent disables the
   * saturation cutoff so the RRF merge always runs — intent would
   * otherwise be discarded when contains has `>= HYBRID_FALLBACK_THRESHOLD`
   * hits. Under RRF, the contains lane is up-weighted so contains-precision
   * still dominates ordering. Has no effect under `mode: "contains"`.
   */
  intent?: string
}

/**
 * Per-row diagnostic for `MemoryService.searchWithExplain`. One entry per
 * memory in the result list, aligned by index (`explain[i]` describes
 * `memories[i]`).
 *
 * The `branch` field carries the resolved-mode information explicitly so
 * a reader doesn't have to infer it from null patterns. Branch-field
 * semantics are pinned:
 *
 * - `"contains-only"` — `mode: "contains"`. `semanticRank` is always
 *   `null`; `rrfScore` is `null`.
 * - `"semantic-only"` — `mode: "semantic"` (including the
 *   `LORE_FORCE_SEMANTIC_SEARCH=1` kill-switch case). `containsRank`
 *   is always `null`; `rrfScore` is `null`.
 * - `"contains-saturated"` — `mode: "hybrid"` and the saturation cutoff
 *   fired. `containsRank` reflects the row's position in the contains
 *   list; `semanticRank` is **always `null`** because the semantic
 *   branch's output was discarded — surfacing its rank would imply
 *   influence on ordering that did not happen. `rrfScore` is `null`.
 * - `"rrf"` — `mode: "hybrid"` and the under-saturation merge ran.
 *   Both ranks reflect actual branch presence (one may be `null` when
 *   only one branch surfaced the row); `rrfScore` is the fused score
 *   used for ordering.
 *
 * Field names are canonical to lore (qmd uses `lexRank` for the contains
 * lane; we keep `containsRank` because the underlying Notion query is
 * a `contains` filter, not a lexical index). A test pins the names so
 * they don't drift toward qmd vocabulary in a future refactor.
 */
export interface SearchExplain {
  memoryId: string
  /** 0-based; null when contains did not run or did not surface this row. */
  containsRank: number | null
  /** 0-based; null when semantic did not run, was discarded, or did not surface this row. */
  semanticRank: number | null
  /** Populated only on the `"rrf"` branch; null on every other branch. */
  rrfScore: number | null
  branch: "contains-only" | "semantic-only" | "contains-saturated" | "rrf"
  /**
   * The confidence-weighting factor applied to this row's per-branch RRF
   * score. `1.0` for unscored (pre-migration `Confidence Score = null`)
   * or fully-trusted rows; `CONFIDENCE_FACTOR_MIN` (default `0.5`) for
   * fully-decayed rows. Multiplied into the score in
   * `MemoryService.searchByHybridPages` and the single-branch
   * `searchByContainsPages` / `searchBySemanticPages` paths.
   *
   * 0.8.0+. Older traces (pre-0.8.0 fixtures) have this field absent;
   * deserialize-aware consumers tolerate the missing field.
   */
  confidenceFactor: number
}

// ---------------------------------------------------------------------------
// Decision (a Memory with Kind = "decision")
// ---------------------------------------------------------------------------

/**
 * Narrowed lifecycle for decisions — excludes `informational` since every
 * decision has an explicit lifecycle state.
 */
export type DecisionStatus = Exclude<MemoryStatus, "informational">

/**
 * Decisions whose `status` qualifies them as "currently governing." A
 * decision in `superseded`, `deprecated`, or `rejected` is conceptually
 * inactive and should never surface as a current/governing decision via
 * `resolveCurrentDecisions` or the near-duplicate probe pool.
 *
 * Single source of truth — both the BFS leaf filter in
 * `src/mcp/decision-graph.ts` and the near-duplicate probe in
 * `src/mcp/tools/decisions.ts` consult this list, so a status added or
 * removed here flows to both surfaces in lockstep.
 */
export const ACTIVE_DECISION_STATUSES: DecisionStatus[] = ["accepted", "proposed"]

/**
 * A decision is a Memory where `kind === "decision"`. Exposed as a distinct
 * type so downstream code can narrow against the discriminator without
 * runtime checks.
 */
export type Decision = Memory & { kind: "decision" }

/**
 * Lightweight decision summary — no markdown body. Returned by
 * `DecisionService.list()` and tools that page through decisions without
 * fetching content (avoids the N+1 `retrieveMarkdown` cost).
 */
export type DecisionSummary = Omit<Decision, "content">

export interface CreateDecisionInput {
  /** One-line decision statement. Becomes the page title. */
  decision: string
  /** Prose explaining why the decision was made. Becomes the page body. */
  rationale: string
  projectIds?: string[]
  topicId?: string
  status?: DecisionStatus
  confidence?: MemoryConfidence
  reviewBy?: string
  decidedAt?: string
  /** Memory IDs this decision supersedes. */
  supersedesIds?: string[]
  /** Memory IDs this decision affects (for auto-created `decided_by` facts). */
  affectsIds?: string[]
  alternatives?: string
  consequences?: string
  tags?: string[]
  keywords?: string
  /**
   * One-line synopsis of the governing rule — distinct from `decision` (the
   * title) and `rationale` (the body). Soft-capped at 500 chars by Zod at the
   * MCP boundary; the service layer accepts any string for legacy data and
   * internal migrations.
   */
  synopsis?: string
  /**
   * Engineer-identity attribution stamped on the Memory `Author`
   * column (DEFERRED-ATTRIBUTION). The MCP tool layer defaults to
   * `services.identity.author` when the caller omits this; service-
   * layer callers (migrations, internal tooling) pass through verbatim.
   */
  author?: string
  agent?: string
  session?: string
}

export interface ListDecisionsOpts {
  projectId?: string
  status?: DecisionStatus
  /** Return only decisions with `Review By` on or before this date. */
  reviewBefore?: string
  limit?: number
  since?: string
  until?: string
  /**
   * Opaque cursor from a previous page's `nextCursor`. When provided,
   * continues enumeration from where that page ended.
   */
  startCursor?: string
}

// ---------------------------------------------------------------------------
// Task (a Memory with Kind = "task")
// ---------------------------------------------------------------------------

/**
 * A task is a Memory where `kind === "task"`. Same shape as Memory —
 * `taskState`, `blockedBy`, `entity` are guaranteed non-null on this
 * subtype because the create path always populates them. Exposed as a
 * distinct type so downstream code can narrow against the discriminator
 * without runtime checks.
 */
export type Task = Memory & {
  kind: "task"
  taskState: TaskState
}

/**
 * Lightweight task summary — no markdown body. Returned by
 * `TaskService.list()` for the index-tier triage paths
 * (`lore-task action='list'`, wake-up Tasks section) so they don't
 * pay an N+1 `retrieveMarkdown` cost.
 */
export type TaskSummary = Omit<Task, "content">

export interface CreateTaskInput {
  /** One-line task subject. Becomes the page title. */
  subject: string
  /** Description / context. Becomes the page body. */
  description?: string
  projectIds?: string[]
  topicId?: string
  /** Defaults to `"open"`. */
  state?: TaskState
  /** Free-form blocker label, used when `state === "blocked"`. */
  blockedBy?: string
  /**
   * Normalized entity name the task is about. Defaults to `subject` when
   * omitted so `lore-query action='ask'` always has something to match.
   */
  entity?: string
  /** Due date / next review. Maps to the `Review By` column. */
  dueDate?: string
  confidence?: MemoryConfidence
  /**
   * Source memory IDs that motivated this task. Maps to `Affects` —
   * mirroring how migrated tasks carry the original fact's
   * `sourceMemoryId` forward.
   */
  affectsIds?: string[]
  alternatives?: string
  consequences?: string
  tags?: string[]
  keywords?: string
  /**
   * One-line synopsis of what the task is about and what "done" looks like —
   * distinct from `subject` (short title) and `description` (the body).
   * Soft-capped at 500 chars by Zod at the MCP boundary; the service layer
   * accepts any string for legacy data and internal migrations.
   */
  synopsis?: string
  /**
   * Engineer-identity attribution stamped on the Memory `Author`
   * column (DEFERRED-ATTRIBUTION). Same posture as `CreateDecisionInput`
   * — MCP tool defaults from `services.identity.author`.
   */
  author?: string
  agent?: string
  session?: string
}

export interface UpdateTaskInput {
  state?: TaskState
  blockedBy?: string
  entity?: string
  /** New due date (`Review By`). Pass empty string to clear. */
  dueDate?: string | null
  subject?: string
  description?: string
  tags?: string[]
  keywords?: string
  synopsis?: string
  affectsIds?: string[]
}

export interface ListTasksOpts {
  projectId?: string
  /**
   * Filter to one or more entity variants. Each variant runs as
   * `Entity rich_text contains <variant>`; multiple variants compose
   * server-side as an OR so a single canonical entity's aliases all
   * recall the same task set. Deduplicated and trimmed by the caller —
   * `TaskService.list` lifts an empty list to "no entity filter."
   *
   * Singular-input call sites (`lore-task action='list'`) wrap their
   * one user-facing string into a one-element array; alias-expanding
   * call sites (`lore-query action='ask'`) hand in the canonical name
   * plus aliases from `EntityService`. Caps live at the boundary that
   * owns the expansion (see `expandEntityQueryVariants` in
   * `core/entity.ts`).
   */
  entities?: string[]
  /** Filter by state. Omit to use `ACTIVE_TASK_STATES`. */
  states?: TaskState[]
  /** Only tasks with `Review By` on or before this date. */
  dueBefore?: string
  /** Only tasks whose `Review By` is after this date, or empty. */
  dueAfterOrEmpty?: string
  /**
   * Sort order for index-tier task listings. Defaults to `reviewByAsc`,
   * the triage-list order used by `lore-task action='list'`.
   */
  sortBy?: "reviewByAsc" | "updatedAtAsc" | "updatedAtDesc"
  limit?: number
  startCursor?: string
}

// ---------------------------------------------------------------------------
// Entity (Canonical entity registry — PF3-01)
// ---------------------------------------------------------------------------

/**
 * Discriminator for Entity rows. Open enum on purpose — agents will hit
 * cases the enum doesn't yet cover (a new domain that wants its own
 * label) and the right move is to add the value, not force it into a
 * neighbour. Sized to the spec's call-out so the migration path lands on
 * a stable starting set.
 */
export type EntityKind =
  | "class"
  | "function"
  | "file"
  | "workflow"
  | "pr"
  | "task-id"
  | "person"
  | "system"

export const ENTITY_KINDS: EntityKind[] = [
  "class",
  "function",
  "file",
  "workflow",
  "pr",
  "task-id",
  "person",
  "system",
]

export interface Entity {
  id: string
  /** Canonical display name. Title cell on the Entities DB. */
  name: string
  /**
   * Comma-separated alias forms that resolve to this entity. Stored as
   * one rich_text cell rather than a multi_select because the alias
   * values are free-form (case-variant subjects, richer-handle suffixes,
   * legacy spellings) and a closed select option set would force every
   * new alias through a schema migration.
   */
  aliases: string[]
  kind: EntityKind | null
  description: string
  /**
   * Notion `Project` relation ids. A single canonical entity can be
   * scoped to multiple projects (a class referenced by facts in
   * several services accumulates union scope on each touch — see
   * `EntityService.resolveOrCreateEntity`'s match branches). Empty
   * array means vault-wide.
   *
   * **Optional on the exported type** so external consumers
   * constructing `Entity`-shaped fixtures, mocks, or adapter objects
   * stay source-compatible across this addition. Internal callers can
   * rely on the runtime always populating it (`pageToEntity` calls
   * `extractRelationIds(Project)` which returns `[]` on absent /
   * legacy rows), but reads should normalize via `?? []` anyway so a
   * partially-constructed external Entity doesn't blow up the
   * service.
   */
  projectIds?: string[]
  /**
   * Whether the underlying Notion page is archived. Optional for source
   * compatibility; service-produced entities populate it.
   */
  archived?: boolean
}

export interface CreateEntityInput {
  name: string
  aliases?: string[]
  kind?: EntityKind
  description?: string
  /**
   * Project scope for the new Entity row. The auto-create path in
   * `EntityService.resolveOrCreateEntity` forwards the originating fact's
   * project ids through here so canonical handles minted from a
   * project-scoped fact carry the same relation, instead of landing as
   * unscoped (vault-wide) rows. Empty / omitted leaves the relation empty
   * for genuinely unscoped callers.
   */
  projectIds?: string[]
}

/**
 * Result of `EntityService.resolveOrCreateEntity`. A unique match returns
 * `{ entity, ambiguous: false }`; multiple matches return
 * `{ entity: null, ambiguous: true, candidates }` so the caller can
 * surface the candidates back to the agent without auto-picking.
 *
 * `created` is true only when the resolver minted a new row (caller asked
 * for auto-create AND no existing match was found). On strict mode no
 * match returns `{ entity: null, ambiguous: false, candidates: [] }`.
 */
export interface EntityResolution {
  entity: Entity | null
  ambiguous: boolean
  candidates: Entity[]
  created: boolean
}

// ---------------------------------------------------------------------------
// Fact (Knowledge Graph)
// ---------------------------------------------------------------------------

export type FactPredicate =
  | "is_a"
  | "has_a"
  | "uses"
  | "depends_on"
  | "related_to"
  | "created_by"
  | "owned_by"
  | "replaces"
  | "extends"
  | "conflicts_with"
  // Decision-graph predicates — created exclusively by DecisionService.
  // Not exposed through `lore-fact` to keep the decision graph consistent.
  | "decided_by"
  | "supersedes_decision"
  | "informs"
  // Auto-emitted by `lore-memory action='save'` (0.8.0/#07) — one fact
  // per entity surfaced by `extractEntityCandidates` over the saved
  // memory's title / keywords / synopsis. Lower-quality (regex-derived,
  // confidence: speculative) than agent-curated `uses` / `depends_on`
  // facts; the categorical confidence tag lets retrieval prefer the
  // agent-curated edges when both exist. Not exposed through
  // `lore-fact action='create'` because the value is system-managed.
  | "mentions"

export type FactConfidence = "certain" | "likely" | "speculative"

export interface Fact {
  id: string
  subject: string
  predicate: FactPredicate
  object: string
  projectIds: string[]
  validFrom: string | null
  validUntil: string | null
  reviewBy: string | null
  sourceMemoryId: string | null
  confidence: FactConfidence
  /**
   * System-managed numeric confidence in [0, 1]. `null` until the fact has
   * been touched once by a read path (or backfilled by `lore migrate
   * --build-fact-confidence-scores`). Mirrors the Memories DB column —
   * lore-ask reads this as a weighting factor over the existing recency
   * sort (DEFERRED-02). Distinct from the agent-curated `confidence`
   * categorical above. Optional on the type for the same backward-compat
   * reason as `subjectEntityId`: pre-DEFERRED-02 `Fact` JSON would
   * otherwise fail validation. Internal `pageToFact` always populates
   * (`null` when the column is absent).
   */
  confidenceScore?: number | null
  /**
   * Most-recent read-citation date in `YYYY-MM-DD` form; `null` until the
   * fact has been touched once by a read path (or backfilled by
   * `lore migrate --build-fact-confidence-scores`). Mirrors the Memories
   * DB column. Distinct from `validFrom` (relationship-validity start) and
   * Notion's `last_edited_time` (write timestamp). Optional for backward
   * compat; `pageToFact` always populates.
   */
  lastReferencedAt?: string | null
  /**
   * Notion `created_time` propagated through `pageToFact`. Used by
   * `decrementConfidence`, `touchOnRead`, and the
   * build-fact-confidence-scores migration as the decay anchor when
   * `lastReferencedAt` is null (the row has never been touched).
   *
   * Optional on the public type (`Fact` is exported from
   * `src/index.ts`) so adding the field is not a TypeScript source-
   * compat break for external consumers building `Fact`-shaped object
   * literals or fixtures. Internal `pageToFact` always populates the
   * field — every domain-internal callsite reads `fact.createdAt`
   * after a fresh `pageToFact` deserialization — so the runtime
   * guarantee is "always present" even though the type permits
   * `undefined`. The internal helpers that consume this field
   * (`invalidate`, `touchOnRead`, the migration) assert presence at
   * the call site; if a future test fixture or external API surface
   * starts deserializing partial `Fact` objects without `createdAt`,
   * those call sites will throw a TypeError on the `.slice(0, 10)`
   * call rather than silently rounding decay to zero.
   */
  createdAt?: string
  /**
   * Entity ID the fact's Subject relates to. Populated by the
   * build-entities migration and by `lore-fact action='create'`
   * after the resolver runs. `null` on unbackfilled rows; queries that
   * filter by entity must accept that and fall back to the SubjectKey /
   * Subject substring path.
   *
   * Optional on the type — external consumers deserializing older
   * `Fact` JSON would otherwise see "missing field" validation errors.
   * Internal `pageToFact` always populates the field (`null` when the
   * relation is empty), so domain-internal callers can rely on it being
   * present without an explicit guard.
   */
  subjectEntityId?: string | null
  /** Mirror of `subjectEntityId` for the Object side of the triple. */
  objectEntityId?: string | null
}

export interface CreateFactInput {
  subject: string
  predicate: FactPredicate
  object: string
  projectIds?: string[]
  validFrom?: string
  reviewBy?: string
  sourceMemoryId?: string
  confidence?: FactConfidence
  /**
   * Pre-resolved entity ids. When provided, the create path skips its
   * resolver pass and writes the relation directly. When omitted, the
   * caller is expected to resolve via `EntityService.resolveOrCreateEntity`
   * before reaching the service — leaving these `undefined` produces a
   * fact whose Subject/Object text are the only handles. Queries fall
   * back to the SubjectKey path for those rows.
   */
  subjectEntityId?: string
  objectEntityId?: string
}

// ---------------------------------------------------------------------------
// Config (.lore.yaml)
// ---------------------------------------------------------------------------

export interface ProjectConfig {
  name: string
  path: string
  tags?: string[]
}

export interface LoreConfig {
  vault: {
    pageId: string
  }
  auth?: {
    /**
     * Soft-deprecated in 0.10.0 — `resolveAuth` treats this as a fallback
     * after `NOTION_API_TOKEN` env and the ntn-resolved token. A
     * one-time-per-config-root stderr warning fires on each session that
     * resolves through this branch; suppress with
     * `LORE_SUPPRESS_DEPRECATIONS=1`. Hard removal is plausible for
     * 1.0.0 contingent on telemetry.
     */
    token?: string
    baseUrl?: string
    /**
     * Workspace id to pick when ntn's `auth.json` carries multiple
     * workspaces. Optional; falls back to `NOTION_WORKSPACE_ID` env, then
     * to single-workspace auto-pick. Has no effect on the
     * `NOTION_API_TOKEN` / `LORE_NOTION_TOKEN` / `auth.token` paths —
     * those carry whatever workspace the operator's token was issued
     * against and Lore can't introspect that without an API call.
     */
    workspaceId?: string
  }
  notion?: {
    rateLimit?: {
      /**
       * Max outbound Notion API calls in flight at once. Shared across every
       * tool call and hook spawned by this process. Defaults to 3 to match
       * Notion's public rate-limit guidance.
       */
      concurrency?: number
      /**
       * Sustained outbound request rate, in calls/second. Token-bucket
       * refill rate enforced by `createLimitedClient`. Defaults to 3 to
       * match Notion's per-token public rate-limit guidance. Distinct
       * from `concurrency`: the latter caps fan-out memory; this caps
       * throughput.
       */
      requestsPerSecond?: number
      /**
       * Token-bucket capacity — how many calls may fire instantly after
       * a quiet period. Defaults to 3. A larger burst lets short
       * fan-outs (decision-graph walks, render-layer title lookups) run
       * without paying refill latency; the sustained ceiling is still
       * `requestsPerSecond`.
       */
      burstSize?: number
    }
  }
  projects?: ProjectConfig[]
  detect?: {
    patterns?: string[]
    exclude?: string[]
  }
  hooks?: {
    autoSave?: boolean
    wakeUp?: boolean
    /**
     * Background digest synthesizer scheduled by the Stop hook. Fires at
     * most once per project per 7 days via a filesystem marker. Default:
     * true. Honors `LORE_AUTO_DIGEST=false` env override as well — either
     * disables the auto-spawn without affecting the manual `lore digest` CLI.
     */
    autoDigest?: boolean
    /**
     * Atomic-learning extraction inside the Stop-spawn autosave sub-agent
     * (0.9.0/08). When true (default) the sub-agent is asked to identify
     * single-fact discoveries and save each as its own `note` memory, in
     * addition to the session synopsis it already writes. When false, the
     * autosave reproduces the 0.8.x synopsis-only shape. Honors
     * `LORE_DISABLE_LEARNING_EXTRACTION=1` env override — either knob set
     * to disabled wins (AND-of-permissive).
     */
    learningExtraction?: boolean
    /** Real user messages between structured AI-driven saves. Default: 5. */
    saveInterval?: number
    /**
     * Background-agent worker configuration (issue #194). Lore's autosave
     * and auto-digest paths shell out to a detached agent CLI to do the
     * structured save / digest synthesis. Defaults to `claude -p` with the
     * shape Claude Code installs assume. Codex-only operators (or anyone
     * who wants to try a different agent CLI) override `command` to point
     * at an alternate binary and `args` to pass that binary's headless
     * flags. Each spawn substitutes `{{allowedTools}}` in `args` for the
     * tool allowlist string — operators whose CLI does not accept an
     * allowlist flag should omit the placeholder. Honors
     * `LORE_BACKGROUND_COMMAND` env override on `command` for ad-hoc
     * experimentation without editing `.lore.yaml`.
     */
    backgroundAgent?: {
      /** Binary name (resolved on PATH) or absolute path. Default: "claude". */
      command?: string
      /**
       * Args passed to the binary verbatim, with `{{allowedTools}}` replaced
       * by the tool allowlist string at spawn time. The placeholder appears
       * once in the default; multiple occurrences are all replaced; omitting
       * it skips the allowlist hand-off entirely (operators whose CLI takes
       * the allowlist via env or stdin instead).
       */
      args?: string[]
    }
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface ResolvedContext {
  vault: Vault
  project: Project | null
  cwd: string
  /**
   * True when `project` was resolved by falling back to a monorepo catch-all
   * (a config entry with path `"."` or `""`). Save tools use this to surface
   * a warning prompting the agent to scope memories to a sub-project.
   */
  isCatchAllFallback: boolean
}
