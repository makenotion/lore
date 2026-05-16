/**
 * `lore-pinned` polymorphic dispatcher.
 *
 * Pinned context blocks are an always-visible, shareable, optionally
 * read-only memory surface that Lore renders in `lore-context
 * action='wake-up'` BEFORE the relevance-ranked sections. They
 * encode governance context — team policies, project invariants,
 * current initiative state, escalation rules, coordination notes —
 * as a distinct primitive from retrieved memory rows.
 *
 * The four actions are siblings of `lore-memory`'s CRUD surface but
 * coherent as a sub-surface: every action targets the pinned-block
 * facet of an existing memory. Splitting them onto a separate
 * polymorphic tool keeps the agent-visible `lore-memory`
 * description lean and surfaces "pinned blocks" as a first-class
 * concept in the MCP tool surface.
 *
 * Audit trail: every pin / unpin / update operation appends a
 * `> Pinned/Unpinned/... <date> by <author>: <reason>` line to the
 * memory body so the change is recoverable from the row itself.
 * Operators forcing a read-only update see a distinct
 * `> Forced read-only update` line so the override is visible
 * inline.
 */

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import {
  DEFAULT_PINNED_BLOCK_LIMIT,
  MEMORY_MUTABILITIES,
  PINNED_BLOCKS_HARD_CAP,
  PINNED_PRIORITY_MAX,
  PINNED_PRIORITY_MIN,
  type MemoryMutability,
  type MemoryPinnedInput,
} from "../../types.js"
import { resolveReadProjectScope } from "../resolve.js"
import { MemoryReadOnlyError } from "../../core/memory.js"
import { RICH_TEXT_PROPERTY_MAX_LEN } from "../../core/rich-text-schema.js"
import { resolveAuthorForWrite } from "../../auth/identity.js"
import { formatDispatchError, toolError, withWakeUpCacheBump } from "../helpers.js"
import { LoreError, errorCauseMessage } from "../../errors.js"

/**
 * Soft cap on the user-supplied audit `reason` field.
 * The Zod boundary clamps before write; the audit-line builder
 * additionally scrubs ASCII control chars (newlines, tab,
 * carriage return, etc.) so a malicious reason cannot forge an
 * adjacent blockquote line. 500 chars matches the existing
 * `lore-memory action='approve'` / `'reject'` reason cap so
 * audit-line wording stays uniform across surfaces.
 */
const PIN_AUDIT_REASON_MAX = 500

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

interface PinArgs {
  memoryId: string
  priority?: number
  audience?: string
  mutability?: MemoryMutability
  reason?: string
}

interface UnpinArgs {
  memoryId: string
  reason?: string
}

interface UpdatePinnedArgs {
  memoryId: string
  priority?: number | null
  audience?: string | null
  mutability?: MemoryMutability | null
  reason?: string
  force?: boolean
}

interface ListPinnedArgs {
  projectName?: string
  audience?: string
  includeAllAudiences?: boolean
  limit?: number
}

const pinnedDispatchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("pin"),
    // Notion page ids are 32 hex chars (canonical) or 36 with
    // dashes (UUID form). `.max(64)` gives headroom for both
    // shapes plus accidental whitespace; without the cap, a
    // pathological caller could route a long string through
    // `pages.retrieve` before Notion rejects it.
    memoryId: z.string().max(64),
    priority: z.number().min(PINNED_PRIORITY_MIN).max(PINNED_PRIORITY_MAX).optional(),
    // Audience writes the `Audience` rich_text column shared with
    // the scope filter. Cap matches `scopeInputSchema.audience` (2000
    // char Notion limit). Without this, a 1999-char comma-bomb would
    // run through the audience-match split+lowercase pipeline on
    // every wake-up across every reader.
    audience: z.string().max(RICH_TEXT_PROPERTY_MAX_LEN).optional(),
    mutability: z.enum(MEMORY_MUTABILITIES).optional(),
    reason: z.string().max(PIN_AUDIT_REASON_MAX).optional(),
  }),
  z.object({
    action: z.literal("unpin"),
    // Notion page ids are 32 hex chars (canonical) or 36 with
    // dashes (UUID form). `.max(64)` gives headroom for both
    // shapes plus accidental whitespace; without the cap, a
    // pathological caller could route a long string through
    // `pages.retrieve` before Notion rejects it.
    memoryId: z.string().max(64),
    reason: z.string().max(PIN_AUDIT_REASON_MAX).optional(),
  }),
  z.object({
    action: z.literal("update"),
    // Notion page ids are 32 hex chars (canonical) or 36 with
    // dashes (UUID form). `.max(64)` gives headroom for both
    // shapes plus accidental whitespace; without the cap, a
    // pathological caller could route a long string through
    // `pages.retrieve` before Notion rejects it.
    memoryId: z.string().max(64),
    priority: z
      .number()
      .min(PINNED_PRIORITY_MIN)
      .max(PINNED_PRIORITY_MAX)
      .optional()
      .nullable(),
    audience: z.string().max(RICH_TEXT_PROPERTY_MAX_LEN).optional().nullable(),
    mutability: z.enum(MEMORY_MUTABILITIES).optional().nullable(),
    reason: z.string().max(PIN_AUDIT_REASON_MAX).optional(),
    force: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("list"),
    projectName: z.string().optional(),
    audience: z.string().max(RICH_TEXT_PROPERTY_MAX_LEN).optional(),
    includeAllAudiences: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
])

export function registerPinnedTools(server: McpServer, services: LoreServices): void {
  server.registerTool(
    "lore-pinned",
    {
      title: "Pinned context blocks",
      description:
        "Manage pinned context blocks (issue #282) — always-visible memory rendered in wake-up before relevance-ranked sections. Audience-targeted via comma-separated tokens matched against the reader's agent/role/userId; `all` matches every reader. Read-only blocks reject `lore-memory action='update'` unless overridden via `force: true` here. `force: true` is a stop-sign visible in the audit trail, NOT an access-control gate — Lore uses one operator bearer token, so any MCP caller can flip it; every forced write lands a `> Forced read-only update` audit line on the memory body. Action-dispatched:\n\n" +
        "- `action: 'pin'` — flip an existing memory into a pinned block; sets priority / audience / mutability.\n" +
        "- `action: 'unpin'` — flip a pinned block back to a regular memory.\n" +
        "- `action: 'update'` — change priority / audience / mutability. Pass `force: true` to override `Mutability: read-only`.\n" +
        "- `action: 'list'` — list active blocks for current project + audience (or vault-wide). Use `includeAllAudiences: true` to skip the audience filter — every block in scope surfaces regardless of audience tokens. Not an authorization boundary; the field is rendered metadata for human triage.",
      inputSchema: {
        action: z
          .enum(["pin", "unpin", "update", "list"])
          .describe("Operation: pin | unpin | update | list."),
        memoryId: z
          .string()
          .optional()
          .describe(
            "Required for pin/unpin/update. The Notion page ID of the memory to operate on."
          ),
        priority: z
          .number()
          .optional()
          .nullable()
          .describe(
            `(pin | update) Sort priority for wake-up's Pinned Context section. Higher first; default 0. Range [${PINNED_PRIORITY_MIN}, ${PINNED_PRIORITY_MAX}]. Pass null on update to clear.`
          ),
        audience: z
          .string()
          .max(RICH_TEXT_PROPERTY_MAX_LEN)
          .optional()
          .nullable()
          .describe(
            `(pin | update | list) Comma-separated audience tokens; \`all\` matches every reader. On list, filters to blocks whose audience matches this token (otherwise applies the reader's scope context). Capped at ${RICH_TEXT_PROPERTY_MAX_LEN} chars to match the underlying rich_text column.`
          ),
        mutability: z
          .enum(MEMORY_MUTABILITIES)
          .optional()
          .nullable()
          .describe(
            "(pin | update) `mutable` (default) or `read-only`. Read-only pins reject `lore-memory action='update'`; override on this tool via `force: true`."
          ),
        reason: z
          .string()
          .max(PIN_AUDIT_REASON_MAX)
          .optional()
          .describe(
            `(pin | unpin | update) Optional rationale ≤${PIN_AUDIT_REASON_MAX} chars. Recorded as an audit line on the memory body. ASCII control characters and embedded newlines are scrubbed before interpolation so the rationale cannot forge an adjacent audit line.`
          ),
        force: z
          .boolean()
          .optional()
          .describe(
            "(update) Bypass `Mutability: read-only`. Records a `> Forced read-only update` audit line on the memory body. NOT an access-control gate — any MCP caller can flip this flag; the audit line is the contract."
          ),
        projectName: z
          .string()
          .optional()
          .describe(
            "(list) Project to filter pinned blocks by. Defaults to auto-detected project. Vault-wide pins surface in every project."
          ),
        includeAllAudiences: z
          .boolean()
          .optional()
          .describe(
            "(list) Skip the audience filter — show every block in scope regardless of audience tokens. Not an authorization boundary (audience is render metadata for human triage); use this when auditing across audiences."
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe(
            `(list) Max blocks returned (default ${DEFAULT_PINNED_BLOCK_LIMIT}, cap 100).`
          ),
      },
    },
    async (args) => {
      const parsed = pinnedDispatchSchema.safeParse(args)
      if (!parsed.success) {
        return toolError(new Error(formatDispatchError("lore-pinned", parsed.error)))
      }
      const data = parsed.data
      switch (data.action) {
        case "pin":
          return withWakeUpCacheBump(services.wakeupCache, () =>
            handlePin(services, data)
          )
        case "unpin":
          return withWakeUpCacheBump(services.wakeupCache, () =>
            handleUnpin(services, data)
          )
        case "update":
          return withWakeUpCacheBump(services.wakeupCache, () =>
            handleUpdate(services, data)
          )
        case "list":
          return handleList(services, data)
      }
    }
  )
}

/** The four audit-line verbs emitted by the pin/unpin/update path. */
type PinAuditAction =
  | "Pinned"
  | "Unpinned"
  | "Pinned block updated"
  | "Forced read-only update"

/**
 * Normalize a user-supplied audience string at the write boundary.
 * Whitespace-only audience writes are
 * collapsed to the empty string so the on-disk column doesn't
 * carry an unprintable "broadcast-via-spaces" signal — operators
 * see either an empty cell (broadcast) or non-whitespace tokens,
 * never a row of spaces masquerading as broadcast. Tokens are
 * trimmed and re-joined; embedded whitespace within a token is
 * preserved (so `"Claude Code"` survives as a single audience
 * token).
 *
 * Pure function — exported for unit-test coverage.
 */
export function normalizeAudienceWrite(audience: string): string {
  return audience
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .join(",")
}

/**
 * Strip ASCII control characters AND Unicode "invisible"
 * characters from user-controlled audit-line fields so a
 * malicious `reason` like
 * `"normal\n\n> Pinned 2026-01-01 by Attacker"` cannot forge an
 * adjacent blockquote line, and so bidi-override / zero-width
 * payloads cannot render an audit line that looks one way to a
 * human triaging Notion and another way to a model scanning the
 * markdown body.
 *
 * Stripped:
 * - C0 controls and DEL (0x00–0x1F, 0x7F) — line terminators,
 * tabs, etc.
 * - Bidi-override controls (U+202A–U+202E, U+2066–U+2069) —
 * RLO/PDF and friends; let an attacker render a reversed
 * audit line.
 * - Zero-width chars (U+200B–U+200D, U+FEFF) — let an
 * attacker inject invisible separators that confuse a
 * grep / parser.
 *
 * Each stripped run collapses to a single space, then runs of
 * whitespace fold and the result is trimmed.
 *
 * Applied to both `reason` (caller-controlled) and `author`
 * (server-resolved but technically free-form). Pure function.
 */
function scrubAuditField(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F]+/g, " ")
      // Bidi-override controls + zero-width characters.
      .replace(/[\u200B-\u200D\u202A-\u202E\u2066-\u2069\uFEFF]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  )
}

/**
 * Thrown when the primary pin/unpin/update mutation lands but the
 * audit-line append fails. Distinguishes the partial state ("the
 * change persisted but provenance is missing") from a clean
 * pre-mutation rejection so callers can retry-recover instead of
 * silently losing the audit trail on a transient blip.
 *
 * Mirrors `RekeyAuditError` in shape and contract. The error
 * carries the memory id, the action that landed, and the
 * underlying cause so the retry path can append the missing
 * audit line idempotently (the retry probes the existing body
 * for an audit line matching `(action, today)`; if absent, the
 * retry appends it).
 */
export class PinnedAuditError extends LoreError<"pinned-audit-failed"> {
  readonly memoryId: string
  readonly action: PinAuditAction
  readonly cause: unknown

  constructor(input: { memoryId: string; action: PinAuditAction; cause: unknown }) {
    const causeMsg =
      input.cause instanceof Error ? input.cause.message : String(input.cause)
    super(
      "pinned-audit-failed",
      `PinnedAuditError: ${input.action.toLowerCase()} for memory ` +
        `${input.memoryId} persisted, but the audit-line append failed: ` +
        `${causeMsg}. Retry the same lore-pinned action to re-attempt the ` +
        "audit append; the primary mutation is idempotent on the row's " +
        "current state.",
      {
        memoryId: input.memoryId,
        action: input.action,
        causeMessage: errorCauseMessage(input.cause),
      },
      { cause: input.cause }
    )
    this.name = "PinnedAuditError"
    this.memoryId = input.memoryId
    this.action = input.action
    this.cause = input.cause
  }
}

/**
 * Thrown when `handlePin` would push the active-pin count past
 * `PINNED_BLOCKS_HARD_CAP`. Closes the
 * defense-in-depth gap where a malicious or runaway caller pins
 * many narrow-audience rows, exhausting `collectLivePages`'s
 * refill ceiling before the audience filter can backfill matching
 * pins for other readers. The cap sits below the refill ceiling
 * so backfill always has room; well above the render-time abuse
 * warning so legitimate growth surfaces a soft signal first.
 *
 * Carries the current and capped counts plus a pointer to
 * `lore pinned list --all-audiences` / `lore-pinned
 * action='unpin'` so operators know exactly how to recover.
 */
export class PinnedCapExceededError extends LoreError<"pinned-cap-exceeded"> {
  readonly currentCount: number
  readonly cap: number

  constructor(input: { currentCount: number; cap: number }) {
    super(
      "pinned-cap-exceeded",
      `PinnedCapExceededError: cannot pin — vault already has ` +
        `${input.currentCount} active pinned block(s), at the ${input.cap}-block ` +
        "hard cap. Unpin stale or unauthorized blocks first via " +
        "`lore pinned list --all-audiences` followed by " +
        "`lore-pinned action='unpin' memoryId=<id>`. The cap prevents " +
        "cross-audience pin spam from starving legitimate matching pins " +
        "out of wake-up's bounded refill window.",
      { currentCount: input.currentCount, cap: input.cap }
    )
    this.name = "PinnedCapExceededError"
    this.currentCount = input.currentCount
    this.cap = input.cap
  }
}

/**
 * Probe whether the row body already carries an audit line for
 * `(action, today)`. The check looks for the canonical blockquote
 * prefix `> <Action> <YYYY-MM-DD>` — a successful retry should
 * find the line and skip the re-append. Pre-existing audit lines
 * with a different date or different action are ignored.
 *
 * Exported for unit-test coverage; production callers route
 * through `appendPinAuditLine`.
 */
/**
 * Escape regex metacharacters in `input` so the result is safe to
 * splice into a `new RegExp(...)` literal. Module-local helper so
 * the earlier shape's brittle escape footgun about an inline
 * character class doesn't expand if a future audit-line verb
 * introduces a new metacharacter.
 */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function bodyContainsPinAuditLine(
  body: string,
  action: PinAuditAction,
  today: string
): boolean {
  const prefix = `> ${action} ${today}`
  // Audit lines are appended with a trailing `\n` and may carry
  // an author / reason after the date. Match the prefix at line
  // start (start of body OR after a `\n`) and accept the rest of
  // the line as the audit-line tail.
  return new RegExp(`(^|\\n)${escapeRegExp(prefix)}(?:[ \\t][^\\n]*)?(?:\\n|$)`).test(
    body
  )
}

/**
 * Return the verb of the LAST `> Pinned <date>` / `> Unpinned <date>`
 * audit line in the body, or `null` when no pin/unpin transition has
 * been recorded.
 *
 * Used by the retry-recovery branches in `handlePin` / `handleUnpin`
 * to decide whether the most recent state transition was audited.
 * The naive `bodyContainsPinAuditLine` check keyed only on
 * `(action, today)`, which on a same-day `pin → unpin → pin`
 * sequence whose second pin's audit append failed would see the
 * first pin's audit line and incorrectly conclude "audit already
 * present" — silently dropping the second pin's audit.
 *
 * The fix: read the LATEST pin/unpin transition from the body and
 * compare against the row's current `Pinned` state. When they
 * disagree, the most recent state transition wasn't audited and the
 * retry-recover branch must append the missing line. When they
 * agree, the retry is a true no-op.
 *
 * Audit lines for `Pinned block updated` and `Forced read-only
 * update` are deliberately IGNORED — those don't transition the
 * row's pin state, so they shouldn't shadow a same-day pin/unpin
 * audit.
 *
 * Exported for unit-test coverage.
 */
// Module-level regex (no `g` flag) so concurrent calls can't race
// on `lastIndex`. The hot pin/unpin retry path uses
// `String.prototype.matchAll` against a freshly-flagged copy via
// the helper below to sidestep the stateful-regex sharp edge.
const PIN_TRANSITION_RE =
  /(^|\n)> (Pinned|Unpinned) \d{4}-\d{2}-\d{2}(?:[ \t][^\n]*)?(?:\n|$)/

export function latestPinnedTransition(body: string): "Pinned" | "Unpinned" | null {
  // `matchAll` requires a `g`-flagged regex; build one per call
  // from the module-level source so the shared instance can't
  // race on `lastIndex` across overlapping async callers. The
  // RegExp construction is cheap (single literal) and avoids the
  // stateful-regex footgun.
  const re = new RegExp(PIN_TRANSITION_RE, "g")
  let last: "Pinned" | "Unpinned" | null = null
  for (const match of body.matchAll(re)) {
    last = match[2] as "Pinned" | "Unpinned"
  }
  return last
}

/**
 * Append an audit line to a memory's body documenting a pin /
 * unpin / pin-update operation. Author / date / reason land inline
 * so the change is recoverable from the row itself without
 * consulting an external audit log.
 *
 * The line shape is a Markdown blockquote — distinct rendering in
 * Notion and in wake-up's `expand: true` body view. Audit lines
 * accumulate verbatim across operations; the latest lands at the
 * end of the body. Same posture as the topic-key re-key
 * `## Re-keyed (date)` append pattern.
 *
 * **Always appends** — no same-day dedupe gate. Every successful
 * mutation deserves its own audit line so the trail captures
 * repeated operations on the same date (e.g. two `update` calls in
 * one day, or a same-day `pin → unpin → pin` sequence). The
 * retry-recovery branches in `handlePin` / `handleUnpin` route
 * through `tryRecoverMissingAudit` below — that's where the
 * "don't stack a duplicate on retry of a partial audit append"
 * gate lives, keyed on the latest pin/unpin transition (NOT on
 * `(action, today)` substring presence, which misfires on same-day
 * repeat operations — a second pin's audit failure followed by
 * retry would see the first pin's audit line and incorrectly
 * conclude "audit already present").
 *
 * Bypasses the read-only guard on `MemoryService.update` for the
 * audit-line append — the audit IS the record of the override or
 * operator action, so refusing to write it would leave the change
 * unrecoverable.
 *
 * On audit-write failure: throws `PinnedAuditError` so the caller
 * can surface the partial-state error to the operator. The
 * primary mutation has already landed.
 */
async function appendPinAuditLine(
  services: LoreServices,
  memoryId: string,
  action: PinAuditAction,
  reason: string | undefined
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  const author = await resolveAuthorForWrite(undefined, services.identity)
  const memory = await services.memories.getById(memoryId)
  const existing = memory.content.trimEnd()
  const cleanReason = reason !== undefined ? scrubAuditField(reason) : ""
  const cleanAuthor = author !== undefined ? scrubAuditField(author) : ""
  const reasonPart = cleanReason.length > 0 ? `: ${cleanReason}` : ""
  const authorPart = cleanAuthor.length > 0 ? ` by ${cleanAuthor}` : ""
  const auditLine = `> ${action} ${today}${authorPart}${reasonPart}`
  const nextBody =
    existing.length > 0 ? `${existing}\n\n${auditLine}\n` : `${auditLine}\n`
  try {
    await services.memories.update(memoryId, {
      content: nextBody,
      allowReadOnlyUpdate: true,
    })
  } catch (cause) {
    throw new PinnedAuditError({ memoryId, action, cause })
  }
}

async function handlePin(services: LoreServices, args: PinArgs): Promise<ToolResult> {
  try {
    const memory = await services.memories.getPropertiesById(args.memoryId)
    // Retry-recover branch: a previous `action='pin'` may have
    // landed the property write but failed the audit append.
    // Re-issuing the same call hits "already pinned" — without
    // recovery, AC #4 is permanently lost. When the row is
    // pinned but the LATEST recorded pin/unpin transition in
    // the body is `Unpinned` (or there is no transition at
    // all), the missing pin audit gets appended. The recovery
    // dispatch lives in `tryRecoverMissingAudit`, which
    // compares the latest transition against the action being
    // retried — see its docstring for the state-
    // transition contract. `appendPinAuditLine` itself always
    // appends, so the dedupe gate is in `tryRecoverMissingAudit`.
    if (memory.pinned !== null && memory.pinned !== undefined) {
      const recovered = await tryRecoverMissingAudit(
        services,
        args.memoryId,
        "Pinned",
        args.reason
      )
      if (recovered) {
        return {
          content: [
            {
              type: "text",
              text:
                `Memory "${memory.title}" (${args.memoryId}) was already pinned ` +
                "but had no audit line for today's date — appended the missing " +
                "audit line. Use action='update' to change priority, audience, or mutability.",
            },
          ],
        }
      }
      return {
        content: [
          {
            type: "text",
            text: `Memory "${memory.title}" (${args.memoryId}) is already pinned. Use action='update' to change priority, audience, or mutability.`,
          },
        ],
      }
    }
    // Hard active-pin cap at the write boundary. Closes the
    // defense-in-depth gap where a
    // malicious caller spam-pins narrow-audience rows and
    // starves matching pins for other audiences past
    // `collectLivePages`'s refill ceiling. The cap is checked
    // BEFORE the property write so a rejected pin attempt
    // leaves vault state untouched. Retry-recovery on an
    // already-pinned row above bypasses this check (the row is
    // already pinned, no new pin lands).
    //
    // **TOCTOU note :** two concurrent `pin`
    // calls can both read `activePinCount = 199` and both write,
    // ending at 201. Bounded in practice (cap=200, refill
    // ceiling=500, abuse threshold fires at 100) so any overshoot
    // is single-digit and the next `countPinnedBlocks` surfaces
    // it via the wake-up warning. Not worth a preflight lock —
    // the cap is defense-in-depth, not a hard authorization
    // boundary; the abuse warning is the operator-facing signal.
    // A double-write defense would require a per-vault filesystem
    // lock and we don't gain enough to justify it.
    //
    // `MemoryService.update` enforces the same cap on any
    // pinning transition initiated through it ( review
    // request); the handler-level check stays as the primary
    // surface so the typed `PinnedCapExceededError` carries the
    // operator-facing recovery copy.
    const activePinCount = await services.memories.countPinnedBlocks()
    if (activePinCount >= PINNED_BLOCKS_HARD_CAP) {
      throw new PinnedCapExceededError({
        currentCount: activePinCount,
        cap: PINNED_BLOCKS_HARD_CAP,
      })
    }
    const pinnedInput: MemoryPinnedInput = { pinned: true }
    if (args.priority !== undefined) pinnedInput.priority = args.priority
    if (args.mutability !== undefined) pinnedInput.mutability = args.mutability
    // `bypassPinCapCheck: true` because we just verified the cap
    // above; the service-layer check would otherwise re-issue
    // `countPinnedBlocks` per pin. Both paths land the same typed
    // error class structure when the cap is exceeded — the
    // handler's `PinnedCapExceededError` (user-facing, with
    // recovery copy) and the service's
    // `MemoryPinCapExceededError` (defense-in-depth for service-
    // layer callers that don't go through this handler).
    const update: Parameters<typeof services.memories.update>[1] = {
      pinned: pinnedInput,
      bypassPinCapCheck: true,
    }
    const normalizedAudience =
      args.audience !== undefined ? normalizeAudienceWrite(args.audience) : undefined
    if (normalizedAudience !== undefined) {
      update.scope = { audience: normalizedAudience }
    }
    await services.memories.update(args.memoryId, update)
    await appendPinAuditLine(services, args.memoryId, "Pinned", args.reason)
    const lines: string[] = [`Pinned: "${memory.title}" (${args.memoryId})`]
    const meta: string[] = []
    if (args.priority !== undefined) meta.push(`priority ${args.priority}`)
    if (args.mutability) meta.push(args.mutability)
    if (normalizedAudience !== undefined) {
      meta.push(`audience: ${normalizedAudience.length > 0 ? normalizedAudience : "all"}`)
    }
    if (meta.length > 0) lines.push(`*${meta.join(" | ")}*`)
    lines.push(
      "",
      "The block now renders in `lore-context action='wake-up'` under `## Pinned Context` for every session that matches its audience."
    )
    return { content: [{ type: "text", text: lines.join("\n") }] }
  } catch (err) {
    return toolError(err)
  }
}

async function handleUnpin(services: LoreServices, args: UnpinArgs): Promise<ToolResult> {
  try {
    const memory = await services.memories.getPropertiesById(args.memoryId)
    // Retry-recover branch: the unpin property write may have
    // landed but the audit append failed, leaving the row
    // un-pinned with no audit line. Append the missing line so
    // AC #4 is recoverable. Mirrors the `handlePin` recovery.
    if (memory.pinned === null || memory.pinned === undefined) {
      const recovered = await tryRecoverMissingAudit(
        services,
        args.memoryId,
        "Unpinned",
        args.reason
      )
      if (recovered) {
        return {
          content: [
            {
              type: "text",
              text:
                `Memory "${memory.title}" (${args.memoryId}) was already ` +
                "unpinned but had no audit line for today's date — appended the missing " +
                "audit line.",
            },
          ],
        }
      }
      return {
        content: [
          {
            type: "text",
            text: `Memory "${memory.title}" (${args.memoryId}) is not pinned. Nothing to unpin.`,
          },
        ],
      }
    }
    if (memory.pinned.mutability === "read-only") {
      throw new MemoryReadOnlyError(args.memoryId, memory.title, {
        recovery:
          "To unpin a read-only block: first run `lore-pinned " +
          "action='update' memoryId='<id>' mutability='mutable' " +
          "force=true` to flip mutability, then re-issue " +
          "`lore-pinned action='unpin'`.",
      })
    }
    await services.memories.update(args.memoryId, {
      pinned: {
        pinned: false,
        priority: null,
        mutability: null,
      },
    })
    await appendPinAuditLine(services, args.memoryId, "Unpinned", args.reason)
    return {
      content: [
        {
          type: "text",
          text: `Unpinned: "${memory.title}" (${args.memoryId})`,
        },
      ],
    }
  } catch (err) {
    return toolError(err)
  }
}

/**
 * Probe whether the row's LATEST pin/unpin transition disagrees
 * with the action being retried; when it does, append the missing
 * audit line. Returns `true` on recovery (audit line appended),
 * `false` when the latest transition already matches (true no-op).
 *
 * State-transition-aware: the retry
 * check compares the LATEST pin/unpin audit line in the body
 * against the row's current `Pinned` state. The naive
 * `(action, today)` predicate could not distinguish "this retried
 * operation already audited" from "an older same-day operation
 * used the same verb." Consider the sequence on a single date:
 *
 * 1. `pin` succeeds, writes `> Pinned <today>`.
 * 2. `unpin` succeeds, writes `> Unpinned <today>`.
 * 3. `pin` lands the property write but its audit append fails.
 * 4. Retry `pin` enters the already-pinned recovery branch.
 *
 * Without state-transition awareness, step 4 sees the step-1
 * `> Pinned <today>` line and concludes "audit present" — silently
 * dropping step 3's missing audit. With state-transition awareness,
 * step 4 sees the latest transition is `Unpinned` while the row IS
 * pinned, recognizes the mismatch, and appends the missing
 * `> Pinned <today>` line.
 *
 * `action` is `"Pinned"` for `handlePin` recovery and `"Unpinned"`
 * for `handleUnpin` recovery. The helper appends iff the latest
 * recorded transition disagrees with `action`. Returns `true` when
 * an audit line was appended (recovery happened), `false` when the
 * latest transition already matched (true no-op).
 */
async function tryRecoverMissingAudit(
  services: LoreServices,
  memoryId: string,
  action: "Pinned" | "Unpinned",
  reason: string | undefined
): Promise<boolean> {
  const memory = await services.memories.getById(memoryId)
  if (latestPinnedTransition(memory.content) === action) {
    return false
  }
  await appendPinAuditLine(services, memoryId, action, reason)
  return true
}

async function handleUpdate(
  services: LoreServices,
  args: UpdatePinnedArgs
): Promise<ToolResult> {
  try {
    const memory = await services.memories.getPropertiesById(args.memoryId)
    if (memory.pinned === null || memory.pinned === undefined) {
      return toolError(
        new Error(
          `Memory "${memory.title}" (${args.memoryId}) is not pinned. Use action='pin' first.`
        )
      )
    }
    const force = args.force === true
    // reject `force: true` against a mutable
    // row. The override is structurally meaningful only on a
    // read-only block; setting it on a mutable row would write a
    // "Forced read-only update" audit line that misrepresents
    // the row state, OR (pre-) silently land a regular
    // "Pinned block updated" line that hides the caller's
    // intent. A typed rejection forces the caller to drop the
    // flag instead of carrying a misleading audit signal.
    if (force && memory.pinned.mutability !== "read-only") {
      return toolError(
        new Error(
          `Cannot use force=true on memory "${memory.title}" (${args.memoryId}): ` +
            "the pinned block is mutable, so the override has no effect. " +
            "Drop force=true or change mutability to 'read-only' first."
        )
      )
    }
    const pinnedInput: MemoryPinnedInput = {}
    if (args.priority !== undefined) pinnedInput.priority = args.priority
    if (args.mutability !== undefined) pinnedInput.mutability = args.mutability
    const update: Parameters<typeof services.memories.update>[1] = {
      pinned: pinnedInput,
    }
    if (args.audience !== undefined) {
      // Rich_text columns treat `""` as the clear value; `null` here
      // maps to that. Non-null audiences are normalized at the
      // write boundary so whitespace-only writes don't masquerade
      // as broadcast (handled by `normalizeAudienceWrite`).
      update.scope = {
        audience: args.audience === null ? "" : normalizeAudienceWrite(args.audience),
      }
    }
    if (force) {
      update.allowReadOnlyUpdate = true
    }
    await services.memories.update(args.memoryId, update)
    // Retry semantics on `handleUpdate` are intentionally
    // simpler than `handlePin` / `handleUnpin`. The primary
    // mutation is idempotent — re-applying the same
    // priority/audience/mutability set is a no-op for Notion.
    // If the audit append fails, the caller sees
    // `PinnedAuditError` and can re-issue the same call; the
    // retry's audit append lands a second `Pinned block
    // updated` line (or `Forced read-only update` when force
    // remains set). Two audit lines for two API calls is an
    // honest AC #4 signal — operators see exactly when each
    // attempt landed. Stronger retry-recover would require a
    // property-equality probe before the second audit which
    // adds complexity without a measurably better contract.
    if (force) {
      await appendPinAuditLine(
        services,
        args.memoryId,
        "Forced read-only update",
        args.reason
      )
    } else {
      await appendPinAuditLine(
        services,
        args.memoryId,
        "Pinned block updated",
        args.reason
      )
    }
    return {
      content: [
        {
          type: "text",
          text: `Updated pinned block: "${memory.title}" (${args.memoryId})`,
        },
      ],
    }
  } catch (err) {
    return toolError(err)
  }
}

async function handleList(
  services: LoreServices,
  args: ListPinnedArgs
): Promise<ToolResult> {
  try {
    const { projectId } = await resolveReadProjectScope(services, args.projectName)
    const limit = args.limit ?? DEFAULT_PINNED_BLOCK_LIMIT
    const today = new Date().toISOString().slice(0, 10)
    // Three audience-filter modes:
    // - `includeAllAudiences: true` → disable the audience filter
    // entirely via `audienceFilter: false` so every block in
    // scope surfaces. The earlier shape that passed
    // `readerContext: {}` did NOT achieve this — an empty
    // reader only matches universal / empty audiences, so
    // narrow-audience blocks would still be filtered out.
    // - `audience: "<token>"` → simulate a single-token reader so
    // operators can ask "what blocks are pinned for X?"
    // - default → use the resolved scope context, same audience
    // filter wake-up applies.
    // `includeOutOfScope` is intentionally NOT exposed on this
    // surface today; operators can drop down to `lore-memory
    // action='recall'` to see scoped rows outside their context.
    const useAllAudiences = args.includeAllAudiences === true
    const readerContext = useAllAudiences
      ? {}
      : args.audience !== undefined
        ? { agent: args.audience }
        : services.scopeContext
    const blocks = await services.memories.listPinnedBlocks({
      projectId: projectId ?? undefined,
      limit,
      today,
      readerContext,
      audienceFilter: !useAllAudiences,
      includeContent: false,
    })
    if (blocks.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No pinned context blocks active for the requested scope.",
          },
        ],
      }
    }
    const lines: string[] = [`## Pinned Context Blocks (${blocks.length})`, ""]
    for (const block of blocks) {
      lines.push(`### ${block.title}`)
      const meta: string[] = [`id: ${block.id}`]
      if (block.pinned) {
        meta.push(`priority ${block.pinned.priority}`)
        meta.push(block.pinned.mutability)
      }
      const audience = block.scope?.audience?.trim() ?? ""
      meta.push(`audience: ${audience.length > 0 ? audience : "all"}`)
      lines.push(`*${meta.join(" | ")}*`)
      if (block.synopsis.length > 0) lines.push(block.synopsis)
      lines.push("")
    }
    return { content: [{ type: "text", text: lines.join("\n") }] }
  } catch (err) {
    return toolError(err)
  }
}
