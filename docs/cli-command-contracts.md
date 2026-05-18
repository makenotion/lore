# CLI Command Contracts

This guide holds developer-facing contracts for CLI commands whose behavior is
easy to break while refactoring. It complements the user-facing
[`cli.md`](cli.md) reference and the shared authoring rules in
[`cli-authoring.md`](cli-authoring.md).

Detailed per-command contracts live under [`docs/cli/contracts/`](cli/contracts/).
Keep this index focused on cross-command invariants, routing, and a short summary of each command contract.

## Cross-Command Rules

- User-facing command inventory lives in [`cli.md`](cli.md). Registered command
  inventory lives in [`src/cli/index.ts`](../src/cli/index.ts). Update both
  when adding, removing, or renaming a command.
- Explicit project scope is fatal-strict. If a command accepts
  `--project <name>` and the name does not resolve, exit non-zero with an
  actionable message instead of falling back to auto-detected or vault-wide
  scope.
- Plan/apply migrations default to plan mode unless the flag's contract says
  otherwise. `--dry-run` always wins over apply mode.
- JSON-capable commands write parseable results to stdout and progress or
  diagnostics to stderr.
- No command should silently widen the user's requested scope after a parse,
  profile, auth, or project-resolution failure.

## Per-Command Contracts

| Command     | Contract                                                        | Summary                                                                                                                                       |
| ----------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`      | [`docs/cli/contracts/auth.md`](cli/contracts/auth.md)           | Interactive authentication, token-source diagnostics, ntn login behavior, and vault preflight contracts.                                      |
| `search`    | [`docs/cli/contracts/search.md`](cli/contracts/search.md)       | Read-only memory search, project/tag/limit filtering, human rendering, and JSON output contracts.                                             |
| `migrate`   | [`docs/cli/contracts/migrate.md`](cli/contracts/migrate.md)     | Additive schema repair and data-migration contracts, including plan/apply posture and idempotency requirements.                               |
| `digest`    | [`docs/cli/contracts/digest.md`](cli/contracts/digest.md)       | Recent-activity digest gathering, dry-run rendering, background synthesis, and debounce-marker contracts.                                     |
| `status`    | [`docs/cli/contracts/status.md`](cli/contracts/status.md)       | Vault metadata, task/confidence/proposed-memory summaries, topology, digest/drift, and local cost status contracts.                           |
| `costs`     | [`docs/cli/contracts/costs.md`](cli/contracts/costs.md)         | Local-only cost ledger summary/export contracts, including range parsing, disabled behavior, and privacy limits.                              |
| `install`   | [`docs/cli/contracts/install.md`](cli/contracts/install.md)     | Assistant integration installation, persona routing, auth preflight, MCP environment, target-specific config, and hook contracts.             |
| `conflicts` | [`docs/cli/contracts/conflicts.md`](cli/contracts/conflicts.md) | Conflict-candidate scan pipeline, bounded coverage, output shapes, and memory scan service contracts.                                         |
| `inbox`     | [`docs/cli/contracts/inbox.md`](cli/contracts/inbox.md)         | Proposed-memory review lifecycle contracts for list, approve, reject, archive, reviewer identity, and audit writes.                           |
| `mine`      | [`docs/cli/contracts/mine.md`](cli/contracts/mine.md)           | File-mining discovery, validation, project resolution, idempotency, topic preservation, failure isolation, concurrency, and output contracts. |
| `tasks`     | [`docs/cli/contracts/tasks.md`](cli/contracts/tasks.md)         | Task lifecycle contracts for create, update, close, close-many, list, reconcile, and project filtering.                                       |
| `eval`      | [`docs/cli/contracts/eval.md`](cli/contracts/eval.md)           | Local evaluation runner, baseline, live-vault, and benchmark command contracts.                                                               |
| `profile`   | [`docs/cli/contracts/profile.md`](cli/contracts/profile.md)     | Profile discovery, validation, preview, install, set, and migration contracts.                                                                |

## Other Command Surfaces

- `doctor` is a read-only setup diagnostic across config, auth, vault access,
  host MCP config, hooks, and next action. It should use narrow probes and must
  not mutate vault or host configuration.
- `memory`, `decision`, and `ask` mirror MCP write/query behavior for manual
  shell use. Keep body-source exclusivity, closed-vocabulary tag validation, and
  JSON output contracts aligned with [`memory-workflows.md`](memory-workflows.md).
- `pinned list` is read-only in the CLI; pin, unpin, and update operations live
  on the `lore-pinned` MCP tool surface.
- `debt scan` and `debt create-tasks` follow the audit categories, score rules,
  task creation cap, and idempotency contract in [`memory-debt.md`](memory-debt.md).
- `procedures scan/propose/deprecate` promote durable procedures through the
  proposed-memory review workflow; approval still routes through
  `lore inbox approve <id>`.
- `entities merge` plans by default, then repoints fact relations, preserves
  aliases, writes a merge note, and archives the loser only with `--yes`.
- `vault ensure-entities` is the legacy four-database cutover helper; it should
  stay additive and dry-run-capable.
- `promote` copies a memory into a configured promotion target and is
  idempotent by target-vault `Promotion Source Key`; rerunning the same
  source/target reuses the existing row.
- `mcp` starts the stdio server and should stay a thin entry point.
- `hooks` dispatches host-assistant hook events. Hook behavior is documented in
  [`hooks.md`](hooks.md), [`hooks-autosave.md`](hooks-autosave.md),
  [`hooks-wakeup.md`](hooks-wakeup.md), and [`hooks-background.md`](hooks-background.md).
