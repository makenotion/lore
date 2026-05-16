# The `inbox` Command

[Back to CLI command contracts](../../cli-command-contracts.md).

`lore inbox` is the operator-facing surface for proposed-memory review.

Subcommands:

- `inbox list [--project <name>] [-n <limit>]` lists memories with
  `Status = proposed`. Empty inbox prints a single line and exits 0.
- `inbox approve <memoryId> [--reason <text>]` promotes a row to
  `Status: accepted` and records `verdict: "approve"`.
- `inbox reject <memoryId> [--reason <text>]` sets `Status: rejected`.
- `inbox archive <memoryId>` soft-deletes through `MemoryService.archive`.

Reviewer identity resolves through `services.identity.resolveAuthor()`, using
the same `LORE_USER_NAME -> users.me` chain as memory writes. An unresolvable
identity fails with exit 1 rather than writing an audit row attributed to an
unknown reviewer.

The `## Reviewed (YYYY-MM-DD)` audit block is appended after the property write.
Property-first / audit-second ordering means a partial audit append failure
leaves the structural status flip in place. Shared error types let callers
distinguish non-proposed rows from audit-write failures.

The MCP parallel surface is `lore-memory action='approve'` and
`lore-memory action='reject'`; keep the handler shape and service path aligned.
