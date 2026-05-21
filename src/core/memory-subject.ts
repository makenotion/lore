import { COMBINING_MARK_PATTERN } from "./topic-key.js"

export const SUBJECT_CANONICAL_TOPIC_FAMILY = "state"

const SUBJECT_SLUG_CHAR_CAP = 80
const SUBJECT_TOPIC_KEY_REGEX =
  /^state\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/

function truncateSlug(slug: string, maxChars: number): string {
  if (slug.length <= maxChars) return slug
  const cut = slug.slice(0, maxChars)
  const lastHyphen = cut.lastIndexOf("-")
  return lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut
}

export function subjectToTopicKey(subject: string): string {
  const trimmed = subject.trim()
  if (SUBJECT_TOPIC_KEY_REGEX.test(trimmed)) return trimmed

  const tokens = trimmed
    .normalize("NFKD")
    .replace(COMBINING_MARK_PATTERN, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0)

  const slug = truncateSlug(tokens.join("-"), SUBJECT_SLUG_CHAR_CAP)
  if (slug.length === 0) {
    throw new Error(
      "subject must contain at least one ASCII letter or number after normalization."
    )
  }

  return `${SUBJECT_CANONICAL_TOPIC_FAMILY}/${slug}`
}
