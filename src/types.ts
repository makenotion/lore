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

export type MemorySource = "conversation" | "file" | "manual" | "agent_diary" | "digest"

/**
 * What kind of memory this is. Used as a server-side discriminator so
 * tools like `lore-list-decisions` can filter without post-processing.
 *
 * `task` memories carry tracking-style state (open / blocked / done) and
 * supersede the legacy tracking-predicate facts (`needs_action` /
 * `waiting_on` / `blocked_by`). The Memories DB hosts them so the title
 * is a structured subject and the body holds the full description —
 * compare to facts where the Object field is a 2000-char rich_text and
 * structural queries fall apart on prose.
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
 * Lifecycle state for `Kind = task` memories. Mirrors the predicates the
 * legacy tracking facts encoded:
 *
 * - `open` — needs action; no one yet picking it up. Default for fresh
 *   tasks and for migrated `needs_action` / `waiting_on` facts.
 * - `in-progress` — actively being worked.
 * - `blocked` — waiting on an external dependency. Pair with `Blocked By`
 *   to name the blocker (PR number, person, service). Migrated
 *   `blocked_by` facts land here.
 * - `done` — closed successfully. `lore-task-close` writes this.
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
 *  `lore-tasks` and the wake-up Tasks section by default. */
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
   * `lore-search` finds them, but kept out of the tag index.
   */
  keywords: string
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
   * `lore-ask` and `lore-tasks` filter against this column server-side.
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

export interface SearchMemoriesInput {
  query: string
  projectId?: string
  topicId?: string
  /**
   * Search/read filters accept any tag string, not just the closed
   * `Tag` vocabulary — legacy memories predate the vocabulary and must
   * remain filterable.
   */
  tags?: string[]
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
 * `TaskService.list()` for the index-tier triage paths (`lore-tasks`,
 * wake-up Tasks section) so they don't pay an N+1 `retrieveMarkdown`
 * cost.
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
   * omitted so `lore-ask(entity)` always has something to match.
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
  affectsIds?: string[]
}

export interface ListTasksOpts {
  projectId?: string
  /**
   * Filter to a specific entity. Matches against the `Entity` column
   * server-side via `rich_text.contains` — same scoping rule
   * `lore-ask(entity)` uses.
   */
  entity?: string
  /** Filter by state. Omit to use `ACTIVE_TASK_STATES`. */
  states?: TaskState[]
  /** Only tasks with `Review By` on or before this date. */
  dueBefore?: string
  limit?: number
  startCursor?: string
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
  | "needs_action"
  | "waiting_on"
  | "blocked_by"
  // Decision-graph predicates — created exclusively by DecisionService.
  // Not exposed through `lore-learn` to keep the decision graph consistent.
  | "decided_by"
  | "supersedes_decision"
  | "informs"

/** Predicates that represent open loops / tracked items. */
export const TRACKING_PREDICATES: FactPredicate[] = [
  "needs_action",
  "waiting_on",
  "blocked_by",
]

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
     * Background digest synthesizer scheduled by the session-end hook. Fires
     * at most once per project per 7 days via a filesystem marker. Default:
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
