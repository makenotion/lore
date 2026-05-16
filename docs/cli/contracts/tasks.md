# The `tasks` Command

[Back to CLI command contracts](../../cli-command-contracts.md).

`lore tasks` is the CLI surface for task lifecycle operations.

Contracts:

- `tasks create` writes a task with explicit title and optional project,
  description, entity, initial state, blocker label, due date, topic, tags,
  keywords, synopsis, pointer-subject override, and JSON output.
- `tasks update` changes mutable metadata without implying completion.
- `tasks close` records closure state and `Done At` when the vault has that
  column. Close reasons should preserve the distinction between completed,
  cancelled, duplicate, and obsolete work.
- `tasks close-many` is a batch operation; preserve per-row reporting so partial
  failures are visible.
- `tasks list` is a read surface. JSON output must remain pipe-clean.
- `tasks reconcile` scans active tasks for memory evidence that suggests they
  can close; it should not silently close work without the explicit close path.
- Project filters use the same fatal-strict project resolution rule as other
  scoped commands.
