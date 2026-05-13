/**
 * Near-duplicate probe used by `lore-memory action='save'` and
 * `lore-decision action='create'`.
 *
 * The probe is advisory, not blocking: the write always proceeds, but the
 * tool response surfaces any existing row whose title looks similar enough
 * that the caller might have meant to update or supersede instead of
 * creating a fresh page.
 *
 * Cost budget: one `dataSources.query` per save, bounded by a project +
 * tag filter. The query runs at the tool layer in parallel with the
 * actual create so it doesn't add wall-clock latency.
 *
 * Thresholds are initial guesses (0.7 for memories,
 * 0.6 for decisions); tune on real data after rollout.
 */

import type {
  Memory,
  MemoryConfidence,
  MemoryKind,
  MemorySource,
  MemoryStatus,
  TaskState,
  TaskSummary,
} from "../types.js"
import { ACTIVE_TASK_STATES } from "../types.js"
import { decodeTextEntities } from "../notion/html-entities.js"
import { trigramJaccard, tagOverlap } from "./similarity.js"

/**
 * Sentinel keyword written into a memory's `Keywords` column at the same
 * `pages.update` that archives a properties-only orphan after a partial
 * `MemoryService.create` failure. Notion's archive is soft —
 * within ~30 days, an operator restoring from the workspace trash (or a
 * UI-level bulk restore) re-introduces the orphan as a live properties-
 * only row. The sentinel is the load-bearing signal that lets every
 * read path that surfaces live memories (`findByTopicKey`,
 * `findNearDuplicates`, `findAutosaveLearningDuplicate`,
 * `MemoryService.list`, `fetchContainsPages`, `listForScan`,
 * `listAllForBackfill`, `queryStaleConfidence`, and the
 * `applySemanticPostFilters` post-filter for `client.search`) ignore the
 * resurfaced row instead of surfacing it as a "live duplicate target"
 * with an empty body.
 *
 * Living here rather than alongside `MemoryService` because two of
 * the original three filters live here, and `MemoryService` already
 * imports from this module — co-locating the constant with its
 * primary consumers avoids a circular import.
 *
 * **Substring match, not tag equality.** Both the server-side filter
 * (`Keywords rich_text does_not_contain ...`) and the client-side
 * post-filters (`memory.keywords.includes(...)`) are substring matches
 * on the literal sentinel string. The leading `__` mimics the
 * system-managed-sentinel convention used elsewhere AND keeps the
 * literal long enough that an agent or operator typing keyword content
 * cannot accidentally collide with it. A user keyword that happens
 * to contain the sentinel substring would technically substring-match
 * and trigger the filter, but typing such a value
 * voluntarily is implausible enough that the cleaner write-path
 * (`existing keywords + " " + sentinel`) is preferable to a more
 * complex word-boundary scheme.
 *
 * **Original keywords are preserved on cleanup writes.** When the
 * partial-failure path archives an orphan, `Keywords` lands as
 * `${decoded.keywords} ${SENTINEL}` (or just the sentinel when the
 * caller passed empty keywords) so an operator inspecting the row in
 * Notion's trash still sees their original keyword content alongside
 * the sentinel. The substring filter is unaffected by the prefix.
 */
export const MEMORY_CLEANUP_ORPHAN_SENTINEL = "__lore-cleanup-orphan"

export interface NearDuplicateMatch {
  id: string
  title: string
  /** Trigram Jaccard over the normalized titles. Range `[0, 1]`. */
  titleSimilarity: number
  /**
   * Jaccard over tag sets. Range `[0, 1]`. `0` when either row has no
   * tags (via `tagOverlap`'s empty-set rule),
   * so callers render this only when `> 0` — a 0.0 reading on an
   * untagged candidate carries no information and would be noise.
   */
  tagOverlap: number
  decidedAt: string | null
  status: MemoryStatus
}

/**
 * Minimal interface the probe needs from `MemoryService`. Keeping it
 * narrow lets tests pass a plain object without constructing a full
 * service, and documents exactly which query shape the probe depends on
 * so future `list()` signature changes don't silently break the probe.
 *
 * `includeProposed` is load-bearing on the write-safety paths:
 * `MemoryService.list` adds a `Status != proposed`
 * default-recall filter when no explicit `status` is passed. Probes that
 * need to consider proposed rows (decision near-duplicate over
 * `accepted | proposed`, autosave-learning dedup against rows written
 * as `proposed`) must opt in via this flag, otherwise the
 * candidate pool silently drops the very rows the probe is meant to
 * deduplicate against.
 */
export interface MemoryLister {
  list(opts: {
    projectId?: string
    topicId?: string
    source?: MemorySource
    tags?: string[]
    kind?: MemoryKind
    confidence?: MemoryConfidence
    session?: string
    limit?: number
    includeContent?: boolean
    includeUnscoped?: boolean
    includeProposed?: boolean
    // If you extend `findNearDuplicates` (or `findAutosaveLearning
    // Duplicate`) to pass another `MemoryService.list` parameter,
    // widen this narrow shape in lockstep — otherwise the test
    // seam types stop matching the production signature and the
    // probe call sites silently fall back to defaults that hide
    // the new dimension. The narrow shape exists so test fixtures
    // pass plain objects without constructing the full service;
    // every probe-used field MUST be enumerated here.
  }): Promise<{ items: Memory[]; nextCursor?: string }>
  /**
   * Candidate-pool fetcher. When the `MemoryLister` is a
   * real `MemoryService`, this routes through the SQL filter path
   * if `LORE_USE_RUNTOOL_FILTER_SQL=1` and a RunTool client is
   * wired; otherwise it forwards to `list({ excludeKinds, ... })`
   * so the REST path's existing `Kind != X` server-side filter is
   * still applied (a one-line REST improvement that lands
   * alongside the SQL path).
   *
   * Optional on the interface so test fixtures that pass a plain
   * `{ list }` object still satisfy the type — `findNearDuplicates`
   * checks for the method's presence at runtime and falls back to
   * `list({ excludeKinds, ... })` when absent.
   */
  listForNearDuplicates?(opts: {
    projectId: string
    topicId?: string
    kind?: MemoryKind
    excludeKinds?: readonly MemoryKind[]
    statuses?: readonly MemoryStatus[]
    tags?: readonly string[]
    includeProposed?: boolean
    limit: number
  }): Promise<Memory[]>
}

export interface FindNearDuplicatesOpts {
  /** Title of the row being written — the probe subject. */
  title: string
  /** Tags on the row being written. Top-2 scope the candidate pool. */
  tags: string[]
  /**
   * Project to scope the candidate pool. Must be provided — vault-wide
   * probes are skipped because they'd scan the entire Memories DB, busting
   * the one-query budget. Multi-project saves pass the primary project;
   * cross-project near-duplicates are deferred future work.
   */
  projectId?: string
  /**
   * Topic filter for decisions (same-topic is part of the decision-path
   * probe rule). Leave undefined for the memory path.
   */
  topicId?: string
  /**
   * `decision` for the `lore-decision action='create'` path, undefined
   * for the `lore-memory action='save'` path.
   */
  kind?: MemoryKind
  /**
   * Kinds to post-filter out of the candidate pool. Notion's
   * `dataSources.query` has no "kind ≠ X" primitive, so the filter
   * runs client-side. The `lore-memory action='save'` path uses
   * `["decision"]` so a freshly-saved note doesn't light up every
   * governing decision record — decisions are the
   * `lore-decision action='create'` probe's domain.
   *
   * Accepts `readonly` arrays so call sites can pass `as const`
   * tuples without an explicit cast — the helper never mutates.
   */
  excludeKinds?: readonly MemoryKind[]
  /**
   * Status whitelist applied client-side after the query. Notion's
   * `dataSources.query` accepts exactly one `Status select equals` clause,
   * so the decision path — which needs `accepted OR proposed` — post-filters
   * here instead of issuing two server queries for one probe.
   *
   * Accepts `readonly` arrays for the same reason as `excludeKinds`.
   */
  statuses?: readonly MemoryStatus[]
  /** Trigram Jaccard threshold to qualify as a match. */
  threshold: number
  /** Max rows to scan in the candidate pool (default 50). */
  limit?: number
  /**
   * Optional observer for list-query failures. Invoked with the raw
   * error before the probe returns `[]`. `lore-memory action='save'`
   * and `lore-decision action='create'` route this through
   * `debugLogPartialFailures` so probe failures show up under
   * `LORE_DEBUG=1` like every other read-path partial failure,
   * instead of degrading silently.
   */
  onError?: (err: unknown) => void
}

/**
 * Fetch the recent-memory candidate pool and return any rows whose title
 * trigram similarity meets or exceeds `threshold`. Results are sorted by
 * similarity descending — the caller typically surfaces the top 2–3.
 *
 * Swallows probe errors and returns `[]` rather than propagating:
 * near-dup detection is advisory, and a failed probe must not fail the
 * surrounding save. The tool layer is free to add a telemetry hook later.
 */
export async function findNearDuplicates(
  memories: MemoryLister,
  opts: FindNearDuplicatesOpts
): Promise<NearDuplicateMatch[]> {
  // Operator kill-switch. Bulk-import, autosave hooks firing every few
  // messages, and test fixtures that spin up 50+ memories all pay a
  // `dataSources.query` per save otherwise. Setting the env var to `1`
  // short-circuits the probe entirely without touching the call sites.
  // Bypass lives here (not per-tool) so both `lore-memory action='save'`
  // and `lore-decision action='create'` honor it automatically.
  if (process.env["LORE_DISABLE_NEAR_DUPLICATE_PROBE"] === "1") return []
  if (opts.title.trim() === "") return []
  if (!opts.projectId) return []

  // Top-2 tags scope the candidate pool. The `list` tag filter is
  // Notion-side OR across values, so a memory needs to match either tag
  // to enter the pool — which is what we want: share a category, be a
  // candidate for dedup. Fewer than 2 tags: use whatever we have;
  // zero tags means no tag filter (project scope alone).
  const topTags = opts.tags.slice(0, 2)

  // The probe's `statuses` filter is post-fetch on the REST fallback
  // path and lets the decision path keep one server query for an
  // `accepted | proposed` candidate pool. `MemoryService.list` applies
  // a default-exclude filter for `Status = proposed`, so the post-fetch
  // `statuses` whitelist runs against an already-narrowed set whenever
  // `proposed` is in the requested set. Opt in to proposed rows on the
  // way down so the post-filter sees the intended candidate pool.
  // Memory near-dup probes (no `statuses` passed) keep the
  // default-recall posture — proposed inbox rows do not surface as
  // memory-side near-duplicate candidates.
  //
  // SQL path: when `memories.listForNearDuplicates` is available (real
  // `MemoryService`, not a test fixture implementing only `list`), it
  // routes through the SQL filter helper if
  // `LORE_USE_RUNTOOL_FILTER_SQL=1` and falls back to
  // `list({ excludeKinds })` otherwise. Either way, the server-side
  // `Kind NOT IN (...)` filter applies BEFORE the limit truncation —
  // closing the JS-post-filter recall hole the REST-fallback code
  // paid every time the candidate pool was decision-heavy.
  const includeProposed = opts.statuses?.includes("proposed") ?? false
  let items: Memory[]
  try {
    if (memories.listForNearDuplicates) {
      items = await memories.listForNearDuplicates({
        projectId: opts.projectId,
        ...(opts.topicId !== undefined ? { topicId: opts.topicId } : {}),
        ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
        ...(opts.excludeKinds && opts.excludeKinds.length > 0
          ? { excludeKinds: opts.excludeKinds }
          : {}),
        ...(opts.statuses && opts.statuses.length > 0
          ? { statuses: opts.statuses }
          : {}),
        ...(topTags.length > 0 ? { tags: topTags } : {}),
        limit: opts.limit ?? 50,
        // Same `|| undefined` shape as the REST lister payload — see the
        // comment below for the rationale that pin tests cement.
        includeProposed: includeProposed || undefined,
      })
    } else {
      const result = await memories.list({
        projectId: opts.projectId,
        topicId: opts.topicId,
        tags: topTags.length > 0 ? topTags : undefined,
        kind: opts.kind,
        limit: opts.limit ?? 50,
        includeContent: false,
        // `|| undefined` (not just `includeProposed`) keeps the lister
        // payload byte-identical to the pre-default-exclude shape on the
        // memory-path probe (no `statuses`) — `false` and `undefined`
        // route through different code paths in some `MemoryService.list`
        // mocks, and the no-opt-in assertion pins `includeProposed` to
        // be undefined on the lister call. Do not simplify to
        // `includeProposed`; the literal `false` would visibly change
        // the lister payload shape.
        includeProposed: includeProposed || undefined,
      })
      items = result.items
    }
  } catch (err) {
    opts.onError?.(err)
    return []
  }

  const excludeKinds =
    opts.excludeKinds && opts.excludeKinds.length > 0
      ? new Set<MemoryKind>(opts.excludeKinds)
      : null

  const matches: NearDuplicateMatch[] = []
  for (const mem of items) {
    // Exclude resurfaced cleanup-orphans. A partial
    // `MemoryService.create` whose body write fails leaves a properties-
    // only row that gets soft-archived and tagged with this sentinel; an
    // operator restoring from Notion's trash within ~30 days reanimates
    // the row, but the sentinel keyword survives the archive/restore
    // round-trip and steers dedup away from the empty-body shell.
    if (mem.keywords.includes(MEMORY_CLEANUP_ORPHAN_SENTINEL)) continue
    if (excludeKinds?.has(mem.kind)) continue
    if (opts.statuses && !opts.statuses.includes(mem.status)) continue
    const sim = trigramJaccard(opts.title, mem.title)
    if (sim < opts.threshold) continue
    matches.push({
      id: mem.id,
      title: mem.title,
      titleSimilarity: sim,
      tagOverlap: tagOverlap(opts.tags, mem.tags),
      decidedAt: mem.decidedAt,
      status: mem.status,
    })
  }
  matches.sort((a, b) => b.titleSimilarity - a.titleSimilarity)
  return matches
}

export interface AutosaveLearningDuplicateMatch extends NearDuplicateMatch {
  /** Full existing row that should be reused instead of creating a duplicate. */
  memory: Memory
  /** Project relation on the existing row, for session auto-link bookkeeping. */
  projectIds: string[]
  /** Hook session id stored on the existing row. */
  session: string | null
  /** Trigram Jaccard over the full markdown body. Range `[0, 1]`. */
  contentSimilarity: number
  /** Trigram Jaccard over title + body. Range `[0, 1]`. */
  combinedSimilarity: number
  /** Token-set Jaccard over title + body after light stemming. Range `[0, 1]`. */
  tokenSimilarity: number
}

export interface FindAutosaveLearningDuplicateOpts {
  /** Title of the atomic learning being written. */
  title: string
  /** Markdown body of the atomic learning being written. */
  content: string
  /** Project scope to prefer when one is available. Used as the query anchor. */
  projectId?: string
  /**
   * Full project relation set for assertive reuse. Project-scoped duplicate
   * hits must match this set exactly before they can suppress creation.
   */
  projectIds?: string[]
  /** Hook session id. Required for session-scoped searches and response context. */
  session?: string
  /**
   * Duplicate search scope. Defaults to the historical same-session gate.
   * Project scope promotes cross-session autosave learnings to assertive reuse,
   * but requires a non-empty project set so the probe never becomes vault-wide.
   */
  scope?: "session" | "project"
  /** Similarity threshold for blocking a duplicate create. */
  threshold?: number
  /** Max rows to scan in the candidate pool (default 50). */
  limit?: number
  /** Optional observer for list-query failures. */
  onError?: (err: unknown) => void
}

export class AutosaveLearningDuplicateProbeError extends Error {
  constructor(
    message: string,
    public readonly cause: unknown
  ) {
    super(message)
    this.name = "AutosaveLearningDuplicateProbeError"
  }
}

const AUTOSAVE_LEARNING_TEXT_DUPLICATE_THRESHOLD = 0.92
const AUTOSAVE_LEARNING_TOKEN_DUPLICATE_THRESHOLD = 0.72

const LEARNING_TOKEN_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
])

function learningContentSimilarity(a: string, b: string): number {
  if (a.trim() === "" || b.trim() === "") return 0
  return trigramJaccard(a, b)
}

function learningCombinedSimilarity(
  titleA: string,
  contentA: string,
  titleB: string,
  contentB: string
): number {
  return trigramJaccard(`${titleA}\n${contentA}`, `${titleB}\n${contentB}`)
}

function normalizeLearningToken(raw: string): string {
  if (LEARNING_TOKEN_STOPWORDS.has(raw)) return ""

  let token = raw
  if (token.endsWith("ies") && token.length > 4) {
    token = `${token.slice(0, -3)}y`
  } else if (token.endsWith("ed") && token.length > 4) {
    token = token.slice(0, -2)
  } else if (token.endsWith("s") && token.length > 3) {
    token = token.slice(0, -1)
  }

  return LEARNING_TOKEN_STOPWORDS.has(token) ? "" : token
}

function learningTokens(title: string, content: string): Set<string> {
  const text = `${title}\n${content}`.toLowerCase().replace(/\b([a-z0-9]+)['’]s\b/g, "$1")
  const rawTokens = text.match(/[a-z0-9]+/g) ?? []
  const tokens = new Set<string>()
  for (const raw of rawTokens) {
    const normalized = normalizeLearningToken(raw)
    if (normalized) tokens.add(normalized)
  }
  return tokens
}

function learningTokenSimilarity(
  titleA: string,
  contentA: string,
  titleB: string,
  contentB: string
): number {
  const A = learningTokens(titleA, contentA)
  const B = learningTokens(titleB, contentB)
  if (A.size === 0 || B.size === 0) return 0

  let intersection = 0
  const [smaller, larger] = A.size <= B.size ? [A, B] : [B, A]
  for (const token of smaller) {
    if (larger.has(token)) intersection++
  }
  const union = A.size + B.size - intersection
  return intersection / union
}

function normalizedProjectSet(ids: readonly string[] | undefined): string[] {
  return [...new Set(ids ?? [])].sort()
}

function projectSetsEqual(a: readonly string[], b: readonly string[]): boolean {
  const A = normalizedProjectSet(a)
  const B = normalizedProjectSet(b)
  if (A.length !== B.length) return false
  return A.every((id, index) => id === B[index])
}

/**
 * Blocking duplicate finder for Stop-spawn atomic learnings.
 *
 * The regular `findNearDuplicates` probe is advisory; autosave learning
 * extraction needs a stronger contract because the same transcript window can
 * be processed more than once, and the same durable fact can reappear in later
 * sessions. This helper reads only likely conversation-sourced notes and
 * fetches bodies so a duplicate body/combined-text pair returns the existing
 * row instead of letting the write path create another memory. Session scope
 * preserves the historical same-session behavior; project scope is exact-set
 * only and uses one project id as the bounded query anchor.
 */
export async function findAutosaveLearningDuplicate(
  memories: MemoryLister,
  opts: FindAutosaveLearningDuplicateOpts
): Promise<AutosaveLearningDuplicateMatch | null> {
  if (
    process.env["LORE_DISABLE_AUTOSAVE_LEARNING_DEDUP"] === "1" ||
    process.env["LORE_DISABLE_NEAR_DUPLICATE_PROBE"] === "1"
  ) {
    return null
  }
  const scope = opts.scope ?? "session"
  const session = opts.session?.trim()
  const requestedProjectIds =
    scope === "project"
      ? normalizedProjectSet(
          opts.projectIds && opts.projectIds.length > 0
            ? opts.projectIds
            : opts.projectId
              ? [opts.projectId]
              : []
        )
      : []
  const queryProjectId = scope === "project" ? requestedProjectIds[0] : opts.projectId
  if (scope === "session" && !session) return null
  if (scope === "project" && !queryProjectId) return null
  if (opts.title.trim() === "") return null

  // `includeProposed: true` is a write-safety opt-in. `MemoryService.list`
  // applies `Status != proposed` to its default filter, but autosave hooks
  // may write atomic learnings as `Status: proposed` when
  // `hooks.proposeAutosaveLearnings` is enabled. Without this flag, the
  // dedup gate silently misses the very rows the previous autosave run
  // just wrote — repeated runs would duplicate proposed learnings instead
  // of reusing them. Same posture as `findNearDuplicates`'s decision-path
  // opt-in: a write-safety probe must see candidates regardless of recall
  // visibility, because the inbox state and the duplicate-prevention
  // contract are orthogonal concerns.
  let items: Memory[]
  try {
    const result = await memories.list({
      projectId: queryProjectId,
      session: scope === "session" ? session : undefined,
      source: "conversation",
      kind: "note",
      confidence: "likely",
      limit: opts.limit ?? 50,
      includeContent: true,
      includeUnscoped: scope === "project" ? true : undefined,
      includeProposed: true,
    })
    items = result.items
  } catch (err) {
    opts.onError?.(err)
    throw new AutosaveLearningDuplicateProbeError(
      "Autosave learning duplicate probe failed; refusing to create a possible duplicate.",
      err
    )
  }

  const textThreshold = opts.threshold ?? AUTOSAVE_LEARNING_TEXT_DUPLICATE_THRESHOLD
  const matches: AutosaveLearningDuplicateMatch[] = []
  for (const mem of items) {
    // Defense in depth: the server-side list filter above should already
    // narrow to this triple. Keeping the client-side guard means a future
    // list-filter regression cannot turn synopsis rows into blocking matches.
    if (
      mem.source !== "conversation" ||
      mem.kind !== "note" ||
      mem.confidence !== "likely"
    ) {
      continue
    }
    // Exclude resurfaced cleanup-orphans. Even though the
    // autosave-learning probe's blocking contract is stronger than the
    // advisory near-dup probe, an empty-body orphan resurrected from
    // Notion's trash must NOT be returned as the reuse target — the
    // caller would write a fresh row's content as a duplicate of an
    // empty shell.
    if (mem.keywords.includes(MEMORY_CLEANUP_ORPHAN_SENTINEL)) continue
    // Project-scoped autosave dedup intentionally accepts legacy unscoped
    // learning rows. Once a row has explicit project relations, though, it
    // must match the full requested project set before it can block a write.
    if (
      scope === "project" &&
      mem.projectIds.length > 0 &&
      !projectSetsEqual(mem.projectIds, requestedProjectIds)
    ) {
      continue
    }
    const titleSimilarity = trigramJaccard(opts.title, mem.title)
    const contentSimilarity = learningContentSimilarity(opts.content, mem.content)
    const combinedSimilarity = learningCombinedSimilarity(
      opts.title,
      opts.content,
      mem.title,
      mem.content
    )
    const tokenSimilarity = learningTokenSimilarity(
      opts.title,
      opts.content,
      mem.title,
      mem.content
    )

    const duplicate =
      combinedSimilarity >= textThreshold ||
      contentSimilarity >= textThreshold ||
      tokenSimilarity >= AUTOSAVE_LEARNING_TOKEN_DUPLICATE_THRESHOLD
    if (!duplicate) continue

    matches.push({
      id: mem.id,
      title: mem.title,
      titleSimilarity,
      tagOverlap: 0,
      decidedAt: mem.decidedAt,
      status: mem.status,
      memory: mem,
      projectIds: mem.projectIds,
      session: mem.session,
      contentSimilarity,
      combinedSimilarity,
      tokenSimilarity,
    })
  }

  matches.sort((a, b) => {
    const aBest = Math.max(
      a.titleSimilarity,
      a.contentSimilarity,
      a.combinedSimilarity,
      a.tokenSimilarity
    )
    const bBest = Math.max(
      b.titleSimilarity,
      b.contentSimilarity,
      b.combinedSimilarity,
      b.tokenSimilarity
    )
    return bBest - aBest
  })
  return matches[0] ?? null
}

/**
 * Minimal interface the task duplicate probe needs from `TaskService`.
 * Keeping it narrow (mirroring `MemoryLister` above) lets tests pass a
 * plain object without constructing a full service, and documents the
 * exact query shape the probe depends on so future `list()` signature
 * changes don't silently break it.
 */
export interface TaskLister {
  list(opts: {
    projectId?: string
    entities?: string[]
    states?: TaskState[]
    limit?: number
    sortBy?: "reviewByAsc" | "updatedAtAsc" | "updatedAtDesc"
  }): Promise<{ items: TaskSummary[]; nextCursor?: string }>
}

export interface FindDuplicateActiveTasksOpts {
  /**
   * Entity string to probe for. Matched against the `Entity` rich_text
   * column server-side via `contains` — exact substring, not fuzzy.
   * Empty / whitespace-only short-circuits the probe.
   */
  entity: string
  /**
   * Project to scope the candidate pool. Optional — the underlying
   * `TaskService.list` honors `projectOrUnscopedFilter`, so an
   * unscoped probe is well-defined (it surfaces vault-wide active
   * tasks on the entity). The wire-in passes the create's resolved
   * project so cross-project work doesn't generate cross-project
   * duplicate warnings.
   */
  projectId?: string
  /**
   * Optional observer for list-query failures. Routed through
   * `debugLogPartialFailures` at the tool layer so probe failures
   * surface under `LORE_DEBUG=1` without adding noise to the default
   * stderr stream — same convention the memory / decision probes use.
   */
  onError?: (err: unknown) => void
}

/**
 * Probe for active tasks in the same project whose `Entity` column
 * contains the given string. Sibling of `findNearDuplicates` for the
 * `lore-task action='create'` path. Returns `[]` on failure, never
 * throws — probe failures must not block the create.
 *
 * **Sequenced before create.** The `lore-task
 * action='create'` wire-in awaits this probe BEFORE dispatching
 * `services.tasks.create`, so the entity-matched candidate pool is
 * available to `findExactReuseTarget` for the assertive-reuse short-
 * circuit. The helper powers two consumers (assertive reuse +
 * advisory close-CTA footer) and the call site sequences them.
 *
 * **Encoded-input handling.** `entity` is decoded with
 * `decodeTextEntities` before going onto the wire, matching
 * `TaskService.create`'s `decodeTextEntities(input.entity ?? input.subject)`
 * write-side decode. Without this, a caller
 * passing `entity: "PR &amp; Review"` would query Notion for the encoded
 * form and miss any stored row whose `Entity` column was decoded at
 * write time — re-introducing the silent-miss case the decode
 * boundary was designed to close, exactly the failure mode reuse
 * is supposed to prevent.
 *
 * **Sort order.** Pinned to `updatedAtDesc` so the first candidate is
 * the most-recently-edited row. `findExactReuseTarget` returns the
 * first matching candidate, so this sort is what makes the predicate's
 * "most-recently-edited wins on ties" contract real.
 *
 * **No just-created-row exclusion** is applied inside this helper.
 * Under the sequence-before-create posture the
 * just-created id literally cannot appear (probe completes strictly
 * before create dispatches). The helper performs no exclusion of
 * its own.
 *
 * Honors `LORE_DISABLE_NEAR_DUPLICATE_PROBE=1` for parity with the
 * memory / decision probes — one operator switch, every duplicate
 * probe respects it. The narrower `LORE_DISABLE_TASK_REUSE=1` switch
 * (read inside `findExactReuseTarget`) keeps the probe alive but
 * disables only the assertive-reuse promotion.
 */
export async function findDuplicateActiveTasks(
  tasks: TaskLister,
  opts: FindDuplicateActiveTasksOpts
): Promise<TaskSummary[]> {
  if (process.env["LORE_DISABLE_NEAR_DUPLICATE_PROBE"] === "1") return []
  if (!opts.entity || opts.entity.trim() === "") return []

  // Decode at the boundary so the server-side `Entity contains` filter
  // sees the same canonical form `TaskService.create` writes via its
  // write-boundary entity decode. Whitespace-only after decode
  // short-circuits — same posture as the raw-input guard above.
  const decodedEntity = decodeTextEntities(opts.entity)
  if (decodedEntity.trim() === "") return []

  try {
    const { items } = await tasks.list({
      projectId: opts.projectId,
      entities: [decodedEntity],
      states: ACTIVE_TASK_STATES,
      limit: 10,
      sortBy: "updatedAtDesc",
    })
    return items
  } catch (err) {
    opts.onError?.(err)
    return []
  }
}

export interface FindExactReuseTargetInput {
  /**
   * Caller's requested `subject`. Compared against each candidate's
   * `title` after normalization (HTML-entity decode, NFKC fold,
   * locale-independent lowercase, internal-whitespace collapse).
   * Whitespace-only inputs short-circuit to no match — a degenerate
   * subject must not silently reuse an unrelated row whose title also
   * normalizes to empty.
   */
  subject: string
  /**
   * Caller's `entity` value (post-default — i.e. `args.entity ?? args.subject`).
   * Required as part of the structural-match key because two tasks
   * sharing a title but tracking different entities are NOT the same
   * task. The probe pre-filters server-side on `Entity contains entity`,
   * which lets a candidate slip in whose entity is a SUPERSTRING of the
   * input (e.g. probe entity `"PR-1"` matches stored entity `"PR-100"`);
   * the post-fetch normalized-equality check here closes that gap.
   */
  entity: string
  /**
   * Resolved project ids for the create. Compared set-equal against
   * each candidate's `projectIds` — same posture as topic-key upsert
   * (`MemoryService.upsertByTopicKey`). `[]` (repo-wide tasks) only
   * matches another `[]` candidate; cross-scope reuse is intentionally
   * rejected so an `[A]` task does not get reused for an `[A, B]`
   * create.
   */
  projectIds: string[]
}

/**
 * Pure reuse predicate over a `findDuplicateActiveTasks` result. Returns
 * the first candidate whose `(entity, title, projectIds)` normalize
 * identically to the caller's `(entity, subject, projectIds)` — the
 * structural-duplicate case where creating a fresh row would produce
 * pollution rather than signal.
 *
 * Sibling of (and assertive promotion over) `findDuplicateActiveTasks`'s
 * advisory-only behavior: that helper says "here are tasks tracking the
 * same entity, you decide"; this helper says "here is the SAME task,
 * reuse it." The caller (`lore-task action='create'`) wires the two
 * together — exact match short-circuits to reuse, the residual probe
 * results render as the existing advisory close-CTA footer.
 *
 * Pure function over the probe result — no I/O. The reuse switch lives
 * here so all callers (current MCP wire-in plus any future CLI / hook
 * surfaces) honor it without duplicate plumbing. `findDuplicateActiveTasks`
 * already honors `LORE_DISABLE_NEAR_DUPLICATE_PROBE=1` (returns `[]`,
 * making this helper a no-op via empty input); the narrower
 * `LORE_DISABLE_TASK_REUSE=1` switch keeps the advisory probe enabled
 * and disables only the assertive promotion. Same single-axis posture
 * as `LORE_DISABLE_TASK_CROSSREF` vs the broader probe switch.
 *
 * Returns `null` when no candidate matches or when reuse is disabled.
 * The probe result's order is fixed by `findDuplicateActiveTasks` to
 * `updatedAtDesc` so the first matching candidate is the most-recently-
 * edited row — the recency tiebreak agents see across every other
 * surface.
 */
export function findExactReuseTarget(
  candidates: TaskSummary[],
  input: FindExactReuseTargetInput
): TaskSummary | null {
  if (process.env["LORE_DISABLE_TASK_REUSE"] === "1") return null

  const normalizedSubject = normalizeReuseKey(input.subject)
  if (normalizedSubject === "") return null
  const normalizedEntity = normalizeReuseKey(input.entity)
  if (normalizedEntity === "") return null

  for (const candidate of candidates) {
    if (normalizeReuseKey(candidate.title) !== normalizedSubject) continue
    if (normalizeReuseKey(candidate.entity) !== normalizedEntity) continue
    if (!projectSetEqual(candidate.projectIds, input.projectIds)) continue
    return candidate
  }
  return null
}

/**
 * Normalize a string for structural reuse comparison: HTML-entity
 * decode, NFKC unicode fold, locale-independent lowercase, internal-
 * whitespace collapse, trim. Match-key only — never written back to
 * Notion.
 *
 * Pipeline parity with `similarity.ts:normalizeTitle`'s decode-then-
 * fold-fold-trim shape so reuse keys agree with the trigram probe's
 * canonical form. Three deliberate divergences:
 *
 * - **`decodeTextEntities` is load-bearing.** `TaskService.create`
 *   decodes `subject` and `entity` at the write boundary, so a stored
 *   row's title is the decoded form. Without the decode here, a
 *   caller passing the already-decoded subject `"Café & Bar"` against
 *   a stored title `"Café &amp; Bar"` (un-migrated vault) would
 *   normalize differently and miss reuse — exactly the silent-miss
 *   `lore migrate --fix-memory-encoding` was designed to close. The
 *   same decode discipline is load-bearing for the trigram pipeline;
 *   the same logic applies to the exact-equality predicate.
 *
 * - **`.toLowerCase()` not `.toLocaleLowerCase()`.** Vault state is
 *   shared across engineers; comparison is per-process. A Turkish-
 *   locale machine's `"INVOICE".toLocaleLowerCase()` is `"ınvoice"`
 *   (dotless-ı), an en-US machine's is `"invoice"` — two engineers
 *   reaching different reuse verdicts on the same vault is a
 *   consistency hazard the rest of the codebase avoids by sticking
 *   to locale-independent `.toLowerCase()`.
 *
 * - **NFKC, not NFC.** `similarity.ts:normalizeTitle` uses NFC.
 *   NFKC additionally folds compatibility variants (`＃` → `#`, `ﬁ`
 *   → `fi`, full-width digits, etc.). For an exact-equality predicate
 *   the more aggressive folding is the safer choice — two tasks whose
 *   titles differ only by full-width vs ASCII punctuation are
 *   structurally the same task, and NFC would let the duplicate land.
 *   The looser fold is intentional and tested
 *   (`near-duplicate.test.ts: "normalizes case, NFKC, and internal
 *   whitespace before equality"`); a future contributor "harmonizing
 *   the normalizers" by switching this to NFC would silently weaken
 *   reuse on full-width / ligature inputs.
 *
 * Trigram-specific punct stripping is deliberately omitted — exact
 * equality, not fuzzy similarity.
 */
function normalizeReuseKey(s: string): string {
  return decodeTextEntities(s)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Set-equality check over project-id arrays. `[]` matches only `[]`.
 * Matches the rule `MemoryService.upsertByTopicKey` enforces via
 * `findByTopicKey` — `[A]` does not match `[A, B]`.
 */
function projectSetEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  for (const id of b) {
    if (!set.has(id)) return false
  }
  return true
}

/**
 * Maximum entity candidates extracted per memory. Notion's filter `OR`
 * has a practical ceiling on branches, so we cap well under it. The
 * iteration order of `extractEntityCandidates` is high-precision-first
 * (PR / issue / Jira / URL before the broader capitalized-phrase
 * pattern) so cap-induced truncation drops the noisiest candidates,
 * not the precise ones.
 */
const ENTITY_CANDIDATE_LIMIT = 5

/**
 * Per-pattern raw match cap, applied before the global
 * `ENTITY_CANDIDATE_LIMIT`. **Counts iteration attempts, not unique
 * additions** — a pattern that matches the same literal 100 times in
 * the input pays the scan cost of 100 matches; the cap is the bound
 * on that scan work, not on Set growth. (A pre-add `sizeBefore` /
 * `sizeAfter` accounting would let a pathological-but-realistic input
 * — same entity-id repeated 50 times in keywords — keep the loop
 * running indefinitely under one pattern, blocking later patterns.)
 *
 * Without this cap, a memory whose body shovels dozens of capitalized-
 * phrase tokens into the title (rare, but has happened on an internal
 * vault for incident memories that paste log lines into the title)
 * would saturate the high-precision slots with one pattern's matches
 * before the others get a turn. Five-per-pattern leaves headroom for
 * the global cap to remain the binding constraint.
 */
const PER_PATTERN_MATCH_CAP = 5

/**
 * URL pattern. Requires at least one alphanumeric immediately after
 * `://` so a bare-scheme stub like `https://` (which appears in prose
 * as `Just https://.`) doesn't match — `Entity contains "https://"`
 * would substring-hit every URL-bearing task entity in the vault and
 * burn a cap-5 slot. The post-process step further strips trailing
 * `.,;:!?)\]}>'"` punct picked up by the greedy `\S*` tail.
 */
const URL_PATTERN = /https?:\/\/[a-zA-Z0-9][^\s]*/g

/** Trailing-punct stripper for URL matches — see `extractEntityCandidates`. */
const URL_TRAILING_PUNCT = /[.,;:!?)\]}>'"]+$/

/**
 * Capitalized-phrase patterns are split into two so the greedy
 * multi-word match doesn't eat a 1-word identifier that happens to
 * follow a stoplisted verb. Concrete case: `"Investigated PR1234
 * fanout"` — a single greedy `(?:\s+[A-Z]…){0,2}` match consumes
 * `"Investigated PR1234"` as a 2-word phrase; the stoplist rejects
 * the lead, and `PR1234` never gets a chance to match alone. Two
 * patterns iterated independently let `PR1234` land via the
 * single-word branch even when the multi-word branch rejected its
 * containing phrase.
 */
const CAPITALIZED_MULTIWORD_PATTERN =
  /\b[A-Z][a-zA-Z0-9]*(?:\s+[A-Z][a-zA-Z0-9]*){1,2}\b/g

const CAPITALIZED_SINGLE_PATTERN = /\b[A-Z][a-zA-Z0-9]*\b/g

/**
 * Patterns matching common entity shapes that show up in tracked work.
 * Iteration order is load-bearing for the cap-induced-truncation rule:
 * high-precision (PR / issue / Jira / URL) first; the broad capitalized-
 * phrase tokenizers last (multi-word before single-word so multi-word
 * candidates get the higher-priority slots when budget is tight). The
 * Set-of-strings dedup that `extractEntityCandidates` runs collapses
 * pattern overlap (e.g. `PR-1234` and the bare `1234` substring both
 * appear).
 *
 * `[A-Z]{2,}-\d+` minimum-two-uppercase-letters narrows Jira-style to
 * the realistic shape (`SENTRY-1234`, `IOS-25`, `PR-1234`). A bare
 * `[A-Z]+-\d+` would happily eat `A-1` or `T-3` from the body, which
 * never carries a real task subject.
 *
 * The two capitalized-phrase patterns produce high noise — both go
 * through `isMeaningfulCapitalizedMatch` post-filtering below to drop
 * verb leads ("Merged", "Fixed", "Found"...) and generic single
 * capitalized words ("Widget", "Bug", "API").
 */
const ENTITY_CANDIDATE_PATTERNS: RegExp[] = [
  /\bPR\s*#\d+\b/g,
  /\bPR-\d+\b/g,
  /(?<![\w#])#\d+\b/g,
  /\b[A-Z]{2,}-\d+\b/g,
  URL_PATTERN,
  CAPITALIZED_MULTIWORD_PATTERN,
  CAPITALIZED_SINGLE_PATTERN,
]

/**
 * Common verb / preposition / article words that begin English title
 * prose. Filtered out as the leading word of a capitalized-phrase
 * match — `Entity contains "Merged PR"` matches no real task entity
 * and would burn a cap-5 slot. This is the closure-nudge tripod's
 * load-bearing relevance gate; if a future contributor "consolidates"
 * the list down, agents will start ignoring the cross-ref footer
 * because it surfaces unrelated tasks under common save verbs.
 *
 * Curated from a pass over realistic save titles on an internal vault.
 * Add to this set when a new noisy verb / connector shows up; do not
 * remove without a matching empirical justification.
 */
const TITLE_LEAD_STOPLIST = new Set([
  // Past-tense verb leads (state changes that show up at the start
  // of memory titles documenting completed work)
  "Saved",
  "Merged",
  "Closed",
  "Resolved",
  "Fixed",
  "Found",
  "Added",
  "Removed",
  "Updated",
  "Created",
  "Deleted",
  "Shipped",
  "Started",
  "Stopped",
  "Continued",
  "Reviewing",
  "Decided",
  "Discussed",
  "Discovered",
  "Implemented",
  "Refactored",
  "Migrated",
  "Tested",
  "Investigated",
  "Wrote",
  "Got",
  // Bare-imperative verb leads (the same actions written in
  // imperative form — common shape in vault titles like
  // "Fix the Outlook bug" or "Add OAuth login"). Without these,
  // multi-word matches like "Fix Outlook Mail" / "Add OAuth" /
  // "Land PR" land as cap-5-slot-burning noise. Pair with the
  // past-tense entries 1:1; future contributors adding a new
  // past-tense lead should add the imperative form too.
  "Fix",
  "Add",
  "Build",
  "Land",
  "Ship",
  "Resolve",
  "Refactor",
  "Test",
  "Investigate",
  "Discover",
  "Discuss",
  "Implement",
  "Migrate",
  "Continue",
  "Stop",
  "Review",
  "Decide",
  "Update",
  "Remove",
  "Create",
  "Delete",
  "Save",
  "Close",
  "Merge",
  "Start",
  // Connectors / common single-word leads
  "Use",
  "See",
  "About",
  "From",
  "After",
  "Before",
  // Notes / status-leading words
  "Notes",
  "Note",
  // Articles / determiners
  "The",
  "A",
  "An",
  // Generic 1-word capitalized nouns that match too many task entities
  "Bug",
  "Issue",
  "Problem",
  "Error",
  "Mail",
  "API",
  "PR",
])

/**
 * Predicate for the broad capitalized-phrase pattern. Multi-word
 * matches always pass — phrases of 2-3 capitalized words are
 * specific enough to be useful (`Outlook Mail App`, `OAuth Flow`).
 *
 * 1-word matches additionally must:
 * - have length >= 4 (rejects `PR`, `A`, `IO`, `OK`)
 * - either contain mixed-case after the first letter (`AuthService`,
 *   `OAuth`) OR contain a digit (`PR1234` lands here when not caught
 *   by the PR pattern).
 *
 * The leading-word stoplist runs over both 1-word and multi-word
 * matches: a phrase starting with `Merged` or `Found` is rejected
 * even if it's 2-3 words ("Merged PR" / "Fixed Bug"). The verb is
 * the noise; the trailing word is the entity but is also captured
 * by other patterns (PR / Jira / standalone capitalized phrase
 * elsewhere in the input).
 */
function isMeaningfulCapitalizedMatch(s: string): boolean {
  const words = s.split(/\s+/)
  if (TITLE_LEAD_STOPLIST.has(words[0])) return false
  if (words.length > 1) return true
  if (s.length < 4) return false
  // 1-word: must be identifier-shaped (mixed case after first letter
  // OR contains a digit). Pure capitalized English words like
  // `Outlook` / `Notion` are rejected — they're brand names that
  // legitimately exist as task entities, but `Entity contains
  // "Outlook"` matches every Outlook-related task in the vault, which
  // is the noise we're filtering out.
  return /[A-Z].*[A-Z]/.test(s) || /\d/.test(s)
}

/**
 * Tokenize a memory's title + keywords + synopsis into entity candidates
 * suitable for an `Entity contains` server-side OR probe.
 *
 * Empty / whitespace-only inputs return `[]`; the caller short-circuits
 * the probe rather than firing a tag-only query that would over-broaden.
 *
 * The match set is order-preserving by pattern priority: a memory that
 * mentions a PR-prefixed entity, a Jira-style id, and "AuthService"
 * yields the candidates in that order.
 * `Set` dedup collapses pattern overlap (a bare numeric substring matches
 * both the PR pattern and the standalone numeric pattern; both are kept
 * because their literal strings differ — `Entity contains "PR-1234"`
 * narrows differently than `Entity contains "1234"`).
 *
 * Capped at `ENTITY_CANDIDATE_LIMIT` total. A memory whose title alone
 * spawns 20+ capitalized-phrase candidates lands the first 5 in
 * priority order; the rest are discarded.
 *
 * Per-pattern post-processing is registered in `PATTERN_POST_PROCESS`
 * — each entry receives `match[0]` and returns either a cleaned
 * candidate string or `null` to drop the match. Currently registered:
 * - **URL**: `URL_TRAILING_PUNCT` strip + bare-scheme rejection
 *   (`https://` alone substring-hits every URL-bearing task entity).
 * - **Capitalized multi-word / single-word**: routed through
 *   `isMeaningfulCapitalizedMatch` for the leading-word stoplist
 *   (`Merged`/`Fix`/`Add`/...) and the 1-word identifier-shape
 *   requirement.
 */
export function extractEntityCandidates(
  title: string,
  keywords: string,
  synopsis: string
): string[] {
  const text = [title, keywords, synopsis].filter((s) => s).join(" ")
  if (text.trim() === "") return []

  const candidates = new Set<string>()
  for (const pattern of ENTITY_CANDIDATE_PATTERNS) {
    const postProcess = PATTERN_POST_PROCESS.get(pattern)
    let perPattern = 0
    for (const match of text.matchAll(pattern)) {
      const raw = match[0]
      // Each pattern can register a post-process step that returns
      // the cleaned value, or `null` to drop the match entirely. A
      // dropped match still counts toward `PER_PATTERN_MATCH_CAP` so
      // a path that produces 5 such no-op matches in a row yields to
      // later patterns rather than scanning further under this one.
      const value = postProcess ? postProcess(raw) : raw
      if (value === null || value === "") {
        perPattern += 1
        if (perPattern >= PER_PATTERN_MATCH_CAP) break
        continue
      }
      candidates.add(value)
      perPattern += 1
      if (candidates.size >= ENTITY_CANDIDATE_LIMIT) {
        return Array.from(candidates)
      }
      if (perPattern >= PER_PATTERN_MATCH_CAP) break
    }
  }
  return Array.from(candidates)
}

/**
 * Per-pattern post-process registry. Each entry receives the raw
 * `match[0]` and returns either the cleaned candidate string or
 * `null` to drop the match. Reference-identity keyed (the loop
 * iterates over `ENTITY_CANDIDATE_PATTERNS` and looks up each
 * pattern in this map) — putting the URL strip and the
 * capitalized-phrase relevance gate into one structure parallels
 * how `CAPITALIZED_FILTERED_PATTERNS` was structured before but
 * lifts both behaviors to a single dispatch shape so a future
 * contributor adding a third post-process can register it without
 * threading another `else if` into `extractEntityCandidates`.
 *
 * Bind via `as const` so reordering `ENTITY_CANDIDATE_PATTERNS`
 * doesn't re-key these entries; each registration uses the same
 * RegExp reference the patterns array does.
 */
const PATTERN_POST_PROCESS = new Map<RegExp, (raw: string) => string | null>([
  [
    URL_PATTERN,
    (raw) => {
      const stripped = raw.replace(URL_TRAILING_PUNCT, "")
      // Bare-scheme defense: the URL regex already requires one
      // alphanumeric after `://`, but if a future regex relaxation
      // re-introduced the bare-scheme case, this guard keeps it out
      // of the candidate set.
      if (stripped === "" || /^https?:\/\/$/.test(stripped)) return null
      return stripped
    },
  ],
  [
    CAPITALIZED_MULTIWORD_PATTERN,
    (raw) => (isMeaningfulCapitalizedMatch(raw) ? raw : null),
  ],
  [CAPITALIZED_SINGLE_PATTERN, (raw) => (isMeaningfulCapitalizedMatch(raw) ? raw : null)],
])

export interface FindRelatedActiveTasksOpts {
  /** Title of the just-saved memory. Primary entity-extraction surface. */
  memoryTitle: string
  /**
   * Free-form keywords on the saved memory. Empty string when the agent
   * didn't supply any. Augments the entity-extraction surface with PR
   * numbers / ticket IDs that might not appear in the title.
   */
  memoryKeywords?: string
  /**
   * Memory synopsis (1–2 sentence gist). Empty string when not populated;
   * the probe still works on title + keywords. The
   * field always exists in `SaveArgs`, but is not guaranteed non-empty.
   */
  memorySynopsis?: string
  /**
   * Project to scope the probe. Optional — `TaskService.list` honors
   * `projectOrUnscopedFilter`, so an unscoped probe is well-defined
   * (vault-wide active tasks on the candidate entities). The wire-in
   * passes the saved memory's resolved project so cross-project tasks
   * don't generate cross-project cross-references.
   */
  projectId?: string
  /**
   * Optional observer for list-query failures. Routed through
   * `debugLogPartialFailures` at the tool layer so probe failures
   * surface under `LORE_DEBUG=1` — same convention the memory /
   * decision probes use.
   */
  onError?: (err: unknown) => void
}

/**
 * Probe for active tasks tracking the same entity as a just-saved
 * memory. Fired in parallel with `lore-memory action='save'` so the
 * response can surface closure CTAs at the resolution moment — a memory
 * titled `Merged PR-1234` cross-references any active task whose
 * `Entity` column contains `PR-1234`.
 *
 * Advisory only: returns `[]` on failure, never throws, must not block
 * the save. No just-saved-row exclusion is needed: tasks and ordinary
 * memories share the Memories DB but the probe's server-side
 * `Kind = task` filter (inside `TaskService.list`) excludes the
 * just-saved memory by kind. The save creates a non-task; the probe
 * surfaces only tasks. Id collision is structurally impossible.
 *
 * Distinct from the near-duplicate / duplicate-task probes:
 * - `findNearDuplicates` matches *similar memories* via title trigrams.
 * - `findDuplicateActiveTasks` matches *the same task entity* via
 *   single-entity `contains`.
 * - `findRelatedActiveTasks` matches *related tasks* via multi-entity
 *   OR-`contains` over the candidate set extracted from the saved
 *   memory.
 *
 * Honors `LORE_DISABLE_TASK_CROSSREF=1` (distinct from the near-dup
 * kill switch). An operator may trust the deterministic substring
 * near-dup probes and distrust the regex-based entity-extraction here
 * (or vice versa); single-axis kill switches are the right shape.
 */
export async function findRelatedActiveTasks(
  services: { tasks: TaskLister },
  opts: FindRelatedActiveTasksOpts
): Promise<TaskSummary[]> {
  if (process.env["LORE_DISABLE_TASK_CROSSREF"] === "1") return []

  // Outer try/catch covers BOTH the synchronous tokenizer
  // (`extractEntityCandidates` runs regex over user-controlled text;
  // a future regex change introducing catastrophic backtracking would
  // throw synchronously) AND the async `services.tasks.list` call.
  // Without this outer wrap, a throw from the tokenizer would reject
  // the returned promise; `Promise.all` in `handleSave` would reject;
  // the user would see a save error even though `memories.create`
  // succeeded. The "save always succeeds; cross-ref is advisory"
  // contract is structurally one wrap-in-try away from being
  // unconditional, so wrap it.
  try {
    const candidateEntities = extractEntityCandidates(
      opts.memoryTitle,
      opts.memoryKeywords ?? "",
      opts.memorySynopsis ?? ""
    )
    if (candidateEntities.length === 0) return []

    const { items } = await services.tasks.list({
      projectId: opts.projectId,
      entities: candidateEntities,
      states: ACTIVE_TASK_STATES,
      limit: 5,
    })
    return items
  } catch (err) {
    opts.onError?.(err)
    return []
  }
}
