/**
 * Task reconciliation — operator-pulled batch pass that surfaces
 * candidate closures across the entire active-task set.
 *
 * Scans every active task, searches recent memories for resolution-
 * shaped matches against the task's entity / title / synopsis, scores
 * the candidates, and returns a ranked list of "these N tasks have
 * memories that look like they resolved them — review and close."
 *
 * Read-only by design. False positives in fuzzy matches would silently
 * destroy real work, so the operator stays in the loop: this surface
 * presents candidates with structured scoring and copy-paste close
 * incantations, never auto-closes. The MCP action's read-only contract
 * is enforced by the handler implementation, not by
 * `readOnlyHint` (the tool registration also serves write actions).
 */

import type { Memory, TaskSummary } from "../types.js"
import { ACTIVE_TASK_STATES, MS_PER_DAY } from "../types.js"
import type { TaskService } from "./task.js"
import type { MemoryService } from "./memory.js"

/**
 * Safety cap on the active-task set scanned per reconcile call. The
 * internal vault's 271 active tasks fit comfortably; vaults with more than
 * 500 active tasks are exactly the population this surface serves and
 * the operator runs reconcile per-project to fit under the cap.
 */
export const MAX_RECONCILE_TASKS = 500

/**
 * Per-task index-tier window. Each surviving task scores against up to
 * this many candidate memories. Five is the sweet spot: large enough
 * to absorb noisy index-tier hits (the post-filter drops task / decision
 * rows), small enough to keep the body-fetch budget at `tasks * 5`
 * `pages.retrieveMarkdown` calls — `271 * 5 = 1355` for an internal vault.
 */
export const RECONCILE_PER_TASK_LIMIT = 5

/**
 * Index-tier over-fetch multiplier. Pulls 4× the post-filter cap so
 * the eligible set still has headroom when the top hits are dominated
 * by task / decision rows (which the post-filter drops). Capped at 20
 * to bound search-response payload. Mirrors the same posture used by
 * `lore-task action='list'` and the wake-up data loader's bucket
 * over-fetch.
 */
export const RECONCILE_INDEX_OVERFETCH = 4
export const RECONCILE_INDEX_CAP = 20

/**
 * Concurrency cap for the per-task search fan-out. The codebase has no
 * concurrency-limiter primitive today (`settleAll` is a partial-failure
 * aggregator over a pre-built `Promise[]`, not a rate-limited fan-out)
 * so reconcile ships its own minimal helper. 8 is the empirical
 * memory/parallelism tradeoff; the rate-limited Notion proxy provides
 * a second backpressure layer underneath.
 */
export const RECONCILE_CONCURRENCY = 8

/**
 * Default minimum score gate. Below this threshold the candidate does
 * not surface in the ranked output. The cue-gate (`cueMatch > 0`) has
 * already filtered the cue-free entity-only candidates by the time the
 * threshold is checked; this knob calibrates how strong the surviving
 * cue + entity + recency combination must be.
 */
export const DEFAULT_RECONCILE_MIN_SCORE = 0.5

/**
 * Default cap on candidate closures surfaced per reconcile call.
 * Capped at `MAX_RECONCILE_LIMIT` (100) — the spec ceiling matches the
 * `lore-task action='list'` per-section cap so an operator who's
 * tuned their triage rhythm to one surface ports it directly to the
 * other.
 */
export const DEFAULT_RECONCILE_LIMIT = 25
export const MAX_RECONCILE_LIMIT = 100

/**
 * Resolution-shaped cues. Hard cues land 1.0 on the cueMatch axis;
 * soft cues land 0.5. Hard-coded list, fixture-pinned. Project-specific
 * verbs ("rolled out", "promoted", "GA'd") are not in the default cue
 * list and a future operator-tuning knob (.lore.yaml
 * `reconcile.cues`) is the next step if real-vault feedback warrants
 * it. Out of scope for the initial reconcile surface.
 */
const HARD_CUE_PATTERN =
  /\b(?:merged|shipped|resolved|fixed|closed|completed|deployed)\b/i
const SOFT_CUE_PATTERN = /\b(?:done|landed|out)\b/i

/**
 * Recency decay window. A memory created within `RECENCY_FULL_DAYS`
 * days scores 1.0 on the recency axis; the bonus decays linearly to 0
 * at `RECENCY_ZERO_DAYS` days. Tunable; weights guess at the rhythm of
 * tracked work that resolves within a fortnight and stays plausibly
 * resolution-shaped through the quarter.
 */
const RECENCY_FULL_DAYS = 14
const RECENCY_ZERO_DAYS = 90

/**
 * Per-axis score weights. The triple sums to 1.0 so the final score
 * lands in `[0, 1]`. `entity` and `cue` carry equal weight so a
 * candidate without one of the two cannot drift past the threshold via
 * recency alone — the cue gate already enforces `cueMatch > 0`, but
 * keeping the weights symmetric pins the intuition. Recency is the
 * tiebreaker.
 */
const WEIGHT_ENTITY = 0.4
const WEIGHT_CUE = 0.4
const WEIGHT_RECENCY = 0.2

/**
 * One scored (task, memory) pair. The task identity is carried
 * separately so the reduce-to-best-per-task step can group on it
 * without re-projecting from the memory.
 */
export interface ReconcileCandidate {
  task: TaskSummary
  memory: Memory
  score: number
  entityMatch: number
  cueMatch: number
  recencyBonus: number
  /** Cue snippet (windowed) used in the rendered output. Empty when no cue matched. */
  cueSnippet: string
}

export interface ReconcileOptions {
  projectId?: string
  minScore?: number
  limit?: number
  /**
   * Caller-supplied "today" anchor in YYYY-MM-DD form, used for the
   * recency-decay calculation. Passing it from the caller lets test
   * fixtures pin a fixed date and lets the action / CLI surfaces share
   * a single anchor. Defaults to `new Date()` when unset.
   */
  today?: string
}

/**
 * Service surface the reconcile pass needs from
 * `LoreServices.tasks` / `LoreServices.memories`. Narrowed to the exact
 * methods consumed so test fixtures can supply plain stubs without
 * constructing the full services. Mirrors the `MemoryLister` / `TaskLister`
 * shape.
 */
export interface ReconcileServices {
  tasks: Pick<TaskService, "list">
  memories: Pick<MemoryService, "search" | "materializeContent">
}

/**
 * Run reconcile against the active-task set and return the ranked
 * candidate closures. Read-only — issues no write-shaped Notion calls.
 *
 * Pipeline:
 *
 * 1. Cursor-paginate `tasks.list` over `ACTIVE_TASK_STATES` until the
 *    cap (500) or `nextCursor` is undefined.
 * 2. For each active task, fan out (concurrency 8) an index-tier
 *    `memories.search({ mode: "hybrid", includeContent: false })` over
 *    a query composed of `task.title + task.entity + task.synopsis`.
 * 3. Drop self-references (task / decision rows) and slice to
 *    `RECONCILE_PER_TASK_LIMIT`. Hydrate bodies for the survivors via
 *    `MemoryService.materializeContent` — failures degrade to empty
 *    content via `.catch`.
 * 4. Cue-gate: drop pairs with no resolution-shaped cue BEFORE
 *    scoring (the false-positive guard).
 * 5. Score the survivors: `entity * 0.4 + cue * 0.4 + recency * 0.2`.
 * 6. Threshold-filter (`< minScore` drops out).
 * 7. Reduce to best memory per task; tie-break on `memory.createdAt`.
 * 8. Sort globally by score descending, tie-break on `memory.createdAt`,
 *    cap at `limit`.
 */
export async function reconcileActiveTasks(
  services: ReconcileServices,
  options: ReconcileOptions = {}
): Promise<{ candidates: ReconcileCandidate[]; activeTasksScanned: number }> {
  const minScore = options.minScore ?? DEFAULT_RECONCILE_MIN_SCORE
  const limit = Math.min(options.limit ?? DEFAULT_RECONCILE_LIMIT, MAX_RECONCILE_LIMIT)
  const today = options.today ?? new Date().toISOString().split("T")[0]!
  const projectId = options.projectId

  // Step 1 — paginate active tasks.
  const activeTasks = await fetchActiveTasks(services.tasks, projectId)

  if (activeTasks.length === 0) {
    return { candidates: [], activeTasksScanned: 0 }
  }

  // Steps 2–4 — per-task search + post-filter + hydrate + cue-gate +
  // score. Concurrency-bounded so a 271-task vault doesn't fan out 271
  // hybrid searches simultaneously.
  const fetchLimit = Math.min(
    RECONCILE_PER_TASK_LIMIT * RECONCILE_INDEX_OVERFETCH,
    RECONCILE_INDEX_CAP
  )
  const settled = await mapWithConcurrency(activeTasks, RECONCILE_CONCURRENCY, (task) =>
    scoreTaskCandidates(services.memories, task, {
      projectId,
      fetchLimit,
      today,
    })
  )

  const surviving: ReconcileCandidate[] = []
  for (const result of settled) {
    if (result.status === "fulfilled") {
      surviving.push(...result.value)
    }
    // Rejected: the per-task probe failed end-to-end. Mirror the
    // `findDuplicateActiveTasks` posture — advisory probes never throw
    // at the orchestrator level. Reconcile is operator-pulled, so a
    // single task's failure shouldn't tank the whole pass.
  }

  // Step 6 — threshold filter.
  const aboveThreshold = surviving.filter((c) => c.score >= minScore)

  // Step 7 — reduce to best memory per task. Tie-break on
  // `memory.createdAt` (more recent wins). Reduce happens BEFORE the
  // global sort/limit so the ranked output never shows two rows
  // recommending the same close incantation.
  const bestPerTask = new Map<string, ReconcileCandidate>()
  for (const c of aboveThreshold) {
    const prior = bestPerTask.get(c.task.id)
    if (
      !prior ||
      c.score > prior.score ||
      (c.score === prior.score &&
        new Date(c.memory.createdAt) > new Date(prior.memory.createdAt))
    ) {
      bestPerTask.set(c.task.id, c)
    }
  }

  // Step 8 — global sort + cap.
  const ranked = [...bestPerTask.values()]
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      return (
        new Date(b.memory.createdAt).getTime() - new Date(a.memory.createdAt).getTime()
      )
    })
    .slice(0, limit)

  return { candidates: ranked, activeTasksScanned: activeTasks.length }
}

/**
 * Cursor-paginate the active-task set up to the safety cap. Vaults
 * with `< 100` active tasks fire one query and return; the loop costs
 * nothing extra in the common case.
 */
async function fetchActiveTasks(
  tasks: Pick<TaskService, "list">,
  projectId: string | undefined
): Promise<TaskSummary[]> {
  const collected: TaskSummary[] = []
  let cursor: string | undefined = undefined
  do {
    const page = await tasks.list({
      projectId,
      states: ACTIVE_TASK_STATES,
      limit: 100,
      startCursor: cursor,
    })
    collected.push(...page.items)
    cursor = page.nextCursor
  } while (cursor && collected.length < MAX_RECONCILE_TASKS)
  return collected.slice(0, MAX_RECONCILE_TASKS)
}

/**
 * Run the per-task probe: index-tier search → post-filter → hydrate
 * → score. Returns every (task, memory) candidate that passes the
 * cue-gate; the threshold filter and per-task reduce step run at the
 * orchestrator level.
 */
async function scoreTaskCandidates(
  memories: Pick<MemoryService, "search" | "materializeContent">,
  task: TaskSummary,
  opts: { projectId: string | undefined; fetchLimit: number; today: string }
): Promise<ReconcileCandidate[]> {
  const query = composeReconcileQuery(task)
  if (query === "") return []

  // Pass 1 — index-tier (no body fetch). One `dataSources.query` per
  // task at page_size 20 (under hybrid's contains leg). Returns
  // identities + properties only.
  const candidates = await memories.search({
    query,
    projectId: opts.projectId,
    limit: opts.fetchLimit,
    mode: "hybrid",
    includeContent: false,
  })

  // Drop self-references (task rows) and decisions before scoring.
  // Reconcile scans tasks AGAINST memories; matching task rows would
  // create self-referential loops, and decisions have their own
  // reconciliation surface. The 4× over-fetch
  // is best-effort headroom — if the top-20 hits are all task /
  // decision rows for some task, the eligible set is smaller than
  // RECONCILE_PER_TASK_LIMIT and that task scores against fewer (or
  // zero) candidates.
  const eligible = candidates
    .filter((m) => m.kind !== "task" && m.kind !== "decision")
    .filter((m) => m.id !== task.id)
    .slice(0, RECONCILE_PER_TASK_LIMIT)

  if (eligible.length === 0) return []

  // Pass 2 — hydrate bodies for ONLY the eligible window. On failure
  // (transient 5xx, archived page) the helper propagates; the caller's
  // `.catch` returns the row with empty content. The pair then has no
  // body to scan, gets `cueMatch = 0`, and is filtered out by the
  // cue-gate below (no body, no cue match, no closure candidate).
  const hydrated = await Promise.all(
    eligible.map((m) =>
      memories.materializeContent(m).catch(() => ({ ...m, content: "" }))
    )
  )

  const todayMs = new Date(opts.today).getTime()
  const scored: ReconcileCandidate[] = []
  for (const memory of hydrated) {
    const candidate = scoreCandidate(task, memory, todayMs)
    // Cue-gate (step 3 in the spec): drop pairs with no resolution-
    // shaped cue BEFORE the threshold filter. A pure entity mention
    // ("blocking on the auth PR because X") is not a resolution
    // candidate regardless of recency.
    if (candidate.cueMatch === 0) continue
    scored.push(candidate)
  }

  return scored
}

/**
 * Compose the search query from the task's title + entity + synopsis.
 * Empty parts skip cleanly so vaults whose synopsis column is empty
 * degrade to entity + title matching.
 */
export function composeReconcileQuery(
  task: Pick<TaskSummary, "title" | "entity" | "synopsis">
): string {
  const parts: string[] = []
  for (const piece of [task.title, task.entity, task.synopsis]) {
    const trimmed = piece?.trim()
    if (trimmed) parts.push(trimmed)
  }
  // Dedupe consecutive identicals so an entity-defaults-to-title row
  // doesn't blow the query into "Foo Foo".
  const deduped: string[] = []
  for (const p of parts) {
    if (deduped[deduped.length - 1] !== p) deduped.push(p)
  }
  return deduped.join(" ")
}

/**
 * Score a single (task, memory) pair. Pure function — deterministic in
 * `task`, `memory`, and `todayMs`, no I/O. Exported for unit testing.
 */
export function scoreCandidate(
  task: TaskSummary,
  memory: Memory,
  todayMs: number
): ReconcileCandidate {
  const entityMatch = scoreEntityMatch(task, memory)
  const { cueMatch, cueSnippet } = scoreCueMatch(memory)
  const recencyBonus = scoreRecency(memory, todayMs)
  const score =
    entityMatch * WEIGHT_ENTITY + cueMatch * WEIGHT_CUE + recencyBonus * WEIGHT_RECENCY
  return { task, memory, score, entityMatch, cueMatch, recencyBonus, cueSnippet }
}

/**
 * Entity-match axis. Returns 0 unconditionally when the trimmed entity
 * is empty — JavaScript's `string.includes("")` is `true` for every
 * string, so an empty-entity task would otherwise score 1.0 against
 * every candidate. When non-empty, 1.0 if the entity appears in
 * title / synopsis / keywords; 0.5 if in the body only; 0 otherwise.
 */
function scoreEntityMatch(task: TaskSummary, memory: Memory): number {
  const entity = task.entity?.trim()
  if (!entity) return 0
  const needle = entity.toLowerCase()
  const inHeader =
    memory.title.toLowerCase().includes(needle) ||
    memory.synopsis.toLowerCase().includes(needle) ||
    memory.keywords.toLowerCase().includes(needle)
  if (inHeader) return 1.0
  if (memory.content && memory.content.toLowerCase().includes(needle)) return 0.5
  return 0
}

/**
 * Cue-match axis. Hard cues (merged / shipped / resolved / fixed /
 * closed / completed / deployed) score 1.0; soft cues (done / landed /
 * out) score 0.5; no cue scores 0. Returns the matched-cue context
 * window so the renderer can echo it inline.
 */
function scoreCueMatch(memory: Memory): { cueMatch: number; cueSnippet: string } {
  const body = memory.content ?? ""
  if (!body) return { cueMatch: 0, cueSnippet: "" }
  const hard = body.match(HARD_CUE_PATTERN)
  if (hard) return { cueMatch: 1.0, cueSnippet: extractSnippet(body, hard.index ?? 0) }
  const soft = body.match(SOFT_CUE_PATTERN)
  if (soft) return { cueMatch: 0.5, cueSnippet: extractSnippet(body, soft.index ?? 0) }
  return { cueMatch: 0, cueSnippet: "" }
}

/**
 * Pull a windowed snippet around the cue match. The renderer needs
 * enough context for an operator to read "did this memory really
 * resolve the task" without fetching the full body, but trimming to
 * one line keeps the ranked output scannable.
 */
function extractSnippet(body: string, matchIndex: number): string {
  const SNIPPET_RADIUS = 60
  const start = Math.max(0, matchIndex - SNIPPET_RADIUS)
  const end = Math.min(body.length, matchIndex + SNIPPET_RADIUS)
  const slice = body.slice(start, end).replace(/\s+/g, " ").trim()
  const prefix = start > 0 ? "…" : ""
  const suffix = end < body.length ? "…" : ""
  return `${prefix}${slice}${suffix}`
}

/**
 * Recency-bonus axis. 1.0 for memories within `RECENCY_FULL_DAYS`,
 * linear decay to 0 at `RECENCY_ZERO_DAYS`. The window is generous
 * because tracked work resolution moments age non-linearly — a
 * "merged PR" memory two months stale is still load-bearing if the
 * task is open.
 */
function scoreRecency(memory: Memory, todayMs: number): number {
  if (!memory.createdAt) return 0
  const createdMs = new Date(memory.createdAt).getTime()
  if (Number.isNaN(createdMs)) return 0
  const ageDays = Math.max(0, (todayMs - createdMs) / MS_PER_DAY)
  if (ageDays <= RECENCY_FULL_DAYS) return 1.0
  if (ageDays >= RECENCY_ZERO_DAYS) return 0
  // Linear decay between RECENCY_FULL_DAYS and RECENCY_ZERO_DAYS.
  const span = RECENCY_ZERO_DAYS - RECENCY_FULL_DAYS
  const aged = ageDays - RECENCY_FULL_DAYS
  return Math.max(0, 1 - aged / span)
}

/**
 * Bounded-concurrency fan-out. True worker-pool — every worker pulls
 * the next item the moment its current item resolves, so a single slow
 * task does not stall the workers that are already free. A naive
 * chunked variant (`Promise.allSettled` over slices of size `limit` in
 * series) would let one outlier in chunk N gate the whole next chunk;
 * with 271 tasks at concurrency 8 that's 34 chunks, and a 30-second
 * outlier per chunk balloons wall-clock dramatically.
 *
 * Order is preserved: results land at their original index in `items`,
 * not in completion order, so the orchestrator's downstream reduce
 * step (which keys on `task.id`, not list position) is unaffected — but
 * a future caller that does care about positional alignment is safe
 * by construction.
 *
 * The codebase has no concurrency-limiter primitive today (`settleAll`
 * is a partial-failure aggregator over a pre-built `Promise[]`, not a
 * rate-limited fan-out); reconcile ships its own minimal helper. If a
 * future caller wants the same primitive, promote to a shared
 * concurrency module and re-export — at a single use site
 * co-location is the right shape.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return []
  const results: PromiseSettledResult<R>[] = new Array(items.length)
  const workerCount = Math.max(1, Math.min(limit, items.length))
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const i = nextIndex++
      if (i >= items.length) return
      try {
        const value = await fn(items[i]!)
        results[i] = { status: "fulfilled", value }
      } catch (reason) {
        results[i] = { status: "rejected", reason }
      }
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker))
  return results
}

/**
 * Render the ranked candidate list as markdown. Both the MCP action
 * and the CLI sibling consume this so the rendered output is byte-
 * identical across surfaces.
 */
export function formatReconcileOutput(
  candidates: ReconcileCandidate[],
  activeTasksScanned: number,
  today: string
): string {
  const header = `## ${candidates.length} candidate closure${candidates.length === 1 ? "" : "s"} (out of ${activeTasksScanned} active task${activeTasksScanned === 1 ? "" : "s"} scanned)`
  if (candidates.length === 0) return header

  const lines: string[] = [header, ""]
  candidates.forEach((c, idx) => {
    const taskAge = computeTaskAgeDays(c.task, today)
    const memoryAge = computeMemoryAgeDays(c.memory, today)
    const stateLabel = c.task.taskState ?? "open"
    const ageLabel =
      taskAge === null ? "" : `, ${taskAge} day${taskAge === 1 ? "" : "s"} old`
    const memoryDate = c.memory.createdAt ? c.memory.createdAt.split("T")[0] : "?"
    const memoryAgeLabel =
      memoryAge === null
        ? ""
        : memoryAge === 0
          ? "today"
          : `${memoryAge} day${memoryAge === 1 ? "" : "s"} ago`
    // Prefer the relative `(N days ago)` form when we can compute it;
    // fall back to the absolute `YYYY-MM-DD` date when `createdAt`
    // exists but age is unavailable; emit nothing when both are absent.
    const memoryWhenSuffix = memoryAgeLabel
      ? ` (${memoryAgeLabel})`
      : memoryDate !== "?"
        ? ` (${memoryDate})`
        : ""
    lines.push(
      `### ${idx + 1}. Task ${c.task.id} — "${c.task.title}" [${stateLabel}${ageLabel}]`
    )
    lines.push(
      `Best match: memory ${c.memory.id}${memoryWhenSuffix}, score ${c.score.toFixed(2)}`
    )
    if (c.cueSnippet) {
      lines.push(`Cue: "${c.cueSnippet}"`)
    }
    lines.push(`Close: lore-task({ action: 'close', taskId: '${c.task.id}' })`)
    lines.push("")
  })
  // Drop the trailing blank line so the rendered output ends crisply.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines.join("\n")
}

function computeTaskAgeDays(
  task: Pick<TaskSummary, "createdAt">,
  today: string
): number | null {
  if (!task.createdAt) return null
  const createdMs = new Date(task.createdAt).getTime()
  const todayMs = new Date(today).getTime()
  if (Number.isNaN(createdMs) || Number.isNaN(todayMs)) return null
  return Math.max(0, Math.floor((todayMs - createdMs) / MS_PER_DAY))
}

function computeMemoryAgeDays(
  memory: Pick<Memory, "createdAt">,
  today: string
): number | null {
  if (!memory.createdAt) return null
  const createdMs = new Date(memory.createdAt).getTime()
  const todayMs = new Date(today).getTime()
  if (Number.isNaN(createdMs) || Number.isNaN(todayMs)) return null
  return Math.max(0, Math.floor((todayMs - createdMs) / MS_PER_DAY))
}
