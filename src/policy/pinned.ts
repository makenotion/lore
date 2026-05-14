/**
 * Pinned-context policy limits.
 */

/**
 * Default cap on pinned-block rows surfaced in the wake-up `Pinned
 * Context` section. Tight enough to keep the section a governance
 * surface (team policies, project invariants, current initiative
 * state) rather than an inventory; operators with deeper sets can
 * tune via `pinnedBlockLimit` on the MCP wake-up call.
 */
export const DEFAULT_PINNED_BLOCK_LIMIT = 10

/**
 * Maximum `Pinned Priority` value accepted at the MCP/service
 * boundary. Notion's number column has no native range; clamping at
 * the boundary keeps sort order predictable and protects against a
 * malformed caller passing `Infinity`.
 */
export const PINNED_PRIORITY_MAX = 1_000_000
export const PINNED_PRIORITY_MIN = -1_000_000

/**
 * Active-pinned-block count above which the wake-up Pinned Context
 * section appends an operator-facing abuse warning.
 *
 * A malicious agent that runs `lore-pinned action='pin'` in a loop
 * can exhaust the wake-up Pinned Context render budget for every
 * other agent on the same vault — the visible cap renders the
 * highest-priority N rows, so high-priority spam pushes legitimate
 * pins out of the window. The threshold is conservative (10× the
 * default visible cap): a single project with a handful of pinned
 * blocks plus a vault-wide governance set sits comfortably below,
 * and crossing it surfaces an inline note so the operator sees the
 * abuse signal without having to instrument the vault separately.
 *
 * Not a hard pin-creation cap — pinning still succeeds past the
 * threshold so legitimate growth (a new governance program adding
 * many blocks at once) isn't blocked. The signal lives at the
 * render boundary so operators see it on the same surface that
 * exposes the blocks themselves.
 */
export const PINNED_BLOCKS_ABUSE_THRESHOLD = 100

/**
 * Hard cap on the total active-pinned-block count enforced at the
 * `lore-pinned action='pin'` write boundary.
 *
 * The render-time abuse warning above is operator-facing but does
 * not prevent the underlying defense-in-depth gap: a malicious or
 * runaway caller pinning many narrow-audience rows can exhaust
 * `collectLivePages`'s refill ceiling
 * (`LIVE_PAGE_REFILL_MAX_PAGES * LIVE_PAGE_QUERY_SIZE` = 500 rows)
 * before the walker reaches a matching pin for a different
 * audience. The matching reader then sees zero pinned context,
 * AND — when the renderer gates the warning on
 * `pinnedBlocks.length > 0` — no abuse signal either.
 *
 * The cap closes that gap structurally. Sitting at 200 (2× the
 * render warning threshold) gives operators headroom past the
 * warning to grow a legitimate governance corpus, while keeping
 * the total well below the refill ceiling so the audience filter
 * has room to backfill matching pins from rows ranked behind
 * non-matching ones.
 *
 * Pin attempts past the cap reject with a typed error pointing
 * operators at `lore pinned list --all-audiences` and
 * `lore-pinned action='unpin'` so the recovery path is obvious.
 * Unpinning is unaffected — operators trying to clear backlog
 * never hit the cap.
 *
 * Larger than `PINNED_BLOCKS_ABUSE_THRESHOLD` so the render
 * warning fires first as an early signal; smaller than
 * `LIVE_PAGE_REFILL_MAX_PAGES * LIVE_PAGE_QUERY_SIZE` so the
 * audience-filter backfill can always traverse the entire pinned
 * set within one refill window.
 */
export const PINNED_BLOCKS_HARD_CAP = 200
