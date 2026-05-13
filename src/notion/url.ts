/**
 * Canonical Notion deep-link builder.
 *
 * The hyphenated UUID format Notion returns is collapsed to the
 * no-dash form Notion emits in its share URLs — matching the
 * canonical form keeps every link target consistent with what an
 * operator would copy from a Notion browser tab.
 *
 * Lives in the notion SDK layer (rather than alongside terminal-link
 * helpers in the CLI output module) so non-CLI surfaces — the MCP
 * layer, core service helpers, the promotion audit-block builder —
 * can import it without crossing the MCP → CLI import boundary.
 * CLI callers re-export from the CLI output module for backward-compat
 * callers.
 */
export function notionPageUrl(pageId: string): string {
  return `https://notion.so/${pageId.replace(/-/g, "")}`
}
