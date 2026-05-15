import type {
  Client,
  PageObjectResponse,
  QueryDataSourceParameters,
} from "@notionhq/client"
import type {
  DatabaseRef,
  Memory,
  MemoryConfidence as MemoryConfidenceLevel,
  MemoryKind,
  MemoryScopeContext,
  MemorySource,
  MemoryStatus,
  MemoryWithoutContent,
} from "../types.js"
import { MEMORY_PROPS } from "../notion/schema.js"
import { projectOrUnscopedFilter, withDefaultScopeFilter } from "../notion/filters.js"
import { collectLivePages } from "../notion/live-pages.js"
import { fetchNearDuplicateCandidatePageIds } from "../notion/runtool/index.js"
import {
  isSqlValidationError,
  logRunToolFallback,
} from "../notion/runtool/error-helpers.js"
import type { LoreFeatureFlags } from "../feature-flags.js"
import { MEMORY_CLEANUP_ORPHAN_SENTINEL } from "./near-duplicate.js"
import { todayUtc } from "./task.js"
import { withCleanupOrphanExclusion } from "./memory-filters.js"
import { matchesDefaultScope } from "./memory-scope.js"
import { reviewTerminalStatusExclusionFilters } from "./memory-review-state.js"

type PageToMemory = (page: PageObjectResponse, content: string) => Promise<Memory>
type GetMemoryPropertiesById = (id: string) => Promise<Memory>

/**
 * Filter / pagination / sort options accepted by `MemoryService.list`.
 * Extracted to a named type so the method's overload signatures can
 * intersect it with literal `includeContent` narrowings and the
 * body-omitted `MemoryWithoutContent` contract.
 */
export interface ListMemoriesOptions {
  projectId?: string
  topicId?: string
  source?: MemorySource
  kind?: MemoryKind
  /**
   * Negative `Kind` filter. Each entry is excluded server-side via
   * a `select.does_not_equal` clause on the `Kind` column. Mirrors
   * the existing `excludeKinds` parameter on the memory
   * near-duplicate probe; use the
   * same `excludeKinds: ["decision"]` posture when surfacing
   * "memories that need triage" without conflating with governance
   * decisions.
   */
  excludeKinds?: MemoryKind[]
  confidence?: MemoryConfidenceLevel
  status?: MemoryStatus
  reviewBefore?: string
  tags?: string[]
  session?: string
  limit?: number
  since?: string
  until?: string
  includeContent?: boolean
  includeUnscoped?: boolean
  includeProposed?: boolean
  sortBy?: "created_time" | "last_edited_time"
  direction?: "ascending" | "descending"
  startCursor?: string
  includeOutOfScope?: boolean
}

export class MemoryList {
  constructor(
    private readonly client: Client,
    private readonly db: DatabaseRef,
    private readonly features: LoreFeatureFlags,
    private readonly getScopeContext: () => MemoryScopeContext,
    private readonly isScopeFilterEnabled: () => boolean,
    private readonly pageToMemory: PageToMemory,
    private readonly getPropertiesById: GetMemoryPropertiesById
  ) {}

  private get scopeCtx(): MemoryScopeContext {
    return this.getScopeContext()
  }

  private get scopeFilterEnabled(): boolean {
    return this.isScopeFilterEnabled()
  }

  /**
   * Candidate-pool fetcher for the near-duplicate probe. Pulls
   * `Status IN (...)` and `Kind NOT IN (...)` ahead of the row
   * limit when the operator opts into the RunTool SQL path.
   */
  async listForNearDuplicates(opts: {
    projectId: string
    topicId?: string
    kind?: MemoryKind
    excludeKinds?: readonly MemoryKind[]
    statuses?: readonly MemoryStatus[]
    tags?: readonly string[]
    includeProposed?: boolean
    limit: number
  }): Promise<Memory[]> {
    if (this.features.runTool.filterSql) {
      try {
        // Mirror `MemoryService.list`'s default: when the
        // caller has not opted into proposed rows AND has not
        // narrowed via an explicit `statuses` whitelist, exclude
        // `Status = proposed` server-side. Without this, the SQL
        // path would surface inbox/proposed rows that the REST
        // path's default-exclude filter drops, breaking the
        // "behavior unchanged with all RunTool flags off" contract
        // under A/B testing.
        const excludeStatuses =
          opts.statuses === undefined && !opts.includeProposed
            ? (["proposed"] as const)
            : undefined
        // **Tag filtering is pushed server-side via the verified
        // exact-token SQL predicate.** An earlier overfetch
        // heuristic was rejected because wrong-tag rows could fill
        // the `limit * 4` window before tag-matching candidates.
        // `fetchNearDuplicateCandidatePageIds` composes
        // `(Tags LIKE %"tag1"% OR Tags LIKE %"tag2"%)` ahead of
        // the LIMIT, so SQL `LIMIT N` truthfully bounds N
        // tag-matching candidates — identical to REST
        // `multi_select.contains` semantics.
        const pageIds = await fetchNearDuplicateCandidatePageIds(this.client, {
          dataSourceId: this.db.dataSourceId,
          projectProperty: MEMORY_PROPS.PROJECT,
          topicProperty: MEMORY_PROPS.TOPIC,
          kindProperty: MEMORY_PROPS.KIND,
          statusProperty: MEMORY_PROPS.STATUS,
          keywordsProperty: MEMORY_PROPS.KEYWORDS,
          tagsProperty: MEMORY_PROPS.TAGS,
          projectId: opts.projectId,
          // Default `includeUnscoped: true` matches
          // `MemoryService.list`'s default `projectOrUnscopedFilter`
          // — without this, project-scoped near-dup probes would
          // miss vault-wide memories that REST surfaces.
          ...(opts.topicId !== undefined ? { topicId: opts.topicId } : {}),
          ...(opts.tags && opts.tags.length > 0 ? { tags: opts.tags } : {}),
          ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
          ...(opts.excludeKinds && opts.excludeKinds.length > 0
            ? { excludeKinds: opts.excludeKinds }
            : {}),
          ...(opts.statuses && opts.statuses.length > 0
            ? { statuses: opts.statuses }
            : {}),
          ...(excludeStatuses ? { excludeStatuses } : {}),
          cleanupOrphanSentinel: MEMORY_CLEANUP_ORPHAN_SENTINEL,
          limit: opts.limit,
        })
        // One `pages.retrieve` per id, gated by the shared rate-
        // limit gate. Hydrate via `getPropertiesById` (no body
        // fetch) so the returned shape matches the REST path's
        // `includeContent: false` — `content: ""`.
        const memories = await Promise.all(
          pageIds.map((id) =>
            this.getPropertiesById(id).catch((err: unknown) => {
              // A single failed id should not collapse the SQL
              // branch — drop it and continue. Hydration failures
              // are typically archived-after-query races; the row
              // would have been filtered out by the REST path's
              // `is_full_page` + `archived` filter anyway.
              if (process.env["LORE_DEBUG"] === "1") {
                process.stderr.write(
                  `[lore] partial-failure: source=near-duplicate-hydrate ` +
                    `pageId=${id} error=${err instanceof Error ? err.message : "unknown"}\n`
                )
              }
              return null
            })
          )
        )
        // SQL applies exact tag filter before LIMIT (see SQL
        // composition above), so the hydrated list is already
        // tag-filtered and truncated to `opts.limit`. No JS
        // post-filter needed for tags.
        return memories.filter((m): m is Memory => m !== null)
      } catch (err) {
        if (isSqlValidationError(err)) {
          // Surface to the operator: a 400 / validation_error
          // indicates query-shape drift —
          // column rename, gateway syntax change, parameter
          // binding shape change. Silent fallback would mask a
          // permanent SQL-rollout failure as "REST path always
          // ran." The error message carries the gateway's
          // specifics. Transient (network / 5xx / 429 /
          // restricted / unauthorized / malformed) failures still
          // fall back per call.
          throw err
        }
        logRunToolFallback("near-duplicate-candidates", err)
        // fall through to REST path
      }
    }

    const { items } = await this.list({
      projectId: opts.projectId,
      ...(opts.topicId !== undefined ? { topicId: opts.topicId } : {}),
      ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
      ...(opts.excludeKinds && opts.excludeKinds.length > 0
        ? { excludeKinds: [...opts.excludeKinds] }
        : {}),
      ...(opts.tags && opts.tags.length > 0 ? { tags: [...opts.tags] } : {}),
      limit: opts.limit,
      includeContent: false,
      ...(opts.includeProposed !== undefined
        ? { includeProposed: opts.includeProposed }
        : {}),
    })
    return items
  }

  async list(opts: ListMemoriesOptions & { includeContent: true }): Promise<{
    items: Memory[]
    nextCursor?: string
    capped: boolean
  }>
  async list(
    opts?: ListMemoriesOptions & { includeContent?: false | undefined }
  ): Promise<{
    items: MemoryWithoutContent[]
    nextCursor?: string
    capped: boolean
  }>
  async list(opts?: ListMemoriesOptions): Promise<{
    items: Memory[]
    nextCursor?: string
    capped: boolean
  }>
  async list(opts?: ListMemoriesOptions): Promise<{
    items: Memory[] | MemoryWithoutContent[]
    nextCursor?: string
    capped: boolean
  }> {
    const filters: Array<Record<string, unknown>> = []

    if (opts?.projectId) {
      filters.push(
        opts.includeUnscoped === false
          ? { property: MEMORY_PROPS.PROJECT, relation: { contains: opts.projectId } }
          : projectOrUnscopedFilter(opts.projectId)
      )
    }
    if (opts?.topicId) {
      filters.push({
        property: MEMORY_PROPS.TOPIC,
        relation: { contains: opts.topicId },
      })
    }
    if (opts?.source) {
      filters.push({
        property: MEMORY_PROPS.SOURCE,
        select: { equals: opts.source },
      })
    }
    if (opts?.kind) {
      filters.push({
        property: MEMORY_PROPS.KIND,
        select: { equals: opts.kind },
      })
    }
    if (opts?.excludeKinds && opts.excludeKinds.length > 0) {
      // One `does_not_equal` clause per excluded kind — Notion's
      // select filter has no `not_in` operator, so each value
      // gets its own clause. Pushed onto the outer `and:` chain
      // by the surrounding combiner. Mirrors the
      // `reviewTerminalStatusExclusionFilters` posture below.
      for (const k of opts.excludeKinds) {
        filters.push({ property: MEMORY_PROPS.KIND, select: { does_not_equal: k } })
      }
    }
    if (opts?.confidence) {
      filters.push({
        property: MEMORY_PROPS.CONFIDENCE,
        select: { equals: opts.confidence },
      })
    }
    if (opts?.status) {
      filters.push({
        property: MEMORY_PROPS.STATUS,
        select: { equals: opts.status },
      })
    } else if (opts?.includeProposed !== true) {
      // Default-exclude review-terminal statuses (`proposed` and
      // `rejected`) so neither pollutes default recall paths.
      // Explicit `status` short-circuits this branch — when the
      // caller asks for
      // `status: "proposed"` (the inbox-review path) or
      // `status: "rejected"` (the audit path) directly, that filter
      // wins. Notion's `does_not_equal` semantics cover both
      // explicit values and the null / unmigrated case (a row
      // with no Status column set is NOT review-terminal and
      // therefore passes the filter).
      filters.push(...reviewTerminalStatusExclusionFilters())
    }
    if (opts?.reviewBefore) {
      filters.push({
        property: MEMORY_PROPS.REVIEW_BY,
        date: { on_or_before: opts.reviewBefore },
      })
    }
    if (opts?.tags?.length) {
      if (opts.tags.length === 1) {
        filters.push({
          property: MEMORY_PROPS.TAGS,
          multi_select: { contains: opts.tags[0] },
        })
      } else {
        filters.push({
          or: opts.tags.map((t) => ({
            property: MEMORY_PROPS.TAGS,
            multi_select: { contains: t },
          })),
        })
      }
    }
    if (opts?.session) {
      filters.push({
        property: MEMORY_PROPS.SESSION,
        rich_text: { equals: opts.session },
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

    const baseFilter =
      filters.length > 1
        ? { and: filters }
        : filters.length === 1
          ? filters[0]
          : undefined

    // Resurfaced cleanup-orphan exclusion. Pushed
    // server-side here so every consumer of `list` — including
    // `lore-query action='recall'`, the wake-up related-memories
    // pass, the autosave-learning probe, and `findNearDuplicates` —
    // uniformly drops sentinel-tagged rows. Without this, an orphan
    // restored from Notion's trash would surface in recall, wake-up,
    // and the dedup post-filter would have to catch it after
    // `MemoryService.list` had already consumed candidate-pool slots.
    //
    // Default scope filter. Composed before the orphan
    // exclusion so both clauses live in the same top-level `and`.
    // `includeOutOfScope: true` skips the scope clause for audit
    // paths (`lore status` expiring-rows surface, conflict scanner,
    // near-duplicate probe pool).
    const scopedFilter =
      opts?.includeOutOfScope === true || !this.scopeFilterEnabled
        ? baseFilter
        : withDefaultScopeFilter(baseFilter, this.scopeCtx, todayUtc())
    const filter = withCleanupOrphanExclusion(scopedFilter)

    const limit = Math.min(opts?.limit ?? 20, 100)
    if (limit <= 0) {
      return { items: [], nextCursor: opts?.startCursor, capped: false }
    }

    // Notion's compound-filter language caps nesting at 2 levels,
    // so `defaultScopeInclusionFilter` emits a server-side shape
    // that includes the reader's narrow kinds without binding each
    // kind to its key. The kind+key binding runs client-side via
    // `matchesDefaultScope` here. The walker over-fetches by the
    // slots dropped on the client side; backfilled pagination keeps
    // the result at the caller's requested limit.
    const today = todayUtc()
    const applyExtraFilter =
      opts?.includeOutOfScope === true || !this.scopeFilterEnabled
        ? undefined
        : (page: PageObjectResponse) =>
            matchesDefaultScope(page.properties, this.scopeCtx, today)
    const result = await collectLivePages({
      limit,
      startCursor: opts?.startCursor,
      source: "MemoryService.list",
      query: ({ page_size, start_cursor }) =>
        this.client.dataSources.query({
          data_source_id: this.db.dataSourceId,
          filter: filter as QueryDataSourceParameters["filter"],
          sorts: [
            {
              timestamp: opts?.sortBy ?? "last_edited_time",
              direction: opts?.direction ?? "descending",
            },
          ],
          page_size,
          start_cursor,
        }),
      extraFilter: applyExtraFilter,
    })

    if (opts?.includeContent !== true) {
      // `pageToMemory` is still async on the body-skipped branch —
      // the wrap pays only the relation-hydration cost (per-row
      // `pages.properties.retrieve` for truncated relation columns
      // when `has_more: true`), not a body fetch. The N-way
      // `pages.retrieveMarkdown` fan-out lives in the explicit-true
      // branch below.
      //
      // Passing `""` to `pageToMemory` produces rows whose `content`
      // field is the empty string. The runtime invariant matches the
      // `MemoryWithoutContent` (`content: ""`) literal-typed shape that
      // the omitted-or-false overload advertises; TypeScript cannot
      // infer the literal from the empty-string argument alone, so the
      // cast bridges the runtime guarantee to the type-level signal.
      const items = (await Promise.all(
        result.pages.map((page) => this.pageToMemory(page, ""))
      )) as MemoryWithoutContent[]
      return {
        items,
        nextCursor: result.nextCursor,
        capped: result.capped,
      }
    }

    const items = await Promise.all(
      result.pages.map(async (page) => {
        const md = await this.client.pages.retrieveMarkdown({ page_id: page.id })
        return await this.pageToMemory(page, md.markdown)
      })
    )
    return { items, nextCursor: result.nextCursor, capped: result.capped }
  }
}
