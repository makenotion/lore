/**
 * Lore MCP server — the primary interface for AI assistants.
 *
 * Runs as a stdio process. AI assistants connect to it and use tools
 * to save, search, and recall memories from a Notion-backed vault.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

import { type LoreServices, initServices } from "../services.js"

import { registerContextTools } from "./tools/context.js"
import { registerMemoryTools } from "./tools/memory.js"
import { registerProjectTools } from "./tools/project.js"
import { registerKnowledgeTools } from "./tools/knowledge.js"
import { registerJournalTools } from "./tools/journal.js"
import { registerDigestTools } from "./tools/digest.js"
import { registerDecisionTools } from "./tools/decisions.js"

// Re-export for consumers that already import from this module
export type { LoreServices } from "../services.js"
export { initServices } from "../services.js"

async function main(): Promise<void> {
  const server = new McpServer(
    { name: "lore", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  )

  let services: LoreServices

  try {
    services = await initServices()
  } catch (err) {
    // If initialization fails, still start the server but with limited tools
    // so the user can get a helpful error message
    console.error(
      `[lore] Failed to initialize: ${err instanceof Error ? err.message : err}`
    )
    process.exit(1)
  }

  // Register all tools
  registerContextTools(server, services)
  registerMemoryTools(server, services)
  registerProjectTools(server, services)
  registerKnowledgeTools(server, services)
  registerJournalTools(server, services)
  registerDigestTools(server, services)
  registerDecisionTools(server, services)

  // Start the stdio transport
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error("[lore] Fatal error:", err)
  process.exit(1)
})
