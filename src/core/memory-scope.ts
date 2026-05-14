import type { PageObjectResponse } from "@notionhq/client"
import type { MemoryScopeContext } from "../types.js"
import { MEMORY_PROPS } from "../notion/schema.js"
import { extractDate, extractRichText } from "../notion/extractors.js"

/**
 * Client-side mirror of the server-side default scope inclusion
 * filter. Used by read paths that need row-by-row filtering because
 * the backend query surface cannot express the full kind/key binding.
 *
 * Returns `true` when the row passes the default scope filter:
 * - Scope Kind empty / `team` / `project` / `global` (broadcast); OR
 * - Scope Kind is one of the narrow kinds AND Scope Key equals the
 * reader's resolved context value for that kind.
 *
 * AND not expired:
 * - Expires At empty OR Expires At >= today.
 */
export function matchesDefaultScope(
  props: PageObjectResponse["properties"],
  ctx: MemoryScopeContext,
  today: string,
  scopeProps: import("../notion/filters.js").ScopeFilterProps = {
    scopeKind: MEMORY_PROPS.SCOPE_KIND,
    scopeKey: MEMORY_PROPS.SCOPE_KEY,
    expiresAt: MEMORY_PROPS.EXPIRES_AT,
  }
): boolean {
  const expiresAt = extractDate(props[scopeProps.expiresAt])
  if (expiresAt !== null && expiresAt < today) return false

  const kindProp = props[scopeProps.scopeKind]
  const kind =
    kindProp && kindProp.type === "select" && kindProp.select
      ? kindProp.select.name
      : null
  if (kind === null) return true
  if (kind === "team" || kind === "project" || kind === "global") return true

  const key = extractRichText(props[scopeProps.scopeKey])
  if (key.length === 0) return false

  switch (kind) {
    case "user":
      return ctx.userId === key
    case "agent":
      return ctx.agent === key
    case "role":
      return ctx.role === key
    case "session":
      return ctx.session === key
    case "run":
      return ctx.run === key
    case "environment":
      return ctx.environment === key
    default:
      return false
  }
}
