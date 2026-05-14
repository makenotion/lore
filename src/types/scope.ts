/**
 * Scope and lifetime types shared by memory, fact, and task rows.
 */

// ---------------------------------------------------------------------------
// Scope and lifetime
// ---------------------------------------------------------------------------

/**
 * Scope kind for a memory, fact, or task. Identity slot the row applies to.
 *
 * - `team`, `project`, `global` are *broadcast* scopes — every reader on
 * any session sees them by default.
 * - `user`, `agent`, `role`, `session`, `run`, `environment` are *narrow*
 * scopes — readers see them only when their resolved scope context's
 * matching slot equals the row's `scopeKey`. A session note from
 * one engineer's debugging run does not become team-wide recall by
 * accident.
 *
 * Existing rows have no `scopeKind` (column null). The retrieval default
 * treats null as "broadcast" — equivalent to `team`/`project`/`global` —
 * so vaults without the Scope columns render byte-identically.
 */
export type MemoryScopeKind =
  | "team"
  | "project"
  | "user"
  | "agent"
  | "role"
  | "session"
  | "run"
  | "environment"
  | "global"

export const MEMORY_SCOPE_KINDS: MemoryScopeKind[] = [
  "team",
  "project",
  "user",
  "agent",
  "role",
  "session",
  "run",
  "environment",
  "global",
]

/**
 * Scopes whose reach is broader than the current reader's context.
 * Always returned by default reads, regardless of `scopeKey`. Anything
 * else requires a `scopeKey` match against the reader's `MemoryScopeContext`.
 */
export const BROADCAST_SCOPE_KINDS: MemoryScopeKind[] = ["team", "project", "global"]

/**
 * Narrow scopes — require a matching `scopeKey` against the reader's
 * resolved scope context to surface in default reads.
 */
export const NARROW_SCOPE_KINDS: MemoryScopeKind[] = [
  "user",
  "agent",
  "role",
  "session",
  "run",
  "environment",
]

/**
 * Lifetime model for a memory, fact, or task.
 *
 * - `persistent` — never expires. The legacy default; null lifetime
 * resolves to this on read.
 * - `expires` — explicit `Expires At` end-date. The row drops out of
 * default retrieval when `Expires At < today`.
 * - `session-only` — paired with `scopeKind = session` and a
 * `Session` field; expires when the originating session is no
 * longer current. Same retrieval behavior as `expires` for the
 * common case (we drop the row when its scopeKey doesn't match the
 * reader's session), but the explicit label gives operators a
 * triage signal in `lore status` for "session-only memories that
 * outlived their session and need cleanup."
 * - `until-task-closed` — for `kind = task` memories; the row's
 * active reach ends when its `taskState` reaches `done` or
 * `cancelled`. Tasks already drop out of `lore-task action='list'`
 * default state filters when closed, so this label is a
 * declaration of intent rather than a new retrieval rule.
 * - `until-decision-superseded` — for `kind = decision` memories;
 * active reach ends when `status` reaches `superseded`. Same
 * declarative posture as `until-task-closed` — superseded
 * decisions already drop out of "currently governing" reads via
 * `ACTIVE_DECISION_STATUSES`.
 */
export type MemoryLifetime =
  | "persistent"
  | "expires"
  | "session-only"
  | "until-task-closed"
  | "until-decision-superseded"

export const MEMORY_LIFETIMES: MemoryLifetime[] = [
  "persistent",
  "expires",
  "session-only",
  "until-task-closed",
  "until-decision-superseded",
]

/**
 * Resolved scope context for the current reader. Populated at
 * `initServices()` time from environment variables, the active project,
 * and the auth identity. Threaded into `MemoryService` and `FactService`
 * so default-retrieval paths can build the safe scope inclusion filter
 * without each call site re-deriving identity.
 *
 * Every field is optional. A missing identity slot means "no row whose
 * `scopeKind` equals this slot can be surfaced by default" — so a
 * vault running without `LORE_AGENT_NAME` set never has agent-scoped
 * recall, only ever broadcast scopes plus the slots that are
 * populated.
 *
 * `userId`, `agent`, `role`, `session`, `run`, `environment` are the
 * raw identity strings the row's `scopeKey` is compared against. The
 * caller is responsible for keeping the same canonical form here as
 * was written into Notion (e.g. `canonicalizeAgentName` for
 * `agent`).
 */
export interface MemoryScopeContext {
  userId?: string
  agent?: string
  role?: string
  session?: string
  run?: string
  environment?: string
}

/**
 * Bundle of scope-related fields surfaced on `Memory` and `Fact` rows.
 * Mirrors the five Notion Scope columns: `Scope Kind`, `Scope Key`,
 * `Audience`, `Lifetime`, `Expires At`. Bundled into a single optional
 * `scope` slot rather than five top-level fields so a `null` from a
 * row without Scope columns collapses to "no scope declared" in one
 * place.
 *
 * `null` on the parent type means the row was written without scope —
 * retrieval treats this as broadcast scope with `persistent` lifetime,
 * matching the legacy behavior.
 */
export interface MemoryScope {
  kind: MemoryScopeKind | null
  key: string
  audience: string
  lifetime: MemoryLifetime | null
  expiresAt: string | null
}

/**
 * Write-side shape for the scope bundle. Mirrors `MemoryScope` but with
 * every field optional and clear-aware semantics where they make sense
 * for a Notion column update.
 *
 * - `kind` — pass a `MemoryScopeKind` to write; `null` clears the
 * column. Omitted leaves untouched.
 * - `key` — string write; empty string clears.
 * - `audience` — string write; empty string clears.
 * - `lifetime` — `MemoryLifetime` to write; `null` clears.
 * - `expiresAt` — `YYYY-MM-DD` to write; `null` clears.
 *
 * The Zod boundary in MCP enforces the format and the Notion `Expires
 * At` column (a Notion `date` type) accepts the date directly.
 */
export interface MemoryScopeInput {
  kind?: MemoryScopeKind | null
  key?: string
  audience?: string
  lifetime?: MemoryLifetime | null
  expiresAt?: string | null
}

/**
 * Translate a read-side `MemoryScope` (or `null`) into the write-side
 * `MemoryScopeInput` shape that `lore-fact action='create'` and
 * `services.facts.createWithDedup` consume.
 *
 * Used by every system-managed fact emitter — auto-`mentions` on
 * `lore-memory action='save'` / `'update'`, `decided_by` on
 * `lore-decision action='create'`, `supersedes_decision` on
 * `lore-decision action='supersede'`, and `decided_by` retargets
 * during decision-graph reachability sync — to propagate the source
 * row's scope onto every emitted fact.
 *
 * Without this propagation, an auto-emitted fact written from a
 * session-scoped memory or decision lands with `Scope Kind = null`
 * (broadcast). The default scope filter intentionally treats null
 * as legacy/broadcast and surfaces the row to every reader, which
 * would let `lore-query action='ask'` and `lore-decision
 * action='context'` leak the scoped row's title and entity edges
 * across sessions even when the memory/decision itself is hidden
 * from recall.
 *
 * Returns `undefined` when the source row has no scope declared (scope
 * is absent or null) so the fact create call sites can pass the result
 * through unchanged via spread / direct assignment without
 * re-implementing the same null-collapse rule each time.
 */
export function memoryScopeToInput(
  scope: MemoryScope | null | undefined
): MemoryScopeInput | undefined {
  if (!scope) return undefined
  // The `key` / `audience` rich_text columns store the empty string
  // on cleared rows; collapse them to undefined so the resulting
  // input shape doesn't write empty cells on the new fact.
  const out: MemoryScopeInput = {}
  if (scope.kind !== null) out.kind = scope.kind
  if (scope.key.length > 0) out.key = scope.key
  if (scope.audience.length > 0) out.audience = scope.audience
  if (scope.lifetime !== null) out.lifetime = scope.lifetime
  if (scope.expiresAt !== null) out.expiresAt = scope.expiresAt
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Decide whether a system-managed fact derived from a PAIR of
 * memories (compare-dispatch `conflicts_with` / `supersedes_decision`)
 * can be safely emitted, and if so what scope it should carry.
 *
 * The rule is "same scope on both sides → emit with that scope; any
 * mismatch → skip emission." Reasoning:
 *
 * - Same scope on both sides: emitting with that scope is safe.
 * Both rows already share visibility, so the derived fact's
 * visibility is identical to either row's visibility.
 * - One narrower than the other (one session-scoped, one team /
 * global / null): emitting with the narrower scope hides the
 * relationship from the broader-scope reader who can see the
 * broader row. Emitting with the broader scope leaks the
 * narrower row's title and the relationship through `lore-query
 * action='ask'` to readers who cannot see the narrower row.
 * Both directions are wrong; the safe answer is to skip the
 * derived-fact emission. The compare verdict still lands in the
 * Compare Notes audit trail on both rows, so the contradiction
 * isn't lost — just the broadcast-able fact-graph projection of
 * it.
 *
 * Returns:
 * - `{ ok: true, scope: MemoryScopeInput | undefined }` when the
 * two rows share a scope. `scope` is the bundle to pass to
 * `createWithDedup`; `undefined` means both rows have no scope
 * declared (legacy passthrough — the fact lands with no scope).
 * - `{ ok: false, reason: string }` when the rows have different
 * scopes. The caller skips fact emission and includes `reason`
 * in operator-facing output / debug logs so the gap is
 * diagnosable.
 *
 * This helper is intentionally narrower than `scopesMatchForMerge`:
 * the merge predicate compares an existing Fact's scope against an
 * incoming `MemoryScopeInput`, while this pair predicate compares two
 * `Memory.scope` values directly. The two implementations stay aligned
 * via shared scope-coverage tests.
 */
export function pairScopeForFactEmission(
  a: MemoryScope | null | undefined,
  b: MemoryScope | null | undefined
): { ok: true; scope: MemoryScopeInput | undefined } | { ok: false; reason: string } {
  const normA = normalizeForCompare(a)
  const normB = normalizeForCompare(b)
  if (
    normA.kind === normB.kind &&
    normA.key === normB.key &&
    normA.audience === normB.audience &&
    normA.lifetime === normB.lifetime &&
    normA.expiresAt === normB.expiresAt
  ) {
    // Both rows share the scope; safe to emit. `memoryScopeToInput`
    // returns undefined when the (now-equal) scope is empty,
    // preserving the legacy null-scope passthrough.
    return { ok: true, scope: memoryScopeToInput(a ?? b ?? null) }
  }
  return {
    ok: false,
    reason:
      `pair-scope mismatch: source=${describeScope(a)} ` +
      `affected=${describeScope(b)} — system fact emission skipped to ` +
      "avoid leaking the narrower-scope row's title across the broader " +
      "reader context. The compare verdict still landed in Compare Notes " +
      "on both rows (audit trail intact).",
  }
}

interface NormalizedScopeForCompare {
  kind: MemoryScopeKind | null
  key: string | null
  audience: string | null
  lifetime: MemoryLifetime | null
  expiresAt: string | null
}

function normalizeForCompare(
  scope: MemoryScope | null | undefined
): NormalizedScopeForCompare {
  if (!scope) {
    return { kind: null, key: null, audience: null, lifetime: null, expiresAt: null }
  }
  return {
    kind: scope.kind,
    key: scope.key.length > 0 ? scope.key : null,
    audience: scope.audience.length > 0 ? scope.audience : null,
    lifetime: scope.lifetime,
    expiresAt: scope.expiresAt,
  }
}

function describeScope(scope: MemoryScope | null | undefined): string {
  if (!scope || (scope.kind === null && scope.key.length === 0)) {
    return "broadcast"
  }
  if (scope.kind === null) return "scoped(unknown-kind)"
  if (scope.key.length === 0) return scope.kind
  return `${scope.kind}:${scope.key}`
}

/**
 * Days-from-today threshold for the `lore status` "expiring scoped
 * rows" surface. A row with `Expires At` between today and today + N
 * days surfaces as "expiring soon"; rows with `Expires At < today`
 * surface as "expired."
 */
export const EXPIRING_SOON_DAYS = 7
