/**
 * Shared Notion query filter builders.
 */

import {
  BROADCAST_SCOPE_KINDS,
  NARROW_SCOPE_KINDS,
  type MemoryScopeContext,
  type MemoryScopeKind,
} from "../types.js"
import { FACT_PROPS, MEMORY_PROPS } from "./schema.js"

/**
 * Build a project filter that includes both project-scoped and unscoped
 * (repo-wide) entries. This is the core of the scope inheritance model:
 * when querying within a project, you always also see repo-wide entries.
 *
 * `projectProperty` defaults to `MEMORY_PROPS.PROJECT` (the most common
 * caller). Callers querying a different database — Topics, Entities, or
 * Facts — must pass their own `*_PROPS.PROJECT` constant so the rename
 * invariant is locally enforceable per call site rather than relying on
 * the four `*_PROPS.PROJECT` constants staying equal forever. Today they
 * all resolve to `"Project"` and the schema-drift test
 * pins each one to its database's builder; the parameter exists so a
 * future rename touching only one DB cannot silently send the wrong key
 * into the other three's queries through this helper.
 */
export function projectOrUnscopedFilter(
  projectId: string,
  projectProperty: string = MEMORY_PROPS.PROJECT
): Record<string, unknown> {
  return {
    or: [
      { property: projectProperty, relation: { contains: projectId } },
      { property: projectProperty, relation: { is_empty: true } },
    ],
  }
}

/**
 * Property names for the scope/lifetime columns on either the Memories
 * or Facts DB. The columns mirror one-for-one across the two DBs but
 * the Notion property names are constants per DB; this struct lets the
 * filter helpers share one implementation that takes the relevant
 * DB's `*_PROPS` snapshot. Default is the Memories DB.
 */
export interface ScopeFilterProps {
  scopeKind: string
  scopeKey: string
  expiresAt: string
}

export interface DefaultScopeFilterOptions {
  includeExpired?: boolean
}

/**
 * Property snapshot for the Memories DB. Mirrors the
 * `MEMORY_PROPS.{SCOPE_KIND,SCOPE_KEY,EXPIRES_AT}` constants. Bundle
 * exported for callers that build a filter against the Memories DB.
 */
export const MEMORY_SCOPE_PROPS: ScopeFilterProps = {
  scopeKind: MEMORY_PROPS.SCOPE_KIND,
  scopeKey: MEMORY_PROPS.SCOPE_KEY,
  expiresAt: MEMORY_PROPS.EXPIRES_AT,
}

/** Mirror for the Facts DB. */
export const FACT_SCOPE_PROPS: ScopeFilterProps = {
  scopeKind: FACT_PROPS.SCOPE_KIND,
  scopeKey: FACT_PROPS.SCOPE_KEY,
  expiresAt: FACT_PROPS.EXPIRES_AT,
}

/**
 * Map a `MemoryScopeKind` (the agent-set narrow scope) to the resolved
 * `scopeKey` value the reader's scope context provides for that slot.
 * Returns `undefined` when the slot is not populated — the caller's
 * scope filter then drops the rows for that scope kind from default
 * retrieval, matching the "no identity, no recall" rule.
 */
function scopeKeyForKind(
  kind: MemoryScopeKind,
  ctx: MemoryScopeContext
): string | undefined {
  switch (kind) {
    case "user":
      return ctx.userId
    case "agent":
      return ctx.agent
    case "role":
      return ctx.role
    case "session":
      return ctx.session
    case "run":
      return ctx.run
    case "environment":
      return ctx.environment
    default:
      return undefined
  }
}

/**
 * Build the default-retrieval scope inclusion filter for the scope
 * contract — server-side, two-level-deep shape only.
 *
 * Notion's `dataSources.query` filter language caps compound
 * nesting at two levels (top-level `and` → `or` of property
 * filters). A naive "narrow scope match" would want to express
 * `(Scope Kind = "session" AND Scope Key = "sess-A")` as one
 * candidate inside the OR, which would be `and → or → and` (three
 * levels) and Notion rejects it with `validation_error`. Empirically
 * confirmed during the scope-rollout smoke test against a real
 * sandbox vault: the SDK reports
 * "body.filter.and[N].or[M].rich_text should be defined" for the
 * nested AND clause because Notion's parser treats it as a property
 * filter expecting one of the documented type keys.
 *
 * Restructure: emit only the broadcast-kinds branches server-side
 * plus the narrow-kinds-the-reader-cares-about (without binding to
 * key), and have callers apply `matchesDefaultScope` as a
 * client-side post-filter to enforce the kind+key binding. The
 * over-fetch is small (rows with reader-matching kind but
 * non-matching key flow through the server filter then drop on the
 * client side); the client post-filter is the same one
 * `applySemanticPostFilters` already runs on the semantic lane, so
 * the two lanes share the binding logic.
 *
 * Server-side filter shape (2 levels deep):
 *
 *   and:
 *     - or:
 *         - { property: "Scope Kind", select: { is_empty: true } }
 *         - { property: "Scope Kind", select: { equals: "team" } }
 *         - { property: "Scope Kind", select: { equals: "project" } }
 *         - { property: "Scope Kind", select: { equals: "global" } }
 *         - { property: "Scope Kind", select: { equals: "<narrow-kind-in-ctx>" } }   ← per ctx
 *         - ...
 *     - or:
 *         - { property: "Expires At", date: { is_empty: true } }
 *         - { property: "Expires At", date: { on_or_after: today } }
 *
 * Client post-filter (applied by callers AFTER the server query
 * returns): for each row whose `Scope Kind` is one of the narrow
 * kinds, drop the row unless `Scope Key` equals the reader's
 * context value for that kind. Rows whose Scope Kind is empty,
 * `team`, `project`, or `global` are kept unconditionally (the
 * server already filtered to those + the reader's narrow kinds).
 *
 * **Migration safety.** Rows written before the scope columns landed
 * have all five columns null, so `Scope Kind is_empty` matches them on
 * the server filter and `matchesDefaultScope`'s `kind === null → true`
 * branch keeps them client-side. Default retrieval is byte-identical
 * to unscoped reads.
 *
 * **Pure builder.** Returns a fresh literal on every call so caller
 * mutations (`and: [...]` array growth) cannot leak across in-flight
 * queries.
 */
export function defaultScopeInclusionFilter(
  ctx: MemoryScopeContext,
  today: string,
  props: ScopeFilterProps = MEMORY_SCOPE_PROPS,
  options: DefaultScopeFilterOptions = {}
): Record<string, unknown> {
  const scopeKindOr: Array<Record<string, unknown>> = [
    { property: props.scopeKind, select: { is_empty: true } },
  ]
  for (const broadcast of BROADCAST_SCOPE_KINDS) {
    scopeKindOr.push({
      property: props.scopeKind,
      select: { equals: broadcast },
    })
  }
  for (const narrow of NARROW_SCOPE_KINDS) {
    const key = scopeKeyForKind(narrow, ctx)
    if (key === undefined || key.length === 0) continue
    // Server-side: include the narrow kind (without binding to
    // key). Client-side `matchesDefaultScope` post-filter enforces
    // the kind+key binding to drop rows whose `Scope Key` does not
    // match the reader's matching context value.
    scopeKindOr.push({
      property: props.scopeKind,
      select: { equals: narrow },
    })
  }

  const clauses: Array<Record<string, unknown>> = [{ or: scopeKindOr }]
  if (options.includeExpired !== true) {
    clauses.push({
      or: [
        { property: props.expiresAt, date: { is_empty: true } },
        { property: props.expiresAt, date: { on_or_after: today } },
      ],
    })
  }

  return { and: clauses }
}

/**
 * Compose `defaultScopeInclusionFilter` onto an existing filter shape.
 * Mirrors `withCleanupOrphanExclusion` — three
 * input shapes:
 *
 * - `undefined` → returns the bare scope filter.
 * - A pre-built `{ and: [...] }` → appends each top-level clause from
 *   the scope filter to the array.
 * - A bare property filter → wraps both into a fresh `{ and: [...] }`.
 *
 * The scope filter is itself a top-level `and: [scopeKindOr, expiry]`,
 * so unrolling its top-level clauses keeps the caller's outer `and`
 * shape flat. Flatness is also a correctness requirement, not just
 * a style preference: Notion's compound-filter language caps
 * compound nesting at TWO levels (`and: [or: [property-filters]]`
 * is the deepest valid shape). Unrolling top-level scope clauses
 * into the caller's outer `and:` keeps every emitted filter at 2
 * levels deep — `defaultScopeInclusionFilter`'s docstring carries
 * the smoke-test incident where a 3-deep `and→or→and` filter was
 * rejected.
 *
 * Returns the input unchanged when `ctx` produces no narrowing — i.e.
 * when the caller wants out-of-scope rows. The caller never needs to
 * decide whether to call this helper; calling it is always safe.
 */
export function withDefaultScopeFilter(
  filter: Record<string, unknown> | undefined,
  ctx: MemoryScopeContext,
  today: string,
  props: ScopeFilterProps = MEMORY_SCOPE_PROPS,
  options: DefaultScopeFilterOptions = {}
): Record<string, unknown> | undefined {
  const scopeFilter = defaultScopeInclusionFilter(ctx, today, props, options)
  const scopeClauses = (scopeFilter["and"] as Array<Record<string, unknown>>) ?? []
  if (filter === undefined) {
    return scopeFilter
  }
  if (Array.isArray((filter as { and?: unknown[] }).and)) {
    return {
      ...filter,
      and: [...((filter as { and: unknown[] }).and as unknown[]), ...scopeClauses],
    }
  }
  return { and: [filter, ...scopeClauses] }
}

/**
 * Filter clause selecting rows whose `Expires At` falls in the
 * inclusive window `[today, until]`. Used by the `lore status`
 * expiring-rows surface (the contract: "`lore status` or audit
 * surfaces expired/expiring scoped memories for cleanup").
 */
export function expiringWithinFilter(
  today: string,
  until: string,
  props: ScopeFilterProps = MEMORY_SCOPE_PROPS
): Record<string, unknown> {
  return {
    and: [
      { property: props.expiresAt, date: { on_or_after: today } },
      { property: props.expiresAt, date: { on_or_before: until } },
    ],
  }
}

/**
 * Filter clause selecting rows whose `Expires At` is strictly before
 * `today` — the row is expired but still present (Lore never deletes,
 * just stops surfacing). Used by `lore status` to surface expired
 * rows for cleanup.
 */
export function expiredBeforeFilter(
  today: string,
  props: ScopeFilterProps = MEMORY_SCOPE_PROPS
): Record<string, unknown> {
  return { property: props.expiresAt, date: { before: today } }
}
