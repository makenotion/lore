/**
 * High-level wrapper for `update_page` / `update_content` that the
 * domain layer (e.g. `MemoryService.upsertByTopicKey` /
 * `rekeyTopicKey` large-body fix) consumes. Owns
 * three concerns:
 *
 * 1. **Pre-call validation.** Reject inputs the wrapper can prove will
 *    fail server-side (empty / malformed `pageId`, empty `old_str`,
 *    intra-batch duplicate anchors when `replace_all_matches` is
 *    unset). Failing fast lets callers branch deterministically before
 *    the wire round-trip.
 * 2. **Error mapping.** RunTool's structured 400s for "no match",
 *    "multiple matches", and 200-with-deletion-warning surface as
 *    `RunToolBlockEditError`. The 403 `RestrictedResource` capability
 *    rejection ALSO maps to a fall-back-able kind
 *    (`restricted_resource`) because the auth-refresh proxy cannot
 *    repair it — the dispatcher's `RunToolBlockEditError` shape carries
 *    the contract. Other
 *    transport errors (401 / 429 / 5xx / malformed) propagate
 *    verbatim so the auth-refresh and rate-limit gates keep working.
 * 3. **Narrow surface.** Callers pass an array of `{ old_str, new_str }`
 *    edits plus a deliberate `allowDeletingContent` opt-in. Everything
 *    else stays internal so the RunTool quarantine's "narrow API"
 *    non-goal stays enforced.
 */

import type { Client } from "@notionhq/client"
import { RunToolBlockEditError, runUpdatePageContent } from "./client.js"
import { isLikelyNotionPageId } from "./error-helpers.js"
import type { RunToolUpdateContentEdit } from "./types.js"

export interface UpdatePageContentEdit {
  /** Exact substring to find on the page body. Required to be non-empty
   *  — server rejects an empty anchor and the failure is not
   *  fall-back-able (it is a programming error). */
  oldStr: string
  /** Replacement text. May be empty (an explicit deletion). */
  newStr: string
  /** When true, every occurrence of `oldStr` is replaced. Default false:
   *  the server fails on multiple matches under the safe default and the
   *  wrapper relays that as `multiple_matches` for the caller to fall
   *  back from. */
  replaceAllMatches?: boolean
}

export interface UpdatePageContentParams {
  pageId: string
  updates: UpdatePageContentEdit[]
  /** Opt in to deletion warnings — required when an edit may remove
   *  child pages or databases. Defaults to false; the wrapper raises
   *  `deletion_warning` rather than silently allowing the loss. */
  allowDeletingContent?: boolean
}

/**
 * Send the structured `update_content` request and translate the
 * response into a stable success / fall-back signal. On success returns
 * `{ ok: true, deletionWarning: boolean }`; the boolean is true iff the
 * caller opted into deletions AND the server reported one (so an audit
 * surface can render it). On a fall-back-able failure throws
 * `RunToolBlockEditError`; consumers catch and use their existing
 * REST/SDK path.
 */
export async function updatePageContentViaRunTool(
  client: Client,
  params: UpdatePageContentParams
): Promise<{ ok: true; deletionWarning: boolean }> {
  if (!params.pageId || params.pageId.trim().length === 0) {
    throw new Error("updatePageContentViaRunTool: pageId is required")
  }
  // Reject obvious programmer-bug shapes (`"undefined"`, `"[object Object]"`,
  // accidental `${value}` template-literal substitutions of non-strings)
  // before the wire round-trip. Notion accepts both the dashed UUID
  // form and the bare 32-hex form for page ids; anything else is a
  // caller bug we'd rather diagnose locally than have surface as a
  // generic Notion 400.
  if (!isLikelyNotionPageId(params.pageId)) {
    throw new Error(
      `updatePageContentViaRunTool: pageId does not look like a Notion ` +
        `page id (expected 32-hex or dashed UUID); got ${JSON.stringify(params.pageId)}.`
    )
  }
  if (params.updates.length === 0) {
    throw new Error("updatePageContentViaRunTool: updates must be non-empty")
  }

  // Reject empty anchors and same-batch duplicate anchors before the
  // wire call. The server rejects both with messages we'd otherwise have
  // to disambiguate from the legitimate "anchor not found in body" case
  // — and a duplicate anchor inside one request is unambiguously a
  // caller bug, not an authoritative-state miss the wrapper should
  // silently fall back from.
  const seenAnchors = new Set<string>()
  for (const update of params.updates) {
    if (update.oldStr.length === 0) {
      throw new Error(
        "updatePageContentViaRunTool: oldStr cannot be empty; " +
          "an empty anchor cannot be a unique substring."
      )
    }
    if (!update.replaceAllMatches) {
      if (seenAnchors.has(update.oldStr)) {
        throw new Error(
          "updatePageContentViaRunTool: duplicate oldStr in updates batch " +
            "without replace_all_matches; the server would reject this as " +
            "ambiguous. Pass replace_all_matches=true if every match should " +
            "be substituted, or split the edits into separate requests."
        )
      }
      seenAnchors.add(update.oldStr)
    }
  }

  const contentUpdates: RunToolUpdateContentEdit[] = params.updates.map((update) => ({
    old_str: update.oldStr,
    new_str: update.newStr,
    ...(update.replaceAllMatches ? { replace_all_matches: true } : {}),
  }))

  const response = await runUpdatePageContent(client, {
    page_id: params.pageId,
    command: "update_content",
    content_updates: contentUpdates,
    ...(params.allowDeletingContent ? { allow_deleting_content: true } : {}),
  })

  return {
    ok: true,
    deletionWarning: params.allowDeletingContent === true && hasDeletionWarning(response),
  }
}

function hasDeletionWarning(response: { deletion_warning?: unknown }): boolean {
  const warning = response.deletion_warning
  if (!warning) return false
  if (Array.isArray(warning)) return warning.length > 0
  return true
}

export { RunToolBlockEditError }
export type { RunToolBlockEditFailureKind } from "./client.js"
