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
| `tools/memory.ts`      | `lore-memory` polymorphic dispatcher (`save` / `update` / `archive` / `expand` / `suggest-topic-key` / `compare` / `approve` / `reject` / `promote`)                                                                       |
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

| Guide                                                                        | Use it for                                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`docs/mcp-tool-authoring.md`](../../docs/mcp-tool-authoring.md)             | Flat MCP schemas, polymorphic dispatch, registration examples, and new-tool checklist |
| [`docs/mcp-tools.md`](../../docs/mcp-tools.md)                               | User-facing tool/action reference and current behavior                                |
| [`docs/archive/mcp-tool-history.md`](../../docs/archive/mcp-tool-history.md) | Removed aliases, deprecation timelines, and historical version evidence               |
| [`docs/mcp-hosts.md`](../../docs/mcp-hosts.md)                               | Unsupported-host configuration notes                                                  |

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

```typescript
export function toolError(err: unknown): ToolResult {
  if (err instanceof WriteBudgetExceededError) {
    return {
      content: [{ type: "text" as const, text: err.message }],
      isError: true,
    }
  }

  const rawMessage = err instanceof Error ? err.message : String(err)
  const message = redactDebugMessage(rawMessage, { truncate: false })
  const metadata = formatErrorMetadata(err)

  return {
    content: [{ type: "text" as const, text: `Error: ${message}${metadata}` }],
    isError: true,
  }
}
```

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

`lore-fact action='create'` provenance precheck failures use a separate
parser-friendly prefix:

```
[lore] fact-precheck-rejected: reason=<reason> agent=<agent> session=<session> sourceMemoryId=<sourceMemoryId> project=<projectIds>
```

This line is emitted only for runtime provenance failures after schema
validation succeeds, such as unresolved session auto-link, cross-project
session candidate, unresolved explicit source, or cross-project explicit
source. `reason=` is the stable classifier; `agent`, `session`,
`sourceMemoryId`, and `project` are diagnostic context.

The convention is opt-in precisely because routine transients would flood
stderr. Operators who want to distinguish a one-off 429 from a pathological
corrupted-page loop set `LORE_DEBUG=1` for a session. Every new partial-result
surface (PF1-01 bounded retries, wake-up's parallel queries, etc.) should
route its failures through the same helper so `grep "[lore] partial-failure:"`
stays comprehensive.

Only `error.message` is logged — not `.stack`, `.body`, `.headers`, or the
full error object. The message then routes through `redactDebugError`
(`src/debug-redact.ts`) before stderr (issue #488):

- **Must-redact (token-leak class).** Bearer-token-shaped substrings
  (`ntn_…` / `secret_…` followed by ≥20 url-safe chars) → `<redacted-token>`.
  Today's Notion SDK does not interpolate tokens into `Error.message`;
  the guard is forward-compatible against a regression in the same class
  axios pre-1.x shipped (echoing `Authorization` headers in retry traces).
- **Should-redact (recon class).** Notion page-id shapes
  (`[a-f0-9]{32}` and the dashed UUID form) → `<page-id>`. Page IDs
  are not bearer secrets per the root `AGENTS.md` Authentication section,
  but they let an outsider enumerate vault structure; same threat the
  PR is closing.
- **SDK-field stripping (flat-string scrubber).** `body=` / `headers?=`
  / `payload=` / `response=` / `request=` / `cause=` / `query=`
  substrings, walked by a state-machine scanner that handles
  arbitrary-depth balanced brace/bracket payloads (the depth counter
  walks through any nesting level — quoted spans inside structured
  payloads are skipped via the quoted-string handler so embedded `}`
  inside `"…"` doesn't confuse the depth math), single- or
  double-quoted strings with C-style escapes, or a bare token stopping
  at hard delimiters (`,`, `;`, `}`, `)`, `]`) OR at whitespace where
  the next non-space token is shaped like another `<name>=` field.
  **Unbalanced or malformed structured input deliberately consumes
  through end-of-string** — the conservative posture when the
  boundary is ambiguous. Forward-compatible against a future SDK
  regression that interpolates a JSON body into `Error.message`.
- **Structured-payload key-aware redaction (extraInfo walker).** The
  Notion SDK's `Logger` interface passes a structured `extraInfo`
  object alongside the `message`. `redactDebugExtraInfo` walks the
  object recursively but applies a **key-aware wholesale-redact rule**:
  when a property's key is in `SENSITIVE_EXTRA_INFO_KEYS` (the same
  eight names as the flat-string scrubber, derived from a single
  `SDK_SENSITIVE_FIELD_NAMES` source) AND the value is not an `Error`,
  the entire value is replaced with `<redacted>` regardless of nested
  shape. This closes the structured-content leak class where leaf-only
  scrubbing would walk into `{ body: { properties: { Name: { title:
[...] } } } }` and only catch substring-shaped leaks. The Error
  escape-hatch preserves operator-actionable diagnostics — `request:
new Error("...")` walks through the Error special-case to extract
  `name` + scrubbed `message`. Recursion still fires for
  non-sensitive keys, so a nested sensitive key under a non-sensitive
  parent (`{ outer: { body: ... } }`) is still wholesale-redacted at
  the inner level. Walker depth is bounded at `MAX_EXTRA_INFO_DEPTH`
  to keep pathological inputs from triggering a recursion-induced
  `RangeError`.
- **Length bound.** Truncated to `MAX_DEBUG_MESSAGE_LENGTH` chars with
  a `…(truncated)` marker.

Operators retain the diagnostic value (error category and first sentence
of message) without leaking SDK-interpolated vault locators (e.g.
`InvalidPathParameterError`'s page-id detail) into a centralized log
aggregator. The explicit `root=<id>` / `memoryId=<id>` / `entity=<value>`
interpolations are intentionally NOT redacted — operators need them to
triage which root failed.

The `eslint.config.js` `no-restricted-syntax` rule fires when a
`process.stderr.write` template literal interpolates an error message
directly (`${err.message}`, `${error.message}`, `${String(err)}`,
`${errorMessage(err)}`, or a ternary thereof). New `LORE_DEBUG`-gated
emitters land safely as `${redactDebugError(err)}` — the wrapped form
sidesteps the rule because the immediate template expression is a call
to the redactor. The lint rule is a backstop, not a complete defense:
a contributor who routes the message through a custom helper that
itself calls `process.stderr.write` could still bypass redaction. The
contract is documented here and in the redactor's own docstring;
review-side enforcement remains the load-bearing layer.

Interpolated `rootId` and `message` fields have ASCII control characters
(`0x00-0x1F`, `0x7F` — including `\n`, `\r`, `\t`) replaced with spaces
before the line is written. One failure always produces exactly one log
line, so `grep` and log-aggregator parsers can rely on newline-delimited
events even if a future caller threads a stringly-typed multi-line error
through the same helper.

**Per-surface key names diverge; the prefix and `error=` field are
the stable contract.** Core-layer surfaces emit `[lore]
partial-failure:` lines too (e.g. hybrid search in
`src/core/memory.ts:debugLogHybridBranchFailure` uses
`branch=<contains|semantic> source=hybrid-search`) because a
non-MCP failure isn't a Notion root id and `tool=` would be
misleading for a core-service path. Downstream log parsers should
match on the `[lore] partial-failure:` prefix and the `error=`
field; per-surface keys are scoped to their surface and may
introduce new names as future call sites land. See
`src/core/AGENTS.md` for the hybrid-search divergence in detail.

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
