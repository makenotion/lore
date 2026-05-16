# The `digest` Command

[Back to CLI command contracts](../../cli-command-contracts.md).

`lore digest` gathers recent project activity and spawns a background
synthesizer that saves a distilled `source: digest` memory back to the vault.
The digest is what `lore-context action='wake-up'` surfaces in its fast path, so
the output goal is signal density: non-obvious findings, decisions, active
tasks, and emerging themes rather than a chronological session log.

Contracts:

- Data gathering is shared with `lore-context action='digest'` through
  [`src/core/digest.ts`](../../../src/core/digest.ts).
- The synthesizer prompt lives in
  [`src/hooks/prompts.ts`](../../../src/hooks/prompts.ts) and uses the same
  untrusted-content framing as background autosave.
- Background spawn reuses
  [`spawnBackgroundSave`](../../../src/hooks/background.ts) with `logLabel: "digest"`
  so stderr attribution stays distinct.
- `--dry-run` prints gathered markdown and skips the spawn.
- When no memories fall in the selected window, the command exits early without
  spawning.
- `--since YYYY-MM-DD` and optional `--until` widen the window for projects
  whose weekly auto-digest would otherwise stay quiet.
- Manual CLI runs touch the same per-project marker file used by the Stop-hook
  auto path so a manual digest debounces the next automatic run.
