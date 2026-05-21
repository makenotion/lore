/**
 * Bearer-shaped-prefix patterns redacted from any agent, judge, or tool
 * output that flows into bench artifacts.
 */
const BEARER_REDACTION_PATTERNS: readonly RegExp[] = [
  /ntn_[A-Za-z0-9_-]{20,}/g,
  /development_ntn_[A-Za-z0-9_-]{20,}/g,
  /secret_[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
]

export function redactBearerTokens(text: string): string {
  let out = text
  for (const re of BEARER_REDACTION_PATTERNS) {
    out = out.replace(re, "<redacted-token>")
  }
  return out
}
