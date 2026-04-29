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
   * Canonical-entity registry (PF3-01). Sits between Memories and Facts in
   * the dependency graph because Facts now relate to Entity rows via
   * `SubjectEntity` / `ObjectEntity` while Entities themselves only
   * reference Projects + Memories.
   *
   * Optional in the type so a vault that pre-dates PF3-01 still loads
   * without a hard error — `verifyVaultDatabases` populates the field
   * only when the database exists. Code paths that read `entities` must
   * guard against `undefined` and fall back to the SubjectKey/Subject
   * substring path.
   */
  entities?: DatabaseRef
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

export interface Memory {
  id: string
  title: string
  projectIds: string[]
  topicId: string | null
  source: MemorySource
  kind: MemoryKind
  status: MemoryStatus
  confidence: MemoryConfidence
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
  reviewBy?: string
  decidedAt?: string
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
  reviewBy?: string | null
  decidedAt?: string | null
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
 *   `Title contains` / `Keywords contains` filters. Strictly DS-scoped (no
 *   workspace leakage), supports server-side property filters
 *   (`kind` / `status` / `tags`), but loses Notion's vector relevance ranking
 *   over page bodies. Best for substring/exact-phrase queries on titles and
 *   keyword tokens (PR numbers, ticket IDs, function names).
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
}

export interface CreateEntityInput {
  name: string
  aliases?: string[]
  kind?: EntityKind
  description?: string
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
   * Entity ID the fact's Subject relates to. Populated post-PF3-01 by
   * the build-entities migration and by `lore-fact action='create'`
   * after the resolver runs. `null` on un-migrated rows; queries that
   * filter by entity must accept that and fall back to the SubjectKey /
   * Subject substring path.
   *
   * Optional on the type — external consumers deserializing pre-PF3-01
   * `Fact` JSON would otherwise see "missing field" validation errors.
   * Internal `pageToFact` always populates the field (`null` when the
   * column is absent), so domain-internal callers can rely on it being
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
   * fact whose Subject/Object text are the only handles, just like
   * pre-PF3-01 rows. Queries fall back to the SubjectKey path for those.
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
    token?: string
    baseUrl?: string
  }
  notion?: {
    rateLimit?: {
      /**
       * Max outbound Notion API calls in flight at once. Shared across every
       * tool call and hook spawned by this process. Defaults to 3 to match
       * Notion's public rate-limit guidance.
       */
      concurrency?: number
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
    /** Real user messages between structured AI-driven saves. Default: 5. */
    saveInterval?: number
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
