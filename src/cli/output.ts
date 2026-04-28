/**
 * CLI rendering helpers shared across `lore` commands.
 *
 * The OSC 8 hyperlink path is the load-bearing surface here. The pure
 * `maybeTerminalLink` accepts injected `{ isTTY, env }` so tests don't mutate
 * `process.stdout.isTTY` or `process.env`; production callers route through
 * the `terminalLink` shim, which binds those values from the live process.
 */

/**
 * Strip C0 controls (`\x00-\x1F`) and DEL (`\x7F`) from a candidate hyperlink
 * label. ESC (`\x1B`) is in the C0 range, so the same regex removes both the
 * OSC 8 terminator (`\x1B\\`) and the BEL terminator (`\x07`) that would
 * otherwise let an embedded escape sequence break out of the hyperlink.
 */
function sanitizeLinkText(s: string): string {
  // Matching control bytes is the entire point — escape sequences embedded
  // in user-controlled text are exactly what we strip.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1F\x7F]/g, "")
}

/**
 * Strip C0/DEL bytes and confirm the URL matches the Notion deep-link
 * safelist. Returns the empty string when the URL fails the safelist; callers
 * treat that as "fall back to plain text" before any OSC 8 bytes are
 * assembled. A future contributor adding a non-Notion link target updates
 * this regex once — ad-hoc URL strings never reach the escape sequence.
 */
function sanitizeLinkUrl(s: string): string {
  // Same posture as `sanitizeLinkText` — control bytes in a candidate URL
  // are exactly the injection vector the safelist defends against.
  // eslint-disable-next-line no-control-regex
  const stripped = s.replace(/[\x00-\x1F\x7F]/g, "")
  return /^https:\/\/(www\.)?notion\.so\/[\w-]+$/.test(stripped) ? stripped : ""
}

/**
 * Treat `LORE_NO_HYPERLINKS=0` / `=false` / empty as "not disabled". A bare
 * truthiness check would treat any non-empty string as "set", so an operator
 * who exports `LORE_NO_HYPERLINKS=0` to be explicit about *off* would get
 * the opposite of what they expected. `NO_COLOR` stays presence-only because
 * that's the documented convention for the third-party flag.
 */
function envDisablesHyperlinks(value: string | undefined): boolean {
  if (!value) return false
  return value !== "0" && value !== "false"
}

/**
 * Pure helper. Decides emission based on injected `isTTY` and env. Used
 * directly by tests; the process-bound `terminalLink` below is the
 * production wrapper.
 *
 * Returns plain `text` (unsanitized) on every fallback path because the
 * caller is asking for inert rendering at that point — stripping C0
 * controls is only justified when we're emitting an OSC 8 sequence those
 * controls could break out of.
 *
 * Do not double-wrap (`terminalLink(terminalLink(x, u1), u2)`): the inner
 * call's ESC bytes would be stripped by the outer call's `sanitizeLinkText`,
 * leaving a malformed sequence. Wrap the raw label exactly once.
 */
export function maybeTerminalLink(
  text: string,
  url: string,
  ctx: { isTTY: boolean; env: NodeJS.ProcessEnv }
): string {
  if (!ctx.isTTY) return text
  if (ctx.env["NO_COLOR"]) return text
  if (envDisablesHyperlinks(ctx.env["LORE_NO_HYPERLINKS"])) return text

  const safeUrl = sanitizeLinkUrl(url)
  // Empty target would render as a "link to nowhere" on supporting
  // terminals — clickable but inert. Bail before assembling the sequence.
  if (!safeUrl) return text

  const safeText = sanitizeLinkText(text)
  // Empty label after sanitization (genuinely empty input, or input that
  // was nothing but stripped control bytes) — wrapping zero characters
  // costs bytes for no affordance. Fall through to plain `text`.
  if (!safeText) return text

  return `\x1b]8;;${safeUrl}\x1b\\${safeText}\x1b]8;;\x1b\\`
}

/**
 * Process-bound wrapper around `maybeTerminalLink`. Production CLI code
 * calls this; tests call `maybeTerminalLink` directly with injected
 * `{ isTTY, env }` so the test runner never has to mutate process globals.
 */
export function terminalLink(text: string, url: string): string {
  return maybeTerminalLink(text, url, {
    isTTY: process.stdout.isTTY ?? false,
    env: process.env,
  })
}

/**
 * Build the canonical Notion deep-link for a page id. The hyphenated UUID
 * format Notion returns is collapsed to the no-dash form Notion emits in
 * its share URLs — matching the canonical form keeps OSC 8 link targets
 * consistent with what an operator would copy from a Notion browser tab.
 *
 * Single production-code source of Notion deep-links. Every CLI surface
 * that links to a page routes through this helper rather than building
 * the string inline.
 */
export function notionPageUrl(pageId: string): string {
  return `https://notion.so/${pageId.replace(/-/g, "")}`
}
