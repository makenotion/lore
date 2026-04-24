/**
 * Decision operations — first-class decision records backed by the Memories DB.
 *
 * A decision is a Notion page in the Memories database with `Kind = decision`.
 * This service wraps the decision-specific read/write paths: it sets the
 * discriminator on create, exposes index-tier listings that skip markdown-body
 * fetches, and provides supersession and review workflows.
 *
 * The service writes only to the Memories DB — it never creates facts or
 * touches other databases. Graph coordination (auto-creating `decided_by` /
 * `supersedes_decision` facts) happens in the MCP tool layer, consistent with
 * how `lore-remember` orchestrates topics + memories in `src/mcp/tools/memory.ts`.
 */

import type { Client } from "@notionhq/client"
import type {
  PageObjectResponse,
  CreatePageParameters,
  QueryDataSourceParameters,
} from "@notionhq/client"
import type {
  Decision,
  DecisionSummary,
  CreateDecisionInput,
  ListDecisionsOpts,
  DatabaseRef,
} from "../types.js"
import { buildMemoryProps } from "../notion/schema.js"
import { projectOrUnscopedFilter } from "../notion/filters.js"
import { isFullPage } from "../notion/extractors.js"
import { pageToMemory } from "./memory.js"
import { LruCache } from "./cache.js"

/** Days to push `Review By` forward when `reviewCompleted` is called with no explicit date. */
const DEFAULT_REVIEW_EXTENSION_DAYS = 90

/** Decision id → Decision cache. Shorter TTL than the project/topic
 *  name caches because decisions mutate (supersession, review-completion)
 *  more than project metadata. Cap is generous — decisions are numerous
 *  but access patterns are bursty around `lore-wake-up` and
 *  `lore-decision-context`. */
const DECISION_CACHE_TTL_MS = 30_000
const DECISION_CACHE_MAX = 500

export class DecisionService {
  private readonly idCache = new LruCache<string, Decision>(
    DECISION_CACHE_MAX,
    DECISION_CACHE_TTL_MS
  )

  constructor(
    private client: Client,
    private db: DatabaseRef
  ) {}

  async create(input: CreateDecisionInput): Promise<Decision> {
    const decidedAt = input.decidedAt ?? todayISO()
    const status = input.status ?? "accepted"
    const confidence = input.confidence ?? "certain"

    const page = await this.client.pages.create({
      parent: { type: "database_id", database_id: this.db.databaseId },
      properties: buildMemoryProps({
        title: input.decision,
        projectIds: input.projectIds,
        topicId: input.topicId,
        source: "manual",
        kind: "decision",
        status,
        confidence,
        reviewBy: input.reviewBy,
        decidedAt,
        supersedesIds: input.supersedesIds,
        affectsIds: input.affectsIds,
        alternatives: input.alternatives,
        consequences: input.consequences,
        agent: input.agent,
        tags: input.tags,
        session: input.session,
      }),
    })

    if (input.rationale) {
      await this.client.pages.updateMarkdown({
        page_id: page.id,
        type: "insert_content",
        insert_content: { content: input.rationale },
      })
    }

    // The page we just created is guaranteed to have `Kind = decision` because
    // we set it explicitly above — the cast is safe by construction.
    const decision = pageToMemory(
      page as PageObjectResponse,
      input.rationale ?? ""
    ) as Decision
    // A fresh id is unlikely to collide with a cached entry, but a
    // supersede-and-recreate flow in the same session could. Drop
    // anything under this id so getById doesn't serve a ghost.
    this.idCache.delete(decision.id)
    return decision
  }

  async getById(id: string): Promise<Decision> {
    const cached = this.idCache.get(id)
    if (cached) return cached

    const [page, md] = await Promise.all([
      this.client.pages.retrieve({ page_id: id }),
      this.client.pages.retrieveMarkdown({ page_id: id }),
    ])
    const memory = pageToMemory(page as PageObjectResponse, md.markdown)
    if (memory.kind !== "decision") {
      throw new Error(
        `Memory ${id} is not a decision (kind: ${memory.kind}). ` +
          "Use MemoryService for non-decision memories."
      )
    }
    const decision = memory as Decision
    this.idCache.set(id, decision)
    return decision
  }

  /**
   * List decisions matching the given filters. Returns summaries with no
   * markdown body — O(1) Notion API calls regardless of result count. This is
   * the index tier that decision-path tools (`lore-list-decisions`,
   * `lore-wake-up`'s decisions section, `lore-audit`'s overdue decisions)
   * rely on for agent-ingestion performance.
   */
  async list(
    opts?: ListDecisionsOpts
  ): Promise<{ items: DecisionSummary[]; nextCursor?: string }> {
    const filters: Array<Record<string, unknown>> = [
      { property: "Kind", select: { equals: "decision" } },
    ]

    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }
    if (opts?.status) {
      filters.push({ property: "Status", select: { equals: opts.status } })
    }
    if (opts?.reviewBefore) {
      filters.push({
        property: "Review By",
        date: { on_or_before: opts.reviewBefore },
      })
    }
    if (opts?.since) {
      filters.push({
        timestamp: "created_time",
        created_time: { on_or_after: opts.since },
      })
    }
    if (opts?.until) {
      filters.push({
        timestamp: "created_time",
        created_time: { before: opts.until },
      })
    }

    const filter = filters.length > 1 ? { and: filters } : filters[0]

    const response = await this.client.dataSources.query({
      data_source_id: this.db.dataSourceId,
      filter: filter as QueryDataSourceParameters["filter"],
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: Math.min(opts?.limit ?? 20, 100),
      start_cursor: opts?.startCursor,
    })

    const pages = response.results.filter(isFullPage) as PageObjectResponse[]
    const nextCursor =
      response.has_more && response.next_cursor ? response.next_cursor : undefined

    return {
      items: pages.map((page) => toDecisionSummary(pageToMemory(page, "") as Decision)),
      nextCursor,
    }
  }

  /**
   * Mark `oldId` as superseded by `newId`. Atomic-by-ordering: writes the new
   * decision's `Supersedes` relation first, then the old decision's `Status`.
   *
   * If the second write fails, the system is in a "new points at old; old is
   * still accepted" state — visible, re-runnable, and safe. The reverse order
   * (mark old superseded first) would leave the old decision orphaned as
   * superseded with no successor recorded — worse.
   */
  async supersede(newId: string, oldId: string): Promise<void> {
    // Step 1: add oldId to the new decision's Supersedes relation.
    // Preserve any existing supersedesIds so we don't clobber prior
    // entries.
    //
    // Pre-read eviction: `merged` is the writeback base, and a stale
    // cached `supersedesIds` would let us clobber supersessions added
    // elsewhere inside the TTL window.
    this.idCache.delete(newId)
    const newDecision = await this.getById(newId)
    const existing = newDecision.supersedesIds
    const merged = existing.includes(oldId) ? existing : [...existing, oldId]

    await this.client.pages.update({
      page_id: newId,
      properties: {
        Supersedes: { relation: merged.map((id) => ({ id })) },
      } as CreatePageParameters["properties"],
    })
    // Post-write eviction: the Supersedes relation just changed on
    // Notion's side, so any future getById must refetch.
    this.idCache.delete(newId)

    // Step 2: mark the old decision as superseded.
    await this.client.pages.update({
      page_id: oldId,
      properties: {
        Status: { select: { name: "superseded" } },
      } as CreatePageParameters["properties"],
    })
    this.idCache.delete(oldId)
  }

  /**
   * Walk the supersession chain backward from `id`, returning the ordered
   * list `[current, previous, ..., root]`. A visited-set guard terminates
   * if pathological data (e.g., cycles from API errors) would otherwise loop
   * forever. When a decision has multiple `supersedesIds`, the chain follows
   * only the first — callers who need the full DAG can expand branches
   * explicitly.
   */
  async getDecisionChain(id: string): Promise<Decision[]> {
    const chain: Decision[] = []
    const visited = new Set<string>()
    let currentId: string | undefined = id

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId)
      const decision = await this.getById(currentId)
      chain.push(decision)
      currentId = decision.supersedesIds[0]
    }

    return chain
  }

  /**
   * Mark a decision as reviewed. Pushes `Review By` forward — to the given
   * date if provided, otherwise 90 days from today.
   */
  async reviewCompleted(id: string, newReviewBy?: string): Promise<void> {
    const reviewDate = newReviewBy ?? addDaysISO(new Date(), DEFAULT_REVIEW_EXTENSION_DAYS)
    await this.client.pages.update({
      page_id: id,
      properties: {
        "Review By": { date: { start: reviewDate } },
      } as CreatePageParameters["properties"],
    })
    this.idCache.delete(id)
  }

  /**
   * Find decisions that are past their review date and still in an active
   * state (proposed or accepted). Superseded/deprecated/rejected decisions
   * are excluded — they don't need review attention.
   */
  async queryOverdue(opts?: { projectId?: string }): Promise<DecisionSummary[]> {
    const today = todayISO()
    const filters: Array<Record<string, unknown>> = [
      { property: "Kind", select: { equals: "decision" } },
      { property: "Review By", date: { on_or_before: today } },
      {
        or: [
          { property: "Status", select: { equals: "proposed" } },
          { property: "Status", select: { equals: "accepted" } },
        ],
      },
    ]
    if (opts?.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }

    const response = await this.client.dataSources.query({
      data_source_id: this.db.dataSourceId,
      filter: { and: filters } as QueryDataSourceParameters["filter"],
      sorts: [{ property: "Review By", direction: "ascending" }],
    })

    const pages = response.results.filter(isFullPage) as PageObjectResponse[]
    return pages.map((page) => toDecisionSummary(pageToMemory(page, "") as Decision))
  }

  /** Reset the in-process decision cache. Used by tests and by the
   *  cross-service `clearServiceCaches()` helper. */
  clearCache(): void {
    this.idCache.clear()
  }
}

function todayISO(): string {
  return new Date().toISOString().split("T")[0]
}

function addDaysISO(base: Date, days: number): string {
  const next = new Date(base)
  next.setDate(next.getDate() + days)
  return next.toISOString().split("T")[0]
}

function toDecisionSummary(decision: Decision): DecisionSummary {
  // Strip `content` — summaries never carry the markdown body. TS's `Omit`
  // on the type does the static work; this runtime projection matches it.
  const copy: Record<string, unknown> = { ...decision }
  delete copy.content
  return copy as DecisionSummary
}
