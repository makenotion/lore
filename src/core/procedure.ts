/**
 * Procedure memories — promotion from resolved episodes to reusable
 * fleet-wide operating knowledge.
 *
 * Lore already stores closed tasks, resolved incidents, postmortems,
 * runbooks, and decisions. Adapting LangMem's episodic / semantic /
 * procedural taxonomy: episodes stay inspectable history, while
 * `kind: "procedure"` memories carry reviewed, fleet-wide operating
 * knowledge — "when this situation appears, this sequence worked."
 *
 * This module hosts the read-only candidate scan
 * (`findProcedureCandidates`) and the structured-body composer used
 * by the propose / promote path (`composeProcedureBody`). The actual
 * Notion writes go through `MemoryService.create` with
 * `kind: "procedure", status: "proposed"`, then humans/authorized
 * agents flip status to `accepted` via the existing inbox
 * (`lore-memory action='approve'`). The two-step gate is the
 * load-bearing safety property: raw session summaries never become
 * fleet-wide procedures silently.
 *
 * The scan is read-only by design and operator-pulled — never
 * auto-fired by a hook or background job. Candidates are surfaced
 * with structured scoring, and the operator (or a reviewing agent)
 * decides whether to promote.
 */

import type {
  CreateMemoryInput,
  ListTasksOpts,
  Memory,
  TaskState,
  TaskSummary,
} from "../types.js"
import type { MemoryService } from "./memory.js"
import { extractEntityCandidates } from "./near-duplicate.js"
import { COMBINING_MARK_PATTERN } from "./topic-key.js"
import { LoreError } from "../errors.js"

/**
 * Memory kinds that can be mined into procedure candidates. Closed
 * tasks are included via `TaskService.list({ states: ["done"] })`,
 * NOT through this kind list — task memories live under
 * `kind: "task"` and aren't mineable as runbook-shaped sources.
 *
 * `runbook` is included as a source because an existing runbook plus
 * a fresh incident on the same entity is exactly the "we have a
 * procedure, but the incident shows it needs revision" signal worth
 * surfacing to the operator. The promoted procedure can then
 * supersede the old runbook via the existing `supersedesIds`
 * relation on Memory.
 */
export const PROCEDURE_SOURCE_KINDS = ["incident", "postmortem", "runbook"] as const

/**
 * Task states that count as "resolved" for the procedure scan. Open
 * / blocked / in-progress tasks are still mid-flight; their
 * resolution shape (the sequence the agent eventually executed)
 * hasn't crystallized yet. `cancelled` is included because a
 * deliberately abandoned task is itself a "this path didn't work"
 * signal that procedures can encode as a known failure mode.
 */
export const PROCEDURE_RESOLVED_TASK_STATES: readonly TaskState[] = [
  "done",
  "cancelled",
] as const

/**
 * Minimum number of supporting memories required for a cluster to
 * surface as a candidate. Two is the smallest count that signals
 * a repeated pattern — a one-shot incident is not a procedure.
 * Operators wanting to inspect one-off resolutions use
 * `lore-query action='ask'` directly.
 */
export const PROCEDURE_MIN_SOURCES = 2

/**
 * Cap on the number of source memories scanned per kind. Incidents,
 * postmortems, and runbooks combined rarely exceed a few hundred rows
 * in a healthy vault, so the 200-per-kind cap covers normal traffic
 * while keeping a pathological vault bounded. Resolved tasks can be
 * in the thousands and are bounded separately.
 */
export const PROCEDURE_MAX_SOURCES_PER_KIND = 200
export const PROCEDURE_MAX_RESOLVED_TASKS = 500

/**
 * Default and maximum number of candidate clusters surfaced per scan
 * call. The default keeps a single scan's response budget tractable;
 * the maximum exists so an operator can widen the window without
 * unbounded growth.
 */
export const DEFAULT_PROCEDURE_CANDIDATE_LIMIT = 25
export const MAX_PROCEDURE_CANDIDATE_LIMIT = 100

/**
 * Recency-decay half-life in days. A source memory from today scores
 * 1.0 on recency; a source from 90 days ago scores 0.5. Pinned at the
 * `STALE_TASK_DAYS` boundary so the recency gate aligns with the
 * task-staleness signal the rest of the system uses.
 */
export const PROCEDURE_RECENCY_HALF_LIFE_DAYS = 90

/**
 * Bonus applied to clusters whose sources span multiple kinds
 * (e.g. one incident + one postmortem on the same entity). Cross-kind
 * agreement is stronger evidence than two postmortems alone — same
 * intuition as RRF's "cross-branch agreement is the load-bearing
 * signal" rule in hybrid search.
 */
export const PROCEDURE_KIND_DIVERSITY_BONUS = 0.5

/**
 * Minimum normalized entity length to be considered as a cluster key.
 * Below this the entity tokenizer's output is too noisy to anchor
 * a cluster — single letters and short fragments would otherwise
 * collapse unrelated procedures together.
 */
const MIN_CLUSTER_KEY_LENGTH = 3

/**
 * One supporting source backing a procedure candidate.
 */
export interface ProcedureSource {
  /** Notion page id of the supporting memory. */
  memoryId: string
  /** Memory kind: `incident` / `postmortem` / `runbook` / `task`. */
  kind: Memory["kind"]
  /** Title of the supporting memory. */
  title: string
  /** ISO date string (YYYY-MM-DD) of memory creation. */
  createdAt: string
  /** Task state, when the source is a task; null otherwise. */
  taskState: TaskState | null
}

/**
 * Aggregated cluster of supporting memories that share an entity.
 * The operator decides whether to promote a cluster into a
 * `kind: "procedure"` memory.
 */
export interface ProcedureCandidate {
  /**
   * Stable cluster key derived from the shared entity. Used as the
   * default topic-key seed (`procedure/<key>`) by the propose path.
   * Lowercase, kebab-case, length-bounded.
   */
  clusterKey: string
  /** Entity string surfaced verbatim from the source memories. */
  entity: string
  /** Supporting memories in newest-first order, bounded at 10. */
  sources: ProcedureSource[]
  /** Number of distinct kinds represented in `sources`. */
  kindDiversity: number
  /**
   * Composite score in roughly `[0, 4]`. Higher = stronger
   * candidate. The score combines count + kind diversity +
   * recency in `scoreCandidate`.
   */
  score: number
  /**
   * Suggested topic-key for the promoted procedure
   * (`procedure/<clusterKey>`). Stable across runs so a re-scan
   * after a partial promotion converges on the same upsert chain.
   */
  suggestedTopicKey: string
}

export interface FindProcedureCandidatesOptions {
  /** Project scope. Required — vault-wide scans aren't meaningful for procedures. */
  projectId: string
  /** Today's date in YYYY-MM-DD form. Defaults to runtime today. */
  today?: string
  /** Maximum candidates to return. Capped at `MAX_PROCEDURE_CANDIDATE_LIMIT`. */
  limit?: number
  /** Minimum score to surface. Default 0 (all clusters above the count gate). */
  minScore?: number
}

/**
 * Memory kinds accepted as supporting sources for a propose call.
 * Mirrors `PROCEDURE_SOURCE_KINDS` (the scan-side accept list) plus
 * `task` — closed tasks are also valid resolved-episode sources and
 * the scan emits them as such. `procedure` is intentionally excluded:
 * a procedure cannot cite itself as its own supporting evidence;
 * supersession uses `supersedesIds` instead.
 */
export const PROCEDURE_VALID_SOURCE_KINDS: readonly Memory["kind"][] = [
  "incident",
  "postmortem",
  "runbook",
  "task",
  // `note` is accepted too — operators can promote a high-confidence
  // note (e.g. a discovery from a debugging session) into a procedure
  // when the pattern crystallizes. Restricting to the kinds that
  // legitimately carry resolved-episode shape (or operator-curated
  // knowledge in the note case) keeps arbitrary unrelated rows out
  // of `## Sources`.
  "note",
] as const

const PROCEDURE_VALID_SOURCE_KIND_SET = new Set<Memory["kind"]>(
  PROCEDURE_VALID_SOURCE_KINDS
)

/**
 * Source memories with `Status = rejected` carry the explicit
 * "this evidence was reviewed and discarded" signal and cannot back
 * a procedure. `superseded` and `deprecated` are also excluded — they
 * are by definition not the current resolved-episode shape we want
 * to cite as the procedure's evidence base. `proposed` is allowed
 * because the autosave learning gate can produce useful single
 * findings before the human reviewer flips them; agents promoting a
 * procedure with a proposed source see that evidence chain
 * preserved.
 */
const PROCEDURE_REJECTED_SOURCE_STATUSES = new Set<Memory["status"]>([
  "superseded",
  "deprecated",
  "rejected",
])

/**
 * Closed-task states for the resolved-task source acceptance gate.
 * Mirrors `PROCEDURE_RESOLVED_TASK_STATES` (the scan-side accept
 * list). `open` / `in-progress` / `blocked` tasks are mid-flight
 * and not eligible as supporting evidence.
 */
const PROCEDURE_VALID_TASK_STATES = new Set<TaskState>(PROCEDURE_RESOLVED_TASK_STATES)

export interface ResolvedProcedureSource {
  memoryId: string
  kind: Memory["kind"]
  title: string
}

/**
 * Thrown by `resolveProcedureSources` when one or more `sourceMemoryIds`
 * references a memory that does not exist, is archived, is not a valid
 * source kind, has a rejected status, or does not project-overlap the
 * target scope. The error message names every offending id and the
 * specific failure mode so the operator can correct the input. Named
 * subclass so consumers can branch on `instanceof`.
 */
export class ProcedureSourceResolutionError extends LoreError<"procedure-source-resolution"> {
  readonly memoryIds: readonly string[]
  constructor(message: string, memoryIds: readonly string[]) {
    super("procedure-source-resolution", message, { memoryIds })
    this.name = "ProcedureSourceResolutionError"
    this.memoryIds = memoryIds
  }
}

/**
 * Resolve every supporting source memory id through
 * `MemoryService.getById` and validate it before the propose write
 * lands. Closes the "syntactic provenance" gap: a Zod-valid 32-char
 * hex string is not the same as a live memory in the target project.
 *
 * Validates per source:
 * - The id resolves to a live memory (not archived, not 404).
 * - The memory's kind is one of `PROCEDURE_VALID_SOURCE_KINDS`.
 * - When the kind is `task`, the task state is in
 *   `PROCEDURE_VALID_TASK_STATES` (done / cancelled).
 * - The memory's project set overlaps `targetProjectIds` (or is
 *   unscoped — repo-wide evidence is acceptable for any project's
 *   procedure).
 * - The memory's status is NOT in `PROCEDURE_REJECTED_SOURCE_STATUSES`.
 *
 * Deduplicates the input id list by canonical id so a double-paste
 * doesn't inflate the count past `PROCEDURE_MIN_SOURCES`. Returns
 * the resolved sources in input order (post-dedup) so the rendered
 * `## Sources` section preserves operator intent.
 */
export interface ProcedureSourceServices {
  memories: {
    getById(id: string): Promise<Memory>
  }
}

export async function resolveProcedureSources(
  services: ProcedureSourceServices,
  sourceMemoryIds: readonly string[],
  targetProjectIds: readonly string[]
): Promise<ResolvedProcedureSource[]> {
  // Dedup while preserving order (first occurrence wins).
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const id of sourceMemoryIds) {
    if (seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
  }

  if (ordered.length < PROCEDURE_MIN_SOURCES) {
    // Boundary-level schemas already reject this, but the service
    // layer should never trust the boundary alone.
    throw new ProcedureSourceResolutionError(
      `Procedure requires at least ${PROCEDURE_MIN_SOURCES} unique source memory ids; ` +
        `received ${ordered.length} after deduplication.`,
      ordered
    )
  }

  const targetSet = new Set(targetProjectIds)
  // Fan out the lookups in parallel; rate-limit middleware paces them
  // and the parallel posture matches the scan's source fetch.
  const results = await Promise.allSettled(
    ordered.map((id) => services.memories.getById(id))
  )

  const resolved: ResolvedProcedureSource[] = []
  const errors: Array<{ id: string; reason: string }> = []

  for (let i = 0; i < ordered.length; i += 1) {
    const id = ordered[i]!
    const result = results[i]!
    if (result.status === "rejected") {
      const message =
        result.reason instanceof Error ? result.reason.message : String(result.reason)
      errors.push({ id, reason: `lookup failed: ${message}` })
      continue
    }
    const mem = result.value
    if (!PROCEDURE_VALID_SOURCE_KIND_SET.has(mem.kind)) {
      errors.push({
        id,
        reason:
          `kind '${mem.kind}' is not a valid procedure source ` +
          `(accept: ${PROCEDURE_VALID_SOURCE_KINDS.join(", ")})`,
      })
      continue
    }
    if (mem.kind === "task") {
      // Three-way gate. `mem.taskState` is nullable: `pageToMemory`
      // returns null when the Task State select is missing (legacy
      // rows from before the column existed, or a Notion-side row
      // edit that cleared it). A two-way `mem.taskState && !allowed`
      // short-circuits on null and lets an untyped task row pass as
      // valid evidence. Require both (taskState present) AND
      // (taskState in allowed set).
      if (mem.taskState === null) {
        errors.push({
          id,
          reason:
            "task has no Task State (legacy row or cleared column); " +
            `procedure sources must be closed tasks (accept: ${[...PROCEDURE_VALID_TASK_STATES].join(", ")})`,
        })
        continue
      }
      if (!PROCEDURE_VALID_TASK_STATES.has(mem.taskState)) {
        errors.push({
          id,
          reason: `task is ${mem.taskState}, not closed (accept: ${[...PROCEDURE_VALID_TASK_STATES].join(", ")})`,
        })
        continue
      }
    }
    if (PROCEDURE_REJECTED_SOURCE_STATUSES.has(mem.status)) {
      errors.push({
        id,
        reason: `status '${mem.status}' disqualifies the row as supporting evidence`,
      })
      continue
    }
    // Project-scope overlap. Empty `projectIds` on the source means
    // repo-wide / unscoped — acceptable for any project's procedure.
    //
    // Error wording does NOT echo the source memory's `projectIds`
    // verbatim — the operator authenticated through Notion's
    // permission model owns the source row, so a leak isn't a
    // bearer-secret class violation, but defense-in-depth says
    // don't enumerate projects the caller chose not to query.
    if (mem.projectIds.length > 0 && targetSet.size > 0) {
      const overlaps = mem.projectIds.some((pid) => targetSet.has(pid))
      if (!overlaps) {
        errors.push({
          id,
          reason: "project scope does not overlap target scope",
        })
        continue
      }
    }
    resolved.push({ memoryId: mem.id, kind: mem.kind, title: mem.title })
  }

  if (errors.length > 0) {
    const lines = errors.map((e) => `  - ${e.id}: ${e.reason}`).join("\n")
    throw new ProcedureSourceResolutionError(
      `Procedure source validation failed for ${errors.length} of ${ordered.length} ` +
        `source memory id${errors.length === 1 ? "" : "s"}:\n${lines}`,
      errors.map((e) => e.id)
    )
  }

  return resolved
}

/**
 * Memory kinds accepted as `supersedesIds` targets when proposing a
 * procedure. A procedure can replace either an older procedure (the
 * common case — round-over-round revision) or a runbook (the
 * promotion-from-existing-runbook case). Other kinds carry their own
 * supersession semantics (decision → decision; incidents/postmortems
 * are historical record and shouldn't be retired by a procedure) and
 * are rejected here.
 */
export const PROCEDURE_VALID_SUPERSEDES_KINDS: readonly Memory["kind"][] = [
  "procedure",
  "runbook",
] as const

const PROCEDURE_VALID_SUPERSEDES_KIND_SET = new Set<Memory["kind"]>(
  PROCEDURE_VALID_SUPERSEDES_KINDS
)

/**
 * Validate every `supersedesIds` entry resolves to a live memory of
 * an acceptable kind, in a project that overlaps the target scope,
 * and whose status is not already in a `rejected` terminal state.
 *
 * Sister of `resolveProcedureSources` but with a narrower kind set:
 * procedures can only supersede procedures and runbooks. Errors
 * surface through the same `ProcedureSourceResolutionError` shape so
 * the boundary handlers branch on one instanceof, not two.
 *
 * The page-id schema validates shape but not liveness; without this
 * preflight a typo'd supersedesIds entry would land a dangling
 * `Supersedes` relation that the next operator can't navigate to.
 * Symmetric with the source-resolution preflight.
 */
export async function resolveProcedureSupersedesIds(
  services: ProcedureSourceServices,
  supersedesIds: readonly string[],
  targetProjectIds: readonly string[]
): Promise<ResolvedProcedureSource[]> {
  if (supersedesIds.length === 0) return []

  const seen = new Set<string>()
  const ordered: string[] = []
  for (const id of supersedesIds) {
    if (seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
  }

  const targetSet = new Set(targetProjectIds)
  const results = await Promise.allSettled(
    ordered.map((id) => services.memories.getById(id))
  )

  const resolved: ResolvedProcedureSource[] = []
  const errors: Array<{ id: string; reason: string }> = []

  for (let i = 0; i < ordered.length; i += 1) {
    const id = ordered[i]!
    const result = results[i]!
    if (result.status === "rejected") {
      const message =
        result.reason instanceof Error ? result.reason.message : String(result.reason)
      errors.push({ id, reason: `lookup failed: ${message}` })
      continue
    }
    const mem = result.value
    if (!PROCEDURE_VALID_SUPERSEDES_KIND_SET.has(mem.kind)) {
      errors.push({
        id,
        reason:
          `kind '${mem.kind}' is not a valid supersedesIds target ` +
          `(accept: ${PROCEDURE_VALID_SUPERSEDES_KINDS.join(", ")}). ` +
          `Procedures only supersede procedures or runbooks; other kinds carry their own supersession semantics.`,
      })
      continue
    }
    if (mem.status === "rejected") {
      errors.push({
        id,
        reason: `status 'rejected' disqualifies the row as a supersession target`,
      })
      continue
    }
    if (mem.projectIds.length > 0 && targetSet.size > 0) {
      const overlaps = mem.projectIds.some((pid) => targetSet.has(pid))
      if (!overlaps) {
        errors.push({
          id,
          reason: "project scope does not overlap target scope",
        })
        continue
      }
    }
    resolved.push({ memoryId: mem.id, kind: mem.kind, title: mem.title })
  }

  if (errors.length > 0) {
    const lines = errors.map((e) => `  - ${e.id}: ${e.reason}`).join("\n")
    throw new ProcedureSourceResolutionError(
      `Procedure supersedesIds validation failed for ${errors.length} of ${ordered.length} ` +
        `id${errors.length === 1 ? "" : "s"}:\n${lines}`,
      errors.map((e) => e.id)
    )
  }

  return resolved
}

/**
 * Thrown by `findExistingProposedProcedure` when an accepted /
 * superseded / deprecated procedure already occupies the topic-key
 * slot. The operator must explicitly deprecate (or revise) before
 * proposing a new procedure on the same key. Carries the existing
 * memory id so the response surface can show the operator what to
 * deprecate.
 */
export class ProcedureTopicKeyConflictError extends LoreError<"procedure-topic-key-conflict"> {
  readonly existingMemoryId: string
  readonly existingStatus: Memory["status"]
  readonly topicKey: string
  constructor(input: {
    topicKey: string
    existingMemoryId: string
    existingStatus: Memory["status"]
    message: string
  }) {
    super("procedure-topic-key-conflict", input.message, {
      topicKey: input.topicKey,
      existingMemoryId: input.existingMemoryId,
      existingStatus: input.existingStatus,
    })
    this.name = "ProcedureTopicKeyConflictError"
    this.topicKey = input.topicKey
    this.existingMemoryId = input.existingMemoryId
    this.existingStatus = input.existingStatus
  }
}

export interface FindExistingProcedureServices {
  memories: {
    findByTopicKey(input: {
      topicKey: string
      projectIds: string[]
    }): Promise<Memory | null>
  }
}

export interface FindExistingProcedureResult {
  /** Existing live procedure on the same `(topicKey, project-set)` slot, or null. */
  existing: Memory | null
  /**
   * When `existing != null` and its status is `proposed`, this is the
   * row the propose path should return as a reuse short-circuit
   * (matching `lore-task action='create'`'s `findExactReuseTarget`
   * posture). When the existing status is non-proposed, the propose
   * path throws `ProcedureTopicKeyConflictError` instead.
   */
  reuseTarget: Memory | null
}

/**
 * Probe `findByTopicKey` for the topic-key slot the propose path is
 * about to write into. Mirrors the topic-key upsert lookup but
 * dispatches on procedure-specific status semantics:
 *
 * - **No existing row** → fresh create.
 * - **Existing `kind: procedure, status: proposed`** → reuse target;
 *   the propose path short-circuits with `Reused existing proposed
 *   procedure: ...` and does NOT call `MemoryService.create`. Closes
 *   the duplicate-on-retry blocker.
 * - **Existing `kind: procedure, status: accepted | superseded | deprecated`**
 *   → throw `ProcedureTopicKeyConflictError`. The operator must
 *   explicitly deprecate (or supersede) the old row before proposing
 *   a replacement. Silent reuse here would either overwrite accepted
 *   guidance or resurrect deprecated guidance, both of which violate
 *   the audit contract.
 * - **Existing non-procedure kind on the same key** → throw the same
 *   conflict error; topic-key identity is per-kind by spec and a
 *   procedure cannot share a key with a decision/runbook/etc.
 */
export async function findExistingProposedProcedure(
  services: FindExistingProcedureServices,
  input: { topicKey: string; projectIds: readonly string[] }
): Promise<FindExistingProcedureResult> {
  if (input.topicKey === "" || input.projectIds.length === 0) {
    return { existing: null, reuseTarget: null }
  }
  const existing = await services.memories.findByTopicKey({
    topicKey: input.topicKey,
    projectIds: [...input.projectIds],
  })
  if (!existing) return { existing: null, reuseTarget: null }

  if (existing.kind !== "procedure") {
    throw new ProcedureTopicKeyConflictError({
      topicKey: input.topicKey,
      existingMemoryId: existing.id,
      existingStatus: existing.status,
      message:
        `Topic key '${input.topicKey}' is already held by a kind='${existing.kind}' ` +
        `memory (${existing.id}) on the same project set. Procedures cannot share a ` +
        `topic-key slot with another kind. Pick a more specific entity / topic key, ` +
        `or revise that memory first.`,
    })
  }

  if (existing.status === "proposed") {
    return { existing, reuseTarget: existing }
  }

  // Article picker for the operator-facing message — "An accepted"
  // vs "A superseded" / "A deprecated".
  const article = /^[aeiou]/i.test(existing.status) ? "An" : "A"
  throw new ProcedureTopicKeyConflictError({
    topicKey: input.topicKey,
    existingMemoryId: existing.id,
    existingStatus: existing.status,
    message:
      `${article} ${existing.status} procedure already exists on topic key '${input.topicKey}' ` +
      `(${existing.id}). To ship a replacement: revise that row via ` +
      `lore-memory action='update', or deprecate it via ` +
      `lore-procedure action='deprecate' first and then re-propose. ` +
      `Silently creating a duplicate would split the procedure's audit history.`,
  })
}

/**
 * Structural contract the scan needs. The real `MemoryService` and
 * `TaskService` both satisfy it; tests pass lightweight stubs.
 */
export interface ProcedureScanServices {
  memories: Pick<MemoryService, "list">
  tasks: {
    list(
      opts?: ListTasksOpts
    ): Promise<{ items: TaskSummary[]; nextCursor?: string; capped: boolean }>
  }
}

const NON_ALPHANUMERIC_PATTERN = /[^a-z0-9]+/g
const SLUG_CAP = 48

const DIGITS_ONLY_PATTERN = /^[0-9]+$/

function normalizeClusterKey(entity: string): string {
  const lowered = entity
    .normalize("NFKD")
    .replace(COMBINING_MARK_PATTERN, "")
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_PATTERN, "-")
    .replace(/^-+|-+$/g, "")
  if (lowered.length === 0) return ""
  // Reject digit-only keys. The entity extractor emits bare numeric
  // tokens (like `1234`) as standalone candidates alongside their
  // prefixed form (`PR-1234`) so a vault-wide entity filter can pick
  // up PR-shaped task entities; for cluster grouping this produces a
  // duplicate `1234` bucket whose support set is a strict subset of
  // the `pr-1234` bucket. Suppress here so the procedure scan
  // surfaces one cluster per conceptual entity.
  if (DIGITS_ONLY_PATTERN.test(lowered)) return ""
  if (lowered.length <= SLUG_CAP) return lowered
  const head = lowered.slice(0, SLUG_CAP)
  const lastHyphen = head.lastIndexOf("-")
  return lastHyphen > 0 ? head.slice(0, lastHyphen) : head
}

function todayInIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso + "T00:00:00Z")
  const to = Date.parse(toIso + "T00:00:00Z")
  if (Number.isNaN(from) || Number.isNaN(to)) return Number.POSITIVE_INFINITY
  return Math.max(0, (to - from) / 86_400_000)
}

function recencyScore(createdAt: string, today: string): number {
  const age = daysBetween(createdAt, today)
  if (!Number.isFinite(age)) return 0
  // Exponential decay with PROCEDURE_RECENCY_HALF_LIFE_DAYS half-life.
  return Math.pow(0.5, age / PROCEDURE_RECENCY_HALF_LIFE_DAYS)
}

/**
 * Composite score for a candidate cluster. Combines three signals:
 *
 * - **Source count.** `log2(1 + count)` — diminishing returns; a
 *   cluster of 10 incidents isn't 5× more procedure-worthy than a
 *   cluster of 2.
 * - **Kind diversity.** `+PROCEDURE_KIND_DIVERSITY_BONUS` per
 *   additional kind represented. Cross-kind agreement is stronger
 *   evidence than repetition within one kind.
 * - **Recency.** Average recency-score across sources. A cluster of
 *   stale sources from 18 months ago is less actionable than a fresh
 *   cluster from the last quarter.
 *
 * Pure function. The constants are starting points; tune from
 * real-vault feedback (operators running `lore procedures scan`
 * who can tell us "these were the candidates I actually promoted").
 */
export function scoreCandidate(
  sources: readonly ProcedureSource[],
  kindDiversity: number,
  today: string
): number {
  if (sources.length === 0) return 0
  const countScore = Math.log2(1 + sources.length)
  const diversityScore = (kindDiversity - 1) * PROCEDURE_KIND_DIVERSITY_BONUS
  const recency =
    sources.reduce((sum, src) => sum + recencyScore(src.createdAt, today), 0) /
    sources.length
  return countScore + diversityScore + recency
}

/**
 * Read-only candidate scan. Walks resolved incidents / postmortems /
 * runbooks plus closed tasks, clusters by entity, and returns ranked
 * candidates. Bounded by `PROCEDURE_MAX_SOURCES_PER_KIND` and
 * `PROCEDURE_MAX_RESOLVED_TASKS` to keep worst-case wall-clock
 * predictable on large vaults.
 *
 * The scan does not touch Notion writes, does not consult LLMs, and
 * is safe to re-run repeatedly.
 *
 * **Does NOT dedupe against existing procedure rows on the topic
 * slot.** A vault with a proposed-but-not-yet-approved or accepted
 * procedure on `procedure/<clusterKey>` still surfaces the cluster
 * on every re-scan. That is deliberate: the propose path itself
 * carries the idempotency probe (`findExistingProposedProcedure`)
 * and rejects accepted/superseded/deprecated conflicts with
 * actionable diagnostics. Filtering at scan time would mask the
 * supporting-source set from operators reviewing the existing
 * procedure for revision (their natural starting point is the
 * cluster of evidence, not the procedure row alone).
 *
 * **Fan-out failure posture.** Source fetches dispatch via
 * `Promise.all`; a transient 5xx in any branch aborts the entire
 * scan. The branches walk the same vault under the same rate-limited
 * client, so a 5xx that takes down one likely takes down the others;
 * `Promise.allSettled`'s partial-recovery posture would help only on
 * the narrow case of a transient single-call failure the rate-limit
 * middleware doesn't retry through, at the cost of masking a
 * fully-broken scan as half-results. Switch to `allSettled` only when
 * a real partial-recovery surface lands.
 */
export async function findProcedureCandidates(
  services: ProcedureScanServices,
  opts: FindProcedureCandidatesOptions
): Promise<ProcedureCandidate[]> {
  const today = opts.today ?? todayInIso()
  const limit = Math.min(
    Math.max(1, opts.limit ?? DEFAULT_PROCEDURE_CANDIDATE_LIMIT),
    MAX_PROCEDURE_CANDIDATE_LIMIT
  )
  const minScore = opts.minScore ?? 0

  // Fan out the source fetches in parallel; the scan is read-only
  // and the rate-limit middleware will pace the calls. Each kind is
  // bounded independently so a pathological vault with thousands of
  // runbooks can't drown the incident / postmortem fetches.
  const memoryFetches = PROCEDURE_SOURCE_KINDS.map((kind) =>
    services.memories.list({
      projectId: opts.projectId,
      kind,
      limit: PROCEDURE_MAX_SOURCES_PER_KIND,
      includeContent: false,
    })
  )
  const taskFetch = services.tasks.list({
    projectId: opts.projectId,
    states: [...PROCEDURE_RESOLVED_TASK_STATES],
    limit: PROCEDURE_MAX_RESOLVED_TASKS,
  })

  const [memoryResults, taskResult] = await Promise.all([
    Promise.all(memoryFetches),
    taskFetch,
  ])

  // Cluster bucket carries its own per-memory dedupe so two entity
  // tokens that normalize to the same cluster key (e.g. a hashed
  // and dashed form of the same PR id both folding to `pr-1234`)
  // only count one supporting memory. Without this, a memory whose
  // title surfaces multiple
  // shape variants of the same entity inflates the cluster's source
  // count and passes `PROCEDURE_MIN_SOURCES` on its own.
  const clusters = new Map<
    string,
    { entity: string; sources: ProcedureSource[]; sourceIds: Set<string> }
  >()

  function addToCluster(entity: string, source: ProcedureSource): void {
    const key = normalizeClusterKey(entity)
    if (key.length < MIN_CLUSTER_KEY_LENGTH) return
    let bucket = clusters.get(key)
    if (!bucket) {
      bucket = { entity, sources: [], sourceIds: new Set() }
      clusters.set(key, bucket)
    }
    if (bucket.sourceIds.has(source.memoryId)) return
    bucket.sourceIds.add(source.memoryId)
    bucket.sources.push(source)
  }

  for (const result of memoryResults) {
    for (const mem of result.items) {
      // Active or accepted statuses only — superseded / deprecated /
      // rejected rows are by definition not the resolution shape we
      // want to mine. Empty status (legacy rows) passes.
      if (
        mem.status === "superseded" ||
        mem.status === "deprecated" ||
        mem.status === "rejected"
      ) {
        continue
      }
      for (const ent of extractEntityCandidates(mem.title, mem.keywords, mem.synopsis)) {
        addToCluster(ent, {
          memoryId: mem.id,
          kind: mem.kind,
          title: mem.title,
          createdAt: mem.createdAt.slice(0, 10),
          taskState: mem.taskState,
        })
      }
    }
  }

  for (const task of taskResult.items) {
    if (!task.entity || task.entity.trim() === "") continue
    addToCluster(task.entity, {
      memoryId: task.id,
      kind: "task",
      title: task.title,
      createdAt: task.createdAt.slice(0, 10),
      taskState: task.taskState,
    })
  }

  const candidates: ProcedureCandidate[] = []
  for (const [clusterKey, bucket] of clusters) {
    if (bucket.sources.length < PROCEDURE_MIN_SOURCES) continue
    // Newest-first; trim to a readable cap so the response doesn't
    // ship megabytes of supporting-source titles for a hot entity.
    const sortedSources = [...bucket.sources].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    )
    const trimmed = sortedSources.slice(0, 10)
    const kinds = new Set(trimmed.map((s) => s.kind))
    const score = scoreCandidate(trimmed, kinds.size, today)
    if (score < minScore) continue
    candidates.push({
      clusterKey,
      entity: bucket.entity,
      sources: trimmed,
      kindDiversity: kinds.size,
      score,
      suggestedTopicKey: `procedure/${clusterKey}`,
    })
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length
    return a.clusterKey.localeCompare(b.clusterKey)
  })

  return candidates.slice(0, limit)
}

/**
 * Section-tagged body content for a procedure. The propose path
 * accepts these structured pieces and renders them into the
 * canonical Markdown body via `composeProcedureBody`. Storing the
 * pieces structurally (rather than asking the caller to pre-render
 * Markdown) lets the wake-up surface and the supersede path read a
 * procedure's activation conditions back without re-parsing the
 * body.
 */
export interface ProcedureBodyInput {
  /**
   * Human-readable activation conditions. Each entry is one bullet
   * under `## Activation Conditions`. Example: "Entity matches PR
   * #*", "Tags include performance".
   */
  activationConditions: string[]
  /**
   * Ordered steps describing the resolution sequence. Each entry is
   * one numbered list item under `## Steps`. Steps can be multiline.
   */
  steps: string[]
  /**
   * Known failure modes — paths the procedure tried that did NOT
   * work, or guardrails on when to abandon. Each entry is a bullet
   * under `## Known Failure Modes`. Empty section renders only the
   * header.
   */
  failureModes?: string[]
  /**
   * Free-form additional context. Rendered verbatim under `##
   * Notes`. Use sparingly; the structured sections above are the
   * load-bearing surface.
   */
  notes?: string
  /**
   * Notion page ids of supporting memories. Rendered as a bulleted
   * `## Sources` section with anchor-style references so an
   * inspecting agent can pull them via `lore-memory action='expand'`.
   */
  sourceMemoryIds: string[]
}

const MAX_BULLET = 500

function bullet(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_BULLET) return `- ${trimmed}`
  return `- ${trimmed.slice(0, MAX_BULLET - 1)}…`
}

/**
 * Step truncation parallel to `bullet` but preserving the numbered-
 * list format. Without this, a multi-thousand-character step would
 * render verbatim while the surrounding bulleted sections enforce
 * the `MAX_BULLET` cap. Caps at `MAX_BULLET` so the per-line budget
 * stays uniform across every structured section in the body.
 */
function numberedStep(index: number, text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_BULLET) return `${index}. ${trimmed}`
  return `${index}. ${trimmed.slice(0, MAX_BULLET - 1)}…`
}

/**
 * Compose the canonical procedure Markdown body. Sections are
 * order-stable and section headers are pinned by test so a future
 * wake-up parser can rely on the structure. Empty optional sections
 * are omitted entirely (no empty headers).
 *
 * **Layering note:** `composeProcedureBody` accepts an empty
 * `sourceMemoryIds` list and renders `- (no supporting memories)`
 * — this is a permissive renderer surface, NOT the boundary
 * contract. The MCP/CLI propose paths enforce `length >=
 * PROCEDURE_MIN_SOURCES` at the schema boundary (with
 * `resolveProcedureSources` validating live-row provenance) BEFORE
 * calling this helper. Tests for the composer's empty-state
 * rendering verify the renderer's behavior, not the propose
 * contract; the boundary tests pin the contract.
 */
export function composeProcedureBody(input: ProcedureBodyInput): string {
  const sections: string[] = []

  sections.push("## Activation Conditions")
  if (input.activationConditions.length === 0) {
    sections.push("- (none specified)")
  } else {
    for (const cond of input.activationConditions) {
      sections.push(bullet(cond))
    }
  }

  sections.push("", "## Steps")
  if (input.steps.length === 0) {
    sections.push("(no steps specified)")
  } else {
    input.steps.forEach((step, i) => {
      sections.push(numberedStep(i + 1, step))
    })
  }

  if (input.failureModes && input.failureModes.length > 0) {
    sections.push("", "## Known Failure Modes")
    for (const mode of input.failureModes) {
      sections.push(bullet(mode))
    }
  }

  if (input.notes && input.notes.trim().length > 0) {
    sections.push("", "## Notes", "", input.notes.trim())
  }

  sections.push("", "## Sources")
  if (input.sourceMemoryIds.length === 0) {
    sections.push("- (no supporting memories)")
  } else {
    for (const id of input.sourceMemoryIds) {
      sections.push(`- ${id}`)
    }
  }

  return sections.join("\n")
}

/**
 * Compose the `Keywords` field for a proposed procedure. Replicates
 * the activation tokens to keywords so the hybrid search's contains
 * branch (which filters server-side on `title | keywords | synopsis`)
 * surfaces procedures whose activation conditions reference an
 * entity the user is currently asking about.
 *
 * Without this, wake-up's relevance section would only fire for
 * procedures whose title contained the activation entity verbatim —
 * a long-tail miss for activation conditions like "Tags include
 * performance".
 */
/**
 * Cap on the rendered `Keywords` cell length. Notion's per-block
 * rich_text ceiling is 2000 chars; budgeting under that with
 * headroom prevents a maxed-out propose payload from failing
 * `pages.create` with a generic 400. The cap kicks in only when a
 * propose carries 50 activation conditions × hundreds of unique
 * tokens — the common case stays well under 100 chars.
 */
export const PROCEDURE_KEYWORDS_CAP = 1900

export function composeProcedureKeywords(
  activationConditions: readonly string[],
  entity: string
): string {
  const tokens = new Set<string>()
  const entityNorm = entity.trim()
  if (entityNorm.length > 0) tokens.add(entityNorm)
  for (const cond of activationConditions) {
    for (const word of cond.split(/[\s,;]+/)) {
      const trimmed = word.trim()
      if (trimmed.length >= 3) tokens.add(trimmed)
    }
  }
  // Accumulate tokens until we'd cross the cap, then stop. Stable
  // order (insertion order on Set) — `entity` always lands first if
  // present, so the activation-token search surface preserves the
  // most-important token even when the rest of the set gets clipped.
  const accumulated: string[] = []
  let length = 0
  for (const token of tokens) {
    const projected = length === 0 ? token.length : length + 1 + token.length
    if (projected > PROCEDURE_KEYWORDS_CAP) break
    accumulated.push(token)
    length = projected
  }
  return accumulated.join(" ")
}

/**
 * Synopsis line surfaced on listings and wake-up. Single short
 * sentence so the entity surfaces immediately for activation
 * matching. Soft-capped at 200 chars; the MCP boundary caps at 500.
 */
export function composeProcedureSynopsis(entity: string, stepCount: number): string {
  const entityClause =
    entity.trim().length > 0 ? `Reusable procedure for "${entity}"` : "Reusable procedure"
  const stepClause =
    stepCount === 0
      ? "(no steps specified yet)"
      : `${stepCount} step${stepCount === 1 ? "" : "s"}`
  const line = `${entityClause}; ${stepClause}.`
  return line.length > 200 ? line.slice(0, 199) + "…" : line
}

export interface ProposeProcedureInput {
  /** Title for the procedure memory. Required, non-empty. */
  title: string
  /**
   * Entity the procedure applies to. Used for synopsis and keywords.
   * Empty string allowed for procedures with no single entity anchor.
   */
  entity: string
  /** Activation conditions, steps, optional failure modes, sources. */
  body: ProcedureBodyInput
  /** Project scope. Same set-equality posture as topic-key upsert. */
  projectIds: string[]
  /**
   * Optional topic key. Defaults to `procedure/<normalized-entity>`.
   * Caller can override (e.g. when promoting from a scan candidate
   * that already carries a `suggestedTopicKey`).
   */
  topicKey?: string
  /**
   * Optional Notion topic relation. Independent of `topicKey`.
   * Most callers omit this.
   */
  topicId?: string
  /**
   * Optional `supersedesIds`. Set when this procedure replaces an
   * older procedure or runbook. The status of the replaced memories
   * is NOT flipped here — that's the operator's call via the
   * existing supersede path. We only record the relation so the
   * audit trail has both directions.
   */
  supersedesIds?: string[]
  /**
   * Optional author / agent provenance. Defaults to the engineer
   * identity resolved by the calling layer (CLI / MCP).
   */
  author?: string
  agent?: string
  /**
   * Optional additional tags. The closed tag vocabulary applies
   * at the MCP boundary — internal callers can pass anything.
   */
  tags?: string[]
}

/**
 * Compose the `CreateMemoryInput` for a proposed procedure. Returns
 * the input rather than performing the write so the caller decides
 * whether to dispatch via `MemoryService.create` (the typical path)
 * or `MemoryService.upsertByTopicKey` (when an operator wants append-
 * revision semantics on a known-good topic chain). MCP and CLI
 * surfaces call `MemoryService.create` because procedures are
 * reviewed individually — upsert would defeat the review gate.
 *
 * The `synopsis`, `keywords`, and `content` fields are composed
 * deterministically from the structured `ProcedureBodyInput` so
 * a future wake-up parser can recover the activation conditions
 * without LLM assistance.
 */
export function buildProposeProcedureInput(
  input: ProposeProcedureInput
): CreateMemoryInput {
  const trimmedTitle = input.title.trim()
  if (trimmedTitle.length === 0) {
    throw new Error("Procedure title must be a non-empty string.")
  }

  // Defensive empty-topic-key throw. The MCP / CLI propose handlers
  // guard this upstream so the operator-facing error names which
  // arg to set, but an internal caller of this helper would
  // otherwise silently land a `topicKey: ""` procedure that defeats
  // the idempotency probe (`findByTopicKey` returns null on empty
  // key). Belt-and-braces.
  const resolvedTopicKey =
    input.topicKey ?? defaultProcedureTopicKey(input.entity, trimmedTitle)
  if (resolvedTopicKey === "") {
    throw new Error(
      "Procedure topic key cannot be empty. Pass an explicit `topicKey`, " +
        "or set a more descriptive `entity` / `title` (both normalized to " +
        "empty alphanumerics in this call)."
    )
  }

  // Dedup source ids before they reach `composeProcedureBody`'s
  // `## Sources` renderer. `resolveProcedureSources` already
  // deduplicates internally for validation, but the body composer
  // iterates `input.body.sourceMemoryIds` directly — a double-paste
  // would land duplicate `- <id>` lines in the rendered body. The
  // dedup preserves first-occurrence order so the rendered surface
  // matches operator intent.
  const seenSources = new Set<string>()
  const dedupedSources: string[] = []
  for (const id of input.body.sourceMemoryIds) {
    if (seenSources.has(id)) continue
    seenSources.add(id)
    dedupedSources.push(id)
  }
  const dedupedBody: ProcedureBodyInput = {
    ...input.body,
    sourceMemoryIds: dedupedSources,
  }

  // Symmetric dedup for `supersedesIds`. Notion dedupes relations on
  // the wire so the database side is safe regardless, but mirroring
  // the sourceMemoryIds dedup keeps the "internal callers can't
  // double-paste" invariant uniform across both id lists.
  let dedupedSupersedesIds: string[] | undefined
  if (input.supersedesIds && input.supersedesIds.length > 0) {
    const seenSupersedes = new Set<string>()
    dedupedSupersedesIds = []
    for (const id of input.supersedesIds) {
      if (seenSupersedes.has(id)) continue
      seenSupersedes.add(id)
      dedupedSupersedesIds.push(id)
    }
  }

  const content = composeProcedureBody(dedupedBody)
  const keywords = composeProcedureKeywords(input.body.activationConditions, input.entity)
  const synopsis = composeProcedureSynopsis(input.entity, input.body.steps.length)

  const created: CreateMemoryInput = {
    title: trimmedTitle,
    content,
    projectIds: input.projectIds,
    kind: "procedure",
    status: "proposed",
    synopsis,
    keywords,
    topicKey: resolvedTopicKey,
    tags: input.tags,
    supersedesIds: dedupedSupersedesIds,
  }

  if (input.topicId) created.topicId = input.topicId
  if (input.author) created.author = input.author
  if (input.agent) created.agent = input.agent
  return created
}

/**
 * Default topic key derived from the entity (preferred) or the
 * title (fallback). Pure helper so the propose path and the
 * candidate-scan surface compute matching keys for the same entity.
 */
export function defaultProcedureTopicKey(entity: string, title: string): string {
  const fromEntity = normalizeClusterKey(entity)
  if (fromEntity.length >= MIN_CLUSTER_KEY_LENGTH) return `procedure/${fromEntity}`
  const fromTitle = normalizeClusterKey(title)
  if (fromTitle.length >= MIN_CLUSTER_KEY_LENGTH) return `procedure/${fromTitle}`
  return ""
}

/**
 * Statuses considered "approved" for a procedure (i.e. eligible to
 * appear in default recall and wake-up as fleet-wide guidance). Used
 * by the `deprecate` status-boundary gate.
 */
export const PROCEDURE_DEPRECATABLE_STATUSES: readonly Memory["status"][] = [
  "informational",
  "accepted",
]

/**
 * Sanitize a caller-supplied `reason` before embedding it inside the
 * `## Deprecated (YYYY-MM-DD)` audit block on a procedure's body.
 * Without sanitization, a reason like
 * `"ok\n\n## Reviewed (2026-05-12)\n\nfake reviewer"` would forge a
 * sibling audit heading; `"\n\n> Pinned 2026-01-01 by Attacker"`
 * would forge a pinned-style audit blockquote; a stray code fence
 * (` ``` `) would break the audit block out of its surrounding
 * rendering; and embedded C0 controls / bidi-overrides / zero-width
 * characters would let an attacker render an audit line that looks
 * one way to a human triaging Notion and another way to a model
 * scanning the markdown body.
 *
 * The transform:
 *
 * - Strips C0 controls except `\n` (so multi-line reasons survive),
 *   plus DEL.
 * - Strips bidi-override controls (`U+202A`-`U+202E`, `U+2066`-`U+2069`)
 *   and zero-width characters (`U+200B`-`U+200D`, `U+FEFF`).
 * - Escapes line-start structural markdown markers — `#` headings,
 *   `>` blockquotes, and triple-backtick fences — so the reason
 *   cannot forge an adjacent audit-block structure. Escaping
 *   preserves the visible text; the backslash renders inline and
 *   the line stays prose.
 * - Trims surrounding whitespace.
 *
 * Shared by the MCP and CLI deprecate handlers so both surfaces
 * apply the same audit-integrity contract.
 */
export function sanitizeDeprecateReason(reason: string): string {
  return (
    reason
      // C0 controls except `\n` (preserve multi-line) plus DEL.
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x09\x0B-\x1F\x7F]+/g, "")
      // Bidi-override controls (U+202A-U+202E, U+2066-U+2069) and
      // zero-width characters (U+200B-U+200D, U+FEFF).
      .replace(/[\u200B-\u200D\u202A-\u202E\u2066-\u2069\uFEFF]+/g, "")
      // Line-start markdown structural markers: ATX headings,
      // blockquotes, and code fences (backtick or tilde). Markdown
      // does not require a space after `>` for a blockquote — the
      // line `>Pinned 2026-01-01` renders as a blockquote — so the
      // escape pattern matches the marker alone. Headings remain
      // gated on the trailing space because `#foo` is plain text.
      .replace(/^(\s*)(#{1,6})(\s)/gm, "$1\\$2$3")
      .replace(/^(\s*)(>)/gm, "$1\\$2")
      .replace(/^(\s*)(```|~~~)/gm, "$1\\$2")
      .trim()
  )
}
