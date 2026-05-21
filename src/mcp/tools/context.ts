import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { formatDispatchError, toolError } from "../helpers.js"
import { handleDigest } from "./context/digest.js"
import { contextDispatchSchema, contextInputSchema } from "./context/schema.js"
import { handleStatus } from "./context/status.js"
import { handleWakeUp, neutralizeLeadingBlockquote } from "./context/wake-up.js"

export { neutralizeLeadingBlockquote }

export function registerContextTools(server: McpServer, services: LoreServices): void {
  // -------------------------------------------------------------------------
  // lore-context — polymorphic dispatcher
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-context",
    {
      title: "Vault context operations",
      description:
        "Vault status, session priming, and project digest in one polymorphic tool. Action-dispatched:\n\n" +
        "- `action: 'status'` — vault page id, topology health when configured, database counts, active project, configured projects, background hook failures, a task summary line (active / overdue / stale / in-progress / blocked, plus a closure-rate line on vaults with the `Done At` column), and a proposed-memory inbox count line when proposed learnings exist (excludes proposed-state decisions, which surface via `lore-decision` instead).\n" +
        "- `action: 'wake-up'` — load digest + (when `userQuery` is set) For-Your-Current-Task ranked memories + recent memories + tasks + active facts + decisions requiring attention. Title-tier rows by default; `expand: true` for bodies. Pass `userQuery` after `/clear` or a session pivot to rank pages for the current question. Use `mode: 'task-only'` for narrow retrieval. Pass `debug: true` for coverage counters.\n" +
        "- `action: 'digest'` — gather raw activity data for synthesis into a digest memory. Save the synthesis via `lore-memory` action='save' with source='digest'.",
      inputSchema: contextInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const parsed = contextDispatchSchema.safeParse(args)
      if (!parsed.success) {
        return toolError(new Error(formatDispatchError("lore-context", parsed.error)))
      }
      switch (parsed.data.action) {
        case "status":
          return handleStatus(services)
        case "wake-up":
          return handleWakeUp(services, parsed.data)
        case "digest":
          return handleDigest(services, parsed.data)
      }
    }
  )
}
