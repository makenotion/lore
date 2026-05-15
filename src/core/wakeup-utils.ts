import type { Memory, TaskSummary } from "../types.js"
import { MS_PER_DAY } from "../types.js"
import {
  MAX_ENTITY_CANDIDATES,
  MAX_USER_QUERY_LENGTH,
  MIN_ENTITY_LENGTH,
} from "./wakeup-constants.js"

/**
 * Normalize a caller-supplied user query: trim, drop empty/whitespace-only
 * inputs, truncate to 1000 chars. Returning `undefined` means "no query"
 * — the caller shouldn't fire the extra search and `taskMemories` stays
 * empty.
 *
 * Truncation is naive at the codepoint level (`slice(0, MAX_USER_QUERY_LENGTH)`),
 * not word- or sentence-aware. Notion's relevance ranking is robust to
 * mid-word cuts, and a smarter trim would risk dropping a critical late-
 * clause keyword (`"... causing the OOM in classifier.ts:213"`) for
 * cosmetic reasons. We do strip a trailing UTF-16 high surrogate post-
 * slice: a user paste with non-BMP characters (emoji, certain CJK)
 * landing on the 1000-char boundary would otherwise produce a lone
 * surrogate, which is invalid UTF-16 and a malformed prefix of the
 * user's actual input.
 */
export function sanitizeUserQuery(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.length <= MAX_USER_QUERY_LENGTH) return trimmed
  return trimmed.slice(0, MAX_USER_QUERY_LENGTH).replace(/[\uD800-\uDBFF]$/, "")
}

/**
 * Pull deduped entity-name candidates from a set of active tasks. The
 * task `entity` field carries the normalized subject (PR number, file,
 * service); `title` is the human-friendly version. Prefer `entity`
 * when populated — it's the structurally-indexed handle that
 * `lore-task action='list'` filters against — and fall back to `title`
 * for tasks created before the `entity` column was filled.
 * Case-insensitive dedupe; short fragments dropped as too noisy.
 */
export function extractTaskEntities(tasks: TaskSummary[]): string[] {
  const seen = new Set<string>()
  const entities: string[] = []
  for (const task of tasks) {
    const raw = (task.entity || task.title).trim()
    if (raw.length < MIN_ENTITY_LENGTH) continue
    const key = raw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    entities.push(raw)
    if (entities.length >= MAX_ENTITY_CANDIDATES) return entities
  }
  return entities
}

export function isFreshDigest(
  digest: Memory | null,
  maxAgeDays: number,
  now: number
): boolean {
  if (!digest) return false
  const ageMs = now - new Date(digest.createdAt).getTime()
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < maxAgeDays * MS_PER_DAY
}

export function digestAgeDays(digest: Memory | null, now: number): number | null {
  if (!digest) return null
  const ageMs = now - new Date(digest.createdAt).getTime()
  if (!Number.isFinite(ageMs) || ageMs < 0) return null
  return Math.floor(ageMs / MS_PER_DAY)
}

/**
 * Classify an ISO timestamp relative to `now` into a human-readable bucket
 * for wake-up rendering. Shared by the MCP tool and the shell hook so both
 * surfaces group memories identically.
 */
export function dateBucket(
  isoDate: string,
  now: number = Date.now()
): "Today" | "Yesterday" | "Earlier" {
  const d = isoDate.split("T")[0]
  const today = new Date(now).toISOString().split("T")[0]
  const yesterday = new Date(now - MS_PER_DAY).toISOString().split("T")[0]
  if (d === today) return "Today"
  if (d === yesterday) return "Yesterday"
  return "Earlier"
}
