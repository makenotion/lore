/**
 * Wake-up data loading — shared by the MCP `lore-wake-up` tool and the
 * shell wake-up hook.
 *
 * When a project has a recently saved digest (source = "digest"), wake-up
 * surfaces that digest as the primary context and trims the raw-memory
 * list underneath it. A digest is a condensed, project-scoped summary and
 * is a denser starting point than N individual memory entries.
 *
 * Wake-up also pulls "related memories": memories that match the entities
 * already surfaced as open loops, via a single relevance-ranked semantic
 * search. Seed phrases come from open-loop fact subjects and objects —
 * signal the user wrote with intent — joined into one query so Notion's
 * vector index scores memory titles AND bodies against the union. This
 * handles the realistic case where facts read like phrases (e.g. "PR
 * #25650 label.applied classifier") that do not appear verbatim in memory
 * titles but are semantically adjacent to the explaining memory.
 */

import type {
  DecisionSummary,
  Fact,
  FactPredicate,
  ListDecisionsOpts,
  Memory,
  MemorySource,
} from "../types.js"
import { TRACKING_PREDICATES } from "../types.js"

export const MS_PER_DAY = 86_400_000

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
 * Notion's hard ceiling on rows returned from a single `list` call. We scale
 * the related-memory fetch window up to this bound so large `relatedLimit`
 * callers aren't silently starved — the service layer (`MemoryService.list`)
 * already clamps here, but stating it at the call site keeps the scaling
 * formula self-documenting.
 */
const NOTION_PAGE_SIZE = 100
/**
 * Default open-loops cap. Matches `NOTION_PAGE_SIZE` so a single bounded
 * Notion page covers the tracking-predicate partition without paginating.
 * Surface callers can dial this lower via `openLoopLimit` to bound prompt
 * size per section independently of the recent-memory cap.
 */
export const DEFAULT_WAKEUP_OPEN_LOOP_LIMIT = NOTION_PAGE_SIZE
/** Upper bound on entity-name seeds passed into the `titleAny` filter. */
const MAX_ENTITY_CANDIDATES = 10
/** Skip entity strings shorter than this — too noisy to match on. */
const MIN_ENTITY_LENGTH = 3

/**
 * Structural contract for the services wake-up needs. Both the real
 * `MemoryService` / `FactService` / `DecisionService` classes and test
 * stubs satisfy this shape.
 */
export interface WakeUpServices {
  memories: {
    list(opts: {
      projectId?: string
      source?: MemorySource
      limit?: number
      includeContent?: boolean
      includeUnscoped?: boolean
      sortBy?: "created_time" | "last_edited_time"
    }): Promise<{ items: Memory[]; nextCursor?: string }>
    search(input: {
      query: string
      projectId?: string
      limit?: number
      includeContent?: boolean
    }): Promise<Memory[]>
  }
  facts: {
    queryBySubject(
      subject: string,
      opts?: { projectId?: string; predicates?: FactPredicate[]; limit?: number },
    ): Promise<Fact[]>
    listRecent(opts: {
      projectId?: string
      excludePredicates?: FactPredicate[]
      limit?: number
    }): Promise<{ items: Fact[]; hasMore: boolean }>
  }
  decisions: {
    list(opts?: ListDecisionsOpts): Promise<{ items: DecisionSummary[]; nextCursor?: string }>
    queryOverdue(opts?: { projectId?: string }): Promise<DecisionSummary[]>
  }
}

export interface WakeUpOptions {
  projectId?: string
  /** Max non-digest memories when no fresh digest exists. */
  memoryLimit?: number
  /** Max non-digest memories when a fresh digest is surfaced. */
  memoryLimitWithDigest?: number
  /** Max age in days for a digest to still count as "fresh". */
  digestFreshnessDays?: number
  /** Max rendered knowledge facts (non-tracking predicates). */
  knowledgeFactLimit?: number
  /**
   * Max open-loop facts fetched from the tracking-predicate partition.
   * Defaults to Notion's per-page ceiling so one bounded page covers the
   * section. Surfaces the per-section knob that P2-01 exposes to callers
   * alongside `knowledgeFactLimit`.
   */
  openLoopLimit?: number
  /** Max related memories. */
  relatedMemoryLimit?: number
  /**
   * When false, fetch recent memories without their markdown body.
   * Used by hook wake-up which only renders title/date. The digest memory
   * is always fetched with content since it IS the content.
   */
  includeMemoryContent?: boolean
  /**
   * When false, skip the proposed + overdue decision queries. The hook
   * wake-up path renders no decision sections, so it has no reason to
   * pay the two Notion round-trips on every session start. Defaults to
   * true so MCP callers (which DO render decisions) keep working.
   */
  includeDecisions?: boolean
  /** Override Date.now() for testing. */
  now?: number
}

export interface WakeUpData {
  /** Fresh project digest, if one exists within the freshness window. */
  digest: Memory | null
  /** Non-digest memories to surface underneath the digest. */
  memories: Memory[]
  /** Facts with tracking predicates (needs_action, waiting_on, blocked_by). */
  openLoops: Fact[]
  /** All other facts, capped at `knowledgeFactLimit`. */
  knowledgeFacts: Fact[]
  /** Proposed decisions awaiting resolution (project-scoped). */
  proposedDecisions: DecisionSummary[]
  /** Active decisions past their review-by date (project-scoped). */
  overdueDecisions: DecisionSummary[]
  /**
   * Memories relevance-matched against the entities surfaced in open loops
   * via one semantic search (Notion's vector index scores both titles and
   * page bodies against the seed query). Deduped against `digest` and
   * `memories` so the same page never renders twice. Empty when there are
   * no open loops to seed from.
   */
  relatedMemories: Memory[]
}

export async function loadWakeUpData(
  services: WakeUpServices,
  opts: WakeUpOptions = {},
): Promise<WakeUpData> {
  const projectId = opts.projectId
  const memoryLimit = opts.memoryLimit ?? DEFAULT_WAKEUP_MEMORY_LIMIT
  const memoryLimitWithDigest =
    opts.memoryLimitWithDigest ?? DEFAULT_WAKEUP_MEMORY_LIMIT_WITH_DIGEST
  const freshnessDays = opts.digestFreshnessDays ?? DEFAULT_DIGEST_FRESHNESS_DAYS
  const knowledgeLimit = opts.knowledgeFactLimit ?? DEFAULT_WAKEUP_KNOWLEDGE_FACT_LIMIT
  // Defense-in-depth clamp. The MCP tool schema rejects
  // `openLoopLimit > 50`, so this branch never fires from the MCP
  // surface today — but `loadWakeUpData` is also consumed by the
  // shell wake-up hook and any future library caller, which bypass
  // Zod validation. Clamping here means no caller can accidentally
  // paginate the tracking-partition query on the hot path.
  const openLoopLimit = Math.min(
    opts.openLoopLimit ?? DEFAULT_WAKEUP_OPEN_LOOP_LIMIT,
    NOTION_PAGE_SIZE,
  )
  const relatedLimit = opts.relatedMemoryLimit ?? DEFAULT_WAKEUP_RELATED_MEMORY_LIMIT
  const includeContent = opts.includeMemoryContent ?? true
  const includeDecisions = opts.includeDecisions ?? true
  const now = opts.now ?? Date.now()

  // Request one extra memory so we can drop a digest entry without running
  // short after filtering.
  //
  // Facts load as two targeted queries, not one full-scan: the old
  // `queryBySubject("")` paginated the whole project and partitioned
  // client-side, which on every hook fire cost 3–6 Notion pages of I/O for
  // a bounded output. Server-side predicate filters collapse that to one
  // page per section.
  const [
    { items: rawMemories },
    { items: latestDigestList },
    openLoops,
    { items: knowledgeFacts },
    { items: proposedDecisions },
    overdueDecisions,
  ] = await Promise.all([
    services.memories.list({
      projectId,
      limit: memoryLimit + 1,
      includeContent,
    }),
    projectId
      ? // Sort by creation so freshness (`createdAt`) aligns with "latest":
        // an edit to an older digest must not mask a newer one.
        services.memories.list({
          projectId,
          source: "digest",
          limit: 1,
          includeUnscoped: false,
          sortBy: "created_time",
        })
      : Promise.resolve({ items: [] as Memory[] }),
    projectId && openLoopLimit > 0
      ? services.facts.queryBySubject("", {
          projectId,
          predicates: TRACKING_PREDICATES,
          limit: openLoopLimit,
        })
      : Promise.resolve([] as Fact[]),
    projectId
      ? services.facts.listRecent({
          projectId,
          excludePredicates: TRACKING_PREDICATES,
          limit: knowledgeLimit,
        })
      : Promise.resolve({ items: [] as Fact[], hasMore: false }),
    projectId && includeDecisions
      ? services.decisions.list({ projectId, status: "proposed", limit: 20 })
      : Promise.resolve({ items: [] as DecisionSummary[] }),
    projectId && includeDecisions
      ? services.decisions.queryOverdue({ projectId })
      : Promise.resolve([] as DecisionSummary[]),
  ])

  const latestDigest = latestDigestList[0] ?? null
  const digest = isFreshDigest(latestDigest, freshnessDays, now) ? latestDigest : null

  const digestCreatedAt = digest ? new Date(digest.createdAt).getTime() : null
  const nonDigestMemories = rawMemories.filter((m) => {
    if (m.source === "digest") return false
    if (digestCreatedAt === null) return true
    return new Date(m.createdAt).getTime() > digestCreatedAt
  })
  const effectiveLimit = digest ? memoryLimitWithDigest : memoryLimit
  const memories = nonDigestMemories.slice(0, effectiveLimit)

  // Related memories: seed from open-loop entities, dedupe against the
  // memories + digest we already plan to render. Skip the round-trip when
  // there are no open loops or no project scope — there's nothing to seed
  // from and wake-up runs every session.
  const alreadySurfaced = new Set<string>()
  if (digest) alreadySurfaced.add(digest.id)
  for (const mem of memories) alreadySurfaced.add(mem.id)

  let relatedMemories: Memory[] = []
  if (projectId && openLoops.length > 0 && relatedLimit > 0) {
    const entities = extractEntities(openLoops)
    if (entities.length > 0) {
      // Scale the candidate pool so dedupe doesn't starve the section: at
      // worst every hit collides with an already-surfaced memory (digest +
      // recents), so `relatedLimit + alreadySurfaced.size` candidates are
      // enough to guarantee `relatedLimit` survivors. Bounded by Notion's
      // per-query row cap.
      const fetchLimit = Math.min(
        NOTION_PAGE_SIZE,
        relatedLimit + alreadySurfaced.size,
      )
      // Join entities into a single relevance query so Notion's vector
      // index scores memory titles AND bodies against the union. This is
      // strictly more permissive than substring title matching — fact
      // subjects like "PR #25650 outlook label.applied classifier" are
      // phrase-shaped, not bare entity names, and only relevance ranking
      // finds the "PR #25650 label.applied classifier: false positives…"
      // memory that explains them.
      const candidates = await services.memories.search({
        query: entities.join(" "),
        projectId,
        limit: fetchLimit,
        includeContent,
      })
      relatedMemories = candidates
        .filter((m) => !alreadySurfaced.has(m.id))
        .slice(0, relatedLimit)
    }
  }

  return {
    digest,
    memories,
    openLoops,
    knowledgeFacts,
    proposedDecisions,
    overdueDecisions,
    relatedMemories,
  }
}

/**
 * Pull deduped entity-name candidates from a set of open-loop facts. Both
 * `subject` and `object` are considered — in a knowledge graph both
 * positions can name real entities (e.g. `autolabel blocked_by OOM_issue`).
 * Case-insensitive dedupe; short fragments dropped as too noisy.
 */
function extractEntities(openLoops: Fact[]): string[] {
  const seen = new Set<string>()
  const entities: string[] = []
  for (const loop of openLoops) {
    for (const raw of [loop.subject, loop.object]) {
      const entity = raw.trim()
      if (entity.length < MIN_ENTITY_LENGTH) continue
      const key = entity.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      entities.push(entity)
      if (entities.length >= MAX_ENTITY_CANDIDATES) return entities
    }
  }
  return entities
}

function isFreshDigest(digest: Memory | null, maxAgeDays: number, now: number): boolean {
  if (!digest) return false
  const ageMs = now - new Date(digest.createdAt).getTime()
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < maxAgeDays * MS_PER_DAY
}

/**
 * Classify an ISO timestamp relative to `now` into a human-readable bucket
 * for wake-up rendering. Shared by the MCP tool and the shell hook so both
 * surfaces group memories identically.
 */
export function dateBucket(
  isoDate: string,
  now: number = Date.now(),
): "Today" | "Yesterday" | "Earlier" {
  const d = isoDate.split("T")[0]
  const today = new Date(now).toISOString().split("T")[0]
  const yesterday = new Date(now - MS_PER_DAY).toISOString().split("T")[0]
  if (d === today) return "Today"
  if (d === yesterday) return "Yesterday"
  return "Earlier"
}
