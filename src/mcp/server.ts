/**
 * Lore MCP server — the primary interface for AI assistants.
 *
 * Runs as a stdio process. AI assistants connect to it and use tools
 * to save, search, and recall memories from a Notion-backed vault.
 *
 * Two entry points reach this code:
 *   - Legacy: `node dist/mcp.js` (preserved for one release for `~/.lore`
 *     consumers; the file's own `if (isEntryPoint())` guard runs `main`).
 *   - Bin-dispatch: `lore mcp` (the default for 0.11.0+ installs). The
 *     CLI command lazy-imports `startServer` from this module.
 */

import { fileURLToPath } from "node:url"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

import { type LoreServices, initServices } from "../services.js"

import { registerContextTools } from "./tools/context.js"
import { registerMemoryTools } from "./tools/memory.js"
import { registerProjectTools } from "./tools/project.js"
import { registerKnowledgeTools } from "./tools/knowledge.js"
import { registerDecisionTools } from "./tools/decisions.js"
import { registerQueryTools } from "./tools/query.js"
import { registerTaskTools } from "./tools/tasks.js"

// Re-export for consumers that already import from this module
export type { LoreServices } from "../services.js"
export { initServices } from "../services.js"

export async function startServer(): Promise<void> {
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
  //
  // 0.5.1 (issue 0.6.0/24) adds the `lore status` tracking-predicate
  // preflight ahead of the 0.6.0 deprecation purge. No MCP surface
  // change — patch bump per the version-literal-must-move-together
  // contract documented in `src/mcp/AGENTS.md`.
  const server = new McpServer(
    { name: "lore", version: "0.9.0" },
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

  // Register all tools. The polymorphic surface is seven dispatchers:
  // lore-context / lore-memory / lore-query / lore-fact / lore-decision /
  // lore-project / lore-task. P3-01 introduced the dispatch pattern,
  // PF3-06 added lore-task, and the 0.6.0 deprecation purge removed the
  // legacy journal dispatcher alongside the 28 single-purpose aliases.
  // See src/mcp/AGENTS.md.
  registerContextTools(server, services)
  registerMemoryTools(server, services)
  registerQueryTools(server, services)
  registerProjectTools(server, services)
  registerKnowledgeTools(server, services)
  registerDecisionTools(server, services)
  registerTaskTools(server, services)

  // Start the stdio transport
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return fileURLToPath(import.meta.url) === entry
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  startServer().catch((err) => {
    console.error("[lore] Fatal error:", err)
    process.exit(1)
  })
}
