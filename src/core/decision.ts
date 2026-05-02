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
 * how `lore-memory action='save'` orchestrates topics + memories in
 * `src/mcp/tools/memory.ts`.
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
import { decodeTextEntities } from "../notion/html-entities.js"
import {
  collectLivePages,
  LIVE_PAGE_REFILL_MAX_ROWS,
  warnLivePageCapFired,
} from "../notion/live-pages.js"
import { isFullPage, isLiveFullPage } from "../notion/extractors.js"
import { pageToMemory } from "./memory.js"
import { LruCache } from "./cache.js"

/** Days to push `Review By` forward when `reviewCompleted` is called with no explicit date. */
const DEFAULT_REVIEW_EXTENSION_DAYS = 90

export interface OverdueDecisionWindow {
  items: DecisionSummary[]
  capped: boolean
}

/** Decision id → Decision cache. Shorter TTL than the project/topic
 *  name caches because decisions mutate (supersession, review-completion)
 *  more than project metadata. Cap is generous — decisions are numerous
 *  but access patterns are bursty around `lore-context action='wake-up'`
 *  and `lore-decision action='context'`. */
const DECISION_CACHE_TTL_MS = 30_000
const DECISION_CACHE_MAX = 500

type DecisionStructuralField =
  | "projectIds"
  | "topicId"
  | "status"
  | "confidence"
  | "reviewBy"
  | "decidedAt"
  | "supersedesIds"
  | "affectsIds"
  | "tags"

type RequiredDecisionTextField = "decision" | "rationale"
type DecisionTextField = Exclude<keyof CreateDecisionInput, DecisionStructuralField>
type OptionalDecisionTextField = Exclude<
  DecisionTextField,
  RequiredDecisionTextField
>
type DecodedDecisionTextFields = Record<RequiredDecisionTextField, string> & {
  [K in OptionalDecisionTextField]: string | undefined
}

/**
 * Decode every user-authored text field at the decision write boundary.
 * Doubly-encoded autosave input like `&amp;amp;` lands in Notion as plain
 * text, matching the broader Memory write discipline.
 *
 * Sibling: `decodeMemoryTextFields` in `memory.ts` — keep shared field
 * coverage in lockstep. `rationale` mirrors memory `content`: it
 * normalizes missing/falsy body text to `""` so create can skip the
 * markdown write while returning a string-backed Decision.
 *
 * The decoded field set is derived from `CreateDecisionInput` by excluding
 * structural IDs/selects/dates. Adding any new decision input field must
 * either classify it as structural above or decode it here, so coverage
 * drift fails typecheck instead of silently reaching Notion.
 */
function decodeDecisionTextFields(input: CreateDecisionInput): DecodedDecisionTextFields {
  return {
    decision: decodeTextEntities(input.decision),
    rationale: input.rationale ? decodeTextEntities(input.rationale) : "",
    alternatives:
      input.alternatives !== undefined
        ? decodeTextEntities(input.alternatives)
        : undefined,
    consequences:
      input.consequences !== undefined
        ? decodeTextEntities(input.consequences)
        : undefined,
    author: input.author !== undefined ? decodeTextEntities(input.author) : undefined,
    agent: input.agent !== undefined ? decodeTextEntities(input.agent) : undefined,
    keywords:
      input.keywords !== undefined ? decodeTextEntities(input.keywords) : undefined,
    synopsis:
      input.synopsis !== undefined ? decodeTextEntities(input.synopsis) : undefined,
    session: input.session !== undefined ? decodeTextEntities(input.session) : undefined,
  }
}

/**
 * Raised when `DecisionService.create` creates the decision row but fails
 * while writing the rationale markdown body. The decision row is best-effort
 * archived before this error is thrown; `cleanedUp` reports whether that
 * cleanup landed.
 */
export class DecisionCreatePartialFailureError extends Error {
  readonly pageId: string
  readonly cleanedUp: boolean
  readonly bodyWriteError: unknown
  readonly cleanupError: unknown

  constructor(
    message: string,
    details: {
      pageId: string
      cleanedUp: boolean
      bodyWriteError: unknown
      cleanupError?: unknown
    }
  ) {
    super(message)
    this.name = "DecisionCreatePartialFailureError"
    this.pageId = details.pageId
    this.cleanedUp = details.cleanedUp
    this.bodyWriteError = details.bodyWriteError
    this.cleanupError = details.cleanupError
  }
}

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
    const decoded = decodeDecisionTextFields(input)

    const page = await this.client.pages.create({
      parent: { type: "database_id", database_id: this.db.databaseId },
      properties: buildMemoryProps({
        title: decoded.decision,
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
        alternatives: decoded.alternatives,
        consequences: decoded.consequences,
        author: decoded.author,
        agent: decoded.agent,
        tags: input.tags,
        keywords: decoded.keywords,
        synopsis: decoded.synopsis,
        session: decoded.session,
      }),
    })

    if (decoded.rationale) {
      try {
        await this.client.pages.updateMarkdown({
          page_id: page.id,
          type: "insert_content",
          insert_content: { content: decoded.rationale },
        })
      } catch (bodyWriteError) {
        let cleanedUp = false
        let cleanupError: unknown
        try {
          await this.client.pages.update({
            page_id: page.id,
            archived: true,
          })
          cleanedUp = true
        } catch (err) {
          cleanupError = err
        }
        const cause =
          bodyWriteError instanceof Error
            ? bodyWriteError.message
            : String(bodyWriteError)
        const message = cleanedUp
          ? `Decision create partial failure: the decision row was ` +
            `created (page ${page.id}) but the rationale write failed: ${cause}. ` +
            `The orphan decision row was archived to keep the vault consistent; ` +
            `retry the create to land a fresh row.`
          : `Decision create partial failure: the decision row was ` +
            `created (page ${page.id}) but the rationale write failed: ${cause}. ` +
            `The cleanup archive also failed (${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }); the orphan decision row remains live in the vault. Archive it ` +
            `manually before retrying to avoid a duplicate row.`
        this.idCache.delete(page.id)
        throw new DecisionCreatePartialFailureError(message, {
          pageId: page.id,
          cleanedUp,
          bodyWriteError,
          cleanupError,
        })
      }
    }

    // The page we just created is guaranteed to have `Kind = decision` because
    // we set it explicitly above — the cast is safe by construction.
    const decision = pageToMemory(
      page as PageObjectResponse,
      decoded.rationale
    ) as Decision
    // A fresh id is unlikely to collide with a cached entry, but a
    // supersede-and-recreate flow in the same session could. Drop
    // anything under this id so getById doesn't serve a ghost.
    this.idCache.delete(decision.id)
    return decision
  }

  async getById(id: string): Promise<Decision> {
    // `getOrLoad` collapses concurrent cold-start fan-out onto a single
    // retrieve: `resolveCanonicalDecisionLinks` walks supersession DAGs
    // in parallel, and converging root walks hitting the same ancestor
    // previously each issued their own `pages.retrieve` call. The loader
    // either returns a Decision or throws on non-decision kinds; the
    // non-null assertion below is safe because `null` is unreachable on
    // this path. A throw propagates to every waiter and clears the
    // pending slot so the next caller retries rather than caching an error.
    const decision = await this.idCache.getOrLoad(id, async () => {
      const page = await this.client.pages.retrieve({ page_id: id })
      if (!isLiveFullPage(page)) {
        if (isFullPage(page) && page.archived) {
          throw new Error(`Decision ${id} is archived.`)
        }
        throw new Error(`Decision ${id} could not be loaded as a full Notion page.`)
      }
      const md = await this.client.pages.retrieveMarkdown({ page_id: id })
      const memory = pageToMemory(page, md.markdown)
      if (memory.kind !== "decision") {
        throw new Error(
          `Memory ${id} is not a decision (kind: ${memory.kind}). ` +
            "Use MemoryService for non-decision memories."
        )
      }
      return memory as Decision
    })
    return decision!
  }

  /**
   * List decisions matching the given filters. Returns summaries with no
   * markdown body. Archived rows are filtered client-side; when they occupy
   * result slots, the method keeps paginating until `limit` live rows are
   * collected or Notion is exhausted. This is the index tier that decision-path tools
   * (`lore-decision action='list'`, `lore-context action='wake-up'`'s
   * decisions section, `lore-query action='audit'`'s overdue decisions)
   * rely on for agent-ingestion performance.
   */
  async list(
    opts?: ListDecisionsOpts
  ): Promise<{ items: DecisionSummary[]; nextCursor?: string; capped: boolean }> {
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

    const limit = Math.min(opts?.limit ?? 20, 100)
    if (limit <= 0) {
      return { items: [], nextCursor: opts?.startCursor, capped: false }
    }

    const result = await collectLivePages({
      limit,
      startCursor: opts?.startCursor,
      source: "DecisionService.list",
      query: ({ page_size, start_cursor }) =>
        this.client.dataSources.query({
          data_source_id: this.db.dataSourceId,
          filter: filter as QueryDataSourceParameters["filter"],
          sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
          page_size,
          start_cursor,
        }),
    })

    return {
      items: result.pages.map((page) =>
        toDecisionSummary(pageToMemory(page, "") as Decision),
      ),
      nextCursor: result.nextCursor,
      capped: result.capped,
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
   *
   * Uses the shared live-row refill cap. Callers that need to tell users the
   * scan hit that cap should use `queryOverdueWindow`; this compatibility
   * wrapper returns only the visible summaries.
   */
  async queryOverdue(opts?: {
    projectId?: string
    limit?: number
  }): Promise<DecisionSummary[]> {
    const { items } = await this.queryOverdueWindow(opts)
    return items
  }

  async queryOverdueWindow(opts?: {
    projectId?: string
    limit?: number
  }): Promise<OverdueDecisionWindow> {
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

    const limit = opts?.limit ?? LIVE_PAGE_REFILL_MAX_ROWS
    if (limit <= 0) return { items: [], capped: false }
    const result = await collectLivePages({
      limit,
      source: "DecisionService.queryOverdue",
      query: ({ page_size, start_cursor }) =>
        this.client.dataSources.query({
          data_source_id: this.db.dataSourceId,
          filter: { and: filters } as QueryDataSourceParameters["filter"],
          sorts: [{ property: "Review By", direction: "ascending" }],
          page_size,
          start_cursor,
        }),
    })
    if (result.capped) {
      warnLivePageCapFired({
        source: "DecisionService.queryOverdue",
        pages: result.pageCount,
        accumulated: result.pages.length,
        limit,
      })
    }

    return {
      items: result.pages.map((page) =>
        toDecisionSummary(pageToMemory(page, "") as Decision),
      ),
      capped: result.capped,
    }
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
