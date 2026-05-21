import type { MemoryKind } from "../../../types.js"
import type { CostOutputCounts } from "../../../core/cost-ledger.js"

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
  /** The `withWakeUpCacheBump` docstring carries the marker contract. */
  noopWrite?: boolean
  costOutputs?: CostOutputCounts
}

export const KINDS = [
  "note",
  "decision",
  "incident",
  "runbook",
  "postmortem",
  "policy",
  "state",
  "operational",
  "procedure",
] as const

/**
 * Full `MemoryKind` set accepted by `lore-memory action='suggest-topic-key'`.
 * Includes `task` (which `KINDS` deliberately excludes — task memories are
 * written via `lore-task action='create'`, not `lore-memory`) because the
 * suggester returns a no-suggestion verdict for task / note kinds rather
 * than rejecting them, and an agent that has just received `kind: "task"`
 * from upstream should be able to ask for a key without first having to
 * special-case the kind. The flat `inputSchema`'s `kind` field uses this
 * broader enum so the MCP-visible surface accepts any kind the tool can
 * reason about; per-arm validation in the discriminated union narrows
 * back to `KINDS` for save / update.
 *
 * `satisfies readonly MemoryKind[]` plus `_SuggestKindExhaustive` below
 * enforce the `Record<MemoryKind, string | null>` exhaustiveness contract
 * at this MCP boundary: adding a new `MemoryKind` without adding it
 * here is a compile error, not a silent runtime rejection from Zod.
 */
export const SUGGEST_KIND_VALUES = [
  "note",
  "decision",
  "incident",
  "runbook",
  "postmortem",
  "policy",
  "state",
  "operational",
  "task",
  "procedure",
] as const satisfies readonly MemoryKind[]

/**
 * Compile-time exhaustiveness assertion: `SUGGEST_KIND_VALUES` MUST
 * cover every `MemoryKind`. The function below requires its argument
 * type to extend `(typeof SUGGEST_KIND_VALUES)[number]`; calling it
 * with `null as unknown as MemoryKind` forces `tsc` to verify that
 * every `MemoryKind` is assignable to the union of literals — a
 * subset relationship the `as const satisfies readonly MemoryKind[]`
 * annotation above does NOT enforce on its own.
 *
 * Adding a new `MemoryKind` without updating `SUGGEST_KIND_VALUES`
 * fails the assignment in this call, breaking the build. The runtime
 * cost is one no-op function call that DCE strips at bundle time.
 */
function _assertSuggestKindCovers(_kind: (typeof SUGGEST_KIND_VALUES)[number]): void {
  // intentionally empty
}
_assertSuggestKindCovers(null as unknown as MemoryKind)

export const STATUSES = [
  "informational",
  "proposed",
  "accepted",
  "superseded",
  "deprecated",
  "rejected",
] as const

export const CONFIDENCES = ["certain", "likely", "speculative"] as const

export const SOURCES = [
  "conversation",
  "file",
  "manual",
  "agent_diary",
  "digest",
] as const

export const EXPAND_MAX_IDS = 20

/**
 * Topic-key format: kebab-case path like `decision/jwt-auth`.
 * Requires a `family/key` shape — at least one slash separator —
 * because the `suggest-topic-key` heuristic always emits
 * `${family}/${slug}` (per the `KIND_TO_FAMILY` table)
 * and the upsert grouping is meaningful only when the family prefix is
 * present. Single-segment tokens (e.g. `decision` alone) are rejected
 * at the Zod boundary so the contract between suggester and upsert
 * stays tight: any key the suggester would return is accepted, and
 * any key it wouldn't is a typo or contract violation.
 *
 * Format violations are validation errors, not silent acceptance —
 * a malformed `topicKey` is almost always a typo, not a deliberate
 * choice.
 */
export const TOPIC_KEY_REGEX = /^[a-z0-9]+\/[a-z0-9-]+(\/[a-z0-9-]+)*$/

export const COMPARE_VERDICTS = [
  "conflicts_with",
  "supersedes",
  "scoped",
  "related",
  "compatible",
  "not_conflict",
] as const

export type CompareVerdict = (typeof COMPARE_VERDICTS)[number]

export const ASYMMETRIC_VERDICTS: ReadonlySet<CompareVerdict> = new Set([
  "conflicts_with",
  "supersedes",
])
