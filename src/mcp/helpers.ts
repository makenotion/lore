/**
 * MCP tool helpers.
 */

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

/**
 * Format an unknown error into a standard MCP tool error response.
 */
export function toolError(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err)
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  }
}

/**
 * Render the pagination footer a cursor-aware list tool appends to its text
 * response when more results exist. Absence of the footer signals end-of-list.
 *
 * A fenced ```json block is used (not a bare JSON line) so agents can parse
 * it unambiguously even when list items contain colons, brackets, or other
 * JSON-looking syntax in their titles or bodies.
 */
export function paginationFooter(nextCursor: string | undefined): string {
  if (!nextCursor) return ""
  return `\n\n---\n\n\`\`\`json\n${JSON.stringify({ nextCursor })}\n\`\`\``
}
