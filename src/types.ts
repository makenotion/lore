/**
 * Core domain types for Lore.
 *
 * Vault → Project → Topic → Memory
 * → Fact (knowledge graph)
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
 * Soft cap on the Synopsis property at the MCP and service boundaries.
 * The Notion rich_text per-block ceiling is 2000; 500 is the value tools
 * and services enforce via Zod and the value tests pin. Bump only with a coordinated
 * design-doc update — agents that have learned to write 500-char
 * synopses would silently see truncation without one.
 *
 * Lives here because the cap is structural to the property, not specific
 * to any one consumer. The write-side Zod, the renderer, and the backfill
 * synthesizer all import it.
 */
export const SYNOPSIS_MAX = 500

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
 * Where a memory originated. Note the asymmetry: `agent_diary` is no
 * longer writeable from the live tool surface. Its only writer was the
 * legacy journal dispatcher, which the 0.6.0 deprecation purge removed;
 * production vaults still carry historical `agent_diary` rows, so the
 * value stays in the union to keep recall paths (`lore-query
 * action='recall'` with `source: "agent_diary"`, the digest grouping
 *, and the Notion `Source` select option) working
 * over legacy data. New memories should pick from the four live
 * sources — `conversation`, `file`, `manual`, `digest`.
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
 */
export type MemoryKind =
  | "note"
  | "decision"
  | "incident"
  | "runbook"
  | "postmortem"
  | "policy"
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

/**
 * Confidence Score is constrained to [CONFIDENCE_SCORE_MIN,
 * CONFIDENCE_SCORE_MAX] inclusive. Out-of-range writes are clamped by
 * `clampConfidenceScore`. Notion's number column has no native range
 * constraint, so the clamp is the single enforcement point.
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
 * the row that needs the visible signal. A `null` Confidence Score never
 * renders the indicator either, so vaults without populated scores look
 * unchanged until `lore migrate --build-confidence-scores` populates them.
 *
 * Single source of truth for the per-row trust indicator AND the
 * low-score branch of the Stale Confidence wake-up subsection.
 * Diverging the two would mean a row could surface in Stale Confidence's
 * low-score branch AND fail to flag in Recent Memories (or vice versa),
 * which is incoherent for a score-driven signal. The neglect branch of
 * the Stale Confidence subsection is governed by `STALE_CONFIDENCE_DAYS`
 * instead and is allowed to surface rows whose stored score is above
 * this threshold.
 */
export const CONFIDENCE_DISPLAY_THRESHOLD = 0.5

/**
 * Map a numeric Confidence Score to the human-readable label rendered
 * below the heading on recall / search / wake-up listings. Three
 * empirical buckets:
 *
 * `score < 0.2` → `"very low confidence"`
 * `score < 0.4` → `"low confidence"`
 * `score < CONFIDENCE_DISPLAY_THRESHOLD` (0.5) → `"moderate confidence"`
 * `score >= CONFIDENCE_DISPLAY_THRESHOLD` → `null` (no indicator)
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
 * (the "no score yet / unmigrated row" case) stays at the call site
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
 * Maximum rows surfaced in the Stale Confidence wake-up subsection.
 * Default 5 — tight enough to keep the subsection a triage prompt
 * rather than an exhaustive list. When the section is saturated
 * (returned exactly STALE_CONFIDENCE_LIMIT rows), the heading prefixes
 * the count with `≥` (e.g. `≥5`) to signal "at least this many"; no
 * exact total is computed (one query, no inventory).
 */
export const STALE_CONFIDENCE_LIMIT = 5

/**
 * Milliseconds in a day. Cross-cutting constant — every native-`Date`
 * day-arithmetic site (`taskDaysOverdue`, `decayConfidenceScore`,
 * `MemoryService.queryStaleConfidence`, the wake-up renderer's
 * `Last referenced: Nd ago` builder, `task-reconcile`'s age scoring,
 * `loadWakeUpData`'s digest-freshness window, `dateBucket`) divides
 * by this value. Pinned here rather than a per-module local so a
 * future tweak (or the inevitable contributor who writes
 * `1000 * 60 * 60 * 24` from muscle memory) finds one source of truth.
 */
export const MS_PER_DAY = 86_400_000

// ---------------------------------------------------------------------------
// Scope and lifetime
// ---------------------------------------------------------------------------

/**
 * Scope kind for a memory, fact, or task. Identity slot the row applies to.
 *
 * - `team`, `project`, `global` are *broadcast* scopes — every reader on
 * any session sees them by default.
 * - `user`, `agent`, `role`, `session`, `run`, `environment` are *narrow*
 * scopes — readers see them only when their resolved scope context's
 * matching slot equals the row's `scopeKey`. A session note from
 * one engineer's debugging run does not become team-wide recall by
 * accident.
 *
 * Existing rows have no `scopeKind` (column null). The retrieval default
 * treats null as "broadcast" — equivalent to `team`/`project`/`global` —
 * so vaults without the Scope columns render byte-identically.
 */
export type MemoryScopeKind =
  | "team"
  | "project"
  | "user"
  | "agent"
  | "role"
  | "session"
  | "run"
  | "environment"
  | "global"

export const MEMORY_SCOPE_KINDS: MemoryScopeKind[] = [
  "team",
  "project",
  "user",
  "agent",
  "role",
  "session",
  "run",
  "environment",
  "global",
]

/**
 * Scopes whose reach is broader than the current reader's context.
 * Always returned by default reads, regardless of `scopeKey`. Anything
 * else requires a `scopeKey` match against the reader's `MemoryScopeContext`.
 */
export const BROADCAST_SCOPE_KINDS: MemoryScopeKind[] = ["team", "project", "global"]

/**
 * Narrow scopes — require a matching `scopeKey` against the reader's
 * resolved scope context to surface in default reads.
 */
export const NARROW_SCOPE_KINDS: MemoryScopeKind[] = [
  "user",
  "agent",
  "role",
  "session",
  "run",
  "environment",
]

/**
 * Lifetime model for a memory, fact, or task.
 *
 * - `persistent` — never expires. The legacy default; null lifetime
 * resolves to this on read.
 * - `expires` — explicit `Expires At` end-date. The row drops out of
 * default retrieval when `Expires At < today`.
 * - `session-only` — paired with `scopeKind = session` and a
 * `Session` field; expires when the originating session is no
 * longer current. Same retrieval behavior as `expires` for the
 * common case (we drop the row when its scopeKey doesn't match the
 * reader's session), but the explicit label gives operators a
 * triage signal in `lore status` for "session-only memories that
 * outlived their session and need cleanup."
 * - `until-task-closed` — for `kind = task` memories; the row's
 * active reach ends when its `taskState` reaches `done` or
 * `cancelled`. Tasks already drop out of `lore-task action='list'`
 * default state filters when closed, so this label is a
 * declaration of intent rather than a new retrieval rule.
 * - `until-decision-superseded` — for `kind = decision` memories;
 * active reach ends when `status` reaches `superseded`. Same
 * declarative posture as `until-task-closed` — superseded
 * decisions already drop out of "currently governing" reads via
 * `ACTIVE_DECISION_STATUSES`.
 */
export type MemoryLifetime =
  | "persistent"
  | "expires"
  | "session-only"
  | "until-task-closed"
  | "until-decision-superseded"

export const MEMORY_LIFETIMES: MemoryLifetime[] = [
  "persistent",
  "expires",
  "session-only",
  "until-task-closed",
  "until-decision-superseded",
]

/**
 * Resolved scope context for the current reader. Populated at
 * `initServices()` time from environment variables, the active project,
 * and the auth identity. Threaded into `MemoryService` and `FactService`
 * so default-retrieval paths can build the safe scope inclusion filter
 * without each call site re-deriving identity.
 *
 * Every field is optional. A missing identity slot means "no row whose
 * `scopeKind` equals this slot can be surfaced by default" — so a
 * vault running without `LORE_AGENT_NAME` set never has agent-scoped
 * recall, only ever broadcast scopes plus the slots that are
 * populated.
 *
 * `userId`, `agent`, `role`, `session`, `run`, `environment` are the
 * raw identity strings the row's `scopeKey` is compared against. The
 * caller is responsible for keeping the same canonical form here as
 * was written into Notion (e.g. `canonicalizeAgentName` for
 * `agent`).
 */
export interface MemoryScopeContext {
  userId?: string
  agent?: string
  role?: string
  session?: string
  run?: string
  environment?: string
}

/**
 * Bundle of scope-related fields surfaced on `Memory` and `Fact` rows.
 * Mirrors the five Notion Scope columns: `Scope Kind`, `Scope Key`,
 * `Audience`, `Lifetime`, `Expires At`. Bundled into a single optional
 * `scope` slot rather than five top-level fields so a `null` from a
 * row without Scope columns collapses to "no scope declared" in one
 * place.
 *
 * `null` on the parent type means the row was written without scope —
 * retrieval treats this as broadcast scope with `persistent` lifetime,
 * matching the legacy behavior.
 */
export interface MemoryScope {
  kind: MemoryScopeKind | null
  key: string
  audience: string
  lifetime: MemoryLifetime | null
  expiresAt: string | null
}

/**
 * Translate a read-side `MemoryScope` (or `null`) into the write-side
 * `MemoryScopeInput` shape that `lore-fact action='create'` and
 * `services.facts.createWithDedup` consume.
 *
 * Used by every system-managed fact emitter — auto-`mentions` on
 * `lore-memory action='save'` / `'update'`, `decided_by` on
 * `lore-decision action='create'`, `supersedes_decision` on
 * `lore-decision action='supersede'`, and `decided_by` retargets
 * during decision-graph reachability sync — to propagate the source
 * row's scope onto every emitted fact.
 *
 * Without this propagation, an auto-emitted fact written from a
 * session-scoped memory or decision lands with `Scope Kind = null`
 * (broadcast). The default scope filter intentionally treats null
 * as legacy/broadcast and surfaces the row to every reader, which
 * would let `lore-query action='ask'` and `lore-decision
 * action='context'` leak the scoped row's title and entity edges
 * across sessions even when the memory/decision itself is hidden
 * from recall.
 *
 * Returns `undefined` when the source row has no scope declared (scope
 * is absent or null) so the fact create call sites can pass the result
 * through unchanged via spread / direct assignment without
 * re-implementing the same null-collapse rule each time.
 */
export function memoryScopeToInput(
  scope: MemoryScope | null | undefined
): MemoryScopeInput | undefined {
  if (!scope) return undefined
  // The `key` / `audience` rich_text columns store the empty string
  // on cleared rows; collapse them to undefined so the resulting
  // input shape doesn't write empty cells on the new fact.
  const out: MemoryScopeInput = {}
  if (scope.kind !== null) out.kind = scope.kind
  if (scope.key.length > 0) out.key = scope.key
  if (scope.audience.length > 0) out.audience = scope.audience
  if (scope.lifetime !== null) out.lifetime = scope.lifetime
  if (scope.expiresAt !== null) out.expiresAt = scope.expiresAt
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Decide whether a system-managed fact derived from a PAIR of
 * memories (compare-dispatch `conflicts_with` / `supersedes_decision`)
 * can be safely emitted, and if so what scope it should carry.
 *
 * The rule is "same scope on both sides → emit with that scope; any
 * mismatch → skip emission." Reasoning:
 *
 * - Same scope on both sides: emitting with that scope is safe.
 * Both rows already share visibility, so the derived fact's
 * visibility is identical to either row's visibility.
 * - One narrower than the other (one session-scoped, one team /
 * global / null): emitting with the narrower scope hides the
 * relationship from the broader-scope reader who can see the
 * broader row. Emitting with the broader scope leaks the
 * narrower row's title and the relationship through `lore-query
 * action='ask'` to readers who cannot see the narrower row.
 * Both directions are wrong; the safe answer is to skip the
 * derived-fact emission. The compare verdict still lands in the
 * Compare Notes audit trail on both rows, so the contradiction
 * isn't lost — just the broadcast-able fact-graph projection of
 * it.
 *
 * Returns:
 * - `{ ok: true, scope: MemoryScopeInput | undefined }` when the
 * two rows share a scope. `scope` is the bundle to pass to
 * `createWithDedup`; `undefined` means both rows have no scope
 * declared (legacy passthrough — the fact lands with no scope).
 * - `{ ok: false, reason: string }` when the rows have different
 * scopes. The caller skips fact emission and includes `reason`
 * in operator-facing output / debug logs so the gap is
 * diagnosable.
 *
 * This helper is intentionally narrower than `scopesMatchForMerge`:
 * the merge predicate compares an existing Fact's scope against an
 * incoming `MemoryScopeInput`, while this pair predicate compares two
 * `Memory.scope` values directly. The two implementations stay aligned
 * via shared scope-coverage tests.
 */
export function pairScopeForFactEmission(
  a: MemoryScope | null | undefined,
  b: MemoryScope | null | undefined
): { ok: true; scope: MemoryScopeInput | undefined } | { ok: false; reason: string } {
  const normA = normalizeForCompare(a)
  const normB = normalizeForCompare(b)
  if (
    normA.kind === normB.kind &&
    normA.key === normB.key &&
    normA.audience === normB.audience &&
    normA.lifetime === normB.lifetime &&
    normA.expiresAt === normB.expiresAt
  ) {
    // Both rows share the scope; safe to emit. `memoryScopeToInput`
    // returns undefined when the (now-equal) scope is empty,
    // preserving the legacy null-scope passthrough.
    return { ok: true, scope: memoryScopeToInput(a ?? b ?? null) }
  }
  return {
    ok: false,
    reason:
      `pair-scope mismatch: source=${describeScope(a)} ` +
      `affected=${describeScope(b)} — system fact emission skipped to ` +
      "avoid leaking the narrower-scope row's title across the broader " +
      "reader context. The compare verdict still landed in Compare Notes " +
      "on both rows (audit trail intact).",
  }
}

interface NormalizedScopeForCompare {
  kind: MemoryScopeKind | null
  key: string | null
  audience: string | null
  lifetime: MemoryLifetime | null
  expiresAt: string | null
}

function normalizeForCompare(
  scope: MemoryScope | null | undefined
): NormalizedScopeForCompare {
  if (!scope) {
    return { kind: null, key: null, audience: null, lifetime: null, expiresAt: null }
  }
  return {
    kind: scope.kind,
    key: scope.key.length > 0 ? scope.key : null,
    audience: scope.audience.length > 0 ? scope.audience : null,
    lifetime: scope.lifetime,
    expiresAt: scope.expiresAt,
  }
}

function describeScope(scope: MemoryScope | null | undefined): string {
  if (!scope || (scope.kind === null && scope.key.length === 0)) {
    return "broadcast"
  }
  if (scope.kind === null) return "scoped(unknown-kind)"
  if (scope.key.length === 0) return scope.kind
  return `${scope.kind}:${scope.key}`
}

/**
 * Days-from-today threshold for the `lore status` "expiring scoped
 * rows" surface. A row with `Expires At` between today and today + N
 * days surfaces as "expiring soon"; rows with `Expires At < today`
 * surface as "expired."
 */
export const EXPIRING_SOON_DAYS = 7

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

/**
 * Default cap on pinned-block rows surfaced in the wake-up `Pinned
 * Context` section. Tight enough to keep the section a governance
 * surface (team policies, project invariants, current initiative
 * state) rather than an inventory; operators with deeper sets can
 * tune via `pinnedBlockLimit` on the MCP wake-up call.
 */
export const DEFAULT_PINNED_BLOCK_LIMIT = 10

/**
 * Maximum `Pinned Priority` value accepted at the MCP/service
 * boundary. Notion's number column has no native range; clamping at
 * the boundary keeps sort order predictable and protects against a
 * malformed caller passing `Infinity`.
 */
export const PINNED_PRIORITY_MAX = 1_000_000
export const PINNED_PRIORITY_MIN = -1_000_000

/**
 * Active-pinned-block count above which the wake-up Pinned Context
 * section appends an operator-facing abuse warning.
 *
 * A malicious agent that runs `lore-pinned action='pin'` in a loop
 * can exhaust the wake-up Pinned Context render budget for every
 * other agent on the same vault — the visible cap renders the
 * highest-priority N rows, so high-priority spam pushes legitimate
 * pins out of the window. The threshold is conservative (10× the
 * default visible cap): a single project with a handful of pinned
 * blocks plus a vault-wide governance set sits comfortably below,
 * and crossing it surfaces an inline note so the operator sees the
 * abuse signal without having to instrument the vault separately.
 *
 * Not a hard pin-creation cap — pinning still succeeds past the
 * threshold so legitimate growth (a new governance program adding
 * many blocks at once) isn't blocked. The signal lives at the
 * render boundary so operators see it on the same surface that
 * exposes the blocks themselves.
 */
export const PINNED_BLOCKS_ABUSE_THRESHOLD = 100

/**
 * Hard cap on the total active-pinned-block count enforced at the
 * `lore-pinned action='pin'` write boundary.
 *
 * The render-time abuse warning above is operator-facing but does
 * not prevent the underlying defense-in-depth gap: a malicious or
 * runaway caller pinning many narrow-audience rows can exhaust
 * `collectLivePages`'s refill ceiling
 * (`LIVE_PAGE_REFILL_MAX_PAGES * LIVE_PAGE_QUERY_SIZE` = 500 rows)
 * before the walker reaches a matching pin for a different
 * audience. The matching reader then sees zero pinned context,
 * AND — when the renderer gates the warning on
 * `pinnedBlocks.length > 0` — no abuse signal either.
 *
 * The cap closes that gap structurally. Sitting at 200 (2× the
 * render warning threshold) gives operators headroom past the
 * warning to grow a legitimate governance corpus, while keeping
 * the total well below the refill ceiling so the audience filter
 * has room to backfill matching pins from rows ranked behind
 * non-matching ones.
 *
 * Pin attempts past the cap reject with a typed error pointing
 * operators at `lore pinned list --all-audiences` and
 * `lore-pinned action='unpin'` so the recovery path is obvious.
 * Unpinning is unaffected — operators trying to clear backlog
 * never hit the cap.
 *
 * Larger than `PINNED_BLOCKS_ABUSE_THRESHOLD` so the render
 * warning fires first as an early signal; smaller than
 * `LIVE_PAGE_REFILL_MAX_PAGES * LIVE_PAGE_QUERY_SIZE` so the
 * audience-filter backfill can always traverse the entire pinned
 * set within one refill window.
 */
export const PINNED_BLOCKS_HARD_CAP = 200

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
   * one-line gist without a body fetch. Soft-capped at 500 chars at the
   * MCP and service boundaries; empty string when not set.
   */
  synopsis: string
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
   * 1–2 sentence synopsis. Capped at 500 chars by the MCP boundary and
   * service layer so CLI/hooks/internal callers fail before Notion writes.
   */
  synopsis?: string
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

/**
 * Write-side shape for the scope bundle. Mirrors `MemoryScope` but with
 * every field optional and clear-aware semantics where they make sense
 * for a Notion column update.
 *
 * - `kind` — pass a `MemoryScopeKind` to write; `null` clears the
 * column. Omitted leaves untouched.
 * - `key` — string write; empty string clears.
 * - `audience` — string write; empty string clears.
 * - `lifetime` — `MemoryLifetime` to write; `null` clears.
 * - `expiresAt` — `YYYY-MM-DD` to write; `null` clears.
 *
 * The Zod boundary in MCP enforces the format and the Notion `Expires
 * At` column (a Notion `date` type) accepts the date directly.
 */
export interface MemoryScopeInput {
  kind?: MemoryScopeKind | null
  key?: string
  audience?: string
  lifetime?: MemoryLifetime | null
  expiresAt?: string | null
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

/**
 * Search execution mode. Trades off scope precision against ranking quality:
 *
 * - `"contains"` — `dataSources.query` against the Memories DB with
 * `Title contains` / `Keywords contains` / `Synopsis contains` filters.
 * Strictly DS-scoped (no workspace leakage), supports server-side property
 * filters (`kind` / `status` / `tags`), but loses Notion's vector relevance
 * ranking over page bodies. Best for substring/exact-phrase queries on
 * titles, keyword tokens (PR numbers, ticket IDs, function names), and the
 * short curated synopsis written at save time.
 * - `"semantic"` — workspace-wide `client.search` ranked by Notion's vector
 * index over titles AND bodies. Preserves relevance ranking, but cannot
 * apply server-side property filters and may rank non-Memory pages from
 * the same workspace ahead of real hits when the query is niche. Best for
 * phrase-shaped or conceptual queries where body matches matter.
 * - `"hybrid"` (default) — fires `contains` and `semantic` in parallel via
 * `Promise.allSettled`. If contains saturates
 * (`>= HYBRID_FALLBACK_THRESHOLD` hits), the contains rows are used
 * alone and the parallel semantic result is discarded; otherwise the
 * two ranked lists are merged via Reciprocal Rank Fusion (RRF) with
 * a deterministic tie-break (`score → best-rank → contains-presence
 * → page id`). Speculative parallelism keeps the worst-case wall-clock
 * at one round-trip (≈ `client.search` latency) regardless of which
 * leg saturates — the cheap-path waste is one discarded Notion call
 * governed by the shared rate limiter.
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
  /**
   * When `true`, do NOT exclude `Status = proposed` rows from the
   * search result set. Defaults to `false` — proposed-memory inbox
   * rows are filtered out of default recall paths so a noisy
   * autosave-as-proposed flow cannot pollute search.
   * Explicit `status: "proposed"` short-circuits this
   * default and surfaces the inbox directly.
   *
   * Mirrors `MemoryService.list`'s `includeProposed` flag with the
   * same semantics. Server-side filter in `"contains"` (and the
   * contains leg of `"hybrid"`); client-side post-filter in
   * `"semantic"` because `client.search` lacks property-filter
   * support.
   */
  includeProposed?: boolean
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
   * Whitespace-only intent (`" "`) normalizes to unset across every
   * consumer.
   *
   * Under `mode: "hybrid"` (default), setting intent disables the
   * saturation cutoff so the RRF merge always runs — intent would
   * otherwise be discarded when contains has `>= HYBRID_FALLBACK_THRESHOLD`
   * hits. Under RRF, the contains lane is up-weighted so contains-precision
   * still dominates ordering. Has no effect under `mode: "contains"`.
   */
  intent?: string
  /**
   * When `true`, skip the default scope filter that excludes narrow-scope
   * (`session` / `agent` / `user` / `role` / `run` / `environment`) rows
   * whose `scopeKey` does not match the resolved `MemoryScopeContext`,
   * AND skip the expired-row exclusion. Defaults to `false`.
   *
   * Operator-facing audit paths (`lore status`'s expiring-rows surface,
   * triage tooling) opt in. Agent-facing recall paths leave it unset so
   * a session-scoped note from a different session never leaks into
   * default retrieval — the load-bearing acceptance criterion of scope.
   *
   * Server-side filter clause in `"contains"` (and the contains leg of
   * `"hybrid"`); client-side post-filter in `"semantic"` because
   * `client.search` lacks property-filter support.
   */
  includeOutOfScope?: boolean
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
 * `null`; `rrfScore` is `null`.
 * - `"semantic-only"` — `mode: "semantic"` (including the
 * `LORE_FORCE_SEMANTIC_SEARCH=1` kill-switch case). `containsRank`
 * is always `null`; `rrfScore` is `null`.
 * - `"contains-saturated"` — `mode: "hybrid"` and the saturation cutoff
 * fired. `containsRank` reflects the row's position in the contains
 * list; `semanticRank` is **always `null`** because the semantic
 * branch's output was discarded — surfacing its rank would imply
 * influence on ordering that did not happen. `rrfScore` is `null`.
 * - `"rrf"` — `mode: "hybrid"` and the under-saturation merge ran.
 * Both ranks reflect actual branch presence (one may be `null` when
 * only one branch surfaced the row); `rrfScore` is the fused score
 * used for ordering.
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
   * score. `1.0` for unscored (unmigrated `Confidence Score = null`)
   * or fully-trusted rows; `CONFIDENCE_FACTOR_MIN` (default `0.5`) for
   * fully-decayed rows. Multiplied into the score in
   * `MemoryService.searchByHybridPages` and the single-branch
   * `searchByContainsPages` / `searchBySemanticPages` paths.
   *
   * Older traces may have this field absent; deserialize-aware
   * consumers tolerate the missing field.
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

// ---------------------------------------------------------------------------
// Config (.lore.yaml)
// ---------------------------------------------------------------------------

export interface ProjectConfig {
  name: string
  path: string
  tags?: string[]
}

export interface UpstreamVaultConfig {
  name: string
  pageId: string
  /**
   * Lower numbers render first. Defaults to 100 when omitted.
   */
  priority?: number
}

export interface PromotionTargetConfig {
  name: string
  pageId: string
  /**
   * Whether promotion into this vault should land as a reviewed/proposed flow.
   * Defaults to false until the promotion command implements policy handling.
   */
  requireReview?: boolean
}

export interface ProfilesAllowedGitInstallSource {
  kind: "git"
  /** Git URL of the source repository. */
  url: string
  /** 40-character lowercase hex commit SHA. */
  commit: string
  /** `sha256:<64-hex>` manifest digest computed at allow-list authoring time. */
  manifestDigest: string
}

export interface ProfilesAllowedPathInstallSource {
  kind: "path"
  /**
   * Absolute or `<configRoot>`-relative path to a profile bundle root
   * (the directory that contains `profile.yaml`).
   */
  path: string
  /** `sha256:<64-hex>` manifest digest of the bundle at allow-list authoring time. */
  manifestDigest: string
}

export type ProfilesAllowedInstallSource =
  | ProfilesAllowedGitInstallSource
  | ProfilesAllowedPathInstallSource

export interface ProfilesConfig {
  /**
   * Closed allow-list of install sources that `lore profile install --yes`
   * may write under `<configRoot>/.lore/profiles/installed/`. The CLI
   * stages the source, validates it, computes its `manifestDigest`, and
   * requires an exact entry match before writing anything to disk.
   * Interactive installs without `--yes` print the digest so an operator
   * can add an entry for later CI/scripted runs.
   */
  allowedInstallSources?: ProfilesAllowedInstallSource[]
}

export interface LoreConfig {
  vault: {
    pageId: string
  }
  /**
   * Exact profile selector (`<name>@<semver>`). Omitted legacy configs
   * resolve in memory to the bundled default profile; read-only starts
   * never write this field back to disk.
   */
  profile?: string
  /**
   * Optional profile distribution settings (Phase 3). Currently scoped to
   * `allowedInstallSources`, the closed allow-list that authorizes
   * `lore profile install --yes` to write under
   * `<configRoot>/.lore/profiles/installed/`.
   */
  profiles?: ProfilesConfig
  /**
   * Read-only vaults whose memories can be inherited by topology-aware read
   * paths. The primary vault remains the only normal write target.
   */
  upstreamVaults?: UpstreamVaultConfig[]
  /**
   * Explicit cross-vault destinations for deliberate memory promotion.
   */
  promotionTargets?: PromotionTargetConfig[]
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
     * Workspace id to pick when ntn's auth.json carries multiple
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
       * Max outbound Notion API calls in flight at once on the global
       * gate. Endpoints with a `endpointOverrides` entry run their own
       * concurrency slot pool independent of this value. Defaults to
       * `DEFAULT_NOTION_CONCURRENCY` (aligned with Notion's public-API
       * ~3 rps guidance).
       */
      concurrency?: number
      /**
       * Sustained outbound request rate, in calls/second, on the global
       * gate. Token-bucket refill rate enforced by `createLimitedClient`.
       * Defaults to `DEFAULT_NOTION_REQUESTS_PER_SECOND`. Distinct from
       * `concurrency`: the latter caps fan-out memory; this caps
       * throughput. Per-process budget; multiple concurrent Lore
       * processes on one Notion token (MCP server + CLI + hooks)
       * compose additively at the server-side bucket and may need
       * tighter tuning to stay under the per-token ceiling.
       */
      requestsPerSecond?: number
      /**
       * Token-bucket capacity for the global gate — how many calls may
       * fire instantly after a quiet period. Defaults to
       * `DEFAULT_NOTION_BURST_SIZE`. Endpoints with their own
       * `endpointOverrides` entry have their own burst.
       */
      burstSize?: number
      /**
       * Per-endpoint pacing overrides keyed by dot-joined SDK method
       * path (e.g., `"pages.retrieveMarkdown"`, `"dataSources.query"`,
       * or a top-level method name like `"search"`). Each override may
       * loosen one or more pacing dimensions for a single endpoint
       * without raising the global cap.
       *
       * Built-in defaults loosen endpoints with operator-runnable probe
       * evidence under `tools/`. When this field is omitted but any
       * global rate-limit knob is set, the effective global values cap
       * the inherited built-ins so existing process-wide throttles stay
       * conservative. Setting this field REPLACES the built-in table —
       * pass `{}` to opt every endpoint back through the global gate, or
       * include any path the caller wants to customize. Endpoints absent
       * from this map fall through to the global concurrency /
       * requestsPerSecond / burstSize values.
       */
      endpointOverrides?: Record<
        string,
        {
          concurrency?: number
          requestsPerSecond?: number
          burstSize?: number
        }
      >
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
     * Atomic-learning extraction inside the Stop-spawn autosave sub-agent.
     * When true (default) the sub-agent is asked to identify
     * single-fact discoveries and save each as its own `note` memory, in
     * addition to the session synopsis it already writes. When false, the
     * autosave reproduces the synopsis-only shape. Honors
     * `LORE_DISABLE_LEARNING_EXTRACTION=1` env override — either knob set
     * to disabled wins (AND-of-permissive).
     */
    learningExtraction?: boolean
    /**
     * Whether the Stop-spawn autosave sub-agent should write atomic
     * learnings as `status: "proposed"`. Default is `false` — the
     * historical "auto-extracted learnings land directly in the shared
     * vault" posture is preserved. When `true`, the prompt instructs
     * the sub-agent to set `status: "proposed"` on every
     * atomic-learning save, routing the row into the review inbox
     * surfaced by `lore status`'s `Proposed memories` line and the
     * wake-up `Proposed Memories` section. Has no effect when
     * `learningExtraction` is `false` — there are no learning saves
     * to gate.
     *
     * The trust boundary this knob enables: a fleet of agents
     * managed by many engineers can opt into review-before-share so
     * a noisy session cannot pollute recall for everyone before a
     * human or authorized agent approves it. The inbox-count surface,
     * default-recall exclusion, and approve / reject actions all read
     * the proposed `Status`; this flag is the corresponding
     * write-side opt-in.
     */
    proposeAutosaveLearnings?: boolean
    /** Real user messages between structured AI-driven saves. Default: 5. */
    saveInterval?: number
    /**
     * Background-agent worker configuration. Lore's autosave
     * and auto-digest paths shell out to a detached agent CLI to do the
     * structured save / digest synthesis. Defaults to `claude -p` with the
     * shape Claude Code installs assume. Codex-only operators (or anyone
     * who wants to try a different agent CLI) override `command` to point
     * at an alternate binary and `args` to pass that binary's headless
     * flags. Each spawn substitutes `{{allowedTools}}` in `args` for the
     * tool allowlist string — operators whose CLI does not accept an
     * allowlist flag should omit the placeholder. Honors
     * `LORE_BACKGROUND_COMMAND` env override on `command` for ad-hoc
     * experimentation without editing .lore.yaml.
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
