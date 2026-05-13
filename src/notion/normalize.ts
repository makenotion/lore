/**
 * Shared text normalization helpers for equality keys written to Notion.
 *
 * The Facts DB uses a `DedupKey` rich_text column to coalesce "same triple,
 * cosmetic differences" writes (case, whitespace, trailing punctuation) into
 * one row. Normalization lives here so callers that need to compute the key
 * from outside `FactService` (migrations, tests) don't re-invent it.
 */

import { createHash } from "node:crypto"

export interface FactTripleInput {
  subject: string
  predicate: string
  object: string
}

/**
 * Trailing characters stripped by `normalize`. Intentionally limited to
 * whitespace and sentence-terminator punctuation (`. , ; : ! ?`) so closing
 * brackets, quotes, and other balanced punctuation stay attached —
 * `"foo (bar)"` normalizes to `"foo (bar)"`, not `"foo (bar"`. The broader
 * `\p{P}` class would silently delete asymmetric bracketing and bite
 * downstream reusers (near-duplicate memories, entity canonicalization).
 */
const TRAILING_STRIP_RE = /[.,;:!?\s]+$/

/**
 * Collapse cosmetic differences that would otherwise split semantically
 * identical strings across multiple fact rows:
 *
 * - Unicode NFC: `"café"` (precomposed é) and `"café"` (e + combining acute)
 *   fold to the same form.
 * - Collapse internal whitespace runs to a single space.
 * - Trim leading / trailing whitespace.
 * - Strip a trailing run of sentence-terminator punctuation and whitespace
 *   (`"Foo."` matches `"Foo"`) but keep embedded punctuation — `"file.ts"`
 *   stays `"file.ts"`.
 * - Lowercase.
 *
 * Not a security boundary; purely a dedup key. Keeping it deterministic and
 * dependency-free makes it safe to reuse across runtime + migration paths.
 */
export function normalize(s: string): string {
  return s
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(TRAILING_STRIP_RE, "")
    .toLowerCase()
}

/**
 * ASCII Unit Separator. Joins the three triple components so normalized
 * user input can never collide across boundaries — `("a b","uses","c")` and
 * `("a","uses","b c")` yield distinct pre-hash strings because `\x1F` never
 * appears in normalized text. Exported so tests can assert the join format
 * without duplicating the literal.
 */
export const DEDUP_KEY_SEP = "\x1F"

/**
 * Compute the dedup key for a fact triple. Subject and object are normalized;
 * the predicate is a closed enum (the `FactPredicate` union) so it
 * passes through unchanged. The resulting triple is hashed with SHA-256 to
 * produce a fixed-length 64-character hex digest.
 *
 * Why hash: Notion's `rich_text` cells silently truncate at 2000 characters
 * and the `equals` filter compares against the stored (possibly truncated)
 * value. A raw key built from a long `object` could silently lose its suffix,
 * defeating the probe and re-creating duplicates every call. Hashing removes
 * the truncation edge case and keeps the column index-friendly.
 */
export function computeFactDedupKey(input: FactTripleInput): string {
  const raw = [
    normalize(input.subject),
    input.predicate,
    normalize(input.object),
  ].join(DEDUP_KEY_SEP)
  return createHash("sha256").update(raw).digest("hex")
}

/**
 * Canonical subject key for case-insensitive `queryBySubject` matching.
 * Stored on the Facts DB's `SubjectKey` rich_text column
 * alongside the human-readable `Subject` title.
 *
 * Implemented as a thin alias over `normalize` because the two share the
 * same fold semantics (NFC, whitespace collapse, trailing-terminator strip,
 * lowercase) — a separate "subject fold" would inevitably drift from the
 * dedup-key fold and reintroduce the same fragmentation. The Entities
 * DB replaces this with a relation-based join,
 * but the rich_text key is sufficient for the substring-contains queries
 * `lore-query action='ask'` and `queryByEntity` issue today.
 *
 * Stored values are bounded by `Subject` itself (Notion title cells cap
 * around 2000 chars), so we don't hash here — the column needs to support
 * `contains`, which Notion doesn't run against hashed values.
 */
export function computeSubjectKey(subject: string): string {
  return normalize(subject)
}
