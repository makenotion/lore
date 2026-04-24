/**
 * Shared rendering helpers for MCP tool output.
 *
 * Facts, decisions, and memories cross-reference each other by Notion
 * page ID. Rendering those IDs raw is opaque to a reader — this module
 * batches referenced IDs, resolves them to titles via a caller-supplied
 * loader, and produces a per-fact renderer that substitutes titles when
 * it has them and falls back to a short hinted suffix when it doesn't.
 *
 * Every lookup path should use `MemoryService.getTitleById` (or an
 * equivalent index-tier loader) — never `getById`, which pulls the full
 * markdown body. A wake-up rendering 25 Active Facts must not fan out
 * to 25+ body fetches just to read a Title property.
 */

import type { Fact } from "../types.js"

/**
 * Notion page IDs are canonical 8-4-4-4-12 hex UUIDs. The SDK emits
 * lowercase, but we match case-insensitively so a stray uppercase value
 * from a migrated row still resolves. All keys are normalized to
 * lowercase before going into the title map.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value)
}

/**
 * Minimal service surface the facts-side resolver needs. A title-only
 * loader — no markdown body — so a render pass costs exactly one Notion
 * round-trip per unique referenced ID.
 */
export interface TitleResolvers {
  memories: { getTitleById(id: string): Promise<string | null> }
}

/**
 * Batch-resolve titles for the given IDs using the provided loader.
 * Dedupes and normalizes to lowercase before issuing the fan-out so a
 * mixed-case set of references still collapses to one request per
 * distinct page. Unresolved IDs (loader returned `null`) are dropped —
 * callers should render them via `displayId` to get the `(?)` fallback.
 *
 * This is the shared primitive. Callers with a `Fact[]` should use
 * `resolveReferencedTitles`; callers with a bare `string[]` (e.g., the
 * `Supersedes` / `Affects` ID lists on a Decision) should use this
 * directly with a kind-specific loader.
 */
export async function resolveTitles(
  ids: readonly string[],
  loader: (id: string) => Promise<string | null>,
): Promise<Map<string, string>> {
  const unique = new Set<string>()
  for (const id of ids) {
    if (!id) continue
    unique.add(id.toLowerCase())
  }
  if (unique.size === 0) return new Map()

  const entries = await Promise.all(
    Array.from(unique).map(async (id) => {
      const title = await loader(id)
      return title ? ([id, title] as const) : null
    }),
  )

  return new Map(
    entries.filter((entry): entry is readonly [string, string] => entry !== null),
  )
}

/**
 * Convenience for the common case: scan a `Fact[]` for UUID-shaped
 * subject/object values and resolve them via `services.memories.getTitleById`.
 * Every MCP read tool that renders facts should pass its fact list
 * through this before calling `renderFact`.
 */
export async function resolveReferencedTitles(
  facts: readonly Fact[],
  services: TitleResolvers,
): Promise<Map<string, string>> {
  const ids: string[] = []
  for (const fact of facts) {
    if (isUuid(fact.subject)) ids.push(fact.subject)
    if (isUuid(fact.object)) ids.push(fact.object)
  }
  return resolveTitles(ids, (id) => services.memories.getTitleById(id))
}

/**
 * Format a single fact line with title substitution. UUIDs that resolve
 * render as their title; UUIDs that don't render as a short hint
 * (`…last8 (?)`) so the reader still has a traceable anchor without
 * 36 characters of random hex cluttering the output. Non-UUID values
 * render verbatim.
 *
 * `trailing` is appended space-prefixed after the core triple so callers
 * can attach confidence, validity window, review hints, or a multi-line
 * ID footer without re-implementing the subject/object substitution.
 */
export interface RenderFactOptions {
  titleMap: Map<string, string>
  /** Appended after the core "Subject predicate Object" segment, space-prefixed. */
  trailing?: string
}

export function renderFact(fact: Fact, options: RenderFactOptions): string {
  const subject = displayValue(fact.subject, options.titleMap)
  const object = displayValue(fact.object, options.titleMap)
  const predicate = fact.predicate.replace(/_/g, " ")
  const suffix = options.trailing ? ` ${options.trailing}` : ""
  return `- **${subject}** ${predicate} **${object}**${suffix}`
}

/**
 * Format a single ID as its resolved title (when known) or a short
 * unresolved-hint that preserves enough of the UUID to trace back
 * without dumping the whole string inline. Exposed so callers rendering
 * non-fact structures (e.g., `lore-get-decision`'s Supersedes section)
 * share the same lookup discipline as `renderFact`.
 */
export function displayId(
  id: string,
  titleMap: Map<string, string>,
): string {
  const title = titleMap.get(id.toLowerCase())
  return title ?? unresolvedHint(id)
}

/**
 * UUID-aware value rendering: looks up a UUID through the title map
 * (with unresolved-hint fallback) and returns plain strings verbatim.
 * Shared by `renderFact` and call sites that need per-side substitution
 * inside a non-standard line format (e.g., wake-up's Open Loops arrows).
 */
export function displayValue(
  value: string,
  titleMap: Map<string, string>,
): string {
  if (!isUuid(value)) return value
  return displayId(value, titleMap)
}

/**
 * Trim a UUID down to its last 8 hex chars for the unresolved fallback.
 * 36 characters of random hex in a bulleted list is visual noise — the
 * tail is enough to disambiguate nearby rows, and a caller who needs
 * the full ID can still look it up on the facts/decisions row itself.
 */
function unresolvedHint(id: string): string {
  const normalized = id.toLowerCase()
  if (!isUuid(normalized)) return `${id} (?)`
  return `…${normalized.slice(-8)} (?)`
}
