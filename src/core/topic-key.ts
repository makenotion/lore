/**
 * Topic-key suggester.
 *
 * Pure heuristic over `(title, kind)` that returns a stable kebab-case
 * key suitable for `lore-memory action='save'`'s `topicKey` parameter.
 * The function is deliberately deterministic and
 * side-effect free: an agent calling this with the same input twice
 * MUST get the same key, otherwise upsert grouping fragments across
 * sessions.
 *
 * The corpus of acceptable keys is small ("does the kebab-case look
 * reasonable for upsert grouping?") and the agent can override the
 * suggestion when it disagrees. Over-engineering with NLP libraries is
 * unnecessary — a regex + stoplist is enough. Heuristic noise (a key
 * that reads slightly off) is the explicit cost; the agent overrides
 * and `topicKey` itself is optional.
 */

import type { MemoryKind } from "../types.js"

/**
 * Map memory Kind to a topic-key family prefix. Closed and matches
 * `MemoryKind` exactly. `note` and `task` map to `null` because notes
 * are the catch-all default (no recurring topic) and tasks transition
 * through lifecycle states (`open` / `blocked` / `done`) rather than
 * upsert revisions.
 *
 * Adding a `MemoryKind` value requires adding an entry here.
 * `Record<MemoryKind, ...>` makes the omission a compile error rather
 * than a runtime null, which is the intended exhaustiveness contract.
 */
const KIND_TO_FAMILY: Record<MemoryKind, string | null> = {
  note: null,
  decision: "decision",
  incident: "incident",
  runbook: "runbook",
  postmortem: "postmortem",
  policy: "policy",
  task: null,
  procedure: "procedure",
}

/**
 * Stoplist for title leading words that don't carry semantic weight in
 * a key. Past-tense and bare-imperative verb forms are paired so an
 * agent-written title in either shape (`"Fixed the bug"` or
 * `"Fix the bug"`) drops the same lead. Articles and `rca`-style
 * report-prefix abbreviations also live here so titles like
 * `"RCA: payment gateway timeout cascade"` keep the meaningful suffix.
 *
 * Same posture as `TITLE_LEAD_STOPLIST` — the
 * two lists overlap in spirit but serve different consumers (entity
 * extraction vs. topic-key composition), so they live separately.
 */
const KEY_LEAD_STOPLIST = new Set([
  "the",
  "a",
  "an",
  "fixed",
  "fix",
  "added",
  "add",
  "removed",
  "remove",
  "investigated",
  "investigate",
  "chose",
  "choose",
  "decided",
  "decide",
  "documented",
  "document",
  "updated",
  "update",
  "drafted",
  "draft",
  "wrote",
  "write",
  "ran",
  "run",
  "rca",
  "tldr",
])

/**
 * Tokens that mark a noun-phrase break — the algorithm trims any
 * trailing tokens after the first occurrence of one of these. Captures
 * the common English shape "<noun phrase> <preposition> <prepositional
 * phrase>" so titles like `"JWT auth model with refresh tokens"` keep
 * `jwt-auth-model` as the key (the prepositional tail describes the
 * decision, not its identity).
 */
const NOUN_PHRASE_BREAKS = new Set([
  "with",
  "for",
  "of",
  "in",
  "by",
  "on",
  "at",
  "from",
  "to",
  "after",
  "before",
  "during",
  "and",
  "or",
  "but",
  "into",
  "onto",
  "via",
  "without",
  "within",
  "across",
  "between",
  "about",
  "the",
  "a",
  "an",
])

/**
 * Maximum token count after stoplist + break filtering. Four tokens
 * post-filter — a ceiling, not a target. Most titles hit a preposition
 * break before reaching it (`jwt-auth-model` stops at "with"); the cap
 * binds on the rare un-broken title shape (e.g. `login-redirect-502-outage`).
 * Keys still pass through `SLUG_CHAR_CAP` below, so a 4-token slug of
 * very long words still gets truncated for readability.
 */
const TOKEN_CAP = 4

/**
 * Maximum character length of the slug *suffix* (excluding the family
 * prefix and the separating `/`). 48 keeps `decision/<48 chars>` under
 * the 60-char comfortable-read width that `lore-context action='wake-up'`
 * listings target. When the joined slug exceeds the cap, it is truncated
 * at the last hyphen boundary that fits — preserving whole tokens — and
 * if no hyphen survives, hard-cut at the cap. A title whose first token
 * alone exceeds the cap still produces a (truncated) key rather than
 * `null`; the suggestion stays useful even when the title is dense.
 */
const SLUG_CHAR_CAP = 48

/**
 * Strip ISO-shape dates (`YYYY-MM-DD`) from the title before
 * tokenizing. A title like `"Login redirect 502 outage 2026-04-12"`
 * carries timestamp metadata that an agent reading the topic key
 * doesn't need — and including the date would make every fresh
 * incident memory a unique key, defeating upsert grouping.
 */
const DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/g

/**
 * Combining diacritical marks left behind after `String.normalize("NFKD")`
 * decomposes accented Latin characters. Stripping them gives an ASCII
 * fold (`Café` → `Cafe` → `cafe`) so a title with a diacritic and a
 * title without produce the same key — same upsert chain.
 *
 * **Limitation**: NFKD doesn't decompose CJK / Cyrillic / Greek into
 * ASCII. Those characters still get stripped by the alphanumeric filter
 * downstream, so a CJK-only word becomes empty (`"会員 login policy"` →
 * `"login policy"`). That is documented behavior — consistent with the
 * "regex + stoplist" scope; an agent that needs a CJK key passes one
 * explicitly.
 */
export const COMBINING_MARK_PATTERN = /[\u0300-\u036f]/g

export interface TopicKeySuggestion {
  /** Suggested key, or `null` when no key is appropriate for this kind/title. */
  key: string | null
  /** Human-readable explanation of the suggestion (or its absence). */
  reason: string
}

/**
 * Suggest a stable topic key from `title + kind`. Pure function — same
 * input always returns the same output. Returns `{ key: null }` when
 * the kind has no family (note, task) or the title produces no
 * meaningful tokens after stoplist filtering.
 */
export function suggestTopicKey(input: {
  title: string
  kind: MemoryKind
}): TopicKeySuggestion {
  const family = KIND_TO_FAMILY[input.kind]
  if (family === null) {
    if (input.kind === "note") {
      return {
        key: null,
        reason:
          "Kind 'note' is the catch-all default and does not form a recurring topic.",
      }
    }
    if (input.kind === "task") {
      return {
        key: null,
        reason: "Kind 'task' transitions through lifecycle states, not upsert revisions.",
      }
    }
    return {
      key: null,
      reason: `Kind '${input.kind}' does not form a topic family.`,
    }
  }

  if (input.title.trim() === "") {
    return { key: null, reason: "Empty title." }
  }

  // ASCII-fold accented Latin characters via NFKD decomposition + a
  // combining-mark strip. `Café` → `Cafe´` → `Cafe`. The combining-mark
  // strip happens before lowercase-and-strip so a precomposed `é`
  // (single code point) and a decomposed `e` + combining-acute (two
  // code points) produce the same key. Non-decomposable scripts (CJK,
  // Cyrillic, Greek) survive NFKD unchanged and get dropped by the
  // alphanumeric filter.
  const undated = input.title
    .replace(DATE_PATTERN, " ")
    .normalize("NFKD")
    .replace(COMBINING_MARK_PATTERN, "")

  const tokens = undated
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0)

  let i = 0
  while (i < tokens.length && KEY_LEAD_STOPLIST.has(tokens[i]!)) {
    i += 1
  }
  let remaining = tokens.slice(i)

  const breakIdx = remaining.findIndex((t) => NOUN_PHRASE_BREAKS.has(t))
  if (breakIdx > 0) remaining = remaining.slice(0, breakIdx)

  remaining = remaining.slice(0, TOKEN_CAP)

  // Single trailing guard. The only path that reaches length-zero is
  // "every token was a leading stoplist word" (`"The a an"` → `[]`
  // after stoplist) — `slice(0, breakIdx)` cannot empty a non-empty
  // list because `breakIdx > 0` is the gate, and `slice(0, TOKEN_CAP)`
  // preserves at least one token when at least one exists. A
  // break-word at position 0 (`"The for shard split"` → `["for",
  // "shard", "split"]`) falls through with the break-words kept, and
  // the resulting heuristic-noisy key is the agent-overridable signal
  // the spec accepts.
  if (remaining.length === 0) {
    return {
      key: null,
      reason:
        "Title carries no significant words after stoplist and noun-phrase-break filters.",
    }
  }

  const slug = truncateSlug(remaining.join("-"), SLUG_CHAR_CAP)

  return {
    key: `${family}/${slug}`,
    reason: `Family from kind=${input.kind}; noun phrase from title.`,
  }
}

/**
 * Truncate a hyphen-joined slug to `cap` characters, preferring a
 * hyphen boundary so whole tokens survive. Falls back to a hard cut
 * when no hyphen fits inside the cap (single very-long token). A slug
 * already at-or-under the cap passes through unchanged.
 */
function truncateSlug(slug: string, cap: number): string {
  if (slug.length <= cap) return slug
  const head = slug.slice(0, cap)
  const lastHyphen = head.lastIndexOf("-")
  return lastHyphen > 0 ? head.slice(0, lastHyphen) : head
}
