/**
 * Shared Zod schema for the `scope` parameter on every tool that
 * writes a Memory or Fact.
 *
 * The schema matches `MemoryScopeInput` exactly:
 *
 * - `kind` — one of the nine `MemoryScopeKind` values, or `null` to
 *   clear the column.
 * - `key` — free-form rich_text (session id, agent canonical name,
 *   role label). Empty string clears the column.
 * - `audience` — free-form rich_text. Empty string clears.
 * - `lifetime` — one of the five `MemoryLifetime` values, or `null`
 *   to clear.
 * - `expiresAt` — `YYYY-MM-DD` date, or `null` to clear.
 *
 * Every field is optional so a caller can write a partial scope
 * declaration (e.g. just `lifetime: "expires"` + `expiresAt: ...`
 * without touching `kind`/`key`). Omitted fields leave the
 * corresponding Notion column untouched on update calls.
 */

import { z } from "zod"
import {
  MEMORY_LIFETIMES,
  MEMORY_SCOPE_KINDS,
  type MemoryLifetime,
  type MemoryScopeKind,
} from "../../types.js"
import { ymdDateSchema } from "./date-schema.js"
import { RICH_TEXT_PROPERTY_MAX_LEN } from "../../core/rich-text-schema.js"

// `as const` to satisfy `z.enum(...)`'s tuple constraint.
const SCOPE_KINDS_TUPLE = MEMORY_SCOPE_KINDS as readonly MemoryScopeKind[] as readonly [
  MemoryScopeKind,
  ...MemoryScopeKind[],
]

const LIFETIMES_TUPLE = MEMORY_LIFETIMES as readonly MemoryLifetime[] as readonly [
  MemoryLifetime,
  ...MemoryLifetime[],
]

/**
 * Zod schema for the `scope` MCP parameter. Every field is optional
 * with documented clear semantics so a partial scope update lands
 * cleanly on the matching subset of Notion columns.
 */
export const scopeInputSchema = z
  .object({
    kind: z.enum(SCOPE_KINDS_TUPLE).nullable().optional(),
    key: z.string().max(RICH_TEXT_PROPERTY_MAX_LEN).optional(),
    audience: z.string().max(RICH_TEXT_PROPERTY_MAX_LEN).optional(),
    lifetime: z.enum(LIFETIMES_TUPLE).nullable().optional(),
    expiresAt: ymdDateSchema.nullable().optional(),
  })
  .strict()
  .optional()
  .describe(
    "Scope/lifetime (#283). kind: team|project|user|agent|role|session|run|environment|global. " +
      "Narrow scopes need a key matching the reader's context. " +
      "lifetime: persistent|expires|session-only|until-task-closed|until-decision-superseded."
  )

/**
 * Inferred TypeScript shape from `scopeInputSchema`. Matches
 * `MemoryScopeInput` modulo the optional outer wrapper.
 */
export type ScopeInput = z.infer<typeof scopeInputSchema>
