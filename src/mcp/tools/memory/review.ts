import type { LoreServices } from "../../server.js"
import { toolError } from "../../helpers.js"
import type { ToolResult } from "./types.js"

// -------------------------------------------------------------------------
// Inbox review — flip a Status: proposed
// memory to accepted (`approve`) or rejected (`reject`) and append a
// Reviewed audit block recording the verdict, reviewer, and timestamp.
// -------------------------------------------------------------------------

export interface ReviewArgs {
  memoryId: string
  reviewer?: string
  reason?: string
}

export async function handleReview(
  services: LoreServices,
  args: ReviewArgs,
  verdict: "approve" | "reject"
): Promise<ToolResult> {
  try {
    // Resolve the reviewer name. Explicit `reviewer` arg wins; the
    // engineer-identity resolver is the standard fallback used
    // elsewhere on the write boundary. The service-layer helper
    // throws on empty-string reviewers, so an unresolvable identity
    // surfaces a clear error rather than landing a row attributed
    // to "(unknown)".
    // Trim BOTH the explicit `reviewer` arg and the resolver result.
    // Without the resolver-side trim, a `users.me` response with a
    // whitespace-only `name` (or `LORE_USER_NAME="   "`) would
    // bypass this no-identity guard, forward into `recordReview`,
    // and surface as the bare service-layer "reviewer must be a
    // non-empty string" error instead of the friendly
    // "set LORE_USER_NAME or pass `--reviewer`" guidance. Mirrors
    // the CLI's resolver-trim posture
    // for surface parity.
    const trimmedExplicit = args.reviewer?.trim()
    const resolved =
      trimmedExplicit && trimmedExplicit.length > 0
        ? trimmedExplicit
        : (await services.identity.resolveAuthor())?.trim()
    if (!resolved || resolved.length === 0) {
      return toolError(
        new Error(
          `Cannot ${verdict} memory ${args.memoryId}: no reviewer identity ` +
            `available. Pass an explicit \`reviewer\` argument or set ` +
            `\`LORE_USER_NAME\` so the audit trail can record who ` +
            `approved/rejected the row.`
        )
      )
    }
    const reviewer = resolved

    const result = await services.memories.recordReview({
      memoryId: args.memoryId,
      verdict,
      reviewer,
      reason: args.reason,
    })

    const verdictLabel = verdict === "approve" ? "Approved" : "Rejected"
    const newStatus = result.memory.status
    const lines = [
      `${verdictLabel} memory ${args.memoryId} (status: proposed → ${newStatus}).`,
      `Reviewer: ${reviewer}`,
    ]
    if (args.reason && args.reason.trim().length > 0) {
      lines.push(`Reason: ${args.reason.trim()}`)
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      costOutputs: { memoriesUpdated: 1 },
    }
  } catch (err) {
    return toolError(err)
  }
}
