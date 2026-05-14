/**
 * Memory CRUD + search — the core content store.
 *
 * Each memory is a Notion page in the Memories database. The page body
 * holds verbatim content. Page properties hold metadata for filtering
 * and categorization.
 *
 * Semantic search leverages Notion's existing embedding + vector search
 * pipeline: content written to Notion pages is automatically chunked,
 * embedded, and indexed. We search via the Notion search API.
 */

import type { Client } from "@notionhq/client"
import { APIErrorCode, isNotionClientError } from "@notionhq/client"
import type {
  PageObjectResponse,
  CreatePageParameters,
  QueryDataSourceParameters,
} from "@notionhq/client"
import type {
  Memory,
  MemoryWithoutContent,
  CreateMemoryInput,
  UpdateMemoryInput,
  SearchMemoriesInput,
  SearchExplain,
  MemorySource,
  MemoryKind,
  MemoryStatus,
  MemoryConfidence as MemoryConfidenceLevel,
  MemoryScopeContext,
  MemoryScopeInput,
  TaskState,
  DatabaseRef,
  FreshCreatePreparation,
} from "../types.js"
import {
  CONFIDENCE_DISPLAY_THRESHOLD,
  EXPIRING_SOON_DAYS,
  MS_PER_DAY,
  STALE_CONFIDENCE_DAYS,
} from "../types.js"
import { buildMemoryProps, MEMORY_PROPS } from "../notion/schema.js"
import { isMissingPropertyError } from "../notion/errors.js"
import { projectOrUnscopedFilter, withDefaultScopeFilter } from "../notion/filters.js"
import { decodeTextEntities } from "../notion/html-entities.js"
import { fixMemoryEncoding, type MemoryEncodingReport } from "./memory-encoding.js"
import { normalizeAgents, type AgentNormalizationReport } from "./agent-normalization.js"
import {
  findAutosaveLearningDuplicate,
  MEMORY_CLEANUP_ORPHAN_SENTINEL,
  type AutosaveLearningDuplicateMatch,
} from "./near-duplicate.js"
import { withAutosaveLearningLock } from "./autosave-learning-lock.js"
import {
  backfillSynopses,
  type BackfillOptions,
  type BackfillReport,
} from "./synopsis-backfill.js"
import { LruCache } from "./cache.js"
import { validateRichTextMetadataFields } from "./rich-text-schema.js"
import { todayUtc } from "./task.js"
import {
  isFullPage,
  isLiveFullPage,
  extractTitle,
  extractRichText,
  extractSelect,
  extractMultiSelect,
  extractRelationIds,
  extractDate,
  extractNumber,
} from "../notion/extractors.js"
import { collectLivePages, warnLivePageCapFired } from "../notion/live-pages.js"
import {
  hydrateRelationProperties,
  hydrateRelationPropertiesForPages,
} from "../notion/relation-properties.js"
import { fetchNearDuplicateCandidatePageIds } from "../notion/runtool/index.js"
import {
  isSqlValidationError,
  logRunToolFallback,
} from "../notion/runtool/error-helpers.js"
import { LoreError, errorCauseMessage } from "../errors.js"
import { resolveFeatureFlags, type LoreFeatureFlags } from "../feature-flags.js"
import { matchesDefaultScope } from "./memory-scope.js"
import {
  MemoryPinned,
  clampPinnedPriority,
  extractMemoryPinned,
  pinnedInputToBuilderProps,
} from "./memory-pinned.js"
import { MemoryConfidence } from "./memory-confidence.js"
import {
  cleanupOrphanExclusionFilter,
  withCleanupOrphanExclusion,
} from "./memory-filters.js"
import {
  MemoryTopicKey,
  type FindByTopicKeyInput,
  type RekeyTopicKeyInput,
  type RekeyTopicKeyResult,
  type RekeyValidationResult,
  type TopicKeyUpsertInput,
  type TopicKeyUpsertResult,
} from "./memory-topic-key.js"
import {
  MemoryCompare,
  type RecordComparedInput,
  type RecordComparedResult,
} from "./memory-compare.js"
import { MemorySearch, type SearchPagesResult } from "./memory-search.js"
import { reviewTerminalStatusExclusionFilters } from "./memory-review-state.js"

export { matchesDefaultScope } from "./memory-scope.js"
export {
  MemoryPinCapExceededError,
  MemoryReadOnlyError,
  clampPinnedPriority,
  pinnedBlockAudienceMatches,
  sanitizeMemoryTitleForMessage,
} from "./memory-pinned.js"
export {
  RekeyAuditError,
  computePromotionAdvisory,
  PROMOTE_BODY_LENGTH_THRESHOLD,
  PROMOTE_REVISION_THRESHOLD,
} from "./memory-topic-key.js"
export type { PromotionAdvisory } from "./memory-topic-key.js"
export {
  COMPARE_NOTES_MAX_CHARS,
  CompareDispatchPartialFailureError,
  RecordComparedPartialWriteError,
  appendCompareDispatchLedgerEntry,
  appendCompareNote,
  buildCompareDispatchLedgerEntry,
  compareDispatchKey,
  encodeCompareNotesRichText,
  hasCompareDispatchLedgerEntry,
  hasMatchingCompareNote,
  recordContradiction,
  recordSupersedence,
} from "./memory-compare.js"
export type {
  CompareDispatchLedgerEntry,
  CompareDispatchServices,
  CompareNoteEntry,
  CompareNotesTextChunk,
  RecordComparedResult,
} from "./memory-compare.js"
export {
  HYBRID_FALLBACK_THRESHOLD,
  SEMANTIC_SEARCH_MAX_PAGES,
  tieBreakingRrfCompare,
} from "./memory-search.js"
export type { RrfEntry } from "./memory-search.js"
export {
  REVIEW_TERMINAL_STATUSES,
  isNotReviewTerminalStatus,
  reviewTerminalStatusExclusionFilters,
} from "./memory-review-state.js"

/** Cap matches `DecisionService.idCache` (500); TTL is 60s (vs Decision's
 * 30s) because title text is cheaper-to-be-stale than decision lifecycle
 * state — a stale title only shows the wrong label until the next write
 * evicts the slot, whereas a stale decision status could mis-apply
 * governance. Titles and `Kind=decision` pages share this pool. */
const TITLE_CACHE_MAX = 500
const TITLE_CACHE_TTL_MS = 60_000
const AUTOSAVE_LEARNING_POST_CREATE_STABILIZE_MS = 500
const AUTOSAVE_LEARNING_POST_CREATE_POLL_MS = 50

function parseNonNegativeIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  if (!/^[0-9]+$/.test(raw)) return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : fallback
}

function autosaveLearningPostCreateStabilizeMs(): number {
  return parseNonNegativeIntegerEnv(
    "LORE_AUTOSAVE_LEARNING_POST_CREATE_STABILIZE_MS",
    AUTOSAVE_LEARNING_POST_CREATE_STABILIZE_MS
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Translate the agent-facing `MemoryScopeInput` bundle into the flat
 * primitive shape `buildMemoryProps` / `buildFactProps` consume. The
 * builders themselves stay one-primitive-per-Notion-column so the
 * write path is identical regardless of which surface produced the
 * scope (CLI, MCP, or internal migration).
 *
 * `undefined` input → `undefined` outputs across the board (no
 * column writes). Spread the result into the builder call so omitted
 * scopes leave the caller's surface untouched.
 */
function scopeInputToBuilderProps(scope: MemoryScopeInput | undefined): {
  scopeKind?: string | null
  scopeKey?: string
  audience?: string
  lifetime?: string | null
  expiresAt?: string | null
} {
  if (scope === undefined) return {}
  const out: ReturnType<typeof scopeInputToBuilderProps> = {}
  if (scope.kind !== undefined) out.scopeKind = scope.kind
  if (scope.key !== undefined) out.scopeKey = scope.key
  if (scope.audience !== undefined) out.audience = scope.audience
  if (scope.lifetime !== undefined) out.lifetime = scope.lifetime
  if (scope.expiresAt !== undefined) out.expiresAt = scope.expiresAt
  return out
}

/**
 * Server-side filter clause defining the proposed-memory review inbox.
 * Single source of truth so every consumer — the count primitive
 * (`MemoryService.countProposed`), the wake-up inbox section
 * (`loadWakeUpData`), the inbox-list CLI (`lore inbox list`) —
 * composes the same filter literal and never drifts.
 *
 * The clause is `Status = proposed AND Kind != decision`:
 *
 * - `Status: { equals: "proposed" }` — the inbox state.
 * - `Kind: { does_not_equal: "decision" }` — `proposed` is also a
 * normal in-flight `decision` lifecycle state per
 * `ACTIVE_DECISION_STATUSES`; counting those rows would conflate
 * governance decisions with auto-extracted learnings. Mirrors the
 * `excludeKinds: ["decision"]` posture in the memory near-duplicate
 * probe.
 *
 * Notion's `does_not_equal` is permissive on null — a row with no
 * `Kind` column set (a hand-edited or unmigrated page) passes the
 * filter, since it is by definition not `decision`. Same posture as
 * the `reviewTerminalStatusExclusionFilters` default-recall filter.
 */
export function proposedMemoryFilter(): { and: Array<Record<string, unknown>> } {
  return {
    and: [
      { property: MEMORY_PROPS.STATUS, select: { equals: "proposed" } },
      { property: MEMORY_PROPS.KIND, select: { does_not_equal: "decision" } },
    ],
  }
}

const MEMORY_RELATION_PROPERTIES = [
  MEMORY_PROPS.PROJECT,
  MEMORY_PROPS.TOPIC,
  MEMORY_PROPS.SUPERSEDES,
  MEMORY_PROPS.AFFECTS,
  MEMORY_PROPS.COMPARED_WITH,
] as const

export async function hydrateMemoryRelationProperties(
  client: Client,
  page: PageObjectResponse
): Promise<PageObjectResponse> {
  return hydrateRelationProperties(client, page, MEMORY_RELATION_PROPERTIES)
}

export async function hydrateMemoryRelationPropertiesForPages(
  client: Client,
  pages: readonly PageObjectResponse[]
): Promise<PageObjectResponse[]> {
  return hydrateRelationPropertiesForPages(client, pages, MEMORY_RELATION_PROPERTIES)
}

/**
 * Every plain-text field that flows through the agent boundary and lands
 * in a Memory page. Run them through `decodeTextEntities` before writing
 * so doubly-encoded autosave input (`&amp;amp;`) resolves to plain text
 * and future similarity / embedding surfaces see consistent values.
 * Sibling: `decodeDecisionTextFields` — keep shared field coverage
 * in lockstep.
 *
 * Coverage is deliberately explicit rather than derived from
 * `CreateMemoryInput` so a future plain-text field addition fails the
 * type-check here and forces a decision about whether to decode. If the
 * coverage ever diverges from `CreateMemoryInput`'s rich_text shape, the
 * drift stays visible in the compiler rather than in a downstream
 * similarity regression.
 */
function decodeMemoryTextFields(input: CreateMemoryInput): {
  title: string
  content: string
  alternatives: string | undefined
  consequences: string | undefined
  author: string | undefined
  agent: string | undefined
  keywords: string | undefined
  synopsis: string | undefined
  session: string | undefined
  blockedBy: string | undefined
  entity: string | undefined
} {
  return {
    title: decodeTextEntities(input.title),
    content: input.content ? decodeTextEntities(input.content) : "",
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
    blockedBy:
      input.blockedBy !== undefined ? decodeTextEntities(input.blockedBy) : undefined,
    entity: input.entity !== undefined ? decodeTextEntities(input.entity) : undefined,
  }
}

/**
 * Partial-update variant. Every field that might be passed gets the
 * decoder; `undefined` propagates so the update path can distinguish
 * "leave untouched" from "explicitly set to empty string".
 *
 * `UpdateMemoryInput` currently omits `author`, `agent`, and `session`
 * because those fields aren't exposed on the update path. If a future
 * change adds them, also extend this helper's return shape and the
 * corresponding `if (decoded.X !== undefined)` branches in `update()`.
 * The structural-literal typing keeps that coupling visible to the
 * type-checker rather than silent.
 */
function decodeUpdateTextFields(input: UpdateMemoryInput): {
  title: string | undefined
  content: string | undefined
  alternatives: string | undefined
  consequences: string | undefined
  keywords: string | undefined
  synopsis: string | undefined
  blockedBy: string | undefined
  entity: string | undefined
} {
  return {
    title: input.title !== undefined ? decodeTextEntities(input.title) : undefined,
    content: input.content !== undefined ? decodeTextEntities(input.content) : undefined,
    alternatives:
      input.alternatives !== undefined
        ? decodeTextEntities(input.alternatives)
        : undefined,
    consequences:
      input.consequences !== undefined
        ? decodeTextEntities(input.consequences)
        : undefined,
    keywords:
      input.keywords !== undefined ? decodeTextEntities(input.keywords) : undefined,
    synopsis:
      input.synopsis !== undefined ? decodeTextEntities(input.synopsis) : undefined,
    blockedBy:
      input.blockedBy !== undefined ? decodeTextEntities(input.blockedBy) : undefined,
    entity: input.entity !== undefined ? decodeTextEntities(input.entity) : undefined,
  }
}

/**
 * Thrown by `MemoryService.recordReview` when the target row's
 * current `Status` is not `"proposed"`. The
 * approve / reject actions are inbox-only — applying them to an
 * already-accepted, rejected, or otherwise non-proposed row would
 * be a state error that masquerades as a no-op. Callers route
 * through this distinct subclass so the MCP / CLI surfaces can
 * render an actionable error pointing at `lore-memory
 * action='update' status='<value>'` for direct status flips.
 */
export class MemoryReviewStateError extends LoreError<"memory-review-state"> {
  readonly memoryId: string
  readonly currentStatus: MemoryStatus

  constructor(
    message: string,
    details: { memoryId: string; currentStatus: MemoryStatus }
  ) {
    super("memory-review-state", message, {
      memoryId: details.memoryId,
      currentStatus: details.currentStatus,
    })
    this.name = "MemoryReviewStateError"
    this.memoryId = details.memoryId
    this.currentStatus = details.currentStatus
  }
}

/**
 * Thrown by `MemoryService.recordReview` when the `Status` property
 * write succeeded but the body audit-block append failed. Same
 * partial-state shape as `RekeyAuditError`: the load-bearing
 * status flip is durable; the cosmetic audit trail is what's
 * missing. A retry rejects with `MemoryReviewStateError` because
 * the row's `Status` has already moved off `"proposed"`. See
 * `recordReview`'s docstring for the full failure-mode rationale.
 */
export class MemoryReviewAuditError extends LoreError<"memory-review-audit-failed"> {
  readonly memoryId: string
  readonly previousStatus: MemoryStatus
  readonly newStatus: MemoryStatus
  readonly cause: unknown

  constructor(
    message: string,
    details: {
      memoryId: string
      previousStatus: MemoryStatus
      newStatus: MemoryStatus
      cause: unknown
    }
  ) {
    super(
      "memory-review-audit-failed",
      message,
      {
        memoryId: details.memoryId,
        previousStatus: details.previousStatus,
        newStatus: details.newStatus,
        causeMessage: errorCauseMessage(details.cause),
      },
      { cause: details.cause }
    )
    this.name = "MemoryReviewAuditError"
    this.memoryId = details.memoryId
    this.previousStatus = details.previousStatus
    this.newStatus = details.newStatus
    this.cause = details.cause
  }
}

/**
 * Structured partial-state error raised by the MCP-layer
 * `lore-memory action='update'` handler when a combined
 * `topicKey + content` update has the content delta land
 * successfully but the subsequent re-key reject. The content
 * mutation is durable on Notion; the re-key did not occur.
 *
 * Distinct from `RekeyAuditError`, which signals "re-key persisted
 * but audit trail missing." A `PartialUpdateError` is the inverse:
 * "content delta persisted, re-key did NOT happen." Callers that
 * need to distinguish the two cases use `instanceof`.
 *
 * Common causes: a transient Notion property-write failure during
 * `rekeyTopicKey`'s `pages.update`, a race where another agent
 * grabbed the topic-key slot between preflight and the mutation,
 * or a content-update that changed `projectIds` and exposed a new
 * collision under the post-update set. The preflight in
 * `handleUpdate` catches the most common validation failures
 * (collision against pre-update state, empty-projectIds) before
 * the content update runs; this error covers the residual cases
 * where the preflight passed but the mutation still rejected.
 */
export class PartialUpdateError extends LoreError<"memory-update-partial"> {
  readonly memoryId: string
  readonly contentApplied: true
  readonly rekeyError: unknown

  constructor(message: string, details: { memoryId: string; rekeyError: unknown }) {
    super(
      "memory-update-partial",
      message,
      {
        memoryId: details.memoryId,
        contentApplied: true,
        rekeyCauseMessage: errorCauseMessage(details.rekeyError),
      },
      { cause: details.rekeyError }
    )
    this.name = "PartialUpdateError"
    this.memoryId = details.memoryId
    this.contentApplied = true
    this.rekeyError = details.rekeyError
  }
}

/**
 * Structured partial-state error raised by `MemoryService.update`
 * when the Notion property update lands but the body markdown write
 * fails afterward. The durable hazard is asymmetry: title/tags/status
 * or other state-like properties may now reflect the attempted update
 * while the body remains at its prior value, so a caller should inspect
 * before repeating non-idempotent property transitions.
 *
 * The literal `failedPhase` / `persisted` fields intentionally mirror
 * the class name so structured in-process callers do not need to parse
 * the message. The message is prefixed with the class name because MCP
 * transports flatten errors to text.
 */
export class MemoryUpdatePartialFailureError extends LoreError<"memory-update-body-partial"> {
  readonly memoryId: string
  readonly failedPhase: "body"
  readonly persisted: { readonly properties: true; readonly body: false }
  readonly bodyWriteError: unknown

  constructor(message: string, details: { memoryId: string; bodyWriteError: unknown }) {
    const prefixedMessage = message.startsWith("MemoryUpdatePartialFailureError: ")
      ? message
      : `MemoryUpdatePartialFailureError: ${message}`
    super(
      "memory-update-body-partial",
      prefixedMessage,
      {
        memoryId: details.memoryId,
        failedPhase: "body",
        persisted: { properties: true, body: false },
        bodyWriteCauseMessage: errorCauseMessage(details.bodyWriteError),
      },
      { cause: details.bodyWriteError }
    )
    this.name = "MemoryUpdatePartialFailureError"
    this.memoryId = details.memoryId
    this.failedPhase = "body"
    this.persisted = { properties: true, body: false }
    this.bodyWriteError = details.bodyWriteError
  }
}

/**
 * Structured partial-state error raised by `MemoryService.create`
 * when the `pages.create` call landed (a Memories DB row exists) but
 * the follow-up `pages.updateMarkdown` body-write rejected. Notion's
 * SDK splits memory creation across two calls — properties first, body
 * second — and a failure between them would otherwise leave a
 * properties-only orphan in the vault that a naive retry would
 * duplicate rather than reuse.
 *
 * **Strategy: best-effort archive, then structured error.** Three
 * options were on the table when this surface was added:
 *
 * 1. *Archive/delete the orphan and throw a structured error.* The
 * chosen path. Matches `MemoryService.archive`'s soft-delete
 * posture — the row is removed from queries but remains
 * inspectable in Notion's trash, preserving audit signal for
 * operators triaging a partial-failure burst. Idempotent on the
 * hot path (a successful retry creates a fresh row, no
 * duplicate-resolution needed).
 * 2. *Throw a structured error without cleanup.* Rejected because the
 * issue's acceptance criterion is "no silently-unrecoverable
 * orphan." Naive callers retrying the same `lore-memory
 * action='save'` would land a duplicate row alongside the orphan
 * until an operator manually archived the original.
 * 3. *Idempotency key / session-aware retry path.* Rejected because
 * it would extend the schema with a new column (or co-opt an
 * existing one) for a defensive guardrail that fires on a rare
 * transient failure mode. Heavyweight relative to the bug.
 *
 * The cleanup is best-effort: a second failure leaves the orphan
 * live and surfaces as `cleanedUp: false` so the operator finishes
 * what the system couldn't.
 *
 * The `cleanedUp` flag distinguishes the two surviving partial-state
 * shapes:
 *
 * - **`cleanedUp: true`** — the orphan row is soft-deleted on Notion.
 * The vault is consistent with "create never happened" from a query
 * perspective; a retry of the original operation will create a fresh
 * row without any operator action. The error still surfaces so the
 * caller can decide whether to retry or surface the body-write
 * failure to the user.
 * - **`cleanedUp: false`** — both the body-write AND the cleanup
 * archive failed. The properties-only row remains live in the vault.
 * A retry without operator intervention would create a duplicate
 * row. The `pageId` field names the orphan; `cleanupError` carries
 * the archive failure so an operator can act on it directly.
 *
 * The `bodyWriteError` field is always populated and carries the
 * underlying `updateMarkdown` failure that triggered the partial
 * state. Distinct from `cleanupError`, which is `undefined` on
 * `cleanedUp: true`.
 *
 * **Auto-mentions / decided_by fact emission is correctly skipped on
 * partial failure.** Fact emission for `mentions` and `decided_by`
 * (decision auto-edges) is a sibling-of-create concern at the MCP
 * handler layer — those handlers fire fact creates AFTER
 * `services.memories.create` resolves so the `Source` relation can
 * point at the just-created row. A `MemoryCreatePartialFailureError`
 * thrown inside `create()` escapes the handler's `await` before fact
 * emission runs, so no orphan facts pointing at an archived (or
 * partially-archived) source land. Confirmed correct by inspection;
 * not load-bearing on any test in this file.
 *
 * Distinct from `RekeyAuditError` ("re-key persisted, audit missing")
 * and `PartialUpdateError` ("content delta persisted, re-key did not
 * happen"). Callers branch on `instanceof` to distinguish the three
 * shapes.
 */
export class MemoryCreatePartialFailureError extends LoreError<"memory-create-partial"> {
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
    super(
      "memory-create-partial",
      message,
      {
        pageId: details.pageId,
        cleanedUp: details.cleanedUp,
        bodyWriteCauseMessage: errorCauseMessage(details.bodyWriteError),
        ...(details.cleanupError !== undefined
          ? { cleanupCauseMessage: errorCauseMessage(details.cleanupError) }
          : {}),
      },
      { cause: details.bodyWriteError }
    )
    this.name = "MemoryCreatePartialFailureError"
    this.pageId = details.pageId
    this.cleanedUp = details.cleanedUp
    this.bodyWriteError = details.bodyWriteError
    this.cleanupError = details.cleanupError
  }
}

export interface MemoryCreateResult {
  memory: Memory
  autosaveLearningDuplicate: AutosaveLearningDuplicateMatch | null
  freshCreatePreparation: FreshCreatePreparation | null
}

/**
 * Filter / pagination / sort options accepted by `MemoryService.list`.
 * Extracted to a named type so the method's overload signatures can
 * intersect it with literal `includeContent` narrowings — see the
 * three overloads on `list()` and the `MemoryWithoutContent` shape
 * in `src/types.ts` for the absent-body type contract.
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
   *
   * Mutually exclusive with `kind` semantically (a server-side
   * `equals` already narrows to one kind). The two compose
   * literally — `kind: "note"` AND `excludeKinds: ["decision"]`
   * is well-formed but redundant — but no caller passes both.
   *
   * Notion's `does_not_equal` is permissive on null, so a row
   * with no `Kind` column set passes the filter unless it
   * happens to match a listed exclusion (it can't, since null is
   * not equal to any literal). Matches the inbox-status filter
   * posture.
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
  /**
   * Opt in to fetching each page's markdown body. Default behavior
   * (omitted or `false`) returns rows with `content: ""` and issues
   * zero `pages.retrieveMarkdown` calls. Setting `true` fans out
   * one `pages.retrieveMarkdown` per row, paced by the shared
   * outbound rate-limit bucket — list views that render only title /
   * project / date / tags should leave the flag unset and pay
   * nothing. Callers that genuinely need bodies (the digest
   * synthesizer's recent-memory preview, the wake-up renderer's
   * stored-digest body, the autosave-learning duplicate probe)
   * pass `true` explicitly.
   *
   * The return type narrows on the literal value: `includeContent:
   * true` resolves to `Memory[]`; omitted or `includeContent: false`
   * resolves to `MemoryWithoutContent[]` whose `content` field is
   * the empty-string literal type `""`. A caller-controlled
   * `boolean` value cannot be statically narrowed and falls back to
   * `Memory[]` (the safe widening for the runtime fan-out).
   */
  includeContent?: boolean
  /**
   * When false, scope project queries to memories explicitly linked to the
   * given project, excluding repo-wide/unscoped entries.
   */
  includeUnscoped?: boolean
  /**
   * When `true`, do NOT exclude `Status = proposed` rows from the
   * result set. The default (`false`) adds a server-side
   * `does_not_equal: "proposed"` filter on the Status column so
   * proposed-memory inbox rows do not pollute default recall paths.
   *
   * Explicit `status` wins: when the caller passes `status:
   * "proposed"` (the inbox-review path), `includeProposed` is
   * irrelevant — the row passes via the explicit `equals` filter
   * regardless of the default exclusion.
   *
   * Set `true` for code paths that need to see every memory
   * regardless of review state — e.g. `lore mine`'s upsert
   * idempotency lookup (a re-mine must match a prior proposed
   * row), the conflict scanner (operates on every live row), or
   * the inbox-review CLI / MCP flows.
   */
  includeProposed?: boolean
  /**
   * Notion timestamp field to sort by. Defaults to `last_edited_time`
   * (general-purpose "most recently touched"). Pass `created_time` for
   * "most recently created" ordering — e.g. latest-digest lookup.
   */
  sortBy?: "created_time" | "last_edited_time"
  /**
   * Sort direction. Defaults to `"descending"` (newest first) —
   * matches Notion's recency-default. Pass `"ascending"` for
   * oldest-first ordering, e.g. the proposed-memory inbox surface
   * where stale review debt should surface ahead of recent
   * additions.
   */
  direction?: "ascending" | "descending"
  /**
   * Opaque cursor from a previous page's `nextCursor`. When provided,
   * continues enumeration from where that page ended. The filter/sort
   * must match the originating query — Notion returns the cursor's
   * contents under the assumption the query shape is unchanged.
   */
  startCursor?: string
  /**
   * When `true`, skip the default scope filter — every
   * scope kind surfaces, expired rows surface, and the resolved
   * `MemoryScopeContext` is ignored. Defaults to `false`.
   *
   * Operator-facing audit paths (`lore status` expiring-rows
   * surface, conflict scan, near-duplicate probe pool) opt in.
   * Agent-facing recall paths leave it unset so a session-scoped
   * row from another session never leaks into default retrieval.
   */
  includeOutOfScope?: boolean
}

export class MemoryService {
  private readonly features: LoreFeatureFlags

  /**
   * `getTitleById` is the hot path for UUID→title resolution in
   * `render.ts:resolveTitles` and `lore-context action='wake-up'`. A 25-UUID wake-up without
   * this cache pays 25 Notion `pages.retrieve` calls even if the same IDs
   * were just resolved a few seconds earlier. The cache is keyed on the
   * memory id so `Kind = decision` pages (which also live in Memories DB)
   * cache alongside plain notes.
   *
   * Value type is `string | null` — null is a cacheable tombstone for
   * IDs that are archived, 404, or permission-scoped. Repeated wake-ups
   * over a stable ID set then stop hitting Notion for the missing ones
   * too, satisfying the "25-UUID wake-up twice → zero retrieve calls on
   * the second run" acceptance criterion. Tombstones are committed via
   * `LruCache.getOrLoad`'s `cacheNegatives: true` option, which
   * distinguishes a known-absent loader return (`null`) from a transient
   * error (loader throws). Errors clear the slot without caching, so a
   * 429 / 5xx blip still re-dispatches on the next read.
   *
   * Stampede-safe via `LruCache.getOrLoad`: N concurrent cold-start
   * misses on the same id share one `pages.retrieve` — the second and
   * later callers await the first loader's promise.
   *
   * **Read/write race handling.** Writers (`update`, `archive`) wrap
   * their `pages.update` round-trip in `titleCache.delete(id)` (pre-write,
   * to flush any in-flight loader's pending slot) and `titleCache.set(id,
   * resolved)` (post-write, to install the authoritative new value).
   * `LruCache.set` itself drops `pending[key]` so a stale loader's
   * `getOrLoad` commit is suppressed by the identity guard at
   * `cache.ts:` — closing both the dispatched-before-write and
   * dispatched-during-write races without a per-service epoch counter.
   * Pre-PF1-09 this race protection lived here as a `writeEpoch`
   * monotonic counter with sandwich-bump discipline; folding the
   * invariant into `LruCache.set` collapsed ~30 lines of bespoke code
   * onto the shared primitive.
   *
   * **One-shot staleness per concurrent reader.** A reader whose
   * loader's `pages.retrieve` straddles the writer's `delete → update →
   * set` window resolves with the pre-write page (reads do not block
   * on writes). The reader's `getOrLoad` commit is suppressed by the
   * identity guard, so the writer's post-write value stays cached.
   * The reader's caller still sees the stale value once; the next
   * read on any id finds fresh in the cache. This is the same
   * tradeoff `LruCache.getOrLoad` applies to every consumer — readers
   * never fail because of a concurrent write.
   */
  private readonly titleCache = new LruCache<string, string | null>(
    TITLE_CACHE_MAX,
    TITLE_CACHE_TTL_MS,
    { cacheNegatives: true }
  )

  /**
   * Resolved scope context for this process. Threaded into every
   * default-retrieval path so default reads exclude narrow-scope
   * rows whose `scopeKey` does not match the reader's matching
   * identity slot. A missing context (default `{}`) means
   * "no narrow scopes ever surface" — only broadcast scopes plus
   * rows without a declared scope. Production callers populate this
   * in `initServices` from environment variables, the active project,
   * and the auth identity; tests default to empty.
   */
  private scopeCtx: MemoryScopeContext = {}
  private readonly pinned: MemoryPinned
  private readonly confidence: MemoryConfidence
  private readonly topicKey: MemoryTopicKey
  private readonly compare: MemoryCompare
  private readonly searcher: MemorySearch

  /**
   * Whether default-retrieval paths should apply the scope filter.
   * Opt-in: a caller that constructs `MemoryService` without an
   * explicit `scopeCtx` argument gets the no-scope retrieval shape
   * (no scope clause, no expiry clause). Production
   * `initServicesFromConfig` always passes a context (possibly
   * empty), turning the filter on for every real-vault read.
   * Tests construct services without scope context and stay on the
   * no-scope shape unless they explicitly opt in via
   * `setScopeContext`.
   */
  private scopeFilterEnabled = false

  constructor(
    private client: Client,
    private db: DatabaseRef,
    scopeCtx?: MemoryScopeContext,
    options?: { features?: LoreFeatureFlags }
  ) {
    this.features = options?.features ?? resolveFeatureFlags()
    this.pinned = new MemoryPinned(
      client,
      db,
      () => this.scopeCtx,
      () => this.scopeFilterEnabled,
      (pages, includeContent) => this.materializeMemories(pages, includeContent)
    )
    this.confidence = new MemoryConfidence(client, db, (page, content) =>
      this.pageToMemory(page, content)
    )
    this.topicKey = new MemoryTopicKey(client, db, this.features, {
      create: (input) => this.create(input),
      getById: (id) => this.getById(id),
      pageToMemory: (page, content) => this.pageToMemory(page, content),
      titleCache: this.titleCache,
    })
    this.compare = new MemoryCompare(client)
    this.searcher = new MemorySearch(
      client,
      db,
      this.features,
      () => this.scopeCtx,
      () => this.scopeFilterEnabled,
      (pages, includeContent) => this.materializeMemories(pages, includeContent)
    )
    if (scopeCtx) {
      this.scopeCtx = scopeCtx
      this.scopeFilterEnabled = true
    }
  }

  /**
   * Replace the scope context after construction. Used by tests and
   * by the `initServices` seam when scope context resolution depends
   * on Notion calls that can't run synchronously in the constructor.
   * Calling this enables the scope filter on subsequent reads.
   */
  setScopeContext(ctx: MemoryScopeContext): void {
    this.scopeCtx = ctx
    this.scopeFilterEnabled = true
  }

  /** Snapshot of the active scope context. Read-only — callers
   * cannot mutate it. Threaded into MCP audit responses so an
   * operator triaging "why don't I see this row?" can confirm
   * which identity slots resolved. */
  getScopeContext(): Readonly<MemoryScopeContext> {
    return this.scopeCtx
  }

  private isMemoryPageParent(parent: PageObjectResponse["parent"]): boolean {
    if (parent.type === "database_id") {
      return parent.database_id === this.db.databaseId
    }
    if (parent.type === "data_source_id") {
      return parent.data_source_id === this.db.dataSourceId
    }
    return false
  }

  private requireLiveMemoryPage(page: unknown, id: string): PageObjectResponse {
    if (!isFullPage(page as Parameters<typeof isFullPage>[0])) {
      throw new Error(`Memory ${id} did not resolve to a full page.`)
    }
    const fullPage = page as PageObjectResponse
    if (fullPage.archived) {
      throw new Error(`Memory ${id} is archived.`)
    }
    if (!this.isMemoryPageParent(fullPage.parent)) {
      throw new Error(`Memory ${id} is not in the Memories database.`)
    }
    return fullPage
  }

  async create(input: CreateMemoryInput): Promise<Memory> {
    return (await this.createWithResult(input)).memory
  }

  async createWithResult(input: CreateMemoryInput): Promise<MemoryCreateResult> {
    validateRichTextMetadataFields(input, "MemoryService.create")

    const duplicateConfig = this.autosaveLearningDuplicateConfig(input)
    const lockKey = duplicateConfig
      ? `autosave-learning:${duplicateConfig.scope}:` +
        (duplicateConfig.scope === "project"
          ? duplicateConfig.projectIds.join(",")
          : `${duplicateConfig.scopeId ?? "global"}\0${duplicateConfig.session}`)
      : null

    return await withAutosaveLearningLock(lockKey, async () => {
      if (duplicateConfig) {
        const decoded = decodeMemoryTextFields(input)
        const duplicate = await findAutosaveLearningDuplicate(this, {
          title: decoded.title,
          content: decoded.content,
          projectId: duplicateConfig.projectIds[0],
          projectIds: duplicateConfig.projectIds,
          session: duplicateConfig.session,
          scope: duplicateConfig.scope,
          features: this.features,
        })
        if (duplicate) {
          return {
            memory: duplicate.memory,
            autosaveLearningDuplicate: duplicate,
            freshCreatePreparation: null,
          }
        }
      }

      const freshCreatePreparation = input.prepareFreshCreate
        ? await input.prepareFreshCreate()
        : null
      const freshInput = freshCreatePreparation
        ? { ...input, ...freshCreatePreparation.input }
        : input
      const memory = await this.createFresh(freshInput)
      if (duplicateConfig) {
        await this.waitForAutosaveLearningIndexStability(
          duplicateConfig,
          memory,
          freshInput
        )
      }

      return {
        memory,
        autosaveLearningDuplicate: null,
        freshCreatePreparation,
      }
    })
  }

  private autosaveLearningDuplicateConfig(
    input: CreateMemoryInput
  ):
    | { scope: "session"; session: string; projectIds: string[]; scopeId: string | null }
    | { scope: "project"; session: string; projectIds: string[]; scopeId: string | null }
    | null {
    if (
      input.autosaveLearningDedupScope === "off" ||
      !this.features.autosaveLearningDedup ||
      !this.features.nearDuplicateProbe
    ) {
      return null
    }
    if ((input.source ?? "manual") !== "conversation") return null
    if ((input.kind ?? "note") !== "note") return null
    if (input.confidence !== "likely") return null

    const session = input.session?.trim()
    if (!session) return null

    const projectIds = [...new Set(input.projectIds ?? [])].sort()
    const requestedScope =
      input.autosaveLearningDedupScope ?? (projectIds.length > 0 ? "project" : "session")
    const scope =
      requestedScope === "project" && projectIds.length > 0 ? "project" : "session"
    const scopeId = input.autosaveLearningScopeId?.trim() || null

    return { scope, session, projectIds, scopeId }
  }

  private async waitForAutosaveLearningIndexStability(
    duplicateConfig:
      | {
          scope: "session"
          session: string
          projectIds: string[]
          scopeId: string | null
        }
      | {
          scope: "project"
          session: string
          projectIds: string[]
          scopeId: string | null
        },
    memory: Memory,
    input: CreateMemoryInput
  ): Promise<void> {
    const timeoutMs = autosaveLearningPostCreateStabilizeMs()
    if (timeoutMs <= 0) return

    const decoded = decodeMemoryTextFields(input)
    const deadline = Date.now() + timeoutMs
    while (true) {
      try {
        const visible = await findAutosaveLearningDuplicate(this, {
          title: decoded.title,
          content: decoded.content,
          projectId: duplicateConfig.projectIds[0],
          projectIds: duplicateConfig.projectIds,
          session: duplicateConfig.session,
          scope: duplicateConfig.scope,
          features: this.features,
        })
        if (visible?.id === memory.id) return
      } catch {
        // The memory already landed. A transient read-side failure should not
        // convert the successful create into a partial failure; future writers
        // still fail closed on their own duplicate probe while Notion recovers.
      }

      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) return
      await sleep(Math.min(AUTOSAVE_LEARNING_POST_CREATE_POLL_MS, remainingMs))
    }
  }

  private async createFresh(input: CreateMemoryInput): Promise<Memory> {
    // Decode at the write boundary so doubly-encoded values from the
    // autosave/markdown path land in Notion as plain text. Idempotent: a
    // clean value passes through unchanged. Covers every plain-text
    // field that flows through the agent boundary — title, content body,
    // and the rich_text fields that downstream similarity/embedding
    // surfaces (near-duplicate probe, entity canonicalization,
    // DS-scoped search) will read.
    const decoded = decodeMemoryTextFields(input)
    const createsPinnedBlock = input.pinned?.pinned === true
    await this.pinned.preflightCreate(input.pinned)

    // Create the page with properties only
    const page = await this.client.pages.create({
      parent: { type: "database_id", database_id: this.db.databaseId },
      properties: buildMemoryProps({
        title: decoded.title,
        projectIds: input.projectIds,
        topicId: input.topicId,
        source: input.source ?? "manual",
        kind: input.kind,
        status: input.status,
        confidence: input.confidence,
        confidenceScore: input.confidenceScore,
        reviewBy: input.reviewBy,
        decidedAt: input.decidedAt,
        lastReferencedAt: input.lastReferencedAt,
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
        taskState: input.taskState,
        blockedBy: decoded.blockedBy,
        entity: decoded.entity,
        topicKey: input.topicKey,
        revisionCount: input.revisionCount,
        ...scopeInputToBuilderProps(input.scope),
        ...pinnedInputToBuilderProps(input.pinned),
      }),
    })
    if (createsPinnedBlock) {
      this.pinned.invalidateCountCache()
    }

    // Write content via markdown API. The SDK splits memory creation
    // across two calls — properties above, body below — so a rejection
    // here would otherwise leave a properties-only orphan that a naive
    // retry would duplicate. Best-effort archive the orphan, then
    // surface a structured error carrying enough state for the caller
    // to retry safely or surface the failure to the operator. See
    // `MemoryCreatePartialFailureError`.
    if (decoded.content) {
      try {
        await this.client.pages.updateMarkdown({
          page_id: page.id,
          type: "insert_content",
          insert_content: { content: decoded.content },
        })
      } catch (bodyWriteError) {
        // Direct `pages.update` rather than `MemoryService.archive()`:
        // the page was just created in this same call, so the
        // title-cache delete-then-tombstone-set discipline `archive()`
        // performs to protect concurrent readers cannot apply — no
        // consumer has had time to cache the title or dispatch a
        // racing read against this id. Inlining keeps the cleanup a
        // single round-trip with no incidental cache work.
        //
        // Cleanup writes BOTH `archived: true` AND the
        // `MEMORY_CLEANUP_ORPHAN_SENTINEL` keyword in one atomic
        // `pages.update`. Notion's archive is soft —
        // within ~30 days the orphan can be restored from the workspace
        // trash, at which point `isLiveFullPage` stops excluding it.
        // The sentinel keyword survives archive/restore round-trips and
        // is the load-bearing signal for `findByTopicKey`,
        // `findNearDuplicates`, and `findAutosaveLearningDuplicate`
        // ignoring the resurfaced empty-body shell. Combining the two
        // mutations into one request closes the window where archive
        // succeeds but the sentinel write fails — Notion's per-request
        // atomicity guarantees both land or neither does.
        //
        // **Keyword preservation**. Notion's `rich_text` writes are
        // full-replace, not append. Writing only the sentinel would
        // clobber whatever the caller passed in `decoded.keywords`,
        // which an operator inspecting Notion's trash would see as
        // "your original keywords are gone" — the sentinel and the
        // user's content. Concatenating preserves both: the sentinel
        // substring still satisfies the `does_not_contain` /
        // `keywords.includes` filters, and the original keywords
        // remain visible if the operator restores the row to recover
        // content. Use a single-space separator so the sentinel is
        // word-tokenizable in any future tag-aware view; an empty
        // existing keywords field collapses to bare-sentinel.
        //
        // **Multi-segment write at the cap edge**. Notion's per-block
        // `rich_text` segment cap is 2000 chars
        // (`RICH_TEXT_PROPERTY_MAX_LEN`), and the MCP boundary's
        // `keywordsSchema` accepts keywords up to exactly that cap.
        // Concatenating ` __lore-cleanup-orphan` (22 chars) onto a
        // 2000-char keyword string would produce a 2022-char single
        // segment that Notion rejects with a validation error. A
        // rejected cleanup write means `cleanedUp = false` and the
        // orphan stays live in the vault — exactly the partial-failure
        // recovery regression the sentinel-write path is meant to
        // prevent. Splitting
        // into two segments — `[originalKeywords, " sentinel"]` —
        // keeps each segment well under the cap; `extractRichText`
        // joins them via empty-string concat, so the substring filter
        // (`does_not_contain` server-side, `keywords.includes`
        // client-side) still sees the unified `original sentinel`
        // string. Always use the two-segment form when keywords are
        // present so the at-cap edge is handled by the same code path
        // as the under-cap normal case — no segment-size math at write
        // time, no edge-case branching.
        const existingKeywords = decoded.keywords?.trim() ?? ""
        const cleanupKeywordsRichText: Array<{ text: { content: string } }> =
          existingKeywords.length > 0
            ? [
                { text: { content: existingKeywords } },
                { text: { content: ` ${MEMORY_CLEANUP_ORPHAN_SENTINEL}` } },
              ]
            : [{ text: { content: MEMORY_CLEANUP_ORPHAN_SENTINEL } }]
        let cleanedUp = false
        let cleanupError: unknown
        try {
          await this.client.pages.update({
            page_id: page.id,
            archived: true,
            properties: {
              [MEMORY_PROPS.KEYWORDS]: {
                rich_text: cleanupKeywordsRichText,
              },
            },
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
          ? `Memory create partial failure: the Memories DB row was ` +
            `created (page ${page.id}) but the body write failed: ${cause}. ` +
            `The orphan row was soft-archived to Notion's trash and its ` +
            `Keywords column carries the '${MEMORY_CLEANUP_ORPHAN_SENTINEL}' ` +
            `sentinel so dedup probes ignore it even if it is later restored ` +
            `from trash. Your retry will land cleanly regardless of whether ` +
            `you restore this row from trash later.`
          : `Memory create partial failure: the Memories DB row was ` +
            `created (page ${page.id}) but the body write failed: ${cause}. ` +
            `The cleanup archive also failed (${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }); the orphan row remains live in the vault. Archive it ` +
            `manually (or hard-delete from Notion's trash) before retrying ` +
            `to avoid a duplicate row.`
        throw new MemoryCreatePartialFailureError(message, {
          pageId: page.id,
          cleanedUp,
          bodyWriteError,
          cleanupError,
        })
      }
    }

    return await this.pageToMemory(page as PageObjectResponse, decoded.content ?? "")
  }

  async getById(id: string): Promise<Memory> {
    const [page, md] = await Promise.all([
      this.client.pages.retrieve({ page_id: id }),
      this.client.pages.retrieveMarkdown({ page_id: id }),
    ])
    return await this.pageToMemory(page as PageObjectResponse, md.markdown)
  }

  /**
   * Read a memory's properties without fetching its markdown body. Sibling
   * of `getById` that skips the `pages.retrieveMarkdown` round-trip —
   * issued exclusively for callers that need the property-tier shape
   * (`confidenceScore`, `lastReferencedAt`, `createdAt`, `confidence`,
   * `id`) and never read the body. The contradiction-decrement path
   * (`lore-fact action='invalidate'` → `decrementConfidence`) is the
   * canonical caller: every fact invalidation otherwise pays one extra
   * `retrieveMarkdown` round-trip for content the decrement algebra
   * never touches.
   *
   * The returned `Memory.content` is `""`. Callers that need the body
   * should use `getById` instead, or hydrate via `materializeContent`
   * after a `getPropertiesById` if both shapes are needed.
   *
   * The ID must point at a live page in the configured Memories database.
   * Accessible pages from sibling databases and archived memory rows are
   * rejected before they can masquerade as vault-wide memories via the
   * backward-compatible parser defaults.
   */
  async getPropertiesById(id: string): Promise<Memory> {
    const page = await this.client.pages.retrieve({ page_id: id })
    return await this.pageToMemory(this.requireLiveMemoryPage(page, id), "")
  }

  /**
   * Batched property-only reads. Issues one `pages.retrieve` per
   * **distinct** input ID via `Promise.all` and skips the
   * `pages.retrieveMarkdown` round-trip — `touchOnRead` reads
   * `confidenceScore` / `lastReferencedAt` / `confidence` / `createdAt`
   * off the in-memory row, all of which live in the page's properties
   * bag. The returned `Memory` shapes carry `content: ""`; callers
   * needing the body must use `getById` instead.
   *
   * The properties-only posture matters because the touch-on-read
   * wiring in `lore-query action='ask'` routes through here —
   * fetching markdown bodies the caller will discard would
   * double the Notion call budget on every ask response with cited
   * source memories.
   *
   * **Output ordering.** Returned memories preserve the input order of
   * their FIRST occurrence. Repeated IDs are deduped at the boundary
   * (collapsed to one fetch), so a caller passing `["a", "a"]` gets
   * `[Memory{a}]` once. Missing IDs (404 / archived / permission
   * errors) resolve to `null` and are filtered out, so a 404 on the
   * row at input position 2 of `[a, b, c]` returns `[Memory{a},
   * Memory{c}]` — output positions are 1:1 with input positions only
   * after the dedup + drop-failures filter has been applied.
   *
   * Callers that already hold materialized `Memory[]` (`recall` /
   * `search` / `expand` / wake-up loaders) should pass them directly
   * to `touchOnRead` instead of re-fetching here.
   */
  async getManyById(ids: ReadonlyArray<string>): Promise<Memory[]> {
    const seen = new Set<string>()
    const distinct: string[] = []
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      distinct.push(id)
    }
    const results = await Promise.all(
      distinct.map(async (id) => {
        try {
          const page = await this.client.pages.retrieve({ page_id: id })
          return await this.pageToMemory(this.requireLiveMemoryPage(page, id), "")
        } catch {
          return null
        }
      })
    )
    return results.filter((m): m is Memory => m !== null)
  }

  async findByTopicKey(input: FindByTopicKeyInput): Promise<Memory | null> {
    return await this.topicKey.findByTopicKey(input)
  }

  async upsertByTopicKey(input: TopicKeyUpsertInput): Promise<TopicKeyUpsertResult> {
    return await this.topicKey.upsertByTopicKey(input)
  }

  async validateRekey(input: RekeyTopicKeyInput): Promise<RekeyValidationResult> {
    return await this.topicKey.validateRekey(input)
  }

  async rekeyTopicKey(input: RekeyTopicKeyInput): Promise<RekeyTopicKeyResult> {
    return await this.topicKey.rekeyTopicKey(input)
  }

  /**
   * Record an inbox-review verdict on a proposed memory. The
   * caller is the human or authorized agent deciding whether the
   * auto-extracted learning belongs in the shared vault or not.
   *
   * Two verdicts:
   *
   * - **`approve`** — flips `Status` from `proposed` to `accepted`.
   * The row enters default recall on the next read pass.
   * - **`reject`** — flips `Status` from `proposed` to `rejected`.
   * The row stays out of default recall (the default-exclude
   * filters `proposed` only, but recall-shaped consumers should
   * continue ignoring `rejected` via their own status filtering).
   *
   * Both verdicts append a `## Reviewed (YYYY-MM-DD)` audit block to
   * the page body recording the verdict, the reviewer, the timestamp,
   * and an optional reason. Audit-block prefix differs from the
   * topic-key re-key prefix (`## Re-keyed`) so a future memory-history
   * renderer can distinguish lifecycle events from identity events
   * without parsing body text. The block is what a future operator
   * sees when inspecting why a row landed in its current state.
   *
   * **Status guard**: a non-proposed row throws
   * `MemoryReviewStateError`. The verdicts only make sense on the
   * inbox-state — applying them to an already-accepted row would be
   * a no-op masquerading as a real review event. Operators who want
   * to flip a non-proposed row's status use
   * `lore-memory action='update' status='<value>'` directly.
   *
   * **Property write FIRST, audit-block append SECOND** — same
   * partial-state posture as `rekeyTopicKey`. A property-write
   * success followed by an audit-write failure leaves the load-
   * bearing status flip in place; the cosmetic audit trail is what
   * gets lost. A retry observes `Status !== "proposed"` and rejects
   * with `MemoryReviewStateError`, surfacing the partial state to
   * the operator. The audit-failure path throws `MemoryReviewAuditError`
   * (a distinct subclass of `Error`) so callers can branch on
   * `instanceof` and disambiguate "review didn't happen" from
   * "review happened but audit is missing." Two distinct call sites
   * inside the audit-block envelope can fail and produce that same
   * partial state: the body fetch (`pages.retrieveMarkdown`, which
   * runs AFTER the status flip so guard-rejection paths skip the
   * round-trip entirely) and the body write (`pages.updateMarkdown`,
   * the actual audit append). Both share one `try/catch` and one
   * `MemoryReviewAuditError` envelope — the recovery contract is
   * identical (next retry rejects with `MemoryReviewStateError`),
   * so callers don't need to disambiguate which sub-step failed.
   *
   * **Concurrent reviews**: two operators racing on the same memory
   * can both observe `Status: proposed` and both call `recordReview`.
   * The second-to-write wins: the property update is per-request
   * atomic, so the row ends up with whichever verdict landed last.
   * Both audit blocks land on the body via separate `updateMarkdown`
   * calls — the trailing call's body read happens after the leading
   * call's write, so audit blocks accumulate without clobbering. A
   * future contributor adding stricter conflict detection would
   * route through a per-memory lock similar to the autosave-learning
   * gate; not needed today given low review concurrency.
   */
  async recordReview(input: {
    memoryId: string
    verdict: "approve" | "reject"
    reviewer: string
    reason?: string
  }): Promise<{ memory: Memory; previousStatus: MemoryStatus }> {
    // Properties-only fetch for the structural guards. `getPropertiesById`
    // skips the `pages.retrieveMarkdown` round-trip that `getById` would
    // pay for the body — the Status / Kind guards only inspect Notion
    // select properties, and the body is needed solely on the success
    // path for the audit-block append. Failing guards short-circuit
    // before the body fetch fires. Mirrors the `lore inbox archive`
    // status guard so both inbox-touching call sites share the
    // property-only-read posture.
    const memory = await this.getPropertiesById(input.memoryId)
    if (memory.status !== "proposed") {
      throw new MemoryReviewStateError(
        `Cannot ${input.verdict} memory ${input.memoryId}: ` +
          `current status is "${memory.status}", expected "proposed". ` +
          `The approve / reject actions are inbox-only — use ` +
          `\`lore-memory action='update' status='<value>'\` to flip a ` +
          `non-proposed row's status directly.`,
        {
          memoryId: input.memoryId,
          currentStatus: memory.status,
        }
      )
    }
    // Inbox contract is structural, not just UI: `proposedMemoryFilter()`
    // (the canonical inbox predicate) excludes `Kind = decision` because
    // proposed-state decisions are part of the decision lifecycle, not
    // the auto-extracted-learning inbox. Refusing here prevents an
    // operator or agent from running the memory-inbox approve / reject
    // path on a decision row and bypassing the decision surface that
    // owns governance (`lore-decision action='accept'` / `'supersede'`
    // / `'review'`). Same `proposedMemoryFilter()` "single source of
    // truth" contract that the count and listing surfaces honor.
    if (memory.kind === "decision") {
      throw new MemoryReviewStateError(
        `Cannot ${input.verdict} memory ${input.memoryId}: ` +
          `Kind is "decision". Decisions have their own lifecycle — ` +
          `use \`lore-decision action='supersede'\` to retire a ` +
          `decision or \`lore-decision action='review'\` to clear ` +
          `the proposed state. The memory-inbox approve / reject ` +
          `actions are limited to non-decision proposed memories.`,
        {
          memoryId: input.memoryId,
          currentStatus: memory.status,
        }
      )
    }

    const newStatus: MemoryStatus = input.verdict === "approve" ? "accepted" : "rejected"
    const trimmedReviewer = input.reviewer.trim()
    if (trimmedReviewer.length === 0) {
      throw new Error(
        `MemoryService.recordReview: reviewer must be a non-empty string. ` +
          `Resolve the engineer identity (LORE_USER_NAME env or ` +
          `services.identity.resolveAuthor()) before calling.`
      )
    }

    // Property write first — see the docstring above for the
    // partial-state rationale. Direct partial-property update; not
    // routed through `update()` to keep the title cache undisturbed
    // and avoid touching `Last Referenced At` (review is a write,
    // not a read citation).
    await this.client.pages.update({
      page_id: input.memoryId,
      properties: {
        [MEMORY_PROPS.STATUS]: { select: { name: newStatus } },
      } as CreatePageParameters["properties"],
    })

    const today = todayUtc()
    const reviewedAtIso = new Date().toISOString()
    const verdictLabel = input.verdict === "approve" ? "approved" : "rejected"
    // ISO 8601 timestamp on a separate `**Reviewed At:**` line so the
    // audit trail records reviewer and timestamp in Notion-visible
    // audit body. The heading keeps the date for human readability;
    // `Reviewed At` carries the durable wall-clock evidence so a
    // future audit walker can recover ordering / latency without
    // relying on Notion's `last_edited_time` (which any subsequent
    // edit overwrites).
    const auditLines = [
      "",
      "---",
      "",
      `## Reviewed (${today})`,
      "",
      `**Verdict:** ${verdictLabel}`,
      `**Reviewer:** ${trimmedReviewer}`,
      `**Reviewed At:** ${reviewedAtIso}`,
    ]
    const trimmedReason = input.reason?.trim() ?? ""
    if (trimmedReason.length > 0) {
      auditLines.push(`**Reason:** ${trimmedReason}`)
    }
    const auditBlock = auditLines.join("\n")

    // Body fetch + audit append are wrapped together: either a
    // failed `retrieveMarkdown` (after the status flip already
    // landed) or a failed `updateMarkdown` leaves the same partial
    // state — Status column updated, body audit missing — so they
    // share one `MemoryReviewAuditError` envelope. The body fetch
    // is deliberately deferred until AFTER the property write so
    // guard-rejection / property-write failures short-circuit
    // without paying for the body round-trip.
    let newBody: string
    try {
      const { markdown } = await this.client.pages.retrieveMarkdown({
        page_id: input.memoryId,
      })
      newBody = markdown + auditBlock
      await this.client.pages.updateMarkdown({
        page_id: input.memoryId,
        type: "replace_content",
        replace_content: {
          new_str: newBody,
          allow_deleting_content: true,
        },
      })
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err)
      throw new MemoryReviewAuditError(
        `Review persisted (status: proposed → ${newStatus}) but ` +
          `audit-block append failed: ${cause}. The Status column is ` +
          `updated; the body audit trail is missing. A retry will ` +
          `reject with MemoryReviewStateError because the row is no ` +
          `longer in proposed state. Inspect memory ${input.memoryId} ` +
          `on Notion and append the audit manually if needed.`,
        {
          memoryId: input.memoryId,
          previousStatus: memory.status,
          newStatus,
          cause: err,
        }
      )
    }

    return {
      memory: { ...memory, status: newStatus, content: newBody },
      previousStatus: memory.status,
    }
  }

  /**
   * Hydrate the markdown body for a memory whose properties are already
   * known. Sibling of `getById` that skips the `pages.retrieve` call —
   * issued exclusively for callers that just received the row from a
   * `MemoryService.search` / `MemoryService.list` pass with
   * `includeContent: false` and need the body without re-fetching the
   * page properties Notion already returned.
   *
   * Call-count math, motivated by `lore-task action='reconcile'`'s
   * internal-vault budget: routing reconcile's per-candidate hydration through
   * `getById` would issue `271 * 5 * 2 = 2710` Notion calls (half of
   * them re-fetching properties already returned by the index-tier
   * search). `materializeContent` issues exactly one
   * `pages.retrieveMarkdown` per call, bounding the budget to
   * `271 * 5 = 1355` calls.
   *
   * Propagates the underlying `pages.retrieveMarkdown` error on failure.
   * Callers that want graceful degradation to empty content (transient
   * 5xx, archived page, etc.) wrap the call in `.catch(() => ({ ...m,
   * content: "" }))`. Failure-handling lives at the caller because
   * different callers want different fallback shapes.
   */
  async materializeContent(memory: Memory): Promise<Memory> {
    const md = await this.client.pages.retrieveMarkdown({ page_id: memory.id })
    return { ...memory, content: md.markdown }
  }

  /**
   * Read a memory's `Title` property without fetching its markdown body.
   * Single `pages.retrieve` round-trip on a cold cache; hot-path hits
   * return synchronously from the in-process title cache. Used by
   * render-layer resolvers that only need a human-readable label for a
   * page ID. Returns `null` on not-found / archived / permission errors
   * so callers can fall through to the raw ID with a `(?)` hint. Works
   * across `Kind = decision` and every other memory kind — both live in
   * the Memories DB.
   *
   * **Caching discipline** — distinguishes two null-result regimes:
   * - *Known absent* (archived full page, 404 `ObjectNotFound`,
   * `RestrictedResource`): `fetchTitle` returns `null` and `getOrLoad`
   * commits a null tombstone. Repeated wake-ups over the same id set
   * stop re-fetching the same missing ids within the TTL window.
   * - *Transient failure* (401 / 429 / 5xx / network / unknown errors):
   * `fetchTitle` re-throws, `getOrLoad` rejects without caching, and
   * the try/catch below converts the rejection into `null` for the
   * caller. The slot is NOT cached, so the next caller retries.
   * Rate-limit / network blips therefore degrade to a single `(?)`
   * render, not a 60-second stretch of `(?)` labels. 401 is
   * deliberately not tombstoned — the auth-refresh rationale lives
   * on `fetchTitle`.
   */
  async getTitleById(id: string): Promise<string | null> {
    // Stampede dedup, TTL, LRU, negative-tombstone caching, and the
    // identity-guard that suppresses stale-loader commits during
    // concurrent writes are all owned by `LruCache.getOrLoad` —
    // see the class docstring for the race protection that replaced
    // the pre-PF1-09 bespoke `writeEpoch` + `pendingTitles` machinery.
    //
    // The loader throws on transient errors so `getOrLoad` propagates
    // the rejection without caching (no poisoned tombstone for a
    // 429 / network blip). We catch here and return null to preserve
    // `getTitleById`'s "never throws on read" public contract — the
    // caller sees a single `(?)` render and the next call retries.
    try {
      return await this.titleCache.getOrLoad(id, () => this.fetchTitle(id))
    } catch {
      return null
    }
  }

  private async fetchTitle(id: string): Promise<string | null> {
    // Distinguishing "known absent" from "transient" is load-bearing
    // under `cacheNegatives: true`:
    //
    // - Returning `null` commits a tombstone via `getOrLoad` so the
    // next read short-circuits without a Notion call.
    // - Throwing routes through `getOrLoad`'s rejection path, which
    // clears the pending slot without caching anything; the next
    // read re-fetches.
    //
    // Tombstone the id-level absence cases (404 ObjectNotFound,
    // RestrictedResource) and the archived-page case (Notion returns
    // a full PageObjectResponse with `archived: true`). Every other
    // error class re-throws and is treated as transient. Without
    // this, every wake-up over a stable id-set would re-issue
    // `pages.retrieve` for every dead id, paced by the outbound
    // rate-limit bucket — silently violating the "25-UUID wake-up
    // twice → zero retrieve calls on the second run" contract this
    // class advertises.
    //
    // `Unauthorized` (401) is deliberately NOT tombstoned: the
    // auth-refreshing SDK wrapper already attempts one auth refresh
    // on 401 and only surfaces the original error when refresh is
    // unavailable or the retry still fails. By the time a 401
    // reaches us it's a broad token-level signal, not a per-page
    // absence — caching it would poison every id resolved during a
    // bad-auth window for up to 60s after recovery.
    let page: Awaited<ReturnType<typeof this.client.pages.retrieve>>
    try {
      page = await this.client.pages.retrieve({ page_id: id })
    } catch (err) {
      if (
        isNotionClientError(err) &&
        (err.code === APIErrorCode.ObjectNotFound ||
          err.code === APIErrorCode.RestrictedResource)
      ) {
        return null
      }
      throw err
    }
    if (!isFullPage(page) || page.archived) return null
    const title = extractTitle(page.properties[MEMORY_PROPS.TITLE])
    return title || null
  }

  /** Drop the in-process title cache. Used by tests and by the
   * cross-service `clearServiceCaches()` helper. `LruCache.clear`
   * also drops any in-flight `getOrLoad` pending slots so test
   * fixtures start clean. */
  clearTitleCache(): void {
    this.titleCache.clear()
    // clear the pinned-count cache too on the
    // cross-service `clearServiceCaches()` reset so test fixtures
    // see a fresh count between cases.
    this.pinned.clearCountCache()
  }

  async update(id: string, input: UpdateMemoryInput): Promise<Memory> {
    validateRichTextMetadataFields(input, "MemoryService.update")

    await this.pinned.preflightUpdate(id, input)

    // Same decode-at-write discipline as `create`: encoded titles /
    // content / alternatives / consequences flowing in from re-saves of
    // autosave-rendered transcripts must land in Notion clean. Without
    // this, `update` would write encoded text around the freshly-decoded
    // rows `create` produces, re-opening the bug class PF1-06 closes.
    const decoded = decodeUpdateTextFields(input)
    const props: Record<string, unknown> = {}

    if (decoded.title !== undefined) {
      // Pre-write delete: clears the stored value AND drops any
      // in-flight `getOrLoad` pending slot, so a reader whose loader
      // is mid-`pages.retrieve` has its post-loader commit suppressed
      // by `getOrLoad`'s identity guard. The post-write `set` below
      // installs the authoritative value and (via `LruCache.set`'s
      // pending-clearing discipline) closes the dispatched-during-
      // write window for any reader that started after this delete.
      this.titleCache.delete(id)
      props[MEMORY_PROPS.TITLE] = { title: [{ text: { content: decoded.title } }] }
    }
    if (input.projectIds) {
      props[MEMORY_PROPS.PROJECT] = { relation: input.projectIds.map((id) => ({ id })) }
    }
    if (input.topicId) {
      props[MEMORY_PROPS.TOPIC] = { relation: [{ id: input.topicId }] }
    }
    if (input.tags) {
      props[MEMORY_PROPS.TAGS] = {
        multi_select: input.tags.map((t) => ({ name: t })),
      }
    }
    if (decoded.keywords !== undefined) {
      props[MEMORY_PROPS.KEYWORDS] = {
        rich_text: [{ text: { content: decoded.keywords } }],
      }
    }
    if (decoded.synopsis !== undefined) {
      props[MEMORY_PROPS.SYNOPSIS] = {
        rich_text: [{ text: { content: decoded.synopsis } }],
      }
    }
    if (input.kind) {
      props[MEMORY_PROPS.KIND] = { select: { name: input.kind } }
    }
    if (input.status) {
      props[MEMORY_PROPS.STATUS] = { select: { name: input.status } }
    }
    if (input.confidence) {
      props[MEMORY_PROPS.CONFIDENCE] = { select: { name: input.confidence } }
    }
    // See `buildMemoryProps` for the three-state rationale.
    if (input.confidenceScore !== undefined) {
      props[MEMORY_PROPS.CONFIDENCE_SCORE] =
        input.confidenceScore === null
          ? { number: null }
          : { number: input.confidenceScore }
    }
    // `null` explicitly clears a date; `undefined` leaves it untouched.
    // Strict `=== null` matches `buildMemoryProps`' shape so update and
    // create use one consistent rule for "is this a clear or a set?"
    if (input.reviewBy !== undefined) {
      props[MEMORY_PROPS.REVIEW_BY] =
        input.reviewBy === null ? { date: null } : { date: { start: input.reviewBy } }
    }
    if (input.decidedAt !== undefined) {
      props[MEMORY_PROPS.DECIDED_AT] =
        input.decidedAt === null ? { date: null } : { date: { start: input.decidedAt } }
    }
    if (input.lastReferencedAt !== undefined) {
      props[MEMORY_PROPS.LAST_REFERENCED_AT] =
        input.lastReferencedAt === null
          ? { date: null }
          : { date: { start: input.lastReferencedAt } }
    }
    if (input.supersedesIds) {
      props[MEMORY_PROPS.SUPERSEDES] = {
        relation: input.supersedesIds.map((id) => ({ id })),
      }
    }
    if (input.affectsIds) {
      props[MEMORY_PROPS.AFFECTS] = { relation: input.affectsIds.map((id) => ({ id })) }
    }
    if (decoded.alternatives !== undefined) {
      props[MEMORY_PROPS.ALTERNATIVES] = {
        rich_text: [{ text: { content: decoded.alternatives } }],
      }
    }
    if (decoded.consequences !== undefined) {
      props[MEMORY_PROPS.CONSEQUENCES] = {
        rich_text: [{ text: { content: decoded.consequences } }],
      }
    }
    if (input.taskState) {
      props[MEMORY_PROPS.TASK_STATE] = { select: { name: input.taskState } }
    }
    if (decoded.blockedBy !== undefined) {
      props[MEMORY_PROPS.BLOCKED_BY] = {
        rich_text: [{ text: { content: decoded.blockedBy } }],
      }
    }
    if (decoded.entity !== undefined) {
      props[MEMORY_PROPS.ENTITY] = {
        rich_text: [{ text: { content: decoded.entity } }],
      }
    }
    // Scope / lifetime. Mirror the `buildMemoryProps`
    // tristate semantics in the inlined update path so the column
    // writes are consistent across `create` and `update`. The update
    // path inlines the property writes (rather than calling
    // `buildMemoryProps`) because Notion's `pages.update` is a
    // partial update — we only emit columns the caller actually
    // touched.
    if (input.scope !== undefined) {
      const scope = input.scope
      if (scope.kind !== undefined) {
        props[MEMORY_PROPS.SCOPE_KIND] =
          scope.kind === null ? { select: null } : { select: { name: scope.kind } }
      }
      if (scope.key !== undefined) {
        props[MEMORY_PROPS.SCOPE_KEY] = {
          rich_text: [{ text: { content: scope.key } }],
        }
      }
      if (scope.audience !== undefined) {
        props[MEMORY_PROPS.AUDIENCE] = {
          rich_text: [{ text: { content: scope.audience } }],
        }
      }
      if (scope.lifetime !== undefined) {
        props[MEMORY_PROPS.LIFETIME] =
          scope.lifetime === null
            ? { select: null }
            : { select: { name: scope.lifetime } }
      }
      if (scope.expiresAt !== undefined) {
        props[MEMORY_PROPS.EXPIRES_AT] =
          scope.expiresAt === null ? { date: null } : { date: { start: scope.expiresAt } }
      }
    }

    // Pinned context block update. Mirrors the scope/
    // lifetime branch above — the update path inlines column writes
    // rather than calling `buildMemoryProps` because Notion's
    // `pages.update` is partial-update only. The checkbox column has
    // no clear sentinel; `priority` and `mutability` accept `null`
    // for the clear path.
    //
    // Priority is clamped to `[PINNED_PRIORITY_MIN, PINNED_PRIORITY_MAX]`
    // at the service boundary — the MCP Zod schema also clamps, but
    // the service-layer guard catches CLI / hook callers and is the
    // load-bearing protection against a malformed write.
    if (input.pinned !== undefined) {
      const pinnedInput = input.pinned
      if (pinnedInput.pinned !== undefined) {
        props[MEMORY_PROPS.PINNED] = { checkbox: pinnedInput.pinned }
        // Invalidate the in-process pinned-count cache so a same-process
        // pin / unpin sees the fresh count without waiting on the 30s TTL.
        this.pinned.invalidateCountCache()
      }
      if (pinnedInput.priority !== undefined) {
        props[MEMORY_PROPS.PINNED_PRIORITY] =
          pinnedInput.priority === null
            ? { number: null }
            : { number: clampPinnedPriority(pinnedInput.priority) }
      }
      if (pinnedInput.mutability !== undefined) {
        props[MEMORY_PROPS.MUTABILITY] =
          pinnedInput.mutability === null
            ? { select: null }
            : { select: { name: pinnedInput.mutability } }
      }
    }

    let propertiesApplied = false
    if (Object.keys(props).length > 0) {
      await this.client.pages.update({
        page_id: id,
        // Cast needed: we're building update props dynamically
        properties: props as CreatePageParameters["properties"],
      })
      propertiesApplied = true
    }

    if (decoded.content !== undefined) {
      try {
        await this.client.pages.updateMarkdown({
          page_id: id,
          type: "replace_content",
          replace_content: {
            new_str: decoded.content,
            allow_deleting_content: true,
          },
        })
      } catch (bodyWriteError) {
        if (!propertiesApplied) {
          throw bodyWriteError
        }
        if (decoded.title !== undefined) {
          this.titleCache.set(id, decoded.title || null)
        }
        const cause =
          bodyWriteError instanceof Error
            ? bodyWriteError.message
            : String(bodyWriteError)
        throw new MemoryUpdatePartialFailureError(
          `Memory update partial failure: properties for memory ${id} ` +
            `persisted, but the body write failed during phase "body": ${cause}. ` +
            `The property changes are already on Notion; the body content was ` +
            `not written. Inspect the row before retrying the update.`,
          { memoryId: id, bodyWriteError }
        )
      }
    }

    const updated = await this.getById(id)
    // Write-through: we just read the authoritative post-update state,
    // so cache it. `LruCache.set` also drops any in-flight `getOrLoad`
    // pending slot, so a reader whose `pages.retrieve` was dispatched
    // *during* this `pages.update` — after the pre-write delete but
    // before this set — has its post-loader commit suppressed by the
    // identity guard. Mirror of `TopicService.getOrCreate`'s post-write
    // `nameCache.set`.
    if (decoded.title !== undefined) {
      this.titleCache.set(id, updated.title || null)
    }
    return updated
  }

  /**
   * Run the HTML-entity decode pass against this service's Memories DB.
   * Thin wrapper over the standalone memory-encoding migration
   * function so the CLI doesn't need to reach past the service
   * boundary for the client + DatabaseRef.
   */
  async fixEncoding(
    options: { dryRun?: boolean; projectId?: string } = {}
  ): Promise<MemoryEncodingReport> {
    return fixMemoryEncoding(this.client, this.db, {
      ...options,
      features: this.features,
    })
  }

  /**
   * Run the agent-identity normalization pass against this service's
   * Memories DB. Same shape as `fixEncoding` — thin wrapper over the
   * standalone migration function so the CLI
   * doesn't need to reach past the service boundary for the client +
   * DatabaseRef.
   */
  async normalizeAgents(
    options: { dryRun?: boolean; projectId?: string } = {}
  ): Promise<AgentNormalizationReport> {
    return normalizeAgents(this.client, this.db, options)
  }

  /**
   * Run the synopsis-backfill pass against this service's Memories DB.
   * Thin wrapper over `backfillSynopses` so the CLI dispatcher reaches
   * the migration through the service boundary like every other
   * encoding / normalization migration.
   */
  async backfillSynopses(options: BackfillOptions): Promise<BackfillReport> {
    return backfillSynopses(this.client, this.db, options)
  }

  async archive(id: string): Promise<void> {
    // Pre-write delete: clear the stored value and drop any in-flight
    // `getOrLoad` pending slot. Post-write `set(id, null)` installs a
    // null tombstone (under `cacheNegatives: true`, subsequent reads
    // short-circuit on the tombstone instead of re-fetching). The
    // post-write `set` also drops the pending slot a second time, so a
    // reader whose retrieve was dispatched after the pre-write delete
    // and resolves with the pre-archive page (Notion returns archived
    // pages with `archived: true` populated) has its commit suppressed
    // by the identity guard.
    this.titleCache.delete(id)
    await this.client.pages.update({
      page_id: id,
      archived: true,
    })
    this.titleCache.set(id, null)
  }

  /**
   * Update `Last Referenced At` to today and lazily seed / decay / bump
   * `Confidence Score` for the given memories. Updates dispatch in
   * parallel via `Promise.all`. Each update is its own `pages.update`
   * (Notion has no batch-update primitive); the rate-limit middleware
   * handles backpressure.
   *
   * Short-circuits per-row when `lastReferencedAt === today` AND the
   * row's `confidenceScore` is already non-null — no Notion call. The
   * check is structural; concurrent reads in the same session may both
   * miss the short-circuit and both fire writes (Notion accepts in
   * arrival order, final state is consistent).
   *
   * Failure handling: any per-row failure routes through `onError` and
   * degrades to a no-op for that row. The caller's read result is
   * always preserved; `touchOnRead` is advisory, never blocking.
   *
   * Bump-once-per-day: a memory cited 50 times in one session bumps
   * exactly once — same gate as the column write.
   *
   * Decay-then-bump on stale rows: when `lastReferencedAt` is non-null
   * and not today, the helper first applies `decayConfidenceScore`
   * against the staleness accrued since the last touch, THEN applies
   * `bumpConfidenceScore`. Write-realized lazy decay — every mutation
   * realizes the time-decay since the last mutation. RRF reads the
   * stored value as-is via `confidenceFactor`.
   *
   * Seed-decay-then-bump on never-scored rows: when
   * `confidenceScore === null`, the row predates the confidence-score
   * column (or is otherwise unmigrated). The decay anchor is
   * `createdAt` — the row's been
   * "neglected" since creation. Seed → decay against `createdAt` →
   * bump matches what the bulk migration writes for the same row, so
   * a read-before-migrate path and a migrate-before-read path
   * converge to the same stored value.
   */
  async touchOnRead(
    memories: ReadonlyArray<
      Pick<
        Memory,
        "id" | "confidence" | "confidenceScore" | "lastReferencedAt" | "createdAt"
      >
    >,
    opts?: {
      today?: string
      onError?: (memoryId: string, error: unknown) => void
    }
  ): Promise<void> {
    return this.confidence.touchOnRead(memories, opts)
  }

  /**
   * Apply a contradiction decrement to a single memory. Reads the
   * current score, lazily seeds from the categorical when null,
   * realizes any accrued decay, applies `decrementConfidenceScore`,
   * writes back. Single round-trip. Returns the new score.
   *
   * Decay-then-decrement on stale rows parallels touchOnRead's
   * decay-then-bump: a stale row's stored value reflects the score at
   * last-touch, not at today, so realizing decay before the
   * contradiction keeps the negative signal proportional to current
   * trust. A row at 0.9 with `lastReferencedAt` 200 days before today
   * has effective `0.9 * 0.99^140 ≈ 0.220` (140 stale days), so the
   * halving lands at `≈ 0.110` — not 0.45 as it would be without the
   * realize step.
   *
   * Seed-decay-then-decrement on never-scored rows mirrors
   * `touchOnRead` — same convergence guarantee that a contradiction
   * landed against an unmigrated row and one landed against a
   * migrated row reach the same effective current value before
   * decrementing.
   *
   * The `Last Referenced At` write on contradiction is deliberate:
   * contradiction IS a form of cite (negative cite), and treating it
   * as neglect would let a heavily-contradicted memory simultaneously
   * decay, producing double-counted negative signal. Bumping
   * `Last Referenced At` resets the decay clock; the explicit
   * decrement provides the negative signal.
   */
  async decrementConfidence(
    memory: Pick<
      Memory,
      "id" | "confidence" | "confidenceScore" | "lastReferencedAt" | "createdAt"
    >,
    opts?: { today?: string; compareNotes?: string }
  ): Promise<number> {
    return this.confidence.decrementConfidence(memory, opts)
  }

  /**
   * Symmetric audit-marker write for `lore-memory action='compare'`.
   * Issues up to two `pages.update` calls in parallel,
   * one per side, each writing BOTH the `Compared With` relation
   * (with the counterpart's id added) AND the `Compare Notes`
   * rich_text (with a fresh NDJSON entry appended). Notion has no
   * multi-page atomic primitive, so the two writes share a
   * `Promise.allSettled`; partial-success is surfaced through the
   * structured `RecordComparedPartialWriteError` so callers can
   * self-heal.
   *
   * **Failure model.** Three settle outcomes:
   *
   * - **Both writes succeed.** Returns `{ wroteA, wroteB }` reflecting
   * which sides this call actually issued (versus which were skipped
   * via per-side idempotency).
   * - **Both writes reject.** Throws the first underlying rejection
   * directly. Per-side idempotency makes a same-input retry safe — a
   * fresh snapshot will see neither audit entry and write both
   * sides cleanly. No structured error here because there is no
   * partial-success state to surface.
   * - **Exactly one side rejects.** Throws
   * `RecordComparedPartialWriteError` carrying `result: {wroteA,
   * wroteB}` (the partial-success outcome), `failedSide` (the side
   * whose `pages.update` rejected), and `cause` (the underlying SDK
   * error). The MCP handler uses this to drive a single-shot
   * reload-and-retry path: the survivor's audit entry is now in
   * Notion, so a fresh `getById` snapshot lets the retry's per-side
   * idempotency check skip the survivor and write only the missing
   * side.
   *
   * Using `Promise.all` here would reject on the first failure —
   * discarding the concurrent success and leaving the caller unable
   * to distinguish "nothing wrote" from "A wrote, B failed." A naive
   * retry against a stale snapshot would then write the already-
   * landed side a second time, duplicating the NDJSON audit line.
   * The `Promise.allSettled` + structured-error contract preserves
   * the partial-success signal so retries can be precise.
   *
   * **Per-side idempotency.** Each side's write is gated locally by
   * `hasMatchingCompareNote(side.compareNotes, {target, verdict,
   * affected})`. If the loaded snapshot already carries a matching
   * entry, that side's `pages.update` is SKIPPED. This is what makes
   * a partial-failure recovery safe: when one side succeeded on a
   * prior call and the other failed, a re-run of `recordCompared`
   * with the same inputs writes only the missing side and leaves the
   * already-present side untouched (no duplicate audit line, no
   * duplicated `Compared With` relation). The returned
   * `RecordComparedResult` tells the caller which sides actually
   * landed a write, so the MCP handler can distinguish "fresh
   * judgment" from "recovery completion" in its response text.
   *
   * **Caller contract.**
   *
   * - The caller MUST have already validated overflow against
   * `COMPARE_NOTES_MAX_CHARS` by running `appendCompareNote` on
   * each side as a preflight inside `handleCompare`. When
   * per-side idempotency skips a write, the preflight cost
   * already incurred is wasted but harmless; the alternative —
   * moving the preflight inside `recordCompared` — would couple
   * the dispatch path to the audit-marker layout.
   * - The caller is responsible for the OUTER pair-scoped gate that
   * decides whether to invoke this method at all. For symmetric
   * verdicts the gate must check BOTH sides; for asymmetric
   * verdicts the gate's single-side check is correct because the
   * destructive dispatch (decrement + fact) is the dominant
   * concern there.
   *
   * **Compared With set semantics.** `Compared With` is a Notion
   * `single_property` self-relation; the API treats the relation list
   * as a set, so re-adding an id Notion already has is a no-op at the
   * data layer. The compose step still de-dupes locally so a fresh
   * verdict on a pair that has already been judged doesn't grow the
   * relation list with a stale duplicate before the API collapses it.
   *
   * **Why two calls, not one.** Notion's relation column points only
   * from the side that names the counterpart. Writing only A → B
   * leaves B's `Compared With` empty, so an operator inspecting B in
   * the Notion UI sees no signal that the pair was judged. Symmetric
   * writes preserve audit visibility on both pages.
   */
  async recordCompared(input: RecordComparedInput): Promise<RecordComparedResult> {
    return this.compare.recordCompared(input)
  }

  /**
   * Paginating async iterator over every non-archived memory in this
   * service's Memories DB, optionally scoped to a single project. Yields
   * `Memory` objects (with empty `content`) in created-time-ascending
   * order so the migration's plan output is deterministic across runs.
   *
   * Two consumers: `runBuildConfidenceScoresMigration` (the baseline
   * backfill) and `MemoryService.confidenceStats` (the
   * `lore status` confidence-distribution summary). Both want a
   * walker over every non-archived memory with no body fetch and the
   * same optional project scope, so they share one iterator rather
   * than re-deriving the pagination algebra. Exposing a
   * `Memory[]`-shaped iterator (rather than raw `PageObjectResponse[]`)
   * keeps callers off the SDK type surface and lets them consume
   * `Memory.createdAt` / `Memory.confidence` / `Memory.confidenceScore`
   * via the same extractor pipeline every other read path uses.
   *
   * Archived rows are filtered client-side: Notion exposes the archived
   * flag on the returned page object, and the existing read paths
   * (`agent-normalization`, `memory-encoding`) skip via `page.archived`.
   * Backfilling a score onto a row whose page is archived is wasted
   * work — it surfaces in no read path and would be silently lost on
   * the next un-archive's full re-write.
   *
   * Scoped by `projectId`: when omitted, the iterator walks every memory
   * in the vault (vault-wide migration). When set, scopes via the same
   * `projectOrUnscopedFilter` shape `MemoryService.list` uses, so a
   * project-scoped run also covers repo-wide unscoped rows that belong
   * to no project.
   */
  async *listAllForBackfill(
    opts: {
      projectId?: string
    } = {}
  ): AsyncGenerator<Memory, void, void> {
    yield* this.confidence.listAllForBackfill(opts)
  }

  /**
   * Single `pages.update` writing both `Confidence Score` and
   * `Last Referenced At`. Distinct from `touchOnRead` because the
   * migration sets `Last Referenced At` to the memory's `createdAt`
   * (sliced to YYYY-MM-DD), not today — the migration's contract is
   * "treat creation as the implicit first reference," so the row's
   * decay anchor IS its creation date.
   *
   * Caller is responsible for clamping `score`. Production callers
   * (`runBuildConfidenceScoresMigration`) hand off scores produced by
   * `decayConfidenceScore`, which clamps internally.
   */
  async applyBackfillScore(
    memoryId: string,
    score: number,
    lastReferencedAt: string
  ): Promise<void> {
    return this.confidence.applyBackfillScore(memoryId, score, lastReferencedAt)
  }

  /**
   * Aggregate `Confidence Score` distribution across non-archived
   * memories — the data the `lore status` confidence-summary line
   * surfaces (DEFERRED-04). Memory-side parallel of `taskStats`'s
   * closure-rate aggregation: pure read, no body fetch, optional
   * project scope.
   *
   * Walks via `listAllForBackfill` so we share one paginated iterator
   * with the `--build-confidence-scores` migration. Aggregates in a
   * single pass:
   *
   * - `totalMemories` — every non-archived row the iterator yields.
   * - `scoredMemories` — `Memory.confidenceScore !== null`. On a
   * vault that hasn't run the backfill this stays at zero and the
   * renderer collapses the `(avg …, … below threshold)` suffix off
   * the line accordingly.
   * - `averageScore` — arithmetic mean across scored rows. Returns
   * `0` when no scored rows exist; the renderer suppresses the avg
   * surface in that case via the `scoredMemories === 0` guard, so
   * the placeholder zero never reaches the operator.
   * - `belowThreshold` — count of scored rows whose stored value is
   * strictly below `CONFIDENCE_DISPLAY_THRESHOLD` (the same gate
   * the trust indicator and Stale Confidence wake-up use, so all
   * three surfaces agree on what "below threshold" means).
   *
   * Cost is one paginated walk over the (project-scoped) Memories
   * data source — the same shape `--build-confidence-scores`
   * already pays per `lore migrate` invocation. The migration is
   * operator-pulled and infrequent; `lore status` is on-demand and
   * now pays this walk on every invocation, so per-status cost
   * scales linearly in vault size (≈ N/100 round-trips). Acceptable
   * on the operator-facing status surface but worth a follow-up
   * (cache, `--confidence` flag, or `lore status` skip) if a vault
   * grows past the point where the walk feels slow.
   *
   * The walk is **internally sequential** — `listAllForBackfill`
   * is a paginated async iterator that awaits each `dataSources.query`
   * before issuing the next. The shared rate-limited client
   * ( default `concurrency = 3`) bounds
   * total in-flight calls but does not parallelize this iterator;
   * its pagination is what dominates wall-clock on large vaults.
   * The CLI fan-out runs `confidenceStats` parallel to `taskStats`
   * at the top level, but the pagination inside this method stays
   * serial. Read together with the per-invocation-cost note above:
   * the `max(taskStats, confidenceStats)` claim at the call site
   * holds for the orchestration, not for any single round-trip.
   *
   * `averageScore` is an arithmetic mean computed in floating-point;
   * accumulation across long pagination can leave the result off by
   * one ULP from the "true" mean. The renderer truncates at two
   * decimals, so this is invisible in practice but worth noting if
   * a future caller compares two stats reports for exact equality.
   *
   * Vaults that haven't migrated to the `Confidence Score` column
   * work fine: every yielded `Memory.confidenceScore` is `null`, so
   * `scoredMemories` / `averageScore` / `belowThreshold` all stay
   * at zero.
   */
  async confidenceStats(opts: { projectId?: string } = {}): Promise<{
    totalMemories: number
    scoredMemories: number
    averageScore: number
    belowThreshold: number
  }> {
    return this.confidence.confidenceStats(opts)
  }

  /**
   * Operator-facing counters for the `lore status` expiring/expired
   * scoped-memory surface.
   *
   * Returns three counts:
   * - `expired`: rows whose `Expires At < today` and whose page is
   * not archived. Already invisible to default reads — surfaced
   * here so an operator can run `lore-memory action='archive'` to
   * actually clean them up.
   * - `expiringSoon`: rows with `Expires At` in the inclusive window
   * `[today, today + EXPIRING_SOON_DAYS]`. The "expiring this
   * week" triage signal — agents whose memories are about to drop
   * out of recall get an audit nudge.
   * - `narrowScopeOutOfContext`: count of rows whose Scope Kind is
   * one of the narrow kinds (`user` / `agent` / `role` / `session`
   * / `run` / `environment`) AND whose Scope Key does NOT match
   * the current resolved scope context. This is the "session-
   * scoped notes outliving their session" signal — the load-
   * bearing acceptance criterion the scope columns exist to make
   * visible.
   *
   * Single paginated walk via `listAllForBackfill`, project-scoped
   * when `projectId` is provided. Counts archived rows out (the
   * walker already filters them).
   */
  async expiringScopedStats(opts: { projectId?: string } = {}): Promise<{
    expired: number
    expiringSoon: number
    narrowScopeOutOfContext: number
  }> {
    const today = todayUtc()
    const horizonMs =
      Date.parse(today) +
      // EXPIRING_SOON_DAYS is the days-ahead horizon. We need it in
      // ms to compare YYYY-MM-DD strings; render the shifted Date
      // back to the same format via `.toISOString().slice(0, 10)`.
      EXPIRING_SOON_DAYS * MS_PER_DAY
    const horizon = new Date(horizonMs).toISOString().slice(0, 10)
    let expired = 0
    let expiringSoon = 0
    let narrowScopeOutOfContext = 0
    const ctx = this.scopeCtx
    for await (const memory of this.listAllForBackfill(opts)) {
      const scope = memory.scope ?? null
      if (scope === null) continue
      const expiresAt = scope.expiresAt
      if (expiresAt !== null) {
        if (expiresAt < today) {
          expired += 1
        } else if (expiresAt <= horizon) {
          expiringSoon += 1
        }
      }
      const kind = scope.kind
      if (kind === null) continue
      if (kind === "team" || kind === "project" || kind === "global") continue
      const expected =
        kind === "user"
          ? ctx.userId
          : kind === "agent"
            ? ctx.agent
            : kind === "role"
              ? ctx.role
              : kind === "session"
                ? ctx.session
                : kind === "run"
                  ? ctx.run
                  : kind === "environment"
                    ? ctx.environment
                    : undefined
      if (expected === undefined || scope.key !== expected) {
        narrowScopeOutOfContext += 1
      }
    }
    return { expired, expiringSoon, narrowScopeOutOfContext }
  }

  /**
   * Count non-archived `Kind != decision` memories whose `Status =
   * proposed` — the proposed-memory review inbox primitive backing
   * the `lore status` and `lore-context action='status'` inbox-count
   * surfaces. Reports pending proposed-memory counts by
   * project/source/agent.
   *
   * Returns the total count plus per-source and per-agent breakdowns
   * so the operator can see at a glance where pending review pressure
   * is coming from. Source is a closed enum (`MemorySource`); the
   * surface bucket is `string` because rows with a missing `Source`
   * column bucket as `"unknown"` (matching the `Agent` `"unknown"`
   * fallback below) rather than collapsing into the historical
   * `extractSelect` `"manual"` default — that default is correct for
   * `pageToMemory`'s in-memory shape but would silently inflate the
   * `manual` bucket on the operator-facing inbox line. Agent is a
   * free-form `rich_text` string canonicalized at write time via
   * `canonicalizeAgentName`, so the keys reflect whatever historical
   * strings remain in the vault.
   *
   * **`Kind != decision` is server-side**, applied via Notion's
   * `select.does_not_equal: "decision"`. `ACTIVE_DECISION_STATUSES`
   * explicitly includes `proposed` as a normal in-flight decision
   * lifecycle state — counting those rows as inbox memories would
   * conflate governance with auto-extracted learnings awaiting
   * review and inflate the operator's review pressure on every
   * vault that uses `lore-decision action='create'` with
   * `status: "proposed"`. The exclusion matches the
   * `excludeKinds: ["decision"]` posture that the memory near-duplicate
   * probe already uses for the same memories-vs-decisions split.
   *
   * Server-side filter:
   *
   * Status = proposed
   * AND Kind != decision
   * AND (when scoped) (Project contains projectId OR Project is_empty)
   *
   * Direct `client.dataSources.query` rather than `MemoryService.list`
   * because the inbox surface only needs the property tuple
   * (Status / Kind / Source / Agent) and never the markdown body —
   * paying for `pageToMemory`'s per-row body fetch on every `lore
   * status` would scale linearly with the inbox depth for zero
   * rendered benefit. Same posture as `TaskService.countClosedSince`
   * and `FactService.countByPredicateRaw`.
   *
   * Archived rows filtered client-side via `isLiveFullPage` — Notion's
   * `archived` flag lives on `PageObjectResponse`, not as a DB column,
   * so a `dataSources.query` cannot exclude it server-side. Archived
   * proposals are not part of the live inbox.
   *
   * Vault-scoping matches `MemoryService.list`: when `projectId` is
   * omitted the project clause is dropped entirely, so the counter
   * walks every project's proposals (the surface used when no
   * `--project` flag is supplied to `lore status`). When `projectId`
   * is supplied, repo-wide unscoped proposals surface in the count
   * via the OR clause — same posture as recall.
   */
  async countProposed(opts: { projectId?: string } = {}): Promise<{
    total: number
    bySource: Record<string, number>
    byAgent: Record<string, number>
  }> {
    // Spread `proposedMemoryFilter()`'s `.and` clauses onto the outer
    // filter array (rather than nesting the helper as a sub-`and`)
    // so the composed shape is flat — `{ and: [status, kind,
    // project] }` instead of `{ and: [{ and: [status, kind] }, project] }`.
    // Notion accepts both, but a flat compound is conventional and
    // easier to debug in API logs.
    //
    // Resurfaced cleanup-orphan exclusion. The proposed-
    // inbox slice in `loadWakeUpData` uses `MemoryService.list({ status:
    // "proposed", excludeKinds: ["decision"] })`, which already excludes
    // the sentinel via the `MemoryService.list` server-side filter.
    // The matching count surface here must apply the same exclusion or
    // the wake-up renderer prints a count that doesn't match its row
    // list — `loadWakeUpData` documents the slice/count match as an
    // invariant. Appended at the end of the flat filter array so the
    // existing `[status, kind, project]` order in API logs is unchanged
    // for the common case.
    const filters: Array<Record<string, unknown>> = [...proposedMemoryFilter().and]
    if (opts.projectId) filters.push(projectOrUnscopedFilter(opts.projectId))
    filters.push(cleanupOrphanExclusionFilter())
    const filter = filters.length > 1 ? { and: filters } : filters[0]

    let total = 0
    const bySource: Record<string, number> = {}
    const byAgent: Record<string, number> = {}
    let cursor: string | undefined
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: filter as QueryDataSourceParameters["filter"],
        page_size: 100,
        start_cursor: cursor,
      })
      for (const page of response.results.filter(isLiveFullPage)) {
        total += 1
        const sourceProp = page.properties[MEMORY_PROPS.SOURCE]
        const sourceKey =
          sourceProp && sourceProp.type === "select" && sourceProp.select
            ? sourceProp.select.name
            : "unknown"
        bySource[sourceKey] = (bySource[sourceKey] ?? 0) + 1
        const agentRaw = extractRichText(page.properties[MEMORY_PROPS.AGENT]).trim()
        const agentKey = agentRaw.length > 0 ? agentRaw : "unknown"
        byAgent[agentKey] = (byAgent[agentKey] ?? 0) + 1
      }
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
    } while (cursor)
    return { total, bySource, byAgent }
  }

  /**
   * Memories that need triage: either scored low, OR long-neglected
   * regardless of stored score. Backs the Stale Confidence wake-up
   * subsection.
   *
   * Server-side filter (when `opts.projectId` is supplied):
   *
   * (Project contains projectId OR Project is_empty)
   * AND Confidence Score is_not_empty
   * AND (
   * Confidence Score < CONFIDENCE_DISPLAY_THRESHOLD
   * OR Last Referenced At on_or_before today - STALE_CONFIDENCE_DAYS
   * )
   *
   * Server-side filter (vault-wide, when `opts.projectId` is omitted):
   * the project clause is dropped entirely so the query covers every
   * memory regardless of project scoping. Same posture as
   * `MemoryService.list`.
   *
   * The neglect-OR clause is load-bearing under the
   * **write-realized lazy decay** model. RRF reads stored
   * Confidence Score verbatim — no decay applied at read. So a memory
   * touched once 6 months ago at score 0.9 keeps a stored 0.9 (and
   * ranks high in retrieval) until something disturbs it. The
   * neglect-OR clause is what surfaces it for triage. When the agent
   * reads it, `touchOnRead` realizes the accrued decay (decay-then-bump),
   * the stored score drops, and the row either continues surfacing
   * (if now actually low-score) or rotates out.
   *
   * The `is_not_empty` guard excludes never-scored rows — those have
   * not yet been touched by any read path; flagging them as stale
   * would conflate "never scored" with "needs triage." Operators
   * backfill them via `lore migrate --build-confidence-scores`.
   *
   * `projectOrUnscopedFilter` matches `MemoryService.list` etc. —
   * repo-wide memories surface in the Stale Confidence section the
   * same way they surface in Recent Memories.
   *
   * Sorted by score ascending so most-decayed rows surface first;
   * neglected-but-fresh-score rows fall to the end of the list. Notion
   * page size = 100 so archive-heavy windows can refill efficiently;
   * archived rows are filtered client-side (matches the established Memories
   * DS pattern). No body fetch — the wake-up subsection renders title +
   * synopsis + trust label + meta only, never bodies.
   */
  async queryStaleConfidence(opts: {
    /** Omit for vault-wide wake-up; matches `MemoryService.list` shape. */
    projectId?: string
    limit: number
    /** YYYY-MM-DD anchor; same shape as `taskDaysOverdue` etc. */
    today: string
    /**
     * When `true`, do NOT exclude `Status = proposed` rows. Defaults
     * to `false` so the wake-up Stale Confidence subsection mirrors
     * the rest of the default-recall posture:
     * proposed memories belong in the inbox surface, not in normal
     * triage lists. The inbox-review flow opts in.
     */
    includeProposed?: boolean
  }): Promise<Memory[]> {
    const neglectCutoff = new Date(
      new Date(opts.today).getTime() - STALE_CONFIDENCE_DAYS * MS_PER_DAY
    )
      .toISOString()
      .slice(0, 10)

    const filters: Array<Record<string, unknown>> = []
    if (opts.projectId) {
      filters.push(projectOrUnscopedFilter(opts.projectId))
    }
    if (opts.includeProposed !== true) {
      // Same default-exclude posture as `MemoryService.list` and
      // `MemoryService.search`: hide both `proposed` (inbox-pending)
      // and `rejected` (terminal-off-recall) rows from triage so
      // review-state never leaks into the Stale Confidence subsection.
      filters.push(...reviewTerminalStatusExclusionFilters())
    }
    filters.push({
      property: MEMORY_PROPS.CONFIDENCE_SCORE,
      number: { is_not_empty: true },
    })
    filters.push({
      or: [
        {
          property: MEMORY_PROPS.CONFIDENCE_SCORE,
          number: { less_than: CONFIDENCE_DISPLAY_THRESHOLD },
        },
        {
          property: MEMORY_PROPS.LAST_REFERENCED_AT,
          date: { on_or_before: neglectCutoff },
        },
      ],
    })
    // Resurfaced cleanup-orphan exclusion. A restored-
    // from-trash orphan that was scored by `--build-confidence-scores`
    // before this filter shipped would otherwise show up in the
    // wake-up Stale Confidence triage view as an empty-body shell —
    // confusing for the operator and noise in the section meant to
    // surface real low-confidence memories.
    filters.push(cleanupOrphanExclusionFilter())

    const filter = { and: filters } as QueryDataSourceParameters["filter"]

    // Pre-migration vaults that haven't yet run `lore migrate` against
    // the 0.8.0 schema lack the `Confidence Score` and
    // `Last Referenced At` columns entirely. Notion responds with a
    // `validation_error` ("Could not find sort property with name or
    // id: Confidence Score") rather than an empty result, which would
    // otherwise propagate up through `loadWakeUpData`'s `Promise.all`
    // and fail the entire wake-up. Degrade to an empty section
    // instead — same posture as `FactService.queryByEntityTextOnUnmigrated`
    // and `TaskService.countClosedSince`, both of which silently
    // suppress their feature on vaults that pre-date the column they
    // depend on. The schema-drift detector
    // (`migrateVaultSchema` / `lore migrate --dry-run`) is the
    // canonical operator-facing surface for "you need to migrate";
    // wake-up itself stays decorative. Transient 5xx / rate-limit /
    // network errors do NOT match `isMissingPropertyError` and still
    // propagate so a real outage isn't masked.
    const limit = opts.limit
    if (limit <= 0) return []

    let result: Awaited<ReturnType<typeof collectLivePages>>
    try {
      result = await collectLivePages({
        limit,
        source: "MemoryService.queryStaleConfidence",
        query: ({ page_size, start_cursor }) =>
          this.client.dataSources.query({
            data_source_id: this.db.dataSourceId,
            filter,
            sorts: [{ property: MEMORY_PROPS.CONFIDENCE_SCORE, direction: "ascending" }],
            page_size,
            start_cursor,
          }),
      })
    } catch (err) {
      if (isMissingPropertyError(err)) return []
      throw err
    }
    if (result.capped) {
      warnLivePageCapFired({
        source: "MemoryService.queryStaleConfidence",
        pages: result.pageCount,
        accumulated: result.pages.length,
        limit,
      })
    }

    return Promise.all(result.pages.map((page) => this.pageToMemory(page, "")))
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
    return this.pinned.listPinnedBlocks(opts)
  }

  async countPinnedBlocks(opts: { bypassCache?: boolean } = {}): Promise<number> {
    return this.pinned.countPinnedBlocks(opts)
  }

  /**
   * Project-grouped paginated walk for `lore conflicts scan`.
   * Returns `Memory[][]` aligned by index with the input `projectIds` —
   * `result[i]` holds every non-archived memory whose `Project` relation
   * contains `projectIds[i]`.
   *
   * **Why a dedicated method, not a re-shaped `list`.** `list` is
   * recall-shaped: capped at 100 rows, sorted by edit time, scoped via
   * `projectOrUnscopedFilter` so unscoped repo-wide rows surface alongside
   * project-scoped ones. The conflict scanner needs the opposite: every
   * row in a project (paginate to exhaustion), strict-scoped (an unscoped
   * repo-wide row is NOT a candidate for "conflicts in project X"
   * because it doesn't carry X's identity), and per-project grouping so
   * `findConflictCandidates` runs in-project and the post-list
   * dedup can collapse cross-project duplicates.
   *
   * **Strict-scoped, not `projectOrUnscopedFilter`-shaped.** The
   * conflict-candidate generator (`findConflictCandidates`) intersects
   * `projectIds` per-pair internally, so an unscoped row paired against
   * a project-scoped row would fail that intersection anyway and
   * surface zero candidates. Including unscoped rows here would only
   * inflate the per-project memory list (and the post-list
   * `findConflictCandidates` O(n²) pair work) for zero useful output.
   *
   * **Archived rows.** Filtered client-side via `page.archived` —
   * `dataSources.query` cannot filter on Notion's page-metadata
   * `archived` flag (it lives on `PageObjectResponse`, not as a DB
   * column). Same posture as `findByTopicKey` and `listAllForBackfill`.
   *
   * **Body fetch is opt-in via `includeBodies`.** The candidate
   * generator reads only `title` / `keywords` / `tags` / `projectIds`
   * — body content is irrelevant to lexical similarity. The CLI's
   * `--include-bodies` flag is the only consumer that needs full
   * markdown; default off keeps the scan an O(N) properties walk
   * rather than an O(N) properties walk + O(N) per-page
   * `retrieveMarkdown` round-trips. When the flag is on, body
   * fetches fan out via `Promise.all` per project, governed by the
   * shared rate-limited client.
   *
   * **Progress signal.** When `onProgress` is provided, the helper
   * fires it once per Notion page received with the project label,
   * 1-based page index, and running total so the CLI can stream
   * `Scanning project 'core-app': page 3, 230 memories...` to stderr
   * without coupling to `console.error`.
   */
  async listForScan(opts: {
    projectIds: string[]
    /** Optional human-readable labels aligned by index with `projectIds`
     * for `onProgress` rendering; defaults to the project ID when omitted. */
    projectLabels?: string[]
    includeBodies?: boolean
    onProgress?: (info: {
      projectId: string
      projectLabel: string
      pageIndex: number
      runningTotal: number
    }) => void
  }): Promise<Memory[][]> {
    const labels = opts.projectLabels ?? opts.projectIds
    const result: Memory[][] = []

    for (let i = 0; i < opts.projectIds.length; i++) {
      const projectId = opts.projectIds[i]!
      const label = labels[i] ?? projectId

      const pages: PageObjectResponse[] = []
      let cursor: string | undefined = undefined
      let pageIndex = 0
      do {
        const response = await this.client.dataSources.query({
          data_source_id: this.db.dataSourceId,
          // Resurfaced cleanup-orphan exclusion composed
          // server-side onto the strict-scoped Project filter. The
          // conflict scanner's lexical pair-detector uses title +
          // keywords + tags; an empty-body orphan still has all three,
          // and the per-pair `findConflictCandidates` work would pair
          // it against legitimate rows.
          filter: withCleanupOrphanExclusion({
            property: MEMORY_PROPS.PROJECT,
            relation: { contains: projectId },
          }) as QueryDataSourceParameters["filter"],
          page_size: 100,
          start_cursor: cursor,
        })
        pageIndex++
        for (const r of response.results) {
          if (isLiveFullPage(r)) pages.push(r)
        }
        if (opts.onProgress) {
          opts.onProgress({
            projectId,
            projectLabel: label,
            pageIndex,
            runningTotal: pages.length,
          })
        }
        cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
      } while (cursor !== undefined)

      if (opts.includeBodies) {
        const memories = await Promise.all(
          pages.map(async (page) => {
            const md = await this.client.pages.retrieveMarkdown({ page_id: page.id })
            return await this.pageToMemory(page, md.markdown)
          })
        )
        result.push(memories)
      } else {
        result.push(await Promise.all(pages.map((page) => this.pageToMemory(page, ""))))
      }
    }

    return result
  }

  /**
   * Candidate-pool fetcher for the near-duplicate probe. Pulls
   * `Status IN (...)` and `Kind NOT IN (...)` ahead of the row
   * limit when the operator opts into the RunTool SQL path:
   *
   * - **Flag on (`LORE_USE_RUNTOOL_FILTER_SQL=1`) AND a RunTool
   * client is wired:** issue one parameterized SQL query through
   * `query_data_sources` with both predicates pushed
   * server-side and `LIMIT N` applied AFTER. The SQL query
   * returns page ids; each id hydrates through
   * `getPropertiesById` so the returned `Memory[]` matches the
   * REST path's content-off shape (`content: ""`).
   * - **Flag off OR no RunTool client OR SQL throws:** falls back
   * to {@link MemoryService.list}. `excludeKinds` is forwarded
   * so the REST path also pushes `Kind != X` server-side via the
   * existing `does_not_equal` clauses (a one-line REST
   * improvement that lands alongside the SQL path); `statuses`
   * on the REST path stays as the caller's JS post-filter
   * responsibility because Notion's `dataSources.query` only
   * accepts a single `select.equals` clause for `Status`.
   *
   * Near-duplicate status and kind filters apply before
   * candidate-pool truncation, so `limit` means SQL-filtered
   * candidates rather than candidates later pruned in JS. The
   * contract holds on the SQL branch and partially on the REST
   * fallback (`excludeKinds` is server-side; `statuses` remains a
   * JS post-filter on REST).
   *
   * Null/missing-property semantics: the SQL `Kind NOT IN (...)`
   * predicate explicitly OR's `Kind IS NULL` so a row with no Kind
   * passes the filter, mirroring Notion's `does_not_equal`'s
   * null-permissive posture. `Status IN (...)` is null-restrictive
   * on the SQL side and matches the REST path's `select.equals`
   * whitelist (a null Status row also fails REST). Documented
   * inline in `fetchNearDuplicateCandidatePageIds`.
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
  // Catch-all overload. Accepts the optional broad options shape
  // (`opts?: ListMemoriesOptions`) so wrapper helpers can forward a
  // normalized `ListMemoriesOptions | undefined` filter variable
  // verbatim. Returns the conservative `Memory[]` widening — when
  // `includeContent` is a caller-controlled runtime `boolean`, TS
  // cannot prove the body was skipped, so the literal `""` signal
  // would be unsound.
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

  async search(input: SearchMemoriesInput): Promise<Memory[]> {
    return this.searcher.search(input)
  }

  async searchWithMeta(input: SearchMemoriesInput): Promise<{
    memories: Memory[]
    capped: boolean
  }> {
    return this.searcher.searchWithMeta(input)
  }

  async searchWithExplain(input: SearchMemoriesInput): Promise<{
    memories: Memory[]
    explain: SearchExplain[]
    capped: boolean
  }> {
    return this.searcher.searchWithExplain(input)
  }

  private async runSearch(
    input: SearchMemoriesInput
  ): Promise<{ memories: Memory[]; explain: SearchExplain[]; capped: boolean }> {
    return this.searcher.runSearch(input)
  }

  private async fetchContainsPages(
    input: SearchMemoriesInput
  ): Promise<SearchPagesResult> {
    return this.searcher.fetchContainsPages(input)
  }

  private async fetchSemanticPages(
    input: SearchMemoriesInput,
    intent: string | null,
    signal?: AbortSignal
  ): Promise<PageObjectResponse[]> {
    return this.searcher.fetchSemanticPages(input, intent, signal)
  }

  private async fetchSemanticPagesViaRunTool(
    input: SearchMemoriesInput,
    composedQuery: string,
    limit: number,
    signal?: AbortSignal
  ): Promise<PageObjectResponse[] | null> {
    return this.searcher.fetchSemanticPagesViaRunTool(input, composedQuery, limit, signal)
  }

  private async applySemanticPostFilters(
    pages: PageObjectResponse[],
    input: SearchMemoriesInput,
    signal?: AbortSignal
  ): Promise<PageObjectResponse[]> {
    return this.searcher.applySemanticPostFilters(pages, input, signal)
  }

  private async searchByContainsPages(
    input: SearchMemoriesInput
  ): Promise<SearchPagesResult> {
    return this.searcher.searchByContainsPages(input)
  }

  private async searchBySemanticPages(
    input: SearchMemoriesInput,
    intent: string | null
  ): Promise<SearchPagesResult> {
    return this.searcher.searchBySemanticPages(input, intent)
  }

  private async searchByHybridPages(
    input: SearchMemoriesInput,
    limit: number,
    intent: string | null
  ): ReturnType<MemorySearch["searchByHybridPages"]> {
    return this.searcher.searchByHybridPages(input, limit, intent)
  }

  /**
   * Hydrate a list of `PageObjectResponse` rows into `Memory` domain types,
   * honoring `includeContent`. Called exactly once at the top of `search()`
   * on the final merged-and-capped page list, so hybrid never fetches
   * markdown for candidates that won't survive the dedupe and limit cap.
   */
  private async materializeMemories(
    pages: PageObjectResponse[],
    includeContent: boolean | undefined
  ): Promise<Memory[]> {
    if (includeContent === false) {
      return Promise.all(pages.map((page) => this.pageToMemory(page, "")))
    }
    return Promise.all(
      pages.map(async (page) => {
        const md = await this.client.pages.retrieveMarkdown({ page_id: page.id })
        return await this.pageToMemory(page, md.markdown)
      })
    )
  }

  private async pageToMemory(
    page: PageObjectResponse,
    content?: string
  ): Promise<Memory> {
    return pageToMemory(await hydrateMemoryRelationProperties(this.client, page), content)
  }
}

/**
 * Convert a Notion page object to a `Memory` domain type. Pure function —
 * exported for unit testing. The hardened extractors guarantee graceful
 * defaults for pages that pre-date any schema addition: an unmigrated
 * page returns `kind: "note"`, `status: "informational"`, etc.
 */
export function pageToMemory(page: PageObjectResponse, content?: string): Memory {
  const props = page.properties
  const topicIds = extractRelationIds(props[MEMORY_PROPS.TOPIC])
  const session = extractRichText(props[MEMORY_PROPS.SESSION]).trim()

  // Read `Task State` only when the column exists *and* a select is set.
  // `extractSelect` falls back when the column is missing — fine for
  // unmigrated pages — but we want a true `null` (not `"open"`) on
  // every non-task memory so downstream code can branch on the field.
  const taskStateProp = props[MEMORY_PROPS.TASK_STATE]
  const taskState =
    taskStateProp && taskStateProp.type === "select" && taskStateProp.select
      ? (taskStateProp.select.name as TaskState)
      : null

  return {
    id: page.id,
    title: extractTitle(props[MEMORY_PROPS.TITLE]),
    projectIds: extractRelationIds(props[MEMORY_PROPS.PROJECT]),
    topicId: topicIds[0] ?? null,
    source: extractSelect(props[MEMORY_PROPS.SOURCE], "manual") as MemorySource,
    // Decision-related columns. Pre-migration pages default gracefully
    // via the hardened extractors — no backfill required.
    kind: extractSelect(props[MEMORY_PROPS.KIND], "note") as MemoryKind,
    status: extractSelect(props[MEMORY_PROPS.STATUS], "informational") as MemoryStatus,
    confidence: extractSelect(
      props[MEMORY_PROPS.CONFIDENCE],
      "certain"
    ) as MemoryConfidenceLevel,
    confidenceScore: extractNumber(props[MEMORY_PROPS.CONFIDENCE_SCORE]),
    reviewBy: extractDate(props[MEMORY_PROPS.REVIEW_BY]),
    doneAt: extractDate(props[MEMORY_PROPS.DONE_AT]),
    decidedAt: extractDate(props[MEMORY_PROPS.DECIDED_AT]),
    lastReferencedAt: extractDate(props[MEMORY_PROPS.LAST_REFERENCED_AT]),
    supersedesIds: extractRelationIds(props[MEMORY_PROPS.SUPERSEDES]),
    affectsIds: extractRelationIds(props[MEMORY_PROPS.AFFECTS]),
    alternatives: extractRichText(props[MEMORY_PROPS.ALTERNATIVES]),
    consequences: extractRichText(props[MEMORY_PROPS.CONSEQUENCES]),
    author: extractRichText(props[MEMORY_PROPS.AUTHOR]),
    agent: extractRichText(props[MEMORY_PROPS.AGENT]),
    tags: extractMultiSelect(props[MEMORY_PROPS.TAGS]),
    keywords: extractRichText(props[MEMORY_PROPS.KEYWORDS]),
    synopsis: extractRichText(props[MEMORY_PROPS.SYNOPSIS]),
    session: session.length > 0 ? session : null,
    content: content ?? "",
    createdAt: page.created_time,
    updatedAt: page.last_edited_time,
    taskState,
    blockedBy: extractRichText(props[MEMORY_PROPS.BLOCKED_BY]),
    entity: extractRichText(props[MEMORY_PROPS.ENTITY]),
    topicKey: extractRichText(props[MEMORY_PROPS.TOPIC_KEY]),
    // Legacy rows have a null `Revision Count` column. Coalesce
    // to 1 — every existing row has been "saved once," so
    // `formatMemoryListItem` treats the count as single-revision
    // and surfaces no `rev` line. Distinct from the Confidence Score
    // path (which preserves null to signal "never scored") because
    // Revision Count carries no "uninitialized" semantic — every row
    // has been written at least once by definition.
    revisionCount: extractNumber(props[MEMORY_PROPS.REVISION_COUNT]) ?? 1,
    comparedWith: extractRelationIds(props[MEMORY_PROPS.COMPARED_WITH]),
    compareNotes: extractRichText(props[MEMORY_PROPS.COMPARE_NOTES]),
    scope: extractMemoryScope(props),
    pinned: extractMemoryPinned(props),
  }
}

/**
 * Read the five scope columns into a `MemoryScope` bundle. Returns
 * `null` when all five columns are empty/missing. Vaults with the
 * scope schema migration applied but without backfilled scope still
 * pass through this branch; default retrieval treats null scope as
 * broadcast.
 *
 * Returns a populated `MemoryScope` with `kind: null` / `lifetime:
 * null` when only one column has been written (e.g. an operator set
 * `Lifetime` on a row but left `Scope Kind` empty) — same surface as
 * a row mid-scope-migration.
 */
function extractMemoryScope(
  props: PageObjectResponse["properties"]
): import("../types.js").MemoryScope | null {
  const kindProp = props[MEMORY_PROPS.SCOPE_KIND]
  const kind =
    kindProp && kindProp.type === "select" && kindProp.select
      ? (kindProp.select.name as import("../types.js").MemoryScopeKind)
      : null
  const key = extractRichText(props[MEMORY_PROPS.SCOPE_KEY])
  const audience = extractRichText(props[MEMORY_PROPS.AUDIENCE])
  const lifetimeProp = props[MEMORY_PROPS.LIFETIME]
  const lifetime =
    lifetimeProp && lifetimeProp.type === "select" && lifetimeProp.select
      ? (lifetimeProp.select.name as import("../types.js").MemoryLifetime)
      : null
  const expiresAt = extractDate(props[MEMORY_PROPS.EXPIRES_AT])
  if (
    kind === null &&
    lifetime === null &&
    expiresAt === null &&
    key.length === 0 &&
    audience.length === 0
  ) {
    return null
  }
  return { kind, key, audience, lifetime, expiresAt }
}
