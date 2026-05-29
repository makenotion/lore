# Vault Command Contract

`lore vault` hosts vault maintenance commands that operate on the configured
primary vault through the shared `initServices()` graph.

## `migrate-agent-diary`

- Default mode is dry-run. It queries live Memories rows with
  `Source = agent_diary`, prints counts and samples, and writes nothing.
- `--apply` is the only write mode. It is idempotent:
  - Rows with empty `Kind` and non-`rejected` `Status` are updated to
    `Status = rejected`.
  - Rows with empty `Kind` already at `Status = rejected` are reported but
    not written.
  - Rows with `Kind = note` are updated to `Source = conversation`.
  - Rows with any other `Kind` are reported for manual review and left
    untouched.
- `--sample <n>` controls how many rows per bucket render in human output.
- `--json` writes the full migration result to stdout. Failures and parse
  errors stay on stderr so stdout remains parseable.
- Partial update failures are reported after the command attempts every planned
  write. Any failure exits non-zero; successful writes are safe to keep because
  rerunning the command skips or repeats the same idempotent target state.
