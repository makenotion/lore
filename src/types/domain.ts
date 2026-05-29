/**
 * Core domain types for Lore.
 *
 * Vault → Project → Topic → Memory
 * → Fact (knowledge graph)
 */

import type { MemoryScope, MemoryScopeInput } from "./scope.js"

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
 * Curated from a frequency census against the internal vault: the
 * high-signal labels cluster into engineering discipline (`architecture`,
 * `testing`, `performance`), platform (`ios`, `backend`, `web`), document
 * kind (`gotcha`, `runbook`, `postmortem`), and workflow (`code-review`,
 * `migration`, `deployment`). Technology-specific names (`tuist`, `tca`,
 * `prisma`) intentionally live in `Keywords` — they don't survive across
 * vaults and would bloat the enum.
 */
export const DEFAULT_TAG_VOCABULARY = [
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

export const TAG_VOCABULARY = DEFAULT_TAG_VOCABULARY

export type Tag = (typeof DEFAULT_TAG_VOCABULARY)[number]

/**
 * Structural cap on the Synopsis property. The Notion rich_text per-block
 * ceiling is 2000; 500 is Lore's storage/rendering ceiling for this field.
 * Normal memory authoring uses `DEFAULT_MEMORY_SYNOPSIS_MAX` unless the
 * vault opts into a different `memory.synopsisMaxChars` value.
 *
 * Lives here because the cap is structural to the property, not specific
 * to any one consumer. The renderer and the backfill synthesizer import it.
 */
export const SYNOPSIS_MAX = 500

/**
 * Default authoring cap for `lore-memory` synopses. Wake-up, recall, and
 * downstream index mirrors render synopses as scan hooks, so fresh memory
 * writes default to a tighter budget than the structural storage ceiling.
 */
export const DEFAULT_MEMORY_SYNOPSIS_MAX = 150

/**
 * Days since `last_edited_time` past which an active task is considered
 * stale and surfaces with a "consider closing" prompt in wake-up.
 * Conservative: 30 days is long enough to absorb a vacation or a
 * context-switched project, short enough to flag truly-forgotten work.
 * Read by the `taskDaysStale` helper, the wake-up Tasks rendering, and
 * the `lore status` / `lore-context action='status'` task summary line.
 *
 * A future operator-tuning knob (`hooks.staleTaskDays` in .lore.yaml)
 * is the next step if real-vault feedback shows 30 is wrong; the const
 * is the single source of truth.
 */
export const STALE_TASK_DAYS = 30

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export type ProjectType = "project" | "person" | "agent"
export type ProjectStatus = "active" | "archived"
export type ProjectListStatus = ProjectStatus | "any"

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
 * Where a memory originated. `agent_diary` is retained for stored rows and
 * explicit audit reads, but write surfaces accept only `conversation`, `file`,
 * `manual`, and `digest`.
 */
export type MemorySource = "conversation" | "file" | "manual" | "agent_diary" | "digest"

/**
 * What kind of memory this is. Used as a server-side discriminator so
 * tools like `lore-decision action='list'` can filter without post-processing.
 *
 * `procedure` memories are reviewed, fleet-wide operating knowledge
 * promoted from resolved episodes (closed tasks, resolved incidents,
 * postmortems, high-confidence notes). Adapted from the LangMem
 * episodic / semantic / procedural taxonomy — episodes remain
 * inspectable history; procedures become the "when this situation
 * appears, this sequence worked" surface agents reach for. The page
 * body carries structured `## Activation Conditions / ## Steps /
 * ## Known Failure Modes / ## Sources` sections; the supporting
 * source memory ids render under `## Sources` (body, not relation).
 * `Supersedes` is reserved for replacement chains — a procedure that
 * retires an older procedure or runbook writes that predecessor id
 * onto the relation; sources stay in the body. Always reviewed before
 * promotion (`Status = proposed` → `accepted`); never written
 * silently by autosave or background jobs.
 *
 * `task` memories carry tracking-style state (open / blocked / done) and
 * are the canonical surface for tracked work. The Memories DB hosts them
 * so the title is a structured subject and the body holds the full
 * description — compare to facts where the Object field is a 2000-char
 * rich_text and structural queries fall apart on prose.
 *
 * `state` memories are subject-canonical current-state projections. They use
 * topic-key upsert chains (`state/<subject>`) so repeated writes replace the
 * wake-up-visible row while preserving prior revisions in the page body.
 *
 * `operational` memories are temporary coordination receipts: PR poll
 * state, closeout banners, build run breadcrumbs, or other entries that
 * explain recent execution but should not become durable project knowledge.
 * They should carry an expiry declaration (`expiresAt`, `expiresOn`, or
 * the nested scope lifetime fields) so default recall can age them out.
 */
export type MemoryKind =
  | "note"
  | "decision"
  | "incident"
  | "runbook"
  | "postmortem"
  | "policy"
  | "state"
  | "operational"
  | "task"
  | "procedure"

/**
 * Lifecycle state for `Kind = task` memories.
 *
 * - `open` — needs action; no one yet picking it up. Default for fresh
 * tasks.
 * - `in-progress` — actively being worked.
 * - `blocked` — waiting on an external dependency. Pair with `Blocked By`
 * to name the blocker (PR number, person, service).
 * - `done` — closed successfully. `lore-task action='close'` writes this.
 * - `cancelled` — dropped without completion. Distinct from `done` so
 * metrics distinguish "shipped" from "abandoned".
 *
 * Non-task memories carry no Task State; the field is read off the
 * `Task State` Notion column when present and elided otherwise.
 */
export type TaskState = "open" | "in-progress" | "blocked" | "done" | "cancelled"

/** Task states that count as "still owing work" — surfaced by
 * `lore-task action='list'` and the wake-up Tasks section by default. */
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

// ---------------------------------------------------------------------------
// Pinned context blocks
// ---------------------------------------------------------------------------

/**
 * Mutability for a pinned context block.
 *
 * - `mutable` (default) — pinned block can be updated via the normal
 * `lore-memory action='update'` and `lore-pinned action='update'`
 * paths.
 * - `read-only` — protected from `lore-memory action='update'` and
 * from the generic `lore-pinned action='update'` mutation path
 * unless the caller explicitly opts in via
 * `allowReadOnlyUpdate: true`. The override on
 * `lore-pinned action='update'` is `force: true`; every forced
 * write lands a `> Forced read-only update` audit line on the
 * memory body so the override is recoverable from the row
 * itself. The override is a stop-sign visible in the audit trail,
 * not an access-control gate — Lore writes through one operator
 * bearer token, so any MCP caller can flip the flag. See AC #4
 * for the visibility model.
 *
 * Non-pinned memories carry `Mutability = null` (column unset) and
 * default to mutable — the read-only check is gated on `Pinned = true`
 * in the service layer so non-pinned rows are never blocked.
 */
export type MemoryMutability = "mutable" | "read-only"

export const MEMORY_MUTABILITIES: readonly [MemoryMutability, ...MemoryMutability[]] = [
  "mutable",
  "read-only",
]

/**
 * Bundle of pinned-block-specific fields surfaced on `Memory` rows.
 * `null` when the row is not a pinned context block — most memories
 * have this slot empty.
 *
 * - `priority` — sort order; higher first. `0` for legacy rows where
 * the column is unset.
 * - `mutability` — `read-only` rows reject normal save/update; see
 * `MemoryMutability`.
 *
 * Reused scope columns: project relation (project scoping) and
 * `Audience` rich_text (audience targeting — comma-separated tokens
 * compared against the reader's scope context). Both stay on the
 * top-level `scope` slot rather than being duplicated here so the
 * scope/lifetime contract keeps one source of truth.
 */
export interface MemoryPinned {
  priority: number
  mutability: MemoryMutability
}

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
   * --build-confidence-scores`). RRF reads this as a weighting factor;
   * rendering surfaces a trust indicator when below
   * `CONFIDENCE_DISPLAY_THRESHOLD`. Distinct from the agent-curated
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
   * `lore migrate --build-confidence-scores`). Distinct from `updatedAt`
   * (Notion built-in, edit timestamp) and from `createdAt` (Notion
   * built-in, creation timestamp).
   *
   * Decay reads this; the stale-confidence wake-up subsection reads this.
   * RRF does NOT read this directly — the decay function mediates between
   * `lastReferencedAt` and the confidence score.
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
   * one-line gist without a body fetch. This is a scan surface, not a
   * session-history log: write durable signal, not chronological activity.
   * Soft-capped at 500 chars at the MCP and service boundaries; empty
   * string when not set.
   */
  synopsis: string
  /**
   * Event-bound expiry marker such as `pr-closed:owner/repo#123` or
   * `task-closed:<memory-id>`. Empty string when unset. Unlike
   * `scope.expiresAt`, this field does not hide a row by itself; debt scan
   * audits operational rows whose linked closure event can be resolved and
   * whose date expiry has not been applied yet.
   */
  expiresOn?: string
  session: string | null
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
   * Stable identifier for upsert grouping. Empty string when unset
   * (legacy rows and saves without an explicit key). Distinct from the
   * `Topic` relation column — Topic is a faceted-browsing axis,
   * Topic Key groups revisions of the same canonical concept so
   * `lore-memory action='save'` can append-revision instead of
   * creating a new row. Format is kebab-case path like
   * `decision/jwt-auth`, enforced at save-path validation.
   */
  topicKey: string
  /**
   * System-managed counter incremented on every topic-key upsert.
   * Defaults to 1 for fresh rows and for legacy rows
   * (`extractNumber` returns null, coalesced to 1 by `pageToMemory`).
   * Listings surface the count when ≥2.
   */
  revisionCount: number
  /**
   * Memory page IDs this memory has been judged against by
   * `lore-memory action='compare'`. Empty for legacy rows and for
   * memories that have never been compared. The relation is
   * `single_property` on the Notion side, so the calling code is
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
   * Empty string for legacy rows. Capped via `COMPARE_NOTES_MAX_CHARS`;
   * the append helpers throw on overflow rather than truncating so
   * over-compared memories surface to the operator.
   */
  compareNotes: string
  /**
   * System-managed idempotency key for cross-vault promotion target rows.
   * Empty string when unset. Optional on the exported type so older external
   * fixtures stay source-compatible; `pageToMemory` always populates it.
   */
  promotionSourceKey?: string
  /**
   * Scope and lifetime declaration. `null` on rows without a scope
   * declared — retrieval treats null as broadcast scope with
   * `persistent` lifetime, preserving legacy behavior. Bundle of
   * five Notion columns: `Scope Kind`, `Scope Key`, `Audience`,
   * `Lifetime`, `Expires At`.
   *
   * **Optional on the exported type** so external consumers
   * constructing `Memory`-shaped fixtures, mocks, or adapter objects
   * stay source-compatible across this addition. Internal
   * `pageToMemory` always populates the field (`null` when every
   * scope column is empty), so domain-internal callers can rely on
   * it being present without an explicit guard. Same posture as
   * `Entity.projectIds` and `Fact.subjectEntityId`.
   */
  scope?: MemoryScope | null
  /**
   * Pinned-block declaration. `null` when the memory is not a pinned
   * context block — the common case. Populated with `priority` and
   * `mutability` when `Pinned = true` on the Notion row.
   *
   * Audience targeting and project scoping reuse the existing
   * `scope.audience` rich_text and `projectIds` relation respectively,
   * so this slot only carries the pinned-block-specific knobs
   * (priority and mutability).
   *
   * **Optional on the exported type** for the same source-compat
   * reason as `scope`. Internal `pageToMemory` always populates it
   * (`null` on non-pinned rows).
   */
  pinned?: MemoryPinned | null
}

/**
 * `Memory` shape returned by list paths that do NOT fetch the markdown
 * body. The runtime invariant: rows returned with body fetching
 * disabled carry `content: ""`. The literal `""` type encodes that
 * statically — a caller reading `.content` on a `MemoryWithoutContent`
 * sees the empty-string literal type, surfacing the absent-body state
 * as a clear "did I mean to opt in?" signal rather than the unspecific
 * `string` type.
 *
 * `MemoryWithoutContent` is structurally assignable to `Memory`
 * (since `"" extends string`), so existing call sites that destructure
 * list results into `Memory[]` continue to type-check; the narrower
 * default-path type only differs at the inferred call-site type.
 *
 * Callers that need the body either pass `includeContent: true` to
 * `MemoryService.list` (when the body is small or the count is
 * bounded), or fetch the bodies separately via
 * `lore-memory action='expand'` / `MemoryService.getById` after
 * triaging the title tier.
 */
export type MemoryWithoutContent = Omit<Memory, "content"> & { content: "" }

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
   * unset — the column is system-managed via `touchOnRead` / decay /
   * contradiction signals. Test fixtures and migrations may set it
   * explicitly. `null` clears the column to "never scored".
   */
  confidenceScore?: number | null
  reviewBy?: string
  decidedAt?: string
  /**
   * Service-layer-only field. Not exposed on the MCP tool surface — the
   * column is system-managed by `MemoryService.touchOnRead` and the
   * `--build-confidence-scores` migration, not by agents.
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
   * 1–2 sentence synopsis. `lore-memory` authoring defaults to 150 chars
   * and can opt up through `memory.synopsisMaxChars`; 500 remains the
   * structural storage ceiling.
   */
  synopsis?: string
  /** Shorthand for `scope: { lifetime: "expires", expiresAt }`. */
  expiresAt?: string
  /** Event-bound expiry marker, e.g. `pr-closed:owner/repo#123`. */
  expiresOn?: string
  session?: string
  /**
   * Internal autosave-learning duplicate mode. Omitted lets the service use
   * project scope when projectIds are present and session scope otherwise;
   * `off` bypasses the blocking reuse gate for callers that intentionally
   * materialize separate rows.
   */
  autosaveLearningDedupScope?: "session" | "project" | "off"
  /**
   * Salt for session-scoped autosave-learning locks. MCP callers pass the
   * vault page id (or config root fallback) so projectless and catch-all
   * saves in different vaults cannot reuse each other's local lock.
   */
  autosaveLearningScopeId?: string
  /**
   * Internal hook for side effects that should happen only after the
   * autosave-learning duplicate gate commits to a fresh row. The returned
   * properties are merged into the create input immediately before Notion
   * page creation; duplicate reuse skips this callback entirely.
   */
  prepareFreshCreate?: () => Promise<FreshCreatePreparation>
  /** Task-specific. Defaults to `"open"` when `kind === "task"`. */
  taskState?: TaskState
  /** Free-form blocker label. Only meaningful on `kind === "task"`. */
  blockedBy?: string
  /** Normalized subject. Only meaningful on `kind === "task"`. */
  entity?: string
  /**
   * Stable identifier for upsert grouping. Format is kebab-case path
   * like `decision/jwt-auth`. Validation lives at the MCP boundary;
   * the service layer only enforces the rich_text length cap so
   * internal migrations can re-write existing keys without
   * re-validating the format.
   */
  topicKey?: string
  /**
   * Initial revision count. Production callers leave this unset — the
   * column defaults to 1 for fresh creates. Set explicitly by
   * `upsertByTopicKey` when seeding a fresh row in the upsert path.
   */
  revisionCount?: number
  /**
   * Service-layer-only field. Set by cross-vault promotion to make retries
   * reuse the original target row instead of creating duplicates.
   */
  promotionSourceKey?: string
  /**
   * Scope and lifetime declaration. Omitted means "no scope
   * declared" — retrieval treats the resulting null column as
   * broadcast scope. Caller is responsible for keeping `kind` and
   * `key` consistent with the resolver context (e.g. `kind: "session"`
   * pairs with `key` set to the same `session` field the autosave
   * passes in).
   */
  scope?: MemoryScopeInput
  /**
   * Pinned-block declaration. Omitted means "not a pinned context
   * block" — the common case. Pass an object with `priority` /
   * `mutability` to create a pinned row in one step; the more common
   * path is to create the memory normally and then call
   * `lore-pinned action='pin'` to convert.
   */
  pinned?: MemoryPinnedInput
}

/**
 * Write-side shape for the pinned-block bundle. Mirrors `MemoryPinned`
 * but with every field optional and clear-aware semantics:
 *
 * - `pinned` — `true` flips the row into a pinned block; `false`
 * un-pins; omitted leaves untouched.
 * - `priority` — number write; `null` clears the column (sorts as
 * `0`).
 * - `mutability` — `MemoryMutability` to write; `null` clears the
 * column (defaults to mutable).
 *
 * `audience` is NOT carried here — it lives on `MemoryScopeInput.audience`
 * so the audience-targeting contract has one source of truth.
 */
export interface MemoryPinnedInput {
  pinned?: boolean
  priority?: number | null
  mutability?: MemoryMutability | null
}

export interface FreshCreatePreparation {
  input: Partial<Pick<CreateMemoryInput, "topicId">>
  topicLabel?: string
  warnings?: string[]
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
  /** Shorthand update for `scope.expiresAt`; `null` clears the date. */
  expiresAt?: string | null
  /** Event-bound expiry marker. Empty string or `null` clears the column. */
  expiresOn?: string | null
  /**
   * Optional Confidence Score update. Production callers leave this unset —
   * the column is system-managed via `touchOnRead` / decay / contradiction
   * signals. Test fixtures and migrations may set it explicitly. `null`
   * clears the column to "never scored".
   */
  confidenceScore?: number | null
  reviewBy?: string | null
  decidedAt?: string | null
  /**
   * Service-layer-only field. Pass `null` to clear; `undefined` (the
   * default) leaves the column untouched. Not exposed on the MCP tool
   * surface — `Last Referenced At` is system-managed by
   * `MemoryService.touchOnRead` and the `--build-confidence-scores`
   * migration.
   */
  lastReferencedAt?: string | null
  supersedesIds?: string[]
  affectsIds?: string[]
  alternatives?: string
  consequences?: string
  taskState?: TaskState
  blockedBy?: string
  entity?: string
  /**
   * Scope/lifetime update. Same `MemoryScopeInput` write shape as
   * `CreateMemoryInput`; absent fields leave the columns untouched,
   * explicit `null` clears the select / date columns, and empty
   * strings clear the rich_text columns.
   */
  scope?: MemoryScopeInput
  /**
   * Pinned-block update. Mirrors
   * `MemoryPinnedInput` write semantics. When the target row has
   * `Mutability = read-only`, every update path rejects with
   * `MemoryReadOnlyError` unless `allowReadOnlyUpdate` is set; the
   * `lore-pinned action='update'` MCP surface exposes the
   * override behind an explicit `force: true` flag so the
   * read-only stop-sign isn't silently bypassed by generic update
   * calls.
   */
  pinned?: MemoryPinnedInput
  /**
   * Escape hatch for editing a `Mutability = read-only` pinned
   * block. When `false` / omitted (the default), update calls
   * against read-only rows reject with `MemoryReadOnlyError`. Set
   * to `true` to bypass the gate — the MCP `lore-pinned
   * action='update'` action threads it through behind an explicit
   * `force: true` so the override lands a visible audit line.
   * Not an access-control gate (Lore uses one operator bearer
   * token); the audit line IS the contract.
   */
  allowReadOnlyUpdate?: boolean
  /**
   * Internal flag. When `true`, the
   * service-layer `PINNED_BLOCKS_HARD_CAP` check inside
   * `MemoryService.update` is skipped. The MCP `handlePin` handler
   * sets this after verifying the cap itself so the update path
   * doesn't pay a second `countPinnedBlocks` round-trip per pin.
   * Other callers (CLI, hooks, migrations) leave it unset; the
   * service-layer cap is the canonical defense-in-depth gate for
   * any path that flips `Pinned = true` through `update`.
   */
  bypassPinCapCheck?: boolean
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
 * Single source of truth — both the decision-graph BFS leaf filter and
 * the decisions near-duplicate probe consult this list, so a status
 * added or removed here flows to both surfaces in lockstep.
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
   * title) and `rationale` (the body). Capped at 500 chars by the MCP
   * boundary and service layer so CLI/hooks/internal callers fail before
   * Notion writes.
   */
  synopsis?: string
  /**
   * Engineer-identity attribution stamped on the Memory `Author`
   * column (DEFERRED-ATTRIBUTION). The MCP tool layer lazily resolves
   * a default author only when the caller omits this; service-layer
   * callers (migrations, internal tooling) pass through verbatim.
   */
  author?: string
  agent?: string
  session?: string
  /**
   * Scope and lifetime declaration. Decisions default to
   * broadcast-scoped persistent governance; the `until-decision-superseded`
   * lifetime label is the conventional marker for "this decision should
   * drop out of default reads when the row's `Status` becomes
   * `superseded`," matching the existing `ACTIVE_DECISION_STATUSES`
   * filter behavior.
   */
  scope?: MemoryScopeInput
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
  /**
   * When `true`, skip the default scope filter that excludes
   * narrow-scope decisions whose `Scope Key` does not match the
   * resolved scope context, and skip the expired-row exclusion.
   * Defaults to `false`. Operator audit paths opt in.
   */
  includeOutOfScope?: boolean
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
   * Capped at 500 chars by the MCP boundary and service layer so
   * CLI/hooks/internal callers fail before Notion writes.
   */
  synopsis?: string
  /**
   * Engineer-identity attribution stamped on the Memory `Author`
   * column (DEFERRED-ATTRIBUTION). Same posture as `CreateDecisionInput`
   * — MCP tools lazily resolve a default only when the caller omits it.
   */
  author?: string
  agent?: string
  session?: string
  /**
   * Scope and lifetime declaration. The conventional lifetime for
   * tracked work is `until-task-closed`; pairing that with
   * `scopeKind: "session"` declares a per-session task that stops
   * being broadcast once the session ends.
   */
  scope?: MemoryScopeInput
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
  /** Scope/lifetime update. Same `MemoryScopeInput` shape as create. */
  scope?: MemoryScopeInput
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
   * owns the expansion in `expandEntityQueryVariants`.
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
  /**
   * When `true`, skip the default scope filter that excludes
   * narrow-scope tasks whose `Scope Key` does not match the
   * resolved scope context, and skip the expired-row exclusion.
   * Defaults to `false`. Operator audit paths opt in.
   */
  includeOutOfScope?: boolean
}

// ---------------------------------------------------------------------------
// Entity (Canonical entity registry)
// ---------------------------------------------------------------------------

/**
 * Discriminator for Entity rows. Open enum on purpose — agents will hit
 * cases the enum doesn't yet cover (a new domain that wants its own
 * label) and the right move is to add the value, not force it into a
 * neighbour. Sized to the spec's call-out so the migration path lands on
 * a stable starting set.
 */
export type EntityKind = string

export const DEFAULT_ENTITY_KINDS = [
  "class",
  "function",
  "file",
  "workflow",
  "pr",
  "task-id",
  "person",
  "system",
] as const

export const ENTITY_KINDS: EntityKind[] = [...DEFAULT_ENTITY_KINDS]

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

export type FactPredicate = string

export const GENERIC_FACT_PREDICATES = ["is_a", "has_a", "related_to"] as const

export const DEFAULT_WRITABLE_FACT_PREDICATES = [
  "uses",
  "depends_on",
  "created_by",
  "owned_by",
  "replaces",
  "extends",
  "conflicts_with",
] as const

export const RESERVED_FACT_PREDICATES = [
  "mentions",
  "decided_by",
  "supersedes_decision",
  "informs",
  "needs_action",
  "waiting_on",
  "blocked_by",
] as const

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
   * Optional on the public type (the `Fact` interface is exported) so
   * adding the field is not a TypeScript source-compat break for
   * external consumers building `Fact`-shaped object literals or
   * fixtures. Internal `pageToFact` always populates the
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
  /**
   * Scope and lifetime declaration. Optional on the public type (same
   * backward-compat reason as `subjectEntityId` / `createdAt`) so
   * deserializing older `Fact` JSON does not fail validation.
   * Internal `pageToFact` always populates the field; reads should
   * normalize via `?? null` so a partially-constructed external Fact
   * doesn't blow up the consumer.
   */
  scope?: MemoryScope | null
  /**
   * Transaction-time observation timestamp in `YYYY-MM-DD` form.
   * `null` on rows whose vault has not yet been backfilled by
   * `lore migrate --backfill-fact-observed-at`. Distinct from `validFrom`
   * (domain-truth start) — `observedAt` answers "when did Lore learn this
   * fact?" while `validFrom` answers "when did the fact start being true
   * in the world?". Optional on the public type for the same
   * backward-compat reason as `subjectEntityId`.
   */
  observedAt?: string | null
  /**
   * Transaction-time invalidation timestamp in `YYYY-MM-DD` form.
   * `null` for live facts and for invalidated facts on vaults without
   * the column. Distinct from `validUntil` (domain-truth end) —
   * `invalidatedAt` answers "when did Lore learn this fact stopped
   * being true?" while `validUntil` answers "when did the fact stop
   * being true in the world?". `FactService.invalidate` writes this
   * alongside `validUntil` in a single atomic update.
   */
  invalidatedAt?: string | null
  /**
   * Memory id that prompted the invalidation. Distinct from
   * `sourceMemoryId` (the supporting memory at creation time). `null` when
   * the row was invalidated without an explicit provenance link.
   */
  invalidatedBySourceMemoryId?: string | null
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
  /**
   * Scope and lifetime declaration. Same `MemoryScopeInput`
   * shape as `CreateMemoryInput` — facts about a session-scoped fact
   * (e.g. `agent uses temporary-token-123`) declare `kind: "session"`
   * + `key: <session>` so they don't leak into team-wide retrieval.
   */
  scope?: MemoryScopeInput
}
