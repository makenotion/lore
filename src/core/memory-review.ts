import type { Client, CreatePageParameters } from "@notionhq/client"
import type { Memory, MemoryStatus } from "../types.js"
import { MEMORY_PROPS } from "../notion/schema.js"
import { LoreError, errorCauseMessage } from "../errors.js"
import { todayUtc } from "./task.js"

type GetMemoryPropertiesById = (id: string) => Promise<Memory>

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

export class MemoryReview {
  constructor(
    private readonly client: Client,
    private readonly getPropertiesById: GetMemoryPropertiesById
  ) {}

  /**
   * Record an inbox-review verdict on a proposed memory. The
   * caller is the human or authorized agent deciding whether the
   * auto-extracted learning belongs in the shared vault or not.
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
}
