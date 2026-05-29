# Partial-Failure Observability

Lore treats partial failures as successful calls with operator-visible
diagnostics. The agent-facing response keeps the useful partial result and a
`Warnings:` footer. Recoverable RunTool-to-REST exceptions are always emitted
to stderr so REST usage remains measurable while RunTool is the primary Notion
API path.

## Debug Gate

Set `LORE_DEBUG=1` to emit legacy partial-failure diagnostics that are still
useful only during investigation, such as hybrid-search branch failures. RunTool
fallback events are not debug-gated because they are part of the operator
contract for explicit REST exceptions.

Every new partial-result surface must route its recoverable per-item failures
through the shared stderr convention so a single grep sweep stays useful:

```text
[lore] partial-failure: ... error=<message> ...
```

The `error=` value must contain only the error message, not stacks, SDK
response bodies, headers, or whole error objects. Route the value through the
debug redactor before writing it, and normalize interpolated fields to one
line so each failure produces exactly one newline-delimited event.

## MCP Root Fan-Outs

MCP read-path fan-outs that use `settleAll` emit one line per failed root:

```text
[lore] partial-failure: root=<rootId> error=<message> tool=<toolName>
```

`root` is the failed Notion root id, and `tool` is the MCP tool name that
returned the partial response. The explicit root id remains visible because it
is the operator's triage key; the `error` value is redacted.

## Fact Provenance Precheck

`lore-fact action='create'` provenance precheck failures use a separate
parser-friendly prefix:

```text
[lore] fact-precheck-rejected: reason=<reason> agent=<agent> session=<session> sourceMemoryId=<sourceMemoryId> project=<projectIds>
```

This line is emitted only for runtime provenance failures after schema
validation succeeds, such as unresolved session auto-link, cross-project
session candidate, unresolved explicit source, or cross-project explicit
source. `reason` is the stable classifier. `agent`, `session`,
`sourceMemoryId`, and `project` are diagnostic context.

## Surface-Specific Keys

The `[lore] partial-failure:` prefix and `error=` field are stable across
surfaces. Other keys are scoped to the emitting surface and may differ when
`root` and `tool` would be misleading.

Examples:

```text
[lore] partial-failure: branch=<contains|semantic> error=<message> source=hybrid-search
[lore] partial-failure: source=<source> status=<status> code=<code> reason=<reason> error=<message> runtool-fallback=1 used-rest=1
```

Downstream parsers should match on the prefix and the `error=` field, then
treat surface-specific keys as optional context.
