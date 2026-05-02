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
 * Thresholds are initial guesses from the P2-03 spec (0.7 for memories,
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
import { trigramJaccard, tagOverlap } from "./similarity.js"

export interface NearDuplicateMatch {
  id: string
  title: string
  /** Trigram Jaccard over the normalized titles. Range `[0, 1]`. */
  titleSimilarity: number
  /**
   * Jaccard over tag sets. Range `[0, 1]`. `0` when either row has no
   * tags (see `tagOverlap` in `similarity.ts` for the empty-set rule),
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
  }): Promise<{ items: Memory[]; nextCursor?: string }>
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
   * cross-project near-duplicates are a Phase 3/4 concern.
   */
  projectId?: string
  /**
   * Topic filter for decisions (same-topic is part of the P2-03 decision
   * rule). Leave undefined for the memory path.
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
   */
  excludeKinds?: MemoryKind[]
  /**
   * Status whitelist applied client-side after the query. Notion's
   * `dataSources.query` accepts exactly one `Status select equals` clause,
   * so the decision path — which needs `accepted OR proposed` — post-filters
   * here instead of issuing two server queries for one probe.
   */
  statuses?: MemoryStatus[]
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
  opts: FindNearDuplicatesOpts,
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

  let items: Memory[]
  try {
    const result = await memories.list({
      projectId: opts.projectId,
      topicId: opts.topicId,
      tags: topTags.length > 0 ? topTags : undefined,
      kind: opts.kind,
      limit: opts.limit ?? 50,
      includeContent: false,
    })
    items = result.items
  } catch (err) {
    opts.onError?.(err)
    return []
  }

  const excludeKinds = opts.excludeKinds && opts.excludeKinds.length > 0
    ? new Set<MemoryKind>(opts.excludeKinds)
    : null

  const matches: NearDuplicateMatch[] = []
  for (const mem of items) {
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
  /** Project relation on the existing row, for session auto-link bookkeeping. */
  projectIds: string[]
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
  /** Project scope to prefer when one is available. */
  projectId?: string
  /** Hook session id. Required because the gate is session-scoped. */
  session?: string
  /** Similarity threshold for blocking a duplicate create. */
  threshold?: number
  /** Max rows to scan in the candidate pool (default 50). */
  limit?: number
  /** Optional observer for list-query failures. */
  onError?: (err: unknown) => void
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
  contentB: string,
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
  const text = `${title}\n${content}`
    .toLowerCase()
    .replace(/\b([a-z0-9]+)['’]s\b/g, "$1")
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
  contentB: string,
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

/**
 * Blocking duplicate finder for Stop-spawn atomic learnings.
 *
 * The regular `findNearDuplicates` probe is advisory and project-scoped.
 * Autosave learning extraction needs a stronger contract because the same
 * transcript window can be processed more than once. This helper stays
 * session-scoped, reads only likely conversation-sourced notes, and fetches bodies
 * so a duplicate body/combined-text pair returns the existing row instead of letting
 * the write path create another memory.
 */
export async function findAutosaveLearningDuplicate(
  memories: MemoryLister,
  opts: FindAutosaveLearningDuplicateOpts,
): Promise<AutosaveLearningDuplicateMatch | null> {
  if (
    process.env["LORE_DISABLE_AUTOSAVE_LEARNING_DEDUP"] === "1" ||
    process.env["LORE_DISABLE_NEAR_DUPLICATE_PROBE"] === "1"
  ) {
    return null
  }
  const session = opts.session?.trim()
  if (!session) return null
  if (opts.title.trim() === "") return null

  let items: Memory[]
  try {
    const result = await memories.list({
      projectId: opts.projectId,
      session,
      source: "conversation",
      kind: "note",
      confidence: "likely",
      limit: opts.limit ?? 50,
      includeContent: true,
    })
    items = result.items
  } catch (err) {
    opts.onError?.(err)
    return null
  }

  const textThreshold = opts.threshold ?? AUTOSAVE_LEARNING_TEXT_DUPLICATE_THRESHOLD
  const matches: AutosaveLearningDuplicateMatch[] = []
  for (const mem of items) {
    // Defense in depth: the server-side list filter above should already
    // narrow to this triple. Keeping the client-side guard means a future
    // list-filter regression cannot turn synopsis rows into blocking matches.
    if (mem.source !== "conversation" || mem.kind !== "note" || mem.confidence !== "likely") {
      continue
    }
    const titleSimilarity = trigramJaccard(opts.title, mem.title)
    const contentSimilarity = learningContentSimilarity(opts.content, mem.content)
    const combinedSimilarity = learningCombinedSimilarity(
      opts.title,
      opts.content,
      mem.title,
      mem.content,
    )
    const tokenSimilarity = learningTokenSimilarity(
      opts.title,
      opts.content,
      mem.title,
      mem.content,
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
      projectIds: mem.projectIds,
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
      a.tokenSimilarity,
    )
    const bBest = Math.max(
      b.titleSimilarity,
      b.contentSimilarity,
      b.combinedSimilarity,
      b.tokenSimilarity,
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
 * `lore-task action='create'` path. Advisory only — returns `[]` on
 * failure, never throws, must not block the create.
 *
 * Deliberately performs **no exclusion**. The `lore-task action='create'`
 * wire-in fires this probe in parallel with `services.tasks.create`,
 * so at probe-fire time the just-created task's id is not yet known.
 * Exclusion of the just-created row is the caller's responsibility —
 * the post-fetch `t.id !== task.id` filter at the `handleCreate` site,
 * applied after `Promise.all([create, probe])` resolves. Any
 * exclusion logic inside this helper would be a misleading no-op
 * (the id we'd want to exclude doesn't exist when we run).
 *
 * Honors `LORE_DISABLE_NEAR_DUPLICATE_PROBE=1` for parity with the
 * memory / decision probes — one operator switch, every advisory
 * probe respects it.
 */
export async function findDuplicateActiveTasks(
  tasks: TaskLister,
  opts: FindDuplicateActiveTasksOpts,
): Promise<TaskSummary[]> {
  if (process.env["LORE_DISABLE_NEAR_DUPLICATE_PROBE"] === "1") return []
  if (!opts.entity || opts.entity.trim() === "") return []

  try {
    const { items } = await tasks.list({
      projectId: opts.projectId,
      entities: [opts.entity],
      states: ACTIVE_TASK_STATES,
      limit: 10,
    })
    return items
  } catch (err) {
    opts.onError?.(err)
    return []
  }
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
 * — same `PR #25750` repeated 50 times in keywords — keep the loop
 * running indefinitely under one pattern, blocking later patterns.)
 *
 * Without this cap, a memory whose body shovels dozens of capitalized-
 * phrase tokens into the title (rare, but has happened on the Mail
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
 * pattern overlap (e.g. `PR #25750` and the `#25750` substring both
 * appear).
 *
 * `[A-Z]{2,}-\d+` minimum-two-uppercase-letters narrows Jira-style to
 * the realistic shape (`SENTRY-1234`, `IOS-25`, `PR-25750`). A bare
 * `[A-Z]+-\d+` would happily eat `A-1` or `T-3` from the body, which
 * never carries a real task subject.
 *
 * The two capitalized-phrase patterns produce high noise — both go
 * through `isMeaningfulCapitalizedMatch` post-filtering below to drop
 * verb leads ("Merged", "Fixed", "Found"...) and generic single
 * capitalized words ("Mail", "Bug", "API").
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
 * Curated from a pass over realistic save titles on the Mail vault.
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
 * mentions `PR #25750`, `SENTRY-1234`, and "AuthService" yields
 * `["PR #25750", "#25750", "SENTRY-1234", "AuthService"]` in that order.
 * `Set` dedup collapses pattern overlap (the `#25750` substring matches
 * both the PR pattern and the standalone `#N` pattern; both are kept
 * because their literal strings differ — `Entity contains "PR #25750"`
 * narrows differently than `Entity contains "#25750"`).
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
  synopsis: string,
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
  [
    CAPITALIZED_SINGLE_PATTERN,
    (raw) => (isMeaningfulCapitalizedMatch(raw) ? raw : null),
  ],
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
   * the probe still works on title + keywords. Soft dep on #02 — the
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
 * titled "Merged PR #25750" cross-references any active task whose
 * `Entity` column contains "PR #25750".
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
  opts: FindRelatedActiveTasksOpts,
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
      opts.memorySynopsis ?? "",
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
