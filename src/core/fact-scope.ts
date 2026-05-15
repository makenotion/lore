import type {
  MemoryLifetime,
  MemoryScope,
  MemoryScopeInput,
  MemoryScopeKind,
} from "../types.js"
import { FACT_PROPS } from "../notion/schema.js"
import { extractDate, extractRichText } from "../notion/extractors.js"
import type { PageObjectResponse } from "@notionhq/client"

/**
 * Read the five scope columns on a Facts DB row into a `MemoryScope`
 * bundle. Matches `extractMemoryScope` — same
 * "all-empty → null" rule so rows without scope columns deserialize
 * as null.
 */
export function extractFactScope(
  props: PageObjectResponse["properties"]
): MemoryScope | null {
  const kindProp = props[FACT_PROPS.SCOPE_KIND]
  const kind =
    kindProp && kindProp.type === "select" && kindProp.select
      ? (kindProp.select.name as MemoryScopeKind)
      : null
  const key = extractRichText(props[FACT_PROPS.SCOPE_KEY])
  const audience = extractRichText(props[FACT_PROPS.AUDIENCE])
  const lifetimeProp = props[FACT_PROPS.LIFETIME]
  const lifetime =
    lifetimeProp && lifetimeProp.type === "select" && lifetimeProp.select
      ? (lifetimeProp.select.name as MemoryLifetime)
      : null
  const expiresAt = extractDate(props[FACT_PROPS.EXPIRES_AT])
  if (
    kind === null &&
    lifetime === null &&
    expiresAt === null &&
    key.length === 0 &&
    audience.length === 0
  ) {
    return null
  }
  return { kind, key, audience, lifetime, expiresAt }
}

/**
 * Decide whether `createWithDedup`'s probe hit on an existing row
 * should merge into that row, or fall through to a blind create.
 *
 * Returns `true` only when the existing row's scope deep-equals the
 * incoming write's scope. The match is exact:
 *
 * - Both null (or absent): match — un-migrated rows or untouched-scope
 *   writes coalesce as broadcast.
 * - One null, one populated: NO match — adding scope to a broadcast row,
 *   or vice versa, must not silently merge. The
 *   narrow-scope write needs its own row; the broadcast write also
 *   needs its own row so default team reads can see it.
 * - Both populated: must match on every component (`kind`, `key`,
 *   `audience`, `lifetime`, `expiresAt`).
 *
 * The `key`, `audience` rich_text comparison normalizes empty string
 * and whitespace-only on both sides to "not declared" so an explicit
 * `key: ""` clear from one side doesn't structurally split from a
 * legacy null on the other side. Select / date columns compare with
 * strict equality.
 *
 * The function is intentionally narrow: a future contributor adding
 * a sixth scope column to the type bundle gets a typecheck error
 * here when they forget to compare it, because the incoming side is
 * destructured and the destructure-rest pattern is `{ ...rest } =
 * input` — any leftover key blocks the same-shape assertion. (The
 * destructure-rest pattern is itself the test fixture's
 * regression detector.)
 */
export function scopesMatchForMerge(
  existing: MemoryScope | null,
  incoming: MemoryScopeInput | undefined
): boolean {
  const incomingDeclared =
    incoming !== undefined &&
    (incoming.kind !== undefined ||
      incoming.lifetime !== undefined ||
      incoming.expiresAt !== undefined ||
      isMeaningful(incoming.key) ||
      isMeaningful(incoming.audience))
  if (existing === null && !incomingDeclared) return true
  if (existing === null || !incomingDeclared) return false

  const existingKey = existing.key.trim().length > 0 ? existing.key : null
  const incomingKey =
    incoming.key !== undefined && incoming.key.trim().length > 0 ? incoming.key : null
  const existingAudience = existing.audience.trim().length > 0 ? existing.audience : null
  const incomingAudience =
    incoming.audience !== undefined && incoming.audience.trim().length > 0
      ? incoming.audience
      : null

  return (
    existing.kind === (incoming.kind ?? null) &&
    existingKey === incomingKey &&
    existingAudience === incomingAudience &&
    existing.lifetime === (incoming.lifetime ?? null) &&
    existing.expiresAt === (incoming.expiresAt ?? null)
  )
}

function isMeaningful(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0
}

export type FactScopeBuilderProps = {
  scopeKind?: string | null
  scopeKey?: string
  audience?: string
  lifetime?: string | null
  expiresAt?: string | null
}

/**
 * Translate the agent-facing `MemoryScopeInput` shape into the flat
 * primitive arguments `buildFactProps` consumes. Matches
 * `scopeInputToBuilderProps` — that helper's
 * docstring carries the rationale on keeping the bundle-to-primitive
 * translation outside the builder.
 */
export function factScopeInputToBuilderProps(
  scope: MemoryScopeInput | undefined
): FactScopeBuilderProps {
  if (scope === undefined) return {}
  const out: FactScopeBuilderProps = {}
  if (scope.kind !== undefined) out.scopeKind = scope.kind
  if (scope.key !== undefined) out.scopeKey = scope.key
  if (scope.audience !== undefined) out.audience = scope.audience
  if (scope.lifetime !== undefined) out.lifetime = scope.lifetime
  if (scope.expiresAt !== undefined) out.expiresAt = scope.expiresAt
  return out
}
