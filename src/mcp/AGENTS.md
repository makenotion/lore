# AGENTS.md -- src/mcp/

> Read the root `AGENTS.md` first. This file covers the MCP server layer only.
> It is the precedence-bearing guide for MCP implementation work; detailed
> authoring examples live in [docs/mcp-tool-authoring.md](../../docs/mcp-tool-authoring.md).

## Purpose

This directory implements Lore's MCP (Model Context Protocol) server. It is the
primary interface for AI assistants. The server runs as a stdio process and
exposes nine polymorphic tools: `lore-context`, `lore-memory`,
`lore-pinned`, `lore-query`, `lore-fact`, `lore-decision`,
`lore-project`, `lore-task`, and `lore-procedure`.

Current user-facing tool behavior belongs in
[docs/mcp-tools.md](../../docs/mcp-tools.md). Historical alias removals,
deprecation windows, and version evidence belong in
[docs/archive/mcp-tool-history.md](../../docs/archive/mcp-tool-history.md).
Do not duplicate the full tool reference in this file.

## Files

| File                   | Responsibility                                                                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.ts`            | Server entry point: init services, register tools, start stdio transport                                                                                                                                                   |
| `help.ts`              | `lore://help` and `lore://help/<tool>/<action>` resource recipes for polymorphic tool payload examples                                                                                                                     |
| `helpers.ts`           | `toolError()`, `paginationFooter()`, `debugLogPartialFailures()`, `formatDispatchError()`                                                                                                                                  |
| `tools/context.ts`     | `lore-context` polymorphic dispatcher (`status` / `wake-up` / `digest`)                                                                                                                                                    |
| `tools/memory.ts`      | `lore-memory` polymorphic dispatcher registration and compatibility exports for `handleRecall` / `handleSearch` used by `lore-query`                                                                                       |
| `tools/memory/`        | Action-specific `lore-memory` handlers (`save` / `update` / `archive` / `expand` / `suggest-topic-key` / `compare` / `approve` / `reject` / `promote`), dispatch schema, and shared memory tool constants                  |
| `tools/pinned.ts`      | `lore-pinned` polymorphic dispatcher (`pin` / `unpin` / `update` / `list`) for pinned context blocks (issue #282); hosts the audit-line append helper and `PinnedAuditError` partial-state error type                      |
| `tools/query.ts`       | `lore-query` polymorphic (read-path dispatcher; reuses handlers from memory.ts and knowledge.ts)                                                                                                                           |
| `tools/project.ts`     | `lore-project` polymorphic dispatcher (`list` / `get`)                                                                                                                                                                     |
| `tools/knowledge.ts`   | `lore-fact` polymorphic dispatcher (`create` / `invalidate` / `extend`); read-side `ask` / `audit` handlers exported for `lore-query`                                                                                      |
| `tools/decisions.ts`   | `lore-decision` polymorphic dispatcher (`create` / `list` / `get` / `context` / `supersede` / `review`)                                                                                                                    |
| `tools/tasks.ts`       | `lore-task` polymorphic dispatcher (`create` / `update` / `close` / `close-many` / `list` / `reconcile`)                                                                                                                   |
| `tools/procedures.ts`  | `lore-procedure` polymorphic dispatcher (`scan-candidates` / `propose` / `deprecate`) — procedural memory promotion. Approval routes through `lore-memory action='approve'` so the audit contract stays on one entrypoint. |
| `tools/date-schema.ts` | Shared `YYYY-MM-DD` and clearable date Zod schemas for MCP tool boundaries                                                                                                                                                 |
| `tools/text-schema.ts` | Shared `nonBlankString` Zod schema for create-required user-facing text fields (rejects empty / whitespace-only)                                                                                                           |

## Documentation Map

| Guide                                                                                  | Use it for                                                                            |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`docs/mcp-tool-authoring.md`](../../docs/mcp-tool-authoring.md)                       | Flat MCP schemas, polymorphic dispatch, registration examples, and new-tool checklist |
| [`docs/mcp-tools.md`](../../docs/mcp-tools.md)                                         | User-facing tool/action reference and current behavior                                |
| [`docs/partial-failure-observability.md`](../../docs/partial-failure-observability.md) | `LORE_DEBUG=1` partial-failure stderr line contract                                   |
| [`docs/archive/mcp-tool-history.md`](../../docs/archive/mcp-tool-history.md)           | Removed aliases, deprecation timelines, and historical version evidence               |
| [`docs/mcp-hosts.md`](../../docs/mcp-hosts.md)                                         | Unsupported-host configuration notes                                                  |

## Contribution Rules

- Keep the MCP surface polymorphic. Prefer a new action on an existing
  `lore-*` dispatcher; add a new tool family only when the behavior does not
  fit any existing family.
- Keep MCP-level schemas flat: one top-level `action` enum plus optional
  per-action fields. Use module-local discriminated unions for runtime
  validation.
- Every tool callback catches failures and returns `toolError(err)`. Do not
  let exceptions escape the MCP callback.
- Every `inputSchema` field uses Zod and has a `.describe()` string that
  tells an agent which actions use the field.
- Omitted update fields mean "leave unchanged." For clearable non-string Notion
  properties, `null` is the canonical clear sentinel; MCP schemas may accept
  `""` as an agent-friendly alias only when they normalize it before calling
  services. Rich-text fields use `""` as the clear value.
- Read-only tools set `readOnlyHint: true`; archive/delete-style actions set
  `destructiveHint: true` where the registration can express it.
- Explicit project scope is strict. Use `resolveProjectIds` for writes and
  `resolveReadProjectScope` for reads that accept an explicit project name.
- Write-time `tags` schemas come from `createTagsSchema(services.profile...)`
  in `tools/tag-schema.ts`. Pair tags with `keywordsSchema` for free-form
  identifiers.
- Deprecation cycles must be explicit: deprecate in descriptions first, mark
  removal blocks with a `TODO(<target-version>)` sentinel, and purge
  registrations, hook allowlists, and surface-count tests atomically.
- Return MCP content as `{ content: [{ type: "text", text: "..." }] }` and
  use readable markdown for multi-item responses.
- Interactive service-init failures must stay MCP-visible: `server.ts` should
  register diagnostic stubs for every `lore-*` dispatcher and connect stdio
  instead of exiting.

## Adding Or Changing Tools

For detailed examples, use [docs/mcp-tool-authoring.md](../../docs/mcp-tool-authoring.md).
The short checklist is:

1. Add or update the local `handle<Action>` function.
2. Add the runtime discriminated-union branch and flat MCP `inputSchema` fields.
3. Add the dispatch case and keep parse failures routed through
   `formatDispatchError()` + `toolError()`.
4. Update the tool description and MCP help recipes in `src/mcp/help.ts` when
   users need examples.
5. Update [docs/mcp-tools.md](../../docs/mcp-tools.md) for user-facing behavior
   changes.
6. Add or update `polymorphic.test.ts` coverage for registration, dispatch,
   unknown actions, and missing required fields.

## Error Handling

The `toolError()` helper in `helpers.ts` formats errors for MCP. MCP-visible
error text is a security boundary: every non-sentinel message must pass through
`redactDebugMessage(..., { truncate: false })` before it is returned to the
host. The `truncate: false` option preserves recovery guidance in long error
messages while still scrubbing SDK fields, bearer tokens, and page-id-shaped
substrings.

`WriteBudgetExceededError` is the explicit exception. It is returned verbatim,
without an `Error: ` prefix, because the bench/mining child grep-matches that
sentinel to halt gracefully.

Do not interpolate `err.message` directly into MCP content, even for validation
or dispatch errors. Wrap thrown and string errors in `toolError()` and let the
helper handle redaction and retryable metadata consistently.

Errors that extend `LoreError` append a fenced JSON metadata block containing
`kind` and redacted `details`. Retryable errors append `code` and
`retryable: true` in the same block. Treat this block as the machine-readable
contract; the leading prose message remains for operators.

**Rule**: Never let exceptions propagate out of a tool callback. The MCP transport
does not handle thrown errors gracefully. Always catch and return `toolError()`.

### Partial-failure observability (`LORE_DEBUG`)

Read-path fan-outs that return partial results must surface agent-facing
warnings and, when `LORE_DEBUG=1`, one-line stderr diagnostics. The canonical
stderr contract lives in
[docs/partial-failure-observability.md](../../docs/partial-failure-observability.md).
The redaction taxonomy for those diagnostics lives in the top-of-file JSDoc in
`src/debug-redact.ts`.

## Versioning

Do not bump versions unless the human lead explicitly asks for a version bump in
this turn. When a requested agent-observable MCP change requires a release bump,
update these four literals in the same commit:

1. `package.json#version`
2. The `version` string passed to `new McpServer({ name, version }, ...)` in
   `src/mcp/server.ts`
3. The `.version(...)` argument in `src/cli/index.ts`
4. `USER_AGENT` in `src/notion/client.ts`

Add the corresponding historical note to
[docs/archive/mcp-tool-history.md](../../docs/archive/mcp-tool-history.md) so
release evidence stays out of this routing guide.

## Server Startup

`server.ts` runs as a standalone process (the `dist/mcp.js` entry point):

1. Creates an `McpServer` instance with `tools` and `resources` capabilities.
2. Calls `initServices()` to load config, connect to Notion, and resolve context.
3. Registers all tool groups.
4. Connects to a `StdioServerTransport`.

If `initServices()` fails (no config, bad token, etc.), interactive MCP hosts
still get a stdio server with diagnostic stubs for every registered
`lore-*` dispatcher. Any action or arguments return the initialization error and
recovery steps, so agents that reflexively call `wake-up`, `digest`, `save`, or
another dispatcher still see actionable setup guidance instead of a schema or
method-not-found error. Non-init failures such as tool registration or
transport connection errors remain fatal.

Hook-spawned background agents set `LORE_BACKGROUND_AGENT=true`; MCP children in
that environment fail fast on init errors rather than staying alive as a
diagnostic server, so the hook lock/liveness path can recover on the next Stop.
They also set `LORE_AUTOSAVE=false` to prevent recursive autosaves, but that
public autosave opt-out is not the diagnostic-mode bypass.

### ntn-issued tokens may expire mid-session

The MCP server is long-running — assistants connect to it and stay
connected across many tool dispatches. If an ntn-issued token
expires mid-session, the next Notion call returns 401. The shared
Notion client wrapper re-runs `resolveAuth` for initial
`ntn-auth-json` sessions, rebuilds the SDK client when `auth.json`
now carries different auth inputs, and retries the failed request once.
Static `NOTION_API_TOKEN` auth does not install this refresh hook, and an
unchanged or still-rejected ntn token surfaces the original tool-call error
so the operator can run `lore auth --login` and reconnect if needed.
