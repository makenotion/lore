# AGENTS.md -- src/mcp/

> Read the root `AGENTS.md` first. This file covers the MCP server layer only.

## Purpose

This directory implements Lore's MCP (Model Context Protocol) server. It is the
primary interface for AI assistants. The server runs as a stdio process and
exposes 24 tools across seven registration files.

## Files

| File | Responsibility |
|------|---------------|
| `server.ts` | Server entry point: init services, register tools, start stdio transport |
| `helpers.ts` | `toolError()` helper for formatting error responses |
| `tools/context.ts` | `lore-status`, `lore-wake-up` |
| `tools/memory.ts` | `lore-remember`, `lore-search`, `lore-recall`, `lore-forget`, `lore-update` |
| `tools/project.ts` | `lore-list-projects`, `lore-get-project` |
| `tools/knowledge.ts` | `lore-learn`, `lore-ask`, `lore-correct`, `lore-open-loops`, `lore-audit`, `lore-extend` |
| `tools/digest.ts` | `lore-digest` |
| `tools/journal.ts` | `lore-journal`, `lore-read-journal` |
| `tools/decisions.ts` | `lore-decide`, `lore-list-decisions`, `lore-get-decision`, `lore-decision-context`, `lore-supersede`, `lore-review-decision` |

## Tool Registration Pattern

Every tool file exports a single `registerFooTools(server, services)` function
that calls `server.registerTool()` for each tool. The pattern:

```typescript
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { toolError } from "../helpers.js"

export function registerFooTools(
  server: McpServer,
  services: LoreServices
): void {
  server.registerTool("lore-verb-noun", {
    title: "Human-readable title",
    description: "What this tool does. Include usage guidance for the AI.",
    inputSchema: {
      paramName: z.string().describe("What this parameter is for"),
      optionalParam: z.string().optional().describe("Optional context"),
    },
    annotations: { readOnlyHint: true },  // if tool only reads data
  }, async ({ paramName, optionalParam }) => {
    try {
      // ... tool logic ...
      return { content: [{ type: "text", text: "result" }] }
    } catch (err) {
      return toolError(err)
    }
  })
}
```

### Mandatory conventions

1. **Tool names**: Always `lore-<verb>` or `lore-<verb>-<noun>` in kebab-case.

2. **try/catch**: Every tool callback must wrap its body in try/catch and return
   `toolError(err)` on failure. MCP protocol requires tools to report errors as
   content, not throw exceptions.

3. **inputSchema**: Always uses Zod objects. Each field must have a `.describe()`
   call explaining the parameter to the AI.

4. **annotations**: Set `readOnlyHint: true` for tools that only read data.
   Set `destructiveHint: true` for tools that delete or archive.

5. **Project resolution**: Most tools accept an optional `projectName` /
   `projectNames` parameter. For **write** tools (memory, knowledge,
   decisions) prefer `resolveProjectIds(services, projectName, projectNames)`
   from `resolve.ts`. For **read** tools, use `services.context.project`
   directly. The write-path resolver handles the catch-all warning:

   ```typescript
   const resolved = await resolveProjectIds(services, projectName, projectNames)
   // resolved.ids → project IDs to persist
   // resolved.warnings → surface in the tool response
   ```

   When the auto-detected context is a monorepo catch-all (config entry with
   path `"."`), and no explicit project was named, `resolveProjectIds` adds
   a warning naming the candidate sub-projects. The warning surfaces via the
   existing `Warnings: …` line in save tool responses — no display-layer
   changes needed per tool.

6. **Return format**: Always return `{ content: [{ type: "text", text: "..." }] }`.
   Format output as readable markdown when returning multiple items.

7. **Tags are a closed vocabulary.** Any tool that accepts `tags` must use
   `tagsSchema` from `tools/tag-schema.ts` (backed by `TAG_VOCABULARY` in
   `types.ts`). Pair it with `keywordsSchema` so callers have a home for
   free-form tokens (PR numbers, ticket IDs, file paths, class names).
   Out-of-vocab tags must fail validation — don't loosen this at the tool
   boundary.

## Tool Reference

### Context Tools

| Tool | Purpose | Read-only |
|------|---------|-----------|
| `lore-status` | Vault status, database counts, active project | Yes |
| `lore-wake-up` | Load recent memories + facts for session priming | Yes |

### Memory Tools

| Tool | Purpose | Read-only |
|------|---------|-----------|
| `lore-remember` | Save a new memory to the vault | No |
| `lore-search` | Semantic search across memories (uses Notion search) | Yes |
| `lore-recall` | List recent memories with optional filters | Yes |
| `lore-forget` | Archive a memory by ID | No (destructive) |
| `lore-update` | Update a memory's title, content, tags, or categorization | No |

#### Content-off default for list/search tools

`lore-recall` and `lore-search` both default to **`includeContent: false`**.
Each returns index-tier rows — title, metadata, timestamps — without fetching
the markdown body for each page. Fetching bodies costs one extra
`pages.retrieveMarkdown` round-trip per row, and most triage paths only need
a handful of bodies for the rows the agent actually cares about.

- **Default path.** Agents scan the index tier, decide which rows are
  relevant, then fetch bodies one at a time via a read tool (e.g.
  `lore-get-decision` for decisions). The response footer reminds callers
  that bodies were omitted.
- **Opt in.** Pass `includeContent: true` when the caller genuinely needs
  every body — e.g. exporting a window of memories or piping into another
  indexing pipeline. The hot path stays fast by default, and the slow path
  is explicit.

Changing this default is a breaking change for agents that relied on eager
bodies; the server version is bumped to `0.2.0` in `server.ts` so MCP
clients see the shift immediately.

### Project Tools

| Tool | Purpose | Read-only |
|------|---------|-----------|
| `lore-list-projects` | List all projects in the vault | Yes |
| `lore-get-project` | Get project details including topics and recent activity | Yes |

### Knowledge Tools

| Tool | Purpose | Read-only |
|------|---------|-----------|
| `lore-learn` | Add a subject-predicate-object fact triple | No |
| `lore-ask` | Query facts about an entity (as subject or object) | Yes |
| `lore-correct` | Invalidate a fact (sets Valid Until, does not delete) | No (destructive) |
| `lore-open-loops` | List active open loops (tracking predicate facts) | Yes |
| `lore-audit` | List all facts past their review-by date | Yes |
| `lore-extend` | Push back a fact's review-by date | No |

### Digest Tools

| Tool | Purpose | Read-only |
|------|---------|-----------|
| `lore-digest` | Generate a project digest for a time window | Yes |

### Journal Tools

| Tool | Purpose | Read-only |
|------|---------|-----------|
| `lore-journal` | Write an agent diary entry | No |
| `lore-read-journal` | Read recent journal entries | Yes |

### Decision Tools

| Tool | Purpose | Read-only |
|------|---------|-----------|
| `lore-decide` | Save a decision; auto-creates `decided_by` facts per affects entry and `supersedes_decision` facts if superseding | No |
| `lore-list-decisions` | Index-tier listing of decisions (properties only, no body fetch) | Yes |
| `lore-get-decision` | Load full rationale + metadata for one decision | Yes |
| `lore-decision-context` | Graph walk: return all active decisions governing an entity (via `decided_by` facts) | Yes |
| `lore-supersede` | Mark old decision as superseded by new; atomic + creates `supersedes_decision` fact | No |
| `lore-review-decision` | Mark a decision as reviewed, push `Review By` forward (default +90 days) | No |

**Decision predicates are internal-only.** `decided_by`, `supersedes_decision`,
and `informs` are in the `FactPredicate` union and the Notion `Predicate`
select options, but they are NOT in `PREDICATE_VALUES` in `tools/knowledge.ts`.
This prevents users from creating inconsistent decision edges via `lore-learn`
— only `DecisionService` and the decision tools create these facts.

**`lore-learn` expects `sourceMemoryId` (soft-phase).** Every fact
should link back to a supporting memory so `lore-ask` can retrace the
reasoning. The tool resolves the source in this order:

1. Explicit `sourceMemoryId` argument — always wins.
2. Session auto-link: if the caller passes `agent`+`session` and a
   `lore-remember`/`lore-decide` call earlier in this process recorded
   a memory under the same composite key, that memory becomes the
   source **only if** its project scope intersects the fact's (or
   either side is vault-wide). The response shows
   "auto-linked from session" so the caller can retract on mis-match.
3. Neither available → fact is created **with a prominent warning** in
   the response. This soft-phase window lets deployed callers adopt
   `sourceMemoryId` before we flip to a hard error in a future minor.

The Zod schema marks `sourceMemoryId` as optional. Runtime logic is
stricter — it surfaces a warning when neither an explicit ID nor an
auto-link candidate is available. The mismatch is intentional: schema-
level strictness would break every deployed agent caller on day one,
which is exactly what the soft-phase avoids. Agents that inspect the
tool description see the contract; runtime surfaces the enforcement.
When we flip to hard error, also tighten the Zod schema to a
`superRefine` requiring either `sourceMemoryId` or `session`.

The session mapping lives on `services.sessionMemories` (a per-process
`SessionMemoryTracker`). `lore-remember` and `lore-decide` write into
it with the memory's `projectIds` so the auto-link project check has
real data. The tracker is keyed on a composite of `agent`+`session`
so two agents connected to the same MCP process cannot collide on a
shared session string. Capped at 256 entries with LRU eviction — no
cross-process persistence.

## Adding a New Tool

1. Decide which tool file it belongs in, or create a new file if it represents a
   new domain.
2. Follow the registration pattern above exactly.
3. Register it in `server.ts` if you created a new file:
   ```typescript
   import { registerNewTools } from "./tools/new.js"
   // ... in main():
   registerNewTools(server, services)
   ```
4. Do not forget the try/catch + `toolError()` wrapper.
5. Add the tool to the table in this file and in the root `README.md`.

## Error Handling

The `toolError()` helper in `helpers.ts` formats errors for MCP:

```typescript
export function toolError(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err)
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  }
}
```

**Rule**: Never let exceptions propagate out of a tool callback. The MCP transport
does not handle thrown errors gracefully. Always catch and return `toolError()`.

### Partial-failure observability (`LORE_DEBUG`)

Read-path fan-outs that use `settleAll` (see `core/settle.ts`) return partial
results plus per-root failures rather than sinking the whole call. Failures
surface to the agent via the existing `Warnings:` footer, but that signal
stops at the MCP response — operators running the server see nothing.

When `LORE_DEBUG=1`, tool handlers call `debugLogPartialFailures(toolName, failures)`
after the resolver returns. The helper is a no-op when the env var is unset,
and otherwise emits one stderr line per failure:

```
[lore] partial-failure: root=<rootId> error=<message> tool=<toolName>
```

The convention is opt-in precisely because routine transients would flood
stderr. Operators who want to distinguish a one-off 429 from a pathological
corrupted-page loop set `LORE_DEBUG=1` for a session. Every new partial-result
surface (PF1-01 bounded retries, wake-up's parallel queries, etc.) should
route its failures through the same helper so `grep "[lore] partial-failure:"`
stays comprehensive.

Only `error.message` is logged — not `.stack`, `.body`, `.headers`, or the
full error object. This narrows the log surface and keeps the bulk of Notion
SDK error metadata out of stderr. It is **not** a redaction boundary: some
SDK errors (e.g. `InvalidPathParameterError`) interpolate request-scoped
detail into `.message` itself, which will still appear. `LORE_DEBUG=1` is
operator instrumentation, not a sensitive-data filter.

Interpolated `rootId` and `message` fields have ASCII control characters
(`0x00-0x1F`, `0x7F` — including `\n`, `\r`, `\t`) replaced with spaces
before the line is written. One failure always produces exactly one log
line, so `grep` and log-aggregator parsers can rely on newline-delimited
events even if a future caller threads a stringly-typed multi-line error
through the same helper.

## Server Startup

`server.ts` runs as a standalone process (the `dist/mcp.js` entry point):

1. Creates an `McpServer` instance with `tools` and `resources` capabilities.
2. Calls `initServices()` to load config, connect to Notion, and resolve context.
3. Registers all tool groups.
4. Connects to a `StdioServerTransport`.

If `initServices()` fails (no config, bad token, etc.), the process exits with
code 1 and logs the error to stderr.
