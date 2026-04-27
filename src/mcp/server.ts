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
import { registerDecisionTools } from "./tools/decisions.js"
import { registerQueryTools } from "./tools/query.js"
import { registerTaskTools } from "./tools/tasks.js"

// Re-export for consumers that already import from this module
export type { LoreServices } from "../services.js"
export { initServices } from "../services.js"

async function main(): Promise<void> {
  // P3-01 collapsed the tool surface from 24 single-purpose tools to seven
  // polymorphic dispatchers (with the prior names retained as deprecated
  // aliases). The shape of every reconnecting client's tool list shifts
  // observably, so the server version bumps 0.3.0 → 0.4.0.
  //
  // PF3-04 tightens the MCP `lore-context action='wake-up'` per-section
  // defaults whenever `userQuery` is non-empty (mirroring the shell hook's
  // `RANKED_WAKEUP_LIMITS`). MCP-direct callers that previously relied on
  // the looser `DEFAULT_WAKEUP_*` caps for ranked calls now see fewer
  // rows — observable shape change with no schema delta — so the server
  // version bumps 0.4.0 → 0.5.0.
  const server = new McpServer(
    { name: "lore", version: "0.5.0" },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  )

  let services: LoreServices

  try {
    // MCP startup is a hot path — every reconnecting client kicks off a
    // fresh process and would otherwise enqueue a full schema-drift scan
    // against the same rate-limited client used for tool calls. Debounce
    // it: the per-config-root marker (see `src/hooks/drift-marker.ts`)
    // ensures the scan fires at most once per `DRIFT_DEBOUNCE_DAYS`.
    services = await initServices(undefined, { driftCheck: "debounced" })
  } catch (err) {
    // If initialization fails, still start the server but with limited tools
    // so the user can get a helpful error message
    console.error(
      `[lore] Failed to initialize: ${err instanceof Error ? err.message : err}`
    )
    process.exit(1)
  }

  // Register all tools. P3-01 collapsed the surface to seven polymorphic
  // tools (lore-context / lore-memory / lore-query / lore-fact /
  // lore-decision / lore-journal / lore-project) with the prior 24 tool
  // names retained as deprecated aliases. See src/mcp/AGENTS.md.
  registerContextTools(server, services)
  registerMemoryTools(server, services)
  registerQueryTools(server, services)
  registerProjectTools(server, services)
  registerKnowledgeTools(server, services)
  registerJournalTools(server, services)
  registerDecisionTools(server, services)
  registerTaskTools(server, services)

  // Start the stdio transport
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error("[lore] Fatal error:", err)
  process.exit(1)
})
