// ABOUTME: Owns partial memory property/content updates behind MemoryService and title/pinned cache repair.
// ABOUTME: Edit when update sequencing, rich-text decoding, or partial-failure semantics change.

import type { Client, CreatePageParameters } from "@notionhq/client"
import type { Memory, UpdateMemoryInput } from "../types.js"
import { MEMORY_PROPS } from "../notion/schema.js"
import { decodeTextEntities } from "../notion/html-entities.js"
import { LoreError, errorCauseMessage } from "../errors.js"
import { validateRichTextMetadataFields } from "./rich-text-schema.js"
import { clampPinnedPriority } from "./memory-pinned.js"

type MemoryUpdateDeps = {
  preflightPinnedUpdate: (id: string, input: UpdateMemoryInput) => Promise<void>
  invalidatePinnedCountCache: () => void
  deleteTitleCache: (id: string) => void
  setTitleCache: (id: string, title: string | null) => void
  getById: (id: string) => Promise<Memory>
}

/**
 * Structured partial-state error raised by the MCP-layer
 * `lore-memory action='update'` handler when a combined
 * `topicKey + content` update has the content delta land
 * successfully but the subsequent re-key reject. The content
 * mutation is durable on Notion; the re-key did not occur.
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

export class MemoryUpdate {
  constructor(
    private readonly client: Client,
    private readonly deps: MemoryUpdateDeps
  ) {}

  async update(id: string, input: UpdateMemoryInput): Promise<Memory> {
    validateRichTextMetadataFields(input, "MemoryService.update")

    await this.deps.preflightPinnedUpdate(id, input)

    // Same decode-at-write discipline as `create`: encoded titles /
    // content / alternatives / consequences flowing in from re-saves of
    // autosave-rendered transcripts must land in Notion clean. Without
    // this, `update` would write encoded text around the freshly-decoded
    // rows `create` produces.
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
      this.deps.deleteTitleCache(id)
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
        this.deps.invalidatePinnedCountCache()
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
          this.deps.setTitleCache(id, decoded.title || null)
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

    const updated = await this.deps.getById(id)
    // Write-through: we just read the authoritative post-update state,
    // so cache it. `LruCache.set` also drops any in-flight `getOrLoad`
    // pending slot, so a reader whose `pages.retrieve` was dispatched
    // *during* this `pages.update` — after the pre-write delete but
    // before this set — has its post-loader commit suppressed by the
    // identity guard. Mirror of `TopicService.getOrCreate`'s post-write
    // `nameCache.set`.
    if (decoded.title !== undefined) {
      this.deps.setTitleCache(id, updated.title || null)
    }
    return updated
  }
}
