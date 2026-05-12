/**
 * Canonical Notion deep-link builder.
 *
 * The hyphenated UUID format Notion returns is collapsed to the
 * no-dash form Notion emits in its share URLs — matching the
 * canonical form keeps every link target consistent with what an
 * operator would copy from a Notion browser tab.
 *
 * Lives in `src/notion/` (not `src/cli/output.ts`, where it was
 * originally co-located with terminal-link helpers) so non-CLI
 * surfaces — the MCP layer, core service helpers, the promotion
 * audit-block builder — can import it without crossing the
 * `src/mcp/` → `src/cli/` import boundary that `src/mcp/AGENTS.md`
 * documents. CLI callers re-export from `src/cli/output.ts` for
 * backward-compat callers.
 */
export function notionPageUrl(pageId: string): string {
  return `https://notion.so/${pageId.replace(/-/g, "")}`
}
