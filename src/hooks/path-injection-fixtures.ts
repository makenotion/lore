/**
 * Canonical list of hostile session-id shapes that every hook-state
 * filename builder (`lockPath`, `logPath`, `statePath`) must keep under
 * `getStateDir()`.
 *
 * Hoisted out of the individual test files so a future maintainer adding
 * a new attack shape (e.g. a Unicode normalization variant, or a new
 * shell-metacharacter Node grew syscall handling for) updates ONE list
 * and every path-injection table picks it up. Without this, the three
 * `it.each` tables drift the moment one is updated and the others are
 * forgotten.
 *
 * Plain `.ts` (not `.test.ts`) so the file is not picked up by vitest's
 * test discovery — it's data, not a suite. Imported only from test
 * modules.
 */

/** `[label, hostileSessionId]` tuples. */
export const HOSTILE_SESSION_IDS: ReadonlyArray<readonly [string, string]> = [
  ["forward slashes", "../etc/passwd"],
  ["backslashes", "..\\etc\\passwd"],
  ["mixed separators", "../foo\\bar/baz"],
  ["whitespace", "session id with spaces"],
  ["tab and newline", "sess\twith\nbreaks"],
  ["shell metacharacters", "a;rm -rf /;b"],
  ["command substitution", "$(whoami)"],
  ["backticks", "`whoami`"],
  ["pipe and ampersand", "a|b&c"],
  ["NUL byte", "sess\0null"],
  ["leading dots only", ".."],
  ["double dots with separator", "../"],
  ["URL-encoded traversal", "%2e%2e%2fescape"],
] as const
