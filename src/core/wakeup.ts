/**
 * Wake-up data loading — shared by the MCP `lore-wake-up` tool and the
 * shell wake-up hook.
 *
 * When a project has a recently saved digest (source = "digest"), wake-up
 * surfaces that digest as the primary context and trims the raw-memory
 * list underneath it. A digest is a condensed, project-scoped summary and
 * is a denser starting point than N individual memory entries.
 */

import type { Fact, FactPredicate, Memory, MemorySource } from "../types.js"
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
 * Structural contract for the services wake-up needs. Both the real
 * `MemoryService` / `FactService` classes and test stubs satisfy this shape.
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
    }): Promise<Memory[]>
  }
  facts: {
    queryBySubject(
      subject: string,
      opts?: { projectId?: string; predicates?: FactPredicate[]; limit?: number },
    ): Promise<Fact[]>
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
   * When false, fetch recent memories without their markdown body.
   * Used by hook wake-up which only renders title/date. The digest memory
   * is always fetched with content since it IS the content.
   */
  includeMemoryContent?: boolean
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
  const includeContent = opts.includeMemoryContent ?? true
  const now = opts.now ?? Date.now()

  // Request one extra memory so we can drop a digest entry without running
  // short after filtering.
  const [rawMemories, latestDigestList, facts] = await Promise.all([
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
      : Promise.resolve([]),
    projectId
      ? services.facts.queryBySubject("", { projectId })
      : Promise.resolve([]),
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

  const trackingSet = new Set<string>(TRACKING_PREDICATES)
  const openLoops = facts.filter((f) => trackingSet.has(f.predicate))
  const knowledgeFacts = facts
    .filter((f) => !trackingSet.has(f.predicate))
    .slice(0, knowledgeLimit)

  return { digest, memories, openLoops, knowledgeFacts }
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
