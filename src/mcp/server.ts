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
import { z } from "zod"

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

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

const DIAGNOSTIC_TOOL_NAMES = [
  "lore-context",
  "lore-memory",
  "lore-query",
  "lore-fact",
  "lore-decision",
  "lore-project",
  "lore-task",
] as const

const DIAGNOSTIC_INPUT_SCHEMA = z
  .object({
    action: z
      .unknown()
      .optional()
      .describe(
        "Diagnostic mode accepts any action value or omitted action; every call returns setup-recovery text."
      ),
  })
  .passthrough()

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
  //
  // 0.10.1 exposes a diagnostic MCP surface for interactive service-init
  // failures. The success path still registers the same seven dispatchers,
  // but degraded startup now presents the same dispatcher names with setup
  // recovery text instead of disconnecting the client.
  //
  // 0.11.0 packages the post-ntn dogfood hardening train: attribution,
  // retry-safe writes, task/audit/list output fixes, entity merge, and
  // Notion request throttling.
  //
  // 0.12.0 makes explicit project scope fail closed across MCP and CLI
  // entry points. Agents now get deterministic errors for typo'd,
  // archived, inaccessible, or ambiguous project names instead of
  // silently falling back to auto-detected or vault-wide scope.
  //
  // 0.13.0 flips normal MCP fact creation from warning-only provenance
  // guidance to hard-error enforcement before fact or Entity writes.
  const server = new McpServer(
    { name: "lore", version: "0.13.0" },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  )

  let services: LoreServices | null = null

  try {
    // MCP startup is a hot path — every reconnecting client kicks off a
    // fresh process and would otherwise enqueue a full schema-drift scan
    // against the same rate-limited client used for tool calls. Debounce
    // it: the per-config-root marker (see `src/hooks/drift-marker.ts`)
    // ensures the scan fires at most once per `DRIFT_DEBOUNCE_DAYS`.
    services = await initServices(undefined, { driftCheck: "debounced" })
  } catch (err) {
    if (process.env["LORE_BACKGROUND_AGENT"] === "true") {
      throw err
    }

    // If service initialization fails, still start the server with a minimal
    // diagnostic surface so MCP clients can display setup guidance instead
    // of collapsing the failure into a generic connection error.
    const initErrorMessage = formatInitErrorMessage(err)
    console.error(
      `[lore] Failed to initialize; starting diagnostic MCP server: ${initErrorMessage}`
    )
    registerStartupDiagnosticTools(server, formatStartupDiagnostic(err, initErrorMessage))
  }

  if (services) {
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
  }

  // Start the stdio transport
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// Called only when service init failed, before the full tool surface has
// registered any of these names.
function registerStartupDiagnosticTools(server: McpServer, diagnosticText: string): void {
  for (const name of DIAGNOSTIC_TOOL_NAMES) {
    registerStartupDiagnosticTool(server, name, diagnosticText)
  }
}

function registerStartupDiagnosticTool(
  server: McpServer,
  name: (typeof DIAGNOSTIC_TOOL_NAMES)[number],
  diagnosticText: string
): void {
  server.registerTool(
    name,
    {
      title: "Lore setup diagnostics",
      description:
        "Lore could not finish startup. Any action or arguments return the initialization error and recovery steps.",
      inputSchema: DIAGNOSTIC_INPUT_SCHEMA,
      annotations: { readOnlyHint: true },
    },
    async (): Promise<ToolResult> => ({
      content: [{ type: "text", text: diagnosticText }],
      isError: true,
    })
  )
}

function formatStartupDiagnostic(
  error: unknown,
  message = formatInitErrorMessage(error)
): string {
  const configRoot = process.env["LORE_CONFIG_ROOT"]?.trim()
  const recoverySteps = [
    "- If the error says no `.lore.yaml` was found, run `lore init` from the project directory or re-run `lore install` from the configured vault project.",
    "- If the error mentions Notion auth, run `lore auth --login` or set `NOTION_API_TOKEN` with a Notion integration token.",
    "- If the error mentions missing `Entities`, run `lore vault ensure-entities`, then `lore migrate --build-entities --yes` in a quiet window.",
    "- If `LORE_CONFIG_ROOT` points at the wrong directory, re-run `lore install` from the project directory or unset `LORE_CONFIG_ROOT` so Lore can search upward from the MCP process cwd.",
    "- After fixing setup, restart or reconnect the MCP client so Lore can register the full tool surface.",
  ]

  return [
    "# Lore MCP Startup Diagnostic",
    "",
    "Lore MCP server started in diagnostic mode because service initialization failed.",
    "",
    "## Initialization Error",
    "",
    fencedMarkdown(message),
    "",
    "## Environment",
    "",
    `- Current working directory: ${process.cwd()}`,
    `- LORE_CONFIG_ROOT: ${configRoot || "not set"}`,
    "",
    "## Recovery Steps",
    "",
    ...recoverySteps,
  ].join("\n")
}

function formatInitErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fencedMarkdown(value: string): string {
  const longestBacktickRun =
    value.match(/`+/g)?.reduce((longest, run) => Math.max(longest, run.length), 0) ?? 0
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1))
  return [fence, value, fence].join("\n")
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
