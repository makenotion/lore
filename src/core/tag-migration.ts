/**
 * Classify and migrate out-of-vocabulary tags into `Keywords`.
 *
 * Before the closed `Tag` vocabulary landed, `Tags` was free-form and
 * accumulated a lot of point-in-time noise: PR numbers (`pr-1234`), Sentry
 * IDs (`SENTRY-APP-2DY`), class names (`ThreadListStore`), file paths
 * (`WidgetListStore.swift`). Those belong in `Keywords`.
 *
 * The migration is conservative: only tags matching an "obvious free-form"
 * pattern are reclassified automatically. Anything ambiguous stays in
 * `Tags` and is surfaced in the report for manual triage — better to leave
 * a few stragglers than to silently destroy signal.
 */

import type { Memory } from "../types.js"
import { TAG_VOCABULARY } from "../types.js"

const VOCAB_SET: ReadonlySet<string> = new Set<string>(TAG_VOCABULARY)

/**
 * Classify a tag against the closed vocabulary, matching case-insensitively.
 * Returns the canonical vocab term when the tag is a case variant
 * (`iOS`/`IOS` → `ios`), or `null` when it's out of vocabulary. Keeps
 * casing drift from being mistaken for free-form noise.
 */
export function canonicalVocabTag(tag: string): string | null {
  if (VOCAB_SET.has(tag)) return tag
  const lower = tag.toLowerCase()
  return VOCAB_SET.has(lower) ? lower : null
}

/**
 * Tests whether a tag is an obvious free-form label and should be moved to
 * `Keywords`. Covers the dominant noise patterns observed in an
 * internal vault census without over-reaching — a capitalized
 * human-curated tag like `UX-Design` or `API-Design` must *not* match:
 *
 * - PR numbers: `pr-1234`, `PR-12345`, `pr1234`
 * - Ticket / Sentry IDs: `SENTRY-APP-2DY`, `APP-1234`
 * - File names: anything ending in `.ext`
 * - PascalCase identifiers: `ThreadListStore`, `WidgetListStore`
 * - camelCase identifiers: `processBatchedItems`, `validateRedirectURI`
 * - Long hex / alphanumeric IDs
 *
 * The identifier tests require contiguous PascalCase or camelCase, not
 * just "any mixed-case": `UX-Design` and `API-Design` are hyphen-separated
 * and do not contain a PascalCase/camelCase run.
 */
export function isObviousFreeformTag(tag: string): boolean {
  if (/^pr-?\d+$/i.test(tag)) return true
  if (/^[A-Z][A-Z0-9]+(-[A-Z0-9]+)+$/.test(tag)) return true
  if (/\.[a-z0-9]{1,6}$/i.test(tag)) return true
  if (/^[A-Z][a-z]+([A-Z][a-z0-9]*)+[A-Z]*$/.test(tag)) return true
  if (/^[a-z]+([A-Z][a-z0-9]*)+[A-Z]*$/.test(tag)) return true
  if (/^[a-f0-9]{8,}$/i.test(tag)) return true
  return false
}

export interface TagClassification {
  /**
   * Tags that belong to the closed vocabulary, emitted in their canonical
   * (lowercase) form. A case variant like `iOS` → `ios` is normalized here
   * so the post-migration tag list is internally consistent.
   */
  vocab: string[]
  /** Non-vocab tags that look like free-form labels — move to Keywords. */
  freeform: string[]
  /** Non-vocab tags that don't match a known pattern — operator triage. */
  ambiguous: string[]
}

export function classifyTags(tags: readonly string[]): TagClassification {
  const vocab: string[] = []
  const freeform: string[] = []
  const ambiguous: string[] = []
  for (const t of tags) {
    const canonical = canonicalVocabTag(t)
    if (canonical !== null) vocab.push(canonical)
    else if (isObviousFreeformTag(t)) freeform.push(t)
    else ambiguous.push(t)
  }
  return { vocab, freeform, ambiguous }
}

export interface MemoryTagPlan {
  memoryId: string
  title: string
  before: {
    tags: readonly string[]
    keywords: string
  }
  after: {
    tags: string[]
    keywords: string
  }
  moved: string[]
  ambiguous: string[]
}

/**
 * Compute the post-migration `Tags` + `Keywords` for a single memory without
 * writing anything. Returns `null` when no change is needed — the caller
 * can skip the Notion update call entirely.
 *
 * Rewrites when either:
 * - obvious free-form tokens need to move into `Keywords`, or
 * - vocab case drift needs normalizing (e.g. `iOS` → `ios`) so future
 *   agent writes against the closed Zod vocabulary match what's in the DB.
 *
 * Existing `Keywords` tokens are preserved and deduped against the moved
 * set so re-running is a no-op on an already-migrated memory.
 */
export function planMemoryMigration(memory: Memory): MemoryTagPlan | null {
  const { vocab, freeform, ambiguous } = classifyTags(memory.tags)
  const nextTags = [...vocab, ...ambiguous]

  const tagsChanged =
    nextTags.length !== memory.tags.length ||
    nextTags.some((t, i) => t !== memory.tags[i])

  if (freeform.length === 0 && !tagsChanged) return null

  const existingKeywords = memory.keywords.trim()
  const existingTokens = new Set(existingKeywords.split(/\s+/).filter(Boolean))
  const newTokens = freeform.filter((t) => !existingTokens.has(t))
  const keywords = existingKeywords
    ? [existingKeywords, ...newTokens].join(" ")
    : newTokens.join(" ")

  return {
    memoryId: memory.id,
    title: memory.title,
    before: { tags: memory.tags, keywords: memory.keywords },
    after: { tags: nextTags, keywords },
    moved: freeform,
    ambiguous,
  }
}
