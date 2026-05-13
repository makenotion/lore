/**
 * Lore MCP server — the primary interface for AI assistants.
 *
 * Runs as a stdio process. AI assistants connect to it and use tools
 * to save, search, and recall memories from a Notion-backed vault.
 *
 * Two entry points reach this code:
 *   - Legacy absolute-path launcher: `node` against the standalone
 *     built MCP entry. The `isEntryPoint()` guard at the bottom of
 *     this file runs `main()` for that path.
 *   - Bin-dispatch: `lore mcp` (the default for current installs).
 *     The CLI command lazy-imports `startServer` from this module.
 */

import { fileURLToPath } from "node:url"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

import { type LoreServices, initServices } from "../services.js"

import { registerContextTools } from "./tools/context.js"
import { registerMemoryTools } from "./tools/memory.js"
import { registerPinnedTools } from "./tools/pinned.js"
import { registerProjectTools } from "./tools/project.js"
import { registerKnowledgeTools } from "./tools/knowledge.js"
import { registerDecisionTools } from "./tools/decisions.js"
import { registerQueryTools } from "./tools/query.js"
import { registerTaskTools } from "./tools/tasks.js"
import { registerProcedureTools } from "./tools/procedures.js"

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
  "lore-pinned",
  "lore-query",
  "lore-fact",
  "lore-decision",
  "lore-project",
  "lore-task",
  "lore-procedure",
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
  // The version literal below is the MCP handshake string. Bumps
  // here move in lockstep with the package version, the CLI's
  // `.version(...)` literal, and the Notion `User-Agent` constant
  // so reconnecting clients always observe the same string the rest
  // of the build advertises.
  const server = new McpServer(
    { name: "lore", version: "0.13.1" },
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
    // it: the per-config-root drift marker ensures the scan fires at
    // most once per `DRIFT_DEBOUNCE_DAYS`.
    services = await initServices(undefined, { driftCheck: "debounced" })
  } catch (err) {
    if (process.env["LORE_BACKGROUND_AGENT"] === "true") {
      throw err
    }

    // If service initialization fails, still start the server with a minimal
    // diagnostic surface so MCP clients can display setup guidance instead
    // of collapsing the failure into a generic connection error. The
    // formatted details preserve the error name, stack, and `cause` chain
    // so a one-line `Invalid URL` failure has a frame-level trail an
    // operator (or agent) can act on.
    const initErrorDetails = formatInitErrorDetails(err)
    console.error(
      `[lore] Failed to initialize; starting diagnostic MCP server:\n${initErrorDetails}`
    )
    registerStartupDiagnosticTools(server, formatStartupDiagnostic(err, initErrorDetails))
  }

  if (services) {
    // Register every polymorphic dispatcher. Each register* call below
    // adds exactly one `lore-*` tool name to the agent-visible surface;
    // the polymorphic dispatch pattern multiplexes per-tool actions
    // behind a single registration so per-session prompt overhead stays
    // bounded. The canonical contract — names, actions, and exhaustive
    // surface count — is enforced by the dispatcher surface tests.
    registerContextTools(server, services)
    registerMemoryTools(server, services)
    registerPinnedTools(server, services)
    registerQueryTools(server, services)
    registerProjectTools(server, services)
    registerKnowledgeTools(server, services)
    registerDecisionTools(server, services)
    registerTaskTools(server, services)
    registerProcedureTools(server, services)
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
  details = formatInitErrorDetails(error)
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
    fencedMarkdown(details),
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

/**
 * Format a thrown error for the startup-diagnostic surface. Includes
 * `error.name`, `error.message`, the full stack, and any `cause` chain
 * so generic messages like `Invalid URL` carry a stack frame the
 * operator (or agent reading the diagnostic) can act on.
 *
 * Falls back to `String(error)` for non-Error throwables. A `cause`
 * cycle is broken via a visited set so a self-referential chain
 * cannot loop forever.
 */
function formatInitErrorDetails(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const blocks: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  let prefix = ""
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    // V8's `error.stack` already starts with `Name: message\n    at ...`,
    // so embedding the stack also embeds the name and message in their
    // canonical positions. Some throwers strip the stack — fall back to
    // the bare `Name: message` shape so the fenced block is never empty.
    const block = current.stack ?? `${current.name}: ${current.message}`
    blocks.push(prefix ? `${prefix}${block}` : block)
    prefix = "Caused by: "
    current = (current as { cause?: unknown }).cause
  }
  // A non-Error `cause` (string, number, plain object) terminates the
  // chain — render it once so the trail is preserved.
  if (current !== undefined && !(current instanceof Error)) {
    blocks.push(`Caused by: ${String(current)}`)
  }
  return blocks.join("\n")
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
