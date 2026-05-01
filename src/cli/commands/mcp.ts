import { Command } from "commander"

/**
 * `lore mcp` — start the MCP stdio server.
 *
 * Replaces the absolute-path `node <pkgRoot>/dist/mcp.js` shape that
 * `lore install` used to write into consumer config. With this subcommand
 * on the bin, host assistants can dispatch through the package-managed
 * `node_modules/.bin/lore` symlink, which yarn/npm resolve correctly on
 * every machine regardless of where the consumer repo lives on disk.
 *
 * The action handler lazy-imports `mcp/server.js` so `lore --help`,
 * `lore install`, and the unrelated CLI surfaces don't drag the MCP
 * module graph (and its eager Notion / Zod imports) into every CLI run.
 */
export const mcpCommand = new Command("mcp")
  .description("Run the Lore MCP server (stdio transport)")
  .action(async () => {
    const { startServer } = await import("../../mcp/server.js")
    await startServer()
  })
