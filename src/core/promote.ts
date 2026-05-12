/**
 * Cross-vault memory promotion.
 *
 * Promotion is the deliberate path for copying a memory from the primary
 * vault into a configured promotion target (issue #286). It is NOT a
 * read-orchestration concept — normal save / update / fact / decision /
 * task tools still write only to the primary vault. The only path that
 * fans out beyond the primary is this helper plus its CLI wrapper
 * (`lore promote`).
 *
 * The promoted row in the target vault is a NEW memory with an audit
 * block recording where it came from. Cross-vault links are stored as
 * stable text/url metadata in the body audit block, not as Notion
 * relations — per the issue's "Do not rely on Notion relations across
 * vaults" rule. Two structural reasons:
 *
 * 1. A Notion `relation` column points at a specific database, so a
 *    primary-vault memory id cannot be the target of a relation column
 *    living in the target vault's Memories DB.
 * 2. The promoted row outlives its source. If an operator later archives
 *    the primary-vault row, the audit block in the target vault still
 *    carries the source id and a deep-link the operator can follow into
 *    Notion's trash.
 *
 * Project taxonomies are NOT carried across the vault boundary. A
 * primary-vault project relation is meaningless in the target vault
 * (the project row lives in a different Projects DB), so the promoted
 * row lands with `projectIds: []` and the operator re-scopes it via
 * `lore-memory action='update'` in the target vault if needed.
 *
 * Same-vault guard: promoting INTO the primary vault collapses to a
 * regular create with the audit block; the helper rejects that case
 * with a clear error rather than silently writing a duplicate row in
 * the same vault. Both page ids are normalized via `normalizePageId`
 * (strip hyphens, lowercase) before comparison so the guard catches
 * the dashed-vs-undashed pair Notion accepts as equivalent — without
 * normalization an operator could bypass the guard by configuring
 * `vault.pageId` with hyphens and the promotion target's `pageId`
 * without (or vice versa).
 *
 * Retry posture: this helper is NOT idempotent. A second run with the
 * same `sourceMemoryId` + target creates a second target-vault row
 * with a fresh audit block. The cross-vault link lives in text/url
 * metadata, not a relation, so there is no read-side dedup key the
 * helper can probe against the target before writing. Operators who
 * land a duplicate via re-run should archive one of the pair via
 * `lore-memory action='archive'` in the target vault; collapsing two
 * promoted rows into one is not safe to automate without a vocabulary
 * for which Reason/Promoter/timestamp wins on the survivor. A future
 * follow-up can add a `Promotion Source` rich_text column on the
 * Memories DB (additive-only schema change) and key dedup against it;
 * the helper's current contract leaves that surface open for that
 * future PR rather than committing to a `Topic Key` repurpose that
 * would conflict with the existing topic-key upsert chain.
 *
 * `--dry-run` is supported on the CLI wrapper: it issues the source
 * read but skips both `targetVault.load` and `targetMemories.create`,
 * returning the audit block + the resolved status for the operator to
 * preview. The wrapper renders the block to stdout; this helper has a
 * sibling `previewPromotion` function that returns the same shape
 * without performing the target write.
 */

import type { Client } from "@notionhq/client"
import { VaultManager } from "./vault.js"
import { MemoryService } from "./memory.js"
import type { PromotionTargetTopologyRef } from "./topology.js"
import type { Memory, MemoryKind, MemoryStatus } from "../types.js"

/**
 * Notion's `rich_text` cap on the audit block we prepend to the
 * promoted body. The block is plain markdown text, but Notion's
 * markdown API splits on its own per-segment cap; the load-bearing
 * concern is human readability, not Notion's structural cap. A reason
 * longer than this is almost certainly a paste-by-accident rather than
 * a deliberate rationale and would push the audit block off the
 * reader's first screen — truncate with a marker so the operator can
 * recover the full text from CLI scrollback or the audit log if
 * needed.
 */
export const PROMOTION_REASON_MAX_LEN = 1000

export interface PromoteMemoryServices {
  /**
   * Shared Notion client from `initServices()`. The promotion writes
   * through the same auth-refreshing + rate-limited Proxy as primary-
   * vault writes, so cross-vault fan-out stays under the process-wide
   * Notion rate-limit bucket (issue #286: "reuse the existing rate
   * limiter posture per process/token").
   */
  client: Client
  /**
   * Primary-vault memory service. Used to read the source memory
   * (title, body, properties) before constructing the cross-vault
   * copy.
   */
  memories: MemoryService
  /**
   * Primary-vault page id. Promotion INTO the primary vault is
   * rejected — the operator wants `lore-memory action='update'` or
   * a fresh save, not a self-referential cross-vault audit block.
   */
  primaryVaultPageId: string
  /**
   * Display label for the primary vault. Stored verbatim in the audit
   * block as "Source vault" so the operator reading the promoted row
   * sees the same name they configured in `.lore.yaml`. Defaults to
   * the literal `Primary` (mirrors `buildVaultTopology`'s primary
   * label) when omitted.
   */
  primaryVaultLabel?: string
}

export interface PromoteMemoryInput {
  /**
   * Notion page id of the source memory in the primary vault.
   */
  sourceMemoryId: string
  /**
   * Resolved promotion target. The caller looks this up in the
   * topology (`buildVaultTopology(config).promotionTargets`) so the
   * service helper does not have to know the config shape.
   */
  target: PromotionTargetTopologyRef
  /**
   * Free-form rationale for the promotion. Empty / whitespace-only
   * inputs are treated as absent (no rationale line in the audit
   * block). Capped at `PROMOTION_REASON_MAX_LEN`; longer values are
   * truncated with a `… [truncated]` marker.
   */
  reason?: string
  /**
   * Engineer name to record as the promoter. Required: an
   * unattributed promotion is structurally indistinguishable from
   * a clandestine cross-vault copy, which is exactly the audit gap
   * the topology design exists to close.
   */
  promoter: string
  /**
   * Deep-link to the source memory in Notion. The caller builds this
   * via `cli/output.ts:notionPageUrl` (or equivalent) so the helper
   * does not duplicate the link-building logic. Optional — the audit
   * block still renders without it, surfacing only the bare id.
   */
  sourceMemoryUrl?: string
  /**
   * Override for "now". Tests inject a deterministic Date so audit
   * blocks compare exactly. Production callers omit it; the helper
   * uses `new Date()`.
   */
  now?: Date
}

export interface PromoteMemoryResult {
  /**
   * Newly-created memory in the target vault.
   */
  promoted: Memory
  /**
   * Display label of the target vault (`target.label`). Returned so
   * the CLI/MCP wrappers can render "Promoted to <label>" without
   * threading the topology ref back through their response shaping.
   */
  targetVaultLabel: string
  /**
   * The resolved status the promoted row landed with — `proposed`
   * when the target's `requireReview` flag is set, the source's
   * status otherwise. Surfaced so wrappers can render "(awaiting
   * review)" when the target gates promotion behind review policy.
   */
  status: MemoryStatus
}

/**
 * Promote a memory from the primary vault into a configured
 * promotion target.
 *
 * Steps:
 * 1. Read the source memory (title + body + properties) from the
 *    primary vault.
 * 2. Reject same-vault promotions (target.pageId === primary).
 * 3. Construct a `VaultManager` against `target.pageId` using the
 *    same shared client, load it without drift-checking, and
 *    construct a target-scoped `MemoryService`.
 * 4. Build the cross-vault audit block (`## Promoted from …`) and
 *    prepend it to the source body.
 * 5. Resolve the target status: `proposed` if `requireReview`,
 *    otherwise pass through the source memory's `status` (a
 *    promoted draft stays a draft, a promoted accepted memory
 *    stays accepted).
 * 6. Create the new memory in the target vault. The new row's
 *    `source` is forced to `"manual"` — cross-vault copies are
 *    operator-deliberate, not autosave / file / digest provenance.
 *    Project relations are NOT carried across the vault boundary
 *    (the project id lives in the primary's Projects DB and is
 *    meaningless in the target).
 *
 * Throws on:
 * - Source memory not found in the primary vault (delegated to
 *   `memories.getById`).
 * - Same-vault target (caught here with a clear error).
 * - Target vault load failure (delegated to `VaultManager.load`).
 * - Target-vault create failure (delegated to `MemoryService.create`).
 */
export async function promoteMemory(
  services: PromoteMemoryServices,
  input: PromoteMemoryInput
): Promise<PromoteMemoryResult> {
  const preview = await preparePromotion(services, input)

  const targetVault = new VaultManager(services.client, input.target.pageId)
  await targetVault.load({ driftCheck: false })
  const targetMemories = new MemoryService(services.client, targetVault.databases.memories)

  const promoted = await targetMemories.create({
    title: preview.source.title,
    content: preview.body,
    // Source URL / id / project taxonomy do NOT cross the vault
    // boundary. The target's Projects DB has different ids; the
    // operator re-scopes via `lore-memory action='update'` if
    // needed.
    projectIds: [],
    source: "manual",
    kind: preview.source.kind,
    status: preview.status,
    confidence: preview.source.confidence,
    // Tags do NOT cross the vault boundary either — mirrors the
    // `projectIds: []` treatment for the same reason. The closed
    // `Tag` vocabulary is enforced at the MCP boundary, not in the
    // service layer (per `CreateMemoryInput.tags` at
    // `src/types.ts:874-880`), so target-vault tag vocabularies can
    // diverge from the source's. A copied tag that's no longer
    // valid in the target's MCP-boundary Zod schema would commit
    // here and then reject on the operator's next
    // `lore-memory action='update'` from the target. Drop tags;
    // the operator re-tags via `lore-memory action='update'`
    // against the target-vault MCP boundary if needed.
    tags: [],
    keywords: preview.source.keywords,
    synopsis: preview.source.synopsis,
    author: preview.promoter,
    // `agent` and `session` are intentionally omitted: a cross-vault
    // promotion is operator-deliberate, not an agent-attributed
    // autosave or session-tied artifact. The source-vault Agent
    // value is `rich_text` so there's no taxonomy collision to
    // avoid; the load-bearing reason is that promotion is a
    // human-curated copy, not an agent-attributed write.
    // Skip the autosave-learning dedup gate — promotion is a
    // deliberate cross-vault write, not a session-scoped reuse.
    autosaveLearningDedupScope: "off",
  })

  return {
    promoted,
    targetVaultLabel: input.target.label,
    status: preview.status,
  }
}

export interface PromotionPreview {
  /**
   * Source memory loaded from the primary vault, validated via the
   * live-Memories-page gate (`getPropertiesById` rejects archived
   * rows and pages whose parent is not the primary vault's
   * Memories DB). Carries the body content materialized via
   * `materializeContent`.
   */
  source: Memory
  /**
   * Audit block that would be prepended to the promoted body.
   */
  auditBlock: string
  /**
   * Full promoted-body text (audit block + source content). Empty
   * source bodies collapse to bare audit block.
   */
  body: string
  /**
   * Resolved promoter name (post-trim).
   */
  promoter: string
  /**
   * Status the promoted row would land with — `proposed` when the
   * target requires review, else the source's status.
   */
  status: MemoryStatus
}

/**
 * Validate inputs, read the source memory, and compose the audit
 * block + resolved status — but do NOT load the target vault and do
 * NOT write the target row. Powers `--dry-run` on the CLI wrapper:
 * the operator gets a faithful preview of what `promoteMemory`
 * would do, at the cost of one `pages.retrieve` + one
 * `pages.retrieveMarkdown` on the source. No target-vault round-
 * trips.
 *
 * Reused by `promoteMemory` itself so the validate-read-compose
 * pipeline is byte-stable across the dry-run and apply paths —
 * future contributors adding a new guard or audit-field touch one
 * function instead of keeping two branches in sync.
 *
 * Validation order is intentional:
 * 1. Same-vault rejection (no source read, no network call).
 * 2. Empty-promoter rejection (no source read, no network call).
 * 3. Source live-memory load (one Notion round-trip).
 *
 * Cheap rejections run first so a misconfigured invocation fails
 * before paying the source read.
 */
export async function preparePromotion(
  services: PromoteMemoryServices,
  input: PromoteMemoryInput
): Promise<PromotionPreview> {
  if (samePageId(input.target.pageId, services.primaryVaultPageId)) {
    throw new Error(
      `Cannot promote into the primary vault (target "${input.target.label}" ` +
        `points at the same page id as the primary). Promotion is a cross-vault ` +
        `operation — to retitle, restatus, or otherwise modify the source row ` +
        `in place, use \`lore-memory action='update'\`.`
    )
  }

  const promoterName = input.promoter.trim()
  if (promoterName.length === 0) {
    throw new Error(
      "Promotion requires a non-empty promoter name so the audit block records " +
        "who promoted the memory. Set LORE_USER_NAME or pass `--promoter <name>` " +
        "directly."
    )
  }

  // Live-memory gate. `getPropertiesById` rejects archived rows and
  // pages whose parent is not the configured Memories DB via
  // `requireLiveMemoryPage`. Without this gate, `lore promote <any
  // accessible Notion page id>` would copy a page from any
  // database, or an archived Memory row, with the audit block
  // claiming primary-vault provenance — exactly the source/
  // destination isolation contract the audit metadata is meant to
  // preserve. Then materialize the body via the same Notion call
  // path `MemoryService.getById` uses internally; failure here
  // propagates the underlying error.
  const sourceProps = await services.memories.getPropertiesById(input.sourceMemoryId)
  const source = await services.memories.materializeContent(sourceProps)

  const primaryLabel = services.primaryVaultLabel ?? "Primary"
  const now = input.now ?? new Date()
  const reason = normalizeReason(input.reason)
  const auditBlock = buildPromotionAuditBlock({
    sourceVaultLabel: primaryLabel,
    sourceMemoryId: source.id,
    sourceMemoryUrl: input.sourceMemoryUrl,
    sourceKind: source.kind,
    sourceStatus: source.status,
    sourceConfidence: source.confidence,
    sourceSynopsis: source.synopsis,
    targetVaultLabel: input.target.label,
    requireReview: input.target.requireReview,
    promoter: promoterName,
    promotedAt: now,
    reason,
  })

  const status: MemoryStatus = input.target.requireReview ? "proposed" : source.status
  const body = source.content.length > 0 ? `${auditBlock}\n\n${source.content}` : auditBlock

  return { source, auditBlock, body, promoter: promoterName, status }
}

/**
 * Normalize a Notion page id for equality comparison. Notion accepts
 * the same id in two structurally equivalent shapes: hyphenated UUID
 * (`abc12345-6789-…`) and compact 32-char form (`abc1234567...`).
 * `pageIdSchema` in `src/config.ts` does not normalize on load, so
 * `vault.pageId` and a `promotionTargets[].pageId` can carry
 * different shapes of the same id. A literal `===` would miss that
 * equivalence and let the same-vault guard pass on a target that
 * really IS the primary. Strip hyphens and lowercase before
 * comparing.
 */
function samePageId(a: string, b: string): boolean {
  return normalizePageId(a) === normalizePageId(b)
}

function normalizePageId(id: string): string {
  return id.replace(/-/g, "").toLowerCase()
}

function normalizeReason(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.length <= PROMOTION_REASON_MAX_LEN) return trimmed
  return `${trimmed.slice(0, PROMOTION_REASON_MAX_LEN)}… [truncated]`
}

interface PromotionAuditBlockInput {
  sourceVaultLabel: string
  sourceMemoryId: string
  sourceMemoryUrl?: string
  sourceKind: MemoryKind
  sourceStatus: MemoryStatus
  sourceConfidence: string
  sourceSynopsis: string
  targetVaultLabel: string
  requireReview: boolean
  promoter: string
  promotedAt: Date
  reason: string | undefined
}

/**
 * Build the `## Promoted from <vault>` audit block that gets
 * prepended to the promoted memory's body. Pure function so the
 * format is testable without Notion plumbing.
 *
 * The block format is part of the operator contract — it is what an
 * operator sees when they open the promoted row in Notion. Two
 * stability guarantees:
 *
 * 1. The leading `## Promoted from …` heading is the parseable
 *    signal that lets a future cross-vault audit renderer recognize
 *    a promoted row without consulting external state. Changing the
 *    prefix (e.g. dropping the "Promoted from" wording) silently
 *    breaks that signal.
 * 2. The bullet list uses `**Field:** value` markdown so Notion's
 *    markdown import renders bold field labels, matching the
 *    `## Revision N` and `## Reviewed` audit blocks elsewhere in the
 *    codebase. Pin via fixture tests when changes are intentional.
 */
export function buildPromotionAuditBlock(input: PromotionAuditBlockInput): string {
  const timestamp = input.promotedAt.toISOString()
  const lines: string[] = [`## Promoted from ${input.sourceVaultLabel}`, ""]
  lines.push(`- **Source memory:** ${formatSourceMemory(input)}`)
  lines.push(`- **Source vault:** ${input.sourceVaultLabel}`)
  lines.push(`- **Source kind:** ${input.sourceKind}`)
  lines.push(`- **Source status:** ${input.sourceStatus}`)
  lines.push(`- **Source confidence:** ${input.sourceConfidence}`)
  if (input.sourceSynopsis.trim().length > 0) {
    lines.push(`- **Source synopsis:** ${input.sourceSynopsis.trim()}`)
  }
  lines.push(`- **Promoted to:** ${input.targetVaultLabel}${input.requireReview ? " (review required)" : ""}`)
  lines.push(`- **Promoter:** ${input.promoter}`)
  lines.push(`- **Promoted at:** ${timestamp}`)
  if (input.reason !== undefined) {
    lines.push(`- **Reason:** ${input.reason}`)
  }
  return lines.join("\n")
}

function formatSourceMemory(input: PromotionAuditBlockInput): string {
  if (input.sourceMemoryUrl) {
    // Use the dashless / lowercased form for the displayed text so it
    // matches the URL slug (`notionPageUrl` strips hyphens). Notion
    // accepts both shapes of the same id; rendering them
    // symmetrically avoids a `[abc-123…](https://notion.so/abc123…)`
    // cosmetic mismatch that operators would otherwise read as "the
    // id and the link disagree."
    return `[${normalizePageId(input.sourceMemoryId)}](${input.sourceMemoryUrl})`
  }
  return input.sourceMemoryId
}
