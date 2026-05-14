/**
 * MCP tool helpers.
 */

import type { ZodError } from "zod"
import type { Memory } from "../types.js"
import type { MemoryService } from "../core/memory.js"
import type { FactService } from "../core/fact.js"
import type { Fact } from "../types.js"
import type { WakeUpCache } from "../core/wakeup-cache.js"
import { isRetryableError } from "../core/project-scope.js"
import { WriteBudgetExceededError } from "../notion/rate-limit.js"
import { redactDebugError, redactDebugMessage } from "../debug-redact.js"

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
  /**
   * Opt-out marker for `withWakeUpCacheBump`. Set on
   * write-action handlers whose code path provably did NOT mutate
   * Notion — e.g. the assertive-reuse short-circuit in
   * `lore-task action='create'` (returns an existing row without
   * calling `services.tasks.create`) and the already-judged
   * short-circuit in `lore-memory action='compare'` (returns when
   * both sides already carry the audit entry). The MCP transport
   * strips arbitrary fields it doesn't recognize, so this never
   * leaks past the dispatcher seam where the wrapper consumes it.
   *
   * Defaults to absent; the wrapper bumps unless the field is
   * explicitly `true`. Conservative — a forgotten marker on a
   * genuine no-op causes a wasted fan-out next wake-up; a marker
   * incorrectly applied to a path that DID mutate Notion would let
   * the cache serve stale state. The first failure mode is the safe
   * default.
   */
  noopWrite?: boolean
}

/**
 * Run a write-action handler and bump the wake-up cache's write
 * epoch. Wraps each write-action `case` in the
 * polymorphic dispatchers so a save / update / archive / create /
 * close / supersede invalidates a cached wake-up snapshot from
 * before the write.
 *
 * **Bumps for every parsed write action — even on `isError`
 * results.** Several write handlers can land durable Notion writes
 * and then return `toolError(...)` for a trailing partial-failure
 * (e.g. `DecisionCreateFactPartialFailureError` surfaced from
 * `decided_by` emission AFTER the decision row already persisted).
 * Gating the bump on `!result.isError` would let the cache serve a
 * pre-write snapshot for the full TTL after such a partial write —
 * silently incorrect. The conservative bump trades one unnecessary
 * fan-out (when an early validation failure rejects without
 * touching Notion) for guaranteed staleness invalidation on every
 * path that could have written. Handlers whose code path provably
 * did NOT mutate Notion opt out by setting `noopWrite: true` on the
 * result (the assertive-reuse and already-judged short-circuits do
 * this).
 *
 * The wrapper is structurally tiny on purpose — it sits at the
 * dispatcher seam, where the write-action case arms live.
 * Centralizing the bump here keeps the cache's invalidation contract
 * auditable: any handler not routed through this wrapper is, by
 * construction, a read action.
 *
 * `cache` is typed as optional because dozens of unit-test fixtures
 * across the MCP test suite construct partial `LoreServices` shapes
 * via `as never` casts and intentionally omit fields they don't
 * exercise. A required signature would force a coordinated update
 * across every fixture for no test-side benefit. Production callers
 * always supply the cache (`initServicesFromConfig` populates
 * `LoreServices.wakeupCache` unconditionally).
 */
export async function withWakeUpCacheBump(
  cache: WakeUpCache | undefined,
  run: () => Promise<ToolResult>
): Promise<ToolResult> {
  const result = await run()
  if (!result.noopWrite) cache?.bumpEpoch()
  return result
}

/**
 * Format an unknown error into a standard MCP tool error response.
 */
export function toolError(err: unknown): ToolResult {
  // WriteBudgetExceededError surfaces verbatim — no `Error: ` prefix —
  // so its text content matches the contract pattern
  // `^WriteBudgetExceeded: tool=<name> limit=<N> count=<final>$` that
  // the mining child grep-matches to halt gracefully. Any other shape
  // would either mis-classify the cap-hit as a transient error or
  // silently swallow the signal.
  if (err instanceof WriteBudgetExceededError) {
    return {
      content: [{ type: "text" as const, text: err.message }],
      isError: true,
    }
  }
  // MCP errors carry recovery guidance, so scrub sensitive SDK details without
  // applying the debug-log length cap.
  const rawMessage = err instanceof Error ? err.message : String(err)
  const message = redactDebugMessage(rawMessage, { truncate: false })
  const retryable = isRetryableError(err)
    ? `\n\n\`\`\`json\n${JSON.stringify({
        code: err.code,
        retryable: true,
      })}\n\`\`\``
    : ""
  return {
    content: [{ type: "text" as const, text: `Error: ${message}${retryable}` }],
    isError: true,
  }
}

/**
 * Render the pagination footer a cursor-aware list tool appends to its text
 * response when more results exist. Absence of the footer signals end-of-list.
 *
 * A fenced ```json block is used (not a bare JSON line) so agents can parse
 * it unambiguously even when list items contain colons, brackets, or other
 * JSON-looking syntax in their titles or bodies.
 */
export function paginationFooter(
  nextCursor: string | undefined,
  opts: { truncated?: boolean } = {}
): string {
  if (!nextCursor && !opts.truncated) return ""
  return `\n\n---\n\n\`\`\`json\n${JSON.stringify({
    ...(nextCursor ? { nextCursor } : {}),
    ...(opts.truncated ? { truncated: true } : {}),
  })}\n\`\`\``
}

/**
 * Opt-in operator observability for partial read-path failures. Partial
 * failures surface to the agent via the `Warnings:` footer, which is right
 * for the UX but leaves ops blind: one 429 on wake-up hydration and a
 * pathological corrupted-page situation both show up as an identical silent
 * partial response. When `LORE_DEBUG=1`, this helper emits one stderr line
 * per failing root so an operator running one session can see which shape
 * they're dealing with.
 *
 * Format: `[lore] partial-failure: root=<rootId> error=<message> tool=<toolName>`
 *
 * Only `error.message` is logged — not `error.stack`, `.body`, `.headers`, or
 * the full error object. The message is then routed through
 * `redactDebugError` which bounds length, strips
 * forward-compatible SDK leak shapes (`body=` / `headers=` / `payload=`),
 * and replaces Notion page-id-shaped substrings with `<page-id>`. The
 * explicit `root=<rootId>` field is NOT redacted — operators need it to
 * triage which root failed.
 *
 * Interpolated fields (`rootId`, `message`) have ASCII control characters
 * — newlines, carriage returns, tabs, and the 0x00-0x1F / 0x7F range —
 * replaced with spaces before the line is written. Under current callers
 * rootIds are Notion UUIDs and rejection messages are single-line, so this
 * is defensive: it preserves the one-event-per-line invariant that log
 * aggregators rely on when future callers (PF1-01 bounded retries,
 * wake-up parallel queries) stream through the same helper.
 */
export function debugLogPartialFailures(
  toolName: string,
  failures: ReadonlyArray<{ rootId: string; error: unknown }>
): void {
  if (process.env["LORE_DEBUG"] !== "1") return
  for (const { rootId, error } of failures) {
    process.stderr.write(
      `[lore] partial-failure: root=${oneLine(rootId)} error=${oneLine(redactDebugError(error))} tool=${toolName}\n`
    )
  }
}

// eslint-disable-next-line no-control-regex -- coercing to a single log line is the point
const CONTROL_CHARS = /[\x00-\x1F\x7F]/g

function oneLine(value: string): string {
  return value.replace(CONTROL_CHARS, " ")
}

/**
 * Operator observability for the auto-`mentions` fact emission path.
 * The auto-emit branch fires per-entity `createWithDedup`
 * calls in parallel after `lore-memory action='save'`; a per-entity
 * failure (transient 429, dedup probe race, schema drift on a vault
 * that hasn't run `lore migrate`) degrades to a no-op for THAT entity
 * rather than failing the surrounding save. The save itself always
 * succeeds; auto-mentions are advisory.
 *
 * Without this helper, a partial-emit failure is invisible to the
 * operator — the save response shows the saved memory but quietly
 * drops the missing fact. Under `LORE_DEBUG=1`, one stderr line per
 * failing entity surfaces enough detail to distinguish a transient
 * blip from a pathological loop.
 *
 * Format: `[lore] auto-fact-failure: source=<save|update> kind=<create|invalidate> memoryId=<id> entity=<entity> error=<message>`
 *
 * Same narrowing as `debugLogPartialFailures`: only `error.message`
 * is logged. ASCII control characters in `memoryId` / `entity` /
 * `message` are replaced with spaces before the line is written so
 * the one-event-per-line invariant log aggregators rely on holds even
 * if a future entity tokenizer surfaces a multi-line input.
 *
 * `source` is the originating tool action (`save` for save-time
 * emission; `update` for the diff-driven re-emission). Carrying it on
 * every line lets a future contributor distinguish save-time vs.
 * update-time emission failures without grepping the calling stack.
 * `kind` distinguishes the per-entity fact create from the stale-fact
 * invalidate path the diff-and-invalidate semantics introduced;
 * defaults to `"create"` so existing save-time call sites stay
 * source-compatible (no parameter re-threading at the call boundary).
 * The key set is uniform across save-time creates, update-time creates,
 * and update-time invalidates so log parsers grepping `[lore]
 * auto-fact-failure:` see one contract, not three.
 */
export function debugLogAutoFactFailure(
  source: "save" | "update",
  memoryId: string,
  entity: string,
  error: unknown,
  kind: "create" | "invalidate" = "create"
): void {
  if (process.env["LORE_DEBUG"] !== "1") return
  process.stderr.write(
    `[lore] auto-fact-failure: source=${source} kind=${kind} memoryId=${oneLine(memoryId)} entity=${oneLine(entity)} error=${oneLine(redactDebugError(error))}\n`
  )
}

/**
 * Opt-in operator observability for contradiction-decrement failures on
 * `lore-fact action='invalidate'` and `lore-decision action='supersede'` /
 * `'create'` (with `supersedesIds`). The decrement is advisory: a failed
 * `pages.update` on the source memory's `Confidence Score` must not fail
 * the surrounding response, because the user already got the contradiction
 * write they asked for (the fact IS invalidated; the decision IS marked
 * superseded). When `LORE_DEBUG=1`, this helper emits one stderr line per
 * failed decrement so an operator triaging confidence drift can tell a
 * transient 429 from a pathological loop.
 *
 * Format: `[lore] contradiction-failure: source=<source> memoryId=<memoryId> error=<message>`
 *
 * The `source` discriminator names the literal MCP action that triggered
 * the decrement, not the colloquial CLAUDE.md alias:
 * - `"invalidate"` — `lore-fact action='invalidate'`
 * - `"supersede"` — `lore-decision action='supersede'`
 * - `"decide-supersede"` — `lore-decision action='create'` with
 *   `supersedesIds` (the supersession is a side-effect of the create)
 *
 * Same `[lore]` prefix as `debugLogPartialFailures` and (forthcoming)
 * `debugLogTouchFailure` so `grep "[lore]"` surfaces all three failure
 * classes together. Per-key naming diverges by surface — `source=` here
 * because there is no Notion `root` and `tool=` would alias the more
 * specific MCP action discriminator. Same redaction posture: only
 * `error.message` is logged, control characters are coerced to spaces so
 * one failure produces exactly one log line.
 */
export function debugLogContradictionFailure(
  source: "invalidate" | "supersede" | "decide-supersede",
  memoryId: string,
  error: unknown
): void {
  if (process.env["LORE_DEBUG"] !== "1") return
  process.stderr.write(
    `[lore] contradiction-failure: source=${oneLine(source)} memoryId=${oneLine(memoryId)} error=${oneLine(redactDebugError(error))}\n`
  )
}

/**
 * Per-row failure logger for `MemoryService.touchOnRead` calls fired
 * from MCP read paths. Touch is advisory — a 429 on
 * one row must not break the surrounding response — so the wiring
 * passes an `onError(memoryId, error)` callback that flows here.
 *
 * Format: `[lore] touch-failure: memory=<id> error=<message> tool=<toolName>`
 *
 * Sibling of `debugLogPartialFailures` and shares its operator-only
 * posture: emits only when `LORE_DEBUG=1`, scrubs ASCII control
 * characters out of interpolated fields, logs `error.message` not
 * `error.stack`. The diverging key is `memory=<id>` rather than
 * `root=<id>` — touch-on-read failures are always a single Notion
 * memory page, not the root id of a fan-out, so the column name
 * carries that scope. Downstream parsers should match on the
 * `[lore] touch-failure:` prefix and the `error=` field.
 *
 * **Per-row signature, not a batch.** Unlike `debugLogPartialFailures`
 * (which receives a `failures` array from `settleAll`), touch failures
 * arrive one-at-a-time via `touchOnRead`'s per-row `onError` callback —
 * the data layer has already iterated the batch and isolated each
 * failure. Re-batching at this layer would either require accumulating
 * across the callback (state) or post-processing the call sites.
 * Per-row matches the data-layer contract; do not "normalize" to a
 * batch shape without revisiting `touchOnRead`'s `onError` signature.
 *
 * `tool` identifies which read path triggered the touch — `lore-query
 * (recall)` / `lore-query (search)` / `lore-query (ask)` / `lore-memory
 * (expand)` / `lore-context (wake-up)` — so a flood of 429s during one
 * action's hot path is distinguishable from a steady drip across all
 * five.
 */
export function debugLogTouchFailure(
  tool: string,
  memoryId: string,
  error: unknown
): void {
  if (process.env["LORE_DEBUG"] !== "1") return
  process.stderr.write(
    `[lore] touch-failure: memory=${oneLine(memoryId)} error=${oneLine(redactDebugError(error))} tool=${tool}\n`
  )
}

/**
 * Single shared seam for the citation-as-evidence touch wiring.
 * All five MCP read paths that surface a memory funnel
 * through here so the contract — empty-batch short-circuit, per-row
 * failure routing through `debugLogTouchFailure`, top-level throw
 * suppression — lives in one place. Reworking the contract (e.g.
 * switching from `await` to `void` for fire-and-forget) is a single-
 * file change.
 *
 * **`await`-then-suppress, not `void`-then-discard.** The outer
 * `await` is deliberate: tests rely on the awaited completion to
 * observe the touch via spy assertions, and the production path's
 * write latency on the first cite of the day is bounded by the
 * rate-limit middleware's concurrency cap
 * (`ceil(N / concurrency) × per-call-latency`). A `void
 * touchOnRead(...).catch(() => {})` pattern would let the response
 * return slightly faster but would (a) make the touch genuinely fire-
 * and-forget — losing the deterministic test observability — and (b)
 * race the next read on the same row through Notion's eventually-
 * consistent query index. The `await` posture trades a one-time first-
 * wake-up-of-day latency hit for testability and read-consistency.
 *
 * **Advisory contract.** Both the per-row `onError` callback and the
 * outer `try/catch` are needed: the callback drains the data layer's
 * isolated per-row failures (one 429 doesn't sink the batch), the
 * outer catch handles a synchronous throw on the `touchOnRead` call
 * itself (e.g. a missing-method test stub or a hypothetical sync
 * throw at the top of the implementation). Either layer alone would
 * leak the other's failure mode through to the response, so both
 * stay.
 */
export async function fireTouchOnRead(
  service: Pick<MemoryService, "touchOnRead">,
  rows: ReadonlyArray<Memory>,
  tool: string
): Promise<void> {
  if (rows.length === 0) return
  try {
    await service.touchOnRead(rows, {
      onError: (id, error) => debugLogTouchFailure(tool, id, error),
    })
  } catch {
    // intentionally suppressed — touch is advisory, never blocking
  }
}

/**
 * Fact-side mirror of `debugLogTouchFailure` (DEFERRED-02). Same posture:
 * gated on `LORE_DEBUG=1`, scrubs control characters, logs
 * `error.message`. The key is `fact=<id>` so log parsers can
 * distinguish memory and fact touch failures without re-running the
 * tool dispatcher.
 */
export function debugLogFactTouchFailure(
  tool: string,
  factId: string,
  error: unknown
): void {
  if (process.env["LORE_DEBUG"] !== "1") return
  process.stderr.write(
    `[lore] fact-touch-failure: fact=${oneLine(factId)} error=${oneLine(redactDebugError(error))} tool=${tool}\n`
  )
}

/**
 * Fact-side mirror of `fireTouchOnRead` (DEFERRED-02). Used by
 * `lore-query action='ask'` and `lore-context action='wake-up'` to
 * bump fact `Confidence Score` + `Last Referenced At` on visible
 * citations. Same advisory contract — the per-row `onError` drains
 * data-layer failures, the outer `try/catch` suppresses synchronous
 * throws.
 */
export async function fireFactTouchOnRead(
  service: Pick<FactService, "touchOnRead">,
  rows: ReadonlyArray<Fact>,
  tool: string
): Promise<void> {
  if (rows.length === 0) return
  try {
    await service.touchOnRead(rows, {
      onError: (id, error) => debugLogFactTouchFailure(tool, id, error),
    })
  } catch {
    // intentionally suppressed — touch is advisory, never blocking
  }
}

/**
 * Render a Zod validation error as a single-line dispatch error message
 * for the polymorphic `lore-*` tools. Surfaces the first issue
 * with `field.path: message` so the calling agent can correct the call
 * without parsing a stack trace. Discriminated-union mismatches manifest
 * as `action: Invalid discriminator value` which already names the
 * offending field, so no extra formatting is needed for that case.
 */
export function formatDispatchError(toolName: string, error: ZodError): string {
  const issue = error.issues[0]
  if (!issue) return `${toolName}: invalid arguments`
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)"
  return `${toolName}: ${path}: ${issue.message}`
}
