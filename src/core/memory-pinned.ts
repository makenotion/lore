import type {
  Client,
  PageObjectResponse,
  QueryDataSourceParameters,
} from "@notionhq/client"
import type {
  DatabaseRef,
  Memory,
  MemoryMutability,
  MemoryPinnedInput,
  MemoryPinned as MemoryPinnedShape,
  MemoryScopeContext,
  UpdateMemoryInput,
} from "../types.js"
import {
  PINNED_BLOCKS_HARD_CAP,
  PINNED_PRIORITY_MAX,
  PINNED_PRIORITY_MIN,
} from "../types.js"
import { MEMORY_PROPS } from "../notion/schema.js"
import { isMissingPropertyError } from "../notion/errors.js"
import { projectOrUnscopedFilter, withDefaultScopeFilter } from "../notion/filters.js"
import { collectLivePages, warnLivePageCapFired } from "../notion/live-pages.js"
import { requireQueryResults } from "../notion/query-response.js"
import {
  extractCheckbox,
  extractNumber,
  extractRichText,
  extractTitle,
  isLiveFullPage,
} from "../notion/extractors.js"
import { LoreError } from "../errors.js"
import { todayUtc } from "./task.js"
import { matchesDefaultScope } from "./memory-scope.js"

type MaterializeMemories = (
  pages: PageObjectResponse[],
  includeContent: boolean
) => Promise<Memory[]>

/**
 * Thrown when the target memory has `Mutability = read-only` and the
 * caller did not opt into the operator override path.
 *
 * The raw title remains available on `.memoryTitle`; the rendered
 * message uses a sanitized title so a pinned-block author cannot
 * inject control characters into logs or tool output.
 */
export class MemoryReadOnlyError extends LoreError<"memory-read-only"> {
  readonly memoryId: string
  readonly memoryTitle: string

  constructor(memoryId: string, memoryTitle: string) {
    const safeTitle = sanitizeMemoryTitleForMessage(memoryTitle)
    super(
      "memory-read-only",
      `MemoryReadOnlyError: cannot modify pinned block "${safeTitle}" (${memoryId}): ` +
        `Mutability is read-only. Pass force=true on lore-pinned action='update' ` +
        `(or allowReadOnlyUpdate=true at the service layer) to override.`,
      { memoryId, memoryTitle }
    )
    this.name = "MemoryReadOnlyError"
    this.memoryId = memoryId
    this.memoryTitle = memoryTitle
  }
}

/**
 * Service-layer mirror of the MCP pinned-cap error.
 *
 * The MCP handler performs its own user-facing precheck before
 * calling `MemoryService.update`. This error keeps the same hard cap
 * enforced for CLI, hook, and future service-layer callers that flip
 * `Pinned = true` directly through the memory update surface.
 */
export class MemoryPinCapExceededError extends LoreError<"memory-pin-cap-exceeded"> {
  readonly memoryId: string
  readonly currentCount: number
  readonly cap: number

  constructor(memoryId: string, currentCount: number, cap: number) {
    super(
      "memory-pin-cap-exceeded",
      `MemoryPinCapExceededError: cannot pin memory ${memoryId} — vault ` +
        `already has ${currentCount} active pinned block(s), at the ${cap}-` +
        "block hard cap. Unpin stale blocks before pinning new rows.",
      { memoryId, currentCount, cap }
    )
    this.name = "MemoryPinCapExceededError"
    this.memoryId = memoryId
    this.currentCount = currentCount
    this.cap = cap
  }
}

/**
 * Sanitize a memory title for interpolation into a user-facing
 * error message. Strips ASCII control chars and Unicode bidi-override
 * / zero-width chars, collapses whitespace, truncates to 120 chars.
 */
export function sanitizeMemoryTitleForMessage(title: string): string {
  const MAX = 120
  const cleaned = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]+/g, " ")
    .replace(/[\u200B-\u200D\u202A-\u202E\u2066-\u2069\uFEFF]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned.length > MAX ? `${cleaned.slice(0, MAX - 1)}…` : cleaned
}

/**
 * Read the pinned-block columns into a `MemoryPinned` bundle.
 *
 * `Pinned` is the source of truth. A row with priority or mutability
 * values but `Pinned = false` is treated as an ordinary memory.
 * Pinned rows default missing priority to `0` and missing mutability
 * to `mutable`.
 */
export function extractMemoryPinned(
  props: PageObjectResponse["properties"]
): MemoryPinnedShape | null {
  const isPinned = extractCheckbox(props[MEMORY_PROPS.PINNED])
  if (!isPinned) return null
  const priority = extractNumber(props[MEMORY_PROPS.PINNED_PRIORITY]) ?? 0
  const mutabilityProp = props[MEMORY_PROPS.MUTABILITY]
  const mutability =
    mutabilityProp && mutabilityProp.type === "select" && mutabilityProp.select
      ? (mutabilityProp.select.name as MemoryMutability)
      : "mutable"
  return { priority, mutability }
}

/**
 * Clamp a pinned-block priority to `[PINNED_PRIORITY_MIN,
 * PINNED_PRIORITY_MAX]` and round to a whole number so Notion's
 * display formatting stays predictable.
 *
 * The MCP schema also clamps, but this service-layer guard protects
 * callers that bypass the MCP input parser.
 */
export function clampPinnedPriority(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value > PINNED_PRIORITY_MAX) return PINNED_PRIORITY_MAX
  if (value < PINNED_PRIORITY_MIN) return PINNED_PRIORITY_MIN
  return Math.round(value)
}

export function pinnedInputToBuilderProps(input: MemoryPinnedInput | undefined): {
  pinned?: boolean
  pinnedPriority?: number | null
  mutability?: MemoryMutability | null
} {
  if (input === undefined) return {}
  return {
    pinned: input.pinned,
    pinnedPriority:
      input.priority === undefined
        ? undefined
        : input.priority === null
          ? null
          : clampPinnedPriority(input.priority),
    mutability: input.mutability,
  }
}

/**
 * Audience matching for pinned context blocks.
 *
 * Empty audience is broadcast. Otherwise, comma-separated tokens are
 * case-folded and matched exactly against the reader's agent, role,
 * or user id. Universal tokens (`all`, `*`, `everyone`, `agents`)
 * match every reader.
 */
export function pinnedBlockAudienceMatches(
  audience: string,
  reader: MemoryScopeContext
): boolean {
  const trimmed = audience.trim()
  if (trimmed.length === 0) return true
  const tokens = trimmed
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return true
  if (
    tokens.some((t) => t === "all" || t === "*" || t === "everyone" || t === "agents")
  ) {
    return true
  }
  const readerSlots: string[] = []
  if (reader.agent && reader.agent.trim().length > 0) {
    readerSlots.push(reader.agent.trim().toLowerCase())
  }
  if (reader.role && reader.role.trim().length > 0) {
    readerSlots.push(reader.role.trim().toLowerCase())
  }
  if (reader.userId && reader.userId.trim().length > 0) {
    readerSlots.push(reader.userId.trim().toLowerCase())
  }
  if (readerSlots.length === 0) return false
  return tokens.some((token) => readerSlots.includes(token))
}

export class MemoryPinned {
  private countCache: { value: number; expiresAt: number } | null = null
  private readonly COUNT_TTL_MS = 30_000

  constructor(
    private client: Client,
    private db: DatabaseRef,
    private readonly getScopeContext: () => MemoryScopeContext,
    private readonly isScopeFilterEnabled: () => boolean,
    private readonly materializeMemories: MaterializeMemories
  ) {}

  clearCountCache(): void {
    this.countCache = null
  }

  invalidateCountCache(): void {
    this.countCache = null
  }

  async preflightCreate(input: MemoryPinnedInput | undefined): Promise<void> {
    if (input?.pinned !== true) return
    const activePinCount = await this.countPinnedBlocks()
    if (activePinCount >= PINNED_BLOCKS_HARD_CAP) {
      throw new MemoryPinCapExceededError(
        "new-memory",
        activePinCount,
        PINNED_BLOCKS_HARD_CAP
      )
    }
  }

  async preflightUpdate(
    id: string,
    input: Pick<UpdateMemoryInput, "allowReadOnlyUpdate" | "pinned" | "bypassPinCapCheck">
  ): Promise<void> {
    // One retrieve covers both pinned-block guards before any
    // property or body mutation: read-only enforcement on existing
    // pins, and hard-cap enforcement on unpinned-to-pinned
    // transitions.
    const wouldPin = input.pinned?.pinned === true
    const needsPreflight =
      !input.allowReadOnlyUpdate || (wouldPin && !input.bypassPinCapCheck)
    if (!needsPreflight) return

    const probe = (await this.client.pages.retrieve({
      page_id: id,
    })) as PageObjectResponse
    const props = probe.properties
    const isPinned = extractCheckbox(props[MEMORY_PROPS.PINNED])
    if (!input.allowReadOnlyUpdate && isPinned) {
      const mutabilityProp = props[MEMORY_PROPS.MUTABILITY]
      const mutability =
        mutabilityProp && mutabilityProp.type === "select" && mutabilityProp.select
          ? (mutabilityProp.select.name as MemoryMutability)
          : "mutable"
      if (mutability === "read-only") {
        throw new MemoryReadOnlyError(id, extractTitle(props[MEMORY_PROPS.TITLE]))
      }
    }
    if (wouldPin && !isPinned && !input.bypassPinCapCheck) {
      const activePinCount = await this.countPinnedBlocks()
      if (activePinCount >= PINNED_BLOCKS_HARD_CAP) {
        throw new MemoryPinCapExceededError(id, activePinCount, PINNED_BLOCKS_HARD_CAP)
      }
    }
  }

  async listPinnedBlocks(opts: {
    projectId?: string
    limit?: number
    today?: string
    readerContext?: MemoryScopeContext
    includeContent?: boolean
    audienceFilter?: boolean
    includeOutOfScope?: boolean
  }): Promise<Memory[]> {
    const limit = opts.limit ?? 10
    if (limit <= 0) return []

    const filters: Array<Record<string, unknown>> = [
      { property: MEMORY_PROPS.PINNED, checkbox: { equals: true } },
    ]
    if (opts.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }
    const baseFilter = { and: filters } as Record<string, unknown>
    // Scope and audience filters run inside the paginating collector,
    // before the visible limit is satisfied. That lets the walker
    // over-fetch and backfill when high-priority pins target a
    // different reader.
    const reader = opts.readerContext ?? {}
    const today = opts.today ?? todayUtc()
    const scopeCtx = this.getScopeContext()
    const scopeFilterActive =
      this.isScopeFilterEnabled() && opts.includeOutOfScope !== true
    const filter = (
      scopeFilterActive ? withDefaultScopeFilter(baseFilter, scopeCtx, today) : baseFilter
    ) as QueryDataSourceParameters["filter"]
    const applyAudienceFilter = opts.audienceFilter !== false

    let result: Awaited<ReturnType<typeof collectLivePages>>
    try {
      result = await collectLivePages({
        limit,
        source: "MemoryService.listPinnedBlocks",
        query: ({ page_size, start_cursor }) =>
          this.client.dataSources.query({
            data_source_id: this.db.dataSourceId,
            filter,
            sorts: [
              {
                property: MEMORY_PROPS.PINNED_PRIORITY,
                direction: "descending",
              },
              { timestamp: "created_time", direction: "descending" },
            ],
            page_size,
            start_cursor,
          }),
        extraFilter: (page) => {
          if (
            scopeFilterActive &&
            !matchesDefaultScope(page.properties, scopeCtx, today)
          ) {
            return false
          }
          if (applyAudienceFilter) {
            const audience = extractRichText(page.properties[MEMORY_PROPS.AUDIENCE])
            if (!pinnedBlockAudienceMatches(audience, reader)) return false
          }
          return true
        },
      })
    } catch (err) {
      // Pre-migration vaults do not have pinned-block columns yet.
      // Treat that as an empty pinned section; transient and malformed
      // non-schema errors still propagate.
      if (isMissingPropertyError(err)) return []
      throw err
    }
    if (result.capped) {
      warnLivePageCapFired({
        source: "MemoryService.listPinnedBlocks",
        pages: result.pageCount,
        accumulated: result.pages.length,
        limit,
      })
    }

    return this.materializeMemories(result.pages, opts.includeContent ?? false)
  }

  async countPinnedBlocks(opts: { bypassCache?: boolean } = {}): Promise<number> {
    // The count intentionally ignores scope and audience. It backs
    // operator-facing abuse signals and hard-cap checks, so callers
    // need the vault-wide active pinned-row total.
    if (!opts.bypassCache && this.countCache !== null) {
      if (Date.now() < this.countCache.expiresAt) {
        return this.countCache.value
      }
      this.countCache = null
    }
    let total = 0
    let cursor: string | undefined
    const filter = {
      property: MEMORY_PROPS.PINNED,
      checkbox: { equals: true },
    } as QueryDataSourceParameters["filter"]
    try {
      for (;;) {
        const response = await this.client.dataSources.query({
          data_source_id: this.db.dataSourceId,
          filter,
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        })
        total += requireQueryResults(response, "MemoryService.countPinnedBlocks").filter(
          isLiveFullPage
        ).length
        if (!response.has_more) break
        cursor = response.next_cursor ?? undefined
        if (!cursor) break
      }
    } catch (err) {
      if (isMissingPropertyError(err)) {
        this.countCache = {
          value: 0,
          expiresAt: Date.now() + this.COUNT_TTL_MS,
        }
        return 0
      }
      throw err
    }
    this.countCache = {
      value: total,
      expiresAt: Date.now() + this.COUNT_TTL_MS,
    }
    return total
  }
}
