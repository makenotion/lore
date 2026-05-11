/**
 * Topic-name normalization for the write-path duplicate probe and the
 * `--merge-similar-topics` migration.
 *
 * The single shared rule: two strings normalize to the same key iff their
 * differences are limited to case, HTML-entity encoding, &/and conjunction,
 * surrounding punctuation, plural-`s` / `-es` / `-ies`, and whitespace
 * variants. Anything beyond that — different head nouns, different
 * adjectives, different conjunction targets ("Quality" vs "Testing") —
 * normalizes apart and flows to the trigram fuzzy probe instead.
 *
 * Why these rules and no more: every transformation here corresponds to a
 * real-world variant pattern observed in the issue #109 internal-vault audit
 * (`Eval & Testing` ↔ `Evals & Testing`, `Build & Tooling` ↔
 * `Build &amp; Tooling`, casing-only twins). Adding gerund-strip
 * (`testing` ↔ `test`) or full lemmatization would over-collapse genuinely
 * distinct topics — `string` normalizing to `str`, `training` to `train` —
 * and silently strand siblings under the wrong canonical. The probe is
 * advisory enough that under-collapse can be corrected by an operator
 * after the fact; over-collapse rewrites memory→topic relations and is
 * not reversible by un-archiving.
 */

import { decodeTextEntities } from "../notion/html-entities.js"

/**
 * Words shorter than this stay as-is during the singularize pass. Without
 * the floor, `gas` would normalize to `ga` and `bus` to `bu` — both far
 * enough from English plural patterns that the safer move is to leave them
 * untouched.
 */
const SINGULARIZE_MIN_LENGTH = 4

/**
 * Conservative singularize: drop a trailing `s` / `es` / `ies` only when
 * the word is long enough that the suffix is unlikely to be load-bearing.
 *
 * - `tests` → `test`, `evals` → `eval`, `bodies` → `body`, `processes` → `process`
 * - `gas`, `bus`, `is`, `as` (length < 4) → unchanged
 * - `boss` → `boss` (double-s exception)
 * - `this`, `quality`, `testing` → unchanged (don't match any rule)
 *
 * Not a real lemmatizer; doesn't try to handle irregulars (`children` /
 * `mice` / `feet`) or gerunds. The point is to fold the cheapest, most
 * common variant — plural — without risking semantic drift.
 */
function singularize(word: string): string {
  if (word.length < SINGULARIZE_MIN_LENGTH) return word
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y"
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2)
  if (word.endsWith("ss")) return word
  if (word.endsWith("s")) return word.slice(0, -1)
  return word
}

/**
 * Normalize a topic name into a comparison key. Two names that produce the
 * same key are treated as the same topic by the write-path probe and the
 * `--merge-similar-topics` migration.
 *
 * Pipeline (order matters):
 *   1. HTML-entity decode — pre-PF1-06 vaults still hold encoded names.
 *   2. NFC — fold combining-mark vs. precomposed-character splits.
 *   3. Lowercase.
 *   4. `&` → `and` — agents flip these freely.
 *   5. Strip every non-letter, non-digit character to a space — folds
 *      hyphens, ampersands (now `and` words), punctuation, em-dashes.
 *   6. Tokenize on whitespace; drop empty tokens.
 *   7. Singularize each token.
 *   8. Re-join with single spaces.
 *
 * Returns `""` for an empty / whitespace-only input. Callers must treat
 * empty keys as "no match" — comparing two empty keys would falsely
 * collapse every degenerate input together.
 */
export function normalizeTopicNameForLookup(input: string): string {
  const stripped = decodeTextEntities(input)
    .normalize("NFC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")

  const tokens = stripped.split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) return ""

  return tokens.map(singularize).join(" ")
}
