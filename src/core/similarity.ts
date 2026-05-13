/**
 * Text-and-tag similarity helpers for the near-duplicate probe.
 *
 * Pure functions, no Notion knowledge. Used by the write paths in
 * `lore-memory action='save'` and `lore-decision action='create'` to
 * surface candidate duplicates alongside freshly-saved rows — the
 * probe is advisory, not blocking.
 *
 * The design premise: cheap trigram Jaccard on the normalized title is
 * enough signal to flag duplicates that differ only in wording
 * (`"Wakeup hook crash diagnosis"` vs `"Wakeup hook crash + migration plan"`)
 * without paying for embeddings. Richer similarity lives downstream
 * (richer similarity is deferred future work).
 *
 * Keeping this side-effect-free means tests run synchronously and the
 * helpers can be reused by future consumers (entity canonicalization,
 * DS-scoped search) without dragging Notion state. The one import
 * (`decodeTextEntities`) is itself pure and carries no Notion knowledge.
 */

import { decodeTextEntities } from "../notion/html-entities.js"

/**
 * Trigram length used throughout this module. Three characters is the
 * classic choice for title-length strings: long enough to carry structure
 * but short enough that a handful of shared words already produce
 * double-digit overlap. Exported as a constant only for test legibility;
 * it is not a tunable.
 */
const TRIGRAM_SIZE = 3

/**
 * Sentinel wrapper that pads the input so short titles still produce
 * trigrams and so boundary trigrams carry positional information. Two
 * spaces gives enough padding that a single character collapses to
 * `"  X"` and `" X "` and `"X  "` — each contributes a trigram that
 * captures the character's position relative to the start/end.
 */
const PADDING = "  "

/**
 * Normalize a title for similarity comparison: HTML-entity decode +
 * NFC + lowercase + collapse internal whitespace + trim.
 *
 * **Entity decode is load-bearing.** Pre-PF1-06 vaults still hold titles
 * written as `"Café &amp;amp; Bar"`, while any post-PF1-06 write lands
 * as `"Café & Bar"` because `MemoryService.create` decodes at the write boundary.
 * Without decoding on the read side, the probe would trigram the
 * encoded legacy row against the decoded new row — and the `"&am"`,
 * `"amp"`, `"mp;"` trigrams the encoding added would drop a true
 * duplicate below the 0.7 memory threshold on short titles. The probe
 * also trigrams the raw MCP input (not the post-create decoded title),
 * so the decoder has to sit *inside* the trigram pipeline to cover both
 * sides of the comparison without making the call site responsible.
 *
 * Intentionally keeps punctuation. Titles almost never carry a trailing
 * period, and stripping would collapse `"Fix bug?"` and `"Fix bug!"`
 * into the same bag of trigrams, possibly masking real lexical
 * distinction. Retaining punctuation lets a `?` vs `.` variation cost
 * exactly two boundary trigrams — a small, honest penalty.
 */
function normalizeTitle(s: string): string {
  return decodeTextEntities(s)
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Generate the set of character trigrams for a title. Padding + two
 * sentinel spaces front and back means the first and last real characters
 * each participate in boundary trigrams — `"foo"` yields
 * `{"  f", " fo", "foo", "oo ", "o  "}`, so an edit at the start of the
 * string still affects two trigrams and contributes to the similarity
 * score.
 *
 * Returns an empty set for an empty / whitespace-only input so the caller
 * can distinguish "no signal" from "strong signal".
 */
export function titleTrigrams(s: string): Set<string> {
  const normalized = normalizeTitle(s)
  if (normalized.length === 0) return new Set()
  const padded = `${PADDING}${normalized}${PADDING}`
  const out = new Set<string>()
  for (let i = 0; i <= padded.length - TRIGRAM_SIZE; i++) {
    out.add(padded.slice(i, i + TRIGRAM_SIZE))
  }
  return out
}

/**
 * Jaccard similarity (|A ∩ B| / |A ∪ B|) over the trigram sets of two
 * titles. Returns a value in `[0, 1]`:
 *
 * - `1.0` — identical after normalization (same title, case variation,
 *   internal whitespace differences).
 * - `~0.7` — roughly "one word edited" in a short title. The
 *   near-duplicate probe uses `0.7` as the memory threshold and
 *   `0.6` for decisions.
 * - `0.0` — disjoint trigrams OR either side normalized to empty.
 *
 * Both sides empty returns `0` rather than `1` — two blank titles are
 * not a useful "match" signal and an empty title would fail Notion's
 * validation long before reaching this code. We'd rather skip the
 * warning than fire it on a degenerate input.
 */
export function trigramJaccard(a: string, b: string): number {
  const A = titleTrigrams(a)
  const B = titleTrigrams(b)
  if (A.size === 0 || B.size === 0) return 0

  let intersection = 0
  // Iterate over the smaller set so the hot inner loop stays short on
  // the lopsided case (long title vs one-word title).
  const [smaller, larger] = A.size <= B.size ? [A, B] : [B, A]
  for (const t of smaller) {
    if (larger.has(t)) intersection++
  }
  const union = A.size + B.size - intersection
  return intersection / union
}

/**
 * Jaccard similarity over two tag lists treated as sets. Empty / empty
 * returns `0` for the same reason as `trigramJaccard`: two untagged
 * rows don't give us a useful tag-overlap signal.
 *
 * Duplicates within a single list collapse to a single set element, so
 * `tagOverlap(["x","x"], ["x"])` is `1.0` — tags should be unique per
 * memory by schema but the helper is defensive.
 */
export function tagOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const A = new Set(a)
  const B = new Set(b)
  let intersection = 0
  const [smaller, larger] = A.size <= B.size ? [A, B] : [B, A]
  for (const t of smaller) {
    if (larger.has(t)) intersection++
  }
  const union = A.size + B.size - intersection
  return intersection / union
}
